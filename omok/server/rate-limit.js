// ============================================================
// 액션별 rate limit — sliding window
// ============================================================
// 정상 플레이에서는 절대 안 걸리는 수준으로 설정한 안전망.
// move 는 게임 턴 로직이 이미 막아주지만(자기 차례 아닐 때 거부) 메시지 자체를
// 폭주시키는 케이스(자동화·악성 클라)에 대한 1차 차단으로 둔다.
// emote 는 handlers.js 에 800ms 쿨다운이 이미 있어 여기서는 제외.
//
// 키 우선순위 (이슈 #31 Phase 3):
//   1) clientId (브라우저 사용자 후보 단위) — primary. 새로고침해도 같은 키 유지.
//   2) sessionId (방 안 역할 단위) — clientId 가 없을 때 폴백.
//   3) connectionId (현재 ws 연결) — 둘 다 없을 때 최후의 폴백.
//
// 의도: 같은 사용자가 새로고침으로 한도를 우회하지 못하게 하는 것.
// 단, clientId 는 localStorage 기반이라 강한 보안 식별자는 아님. 클리어/조작
// 가능. 큰 남용에는 별도 IP rate-limit 또는 cloudflare 같은 layer 필요.

const POLICIES = {
  move:                { limit: 3, windowMs: 1000 },
  request_rooms_list:  { limit: 1, windowMs: 3000 },
  request_online_list: { limit: 1, windowMs: 5000 },
  create_room:         { limit: 3, windowMs: 10000 },
  join_room:           { limit: 5, windowMs: 10000 },
  queue_join:          { limit: 3, windowMs: 10000 },
  create_bot_game:     { limit: 3, windowMs: 10000 },
};

// bucketKey → { action: number[] } (window 안의 timestamp 들)
// 각 bucketKey 는 'c:CLIENTID' / 's:SESSIONID' / 'n:CONNECTIONID' prefix 로 namespace 분리.
const buckets = new Map();

const resolveKey = (identity) => {
  if (!identity) return null;
  if (identity.clientId) return 'c:' + identity.clientId;
  if (identity.sessionId) return 's:' + identity.sessionId;
  if (identity.connectionId) return 'n:' + identity.connectionId;
  return null;
};

// identity: { clientId, sessionId, connectionId } 중 하나 이상.
const checkRateLimit = (identity, action) => {
  const p = POLICIES[action];
  if (!p) return true;
  const key = resolveKey(identity);
  if (!key) return true;  // 모든 키가 없는 초기 윈도우 — 미체크 (set_nickname 이전 짧은 순간).
  let actions = buckets.get(key);
  if (!actions) {
    actions = {};
    buckets.set(key, actions);
  }
  const arr = actions[action] || (actions[action] = []);
  const cutoff = Date.now() - p.windowMs;
  while (arr.length && arr[0] < cutoff) arr.shift();
  if (arr.length >= p.limit) return false;
  arr.push(Date.now());
  return true;
};

// 연결 종료 시 호출 — 그 connection 의 bucket 만 정리.
// clientId 단위 bucket 은 다음 연결에서 이어 쓰므로 정리하지 않음
// (새로고침으로 한도 우회되는 동작 방지).
const clearForConnection = (connectionId) => {
  if (connectionId) buckets.delete('n:' + connectionId);
};

module.exports = { checkRateLimit, clearForConnection, POLICIES };
