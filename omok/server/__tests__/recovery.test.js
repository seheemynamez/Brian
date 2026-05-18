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

test('T9: bot game player disconnect → no grace', async () => {
  const ws = await open();
  sendJson(ws, { type: 'set_nickname', nickname: 'Me', clientId: 'cid-T9' });
  sendJson(ws, { type: 'create_bot_game', difficulty: 'easy', first: 'me', nickname: 'Me' });
  await waitForType(ws, 'game_start');
  ws.close();
  await sleep(200);
  const observer = await open();
  sendJson(observer, { type: 'request_rooms_list' });
  const list = await waitForType(observer, 'rooms_list');
  const lingering = list.rooms.filter((r) => r.nicknames.black === 'Me' || r.nicknames.white === 'Me');
  assert(lingering.length === 0, `bot room still lingers: ${JSON.stringify(lingering)}`);
  observer.close();
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

test('P2: rate-limit bucket is per-clientId (Phase 3)', async () => {
  // 같은 clientId 로 create_room 4번 → 4번째는 한도 초과 (limit=3/10s).
  const ws1 = await open();
  sendJson(ws1, { type: 'set_nickname', nickname: 'L', clientId: 'cid-P2-shared' });
  for (let i = 0; i < 3; i++) {
    sendJson(ws1, { type: 'create_room', nickname: 'L' });
    await waitForType(ws1, 'room_created', 1500);
    sendJson(ws1, { type: 'leave_room' });
    await sleep(50);
  }
  // 4번째 — limit hit
  sendJson(ws1, { type: 'create_room', nickname: 'L' });
  await sleep(200);
  const errLimit = ws1.received.filter((m) => m.type === 'error' && /다시 시도/.test(m.message));
  assert(errLimit.length >= 1, `expected rate-limit error after 4th create_room, got ${errLimit.length}`);
  ws1.close();
});

test('P3: 같은 clientId 새 ws 도 한도 유지 (새로고침 우회 방지)', async () => {
  // 옛 ws 에서 3번 create_room → 새 ws (다른 connectionId, 같은 clientId) 가 4번째
  //  → 여전히 한도 hit.
  const ws1 = await open();
  sendJson(ws1, { type: 'set_nickname', nickname: 'L', clientId: 'cid-P3-shared' });
  for (let i = 0; i < 3; i++) {
    sendJson(ws1, { type: 'create_room', nickname: 'L' });
    await waitForType(ws1, 'room_created', 1500);
    sendJson(ws1, { type: 'leave_room' });
    await sleep(50);
  }
  ws1.close();
  await sleep(200);
  // 새 connection 같은 clientId
  const ws2 = await open();
  sendJson(ws2, { type: 'set_nickname', nickname: 'L', clientId: 'cid-P3-shared' });
  sendJson(ws2, { type: 'create_room', nickname: 'L' });
  await sleep(200);
  const errLimit = ws2.received.filter((m) => m.type === 'error' && /다시 시도/.test(m.message));
  assert(errLimit.length >= 1, `expected rate-limit on new connection with same clientId, got ${errLimit.length}`);
  ws2.close();
});

test('P3b: 다른 clientId 새 ws → 깨끗한 bucket', async () => {
  const ws1 = await open();
  sendJson(ws1, { type: 'set_nickname', nickname: 'L', clientId: 'cid-P3b-old' });
  for (let i = 0; i < 3; i++) {
    sendJson(ws1, { type: 'create_room', nickname: 'L' });
    await waitForType(ws1, 'room_created', 1500);
    sendJson(ws1, { type: 'leave_room' });
    await sleep(50);
  }
  ws1.close();
  await sleep(200);
  // 다른 clientId — 새 bucket
  const ws2 = await open();
  sendJson(ws2, { type: 'set_nickname', nickname: 'L2', clientId: 'cid-P3b-fresh' });
  sendJson(ws2, { type: 'create_room', nickname: 'L2' });
  await waitForType(ws2, 'room_created', 1500);
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
// Phase 4+5 — JSON 직렬화 가능한 room state
// ============================================================

test('J1: getSerializableRoomState 출력에 비-직렬화 타입 없음', async () => {
  // 직접 module 을 require 해서 state shape 확인. server 와 같은 cwd 라 가능.
  const rooms = require('../rooms');
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
  const ser = rooms.getSerializableRoomState(room);
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
  const rooms = require('../rooms');
  const room = rooms.createRoom('NOTM');
  rooms.setRoom('NOTM', room);
  for (const banned of ['turnTimer', 'botMoveTimer', 'botOfferTimer', 'disconnectTimers']) {
    assert(!(banned in room), `room should not have ${banned} (moved to room-runtime)`);
  }
  rooms.deleteRoom('NOTM');
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
