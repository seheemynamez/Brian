// ============================================================
// 재대국 — onRematch.
// 패자 선공 (black/white slot swap).
// ============================================================

const { getRoom, getSession } = require('../domain/rooms');
const connections = require('../connections');
const { newBotEmoteState } = require('../game/bot');
const { broadcastRoom } = require('./send');
const { startGame } = require('./game');
const { getBotColor, scheduleBotMove } = require('./bot');
const { tryBotEmote } = require('./emote');

const onRematch = (ws) => {
  if (!ws.roomCode || ws.role !== 'player') return;
  const room = getRoom(ws.roomCode);
  if (!room || room.status !== 'over') return;
  room.rematchVotes.add(ws.color);
  // 봇은 자동으로 재대국 동의
  if (room.hasBot) {
    const botColor = getBotColor(room);
    if (botColor) room.rematchVotes.add(botColor);
  }
  if (room.rematchVotes.size < 2) {
    broadcastRoom(room, { type: 'rematch_pending', who: ws.color });
    return;
  }
  // 패자 선공 — black/white 슬롯을 swap. 옛 sessionId 의 color 정보도 업데이트.
  if (room.loser === 'white') {
    const blackSlot = room.players.black;
    const whiteSlot = room.players.white;
    room.players.black = whiteSlot;
    room.players.white = blackSlot;
    // sessions 안의 color 필드도 동기화. ws 의 color 도.
    if (whiteSlot?.sessionId) {
      const sess = getSession(whiteSlot.sessionId);
      if (sess) sess.color = 'black';
      const w = connections.getWsBySessionId(whiteSlot.sessionId);
      if (w) w.color = 'black';
    }
    if (blackSlot?.sessionId) {
      const sess = getSession(blackSlot.sessionId);
      if (sess) sess.color = 'white';
      const w = connections.getWsBySessionId(blackSlot.sessionId);
      if (w) w.color = 'white';
    }
  }
  startGame(room);
  // 봇이 흑(선공) 이라면 첫 수 스케줄링
  if (room.hasBot) {
    if (room.botEmoteState) room.botEmoteState = newBotEmoteState();  // emote 쿨다운 리셋
    const botColor = getBotColor(room);
    if (botColor && room.turn === botColor) scheduleBotMove(room);
    setTimeout(() => tryBotEmote(room, 'game_start'), 800);
  }
};

module.exports = { onRematch };
