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
  if (name !== 'game') {
    $('game-over').classList.add('hidden');
    // 게임 화면을 떠나면 이모트 피커도 닫고 FAB도 숨김
    setEmotePickerVisible(false);
    const btnEmote = $('btn-emote');
    if (btnEmote) btnEmote.classList.add('hidden');
  }
  // 초대 링크 복사 버튼 — 방 안에 있을 때만 노출 (대기 화면은 '방' 모드일 때만)
  const hasCode = !!state.currentRoomCode;
  $('btn-copy-waiting').classList.toggle('hidden', !(name === 'waiting' && hasCode && state.waitingMode === 'room'));
  $('btn-copy-game').classList.toggle('hidden', !(name === 'game' && hasCode));
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

  // 닉네임이 빈 문자열이면 그 슬롯은 아직 비어있는 것 (서버가 미배정 슬롯을 빈 문자열로 표현).
  // 관전자가 waiting 상태의 방에 들어왔을 때 백 슬롯이 이렇게 비어있다.
  // 사용자가 실제로 닉을 입력 안 한 경우는 서버에서 '익명'으로 채워 보내므로, 빈 문자열은 곧 '미배정'.
  const WAITING_LABEL = '대기 중…';
  const blackEmpty = !state.nicknames.black;
  const whiteEmpty = !state.nicknames.white;
  $('black-nick').textContent = blackEmpty ? WAITING_LABEL : state.nicknames.black;
  $('white-nick').textContent = whiteEmpty ? WAITING_LABEL : state.nicknames.white;
  $('player-black').classList.toggle('waiting', blackEmpty);
  $('player-white').classList.toggle('waiting', whiteEmpty);
  $('black-color').textContent = '흑';
  $('white-color').textContent = '백';

  // 티어 + 레이팅 — server 가 game_start / resume_success / spectate_success 에 ratings 보냄
  const renderTier = (sideColor) => {
    const rating = state.ratings?.[sideColor];
    const tierEl = $(`${sideColor}-tier`);
    const rateEl = $(`${sideColor}-rating`);
    const rowEl = $(`${sideColor}-rating-row`);
    const empty = state.nicknames[sideColor] === '' || rating == null;
    if (!tierEl || !rateEl || !rowEl) return;
    if (empty) {
      rowEl.classList.add('hidden');
      tierEl.textContent = '';
      rateEl.textContent = '';
    } else {
      rowEl.classList.remove('hidden');
      const tier = tierOf(rating);
      tierEl.textContent = TIER_EMOJI[tier] || '⚙️';
      tierEl.title = `${tier} · ${rating}`;
      rateEl.textContent = rating;
    }
  };
  renderTier('black');
  renderTier('white');

  // '나' 배지
  $('black-me').classList.toggle('hidden', state.myColor !== 'black');
  $('white-me').classList.toggle('hidden', state.myColor !== 'white');

  // 온라인 상태 indicator — 자기 자신은 게임 화면 보고 있으니 항상 online.
  // 빈 슬롯은 indicator 숨김. 봇은 서버가 'online' 으로 보내줌.
  const statusBlack = state.myColor === 'black' ? 'online' : (state.playerStatus?.black || 'online');
  const statusWhite = state.myColor === 'white' ? 'online' : (state.playerStatus?.white || 'online');
  $('player-black').classList.toggle('offline', !blackEmpty && statusBlack === 'offline');
  $('player-white').classList.toggle('offline', !whiteEmpty && statusWhite === 'offline');

  // 관전자 모드 표시
  $('spectator-badge').classList.toggle('hidden', state.role !== 'spectator');

  // 이모트 FAB — 플레이어일 때만 노출 (관전자는 보내기 X, 받기는 O)
  const btnEmote = $('btn-emote');
  if (btnEmote) btnEmote.classList.toggle('hidden', state.role !== 'player');
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

// ---- 로비: 방 목록 ----
const escapeText = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export const updateRoomsList = (rooms) => {
  state.roomsList = Array.isArray(rooms) ? rooms : [];
  const wrap = $('rooms-list');
  const count = $('rooms-count');
  if (!wrap) return;
  count.textContent = state.roomsList.length;
  if (!state.roomsList.length) {
    wrap.innerHTML = '<div class="rooms-empty">지금은 열려있는 방이 없어요</div>';
    return;
  }
  const html = state.roomsList.map((r) => {
    const black = escapeText(r.nicknames?.black || '');
    const white = escapeText(r.nicknames?.white || '');
    const isWaiting = r.status === 'waiting';
    const statusLabel = isWaiting ? '대기 중' : '대전 중';
    const players = isWaiting
      ? `${black || '익명'} <span class="muted">— 상대 모집 중</span>`
      : `${black || '익명'} <span class="muted">vs</span> ${white || '익명'}`;
    const actionLabel = isWaiting ? '참가' : '관전';
    return `
      <div class="room-item" data-code="${escapeText(r.code)}" data-action="${isWaiting ? 'join' : 'spectate'}">
        <div class="room-item-code">${escapeText(r.code)}</div>
        <div class="room-item-body">
          <div class="room-item-players">${players}</div>
          <div class="room-item-meta">
            <span class="room-item-status ${isWaiting ? 'waiting' : 'playing'}">${statusLabel}</span>
            <span>👀 ${r.spectatorCount || 0}</span>
          </div>
        </div>
        <button class="btn ${isWaiting ? 'primary' : 'ghost'} room-item-action">${actionLabel}</button>
      </div>
    `;
  }).join('');
  wrap.innerHTML = html;
};

