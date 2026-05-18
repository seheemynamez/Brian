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
const { checkForbidden, checkWinRenju, FORBIDDEN_LABEL } = require('./renju');
const {
  BOT_IDS, BOT_NICKNAMES, VALID_DIFFICULTIES,
  decideBotEmote, recordBotEmote, newBotEmoteState, thinkTimeMs,
} = require('./bot');
// generateMove 는 워커 풀의 async 래퍼 사용 — 메인 이벤트 루프 블로킹 회피.
const { generateMoveAsync } = require('./bot-pool');

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
  // clientId 도 함께 받아서 ws 에 기록 — 추후 게임 결과 기록 시 안정 식별자로 사용
  if (typeof msg.clientId === 'string' && msg.clientId.length > 0 && msg.clientId.length <= 64) {
    ws.clientId = msg.clientId;
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
    if (opponent.botOfferTimer) { clearTimeout(opponent.botOfferTimer); opponent.botOfferTimer = null; }
    const code = genCode();
    const room = createRoom(code);
    room.players[0] = opponent;
    room.nicknames[0] = opponent.nickname || '익명';
    room.playerIds[0] = opponent.clientId || null;
    opponent.roomCode = code; opponent.color = 'black'; opponent.role = 'player';
    room.players[1] = ws;
    room.nicknames[1] = ws.nickname;
    room.playerIds[1] = ws.clientId || null;
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
    // 큐 진입 후 BOT_OFFER_DELAY_MS 동안 매칭 안 되면 봇 제안 모달 트리거.
    if (ws.botOfferTimer) clearTimeout(ws.botOfferTimer);
    ws.botOfferTimer = setTimeout(() => {
      ws.botOfferTimer = null;
      if (!ws.inQueue) return;
      if (ws.readyState !== ws.OPEN) return;
      send(ws, { type: 'bot_offer' });
    }, BOT_OFFER_DELAY_MS);
  }
};

const onQueueLeave = (ws) => {
  dequeue(ws);
  ws.inQueue = false;
  if (ws.botOfferTimer) { clearTimeout(ws.botOfferTimer); ws.botOfferTimer = null; }
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

const onBotOfferDecline = (ws) => {
  // 단순히 타이머만 정리 — 사용자는 계속 큐 대기.
  if (ws.botOfferTimer) { clearTimeout(ws.botOfferTimer); ws.botOfferTimer = null; }
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
    broadcastRoom(room, { type: 'game_over', winner: ws.color, line: winLine, playerIds: room.playerIds });
    broadcastRoomsList();
  } else if (isDraw(room.board)) {
    room.status = 'over';
    room.winner = 'draw';
    room.loser = null;
    clearTurnTimer(room);
    broadcastRoom(room, { type: 'move', row, col, color: ws.color });
    broadcastRoom(room, { type: 'game_over', winner: 'draw', line: null, playerIds: room.playerIds });
    broadcastRoomsList();
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
