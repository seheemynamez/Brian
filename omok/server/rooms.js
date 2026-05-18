// ============================================================
// 방·큐·세션·관전자·온라인 카운트 상태 + 헬퍼
// ============================================================

const crypto = require('crypto');
const { emptyBoard } = require('./game-logic');
const connections = require('./connections');

const MAX_NICK_LEN = 12;

const rooms = new Map();      // code -> Room
//
// 자동 매칭 대기 큐. 항목: { connectionId, clientId, nickname, joinedAt }.
// connectionId 가 unique key — handler 가 ws 가 아니라 connectionId 로 enqueue/dequeue.
// 송신/타이머는 connections.getWsByConnectionId 로 ws 를 매번 resolve.
// (이슈 #31 PR #2 — queue 에서 ws 객체 제거)
const queue = [];
//
// sessionId → {
//   role:        'player' | 'spectator',
//   code:        roomCode,
//   color?:      'black' | 'white'  (player only),
//   clientId?:   localStorage UUID  (사람) | '_bot_easy/_medium/_hard'  (봇),
//   nickname:    string,
//   lastSeenAt:  ms epoch
// }
//
// 이슈 #31: 도메인 상태의 unique key 로 ws 를 쓰지 않기 위해 session 정보 풍부화.
// player·spectator 모두 session 발급 가능.
const sessions = new Map();

let onlineCount = 0;

// ---- 접근자 ----
const getRoom    = (code) => rooms.get(code);
const setRoom    = (code, room) => rooms.set(code, room);
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
};
// 세션 lastSeenAt 갱신 — heartbeat / 메시지 수신 시 호출.
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
};
const dequeueByConnectionId = (cid) => {
  if (!cid) return null;
  const i = queue.findIndex((e) => e.connectionId === cid);
  if (i < 0) return null;
  return queue.splice(i, 1)[0];
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
// 이슈 #31 Phase 1: room.players 가 ws 가 아니라 metadata object 만 보유.
// 도메인 상태 (room) 와 transport (ws) 분리. JSON 직렬화 가능한 shape 으로 한 걸음 더.
const createRoom = (code) => ({
  code,
  // gameId — startGame 시마다 새로 발급. 재대국마다 변경. 랭킹/통계 사전 작업.
  gameId: null,
  // 플레이어 슬롯 — color → PlayerSlot | null.
  //   PlayerSlot = {
  //     sessionId, playerId, clientId, nickname, type: 'human'|'bot', difficulty?
  //   }
  // 송신은 sendToPlayer(room, color, msg) → connections.getWsBySessionId 으로 매번 resolve.
  players: { black: null, white: null },
  // 관전자 sessionId 단독. 같은 clientId 의 멀티탭은 attachSpectatorSession 이 동일 sessionId
  // 1개로만 카운트.
  spectatorSessionIds: new Set(),
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
  // 봇 게임 표시 — 봇이 들어있는 방. 사람만의 게임은 false.
  hasBot: false,
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
  sessions.set(sid, {
    role: 'player',
    code: room.code,
    color,
    clientId: slot.clientId,
    nickname: slot.nickname,
    type,
    ...(type === 'bot' && { difficulty }),
    lastSeenAt: Date.now(),
  });
  if (ws && type === 'human') connections.bindSession(ws, sid);
  room.players[color] = slot;
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
  sessions.set(sid, {
    role: 'spectator',
    code: room.code,
    color: null,
    clientId: ws.clientId || null,
    nickname: ws.nickname || '',
    lastSeenAt: Date.now(),
  });
  room.spectatorSessionIds.add(sid);
  connections.bindSession(ws, sid);
  return { sid, droppedOldSid, droppedOldWs };
};

module.exports = {
  MAX_NICK_LEN,
  getRoom, setRoom, deleteRoom, getRoomsList,
  getSession, dropSession, touchSession,
  getQueue, enqueue, dequeueByConnectionId,
  incrementOnline, decrementOnline, getOnline,
  genCode, genSessionId, genGameId, sanitizeNick,
  createRoom, createPlayerSession, clearPlayerSession, attachSpectatorSession,
};
