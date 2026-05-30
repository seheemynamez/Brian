// ============================================================
// 첫 게임 흑백 결정 — 약자 (= 흑, 선공) 우선 정책 단위 테스트.
// compareForBlack 자체 + assignColorsByRating 의 swap 동작.
// ============================================================

'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { getStore } = require('../../store');
const { getOrCreateUser, compareForBlack, userForSlot } = require('../../domain/users');
const { assignColorsByRating, swapSlots } = require('../../handlers/game');

const store = getStore();

// 같은 store singleton 을 모든 test 가 공유 → 매 test 마다 cache clear.
beforeEach(() => {
  store.users.clear();
  store.rooms.clear();
});

// helper
const mkRoom = (blackSlot, whiteSlot) => ({
  code: 'TEST',
  players: { black: blackSlot, white: whiteSlot },
});
const mkHumanSlot = (cid, nick) => ({
  type: 'human', clientId: cid, nickname: nick, sessionId: null,
});
const mkBotSlot = (diff) => ({
  type: 'bot', clientId: '_bot_' + diff, difficulty: diff, nickname: '봇·' + diff, sessionId: null,
});

// ============================================================
// compareForBlack — compareForRanking 의 정확한 역순
// ============================================================
describe('compareForBlack — 약자 우선 (rating asc → wins asc → losses desc → draws asc → createdAt desc)', () => {
  const mkUser = (overrides = {}) => ({
    clientId: 'x', rating: 1200, wins: 0, losses: 0, draws: 0, createdAt: Date.now(),
    ...overrides,
  });

  test('1차: rating 낮은 쪽이 흑', () => {
    const weak = mkUser({ clientId: 'w', rating: 1100 });
    const strong = mkUser({ clientId: 's', rating: 1500 });
    assert.ok(compareForBlack(weak, strong) < 0, 'weak (1100) should be black');
    assert.ok(compareForBlack(strong, weak) > 0);
  });

  test('2차: rating 동률 → wins 적은 쪽 흑', () => {
    const a = mkUser({ clientId: 'a', rating: 1200, wins: 1 });
    const b = mkUser({ clientId: 'b', rating: 1200, wins: 5 });
    assert.ok(compareForBlack(a, b) < 0);
  });

  test('3차: rating + wins 동률 → losses 많은 쪽 흑', () => {
    const a = mkUser({ clientId: 'a', rating: 1200, wins: 3, losses: 7 });
    const b = mkUser({ clientId: 'b', rating: 1200, wins: 3, losses: 2 });
    assert.ok(compareForBlack(a, b) < 0);
  });

  test('4차: rating/wins/losses 동률 → draws 적은 쪽 흑', () => {
    const a = mkUser({ clientId: 'a', rating: 1200, wins: 1, losses: 1, draws: 0 });
    const b = mkUser({ clientId: 'b', rating: 1200, wins: 1, losses: 1, draws: 5 });
    assert.ok(compareForBlack(a, b) < 0);
  });

  test('5차: 모두 동률 → createdAt 최신 (나중 가입자) 가 흑', () => {
    const old = mkUser({ clientId: 'old', createdAt: 100 });
    const newer = mkUser({ clientId: 'new', createdAt: 9000 });
    assert.ok(compareForBlack(newer, old) < 0, 'newer createdAt → black');
  });

  test('자기 자신 비교 → 0', () => {
    const u = mkUser({ clientId: 'x' });
    assert.equal(compareForBlack(u, u), 0);
  });

  test('compareForRanking 정확한 역순 — 동률 외 모든 차원 부호 반전', () => {
    const cases = [
      // [a, b] — a 가 강자 (rating 높음)
      [{ rating: 1500, wins: 0, losses: 0, draws: 0, createdAt: 100 },
       { rating: 1100, wins: 0, losses: 0, draws: 0, createdAt: 100 }],
      // a 가 wins 많음 (rating 같음)
      [{ rating: 1200, wins: 5, losses: 0, draws: 0, createdAt: 100 },
       { rating: 1200, wins: 1, losses: 0, draws: 0, createdAt: 100 }],
      // a 가 losses 적음 (rating/wins 같음)
      [{ rating: 1200, wins: 1, losses: 1, draws: 0, createdAt: 100 },
       { rating: 1200, wins: 1, losses: 5, draws: 0, createdAt: 100 }],
    ];
    const { compareForRanking } = require('../../domain/users');
    for (const [a, b] of cases) {
      const rank = compareForRanking(a, b);   // a 가 랭킹 위 (강자) → 음수
      const black = compareForBlack(a, b);    // a 가 흑 (약자) → 양수
      assert.ok((rank < 0 && black > 0) || (rank > 0 && black < 0),
        `a vs b 비교: 랭킹 ${rank} / 흑 ${black} 부호 반대 기대`);
    }
  });
});

