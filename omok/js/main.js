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
    sendMessage({ type: 'queue_join', nickname: state.myNick });
  });
  $('code-input').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase();
  });
  $('code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-join').click();
  });
};

// ---- 대기 화면 ----
const setupWaiting = () => {
  $('btn-cancel').addEventListener('click', () => {
    if (state.waitingMode === 'queue') sendMessage({ type: 'queue_leave' });
    else if (state.waitingMode === 'room') sendMessage({ type: 'leave_room' });
    state.currentRoomCode = null;
    state.waitingMode = null;
    showScreen('lobby');
  });
};

// ---- 게임 화면 ----
const setupGame = () => {
  $('board').addEventListener('click', onBoardClick);
  $('btn-rematch').addEventListener('click', () => {
    sendMessage({ type: 'rematch' });
    $('rematch-pending').classList.remove('hidden');
  });
  $('btn-leave').addEventListener('click', () => {
    sendMessage({ type: 'leave_room' });
    resetGameLocal();
    setSessionInUrl(null);
    showScreen('lobby');
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
