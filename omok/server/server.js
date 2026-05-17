// ============================================================
// 오목대전 서버
// - HTTP: omok/ FE 정적 파일 서빙
// - WebSocket(/ws): 매치메이킹, 게임 상태, 5목 판정,
//                   닉네임, 30초 차례 타이머, 세션 복구(30초 grace)
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const BOARD_SIZE = 15;
const WIN_LENGTH = 5;
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS) || 30000;
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS) || 30000;
const STATIC_ROOT = path.resolve(__dirname, '..'); // omok/
const MAX_NICK_LEN = 12;

// ============================================================
// 정적 파일 서빙
// ============================================================
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const httpServer = http.createServer((req, res) => {
  let urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(STATIC_ROOT, urlPath));
  if (!filePath.startsWith(STATIC_ROOT + path.sep) && filePath !== STATIC_ROOT) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found: ' + urlPath);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ============================================================
// 상태
// ============================================================
const rooms = new Map();      // code -> Room
const queue = [];             // 자동 매칭 대기 (WS)
const sessions = new Map();   // sessionId -> { code, color }

function emptyBoard() {
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(0));
}

function createRoom(code) {
  return {
    code,
    players: [null, null],            // 0 = black, 1 = white
    nicknames: ['', ''],              // 0 = black nick, 1 = white nick
    sessionIds: [null, null],         // 0 = black, 1 = white
    board: emptyBoard(),
    turn: 'black',
    turnDeadline: 0,
    turnTimer: null,
    status: 'waiting',                // waiting | playing | over
    winner: null,
    winLine: null,
    lastMove: null,                   // [row, col]
    rematchVotes: new Set(),
    loser: null,
    disconnectTimers: { black: null, white: null }, // setTimeout handles
  };
}

function genCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function genSessionId() {
  return crypto.randomBytes(12).toString('base64url');
}

function sanitizeNick(nick) {
  if (typeof nick !== 'string') return '';
  return nick.trim().slice(0, MAX_NICK_LEN);
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  for (const p of room.players) if (p) send(p, msg);
}

function colorIndex(color) { return color === 'black' ? 0 : 1; }
function otherColor(color) { return color === 'black' ? 'white' : 'black'; }

// ============================================================
// 5목 판정
// ============================================================
function checkWin(board, r, c, color) {
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  const stone = color === 'black' ? 1 : 2;
  for (const [dr, dc] of dirs) {
    const line = [[r, c]];
    for (let i = 1; i <= WIN_LENGTH; i++) {
      const nr = r + dr * i, nc = c + dc * i;
      if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) break;
      if (board[nr][nc] !== stone) break;
      line.push([nr, nc]);
    }
    for (let i = 1; i <= WIN_LENGTH; i++) {
      const nr = r - dr * i, nc = c - dc * i;
      if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) break;
      if (board[nr][nc] !== stone) break;
      line.unshift([nr, nc]);
    }
    if (line.length >= WIN_LENGTH) return line;
  }
  return null;
}

function isDraw(board) {
  for (const row of board) for (const v of row) if (v === 0) return false;
  return true;
}

// ============================================================
// 차례 타이머
// ============================================================
function startTurnTimer(room) {
  clearTurnTimer(room);
  room.turnDeadline = Date.now() + TURN_TIMEOUT_MS;
  room.turnTimer = setTimeout(() => onTurnTimeout(room), TURN_TIMEOUT_MS);
  broadcast(room, { type: 'turn_started', turn: room.turn, deadline: room.turnDeadline });
}

function clearTurnTimer(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  room.turnDeadline = 0;
}

function onTurnTimeout(room) {
  if (room.status !== 'playing') return;
  const skipped = room.turn;
  room.turn = otherColor(room.turn);
  broadcast(room, { type: 'turn_skipped', skipped, turn: room.turn });
  startTurnTimer(room);
}

// ============================================================
// 세션
// ============================================================
function attachSession(ws, room, color) {
  const sid = genSessionId();
  ws.sessionId = sid;
  room.sessionIds[colorIndex(color)] = sid;
  sessions.set(sid, { code: room.code, color });
  return sid;
}

function dropSession(sid) {
  if (sid) sessions.delete(sid);
}

// ============================================================
// 연결 끊김 처리 (30초 grace)
// ============================================================
function onPlayerDisconnect(ws) {
  if (!ws.roomCode || !ws.color) return;
  const room = rooms.get(ws.roomCode);
  if (!room) return;

  // 대기/종료 방의 disconnect는 즉시 정리
  if (room.status !== 'playing') {
    handleLeaveRoom(ws);
    return;
  }

  const myColor = ws.color;
  const opp = room.players[colorIndex(otherColor(myColor))];
  if (opp) {
    send(opp, { type: 'opponent_disconnected', color: myColor, deadline: Date.now() + DISCONNECT_GRACE_MS });
  }

  // 슬롯 비우고 grace 타이머
  room.players[colorIndex(myColor)] = null;
  room.disconnectTimers[myColor] = setTimeout(() => {
    finalizeAbandon(room, myColor);
  }, DISCONNECT_GRACE_MS);
}

