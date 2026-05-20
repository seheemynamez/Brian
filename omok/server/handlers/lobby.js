// ============================================================
// 로비 — set_nickname / online_list / create_room.
// ============================================================

const {
  setRoom, sanitizeNick,
  genCode, createRoom, createPlayerSession,
} = require('../domain/rooms');
const connections = require('../connections');
const { send, broadcastOnlineCount, broadcastRoomsList } = require('./send');
const { getWss } = require('./state');
const { getTopRanking, getRecentGames, getMyRankEntry } = require('../domain/users');
const log = require('../infra/log');

// 로비에서 닉네임/clientId 동기화 — 방에 들어가기 전에도 온라인 목록 표시 + 랭킹용 식별자 확보.
const onSetNickname = (ws, msg) => {
  const next = sanitizeNick(msg.nickname);
  if (next) ws.nickname = next;
  // clientId 도 함께 받아서 ws 에 기록 — 추후 게임 결과 기록 시 안정 식별자로 사용.
  // 동시에 connection registry 에 등록 → 같은 clientId 의 멀티탭 추적 가능 (이슈 #31).
  if (typeof msg.clientId === 'string' && msg.clientId.length > 0 && msg.clientId.length <= 64) {
    const isNewBinding = !ws.clientId || ws.clientId !== msg.clientId;
    connections.bindClient(ws, msg.clientId);
    // 새 ws 가 같은 clientId 의 옛 좀비 연결과 합쳐졌을 수 있으니 unique count 재발송.
    // (비행기모드 reconnect 시 짧게 중복 카운팅 되던 증상 해소)
    if (isNewBinding) broadcastOnlineCount();
  }
};

// 접속자 닉네임 목록 — clientId 단위 dedupe (같은 브라우저의 멀티탭은 1명).
// clientId 가 없는 연결 (set_nickname 직전 짧은 윈도우) 은 닉네임 단위로 dedup.
// unique online count 와 동일한 기준으로 카운트/명단이 일치하도록.
const onRequestOnlineList = (ws) => {
  const wssRef = getWss();
  if (!wssRef) return;
  const byClient = new Map();    // clientId → 최신 nickname
  const noClient = new Set();    // clientId 없는 경우의 nickname 집합
  for (const c of wssRef.clients) {
    if (c.readyState !== c.OPEN) continue;
    if (!c.nickname) continue;
    if (c.clientId) {
      byClient.set(c.clientId, c.nickname);  // 같은 clientId 의 마지막 탭의 nickname 으로 갱신
    } else {
      noClient.add(c.nickname);
    }
  }
  // unique 단위는 clientId. 같은 nickname 의 다른 clientId 는 별개 사용자 — list 에 둘 다 노출.
  // (이전엔 new Set(nicknames) 로 한 번 더 nickname dedup 했지만, 그건 닉네임 같다는 이유로
  //  다른 사용자를 한 명으로 합쳐버려 잘못. count 와 list 의 unique 기준이 둘 다 clientId.)
  // byClient 는 이미 clientId 단위 unique. noClient (clientId 없는 짧은 윈도우) 는 nickname Set
  // 이라 자체적으로 nickname dedup 된 상태 — 그대로 합쳐서 list.
  const nicknames = [...byClient.values(), ...noClient];
  nicknames.sort((a, b) => a.localeCompare(b, 'ko'));
  send(ws, { type: 'online_list', nicknames });
};

const onCreateRoom = (ws, msg) => {
  if (ws.roomCode) return send(ws, { type: 'error', message: '이미 방에 있어요' });
  const { onQueueLeave } = require('./queue');
  onQueueLeave(ws);
  const code = genCode();
  // visibility: 'public' (default — 로비 노출 + 랜덤 매칭 대상) | 'private' (코드/링크로만)
  const visibility = msg.visibility === 'private' ? 'private' : 'public';
  const room = createRoom(code, visibility);
  const nickname = sanitizeNick(msg.nickname) || '익명';
  ws.roomCode = code;
  ws.color = 'black';
  ws.role = 'player';
  ws.nickname = nickname;
  setRoom(code, room);
  // 방장에게도 sessionId 부여 — 대기 중 끊김 발생 시 resume_session 으로 복구 가능하게 함 (이슈 #9)
  const slot = createPlayerSession(room, 'black', {
    type: 'human', ws, clientId: ws.clientId || null, nickname,
  });
  send(ws, { type: 'room_created', code, sessionId: slot.sessionId, visibility });
  log.event('room_created', { code, by: nickname, visibility });

  // 공개 방 만든 직후 큐에 대기자가 있으면 그 사람과 즉시 매칭.
  // (반대 흐름: 큐 → 방 만들기. 사용자가 "랜덤 매칭" 누른 뒤 다른 사람이 방 만들면 자동 매칭).
  if (visibility === 'public') {
    const { tryMatchWaiterIntoNewRoom } = require('./queue');
    const matched = tryMatchWaiterIntoNewRoom(room, ws);
    // 매칭 됐으면 startGame 안에서 자체적으로 broadcastRoomsList 호출됨.
    if (matched) return;
  }
  broadcastRoomsList();
};

// 홈 진입 시 1회 요청 — 상위 N명 rating 순 + 본인 entry/순위.
// me 가 null 이면 미등록 (첫 게임 안 한 사용자).
const onRequestRanking = (ws, msg) => {
  const limit = Math.min(50, Number(msg && msg.limit) || 10);
  send(ws, {
    type: 'ranking_list',
    entries: getTopRanking(limit),
    me: getMyRankEntry(ws.clientId),
  });
};

// 홈 진입 시 1회 요청 — 최근 N개 게임 결과 (최신 먼저).
const onRequestRecentGames = (ws, msg) => {
  const limit = Math.min(50, Number(msg && msg.limit) || 10);
  send(ws, { type: 'recent_games_list', entries: getRecentGames(limit) });
};

module.exports = {
  onSetNickname, onRequestOnlineList, onCreateRoom,
  onRequestRanking, onRequestRecentGames,
};
