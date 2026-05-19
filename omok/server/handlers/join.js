// ============================================================
// 방 입장 — join_room / spectate_room.
// clientId 매치되면 player resume, 그 외엔 관전자 / 자리 채움.
// ============================================================

const { getRoom, sanitizeNick, createPlayerSession } = require('../domain/rooms');
const connections = require('../connections');
const roomRuntime = require('../domain/room-runtime');
const {
  send, sendToPlayer, forEachSpectatorWs,
  playerStatusPayload,
} = require('./send');
const { getSpectatorNames, addSpectator } = require('./spectator');
const log = require('../infra/log');

const otherColor = (c) => (c === 'black' ? 'white' : 'black');

// player slot 의 clientId 와 매치되는 사람 슬롯을 찾음. 봇 슬롯은 제외.
const findPlayerColorByClientId = (room, clientId) => {
  if (!clientId) return null;
  for (const color of ['black', 'white']) {
    const slot = room.players[color];
    if (slot && slot.type === 'human' && slot.clientId === clientId) return color;
  }
  return null;
};

// clientId 매치된 player 자리로 새 ws 를 재합류. join_room / spectate_room / ?room=
// 어떤 경로로든 자기 방이면 이 함수로 곧바로 player resume.
// 옛 ws (같은 sessionId 의 활성 연결) 가 있으면 player_replaced 알림 후 정리.
const reclaimPlayerSlot = (ws, room, color, nicknameOverride) => {
  const slot = room.players[color];
  if (!slot) return false;
  const sid = slot.sessionId;
  // 옛 ws (같은 sid 의 활성 연결) 정리 — 다른 탭/기기에서 player 였던 경우.
  const oldWs = sid ? connections.getWsBySessionId(sid) : null;
  if (oldWs && oldWs !== ws) {
    send(oldWs, { type: 'player_replaced' });
    oldWs.roomCode = null;
    oldWs.color = null;
    oldWs.role = null;
    oldWs.sessionId = null;
  }
  // grace timer 정리 (이 player 가 끊겨있던 상태일 때)
  roomRuntime.clearDisconnectTimer(room.code, color);

  // ws 에 player state 세팅
  ws.roomCode = room.code;
  ws.color = color;
  ws.role = 'player';
  // slot 의 기존 sessionId 와 새 ws 바인딩 (옛 매핑 덮어쓰기).
  connections.bindSession(ws, sid);
  if (slot.clientId) connections.bindClient(ws, slot.clientId);

  // 닉네임 갱신
  if (nicknameOverride) {
    const n = sanitizeNick(nicknameOverride) || slot.nickname;
    slot.nickname = n;
    ws.nickname = n;
  } else {
    ws.nickname = slot.nickname;
  }

  // 상대 + 관전자에 reconnected 알림
  const oppColor = otherColor(color);
  sendToPlayer(room, oppColor, { type: 'opponent_reconnected', color });
  forEachSpectatorWs(room, (sWs) => send(sWs, { type: 'opponent_reconnected', color }));

  // 봇 게임은 disconnect 시 turn timer + 봇 schedule 멈춰뒀음 (disconnect.js).
  // reclaim 시 사용자가 다시 둘 수 있게 turn timer 새로 시작 + 봇 차례면 봇 schedule.
  // resume.js 와 동일한 로직.
  if (room.hasBot && room.status === 'playing') {
    const { startTurnTimer } = require('./game');
    const { getBotColor, scheduleBotMove } = require('./bot');
    startTurnTimer(room);
    const botColor = getBotColor(room);
    if (botColor && room.turn === botColor) scheduleBotMove(room);
  }

  // resume_success 페이로드로 응답 — FE 의 기존 onResumeSuccess 가 처리해 game 화면 전환.
  send(ws, {
    type: 'resume_success',
    code: room.code,
    gameId: room.gameId,
    you: color,
    opponent: oppColor,
    sessionId: sid,
    board: room.board,
    turn: room.turn,
    nicknames: { black: room.players.black?.nickname || '', white: room.players.white?.nickname || '' },
    playerStatus: playerStatusPayload(room),
    status: room.status,
    winner: room.winner,
    line: room.winLine,
    lastMove: room.lastMove,
    turnDeadline: room.turnDeadline || null,
    spectators: getSpectatorNames(room),
  });
  log.event('player_reclaimed', { code: room.code, color, client: log.mask(ws.clientId) });
  return true;
};

const onJoinRoom = (ws, msg) => {
  if (ws.roomCode) return send(ws, { type: 'error', message: '이미 방에 있어요' });
  if (typeof msg.code !== 'string') return send(ws, { type: 'error', message: '방 코드를 입력하세요' });
  const code = msg.code.toUpperCase().trim();
  const room = getRoom(code);
  if (!room) return send(ws, { type: 'error', message: '존재하지 않는 방 코드예요' });

  const { onQueueLeave } = require('./queue');

  // clientId 가 player slot 과 매치되면 player 자리로 재합류 (어떤 경로로건 자기 방이면 player).
  const reclaimColor = findPlayerColorByClientId(room, ws.clientId);
  if (reclaimColor) {
    onQueueLeave(ws);
    reclaimPlayerSlot(ws, room, reclaimColor, msg.nickname);
    return;
  }

  // 두 자리 모두 차 있으면 관전자로
  if (room.players.black && room.players.white) {
    onQueueLeave(ws);
    addSpectator(ws, room, msg.nickname);
    return;
  }
  // 방장 슬롯이 비어있다면 (grace 만료 등으로 방이 곧 폐쇄될 상태) join 거부
  if (!room.players.black) {
    return send(ws, { type: 'error', message: '방장이 잠시 자리를 비웠어요. 잠시 후 다시 시도해주세요' });
  }
  onQueueLeave(ws);
  const nickname = sanitizeNick(msg.nickname) || '익명';
  ws.roomCode = code;
  ws.color = 'white';
  ws.role = 'player';
  ws.nickname = nickname;
  createPlayerSession(room, 'white', {
    type: 'human', ws, clientId: ws.clientId || null, nickname,
  });
  // Lazy require — game.js 가 spectator/bot 모듈을 require 하므로 cycle 회피.
  const { startGame } = require('./game');
  startGame(room);
};

const onSpectateRoom = (ws, msg) => {
  if (ws.roomCode) return send(ws, { type: 'error', message: '이미 방에 있어요' });
  if (typeof msg.code !== 'string') return send(ws, { type: 'error', message: '방 코드를 입력하세요' });
  const code = msg.code.toUpperCase().trim();
  const room = getRoom(code);
  if (!room) return send(ws, { type: 'error', message: '존재하지 않는 방 코드예요' });
  const { onQueueLeave } = require('./queue');
  // 자기 방이면 spectator 의도더라도 player 재합류 (이슈: 모바일 사용자가 [관전만] 눌러도
  // 자기 player 자리로 자동 이동되길 원함).
  const reclaimColor = findPlayerColorByClientId(room, ws.clientId);
  if (reclaimColor) {
    onQueueLeave(ws);
    reclaimPlayerSlot(ws, room, reclaimColor, msg.nickname);
    return;
  }
  onQueueLeave(ws);
  addSpectator(ws, room, msg.nickname);
};

module.exports = {
  findPlayerColorByClientId,
  reclaimPlayerSlot,
  onJoinRoom,
  onSpectateRoom,
};
