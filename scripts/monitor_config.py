"""monitor 의 환경변수 / 상수 / 임계 — 다른 monitor_* 모듈이 import 해서 사용."""
from __future__ import annotations
import os
from datetime import datetime, timezone, timedelta
from pathlib import Path

# ============================================================
# 환경
# ============================================================
RENDER_API_KEY = os.environ.get('RENDER_API_KEY', '')
AIVEN_API_TOKEN = os.environ.get('AIVEN_API_TOKEN', '')
GH_TOKEN = os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN', '')
GH_REPO = os.environ.get('GITHUB_REPOSITORY', 'seheemynamez/Brian')
MODE = os.environ.get('MODE', 'collect')
DRY_RUN = os.environ.get('DRY_RUN', '0') == '1' or not GH_TOKEN

# Render workspace (omok 과 2048 같은 owner 사용).
RENDER_OWNER_ID = 'tea-d84jo8jrjlhs73d9afeg'

# Render services — omok-server, 2048-server. monitor 가 5분/일간 cron 에서
# 두 service 모두 같은 임계 / cooldown 정책으로 fetch + alert.
# key 는 alert suffix / 본문 prefix / metrics snapshot key 로 사용 — 짧고 안정적.
SERVICES = {
    'omok': {
        'name': 'omok-server',
        'service_id': 'srv-d84mu23tqb8s73fgcq60',
        'public_url': 'https://omok-server-dorf.onrender.com',
        # game-specific 로그 prefix 가 풍부 — 봇/RETRY/SKIP/server_failed 모두 추적.
        'has_bot_logs': True,
    },
    '2048': {
        'name': '2048-server',
        'service_id': 'srv-d87tvarbc2fs73echpr0',
        'public_url': 'https://two048-server-yom9.onrender.com',
        # 봇 없음 — RETRY/SKIP/worker_timeout/no_move 미해당. submit_score 등은 별도.
        'has_bot_logs': False,
    },
}

# 기존 호출자 호환 (단일 service 가정 코드 — fetch_server_stats 등). omok 을 디폴트로.
RENDER_SERVICE_ID = SERVICES['omok']['service_id']
SERVER_PUBLIC_URL = SERVICES['omok']['public_url']

AIVEN_PROJECT = 'se2hee-93ed'
AIVEN_SERVICE = 'valkey-411207c'

# 한도
RENDER_CPU_LIMIT_M = 100.0   # millicore
RENDER_MEM_LIMIT_MB = 512.0
RENDER_BW_LIMIT_GB = 100.0
AIVEN_MEM_LIMIT_MB = 1024.0

# 임계 — cron 30분 → 5분 변경 (2026-05-22) 으로 window 도 30분 → 15분 축소.
# Issue #108 분석 (Render 로그 21건 직접 분석): unique room 2개 + 비슷한 시간대
# 의 두 봇 게임 (각 14건/5분, 7건/2분) 에서 발생. RETRY 메커니즘은 정상 동작
# (stones 진행 중). 한 게임 평균 ~15건/5분 (≈ 매 턴마다 RETRY 1회) 기준으로:
# - 동시 2 게임 lag = ~30건/15분
# - 동시 3 게임 lag = ~45건/15분
# → 임계 30 으로 동시 2 게임 이상 lag 만 잡음 (한 게임 단독 케이스 제외).
THRESHOLD_RENDER_CPU_M = 100.0   # 한도 (100m) 도달 — throttle 시작.

