"""monitor MODE=collect — 매 5분 cron. 메트릭 수집 + 임계 검사 + alert Issue 생성.

snapshot 구조:
  {
    "ts": "...",
    "services": {
      "omok":  {"render": {...인프라+봇...}, "stats": {...}},
      "2048":  {"render": {...인프라만...}, "stats": {...}},
    },
    "aiven": {...},                  # 공유 (omok/2048 같은 Aiven 인스턴스)
  }

alert key 는 `{base_key}:{service}` 로 service 별 cooldown 분리.
title 은 `[2048]` prefix (omok 은 기존 호환 위해 prefix 없음).
"""
from __future__ import annotations
import json
import os
from datetime import timedelta

from monitor_config import (
    ALERT_LABELS, AIVEN_MEM_LIMIT_MB, COOLDOWN_HOURS, DRY_RUN, METRICS_DIR, NOW,
    REPO_ROOT, RENDER_CPU_LIMIT_M, RENDER_MEM_LIMIT_MB, SERVICES, TODAY,
    THRESHOLD_AIVEN_MEM_PCT, THRESHOLD_BOT_RETRY_15MIN, THRESHOLD_BOT_SKIP_15MIN,
    THRESHOLD_DOWNTIME_S, THRESHOLD_RENDER_CPU_M,
    alert_key_for, service_label,
)
from monitor_apis import (
    aiven_metrics, create_issue, fetch_server_stats, render_events,
    render_metric, render_recent_deploy_status, render_search_logs,
)
from monitor_data import (
    aiven_stats, bot_activity_summary, compute_recovery_times, cooldown_ok,
    load_state, mark_alerted, parse_bot_logs, parse_bot_moves,
    parse_server_failures, render_cpu_stats, render_mem_stats,
    save_state, summarize_bot_logs,
)


# ============================================================
# service 별 메트릭/이벤트/로그 수집
# ============================================================
def _collect_render(service, s_iso, e_iso):
    """service 의 Render 인프라 메트릭 + 이벤트 + (omok 만) 봇 로그 fetch.

    반환:
      snap — metrics/*.json 에 저장될 dict (인프라 카운트 위주)
      raw  — alert 본문 생성에 쓸 원본 (cpu_st/mem_st/logs/failures 등)
    """
    cpu = render_metric('cpu', s_iso, e_iso, 60, service=service)
    mem = render_metric('memory', s_iso, e_iso, 60, service=service)
    cpu_st = render_cpu_stats(cpu)
    mem_st = render_mem_stats(mem)
    deploy = render_recent_deploy_status(service=service)
    events = render_events(s_iso, e_iso, limit=100, service=service)
    failures = parse_server_failures(events)
    oom_fails = [f for f in failures if f['evicted'] or f['oom']]
    crash_fails = [f for f in failures if not (f['evicted'] or f['oom'])]
    recoveries = compute_recovery_times(events)
    slow_recoveries = [r for r in recoveries if r['downtime_s'] > THRESHOLD_DOWNTIME_S]

    snap = {
        'cpu_peak_m': cpu_st['max'] if cpu_st else None,
        'cpu_avg_m':  cpu_st['avg'] if cpu_st else None,
        'mem_peak_mb': mem_st['max'] if mem_st else None,
        'deploy_status': deploy['status'] if deploy else None,
        'server_failed_count': len(failures),
        'server_oom_count':    len(oom_fails),
        'server_crash_count':  len(crash_fails),
        'downtime_count': len(recoveries),
        'downtime_max_s': max((r['downtime_s'] for r in recoveries), default=None),
        'slow_recovery_count': len(slow_recoveries),
    }
    raw = {
        'cpu_st': cpu_st, 'mem_st': mem_st, 'deploy': deploy,
        'failures': failures, 'oom_fails': oom_fails, 'crash_fails': crash_fails,
        'recoveries': recoveries, 'slow_recoveries': slow_recoveries,
    }

    if SERVICES[service]['has_bot_logs']:
        wt_logs = render_search_logs('worker_timeout', s_iso, e_iso, limit=10, service=service)
        nm_logs = render_search_logs('search returned no move', s_iso, e_iso, limit=10, service=service)
        retry_logs = render_search_logs('schedule RETRY', s_iso, e_iso, limit=50, service=service)
        skip_logs = render_search_logs('schedule SKIP', s_iso, e_iso, limit=30, service=service)
        retry_parsed = parse_bot_logs(retry_logs)
        skip_parsed = parse_bot_logs(skip_logs)
        snap.update({
            'worker_timeout_count': len(wt_logs),
            'no_move_count': len(nm_logs),
            'bot_retry_count': len(retry_logs),
            'bot_skip_count':  len(skip_logs),
            'bot_retry_rooms':   len({p['room'] for p in retry_parsed}),
            'bot_retry_clients': len({p['client'] for p in retry_parsed if p['client']}),
            'bot_skip_rooms':    len({p['room'] for p in skip_parsed}),
            'bot_skip_clients':  len({p['client'] for p in skip_parsed if p['client']}),
        })
        raw.update({
            'wt_logs': wt_logs, 'nm_logs': nm_logs,
            'retry_logs': retry_logs, 'skip_logs': skip_logs,
            'retry_parsed': retry_parsed, 'skip_parsed': skip_parsed,
        })

    return snap, raw