// ---- 랭킹 / 최근 대국 ----
// rating 구간 → 티어 이름. 서버의 game/rating.js 와 동일 기준.
const tierOf = (r) => {
  if (r >= 2100) return 'Master';
  if (r >= 1900) return 'Diamond';
  if (r >= 1700) return 'Platinum';
  if (r >= 1500) return 'Gold';
  if (r >= 1300) return 'Silver';
  if (r >= 1100) return 'Bronze';
  return 'Iron';
};

// 티어 → 이모지. UI 공간 절약 + 직관적 시각화. tooltip 으로 이름.
const TIER_EMOJI = {
  Iron: '⚙️',
  Bronze: '🥉',
  Silver: '🥈',
  Gold: '🥇',
  Platinum: '💠',
  Diamond: '💎',
  Master: '👑',
};
const tierEmojiOf = (rating) => TIER_EMOJI[tierOf(rating)] || '⚙️';
const tierBadgeHtml = (rating) => {
  const tier = tierOf(rating);
  const emoji = TIER_EMOJI[tier] || '⚙️';
  return `<span class="tier-badge tier-${tier.toLowerCase()}" title="${tier} · ${rating}">${emoji}</span>`;
};

const renderRankItem = (entry, rank, { isMe }) => {
  const nick = escapeText(entry.nickname || '?');
  const botMark = entry.isBot ? `<span class="rank-bot-mark" title="봇">🤖</span>` : '';
  const rec = `${entry.wins || 0}승 ${entry.losses || 0}패${(entry.draws || 0) ? ` ${entry.draws}무` : ''}`;
  const meClass = isMe ? ' is-me' : '';
  return `
    <div class="rank-item${meClass}" data-cid="${escapeText(entry.clientId || '')}">
      <div class="rank-num">${rank}</div>
      <div>${tierBadgeHtml(entry.rating || 0)}</div>
      <div class="rank-nick">${nick}${botMark}</div>
      <div class="rank-rating">${entry.rating ?? '-'}</div>
      <div class="rank-record">${rec}</div>
    </div>
  `;
};

export const updateRanking = (entries) => {
  state.ranking = Array.isArray(entries) ? entries : [];
  const wrap = $('ranking-list');
  const count = $('ranking-count');
  const meExtra = $('me-rank-extra');
  if (!wrap) return;
  count.textContent = state.ranking.length;
  if (!state.ranking.length) {
    wrap.innerHTML = '<div class="rooms-empty">아직 랭킹 데이터가 없어요</div>';
    if (meExtra) meExtra.classList.add('hidden');
    return;
  }
  const myCid = state.clientId;
  const top = state.ranking;  // 서버가 이미 limit 적용 (기본 10)
  wrap.innerHTML = top.map((e, i) => renderRankItem(e, i + 1, { isMe: e.clientId === myCid })).join('');

  // 내가 top 안에 있으면 보조 행 숨김. 없으면 서버에서 별도로 제공 안 하니
  // (현재는 top 10 만 보냄) "내 정보 비공개" 처리 안 함 — 향후 확장 시 추가.
  if (meExtra) {
    const meInTop = top.some((e) => e.clientId === myCid);
    meExtra.classList.toggle('hidden', meInTop || !myCid);
    // 향후: 별도 request_my_rank 핸들러 추가 후 여기서 fill.
    if (!meInTop) meExtra.innerHTML = '';
  }
};

