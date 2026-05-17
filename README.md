# Brian

브라우저에서 바로 즐기는 미니 게임 모음 레포입니다.

- 🌐 라이브: https://seheemynamez.github.io/Brian/
- 🧩 게임:
  - [2048](https://seheemynamez.github.io/Brian/2048/) — 클래식 슬라이드 퍼즐 (싱글 플레이)
  - [오목대전](https://seheemynamez.github.io/Brian/omok/) — 실시간 멀티플레이 오목 (방 코드 / 랜덤 매칭 / 관전)

---

## 디렉토리 구조

```
Brian/
├── 2048/             # 2048 게임 — 정적 파일만 (HTML/CSS/JS)
├── omok/             # 오목대전
│   ├── index.html    # 진입 페이지
│   ├── css/          # base / components / screens 로 분리
│   ├── js/           # ES Modules (main, net, ui, board, state, sound)
│   └── server/       # WebSocket + 정적 서빙 (Node.js)
├── render.yaml       # Render 배포 설정 (omok 서버용)
├── .nojekyll         # GitHub Pages 가 그대로 서빙하도록
└── README.md
```

---

## 스택

| 영역 | 사용 기술 |
|---|---|
| 프론트엔드 (공통) | HTML, CSS, **Vanilla JavaScript (ES Modules)** — 빌드 도구 없음 |
| 오목 보드 렌더링 | HTML Canvas |
| 오목 실시간 통신 | WebSocket (`wss://`) |
| 오목 서버 | Node.js 18+, [`ws`](https://github.com/websockets/ws) 라이브러리 |
| 서버 상태 저장 | **인메모리** (Map / Set) — DB 없음. 재시작하면 진행 중인 방은 사라짐 |

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
│  - UI, 보드 그리기            │   WebSocket     │  - 방/큐/세션 관리            │
│  - WebSocket 클라이언트       │                 │  - 게임 룰 검증, 승패 판정   │
└──────────────────────────────┘                 └──────────────────────────────┘
```

- **호스트에 따라 자동 전환**: GitHub Pages 도메인에서 열리면 Render 서버로, 그 외(로컬·LAN) 에서는 같은 호스트로 연결합니다 ([omok/js/net.js](omok/js/net.js)).
- **Origin 잠금**: 프로덕션에서는 환경변수 `ALLOWED_ORIGINS` 로 GitHub Pages 도메인만 허용합니다.
- **재연결**: 세션 ID 를 URL 해시에 저장해두고, 새로고침/네트워크 끊김 시 30 초 이내에 자동 복구합니다.

### WebSocket 프로토콜 (요약)

클라이언트 → 서버
- `create_room` / `join_room` / `spectate_room`
- `queue_join` / `queue_leave` (랜덤 매칭)
- `move` (착수) / `rematch` / `leave_room` / `resume_session`

서버 → 클라이언트
- `room_created` / `matched` / `game_start` / `spectate_success`
- `move` / `turn_started` / `turn_skipped` / `game_over`
- `opponent_disconnected` / `opponent_reconnected` / `opponent_left` / `opponent_abandoned`
- `online_count` / `spectator_list` / `error`

자세한 내용은 [omok/server/README.md](omok/server/README.md) 참고.

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

---

## 배포

### 프론트엔드 — GitHub Pages
- `main` 브랜치의 루트가 그대로 https://seheemynamez.github.io/Brian/ 에 올라갑니다.
- `.nojekyll` 파일로 Jekyll 처리를 끄고, 폴더 구조 그대로 서빙합니다.
- 푸시하면 자동 재배포됩니다.

### 오목 서버 — Render (Blueprint)
- [`render.yaml`](render.yaml) 한 파일로 정의돼 있어, Render 대시보드에서 New → Blueprint → 이 레포 선택 → Connect 하면 끝납니다.
- `main` 에 push 할 때마다 자동 재배포.
- 무료 플랜이라 15 분 무활동 시 sleep 됩니다 (첫 접속 시 30 초 정도 콜드스타트).
- 리전: `singapore` (한국에서 가장 가까움).
- 환경변수: `ALLOWED_ORIGINS=https://seheemynamez.github.io`.

배포된 서버 주소는 [omok/js/net.js](omok/js/net.js) 의 `PROD_WS_URL` 에 박혀 있습니다.
