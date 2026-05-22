// ============================================================
// 상수
// ============================================================
const SIZE = 4;
const SLIDE_MS = 130;
const SWIPE_THRESHOLD = 24; // px

// ============================================================
// 게임 상태
// ============================================================
let tiles = [];
let nextId = 1;
let score = 0;
let best = Number(localStorage.getItem('best2048') || 0);
let gameOver = false;
let won = false;
let animating = false;

// ============================================================
// 헬퍼
// ============================================================
function tileAt(r, c) {
  return tiles.find(t => t.row === r && t.col === c);
}

function showMessage(text, cls) {
  const m = document.getElementById('message');
  m.textContent = text;
  m.className = 'message' + (cls ? ' ' + cls : '');
}

// ============================================================
// 보드 조작 (슬라이드 + 병합 계산, 종료 판정)
// ============================================================
function computeMove(direction) {
  const isHoriz = (direction === 'left' || direction === 'right');
  const forward = (direction === 'left' || direction === 'up');
  const merges = [];
  const removals = [];
  let moved = false;

  for (let lane = 0; lane < SIZE; lane++) {
    const laneTiles = tiles.filter(t => (isHoriz ? t.row : t.col) === lane);
    laneTiles.sort((a, b) => {
      const av = isHoriz ? a.col : a.row;
      const bv = isHoriz ? b.col : b.row;
      return forward ? av - bv : bv - av;
    });
    let write = forward ? 0 : SIZE - 1;
    const step = forward ? 1 : -1;
    let lastTile = null;
    let lastValue = null;
    let canMerge = false;

    for (const t of laneTiles) {
      const cur = isHoriz ? t.col : t.row;
      if (canMerge && t.value === lastValue) {
        if (isHoriz) t.col = lastTile.col;
        else         t.row = lastTile.row;
        removals.push(t.id);
        merges.push({ absorberId: lastTile.id, newValue: lastValue * 2 });
        canMerge = false;
        moved = true;
      } else {
        if (cur !== write) {
          if (isHoriz) t.col = write;
          else         t.row = write;
          moved = true;
        }
        lastTile = t;
        lastValue = t.value;
        canMerge = true;
        write += step;
      }
    }
  }
  return { moved, merges, removals };
}

function hasMoves() {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const t = tileAt(r, c);
      if (!t) return true;
      if (c < SIZE - 1) {
        const right = tileAt(r, c + 1);
        if (right && right.value === t.value) return true;
      }
      if (r < SIZE - 1) {
        const down = tileAt(r + 1, c);
        if (down && down.value === t.value) return true;
      }
    }
  }
  return false;
}

// ============================================================
// 렌더링 (DOM 업데이트)
// ============================================================
function setTilePos(el, row, col) {
  el.style.setProperty('--row', row);
  el.style.setProperty('--col', col);
}

function render() {
  const layer = document.getElementById('tile-layer');
  const present = new Set(tiles.map(t => 't' + t.id));

  // 사라진 타일의 DOM 제거
  for (const el of Array.from(layer.children)) {
    if (!present.has(el.id)) el.remove();
  }

  // 각 타일 생성/업데이트
  for (const t of tiles) {
    let el = document.getElementById('t' + t.id);
    if (!el) {
      el = document.createElement('div');
      el.id = 't' + t.id;
      el.className = 'tile tile-' + t.value;
      const inner = document.createElement('div');
      inner.className = 'tile-content';
      inner.textContent = t.value;
      el.appendChild(inner);
      setTilePos(el, t.row, t.col);
      layer.appendChild(el);
    } else {
      el.className = 'tile tile-' + t.value;
      el.firstElementChild.textContent = t.value;
      setTilePos(el, t.row, t.col);
    }
    if (t.isNew) {
      el.classList.add('tile-new');
      t.isNew = false;
      setTimeout(() => el && el.classList.remove('tile-new'), 220);
    }
    if (t.justMerged) {
      el.classList.add('tile-merged');
      t.justMerged = false;
      setTimeout(() => el && el.classList.remove('tile-merged'), 240);
    }
  }

  // 점수 표시 갱신
  document.getElementById('score').textContent = score;
  if (score > best) {
    best = score;
    localStorage.setItem('best2048', String(best));
  }
  document.getElementById('best').textContent = best;
}

// 슬라이드만 반영하는 가벼운 업데이트 (병합 결과 값은 아직 미반영)
function applyTransforms() {
  for (const t of tiles) {
    const el = document.getElementById('t' + t.id);
    if (el) setTilePos(el, t.row, t.col);
  }
}

// ============================================================
// 게임 흐름 (newGame, addRandomTile, move)
// ============================================================
function newGame() {
  document.getElementById('tile-layer').innerHTML = '';
  tiles = [];
  score = 0;
  gameOver = false;
  won = false;
  animating = false;
  showMessage('', '');
  // 이전 게임의 공유 모달 정리 — 새 판 시작 시 사라져야 (이전 점수 잔존 방지).
  if (window.Rank2048 && window.Rank2048.hideShareModal) {
    window.Rank2048.hideShareModal();
  }
  addRandomTile();
  addRandomTile();
  render();
}

function addRandomTile() {
  const empty = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (!tileAt(r, c)) empty.push([r, c]);
    }
  }
  if (empty.length === 0) return null;
  const [r, c] = empty[Math.floor(Math.random() * empty.length)];
  const tile = {
    id: nextId++,
    row: r,
    col: c,
    value: Math.random() < 0.9 ? 2 : 4,
    isNew: true
  };
  tiles.push(tile);
  return tile;
}

