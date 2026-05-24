// ============================================================
// Valkey-backed store — Aiven Valkey (Redis 호환).
// ============================================================
// omok 의 store/valkey.js 와 동일 패턴:
//   - 메모리 cache (Map) 가 single source for reads
//   - 모든 write 는 메모리 → 즉시 fire-and-forget valkey SET (사용자 latency 영향 X)
//   - 부팅 시 hydrate — valkey 의 모든 user 를 메모리로 load
//
// 키 스키마 (VALKEY_KEY_PREFIX 분리 — omok 의 `omok:prod` 와 격리):
//   {PREFIX}:user:{clientId}             — user JSON
//   {PREFIX}:users                       — SET of clientIds (index)
//   {PREFIX}:daily:{date}                — Hash (counter)
//   {PREFIX}:daily-set:{date}:{name}     — SET (unique 멤버)
//   {PREFIX}:online                      — ZSET (1분 online sample, score=epoch_ms)
'use strict';

const Redis = require('ioredis');
const log = require('../infra/log');

const PREFIX = process.env.VALKEY_KEY_PREFIX || '2048:dev';
const URL = process.env.VALKEY_URL;
const DAILY_TTL_SEC = 90 * 86400;
const ONLINE_TTL_SEC = 90 * 86400;

const userKey = (cid) => `${PREFIX}:user:${cid}`;
const usersIndexKey = `${PREFIX}:users`;
const dailyKey = (date) => `${PREFIX}:daily:${date}`;
const dailyMatch = `${PREFIX}:daily:*`;
const dailySetKey = (date, name) => `${PREFIX}:daily-set:${date}:${name}`;
const dailySetMatch = `${PREFIX}:daily-set:*`;
const onlineKey = `${PREFIX}:online`;

const users = new Map();
const dailyStats = new Map();        // date → { field: number }
const dailySets = new Map();         // date → Map<setName, Set<string>>
const onlineSamples = [];            // [{ts, count}] sorted by ts asc
let redis = null;

const fnf = (label, p) => {
  if (!p || !p.catch) return;
  p.catch((e) => log.event('valkey_fail', { cmd: label, err: String(e && e.message || e).slice(0, 200) }));
};

const connect = async () => {
  if (!URL) {
    log.event('valkey_no_url', { msg: 'VALKEY_URL 미설정 — valkey backend 부팅 불가' });
    throw new Error('VALKEY_URL required');
  }
  redis = new Redis(URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
    enableReadyCheck: true,
  });
  redis.on('error', (e) => log.event('valkey_error', { err: String(e && e.message || e).slice(0, 200) }));
  await new Promise((resolve, reject) => {
    if (redis.status === 'ready') return resolve();
    redis.once('ready', resolve);
    redis.once('error', reject);
  });
  log.event('valkey_connected', { prefix: PREFIX });
};

const hydrate = async () => {
  if (!redis) return;
  // Users
  let cursor = '0';
  let total = 0;
  do {
    const [next, ids] = await redis.sscan(usersIndexKey, cursor, 'COUNT', 200);
    cursor = next;
    if (ids.length) {
      const vals = await redis.mget(ids.map((cid) => userKey(cid)));
      for (let i = 0; i < ids.length; i++) {
        const raw = vals[i];
        if (!raw) continue;
        try {
          const user = JSON.parse(raw);
          users.set(ids[i], user);
          total++;
        } catch { /* corrupt — skip */ }
      }
    }
  } while (cursor !== '0');
  // Daily counter Hash
  let dailyHydrated = 0;
  const dailyPrefix = `${PREFIX}:daily:`;
  let dcCursor = '0';
  do {
    const [next, keys] = await redis.scan(dcCursor, 'MATCH', dailyMatch, 'COUNT', 200);
    dcCursor = next;
    for (const k of keys) {
      const date = k.slice(dailyPrefix.length);
      try {
        const h = await redis.hgetall(k);
        if (h && Object.keys(h).length) {
          const obj = {};
          for (const [f, v] of Object.entries(h)) obj[f] = Number(v) || 0;
          dailyStats.set(date, obj);
          dailyHydrated++;
        }
      } catch (e) {
        log.event('valkey_daily_hydrate_fail', { date, err: String(e && e.message).slice(0, 200) });
      }
    }
  } while (dcCursor !== '0');
  // Daily SET
  let dailySetHydrated = 0;
  const dailySetPrefix = `${PREFIX}:daily-set:`;
  let dsCursor = '0';
  do {
    const [next, keys] = await redis.scan(dsCursor, 'MATCH', dailySetMatch, 'COUNT', 200);
    dsCursor = next;
    for (const k of keys) {
      const tail = k.slice(dailySetPrefix.length);
      const idx = tail.indexOf(':');
      if (idx < 0) continue;
      const date = tail.slice(0, idx);
      const name = tail.slice(idx + 1);
      try {
        const members = await redis.smembers(k);
        if (!dailySets.has(date)) dailySets.set(date, new Map());
        dailySets.get(date).set(name, new Set(members));
        dailySetHydrated++;
      } catch (e) {
        log.event('valkey_daily_set_hydrate_fail', { date, name, err: String(e && e.message).slice(0, 200) });
      }
    }
  } while (dsCursor !== '0');
  // Online ZSET
  try {
    const cutoff = Date.now() - ONLINE_TTL_SEC * 1000;
    await redis.zremrangebyscore(onlineKey, '-inf', cutoff);
    const raw = await redis.zrange(onlineKey, 0, -1, 'WITHSCORES');
    onlineSamples.length = 0;
    for (let i = 0; i < raw.length; i += 2) {
      const member = raw[i];
      const score = Number(raw[i + 1]);
      const colon = member.lastIndexOf(':');
      const count = colon > 0 ? Number(member.slice(colon + 1)) : 0;
      if (Number.isFinite(score) && Number.isFinite(count)) onlineSamples.push({ ts: score, count });
    }
  } catch (e) {
    log.event('valkey_online_hydrate_fail', { err: String(e && e.message).slice(0, 200) });
  }
  log.event('valkey_hydrated', {
    users: total, daily: dailyHydrated, dailySet: dailySetHydrated, online: onlineSamples.length,
  });
};

