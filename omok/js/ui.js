// ============================================================
// DOM 업데이트 (화면 전환, 플레이어 카드, 타이머, 토스트, 오버레이)
// ============================================================

import { state, emptyBoard } from './state.js';
import { playSound } from './sound.js';

const $ = (id) => document.getElementById(id);

// ---- 화면 전환 ----
export const showScreen = (name) => {
  state.screenState = name;
  $('screen-lobby').classList.toggle('hidden', name !== 'lobby');
  $('screen-waiting').classList.toggle('hidden', name !== 'waiting');
  $('screen-game').classList.toggle('hidden', name !== 'game');
  if (name !== 'game') $('game-over').classList.add('hidden');
};

export const setLobbyError = (text) => { $('lobby-error').textContent = text || ''; };

// ---- 토스트 ----
let toastTimer = null;
export const showToast = (text, ms = 2400) => {
  const el = $('game-toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
};

// ---- 연결 상태 ----
export const updateConnStatus = () => {
  const el = $('conn-status');
  if (state.connected) {
    el.textContent = '● 연결됨';
    el.className = 'chip ok';
  } else {
    el.textContent = '● 연결 끊김';
    el.className = 'chip bad';
  }
};

// ---- 재연결 오버레이 ----
export const setReconnectOverlay = (visible, sub) => {
  $('reconnect-overlay').classList.toggle('hidden', !visible);
  $('overlay-sub').textContent = sub || '';
};

// ---- 접속자 수 ----
export const updateOnlineCount = (n) => {
  state.onlineCount = n;
  const el = $('online-count');
  if (el) el.textContent = `🟢 ${n}명 온라인`;
};

// ---- 음소거 버튼 ----
export const updateMuteButton = () => {
  $('btn-mute').textContent = state.muted ? '🔇' : '🔊';
};

// ---- 플레이어 카드 (left = black, right = white) ----
const colorLabel = (c) => (c === 'black' ? '흑' : '백');

export const updatePlayerCards = () => {
  // 양쪽 카드 항상 노출 (왼쪽=흑, 오른쪽=백)
  $('player-black').classList.remove('hidden');
  $('player-white').classList.remove('hidden');
  $('vs-divider').classList.remove('hidden');

  $('black-nick').textContent = state.nicknames.black || '익명';
  $('white-nick').textContent = state.nicknames.white || '익명';
  $('black-color').textContent = '흑';
  $('white-color').textContent = '백';

  // '나' 배지
  $('black-me').classList.toggle('hidden', state.myColor !== 'black');
  $('white-me').classList.toggle('hidden', state.myColor !== 'white');

  // 관전자 모드 표시
  $('spectator-badge').classList.toggle('hidden', state.role !== 'spectator');
};

export const updateTurnUI = () => {
  const turnIsBlack = state.currentTurn === 'black' && !state.gameOver;
  const turnIsWhite = state.currentTurn === 'white' && !state.gameOver;
  $('player-black').classList.toggle('active', turnIsBlack);
  $('player-white').classList.toggle('active', turnIsWhite);
  const myTurn = state.role === 'player' && state.currentTurn === state.myColor && !state.gameOver;
  $('board').classList.toggle('my-turn', myTurn);
};

// ---- 관전자 목록 ----
export const updateSpectatorList = (names) => {
  state.spectators = names || [];
  const wrap = $('spectator-list');
  if (!wrap) return;
  if (!state.spectators.length) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
  $('spectator-count').textContent = state.spectators.length;
  const chips = $('spectator-chips');
  chips.innerHTML = '';
  for (const n of state.spectators) {
    const c = document.createElement('span');
    c.className = 'mini-chip';
    c.textContent = n;
    chips.appendChild(c);
  }
};

// ---- 타이머 tick ----
const startTimerTick = () => {
  stopTimerTick();
  tickTimer();
  state.timerTickHandle = setInterval(tickTimer, 250);
};

export const stopTimerTick = () => {
  if (state.timerTickHandle) {
    clearInterval(state.timerTickHandle);
    state.timerTickHandle = null;
  }
  $('timer-fill').style.width = '0%';
  $('timer-text').textContent = '–';
};

let lastTickSec = null;
function tickTimer() {
  if (!state.turnDeadline) return;
  const remainMs = Math.max(0, state.turnDeadline - Date.now());
  const remainSec = Math.ceil(remainMs / 1000);
  const pct = Math.max(0, Math.min(100, (remainMs / 30000) * 100));
  const fill = $('timer-fill');
  fill.style.width = pct + '%';
  fill.classList.toggle('low', remainSec <= 5);
  const text = $('timer-text');
  text.textContent = remainSec;
  text.classList.toggle('low', remainSec <= 5);

  // 내 차례 + 5초 이하 → 매초 톡
  if (state.role === 'player' && state.currentTurn === state.myColor && !state.gameOver) {
    if (remainSec <= 5 && remainSec > 0 && lastTickSec !== remainSec) {
      lastTickSec = remainSec;
      playSound('tick');
    }
    if (remainSec > 5) lastTickSec = null;
  }
}

export { startTimerTick };

// ---- 게임 종료 UI ----
export const showGameOver = (winner, reason) => {
  const card = $('game-over');
  const text = $('result-text');
  $('rematch-pending').classList.add('hidden');
  $('btn-rematch').classList.remove('hidden');
  // 상대가 도중에 나간 경우(opponent_left)는 재대국 불가 — 방이 사라졌음
  const opponentLeft = reason === 'opponent_left';
  if (opponentLeft) $('btn-rematch').classList.add('hidden');
  if (state.role === 'spectator') {
    // 관전자: 누가 이겼는지만 표시, 재대국 버튼 숨김
    $('btn-rematch').classList.add('hidden');
    if (winner === 'draw') {
      text.textContent = '무승부';
      text.className = 'result draw';
    } else if (opponentLeft) {
      text.textContent = (winner === 'black' ? '흑' : '백') + ' 승 (상대 포기)';
      text.className = 'result neutral';
    } else {
      text.textContent = (winner === 'black' ? '흑' : '백') + ' 승';
      text.className = 'result neutral';
    }
  } else if (winner === 'draw') {
    text.textContent = '무승부';
    text.className = 'result draw';
    playSound('draw');
  } else if (winner === state.myColor) {
    text.textContent = opponentLeft ? '🏆 상대 포기 → 승리' : '🏆 승리';
    text.className = 'result win';
    playSound('win');
  } else {
    text.textContent = '패배';
    text.className = 'result lose';
    playSound('lose');
  }
  card.classList.remove('hidden');
  updateTurnUI();
};

export const showGameOverNeutral = (text) => {
  const card = $('game-over');
  const t = $('result-text');
  t.textContent = text;
  t.className = 'result neutral';
  $('rematch-pending').classList.add('hidden');
  $('btn-rematch').classList.add('hidden');
  card.classList.remove('hidden');
};

// ---- 게임 초기화(로비 복귀) ----
export const resetGameLocal = () => {
  state.board = emptyBoard();
  state.winLine = null;
  state.lastMove = null;
  state.gameOver = false;
  state.currentRoomCode = null;
  state.sessionId = null;
  state.role = null;
  state.spectators = [];
};
