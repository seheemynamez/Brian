// ============================================================
// 렌주룰 단위 테스트 — 그동안 디버깅하면서 발견된 시나리오 회귀 방지.
// 서버 부팅 없이 pure 함수만 검증. node --test 로 실행.
// ============================================================
//
// 검증 시나리오:
//   - 합법: 정확히 5 (흑 승리), 백 6+ (백 승리도 OK)
//   - 금수: 장목 (overline, 흑만), 쌍사 (4-4), 쌍삼 (3-3)
//   - 비포함: 점삼 (O.O.O, gap 2) 은 3 으로 카운트 안 됨
//   - 우선순위: 정확히 5 형성 시 금수 검사 skip (승리 우선)
// ============================================================

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  checkForbidden,
  checkWinRenju,
  findForbiddenSpots,
  FORBIDDEN_LABEL,
} = require('../../game/renju');

const SIZE = 15;
const emptyBoard = () =>
  Array.from({ length: SIZE }, () => Array(SIZE).fill(0));

// place(b, 'black', [[7,3], [7,4]]) — 다중 좌표에 돌 배치
const place = (b, color, cells) => {
  const stone = color === 'black' ? 1 : 2;
  for (const [r, c] of cells) b[r][c] = stone;
};

// ============================================================
// checkForbidden — 흑 금수 판정
// ============================================================

describe('checkForbidden — 합법 케이스', () => {
  test('빈 보드에 단일 흑돌: null', () => {
    const b = emptyBoard();
    b[7][7] = 1;
    assert.equal(checkForbidden(b, 7, 7, 'black'), null);
  });

  test('정확히 5 (승리) 형성: 금수 아님 (승리 우선)', () => {
    // 4 + 1 = 5 → 5목 우선이므로 다른 금수 패턴 검사 skip
    const b = emptyBoard();
    place(b, 'black', [[7, 3], [7, 4], [7, 5], [7, 6], [7, 7]]);
    assert.equal(checkForbidden(b, 7, 7, 'black'), null);
  });

  test('백돌은 항상 금수 없음 (overline 형성해도 null)', () => {
    const b = emptyBoard();
    place(b, 'white', [[7, 2], [7, 3], [7, 4], [7, 5], [7, 6], [7, 7]]);
    assert.equal(checkForbidden(b, 7, 7, 'white'), null);
  });

  test('일반 4 + 일반 3 (4-3): 합법 (쌍사 X, 쌍삼 X)', () => {
    // 가로 4: (7,4)(7,5)(7,6)(7,7) — 4 형성
    // 세로 3: (5,7)(6,7)(7,7) — open 3 형성 (8,7 empty)
    // 한 방향만 4, 한 방향만 3 → 금수 아님
    const b = emptyBoard();
    place(b, 'black', [[7, 4], [7, 5], [7, 6]]);
    place(b, 'black', [[5, 7], [6, 7]]);
    place(b, 'black', [[7, 7]]);
    assert.equal(checkForbidden(b, 7, 7, 'black'), null);
  });
});

describe('checkForbidden — overline (장목, 흑만)', () => {
  test('가로 6 연속: { reason: overline }', () => {
    const b = emptyBoard();
    place(b, 'black', [[7, 2], [7, 3], [7, 4], [7, 5], [7, 6], [7, 7]]);
    assert.deepEqual(checkForbidden(b, 7, 7, 'black'), { reason: 'overline' });
  });

  test('가운데 끼워 6 만들기 (양옆 X X X _ X X → 가운데 두면 장목)', () => {
    const b = emptyBoard();
    place(b, 'black', [[7, 3], [7, 4], [7, 5], [7, 7], [7, 8]]);
    place(b, 'black', [[7, 6]]); // 가운데 끼워서 6 연속
    assert.deepEqual(checkForbidden(b, 7, 6, 'black'), { reason: 'overline' });
  });

  test('세로 7 연속도 overline', () => {
    const b = emptyBoard();
    place(b, 'black', [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7], [6, 7], [7, 7]]);
    assert.deepEqual(checkForbidden(b, 7, 7, 'black'), { reason: 'overline' });
  });

  test('대각선 6 연속도 overline', () => {
    const b = emptyBoard();
    place(b, 'black', [[2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7]]);
    assert.deepEqual(checkForbidden(b, 7, 7, 'black'), { reason: 'overline' });
  });
});

