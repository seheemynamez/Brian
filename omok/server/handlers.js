// ============================================================
// WS 메시지 처리 + 차례 타이머 + 재연결 grace + 관전자 + 게임 흐름
// ============================================================

const {
  getRoom, setRoom, deleteRoom, getRoomsList,
  getSession, dropSession,
  getQueue, enqueue, dequeueByConnectionId,
  getOnline,
  genCode, genGameId, sanitizeNick,
  createRoom, attachSession, attachSpectatorSession,
} = require('./rooms');
const connections = require('./connections');
const { emptyBoard, checkWin, isDraw, BOARD_SIZE } = require('./game-logic');
const { checkForbidden, checkWinRenju, FORBIDDEN_LABEL } = require('./renju');
const {
  BOT_IDS, BOT_NICKNAMES, VALID_DIFFICULTIES,
  decideBotEmote, recordBotEmote, newBotEmoteState, thinkTimeMs,
} = require('./bot');
// generateMove 는 워커 풀의 async 래퍼 사용 — 메인 이벤트 루프 블로킹 회피.
const { generateMoveAsync } = require('./bot-pool');
const log = require('./log');

const TURN_TIMEOUT_MS       = Number(process.env.TURN_TIMEOUT_MS)       || 30000;
const DISCONNECT_GRACE_MS   = Number(process.env.DISCONNECT_GRACE_MS)   || 30000;
const EMOTE_COOLDOWN_MS     = Number(process.env.EMOTE_COOLDOWN_MS)     || 800;
const BOT_OFFER_DELAY_MS    = Number(process.env.BOT_OFFER_DELAY_MS)    || 10000;

// 게임 중 짧은 상호작용 이모트. 키는 클라/서버 합의된 화이트리스트만 허용.
const EMOTES = {
  hi:        { emoji: '👋', text: 'Hi' },
  tick_tock: { emoji: '⏰', text: 'Tick-tock' },
  hmm:       { emoji: '🤔', text: 'Hmm..' },
  oops:      { emoji: '🫢', text: 'Oops' },
  easy:      { emoji: '😏', text: 'Easy' },
  sure:      { emoji: '🤨', text: 'You sure?' },
  please:    { emoji: '🥺', text: 'Please..' },
  wow:       { emoji: '😳', text: 'WOW' },
  gg:        { emoji: '🫡', text: 'GG' },
  again:     { emoji: '🔁', text: 'Again?' },
};

let wssRef = null;

const init = (wss) => { wssRef = wss; };

// ---- 송신 헬퍼 ----
// 도메인 코드가 ws 객체에 직접 의존하지 않도록, ID 기반 송신 헬퍼를 함께 노출 (이슈 #31).
// 기존 send(ws, msg) 는 점진 마이그레이션을 위해 유지.
const send = (ws, msg) => {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};

const sendToConnection = (connectionId, msg) => {
  if (!connectionId) return;
  send(connections.getWsByConnectionId(connectionId), msg);
};

const sendToSession = (sessionId, msg) => {
  if (!sessionId) return;
  send(connections.getWsBySessionId(sessionId), msg);
};

// 같은 clientId 로 연결된 모든 ws 에 송신 (멀티탭/멀티기기).
const sendToClient = (clientId, msg) => {
  if (!clientId) return;
  for (const ws of connections.getWsListByClientId(clientId)) send(ws, msg);
};

// 관전자 iteration helpers — spectatorSessionIds (single source of truth) → ws via connections.
// ws 가 죽어있으면(close 직후) 무시. 호출 측은 ws 없는 sid 를 신경 쓸 필요 없음.
const forEachSpectatorWs = (room, fn) => {
  for (const sid of room.spectatorSessionIds) {
    const ws = connections.getWsBySessionId(sid);
    if (ws && ws.readyState === ws.OPEN) fn(ws, sid);
  }
};

const broadcastRoom = (room, msg) => {
  for (const p of room.players) if (p) send(p, msg);
  forEachSpectatorWs(room, (ws) => send(ws, msg));
};

