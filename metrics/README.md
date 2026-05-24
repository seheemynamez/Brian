# Infra Metrics

`.github/workflows/monitor-infra.yml` 가 외부 cron (cron-job.org) 의 `workflow_dispatch` 호출로 자동 수집·commit 합니다.

- **매 5분** — collect 모드: snapshot 저장 + 임계 검사 + 필요 시 alert Issue.
- **매일 KST 09:00 (UTC 00:00)** — daily-summary 모드: 24h + 7d 요약 Issue 발행, 이전 daily-summary close.

GitHub Actions 내장 `schedule` 은 best-effort 라 peak 시 수십분~수시간 skip 발생. 외부 ping 으로 ~99%+ 신뢰도 확보. setup: [`docs/MONITOR_RELIABILITY.md`](../docs/MONITOR_RELIABILITY.md).

## Timezone 정책

| 위치 | 기준 | 비고 |
|---|---|---|
| 파일명 `YYYY-MM-DD.json` | **KST date** | 각 파일은 그 KST day 00:00 ~ 익일 00:00 snapshot |
| snapshot 내부 `ts` | UTC ISO | 외부 API (Render/Aiven) 응답과 호환 — 가공/비교 비용 ↓ |
| `daily-stats.json` key | KST date | summary_date 와 일치 |
| `state.json` `last_alert` ts | UTC ISO | cooldown 계산 (절대 시간) 만 사용, 사람 표시 X |
| alert / daily-summary 본문 시각 | KST 표기 + UTC 병기 | `2026-05-24 09:05:14 KST (00:05:14Z)` |
| 모든 day 단위 집계 | KST | 7일 trend / 시간대별 bucket / window |
| Render/Aiven API 호출 | UTC ISO (`...Z`) | `to_utc_iso(kst_dt)` helper 로 변환 |

호출자가 KST 일관 사용 가정 가능. parser (`parse_bot_logs`, `parse_game_over`, `compute_recovery_times` 등) 의 ts 결과는 모두 KST ISO 로 normalize.

## 파일

- `YYYY-MM-DD.json` — **KST 캘린더 day** 별 시계열 (KST 00:00 ~ 익일 00:00). snapshot 내부 `ts` 는 UTC ISO.
- `state.json` — alert cooldown 상태 (같은 알림 종류 2시간 1회 제한). `last_alert` ts 는 UTC ISO.
- `daily-stats.json` — daily-summary 가 사용하는 일별 통계 누적 (30일치 보존). key = KST date. 필드: `pvp_games`, `bot_games`, `total_bot_moves`, `render_cpu_max_m`, `aiven_mem_max_pct`, `active_users` (24h game_over 의 unique 사람 닉네임 수), `total_human_users` (그 날 발행 시 server `/api/stats` 응답).

## snapshot 구조 (collect 모드)

PR — 2048 통합으로 service 별 분리:

```json
{
  "ts": "2026-05-21T03:30:00+00:00",
  "services": {
    "omok": {
      "render": {
        "cpu_peak_m": 105.4, "cpu_avg_m": 49.8, "mem_peak_mb": 102.5,
        "deploy_status": "live",
        "server_failed_count": 0, "server_oom_count": 0, "server_crash_count": 0,
        "downtime_count": 0, "downtime_max_s": null, "slow_recovery_count": 0,
        "worker_timeout_count": 0, "no_move_count": 0,
        "bot_retry_count": 0, "bot_skip_count": 0,
        "bot_retry_rooms": 0, "bot_retry_clients": 0,
        "bot_skip_rooms": 0,  "bot_skip_clients": 0
      },
      "stats": { "total_human_users": 164, "ts": "..." }
    },
    "2048": {
      "render": {
        "cpu_peak_m": 2.1, "mem_peak_mb": 45.0, "deploy_status": "live",
        "server_failed_count": 0, "downtime_count": 0
        /* 봇 관련 필드 없음 (has_bot_logs=false) */
      },
      "stats": { "total_users": 12, "top_all_time": 8192, "top_daily": 1024, "active_ws": 0, "ts": "..." }
    }
  },
  "aiven": {
    "cpu_pct_avg": 7.0, "cpu_pct_max": 8.83,
    "mem_pct_avg": 64.76, "mem_pct_max": 68.69
  }
}
```

