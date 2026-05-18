// ============================================================
// 진입점: 초기화 + 사용자 이벤트 바인딩
// ============================================================

import { state, EMOTES } from './state.js';
import {
  showScreen, setLobbyError, updateConnStatus, updateMuteButton,
  setReconnectOverlay, resetGameLocal, updateOnlineCount, setEmotePickerVisible,
} from './ui.js';
import { initAudio } from './sound.js';
import { connect, sendMessage, getSession, setSession, setRoomInUrl, getRoomFromUrl, buildShareUrl } from './net.js';
import { drawBoard, getBoardCoord } from './board.js';

const $ = (id) => document.getElementById(id);

// ---- 보드 클릭 ----
const onBoardClick = (e) => {
  if (state.gameOver || state.role !== 'player' || state.currentTurn !== state.myColor) return;
  const coord = getBoardCoord(e.clientX, e.clientY);
  if (!coord) return;
  if (state.board[coord.row][coord.col] !== 0) return;
  sendMessage({ type: 'move', row: coord.row, col: coord.col });
};

// ---- 닉네임 ----
// 페이지 진입 시 localStorage 가 비어 있으면 형용사+동물 자동 부여.
// 사용자는 input 을 수정해서 자기 닉으로 바꿀 수 있고, 비워둘 경우 다음 액션 직전에 다시 채워준다.
const setupNickname = () => {
  const input = $('nick-input');
  let nick = localStorage.getItem('omok_nick') || '';
  if (!nick) {
    nick = genGuestNick();
    localStorage.setItem('omok_nick', nick);
  }
  input.value = nick;
  state.myNick = nick;
  input.addEventListener('input', (e) => {
    state.myNick = e.target.value.trim();
    localStorage.setItem('omok_nick', state.myNick);
    // 온라인 목록에 즉시 반영 + 차후 랭킹 기록용 clientId 동기화
    sendMessage({ type: 'set_nickname', nickname: state.myNick, clientId: state.clientId });
  });
};

// input 이 비어있는 채로 액션 버튼을 누른 경우의 fallback —
// 자동 닉을 부여하고 input/state/저장소/서버까지 일관되게 맞춘다.
const ensureNick = () => {
  if (state.myNick) return state.myNick;
  const nick = genGuestNick();
  state.myNick = nick;
  localStorage.setItem('omok_nick', nick);
  $('nick-input').value = nick;
  sendMessage({ type: 'set_nickname', nickname: nick, clientId: state.clientId });
  return nick;
};

// ---- 로비 액션 ----
// 닉네임은 페이지 진입 시 자동 부여되어 있고, 비어 있어도 ensureNick() 이 fallback 으로 채워준다.
// 따라서 '닉네임을 먼저 입력하세요' 에러는 발생하지 않는다.
const setupLobby = () => {
  $('btn-create').addEventListener('click', () => {
    setLobbyError('');
    const nick = ensureNick();
    initAudio();
    sendMessage({ type: 'create_room', nickname: nick });
  });
  $('btn-join').addEventListener('click', () => {
    setLobbyError('');
    const code = $('code-input').value.trim().toUpperCase();
    if (code.length !== 4) return setLobbyError('4글자 코드를 입력하세요');
    const nick = ensureNick();
    initAudio();
    sendMessage({ type: 'join_room', code, nickname: nick });
  });
  $('btn-spectate').addEventListener('click', () => {
    setLobbyError('');
    const code = $('code-input').value.trim().toUpperCase();
    if (code.length !== 4) return setLobbyError('4글자 코드를 입력하세요');
    const nick = ensureNick();
    initAudio();
    sendMessage({ type: 'spectate_room', code, nickname: nick });
  });
  $('btn-queue').addEventListener('click', () => {
    setLobbyError('');
    const nick = ensureNick();
    initAudio();
    sendMessage({ type: 'queue_join', nickname: nick, clientId: state.clientId });
  });
  $('code-input').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase();
  });
  $('code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-join').click();
  });

  // 방 목록 카드 클릭 → 대기 중이면 참가, 대전 중이면 관전
  $('rooms-list').addEventListener('click', (e) => {
    const item = e.target.closest('.room-item');
    if (!item) return;
    setLobbyError('');
    const nick = ensureNick();
    initAudio();
    const code = item.dataset.code;
    const action = item.dataset.action;
    sendMessage({ type: action === 'join' ? 'join_room' : 'spectate_room', code, nickname: nick });
  });
};

