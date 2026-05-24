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
const log = require('../infra/log');

const PREFIX = process.env.VALKEY_KEY_PREFIX || 'omok';
const RECENT_GAMES_CAP = Number(process.env.RECENT_GAMES_CAP) || 100;
// daily 데이터 (counter / SET / LIST) TTL — 90일 보존. monitor 의 7d trend 대비 충분.
// 더 길게 잡으면 valkey 메모리 부담 (실제 24h 분량: counter Hash 수십B, active_users SET
// ~수십KB, game/bot_move LIST ~ MB 단위).
const DAILY_TTL_SEC = 90 * 86400;
// online time-series ZSET — 1분마다 sample. 90d × 1440/day = 130K entries × 30B = ~4MB.
// cleanup 은 매 sampleOnline 시 ZREMRANGEBYSCORE 로 만료 score 자동 정리.
const ONLINE_TTL_SEC = 90 * 86400;
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
  // 일별 카운터 — Hash (HINCRBY 로 atomic 증가).
  // fields: pvp_games / bot_games / total_bot_moves / worker_timeout / no_move /
  //         bot_retry / bot_skip / heartbeat_terminate / ws_connected / ws_disconnected
  // key 는 KST YYYY-MM-DD 기준 (server 가 KST date 로 호출).
  daily: (date) => `${PREFIX}:daily:${date}`,
  dailyMatch: `${PREFIX}:daily:*`,
  // 일별 SET — unique 멤버 집계 (active_users / bot_retry_rooms / bot_retry_clients /
  // bot_skip_rooms / bot_skip_clients). key prefix 가 'daily-set' 으로 별도라
  // `${PREFIX}:daily:*` SCAN 과 충돌 X.
  dailySet: (date, name) => `${PREFIX}:daily-set:${date}:${name}`,
  dailySetMatch: `${PREFIX}:daily-set:*`,
  // 일별 LIST — raw event JSON 누적 (games / bot_moves). LPUSH (최신 머리). monitor
  // 가 LRANGE 0 -1 로 그 날 전체 읽음. game_over log / move applied log 대체.
  dailyList: (date, name) => `${PREFIX}:daily-list:${date}:${name}`,
  dailyListMatch: `${PREFIX}:daily-list:*`,
  // online time-series — 단일 ZSET. score=epoch_ms, member=`${ts}:${count}` (unique).
  // 1분 sampler 가 ZADD + 주기 ZREMRANGEBYSCORE (만료 score 제거).
  online: `${PREFIX}:online`,
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
  client.on('error', (e) => log.error('valkey_error', { err: e && e.message }));
  client.on('connect', () => log.event('valkey_connecting'));
  client.on('ready', () => log.event('valkey_ready'));
  client.on('reconnecting', (delay) => log.event('valkey_reconnecting', { delay_ms: delay }));
  client.on('close', () => log.event('valkey_connection_closed'));

  // 메모리 cache. backend === 'valkey' 에서도 read 는 메모리 우선.
  const rooms = new Map();
  const sessions = new Map();
  const queue = [];
  const botOffer = new Map();
  const users = new Map();         // clientId → user JSON
  const recentGames = [];          // 최신 먼저 (unshift). hydrate 시 valkey 의 LRANGE 0 N-1 을 그대로.
  // 일별 카운터 — date(YYYY-MM-DD) → { fieldName: number, ... }.
  // 서버 in-process atomic 보장 (Node.js single-thread). valkey 도 HINCRBY 로 atomic.
  const dailyStats = new Map();
  // 일별 SET — date → Map<setName, Set<string>>. SCARD 결과 빠르게 응답.
  // active_users / bot_retry_rooms 등 unique count 캐싱.
  const dailySets = new Map();
  // LIST 는 메모리 캐시 X — 1일치 수천-수만 entry 라 메모리 부담. 읽기는 endpoint
  // 호출 시 valkey LRANGE 로 직접. write 는 fire-and-forget LPUSH.
  // online time-series — 메모리 sorted array (ts ascending). 90d × 1440/day × 30B ≈ 4MB.
  // 읽기 빈도 높고 endpoint 응답에서도 직접 쓰여 캐싱 유지.
  const onlineSamples = [];

  const fnf = (p) => Promise.resolve(p).catch((e) => log.error('valkey_cmd_fail', { err: e && e.message }));

  const api = {
    backend: 'valkey',
    rooms, sessions, queue, botOffer, users, recentGames,
    dailyStats, dailySets, onlineSamples,
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
            log.error('valkey_room_hydrate_fail', { code, err: e && e.message });
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
            log.error('valkey_session_hydrate_fail', { sid, err: e && e.message });
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
          log.error('valkey_queue_hydrate_fail', { err: e && e.message });
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
            log.error('valkey_user_hydrate_fail', { cid, err: e && e.message });
          }
        }
      }
      // Recent games (LIST, 최신 먼저)
      const gamesJson = await client.lrange(K.recentGames, 0, RECENT_GAMES_CAP - 1);
      recentGames.length = 0;
      for (const j of gamesJson) {
        try { recentGames.push(JSON.parse(j)); } catch {}
      }
      // Daily stats — SCAN 으로 살아 있는 키 (TTL 만료 안 된 것) 모두 메모리 캐싱.
      let dailyHydrated = 0;
      const dailyPrefix = `${PREFIX}:daily:`;
      let dCursor = '0';
      do {
        const [next, keys] = await client.scan(dCursor, 'MATCH', K.dailyMatch, 'COUNT', 200);
        dCursor = next;
        for (const k of keys) {
          const date = k.slice(dailyPrefix.length);
          try {
            const h = await client.hgetall(k);
            if (h && Object.keys(h).length) {
              const obj = {};
              for (const [f, v] of Object.entries(h)) obj[f] = Number(v) || 0;
              dailyStats.set(date, obj);
              dailyHydrated++;
            }
          } catch (e) {
            log.error('valkey_daily_hydrate_fail', { date, err: e && e.message });
          }
        }
      } while (dCursor !== '0');
      // Daily SET — `{PREFIX}:daily-set:{date}:{name}` → in-memory Map<date, Map<name, Set>>.
      // SCARD 값을 매 endpoint 호출 시 valkey 가 아닌 메모리에서 응답.
      let dailySetHydrated = 0;
      const dailySetPrefix = `${PREFIX}:daily-set:`;
      let dsCursor = '0';
      do {
        const [next, keys] = await client.scan(dsCursor, 'MATCH', K.dailySetMatch, 'COUNT', 200);
        dsCursor = next;
        for (const k of keys) {
          // key 형식: PREFIX:daily-set:YYYY-MM-DD:setName
          const tail = k.slice(dailySetPrefix.length);
          const idx = tail.indexOf(':');
          if (idx < 0) continue;
          const date = tail.slice(0, idx);
          const name = tail.slice(idx + 1);
          try {
            const members = await client.smembers(k);
            if (!dailySets.has(date)) dailySets.set(date, new Map());
            dailySets.get(date).set(name, new Set(members));
            dailySetHydrated++;
          } catch (e) {
            log.error('valkey_daily_set_hydrate_fail', { date, name, err: e && e.message });
          }
        }
      } while (dsCursor !== '0');
      // Online time-series ZSET — 메모리 sorted array 로 캐싱. ZRANGEBYSCORE 로 전체 읽고
      // member 형식 `{ts}:{count}` 파싱. sample 호출 시점에 cutoff (90d 이전) 제거.
      try {
        const cutoff = Date.now() - ONLINE_TTL_SEC * 1000;
        await client.zremrangebyscore(K.online, '-inf', cutoff);
        const raw = await client.zrange(K.online, 0, -1, 'WITHSCORES');
        onlineSamples.length = 0;
        for (let i = 0; i < raw.length; i += 2) {
          const member = raw[i];
          const score = Number(raw[i + 1]);
          // member = `${ts}:${count}` 또는 fallback (member 가 score 만)
          const colon = member.lastIndexOf(':');
          const count = colon > 0 ? Number(member.slice(colon + 1)) : 0;
          if (Number.isFinite(score) && Number.isFinite(count)) {
            onlineSamples.push({ ts: score, count });
          }
        }
      } catch (e) {
        log.error('valkey_online_hydrate_fail', { err: e && e.message });
      }
      log.event('valkey_hydrated', {
        prefix: PREFIX, rooms: roomHydrated, sessions: sessionHydrated,
        queue: queue.length, botOffer: botOfferHydrated,
        users: userHydrated, recentGames: recentGames.length,
        daily: dailyHydrated, dailySet: dailySetHydrated, online: onlineSamples.length,
      });
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
    // 일별 카운터 — HINCRBY (valkey atomic) + 메모리 캐시 동시 증가.
    // field 별 따로 증가 → caller 가 game_over / move applied 시점에 호출.
    incrementDailyCounter(date, field, n = 1) {
      if (!date || !field || !n) return;
      const obj = dailyStats.get(date) || {};
      obj[field] = (obj[field] || 0) + n;
      dailyStats.set(date, obj);
      fnf(client.hincrby(K.daily(date), field, n));
      // TTL 갱신 — HINCRBY 자체는 TTL 안 건드림. 매 호출마다 EXPIRE 다시 걸어 90일 슬라이딩.
      fnf(client.expire(K.daily(date), DAILY_TTL_SEC));
    },
    // snapshot 형 (counter 가 아닌 fixed 값) field 갱신 — total_human_users / tier_* 등.
    // HSET (replace) — caller 가 매번 최신값 전달. 7일 trend 의 "계정/티어 분포" 컬럼이
    // 과거 KST day 의 end-of-day snapshot 으로 표시되도록 monitor 5분 cron 이 자연 갱신.
    snapshotDailyMeta(date, fields) {
      if (!date || !fields || !Object.keys(fields).length) return;
      const obj = dailyStats.get(date) || {};
      for (const [k, v] of Object.entries(fields)) obj[k] = Number(v) || 0;
      dailyStats.set(date, obj);
      const stringified = {};
      for (const [k, v] of Object.entries(fields)) stringified[k] = String(Number(v) || 0);
      fnf(client.hset(K.daily(date), stringified));
      fnf(client.expire(K.daily(date), DAILY_TTL_SEC));
    },
    // 특정 date 의 카운터 dict 반환. 없으면 null.
    // 메모리 캐시 우선이지만 backfill / 외부 write 가 valkey 직접 build 한 경우
    // 캐시는 stale. authoritative 응답이 필요한 endpoint 는 getDailyStatsFresh 사용.
    getDailyStats(date) {
      if (!date) return null;
      return dailyStats.get(date) || null;
    },
    // valkey HGETALL 직접 조회 → in-memory cache 도 갱신 후 반환. endpoint 가
    // backfill / disaster-recovery 로 직접 valkey HSET 된 값까지 항상 응답.
    async getDailyStatsFresh(date) {
      if (!date) return null;
      try {
        const h = await client.hgetall(K.daily(date));
        if (!h || !Object.keys(h).length) return null;
        const obj = {};
        for (const [f, v] of Object.entries(h)) obj[f] = Number(v) || 0;
        dailyStats.set(date, obj);   // cache 자체도 refresh
        return obj;
      } catch (e) {
        log.error('valkey_daily_fresh_read_fail', { date, err: e && e.message });
        return dailyStats.get(date) || null;   // 실패 시 cache fallback
      }
    },

    // ---- 일별 SET (unique 멤버) ----
    // active_users (게임 종료 시 양 사람 nick), bot_retry_rooms / bot_retry_clients /
    // bot_skip_rooms / bot_skip_clients 등. SADD 는 멤버 중복 자동 dedup.
    addDailySetMember(date, name, member) {
      if (!date || !name || !member) return;
      let perDate = dailySets.get(date);
      if (!perDate) { perDate = new Map(); dailySets.set(date, perDate); }
      let s = perDate.get(name);
      if (!s) { s = new Set(); perDate.set(name, s); }
      s.add(String(member));
      fnf(client.sadd(K.dailySet(date, name), String(member)));
      fnf(client.expire(K.dailySet(date, name), DAILY_TTL_SEC));
    },
    // SET 크기 (SCARD) — endpoint 가 자주 부르므로 메모리에서 즉답.
    getDailySetSize(date, name) {
      if (!date || !name) return 0;
      const perDate = dailySets.get(date);
      if (!perDate) return 0;
      const s = perDate.get(name);
      return s ? s.size : 0;
    },
    // SET 크기 fresh — backfill / 외부 SADD 까지 반영. endpoint authoritative 응답 용.
    async getDailySetSizeFresh(date, name) {
      if (!date || !name) return 0;
      try {
        const n = await client.scard(K.dailySet(date, name));
        // memory cache 도 lazy refresh (멤버 까지 다 가져오면 부담 — count 만 기록).
        // 실제 멤버 조회는 getDailySetMembers 가 별도로 SMEMBERS.
        return Number(n) || 0;
      } catch (e) {
        log.error('valkey_set_card_fresh_fail', { date, name, err: e && e.message });
        return this.getDailySetSize(date, name);
      }
    },
    // 멤버 전체 (active_users 의 unique nick 목록 등). 큰 SET 도 그대로 array 반환.
    getDailySetMembers(date, name) {
      if (!date || !name) return [];
      const perDate = dailySets.get(date);
      if (!perDate) return [];
      const s = perDate.get(name);
      return s ? Array.from(s) : [];
    },

    // ---- 일별 LIST (raw event JSON 누적) ----
    // games (game_over JSON), bot_moves (move applied JSON). LPUSH 로 최신 머리.
    // 메모리 캐시 X — 대용량이라 endpoint 호출 시 valkey 직접 LRANGE.
    pushDailyListItem(date, name, item) {
      if (!date || !name || !item) return;
      let json;
      try { json = JSON.stringify(item); } catch { return; }
      fnf(client.lpush(K.dailyList(date, name), json));
      fnf(client.expire(K.dailyList(date, name), DAILY_TTL_SEC));
    },
    async getDailyListRange(date, name, start = 0, stop = -1) {
      if (!date || !name) return [];
      try {
        const raw = await client.lrange(K.dailyList(date, name), start, stop);
        const out = [];
        for (const j of raw) {
          try { out.push(JSON.parse(j)); } catch {}
        }
        return out;
      } catch (e) {
        log.error('valkey_daily_list_read_fail', { date, name, err: e && e.message });
        return [];
      }
    },
    async getDailyListLength(date, name) {
      if (!date || !name) return 0;
      try { return await client.llen(K.dailyList(date, name)); }
      catch { return 0; }
    },

    // ---- online time-series (ZSET, 1분 sample) ----
    // member 형식 `${ts}:${count}` (unique 보장 — 같은 ms 같은 count 충돌 위험 거의 0).
    // ZREMRANGEBYSCORE 로 cutoff 이전 자동 정리.
    sampleOnline(ts, count) {
      const now = Number(ts) || Date.now();
      const c = Number(count) || 0;
      onlineSamples.push({ ts: now, count: c });
      // 메모리도 cutoff 정리 — 90d 이전 제거.
      const cutoff = now - ONLINE_TTL_SEC * 1000;
      while (onlineSamples.length && onlineSamples[0].ts < cutoff) onlineSamples.shift();
      const member = `${now}:${c}`;
      fnf(client.zadd(K.online, now, member));
      fnf(client.zremrangebyscore(K.online, '-inf', cutoff));
    },
    // 시간 범위 (fromTs ~ toTs, epoch ms) 의 sample 배열 반환. 메모리에서 즉답.
    getOnlineSeries(fromTs, toTs) {
      const from = Number(fromTs) || 0;
      const to = Number(toTs) || Date.now();
      return onlineSamples.filter((s) => s.ts >= from && s.ts <= to);
    },
  };
  return api;
};

module.exports = { createValkeyStore };
