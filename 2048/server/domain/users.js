// ============================================================
// 2048 user / ranking 도메인 — Aiven Valkey backed (omok 와 동일 인스턴스, prefix 격리).
// ============================================================
// User 모델:
//   { clientId, nickname, allTimeBest, dailyBest, dailyDate, createdAt, updatedAt }
// 랭킹:
//   - All-time: allTimeBest desc
//   - Daily: dailyBest desc — KST 자정 00:00 reset (dailyDate 비교로 lazy reset)
// ============================================================

'use strict';

const { getStore } = require('../store');

const store = getStore();
const users = store.users;  // Map<clientId, user>

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// 지금 시점의 KST 날짜 'YYYY-MM-DD'.
// Date 객체를 KST 로 shift 한 후 ISO 의 date 부분만.
const kstDateStr = (nowMs = Date.now()) => {
  return new Date(nowMs + KST_OFFSET_MS).toISOString().slice(0, 10);
};

// 14 글자 한도 (omok 와 동일).
const sanitizeNick = (raw) => {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, 14);
};

const getUser = (clientId) => (clientId ? users.get(clientId) : null);

// 첫 점수 등록 또는 닉네임 변경 시 자동 생성.
const getOrCreateUser = (clientId, nickname) => {
  if (!clientId) return null;
  const today = kstDateStr();
  const existing = users.get(clientId);
  if (existing) {
    if (nickname && nickname !== existing.nickname) {
      existing.nickname = nickname;
      existing.updatedAt = Date.now();
      store.persistUser(clientId, existing);
    }
    // Daily lazy reset — dailyDate 가 오늘과 다르면 0 으로.
    if (existing.dailyDate !== today) {
      existing.dailyBest = 0;
      existing.dailyDate = today;
      existing.updatedAt = Date.now();
      store.persistUser(clientId, existing);
    }
    return existing;
  }
  const user = {
    clientId,
    nickname: nickname || '익명',
    allTimeBest: 0,
    dailyBest: 0,
    dailyDate: today,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  users.set(clientId, user);
  store.persistUser(clientId, user);
  return user;
};

// 닉네임만 변경 — 점수 등록 흐름과 분리.
const setNickname = (clientId, nickname) => {
  if (!clientId) return null;
  const nick = sanitizeNick(nickname);
  if (!nick) return null;
  return getOrCreateUser(clientId, nick);
};

// 점수 등록. 갱신된 best 만 valkey 영속화. 반환: { user, allTimeUpdated, dailyUpdated }.
// score 가 best 미만이면 user 만 반환 (영속화 X).
const submitScore = (clientId, nickname, score) => {
  if (!clientId || typeof score !== 'number' || score < 0) return null;
  const user = getOrCreateUser(clientId, nickname);
  if (!user) return null;
  let allTimeUpdated = false;
  let dailyUpdated = false;
  if (score > user.allTimeBest) {
    user.allTimeBest = score;
    allTimeUpdated = true;
  }
  if (score > user.dailyBest) {
    user.dailyBest = score;
    dailyUpdated = true;
  }
  if (allTimeUpdated || dailyUpdated) {
    user.updatedAt = Date.now();
    store.persistUser(clientId, user);
  }
  return { user, allTimeUpdated, dailyUpdated };
};

// 정렬 비교 — score desc, tie 면 createdAt asc (먼저 도달한 사람 우선).
const cmpAllTime = (a, b) => {
  if (b.allTimeBest !== a.allTimeBest) return b.allTimeBest - a.allTimeBest;
  return (a.createdAt || Infinity) - (b.createdAt || Infinity);
};
const cmpDaily = (a, b) => {
  if (b.dailyBest !== a.dailyBest) return b.dailyBest - a.dailyBest;
  return (a.createdAt || Infinity) - (b.createdAt || Infinity);
};

// daily 필터: 오늘 date 와 다른 user 는 0 으로 간주 (메모리 한 번에 reset 안 하려고).
// 표시 시점에서 lazy 평가.
const dailyScoreOf = (user, today) => (user.dailyDate === today ? user.dailyBest : 0);

const getTopAllTime = (limit = 10) => {
  const arr = Array.from(users.values()).filter((u) => u.allTimeBest > 0);
  arr.sort(cmpAllTime);
  return arr.slice(0, limit).map((u) => ({
    clientId: u.clientId,
    nickname: u.nickname,
    score: u.allTimeBest,
  }));
};

const getTopDaily = (limit = 10) => {
  const today = kstDateStr();
  const arr = Array.from(users.values())
    .map((u) => ({ ...u, dailyBest: dailyScoreOf(u, today) }))
    .filter((u) => u.dailyBest > 0);
  arr.sort(cmpDaily);
  return arr.slice(0, limit).map((u) => ({
    clientId: u.clientId,
    nickname: u.nickname,
    score: u.dailyBest,
  }));
};

// 특정 clientId 의 ranking entry (all-time / daily 각각의 순위).
const getMyRank = (clientId) => {
  if (!clientId) return null;
  const u = users.get(clientId);
  if (!u) return null;
  const today = kstDateStr();
  // All-time
  const allArr = Array.from(users.values()).filter((x) => x.allTimeBest > 0);
  allArr.sort(cmpAllTime);
  const allIdx = allArr.findIndex((x) => x.clientId === clientId);
  // Daily
  const dailyArr = Array.from(users.values())
    .map((x) => ({ ...x, dailyBest: dailyScoreOf(x, today) }))
    .filter((x) => x.dailyBest > 0);
  dailyArr.sort(cmpDaily);
  const dailyIdx = dailyArr.findIndex((x) => x.clientId === clientId);
  return {
    nickname: u.nickname,
    allTime: {
      score: u.allTimeBest,
      rank: allIdx >= 0 ? allIdx + 1 : null,
      total: allArr.length,
    },
    daily: {
      score: dailyScoreOf(u, today),
      rank: dailyIdx >= 0 ? dailyIdx + 1 : null,
      total: dailyArr.length,
    },
  };
};

// 운영 통계 — /api/stats 용. 봇 user 없음.
// monitor 가 5분마다 호출 (sleep 방지 + 시계열 수집). active_ws 는 server.js 의
// statsHandler 가 wss 에서 합쳐서 응답.
const getUserStats = () => {
  let topAllTime = 0;
  let topDaily = 0;
  const today = kstDateStr();
  for (const u of users.values()) {
    if (u.allTimeBest > topAllTime) topAllTime = u.allTimeBest;
    const d = (u.dailyDate === today) ? u.dailyBest : 0;
    if (d > topDaily) topDaily = d;
  }
  return {
    total_users: users.size,
    top_all_time: topAllTime,
    top_daily: topDaily,
  };
};

module.exports = {
  getUser, getOrCreateUser, setNickname, submitScore,
  getTopAllTime, getTopDaily, getMyRank, getUserStats,
  kstDateStr,  // test 용
};
