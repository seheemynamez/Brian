"""monitor MODE=daily-summary — 매일 09:00 KST cron. 24h+7d 요약 Issue 생성."""
from __future__ import annotations
import os
from collections import defaultdict
from datetime import timedelta

from monitor_config import (
    AIVEN_MEM_LIMIT_MB, DRY_RUN, KST, NOW, RENDER_BW_LIMIT_GB,
    RENDER_CPU_LIMIT_M, RENDER_MEM_LIMIT_MB,
)
from monitor_apis import (
    aiven_metrics, close_issue, create_issue, fetch_server_stats,
    list_issues_by_label, render_events, render_metric, render_search_logs,
)
from monitor_data import (
    aiven_stats, bot_perf_stats, bot_stats_by_cfg, compute_recovery_times,
    hourly_bucket_by_ts, kst_window, load_daily_stats, load_recent_metrics,
    load_state, parse_bot_logs, parse_bot_moves, parse_game_over,
    parse_game_started, parse_iso, parse_online_count_series,
    parse_server_failures, player_activity, render_bw_sum_mb, render_cpu_stats,
    render_mem_stats, save_daily_stats, snap_2048_render, snap_aiven,
    snap_omok_render, to_utc_iso,
)


# ============================================================
# Markdown 차트 — daily-summary 본문 표시용
# ============================================================
def gauge_table(rows):
    """rows = [(name, current, limit, unit)] → '자원 한도 대비 % bar' 표."""
    out = ['| 자원 | 현재 | 한도 | 사용율 | bar |',
           '|---|---|---|---|---|']
    for name, cur, lim, unit in rows:
        if lim > 0:
            pct = 100 * cur / lim
            n = int(pct / 10)
            bar = '█' * n + '░' * (10 - n)
        else:
            pct = 0
            bar = '░' * 10
        out.append(f'| {name} | {cur:.1f}{unit} | {lim:.0f}{unit} | {pct:.1f}% | `{bar}` |')
    return '\n'.join(out)


