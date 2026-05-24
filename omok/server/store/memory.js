// ============================================================
// InMemoryStore — 기존 동작 그대로. 단일 프로세스 메모리에만 데이터 유지.
// ============================================================
// 데이터 형태는 valkey backend 와 일치하도록 namespace 별 Map / Array.
// rooms / sessions / botOffer / users 는 Map (string key → value),
// queue 는 array of records,
// recentGames 는 array (LIFO, capped — 마지막 N개).

'use strict';

const RECENT_GAMES_CAP = Number(process.env.RECENT_GAMES_CAP) || 100;

const ONLINE_TTL_MS = 90 * 86400 * 1000;

const createInMemoryStore = () => ({
  backend: 'memory',
  rooms: new Map(),
  sessions: new Map(),
  queue: [],
  botOffer: new Map(),
  users: new Map(),        // clientId → user JSON
  recentGames: [],         // [{ ..., endedAt }]  최신 먼저 (unshift)
  dailyStats: new Map(),   // date → { fieldName: number, ... }
  dailySets: new Map(),    // date → Map<setName, Set<string>>
  dailyLists: new Map(),   // date → Map<listName, Array<object>>  (head=최신)
  onlineSamples: [],       // [{ts, count}]  ts ascending
  // lifecycle no-op (메모리만 사용)
  async connect() {},
  async hydrate() {},
  async close() {},
  // valkey backend 와 인터페이스 일치 위한 no-op write-through helpers.
  persistRoom() {},
  deleteRoomFromStore() {},
  persistSession() {},
  deleteSessionFromStore() {},
  persistQueue() {},
  persistBotOffer() {},
  deleteBotOfferFromStore() {},
  // user / recent_games — memory backend 에선 캐시 자체가 SoT.
  // 단, recentGames 는 cap 유지 (LTRIM 흉내).
  persistUser() {},
  persistRecentGame(entry) {
    this.recentGames.unshift(entry);
    if (this.recentGames.length > RECENT_GAMES_CAP) this.recentGames.length = RECENT_GAMES_CAP;
  },
  // 일별 카운터 — 프로세스 재시작 시 휘발 (memory backend 한계). prod 에서는 valkey 강제.
  incrementDailyCounter(date, field, n = 1) {
    if (!date || !field || !n) return;
    const obj = this.dailyStats.get(date) || {};
    obj[field] = (obj[field] || 0) + n;
    this.dailyStats.set(date, obj);
  },
  snapshotDailyMeta(date, fields) {
    if (!date || !fields || !Object.keys(fields).length) return;
    const obj = this.dailyStats.get(date) || {};
    for (const [k, v] of Object.entries(fields)) obj[k] = Number(v) || 0;
    this.dailyStats.set(date, obj);
  },
  getDailyStats(date) {
    if (!date) return null;
    return this.dailyStats.get(date) || null;
  },
  // memory backend 는 캐시가 SoT — fresh 와 동일.
  async getDailyStatsFresh(date) { return this.getDailyStats(date); },
  // ---- daily SET ----
  addDailySetMember(date, name, member) {
    if (!date || !name || !member) return;
    let perDate = this.dailySets.get(date);
    if (!perDate) { perDate = new Map(); this.dailySets.set(date, perDate); }
    let s = perDate.get(name);
    if (!s) { s = new Set(); perDate.set(name, s); }
    s.add(String(member));
  },
  getDailySetSize(date, name) {
    const perDate = this.dailySets.get(date);
    if (!perDate) return 0;
    const s = perDate.get(name);
    return s ? s.size : 0;
  },
  async getDailySetSizeFresh(date, name) { return this.getDailySetSize(date, name); },
  getDailySetMembers(date, name) {
    const perDate = this.dailySets.get(date);
    if (!perDate) return [];
    const s = perDate.get(name);
    return s ? Array.from(s) : [];
  },
  // ---- daily LIST ----
  pushDailyListItem(date, name, item) {
    if (!date || !name || !item) return;
    let perDate = this.dailyLists.get(date);
    if (!perDate) { perDate = new Map(); this.dailyLists.set(date, perDate); }
    let arr = perDate.get(name);
    if (!arr) { arr = []; perDate.set(name, arr); }
    arr.unshift(item);  // 최신 머리 (valkey LPUSH 와 동일)
  },
  async getDailyListRange(date, name, start = 0, stop = -1) {
    const perDate = this.dailyLists.get(date);
    if (!perDate) return [];
    const arr = perDate.get(name) || [];
    const end = stop === -1 ? arr.length : Math.min(stop + 1, arr.length);
    return arr.slice(start, end);
  },
  async getDailyListLength(date, name) {
    const perDate = this.dailyLists.get(date);
    if (!perDate) return 0;
    const arr = perDate.get(name);
    return arr ? arr.length : 0;
  },
  // ---- online time-series ----
  sampleOnline(ts, count) {
    const now = Number(ts) || Date.now();
    const c = Number(count) || 0;
    this.onlineSamples.push({ ts: now, count: c });
    const cutoff = now - ONLINE_TTL_MS;
    while (this.onlineSamples.length && this.onlineSamples[0].ts < cutoff) this.onlineSamples.shift();
  },
  getOnlineSeries(fromTs, toTs) {
    const from = Number(fromTs) || 0;
    const to = Number(toTs) || Date.now();
    return this.onlineSamples.filter((s) => s.ts >= from && s.ts <= to);
  },
  async getOnlineSeriesFresh(fromTs, toTs) { return this.getOnlineSeries(fromTs, toTs); },
});

module.exports = { createInMemoryStore };
