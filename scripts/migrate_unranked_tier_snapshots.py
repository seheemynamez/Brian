#!/usr/bin/env python3
"""
One-time migration: backfill 5/22-25 daily Hash snapshots with the new
`tier_Unranked` field (PR #187 — unranked feature).

전제:
- 새 코드 deploy 완료 → /api/stats 가 8 tier (Iron…Master + Unranked) 응답
- 과거 5/22-24 daily snapshot 은 구 7 tier 만 (Unranked 없음)
- "오늘 기준 재snapshot" 정책: 현재 user state 의 tier 분포를
  5/22-25 모두에 덮어쓰기 (trend 표 일관성 확보)
- 5/21 은 total/tier 둘 다 없음 → 건너뜀

실행:
    source ~/.zshenv && use-sehee
    python3 scripts/migrate_unranked_tier_snapshots.py            # dry-run
    python3 scripts/migrate_unranked_tier_snapshots.py --apply    # 실제 HSET

사용 env:
- VALKEY_URL: Render env 와 동일 (rediss://...)
- VALKEY_KEY_PREFIX: 기본 `omok:prod`
- OMOK_API_BASE: 기본 production URL
"""
import argparse
import os
import sys
import urllib.parse
import urllib.request
import json

from monitor_config import SERVER_PUBLIC_URL as DEFAULT_API_BASE, RENDER_API_KEY  # 단일 소스(targets.json)
DEFAULT_PREFIX = 'omok:prod'
TARGET_DATES = ['2026-05-22', '2026-05-23', '2026-05-24', '2026-05-25']


def fetch_stats(api_base):
    with urllib.request.urlopen(f'{api_base}/api/stats', timeout=15) as r:
        return json.loads(r.read())


def get_valkey_url():
    url = os.environ.get('VALKEY_URL', '').strip()
    if url:
        return url
    # 없으면 Render env 에서 가져오기 (use-sehee 가 RENDER_API_KEY 설정 가정).
    api_key = RENDER_API_KEY
    if not api_key:
        sys.exit('VALKEY_URL 또는 RENDER_API_KEY 환경변수 필요')
    # omok-server 의 env-vars 에서 가져옴
    headers = {'Authorization': f'Bearer {api_key}'}
    req = urllib.request.Request(
        'https://api.render.com/v1/services?limit=20',
        headers=headers,
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        svcs = json.loads(r.read())
    svc_id = next(s['service']['id'] for s in svcs if s['service']['name'] == 'omok-server')
    req2 = urllib.request.Request(
        f'https://api.render.com/v1/services/{svc_id}/env-vars',
        headers=headers,
    )
    with urllib.request.urlopen(req2, timeout=15) as r:
        envs = json.loads(r.read())
    for e in envs:
        v = e.get('envVar', {})
        if v.get('key') == 'VALKEY_URL':
            return v.get('value', '')
    sys.exit('Render env 에서 VALKEY_URL 못 찾음')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='실제 HSET 실행 (없으면 dry-run)')
    ap.add_argument('--api-base', default=DEFAULT_API_BASE)
    ap.add_argument('--prefix', default=os.environ.get('VALKEY_KEY_PREFIX', DEFAULT_PREFIX))
    args = ap.parse_args()

    print(f'API: {args.api_base}')
    print(f'PREFIX: {args.prefix}')
    print(f'타겟 dates: {TARGET_DATES}')
    print(f'모드: {"APPLY (HSET 실행)" if args.apply else "DRY-RUN"}')
    print()

    # 1. 현재 /api/stats 응답 — Unranked 포함 8 tier 가 와야 함
    stats = fetch_stats(args.api_base)
    tiers = stats.get('tiers') or {}
    total = stats.get('total_human_users', 0)
    print(f'현재 stats: total_human_users={total}')
    print(f'  tiers: {tiers}')
    if 'Unranked' not in tiers:
        sys.exit('  ⚠ tier_Unranked 누락 — PR #187 deploy 가 아직 안 됐을 수 있음')
    print()

    # 2. valkey 연결
    valkey_url = get_valkey_url()
    parsed = urllib.parse.urlparse(valkey_url)
    print(f'valkey: {parsed.hostname}:{parsed.port}')

    try:
        import redis  # type: ignore
    except ImportError:
        sys.exit('redis-py 필요: pip install redis')

    r = redis.from_url(valkey_url, decode_responses=True)
    r.ping()
    print('  연결 OK')
    print()

    # 3. 각 date 별로 HSET (snapshot)
    fields_to_set = {'total_human_users': str(total)}
    for tier_name, count in tiers.items():
        fields_to_set[f'tier_{tier_name}'] = str(count)

    print(f'각 date 에 set 할 fields: {len(fields_to_set)} 개')
    for k, v in sorted(fields_to_set.items()):
        print(f'  {k} = {v}')
    print()

    for date in TARGET_DATES:
        key = f'{args.prefix}:daily:{date}'
        if args.apply:
            existing_before = r.hgetall(key)
            r.hset(key, mapping=fields_to_set)
            existing_after = r.hgetall(key)
            print(f'✓ HSET {key}')
            # 변경된 필드만 표시
            changed = {}
            for k, v in fields_to_set.items():
                old = existing_before.get(k, '<none>')
                if old != v:
                    changed[k] = f'{old} → {v}'
            if changed:
                for k, v in sorted(changed.items()):
                    print(f'    {k}: {v}')
            else:
                print('    (변경 없음 — 모두 이미 동일 값)')
        else:
            existing = r.hgetall(key)
            print(f'[DRY] {key}')
            for k, v in sorted(fields_to_set.items()):
                old = existing.get(k, '<none>')
                marker = '=' if old == v else '→'
                print(f'    {k}: {old} {marker} {v}')

    if not args.apply:
        print()
        print('dry-run 종료. --apply 로 실제 실행.')


if __name__ == '__main__':
    main()
