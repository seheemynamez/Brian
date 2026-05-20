// ============================================================
// 오목봇 (AI) — 식별자 / 착수 generator / 감정표현 엔진
// ============================================================
// 봇은 사람 player 와 동일한 onMove 경로를 탄다. 이 파일은 "다음 어디에 둘지" 와
// "지금 감정 한마디" 를 계산할 뿐, 판정·적용 로직은 가지지 않는다.
// 렌주룰 판정은 ./renju 에 격리되어 있어 봇/사람 모두 동일 함수를 호출.
//
// 차후 DB 랭킹: BOT_IDS 가 안정 식별자로 유지되어야 봇별 레이팅 추적 가능.
// ============================================================

const { checkForbidden, checkWinRenju } = require('./renju');

const SIZE = 15;
const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

// 봇 정체성 — 변경 금지 (랭킹 데이터의 키).
const BOT_IDS = {
  easy:   '_bot_easy',
  medium: '_bot_medium',
  hard:   '_bot_hard',
};
const BOT_NICKNAMES = {
  easy:   '오목봇·하',
  medium: '오목봇·중',
  hard:   '오목봇·상',
};
const VALID_DIFFICULTIES = new Set(['easy', 'medium', 'hard']);

const colorNumOf = (color) => (color === 'black' ? 1 : 2);
const otherColor = (c) => (c === 'black' ? 'white' : 'black');

// ============================================================
// 후보 수 선정 (이웃 칸 + 흑이면 금수 제외)
// ============================================================
const hasNeighborStone = (board, r, c, dist) => {
  for (let dr = -dist; dr <= dist; dr++) {
    for (let dc = -dist; dc <= dist; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) continue;
      if (board[nr][nc] !== 0) return true;
    }
  }
  return false;
};

const getCandidates = (board, color, dist = 2) => {
  const me = colorNumOf(color);
  const cands = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] !== 0) continue;
      if (!hasNeighborStone(board, r, c, dist)) continue;
      if (color === 'black') {
        board[r][c] = me;
        const f = checkForbidden(board, r, c, color);
        board[r][c] = 0;
        if (f) continue;
      }
      cands.push([r, c]);
    }
  }
  return cands;
};

// 보드가 비어있으면 중앙. 후보가 없으면 모든 빈 칸 (마지막 fallback).
const getCandidatesWithFallback = (board, color) => {
  let cands = getCandidates(board, color, 2);
  if (cands.length) return cands;
  // 모든 돌이 너무 멀리 있거나 보드 비어있음 — 중앙 우선
  if (board[7][7] === 0) {
    if (color === 'black') {
      board[7][7] = 1;
      const f = checkForbidden(board, 7, 7, color);
      board[7][7] = 0;
      if (!f) return [[7, 7]];
    } else {
      return [[7, 7]];
    }
  }
  // 그래도 없으면 빈 칸 전수
  const all = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] === 0) {
        if (color === 'black') {
          board[r][c] = 1;
          const f = checkForbidden(board, r, c, color);
          board[r][c] = 0;
          if (f) continue;
        }
        all.push([r, c]);
      }
    }
  }
  return all;
};

// ============================================================
// 평가 함수 — 패턴 인식 기반
// ============================================================
// 4 방향 전체 라인을 1D 문자열(`#OO.X.O#` 류, # = 보드 경계)로 추출 후 패턴 매칭.
// 패턴 점수표는 위협 강도순:
//   열린4(.OOOO.) 50K — 막을 수 없음, 사실상 승
//   단4 / 점프4 10K — 한 수에 5목 가능 (막아도 다른 방향 + 콤보)
//   열린3(.OOO.) 5K — 다음 수에 열린4 형성, 반드시 응수 필요
//   점프 열린3 4K — 동일 위협
//   단3 / 열린2 / 점프2 작은 점수
// 본인 점수와 상대 점수의 차로 포지션을 평가.

