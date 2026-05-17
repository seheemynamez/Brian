// ============================================================
// 오목대전 클라이언트
// ============================================================

// ---- 상수 ----
const BOARD_SIZE = 15;
const CANVAS_SIZE = 600;
const PADDING = 28;
const CELL = (CANVAS_SIZE - PADDING * 2) / (BOARD_SIZE - 1);
const STAR_POINTS = [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]];

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

// ---- 상태 ----
let ws = null;
let connected = false;
let screenState = 'lobby';        // lobby | waiting | game
let board = emptyBoard();
let myColor = null;
let oppColor = null;
let myNick = '';
let oppNick = '';
let currentTurn = null;
let winLine = null;
let lastMove = null;              // [row, col]
let gameOver = false;
let currentRoomCode = null;
let waitingMode = null;            // 'room' | 'queue'
let sessionId = null;
let turnDeadline = null;
let timerTickHandle = null;
let muted = localStorage.getItem('omok_muted') === '1';

function emptyBoard() {
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(0));
}

// ============================================================
// 화면 전환
// ============================================================
function showScreen(name) {
  screenState = name;
  document.getElementById('screen-lobby').classList.toggle('hidden', name !== 'lobby');
  document.getElementById('screen-waiting').classList.toggle('hidden', name !== 'waiting');
  document.getElementById('screen-game').classList.toggle('hidden', name !== 'game');
  if (name !== 'game') document.getElementById('game-over').classList.add('hidden');
}

function setLobbyError(text) {
  document.getElementById('lobby-error').textContent = text || '';
}

