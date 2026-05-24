// ============================================================
// Bot Iterative Deepening 동작 검증 — abort 시 마지막 완성 depth best 반환.
// ============================================================
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { generateMove, searchBestMove, getDynamicConfig, countMyStones } = require('../../game/bot');

const SIZE = 15;
const empty = () => Array.from({ length: SIZE }, () => Array(SIZE).fill(0));

// 특정 color 의 돌 N개 짜리 보드 — 흩어진 자리에 N개 동색 돌만 배치.
// dynamic cfg 의 "자기 돌" 기준 (<5 / <15 / 15+) 테스트 전용.
// (실제 게임이라면 흑백 번갈아 두지만 cfg 테스트는 my-stones 만 보므로 단색이면 충분.)
const boardWithMyStones = (n, color = 'black') => {
  const b = empty();
  const me = color === 'black' ? 1 : 2;
  let placed = 0;
  // 15×15 / 2 = 112+ 자리 충분. row+col 짝수 만 채워서 5목 안 만들어짐.
  for (let r = 0; r < SIZE && placed < n; r += 2) {
    for (let c = 0; c < SIZE && placed < n; c += 2) {
      b[r][c] = me;
      placed++;
    }
  }
  return b;
};

describe('Bot ID — generateMove 반환 shape + 깊이 도달', () => {
  test('easy: d2 까지 도달, move 반환', () => {
    const b = empty();
    b[7][7] = 2;
    const r = generateMove(b, 'black', 'easy');
    assert.ok(r.move, 'move 필요');
    assert.equal(r.cfgMaxDepth, 2);
    assert.equal(r.cfgTopK, 2);   // PR — t3→2 (약화)
    assert.equal(r.reachedDepth, 2);  // easy 는 무조건 d2 까지 — 매우 빠름
    assert.ok(typeof r.elapsedMs === 'number');
    assert.equal(r.aborted, false);
  });

  test('medium: 초반 (자기<5) maxDepth 3 — 동적 cfg', () => {
    const b = empty();
    b[7][7] = 2;
    const r = generateMove(b, 'black', 'medium');
    assert.ok(r.move);
    assert.equal(r.cfgMaxDepth, 3);   // 자기 black=0 → medium 초반 cfg
    assert.ok(r.reachedDepth >= 1, '최소 d1 까지는 도달');
    assert.ok(r.reachedDepth <= 3, 'cfgMaxDepth 이내');
  });

  test('hard: 초반 (자기<5) maxDepth 4 — 동적 cfg', () => {
    const b = empty();
    b[7][7] = 2;
    const r = generateMove(b, 'black', 'hard');
    assert.ok(r.move);
    assert.equal(r.cfgMaxDepth, 4);   // 자기 black=0 → hard 초반 cfg (αβ 약해서 d4 까지만)
    assert.ok(r.reachedDepth >= 1);
    assert.ok(r.reachedDepth <= 4);
  });
});

describe('Bot ID — countMyStones — 자기 색 돌만 카운트', () => {
  test('흑백 섞인 보드에서 black 만 / white 만 각각 정확히 카운트', () => {
    const b = empty();
    b[0][0] = 1; b[0][2] = 1; b[0][4] = 1;   // black 3개
    b[2][0] = 2; b[2][2] = 2;                // white 2개
    assert.equal(countMyStones(b, 'black'), 3);
    assert.equal(countMyStones(b, 'white'), 2);
  });

  test('빈 보드 — 양 색 모두 0', () => {
    const b = empty();
    assert.equal(countMyStones(b, 'black'), 0);
    assert.equal(countMyStones(b, 'white'), 0);
  });
});