# ============================================================
# run_daily_summary
# ============================================================
def run_daily_summary():
    # 시간 윈도우 — KST 어제 00:00 ~ 오늘 00:00 (캘린더 day). kst_window helper
    # 로 통일 — 모든 day 단위 집계의 단일 진입점.
    win_start_kst, win_end_kst = kst_window(days=1)
    s_iso = to_utc_iso(win_start_kst)
    e_iso = to_utc_iso(win_end_kst)
    summary_date = win_start_kst.strftime('%Y-%m-%d')   # 어제 KST 날짜
    print(f'=== daily-summary {summary_date} KST (window {s_iso} ~ {e_iso}) ===')

    # 1) Render / Aiven 메트릭 (24h KST 캘린더 day)
    # omok render
    cpu = render_metric('cpu', s_iso, e_iso, 300, service='omok')
    mem = render_metric('memory', s_iso, e_iso, 300, service='omok')
    bw_30d_start = to_utc_iso(win_end_kst - timedelta(days=30))
    bw = render_metric('bandwidth', bw_30d_start, e_iso, 300, service='omok')
    cpu_st = render_cpu_stats(cpu) or {}
    mem_st = render_mem_stats(mem) or {}
    bw_30d = render_bw_sum_mb(bw)
    # 2048 render — 별 service.
    cpu_2048 = render_metric('cpu', s_iso, e_iso, 300, service='2048')
    mem_2048 = render_metric('memory', s_iso, e_iso, 300, service='2048')
    bw_2048 = render_metric('bandwidth', bw_30d_start, e_iso, 300, service='2048')
    cpu_2048_st = render_cpu_stats(cpu_2048) or {}
    mem_2048_st = render_mem_stats(mem_2048) or {}
    bw_2048_30d = render_bw_sum_mb(bw_2048)
    # Aiven 은 공유 (omok / 2048 같은 instance, prefix 격리).
    aiven = aiven_metrics(period='day')
    aiven_cpu = aiven_stats(aiven, 'cpu_usage') or {}
    aiven_mem = aiven_stats(aiven, 'mem_usage') or {}
    aiven_disk = aiven_stats(aiven, 'disk_usage') or {}
    aiven_load = aiven_stats(aiven, 'load_average') or {}

    # 2) omok 로그 fetch
    bot_logs = render_search_logs('move applied', s_iso, e_iso, limit=100, max_pages=10, service='omok')
    bot_moves = parse_bot_moves(bot_logs)
    bot_by_cfg = bot_stats_by_cfg(bot_moves)
    bot_moves_by_hour = hourly_bucket_by_ts(bot_moves, 'ts')
    game_started_raw = render_search_logs('game_started', s_iso, e_iso, limit=100, max_pages=5, service='omok')
    game_started = parse_game_started(game_started_raw)
    game_over_raw = render_search_logs('game_over', s_iso, e_iso, limit=100, max_pages=5, service='omok')
    game_overs = parse_game_over(game_over_raw)
    skip_logs = render_search_logs('schedule SKIP', s_iso, e_iso, limit=50, service='omok')
    retry_logs = render_search_logs('schedule RETRY', s_iso, e_iso, limit=100, max_pages=3, service='omok')
    # 영향 unique rooms/clients — alert 본문에는 있지만 daily-summary 표엔 단순
    # 카운트만 있었음. burst 가 1-2 게임 집중 vs 다수 사용자 패턴인지 판단용.
    retry_parsed = parse_bot_logs(retry_logs)
    skip_parsed = parse_bot_logs(skip_logs)
    retry_rooms = len({p['room'] for p in retry_parsed})
    retry_clients = len({p['client'] for p in retry_parsed if p['client']})
    skip_rooms = len({p['room'] for p in skip_parsed})
    skip_clients = len({p['client'] for p in skip_parsed if p['client']})
    hb_logs = render_search_logs('heartbeat_terminate', s_iso, e_iso, limit=100, max_pages=2, service='omok')
    ws_conn_logs = render_search_logs('ws_connected', s_iso, e_iso, limit=100, max_pages=10, service='omok')
    ws_disc_logs = render_search_logs('ws_disconnected', s_iso, e_iso, limit=100, max_pages=10, service='omok')
    # PR #4(d) — worker_timeout / no_move 도 안정성 지표에 표시.
    wt_logs = render_search_logs('worker_timeout', s_iso, e_iso, limit=100, max_pages=5, service='omok')
    nm_logs = render_search_logs('search returned no move', s_iso, e_iso, limit=100, max_pages=2, service='omok')
    # omok 인프라 이벤트 — server_failed (OOM / crash), deploy 등.
    # limit max = 100 (Render API 제약). 200 으로 호출하면 400 "invalid limit:
    # too large" 반환 + render_events 가 HTTPError catch 해서 빈 list 반환 →
    # deploy 횟수 / server_failed / recoveries 가 항상 0 으로 보이는 silent
    # failure 였음.
    events = render_events(s_iso, e_iso, limit=100, service='omok')
    failures = parse_server_failures(events)
    oom_fails = [f for f in failures if f['evicted'] or f['oom']]
    crash_fails = [f for f in failures if not (f['evicted'] or f['oom'])]
    deploy_count = sum(1 for e in events if e.get('event', {}).get('type') == 'deploy_ended')
    # downtime 계산 (PR #97) — server_failed/deploy_started → server_available 매칭
    recoveries = compute_recovery_times(events)

    # 2-b) 2048 로그 fetch — 봇 없는 서비스, 활성/일일/동접 위주.
    submit_logs_2048 = render_search_logs('[submit_score]', s_iso, e_iso, limit=100, max_pages=10, service='2048')
    user_created_logs_2048 = render_search_logs('[user_created]', s_iso, e_iso, limit=100, max_pages=3, service='2048')
    ws_conn_logs_2048 = render_search_logs('[ws_connected]', s_iso, e_iso, limit=100, max_pages=10, service='2048')
    ws_disc_logs_2048 = render_search_logs('[ws_disconnected]', s_iso, e_iso, limit=100, max_pages=10, service='2048')
    hb_logs_2048 = render_search_logs('[heartbeat_terminate]', s_iso, e_iso, limit=100, max_pages=2, service='2048')
    score_best_logs_2048 = render_search_logs('[score_best]', s_iso, e_iso, limit=100, max_pages=5, service='2048')
    events_2048 = render_events(s_iso, e_iso, limit=100, service='2048')
    failures_2048 = parse_server_failures(events_2048)
    deploy_count_2048 = sum(1 for e in events_2048 if e.get('event', {}).get('type') == 'deploy_ended')
    recoveries_2048 = compute_recovery_times(events_2048)

    # 3) 시간대별 분포 (KST hour bucket)
    games_by_hour = hourly_bucket_by_ts(game_started, 'ts')
    pvp_games = [g for g in game_started if g.get('bot') == 'false']
    pvp_games_by_hour = hourly_bucket_by_ts(pvp_games, 'ts')
    online_avg_by_hour, online_peak_by_hour = parse_online_count_series(ws_conn_logs + ws_disc_logs)

    # 4) 봇 운영 지표 (봇별 승패 + 상대 rating 분포)
    bot_perf = bot_perf_stats(game_overs)

    # 5) 사람 활동 (TOP / rating movers + 활성 사용자)
    player_acts = player_activity(game_overs)
    top_active = sorted(player_acts.items(), key=lambda kv: -kv[1]['games'])[:5]
    top_movers_up = sorted([(n, d) for n, d in player_acts.items() if d['delta_sum'] > 0],
                           key=lambda kv: -kv[1]['delta_sum'])[:5]
    top_movers_dn = sorted([(n, d) for n, d in player_acts.items() if d['delta_sum'] < 0],
                           key=lambda kv: kv[1]['delta_sum'])[:5]
    # 활성 사용자 24h — game_over 에 등장한 unique 사람 nickname.
    active_user_nicks = set(player_acts.keys())
    active_users_24h = len(active_user_nicks)

    # 5-b) server /api/stats — 현재 사람 계정 수 (PR #95).
    server_stats = fetch_server_stats(service='omok')
    # 2048 stats — total_users / top_all_time / top_daily / active_ws (PR — 2048 통합).
    stats_2048 = fetch_server_stats(service='2048') or {}

    # 5-c) 2048 활성 / 일일 / 신규 사용자 — submit_score / user_created 로그 파싱.
    from monitor_data import parse_log_fields
    active_nicks_2048 = set()
    daily_submits_2048 = 0
    for L in submit_logs_2048:
        f = parse_log_fields(L.get('message', ''))
        if 'nick' in f:
            active_nicks_2048.add(f['nick'])
            daily_submits_2048 += 1
    new_users_2048 = len(user_created_logs_2048)
    # 시간대별 (KST) — submit_score 이벤트 분포.
    submits_2048_by_hour = hourly_bucket_by_ts(
        [{'ts': L['timestamp']} for L in submit_logs_2048], 'ts')

    # 6) reason 카운트
    reason_counts = defaultdict(int)
    for g in game_overs:
        r = g.get('reason', '')
        if r: reason_counts[r] += 1

    # 7) alert 이력 (state.json 의 24h 안 last_alert 시각). last_alert ts 는 UTC.
    # win_start_kst / win_end_kst 는 tz-aware (KST) — parse_iso 가 UTC 로 반환해도
    # tz-aware 끼리 비교 가능 (자동 변환).
    state = load_state()
    alert_history = []
    for k, ts in state.get('last_alert', {}).items():
        try:
            dt = parse_iso(ts)
            if dt >= win_start_kst and dt < win_end_kst:
                alert_history.append((k, ts))
        except Exception:
            pass

    # 8) 7일 trend — metrics/ snapshot + daily-stats.json
    # Timezone 통일 (issue #95 fix): 모든 day key 는 KST 기준.
    # snapshot ts 는 UTC ISO 라 KST 변환 후 date 추출. daily_stats key 도 KST date.
    recent = load_recent_metrics(days=7)
    trend_days = []
    by_day = defaultdict(list)
    for s in recent:
        ts = s.get('ts', '')
        if not ts: continue
        try:
            d = parse_iso(ts).astimezone(KST).strftime('%Y-%m-%d')
        except Exception:
            continue
        by_day[d].append(s)
    daily_stats = load_daily_stats()
    # PR — (a) 전일 비교: summary_date 직전 날 entry 가져옴. 첫날엔 {} (Δ 표시 안 함).
    prev_date = (win_start_kst - timedelta(days=1)).strftime('%Y-%m-%d')
    prev_stats = daily_stats.get(prev_date, {})
    # snapshot 만 있는 날 + daily_stats 만 있는 날 모두 표시 (union).
    # Cutoff: summary_date (= 어제 KST) 까지만 포함. 발행 당일 부분 snapshot 제외.
    all_days = sorted(set(by_day.keys()) | set(daily_stats.keys()))
    all_days = [d for d in all_days if d <= summary_date]
    all_days = all_days[-7:]
    for d in all_days:
        snaps = by_day.get(d, [])
        # PR — snap helper 사용 (옛/새 구조 모두 호환). 2048 컬럼도 추가.
        omok_renders = [snap_omok_render(s) for s in snaps]
        r2048_renders = [snap_2048_render(s) for s in snaps]
        aivens = [snap_aiven(s) for s in snaps]
        omok_cpu_maxes = [r.get('cpu_peak_m') for r in omok_renders if r.get('cpu_peak_m') is not None]
        r2048_cpu_maxes = [r.get('cpu_peak_m') for r in r2048_renders if r.get('cpu_peak_m') is not None]
        mem_maxes = [a.get('mem_pct_max') for a in aivens if a.get('mem_pct_max') is not None]
        # worker_timeout 누적 — snapshot 별 15분 window 카운트의 일별 합산.
        wt_sums = sum((r.get('worker_timeout_count') or 0) for r in omok_renders)
        ds = daily_stats.get(d, {})
        trend_days.append({
            'date': d,
            'omok_cpu_max_m': max(omok_cpu_maxes) if omok_cpu_maxes else None,
            'r2048_cpu_max_m': max(r2048_cpu_maxes) if r2048_cpu_maxes else None,
            'aiven_mem_max_pct': max(mem_maxes) if mem_maxes else None,
            'pvp_games': ds.get('pvp_games'),
            'bot_games': ds.get('bot_games'),
            'active_users': ds.get('active_users'),
            'total_users': ds.get('total_human_users'),
            # (d) worker_timeout 일별 합산 — daily_stats 누적 우선, 없으면 snapshot 합.
            'worker_timeout': ds.get('worker_timeout', wt_sums if wt_sums > 0 else None),
            # issue #122 (c) — hard/d6 cfgMax 도달율 7일 추세. d6 50% 목표 추적.
            'hard_d6_pct': ds.get('hard_d6_pct'),
            'hard_d6_n': ds.get('hard_d6_n'),
            # 2048
            'active_users_2048': ds.get('active_users_2048'),
            'daily_submits_2048': ds.get('daily_submits_2048'),
        })

    # Aiven memory 장기 추정
    aiven_trend_msg = '(데이터 부족)'
    valid_mem = [(d['date'], d['aiven_mem_max_pct']) for d in trend_days if d['aiven_mem_max_pct'] is not None]
    if len(valid_mem) >= 2:
        first_p = valid_mem[0][1]; last_p = valid_mem[-1][1]
        days_span = max(1, len(valid_mem) - 1)
        per_week_pct = (last_p - first_p) / days_span * 7
        if per_week_pct > 0.01:
            weeks_to_80 = (80 - last_p) / per_week_pct
            aiven_trend_msg = f'주당 {per_week_pct:+.2f}%p — 80% 도달 예상: ~{weeks_to_80:.1f}주 후'
        elif per_week_pct < -0.01:
            aiven_trend_msg = f'주당 {per_week_pct:+.2f}%p (감소 추세) — 안정'
        else:
            aiven_trend_msg = f'주당 {per_week_pct:+.2f}%p (평탄)'

    # ====== Issue 본문 ======
    bot_total = len(bot_moves)
    total_games = len(game_started)
    pvp_count = len(pvp_games)
    bot_game_count = total_games - pvp_count

    body = []
    body.append(f'## 일일 인프라 요약 — {summary_date} KST (00:00 ~ 익일 00:00)\n')
    body.append(f'_시간 기준: 모두 KST. 측정 window: `{s_iso} ~ {e_iso}` (UTC)._\n')

    # 자원 사용율
    body.append('### 자원 사용율 (한도 대비)\n')
    body.append(gauge_table([
        ('Render CPU peak',  cpu_st.get('max') or 0, RENDER_CPU_LIMIT_M, 'm'),
        ('Render Memory peak', mem_st.get('max') or 0, RENDER_MEM_LIMIT_MB, 'MB'),
        ('Render Bandwidth 30d', bw_30d / 1024, RENDER_BW_LIMIT_GB, 'GB'),
        ('Aiven CPU max', aiven_cpu.get('max') or 0, 100, '%'),
        ('Aiven Memory max', aiven_mem.get('max') or 0, 100, '%'),
    ]))
    body.append('')

    # Render/Aiven 24h 메트릭
    body.append('### Render 메트릭\n| 항목 | avg | p50 | p95 | max |')
    body.append('|---|---|---|---|---|')
    body.append(f'| CPU (m) | {cpu_st.get("avg",0):.1f} | {cpu_st.get("p50",0):.1f} | {cpu_st.get("p95",0):.1f} | {cpu_st.get("max",0):.1f} |')
    body.append(f'| Memory (MB) | {mem_st.get("avg",0):.1f} | {mem_st.get("p50",0):.1f} | {mem_st.get("p95",0):.1f} | {mem_st.get("max",0):.1f} |')
    body.append(f'| Bandwidth 30d 누적 | {bw_30d:.1f}MB (한도 100GB) |  |  |  |')
    body.append('')
    body.append('### Aiven valkey 메트릭\n| 항목 | avg | p50 | p95 | max |')
    body.append('|---|---|---|---|---|')
    body.append(f'| CPU % | {aiven_cpu.get("avg",0):.2f} | {aiven_cpu.get("p50",0):.2f} | {aiven_cpu.get("p95",0):.2f} | {aiven_cpu.get("max",0):.2f} |')
    body.append(f'| Memory % | {aiven_mem.get("avg",0):.2f} | {aiven_mem.get("p50",0):.2f} | {aiven_mem.get("p95",0):.2f} | {aiven_mem.get("max",0):.2f} |')
    body.append(f'| Disk % | {aiven_disk.get("avg",0):.3f} | — | — | {aiven_disk.get("max",0):.3f} |')
    body.append(f'| Load avg | {aiven_load.get("avg",0):.2f} | — | {aiven_load.get("p95",0):.2f} | {aiven_load.get("max",0):.2f} |')
    body.append('')
    body.append(f'**Aiven 장기 메모리 트렌드**: {aiven_trend_msg}\n')

    # 게임 활동 요약 — 계정 수 / 활성 사용자 + 전일Δ (PR — 5개 개선 (a))
    body.append('### 게임 활동 요약 (오목)\n')
    def _delta(cur, prev_key):
        """(cur, prev) 비교 Δ markdown. prev 또는 cur 없으면 빈 문자열."""
        if cur is None or not isinstance(cur, (int, float)):
            return ''
        prev = prev_stats.get(prev_key)
        if prev is None or not isinstance(prev, (int, float)):
            return ''
        d = cur - prev
        if d == 0: return ' (±0)'
        return f' (**{d:+d}**)'

    total_human_users = server_stats.get('total_human_users') if server_stats else None
    user_count_str = f'**{total_human_users}**{_delta(total_human_users, "total_human_users") if total_human_users is not None else ""}' \
        if total_human_users is not None else '_(server /api/stats 응답 없음 — cold-start 가능성)_'
    body.append(f'- 현재 사람 계정 수: {user_count_str}')
    body.append(f'- **24h 활성 사용자**: **{active_users_24h}명**{_delta(active_users_24h, "active_users")} (게임 한 판 이상 둔 unique 닉네임)')
    body.append(f'- 총 게임 시작: **{total_games}건** (PVP {pvp_count}{_delta(pvp_count, "pvp_games")} / 봇 {bot_game_count}{_delta(bot_game_count, "bot_games")})')
    body.append(f'- 봇 착수 총 횟수: **{bot_total}건**{_delta(bot_total, "total_bot_moves")}')
    body.append(f'- 새 ws 연결: 대략 **{len(ws_conn_logs)}건**{_delta(len(ws_conn_logs), "ws_connected")}\n')

    # 봇 운영 지표 (핵심) — (b) 승률 + 봇 rating Δ 추가.
    body.append('### 봇 운영 지표 (난이도 별)\n')
    if bot_perf:
        body.append('| 난이도 | 총 | 승/패/무 | 승률 | 이탈/포기 | 봇 rating (Δ24h) | 상대 rating avg/min/max | 평균 길이 (수) |')
        body.append('|---|---|---|---|---|---|---|---|')
        for diff in ['easy', 'medium', 'hard']:
            s = bot_perf.get(diff)
            if not s: continue
            ratings = s['opp_ratings']
            rating_str = f'{sum(ratings)/len(ratings):.0f} / {min(ratings)} / {max(ratings)}' if ratings else '-'
            stones = s['stones_list']
            stones_str = f'{sum(stones)/len(stones):.1f}' if stones else '-'
            left_total = s['left'] + s['abandoned']
            # 승률 — total 에서 이탈/무승부 제외한 결정 게임만 분모로 두는 게 정확. 단순화:
            # 모든 종결을 분모로 (이탈/포기도 보통 봇 승으로 처리되니 합리적).
            wr = (100.0 * s['wins'] / s['total']) if s['total'] else 0
            wr_str = f'{wr:.1f}%'
            # 봇 rating 변화 — bot_delta_sum / last_rating.
            bot_rating = s.get('bot_last_rating')
            bot_delta = s.get('bot_delta_sum', 0)
            if bot_rating is not None:
                rating_col = f'{bot_rating} ({bot_delta:+d})'
            else:
                rating_col = '-'
            body.append(f'| {diff} | {s["total"]} | {s["wins"]}/{s["losses"]}/{s["draws"]} | {wr_str} | {left_total} | {rating_col} | {rating_str} | {stones_str} |')
        body.append('\n_승률 = 봇 승 / 총. 봇 rating Δ = 24h 누적 변화 (zero-sum). 상대 rating = 사람 측 분포._')
    else:
        body.append('- (봇 게임 데이터 없음)')
    body.append('')

    # cfgMax 도달율
    if bot_by_cfg:
        body.append('### cfgMax 도달율 (cfg 별)\n')
        body.append('| 난이도 | cfg | n | avg/p50/p95 elapsed (ms) | cfgMax 도달 |')
        body.append('|---|---|---|---|---|')
        for diff in ['easy', 'medium', 'hard']:
            if diff not in bot_by_cfg: continue
            for cfg_key, st in sorted(bot_by_cfg[diff].items()):
                body.append(f'| {diff} | {cfg_key} | {st["n"]} | {st["avg_elap"]}/{st["p50_elap"]}/{st["p95_elap"]} | **{st["cfgmax_pct"]:.1f}%** |')
        body.append('')

    # 시간대별 활동 (KST hour, 세 종류 통합 표)
    body.append('### 시간대별 활동 (KST hour)\n')
    body.append('| hour | 동접 평균 | 동접 peak | 게임 시작 | 봇 착수 | bar (게임) |')
    body.append('|---|---|---|---|---|---|')
    max_g = max(games_by_hour.values()) if games_by_hour else 1
    for h in range(24):
        avg_o = online_avg_by_hour.get(h, 0)
        peak_o = online_peak_by_hour.get(h, 0)
        g = games_by_hour.get(h, 0)
        bm = bot_moves_by_hour.get(h, 0)
        bar = '█' * int(20 * g / max_g) if max_g > 0 else ''
        body.append(f'| {h:02d}:00 | {avg_o:.1f} | {peak_o} | {g} | {bm} | `{bar}` |')
    body.append('')

    # 사람 활동 TOP / rating movers
    body.append('### TOP 활동 사용자 (24h 게임 수)\n')
    if top_active:
        body.append('| # | nickname | 게임 | W/L/D | rating Δ | 현재 rating |')
        body.append('|---|---|---|---|---|---|')
        for i, (n, d) in enumerate(top_active, 1):
            body.append(f'| {i} | {n} | {d["games"]} | {d["wins"]}/{d["losses"]}/{d["draws"]} | {d["delta_sum"]:+d} | {d["last_rating"]} |')
    else:
        body.append('- (사람 게임 데이터 없음)')
    body.append('')

    body.append('### Rating 상위 변동자 (24h Δ)\n')
    body.append('**↑ 상승 TOP 5**')
    if top_movers_up:
        body.append('| nickname | Δ | 게임 | 현재 rating |')
        body.append('|---|---|---|---|')
        for n, d in top_movers_up:
            body.append(f'| {n} | {d["delta_sum"]:+d} | {d["games"]} | {d["last_rating"]} |')
    else:
        body.append('- 없음')
    body.append('\n**↓ 하락 TOP 5**')
    if top_movers_dn:
        body.append('| nickname | Δ | 게임 | 현재 rating |')
        body.append('|---|---|---|---|')
        for n, d in top_movers_dn:
            body.append(f'| {n} | {d["delta_sum"]:+d} | {d["games"]} | {d["last_rating"]} |')
    else:
        body.append('- 없음')
    body.append('')

    # 안정성 / 임계 이력 — (d) worker_timeout / no_move 추가.
    body.append('### 안정성 지표 (오목)\n')
    body.append('| 항목 | 카운트 |')
    body.append('|---|---|')
    body.append(f'| game_over (전체) | {len(game_overs)} |')
    for r, c in sorted(reason_counts.items(), key=lambda x: -x[1]):
        body.append(f'| └ reason={r} | {c} |')
    body.append(f'| **worker_timeout** | **{len(wt_logs)}** _(0 유지 베이스, > 0 = 회귀)_ |')
    body.append(f'| search no_move | {len(nm_logs)} |')
    # RETRY/SKIP 영향 unique 게임/사용자 — 단순 카운트만으로는 "1-2 게임 집중"
    # vs "다수 사용자 패턴" 구분 어려움. alert 본문 패턴과 같이 노출.
    retry_extra = f' (게임 {retry_rooms}개 / 사용자 {retry_clients}명)' if retry_logs else ''
    skip_extra = f' (게임 {skip_rooms}개 / 사용자 {skip_clients}명)' if skip_logs else ''
    body.append(f'| schedule RETRY (봇 wakeup, 정상) | {len(retry_logs)}{retry_extra} |')
    body.append(f'| schedule SKIP (RETRY 실패) | {len(skip_logs)}{skip_extra} |')
    body.append(f'| heartbeat_terminate (zombie 정리) | {len(hb_logs)} |')
    body.append(f'| **server_failed (전체)** | **{len(failures)}** |')
    body.append(f'| └ OOM (evicted) | {len(oom_fails)} |')
    body.append(f'| └ crash (nonZeroExit) | {len(crash_fails)} |')
    body.append(f'| deploy 횟수 | {deploy_count} |')
    body.append('')

    # 서버 장애 + downtime 상세 (server_failed/deploy_started → server_available 매칭)
    if recoveries:
        body.append('### 서버 장애 / 배포 downtime (24h)\n')
        body.append('| 시각 (KST) | 종류 | 인스턴스 | reason | recovery | grace 60s |')
        body.append('|---|---|---|---|---|---|')
        for r in recoveries[:15]:
            try:
                kst_ts = parse_iso(r['start_ts']).astimezone(KST).strftime('%H:%M:%S')
            except Exception:
                kst_ts = r['start_ts'][:19]
            if r['kind'] == 'deploy':
                reason = 'deploy'
            elif r['evicted'] or r['oom']:
                reason = '**OOM**'
            elif r['nonZeroExit']:
                reason = f'crash (exit={r["nonZeroExit"]})'
            else:
                reason = 'unknown'
            inst = f'…{r["instance"][-6:]}' if r['instance'] else '-'
            grace_ok = '✓ OK' if r['within_grace'] else '⚠️ over'
            body.append(f'| {kst_ts} | {r["kind"]} | {inst} | {reason} | **{r["downtime_s"]:.1f}s** | {grace_ok} |')
        # 통계 요약
        dts = sorted(x['downtime_s'] for x in recoveries)
        med = dts[len(dts)//2]
        p95 = dts[min(len(dts)-1, int(len(dts)*0.95))]
        over_count = sum(1 for x in recoveries if not x['within_grace'])
        body.append(f'\n_n={len(recoveries)} · median={med:.1f}s · p95={p95:.1f}s · max={max(dts):.1f}s · '
                    f'60s grace 초과 {over_count}건. downtime = `server_failed`/`deploy_started` → `server_available` 간격._')
        body.append('')

    body.append('### 임계 alert 이력 (24h)\n')
    if alert_history:
        for k, ts in alert_history:
            body.append(f'- `{ts[:19]}` — {k}')
    else:
        body.append('- 0건 (모두 임계 미달, 안전)')
    body.append('')

    # ============================================================
    # 2048 서비스 섹션 — 인프라 + 게임 활동.
    # ============================================================
    body.append('---\n')
    body.append('## 2048 서비스\n')
    body.append('### 2048 자원 사용율 (한도 대비)\n')
    body.append(gauge_table([
        ('Render CPU peak',  cpu_2048_st.get('max') or 0, RENDER_CPU_LIMIT_M, 'm'),
        ('Render Memory peak', mem_2048_st.get('max') or 0, RENDER_MEM_LIMIT_MB, 'MB'),
        ('Render Bandwidth 30d', bw_2048_30d / 1024, RENDER_BW_LIMIT_GB, 'GB'),
    ]))
    body.append('')
    body.append('### 2048 Render 메트릭\n| 항목 | avg | p50 | p95 | max |')
    body.append('|---|---|---|---|---|')
    body.append(f'| CPU (m) | {cpu_2048_st.get("avg",0):.1f} | {cpu_2048_st.get("p50",0):.1f} | {cpu_2048_st.get("p95",0):.1f} | {cpu_2048_st.get("max",0):.1f} |')
    body.append(f'| Memory (MB) | {mem_2048_st.get("avg",0):.1f} | {mem_2048_st.get("p50",0):.1f} | {mem_2048_st.get("p95",0):.1f} | {mem_2048_st.get("max",0):.1f} |')
    body.append(f'| Bandwidth 30d 누적 | {bw_2048_30d:.1f}MB (한도 100GB) |  |  |  |')
    body.append('')

    body.append('### 2048 게임 활동 요약\n')
    total_users_2048 = stats_2048.get('total_users')
    top_all = stats_2048.get('top_all_time')
    top_daily_2048 = stats_2048.get('top_daily')
    active_ws_2048 = stats_2048.get('active_ws')
    count_str = f'**{total_users_2048}**{_delta(total_users_2048, "total_users_2048")}' if total_users_2048 is not None else '_(stats fetch 실패 — cold-start 가능성)_'
    body.append(f'- 현재 사용자 계정 수: {count_str}')
    body.append(f'- **24h 활성 사용자**: **{len(active_nicks_2048)}명**{_delta(len(active_nicks_2048), "active_users_2048")} (점수 등록한 unique 닉)')
    body.append(f'- 24h 점수 등록: **{daily_submits_2048}건**{_delta(daily_submits_2048, "daily_submits_2048")}')
    body.append(f'- 24h 신규 사용자: **{new_users_2048}명**{_delta(new_users_2048, "new_users_2048")}')
    body.append(f'- 24h 새 ws 연결: 대략 **{len(ws_conn_logs_2048)}건**')
    if active_ws_2048 is not None:
        body.append(f'- 현재 동접 (ws): **{active_ws_2048}명**')
    if top_all is not None:
        body.append(f'- 전체 최고 점수: **{top_all}**')
    if top_daily_2048 is not None:
        body.append(f'- 오늘 최고 점수: **{top_daily_2048}**')
    body.append(f'- 24h best 갱신 broadcast: **{len(score_best_logs_2048)}건**\n')

    # 2048 시간대별 활동
    if submits_2048_by_hour:
        body.append('### 2048 시간대별 활동 (KST hour)\n')
        body.append('| hour | 점수 등록 | bar |')
        body.append('|---|---|---|')
        max_s = max(submits_2048_by_hour.values())
        for h in range(24):
            n = submits_2048_by_hour.get(h, 0)
            bar = '█' * int(20 * n / max_s) if max_s > 0 else ''
            body.append(f'| {h:02d}:00 | {n} | `{bar}` |')
        body.append('')

    # 2048 안정성 지표
    body.append('### 2048 안정성 지표\n')
    body.append('| 항목 | 카운트 |')
    body.append('|---|---|')
    oom_2048 = [f for f in failures_2048 if f['evicted'] or f['oom']]
    crash_2048 = [f for f in failures_2048 if not (f['evicted'] or f['oom'])]
    body.append(f'| heartbeat_terminate (zombie 정리) | {len(hb_logs_2048)} |')
    body.append(f'| **server_failed (전체)** | **{len(failures_2048)}** |')
    body.append(f'| └ OOM (evicted) | {len(oom_2048)} |')
    body.append(f'| └ crash (nonZeroExit) | {len(crash_2048)} |')
    body.append(f'| deploy 횟수 | {deploy_count_2048} |')
    body.append('')
    if recoveries_2048:
        slow_2048 = [r for r in recoveries_2048 if not r['within_grace']]
        dts = sorted(x['downtime_s'] for x in recoveries_2048)
        body.append(f'- recovery {len(recoveries_2048)}건 (median {dts[len(dts)//2]:.1f}s · max {max(dts):.1f}s · 60s 초과 {len(slow_2048)}건)\n')
    body.append('')

    # 7일 trend — omok / 2048 분리. PVP/봇/활성 컬럼은 daily-stats.json 누적이 어제
    # workflow fix 머지 이전엔 push 안 됐던 버그로 빈 칸이 많음 — fix 이후 채워짐.
    body.append('### 7일 트렌드 (오목)\n')
    if len(trend_days) >= 2:
        body.append('| 날짜 | CPU max | Aiven Mem | PVP | 봇 | 활성 | 계정 | worker_timeout | hard d6 도달% |')
        body.append('|---|---|---|---|---|---|---|---|---|')
        for d in trend_days:
            cpu_v = f'{d["omok_cpu_max_m"]:.1f}m' if d['omok_cpu_max_m'] is not None else '-'
            mem_v = f'{d["aiven_mem_max_pct"]:.2f}%' if d['aiven_mem_max_pct'] is not None else '-'
            pvp_v = str(d['pvp_games']) if d['pvp_games'] is not None else '-'
            bot_v = str(d['bot_games']) if d['bot_games'] is not None else '-'
            active_v = str(d['active_users']) if d.get('active_users') is not None else '-'
            total_v = str(d['total_users']) if d.get('total_users') is not None else '-'
            wt_v = str(d['worker_timeout']) if d.get('worker_timeout') is not None else '-'
            # hard d6 표본 수 같이 (n=X) — 표본 적으면 신뢰도 낮으니 같이 표시
            if d.get('hard_d6_pct') is not None:
                n = d.get('hard_d6_n') or 0
                d6_v = f'{d["hard_d6_pct"]:.1f}% (n={n})'
            else:
                d6_v = '-'
            body.append(f'| {d["date"]} | {cpu_v} | {mem_v} | {pvp_v} | {bot_v} | {active_v} | {total_v} | {wt_v} | {d6_v} |')
        body.append('\n_활성 = 그 날 game_over 의 unique 사람 닉. 계정 = `/api/stats` total_human_users. worker_timeout = 그 날 모든 5분 snapshot 의 카운트 합산. hard d6 도달% = 그 날 hard 봇 d6 cfg search 중 reached=d6 비율 (목표: 50%+)._')
    else:
        body.append('- 데이터 부족 (수집 시작 직후)')
    body.append('')

    body.append('### 7일 트렌드 (2048)\n')
    if len(trend_days) >= 2:
        body.append('| 날짜 | CPU max | 활성 사용자 | 일일 submit |')
        body.append('|---|---|---|---|')
        for d in trend_days:
            cpu_v = f'{d["r2048_cpu_max_m"]:.1f}m' if d['r2048_cpu_max_m'] is not None else '-'
            au_v = str(d['active_users_2048']) if d.get('active_users_2048') is not None else '-'
            ds_v = str(d['daily_submits_2048']) if d.get('daily_submits_2048') is not None else '-'
            body.append(f'| {d["date"]} | {cpu_v} | {au_v} | {ds_v} |')
        body.append('\n_활성 = 그 날 `[submit_score]` 의 unique 닉. submit = 모든 등록 (best 갱신 여부 무관)._')
    else:
        body.append('- 데이터 부족')
    body.append('')

    body.append('---')
    body.append(f'_생성: {NOW.isoformat()} (workflow: monitor-infra, KST {NOW.astimezone(KST).strftime("%Y-%m-%d %H:%M")})_')

    body_text = '\n'.join(body)
    print(f'본문 길이: {len(body_text)} chars')

    # 일별 stats 저장 (7일 trend 누적용)
    # PR — workflow fix 와 같이 가야 실제 push 됨 (이전엔 collect 만 commit 해서
    # daily-stats.json 가 절대 push 안 됐던 버그). PR #4(e) 의 7일 트렌드 빈 컬럼
    # 원인.
    if not DRY_RUN or os.environ.get('SAVE_METRICS') == '1':
        daily_stats[summary_date] = {
            # omok
            'pvp_games': pvp_count,
            'bot_games': bot_game_count,
            'total_bot_moves': bot_total,
            'render_cpu_max_m': cpu_st.get('max') or 0,
            'aiven_mem_max_pct': aiven_mem.get('max') or 0,
            'active_users': active_users_24h,
            'total_human_users': (server_stats or {}).get('total_human_users'),
            'ws_connected': len(ws_conn_logs),
            # (d) worker_timeout 일별 누적 — 7일 트렌드에서 회귀 추적.
            'worker_timeout': len(wt_logs),
            'no_move': len(nm_logs),
            # (c) hard/d6 cfgMax 도달율 — issue #122 의 d6 50% 목표 추적.
            'hard_d6_pct': (bot_by_cfg.get('hard', {}) or {}).get('d6', {}).get('cfgmax_pct'),
            'hard_d6_n':   (bot_by_cfg.get('hard', {}) or {}).get('d6', {}).get('n'),
            # 2048
            'r2048_cpu_max_m': cpu_2048_st.get('max') or 0,
            'active_users_2048': len(active_nicks_2048),
            'daily_submits_2048': daily_submits_2048,
            'new_users_2048': new_users_2048,
            'total_users_2048': stats_2048.get('total_users'),
            'top_all_time_2048': stats_2048.get('top_all_time'),
            'top_daily_2048': stats_2048.get('top_daily'),
        }
        # 30일 이상 오래된 entry 정리 (win_end_kst = 오늘 KST 00:00 기준)
        cutoff = (win_end_kst - timedelta(days=30)).strftime('%Y-%m-%d')
        daily_stats = {k: v for k, v in daily_stats.items() if k >= cutoff}
        save_daily_stats(daily_stats)
        print(f'  saved: daily-stats.json ({len(daily_stats)} entries)')

    # 이전 daily-summary close
    prev = list_issues_by_label('daily-summary', state='open')
    print(f'이전 open daily-summary Issue: {len(prev)}개')
    for issue in prev:
        if isinstance(issue, dict) and 'number' in issue:
            close_issue(issue['number'])
            print(f'  closed: #{issue["number"]} {issue.get("title", "")[:60]}')

    # 새 daily-summary Issue
    title = f'[daily-summary] {summary_date} KST 인프라/게임 요약'
    labels = ['monitor', 'daily-summary', 'severity-low']
    url = create_issue(title, body_text, labels)
    print(f'  created: {url}')
