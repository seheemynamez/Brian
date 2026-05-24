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
  disconnectStatePayload,
  bothPlayersOnline,
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
  // 옛 ws (좀비 — 비행기모드 등으로 close 가 지연된 경우) 가 같은 sid 에 바인딩돼 있으면
  // 정리. 그렇지 않으면 옛 ws 의 뒤늦은 close 이벤트가 onPlayerDisconnect 를 다시
  // trigger 해서 grace timer 가 재시작되고, 정상 게임 중인 새 ws 가 패배 처리됨.
  const oldWs = connections.getWsBySessionId(sid);
  if (oldWs && oldWs !== ws) {
    oldWs.roomCode = null;
    oldWs.color = null;
    oldWs.role = null;
    oldWs.sessionId = null;
  }
  ws.roomCode = room.code;
  ws.color = sess.color;
  ws.role = 'player';
  connections.bindSession(ws, sid);
  if (sess.clientId) connections.bindClient(ws, sess.clientId);
  if (msg.nickname) {
    const n = sanitizeNick(msg.nickname) || slot.nickname;
    // SANITY — 봇 slot 의 nickname 을 사람 입력으로 덮어쓰는 path 는 존재하면 안 됨.
    if (slot.type === 'bot') {
      log.warn('bot_nickname_warn', {
        src: 'resume',
        code: room.code, color: sess.color, botClientId: slot.clientId,
        wsClientId: sess.clientId, attemptedNickname: n,
      });
    } else {
      slot.nickname = n;
    }
    ws.nickname = n;
  } else {
    ws.nickname = slot.nickname;
  }
  const oppColor = otherColor(sess.color);
  // 남은 grace 정보 같이 보냄 — 양쪽 동시 끊긴 케이스 또는 다른 색 grace 진행
  // 중인 경우 client 가 그 색의 카운트다운 UI 유지 (PR — Issue: 한 쪽 reconnect
  // 시 다른 쪽 grace UI 까지 잘못 cancel 되던 버그 fix).
  const reconnectPayload = {
    type: 'opponent_reconnected',
    color: sess.color,
    ...disconnectStatePayload(room),
  };
  sendToPlayer(room, oppColor, reconnectPayload);
  forEachSpectatorWs(room, (sWs) => send(sWs, reconnectPayload));
  // 봇 게임 / PVP 모두 disconnect 시 turn timer 동결됨 (disconnect.js → pauseTurnTimer).
  // resume 시 양쪽 다 online 일 때만 turn timer 재개 — PVP 는 한 쪽만 reconnect 한 상태면
  // 다른 쪽 reconnect 까지 timer 안 시작. 봇 게임은 봇이 항상 online 이라 사람 reconnect 즉시 재개.
  // resumeTurnTimer 는 pauseTurnTimer 가 저장한 turnRemainMs (남은 시간) 으로 재개 →
  // 새로고침 시 카운트다운 초기화 X.
  if (room.status === 'playing') {
    const { bothPlayersOnline } = require('./send');
    if (bothPlayersOnline(room)) {
      const { resumeTurnTimer } = require('./game');
      resumeTurnTimer(room);
      if (room.hasBot) {
        const { getBotColor, scheduleBotMove } = require('./bot');
        const botColor = getBotColor(room);
        if (botColor && room.turn === botColor) scheduleBotMove(room);
      }
    }
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
    ...disconnectStatePayload(room),  // disconnectGraceMs + (진행 중 시) disconnectDeadlines
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
