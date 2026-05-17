// ============================================================
// 클라이언트 전역 상태 (단순 객체 — 다른 모듈에서 읽고 변경)
// ============================================================

export const BOARD_SIZE = 15;

export const emptyBoard = () =>
  Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(0));

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
};
