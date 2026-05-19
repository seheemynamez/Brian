// ============================================================
// 방·큐·세션·관전자·온라인 카운트 상태 + 헬퍼
// ============================================================

const crypto = require('crypto');
const { emptyBoard } = require('./game-logic');
const connections = require('./connections');
const { getStore } = require('./store');

const MAX_NICK_LEN = 12;

// 도메인 state 는 store 가 보관. backend 가 'memory' 면 in-process Map / Array,
// 'valkey' 면 메모리 cache + Aiven 등 외부 redis-compat 으로 write-through.
// (인터페이스는 Map / Array 와 동일해서 backend 교체에도 호출 측 코드 안 변함.)
const store = getStore();
const rooms = store.rooms;        // code -> Room
const queue = store.queue;        // [{ connectionId, clientId, nickname, joinedAt, ... }]
const sessions = store.sessions;  // sessionId -> { role, code, color?, clientId, nickname, lastSeenAt, ... }

let onlineCount = 0;

// ---- 접근자 ----
// 모든 write 는 메모리 cache + (valkey backend 면) 외부 store 둘 다 동기 (write-through).
// memory backend 에선 persist* 가 no-op.
const getRoom    = (code) => rooms.get(code);
const setRoom    = (code, room) => {
  rooms.set(code, room);
  store.persistRoom(code, room);
};
const deleteRoom = (code) => {
  const room = rooms.get(code);
  if (room) {
    for (const color of ['black', 'white']) {
      const slot = room.players?.[color];
      if (slot?.sessionId) dropSession(slot.sessionId);
    }
    for (const sid of room.spectatorSessionIds || []) dropSession(sid);
  }
  rooms.delete(code);
  store.deleteRoomFromStore(code);
};

// room 의 in-place mutation (board, status, turn 등) 후 호출 — store 에 sync.
const markRoomDirty = (room) => {
  if (!room || !room.code) return;
  store.persistRoom(room.code, room);
};

// 로비 표시용 방 목록 요약 — 'over' 는 곧 사라질 상태라 굳이 노출하지 않음
const getRoomsList = () => {
  const out = [];
  for (const [code, room] of rooms) {
    if (room.status !== 'waiting' && room.status !== 'playing') continue;
    out.push({
      code,
      status: room.status,
      nicknames: {
        black: room.players.black?.nickname || '',
        white: room.players.white?.nickname || '',
      },
      spectatorCount: room.spectatorSessionIds.size,
    });
  }
  return out;
};

const getSession  = (sid) => sessions.get(sid);
const dropSession = (sid) => {
  if (!sid) return;
  sessions.delete(sid);
  connections.unbindSession(sid);
  store.deleteSessionFromStore(sid);
};
// 세션 lastSeenAt 갱신 — heartbeat / 메시지 수신 시 호출.
// touchSession 은 자주 호출돼서 valkey sync 안 함 (lastSeenAt 정확도가 그렇게 중요하지 않음).
const touchSession = (sid) => {
  if (!sid) return;
  const sess = sessions.get(sid);
  if (sess) sess.lastSeenAt = Date.now();
};

