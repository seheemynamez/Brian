# Infra Metrics

`.github/workflows/monitor-infra.yml` 가 외부 cron (cron-job.org) 의 `workflow_dispatch` 호출로 자동 수집·commit 합니다.

- **매 5분** — collect 모드: snapshot 저장 + 임계 검사 + 필요 시 alert Issue.
- **매일 KST 09:00 (UTC 00:00)** — daily-summary 모드: 24h + 7d 요약 Issue 발행, 이전 daily-summary close.

GitHub Actions 내장 `schedule` 은 best-effort 라 peak 시 수십분~수시간 skip 발생. 외부 ping 으로 ~99%+ 신뢰도 확보. setup: [`docs/MONITOR_RELIABILITY.md`](../docs/MONITOR_RELIABILITY.md).

## 파일

- `YYYY-MM-DD.json` — 일별 시계열 (해당 일에 collect 가 누적한 snapshot 배열)
- `state.json` — alert cooldown 상태 (마지막 알림 시각, 같은 알림 종류 6시간 1회 제한)
- `daily-stats.json` — daily-summary 가 사용하는 일별 통계 누적 (30일치 보존). 필드: `pvp_games`, `bot_games`, `total_bot_moves`, `render_cpu_max_m`, `aiven_mem_max_pct`, `active_users` (24h game_over 의 unique 사람 닉네임 수), `total_human_users` (그 날 발행 시 server `/api/stats` 응답).

## snapshot 구조 (collect 모드)

```json
{
  "ts": "2026-05-21T03:30:00+00:00",
  "render": {
    "cpu_peak_m": 105.4,
    "cpu_avg_m": 49.8,
    "mem_peak_mb": 102.5,
    "deploy_status": "live",
    "worker_timeout_count": 0,
    "no_move_count": 0,
    "bot_retry_count": 0,
    "bot_skip_count": 0,
    "server_failed_count": 0,
    "server_oom_count": 0,
    "server_crash_count": 0
  },
  "aiven": {
    "cpu_pct_avg": 7.0,
    "cpu_pct_max": 8.83,
    "mem_pct_avg": 64.76,
    "mem_pct_max": 68.69
  }
}
```

(Aiven disk % 는 collect snapshot 엔 안 들어가고 daily-summary 본문 표에만 표시됨.)

## 임계 (현 정책)

- Render CPU peak ≥ 90m (한도 100m)
- Aiven Memory ≥ 80% (한도 1024MB, noeviction)
- `worker_timeout` 발생 1건 이상
- `search returned no move` 발생 1건 이상
- `server_failed` 발생 1건 이상 (OOM / crash)
- Render 배포 비정상 (`deploy_status` ∉ {`live`, `*_in_progress`})

임계 도달 시 GitHub Issue 자동 생성 (label: `monitor`, severity). 같은 alert key 는 6시간 cooldown.

## 수동 실행

```sh
# 로컬에서 dry-run (Issue 안 만들고 stdout 만 출력)
cd ~/Development/Personal/Brian
source ~/.zshrc && use-sehee
GITHUB_REPOSITORY=seheemynamez/Brian SAVE_METRICS=0 python3 scripts/monitor.py
```

GitHub Actions 에서는 [Actions UI](https://github.com/seheemynamez/Brian/actions/workflows/monitor-infra.yml) 의 `Run workflow` 로 `collect` / `daily-summary` 직접 호출 가능.
