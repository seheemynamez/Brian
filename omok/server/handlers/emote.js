// ============================================================
// 이모트 — 게임 중 짧은 상호작용 메시지.
// 사람 이모트는 onEmote, 봇 이모트는 tryBotEmote 로 전송.
// ============================================================

const { getRoom } = require('../domain/rooms');
const {
  decideBotEmote, recordBotEmote, newBotEmoteState,
} = require('../game/bot');
const { broadcastRoom } = require('./send');

const EMOTE_COOLDOWN_MS = Number(process.env.EMOTE_COOLDOWN_MS) || 800;

// 게임 중 짧은 상호작용 이모트. 키는 클라/서버 합의된 화이트리스트만 허용.
const EMOTES = {
  hi:        { emoji: '👋', text: 'Hi' },
  tick_tock: { emoji: '⏰', text: 'Tick-tock' },
  hmm:       { emoji: '🤔', text: 'Hmm..' },
  oops:      { emoji: '🫢', text: 'Oops' },
  easy:      { emoji: '😏', text: 'Easy' },
  sure:      { emoji: '🤨', text: 'You sure?' },
  please:    { emoji: '🥺', text: 'Please..' },
  wow:       { emoji: '😳', text: 'WOW' },
  gg:        { emoji: '🫡', text: 'GG' },
  again:     { emoji: '🔁', text: 'Again?' },
};

// 봇 컬러 조회 (다른 모듈에서도 쓰지만 emote 에서 직접 필요).
const getBotColor = (room) => {
  if (!room.hasBot) return null;
  if (room.players.black?.type === 'bot') return 'black';
  if (room.players.white?.type === 'bot') return 'white';
  return null;
};

// ============================================================
// 봇 행동 — emote
// ============================================================
const tryBotEmote = (room, trigger) => {
  if (!room || !room.hasBot) return;
  const botColor = getBotColor(room);
  if (!botColor) return;
  const bot = room.players[botColor];
  if (!room.botEmoteState) room.botEmoteState = newBotEmoteState();
  const key = decideBotEmote({
    board: room.board, botColor, difficulty: bot.difficulty,
    trigger, emoteState: room.botEmoteState, now: Date.now(),
  });
  if (!key) return;
  const e = EMOTES[key];
  if (!e) return;
  recordBotEmote(room.botEmoteState, key, Date.now());
  broadcastRoom(room, { type: 'emote', from: botColor, key, emoji: e.emoji, text: e.text });
};

// 플레이어가 보낸 이모트를 방 전체(상대 + 관전자)에 브로드캐스트.
// 진행 중(playing) 또는 종료 후(over)에만 허용. 같은 ws의 너무 잦은 송신은 쿨다운으로 무시.
const onEmote = (ws, msg) => {
  if (!ws.roomCode || ws.role !== 'player') return;
  const room = getRoom(ws.roomCode);
  if (!room) return;
  if (room.status !== 'playing' && room.status !== 'over') return;
  const e = EMOTES[msg.key];
  if (!e) return;
  const now = Date.now();
  if (ws.lastEmoteAt && now - ws.lastEmoteAt < EMOTE_COOLDOWN_MS) return;
  ws.lastEmoteAt = now;
  broadcastRoom(room, {
    type: 'emote',
    from: ws.color,
    key: msg.key,
    emoji: e.emoji,
    text: e.text,
  });
};

module.exports = { EMOTES, onEmote, tryBotEmote };
