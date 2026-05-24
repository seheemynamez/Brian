// ============================================================
// 봇 워커 풀 — generateMove 의 동기 CPU 블로킹을 메인 이벤트 루프 밖으로 격리.
// ============================================================
// 워커 thread 들을 미리 띄워두고 가장 한가한 워커에 요청을 분배한다. 각 워커는
// 자체 V8 인스턴스에서 generateMove 를 실행하므로 메인 thread 의 WS / HTTP 처리에
// 영향을 주지 않는다.
//
//   메인 ──postMessage(board, color, diff, id)──▶ worker ──generateMove──▶
//        ◀──postMessage(move, id)─────────────────
//
// id 로 pending Promise 를 추적. 워커가 죽으면 그 워커에 할당된 pending 은 거부
// 후 새 워커로 교체.
//
// 디스패치 전략 (PR — round-robin 큐잉 회귀 fix):
//   라운드로빈 + busy 체크 없음으로 가면 한 워커가 hard d6 (18s self-abort) 작업
//   진행 중일 때 다음 작업이 같은 워커에 큐잉되어 22s WORKER_TIMEOUT 안에 처리
//   못 하는 케이스 다발 (Render 로그 #116/#118/#121 — same worker 14회 연속 timeout
//   포함). 그래서 dispatch 시점에 busyCount 최소 워커를 우선 선택.
// ============================================================

const { Worker } = require('worker_threads');
const path = require('path');

// 동시 hard d6 (18s) 두 게임 + easy/medium 한 게임 정도까지 큐잉 없이 처리 가능
// 하도록 3 으로 상향 (이전 기본 2). Render free 512MB 기준 worker 1개 추가 ≈ +50MB
// 부담이라 안전 (현재 peak ~134MB).
const POOL_SIZE = Math.max(1, Number(process.env.BOT_WORKER_POOL_SIZE) || 3);
const WORKER_PATH = path.resolve(__dirname, 'bot-worker.js');
// Worker 가 hang 또는 너무 느린 경우 응답 cap — 이 시간 후 reject + worker 재시작.
// turn timeout (30s) 보다 여유있게 작게 설정해서 fallback 처리 시간 확보.
// PR v4: hard 봇 강화로 cfg deadline 최대 20s (hard 15+). margin 5s = 25s.
// turn 30s 대비 fallback 5s — bot self-abort 정확하므로 OK.
const WORKER_TIMEOUT_MS = Number(process.env.BOT_WORKER_TIMEOUT_MS) || 25000;

let nextId = 1;
// id → { resolve, reject, workerIndex }
const pending = new Map();
const workers = new Array(POOL_SIZE).fill(null);
// 워커별 진행 중 작업 수 — 디스패치 시 최소 busy 워커 선택용. setupWorker 가
// pending 정리하면서 같이 감소시킴.
const busyCount = new Array(POOL_SIZE).fill(0);

const setupWorker = (index) => {
  const w = new Worker(WORKER_PATH);
  w.on('message', (msg) => {
    const { id, error } = msg || {};
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (busyCount[p.workerIndex] > 0) busyCount[p.workerIndex]--;
    if (error) {
      p.reject(new Error(error));
      return;
    }
    // worker 의 generateMove 결과 객체 전체 전달 — { move, reachedDepth, cfgMaxDepth,
    // cfgTopK, elapsedMs, aborted }. caller 가 .move 추출 + 로깅에 메타 활용.
    p.resolve(msg);
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
    busyCount[index] = 0;
    // 워커 교체
    workers[index] = setupWorker(index);
  });
  w.on('exit', (code) => {
    if (code !== 0) {
      console.error(`[bot-pool] worker[${index}] exited code=${code}, restarting`);
      // exit 가 error 보다 늦게 올 수 있으나 안전하게 한 번 더 재생성 시도
      if (workers[index] === w) {
        busyCount[index] = 0;
        workers[index] = setupWorker(index);
      }
    }
  });
  return w;
};

for (let i = 0; i < POOL_SIZE; i++) workers[i] = setupWorker(i);

// busy 가장 적은 워커 선택. 동률이면 lower index 우선 (deterministic).
const pickLeastBusyWorker = () => {
  let best = 0;
  for (let i = 1; i < workers.length; i++) {
    if (busyCount[i] < busyCount[best]) best = i;
  }
  return best;
};

const generateMoveAsync = (board, color, difficulty) => {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const workerIndex = pickLeastBusyWorker();
    busyCount[workerIndex]++;
    // Worker hang 또는 과도한 지연 방어 — timeout 시 reject + 해당 worker 강제 재시작.
    const to = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      console.error(`[bot-pool] worker[${workerIndex}] timeout (${WORKER_TIMEOUT_MS}ms) — terminating`);
      const w = workers[workerIndex];
      try { w && w.terminate(); } catch {}
      busyCount[workerIndex] = 0;
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
      if (busyCount[workerIndex] > 0) busyCount[workerIndex]--;
      reject(e);
    }
  });
};

module.exports = { generateMoveAsync, POOL_SIZE };