const getQueue = () => queue;
// entry: { connectionId, clientId, nickname }
const enqueue = (entry) => {
  if (!entry || !entry.connectionId) return;
  if (queue.some((e) => e.connectionId === entry.connectionId)) return;
  queue.push(entry);
  store.persistQueue();
};
const dequeueByConnectionId = (cid) => {
  if (!cid) return null;
  const i = queue.findIndex((e) => e.connectionId === cid);
  if (i < 0) return null;
  const removed = queue.splice(i, 1)[0];
  store.persistQueue();
  return removed;
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
// 이슈 #31 Phase 1+4+5:
//   - players 는 ws 가 아니라 metadata object.
//   - timer handle, worker handle 같은 직렬화 불가능한 객체는 room-runtime.js 에 분리.
//   - room 자체는 (rematchVotes Set, spectatorSessionIds Set 만 제외하면) JSON 직렬화 가능.
const createRoom = (code) => ({
  code,
  // gameId — startGame 시마다 새로 발급. 재대국마다 변경. 랭킹/통계 사전 작업.
  gameId: null,
  // 플레이어 슬롯 — color → PlayerSlot | null.
  //   PlayerSlot = { sessionId, playerId, clientId, nickname, type, difficulty? }
  // 송신은 sendToPlayer(room, color, msg) → connections.getWsBySessionId 으로 매번 resolve.
  players: { black: null, white: null },
  // 관전자 sessionId 단독. 같은 clientId 의 멀티탭은 attachSpectatorSession 이 동일 sessionId 1개로만 카운트.
  spectatorSessionIds: new Set(),
  board: emptyBoard(),
  turn: 'black',
  turnDeadline: 0,
  status: 'waiting',              // waiting | playing | over
  winner: null,
  winLine: null,
  lastMove: null,
  rematchVotes: new Set(),
  loser: null,                    // 다음 판 선공 결정용
  hasBot: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

// Valkey 같은 store 에 저장하기 위한 직렬화 가능 형태로 변환.
// Set 들은 array 로 풀고, 비-직렬화 필드 (있다면) 는 제외.
const getSerializableRoomState = (room) => ({
  code: room.code,
  gameId: room.gameId,
  players: {
    black: room.players.black ? { ...room.players.black } : null,
    white: room.players.white ? { ...room.players.white } : null,
  },
  spectatorSessionIds: Array.from(room.spectatorSessionIds || []),
  board: room.board,
  turn: room.turn,
  turnDeadline: room.turnDeadline || 0,
  status: room.status,
  winner: room.winner,
  winLine: room.winLine,
  lastMove: room.lastMove,
  rematchVotes: Array.from(room.rematchVotes || []),
  loser: room.loser,
  hasBot: !!room.hasBot,
  createdAt: room.createdAt || 0,
  updatedAt: room.updatedAt || 0,
});

// 새 게임 시작마다 발급. 랭킹·통계 키.
const genGameId = () => crypto.randomBytes(10).toString('base64url');

// ---- player session ----
// 플레이어 슬롯 + 세션을 동시에 생성. 사람이면 ws.sessionId 와 connections 바인딩까지.
// type='bot' 이면 ws=null (봇은 transport 가 없음). slot 만 메모리에 둠.
const createPlayerSession = (room, color, opts) => {
  const { type, ws = null, clientId = null, playerId = null, nickname = '', difficulty = null } = opts;
  const sid = genSessionId();
  const slot = {
    sessionId: sid,
    playerId: playerId || clientId || null,
    clientId: clientId || null,
    nickname: nickname || '',
    type,
  };
  if (type === 'bot') slot.difficulty = difficulty;
  const sessData = {
    role: 'player',
    code: room.code,
    color,
    clientId: slot.clientId,
    nickname: slot.nickname,
    type,
    ...(type === 'bot' && { difficulty }),
    lastSeenAt: Date.now(),
  };
  sessions.set(sid, sessData);
  store.persistSession(sid, sessData);
  if (ws && type === 'human') connections.bindSession(ws, sid);
  room.players[color] = slot;
  store.persistRoom(room.code, room);
  return slot;
};

// 슬롯의 세션을 정리 (slot 자체는 caller 가 결정 — 보통 startGame 의 재발급 직전 또는 방 폐쇄 시).
const clearPlayerSession = (room, color) => {
  const slot = room.players[color];
  if (slot?.sessionId) dropSession(slot.sessionId);
};

// ---- spectator session ----
// 관전자는 clientId 당 1개의 sessionId 만 유지 (dedup) — 같은 사용자가 멀티탭으로
// 관전 시도하면 이전 세션을 정리.
// 호출자는 이미 ws.nickname / ws.clientId 가 세팅돼있다는 전제.
// 반환: { sid, droppedOldSid|null, droppedOldWs|null } — 호출자가 옛 ws 의 transient 상태(roomCode,
//        role 등) 를 정리하는 데 사용. dropSession 후엔 ws 조회가 불가하므로 미리 resolve.
const attachSpectatorSession = (ws, room) => {
  let droppedOldSid = null;
  let droppedOldWs = null;
  if (ws.clientId) {
    // 같은 clientId 의 기존 spectator 세션 있으면 제거
    for (const [sid, sess] of sessions) {
      if (sess.role === 'spectator' && sess.clientId === ws.clientId) {
        droppedOldSid = sid;
        break;
      }
    }
    if (droppedOldSid) {
      // dropSession 으로 ws 매핑이 정리되기 전에 미리 ws 조회.
      droppedOldWs = connections.getWsBySessionId(droppedOldSid) || null;
      const oldSess = sessions.get(droppedOldSid);
      if (oldSess) {
        const oldRoom = rooms.get(oldSess.code);
        if (oldRoom) oldRoom.spectatorSessionIds.delete(droppedOldSid);
      }
      dropSession(droppedOldSid);
    }
  }
  const sid = genSessionId();
  const sessData = {
    role: 'spectator',
    code: room.code,
    color: null,
    clientId: ws.clientId || null,
    nickname: ws.nickname || '',
    lastSeenAt: Date.now(),
  };
  sessions.set(sid, sessData);
  store.persistSession(sid, sessData);
  room.spectatorSessionIds.add(sid);
  connections.bindSession(ws, sid);
  store.persistRoom(room.code, room);
  return { sid, droppedOldSid, droppedOldWs };
};

module.exports = {
  MAX_NICK_LEN,
  getRoom, setRoom, deleteRoom, markRoomDirty, getRoomsList,
  getSession, dropSession, touchSession,
  getQueue, enqueue, dequeueByConnectionId,
  incrementOnline, decrementOnline, getOnline,
  genCode, genSessionId, genGameId, sanitizeNick,
  createRoom, createPlayerSession, clearPlayerSession, attachSpectatorSession,
  getSerializableRoomState,
};
