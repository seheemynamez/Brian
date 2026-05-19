// ============================================================
// Elo 기반 레이팅 + 티어 계산. 순수 함수.
// ============================================================
// - 모든 user (사람 + 봇) 가 동일한 공식 적용. 봇은 초기 rating 만 다름.
// - 봇 rating 도 변동 — 사용자에게 자주 지면 떨어지고, 자주 이기면 오름.
// - 무승부는 양쪽 모두 0.5 score.
// - K-factor 32 (체스 일반 amateur 값). 영향 적당히 크게.

'use strict';

const INITIAL_RATING = 1500;
const K_FACTOR = 32;

// 봇 초기 rating — bot.js 의 BOT_IDS 와 매칭.
// easy=Bronze, medium=Gold, hard=Diamond 시작.
const BOT_INITIAL_RATING = {
  _bot_easy: 1000,
  _bot_medium: 1500,
  _bot_hard: 1900,
};

// Elo expected score: A 가 B 에게 이길 기댓값 (0~1).
const expectedScore = (ratingA, ratingB) =>
  1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));

// 두 user 의 게임 결과로 rating 변동 계산.
// resultA: 1 (A win), 0.5 (draw), 0 (A loss).
// 반환: { deltaA, deltaB } — zero-sum.
const computeDeltas = (ratingA, ratingB, resultA) => {
  const expA = expectedScore(ratingA, ratingB);
  const deltaA = Math.round(K_FACTOR * (resultA - expA));
  return { deltaA, deltaB: -deltaA };
};

// 티어 — rating 구간별 매핑. 게임 스타일 (FPS/MOBA) 명명.
const TIER_THRESHOLDS = [
  { name: 'Iron',     min: 0,    max: 1099 },
  { name: 'Bronze',   min: 1100, max: 1299 },
  { name: 'Silver',   min: 1300, max: 1499 },
  { name: 'Gold',     min: 1500, max: 1699 },
  { name: 'Platinum', min: 1700, max: 1899 },
  { name: 'Diamond',  min: 1900, max: 2099 },
  { name: 'Master',   min: 2100, max: Infinity },
];

const getTier = (rating) => {
  for (const t of TIER_THRESHOLDS) {
    if (rating >= t.min && rating <= t.max) return t.name;
  }
  return 'Iron';
};

// game-over reason → 양쪽의 resultA 계산.
// winnerColor: 'black' | 'white' | 'draw'.
// resultA 는 black 입장.
const resultForBlack = (winnerColor) => {
  if (winnerColor === 'black') return 1;
  if (winnerColor === 'white') return 0;
  return 0.5;
};

module.exports = {
  INITIAL_RATING,
  K_FACTOR,
  BOT_INITIAL_RATING,
  TIER_THRESHOLDS,
  expectedScore,
  computeDeltas,
  getTier,
  resultForBlack,
};
