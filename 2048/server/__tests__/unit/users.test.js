// ============================================================
// 2048 users domain — unit tests
// ============================================================
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// 새 import 마다 fresh — store 가 module level singleton 이라 각 테스트가 isolated 하려면
// jest 처럼 module cache invalidation 이 필요. 여기선 단일 file 안에서 누적 검증.
const users = require('../../domain/users');

describe('users.submitScore', () => {
  test('첫 등록 — all-time 과 daily 모두 갱신', () => {
    const r = users.submitScore('c1', '닉네임1', 100);
    assert.ok(r);
    assert.equal(r.user.nickname, '닉네임1');
    assert.equal(r.user.allTimeBest, 100);
    assert.equal(r.user.dailyBest, 100);
    assert.ok(r.allTimeUpdated);
    assert.ok(r.dailyUpdated);
  });

  test('낮은 점수 — 갱신 안 됨', () => {
    const r = users.submitScore('c1', '닉네임1', 50);
    assert.equal(r.allTimeUpdated, false);
    assert.equal(r.dailyUpdated, false);
    assert.equal(r.user.allTimeBest, 100);
  });

  test('더 높은 점수 — 둘 다 갱신', () => {
    const r = users.submitScore('c1', '닉네임1', 200);
    assert.ok(r.allTimeUpdated);
    assert.ok(r.dailyUpdated);
    assert.equal(r.user.allTimeBest, 200);
  });

  test('잘못된 점수 — null 반환', () => {
    assert.equal(users.submitScore('c1', '', -1), null);
    assert.equal(users.submitScore('', '닉', 100), null);
    assert.equal(users.submitScore('c1', '', 'NaN'), null);
  });
});

describe('users.setNickname', () => {
  test('닉네임 변경 후에도 점수 유지', () => {
    const u = users.setNickname('c1', '새닉');
    assert.equal(u.nickname, '새닉');
    assert.equal(u.allTimeBest, 200);   // 앞 테스트의 값
  });

  test('14 자 cutoff', () => {
    const u = users.setNickname('c2', 'a'.repeat(20));
    assert.equal(u.nickname.length, 14);
  });
});

describe('users.getTopAllTime / getTopDaily', () => {
  test('정렬 + 점수 0 제외', () => {
    users.submitScore('c3', 'C', 300);
    users.submitScore('c4', 'D', 50);
    const top = users.getTopAllTime(10);
    // c3 (300) > c1 (200) > c4 (50). c2 (0) 는 필터링.
    assert.equal(top[0].clientId, 'c3');
    assert.equal(top[0].score, 300);
    assert.equal(top[1].clientId, 'c1');
    assert.equal(top[1].score, 200);
    assert.equal(top[2].clientId, 'c4');
  });
});

describe('users.getMyRank', () => {
  test('clientId 의 all-time / daily 순위 + 총 인원', () => {
    const r = users.getMyRank('c1');
    assert.ok(r);
    assert.equal(r.nickname, '새닉');
    assert.equal(r.allTime.rank, 2);   // c3 다음
    assert.ok(r.allTime.total >= 3);
  });

  test('미등록 clientId — null', () => {
    assert.equal(users.getMyRank('unknown'), null);
  });
});

describe('users.kstDateStr', () => {
  test('KST = UTC + 9h 적용', () => {
    // UTC 2026-01-01 00:00:00 → KST 09:00 같은 날
    const ms = Date.UTC(2026, 0, 1, 0, 0, 0);
    assert.equal(users.kstDateStr(ms), '2026-01-01');
    // UTC 2026-01-01 16:00:00 → KST 01:00 다음 날
    const ms2 = Date.UTC(2026, 0, 1, 16, 0, 0);
    assert.equal(users.kstDateStr(ms2), '2026-01-02');
  });
});
