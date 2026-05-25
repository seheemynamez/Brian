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
| valkey daily Hash key suffix | **KST date** (`omok:prod:daily:YYYY-MM-DD`) | summary_date 와 일치 |
| `state.json` `last_alert` ts | UTC ISO | cooldown 계산 (절대 시간) 만 사용, 사람 표시 X |
| alert / daily-summary 본문 시각 | KST 표기 + UTC 병기 | `2026-05-24 09:05:14 KST (00:05:14Z)` |
| 모든 day 단위 집계 | KST | 7일 trend / 시간대별 bucket / window |
| Render/Aiven API 호출 | UTC ISO (`...Z`) | `to_utc_iso(kst_dt)` helper 로 변환 |

호출자가 KST 일관 사용 가정 가능. parser (`parse_bot_logs`, `parse_bot_moves` — 알림 컨텍스트 용, `compute_recovery_times` 등) 의 ts 결과는 모두 KST ISO 로 normalize.

## 파일

- `YYYY-MM-DD.json` — **KST 캘린더 day** 별 5분 collect snapshot 시계열 (KST 00:00 ~ 익일 00:00). snapshot 내부 `ts` 는 UTC ISO. **infra-only**: Render CPU/Mem/BW + Render events (deploy/server_failed) + Aiven metrics + `services.omok.stats` (current /api/stats snapshot at collect time). server-domain 카운터 (worker_timeout / bot_retry / etc.) 는 **valkey 가 SoT 이며 snapshot 에 포함되지 않음** — daily-summary 가 `/api/daily-stats` endpoint 로 가져감.
- `state.json` — alert cooldown 상태 (같은 알림 종류 2시간 1회 제한) + `fetch_fail_streak` (endpoint 별 연속 실패 카운트). `last_alert` ts 는 UTC ISO.