const broadcastOnlineCount = () => {
  if (!wssRef) return;
  // 클라이언트에는 "실제 사용자 수" — 같은 clientId 의 좀비 연결은 합산 안 함.
  // 비행기모드 reconnect 동안 옛 ws 가 heartbeat 로 정리되기 전까지 짧게 중복 카운팅 되던 버그.
  const payload = JSON.stringify({ type: 'online_count', n: connections.getUniqueOnlineCount() });
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
// 봇 ws shim — 사람 player 와 같은 onMove 경로를 타기 위한 가짜 ws.
// 실제 네트워크 송신 없음 (send는 no-op). WebSocketServer.clients 와 무관.
// ============================================================
const makeBotWs = (difficulty) => ({
  readyState: 1, OPEN: 1, CLOSED: 3,
  send() {},
  isBot: true,
  botDifficulty: difficulty,
  roomCode: null,
  color: null,
  role: null,
  sessionId: null,
  nickname: BOT_NICKNAMES[difficulty],
  clientId: BOT_IDS[difficulty],
});

// ============================================================
// 봇 행동 — emote / 다음 수 스케줄링
// ============================================================
const tryBotEmote = (room, trigger) => {
  if (!room || !room.hasBot) return;
  const bot = room.players.find((p) => p && p.isBot);
  if (!bot) return;
  if (!room.botEmoteState) room.botEmoteState = newBotEmoteState();
  const key = decideBotEmote({
    board: room.board, botColor: bot.color, difficulty: bot.botDifficulty,
    trigger, emoteState: room.botEmoteState, now: Date.now(),
  });
  if (!key) return;
  const e = EMOTES[key];
  if (!e) return;
  recordBotEmote(room.botEmoteState, key, Date.now());
  broadcastRoom(room, { type: 'emote', from: bot.color, key, emoji: e.emoji, text: e.text });
};

const scheduleBotMove = (room) => {
  if (!room || !room.hasBot) return;
  if (room.status !== 'playing') return;
  const bot = room.players.find((p) => p && p.isBot);
  if (!bot) return;
  if (room.turn !== bot.color) return;
  if (room.botMoveTimer) clearTimeout(room.botMoveTimer);
  const delay = thinkTimeMs(bot.botDifficulty);
  const code = room.code;
  room.botMoveTimer = setTimeout(() => {
    room.botMoveTimer = null;
    if (room.status !== 'playing') return;
    if (room.turn !== bot.color) return;
    // 보드 스냅샷을 워커로 보내 비동기로 계산. 메인 이벤트 루프는 그동안 자유.
    // 워커가 결과를 돌려줄 시점에 게임 상태가 변했을 수 있으니(사용자 leave / 타임아웃 등)
    // 한 번 더 검증 후 onMove 호출.
    generateMoveAsync(room.board, bot.color, bot.botDifficulty).then((move) => {
      if (!move) return;
      const current = getRoom(code);
      if (!current || current !== room) return;          // 방이 사라졌거나 교체됨
      if (room.status !== 'playing') return;             // 게임 종료 / 사용자 이탈
      if (room.turn !== bot.color) return;               // 차례가 다른 색으로 넘어감 (타임아웃 등)
      if (room.board[move[0]][move[1]] !== 0) return;    // 그 칸이 이미 채워짐 (방어적)
      onMove(bot, move[0], move[1]);
    }).catch((err) => {
      console.error('[bot] generateMoveAsync 실패:', err && err.message);
    });
  }, delay);
};

const cancelBotTimers = (room) => {
  if (room && room.botMoveTimer) {
    clearTimeout(room.botMoveTimer);
    room.botMoveTimer = null;
  }
  if (room && room.botOfferTimer) {
    clearTimeout(room.botOfferTimer);
    room.botOfferTimer = null;
  }
};

// 매 성공적인 move 직후 호출 — 봇 게임이면 emote / 다음 봇 차례 처리.
const afterSuccessfulMove = (room, justMovedWs) => {
  if (!room.hasBot) return;
  const bot = room.players.find((p) => p && p.isBot);
  if (!bot) return;

  if (room.status === 'over') {
    if (room.winner === bot.color) setTimeout(() => tryBotEmote(room, 'game_over_win'), 600);
    else if (room.winner && room.winner !== 'draw') setTimeout(() => tryBotEmote(room, 'game_over_lose'), 600);
    cancelBotTimers(room);
    return;
  }
  // 진행 중: 직전 수가 봇/사람 분기 → 적절한 emote → 봇 차례면 다음 수 스케줄
  const trigger = justMovedWs && justMovedWs.isBot ? 'bot_moved' : 'opponent_moved';
  setTimeout(() => tryBotEmote(room, trigger), 300);
  if (room.turn === bot.color) scheduleBotMove(room);
};

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
  // 봇 게임에서 사람이 시간 초과되면 봇 차례로 넘어가는데, 봇이 깨어나지 않던 버그.
  // afterSuccessfulMove 경로가 아닌 곳에서도 봇 차례면 즉시 스케줄.
  if (room.hasBot) {
    const bot = room.players.find((p) => p && p.isBot);
    if (bot && room.turn === bot.color) scheduleBotMove(room);
  }
};

