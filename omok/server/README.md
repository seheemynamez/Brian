# 오목 서버

Korean Gomoku WebSocket server. 정적 파일 호스팅 (omok/ 디렉토리) + `/ws` 게임 WebSocket 엔드포인트.

## 실행

```bash
npm install
npm start             # 기본 — memory backend, port 8080
npm run test:unit     # 단위 테스트 (renju / rating / game-logic / parity / bot / ranking-sort 등 — 138 케이스)
npm test              # E2E 회귀 (recovery / reconnect / spectator / bot lifecycle — 79 시나리오, memory backend)
npm run test:ci       # 둘 다 (CI 와 동일)
npm run test:valkey   # E2E 를 valkey backend 로 (.env 의 VALKEY_URL 사용, prefix omok:test 자동격리)
npm run test:hydrate  # 부팅 hydrate 검증 — 방생성 → SIGTERM → restart → resume 일치 확인
```

수동 스모크 체크리스트: `scripts/MANUAL_SMOKE.md`
Render 프로덕션 검증 절차: `scripts/RENDER_VERIFY.md`

`.env` 파일을 만들면 `node --env-file-if-exists=.env server.js` 가 자동 로드합니다. 운영 튜닝 가능한 env 전체 목록은 [`.env.example`](.env.example).

콘솔 부팅 로그 예시:
```
[store_ready] backend=memory
[server_start] port=8080 heartbeat_ms=15000 allowed_origins=any store=memory
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
| `{PREFIX}:room:{code}` | room JSON (board / turn / players / status / turnDeadline / turnRemainMs / ...) |
| `{PREFIX}:rooms` | SET of room codes (인덱스) |
| `{PREFIX}:session:{sid}` | session JSON (role / code / color / clientId / nickname / lastSeenAt) |
| `{PREFIX}:sessions` | SET of session IDs |
| `{PREFIX}:queue` | 매칭 대기 큐 array JSON |
| `{PREFIX}:botOffer:{clientId}` | 봇 제안 발송 시각 (EX 120s 자동 만료) |
| `{PREFIX}:user:{clientId}` | user JSON (rating / wins / losses / draws / nickname / createdAt) |
| `{PREFIX}:users` | SET of user clientIds (랭킹 인덱스) |
| `{PREFIX}:recent_games` | LIST of game-over JSON (LPUSH + LTRIM, cap = `RECENT_GAMES_CAP`) |

쓰기 시점: 메모리 갱신 직후 fire-and-forget 으로 valkey 에 SET (write-through).
읽기는 항상 메모리. 부팅 시 한 번 hydrate 로 메모리 cache 초기화.

### Write-through 정책 (best-effort)

valkey backend 의 write 는 **fire-and-forget**:

1. 메모리 cache (Map / Array) 를 먼저 갱신
2. valkey 명령을 비동기 호출 (`.catch` 만 걸려있고 await 안 함)
3. 사용자 action 응답은 즉시 (valkey RTT 무시)

이 정책의 의미:

- **장점**: 사용자 action latency 가 valkey RTT (Aiven Bangalore ~200ms) 에 영향 없음.
- **단점**: process crash + valkey 미도달 사이의 좁은 window (보통 수십 ms) 에 한해 마지막 변경 lost 가능. valkey 실패는 `[valkey] cmd fail:` 로 로깅되지만 사용자 action 은 성공으로 응답.
- **회복**: 다음 write 가 자연 복구. room 단위로 전체 JSON 을 매번 SET 하기 때문에 partial write 누락이 다음 변경 시 사라짐.
- **운영 트래픽 수준**: 현재 single Render 인스턴스 + 동시 게임 < 100 수준에선 fire-and-forget 으로 충분. 만일 일관성을 더 강하게 가져가려면 `store/valkey.js` 의 `fnf` 를 await 으로 바꿔 latency 와 트레이드 가능.

### Production 가드

`NODE_ENV=production` (Render 가 자동 설정) 에서 `STORE_BACKEND` 가 `valkey` 가 아니면 부팅 거부. env 누락으로 prod 가 memory backend 로 떠 데이터가 휘발되는 사고 방지.

```
Error: Production (NODE_ENV=production) 에서 STORE_BACKEND='memory' 거부.
```

임시 우회 (테스트 / 데이터 마이그레이션 등 의도된 경우):
```
ALLOW_MEMORY_STORE_IN_PROD=1
```

local / test 환경 (`NODE_ENV` 미설정) 에서는 무관 — `STORE_BACKEND` 기본값 (memory) 또는 명시 (valkey) 모두 동작.

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
