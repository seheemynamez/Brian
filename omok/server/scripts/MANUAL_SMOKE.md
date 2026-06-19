# Manual Smoke Checklist

자동 테스트가 cover 못 하는 UI/네트워크 결합 부분만 브라우저로 빠르게 검증.
**소요 시간: 15-30분**. 머지 전 1회면 충분.

대상 환경:
- 로컬: `npm start` 또는 `node --env-file-if-exists=.env server.js` → http://localhost:18091
- Render: https://omok-server-dorf.onrender.com

각 시나리오 후 ✅ 표시.

---

## 1) 봇 게임 (한 난이도)

- [ ] 로비에서 "혼자 봇과" → easy 선택
- [ ] 게임 시작 시 봇이 `game_start` emote 표시
- [ ] 내 차례에 (7,7) 클릭 → 돌 놓임
- [ ] 봇이 thinking 후 응수
- [ ] 5-10수 진행하면서 `bot_moved` / `opponent_moved` emote 자연스럽게 뜨는지
- [ ] 게임 끝까지 진행 → `game_over_win` 또는 `game_over_lose` emote
- [ ] 끝나고 "다시" 버튼 동작 (rematch)

문제 신호: emote 안 뜸, 봇 응수 5초+ 지연, 게임 종료 안 됨

---

## 2) 랜덤 매칭 → 봇 제안 흐름

- [ ] 탭 A에서 "랜덤 매칭" 클릭 → 큐 입장
- [ ] 10초+ 대기 (BOT_OFFER_DELAY_MS = 10000 in prod)
- [ ] "봇과 둘까요?" 모달 뜸
- [ ] "수락" → 봇 게임 자동 시작
- [ ] (별도 검증) 탭 A 큐 입장 → 탭 B 큐 입장 → 즉시 매칭 → 게임 시작

문제 신호: 봇 제안 모달 안 뜸, 매칭 안 됨, 큐가 안 빠짐

---

## 3) 새로고침 후 resume (가장 중요)

valkey backend 의 핵심 가치 검증.

### 3-1) PVP 게임 도중

- [ ] 탭 A + 탭 B로 같은 방 입장 → 게임 시작
- [ ] 양쪽 2-3수 진행
- [ ] **탭 A 새로고침 (F5)** — URL `?room=XXXX` 그대로 유지
- [ ] 새로고침 후 보드 state 그대로 보임
- [ ] 탭 B에 `opponent_reconnected` 표시
- [ ] 계속 둘 수 있음

### 3-2) 봇 게임 도중

- [ ] 봇 게임 시작 + 2-3수
- [ ] 새로고침
- [ ] 보드 state 보존, 봇이 차례라면 계속 응수

### 3-3) (Render only) 서버 재시작 시뮬레이션 불가능 — 자동 hydrate 테스트로 대체

로컬에서는 `npm run test:hydrate` 가 동일 시나리오 자동 검증.

---

## 4) (선택) 관전자 흐름

- [ ] 탭 A + 탭 B 게임 시작
- [ ] 탭 C에서 같은 방 URL 직접 입장 → 관전자로 입장
- [ ] 탭 C 보드에 진행 상황 실시간 반영
- [ ] 탭 C 새로고침 → spectator 로 다시 입장 (30s grace 안에)

---

## 환경 조합 권장 매트릭스

| 환경 | 봇 게임 | 매칭 | Resume |
|---|---|---|---|
| 로컬 memory | 필수 | 필수 | (의미 없음) |
| 로컬 valkey (Aiven dev prefix) | 필수 | 필수 | 필수 |
| Render prod (머지 후) | 필수 | 필수 | 필수 |

머지 전 = 위 두 줄. 머지 후 = 마지막 줄.