const formatTimeShort = (ms) => {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}일 전`;
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

const deltaClass = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'zero');
const deltaText = (n) => (n > 0 ? `+${n}` : `${n}`);

// game_over reason 한국어 라벨
const REASON_LABEL = {
  five: '5목 승',
  draw: '무승부',
  opponent_left: '상대 나감',
  abandoned: '미복귀',
  timeout: '시간 초과',
};

const renderRecentGameItem = (g) => {
  const myCid = state.clientId;
  const renderSide = (s, color) => {
    const winnerOf = g.winner === color ? ' is-winner' : '';
    const isMe = s.clientId === myCid ? ' is-me-row' : '';
    const nick = escapeText(s.nickname || '?');
    const bot = s.isBot ? `<span class="rank-bot-mark">🤖</span>` : '';
    const delta = typeof s.delta === 'number'
      ? `<span class="rating-delta ${deltaClass(s.delta)}">${deltaText(s.delta)}</span>`
      : '';
    return `<span class="recent-game-side${winnerOf}${isMe}">
      <span class="side-color-dot ${color}"></span>${nick}${bot} ${delta}
    </span>`;
  };
  const reasonLabel = REASON_LABEL[g.reason] || g.reason || '';
  return `
    <div class="recent-game-item">
      <div class="recent-game-line">
        ${renderSide(g.black, 'black')}
        <span class="recent-game-vs">vs</span>
        ${renderSide(g.white, 'white')}
      </div>
      <div class="recent-game-meta">
        <span class="recent-game-reason">${escapeText(reasonLabel)}</span>
      </div>
      <div class="recent-game-time">${formatTimeShort(g.endedAt)}</div>
    </div>
  `;
};

export const updateRecentGames = (entries) => {
  state.recentGames = Array.isArray(entries) ? entries : [];
  const wrap = $('recent-games-list');
  const count = $('recent-games-count');
  if (!wrap) return;
  count.textContent = state.recentGames.length;
  if (!state.recentGames.length) {
    wrap.innerHTML = '<div class="rooms-empty">아직 종료된 대국이 없어요</div>';
    return;
  }
  wrap.innerHTML = state.recentGames.map(renderRecentGameItem).join('');
};

// ---- 온라인 사용자 목록 팝업 ----
export const showOnlineList = (nicknames) => {
  const overlay = $('online-list-overlay');
  if (!overlay) return;
  const list = Array.isArray(nicknames) ? nicknames : [];
  $('online-list-count').textContent = list.length;
  const items = $('online-list-items');
  items.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('li');
    empty.className = 'online-list-empty';
    empty.textContent = '아직 닉네임을 설정한 사용자가 없어요';
    items.appendChild(empty);
  } else {
    const myNick = state.myNick;
    for (const n of list) {
      const li = document.createElement('li');
      li.textContent = n;
      if (n === myNick) li.classList.add('me');
      items.appendChild(li);
    }
  }
  overlay.classList.remove('hidden');
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

// ============================================================
// 이모트 (FAB / 피커 / 말풍선)
// ============================================================

// 피커 열기/닫기
export const setEmotePickerVisible = (visible) => {
  const el = $('emote-picker');
  if (el) el.classList.toggle('hidden', !visible);
};

// 보드 아래에서 위로 둥실 떠올라 보드 최하단 두 줄(~85%) 지점에서 사라지는 말풍선.
// 다수가 동시에 떠있어도 자연스럽게 (색별 X 베이스 + 랜덤 흔들기로 분산).
// 보드 좌표는 getBoundingClientRect로 매번 측정 → 화면 크기에 자동 대응.
export const showEmote = (color, emoji, text) => {
  const board = document.querySelector('.board-wrap');
  if (!board) return;
  const rect = board.getBoundingClientRect();
  // 시작: 보드 바로 아래
  const startY = rect.bottom + 30;
  // 끝: 보드 최하단 두 줄 라인(보드 위에서 ~85% 지점) — 여기서 opacity 0
  const endY = rect.top + rect.height * 0.85;
  // 자연 계산값 그대로 — 화면 크기에 맞춰 자동 스케일. 최소 30px만 안전장치.
  const travel = Math.max(30, startY - endY);

  // 색별 시작 X 위치(센터 기준 좌/우 약간) + 약간의 랜덤
  const baseX = color === 'black' ? -52 : 52;
  const randX = Math.floor(Math.random() * 28) - 14;
  const startX = baseX + randX;

  const bubble = document.createElement('div');
  bubble.className = `emote-bubble emote-bubble-${color}`;
  bubble.style.setProperty('--start-y', `${startY}px`);
  bubble.style.setProperty('--start-x', `${startX}px`);
  bubble.style.setProperty('--travel', `${travel}px`);

  const dot = document.createElement('span');
  dot.className = 'emote-bubble-color';
  const emo = document.createElement('span');
  emo.className = 'emote-emoji';
  emo.textContent = emoji;
  const t = document.createElement('span');
  t.className = 'emote-text';
  t.textContent = text;
  bubble.append(dot, emo, t);

  document.body.appendChild(bubble);
  // animation 끝나면 자동 정리, 만일을 대비해 폴백 타이머도 걸어둠
  bubble.addEventListener('animationend', () => bubble.remove(), { once: true });
  setTimeout(() => { if (bubble.isConnected) bubble.remove(); }, 4500);
};
