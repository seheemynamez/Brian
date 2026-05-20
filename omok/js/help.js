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

const updatePageView = () => {
  document.querySelectorAll('.help-page').forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.page) === currentPage);
  });
  document.querySelectorAll('.help-dots .dot').forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.page) === currentPage);
  });
  $('btn-help-prev').disabled = (currentPage === 0);
  $('btn-help-next').disabled = (currentPage === TOTAL_PAGES - 1);
  $('help-page-label').textContent = `${currentPage + 1} / ${TOTAL_PAGES}`;
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
  updatePageView();
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
};
