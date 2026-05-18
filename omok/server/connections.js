// ============================================================
// Connection registry — ws 객체와 도메인 식별자 간 매핑.
// ============================================================
// 의도:
//   - 도메인 코드(room, queue, rate-limit 등)는 connectionId / sessionId /
//     clientId 만 다루고, 실제 ws 송수신은 이 모듈을 거쳐서 ws 를 찾는다.
//   - ws 객체가 도메인 상태의 unique key 가 되지 않게 분리 (이슈 #31).
//
// 매핑:
//   connectionId → ws         : 1:1 (연결 살아있는 동안)
//   ws → connectionId         : 1:1
//   sessionId → ws            : 1:1 (그 세션의 현재 활성 ws). 재접속 시 갱신.
//   clientId → Set<connectionId> : 1:N (멀티탭/멀티기기)
// ============================================================

const crypto = require('crypto');

const connectionsByConnectionId = new Map();   // connectionId → ws
const connectionIdByWs = new WeakMap();        // ws → connectionId
const wsBySessionId = new Map();               // sessionId → ws
const connectionsByClientId = new Map();       // clientId → Set<connectionId>

const genConnectionId = () => crypto.randomBytes(8).toString('base64url');

// 새 ws 연결 시 호출. connectionId 발급 + 양방향 매핑.
const register = (ws) => {
  const connectionId = genConnectionId();
  connectionsByConnectionId.set(connectionId, ws);
  connectionIdByWs.set(ws, connectionId);
  ws.connectionId = connectionId;
  return connectionId;
};

// ws close 시 호출. 모든 매핑 정리.
const unregister = (ws) => {
  if (!ws) return;
  const cid = connectionIdByWs.get(ws);
  if (cid) {
    connectionsByConnectionId.delete(cid);
    connectionIdByWs.delete(ws);  // WeakMap entry 정리
    if (ws.clientId) {
      const set = connectionsByClientId.get(ws.clientId);
      if (set) {
        set.delete(cid);
        if (set.size === 0) connectionsByClientId.delete(ws.clientId);
      }
    }
  }
  if (ws.sessionId && wsBySessionId.get(ws.sessionId) === ws) {
    wsBySessionId.delete(ws.sessionId);
  }
};

// session 발급 시 호출 — 그 sessionId 의 활성 ws 를 등록.
// 재접속 시 동일 sessionId 의 ws 가 교체된다 (옛 ws 는 close 가 별도로 정리).
const bindSession = (ws, sessionId) => {
  if (!ws || !sessionId) return;
  wsBySessionId.set(sessionId, ws);
  ws.sessionId = sessionId;
};

const unbindSession = (sessionId) => {
  if (sessionId) wsBySessionId.delete(sessionId);
};

// set_nickname 으로 clientId 받은 직후 호출.
// 같은 ws 가 여러 번 호출돼도 idempotent.
const bindClient = (ws, clientId) => {
  if (!ws || !clientId) return;
  const cid = connectionIdByWs.get(ws);
  if (!cid) return;
  // 기존 clientId 가 있으면 그 set 에서 먼저 제거 (clientId 가 갱신되는 경우)
  if (ws.clientId && ws.clientId !== clientId) {
    const oldSet = connectionsByClientId.get(ws.clientId);
    if (oldSet) {
      oldSet.delete(cid);
      if (oldSet.size === 0) connectionsByClientId.delete(ws.clientId);
    }
  }
  ws.clientId = clientId;
  let set = connectionsByClientId.get(clientId);
  if (!set) {
    set = new Set();
    connectionsByClientId.set(clientId, set);
  }
  set.add(cid);
};

// ---- 조회 ----
const getWsByConnectionId = (id) => connectionsByConnectionId.get(id);
const getWsBySessionId    = (id) => wsBySessionId.get(id);
const getConnectionIdByWs = (ws) => connectionIdByWs.get(ws);

const getWsListByClientId = (clientId) => {
  const cids = connectionsByClientId.get(clientId);
  if (!cids) return [];
  const out = [];
  for (const cid of cids) {
    const ws = connectionsByConnectionId.get(cid);
    if (ws) out.push(ws);
  }
  return out;
};

module.exports = {
  register, unregister,
  bindSession, unbindSession,
  bindClient,
  getWsByConnectionId, getWsBySessionId, getConnectionIdByWs,
  getWsListByClientId,
};
