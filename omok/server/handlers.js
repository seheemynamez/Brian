// ============================================================
// WS 메시지 처리 + 차례 타이머 + 재연결 grace + 관전자 + 게임 흐름
// ============================================================

const {
  getRoom, setRoom, deleteRoom,
  getSession, dropSession,
  getQueue, enqueue, dequeue,
  getOnline,
  genCode, sanitizeNick,
  createRoom, attachSession,
} = require('./rooms');
const { emptyBoard, checkWin, isDraw, BOARD_SIZE } = require('./game-logic');

const TURN_TIMEOUT_MS       = Number(process.env.TURN_TIMEOUT_MS)       || 30000;
const DISCONNECT_GRACE_MS   = Number(process.env.DISCONNECT_GRACE_MS)   || 30000;

let wssRef = null;

const init = (wss) => { wssRef = wss; };

// ---- 송신 헬퍼 ----
const send = (ws, msg) => {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};

const broadcastRoom = (room, msg) => {
  for (const p of room.players) if (p) send(p, msg);
  for (const s of room.spectators) send(s, msg);
};

const broadcastOnlineCount = () => {
  if (!wssRef) return;
  const payload = JSON.stringify({ type: 'online_count', n: getOnline() });
  for (const c of wssRef.clients) {
    if (c.readyState === c.OPEN) c.send(payload);
  }
};

const colorIndex = (c) => (c === 'black' ? 0 : 1);
const otherColor = (c) => (c === 'black' ? 'white' : 'black');

// ============================================================
// 차례 타이머
// ============================================================
const startTurnTimer = (room) => {
  clearTurnTimer(room);
  room.turnDeadline = Date.now() + TURN_TIMEOUT_MS;
  room.turnTimer = setTimeout(() => onTurnTimeout(room), TURN_TIMEOUT_MS);
  broadcastRoom(room, { type: 'turn_started', turn: room.turn, deadline: room.turnDeadline });
};

const clearTurnTimer = (room) => {
  if (room.turnTimer) clearTimeout(room.turnTimer);
  room.turnTimer = null;
  room.turnDeadline = 0;
};

const onTurnTimeout = (room) => {
  if (room.status !== 'playing') return;
  const skipped = room.turn;
  room.turn = otherColor(room.turn);
  broadcastRoom(room, { type: 'turn_skipped', skipped, turn: room.turn });
  startTurnTimer(room);
};

// ============================================================
// 관전자 헬퍼
// ============================================================
const getSpectatorNames = (room) =>
  Array.from(room.spectators).map((s) => s.nickname || '익명');

const broadcastSpectators = (room) => {
  broadcastRoom(room, { type: 'spectator_list', spectators: getSpectatorNames(room) });
};