describe('checkForbidden — double_four (쌍사 4-4)', () => {
  test('가로 4 + 세로 4 동시 형성', () => {
    // 가로: (7,4)(7,5)(7,6)(7,7) — 4 형성
    // 세로: (4,7)(5,7)(6,7)(7,7) — 4 형성
    const b = emptyBoard();
    place(b, 'black', [[7, 4], [7, 5], [7, 6]]);
    place(b, 'black', [[4, 7], [5, 7], [6, 7]]);
    place(b, 'black', [[7, 7]]);
    assert.deepEqual(checkForbidden(b, 7, 7, 'black'), { reason: 'double_four' });
  });

  test('점사 (jump four, 4-with-gap) 포함 쌍사', () => {
    // 가로 점사: (7,3)(7,4)(7,6)(7,7) — 4 X + 1 dot = 4 (lineHasFour 정의)
    // 세로 직사: (4,7)(5,7)(6,7)(7,7) — 4 형성
    const b = emptyBoard();
    place(b, 'black', [[7, 3], [7, 4], [7, 6]]);
    place(b, 'black', [[4, 7], [5, 7], [6, 7]]);
    place(b, 'black', [[7, 7]]);
    assert.deepEqual(checkForbidden(b, 7, 7, 'black'), { reason: 'double_four' });
  });

  test('대각선 4 + 가로 4', () => {
    // 대각선: (3,3)(4,4)(5,5)(6,6)(7,7) → 5 형성... 이건 5목 우선이므로 안 됨
    // 4 만 만들려면: (4,4)(5,5)(6,6)(7,7) — 4 형성, 다음이 (8,8) 비었어야 4 (5 되면 안 됨)
    // 가로 4: (7,4)(7,5)(7,6)(7,7)
    const b = emptyBoard();
    place(b, 'black', [[4, 4], [5, 5], [6, 6]]); // 대각선 3 (배치 후 4 됨)
    place(b, 'black', [[7, 4], [7, 5], [7, 6]]); // 가로 3 (배치 후 4 됨)
    place(b, 'black', [[7, 7]]);
    assert.deepEqual(checkForbidden(b, 7, 7, 'black'), { reason: 'double_four' });
  });
});

describe('checkForbidden — double_three (쌍삼 3-3)', () => {
  test('가로 open 3 + 세로 open 3 동시 형성', () => {
    // (7,7) 둘 때 가로 (7,7)(7,8)(7,9) 와 세로 (7,7)(8,7)(9,7) 모두 open 3
    const b = emptyBoard();
    place(b, 'black', [[7, 8], [7, 9]]);
    place(b, 'black', [[8, 7], [9, 7]]);
    place(b, 'black', [[7, 7]]);
    assert.deepEqual(checkForbidden(b, 7, 7, 'black'), { reason: 'double_three' });
  });

  test('가로 점프 3 (.XX.X 형태에서 가운데 두는 케이스) + 세로 open 3', () => {
    // 가로: (7,6)(7,7)(7,9) — (7,7) 배치 시 _XX_X 형태로 점프 3 인지 확인.
    // dirHasOpenThree 알고리즘: virtual 배치 후 open 4 (.XXXX.) 형성되는지 검사.
    // (7,8) 에 가상 배치 → (7,6)(7,7)(7,8)(7,9) 4 연속 + 양옆 .. → open 4. 점프 3 인정됨.
    // 세로: (7,7)(8,7)(9,7) — open 3
    const b = emptyBoard();
    place(b, 'black', [[7, 6], [7, 9]]); // 가로 점프 3 pre
    place(b, 'black', [[8, 7], [9, 7]]); // 세로 open 3 pre
    place(b, 'black', [[7, 7]]);
    assert.deepEqual(checkForbidden(b, 7, 7, 'black'), { reason: 'double_three' });
  });
});

describe('checkForbidden — 점삼 (point three, gap 2 형태)', () => {
  // 점삼: O.O.O 같이 2 칸씩 떨어진 3 stone 패턴. 표준 렌주룰에서 "3" 으로 인정 안 됨.
  // dirHasOpenThree 알고리즘은 virtual placement 후 .XXXX. (open 4) 가 형성되는지 검사하므로,
  // O.O.O 에서 어느 칸에 둬도 .XXXX. 가 만들어지지 않아 자연스럽게 "3" 비포함.

  test('가로 O.O.O + 세로 open 3 → 점삼은 3 아니므로 합법', () => {
    // 가로: (7,5)(7,7)(7,9) — 점삼 (3 으로 카운트 X)
    // 세로: (7,7)(8,7)(9,7) — open 3 1개 (3 으로 카운트 O)
    // countOpenThrees = 1 → 쌍삼 아님 → 합법
    const b = emptyBoard();
    place(b, 'black', [[7, 5], [7, 9]]);
    place(b, 'black', [[8, 7], [9, 7]]);
    place(b, 'black', [[7, 7]]);
    assert.equal(checkForbidden(b, 7, 7, 'black'), null);
  });

  test('가로 점삼 단독 → null (3 아님)', () => {
    const b = emptyBoard();
    place(b, 'black', [[7, 5], [7, 9]]);
    place(b, 'black', [[7, 7]]);
    assert.equal(checkForbidden(b, 7, 7, 'black'), null);
  });
});

