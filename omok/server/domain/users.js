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

const store = getStore();
const users = store.users;
const recentGames = store.recentGames;

const getUser = (clientId) => (clientId ? users.get(clientId) : null);

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

// 메모리 cache 의 users 를 rating desc 로 sort → top N 반환.
// tie-break: wins desc → losses asc.
const getTopRanking = (limit = 10) => {
  const arr = Array.from(users.values());
  arr.sort((a, b) => {
    if (b.rating !== a.rating) return b.rating - a.rating;
    if (b.wins !== a.wins) return b.wins - a.wins;
    return a.losses - b.losses;
  });
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

module.exports = {
  getUser, getOrCreateUser, recordGameResult,
  getTopRanking, getRecentGames,
};