// ============================================================
// 관전자 헬퍼
// ============================================================
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
  if (room && ws.sessionId) {
    room.spectatorSessionIds.delete(ws.sessionId);
    broadcastSpectators(room);
  }
  // spectator 세션은 grace 의미가 없어 즉시 정리.
  if (ws.sessionId) {
    dropSession(ws.sessionId);
    ws.sessionId = null;
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
  // 매 게임마다 새 gameId — 차후 DB 랭킹/통계 기록 키로 활용.
  room.gameId = genGameId();
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
    gameId: room.gameId,
    board: room.board,
    turn: room.turn,
    nicknames: { black: room.nicknames[0], white: room.nicknames[1] },
    spectators: getSpectatorNames(room),
  };
  send(room.players[0], { ...base, you: 'black', opponent: 'white', sessionId: sidBlack });
  send(room.players[1], { ...base, you: 'white', opponent: 'black', sessionId: sidWhite });
  forEachSpectatorWs(room, (ws) => sendSpectatorState(ws, room));

  startTurnTimer(room);
  broadcastRoomsList();
  log.event('game_started', {
    code: room.code,
    gameId: room.gameId,
    black: room.nicknames[0],
    white: room.nicknames[1],
    bot: !!room.hasBot,
  });
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
    case 'set_nickname':   return onSetNickname(ws, msg);
    case 'create_bot_game':    return onCreateBotGame(ws, msg);
    case 'bot_offer_accept':   return onBotOfferAccept(ws, msg);
    case 'bot_offer_decline':  return onBotOfferDecline(ws);
    case 'request_rooms_list':
      return send(ws, { type: 'rooms_list', rooms: getRoomsList() });
    case 'request_online_list':
      return onRequestOnlineList(ws);
  }
};

// 로비에서 닉네임/clientId 동기화 — 방에 들어가기 전에도 온라인 목록 표시 + 랭킹용 식별자 확보.
const onSetNickname = (ws, msg) => {
  const next = sanitizeNick(msg.nickname);
  if (next) ws.nickname = next;
  // clientId 도 함께 받아서 ws 에 기록 — 추후 게임 결과 기록 시 안정 식별자로 사용.
  // 동시에 connection registry 에 등록 → 같은 clientId 의 멀티탭 추적 가능 (이슈 #31).
  if (typeof msg.clientId === 'string' && msg.clientId.length > 0 && msg.clientId.length <= 64) {
    const isNewBinding = !ws.clientId || ws.clientId !== msg.clientId;
    connections.bindClient(ws, msg.clientId);
    // 새 ws 가 같은 clientId 의 옛 좀비 연결과 합쳐졌을 수 있으니 unique count 재발송.
    // (비행기모드 reconnect 시 짧게 중복 카운팅 되던 증상 해소)
    if (isNewBinding) broadcastOnlineCount();
  }
};

