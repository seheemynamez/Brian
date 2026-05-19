// ============================================================
// Room runtime state — JSON 직렬화 불가능한 transient 객체들.
// (timer handle, worker promise 등). Valkey 이전 시 이쪽은 저장 안 함.
// ============================================================
// 이슈 #31 Phase 5: room state (rooms.js) 는 board/turn/players 같은 도메인
// 데이터만 갖고, 이쪽 runtime registry 에는 setTimeout handle 등이 들어감.
//
// 키: roomCode. 값: { turnTimer, botMoveTimer, botOfferTimer } (모두 null 가능).
//
// 서버 재시작 시 room 도메인 state 만 store 에서 복구하고, timer 는 turnDeadline
// 같은 timestamp 를 보고 새로 등록.

const runtimeByRoomCode = new Map();

const get = (code) => {
  if (!code) return null;
  let entry = runtimeByRoomCode.get(code);
  if (!entry) {
    entry = { turnTimer: null, botMoveTimer: null, botOfferTimer: null };
    runtimeByRoomCode.set(code, entry);
  }
  return entry;
};

const peek = (code) => (code ? runtimeByRoomCode.get(code) : null);

const setTimer = (code, name, handle) => {
  const entry = get(code);
  const old = entry[name];
  if (old) clearTimeout(old);
  entry[name] = handle;
};

const clearTimer = (code, name) => {
  const entry = runtimeByRoomCode.get(code);
  if (!entry) return;
  if (entry[name]) {
    clearTimeout(entry[name]);
    entry[name] = null;
  }
};

const clearAllTimers = (code) => {
  const entry = runtimeByRoomCode.get(code);
  if (!entry) return;
  for (const k of Object.keys(entry)) {
    if (entry[k]) { clearTimeout(entry[k]); entry[k] = null; }
  }
};

// 방 폐쇄 시 호출 — 타이머 정리 + 레지스트리 entry 제거.
const dispose = (code) => {
  clearAllTimers(code);
  runtimeByRoomCode.delete(code);
};

// 색깔별 disconnect timer 는 별도 Map (다른 모양이라 어색해 분리).
const disconnectTimers = new Map();  // roomCode → { black, white }

const getDisconnectEntry = (code) => {
  let entry = disconnectTimers.get(code);
  if (!entry) {
    entry = { black: null, white: null };
    disconnectTimers.set(code, entry);
  }
  return entry;
};

const setDisconnectTimer = (code, color, handle) => {
  const entry = getDisconnectEntry(code);
  if (entry[color]) clearTimeout(entry[color]);
  entry[color] = handle;
};

const clearDisconnectTimer = (code, color) => {
  const entry = disconnectTimers.get(code);
  if (!entry) return;
  if (entry[color]) { clearTimeout(entry[color]); entry[color] = null; }
};

const clearAllDisconnectTimers = (code) => {
  const entry = disconnectTimers.get(code);
  if (!entry) return;
  for (const c of ['black', 'white']) {
    if (entry[c]) { clearTimeout(entry[c]); entry[c] = null; }
  }
  disconnectTimers.delete(code);
};

module.exports = {
  // 일반 timer
  setTimer, clearTimer, clearAllTimers, dispose, peek,
  // disconnect timer (color-keyed)
  setDisconnectTimer, clearDisconnectTimer, clearAllDisconnectTimers, getDisconnectEntry,
};
