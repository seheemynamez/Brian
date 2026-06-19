// ============================================================
// WebSocket 연결 + 송수신 + 메시지 dispatcher
// ============================================================

import { state } from './state.js';
import {
  showScreen, setLobbyError, showToast, updateConnStatus,
  setReconnectOverlay, updateOnlineCount, updatePlayerCards,
  updateTurnUI, updateSpectatorList, startTimerTick, stopTimerTick,
  pauseTurnTimer, resumeTurnTimer,
  showGameOver, showGameOverNeutral, updateRoomsList, showEmote, showOnlineList,
  updateRanking, updateRecentGames,
} from './ui.js';
import { playSound } from './sound.js';
import { drawBoard } from './board.js';

// ============================================================
// WS 서버 URL 선택
// - GitHub Pages(seheemynamez.github.io)에서 켜진 경우: Render의 외부 서버
// - 그 외(로컬 개발, LAN, Render 직접 접속): 같은 origin
// ============================================================
// Render 배포 후 실제 URL로 교체 (예: wss://omok-server-xxxx.onrender.com/ws)
const PROD_WS_URL     = 'wss://omok-server-dorf.onrender.com/ws';
const PROD_SHARE_BASE = 'https://omok-server-dorf.onrender.com';

const WS_URL = (() => {
  if (location.hostname === 'seheemynamez.github.io') return PROD_WS_URL;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
})();

// 공유용 초대 링크 — /i/CODE?n=NICK
// 운영(GitHub Pages): Render 서버가 동적 OG 메타를 렌더링 → 메신저 프리뷰가 닉네임으로 노출됨
// 그 외(로컬·LAN): 같은 origin 의 share 엔드포인트 사용
export const buildShareUrl = (code, nick) => {
  if (!code) return location.href;
  const base = location.hostname === 'seheemynamez.github.io' ? PROD_SHARE_BASE : location.origin;
  const params = new URLSearchParams();
  if (nick) params.set('n', nick);
  const qs = params.toString();
  return `${base}/i/${encodeURIComponent(code)}${qs ? '?' + qs : ''}`;
};

// ---- 세션 저장 (sessionStorage 사용)
// URL 해시(#session=...) 대신 sessionStorage 에 저장한다.
//   - 공유 가능한 URL 에 세션 ID 가 노출되지 않음
//   - 탭 단위 격리: 같은 도메인이라도 다른 탭에선 자동 복구되지 않음 (의도된 동작)
const SESSION_KEY = 'omok_session';

const setSession = (id) => {
  try {
    if (id) sessionStorage.setItem(SESSION_KEY, id);
    else    sessionStorage.removeItem(SESSION_KEY);
  } catch {}
};

export const getSession = () => {
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

// ---- 재연결 백오프 + app-level heartbeat ----
// 고정 간격 재연결은 서버 다운/cold start 시 과한 요청을 만든다.
// 1s → 2s → 4s → 8s → 16s → 30s 의 지수 백오프 + 동일 시점 동시 재연결을 분산시키는 jitter.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS  = 30000;
const RECONNECT_JITTER_MS = 500;
// 서버 heartbeat(30s)보다 약간 짧게 보내, 네트워크가 죽었으면 서버가 더 빨리 알아채게 한다.
const APP_PING_INTERVAL_MS = 25000;

let reconnectAttempt = 0;
let reconnectTimer = null;
let appPingTimer = null;

const clearReconnectTimer = () => {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
};
const clearAppPingTimer = () => {
  if (appPingTimer) { clearInterval(appPingTimer); appPingTimer = null; }
};

const scheduleReconnect = () => {
  clearReconnectTimer();
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt), RECONNECT_MAX_MS)
              + Math.floor(Math.random() * RECONNECT_JITTER_MS);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(connect, delay);
};

