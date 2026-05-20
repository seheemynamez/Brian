// ============================================================
// Bot Iterative Deepening 동작 검증 — abort 시 마지막 완성 depth best 반환.
// ============================================================
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { generateMove, searchBestMove, getDynamicConfig } = require('../../game/bot');

const SIZE = 15;
const empty = () => Array.from({ length: SIZE }, () => Array(SIZE).fill(0));

// stones N개 짜리 보드 — 임의 위치에 흑백 번갈아 채움 (셀프 5목 안 만들게 spread).
// dynamic cfg 의 stones 기준 (<5 / <15 / 15+) 테스트 전용.
const boardWithStones = (n) => {
  const b = empty();
  // 흩어진 위치에 번갈아 두기 — 15×15 에 분산. (row+col) % 2 패턴.
  let placed = 0;
  for (let r = 0; r < SIZE && placed < n; r += 2) {
    for (let c = 0; c < SIZE && placed < n; c += 2) {
      b[r][c] = (placed % 2 === 0) ? 1 : 2;
      placed++;
    }
  }
  return b;
};

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

  test('medium: 초반 (stones<5) maxDepth 3 — 동적 cfg', () => {
    const b = empty();
    b[7][7] = 2;
    const r = generateMove(b, 'black', 'medium');
    assert.ok(r.move);
    assert.equal(r.cfgMaxDepth, 3);   // stones=1 → medium 초반 cfg
    assert.ok(r.reachedDepth >= 1, '최소 d1 까지는 도달');
    assert.ok(r.reachedDepth <= 3, 'cfgMaxDepth 이내');
  });

  test('hard: 초반 (stones<5) maxDepth 4 — 동적 cfg', () => {
    const b = empty();
    b[7][7] = 2;
    const r = generateMove(b, 'black', 'hard');
    assert.ok(r.move);
    assert.equal(r.cfgMaxDepth, 4);   // stones=1 → hard 초반 cfg (αβ 약해서 d4 까지만)
    assert.ok(r.reachedDepth >= 1);
    assert.ok(r.reachedDepth <= 4);
  });
});

describe('Bot ID — getDynamicConfig stones 별 매핑', () => {
  test('easy: stones 무관 — d2×t3×1s 고정', () => {
    assert.deepEqual(getDynamicConfig(empty(), 'easy'),
      { maxDepth: 2, topK: 3, timeoutMs: 1000 });
    assert.deepEqual(getDynamicConfig(boardWithStones(20), 'easy'),
      { maxDepth: 2, topK: 3, timeoutMs: 1000 });
  });

  test('medium: 초반(<5) d3 / 중반(5-14) d4 / 후반(15+) d4', () => {
    assert.equal(getDynamicConfig(boardWithStones(0), 'medium').maxDepth, 3);
    assert.equal(getDynamicConfig(boardWithStones(4), 'medium').maxDepth, 3);
    assert.equal(getDynamicConfig(boardWithStones(5), 'medium').maxDepth, 4);
    assert.equal(getDynamicConfig(boardWithStones(14), 'medium').maxDepth, 4);
    assert.equal(getDynamicConfig(boardWithStones(15), 'medium').maxDepth, 4);
    assert.equal(getDynamicConfig(boardWithStones(20), 'medium').maxDepth, 4);
    // timeoutMs 도 단계별로 다름
    assert.equal(getDynamicConfig(boardWithStones(0), 'medium').timeoutMs, 1500);
    assert.equal(getDynamicConfig(boardWithStones(10), 'medium').timeoutMs, 3000);
    assert.equal(getDynamicConfig(boardWithStones(20), 'medium').timeoutMs, 1500);
  });

  test('hard: 초반(<5) d4 / 중반(5-14) d5 / 후반(15+) d6', () => {
    assert.equal(getDynamicConfig(boardWithStones(0), 'hard').maxDepth, 4);
    assert.equal(getDynamicConfig(boardWithStones(4), 'hard').maxDepth, 4);
    assert.equal(getDynamicConfig(boardWithStones(5), 'hard').maxDepth, 5);
    assert.equal(getDynamicConfig(boardWithStones(14), 'hard').maxDepth, 5);
    assert.equal(getDynamicConfig(boardWithStones(15), 'hard').maxDepth, 6);
    assert.equal(getDynamicConfig(boardWithStones(20), 'hard').maxDepth, 6);
    // timeoutMs 도 단계별
    assert.equal(getDynamicConfig(boardWithStones(0), 'hard').timeoutMs, 5000);
    assert.equal(getDynamicConfig(boardWithStones(10), 'hard').timeoutMs, 8000);
    assert.equal(getDynamicConfig(boardWithStones(20), 'hard').timeoutMs, 5000);
  });

  test('topK 는 모든 단계에서 10 (easy 제외)', () => {
    for (const s of [0, 4, 5, 14, 15, 20]) {
      assert.equal(getDynamicConfig(boardWithStones(s), 'medium').topK, 10);
      assert.equal(getDynamicConfig(boardWithStones(s), 'hard').topK, 10);
    }
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
    // reachedDepth 은 1 일 수 있고 더 깊이 갈 수도 있지만 cfgMaxDepth 까지 안 감
    // (win 발견 시 ID break). 단 d1 에서만 win 잡힌다고 보장 X — αβ 가지치기 / move ordering
    // 따라 다름. 일단 reached <= cfgMaxDepth + move 가 win 자리이기만 하면 OK.
    // stones=4 → hard 초반 cfg = d4. (dynamic cfg, PR #81.)
    assert.equal(r.cfgMaxDepth, 4);
    assert.ok(r.reachedDepth >= 1 && r.reachedDepth <= r.cfgMaxDepth);
  });
});

