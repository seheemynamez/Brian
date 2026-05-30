// ============================================================
// 재대국 — onRematch.
// 패자 선공 (black/white slot swap).
// ============================================================

const { getRoom } = require('../domain/rooms');
const { newBotEmoteState } = require('../game/bot');
const { broadcastRoom } = require('./send');
const { startGame, swapSlots } = require('./game');
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
  // 패자 선공 — black/white 슬롯 swap. rematch 는 rating 정책 무관.
  if (room.loser === 'white') {
    swapSlots(room);
  }
  // rematch=true → startGame 의 assignColorsByRating skip (패자 흑 정책 보존).
  startGame(room, { rematch: true });
  // 봇이 흑(선공) 이라면 첫 수 스케줄링
  if (room.hasBot) {
    if (room.botEmoteState) room.botEmoteState = newBotEmoteState();  // emote 쿨다운 리셋
    const botColor = getBotColor(room);
    if (botColor && room.turn === botColor) scheduleBotMove(room);
    setTimeout(() => tryBotEmote(room, 'game_start'), 800);
  }
};

module.exports = { onRematch };
