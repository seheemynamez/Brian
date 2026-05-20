// ============================================================
// 서버 / 클라이언트 renju 룰 sync 검증.
// omok/server/game/renju.js 와 omok/js/renju.js 의 공유 함수 body 가 같은지 비교.
// 한 쪽만 수정하고 다른 쪽 안 고치는 버그 회귀 방지 (서버 = final authority,
// 클라이언트 = × 오버레이 hint 이므로 둘이 어긋나면 UX 깨짐).
// ============================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const SERVER_PATH = path.join(__dirname, '..', '..', 'game', 'renju.js');
const CLIENT_PATH = path.join(__dirname, '..', '..', '..', 'js', 'renju.js');

// 양쪽이 동일하게 가져야 하는 핵심 함수 — 변경 시 둘 다 sync 필요.
const SHARED_FUNCTIONS = [
  'lineAt',
  'lineHasExactFive',
  'lineHasFive',
  'lineHasOverline',
  'lineHasOpenFour',
  'lineHasFour',
  'dirHasOpenThree',
  'countOpenThrees',
  'countFours',
  'moveCreatesOverline',
  'moveCreatesExactFive',
  'checkForbidden',
  'findForbiddenSpots',
];

// `(export )? function name(...) { body }` 의 body 만 추출.
// 중괄호 카운트로 매칭. body 만 비교하므로 export prefix 차이는 무시.
const extractFnBody = (src, name) => {
  const re = new RegExp(`(?:export\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`);
  const m = re.exec(src);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(m.index + m[0].length, i - 1).trim();
};

const serverSrc = fs.readFileSync(SERVER_PATH, 'utf8');
const clientSrc = fs.readFileSync(CLIENT_PATH, 'utf8');

describe('renju 룰 서버/클라 parity', () => {
  for (const name of SHARED_FUNCTIONS) {
    test(`${name} body 동일`, () => {
      const sBody = extractFnBody(serverSrc, name);
      const cBody = extractFnBody(clientSrc, name);
      assert.ok(sBody, `server renju.js 에 function ${name} 없음`);
      assert.ok(cBody, `client renju.js 에 function ${name} 없음`);
      assert.equal(sBody, cBody, `${name} body 가 서버/클라이언트에서 다름 — 한 쪽만 수정한 듯`);
    });
  }
});
