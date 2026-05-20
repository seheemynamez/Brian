// ============================================================
// 오목 초보자용 도움말 페이지
// ============================================================
// 4 페이지: 오목이란 / 승리 조건 / 렌주룰 / 금수 패턴 예시
// 어디서든 ? 버튼 → 풀-screen 으로 표시 → X 또는 ESC 로 이전 화면 복귀.
// 서버 통신 없음 (static).
// ============================================================

import { state } from './state.js';
import { showScreen } from './ui.js';

const $ = (id) => document.getElementById(id);

const TOTAL_PAGES = 4;
let currentPage = 0;
let previousScreen = 'lobby';

// ============================================================
// 미니 SVG 보드 렌더러 — 7x7 grid, 우드 톤, 패턴 시각화용.
// stones: [{r, c, color: 'black'|'white', highlight?}]
// marker: {r, c, type: 'forbidden'|'win'} (선택)
// ============================================================

const renderMiniBoard = (stones = [], marker = null, opts = {}) => {
  const size = opts.size || 7;
  const cell = opts.cell || 32;
  const pad = opts.pad || 22;
  const total = pad * 2 + (size - 1) * cell;
  const stoneR = cell * 0.42;
  const gradId = `wood-grad-${Math.random().toString(36).slice(2, 8)}`;

  const out = [];
  out.push(`<defs>
    <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#e0b676"/>
      <stop offset="100%" stop-color="#c8964d"/>
    </linearGradient>
  </defs>`);
  out.push(`<rect width="${total}" height="${total}" fill="url(#${gradId})" rx="6"/>`);

  // 격자
  for (let i = 0; i < size; i++) {
    const p = pad + i * cell;
    out.push(`<line x1="${pad}" y1="${p}" x2="${total - pad}" y2="${p}" stroke="rgba(60,40,18,0.7)" stroke-width="1.2"/>`);
    out.push(`<line x1="${p}" y1="${pad}" x2="${p}" y2="${total - pad}" stroke="rgba(60,40,18,0.7)" stroke-width="1.2"/>`);
  }

  // 돌
  for (const s of stones) {
    const cx = pad + s.c * cell;
    const cy = pad + s.r * cell;
    // 그림자
    out.push(`<circle cx="${cx + 1}" cy="${cy + 2}" r="${stoneR}" fill="rgba(0,0,0,0.32)"/>`);
    if (s.color === 'black') {
      out.push(`<circle cx="${cx}" cy="${cy}" r="${stoneR}" fill="#181818" stroke="#000" stroke-width="0.5"/>`);
    } else {
      out.push(`<circle cx="${cx}" cy="${cy}" r="${stoneR}" fill="#f0f0f0" stroke="#888" stroke-width="0.5"/>`);
    }
    if (s.highlight) {
      out.push(`<circle cx="${cx}" cy="${cy}" r="${stoneR + 3.5}" fill="none" stroke="#ffeb3b" stroke-width="2.5"/>`);
    }
  }

  // marker
  if (marker) {
    const cx = pad + marker.c * cell;
    const cy = pad + marker.r * cell;
    if (marker.type === 'forbidden') {
      const s = cell * 0.32;
      out.push(`<line x1="${cx - s}" y1="${cy - s}" x2="${cx + s}" y2="${cy + s}" stroke="#ff3d3d" stroke-width="4" stroke-linecap="round"/>`);
      out.push(`<line x1="${cx - s}" y1="${cy + s}" x2="${cx + s}" y2="${cy - s}" stroke="#ff3d3d" stroke-width="4" stroke-linecap="round"/>`);
    } else if (marker.type === 'win') {
      out.push(`<circle cx="${cx}" cy="${cy}" r="${cell * 0.55}" fill="none" stroke="#ffeb3b" stroke-width="3"/>`);
    }
  }

  return `<svg viewBox="0 0 ${total} ${total}" class="mini-board" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${out.join('')}</svg>`;
};

// ============================================================
// 패턴 데이터 — 각 페이지 / 카드의 미니 보드 정의.
// ============================================================

