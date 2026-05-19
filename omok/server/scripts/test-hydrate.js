// ============================================================
// Boot hydrate 자동화 — valkey backend 에서 reboot 후 state 복구 검증.
//
// 시나리오:
//   1. 서버 띄움 (valkey, PREFIX=omok:test)
//   2. PVP 방 생성 + 한 수 두기 (board[7][7]=black)
//   3. 서버 SIGTERM
//   4. 서버 재시작 → valkey 에서 hydrate
//   5. 새 ws 로 resume_session → board[7][7] 가 보존됐는지 확인
//
// 실행: node --env-file-if-exists=.env scripts/test-hydrate.js
// ============================================================

'use strict';

const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 18082;
const URL = `ws://127.0.0.1:${PORT}/ws`;

// ---- WS 헬퍼 (recovery.test.js 와 동일 패턴) ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const open = () => new Promise((resolve, reject) => {
  const ws = new WebSocket(URL);
  ws.received = [];
  const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('ws open timeout')); }, 5000);
  ws.on('message', (raw) => {
    try { ws.received.push(JSON.parse(raw.toString())); } catch {}
  });
  ws.on('open', () => { clearTimeout(timer); resolve(ws); });
  ws.on('error', (e) => { clearTimeout(timer); reject(e); });
});
const sendJson = (ws, msg) => ws.send(JSON.stringify(msg));
const waitFor = async (ws, pred, timeoutMs = 5000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = ws.received.find(pred);
    if (found) return found;
    await sleep(20);
  }
  throw new Error(`waitFor timeout (${timeoutMs}ms). Last few: ${JSON.stringify(ws.received.slice(-3))}`);
};
const waitForType = (ws, type, timeoutMs) => waitFor(ws, (m) => m.type === type, timeoutMs);
const assert = (cond, msg) => { if (!cond) throw new Error(`ASSERT FAILED: ${msg}`); };

// ---- 서버 child process 관리 ----
const startServer = () => {
  const env = {
    ...process.env,
    STORE_BACKEND: 'valkey',
    VALKEY_KEY_PREFIX: 'omok:test',
    PORT: String(PORT),
    STATIC_ROOT: '.',
    BOT_OFFER_DELAY_MS: '1000',
    // resume 위해 grace 길게 — 테스트는 즉시 resume 하지만 안전 마진.
    DISCONNECT_GRACE_MS: '60000',
    SPECTATOR_DISCONNECT_GRACE_MS: '60000',
  };
  const proc = spawn('node', ['--env-file-if-exists=.env', 'server.js'], { env });
  proc.stdoutData = '';
  proc.stdout.on('data', (d) => {
    proc.stdoutData += d.toString();
    process.stdout.write(`  [srv] ${d}`);
  });
  proc.stderr.on('data', (d) => process.stderr.write(`  [srv-err] ${d}`));
  return proc;
};

const waitForServerReady = async (proc, timeoutMs = 30000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (proc.stdoutData.includes('[store_ready]')) return;
    await sleep(200);
  }
  throw new Error('server failed to reach [store_ready]');
};

const stopServer = (proc) => new Promise((resolve) => {
  if (!proc || proc.exitCode != null) return resolve();
  proc.once('exit', () => resolve());
  proc.kill('SIGTERM');
  setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
});

// ---- omok:test:* 키 청소 ----
const cleanupKeys = async () => {
  try {
    const Redis = require('ioredis');
    const url = process.env.VALKEY_URL;
    if (!url) return;
    const client = new Redis(url, { connectTimeout: 10000, maxRetriesPerRequest: 3 });
    let cursor = '0';
    let total = 0;
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', 'omok:test:*', 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) { await client.del(...keys); total += keys.length; }
    } while (cursor !== '0');
    await client.quit();
    console.log(`[hydrate] cleanup: deleted ${total} keys`);
  } catch (e) {
    console.error('[hydrate] cleanup failed:', e && e.message);
  }
};

