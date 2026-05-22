# Brian

브라우저에서 바로 즐기는 미니 게임 모음 + 멀티플레이 오목 서버 + 인프라 모니터링.

- 🌐 라이브: https://seheemynamez.github.io/Brian/
- 🧩 게임:
  - [2048](https://seheemynamez.github.io/Brian/2048/) — 클래식 슬라이드 퍼즐 (싱글 플레이)
  - [오목대전](https://seheemynamez.github.io/Brian/omok/) — 실시간 멀티플레이 오목 (방 코드 / 랜덤 매칭 / 봇 대전 / 관전 / 랭킹)

---

## 디렉토리 구조

```
Brian/
├── 2048/                    # 2048 게임 — 정적 파일만 (HTML/CSS/JS)
├── omok/                    # 오목대전
│   ├── index.html           # 진입 페이지 (canonical / OG / JSON-LD 메타 포함)
│   ├── css/                 # base / components / screens 로 분리
│   ├── js/                  # ES Modules — main, net, ui, board, state, help, renju, sound
│   └── server/              # WebSocket + 정적 서빙 (Node.js)
├── metrics/                 # 인프라 메트릭 시계열 (monitor-infra cron 자동 수집·commit)
├── scripts/monitor.py       # Render + Aiven 메트릭 수집 + 임계 알림 (1,200 줄)
├── .github/workflows/       # CI (ci.yml) + monitor-infra (monitor-infra.yml)
├── render.yaml              # Render 배포 설정 (omok 서버용)
├── .nojekyll                # GitHub Pages 가 그대로 서빙하도록
└── README.md
```

---

## 스택

| 영역 | 사용 기술 |
|---|---|
| 프론트엔드 (공통) | HTML, CSS, **Vanilla JavaScript (ES Modules)** — 빌드 도구 없음 |
| 오목 보드 렌더링 | HTML Canvas |
| 오목 실시간 통신 | WebSocket (`wss://`) |
| 오목 서버 | Node.js **22+**, [`ws`](https://github.com/websockets/ws), [`ioredis`](https://github.com/redis/ioredis) |
| 서버 상태 저장 | 인메모리 cache + **Aiven Valkey (Redis 호환)** write-through 영속화. 재시작 후 hydrate 로 복구 |
| 봇 AI | `worker_threads` 격리 풀 — minimax + α-β + Iterative Deepening + Zobrist TT |
| 운영 모니터링 | Python + GitHub Actions cron — Render/Aiven 메트릭 시계열 + 임계 시 Issue 자동 발행 |

---

## 아키텍처

### 2048
순수 정적 페이지입니다. GitHub Pages 가 HTML/CSS/JS 를 그대로 서빙하고, 모든 게임 로직은 브라우저에서 돌아갑니다.

### 오목대전
프론트엔드와 서버가 **분리 배포**되어 있습니다.

```
┌──────────────────────────────┐                 ┌──────────────────────────────┐
│  브라우저 (GitHub Pages)     │   wss://...     │  Render (Node.js + ws)       │
│  /Brian/omok/                │ ◀──────────────▶│  omok/server/                │
│  - UI, 보드 그리기            │   WebSocket     │  - 방/큐/세션 / 봇 게임       │
│  - WebSocket 클라이언트       │                 │  - 게임 룰 검증, 승패 판정   │
│  - renju.js (FE 힌트용)       │                 │  - 렌주룰 (BE 가 SoT)         │
└──────────────────────────────┘                 └──────────────────────────────┘
                                                              │
                                                              │ write-through (ioredis)
                                                              ▼
                                                 ┌──────────────────────────────┐
                                                 │  Aiven Valkey (singapore)    │
                                                 │  - rooms / sessions / queue  │
                                                 │  - users / ranking / recent  │
                                                 └──────────────────────────────┘
```

- **호스트에 따라 자동 전환**: GitHub Pages 도메인에서 열리면 Render 서버로, 그 외(로컬·LAN) 에서는 같은 호스트로 연결합니다 ([omok/js/net.js](omok/js/net.js)).
- **Origin 잠금**: 프로덕션에서는 환경변수 `ALLOWED_ORIGINS` 로 GitHub Pages 도메인만 허용합니다.
- **renju 룰 parity**: FE/BE 양쪽에 `renju.js` 가 있고 CI 가 함수 body 를 정규식으로 비교해 강제 동기화 (`omok/server/__tests__/unit/renju-parity.test.js`). FE 의 금수 표시는 UX 힌트이고 권위 있는 판정은 서버.
- **재연결 모델**: 두 layer 식별자.
  - `sessionId` — 방 안 역할 단위. URL 해시에 저장, `resume_session` 으로 복구.
  - `clientId` — 브라우저 사용자 후보 단위. localStorage 에 저장, 끊긴 player 가 새 ws 로 같은 방 join 시 자동 player 재합류 (reclaim).
  - heartbeat ws ping (15s × 2 cycle) + app-level ping/pong 으로 좀비 ws 감지. 모든 grace timer 는 `DISCONNECT_GRACE_MS` 등 env 로 조정 (기본값은 `omok/server/.env.example` 참고).

### WebSocket 프로토콜 (요약)

상세는 [omok/server/README.md](omok/server/README.md) 참고.

**클라이언트 → 서버**
- 방 관리: `create_room` / `join_room` / `spectate_room` / `leave_room` / `rematch`
- 매칭: `queue_join` / `queue_leave`
- 게임: `move` / `resume_session`
- 봇 게임: `create_bot_game` / `bot_offer_accept` / `bot_offer_decline`
- 이모트·로비: `emote` / `set_nickname` / `request_rooms_list` / `request_online_list`
- 연결: `ping`

**서버 → 클라이언트**
- 매칭/시작: `room_created` / `matched` / `game_start` / `spectate_success` / `queue_waiting` / `queue_canceled` / `bot_offer`
- 진행/종료: `move` / `turn_started` / `turn_skipped` / `game_over` / `rematch_pending`
- 끊김/복귀: `opponent_disconnected` / `opponent_reconnected` / `opponent_left` / `opponent_abandoned` / `player_replaced` / `resume_success` / `resume_failed`
- 로비/관전: `online_count` / `online_list` / `rooms_list` / `spectator_list` / `spectator_replaced`
- 기타: `emote` / `error` / `pong` / `server_restarting`

---

## 주요 기능

- **방 코드 매칭** — 4자리 코드 생성·공유. private 방 toggle.
- **랜덤 매칭** — 빈 public 방 우선 합류 → 없으면 큐. 10s 무매칭 시 봇 제안.
- **봇 대전** — 易/中/上 3난이도. minimax + α-β + ID + Zobrist TT. worker thread 격리로 main loop block 방지.
- **관전** — 같은 방 코드로 spectator 입장. 진행 상황 실시간 broadcast.
- **랭킹 / 레이팅** — Elo 기반. 봇 게임도 포함. 종료 화면 즉시 표시 + 로비에 top 10 broadcast.
- **이모트** — 정해진 셋 (👏🔥😅🤔 등) 으로 양쪽·관전자에 broadcast. 봇도 상황별로 응답.
- **재연결 복구** — 새로고침 / 비행기모드 / Render 재배포 모두 대응. 진행 중 게임 보존.
- **초대 URL** — `/i/CODE` 가 OG 메타 응답 후 사람에게 canonical 게임 URL 로 redirect.
- **운영 모니터링** — Render + Aiven 메트릭을 매시 **7,37분** cron 으로 수집, 임계 도달 시 GitHub Issue 자동 발행, 매일 daily-summary 발행.

---

## 로컬에서 실행

### 2048
```bash
cd 2048
python3 -m http.server 8765
# → http://localhost:8765
```

### 오목대전
정적 파일과 WebSocket 서버가 **한 프로세스**에서 함께 돌아갑니다.

```bash
cd omok/server
npm install
npm start
# → http://localhost:8080
# → ws://localhost:8080/ws
```

같은 와이파이의 다른 기기에서 테스트하려면 맥의 LAN IP 를 확인해서 (`ipconfig getifaddr en0`) 그 주소로 접속하면 됩니다.

서버는 기본적으로 **memory backend** 로 뜹니다. 영속화 / hydrate 테스트는 `omok/server/.env` 에 `STORE_BACKEND=valkey` + `VALKEY_URL` 설정 — 자세한 건 [omok/server/README.md](omok/server/README.md).

### 테스트

```bash
cd omok/server
npm run test:unit    # 단위 (renju / rating / game-logic / parity / bot)
npm test             # E2E (recovery / reconnect / spectator / bot lifecycle)
npm run test:ci      # 둘 다
npm run test:valkey  # E2E 를 valkey backend 로 (.env 필요)
npm run test:hydrate # 재시작 hydrate 검증 (SIGTERM → restart → resume 일치)
```

---

## 배포

### 프론트엔드 — GitHub Pages
- `main` 브랜치의 루트가 그대로 https://seheemynamez.github.io/Brian/ 에 올라갑니다.
- `.nojekyll` 파일로 Jekyll 처리를 끄고, 폴더 구조 그대로 서빙합니다.
- 푸시하면 자동 재배포됩니다.

### 오목 서버 — Render (Blueprint)
- [`render.yaml`](render.yaml) 한 파일로 정의돼 있어, Render 대시보드에서 New → Blueprint → 이 레포 선택 → Connect 하면 끝납니다.
- `main` 에 push 할 때마다 자동 재배포.
- 무료 플랜이라 15분 무활동 시 sleep 됩니다 (첫 접속 시 30초 정도 콜드스타트).
- 리전: `singapore` (한국에서 가장 가까움).
- 필수 환경변수 (Render dashboard 에서 설정):
  - `STORE_BACKEND=valkey` — production 가드가 memory backend 거부.
  - `VALKEY_URL=rediss://...` — Aiven Connection URI.
  - `VALKEY_KEY_PREFIX=omok:prod` — dev 와 namespace 분리.
  - `ALLOWED_ORIGINS=https://seheemynamez.github.io` — Origin 잠금.
  - `CANONICAL_OMOK_URL=https://seheemynamez.github.io/Brian/omok/` — `/i/CODE` redirect 타겟.
- 그 외 운영 튜닝 가능 env: `BOT_WORKER_POOL_SIZE`, `BOT_WORKER_TIMEOUT_MS`, `DISCONNECT_GRACE_MS` 등. [omok/server/.env.example](omok/server/.env.example) 참고.

배포된 서버 주소는 [omok/js/net.js](omok/js/net.js) 의 `PROD_WS_URL` 에 박혀 있습니다.

### 운영 모니터링 — GitHub Actions
- [`.github/workflows/monitor-infra.yml`](.github/workflows/monitor-infra.yml) 가 cron 으로 자동 실행:
  - 매시 **7분/37분** — collect (snapshot 저장 + 임계 검사 + alert Issue)
  - 매일 **UTC 00:07** — daily-summary (24h+7d 요약 Issue 발행)
- 결과는 [`metrics/`](metrics/) 에 자동 commit. 상세는 [`metrics/README.md`](metrics/README.md).
- Issue 자동 발행 정책 (label `monitor`, severity, 6시간 cooldown) 도 같은 README 에.
