// ============================================================
// 서버 timing 상수의 단일 source-of-truth.
// 같은 env 변수가 여러 파일에서 서로 다른 default 를 갖던 사고 방지.
// ============================================================

// 사용자 끊김 → finalizeAbandon 까지의 grace 기간.
//
// 두 시나리오에서 모두 사용:
//   (1) Runtime disconnect (handlers/disconnect.js):
//       heartbeat 15s × 2 cycle (최대 30s) 무응답 → onPlayerDisconnect.
//       추가로 90s grace 동안 reconnect 못 하면 finalizeAbandon.
//       총 최대 30+90=120s.
//   (2) Rehydrate (handlers/rehydrate.js):
//       valkey backend 부팅 시 진행 중이던 방들의 grace timer 신규 등록.
//       deploy 직전 메모리 setTimeout 은 죽었으므로 0 부터 90s 카운트.
//
// 기본값 90s — Issue #155 (5/24 deploy 136s) 까지 측정 데이터 반영:
//   옛 60s 정책: median 43s, p75 59s, max 102s (24h, n=10) 기반 — 안전선.
//   새 90s 정책: Render free plan deploy 시간 41s~137s 변동 관찰 (같은 day 내).
//     - 5/22 deploy ~50s, 5/23 ~54s, 5/24 03:52 41s, 5/24 15:49 137s.
//     - 136s 같은 outlier 발생 시 60s grace 부족 → 진행 중 게임 abandoned 위험.
//   trade-off: 진짜 떠난 사용자 자리 30s 더 점유 (총 120s 까지).
//
// monitor 의 THRESHOLD_DOWNTIME_S 도 90s 로 동기. monitor/server 정책 일치.
// 향후 reconnect_latency 분포 측정 후 패턴 바뀌면 env override 로 조정.
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS) || 90000;

module.exports = { DISCONNECT_GRACE_MS };
