// ============================================================
// WS 메시지 처리 + 차례 타이머 + 재연결 grace + 관전자 + 게임 흐름
// ============================================================

const {
  getRoom, setRoom, deleteRoom, getRoomsList,
  getSession, dropSession,
  getQueue, enqueue, dequeue,
  getOnline,
  genCode, sanitizeNick,
  createRoom, attachSession,
} = require('./rooms');
const { emptyBoard, checkWin, isDraw, BOARD_SIZE } = require('./game-logic');

const TURN_TIMEOUT_MS       = Number(process.env.TURN_TIMEOUT_MS)       || 30000;
const DISCONNECT_GRACE_MS   = Number(process.env.DISCONNECT_GRACE_MS)   || 30000;
const EMOTE_COOLDOWN_MS     = Number(process.env.EMOTE_COOLDOWN_MS)     || 800;

// 게임 중 짧은 상호작용 이모트. 키는 클라/서버 합의된 화이트리스트만 허용.
const EMOTES = {
  hi:        { emoji: '👋', text: 'Hi' },
  tick_tock: { emoji: '⏰', text: 'Tick-tock' },
  hmm:       { emoji: '🤔', text: 'Hmm..' },
  oops:      { emoji: '😬', text: 'Oops' },
  easy:      { emoji: '😏', text: 'Easy' },
  sure:      { emoji: '🤨', text: 'You sure?' },
  please:    { emoji: '🥺', text: 'Please..' },
  wow:       { emoji: '🤯', text: 'WOW' },
  gg:        { emoji: '🫡', text: 'GG' },
  again:     { emoji: '🔁', text: 'Again?' },
};

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

// 방 목록 변경 시 모든 연결된 클라에게 푸시.
// 동시에 여러 변경이 일어나도 한 tick 으로 합쳐 보냄(부하 절약).
let _roomsListPending = false;
const broadcastRoomsList = () => {
  if (!wssRef || _roomsListPending) return;
  _roomsListPending = true;
  setImmediate(() => {
    _roomsListPending = false;
    const payload = JSON.stringify({ type: 'rooms_list', rooms: getRoomsList() });
    for (const c of wssRef.clients) {
      if (c.readyState === c.OPEN) c.send(payload);
    }
  });
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
  broadcastRoomsList();
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
  broadcastRoomsList();
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
  broadcastRoomsList();
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
    case 'emote':          return onEmote(ws, msg);
    case 'request_rooms_list':
      return send(ws, { type: 'rooms_list', rooms: getRoomsList() });
  }
};