// ---- 대기 화면 ----
const setupWaiting = () => {
  $('btn-cancel').addEventListener('click', () => {
    if (state.waitingMode === 'queue') sendMessage({ type: 'queue_leave' });
    else if (state.waitingMode === 'room') sendMessage({ type: 'leave_room' });
    state.currentRoomCode = null;
    state.waitingMode = null;
    // 방 만들기에서 발급된 sessionId 정리 (자동 resume 방지)
    state.sessionId = null;
    setSession(null);
    setRoomInUrl(null);
    showScreen('lobby');
  });
};

// ---- 게임 화면 ----
const leaveRoomAndGoLobby = () => {
  sendMessage({ type: 'leave_room' });
  resetGameLocal();
  setSession(null);
  setRoomInUrl(null);
  showScreen('lobby');
};

const showLeaveConfirm = (show) => {
  $('leave-confirm-overlay').classList.toggle('hidden', !show);
};

const setupGame = () => {
  $('board').addEventListener('click', onBoardClick);
  $('btn-rematch').addEventListener('click', () => {
    sendMessage({ type: 'rematch' });
    $('rematch-pending').classList.remove('hidden');
  });
  // 게임오버 카드 안의 "방 나가기" — 게임이 이미 끝났으므로 바로 나감
  $('btn-leave').addEventListener('click', leaveRoomAndGoLobby);

  // 항상 보이는 "방 나가기" (관전/대전 중 모두)
  $('btn-leave-game').addEventListener('click', () => {
    // forfeit 경고는 '대전 중인 플레이어' 일 때만.
    // role / myColor / gameOver 세 가지 신호를 모두 사용해 어떤 이상 상태에서도
    // 관전자가 플레이어 취급되지 않게 한다.
    const isActivePlayer = state.role === 'player' && state.myColor && !state.gameOver;
    if (!isActivePlayer) {
      leaveRoomAndGoLobby();
      return;
    }
    showLeaveConfirm(true);
  });
  $('btn-leave-cancel').addEventListener('click', () => showLeaveConfirm(false));
  $('btn-leave-confirm').addEventListener('click', () => {
    showLeaveConfirm(false);
    leaveRoomAndGoLobby();
  });
};

// ---- 초대 링크 복사 ----
// 두 위치(대기 화면 큰 버튼, 게임 화면 작은 버튼)에서 같은 동작을 한다.
// 복사되는 URL 은 share 엔드포인트(/i/CODE?n=NICK) — 메신저 봇이 동적 OG 메타를 가져가
// "닉네임님이 오목대전을 신청했어요" 형태의 프리뷰가 뜬다. 사람이 클릭하면 canonical 게임 URL 로 redirect.
const copyInviteLink = async (btn) => {
  const url = buildShareUrl(state.currentRoomCode, state.myNick) || location.href;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(url);
    } else {
      // 보안 컨텍스트(https/localhost)가 아닌 LAN 테스트 등에서는 execCommand 폴백
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    const label = btn.querySelector('.copy-label');
    const original = label ? label.textContent : btn.textContent;
    btn.classList.add('copied');
    if (label) label.textContent = '복사됨!';
    else btn.textContent = '✓ 복사됨';
    setTimeout(() => {
      btn.classList.remove('copied');
      if (label) label.textContent = original;
      else btn.textContent = '🔗 링크 복사';
    }, 1500);
  } catch {
    // 복사 실패 — prompt 로 폴백해서 사용자가 직접 복사 가능하게
    prompt('아래 링크를 복사해서 공유하세요', url);
  }
};

const setupCopyLinks = () => {
  $('btn-copy-waiting').addEventListener('click', (e) => copyInviteLink(e.currentTarget));
  $('btn-copy-game').addEventListener('click', (e) => copyInviteLink(e.currentTarget));
};

