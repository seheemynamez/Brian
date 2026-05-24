// ============================================================
// Unranked (placement) feature 단위 테스트.
// PLACEMENT_GAMES = 10 미만 사람 user 는 랭킹/티어/레이팅 display 가림.
// internal Elo 는 그대로. 10판 채우면 자동 rated.
// ============================================================

'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { getStore } = require('../../store');
const { BOT_NICKNAMES } = require('../../game/bot');
const {
  getOrCreateUser, recordGameResult,
  getTopRanking, getMyRankEntry, getUserStats,
  buildPlayerRatings,
  isUnranked, PLACEMENT_GAMES,
} = require('../../domain/users');

const store = getStore();

// 같은 store singleton 을 모든 test 가 공유 → 매 test 마다 cache clear.
beforeEach(() => {
  store.users.clear();
  store.recentGames.length = 0;
});

// 봇은 항상 rated — bot slot 만들기 (recordGameResult 호출용).
// nickname 은 BOT_NICKNAMES 정확히 일치 — recordGameResult 의 bot_nickname_warn 회피.
const mkBotSlot = (color, difficulty = 'medium') => ({
  clientId: `_bot_${difficulty}`,
  nickname: BOT_NICKNAMES[difficulty],
  type: 'bot',
  difficulty,
  color,
});
const mkHumanSlot = (cid, nick = 'human', color = 'black') => ({
  clientId: cid,
  nickname: nick,
  type: 'human',
  color,
});

// 사람 vs 봇 게임 1판 (사람이 black 으로 black 승)
const playOneBotGame = (humanCid, humanNick, opts = {}) => {
  const winner = opts.winner || 'black';   // 사람이 흑이고 흑 승 (default 사람 승)
  const room = {
    gameId: `g_${humanCid}_${Date.now()}_${Math.random()}`,
    code: 'TEST',
    hasBot: true,
    players: {
      black: mkHumanSlot(humanCid, humanNick, 'black'),
      white: mkBotSlot('white'),
    },
  };
  return recordGameResult(room, { winnerColor: winner, reason: winner === 'draw' ? 'draw' : 'five' });
};

// ============================================================
// isUnranked / PLACEMENT_GAMES — 기본 의미
// ============================================================
describe('isUnranked — 사람 user 10판 기준', () => {
  test('PLACEMENT_GAMES = 10', () => {
    assert.equal(PLACEMENT_GAMES, 10);
  });

  test('갓 만든 사람 user (0판) → unranked', () => {
    const u = getOrCreateUser('h1', 'h1');
    assert.equal(isUnranked(u), true);
  });

  test('9판 (W+L+D 합산) → unranked', () => {
    const u = getOrCreateUser('h2', 'h2');
    u.wins = 4; u.losses = 3; u.draws = 2;  // 9판
    assert.equal(isUnranked(u), true);
  });

  test('정확히 10판 → rated', () => {
    const u = getOrCreateUser('h3', 'h3');
    u.wins = 5; u.losses = 3; u.draws = 2;  // 10판
    assert.equal(isUnranked(u), false);
  });

  test('봇은 0판이어도 항상 rated', () => {
    const bot = getOrCreateUser('_bot_easy', '봇', { botDifficulty: 'easy' });
    assert.equal(isUnranked(bot), false);
  });

  test('null / 미정의 user → false (방어적)', () => {
    assert.equal(isUnranked(null), false);
    assert.equal(isUnranked(undefined), false);
  });
});

// ============================================================
// getTopRanking — unranked 제외
// ============================================================
describe('getTopRanking — unranked 사람 user 완전 제외', () => {
  test('rated 사람 + unranked 사람 + 봇 섞여있을 때 unranked 만 빠짐', () => {
    // rated 사람 (10판 채움, high rating)
    const rated = getOrCreateUser('rated1', 'rated1');
    rated.wins = 10; rated.rating = 1500;
    // unranked 사람 (5판, high rating 이라도 제외돼야 함)
    const unr = getOrCreateUser('unr1', 'unr1');
    unr.wins = 5; unr.rating = 1800;
    // 봇 (rated)
    const bot = getOrCreateUser('_bot_hard', '하드봇', { botDifficulty: 'hard' });
    bot.rating = 1400;

    const top = getTopRanking(10);
    const cids = top.map((e) => e.clientId);
    assert.deepEqual(cids.sort(), ['_bot_hard', 'rated1']);
    assert.ok(!cids.includes('unr1'));
  });

  test('모두 unranked 면 빈 배열', () => {
    for (let i = 0; i < 3; i++) {
      const u = getOrCreateUser(`u${i}`, `u${i}`);
      u.wins = 2; u.losses = 2; u.draws = 2;  // 6판
    }
    assert.deepEqual(getTopRanking(10), []);
  });

  test('rated entries 정렬 — rating desc 유지', () => {
    const a = getOrCreateUser('a', 'a'); a.wins = 10; a.rating = 1300;
    const b = getOrCreateUser('b', 'b'); b.wins = 10; b.rating = 1600;
    const c = getOrCreateUser('c', 'c'); c.wins = 10; c.rating = 1450;
    const top = getTopRanking(10);
    assert.deepEqual(top.map((e) => e.clientId), ['b', 'c', 'a']);
  });
});

