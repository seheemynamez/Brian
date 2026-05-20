// ============================================================
// User profile + ranking + recent games — store-backed.
// ============================================================
// 봇도 동일 user profile 가짐. 초기 rating 만 다름 (BOT_INITIAL_RATING).
// 게임 종료마다 양쪽 user 의 rating / 승패 갱신 + recent_games 에 entry 추가.

'use strict';

const { getStore } = require('../store');
const {
  INITIAL_RATING, BOT_INITIAL_RATING,
  computeDeltas, getTier, resultForBlack,
} = require('../game/rating');
const { BOT_NICKNAMES } = require('../game/bot');

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
const buildPlayerRatings = (room) => {
  const blk = room?.players?.black;
  const wht = room?.players?.white;
  return {
    black: blk ? getRatingPreview(blk.clientId, blk.type === 'bot', blk.difficulty) : null,
    white: wht ? getRatingPreview(wht.clientId, wht.type === 'bot', wht.difficulty) : null,
  };
};

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
        console.error('[BOT_NICKNAME_WARN] recordGameResult', {
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
    },
    white: {
      clientId: whiteSlot.clientId,
      nickname: whiteUser.nickname,
      rating: whiteUser.rating,
      delta: deltaWhite,
      isBot: whiteSlot.type === 'bot',
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

// 메모리 cache 의 users 를 정렬 → top N 반환.
const getTopRanking = (limit = 10) => {
  const arr = Array.from(users.values());
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

// 특정 clientId 의 ranking entry + 전체 순위. user 미등록이면 null.
const getMyRankEntry = (clientId) => {
  if (!clientId) return null;
  const u = users.get(clientId);
  if (!u) return null;
  const arr = Array.from(users.values());
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

module.exports = {
  getUser, getOrCreateUser, recordGameResult,
  getTopRanking, getRecentGames, getMyRankEntry,
  getRatingPreview, buildPlayerRatings,
  compareForRanking,  // unit test 용 — 정렬 로직 자체 검증
};