- Aiven 은 omok / 2048 공유 (같은 인스턴스, prefix 격리) — `aiven` 한 번만 수집.
- 봇 관련 필드 (`worker_timeout_count` 등) 는 `has_bot_logs=true` 인 service (omok) 에만.
- 2048 stats fetch 가 cold-start 시 timeout → 다음 cycle 부터 alive (monitor 호출이 sleep 방지 역할).
- Aiven disk % 는 collect snapshot 엔 안 들어가고 daily-summary 본문 표에만 표시됨.

## 임계 (현 정책)

15 분 window 안에서 평가:

- Render CPU peak ≥ 100m (한도 100m — 도달 시 throttle)
- Aiven Memory ≥ 80% (한도 1024MB, noeviction)
- `worker_timeout` 발생 1건 이상
- `search returned no move` 발생 1건 이상
- `server_failed` 발생 1건 이상 (OOM / crash)
- 봇 `schedule RETRY` ≥ 30 건 (≈동시 2 게임 lag — 한 게임 단독 케이스는 통과)
- 봇 `schedule SKIP` ≥ 3 건 (RETRY 가 못 잡는 진짜 끊김)
- Server downtime > 60 초 (DISCONNECT_GRACE_MS 초과)
- Render 배포 비정상 (`deploy_status` ∉ {`live`, `*_in_progress`})
- **monitor 자체 fetch 연속 실패 ≥ 3회** (= 약 15분) — endpoint 별 (`render:{svc}` / `stats:{svc}` / `aiven`). transient retry (3회 exp backoff) 통과 후에도 실패. label `alert-fetch`.

임계 도달 시 GitHub Issue 자동 생성 (label: `monitor`, severity, `service-{omok|2048}`). 같은 alert key 는 **2시간 cooldown** (이전 6시간 — cron 5분에 맞춰 단축). alert key 는 `{base}:{service}` 형태로 service 별 cooldown 분리 (omok 의 CPU peak 와 2048 의 CPU peak 가 동시 발사 가능). 봇 관련 alert (`worker_timeout` / `no_move` / `bot_retry_burst` / `bot_skip_burst`) 는 `has_bot_logs=true` 인 omok 만 평가.

## Daily-summary 본문 — 시점 정책

