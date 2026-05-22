"""monitor MODE=daily-summary — 매일 09:00 KST cron. 24h+7d 요약 Issue 생성."""
from __future__ import annotations
import os
from collections import defaultdict
from datetime import timedelta, timezone

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
    hourly_bucket_by_ts, load_daily_stats, load_recent_metrics, load_state,
    parse_bot_moves, parse_game_over, parse_game_started, parse_iso,
    parse_online_count_series, parse_server_failures, player_activity,
    render_bw_sum_mb, render_cpu_stats, render_mem_stats, save_daily_stats,
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
    # 시간 윈도우 — KST 어제 00:00 ~ 오늘 00:00 (캘린더 day)
    kst_today_00 = NOW.astimezone(KST).replace(hour=0, minute=0, second=0, microsecond=0)
    win_end_kst = kst_today_00
    win_start_kst = kst_today_00 - timedelta(days=1)
    win_end_utc = win_end_kst.astimezone(timezone.utc)
    win_start_utc = win_start_kst.astimezone(timezone.utc)
    s_iso = win_start_utc.strftime('%Y-%m-%dT%H:%M:%SZ')
    e_iso = win_end_utc.strftime('%Y-%m-%dT%H:%M:%SZ')
    summary_date = win_start_kst.strftime('%Y-%m-%d')   # 어제 KST 날짜
    print(f'=== daily-summary {summary_date} KST (window {s_iso} ~ {e_iso}) ===')

    # 1) Render / Aiven 메트릭 (24h KST 캘린더 day)
    cpu = render_metric('cpu', s_iso, e_iso, 300)
    mem = render_metric('memory', s_iso, e_iso, 300)
    bw_30d_start = (win_end_utc - timedelta(days=30)).strftime('%Y-%m-%dT%H:%M:%SZ')
    bw = render_metric('bandwidth', bw_30d_start, e_iso, 300)
    cpu_st = render_cpu_stats(cpu) or {}
    mem_st = render_mem_stats(mem) or {}
    bw_30d = render_bw_sum_mb(bw)
    aiven = aiven_metrics(period='day')
    aiven_cpu = aiven_stats(aiven, 'cpu_usage') or {}
    aiven_mem = aiven_stats(aiven, 'mem_usage') or {}
    aiven_disk = aiven_stats(aiven, 'disk_usage') or {}
    aiven_load = aiven_stats(aiven, 'load_average') or {}

    # 2) 로그 fetch
    bot_logs = render_search_logs('move applied', s_iso, e_iso, limit=100, max_pages=10)
    bot_moves = parse_bot_moves(bot_logs)
    bot_by_cfg = bot_stats_by_cfg(bot_moves)
    bot_moves_by_hour = hourly_bucket_by_ts(bot_moves, 'ts')
    game_started_raw = render_search_logs('game_started', s_iso, e_iso, limit=100, max_pages=5)
    game_started = parse_game_started(game_started_raw)
    game_over_raw = render_search_logs('game_over', s_iso, e_iso, limit=100, max_pages=5)
    game_overs = parse_game_over(game_over_raw)
    skip_logs = render_search_logs('schedule SKIP', s_iso, e_iso, limit=50)
    retry_logs = render_search_logs('schedule RETRY', s_iso, e_iso, limit=100, max_pages=3)
    hb_logs = render_search_logs('heartbeat_terminate', s_iso, e_iso, limit=100, max_pages=2)
    ws_conn_logs = render_search_logs('ws_connected', s_iso, e_iso, limit=100, max_pages=10)
    ws_disc_logs = render_search_logs('ws_disconnected', s_iso, e_iso, limit=100, max_pages=10)
    # 인프라 이벤트 — server_failed (OOM / crash), deploy 등
    events = render_events(s_iso, e_iso, limit=200)
    failures = parse_server_failures(events)
    oom_fails = [f for f in failures if f['evicted'] or f['oom']]
    crash_fails = [f for f in failures if not (f['evicted'] or f['oom'])]
    deploy_count = sum(1 for e in events if e.get('event', {}).get('type') == 'deploy_ended')
    # downtime 계산 (PR #97) — server_failed/deploy_started → server_available 매칭
    recoveries = compute_recovery_times(events)

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
    server_stats = fetch_server_stats()

    # 6) reason 카운트
    reason_counts = defaultdict(int)
    for g in game_overs:
        r = g.get('reason', '')
        if r: reason_counts[r] += 1

    # 7) alert 이력 (state.json 의 24h 안 last_alert 시각)
    state = load_state()
    alert_history = []
    for k, ts in state.get('last_alert', {}).items():
        try:
            dt = parse_iso(ts)
            if dt >= win_start_utc and dt < win_end_utc:
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
    # snapshot 만 있는 날 + daily_stats 만 있는 날 모두 표시 (union).
    # Cutoff: summary_date (= 어제 KST) 까지만 포함. 발행 당일 부분 snapshot 제외.
    all_days = sorted(set(by_day.keys()) | set(daily_stats.keys()))
    all_days = [d for d in all_days if d <= summary_date]
    all_days = all_days[-7:]
    for d in all_days:
        snaps = by_day.get(d, [])
        cpu_maxes = [s.get('render', {}).get('cpu_peak_m') for s in snaps if s.get('render', {}).get('cpu_peak_m') is not None]
        mem_maxes = [s.get('aiven', {}).get('mem_pct_max') for s in snaps if s.get('aiven', {}).get('mem_pct_max') is not None]
        ds = daily_stats.get(d, {})
        trend_days.append({
            'date': d,
            'render_cpu_max_m': max(cpu_maxes) if cpu_maxes else None,
            'aiven_mem_max_pct': max(mem_maxes) if mem_maxes else None,
            'pvp_games': ds.get('pvp_games'),
            'bot_games': ds.get('bot_games'),
            'active_users': ds.get('active_users'),
            'total_users': ds.get('total_human_users'),
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

    # 게임 활동 요약 — 계정 수 / 활성 사용자 포함
    body.append('### 게임 활동 요약\n')
    total_human_users = server_stats.get('total_human_users') if server_stats else None
    user_count_str = f'**{total_human_users}**' if total_human_users is not None else '_(server /api/stats 응답 없음 — cold-start 가능성)_'
    body.append(f'- 현재 사람 계정 수: {user_count_str}')
    body.append(f'- **24h 활성 사용자**: **{active_users_24h}명** (게임 한 판 이상 둔 unique 닉네임)')
    body.append(f'- 총 게임 시작: **{total_games}건** (PVP {pvp_count} / 봇 {bot_game_count})')
    body.append(f'- 봇 착수 총 횟수: **{bot_total}건**')
    body.append(f'- 새 ws 연결: 대략 **{len(ws_conn_logs)}건**\n')

    # 봇 운영 지표 (핵심)
    body.append('### 봇 운영 지표 (난이도 별)\n')
    if bot_perf:
        body.append('| 난이도 | 총 | 봇 승 | 봇 패 | 무 | 이탈/포기 | 상대 rating avg/min/max | 평균 게임 길이 (수) |')
        body.append('|---|---|---|---|---|---|---|---|')
        for diff in ['easy', 'medium', 'hard']:
            s = bot_perf.get(diff)
            if not s: continue
            ratings = s['opp_ratings']
            rating_str = f'{sum(ratings)/len(ratings):.0f} / {min(ratings)} / {max(ratings)}' if ratings else '-'
            stones = s['stones_list']
            stones_str = f'{sum(stones)/len(stones):.1f}' if stones else '-'
            left_total = s['left'] + s['abandoned']
            body.append(f'| {diff} | {s["total"]} | {s["wins"]} | {s["losses"]} | {s["draws"]} | {left_total} | {rating_str} | {stones_str} |')
        body.append('\n_상대 rating avg/min/max — 해당 봇과 대국한 사람 측 rating 분포. 봇 난이도가 유저 풀에 맞는지 판단._')
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

    # 안정성 / 임계 이력
    body.append('### 안정성 지표\n')
    body.append('| 항목 | 카운트 |')
    body.append('|---|---|')
    body.append(f'| game_over (전체) | {len(game_overs)} |')
    for r, c in sorted(reason_counts.items(), key=lambda x: -x[1]):
        body.append(f'| └ reason={r} | {c} |')
    body.append(f'| schedule RETRY (봇 wakeup, 정상) | {len(retry_logs)} |')
    body.append(f'| schedule SKIP (RETRY 실패) | {len(skip_logs)} |')
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

    # 7일 trend (CPU/Memory + PVP 게임 수 + 활성/총 사용자)
    body.append('### 7일 트렌드\n')
    if len(trend_days) >= 2:
        body.append('| 날짜 | Render CPU max | Aiven Mem max | PVP 게임 | 봇 게임 | 활성 사용자 | 총 계정 |')
        body.append('|---|---|---|---|---|---|---|')
        for d in trend_days:
            cpu_v = f'{d["render_cpu_max_m"]:.1f}m' if d['render_cpu_max_m'] is not None else '-'
            mem_v = f'{d["aiven_mem_max_pct"]:.2f}%' if d['aiven_mem_max_pct'] is not None else '-'
            pvp_v = str(d['pvp_games']) if d['pvp_games'] is not None else '-'
            bot_v = str(d['bot_games']) if d['bot_games'] is not None else '-'
            active_v = str(d['active_users']) if d.get('active_users') is not None else '-'
            total_v = str(d['total_users']) if d.get('total_users') is not None else '-'
            body.append(f'| {d["date"]} | {cpu_v} | {mem_v} | {pvp_v} | {bot_v} | {active_v} | {total_v} |')
        body.append('\n_활성 사용자 = 그 날 게임 한 판 이상 둔 unique 닉네임 (game_over 로그 기반). 총 계정 = `/api/stats` 가 그 날 daily-summary 발행 시 server 에서 가져온 사람 계정 수._')
    else:
        body.append('- 데이터 부족 (수집 시작 직후)')
    body.append('')

    body.append('---')
    body.append(f'_생성: {NOW.isoformat()} (workflow: monitor-infra, KST {NOW.astimezone(KST).strftime("%Y-%m-%d %H:%M")})_')

    body_text = '\n'.join(body)
    print(f'본문 길이: {len(body_text)} chars')

    # 일별 stats 저장 (7일 trend 누적용)
    if not DRY_RUN or os.environ.get('SAVE_METRICS') == '1':
        daily_stats[summary_date] = {
            'pvp_games': pvp_count,
            'bot_games': bot_game_count,
            'total_bot_moves': bot_total,
            'render_cpu_max_m': cpu_st.get('max') or 0,
            'aiven_mem_max_pct': aiven_mem.get('max') or 0,
            # PR #95 — 활성/총 사용자 trend 누적
            'active_users': active_users_24h,
            'total_human_users': (server_stats or {}).get('total_human_users'),
        }
        # 30일 이상 오래된 entry 정리
        cutoff = (kst_today_00 - timedelta(days=30)).strftime('%Y-%m-%d')
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
