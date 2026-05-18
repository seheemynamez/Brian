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
// 평가 함수 — 보드에 대한 한 색의 점수
// ============================================================
// 한 라인 패턴 점수
const scoreLine = (len, openCount) => {
  if (len >= 5) return 100000;            // 승리 (or 장목 — 흑이면 forbidden 으로 미리 걸러짐)
  if (len === 4) return openCount === 2 ? 10000 : (openCount === 1 ? 1000 : 50);
  if (len === 3) return openCount === 2 ? 500   : (openCount === 1 ? 50   : 5);
  if (len === 2) return openCount === 2 ? 20    : (openCount === 1 ? 5    : 1);
  if (len === 1) return openCount === 2 ? 2     : (openCount === 1 ? 1    : 0);
  return 0;
};

// (r,c) 가 (dr,dc) 방향 연속 라인의 시작점인지 — 라인 중복 카운트 방지용
const isLineStart = (board, r, c, dr, dc, me) => {
  const pr = r - dr, pc = c - dc;
  if (pr < 0 || pr >= SIZE || pc < 0 || pc >= SIZE) return true;
  return board[pr][pc] !== me;
};

const scoreFor = (board, color) => {
  const me = colorNumOf(color);
  let total = 0;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] !== me) continue;
      for (const [dr, dc] of DIRS) {
        if (!isLineStart(board, r, c, dr, dc, me)) continue;
        // 연속 길이 측정
        let len = 0;
        let rr = r, cc = c;
        while (rr >= 0 && rr < SIZE && cc >= 0 && cc < SIZE && board[rr][cc] === me) {
          len++;
          rr += dr; cc += dc;
        }
        // 양 끝 개방 여부
        const beforeR = r - dr, beforeC = c - dc;
        const afterR = rr, afterC = cc;
        const openLeft = (beforeR >= 0 && beforeR < SIZE && beforeC >= 0 && beforeC < SIZE && board[beforeR][beforeC] === 0);
        const openRight = (afterR >= 0 && afterR < SIZE && afterC >= 0 && afterC < SIZE && board[afterR][afterC] === 0);
        const openCount = (openLeft ? 1 : 0) + (openRight ? 1 : 0);
        total += scoreLine(len, openCount);
      }
    }
  }
  return total;
};

const evaluatePosition = (board, myColor) =>
  scoreFor(board, myColor) - scoreFor(board, otherColor(myColor));

// ============================================================
// 미니맥스 + 알파베타
// ============================================================
const minimax = (board, depth, color, myColor, alpha, beta) => {
  // 즉시 승리 / 패배 빠른 종결 — 마지막 수가 5목이면 큰 점수
  // (검사 비용 줄이려 depth=0 일 때만 평가)
  if (depth === 0) return evaluatePosition(board, myColor);

  const cands = getCandidates(board, color, 2);
  if (!cands.length) return evaluatePosition(board, myColor);

  // 휴리스틱: 평가가 높은 순으로 정렬 → 알파베타 가지치기 효율 향상
  cands.sort(() => Math.random() - 0.5);  // 가벼운 셔플로 동률 시 결정성 깨기

  const me = colorNumOf(color);
  const isMaximizing = (color === myColor);
  let best = isMaximizing ? -Infinity : Infinity;
  for (const [r, c] of cands) {
    board[r][c] = me;
    // 즉시 승리하면 깊게 안 들어가도 됨 (성능 + 정확도)
    const winLine = checkWinRenju(board, r, c, color);
    let score;
    if (winLine) {
      score = isMaximizing ? 100000 - (3 - depth) : -100000 + (3 - depth);
      // depth 보정: 같은 100000 이라도 깊이가 얕을수록 더 좋은 / 나쁜 수.
    } else {
      score = minimax(board, depth - 1, otherColor(color), myColor, alpha, beta);
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

// ============================================================
// 난이도별 generator
// ============================================================
const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

// 하: 이웃 ±2 빈 칸 중 (흑이면 금수 제외) 랜덤 1개
const generateMoveEasy = (board, color) => {
  const cands = getCandidatesWithFallback(board, color);
  if (!cands.length) return null;
  return pickRandom(cands);
};

// 중: 2-ply 미니맥스
const generateMoveMedium = (board, color) => {
  return searchBestMove(board, color, 2);
};

// 상: 3-ply 미니맥스
const generateMoveHard = (board, color) => {
  return searchBestMove(board, color, 3);
};

const searchBestMove = (board, color, depth) => {
  const cands = getCandidatesWithFallback(board, color);
  if (!cands.length) return null;
  if (cands.length === 1) return cands[0];

  const me = colorNumOf(color);
  let bestMove = null;
  let bestScore = -Infinity;
  let alpha = -Infinity, beta = Infinity;

  for (const [r, c] of cands) {
    board[r][c] = me;
    const winLine = checkWinRenju(board, r, c, color);
    let score;
    if (winLine) {
      score = 100000;
    } else {
      score = minimax(board, depth - 1, otherColor(color), color, alpha, beta);
    }
    board[r][c] = 0;
    if (score > bestScore) {
      bestScore = score;
      bestMove = [r, c];
    }
    if (score > alpha) alpha = score;
  }
  return bestMove || cands[0];
};

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
const BOT_THINK_MS_RANGE = {
  easy:   [400, 900],
  medium: [800, 1800],
  hard:   [1200, 2500],
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