// 플레이어가 보낸 이모트를 방 전체(상대 + 관전자)에 브로드캐스트.
// 진행 중(playing) 또는 종료 후(over)에만 허용. 같은 ws의 너무 잦은 송신은 쿨다운으로 무시.
const onEmote = (ws, msg) => {
  if (!ws.roomCode || ws.role !== 'player') return;
  const room = getRoom(ws.roomCode);
  if (!room) return;
  if (room.status !== 'playing' && room.status !== 'over') return;
  const e = EMOTES[msg.key];
  if (!e) return;
  const now = Date.now();
  if (ws.lastEmoteAt && now - ws.lastEmoteAt < EMOTE_COOLDOWN_MS) return;
  ws.lastEmoteAt = now;
  broadcastRoom(room, {
    type: 'emote',
    from: ws.color,
    key: msg.key,
    emoji: e.emoji,
    text: e.text,
  });
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
  // 방장에게도 sessionId 부여 — 대기 중 끊김 발생 시 resume_session 으로 복구 가능하게 함 (이슈 #9)
  const sid = attachSession(ws, room, 'black');
  send(ws, { type: 'room_created', code, sessionId: sid });
  broadcastRoomsList();
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
  // 방장이 잠시 끊긴 상태(자리 비움)면 join 거부 — grace 끝나기를 기다림
  if (!room.players[0]) {
    return send(ws, { type: 'error', message: '방장이 잠시 자리를 비웠어요. 잠시 후 다시 시도해주세요' });
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
  // 클라이언트 식별자 (같은 브라우저에서 온 요청 dedupe 용도)
  ws.clientId = typeof msg.clientId === 'string' && msg.clientId.length <= 64 ? msg.clientId : null;

  const q = getQueue();

  // 같은 clientId 의 좀비 ws 가 큐에 남아 있으면 정리.
  // (이슈 #5/#6: 같은 사용자가 새 탭/재연결로 다시 매칭을 누른 경우, 이전 ws 와 자기 자신이 매칭되는 사태 방지)
  if (ws.clientId) {
    for (let i = q.length - 1; i >= 0; i--) {
      if (q[i] !== ws && q[i].clientId === ws.clientId) {
        const stale = q.splice(i, 1)[0];
        stale.inQueue = false;
        if (stale.readyState === stale.OPEN) {
          send(stale, { type: 'queue_canceled', reason: 'replaced' });
        }
      }
    }
  }

  // 매칭 상대 찾기 — readyState OPEN 이고, 같은 clientId 가 아닌 사람
  const idx = q.findIndex((w) =>
    w !== ws &&
    w.readyState === w.OPEN &&
    !(ws.clientId && w.clientId && w.clientId === ws.clientId)
  );
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
    broadcastRoomsList();
  } else if (isDraw(room.board)) {
    room.status = 'over';
    room.winner = 'draw';
    room.loser = null;
    clearTurnTimer(room);
    broadcastRoom(room, { type: 'move', row, col, color: ws.color });
    broadcastRoom(room, { type: 'game_over', winner: 'draw', line: null });
    broadcastRoomsList();
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

  // 대전 중에 나가면 → 상대 승리로 처리
  if (room.status === 'playing') {
    const winnerColor = otherColor(ws.color);
    room.status = 'over';
    room.winner = winnerColor;
    if (opp) send(opp, { type: 'game_over', winner: winnerColor, line: null, reason: 'opponent_left' });
    for (const s of room.spectators) {
      send(s, { type: 'game_over', winner: winnerColor, line: null, reason: 'opponent_left' });
    }
  } else {
    // 대기/종료 상태에서 나감 → 기존대로 상대만 통보
    if (opp) send(opp, { type: 'opponent_left' });
    for (const s of room.spectators) send(s, { type: 'opponent_left' });
  }

  if (opp) {
    opp.roomCode = null; opp.color = null; opp.role = null;
    dropSession(opp.sessionId); opp.sessionId = null;
  }
  for (const s of room.spectators) {
    s.roomCode = null; s.role = null;
  }
  dropSession(ws.sessionId); ws.sessionId = null;
  deleteRoom(room.code);
  ws.roomCode = null; ws.color = null; ws.role = null;
  broadcastRoomsList();
};

// ============================================================
// 연결 끊김 처리 (30초 grace, 관전자는 즉시 제거)
// ----------------------------------------------------------------
// playing : 기존대로 — 상대에게 opponent_disconnected, grace 후 finalizeAbandon
// waiting : 방장만 있는 상태에서 끊김 — 방은 유지, grace 후 폐쇄.
//           (다른 탭/네트워크 회복 후 resume_session 으로 복귀 가능)
// over    : 게임 끝나고 재대국 대기 중 — 방 유지, grace 후 폐쇄.
//           (재연결되면 결과 화면 그대로 복귀)
// ============================================================
const onPlayerDisconnect = (ws) => {
  if (!ws.roomCode) return;
  if (ws.role === 'spectator') {
    removeSpectator(ws);
    return;
  }
  const room = getRoom(ws.roomCode);
  if (!room) return;
  if (room.status !== 'playing' && room.status !== 'waiting' && room.status !== 'over') {
    onLeaveRoom(ws);
    return;
  }
  const myColor = ws.color;
  const deadline = Date.now() + DISCONNECT_GRACE_MS;
  // 진행 중이든 대기/종료든 상대(있다면) + 관전자에게는 동일한 신호 — 표시는 클라가 알아서.
  for (const p of room.players) {
    if (p && p !== ws) send(p, { type: 'opponent_disconnected', color: myColor, deadline });
  }
  for (const s of room.spectators) {
    send(s, { type: 'opponent_disconnected', color: myColor, deadline });
  }
  room.players[colorIndex(myColor)] = null;
  if (room.disconnectTimers[myColor]) clearTimeout(room.disconnectTimers[myColor]);
  room.disconnectTimers[myColor] = setTimeout(() => finalizeAbandon(room, myColor), DISCONNECT_GRACE_MS);
};

const finalizeAbandon = (room, color) => {
  // 게임 중에 안 돌아온 경우 — 기존 동작 유지 (opponent_abandoned 알림, status='over' 로 전환)
  if (room.status === 'playing') {
    room.status = 'over';
    for (const p of room.players) if (p) send(p, { type: 'opponent_abandoned', color });
    for (const s of room.spectators) send(s, { type: 'opponent_abandoned', color });
    clearTurnTimer(room);
    dropSession(room.sessionIds[colorIndex(color)]);
    room.sessionIds[colorIndex(color)] = null;
    broadcastRoomsList();
    return;
  }
  // 대기 중(waiting) 또는 종료 후(over) 에 grace 동안 안 돌아온 경우 — 방 자체를 닫음.
  // 남은 상대(있다면)와 관전자들에게 opponent_left 통보하고 방 폐쇄.
  if (room.status === 'waiting' || room.status === 'over') {
    const opp = room.players[colorIndex(otherColor(color))];
    if (opp) {
      send(opp, { type: 'opponent_left' });
      opp.roomCode = null; opp.color = null; opp.role = null;
      dropSession(opp.sessionId); opp.sessionId = null;
    }
    for (const s of room.spectators) {
      send(s, { type: 'opponent_left' });
      s.roomCode = null; s.role = null;
    }
    if (room.disconnectTimers.black) { clearTimeout(room.disconnectTimers.black); room.disconnectTimers.black = null; }
    if (room.disconnectTimers.white) { clearTimeout(room.disconnectTimers.white); room.disconnectTimers.white = null; }
    clearTurnTimer(room);
    deleteRoom(room.code);
    broadcastRoomsList();
  }
};

module.exports = {
  init,
  handleMessage,
  onPlayerDisconnect,
  onQueueLeave,
  broadcastOnlineCount,
};
