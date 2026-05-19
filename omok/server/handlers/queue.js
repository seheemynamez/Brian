// ============================================================
// 큐 / 자동매칭 / 봇 제안 — 사용자 매칭 큐와 봇 게임 제안 로직.
// ============================================================

const {
  setRoom, sanitizeNick,
  getQueue, enqueue, dequeueByConnectionId,
  genCode,
  createRoom, createPlayerSession,
} = require('../domain/rooms');
const connections = require('../connections');
const { send } = require('./send');
const log = require('../infra/log');

const BOT_OFFER_DELAY_MS = Number(process.env.BOT_OFFER_DELAY_MS) || 10000;

// 봇 제안 발송 이력 (clientId 단위) — queue 와 무관하게 유지.
// 비행기모드 reconnect race 방어: 옛 ws 의 close 가 새 ws 의 queue_join 보다 먼저 fire
// 되어 옛 entry 가 dequeue 된 경우에도, history 가 남아서 cooldown 으로 중복 발송 차단.
// store.botOffer 를 통해 보관 → valkey backend 면 재시작 후에도 cooldown 유지.
const botOfferSentByClientId = require('../store').getStore().botOffer;
const BOT_OFFER_COOLDOWN_MS = 60_000;  // 발송 후 같은 사용자에게 다시 발송 가능한 최소 간격.

// bot offer 타이머는 queue entry 에 부착 — ws 가 reconnect 로 교체돼도 상태 유지.
// 추가로 clientId 단위 history 도 확인 (entry 가 close→reconnect race 로 사라진 경우 대비).
const scheduleBotOfferIfNeeded = (entry) => {
  if (entry.botOfferSentAt) return;
  // clientId 별 cooldown 검사 — 최근에 발송한 적 있으면 entry 에 표시만 하고 timer 안 켬.
  if (entry.clientId) {
    const last = botOfferSentByClientId.get(entry.clientId);
    if (last && (Date.now() - last) < BOT_OFFER_COOLDOWN_MS) {
      entry.botOfferSentAt = last;
      return;
    }
  }
  if (entry.botOfferTimer) clearTimeout(entry.botOfferTimer);
  const remaining = Math.max(0, BOT_OFFER_DELAY_MS - (Date.now() - entry.joinedAt));
  entry.botOfferTimer = setTimeout(() => {
    entry.botOfferTimer = null;
    const now = Date.now();
    entry.botOfferSentAt = now;
    if (entry.clientId) {
      botOfferSentByClientId.set(entry.clientId, now);
      // Lazy cleanup — cooldown 의 2배 지난 항목 제거 (메모리 누수 방지).
      for (const [cid, ts] of botOfferSentByClientId) {
        if (now - ts > BOT_OFFER_COOLDOWN_MS * 2) botOfferSentByClientId.delete(cid);
      }
    }
    const liveWs = connections.getWsByConnectionId(entry.connectionId);
    if (liveWs && liveWs.readyState === liveWs.OPEN) {
      send(liveWs, { type: 'bot_offer' });
    }
  }, remaining);
};

const clearBotOfferTimer = (entry) => {
  if (entry && entry.botOfferTimer) {
    clearTimeout(entry.botOfferTimer);
    entry.botOfferTimer = null;
  }
};