# ============================================================
# service 별 alert 생성
# ============================================================
def _title(service, body_title):
    """omok 은 기존 호환을 위해 prefix 없음, 2048 만 `[2048]` prefix."""
    return body_title if service == 'omok' else f'[{service}] {body_title}'


def _build_alerts(service, snap, raw, aiven_cpu, aiven_mem, s_iso, e_iso):
    alerts = []
    cpu_st = raw['cpu_st']; mem_st = raw['mem_st']; deploy = raw['deploy']

    # ---- Render CPU peak — service 공통, 봇 활동 컨텍스트 (omok 만)
    if cpu_st and cpu_st['max'] >= THRESHOLD_RENDER_CPU_M:
        body = (
            f'## Render CPU peak 임계 초과 — {service}\n\n'
            f'- 측정: **{cpu_st["max"]:.1f}m** (CPU peak, 최근 15분)\n'
            f'- 임계: ≥ {THRESHOLD_RENDER_CPU_M:.0f}m (한도 {RENDER_CPU_LIMIT_M:.0f}m)\n'
            f'- 시각: {NOW.isoformat()}\n\n'
            f'### 같이 본 상태\n'
            f'- Render Memory peak: {mem_st["max"]:.1f}MB / {RENDER_MEM_LIMIT_MB:.0f}MB\n'
            f'- Aiven CPU max: {aiven_cpu["max"]:.1f}% (h)\n'
            f'- Aiven Memory max: {aiven_mem["max"]:.1f}%\n'
        )
        if SERVICES[service]['has_bot_logs']:
            # CPU peak 시점 원인 추적: 같은 window 의 봇 활동 (난이도/cfg/장기 search).
            try:
                move_logs = render_search_logs(
                    '[bot] move applied', s_iso, e_iso, limit=200, service=service)
                moves = parse_bot_moves(move_logs)
                body += f'\n### 같은 window 의 봇 활동\n{bot_activity_summary(moves)}\n'
            except Exception as e:
                body += f'\n### 봇 활동 컨텍스트\n- 수집 실패: {e}\n'
        body += (
            f'\n### 다음 조치 후보\n'
            f'- 봇 동시 사용 패턴 점검 (Render 로그)\n'
            f'- Hobby plan ($7/월) 검토\n'
        )
        alerts.append((
            alert_key_for('render_cpu_high', service),
            _title(service, f'[monitor] Render CPU peak {cpu_st["max"]:.1f}m (≥{THRESHOLD_RENDER_CPU_M:.0f}m)'),
            body,
        ))

    # ---- Deploy 비정상 (공통)
    if deploy and deploy['status'] not in (
        'live', 'pre_deploy_in_progress', 'build_in_progress', 'update_in_progress',
    ):
        alerts.append((
            alert_key_for('deploy_bad', service),
            _title(service, f'[monitor] Render 배포 상태 비정상: {deploy["status"]}'),
            f'## Render 배포 비정상 — {service}\n\n'
            f'- 상태: **{deploy["status"]}**\n- 시각: {deploy["createdAt"]}\n'
            f'- 커밋: {deploy["commit"]}\n',
        ))

    # ---- 서버 OOM / crash / slow recovery (공통 — 인프라 이벤트 기반)
    if raw['oom_fails']:
        oom_fails = raw['oom_fails']
        samples = '\n'.join(
            f'- `{f["ts"][:19]}` instance={f["instance"][-6:]} evicted={f["evicted"]} oom={f["oom"]}'
            for f in oom_fails[:5])
        alerts.append((
            alert_key_for('server_oom', service),
            _title(service, f'[monitor] 서버 OOM 강제 종료 {len(oom_fails)}건'),
            f'## 서버 OOM (메모리 한도 초과) 감지 — {service}\n\n'
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
            f'- Hobby plan ($7/월, 512MB) 또는 Standard ($25/월, 2GB) 검토\n',
        ))
    if raw['crash_fails']:
        crash_fails = raw['crash_fails']
        samples = '\n'.join(
            f'- `{f["ts"][:19]}` instance={f["instance"][-6:]} nonZeroExit={f["nonZeroExit"]}'
            for f in crash_fails[:5])
        alerts.append((
            alert_key_for('server_crash', service),
            _title(service, f'[monitor] 서버 crash (코드 에러) {len(crash_fails)}건'),
            f'## 서버 crash 감지 (nonZeroExit) — {service}\n\n'
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
            f'- crash loop (짧은 시간 다수) 면 rollback 검토\n',
        ))
    if raw['slow_recoveries']:
        slow_recoveries = raw['slow_recoveries']
        samples = '\n'.join(
            f'- `{r["start_ts"][:19]}` {r["kind"]} — downtime **{r["downtime_s"]:.1f}s** (60s grace 초과)'
            for r in slow_recoveries[:5])
        max_dt = max(r['downtime_s'] for r in slow_recoveries)
        alerts.append((
            alert_key_for('server_slow_recovery', service),
            _title(service, f'[monitor] 서버 downtime {max_dt:.0f}s (> {THRESHOLD_DOWNTIME_S:.0f}s grace)'),
            f'## 서버 downtime 이 grace 60s 초과 — {service}\n\n'
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
            f'- 반복 발생 시 root cause (메모리 / 코드 회귀) 파악\n',
        ))

    # ---- 봇 관련 alert (omok 만 — has_bot_logs)
    if SERVICES[service]['has_bot_logs']:
        wt_logs = raw.get('wt_logs', [])
        nm_logs = raw.get('nm_logs', [])
        retry_logs = raw.get('retry_logs', [])
        skip_logs = raw.get('skip_logs', [])
        retry_parsed = raw.get('retry_parsed', [])
        skip_parsed = raw.get('skip_parsed', [])
        if len(wt_logs) > 0:
            samples = '\n'.join(f'- `{L["timestamp"][:19]}` {L["message"][:140]}' for L in wt_logs[:5])
            alerts.append((
                alert_key_for('worker_timeout', service),
                _title(service, f'[monitor] worker_timeout 발생 {len(wt_logs)}건'),
                f'## 봇 worker_timeout 발생\n\n'
                f'- 카운트: **{len(wt_logs)}건** (최근 15분)\n'
                f'- 임계: > 0 (PR #82+ 0건 유지 베이스)\n\n'
                f'### 샘플\n{samples}\n\n'
                f'self-abort 회귀 의심. 최근 PR 점검 필요.\n',
            ))
        if len(nm_logs) > 0:
            samples = '\n'.join(f'- `{L["timestamp"][:19]}` {L["message"][:140]}' for L in nm_logs[:5])
            alerts.append((
                alert_key_for('no_move', service),
                _title(service, f'[monitor] 봇 no_move {len(nm_logs)}건'),
                f'## 봇이 수를 못 두는 케이스\n\n- 카운트: **{len(nm_logs)}건**\n\n### 샘플\n{samples}\n',
            ))
        if len(retry_logs) >= THRESHOLD_BOT_RETRY_15MIN:
            samples = '\n'.join(f'- `{L["timestamp"][:19]}` {L["message"][:140]}' for L in retry_logs[:5])
            alerts.append((
                alert_key_for('bot_retry_burst', service),
                _title(service, f'[monitor] 봇 schedule RETRY {len(retry_logs)}건 (≥{THRESHOLD_BOT_RETRY_15MIN})'),
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
                f'- Aiven CPU max: {aiven_cpu["max"] if aiven_cpu else "?"}%\n',
            ))
        if len(skip_logs) >= THRESHOLD_BOT_SKIP_15MIN:
            samples = '\n'.join(f'- `{L["timestamp"][:19]}` {L["message"][:140]}' for L in skip_logs[:5])
            alerts.append((
                alert_key_for('bot_skip_burst', service),
                _title(service, f'[monitor] 봇 schedule SKIP {len(skip_logs)}건 (≥{THRESHOLD_BOT_SKIP_15MIN})'),
                f'## 봇 SKIP burst — RETRY 도 못 잡는 끊김 사례\n\n'
                f'- 카운트: **{len(skip_logs)}건** (최근 15분)\n'
                f'- 임계: ≥ {THRESHOLD_BOT_SKIP_15MIN}건\n'
                f'{summarize_bot_logs(skip_parsed)}\n'
                f'- 시각: {NOW.isoformat()}\n\n'
                f'### 의미\n'
                f'SKIP 은 PR #85 이후 거의 발생 X 가 정상. burst 발생 = `bothPlayersOnline` 가드를 RETRY 가 '
                f'우회 못 하는 새 패턴. 코드 회귀 또는 새 끊김 시나리오 의심.\n\n'
                f'### 샘플\n{samples}\n',
            ))

    return alerts


