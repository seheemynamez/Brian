// ============================================================
// WebSocket 연결 + 송수신 + 메시지 dispatcher
// ============================================================

import { state } from './state.js';
import {
  showScreen, setLobbyError, showToast, updateConnStatus,
  setReconnectOverlay, updateOnlineCount, updatePlayerCards,
  updateTurnUI, updateSpectatorList, startTimerTick, stopTimerTick,
  showGameOver, showGameOverNeutral,
} from './ui.js';
import { playSound } from './sound.js';
import { drawBoard } from './board.js';

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

// ---- URL hash 세션 ----
const setSessionInUrl = (id) => {
  if (id) history.replaceState(null, '', '#session=' + id);
  else    history.replaceState(null, '', location.pathname + location.search);
};

export const readSessionFromUrl = () => {
  const m = location.hash.match(/session=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
};

// ---- 송신 ----
export const sendMessage = (obj) => {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  }
};

// ---- 연결 ----
export const connect = () => {
  state.ws = new WebSocket(WS_URL);
  state.ws.addEventListener('open', () => {
    state.connected = true;
    updateConnStatus();
    if (state.sessionId) {
      sendMessage({ type: 'resume_session', sessionId: state.sessionId, nickname: state.myNick });
    }
  });
  state.ws.addEventListener('close', () => {
    state.connected = false;
    updateConnStatus();
    if (state.sessionId && state.screenState === 'game' && !state.gameOver) {
      setReconnectOverlay(true, '연결이 끊겨 다시 연결하고 있어요...');
    }
    setTimeout(connect, 1500);
  });
  state.ws.addEventListener('error', () => {});
  state.ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    dispatch(msg);
  });
};

// ---- 메시지 처리 ----
const dispatch = (msg) => {
  switch (msg.type) {
    case 'room_created':       return onRoomCreated(msg);
    case 'queue_waiting':      return onQueueWaiting();
    case 'matched':            return onMatched(msg);
    case 'game_start':         return onGameStart(msg);
    case 'spectate_success':   return onSpectateSuccess(msg);
    case 'resume_success':     return onResumeSuccess(msg);
    case 'resume_failed':      return onResumeFailed();
    case 'move':               return onMove(msg);
    case 'turn_started':       return onTurnStarted(msg);
    case 'turn_skipped':       return onTurnSkipped(msg);
    case 'game_over':          return onGameOver(msg);
    case 'rematch_pending':    return onRematchPending(msg);
    case 'opponent_disconnected': return onOpponentDisconnected();
    case 'opponent_reconnected':  return onOpponentReconnected();
    case 'opponent_left':         return onOpponentGone('상대가 방을 나갔어요');
    case 'opponent_abandoned':    return onOpponentGone('상대가 돌아오지 않아 종료');
    case 'spectator_list':     return updateSpectatorList(msg.spectators);
    case 'online_count':       return updateOnlineCount(msg.n);
    case 'error':              return onError(msg);
  }
};

// ---- 핸들러들 ----
const onRoomCreated = (msg) => {
  state.currentRoomCode = msg.code;
  state.waitingMode = 'room';
  document.getElementById('waiting-title').textContent = '상대를 기다리는 중';
  document.getElementById('waiting-code').textContent = msg.code;
  document.getElementById('waiting-detail').textContent = '이 코드를 친구에게 공유하세요';
  showScreen('waiting');
};

const onQueueWaiting = () => {
  state.waitingMode = 'queue';
  document.getElementById('waiting-title').textContent = '랜덤 매칭 중';
  document.getElementById('waiting-code').textContent = '';
  document.getElementById('waiting-detail').textContent = '누구와든 곧 매칭됩니다';
  showScreen('waiting');
};

const onMatched = (msg) => {
  // 자동매칭에서 코드가 부여될 때 (game_start가 곧 따라옴 — 여기선 코드만 기억)
  state.currentRoomCode = msg.code;
};

const onGameStart = (msg) => {
  state.myColor = msg.you;
  state.nicknames = msg.nicknames;
  state.myNick = msg.nicknames[msg.you];
  state.board = msg.board;
  state.currentTurn = msg.turn;
  state.winLine = null;
  state.lastMove = null;
  state.gameOver = false;
  state.role = 'player';
  if (msg.sessionId) {
    state.sessionId = msg.sessionId;
    setSessionInUrl(msg.sessionId);
  }
  if (msg.code) state.currentRoomCode = msg.code;
  updateSpectatorList(msg.spectators || []);
  document.getElementById('room-code-display').textContent = state.currentRoomCode ? '방 코드 · ' + state.currentRoomCode : '';
  document.getElementById('game-over').classList.add('hidden');
  document.getElementById('rematch-pending').classList.add('hidden');
  setReconnectOverlay(false);
  updatePlayerCards();
  showScreen('game');
  drawBoard();
  updateTurnUI();
  playSound('turn_start');
};

