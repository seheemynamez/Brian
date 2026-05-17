// ============================================================
// 클라이언트 전역 상태 (단순 객체 — 다른 모듈에서 읽고 변경)
// ============================================================

export const BOARD_SIZE = 15;

export const emptyBoard = () =>
  Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(0));

// 게임 중 상호작용 이모트 — 서버 화이트리스트와 동일 (key 기준 검증).
// 표시용 emoji/text는 클라가 가지고 있어서 picker UI 빌드에 사용.
export const EMOTES = [
  { key: 'easy',     emoji: '😏', text: 'Easy' },
  { key: 'cute',     emoji: '🥺', text: 'Cute move' },
  { key: 'nice_try', emoji: '😅', text: 'Nice try' },
  { key: 'sure',     emoji: '🤔', text: 'You sure?' },
  { key: 'gg',       emoji: '🫡', text: 'GG' },
  { key: 'again',    emoji: '🔁', text: 'Again?' },
  { key: 'try_me',   emoji: '😤', text: 'Try me' },
  { key: 'free_win', emoji: '💸', text: 'Free win?' },
];

export const state = {
  ws: null,
  connected: false,
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

  // 양 플레이어
  nicknames: { black: '', white: '' },
  myNick: '',

  // 역할
  role: null,                    // 'player' | 'spectator' | null
  spectators: [],                // string[]

  // 타이머
  turnDeadline: null,
  timerTickHandle: null,

  // 오디오
  muted: localStorage.getItem('omok_muted') === '1',

  // 로비
  onlineCount: 0,
  roomsList: [],

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
