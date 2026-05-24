// ============================================================
// daily counter — KST 캘린더 day 별 카운터 증가 helper.
// ============================================================
// game_over / bot move 등 이벤트 시점에 호출. store (valkey/memory) 의
// incrementDailyCounter 를 wrapping 해 KST date 자동 계산 + 예외 swallow.
// monitor 가 /api/daily-stats?date=YYYY-MM-DD 로 읽어 authoritative source 로 사용.
//
// fields (현재 추적 중):
//   - pvp_games       : PVP 게임 종료 수
//   - bot_games       : 봇 게임 종료 수
//   - total_bot_moves : 봇 착수 수

'use strict';

const { getStore } = require('../store');

// KST 기준 YYYY-MM-DD 반환. en-CA locale 이 ISO date 형식 (YYYY-MM-DD) 과 동일.
// 매 호출마다 new Date() — 자정 직후 호출은 다음 날짜로 자연 전환.
const kstDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

// 오늘 (KST) 의 field 카운터를 n 만큼 증가. store 가 valkey 면 HINCRBY,
// memory 면 in-process. 예외는 swallow — caller 의 정상 흐름 절대 방해 안 함.
const incrementToday = (field, n = 1) => {
  try {
    const store = getStore();
    store.incrementDailyCounter(kstDate(), field, n);
  } catch {}
};

module.exports = { kstDate, incrementToday };
