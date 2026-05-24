#!/usr/bin/env python3
"""metrics/*.json 의 옛 UTC date 기준 파일들을 KST date 기준으로 재분류.

배경:
  monitor_collect.py 가 옛엔 `daily_file = METRICS_DIR / f'{TODAY}.json'`
  (TODAY = UTC date) 로 저장. 즉 `metrics/2026-05-24.json` 안에 들어있는
  snapshot 의 KST 시각은 `KST 2026-05-24 09:00 ~ KST 2026-05-25 09:00` 로
  파일명과 9시간 어긋난 상태.

이 스크립트는 일회성. 한 번 실행 후 commit:
  1. 모든 옛 *.json 의 snapshot 을 ts 기준 KST day 별로 모음
  2. 새 KST date 파일 작성 (timestamp 순 정렬)
  3. 옛 파일 중 새 파일과 같은 이름이 아닌 것 삭제
  4. state.json / daily-stats.json 은 그대로 유지 (이미 KST 정책 또는 timezone-
     independent — daily-stats 의 key 는 이미 KST date, state 의 last_alert ts 는
     UTC ISO 그대로 cooldown 계산에만 사용)

사용:
  cd ~/Development/Personal/Brian
  python3 scripts/migrate_metrics_to_kst.py            # dry-run (변경 print 만)
  python3 scripts/migrate_metrics_to_kst.py --apply    # 실제 변경
"""
from __future__ import annotations
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

KST = timezone(timedelta(hours=9))
METRICS_DIR = Path(__file__).resolve().parent.parent / 'metrics'
DATE_FILE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}\.json$')

# monitor_data.parse_iso 와 동일 — ns precision 잘라냄.
_TS_TRUNC_RE = re.compile(r'(\.\d{6})\d+')


def parse_iso(ts):
    s = ts.replace('Z', '+00:00')
    s = _TS_TRUNC_RE.sub(r'\1', s)
    return datetime.fromisoformat(s)


def main():
    apply = '--apply' in sys.argv
    if not METRICS_DIR.exists():
        print(f'no metrics/ dir at {METRICS_DIR}')
        sys.exit(0)

    # 1. 옛 *.json 모두 읽고 snapshot 을 KST day 로 모음
    by_kst_day = defaultdict(list)
    src_files = []
    for f in sorted(METRICS_DIR.iterdir()):
        if not DATE_FILE_RE.match(f.name):
            continue
        try:
            snaps = json.loads(f.read_text())
        except Exception as e:
            print(f'  skip {f.name}: parse fail ({e})')
            continue
        if not isinstance(snaps, list):
            print(f'  skip {f.name}: not a list')
            continue
        src_files.append(f)
        for s in snaps:
            ts = s.get('ts', '')
            if not ts:
                print(f'  skip 1 snapshot in {f.name}: ts 비어있음')
                continue
            try:
                kst_d = parse_iso(ts).astimezone(KST).strftime('%Y-%m-%d')
            except Exception as e:
                print(f'  skip 1 snapshot in {f.name}: parse 실패 ({e}) ts={ts}')
                continue
            by_kst_day[kst_d].append(s)

    if not src_files:
        print('no source files — nothing to migrate')
        sys.exit(0)

    # 2. 재분류 결과 요약
    print(f'\n=== 재분류 결과 (src {len(src_files)} files → {len(by_kst_day)} KST days) ===')
    for src in src_files:
        print(f'  src: {src.name}')
    for kst_d in sorted(by_kst_day):
        print(f'  → {kst_d}.json: {len(by_kst_day[kst_d])} snapshots')

    # 3. 새 KST 파일 작성 (timestamp 순 정렬)
    target_files = set()
    for kst_d, snaps in by_kst_day.items():
        snaps.sort(key=lambda s: s.get('ts', ''))
        out = METRICS_DIR / f'{kst_d}.json'
        target_files.add(out)
        if apply:
            out.write_text(json.dumps(snaps, indent=2, ensure_ascii=False))
            print(f'  wrote {out.name}: {len(snaps)} snapshots')
        else:
            print(f'  [dry] would write {out.name}: {len(snaps)} snapshots')

    # 4. 옛 파일 중 target 과 이름 안 겹치는 것 삭제
    for f in src_files:
        if f in target_files:
            continue
        if apply:
            f.unlink()
            print(f'  deleted {f.name}')
        else:
            print(f'  [dry] would delete {f.name}')

    if not apply:
        print('\n(dry run — actual changes require --apply)')


if __name__ == '__main__':
    main()
