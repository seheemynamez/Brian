// ============================================================
// 관전자 헬퍼 — spectatorSessionIds 단일 source of truth.
// ============================================================

const {
  getRoom, markRoomDirty, getSession, dropSession,
  sanitizeNick, attachSpectatorSession,
} = require('../domain/rooms');
const connections = require('../connections');
const {
  send, forEachSpectatorWs, broadcastRoom,
  playerStatusPayload, disconnectStatePayload, broadcastRoomsList,
} = require('./send');

const SPECTATOR_DISCONNECT_GRACE_MS = Number(process.env.SPECTATOR_DISCONNECT_GRACE_MS) || 30000;

// spectatorSessionIds 를 단일 source of truth 로 사용. 닉네임은 활성 ws 가 있으면 거기서,
// 없으면 session 에 저장된 닉네임으로 fallback (재접속 grace 동안에도 표시 유지).
const getSpectatorNames = (room) => {
  const names = [];
  for (const sid of room.spectatorSessionIds) {
    const ws = connections.getWsBySessionId(sid);
    if (ws && ws.nickname) { names.push(ws.nickname); continue; }
    const sess = getSession(sid);
    if (sess) names.push(sess.nickname || '익명');
  }
  return names;
};

const broadcastSpectators = (room) => {
  broadcastRoom(room, { type: 'spectator_list', spectators: getSpectatorNames(room) });
};

const sendSpectatorState = (ws, room) => {
  // ws.sessionId 는 addSpectator 의 attachSpectatorSession 안에서 이미 세팅돼있음.
  // FE 가 sessionStorage 에 저장해서 reconnect 시 resume_session 으로 재합류.
  const { buildPlayerRatings } = require('../domain/users');
  send(ws, {
    type: 'spectate_success',
    code: room.code,
    sessionId: ws.sessionId || null,
    nicknames: { black: room.players.black?.nickname || '', white: room.players.white?.nickname || '' },
    ratings: buildPlayerRatings(room),
    playerStatus: playerStatusPayload(room),
    ...disconnectStatePayload(room),  // disconnectGraceMs + (진행 중 시) disconnectDeadlines
    board: room.board,
    turn: room.turn,
    status: room.status,
    winner: room.winner,
    line: room.winLine,
    lastMove: room.lastMove,
    turnDeadline: room.turnDeadline || null,
    spectators: getSpectatorNames(room),
  });
};

const addSpectator = (ws, room, nickname) => {
  ws.nickname = sanitizeNick(nickname) || '익명';
  ws.roomCode = room.code;
  ws.role = 'spectator';
  // 같은 clientId 의 이전 spectator 세션 정리 — 멀티탭으로 들어와도 한 자리만 차지.
  // attachSpectatorSession 안에서 옛 spectatorSessionIds 항목 + 세션 자체를 정리.
  const { sid, droppedOldWs } = attachSpectatorSession(ws, room);
  if (droppedOldWs && droppedOldWs !== ws) {
    // 옛 ws 가 다른 방을 관전 중이었다면 그 방의 spectator_list 도 갱신.
    if (droppedOldWs.roomCode) {
      const oldRoom = getRoom(droppedOldWs.roomCode);
      if (oldRoom && oldRoom !== room) broadcastSpectators(oldRoom);
    }
    // 옛 ws 에게 강제 정리됐음을 알림 (UI 가 적절히 처리).
    send(droppedOldWs, { type: 'spectator_replaced' });
    droppedOldWs.roomCode = null;
    droppedOldWs.role = null;
    droppedOldWs.sessionId = null;
  }
  sendSpectatorState(ws, room);
  broadcastSpectators(room);
  broadcastRoomsList();
  return sid;
};

const removeSpectator = (ws) => {
  if (ws.role !== 'spectator' || !ws.roomCode) return;
  const room = getRoom(ws.roomCode);
  const sid = ws.sessionId;
  // 명단에서는 즉시 제거 (다른 사용자에게 보여주는 spectator_list 갱신).
  if (room && sid) {
    room.spectatorSessionIds.delete(sid);
    markRoomDirty(room);
    broadcastSpectators(room);
  }
  // session 자체는 짧은 grace 동안 유지 — 새로고침 / 비행기모드 reconnect 시
  // resume_session 으로 복구 가능하게 함 (이슈: 봇 게임 관전 중 새로고침 시 만료 에러).
  // grace 만료 후 lazy drop. 그 사이 resume 되면 onResumeSession 의 spectator 분기가
  // dropSession 으로 정리.
  if (sid) {
    setTimeout(() => {
      const sess = getSession(sid);
      if (sess && sess.role === 'spectator') dropSession(sid);
    }, SPECTATOR_DISCONNECT_GRACE_MS).unref?.();
    ws.sessionId = null;
  }
  ws.roomCode = null;
  ws.role = null;
  broadcastRoomsList();
};

module.exports = {
  getSpectatorNames,
  broadcastSpectators,
  sendSpectatorState,
  addSpectator,
  removeSpectator,
};
