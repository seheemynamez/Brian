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


def backfill(daily_stats_path: Path, valkey_url: str, prefix: str, dry_run: bool = False,
             ttl_sec: int = 90 * 86400, lookback_days: int = 90):
    data = json.loads(daily_stats_path.read_text())
    today = date.today()
    cutoff = today - timedelta(days=lookback_days)

    # 어떤 카운터 필드를 valkey Hash 에 옮길지 — server 의 endpoint 응답 schema 와 일치.
    # active_users 는 카운트만 옮기되 SET 멤버는 없음 → 별도 처리 (active_users_count Hash field 로 임시 보관).
    # 실제 server endpoint 가 SET SCARD 를 응답하므로 backfill 데이터는 'active_users' 카운터로 따로
    # 적재해 monitor 가 backfill 시점 데이터로 인지하게 함 (server 가 SCARD=0 이면 이 값 사용).
    COUNTER_FIELDS = (
        'pvp_games', 'bot_games', 'total_bot_moves',
        'worker_timeout_count', 'no_move_count', 'bot_retry_count', 'bot_skip_count',
        'bot_retry_rooms', 'bot_retry_clients', 'bot_skip_rooms', 'bot_skip_clients',
        'heartbeat_terminate_count',
        # active_users 는 daily-stats.json 키. valkey field 는 'active_users' (endpoint 응답에 맞춤).
    )
    # daily-stats.json 키 → valkey Hash field 매핑.
    FIELD_MAP = {
        'pvp_games': 'pvp_games',
        'bot_games': 'bot_games',
        'total_bot_moves': 'total_bot_moves',
        'worker_timeout_count': 'worker_timeout',
        'no_move_count': 'no_move',
        'bot_retry_count': 'bot_retry',
        'bot_skip_count': 'bot_skip',
        'bot_retry_rooms': 'bot_retry_rooms_backfill',     # SET 없으므로 backfill counter
        'bot_retry_clients': 'bot_retry_clients_backfill',
        'bot_skip_rooms': 'bot_skip_rooms_backfill',
        'bot_skip_clients': 'bot_skip_clients_backfill',
        'heartbeat_terminate_count': 'heartbeat_terminate',
        'active_users': 'active_users_backfill',           # endpoint 는 SCARD 우선, 빈 SET 이면 이 값
    }

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
        for src_field in ('pvp_games', 'bot_games', 'total_bot_moves',
                          'worker_timeout_count', 'no_move_count',
                          'bot_retry_count', 'bot_skip_count',
                          'bot_retry_rooms', 'bot_retry_clients',
                          'bot_skip_rooms', 'bot_skip_clients',
                          'heartbeat_terminate_count', 'active_users'):
            v = fields.get(src_field)
            if v is None: continue
            try:
                write[FIELD_MAP[src_field]] = int(v)
            except (TypeError, ValueError):
                continue
        if not write:
            summary['dates_skipped'] += 1
            continue
        msg = f'  {valkey_key} ← {len(write)} fields: {write}'
        if dry_run:
            print(f'[DRY] {msg}')
        else:
            r.hset(valkey_key, mapping=write)
            r.expire(valkey_key, ttl_sec)
            print(msg)
        summary['dates_written'] += 1
    print(f'\nDone: {summary}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--daily-stats', default='metrics/daily-stats.json')
    ap.add_argument('--prefix', default=os.environ.get('VALKEY_KEY_PREFIX', 'omok'))
    ap.add_argument('--url', default=os.environ.get('VALKEY_URL'))
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
    backfill(path, args.url or '', args.prefix, dry_run=args.dry_run,
             ttl_sec=args.ttl_sec, lookback_days=args.lookback_days)


if __name__ == '__main__':
    main()
