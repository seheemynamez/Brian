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
    // 봇 차례면 봇 응수 스케줄링 재개
    if (room.hasBot) {
      const botColor = getBotColor(room);
      if (botColor && room.turn === botColor) scheduleBotMove(room);
    }
    log.event('room_rehydrated', { code, status: room.status, gameId: room.gameId, turn: room.turn });
  }
};

module.exports = { rehydrateTimers };
