// ============================================================
// WebSocket 연결 + 송수신 + 메시지 dispatcher
// ============================================================

import { state } from './state.js';
import {
  showScreen, setLobbyError, showToast, updateConnStatus,
  setReconnectOverlay, updateOnlineCount, updatePlayerCards,
  updateTurnUI, updateSpectatorList, startTimerTick, stopTimerTick,
  showGameOver, showGameOverNeutral, updateRoomsList, showEmote,
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

// ---- 세션 저장 (sessionStorage 사용)
// URL 해시(#session=...) 대신 sessionStorage 에 저장한다.
//   - 공유 가능한 URL 에 세션 ID 가 노출되지 않음
//   - 탭 단위 격리: 같은 도메인이라도 다른 탭에선 자동 복구되지 않음 (의도된 동작)
// 이전 버전 사용자 호환: hash 에 session 이 남아있다면 한 번 읽어 sessionStorage 로 옮기고 hash 정리.
const SESSION_KEY = 'omok_session';

const setSession = (id) => {
  try {
    if (id) sessionStorage.setItem(SESSION_KEY, id);
    else    sessionStorage.removeItem(SESSION_KEY);
  } catch {}
};

export const getSession = () => {
  const m = location.hash.match(/session=([^&]+)/);
  if (m) {
    const fromHash = decodeURIComponent(m[1]);
    try { sessionStorage.setItem(SESSION_KEY, fromHash); } catch {}
    history.replaceState(null, '', location.pathname + location.search);
    return fromHash;
  }
  try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; }
};

// ---- 방 코드 URL 파라미터 (?room=XXXX)
// 방 안에 있는 동안 URL 자체가 공유 가능한 초대 링크가 된다.
// 방을 떠나거나 실패하면 즉시 제거 — URL 이 현재 상태와 일치하도록 유지.
const setRoomInUrl = (code) => {
  const url = new URL(location.href);
  if (code) url.searchParams.set('room', code);
  else      url.searchParams.delete('room');
  const qs = url.searchParams.toString();
  history.replaceState(null, '', url.pathname + (qs ? '?' + qs : '') + url.hash);
};

export const getRoomFromUrl = () => {
  const code = new URL(location.href).searchParams.get('room');
  if (!code) return null;
  const c = code.toUpperCase().trim();
  if (!/^[A-Z0-9]{4}$/.test(c)) return null;
  return c;
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
    } else if (state.pendingDirectJoin) {
      // 직접 링크(?room=) 진입 모달에서 사용자가 확정했지만 WS 가 아직 안 열려있었던 경우
      sendMessage(state.pendingDirectJoin);
      state.pendingDirectJoin = null;
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
    case 'emote':              return showEmote(msg.from, msg.emoji, msg.text);
    case 'error':              return onError(msg);
  }
};

// ---- 핸들러들 ----
const onRoomCreated = (msg) => {
  state.currentRoomCode = msg.code;
  state.waitingMode = 'room';
  if (msg.sessionId) {
    state.sessionId = msg.sessionId;
    setSession(msg.sessionId);
  }
  setRoomInUrl(msg.code);
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
  setRoomInUrl(null);
  showScreen('lobby');
};

const onMatched = (msg) => {
  // 자동매칭에서 코드가 부여될 때 (game_start가 곧 따라옴 — 여기선 코드만 기억)
  state.currentRoomCode = msg.code;
  setRoomInUrl(msg.code);
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
    setSession(msg.sessionId);
  }
  if (msg.code) state.currentRoomCode = msg.code;
  if (state.currentRoomCode) setRoomInUrl(state.currentRoomCode);
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
  setSession(null);
  setRoomInUrl(msg.code);
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
  setSession(state.sessionId);
  if (state.currentRoomCode) setRoomInUrl(state.currentRoomCode);
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
  state.currentRoomCode = null;
  setSession(null);
  setRoomInUrl(null);
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
  setSession(null);
  // currentRoomCode 와 URL ?room= 은 게임 끝난 화면에서 결과를 보는 동안 유지.
  // 사용자가 '방 나가기' 누를 때 leaveRoomAndGoLobby 에서 정리됨.
};

const onError = (msg) => {
  if (state.screenState === 'lobby') {
    setLobbyError(msg.message);
    // 직접 링크로 들어왔다가 join 이 실패한 경우 → URL 의 ?room= 도 정리해서
    // 새로고침해도 같은 에러가 반복되지 않게 한다.
    setRoomInUrl(null);
  } else {
    showToast(msg.message);
  }
};

export { setSession, setRoomInUrl };
