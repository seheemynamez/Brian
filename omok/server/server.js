// ============================================================
// 오목대전 서버 진입점
// HTTP는 omok/ FE 정적 파일, /ws는 게임 WebSocket
// ============================================================

const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { makeStaticHandler } = require('./http-static');
const { makeShareHandler } = require('./share');
const { incrementOnline, decrementOnline, getOnline } = require('./rooms');
const handlers = require('./handlers');

const PORT = Number(process.env.PORT) || 8080;
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

  incrementOnline();
  handlers.broadcastOnlineCount();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
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
    decrementOnline();
    handlers.broadcastOnlineCount();
  });
});

httpServer.listen(PORT, () => {
  console.log(`[omok] HTTP   http://localhost:${PORT}`);
  console.log(`[omok] WS     ws://localhost:${PORT}/ws`);
  console.log(`[omok] online=${getOnline()}`);
  if (ALLOWED_ORIGINS.length) {
    console.log(`[omok] ALLOWED_ORIGINS=${ALLOWED_ORIGINS.join(',')}`);
  } else {
    console.log('[omok] ALLOWED_ORIGINS unset → 모든 origin 허용 (개발 모드)');
  }
});
