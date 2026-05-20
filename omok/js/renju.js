// ============================================================
// 렌주룰 (Renju) — 클라이언트 사본
// ============================================================
// 서버 omok/server/renju.js 와 동일 로직. 한 쪽 변경 시 반드시 다른 쪽도 sync.
// 클라이언트는 흑 차례에 보드의 금수 위치에 × 오버레이를 그리는 용도로 사용.
// 서버가 진위 결정의 final authority — 클라이언트 검증은 UX 힌트일 뿐.
// ============================================================

const SIZE = 15;
const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
const RANGE = 5;
const CENTER = RANGE;

const colorNumOf = (color) => (color === 'black' ? 1 : 2);

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

function lineHasExactFive(line) {
  for (let i = Math.max(0, CENTER - 4); i <= Math.min(line.length - 5, CENTER); i++) {
    if (line.substr(i, 5) !== 'XXXXX') continue;
    if (i > 0 && line[i - 1] === 'X') continue;
    if (i + 5 < line.length && line[i + 5] === 'X') continue;
    return true;
  }
  return false;
}

function lineHasFive(line) {
  for (let i = Math.max(0, CENTER - 4); i <= Math.min(line.length - 5, CENTER); i++) {
    if (line.substr(i, 5) === 'XXXXX') return true;
  }
  return false;
}

function lineHasOverline(line) {
  let count = 1;
  for (let i = CENTER - 1; i >= 0 && line[i] === 'X'; i--) count++;
  for (let i = CENTER + 1; i < line.length && line[i] === 'X'; i++) count++;
  return count >= 6;
}

function lineHasOpenFour(line) {
  for (let i = Math.max(0, CENTER - 4); i <= Math.min(line.length - 6, CENTER - 1); i++) {
    if (line.substr(i, 6) === '.XXXX.') return true;
  }
  return false;
}

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
    // (r,c) 는 virtual placement (line center) 의 반대쪽 i 칸 → line idx = CENTER - i.
    const rcIdx = CENTER - i;
    for (let k = Math.max(0, CENTER - 4); k <= Math.min(sub.length - 6, CENTER - 1); k++) {
      if (sub.substr(k, 6) !== '.XXXX.') continue;
      // .XXXX. 의 X 4 칸: k+1..k+4. (r,c) 가 그 중 하나여야 (r,c) 가 만든 open three.
      if (rcIdx >= k + 1 && rcIdx <= k + 4) return true;
    }
  }
  return false;
}

function countOpenThrees(board, r, c, color) {
  let n = 0;
  for (const [dr, dc] of DIRS) {
    // 같은 line 에 four (= 한 수에 5목) 가 있으면 그 line 은 "four" 레벨이지 "three" 가 아님.
    // renju 표준의 highest-threat 우선 규칙 (4 > 3) — line 단위 분류로 카운트.
    // 이 가드 없으면 jump four `XXX.X` (한 line 에 4 + 3 가 함께 존재) 가 open three 로도
    // 동시에 잡혀 쌍삼 false positive 발생. consecutive `XXXX` 는 dirHasOpenThree 가
    // 자연히 false (virtual 두면 5목, open four X) 라 이 가드 없어도 영향 없음.
    if (lineHasFour(lineAt(board, r, c, dr, dc, color))) continue;
    if (dirHasOpenThree(board, r, c, dr, dc, color)) n++;
  }
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

export function checkForbidden(board, r, c, color) {
  if (color !== 'black') return null;
  if (moveCreatesExactFive(board, r, c, color)) return null;
  if (moveCreatesOverline(board, r, c, color)) return { reason: 'overline' };
  if (countFours(board, r, c, color) >= 2)     return { reason: 'double_four' };
  if (countOpenThrees(board, r, c, color) >= 2) return { reason: 'double_three' };
  return null;
}

export function findForbiddenSpots(board, color) {
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
