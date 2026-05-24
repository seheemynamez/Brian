#!/usr/bin/env python3
"""metrics/*.json 의 옛 평탄 snapshot → 새 services 구조 일괄 변환.

배경:
  옛 snapshot 은 `render: {...omok...}` 평탄 구조 + `aiven: {...}` 만 있었음.
  2026-05-23 쯤 `services: {omok: {render, stats}, 2048: {render, stats}}`
  구조로 전환. 호환 위해 `snap_omok_render` 등 helper 가 두 구조 모두 처리해
  왔는데 그 fallback 분기 제거를 위해 옛 snapshot 을 새 구조로 변환.

변환 규칙 (사용자 결정: "비어있는 값은 비워둬도 좋아"):
  옛:
    { "ts": ..., "render": {...}, "aiven": {...} }
  새:
    {
      "ts": ...,
      "services": {
        "omok": { "render": <옛 render 그대로>, "stats": {} },
        "2048": { "render": {}, "stats": {} }
      },
      "aiven": <옛 aiven 그대로>
    }

이미 새 구조인 snapshot 은 건드리지 않음.

사용:
  python3 scripts/migrate_metrics_format.py            # dry-run
  python3 scripts/migrate_metrics_format.py --apply    # 실제 변경
"""
from __future__ import annotations
import json
import re
import sys
from pathlib import Path

METRICS_DIR = Path(__file__).resolve().parent.parent / 'metrics'
DATE_FILE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}\.json$')


def upgrade(snap):
    """옛 평탄 snapshot → 새 services 구조. 이미 새 구조면 그대로 반환."""
    if 'services' in snap:
        return snap, False   # 변환 불필요
    new_snap = {
        'ts': snap.get('ts', ''),
        'services': {
            'omok': {
                'render': snap.get('render', {}) or {},
                'stats': {},
            },
            '2048': {
                'render': {},
                'stats': {},
            },
        },
        'aiven': snap.get('aiven', {}) or {},
    }
    return new_snap, True


def main():
    apply = '--apply' in sys.argv
    if not METRICS_DIR.exists():
        print(f'no metrics/ dir at {METRICS_DIR}')
        sys.exit(0)

    total_files = 0
    total_converted = 0
    for f in sorted(METRICS_DIR.iterdir()):
        if not DATE_FILE_RE.match(f.name):
            continue
        try:
            snaps = json.loads(f.read_text())
        except Exception as e:
            print(f'  skip {f.name}: parse fail ({e})')
            continue
        if not isinstance(snaps, list):
            continue
        total_files += 1
        new_snaps = []
        converted = 0
        for s in snaps:
            new_s, did = upgrade(s)
            new_snaps.append(new_s)
            if did:
                converted += 1
        total_converted += converted
        if converted == 0:
            print(f'  {f.name}: all {len(snaps)} already new — skip')
            continue
        if apply:
            f.write_text(json.dumps(new_snaps, indent=2, ensure_ascii=False))
            print(f'  {f.name}: converted {converted}/{len(snaps)} → wrote')
        else:
            print(f'  [dry] {f.name}: would convert {converted}/{len(snaps)}')

    print(f'\n총 {total_files} files, {total_converted} snapshots 변환' +
          ('' if apply else ' (dry — --apply 필요)'))


if __name__ == '__main__':
    main()