const sendSpectatorState = (ws, room) => {
  send(ws, {
    type: 'spectate_success',
    code: room.code,
    nicknames: { black: room.nicknames[0], white: room.nicknames[1] },
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
  room.spectators.add(ws);
  sendSpectatorState(ws, room);
  broadcastSpectators(room);
};

const removeSpectator = (ws) => {
  if (ws.role !== 'spectator' || !ws.roomCode) return;
  const room = getRoom(ws.roomCode);
  if (room) {
    room.spectators.delete(ws);
    broadcastSpectators(room);
  }
  ws.roomCode = null;
  ws.role = null;
};

// ============================================================
// 게임 시작/재시작 — 양쪽 플레이어 + 관전자 모두에게 알림
// ============================================================
const startGame = (room) => {
  for (const sid of room.sessionIds) dropSession(sid);
  room.sessionIds = [null, null];
  room.status = 'playing';
  room.board = emptyBoard();
  room.turn = 'black';
  room.winner = null;
  room.winLine = null;
  room.lastMove = null;
  room.rematchVotes.clear();
  room.loser = null;

  const sidBlack = attachSession(room.players[0], room, 'black');
  const sidWhite = attachSession(room.players[1], room, 'white');

  const base = {
    type: 'game_start',
    code: room.code,
    board: room.board,
    turn: room.turn,
    nicknames: { black: room.nicknames[0], white: room.nicknames[1] },
    spectators: getSpectatorNames(room),
  };
  send(room.players[0], { ...base, you: 'black', opponent: 'white', sessionId: sidBlack });
  send(room.players[1], { ...base, you: 'white', opponent: 'black', sessionId: sidWhite });
  for (const s of room.spectators) sendSpectatorState(s, room);

  startTurnTimer(room);
};

// ============================================================
// 메시지 디스패치
// ============================================================
const handleMessage = (ws, msg) => {
  switch (msg.type) {
    case 'create_room':    return onCreateRoom(ws, msg);
    case 'join_room':      return onJoinRoom(ws, msg);
    case 'spectate_room':  return onSpectateRoom(ws, msg);
    case 'queue_join':     return onQueueJoin(ws, msg);
    case 'queue_leave':    return onQueueLeave(ws);
    case 'resume_session': return onResumeSession(ws, msg);
    case 'move':           return onMove(ws, msg.row, msg.col);
    case 'rematch':        return onRematch(ws);
    case 'leave_room':     return onLeaveRoom(ws);
  }
};

const onCreateRoom = (ws, msg) => {
  if (ws.roomCode) return send(ws, { type: 'error', message: '이미 방에 있어요' });
  onQueueLeave(ws);
  const code = genCode();
  const room = createRoom(code);
  room.players[0] = ws;
  room.nicknames[0] = sanitizeNick(msg.nickname) || '익명';
  ws.roomCode = code;
  ws.color = 'black';
  ws.role = 'player';
  ws.nickname = room.nicknames[0];
  setRoom(code, room);
  send(ws, { type: 'room_created', code });
};

const onJoinRoom = (ws, msg) => {
  if (ws.roomCode) return send(ws, { type: 'error', message: '이미 방에 있어요' });
  if (typeof msg.code !== 'string') return send(ws, { type: 'error', message: '방 코드를 입력하세요' });
  const code = msg.code.toUpperCase().trim();
  const room = getRoom(code);
  if (!room) return send(ws, { type: 'error', message: '존재하지 않는 방 코드예요' });

  // 두 자리 모두 차 있으면 관전자로
  if (room.players[0] && room.players[1]) {
    onQueueLeave(ws);
    addSpectator(ws, room, msg.nickname);
    return;
  }
  onQueueLeave(ws);
  room.players[1] = ws;
  room.nicknames[1] = sanitizeNick(msg.nickname) || '익명';
  ws.roomCode = code;
  ws.color = 'white';
  ws.role = 'player';
  ws.nickname = room.nicknames[1];
  startGame(room);
};

const onSpectateRoom = (ws, msg) => {
  // 항상 관전 모드 (방이 안 차있어도 관전만)
  if (ws.roomCode) return send(ws, { type: 'error', message: '이미 방에 있어요' });
  if (typeof msg.code !== 'string') return send(ws, { type: 'error', message: '방 코드를 입력하세요' });
  const code = msg.code.toUpperCase().trim();
  const room = getRoom(code);
  if (!room) return send(ws, { type: 'error', message: '존재하지 않는 방 코드예요' });
  onQueueLeave(ws);
  addSpectator(ws, room, msg.nickname);
};

const onQueueJoin = (ws, msg) => {
  if (ws.roomCode) return send(ws, { type: 'error', message: '이미 방에 있어요' });
  ws.nickname = sanitizeNick(msg.nickname) || '익명';
  const q = getQueue();
  const idx = q.findIndex((w) => w !== ws && w.readyState === w.OPEN);
  if (idx >= 0) {
    const opponent = q.splice(idx, 1)[0];
    opponent.inQueue = false;
    const code = genCode();
    const room = createRoom(code);
    room.players[0] = opponent;
    room.nicknames[0] = opponent.nickname || '익명';
    opponent.roomCode = code; opponent.color = 'black'; opponent.role = 'player';
    room.players[1] = ws;
    room.nicknames[1] = ws.nickname;
    ws.roomCode = code; ws.color = 'white'; ws.role = 'player';
    setRoom(code, room);
    // 자동매칭 후에도 방 코드 부여 (관전자 모집용)
    send(opponent, { type: 'matched', code });
    send(ws,       { type: 'matched', code });
    startGame(room);
  } else {
    enqueue(ws);
    ws.inQueue = true;
    send(ws, { type: 'queue_waiting' });
  }
};

const onQueueLeave = (ws) => {
  dequeue(ws);
  ws.inQueue = false;
};

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
  const idx = colorIndex(sess.color);
  if (room.disconnectTimers[sess.color]) {
    clearTimeout(room.disconnectTimers[sess.color]);
    room.disconnectTimers[sess.color] = null;
  }
  room.players[idx] = ws;
  ws.roomCode = room.code;
  ws.color = sess.color;
  ws.sessionId = sid;
  ws.role = 'player';
  if (msg.nickname) {
    const n = sanitizeNick(msg.nickname) || room.nicknames[idx];
    room.nicknames[idx] = n;
    ws.nickname = n;
  } else {
    ws.nickname = room.nicknames[idx];
  }
  const opp = room.players[colorIndex(otherColor(sess.color))];
  if (opp) send(opp, { type: 'opponent_reconnected', color: sess.color });
  for (const s of room.spectators) send(s, { type: 'opponent_reconnected', color: sess.color });
  send(ws, {
    type: 'resume_success',
    code: room.code,
    you: sess.color,
    opponent: otherColor(sess.color),
    sessionId: sid,
    board: room.board,
    turn: room.turn,
    nicknames: { black: room.nicknames[0], white: room.nicknames[1] },
    status: room.status,
    winner: room.winner,
    line: room.winLine,
    lastMove: room.lastMove,
    turnDeadline: room.turnDeadline || null,
    spectators: getSpectatorNames(room),
  });
};

const onMove = (ws, row, col) => {
  if (!ws.roomCode || ws.role !== 'player') return;
  const room = getRoom(ws.roomCode);
  if (!room || room.status !== 'playing') return;
  if (room.turn !== ws.color) return send(ws, { type: 'error', message: '당신 차례가 아니에요' });
  if (typeof row !== 'number' || typeof col !== 'number') return;
  if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return;
  if (room.board[row][col] !== 0) return send(ws, { type: 'error', message: '이미 돌이 있어요' });

  const stone = ws.color === 'black' ? 1 : 2;
  room.board[row][col] = stone;
  room.lastMove = [row, col];

  const winLine = checkWin(room.board, row, col, ws.color);
  if (winLine) {
    room.status = 'over';
    room.winner = ws.color;
    room.winLine = winLine;
    room.loser = otherColor(ws.color);
    clearTurnTimer(room);
    broadcastRoom(room, { type: 'move', row, col, color: ws.color });
    broadcastRoom(room, { type: 'game_over', winner: ws.color, line: winLine });
  } else if (isDraw(room.board)) {
    room.status = 'over';
    room.winner = 'draw';
    room.loser = null;
    clearTurnTimer(room);
    broadcastRoom(room, { type: 'move', row, col, color: ws.color });
    broadcastRoom(room, { type: 'game_over', winner: 'draw', line: null });
  } else {
    room.turn = otherColor(room.turn);
    broadcastRoom(room, { type: 'move', row, col, color: ws.color, turn: room.turn });
    startTurnTimer(room);
  }
};

const onRematch = (ws) => {
  if (!ws.roomCode || ws.role !== 'player') return;
  const room = getRoom(ws.roomCode);
  if (!room || room.status !== 'over') return;
  room.rematchVotes.add(ws.color);
  if (room.rematchVotes.size < 2) {
    broadcastRoom(room, { type: 'rematch_pending', who: ws.color });
    return;
  }
  // 패자 선공
  if (room.loser === 'white') {
    [room.players[0], room.players[1]] = [room.players[1], room.players[0]];
    [room.nicknames[0], room.nicknames[1]] = [room.nicknames[1], room.nicknames[0]];
    room.players[0].color = 'black';
    room.players[1].color = 'white';
  }
  startGame(room);
};

const onLeaveRoom = (ws) => {
  if (!ws.roomCode) return;
  const room = getRoom(ws.roomCode);
  if (!room) { ws.roomCode = null; ws.color = null; ws.role = null; return; }

  if (ws.role === 'spectator') {
    removeSpectator(ws);
    return;
  }

  // 플레이어가 나감 → 방 폐쇄, 모두에게 알림
  clearTurnTimer(room);
  if (room.disconnectTimers.black) clearTimeout(room.disconnectTimers.black);
  if (room.disconnectTimers.white) clearTimeout(room.disconnectTimers.white);

  const opp = room.players[colorIndex(otherColor(ws.color))];
  if (opp) {
    send(opp, { type: 'opponent_left' });
    opp.roomCode = null; opp.color = null; opp.role = null;
    dropSession(opp.sessionId); opp.sessionId = null;
  }
  for (const s of room.spectators) {
    send(s, { type: 'opponent_left' });
    s.roomCode = null; s.role = null;
  }
  dropSession(ws.sessionId); ws.sessionId = null;
  deleteRoom(room.code);
  ws.roomCode = null; ws.color = null; ws.role = null;
};

// ============================================================
// 연결 끊김 처리 (30초 grace, 관전자는 즉시 제거)
// ============================================================
const onPlayerDisconnect = (ws) => {
  if (!ws.roomCode) return;
  if (ws.role === 'spectator') {
    removeSpectator(ws);
    return;
  }
  const room = getRoom(ws.roomCode);
  if (!room) return;
  if (room.status !== 'playing') {
    onLeaveRoom(ws);
    return;
  }
  const myColor = ws.color;
  for (const p of room.players) {
    if (p && p !== ws) send(p, { type: 'opponent_disconnected', color: myColor, deadline: Date.now() + DISCONNECT_GRACE_MS });
  }
  for (const s of room.spectators) {
    send(s, { type: 'opponent_disconnected', color: myColor, deadline: Date.now() + DISCONNECT_GRACE_MS });
  }
  room.players[colorIndex(myColor)] = null;
  room.disconnectTimers[myColor] = setTimeout(() => finalizeAbandon(room, myColor), DISCONNECT_GRACE_MS);
};

const finalizeAbandon = (room, color) => {
  if (room.status !== 'playing') return;
  room.status = 'over';
  for (const p of room.players) if (p) send(p, { type: 'opponent_abandoned', color });
  for (const s of room.spectators) send(s, { type: 'opponent_abandoned', color });
  clearTurnTimer(room);
  dropSession(room.sessionIds[colorIndex(color)]);
  room.sessionIds[colorIndex(color)] = null;
};

module.exports = {
  init,
  handleMessage,
  onPlayerDisconnect,
  onQueueLeave,
  broadcastOnlineCount,
};