// ---- 봇 대전 모달 ----
// 두 경로에서 같은 모달을 띄운다:
//   1) 로비 "혼자 두기 (AI)" 카드 클릭 → mode='lobby'
//   2) 랜덤 매칭 큐에서 10초 timeout → 서버가 bot_offer 보냄 → mode='offer'
// 같은 모달이지만 mode 에 따라 타이틀/부가설명만 다름. 사용자 입력은 동일 (난이도+선공).
const setupBotGame = () => {
  const overlay = $('bot-game-overlay');
  const titleEl = $('bot-game-title');
  const subEl = $('bot-game-sub');
  let mode = 'lobby';
  let difficulty = 'medium';
  let first = 'me';

  // 토글 버튼 그룹 — active 클래스 갱신 + 선택 값 보관
  overlay.querySelectorAll('.bot-toggle-row').forEach((row) => {
    const group = row.dataset.group;
    row.addEventListener('click', (e) => {
      const btn = e.target.closest('.bot-toggle-btn');
      if (!btn) return;
      row.querySelectorAll('.bot-toggle-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const value = btn.dataset.value;
      if (group === 'difficulty') difficulty = value;
      else if (group === 'first')  first = value;
    });
  });

  const showModal = (m) => {
    mode = m;
    if (m === 'offer') {
      titleEl.textContent = '🤖 매칭이 늦어요';
      subEl.textContent = '오목봇과 한 판 두시겠어요?';
    } else {
      titleEl.textContent = '🤖 봇과 대전';
      subEl.textContent = '난이도와 선공을 선택하세요';
    }
    overlay.classList.remove('hidden');
  };
  const hideModal = () => overlay.classList.add('hidden');

  // 카드 클릭 → lobby 모드로 모달 열기
  $('btn-bot-game').addEventListener('click', () => {
    setLobbyError('');
    ensureNick();
    showModal('lobby');
  });

  $('btn-bot-game-cancel').addEventListener('click', () => {
    if (mode === 'offer') sendMessage({ type: 'bot_offer_decline' });
    hideModal();
  });

  $('btn-bot-game-start').addEventListener('click', () => {
    const nick = ensureNick();
    initAudio();
    // offer 모드든 lobby 모드든 동일한 메시지 — 서버 onCreateBotGame 가 큐 정리부터 시작.
    sendMessage({ type: 'create_bot_game', nickname: nick, difficulty, first });
    hideModal();
  });

  // net.js 의 bot_offer 디스패치가 호출할 수 있도록 state 에 노출
  state.openBotGameModal = showModal;
};

// ---- 접속자 목록 팝업 ----
// 상단 '🟢 N명 온라인' 칩 클릭 → 서버에 목록 요청 (응답은 net.js 의 dispatch 가 받아 ui.js 의 showOnlineList 호출).
const setupOnlineListPopup = () => {
  $('online-count').addEventListener('click', () => {
    sendMessage({ type: 'request_online_list' });
  });
  $('btn-online-close').addEventListener('click', () => {
    $('online-list-overlay').classList.add('hidden');
  });
  // ESC 로 닫기
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('online-list-overlay').classList.add('hidden');
  });
};

// ---- 직접 링크(?room=XXXX) 진입 모달 ----
// 닉네임을 입력받아 사용자가 '참가' 또는 '관전' 의도를 명시적으로 선택.
// 비워두면 형용사+동물 자동 부여 (당근마켓·카카오 오픈채팅 류 패턴).
//   - 참가: join_room — 빈 자리가 있으면 플레이어, 없으면 서버가 자동으로 관전 처리
//   - 관전: spectate_room — 항상 관전 (의도가 보호됨)

// 형용사·동물 풀 — 모든 조합이 서버 MAX_NICK_LEN(12자) 안에 들어오도록 6자 이하만.
// 30 × 30 = 900 조합. 친근하고 귀여운 톤으로 큐레이션 (당근/토스/오픈채팅 참조).
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
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const genGuestNick = () => pick(NICK_ADJECTIVES) + pick(NICK_ANIMALS);

