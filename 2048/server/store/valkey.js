// ============================================================
// Valkey-backed store — Aiven Valkey (Redis 호환).
// ============================================================
// omok 의 store/valkey.js 와 동일 패턴:
//   - 메모리 cache (Map) 가 single source for reads
//   - 모든 write 는 메모리 → 즉시 fire-and-forget valkey SET (사용자 latency 영향 X)
//   - 부팅 시 hydrate — valkey 의 모든 user 를 메모리로 load
//
// 키 스키마 (VALKEY_KEY_PREFIX 분리 — omok 의 `omok:prod` 와 격리):
//   {PREFIX}:user:{clientId} — user JSON
//   {PREFIX}:users           — SET of clientIds (index)
'use strict';

const Redis = require('ioredis');
const log = require('../infra/log');

const PREFIX = process.env.VALKEY_KEY_PREFIX || '2048:dev';
const URL = process.env.VALKEY_URL;

const userKey = (cid) => `${PREFIX}:user:${cid}`;
const usersIndexKey = `${PREFIX}:users`;

const users = new Map();
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
  log.event('valkey_hydrated', { users: total });
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

module.exports = {
  backend: 'valkey',
  users,
  connect, hydrate, disconnect,
  persistUser, removeUser,
};