const PATTERN_SCORES = [
  // [pattern, score]
  // 5목 (참고용 — 미니맥스에서 winLine 으로 먼저 처리되긴 함)
  ['OOOOO', 100000],

  // 열린 4 — 사실상 승리 (양 끝으로 5목 가능)
  ['.OOOO.', 50000],

  // 단4 — 한 수에 5목 가능. 양 끝 중 한쪽 막힘. 막힌 방향으론 못 확장.
  ['XOOOO.', 10000], ['.OOOOX', 10000],
  ['#OOOO.', 10000], ['.OOOO#', 10000],
  // 점프 4 — 가운데 빈 칸 메우면 5목. 양 끝 막혀도 5목 가능 → 단4 보다 더 견고.
  ['O.OOO',  15000], ['OO.OO',  15000], ['OOO.O', 15000],

  // 열린 3 — 다음 수에 열린4 (사실상 승) 형성. 강제 응수 패턴.
  ['.OOO.',   8000],
  // 점프 열린 3 — 가운데 빈 칸 메우면 열린4.
  ['.O.OO.',  6000], ['.OO.O.',  6000],

  // 단 3 — 한쪽 막힘. 다음 수에 단4 가능.
  ['XOOO.',    500], ['.OOOX',    500],
  ['#OOO.',    500], ['.OOO#',    500],

  // 열린 2 — 발전 가능성.
  ['.OO.',     200],
  // 점프 열린 2 — 약한 발전.
  ['.O.O.',    150],
];

// 4 방향 각각의 전체 라인을 # 센티넬과 함께 1D 문자열로 수집.
const getAllLines = (board, color) => {
  const me = colorNumOf(color);
  const opp = me === 1 ? 2 : 1;
  const lines = [];
  const ch = (r, c) => {
    if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return '#';
    if (board[r][c] === me) return 'O';
    if (board[r][c] === opp) return 'X';
    return '.';
  };

  // 가로
  for (let r = 0; r < SIZE; r++) {
    let s = '#';
    for (let c = 0; c < SIZE; c++) s += ch(r, c);
    lines.push(s + '#');
  }
  // 세로
  for (let c = 0; c < SIZE; c++) {
    let s = '#';
    for (let r = 0; r < SIZE; r++) s += ch(r, c);
    lines.push(s + '#');
  }
  // 대각 \ — 왼쪽 위 → 오른쪽 아래
  for (let i = 0; i < SIZE; i++) {
    let s = '#', r = 0, c = i;
    while (r < SIZE && c < SIZE) { s += ch(r, c); r++; c++; }
    if (s.length >= 6) lines.push(s + '#');  // 5목 가능한 길이만
  }
  for (let i = 1; i < SIZE; i++) {
    let s = '#', r = i, c = 0;
    while (r < SIZE && c < SIZE) { s += ch(r, c); r++; c++; }
    if (s.length >= 6) lines.push(s + '#');
  }
  // 대각 / — 왼쪽 아래 → 오른쪽 위
  for (let i = 0; i < SIZE; i++) {
    let s = '#', r = 0, c = i;
    while (r < SIZE && c >= 0) { s += ch(r, c); r++; c--; }
    if (s.length >= 6) lines.push(s + '#');
  }
  for (let i = 1; i < SIZE; i++) {
    let s = '#', r = i, c = SIZE - 1;
    while (r < SIZE && c >= 0) { s += ch(r, c); r++; c--; }
    if (s.length >= 6) lines.push(s + '#');
  }
  return lines;
};

const scoreFor = (board, color) => {
  const lines = getAllLines(board, color);
  let total = 0;
  for (const line of lines) {
    for (const [pattern, score] of PATTERN_SCORES) {
      let idx = 0;
      while ((idx = line.indexOf(pattern, idx)) !== -1) {
        total += score;
        idx += 1;  // 겹치는 점프 패턴까지 잡도록 1씩 전진
      }
    }
  }
  return total;
};

// 평가: 자기 점수 - 상대 점수 × DEFENSIVE_BIAS (1.1).
// 상대 위협이 같은 크기여도 약간 더 무겁게 다뤄 봇이 공격보다 방어를 살짝 우선시.
// 동률 시점에서 자기 패턴 발전이 아닌 상대 차단 쪽으로 기울어짐.
const DEFENSIVE_BIAS = 1.1;
const evaluatePosition = (board, myColor) =>
  scoreFor(board, myColor) - scoreFor(board, otherColor(myColor)) * DEFENSIVE_BIAS;

// ============================================================
// 무브 정렬
// ----------------------------------------------------------------
// 루트 (orderCandidatesAtRoot) — 정확한 1-ply 평가 기반 정렬. 후보당 evaluatePosition 1 회.
//   비싸지만 루트는 1회만 호출되고 α-β 가지치기 효과가 가장 크다.
// 비루트 (orderCandidatesCheap) — 이웃 돌 개수(3×3, 8 칸)로 cheap 정렬.
//   eval call 0 회. 후반(후보 100+)에 minimax 트리 전체에서 누적되던 비용 제거.
// ============================================================
const orderCandidatesAtRoot = (board, color, myColor, topK) => {
  const me = colorNumOf(color);
  const cands = getCandidates(board, color, 2);
  if (cands.length <= 1) return cands;
  const scored = cands.map(([r, c]) => {
    board[r][c] = me;
    const winLine = checkWinRenju(board, r, c, color);
    let s;
    if (winLine) s = (color === myColor) ? 1e9 : -1e9;
    else s = evaluatePosition(board, myColor);
    board[r][c] = 0;
    return { rc: [r, c], s };
  });
  scored.sort((a, b) => (color === myColor ? b.s - a.s : a.s - b.s));
  return scored.slice(0, topK).map((x) => x.rc);
};

