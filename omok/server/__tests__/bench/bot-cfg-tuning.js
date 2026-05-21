// ============================================================
// PR #83 cfg 튜닝 벤치 — topK 변경의 cfgMax 도달율 영향 측정 (local Mac)
// ============================================================
// 실행: node __tests__/bench/bot-cfg-tuning.js
//
// 각 cfg 케이스에 대해 ID (depth 1~maxDepth, TT 공유, timeout) 시뮬레이션 후
// cfgMax 도달 여부 + elapsed 측정.
// 다양한 stones 와 시드로 평균 도달율 추정.
// ============================================================

'use strict';

const { generateMove } = require('../../game/bot');

const SIZE = 15;
const empty = () => Array.from({ length: SIZE }, () => Array(SIZE).fill(0));

const buildBoard = (n, seed) => {
  const b = empty();
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  let placed = 0, attempts = 0;
  while (placed < n && attempts < 5000) {
    attempts++;
    const r = Math.floor(rand() * SIZE), c = Math.floor(rand() * SIZE);
    if (b[r][c] !== 0) continue;
    const color = (placed % 2 === 0) ? 1 : 2;
    b[r][c] = color;
    let bad = false;
    for (const [dr, dc] of [[0,1],[1,0],[1,1],[1,-1]]) {
      let cnt = 1;
      for (let i = 1; i < 5; i++) {
        const nr=r+dr*i, nc=c+dc*i;
        if (nr<0||nr>=SIZE||nc<0||nc>=SIZE||b[nr][nc]!==color) break;
        cnt++;
      }
      for (let i = 1; i < 5; i++) {
        const nr=r-dr*i, nc=c-dc*i;
        if (nr<0||nr>=SIZE||nc<0||nc>=SIZE||b[nr][nc]!==color) break;
        cnt++;
      }
      if (cnt >= 5) { bad = true; break; }
    }
    if (bad) { b[r][c] = 0; continue; }
    placed++;
  }
  return b;
};

// 자기 돌 N개 짜리 보드 — 사용자가 N번째 두는 시점
// generateMove(board, color, difficulty) — board 의 colorNumOf(color) 돌이 자기 돌
// stones N 개 보드 + 자기 색에 따라 자기 돌 수가 N/2 정도.
// 정확한 자기 N수 시점 시뮬레이션: board 에 N×2 또는 N×2-1 돌 (양 색 번갈아).
// generateMove(b, 'black') → black 돌 수가 N 이어야 자기 N 시점.

// 새 cfg 케이스
const CASES = [
  // [name, difficulty, myStones target, simulated full board stones]
  { name: 'easy', diff: 'easy', stonesList: [0, 5, 10, 20] },
  { name: 'medium 자기<5 (d3×t10×2s)',  diff: 'medium', stonesList: [0, 4, 8] },        // 0~9 (자기 0~4)
  { name: 'medium 자기 5+ (d4×t8×4s)',  diff: 'medium', stonesList: [10, 20, 30, 50] }, // 자기 5~25
  { name: 'hard 자기<5 (d4×t8×5s)',     diff: 'hard',   stonesList: [0, 4, 8] },
  { name: 'hard 자기 5-14 (d5×t8×12s)', diff: 'hard',   stonesList: [10, 20, 28] },
  { name: 'hard 자기 15+ (d6×t7×18s)',  diff: 'hard',   stonesList: [30, 40, 60] },
];

const seeds = [42, 137, 271];

console.log('=== PR #83 cfg 튜닝 — 로컬 Mac generateMove 벤치 ===');
console.log('(각 stones 별 3 seed 평균, ID + TT 공유)\n');
console.log('case                                 stones  avg_elap  max_elap  cfgMax 도달 (n/N)');
console.log('-'.repeat(90));

for (const c of CASES) {
  for (const n of c.stonesList) {
    const elaps = [], reaches = [], cfgMaxes = [];
    for (const seed of seeds) {
      const b = buildBoard(n, seed);
      // board 의 black 수
      const color = 'black';
      // 1번째 warm
      const r0 = generateMove(b, color, c.diff);
      const r = generateMove(b, color, c.diff);
      elaps.push(r.elapsedMs);
      reaches.push(r.reachedDepth);
      cfgMaxes.push(r.cfgMaxDepth);
    }
    const avg = Math.round(elaps.reduce((a,b)=>a+b,0) / elaps.length);
    const mx  = Math.max(...elaps);
    const cfgMax = cfgMaxes[0];
    const reachedMax = reaches.filter(r => r === cfgMax).length;
    const reachDist = {};
    for (const r of reaches) reachDist[r] = (reachDist[r]||0)+1;
    console.log(`${c.name.padEnd(36)} s=${n.toString().padStart(2)}      ${avg.toString().padStart(5)}ms   ${mx.toString().padStart(5)}ms   ${reachedMax}/${seeds.length} (cfgMax=${cfgMax}) reach=${JSON.stringify(reachDist)}`);
  }
  console.log('');
}