describe('Bot ID — getDynamicConfig 자기 돌 수 별 매핑', () => {
  test('easy: 자기 돌 수 무관 — d2×t2×1s 고정 (PR — t3→2 약화)', () => {
    assert.deepEqual(getDynamicConfig(empty(), 'black', 'easy'),
      { maxDepth: 2, topK: 2, timeoutMs: 1000 });
    assert.deepEqual(getDynamicConfig(boardWithMyStones(20, 'black'), 'black', 'easy'),
      { maxDepth: 2, topK: 2, timeoutMs: 1000 });
  });

  test('medium: 단계 분기 제거 — 모든 stones 에서 d3×t8×2s (PR v5 — 약화 통합)', () => {
    // 의도: Bronze 상위 + Silver 5:5. v4 (5+ d4×t6) 가 Bronze 95%/Silver 74% 봇승률로 너무 강함.
    const expected = { maxDepth: 3, topK: 8, timeoutMs: 2000 };
    for (const stones of [0, 4, 5, 14, 15, 30]) {
      assert.deepEqual(
        getDynamicConfig(boardWithMyStones(stones, 'black'), 'black', 'medium'),
        expected,
        `stones=${stones} 에서 단일 cfg 기대`
      );
    }
  });

  test('hard: 자기<5 → d4×t10×10s / 5-14 → d5×t7×15s / 15+ → d6×t5×20s (PR v4 — 강화)', () => {
    // 자기 < 5: d4 × t10 × 10s (강화 — 트리 2.4x, 시간 2x → 도달율 ~70%)
    assert.deepEqual(getDynamicConfig(boardWithMyStones(0, 'white'), 'white', 'hard'),
      { maxDepth: 4, topK: 10, timeoutMs: 10000 });
    assert.deepEqual(getDynamicConfig(boardWithMyStones(4, 'white'), 'white', 'hard'),
      { maxDepth: 4, topK: 10, timeoutMs: 10000 });
    // 자기 5-14: d5 × t7 × 15s (강화 — 트리 2.2x, 시간 1.25x → 도달율 ~60-65%)
    assert.deepEqual(getDynamicConfig(boardWithMyStones(5, 'white'), 'white', 'hard'),
      { maxDepth: 5, topK: 7, timeoutMs: 15000 });
    assert.deepEqual(getDynamicConfig(boardWithMyStones(14, 'white'), 'white', 'hard'),
      { maxDepth: 5, topK: 7, timeoutMs: 15000 });
    // 자기 15+: d6 × t5 × 20s (시간만 18→20s, topK 유지 → 도달율 ~65-70%)
    assert.deepEqual(getDynamicConfig(boardWithMyStones(15, 'white'), 'white', 'hard'),
      { maxDepth: 6, topK: 5, timeoutMs: 20000 });
    assert.deepEqual(getDynamicConfig(boardWithMyStones(20, 'white'), 'white', 'hard'),
      { maxDepth: 6, topK: 5, timeoutMs: 20000 });
  });

  test('상대 돌은 분기에 영향 X — 자기 black 0개 + 상대 white 20개 → 초반 cfg', () => {
    const b = boardWithMyStones(20, 'white');  // white 만 20개
    // black 입장에선 자기 돌 0 → 초반 cfg
    assert.equal(getDynamicConfig(b, 'black', 'hard').maxDepth, 4);
    assert.equal(getDynamicConfig(b, 'black', 'hard').timeoutMs, 10000);   // PR v4: 5→10s
    // white 입장에선 자기 돌 20 → 후반 cfg
    assert.equal(getDynamicConfig(b, 'white', 'hard').maxDepth, 6);
    assert.equal(getDynamicConfig(b, 'white', 'hard').timeoutMs, 20000);   // PR v4: 18→20s
  });

  test('topK 정책 — cfgMax 도달율 50%+ 목표로 cfg 별 차등 (PR v5 — medium 약화)', () => {
    // easy = 2
    assert.equal(getDynamicConfig(empty(), 'black', 'easy').topK, 2);
    // medium = 8 (PR v5 — 단계 분기 제거, 모든 stones 에서 동일)
    assert.equal(getDynamicConfig(boardWithMyStones(0, 'black'), 'black', 'medium').topK, 8);
    assert.equal(getDynamicConfig(boardWithMyStones(10, 'black'), 'black', 'medium').topK, 8);
    // hard d4 (초반) = **10** (PR v4 — t8→10, 강화)
    assert.equal(getDynamicConfig(boardWithMyStones(0, 'black'), 'black', 'hard').topK, 10);
    // hard d5 (자기 5-14) = **7** (PR v4 — t6→7, 강화)
    assert.equal(getDynamicConfig(boardWithMyStones(10, 'black'), 'black', 'hard').topK, 7);
    // hard d6 (자기 15+) = 5 (PR v3 그대로, 시간만 18→20s)
    assert.equal(getDynamicConfig(boardWithMyStones(20, 'black'), 'black', 'hard').topK, 5);
  });

  test('worker_timeout 25s 안전 margin — 모든 cfg 의 timeoutMs ≤ 20s (margin ≥ 5s) (PR v4)', () => {
    for (const diff of ['easy', 'medium', 'hard']) {
      for (const s of [0, 4, 5, 14, 15, 30]) {
        const cfg = getDynamicConfig(boardWithMyStones(s, 'black'), 'black', diff);
        assert.ok(cfg.timeoutMs <= 20000, `${diff} 자기${s}수 timeoutMs=${cfg.timeoutMs} > 20s`);
      }
    }
  });
});

