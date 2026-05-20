// ============================================================
// game-logic 단위 테스트.
// emptyBoard / isDraw / BOARD_SIZE 만 실제 사용됨 (checkWin 은 dead code,
// 실제 승리 판정은 renju.checkWinRenju 가 담당).
// ============================================================

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  BOARD_SIZE,
  WIN_LENGTH,
  emptyBoard,
  isDraw,
} = require('../../game/game-logic');

describe('상수', () => {
  test('BOARD_SIZE = 15', () => {
    assert.equal(BOARD_SIZE, 15);
  });
  test('WIN_LENGTH = 5', () => {
    assert.equal(WIN_LENGTH, 5);
  });
});

describe('emptyBoard', () => {
  test('15x15 모두 0', () => {
    const b = emptyBoard();
    assert.equal(b.length, 15);
    for (const row of b) {
      assert.equal(row.length, 15);
      for (const v of row) assert.equal(v, 0);
    }
  });

  test('호출마다 독립 인스턴스 (mutation 격리)', () => {
    const a = emptyBoard();
    const b = emptyBoard();
    a[0][0] = 1;
    assert.equal(b[0][0], 0, '한 보드의 mutation 이 다른 보드에 영향 주면 안 됨');
  });
});

describe('isDraw', () => {
  test('빈 보드 → false', () => {
    assert.equal(isDraw(emptyBoard()), false);
  });

  test('한 칸만 비어있어도 → false', () => {
    const b = emptyBoard();
    for (let r = 0; r < 15; r++)
      for (let c = 0; c < 15; c++)
        b[r][c] = 1;
    b[7][7] = 0; // 한 칸 비움
    assert.equal(isDraw(b), false);
  });

  test('모든 칸 채워짐 → true', () => {
    const b = emptyBoard();
    for (let r = 0; r < 15; r++)
      for (let c = 0; c < 15; c++)
        b[r][c] = (r + c) % 2 === 0 ? 1 : 2;
    assert.equal(isDraw(b), true);
  });
});