const PATTERNS = {
  // 5목 승리 (가로) — 흑 5개 연속, 모두 highlight
  five: {
    stones: [
      { r: 3, c: 1, color: 'black', highlight: true },
      { r: 3, c: 2, color: 'black', highlight: true },
      { r: 3, c: 3, color: 'black', highlight: true },
      { r: 3, c: 4, color: 'black', highlight: true },
      { r: 3, c: 5, color: 'black', highlight: true },
    ],
    marker: null,
  },
  // 장목 — (3,1)(3,2) 와 (3,4)(3,5)(3,6) 사이 (3,3) 자리 두면 6 연속
  overline: {
    stones: [
      { r: 3, c: 1, color: 'black' },
      { r: 3, c: 2, color: 'black' },
      { r: 3, c: 4, color: 'black' },
      { r: 3, c: 5, color: 'black' },
      { r: 3, c: 6, color: 'black' },
    ],
    marker: { r: 3, c: 3, type: 'forbidden' },
  },
  // 쌍사 — 가로 (3,0)(3,1)(3,2) + 세로 (0,3)(1,3)(2,3); (3,3) 두면 4-4
  double_four: {
    stones: [
      { r: 3, c: 0, color: 'black' },
      { r: 3, c: 1, color: 'black' },
      { r: 3, c: 2, color: 'black' },
      { r: 0, c: 3, color: 'black' },
      { r: 1, c: 3, color: 'black' },
      { r: 2, c: 3, color: 'black' },
    ],
    marker: { r: 3, c: 3, type: 'forbidden' },
  },
  // 쌍삼 — 가로 (3,4)(3,5) + 세로 (4,3)(5,3); (3,3) 두면 양쪽 open 3
  double_three: {
    stones: [
      { r: 3, c: 4, color: 'black' },
      { r: 3, c: 5, color: 'black' },
      { r: 4, c: 3, color: 'black' },
      { r: 5, c: 3, color: 'black' },
    ],
    marker: { r: 3, c: 3, type: 'forbidden' },
  },
  // 점삼 (gap 2 형태) — 합법, 3 으로 카운트 안 됨
  point_three: {
    stones: [
      { r: 3, c: 1, color: 'black' },
      { r: 3, c: 3, color: 'black', highlight: true },
      { r: 3, c: 5, color: 'black' },
    ],
    marker: null,
  },
};

const renderAllBoards = () => {
  const slots = document.querySelectorAll('.help-board-slot');
  for (const slot of slots) {
    const key = slot.dataset.svg;
    const p = PATTERNS[key];
    if (p) slot.innerHTML = renderMiniBoard(p.stones, p.marker);
  }
};

// ============================================================
// 페이지 전환
// ============================================================

// 트랙을 currentPage 위치로 이동 (CSS transition 으로 부드럽게).
const updateTrackTransform = () => {
  const track = document.querySelector('.help-pages-track');
  if (track) track.style.transform = `translateX(${-currentPage * 25}%)`;
};

const updatePageView = () => {
  document.querySelectorAll('.help-page').forEach((el) => {
    const isActive = Number(el.dataset.page) === currentPage;
    el.classList.toggle('active', isActive);
    el.setAttribute('aria-hidden', isActive ? 'false' : 'true');
  });
  document.querySelectorAll('.help-dots .dot').forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.page) === currentPage);
  });
  $('btn-help-prev').disabled = (currentPage === 0);
  $('btn-help-next').disabled = (currentPage === TOTAL_PAGES - 1);
  $('help-page-label').textContent = `${currentPage + 1} / ${TOTAL_PAGES}`;
  updateTrackTransform();
  // 페이지 변경 시 위로 스크롤
  window.scrollTo({ top: 0, behavior: 'instant' });
};

const goToPage = (n) => {
  currentPage = Math.max(0, Math.min(TOTAL_PAGES - 1, n));
  updatePageView();
};

export const showHelp = () => {
  previousScreen = state.screenState || 'lobby';
  currentPage = 0;
  showScreen('help');
  renderAllBoards();
  // 트랙 초기 위치 (transition 없이 0% 로 reset)
  const track = document.querySelector('.help-pages-track');
  if (track) {
    track.style.transition = 'none';
    track.style.transform = 'translateX(0%)';
    // 다음 frame 에 transition 복구
    requestAnimationFrame(() => { track.style.transition = ''; });
  }
  updatePageView();
};

// ============================================================
// Touch swipe — 모바일 전용 (좌우 드래그로 페이지 전환)
// ============================================================
// - 25% 이상 swipe 시 다음/이전 페이지 commit, 미만이면 snap back
// - 경계 (page 1 의 오른쪽, page 4 의 왼쪽): rubber-band (35% 만 따라옴)
// - 세로 스크롤 우선: 처음 12px 안에 |dy| > |dx|*1.5 면 horizontal swipe 취소
// ============================================================

