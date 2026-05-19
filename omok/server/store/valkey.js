// ============================================================
// ValkeyStore — write-through persistence to Aiven (또는 다른 redis-compat).
// ============================================================
// 메모리 cache (Map / Array) 는 read 경로용. write 시점에 valkey 도 동시에 update.
// valkey 명령은 fire-and-forget (실패는 로깅, 다음 write 가 자연 복구).
//
// 호출자 (rooms.js / handlers.js) 는 backend === 'valkey' 일 때 store.persistRoom
// 같은 헬퍼를 호출해서 변경을 명시적으로 sync. memory backend 에선 모두 no-op.
//
// 키 스키마 (PREFIX namespace, 기본 'omok'):
//   {PREFIX}:room:{code}        — room JSON
//   {PREFIX}:rooms              — SET of room codes (인덱싱)
//   {PREFIX}:session:{sid}      — session JSON
//   {PREFIX}:sessions           — SET of session ids
//   {PREFIX}:queue              — queue array JSON (단일 키)
//   {PREFIX}:botOffer:{cid}     — 봇 제안 발송 시각 (string, EX 120s)
//   {PREFIX}:user:{clientId}    — user JSON (rating / wins / losses / draws / nickname)
//   {PREFIX}:users              — SET of clientIds (랭킹 인덱스)
//   {PREFIX}:recent_games       — LIST of game result JSON (LPUSH + LTRIM 으로 최근 N개 유지)
//
// PREFIX 는 VALKEY_KEY_PREFIX 환경변수로 override. dev/prod 가 같은 valkey
// 인스턴스를 공유할 때 키 충돌 방지 (예: 'omok:dev' vs 'omok:prod').

'use strict';

const Redis = require('ioredis');
const { serializeRoom, deserializeRoom } = require('./serialize');

const PREFIX = process.env.VALKEY_KEY_PREFIX || 'omok';
const RECENT_GAMES_CAP = Number(process.env.RECENT_GAMES_CAP) || 100;
const K = {
  room: (code) => `${PREFIX}:room:${code}`,
  rooms: `${PREFIX}:rooms`,
  session: (sid) => `${PREFIX}:session:${sid}`,
  sessions: `${PREFIX}:sessions`,
  queue: `${PREFIX}:queue`,
  botOffer: (cid) => `${PREFIX}:botOffer:${cid}`,
  botOfferMatch: `${PREFIX}:botOffer:*`,
  user: (cid) => `${PREFIX}:user:${cid}`,
  users: `${PREFIX}:users`,
  recentGames: `${PREFIX}:recent_games`,
};

