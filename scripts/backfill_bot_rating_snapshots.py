#!/usr/bin/env python3
"""
One-time backfill: 과거 daily Hash 에 봇 rating snapshot 채우기.

전제:
- PR (feat/daily-summary-frozen-snapshots) 로 server statsHandler 가 매 /api/stats
  호출 시 daily Hash 에 bot_{diff}_rating/wins/losses/draws 적재 시작.
- 그 전 day 들 (5/22-24) 은 daily Hash 에 봇 rating snapshot 없음 → monitor 가
  24h log fallback 사용 (작동은 함). 일관성 위해 metrics/{date}.json 의 last
  snapshot 에 저장된 봇 rating 으로 backfill.

source 우선:
1. metrics/YYYY-MM-DD.json 의 KST 어제 day last snapshot 의 services.omok.stats.bots
2. (위 없으면) 같은 day 의 daily-games endpoint 마지막 봇 game 의 봇 rating

target valkey key: omok:prod:daily:YYYY-MM-DD
fields: bot_easy_rating, bot_easy_wins, bot_easy_losses, bot_easy_draws (각 difficulty)

사용:
    source ~/.zshenv && use-sehee
    python3 scripts/backfill_bot_rating_snapshots.py            # dry-run
    python3 scripts/backfill_bot_rating_snapshots.py --apply    # 실제 HSET
"""
import argparse
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone, timedelta

from monitor_config import RENDER_API_KEY  # 단일 소스(targets.json)

KST = timezone(timedelta(hours=9))
DEFAULT_PREFIX = 'omok:prod'
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
    svc_id = next(s['service']['id'] for s in svcs if s['service']['name'] == 'omok-server')
    req2 = urllib.request.Request(
        f'https://api.render.com/v1/services/{svc_id}/env-vars', headers=headers,
    )
    with urllib.request.urlopen(req2, timeout=15) as r:
        envs = json.loads(r.read())
    for e in envs:
        if e.get('envVar', {}).get('key') == 'VALKEY_URL':
            return e['envVar']['value']
    sys.exit('Render env 에서 VALKEY_URL 못 찾음')


def last_bots_for_date(target_date):
    """metrics/YYYY-MM-DD.json 의 KST 어제 day 안 마지막 snapshot 의 services.omok.stats.bots 반환.
    파일은 KST date 기준이지만 snapshot ts 는 UTC — 따라서 같은 날 파일 안에서도 KST 다른 날 snapshot 이 섞일 수 있음 (수집 시점 KST boundary). 정확한 매칭 위해 ts 의 KST date 확인."""
    fp = os.path.join(METRICS_DIR, f'{target_date}.json')
    if not os.path.exists(fp):
        return None, None
    with open(fp) as f:
        snaps = json.load(f)
    last_bots = None
    last_ts = None
    for s in snaps:
        ts = s.get('ts', '')
        if not ts: continue
        try:
            if parse_iso(ts).astimezone(KST).strftime('%Y-%m-%d') != target_date:
                continue
        except Exception:
            continue
        bots = ((s.get('services') or {}).get('omok') or {}).get('stats', {}).get('bots')
        if bots:
            last_bots = bots
            last_ts = ts
    return last_bots, last_ts


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
        bots, source_ts = last_bots_for_date(date)
        key = f'{args.prefix}:daily:{date}'
        print(f'■ {date}')
        if not bots:
            print(f'  metrics snapshot 에 봇 정보 없음 — skip')
            continue
        print(f'  source: metrics/{date}.json (ts {source_ts})')
        existing = r.hgetall(key) if not args.apply else {}
        fields = {}
        for diff, b in bots.items():
            fields[f'bot_{diff}_rating'] = str(int(b.get('rating') or 0))
            fields[f'bot_{diff}_wins']   = str(int(b.get('wins')   or 0))
            fields[f'bot_{diff}_losses'] = str(int(b.get('losses') or 0))
            fields[f'bot_{diff}_draws']  = str(int(b.get('draws')  or 0))
        for k, v in sorted(fields.items()):
            old = existing.get(k, '<none>')
            mark = '=' if old == v else '→'
            print(f'    {k}: {old} {mark} {v}')
        if args.apply:
            r.hset(key, mapping=fields)
            print(f'  ✓ HSET {key}')


if __name__ == '__main__':
    main()
