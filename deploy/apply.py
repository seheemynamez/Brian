#!/usr/bin/env python3
"""deploy/apply.py — deploy/targets.json(단일 소스)의 active 프로필을 모든 곳에 전파.

읽기: deploy/targets.json
  - render  = profiles[active].render
  - aiven   = profiles[valkey_override or active].aiven   (Valkey 계정은 따로 고정 가능)

수행:
  1) FE      : omok/js/net.js, 2048/net.js 의 PROD_WS_URL/PROD_SHARE_BASE 를 active 도메인으로 재작성.
  2) Aiven   : 대상 Valkey 전원 ON 보장 + service_uri(rediss://) 조회.
  3) Render  : active 두 서비스의 VALKEY_URL 을 service_uri 로 설정(변경 시에만) + 재배포.
  4) (opt) --power-off-inactive : 미선택 Valkey 전원 OFF.
  5) (opt) --sync-ci-secrets    : gh secret set RENDER_API_KEY/AIVEN_API_TOKEN (active 값) on github.com repo.

토큰은 프로필의 *_env 이름으로 os.environ 에서 해석한다(.zshenv 무변경). 비밀값은 출력하지 않는다.

사용:
  python3 deploy/apply.py --dry-run         # 변경 미리보기
  python3 deploy/apply.py                    # 적용
  python3 deploy/apply.py --power-off-inactive --sync-ci-secrets
"""
from __future__ import annotations
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
TARGETS = ROOT / 'deploy' / 'targets.json'
AIVEN_BASE = 'https://api.aiven.io/v1'
RENDER_BASE = 'https://api.render.com/v1'


def log(msg: str) -> None:
    print(msg, flush=True)