const onSpectateSuccess = (msg) => {
  state.role = 'spectator';
  state.myColor = null;
  state.nicknames = msg.nicknames;
  state.board = msg.board;
  state.currentTurn = msg.turn;
  state.winLine = msg.line || null;
  state.lastMove = msg.lastMove || null;
  state.gameOver = msg.status === 'over';
  state.currentRoomCode = msg.code;
  state.sessionId = null;
  setSessionInUrl(null);
  state.turnDeadline = msg.turnDeadline || null;
  updateSpectatorList(msg.spectators || []);
  document.getElementById('room-code-display').textContent = '관전 중 · ' + msg.code;
  document.getElementById('game-over').classList.add('hidden');
  document.getElementById('rematch-pending').classList.add('hidden');
  setReconnectOverlay(false);
  updatePlayerCards();
  showScreen('game');
  drawBoard();
  updateTurnUI();
  if (state.gameOver) {
    stopTimerTick();
    showGameOver(msg.winner);
  } else if (state.turnDeadline) {
    startTimerTick();
  }
};

const onResumeSuccess = (msg) => {
  state.myColor = msg.you;
  state.nicknames = msg.nicknames;
  state.myNick = msg.nicknames[msg.you];
  state.board = msg.board;
  state.currentTurn = msg.turn;
  state.winLine = msg.line || null;
  state.lastMove = msg.lastMove || null;
  state.gameOver = msg.status === 'over';
  state.role = 'player';
  state.sessionId = msg.sessionId;
  state.currentRoomCode = msg.code || state.currentRoomCode;
  setSessionInUrl(state.sessionId);
  state.turnDeadline = msg.turnDeadline || null;
  updateSpectatorList(msg.spectators || []);
  document.getElementById('room-code-display').textContent = state.currentRoomCode ? '방 코드 · ' + state.currentRoomCode : '';
  setReconnectOverlay(false);
  updatePlayerCards();
  showScreen('game');
  drawBoard();
  updateTurnUI();
  if (state.gameOver) {
    stopTimerTick();
    showGameOver(msg.winner);
  } else {
    startTimerTick();
  }
};

const onResumeFailed = () => {
  state.sessionId = null;
  setSessionInUrl(null);
  setReconnectOverlay(false);
  showScreen('lobby');
  setLobbyError('이전 게임을 복구할 수 없어요 (만료됨)');
};

const onMove = (msg) => {
  state.board[msg.row][msg.col] = msg.color === 'black' ? 1 : 2;
  state.lastMove = [msg.row, msg.col];
  if (state.role === 'spectator') {
    playSound('stone_opp');
  } else {
    playSound(msg.color === state.myColor ? 'stone_self' : 'stone_opp');
  }
  if (msg.turn) state.currentTurn = msg.turn;
  drawBoard();
  updateTurnUI();
};

const onTurnStarted = (msg) => {
  state.currentTurn = msg.turn;
  state.turnDeadline = msg.deadline;
  startTimerTick();
  updateTurnUI();
};

const onTurnSkipped = (msg) => {
  state.currentTurn = msg.turn;
  let who;
  if (state.role === 'spectator') who = (msg.skipped === 'black' ? '흑' : '백');
  else who = (msg.skipped === state.myColor ? '내' : '상대');
  showToast(`${who} 차례 시간 초과로 넘어갔어요`);
  playSound('skip');
  updateTurnUI();
};

const onGameOver = (msg) => {
  state.gameOver = true;
  state.winLine = msg.line;
  stopTimerTick();
  drawBoard();
  showGameOver(msg.winner);
};

const onRematchPending = (msg) => {
  if (msg.who !== state.myColor) showToast('상대가 다시 두기를 원해요. "다시 두기"를 누르면 시작!');
  else document.getElementById('rematch-pending').classList.remove('hidden');
};

const onOpponentDisconnected = () => {
  showToast('상대 연결 끊김 — 30초 안에 돌아오지 않으면 게임 종료');
};

const onOpponentReconnected = () => {
  showToast('상대 재연결됨');
};

const onOpponentGone = (text) => {
  state.gameOver = true;
  stopTimerTick();
  showToast(text);
  showGameOverNeutral(text);
  state.sessionId = null;
  setSessionInUrl(null);
};

const onError = (msg) => {
  if (state.screenState === 'lobby') setLobbyError(msg.message);
  else showToast(msg.message);
};

export { setSessionInUrl };
