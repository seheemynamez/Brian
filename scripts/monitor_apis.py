"""monitor 의 외부 API 호출 — Render / Aiven / GitHub / 자체 server.

각 API 는 raw JSON 그대로 반환. 가공은 monitor_data 에 위임.

## 정책
- **Retry**: 모든 HTTP 호출은 transient 에러 (HTTP 429/502/503/504/network)
  에 대해 exp backoff (1→2→4s, 최대 3회) 자동 재시도. 4xx 4xx (404/400/...)
  는 영구 에러로 즉시 propagate. 호출자는 try/except 로 graceful skip.
- **Pagination**: window 안 모든 데이터 누적 (cursor / nextEndTime). safety
  max_iter=50 — 5000건 (limit=100) 이상 fetch 차단.
- **Limit cap**: Render API limit max=100 (200 호출 시 400 'invalid limit:
  too large' — PR #130 silent failure 사례). 100 + 페이지네이션 표준.
"""
from __future__ import annotations
import json
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from monitor_config import (
    AIVEN_API_TOKEN, AIVEN_PROJECT, AIVEN_SERVICE,
    DRY_RUN, GH_REPO, GH_TOKEN,
    RENDER_API_KEY, RENDER_OWNER_ID, RENDER_SERVICE_ID,
    SERVER_PUBLIC_URL, SERVICES,
)
from monitor_data import parse_iso


# ============================================================
# HTTP retry — transient 에러 (5xx, 429, network) 만 자동 재시도.
# 429 는 Retry-After 헤더 (RFC 7231) 가 있으면 그 값 우선. 없으면 exp backoff.
# ============================================================
TRANSIENT_HTTP_STATUS = {429, 502, 503, 504}
RETRY_MAX = 5
RETRY_BASE_S = 1.0      # exp backoff: 1, 2, 4, 8, 16s (RETRY_MAX-1 까지)
RETRY_BACKOFF_CAP_S = 30.0   # Retry-After 가 너무 길어도 cap (workflow timeout 보호)


def _is_transient(exc):
    """HTTP 5xx/429 또는 network/socket 에러면 retry 대상."""
    if isinstance(exc, urllib.error.HTTPError):
        return exc.code in TRANSIENT_HTTP_STATUS
    if isinstance(exc, urllib.error.URLError):
        return True
    if isinstance(exc, (socket.timeout, TimeoutError)):
        return True
    return False


def _retry_after_seconds(exc):
    """HTTP 429 응답의 Retry-After 헤더 (초 또는 HTTP-date) → 초. 없거나 parse 실패면 None.

    RFC 7231 §7.1.3:
      Retry-After = HTTP-date | delta-seconds
    delta-seconds (정수 초) 우선 — 가장 흔함. HTTP-date 는 지원 안 함 (parse 복잡).
    """
    if not isinstance(exc, urllib.error.HTTPError):
        return None
    if exc.code != 429:
        return None
    if not exc.headers:
        return None
    h = exc.headers.get('Retry-After')
    if not h:
        return None
    try:
        return max(0.0, float(h.strip()))
    except (ValueError, AttributeError):
        return None   # HTTP-date 형식 — exp backoff fallback


def _with_retry(call, label='http'):
    """call() 을 RETRY_MAX 번까지 transient 에러 시 재시도.
    429: Retry-After 헤더 값 우선 (cap RETRY_BACKOFF_CAP_S). 없으면 exp backoff.
    기타 transient (5xx/network): exp backoff (cap = RETRY_BASE_S * 2^(MAX-2)).
    영구 에러 (4xx 4xx 외) 는 즉시 propagate — 호출자가 catch.
    """
    last_exc = None
    for attempt in range(RETRY_MAX):
        try:
            return call()
        except Exception as e:
            last_exc = e
            if not _is_transient(e):
                raise
            if attempt < RETRY_MAX - 1:
                # exp backoff (1, 2, 4, 8, 16s — cap 30s) 을 기본선으로 두고, 429
                # Retry-After 가 더 길면 그걸 우선. Retry-After=0/작은 값으로 instant
                # retry 가 되지 않게 exp 와 max.
                exp = min(RETRY_BASE_S * (2 ** attempt), RETRY_BACKOFF_CAP_S)
                retry_after = _retry_after_seconds(e)
                if retry_after is not None:
                    backoff = max(min(retry_after, RETRY_BACKOFF_CAP_S), exp)
                    src = 'Retry-After+exp'
                else:
                    backoff = exp
                    src = 'exp'
                code = getattr(e, 'code', type(e).__name__)
                print(f'  [{label}] transient {code} ({src}): retry in {backoff:.1f}s '
                      f'(attempt {attempt + 1}/{RETRY_MAX})', file=sys.stderr)
                time.sleep(backoff)
    raise last_exc


# ============================================================
# HTTP helpers — 모두 _with_retry 로 wrapping.
# ============================================================
def http_get(url, headers=None, timeout=30):
    def call():
        req = urllib.request.Request(url, headers=headers or {}, method='GET')
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    return _with_retry(call, label=f'GET {url[:60]}')


def http_post(url, body, headers=None, timeout=30):
    def call():
        data = json.dumps(body).encode()
        h = {'Content-Type': 'application/json', **(headers or {})}
        req = urllib.request.Request(url, data=data, headers=h, method='POST')
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    return _with_retry(call, label=f'POST {url[:60]}')


def http_patch(url, body, headers=None, timeout=30):
    def call():
        data = json.dumps(body).encode()
        h = {'Content-Type': 'application/json', **(headers or {})}
        req = urllib.request.Request(url, data=data, headers=h, method='PATCH')
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    return _with_retry(call, label=f'PATCH {url[:60]}')


