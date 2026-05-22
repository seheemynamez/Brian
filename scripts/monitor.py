#!/usr/bin/env python3
"""
인프라 메트릭 수집 + 임계 검사 + GitHub Issue 알림.

두 가지 모드:
  MODE=collect (default) — 매 30분 cron. 메트릭 수집 + 임계 검사 + alert Issue 생성.
  MODE=daily-summary    — 매일 09:00 KST (00:00 UTC) cron. 24h+7d 요약 Issue 생성,
                          이전 daily-summary Issue 자동 close.

Label 체계 (2차원):
  공통: monitor
  종류: daily-summary | alert-render | alert-aiven | alert-bot | alert-deploy
  심각도: severity-low | severity-high | severity-critical

저장:
  metrics/YYYY-MM-DD.json  — 일별 snapshot 시계열 (collect 모드)
  metrics/state.json        — cooldown 추적
"""
from __future__ import annotations
import json
import os
import sys
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime, timezone, timedelta
from pathlib import Path
from collections import defaultdict
import re

# ============================================================
# 환경
# ============================================================
RENDER_API_KEY = os.environ.get('RENDER_API_KEY', '')
AIVEN_API_TOKEN = os.environ.get('AIVEN_API_TOKEN', '')
GH_TOKEN = os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN', '')
GH_REPO = os.environ.get('GITHUB_REPOSITORY', 'seheemynamez/Brian')
MODE = os.environ.get('MODE', 'collect')
DRY_RUN = os.environ.get('DRY_RUN', '0') == '1' or not GH_TOKEN

RENDER_SERVICE_ID = 'srv-d84mu23tqb8s73fgcq60'
# server 의 /api/stats endpoint — 계정 수 가져옴 (PR #95).
SERVER_PUBLIC_URL = 'https://omok-server-u4rp.onrender.com'
RENDER_OWNER_ID = 'tea-d84jo8jrjlhs73d9afeg'
AIVEN_PROJECT = 'se2hee-93ed'
AIVEN_SERVICE = 'valkey-411207c'

# 한도
RENDER_CPU_LIMIT_M = 100.0   # millicore
RENDER_MEM_LIMIT_MB = 512.0
RENDER_BW_LIMIT_GB = 100.0
AIVEN_MEM_LIMIT_MB = 1024.0

# 임계
THRESHOLD_RENDER_CPU_M = 90.0
THRESHOLD_AIVEN_MEM_PCT = 80.0
# 봇 zombie 회복 (PR #85). RETRY 가 정상 동작이지만 burst 가 잦으면 사용자 lag 심각.
# SKIP 는 RETRY 후에도 회복 못 한 경우 — 거의 발생 X (없어야 정상).
THRESHOLD_BOT_RETRY_30MIN = 20   # 30분 안 RETRY 20건 이상 — 사용자 다수 lag
THRESHOLD_BOT_SKIP_30MIN = 3     # 30분 안 SKIP 3건 이상 — RETRY 가 못 잡는 진짜 끊김 패턴
COOLDOWN_HOURS = 6

REPO_ROOT = Path(__file__).resolve().parent.parent
METRICS_DIR = REPO_ROOT / 'metrics'
STATE_FILE = METRICS_DIR / 'state.json'

NOW = datetime.now(timezone.utc)
KST = timezone(timedelta(hours=9))
TODAY = NOW.strftime('%Y-%m-%d')


# ============================================================
# HTTP
# ============================================================
def http_get(url, headers=None, timeout=30):
    req = urllib.request.Request(url, headers=headers or {}, method='GET')
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def http_post(url, body, headers=None, timeout=30):
    data = json.dumps(body).encode()
    h = {'Content-Type': 'application/json', **(headers or {})}
    req = urllib.request.Request(url, data=data, headers=h, method='POST')
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def http_patch(url, body, headers=None, timeout=30):
    data = json.dumps(body).encode()
    h = {'Content-Type': 'application/json', **(headers or {})}
    req = urllib.request.Request(url, data=data, headers=h, method='PATCH')
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


# ============================================================
# Render API
# ============================================================
def render_headers():
    return {'Authorization': f'Bearer {RENDER_API_KEY}'}


def render_metric(kind, start_iso, end_iso, resolution_s=300):
    qs = urllib.parse.urlencode({
        'resource': RENDER_SERVICE_ID,
        'startTime': start_iso, 'endTime': end_iso,
        'resolutionSeconds': resolution_s,
    })
    return http_get(f'https://api.render.com/v1/metrics/{kind}?{qs}', render_headers())


def render_recent_deploy_status():
    url = f'https://api.render.com/v1/services/{RENDER_SERVICE_ID}/deploys?limit=1'
    data = http_get(url, render_headers())
    if not data: return None
    dep = data[0].get('deploy', {})
    return {
        'status': dep.get('status'),
        'createdAt': dep.get('createdAt'),
        'commit': (dep.get('commit') or {}).get('message', '').split('\n')[0][:60],
    }


def render_search_logs(text, start_iso, end_iso, limit=100, max_pages=5):
    """로그 검색 (페이지네이션)."""
    all_logs = []
    end = end_iso
    for _ in range(max_pages):
        qs = urllib.parse.urlencode({
            'ownerId': RENDER_OWNER_ID, 'resource': RENDER_SERVICE_ID,
            'startTime': start_iso, 'endTime': end,
            'text': text, 'limit': limit, 'direction': 'backward',
        })
        url = f'https://api.render.com/v1/logs?{qs}'
        try:
            data = http_get(url, render_headers())
        except urllib.error.HTTPError:
            break
        logs = data.get('logs') or []
        if not logs: break
        all_logs.extend(logs)
        if not data.get('hasMore'): break
        end = data.get('nextEndTime', '')
        if not end: break
    return all_logs


def render_events(start_iso, end_iso, limit=100):
    """Render events API — server_failed/available/deploy 등 인프라 이벤트.
    API 는 startTime 미지원 → endTime + limit 으로 fetch 후 client-side 필터."""
    qs = urllib.parse.urlencode({'endTime': end_iso, 'limit': limit})
    url = f'https://api.render.com/v1/services/{RENDER_SERVICE_ID}/events?{qs}'
    try:
        events = http_get(url, render_headers())
    except urllib.error.HTTPError:
        return []
    try:
        start_dt = _parse_iso(start_iso)
    except Exception:
        return events
    out = []
    for e in events:
        ts = e.get('event', {}).get('timestamp', '')
        if not ts: continue
        try:
            dt = _parse_iso(ts)
            if dt >= start_dt: out.append(e)
        except Exception:
            continue
    return out


def parse_server_failures(events):
    """events → [{ts, instance, evicted, nonZeroExit, oom}]"""
    out = []
    for e in events:
        ev = e.get('event', {})
        if ev.get('type') != 'server_failed': continue
        det = ev.get('details', {})
        reason = det.get('reason', {})
        out.append({
            'ts': ev.get('timestamp', ''),
            'instance': det.get('instanceID', ''),
            'evicted': bool(reason.get('evicted')),
            'nonZeroExit': reason.get('nonZeroExit'),
            'oom': bool(reason.get('oom')),
        })
    return out


# ============================================================
# Sehee server /api/stats — 운영 user 카운트 (PR #95)
# ============================================================
def fetch_server_stats():
    """GET /api/stats — {total_human_users, ts}. cold-start / down 시 None."""
    try:
        return http_get(f'{SERVER_PUBLIC_URL}/api/stats', timeout=10)
    except Exception as e:
        print(f'  /api/stats fetch 실패: {e}')
        return None


