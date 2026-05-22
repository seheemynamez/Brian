// ============================================================
// WS broadcast / send helpers
// ============================================================
'use strict';

let wssRef = null;

const init = (wss) => { wssRef = wss; };

const send = (ws, payload) => {
  if (!ws || ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(payload)); } catch { /* ignore */ }
};

// 전체 클라이언트 broadcast — 랭킹 업데이트용. 작은 데이터.
const broadcastAll = (payload) => {
  if (!wssRef) return;
  const json = JSON.stringify(payload);
  for (const ws of wssRef.clients) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(json); } catch { /* ignore */ }
    }
  }
};

module.exports = { init, send, broadcastAll };