function cancelDisconnectTimer(room, color) {
  if (room.disconnectTimers[color]) {
    clearTimeout(room.disconnectTimers[color]);
    room.disconnectTimers[color] = null;
  }
}

function finalizeAbandon(room, color) {
  if (room.status !== 'playing') return;
  room.status = 'over';
  const opp = room.players[colorIndex(otherColor(color))];
  if (opp) {
    send(opp, { type: 'opponent_abandoned', color });
  }
  clearTurnTimer(room);
  // 세션 만료
  dropSession(room.sessionIds[colorIndex(color)]);
  room.sessionIds[colorIndex(color)] = null;
  // 남은 사람이 마저 나갈 때 방 삭제
}

// ============================================================
// 메시지 핸들러
// ============================================================
function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'create_room':    return handleCreateRoom(ws, msg);
    case 'join_room':      return handleJoinRoom(ws, msg);
    case 'queue_join':     return handleQueueJoin(ws, msg);
    case 'queue_leave':    return handleQueueLeave(ws);
    case 'resume_session': return handleResumeSession(ws, msg);
    case 'move':           return handleMove(ws, msg.row, msg.col);
    case 'rematch':        return handleRematch(ws);
    case 'leave_room':     return handleLeaveRoom(ws);
  }
}

function handleCreateRoom(ws, msg) {
  if (ws.roomCode) return send(ws, { type: 'error', message: '이미 방에 있어요' });
  handleQueueLeave(ws);
  const code = genCode();
  const room = createRoom(code);
  room.players[0] = ws;
  room.nicknames[0] = sanitizeNick(msg.nickname) || '익명';
  ws.roomCode = code;
  ws.color = 'black';
  ws.nickname = room.nicknames[0];
  rooms.set(code, room);
  send(ws, { type: 'room_created', code });
}

function handleJoinRoom(ws, msg) {
  if (ws.roomCode) return send(ws, { type: 'error', message: '이미 방에 있어요' });
  if (typeof msg.code !== 'string') return send(ws, { type: 'error', message: '방 코드를 입력하세요' });
  const code = msg.code.toUpperCase().trim();
  const room = rooms.get(code);
  if (!room) return send(ws, { type: 'error', message: '존재하지 않는 방 코드예요' });
  if (room.players[0] && room.players[1]) return send(ws, { type: 'error', message: '방이 꽉 찼어요' });
  handleQueueLeave(ws);
  room.players[1] = ws;
  room.nicknames[1] = sanitizeNick(msg.nickname) || '익명';
  ws.roomCode = code;
  ws.color = 'white';
  ws.nickname = room.nicknames[1];
  startGame(room);
}

function handleQueueJoin(ws, msg) {
  if (ws.roomCode) return send(ws, { type: 'error', message: '이미 방에 있어요' });
  ws.nickname = sanitizeNick(msg.nickname) || '익명';
  const idx = queue.findIndex(w => w !== ws && w.readyState === w.OPEN);
  if (idx >= 0) {
    const opponent = queue.splice(idx, 1)[0];
    opponent.inQueue = false;
    const code = genCode();
    const room = createRoom(code);
    room.players[0] = opponent;
    room.nicknames[0] = opponent.nickname || '익명';
    opponent.roomCode = code; opponent.color = 'black';
    room.players[1] = ws;
    room.nicknames[1] = ws.nickname || '익명';
    ws.roomCode = code; ws.color = 'white';
    rooms.set(code, room);
    startGame(room);
  } else {
    if (!queue.includes(ws)) queue.push(ws);
    ws.inQueue = true;
    send(ws, { type: 'queue_waiting' });
  }
}

function handleQueueLeave(ws) {
  const idx = queue.indexOf(ws);
  if (idx >= 0) queue.splice(idx, 1);
  ws.inQueue = false;
}

function startGame(room) {
  // 만약 이전 세션이 있으면 정리
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

  // 각 플레이어에 sessionId 발급
  const sidBlack = attachSession(room.players[0], room, 'black');
  const sidWhite = attachSession(room.players[1], room, 'white');

  const baseStart = {
    type: 'game_start',
    board: room.board,
    turn: room.turn,
    nicknames: { black: room.nicknames[0], white: room.nicknames[1] },
  };
  send(room.players[0], { ...baseStart, you: 'black', opponent: 'white', sessionId: sidBlack });
  send(room.players[1], { ...baseStart, you: 'white', opponent: 'black', sessionId: sidWhite });

  startTurnTimer(room);
}

