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


def run_daily_summary():
    # 시간 범위 — 지난 24시간
    win_end = NOW
    win_start = NOW - timedelta(hours=24)
    s_iso = win_start.strftime('%Y-%m-%dT%H:%M:%SZ')
    e_iso = win_end.strftime('%Y-%m-%dT%H:%M:%SZ')
    kst_today = NOW.astimezone(KST).strftime('%Y-%m-%d')

    print(f'=== daily-summary {kst_today} (KST) ===')

    # 1) Render 24h 메트릭
    cpu = render_metric('cpu', s_iso, e_iso, 300)
    mem = render_metric('memory', s_iso, e_iso, 300)
    bw_start = (NOW - timedelta(days=30)).strftime('%Y-%m-%dT%H:%M:%SZ')
    bw = render_metric('bandwidth', bw_start, e_iso, 300)
    cpu_st = render_cpu_stats(cpu) or {}
    mem_st = render_mem_stats(mem) or {}
    bw_30d = render_bw_sum_mb(bw)

    # 2) Aiven 24h 메트릭
    aiven = aiven_metrics(period='day')
    aiven_cpu = aiven_stats(aiven, 'cpu_usage') or {}
    aiven_mem = aiven_stats(aiven, 'mem_usage') or {}
    aiven_disk = aiven_stats(aiven, 'disk_usage') or {}
    aiven_load = aiven_stats(aiven, 'load_average') or {}

    # 3) 봇 활동 24h
    bot_logs = render_search_logs('move applied', s_iso, e_iso, limit=100, max_pages=10)
    bot_moves = parse_bot_moves(bot_logs)
    bot_by_cfg = bot_stats_by_cfg(bot_moves)
    by_hour_kst = hourly_bot_activity(bot_moves)

    # 4) 게임 결과 / 안정성 지표 — Render 로그 카운트
    game_over_logs = render_search_logs('game_over', s_iso, e_iso, limit=100, max_pages=3)
    skip_logs = render_search_logs('schedule SKIP', s_iso, e_iso, limit=50)
    hb_logs = render_search_logs('heartbeat_terminate', s_iso, e_iso, limit=100, max_pages=2)
    ws_conn_logs = render_search_logs('ws_connected', s_iso, e_iso, limit=100, max_pages=5)
    game_started_logs = render_search_logs('game_started', s_iso, e_iso, limit=100)

    # game_over reason 카운트
    reason_re = re.compile(r'reason=(\w+)')
    reason_counts = defaultdict(int)
    for L in game_over_logs:
        m = reason_re.search(L.get('message', ''))
        if m: reason_counts[m.group(1)] += 1

    # 5) 임계 alert 이력 24h (state.json 의 last_alert 시각 기준)
    state = load_state()
    alert_history = []
    for k, ts in state.get('last_alert', {}).items():
        try:
            dt = _parse_iso(ts)
            if dt > NOW - timedelta(hours=24):
                alert_history.append((k, ts))
        except Exception:
            pass

    # 6) 7일 트렌드 — metrics/ 시계열에서 일별 max 추출
    recent = load_recent_metrics(days=7)
    trend_days = []  # [(date_str, render_cpu_max, aiven_mem_max)]
    by_day = defaultdict(list)
    for s in recent:
        d = s.get('ts', '')[:10]
        if d: by_day[d].append(s)
    for d in sorted(by_day.keys())[-7:]:
        snaps = by_day[d]
        cpu_maxes = [s.get('render', {}).get('cpu_peak_m') for s in snaps if s.get('render', {}).get('cpu_peak_m') is not None]
        mem_maxes = [s.get('aiven', {}).get('mem_pct_max') for s in snaps if s.get('aiven', {}).get('mem_pct_max') is not None]
        trend_days.append({
            'date': d,
            'render_cpu_max_m': max(cpu_maxes) if cpu_maxes else None,
            'aiven_mem_max_pct': max(mem_maxes) if mem_maxes else None,
        })

    # 7) Aiven memory 장기 추정 (선형 회귀 간단 — 7일 변화율)
    aiven_trend_msg = '(데이터 부족)'
    valid_mem = [(d['date'], d['aiven_mem_max_pct']) for d in trend_days if d['aiven_mem_max_pct'] is not None]
    if len(valid_mem) >= 2:
        first_p = valid_mem[0][1]
        last_p = valid_mem[-1][1]
        days_span = max(1, len(valid_mem) - 1)
        per_week_pct = (last_p - first_p) / days_span * 7  # %p / 주
        if per_week_pct > 0.01:
            weeks_to_80 = (80 - last_p) / per_week_pct
            aiven_trend_msg = f'주당 {per_week_pct:+.2f}%p — 80% 도달 예상: ~{weeks_to_80:.1f}주 후'
        elif per_week_pct < -0.01:
            aiven_trend_msg = f'주당 {per_week_pct:+.2f}%p (감소 추세) — 안정'
        else:
            aiven_trend_msg = f'주당 {per_week_pct:+.2f}%p (평탄)'

    # ====== Issue 본문 작성 ======
    bot_total = len(bot_moves)
    games_started = len(game_started_logs)
    ws_unique = len(ws_conn_logs)

    body = []
    body.append(f'## 일일 인프라 요약 — {kst_today} KST (지난 24h)\n')

    # 자원 사용율 gauge (table)
    body.append('### 자원 사용율 (현재 → 한도)\n')
    body.append(gauge_table([
        ('Render CPU peak',  cpu_st.get('max') or 0, RENDER_CPU_LIMIT_M, 'm'),
        ('Render Memory peak', mem_st.get('max') or 0, RENDER_MEM_LIMIT_MB, 'MB'),
        ('Render Bandwidth 30d', bw_30d / 1024, RENDER_BW_LIMIT_GB, 'GB'),
        ('Aiven CPU max', aiven_cpu.get('max') or 0, 100, '%'),
        ('Aiven Memory max', aiven_mem.get('max') or 0, 100, '%'),
    ]))
    body.append('')

    # Render/Aiven 24h 통계
    body.append('### Render 메트릭 (24h)\n')
    body.append('| 항목 | avg | p50 | p95 | max |')
    body.append('|---|---|---|---|---|')
    body.append(f'| CPU (m) | {cpu_st.get("avg",0):.1f} | {cpu_st.get("p50",0):.1f} | {cpu_st.get("p95",0):.1f} | {cpu_st.get("max",0):.1f} |')
    body.append(f'| Memory (MB) | {mem_st.get("avg",0):.1f} | {mem_st.get("p50",0):.1f} | {mem_st.get("p95",0):.1f} | {mem_st.get("max",0):.1f} |')
    body.append(f'| Bandwidth 30d 누적 | {bw_30d:.1f}MB (한도 100GB) |  |  |  |')
    body.append('')

    body.append('### Aiven valkey 메트릭 (24h)\n')
    body.append('| 항목 | avg | p50 | p95 | max |')
    body.append('|---|---|---|---|---|')
    body.append(f'| CPU % | {aiven_cpu.get("avg",0):.2f} | {aiven_cpu.get("p50",0):.2f} | {aiven_cpu.get("p95",0):.2f} | {aiven_cpu.get("max",0):.2f} |')
    body.append(f'| Memory % | {aiven_mem.get("avg",0):.2f} | {aiven_mem.get("p50",0):.2f} | {aiven_mem.get("p95",0):.2f} | {aiven_mem.get("max",0):.2f} |')
    body.append(f'| Disk % | {aiven_disk.get("avg",0):.3f} | — | — | {aiven_disk.get("max",0):.3f} |')
    body.append(f'| Load avg | {aiven_load.get("avg",0):.2f} | — | {aiven_load.get("p95",0):.2f} | {aiven_load.get("max",0):.2f} |')
    body.append('')
    body.append(f'**Aiven 장기 메모리 트렌드**: {aiven_trend_msg}\n')

    # 봇 활동
    body.append('### 봇 활동 (24h)\n')
    body.append(f'- 총 봇 착수: **{bot_total}건**')
    body.append(f'- 새 게임 시작: **{games_started}건**')
    body.append(f'- 새 ws 연결 (대략): **{ws_unique}건**')
    body.append('')

    if bot_by_cfg:
        body.append('### cfgMax 도달율 (cfg 별)\n')
        body.append('| 난이도 | cfg | n | avg/p50/p95 elapsed (ms) | cfgMax 도달 |')
        body.append('|---|---|---|---|---|')
        for diff in ['easy', 'medium', 'hard']:
            if diff not in bot_by_cfg: continue
            for cfg_key, st in sorted(bot_by_cfg[diff].items()):
                body.append(f'| {diff} | {cfg_key} | {st["n"]} | {st["avg_elap"]}/{st["p50_elap"]}/{st["p95_elap"]} | **{st["cfgmax_pct"]:.1f}%** |')
        body.append('')

    # 안정성 지표
    body.append('### 안정성 지표 (24h)\n')
    body.append('| 항목 | 카운트 |')
    body.append('|---|---|')
    body.append(f'| game_over (전체 종료) | {len(game_over_logs)} |')
    for r, c in sorted(reason_counts.items(), key=lambda x: -x[1]):
        body.append(f'| └ reason={r} | {c} |')
    body.append(f'| [bot] schedule SKIP | {len(skip_logs)} |')
    body.append(f'| heartbeat_terminate (zombie 정리) | {len(hb_logs)} |')
    body.append('')

    # 임계 alert 이력
    body.append('### 임계 alert 이력 (24h)\n')
    if alert_history:
        for k, ts in alert_history:
            body.append(f'- `{ts[:19]}` — {k}')
    else:
        body.append('- 0건 (모두 임계 미달, 안전)')
    body.append('')

    # 7일 트렌드 비교
    body.append('### 7일 트렌드 비교\n')
    if len(trend_days) >= 2:
        body.append('| 날짜 | Render CPU max | Aiven Memory max |')
        body.append('|---|---|---|')
        for d in trend_days:
            cpu_v = f'{d["render_cpu_max_m"]:.1f}m' if d['render_cpu_max_m'] is not None else '-'
            mem_v = f'{d["aiven_mem_max_pct"]:.2f}%' if d['aiven_mem_max_pct'] is not None else '-'
            body.append(f'| {d["date"]} | {cpu_v} | {mem_v} |')
    else:
        body.append('- 데이터 부족 (수집 시작 직후)')
    body.append('')

    # 시간대별 봇 활동 (KST)
    if by_hour_kst:
        body.append('### 시간대별 봇 활동 (KST hour, 24h)\n')
        body.append('| hour (KST) | 봇 착수 | bar |')
        body.append('|---|---|---|')
        max_v = max(by_hour_kst.values()) if by_hour_kst.values() else 1
        for h in range(24):
            v = by_hour_kst.get(h, 0)
            bar = '█' * int(20 * v / max_v) if max_v > 0 else ''
            body.append(f'| {h:02d}:00 | {v} | `{bar}` |')
        body.append('')

    # ====== Mermaid 차트 4종 ======
    body.append('### 시각화\n')

    # 1) 7일 CPU/Memory 트렌드
    if len(trend_days) >= 2:
        x = [d['date'][5:] for d in trend_days]  # MM-DD
        cpu_vals = [d['render_cpu_max_m'] or 0 for d in trend_days]
        mem_vals = [d['aiven_mem_max_pct'] or 0 for d in trend_days]
        body.append('#### Render CPU peak vs Aiven Memory max (7일)\n')
        body.append(mermaid_line_chart('Render CPU (m) / Aiven Memory (%) - 7d', x,
                                       {'Render_CPU_m': cpu_vals, 'Aiven_Mem_pct': mem_vals},
                                       'value'))
        body.append('')

    # 2) 24h 시간대별 봇 활동
    if by_hour_kst:
        x = [f'{h:02d}' for h in range(24)]
        v = [by_hour_kst.get(h, 0) for h in range(24)]
        body.append('#### 시간대별 봇 활동 (KST hour, bar)\n')
        body.append(mermaid_bar_chart('Bot moves per KST hour (24h)', x, v, 'moves'))
        body.append('')

    # 3) cfgMax 도달율 변화 (7일) — 단순화: 오늘만 표시 (시계열 누적 필요)
    if bot_by_cfg.get('hard'):
        body.append('#### hard 봇 cfgMax 도달율 (오늘, cfg 별)\n')
        cfgs = sorted(bot_by_cfg['hard'].keys())
        x = cfgs
        v = [bot_by_cfg['hard'][k]['cfgmax_pct'] for k in cfgs]
        body.append(mermaid_bar_chart('hard cfgMax 도달율 %', x, v, '%'))
        body.append('')

    # 4) gauge — 이미 위에서 표로 표현됨
    body.append('#### 자원 사용율 (표는 상단)\n')
    body.append('한도 대비 사용율은 본문 상단 "자원 사용율" 표 참고.\n')

    body.append('---')
    body.append(f'_생성: {NOW.isoformat()} (workflow: monitor-infra)_')

    body_text = '\n'.join(body)
    print(f'본문 길이: {len(body_text)} chars')

    # 이전 daily-summary Issue close
    prev = list_issues_by_label('daily-summary', state='open')
    print(f'이전 open daily-summary Issue: {len(prev)}개')
    for issue in prev:
        if isinstance(issue, dict) and 'number' in issue:
            close_issue(issue['number'])
            print(f'  closed: #{issue["number"]} {issue.get("title", "")[:60]}')

    # 새 daily-summary Issue 생성
    title = f'[daily-summary] {kst_today} KST 인프라 요약'
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
