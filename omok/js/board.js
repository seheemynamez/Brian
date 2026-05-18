// ============================================================
// 캔버스 보드 렌더링 + 클릭 좌표 변환
// ============================================================

import { state, BOARD_SIZE } from './state.js';
import { findForbiddenSpots } from './renju.js';

const CANVAS_SIZE = 600;
const PADDING = 28;
const CELL = (CANVAS_SIZE - PADDING * 2) / (BOARD_SIZE - 1);
const STAR_POINTS = [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]];

const getCtx = () => document.getElementById('board').getContext('2d');

export const drawBoard = () => {
  const ctx = getCtx();

  // 배경 (우드 그라데이션)
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
      if (state.board[r][c]) drawStone(ctx, r, c, state.board[r][c], stoneR);
    }
  }

  // 마지막 수
  if (state.lastMove) {
    const [r, c] = state.lastMove;
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
  if (state.winLine && state.winLine.length >= 2) {
    const [r1, c1] = state.winLine[0];
    const [r2, c2] = state.winLine[state.winLine.length - 1];
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

  // 렌주 금수 표시 — 흑 플레이어 본인 화면에만 노출.
  //   - 백/관전자 화면엔 표시 안 함 (상대 측 정보를 UI 로 흘리지 않기 위함)
  //   - 흑 차례 여부와 무관하게 게임이 진행 중이면 항상 노출 → 흑이 미리 수읽기 가능
  const isBlackPlayer = state.role === 'player' && state.myColor === 'black';
  if (!state.gameOver && isBlackPlayer) {
    // 매번 계산 — 15x15 + 패턴 검사로 비용 작음.
    const forbidden = findForbiddenSpots(state.board, 'black');
    if (forbidden.length) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 77, 106, 0.55)';
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      const sz = CELL * 0.22;
      for (const [r, c] of forbidden) {
        const x = PADDING + c * CELL;
        const y = PADDING + r * CELL;
        ctx.beginPath();
        ctx.moveTo(x - sz, y - sz); ctx.lineTo(x + sz, y + sz);
        ctx.moveTo(x + sz, y - sz); ctx.lineTo(x - sz, y + sz);
        ctx.stroke();
      }
      ctx.restore();
    }
  }
};

const drawStone = (ctx, r, c, stone, radius) => {
  const x = PADDING + c * CELL;
  const y = PADDING + r * CELL;
  // 그림자
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.beginPath();
  ctx.arc(x + 1, y + 2, radius, 0, Math.PI * 2);
  ctx.fill();
  // 돌 본체 (방사형 그라데이션)
  const g = ctx.createRadialGradient(x - radius / 3, y - radius / 3, 2, x, y, radius);
  if (stone === 1) {
    g.addColorStop(0, '#4c4c4c');
    g.addColorStop(0.6, '#181818');
    g.addColorStop(1, '#000');
  } else {
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.6, '#f0f0f0');
    g.addColorStop(1, '#c8c8c8');
  }
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = stone === 1 ? '#000' : '#888';
  ctx.lineWidth = 1;
  ctx.stroke();
};

export const getBoardCoord = (clientX, clientY) => {
  const canvas = document.getElementById('board');
  const rect = canvas.getBoundingClientRect();
  const x = (clientX - rect.left) * (CANVAS_SIZE / rect.width);
  const y = (clientY - rect.top)  * (CANVAS_SIZE / rect.height);
  const col = Math.round((x - PADDING) / CELL);
  const row = Math.round((y - PADDING) / CELL);
  if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return null;
  return { row, col };
};
