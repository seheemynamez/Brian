// ============================================================
// 순수 게임 로직: 보드 / 무승부 판정
// 승리 판정은 game/renju.js 의 checkWinRenju 가 담당 (렌주룰 적용).
// ============================================================

const BOARD_SIZE = 15;
const WIN_LENGTH = 5;

const emptyBoard = () =>
  Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(0));

const isDraw = (board) => board.every((row) => row.every((v) => v !== 0));

module.exports = { BOARD_SIZE, WIN_LENGTH, emptyBoard, isDraw };
