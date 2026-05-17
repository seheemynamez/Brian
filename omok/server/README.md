# 오목 서버 (Stage 1: 같은 와이파이)

게임 정적 파일과 WebSocket을 동시에 서빙합니다.

## 실행

```bash
cd omok/server
npm install
npm start
```

기본 포트는 `8080`. 환경변수 `PORT`로 변경 가능.

콘솔에 다음과 같이 표시됩니다:

```
[omok] HTTP listening on http://localhost:8080
[omok] WebSocket endpoint: ws://localhost:8080/ws
```

## 같은 와이파이의 다른 기기에서 접속

1. 맥 LAN IP 확인: `ipconfig getifaddr en0`
2. 다른 기기 브라우저에서 `http://<맥 LAN IP>:8080/` 접속
3. 두 기기에서 같은 방 코드로 들어가거나 "랜덤 매칭"으로 매칭

## 프로토콜 (요약)

클라이언트 → 서버:
- `{type:"create_room"}`
- `{type:"join_room", code:"ABCD"}`
- `{type:"queue_join"}` / `{type:"queue_leave"}`
- `{type:"move", row, col}`
- `{type:"rematch"}`
- `{type:"leave_room"}`

서버 → 클라이언트:
- `{type:"room_created", code}`
- `{type:"queue_waiting"}`
- `{type:"game_start", you, opponent, turn, board}`
- `{type:"move", row, col, color, turn?}`
- `{type:"game_over", winner, line}`
- `{type:"rematch_pending", who}`
- `{type:"opponent_left"}`
- `{type:"error", message}`

## Stage 2 (나중)

- FE는 GitHub Pages `/Brian/omok/`로 분리 배포
- 이 서버는 wss:// 지원하는 호스트(Render/Railway/Fly.io 등)에 배포
- FE에서 `location.hostname`으로 환경 감지하여 WS URL 자동 전환
