#!/usr/bin/env python3
"""인프라 메트릭 수집 + 임계 검사 + GitHub Issue 알림.

두 가지 모드:
  MODE=collect (default) — 매 5분 cron (외부 cron-job.org → workflow_dispatch).
                          메트릭 수집 + 임계 검사 + alert Issue 생성.
  MODE=daily-summary    — 매일 09:00 KST (00:00 UTC) cron. 24h+7d 요약 Issue 생성,
                          이전 daily-summary Issue 자동 close.

Label 체계 (2차원):
  공통: monitor
  종류: daily-summary | alert-render | alert-aiven | alert-bot | alert-deploy
  심각도: severity-low | severity-high | severity-critical

저장:
  metrics/YYYY-MM-DD.json  — 일별 snapshot 시계열 (collect 모드)
  metrics/state.json        — cooldown 추적
  metrics/daily-stats.json  — 7일 trend 누적 (daily-summary 모드)

모듈 구조:
  monitor.py          — entry point (이 파일)
  monitor_config.py   — env / 한도 / 임계 / 상수
  monitor_apis.py     — Render / Aiven / GitHub / 자체 server 외부 API
  monitor_data.py     — 로그/이벤트 파서 + 통계 + state IO + helpers
  monitor_collect.py  — collect mode (run_collect)
  monitor_summary.py  — daily-summary mode (run_daily_summary + charts)
"""
from __future__ import annotations
import sys

from monitor_config import AIVEN_API_TOKEN, DRY_RUN, MODE, RENDER_API_KEY


def main():
    if not RENDER_API_KEY:
        print('ERROR: RENDER_API_KEY 필요', file=sys.stderr); sys.exit(1)
    if not AIVEN_API_TOKEN:
        print('ERROR: AIVEN_API_TOKEN 필요', file=sys.stderr); sys.exit(1)

    print(f'=== monitor MODE={MODE} (DRY_RUN={DRY_RUN}) ===')

    if MODE == 'collect':
        # lazy import — collect 가 import 무거우니 mode 분기 후에만 로드.
        from monitor_collect import run_collect
        run_collect()
    elif MODE == 'daily-summary':
        from monitor_summary import run_daily_summary
        run_daily_summary()
    else:
        print(f'ERROR: unknown MODE={MODE}', file=sys.stderr); sys.exit(1)


if __name__ == '__main__':
    main()