// ---- 메인 시나리오 ----
const main = async () => {
  let server;
  let exitCode = 1;
  try {
    if (!process.env.VALKEY_URL) {
      throw new Error('VALKEY_URL not set. Run via: npm run test:hydrate (uses .env)');
    }

    console.log('=== Phase 1: start server ===');
    server = startServer();
    await waitForServerReady(server);
    console.log('  server ready\n');

    console.log('=== Phase 2: create PVP room, make 1 move ===');
    const host = await open();
    sendJson(host, { type: 'set_nickname', nickname: 'Host', clientId: 'cid-hydrate-host' });
    sendJson(host, { type: 'create_room', nickname: 'Host' });
    const created = await waitForType(host, 'room_created');
    const code = created.code;
    console.log(`  room created: code=${code}`);

    const guest = await open();
    sendJson(guest, { type: 'set_nickname', nickname: 'Guest', clientId: 'cid-hydrate-guest' });
    sendJson(guest, { type: 'join_room', code, nickname: 'Guest' });
    const hostStart = await waitForType(host, 'game_start');
    const guestStart = await waitForType(guest, 'game_start');
    const hostSid = hostStart.sessionId;
    const hostColor = hostStart.you || hostStart.color;
    const guestColor = guestStart.you || guestStart.color;
    console.log(`  host=${hostColor} sid=${String(hostSid).slice(0, 6)}... guest=${guestColor}`);

    // black 이 첫 수. host 가 black 일 거 (createRoom 의 흑 우선 배정).
    const blackWs = (hostColor === 'black') ? host : guest;
    sendJson(blackWs, { type: 'move', row: 7, col: 7 });
    const moveMsg = await waitForType(host, 'move');
    assert(moveMsg.row === 7 && moveMsg.col === 7, `move ack mismatch`);
    console.log(`  black moved (7,7)\n`);

    // 두 ws 모두 close — grace timer 가 등록되지만 60s 라 충분.
    host.close();
    guest.close();
    await sleep(300);

    console.log('=== Phase 3: SIGTERM server ===');
    await stopServer(server);
    server = null;
    console.log('  server stopped\n');

    console.log('=== Phase 4: restart server, hydrate from valkey ===');
    server = startServer();
    await waitForServerReady(server);
    console.log('  server ready (hydrated)\n');

    console.log('=== Phase 5: resume host session ===');
    const host2 = await open();
    sendJson(host2, { type: 'resume_session', sessionId: hostSid, clientId: 'cid-hydrate-host', nickname: 'Host' });
    const resumed = await waitForType(host2, 'resume_success', 10000);

    // 검증
    assert(resumed.code === code, `code mismatch: got ${resumed.code} expected ${code}`);
    assert(resumed.you === hostColor, `color mismatch: got ${resumed.you} expected ${hostColor}`);
    assert(resumed.status === 'playing', `status not playing: ${resumed.status}`);
    const board = resumed.board;
    assert(Array.isArray(board) && Array.isArray(board[7]), 'board structure invalid');
    assert(board[7][7] !== 0, `board[7][7] should be preserved, got ${board[7][7]}`);
    // black = 1 일 확률 (관례). 확인:
    const blackVal = hostColor === 'black' ? 1 : 2;
    assert(board[7][7] === blackVal, `board[7][7]=${board[7][7]} expected ${blackVal} (${hostColor})`);
    console.log(`  ✓ resume_success: code=${resumed.code}, you=${resumed.you}, status=${resumed.status}`);
    console.log(`  ✓ board[7][7]=${board[7][7]} (preserved across reboot)\n`);

    host2.close();
    await sleep(200);

    console.log('✓ HYDRATE TEST PASSED');
    exitCode = 0;
  } catch (e) {
    console.error('\n✗ HYDRATE TEST FAILED:', e && e.message);
    exitCode = 1;
  } finally {
    if (server) try { await stopServer(server); } catch {}
    await cleanupKeys();
    process.exit(exitCode);
  }
};

main();
