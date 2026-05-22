// ============================================================
// 2048 효과음 — Web Audio API 즉석 톤 생성 (외부 파일 0개)
// omok/js/sound.js 와 같은 패턴 — context lifecycle 안정성 확보.
// ============================================================
(function () {
  'use strict';

  let audioCtx = null;
  let muted = localStorage.getItem('2048_muted') === '1';

  // AudioContext lifecycle:
  //   created (state='suspended')
  //     --[user gesture 안의 resume()]--> running
  //     --[브라우저 / 시스템 sleep / 탭 background]--> suspended (자동)
  // 한 번 만들고 끝이 아니라, suspended 일 때 매번 resume 시도해야 한다.
  // resume() 은 user gesture 밖에선 reject — silent catch.
  // 멱등 — 여러 번 불러도 안전 (audioReady 같은 플래그를 두면 init 실패 시 영구 차단됨).
  const initAudio = () => {
    if (!audioCtx) {
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      } catch { return; }
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
  };

  // 첫 사용자 입력에 unlock. once:true 라 listener 자체는 한 번만 발사되지만,
  // initAudio 는 멱등이라 이후 setMuted / playSound 가 호출해도 안전.
  ['click', 'keydown', 'touchstart'].forEach((ev) =>
    document.addEventListener(ev, initAudio, { once: true })
  );

  const tone = (freq, duration, type = 'sine', volume = 0.18) => {
    if (muted || !audioCtx) return;
    // 탭 백그라운드 / 시스템 sleep 후 자동 suspend 된 경우 매 사운드마다 복구 시도.
    // 호출 시점이 user gesture 안이면 resume 성공해서 즉시 들림. 아니면 다음 클릭 때 복구.
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
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

  // 디버깅 — context 상태 확인용 (개발자 콘솔에서 Sound2048._debug() 가능)
  const _debug = () => ({
    hasCtx: !!audioCtx,
    ctxState: audioCtx ? audioCtx.state : null,
    muted,
  });
  // 테스트용 — 외부에서 직접 suspend / resume / 시도 가능. 일반 사용 X.
  const _getCtx = () => audioCtx;

  // 외부 노출
  window.Sound2048 = { playSound, isMuted, setMuted, _debug, _getCtx };
})();
