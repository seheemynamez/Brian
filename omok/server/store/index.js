// ============================================================
// Store factory — singleton.
// ============================================================
// STORE_BACKEND=valkey  → ValkeyStore (write-through, Aiven 등 외부 redis-compat)
// STORE_BACKEND=memory  → InMemoryStore (기본)
//
// 도메인 모듈 (rooms.js, handlers.js) 은 getStore().rooms / .sessions / .queue /
// .botOffer 에 접근. 인터페이스는 Map / Array 와 동일하므로 backend 교체 무관.

'use strict';

let inst = null;

const getStore = () => {
  if (inst) return inst;
  const backend = (process.env.STORE_BACKEND || 'memory').toLowerCase();
  if (backend === 'valkey') {
    try {
      inst = require('./valkey').createValkeyStore();
    } catch (e) {
      console.error('[store] valkey backend 로드 실패, memory 로 폴백:', e && e.message);
      inst = require('./memory').createInMemoryStore();
    }
  } else {
    inst = require('./memory').createInMemoryStore();
  }
  return inst;
};

module.exports = { getStore };
