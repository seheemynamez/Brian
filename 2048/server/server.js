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

const PORT = Number(process.env.PORT) || 8081;
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS) || 15000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const CANONICAL_2048_URL = process.env.CANONICAL_2048_URL || null;

const shareHandler = makeShareHandler({ canonical2048Url: CANONICAL_2048_URL });

const statsHandler = (req, res) => {
  // active_ws — wss 가 아래에서 만들어지지만 statsHandler 가 실제 호출되는 시점엔
  // 이미 init. 아직 없으면 0.
  const activeWs = wss ? wss.clients.size : 0;
  const payload = { ...getUserStats(), active_ws: activeWs, ts: new Date().toISOString() };
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
};

const httpServer = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/api/stats') return statsHandler(req, res);
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
    /* user 데이터는 valkey 에 영속 — 정리 필요 X */
  });
});

// Heartbeat — 15s cycle, zombie ws 정리.
const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      log.event('heartbeat_terminate', { client: log.mask(ws.clientId), nick: ws.nickname || undefined });
      try { ws.terminate(); } catch {}
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, HEARTBEAT_INTERVAL_MS);
heartbeatTimer.unref?.();
wss.on('close', () => clearInterval(heartbeatTimer));

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
