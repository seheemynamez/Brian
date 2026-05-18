// ============================================================
// 렌주룰 (Renju) 판정 — 흑 금수(쌍삼/쌍사/장목) + 정확한 승리 판정
// ============================================================
// 봇과 인간이 같은 경로로 검증받도록 pure 함수로 분리.
// 클라이언트 omok/js/renju.js 와 동일 로직 — 변경 시 둘 다 sync 필요.
//
// 보드 인코딩: board[r][c] in {0=empty, 1=black, 2=white}
// 컬러 인자: 'black' | 'white'
//
// 모든 검사는 "board 가 이미 (r,c) 에 color 로 놓여있다" 는 전제. caller 가 책임.
// ============================================================

const SIZE = 15;
const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
const RANGE = 5;             // 중심에서 each side ±5 = 11칸 라인
const CENTER = RANGE;        // 11-char 라인에서 중심 index

const colorNumOf = (color) => (color === 'black' ? 1 : 2);

// 라인 추출: (r,c) 에서 (dr,dc) 방향 ±RANGE 칸.
//   'X' = my color, 'O' = opponent, '.' = empty, '#' = out-of-bounds
function lineAt(board, r, c, dr, dc, color) {
  const me = colorNumOf(color);
  const out = [];
  for (let i = -RANGE; i <= RANGE; i++) {
    const nr = r + dr * i;
    const nc = c + dc * i;
    if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) out.push('#');
    else if (board[nr][nc] === 0) out.push('.');
    else if (board[nr][nc] === me) out.push('X');
    else out.push('O');
  }
  return out.join('');
}

// ---- 패턴 판정 함수들 (모두 11-char 라인 기준, center 포함 윈도우만 검사) ----

// 정확히 5 (장목이 아닌 5-in-a-row).
function lineHasExactFive(line) {
  for (let i = Math.max(0, CENTER - 4); i <= Math.min(line.length - 5, CENTER); i++) {
    if (line.substr(i, 5) !== 'XXXXX') continue;
    if (i > 0 && line[i - 1] === 'X') continue;
    if (i + 5 < line.length && line[i + 5] === 'X') continue;
    return true;
  }
  return false;
}

// 5+ 연속 (백용 — 장목도 승리).
function lineHasFive(line) {
  for (let i = Math.max(0, CENTER - 4); i <= Math.min(line.length - 5, CENTER); i++) {
    if (line.substr(i, 5) === 'XXXXX') return true;
  }
  return false;
}

// 장목 (6+ 연속 X — center 포함).
function lineHasOverline(line) {
  let count = 1;
  for (let i = CENTER - 1; i >= 0 && line[i] === 'X'; i--) count++;
  for (let i = CENTER + 1; i < line.length && line[i] === 'X'; i++) count++;
  return count >= 6;
}

// 열린 4 `.XXXX.` (center 포함).
function lineHasOpenFour(line) {
  for (let i = Math.max(0, CENTER - 4); i <= Math.min(line.length - 6, CENTER - 1); i++) {
    if (line.substr(i, 6) === '.XXXX.') return true;
  }
  return false;
}

// 4 (모든 종류 — 열린/닫힌/점프). 5-window 에 X 4 + . 1 + 그 외 0.
function lineHasFour(line) {
  for (let i = Math.max(0, CENTER - 4); i <= Math.min(line.length - 5, CENTER); i++) {
    const w = line.substr(i, 5);
    let x = 0, dot = 0, bad = false;
    for (const ch of w) {
      if (ch === 'X') x++;
      else if (ch === '.') dot++;
      else { bad = true; break; }
    }
    if (!bad && x === 4 && dot === 1) return true;
  }
  return false;
}

