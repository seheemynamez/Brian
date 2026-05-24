// ============================================================
// daily 데이터 helper — KST 캘린더 day 별 카운터 / SET + online sampler.
// ============================================================
// omok/server/infra/daily-counter.js 와 같은 패턴. 2048 도메인 사용처:
//   - submit_score / user_created / score_best → counter
//   - active_users → SET (submit 한 unique 사람 nick)
//   - ws_connected / ws_disconnected / heartbeat_terminate → counter
//   - 1분 online sampler (server.js)
// monitor 가 /api/daily-stats / /api/online-series 로 읽어 server-domain 데이터의
// 단일 source 로 사용 (Render log fetch 대체).

'use strict';

const store = require('../store');

const kstDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

const incrementToday = (field, n = 1) => {
  try { store.incrementDailyCounter(kstDate(), field, n); } catch {}
};
const addTodaySetMember = (name, member) => {
  try { store.addDailySetMember(kstDate(), name, member); } catch {}
};
const sampleOnlineNow = (count) => {
  try { store.sampleOnline(Date.now(), count); } catch {}
};

module.exports = { kstDate, incrementToday, addTodaySetMember, sampleOnlineNow };