describe('checkForbidden — pre-existing 3 가 (r,c) 와 무관할 때 (false positive 회귀)', () => {
  // 버그: dirHasOpenThree 가 virtual placement 후 line 어딘가에 .XXXX. 만 있으면 true 를 반환.
  // 그 open four 가 (r,c) 와 무관하게 만들어진 거여도 카운트해버려서 false positive 발생.
  // Fix: .XXXX. 가 (r,c) 와 virtual placement (= line center) 둘 다 포함하는 경우만 인정.

  test('(5,8) 두는데 가로의 기존 BB_B 가 가로 open three 로 잘못 카운트되면 안 됨', () => {
    // 사용자가 보고한 보드 — (5,8) 의 / 대각엔 진짜 open three 있지만 가로는 없음.
    // 가로 (5,2)(5,3)(5,5) 의 BB_B 는 기존부터 있던 open three (5,8) 와 무관.
    // (5,8) 의 진짜 three 는 / 대각 (5,8)(6,7)(7,6) 1 개뿐 → 쌍삼 아님 → 합법.
    const b = emptyBoard();
    place(b, 'black', [[5, 2], [5, 3], [5, 5]]); // 가로 BB_B (기존 open three, (5,8) 무관)
    place(b, 'white', [[5, 7]]);                  // 가로 BB_B 의 우측 차단 — (5,8) 의 가로 라인 격리
    place(b, 'black', [[6, 7], [7, 6]]);          // / 대각 BBB 의 일부 ((5,8) 와 함께 open three)
    place(b, 'black', [[5, 8]]);                  // 테스트 대상
    assert.equal(checkForbidden(b, 5, 8, 'black'), null,
      '(5,8) 가 만드는 open three 는 / 대각 1 개뿐 — 쌍삼 false positive 회귀 방지');
  });

  test('대조: (5,8) 자신이 양쪽 open three 만들면 쌍삼', () => {
    // 가로 (5,8)(5,9)(5,10) + 세로 (5,8)(6,8)(7,8) 둘 다 (5,8) 포함하는 open three.
    const b = emptyBoard();
    place(b, 'black', [[5, 9], [5, 10]]);
    place(b, 'black', [[6, 8], [7, 8]]);
    place(b, 'black', [[5, 8]]);
    assert.deepEqual(checkForbidden(b, 5, 8, 'black'), { reason: 'double_three' });
  });
});

describe('checkForbidden — 우선순위 (5목 > overline > 4-4 > 3-3)', () => {
  test('5목 형성 + overline 가능 패턴 → null (5목 승리 우선)', () => {
    // 가로 정확히 5: (7,3)(7,4)(7,5)(7,6)(7,7) — but no 6
    const b = emptyBoard();
    place(b, 'black', [[7, 3], [7, 4], [7, 5], [7, 6], [7, 7]]);
    assert.equal(checkForbidden(b, 7, 7, 'black'), null);
  });
});

// ============================================================
// checkWinRenju — 승리 판정 (흑은 정확히 5, 백은 5+)
// ============================================================

