// ============================================================
// InMemoryStore — 기존 동작 그대로. 단일 프로세스 메모리에만 데이터 유지.
// ============================================================
// 데이터 형태는 valkey backend 와 일치하도록 namespace 별 Map / Array.
// rooms / sessions / botOffer / users 는 Map (string key → value),
// queue 는 array of records,
// recentGames 는 array (LIFO, capped — 마지막 N개).

'use strict';

const RECENT_GAMES_CAP = Number(process.env.RECENT_GAMES_CAP) || 100;

const createInMemoryStore = () => ({
  backend: 'memory',
  rooms: new Map(),
  sessions: new Map(),
  queue: [],
  botOffer: new Map(),
  users: new Map(),        // clientId → user JSON
  recentGames: [],         // [{ ..., endedAt }]  최신 먼저 (unshift)
  // lifecycle no-op (메모리만 사용)
  async connect() {},
  async hydrate() {},
  async close() {},
  // valkey backend 와 인터페이스 일치 위한 no-op write-through helpers.
  persistRoom() {},
  deleteRoomFromStore() {},
  persistSession() {},
  deleteSessionFromStore() {},
  persistQueue() {},
  persistBotOffer() {},
  deleteBotOfferFromStore() {},
  // user / recent_games — memory backend 에선 캐시 자체가 SoT.
  // 단, recentGames 는 cap 유지 (LTRIM 흉내).
  persistUser() {},
  persistRecentGame(entry) {
    this.recentGames.unshift(entry);
    if (this.recentGames.length > RECENT_GAMES_CAP) this.recentGames.length = RECENT_GAMES_CAP;
  },
});

module.exports = { createInMemoryStore };