| 영역 | 시점 |
|---|---|
| 측정 window (게임 활동 / 봇 / TOP / 안정성 / 시간대별) | **KST 어제 00:00 ~ 24:00** (s_iso ~ e_iso, UTC 변환 후 호출) |
| Render CPU / Memory (avg/p50/p95/max) | window 24h 직접 호출 (KST 어제) |
| **Aiven valkey 메트릭** (CPU/Mem/Disk/Load) | **발행 시점 -24h** (`period='day'` API — startTime 지원 X). 본문 캡션에 명시. |
| **Bandwidth 30d 누적** | **발행 시점 -30d** (직접 호출). 본문 캡션에 명시. |
| **현재 사람/사용자 계정 수, 동접** | **발행 시점** (`/api/stats` 단일 값). 본문 캡션에 명시. |
| 7일 trend 표 | snapshot KST day 합산 (Render CPU/Aiven Mem) + `daily-stats.json` (PVP/봇/활성/worker_timeout/hard_d6) |
| **`daily-stats[summary_date]` 갱신** | **trend 계산 직전** (race condition fix — Issue #148: 본문은 새 fetch 결과 / trend 표는 옛 stale daily-stats 결과 모순). 같은 발행 안에서 trend 가 본문 데이터와 일관성. |
| **배포 이력 (24h)** 표 | **window 안 deploy_started → deploy_ended 매칭** (KST 어제). 시각/소요/commit SHA/trigger (auto/manual/rollback/envUpdated). Render events API 응답은 commit SHA 만 — message 까지 원하면 별도 `/deploys/{deployId}` 호출 필요 (현재 생략 — burst 비용). |
| **서버 장애 / 배포 downtime (24h)** 표 | `compute_recovery_times` 결과 — `server_failed → server_available` (crash) + `deploy_started → server_available`/`deploy_ended` (deploy). free plan 의 deploy 는 `server_available` 미발사 → `deploy_ended` 가 사실상 "available again" 의 의미. |

같은 KST day 의 daily-summary 를 여러 번 발행해도 (cron-job.org primary, manual trigger, retry 등) **시계열 데이터의 값은 안정** — 단 위 표의 "발행 시점 -X" 항목만 발행 시각에 따라 약간 변동.

발행 본문에 `⚠️ Fetch 실패 endpoint` 섹션이 있으면 해당 endpoint 의 metric 은 fetch 못 한 silent loss 상태. 연속 3회 도달 시 fetch_fail Issue (collect cron 에서 발사).

## Fetch 정책

| 항목 | 정책 |
|---|---|
| Retry | transient HTTP 5xx / 429 / network 에러 → 자동 재시도, **최대 5회**. 429 는 응답의 **`Retry-After` 헤더** (RFC 7231 delta-seconds) 우선 사용, 없거나 다른 transient 면 exp backoff (1→2→4→8→16s, cap 30s). 4xx 4xx (404/400/...) 는 영구 에러로 즉시 propagate. `monitor_apis.http_get/post/patch` 에 일괄 적용. |
| Pagination | `render_search_logs` (nextEndTime), `render_events` (cursor) 모두 페이지네이션 자동 — window 안 모든 데이터 누적. safety cap `max_iter=50` (limit×50 = 5000건). Render API limit max=100 제약. |
| 실패 처리 | 호출자가 try/except 로 graceful skip — 해당 metric/alert 만 None, 나머지 흐름 정상. fetch_fail_streak (state.json) 에 endpoint 별 누적, 연속 3회 (≈ 15분) 도달 시 별도 `fetch_fail` alert. 성공 시 streak 자동 reset. |
| daily-summary fetch tracking | `render_search_logs` / `render_events` 의 `track_state` / `track_key` 인자로 fail_streak 자동 누적 — collect 와 같은 state.json 통합. **이번 발행 시점에 fetch 실패한 endpoint** 는 본문 끝의 `⚠️ Fetch 실패 endpoint` 섹션에 명시 (silent loss 인지). 누적 3회 시 collect 의 fetch_fail alert 와 같은 정책으로 Issue. |

## 수동 실행

```sh
# 로컬에서 dry-run (Issue 안 만들고 stdout 만 출력)
cd ~/Development/Personal/Brian
source ~/.zshrc && use-sehee   # 운영 데이터 fetch. dev/test 면 use-brian
GITHUB_REPOSITORY=seheemynamez/Brian SAVE_METRICS=0 python3 scripts/monitor.py
# daily-summary 모드:
MODE=daily-summary GITHUB_REPOSITORY=seheemynamez/Brian SAVE_METRICS=0 python3 scripts/monitor.py
```

GitHub Actions 에서는 [Actions UI](https://github.com/seheemynamez/Brian/actions/workflows/monitor-infra.yml) 의 `Run workflow` 로 `collect` / `daily-summary` 직접 호출 가능.

## 마이그레이션 (옛 UTC date 파일 → KST date)

KST 타임존 일관화 (PR 시점) 전에는 파일명이 UTC date 였음. 그 파일들을 KST date 별로 재분류하는 일회성 스크립트:

```sh
python3 scripts/migrate_metrics_to_kst.py            # dry-run
python3 scripts/migrate_metrics_to_kst.py --apply    # 실제 변경
```

각 옛 파일의 snapshot ts (UTC) 를 KST 로 변환해 해당 KST day 파일로 이동. 옛 UTC 이름 파일 중 새 KST 파일과 겹치지 않는 것만 삭제. 한 번 실행 후 commit. 새 데이터는 collect 가 KST_TODAY 로 자동 저장.