describe('checkWinRenju', () => {
  test('흑 가로 정확히 5: 승리 라인 반환', () => {
    const b = emptyBoard();
    place(b, 'black', [[7, 3], [7, 4], [7, 5], [7, 6], [7, 7]]);
    const win = checkWinRenju(b, 7, 7, 'black');
    assert.ok(win, '5목 인정 필요');
    assert.equal(win.length, 5);
  });

  test('흑 6 연속 (장목): 승리 아님 (금수)', () => {
    // checkWinRenju 만 호출 — checkForbidden 은 별도. 6 연속은 lineHasExactFive false.
    const b = emptyBoard();
    place(b, 'black', [[7, 2], [7, 3], [7, 4], [7, 5], [7, 6], [7, 7]]);
    assert.equal(checkWinRenju(b, 7, 7, 'black'), null);
  });

  test('백 5: 승리', () => {
    const b = emptyBoard();
    place(b, 'white', [[7, 3], [7, 4], [7, 5], [7, 6], [7, 7]]);
    const win = checkWinRenju(b, 7, 7, 'white');
    assert.ok(win);
    assert.equal(win.length, 5);
  });

  test('백 6+ (장목): 백은 승리 (백 금수 없음)', () => {
    const b = emptyBoard();
    place(b, 'white', [[7, 2], [7, 3], [7, 4], [7, 5], [7, 6], [7, 7]]);
    const win = checkWinRenju(b, 7, 7, 'white');
    assert.ok(win);
  });

  test('세로 5 승리', () => {
    const b = emptyBoard();
    place(b, 'black', [[3, 7], [4, 7], [5, 7], [6, 7], [7, 7]]);
    assert.ok(checkWinRenju(b, 7, 7, 'black'));
  });

  test('대각선 (↘) 5 승리', () => {
    const b = emptyBoard();
    place(b, 'black', [[3, 3], [4, 4], [5, 5], [6, 6], [7, 7]]);
    assert.ok(checkWinRenju(b, 7, 7, 'black'));
  });

  test('반대각선 (↗) 5 승리', () => {
    const b = emptyBoard();
    place(b, 'black', [[7, 3], [6, 4], [5, 5], [4, 6], [3, 7]]);
    assert.ok(checkWinRenju(b, 3, 7, 'black'));
  });

  test('4 연속만 있으면 승리 아님', () => {
    const b = emptyBoard();
    place(b, 'black', [[7, 4], [7, 5], [7, 6], [7, 7]]);
    assert.equal(checkWinRenju(b, 7, 7, 'black'), null);
  });

  test('승리 라인은 5칸 (정확히)', () => {
    const b = emptyBoard();
    place(b, 'white', [[7, 2], [7, 3], [7, 4], [7, 5], [7, 6], [7, 7]]);
    const win = checkWinRenju(b, 7, 7, 'white');
    assert.equal(win.length, 5, 'findWinCells 는 최대 5칸 slice');
  });
});

// ============================================================
// findForbiddenSpots — 보드 전체에서 흑 금수 위치 찾기 (클라이언트 × 오버레이)
// ============================================================

describe('findForbiddenSpots', () => {
  test('빈 보드: 빈 배열', () => {
    const b = emptyBoard();
    assert.deepEqual(findForbiddenSpots(b, 'black'), []);
  });

  test('백 color 는 항상 빈 배열 (금수 없음)', () => {
    const b = emptyBoard();
    place(b, 'black', [[7, 8], [7, 9], [8, 7], [9, 7]]);
    assert.deepEqual(findForbiddenSpots(b, 'white'), []);
  });

  test('쌍삼 형성 가능 spot 검출', () => {
    // (7,7) 에 두면 쌍삼 — pre setup
    const b = emptyBoard();
    place(b, 'black', [[7, 8], [7, 9]]);
    place(b, 'black', [[8, 7], [9, 7]]);
    const spots = findForbiddenSpots(b, 'black');
    const has77 = spots.some(([r, c]) => r === 7 && c === 7);
    assert.ok(has77, '(7,7) 은 쌍삼 spot 이어야 함');
  });

  test('overline 형성 가능 spot 검출', () => {
    // (7,6) 에 두면 6 연속 → overline
    const b = emptyBoard();
    place(b, 'black', [[7, 3], [7, 4], [7, 5], [7, 7], [7, 8]]);
    const spots = findForbiddenSpots(b, 'black');
    const has76 = spots.some(([r, c]) => r === 7 && c === 6);
    assert.ok(has76, '(7,6) 은 overline spot 이어야 함');
  });

  test('5목 형성 spot 은 금수 아님 (포함 X)', () => {
    // (7,7) 에 두면 정확히 5 → 승리 → 금수 아님
    const b = emptyBoard();
    place(b, 'black', [[7, 3], [7, 4], [7, 5], [7, 6]]);
    const spots = findForbiddenSpots(b, 'black');
    const has77 = spots.some(([r, c]) => r === 7 && c === 7);
    assert.ok(!has77, '(7,7) 은 5목 승리 spot — 금수 아님');
  });

  test('이미 돌이 있는 칸은 검출 안 됨', () => {
    const b = emptyBoard();
    b[7][7] = 1;
    const spots = findForbiddenSpots(b, 'black');
    const has77 = spots.some(([r, c]) => r === 7 && c === 7);
    assert.ok(!has77, '이미 돌이 있는 칸은 무시');
  });
});

// ============================================================
// FORBIDDEN_LABEL — UX 토스트 메시지용 라벨
// ============================================================

describe('FORBIDDEN_LABEL', () => {
  test('각 reason 에 한글 라벨 존재', () => {
    assert.ok(FORBIDDEN_LABEL.overline);
    assert.ok(FORBIDDEN_LABEL.double_four);
    assert.ok(FORBIDDEN_LABEL.double_three);
  });
});
