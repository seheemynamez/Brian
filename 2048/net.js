// ============================================================
// 2048 WebSocket 클라이언트 — 닉네임 / 점수 등록 / 랭킹 수신
// ============================================================
// omok/js/net.js 와 비슷한 패턴 (호스트 기반 URL 분기 + 지수 백오프 재연결 +
// app-level heartbeat) 이지만 2048 은 방/세션 개념이 없어서 훨씬 작다.
// 노출: window.Net2048 = { connect, sendNickname, submitScore, requestMyRank,
//                           getClientId, getNick, setNick, isConnected }
(function () {
  'use strict';

  // ---- 서버 URL ----
  // GitHub Pages 에서 켜진 경우는 Render 의 prod 서버, 그 외 (로컬 dev, LAN)
  // 은 같은 origin 으로 가정 (8081 으로 띄운 BE 와 함께 정적 서빙 시).
  const PROD_WS_URL    = 'wss://two048-server-yom9.onrender.com/ws';
  const PROD_SHARE_BASE = 'https://two048-server-yom9.onrender.com';

  const WS_URL = (function () {
    if (location.hostname === 'seheemynamez.github.io') return PROD_WS_URL;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return proto + '://' + location.host + '/ws';
  })();

  // ---- 안정 식별자 ----
  const CLIENT_ID_KEY = '2048_client_id';
  const NICK_KEY      = '2048_nick';

  const getClientId = () => {
    let id = localStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
      id = (crypto.randomUUID
        ? crypto.randomUUID()
        : String(Date.now()) + '-' + Math.random().toString(36).slice(2));
      localStorage.setItem(CLIENT_ID_KEY, id);
    }
    return id;
  };

  const getNick = () => localStorage.getItem(NICK_KEY) || '';
  const setNick = (n) => {
    if (n) localStorage.setItem(NICK_KEY, n);
    else   localStorage.removeItem(NICK_KEY);
  };

  // ---- 송신 ----
  let ws = null;
  let connected = false;
  let serverRestarting = false;

  const send = (obj) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(obj)); } catch {}
    }
  };

  const sendNickname = (nick) => {
    if (!nick) return;
    setNick(nick);
    send({ type: 'set_nickname', clientId: getClientId(), nickname: nick });
  };

  // 게임 종료 시 호출. 닉네임/clientId 누락이면 서버가 거부함.
  const submitScore = (score) => {
    if (!Number.isFinite(score) || score < 0) return;
    const nick = getNick();
    if (!nick) return;   // 닉네임 없으면 boundary 에서 차단 (rank.js 가 모달로 받음)
    send({ type: 'submit_score', clientId: getClientId(), nickname: nick, score });
  };

  const requestRanking = () => send({ type: 'request_ranking' });
  const requestMyRank  = () => send({ type: 'request_my_rank', clientId: getClientId() });

  // ---- 재연결 백오프 + heartbeat (omok 패턴과 동일) ----
  const RECONNECT_BASE_MS   = 1000;
  const RECONNECT_MAX_MS    = 30000;
  const RECONNECT_JITTER_MS = 500;
  const APP_PING_INTERVAL_MS = 25000;

  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let appPingTimer = null;

  const clearReconnectTimer = () => {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };
  const clearAppPingTimer = () => {
    if (appPingTimer) { clearInterval(appPingTimer); appPingTimer = null; }
  };

  const scheduleReconnect = () => {
    clearReconnectTimer();
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt), RECONNECT_MAX_MS)
                + Math.floor(Math.random() * RECONNECT_JITTER_MS);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(connect, delay);
  };

  // ---- 이벤트 디스패치 ----
  // rank.js / game.js 가 자체적으로 hook 할 수 있도록 CustomEvent 로 노출.
  const emit = (type, detail) => {
    window.dispatchEvent(new CustomEvent('net2048:' + type, { detail }));
  };

  const dispatch = (msg) => {
    switch (msg.type) {
      case 'pong':            return;
      case 'nickname_set':    return emit('nickname_set', msg.user);
      case 'score_recorded':  return emit('score_recorded', msg);
      case 'ranking':         return emit('ranking', msg);
      case 'my_rank':         return emit('my_rank', msg);
      case 'error':           return emit('error', msg);
      case 'server_restarting':
        serverRestarting = true;
        emit('server_restarting', {});
        return;
      default:
        // unknown — 무시
    }
  };

  // ---- 연결 ----
  function connect() {
    clearReconnectTimer();
    try { ws = new WebSocket(WS_URL); } catch (e) {
      scheduleReconnect();
      return;
    }

    ws.addEventListener('open', () => {
      connected = true;
      reconnectAttempt = 0;
      serverRestarting = false;
      clearAppPingTimer();
      appPingTimer = setInterval(() => send({ type: 'ping' }), APP_PING_INTERVAL_MS);

      // 닉네임이 있으면 등록 (재연결 후 자동 복원) + 랭킹 + 내 순위 요청.
      const nick = getNick();
      if (nick) sendNickname(nick);
      requestRanking();
      if (nick) requestMyRank();
      emit('connected', {});
    });

    ws.addEventListener('close', () => {
      connected = false;
      clearAppPingTimer();
      emit('disconnected', { serverRestarting });
      scheduleReconnect();
    });

    ws.addEventListener('error', () => { /* close 가 따라옴 */ });

    ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      dispatch(msg);
    });
  }

  // ---- 공유 URL 빌더 ----
  // /i/2048/{nick}/{score} → Render 서버가 OG meta + canonical 2048 페이지 redirect.
  // 메신저 봇은 OG 만 읽고 사람은 게임으로 이동. 운영(GitHub Pages) 도메인이면 prod
  // share base 사용, 로컬은 같은 origin (launcher 의 /i/2048 endpoint).
  const buildShareUrl = (nick, score) => {
    const base = location.hostname === 'seheemynamez.github.io'
      ? PROD_SHARE_BASE
      : location.origin;
    const segs = ['i', '2048'];
    if (nick) segs.push(encodeURIComponent(nick));
    if (nick && Number.isFinite(Number(score))) segs.push(String(Math.floor(score)));
    return `${base}/${segs.join('/')}`;
  };

  // ---- 노출 ----
  window.Net2048 = {
    connect,
    sendNickname,
    submitScore,
    requestRanking,
    requestMyRank,
    getClientId,
    getNick,
    setNick,
    isConnected: () => connected,
    buildShareUrl,
    PROD_SHARE_BASE,
  };
})();