// (r,c) 에 me 색 돌을 놓으면 4 이상 연속이 형성되는지 — 점프 패턴은 제외, 연속 5 직전.
// 한 방향당 ±4 칸 스캔. 후보당 ~30 칸 액세스 (가볍다).
const placementMakesFour = (board, r, c, me) => {
  board[r][c] = me;
  let found = false;
  for (const [dr, dc] of DIRS) {
    let n = 1;
    for (let i = 1; i < 5; i++) {
      const nr = r + dr * i, nc = c + dc * i;
      if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE || board[nr][nc] !== me) break;
      n++;
    }
    for (let i = 1; i < 5; i++) {
      const nr = r - dr * i, nc = c - dc * i;
      if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE || board[nr][nc] !== me) break;
      n++;
    }
    if (n >= 4) { found = true; break; }
  }
  board[r][c] = 0;
  return found;
};

// 이웃 카운트 + 결정적 자리 우선 — 빠르면서 핵심 후보는 놓치지 않음.
// 후보당:
//   1) 내가 두면 4 연속 만드는 자리 → 공격 우선 (top 무조건 포함)
//   2) 상대가 두면 4 연속 만드는 자리 → 방어 우선 (top 무조건 포함)
//      ← 이 검사가 없으면 사용자 open 3 차단 자리가 누락되어 봇이 막지 못함
//   3) 그 외 → 이웃 돌 개수(3×3, 8칸) 기준 정렬
// evaluatePosition 미사용 (cheap). + 후보 상한 MAX_CANDS_PER_NODE.
const MAX_CANDS_PER_NODE = 50;
const orderCandidatesCheap = (board, color, topK) => {
  const me = colorNumOf(color);
  const opp = me === 1 ? 2 : 1;
  const cands = getCandidates(board, color, 2);
  if (cands.length <= topK) return cands;
  const critical = [];  // 공격(내 4목) 또는 방어(상대 4목 차단)
  const others = [];
  for (const [r, c] of cands) {
    if (placementMakesFour(board, r, c, me) || placementMakesFour(board, r, c, opp)) {
      critical.push([r, c]);
      continue;
    }
    let n = 0;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && board[nr][nc] !== 0) n++;
      }
    }
    others.push({ rc: [r, c], s: n });
  }
  others.sort((a, b) => b.s - a.s);
  const result = critical.slice();  // 결정적 자리는 무조건 포함
  for (const { rc } of others) {
    if (result.length >= topK) break;
    result.push(rc);
  }
  return result.slice(0, MAX_CANDS_PER_NODE);
};

// 후보 정렬과 무관하게 즉시 승리수가 존재하면 빠르게 잡아낸다.
// — cheap ordering 이 결정적 cell 을 놓쳐 minimax 가 잘못된 분석을 하는 문제 방지
// — 더불어 큰 성능 향상 (재귀 회피)
const findWinningMove = (board, color) => {
  const me = colorNumOf(color);
  const cands = getCandidates(board, color, 2);
  for (const [r, c] of cands) {
    board[r][c] = me;
    const win = checkWinRenju(board, r, c, color);
    board[r][c] = 0;
    if (win) return [r, c];
  }
  return null;
};

// ============================================================
// 미니맥스 + 알파베타 (정렬된 상위 K 후보만 탐색)
// ============================================================
const minimax = (board, depth, color, myColor, alpha, beta, topK) => {
  if (depth === 0) return evaluatePosition(board, myColor);

  // 단축회로: 이 차례에 즉시 5목 만들 수 있으면 더 깊이 갈 필요 없음.
  // cheap ordering 이 결정적 cell 을 top K 에 못 넣어도 안전하게 잡힘.
  const win = findWinningMove(board, color);
  if (win) {
    const isMax = (color === myColor);
    return isMax ? (100000 - (5 - depth)) : (-100000 + (5 - depth));
  }

  const cands = orderCandidatesCheap(board, color, topK);
  if (!cands.length) return evaluatePosition(board, myColor);

  const me = colorNumOf(color);
  const isMaximizing = (color === myColor);
  let best = isMaximizing ? -Infinity : Infinity;

  for (const [r, c] of cands) {
    board[r][c] = me;
    const winLine = checkWinRenju(board, r, c, color);
    let score;
    if (winLine) {
      // depth 보정 — 같은 승리라도 빨리 이기는/지는 게 더 좋은/나쁜 결과
      score = isMaximizing ? (100000 - (5 - depth)) : (-100000 + (5 - depth));
    } else {
      score = minimax(board, depth - 1, otherColor(color), myColor, alpha, beta, topK);
    }
    board[r][c] = 0;
    if (isMaximizing) {
      if (score > best) best = score;
      if (best > alpha) alpha = best;
    } else {
      if (score < best) best = score;
      if (best < beta) beta = best;
    }
    if (beta <= alpha) break;
  }
  return best;
};

