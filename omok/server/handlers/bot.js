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
  countStones,
} = require('../game/bot');
// generateMove 는 워커 풀의 async 래퍼 사용 — 메인 이벤트 루프 블로킹 회피.
const { generateMoveAsync } = require('../game/bot-pool');
const { send } = require('./send');
const { tryBotEmote } = require('./emote');
const {
  incrementToday, addTodaySetMember, pushTodayListItem,
} = require('../infra/daily-counter');

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
//
// Iterative Deepening (ID): bot.js 의 generateMove 가 워커 내부에서 depth 1 → 2 → ...
// → maxDepth 순차 탐색 + AbortController (timeoutMs 후 자동 abort). timeout 시
// 마지막 완성된 depth 의 best 반환 — 항상 그 깊이의 optimal 보장. 부분 탐색의
// best 보다 안전. 자세한 건 bot.js 의 generateMove comments.
//
// 로깅: 매 봇 수마다 cfg=d{cfgMax}×t{cfgTopK} reached=d{실제도달} elapsed=Xms.
//   - cfgMax 는 maxDepth (상한). reached 는 timeout 안에 완성된 최종 depth.
//   - 운영 중 reached < cfgMax 가 자주 보이면 cfg 줄이고 평가 함수 강화 등 검토.
//   - reached == cfgMax 면 cfg 더 올릴 여유 있다는 신호.
// 사람 zombie (Wi-Fi 잠시 lag — ws close 안 fire 됐지만 응답 없음) 상태에서
// 봇 차례 도래 시 짧은 retry 로 회복 대기. 진짜 끊김이면 grace timer (60s) 가 자연 정리.
// 이전엔 SKIP 후 사용자 새로고침 (resume_session) 까지 영원히 대기 → 봇 멈춤 사례 다발.
// PR #85 부터: RETRY 로 자동 회복. heartbeat pong 으로 wakeup 도 시도 (server.js).
const BOT_ZOMBIE_RETRY_MS = 3000;

