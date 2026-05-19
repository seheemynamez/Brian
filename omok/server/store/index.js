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
  const isProd = process.env.NODE_ENV === 'production';

  // Production 가드 — env 누락으로 prod 가 memory backend 로 뜨는 사고 방지.
  // Render 는 NODE_ENV=production 을 자동 설정함. local/test 에서는 무관.
  // 정말 prod 에서 memory 가 필요한 임시 상황이면 ALLOW_MEMORY_STORE_IN_PROD=1 로 우회.
  if (isProd && backend !== 'valkey' && process.env.ALLOW_MEMORY_STORE_IN_PROD !== '1') {
    throw new Error(
      `Production (NODE_ENV=production) 에서 STORE_BACKEND='${backend}' 거부. ` +
      `STORE_BACKEND=valkey + VALKEY_URL 설정 필요. ` +
      `임시 우회: ALLOW_MEMORY_STORE_IN_PROD=1`
    );
  }

  if (backend === 'valkey') {
    try {
      inst = require('./valkey').createValkeyStore();
    } catch (e) {
      // dev/test 폴백. prod 는 위에서 throw 했으므로 여기 안 옴.
      console.error('[store] valkey backend 로드 실패, memory 로 폴백:', e && e.message);
      inst = require('./memory').createInMemoryStore();
    }
  } else {
    inst = require('./memory').createInMemoryStore();
  }
  return inst;
};

module.exports = { getStore };