// ============================================================
// userForSlot — 봇 slot, 사람 slot, 미존재 user 케이스
// ============================================================
describe('userForSlot — slot 종류 별 user 추출', () => {
  test('봇 slot + user 존재 → 그 user 반환', () => {
    const u = getOrCreateUser('_bot_easy', '봇easy', { botDifficulty: 'easy' });
    u.rating = 1300;
    const slot = mkBotSlot('easy');
    const result = userForSlot(slot);
    assert.equal(result.rating, 1300);
    assert.equal(result.isBot, true);
  });

  test('봇 slot + user 미존재 → BOT_INITIAL_RATING 가상 user', () => {
    const slot = mkBotSlot('medium');
    const result = userForSlot(slot);
    assert.equal(result.isBot, true);
    assert.ok(typeof result.rating === 'number');
    assert.equal(result.createdAt, 0);  // 가상 user createdAt=0
  });

  test('사람 slot + user 존재 → 그 user 반환', () => {
    const u = getOrCreateUser('cid_h', '사람');
    u.rating = 1400;
    const slot = mkHumanSlot('cid_h', '사람');
    const result = userForSlot(slot);
    assert.equal(result.rating, 1400);
  });

  test('사람 slot + user 미존재 → INITIAL_RATING 신규 가상 user', () => {
    const slot = mkHumanSlot('cid_new', '신규');
    const result = userForSlot(slot);
    assert.equal(result.rating, 1200);
    assert.equal(result.isBot, false);
  });
});

// ============================================================
// swapSlots / assignColorsByRating — 실제 swap 동작
// ============================================================
describe('assignColorsByRating — black 슬롯에 약자, 강자면 swap', () => {
  test('현재 black 슬롯이 약자 → swap 안 일어남', () => {
    const weak = getOrCreateUser('weak', 'weak'); weak.rating = 1100;
    const strong = getOrCreateUser('strong', 'strong'); strong.rating = 1500;
    const room = mkRoom(mkHumanSlot('weak', 'weak'), mkHumanSlot('strong', 'strong'));
    assignColorsByRating(room);
    assert.equal(room.players.black.clientId, 'weak');
    assert.equal(room.players.white.clientId, 'strong');
  });

  test('현재 black 슬롯이 강자 → swap 일어남', () => {
    const weak = getOrCreateUser('weak', 'weak'); weak.rating = 1100;
    const strong = getOrCreateUser('strong', 'strong'); strong.rating = 1500;
    const room = mkRoom(mkHumanSlot('strong', 'strong'), mkHumanSlot('weak', 'weak'));
    assignColorsByRating(room);
    assert.equal(room.players.black.clientId, 'weak', '약자가 흑이 되어야');
    assert.equal(room.players.white.clientId, 'strong');
  });

  test('동률 — createdAt tie-break (나중 가입자가 흑)', () => {
    const older = getOrCreateUser('older', 'older'); older.rating = 1200; older.createdAt = 100;
    const newer = getOrCreateUser('newer', 'newer'); newer.rating = 1200; newer.createdAt = 9000;
    const room = mkRoom(mkHumanSlot('older', 'older'), mkHumanSlot('newer', 'newer'));
    assignColorsByRating(room);
    assert.equal(room.players.black.clientId, 'newer', '나중 가입자 흑');
  });

  test('봇 강자 + 사람 약자 (예: hard 1500 vs unranked 사람 1200) → 사람 흑', () => {
    const human = getOrCreateUser('h', 'h'); human.rating = 1200; // unranked OK
    const hardBot = getOrCreateUser('_bot_hard', '하드', { botDifficulty: 'hard' });
    hardBot.rating = 1500;
    const room = mkRoom(mkBotSlot('hard'), mkHumanSlot('h', 'h'));  // 봇이 black 슬롯
    assignColorsByRating(room);
    assert.equal(room.players.black.clientId, 'h', '약자 사람 흑');
    assert.equal(room.players.white.clientId, '_bot_hard');
  });

  test('봇 약자 + 사람 강자 (예: easy 1200 vs Gold 사람 1550) → 봇 흑', () => {
    const human = getOrCreateUser('h', 'h'); human.rating = 1550;
    const easyBot = getOrCreateUser('_bot_easy', '이지', { botDifficulty: 'easy' });
    easyBot.rating = 1200;
    const room = mkRoom(mkHumanSlot('h', 'h'), mkBotSlot('easy'));
    assignColorsByRating(room);
    assert.equal(room.players.black.clientId, '_bot_easy', '약자 봇 흑');
    assert.equal(room.players.white.clientId, 'h');
  });

  test('slot 비어있으면 no-op', () => {
    const room = mkRoom(null, mkHumanSlot('a', 'a'));
    assignColorsByRating(room);
    assert.equal(room.players.black, null);
  });
});

describe('swapSlots — slot 자체 swap (sessions/ws 동기화는 통합 테스트에서)', () => {
  test('단순 black ↔ white slot 객체 교체', () => {
    const a = mkHumanSlot('a', 'A');
    const b = mkHumanSlot('b', 'B');
    const room = mkRoom(a, b);
    swapSlots(room);
    assert.equal(room.players.black, b);
    assert.equal(room.players.white, a);
  });
});