describe('Bot ID — 5목 즉시 발견 (winning move) 시 ID 조기 종료', () => {
  test('5목 가능한 직전 상태: d1 에서도 win 발견 → ID 종료, hard 도 d1 reached', () => {
    // 흑 (7,4)(7,5)(7,6)(7,7) 4 in a row → (7,3) 또는 (7,8) 두면 5목.
    const b = empty();
    b[7][4] = 1; b[7][5] = 1; b[7][6] = 1; b[7][7] = 1;
    const r = generateMove(b, 'black', 'hard');
    assert.ok(r.move);
    // 5목 만드는 자리 — (7,3) 또는 (7,8) 둘 중 하나.
    const isWinMove = (r.move[0] === 7 && (r.move[1] === 3 || r.move[1] === 8));
    assert.ok(isWinMove, `winning move 기대, got [${r.move}]`);
    // reachedDepth 은 1 일 수 있고 더 깊이 갈 수도 있지만 cfgMaxDepth 까지 안 감
    // (win 발견 시 ID break). 단 d1 에서만 win 잡힌다고 보장 X — αβ 가지치기 / move ordering
    // 따라 다름. 일단 reached <= cfgMaxDepth + move 가 win 자리이기만 하면 OK.
    // stones=4 → hard 초반 cfg = d4. (dynamic cfg, PR #81.)
    assert.equal(r.cfgMaxDepth, 4);
    assert.ok(r.reachedDepth >= 1 && r.reachedDepth <= r.cfgMaxDepth);
  });
});

describe('Bot ID — abort 시나리오', () => {
  test('반환 shape — aborted bool, elapsedMs number, cfgMaxDepth/cfgTopK 일치', () => {
    const b = empty();
    b[7][7] = 2;
    const r = generateMove(b, 'black', 'easy');
    assert.equal(typeof r.aborted, 'boolean');
    assert.equal(typeof r.elapsedMs, 'number');
    assert.equal(typeof r.reachedDepth, 'number');
    assert.equal(typeof r.cfgMaxDepth, 'number');
    assert.equal(typeof r.cfgTopK, 'number');
  });

  // 핵심: deadline 발동 검증 — PR #78 의 hotfix 회귀 방지.
  // 이전 AbortController + setTimeout 방식은 worker 의 동기 흐름 점령으로 abort 안 됨.
  // deadline 직접 비교 (Date.now() > deadline) 가 동기 안에서도 발동하는지.
  test('짧은 timeoutMs 강제 시 hard 봇 aborted=true + reached < cfgMaxDepth', () => {
    const b = empty();
    b[7][7] = 2;
    // 1ms — d1 도 못 끝낼 만큼 짧음. 실제론 d1 한 후보 평가 후 deadline 초과 감지 → break.
    const r = generateMove(b, 'black', 'hard', { timeoutMs: 1 });
    assert.equal(r.aborted, true, 'aborted=true 여야 — deadline 초과로 ID 중단됨');
    assert.ok(r.reachedDepth < r.cfgMaxDepth, `reached(${r.reachedDepth}) < cfgMax(${r.cfgMaxDepth})`);
    // d1 시작 후 abort 면 bestMove 가 partial best — 그래도 null 아님 (orderCandidatesAtRoot
    // 결과의 1번 후보가 cands[0] 으로 들어가 partial best 됨).
    // OR generateMove 가 ID 의 첫 depth 도 못 끝내서 null 반환. 둘 다 OK.
  });

  test('짧은 timeoutMs 강제 시 medium 봇 동일 — aborted=true + 일관성', () => {
    const b = empty();
    b[7][7] = 2;
    const r = generateMove(b, 'black', 'medium', { timeoutMs: 1 });
    assert.equal(r.aborted, true);
    assert.ok(r.reachedDepth < r.cfgMaxDepth);
  });

  test('충분한 timeoutMs 시 정상 완료 (aborted=false, reached=cfgMax)', () => {
    const b = empty();
    b[7][7] = 2;
    // easy 는 무조건 빠르게 끝남 — abort 절대 발동 안 함 검증.
    const r = generateMove(b, 'black', 'easy');
    assert.equal(r.aborted, false);
    assert.equal(r.reachedDepth, r.cfgMaxDepth);
    assert.ok(r.move);
  });
});

