// ============================================================
// 흑백 슬롯 결정 / swap — startGame 직전 또는 rematch 시 사용.
// 기존 handlers/game.js 안에 있었으나 단위 테스트가 game.js → bot.js → bot-pool
// (worker_threads) 까지 끌어들여 CI 에서 test runner 가 종료되지 않는 문제가 있어
// 별도 모듈로 분리. dependency 는 domain (rooms / users) + connections 만 — worker 없음.
// ============================================================

const { getSession } = require('../domain/rooms');
const connections = require('../connections');
const { compareForBlack, userForSlot } = require('../domain/users');

// black/white 슬롯 swap (sessions.color + ws.color 동기화).
// rematch.js 의 패자-흑 swap + assignColorsByRating 의 약자-흑 swap 둘 다 사용.
const swapSlots = (room) => {
  const blackSlot = room.players.black;
  const whiteSlot = room.players.white;
  room.players.black = whiteSlot;
  room.players.white = blackSlot;
  if (whiteSlot?.sessionId) {
    const sess = getSession(whiteSlot.sessionId);
    if (sess) sess.color = 'black';
    const w = connections.getWsBySessionId(whiteSlot.sessionId);
    if (w) w.color = 'black';
  }
  if (blackSlot?.sessionId) {
    const sess = getSession(blackSlot.sessionId);
    if (sess) sess.color = 'white';
    const w = connections.getWsBySessionId(blackSlot.sessionId);
    if (w) w.color = 'white';
  }
};

// 첫 게임 흑백 결정 — rating 약자 우선 (= 흑, 선공). 봇전 / PVP 모두 적용.
// 룸 만든 사람 / 큐 도착 순서 / 봇 모달 first 무관. tie-break 는 wins / losses / draws /
// createdAt (compareForBlack). rematch 인 경우 본 함수 안 호출 — 패자 흑 정책 유지.
const assignColorsByRating = (room) => {
  if (!room?.players?.black || !room.players.white) return;
  const blackUser = userForSlot(room.players.black);
  const whiteUser = userForSlot(room.players.white);
  if (!blackUser || !whiteUser) return;
  // compareForBlack(a, b) < 0 이면 a 가 흑. 현재 black 슬롯의 user 가 약자 아니면 swap.
  if (compareForBlack(blackUser, whiteUser) > 0) {
    swapSlots(room);
  }
};

module.exports = { swapSlots, assignColorsByRating };
