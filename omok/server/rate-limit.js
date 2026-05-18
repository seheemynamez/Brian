// ============================================================
// 액션별 rate limit — per-connection sliding window
// ============================================================
// 정상 플레이에서는 절대 안 걸리는 수준으로 설정한 안전망.
// move 는 게임 턴 로직이 이미 막아주지만(자기 차례 아닐 때 거부) 메시지 자체를
// 폭주시키는 케이스(자동화·악성 클라)에 대한 1차 차단으로 둔다.
// emote 는 handlers.js 에 800ms 쿨다운이 이미 있어 여기서는 제외.
//
// 이슈 #31: state 는 connectionId 로 keyed. ws 객체에 _rl 을 매달지 않음.
// 연결이 끊기면 server.js 의 close 핸들러가 clearForConnection 으로 정리.

const POLICIES = {
  move:                { limit: 3, windowMs: 1000 },
  request_rooms_list:  { limit: 1, windowMs: 3000 },
  request_online_list: { limit: 1, windowMs: 5000 },
  create_room:         { limit: 3, windowMs: 10000 },
  join_room:           { limit: 5, windowMs: 10000 },
  queue_join:          { limit: 3, windowMs: 10000 },
  create_bot_game:     { limit: 3, windowMs: 10000 },
};

// connectionId → { action: number[] } (window 안의 timestamp 들)
const buckets = new Map();

const checkRateLimit = (connectionId, action) => {
  const p = POLICIES[action];
  if (!p) return true;
  if (!connectionId) return true;  // 방어적 — register 전엔 미체크
  let actions = buckets.get(connectionId);
  if (!actions) {
    actions = {};
    buckets.set(connectionId, actions);
  }
  const arr = actions[action] || (actions[action] = []);
  const cutoff = Date.now() - p.windowMs;
  while (arr.length && arr[0] < cutoff) arr.shift();
  if (arr.length >= p.limit) return false;
  arr.push(Date.now());
  return true;
};

// 연결 종료 시 호출 — 그 connection 의 모든 rate-limit state 정리.
const clearForConnection = (connectionId) => {
  if (connectionId) buckets.delete(connectionId);
};

module.exports = { checkRateLimit, clearForConnection, POLICIES };
