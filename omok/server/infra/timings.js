// ============================================================
// 서버 timing 상수의 단일 source-of-truth.
// 같은 env 변수가 여러 파일에서 서로 다른 default 를 갖던 사고 방지.
// ============================================================

// 사용자 끊김 → finalizeAbandon 까지의 grace 기간.
//
// 두 시나리오에서 모두 사용:
//   (1) Runtime disconnect (handlers/disconnect.js):
//       heartbeat 가 15s × 2 cycle (최대 30s) 동안 무응답 → onPlayerDisconnect.
//       추가로 60s grace 동안 reconnect 못 하면 finalizeAbandon.
//       총 최대 30+60=90s — Render free-tier deploy graceful 30s 도 안에 들어옴.
//   (2) Rehydrate (handlers/rehydrate.js):
//       valkey backend 부팅 시 진행 중이던 방들의 grace timer 신규 등록.
//       deploy 직전 메모리 setTimeout 은 죽었으므로 0 부터 60s 카운트.
//       Render deploy 시간이 60s 를 넘어 reconnect 여유 부족하면 prod 의 env 로
//       DISCONNECT_GRACE_MS=90000 (또는 더 길게) override.
//
// 기본값 60s — prod 측정 시 heartbeat_terminate 가 24h 41~165건 수준이라
// grace 50% 증가가 opponent_abandoned 평균을 흔들 수 있어 보수적으로 유지.
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS) || 60000;

module.exports = { DISCONNECT_GRACE_MS };