# ============================================================
# Aiven (공유 — omok / 2048 같은 인스턴스 prefix 격리)
# ============================================================
def _build_aiven_alert(aiven_mem):
    if not (aiven_mem and aiven_mem['max'] >= THRESHOLD_AIVEN_MEM_PCT):
        return None
    return (
        'aiven_mem_high',
        f'[monitor] Aiven valkey Memory {aiven_mem["max"]:.1f}% (≥{THRESHOLD_AIVEN_MEM_PCT:.0f}%)',
        f'## Aiven Memory 임계 초과\n\n'
        f'- 측정: **{aiven_mem["max"]:.1f}%** / {AIVEN_MEM_LIMIT_MB:.0f}MB\n'
        f'- 임계: ≥ {THRESHOLD_AIVEN_MEM_PCT:.0f}% — noeviction (100% 시 write 실패)\n'
        f'- 시각: {NOW.isoformat()}\n\n'
        f'### 다음 조치 후보\n'
        f'- 정기 cleanup 검토\n'
        f'- Aiven Startup-4 (4GB / $30월) 검토\n',
    )


# ============================================================
# entry — run_collect
# ============================================================
def run_collect():
    win_end = NOW
    # Window 30분 → 15분 (cron 30분 → 5분 변경에 맞춰 더 세밀하게).
    # 같은 alert 가 evaluation 마다 재발사되지 않게 COOLDOWN_HOURS=2 으로 묶임.
    win_start = NOW - timedelta(minutes=15)
    s_iso = win_start.strftime('%Y-%m-%dT%H:%M:%SZ')
    e_iso = win_end.strftime('%Y-%m-%dT%H:%M:%SZ')

    # service 별 메트릭/이벤트/로그 + stats
    services_snapshot = {}
    services_raw = {}
    for svc_key in SERVICES:
        try:
            snap, raw = _collect_render(svc_key, s_iso, e_iso)
        except Exception as e:
            print(f'  [{svc_key}] render fetch 실패: {e}')
            snap, raw = {}, {}
        try:
            stats = fetch_server_stats(service=svc_key) or {}
        except Exception as e:
            print(f'  [{svc_key}] stats fetch 실패: {e}')
            stats = {}
        services_snapshot[svc_key] = {'render': snap, 'stats': stats}
        services_raw[svc_key] = raw

    # Aiven (공유)
    aiven = aiven_metrics(period='hour')
    aiven_cpu = aiven_stats(aiven, 'cpu_usage')
    aiven_mem = aiven_stats(aiven, 'mem_usage')

    # snapshot — services.{omok,2048} 구조. monitor_summary 의 snap_omok_render /
    # snap_2048_render helper 가 옛 평탄 구조 (`render`) 와 새 구조 둘 다 호환하므로
    # 평탄 사본 불필요. 옛 metrics/*.json 도 자연 expire (7일 트렌드 window).
    snapshot = {
        'ts': NOW.isoformat(),
        'services': services_snapshot,
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
    for svc_key in SERVICES:
        alerts.extend(_build_alerts(
            svc_key, services_snapshot[svc_key]['render'], services_raw[svc_key],
            aiven_cpu, aiven_mem, s_iso, e_iso))
    aiven_alert = _build_aiven_alert(aiven_mem)
    if aiven_alert:
        alerts.append(aiven_alert)

    for key, title, body in alerts:
        if not cooldown_ok(state, key):
            print(f'  alert {key}: cooldown active — skip')
            continue
        # ALERT_LABELS lookup — service suffix 떼고 base_key 로 조회.
        base_key = key.split(':', 1)[0]
        labels = list(ALERT_LABELS.get(base_key, ['monitor', 'severity-high']))
        # service 별 식별 라벨 — base_key:service 형태에서 service 추출
        if ':' in key:
            labels.append(service_label(key.split(':', 1)[1]))
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
