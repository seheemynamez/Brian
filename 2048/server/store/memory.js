// ============================================================
// In-memory store — 단일 프로세스 메모리. 영속화 X.
// ============================================================
// 테스트 / 로컬 개발용. production 거부 (store/index.js 의 가드).
'use strict';

const users = new Map();

module.exports = {
  backend: 'memory',
  users,
  // valkey backend 호환 — no-op.
  async connect() { /* no-op */ },
  async hydrate() { /* no-op */ },
  async disconnect() { /* no-op */ },
  persistUser(_clientId, _user) { /* no-op */ },
  removeUser(_clientId) { /* no-op */ },
};
