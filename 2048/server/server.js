// ============================================================
// 2048 ranking server — HTTP + WebSocket.
// ============================================================
// HTTP:
//   GET /api/stats       — 운영 통계 (monitor 가 호출)
//   GET /i/2048/{nick}/{score} — share 초대 페이지 (OG 메타 + redirect)
//   GET / 그 외          — 404 (정적 파일은 GitHub Pages 가 서빙)
// WebSocket:
//   /ws — 메시지 router (handlers/index.js 참고)
'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');
const { getStore } = require('./store');
const { getUserStats } = require('./domain/users');
const { makeShareHandler } = require('./infra/share');
const handlers = require('./handlers');
const log = require('./infra/log');
const { incrementToday, sampleOnlineNow } = require('./infra/daily-counter');

const PORT = Number(process.env.PORT) || 8081;
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS) || 15000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const CANONICAL_2048_URL = process.env.CANONICAL_2048_URL || null;

const shareHandler = makeShareHandler({ canonical2048Url: CANONICAL_2048_URL });

// 공통 JSON 응답 헬퍼.
const sendJson = (res, status, payload) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
};

const statsHandler = (req, res) => {
  // active_ws — wss 가 아래에서 만들어지지만 statsHandler 가 실제 호출되는 시점엔
  // 이미 init. 아직 없으면 0.
  const activeWs = wss ? wss.clients.size : 0;
  sendJson(res, 200, { ...getUserStats(), active_ws: activeWs, ts: new Date().toISOString() });
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// /api/daily-stats?date=YYYY-MM-DD — 일별 카운터 + active_users SET 크기.
// monitor 가 server-domain 카운트를 이 단일 endpoint 로 수신 (Render log 대체).
const dailyStatsHandler = (req, res) => {
  const url = new URL(req.url, 'http://x');
  const date = url.searchParams.get('date') || '';
  if (!DATE_RE.test(date)) return sendJson(res, 400, { error: 'date=YYYY-MM-DD required' });
  const store = getStore();
  const c = store.getDailyStats ? (store.getDailyStats(date) || {}) : {};
  // backfill 호환: SET 크기 0 이면 `{name}_backfill` counter fallback.
  const setSize = (name) => {
    const live = store.getDailySetSize ? store.getDailySetSize(date, name) : 0;
    if (live > 0) return live;
    return Number(c[`${name}_backfill`]) || 0;
  };
  sendJson(res, 200, {
    date,
    submit_score: c.submit_score || 0,
    user_created: c.user_created || 0,
    score_best: c.score_best || 0,
    ws_connected: c.ws_connected || 0,
    ws_disconnected: c.ws_disconnected || 0,
    heartbeat_terminate: c.heartbeat_terminate || 0,
    active_users: setSize('active_users'),
    ts: new Date().toISOString(),
  });
};

// /api/online-series?from=epoch_ms&to=epoch_ms — 1분 sample.
const onlineSeriesHandler = (req, res) => {
  const url = new URL(req.url, 'http://x');
  const from = Number(url.searchParams.get('from')) || 0;
  const to = Number(url.searchParams.get('to')) || Date.now();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return sendJson(res, 400, { error: 'from=<epoch_ms>&to=<epoch_ms> required (to > from)' });
  }
  const store = getStore();
  const items = store.getOnlineSeries ? store.getOnlineSeries(from, to) : [];
  sendJson(res, 200, { from, to, count: items.length, items, ts: new Date().toISOString() });
};

const httpServer = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/api/stats') return statsHandler(req, res);
  if (urlPath === '/api/daily-stats') return dailyStatsHandler(req, res);
  if (urlPath === '/api/online-series') return onlineSeriesHandler(req, res);
  if (urlPath.startsWith('/i/2048')) return shareHandler(req, res);
  // FE 정적 파일은 GitHub Pages 에서 서빙 — 여기선 404.
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// WS — Origin 잠금 (prod). 미설정 시 (로컬) 모두 허용.
const wssOpts = { server: httpServer, path: '/ws' };
if (ALLOWED_ORIGINS.length) {
  wssOpts.verifyClient = ({ origin }, cb) => {
    if (origin && ALLOWED_ORIGINS.includes(origin)) return cb(true);
    cb(false, 403, 'Origin not allowed');
  };
}
const wss = new WebSocketServer(wssOpts);
handlers.init(wss);

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.clientId = null;
  ws.nickname = '';
  // monitor 가 시간대별 동접/연결 burst 추적용. clientId/nick 은 connection
  // 시점엔 아직 모름 (set_nickname 도착 전) — close 시 mask 출력.
  log.event('ws_connected', { active: wss.clients.size });
  incrementToday('ws_connected');

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    if (raw && raw.length > 4096) return;   // sanity cap (작은 message 만)
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    try {
      handlers.handleMessage(ws, msg);
    } catch (e) {
      console.error('handler error:', e);
    }
  });

  ws.on('close', () => {
    log.event('ws_disconnected', {
      client: log.mask(ws.clientId), nick: ws.nickname || undefined,
      active: wss.clients.size,
    });
    incrementToday('ws_disconnected');
    /* user 데이터는 valkey 에 영속 — 정리 필요 X */
  });
});

// Heartbeat — 15s cycle, zombie ws 정리.
const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      log.event('heartbeat_terminate', { client: log.mask(ws.clientId), nick: ws.nickname || undefined });
      incrementToday('heartbeat_terminate');
      try { ws.terminate(); } catch {}
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, HEARTBEAT_INTERVAL_MS);
heartbeatTimer.unref?.();
wss.on('close', () => clearInterval(heartbeatTimer));

// Online time-series sampler — 1분마다 wss.clients.size sample.
const ONLINE_SAMPLE_INTERVAL_MS = Number(process.env.ONLINE_SAMPLE_INTERVAL_MS) || 60 * 1000;
const onlineSamplerTimer = setInterval(() => {
  try { sampleOnlineNow(wss.clients.size); } catch {}
}, ONLINE_SAMPLE_INTERVAL_MS);
onlineSamplerTimer.unref?.();
wss.on('close', () => clearInterval(onlineSamplerTimer));

(async () => {
  const store = getStore();
  try {
    await store.connect();
    await store.hydrate();
    log.event('store_ready', { backend: store.backend });
  } catch (e) {
    console.error('[store] init 실패:', e && e.message);
  }

  httpServer.listen(PORT, () => {
    log.event('server_start', {
      port: PORT,
      heartbeat_ms: HEARTBEAT_INTERVAL_MS,
      allowed_origins: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(',') : 'any',
      store: store.backend,
    });
  });
})();

// Graceful shutdown — Render redeploy / 수동 SIGTERM 대응.
const shutdown = async (signal) => {
  log.event('server_shutdown', { signal });
  try {
    for (const ws of wss.clients) {
      try {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'server_restarting' }));
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 1500));
    wss.close();
    httpServer.close();
    await getStore().disconnect();
  } catch {}
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