function showToast(text, ms = 2400) {
  const el = document.getElementById('game-toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function updateConnStatus() {
  const el = document.getElementById('conn-status');
  if (connected) {
    el.textContent = '● 연결됨';
    el.className = 'chip ok';
  } else {
    el.textContent = '● 연결 끊김';
    el.className = 'chip bad';
  }
}

function setReconnectOverlay(visible, sub) {
  const ov = document.getElementById('reconnect-overlay');
  ov.classList.toggle('hidden', !visible);
  document.getElementById('overlay-sub').textContent = sub || '';
}

// ============================================================
// 세션 URL hash 처리
// ============================================================
function setSessionInUrl(id) {
  if (id) history.replaceState(null, '', '#session=' + id);
  else history.replaceState(null, '', location.pathname + location.search);
}

function readSessionFromUrl() {
  const m = location.hash.match(/session=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// ============================================================
// 사운드 (Web Audio API, 즉석 톤 생성)
// ============================================================
let audioCtx = null;
let audioReady = false;

function initAudio() {
  if (audioReady) return;
  audioReady = true;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {}
}

function tone(freq, duration, type = 'sine', volume = 0.18) {
  if (muted || !audioCtx) return;
  const t0 = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(volume, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + duration);
}

function playSound(kind) {
  if (muted) return;
  initAudio();
  switch (kind) {
    case 'stone_self': tone(1100, 0.08, 'triangle', 0.20); break;
    case 'stone_opp':  tone(780,  0.08, 'triangle', 0.16); break;
    case 'turn_start': tone(620,  0.10, 'sine', 0.14); break;
    case 'tick':       tone(1400, 0.04, 'square', 0.10); break;
    case 'win':
      [523, 659, 784, 1047].forEach((f, i) =>
        setTimeout(() => tone(f, 0.22, 'sine', 0.18), i * 110));
      break;
    case 'lose':
      [440, 370, 300, 247].forEach((f, i) =>
        setTimeout(() => tone(f, 0.22, 'sine', 0.14), i * 130));
      break;
    case 'draw':
      [523, 392].forEach((f, i) =>
        setTimeout(() => tone(f, 0.25, 'sine', 0.14), i * 140));
      break;
    case 'skip':       tone(330, 0.18, 'sawtooth', 0.12); break;
  }
}

function updateMuteButton() {
  document.getElementById('btn-mute').textContent = muted ? '🔇' : '🔊';
}

// ============================================================
// WebSocket
// ============================================================
function connect() {
  ws = new WebSocket(WS_URL);
  ws.addEventListener('open', () => {
    connected = true;
    updateConnStatus();
    // 게임 중에 끊겼다가 복귀한 거면 resume
    if (sessionId) {
      sendMessage({ type: 'resume_session', sessionId, nickname: myNick });
    }
  });
  ws.addEventListener('close', () => {
    connected = false;
    updateConnStatus();
    // 게임 중이라면 재연결 오버레이
    if (sessionId && screenState === 'game' && !gameOver) {
      setReconnectOverlay(true, '연결이 끊겨 다시 연결하고 있어요...');
    }
    setTimeout(connect, 1500);
  });
  ws.addEventListener('error', () => {});
  ws.addEventListener('message', (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    handleServerMessage(msg);
  });
}

function sendMessage(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ============================================================
// 서버 메시지 처리
// ============================================================
function handleServerMessage(msg) {
  switch (msg.type) {
    case 'room_created':
      currentRoomCode = msg.code;
      waitingMode = 'room';
      document.getElementById('waiting-title').textContent = '상대를 기다리는 중';
      document.getElementById('waiting-code').textContent = msg.code;
      document.getElementById('waiting-detail').textContent = '이 코드를 친구에게 공유하세요';
      showScreen('waiting');
      break;

    case 'queue_waiting':
      waitingMode = 'queue';
      document.getElementById('waiting-title').textContent = '랜덤 매칭 중';
      document.getElementById('waiting-code').textContent = '';
      document.getElementById('waiting-detail').textContent = '누구와든 곧 매칭됩니다';
      showScreen('waiting');
      break;

    case 'game_start':
      onGameStart(msg);
      break;

    case 'resume_success':
      onResumeSuccess(msg);
      break;

    case 'resume_failed':
      // 세션 사라짐 — 정리하고 로비로
      sessionId = null;
      setSessionInUrl(null);
      setReconnectOverlay(false);
      showScreen('lobby');
      setLobbyError('이전 게임을 복구할 수 없어요 (만료됨)');
      break;

    case 'move':
      board[msg.row][msg.col] = msg.color === 'black' ? 1 : 2;
      lastMove = [msg.row, msg.col];
      if (msg.color === myColor) playSound('stone_self');
      else playSound('stone_opp');
      if (msg.turn) currentTurn = msg.turn;
      drawBoard();
      updateTurnUI();
      break;

    case 'turn_started':
      currentTurn = msg.turn;
      turnDeadline = msg.deadline;
      startTimerTick();
      updateTurnUI();
      break;

    case 'turn_skipped':
      currentTurn = msg.turn;
      const who = msg.skipped === myColor ? '내' : '상대';
      showToast(`${who} 차례 시간 초과로 넘어갔어요`);
      playSound('skip');
      updateTurnUI();
      break;

    case 'game_over':
      gameOver = true;
      winLine = msg.line;
      stopTimerTick();
      drawBoard();
      showGameOver(msg.winner);
      // 세션은 곧 만료되지만 결과 화면을 위해 hash는 유지
      break;

    case 'rematch_pending':
      if (msg.who !== myColor) showToast('상대가 다시 두기를 원해요. "다시 두기"를 누르면 시작!');
      else document.getElementById('rematch-pending').classList.remove('hidden');
      break;

    case 'opponent_disconnected':
      showToast('상대 연결 끊김 — 30초 안에 돌아오지 않으면 게임 종료');
      break;

    case 'opponent_reconnected':
      showToast('상대 재연결됨');
      break;

    case 'opponent_left':
      showToast('상대가 방을 나갔어요');
      endGameByOpponentGone('상대가 방을 나갔어요');
      break;

    case 'opponent_abandoned':
      showToast('상대가 돌아오지 않아 게임이 종료됐어요');
      endGameByOpponentGone('상대가 돌아오지 않아 종료');
      break;

    case 'error':
      if (screenState === 'lobby') setLobbyError(msg.message);
      else showToast(msg.message);
      break;
  }
}

function onGameStart(msg) {
  myColor = msg.you;
  oppColor = msg.opponent;
  myNick = msg.nicknames[myColor];
  oppNick = msg.nicknames[oppColor];
  board = msg.board || emptyBoard();
  currentTurn = msg.turn;
  winLine = null;
  lastMove = null;
  gameOver = false;
  if (msg.sessionId) {
    sessionId = msg.sessionId;
    setSessionInUrl(sessionId);
  }
  document.getElementById('room-code-display').textContent = currentRoomCode ? '방 코드 · ' + currentRoomCode : '';
  document.getElementById('game-over').classList.add('hidden');
  document.getElementById('rematch-pending').classList.add('hidden');
  setReconnectOverlay(false);
  updatePlayerCards();
  showScreen('game');
  drawBoard();
  updateTurnUI();
  playSound('turn_start');
}

function onResumeSuccess(msg) {
  myColor = msg.you;
  oppColor = msg.opponent;
  myNick = msg.nicknames[myColor];
  oppNick = msg.nicknames[oppColor];
  board = msg.board;
  currentTurn = msg.turn;
  winLine = msg.line || null;
  lastMove = msg.lastMove || null;
  gameOver = msg.status === 'over';
  sessionId = msg.sessionId;
  setSessionInUrl(sessionId);
  turnDeadline = msg.turnDeadline || null;
  setReconnectOverlay(false);
  updatePlayerCards();
  showScreen('game');
  drawBoard();
  updateTurnUI();
  if (gameOver) {
    stopTimerTick();
    showGameOver(msg.winner);
  } else {
    startTimerTick();
  }
}

function endGameByOpponentGone(text) {
  gameOver = true;
  stopTimerTick();
  const card = document.getElementById('game-over');
  const t = document.getElementById('result-text');
  t.textContent = text;
  t.className = 'result neutral';
  document.getElementById('rematch-pending').classList.add('hidden');
  document.getElementById('btn-rematch').classList.add('hidden');
  card.classList.remove('hidden');
  // 세션 정리
  sessionId = null;
  setSessionInUrl(null);
}

// ============================================================
// 게임 UI
// ============================================================
function colorLabel(c) { return c === 'black' ? '흑' : '백'; }

function updatePlayerCards() {
  // self
  const selfCard = document.getElementById('player-self');
  document.getElementById('self-nick').textContent = myNick || '나';
  document.getElementById('self-color').className = 'player-color ' + (myColor || 'black');
  document.getElementById('self-color').textContent = colorLabel(myColor);
  // opp
  document.getElementById('opp-nick').textContent = oppNick || '상대';
  document.getElementById('opp-color').className = 'player-color ' + (oppColor || 'white');
  document.getElementById('opp-color').textContent = colorLabel(oppColor);
}

function updateTurnUI() {
  const myTurn = currentTurn === myColor && !gameOver;
  document.getElementById('player-self').classList.toggle('active', myTurn);
  document.getElementById('player-opp').classList.toggle('active', !myTurn && !gameOver);
  document.getElementById('board').classList.toggle('my-turn', myTurn);
}

// ============================================================
// 타이머
// ============================================================
function startTimerTick() {
  stopTimerTick();
  tickTimer();
  timerTickHandle = setInterval(tickTimer, 250);
}

function stopTimerTick() {
  if (timerTickHandle) { clearInterval(timerTickHandle); timerTickHandle = null; }
  document.getElementById('timer-fill').style.width = '0%';
  document.getElementById('timer-text').textContent = '–';
}

function tickTimer() {
  if (!turnDeadline) return;
  const remainMs = Math.max(0, turnDeadline - Date.now());
  const remainSec = Math.ceil(remainMs / 1000);
  const pct = Math.max(0, Math.min(100, remainMs / 30000 * 100));
  const fill = document.getElementById('timer-fill');
  fill.style.width = pct + '%';
  fill.classList.toggle('low', remainSec <= 5);
  const text = document.getElementById('timer-text');
  text.textContent = remainSec;
  text.classList.toggle('low', remainSec <= 5);

  // 내 차례이고 5초 이하면 매초 톡
  if (currentTurn === myColor && !gameOver) {
    if (remainSec <= 5 && remainSec > 0 && tickTimer._last !== remainSec) {
      tickTimer._last = remainSec;
      playSound('tick');
    }
    if (remainSec > 5) tickTimer._last = null;
  }
}

// ============================================================
// 게임 종료 UI
// ============================================================
function showGameOver(winner) {
  const card = document.getElementById('game-over');
  const text = document.getElementById('result-text');
  document.getElementById('rematch-pending').classList.add('hidden');
  document.getElementById('btn-rematch').classList.remove('hidden');
  if (winner === 'draw') {
    text.textContent = '무승부';
    text.className = 'result draw';
    playSound('draw');
  } else if (winner === myColor) {
    text.textContent = '🏆 승리';
    text.className = 'result win';
    playSound('win');
  } else {
    text.textContent = '패배';
    text.className = 'result lose';
    playSound('lose');
  }
  card.classList.remove('hidden');
  updateTurnUI();
}

// ============================================================
// 보드 렌더링 (Canvas)
// ============================================================
function getCtx() {
  return document.getElementById('board').getContext('2d');
}

function drawBoard() {
  const ctx = getCtx();
  // 보드 배경 (전통 우드 — UI 다크와 대비)
  const grad = ctx.createLinearGradient(0, 0, 0, CANVAS_SIZE);
  grad.addColorStop(0, '#e0b676');
  grad.addColorStop(1, '#c8964d');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  // 격자
  ctx.strokeStyle = 'rgba(80, 55, 25, 0.85)';
  ctx.lineWidth = 1;
  for (let i = 0; i < BOARD_SIZE; i++) {
    ctx.beginPath();
    ctx.moveTo(PADDING, PADDING + i * CELL);
    ctx.lineTo(PADDING + (BOARD_SIZE - 1) * CELL, PADDING + i * CELL);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(PADDING + i * CELL, PADDING);
    ctx.lineTo(PADDING + i * CELL, PADDING + (BOARD_SIZE - 1) * CELL);
    ctx.stroke();
  }

  // 화점
  ctx.fillStyle = 'rgba(60, 40, 18, 0.95)';
  for (const [r, c] of STAR_POINTS) {
    ctx.beginPath();
    ctx.arc(PADDING + c * CELL, PADDING + r * CELL, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // 돌
  const stoneR = CELL * 0.42;
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (board[r][c]) drawStone(ctx, r, c, board[r][c], stoneR);
    }
  }

  // 마지막 수 표시 (네온 핑크 점)
  if (lastMove) {
    const [r, c] = lastMove;
    const x = PADDING + c * CELL;
    const y = PADDING + r * CELL;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#ff3d8a';
    ctx.fill();
    ctx.shadowColor = '#ff3d8a';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // 승리 라인
  if (winLine && winLine.length >= 2) {
    const [r1, c1] = winLine[0];
    const [r2, c2] = winLine[winLine.length - 1];
    ctx.strokeStyle = '#ff3d8a';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.shadowColor = '#ff3d8a';
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.moveTo(PADDING + c1 * CELL, PADDING + r1 * CELL);
    ctx.lineTo(PADDING + c2 * CELL, PADDING + r2 * CELL);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}

function drawStone(ctx, r, c, stone, radius) {
  const x = PADDING + c * CELL;
  const y = PADDING + r * CELL;
  // 그림자
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.beginPath();
  ctx.arc(x + 1, y + 2, radius, 0, Math.PI * 2);
  ctx.fill();
  // 돌
  if (stone === 1) {
    // 흑돌: 반지름 방향 그라데이션
    const g = ctx.createRadialGradient(x - radius/3, y - radius/3, 2, x, y, radius);
    g.addColorStop(0, '#4c4c4c');
    g.addColorStop(0.6, '#181818');
    g.addColorStop(1, '#000');
    ctx.fillStyle = g;
  } else {
    const g = ctx.createRadialGradient(x - radius/3, y - radius/3, 2, x, y, radius);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.6, '#f0f0f0');
    g.addColorStop(1, '#c8c8c8');
    ctx.fillStyle = g;
  }
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = stone === 1 ? '#000' : '#888';
  ctx.lineWidth = 1;
  ctx.stroke();
}

// ============================================================
// 입력
// ============================================================
function getBoardCoord(clientX, clientY) {
  const canvas = document.getElementById('board');
  const rect = canvas.getBoundingClientRect();
  const x = (clientX - rect.left) * (CANVAS_SIZE / rect.width);
  const y = (clientY - rect.top)  * (CANVAS_SIZE / rect.height);
  const col = Math.round((x - PADDING) / CELL);
  const row = Math.round((y - PADDING) / CELL);
  if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return null;
  return { row, col };
}

function onBoardClick(e) {
  if (gameOver || currentTurn !== myColor) return;
  const coord = getBoardCoord(e.clientX, e.clientY);
  if (!coord) return;
  if (board[coord.row][coord.col] !== 0) return;
  sendMessage({ type: 'move', row: coord.row, col: coord.col });
}

// ============================================================
// 이벤트 바인딩
// ============================================================
function setupHandlers() {
  // 닉네임 입력
  const nickInput = document.getElementById('nick-input');
  nickInput.value = localStorage.getItem('omok_nick') || '';
  myNick = nickInput.value;
  nickInput.addEventListener('input', (e) => {
    myNick = e.target.value.trim();
    localStorage.setItem('omok_nick', myNick);
  });

  // 로비 액션
  document.getElementById('btn-create').addEventListener('click', () => {
    setLobbyError('');
    if (!myNick) { setLobbyError('닉네임을 먼저 입력하세요'); return; }
    initAudio();
    sendMessage({ type: 'create_room', nickname: myNick });
  });
  document.getElementById('btn-join').addEventListener('click', () => {
    setLobbyError('');
    if (!myNick) { setLobbyError('닉네임을 먼저 입력하세요'); return; }
    const code = document.getElementById('code-input').value.trim().toUpperCase();
    if (code.length !== 4) { setLobbyError('4글자 코드를 입력하세요'); return; }
    initAudio();
    sendMessage({ type: 'join_room', code, nickname: myNick });
  });
  document.getElementById('btn-queue').addEventListener('click', () => {
    setLobbyError('');
    if (!myNick) { setLobbyError('닉네임을 먼저 입력하세요'); return; }
    initAudio();
    sendMessage({ type: 'queue_join', nickname: myNick });
  });
  document.getElementById('code-input').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase();
  });
  document.getElementById('code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-join').click();
  });

  // 대기 화면
  document.getElementById('btn-cancel').addEventListener('click', () => {
    if (waitingMode === 'queue') sendMessage({ type: 'queue_leave' });
    else if (waitingMode === 'room') sendMessage({ type: 'leave_room' });
    currentRoomCode = null; waitingMode = null;
    showScreen('lobby');
  });

  // 게임 화면
  document.getElementById('board').addEventListener('click', onBoardClick);
  document.getElementById('btn-rematch').addEventListener('click', () => {
    sendMessage({ type: 'rematch' });
    document.getElementById('rematch-pending').classList.remove('hidden');
  });
  document.getElementById('btn-leave').addEventListener('click', () => {
    sendMessage({ type: 'leave_room' });
    currentRoomCode = null;
    board = emptyBoard();
    winLine = null; lastMove = null;
    gameOver = false;
    sessionId = null;
    setSessionInUrl(null);
    showScreen('lobby');
  });

  // 음소거 토글
  document.getElementById('btn-mute').addEventListener('click', () => {
    muted = !muted;
    localStorage.setItem('omok_muted', muted ? '1' : '0');
    updateMuteButton();
    if (!muted) initAudio();
  });

  // 첫 사용자 액션에 오디오 활성화
  ['click', 'keydown', 'touchstart'].forEach((ev) =>
    document.addEventListener(ev, initAudio, { once: true }));
}

// ============================================================
// 시작
// ============================================================
setupHandlers();
updateMuteButton();
showScreen('lobby');
drawBoard();
updateConnStatus();

// URL hash에 세션 있으면 자동 복구
const urlSession = readSessionFromUrl();
if (urlSession) {
  sessionId = urlSession;
  setReconnectOverlay(true, '이전 게임을 복구하는 중...');
}

connect();
