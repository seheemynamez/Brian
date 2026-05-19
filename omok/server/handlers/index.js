// ============================================================
// WS 메시지 dispatcher + 외부 entry point.
// 도메인 핸들러는 sub-module 로 분리되어 있고, 여기서는 메시지 타입별 라우팅만 한다.
// ============================================================

const { getRoomsList } = require('../domain/rooms');
const { init } = require('./state');
const { send, broadcastOnlineCount } = require('./send');
const { onEmote } = require('./emote');
const { onQueueJoin, onQueueLeave, onBotOfferAccept, onBotOfferDecline } = require('./queue');
const { onMove } = require('./game');
const { onSetNickname, onRequestOnlineList, onCreateRoom, onRequestRanking, onRequestRecentGames } = require('./lobby');
const { onJoinRoom, onSpectateRoom } = require('./join');
const { onResumeSession } = require('./resume');
const { onPlayerDisconnect, onLeaveRoom } = require('./disconnect');
const { onRematch } = require('./rematch');
const { onCreateBotGame } = require('./bot');
const { rehydrateTimers } = require('./rehydrate');

// ============================================================
// 메시지 디스패치
// ============================================================
const handleMessage = (ws, msg) => {
  switch (msg.type) {
    case 'create_room':    return onCreateRoom(ws, msg);
    case 'join_room':      return onJoinRoom(ws, msg);
    case 'spectate_room':  return onSpectateRoom(ws, msg);
    case 'queue_join':     return onQueueJoin(ws, msg);
    case 'queue_leave':    return onQueueLeave(ws);
    case 'resume_session': return onResumeSession(ws, msg);
    case 'move':           return onMove(ws, msg.row, msg.col);
    case 'rematch':        return onRematch(ws);
    case 'leave_room':     return onLeaveRoom(ws);
    case 'emote':          return onEmote(ws, msg);
    case 'set_nickname':   return onSetNickname(ws, msg);
    case 'create_bot_game':    return onCreateBotGame(ws, msg);
    case 'bot_offer_accept':   return onBotOfferAccept(ws, msg);
    case 'bot_offer_decline':  return onBotOfferDecline(ws);
    case 'request_rooms_list':
      return send(ws, { type: 'rooms_list', rooms: getRoomsList() });
    case 'request_online_list':
      return onRequestOnlineList(ws);
    case 'request_ranking':
      return onRequestRanking(ws, msg);
    case 'request_recent_games':
      return onRequestRecentGames(ws, msg);
  }
};

module.exports = {
  init,
  handleMessage,
  onPlayerDisconnect,
  onQueueLeave,
  broadcastOnlineCount,
  rehydrateTimers,
};
