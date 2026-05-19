// ============================================================
// InMemoryStore — 기존 동작 그대로. 단일 프로세스 메모리에만 데이터 유지.
// ============================================================
// 데이터 형태는 valkey backend 와 일치하도록 namespace 별 Map / Array.
// rooms / sessions / botOffer 는 Map (string key → value),
// queue 는 array of records.

'use strict';

const createInMemoryStore = () => ({
  backend: 'memory',
  rooms: new Map(),
  sessions: new Map(),
  queue: [],
  botOffer: new Map(),
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
});

module.exports = { createInMemoryStore };
