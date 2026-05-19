// ============================================================
// 순수 게임 로직: 보드 / 5목 판정 / 무승부 판정
// ============================================================

const BOARD_SIZE = 15;
const WIN_LENGTH = 5;

const emptyBoard = () =>
  Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(0));

/**
 * 마지막에 둔 (r, c) 위치를 기준으로 4방향 5목 검사.
 * 5목이면 라인 좌표 배열, 아니면 null.
 */
function checkWin(board, r, c, color) {
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  const stone = color === 'black' ? 1 : 2;
  for (const [dr, dc] of dirs) {
    const line = [[r, c]];
    for (let i = 1; i <= WIN_LENGTH; i++) {
      const nr = r + dr * i, nc = c + dc * i;
      if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) break;
      if (board[nr][nc] !== stone) break;
      line.push([nr, nc]);
    }
    for (let i = 1; i <= WIN_LENGTH; i++) {
      const nr = r - dr * i, nc = c - dc * i;
      if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) break;
      if (board[nr][nc] !== stone) break;
      line.unshift([nr, nc]);
    }
    if (line.length >= WIN_LENGTH) return line;
  }
  return null;
}

const isDraw = (board) => board.every((row) => row.every((v) => v !== 0));

module.exports = { BOARD_SIZE, WIN_LENGTH, emptyBoard, checkWin, isDraw };
