# 오목 서버

Korean Gomoku WebSocket server. 정적 파일 호스팅 (omok/ 디렉토리) + `/ws` 게임 WebSocket 엔드포인트.

## 실행

```bash
npm install
npm start             # 기본 — memory backend, port 8080
npm test              # 회귀 테스트 (memory backend, 57 시나리오)
npm run test:valkey   # 같은 테스트를 valkey backend 로 (.env 의 VALKEY_URL 사용, prefix omok:test 자동격리)
npm run test:hydrate  # 부팅 hydrate 검증 — 방생성 → SIGTERM → restart → resume 일치 확인
```

수동 스모크 체크리스트: `scripts/MANUAL_SMOKE.md`
Render 프로덕션 검증 절차: `scripts/RENDER_VERIFY.md`

`.env` 파일을 만들면 `node --env-file-if-exists=.env server.js` 가 자동 로드합니다.

콘솔 부팅 로그 예시:
```
[server_start] port=8080 heartbeat_ms=30000 allowed_origins=any store=memory
```

## 같은 WiFi 의 다른 기기에서 접속

1. Mac LAN IP 확인: `ipconfig getifaddr en0`
2. 다른 기기 브라우저에서 `http://<LAN IP>:8080/` 접속
3. 두 기기에서 같은 방 코드로 들어가거나 "랜덤 매칭" 으로 매칭

## Store backend

`STORE_BACKEND` 환경변수로 선택:

- **`memory`** (기본): 단일 프로세스 메모리. 서버 재시작 시 모든 도메인 state 초기화.
- **`valkey`**: 외부 redis-compatible (Aiven Valkey 등) 에 write-through. 재시작 후 hydrate 로 복구.

### valkey 사용 시 환경변수

```
STORE_BACKEND=valkey
VALKEY_URL=rediss://default:PASSWORD@host:port
VALKEY_KEY_PREFIX=omok:dev      # 로컬. production 은 'omok:prod'
```

`.env.example` 참고. Aiven 콘솔의 Connection information → Service URI 를 그대로 사용.

### dev / prod 키 namespace 분리

로컬 개발 + Render production 이 같은 Aiven 인스턴스를 공유한다면 **`VALKEY_KEY_PREFIX` 분리 필수**. 안 그러면 로컬 게임이 production 데이터에 섞임.

- 로컬 `.env`: `VALKEY_KEY_PREFIX=omok:dev`
- Render Environment: `VALKEY_KEY_PREFIX=omok:prod`

키 스키마는 prefix 만 바뀌고 나머지 동일 (예: `omok:prod:room:ABCD`).

### Valkey 키 스키마

`{PREFIX}` 는 `VALKEY_KEY_PREFIX` 환경변수 (기본 `omok`).

| 키 | 값 |
|---|---|
| `{PREFIX}:room:{code}` | room JSON (board / turn / players / status / turnDeadline / ...) |
| `{PREFIX}:rooms` | SET of room codes (인덱스) |
| `{PREFIX}:session:{sid}` | session JSON (role / code / color / clientId / nickname / lastSeenAt) |
| `{PREFIX}:sessions` | SET of session IDs |
| `{PREFIX}:queue` | 매칭 대기 큐 array JSON |
| `{PREFIX}:botOffer:{clientId}` | 봇 제안 발송 시각 (EX 120s 자동 만료) |

쓰기 시점: 메모리 갱신 직후 fire-and-forget 으로 valkey 에 SET (write-through).
읽기는 항상 메모리. 부팅 시 한 번 hydrate 로 메모리 cache 초기화.

## 프로토콜 (주요 메시지)

클라이언트 → 서버:
- `{ type: "create_room", nickname }`
- `{ type: "join_room", code, nickname }`
- `{ type: "spectate_room", code, nickname }`
- `{ type: "queue_join", nickname, clientId }` / `{ type: "queue_leave" }`
- `{ type: "set_nickname", nickname, clientId }`
- `{ type: "resume_session", sessionId, nickname }`
- `{ type: "move", row, col }`
- `{ type: "rematch" }` / `{ type: "leave_room" }`
- `{ type: "ping" }` (app-level heartbeat)
- `{ type: "create_bot_game", difficulty, first, nickname }`
- `{ type: "bot_offer_accept", difficulty, first, nickname }` / `{ type: "bot_offer_decline" }`
- `{ type: "request_rooms_list" }` / `{ type: "request_online_list" }`

서버 → 클라이언트:
- `{ type: "room_created", code, sessionId }`
- `{ type: "game_start", you, opponent, turn, board, gameId, sessionId, playerStatus, ... }`
- `{ type: "spectate_success", code, sessionId, board, playerStatus, ... }`
- `{ type: "resume_success", ... }` / `{ type: "resume_failed", reason }`
- `{ type: "move", row, col, color, turn? }`
- `{ type: "turn_started", turn, deadline }` / `{ type: "turn_skipped", skipped, turn }`
- `{ type: "game_over", winner, line, gameId, playerIds }`
- `{ type: "rematch_pending", who }`
- `{ type: "opponent_disconnected", color, deadline }` / `{ type: "opponent_reconnected", color }`
- `{ type: "opponent_left" }` / `{ type: "opponent_abandoned", color }`
- `{ type: "spectator_list", spectators }` / `{ type: "spectator_replaced" }`
- `{ type: "online_count", n }` / `{ type: "online_list", nicknames }` / `{ type: "rooms_list", rooms }`
- `{ type: "matched", code }` / `{ type: "queue_waiting" }` / `{ type: "queue_canceled", reason }`
- `{ type: "bot_offer" }`
- `{ type: "player_replaced" }`
- `{ type: "emote", from, key, emoji, text }`
- `{ type: "error", message, reason? }`
- `{ type: "pong" }`

## 운영 노트

### Render 배포
1. Service settings → Environment 탭에서 `STORE_BACKEND=valkey`, `VALKEY_URL=…` 추가.
2. 저장 시 자동 재배포. 부팅 로그에서 `[valkey] hydrated: ...` + `[store_ready] backend=valkey` 확인.

### 진행 중 게임의 재시작 복구 (valkey backend)
- 부팅 시 valkey 의 모든 room hydrate.
- `status='playing'` 인 방은 `turnDeadline` 기준으로 turn timer 재등록. 봇 차례면 `scheduleBotMove` 재개.
- 사용자는 평소처럼 `resume_session` (또는 clientId reclaim) 으로 진행 중 게임 이어가기 가능.

### 단일 인스턴스 가정
멀티 인스턴스 (Render Pro 등) 운영 시 추가 작업 필요:
- 인스턴스 간 broadcast/state sync (현재는 메모리 cache 가 각 인스턴스마다 개별).
- 메시지 큐 / pub-sub (예: valkey pub/sub) 도입.

지금은 가정하지 않음.

### 보안
- `VALKEY_URL` 에 password 포함. **절대 코드/commit 에 inline 하지 말 것**. 항상 `.env` 또는 Render env 로만.
- chat / 이슈 / 로그에 노출되면 즉시 Aiven 콘솔에서 password rotate.