// ============================================================
// getMyRankEntry — unranked vs rated 분기
// ============================================================
describe('getMyRankEntry — unranked 면 placement 정보, rated 면 rank', () => {
  test('unranked 사람: { unranked: true, placement: { played, needed: 10 } }', () => {
    const u = getOrCreateUser('me', 'me');
    u.wins = 3; u.losses = 1;  // 4판
    const e = getMyRankEntry('me');
    assert.equal(e.unranked, true);
    assert.deepEqual(e.placement, { played: 4, needed: 10 });
    assert.equal(e.rank, undefined);
    assert.equal(e.rating, undefined);
    assert.equal(e.tier, undefined);
    // nickname / W/L/D 는 노출 (본인 화면)
    assert.equal(e.nickname, 'me');
    assert.equal(e.wins, 3);
    assert.equal(e.losses, 1);
  });

  test('rated 사람: rank/rating/tier 정상 반환, placement 없음', () => {
    // 다른 rated 1명도 만들어 rank 검증
    const other = getOrCreateUser('other', 'other'); other.wins = 10; other.rating = 1700;
    const me = getOrCreateUser('me', 'me'); me.wins = 10; me.rating = 1500;
    const e = getMyRankEntry('me');
    assert.equal(e.unranked, undefined);
    assert.equal(e.placement, undefined);
    assert.equal(e.rank, 2);  // 1700 > 1500
    assert.equal(e.rating, 1500);
    assert.equal(typeof e.tier, 'string');
  });

  test('rated entry 의 rank — unranked 사람 제외하고 계산', () => {
    // unranked 인데 rating 만 높은 사람이 rated 의 rank 를 깎으면 안 됨.
    const unr = getOrCreateUser('unr', 'unr'); unr.wins = 5; unr.rating = 2500;
    const me = getOrCreateUser('me', 'me'); me.wins = 10; me.rating = 1500;
    const e = getMyRankEntry('me');
    assert.equal(e.rank, 1);  // unr 는 unranked 라 제외 → me 가 1위
  });

  test('미등록 clientId → null', () => {
    assert.equal(getMyRankEntry('ghost'), null);
  });
});

// ============================================================
// recordGameResult — placementJustReached flag
// ============================================================
describe('recordGameResult — placementJustReached on 10th game', () => {
  test('9판→10판 (placement 통과) 시 black.placementJustReached = true', () => {
    const human = getOrCreateUser('h', 'h');
    human.wins = 5; human.losses = 4;  // 9판 → 다음 게임이 10번째
    const entry = playOneBotGame('h', 'h', { winner: 'black' });  // 사람 승 → wins=6, 총 10
    assert.equal(entry.black.placementJustReached, true);
    assert.equal(entry.black.unranked, false);  // 통과 직후 → rated
    assert.deepEqual(entry.black.placement, { played: 10, needed: 10 });
  });

  test('8판→9판 → placementJustReached = false (아직 미달)', () => {
    const human = getOrCreateUser('h', 'h');
    human.wins = 4; human.losses = 4;  // 8판
    const entry = playOneBotGame('h', 'h', { winner: 'black' });  // 9판 됨
    assert.equal(entry.black.placementJustReached, false);
    assert.equal(entry.black.unranked, true);  // 아직 unranked
    assert.deepEqual(entry.black.placement, { played: 9, needed: 10 });  // 본인 화면 진행도 표시 source
  });

  test('10판→11판 (이미 rated) → placementJustReached = false', () => {
    const human = getOrCreateUser('h', 'h');
    human.wins = 5; human.losses = 5;  // 10판
    const entry = playOneBotGame('h', 'h', { winner: 'black' });  // 11판
    assert.equal(entry.black.placementJustReached, false);
    assert.equal(entry.black.unranked, false);
    // placement 는 rated 도 동봉 — client 가 unranked flag 로 분기.
    assert.deepEqual(entry.black.placement, { played: 11, needed: 10 });
  });

  test('봇 사이드는 placementJustReached + placement 모두 null/false', () => {
    const human = getOrCreateUser('h', 'h');
    human.wins = 5; human.losses = 4;  // 9판
    const entry = playOneBotGame('h', 'h', { winner: 'black' });
    assert.equal(entry.white.placementJustReached, false);  // 봇 side
    assert.equal(entry.white.unranked, false);
    assert.equal(entry.white.placement, null);
  });
});

