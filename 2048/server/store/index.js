// ============================================================
// Store entry — STORE_BACKEND 환경변수로 memory / valkey 선택.
// ============================================================
// 메모리 cache (Map) 는 backend 무관하게 항상 in-process. valkey backend 는
// write-through + 부팅 시 hydrate. memory backend 는 영속화 안 함 (테스트 / 로컬 개발용).
//
// production 가드: NODE_ENV=production 인데 backend=memory 면 부팅 거부.
// (omok 와 동일 정책 — 데이터 휘발 사고 방지.)
'use strict';

const BACKEND = (process.env.STORE_BACKEND || 'memory').toLowerCase();
const ALLOW_MEMORY_IN_PROD = process.env.ALLOW_MEMORY_STORE_IN_PROD === '1';

if (process.env.NODE_ENV === 'production' && BACKEND !== 'valkey' && !ALLOW_MEMORY_IN_PROD) {
  throw new Error(
    `Production (NODE_ENV=production) 에서 STORE_BACKEND='${BACKEND}' 거부. ` +
    `'valkey' 로 설정하거나 ALLOW_MEMORY_STORE_IN_PROD=1 (의도적 우회) 사용.`
  );
}

let store;
if (BACKEND === 'valkey') {
  store = require('./valkey');
} else {
  store = require('./memory');
}

module.exports = { getStore: () => store };