// 접속자 닉네임 목록 — 닉이 설정된 연결만, 같은 닉(멀티탭)은 1개로 dedupe.
const onRequestOnlineList = (ws) => {
  if (!wssRef) return;
  const seen = new Set();
  const nicknames = [];
  for (const c of wssRef.clients) {
    if (c.readyState !== c.OPEN) continue;
    if (!c.nickname) continue;
    if (seen.has(c.nickname)) continue;
    seen.add(c.nickname);
    nicknames.push(c.nickname);
  }
  nicknames.sort((a, b) => a.localeCompare(b, 'ko'));
  send(ws, { type: 'online_list', nicknames });
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
  room.playerIds[0] = ws.clientId || null;
  ws.roomCode = code;
  ws.color = 'black';
  ws.role = 'player';
  ws.nickname = room.nicknames[0];
  setRoom(code, room);
  // 방장에게도 sessionId 부여 — 대기 중 끊김 발생 시 resume_session 으로 복구 가능하게 함 (이슈 #9)
  const sid = attachSession(ws, room, 'black');
  send(ws, { type: 'room_created', code, sessionId: sid });
  broadcastRoomsList();
  log.event('room_created', { code, by: ws.nickname });
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
  room.playerIds[1] = ws.clientId || null;
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

// bot offer 타이머는 queue entry 에 부착 — ws 가 reconnect 로 교체돼도 상태 유지.
// 이미 발송된 적 있으면 중복 발송 안 함; 처음 발송이면 joinedAt 기준 남은 시간만 대기.
// (이슈: 비행기모드 reconnect 시 봇 제안이 한 번 더 떴음.)
const scheduleBotOfferIfNeeded = (entry) => {
  if (entry.botOfferSentAt) return;
  if (entry.botOfferTimer) clearTimeout(entry.botOfferTimer);
  const remaining = Math.max(0, BOT_OFFER_DELAY_MS - (Date.now() - entry.joinedAt));
  entry.botOfferTimer = setTimeout(() => {
    entry.botOfferTimer = null;
    entry.botOfferSentAt = Date.now();
    const liveWs = connections.getWsByConnectionId(entry.connectionId);
    if (liveWs && liveWs.readyState === liveWs.OPEN) {
      send(liveWs, { type: 'bot_offer' });
    }
  }, remaining);
};

const clearBotOfferTimer = (entry) => {
  if (entry && entry.botOfferTimer) {
    clearTimeout(entry.botOfferTimer);
    entry.botOfferTimer = null;
  }
};

const onQueueJoin = (ws, msg) => {
  if (ws.roomCode) return send(ws, { type: 'error', message: '이미 방에 있어요' });
  ws.nickname = sanitizeNick(msg.nickname) || '익명';
  // 클라이언트 식별자 (같은 브라우저에서 온 요청 dedupe 용도) — connection registry 에도 반영.
  if (typeof msg.clientId === 'string' && msg.clientId.length > 0 && msg.clientId.length <= 64) {
    connections.bindClient(ws, msg.clientId);
  }

  const q = getQueue();
  const myCid = ws.connectionId;

  // 같은 connection 이 큐에 이미 있으면 status 재발송만 (FE bug / 재발송 보호).
  if (q.some((e) => e.connectionId === myCid)) {
    return send(ws, { type: 'queue_waiting' });
  }

  // 같은 clientId 의 좀비 큐 항목 정리 + 옛 entry 의 timer/sent 상태 상속.
  // (이슈 #5/#6, 그리고 비행기모드 reconnect: 옛 ws 가 close 안 됐는데 새 ws 가 reconnect 한 경우)
  let inheritedJoinedAt = null;
  let inheritedSentAt   = null;
  if (ws.clientId) {
    for (let i = q.length - 1; i >= 0; i--) {
      const e = q[i];
      if (e.connectionId !== myCid && e.clientId === ws.clientId) {
        q.splice(i, 1);
        clearBotOfferTimer(e);
        // 가장 마지막에 본 옛 entry 의 시각 정보 상속 (보통 1개).
        inheritedJoinedAt = e.joinedAt;
        if (e.botOfferSentAt) inheritedSentAt = e.botOfferSentAt;
        const staleWs = connections.getWsByConnectionId(e.connectionId);
        if (staleWs) {
          staleWs.inQueue = false;
          if (staleWs.readyState === staleWs.OPEN) {
            send(staleWs, { type: 'queue_canceled', reason: 'replaced' });
          }
        }
      }
    }
  }

  // 매칭 상대 찾기 — 다른 connection 이고 같은 clientId 가 아닌 항목
  const idx = q.findIndex((e) => {
    if (e.connectionId === myCid) return false;
    if (ws.clientId && e.clientId && e.clientId === ws.clientId) return false;
    const w = connections.getWsByConnectionId(e.connectionId);
    return w && w.readyState === w.OPEN;
  });

  const makeMyEntry = () => ({
    connectionId: myCid,
    clientId: ws.clientId || null,
    nickname: ws.nickname,
    joinedAt: inheritedJoinedAt || Date.now(),
    botOfferTimer: null,
    botOfferSentAt: inheritedSentAt,
  });

  if (idx >= 0) {
    const oppEntry = q.splice(idx, 1)[0];
    clearBotOfferTimer(oppEntry);
    const opponent = connections.getWsByConnectionId(oppEntry.connectionId);
    if (!opponent) {
      // opponent ws 가 race 로 사라진 경우 — re-enqueue self 로 fallback.
      const myEntry = makeMyEntry();
      enqueue(myEntry);
      ws.inQueue = true;
      scheduleBotOfferIfNeeded(myEntry);
      return send(ws, { type: 'queue_waiting' });
    }
    opponent.inQueue = false;
    const code = genCode();
    const room = createRoom(code);
    room.players[0] = opponent;
    room.nicknames[0] = opponent.nickname || oppEntry.nickname || '익명';
    room.playerIds[0] = opponent.clientId || oppEntry.clientId || null;
    opponent.roomCode = code; opponent.color = 'black'; opponent.role = 'player';
    room.players[1] = ws;
    room.nicknames[1] = ws.nickname;
    room.playerIds[1] = ws.clientId || null;
    ws.roomCode = code; ws.color = 'white'; ws.role = 'player';
    setRoom(code, room);
    // 자동매칭 후에도 방 코드 부여 (관전자 모집용)
    send(opponent, { type: 'matched', code });
    send(ws,       { type: 'matched', code });
    log.event('queue_matched', { code, a: opponent.nickname, b: ws.nickname });
    startGame(room);
  } else {
    const myEntry = makeMyEntry();
    enqueue(myEntry);
    ws.inQueue = true;
    send(ws, { type: 'queue_waiting' });
    // bot 제안 타이머: 옛 entry 가 이미 발송했었다면 다시 보내지 않음.
    //                  처음이면 joinedAt 기준 남은 시간만 대기.
    scheduleBotOfferIfNeeded(myEntry);
  }
};

const onQueueLeave = (ws) => {
  if (ws.connectionId) {
    const entry = dequeueByConnectionId(ws.connectionId);
    if (entry) clearBotOfferTimer(entry);
  }
  ws.inQueue = false;
};

// ============================================================
// 봇 게임 생성 — 사용자 + 봇 즉시 매칭, 곧바로 게임 시작
// first: 'me' | 'bot' | 'random' (선공 누가)
// difficulty: 'easy' | 'medium' | 'hard'
// ============================================================
const onCreateBotGame = (ws, msg) => {
  if (ws.roomCode) return send(ws, { type: 'error', message: '이미 방에 있어요' });
  const difficulty = VALID_DIFFICULTIES.has(msg.difficulty) ? msg.difficulty : 'medium';
  let firstChoice = msg.first;
  if (firstChoice === 'random') firstChoice = Math.random() < 0.5 ? 'me' : 'bot';
  if (firstChoice !== 'me' && firstChoice !== 'bot') firstChoice = 'me';
  onQueueLeave(ws);

  const code = genCode();
  const room = createRoom(code);
  room.hasBot = true;
  room.botEmoteState = newBotEmoteState();

  const userColor = (firstChoice === 'me') ? 'black' : 'white';
  const botColor  = otherColor(userColor);
  const userIdx = colorIndex(userColor);
  const botIdx  = colorIndex(botColor);

  // 사용자 배치
  room.players[userIdx] = ws;
  room.nicknames[userIdx] = sanitizeNick(msg.nickname) || ws.nickname || '익명';
  room.playerIds[userIdx] = ws.clientId || null;
  ws.roomCode = code;
  ws.color = userColor;
  ws.role = 'player';
  ws.nickname = room.nicknames[userIdx];

  // 봇 배치
  const botWs = makeBotWs(difficulty);
  botWs.roomCode = code;
  botWs.color = botColor;
  botWs.role = 'player';
  room.players[botIdx] = botWs;
  room.nicknames[botIdx] = botWs.nickname;
  room.playerIds[botIdx] = botWs.clientId;

  setRoom(code, room);
  startGame(room);

  // 시작 직후 봇 인사 시도 + 봇이 흑이면 첫 수 스케줄링.
  setTimeout(() => tryBotEmote(room, 'game_start'), 800);
  if (room.turn === botColor) scheduleBotMove(room);
};

const onBotOfferAccept = (ws, msg) => {
  // 큐에서 빠지고 봇 게임 생성으로 합류.
  onQueueLeave(ws);
  onCreateBotGame(ws, msg);
};

const onBotOfferDecline = (_ws) => {
  // 사용자가 봇 제안을 거절 — 큐는 그대로 유지. timer 는 이미 발화돼 fire 됐고,
  // entry.botOfferSentAt 도 세팅된 상태라 같은 entry 에 대해서 다시 발송되지 않음.
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
  const idx = colorIndex(sess.color);
  if (room.disconnectTimers[sess.color]) {
    clearTimeout(room.disconnectTimers[sess.color]);
    room.disconnectTimers[sess.color] = null;
  }
  room.players[idx] = ws;
  ws.roomCode = room.code;
  ws.color = sess.color;
  ws.role = 'player';
  // 세션의 ws 매핑 갱신 — 재접속한 새 ws 가 이 sid 의 현재 활성 연결이 된다.
  connections.bindSession(ws, sid);
  if (sess.clientId) connections.bindClient(ws, sess.clientId);
  if (msg.nickname) {
    const n = sanitizeNick(msg.nickname) || room.nicknames[idx];
    room.nicknames[idx] = n;
    ws.nickname = n;
  } else {
    ws.nickname = room.nicknames[idx];
  }
  const opp = room.players[colorIndex(otherColor(sess.color))];
  if (opp) send(opp, { type: 'opponent_reconnected', color: sess.color });
  forEachSpectatorWs(room, (ws) => send(ws, { type: 'opponent_reconnected', color: sess.color }));
  send(ws, {
    type: 'resume_success',
    code: room.code,
    gameId: room.gameId,
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
  log.event('session_resumed', { sid: log.mask(sid), code: room.code, color: sess.color });
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

  // ---- 렌주룰 (흑 전용) ----
  // 1) 정확히 5 만들면 승리 우선 (금수 예외).
  // 2) 그 외 금수(장목/쌍사/쌍삼)는 거부 + 돌 되돌리기.
  const winLine = checkWinRenju(room.board, row, col, ws.color);
  if (!winLine && ws.color === 'black') {
    const forbidden = checkForbidden(room.board, row, col, ws.color);
    if (forbidden) {
      room.board[row][col] = 0;  // 되돌리기
      return send(ws, {
        type: 'error',
        message: `금수 — ${FORBIDDEN_LABEL[forbidden.reason] || forbidden.reason}`,
        reason: 'forbidden',
      });
    }
  }

  room.lastMove = [row, col];

  if (winLine) {
    room.status = 'over';
    room.winner = ws.color;
    room.winLine = winLine;
    room.loser = otherColor(ws.color);
    clearTurnTimer(room);
    broadcastRoom(room, { type: 'move', row, col, color: ws.color });
    broadcastRoom(room, { type: 'game_over', winner: ws.color, line: winLine, gameId: room.gameId, playerIds: room.playerIds });
    broadcastRoomsList();
    log.event('game_over', { code: room.code, gameId: room.gameId, winner: ws.color, reason: 'five' });
  } else if (isDraw(room.board)) {
    room.status = 'over';
    room.winner = 'draw';
    room.loser = null;
    clearTurnTimer(room);
    broadcastRoom(room, { type: 'move', row, col, color: ws.color });
    broadcastRoom(room, { type: 'game_over', winner: 'draw', line: null, gameId: room.gameId, playerIds: room.playerIds });
    broadcastRoomsList();
    log.event('game_over', { code: room.code, gameId: room.gameId, winner: 'draw', reason: 'draw' });
  } else {
    room.turn = otherColor(room.turn);
    broadcastRoom(room, { type: 'move', row, col, color: ws.color, turn: room.turn });
    startTurnTimer(room);
  }
  afterSuccessfulMove(room, ws);
};

const onRematch = (ws) => {
  if (!ws.roomCode || ws.role !== 'player') return;
  const room = getRoom(ws.roomCode);
  if (!room || room.status !== 'over') return;
  room.rematchVotes.add(ws.color);
  // 봇은 자동으로 재대국 동의
  if (room.hasBot) {
    const bot = room.players.find((p) => p && p.isBot);
    if (bot) room.rematchVotes.add(bot.color);
  }
  if (room.rematchVotes.size < 2) {
    broadcastRoom(room, { type: 'rematch_pending', who: ws.color });
    return;
  }
  // 패자 선공
  if (room.loser === 'white') {
    [room.players[0], room.players[1]] = [room.players[1], room.players[0]];
    [room.nicknames[0], room.nicknames[1]] = [room.nicknames[1], room.nicknames[0]];
    [room.playerIds[0], room.playerIds[1]] = [room.playerIds[1], room.playerIds[0]];
    room.players[0].color = 'black';
    room.players[1].color = 'white';
  }
  startGame(room);
  // 봇이 흑(선공) 이라면 첫 수 스케줄링
  if (room.hasBot) {
    if (room.botEmoteState) room.botEmoteState = newBotEmoteState();  // emote 쿨다운 리셋
    const bot = room.players.find((p) => p && p.isBot);
    if (bot && room.turn === bot.color) scheduleBotMove(room);
    setTimeout(() => tryBotEmote(room, 'game_start'), 800);
  }
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
  cancelBotTimers(room);
  if (room.disconnectTimers.black) clearTimeout(room.disconnectTimers.black);
  if (room.disconnectTimers.white) clearTimeout(room.disconnectTimers.white);

  const opp = room.players[colorIndex(otherColor(ws.color))];

  // 대전 중에 나가면 → 상대 승리로 처리
  if (room.status === 'playing') {
    const winnerColor = otherColor(ws.color);
    room.status = 'over';
    room.winner = winnerColor;
    if (opp) send(opp, { type: 'game_over', winner: winnerColor, line: null, gameId: room.gameId, reason: 'opponent_left' });
    forEachSpectatorWs(room, (s) => send(s, { type: 'game_over', winner: winnerColor, line: null, gameId: room.gameId, reason: 'opponent_left' }));
    log.event('game_over', { code: room.code, gameId: room.gameId, winner: winnerColor, reason: 'opponent_left' });
  } else {
    // 대기/종료 상태에서 나감 → 기존대로 상대만 통보
    if (opp) send(opp, { type: 'opponent_left' });
    forEachSpectatorWs(room, (s) => send(s, { type: 'opponent_left' }));
  }

  if (opp) {
    opp.roomCode = null; opp.color = null; opp.role = null;
    dropSession(opp.sessionId); opp.sessionId = null;
  }
  forEachSpectatorWs(room, (s) => { s.roomCode = null; s.role = null; });
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

  // 봇 게임에서 사람이 끊기면 grace 없이 즉시 종료 (봇 혼자 남아있을 이유 없음).
  if (room.hasBot) {
    // 워커가 계산 중인 봇 수가 stale 결과로 들어오는 걸 막기 위해 status 먼저 변경.
    room.status = 'over';
    cancelBotTimers(room);
    clearTurnTimer(room);
    if (room.disconnectTimers.black) clearTimeout(room.disconnectTimers.black);
    if (room.disconnectTimers.white) clearTimeout(room.disconnectTimers.white);
    dropSession(ws.sessionId); ws.sessionId = null;
    deleteRoom(room.code);
    broadcastRoomsList();
    return;
  }

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
  forEachSpectatorWs(room, (s) => send(s, { type: 'opponent_disconnected', color: myColor, deadline }));
  room.players[colorIndex(myColor)] = null;
  if (room.disconnectTimers[myColor]) clearTimeout(room.disconnectTimers[myColor]);
  room.disconnectTimers[myColor] = setTimeout(() => finalizeAbandon(room, myColor), DISCONNECT_GRACE_MS);
};

const finalizeAbandon = (room, color) => {
  // 게임 중에 안 돌아온 경우 — 기존 동작 유지 (opponent_abandoned 알림, status='over' 로 전환)
  if (room.status === 'playing') {
    room.status = 'over';
    for (const p of room.players) if (p) send(p, { type: 'opponent_abandoned', color, gameId: room.gameId });
    forEachSpectatorWs(room, (s) => send(s, { type: 'opponent_abandoned', color, gameId: room.gameId }));
    clearTurnTimer(room);
    dropSession(room.sessionIds[colorIndex(color)]);
    room.sessionIds[colorIndex(color)] = null;
    broadcastRoomsList();
    log.event('game_over', { code: room.code, gameId: room.gameId, winner: otherColor(color), reason: 'abandoned' });
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
    forEachSpectatorWs(room, (s) => {
      send(s, { type: 'opponent_left' });
      s.roomCode = null; s.role = null;
    });
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
