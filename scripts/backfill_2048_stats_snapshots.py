#!/usr/bin/env python3
"""
One-time backfill: 옛 day 의 2048 daily Hash 에 total_users/top_all_time/top_daily snapshot 채우기.

전제:
- 2048 server statsHandler 는 이미 매 /api/stats 호출 시 daily Hash 에 snapshot 적재.
- 그 전 day 들 (5/22-23 일부) 은 statsHandler 의 부수효과가 없거나 호출 안 됨.
- metrics/YYYY-MM-DD.json 의 KST 어제 day last snapshot 의 services.2048.stats 가 가장 좋은 source.

source 우선: metrics 파일 last snapshot 의 services.2048.stats
target valkey key: 2048:prod:daily:YYYY-MM-DD
fields: total_users, top_all_time, top_daily

사용:
    source ~/.zshenv && use-sehee
    python3 scripts/backfill_2048_stats_snapshots.py            # dry-run
    python3 scripts/backfill_2048_stats_snapshots.py --apply    # 실제 HSET
"""
import argparse
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone, timedelta

from monitor_config import RENDER_API_KEY  # 단일 소스(targets.json)

KST = timezone(timedelta(hours=9))
DEFAULT_PREFIX = '2048:prod'
TARGET_DATES = ['2026-05-22', '2026-05-23', '2026-05-24']
METRICS_DIR = os.path.join(os.path.dirname(__file__), '..', 'metrics')


def parse_iso(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00'))


def get_valkey_url():
    url = os.environ.get('VALKEY_URL', '').strip()
    if url:
        return url
    api_key = RENDER_API_KEY
    if not api_key:
        sys.exit('VALKEY_URL 또는 RENDER_API_KEY env 필요')
    headers = {'Authorization': f'Bearer {api_key}'}
    req = urllib.request.Request('https://api.render.com/v1/services?limit=20', headers=headers)
    with urllib.request.urlopen(req, timeout=15) as r:
        svcs = json.loads(r.read())
    # 2048 server 의 VALKEY_URL (omok 와 같은 Aiven 인스턴스, prefix 다름)
    svc_id = next(s['service']['id'] for s in svcs if s['service']['name'] == '2048-server')
    req2 = urllib.request.Request(
        f'https://api.render.com/v1/services/{svc_id}/env-vars', headers=headers,
    )
    with urllib.request.urlopen(req2, timeout=15) as r:
        envs = json.loads(r.read())
    for e in envs:
        if e.get('envVar', {}).get('key') == 'VALKEY_URL':
            return e['envVar']['value']
    sys.exit('Render env 에서 VALKEY_URL 못 찾음')


def last_stats_for_date(target_date):
    """metrics/YYYY-MM-DD.json 의 KST 어제 day 안 마지막 snapshot 의 services.2048.stats."""
    fp = os.path.join(METRICS_DIR, f'{target_date}.json')
    if not os.path.exists(fp):
        return None, None
    with open(fp) as f:
        snaps = json.load(f)
    last_stats = None
    last_ts = None
    for s in snaps:
        ts = s.get('ts', '')
        if not ts: continue
        try:
            if parse_iso(ts).astimezone(KST).strftime('%Y-%m-%d') != target_date:
                continue
        except Exception:
            continue
        st = ((s.get('services') or {}).get('2048') or {}).get('stats')
        if st:
            last_stats = st
            last_ts = ts
    return last_stats, last_ts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='실제 HSET 실행')
    ap.add_argument('--prefix', default=os.environ.get('VALKEY_KEY_PREFIX', DEFAULT_PREFIX))
    ap.add_argument('--dates', default=','.join(TARGET_DATES))
    args = ap.parse_args()

    dates = args.dates.split(',')
    print(f'PREFIX: {args.prefix}')
    print(f'타겟 dates: {dates}')
    print(f'모드: {"APPLY" if args.apply else "DRY-RUN"}\n')

    try:
        import redis
    except ImportError:
        sys.exit('redis-py 필요: pip install redis')

    url = get_valkey_url()
    r = redis.from_url(url, decode_responses=True)
    r.ping()
    print(f'valkey connected.\n')

    for date in dates:
        st, source_ts = last_stats_for_date(date)
        key = f'{args.prefix}:daily:{date}'
        print(f'■ {date}')
        if not st:
            print(f'  metrics snapshot 에 stats 없음 — skip')
            continue
        print(f'  source: metrics/{date}.json (ts {source_ts})')
        existing = r.hgetall(key) if not args.apply else {}
        fields = {
            'total_users':  str(int(st.get('total_users')  or 0)),
            'top_all_time': str(int(st.get('top_all_time') or 0)),
            'top_daily':    str(int(st.get('top_daily')    or 0)),
        }
        for k, v in fields.items():
            old = existing.get(k, '<none>')
            mark = '=' if old == v else '→'
            print(f'    {k}: {old} {mark} {v}')
        if args.apply:
            r.hset(key, mapping=fields)
            print(f'  ✓ HSET {key}')


if __name__ == '__main__':
    main()