const setupDirectJoinModal = () => {
  const overlay = $('direct-join-overlay');
  const codeEl = $('direct-join-code');
  const nickInput = $('direct-join-nick');

  const hide = () => overlay.classList.add('hidden');

  const submit = (asSpectator) => {
    const code = (codeEl.textContent || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) { hide(); return; }
    let nick = nickInput.value.trim();
    if (!nick) nick = genGuestNick();
    state.myNick = nick;
    localStorage.setItem('omok_nick', nick);
    // 로비 입력 칸과 동기화 — 모달 닫힌 뒤 사용자가 로비를 봤을 때 일관성 유지
    $('nick-input').value = nick;

    initAudio();
    const payload = asSpectator
      ? { type: 'spectate_room', code, nickname: nick }
      : { type: 'join_room',     code, nickname: nick };
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      sendMessage(payload);
    } else {
      // WS 가 아직 열리지 않았으면 net.js 의 open 핸들러가 이걸 보고 보낸다.
      state.pendingDirectJoin = payload;
    }
    hide();
  };

  $('btn-direct-confirm').addEventListener('click', () => submit(false));
  $('btn-direct-spectate').addEventListener('click', () => submit(true));
  $('btn-direct-cancel').addEventListener('click', () => {
    setRoomInUrl(null);
    hide();
  });
  // Enter 는 기본 액션(참가)으로 — 가장 흔한 경로를 빠르게.
  nickInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit(false);
  });
};

const showDirectJoinModal = (code) => {
  $('direct-join-code').textContent = code;
  $('direct-join-nick').value = localStorage.getItem('omok_nick') || '';
  $('direct-join-overlay').classList.remove('hidden');
  setTimeout(() => $('direct-join-nick').focus(), 50);
};

// ---- 음소거 ----
const setupMute = () => {
  $('btn-mute').addEventListener('click', () => {
    state.muted = !state.muted;
    localStorage.setItem('omok_muted', state.muted ? '1' : '0');
    updateMuteButton();
    if (!state.muted) initAudio();
  });
  ['click', 'keydown', 'touchstart'].forEach((ev) =>
    document.addEventListener(ev, initAudio, { once: true }));
};

// ---- 이모트 ----
const setupEmote = () => {
  const grid = $('emote-grid');
  if (!grid) return;
  // 피커 옵션 빌드
  for (const e of EMOTES) {
    const btn = document.createElement('button');
    btn.className = 'emote-option';
    btn.type = 'button';
    btn.setAttribute('aria-label', e.text);
    const em = document.createElement('span');
    em.className = 'emote-emoji';
    em.textContent = e.emoji;
    const lb = document.createElement('span');
    lb.className = 'emote-label';
    lb.textContent = e.text;
    btn.appendChild(em);
    btn.appendChild(lb);
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      sendMessage({ type: 'emote', key: e.key });
      setEmotePickerVisible(false);
    });
    grid.appendChild(btn);
  }
  // FAB 토글
  $('btn-emote').addEventListener('click', (ev) => {
    ev.stopPropagation();
    const picker = $('emote-picker');
    setEmotePickerVisible(picker.classList.contains('hidden'));
  });
  // 외부 클릭/ESC로 닫기
  document.addEventListener('click', (e) => {
    const picker = $('emote-picker');
    if (!picker || picker.classList.contains('hidden')) return;
    if (e.target.closest('#emote-picker') || e.target.closest('#btn-emote')) return;
    setEmotePickerVisible(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setEmotePickerVisible(false);
  });
};

// ---- 시작 ----
setupNickname();
setupLobby();
setupWaiting();
setupGame();
setupCopyLinks();
setupOnlineListPopup();
setupBotGame();
setupDirectJoinModal();
setupMute();
setupEmote();
updateMuteButton();
updateOnlineCount(0);
showScreen('lobby');
drawBoard();
updateConnStatus();

// sessionStorage 에 세션이 있으면 자동 복구
const urlSession = getSession();
if (urlSession) {
  state.sessionId = urlSession;
  setReconnectOverlay(true, '이전 게임을 복구하는 중...');
} else {
  // 직접 링크(?room=XXXX) 로 들어왔으면 닉네임 모달 노출.
  // 세션 복구가 우선 — 그쪽이 성공하면 URL 의 ?room= 은 onResumeSuccess 에서 정합화된다.
  const urlRoom = getRoomFromUrl();
  if (urlRoom) showDirectJoinModal(urlRoom);
}

connect();
