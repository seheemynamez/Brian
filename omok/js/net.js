// ============================================================
// WebSocket 연결 + 송수신 + 메시지 dispatcher
// ============================================================

import { state } from './state.js';
import {
  showScreen, setLobbyError, showToast, updateConnStatus,
  setReconnectOverlay, updateOnlineCount, updatePlayerCards,
  updateTurnUI, updateSpectatorList, startTimerTick, stopTimerTick,
  showGameOver, showGameOverNeutral, updateRoomsList,
} from './ui.js';
import { playSound } from './sound.js';
import { drawBoard } from './board.js';

// ============================================================
// WS 서버 URL 선택
// - GitHub Pages(seheemynamez.github.io)에서 켜진 경우: Render의 외부 서버
// - 그 외(로컬 개발, LAN, Render 직접 접속): 같은 origin
// ============================================================
// Render 배포 후 실제 URL로 교체 (예: wss://omok-server-xxxx.onrender.com/ws)
const PROD_WS_URL = 'wss://omok-server-u4rp.onrender.com/ws';

const WS_URL = (() => {
  if (location.hostname === 'seheemynamez.github.io') return PROD_WS_URL;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
})();

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
      // 게임 중 / 방 만들기 대기 중 / 재대국 대기 중 — 어느 상태이든 세션 복구 시도
      sendMessage({ type: 'resume_session', sessionId: state.sessionId, nickname: state.myNick });
    } else if (state.role === 'spectator' && state.currentRoomCode && state.screenState === 'game') {
      // 관전 중 끊김 → 같은 방으로 자동 재관전 (이슈 #9)
      sendMessage({ type: 'spectate_room', code: state.currentRoomCode, nickname: state.myNick });
    } else if (state.waitingMode === 'queue' && state.screenState === 'waiting') {
      // 랜덤 매칭 대기 중 끊김 — 큐에 다시 등록
      sendMessage({ type: 'queue_join', nickname: state.myNick, clientId: state.clientId });
    }
    // 로비에 있다면 방 목록 즉시 요청 (자동 푸시 전 초기 상태)
    if (state.screenState === 'lobby') {
      sendMessage({ type: 'request_rooms_list' });
    }
  });
  state.ws.addEventListener('close', () => {
    state.connected = false;
    updateConnStatus();
    if (state.sessionId && state.screenState === 'game' && !state.gameOver) {
      setReconnectOverlay(true, '연결이 끊겨 다시 연결하고 있어요...');
    } else if (state.screenState === 'waiting') {
      // 대기 화면(랜덤 매칭 / 방 만들기) — 안내 문구로 상황 표시
      const detail = document.getElementById('waiting-detail');
      if (detail) detail.textContent = '연결이 끊겨 다시 시도하는 중…';
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
    case 'queue_canceled':     return onQueueCanceled();
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
    case 'rooms_list':         return updateRoomsList(msg.rooms);
    case 'error':              return onError(msg);
  }
};

// ---- 핸들러들 ----
const onRoomCreated = (msg) => {
  state.currentRoomCode = msg.code;
  state.waitingMode = 'room';
  // 방장에게 발급된 sessionId 를 URL 해시에 저장해두면, 다른 탭/네트워크 끊김 후
  // 자동으로 resume_session 으로 복구된다 (이슈 #9).
  if (msg.sessionId) {
    state.sessionId = msg.sessionId;
    setSessionInUrl(msg.sessionId);
  }
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

const onQueueCanceled = () => {
  // 서버에서 큐 등록을 취소했음 (예: 같은 브라우저에서 새 매칭 요청이 들어와 이전 등록을 정리)
  // 사용자가 다른 탭에서 매칭 다시 누른 경우이므로 조용히 로비로 복귀
  state.waitingMode = null;
  state.currentRoomCode = null;
  showScreen('lobby');
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
  setReconnectOverlay(false);

  // 상대 모집 중 (status=waiting) 에 끊겼다가 복구된 경우 — 대기 화면으로 (게임 화면 X)
  if (msg.status === 'waiting') {
    state.waitingMode = 'room';
    document.getElementById('waiting-title').textContent = '상대를 기다리는 중';
    document.getElementById('waiting-code').textContent = state.currentRoomCode || '';
    document.getElementById('waiting-detail').textContent = '이 코드를 친구에게 공유하세요';
    showScreen('waiting');
    return;
  }

  // playing 또는 over — 게임 화면으로 복귀
  state.waitingMode = null;
  document.getElementById('room-code-display').textContent = state.currentRoomCode ? '방 코드 · ' + state.currentRoomCode : '';
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
  showGameOver(msg.winner, msg.reason);
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