const disconnect = async () => {
  if (redis) {
    try { await redis.quit(); } catch { /* ignore */ }
    redis = null;
  }
};

const persistUser = (clientId, user) => {
  if (!clientId || !user || !redis) return;
  fnf('persistUser', redis.multi()
    .set(userKey(clientId), JSON.stringify(user))
    .sadd(usersIndexKey, clientId)
    .exec());
};

const removeUser = (clientId) => {
  if (!clientId || !redis) return;
  users.delete(clientId);
  fnf('removeUser', redis.multi()
    .del(userKey(clientId))
    .srem(usersIndexKey, clientId)
    .exec());
};

// ---- daily counter ----
const incrementDailyCounter = (date, field, n = 1) => {
  if (!date || !field || !n) return;
  const obj = dailyStats.get(date) || {};
  obj[field] = (obj[field] || 0) + n;
  dailyStats.set(date, obj);
  if (!redis) return;
  fnf('hincrby', redis.hincrby(dailyKey(date), field, n));
  fnf('expire', redis.expire(dailyKey(date), DAILY_TTL_SEC));
};
const getDailyStats = (date) => {
  if (!date) return null;
  return dailyStats.get(date) || null;
};
// valkey HGETALL 직접 조회 → cache 도 갱신. backfill / 외부 HSET 까지 반영.
const getDailyStatsFresh = async (date) => {
  if (!date) return null;
  if (!redis) return getDailyStats(date);
  try {
    const h = await redis.hgetall(dailyKey(date));
    if (!h || !Object.keys(h).length) return null;
    const obj = {};
    for (const [f, v] of Object.entries(h)) obj[f] = Number(v) || 0;
    dailyStats.set(date, obj);
    return obj;
  } catch (e) {
    log.event('valkey_daily_fresh_fail', { date, err: String(e && e.message).slice(0, 200) });
    return getDailyStats(date);
  }
};

// ---- daily SET ----
const addDailySetMember = (date, name, member) => {
  if (!date || !name || !member) return;
  let perDate = dailySets.get(date);
  if (!perDate) { perDate = new Map(); dailySets.set(date, perDate); }
  let s = perDate.get(name);
  if (!s) { s = new Set(); perDate.set(name, s); }
  s.add(String(member));
  if (!redis) return;
  fnf('sadd', redis.sadd(dailySetKey(date, name), String(member)));
  fnf('expire', redis.expire(dailySetKey(date, name), DAILY_TTL_SEC));
};
const getDailySetSize = (date, name) => {
  const perDate = dailySets.get(date);
  if (!perDate) return 0;
  const s = perDate.get(name);
  return s ? s.size : 0;
};
const getDailySetSizeFresh = async (date, name) => {
  if (!date || !name) return 0;
  if (!redis) return getDailySetSize(date, name);
  try {
    return Number(await redis.scard(dailySetKey(date, name))) || 0;
  } catch (e) {
    log.event('valkey_set_card_fresh_fail', { date, name, err: String(e && e.message).slice(0, 200) });
    return getDailySetSize(date, name);
  }
};
const getDailySetMembers = (date, name) => {
  const perDate = dailySets.get(date);
  if (!perDate) return [];
  const s = perDate.get(name);
  return s ? Array.from(s) : [];
};

// ---- online time-series ----
const sampleOnline = (ts, count) => {
  const now = Number(ts) || Date.now();
  const c = Number(count) || 0;
  onlineSamples.push({ ts: now, count: c });
  const cutoff = now - ONLINE_TTL_SEC * 1000;
  while (onlineSamples.length && onlineSamples[0].ts < cutoff) onlineSamples.shift();
  if (!redis) return;
  fnf('zadd', redis.zadd(onlineKey, now, `${now}:${c}`));
  fnf('zremrangebyscore', redis.zremrangebyscore(onlineKey, '-inf', cutoff));
};
const getOnlineSeries = (fromTs, toTs) => {
  const from = Number(fromTs) || 0;
  const to = Number(toTs) || Date.now();
  return onlineSamples.filter((s) => s.ts >= from && s.ts <= to);
};

module.exports = {
  backend: 'valkey',
  users, dailyStats, dailySets, onlineSamples,
  connect, hydrate, disconnect,
  persistUser, removeUser,
  incrementDailyCounter, getDailyStats, getDailyStatsFresh,
  addDailySetMember, getDailySetSize, getDailySetSizeFresh, getDailySetMembers,
  sampleOnline, getOnlineSeries,
};
