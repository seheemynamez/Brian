// ============================================================
// 봇 search 성능 벤치마크 — stones × depth 매트릭스
// ============================================================
// 실행: node __tests__/bench/bot-perf.js
//
// 측정 대상:
//   A. 단일 searchBestMove(depth=N) — depth 별 단독 시간
//   B. ID 시뮬레이션 (depth 1→N, TT 공유) — 실제 generateMove 흐름
//   C. ID 시뮬레이션 (TT 미사용) — TT 효과 격리 측정
// ============================================================

'use strict';

const { searchBestMove } = require('../../game/bot');

const SIZE = 15;
const empty = () => Array.from({ length: SIZE }, () => Array(SIZE).fill(0));

// stones N개 결정적 배치 — 시드 고정한 LCG, 5목 즉시 생성 방지.
const buildBoard = (n, seed = 42) => {
  const b = empty();
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  let placed = 0;
  let attempts = 0;
  while (placed < n && attempts < 5000) {
    attempts++;
    const r = Math.floor(rand() * SIZE);
    const c = Math.floor(rand() * SIZE);
    if (b[r][c] !== 0) continue;
    const color = (placed % 2 === 0) ? 1 : 2;
    b[r][c] = color;
    let bad = false;
    for (const [dr, dc] of [[0,1],[1,0],[1,1],[1,-1]]) {
      let cnt = 1;
      for (let i = 1; i < 5; i++) {
        const nr = r+dr*i, nc = c+dc*i;
        if (nr<0||nr>=SIZE||nc<0||nc>=SIZE||b[nr][nc]!==color) break;
        cnt++;
      }
      for (let i = 1; i < 5; i++) {
        const nr = r-dr*i, nc = c-dc*i;
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

const CASES = [1, 5, 10, 15, 20, 30];

const measureMs = (fn) => {
  const t0 = process.hrtime.bigint();
  fn();
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1e6;
};

// A) 단일 depth — TT 무사용 (한 호출 안에 cache 효과 작음).
console.log('=== A) 단일 searchBestMove 호출 (depth 별) ===');
console.log('| stones | d3 | d4 | d5 | d6 |');
console.log('|--------|------|------|------|------|');
for (const n of CASES) {
  const b = buildBoard(n);
  const color = (n % 2 === 0) ? 'black' : 'white';
  if (n === 1) { searchBestMove(b, color, 3, 10); }  // warmup
  const row = [`s${n}`];
  for (const d of [3, 4, 5, 6]) {
    const ms = measureMs(() => searchBestMove(b, color, d, 10));
    row.push(`${ms.toFixed(0)}ms`);
  }
  console.log('| ' + row.join(' | ') + ' |');
}

// B) ID 시뮬레이션 — TT 공유 (실제 generateMove 흐름)
console.log('\n=== B) ID 시뮬레이션 (TT 공유) — generateMove 실제 흐름 ===');
console.log('각 셀: depth=N 까지의 누적 elapsed (d1+d2+...+dN, TT 공유 효과 반영)');
console.log('| stones | d3 | d4 | d5 | d6 |');
console.log('|--------|------|------|------|------|');
for (const n of CASES) {
  const b = buildBoard(n);
  const color = (n % 2 === 0) ? 'black' : 'white';
  const tt = new Map();
  let cum = 0;
  const row = [`s${n}`];
  for (let d = 1; d <= 6; d++) {
    cum += measureMs(() => searchBestMove(b, color, d, 10, { tt }));
    if (d >= 3) row.push(`${cum.toFixed(0)}ms`);
  }
  console.log('| ' + row.join(' | ') + ' |');
}

// C) ID 시뮬레이션 — TT 미사용 (Step 1 만 적용된 상태 비교용)
console.log('\n=== C) ID 시뮬레이션 (TT 미사용) — TT 효과 격리 ===');
console.log('| stones | d3 | d4 | d5 | d6 |');
console.log('|--------|------|------|------|------|');
for (const n of CASES) {
  const b = buildBoard(n);
  const color = (n % 2 === 0) ? 'black' : 'white';
  let cum = 0;
  const row = [`s${n}`];
  for (let d = 1; d <= 6; d++) {
    cum += measureMs(() => searchBestMove(b, color, d, 10));  // no tt
    if (d >= 3) row.push(`${cum.toFixed(0)}ms`);
  }
  console.log('| ' + row.join(' | ') + ' |');
}

// B vs C 의 차이 = TT 효과
console.log('\n=== TT 효과 = (C - B) / C × 100% (ID 누적 시간 단축율) ===');
