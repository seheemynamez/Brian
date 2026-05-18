// ============================================================
// 2048 효과음 — Web Audio API 즉석 톤 생성 (외부 파일 0개)
// 오목 omok/js/sound.js 와 같은 패턴.
// ============================================================
(function () {
  let audioCtx = null;
  let audioReady = false;
  let muted = localStorage.getItem('2048_muted') === '1';

  const initAudio = () => {
    if (audioReady) return;
    audioReady = true;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch {}
  };

  // 사용자의 첫 입력이 들어오기 전엔 브라우저가 AudioContext 를 허용하지 않으므로
  // 한 번만 자동 unlock.
  ['click', 'keydown', 'touchstart'].forEach((ev) =>
    document.addEventListener(ev, initAudio, { once: true })
  );

  const tone = (freq, duration, type = 'sine', volume = 0.18) => {
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
  };

  // 병합 톤 — 새 타일 값에 따라 음정이 올라간다 (2→4→8 ... → 2048 까지 약 한 옥타브 분량).
  const mergeTone = (value) => {
    const freq = Math.min(280 + Math.log2(value) * 60, 1200);
    tone(freq, 0.14, 'triangle', 0.18);
  };

  const playSound = (kind, value) => {
    if (muted) return;
    initAudio();
    switch (kind) {
      case 'slide':     tone(220, 0.06, 'sine',     0.10); break;
      case 'merge':     mergeTone(value || 4); break;
      case 'win_2048':
        [523, 659, 784, 1047, 1319].forEach((f, i) =>
          setTimeout(() => tone(f, 0.22, 'sine', 0.20), i * 110));
        break;
      case 'gameover':
        [440, 370, 311, 262].forEach((f, i) =>
          setTimeout(() => tone(f, 0.22, 'sine', 0.14), i * 130));
        break;
      case 'click':     tone(800, 0.05, 'square',   0.08); break;
    }
  };

  const isMuted = () => muted;
  const setMuted = (next) => {
    muted = !!next;
    localStorage.setItem('2048_muted', muted ? '1' : '0');
    if (!muted) initAudio();
  };

  // 외부 노출
  window.Sound2048 = { playSound, isMuted, setMuted };
})();
