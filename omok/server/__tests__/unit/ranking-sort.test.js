// ============================================================
// 랭킹 정렬 비교 함수 (compareForRanking) 단위 테스트.
// tie-break: rating → wins → losses → draws → createdAt 순서로 적용 확인.
// ============================================================

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { compareForRanking } = require('../../domain/users');

const mkUser = (overrides = {}) => ({
  clientId: 'x',
  rating: 1200,
  wins: 0,
  losses: 0,
  draws: 0,
  createdAt: Date.now(),
  ...overrides,
});

// helper — 배열 sort 결과의 clientId 순서 반환
const orderOf = (users) => {
  const arr = [...users];
  arr.sort(compareForRanking);
  return arr.map((u) => u.clientId);
};

describe('compareForRanking — 1차 (rating desc)', () => {
  test('rating 높은 쪽이 앞에', () => {
    const a = mkUser({ clientId: 'a', rating: 1500 });
    const b = mkUser({ clientId: 'b', rating: 1200 });
    assert.ok(compareForRanking(a, b) < 0);
    assert.deepEqual(orderOf([b, a]), ['a', 'b']);
  });
});

describe('compareForRanking — 2차 (rating 동률 → wins desc)', () => {
  test('동률 rating + wins 많은 쪽 위', () => {
    const a = mkUser({ clientId: 'a', rating: 1200, wins: 5 });
    const b = mkUser({ clientId: 'b', rating: 1200, wins: 3 });
    assert.ok(compareForRanking(a, b) < 0);
    assert.deepEqual(orderOf([b, a]), ['a', 'b']);
  });
});

describe('compareForRanking — 3차 (rating + wins 동률 → losses asc)', () => {
  test('losses 적은 쪽 위', () => {
    const a = mkUser({ clientId: 'a', rating: 1200, wins: 3, losses: 2 });
    const b = mkUser({ clientId: 'b', rating: 1200, wins: 3, losses: 5 });
    assert.ok(compareForRanking(a, b) < 0);
    assert.deepEqual(orderOf([b, a]), ['a', 'b']);
  });
});

describe('compareForRanking — 4차 (rating/wins/losses 동률 → draws desc)', () => {
  test('draws 많은 쪽 위 (게임 수 많을수록)', () => {
    const a = mkUser({ clientId: 'a', rating: 1200, wins: 1, losses: 1, draws: 5 });
    const b = mkUser({ clientId: 'b', rating: 1200, wins: 1, losses: 1, draws: 1 });
    assert.ok(compareForRanking(a, b) < 0);
    assert.deepEqual(orderOf([b, a]), ['a', 'b']);
  });
});

describe('compareForRanking — 5차 (승패무 모두 동률 → createdAt asc, 신규 요청사항)', () => {
  test('먼저 가입한 (createdAt 작은) 사람이 위', () => {
    const older = mkUser({ clientId: 'older', createdAt: 1_000_000 });
    const newer = mkUser({ clientId: 'newer', createdAt: 2_000_000 });
    assert.ok(compareForRanking(older, newer) < 0);
    assert.deepEqual(orderOf([newer, older]), ['older', 'newer']);
  });

  test('3 명 완전 동률 + createdAt 만 다름 → 가입 순', () => {
    const u1 = mkUser({ clientId: 'first',  createdAt: 100 });
    const u2 = mkUser({ clientId: 'second', createdAt: 200 });
    const u3 = mkUser({ clientId: 'third',  createdAt: 300 });
    assert.deepEqual(orderOf([u3, u1, u2]), ['first', 'second', 'third']);
  });

  test('createdAt 누락 (legacy) 시 가장 뒤로', () => {
    const legacy = mkUser({ clientId: 'legacy', createdAt: undefined });
    const fresh  = mkUser({ clientId: 'fresh',  createdAt: 2_000_000 });
    assert.ok(compareForRanking(legacy, fresh) > 0);
    assert.deepEqual(orderOf([legacy, fresh]), ['fresh', 'legacy']);
  });
});

describe('compareForRanking — 우선순위 (1차가 우세하면 후속 무시)', () => {
  test('rating 높으면 wins/createdAt 무관', () => {
    const high = mkUser({ clientId: 'high', rating: 1500, wins: 0, createdAt: 9_000_000 });
    const low  = mkUser({ clientId: 'low',  rating: 1200, wins: 99, createdAt: 1_000_000 });
    assert.deepEqual(orderOf([low, high]), ['high', 'low']);
  });

  test('rating 동률 + wins 많은 쪽 — losses/draws/createdAt 무시', () => {
    const moreWins = mkUser({ clientId: 'wins', rating: 1200, wins: 10, losses: 100, draws: 0, createdAt: 9000 });
    const lessWins = mkUser({ clientId: 'less', rating: 1200, wins: 1,  losses: 0,   draws: 99, createdAt: 1 });
    assert.deepEqual(orderOf([lessWins, moreWins]), ['wins', 'less']);
  });
});

describe('compareForRanking — 동일 user (자기 자신) 비교', () => {
  test('완전 동일 → 0 (stable sort 가 원본 순서 유지)', () => {
    const u = mkUser({ clientId: 'x', rating: 1200, wins: 0, losses: 0, draws: 0, createdAt: 1000 });
    assert.equal(compareForRanking(u, u), 0);
    assert.equal(compareForRanking({ ...u }, { ...u }), 0);
  });
});