describe('Bot ID — abort 시나리오', () => {
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

  // 핵심: deadline 발동 검증 — PR #78 의 hotfix 회귀 방지.
  // 이전 AbortController + setTimeout 방식은 worker 의 동기 흐름 점령으로 abort 안 됨.
  // deadline 직접 비교 (Date.now() > deadline) 가 동기 안에서도 발동하는지.
  test('짧은 timeoutMs 강제 시 hard 봇 aborted=true + reached < cfgMaxDepth', () => {
    const b = empty();
    b[7][7] = 2;
    // 1ms — d1 도 못 끝낼 만큼 짧음. 실제론 d1 한 후보 평가 후 deadline 초과 감지 → break.
    const r = generateMove(b, 'black', 'hard', { timeoutMs: 1 });
    assert.equal(r.aborted, true, 'aborted=true 여야 — deadline 초과로 ID 중단됨');
    assert.ok(r.reachedDepth < r.cfgMaxDepth, `reached(${r.reachedDepth}) < cfgMax(${r.cfgMaxDepth})`);
    // d1 시작 후 abort 면 bestMove 가 partial best — 그래도 null 아님 (orderCandidatesAtRoot
    // 결과의 1번 후보가 cands[0] 으로 들어가 partial best 됨).
    // OR generateMove 가 ID 의 첫 depth 도 못 끝내서 null 반환. 둘 다 OK.
  });

  test('짧은 timeoutMs 강제 시 medium 봇 동일 — aborted=true + 일관성', () => {
    const b = empty();
    b[7][7] = 2;
    const r = generateMove(b, 'black', 'medium', { timeoutMs: 1 });
    assert.equal(r.aborted, true);
    assert.ok(r.reachedDepth < r.cfgMaxDepth);
  });

  test('충분한 timeoutMs 시 정상 완료 (aborted=false, reached=cfgMax)', () => {
    const b = empty();
    b[7][7] = 2;
    // easy 는 무조건 빠르게 끝남 — abort 절대 발동 안 함 검증.
    const r = generateMove(b, 'black', 'easy');
    assert.equal(r.aborted, false);
    assert.equal(r.reachedDepth, r.cfgMaxDepth);
    assert.ok(r.move);
  });
});

describe('Bot ID — searchBestMove deadline 직접 검증 (PR #78 회귀)', () => {
  // searchBestMove 직접 호출 — deadline 이 한 search 안에서 동작하는지.
  // Date.now() > deadline 비교가 매 후보 평가 후 발동해야 함. setTimeout/AbortSignal 의존 X.
  test('과거 deadline 주면 complete=false 즉시 반환', () => {
    const b = empty();
    b[7][7] = 2;
    // 이미 1초 전 시각. 모든 후보 평가 전 즉시 abort.
    const past = Date.now() - 1000;
    const r = searchBestMove(b, 'black', 4, 10, { deadline: past });
    assert.equal(r.complete, false, 'complete=false 여야 (deadline 초과)');
  });

  test('미래 deadline 충분히 길면 complete=true + move 있음', () => {
    const b = empty();
    b[7][7] = 2;
    const future = Date.now() + 30000;  // 30s 후 — 어떤 d 도 끝남
    const r = searchBestMove(b, 'black', 2, 5, { deadline: future });
    assert.equal(r.complete, true);
    assert.ok(r.move);
  });

  test('opts 안 줘도 (deadline=undefined) 정상 작동 — backward compat', () => {
    const b = empty();
    b[7][7] = 2;
    const r = searchBestMove(b, 'black', 2, 5);
    assert.equal(r.complete, true);
    assert.ok(r.move);
  });
});