const createValkeyStore = () => {
  const url = process.env.VALKEY_URL;
  if (!url) throw new Error('VALKEY_URL 환경변수가 설정되어 있지 않음');

  const client = new Redis(url, {
    lazyConnect: true,             // explicit connect()
    connectTimeout: 10000,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 5000),
    enableOfflineQueue: true,       // 연결 끊긴 동안의 명령은 큐에 쌓임
  });
  client.on('error', (e) => console.error('[valkey] error:', e && e.message));
  client.on('connect', () => console.log('[valkey] connecting...'));
  client.on('ready', () => console.log('[valkey] ready'));
  client.on('reconnecting', (delay) => console.log('[valkey] reconnecting in', delay, 'ms'));
  client.on('close', () => console.log('[valkey] connection closed'));

  // 메모리 cache. backend === 'valkey' 에서도 read 는 메모리 우선.
  const rooms = new Map();
  const sessions = new Map();
  const queue = [];
  const botOffer = new Map();
  const users = new Map();         // clientId → user JSON
  const recentGames = [];          // 최신 먼저 (unshift). hydrate 시 valkey 의 LRANGE 0 N-1 을 그대로.

  const fnf = (p) => Promise.resolve(p).catch((e) => console.error('[valkey] cmd fail:', e && e.message));

  const api = {
    backend: 'valkey',
    rooms, sessions, queue, botOffer, users, recentGames,
    client,

    async connect() {
      await client.connect();
    },

    // 부팅 시 valkey 에서 모든 도메인 state 읽어 메모리 cache 로 hydrate.
    // 진행 중 (status='playing') 인 방의 timer 는 server 의 boot 단계에서 별도로
    // (handlers 에서) 재등록. 여기선 데이터만 메모리에 채움.
    async hydrate() {
      // Rooms
      const codes = await client.smembers(K.rooms);
      let roomHydrated = 0;
      for (const code of codes) {
        const json = await client.get(K.room(code));
        if (json) {
          try {
            const room = deserializeRoom(json);
            rooms.set(code, room);
            roomHydrated++;
          } catch (e) {
            console.error('[valkey] room hydrate fail', code, e && e.message);
            await client.del(K.room(code)).catch(() => {});
            await client.srem(K.rooms, code).catch(() => {});
          }
        }
      }
      // Sessions
      const sids = await client.smembers(K.sessions);
      let sessionHydrated = 0;
      for (const sid of sids) {
        const json = await client.get(K.session(sid));
        if (json) {
          try {
            sessions.set(sid, JSON.parse(json));
            sessionHydrated++;
          } catch (e) {
            console.error('[valkey] session hydrate fail', sid, e && e.message);
          }
        }
      }
      // Queue
      const qJson = await client.get(K.queue);
      if (qJson) {
        try {
          const arr = JSON.parse(qJson);
          queue.length = 0;
          for (const e of arr) queue.push(e);
        } catch (e) {
          console.error('[valkey] queue hydrate fail', e && e.message);
        }
      }
      // Bot offer history (EX TTL 로 만료된 건 자동 제외됨, 남은 key 들 scan)
      let botOfferHydrated = 0;
      const botOfferPrefix = `${PREFIX}:botOffer:`;
      let cursor = '0';
      do {
        const [next, keys] = await client.scan(cursor, 'MATCH', K.botOfferMatch, 'COUNT', 200);
        cursor = next;
        for (const k of keys) {
          const ts = await client.get(k);
          if (ts) {
            const clientId = k.replace(botOfferPrefix, '');
            botOffer.set(clientId, Number(ts));
            botOfferHydrated++;
          }
        }
      } while (cursor !== '0');
      // Users (랭킹용 — 모든 user 메모리에 캐싱)
      const cids = await client.smembers(K.users);
      let userHydrated = 0;
      for (const cid of cids) {
        const json = await client.get(K.user(cid));
        if (json) {
          try {
            users.set(cid, JSON.parse(json));
            userHydrated++;
          } catch (e) {
            console.error('[valkey] user hydrate fail', cid, e && e.message);
          }
        }
      }
      // Recent games (LIST, 최신 먼저)
      const gamesJson = await client.lrange(K.recentGames, 0, RECENT_GAMES_CAP - 1);
      recentGames.length = 0;
      for (const j of gamesJson) {
        try { recentGames.push(JSON.parse(j)); } catch {}
      }
      console.log(`[valkey] hydrated (prefix=${PREFIX}): rooms=${roomHydrated} sessions=${sessionHydrated} queue=${queue.length} botOffer=${botOfferHydrated} users=${userHydrated} recentGames=${recentGames.length}`);
    },

    async close() {
      try { await client.quit(); } catch {}
    },

    // ---- write-through helpers (호출자가 변경 후 명시적 호출) ----
    persistRoom(code, room) {
      if (!code || !room) return;
      const json = JSON.stringify(serializeRoom(room));
      fnf(client.set(K.room(code), json));
      fnf(client.sadd(K.rooms, code));
    },
    deleteRoomFromStore(code) {
      if (!code) return;
      fnf(client.del(K.room(code)));
      fnf(client.srem(K.rooms, code));
    },
    persistSession(sid, sess) {
      if (!sid || !sess) return;
      fnf(client.set(K.session(sid), JSON.stringify(sess)));
      fnf(client.sadd(K.sessions, sid));
    },
    deleteSessionFromStore(sid) {
      if (!sid) return;
      fnf(client.del(K.session(sid)));
      fnf(client.srem(K.sessions, sid));
    },
    // queue 는 작은 array 이므로 변경 시 전체를 한 키에 SET.
    persistQueue() {
      fnf(client.set(K.queue, JSON.stringify(queue)));
    },
    // botOffer 는 cooldown (60s) 보다 약간 길게 EX 줘서 자동 만료.
    persistBotOffer(clientId, ts) {
      if (!clientId) return;
      fnf(client.set(K.botOffer(clientId), String(ts), 'EX', 120));
    },
    deleteBotOfferFromStore(clientId) {
      if (!clientId) return;
      fnf(client.del(K.botOffer(clientId)));
    },
    // user — rating / wins / losses / draws 갱신 시 호출. 메모리 cache 는 caller 가 set.
    persistUser(clientId, user) {
      if (!clientId || !user) return;
      fnf(client.set(K.user(clientId), JSON.stringify(user)));
      fnf(client.sadd(K.users, clientId));
    },
    // recent game — LIST 의 head 에 push + 마지막 cap 까지만 유지.
    // 메모리 cache 도 동일하게 unshift + cap.
    persistRecentGame(entry) {
      if (!entry) return;
      recentGames.unshift(entry);
      if (recentGames.length > RECENT_GAMES_CAP) recentGames.length = RECENT_GAMES_CAP;
      fnf(client.lpush(K.recentGames, JSON.stringify(entry)));
      fnf(client.ltrim(K.recentGames, 0, RECENT_GAMES_CAP - 1));
    },
  };
  return api;
};

module.exports = { createValkeyStore };
