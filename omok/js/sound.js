// ============================================================
// Web Audio API로 즉석 톤 생성 (외부 파일 0개)
// ============================================================

import { state } from './state.js';

let audioCtx = null;
let audioReady = false;

export const initAudio = () => {
  if (audioReady) return;
  audioReady = true;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {}
};

const tone = (freq, duration, type = 'sine', volume = 0.18) => {
  if (state.muted || !audioCtx) return;
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
};

export const playSound = (kind) => {
  if (state.muted) return;
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
};