const onQueueJoin = (ws, msg) => {
  if (ws.roomCode) return send(ws, { type: 'error', message: '이미 방에 있어요' });
  ws.nickname = sanitizeNick(msg.nickname) || '익명';
  // 클라이언트 식별자 (같은 브라우저에서 온 요청 dedupe 용도) — connection registry 에도 반영.
  if (typeof msg.clientId === 'string' && msg.clientId.length > 0 && msg.clientId.length <= 64) {
    connections.bindClient(ws, msg.clientId);
  }

  const q = getQueue();
  const myCid = ws.connectionId;

  // 같은 connection 이 큐에 이미 있으면 status 재발송만 (FE bug / 재발송 보호).
  if (q.some((e) => e.connectionId === myCid)) {
    return send(ws, { type: 'queue_waiting' });
  }

  // 같은 clientId 의 좀비 큐 항목 정리 + 옛 entry 의 timer/sent 상태 상속.
  // (이슈 #5/#6, 그리고 비행기모드 reconnect: 옛 ws 가 close 안 됐는데 새 ws 가 reconnect 한 경우)
  let inheritedJoinedAt = null;
  let inheritedSentAt   = null;
  if (ws.clientId) {
    for (let i = q.length - 1; i >= 0; i--) {
      const e = q[i];
      if (e.connectionId !== myCid && e.clientId === ws.clientId) {
        q.splice(i, 1);
        clearBotOfferTimer(e);
        // 가장 마지막에 본 옛 entry 의 시각 정보 상속 (보통 1개).
        inheritedJoinedAt = e.joinedAt;
        if (e.botOfferSentAt) inheritedSentAt = e.botOfferSentAt;
        const staleWs = connections.getWsByConnectionId(e.connectionId);
        if (staleWs) {
          staleWs.inQueue = false;
          if (staleWs.readyState === staleWs.OPEN) {
            send(staleWs, { type: 'queue_canceled', reason: 'replaced' });
          }
        }
      }
    }
  }

  // 매칭 상대 찾기 — 다른 connection 이고 같은 clientId 가 아닌 항목
  const idx = q.findIndex((e) => {
    if (e.connectionId === myCid) return false;
    if (ws.clientId && e.clientId && e.clientId === ws.clientId) return false;
    const w = connections.getWsByConnectionId(e.connectionId);
    return w && w.readyState === w.OPEN;
  });

  const makeMyEntry = () => ({
    connectionId: myCid,
    clientId: ws.clientId || null,
    nickname: ws.nickname,
    joinedAt: inheritedJoinedAt || Date.now(),
    botOfferTimer: null,
    botOfferSentAt: inheritedSentAt,
  });

  if (idx >= 0) {
    const oppEntry = q.splice(idx, 1)[0];
    clearBotOfferTimer(oppEntry);
    const opponent = connections.getWsByConnectionId(oppEntry.connectionId);
    if (!opponent) {
      // opponent ws 가 race 로 사라진 경우 — re-enqueue self 로 fallback.
      const myEntry = makeMyEntry();
      enqueue(myEntry);
      ws.inQueue = true;
      scheduleBotOfferIfNeeded(myEntry);
      return send(ws, { type: 'queue_waiting' });
    }
    opponent.inQueue = false;
    const code = genCode();
    const room = createRoom(code);
    const blackNick = opponent.nickname || oppEntry.nickname || '익명';
    const whiteNick = ws.nickname;
    opponent.roomCode = code; opponent.color = 'black'; opponent.role = 'player';
    ws.roomCode = code; ws.color = 'white'; ws.role = 'player';
    setRoom(code, room);
    createPlayerSession(room, 'black', {
      type: 'human', ws: opponent, clientId: opponent.clientId || oppEntry.clientId || null, nickname: blackNick,
    });
    createPlayerSession(room, 'white', {
      type: 'human', ws, clientId: ws.clientId || null, nickname: whiteNick,
    });
    // 자동매칭 후에도 방 코드 부여 (관전자 모집용)
    send(opponent, { type: 'matched', code });
    send(ws,       { type: 'matched', code });
    log.event('queue_matched', { code, a: blackNick, b: whiteNick });
    // Lazy require — game.js depends on bot.js / queue.js indirectly.
    const { startGame } = require('./game');
    startGame(room);
  } else {
    const myEntry = makeMyEntry();
    enqueue(myEntry);
    ws.inQueue = true;
    send(ws, { type: 'queue_waiting' });
    // bot 제안 타이머: 옛 entry 가 이미 발송했었다면 다시 보내지 않음.
    //                  처음이면 joinedAt 기준 남은 시간만 대기.
    scheduleBotOfferIfNeeded(myEntry);
  }
};

const onQueueLeave = (ws) => {
  if (ws.connectionId) {
    const entry = dequeueByConnectionId(ws.connectionId);
    if (entry) clearBotOfferTimer(entry);
  }
  ws.inQueue = false;
};

const onBotOfferAccept = (ws, msg) => {
  // 큐에서 빠지고 봇 게임 생성으로 합류.
  onQueueLeave(ws);
  const { onCreateBotGame } = require('./bot');
  onCreateBotGame(ws, msg);
};

const onBotOfferDecline = (_ws) => {
  // 사용자가 봇 제안을 거절 — 큐는 그대로 유지. timer 는 이미 발화돼 fire 됐고,
  // entry.botOfferSentAt 도 세팅된 상태라 같은 entry 에 대해서 다시 발송되지 않음.
};

module.exports = {
  botOfferSentByClientId,
  BOT_OFFER_COOLDOWN_MS,
  scheduleBotOfferIfNeeded,
  clearBotOfferTimer,
  onQueueJoin,
  onQueueLeave,
  onBotOfferAccept,
  onBotOfferDecline,
};
