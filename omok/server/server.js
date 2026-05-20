// ============================================================
// 오목대전 서버 진입점
// HTTP는 omok/ FE 정적 파일, /ws는 게임 WebSocket
// ============================================================

const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { makeStaticHandler } = require('./infra/http-static');
const { makeShareHandler } = require('./infra/share');
const { incrementOnline, decrementOnline, getOnline, touchSession } = require('./domain/rooms');
const connections = require('./connections');
const handlers = require('./handlers');
const { validateMessage, MAX_MESSAGE_BYTES } = require('./infra/validators');
const { checkRateLimit, clearForConnection } = require('./infra/rate-limit');
const { getStore } = require('./store');
const log = require('./infra/log');

const PORT = Number(process.env.PORT) || 8080;
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS) || 30000;
// 기본: omok/ — 운영(Render) 배포와 동일
// 로컬 LAN 테스트에서 2048 등 형제 디렉토리까지 같이 띄우려면 STATIC_ROOT=../.. 로 실행.
const STATIC_ROOT = process.env.STATIC_ROOT
  ? path.resolve(process.env.STATIC_ROOT)
  : path.resolve(__dirname, '..');

// 프로덕션(Render 등)에선 Pages 도메인만 허용. 미설정 시(로컬 개발) 모두 허용.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// /i/CODE 초대 페이지의 canonical 리다이렉트 타깃.
// 운영(Render): https://seheemynamez.github.io/Brian/omok/
// 로컬: 미설정 시 같은 origin 의 /omok/ 로 자동 fallback (share.js 내부)
const CANONICAL_OMOK_URL = process.env.CANONICAL_OMOK_URL || null;

const staticHandler = makeStaticHandler(STATIC_ROOT);
const shareHandler  = makeShareHandler({ canonicalOmokUrl: CANONICAL_OMOK_URL });

const httpServer = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath.startsWith('/i/')) return shareHandler(req, res);
  return staticHandler(req, res);
});

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
  ws.roomCode = null;
  ws.color = null;
  ws.role = null;
  ws.inQueue = false;
  ws.sessionId = null;
  ws.nickname = '';
  // heartbeat: 직전 ping 사이클에 pong(또는 client app-ping)을 받았는가
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // 도메인 코드가 ws 객체를 직접 unique key 로 안 쓰게 — connectionId 발급 (이슈 #31).
  connections.register(ws);

  incrementOnline();
  handlers.broadcastOnlineCount();
  log.event('ws_connected', { online: getOnline(), conn: ws.connectionId });

  ws.on('message', (raw) => {
    // 너무 큰 payload 는 parse 자체를 건너뛴다 — 메모리·CPU 방어.
    if (raw && raw.length > MAX_MESSAGE_BYTES) return;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    // 클라이언트 app-level ping은 즉시 pong 으로 응답하고 살아있다고 표시.
    // 모바일 브라우저(WebSocket protocol ping 다루기 어려움)에서 백업 채널 역할.
    // schema 검증·rate limit 이전에 가로채 — 빈도 높고 비용 절약.
    if (msg.type === 'ping') {
      ws.isAlive = true;
      if (ws.sessionId) touchSession(ws.sessionId);
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    if (msg.type === 'pong') {
      ws.isAlive = true;
      if (ws.sessionId) touchSession(ws.sessionId);
      return;
    }
    // schema 검증 — 형식 어긋난 payload 는 조용히 무시(스팸 답신 방지).
    const v = validateMessage(msg);
    if (!v.ok) return;
    // 세션 활성 신호 — 메시지 도착 자체로 lastSeenAt 갱신.
    if (ws.sessionId) touchSession(ws.sessionId);
    // 액션별 rate limit — primary key 는 clientId, 폴백은 sessionId → connectionId.
    // (이슈 #31 Phase 3: 새로고침으로 한도 우회되지 않도록 사용자 단위로 묶음.)
    if (!checkRateLimit({ clientId: ws.clientId, sessionId: ws.sessionId, connectionId: ws.connectionId }, msg.type)) {
      log.event('rate_limited', { action: msg.type, client: log.mask(ws.clientId), nick: ws.nickname || undefined });
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: '잠시 후 다시 시도해주세요' }));
      }
      return;
    }
    try {
      handlers.handleMessage(ws, msg);
    } catch (e) {
      console.error('handler error:', e);
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: '서버 처리 중 오류' }));
      }
    }
  });

  ws.on('close', () => {
    handlers.onQueueLeave(ws);
    handlers.onPlayerDisconnect(ws);
    // rate-limit bucket 정리. unregister 보다 먼저 — connectionId 가 아직 살아있을 때.
    clearForConnection(ws.connectionId);
    // connectionId / clientId / sessionId 매핑 정리. session 자체는 grace 동안 유지될 수 있어서
    // 여기서 dropSession 은 하지 않음 — wsBySessionId 매핑만 제거.
    connections.unregister(ws);
    decrementOnline();
    handlers.broadcastOnlineCount();
    log.event('ws_disconnected', { online: getOnline(), client: log.mask(ws.clientId), nick: ws.nickname || undefined });
  });
});