# ============================================================
# Aiven API
# ============================================================
def aiven_headers():
    return {'Authorization': f'aivenv1 {AIVEN_API_TOKEN}'}


def aiven_metrics(period='hour'):
    url = f'https://api.aiven.io/v1/project/{AIVEN_PROJECT}/service/{AIVEN_SERVICE}/metrics'
    return http_post(url, {'period': period}, aiven_headers())


# ============================================================
# 메트릭 가공
# ============================================================
def extract_values(samples):
    vals = []
    for s in samples:
        for v in s.get('values', []):
            if v.get('value') is not None:
                vals.append(v['value'])
    return vals


def render_cpu_stats(samples):
    vals = extract_values(samples)
    if not vals: return None
    vals_m = [v * 1000 for v in vals]  # core -> millicore
    srt = sorted(vals_m)
    return {
        'avg': sum(vals_m) / len(vals_m),
        'p50': srt[len(srt)//2],
        'p95': srt[int(len(srt)*0.95)] if len(srt) > 1 else srt[0],
        'max': max(vals_m),
        'n': len(vals_m),
    }


def render_mem_stats(samples):
    vals = extract_values(samples)
    if not vals: return None
    MB = 1024 * 1024
    vals_mb = [v / MB for v in vals]
    srt = sorted(vals_mb)
    return {
        'avg': sum(vals_mb) / len(vals_mb),
        'p50': srt[len(srt)//2],
        'p95': srt[int(len(srt)*0.95)] if len(srt) > 1 else srt[0],
        'max': max(vals_mb),
        'n': len(vals_mb),
    }


def render_bw_sum_mb(samples):
    vals = extract_values(samples)
    return sum(vals) if vals else 0


def aiven_stats(metrics_dict, key):
    m = metrics_dict.get('metrics', {}).get(key, {})
    rows = m.get('data', {}).get('rows', [])
    vals = [r[1] for r in rows[1:] if isinstance(r, list) and len(r) >= 2 and r[1] is not None]
    if not vals: return None
    srt = sorted(vals)
    return {
        'avg': sum(vals) / len(vals),
        'p50': srt[len(srt)//2],
        'p95': srt[int(len(srt)*0.95)] if len(srt) > 1 else srt[0],
        'max': max(vals),
        'n': len(vals),
    }


# ============================================================
# 봇 로그 파싱
# ============================================================
BOT_MOVE_PAT = re.compile(r'bot=(\w+) stones=(\d+) \((\d+)번째 수\) cfg=d(\d+)×t(\d+) reached=d(\d+) elapsed=(\d+)ms')


def parse_bot_moves(logs):
    rows = []
    for L in logs:
        m = BOT_MOVE_PAT.search(L.get('message', ''))
        if m:
            diff, stones, nth, cfgD, cfgT, reach, elap = m.groups()
            rows.append({
                'ts': L['timestamp'],
                'diff': diff, 'stones': int(stones), 'nth': int(nth),
                'cfgD': int(cfgD), 'cfgT': int(cfgT), 'reach': int(reach), 'elap': int(elap),
            })
    return rows


def bot_stats_by_cfg(moves):
    """cfg 별 cfgMax 도달율 + elapsed 통계."""
    by = defaultdict(lambda: defaultdict(list))
    for r in moves:
        by[r['diff']][r['cfgD']].append(r)
    out = {}
    for diff, by_d in by.items():
        out[diff] = {}
        for cfgD, rs in by_d.items():
            elaps = sorted([r['elap'] for r in rs])
            cfgmax_n = sum(1 for r in rs if r['reach'] == cfgD)
            out[diff][f'd{cfgD}'] = {
                'n': len(rs),
                'avg_elap': sum(elaps) // len(elaps),
                'p50_elap': elaps[len(elaps)//2],
                'p95_elap': elaps[int(len(elaps)*0.95)] if len(elaps) > 1 else elaps[0],
                'cfgmax_pct': round(100 * cfgmax_n / len(rs), 1),
            }
    return out


_TS_TRUNC_RE = re.compile(r'(\.\d{6})\d+')


def _parse_iso(ts):
    """Render 가 ns precision 보낼 수 있어 µs 까지만 자르고 파싱."""
    s = ts.replace('Z', '+00:00')
    s = _TS_TRUNC_RE.sub(r'\1', s)
    return datetime.fromisoformat(s)


def hourly_bot_activity(moves):
    """KST hour bucket 별 봇 착수 횟수."""
    buckets = defaultdict(int)
    for r in moves:
        try:
            dt = _parse_iso(r['ts']).astimezone(KST)
            buckets[dt.hour] += 1
        except Exception:
            continue
    return dict(buckets)


# ============================================================
# state / cooldown
# ============================================================
def load_state():
    if STATE_FILE.exists():
        try: return json.loads(STATE_FILE.read_text())
        except Exception: pass
    return {'last_alert': {}}


def save_state(state):
    METRICS_DIR.mkdir(exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False))


def cooldown_ok(state, alert_key):
    last = state.get('last_alert', {}).get(alert_key)
    if not last: return True
    try:
        last_dt = _parse_iso(last)
    except Exception:
        return True
    return NOW > last_dt + timedelta(hours=COOLDOWN_HOURS)


def mark_alerted(state, alert_key):
    state.setdefault('last_alert', {})[alert_key] = NOW.isoformat()


# ============================================================
# GitHub Issues
# ============================================================
def gh_headers():
    return {
        'Authorization': f'Bearer {GH_TOKEN}',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    }


def create_issue(title, body, labels):
    if DRY_RUN:
        print(f'[DRY_RUN] Would create Issue:')
        print(f'  title: {title}')
        print(f'  labels: {labels}')
        print(f'  body (first 500 chars):\n{body[:500]}...\n')
        return None
    url = f'https://api.github.com/repos/{GH_REPO}/issues'
    try:
        resp = http_post(url, {'title': title, 'body': body, 'labels': labels}, gh_headers())
        return resp.get('html_url')
    except urllib.error.HTTPError as e:
        print(f'  Issue 생성 실패: {e.code} {e.reason}', file=sys.stderr)
        return None


def list_issues_by_label(label, state='open'):
    """특정 label 의 open Issue 목록."""
    qs = urllib.parse.urlencode({'labels': label, 'state': state, 'per_page': 100})
    url = f'https://api.github.com/repos/{GH_REPO}/issues?{qs}'
    try:
        return http_get(url, gh_headers())
    except urllib.error.HTTPError:
        return []


def close_issue(number):
    if DRY_RUN:
        print(f'[DRY_RUN] Would close Issue #{number}')
        return True
    url = f'https://api.github.com/repos/{GH_REPO}/issues/{number}'
    try:
        http_patch(url, {'state': 'closed', 'state_reason': 'completed'}, gh_headers())
        return True
    except urllib.error.HTTPError:
        return False


# ============================================================
# 차트 (mermaid)
# ============================================================
def mermaid_line_chart(title, x_labels, series_dict, y_label='value'):
    """xychart-beta 로 line. series_dict = {label: [values]}"""
    lines = ['```mermaid', 'xychart-beta', f'    title "{title}"',
             f'    x-axis [{", ".join(str(x) for x in x_labels)}]',
             f'    y-axis "{y_label}"']
    for label, vals in series_dict.items():
        lines.append(f'    line "{label}" [{", ".join(str(round(v,1)) for v in vals)}]')
    lines.append('```')
    return '\n'.join(lines)


def mermaid_bar_chart(title, x_labels, values, y_label='count'):
    lines = ['```mermaid', 'xychart-beta', f'    title "{title}"',
             f'    x-axis [{", ".join(str(x) for x in x_labels)}]',
             f'    y-axis "{y_label}"',
             f'    bar [{", ".join(str(round(v,1)) for v in values)}]']
    lines.append('```')
    return '\n'.join(lines)


def gauge_table(rows):
    """Mermaid gauge 직접 지원 X — 표로 대체. rows = [(name, current, limit, unit)]"""
    out = ['| 자원 | 현재 | 한도 | 사용율 | bar |',
           '|---|---|---|---|---|']
    for name, cur, lim, unit in rows:
        if lim > 0:
            pct = 100 * cur / lim
            n = int(pct / 10)
            bar = '█' * n + '░' * (10 - n)
        else:
            pct = 0
            bar = '░' * 10
        out.append(f'| {name} | {cur:.1f}{unit} | {lim:.0f}{unit} | {pct:.1f}% | `{bar}` |')
    return '\n'.join(out)


# ============================================================
# alert key → label 매핑
# ============================================================
ALERT_LABELS = {
    'render_cpu_high':  ['monitor', 'alert-render', 'severity-high'],
    'aiven_mem_high':   ['monitor', 'alert-aiven',  'severity-high'],
    'worker_timeout':   ['monitor', 'alert-bot',    'severity-critical'],
    'no_move':          ['monitor', 'alert-bot',    'severity-high'],
    'deploy_bad':       ['monitor', 'alert-deploy', 'severity-critical'],
    'bot_retry_burst':  ['monitor', 'alert-bot',    'severity-high'],
    'bot_skip_burst':   ['monitor', 'alert-bot',    'severity-critical'],
    'server_oom':       ['monitor', 'alert-render', 'severity-critical'],   # OOM 강제 종료
    'server_crash':     ['monitor', 'alert-render', 'severity-critical'],   # nonZeroExit 코드 에러
}


# ============================================================
# MODE: collect (매 30분)
# ============================================================
def run_collect():
    win_end = NOW
    win_start = NOW - timedelta(minutes=30)
    s_iso = win_start.strftime('%Y-%m-%dT%H:%M:%SZ')
    e_iso = win_end.strftime('%Y-%m-%dT%H:%M:%SZ')

    cpu = render_metric('cpu', s_iso, e_iso, 60)
    mem = render_metric('memory', s_iso, e_iso, 60)
    cpu_st = render_cpu_stats(cpu)
    mem_st = render_mem_stats(mem)
    deploy = render_recent_deploy_status()
    wt_logs = render_search_logs('worker_timeout', s_iso, e_iso, limit=10)
    nm_logs = render_search_logs('search returned no move', s_iso, e_iso, limit=10)
    # 봇 RETRY / SKIP (PR #85) — Wi-Fi 불안정으로 사람 zombie 판정된 빈도.
    # RETRY 가 정상 회복 흐름, SKIP 은 RETRY 도 못 잡는 진짜 끊김 (드물어야 정상).
    retry_logs = render_search_logs('schedule RETRY', s_iso, e_iso, limit=50)
    skip_logs = render_search_logs('schedule SKIP', s_iso, e_iso, limit=30)
    # 인프라 이벤트 (PR #89) — server_failed (OOM / crash) 감지.
    events = render_events(s_iso, e_iso, limit=100)
    failures = parse_server_failures(events)
    oom_fails = [f for f in failures if f['evicted'] or f['oom']]
    crash_fails = [f for f in failures if not (f['evicted'] or f['oom'])]
    aiven = aiven_metrics(period='hour')
    aiven_cpu = aiven_stats(aiven, 'cpu_usage')
    aiven_mem = aiven_stats(aiven, 'mem_usage')

    snapshot = {
        'ts': NOW.isoformat(),
        'render': {
            'cpu_peak_m': cpu_st['max'] if cpu_st else None,
            'cpu_avg_m':  cpu_st['avg'] if cpu_st else None,
            'mem_peak_mb': mem_st['max'] if mem_st else None,
            'deploy_status': deploy['status'] if deploy else None,
            'worker_timeout_count': len(wt_logs),
            'no_move_count': len(nm_logs),
            'bot_retry_count': len(retry_logs),
            'bot_skip_count':  len(skip_logs),
            'server_failed_count': len(failures),
            'server_oom_count':    len(oom_fails),
            'server_crash_count':  len(crash_fails),
        },
        'aiven': {
            'cpu_pct_avg': aiven_cpu['avg'] if aiven_cpu else None,
            'cpu_pct_max': aiven_cpu['max'] if aiven_cpu else None,
            'mem_pct_avg': aiven_mem['avg'] if aiven_mem else None,
            'mem_pct_max': aiven_mem['max'] if aiven_mem else None,
        },
    }
    print(json.dumps(snapshot, indent=2, ensure_ascii=False))

    # 임계 검사
    state = load_state()
    alerts = []
    if cpu_st and cpu_st['max'] >= THRESHOLD_RENDER_CPU_M:
        alerts.append(('render_cpu_high',
            f'[monitor] Render CPU peak {cpu_st["max"]:.1f}m (≥{THRESHOLD_RENDER_CPU_M:.0f}m)',
            f'## Render CPU peak 임계 초과\n\n'
            f'- 측정: **{cpu_st["max"]:.1f}m** (CPU peak, 최근 30분)\n'
            f'- 임계: ≥ {THRESHOLD_RENDER_CPU_M:.0f}m (한도 {RENDER_CPU_LIMIT_M:.0f}m)\n'
            f'- 시각: {NOW.isoformat()}\n\n'
            f'### 같이 본 상태\n'
            f'- Render Memory peak: {mem_st["max"]:.1f}MB / {RENDER_MEM_LIMIT_MB:.0f}MB\n'
            f'- Aiven CPU max: {aiven_cpu["max"]:.1f}% (h)\n'
            f'- Aiven Memory max: {aiven_mem["max"]:.1f}%\n\n'
            f'### 다음 조치 후보\n'
            f'- 봇 동시 사용 패턴 점검 (Render 로그)\n'
            f'- Hobby plan ($7/월) 검토\n'))
    if aiven_mem and aiven_mem['max'] >= THRESHOLD_AIVEN_MEM_PCT:
        alerts.append(('aiven_mem_high',
            f'[monitor] Aiven valkey Memory {aiven_mem["max"]:.1f}% (≥{THRESHOLD_AIVEN_MEM_PCT:.0f}%)',
            f'## Aiven Memory 임계 초과\n\n'
            f'- 측정: **{aiven_mem["max"]:.1f}%** / {AIVEN_MEM_LIMIT_MB:.0f}MB\n'
            f'- 임계: ≥ {THRESHOLD_AIVEN_MEM_PCT:.0f}% — noeviction (100% 시 write 실패)\n'
            f'- 시각: {NOW.isoformat()}\n\n'
            f'### 다음 조치 후보\n'
            f'- 정기 cleanup 검토\n'
            f'- Aiven Startup-4 (4GB / $30월) 검토\n'))
    if len(wt_logs) > 0:
        samples = '\n'.join(f'- `{L["timestamp"][:19]}` {L["message"][:140]}' for L in wt_logs[:5])
        alerts.append(('worker_timeout',
            f'[monitor] worker_timeout 발생 {len(wt_logs)}건',
            f'## 봇 worker_timeout 발생\n\n'
            f'- 카운트: **{len(wt_logs)}건** (최근 30분)\n'
            f'- 임계: > 0 (PR #82+ 0건 유지 베이스)\n\n'
            f'### 샘플\n{samples}\n\n'
            f'self-abort 회귀 의심. 최근 PR 점검 필요.\n'))
    if len(nm_logs) > 0:
        samples = '\n'.join(f'- `{L["timestamp"][:19]}` {L["message"][:140]}' for L in nm_logs[:5])
        alerts.append(('no_move',
            f'[monitor] 봇 no_move {len(nm_logs)}건',
            f'## 봇이 수를 못 두는 케이스\n\n- 카운트: **{len(nm_logs)}건**\n\n### 샘플\n{samples}\n'))
    if deploy and deploy['status'] not in ('live', 'pre_deploy_in_progress', 'build_in_progress', 'update_in_progress'):
        alerts.append(('deploy_bad',
            f'[monitor] Render 배포 상태 비정상: {deploy["status"]}',
            f'## Render 배포 비정상\n\n- 상태: **{deploy["status"]}**\n- 시각: {deploy["createdAt"]}\n- 커밋: {deploy["commit"]}\n'))
    if len(retry_logs) >= THRESHOLD_BOT_RETRY_30MIN:
        samples = '\n'.join(f'- `{L["timestamp"][:19]}` {L["message"][:140]}' for L in retry_logs[:5])
        alerts.append(('bot_retry_burst',
            f'[monitor] 봇 schedule RETRY {len(retry_logs)}건 (≥{THRESHOLD_BOT_RETRY_30MIN})',
            f'## 봇 RETRY burst — 사용자 다수 Wi-Fi lag 의심\n\n'
            f'- 카운트: **{len(retry_logs)}건** (최근 30분)\n'
            f'- 임계: ≥ {THRESHOLD_BOT_RETRY_30MIN}건\n'
            f'- 시각: {NOW.isoformat()}\n\n'
            f'### 의미\n'
            f'RETRY = Wi-Fi 잠시 lag 으로 사람 zombie 판정 → 3s 후 재시도. PR #85 의 정상 회복 흐름. '
            f'burst 가 잦으면 다수 사용자 lag 상황 (서버 응답 지연 / 사용자 측 ISP 등 영향).\n\n'
            f'### 샘플\n{samples}\n\n'
            f'### 같이 본 상태\n'
            f'- Render CPU peak: {cpu_st["max"] if cpu_st else "?"}m\n'
            f'- Aiven CPU max: {aiven_cpu["max"] if aiven_cpu else "?"}%\n'))
    if len(skip_logs) >= THRESHOLD_BOT_SKIP_30MIN:
        samples = '\n'.join(f'- `{L["timestamp"][:19]}` {L["message"][:140]}' for L in skip_logs[:5])
        alerts.append(('bot_skip_burst',
            f'[monitor] 봇 schedule SKIP {len(skip_logs)}건 (≥{THRESHOLD_BOT_SKIP_30MIN})',
            f'## 봇 SKIP burst — RETRY 도 못 잡는 끊김 사례\n\n'
            f'- 카운트: **{len(skip_logs)}건** (최근 30분)\n'
            f'- 임계: ≥ {THRESHOLD_BOT_SKIP_30MIN}건\n'
            f'- 시각: {NOW.isoformat()}\n\n'
            f'### 의미\n'
            f'SKIP 은 PR #85 이후 거의 발생 X 가 정상. burst 발생 = `bothPlayersOnline` 가드를 RETRY 가 '
            f'우회 못 하는 새 패턴. 코드 회귀 또는 새 끊김 시나리오 의심.\n\n'
            f'### 샘플\n{samples}\n'))
    if oom_fails:
        samples = '\n'.join(f'- `{f["ts"][:19]}` instance={f["instance"][-6:]} evicted={f["evicted"]} oom={f["oom"]}' for f in oom_fails[:5])
        alerts.append(('server_oom',
            f'[monitor] 서버 OOM 강제 종료 {len(oom_fails)}건',
            f'## 서버 OOM (메모리 한도 초과) 감지\n\n'
            f'- 카운트: **{len(oom_fails)}건** (최근 30분)\n'
            f'- 임계: > 0 (OOM 은 자원 부족 신호 — 1건도 위험)\n'
            f'- 시각: {NOW.isoformat()}\n\n'
            f'### 의미\n'
            f'`evicted=true` 또는 `oom=true` — 인스턴스가 메모리 한도 (512MB) 도달로 강제 종료됨. '
            f'Render 가 자동 재시작 하지만 진행 중 게임/세션 사라짐.\n\n'
            f'### 샘플\n{samples}\n\n'
            f'### 다음 조치\n'
            f'- 메모리 leak 검토 (시간 따라 증가 추세)\n'
            f'- Aiven 캐시 사용량 점검\n'
            f'- Hobby plan ($7/월, 512MB) 또는 Standard ($25/월, 2GB) 검토\n'))
    if crash_fails:
        samples = '\n'.join(f'- `{f["ts"][:19]}` instance={f["instance"][-6:]} nonZeroExit={f["nonZeroExit"]}' for f in crash_fails[:5])
        alerts.append(('server_crash',
            f'[monitor] 서버 crash (코드 에러) {len(crash_fails)}건',
            f'## 서버 crash 감지 (nonZeroExit)\n\n'
            f'- 카운트: **{len(crash_fails)}건** (최근 30분)\n'
            f'- 임계: > 0 (crash 1건도 회귀 신호)\n'
            f'- 시각: {NOW.isoformat()}\n\n'
            f'### 의미\n'
            f'`nonZeroExit=1` — Node 프로세스가 코드 에러 또는 `process.exit(N≠0)` 로 종료. '
            f'unhandled exception / startup 실패 / hydrate 실패 가능성.\n\n'
            f'### 샘플\n{samples}\n\n'
            f'### 다음 조치\n'
            f'- 최근 deploy / PR 점검\n'
            f'- Render 로그에서 crash 직전 에러 메시지 확인\n'
            f'- crash loop (짧은 시간 다수) 면 rollback 검토\n'))

    for key, title, body in alerts:
        if not cooldown_ok(state, key):
            print(f'  alert {key}: cooldown active — skip')
            continue
        labels = ALERT_LABELS.get(key, ['monitor', 'severity-high'])
        url = create_issue(title, body, labels)
        if url or DRY_RUN:
            mark_alerted(state, key)
            print(f'  alerted: {key} → {url}')

    # 저장
    if not DRY_RUN or os.environ.get('SAVE_METRICS') == '1':
        METRICS_DIR.mkdir(exist_ok=True)
        daily_file = METRICS_DIR / f'{TODAY}.json'
        daily = json.loads(daily_file.read_text()) if daily_file.exists() else []
        daily.append(snapshot)
        daily_file.write_text(json.dumps(daily, indent=2, ensure_ascii=False))
        save_state(state)
        print(f'  saved: {daily_file.relative_to(REPO_ROOT)}')

    print(f'\n=== {len(alerts)} alert(s) ===' if alerts else '\n=== no alerts ===')


# ============================================================
# MODE: daily-summary (매일 00:00 UTC = 09:00 KST)
# ============================================================
def load_recent_metrics(days=7):
    """metrics/YYYY-MM-DD.json 최근 N 일 로드."""
    out = []
    for i in range(days):
        d = (NOW - timedelta(days=i)).strftime('%Y-%m-%d')
        f = METRICS_DIR / f'{d}.json'
        if f.exists():
            try:
                out.extend(json.loads(f.read_text()))
            except Exception:
                pass
    return out


# ============================================================
# 봇 운영 지표 — game_started / game_over 로그 파싱 (PR #86 보강된 필드)
# ============================================================
# 새 game_over 로그 형식: key=value pairs (value 가 공백 / "..." 으로 인용)
#   [game_over] code=XXXX gameId=YY winner=black reason=five bot=true botDiff=hard
#               blackNick="홍길동" whiteNick=오목봇·상 blackRating=1318 whiteRating=1180
#               blackDelta=+8 whiteDelta=-8 stones=23
LOG_FIELD_RE = re.compile(r'(\w+)=("(?:[^"\\]|\\.)*"|\S+)')


def parse_log_fields(message):
    """`[event] k=v k=v` → dict. 값이 따옴표면 unquote."""
    out = {}
    for k, v in LOG_FIELD_RE.findall(message):
        if v.startswith('"') and v.endswith('"'):
            v = v[1:-1].replace('\\"', '"')
        out[k] = v
    return out


def parse_game_over(logs):
    """game_over 로그 → [{gameId, winner, reason, bot, botDiff, blackNick, whiteNick,
                          blackRating, whiteRating, blackDelta, whiteDelta, stones, ts}]"""
    out = []
    for L in logs:
        msg = L.get('message', '')
        if '[game_over]' not in msg:
            continue
        f = parse_log_fields(msg)
        f['ts'] = L.get('timestamp', '')
        out.append(f)
    return out


def parse_game_started(logs):
    """game_started → [{gameId, black, white, bot, ts}]"""
    out = []
    for L in logs:
        msg = L.get('message', '')
        if '[game_started]' not in msg:
            continue
        f = parse_log_fields(msg)
        f['ts'] = L.get('timestamp', '')
        out.append(f)
    return out


# ============================================================
# 시간대별 분포 (KST hour bucket)
# ============================================================
def hourly_bucket_by_ts(items, ts_field='ts'):
    """items 의 ts 필드 (UTC ISO) → KST hour (0-23) 카운트."""
    buckets = defaultdict(int)
    for r in items:
        ts = r.get(ts_field, '')
        if not ts: continue
        try:
            dt = _parse_iso(ts).astimezone(KST)
            buckets[dt.hour] += 1
        except Exception:
            continue
    return dict(buckets)


def parse_online_count_series(logs):
    """ws_connected / ws_disconnected 로그의 `online=N` 시계열 추출 → KST hour 별 평균/peak."""
    pat = re.compile(r'online=(\d+)')
    series = []  # [(kst_dt, online_n)]
    for L in logs:
        m = pat.search(L.get('message', ''))
        if not m: continue
        try:
            dt = _parse_iso(L['timestamp']).astimezone(KST)
            series.append((dt, int(m.group(1))))
        except Exception:
            continue
    series.sort()
    by_hour_avg = {}
    by_hour_peak = {}
    grouped = defaultdict(list)
    for dt, n in series:
        grouped[dt.hour].append(n)
    for h, vals in grouped.items():
        by_hour_avg[h] = sum(vals) / len(vals)
        by_hour_peak[h] = max(vals)
    return by_hour_avg, by_hour_peak


# ============================================================
# 봇 운영 지표 — 봇 별 win/loss + 상대 rating 분포
# ============================================================
def bot_perf_stats(game_overs):
    """game_over (bot=true only) → {difficulty: {wins, losses, draws, abandoned,
                                                  opponents, opp_ratings, avg_stones, total}}"""
    bot_diffs = {}  # difficulty -> stats
    for g in game_overs:
        if g.get('bot') != 'true': continue
        diff = g.get('botDiff')
        if not diff: continue
        if diff not in bot_diffs:
            bot_diffs[diff] = {
                'wins': 0, 'losses': 0, 'draws': 0, 'abandoned': 0, 'left': 0,
                'total': 0,
                'opp_nicks': [],
                'opp_ratings': [],  # 봇이 만난 사람 rating 리스트
                'stones_list': [],
            }
        s = bot_diffs[diff]
        s['total'] += 1
        # 봇 색 식별 — black/white 중 nick 이 botDiff 이름과 매칭되는 색
        # 또는 더 간단: botNick prefix 'BOT_' 또는 '오목봇·' 검사
        black_nick = g.get('blackNick', '')
        white_nick = g.get('whiteNick', '')
        bot_is_black = black_nick.startswith('오목봇')
        bot_color = 'black' if bot_is_black else 'white'
        human_color = 'white' if bot_is_black else 'black'
        human_nick = white_nick if bot_is_black else black_nick
        try:
            human_rating = int(g.get(f'{human_color}Rating', 0))
        except Exception:
            human_rating = 0
        s['opp_nicks'].append(human_nick)
        if human_rating > 0:
            s['opp_ratings'].append(human_rating)
        try:
            stones = int(g.get('stones', 0))
            if stones > 0: s['stones_list'].append(stones)
        except Exception:
            pass
        # 결과 분류
        reason = g.get('reason', '')
        winner = g.get('winner', '')
        if reason == 'draw':
            s['draws'] += 1
        elif reason == 'opponent_left':
            s['left'] += 1
        elif reason == 'abandoned':
            s['abandoned'] += 1
        elif winner == bot_color:
            s['wins'] += 1
        elif winner == human_color:
            s['losses'] += 1
    return bot_diffs


def player_activity(game_overs):
    """사람 닉네임 별 활동 통계 → {nickname: {games, wins, losses, rating_delta_sum, last_rating}}"""
    by_nick = {}
    for g in game_overs:
        for color in ('black', 'white'):
            nick = g.get(f'{color}Nick')
            if not nick or nick.startswith('오목봇'): continue
            if nick not in by_nick:
                by_nick[nick] = {'games': 0, 'wins': 0, 'losses': 0, 'draws': 0,
                                  'delta_sum': 0, 'last_rating': 0}
            d = by_nick[nick]
            d['games'] += 1
            try:
                delta_s = g.get(f'{color}Delta', '0').replace('+', '')
                delta = int(delta_s)
                d['delta_sum'] += delta
            except Exception:
                pass
            try:
                d['last_rating'] = int(g.get(f'{color}Rating', d['last_rating']))
            except Exception:
                pass
            reason = g.get('reason', '')
            winner = g.get('winner', '')
            if reason == 'draw':
                d['draws'] += 1
            elif winner == color:
                d['wins'] += 1
            elif winner != 'draw' and winner:
                d['losses'] += 1
    return by_nick


# ============================================================
# daily stats 저장 — 7일 trend 위해 일별 PVP/봇 게임 수 누적
# ============================================================
DAILY_STATS_FILE = METRICS_DIR / 'daily-stats.json'


def load_daily_stats():
    if DAILY_STATS_FILE.exists():
        try: return json.loads(DAILY_STATS_FILE.read_text())
        except Exception: pass
    return {}


def save_daily_stats(d):
    METRICS_DIR.mkdir(exist_ok=True)
    DAILY_STATS_FILE.write_text(json.dumps(d, indent=2, ensure_ascii=False))


def run_daily_summary():
    # 시간 윈도우 — KST 어제 00:00 ~ 오늘 00:00 (캘린더 day)
    kst_today_00 = NOW.astimezone(KST).replace(hour=0, minute=0, second=0, microsecond=0)
    win_end_kst = kst_today_00
    win_start_kst = kst_today_00 - timedelta(days=1)
    win_end_utc = win_end_kst.astimezone(timezone.utc)
    win_start_utc = win_start_kst.astimezone(timezone.utc)
    s_iso = win_start_utc.strftime('%Y-%m-%dT%H:%M:%SZ')
    e_iso = win_end_utc.strftime('%Y-%m-%dT%H:%M:%SZ')
    summary_date = win_start_kst.strftime('%Y-%m-%d')  # 어제 KST 날짜
    print(f'=== daily-summary {summary_date} KST (window {s_iso} ~ {e_iso}) ===')

    # 1) Render / Aiven 메트릭 (24h KST 캘린더 day)
    cpu = render_metric('cpu', s_iso, e_iso, 300)
    mem = render_metric('memory', s_iso, e_iso, 300)
    bw_30d_start = (win_end_utc - timedelta(days=30)).strftime('%Y-%m-%dT%H:%M:%SZ')
    bw = render_metric('bandwidth', bw_30d_start, e_iso, 300)
    cpu_st = render_cpu_stats(cpu) or {}
    mem_st = render_mem_stats(mem) or {}
    bw_30d = render_bw_sum_mb(bw)
    aiven = aiven_metrics(period='day')
    aiven_cpu = aiven_stats(aiven, 'cpu_usage') or {}
    aiven_mem = aiven_stats(aiven, 'mem_usage') or {}
    aiven_disk = aiven_stats(aiven, 'disk_usage') or {}
    aiven_load = aiven_stats(aiven, 'load_average') or {}

    # 2) 로그 fetch
    bot_logs = render_search_logs('move applied', s_iso, e_iso, limit=100, max_pages=10)
    bot_moves = parse_bot_moves(bot_logs)
    bot_by_cfg = bot_stats_by_cfg(bot_moves)
    bot_moves_by_hour = hourly_bucket_by_ts(bot_moves, 'ts')
    game_started_raw = render_search_logs('game_started', s_iso, e_iso, limit=100, max_pages=5)
    game_started = parse_game_started(game_started_raw)
    game_over_raw = render_search_logs('game_over', s_iso, e_iso, limit=100, max_pages=5)
    game_overs = parse_game_over(game_over_raw)
    skip_logs = render_search_logs('schedule SKIP', s_iso, e_iso, limit=50)
    retry_logs = render_search_logs('schedule RETRY', s_iso, e_iso, limit=100, max_pages=3)
    hb_logs = render_search_logs('heartbeat_terminate', s_iso, e_iso, limit=100, max_pages=2)
    ws_conn_logs = render_search_logs('ws_connected', s_iso, e_iso, limit=100, max_pages=10)
    ws_disc_logs = render_search_logs('ws_disconnected', s_iso, e_iso, limit=100, max_pages=10)
    # 인프라 이벤트 — server_failed (OOM / crash), deploy 등
    events = render_events(s_iso, e_iso, limit=200)
    failures = parse_server_failures(events)
    oom_fails = [f for f in failures if f['evicted'] or f['oom']]
    crash_fails = [f for f in failures if not (f['evicted'] or f['oom'])]
    deploy_count = sum(1 for e in events if e.get('event', {}).get('type') == 'deploy_ended')

    # 3) 시간대별 분포 (KST hour bucket)
    games_by_hour = hourly_bucket_by_ts(game_started, 'ts')
    pvp_games = [g for g in game_started if g.get('bot') == 'false']
    pvp_games_by_hour = hourly_bucket_by_ts(pvp_games, 'ts')
    online_avg_by_hour, online_peak_by_hour = parse_online_count_series(ws_conn_logs + ws_disc_logs)

    # 4) 봇 운영 지표 (봇별 승패 + 상대 rating 분포)
    bot_perf = bot_perf_stats(game_overs)

    # 5) 사람 활동 (TOP / rating movers + 활성 사용자)
    player_acts = player_activity(game_overs)
    top_active = sorted(player_acts.items(), key=lambda kv: -kv[1]['games'])[:5]
    top_movers_up = sorted([(n, d) for n, d in player_acts.items() if d['delta_sum'] > 0],
                           key=lambda kv: -kv[1]['delta_sum'])[:5]
    top_movers_dn = sorted([(n, d) for n, d in player_acts.items() if d['delta_sum'] < 0],
                           key=lambda kv: kv[1]['delta_sum'])[:5]
    # 활성 사용자 24h — game_over 에 등장한 unique 사람 nickname.
    # (clientId 가 game_over 로그에 없어 nickname 으로 근사. 같은 사람 닉네임 바꾸면 중복 집계 위험,
    # 단 대부분 nickname 안정적이라 실용 OK.)
    active_user_nicks = set(player_acts.keys())
    active_users_24h = len(active_user_nicks)

    # 5-b) server /api/stats — 현재 사람 계정 수 (PR #95).
    server_stats = fetch_server_stats()

    # 6) reason 카운트
    reason_counts = defaultdict(int)
    for g in game_overs:
        r = g.get('reason', '')
        if r: reason_counts[r] += 1

    # 7) alert 이력 (state.json 의 24h 안 last_alert 시각)
    state = load_state()
    alert_history = []
    for k, ts in state.get('last_alert', {}).items():
        try:
            dt = _parse_iso(ts)
            if dt >= win_start_utc and dt < win_end_utc:
                alert_history.append((k, ts))
        except Exception:
            pass

    # 8) 7일 trend — metrics/ snapshot + daily-stats.json
    #
    # Timezone 통일 (issue #95 fix): 모든 day key 는 KST 기준.
    # snapshot ts 는 UTC ISO 라 KST 변환 후 date 추출. daily_stats key 도 KST date.
    # 이전엔 by_day key 가 UTC date 라 daily_stats KST key 와 불일치 →
    # daily_stats.get(d) 가 거의 항상 None → PVP/봇 게임 컬럼 "-".
    recent = load_recent_metrics(days=7)
    trend_days = []
    by_day = defaultdict(list)
    for s in recent:
        ts = s.get('ts', '')
        if not ts: continue
        try:
            d = _parse_iso(ts).astimezone(KST).strftime('%Y-%m-%d')
        except Exception:
            continue
        by_day[d].append(s)
    daily_stats = load_daily_stats()
    # snapshot 만 있는 날 + daily_stats 만 있는 날 모두 표시 (union). 이번 발행의
    # self entry 는 마지막 단계에서 저장되므로 load_daily_stats() 결과엔 아직 없음 —
    # 다음 발행 표에서 보임.
    all_days = sorted(set(by_day.keys()) | set(daily_stats.keys()))[-7:]
    for d in all_days:
        snaps = by_day.get(d, [])
        cpu_maxes = [s.get('render', {}).get('cpu_peak_m') for s in snaps if s.get('render', {}).get('cpu_peak_m') is not None]
        mem_maxes = [s.get('aiven', {}).get('mem_pct_max') for s in snaps if s.get('aiven', {}).get('mem_pct_max') is not None]
        ds = daily_stats.get(d, {})
        trend_days.append({
            'date': d,
            'render_cpu_max_m': max(cpu_maxes) if cpu_maxes else None,
            'aiven_mem_max_pct': max(mem_maxes) if mem_maxes else None,
            'pvp_games': ds.get('pvp_games'),
            'bot_games': ds.get('bot_games'),
            'active_users': ds.get('active_users'),
            'total_users': ds.get('total_human_users'),
        })

    # Aiven memory 장기 추정
    aiven_trend_msg = '(데이터 부족)'
    valid_mem = [(d['date'], d['aiven_mem_max_pct']) for d in trend_days if d['aiven_mem_max_pct'] is not None]
    if len(valid_mem) >= 2:
        first_p = valid_mem[0][1]; last_p = valid_mem[-1][1]
        days_span = max(1, len(valid_mem) - 1)
        per_week_pct = (last_p - first_p) / days_span * 7
        if per_week_pct > 0.01:
            weeks_to_80 = (80 - last_p) / per_week_pct
            aiven_trend_msg = f'주당 {per_week_pct:+.2f}%p — 80% 도달 예상: ~{weeks_to_80:.1f}주 후'
        elif per_week_pct < -0.01:
            aiven_trend_msg = f'주당 {per_week_pct:+.2f}%p (감소 추세) — 안정'
        else:
            aiven_trend_msg = f'주당 {per_week_pct:+.2f}%p (평탄)'

    # ====== Issue 본문 ======
    bot_total = len(bot_moves)
    total_games = len(game_started)
    pvp_count = len(pvp_games)
    bot_game_count = total_games - pvp_count

    body = []
    body.append(f'## 일일 인프라 요약 — {summary_date} KST (00:00 ~ 익일 00:00)\n')
    body.append(f'_시간 기준: 모두 KST. 측정 window: `{s_iso} ~ {e_iso}` (UTC)._\n')

    # 자원 사용율
    body.append('### 자원 사용율 (한도 대비)\n')
    body.append(gauge_table([
        ('Render CPU peak',  cpu_st.get('max') or 0, RENDER_CPU_LIMIT_M, 'm'),
        ('Render Memory peak', mem_st.get('max') or 0, RENDER_MEM_LIMIT_MB, 'MB'),
        ('Render Bandwidth 30d', bw_30d / 1024, RENDER_BW_LIMIT_GB, 'GB'),
        ('Aiven CPU max', aiven_cpu.get('max') or 0, 100, '%'),
        ('Aiven Memory max', aiven_mem.get('max') or 0, 100, '%'),
    ]))
    body.append('')

    # Render/Aiven 24h 메트릭
    body.append('### Render 메트릭\n| 항목 | avg | p50 | p95 | max |')
    body.append('|---|---|---|---|---|')
    body.append(f'| CPU (m) | {cpu_st.get("avg",0):.1f} | {cpu_st.get("p50",0):.1f} | {cpu_st.get("p95",0):.1f} | {cpu_st.get("max",0):.1f} |')
    body.append(f'| Memory (MB) | {mem_st.get("avg",0):.1f} | {mem_st.get("p50",0):.1f} | {mem_st.get("p95",0):.1f} | {mem_st.get("max",0):.1f} |')
    body.append(f'| Bandwidth 30d 누적 | {bw_30d:.1f}MB (한도 100GB) |  |  |  |')
    body.append('')
    body.append('### Aiven valkey 메트릭\n| 항목 | avg | p50 | p95 | max |')
    body.append('|---|---|---|---|---|')
    body.append(f'| CPU % | {aiven_cpu.get("avg",0):.2f} | {aiven_cpu.get("p50",0):.2f} | {aiven_cpu.get("p95",0):.2f} | {aiven_cpu.get("max",0):.2f} |')
    body.append(f'| Memory % | {aiven_mem.get("avg",0):.2f} | {aiven_mem.get("p50",0):.2f} | {aiven_mem.get("p95",0):.2f} | {aiven_mem.get("max",0):.2f} |')
    body.append(f'| Disk % | {aiven_disk.get("avg",0):.3f} | — | — | {aiven_disk.get("max",0):.3f} |')
    body.append(f'| Load avg | {aiven_load.get("avg",0):.2f} | — | {aiven_load.get("p95",0):.2f} | {aiven_load.get("max",0):.2f} |')
    body.append('')
    body.append(f'**Aiven 장기 메모리 트렌드**: {aiven_trend_msg}\n')

    # 게임 활동 요약 — 계정 수 / 활성 사용자 포함
    body.append('### 게임 활동 요약\n')
    total_human_users = server_stats.get('total_human_users') if server_stats else None
    user_count_str = f'**{total_human_users}**' if total_human_users is not None else '_(server /api/stats 응답 없음 — cold-start 가능성)_'
    body.append(f'- 현재 사람 계정 수: {user_count_str}')
    body.append(f'- **24h 활성 사용자**: **{active_users_24h}명** (게임 한 판 이상 둔 unique 닉네임)')
    body.append(f'- 총 게임 시작: **{total_games}건** (PVP {pvp_count} / 봇 {bot_game_count})')
    body.append(f'- 봇 착수 총 횟수: **{bot_total}건**')
    body.append(f'- 새 ws 연결: 대략 **{len(ws_conn_logs)}건**\n')

    # 봇 운영 지표 (핵심)
    body.append('### 봇 운영 지표 (난이도 별)\n')
    if bot_perf:
        body.append('| 난이도 | 총 | 봇 승 | 봇 패 | 무 | 이탈/포기 | 상대 rating avg/min/max | 평균 게임 길이 (수) |')
        body.append('|---|---|---|---|---|---|---|---|')
        for diff in ['easy', 'medium', 'hard']:
            s = bot_perf.get(diff)
            if not s: continue
            ratings = s['opp_ratings']
            rating_str = f'{sum(ratings)/len(ratings):.0f} / {min(ratings)} / {max(ratings)}' if ratings else '-'
            stones = s['stones_list']
            stones_str = f'{sum(stones)/len(stones):.1f}' if stones else '-'
            left_total = s['left'] + s['abandoned']
            body.append(f'| {diff} | {s["total"]} | {s["wins"]} | {s["losses"]} | {s["draws"]} | {left_total} | {rating_str} | {stones_str} |')
        body.append('\n_상대 rating avg/min/max — 해당 봇과 대국한 사람 측 rating 분포. 봇 난이도가 유저 풀에 맞는지 판단._')
    else:
        body.append('- (봇 게임 데이터 없음)')
    body.append('')

    # cfgMax 도달율
    if bot_by_cfg:
        body.append('### cfgMax 도달율 (cfg 별)\n')
        body.append('| 난이도 | cfg | n | avg/p50/p95 elapsed (ms) | cfgMax 도달 |')
        body.append('|---|---|---|---|---|')
        for diff in ['easy', 'medium', 'hard']:
            if diff not in bot_by_cfg: continue
            for cfg_key, st in sorted(bot_by_cfg[diff].items()):
                body.append(f'| {diff} | {cfg_key} | {st["n"]} | {st["avg_elap"]}/{st["p50_elap"]}/{st["p95_elap"]} | **{st["cfgmax_pct"]:.1f}%** |')
        body.append('')

    # 시간대별 활동 (KST hour, 세 종류 통합 표)
    body.append('### 시간대별 활동 (KST hour)\n')
    body.append('| hour | 동접 평균 | 동접 peak | 게임 시작 | 봇 착수 | bar (게임) |')
    body.append('|---|---|---|---|---|---|')
    max_g = max(games_by_hour.values()) if games_by_hour else 1
    for h in range(24):
        avg_o = online_avg_by_hour.get(h, 0)
        peak_o = online_peak_by_hour.get(h, 0)
        g = games_by_hour.get(h, 0)
        bm = bot_moves_by_hour.get(h, 0)
        bar = '█' * int(20 * g / max_g) if max_g > 0 else ''
        body.append(f'| {h:02d}:00 | {avg_o:.1f} | {peak_o} | {g} | {bm} | `{bar}` |')
    body.append('')

    # 사람 활동 TOP / rating movers
    body.append('### TOP 활동 사용자 (24h 게임 수)\n')
    if top_active:
        body.append('| # | nickname | 게임 | W/L/D | rating Δ | 현재 rating |')
        body.append('|---|---|---|---|---|---|')
        for i, (n, d) in enumerate(top_active, 1):
            body.append(f'| {i} | {n} | {d["games"]} | {d["wins"]}/{d["losses"]}/{d["draws"]} | {d["delta_sum"]:+d} | {d["last_rating"]} |')
    else:
        body.append('- (사람 게임 데이터 없음)')
    body.append('')

    body.append('### Rating 상위 변동자 (24h Δ)\n')
    body.append('**↑ 상승 TOP 5**')
    if top_movers_up:
        body.append('| nickname | Δ | 게임 | 현재 rating |')
        body.append('|---|---|---|---|')
        for n, d in top_movers_up:
            body.append(f'| {n} | {d["delta_sum"]:+d} | {d["games"]} | {d["last_rating"]} |')
    else:
        body.append('- 없음')
    body.append('\n**↓ 하락 TOP 5**')
    if top_movers_dn:
        body.append('| nickname | Δ | 게임 | 현재 rating |')
        body.append('|---|---|---|---|')
        for n, d in top_movers_dn:
            body.append(f'| {n} | {d["delta_sum"]:+d} | {d["games"]} | {d["last_rating"]} |')
    else:
        body.append('- 없음')
    body.append('')

    # 안정성 / 임계 이력
    body.append('### 안정성 지표\n')
    body.append('| 항목 | 카운트 |')
    body.append('|---|---|')
    body.append(f'| game_over (전체) | {len(game_overs)} |')
    for r, c in sorted(reason_counts.items(), key=lambda x: -x[1]):
        body.append(f'| └ reason={r} | {c} |')
    body.append(f'| schedule RETRY (봇 wakeup, 정상) | {len(retry_logs)} |')
    body.append(f'| schedule SKIP (RETRY 실패) | {len(skip_logs)} |')
    body.append(f'| heartbeat_terminate (zombie 정리) | {len(hb_logs)} |')
    body.append(f'| **server_failed (전체)** | **{len(failures)}** |')
    body.append(f'| └ OOM (evicted) | {len(oom_fails)} |')
    body.append(f'| └ crash (nonZeroExit) | {len(crash_fails)} |')
    body.append(f'| deploy 횟수 | {deploy_count} |')
    body.append('')

    # server_failed 발생 시 상세 (시각 + reason)
    if failures:
        body.append('### 서버 장애 상세 (server_failed, 24h)\n')
        body.append('| 시각 (KST) | 인스턴스 | reason |')
        body.append('|---|---|---|')
        for f in failures[:10]:
            try:
                kst_ts = _parse_iso(f['ts']).astimezone(KST).strftime('%H:%M:%S')
            except Exception:
                kst_ts = f['ts'][:19]
            if f['evicted'] or f['oom']:
                reason = '**OOM** (evicted)'
            elif f['nonZeroExit']:
                reason = f'crash (nonZeroExit={f["nonZeroExit"]})'
            else:
                reason = 'unknown'
            body.append(f'| {kst_ts} | …{f["instance"][-6:]} | {reason} |')
        body.append('')

    body.append('### 임계 alert 이력 (24h)\n')
    if alert_history:
        for k, ts in alert_history:
            body.append(f'- `{ts[:19]}` — {k}')
    else:
        body.append('- 0건 (모두 임계 미달, 안전)')
    body.append('')

    # 7일 trend (CPU/Memory + PVP 게임 수 + 활성/총 사용자)
    body.append('### 7일 트렌드\n')
    if len(trend_days) >= 2:
        body.append('| 날짜 | Render CPU max | Aiven Mem max | PVP 게임 | 봇 게임 | 활성 사용자 | 총 계정 |')
        body.append('|---|---|---|---|---|---|---|')
        for d in trend_days:
            cpu_v = f'{d["render_cpu_max_m"]:.1f}m' if d['render_cpu_max_m'] is not None else '-'
            mem_v = f'{d["aiven_mem_max_pct"]:.2f}%' if d['aiven_mem_max_pct'] is not None else '-'
            pvp_v = str(d['pvp_games']) if d['pvp_games'] is not None else '-'
            bot_v = str(d['bot_games']) if d['bot_games'] is not None else '-'
            active_v = str(d['active_users']) if d.get('active_users') is not None else '-'
            total_v = str(d['total_users']) if d.get('total_users') is not None else '-'
            body.append(f'| {d["date"]} | {cpu_v} | {mem_v} | {pvp_v} | {bot_v} | {active_v} | {total_v} |')
        body.append('\n_활성 사용자 = 그 날 게임 한 판 이상 둔 unique 닉네임 (game_over 로그 기반). 총 계정 = `/api/stats` 가 그 날 daily-summary 발행 시 server 에서 가져온 사람 계정 수._')
    else:
        body.append('- 데이터 부족 (수집 시작 직후)')
    body.append('')

    body.append('---')
    body.append(f'_생성: {NOW.isoformat()} (workflow: monitor-infra, KST {NOW.astimezone(KST).strftime("%Y-%m-%d %H:%M")})_')

    body_text = '\n'.join(body)
    print(f'본문 길이: {len(body_text)} chars')

    # 일별 stats 저장 (7일 trend 누적용)
    if not DRY_RUN or os.environ.get('SAVE_METRICS') == '1':
        daily_stats[summary_date] = {
            'pvp_games': pvp_count,
            'bot_games': bot_game_count,
            'total_bot_moves': bot_total,
            'render_cpu_max_m': cpu_st.get('max') or 0,
            'aiven_mem_max_pct': aiven_mem.get('max') or 0,
            # PR #95 — 활성/총 사용자 trend 누적
            'active_users': active_users_24h,
            'total_human_users': (server_stats or {}).get('total_human_users'),
        }
        # 30일 이상 오래된 entry 정리
        cutoff = (kst_today_00 - timedelta(days=30)).strftime('%Y-%m-%d')
        daily_stats = {k: v for k, v in daily_stats.items() if k >= cutoff}
        save_daily_stats(daily_stats)
        print(f'  saved: daily-stats.json ({len(daily_stats)} entries)')

    # 이전 daily-summary close
    prev = list_issues_by_label('daily-summary', state='open')
    print(f'이전 open daily-summary Issue: {len(prev)}개')
    for issue in prev:
        if isinstance(issue, dict) and 'number' in issue:
            close_issue(issue['number'])
            print(f'  closed: #{issue["number"]} {issue.get("title", "")[:60]}')

    # 새 daily-summary Issue
    title = f'[daily-summary] {summary_date} KST 인프라/게임 요약'
    labels = ['monitor', 'daily-summary', 'severity-low']
    url = create_issue(title, body_text, labels)
    print(f'  created: {url}')


# ============================================================
# main
# ============================================================
def main():
    if not RENDER_API_KEY:
        print('ERROR: RENDER_API_KEY 필요', file=sys.stderr); sys.exit(1)
    if not AIVEN_API_TOKEN:
        print('ERROR: AIVEN_API_TOKEN 필요', file=sys.stderr); sys.exit(1)

    print(f'=== monitor MODE={MODE} (DRY_RUN={DRY_RUN}) ===')

    if MODE == 'collect':
        run_collect()
    elif MODE == 'daily-summary':
        run_daily_summary()
    else:
        print(f'ERROR: unknown MODE={MODE}', file=sys.stderr); sys.exit(1)


if __name__ == '__main__':
    main()
