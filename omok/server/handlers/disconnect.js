// ============================================================
// 연결 끊김 처리 — onPlayerDisconnect / finalizeAbandon / onLeaveRoom.
// playing : 기존대로 — 상대에게 opponent_disconnected, grace 후 finalizeAbandon
// waiting : 방장만 있는 상태에서 끊김 — 방은 유지, grace 후 폐쇄.
//           (다른 탭/네트워크 회복 후 resume_session 으로 복귀 가능)
// over    : 게임 끝나고 재대국 대기 중 — 방 유지, grace 후 폐쇄.
//           (재연결되면 결과 화면 그대로 복귀)
// ============================================================

const { getRoom, deleteRoom, markRoomDirty, clearPlayerSession } = require('../domain/rooms');
const connections = require('../connections');
const roomRuntime = require('../domain/room-runtime');
const {
  send, sendToPlayer, forEachSpectatorWs,
  playerIdsPayload, broadcastRoomsList,
  broadcastRankingUpdate, broadcastRecentGamesUpdate,
} = require('./send');
const { removeSpectator } = require('./spectator');
const { clearTurnTimer } = require('./game');
const { cancelBotTimers } = require('./bot');
const { recordGameResult } = require('../domain/users');
const log = require('../infra/log');

// 사용자 끊김 → heartbeat 가 0-60s 안에 감지 (HEARTBEAT_INTERVAL_MS=30s × 2 사이클).
// 그 후 grace 동안 reconnect 안 하면 finalizeAbandon. heartbeat 단계에서 이미 60s
// 동안 응답이 없었으니 grace 는 60s 면 충분 (총 최대 60+60=120s).
// Render free-tier deploy 의 graceful period 30s 도 안에 들어옴.
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS) || 60000;

const otherColor = (c) => (c === 'black' ? 'white' : 'black');

const onLeaveRoom = (ws) => {
  if (!ws.roomCode) return;
  const room = getRoom(ws.roomCode);
  if (!room) { ws.roomCode = null; ws.color = null; ws.role = null; return; }

  if (ws.role === 'spectator') {
    removeSpectator(ws);
    return;
  }

  // 플레이어가 나감 → 방 폐쇄, 모두에게 알림
  clearTurnTimer(room);
  cancelBotTimers(room);
  roomRuntime.clearAllDisconnectTimers(room.code);

  const oppColor = otherColor(ws.color);
  const oppSlot = room.players[oppColor];
  const oppWs = oppSlot ? connections.getWsBySessionId(oppSlot.sessionId) : null;
  const playerIds = playerIdsPayload(room);

  // 대전 중에 나가면 → 상대 승리로 처리
  if (room.status === 'playing') {
    const winnerColor = oppColor;
    room.status = 'over';
    room.winner = winnerColor;
    sendToPlayer(room, oppColor, { type: 'game_over', winner: winnerColor, line: null, gameId: room.gameId, playerIds, reason: 'opponent_left' });
    forEachSpectatorWs(room, (s) => send(s, { type: 'game_over', winner: winnerColor, line: null, gameId: room.gameId, playerIds, reason: 'opponent_left' }));
    // 명시적 leave_room → 자진 포기로 간주, 랭킹 반영
    recordGameResult(room, { winnerColor, reason: 'opponent_left' });
    broadcastRankingUpdate();
    broadcastRecentGamesUpdate();
    log.event('game_over', { code: room.code, gameId: room.gameId, winner: winnerColor, reason: 'opponent_left' });
  } else {
    sendToPlayer(room, oppColor, { type: 'opponent_left' });
    forEachSpectatorWs(room, (s) => send(s, { type: 'opponent_left' }));
  }

  if (oppWs) {
    oppWs.roomCode = null; oppWs.color = null; oppWs.role = null;
    oppWs.sessionId = null;
  }
  forEachSpectatorWs(room, (s) => { s.roomCode = null; s.role = null; });
  ws.sessionId = null;
  // deleteRoom 이 양쪽 슬롯 + spectator sessions 모두 dropSession 처리.
  roomRuntime.dispose(room.code);
  deleteRoom(room.code);
  ws.roomCode = null; ws.color = null; ws.role = null;
  broadcastRoomsList();
};

