#!/usr/bin/env python3
"""one-time cleanup — metrics/YYYY-MM-DD.json snapshot 에서 server-domain 카운터 필드 제거.

PR #168 (valkey-first monitoring) 이후 server-domain 데이터 (worker_timeout /
no_move / bot_retry / bot_skip 카운트 + rooms/clients 집합) 는 valkey 가 SoT.
이전 collect 가 snapshot 에 같이 적재한 옛 데이터는 더 이상 monitor 가 읽지 않음 —
저장만 차지하므로 정리.

사용:
  python3 scripts/cleanup_obsolete_snapshot_fields.py [--dry-run]

idempotent — 이미 정리된 snapshot 은 변동 X.
"""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path

# 제거 대상 — services.{omok,2048}.render.* 안의 server-domain 카운터.
OBSOLETE_FIELDS = {
    'worker_timeout_count', 'no_move_count',
    'bot_retry_count', 'bot_skip_count',
    'bot_retry_rooms', 'bot_retry_clients',
    'bot_skip_rooms', 'bot_skip_clients',
}


def cleanup_file(path: Path, dry_run: bool) -> tuple[int, int]:
    """파일 1개 처리. (snapshots 수, 제거된 필드 누적 수) 반환."""
    raw = path.read_text()
    snaps = json.loads(raw)
    if not isinstance(snaps, list):
        return (0, 0)
    removed = 0
    changed = False
    for s in snaps:
        services = s.get('services', {})
        for svc in ('omok', '2048'):
            render = services.get(svc, {}).get('render', {})
            for f in list(render.keys()):
                if f in OBSOLETE_FIELDS:
                    del render[f]
                    removed += 1
                    changed = True
    if changed and not dry_run:
        path.write_text(json.dumps(snaps, indent=2, ensure_ascii=False))
    return (len(snaps), removed)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--metrics-dir', default='metrics')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()
    metrics = Path(args.metrics_dir)
    if not metrics.exists():
        print(f'경로 없음: {metrics}')
        sys.exit(1)
    files = sorted(p for p in metrics.glob('*.json') if 'state' not in p.name and 'daily-stats' not in p.name)
    total_snaps = 0
    total_removed = 0
    for p in files:
        try:
            n_snaps, n_removed = cleanup_file(p, args.dry_run)
        except Exception as e:
            print(f'  {p}: ERR {e}')
            continue
        prefix = '[DRY] ' if args.dry_run else ''
        print(f'  {prefix}{p}: {n_snaps} snapshots, removed {n_removed} obsolete fields')
        total_snaps += n_snaps
        total_removed += n_removed
    print(f'\nTotal: {total_snaps} snapshots, {total_removed} obsolete fields removed across {len(files)} files')


if __name__ == '__main__':
    main()
