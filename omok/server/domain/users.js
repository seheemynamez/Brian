// ============================================================
// User profile + ranking + recent games — store-backed.
// ============================================================
// 봇도 동일 user profile 가짐. 초기 rating 만 다름 (BOT_INITIAL_RATING).
// 게임 종료마다 양쪽 user 의 rating / 승패 갱신 + recent_games 에 entry 추가.

'use strict';

const { getStore } = require('../store');
const {
  INITIAL_RATING, BOT_INITIAL_RATING,
  computeDeltas, getTier, resultForBlack, TIER_THRESHOLDS,
} = require('../game/rating');
const { BOT_NICKNAMES } = require('../game/bot');
const log = require('../infra/log');

// Placement (배치) — 사람 user 가 PLACEMENT_GAMES 미만 플레이 시 unranked.
// PVP+봇 합산. unranked 는 랭킹/티어/레이팅 display 가리고 internal Elo 는 그대로.
const PLACEMENT_GAMES = 10;
const playedCount = (u) => (u?.wins || 0) + (u?.losses || 0) + (u?.draws || 0);
const isUnranked = (u) => !!u && !u.isBot && playedCount(u) < PLACEMENT_GAMES;

// 봇 clientId 식별 — recordGameResult 의 nickname 덮어쓰기 추적용.
const isBotClientId = (cid) => typeof cid === 'string' && cid.startsWith('_bot_');
const expectedBotNickname = (cid) => {
  if (cid === '_bot_easy')   return BOT_NICKNAMES.easy;
  if (cid === '_bot_medium') return BOT_NICKNAMES.medium;
  if (cid === '_bot_hard')   return BOT_NICKNAMES.hard;
  return null;
};

const store = getStore();
const users = store.users;
const recentGames = store.recentGames;

const getUser = (clientId) => (clientId ? users.get(clientId) : null);

// game_start / resume_success / spectate_success payload 용 — user 가 없어도
// 추정 rating 반환 (생성 안 함). recordGameResult 가 호출돼야만 user 가 생성됨.
const getRatingPreview = (clientId, isBot = false, botDifficulty = null) => {
  const u = clientId ? users.get(clientId) : null;
  if (u) return u.rating;
  if (isBot && botDifficulty) {
    const botKey = `_bot_${botDifficulty}`;
    return BOT_INITIAL_RATING[botKey] ?? INITIAL_RATING;
  }
  return INITIAL_RATING;
};

// room.players 양쪽 색의 rating 을 한꺼번에 — 핸들러에서 game_start payload 빌드용.
// 사람 사이드: user 가 아직 없거나 (recordGameResult 호출 전) unranked 면 null
// → 상대/관전자에게 rating/tier 노출 안 됨. 봇은 항상 노출.
const ratingForSlot = (slot) => {
  if (!slot) return null;
  if (slot.type === 'bot') {
    return getRatingPreview(slot.clientId, true, slot.difficulty);
  }
  const u = slot.clientId ? users.get(slot.clientId) : null;
  if (!u || isUnranked(u)) return null;
  return u.rating;
};
const buildPlayerRatings = (room) => ({
  black: ratingForSlot(room?.players?.black),
  white: ratingForSlot(room?.players?.white),
});

