// ============================================================
// 오목대전 서버 진입점
// HTTP는 omok/ FE 정적 파일, /ws는 게임 WebSocket
// ============================================================

const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { makeStaticHandler } = require('./http-static');
const { incrementOnline, decrementOnline, getOnline } = require('./rooms');
const handlers = require('./handlers');

const PORT = Number(process.env.PORT) || 8080;
const STATIC_ROOT = path.resolve(__dirname, '..'); // omok/

const httpServer = http.createServer(makeStaticHandler(STATIC_ROOT));

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
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
});
