// ============================================================
// E2E session/disconnect/recovery + 비행기모드 reconnect 시나리오 테스트.
// 외부에서 띄운 omok 서버에 WS 로 붙어 메시지 교환을 검증.
// 실행 전제:
//   BOT_OFFER_DELAY_MS=1000 DISCONNECT_GRACE_MS=1500 PORT=18080 node server.js
// ============================================================
//
// 카테고리:
//   T1-T16  핵심 disconnect/resume 시나리오
//   R1-R17  latent risk probes
//   P1-P4   PR#2 신규 코드 경로 (ID 기반)
//   A1-A3   비행기모드 unique online count
//   B1-B4   비행기모드 bot offer dedup
// ============================================================

const WebSocket = require('ws');

const URL = 'ws://localhost:18080/ws';
const GRACE = Number(process.env.DISCONNECT_GRACE_MS) || 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const open = () => new Promise((resolve, reject) => {
  const ws = new WebSocket(URL);
  ws.received = [];
  ws.on('message', (raw) => {
    try { ws.received.push(JSON.parse(raw.toString())); } catch {}
  });
  ws.on('open', () => resolve(ws));
  ws.on('error', reject);
});

const sendJson = (ws, msg) => ws.send(JSON.stringify(msg));

const waitFor = async (ws, predicate, timeoutMs = 3000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = ws.received.find(predicate);
    if (found) return found;
    await sleep(20);
  }
  throw new Error(`waitFor timeout (${timeoutMs}ms). Last few: ${JSON.stringify(ws.received.slice(-3))}`);
};
const waitForType = (ws, type, timeoutMs) => waitFor(ws, (m) => m.type === type, timeoutMs);
const assert = (cond, msg) => { if (!cond) throw new Error(`ASSERT FAILED: ${msg}`); };

// 비행기모드 모방 — 옛 ws 를 close 하지 않고 그대로 둔다 (서버 입장에선 좀비).
// _socket.destroy() 는 TCP RST 를 즉시 보내 close 가 정상적으로 fire → 좀비 시뮬레이션 안 됨.
const simulateAirplaneZombie = (_ws) => {};

// PlayerIds payload 비교 — array (legacy) 든 object (PR#1 후) 든 같은 의미면 통과.
// 단일 색만 검사: getPidForColor(playerIds, 'black')
const getPidForColor = (playerIds, color) => {
  if (!playerIds) return null;
  if (Array.isArray(playerIds)) return playerIds[color === 'black' ? 0 : 1];
  return playerIds[color];
};

