// ============================================================
// queue.js 의 botOffer write-through 회귀 방지 (PR #90 review 반영).
// recovery.test.js 가 memory backend 만 검증해서 valkey persist 호출이
// 빠져도 못 잡음 — store 메서드를 spy 로 감싸서 호출 여부 직접 검증.
// ============================================================

'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');

// queue.js 가 top-level 에서 require('../store').getStore() 를 호출하므로
// 실제 메모리 store 인스턴스를 가져와 그 메서드만 monkey-patch.
const store = require('../../store').getStore();

// queue.js 가 require 시점에 store 참조를 캡쳐하지만 메서드 호출은 런타임이라
// 메서드 자체를 swap 하면 spy 가 잡힘.
const persistCalls = [];
const deleteCalls = [];
const origPersist = store.persistBotOffer;
const origDelete  = store.deleteBotOfferFromStore;
store.persistBotOffer = (cid, ts) => { persistCalls.push([cid, ts]); };
store.deleteBotOfferFromStore = (cid) => { deleteCalls.push(cid); };

// queue.js 를 spy 설치 *후에* require — top-level capture 시점에 swapped 메서드 잡히게.
// (현 구조상 store 객체 자체는 동일 참조이므로 capture 시점은 무관하지만, 안전망)
delete require.cache[require.resolve('../../handlers/queue')];
const { scheduleBotOfferIfNeeded, BOT_OFFER_COOLDOWN_MS } = require('../../handlers/queue');

describe('queue.js — botOffer Valkey 영속화 write-through', () => {
  before(() => {
    // 각 테스트 직전에 spy 기록 초기화는 안 함 — 누적 검증.
    // 기존 store.botOffer Map 이 다른 테스트와 공유라 격리 위해 clear.
    store.botOffer.clear();
    persistCalls.length = 0;
    deleteCalls.length = 0;
  });

  test('bot_offer 발송 시 store.persistBotOffer(clientId, ts) 호출됨', async () => {
    const entry = {
      connectionId: 'conn-spy-1',
      clientId: 'cid-spy-1',
      nickname: 'Spy',
      joinedAt: Date.now() - 11000,  // BOT_OFFER_DELAY_MS=1000 (test env) 이미 지남
      botOfferTimer: null,
      botOfferSentAt: null,
    };

    scheduleBotOfferIfNeeded(entry);

    // BOT_OFFER_DELAY_MS=1000 (test env override) 가 fire 될 때까지 잠시 대기.
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(persistCalls.length, 1, 'persistBotOffer 가 1회 호출돼야 함');
    assert.equal(persistCalls[0][0], 'cid-spy-1', 'clientId 일치');
    assert.ok(typeof persistCalls[0][1] === 'number' && persistCalls[0][1] > 0, 'timestamp 양수');
  });

  test('lazy cleanup 분기에서 store.deleteBotOfferFromStore 호출됨', async () => {
    // cooldown × 2 보다 더 옛 entry 를 미리 botOffer Map 에 심어둠 → 새 발송 시 cleanup 됨.
    const staleCid = 'cid-spy-stale';
    const veryOld = Date.now() - (BOT_OFFER_COOLDOWN_MS * 3);
    store.botOffer.set(staleCid, veryOld);
    deleteCalls.length = 0;  // 명확한 격리

    const entry = {
      connectionId: 'conn-spy-2',
      clientId: 'cid-spy-2',
      nickname: 'Spy2',
      joinedAt: Date.now() - 11000,
      botOfferTimer: null,
      botOfferSentAt: null,
    };
    scheduleBotOfferIfNeeded(entry);
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(deleteCalls.includes(staleCid),
      `deleteBotOfferFromStore 가 stale cid (${staleCid}) 에 대해 호출돼야 함. 실제 호출: ${JSON.stringify(deleteCalls)}`);
  });
});

// 모든 테스트 후 원복 — 동일 process 안에서 다른 테스트 영향 방지.
process.on('exit', () => {
  store.persistBotOffer = origPersist;
  store.deleteBotOfferFromStore = origDelete;
});
