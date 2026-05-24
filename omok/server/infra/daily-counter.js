// ============================================================
// daily 데이터 helper — KST 캘린더 day 별 카운터 / SET / LIST + online sampler.
// ============================================================
// game_over / bot move / RETRY / SKIP / heartbeat 등 이벤트 시점에 호출.
// store (valkey/memory) 의 incrementDailyCounter / addDailySetMember /
// pushDailyListItem / sampleOnline 을 wrapping 해 KST date 자동 계산 + 예외 swallow.
// monitor 가 /api/daily-stats / /api/daily-games / /api/daily-bot-moves /
// /api/online-series 로 읽어 server-domain 데이터의 단일 source 로 사용.
//
// fields (counter Hash):
//   - pvp_games / bot_games           : 게임 종료 수 (game.js / disconnect.js)
//   - total_bot_moves                 : 봇 착수 수 (game.js applyMove actor='bot')
//   - worker_timeout / no_move        : 봇 search 실패 (bot.js)
//   - bot_retry / bot_skip            : 봇 schedule 재시도 / 스킵 (bot.js)
//   - heartbeat_terminate             : 좀비 ws 정리 (server.js)
//   - ws_connected / ws_disconnected  : WS 연결/끊김 (server.js)
//
// sets (date 별 unique):
//   - active_users                    : 게임 종료 시 양 사람 nick (game.js)
//   - bot_retry_rooms / bot_retry_clients : RETRY 영향 unique (bot.js)
//   - bot_skip_rooms  / bot_skip_clients  : SKIP 영향 unique (bot.js)
//
// lists (date 별 raw event JSON):
//   - games      : game_over 시 gameOverFields(...) JSON (game.js / disconnect.js)
//   - bot_moves  : applyMove (actor='bot') 시 move event JSON (bot.js)
//
// online time-series:
//   - 1분 sampler (server.js) 가 sampleOnline(ts, count) 호출

'use strict';

const { getStore } = require('../store');

// KST 기준 YYYY-MM-DD 반환. en-CA locale 이 ISO date 형식 (YYYY-MM-DD) 과 동일.
// 매 호출마다 new Date() — 자정 직후 호출은 다음 날짜로 자연 전환.
const kstDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

// 모든 helper 는 예외 swallow — caller 의 정상 흐름 절대 방해 안 함 (fire-and-forget).

const incrementToday = (field, n = 1) => {
  try { getStore().incrementDailyCounter(kstDate(), field, n); } catch {}
};

const addTodaySetMember = (name, member) => {
  try { getStore().addDailySetMember(kstDate(), name, member); } catch {}
};

const pushTodayListItem = (name, item) => {
  try { getStore().pushDailyListItem(kstDate(), name, item); } catch {}
};

const sampleOnlineNow = (count) => {
  try { getStore().sampleOnline(Date.now(), count); } catch {}
};

module.exports = {
  kstDate,
  incrementToday,
  addTodaySetMember,
  pushTodayListItem,
  sampleOnlineNow,
};