describe('Bot ID — TT (Transposition Table) 동작 검증 (PR #82)', () => {
  // TT 는 search 결과 cache. 같은 보드에서 TT 사용 vs 미사용 결과 score 동일해야.
  // bestMove 는 tie-break 순서로 다를 수 있어 score 만 검증.
  test('같은 보드/depth — TT 유무에 따른 score 동일성', () => {
    const b = empty();
    b[7][7] = 1; b[7][8] = 2; b[8][7] = 1; b[6][7] = 2;
    const r1 = searchBestMove(b, 'black', 3, 10);  // no tt
    const r2 = searchBestMove(b, 'black', 3, 10, { tt: new Map() });
    assert.equal(r1.complete, r2.complete);
    assert.equal(r1.score, r2.score, 'TT 가 score 변경하면 안 됨');
    assert.equal(r1.win, r2.win);
  });

  test('TT 공유 시 ID 모든 depth 누적 효과 — 같은 보드 d3+d4 호출 시 d4 가 d3 의 cache 활용', () => {
    const b = empty();
    b[7][7] = 1; b[7][8] = 2;
    const tt = new Map();
    const r3 = searchBestMove(b, 'black', 3, 10, { tt });
    const sizeAfterD3 = tt.size;
    assert.ok(sizeAfterD3 > 0, 'd3 후 TT 에 entry 들어가야 함');
    const r4 = searchBestMove(b, 'black', 4, 10, { tt });
    assert.ok(r3.move && r4.move);
    // TT 가 누적되어 size 더 커짐 (d4 가 새 entries 추가)
    assert.ok(tt.size >= sizeAfterD3, 'd4 후 TT size 가 d3 후 이상');
  });

  test('generateMove 가 호출마다 새 TT 사용 — 다른 게임 사이 오염 없음', () => {
    // 두 보드에서 generateMove 두 번 호출 — 서로 영향 없어야.
    const b1 = empty(); b1[7][7] = 1;
    const b2 = empty(); b2[8][8] = 2;
    const r1 = generateMove(b1, 'white', 'easy');
    const r2 = generateMove(b2, 'black', 'easy');
    assert.ok(r1.move);
    assert.ok(r2.move);
    // 두 호출이 독립적이어야 — generateMove 가 매번 새 TT 생성하므로 검증 트리비얼.
    // 메모리 누수 방지 검증은 TT_MAX_ENTRIES 로 직접 못 함 (실제 100k 도달은 어려움).
  });
});

describe('Bot ID — searchBestMove deadline 직접 검증 (PR #78 회귀)', () => {
  // searchBestMove 직접 호출 — deadline 이 한 search 안에서 동작하는지.
  // Date.now() > deadline 비교가 매 후보 평가 후 발동해야 함. setTimeout/AbortSignal 의존 X.
  test('과거 deadline 주면 complete=false 즉시 반환', () => {
    const b = empty();
    b[7][7] = 2;
    // 이미 1초 전 시각. 모든 후보 평가 전 즉시 abort.
    const past = Date.now() - 1000;
    const r = searchBestMove(b, 'black', 4, 10, { deadline: past });
    assert.equal(r.complete, false, 'complete=false 여야 (deadline 초과)');
  });

  test('미래 deadline 충분히 길면 complete=true + move 있음', () => {
    const b = empty();
    b[7][7] = 2;
    const future = Date.now() + 30000;  // 30s 후 — 어떤 d 도 끝남
    const r = searchBestMove(b, 'black', 2, 5, { deadline: future });
    assert.equal(r.complete, true);
    assert.ok(r.move);
  });

  test('opts 안 줘도 (deadline=undefined) 정상 작동 — backward compat', () => {
    const b = empty();
    b[7][7] = 2;
    const r = searchBestMove(b, 'black', 2, 5);
    assert.equal(r.complete, true);
    assert.ok(r.move);
  });
});
