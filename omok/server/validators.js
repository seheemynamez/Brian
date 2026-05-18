// ============================================================
// 클라이언트→서버 메시지 schema 검증
// ============================================================
// 잘못된 payload(타입 오류, 과도한 길이, 정수 아닌 좌표 등)가 핸들러까지
// 도달하지 않도록 1차 게이트 역할을 한다. 화이트리스트(emote key, difficulty 값,
// 게임 룰 등) 비즈니스 검증은 handlers.js 에 그대로 두고, 여기서는 형식·범위만 본다.

const { BOARD_SIZE } = require('./game-logic');

const NICK_MAX = 24;
const ID_MAX = 64;
const SHORT_ENUM_MAX = 16;
const EMOTE_KEY_MAX = 32;
const ROOM_CODE_RE = /^[A-Z0-9]{4}$/i;

const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const isOptStr = (v, max) =>
  v === undefined || v === null || (typeof v === 'string' && v.length <= max);
const isInt0to = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;

const ok = { ok: true };
const fail = (reason) => ({ ok: false, reason });

const validateCode = (v) => isStr(v, 16) && ROOM_CODE_RE.test(v.trim());

const validators = {
  create_room: (m) => (isOptStr(m.nickname, NICK_MAX) ? ok : fail('nickname')),
  join_room: (m) => {
    if (!validateCode(m.code)) return fail('code');
    if (!isOptStr(m.nickname, NICK_MAX)) return fail('nickname');
    return ok;
  },
  spectate_room: (m) => {
    if (!validateCode(m.code)) return fail('code');
    if (!isOptStr(m.nickname, NICK_MAX)) return fail('nickname');
    return ok;
  },
  queue_join: (m) => {
    if (!isOptStr(m.nickname, NICK_MAX)) return fail('nickname');
    if (!isOptStr(m.clientId, ID_MAX)) return fail('clientId');
    return ok;
  },
  queue_leave: () => ok,
  resume_session: (m) => {
    if (!isStr(m.sessionId, ID_MAX)) return fail('sessionId');
    if (!isOptStr(m.nickname, NICK_MAX)) return fail('nickname');
    return ok;
  },
  move: (m) => {
    if (!isInt0to(m.row, BOARD_SIZE - 1)) return fail('row');
    if (!isInt0to(m.col, BOARD_SIZE - 1)) return fail('col');
    return ok;
  },
  rematch: () => ok,
  leave_room: () => ok,
  emote: (m) => (isStr(m.key, EMOTE_KEY_MAX) ? ok : fail('key')),
  set_nickname: (m) => {
    if (!isOptStr(m.nickname, NICK_MAX)) return fail('nickname');
    if (!isOptStr(m.clientId, ID_MAX)) return fail('clientId');
    return ok;
  },
  create_bot_game: (m) => {
    if (!isOptStr(m.nickname, NICK_MAX)) return fail('nickname');
    if (!isOptStr(m.difficulty, SHORT_ENUM_MAX)) return fail('difficulty');
    if (!isOptStr(m.first, SHORT_ENUM_MAX)) return fail('first');
    return ok;
  },
  bot_offer_accept: (m) => {
    if (!isOptStr(m.difficulty, SHORT_ENUM_MAX)) return fail('difficulty');
    if (!isOptStr(m.first, SHORT_ENUM_MAX)) return fail('first');
    return ok;
  },
  bot_offer_decline: () => ok,
  request_rooms_list: () => ok,
  request_online_list: () => ok,
};

const validateMessage = (msg) => {
  if (!msg || typeof msg.type !== 'string') return fail('type');
  const fn = validators[msg.type];
  if (!fn) return fail('unknown_type');
  return fn(msg);
};

// JSON.parse 전에 raw payload 크기를 자르는 게이트.
// 정상 메시지는 모두 수백 바이트 안쪽 — 4KB 면 충분히 여유.
const MAX_MESSAGE_BYTES = 4096;

module.exports = { validateMessage, MAX_MESSAGE_BYTES };
