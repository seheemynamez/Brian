// ============================================================
// 진입점: 초기화 + 사용자 이벤트 바인딩
// ============================================================

import { state } from './state.js';
import {
  showScreen, setLobbyError, updateConnStatus, updateMuteButton,
  setReconnectOverlay, resetGameLocal, updateOnlineCount,
} from './ui.js';
import { initAudio } from './sound.js';
import { connect, sendMessage, readSessionFromUrl, setSessionInUrl } from './net.js';
import { drawBoard, getBoardCoord } from './board.js';

const $ = (id) => document.getElementById(id);

// ---- 보드 클릭 ----
const onBoardClick = (e) => {
  if (state.gameOver || state.role !== 'player' || state.currentTurn !== state.myColor) return;
  const coord = getBoardCoord(e.clientX, e.clientY);
  if (!coord) return;
  if (state.board[coord.row][coord.col] !== 0) return;
  sendMessage({ type: 'move', row: coord.row, col: coord.col });
};

// ---- 닉네임 ----
const setupNickname = () => {
  const input = $('nick-input');
  input.value = localStorage.getItem('omok_nick') || '';
  state.myNick = input.value;
  input.addEventListener('input', (e) => {
    state.myNick = e.target.value.trim();
    localStorage.setItem('omok_nick', state.myNick);
  });
};

// ---- 로비 액션 ----
const setupLobby = () => {
  $('btn-create').addEventListener('click', () => {
    setLobbyError('');
    if (!state.myNick) return setLobbyError('닉네임을 먼저 입력하세요');
    initAudio();
    sendMessage({ type: 'create_room', nickname: state.myNick });
  });
  $('btn-join').addEventListener('click', () => {
    setLobbyError('');
    if (!state.myNick) return setLobbyError('닉네임을 먼저 입력하세요');
    const code = $('code-input').value.trim().toUpperCase();
    if (code.length !== 4) return setLobbyError('4글자 코드를 입력하세요');
    initAudio();
    sendMessage({ type: 'join_room', code, nickname: state.myNick });
  });
  $('btn-spectate').addEventListener('click', () => {
    setLobbyError('');
    if (!state.myNick) return setLobbyError('닉네임을 먼저 입력하세요');
    const code = $('code-input').value.trim().toUpperCase();
    if (code.length !== 4) return setLobbyError('4글자 코드를 입력하세요');
    initAudio();
    sendMessage({ type: 'spectate_room', code, nickname: state.myNick });
  });
  $('btn-queue').addEventListener('click', () => {
    setLobbyError('');
    if (!state.myNick) return setLobbyError('닉네임을 먼저 입력하세요');
    initAudio();
    sendMessage({ type: 'queue_join', nickname: state.myNick, clientId: state.clientId });
  });
  $('code-input').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase();
  });
  $('code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-join').click();
  });

  // 방 목록 카드 클릭 → 대기 중이면 참가, 대전 중이면 관전
  $('rooms-list').addEventListener('click', (e) => {
    const item = e.target.closest('.room-item');
    if (!item) return;
    setLobbyError('');
    if (!state.myNick) return setLobbyError('닉네임을 먼저 입력하세요');
    initAudio();
    const code = item.dataset.code;
    const action = item.dataset.action;
    if (action === 'join') {
      sendMessage({ type: 'join_room', code, nickname: state.myNick });
    } else {
      sendMessage({ type: 'spectate_room', code, nickname: state.myNick });
    }
  });
};

// ---- 대기 화면 ----
const setupWaiting = () => {
  $('btn-cancel').addEventListener('click', () => {
    if (state.waitingMode === 'queue') sendMessage({ type: 'queue_leave' });
    else if (state.waitingMode === 'room') sendMessage({ type: 'leave_room' });
    state.currentRoomCode = null;
    state.waitingMode = null;
    // 방 만들기에서 발급된 sessionId 정리 (자동 resume 방지)
    state.sessionId = null;
    setSessionInUrl(null);
    showScreen('lobby');
  });
};

// ---- 게임 화면 ----
const leaveRoomAndGoLobby = () => {
  sendMessage({ type: 'leave_room' });
  resetGameLocal();
  setSessionInUrl(null);
  showScreen('lobby');
};

const showLeaveConfirm = (show) => {
  $('leave-confirm-overlay').classList.toggle('hidden', !show);
};

const setupGame = () => {
  $('board').addEventListener('click', onBoardClick);
  $('btn-rematch').addEventListener('click', () => {
    sendMessage({ type: 'rematch' });
    $('rematch-pending').classList.remove('hidden');
  });
  // 게임오버 카드 안의 "방 나가기" — 게임이 이미 끝났으므로 바로 나감
  $('btn-leave').addEventListener('click', leaveRoomAndGoLobby);

  // 항상 보이는 "방 나가기" (관전/대전 중 모두)
  $('btn-leave-game').addEventListener('click', () => {
    // 관전 중이거나 게임이 이미 끝났으면 즉시 나감
    if (state.role === 'spectator' || state.gameOver) {
      leaveRoomAndGoLobby();
      return;
    }
    // 대전 중 → 확인 모달
    showLeaveConfirm(true);
  });
  $('btn-leave-cancel').addEventListener('click', () => showLeaveConfirm(false));
  $('btn-leave-confirm').addEventListener('click', () => {
    showLeaveConfirm(false);
    leaveRoomAndGoLobby();
  });
};

// ---- 음소거 ----
const setupMute = () => {
  $('btn-mute').addEventListener('click', () => {
    state.muted = !state.muted;
    localStorage.setItem('omok_muted', state.muted ? '1' : '0');
    updateMuteButton();
    if (!state.muted) initAudio();
  });
  ['click', 'keydown', 'touchstart'].forEach((ev) =>
    document.addEventListener(ev, initAudio, { once: true }));
};

// ---- 시작 ----
setupNickname();
setupLobby();
setupWaiting();
setupGame();
setupMute();
updateMuteButton();
updateOnlineCount(0);
showScreen('lobby');
drawBoard();
updateConnStatus();

// URL hash에 세션이 있으면 자동 복구
const urlSession = readSessionFromUrl();
if (urlSession) {
  state.sessionId = urlSession;
  setReconnectOverlay(true, '이전 게임을 복구하는 중...');
}

connect();
