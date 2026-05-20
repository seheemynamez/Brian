// ============================================================
// 클라이언트 전역 상태 (단순 객체 — 다른 모듈에서 읽고 변경)
// ============================================================

export const BOARD_SIZE = 15;

export const emptyBoard = () =>
  Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(0));

// 게임 중 상호작용 이모트 — 서버 화이트리스트와 동일 (key 기준 검증).
// 표시용 emoji/text는 클라가 가지고 있어서 picker UI 빌드에 사용.
// 순서가 picker에 그대로 노출됨 — 인사 → 견제 → 게임 중 반응 → 마무리 흐름.
export const EMOTES = [
  { key: 'hi',        emoji: '👋', text: 'Hi' },
  { key: 'tick_tock', emoji: '⏰', text: 'Tick-tock' },
  { key: 'hmm',       emoji: '🤔', text: 'Hmm..' },
  { key: 'oops',      emoji: '🫢', text: 'Oops' },
  { key: 'easy',      emoji: '😏', text: 'Easy' },
  { key: 'sure',      emoji: '🤨', text: 'You sure?' },
  { key: 'please',    emoji: '🥺', text: 'Please..' },
  { key: 'wow',       emoji: '😳', text: 'WOW' },
  { key: 'gg',        emoji: '🫡', text: 'GG' },
  { key: 'again',     emoji: '🔁', text: 'Again?' },
];

export const state = {
  ws: null,
  connected: false,
  serverRestarting: false,       // server_restarting 메시지를 받은 직후 close 시 overlay 메시지 유지용
  screenState: 'lobby',          // lobby | waiting | game

  // 게임
  board: emptyBoard(),
  myColor: null,                 // 'black' | 'white' | null
  currentTurn: null,
  winLine: null,
  lastMove: null,
  gameOver: false,

  // 방/세션
  currentRoomCode: null,
  waitingMode: null,             // 'room' | 'queue'
  sessionId: null,
  // 직접 링크(?room=) 진입 모달에서 확정했지만 WS 가 아직 열리지 않은 경우 임시 보관
  pendingDirectJoin: null,       // { type: 'join_room', code, nickname } | null
  // main.js setupBotGame 가 채워주는 모달 오프너 — net.js 의 bot_offer 디스패치가 호출
  openBotGameModal: null,        // ((mode: 'lobby' | 'offer') => void) | null

  // 양 플레이어
  nicknames: { black: '', white: '' },
  ratings: { black: null, white: null },  // game_start 시점의 rating. 게임 화면 티어 표시용.
  // 종료 시 변동분 — game_over payload 의 deltas. 종료 화면에 "1500 → 1490 (-10)" 표시용.
  // 게임 새로 시작하면 null 로 reset (state 잔존 방지).
  lastRatingDeltas: null,
  myNick: '',
  // 양 플레이어의 connection 상태 — 게임 화면의 online indicator 용.
  // 'online' | 'offline'. game_start/resume_success/spectate_success 시 서버가 동기화.
  // opponent_disconnected/reconnected 로도 실시간 업데이트.
  playerStatus: { black: 'online', white: 'online' },

  // 역할
  role: null,                    // 'player' | 'spectator' | null
  spectators: [],                // string[]

  // 타이머
  turnDeadline: null,
  timerTickHandle: null,
  // 서버가 turn_started 에 보내주는 timeout 총 길이 (ms).
  // 클라이언트 시계가 서버보다 빠를 때 deadline-clientNow > timeout 이라 "31초"
  // 표시되는 케이스 방지용 — 매 tick 시 remainMs 를 이 값으로 cap.
  turnTimeoutMs: 30_000,
  // 상대가 끊긴 상태에서 grace 안에 복귀해야 하는 deadline.
  // opponent_disconnected.deadline 으로 set, opponent_reconnected 시 null.
  // 값이 있으면 turn timer 는 일시정지 + 이 deadline 으로 카운트다운 표시.
  disconnectDeadline: null,
  // 서버 grace 총 길이 (ms) — 시계 skew 로 "61초" 표시 방지 cap 용. 기본 60s.
  disconnectGraceMs: 60_000,

  // 오디오
  muted: localStorage.getItem('omok_muted') === '1',

  // 로비
  onlineCount: 0,
  roomsList: [],
  ranking: [],                   // [{ clientId, nickname, rating, tier, wins, losses, draws, isBot }]
  recentGames: [],               // [{ gameId, endedAt, winner, reason, isBot, black, white }]

  // 영구 클라이언트 ID — 같은 브라우저는 같은 ID. 서버에서 자기 자신끼리 매칭되는 것을 막는 용도.
  clientId: (() => {
    let id = localStorage.getItem('omok_client_id');
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(36).slice(2));
      localStorage.setItem('omok_client_id', id);
    }
    return id;
  })(),
};