const onPlayerDisconnect = (ws) => {
  if (!ws.roomCode) return;
  if (ws.role === 'spectator') {
    removeSpectator(ws);
    return;
  }
  const room = getRoom(ws.roomCode);
  if (!room) return;

  // 옛 ws 가 뒤늦게 close 된 경우 (비행기모드 좀비) — 이미 새 ws 로 sid 가 rebind 됐다면
  // 그 player 는 사실상 online. 옛 ws 의 close 로 grace timer 시작하면 안 됨.
  // resume.js 에서도 옛 ws.roomCode 를 정리하지만, 그 정리 시점과 close fire 시점이
  // 어긋날 수 있어 여기서 한번 더 가드 (defense in depth).
  if (ws.sessionId && ws.color) {
    const activeWs = connections.getWsBySessionId(ws.sessionId);
    if (activeWs && activeWs !== ws) return;  // 다른 ws 가 이 sid 의 active — 무시
  }

  if (room.status !== 'playing' && room.status !== 'waiting' && room.status !== 'over') {
    onLeaveRoom(ws);
    return;
  }

  // 봇 게임 / PVP 모두 — 사람이 끊긴 동안 turn timer 동결.
  // 의도: deploy / 일시 네트워크 끊김 동안 turn 이 일방적으로 토글되어 reconnect 후
  //   상태가 엉키는 사고 방지. resume_session / reclaim 시 양쪽 다 online 일 때 재개.
  // grace timer 는 그대로 작동 (DISCONNECT_GRACE_MS 만료 시 abandon).
  if (room.status === 'playing') {
    clearTurnTimer(room);
    if (room.hasBot) cancelBotTimers(room);
    markRoomDirty(room);  // turnDeadline=0 도 valkey 에 sync (deploy hydrate 후 일관)
  }
  const myColor = ws.color;
  const deadline = Date.now() + DISCONNECT_GRACE_MS;
  // slot 자체는 nullify 하지 않는다 (resume 시 메타 그대로 사용). ws 만 끊겼으니
  // sendToSession 은 자연히 no-op.
  // graceMs 도 같이 보냄 — 클라이언트가 deadline 을 자기 시계로 normalize 할 때 cap.
  // (시계 skew 로 deadline-clientNow > graceMs 되어 "61초" 같은 표시 방지)
  const payload = { type: 'opponent_disconnected', color: myColor, deadline, graceMs: DISCONNECT_GRACE_MS };
  sendToPlayer(room, otherColor(myColor), payload);
  forEachSpectatorWs(room, (s) => send(s, payload));
  roomRuntime.setDisconnectTimer(room.code, myColor, setTimeout(() => finalizeAbandon(room, myColor), DISCONNECT_GRACE_MS));
};

const finalizeAbandon = (room, color) => {
  const playerIds = playerIdsPayload(room);
  // 게임 중에 안 돌아온 경우 — opponent_abandoned 알림, status='over' 로 전환.
  // 봇 게임도 동일 흐름. 봇한테 sendToPlayer 는 자연히 no-op.
  if (room.status === 'playing') {
    room.status = 'over';
    for (const c of ['black', 'white']) sendToPlayer(room, c, { type: 'opponent_abandoned', color, gameId: room.gameId, playerIds });
    forEachSpectatorWs(room, (s) => send(s, { type: 'opponent_abandoned', color, gameId: room.gameId, playerIds }));
    clearTurnTimer(room);
    cancelBotTimers(room);
    // 양쪽 동시 끊김 (PVP) 인지 체크 — 사용자 결정으로 그 케이스는 rating 변화 없음.
    // 봇 게임은 한 쪽 (사람) 끊김으로 봇은 영향 없으니 bothDisconnected 아님.
    const oppColor = otherColor(color);
    const oppSlot = room.players[oppColor];
    const bothDisconnected = !room.hasBot && oppSlot && oppSlot.type === 'human' &&
      !connections.getWsBySessionId(oppSlot.sessionId);
    recordGameResult(room, { winnerColor: oppColor, reason: 'abandoned', bothDisconnected });
    if (!bothDisconnected) {
      broadcastRankingUpdate();
      broadcastRecentGamesUpdate();
    }
    clearPlayerSession(room, color);
    markRoomDirty(room);
    broadcastRoomsList();
    log.event('game_over', { code: room.code, gameId: room.gameId, winner: oppColor, reason: 'abandoned' });
    // 봇대전이면 rematch 의미 없으니 방 자체 폐쇄. 사람 대전은 status='over' 채로 유지
    // (남은 사람이 leave_room 누르거나 grace 만료될 때까지).
    if (room.hasBot) {
      roomRuntime.clearAllDisconnectTimers(room.code);
      roomRuntime.dispose(room.code);
      deleteRoom(room.code);
    }
    return;
  }
  // 대기 중(waiting) 또는 종료 후(over) 에 grace 동안 안 돌아온 경우 — 방 자체를 닫음.
  if (room.status === 'waiting' || room.status === 'over') {
    const oppColor = otherColor(color);
    const oppSlot = room.players[oppColor];
    const oppWs = oppSlot ? connections.getWsBySessionId(oppSlot.sessionId) : null;
    if (oppSlot) {
      sendToPlayer(room, oppColor, { type: 'opponent_left' });
      if (oppWs) {
        oppWs.roomCode = null; oppWs.color = null; oppWs.role = null;
        oppWs.sessionId = null;
      }
    }
    forEachSpectatorWs(room, (s) => {
      send(s, { type: 'opponent_left' });
      s.roomCode = null; s.role = null;
    });
    roomRuntime.clearAllDisconnectTimers(room.code);
    clearTurnTimer(room);
    roomRuntime.dispose(room.code);
    deleteRoom(room.code);
    broadcastRoomsList();
  }
};

module.exports = { onPlayerDisconnect, finalizeAbandon, onLeaveRoom };
