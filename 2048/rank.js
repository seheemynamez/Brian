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
  const ensureNicknameModalEl = () => {
    let el = $('nick-modal');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'nick-modal';
    el.className = 'nick-modal hidden';
    el.innerHTML = `
      <div class="nick-modal-box">
        <h2>닉네임</h2>
        <p class="nick-modal-desc">랭킹에 표시될 이름이에요. 비워두면 자동으로 정해져요.</p>
        <input id="nick-input" type="text" maxlength="14" placeholder="${escapeHtml(genGuestNick())}" autocomplete="off" />
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
      const nick = raw || genGuestNick();
      window.Net2048.sendNickname(nick);
      renderHeader();  // 헤더 닉 즉시 갱신
      hide();
      // 등록 직후 — score 등록 직전이었다면 점수 submit + 공유 모달 표시.
      // 닉 모달이 닫히면서 자연스럽게 share 모달로 이어짐.
      if (lastSubmittedScore != null) {
        const s = lastSubmittedScore; lastSubmittedScore = null;
        window.Net2048.submitScore(s);
        showShareModal(s);
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
    input.placeholder = genGuestNick();
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

  // ---- 점수 등록 + 공유 모달 (game.js 가 gameOver 시 호출) ----
  // 닉이 있으면: 즉시 submit + 공유 모달.
  // 닉이 없으면: 닉 모달 띄움 — 모달 confirm 핸들러가 submit + 공유 모달까지 처리.
  const onScoreSubmitted = (score) => {
    if (!promptNicknameIfNeeded(score)) return;   // 닉 없음 — 모달 confirm 이 이어받음
    window.Net2048.submitScore(score);
    showShareModal(score);
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

  // ---- 클립보드 복사 (비-HTTPS / IP 주소 환경에서도 작동) ----
  // navigator.clipboard.writeText 는 secure context 전용 — localhost OK, 그러나
  // 192.168.x.x 같은 LAN IP HTTP 에서는 거부됨. legacy execCommand('copy') 는
  // deprecated 지만 secure context 외에서도 작동해서 fallback 으로 사용.
  // 반환: true = 성공, false = 둘 다 실패.
  const copyToClipboard = async (text) => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch { /* secure context 아니거나 권한 거부 — 아래 fallback */ }
    }
    // Legacy fallback — hidden textarea + execCommand('copy').
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      // iOS Safari 는 contentEditable + selection range 가 필요해서 직접 호출.
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  };

  // ---- 게임오버 공유 모달 ----
  // showShareModal(score) — onScoreSubmitted 가 submit 후 호출 (nick modal 다음에).
  // hideShareModal() — game.js 의 newGame() 이 호출.
  // 닉 모달과 톤 통일 — overlay + 가운데 박스. score 강조, 큰 공유 버튼.
  const ensureShareModalEl = () => {
    let el = $('share-modal');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'share-modal';
    el.className = 'share-modal hidden';
    el.innerHTML = `
      <div class="share-modal-box">
        <div class="share-modal-emoji">🎉</div>
        <div class="share-modal-score" id="share-modal-score">0</div>
        <div class="share-modal-text">친구에게 자랑해 보세요</div>
        <div class="share-modal-actions">
          <button class="share-modal-share" id="share-modal-share" type="button">🔗 친구에게 공유</button>
          <button class="share-modal-close" id="share-modal-close" type="button">닫기</button>
        </div>
      </div>
    `;
    document.body.appendChild(el);

    const hide = () => el.classList.add('hidden');

    // overlay 클릭 (박스 바깥) 으로 닫기 — 박스 자체 클릭은 무시.
    el.addEventListener('click', (e) => {
      if (e.target === el) hide();
    });
    $('share-modal-close').addEventListener('click', hide);

    // ESC 로 닫기 — 키 이벤트는 document 에 걸어서 modal visible 시에만 처리.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.classList.contains('hidden')) hide();
    });

    // 공유 버튼 — Web Share API → 없으면 clipboard.
    $('share-modal-share').addEventListener('click', async () => {
      const btn = $('share-modal-share');
      const score = Number(btn.dataset.score || 0);
      const nick  = window.Net2048.getNick() || '';
      const url   = window.Net2048.buildShareUrl(nick, score);
      const caption = nick
        ? `${nick} 님 ${score}점! 2048 더 높은 점수에 도전해보세요`
        : `2048 — 도전해보세요`;
      // 1) Web Share API — 모바일 native share sheet (카카오톡 / 메시지 등).
      // 주의: text + url 두 필드 분리해서 넘기면 카카오톡 같은 일부 앱이
      // 둘을 separator 없이 concat 해서 URL 끝이 다음 단어와 붙어 깨짐
      // (예: ".../1956SEHEE MY NAME!" — URL 이 /1956SEHEE 로 파싱됨).
      // 해결: URL 을 text 안에 줄바꿈으로 포함시키고 url 필드는 비움.
      // 어떤 앱이든 URL 이 독립 줄에 놓여서 OG fetcher 가 깨끗하게 파싱.
      const shareText = `${caption}\n${url}`;
      if (navigator.share) {
        try {
          await navigator.share({ title: '2048 도전!', text: shareText });
          hide();         // 공유 성공 — 모달 닫음
          return;
        } catch (e) {
          if (e && e.name === 'AbortError') return;   // 사용자 취소 — 모달 유지
          // 다른 에러 → clipboard 로 fall through
        }
      }
      // 2) 클립보드 복사 — modern API 우선, 실패하면 legacy execCommand 로.
      // 한 가지 함정: navigator.clipboard 는 secure context 전용 (HTTPS 또는
      // localhost). IP 주소 HTTP (192.168.x.x 등) 에선 거부 → legacy fallback 필요.
      if (await copyToClipboard(url)) {
        showToast('🔗 링크가 복사되었어요!');
        hide();
      } else {
        showToast('⚠ 복사 실패 — 브라우저 권한을 확인해주세요');
      }
    });

    return el;
  };

  const showShareModal = (score) => {
    const el = ensureShareModalEl();
    const s = Math.max(0, Math.floor(Number(score) || 0));
    $('share-modal-score').textContent = `${s}점`;
    $('share-modal-share').dataset.score = String(s);
    el.classList.remove('hidden');
  };
  const hideShareModal = () => {
    const el = $('share-modal');
    if (el) el.classList.add('hidden');
  };

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
    ensureShareModalEl();   // 미리 만들어두면 첫 game over 시 깜빡임 X.
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
    showShareModal,
    hideShareModal,
  };
})();
