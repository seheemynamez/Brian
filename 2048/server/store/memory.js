// ============================================================
// In-memory store — 단일 프로세스 메모리. 영속화 X.
// ============================================================
// 테스트 / 로컬 개발용. production 거부 (store/index.js 의 가드).
'use strict';

const ONLINE_TTL_MS = 90 * 86400 * 1000;

const users = new Map();
const dailyStats = new Map();   // date → { fieldName: number }
const dailySets = new Map();    // date → Map<setName, Set<string>>
const onlineSamples = [];       // [{ts, count}] ts ascending

module.exports = {
  backend: 'memory',
  users, dailyStats, dailySets, onlineSamples,
  // valkey backend 호환 — no-op.
  async connect() { /* no-op */ },
  async hydrate() { /* no-op */ },
  async disconnect() { /* no-op */ },
  persistUser(_clientId, _user) { /* no-op */ },
  removeUser(_clientId) { /* no-op */ },
  // ---- daily counter ----
  incrementDailyCounter(date, field, n = 1) {
    if (!date || !field || !n) return;
    const obj = dailyStats.get(date) || {};
    obj[field] = (obj[field] || 0) + n;
    dailyStats.set(date, obj);
  },
  snapshotDailyMeta(date, fields) {
    if (!date || !fields || !Object.keys(fields).length) return;
    const obj = dailyStats.get(date) || {};
    for (const [k, v] of Object.entries(fields)) obj[k] = Number(v) || 0;
    dailyStats.set(date, obj);
  },
  getDailyStats(date) {
    if (!date) return null;
    return dailyStats.get(date) || null;
  },
  // ---- daily SET ----
  addDailySetMember(date, name, member) {
    if (!date || !name || !member) return;
    let perDate = dailySets.get(date);
    if (!perDate) { perDate = new Map(); dailySets.set(date, perDate); }
    let s = perDate.get(name);
    if (!s) { s = new Set(); perDate.set(name, s); }
    s.add(String(member));
  },
  getDailySetSize(date, name) {
    const perDate = dailySets.get(date);
    if (!perDate) return 0;
    const s = perDate.get(name);
    return s ? s.size : 0;
  },
  getDailySetMembers(date, name) {
    const perDate = dailySets.get(date);
    if (!perDate) return [];
    const s = perDate.get(name);
    return s ? Array.from(s) : [];
  },
  // ---- online time-series ----
  sampleOnline(ts, count) {
    const now = Number(ts) || Date.now();
    const c = Number(count) || 0;
    onlineSamples.push({ ts: now, count: c });
    const cutoff = now - ONLINE_TTL_MS;
    while (onlineSamples.length && onlineSamples[0].ts < cutoff) onlineSamples.shift();
  },
  getOnlineSeries(fromTs, toTs) {
    const from = Number(fromTs) || 0;
    const to = Number(toTs) || Date.now();
    return onlineSamples.filter((s) => s.ts >= from && s.ts <= to);
  },
};
