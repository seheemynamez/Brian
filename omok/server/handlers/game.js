// ============================================================
// 게임 흐름 — startGame / 차례 타이머 / move 검증 + 적용.
// ============================================================

const { getRoom, markRoomDirty, genGameId } = require('../domain/rooms');
const roomRuntime = require('../domain/room-runtime');
const { emptyBoard, isDraw, BOARD_SIZE } = require('../game/game-logic');
const { checkForbidden, checkWinRenju, FORBIDDEN_LABEL } = require('../game/renju');
const log = require('../infra/log');
const {
  send, sendToPlayer, forEachSpectatorWs, broadcastRoom,
  playerIdsPayload, playerStatusPayload, broadcastRoomsList,
  broadcastRankingUpdate, broadcastRecentGamesUpdate,
} = require('./send');
const { recordGameResult, buildPlayerRatings } = require('../domain/users');
const { getSpectatorNames, sendSpectatorState } = require('./spectator');
const {
  getBotColor, scheduleBotMove, afterSuccessfulMove,
} = require('./bot');

const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS) || 30000;

const otherColor = (c) => (c === 'black' ? 'white' : 'black');

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
  // 봇 게임 + 사람 ws offline (좀비) 이면 turn 토글 + 봇 schedule 안 함.
  // grace timer 가 별도 만료 처리 (90s 후 abandon). 봇이 혼자 두면서 게임이
  // 부재중 끝나는 시나리오 차단.
  if (room.hasBot) {
    const { bothPlayersOnline } = require('./send');
    if (!bothPlayersOnline(room)) return;
  }
  const skipped = room.turn;
  room.turn = otherColor(room.turn);
  // 봇 게임에서 사람 차례 timeout → 봇 차례로 토글 → 봇이 둠. 만약 사람 ws 가
  // 좀비 (close fire 안 됨) 상태로 timeout 이 반복되면 봇이 끝까지 혼자 진행해서
  // 사람이 패배 + 봇 user record 가 잘못 update 되는 버그 추적용 logging.
  if (room.hasBot) {
    const humanColor = skipped;
    const humanSlot = room.players[humanColor];
    if (humanSlot && humanSlot.type === 'human') {
      const { getWsBySessionId } = require('../connections');
      const humanWs = getWsBySessionId(humanSlot.sessionId);
      const humanOnline = humanWs && humanWs.readyState === humanWs.OPEN;
      if (!humanOnline) {
        console.error('[BOT_GAME_TURN_TIMEOUT_OFFLINE] human timed out while offline (bot will continue solo)', {
          code: room.code, gameId: room.gameId,
          humanColor, humanClientId: humanSlot.clientId, humanNickname: humanSlot.nickname,
          sessionId: humanSlot.sessionId,
        });
      }
    }
  }
  broadcastRoom(room, { type: 'turn_skipped', skipped, turn: room.turn });
  startTurnTimer(room);
  markRoomDirty(room);
  // 봇 게임에서 사람이 시간 초과되면 봇 차례로 넘어가는데, 봇이 깨어나지 않던 버그.
  // afterSuccessfulMove 경로가 아닌 곳에서도 봇 차례면 즉시 스케줄.
  if (room.hasBot) {
    const botColor = getBotColor(room);
    if (botColor && room.turn === botColor) scheduleBotMove(room);
  }
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
  const ratings = buildPlayerRatings(room);
  const base = {
    type: 'game_start',
    code: room.code,
    gameId: room.gameId,
    board: room.board,
    turn: room.turn,
    nicknames,
    ratings,
    playerStatus: playerStatusPayload(room),
    spectators: getSpectatorNames(room),
  };
  // 각 플레이어에게 본인 sessionId 와 함께 알림 (FE 가 sessionStorage 에 저장).
  sendToPlayer(room, 'black', { ...base, you: 'black', opponent: 'white', sessionId: blackSlot.sessionId });
  sendToPlayer(room, 'white', { ...base, you: 'white', opponent: 'black', sessionId: whiteSlot.sessionId });
  forEachSpectatorWs(room, (ws) => sendSpectatorState(ws, room));

  startTurnTimer(room);
  markRoomDirty(room);
  broadcastRoomsList();
  log.event('game_started', {
    code: room.code,
    gameId: room.gameId,
    black: blackSlot.nickname,
    white: whiteSlot.nickname,
    bot: !!room.hasBot,
  });
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
    recordGameResult(room, { winnerColor: color, reason: 'five' });
    broadcastRankingUpdate();
    broadcastRecentGamesUpdate();
    log.event('game_over', { code: room.code, gameId: room.gameId, winner: color, reason: 'five' });
  } else if (isDraw(room.board)) {
    room.status = 'over';
    room.winner = 'draw';
    room.loser = null;
    clearTurnTimer(room);
    broadcastRoom(room, { type: 'move', row, col, color });
    broadcastRoom(room, { type: 'game_over', winner: 'draw', line: null, gameId: room.gameId, playerIds });
    broadcastRoomsList();
    recordGameResult(room, { winnerColor: 'draw', reason: 'draw' });
    broadcastRankingUpdate();
    broadcastRecentGamesUpdate();
    log.event('game_over', { code: room.code, gameId: room.gameId, winner: 'draw', reason: 'draw' });
  } else {
    room.turn = otherColor(room.turn);
    broadcastRoom(room, { type: 'move', row, col, color, turn: room.turn });
    startTurnTimer(room);
  }
  markRoomDirty(room);
  afterSuccessfulMove(room, opts.actor === 'bot');
};

module.exports = {
  startTurnTimer,
  clearTurnTimer,
  onTurnTimeout,
  applyMove,
  onMove,
  startGame,
};