def http(method: str, url: str, headers: dict, body=None, timeout: int = 30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = {'_raw': raw.decode('utf-8', 'replace')[:300]}
        return e.code, parsed


def env_token(name: str) -> str:
    v = os.environ.get(name, '').strip()
    if not v:
        sys.exit(f"[abort] 환경변수 {name} 가 비어있음 — ~/.zshenv 확인 후 source 하고 재실행.")
    return v


def redact(uri):
    return re.sub(r'(//[^:/]+:)[^@]+(@)', r'\1***\2', uri or '(none)')


# ---------- 1) FE ----------
def rewrite_net(path: Path, host: str, dry: bool) -> bool:
    txt = path.read_text()
    new = re.sub(r"(PROD_WS_URL\s*=\s*')wss://[^/']+/ws(')",
                 lambda m: f"{m.group(1)}wss://{host}/ws{m.group(2)}", txt)
    new = re.sub(r"(PROD_SHARE_BASE\s*=\s*')https://[^']+(')",
                 lambda m: f"{m.group(1)}https://{host}{m.group(2)}", new)
    rel = path.relative_to(ROOT)
    if new == txt:
        log(f"  FE  {rel}: 이미 {host} — 변경 없음")
        return False
    log(f"  FE  {rel}: -> {host}")
    if not dry:
        path.write_text(new)
    return True


# ---------- 2) Aiven ----------
def aiven_get(project, service, tok):
    return http('GET', f"{AIVEN_BASE}/project/{project}/service/{service}",
                {'Authorization': f'aivenv1 {tok}'})


def aiven_power(project, service, tok, powered):
    return http('PUT', f"{AIVEN_BASE}/project/{project}/service/{service}",
                {'Authorization': f'aivenv1 {tok}', 'content-type': 'application/json'},
                {'powered': powered})


def aiven_ensure_running(project, service, tok, dry):
    code, body = aiven_get(project, service, tok)
    if code != 200:
        sys.exit(f"[abort] Aiven {project}/{service} 조회 실패 HTTP {code}: {body}")
    state = body.get('service', {}).get('state')
    log(f"  Aiven {service}: state={state}")
    if state != 'RUNNING':
        log(f"  Aiven {service}: 전원 ON")
        if not dry:
            aiven_power(project, service, tok, True)
            for _ in range(40):  # ~120s
                time.sleep(3)
                _, b = aiven_get(project, service, tok)
                if b.get('service', {}).get('state') == 'RUNNING':
                    log(f"  Aiven {service}: RUNNING")
                    break
            else:
                sys.exit(f"[abort] Aiven {service} 가 제때 RUNNING 안 됨")
    _, body = aiven_get(project, service, tok)
    uri = body.get('service', {}).get('service_uri')
    if not uri:
        sys.exit("[abort] Aiven service_uri 비어있음 (전원/권한 확인)")
    return uri


# ---------- 3) Render ----------
def render_get_valkey_url(sid, tok):
    code, body = http('GET', f"{RENDER_BASE}/services/{sid}/env-vars?limit=100",
                      {'Authorization': f'Bearer {tok}', 'accept': 'application/json'})
    if code != 200 or not isinstance(body, list):
        return None
    for item in body:
        ev = item.get('envVar', {})
        if ev.get('key') == 'VALKEY_URL':
            return ev.get('value')
    return None


def render_set_valkey_url(sid, uri, tok):
    return http('PUT', f"{RENDER_BASE}/services/{sid}/env-vars/VALKEY_URL",
                {'Authorization': f'Bearer {tok}', 'content-type': 'application/json',
                 'accept': 'application/json'}, {'value': uri})


def render_resume_if_suspended(sid, tok, dry):
    code, body = http('GET', f"{RENDER_BASE}/services/{sid}",
                      {'Authorization': f'Bearer {tok}', 'accept': 'application/json'})
    if code == 200 and body.get('suspended') == 'suspended':
        log(f"  Render {sid}: suspended -> resume")
        if not dry:
            http('POST', f"{RENDER_BASE}/services/{sid}/resume",
                 {'Authorization': f'Bearer {tok}', 'accept': 'application/json'})


def render_deploy(sid, tok):
    return http('POST', f"{RENDER_BASE}/services/{sid}/deploys",
                {'Authorization': f'Bearer {tok}', 'content-type': 'application/json',
                 'accept': 'application/json'}, {})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true', help='변경 미리보기(쓰기/API mutate 안 함)')
    ap.add_argument('--power-off-inactive', action='store_true', help='미선택 Valkey 전원 OFF')
    ap.add_argument('--sync-ci-secrets', action='store_true', help='gh secret set RENDER_API_KEY/AIVEN_API_TOKEN')
    ap.add_argument('--valkey-url', default=None,
                    help="Valkey 계정 전환(host 변경) 시 새 연결문자열 'rediss://default:<pw>@host:port'. "
                         'Aiven API는 비밀번호를 redact 하므로 host 변경 시 직접 제공해야 한다.')
    args = ap.parse_args()
    dry = args.dry_run

    T = json.loads(TARGETS.read_text())
    active = T['active']
    vk_acct = T.get('valkey_override') or active
    R = T['profiles'][active]['render']
    A = T['profiles'][vk_acct]['aiven']
    log(f"== apply: active(render)={active}  valkey={vk_acct}  {'(dry-run)' if dry else ''}")

    render_tok = env_token(R['api_key_env'])
    aiven_tok = env_token(A['api_token_env'])

    # 1) FE 재작성
    log("[1] FE 도메인 재작성")
    rewrite_net(ROOT / 'omok' / 'js' / 'net.js', R['services']['omok']['domain'], dry)
    rewrite_net(ROOT / '2048' / 'net.js', R['services']['2048']['domain'], dry)

    # 2) Aiven 전원 보장 + 대상 host. 주의: Aiven service_uri 의 '비밀번호'는 제한 토큰에서
    #    redact 되어 실제와 다를 수 있다(검증됨) → host 만 신뢰하고 비밀번호는 사용하지 않는다.
    log("[2] Aiven Valkey 전원/host")
    uri = aiven_ensure_running(A['project'], A['service'], aiven_tok, dry)
    target_host = urlparse(uri).hostname
    log(f"  대상 Valkey host = {target_host}")

    # 3) Render VALKEY_URL — host 기준으로만 검사(비밀번호는 안 건드림).
    #    host 가 이미 맞으면 작동 중인 비밀번호를 보존. host 가 다르면(=계정 전환) 비밀번호를
    #    API로 못 가져오므로 --valkey-url 로 받거나 수동 설정 안내.
    log("[3] Render VALKEY_URL 점검 (host 기준, 비밀 보존)")
    for game, svc in R['services'].items():
        sid = svc['service_id']
        render_resume_if_suspended(sid, render_tok, dry)
        cur = render_get_valkey_url(sid, render_tok)
        cur_host = urlparse(cur).hostname if cur else None
        if cur_host == target_host:
            log(f"  {game}({sid}): 이미 {target_host} 가리킴 — 유지(비밀 보존)")
            continue
        if args.valkey_url:
            new_host = urlparse(args.valkey_url).hostname
            if new_host != target_host:
                log(f"  {game}({sid}): !! --valkey-url host({new_host}) != 대상({target_host}) — 스킵")
                continue
            log(f"  {game}({sid}): host {cur_host} -> {target_host} 갱신 (+redeploy)")
            if not dry:
                code, body = render_set_valkey_url(sid, args.valkey_url, render_tok)
                if code not in (200, 201):
                    log(f"    !! set 실패 HTTP {code}: {body}")
                    continue
                render_deploy(sid, render_tok)
        else:
            log(f"  {game}({sid}): !! host 불일치 {cur_host} -> {target_host}. "
                f"Aiven 비밀번호는 API로 못 가져옴 → Render 대시보드에서 VALKEY_URL 직접 설정하거나 "
                f"`--valkey-url 'rediss://default:<pw>@{target_host}:<port>'` 로 재실행.")

    # 4) 미선택 Valkey 전원 OFF (옵션)
    if args.power_off_inactive:
        other = next(p for p in T['profiles'] if p != vk_acct)
        oa = T['profiles'][other]['aiven']
        log(f"[4] 미선택 Valkey 전원 OFF: {other} {oa['service']}")
        if not dry:
            aiven_power(oa['project'], oa['service'], env_token(oa['api_token_env']), False)

    # 5) CI secret 동기화 (옵션)
    if args.sync_ci_secrets:
        repo = 'seheemynamez/Brian'
        log(f"[5] gh secret set (github.com {repo})")
        if not dry:
            for key, tok in (('RENDER_API_KEY', render_tok), ('AIVEN_API_TOKEN', aiven_tok)):
                subprocess.run(['gh', 'secret', 'set', key, '--repo', repo,
                                '--hostname', 'github.com', '--body', tok], check=False)

    log("== done. (FE 변경분은 commit+push 해야 GitHub Pages 반영)")


if __name__ == '__main__':
    main()
