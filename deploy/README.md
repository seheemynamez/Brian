# deploy — Render/Aiven 계정 단일 소스 & 전환

`Brian`은 무료 티어 한도 때문에 **BRIAN(emfoa23)·SEHEE(se2hee)** 두 계정의 Render/Aiven을
번갈아 쓴다. "어느 계정을 쓰는지"의 **유일한 출처는 [`targets.json`](targets.json)** 이다.

## 구조
- `targets.json` — `active`(어느 Render 계정) + `valkey_override`(어느 Aiven, null이면 active 따라감) + 두 프로필의 식별자.
  - 비밀 없음: render owner/service_id/도메인, aiven project/service, **토큰의 env 변수 "이름"**(`BRIAN_RENDER_API_KEY` 등)만.
  - 실제 토큰 값은 `~/.zshenv`에만(`BRIAN_*`/`SEHEE_*`). 전환해도 zshenv는 안 건드린다.
- `apply.py` — `targets.json`을 읽어 전 계층에 전파(FE 상수 / Aiven 전원·URI / Render `VALKEY_URL`+재배포).
- 소비처는 전부 단일 소스에서 파생:
  - Python 모니터/스크립트 → `scripts/monitor_config.py`가 `targets.json`을 읽어 기존 이름으로 재노출.
  - FE(`omok/js/net.js`, `2048/net.js`) → `apply.py`가 `PROD_*` 상수를 재작성.
  - Render 대시보드 `VALKEY_URL`(비밀, sync:false) → `apply.py`는 **host만 점검**(이미 맞으면 작동 중 비밀번호 보존). host 가 바뀌는 계정 전환만 `--valkey-url`로 직접 제공(Aiven API가 비밀번호를 redact 하므로 자동 취득 불가).

## 계정 전환 (brian ↔ sehee)
```sh
# 1) 단일 소스 한 줄 수정
#    targets.json 의 "active" 를 "brian"/"sehee" 로 (필요시 "valkey_override"도)

# 2) 전파 (~/.zshenv 를 source 한 셸에서)
python3 deploy/apply.py --dry-run     # 미리보기
python3 deploy/apply.py               # 적용 (FE 재작성 + Aiven 전원 + Render VALKEY_URL host 점검)
#   옵션: --valkey-url 'rediss://default:<pw>@<host>:<port>'
#            └ Valkey host 가 바뀌는 계정 전환 시 필수. Aiven API는 비밀번호를 redact 하므로 직접 제공.
#         --power-off-inactive  (미선택 Valkey 끄기)
#         --sync-ci-secrets     (GitHub Actions 모니터용 RENDER_API_KEY/AIVEN_API_TOKEN 갱신)

# 3) FE 반영 (GitHub Pages 는 커밋된 정적 파일을 서빙)
git add targets.json ../omok/js/net.js ../2048/net.js
git commit -m "chore(deploy): switch active target" && git push
```

## 현재 상태
- `active = brian`, `valkey_override = sehee` — Render는 BRIAN(현재 live), 데이터 있는 Valkey는 SEHEE를 계속 사용(무중단·무손실).
- GitHub Actions 모니터(`.github/workflows/monitor-infra.yml`)는 GitHub Secrets의 generic `RENDER_API_KEY`/`AIVEN_API_TOKEN`을 쓴다. 전환 시 `--sync-ci-secrets`로 갱신할 것.

## 전략적 참고
이 전환 체계는 무료 티어 로테이션 때문이다. 한 계정 Render Starter + 상시 Aiven로 가면
`targets.json`은 단일 프로필로 축소되고 `apply.py`는 1회 셋업 역할만 남는다.
