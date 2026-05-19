// ============================================================
// ValkeyStore — write-through persistence to Aiven (또는 다른 redis-compat).
// ============================================================
// 메모리 cache (Map / Array) 는 read 경로용. write 시점에 valkey 도 동시에 update.
// valkey 명령은 fire-and-forget (실패는 로깅, 다음 write 가 자연 복구).
//
// 호출자 (rooms.js / handlers.js) 는 backend === 'valkey' 일 때 store.persistRoom
// 같은 헬퍼를 호출해서 변경을 명시적으로 sync. memory backend 에선 모두 no-op.
//
// 키 스키마 (omok namespace prefix):
//   omok:room:{code}        — room JSON
//   omok:rooms              — SET of room codes (인덱싱)
//   omok:session:{sid}      — session JSON
//   omok:sessions           — SET of session ids
//   omok:queue              — queue array JSON (단일 키)
//   omok:botOffer:{cid}     — 봇 제안 발송 시각 (string, EX 120s)

'use strict';

const Redis = require('ioredis');
const { serializeRoom, deserializeRoom } = require('./serialize');

const K = {
  room: (code) => `omok:room:${code}`,
  rooms: 'omok:rooms',
  session: (sid) => `omok:session:${sid}`,
  sessions: 'omok:sessions',
  queue: 'omok:queue',
  botOffer: (cid) => `omok:botOffer:${cid}`,
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

  const fnf = (p) => Promise.resolve(p).catch((e) => console.error('[valkey] cmd fail:', e && e.message));

  const api = {
    backend: 'valkey',
    rooms, sessions, queue, botOffer,
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
      let cursor = '0';
      do {
        const [next, keys] = await client.scan(cursor, 'MATCH', 'omok:botOffer:*', 'COUNT', 200);
        cursor = next;
        for (const k of keys) {
          const ts = await client.get(k);
          if (ts) {
            const clientId = k.replace('omok:botOffer:', '');
            botOffer.set(clientId, Number(ts));
            botOfferHydrated++;
          }
        }
      } while (cursor !== '0');
      console.log(`[valkey] hydrated: rooms=${roomHydrated} sessions=${sessionHydrated} queue=${queue.length} botOffer=${botOfferHydrated}`);
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
  };
  return api;
};

module.exports = { createValkeyStore };
