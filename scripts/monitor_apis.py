"""monitor 의 외부 API 호출 — Render / Aiven / GitHub / 자체 server.

각 API 는 raw JSON 그대로 반환. 가공은 monitor_data 에 위임.
"""
from __future__ import annotations
import json
import sys
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
# HTTP helpers
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


def render_search_logs(text, start_iso, end_iso, limit=100, max_pages=5, service='omok'):
    """로그 검색 (페이지네이션). service 별 service_id."""
    all_logs = []
    end = end_iso
    for _ in range(max_pages):
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
        logs = data.get('logs') or []
        if not logs: break
        all_logs.extend(logs)
        if not data.get('hasMore'): break
        end = data.get('nextEndTime', '')
        if not end: break
    return all_logs


def render_events(start_iso, end_iso, limit=100, service='omok'):
    """Render events API — server_failed/available/deploy 등 인프라 이벤트.
    API 는 startTime 미지원 → endTime + limit 으로 fetch 후 client-side 필터."""
    qs = urllib.parse.urlencode({'endTime': end_iso, 'limit': limit})
    url = f'https://api.render.com/v1/services/{_service_id(service)}/events?{qs}'
    try:
        events = http_get(url, render_headers())
    except urllib.error.HTTPError:
        return []
    try:
        start_dt = parse_iso(start_iso)
    except Exception:
        return events
    out = []
    for e in events:
        ts = e.get('event', {}).get('timestamp', '')
        if not ts: continue
        try:
            dt = parse_iso(ts)
            if dt >= start_dt: out.append(e)
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
