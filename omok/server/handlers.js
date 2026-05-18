// ============================================================
// WS 메시지 처리 + 차례 타이머 + 재연결 grace + 관전자 + 게임 흐름
// ============================================================

const {
  getRoom, setRoom, deleteRoom, getRoomsList,
  getSession, dropSession,
  getQueue, enqueue, dequeueByConnectionId,
  getOnline,
  genCode, genGameId, sanitizeNick,
  createRoom, createPlayerSession, clearPlayerSession, attachSpectatorSession,
} = require('./rooms');
const connections = require('./connections');
const roomRuntime = require('./room-runtime');
const { emptyBoard, checkWin, isDraw, BOARD_SIZE } = require('./game-logic');
const { checkForbidden, checkWinRenju, FORBIDDEN_LABEL } = require('./renju');
const {
  BOT_IDS, BOT_NICKNAMES, VALID_DIFFICULTIES,
  decideBotEmote, recordBotEmote, newBotEmoteState, thinkTimeMs,
} = require('./bot');
// generateMove 는 워커 풀의 async 래퍼 사용 — 메인 이벤트 루프 블로킹 회피.
const { generateMoveAsync } = require('./bot-pool');
const log = require('./log');

const TURN_TIMEOUT_MS                = Number(process.env.TURN_TIMEOUT_MS)                || 30000;
const DISCONNECT_GRACE_MS            = Number(process.env.DISCONNECT_GRACE_MS)            || 30000;
const SPECTATOR_DISCONNECT_GRACE_MS  = Number(process.env.SPECTATOR_DISCONNECT_GRACE_MS)  || 30000;
const EMOTE_COOLDOWN_MS              = Number(process.env.EMOTE_COOLDOWN_MS)              || 800;
const BOT_OFFER_DELAY_MS             = Number(process.env.BOT_OFFER_DELAY_MS)             || 10000;

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
// ws 가 죽어있으면(close 직후) 무시.
const forEachSpectatorWs = (room, fn) => {
  for (const sid of room.spectatorSessionIds) {
    const ws = connections.getWsBySessionId(sid);
    if (ws && ws.readyState === ws.OPEN) fn(ws, sid);
  }
};

// Player Actor 추상화 — 사람과 봇을 색깔 기준으로 다룬다. room 안에 ws 가 없으므로
// 송신은 sessionId → ws lookup 으로 처리. 봇은 transport 가 없으므로 송신 no-op.
const sendToPlayer = (room, color, msg) => {
  const slot = room.players[color];
  if (!slot) return false;
  if (slot.type === 'bot') return true;  // 봇에게 UI 메시지 전송 불필요
  return sendToSession(slot.sessionId, msg);
};

const forEachPlayerWs = (room, fn) => {
  for (const color of ['black', 'white']) {
    const slot = room.players[color];
    if (!slot || slot.type !== 'human') continue;
    const ws = connections.getWsBySessionId(slot.sessionId);
    if (ws && ws.readyState === ws.OPEN) fn(ws, color, slot);
  }
};

const broadcastRoom = (room, msg) => {
  for (const color of ['black', 'white']) sendToPlayer(room, color, msg);
  forEachSpectatorWs(room, (ws) => send(ws, msg));
};

// game_over / game_start 같은 곳에서 발송하는 player metadata payload.
// FE 가 black/white 둘 다 알아야 할 때 일관되게 사용.
const playerIdsPayload = (room) => ({
  black: room.players.black?.playerId || null,
  white: room.players.white?.playerId || null,
});

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

const otherColor = (c) => (c === 'black' ? 'white' : 'black');

// ============================================================
// 봇은 ws shim 을 만들지 않고 room.players[color] 의 metadata 만으로 표현.
// onMove 같은 ws 기반 핸들러를 봇이 직접 호출하지 않고, scheduleBotMove → applyBotMove
// 라는 별도 경로를 통해 게임 로직을 진행. (이슈 #31 Phase 1)
// ============================================================
const getBotColor = (room) => {
  if (!room.hasBot) return null;
  if (room.players.black?.type === 'bot') return 'black';
  if (room.players.white?.type === 'bot') return 'white';
  return null;
};

