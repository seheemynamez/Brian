#!/usr/bin/env python3
"""one-time 복원 — Render log 에서 server-domain event 파싱 → valkey LIST/SET/Hash 적재.

PR #168 (valkey-first) 배포 전 일자들은 valkey LIST/SET 이 비어 있어 daily-summary
의 "봇 운영 지표 / 사람 thinking time / TOP 활동 / Rating mover / 안정성 카운트"
섹션이 모두 빈 상태로 발행됨 (Issue #170 사례).

이 script 는 SEHEE Render API key 로 직접 로그 fetch 후 valkey 에 적재해 endpoint 가
다음 발행부터 정상 응답하게 만듦. 같은 날짜로 재실행 시 LIST 는 중복 push, SET/Hash 는
멱등 (SADD/HSET) — 재실행 전엔 LIST 만 따로 clean 권장 (--clean-list flag).

env:
  SEHEE_RENDER_API_KEY  Render API key (필수)
  VALKEY_URL            prod valkey rediss:// (필수)
  VALKEY_KEY_PREFIX     기본 'omok:prod'

사용:
  python3 scripts/reconstruct_valkey_from_render_logs.py --date 2026-05-23
  python3 scripts/reconstruct_valkey_from_render_logs.py --date 2026-05-23 --clean-list
  python3 scripts/reconstruct_valkey_from_render_logs.py --dates 2026-05-22,2026-05-23 --dry-run
"""
from __future__ import annotations
import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

try:
    import redis  # type: ignore
except ImportError:
    print('redis-py 필요: pip install redis')
    sys.exit(1)

KST = timezone(timedelta(hours=9))

# 계정 식별자는 deploy/targets.json 단일 소스에서 (monitor_config 경유).
from monitor_config import RENDER_OWNER_ID, RENDER_API_KEY, SERVICES  # noqa: E402
RENDER_SERVICE_IDS = {g: s['service_id'] for g, s in SERVICES.items()}
RENDER_BASE = 'https://api.render.com/v1'

DAILY_TTL_SEC = 90 * 86400

# log 형식 — server handlers/bot.js, infra/log.js 의 출력과 일치.
RE_GAME_OVER_KV = re.compile(r'(\w+)=("(?:[^"\\]|\\.)*"|\S+)')
RE_BOT_MOVE = re.compile(
    r'\[bot\] move applied: bot=(\w+) stones=(\d+) \((\d+)번째 수\) '
    r'cfg=d(\d+)×t(\d+) reached=d(\d+) elapsed=(\d+)ms move=\[(\d+),(\d+)\] room=(\S+)'
)
RE_BOT_RETRY = re.compile(
    r'\[bot\] schedule RETRY .+?: bot=(\w+) stones=(\d+) room=(\S+) color=(\w+) client=(\S+)'
)
RE_BOT_NO_MOVE = re.compile(r'\[bot\] search returned no move')
RE_BOT_WORKER_FAIL = re.compile(r'\[bot\] worker failed')
RE_HEARTBEAT_TERMINATE = re.compile(r'\[heartbeat_terminate\]')

# game_over: `[game_over] code=XXXX gameId=YY winner=black reason=five bot=true...`
# fields 모두 key=value (값은 공백/" 으로 묶임 가능). log.js 의 fmt 와 동일.
def parse_kv_message(message: str, prefix: str) -> dict | None:
    """`[prefix] k=v k="v with space" ...` 패턴 → dict. prefix 미일치 시 None."""
    if f'[{prefix}]' not in message:
        return None
    out = {}
    for k, v in RE_GAME_OVER_KV.findall(message):
        if v.startswith('"') and v.endswith('"'):
            v = v[1:-1].replace('\\"', '"')
        out[k] = v
    return out


