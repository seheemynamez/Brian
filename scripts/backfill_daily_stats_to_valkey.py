#!/usr/bin/env python3
"""one-time backfill — metrics/daily-stats.json 의 최근 90일 aggregate counter 를
   valkey 의 daily Hash 로 push.

목적:
- "valkey-first monitoring" 전환 후 7d trend 가 backfill 없이 0/"-" 로 표시되는 것 방지.
- 옛 (PR-1~PR-4 기간) daily-stats.json 에 누적된 카운트 (pvp_games / bot_games /
  total_bot_moves / active_users 등) 를 valkey 의 `{PREFIX}:daily:{date}` Hash 에 HSET.
- LIST (raw games / bot_moves) / SET (active_users 멤버) / online series 는 backfill 안 함
  (raw 데이터 없음). count 만 옮김.

사용:
  VALKEY_URL=redis://... VALKEY_KEY_PREFIX=omok:prod \\
      python3 scripts/backfill_daily_stats_to_valkey.py [--dry-run]

  service=omok 가 default. 2048 도 채울 거면 PREFIX 만 다르게 두 번 실행.

후속:
- backfill 검증 후 monitor 의 log-fetch 폴백 제거 + metrics/daily-stats.json git rm.
- 이 script 도 commit 에 포함 (재실행 가능, idempotent — HSET 으로 덮어쓰기).
"""
from __future__ import annotations
import argparse
import json
import os
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

try:
    import redis  # type: ignore
except ImportError:
    print('redis-py 필요: pip install redis')
    sys.exit(1)


# daily-stats.json 키 → valkey Hash field 매핑. service 별 다름.
# - 'backfill' 접미사 필드 (active_users_backfill / bot_retry_rooms_backfill 등) 는
#   원본이 SET (SCARD) 이고 monitor endpoint 는 SCARD 우선 응답.
#   backfill 시점엔 SET 멤버 없으므로 별도 카운터 필드로 임시 적재.
#   monitor 의 endpoint 응답은 SET 이 우선이라 backfill 값은 fallback 으로만 활용.
FIELD_MAP_OMOK = {
    'pvp_games': 'pvp_games',
    'bot_games': 'bot_games',
    'total_bot_moves': 'total_bot_moves',
    'worker_timeout_count': 'worker_timeout',
    'no_move_count': 'no_move',
    'bot_retry_count': 'bot_retry',
    'bot_skip_count': 'bot_skip',
    'bot_retry_rooms': 'bot_retry_rooms_backfill',
    'bot_retry_clients': 'bot_retry_clients_backfill',
    'bot_skip_rooms': 'bot_skip_rooms_backfill',
    'bot_skip_clients': 'bot_skip_clients_backfill',
    'heartbeat_terminate_count': 'heartbeat_terminate',
    'active_users': 'active_users_backfill',
    'ws_connected': 'ws_connected',
}
# 2048 의 daily-stats.json 필드는 `_2048` 접미사. valkey 의 endpoint 필드는 접미사 X.
FIELD_MAP_2048 = {
    'daily_submits_2048': 'submit_score',
    'new_users_2048': 'user_created',
    'active_users_2048': 'active_users_backfill',
    # score_best / ws_connected / heartbeat_terminate 는 daily-stats.json 에 미수집 → 0 으로 시작.
}


def backfill(daily_stats_path: Path, valkey_url: str, prefix: str,
             service: str, dry_run: bool = False,
             ttl_sec: int = 90 * 86400, lookback_days: int = 90):
    """service: 'omok' 또는 '2048'. FIELD_MAP 다르게 적용."""
    data = json.loads(daily_stats_path.read_text())
    today = date.today()
    cutoff = today - timedelta(days=lookback_days)

    if service == 'omok':
        field_map = FIELD_MAP_OMOK
    elif service == '2048':
        field_map = FIELD_MAP_2048
    else:
        raise ValueError(f'service must be omok or 2048: {service}')

    r = None if dry_run else redis.from_url(valkey_url)
    summary = {'dates_seen': 0, 'dates_skipped': 0, 'dates_written': 0}

    for d_key, fields in sorted(data.items()):
        summary['dates_seen'] += 1
        try:
            d = datetime.strptime(d_key, '%Y-%m-%d').date()
        except ValueError:
            print(f'  skip invalid date key: {d_key}')
            summary['dates_skipped'] += 1
            continue
        if d < cutoff or d > today:
            summary['dates_skipped'] += 1
            continue
        valkey_key = f'{prefix}:daily:{d_key}'
        write = {}
        for src_field, dst_field in field_map.items():
            v = fields.get(src_field)
            if v is None: continue
            try:
                write[dst_field] = int(v)
            except (TypeError, ValueError):
                continue
        if not write:
            summary['dates_skipped'] += 1
            continue
        msg = f'  {valkey_key} ← {len(write)} fields ({service}): {write}'
        if dry_run:
            print(f'[DRY] {msg}')
        else:
            r.hset(valkey_key, mapping=write)
            r.expire(valkey_key, ttl_sec)
            print(msg)
        summary['dates_written'] += 1
    print(f'\nDone ({service}): {summary}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--daily-stats', default='metrics/daily-stats.json')
    ap.add_argument('--prefix', default=os.environ.get('VALKEY_KEY_PREFIX', 'omok'))
    ap.add_argument('--url', default=os.environ.get('VALKEY_URL'))
    ap.add_argument('--service', choices=['omok', '2048'], default='omok',
                    help='어느 service 의 필드 매핑 적용할지 (omok / 2048 다름)')
    ap.add_argument('--ttl-sec', type=int, default=90 * 86400)
    ap.add_argument('--lookback-days', type=int, default=90)
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()
    if not args.dry_run and not args.url:
        print('VALKEY_URL 환경변수 필요 (또는 --url, --dry-run)')
        sys.exit(1)
    path = Path(args.daily_stats)
    if not path.exists():
        print(f'파일 없음: {path}')
        sys.exit(1)
    backfill(path, args.url or '', args.prefix, args.service,
             dry_run=args.dry_run,
             ttl_sec=args.ttl_sec, lookback_days=args.lookback_days)


if __name__ == '__main__':
    main()