> **이전 파일 `daily-stats.json` 제거** (valkey-first monitoring 전환, PR #168). 일별 aggregate (pvp_games / bot_games / active_users / total_human_users / tiers 등) 는 모두 server `/api/daily-stats?date=YYYY-MM-DD` 로 조회. 옛 30일 보존 파일이 90일 보존 valkey Hash 로 대체. 7d trend 표는 daily-summary 가 7개 date 에 대해 endpoint 를 hit. 재해 복구는 `scripts/reconstruct_valkey_from_render_logs.py` 로 Render log 90d 윈도우에서 game records / bot moves / counter / SET / online series 모두 valkey 적재 가능 (실측: 5/22-23 사례).

## snapshot 구조 (collect 모드)

`metrics/YYYY-MM-DD.json` 의 한 entry — daily-summary 가 7d trend (Render CPU max 일별) + Aiven 메트릭 (어제 day 집계) 를 만드는 데 필요한 최소 필드만:

```json
{
  "ts": "2026-05-25T03:05:14.995511+00:00",
  "services": {
    "omok": { "render": { "cpu_peak_m": 1.28 } },
    "2048": { "render": { "cpu_peak_m": 0.71 } }
  },
  "aiven": {
    "cpu_pct_avg": 7.31, "cpu_pct_max": 10.67,
    "mem_pct_avg": 66.42, "mem_pct_max": 67.46,
    "disk_pct_avg": 0.091, "disk_pct_max": 0.091,
    "load_avg":     0.066, "load_max":     0.21
  }
}
```

### 필드 별 용도

| 필드 | source | summary 사용처 |
|---|---|---|
| `ts` | collect 실행 시각 UTC ISO | `by_day` KST 그룹핑 — 7d trend / Aiven 집계의 day key |
| `services.{omok,2048}.render.cpu_peak_m` | Render `cpu` metric 5분 window max | 7d 트렌드 표 "CPU max" (omok / 2048 각) |
| `aiven.cpu_pct_avg/max` | `aiven_metrics('hour')` 응답 집계 | Aiven 메트릭 표 (CPU%) |
| `aiven.mem_pct_avg/max` | 동일 | Aiven 메모리 표 + 7d trend `aiven_mem_max_pct` + 장기 트렌드 추정 |
| `aiven.disk_pct_avg/max` | 동일 | Aiven 디스크 표 |
| `aiven.load_avg/max` | 동일 | Aiven Load avg 표 |

### 제거된 필드 (PR — slim)

`cpu_avg_m`, `mem_peak_mb`, `deploy_status`, `server_failed_count`, `server_oom_count`, `server_crash_count`, `downtime_count`, `downtime_max_s`, `slow_recovery_count`, `worker_timeout_count` 등 옛 alert 평가용 필드는 collect 의 즉시 alert 판정 후 dormant — summary 가 다시 안 읽음 (`failures` / `recoveries` 는 `render_events` 직접 호출로 fresh 계산, `worker_timeout` 등 카운터는 daily-stats endpoint 가 SoT). 저장 의미 없어 drop.

또 `services.{svc}.stats` 도 제거 — daily-stats endpoint snapshot 과 100% 중복 (`total_human_users` / `tiers` / `bots` / 2048 `total_users` 등 모두 그 endpoint 에서 frozen 응답).

### 운영 노트

- Aiven 은 omok / 2048 공유 (같은 인스턴스, prefix 격리) — `aiven` 한 번만 수집.
- snapshot 은 **infra-only** — server-domain 카운터는 valkey daily Hash 가 SoT (`/api/daily-stats?date=...` 응답). collect 가 매 5분 `/api/stats` 호출은 server cold-start ping + `statsHandler` 의 snapshotDailyMeta 부수효과 트리거용.
- collect 의 **burst alert** (worker_timeout / RETRY / SKIP burst Issue) 는 정확한 15분 window 측정 필요 → 그 부분만 log fetch 유지 (raw 로 즉시 평가, snapshot 에 저장 X).
- JSON 파일은 `indent=2` 로 prettify — 사람이 직접 열람 + 검증 가능.

## 임계 (현 정책)

15 분 window 안에서 평가:

- Render CPU peak ≥ 100m (한도 100m — 도달 시 throttle)
- Aiven Memory ≥ 80% (한도 1024MB, noeviction)
- `worker_timeout` 발생 1건 이상
- `search returned no move` 발생 1건 이상
- `server_failed` 발생 1건 이상 (OOM / crash)
- 봇 `schedule RETRY` ≥ 30 건 (≈동시 2 게임 lag — 한 게임 단독 케이스는 통과)
- 봇 `schedule SKIP` ≥ 3 건 (RETRY 가 못 잡는 진짜 끊김)
- Server downtime > 90 초 (DISCONNECT_GRACE_MS 초과 — Issue #155 deploy 136s 반영)
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
| **server-domain 카운터 / 게임 / 봇 착수 / online series** | **valkey-first** — `/api/daily-stats`, `/api/daily-games`, `/api/daily-bot-moves`, `/api/online-series` 4종 endpoint 직접. Render log fetch 제거 (silent loss / pagination cap 영향 없음). valkey 장애 시 해당 영역 "0" / "-" + fail_streak alert. |
| 7일 trend 표 | snapshot KST day 합산 (Render CPU/Aiven Mem) + 7개 date 에 대해 `/api/daily-stats` endpoint 호출 (omok + 2048 각). PR 머지 전 backfill 권장 — `scripts/backfill_daily_stats_to_valkey.py`. |
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
| daily-summary fetch tracking | server-domain 데이터는 `/api/daily-stats`, `/api/daily-games`, `/api/daily-bot-moves`, `/api/online-series` 4종 endpoint 직접 호출 (Render log fetch 0). infra-only 잔존 호출은 `render_events` 의 `track_state`/`track_key` 인자로 fail_streak 자동 누적 — collect 와 같은 state.json 통합. **이번 발행 시점에 fetch 실패한 endpoint** 는 본문 끝의 `⚠️ Fetch 실패 endpoint` 섹션에 명시 (silent loss 인지). 누적 3회 시 collect 의 fetch_fail alert 와 같은 정책으로 Issue. |

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
