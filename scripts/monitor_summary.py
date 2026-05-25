"""monitor MODE=daily-summary — 매일 09:00 KST cron. 24h+7d 요약 Issue 생성."""
from __future__ import annotations
import os
from collections import defaultdict
from datetime import timedelta

from monitor_config import (
    AIVEN_MEM_LIMIT_MB, DRY_RUN, KST, NOW, RENDER_BW_LIMIT_GB,
    RENDER_CPU_LIMIT_M, RENDER_MEM_LIMIT_MB, THRESHOLD_DOWNTIME_S,
)
from monitor_apis import (
    close_issue, create_issue,
    fetch_daily_bot_moves, fetch_daily_games, fetch_daily_stats,
    fetch_online_series, fetch_server_stats, list_issues_by_label,
    render_events, render_metric,
)
from monitor_data import (
    bot_moves_from_endpoint, bot_perf_stats, bot_stats_by_cfg,
    compute_recovery_times, games_from_endpoint, hourly_bucket_by_ts,
    hourly_online_from_series, human_turn_stats, kst_window,
    load_recent_metrics, load_state, online_series_from_endpoint, parse_deploys,
    parse_iso, parse_server_failures, player_activity,
    render_bw_sum_mb, render_cpu_stats, render_mem_stats,
    save_state, snap_2048_render, snap_aiven, snap_omok_render, to_utc_iso,
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

    # fetch_fail_streak 추적 — collect 와 같은 state.json 공유. 모든 fetch 호출에
    # track_state=state + track_key=... 전달. 호출 직전 streak snapshot 보관 후
    # 호출 끝나면 비교해 "이번 발행 시점 실패한 endpoint" 추출 → 본문에 표시.
    state = load_state()
    prev_streaks = dict(state.get('fetch_fail_streak', {}))

    # 1) Render / Aiven 메트릭
    # Render CPU/Mem 은 KST window 직접 호출 (이미 frozen — window 가 어제 day 한정).
    # Bandwidth 30d 도 window end 를 KST 어제 끝으로 fix (frozen). 옛엔 e_iso 자리에
    # now 가 들어가 발행 시점에 따라 달라졌음 — 이제 e_iso (KST 어제 24:00=UTC 15:00) 까지로 통일.
    cpu = render_metric('cpu', s_iso, e_iso, 300, service='omok')
    mem = render_metric('memory', s_iso, e_iso, 300, service='omok')
    bw_30d_start = to_utc_iso(win_end_kst - timedelta(days=30))
    bw = render_metric('bandwidth', bw_30d_start, e_iso, 300, service='omok')
    cpu_st = render_cpu_stats(cpu) or {}
    mem_st = render_mem_stats(mem) or {}
    bw_30d = render_bw_sum_mb(bw)
    cpu_2048 = render_metric('cpu', s_iso, e_iso, 300, service='2048')
    mem_2048 = render_metric('memory', s_iso, e_iso, 300, service='2048')
    bw_2048 = render_metric('bandwidth', bw_30d_start, e_iso, 300, service='2048')
    cpu_2048_st = render_cpu_stats(cpu_2048) or {}
    mem_2048_st = render_mem_stats(mem_2048) or {}
    bw_2048_30d = render_bw_sum_mb(bw_2048)
    # Aiven 은 공유 (omok / 2048 같은 instance). 어제 day 의 collect snapshot 들 (5분 마다)
    # 에서 집계 — last snapshot 의 avg + max-over-day. 라이브 aiven_metrics('day') 호출 X.
    # 의도: 같은 어제 보고를 여러 번 발행해도 값 동일 (frozen).
    recent = load_recent_metrics(days=7)
    yday_snaps = [
        s for s in recent
        if (s.get('ts') and parse_iso(s['ts']).astimezone(KST).strftime('%Y-%m-%d') == summary_date)
    ]
    def _aiven_from_snaps(snaps, avg_key, max_key):
        """summary_date 의 collect snapshots 에서 frozen aggregate.
        avg = last snapshot 의 avg (가장 어제 day end 시점에 가까움).
        max = day 전체 snapshot 중 cpu_pct_max 의 max (그 날 최고치).
        n = snapshot 수 (참고용)."""
        if not snaps: return {}
        last_avg = None
        for s in reversed(snaps):
            v = (s.get('aiven') or {}).get(avg_key)
            if v is not None: last_avg = v; break
        max_vals = [(s.get('aiven') or {}).get(max_key) for s in snaps]
        max_vals = [v for v in max_vals if v is not None]
        return {
            'avg': last_avg if last_avg is not None else 0,
            'max': max(max_vals) if max_vals else 0,
            'n': len(snaps),
            # p50/p95 는 snapshot 에서 직접 산출 어려움 (각 snapshot 이 24h 롤링) — drop.
            'p50': None, 'p95': None,
        }
    aiven_cpu  = _aiven_from_snaps(yday_snaps, 'cpu_pct_avg', 'cpu_pct_max')
    aiven_mem  = _aiven_from_snaps(yday_snaps, 'mem_pct_avg', 'mem_pct_max')
    aiven_disk = _aiven_from_snaps(yday_snaps, 'disk_pct_avg', 'disk_pct_max')
    aiven_load = _aiven_from_snaps(yday_snaps, 'load_avg',     'load_max')

    # 2) omok server-domain 데이터 — valkey-first endpoint 호출.
    # 모든 server-domain 메트릭 (game_over / bot_moves / 카운터 / SET 크기 / online
    # series) 을 server 의 4종 endpoint 로 가져옴. Render log fetch 는 완전 제거.
    # endpoint 실패 시 monitor_summary 는 해당 영역 0/"-" 로 채우고 진행 (fault
    # tolerance 결정: valkey 장애 시 server fire-and-forget, monitor 그래도 발행).

    # 일별 카운터 + SET 크기 — 단일 endpoint 호출로 모든 종류 카운트 수신.
    daily_omok = fetch_daily_stats(summary_date, service='omok') or {}

    # game_over raw — LIST endpoint. parse_game_over 와 동일 row 포맷으로 normalize.
    auth_games = fetch_daily_games(summary_date, service='omok')
    game_overs = games_from_endpoint(auth_games.get('items') if auth_games else [])

    # bot moves raw — LIST endpoint. parse_bot_moves 동일 row 포맷.
    auth_moves = fetch_daily_bot_moves(summary_date, service='omok')
    bot_moves = bot_moves_from_endpoint(auth_moves.get('items') if auth_moves else [])
    bot_by_cfg = bot_stats_by_cfg(bot_moves)
    bot_moves_by_hour = hourly_bucket_by_ts(bot_moves, 'ts')

    # game_started 는 더 이상 fetch 안 함 — pvp_games + bot_games 카운터로 대체.
    # 시간대별 분포 (games_by_hour) 는 game_overs 에서 ts 기준 bucket.
    # 봇 영향 unique rooms/clients + 카운터 — daily-stats endpoint 응답에서 직접.
    retry_rooms = int(daily_omok.get('bot_retry_rooms') or 0)
    retry_clients = int(daily_omok.get('bot_retry_clients') or 0)
    skip_rooms = int(daily_omok.get('bot_skip_rooms') or 0)
    skip_clients = int(daily_omok.get('bot_skip_clients') or 0)
    hb_count = int(daily_omok.get('heartbeat_terminate') or 0)
    ws_conn_count = int(daily_omok.get('ws_connected') or 0)
    ws_disc_count = int(daily_omok.get('ws_disconnected') or 0)
    wt_count = int(daily_omok.get('worker_timeout') or 0)
    nm_count = int(daily_omok.get('no_move') or 0)
    retry_count_total = int(daily_omok.get('bot_retry') or 0)
    skip_count_total = int(daily_omok.get('bot_skip') or 0)

    # online time-series — server 1분 sampler (epoch_ms ZSET). 윈도우 = KST 어제.
    win_from_ms = int(win_start_kst.timestamp() * 1000)
    win_to_ms = int(win_end_kst.timestamp() * 1000)
    online_resp = fetch_online_series(win_from_ms, win_to_ms, service='omok')
    online_series = online_series_from_endpoint(online_resp.get('items') if online_resp else [])
    online_avg_by_hour, online_peak_by_hour = hourly_online_from_series(online_series)
    # omok 인프라 이벤트 — server_failed (OOM / crash), deploy 등.
    # limit max = 100 (Render API 제약). 200 으로 호출하면 400 "invalid limit:
    # too large" 반환 + render_events 가 HTTPError catch 해서 빈 list 반환 →
    # deploy 횟수 / server_failed / recoveries 가 항상 0 으로 보이는 silent
    # failure 였음.
    events = render_events(s_iso, e_iso, limit=100, service='omok',
                           track_state=state, track_key='events:omok')
    failures = parse_server_failures(events)
    oom_fails = [f for f in failures if f['evicted'] or f['oom']]
    crash_fails = [f for f in failures if not (f['evicted'] or f['oom'])]
    deploy_count = sum(1 for e in events if e.get('event', {}).get('type') == 'deploy_ended')
    # downtime 계산 — crash 의 server_failed → server_available, deploy 의
    # deploy_started → server_available/deploy_ended (둘 중 빠른 쪽).
    recoveries = compute_recovery_times(events)
    # 배포 이력 별도 추출 (시각/소요/commit) — '배포 이력 (24h)' 표 용.
    deploys = parse_deploys(events)

    # 2-b) 2048 server-domain 카운터 — daily-stats endpoint 단일 호출.
    # submit_score / user_created / score_best / ws_connected/disconnected /
    # heartbeat_terminate / active_users 모두 valkey 누적치 수신.
    daily_2048 = fetch_daily_stats(summary_date, service='2048') or {}
    # 2048 online series — server 1분 sampler.
    online_resp_2048 = fetch_online_series(win_from_ms, win_to_ms, service='2048')
    online_series_2048 = online_series_from_endpoint(online_resp_2048.get('items') if online_resp_2048 else [])
    online_2048_avg_by_hour, online_2048_peak_by_hour = hourly_online_from_series(online_series_2048)
    # 2048 카운터 — daily-stats endpoint 응답에서 직접.
    submit_count_2048 = int(daily_2048.get('submit_score') or 0)
    user_created_count_2048 = int(daily_2048.get('user_created') or 0)
    score_best_count_2048 = int(daily_2048.get('score_best') or 0)
    hb_count_2048 = int(daily_2048.get('heartbeat_terminate') or 0)
    ws_conn_count_2048 = int(daily_2048.get('ws_connected') or 0)
    ws_disc_count_2048 = int(daily_2048.get('ws_disconnected') or 0)
    # 2048 infra events — Render API 직접 (server domain 아님).
    events_2048 = render_events(s_iso, e_iso, limit=100, service='2048',
                                track_state=state, track_key='events:2048')
    failures_2048 = parse_server_failures(events_2048)
    deploy_count_2048 = sum(1 for e in events_2048 if e.get('event', {}).get('type') == 'deploy_ended')
    recoveries_2048 = compute_recovery_times(events_2048)
    deploys_2048 = parse_deploys(events_2048)

    # 3) 시간대별 분포 (KST hour bucket) — game_overs 의 ts 기반.
    # online_avg/peak_by_hour 는 위에서 online-series endpoint 로 이미 계산됨.
    games_by_hour = hourly_bucket_by_ts(game_overs, 'ts')
    pvp_game_overs = [g for g in game_overs if g.get('bot') != 'true']
    pvp_games_by_hour = hourly_bucket_by_ts(pvp_game_overs, 'ts')
    # 호환 placeholder — 일부 body 코드가 pvp_games 직접 참조.
    pvp_games = pvp_game_overs

    # 4) 봇 운영 지표 (봇별 승패 + 상대 rating 분포)
    bot_perf = bot_perf_stats(game_overs)
    # 사람 thinking time — game_over 의 humanTurnsMs CSV flatten 후 통계.
    # PVP / 봇 게임 분리 — 봇 상대일 때 사람이 더 신중하거나/덜 신중한 경향 분석 가능.
    human_turn_split = human_turn_stats(game_overs, split_by_bot=True)

    # 5) 사람 활동 (TOP / rating movers + 활성 사용자)
    player_acts = player_activity(game_overs)
    top_active = sorted(player_acts.items(), key=lambda kv: -kv[1]['games'])[:5]
    top_movers_up = sorted([(n, d) for n, d in player_acts.items() if d['delta_sum'] > 0],
                           key=lambda kv: -kv[1]['delta_sum'])[:5]
    top_movers_dn = sorted([(n, d) for n, d in player_acts.items() if d['delta_sum'] < 0],
                           key=lambda kv: kv[1]['delta_sum'])[:5]
    # 활성 사용자 24h — server 의 daily-set:active_users SCARD 가 SoT.
    # game_overs LIST 와 같은 시점에 SADD 됨.
    active_users_24h = int(daily_omok.get('active_users') or 0)

    # 5-b) omok 사람 계정 수 / 티어 분포 / 봇 rating — 모두 daily-stats endpoint 의
    # snapshot 사용 (frozen). 옛엔 server_stats 라이브 호출 → 발행 시점에 따라 값 변동.
    # daily_omok 응답에 total_human_users / tiers / bots 모두 포함 (server statsHandler
    # 가 snapshotDailyMeta 부수효과로 적재 — PR — 발행시점 일관화).
    server_stats = {
        'total_human_users': daily_omok.get('total_human_users'),
        'tiers': daily_omok.get('tiers') or {},
        'bots': daily_omok.get('bots') or {},
    }
    # 2048 stats — total_users / top_all_time / top_daily 어제 마감 snapshot (frozen).
    # 2048 server statsHandler 도 snapshotDailyMeta 적재 함 → daily-stats endpoint 응답에 포함.
    # active_ws (현재 동접) 은 본질적 발행 시점 — 보고에서 제거.
    stats_2048 = {
        'total_users': daily_2048.get('total_users'),
        'top_all_time': daily_2048.get('top_all_time'),
        'top_daily': daily_2048.get('top_daily'),
    }

    # 5-c) 2048 활성 / 일일 / 신규 사용자 — daily-stats endpoint 의 카운터/SET.
    # active_users SET size = unique nick. submit_score / user_created 카운터 직접.
    active_users_2048_count = int(daily_2048.get('active_users') or 0)
    daily_submits_2048 = int(daily_2048.get('submit_score') or 0)
    new_users_2048 = int(daily_2048.get('user_created') or 0)
    # 시간대별 submit 분포 — daily-stats endpoint 가 시간 분포 안 가짐. 7일 trend 표는
    # 일별 단위 합이라 영향 없음. 시간대별 표는 omok 만 사용 (2048 는 본문에 시간대별
    # 표 없음). 추후 필요 시 server 가 hourly bucket Hash 추가 검토.
    submits_2048_by_hour = {}

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

    # daily-stats.json 제거됨 (valkey-first 전환) — 7d trend lookup 은 valkey
    # endpoint 직접 호출. 메모리 dict 는 임시 cache 용도.
    daily_stats = {}

    # Server-domain 카운트 — valkey HINCRBY 누적 (daily_omok endpoint 응답).
    # game_overs / bot_moves LIST 와 daily_omok counter 는 같은 valkey 에서 동기 누적되므로
    # 이론상 항상 일치. 0 이면 그날 실제로 게임 없거나 valkey 장애 (해당 시 fail_streak alert).
    pvp_count = int(daily_omok.get('pvp_games') or 0)
    bot_game_count = int(daily_omok.get('bot_games') or 0)
    bot_total = int(daily_omok.get('total_bot_moves') or 0)
    total_games = pvp_count + bot_game_count
    active_users_authoritative = int(daily_omok.get('active_users') or 0)
    print(f'[daily-stats source=srv] pvp={pvp_count} bot={bot_game_count} moves={bot_total} active={active_users_authoritative}')

    # 발행 당일 (KST 어제) entry — 본문 내 직접 참조 + trend 표 fallback.
    # total_human_users / tiers / bots 는 daily_omok endpoint snapshot 사용 (frozen).
    # 옛엔 collect snapshot 의 services.omok.stats 또는 server_stats 라이브 사용 →
    # 발행 시점 의존이었음. 이제 daily-stats 가 단일 source.
    daily_stats[summary_date] = {
        'pvp_games': pvp_count, 'bot_games': bot_game_count, 'total_bot_moves': bot_total,
        'render_cpu_max_m': cpu_st.get('max') or 0,
        'aiven_mem_max_pct': aiven_mem.get('max') or 0,
        'active_users': active_users_24h,
        'total_human_users': daily_omok.get('total_human_users'),
        'ws_connected': ws_conn_count,
        'ws_disconnected': ws_disc_count,
        'heartbeat_terminate': hb_count,
        'bot_retry': retry_count_total,
        'bot_skip': skip_count_total,
        'worker_timeout': wt_count,
        'no_move': nm_count,
        'hard_d6_pct': (bot_by_cfg.get('hard', {}) or {}).get('d6', {}).get('cfgmax_pct'),
        'hard_d6_n':   (bot_by_cfg.get('hard', {}) or {}).get('d6', {}).get('n'),
        'tiers': daily_omok.get('tiers') or {},
        'r2048_cpu_max_m': cpu_2048_st.get('max') or 0,
        'active_users_2048': int(daily_2048.get('active_users') or 0),
        'daily_submits_2048': daily_submits_2048,
        'new_users_2048': new_users_2048,
        'score_best_count_2048': score_best_count_2048,
        'ws_connected_2048': ws_conn_count_2048,
        'ws_disconnected_2048': ws_disc_count_2048,
        'heartbeat_terminate_2048': hb_count_2048,
        # 2048 snapshot — daily-stats endpoint (statsHandler 부수효과로 적재)
        'total_users_2048': daily_2048.get('total_users'),
        'top_all_time_2048': daily_2048.get('top_all_time'),
        'top_daily_2048': daily_2048.get('top_daily'),
    }

    # 전일 + 7d trend lookup — 모두 valkey /api/daily-stats endpoint 직접 호출.
    # backfill 으로 PR 머지 전 옛 데이터까지 valkey 에 들어와 있어야 정상 출력.
    # endpoint 응답 None → 0 fallback (그 날 데이터 없음).
    # 본문 _delta() 호출용으로 모든 카운터 / snapshot 필드 포함 (key 누락 = Δ 빈 칸).
    def _fetch_day(d_str):
        omok_r = fetch_daily_stats(d_str, service='omok') or {}
        r2048_r = fetch_daily_stats(d_str, service='2048') or {}
        return {
            # omok 카운터
            'pvp_games': int(omok_r.get('pvp_games') or 0),
            'bot_games': int(omok_r.get('bot_games') or 0),
            'total_bot_moves': int(omok_r.get('total_bot_moves') or 0),
            'active_users': int(omok_r.get('active_users') or 0),
            'worker_timeout': int(omok_r.get('worker_timeout') or 0),
            'no_move': int(omok_r.get('no_move') or 0),
            'bot_retry': int(omok_r.get('bot_retry') or 0),
            'bot_skip': int(omok_r.get('bot_skip') or 0),
            'heartbeat_terminate': int(omok_r.get('heartbeat_terminate') or 0),
            'ws_connected': int(omok_r.get('ws_connected') or 0),
            'ws_disconnected': int(omok_r.get('ws_disconnected') or 0),
            # omok snapshot (server statsHandler 부수효과 — daily Hash 누적)
            'total_human_users': omok_r.get('total_human_users'),  # int or None
            'tiers': omok_r.get('tiers'),                          # dict or None
            'hard_d6_pct': omok_r.get('hard_d6_pct'),
            'hard_d6_n': omok_r.get('hard_d6_n'),
            # 2048 카운터
            'active_users_2048': int(r2048_r.get('active_users') or 0),
            'daily_submits_2048': int(r2048_r.get('submit_score') or 0),
            'new_users_2048': int(r2048_r.get('user_created') or 0),
            'score_best_count_2048': int(r2048_r.get('score_best') or 0),
            'ws_connected_2048': int(r2048_r.get('ws_connected') or 0),
            'ws_disconnected_2048': int(r2048_r.get('ws_disconnected') or 0),
            'heartbeat_terminate_2048': int(r2048_r.get('heartbeat_terminate') or 0),
            # 2048 snapshot (statsHandler 부수효과)
            'total_users_2048': r2048_r.get('total_users'),     # int or None
            'top_all_time_2048': r2048_r.get('top_all_time'),   # int or None
            'top_daily_2048': r2048_r.get('top_daily'),         # int or None
        }

    prev_date = (win_start_kst - timedelta(days=1)).strftime('%Y-%m-%d')
    prev_stats = _fetch_day(prev_date)
    # 7일 lookback: summary_date 부터 6일 전까지 → 7개 endpoint 호출.
    all_days = sorted({(win_end_kst - timedelta(days=i)).strftime('%Y-%m-%d') for i in range(1, 8)})
    for d in all_days:
        if d not in daily_stats:
            daily_stats[d] = _fetch_day(d)
    for d in all_days:
        snaps = by_day.get(d, [])
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
    # bot_total / total_games / pvp_count / bot_game_count 는 위 trend 계산 전
    # block 에서 이미 정의 (race condition fix).

    body = []
    body.append(f'## 일일 인프라 요약 — {summary_date} KST (00:00 ~ 익일 00:00)\n')
    body.append(f'_시간 기준: 모두 KST. 측정 window: `{s_iso} ~ {e_iso}` (UTC). '
                f'모든 metric 은 어제 day 마감값 (frozen) — 같은 보고를 여러 번 발행해도 값 동일._\n')

    # 자원 사용율 — 모두 어제 day 마감값.
    body.append('### 자원 사용율 (한도 대비)\n')
    body.append(gauge_table([
        ('Render CPU peak',  cpu_st.get('max') or 0, RENDER_CPU_LIMIT_M, 'm'),
        ('Render Memory peak', mem_st.get('max') or 0, RENDER_MEM_LIMIT_MB, 'MB'),
        ('Render Bandwidth 30d (-30d ~ 어제)', bw_30d / 1024, RENDER_BW_LIMIT_GB, 'GB'),
        ('Aiven CPU max (어제 day)', aiven_cpu.get('max') or 0, 100, '%'),
        ('Aiven Memory max (어제 day)', aiven_mem.get('max') or 0, 100, '%'),
    ]))
    body.append('')

    # Render/Aiven 24h 메트릭
    body.append('### Render 메트릭\n| 항목 | avg | p50 | p95 | max |')
    body.append('|---|---|---|---|---|')
    body.append(f'| CPU (m) | {cpu_st.get("avg",0):.1f} | {cpu_st.get("p50",0):.1f} | {cpu_st.get("p95",0):.1f} | {cpu_st.get("max",0):.1f} |')
    body.append(f'| Memory (MB) | {mem_st.get("avg",0):.1f} | {mem_st.get("p50",0):.1f} | {mem_st.get("p95",0):.1f} | {mem_st.get("max",0):.1f} |')
    body.append(f'| Bandwidth 30d 누적 (-30d ~ 어제) | {bw_30d:.1f}MB (한도 100GB) |  |  |  |')
    body.append('')
    # Aiven valkey 상태 — 3-tier 색 코드 (🟢safe / 🟡warn / 🟠high / 🔴crit / ⚪na).
    # noeviction 정책 + free-1 plan (1GB RAM, disk 0) 기준. max 값으로 상태 판정.
    from monitor_config import (
        THRESHOLD_AIVEN_CPU_PCT_WARN, THRESHOLD_AIVEN_CPU_PCT_HIGH, THRESHOLD_AIVEN_CPU_PCT_CRIT,
        THRESHOLD_AIVEN_MEM_PCT_WARN, THRESHOLD_AIVEN_MEM_PCT_HIGH, THRESHOLD_AIVEN_MEM_PCT_CRIT,
        THRESHOLD_AIVEN_DISK_PCT_WARN, THRESHOLD_AIVEN_DISK_PCT_HIGH, THRESHOLD_AIVEN_DISK_PCT_CRIT,
        THRESHOLD_AIVEN_LOAD_WARN, THRESHOLD_AIVEN_LOAD_HIGH, THRESHOLD_AIVEN_LOAD_CRIT,
    )
    from monitor_data import severity_for
    cpu_max = aiven_cpu.get('max') or 0
    mem_max = aiven_mem.get('max') or 0
    disk_max = aiven_disk.get('max') or 0
    load_max = aiven_load.get('max') or 0
    _, cpu_emo  = severity_for(cpu_max, THRESHOLD_AIVEN_CPU_PCT_WARN, THRESHOLD_AIVEN_CPU_PCT_HIGH, THRESHOLD_AIVEN_CPU_PCT_CRIT)
    _, mem_emo  = severity_for(mem_max, THRESHOLD_AIVEN_MEM_PCT_WARN, THRESHOLD_AIVEN_MEM_PCT_HIGH, THRESHOLD_AIVEN_MEM_PCT_CRIT)
    _, disk_emo = severity_for(disk_max, THRESHOLD_AIVEN_DISK_PCT_WARN, THRESHOLD_AIVEN_DISK_PCT_HIGH, THRESHOLD_AIVEN_DISK_PCT_CRIT)
    _, load_emo = severity_for(load_max, THRESHOLD_AIVEN_LOAD_WARN, THRESHOLD_AIVEN_LOAD_HIGH, THRESHOLD_AIVEN_LOAD_CRIT)
    # max% → 절대값 MB (메모리만, 한도 1024MB 기준).
    mem_max_mb = mem_max * AIVEN_MEM_LIMIT_MB / 100
    body.append(f'### Aiven valkey 메트릭 _(어제 day, frozen — collect snapshot {aiven_cpu.get("n",0)}개 집계)_\n')
    body.append('| 항목 | avg | max | 상태 | 임계 (warn / high / crit) |')
    body.append('|---|---|---|---|---|')
    body.append(
        f'| CPU % | {aiven_cpu.get("avg",0):.2f} | **{cpu_max:.2f}** | {cpu_emo} | '
        f'{THRESHOLD_AIVEN_CPU_PCT_WARN:.0f} / {THRESHOLD_AIVEN_CPU_PCT_HIGH:.0f} / {THRESHOLD_AIVEN_CPU_PCT_CRIT:.0f} |'
    )
    body.append(
        f'| Memory % _({mem_max_mb:.0f}MB / {AIVEN_MEM_LIMIT_MB:.0f}MB)_ | '
        f'{aiven_mem.get("avg",0):.2f} | **{mem_max:.2f}** | {mem_emo} | '
        f'{THRESHOLD_AIVEN_MEM_PCT_WARN:.0f} / {THRESHOLD_AIVEN_MEM_PCT_HIGH:.0f} / {THRESHOLD_AIVEN_MEM_PCT_CRIT:.0f} |'
    )
    body.append(
        f'| Disk % | {aiven_disk.get("avg",0):.3f} | **{disk_max:.3f}** | {disk_emo} | '
        f'{THRESHOLD_AIVEN_DISK_PCT_WARN:.0f} / {THRESHOLD_AIVEN_DISK_PCT_HIGH:.0f} / {THRESHOLD_AIVEN_DISK_PCT_CRIT:.0f} |'
    )
    body.append(
        f'| Load avg | {aiven_load.get("avg",0):.2f} | **{load_max:.2f}** | {load_emo} | '
        f'{THRESHOLD_AIVEN_LOAD_WARN:.1f} / {THRESHOLD_AIVEN_LOAD_HIGH:.1f} / {THRESHOLD_AIVEN_LOAD_CRIT:.1f} |'
    )
    body.append('')
    body.append(
        '_플랜: **free-1** (1024MB node RAM, disk 0, `maxmemory-policy=noeviction`, valkey 내부 cap=299MB)._\n'
        '_Aiven `mem_usage` 는 **node OS RSS 비율** — baseline ~60-70% 정상 (OS + 복제 버퍼 + valkey 오버헤드)._\n'
        '_데이터 자체 부담은 valkey 내부 ~5MB 수준 (299MB cap 의 1.7%). noeviction 으로 인한 write 실패는_\n'
        '_valkey 내부 cap 도달 시 발생 — 본 메트릭으로는 직접 감지 X (향후 INFO MEMORY 직접 조회 후보)._\n'
        '_본 임계는 "OS OOM kill 임박" 관점: WARN 75% / HIGH 85% / CRIT 95%._'
    )
    body.append(f'\n**Aiven 장기 메모리 트렌드**: {aiven_trend_msg}\n')

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
        if total_human_users is not None else '_(daily-stats snapshot 없음 — 그 날 /api/stats 호출 안 됨)_'
    body.append(f'- 어제 마감 사람 계정 수: {user_count_str}')
    body.append(f'- **24h 활성 사용자**: **{active_users_24h}명**{_delta(active_users_24h, "active_users")} (게임 한 판 이상 둔 unique 닉네임)')
    body.append(f'- 총 게임 시작: **{total_games}건** (PVP {pvp_count}{_delta(pvp_count, "pvp_games")} / 봇 {bot_game_count}{_delta(bot_game_count, "bot_games")})')
    body.append(f'- 봇 착수 총 횟수: **{bot_total}건**{_delta(bot_total, "total_bot_moves")}')
    body.append(f'- 새 ws 연결: 대략 **{ws_conn_count}건**{_delta(ws_conn_count, "ws_connected")}\n')

    # 티어 분포 (PR — server /api/stats 의 tiers + 전일 Δ).
    # 발행 시점 snapshot — 0명 티어도 트렌드 일관성 위해 모두 표시 (Master→Iron).
    tiers_now = (server_stats or {}).get('tiers') or {}
    tiers_prev = (prev_stats or {}).get('tiers') or {}
    if tiers_now:
        # Unranked = 10판 미달 (placement) 사람 user. 별도 row, rating 구간 없음.
        TIER_ORDER = ['Master', 'Diamond', 'Platinum', 'Gold', 'Silver', 'Bronze', 'Iron', 'Unranked']
        TIER_RANGE = {
            'Master':   '2100+',
            'Diamond':  '1900~2099',
            'Platinum': '1700~1899',
            'Gold':     '1500~1699',
            'Silver':   '1300~1499',
            'Bronze':   '1100~1299',
            'Iron':     '~1099',
            'Unranked': '10판 미달',
        }
        body.append('### 오목 티어 분포 _(어제 마감, frozen)_\n')
        body.append('| 티어 | rating 구간 | 인원 | 비중 | 전일 Δ |')
        body.append('|---|---|---|---|---|')
        total_now = sum(tiers_now.values()) or 1
        for tier in TIER_ORDER:
            cur = tiers_now.get(tier, 0)
            pct = 100.0 * cur / total_now
            if tiers_prev:
                prev = tiers_prev.get(tier, 0)
                if cur == prev:
                    delta_str = '±0'
                else:
                    delta_str = f'{cur - prev:+d}'
            else:
                delta_str = ''   # 전일 entry 없음 (첫 발행 또는 30일 cutoff 후)
            body.append(f'| {tier} | {TIER_RANGE[tier]} | {cur} | {pct:.1f}% | {delta_str} |')
        # 합계 row (전일 entry 없으면 Δ cell 빈칸)
        sum_now = sum(tiers_now.values())
        if tiers_prev:
            sum_prev = sum(tiers_prev.values())
            sum_delta_cell = '**±0**' if sum_now == sum_prev else f'**{sum_now - sum_prev:+d}**'
        else:
            sum_delta_cell = ''
        body.append(f'| **합계** |  | **{sum_now}** | 100% | {sum_delta_cell} |')
        body.append('\n_각 사용자의 어제 마감 시점 rating 기준. server `/api/daily-stats?date=어제` 의 tiers snapshot. 전일 Δ = 직전 발행 entry 대비._')
        body.append('')

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
            # 봇 rating — daily-stats endpoint 의 bots snapshot (어제 마감 시점, frozen).
            # statsHandler 가 매 /api/stats 호출 시 daily Hash 에 적재 — 그 날 마지막 호출
            # 시점의 봇 rating 이 응답. 옛엔 server_stats 라이브 호출로 발행 시점 의존.
            # fallback: 24h log 의 마지막 (snapshot 없을 때 — 옛 day backfill 미수행 case).
            server_bot = ((server_stats or {}).get('bots') or {}).get(diff) or {}
            bot_rating = server_bot.get('rating') if server_bot.get('rating') is not None else s.get('bot_last_rating')
            bot_delta = s.get('bot_delta_sum', 0)
            if bot_rating is not None:
                rating_col = f'{bot_rating} ({bot_delta:+d})'
            else:
                rating_col = '-'
            body.append(f'| {diff} | {s["total"]} | {s["wins"]}/{s["losses"]}/{s["draws"]} | {wr_str} | {left_total} | {rating_col} | {rating_str} | {stones_str} |')
        body.append('\n_승률 = 봇 승 / 총. 봇 rating = 어제 마감 시점 (daily-stats.bots snapshot, fallback: 24h log 마지막). Δ = 24h 누적 변화 (zero-sum). 상대 rating = 사람 측 분포._')
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

    # 봇 cfg 권장 사항 — 도달율/승률 임계 기반 자동 권장.
    # 도달율 (cfgmax_pct) = 봇이 timeout/topK 한계까지 다 써서 탐색한 비율.
    #   너무 낮으면 (<40%) 한계가 헐거워 자원 낭비 — topK 줄여 탐색 빠르게.
    #   너무 높으면 (>80%) 한계가 꽉 차 미흡한 수 둘 위험 — topK 늘리거나 timeout 줄여 조정.
    # 봇 승률 — 사람 상대 평균. <30% 면 봇 너무 약함, >80% 면 봇 너무 강함 (사람 이탈).
    # 표본 작으면 (cfg n<10, 봇 total<5) skip — noise 로 잘못된 권장 막기.
    bot_recs = []
    for diff in ['easy', 'medium', 'hard']:
        cfgs = bot_by_cfg.get(diff, {}) if bot_by_cfg else {}
        for cfg_key, st in sorted(cfgs.items()):
            n = st.get('n', 0)
            if n < 10: continue
            pct = st.get('cfgmax_pct', 0)
            if pct < 40:
                bot_recs.append(f'- **{diff} {cfg_key}** 도달율 {pct:.1f}% (n={n}) — `topK ↓` 권장 (목표 50%+, 자원 낭비)')
            elif pct > 80:
                bot_recs.append(f'- **{diff} {cfg_key}** 도달율 {pct:.1f}% (n={n}) — `topK ↑` 또는 `timeout ↓` 권장 (한계 도달)')
    if bot_perf:
        for diff in ['easy', 'medium', 'hard']:
            s = bot_perf.get(diff)
            if not s or s.get('total', 0) < 5: continue
            total = s['total']
            wr = 100.0 * s['wins'] / total
            if wr < 30:
                bot_recs.append(f'- **{diff} 봇 승률 {wr:.1f}%** (총 {total}게임) — 봇 강화 권장 (난이도 ↑ / topK ↑ / timeout ↑)')
            elif wr > 80:
                bot_recs.append(f'- **{diff} 봇 승률 {wr:.1f}%** (총 {total}게임) — 봇 약화 권장 (사람 이탈 방지)')
    body.append('### 봇 cfg 권장 사항\n')
    if bot_recs:
        body.extend(bot_recs)
        body.append('\n_임계: 도달율 <40% → topK ↓, >80% → topK ↑. 승률 <30% → 강화, >80% → 약화. 표본 적은 cfg (n<10) / 봇 (total<5) 은 skip._')
    else:
        body.append('- (현재 권장 사항 없음 — 모든 cfg 도달율 40~80% & 봇 승률 30~80% 정상 범위)')
    body.append('')

    # 사람 thinking time — 매 차례 elapsed (ms) 분포. server game_over 로그의
    # humanTurnsMs CSV 를 flatten. 봇 차례는 search timeout 으로 별도 측정 → 제외.
    # PVP vs 봇 게임 분리 — 봇 상대일 때 신중도 차이 분석.
    body.append('### 사람 thinking time (차례 elapsed)\n')
    htsplit = human_turn_split or {}
    rows = []
    for label, key in [('PVP', 'pvp'), ('vs 봇', 'bot')]:
        st = htsplit.get(key)
        if not st: continue
        rows.append((label, st))
    if rows:
        body.append('| 구분 | 차례 수 | 게임 | avg | p50 | p95 | max |')
        body.append('|---|---|---|---|---|---|---|')
        for label, st in rows:
            body.append(
                f'| {label} | {st["n"]} | {st["games"]} | '
                f'{st["avg_ms"]/1000:.1f}s | {st["p50_ms"]/1000:.1f}s | '
                f'{st["p95_ms"]/1000:.1f}s | {st["max_ms"]/1000:.1f}s |'
            )
        body.append('\n_사람 차례에 보낸 실제 시간만 누적 (disconnect 중 paused 시간 제외). 봇 차례는 별도 cfgMax 표 참고._')
    else:
        body.append('- (사람 차례 데이터 없음)')
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
    body.append(f'| **worker_timeout** | **{wt_count}** _(0 유지 베이스, > 0 = 회귀)_ |')
    body.append(f'| search no_move | {nm_count} |')
    # RETRY/SKIP 영향 unique 게임/사용자 — 단순 카운트만으로는 "1-2 게임 집중"
    # vs "다수 사용자 패턴" 구분 어려움. alert 본문 패턴과 같이 노출.
    retry_extra = f' (게임 {retry_rooms}개 / 사용자 {retry_clients}명)' if retry_count_total else ''
    skip_extra = f' (게임 {skip_rooms}개 / 사용자 {skip_clients}명)' if skip_count_total else ''
    body.append(f'| schedule RETRY (봇 wakeup, 정상) | {retry_count_total}{retry_extra} |')
    body.append(f'| schedule SKIP (RETRY 실패) | {skip_count_total}{skip_extra} |')
    body.append(f'| heartbeat_terminate (zombie 정리) | {hb_count} |')
    body.append(f'| **server_failed (전체)** | **{len(failures)}** |')
    body.append(f'| └ OOM (evicted) | {len(oom_fails)} |')
    body.append(f'| └ crash (nonZeroExit) | {len(crash_fails)} |')
    body.append(f'| deploy 횟수 | {deploy_count} |')
    body.append('')

    # 배포 이력 (24h) — deploy_started → deploy_ended 매칭 결과 (오목).
    # 정상 동작이라 alert 대상 아님, 본문 참조 용.
    if deploys:
        body.append('### 배포 이력 (24h, 오목)\n')
        body.append('| 시각 (KST) | 소요 | commit | trigger |')
        body.append('|---|---|---|---|')
        for d in deploys:
            try:
                kst_ts = parse_iso(d['start_ts']).astimezone(KST).strftime('%H:%M:%S')
            except Exception:
                kst_ts = d['start_ts'][:19]
            commit = f'`{d["commit_sha"]}`' if d.get('commit_sha') else '_(none)_'
            flags = d.get('flags') or []
            trigger = ', '.join(flags) if flags else 'auto'
            body.append(f'| {kst_ts} | **{d["duration_s"]:.0f}s** | {commit} | {trigger} |')
        body.append('')

    # 서버 장애 + downtime 상세 (server_failed/deploy_started → server_available 매칭)
    if recoveries:
        body.append('### 서버 장애 / 배포 downtime (24h)\n')
        body.append(f'| 시각 (KST) | 종류 | 인스턴스 | reason | recovery | grace {THRESHOLD_DOWNTIME_S:.0f}s |')
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
                    f'{THRESHOLD_DOWNTIME_S:.0f}s grace 초과 {over_count}건. downtime = '
                    f'`server_failed`→`server_available` (crash) 또는 `deploy_started`→`server_available`/`deploy_ended` (deploy)._')
        body.append('')

    body.append('### 임계 alert 이력 (24h)\n')
    if alert_history:
        for k, ts in alert_history:
            # ts 는 state.json 에 저장된 UTC ISO — 사람 표시는 KST + UTC 병기.
            try:
                kst_str = parse_iso(ts).astimezone(KST).strftime('%Y-%m-%d %H:%M:%S')
                ts_disp = f'{kst_str} KST'
            except Exception:
                ts_disp = ts[:19]
            body.append(f'- `{ts_disp}` — {k}')
    else:
        body.append('- 0건 (모두 임계 미달, 안전)')
    body.append('')

    # 이번 발행 시점 fetch 실패 endpoint — prev_streaks 와 비교해 증가한 것만.
    # silent loss 인지: server endpoint 응답 실패 → 본문 카운트 0 으로 잘못 발행
    # 위험. 별도 경고 섹션으로 visible.
    current_streaks = state.get('fetch_fail_streak', {}) or {}
    new_fails = sorted(k for k, n in current_streaks.items() if n > prev_streaks.get(k, 0))
    if new_fails:
        body.append('### ⚠️ Fetch 실패 endpoint (이번 발행 — silent loss 경고)\n')
        body.append('다음 endpoint 가 fetch 실패 — 위 본문의 관련 카운트가 누락됐을 수 있음:\n')
        for ep in new_fails:
            body.append(f'- `{ep}` (streak 누적 {current_streaks[ep]}회)')
        body.append('\n_연속 fail_streak ≥ 3 회 시 별도 fetch_fail Issue 알림 (collect 5분 cron 에서 처리)._')
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
        ('Render Bandwidth 30d _(발행시점-30d)_', bw_2048_30d / 1024, RENDER_BW_LIMIT_GB, 'GB'),
    ]))
    body.append('')
    body.append('### 2048 Render 메트릭\n| 항목 | avg | p50 | p95 | max |')
    body.append('|---|---|---|---|---|')
    body.append(f'| CPU (m) | {cpu_2048_st.get("avg",0):.1f} | {cpu_2048_st.get("p50",0):.1f} | {cpu_2048_st.get("p95",0):.1f} | {cpu_2048_st.get("max",0):.1f} |')
    body.append(f'| Memory (MB) | {mem_2048_st.get("avg",0):.1f} | {mem_2048_st.get("p50",0):.1f} | {mem_2048_st.get("p95",0):.1f} | {mem_2048_st.get("max",0):.1f} |')
    body.append(f'| Bandwidth 30d 누적 (-30d ~ 어제) | {bw_2048_30d:.1f}MB (한도 100GB) |  |  |  |')
    body.append('')

    # 게임 활동 요약 — 오목 와 동일한 표현. 모두 어제 마감값 (frozen) / Δ = 전일 마감 대비.
    body.append('### 2048 게임 활동 요약\n')
    total_users_2048 = stats_2048.get('total_users')
    top_all = stats_2048.get('top_all_time')
    top_daily_2048 = stats_2048.get('top_daily')
    count_str = f'**{total_users_2048}**{_delta(total_users_2048, "total_users_2048")}' if total_users_2048 is not None else '_(daily-stats snapshot 없음 — 그 날 /api/stats 호출 안 됨)_'
    body.append(f'- 어제 마감 사용자 계정 수: {count_str}')
    body.append(f'- **24h 활성 사용자**: **{active_users_2048_count}명**{_delta(active_users_2048_count, "active_users_2048")} (점수 등록한 unique 닉)')
    body.append(f'- 24h 점수 등록: **{daily_submits_2048}건**{_delta(daily_submits_2048, "daily_submits_2048")}')
    body.append(f'- 24h 신규 사용자: **{new_users_2048}명**{_delta(new_users_2048, "new_users_2048")}')
    body.append(f'- 24h best 갱신 broadcast: **{score_best_count_2048}건**{_delta(score_best_count_2048, "score_best_count_2048")}')
    body.append(f'- 24h 새 ws 연결: 대략 **{ws_conn_count_2048}건**{_delta(ws_conn_count_2048, "ws_connected_2048")}')
    if top_all is not None:
        body.append(f'- 어제 마감 전체 최고 점수: **{top_all}**{_delta(top_all, "top_all_time_2048")}')
    if top_daily_2048 is not None:
        body.append(f'- 어제 best 점수: **{top_daily_2048}**')
    body.append('')

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
    body.append(f'| heartbeat_terminate (zombie 정리) | {hb_count_2048} |')
    body.append(f'| **server_failed (전체)** | **{len(failures_2048)}** |')
    body.append(f'| └ OOM (evicted) | {len(oom_2048)} |')
    body.append(f'| └ crash (nonZeroExit) | {len(crash_2048)} |')
    body.append(f'| deploy 횟수 | {deploy_count_2048} |')
    body.append('')
    if recoveries_2048:
        slow_2048 = [r for r in recoveries_2048 if not r['within_grace']]
        dts = sorted(x['downtime_s'] for x in recoveries_2048)
        body.append(f'- recovery {len(recoveries_2048)}건 (median {dts[len(dts)//2]:.1f}s · max {max(dts):.1f}s · {THRESHOLD_DOWNTIME_S:.0f}s 초과 {len(slow_2048)}건)\n')
    # 배포 이력 (24h, 2048).
    if deploys_2048:
        body.append('### 배포 이력 (24h, 2048)\n')
        body.append('| 시각 (KST) | 소요 | commit | trigger |')
        body.append('|---|---|---|---|')
        for d in deploys_2048:
            try:
                kst_ts = parse_iso(d['start_ts']).astimezone(KST).strftime('%H:%M:%S')
            except Exception:
                kst_ts = d['start_ts'][:19]
            commit = f'`{d["commit_sha"]}`' if d.get('commit_sha') else '_(none)_'
            flags = d.get('flags') or []
            trigger = ', '.join(flags) if flags else 'auto'
            body.append(f'| {kst_ts} | **{d["duration_s"]:.0f}s** | {commit} | {trigger} |')
        body.append('')
    body.append('')

    # 7일 trend — omok / 2048 분리. PVP/봇/활성 컬럼은 daily-stats.json 누적이 어제
    # workflow fix 머지 이전엔 push 안 됐던 버그로 빈 칸이 많음 — fix 이후 채워짐.
    body.append('### 7일 트렌드 (오목)\n')
    if len(trend_days) >= 2:
        body.append('| 날짜 | CPU max | Aiven Mem | PVP | 봇 | 봇 비율 | 활성 | 계정 | worker_timeout | hard d6 도달% |')
        body.append('|---|---|---|---|---|---|---|---|---|---|')
        for d in trend_days:
            cpu_v = f'{d["omok_cpu_max_m"]:.1f}m' if d['omok_cpu_max_m'] is not None else '-'
            mem_v = f'{d["aiven_mem_max_pct"]:.2f}%' if d['aiven_mem_max_pct'] is not None else '-'
            pvp_v = str(d['pvp_games']) if d['pvp_games'] is not None else '-'
            bot_v = str(d['bot_games']) if d['bot_games'] is not None else '-'
            # 봇 비율 — bot / (pvp + bot). 사용자 행동 추세 (봇 의존도 ↑↓).
            pvp_n = d.get('pvp_games') or 0
            bot_n = d.get('bot_games') or 0
            total_games = pvp_n + bot_n
            if total_games > 0:
                bot_pct_v = f'{100.0 * bot_n / total_games:.1f}%'
            else:
                bot_pct_v = '-'
            active_v = str(d['active_users']) if d.get('active_users') is not None else '-'
            total_v = str(d['total_users']) if d.get('total_users') is not None else '-'
            wt_v = str(d['worker_timeout']) if d.get('worker_timeout') is not None else '-'
            # hard d6 표본 수 같이 (n=X) — 표본 적으면 신뢰도 낮으니 같이 표시
            if d.get('hard_d6_pct') is not None:
                n = d.get('hard_d6_n') or 0
                d6_v = f'{d["hard_d6_pct"]:.1f}% (n={n})'
            else:
                d6_v = '-'
            body.append(f'| {d["date"]} | {cpu_v} | {mem_v} | {pvp_v} | {bot_v} | {bot_pct_v} | {active_v} | {total_v} | {wt_v} | {d6_v} |')
        body.append('\n_활성 = 그 날 game_over 의 unique 사람 닉. 계정 = `/api/stats` total_human_users. 봇 비율 = bot / (PVP + bot). worker_timeout = 그 날 모든 5분 snapshot 의 카운트 합산. hard d6 도달% = 그 날 hard 봇 d6 cfg search 중 reached=d6 비율 (목표: 50%+)._')
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

    # daily-stats.json 저장 제거 — valkey 가 단일 source. 메모리 dict (daily_stats) 는
    # 본문/trend 계산 중 in-process cache 로만 사용, 파일 시스템 영속화 안 함.

    # fetch_fail_streak 추적 결과 state.json 에 저장 — collect 의 fail_streak alert
    # 정책과 통합. daily 발행 시 streak +1, 정상 fetch 면 reset.
    if not DRY_RUN or os.environ.get('SAVE_METRICS') == '1':
        save_state(state)

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
