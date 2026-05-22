// ============================================================
// 서버 부팅 시 valkey 에서 hydrate 된 rooms 의 timer / grace 재등록.
// ============================================================
// 정책 (deploy 일시정지):
//   - boot 직후 모든 player ws 가 없으므로 turn timer 는 등록하지 않는다.
//   - 사용자가 resume_session / clientId reclaim 으로 돌아오면 그 핸들러가
//     bothPlayersOnline 확인 후 startTurnTimer + scheduleBotMove 재개.
//   - 각 player 색에 새 disconnect grace timer 등록 — DISCONNECT_GRACE_MS (기본 60s)
//     안에 reconnect 못 하면 finalizeAbandon. 데이터 근거는 infra/timings.js 참고.
//     (deploy 직전 grace timer 는 메모리 setTimeout 이라 죽었음.)
// ============================================================

const roomRuntime = require('../domain/room-runtime');
const log = require('../infra/log');
const { DISCONNECT_GRACE_MS } = require('../infra/timings');

const rehydrateTimers = () => {
  const { getStore } = require('../store');
  const store = getStore();
  for (const [code, room] of store.rooms) {
    if (room.status !== 'playing') continue;

    // boot 직후 모든 player 가 disconnect 상태로 간주. turn timer 미등록.
    // 각 사람 player 에 grace timer 신규 등록 (reconnect 까지 여유 보장).
    // Lazy require — disconnect.js 가 send/users 등 의존성을 거꾸로 가져갈 수 있어 분리.
    const { finalizeAbandon } = require('./disconnect');
    for (const color of ['black', 'white']) {
      const slot = room.players?.[color];
      if (!slot) continue;
      if (slot.type === 'bot') continue;  // 봇은 grace 안 함
      roomRuntime.setDisconnectTimer(
        code, color,
        setTimeout(() => finalizeAbandon(room, color), DISCONNECT_GRACE_MS),
      );
    }
    log.event('room_rehydrated', {
      code, status: room.status, gameId: room.gameId, turn: room.turn,
      paused: 'awaiting_reconnect',
    });
  }
};

module.exports = { rehydrateTimers };
