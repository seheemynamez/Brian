// ============================================================
// Elo rating 단위 테스트.
// PR #50 에서 봇 초기 rating 을 1200 (사람과 동일) 로 통일한 후 회귀 방지.
// ============================================================

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  INITIAL_RATING,
  K_FACTOR,
  BOT_INITIAL_RATING,
  TIER_THRESHOLDS,
  expectedScore,
  computeDeltas,
  getTier,
  resultForBlack,
} = require('../../game/rating');

// ============================================================
// 상수 — INITIAL_RATING (사람 + 봇) 일관성 보장
// ============================================================

describe('rating 상수', () => {
  test('INITIAL_RATING = 1200 (Bronze 가운데)', () => {
    assert.equal(INITIAL_RATING, 1200);
  });

  test('K_FACTOR = 32 (체스 amateur)', () => {
    assert.equal(K_FACTOR, 32);
  });

  test('모든 봇 (easy/medium/hard) 이 INITIAL_RATING 로 시작', () => {
    // PR #50: bot 도 사람과 동일하게 시작 — 실력 차이는 결과로 자연 보정
    assert.equal(BOT_INITIAL_RATING._bot_easy, INITIAL_RATING);
    assert.equal(BOT_INITIAL_RATING._bot_medium, INITIAL_RATING);
    assert.equal(BOT_INITIAL_RATING._bot_hard, INITIAL_RATING);
  });

  test('TIER_THRESHOLDS 는 Iron..Master 7 단계', () => {
    const names = TIER_THRESHOLDS.map((t) => t.name);
    assert.deepEqual(names, ['Iron', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Master']);
  });
});

// ============================================================
// expectedScore — Elo 기댓값
// ============================================================

describe('expectedScore', () => {
  test('동률 → 0.5', () => {
    assert.equal(expectedScore(1500, 1500), 0.5);
  });

  test('대칭: A vs B + B vs A = 1', () => {
    const cases = [[1200, 1500], [1000, 2000], [1800, 1300], [800, 2500]];
    for (const [a, b] of cases) {
      const sum = expectedScore(a, b) + expectedScore(b, a);
      assert.ok(Math.abs(sum - 1) < 1e-9, `A=${a} B=${b} 합=${sum}`);
    }
  });

  test('rating 높은 쪽 expected 더 큼', () => {
    assert.ok(expectedScore(1800, 1200) > 0.5);
    assert.ok(expectedScore(1200, 1800) < 0.5);
  });

  test('400 점 차이 = 1/11 ≈ 0.0909 (canonical Elo)', () => {
    // 약자 입장: expected = 1 / (1 + 10^(400/400)) = 1/11
    const e = expectedScore(1500, 1900);
    assert.ok(Math.abs(e - 1 / 11) < 1e-6, `expected ≈ 0.0909, got ${e}`);
  });
});

// ============================================================
// computeDeltas — Elo 변동량
// ============================================================

describe('computeDeltas', () => {
  test('zero-sum: deltaA + deltaB = 0 (모든 케이스)', () => {
    const cases = [
      [1200, 1200, 1],
      [1200, 1200, 0],
      [1200, 1200, 0.5],
      [1500, 1200, 1],
      [1500, 1200, 0],
      [1000, 2500, 1],
      [2500, 1000, 0],
    ];
    for (const [a, b, r] of cases) {
      const { deltaA, deltaB } = computeDeltas(a, b, r);
      assert.equal(deltaA + deltaB, 0, `A=${a} B=${b} r=${r} → ${deltaA} + ${deltaB}`);
    }
  });

  test('동률 + A 승 → ±16 (K=32 × (1 - 0.5))', () => {
    const { deltaA, deltaB } = computeDeltas(1500, 1500, 1);
    assert.equal(deltaA, 16);
    assert.equal(deltaB, -16);
  });

  test('동률 + 무승부 → 0 / 0', () => {
    const { deltaA, deltaB } = computeDeltas(1500, 1500, 0.5);
    // -0 / +0 둘 다 0 으로 취급 (strict equal 은 Object.is 라 -0 !== 0)
    assert.equal(deltaA + 0, 0);
    assert.equal(deltaB + 0, 0);
  });

  test('upset (약자 승) > 강자 승 (변동량)', () => {
    const upset = computeDeltas(1200, 1800, 1); // 약자가 이김
    const favored = computeDeltas(1800, 1200, 1); // 강자가 이김
    assert.ok(upset.deltaA > favored.deltaA,
      `upset deltaA=${upset.deltaA} should > favored deltaA=${favored.deltaA}`);
  });

  test('|delta| ≤ K_FACTOR (한 게임에서 K 이상 변동 X)', () => {
    for (const r of [0, 0.5, 1]) {
      const { deltaA } = computeDeltas(1000, 3000, r);
      assert.ok(Math.abs(deltaA) <= K_FACTOR, `|deltaA|=${Math.abs(deltaA)} > K=${K_FACTOR}`);
    }
  });

  test('정수 반환 (Math.round)', () => {
    const { deltaA, deltaB } = computeDeltas(1234, 1567, 1);
    assert.equal(Number.isInteger(deltaA), true);
    assert.equal(Number.isInteger(deltaB), true);
  });
});

// ============================================================
// getTier — rating → 티어 이름
// ============================================================

describe('getTier — 경계값', () => {
  const cases = [
    [0, 'Iron'],
    [500, 'Iron'],
    [1099, 'Iron'],
    [1100, 'Bronze'],
    [1200, 'Bronze'], // INITIAL_RATING
    [1299, 'Bronze'],
    [1300, 'Silver'],
    [1499, 'Silver'],
    [1500, 'Gold'],
    [1699, 'Gold'],
    [1700, 'Platinum'],
    [1899, 'Platinum'],
    [1900, 'Diamond'],
    [2099, 'Diamond'],
    [2100, 'Master'],
    [3000, 'Master'],
    [99999, 'Master'],
  ];
  for (const [rating, tier] of cases) {
    test(`rating ${rating} → ${tier}`, () => {
      assert.equal(getTier(rating), tier);
    });
  }
});

// ============================================================
// resultForBlack — winner color → black 입장의 score
// ============================================================

describe('resultForBlack', () => {
  test('black 승 → 1', () => {
    assert.equal(resultForBlack('black'), 1);
  });

  test('white 승 → 0', () => {
    assert.equal(resultForBlack('white'), 0);
  });

  test('draw → 0.5', () => {
    assert.equal(resultForBlack('draw'), 0.5);
  });

  test('알 수 없는 값 → 0.5 (draw 로 폴백)', () => {
    assert.equal(resultForBlack(undefined), 0.5);
    assert.equal(resultForBlack(null), 0.5);
    assert.equal(resultForBlack('???'), 0.5);
  });
});
