// ============================================================
// 액션별 rate limit — per-ws sliding window
// ============================================================
// 정상 플레이에서는 절대 안 걸리는 수준으로 설정한 안전망.
// move 는 게임 턴 로직이 이미 막아주지만(자기 차례 아닐 때 거부) 메시지 자체를
// 폭주시키는 케이스(자동화·악성 클라)에 대한 1차 차단으로 둔다.
// emote 는 handlers.js 에 800ms 쿨다운이 이미 있어 여기서는 제외.

const POLICIES = {
  move:                { limit: 3, windowMs: 1000 },
  request_rooms_list:  { limit: 1, windowMs: 3000 },
  request_online_list: { limit: 1, windowMs: 5000 },
  create_room:         { limit: 3, windowMs: 10000 },
  join_room:           { limit: 5, windowMs: 10000 },
  queue_join:          { limit: 3, windowMs: 10000 },
  create_bot_game:     { limit: 3, windowMs: 10000 },
};

const checkRateLimit = (ws, action) => {
  const p = POLICIES[action];
  if (!p) return true;
  if (!ws._rl) ws._rl = {};
  const arr = ws._rl[action] || (ws._rl[action] = []);
  const cutoff = Date.now() - p.windowMs;
  while (arr.length && arr[0] < cutoff) arr.shift();
  if (arr.length >= p.limit) return false;
  arr.push(Date.now());
  return true;
};

module.exports = { checkRateLimit, POLICIES };