const RUBBER_BAND_FACTOR = 0.35;
const COMMIT_RATIO = 0.25;         // viewport 너비의 25%
const AXIS_DECIDE_THRESHOLD = 12;  // 축 결정 최소 거리 (px)

let dragState = null;

const onTouchStart = (e) => {
  if (e.touches.length !== 1) return;
  if (state.screenState !== 'help') return;
  const t = e.touches[0];
  const viewport = document.querySelector('.help-pages-viewport');
  if (!viewport) return;
  dragState = {
    startX: t.clientX,
    startY: t.clientY,
    deltaX: 0,
    viewportW: viewport.offsetWidth,
    axis: null, // null | 'h' | 'v'
  };
};

const onTouchMove = (e) => {
  if (!dragState) return;
  const t = e.touches[0];
  const dx = t.clientX - dragState.startX;
  const dy = t.clientY - dragState.startY;

  // 축 결정 — 가로 우세하면 'h', 세로 우세하면 'v'
  if (dragState.axis === null) {
    if (Math.abs(dx) > AXIS_DECIDE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * 1.5) {
      dragState.axis = 'h';
      const track = document.querySelector('.help-pages-track');
      if (track) track.classList.add('dragging');
    } else if (Math.abs(dy) > AXIS_DECIDE_THRESHOLD) {
      dragState.axis = 'v';
    }
  }

  if (dragState.axis !== 'h') return;

  // 경계에서 rubber-band
  let effectiveDx = dx;
  const atLeftEdge = (currentPage === 0 && dx > 0);
  const atRightEdge = (currentPage === TOTAL_PAGES - 1 && dx < 0);
  if (atLeftEdge || atRightEdge) {
    effectiveDx = dx * RUBBER_BAND_FACTOR;
  }

  dragState.deltaX = effectiveDx;
  const basePct = -currentPage * 25;
  const dxPct = (effectiveDx / dragState.viewportW) * 25;
  const track = document.querySelector('.help-pages-track');
  if (track) track.style.transform = `translateX(${basePct + dxPct}%)`;

  // 가로 swipe 인 경우만 browser 의 가로 스크롤 차단 (passive: false 등록 시)
  if (e.cancelable) e.preventDefault();
};

const onTouchEnd = () => {
  if (!dragState) return;
  const track = document.querySelector('.help-pages-track');
  if (track) track.classList.remove('dragging');

  if (dragState.axis === 'h') {
    const threshold = dragState.viewportW * COMMIT_RATIO;
    if (dragState.deltaX < -threshold && currentPage < TOTAL_PAGES - 1) {
      goToPage(currentPage + 1);
    } else if (dragState.deltaX > threshold && currentPage > 0) {
      goToPage(currentPage - 1);
    } else {
      // 임계치 미만 — snap back
      updateTrackTransform();
    }
  }
  dragState = null;
};

const onTouchCancel = () => {
  if (!dragState) return;
  const track = document.querySelector('.help-pages-track');
  if (track) track.classList.remove('dragging');
  updateTrackTransform();
  dragState = null;
};

export const closeHelp = () => {
  showScreen(previousScreen);
};

export const wireHelpEvents = () => {
  $('btn-help').addEventListener('click', showHelp);
  $('btn-help-close').addEventListener('click', closeHelp);
  $('btn-help-prev').addEventListener('click', () => goToPage(currentPage - 1));
  $('btn-help-next').addEventListener('click', () => goToPage(currentPage + 1));
  document.querySelectorAll('.help-dots .dot').forEach((el) => {
    el.addEventListener('click', () => goToPage(Number(el.dataset.page)));
  });
  // 키보드 — help screen 일 때만 동작
  document.addEventListener('keydown', (e) => {
    if (state.screenState !== 'help') return;
    if (e.key === 'ArrowLeft') goToPage(currentPage - 1);
    else if (e.key === 'ArrowRight') goToPage(currentPage + 1);
    else if (e.key === 'Escape') closeHelp();
  });
  // Touch swipe — 모바일 전용
  const viewport = document.querySelector('.help-pages-viewport');
  if (viewport) {
    viewport.addEventListener('touchstart', onTouchStart, { passive: true });
    viewport.addEventListener('touchmove',  onTouchMove,  { passive: false });
    viewport.addEventListener('touchend',   onTouchEnd,   { passive: true });
    viewport.addEventListener('touchcancel', onTouchCancel, { passive: true });
  }
};