// ---- 연결 ----
export const connect = () => {
  clearReconnectTimer();
  state.ws = new WebSocket(WS_URL);
  state.ws.addEventListener('open', () => {
    state.connected = true;
    reconnectAttempt = 0;
    state.serverRestarting = false;  // 새 server 가 떴음. flag 리셋.
    // app-level ping: 모바일 브라우저는 WebSocket protocol-level ping 노출이 어렵다.
    // 일정 간격으로 {type:'ping'} 을 직접 보내 서버가 살아있다고 판단하게 한다.
    clearAppPingTimer();
    appPingTimer = setInterval(() => {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        try { state.ws.send(JSON.stringify({ type: 'ping' })); } catch {}
      }
    }, APP_PING_INTERVAL_MS);
    updateConnStatus();
    // 로비 닉네임과 안정 식별자(clientId)를 서버에 알려둠 — 온라인 목록 + 차후 랭킹 기록용.
    if (state.myNick) sendMessage({ type: 'set_nickname', nickname: state.myNick, clientId: state.clientId });
    if (state.sessionId) {
      // 게임 중 / 방 만들기 대기 중 / 재대국 대기 중 / 관전 중 — 어느 상태이든
      // 세션 복구 시도. (Phase 2 이후 관전자도 sessionId 발급 → 일반 resume 흐름.)
      sendMessage({ type: 'resume_session', sessionId: state.sessionId, nickname: state.myNick });
    } else if (state.waitingMode === 'queue' && state.screenState === 'waiting') {
      // 랜덤 매칭 대기 중 끊김 — 큐에 다시 등록
      sendMessage({ type: 'queue_join', nickname: state.myNick, clientId: state.clientId });
    } else if (state.pendingDirectJoin) {
      // 직접 링크(?room=) 진입 모달에서 사용자가 확정했지만 WS 가 아직 안 열려있었던 경우
      sendMessage(state.pendingDirectJoin);
      state.pendingDirectJoin = null;
    }
    // 로비에 있다면 방 목록 + 랭킹 + 최근 대국 즉시 요청 (자동 푸시 전 초기 상태)
    if (state.screenState === 'lobby') {
      sendMessage({ type: 'request_rooms_list' });
      sendMessage({ type: 'request_ranking' });
      sendMessage({ type: 'request_recent_games' });
    }
  });
  state.ws.addEventListener('close', () => {
    state.connected = false;
    clearAppPingTimer();
    updateConnStatus();
    // 게임 중이면 timer tick 동결 — server 가 죽은 동안 카운트다운 계속 가지 않게.
    // resume_success 가 새 turnDeadline 으로 재시작 시킴.
    if (state.screenState === 'game') stopTimerTick();
    if (state.sessionId && state.screenState === 'game' && !state.gameOver) {
      // server_restarting 으로 명시적 알림을 받았으면 그 메시지 유지, 아니면 일반 reconnect 문구.
      if (!state.serverRestarting) {
        setReconnectOverlay(true, '연결이 끊겨 다시 연결하고 있어요...');
      }
    } else if (state.screenState === 'waiting') {
      // 대기 화면(랜덤 매칭 / 방 만들기) — 안내 문구로 상황 표시
      const detail = document.getElementById('waiting-detail');
      if (detail) detail.textContent = '연결이 끊겨 다시 시도하는 중…';
    }
    scheduleReconnect();
  });
  state.ws.addEventListener('error', () => {});
  state.ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    // 서버 pong 은 별도 액션 없음 — 메시지 수신 자체가 연결 살아있음을 의미.
    if (msg.type === 'pong') return;
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
    case 'opponent_disconnected': return onOpponentDisconnected(msg);
    case 'opponent_reconnected':  return onOpponentReconnected(msg);
    case 'opponent_left':         return onOpponentGone('상대가 방을 나갔어요');
    case 'opponent_abandoned':    return onOpponentAbandoned(msg);
    case 'spectator_list':     return updateSpectatorList(msg.spectators);
    case 'online_count':       return updateOnlineCount(msg.n);
    case 'online_list':        return showOnlineList(msg.nicknames);
    case 'rooms_list':         return updateRoomsList(msg.rooms);
    case 'ranking_list':       return updateRanking(msg);
    case 'recent_games_list':  return updateRecentGames(msg.entries);
    case 'emote':              return showEmote(msg.from, msg.emoji, msg.text);
    case 'bot_offer':          return onBotOffer();
    case 'player_replaced':    return onPlayerReplaced();
    case 'error':              return onError(msg);
    case 'server_restarting':  return onServerRestarting();
  }
};

