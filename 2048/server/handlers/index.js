// ============================================================
// WS message router — 클라가 보내는 type 별 handler 분기
// ============================================================
// 메시지:
//   C→S:
//     { type: 'set_nickname', clientId, nickname }
//     { type: 'submit_score', clientId, nickname?, score }
//     { type: 'request_ranking' }                # 최초 진입 시 1회
//     { type: 'request_my_rank', clientId }
//     { type: 'ping' }
//   S→C:
//     { type: 'nickname_set', user }
//     { type: 'score_recorded', user, allTimeUpdated, dailyUpdated }
//     { type: 'ranking', allTime: [...], daily: [...] }                # 변동 broadcast
//     { type: 'my_rank', allTime: {...}, daily: {...} }
//     { type: 'pong' }
//     { type: 'error', message }
// ============================================================
'use strict';

const send = require('./send');
const users = require('../domain/users');
const log = require('../infra/log');

const RANKING_TOP_N = 10;

const buildRankingPayload = () => ({
  type: 'ranking',
  allTime: users.getTopAllTime(RANKING_TOP_N),
  daily: users.getTopDaily(RANKING_TOP_N),
  dailyDate: users.kstDateStr(),
});

const broadcastRanking = () => send.broadcastAll(buildRankingPayload());

const handleMessage = (ws, msg) => {
  if (!msg || typeof msg.type !== 'string') return;
  switch (msg.type) {
    case 'set_nickname': {
      const clientId = String(msg.clientId || '').slice(0, 64);
      const nickname = String(msg.nickname || '');
      if (!clientId) return send.send(ws, { type: 'error', message: 'clientId 필요' });
      // 닉 변경 전 영속 사용자의 닉을 스냅샷 — ws.nickname 은 connection-bound 이라
      // 재연결마다 '' 로 시작해서 같은 닉 재전송에도 broadcast 가 일어남. 영속 비교가 정확.
      const before = users.getUser(clientId);
      const prevPersistedNick = before ? before.nickname : null;
      const user = users.setNickname(clientId, nickname);
      if (!user) return send.send(ws, { type: 'error', message: '닉네임 형식 오류' });
      ws.clientId = clientId;
      ws.nickname = user.nickname;
      send.send(ws, { type: 'nickname_set', user });
      // 사용자가 랭킹에 노출돼 있고 (= 점수 > 0) 실제로 닉이 바뀌었으면 broadcast.
      // 점수 0 인 익명/자동닉 사용자가 닉만 정하는 케이스에서는 굳이 broadcast 안 함 (트래픽 절약).
      const hasScore = user.allTimeBest > 0 || user.dailyBest > 0;
      const nickActuallyChanged = prevPersistedNick !== null && prevPersistedNick !== user.nickname;
      if (hasScore && nickActuallyChanged) broadcastRanking();
      log.event('nickname_set', { client: log.mask(clientId), nick: user.nickname });
      if (!before) log.event('user_created', { client: log.mask(clientId), nick: user.nickname, src: 'nickname' });
      return;
    }
    case 'submit_score': {
      const clientId = String(msg.clientId || '').slice(0, 64);
      const nickname = String(msg.nickname || '');
      const score = Number(msg.score);
      if (!clientId || !Number.isFinite(score) || score < 0) {
        return send.send(ws, { type: 'error', message: '잘못된 점수' });
      }
      const before = users.getUser(clientId);
      const r = users.submitScore(clientId, nickname, score);
      if (!r) return send.send(ws, { type: 'error', message: '등록 실패' });
      ws.clientId = clientId;
      ws.nickname = r.user.nickname;
      send.send(ws, {
        type: 'score_recorded',
        user: r.user,
        allTimeUpdated: r.allTimeUpdated,
        dailyUpdated: r.dailyUpdated,
      });
      // submit_score — 모든 등록 로그 (best 아니어도). monitor 가 일일 게임 수 / 활성
      // 사용자 (unique nick) 카운트의 raw 소스로 사용. broadcast 트리거인 score_best
      // 는 갱신 시에만 출력 (사용자 visible 이벤트).
      log.event('submit_score', {
        client: log.mask(clientId), nick: r.user.nickname,
        score, allTime: r.allTimeUpdated, daily: r.dailyUpdated,
      });
      if (!before) log.event('user_created', { client: log.mask(clientId), nick: r.user.nickname, src: 'score' });
      if (r.allTimeUpdated || r.dailyUpdated) {
        broadcastRanking();   // best 변동 시만 broadcast — 노이즈 ↓
        log.event('score_best', {
          client: log.mask(clientId), nick: r.user.nickname,
          score, allTime: r.allTimeUpdated, daily: r.dailyUpdated,
        });
      }
      return;
    }
    case 'request_ranking': {
      send.send(ws, buildRankingPayload());
      return;
    }
    case 'request_my_rank': {
      const clientId = String(msg.clientId || '').slice(0, 64);
      const r = users.getMyRank(clientId);
      send.send(ws, { type: 'my_rank', ...r });
      return;
    }
    case 'ping': {
      ws.isAlive = true;
      send.send(ws, { type: 'pong' });
      return;
    }
    default:
      send.send(ws, { type: 'error', message: `알 수 없는 타입: ${msg.type}` });
  }
};

module.exports = { handleMessage, broadcastRanking, init: send.init };