function move(direction) {
  if (gameOver || animating) return;

  const result = computeMove(direction);
  if (!result.moved) return;

  animating = true;
  applyTransforms(); // 슬라이드 시작 (CSS transition)
  // 이동이 일어났으면 슬라이드 사운드 한 번 (병합 사운드와 겹치도록 즉시).
  window.Sound2048 && window.Sound2048.playSound('slide');

  setTimeout(() => {
    // 슬라이드 끝 → 병합 적용
    let won2048ThisMove = false;
    for (const m of result.merges) {
      const absorber = tiles.find(t => t.id === m.absorberId);
      if (absorber) {
        absorber.value = m.newValue;
        absorber.justMerged = true;
        score += m.newValue;
        if (m.newValue === 2048 && !won) {
          won = true;
          won2048ThisMove = true;
          showMessage('2048 달성! 계속 진행해도 됩니다.', 'win');
        } else {
          // 병합당 한 번씩 톤 — 값에 따라 음정이 올라간다.
          window.Sound2048 && window.Sound2048.playSound('merge', m.newValue);
        }
      }
    }
    // 흡수된 타일 제거
    const rmSet = new Set(result.removals);
    tiles = tiles.filter(t => !rmSet.has(t.id));
    // 새 타일 스폰
    addRandomTile();
    render();
    animating = false;

    if (won2048ThisMove) window.Sound2048 && window.Sound2048.playSound('win_2048');

    if (!hasMoves()) {
      gameOver = true;
      if (!won) showMessage('게임 끝! "새 게임"을 눌러 다시 시작하세요.', '');
      window.Sound2048 && window.Sound2048.playSound('gameover');
      // 점수 등록 — rank.js 가 닉네임 모달 → submit → 공유 모달까지 일괄 처리.
      if (score > 0 && window.Rank2048) {
        window.Rank2048.onScoreSubmitted(score);
      }
    }
  }, SLIDE_MS);
}

// ============================================================
// 입력 처리 (키보드 + 터치 스와이프)
// ============================================================
const KEY_TO_DIR = {
  ArrowLeft: 'left',  ArrowRight: 'right',
  ArrowUp:   'up',    ArrowDown:  'down'
};

// 닉 / 공유 모달 중 하나라도 떠 있는지 — visible 시 게임 키 처리 차단.
const isModalOpen = () => {
  const nick  = document.getElementById('nick-modal');
  const share = document.getElementById('share-modal');
  return (nick  && !nick.classList.contains('hidden')) ||
         (share && !share.classList.contains('hidden'));
};

document.addEventListener('keydown', (e) => {
  // 모달 (닉/공유) 떠 있으면 게임 키 처리 안 함 — input 안 방향키가 보드 움직이는
  // 버그 + 공유 모달에서 ESC 가 게임에도 영향 가는 것 방지.
  if (isModalOpen()) return;
  // 포커스가 텍스트 입력에 있으면 방향키는 커서 이동용 — 게임 동작 안 함.
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const dir = KEY_TO_DIR[e.key];
  if (dir) {
    e.preventDefault();
    move(dir);
  }
});

let touchStart = null;

// 스와이프 입력은 보드 안에서 시작한 것만 처리.
// document 에 걸면 사이드바(랭킹) 스크롤이 game move 로 잘못 해석됨.
const boardEl = document.getElementById('board');

boardEl.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) { touchStart = null; return; }
  const t = e.touches[0];
  touchStart = { x: t.clientX, y: t.clientY, time: Date.now() };
}, { passive: true });

boardEl.addEventListener('touchend', (e) => {
  if (!touchStart) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touchStart.x;
  const dy = t.clientY - touchStart.y;
  const dt = Date.now() - touchStart.time;
  touchStart = null;
  if (dt > 800) return;
  const absDx = Math.abs(dx), absDy = Math.abs(dy);
  if (Math.max(absDx, absDy) < SWIPE_THRESHOLD) return;
  if (absDx > absDy) move(dx > 0 ? 'right' : 'left');
  else               move(dy > 0 ? 'down' : 'up');
}, { passive: true });

// 보드 안 스와이프가 페이지 스크롤(특히 모바일 pull-to-refresh)로 이어지지 않게.
// board 바깥(사이드바 등)에서는 정상 스크롤 가능 — 여기는 preventDefault 안 함.
boardEl.addEventListener('touchmove', (e) => {
  e.preventDefault();
}, { passive: false });

// 보드 외 영역에서 스와이프하다가 보드 위에서 손가락을 떼면 touchend 가 board 에
// 안 들어옴 (출발점이 board 가 아니므로). 그래도 touchStart 가 null 이라
// 잘못된 move 가 일어나지 않는다.

// ============================================================
// 음소거 토글
// ============================================================
const muteBtn = document.getElementById('btn-mute');
const syncMuteIcon = () => {
  if (!muteBtn) return;
  muteBtn.textContent = (window.Sound2048 && window.Sound2048.isMuted()) ? '🔇' : '🔊';
};
if (muteBtn) {
  muteBtn.addEventListener('click', () => {
    if (!window.Sound2048) return;
    window.Sound2048.setMuted(!window.Sound2048.isMuted());
    syncMuteIcon();
  });
  syncMuteIcon();
}

// ============================================================
// 시작
// ============================================================
document.getElementById('new-game').addEventListener('click', () => {
  window.Sound2048 && window.Sound2048.playSound('click');
  newGame();
});
newGame();
