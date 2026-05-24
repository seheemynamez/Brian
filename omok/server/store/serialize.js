// ============================================================
// Domain state ↔ JSON 변환. valkey.js 가 이걸 통해 SET/GET.
// ============================================================
// room 안의 Set / Map 같은 비-JSON 타입을 array 로 변환하고, 역변환 시 복원.
// rooms.js 의 getSerializableRoomState 와 중복인데, circular require 방지 위해 분리.

'use strict';

const serializeRoom = (room) => ({
  code: room.code,
  gameId: room.gameId,
  players: {
    black: room.players.black ? { ...room.players.black } : null,
    white: room.players.white ? { ...room.players.white } : null,
  },
  spectatorSessionIds: Array.from(room.spectatorSessionIds || []),
  board: room.board,
  turn: room.turn,
  turnDeadline: room.turnDeadline || 0,
  // disconnect 중 pauseTurnTimer 가 저장한 남은 시간. valkey hydrate 후 resumeTurnTimer
  // 가 이 값으로 timer 재개. 누락 시 새로고침/재배포 후 남은 시간이 초기화됨.
  turnRemainMs: room.turnRemainMs || 0,
  // 현 차례 시작 시각 — applyMove 가 사람 thinking time 누적 시 사용. hydrate 후엔
  // resumeTurnTimer 가 turnRemainMs 기반으로 다시 보정하므로 그대로 보존해도 무방
  // (단, 재배포 사이 흐른 wall time 만큼 elapsed 가 부풀려질 수 있어 startTurnTimer/
  // resumeTurnTimer 가 재호출 시 덮어쓰는 게 정상 흐름).
  turnStartedAt: room.turnStartedAt || 0,
  // 사람 차례 elapsed CSV 의 raw 배열 — game_over 시 log 로 flush. 재배포 사이
  // 누락 방지 위해 persist.
  humanTurnsMs: Array.isArray(room.humanTurnsMs) ? room.humanTurnsMs.slice() : [],
  status: room.status,
  winner: room.winner,
  winLine: room.winLine,
  lastMove: room.lastMove,
  rematchVotes: Array.from(room.rematchVotes || []),
  loser: room.loser,
  hasBot: !!room.hasBot,
  botEmoteState: room.botEmoteState || null,
  createdAt: room.createdAt || 0,
  updatedAt: Date.now(),
});

const deserializeRoom = (data) => {
  const r = typeof data === 'string' ? JSON.parse(data) : data;
  return {
    ...r,
    spectatorSessionIds: new Set(r.spectatorSessionIds || []),
    rematchVotes: new Set(r.rematchVotes || []),
  };
};

module.exports = { serializeRoom, deserializeRoom };