function handleResumeSession(ws, msg) {
  if (ws.roomCode) return; // 이미 방 안에 있음
  const sid = msg.sessionId;
  if (typeof sid !== 'string') return send(ws, { type: 'resume_failed', reason: 'invalid_session' });
  const sess = sessions.get(sid);
  if (!sess) return send(ws, { type: 'resume_failed', reason: 'not_found' });
  const room = rooms.get(sess.code);
  if (!room || room.status === 'over' && !room.disconnectTimers[sess.color]) {
    // 방 자체가 사라졌거나 게임 끝남 — 일단 끝난 게임도 결과 전달 가능하게 처리
  }
  if (!room) {
    sessions.delete(sid);
    return send(ws, { type: 'resume_failed', reason: 'not_found' });
  }

  const idx = colorIndex(sess.color);
  // disconnect timer 취소, ws 재바인딩
  cancelDisconnectTimer(room, sess.color);
  room.players[idx] = ws;
  ws.roomCode = room.code;
  ws.color = sess.color;
  ws.sessionId = sid;
  // 닉네임 갱신(닉 바뀌었으면 반영)
  if (msg.nickname) {
    const n = sanitizeNick(msg.nickname) || room.nicknames[idx];
    room.nicknames[idx] = n;
    ws.nickname = n;
  } else {
    ws.nickname = room.nicknames[idx];
  }

  // 상대에게 알림
  const opp = room.players[colorIndex(otherColor(sess.color))];
  if (opp) send(opp, { type: 'opponent_reconnected', color: sess.color });

  // 전체 상태 송신
  send(ws, {
    type: 'resume_success',
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
  });
}

function handleMove(ws, row, col) {
  if (!ws.roomCode) return;
  const room = rooms.get(ws.roomCode);
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
    broadcast(room, { type: 'move', row, col, color: ws.color });
    broadcast(room, { type: 'game_over', winner: ws.color, line: winLine });
  } else if (isDraw(room.board)) {
    room.status = 'over';
    room.winner = 'draw';
    room.loser = null;
    clearTurnTimer(room);
    broadcast(room, { type: 'move', row, col, color: ws.color });
    broadcast(room, { type: 'game_over', winner: 'draw', line: null });
  } else {
    room.turn = otherColor(room.turn);
    broadcast(room, { type: 'move', row, col, color: ws.color, turn: room.turn });
    startTurnTimer(room);
  }
}

function handleRematch(ws) {
  if (!ws.roomCode) return;
  const room = rooms.get(ws.roomCode);
  if (!room || room.status !== 'over') return;
  room.rematchVotes.add(ws.color);
  if (room.rematchVotes.size < 2) {
    broadcast(room, { type: 'rematch_pending', who: ws.color });
    return;
  }
  // 패자가 흑(선공). 무승부면 색 유지.
  if (room.loser === 'white') {
    [room.players[0], room.players[1]] = [room.players[1], room.players[0]];
    [room.nicknames[0], room.nicknames[1]] = [room.nicknames[1], room.nicknames[0]];
    room.players[0].color = 'black';
    room.players[1].color = 'white';
  }
  startGame(room);
}

function handleLeaveRoom(ws) {
  if (!ws.roomCode) return;
  const room = rooms.get(ws.roomCode);
  if (!room) { ws.roomCode = null; ws.color = null; return; }
  clearTurnTimer(room);
  cancelDisconnectTimer(room, 'black');
  cancelDisconnectTimer(room, 'white');
  const opp = room.players[colorIndex(otherColor(ws.color))];
  if (opp) {
    send(opp, { type: 'opponent_left' });
    opp.roomCode = null;
    opp.color = null;
    dropSession(opp.sessionId);
    opp.sessionId = null;
  }
  dropSession(ws.sessionId);
  ws.sessionId = null;
  for (const sid of room.sessionIds) dropSession(sid);
  rooms.delete(ws.roomCode);
  ws.roomCode = null;
  ws.color = null;
}

// ============================================================
// WS 연결
// ============================================================
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.color = null;
  ws.inQueue = false;
  ws.sessionId = null;
  ws.nickname = '';

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    try {
      handleMessage(ws, msg);
    } catch (e) {
      console.error('handler error:', e);
      send(ws, { type: 'error', message: '서버 처리 중 오류' });
    }
  });

  ws.on('close', () => {
    handleQueueLeave(ws);
    // 게임 중이면 grace 타이머, 아니면 즉시 정리
    onPlayerDisconnect(ws);
  });
});

httpServer.listen(PORT, () => {
  console.log(`[omok] HTTP   http://localhost:${PORT}`);
  console.log(`[omok] WS     ws://localhost:${PORT}/ws`);
  console.log(`[omok] TURN_TIMEOUT_MS=${TURN_TIMEOUT_MS}  DISCONNECT_GRACE_MS=${DISCONNECT_GRACE_MS}`);
});
