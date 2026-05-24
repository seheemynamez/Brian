# 2048 server

랭킹 backend — WebSocket 으로 점수 등록 / 랭킹 broadcast / 닉네임 관리. Aiven Valkey 영속화 (omok 와 같은 인스턴스, prefix `2048:prod` 격리).

## 실행

```bash
npm install
npm start             # memory backend, port 8081
npm run test:unit     # 단위 (users 도메인)
npm test              # E2E (recovery)
npm run test:ci       # 둘 다
```

`.env` 만들면 자동 로드 (`--env-file-if-exists=.env`). 변수는 [.env.example](.env.example) 참고.

## 디렉토리

```
2048/server/
├── server.js           # HTTP + WS entry
├── infra/
│   ├── log.js          # 구조화 로깅
│   └── share.js        # /i/2048/{nick}/{score} OG meta
├── domain/
│   └── users.js        # user + all-time / daily 랭킹
├── handlers/
│   ├── index.js        # WS message router
│   └── send.js         # broadcast helpers
├── store/
│   ├── index.js        # backend selector + prod 가드
│   ├── memory.js       # in-process Map (테스트/로컬)
│   └── valkey.js       # Aiven Valkey write-through
└── __tests__/
    ├── unit/users.test.js  # users 도메인 단위
    └── recovery.test.js    # E2E (npm test 가 서버 자동 spawn — port 18082)
```

## HTTP endpoint

| Path | 응답 |
|---|---|
| `GET /api/stats` | `{total_users, top_all_time, top_daily, active_ws, ts}` JSON (monitor 가 5분마다 호출 — sleep 방지 + 시계열 수집) |
| `GET /api/daily-stats?date=YYYY-MM-DD` | KST 일별 카운터 + active_users SET 크기. 응답: `{date, submit_score, user_created, score_best, ws_connected, ws_disconnected, heartbeat_terminate, active_users, ts}`. valkey 90d TTL. 400 on invalid date. |
| `GET /api/online-series?from=<epoch_ms>&to=<epoch_ms>` | 1분 sampler online count 시계열. 응답: `{from, to, count, items: [{ts, count}], ts}`. |
| `GET /i/2048` `/i/2048/{nick}` `/i/2048/{nick}/{score}` | 동적 OG meta + canonical 2048 페이지로 redirect |
| 그 외 | 404 (정적 파일은 GitHub Pages 에서 서빙) |

## WebSocket 메시지

### 클라이언트 → 서버
- `{type:'set_nickname', clientId, nickname}` — 닉네임 등록/변경
- `{type:'submit_score', clientId, nickname?, score}` — 점수 등록 (game over + best 갱신 시)
- `{type:'request_ranking'}` — 최초 진입 시 1회
- `{type:'request_my_rank', clientId}` — 내 순위 조회
- `{type:'ping'}` — heartbeat

### 서버 → 클라이언트
- `{type:'nickname_set', user}` — 닉네임 등록 결과
- `{type:'score_recorded', user, allTimeUpdated, dailyUpdated}` — 점수 등록 결과
- `{type:'ranking', allTime:[...], daily:[...], dailyDate}` — 랭킹 (변동 시 broadcast)
- `{type:'my_rank', nickname, allTime:{score,rank,total}, daily:{...}}`
- `{type:'pong'}`
- `{type:'error', message}`
- `{type:'server_restarting}` — graceful shutdown 시

## 랭킹 모델

- **All-time**: `user.allTimeBest` desc, tie 면 `createdAt` asc (먼저 도달한 사람 우선)
- **Daily**: 같은 정렬, **KST 자정 00:00 reset** — lazy 적용 (사용자 점수 등록 시 `user.dailyDate !== 오늘` 이면 0 으로 reset 후 갱신)

## valkey 키 스키마

`{PREFIX}` 는 `VALKEY_KEY_PREFIX` 환경변수 (기본 `2048:dev`). production 은 `2048:prod`.

| 키 | 값 |
|---|---|
| `{PREFIX}:user:{clientId}` | user JSON `{clientId, nickname, allTimeBest, dailyBest, dailyDate, createdAt, updatedAt}` |
| `{PREFIX}:users` | SET of clientIds (인덱스, hydrate 용) |

omok 의 `omok:prod` 와 격리 — 같은 Aiven 인스턴스에 공존 가능.

## 운영 로그 (monitor 가 parse)

monitor (5분 cron) 이 Render 로그에서 이 prefix 들을 검색해 시계열/일일 지표로 집계.

| prefix | 의미 | 출력 시점 |
|---|---|---|
| `[submit_score]` | 모든 점수 등록 (best 갱신 여부 무관) | 매 `submit_score` 메시지 처리 시 |
| `[score_best]` | best 갱신 시 broadcast 트리거 — 사용자 visible 이벤트 | `submit_score` 가 allTime/daily 갱신 시 |
| `[user_created]` | 신규 user 첫 생성 — `src=nickname`/`score` | `set_nickname` 또는 `submit_score` 가 첫 등록일 때 |
| `[nickname_set]` | 닉네임 등록/변경 | 매 `set_nickname` 처리 시 |
| `[ws_connected]` / `[ws_disconnected]` | WS 연결 수명 | connection / close 시 (`active=` 는 현재 연결 수) |
| `[heartbeat_terminate]` | zombie ws 정리 (2 cycle 무응답) | 15s heartbeat 가 좀비 발견 시 |
| `[store_ready]` / `[server_start]` / `[server_shutdown]` | 부팅 / 종료 | 해당 시점 |

## 보안

- `VALKEY_URL` 에 password 포함 → 코드/commit 에 inline 금지. `.env` 또는 Render env 만.
- chat / 이슈 / 로그 노출 시 즉시 Aiven 콘솔에서 rotate.

## Production 가드

`NODE_ENV=production` + `STORE_BACKEND≠valkey` → 부팅 거부. 우회: `ALLOW_MEMORY_STORE_IN_PROD=1`.