const onServerRestarting = () => {
  state.serverRestarting = true;
  // 게임 화면이면 명시적 점검 안내. close 후 reconnect 가 일어나도 안내 유지.
  if (state.screenState === 'game') {
    stopTimerTick();
    setReconnectOverlay(true, '🛠 서버 업데이트 중입니다.\n잠시 후 자동으로 이어집니다 (보드/타이머 그대로).');
  } else {
    setReconnectOverlay(true, '🛠 서버 업데이트 중입니다.\n잠시만 기다려주세요.');
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

// 진행 중 disconnect grace 정보 (resume/spectate/game_start msg 의 disconnectDeadlines
// + disconnectGraceMs) 를 처리해 turn timer 일시정지 + 카운트다운 UI 시작.
// 새로고침한 player / 신규 입장한 관전자 / 게임 시작 직후 이미 끊긴 상대 모두 cover.
// (PR — Issue: 관전자 새로고침 시 grace 카운트다운 안 보이던 버그 fix.)
const applyDisconnectInfo = (msg) => {
  if (typeof msg.disconnectGraceMs === 'number') {
    state.disconnectGraceMs = msg.disconnectGraceMs;
  }
  const deadlines = msg.disconnectDeadlines;
  if (!deadlines) return;
  // black / white 중 어느 색이든 deadline 있으면 그 색 disconnect 카운트다운 UI 시작.
  // 양쪽 동시 끊김 케이스도 가능 (PVP) — 첫 색만 처리 (UI 표시 단일).
  for (const color of ['black', 'white']) {
    const deadline = deadlines[color];
    if (!deadline) continue;
    pauseTurnTimer(deadline);
    break;
  }
};

const onGameStart = (msg) => {
  state.myColor = msg.you;
  state.nicknames = msg.nicknames;
  state.ratings = msg.ratings || { black: null, white: null };
  state.myNick = msg.nicknames[msg.you];
  state.playerStatus = msg.playerStatus || { black: 'online', white: 'online' };
  state.board = msg.board;
  state.currentTurn = msg.turn;
  state.winLine = null;
  state.lastMove = null;
  state.gameOver = false;
  state.lastRatingDeltas = null;  // 새 게임 — 이전 변동분 잔존 방지 (renderRatingChange 가 hide)
  state.lastUnranked = null;
  state.lastPlacementJustReached = null;
  state.lastPlacement = null;
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
  applyDisconnectInfo(msg);   // 게임 시작 직후 상대 이미 끊긴 케이스도 처리
  playSound('turn_start');
};

const onSpectateSuccess = (msg) => {
  state.role = 'spectator';
  state.myColor = null;
  state.nicknames = msg.nicknames;
  state.ratings = msg.ratings || { black: null, white: null };
  state.playerStatus = msg.playerStatus || { black: 'online', white: 'online' };
  state.board = msg.board;
  state.currentTurn = msg.turn;
  state.winLine = msg.line || null;
  state.lastMove = msg.lastMove || null;
  state.gameOver = msg.status === 'over';
  state.currentRoomCode = msg.code;
  // 관전자도 sessionId 발급 — 새로고침/네트워크 끊김 후 resume_session 으로 재합류.
  // (이슈 #31 Phase 2)
  if (msg.sessionId) {
    state.sessionId = msg.sessionId;
    setSession(msg.sessionId);
  } else {
    state.sessionId = null;
    setSession(null);
  }
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
  applyDisconnectInfo(msg);   // 관전자 새 입장 시 진행 중 grace 카운트다운 표시
};

const onResumeSuccess = (msg) => {
  state.myColor = msg.you;
  state.nicknames = msg.nicknames;
  state.ratings = msg.ratings || { black: null, white: null };
  state.myNick = msg.nicknames[msg.you];
  state.playerStatus = msg.playerStatus || { black: 'online', white: 'online' };
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
  applyDisconnectInfo(msg);   // resume 시점 상대 grace 진행 중이면 카운트다운 시작
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
  // 서버가 보낸 timeout 총 길이를 state 에 저장 — tickTimer 가 cap 으로 사용 (시계 skew 31초 표시 방지).
  if (typeof msg.timeoutMs === 'number') state.turnTimeoutMs = msg.timeoutMs;
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
  // 변동된 rating + delta — 종료 화면 (showGameOver) 에서 즉시 표시. game 화면 카드의 rating/티어도
  // updatePlayerCards 로 즉시 갱신. PVP 양쪽 동시 끊김의 경우 서버가 ratings=null → 표시 skip.
  if (msg.ratings) {
    state.ratings = msg.ratings;
    state.lastRatingDeltas = msg.deltas || null;
    state.lastUnranked = msg.unranked || null;
    state.lastPlacementJustReached = msg.placementJustReached || null;
    state.lastPlacement = msg.placement || null;
    updatePlayerCards();
  }
  stopTimerTick();
  drawBoard();
  showGameOver(msg.winner, msg.reason);
};

const onRematchPending = (msg) => {
  if (msg.who !== state.myColor) showToast('상대가 다시 두기를 원해요. "다시 두기"를 누르면 시작!');
  else document.getElementById('rematch-pending').classList.remove('hidden');
};

const onOpponentDisconnected = (msg) => {
  if (msg && msg.color && state.playerStatus) {
    state.playerStatus[msg.color] = 'offline';
    updatePlayerCards();
  }
  // 서버가 disconnect 동안 turn timer 를 동결하므로 UI 도 동결.
  // grace deadline 으로 카운트다운 표시 + "내 승리" 강조 (사용자에게 결과 명확화).
  if (typeof msg.graceMs === 'number') state.disconnectGraceMs = msg.graceMs;
  pauseTurnTimer(msg && msg.deadline);
  // 시계 skew 로 remainMs 가 graceMs 보다 살짝 커서 "61초" 표시되는 케이스 방지 cap.
  const rawRemainMs = msg && msg.deadline ? msg.deadline - Date.now() : state.disconnectGraceMs;
  const remainMs = Math.max(0, Math.min(rawRemainMs, state.disconnectGraceMs));
  const sec = Math.ceil(remainMs / 1000);
  // role 별 메시지 — player 는 자기 승리 강조, spectator 는 끊긴 쪽 패배.
  if (state.role === 'spectator') {
    const loser = msg && msg.color === 'black' ? '흑' : '백';
    showToast(`${loser} 연결 끊김 — ${sec}초 안에 안 돌아오면 ${loser} 패배`);
  } else {
    showToast(`🏆 상대 끊김! ${sec}초 안에 안 돌아오면 내 승리`);
  }
};

const onOpponentReconnected = (msg) => {
  if (msg && msg.color && state.playerStatus) {
    state.playerStatus[msg.color] = 'online';
    updatePlayerCards();
  }
  // 색 구분 — server 가 보낸 disconnectDeadlines 가 비어있지 않으면 (= 다른 색이
  // 여전히 grace 중) UI 유지 + 그 색 카운트다운 새로 시작. (PR — Issue: 한 쪽
  // reconnect 시 다른 쪽 grace UI 잘못 cancel 되던 버그 fix.)
  if (msg.disconnectDeadlines && Object.keys(msg.disconnectDeadlines).length > 0) {
    applyDisconnectInfo(msg);
    const who = msg.color === 'black' ? '흑' : '백';
    showToast(`${who} 재연결됨 (다른 쪽 끊김 유지)`);
    return;
  }
  // 양쪽 다 online — grace countdown 종료. 다음 turn_started 가 정상 turn timer 재개.
  resumeTurnTimer();
  showToast('상대 재연결됨');
};

// 상대 abandoned (grace 만료) — rating 변동 있음. game_over 처럼 처리하되 winner 가
// 상대 (= 사용자 = oppColor) 임을 명시. showGameOver 가 reason='abandoned' 분기로 표시.
const onOpponentAbandoned = (msg) => {
  state.gameOver = true;
  stopTimerTick();
  drawBoard();
  if (msg.ratings) {
    state.ratings = msg.ratings;
    state.lastRatingDeltas = msg.deltas || null;
    state.lastUnranked = msg.unranked || null;
    state.lastPlacementJustReached = msg.placementJustReached || null;
    state.lastPlacement = msg.placement || null;
    updatePlayerCards();
  }
  // msg.color 는 abandoned 한 쪽 (= loser). winner 는 그 반대.
  const winner = msg.color === 'black' ? 'white' : 'black';
  showGameOver(winner, 'abandoned');
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

// 서버가 큐에서 N초 동안 매칭 못 잡으면 보내주는 봇 제안 — main.js 가 설치한 모달 오프너 호출.
const onBotOffer = () => {
  if (state.openBotGameModal) state.openBotGameModal('offer');
};

// 다른 탭/기기에서 같은 clientId 로 같은 방 player 자리를 가져갔을 때.
// 이 ws 는 player 자격 잃고 로비로 떨어짐.
const onPlayerReplaced = () => {
  state.gameOver = true;
  stopTimerTick();
  state.sessionId = null;
  setSession(null);
  state.currentRoomCode = null;
  setRoomInUrl(null);
  state.role = null;
  state.myColor = null;
  state.waitingMode = null;
  setReconnectOverlay(false);
  showScreen('lobby');
  setLobbyError('다른 탭/기기에서 게임을 이어가고 있어요');
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
