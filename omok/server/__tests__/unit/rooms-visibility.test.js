// ============================================================
// 방 visibility (public/private) 도메인 로직 단위 테스트.
// ============================================================

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createRoom, getRoomsList, findEmptyPublicRoom, setRoom, deleteRoom } = require('../../domain/rooms');
const connections = require('../../connections');

// findEmptyPublicRoom 은 방장 ws 가 active (OPEN) 인지 검증함 — 좀비 방 차단용.
// unit test 의 mock slot 에 fake ws (readyState=OPEN) 를 connections 에 bind.
const OPEN = 1;
// 실 WebSocket instance 는 instance.OPEN === 1 상수도 가지므로 fake 에도 추가 (findEmptyPublicRoom 의 ws.readyState === ws.OPEN 검증 통과용).
const bindFakeWs = (sid) => {
  const fakeWs = { readyState: OPEN, OPEN, sessionId: sid };
  connections.bindSession(fakeWs, sid);
  return fakeWs;
};

// 테스트 간 정리 — 같은 process 안에서 store 가 공유되므로 명시적 cleanup 필요.
const cleanup = (codes) => codes.forEach((c) => deleteRoom(c));

// player slot helper — fake ws 까지 같이 bind
const setBlackSlot = (room, clientId, nickname) => {
  const sid = 's-' + room.code + '-b';
  room.players.black = { sessionId: sid, clientId, nickname, type: 'human' };
  bindFakeWs(sid);
};
const setWhiteSlot = (room, clientId, nickname) => {
  const sid = 's-' + room.code + '-w';
  room.players.white = { sessionId: sid, clientId, nickname, type: 'human' };
  bindFakeWs(sid);
};

describe('createRoom(visibility)', () => {
  test('default = public', () => {
    const r = createRoom('TST1');
    assert.equal(r.visibility, 'public');
  });
  test('visibility=public 명시', () => {
    const r = createRoom('TST2', 'public');
    assert.equal(r.visibility, 'public');
  });
  test('visibility=private 명시', () => {
    const r = createRoom('TST3', 'private');
    assert.equal(r.visibility, 'private');
  });
  test('알 수 없는 값 → public 으로 sanitize', () => {
    const r = createRoom('TST4', 'foo');
    assert.equal(r.visibility, 'public');
  });
});

describe('getRoomsList — visibility 필터', () => {
  test('waiting + public → 노출', () => {
    const r = createRoom('LV1', 'public');
    setBlackSlot(r, 'c', 'A');
    setRoom('LV1', r);
    const list = getRoomsList();
    const found = list.find((x) => x.code === 'LV1');
    assert.ok(found, 'public 대기 방은 list 에 있어야 함');
    assert.equal(found.visibility, 'public');
    cleanup(['LV1']);
  });

  test('waiting + private → 안 보임', () => {
    const r = createRoom('LV2', 'private');
    setBlackSlot(r, 'c', 'A');
    setRoom('LV2', r);
    const list = getRoomsList();
    const found = list.find((x) => x.code === 'LV2');
    assert.equal(found, undefined, 'private 대기 방은 list 에 없어야 함');
    cleanup(['LV2']);
  });

  test('playing + private → 노출 (관전 모집)', () => {
    const r = createRoom('LV3', 'private');
    setBlackSlot(r, 'c1', 'A');
    setWhiteSlot(r, 'c2', 'B');
    r.status = 'playing';
    setRoom('LV3', r);
    const list = getRoomsList();
    const found = list.find((x) => x.code === 'LV3');
    assert.ok(found, '매칭된 private 방은 list 에 노출');
    assert.equal(found.visibility, 'private');
    cleanup(['LV3']);
  });

  test('legacy data (visibility 없음) → public 으로 처리', () => {
    const r = createRoom('LV4', 'public');
    delete r.visibility;          // legacy 시뮬레이션
    setBlackSlot(r, 'c', 'A');
    setRoom('LV4', r);
    const list = getRoomsList();
    const found = list.find((x) => x.code === 'LV4');
    assert.ok(found, 'visibility 누락 = public 처리');
    cleanup(['LV4']);
  });
});

describe('findEmptyPublicRoom — 매칭 대상 탐색', () => {
  test('빈 public 방 1개 → 반환', () => {
    const r = createRoom('FE1', 'public');
    setBlackSlot(r, 'host', 'Host');
    setRoom('FE1', r);
    const found = findEmptyPublicRoom('other');
    assert.ok(found, 'public 빈 방이 매칭 후보');
    assert.equal(found.code, 'FE1');
    cleanup(['FE1']);
  });

  test('빈 private 방은 무시', () => {
    const r = createRoom('FE2', 'private');
    setBlackSlot(r, 'host', 'Host');
    setRoom('FE2', r);
    const found = findEmptyPublicRoom('other');
    assert.equal(found, null, 'private 빈 방은 매칭 안 됨');
    cleanup(['FE2']);
  });

  test('자기 방 (excludeClientId 일치) 제외', () => {
    const r = createRoom('FE3', 'public');
    setBlackSlot(r, 'me', 'Me');
    setRoom('FE3', r);
    const found = findEmptyPublicRoom('me');
    assert.equal(found, null, '자기 방은 매칭 안 됨');
    cleanup(['FE3']);
  });

  test('이미 두 자리 찬 방 (playing) 무시', () => {
    const r = createRoom('FE4', 'public');
    setBlackSlot(r, 'a', 'A');
    setWhiteSlot(r, 'b', 'B');
    r.status = 'playing';
    setRoom('FE4', r);
    const found = findEmptyPublicRoom('other');
    assert.equal(found, null, '이미 매칭된 방은 매칭 대상 아님');
    cleanup(['FE4']);
  });

  test('봇 게임 방 (hasBot=true) 무시', () => {
    const r = createRoom('FE5', 'public');
    setBlackSlot(r, 'a', 'A');
    r.hasBot = true;
    setRoom('FE5', r);
    const found = findEmptyPublicRoom('other');
    assert.equal(found, null, '봇 방은 큐 매칭 대상 아님');
    cleanup(['FE5']);
  });

  test('FIFO — 가장 오래된 (createdAt 작은) 방 우선', async () => {
    const r1 = createRoom('FE6', 'public');
    setBlackSlot(r1, 'a', 'A');
    r1.createdAt = 1_000;
    setRoom('FE6', r1);
    const r2 = createRoom('FE7', 'public');
    setBlackSlot(r2, 'b', 'B');
    r2.createdAt = 2_000;
    setRoom('FE7', r2);
    const found = findEmptyPublicRoom('other');
    assert.ok(found);
    assert.equal(found.code, 'FE6', '오래된 방 (FE6) 이 먼저');
    cleanup(['FE6', 'FE7']);
  });

  test('빈 public 방 없음 → null', () => {
    // 다른 test 의 잔여물 cleanup
    const found = findEmptyPublicRoom('other');
    assert.equal(found, null);
  });
});