// startGame 이 발급하는 새 sessionId 를 사용해야 resume 가능 (room_created sid 는 drop 됨).
const bootstrapRoom = async ({ hostNick = 'Host', hostClientId = 'host-cid', guestNick = 'Guest', guestClientId = 'guest-cid' } = {}) => {
  const host = await open();
  sendJson(host, { type: 'set_nickname', nickname: hostNick, clientId: hostClientId });
  sendJson(host, { type: 'create_room', nickname: hostNick });
  const created = await waitForType(host, 'room_created');
  const code = created.code;

  const guest = await open();
  sendJson(guest, { type: 'set_nickname', nickname: guestNick, clientId: guestClientId });
  sendJson(guest, { type: 'join_room', code, nickname: guestNick });
  const guestStart = await waitForType(guest, 'game_start');
  const guestSid = guestStart.sessionId;
  const hostStart = await waitForType(host, 'game_start');
  const hostSid = hostStart.sessionId;
  return { host, guest, code, hostSid, guestSid, gameId: hostStart.gameId };
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ============================================================
// T 시나리오 — 핵심 disconnect / resume
// ============================================================

test('T1: waiting disconnect + resume to waiting screen', async () => {
  const host = await open();
  sendJson(host, { type: 'set_nickname', nickname: 'H', clientId: 'cid-T1' });
  sendJson(host, { type: 'create_room', nickname: 'H' });
  const created = await waitForType(host, 'room_created');
  const sid = created.sessionId;
  host.close();
  await sleep(200);
  const host2 = await open();
  sendJson(host2, { type: 'resume_session', sessionId: sid, nickname: 'H' });
  const ok = await waitForType(host2, 'resume_success');
  assert(ok.code === created.code, 'resumed to same room');
  assert(ok.status === 'waiting', `expected waiting, got ${ok.status}`);
  host2.close();
});

test('T2: playing disconnect → opponent_disconnected → resume → opponent_reconnected', async () => {
  const { host, guest, code, hostSid } = await bootstrapRoom({ hostClientId: 'cid-T2a', guestClientId: 'cid-T2b' });
  host.close();
  await waitFor(guest, (m) => m.type === 'opponent_disconnected' && m.color === 'black', 1000);
  await sleep(300);
  const host2 = await open();
  sendJson(host2, { type: 'resume_session', sessionId: hostSid, nickname: 'H' });
  const ok = await waitForType(host2, 'resume_success');
  assert(ok.status === 'playing', `expected playing, got ${ok.status}`);
  assert(ok.code === code);
  await waitFor(guest, (m) => m.type === 'opponent_reconnected' && m.color === 'black', 1000);
  host2.close(); guest.close();
});

test('T3: grace expires → opponent_abandoned has gameId', async () => {
  const { host, guest, gameId } = await bootstrapRoom({ hostClientId: 'cid-T3a', guestClientId: 'cid-T3b' });
  host.close();
  const abandoned = await waitFor(guest, (m) => m.type === 'opponent_abandoned', GRACE + 1500);
  assert(abandoned.color === 'black');
  assert(abandoned.gameId === gameId);
  guest.close();
});

test('T4: over-state disconnect + resume preserves gameId & winner', async () => {
  const { host, guest, hostSid, gameId } = await bootstrapRoom({ hostClientId: 'cid-T4a', guestClientId: 'cid-T4b' });
  // 흑 5목 — Renju 금수 회피 + 380ms sleep (move rate-limit 3/sec 회피)
  const moves = [
    { p: 'h', r: 7, c: 7 }, { p: 'g', r: 0, c: 0 },
    { p: 'h', r: 7, c: 8 }, { p: 'g', r: 0, c: 1 },
    { p: 'h', r: 7, c: 10 }, { p: 'g', r: 0, c: 2 },
    { p: 'h', r: 7, c: 11 }, { p: 'g', r: 0, c: 3 },
    { p: 'h', r: 7, c: 9 },
  ];
  for (const m of moves) {
    sendJson(m.p === 'h' ? host : guest, { type: 'move', row: m.r, col: m.c });
    await sleep(380);
  }
  const gameOver = await waitFor(host, (m) => m.type === 'game_over' && m.winner === 'black', 2000);
  assert(gameOver.gameId === gameId);
  host.close();
  await sleep(200);
  const host2 = await open();
  sendJson(host2, { type: 'resume_session', sessionId: hostSid, nickname: 'H' });
  const ok = await waitForType(host2, 'resume_success');
  assert(ok.status === 'over', `expected over, got ${ok.status}`);
  assert(ok.winner === 'black');
  assert(ok.gameId === gameId);
  host2.close(); guest.close();
});

test('T5: spectator disconnect → list updated immediately', async () => {
  const host = await open();
  sendJson(host, { type: 'set_nickname', nickname: 'H', clientId: 'cid-T5h' });
  sendJson(host, { type: 'create_room', nickname: 'H' });
  const { code } = await waitForType(host, 'room_created');
  const spec = await open();
  sendJson(spec, { type: 'set_nickname', nickname: 'Spec', clientId: 'cid-T5s' });
  sendJson(spec, { type: 'spectate_room', code, nickname: 'Spec' });
  await waitForType(spec, 'spectate_success');
  await waitFor(host, (m) => m.type === 'spectator_list' && m.spectators.includes('Spec'), 1000);
  spec.close();
  await waitFor(host, (m) => m.type === 'spectator_list' && m.spectators.length === 0, 1000);
  host.close();
});

test('T6: spectator dedup → old ws receives spectator_replaced', async () => {
  const host = await open();
  sendJson(host, { type: 'set_nickname', nickname: 'H', clientId: 'cid-T6h' });
  sendJson(host, { type: 'create_room', nickname: 'H' });
  const { code } = await waitForType(host, 'room_created');
  const wsX = await open();
  sendJson(wsX, { type: 'set_nickname', nickname: 'SpecX', clientId: 'SHARED-T6' });
  sendJson(wsX, { type: 'spectate_room', code, nickname: 'SpecX' });
  await waitForType(wsX, 'spectate_success');
  const wsY = await open();
  sendJson(wsY, { type: 'set_nickname', nickname: 'SpecY', clientId: 'SHARED-T6' });
  sendJson(wsY, { type: 'spectate_room', code, nickname: 'SpecY' });
  const yOk = await waitForType(wsY, 'spectate_success');
  assert(yOk.spectators.length === 1 && yOk.spectators[0] === 'SpecY', `expected only SpecY, got ${JSON.stringify(yOk.spectators)}`);
  await waitForType(wsX, 'spectator_replaced');
  host.close(); wsX.close(); wsY.close();
});

test('T7: spectator dedup across rooms → old room list updated', async () => {
  const h1 = await open();
  sendJson(h1, { type: 'set_nickname', nickname: 'H1', clientId: 'cid-T7h1' });
  sendJson(h1, { type: 'create_room', nickname: 'H1' });
  const room1 = await waitForType(h1, 'room_created');
  const h2 = await open();
  sendJson(h2, { type: 'set_nickname', nickname: 'H2', clientId: 'cid-T7h2' });
  sendJson(h2, { type: 'create_room', nickname: 'H2' });
  const room2 = await waitForType(h2, 'room_created');
  const spec = await open();
  sendJson(spec, { type: 'set_nickname', nickname: 'Spec', clientId: 'CROSS-T7' });
  sendJson(spec, { type: 'spectate_room', code: room1.code, nickname: 'Spec' });
  await waitForType(spec, 'spectate_success');
  await waitFor(h1, (m) => m.type === 'spectator_list' && m.spectators.includes('Spec'), 1000);
  const spec2 = await open();
  sendJson(spec2, { type: 'set_nickname', nickname: 'Spec2', clientId: 'CROSS-T7' });
  sendJson(spec2, { type: 'spectate_room', code: room2.code, nickname: 'Spec2' });
  await waitForType(spec2, 'spectate_success');
  await waitFor(h1, (m) => m.type === 'spectator_list' && m.spectators.length === 0, 1500);
  await waitFor(h2, (m) => m.type === 'spectator_list' && m.spectators.includes('Spec2'), 1500);
  h1.close(); h2.close(); spec.close(); spec2.close();
});

test('T8: queue_join dedup → first ws receives queue_canceled', async () => {
  const wsA = await open();
  sendJson(wsA, { type: 'queue_join', nickname: 'A', clientId: 'queue-cid-T8' });
  await waitForType(wsA, 'queue_waiting');
  const wsB = await open();
  sendJson(wsB, { type: 'queue_join', nickname: 'B', clientId: 'queue-cid-T8' });
  await waitFor(wsA, (m) => m.type === 'queue_canceled', 1500);
  await waitForType(wsB, 'queue_waiting');
  wsA.close(); wsB.close();
});

test('T9: bot game player disconnect → grace, room gone after grace expires', async () => {
  const ws = await open();
  sendJson(ws, { type: 'set_nickname', nickname: 'Me-T9', clientId: 'cid-T9' });
  sendJson(ws, { type: 'create_bot_game', difficulty: 'easy', first: 'me', nickname: 'Me-T9' });
  await waitForType(ws, 'game_start');
  ws.close();
  // grace 안 — 방 아직 존재
  await sleep(200);
  // grace 만료 + 여유 후 — 방 사라짐
  await sleep(GRACE + 500);
  const observer = await open();
  sendJson(observer, { type: 'request_rooms_list' });
  const list = await waitForType(observer, 'rooms_list');
  const lingering = list.rooms.filter((r) => r.nicknames.black === 'Me-T9' || r.nicknames.white === 'Me-T9');
  assert(lingering.length === 0, `bot room should be gone after grace: ${JSON.stringify(lingering)}`);
  observer.close();
});

test('T9b: bot game 끊김 + grace 안에 resume → 게임 이어짐', async () => {
  const ws = await open();
  sendJson(ws, { type: 'set_nickname', nickname: 'Me-T9b', clientId: 'cid-T9b' });
  sendJson(ws, { type: 'create_bot_game', difficulty: 'easy', first: 'me', nickname: 'Me-T9b' });
  const start = await waitForType(ws, 'game_start');
  const sid = start.sessionId;
  const code = start.code;
  ws.close();
  await sleep(300);
  // grace 안에 resume
  const ws2 = await open();
  sendJson(ws2, { type: 'resume_session', sessionId: sid, nickname: 'Me-T9b' });
  const ok = await waitForType(ws2, 'resume_success', 1500);
  assert(ok.status === 'playing', `expected playing, got ${ok.status}`);
  assert(ok.code === code);
  // 봇이 흑(선공) 이면 봇 차례 → scheduleBotMove 가 재개됨. 잠시 후 move 들어와야.
  if (ok.turn === 'white') {
    // 봇이 흑이고 사용자 차례 (white). 사용자가 둬보기 — 봇 응수 와야.
    sendJson(ws2, { type: 'move', row: 7, col: 7 });
    await waitFor(ws2, (m) => m.type === 'move' && m.color === 'black', 5000);
  } else {
    // 봇이 백이고 사용자 차례 (black). 사용자가 둬보기 — 봇 응수 와야.
    sendJson(ws2, { type: 'move', row: 7, col: 7 });
    await waitFor(ws2, (m) => m.type === 'move' && m.color === 'white', 5000);
  }
  ws2.close();
});

test('T10: resume_session with random sid → resume_failed', async () => {
  const ws = await open();
  sendJson(ws, { type: 'resume_session', sessionId: 'nonexistent-sid-xxxxxxxxxxxxxxx' });
  const fail = await waitForType(ws, 'resume_failed');
  assert(fail.reason === 'not_found');
  ws.close();
});

test('T11: resume after room deleted → resume_failed', async () => {
  const host = await open();
  sendJson(host, { type: 'set_nickname', nickname: 'H', clientId: 'cid-T11' });
  sendJson(host, { type: 'create_room', nickname: 'H' });
  const created = await waitForType(host, 'room_created');
  const sid = created.sessionId;
  sendJson(host, { type: 'leave_room' });
  await sleep(300);
  host.close();
  const ws = await open();
  sendJson(ws, { type: 'resume_session', sessionId: sid, nickname: 'H' });
  const fail = await waitForType(ws, 'resume_failed');
  assert(fail.reason === 'not_found' || fail.reason === 'invalid_session');
  ws.close();
});

test('T12: both players disconnect simultaneously', async () => {
  const { host, guest, hostSid, guestSid } = await bootstrapRoom({ hostClientId: 'cid-T12a', guestClientId: 'cid-T12b' });
  host.close(); guest.close();
  await sleep(GRACE + 800);
  const ws = await open();
  sendJson(ws, { type: 'resume_session', sessionId: hostSid });
  await waitForType(ws, 'resume_failed');
  ws.close();
  const ws2 = await open();
  sendJson(ws2, { type: 'resume_session', sessionId: guestSid });
  await waitForType(ws2, 'resume_failed');
  ws2.close();
});

test('T13: leave_room while playing → opponent gets game_over+gameId+reason', async () => {
  const { host, guest, gameId } = await bootstrapRoom({ hostClientId: 'cid-T13a', guestClientId: 'cid-T13b' });
  sendJson(host, { type: 'leave_room' });
  const go = await waitFor(guest, (m) => m.type === 'game_over' && m.reason === 'opponent_left', 1500);
  assert(go.winner === 'white');
  assert(go.gameId === gameId);
  host.close(); guest.close();
});

test('T14: resume_session while already in room → ignored', async () => {
  const { host, hostSid } = await bootstrapRoom({ hostClientId: 'cid-T14a', guestClientId: 'cid-T14b' });
  host.received.length = 0;
  sendJson(host, { type: 'resume_session', sessionId: hostSid });
  await sleep(400);
  const replies = host.received.filter((m) => m.type === 'resume_success' || m.type === 'resume_failed');
  assert(replies.length === 0, `expected no resume_* reply`);
  host.close();
});

test('T15: resume cancels grace timer; finalizeAbandon does not double-fire', async () => {
  const { host, guest, hostSid } = await bootstrapRoom({ hostClientId: 'cid-T15a', guestClientId: 'cid-T15b' });
  host.close();
  await sleep(200);
  const host2 = await open();
  sendJson(host2, { type: 'resume_session', sessionId: hostSid, nickname: 'H' });
  await waitForType(host2, 'resume_success');
  guest.received.length = 0;
  await sleep(GRACE + 500);
  const stray = guest.received.find((m) => m.type === 'opponent_abandoned');
  assert(!stray, `unexpected opponent_abandoned`);
  host2.close(); guest.close();
});

test('T16: app-level ping receives pong', async () => {
  const ws = await open();
  sendJson(ws, { type: 'ping' });
  const pong = await waitForType(ws, 'pong', 1000);
  assert(pong);
  ws.close();
});

// ============================================================
// R 시나리오 — latent risk probes
// ============================================================

test('R1: spectator dedup when old room already deleted', async () => {
  const h1 = await open();
  sendJson(h1, { type: 'set_nickname', nickname: 'H1', clientId: 'cid-R1h1' });
  sendJson(h1, { type: 'create_room', nickname: 'H1' });
  const room1 = await waitForType(h1, 'room_created');
  const spec = await open();
  sendJson(spec, { type: 'set_nickname', nickname: 'Spec', clientId: 'SHARED-R1' });
  sendJson(spec, { type: 'spectate_room', code: room1.code, nickname: 'Spec' });
  await waitForType(spec, 'spectate_success');
  sendJson(h1, { type: 'leave_room' });
  await waitForType(spec, 'opponent_left');
  const h2 = await open();
  sendJson(h2, { type: 'set_nickname', nickname: 'H2', clientId: 'cid-R1h2' });
  sendJson(h2, { type: 'create_room', nickname: 'H2' });
  const room2 = await waitForType(h2, 'room_created');
  const spec2 = await open();
  sendJson(spec2, { type: 'set_nickname', nickname: 'Spec2', clientId: 'SHARED-R1' });
  sendJson(spec2, { type: 'spectate_room', code: room2.code, nickname: 'Spec2' });
  const ok = await waitForType(spec2, 'spectate_success');
  assert(ok.code === room2.code);
  h2.close(); spec.close(); spec2.close();
});

test('R2: invalid sid graceful', async () => {
  const ws = await open();
  sendJson(ws, { type: 'resume_session', sessionId: 'abcdefghijklmnop', nickname: 'X' });
  const fail = await waitForType(ws, 'resume_failed', 1000);
  assert(fail.reason === 'not_found' || fail.reason === 'invalid_session');
  ws.close();
});

test('R3: resume binds new ws as active for sessionId', async () => {
  const { host, guest, hostSid } = await bootstrapRoom({ hostClientId: 'cid-R3a', guestClientId: 'cid-R3b' });
  host.close();
  const host2 = await open();
  sendJson(host2, { type: 'resume_session', sessionId: hostSid, nickname: 'H' });
  const ok = await waitForType(host2, 'resume_success');
  assert(ok.status === 'playing');
  sendJson(host2, { type: 'move', row: 7, col: 7 });
  const moved = await waitFor(guest, (m) => m.type === 'move' && m.row === 7 && m.col === 7, 1500);
  assert(moved.color === 'black');
  host2.close(); guest.close();
});

test('R4: bot game disconnect → recreate within 200ms', async () => {
  const ws = await open();
  sendJson(ws, { type: 'set_nickname', nickname: 'Me', clientId: 'cid-R4' });
  sendJson(ws, { type: 'create_bot_game', difficulty: 'easy', first: 'me', nickname: 'Me' });
  await waitForType(ws, 'game_start');
  ws.close();
  await sleep(50);
  const ws2 = await open();
  sendJson(ws2, { type: 'set_nickname', nickname: 'Me', clientId: 'cid-R4' });
  sendJson(ws2, { type: 'create_bot_game', difficulty: 'easy', first: 'me', nickname: 'Me' });
  const start = await waitForType(ws2, 'game_start', 2000);
  assert(start.code);
  ws2.close();
});

test('R6: session survives ws.close; resume via fresh ws works', async () => {
  const host = await open();
  sendJson(host, { type: 'set_nickname', nickname: 'H', clientId: 'cid-R6' });
  sendJson(host, { type: 'create_room', nickname: 'H' });
  const created = await waitForType(host, 'room_created');
  host.close();
  await sleep(100);
  const wsNew = await open();
  sendJson(wsNew, { type: 'set_nickname', nickname: 'H2', clientId: 'cid-R6-different' });
  sendJson(wsNew, { type: 'resume_session', sessionId: created.sessionId, nickname: 'H2' });
  const ok = await waitForType(wsNew, 'resume_success');
  assert(ok.status === 'waiting');
  wsNew.close();
});

test('R8: double leave_room is idempotent', async () => {
  const { host, guest } = await bootstrapRoom({ hostClientId: 'cid-R8a', guestClientId: 'cid-R8b' });
  sendJson(host, { type: 'leave_room' });
  await waitFor(guest, (m) => m.type === 'game_over', 1500);
  host.received.length = 0;
  sendJson(host, { type: 'leave_room' });
  await sleep(200);
  const errs = host.received.filter((m) => m.type === 'error');
  assert(errs.length === 0);
  host.close(); guest.close();
});

test('R9: oversized nickname rejected at schema', async () => {
  const host = await open();
  sendJson(host, { type: 'set_nickname', nickname: 'x'.repeat(50), clientId: 'cid-R9' });
  sendJson(host, { type: 'create_room', nickname: 'x'.repeat(50) });
  await sleep(400);
  const created = host.received.find((m) => m.type === 'room_created');
  assert(!created);
  host.close();
});

test('R10: 12-char nickname survives sanitize + resume', async () => {
  const nick = 'abcdefghijkl';
  const host = await open();
  sendJson(host, { type: 'set_nickname', nickname: nick, clientId: 'cid-R10' });
  sendJson(host, { type: 'create_room', nickname: nick });
  const created = await waitForType(host, 'room_created');
  host.close();
  await sleep(100);
  const wsNew = await open();
  sendJson(wsNew, { type: 'resume_session', sessionId: created.sessionId });
  const ok = await waitForType(wsNew, 'resume_success');
  assert(ok.nicknames.black === nick);
  wsNew.close();
});

test('R11: connected ws without state survives 500ms', async () => {
  const ws = await open();
  await sleep(500);
  assert(ws.readyState === ws.OPEN);
  ws.close();
});

test('R12: queue_leave cancels bot offer timer', async () => {
  const ws = await open();
  sendJson(ws, { type: 'queue_join', nickname: 'A', clientId: 'cid-R12' });
  await waitForType(ws, 'queue_waiting');
  sendJson(ws, { type: 'queue_leave' });
  await sleep(1500);
  const offers = ws.received.filter((m) => m.type === 'bot_offer');
  assert(offers.length === 0);
  ws.close();
});

test('R13: bot offer accepted → game start with gameId + sessionId', async () => {
  const ws = await open();
  sendJson(ws, { type: 'set_nickname', nickname: 'Me', clientId: 'cid-R13' });
  sendJson(ws, { type: 'bot_offer_accept', difficulty: 'easy', first: 'me', nickname: 'Me' });
  const start = await waitForType(ws, 'game_start', 2000);
  assert(start.gameId && start.gameId.length >= 10);
  assert(start.sessionId);
  ws.close();
});

test('R14: resume with new nickname updates room nickname', async () => {
  const { host, hostSid } = await bootstrapRoom({ hostClientId: 'cid-R14a', guestClientId: 'cid-R14b' });
  host.close();
  await sleep(100);
  const wsNew = await open();
  sendJson(wsNew, { type: 'resume_session', sessionId: hostSid, nickname: '새닉' });
  const ok = await waitForType(wsNew, 'resume_success');
  assert(ok.nicknames.black === '새닉');
  wsNew.close();
});

test('R15: spectator joining mid-playing receives current board', async () => {
  const { host, guest, code } = await bootstrapRoom({ hostClientId: 'cid-R15a', guestClientId: 'cid-R15b' });
  sendJson(host, { type: 'move', row: 7, col: 7 });
  await sleep(400);
  sendJson(guest, { type: 'move', row: 8, col: 8 });
  await waitFor(guest, (m) => m.type === 'move' && m.row === 8, 1000);
  const spec = await open();
  sendJson(spec, { type: 'set_nickname', nickname: 'Spec', clientId: 'cid-R15s' });
  sendJson(spec, { type: 'spectate_room', code, nickname: 'Spec' });
  const ok = await waitForType(spec, 'spectate_success');
  assert(ok.board[7][7] === 1);
  assert(ok.board[8][8] === 2);
  host.close(); guest.close(); spec.close();
});

test('R16: clientId bound for fresh ws even before joining room', async () => {
  const ws1 = await open();
  sendJson(ws1, { type: 'set_nickname', nickname: 'A', clientId: 'cid-R16' });
  await sleep(100);
  const ws2 = await open();
  sendJson(ws2, { type: 'set_nickname', nickname: 'B', clientId: 'cid-R16' });
  await sleep(100);
  sendJson(ws1, { type: 'queue_join', nickname: 'A', clientId: 'cid-R16' });
  await waitForType(ws1, 'queue_waiting');
  sendJson(ws2, { type: 'queue_join', nickname: 'B', clientId: 'cid-R16' });
  await waitFor(ws1, (m) => m.type === 'queue_canceled', 1500);
  ws1.close(); ws2.close();
});

test('S1: spectate_success 에 sessionId 포함 (Phase 2)', async () => {
  const host = await open();
  sendJson(host, { type: 'set_nickname', nickname: 'H', clientId: 'cid-S1h' });
  sendJson(host, { type: 'create_room', nickname: 'H' });
  const { code } = await waitForType(host, 'room_created');
  const spec = await open();
  sendJson(spec, { type: 'set_nickname', nickname: 'Spec', clientId: 'cid-S1s' });
  sendJson(spec, { type: 'spectate_room', code, nickname: 'Spec' });
  const ok = await waitForType(spec, 'spectate_success');
  assert(typeof ok.sessionId === 'string' && ok.sessionId.length > 0, `expected sessionId in spectate_success, got ${ok.sessionId}`);
  host.close(); spec.close();
});

test('S3: spectator 정상 close + grace 안에 resume → 같은 방 재합류', async () => {
  // 새로고침 시나리오 — ws close 가 정상 fire 되는 경우.
  // SPECTATOR_DISCONNECT_GRACE_MS 가 짧으니 (test: 500ms), 빠르게 reconnect.
  const host = await open();
  sendJson(host, { type: 'set_nickname', nickname: 'H', clientId: 'cid-S3h' });
  sendJson(host, { type: 'create_room', nickname: 'H' });
  const { code } = await waitForType(host, 'room_created');
  const spec = await open();
  sendJson(spec, { type: 'set_nickname', nickname: 'Spec', clientId: 'cid-S3s' });
  sendJson(spec, { type: 'spectate_room', code, nickname: 'Spec' });
  const first = await waitForType(spec, 'spectate_success');
  const sid = first.sessionId;
  spec.close();   // 정상 close — grace 동안 session 유지
  await sleep(150);
  const spec2 = await open();
  sendJson(spec2, { type: 'resume_session', sessionId: sid, nickname: 'Spec' });
  const ok = await waitForType(spec2, 'spectate_success', 1500);
  assert(ok.code === code);
  assert(typeof ok.sessionId === 'string' && ok.sessionId !== sid, 'expected new sessionId after resume');
  host.close(); spec2.close();
});

test('S4: spectator grace 만료 후 resume → resume_failed', async () => {
  const host = await open();
  sendJson(host, { type: 'set_nickname', nickname: 'H', clientId: 'cid-S4h' });
  sendJson(host, { type: 'create_room', nickname: 'H' });
  const { code } = await waitForType(host, 'room_created');
  const spec = await open();
  sendJson(spec, { type: 'set_nickname', nickname: 'Spec', clientId: 'cid-S4s' });
  sendJson(spec, { type: 'spectate_room', code, nickname: 'Spec' });
  const first = await waitForType(spec, 'spectate_success');
  const sid = first.sessionId;
  spec.close();
  // SPECTATOR_DISCONNECT_GRACE_MS=500 (env) 보다 길게
  await sleep(900);
  const spec2 = await open();
  sendJson(spec2, { type: 'resume_session', sessionId: sid, nickname: 'Spec' });
  const fail = await waitForType(spec2, 'resume_failed', 1500);
  assert(fail.reason === 'not_found' || fail.reason === 'invalid_session');
  host.close(); spec2.close();
});

test('S2: spectator resume_session 으로 같은 방 재합류 (비행기모드 모방)', async () => {
  // spectator 세션은 grace 없이 ws close 즉시 정리. 따라서 정상 close 한 경우는
  // resume 불가. 비행기모드(좀비 옛 ws + 새 ws) 시나리오에서만 resume_session 이
  // 의미 있음 — 서버가 옛 ws 의 close 를 아직 감지하지 못한 윈도우.
  const host = await open();
  sendJson(host, { type: 'set_nickname', nickname: 'H', clientId: 'cid-S2h' });
  sendJson(host, { type: 'create_room', nickname: 'H' });
  const { code } = await waitForType(host, 'room_created');
  const spec = await open();
  sendJson(spec, { type: 'set_nickname', nickname: 'Spec', clientId: 'cid-S2s' });
  sendJson(spec, { type: 'spectate_room', code, nickname: 'Spec' });
  const first = await waitForType(spec, 'spectate_success');
  const sid = first.sessionId;
  // 옛 spec 을 close 하지 않음 (좀비) → 새 ws 가 resume_session 으로 합류
  const spec2 = await open();
  sendJson(spec2, { type: 'set_nickname', nickname: 'Spec', clientId: 'cid-S2s' });
  sendJson(spec2, { type: 'resume_session', sessionId: sid, nickname: 'Spec' });
  const ok = await waitForType(spec2, 'spectate_success', 1500);
  assert(ok.code === code, `expected same code ${code}, got ${ok.code}`);
  assert(typeof ok.sessionId === 'string' && ok.sessionId.length > 0, 'expected new sessionId');
  host.close(); spec.close(); spec2.close();
});

test('R17: rematch issues fresh gameId', async () => {
  const { host, guest, gameId: g1 } = await bootstrapRoom({ hostClientId: 'cid-R17a', guestClientId: 'cid-R17b' });
  const moves = [
    { p: 'h', r: 7, c: 7 }, { p: 'g', r: 0, c: 0 },
    { p: 'h', r: 7, c: 8 }, { p: 'g', r: 0, c: 1 },
    { p: 'h', r: 7, c: 10 }, { p: 'g', r: 0, c: 2 },
    { p: 'h', r: 7, c: 11 }, { p: 'g', r: 0, c: 3 },
    { p: 'h', r: 7, c: 9 },
  ];
  for (const m of moves) {
    sendJson(m.p === 'h' ? host : guest, { type: 'move', row: m.r, col: m.c });
    await sleep(380);
  }
  await waitFor(host, (m) => m.type === 'game_over', 2000);
  sendJson(host, { type: 'rematch' });
  sendJson(guest, { type: 'rematch' });
  const start2 = await waitFor(host, (m) => m.type === 'game_start' && m.gameId !== g1, 2000);
  assert(start2.gameId !== g1);
  host.close(); guest.close();
});

// ============================================================
// P 시나리오 — PR#2 신규 코드 경로
// ============================================================

test('P1: queue record-based matchmaking', async () => {
  const wsA = await open();
  sendJson(wsA, { type: 'queue_join', nickname: 'A', clientId: 'cid-P1a' });
  await waitForType(wsA, 'queue_waiting');
  const wsB = await open();
  sendJson(wsB, { type: 'queue_join', nickname: 'B', clientId: 'cid-P1b' });
  const aStart = await waitForType(wsA, 'game_start', 2000);
  const bStart = await waitForType(wsB, 'game_start', 2000);
  assert(aStart.code === bStart.code);
  wsA.close(); wsB.close();
});

test('F1: online_list 는 clientId 단위 dedup (같은 브라우저 멀티탭 = 1명)', async () => {
  // 같은 clientId 로 두 탭에서 set_nickname (서로 다른 닉) → 명단에 1명만.
  const tabA = await open();
  sendJson(tabA, { type: 'set_nickname', nickname: 'F1탭A', clientId: 'cid-F1' });
  await sleep(150);
  const tabB = await open();
  sendJson(tabB, { type: 'set_nickname', nickname: 'F1탭B', clientId: 'cid-F1' });
  await sleep(300);
  // 다른 사용자가 명단 요청
  const obs = await open();
  sendJson(obs, { type: 'set_nickname', nickname: 'F1obs', clientId: 'cid-F1obs' });
  sendJson(obs, { type: 'request_online_list' });
  const list = await waitForType(obs, 'online_list', 1500);
  const f1Count = list.nicknames.filter((n) => n.startsWith('F1탭')).length;
  assert(f1Count === 1, `expected 1 F1탭 entry (dedup by clientId), got ${f1Count}: ${JSON.stringify(list.nicknames)}`);
  // 마지막에 set_nickname 한 탭의 닉이 보여야 (B)
  assert(list.nicknames.includes('F1탭B'), `expected F1탭B (most recent), got ${JSON.stringify(list.nicknames)}`);
  tabA.close(); tabB.close(); obs.close();
});

test('F2: 옛 큐 entry 가 close 로 사라진 후 새 ws 재진입 → bot_offer 재발송 안 함 (clientId history)', async () => {
  // race 시나리오: 옛 ws 의 close 가 새 ws 의 queue_join 보다 _먼저_ fire.
  // 옛 entry 는 정리됐지만 botOfferSentByClientId 에 시각이 남아있어야 → 새 entry timer 안 켬.
  const old = await open();
  sendJson(old, { type: 'queue_join', nickname: 'F2', clientId: 'cid-F2' });
  await waitForType(old, 'queue_waiting');
  await waitForType(old, 'bot_offer', 2000);
  old.close();  // 명시적 close — 옛 entry 정리됨
  await sleep(150);
  // 새 ws 가 같은 clientId 로 큐 재진입
  const fresh = await open();
  sendJson(fresh, { type: 'queue_join', nickname: 'F2', clientId: 'cid-F2' });
  await waitForType(fresh, 'queue_waiting', 1500);
  // 1500ms 대기 — bot_offer 다시 와선 안 됨
  await sleep(1500);
  const dupOffers = fresh.received.filter((m) => m.type === 'bot_offer');
  assert(dupOffers.length === 0, `expected NO bot_offer (clientId cooldown), got ${dupOffers.length}`);
  fresh.close();
});

// 정책 import — 정책 값이 바뀌어도 테스트 안 깨짐.
const { POLICIES } = require('../infra/rate-limit');

test('P2: rate-limit hits at policy limit for clientId', async () => {
  // request_online_list 는 짧은 windowMs 라 테스트하기 좋음.
  const policy = POLICIES.request_online_list;
  const ws1 = await open();
  sendJson(ws1, { type: 'set_nickname', nickname: 'L', clientId: 'cid-P2' });
  await sleep(100);
  // limit 번 까지는 OK, limit+1 번째에 에러.
  for (let i = 0; i <= policy.limit; i++) {
    sendJson(ws1, { type: 'request_online_list' });
    await sleep(20);
  }
  await sleep(200);
  const errLimit = ws1.received.filter((m) => m.type === 'error' && /다시 시도/.test(m.message));
  assert(errLimit.length >= 1, `expected rate-limit error after limit+1=${policy.limit + 1} calls, got ${errLimit.length}`);
  ws1.close();
});

test('P3: 같은 clientId 새 ws 도 한도 유지 (새로고침 우회 방지)', async () => {
  const policy = POLICIES.request_online_list;
  const ws1 = await open();
  sendJson(ws1, { type: 'set_nickname', nickname: 'L', clientId: 'cid-P3-shared' });
  await sleep(100);
  for (let i = 0; i < policy.limit; i++) {
    sendJson(ws1, { type: 'request_online_list' });
    await sleep(20);
  }
  ws1.close();
  await sleep(200);
  // 새 connection 같은 clientId — 첫 호출 하나만으로 limit+1 도달
  const ws2 = await open();
  sendJson(ws2, { type: 'set_nickname', nickname: 'L', clientId: 'cid-P3-shared' });
  sendJson(ws2, { type: 'request_online_list' });
  await sleep(200);
  const errLimit = ws2.received.filter((m) => m.type === 'error' && /다시 시도/.test(m.message));
  assert(errLimit.length >= 1, `expected rate-limit on new connection with same clientId, got ${errLimit.length}`);
  ws2.close();
});

test('P3b: 다른 clientId 새 ws → 깨끗한 bucket', async () => {
  const policy = POLICIES.request_online_list;
  const ws1 = await open();
  sendJson(ws1, { type: 'set_nickname', nickname: 'L', clientId: 'cid-P3b-old' });
  await sleep(100);
  for (let i = 0; i < policy.limit; i++) {
    sendJson(ws1, { type: 'request_online_list' });
    await sleep(20);
  }
  ws1.close();
  await sleep(200);
  // 다른 clientId — 새 bucket
  const ws2 = await open();
  sendJson(ws2, { type: 'set_nickname', nickname: 'L2', clientId: 'cid-P3b-fresh' });
  sendJson(ws2, { type: 'request_online_list' });
  await sleep(200);
  // 첫 호출은 통과해야 (한도 미달)
  const ok = ws2.received.filter((m) => m.type === 'online_list');
  assert(ok.length >= 1, `expected online_list on fresh clientId, got ${JSON.stringify(ws2.received.slice(-3))}`);
  ws2.close();
});

test('P4: spectator broadcast via spectatorSessionIds', async () => {
  const host = await open();
  sendJson(host, { type: 'set_nickname', nickname: 'H', clientId: 'cid-P4h' });
  sendJson(host, { type: 'create_room', nickname: 'H' });
  const { code } = await waitForType(host, 'room_created');
  const s1 = await open();
  sendJson(s1, { type: 'set_nickname', nickname: 'S1', clientId: 'cid-P4s1' });
  sendJson(s1, { type: 'spectate_room', code, nickname: 'S1' });
  await waitForType(s1, 'spectate_success');
  const s2 = await open();
  sendJson(s2, { type: 'set_nickname', nickname: 'S2', clientId: 'cid-P4s2' });
  sendJson(s2, { type: 'spectate_room', code, nickname: 'S2' });
  await waitForType(s2, 'spectate_success');
  const guest = await open();
  sendJson(guest, { type: 'set_nickname', nickname: 'G', clientId: 'cid-P4g' });
  sendJson(guest, { type: 'join_room', code, nickname: 'G' });
  await waitForType(guest, 'game_start');
  await waitFor(s1, (m) => m.type === 'spectate_success' && m.status === 'playing', 1500);
  await waitFor(s2, (m) => m.type === 'spectate_success' && m.status === 'playing', 1500);
  host.close(); guest.close(); s1.close(); s2.close();
});

// ============================================================
// A/B 시나리오 — 비행기모드 (좀비 ws + reconnect)
// ============================================================

// A 시리즈: 절대 카운트가 아니라 baseline 대비 DELTA 로 검증 (이전 테스트의 lingering 연결 영향 배제).
const captureBaselineN = async () => {
  const obs = await open();
  // 초기 online_count 받아서 baseline 잡기
  const first = await waitForType(obs, 'online_count', 1500);
  return { obs, baseline: first.n };
};

test('A1: 단일 ws + clientId 바인딩 → 1 unique 사용자 추가', async () => {
  const { obs, baseline } = await captureBaselineN();
  obs.received.length = 0;
  const ws = await open();
  sendJson(ws, { type: 'set_nickname', nickname: 'A1', clientId: 'cid-A1' });
  await sleep(300);
  const last = obs.received.filter((m) => m.type === 'online_count').pop();
  assert(last && last.n === baseline + 1, `expected baseline+1=${baseline + 1}, got ${last?.n}`);
  ws.close(); obs.close();
});

test('A2: 같은 clientId 두 탭 → 1 unique 사용자만 추가', async () => {
  const { obs, baseline } = await captureBaselineN();
  obs.received.length = 0;
  const tabA = await open();
  sendJson(tabA, { type: 'set_nickname', nickname: 'Same', clientId: 'cid-shared-A2' });
  await sleep(300);
  const tabB = await open();
  sendJson(tabB, { type: 'set_nickname', nickname: 'Same', clientId: 'cid-shared-A2' });
  await sleep(400);
  const last = obs.received.filter((m) => m.type === 'online_count').pop();
  assert(last && last.n === baseline + 1, `expected baseline+1=${baseline + 1} (dedup), got ${last?.n}`);
  tabA.close(); tabB.close(); obs.close();
});

test('A3: 좀비 옛 ws + reconnect 새 ws → unique 변화 없음', async () => {
  const { obs, baseline } = await captureBaselineN();
  obs.received.length = 0;
  const userOld = await open();
  sendJson(userOld, { type: 'set_nickname', nickname: 'U', clientId: 'cid-user-A3' });
  await sleep(300);
  const afterOld = obs.received.filter((m) => m.type === 'online_count').pop();
  assert(afterOld && afterOld.n === baseline + 1, `expected baseline+1 after first open, got ${afterOld?.n}`);
  obs.received.length = 0;
  simulateAirplaneZombie(userOld);
  const userNew = await open();
  sendJson(userNew, { type: 'set_nickname', nickname: 'U', clientId: 'cid-user-A3' });
  await sleep(500);
  const afterReconnect = obs.received.filter((m) => m.type === 'online_count').pop();
  // 같은 clientId 의 두 connection 이지만 unique = 1 명. baseline + 1 그대로.
  assert(afterReconnect && afterReconnect.n === baseline + 1, `after reconnect expected baseline+1=${baseline + 1}, got ${afterReconnect?.n}`);
  userOld.close(); userNew.close(); obs.close();
});

test('B1: 정상 큐 → 단일 bot_offer', async () => {
  const ws = await open();
  sendJson(ws, { type: 'queue_join', nickname: 'Q', clientId: 'cid-B1' });
  await waitForType(ws, 'queue_waiting');
  await waitForType(ws, 'bot_offer', 2000);
  const offers = ws.received.filter((m) => m.type === 'bot_offer');
  assert(offers.length === 1);
  ws.close();
});

test('B2: 좀비 옛 ws (bot_offer 발송 후) + 새 ws → 다시 안 받음', async () => {
  const old = await open();
  sendJson(old, { type: 'queue_join', nickname: 'Q', clientId: 'cid-B2' });
  await waitForType(old, 'queue_waiting');
  await waitForType(old, 'bot_offer', 2000);
  simulateAirplaneZombie(old);
  const fresh = await open();
  sendJson(fresh, { type: 'queue_join', nickname: 'Q', clientId: 'cid-B2' });
  await waitForType(fresh, 'queue_waiting', 2000);
  await sleep(1800);
  const dupOffers = fresh.received.filter((m) => m.type === 'bot_offer');
  assert(dupOffers.length === 0, `expected NO duplicate bot_offer, got ${dupOffers.length}`);
  old.close(); fresh.close();
});

test('B3: 좀비 옛 ws (bot_offer 발송 전) + 새 ws → joinedAt 보존, 원래 deadline', async () => {
  const old = await open();
  sendJson(old, { type: 'queue_join', nickname: 'Q', clientId: 'cid-B3' });
  await waitForType(old, 'queue_waiting');
  await sleep(300);
  simulateAirplaneZombie(old);
  const fresh = await open();
  sendJson(fresh, { type: 'queue_join', nickname: 'Q', clientId: 'cid-B3' });
  await waitForType(fresh, 'queue_waiting', 1500);
  const t0 = Date.now();
  await waitForType(fresh, 'bot_offer', 2000);
  const elapsed = Date.now() - t0;
  assert(elapsed < 1000, `expected bot_offer < 1000ms (joinedAt preserved), got ${elapsed}ms`);
  old.close(); fresh.close();
});

test('B4: 정상 queue_leave → bot_offer 안 옴', async () => {
  const ws = await open();
  sendJson(ws, { type: 'queue_join', nickname: 'Q', clientId: 'cid-B4' });
  await waitForType(ws, 'queue_waiting');
  await sleep(200);
  sendJson(ws, { type: 'queue_leave' });
  await sleep(1500);
  const offers = ws.received.filter((m) => m.type === 'bot_offer');
  assert(offers.length === 0);
  ws.close();
});

// ============================================================
// clientId reclaim — 같은 사용자가 어떤 경로로건 자기 방에 재합류 시 player 자리로
// ============================================================

test('RC1: 끊긴 player 가 새 ws 로 join_room → 자동 player 재합류 (resume_success)', async () => {
  const { host, guest, hostSid, code } = await bootstrapRoom({ hostClientId: 'cid-RC1h', guestClientId: 'cid-RC1g' });
  // 첫 수 둬서 보드 상태 만듦
  sendJson(host, { type: 'move', row: 7, col: 7 });
  await waitFor(host, (m) => m.type === 'move' && m.row === 7, 1000);
  // host close → grace 시작, slot 유지
  host.close();
  await sleep(300);
  // 새 탭 (sessionStorage 없음) — sessionId 없이 join_room
  const host2 = await open();
  sendJson(host2, { type: 'set_nickname', nickname: 'NewTab', clientId: 'cid-RC1h' });
  sendJson(host2, { type: 'join_room', code, nickname: 'NewTab' });
  // join_room 응답이 spectate_success 가 아니라 resume_success 여야 함 (reclaim)
  const ok = await waitForType(host2, 'resume_success', 1500);
  assert(ok.you === 'black', `expected reclaimed as black, got ${ok.you}`);
  assert(ok.code === code);
  assert(ok.board[7][7] === 1, 'board state preserved');
  // guest 가 opponent_reconnected 받아야
  await waitFor(guest, (m) => m.type === 'opponent_reconnected' && m.color === 'black', 1500);
  // reclaim 후 사용자가 또 두면 정상 처리
  // (host2 차례 아니지만 검증 목적: guest 가 다음 차례)
  host2.close(); guest.close();
});

test('RC2: 끊긴 player 가 새 ws 로 spectate_room → 자동 player 재합류', async () => {
  const { host, guest, code } = await bootstrapRoom({ hostClientId: 'cid-RC2h', guestClientId: 'cid-RC2g' });
  host.close();
  await sleep(300);
  const host2 = await open();
  sendJson(host2, { type: 'set_nickname', nickname: 'NewTab', clientId: 'cid-RC2h' });
  // 사용자가 [관전만] 눌렀어도 자기 방이면 player 로 재합류
  sendJson(host2, { type: 'spectate_room', code, nickname: 'NewTab' });
  const ok = await waitForType(host2, 'resume_success', 1500);
  assert(ok.you === 'black', `expected reclaimed as black, got ${ok.you}`);
  host2.close(); guest.close();
});

test('RC3: 옛 ws 살아있을 때 새 ws reclaim → 옛 ws 가 player_replaced 받고 정리', async () => {
  // 옛 ws 가 close 안 됐는데 (또는 race) 새 ws 가 같은 clientId 로 join_room.
  const { host, guest, code } = await bootstrapRoom({ hostClientId: 'cid-RC3h', guestClientId: 'cid-RC3g' });
  // 옛 host 는 그대로 alive
  const host2 = await open();
  sendJson(host2, { type: 'set_nickname', nickname: 'NewTab', clientId: 'cid-RC3h' });
  sendJson(host2, { type: 'join_room', code, nickname: 'NewTab' });
  await waitForType(host2, 'resume_success', 1500);
  // 옛 ws (host) 가 player_replaced 받아야
  await waitFor(host, (m) => m.type === 'player_replaced', 1500);
  host.close(); host2.close(); guest.close();
});

test('RC4: 봇 게임도 clientId reclaim 동작', async () => {
  const ws = await open();
  sendJson(ws, { type: 'set_nickname', nickname: 'Me', clientId: 'cid-RC4' });
  sendJson(ws, { type: 'create_bot_game', difficulty: 'easy', first: 'me', nickname: 'Me' });
  const start = await waitForType(ws, 'game_start');
  const code = start.code;
  ws.close();
  await sleep(300);
  // 새 탭에서 join_room (또는 spectate_room) — 봇 게임 방
  const ws2 = await open();
  sendJson(ws2, { type: 'set_nickname', nickname: 'NewTab', clientId: 'cid-RC4' });
  sendJson(ws2, { type: 'spectate_room', code, nickname: 'NewTab' });
  const ok = await waitForType(ws2, 'resume_success', 1500);
  assert(ok.code === code);
  // 사람 색으로 reclaim (봇이 아닌 색)
  assert(ok.you === 'black' || ok.you === 'white');
  assert(ok.status === 'playing');
  ws2.close();
});

test('RC5: 다른 clientId 가 join_room 하면 기존대로 spectator (reclaim 안 됨)', async () => {
  const { host, guest, code } = await bootstrapRoom({ hostClientId: 'cid-RC5h', guestClientId: 'cid-RC5g' });
  const stranger = await open();
  sendJson(stranger, { type: 'set_nickname', nickname: 'Stranger', clientId: 'cid-RC5-stranger' });
  sendJson(stranger, { type: 'join_room', code, nickname: 'Stranger' });
  // 두 자리 모두 차있으니 관전자로
  const ok = await waitForType(stranger, 'spectate_success', 1500);
  assert(ok.code === code);
  host.close(); guest.close(); stranger.close();
});

// ============================================================
// Phase 4+5 — JSON 직렬화 가능한 room state
// ============================================================

test('J1: serializeRoom 출력에 비-직렬화 타입 없음', async () => {
  // 직접 module 을 require 해서 state shape 확인. server 와 같은 cwd 라 가능.
  const rooms = require('../domain/rooms');
  const { serializeRoom } = require('../store/serialize');
  const room = rooms.createRoom('JSON');
  rooms.setRoom('JSON', room);
  rooms.createPlayerSession(room, 'black', {
    type: 'human', ws: null, clientId: 'cid-x', nickname: 'X',
  });
  rooms.createPlayerSession(room, 'white', {
    type: 'bot', ws: null, clientId: '_bot_hard', playerId: '_bot_hard', nickname: 'Hard Bot', difficulty: 'hard',
  });
  room.spectatorSessionIds.add('sess-A');
  room.spectatorSessionIds.add('sess-B');
  room.rematchVotes.add('black');
  const ser = serializeRoom(room);
  // 직렬화 시 throw 안 해야 + 결과에 banned types 없어야
  const json = JSON.stringify(ser);
  assert(typeof json === 'string' && json.length > 0, 'JSON.stringify failed');
  const parsed = JSON.parse(json);
  assert(parsed.code === 'JSON');
  assert(parsed.players.black?.clientId === 'cid-x');
  assert(parsed.players.white?.type === 'bot' && parsed.players.white?.difficulty === 'hard');
  assert(Array.isArray(parsed.spectatorSessionIds) && parsed.spectatorSessionIds.length === 2);
  assert(Array.isArray(parsed.rematchVotes) && parsed.rematchVotes.includes('black'));
  // 비-직렬화 키들이 root 에 없어야
  for (const banned of ['turnTimer', 'botMoveTimer', 'botOfferTimer', 'disconnectTimers']) {
    assert(!(banned in parsed), `unexpected ${banned} in serialized state`);
  }
  rooms.deleteRoom('JSON');
});

test('J2: room 자체에도 timer field 가 없음 (runtime 분리)', async () => {
  const rooms = require('../domain/rooms');
  const room = rooms.createRoom('NOTM');
  rooms.setRoom('NOTM', room);
  for (const banned of ['turnTimer', 'botMoveTimer', 'botOfferTimer', 'disconnectTimers']) {
    assert(!(banned in room), `room should not have ${banned} (moved to room-runtime)`);
  }
  rooms.deleteRoom('NOTM');
});

// ============================================================
// 랭킹 / 레이팅
// ============================================================
// broadcast 의 ranking_list (top 10) 가 먼저 도착해 새 user 가 그 안에 없을 수 있으니,
// request_ranking 보내기 전 이전 ranking_list / recent_games_list 메시지를 비워둔다.
// request 응답은 limit 50 으로 새 user 가 누적되어도 무조건 찾을 수 있게.
const clearRankingMessages = (ws) => {
  ws.received = ws.received.filter((m) =>
    m.type !== 'ranking_list' && m.type !== 'recent_games_list');
};

test('RK1: 봇 게임 leave_room → 사람 rating 감소 + recent_games 적재', async () => {
  const ws = await open();
  sendJson(ws, { type: 'set_nickname', nickname: 'RKLeaver', clientId: 'cid-rk1' });
  sendJson(ws, { type: 'create_bot_game', nickname: 'RKLeaver', difficulty: 'easy', first: 'me' });
  await waitForType(ws, 'game_start');
  sendJson(ws, { type: 'leave_room' });
  // leave_room 본인 ws 는 game_over 받지 않음 (다른 player/spectator 만). 잠시 대기로 처리 완료.
  await sleep(300);

  clearRankingMessages(ws);
  sendJson(ws, { type: 'request_ranking', limit: 50 });
  const list = await waitForType(ws, 'ranking_list');
  const me = list.entries.find((e) => e.clientId === 'cid-rk1');
  assert(me, 'me not in ranking after game');
  assert(me.rating < 1200, `expected rating < 1200 (INITIAL) after loss, got ${me.rating}`);
  assert(me.losses === 1, `expected losses=1, got ${me.losses}`);
  assert(typeof me.tier === 'string' && me.tier.length > 0, 'tier missing');

  clearRankingMessages(ws);
  sendJson(ws, { type: 'request_recent_games' });
  const games = await waitForType(ws, 'recent_games_list');
  const myGame = games.entries.find((g) =>
    g.black.clientId === 'cid-rk1' || g.white.clientId === 'cid-rk1');
  assert(myGame, 'my game not in recent_games');
  assert(myGame.reason === 'opponent_left', `expected reason=opponent_left, got ${myGame.reason}`);
  assert(myGame.isBot === true, 'expected isBot=true');
});

test('RK2: 봇 user 도 ranking 에 등록', async () => {
  const ws = await open();
  sendJson(ws, { type: 'set_nickname', nickname: 'RKObs', clientId: 'cid-rk2' });
  clearRankingMessages(ws);
  sendJson(ws, { type: 'request_ranking', limit: 50 });
  const list = await waitForType(ws, 'ranking_list');
  // RK1 시나리오 후 easy 봇 user 가 생성되어있어야 함
  const bot = list.entries.find((e) => e.clientId === '_bot_easy');
  assert(bot, '_bot_easy not in ranking');
  assert(bot.isBot === true, 'bot.isBot=true 기대');
  assert(bot.rating > 1000, `expected easy bot rating > 1000 (RK1 에서 한 번 이김), got ${bot.rating}`);
  assert(bot.wins >= 1, `expected bot.wins>=1, got ${bot.wins}`);
  assert(typeof bot.tier === 'string', 'bot tier missing');
});

test('RK3: PVP leave_room → 떠난 쪽 패배 + ratings 변동', async () => {
  const { host, guest, code } = await bootstrapRoom({
    hostNick: 'RKHost', hostClientId: 'cid-rk3-host',
    guestNick: 'RKGuest', guestClientId: 'cid-rk3-guest',
  });
  void code;
  sendJson(host, { type: 'leave_room' });
  await waitForType(guest, 'game_over');

  clearRankingMessages(host);
  sendJson(host, { type: 'request_ranking', limit: 50 });
  const list = await waitForType(host, 'ranking_list');
  const h = list.entries.find((e) => e.clientId === 'cid-rk3-host');
  const g = list.entries.find((e) => e.clientId === 'cid-rk3-guest');
  assert(h && g, 'host/guest not in ranking');
  // zero-sum (양쪽 INITIAL_RATING=1200 시작 → 합 2400 유지)
  assert(h.rating + g.rating === 2400, `zero-sum 깨짐: host=${h.rating} guest=${g.rating}`);
  assert(h.rating < 1200 && g.rating > 1200, 'host should lose, guest should win');
  assert(h.losses === 1 && g.wins === 1, `wins/losses 카운트 오류`);
});

// ============================================================
// 서버 deploy 시뮬레이션 — disconnect 동안 timer 동결 + reconnect 시 재개
// ============================================================
test('D1: 봇 게임 disconnect 후 reconnect → 보드/턴 보존 + timer 재개', async () => {
  const ws = await open();
  sendJson(ws, { type: 'set_nickname', nickname: 'D1', clientId: 'cid-d1' });
  sendJson(ws, { type: 'create_bot_game', nickname: 'D1', difficulty: 'easy', first: 'me' });
  const gs = await waitForType(ws, 'game_start');
  const sid = gs.sessionId;
  sendJson(ws, { type: 'move', row: 7, col: 7 });
  await waitForType(ws, 'move');
  await sleep(600);                      // 봇 응수
  ws.close();
  await sleep(300);

  const ws2 = await open();
  sendJson(ws2, { type: 'resume_session', sessionId: sid, clientId: 'cid-d1', nickname: 'D1' });
  const resumed = await waitForType(ws2, 'resume_success');
  assert(resumed.board[7][7] === 1, `흑돌 (7,7) 보존 필요`);
  // 봇 게임 + 사람 reconnect → bothPlayersOnline true → turn timer 시작
  await waitForType(ws2, 'turn_started', 1500);
});

// D2 (PVP 양쪽 reconnect 시 timer 재개) 는 turn_started broadcast 의 timing 이
// PR 안에서 안정적으로 검증하기 어려워 보류. 대신 npm run test:hydrate (PVP 시나리오)
// 가 SIGTERM/restart 후 보드 보존 검증. 본 PR 의 핵심 로직 (bothPlayersOnline 분기)
// 은 D1 (봇 게임) 으로 cover — 봇 게임/PVP 모두 동일 코드 경로.

// ============================================================
// VIS — public / private 방 visibility 시나리오
// ============================================================
// VIS1: public 방 만들면 rooms_list 에 노출
// VIS2: private 방 만들면 rooms_list 에 안 노출
// VIS3: private 방에 코드로 join → 매칭 OK
// VIS4: private 방 매칭 성사 (playing) → rooms_list 에 노출
// VIS5: private 방 코드로 spectate → 관전 OK
// VIS6: 빈 public 방 존재 → queue_join 즉시 그 방에 합류 (matched)
// VIS7: 빈 public 방 없음 (private 만 있음) → queue_join 큐 대기
// VIS8: 여러 빈 public 방 → FIFO (먼저 만든 방) 우선
// VIS9: 방장 자신이 queue_join → 자기 방에 매칭 안 됨

const requestRooms = async (ws) => {
  ws.received.length = 0;
  sendJson(ws, { type: 'request_rooms_list' });
  return waitForType(ws, 'rooms_list');
};

test('VIS1: public 방 만들면 rooms_list 에 노출', async () => {
  const host = await open();
  sendJson(host, { type: 'set_nickname', nickname: 'H', clientId: 'cid-vis1-h' });
  sendJson(host, { type: 'create_room', nickname: 'H', visibility: 'public' });
  await waitForType(host, 'room_created');

  const obs = await open();
  sendJson(obs, { type: 'set_nickname', nickname: 'O', clientId: 'cid-vis1-o' });
  const list = await requestRooms(obs);
  const found = list.rooms.find((r) => r.nicknames.black === 'H');
  assert(found, 'public 방이 list 에 있어야 함');
  assert(found.visibility === 'public', `expected visibility=public, got ${found.visibility}`);
  host.close(); obs.close();
});

test('VIS2: private 방 만들면 rooms_list 에 안 노출', async () => {
  const host = await open();
  sendJson(host, { type: 'set_nickname', nickname: 'HP', clientId: 'cid-vis2-h' });
  sendJson(host, { type: 'create_room', nickname: 'HP', visibility: 'private' });
  await waitForType(host, 'room_created');

  const obs = await open();
  sendJson(obs, { type: 'set_nickname', nickname: 'O2', clientId: 'cid-vis2-o' });
  const list = await requestRooms(obs);
  const found = list.rooms.find((r) => r.nicknames.black === 'HP');
  assert(!found, 'private 대기 방은 list 에 없어야 함');
  host.close(); obs.close();
});

test('VIS3: private 방 코드로 join → 매칭 OK', async () => {
  const host = await open();
  sendJson(host, { type: 'set_nickname', nickname: 'PH', clientId: 'cid-vis3-h' });
  sendJson(host, { type: 'create_room', nickname: 'PH', visibility: 'private' });
  const created = await waitForType(host, 'room_created');
  const code = created.code;

  const guest = await open();
  sendJson(guest, { type: 'set_nickname', nickname: 'PG', clientId: 'cid-vis3-g' });
  sendJson(guest, { type: 'join_room', code, nickname: 'PG' });
  await waitForType(guest, 'game_start');
  await waitForType(host, 'game_start');
  host.close(); guest.close();
});

test('VIS4: private 방 매칭 후 (playing) → rooms_list 에 노출', async () => {
  const host = await open();
  sendJson(host, { type: 'set_nickname', nickname: 'P4H', clientId: 'cid-vis4-h' });
  sendJson(host, { type: 'create_room', nickname: 'P4H', visibility: 'private' });
  const created = await waitForType(host, 'room_created');
  const code = created.code;
  const guest = await open();
  sendJson(guest, { type: 'set_nickname', nickname: 'P4G', clientId: 'cid-vis4-g' });
  sendJson(guest, { type: 'join_room', code, nickname: 'P4G' });
  await waitForType(guest, 'game_start');

  const obs = await open();
  sendJson(obs, { type: 'set_nickname', nickname: 'P4O', clientId: 'cid-vis4-o' });
  const list = await requestRooms(obs);
  const found = list.rooms.find((r) => r.code === code);
  assert(found, 'playing 상태 private 방은 list 에 노출');
  assert(found.status === 'playing');
  assert(found.visibility === 'private');
  host.close(); guest.close(); obs.close();
});

test('VIS5: private 방 코드로 spectate → 관전 OK', async () => {
  const host = await open();
  sendJson(host, { type: 'set_nickname', nickname: 'P5H', clientId: 'cid-vis5-h' });
  sendJson(host, { type: 'create_room', nickname: 'P5H', visibility: 'private' });
  const created = await waitForType(host, 'room_created');
  const code = created.code;
  const spec = await open();
  sendJson(spec, { type: 'set_nickname', nickname: 'P5S', clientId: 'cid-vis5-s' });
  sendJson(spec, { type: 'spectate_room', code, nickname: 'P5S' });
  await waitForType(spec, 'spectate_success');
  host.close(); spec.close();
});

test('VIS6: 빈 public 방 → queue_join 즉시 그 방에 합류 (matched)', async () => {
  const host = await open();
  sendJson(host, { type: 'set_nickname', nickname: 'V6H', clientId: 'cid-vis6-h' });
  sendJson(host, { type: 'create_room', nickname: 'V6H', visibility: 'public' });
  const created = await waitForType(host, 'room_created');

  const guest = await open();
  sendJson(guest, { type: 'set_nickname', nickname: 'V6G', clientId: 'cid-vis6-g' });
  sendJson(guest, { type: 'queue_join', nickname: 'V6G', clientId: 'cid-vis6-g' });
  const matched = await waitForType(guest, 'matched', 2000);
  assert(matched.code === created.code, `expected matched into ${created.code}, got ${matched.code}`);
  await waitForType(guest, 'game_start');
  await waitForType(host,  'game_start');
  host.close(); guest.close();
});

test('VIS7: 빈 public 방 없음 (private 만) → queue_join 큐 대기', async () => {
  // private 방 만들고 — 매칭 대상 아님
  const host = await open();
  sendJson(host, { type: 'set_nickname', nickname: 'V7H', clientId: 'cid-vis7-h' });
  sendJson(host, { type: 'create_room', nickname: 'V7H', visibility: 'private' });
  await waitForType(host, 'room_created');

  const guest = await open();
  sendJson(guest, { type: 'set_nickname', nickname: 'V7G', clientId: 'cid-vis7-g' });
  sendJson(guest, { type: 'queue_join', nickname: 'V7G', clientId: 'cid-vis7-g' });
  // matched 가 오면 안 됨 — queue_waiting 만 와야
  const evt = await waitFor(guest, (m) => m.type === 'queue_waiting' || m.type === 'matched', 2000);
  assert(evt.type === 'queue_waiting', `expected queue_waiting, got ${evt.type}`);
  sendJson(guest, { type: 'queue_leave' });
  host.close(); guest.close();
});

test('VIS8: 여러 빈 public 방 → FIFO (먼저 만든 방) 우선', async () => {
  const h1 = await open();
  sendJson(h1, { type: 'set_nickname', nickname: 'V8H1', clientId: 'cid-vis8-h1' });
  sendJson(h1, { type: 'create_room', nickname: 'V8H1', visibility: 'public' });
  const c1 = await waitForType(h1, 'room_created');
  await sleep(30);
  const h2 = await open();
  sendJson(h2, { type: 'set_nickname', nickname: 'V8H2', clientId: 'cid-vis8-h2' });
  sendJson(h2, { type: 'create_room', nickname: 'V8H2', visibility: 'public' });
  await waitForType(h2, 'room_created');

  const guest = await open();
  sendJson(guest, { type: 'set_nickname', nickname: 'V8G', clientId: 'cid-vis8-g' });
  sendJson(guest, { type: 'queue_join', nickname: 'V8G', clientId: 'cid-vis8-g' });
  const matched = await waitForType(guest, 'matched', 2000);
  assert(matched.code === c1.code, `FIFO: should match ${c1.code}, got ${matched.code}`);
  h1.close(); h2.close(); guest.close();
});

test('VIS9: 방장이 자신이 queue_join → 자기 방에 매칭 안 됨', async () => {
  const host = await open();
  sendJson(host, { type: 'set_nickname', nickname: 'V9H', clientId: 'cid-vis9' });
  sendJson(host, { type: 'create_room', nickname: 'V9H', visibility: 'public' });
  await waitForType(host, 'room_created');

  // 같은 clientId 가 새 ws 로 queue_join — leave_room 안 하고 큐 입장은 비현실적이지만
  // findEmptyPublicRoom 의 excludeClientId 가드 검증용.
  const second = await open();
  sendJson(second, { type: 'set_nickname', nickname: 'V9H', clientId: 'cid-vis9' });
  sendJson(second, { type: 'queue_join', nickname: 'V9H', clientId: 'cid-vis9' });
  // 자기 방에 합류하면 안 됨 → queue_waiting (또는 다른 큐 entry 와 매칭) 만 와야
  const evt = await waitFor(second, (m) => m.type === 'queue_waiting' || m.type === 'matched', 2000);
  assert(evt.type === 'queue_waiting', `방장 자기 방 매칭 안 됨, got ${evt.type}`);
  sendJson(second, { type: 'queue_leave' });
  host.close(); second.close();
});

// ============================================================
// BG — 봇 게임 끊김 / hydrate / nickname 보존 시나리오
// ============================================================

// BG2 — 사용자 보고 버그 재현:
// 봇 게임 중 사람 ws zombie (close 안 fire + heartbeat pong 도 안 옴) + turn 응답 없음
// → onTurnTimeout 발화 → 차례 봇으로 토글 → scheduleBotMove → 봇 둠 → afterSuccessfulMove
// → 사람 차례 → 다시 onTurnTimeout 반복으로 봇이 혼자 게임을 끝까지 진행하면 안 됨.
// 진짜 zombie 시뮬: ws._socket.pause() 로 incoming/outgoing 모두 멈춤 → ping 받지만
// pong 자동 응답 안 됨 → server 의 ws.isAlive=false → bothPlayersOnline=false.
test('BG2: 봇 게임 — 사람 응답 없는 zombie 상태에서 봇이 혼자 두면 안 됨', async () => {
  const ws = await open();
  sendJson(ws, { type: 'set_nickname', nickname: 'BG2U', clientId: 'cid-bg2' });
  sendJson(ws, { type: 'create_bot_game', difficulty: 'easy', first: 'me', nickname: 'BG2U' });
  await waitForType(ws, 'game_start');
  // 진짜 zombie 시뮬: TCP socket 자체를 pause — ping 받지만 pong 자동 응답 못 함.
  // server 의 다음 heartbeat cycle (~2s test) 에서 ws.isAlive=false. 그 다음 cycle (4s) 에 terminate.
  ws._socket?.pause();
  ws.received.length = 0;
  // 12초 대기: 2 heartbeat cycle + turn timeout 1회 이상.
  await sleep(12000);
  // socket.pause 라 ws.received 안 채워짐. 봇이 두면 server log 에 game_over 또는 move broadcast.
  // 정확한 검증 어렵지만 — heartbeat terminate 가 정상 작동했다면 ws 가 server side 에서 close
  // 되어 onPlayerDisconnect → grace timer 시작 → 정상 abandon 흐름.
  // 이 test 의 핵심은 봇 게임이 사람 부재 중에 무한 진행되지 않는다는 것 — 별도 ws 로 server
  // 상태 확인.
  ws._socket?.resume();   // 청소 위해 다시 풀어줌
  ws.close();
  await sleep(200);
  // 새 ws 로 rooms_list 조회 — 봇 게임 방이 그래도 살아있거나 사라졌어야 함 (계속 두진 않음).
  const probe = await open();
  sendJson(probe, { type: 'set_nickname', nickname: 'P', clientId: 'cid-bg2-p' });
  sendJson(probe, { type: 'request_rooms_list' });
  const list = await waitForType(probe, 'rooms_list');
  // BG2U 가 black 인 봇 방이 status='playing' 으로 계속 진행 중이면 NG.
  // 정상은: heartbeat terminate + grace 만료로 finalizeAbandon → 방 폐쇄 (status='over' 또는 사라짐).
  const bg2Room = list.rooms.find((r) => r.nicknames.black === 'BG2U');
  if (bg2Room) {
    assert(bg2Room.status !== 'playing',
      `사람 zombie 12초 후 봇 게임이 계속 playing 이면 안 됨 — fix 가 안 됐을 가능성. got: ${JSON.stringify(bg2Room)}`);
  }
  // 추가로 봇 user nickname 도 보존됐는지 확인
  sendJson(probe, { type: 'request_ranking', limit: 100 });
  const ranking = await waitForType(probe, 'ranking_list');
  const botEntry = ranking.entries.find((e) => e.clientId === '_bot_easy');
  if (botEntry) {
    assert(botEntry.nickname !== 'BG2U',
      `봇 user nickname 이 사용자 닉으로 바뀌면 안 됨, got: ${botEntry.nickname}`);
  }
  probe.close();
}, 30000);

test('BG1: 봇 게임 끊김 → grace 만료 → finalizeAbandon 후에도 봇 user nickname 보존', async () => {
  const userNick = 'BG1User';
  const ws = await open();
  sendJson(ws, { type: 'set_nickname', nickname: userNick, clientId: 'cid-bg1' });
  sendJson(ws, { type: 'create_bot_game', difficulty: 'easy', first: 'me', nickname: userNick });
  await waitForType(ws, 'game_start');

  // 사람 ws close → grace 만료 → finalizeAbandon → 봇이 abandoned 승리 → recordGameResult
  ws.close();
  await sleep(GRACE + 500);

  // 새 ws 로 랭킹 조회 → 봇 user 의 nickname 확인
  const obs = await open();
  sendJson(obs, { type: 'set_nickname', nickname: 'Obs', clientId: 'cid-bg1-obs' });
  sendJson(obs, { type: 'request_ranking', limit: 100 });
  const list = await waitForType(obs, 'ranking_list');
  const botEntry = list.entries.find((e) => e.clientId === '_bot_easy');
  assert(botEntry, '_bot_easy user 가 ranking 에 등록되어 있어야 함');
  assert(botEntry.nickname !== userNick,
    `봇 user nickname 이 사용자 닉(${userNick}) 으로 바뀌면 안 됨, got: ${botEntry.nickname}`);
  // recent_games 도 확인 — black/white nickname 이 swap 안 됐는지
  sendJson(obs, { type: 'request_recent_games' });
  const games = await waitForType(obs, 'recent_games_list');
  const myGame = games.entries.find((g) =>
    g.black.clientId === 'cid-bg1' || g.white.clientId === 'cid-bg1');
  if (myGame) {
    // 봇 슬롯의 nickname 은 봇 닉이어야 함 (사용자 닉 X)
    const botSide = myGame.black.clientId === '_bot_easy' ? myGame.black : myGame.white;
    assert(botSide.nickname !== userNick,
      `recent_games 의 봇 nickname 이 사용자 닉으로 바뀌면 안 됨, got: ${botSide.nickname}`);
  }
  obs.close();
});

// ============================================================
// Z — 좀비 ws (비행기모드 reconnect 후 옛 ws 지연 close) 시나리오
// ============================================================
// 사용자 보고 버그: A 비행기모드 → 재접속 → 잘 두고 있다가 갑자기 미복귀 판정 (A 패배).
// 가설: 새 ws 로 resume_session 성공 후, 옛 좀비 ws 의 close 가 뒤늦게 fire 되며
//       disconnect handler 가 다시 호출돼 grace timer 가 재시작.

test('Z1: resume 후 옛 좀비 ws 의 지연 close 가 grace timer 재시작하면 안 됨', async () => {
  const { host, guest, hostSid } = await bootstrapRoom({
    hostClientId: 'cid-z1a', guestClientId: 'cid-z1b',
  });
  // host (옛 ws) 는 close 안 함 — 비행기모드 좀비 시뮬레이션

  // 새 ws 로 resume_session
  const host2 = await open();
  sendJson(host2, { type: 'set_nickname', nickname: 'H', clientId: 'cid-z1a' });
  sendJson(host2, { type: 'resume_session', sessionId: hostSid, nickname: 'H' });
  await waitForType(host2, 'resume_success');

  // 잠시 정상 진행 (move 한 번 — '잘 두고 있는' 상태)
  sendJson(host2, { type: 'move', row: 7, col: 7 });
  await waitFor(guest, (m) => m.type === 'move' && m.row === 7 && m.col === 7);

  // 옛 host ws 가 뒤늦게 close — 비행기모드 OFF 후 TCP 정리되며 fire
  host.close();
  guest.received.length = 0;

  // GRACE 만료 시간만큼 대기 — host2 가 패배 처리되면 안 됨
  await sleep(GRACE + 500);
  const abandoned = guest.received.find((m) => m.type === 'opponent_abandoned');
  assert(!abandoned, `옛 ws 의 지연 close 가 grace timer 재시작 시키면 안 됨. got: ${JSON.stringify(abandoned)}`);
  host2.close(); guest.close();
});

test('VIS10: 큐 대기 중 누가 공개 방 만들면 즉시 매칭 (reverse 흐름)', async () => {
  // A 가 먼저 queue_join → 대기 (빈 public 방 없음)
  const waiter = await open();
  sendJson(waiter, { type: 'set_nickname', nickname: 'V10W', clientId: 'cid-vis10-w' });
  sendJson(waiter, { type: 'queue_join', nickname: 'V10W', clientId: 'cid-vis10-w' });
  await waitForType(waiter, 'queue_waiting', 2000);

  // B 가 공개 방 만들기 → A 와 즉시 매칭되어야 함
  const host = await open();
  sendJson(host, { type: 'set_nickname', nickname: 'V10H', clientId: 'cid-vis10-h' });
  sendJson(host, { type: 'create_room', nickname: 'V10H', visibility: 'public' });
  const created = await waitForType(host, 'room_created');
  // B 도 matched 받음 (자기 방에 A 가 합류)
  const hostMatched = await waitForType(host, 'matched', 2000);
  assert(hostMatched.code === created.code);
  // A 도 같은 방으로 matched
  const waiterMatched = await waitForType(waiter, 'matched', 2000);
  assert(waiterMatched.code === created.code, `expected matched into ${created.code}, got ${waiterMatched.code}`);
  await waitForType(host, 'game_start');
  await waitForType(waiter, 'game_start');
  host.close(); waiter.close();
});

test('VIS11: 큐 대기 중 누가 비공개 방 만들면 매칭 안 됨', async () => {
  const waiter = await open();
  sendJson(waiter, { type: 'set_nickname', nickname: 'V11W', clientId: 'cid-vis11-w' });
  sendJson(waiter, { type: 'queue_join', nickname: 'V11W', clientId: 'cid-vis11-w' });
  await waitForType(waiter, 'queue_waiting', 2000);

  // B 가 private 방 만듦 → A 는 그대로 큐 대기
  const host = await open();
  sendJson(host, { type: 'set_nickname', nickname: 'V11H', clientId: 'cid-vis11-h' });
  sendJson(host, { type: 'create_room', nickname: 'V11H', visibility: 'private' });
  await waitForType(host, 'room_created');

  // A 의 received 에 matched 가 오지 않아야 함 — 1초 정도 대기 후 확인
  await sleep(800);
  const matched = waiter.received.find((m) => m.type === 'matched');
  assert(!matched, `private 방 만들기로 큐 대기자가 매칭되면 안 됨, got ${JSON.stringify(matched)}`);

  sendJson(waiter, { type: 'queue_leave' });
  host.close(); waiter.close();
});

// ============================================================
// runner
// ============================================================
(async () => {
  let pass = 0; let fail = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`✓ ${t.name}`);
      pass += 1;
    } catch (e) {
      console.log(`✗ ${t.name}\n    ${e.message}`);
      fail += 1;
    }
    await sleep(150);
  }
  console.log(`\n${pass} passed, ${fail} failed (of ${tests.length})`);
  process.exit(fail === 0 ? 0 : 1);
})();