// 없으면 새로 만들고 valkey 에도 sync. 봇이면 봇 전용 초기 rating.
// 있으면 nickname 만 마지막 값으로 업데이트 (마지막 사용한 닉 보존).
const getOrCreateUser = (clientId, nickname, opts = {}) => {
  if (!clientId) return null;
  const existing = users.get(clientId);
  if (existing) {
    if (nickname && nickname !== existing.nickname) {
      existing.nickname = nickname;
      existing.updatedAt = Date.now();
      store.persistUser(clientId, existing);
    }
    return existing;
  }
  const isBot = !!opts.botDifficulty;
  const initialRating = isBot
    ? (BOT_INITIAL_RATING[clientId] ?? INITIAL_RATING)
    : INITIAL_RATING;
  const user = {
    clientId,
    nickname: nickname || (isBot ? clientId : '익명'),
    rating: initialRating,
    wins: 0,
    losses: 0,
    draws: 0,
    isBot,
    botDifficulty: opts.botDifficulty || null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  users.set(clientId, user);
  store.persistUser(clientId, user);
  return user;
};

// 게임 결과 적용 — rating 변동 + 승패 카운트 + recent_games 추가.
// winnerColor: 'black' | 'white' | 'draw'
// reason: 'five' | 'draw' | 'abandoned' | 'opponent_left' | 'timeout'
// bothDisconnected: true 면 양쪽 동시 끊김 — rating 변화 없음 (의사결정).
// 반환: recent_games entry (broadcast 용) 또는 null.
const recordGameResult = (room, { winnerColor, reason, bothDisconnected = false }) => {
  if (!room || !room.players) return null;
  if (bothDisconnected) return null;
  const blackSlot = room.players.black;
  const whiteSlot = room.players.white;
  if (!blackSlot || !whiteSlot) return null;

  const blackUser = getOrCreateUser(blackSlot.clientId, blackSlot.nickname, {
    botDifficulty: blackSlot.type === 'bot' ? blackSlot.difficulty : null,
  });
  const whiteUser = getOrCreateUser(whiteSlot.clientId, whiteSlot.nickname, {
    botDifficulty: whiteSlot.type === 'bot' ? whiteSlot.difficulty : null,
  });
  if (!blackUser || !whiteUser) return null;

  const resultBlack = resultForBlack(winnerColor);
  const { deltaA: deltaBlack, deltaB: deltaWhite } =
    computeDeltas(blackUser.rating, whiteUser.rating, resultBlack);

  // placement 진입 직전 played count snapshot — 이 게임으로 PLACEMENT_GAMES 달성하면
  // entry 에 placementJustReached: true 표시. game_over 화면이 "티어 부여" 메세지 표시용.
  const blackPlayedBefore = playedCount(blackUser);
  const whitePlayedBefore = playedCount(whiteUser);

  blackUser.rating += deltaBlack;
  whiteUser.rating += deltaWhite;
  if (winnerColor === 'black')      { blackUser.wins++;  whiteUser.losses++; }
  else if (winnerColor === 'white') { whiteUser.wins++;  blackUser.losses++; }
  else                              { blackUser.draws++; whiteUser.draws++;  }
  // 봇 user.nickname 이 잘못 덮어쓰기 되는 버그 추적용 logging — 봇 slot 의 nickname 이
  // BOT_NICKNAMES 와 다른 값이면 어딘가에서 mutation 이 일어났다는 단서.
  for (const [color, slot, user] of [['black', blackSlot, blackUser], ['white', whiteSlot, whiteUser]]) {
    if (isBotClientId(slot.clientId)) {
      const expected = expectedBotNickname(slot.clientId);
      if (slot.nickname && expected && slot.nickname !== expected) {
        log.warn('bot_nickname_warn', {
          src: 'recordGameResult',
          code: room.code, gameId: room.gameId, color,
          botClientId: slot.clientId, expected, gotSlotNickname: slot.nickname,
          oppColor: color === 'black' ? 'white' : 'black',
          oppNickname: (color === 'black' ? whiteSlot : blackSlot).nickname,
          oppClientId: (color === 'black' ? whiteSlot : blackSlot).clientId,
        });
      }
    }
  }
  if (blackSlot.nickname) blackUser.nickname = blackSlot.nickname;
  if (whiteSlot.nickname) whiteUser.nickname = whiteSlot.nickname;
  blackUser.updatedAt = Date.now();
  whiteUser.updatedAt = Date.now();

  store.persistUser(blackSlot.clientId, blackUser);
  store.persistUser(whiteSlot.clientId, whiteUser);

  const entry = {
    gameId: room.gameId,
    code: room.code,
    endedAt: Date.now(),
    winner: winnerColor,
    reason,
    isBot: !!room.hasBot,
    black: {
      clientId: blackSlot.clientId,
      nickname: blackUser.nickname,
      rating: blackUser.rating,
      delta: deltaBlack,
      isBot: blackSlot.type === 'bot',
      unranked: isUnranked(blackUser),
      placementJustReached:
        !blackUser.isBot &&
        blackPlayedBefore === PLACEMENT_GAMES - 1 &&
        playedCount(blackUser) === PLACEMENT_GAMES,
      placement: blackUser.isBot
        ? null
        : { played: playedCount(blackUser), needed: PLACEMENT_GAMES },
    },
    white: {
      clientId: whiteSlot.clientId,
      nickname: whiteUser.nickname,
      rating: whiteUser.rating,
      delta: deltaWhite,
      isBot: whiteSlot.type === 'bot',
      unranked: isUnranked(whiteUser),
      placementJustReached:
        !whiteUser.isBot &&
        whitePlayedBefore === PLACEMENT_GAMES - 1 &&
        playedCount(whiteUser) === PLACEMENT_GAMES,
      placement: whiteUser.isBot
        ? null
        : { played: playedCount(whiteUser), needed: PLACEMENT_GAMES },
    },
  };
  store.persistRecentGame(entry);
  return entry;
};

// 랭킹 정렬 기준 — getTopRanking / getMyRankEntry 가 같은 순서를 보이도록 공유.
// 1차: rating desc
// 2차: wins desc (같은 rating 일 때 승 많은 쪽 위)
// 3차: losses asc (그래도 같으면 패 적은 쪽 위)
// 4차: draws desc (그래도 같으면 게임 수 많은 쪽 위)
// 5차: createdAt asc (승패무 모두 동률이면 먼저 가입한 사람이 위)
//
// createdAt 미존재 (호환성) 시 Infinity → 신규 user 처럼 가장 뒤로 밀림.
const compareForRanking = (a, b) => {
  if (b.rating !== a.rating) return b.rating - a.rating;
  if (b.wins   !== a.wins)   return b.wins   - a.wins;
  if (a.losses !== b.losses) return a.losses - b.losses;
  if (b.draws  !== a.draws)  return b.draws  - a.draws;
  return (a.createdAt || Infinity) - (b.createdAt || Infinity);
};

// 첫 게임 흑백 결정 — 약자 (= 흑, 선공) 우선. compareForRanking 의 정확한 역순.
//   1차: rating asc (낮은 사람 흑)
//   2차: wins asc (이긴 게임 적은 사람 흑)
//   3차: losses desc (진 게임 많은 사람 흑)
//   4차: draws asc (게임 수 적은 사람 흑)
//   5차: createdAt desc (나중 가입자 흑 — 신규 user 우대)
// 음수 = a 가 흑 우선. 봇 user 도 동일 user 객체 형식이라 비교 가능.
const compareForBlack = (a, b) => {
  if (a.rating !== b.rating) return a.rating - b.rating;
  if (a.wins   !== b.wins)   return a.wins   - b.wins;
  if (b.losses !== a.losses) return b.losses - a.losses;
  if (a.draws  !== b.draws)  return a.draws  - b.draws;
  return (b.createdAt || 0) - (a.createdAt || 0);
};

// slot ({clientId, type, difficulty?, nickname}) → user 객체 형식 ({rating, wins, ...}).
// 사람: getOrCreateUser 로 internal user 가져옴 (placement 미달도 internal rating
// 보유). 봇: 봇 user 가 없을 수도 있으니 (recordGameResult 전) BOT_INITIAL_RATING
// 폴백. compareForBlack 가 직접 사용할 수 있는 shape 반환.
const userForSlot = (slot) => {
  if (!slot) return null;
  if (slot.type === 'bot') {
    const u = slot.clientId ? users.get(slot.clientId) : null;
    if (u) return u;
    // 봇 user 미생성 — INITIAL_RATING 기반 가상 user (createdAt 0 → 가장 옛).
    return {
      clientId: slot.clientId,
      rating: BOT_INITIAL_RATING[slot.clientId] ?? INITIAL_RATING,
      wins: 0, losses: 0, draws: 0,
      isBot: true,
      createdAt: 0,
    };
  }
  // 사람: 룸 들어오는 시점에 user 가 없을 수도 있음 (set_nickname 미호출). 신규 가상 user.
  const u = slot.clientId ? users.get(slot.clientId) : null;
  if (u) return u;
  return {
    clientId: slot.clientId,
    rating: INITIAL_RATING,
    wins: 0, losses: 0, draws: 0,
    isBot: false,
    createdAt: Date.now(),  // 신규 → createdAt 최신 → 약자 tiebreak 우선
  };
};

// 메모리 cache 의 users 를 정렬 → top N 반환.
// unranked 사람 user (PLACEMENT_GAMES 미만) 는 완전 제외 — 봇은 포함 (배치 무관).
const getTopRanking = (limit = 10) => {
  const arr = Array.from(users.values()).filter((u) => !isUnranked(u));
  arr.sort(compareForRanking);
  return arr.slice(0, limit).map((u) => ({
    clientId: u.clientId,
    nickname: u.nickname,
    rating: u.rating,
    tier: getTier(u.rating),
    wins: u.wins,
    losses: u.losses,
    draws: u.draws,
    isBot: u.isBot,
  }));
};

const getRecentGames = (limit = 10) => recentGames.slice(0, limit);

// 특정 clientId 의 ranking entry. user 미등록이면 null.
// unranked 면 rank/rating/tier 대신 placement 정보만 반환 → 클라가 "프레이스 N/10" 표시.
const getMyRankEntry = (clientId) => {
  if (!clientId) return null;
  const u = users.get(clientId);
  if (!u) return null;
  if (isUnranked(u)) {
    return {
      unranked: true,
      placement: { played: playedCount(u), needed: PLACEMENT_GAMES },
      clientId: u.clientId,
      nickname: u.nickname,
      wins: u.wins,
      losses: u.losses,
      draws: u.draws,
      isBot: u.isBot,
    };
  }
  const arr = Array.from(users.values()).filter((x) => !isUnranked(x));
  arr.sort(compareForRanking);
  const idx = arr.findIndex((x) => x.clientId === clientId);
  if (idx < 0) return null;
  return {
    rank: idx + 1,
    clientId: u.clientId,
    nickname: u.nickname,
    rating: u.rating,
    tier: getTier(u.rating),
    wins: u.wins,
    losses: u.losses,
    draws: u.draws,
    isBot: u.isBot,
  };
};

// 운영 통계 — /api/stats endpoint 용 (PR #95). 봇 user 는 제외 (사람 계정만).
// total_human_users = recordGameResult 가 한 번이라도 호출된 사람 user 수.
// active 는 server 가 lastPlayedAt 추적 안 해서 monitor.py 가 game_over 로그로 계산.
//
// tiers (PR — daily-summary 의 티어 분포 표 용): 각 티어 별 사람 user 수.
// 발행 시점 (호출 시점) snapshot. 0명 티어도 키는 보존 (trend 일관성).
//
// bots (PR — monitor 의 봇 rating 정확성 향상): 봇 user 의 현재 누적값.
// 옛 코드는 봇 제외 → monitor 가 24h game_over 로그의 마지막 botRating 추정
// (24h 외 봇 게임 후 stale). 이제 직접 노출. clientId 형식 `_bot_{difficulty}`
// 에서 difficulty 만 키로.
// tiers: 기존 7 티어 + 'Unranked' (PLACEMENT_GAMES 미만 사람 user) = 8키.
// 모든 사람 user 는 정확히 하나의 티어에 카운트. 봇은 아예 제외.
const getUserStats = () => {
  const tiers = Object.fromEntries(TIER_THRESHOLDS.map((t) => [t.name, 0]));
  tiers.Unranked = 0;
  const bots = {};
  let total = 0;
  for (const u of users.values()) {
    if (!u) continue;
    if (!u.isBot) {
      total++;
      if (isUnranked(u)) tiers.Unranked++;
      else tiers[getTier(u.rating)]++;
    } else if (typeof u.clientId === 'string' && u.clientId.startsWith('_bot_')) {
      const diff = u.clientId.slice('_bot_'.length);
      bots[diff] = {
        rating: u.rating,
        wins: u.wins || 0,
        losses: u.losses || 0,
        draws: u.draws || 0,
      };
    }
  }
  return { total_human_users: total, tiers, bots };
};

module.exports = {
  getUser, getOrCreateUser, recordGameResult,
  getTopRanking, getRecentGames, getMyRankEntry,
  getRatingPreview, buildPlayerRatings,
  getUserStats,                     // /api/stats endpoint 용 (PR #95)
  compareForRanking,  // unit test 용 — 정렬 로직 자체 검증
  compareForBlack,    // 첫 게임 흑백 결정 — 약자 우선
  userForSlot,        // slot → user 객체 (compareForBlack 입력용)
  isUnranked, playedCount, PLACEMENT_GAMES,  // unranked feature — handlers / tests
};
