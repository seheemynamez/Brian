// ============================================================
// 전송 헬퍼 — ws / sessionId / clientId / room 기준 송신.
// 모듈-내부 state (rooms_list 보류 플래그) 도 여기에서 관리.
// ============================================================

const connections = require('../connections');
const { getRoomsList } = require('../domain/rooms');
const { getWss } = require('./state');

// 도메인 코드가 ws 객체에 직접 의존하지 않도록, ID 기반 송신 헬퍼를 함께 노출 (이슈 #31).
// 기존 send(ws, msg) 는 점진 마이그레이션을 위해 유지.
const send = (ws, msg) => {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};

const sendToConnection = (connectionId, msg) => {
  if (!connectionId) return;
  send(connections.getWsByConnectionId(connectionId), msg);
};

const sendToSession = (sessionId, msg) => {
  if (!sessionId) return;
  send(connections.getWsBySessionId(sessionId), msg);
};

// 같은 clientId 로 연결된 모든 ws 에 송신 (멀티탭/멀티기기).
const sendToClient = (clientId, msg) => {
  if (!clientId) return;
  for (const ws of connections.getWsListByClientId(clientId)) send(ws, msg);
};

// 관전자 iteration helpers — spectatorSessionIds (single source of truth) → ws via connections.
// ws 가 죽어있으면(close 직후) 무시.
const forEachSpectatorWs = (room, fn) => {
  for (const sid of room.spectatorSessionIds) {
    const ws = connections.getWsBySessionId(sid);
    if (ws && ws.readyState === ws.OPEN) fn(ws, sid);
  }
};

// Player Actor 추상화 — 사람과 봇을 색깔 기준으로 다룬다. room 안에 ws 가 없으므로
// 송신은 sessionId → ws lookup 으로 처리. 봇은 transport 가 없으므로 송신 no-op.
const sendToPlayer = (room, color, msg) => {
  const slot = room.players[color];
  if (!slot) return false;
  if (slot.type === 'bot') return true;  // 봇에게 UI 메시지 전송 불필요
  return sendToSession(slot.sessionId, msg);
};

const broadcastRoom = (room, msg) => {
  for (const color of ['black', 'white']) sendToPlayer(room, color, msg);
  forEachSpectatorWs(room, (ws) => send(ws, msg));
};

// game_over / game_start 같은 곳에서 발송하는 player metadata payload.
// FE 가 black/white 둘 다 알아야 할 때 일관되게 사용.
const playerIdsPayload = (room) => ({
  black: room.players.black?.playerId || null,
  white: room.players.white?.playerId || null,
});

// 현재 양쪽 player 의 connection 상태 — 게임 화면 UI 의 online indicator 용.
// 봇은 항상 'online' (transport 는 없지만 UI 표시는 그렇게).
// 사람은 sessionId 의 활성 ws 존재 여부로 판단.
const playerStatusPayload = (room) => {
  const out = {};
  for (const color of ['black', 'white']) {
    const slot = room.players[color];
    if (!slot) { out[color] = 'offline'; continue; }
    if (slot.type === 'bot') { out[color] = 'online'; continue; }
    const ws = connections.getWsBySessionId(slot.sessionId);
    out[color] = (ws && ws.readyState === ws.OPEN) ? 'online' : 'offline';
  }
  return out;
};

const broadcastOnlineCount = () => {
  const wssRef = getWss();
  if (!wssRef) return;
  // 클라이언트에는 "실제 사용자 수" — 같은 clientId 의 좀비 연결은 합산 안 함.
  // 비행기모드 reconnect 동안 옛 ws 가 heartbeat 로 정리되기 전까지 짧게 중복 카운팅 되던 버그.
  const payload = JSON.stringify({ type: 'online_count', n: connections.getUniqueOnlineCount() });
  for (const c of wssRef.clients) {
    if (c.readyState === c.OPEN) c.send(payload);
  }
};

// 방 목록 변경 시 모든 연결된 클라에게 푸시.
// 동시에 여러 변경이 일어나도 한 tick 으로 합쳐 보냄(부하 절약).
let _roomsListPending = false;
const broadcastRoomsList = () => {
  const wssRef = getWss();
  if (!wssRef || _roomsListPending) return;
  _roomsListPending = true;
  setImmediate(() => {
    _roomsListPending = false;
    const currentWss = getWss();
    if (!currentWss) return;
    const payload = JSON.stringify({ type: 'rooms_list', rooms: getRoomsList() });
    for (const c of currentWss.clients) {
      if (c.readyState === c.OPEN) c.send(payload);
    }
  });
};

// 랭킹 변경 시 모든 연결된 클라에 push. 게임 종료 직후 호출.
// rooms_list 와 동일한 1-tick 합치기 패턴.
let _rankingPending = false;
const broadcastRankingUpdate = () => {
  const wssRef = getWss();
  if (!wssRef || _rankingPending) return;
  _rankingPending = true;
  setImmediate(() => {
    _rankingPending = false;
    const currentWss = getWss();
    if (!currentWss) return;
    const { getTopRanking } = require('../domain/users');
    const entries = getTopRanking(10);
    const payload = JSON.stringify({ type: 'ranking_list', entries });
    for (const c of currentWss.clients) {
      if (c.readyState === c.OPEN) c.send(payload);
    }
  });
};

let _recentGamesPending = false;
const broadcastRecentGamesUpdate = () => {
  const wssRef = getWss();
  if (!wssRef || _recentGamesPending) return;
  _recentGamesPending = true;
  setImmediate(() => {
    _recentGamesPending = false;
    const currentWss = getWss();
    if (!currentWss) return;
    const { getRecentGames } = require('../domain/users');
    const payload = JSON.stringify({ type: 'recent_games_list', entries: getRecentGames(10) });
    for (const c of currentWss.clients) {
      if (c.readyState === c.OPEN) c.send(payload);
    }
  });
};

// 양쪽 player 가 모두 online 인지 — PVP 는 두 사람 다 ws 활성, 봇 게임은 사람만 활성.
// resume/reclaim 후 turn timer 재개 결정에 사용.
const bothPlayersOnline = (room) => {
  if (!room || !room.players) return false;
  for (const color of ['black', 'white']) {
    const slot = room.players[color];
    if (!slot) return false;
    if (slot.type === 'bot') continue;
    const ws = connections.getWsBySessionId(slot.sessionId);
    if (!ws || ws.readyState !== ws.OPEN) return false;
  }
  return true;
};

module.exports = {
  send,
  sendToConnection,
  sendToSession,
  sendToClient,
  sendToPlayer,
  forEachSpectatorWs,
  broadcastRoom,
  playerIdsPayload,
  playerStatusPayload,
  bothPlayersOnline,
  broadcastOnlineCount,
  broadcastRoomsList,
  broadcastRankingUpdate,
  broadcastRecentGamesUpdate,
};