// 열린 3: 한 수 더 두면 열린 4 가 형성되는 형태.
// 알고리즘: 중심 주변 ±4 빈 칸에 가상 배치 후 그 자리 기준 열린 4 확인.
function dirHasOpenThree(board, r, c, dr, dc, color) {
  const me = colorNumOf(color);
  for (let i = -4; i <= 4; i++) {
    if (i === 0) continue;
    const nr = r + dr * i;
    const nc = c + dc * i;
    if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) continue;
    if (board[nr][nc] !== 0) continue;
    board[nr][nc] = me;
    const sub = lineAt(board, nr, nc, dr, dc, color);
    board[nr][nc] = 0;
    if (lineHasOpenFour(sub)) return true;
  }
  return false;
}

// ---- 방향별 합산 ----

function countOpenThrees(board, r, c, color) {
  let n = 0;
  for (const [dr, dc] of DIRS) if (dirHasOpenThree(board, r, c, dr, dc, color)) n++;
  return n;
}

function countFours(board, r, c, color) {
  let n = 0;
  for (const [dr, dc] of DIRS) {
    if (lineHasFour(lineAt(board, r, c, dr, dc, color))) n++;
  }
  return n;
}

function moveCreatesOverline(board, r, c, color) {
  for (const [dr, dc] of DIRS) {
    if (lineHasOverline(lineAt(board, r, c, dr, dc, color))) return true;
  }
  return false;
}

function moveCreatesExactFive(board, r, c, color) {
  for (const [dr, dc] of DIRS) {
    if (lineHasExactFive(lineAt(board, r, c, dr, dc, color))) return true;
  }
  return false;
}

// ============================================================
// 외부 API
// ============================================================

// 금수 판정 — 흑 전용. 정확히 5 가 만들어지면 예외(승리 우선)로 금수 아님.
// 반환: null (금수 아님) | { reason: 'overline' | 'double_four' | 'double_three' }
function checkForbidden(board, r, c, color) {
  if (color !== 'black') return null;
  if (moveCreatesExactFive(board, r, c, color)) return null;
  if (moveCreatesOverline(board, r, c, color)) return { reason: 'overline' };
  if (countFours(board, r, c, color) >= 2)     return { reason: 'double_four' };
  if (countOpenThrees(board, r, c, color) >= 2) return { reason: 'double_three' };
  return null;
}

// 승리 판정 — 흑은 정확히 5, 백은 5+. 반환: 승리 라인 5칸 [[r,c],...] 또는 null.
function checkWinRenju(board, r, c, color) {
  for (const [dr, dc] of DIRS) {
    const line = lineAt(board, r, c, dr, dc, color);
    const hit = (color === 'black') ? lineHasExactFive(line) : lineHasFive(line);
    if (hit) return findWinCells(board, r, c, dr, dc, color);
  }
  return null;
}

function findWinCells(board, r, c, dr, dc, color) {
  const me = colorNumOf(color);
  let r0 = r, c0 = c;
  while (true) {
    const nr = r0 - dr, nc = c0 - dc;
    if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) break;
    if (board[nr][nc] !== me) break;
    r0 = nr; c0 = nc;
  }
  const cells = [];
  let r1 = r0, c1 = c0;
  while (r1 >= 0 && r1 < SIZE && c1 >= 0 && c1 < SIZE && board[r1][c1] === me) {
    cells.push([r1, c1]);
    r1 += dr; c1 += dc;
  }
  return cells.slice(0, 5);
}

// 보드 전체에서 흑의 금수 위치 — 클라이언트 × 오버레이용.
function findForbiddenSpots(board, color) {
  if (color !== 'black') return [];
  const me = colorNumOf(color);
  const spots = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] !== 0) continue;
      board[r][c] = me;
      const result = checkForbidden(board, r, c, color);
      board[r][c] = 0;
      if (result) spots.push([r, c]);
    }
  }
  return spots;
}

// 한글 이유 라벨 — 에러 토스트 메시지용
const FORBIDDEN_LABEL = {
  overline:     '장목 (6목 이상)',
  double_four:  '쌍사 (4-4)',
  double_three: '쌍삼 (3-3)',
};

module.exports = {
  checkForbidden,
  checkWinRenju,
  findForbiddenSpots,
  FORBIDDEN_LABEL,
};