// ============================================================
// 봇 행동 — emote / 다음 수 스케줄링
// ============================================================
const tryBotEmote = (room, trigger) => {
  if (!room || !room.hasBot) return;
  const botColor = getBotColor(room);
  if (!botColor) return;
  const bot = room.players[botColor];
  if (!room.botEmoteState) room.botEmoteState = newBotEmoteState();
  const key = decideBotEmote({
    board: room.board, botColor, difficulty: bot.difficulty,
    trigger, emoteState: room.botEmoteState, now: Date.now(),
  });
  if (!key) return;
  const e = EMOTES[key];
  if (!e) return;
  recordBotEmote(room.botEmoteState, key, Date.now());
  broadcastRoom(room, { type: 'emote', from: botColor, key, emoji: e.emoji, text: e.text });
};

// 봇 차례 → 워커 풀에 generateMove 요청 → 결과를 applyMove 로 적용.
// onMove 는 사람 ws 입력 전용 (rate-limit/validators 가 들어옴). 봇은 그 경로를 우회.
const scheduleBotMove = (room) => {
  if (!room || !room.hasBot) return;
  if (room.status !== 'playing') return;
  const botColor = getBotColor(room);
  if (!botColor) return;
  const bot = room.players[botColor];
  if (room.turn !== botColor) return;
  const delay = thinkTimeMs(bot.difficulty);
  const code = room.code;
  roomRuntime.setTimer(code, 'botMoveTimer', setTimeout(() => {
    roomRuntime.clearTimer(code, 'botMoveTimer');
    if (room.status !== 'playing') return;
    if (room.turn !== botColor) return;
    // 보드 스냅샷을 워커로 보내 비동기로 계산. 메인 이벤트 루프는 그동안 자유.
    // 워커가 결과를 돌려줄 시점에 게임 상태가 변했을 수 있으니(사용자 leave / 타임아웃 등)
    // 한 번 더 검증 후 applyMove 호출.
    generateMoveAsync(room.board, botColor, bot.difficulty).then((move) => {
      if (!move) return;
      const current = getRoom(code);
      if (!current || current !== room) return;          // 방이 사라졌거나 교체됨
      if (room.status !== 'playing') return;             // 게임 종료 / 사용자 이탈
      if (room.turn !== botColor) return;                // 차례가 다른 색으로 넘어감 (타임아웃 등)
      if (room.board[move[0]][move[1]] !== 0) return;    // 그 칸이 이미 채워짐 (방어적)
      applyMove(room, botColor, move[0], move[1], { actor: 'bot' });
    }).catch((err) => {
      console.error('[bot] generateMoveAsync 실패:', err && err.message);
    });
  }, delay));
};

const cancelBotTimers = (room) => {
  if (!room) return;
  roomRuntime.clearTimer(room.code, 'botMoveTimer');
  // room.botOfferTimer 는 옛 코드의 잔재 (실제 set 안 됨) — 안전하게 정리.
  roomRuntime.clearTimer(room.code, 'botOfferTimer');
};

// 매 성공적인 move 직후 호출 — 봇 게임이면 emote / 다음 봇 차례 처리.
// movedByBot: 직전 수가 봇이 둔 거면 true. emote trigger 분기용.
const afterSuccessfulMove = (room, movedByBot) => {
  if (!room.hasBot) return;
  const botColor = getBotColor(room);
  if (!botColor) return;

  if (room.status === 'over') {
    if (room.winner === botColor) setTimeout(() => tryBotEmote(room, 'game_over_win'), 600);
    else if (room.winner && room.winner !== 'draw') setTimeout(() => tryBotEmote(room, 'game_over_lose'), 600);
    cancelBotTimers(room);
    return;
  }
  // 진행 중: 직전 수가 봇/사람 분기 → 적절한 emote → 봇 차례면 다음 수 스케줄
  const trigger = movedByBot ? 'bot_moved' : 'opponent_moved';
  setTimeout(() => tryBotEmote(room, trigger), 300);
  if (room.turn === botColor) scheduleBotMove(room);
};

// ============================================================
// 차례 타이머
// ============================================================
const startTurnTimer = (room) => {
  clearTurnTimer(room);
  room.turnDeadline = Date.now() + TURN_TIMEOUT_MS;
  roomRuntime.setTimer(room.code, 'turnTimer', setTimeout(() => onTurnTimeout(room), TURN_TIMEOUT_MS));
  broadcastRoom(room, { type: 'turn_started', turn: room.turn, deadline: room.turnDeadline });
};