// ============================================================
// getUserStats — Unranked tier 카운트
// ============================================================
describe('getUserStats — tiers.Unranked 8번째 key', () => {
  test('Unranked key 가 항상 존재 (0 명이어도)', () => {
    const s = getUserStats();
    assert.ok('Unranked' in s.tiers);
    assert.equal(s.tiers.Unranked, 0);
  });

  test('사람 user 의 tier 카운트가 unranked 면 Unranked 로, rated 면 해당 티어로', () => {
    // unranked 사람 2명
    const u1 = getOrCreateUser('u1', 'u1'); u1.wins = 2; u1.rating = 1500;  // Gold but unranked
    const u2 = getOrCreateUser('u2', 'u2'); u2.wins = 0;
    // rated Iron (10판)
    const r1 = getOrCreateUser('r1', 'r1'); r1.wins = 10; r1.rating = 1050;
    // rated Gold (10판)
    const r2 = getOrCreateUser('r2', 'r2'); r2.wins = 10; r2.rating = 1500;
    // 봇 — tiers 에 카운트 X
    getOrCreateUser('_bot_easy', '봇', { botDifficulty: 'easy' });

    const s = getUserStats();
    assert.equal(s.tiers.Unranked, 2);
    assert.equal(s.tiers.Iron, 1);
    assert.equal(s.tiers.Gold, 1);
    assert.equal(s.tiers.Master, 0);
    // 합계 = 사람 user 수
    const total = Object.values(s.tiers).reduce((a, b) => a + b, 0);
    assert.equal(total, 4);
    assert.equal(s.total_human_users, 4);
  });
});

// ============================================================
// buildPlayerRatings — unranked 사람은 null
// ============================================================
describe('buildPlayerRatings — unranked 사람 사이드는 null', () => {
  test('user 가 아직 없는 사람 (recordGameResult 전) → null', () => {
    // getOrCreateUser 호출 안 함 → game_start 시점엔 user 가 아직 없음.
    const room = {
      players: {
        black: mkHumanSlot('newbie', 'newbie', 'black'),
        white: mkBotSlot('white', 'medium'),
      },
    };
    const r = buildPlayerRatings(room);
    assert.equal(r.black, null);  // 신규 user 도 unranked 취급
    assert.equal(typeof r.white, 'number');
  });

  test('unranked 사람 vs 봇 → black=null, white=봇 rating', () => {
    const h = getOrCreateUser('h', 'h'); h.wins = 2;  // unranked
    const room = {
      players: {
        black: mkHumanSlot('h', 'h', 'black'),
        white: mkBotSlot('white', 'medium'),
      },
    };
    const r = buildPlayerRatings(room);
    assert.equal(r.black, null);
    assert.equal(typeof r.white, 'number');
  });

  test('rated 사람 vs rated 사람 → 양쪽 모두 number', () => {
    const a = getOrCreateUser('a', 'a'); a.wins = 10; a.rating = 1500;
    const b = getOrCreateUser('b', 'b'); b.wins = 10; b.rating = 1300;
    const room = {
      players: {
        black: mkHumanSlot('a', 'a', 'black'),
        white: mkHumanSlot('b', 'b', 'white'),
      },
    };
    const r = buildPlayerRatings(room);
    assert.equal(r.black, 1500);
    assert.equal(r.white, 1300);
  });

  test('unranked vs rated → 양쪽 비대칭 (rated 만 보임)', () => {
    const a = getOrCreateUser('a', 'a'); a.wins = 10; a.rating = 1700;
    const b = getOrCreateUser('b', 'b'); b.wins = 1;  // unranked
    const room = {
      players: {
        black: mkHumanSlot('a', 'a', 'black'),
        white: mkHumanSlot('b', 'b', 'white'),
      },
    };
    const r = buildPlayerRatings(room);
    assert.equal(r.black, 1700);
    assert.equal(r.white, null);
  });
});
