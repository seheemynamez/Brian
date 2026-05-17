// ============================================================
// 방·큐·세션·관전자·온라인 카운트 상태 + 헬퍼
// ============================================================

const crypto = require('crypto');
const { emptyBoard } = require('./game-logic');

const MAX_NICK_LEN = 12;

const rooms = new Map();      // code -> Room
const queue = [];             // WS[] (자동 매칭 대기)
const sessions = new Map();   // sessionId -> { code, color }

let onlineCount = 0;

// ---- 접근자 ----
const getRoom    = (code) => rooms.get(code);
const setRoom    = (code, room) => rooms.set(code, room);
const deleteRoom = (code) => {
  const room = rooms.get(code);
  if (room) {
    for (const sid of room.sessionIds) dropSession(sid);
  }
  rooms.delete(code);
};

// 로비 표시용 방 목록 요약 — 'over' 는 곧 사라질 상태라 굳이 노출하지 않음
const getRoomsList = () => {
  const out = [];
  for (const [code, room] of rooms) {
    if (room.status !== 'waiting' && room.status !== 'playing') continue;
    out.push({
      code,
      status: room.status,
      nicknames: { black: room.nicknames[0] || '', white: room.nicknames[1] || '' },
      spectatorCount: room.spectators.size,
    });
  }
  return out;
};

const getSession  = (sid) => sessions.get(sid);
const dropSession = (sid) => { if (sid) sessions.delete(sid); };

const getQueue = () => queue;
const enqueue  = (ws) => { if (!queue.includes(ws)) queue.push(ws); };
const dequeue  = (ws) => {
  const i = queue.indexOf(ws);
  if (i >= 0) queue.splice(i, 1);
};

const incrementOnline = () => ++onlineCount;
const decrementOnline = () => (onlineCount = Math.max(0, onlineCount - 1));
const getOnline       = () => onlineCount;

// ---- 코드 / 세션 ID 생성 ----
const genCode = () => {
  // 헷갈리는 문자(O, 0, I, 1, L) 제외
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
};

const genSessionId = () => crypto.randomBytes(12).toString('base64url');

const sanitizeNick = (nick) => {
  if (typeof nick !== 'string') return '';
  return nick.trim().slice(0, MAX_NICK_LEN);
};

// ---- 방 객체 / 세션 부착 ----
const createRoom = (code) => ({
  code,
  players: [null, null],          // 0 = black, 1 = white
  nicknames: ['', ''],            // 0 = black nick, 1 = white nick
  sessionIds: [null, null],
  spectators: new Set(),          // Set<WS>
  board: emptyBoard(),
  turn: 'black',
  turnDeadline: 0,
  turnTimer: null,
  status: 'waiting',              // waiting | playing | over
  winner: null,
  winLine: null,
  lastMove: null,
  rematchVotes: new Set(),
  loser: null,                    // 다음 판 선공 결정용
  disconnectTimers: { black: null, white: null },
});

const attachSession = (ws, room, color) => {
  const sid = genSessionId();
  ws.sessionId = sid;
  const idx = color === 'black' ? 0 : 1;
  room.sessionIds[idx] = sid;
  sessions.set(sid, { code: room.code, color });
  return sid;
};

module.exports = {
  MAX_NICK_LEN,
  getRoom, setRoom, deleteRoom, getRoomsList,
  getSession, dropSession,
  getQueue, enqueue, dequeue,
  incrementOnline, decrementOnline, getOnline,
  genCode, genSessionId, sanitizeNick,
  createRoom, attachSession,
};