const searchBestMove = (board, color, depth, topK) => {
  const cands = orderCandidatesAtRoot(board, color, color, topK);
  if (!cands.length) {
    const fb = getCandidatesWithFallback(board, color);
    return fb[0] || null;
  }
  if (cands.length === 1) return cands[0];

  const me = colorNumOf(color);
  let bestMove = cands[0];
  let bestScore = -Infinity;
  let alpha = -Infinity, beta = Infinity;

  for (const [r, c] of cands) {
    board[r][c] = me;
    const winLine = checkWinRenju(board, r, c, color);
    let score;
    if (winLine) {
      score = 100000;
    } else {
      score = minimax(board, depth - 1, otherColor(color), color, alpha, beta, topK);
    }
    board[r][c] = 0;
    if (score > bestScore) {
      bestScore = score;
      bestMove = [r, c];
    }
    if (score > alpha) alpha = score;
  }
  return bestMove;
};

// ============================================================
// 난이도별 generator
// ============================================================
// 하: 2-ply × top 3 — 상대 1수 응수는 보지만 후보 폭을 매우 좁혀
//     루트 정렬에 의존. 좋은 수 자주 놓침. 입문자도 더 자주 이기게 약화.
//     즉시 승리수 (5목) 는 root 에서 무조건 잡힘. early ~9ms.
const generateMoveEasy = (board, color) => searchBestMove(board, color, 2, 3);

// 중: 3-ply × top 10 — depth 는 3 유지하되 폭 좁혀 콤보·강제 응수 차단력 약간 ↓.
//     이전 (3,15) 보다 후보 5개 적음. early ~66ms.
const generateMoveMedium = (board, color) => searchBestMove(board, color, 3, 10);

// 상: 6-ply × top 6 — 이전 (5, 8) 대비 depth +1, 폭 -2. α-β 가지치기 극대화.
//     local one_stone worst 945ms, early 306ms. Render free-tier 가 로컬 대비 5-10배
//     느릴 수 있어 worst case ≈ 5-10s — turn timeout 30s 안에 안전.
//     이전 (7, 6) 은 local 4.2s 였는데 Render 에선 20-30s 초과해 timeout 발생 → revert.
// (6, 6) 도 에러나서 (5, 12) 로 hotfix
const generateMoveHard = (board, color) => searchBestMove(board, color, 5, 12);

const GENERATORS = {
  easy:   generateMoveEasy,
  medium: generateMoveMedium,
  hard:   generateMoveHard,
};

// 외부 진입점
const generateMove = (board, color, difficulty) => {
  const fn = GENERATORS[difficulty] || GENERATORS.medium;
  return fn(board, color);
};

// ============================================================
// 봇 감정표현 (emote) 엔진
// ============================================================
// 봇은 사람용 EMOTE_COOLDOWN_MS 와 무관하게 자체 쿨다운으로 관리.
// 트리거: 'game_start' | 'bot_moved' | 'opponent_moved' | 'game_over_win' | 'game_over_lose'

const BOT_EMOTE_COOLDOWN_MS = 5000;      // 봇이 연속 emote 최소 간격
const SAME_EMOTE_COOLDOWN_MS = 20000;    // 같은 종류 반복 금지

const TRIGGER_PROB = {
  game_start:      0.6,
  bot_moved:       0.20,
  opponent_moved:  0.25,
  game_over_win:   0.9,
  game_over_lose:  0.9,
};

// 상태 → emote 가중치
const STATE_WEIGHTS = {
  winning:    { easy: 0.4, wow: 0.2, sure: 0.2, hmm: 0.2 },
  pressured:  { hmm: 0.4, oops: 0.3, please: 0.2, sure: 0.1 },
  losing:     { please: 0.4, oops: 0.3, hmm: 0.2, tick_tock: 0.1 },
  even:       { hmm: 0.4, hi: 0.2, sure: 0.2, tick_tock: 0.2 },
  start:      { hi: 0.8, tick_tock: 0.2 },
  end_win:    { gg: 0.6, easy: 0.2, again: 0.2 },
  end_lose:   { gg: 0.5, oops: 0.2, please: 0.2, again: 0.1 },
};

