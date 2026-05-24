"""monitor 의 데이터 변환 — 로그/이벤트 파싱, 통계 계산, state.json IO.

순수 함수 + 파일 IO (외부 API 호출 없음). monitor_apis 에서 가져온 raw 데이터
를 가공해서 collect/summary 에 넘김.

Timezone 정책:
  - 외부 API (Render / Aiven) 가 UTC ISO 로 응답 → `parse_iso` 가 그대로 datetime.
  - **이 모듈에서 가공해 반환하는 모든 ts 필드는 KST ISO** (`+09:00`).
    호출자 (collect / summary) 는 KST 일관 사용 가정 가능.
  - 파일 IO / 7일 trend / day key 모두 KST 기준 (`monitor_config.KST_TODAY`).
  - API 호출 직전엔 `to_utc_iso` 로 변환 (API 는 표준 UTC).
"""
from __future__ import annotations
import json
import re
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from monitor_config import (
    COOLDOWN_HOURS, DAILY_STATS_FILE, KST, METRICS_DIR, NOW, STATE_FILE,
    THRESHOLD_DOWNTIME_S,
)

# ============================================================
# ISO 타임스탬프 파싱 + Timezone 변환 helper
# ============================================================
# Python ≤ 3.10 의 `datetime.fromisoformat` 은 fractional seconds 가 정확히
# 6자리 microsecond 여야 함 — 4자리 (`.3819`) 또는 9자리 (ns) 거부.
# Render API 가 둘 다 보낼 수 있어 정규화:
#   - 7+자리 (ns)   → 앞 6자리 truncate
#   - 1~5자리       → 6자리로 0-padding
#   - 6자리 / 없음  → 그대로
# Python 3.11+ 는 모두 받지만 로컬 dev (3.9/3.10) 호환 위해 명시.
_TS_FRAC_RE = re.compile(r'\.(\d+)(?=[+\-Z])')


def _normalize_frac(m):
    frac = m.group(1)
    if len(frac) > 6:
        frac = frac[:6]
    elif len(frac) < 6:
        frac = frac.ljust(6, '0')
    return f'.{frac}'


def parse_iso(ts):
    """ISO ts (UTC or any tz) → tz-aware datetime. 빈 string 은 ValueError.
    fractional seconds 가 4~9자리 모두 호환 (Python 3.9+ 지원)."""
    s = ts.replace('Z', '+00:00')
    s = _TS_FRAC_RE.sub(_normalize_frac, s)
    return datetime.fromisoformat(s)


def parse_iso_kst(ts):
    """ISO ts → KST-aware datetime. parse 실패 시 ValueError 전파."""
    return parse_iso(ts).astimezone(KST)


def to_kst_iso(ts):
    """ISO ts (UTC or any tz) → KST ISO string (`+09:00`).
    빈 string / parse 실패 시 원본 그대로 반환 (graceful — 옛 로그 호환)."""
    if not ts:
        return ''
    try:
        return parse_iso(ts).astimezone(KST).isoformat()
    except Exception:
        return ts