const scheduleBotMove = (room) => {
  if (!room || !room.hasBot) return;
  if (room.status !== 'playing') return;
  const botColor = getBotColor(room);
  if (!botColor) return;
  const bot = room.players[botColor];
  if (room.turn !== botColor) return;
  // 사람 player 가 offline/zombie 면 SKIP 안 함 — 짧은 retry 로 회복 대기.
  // setTimer 가 같은 botMoveTimer 덮어쓰니 중복 호출돼도 안전.
  const { bothPlayersOnline } = require('./send');
  if (!bothPlayersOnline(room)) {
    // 사람의 clientId 도 같이 log — monitor 가 unique user 카운트 (issue #108
    // 같은 false positive 차단). log.mask 로 앞 8자만 (PII 보호).
    const { mask } = require('../infra/log');
    const humanColor = botColor === 'black' ? 'white' : 'black';
    const humanCidFull = room.players[humanColor]?.clientId;
    const humanCid = mask(humanCidFull);
    console.error(`[bot] schedule RETRY (사람 잠시 offline/zombie, ${BOT_ZOMBIE_RETRY_MS}ms 후 재시도): bot=${bot.difficulty} stones=${countStones(room.board)} room=${room.code} color=${botColor} client=${humanCid}`);
    // daily counter + SET (monitor 가 log fetch 없이 알 수 있게).
    incrementToday('bot_retry');
    addTodaySetMember('bot_retry_rooms', room.code);
    if (humanCidFull) addTodaySetMember('bot_retry_clients', humanCidFull);
    roomRuntime.setTimer(room.code, 'botMoveTimer', setTimeout(() => {
      roomRuntime.clearTimer(room.code, 'botMoveTimer');
      scheduleBotMove(room);
    }, BOT_ZOMBIE_RETRY_MS));
    return;
  }
  const delay = thinkTimeMs(bot.difficulty);
  const code = room.code;
  roomRuntime.setTimer(code, 'botMoveTimer', setTimeout(() => {
    roomRuntime.clearTimer(code, 'botMoveTimer');
    if (room.status !== 'playing') return;
    if (room.turn !== botColor) return;
    // search 시작 시점에 메타 snapshot (워커 결과 늦게 와도 stones 정확히 잡힘).
    const stonesAtStart = countStones(room.board);
    generateMoveAsync(room.board, botColor, bot.difficulty).then((result) => {
      const move = result && result.move;
      const cfgMax = result?.cfgMaxDepth ?? '?';
      const cfgTopK = result?.cfgTopK ?? '?';
      const reached = result?.reachedDepth ?? 0;
      const elapsed = result?.elapsedMs ?? 0;
      if (!move) {
        console.error(`[bot] search returned no move: bot=${bot.difficulty} stones=${stonesAtStart} cfg=d${cfgMax}×t${cfgTopK} reached=d${reached} elapsed=${elapsed}ms room=${code}`);
        incrementToday('no_move');
        return;
      }
      const current = getRoom(code);
      if (!current || current !== room) return;          // 방이 사라졌거나 교체됨
      if (room.status !== 'playing') return;             // 게임 종료 / 사용자 이탈
      if (room.turn !== botColor) return;                // 차례가 다른 색으로 넘어감 (타임아웃 등)
      if (room.board[move[0]][move[1]] !== 0) return;    // 그 칸이 이미 채워짐 (방어적)
      // Lazy require — game.js 가 bot.js 를 require 하므로 순환 방지.
      const { applyMove } = require('./game');
      applyMove(room, botColor, move[0], move[1], { actor: 'bot' });
      // 매 봇 수 — 성능 / 판단 / 시간 적절성 검토. cfg=상한 reached=실제도달 깊이.
      console.error(`[bot] move applied: bot=${bot.difficulty} stones=${stonesAtStart} (${stonesAtStart+1}번째 수) cfg=d${cfgMax}×t${cfgTopK} reached=d${reached} elapsed=${elapsed}ms move=[${move[0]},${move[1]}] room=${code}`);
      // raw move LIST push — monitor 가 cfgMax 도달율 / elapsed p50/p95 계산.
      // 로그 파싱 대체 (move applied log fetch 제거 가능).
      pushTodayListItem('bot_moves', {
        ts: new Date().toISOString(),
        diff: bot.difficulty,
        stones: stonesAtStart,
        cfgD: typeof cfgMax === 'number' ? cfgMax : null,
        cfgTopK: typeof cfgTopK === 'number' ? cfgTopK : null,
        reach: typeof reached === 'number' ? reached : null,
        elap: typeof elapsed === 'number' ? elapsed : null,
        room: code,
      });
    }).catch((err) => {
      // worker_timeout 또는 worker crash. ID + AbortController 가 정상 동작하면 매우 드뭄
      // (ID self-abort 가 worker timeout 22s 보다 빠르게 발동). 발생 시 봇 turn 진행 안 됨 —
      // turn timeout (30s) 자연 발동으로 다음 차례 토글. 사용자 명시: easy fallback 제거.
      console.error(`[bot] worker failed: ${err && err.message} | bot=${bot.difficulty} stones=${stonesAtStart} (${stonesAtStart+1}번째 수) room=${code} color=${botColor}`);
      incrementToday('worker_timeout');
    });
  }, delay));
};

const cancelBotTimers = (room) => {
  if (!room) return;
  roomRuntime.clearTimer(room.code, 'botMoveTimer');
};

// 사람 ws 가 zombie 에서 회복됐을 때 (heartbeat pong/ping 도착) 호출.
// 봇 차례 + 진행 중 게임이면 즉시 scheduleBotMove 로 wakeup.
// botMoveTimer 가 RETRY pending 중일 수 있어 setTimer 가 덮어쓰는 흐름.
// server.js 의 markWsAlive (false → true 전환 시) 에서 호출.
const tryReviveBotIfStuck = (roomCode) => {
  if (!roomCode) return;
  const room = getRoom(roomCode);
  if (!room || !room.hasBot || room.status !== 'playing') return;
  const botColor = getBotColor(room);
  if (!botColor || room.turn !== botColor) return;
  scheduleBotMove(room);
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
  tryReviveBotIfStuck,
  afterSuccessfulMove,
  onCreateBotGame,
};