# Aiven valkey (free-1 plan: 1024MB node RAM, disk 0 = in-memory only)
#
# 중요: Aiven mem_usage 메트릭은 **node OS RSS 비율 (/1024MB)** 이며
# **valkey 내부 maxmemory (299MB)** 와 별개. 운영 확인 (2026-05-24):
#   - 노드 RSS baseline ~60-70% (OS + 복제 버퍼 + valkey 오버헤드, 데이터 거의 비어 있음)
#   - valkey 데이터 자체는 5MB 수준 → 299MB / 1.7% 사용
#   - noeviction 으로 write 실패하는 시점 = valkey 내부 299MB 도달 (별도 메트릭, 본 모니터링 미수집)
# 따라서 Aiven mem_pct 기반 임계는 "node OOM kill 위험" 관점.
# 실제 데이터 cleanup 필요 신호는 valkey INFO MEMORY 별도 조회가 정확 (향후 PR 후보).
#
# 임계 (Aiven node mem, 3-tier):
#   - WARN  (75%): 본문 표 노랑. 정상 baseline 부근, 모니터링만.
#   - HIGH  (85%): alert. OS OOM 임박. 데이터 cleanup + plan upgrade 검토.
#   - CRIT  (95%): 즉시 조치. OOM kill 직전.
THRESHOLD_AIVEN_MEM_PCT_WARN = 75.0
THRESHOLD_AIVEN_MEM_PCT_HIGH = 85.0
THRESHOLD_AIVEN_MEM_PCT_CRIT = 95.0
THRESHOLD_AIVEN_MEM_PCT = THRESHOLD_AIVEN_MEM_PCT_HIGH  # backward-compat alias
# CPU — valkey 9.0 single-thread (io_threads=1 default). CPU 사용율 90% 면 throughput
# 한도 도달, RTT 증가. free-1 1 core 기준.
THRESHOLD_AIVEN_CPU_PCT_WARN = 50.0
THRESHOLD_AIVEN_CPU_PCT_HIGH = 70.0
THRESHOLD_AIVEN_CPU_PCT_CRIT = 90.0
# Disk — free-1 은 disk_space_mb=0 (in-memory only). 응답 값 항상 0 또는 N/A 가능.
# 유료 plan upgrade 시 의미 — RDB/AOF 영속화 disk 사용.
THRESHOLD_AIVEN_DISK_PCT_WARN = 50.0
THRESHOLD_AIVEN_DISK_PCT_HIGH = 75.0
THRESHOLD_AIVEN_DISK_PCT_CRIT = 90.0
# Load average — node-level 1m load. CPU=1 이라 1.0 이 사실상 100%.
THRESHOLD_AIVEN_LOAD_WARN = 0.8
THRESHOLD_AIVEN_LOAD_HIGH = 1.5
THRESHOLD_AIVEN_LOAD_CRIT = 2.5
# 봇 zombie 회복 (PR #85). RETRY 가 정상 동작이지만 burst 가 잦으면 사용자 lag 심각.
# SKIP 는 RETRY 후에도 회복 못 한 경우 — 거의 발생 X (없어야 정상).
THRESHOLD_BOT_RETRY_15MIN = 30   # 15분 안 RETRY 30건 이상 (≈동시 2 게임 lag)
THRESHOLD_BOT_SKIP_15MIN = 3     # 15분 안 SKIP 3건 이상 — RETRY 가 못 잡는 진짜 끊김 패턴
# grace 임계 — server downtime 이 이를 초과하면 사용자 disconnect_grace 만료 위험.
# omok/server/infra/timings.js 의 DISCONNECT_GRACE_MS (90s, Issue #155 deploy
# 136s 반영) 와 동기. 두 정책 같이 움직임 — server 가 grace 늘리면 monitor 도
# alert 임계 늘려 의미 일치.
THRESHOLD_DOWNTIME_S = 90.0
# Cooldown — cron 5분이라 같은 alert 가 evaluation 마다 발사되지 않게.
# 6시간은 진짜 문제가 회복 안 됐을 때 너무 늦게 재감지 → 2시간으로 단축.
COOLDOWN_HOURS = 2

# fetch_fail_streak — monitor 자체의 외부 API fetch 가 연속 N 회 실패 시 alert.
# transient retry (monitor_apis.RETRY_MAX=3) 후에도 실패라 진짜 outage 의심.
# cron 5분 × 3 = 약 15분 = 사람이 인지할 만한 outage 시작 시점.
FETCH_FAIL_THRESHOLD = 3

REPO_ROOT = Path(__file__).resolve().parent.parent
METRICS_DIR = REPO_ROOT / 'metrics'
STATE_FILE = METRICS_DIR / 'state.json'
# 옛 DAILY_STATS_FILE 제거 (PR #168) — 일별 aggregate 는 server /api/daily-stats (valkey 90d) 가 SoT.

NOW = datetime.now(timezone.utc)
KST = timezone(timedelta(hours=9))
# 모든 metric 파일명 / day 단위 집계는 KST 기준. snapshot 내부 ts 만 UTC ISO 유지
# (외부 API 응답이 UTC 라 변환 비용 최소화). 사람이 보는 모든 시각은 KST 로 표시.
KST_TODAY = NOW.astimezone(KST).strftime('%Y-%m-%d')

# alert key → label 매핑. service 별 alert 는 key 에 ':{service}' suffix 가 붙어
# cooldown 추적은 분리되지만 라벨은 공통. title prefix `[{service}]` 로 issue 에서 구분.
ALERT_LABELS = {
    'render_cpu_high':  ['monitor', 'alert-render', 'severity-high'],
    'aiven_mem_high':   ['monitor', 'alert-aiven',  'severity-high'],
    'worker_timeout':   ['monitor', 'alert-bot',    'severity-critical'],
    'no_move':          ['monitor', 'alert-bot',    'severity-high'],
    'deploy_bad':       ['monitor', 'alert-deploy', 'severity-critical'],
    'bot_retry_burst':  ['monitor', 'alert-bot',    'severity-high'],
    'bot_skip_burst':   ['monitor', 'alert-bot',    'severity-critical'],
    'server_oom':       ['monitor', 'alert-render', 'severity-critical'],   # OOM 강제 종료
    'server_crash':     ['monitor', 'alert-render', 'severity-critical'],   # nonZeroExit 코드 에러
    'server_slow_recovery': ['monitor', 'alert-render', 'severity-high'],   # downtime > 60s (grace 초과)
    'fetch_fail':       ['monitor', 'alert-fetch',  'severity-high'],       # monitor 자체 fetch 연속 실패
}


def alert_key_for(base_key: str, service: str) -> str:
    """service 별 cooldown 분리용 key. 같은 base_key 라도 service 다르면 별도 cooldown."""
    return f'{base_key}:{service}'


def service_label(service: str) -> str:
    """alert label 에 추가될 service 식별 — `service-{key}`."""
    return f'service-{service}'
