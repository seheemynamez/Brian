// ============================================================
// 2048 랭킹 사이드바 + 닉네임 모달
// ============================================================
// 의존: window.Net2048 (CustomEvent 로 ranking / my_rank / score_recorded 수신)
// 노출: window.Rank2048 = { promptNicknameIfNeeded, openNicknameModal,
//                            onScoreSubmitted }
(function () {
  'use strict';

  // ---- 자동 닉네임 풀 (omok 와 동일 톤) ----
  // 30 × 30 = 900 조합, 모두 14자 server cap 이내.
  const NICK_ADJECTIVES = [
    '귀여운', '멋진', '다정한', '슬기로운', '용감한', '신비한', '행복한', '따뜻한',
    '친절한', '똑똑한', '든든한', '발랄한', '깜찍한', '부드러운', '솔직한', '게으른',
    '졸린', '수줍은', '어설픈', '비밀스런', '엉뚱한', '자유로운', '평화로운', '빛나는',
    '외로운', '배고픈', '진지한', '도도한', '신중한', '느긋한',
  ];
  const NICK_ANIMALS = [
    '너구리', '고양이', '강아지', '토끼', '다람쥐', '펭귄', '곰', '여우',
    '늑대', '거북이', '햄스터', '판다', '쿼카', '미어캣', '수달', '라쿤',
    '사슴', '알파카', '코알라', '캥거루', '오리', '부엉이', '두루미', '매',
    '까치', '참새', '박쥐', '개구리', '도마뱀', '사자',
  ];
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const genGuestNick = () => pick(NICK_ADJECTIVES) + pick(NICK_ANIMALS);

  // ---- 상태 ----
  // 현재 보여주는 탭: 'allTime' | 'daily'.
  let activeTab = 'allTime';
  // 최근 ranking 메시지 (탭 전환 시 재렌더링).
  let lastRanking = { allTime: [], daily: [], dailyDate: null };
  // 내 순위 (서버가 보내준 값).
  let myRank = null;
  // FLIP 애니메이션 — 이전 렌더의 각 row 위치를 기억.
  let prevRects = new Map();   // key = clientId, value = { top, left }
  // 점수 등록 후 'NEW BEST' toast 띄울 클라이언트 id (자기 자신).
  let lastSubmittedScore = null;

  // ---- 유틸 ----
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  // ---- 닉네임 모달 ----
  // 최초 진입 시 + 사용자가 직접 변경 버튼 눌렀을 때.
  // omok 의 direct-join-modal 톤을 따라 함 (빈칸 OK → 자동 부여).
  //
  // pendingAutoNick: 모달을 열 때 한 번 생성해서 placeholder 와 "비워두면 부여될 닉"
  // 둘 다에 사용. 사용자에게 보여준 닉과 실제 부여될 닉을 동기화 — 이 변수 없이
  // 호출마다 genGuestNick() 새로 부르면 placeholder 와 실제 부여 닉이 달라짐.
  let pendingAutoNick = '';

  const ensureNicknameModalEl = () => {
    let el = $('nick-modal');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'nick-modal';
    el.className = 'nick-modal hidden';
    // placeholder 는 openNicknameModal 에서 항상 새로 박으니 여기선 빈 값.
    el.innerHTML = `
      <div class="nick-modal-box">
        <h2>닉네임</h2>
        <p class="nick-modal-desc">랭킹에 표시될 이름이에요. 비워두면 자동으로 정해져요.</p>
        <input id="nick-input" type="text" maxlength="14" placeholder="" autocomplete="off" />
        <div class="nick-modal-actions">
          <button id="nick-cancel" type="button" class="ghost">취소</button>
          <button id="nick-confirm" type="button">확인</button>
        </div>
      </div>
    `;
    document.body.appendChild(el);

    const hide = () => el.classList.add('hidden');
    $('nick-cancel').addEventListener('click', hide);
    $('nick-confirm').addEventListener('click', () => {
      const raw = $('nick-input').value.trim();
      // 비워두면 모달 열 때 placeholder 로 보여준 그 닉이 그대로 부여 — 일관성.
      const nick = raw || pendingAutoNick || genGuestNick();
      window.Net2048.sendNickname(nick);
      renderHeader();  // 헤더 닉 즉시 갱신
      hide();
      // 등록 직후 — 만약 이 모달이 score 등록 직전 띄워졌다면 점수도 같이 등록
      if (lastSubmittedScore != null) {
        const s = lastSubmittedScore; lastSubmittedScore = null;
        window.Net2048.submitScore(s);
      }
    });
    $('nick-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('nick-confirm').click();
    });
    return el;
  };

  const openNicknameModal = () => {
    const el = ensureNicknameModalEl();
    const input = $('nick-input');
    input.value = window.Net2048.getNick() || '';
    // 모달 열 때마다 한 번 generate — placeholder 와 confirm 양쪽에서 같은 값 사용.
    pendingAutoNick = genGuestNick();
    input.placeholder = pendingAutoNick;
    el.classList.remove('hidden');
    setTimeout(() => input.focus(), 30);
  };

  // 점수 등록 전에 닉네임 없으면 모달 띄우고 (사용자 확인 후 점수 등록 이어짐).
  // 있으면 true 반환 — 호출측이 그대로 submitScore 진행.
  const promptNicknameIfNeeded = (pendingScore) => {
    if (window.Net2048.getNick()) return true;
    lastSubmittedScore = pendingScore;
    openNicknameModal();
    return false;
  };

  // ---- 사이드바 렌더링 ----
  const renderHeader = () => {
    const nickEl = $('rank-my-nick');
    if (nickEl) nickEl.textContent = window.Net2048.getNick() || '(닉네임 없음)';
    const statusEl = $('rank-conn');
    if (statusEl) {
      statusEl.className = 'rank-conn ' + (window.Net2048.isConnected() ? 'online' : 'offline');
      statusEl.textContent = window.Net2048.isConnected() ? '● 연결됨' : '● 연결 끊김';
    }
  };

  const renderMyRank = () => {
    const el = $('rank-myrank');
    if (!el) return;
    if (!myRank) { el.textContent = ''; return; }
    const tab = activeTab === 'daily' ? myRank.daily : myRank.allTime;
    if (!tab || !tab.rank) {
      el.textContent = `나: 미등록 (${tab && tab.total ? tab.total : 0}명 중)`;
      return;
    }
    el.textContent = `나: ${tab.rank}위 / ${tab.total}명 (${tab.score}점)`;
  };

  // FLIP — 이전 prevRects 와 현재 layout 을 비교해서 transform 으로 이동 애니메이션.
  const captureRects = (container) => {
    const map = new Map();
    container.querySelectorAll('.rank-row').forEach((row) => {
      const cid = row.dataset.cid;
      if (cid) {
        const r = row.getBoundingClientRect();
        map.set(cid, { top: r.top, left: r.left });
      }
    });
    return map;
  };

  const animateFlip = (container) => {
    container.querySelectorAll('.rank-row').forEach((row) => {
      const cid = row.dataset.cid;
      if (!cid || !prevRects.has(cid)) return;
      const prev = prevRects.get(cid);
      const cur = row.getBoundingClientRect();
      const dx = prev.left - cur.left;
      const dy = prev.top - cur.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      row.style.transform = `translate(${dx}px, ${dy}px)`;
      row.style.transition = 'none';
      // 다음 frame 에 0 으로 transition.
      requestAnimationFrame(() => {
        row.style.transition = 'transform 400ms cubic-bezier(0.4, 0, 0.2, 1)';
        row.style.transform = '';
      });
    });
  };

  const renderRanking = () => {
    const container = $('rank-list');
    if (!container) return;

    // FLIP — 새 DOM 그리기 전에 이전 위치 캡처. (FIRST → LAST)
    prevRects = captureRects(container);

    const list = activeTab === 'daily' ? lastRanking.daily : lastRanking.allTime;
    const myCid = window.Net2048.getClientId();

    if (!list || list.length === 0) {
      container.innerHTML = '<div class="rank-empty">아직 등록된 점수가 없어요</div>';
      return;
    }

    const rows = list.map((entry, i) => {
      const rank = i + 1;
      const isMe = entry.clientId === myCid;
      const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '';
      return `
        <div class="rank-row ${isMe ? 'me' : ''}" data-cid="${escapeHtml(entry.clientId)}">
          <div class="rank-num">${medal || rank}</div>
          <div class="rank-nick">${escapeHtml(entry.nickname || '이름 없음')}</div>
          <div class="rank-score">${entry.score}</div>
        </div>
      `;
    }).join('');
    container.innerHTML = rows;

    // FLIP — 새 DOM 의 위치와 prev 비교해서 transform.
    animateFlip(container);
  };

  const renderAll = () => {
    renderHeader();
    renderRanking();
    renderMyRank();
  };

  // ---- 탭 전환 ----
  const setupTabButtons = () => {
    const tabBtns = document.querySelectorAll('.rank-tab');
    tabBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        if (!tab) return;
        activeTab = tab;
        tabBtns.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
        renderRanking();
        renderMyRank();
      });
    });
    // 초기 active 동기화
    tabBtns.forEach((b) => b.classList.toggle('active', b.dataset.tab === activeTab));

    // 닉네임 변경 버튼
    const editBtn = $('rank-edit-nick');
    if (editBtn) editBtn.addEventListener('click', openNicknameModal);
  };

  // ---- 점수 등록 후 처리 (game.js 에서 호출) ----
  // 사용자에게 NEW BEST toast 띄움. score_recorded 이벤트 도착 시 toast 결정.
  const onScoreSubmitted = (score) => {
    // game.js 가 gameOver 직후 호출. 닉네임 없으면 모달 띄우고 등록은 모달 콜백에서.
    if (!promptNicknameIfNeeded(score)) return;
    window.Net2048.submitScore(score);
  };

  // ---- Net2048 이벤트 listening ----
  window.addEventListener('net2048:ranking', (e) => {
    lastRanking = e.detail || lastRanking;
    renderRanking();
  });
  window.addEventListener('net2048:my_rank', (e) => {
    myRank = e.detail || null;
    renderMyRank();
  });
  // 서버가 닉 변경을 confirm 하면 (자기 자신 또는 reconnect 시 자동 동기화) 헤더 갱신.
  // 모달 확인 버튼은 즉시 renderHeader 하지만, 다른 경로 (programmatic / 재연결) 도
  // 안전하게 처리하도록 nickname_set 이벤트를 listen.
  window.addEventListener('net2048:nickname_set', renderHeader);
  window.addEventListener('net2048:score_recorded', (e) => {
    const { allTimeUpdated, dailyUpdated } = e.detail || {};
    if (allTimeUpdated || dailyUpdated) {
      showToast(allTimeUpdated ? '🏆 역대 최고 기록!' : '⭐ 오늘의 최고 기록!');
    }
    // 등록 후 내 순위 다시 요청 (서버가 broadcast 안 보냈을 수도)
    window.Net2048.requestMyRank();
  });
  window.addEventListener('net2048:connected', renderAll);
  window.addEventListener('net2048:disconnected', renderHeader);
  window.addEventListener('net2048:server_restarting', () => {
    showToast('🛠 서버 점검 중. 잠시 후 자동 재연결.');
  });
  window.addEventListener('net2048:error', (e) => {
    const m = (e.detail && e.detail.message) || '서버 오류';
    showToast('⚠ ' + m);
  });

  // ---- 가벼운 toast ----
  let toastTimer = null;
  const showToast = (text) => {
    let el = $('rank-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'rank-toast';
      el.className = 'rank-toast';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  };

  // ---- 부팅 ----
  document.addEventListener('DOMContentLoaded', () => {
    ensureNicknameModalEl();
    setupTabButtons();
    renderAll();
    // 최초 진입 시 닉네임 없으면 모달 자동 노출 (게임 시작과 무관, 사용자 거부 가능)
    if (!window.Net2048.getNick()) {
      // 약간 지연 — 게임 첫 frame 이 먼저 보이도록
      setTimeout(openNicknameModal, 400);
    }
    window.Net2048.connect();
  });

  // ---- 노출 ----
  window.Rank2048 = {
    promptNicknameIfNeeded,
    openNicknameModal,
    onScoreSubmitted,
  };
})();
