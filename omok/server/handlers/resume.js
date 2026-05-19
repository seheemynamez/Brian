// ============================================================
// 세션 재개 — resume_session.
// player 세션 / spectator 세션 둘 다 처리.
// ============================================================

const {
  getRoom, getSession, dropSession, sanitizeNick,
} = require('../domain/rooms');
const connections = require('../connections');
const roomRuntime = require('../domain/room-runtime');
const {
  send, sendToPlayer, forEachSpectatorWs,
  playerStatusPayload,
} = require('./send');
const { getSpectatorNames, addSpectator } = require('./spectator');
const log = require('../infra/log');

const otherColor = (c) => (c === 'black' ? 'white' : 'black');

const onResumeSession = (ws, msg) => {
  if (ws.roomCode) return;
  const sid = msg.sessionId;
  if (typeof sid !== 'string') return send(ws, { type: 'resume_failed', reason: 'invalid_session' });
  const sess = getSession(sid);
  if (!sess) return send(ws, { type: 'resume_failed', reason: 'not_found' });
  const room = getRoom(sess.code);
  if (!room) {
    dropSession(sid);
    return send(ws, { type: 'resume_failed', reason: 'not_found' });
  }
  // spectator 세션 복구 — 같은 방으로 다시 합류시킨다.
  // 단, 이미 같은 clientId 의 다른 ws 가 관전 중이라면 attachSpectatorSession 가 이전 sid 를 청소.
  if (sess.role === 'spectator') {
    // 기존 sid 는 새 sid 로 교체되어야 하므로 일단 정리 (oldRoom 에서도 제거).
    room.spectatorSessionIds.delete(sid);
    dropSession(sid);
    if (msg.nickname) ws.nickname = sanitizeNick(msg.nickname) || sess.nickname || '익명';
    else ws.nickname = sess.nickname || '익명';
    if (sess.clientId) connections.bindClient(ws, sess.clientId);
    addSpectator(ws, room, ws.nickname);
    log.event('session_resumed', { sid: log.mask(sid), code: room.code, role: 'spectator' });
    return;
  }
  // player resume — slot 의 sessionId 는 sid 그대로 유지. ws 만 새로 바인딩.
  const slot = room.players[sess.color];
  if (!slot) {
    // 옛 slot 이 사라진 비정상 상황 (방 폐쇄 직전 등) — 실패로 처리.
    return send(ws, { type: 'resume_failed', reason: 'not_found' });
  }
  roomRuntime.clearDisconnectTimer(room.code, sess.color);
  ws.roomCode = room.code;
  ws.color = sess.color;
  ws.role = 'player';
  connections.bindSession(ws, sid);
  if (sess.clientId) connections.bindClient(ws, sess.clientId);
  if (msg.nickname) {
    const n = sanitizeNick(msg.nickname) || slot.nickname;
    slot.nickname = n;
    ws.nickname = n;
  } else {
    ws.nickname = slot.nickname;
  }
  const oppColor = otherColor(sess.color);
  sendToPlayer(room, oppColor, { type: 'opponent_reconnected', color: sess.color });
  forEachSpectatorWs(room, (sWs) => send(sWs, { type: 'opponent_reconnected', color: sess.color }));
  // 봇 게임은 disconnect 시 turn timer + 봇 schedule 멈춰뒀음 (disconnect.js).
  // resume 시 사용자가 다시 둘 수 있게 turn timer 새로 시작 + 봇 차례면 봇 schedule.
  // Lazy require — game/bot 이 resume 을 간접 참조할 수 있어 circular 회피.
  if (room.hasBot && room.status === 'playing') {
    const { startTurnTimer } = require('./game');
    const { getBotColor, scheduleBotMove } = require('./bot');
    startTurnTimer(room);
    const botColor = getBotColor(room);
    if (botColor && room.turn === botColor) scheduleBotMove(room);
  }
  const { buildPlayerRatings } = require('../domain/users');
  send(ws, {
    type: 'resume_success',
    code: room.code,
    gameId: room.gameId,
    you: sess.color,
    opponent: oppColor,
    sessionId: sid,
    board: room.board,
    turn: room.turn,
    nicknames: { black: room.players.black?.nickname || '', white: room.players.white?.nickname || '' },
    ratings: buildPlayerRatings(room),
    playerStatus: playerStatusPayload(room),
    status: room.status,
    winner: room.winner,
    line: room.winLine,
    lastMove: room.lastMove,
    turnDeadline: room.turnDeadline || null,
    spectators: getSpectatorNames(room),
  });
  log.event('session_resumed', { sid: log.mask(sid), code: room.code, color: sess.color });
};

module.exports = { onResumeSession };
