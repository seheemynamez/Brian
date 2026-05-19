// ============================================================
// 서버 부팅 시 valkey 에서 hydrate 된 rooms 의 timer 를 재등록.
// turnDeadline 이 미래면 남은 시간만큼 startTurnTimer. 이미 지났으면 즉시 onTurnTimeout.
// 봇 차례면 봇 timer 도 다시 활성.
// ============================================================

const roomRuntime = require('../domain/room-runtime');
const log = require('../infra/log');
const { startTurnTimer, onTurnTimeout } = require('./game');
const { getBotColor, scheduleBotMove } = require('./bot');

const rehydrateTimers = () => {
  const { getStore } = require('../store');
  const store = getStore();
  for (const [code, room] of store.rooms) {
    if (room.status !== 'playing') continue;

    // 봇 게임은 boot 직후 사람 ws 가 없으므로 timer / 봇 schedule 등록하지 않는다.
    // 사람이 resume_session 또는 clientId reclaim 으로 돌아오면 그 핸들러가 startTurnTimer
    // + scheduleBotMove 시작. boot 직후에 등록하면 사람이 reconnect 하기 전에 봇이 board
    // 를 dominate 하는 사고 발생 (disconnect.js 와 같은 정책).
    if (room.hasBot) {
      log.event('room_rehydrated', { code, status: room.status, gameId: room.gameId, turn: room.turn, paused: 'bot_disconnect' });
      continue;
    }

    const now = Date.now();
    const remaining = (room.turnDeadline || 0) - now;
    if (remaining > 0) {
      // 남은 시간만큼 turn timer 재등록 (startTurnTimer 는 항상 TURN_TIMEOUT_MS 새로 시작
      // 하지만 hydrate 케이스에선 남은 시간 그대로 가야 자연스러움)
      const handle = setTimeout(() => onTurnTimeout(room), remaining);
      roomRuntime.setTimer(code, 'turnTimer', handle);
    } else if (room.turnDeadline > 0) {
      // 이미 지남 — 곧바로 turn skip 처리
      setImmediate(() => onTurnTimeout(room));
    } else {
      // turnDeadline 0 — 아직 게임 시작 안한 케이스 (혹시 모를 비정상). startTurnTimer 새로.
      startTurnTimer(room);
    }
    log.event('room_rehydrated', { code, status: room.status, gameId: room.gameId, turn: room.turn });
  }
};

module.exports = { rehydrateTimers };
