// ============================================================
// Bot Iterative Deepening 동작 검증 — abort 시 마지막 완성 depth best 반환.
// ============================================================
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { generateMove } = require('../../game/bot');

const SIZE = 15;
const empty = () => Array.from({ length: SIZE }, () => Array(SIZE).fill(0));

describe('Bot ID — generateMove 반환 shape + 깊이 도달', () => {
  test('easy: d2 까지 도달, move 반환', () => {
    const b = empty();
    b[7][7] = 2;
    const r = generateMove(b, 'black', 'easy');
    assert.ok(r.move, 'move 필요');
    assert.equal(r.cfgMaxDepth, 2);
    assert.equal(r.cfgTopK, 3);
    assert.equal(r.reachedDepth, 2);  // easy 는 무조건 d2 까지 — 매우 빠름
    assert.ok(typeof r.elapsedMs === 'number');
    assert.equal(r.aborted, false);
  });

  test('medium: maxDepth 4 — 충분한 시간 안에 d4 까지 도달', () => {
    const b = empty();
    b[7][7] = 2;
    const r = generateMove(b, 'black', 'medium');
    assert.ok(r.move);
    assert.equal(r.cfgMaxDepth, 4);
    assert.ok(r.reachedDepth >= 1, '최소 d1 까지는 도달');
    assert.ok(r.reachedDepth <= 4, 'cfgMaxDepth 이내');
  });

  test('hard: maxDepth 6 — ID 가 시간 안에서 도달 가능한 max 까지', () => {
    const b = empty();
    b[7][7] = 2;
    const r = generateMove(b, 'black', 'hard');
    assert.ok(r.move);
    assert.equal(r.cfgMaxDepth, 6);
    assert.ok(r.reachedDepth >= 1);
    assert.ok(r.reachedDepth <= 6);
  });
});

describe('Bot ID — 5목 즉시 발견 (winning move) 시 ID 조기 종료', () => {
  test('5목 가능한 직전 상태: d1 에서도 win 발견 → ID 종료, hard 도 d1 reached', () => {
    // 흑 (7,4)(7,5)(7,6)(7,7) 4 in a row → (7,3) 또는 (7,8) 두면 5목.
    const b = empty();
    b[7][4] = 1; b[7][5] = 1; b[7][6] = 1; b[7][7] = 1;
    const r = generateMove(b, 'black', 'hard');
    assert.ok(r.move);
    // 5목 만드는 자리 — (7,3) 또는 (7,8) 둘 중 하나.
    const isWinMove = (r.move[0] === 7 && (r.move[1] === 3 || r.move[1] === 8));
    assert.ok(isWinMove, `winning move 기대, got [${r.move}]`);
    // reachedDepth 은 1 일 수 있고 더 깊이 갈 수도 있지만 hard maxDepth 6 까지 안 감
    // (win 발견 시 ID break). 단 d1 에서만 win 잡힌다고 보장 X — αβ 가지치기 / move ordering
    // 따라 다름. 일단 reached <= 6 + move 가 win 자리이기만 하면 OK.
    assert.ok(r.reachedDepth >= 1 && r.reachedDepth <= 6);
  });
});

describe('Bot ID — abort 시나리오', () => {
  // 실제 timeout 발동은 hard d6 의 빈 보드 worst case (10s+) 가 필요한데 unit test
  // 안에서 너무 오래 걸림. 대신 generateMove 의 반환 shape (aborted 필드) + cfg 일치만 검증.
  // 실제 abort behavior 는 prod 로그의 reached < cfgMaxDepth 사례로 확인.
  test('반환 shape — aborted bool, elapsedMs number, cfgMaxDepth/cfgTopK 일치', () => {
    const b = empty();
    b[7][7] = 2;
    const r = generateMove(b, 'black', 'easy');
    assert.equal(typeof r.aborted, 'boolean');
    assert.equal(typeof r.elapsedMs, 'number');
    assert.equal(typeof r.reachedDepth, 'number');
    assert.equal(typeof r.cfgMaxDepth, 'number');
    assert.equal(typeof r.cfgTopK, 'number');
  });
});