// 난이도별 personality multiplier (전체 빈도 + 상은 'easy'/'sure' 가중↑)
const PERSONALITY = {
  easy:   { freq: 1.2, override: {} },
  medium: { freq: 1.0, override: {} },
  hard:   { freq: 0.7, override: { winning: { easy: 0.55, sure: 0.25, wow: 0.1, hmm: 0.1 } } },
};

// 보드 상태 분류 — 봇 관점에서 winning/pressured/losing/even
const classifyState = (board, botColor) => {
  const my = scoreFor(board, botColor);
  const opp = scoreFor(board, otherColor(botColor));
  const delta = my - opp;
  if (delta >= 500) return 'winning';
  if (delta <= -500) return 'losing';
  if (delta <= -150) return 'pressured';
  return 'even';
};

const weightedPick = (weights) => {
  const keys = Object.keys(weights);
  if (!keys.length) return null;
  const total = keys.reduce((s, k) => s + weights[k], 0);
  let r = Math.random() * total;
  for (const k of keys) {
    r -= weights[k];
    if (r <= 0) return k;
  }
  return keys[keys.length - 1];
};

// 봇 상태(쿨다운 트래킹) — 룸별로 따로 유지 (메모리 누수 방지: 룸 삭제 시 같이 정리됨)
const newBotEmoteState = () => ({
  lastEmoteAt: 0,
  lastEmoteKey: '',
  lastSameKeyAt: 0,
});

// trigger 발생 시 호출. emote key 를 반환 (실제 broadcast 는 caller 책임).
const decideBotEmote = ({ board, botColor, difficulty, trigger, emoteState, now }) => {
  if (!trigger) return null;
  if (now - emoteState.lastEmoteAt < BOT_EMOTE_COOLDOWN_MS) return null;
  const personality = PERSONALITY[difficulty] || PERSONALITY.medium;
  const baseProb = TRIGGER_PROB[trigger] || 0;
  if (Math.random() > baseProb * personality.freq) return null;

  // 트리거 → state 결정
  let stateName;
  if (trigger === 'game_start')           stateName = 'start';
  else if (trigger === 'game_over_win')   stateName = 'end_win';
  else if (trigger === 'game_over_lose')  stateName = 'end_lose';
  else                                    stateName = classifyState(board, botColor);

  // 난이도별 override 적용
  const overrideForState = (personality.override || {})[stateName];
  const weights = overrideForState || STATE_WEIGHTS[stateName] || STATE_WEIGHTS.even;

  // 직전과 같은 emote 는 일정 시간 내 재사용 금지
  const filtered = {};
  for (const k of Object.keys(weights)) {
    if (k === emoteState.lastEmoteKey && (now - emoteState.lastSameKeyAt) < SAME_EMOTE_COOLDOWN_MS) continue;
    filtered[k] = weights[k];
  }
  const target = Object.keys(filtered).length ? filtered : weights;
  return weightedPick(target);
};

// emote 사용 직후 호출
const recordBotEmote = (emoteState, key, now) => {
  emoteState.lastEmoteAt = now;
  emoteState.lastSameKeyAt = now;
  emoteState.lastEmoteKey = key;
};

// ============================================================
// 착수 자연 딜레이 — 난이도별 사고시간 시뮬레이션
// ============================================================
// 사람 느낌의 사고시간 — 실제 탐색 시간이 이보다 길면 자연스럽게 그만큼 걸림.
// 짧은 쪽은 "생각하는 척" 최소 딜레이, 긴 쪽은 자연스러운 최대.
// 상 봇은 generateMove 자체가 깊은 탐색 (worst 4s) 이라 delay 는 중 수준으로 줄여서
// 합산 사고시간을 조절. delay 줄여 확보한 budget 을 탐색에 더 씀.
const BOT_THINK_MS_RANGE = {
  easy:   [300, 700],
  medium: [700, 1400],
  hard:   [900, 1800],
};
const thinkTimeMs = (difficulty) => {
  const r = BOT_THINK_MS_RANGE[difficulty] || BOT_THINK_MS_RANGE.medium;
  return r[0] + Math.floor(Math.random() * (r[1] - r[0]));
};

module.exports = {
  BOT_IDS, BOT_NICKNAMES, VALID_DIFFICULTIES,
  generateMove,
  decideBotEmote, recordBotEmote, newBotEmoteState,
  thinkTimeMs,
};
