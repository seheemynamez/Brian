// ============================================================
// 봇 — 봇 게임 생성, 봇 차례 스케줄링, emote / 다음 수 처리.
// ws shim 없이 room.players[color] 의 metadata 만으로 표현.
// ============================================================

const {
  getRoom, setRoom, sanitizeNick,
  genCode,
  createRoom, createPlayerSession,
} = require('../domain/rooms');
const roomRuntime = require('../domain/room-runtime');
const {
  BOT_IDS, BOT_NICKNAMES, VALID_DIFFICULTIES,
  newBotEmoteState, thinkTimeMs,
} = require('../game/bot');
// generateMove 는 워커 풀의 async 래퍼 사용 — 메인 이벤트 루프 블로킹 회피.
const { generateMoveAsync } = require('../game/bot-pool');
const { send } = require('./send');
const { tryBotEmote } = require('./emote');

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

// 봇 차례 → 워커 풀에 generateMove 요청 → 결과를 applyMove 로 적용.
// onMove 는 사람 ws 입력 전용 (rate-limit/validators 가 들어옴). 봇은 그 경로를 우회.
const scheduleBotMove = (room) => {
  if (!room || !room.hasBot) return;
  if (room.status !== 'playing') return;
  const botColor = getBotColor(room);
  if (!botColor) return;
  const bot = room.players[botColor];
  if (room.turn !== botColor) return;
  // 사람 player 가 offline (좀비 ws — close 가 fire 안 된 채 응답 없는 상태) 이면
  // 봇이 두지 않음. 좀비 + turn timeout 으로 봇이 혼자 게임을 끝까지 진행해 사람이
  // 부재중 패배 처리되던 버그 방지.
  const { bothPlayersOnline } = require('./send');
  if (!bothPlayersOnline(room)) return;
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
      // Lazy require — game.js 가 bot.js 를 require 하므로 순환 방지.
      const { applyMove } = require('./game');
      applyMove(room, botColor, move[0], move[1], { actor: 'bot' });
    }).catch((err) => {
      console.error('[bot] generateMoveAsync 실패:', err && err.message);
    });
  }, delay));
};

const cancelBotTimers = (room) => {
  if (!room) return;
  roomRuntime.clearTimer(room.code, 'botMoveTimer');
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
  // Lazy require — queue.js 가 emote/spectator/send 등을 통해 간접적으로 우리를 참조.
  const { onQueueLeave } = require('./queue');
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
  // Lazy require — game.js depends on bot.js for afterSuccessfulMove.
  const { startGame } = require('./game');
  startGame(room);

  // 시작 직후 봇 인사 시도 + 봇이 흑이면 첫 수 스케줄링.
  setTimeout(() => tryBotEmote(room, 'game_start'), 800);
  if (room.turn === botColor) scheduleBotMove(room);
};

module.exports = {
  getBotColor,
  scheduleBotMove,
  cancelBotTimers,
  afterSuccessfulMove,
  onCreateBotGame,
};
