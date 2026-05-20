// ============================================================
// 봇 generateMove 를 메인 이벤트 루프와 분리해서 실행하는 워커.
// ============================================================
// parentPort 로부터 { id, board, color, difficulty } 받아 generateMove 실행 후
// { id, move, reachedDepth, cfgMaxDepth, cfgTopK, elapsedMs, aborted } 또는
// { id, error } 로 응답.
//
// generateMove 자체가 Iterative Deepening + AbortController(timeoutMs) 처리 →
// worker 는 단순 wrapper. worker 의 메시지 timeout (bot-pool.js, ~22s) 은 안전망 —
// generateMove 의 soft limit (default 20s for hard) 이 그 전에 self-abort.
//
// 워커는 main 과 메모리를 공유하지 않음 — postMessage 가 structured clone 으로
// board (2D 배열) 를 워커로 깊은 복사. 워커는 자체 board copy 위에서 계산하므로
// main 의 room.board 가 변해도 워커는 영향 없음. 안전.
// ============================================================

const { parentPort } = require('worker_threads');
const { generateMove } = require('./bot');

parentPort.on('message', (msg) => {
  const { id, board, color, difficulty } = msg || {};
  try {
    const result = generateMove(board, color, difficulty);
    parentPort.postMessage({ id, ...result });
  } catch (e) {
    parentPort.postMessage({ id, error: String(e && e.message || e) });
  }
});