# Pagination safety cap — 한 호출당 fetch 반복 max (= limit × max_iter 건 상한).
# 5000건 (100 × 50). 24h window 의 ws_connected 등 대용량 시계열 cover.
PAGINATE_MAX_ITER = 50


def _track_fetch(state, key, success):
    """fetch helper — 호출자 (collect/summary) 가 fail_streak 추적 원하면
    state/key 전달. 여기서 monitor_data 의 incr/reset 호출 (lazy import).
    state=None 또는 key=None 이면 no-op."""
    if state is None or key is None:
        return
    from monitor_data import incr_fail_streak, reset_fail_streak
    if success:
        reset_fail_streak(state, key)
    else:
        incr_fail_streak(state, key)


# ============================================================
# Render API
# ============================================================
def render_headers():
    return {'Authorization': f'Bearer {RENDER_API_KEY}'}


def _service_id(service):
    return SERVICES[service]['service_id']


def _service_url(service):
    return SERVICES[service]['public_url']


def render_metric(kind, start_iso, end_iso, resolution_s=300, service='omok'):
    qs = urllib.parse.urlencode({
        'resource': _service_id(service),
        'startTime': start_iso, 'endTime': end_iso,
        'resolutionSeconds': resolution_s,
    })
    return http_get(f'https://api.render.com/v1/metrics/{kind}?{qs}', render_headers())


def render_recent_deploy_status(service='omok'):
    url = f'https://api.render.com/v1/services/{_service_id(service)}/deploys?limit=1'
    data = http_get(url, render_headers())
    if not data: return None
    dep = data[0].get('deploy', {})
    return {
        'status': dep.get('status'),
        'createdAt': dep.get('createdAt'),
        'commit': (dep.get('commit') or {}).get('message', '').split('\n')[0][:60],
    }


def render_search_logs(text, start_iso, end_iso, limit=100, max_iter=PAGINATE_MAX_ITER,
                       service='omok', track_state=None, track_key=None):
    """로그 검색 (nextEndTime backward pagination).

    Window 안 모든 로그 누적. safety cap = limit × max_iter 건.
    의도적으로 작은 sample 만 보려면 max_iter=1 + limit 작게.

    track_state / track_key 전달 시 fail_streak 추적:
      - 첫 페이지부터 HTTPError → incr_fail_streak (fetch fail).
      - 적어도 한 페이지 성공 → reset_fail_streak.
    """
    all_logs = []
    end = end_iso
    fetched_any = False
    for _ in range(max_iter):
        qs = urllib.parse.urlencode({
            'ownerId': RENDER_OWNER_ID, 'resource': _service_id(service),
            'startTime': start_iso, 'endTime': end,
            'text': text, 'limit': limit, 'direction': 'backward',
        })
        url = f'https://api.render.com/v1/logs?{qs}'
        try:
            data = http_get(url, render_headers())
        except urllib.error.HTTPError:
            break
        fetched_any = True
        logs = data.get('logs') or []
        if not logs: break
        all_logs.extend(logs)
        if not data.get('hasMore'): break
        end = data.get('nextEndTime', '')
        if not end: break
    _track_fetch(track_state, track_key, fetched_any)
    return all_logs


def render_events(start_iso, end_iso, limit=100, max_iter=PAGINATE_MAX_ITER,
                  service='omok', track_state=None, track_key=None):
    """Render events API — server_failed/available/deploy 등 인프라 이벤트.

    API 는 startTime 미지원 + limit max=100 → endTime backward + cursor
    페이지네이션. 매 호출 응답의 마지막 event 의 cursor 를 다음 호출에 전달.
    window 시작 도달 시 stop. client-side 로 startTime 이전 event 필터.

    track_state / track_key 전달 시 fail_streak 추적 (render_search_logs 와 동일).
    """
    all_events = []
    cursor = None
    fetched_any = False
    try:
        start_dt = parse_iso(start_iso)
    except Exception:
        start_dt = None

    for _ in range(max_iter):
        params = {'endTime': end_iso, 'limit': limit}
        if cursor:
            params['cursor'] = cursor
        url = f'https://api.render.com/v1/services/{_service_id(service)}/events?{urllib.parse.urlencode(params)}'
        try:
            events = http_get(url, render_headers())
        except urllib.error.HTTPError:
            break
        fetched_any = True
        if not events:
            break
        all_events.extend(events)
        # window 시작 이전 도달 시 stop (마지막 event 의 timestamp 기준).
        last_ts = events[-1].get('event', {}).get('timestamp', '')
        if start_dt and last_ts:
            try:
                if parse_iso(last_ts) < start_dt:
                    break
            except Exception:
                pass
        # 다음 cursor — 마지막 event 의 cursor 필드 (Render API 표준).
        cursor = events[-1].get('cursor')
        if not cursor:
            break
    _track_fetch(track_state, track_key, fetched_any)

    # client-side 필터 (startTime 이전 잘라냄).
    if not start_dt:
        return all_events
    out = []
    for e in all_events:
        ts = e.get('event', {}).get('timestamp', '')
        if not ts: continue
        try:
            if parse_iso(ts) >= start_dt:
                out.append(e)
        except Exception:
            continue
    return out


# ============================================================
# 자체 server /api/stats — 운영 user 카운트 (PR #95)
# ============================================================
def fetch_server_stats(service='omok'):
    """GET /api/stats — service 별 응답 형식 다름:
      omok: {total_human_users, ts}
      2048: {total_users, top_all_time, top_daily, active_ws, ts}
    cold-start / down 시 None.
    """
    try:
        return http_get(f'{_service_url(service)}/api/stats', timeout=10)
    except Exception as e:
        print(f'  [{service}] /api/stats fetch 실패: {e}')
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