def render_get_with_retry(url, headers, timeout=30, max_retries=8):
    """429 / 5xx 시 Retry-After 헤더 + exp backoff. 끝까지 실패 시 raise."""
    req = urllib.request.Request(url, headers=headers)
    delay = 2
    for attempt in range(max_retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < max_retries - 1:
                ra = e.headers.get('Retry-After')
                wait = float(ra) if ra and ra.replace('.', '', 1).isdigit() else delay
                wait = min(wait, 30)
                print(f'    {e.code} retry-after={wait}s (attempt {attempt+1}/{max_retries})', file=sys.stderr)
                time.sleep(wait)
                delay = min(delay * 2, 30)
                continue
            raise
        except Exception:
            if attempt < max_retries - 1:
                time.sleep(delay)
                delay = min(delay * 2, 30)
                continue
            raise


def fetch_render_logs(text: str, start_iso: str, end_iso: str, api_key: str,
                      limit: int = 100, max_iter: int = 200,
                      between_calls_sec: float = 0.5) -> list[dict]:
    """Render Logs API — text 검색 + backward pagination. 한 호출 limit×iter 까지 cap.
    courtesy throttle 0.5s 기본 (rate limit 회피)."""
    headers = {'Authorization': f'Bearer {api_key}', 'Accept': 'application/json'}
    all_logs = []
    end = end_iso
    for _ in range(max_iter):
        qs = urllib.parse.urlencode({
            'ownerId': RENDER_OWNER_ID, 'resource': RENDER_SERVICE_IDS['omok'],
            'startTime': start_iso, 'endTime': end,
            'text': text, 'limit': limit, 'direction': 'backward',
        })
        try:
            data = render_get_with_retry(f'{RENDER_BASE}/logs?{qs}', headers)
        except urllib.error.HTTPError as e:
            body = ''
            try: body = e.read().decode()[:200]
            except Exception: pass
            print(f'    final HTTPError: {e.code} {body}', file=sys.stderr)
            break
        except Exception as e:
            print(f'    final fetch err: {e}', file=sys.stderr)
            break
        logs = data.get('logs') or []
        if not logs: break
        all_logs.extend(logs)
        if not data.get('hasMore'): break
        end = data.get('nextEndTime', '')
        if not end: break
        time.sleep(between_calls_sec)
    return all_logs


def kst_window_for(date_str: str) -> tuple[str, str]:
    """date_str (YYYY-MM-DD) → KST 00:00 ~ +24h UTC ISO 변환."""
    d = datetime.strptime(date_str, '%Y-%m-%d').replace(tzinfo=KST)
    start_utc = d.astimezone(timezone.utc)
    end_utc = (d + timedelta(days=1)).astimezone(timezone.utc)
    fmt = lambda x: x.strftime('%Y-%m-%dT%H:%M:%SZ')
    return (fmt(start_utc), fmt(end_utc))


def reconstruct_date(r: redis.Redis | None, date_str: str, prefix: str,
                     api_key: str, clean_list: bool, dry_run: bool,
                     skip_hash: bool = False, service_id: str = RENDER_SERVICE_IDS['omok']):
    """skip_hash=True 일 때 Hash counter 는 안 건드림 (live server 가 이미 정확히 누적 중인 경우).
    LIST/SET 만 적재."""
    s_iso, e_iso = kst_window_for(date_str)
    print(f'\n=== {date_str} KST  ({s_iso} ~ {e_iso})  skip_hash={skip_hash} ===')

    # 1) game_over → games LIST + active_users SET
    print('  fetching [game_over]...')
    game_logs = fetch_render_logs('[game_over]', s_iso, e_iso, api_key)
    games_parsed = []
    active_nicks = set()
    for L in game_logs:
        msg = L.get('message', '')
        d = parse_kv_message(msg, 'game_over')
        if not d: continue
        # server endpoint 응답과 동일 형식 — bool/숫자 캐스팅 X (string 그대로).
        # PR #168 의 games_from_endpoint adapter 가 normalize 함.
        d['ts'] = L.get('timestamp', '')   # UTC ISO; adapter 가 KST 변환
        # server-side gameOverFields 에는 bot 가 boolean. log 에는 'true'/'false' string.
        # endpoint JSON 은 boolean 으로 응답 — backfill 시 string 그대로 두면 adapter 가 처리.
        games_parsed.append(d)
        # active_users — 사람 nick (봇 nick 제외).
        for color in ('black', 'white'):
            nick = d.get(f'{color}Nick', '')
            if nick and not nick.startswith('오목봇'):
                active_nicks.add(nick)
    print(f'    parsed: {len(games_parsed)} games, {len(active_nicks)} unique human nicks')

    # 2) bot move applied → bot_moves LIST
    print('  fetching [bot] move applied...')
    move_logs = fetch_render_logs('[bot] move applied', s_iso, e_iso, api_key)
    moves_parsed = []
    for L in move_logs:
        msg = L.get('message', '')
        m = RE_BOT_MOVE.search(msg)
        if not m: continue
        diff, stones, nth, cfgD, cfgT, reach, elap, mr, mc, room = m.groups()
        moves_parsed.append({
            'ts': L.get('timestamp', ''),
            'diff': diff,
            'stones': int(stones),
            'cfgD': int(cfgD),
            'cfgTopK': int(cfgT),
            'reach': int(reach),
            'elap': int(elap),
            'room': room,
        })
    print(f'    parsed: {len(moves_parsed)} bot moves')

    # 3) RETRY / SKIP → counter + sets
    print('  fetching [bot] schedule RETRY/SKIP...')
    retry_logs = fetch_render_logs('[bot] schedule RETRY', s_iso, e_iso, api_key, limit=100)
    skip_logs = fetch_render_logs('[bot] schedule SKIP', s_iso, e_iso, api_key, limit=100)
    retry_rooms, retry_clients = set(), set()
    for L in retry_logs:
        m = RE_BOT_RETRY.search(L.get('message', ''))
        if not m: continue
        retry_rooms.add(m.group(3))
        retry_clients.add(m.group(5))
    skip_rooms, skip_clients = set(), set()
    for L in skip_logs:
        m = RE_BOT_RETRY.search(L.get('message', '').replace('SKIP', 'RETRY'))  # 동일 포맷
        if not m: continue
        skip_rooms.add(m.group(3))
        skip_clients.add(m.group(5))
    print(f'    RETRY={len(retry_logs)} (rooms={len(retry_rooms)}, clients={len(retry_clients)})')
    print(f'    SKIP={len(skip_logs)} (rooms={len(skip_rooms)}, clients={len(skip_clients)})')

    # 4) worker_timeout / no_move / heartbeat_terminate → counter
    print('  fetching worker_timeout / no_move / heartbeat_terminate...')
    wt_logs = fetch_render_logs('worker_timeout', s_iso, e_iso, api_key, limit=100)
    nm_logs = fetch_render_logs('search returned no move', s_iso, e_iso, api_key, limit=100)
    hb_logs = fetch_render_logs('heartbeat_terminate', s_iso, e_iso, api_key, limit=100)
    # worker_timeout 텍스트는 [bot] worker failed 와 valkey_no_move 등에서 모두 매칭될 수 있어 사후 필터.
    wt_count = sum(1 for L in wt_logs if 'worker failed' in L.get('message', '') or '[worker_timeout]' in L.get('message', ''))
    nm_count = sum(1 for L in nm_logs if 'search returned no move' in L.get('message', ''))
    hb_count = sum(1 for L in hb_logs if '[heartbeat_terminate]' in L.get('message', ''))
    print(f'    worker_timeout={wt_count}, no_move={nm_count}, heartbeat_terminate={hb_count}')

    # 5) ws_connected / ws_disconnected — 카운트만 (online series 는 server sampler 시작 이후만 가능)
    print('  fetching ws_connected / ws_disconnected...')
    wsc_logs = fetch_render_logs('[ws_connected]', s_iso, e_iso, api_key, limit=100)
    wsd_logs = fetch_render_logs('[ws_disconnected]', s_iso, e_iso, api_key, limit=100)
    print(f'    ws_connected={len(wsc_logs)}, ws_disconnected={len(wsd_logs)}')

    if dry_run:
        print(f'  [DRY-RUN] valkey writes skipped')
        return

    # 적재
    games_key  = f'{prefix}:daily-list:{date_str}:games'
    moves_key  = f'{prefix}:daily-list:{date_str}:bot_moves'
    actives_key = f'{prefix}:daily-set:{date_str}:active_users'
    retry_r_key = f'{prefix}:daily-set:{date_str}:bot_retry_rooms'
    retry_c_key = f'{prefix}:daily-set:{date_str}:bot_retry_clients'
    skip_r_key  = f'{prefix}:daily-set:{date_str}:bot_skip_rooms'
    skip_c_key  = f'{prefix}:daily-set:{date_str}:bot_skip_clients'
    daily_hash_key = f'{prefix}:daily:{date_str}'

    if clean_list:
        r.delete(games_key)
        r.delete(moves_key)
        print(f'  cleaned LIST keys')

    # games LIST — server 가 LPUSH (최신 머리). 우리는 시간순으로 들어왔다고 가정해 그대로 LPUSH.
    if games_parsed:
        pipe = r.pipeline()
        for g in games_parsed:
            pipe.lpush(games_key, json.dumps(g, ensure_ascii=False))
        pipe.expire(games_key, DAILY_TTL_SEC)
        pipe.execute()
    if moves_parsed:
        pipe = r.pipeline()
        for m in moves_parsed:
            pipe.lpush(moves_key, json.dumps(m, ensure_ascii=False))
        pipe.expire(moves_key, DAILY_TTL_SEC)
        pipe.execute()
    if active_nicks:
        pipe = r.pipeline()
        for n in active_nicks: pipe.sadd(actives_key, n)
        pipe.expire(actives_key, DAILY_TTL_SEC)
        pipe.execute()
    if retry_rooms:
        pipe = r.pipeline()
        for x in retry_rooms: pipe.sadd(retry_r_key, x)
        pipe.expire(retry_r_key, DAILY_TTL_SEC)
        pipe.execute()
    if retry_clients:
        pipe = r.pipeline()
        for x in retry_clients: pipe.sadd(retry_c_key, x)
        pipe.expire(retry_c_key, DAILY_TTL_SEC)
        pipe.execute()
    if skip_rooms:
        pipe = r.pipeline()
        for x in skip_rooms: pipe.sadd(skip_r_key, x)
        pipe.expire(skip_r_key, DAILY_TTL_SEC)
        pipe.execute()
    if skip_clients:
        pipe = r.pipeline()
        for x in skip_clients: pipe.sadd(skip_c_key, x)
        pipe.expire(skip_c_key, DAILY_TTL_SEC)
        pipe.execute()

    # daily Hash counter — HSET (replace). caller 의 backfill 값과 합쳐 일관성.
    # 기존 active_users_backfill / bot_games / pvp_games 등은 보존. 이번에 명확히 알 수 있는 값만 덮어씀.
    # skip_hash=True 면 Hash 업데이트 자체 안 함 (live server 가 이미 누적 중인 경우).
    if skip_hash:
        print(f'  Hash counter update SKIPPED (live server 가 이미 누적 중)')
    else:
        hash_updates = {}
        if wt_count > 0: hash_updates['worker_timeout'] = wt_count
        if nm_count > 0: hash_updates['no_move'] = nm_count
        if hb_count > 0: hash_updates['heartbeat_terminate'] = hb_count
        if len(retry_logs) > 0: hash_updates['bot_retry'] = len(retry_logs)
        if len(skip_logs) > 0: hash_updates['bot_skip'] = len(skip_logs)
        if len(wsc_logs) > 0: hash_updates['ws_connected'] = len(wsc_logs)
        if len(wsd_logs) > 0: hash_updates['ws_disconnected'] = len(wsd_logs)
        # PVP / bot_games 도 game_over 로그에서 정확히 셀 수 있음 — 기존 backfill 값 덮어쓰기.
        pvp = sum(1 for g in games_parsed if g.get('bot') == 'false')
        bot = sum(1 for g in games_parsed if g.get('bot') == 'true')
        if pvp: hash_updates['pvp_games'] = pvp
        if bot: hash_updates['bot_games'] = bot
        if moves_parsed: hash_updates['total_bot_moves'] = len(moves_parsed)
        if hash_updates:
            r.hset(daily_hash_key, mapping={k: str(v) for k, v in hash_updates.items()})
            r.expire(daily_hash_key, DAILY_TTL_SEC)
            print(f'  Hash updated: {hash_updates}')

    print(f'  wrote: games_LIST={len(games_parsed)}, moves_LIST={len(moves_parsed)}, '
          f'active_users_SET={len(active_nicks)}, retry/skip SETs')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--date', help='single date YYYY-MM-DD')
    ap.add_argument('--dates', help='comma-separated YYYY-MM-DD,YYYY-MM-DD,...')
    ap.add_argument('--prefix', default=os.environ.get('VALKEY_KEY_PREFIX', 'omok:prod'))
    ap.add_argument('--url', default=os.environ.get('VALKEY_URL'))
    ap.add_argument('--api-key', default=RENDER_API_KEY or None)
    ap.add_argument('--clean-list', action='store_true', help='재실행 전 LIST 삭제 (중복 방지)')
    ap.add_argument('--skip-hash', action='store_true',
                    help='Hash counter 업데이트 skip (live server 가 이미 누적 중인 today 등)')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    if not args.api_key:
        print('RENDER_API_KEY(active 계정 토큰) 또는 --api-key 필요')
        sys.exit(1)
    if not args.dry_run and not args.url:
        print('VALKEY_URL 또는 --url 필요 (또는 --dry-run)')
        sys.exit(1)
    if not args.date and not args.dates:
        print('--date 또는 --dates 필수')
        sys.exit(1)

    dates = [args.date] if args.date else args.dates.split(',')
    dates = [d.strip() for d in dates if d.strip()]

    r = None if args.dry_run else redis.from_url(args.url)
    try:
        for d in dates:
            reconstruct_date(r, d, args.prefix, args.api_key,
                             args.clean_list, args.dry_run, skip_hash=args.skip_hash)
    finally:
        if r: r.close()


if __name__ == '__main__':
    main()
