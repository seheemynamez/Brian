// ============================================================
// 서버 timing 상수의 단일 source-of-truth.
// 같은 env 변수가 여러 파일에서 서로 다른 default 를 갖던 사고 방지.
// ============================================================

// 사용자 끊김 → finalizeAbandon 까지의 grace 기간.
//
// 두 시나리오에서 모두 사용:
//   (1) Runtime disconnect (handlers/disconnect.js):
//       heartbeat 15s × 2 cycle (최대 30s) 무응답 → onPlayerDisconnect.
//       추가로 60s grace 동안 reconnect 못 하면 finalizeAbandon.
//       총 최대 30+60=90s.
//   (2) Rehydrate (handlers/rehydrate.js):
//       valkey backend 부팅 시 진행 중이던 방들의 grace timer 신규 등록.
//       deploy 직전 메모리 setTimeout 은 죽었으므로 0 부터 60s 카운트.
//
// 기본값 60s — Render server_failed→server_available 측정 (24h, n=10):
//   median 43s, p75 59s, max 102s.
//   p75 까지는 60s grace 안에 FE backoff (1+2+4+8+16+30s) reconnect 도달.
//   극단 case (102s) 도 FE 의 30s cap 시점에서 도달 가능.
//   90s grace 가 활용된 sample 없음 — 60s 가 데이터 정당화된 안전선.
//
// 향후 reconnect_latency 분포 측정 후 패턴 바뀌면 env override 로 조정.
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS) || 60000;

module.exports = { DISCONNECT_GRACE_MS };