const clearTurnTimer = (room) => {
  roomRuntime.clearTimer(room.code, 'turnTimer');
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
    const botColor = getBotColor(room);
    if (botColor && room.turn === botColor) scheduleBotMove(room);
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
  // ws.sessionId 는 addSpectator 의 attachSpectatorSession 안에서 이미 세팅돼있음.
  // FE 가 sessionStorage 에 저장해서 reconnect 시 resume_session 으로 재합류.
  send(ws, {
    type: 'spectate_success',
    code: room.code,
    sessionId: ws.sessionId || null,
    nicknames: { black: room.players.black?.nickname || '', white: room.players.white?.nickname || '' },
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

// ============================================================
// 게임 시작/재시작 — 양쪽 플레이어 + 관전자 모두에게 알림
// ============================================================
// startGame 진입 시점: room.players.black / white 가 이미 metadata 로 채워져 있다고 가정
// (onJoinRoom / onQueueJoin 매칭 / onCreateBotGame / onRematch 가 setup 후 호출).
// 슬롯 안의 ws 는 이미 set up 되어 있고 connections 에도 바인딩되어 있어야 함 (rematch 외).
const startGame = (room) => {
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

  const blackSlot = room.players.black;
  const whiteSlot = room.players.white;
  const nicknames = { black: blackSlot.nickname, white: whiteSlot.nickname };
  const base = {
    type: 'game_start',
    code: room.code,
    gameId: room.gameId,
    board: room.board,
    turn: room.turn,
    nicknames,
    spectators: getSpectatorNames(room),
  };
  // 각 플레이어에게 본인 sessionId 와 함께 알림 (FE 가 sessionStorage 에 저장).
  sendToPlayer(room, 'black', { ...base, you: 'black', opponent: 'white', sessionId: blackSlot.sessionId });
  sendToPlayer(room, 'white', { ...base, you: 'white', opponent: 'black', sessionId: whiteSlot.sessionId });
  forEachSpectatorWs(room, (ws) => sendSpectatorState(ws, room));

  startTurnTimer(room);
  broadcastRoomsList();
  log.event('game_started', {
    code: room.code,
    gameId: room.gameId,
    black: blackSlot.nickname,
    white: whiteSlot.nickname,
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

// 접속자 닉네임 목록 — clientId 단위 dedupe (같은 브라우저의 멀티탭은 1명).
// clientId 가 없는 연결 (set_nickname 직전 짧은 윈도우) 은 닉네임 단위로 dedup.
// unique online count 와 동일한 기준으로 카운트/명단이 일치하도록.
const onRequestOnlineList = (ws) => {
  if (!wssRef) return;
  const byClient = new Map();    // clientId → 최신 nickname
  const noClient = new Set();    // clientId 없는 경우의 nickname 집합
  for (const c of wssRef.clients) {
    if (c.readyState !== c.OPEN) continue;
    if (!c.nickname) continue;
    if (c.clientId) {
      byClient.set(c.clientId, c.nickname);  // 같은 clientId 의 마지막 탭의 nickname 으로 갱신
    } else {
      noClient.add(c.nickname);
    }
  }
  const nicknames = [...byClient.values(), ...noClient];
  // 위 두 그룹 간에도 닉네임 겹침 가능성 — 한번 더 dedup
  const unique = Array.from(new Set(nicknames));
  unique.sort((a, b) => a.localeCompare(b, 'ko'));
  send(ws, { type: 'online_list', nicknames: unique });
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
  const nickname = sanitizeNick(msg.nickname) || '익명';
  ws.roomCode = code;
  ws.color = 'black';
  ws.role = 'player';
  ws.nickname = nickname;
  setRoom(code, room);
  // 방장에게도 sessionId 부여 — 대기 중 끊김 발생 시 resume_session 으로 복구 가능하게 함 (이슈 #9)
  const slot = createPlayerSession(room, 'black', {
    type: 'human', ws, clientId: ws.clientId || null, nickname,
  });
  send(ws, { type: 'room_created', code, sessionId: slot.sessionId });
  broadcastRoomsList();
  log.event('room_created', { code, by: nickname });
};

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
  startGame(room);
};

const onSpectateRoom = (ws, msg) => {
  if (ws.roomCode) return send(ws, { type: 'error', message: '이미 방에 있어요' });
  if (typeof msg.code !== 'string') return send(ws, { type: 'error', message: '방 코드를 입력하세요' });
  const code = msg.code.toUpperCase().trim();
  const room = getRoom(code);
  if (!room) return send(ws, { type: 'error', message: '존재하지 않는 방 코드예요' });
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

// 봇 제안 발송 이력 (clientId 단위) — queue 와 무관하게 유지.
// 비행기모드 reconnect race 방어: 옛 ws 의 close 가 새 ws 의 queue_join 보다 먼저 fire
// 되어 옛 entry 가 dequeue 된 경우에도, history 가 남아서 cooldown 으로 중복 발송 차단.
const botOfferSentByClientId = new Map();
const BOT_OFFER_COOLDOWN_MS = 60_000;  // 발송 후 같은 사용자에게 다시 발송 가능한 최소 간격.

// bot offer 타이머는 queue entry 에 부착 — ws 가 reconnect 로 교체돼도 상태 유지.
// 추가로 clientId 단위 history 도 확인 (entry 가 close→reconnect race 로 사라진 경우 대비).
const scheduleBotOfferIfNeeded = (entry) => {
  if (entry.botOfferSentAt) return;
  // clientId 별 cooldown 검사 — 최근에 발송한 적 있으면 entry 에 표시만 하고 timer 안 켬.
  if (entry.clientId) {
    const last = botOfferSentByClientId.get(entry.clientId);
    if (last && (Date.now() - last) < BOT_OFFER_COOLDOWN_MS) {
      entry.botOfferSentAt = last;
      return;
    }
  }
  if (entry.botOfferTimer) clearTimeout(entry.botOfferTimer);
  const remaining = Math.max(0, BOT_OFFER_DELAY_MS - (Date.now() - entry.joinedAt));
  entry.botOfferTimer = setTimeout(() => {
    entry.botOfferTimer = null;
    const now = Date.now();
    entry.botOfferSentAt = now;
    if (entry.clientId) {
      botOfferSentByClientId.set(entry.clientId, now);
      // Lazy cleanup — cooldown 의 2배 지난 항목 제거 (메모리 누수 방지).
      for (const [cid, ts] of botOfferSentByClientId) {
        if (now - ts > BOT_OFFER_COOLDOWN_MS * 2) botOfferSentByClientId.delete(cid);
      }
    }
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
    const blackNick = opponent.nickname || oppEntry.nickname || '익명';
    const whiteNick = ws.nickname;
    opponent.roomCode = code; opponent.color = 'black'; opponent.role = 'player';
    ws.roomCode = code; ws.color = 'white'; ws.role = 'player';
    setRoom(code, room);
    createPlayerSession(room, 'black', {
      type: 'human', ws: opponent, clientId: opponent.clientId || oppEntry.clientId || null, nickname: blackNick,
    });
    createPlayerSession(room, 'white', {
      type: 'human', ws, clientId: ws.clientId || null, nickname: whiteNick,
    });
    // 자동매칭 후에도 방 코드 부여 (관전자 모집용)
    send(opponent, { type: 'matched', code });
    send(ws,       { type: 'matched', code });
    log.event('queue_matched', { code, a: blackNick, b: whiteNick });
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

  // 사용자 배치
  const userNick = sanitizeNick(msg.nickname) || ws.nickname || '익명';
  ws.roomCode = code;
  ws.color = userColor;
  ws.role = 'player';
  ws.nickname = userNick;
  createPlayerSession(room, userColor, {
    type: 'human', ws, clientId: ws.clientId || null, nickname: userNick,
  });

  // 봇 배치 — ws shim 없이 metadata 만.
  createPlayerSession(room, botColor, {
    type: 'bot', ws: null,
    clientId: BOT_IDS[difficulty],
    playerId: BOT_IDS[difficulty],
    nickname: BOT_NICKNAMES[difficulty],
    difficulty,
  });

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
    status: room.status,
    winner: room.winner,
    line: room.winLine,
    lastMove: room.lastMove,
    turnDeadline: room.turnDeadline || null,
    spectators: getSpectatorNames(room),
  });
  log.event('session_resumed', { sid: log.mask(sid), code: room.code, color: sess.color });
};

// 사람 ws 가 보낸 move — 검증 후 applyMove 로 위임.
const onMove = (ws, row, col) => {
  if (!ws.roomCode || ws.role !== 'player') return;
  const room = getRoom(ws.roomCode);
  if (!room || room.status !== 'playing') return;
  if (room.turn !== ws.color) return send(ws, { type: 'error', message: '당신 차례가 아니에요' });
  if (typeof row !== 'number' || typeof col !== 'number') return;
  if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return;
  if (room.board[row][col] !== 0) return send(ws, { type: 'error', message: '이미 돌이 있어요' });
  applyMove(room, ws.color, row, col, { actor: 'human', humanWs: ws });
};

// 사람/봇 공통 move 적용 — 게임 상태 갱신 + broadcast + 다음 턴 처리.
// opts.actor: 'human' | 'bot'. humanWs 는 actor='human' 일 때 forbidden error 응답용.
const applyMove = (room, color, row, col, opts) => {
  const stone = color === 'black' ? 1 : 2;
  room.board[row][col] = stone;

  // ---- 렌주룰 (흑 전용) ----
  const winLine = checkWinRenju(room.board, row, col, color);
  if (!winLine && color === 'black') {
    const forbidden = checkForbidden(room.board, row, col, color);
    if (forbidden) {
      room.board[row][col] = 0;  // 되돌리기
      if (opts.actor === 'human' && opts.humanWs) {
        send(opts.humanWs, {
          type: 'error',
          message: `금수 — ${FORBIDDEN_LABEL[forbidden.reason] || forbidden.reason}`,
          reason: 'forbidden',
        });
      }
      return;
    }
  }

  room.lastMove = [row, col];
  const playerIds = playerIdsPayload(room);

  if (winLine) {
    room.status = 'over';
    room.winner = color;
    room.winLine = winLine;
    room.loser = otherColor(color);
    clearTurnTimer(room);
    broadcastRoom(room, { type: 'move', row, col, color });
    broadcastRoom(room, { type: 'game_over', winner: color, line: winLine, gameId: room.gameId, playerIds });
    broadcastRoomsList();
    log.event('game_over', { code: room.code, gameId: room.gameId, winner: color, reason: 'five' });
  } else if (isDraw(room.board)) {
    room.status = 'over';
    room.winner = 'draw';
    room.loser = null;
    clearTurnTimer(room);
    broadcastRoom(room, { type: 'move', row, col, color });
    broadcastRoom(room, { type: 'game_over', winner: 'draw', line: null, gameId: room.gameId, playerIds });
    broadcastRoomsList();
    log.event('game_over', { code: room.code, gameId: room.gameId, winner: 'draw', reason: 'draw' });
  } else {
    room.turn = otherColor(room.turn);
    broadcastRoom(room, { type: 'move', row, col, color, turn: room.turn });
    startTurnTimer(room);
  }
  afterSuccessfulMove(room, opts.actor === 'bot');
};

const onRematch = (ws) => {
  if (!ws.roomCode || ws.role !== 'player') return;
  const room = getRoom(ws.roomCode);
  if (!room || room.status !== 'over') return;
  room.rematchVotes.add(ws.color);
  // 봇은 자동으로 재대국 동의
  if (room.hasBot) {
    const botColor = getBotColor(room);
    if (botColor) room.rematchVotes.add(botColor);
  }
  if (room.rematchVotes.size < 2) {
    broadcastRoom(room, { type: 'rematch_pending', who: ws.color });
    return;
  }
  // 패자 선공 — black/white 슬롯을 swap. 옛 sessionId 의 color 정보도 업데이트.
  if (room.loser === 'white') {
    const blackSlot = room.players.black;
    const whiteSlot = room.players.white;
    room.players.black = whiteSlot;
    room.players.white = blackSlot;
    // sessions 안의 color 필드도 동기화. ws 의 color 도.
    if (whiteSlot?.sessionId) {
      const sess = getSession(whiteSlot.sessionId);
      if (sess) sess.color = 'black';
      const w = connections.getWsBySessionId(whiteSlot.sessionId);
      if (w) w.color = 'black';
    }
    if (blackSlot?.sessionId) {
      const sess = getSession(blackSlot.sessionId);
      if (sess) sess.color = 'white';
      const w = connections.getWsBySessionId(blackSlot.sessionId);
      if (w) w.color = 'white';
    }
  }
  startGame(room);
  // 봇이 흑(선공) 이라면 첫 수 스케줄링
  if (room.hasBot) {
    if (room.botEmoteState) room.botEmoteState = newBotEmoteState();  // emote 쿨다운 리셋
    const botColor = getBotColor(room);
    if (botColor && room.turn === botColor) scheduleBotMove(room);
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
  roomRuntime.clearAllDisconnectTimers(room.code);

  const oppColor = otherColor(ws.color);
  const oppSlot = room.players[oppColor];
  const oppWs = oppSlot ? connections.getWsBySessionId(oppSlot.sessionId) : null;
  const playerIds = playerIdsPayload(room);

  // 대전 중에 나가면 → 상대 승리로 처리
  if (room.status === 'playing') {
    const winnerColor = oppColor;
    room.status = 'over';
    room.winner = winnerColor;
    sendToPlayer(room, oppColor, { type: 'game_over', winner: winnerColor, line: null, gameId: room.gameId, playerIds, reason: 'opponent_left' });
    forEachSpectatorWs(room, (s) => send(s, { type: 'game_over', winner: winnerColor, line: null, gameId: room.gameId, playerIds, reason: 'opponent_left' }));
    log.event('game_over', { code: room.code, gameId: room.gameId, winner: winnerColor, reason: 'opponent_left' });
  } else {
    sendToPlayer(room, oppColor, { type: 'opponent_left' });
    forEachSpectatorWs(room, (s) => send(s, { type: 'opponent_left' }));
  }

  if (oppWs) {
    oppWs.roomCode = null; oppWs.color = null; oppWs.role = null;
    oppWs.sessionId = null;
  }
  forEachSpectatorWs(room, (s) => { s.roomCode = null; s.role = null; });
  ws.sessionId = null;
  // deleteRoom 이 양쪽 슬롯 + spectator sessions 모두 dropSession 처리.
  roomRuntime.dispose(room.code);
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

  // 봇 게임이라도 사람 게임과 완전히 동일한 흐름.
  // turn timer / 봇 timer 멈추지 않음 — 사용자가 끊긴 동안에도 봇은 자기 차례면 응수하고,
  // turn_skipped 가 발생하면 봇이 둠. 두 timer (turn / disconnect grace) 가 동시에 흘러
  // 어느 쪽이든 먼저 만료되는 쪽이 종료 trigger. 사람 + 봇 둘 다 멈춘 채 방이 방치되는
  // 상황 방지.
  const myColor = ws.color;
  const deadline = Date.now() + DISCONNECT_GRACE_MS;
  // slot 자체는 nullify 하지 않는다 (resume 시 메타 그대로 사용). ws 만 끊겼으니
  // sendToSession 은 자연히 no-op.
  sendToPlayer(room, otherColor(myColor), { type: 'opponent_disconnected', color: myColor, deadline });
  forEachSpectatorWs(room, (s) => send(s, { type: 'opponent_disconnected', color: myColor, deadline }));
  roomRuntime.setDisconnectTimer(room.code, myColor, setTimeout(() => finalizeAbandon(room, myColor), DISCONNECT_GRACE_MS));
};

const finalizeAbandon = (room, color) => {
  const playerIds = playerIdsPayload(room);
  // 게임 중에 안 돌아온 경우 — opponent_abandoned 알림, status='over' 로 전환.
  // 봇 게임도 동일 흐름. 봇한테 sendToPlayer 는 자연히 no-op.
  if (room.status === 'playing') {
    room.status = 'over';
    for (const c of ['black', 'white']) sendToPlayer(room, c, { type: 'opponent_abandoned', color, gameId: room.gameId, playerIds });
    forEachSpectatorWs(room, (s) => send(s, { type: 'opponent_abandoned', color, gameId: room.gameId, playerIds }));
    clearTurnTimer(room);
    cancelBotTimers(room);
    clearPlayerSession(room, color);
    broadcastRoomsList();
    log.event('game_over', { code: room.code, gameId: room.gameId, winner: otherColor(color), reason: 'abandoned' });
    // 봇대전이면 rematch 의미 없으니 방 자체 폐쇄. 사람 대전은 status='over' 채로 유지
    // (남은 사람이 leave_room 누르거나 grace 만료될 때까지).
    if (room.hasBot) {
      roomRuntime.clearAllDisconnectTimers(room.code);
      roomRuntime.dispose(room.code);
      deleteRoom(room.code);
    }
    return;
  }
  // 대기 중(waiting) 또는 종료 후(over) 에 grace 동안 안 돌아온 경우 — 방 자체를 닫음.
  if (room.status === 'waiting' || room.status === 'over') {
    const oppColor = otherColor(color);
    const oppSlot = room.players[oppColor];
    const oppWs = oppSlot ? connections.getWsBySessionId(oppSlot.sessionId) : null;
    if (oppSlot) {
      sendToPlayer(room, oppColor, { type: 'opponent_left' });
      if (oppWs) {
        oppWs.roomCode = null; oppWs.color = null; oppWs.role = null;
        oppWs.sessionId = null;
      }
    }
    forEachSpectatorWs(room, (s) => {
      send(s, { type: 'opponent_left' });
      s.roomCode = null; s.role = null;
    });
    roomRuntime.clearAllDisconnectTimers(room.code);
    clearTurnTimer(room);
    roomRuntime.dispose(room.code);
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
