// ============================================================
// 2048 E2E — recovery / ranking / broadcast / HTTP endpoint 회귀 테스트.
// ============================================================
// 외부에서 띄운 2048 서버에 WS + HTTP 로 붙어 메시지 / 응답을 검증.
// 실행 전제 (npm test 가 자동 처리):
//   STORE_BACKEND=memory HEARTBEAT_INTERVAL_MS=2000 PORT=18082 node server.js
//
// 카테고리:
//   N1-N4  set_nickname (등록 / 변경 / cutoff / 가드)
//   S1-S6  submit_score (첫 등록 / 갱신 / 미갱신 / 가드 / 잘못된 입력)
//   R1-R4  ranking / my_rank
//   B1-B3  broadcast 시나리오 (best 갱신 시 전체에게 push)
//   P1-P2  persistence — best 가 reconnect 후에도 같은 clientId 로 보존 (in-process)
//   D1-D2  daily 모델 (dailyDate / dailyBest)
//   H1-H4  HTTP endpoint (/api/stats, /i/2048 OG meta)
//   M1-M2  기타 (ping/pong, unknown type)
// ============================================================
'use strict';

const WebSocket = require('ws');
const http = require('http');

const PORT = Number(process.env.PORT) || 18082;
const WS_URL = `ws://localhost:${PORT}/ws`;
const HTTP_BASE = `http://localhost:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const open = () => new Promise((resolve, reject) => {
  const ws = new WebSocket(WS_URL);
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

// HTTP GET — Node 빌트인 (의존성 추가 없이).
const httpGet = (path) => new Promise((resolve, reject) => {
  const req = http.get(HTTP_BASE + path, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({
      status: res.statusCode,
      headers: res.headers,
      body: Buffer.concat(chunks).toString('utf-8'),
    }));
  });
  req.on('error', reject);
  req.setTimeout(3000, () => { req.destroy(new Error('http timeout')); });
});

// KST 오늘 (server.js domain/users.js 의 kstDateStr 와 같은 로직).
const todayKst = () => {
  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  return new Date(Date.now() + KST_OFFSET_MS).toISOString().slice(0, 10);
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ============================================================
// N — set_nickname
// ============================================================

test('N1: set_nickname 첫 등록 → nickname_set + user 생성', async () => {
  const ws = await open();
  sendJson(ws, { type: 'set_nickname', clientId: 'cid-N1', nickname: '닉넴1' });
  const res = await waitForType(ws, 'nickname_set');
  assert(res.user.nickname === '닉넴1', `expected nick 닉넴1, got ${res.user.nickname}`);
  assert(res.user.clientId === 'cid-N1', `clientId mismatch`);
  assert(res.user.allTimeBest === 0, `초기 allTimeBest=0 기대`);
  assert(res.user.dailyBest === 0, `초기 dailyBest=0 기대`);
  assert(res.user.dailyDate === todayKst(), `dailyDate=오늘 KST 기대`);
  ws.close();
});

test('N2: set_nickname clientId 없으면 error', async () => {
  const ws = await open();
  sendJson(ws, { type: 'set_nickname', nickname: '닉' });
  const err = await waitForType(ws, 'error', 1000);
  assert(/clientId/.test(err.message), `expected clientId 관련 에러, got ${err.message}`);
  ws.close();
});

test('N3: 14 자 초과 닉 cutoff', async () => {
  const ws = await open();
  sendJson(ws, { type: 'set_nickname', clientId: 'cid-N3', nickname: 'a'.repeat(30) });
  const res = await waitForType(ws, 'nickname_set');
  assert(res.user.nickname.length === 14, `expected 14 자 cutoff, got len=${res.user.nickname.length}`);
  ws.close();
});

test('N4: 닉네임 변경 (score=0) → broadcast 없음', async () => {
  // 점수 없는 사용자가 닉만 바꿔도 다른 사람에게 ranking broadcast 가 가면 안 됨 (트래픽 절약).
  const obs = await open();
  sendJson(obs, { type: 'set_nickname', clientId: 'cid-N4-obs', nickname: '관전자' });
  await waitForType(obs, 'nickname_set');
  // 관전자도 ranking 초기 1번은 받을 수 있으니 clear
  obs.received.length = 0;

  const ws = await open();
  sendJson(ws, { type: 'set_nickname', clientId: 'cid-N4', nickname: '원래닉' });
  await waitForType(ws, 'nickname_set');
  sendJson(ws, { type: 'set_nickname', clientId: 'cid-N4', nickname: '바뀐닉' });
  await waitForType(ws, 'nickname_set');
  await sleep(300);
  const stray = obs.received.find((m) => m.type === 'ranking');
  assert(!stray, `점수 0 사용자의 닉 변경에 ranking broadcast 가 가면 안 됨`);
  ws.close(); obs.close();
});

// ============================================================
// S — submit_score
// ============================================================

test('S1: 첫 점수 등록 → allTime/daily 모두 갱신', async () => {
  const ws = await open();
  sendJson(ws, { type: 'submit_score', clientId: 'cid-S1', nickname: 'S1', score: 1024 });
  const res = await waitForType(ws, 'score_recorded');
  assert(res.allTimeUpdated === true, `allTimeUpdated=true 기대`);
  assert(res.dailyUpdated === true, `dailyUpdated=true 기대`);
  assert(res.user.allTimeBest === 1024, `allTimeBest=1024, got ${res.user.allTimeBest}`);
  assert(res.user.dailyBest === 1024, `dailyBest=1024, got ${res.user.dailyBest}`);
  ws.close();
});

test('S2: 더 낮은 점수 → 갱신 없음', async () => {
  const ws = await open();
  sendJson(ws, { type: 'submit_score', clientId: 'cid-S1', nickname: 'S1', score: 500 });
  const res = await waitForType(ws, 'score_recorded');
  assert(res.allTimeUpdated === false, `lower score 면 allTimeUpdated=false`);
  assert(res.dailyUpdated === false, `lower score 면 dailyUpdated=false`);
  assert(res.user.allTimeBest === 1024, `best 보존, got ${res.user.allTimeBest}`);
  ws.close();
});

test('S3: 더 높은 점수 → 양쪽 갱신', async () => {
  const ws = await open();
  sendJson(ws, { type: 'submit_score', clientId: 'cid-S1', nickname: 'S1', score: 2048 });
  const res = await waitForType(ws, 'score_recorded');
  assert(res.allTimeUpdated === true);
  assert(res.dailyUpdated === true);
  assert(res.user.allTimeBest === 2048, `expected 2048, got ${res.user.allTimeBest}`);
  ws.close();
});

test('S4: 음수 점수 → error', async () => {
  const ws = await open();
  sendJson(ws, { type: 'submit_score', clientId: 'cid-S4', nickname: 'S4', score: -1 });
  const err = await waitForType(ws, 'error', 1000);
  assert(/점수/.test(err.message), `expected 점수 관련 에러, got ${err.message}`);
  ws.close();
});

test('S5: 점수 NaN → error', async () => {
  const ws = await open();
  sendJson(ws, { type: 'submit_score', clientId: 'cid-S5', nickname: 'S5', score: 'NaN' });
  const err = await waitForType(ws, 'error', 1000);
  assert(/점수/.test(err.message));
  ws.close();
});

test('S6: clientId 없음 → error', async () => {
  const ws = await open();
  sendJson(ws, { type: 'submit_score', nickname: 'X', score: 100 });
  const err = await waitForType(ws, 'error', 1000);
  assert(err.message);
  ws.close();
});

// ============================================================
// R — ranking / my_rank
// ============================================================

test('R1: request_ranking → top 10 + 오늘 dailyDate', async () => {
  const ws = await open();
  sendJson(ws, { type: 'request_ranking' });
  const r = await waitForType(ws, 'ranking');
  assert(Array.isArray(r.allTime), `allTime array 기대`);
  assert(Array.isArray(r.daily), `daily array 기대`);
  assert(r.dailyDate === todayKst(), `dailyDate=오늘 KST`);
  // S 시나리오에서 cid-S1 이 2048 로 1 위
  const top = r.allTime[0];
  assert(top && top.clientId === 'cid-S1' && top.score === 2048,
    `top1 expected cid-S1/2048, got ${JSON.stringify(top)}`);
  ws.close();
});

test('R2: request_my_rank → nickname / rank / total', async () => {
  const ws = await open();
  sendJson(ws, { type: 'request_my_rank', clientId: 'cid-S1' });
  const r = await waitForType(ws, 'my_rank');
  assert(r.nickname === 'S1');
  assert(r.allTime.score === 2048);
  assert(r.allTime.rank === 1, `rank=1 기대, got ${r.allTime.rank}`);
  assert(r.allTime.total >= 1, `total >= 1`);
  ws.close();
});

test('R3: request_my_rank 미등록 clientId → null shape (rank/total 0)', async () => {
  const ws = await open();
  sendJson(ws, { type: 'request_my_rank', clientId: 'never-registered-' + Date.now() });
  const r = await waitForType(ws, 'my_rank');
  // domain.getMyRank 가 null 반환 → handler 가 spread → {type:'my_rank'} 만 옴.
  assert(!r.nickname, `미등록 user 면 nickname 없음, got ${r.nickname}`);
  assert(!r.allTime, `미등록 user 면 allTime 없음`);
  ws.close();
});

test('R4: 새 user 가 점수 0 이면 ranking 에 안 보임', async () => {
  const ws = await open();
  sendJson(ws, { type: 'set_nickname', clientId: 'cid-R4-zero', nickname: '점수없는사람' });
  await waitForType(ws, 'nickname_set');
  sendJson(ws, { type: 'request_ranking' });
  const r = await waitForType(ws, 'ranking');
  const me = r.allTime.find((e) => e.clientId === 'cid-R4-zero');
  assert(!me, `점수 0 사용자는 allTime ranking 에 없어야 함`);
  ws.close();
});

// ============================================================
// B — broadcast
// ============================================================

test('B1: best 갱신 시 전체 broadcast (다른 ws 도 ranking 받음)', async () => {
  const obs = await open();
  sendJson(obs, { type: 'set_nickname', clientId: 'cid-B1-obs', nickname: 'B1Obs' });
  await waitForType(obs, 'nickname_set');
  obs.received.length = 0;

  const ws = await open();
  sendJson(ws, { type: 'submit_score', clientId: 'cid-B1', nickname: 'B1', score: 5000 });
  await waitForType(ws, 'score_recorded');

  const r = await waitFor(obs, (m) => m.type === 'ranking', 1500);
  assert(r, `obs 가 ranking broadcast 받아야 함`);
  const found = r.allTime.find((e) => e.clientId === 'cid-B1');
  assert(found && found.score === 5000, `obs ranking 에 B1 5000 보여야`);
  ws.close(); obs.close();
});

test('B2: lower score → broadcast 안 옴 (noise ↓)', async () => {
  const obs = await open();
  sendJson(obs, { type: 'set_nickname', clientId: 'cid-B2-obs', nickname: 'B2Obs' });
  await waitForType(obs, 'nickname_set');

  // 먼저 5000 등록 (B1 시나리오와 분리)
  const ws = await open();
  sendJson(ws, { type: 'submit_score', clientId: 'cid-B2', nickname: 'B2', score: 5000 });
  await waitForType(ws, 'score_recorded');
  await sleep(200);
  obs.received.length = 0;

  // 낮은 점수 재등록 → broadcast 없음
  sendJson(ws, { type: 'submit_score', clientId: 'cid-B2', nickname: 'B2', score: 1000 });
  await waitForType(ws, 'score_recorded');
  await sleep(400);
  const stray = obs.received.find((m) => m.type === 'ranking');
  assert(!stray, `lower score 에는 broadcast 가 가면 안 됨`);
  ws.close(); obs.close();
});

test('B3: 닉네임 변경 (score>0) → broadcast 옴', async () => {
  const obs = await open();
  sendJson(obs, { type: 'set_nickname', clientId: 'cid-B3-obs', nickname: 'B3Obs' });
  await waitForType(obs, 'nickname_set');

  const ws = await open();
  sendJson(ws, { type: 'submit_score', clientId: 'cid-B3', nickname: 'B3원래', score: 3000 });
  await waitForType(ws, 'score_recorded');
  await sleep(200);
  obs.received.length = 0;

  sendJson(ws, { type: 'set_nickname', clientId: 'cid-B3', nickname: 'B3바뀐' });
  await waitForType(ws, 'nickname_set');
  const r = await waitFor(obs, (m) => m.type === 'ranking', 1500);
  assert(r);
  const found = r.allTime.find((e) => e.clientId === 'cid-B3');
  assert(found && found.nickname === 'B3바뀐', `broadcast 에 새 닉 반영 기대, got ${JSON.stringify(found)}`);
  ws.close(); obs.close();
});

// ============================================================
// P — persistence (in-process: ws 끊겨도 같은 clientId 면 best 보존)
// ============================================================

test('P1: ws close 후 새 ws 로 같은 clientId → best 보존', async () => {
  const ws1 = await open();
  sendJson(ws1, { type: 'submit_score', clientId: 'cid-P1', nickname: 'P1', score: 1234 });
  await waitForType(ws1, 'score_recorded');
  ws1.close();
  await sleep(200);

  const ws2 = await open();
  sendJson(ws2, { type: 'request_my_rank', clientId: 'cid-P1' });
  const r = await waitForType(ws2, 'my_rank');
  assert(r.nickname === 'P1', `nickname 보존 기대, got ${r.nickname}`);
  assert(r.allTime.score === 1234, `score 보존 기대, got ${r.allTime.score}`);
  ws2.close();
});

test('P2: store 가 clientId-keyed — 두 다른 ws 가 같은 clientId 면 같은 user', async () => {
  const wsA = await open();
  sendJson(wsA, { type: 'submit_score', clientId: 'cid-P2-shared', nickname: 'Shared', score: 800 });
  await waitForType(wsA, 'score_recorded');

  // 같은 clientId 의 다른 ws 가 더 높은 점수 등록 → 동일 user 의 best 가 갱신
  const wsB = await open();
  sendJson(wsB, { type: 'submit_score', clientId: 'cid-P2-shared', nickname: 'Shared', score: 1600 });
  const r = await waitForType(wsB, 'score_recorded');
  assert(r.user.allTimeBest === 1600, `같은 clientId 의 best 갱신 기대, got ${r.user.allTimeBest}`);
  assert(r.allTimeUpdated === true);
  wsA.close(); wsB.close();
});

// ============================================================
// D — daily 모델
// ============================================================

test('D1: 새 user 의 dailyDate = 오늘 KST', async () => {
  const ws = await open();
  sendJson(ws, { type: 'submit_score', clientId: 'cid-D1', nickname: 'D1', score: 500 });
  const r = await waitForType(ws, 'score_recorded');
  assert(r.user.dailyDate === todayKst(), `dailyDate=${todayKst()} 기대, got ${r.user.dailyDate}`);
  assert(r.user.dailyBest === 500);
  ws.close();
});

test('D2: daily ranking 도 오늘 점수만 포함 (dailyDate 일치)', async () => {
  // D1 의 cid-D1 가 daily 에도 있어야 함.
  const ws = await open();
  sendJson(ws, { type: 'request_ranking' });
  const r = await waitForType(ws, 'ranking');
  const me = r.daily.find((e) => e.clientId === 'cid-D1');
  assert(me, `cid-D1 가 daily ranking 에 있어야 함`);
  assert(me.score === 500);
  ws.close();
});

// ============================================================
// H — HTTP endpoint
// ============================================================

test('H1: GET /api/stats → JSON shape', async () => {
  const res = await httpGet('/api/stats');
  assert(res.status === 200, `200 기대, got ${res.status}`);
  const data = JSON.parse(res.body);
  assert(typeof data.total_users === 'number', `total_users number`);
  assert(typeof data.top_all_time === 'number', `top_all_time number`);
  assert(typeof data.top_daily === 'number', `top_daily number`);
  assert(typeof data.active_ws === 'number', `active_ws number`);
  assert(typeof data.ts === 'string', `ts string`);
  // 앞 시나리오에서 점수 등록한 사용자가 있으니 top_all_time > 0
  assert(data.top_all_time > 0, `이전 시나리오 점수가 반영되어 있어야`);
  assert(res.headers['access-control-allow-origin'] === '*', `CORS 헤더 기대`);
});

test('H2: GET /i/2048/{nick}/{score} → OG meta HTML', async () => {
  const res = await httpGet('/i/2048/' + encodeURIComponent('테스트') + '/4096');
  assert(res.status === 200, `200 기대, got ${res.status}`);
  assert(/text\/html/.test(res.headers['content-type'] || ''), `text/html 기대`);
  assert(/og:title/.test(res.body), `og:title 메타 포함 기대`);
  assert(/4096/.test(res.body), `score=4096 포함 기대`);
  assert(/테스트/.test(res.body), `nick 포함 기대`);
});

test('H3: GET /i/2048 (nick/score 없음) → 기본 HTML', async () => {
  const res = await httpGet('/i/2048');
  assert(res.status === 200, `200 기대, got ${res.status}`);
  assert(/og:title/.test(res.body));
});

test('H4: GET / (unknown) → 404', async () => {
  const res = await httpGet('/something-not-routed');
  assert(res.status === 404, `404 기대, got ${res.status}`);
});

// ============================================================
// M — misc
// ============================================================

test('M1: ping → pong', async () => {
  const ws = await open();
  sendJson(ws, { type: 'ping' });
  const pong = await waitForType(ws, 'pong', 1000);
  assert(pong);
  ws.close();
});

test('M2: unknown type → error', async () => {
  const ws = await open();
  sendJson(ws, { type: 'totally_unknown' });
  const err = await waitForType(ws, 'error', 1000);
  assert(/알 수 없는/.test(err.message), `expected '알 수 없는' 메시지, got ${err.message}`);
  ws.close();
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
    await sleep(80);
  }
  console.log(`\n${pass} passed, ${fail} failed (of ${tests.length})`);
  process.exit(fail === 0 ? 0 : 1);
})();
