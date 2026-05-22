"""monitor MODE=collect — 매 5분 cron. 메트릭 수집 + 임계 검사 + alert Issue 생성."""
from __future__ import annotations
import json
import os
from datetime import timedelta

from monitor_config import (
    ALERT_LABELS, AIVEN_MEM_LIMIT_MB, COOLDOWN_HOURS, DRY_RUN, METRICS_DIR, NOW,
    REPO_ROOT, RENDER_CPU_LIMIT_M, RENDER_MEM_LIMIT_MB, TODAY,
    THRESHOLD_AIVEN_MEM_PCT, THRESHOLD_BOT_RETRY_15MIN, THRESHOLD_BOT_SKIP_15MIN,
    THRESHOLD_DOWNTIME_S, THRESHOLD_RENDER_CPU_M,
)
from monitor_apis import (
    aiven_metrics, create_issue, render_events, render_metric,
    render_recent_deploy_status, render_search_logs,
)
from monitor_data import (
    aiven_stats, compute_recovery_times, cooldown_ok, load_state, mark_alerted,
    parse_bot_logs, parse_server_failures, render_cpu_stats, render_mem_stats,
    save_state, summarize_bot_logs,
)


def run_collect():
    win_end = NOW
    # Window 30분 → 15분 (cron 30분 → 5분 변경에 맞춰 더 세밀하게).
    # 같은 alert 가 evaluation 마다 재발사되지 않게 COOLDOWN_HOURS=2 으로 묶임.
    win_start = NOW - timedelta(minutes=15)
    s_iso = win_start.strftime('%Y-%m-%dT%H:%M:%SZ')
    e_iso = win_end.strftime('%Y-%m-%dT%H:%M:%SZ')

    cpu = render_metric('cpu', s_iso, e_iso, 60)
    mem = render_metric('memory', s_iso, e_iso, 60)
    cpu_st = render_cpu_stats(cpu)
    mem_st = render_mem_stats(mem)
    deploy = render_recent_deploy_status()
    wt_logs = render_search_logs('worker_timeout', s_iso, e_iso, limit=10)
    nm_logs = render_search_logs('search returned no move', s_iso, e_iso, limit=10)
    # 봇 RETRY / SKIP (PR #85) — Wi-Fi 불안정으로 사람 zombie 판정된 빈도.
    # RETRY 가 정상 회복 흐름, SKIP 은 RETRY 도 못 잡는 진짜 끊김 (드물어야 정상).
    retry_logs = render_search_logs('schedule RETRY', s_iso, e_iso, limit=50)
    skip_logs = render_search_logs('schedule SKIP', s_iso, e_iso, limit=30)
    # 인프라 이벤트 (PR #89) — server_failed (OOM / crash) 감지.
    events = render_events(s_iso, e_iso, limit=100)
    failures = parse_server_failures(events)
    oom_fails = [f for f in failures if f['evicted'] or f['oom']]
    crash_fails = [f for f in failures if not (f['evicted'] or f['oom'])]
    # downtime 측정 (PR #97) — server_failed/deploy_started → server_available 매칭.
    recoveries = compute_recovery_times(events)
    slow_recoveries = [r for r in recoveries if r['downtime_s'] > THRESHOLD_DOWNTIME_S]
    aiven = aiven_metrics(period='hour')
    aiven_cpu = aiven_stats(aiven, 'cpu_usage')
    aiven_mem = aiven_stats(aiven, 'mem_usage')

    # RETRY/SKIP 분포 — unique rooms / clients (issue #108 같은 false positive 차단)
    retry_parsed = parse_bot_logs(retry_logs)
    skip_parsed = parse_bot_logs(skip_logs)

    snapshot = {
        'ts': NOW.isoformat(),
        'render': {
            'cpu_peak_m': cpu_st['max'] if cpu_st else None,
            'cpu_avg_m':  cpu_st['avg'] if cpu_st else None,
            'mem_peak_mb': mem_st['max'] if mem_st else None,
            'deploy_status': deploy['status'] if deploy else None,
            'worker_timeout_count': len(wt_logs),
            'no_move_count': len(nm_logs),
            'bot_retry_count': len(retry_logs),
            'bot_skip_count':  len(skip_logs),
            # unique rooms / clientIds — RETRY 가 1-2 게임 lag 인지 vs 다수 사용자 lag 인지 구분.
            'bot_retry_rooms':   len({p['room'] for p in retry_parsed}),
            'bot_retry_clients': len({p['client'] for p in retry_parsed if p['client']}),
            'bot_skip_rooms':    len({p['room'] for p in skip_parsed}),
            'bot_skip_clients':  len({p['client'] for p in skip_parsed if p['client']}),
            'server_failed_count': len(failures),
            'server_oom_count':    len(oom_fails),
            'server_crash_count':  len(crash_fails),
            'downtime_count': len(recoveries),
            'downtime_max_s': max((r['downtime_s'] for r in recoveries), default=None),
            'slow_recovery_count': len(slow_recoveries),
        },
        'aiven': {
            'cpu_pct_avg': aiven_cpu['avg'] if aiven_cpu else None,
            'cpu_pct_max': aiven_cpu['max'] if aiven_cpu else None,
            'mem_pct_avg': aiven_mem['avg'] if aiven_mem else None,
            'mem_pct_max': aiven_mem['max'] if aiven_mem else None,
        },
    }
    print(json.dumps(snapshot, indent=2, ensure_ascii=False))

    # 임계 검사
    state = load_state()
    alerts = []
    if cpu_st and cpu_st['max'] >= THRESHOLD_RENDER_CPU_M:
        alerts.append(('render_cpu_high',
            f'[monitor] Render CPU peak {cpu_st["max"]:.1f}m (≥{THRESHOLD_RENDER_CPU_M:.0f}m)',
            f'## Render CPU peak 임계 초과\n\n'
            f'- 측정: **{cpu_st["max"]:.1f}m** (CPU peak, 최근 15분)\n'
            f'- 임계: ≥ {THRESHOLD_RENDER_CPU_M:.0f}m (한도 {RENDER_CPU_LIMIT_M:.0f}m)\n'
            f'- 시각: {NOW.isoformat()}\n\n'
            f'### 같이 본 상태\n'
            f'- Render Memory peak: {mem_st["max"]:.1f}MB / {RENDER_MEM_LIMIT_MB:.0f}MB\n'
            f'- Aiven CPU max: {aiven_cpu["max"]:.1f}% (h)\n'
            f'- Aiven Memory max: {aiven_mem["max"]:.1f}%\n\n'
            f'### 다음 조치 후보\n'
            f'- 봇 동시 사용 패턴 점검 (Render 로그)\n'
            f'- Hobby plan ($7/월) 검토\n'))
    if aiven_mem and aiven_mem['max'] >= THRESHOLD_AIVEN_MEM_PCT:
        alerts.append(('aiven_mem_high',
            f'[monitor] Aiven valkey Memory {aiven_mem["max"]:.1f}% (≥{THRESHOLD_AIVEN_MEM_PCT:.0f}%)',
            f'## Aiven Memory 임계 초과\n\n'
            f'- 측정: **{aiven_mem["max"]:.1f}%** / {AIVEN_MEM_LIMIT_MB:.0f}MB\n'
            f'- 임계: ≥ {THRESHOLD_AIVEN_MEM_PCT:.0f}% — noeviction (100% 시 write 실패)\n'
            f'- 시각: {NOW.isoformat()}\n\n'
            f'### 다음 조치 후보\n'
            f'- 정기 cleanup 검토\n'
            f'- Aiven Startup-4 (4GB / $30월) 검토\n'))
    if len(wt_logs) > 0:
        samples = '\n'.join(f'- `{L["timestamp"][:19]}` {L["message"][:140]}' for L in wt_logs[:5])
        alerts.append(('worker_timeout',
            f'[monitor] worker_timeout 발생 {len(wt_logs)}건',
            f'## 봇 worker_timeout 발생\n\n'
            f'- 카운트: **{len(wt_logs)}건** (최근 15분)\n'
            f'- 임계: > 0 (PR #82+ 0건 유지 베이스)\n\n'
            f'### 샘플\n{samples}\n\n'
            f'self-abort 회귀 의심. 최근 PR 점검 필요.\n'))
    if len(nm_logs) > 0:
        samples = '\n'.join(f'- `{L["timestamp"][:19]}` {L["message"][:140]}' for L in nm_logs[:5])
        alerts.append(('no_move',
            f'[monitor] 봇 no_move {len(nm_logs)}건',
            f'## 봇이 수를 못 두는 케이스\n\n- 카운트: **{len(nm_logs)}건**\n\n### 샘플\n{samples}\n'))
    if deploy and deploy['status'] not in ('live', 'pre_deploy_in_progress', 'build_in_progress', 'update_in_progress'):
        alerts.append(('deploy_bad',
            f'[monitor] Render 배포 상태 비정상: {deploy["status"]}',
            f'## Render 배포 비정상\n\n- 상태: **{deploy["status"]}**\n- 시각: {deploy["createdAt"]}\n- 커밋: {deploy["commit"]}\n'))
    if len(retry_logs) >= THRESHOLD_BOT_RETRY_15MIN:
        samples = '\n'.join(f'- `{L["timestamp"][:19]}` {L["message"][:140]}' for L in retry_logs[:5])
        alerts.append(('bot_retry_burst',
            f'[monitor] 봇 schedule RETRY {len(retry_logs)}건 (≥{THRESHOLD_BOT_RETRY_15MIN})',
            f'## 봇 RETRY burst — 사용자 다수 Wi-Fi lag 의심\n\n'
            f'- 카운트: **{len(retry_logs)}건** (최근 15분)\n'
            f'- 임계: ≥ {THRESHOLD_BOT_RETRY_15MIN}건\n'
            f'{summarize_bot_logs(retry_parsed)}\n'
            f'- 시각: {NOW.isoformat()}\n\n'
            f'### 의미\n'
            f'RETRY = Wi-Fi 잠시 lag 으로 사람 zombie 판정 → 3s 후 재시도. PR #85 의 정상 회복 흐름. '
            f'burst 가 잦으면 다수 사용자 lag 상황 (서버 응답 지연 / 사용자 측 ISP 등 영향). '
            f'영향 게임/사용자 수 비교: 1-2개면 단일 사용자 wifi 문제 가능성, 3개 이상이면 서버 측 의심.\n\n'
            f'### 샘플\n{samples}\n\n'
            f'### 같이 본 상태\n'
            f'- Render CPU peak: {cpu_st["max"] if cpu_st else "?"}m\n'
            f'- Aiven CPU max: {aiven_cpu["max"] if aiven_cpu else "?"}%\n'))
    if len(skip_logs) >= THRESHOLD_BOT_SKIP_15MIN:
        samples = '\n'.join(f'- `{L["timestamp"][:19]}` {L["message"][:140]}' for L in skip_logs[:5])
        alerts.append(('bot_skip_burst',
            f'[monitor] 봇 schedule SKIP {len(skip_logs)}건 (≥{THRESHOLD_BOT_SKIP_15MIN})',
            f'## 봇 SKIP burst — RETRY 도 못 잡는 끊김 사례\n\n'
            f'- 카운트: **{len(skip_logs)}건** (최근 15분)\n'
            f'- 임계: ≥ {THRESHOLD_BOT_SKIP_15MIN}건\n'
            f'{summarize_bot_logs(skip_parsed)}\n'
            f'- 시각: {NOW.isoformat()}\n\n'
            f'### 의미\n'
            f'SKIP 은 PR #85 이후 거의 발생 X 가 정상. burst 발생 = `bothPlayersOnline` 가드를 RETRY 가 '
            f'우회 못 하는 새 패턴. 코드 회귀 또는 새 끊김 시나리오 의심.\n\n'
            f'### 샘플\n{samples}\n'))
    if oom_fails:
        samples = '\n'.join(f'- `{f["ts"][:19]}` instance={f["instance"][-6:]} evicted={f["evicted"]} oom={f["oom"]}' for f in oom_fails[:5])
        alerts.append(('server_oom',
            f'[monitor] 서버 OOM 강제 종료 {len(oom_fails)}건',
            f'## 서버 OOM (메모리 한도 초과) 감지\n\n'
            f'- 카운트: **{len(oom_fails)}건** (최근 15분)\n'
            f'- 임계: > 0 (OOM 은 자원 부족 신호 — 1건도 위험)\n'
            f'- 시각: {NOW.isoformat()}\n\n'
            f'### 의미\n'
            f'`evicted=true` 또는 `oom=true` — 인스턴스가 메모리 한도 (512MB) 도달로 강제 종료됨. '
            f'Render 가 자동 재시작 하지만 진행 중 게임/세션 사라짐.\n\n'
            f'### 샘플\n{samples}\n\n'
            f'### 다음 조치\n'
            f'- 메모리 leak 검토 (시간 따라 증가 추세)\n'
            f'- Aiven 캐시 사용량 점검\n'
            f'- Hobby plan ($7/월, 512MB) 또는 Standard ($25/월, 2GB) 검토\n'))
    if crash_fails:
        samples = '\n'.join(f'- `{f["ts"][:19]}` instance={f["instance"][-6:]} nonZeroExit={f["nonZeroExit"]}' for f in crash_fails[:5])
        alerts.append(('server_crash',
            f'[monitor] 서버 crash (코드 에러) {len(crash_fails)}건',
            f'## 서버 crash 감지 (nonZeroExit)\n\n'
            f'- 카운트: **{len(crash_fails)}건** (최근 15분)\n'
            f'- 임계: > 0 (crash 1건도 회귀 신호)\n'
            f'- 시각: {NOW.isoformat()}\n\n'
            f'### 의미\n'
            f'`nonZeroExit=1` — Node 프로세스가 코드 에러 또는 `process.exit(N≠0)` 로 종료. '
            f'unhandled exception / startup 실패 / hydrate 실패 가능성.\n\n'
            f'### 샘플\n{samples}\n\n'
            f'### 다음 조치\n'
            f'- 최근 deploy / PR 점검\n'
            f'- Render 로그에서 crash 직전 에러 메시지 확인\n'
            f'- crash loop (짧은 시간 다수) 면 rollback 검토\n'))
    if slow_recoveries:
        samples = '\n'.join(
            f'- `{r["start_ts"][:19]}` {r["kind"]} — downtime **{r["downtime_s"]:.1f}s** (60s grace 초과)'
            for r in slow_recoveries[:5]
        )
        max_dt = max(r['downtime_s'] for r in slow_recoveries)
        alerts.append(('server_slow_recovery',
            f'[monitor] 서버 downtime {max_dt:.0f}s (> {THRESHOLD_DOWNTIME_S:.0f}s grace)',
            f'## 서버 downtime 이 grace 60s 초과\n\n'
            f'- 발생: **{len(slow_recoveries)}건** (최근 15분)\n'
            f'- 최대 downtime: **{max_dt:.1f}s**\n'
            f'- 임계: > {THRESHOLD_DOWNTIME_S:.0f}s — DISCONNECT_GRACE_MS (60s) 안에 사용자 재연결 어려움 → '
            f'진행 중 게임이 abandoned 처리될 위험.\n\n'
            f'### 측정\n'
            f'`server_failed` (또는 `deploy_started`) → `server_available` 간격.\n\n'
            f'### 샘플\n{samples}\n\n'
            f'### 다음 조치\n'
            f'- Render free → Hobby 등급 (cold start ↓) 검토\n'
            f'- DISCONNECT_GRACE_MS 상향 (현재 60s → 90s) 검토 — 비용 = 진짜 떠난 사용자 자리 60s 더 점유\n'
            f'- 반복 발생 시 root cause (메모리 / 코드 회귀) 파악\n'))

    for key, title, body in alerts:
        if not cooldown_ok(state, key):
            print(f'  alert {key}: cooldown active — skip')
            continue
        labels = ALERT_LABELS.get(key, ['monitor', 'severity-high'])
        url = create_issue(title, body, labels)
        if url or DRY_RUN:
            mark_alerted(state, key)
            print(f'  alerted: {key} → {url}')

    # 저장
    if not DRY_RUN or os.environ.get('SAVE_METRICS') == '1':
        METRICS_DIR.mkdir(exist_ok=True)
        daily_file = METRICS_DIR / f'{TODAY}.json'
        daily = json.loads(daily_file.read_text()) if daily_file.exists() else []
        daily.append(snapshot)
        daily_file.write_text(json.dumps(daily, indent=2, ensure_ascii=False))
        save_state(state)
        print(f'  saved: {daily_file.relative_to(REPO_ROOT)}')

    print(f'\n=== {len(alerts)} alert(s) ===' if alerts else '\n=== no alerts ===')
