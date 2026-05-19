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

const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS) || 30000;

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

  if (room.status !== 'playing' && room.status !== 'waiting' && room.status !== 'over') {
    onLeaveRoom(ws);
    return;
  }

  // PVP 는 기존대로 — turn timer / 봇 timer (없음) 가 동시에 흘러 grace 만료 또는
  //   turn timer 만료 중 먼저 발동하는 쪽이 종료 trigger. 양쪽 다 멈춰 방치되는 상황 방지.
  // 봇 게임은 사람이 끊긴 동안 game 자체를 일시정지 — turn timer + 봇 응수 schedule 멈춤.
  //   이유: deploy / 일시 네트워크 끊김 사이에 봇이 사용자 차례 timeout 을 반복 흡수해
  //   board 가 사용자 모르게 진행되는 사고 방지. resume_session / clientId reclaim 시 재개.
  //   봇은 시간 손해 없으니 멈춰도 무해. grace 만료 시 abandon 처리는 그대로.
  if (room.hasBot && room.status === 'playing') {
    clearTurnTimer(room);
    cancelBotTimers(room);
  }
  const myColor = ws.color;
  const deadline = Date.now() + DISCONNECT_GRACE_MS;
  // slot 자체는 nullify 하지 않는다 (resume 시 메타 그대로 사용). ws 만 끊겼으니
  // sendToSession 은 자연히 no-op.
  sendToPlayer(room, otherColor(myColor), { type: 'opponent_disconnected', color: myColor, deadline });
  forEachSpectatorWs(room, (s) => send(s, { type: 'opponent_disconnected', color: myColor, deadline }));
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