// 좀비 연결 청소: 한 사이클 동안 pong/메시지가 전혀 없으면 강제 종료.
// 정상 종료한 연결은 즉시 'close' 가 발생해 online/queue/session 정리가 일어나지만,
// 모바일 백그라운드·네트워크 단절은 socket 이 그대로 떠 있어 카운트가 누적되는 원인이 됨.
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
  // Store 초기화 — STORE_BACKEND=valkey 면 외부 연결 + hydrate.
  // memory backend 면 모든 lifecycle no-op.
  const store = getStore();
  try {
    await store.connect();
    await store.hydrate();
    // hydrate 후 진행 중인 방들의 timer 재등록
    handlers.rehydrateTimers();
    log.event('store_ready', { backend: store.backend });
  } catch (e) {
    console.error('[store] init 실패:', e && e.message);
    // valkey 가 죽어도 서버는 메모리만으로 동작 (지속성 보장 안 됨).
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

// ============================================================
// Graceful shutdown — Render redeploy / 수동 SIGTERM 대응.
// ============================================================
// 흐름:
//   1) 모든 ws 에 server_restarting + close(1012) — 클라가 "서버 업데이트 중" 표시
//   2) 1.5s 대기 (ws send 가 TCP 로 flush 될 시간)
//   3) store.close() — valkey client.quit() 호출 → ioredis 가 pending command 모두
//      서버에 보낸 후 close. 직전에 발생한 마지막 수의 persistRoom 같은 fire-and-forget
//      write 가 valkey 에 도달함을 보장. 이게 빠지면 마지막 1-2 수가 hydrate 시 누락.
//   4) httpServer.close + process.exit
let _shuttingDown = false;
const gracefulShutdown = async (signal) => {
  if (_shuttingDown) return;
  _shuttingDown = true;
  log.event('server_shutdown', { signal });
  const payload = JSON.stringify({ type: 'server_restarting' });
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(payload); } catch {}
      try { ws.close(1012, 'restarting'); } catch {}  // 1012 = Service Restart
    }
  }
  // ws send TCP flush 대기.
  await new Promise((r) => setTimeout(r, 1500));
  // valkey 의 pending writes (마지막 수의 persistRoom 등) 모두 flush 후 connection 정리.
  try {
    const s = require('./store').getStore();
    if (typeof s.close === 'function') await s.close();
  } catch (e) {
    console.error('[shutdown] store.close 실패:', e && e.message);
  }
  try { httpServer.close(); } catch {}
  process.exit(0);
};
process.on('SIGTERM', () => { gracefulShutdown('SIGTERM'); });
process.on('SIGINT',  () => { gracefulShutdown('SIGINT');  });
