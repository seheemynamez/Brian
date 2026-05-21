#!/usr/bin/env python3
"""
인프라 메트릭 수집 + 임계 검사 + 알림 발송.

GitHub Actions 의 monitor-infra.yml 에서 매 30분 호출.
로컬에서도 dry-run 가능 — GH_TOKEN 없으면 알림 안 발송 (출력만).

수집 대상:
  - Render (web service): CPU/Memory/Bandwidth 메트릭, 최근 배포 상태
  - Aiven (valkey): CPU/Memory/Disk/Load 메트릭
  - Render 로그: 봇 관련 에러 (worker_timeout, search no move, deploy 실패 흔적)

알림 채널: GitHub Issue (REST API, GITHUB_TOKEN 사용)
cooldown: 같은 종류 알림은 6시간마다 1회 (state.json 으로 추적)

저장:
  metrics/YYYY-MM-DD.json — 일별 수집 데이터 (시계열 append)
  metrics/state.json — cooldown 상태
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

# ============================================================
# 환경
# ============================================================
RENDER_API_KEY = os.environ.get('RENDER_API_KEY', '')
AIVEN_API_TOKEN = os.environ.get('AIVEN_API_TOKEN', '')
GH_TOKEN = os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN', '')
GH_REPO = os.environ.get('GITHUB_REPOSITORY', 'seheemynamez/Brian')  # owner/repo
DRY_RUN = os.environ.get('DRY_RUN', '0') == '1' or not GH_TOKEN

# Render / Aiven 식별자 (현재 운영 인프라)
RENDER_SERVICE_ID = 'srv-d84mu23tqb8s73fgcq60'
RENDER_OWNER_ID = 'tea-d84jo8jrjlhs73d9afeg'
AIVEN_PROJECT = 'se2hee-93ed'
AIVEN_SERVICE = 'valkey-411207c'

# 임계
THRESHOLD_RENDER_CPU_M = 90.0           # millicore (한도 100m)
THRESHOLD_AIVEN_MEM_PCT = 80.0          # % (한도 100%, noeviction 정책)
COOLDOWN_HOURS = 6

# 경로
REPO_ROOT = Path(__file__).resolve().parent.parent
METRICS_DIR = REPO_ROOT / 'metrics'
STATE_FILE = METRICS_DIR / 'state.json'

NOW = datetime.now(timezone.utc)
TODAY = NOW.strftime('%Y-%m-%d')


# ============================================================
# HTTP 헬퍼
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


# ============================================================
# Render
# ============================================================
def render_headers():
    return {'Authorization': f'Bearer {RENDER_API_KEY}'}


def render_metric(kind, start_iso, end_iso, resolution_s=300):
    """Render 메트릭 fetch. kind = cpu / memory / bandwidth."""
    qs = urllib.parse.urlencode({
        'resource': RENDER_SERVICE_ID,
        'startTime': start_iso,
        'endTime': end_iso,
        'resolutionSeconds': resolution_s,
    })
    url = f'https://api.render.com/v1/metrics/{kind}?{qs}'
    return http_get(url, render_headers())


def render_recent_deploy_status():
    """최근 배포 상태 (live / failed / ...)."""
    url = f'https://api.render.com/v1/services/{RENDER_SERVICE_ID}/deploys?limit=1'
    data = http_get(url, render_headers())
    if not data:
        return None
    dep = data[0].get('deploy', {})
    return {
        'status': dep.get('status'),
        'createdAt': dep.get('createdAt'),
        'commit': (dep.get('commit') or {}).get('message', '').split('\n')[0][:60],
    }


def render_search_logs(text, start_iso, end_iso, limit=10):
    """로그 검색. text 패턴 카운트만 필요."""
    qs = urllib.parse.urlencode({
        'ownerId': RENDER_OWNER_ID,
        'resource': RENDER_SERVICE_ID,
        'startTime': start_iso,
        'endTime': end_iso,
        'text': text,
        'limit': limit,
        'direction': 'backward',
    })
    url = f'https://api.render.com/v1/logs?{qs}'
    data = http_get(url, render_headers())
    logs = data.get('logs') or []
    return logs


# ============================================================
# Aiven
# ============================================================
def aiven_headers():
    return {'Authorization': f'aivenv1 {AIVEN_API_TOKEN}'}


def aiven_metrics(period='hour'):
    """Aiven valkey 메트릭 — POST + period 파라미터."""
    url = f'https://api.aiven.io/v1/project/{AIVEN_PROJECT}/service/{AIVEN_SERVICE}/metrics'
    return http_post(url, {'period': period}, aiven_headers())


# ============================================================
# 메트릭 가공
# ============================================================
def render_cpu_peak_millicore(samples):
    """Render CPU 샘플에서 peak (millicore 단위) 추출."""
    vals = []
    for s in samples:
        for v in s.get('values', []):
            if v.get('value') is not None:
                vals.append(v['value'])
    if not vals:
        return None
    return max(vals) * 1000  # core -> millicore


def render_mem_peak_mb(samples):
    vals = []
    for s in samples:
        for v in s.get('values', []):
            if v.get('value') is not None:
                vals.append(v['value'])
    if not vals:
        return None
    MB = 1024 * 1024
    return max(vals) / MB


def aiven_metric_peak(metrics_dict, key):
    """Aiven metrics dict 에서 특정 key 의 peak 추출. None 이면 데이터 없음."""
    m = metrics_dict.get('metrics', {}).get(key, {})
    rows = m.get('data', {}).get('rows', [])
    vals = [r[1] for r in rows[1:] if isinstance(r, list) and len(r) >= 2 and r[1] is not None]
    if not vals:
        return None
    return max(vals)


def aiven_metric_avg(metrics_dict, key):
    m = metrics_dict.get('metrics', {}).get(key, {})
    rows = m.get('data', {}).get('rows', [])
    vals = [r[1] for r in rows[1:] if isinstance(r, list) and len(r) >= 2 and r[1] is not None]
    if not vals:
        return None
    return sum(vals) / len(vals)


# ============================================================
# 상태 (cooldown)
# ============================================================
def load_state():
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {'last_alert': {}}


def save_state(state):
    METRICS_DIR.mkdir(exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False))


def cooldown_ok(state, alert_key):
    """이 알림 종류가 cooldown 통과한 상태인지."""
    last = state.get('last_alert', {}).get(alert_key)
    if not last:
        return True
    last_dt = datetime.fromisoformat(last.replace('Z', '+00:00'))
    return NOW > last_dt + timedelta(hours=COOLDOWN_HOURS)


def mark_alerted(state, alert_key):
    state.setdefault('last_alert', {})[alert_key] = NOW.isoformat()


# ============================================================
# GitHub Issue 알림
# ============================================================
def post_github_issue(title, body, labels=None):
    if DRY_RUN:
        print(f'[DRY_RUN] Would create Issue: {title}')
        print(f'  Labels: {labels}')
        print(f'  Body:\n{body}\n')
        return None
    url = f'https://api.github.com/repos/{GH_REPO}/issues'
    headers = {
        'Authorization': f'Bearer {GH_TOKEN}',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    }
    body_dict = {'title': title, 'body': body}
    if labels:
        body_dict['labels'] = labels
    try:
        resp = http_post(url, body_dict, headers)
        return resp.get('html_url')
    except urllib.error.HTTPError as e:
        print(f'  GH Issue 생성 실패: {e.code} {e.reason}', file=sys.stderr)
        return None


# ============================================================
# 메인
# ============================================================
def main():
    if not RENDER_API_KEY:
        print('ERROR: RENDER_API_KEY 환경변수 필요', file=sys.stderr)
        sys.exit(1)
    if not AIVEN_API_TOKEN:
        print('ERROR: AIVEN_API_TOKEN 환경변수 필요', file=sys.stderr)
        sys.exit(1)

    print(f'=== monitor 실행 {NOW.isoformat()} (DRY_RUN={DRY_RUN}) ===')

    # 시간 윈도우 — 최근 30분
    win_end = NOW
    win_start = NOW - timedelta(minutes=30)
    s_iso = win_start.strftime('%Y-%m-%dT%H:%M:%SZ')
    e_iso = win_end.strftime('%Y-%m-%dT%H:%M:%SZ')

    # 1) Render 메트릭
    render_cpu = render_metric('cpu', s_iso, e_iso, resolution_s=60)
    render_mem = render_metric('memory', s_iso, e_iso, resolution_s=60)
    cpu_peak_m = render_cpu_peak_millicore(render_cpu)
    mem_peak_mb = render_mem_peak_mb(render_mem)

    # 2) Render 배포 상태
    deploy = render_recent_deploy_status()

    # 3) Render 로그 — 봇 에러 (최근 30분)
    worker_timeout_logs = render_search_logs('worker_timeout', s_iso, e_iso, limit=10)
    no_move_logs = render_search_logs('search returned no move', s_iso, e_iso, limit=10)

    # 4) Aiven 메트릭
    aiven = aiven_metrics(period='hour')
    aiven_cpu_max = aiven_metric_peak(aiven, 'cpu_usage')
    aiven_mem_max = aiven_metric_peak(aiven, 'mem_usage')
    aiven_disk_max = aiven_metric_peak(aiven, 'disk_usage')
    aiven_cpu_avg = aiven_metric_avg(aiven, 'cpu_usage')
    aiven_mem_avg = aiven_metric_avg(aiven, 'mem_usage')

    # 요약
    snapshot = {
        'ts': NOW.isoformat(),
        'render': {
            'cpu_peak_m': cpu_peak_m,
            'mem_peak_mb': mem_peak_mb,
            'deploy_status': deploy.get('status') if deploy else None,
            'worker_timeout_count': len(worker_timeout_logs),
            'no_move_count': len(no_move_logs),
        },
        'aiven': {
            'cpu_pct_avg': aiven_cpu_avg,
            'cpu_pct_max': aiven_cpu_max,
            'mem_pct_avg': aiven_mem_avg,
            'mem_pct_max': aiven_mem_max,
            'disk_pct_max': aiven_disk_max,
        },
    }
    print(json.dumps(snapshot, indent=2, ensure_ascii=False))

    # 5) 임계 검사 → 알림
    state = load_state()
    alerts = []  # (alert_key, title, body, labels)

    if cpu_peak_m is not None and cpu_peak_m >= THRESHOLD_RENDER_CPU_M:
        title = f'[monitor] Render CPU peak {cpu_peak_m:.1f}m (≥{THRESHOLD_RENDER_CPU_M:.0f}m)'
        body = (
            f'## 알림: Render CPU peak 임계 초과\n\n'
            f'- 측정값: **{cpu_peak_m:.1f}m** (CPU peak, 최근 30분)\n'
            f'- 임계: ≥ {THRESHOLD_RENDER_CPU_M:.0f}m (한도 100m 의 {100*THRESHOLD_RENDER_CPU_M/100:.0f}%)\n'
            f'- 시각: {NOW.isoformat()}\n\n'
            f'### 같이 본 상태\n'
            f'- Render Memory peak: {mem_peak_mb:.1f}MB / 512MB\n'
            f'- Aiven CPU max: {aiven_cpu_max:.1f}%\n'
            f'- Aiven Memory max: {aiven_mem_max:.1f}%\n\n'
            f'### 다음 조치 후보\n'
            f'- 봇 동시 사용 패턴 점검 (Render 로그)\n'
            f'- Hobby plan ($7/월, 0.5 CPU + 512MB) 검토\n'
        )
        alerts.append(('render_cpu_high', title, body, ['monitor', 'severity-high']))

    if aiven_mem_max is not None and aiven_mem_max >= THRESHOLD_AIVEN_MEM_PCT:
        title = f'[monitor] Aiven valkey Memory {aiven_mem_max:.1f}% (≥{THRESHOLD_AIVEN_MEM_PCT:.0f}%)'
        body = (
            f'## 알림: Aiven valkey Memory 임계 초과\n\n'
            f'- 측정값: **{aiven_mem_max:.1f}%** (Memory peak, 최근 1시간)\n'
            f'- 임계: ≥ {THRESHOLD_AIVEN_MEM_PCT:.0f}% (한도 1024MB)\n'
            f'- noeviction 정책 — 100% 도달 시 write 실패 가능\n'
            f'- 시각: {NOW.isoformat()}\n\n'
            f'### 다음 조치 후보\n'
            f'- 정기 cleanup (room/session dispose) 검토\n'
            f'- Aiven plan upgrade (Startup-4 = 4GB / $30월) 검토\n'
        )
        alerts.append(('aiven_mem_high', title, body, ['monitor', 'severity-high']))

    if len(worker_timeout_logs) > 0:
        title = f'[monitor] worker_timeout 발생 {len(worker_timeout_logs)}건 (최근 30분)'
        sample_lines = '\n'.join(f'- `{L["timestamp"][:19]}` {L["message"][:140]}' for L in worker_timeout_logs[:5])
        body = (
            f'## 알림: 봇 worker_timeout 발생\n\n'
            f'- 카운트: **{len(worker_timeout_logs)}건** (최근 30분)\n'
            f'- 임계: > 0 (PR #82 이후 0건 유지 중)\n'
            f'- 시각: {NOW.isoformat()}\n\n'
            f'### 샘플 (최대 5개)\n{sample_lines}\n\n'
            f'### 다음 조치 후보\n'
            f'- self-abort 회귀 (deadline 검사 누락?) 의심\n'
            f'- 최근 PR / 배포 점검\n'
        )
        alerts.append(('worker_timeout', title, body, ['monitor', 'severity-critical']))

    if len(no_move_logs) > 0:
        title = f'[monitor] 봇 search returned no move {len(no_move_logs)}건'
        sample_lines = '\n'.join(f'- `{L["timestamp"][:19]}` {L["message"][:140]}' for L in no_move_logs[:5])
        body = (
            f'## 알림: 봇이 수를 못 두는 케이스 발생\n\n'
            f'- 카운트: **{len(no_move_logs)}건** (최근 30분)\n'
            f'- 임계: > 0\n\n'
            f'### 샘플\n{sample_lines}\n'
        )
        alerts.append(('no_move', title, body, ['monitor', 'severity-high']))

    if deploy and deploy['status'] not in ('live', 'pre_deploy_in_progress', 'build_in_progress', 'update_in_progress'):
        title = f'[monitor] Render 배포 상태 비정상: {deploy["status"]}'
        body = (
            f'## 알림: Render 배포 비정상\n\n'
            f'- 상태: **{deploy["status"]}**\n'
            f'- 시각: {deploy["createdAt"]}\n'
            f'- 커밋: {deploy["commit"]}\n'
        )
        alerts.append(('deploy_bad', title, body, ['monitor', 'severity-critical']))

    # 알림 발송 (cooldown 통과한 것만)
    alert_sent = []
    for key, title, body, labels in alerts:
        if not cooldown_ok(state, key):
            print(f'  alert {key} cooldown active — skip')
            continue
        url = post_github_issue(title, body, labels=labels)
        if url or DRY_RUN:
            alert_sent.append({'key': key, 'title': title, 'url': url})
            mark_alerted(state, key)
            print(f'  alerted: {key} → {url}')

    # 6) 메트릭 저장 (일별 append)
    if not DRY_RUN or os.environ.get('SAVE_METRICS') == '1':
        METRICS_DIR.mkdir(exist_ok=True)
        daily_file = METRICS_DIR / f'{TODAY}.json'
        if daily_file.exists():
            daily = json.loads(daily_file.read_text())
        else:
            daily = []
        daily.append(snapshot)
        daily_file.write_text(json.dumps(daily, indent=2, ensure_ascii=False))
        save_state(state)
        print(f'  saved: {daily_file.relative_to(REPO_ROOT)}')

    # 종료 코드 — 알림 있으면 1 (CI 가시성)
    if alerts:
        print(f'\n=== {len(alerts)} alert(s) detected ===')
    else:
        print('\n=== no alerts ===')


if __name__ == '__main__':
    main()
