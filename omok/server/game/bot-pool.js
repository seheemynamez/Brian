// ============================================================
// 봇 워커 풀 — generateMove 의 동기 CPU 블로킹을 메인 이벤트 루프 밖으로 격리.
// ============================================================
// 워커 thread 들을 미리 띄워두고 라운드로빈으로 요청을 분배한다. 각 워커는 자체
// V8 인스턴스에서 generateMove 를 실행하므로 메인 thread 의 WS / HTTP 처리에
// 영향을 주지 않는다.
//
//   메인 ──postMessage(board, color, diff, id)──▶ worker ──generateMove──▶
//        ◀──postMessage(move, id)─────────────────
//
// id 로 pending Promise 를 추적. 워커가 죽으면 그 워커에 할당된 pending 은 거부
// 후 새 워커로 교체.
// ============================================================

const { Worker } = require('worker_threads');
const path = require('path');

const POOL_SIZE = Math.max(1, Number(process.env.BOT_WORKER_POOL_SIZE) || 2);
const WORKER_PATH = path.resolve(__dirname, 'bot-worker.js');
// Worker 가 hang 또는 너무 느린 경우 응답 cap — 이 시간 후 reject + worker 재시작.
// turn timeout (30s) 보다 여유있게 작게 설정해서 fallback 처리 시간 확보.
const WORKER_TIMEOUT_MS = Number(process.env.BOT_WORKER_TIMEOUT_MS) || 20000;

let nextId = 1;
// id → { resolve, reject, workerIndex }
const pending = new Map();
const workers = new Array(POOL_SIZE).fill(null);
let nextWorker = 0;

const setupWorker = (index) => {
  const w = new Worker(WORKER_PATH);
  w.on('message', (msg) => {
    const { id, move, error } = msg || {};
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve(move || null);
  });
  w.on('error', (err) => {
    console.error(`[bot-pool] worker[${index}] error:`, err && err.message);
    // 이 워커에 할당된 pending 모두 거부
    for (const [id, p] of pending) {
      if (p.workerIndex === index) {
        pending.delete(id);
        p.reject(err);
      }
    }
    // 워커 교체
    workers[index] = setupWorker(index);
  });
  w.on('exit', (code) => {
    if (code !== 0) {
      console.error(`[bot-pool] worker[${index}] exited code=${code}, restarting`);
      // exit 가 error 보다 늦게 올 수 있으나 안전하게 한 번 더 재생성 시도
      if (workers[index] === w) workers[index] = setupWorker(index);
    }
  });
  return w;
};

for (let i = 0; i < POOL_SIZE; i++) workers[i] = setupWorker(i);

const generateMoveAsync = (board, color, difficulty) => {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const workerIndex = nextWorker;
    nextWorker = (nextWorker + 1) % workers.length;
    // Worker hang 또는 과도한 지연 방어 — timeout 시 reject + 해당 worker 강제 재시작.
    const to = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      console.error(`[bot-pool] worker[${workerIndex}] timeout (${WORKER_TIMEOUT_MS}ms) — terminating`);
      const w = workers[workerIndex];
      try { w && w.terminate(); } catch {}
      workers[workerIndex] = setupWorker(workerIndex);
      reject(new Error('worker_timeout'));
    }, WORKER_TIMEOUT_MS);
    pending.set(id, {
      resolve: (v) => { clearTimeout(to); resolve(v); },
      reject:  (e) => { clearTimeout(to); reject(e); },
      workerIndex,
    });
    try {
      workers[workerIndex].postMessage({ id, board, color, difficulty });
    } catch (e) {
      clearTimeout(to);
      pending.delete(id);
      reject(e);
    }
  });
};

module.exports = { generateMoveAsync, POOL_SIZE };