def to_utc_iso(dt):
    """tz-aware datetime → UTC ISO string (`...Z`, Render/Aiven API 입력 표준).
    naive datetime 입력은 UTC 로 가정."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def kst_pretty(ts):
    """사람 가독성용 — `2026-05-24 09:05:14 KST`. alert 본문 / 표 등.
    parse 실패 / 빈 ts → 원본 앞 19글자."""
    if not ts:
        return ''
    try:
        return parse_iso(ts).astimezone(KST).strftime('%Y-%m-%d %H:%M:%S') + ' KST'
    except Exception:
        return ts[:19]


def kst_window(days):
    """KST 기준 캘린더 day window. days=1 → 어제 00:00 ~ 오늘 00:00 (KST).
    반환: (start_kst, end_kst) — 둘 다 KST tz-aware datetime."""
    kst_today_00 = NOW.astimezone(KST).replace(hour=0, minute=0, second=0, microsecond=0)
    return kst_today_00 - timedelta(days=days), kst_today_00


# ============================================================
# state / cooldown
# ============================================================
def load_state():
    if STATE_FILE.exists():
        try: return json.loads(STATE_FILE.read_text())
        except Exception: pass
    return {'last_alert': {}}


def save_state(state):
    METRICS_DIR.mkdir(exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False))


def cooldown_ok(state, alert_key):
    last = state.get('last_alert', {}).get(alert_key)
    if not last: return True
    try:
        last_dt = parse_iso(last)
    except Exception:
        return True
    return NOW > last_dt + timedelta(hours=COOLDOWN_HOURS)


def mark_alerted(state, alert_key):
    state.setdefault('last_alert', {})[alert_key] = NOW.isoformat()


# ============================================================
# fetch fail streak — endpoint 별 연속 fetch 실패 카운트 (state.json).
# transient retry (monitor_apis.RETRY_MAX) 통과해도 실패 시 incr. 성공 시 reset.
# 연속 N 회 도달 시 fetch_fail 알림 발사 (monitor_collect 가 처리).
# ============================================================
def incr_fail_streak(state, endpoint_key):
    """endpoint 의 연속 실패 카운트 +1. 새 카운트 반환."""
    streaks = state.setdefault('fetch_fail_streak', {})
    streaks[endpoint_key] = streaks.get(endpoint_key, 0) + 1
    return streaks[endpoint_key]


def reset_fail_streak(state, endpoint_key):
    """0 으로 reset (이미 0 이면 no-op)."""
    streaks = state.setdefault('fetch_fail_streak', {})
    if streaks.get(endpoint_key, 0) > 0:
        streaks[endpoint_key] = 0


def fail_streaks_over(state, threshold):
    """state 의 fail_streak 중 threshold 이상인 (endpoint, count) 목록."""
    streaks = state.get('fetch_fail_streak', {}) or {}
    return [(ep, n) for ep, n in streaks.items() if n >= threshold]


# ============================================================
# daily-stats / 일별 snapshot IO (7일 trend 용)
# ============================================================
def load_daily_stats():
    if DAILY_STATS_FILE.exists():
        try: return json.loads(DAILY_STATS_FILE.read_text())
        except Exception: pass
    return {}


def save_daily_stats(d):
    METRICS_DIR.mkdir(exist_ok=True)
    DAILY_STATS_FILE.write_text(json.dumps(d, indent=2, ensure_ascii=False))


def load_recent_metrics(days=7):
    """metrics/YYYY-MM-DD.json 최근 N 일 로드. **KST 기준 파일명** (PR — KST 일관화).

    매일 KST 09:00 daily-summary 실행 시점에 NOW = UTC 00:00, KST 09:00.
    KST 어제 (= summary_date) 기준으로 N 일치 파일 로드:
      days=7 → KST 어제 ~ 6일 전 (총 7개 KST day)
    """
    out = []
    kst_today = NOW.astimezone(KST).date()
    for i in range(days):
        d = (kst_today - timedelta(days=i)).strftime('%Y-%m-%d')
        f = METRICS_DIR / f'{d}.json'
        if f.exists():
            try:
                out.extend(json.loads(f.read_text()))
            except Exception:
                pass
    return out


# ============================================================
# Bot RETRY/SKIP log 파싱 — 예:
#   "[bot] schedule RETRY (...): bot=hard stones=5 room=83SN color=white client=A1B2C3D4"
# client= 는 BE 에 추가된 시점부터 등장 — 옛 로그엔 없을 수 있어 graceful 처리.
# ============================================================
_BOT_LOG_RE = re.compile(
    r'bot=(?P<bot>\w+)\s+stones=(?P<stones>\d+)\s+room=(?P<room>\w+)\s+color=(?P<color>\w+)'
    r'(?:\s+client=(?P<client>\S+))?'
)


def parse_bot_logs(logs):
    """RETRY / SKIP 로그 list → [{ts, bot, stones, room, color, client?}].

    client field 가 없는 로그는 client=None — caller 가 graceful 처리.
    """
    out = []
    for L in logs:
        m = _BOT_LOG_RE.search(L.get('message', ''))
        if not m: continue
        out.append({
            'ts':     to_kst_iso(L.get('timestamp', '')),
            'bot':    m.group('bot'),
            'stones': int(m.group('stones')),
            'room':   m.group('room'),
            'color':  m.group('color'),
            'client': m.group('client'),   # None 이면 client= 필드 없는 옛 로그
        })
    return out


def summarize_bot_logs(parsed):
    """parse_bot_logs 결과 → 사람이 읽기 좋은 markdown 요약 (alert body 용)."""
    if not parsed:
        return '- 영향 분포: 파싱 실패 (로그 형식 변경 의심)'
    rooms = sorted({p['room'] for p in parsed})
    clients = sorted({p['client'] for p in parsed if p['client']})
    has_old_logs = any(p['client'] is None for p in parsed)
    rooms_str = f"**{len(rooms)}개 방** (`{', '.join(rooms[:5])}`{'…' if len(rooms) > 5 else ''})"
    if clients:
        clients_str = f"**{len(clients)}명 사용자** (`{', '.join(clients[:5])}`{'…' if len(clients) > 5 else ''})"
    elif has_old_logs:
        clients_str = "사용자 수 미상 (BE 로그에 client= 추가 전의 옛 로그)"
    else:
        clients_str = "사용자 수 추출 실패"
    return f"- 영향 게임: {rooms_str}\n- 영향 사용자: {clients_str}"


# ============================================================
# Server failure / recovery 파싱 — events API 결과 기반
# ============================================================
def parse_deploys(events):
    """deploy_started → deploy_ended 매칭 → 배포 이력.

    deploy 자체는 정상 동작이라 alert 대상 아님. daily-summary 본문의
    `### 배포 이력 (24h)` 표에 시각/소요/commit 표시 용.

    반환: [{start_ts (KST ISO), end_ts (KST ISO), duration_s, commit_msg, instance}]
    """
    by_time = sorted(events, key=lambda e: e.get('event', {}).get('timestamp', ''))
    out = []
    for i, e in enumerate(by_time):
        ev = e.get('event', {})
        if ev.get('type') != 'deploy_started':
            continue
        start_ts = ev.get('timestamp', '')
        try:
            start_dt = parse_iso(start_ts)
        except Exception:
            continue
        # 같은 deploy 의 deploy_ended (start 이후 첫 deploy_ended).
        end_ts = end_dt = None
        for f in by_time[i+1:]:
            fev = f.get('event', {})
            if fev.get('type') != 'deploy_ended':
                continue
            try:
                cand_dt = parse_iso(fev.get('timestamp', ''))
            except Exception:
                continue
            if cand_dt >= start_dt:
                end_ts = fev.get('timestamp', '')
                end_dt = cand_dt
                break
        if not end_dt:
            continue
        det = ev.get('details', {}) or {}
        # Render events API 의 deploy_started details:
        #   { deployId, trigger: { newCommit, deployedByRender, manual, rollback, ... } }
        # commit message 는 events 응답에 없음 — SHA (앞 7자) 만 표시. message 까지
        # 원하면 별도 /deploys/{deployId} 호출 (호출 burst risk 로 일단 생략).
        trigger = det.get('trigger') or {}
        commit_sha = (trigger.get('newCommit') or '')[:7]
        flags = []
        if trigger.get('manual'): flags.append('manual')
        if trigger.get('rollback'): flags.append('rollback')
        if trigger.get('clearCache'): flags.append('clearCache')
        if trigger.get('envUpdated'): flags.append('envUpdated')
        out.append({
            'start_ts': to_kst_iso(start_ts),
            'end_ts': to_kst_iso(end_ts),
            'duration_s': (end_dt - start_dt).total_seconds(),
            'commit_sha': commit_sha,
            'flags': flags,   # ['manual', 'rollback' 등] — 본문에 chip 으로 표시.
            'deploy_id': det.get('deployId', ''),
        })
    return out


def parse_server_failures(events):
    """events → [{ts (KST ISO), instance, evicted, nonZeroExit, oom}]"""
    out = []
    for e in events:
        ev = e.get('event', {})
        if ev.get('type') != 'server_failed': continue
        det = ev.get('details', {})
        reason = det.get('reason', {})
        out.append({
            'ts': to_kst_iso(ev.get('timestamp', '')),
            'instance': det.get('instanceID', ''),
            'evicted': bool(reason.get('evicted')),
            'nonZeroExit': reason.get('nonZeroExit'),
            'oom': bool(reason.get('oom')),
        })
    return out


def compute_recovery_times(events):
    """server_failed / server_available / deploy_started 매칭 → 실제 downtime 계산.

    각 failure 에 대해 그 후 첫 server_available 매칭:
      crash:  server_failed   → 다음 server_available
      deploy: deploy_started  → 다음 server_available 또는 deploy_ended (빠른 쪽)
              Render free plan 의 deploy 는 새 인스턴스로 swap — server_available
              이벤트가 발사 안 되는 경우 있음. 그땐 deploy_ended 가 사실상
              "available again" 의 의미.

    반환: [{kind, start_ts, end_ts, downtime_s, within_grace, evicted,
            nonZeroExit, oom, instance}]
    """
    by_time = sorted(events, key=lambda e: e.get('event', {}).get('timestamp', ''))
    out = []
    for i, e in enumerate(by_time):
        ev = e.get('event', {})
        t = ev.get('type', '')
        if t not in ('server_failed', 'deploy_started'):
            continue
        start_ts = ev.get('timestamp', '')
        try:
            start_dt = parse_iso(start_ts)
        except Exception:
            continue
        # deploy 의 경우 server_available + deploy_ended 둘 다 후보 (빠른 쪽).
        # crash 는 server_available 만.
        end_types = (
            ('server_available', 'deploy_ended') if t == 'deploy_started'
            else ('server_available',)
        )
        end_ts, end_dt = None, None
        for f in by_time[i+1:]:
            fev = f.get('event', {})
            if fev.get('type') not in end_types: continue
            try:
                cand_dt = parse_iso(fev.get('timestamp', ''))
            except Exception:
                continue
            if cand_dt >= start_dt:
                end_ts = fev.get('timestamp', '')
                end_dt = cand_dt
                break
        if not end_dt: continue
        downtime_s = (end_dt - start_dt).total_seconds()
        det = ev.get('details', {}) or {}
        reason = det.get('reason', {}) or {}
        out.append({
            'kind': 'crash' if t == 'server_failed' else 'deploy',
            'start_ts': to_kst_iso(start_ts),
            'end_ts': to_kst_iso(end_ts),
            'downtime_s': downtime_s,
            'within_grace': downtime_s <= THRESHOLD_DOWNTIME_S,
            'evicted': bool(reason.get('evicted')),
            'nonZeroExit': reason.get('nonZeroExit'),
            'oom': bool(reason.get('oom')),
            'instance': det.get('instanceID', ''),
        })
    return out


# ============================================================
# 메트릭 stats (Render / Aiven)
# ============================================================
def extract_values(samples):
    vals = []
    for s in samples:
        for v in s.get('values', []):
            if v.get('value') is not None:
                vals.append(v['value'])
    return vals


def render_cpu_stats(samples):
    vals = extract_values(samples)
    if not vals: return None
    vals_m = [v * 1000 for v in vals]  # core -> millicore
    srt = sorted(vals_m)
    return {
        'avg': sum(vals_m) / len(vals_m),
        'p50': srt[len(srt)//2],
        'p95': srt[int(len(srt)*0.95)] if len(srt) > 1 else srt[0],
        'max': max(vals_m),
        'n': len(vals_m),
    }


def render_mem_stats(samples):
    vals = extract_values(samples)
    if not vals: return None
    MB = 1024 * 1024
    vals_mb = [v / MB for v in vals]
    srt = sorted(vals_mb)
    return {
        'avg': sum(vals_mb) / len(vals_mb),
        'p50': srt[len(srt)//2],
        'p95': srt[int(len(srt)*0.95)] if len(srt) > 1 else srt[0],
        'max': max(vals_mb),
        'n': len(vals_mb),
    }


def render_bw_sum_mb(samples):
    vals = extract_values(samples)
    return sum(vals) if vals else 0


def aiven_stats(metrics_dict, key):
    m = metrics_dict.get('metrics', {}).get(key, {})
    rows = m.get('data', {}).get('rows', [])
    vals = [r[1] for r in rows[1:] if isinstance(r, list) and len(r) >= 2 and r[1] is not None]
    if not vals: return None
    srt = sorted(vals)
    return {
        'avg': sum(vals) / len(vals),
        'p50': srt[len(srt)//2],
        'p95': srt[int(len(srt)*0.95)] if len(srt) > 1 else srt[0],
        'max': max(vals),
        'n': len(vals),
    }


def severity_for(value, warn, high, crit):
    """value 와 (warn, high, crit) 임계 비교 → ('safe'|'warn'|'high'|'crit', emoji).

    value None / 음수 → ('na', '⚪'). 본문 표/alert 의 상태 컬럼에 통일된 표시 위함.
    """
    if value is None or not isinstance(value, (int, float)) or value < 0:
        return ('na', '⚪')
    if value >= crit: return ('crit', '🔴')
    if value >= high: return ('high', '🟠')
    if value >= warn: return ('warn', '🟡')
    return ('safe', '🟢')


# ============================================================
# 봇 move 로그 파싱 (daily-summary 의 cfgMax 분석 용)
# ============================================================
BOT_MOVE_PAT = re.compile(r'bot=(\w+) stones=(\d+) \((\d+)번째 수\) cfg=d(\d+)×t(\d+) reached=d(\d+) elapsed=(\d+)ms')


def parse_bot_moves(logs):
    rows = []
    for L in logs:
        m = BOT_MOVE_PAT.search(L.get('message', ''))
        if m:
            diff, stones, nth, cfgD, cfgT, reach, elap = m.groups()
            rows.append({
                'ts': to_kst_iso(L.get('timestamp', '')),
                'diff': diff, 'stones': int(stones), 'nth': int(nth),
                'cfgD': int(cfgD), 'cfgT': int(cfgT), 'reach': int(reach), 'elap': int(elap),
            })
    return rows


def bot_moves_from_endpoint(items):
    """server /api/daily-bot-moves items → parse_bot_moves 와 동일 row 형식.

    endpoint item 키: ts (UTC ISO), diff, stones, cfgD, cfgTopK, reach, elap, room
    parse_bot_moves 호환: ts (KST ISO), diff, stones, nth, cfgD, cfgT, reach, elap
    """
    rows = []
    for it in items or []:
        if not isinstance(it, dict): continue
        try:
            rows.append({
                'ts': to_kst_iso(it.get('ts', '')),
                'diff': it.get('diff'),
                'stones': int(it.get('stones', 0)),
                'nth': int(it.get('stones', 0)) + 1,
                'cfgD': int(it.get('cfgD', 0)),
                'cfgT': int(it.get('cfgTopK', 0)),
                'reach': int(it.get('reach', 0)),
                'elap': int(it.get('elap', 0)),
            })
        except (TypeError, ValueError):
            continue
    return rows


def bot_stats_by_cfg(moves):
    """cfg 별 cfgMax 도달율 + elapsed 통계."""
    by = defaultdict(lambda: defaultdict(list))
    for r in moves:
        by[r['diff']][r['cfgD']].append(r)
    out = {}
    for diff, by_d in by.items():
        out[diff] = {}
        for cfgD, rs in by_d.items():
            elaps = sorted([r['elap'] for r in rs])
            cfgmax_n = sum(1 for r in rs if r['reach'] == cfgD)
            out[diff][f'd{cfgD}'] = {
                'n': len(rs),
                'avg_elap': sum(elaps) // len(elaps),
                'p50_elap': elaps[len(elaps)//2],
                'p95_elap': elaps[int(len(elaps)*0.95)] if len(elaps) > 1 else elaps[0],
                'cfgmax_pct': round(100 * cfgmax_n / len(rs), 1),
            }
    return out


def human_turn_stats(game_overs, split_by_bot=False):
    """game_over 의 humanTurnsMs CSV → 사람 thinking time 분포 (avg/p50/p95).

    server 가 game_over 로그에 매 차례 elapsed 를 CSV (humanTurnsMs="1234,5678,...")
    로 출력. 봇 차례는 제외 (search timeout 으로 별도 측정).

    split_by_bot=False (default): 전체 game_over 통합 → 단일 dict 반환.
    split_by_bot=True: {'pvp': {...}, 'bot': {...}} 로 봇 게임 vs PVP 분리.
    bot 게임의 사람 (= 봇 상대) 과 PVP 의 사람은 행동 패턴이 다를 수 있어 분리 옵션.
    """
    def _agg(items):
        all_ms = []
        games_with = 0
        for g in items:
            csv = g.get('humanTurnsMs')
            if not csv: continue
            had = False
            for s in csv.split(','):
                try:
                    all_ms.append(int(s))
                    had = True
                except (ValueError, TypeError):
                    continue
            if had: games_with += 1
        if not all_ms: return None
        s = sorted(all_ms)
        n = len(s)
        return {
            'n': n,
            'games': games_with,
            'avg_ms': sum(s) // n,
            'p50_ms': s[n // 2],
            'p95_ms': s[int(n * 0.95)] if n > 1 else s[0],
            'max_ms': s[-1],
        }
    if not split_by_bot:
        return _agg(game_overs)
    pvp = [g for g in game_overs if g.get('bot') != 'true']
    bot = [g for g in game_overs if g.get('bot') == 'true']
    return {'pvp': _agg(pvp), 'bot': _agg(bot)}


# ============================================================
# game_started / game_over 로그 파싱 (PR #86 보강된 필드)
# 새 game_over 로그 형식: key=value pairs (value 가 공백 / "..." 으로 인용)
#   [game_over] code=XXXX gameId=YY winner=black reason=five bot=true botDiff=hard ...
# ============================================================
LOG_FIELD_RE = re.compile(r'(\w+)=("(?:[^"\\]|\\.)*"|\S+)')


def parse_log_fields(message):
    """`[event] k=v k=v` → dict. 값이 따옴표면 unquote."""
    out = {}
    for k, v in LOG_FIELD_RE.findall(message):
        if v.startswith('"') and v.endswith('"'):
            v = v[1:-1].replace('\\"', '"')
        out[k] = v
    return out


def parse_game_over(logs):
    out = []
    for L in logs:
        msg = L.get('message', '')
        if '[game_over]' not in msg:
            continue
        f = parse_log_fields(msg)
        f['ts'] = to_kst_iso(L.get('timestamp', ''))
        out.append(f)
    return out


def games_from_endpoint(items):
    """server /api/daily-games items → parse_game_over 와 동일 row 형식.

    endpoint item 은 gameOverFields(...) 결과 + ts. JSON 자체 타입 (bool, int)
    이라 downstream (bot_perf_stats / human_turn_stats / player_activity) 와
    호환되도록 normalize:
      - bot: bool true/false → str 'true'/'false' (downstream 의 `== 'true'` 비교)
      - rating/delta: 숫자 → 그대로 (downstream 이 int() cast 함)
      - ts: UTC ISO → KST ISO
    """
    out = []
    for it in items or []:
        if not isinstance(it, dict): continue
        d = dict(it)
        # bot bool → 'true'/'false' 문자열
        b = d.get('bot')
        d['bot'] = 'true' if b is True else ('false' if b is False else str(b)) if b is not None else 'false'
        # delta 는 downstream 에서 `.replace('+', '')` 호출. 숫자면 str 로.
        for k in ('blackDelta', 'whiteDelta', 'blackRating', 'whiteRating', 'stones'):
            v = d.get(k)
            if v is not None and not isinstance(v, str):
                d[k] = str(v)
        # ts KST 정규화
        d['ts'] = to_kst_iso(d.get('ts', ''))
        out.append(d)
    return out


def online_series_from_endpoint(items):
    """server /api/online-series items → ts/online 쌍 정렬.

    item: {ts: epoch_ms, count: int}. 호출자는 KST hour bucket 으로 그룹.
    """
    out = []
    for it in items or []:
        if not isinstance(it, dict): continue
        try:
            out.append({'ts_ms': int(it['ts']), 'count': int(it.get('count', 0))})
        except (KeyError, TypeError, ValueError):
            continue
    out.sort(key=lambda x: x['ts_ms'])
    return out


def hourly_online_from_series(series):
    """[{ts_ms, count}] → (avg_by_hour, peak_by_hour) — KST hour 별 dict.

    1분 sample 가정. peak 는 그 시간대 max count. avg 는 mean (sample-weighted).
    """
    from collections import defaultdict
    buckets = defaultdict(list)
    for s in series:
        try:
            dt = datetime.fromtimestamp(s['ts_ms'] / 1000, tz=timezone.utc).astimezone(KST)
            buckets[dt.hour].append(s['count'])
        except Exception:
            continue
    avg = {}
    peak = {}
    for h, vals in buckets.items():
        if vals:
            avg[h] = sum(vals) / len(vals)
            peak[h] = max(vals)
    return avg, peak


def parse_game_started(logs):
    out = []
    for L in logs:
        msg = L.get('message', '')
        if '[game_started]' not in msg:
            continue
        f = parse_log_fields(msg)
        f['ts'] = to_kst_iso(L.get('timestamp', ''))
        out.append(f)
    return out


# ============================================================
# 시간대별 분포 (KST hour bucket)
# ============================================================
def hourly_bucket_by_ts(items, ts_field='ts'):
    """items 의 ts 필드 (UTC ISO) → KST hour (0-23) 카운트."""
    buckets = defaultdict(int)
    for r in items:
        ts = r.get(ts_field, '')
        if not ts: continue
        try:
            dt = parse_iso(ts).astimezone(KST)
            buckets[dt.hour] += 1
        except Exception:
            continue
    return dict(buckets)


def hourly_bot_activity(moves):
    """KST hour bucket 별 봇 착수 횟수."""
    buckets = defaultdict(int)
    for r in moves:
        try:
            dt = parse_iso(r['ts']).astimezone(KST)
            buckets[dt.hour] += 1
        except Exception:
            continue
    return dict(buckets)


def parse_online_count_series(logs):
    """ws_connected / ws_disconnected 로그의 `online=N` 시계열 → KST hour 별 평균/peak."""
    pat = re.compile(r'online=(\d+)')
    series = []
    for L in logs:
        m = pat.search(L.get('message', ''))
        if not m: continue
        try:
            dt = parse_iso(L['timestamp']).astimezone(KST)
            series.append((dt, int(m.group(1))))
        except Exception:
            continue
    series.sort()
    by_hour_avg = {}
    by_hour_peak = {}
    grouped = defaultdict(list)
    for dt, n in series:
        grouped[dt.hour].append(n)
    for h, vals in grouped.items():
        by_hour_avg[h] = sum(vals) / len(vals)
        by_hour_peak[h] = max(vals)
    return by_hour_avg, by_hour_peak


# ============================================================
# 봇 운영 지표 — 봇 별 win/loss + 상대 rating 분포
# ============================================================
def bot_perf_stats(game_overs):
    """game_over (bot=true only) → {difficulty: {wins, losses, draws, abandoned,
                                                  left, opp_nicks, opp_ratings,
                                                  stones_list, total}}"""
    bot_diffs = {}
    for g in game_overs:
        if g.get('bot') != 'true': continue
        diff = g.get('botDiff')
        if not diff: continue
        if diff not in bot_diffs:
            bot_diffs[diff] = {
                'wins': 0, 'losses': 0, 'draws': 0, 'abandoned': 0, 'left': 0,
                'total': 0,
                'opp_nicks': [],
                'opp_ratings': [],
                'stones_list': [],
                # 봇 운영 지표 확장: 봇 측 rating delta 누적 + 마지막 rating.
                'bot_delta_sum': 0,
                'bot_last_rating': None,
            }
        s = bot_diffs[diff]
        s['total'] += 1
        black_nick = g.get('blackNick', '')
        white_nick = g.get('whiteNick', '')
        bot_is_black = black_nick.startswith('오목봇')
        bot_color = 'black' if bot_is_black else 'white'
        human_color = 'white' if bot_is_black else 'black'
        human_nick = white_nick if bot_is_black else black_nick
        try:
            human_rating = int(g.get(f'{human_color}Rating', 0))
        except Exception:
            human_rating = 0
        s['opp_nicks'].append(human_nick)
        if human_rating > 0:
            s['opp_ratings'].append(human_rating)
        # 봇 측 rating delta — zero-sum 이라 human_delta 의 음수와 일치. 직접 봇
        # 측 Delta 필드 읽어 정확성 보장. unknown 일 땐 0.
        try:
            bot_delta_s = g.get(f'{bot_color}Delta', '0').replace('+', '')
            s['bot_delta_sum'] += int(bot_delta_s)
        except Exception:
            pass
        try:
            bot_rating = int(g.get(f'{bot_color}Rating', 0))
            if bot_rating > 0:
                s['bot_last_rating'] = bot_rating
        except Exception:
            pass
        try:
            stones = int(g.get('stones', 0))
            if stones > 0: s['stones_list'].append(stones)
        except Exception:
            pass
        reason = g.get('reason', '')
        winner = g.get('winner', '')
        if reason == 'draw':
            s['draws'] += 1
        elif reason == 'opponent_left':
            s['left'] += 1
        elif reason == 'abandoned':
            s['abandoned'] += 1
        elif winner == bot_color:
            s['wins'] += 1
        elif winner == human_color:
            s['losses'] += 1
    return bot_diffs


def player_activity(game_overs):
    """사람 닉네임 별 활동 통계 → {nickname: {games, wins, losses, draws,
                                              delta_sum, last_rating}}"""
    by_nick = {}
    for g in game_overs:
        for color in ('black', 'white'):
            nick = g.get(f'{color}Nick')
            if not nick or nick.startswith('오목봇'): continue
            if nick not in by_nick:
                by_nick[nick] = {'games': 0, 'wins': 0, 'losses': 0, 'draws': 0,
                                  'delta_sum': 0, 'last_rating': 0}
            d = by_nick[nick]
            d['games'] += 1
            try:
                delta_s = g.get(f'{color}Delta', '0').replace('+', '')
                delta = int(delta_s)
                d['delta_sum'] += delta
            except Exception:
                pass
            try:
                d['last_rating'] = int(g.get(f'{color}Rating', d['last_rating']))
            except Exception:
                pass
            reason = g.get('reason', '')
            winner = g.get('winner', '')
            if reason == 'draw':
                d['draws'] += 1
            elif winner == color:
                d['wins'] += 1
            elif winner != 'draw' and winner:
                d['losses'] += 1
    return by_nick


# ============================================================
# Snapshot 구조 helper — None-safe deep access.
# snapshot 표준: { ts, services: { omok: {render, stats}, 2048: {...} }, aiven }
# ============================================================
def snap_omok_render(snap):
    """snapshot 에서 omok render 부분 추출."""
    return (snap.get('services', {}) or {}).get('omok', {}).get('render', {}) or {}


def snap_2048_render(snap):
    """snapshot 에서 2048 render 부분 추출."""
    return (snap.get('services', {}) or {}).get('2048', {}).get('render', {}) or {}


def snap_aiven(snap):
    """snapshot 에서 aiven 부분 추출 (top-level — omok/2048 공유)."""
    return snap.get('aiven', {}) or {}


# ============================================================
# CPU peak alert 본문 보강 — 같은 window 의 봇 활동 요약 (omok 전용).
# parse_bot_moves 결과를 받아서 alert 본문에 들어갈 markdown 문자열 반환.
# 원인 추적: 어떤 난이도/cfg 가 활성이었고 ≥10s 장기 search 가 몇 건이었는지.
# ============================================================
def bot_activity_summary(moves):
    if not moves:
        return '- 봇 활동: 없음'
    by_diff = defaultdict(int)
    by_cfg = defaultdict(int)
    long_count = 0
    for r in moves:
        by_diff[r['diff']] += 1
        by_cfg[f"d{r['cfgD']}×t{r['cfgT']}"] += 1
        if r['elap'] >= 10000:
            long_count += 1
    diff_str = ', '.join(f'{k}={v}' for k, v in sorted(by_diff.items()))
    cfg_str = ', '.join(f'{k}={v}' for k, v in sorted(by_cfg.items()))
    return (
        f'- 총 봇 수: **{len(moves)}건**\n'
        f'- 난이도 분포: {diff_str}\n'
        f'- cfg 분포: {cfg_str}\n'
        f'- 장기 search (≥10s): **{long_count}건**'
    )
