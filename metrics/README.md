# Infra Metrics

매 30분 `.github/workflows/monitor-infra.yml` 가 자동 수집 + commit.

## 파일

- `YYYY-MM-DD.json` — 일별 시계열 (해당 일에 수집된 모든 snapshot 누적)
- `state.json` — cooldown 상태 (마지막 알림 시각, 같은 알림 6시간 1회 제한)

## snapshot 구조

```json
{
  "ts": "2026-05-21T03:30:00Z",
  "render": {
    "cpu_peak_m": 12.5,
    "mem_peak_mb": 130.2,
    "deploy_status": "live",
    "worker_timeout_count": 0,
    "no_move_count": 0
  },
  "aiven": {
    "cpu_pct_avg": 7.00,
    "cpu_pct_max": 8.83,
    "mem_pct_avg": 64.76,
    "mem_pct_max": 68.69,
    "disk_pct_max": 0.04
  }
}
```

## 임계 (현 정책)

- Render CPU peak ≥ 90m (한도 100m)
- Aiven Memory ≥ 80% (한도 1024MB, noeviction)
- worker_timeout 발생 1건+
- search returned no move 1건+
- Render 배포 비정상 (deploy_status not in [live, *_in_progress])

임계 도달 시 GitHub Issue 자동 생성 (label: `monitor`, severity).
같은 알림 종류 6시간 cooldown.

## 수동 실행

```sh
# 로컬에서 dry-run (Issue 안 만들고 출력만)
cd ~/Development/Personal/Brian
source ~/.zshrc && use-sehee
GITHUB_REPOSITORY=seheemynamez/Brian SAVE_METRICS=0 python3 scripts/monitor.py
```
