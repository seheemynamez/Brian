# monitor-infra 안정성 강화 — 외부 ping 설정 가이드

## 배경

GitHub Actions 의 `schedule` cron 은 **best-effort** — peak load 시 수십분~수시간 delay 또는 skip 발생. 공식 docs 명시 + paid plan 도 SLA 없음.

- PR #84 (`*/30 * * * *`) → 6시간 동안 schedule event 0건
- PR #89 (`7,37 * * * *`) → 정각 회피로 개선, 단 100% 보장 X

해결책: **외부 cron 서비스에서 GitHub `workflow_dispatch` API 호출**. 이 PR 이 workflow 측 준비 끝낸 상태. 아래는 사용자가 외부 서비스 등록할 절차.

---

## 권장: cron-job.org (무료, 5분)

### Step 1. Personal Access Token (PAT) 발급

GitHub Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token

설정:
- **Token name**: `monitor-infra-cron`
- **Expiration**: 1년 (캘린더 알림 등록 권장 — 만료 silent fail 방지)
- **Repository access**: Only select repositories → `seheemynamez/Brian`
- **Permissions** (Repository permissions):
  - `Actions`: **Read and write**
  - `Contents`: Read-only
  - 그 외 모두 No access

→ token 값 (`github_pat_...`) 복사. 한 번만 보임.

### Step 2. cron-job.org 가입 + cronjob 등록

[cron-job.org](https://cron-job.org/) 가입 → "Cronjobs" → "Create cronjob"

#### collect (매 30분)

| 필드 | 값 |
|---|---|
| Title | `monitor-infra collect` |
| URL | `https://api.github.com/repos/seheemynamez/Brian/actions/workflows/monitor-infra.yml/dispatches` |
| Schedule | Every 30 minutes (offset 5분 권장 — GitHub 큐 회피) |
| Request method | **POST** |
| Request body | `{"ref":"main","inputs":{"mode":"collect"}}` |
| Headers | `Authorization: Bearer <PAT>` <br> `Accept: application/vnd.github+json` <br> `X-GitHub-Api-Version: 2022-11-28` <br> `Content-Type: application/json` |
| Notifications | "On failure" 활성화 (PAT 만료 / API 다운 즉시 알림) |

#### daily-summary (매일 KST 09:07)

| 필드 | 값 |
|---|---|
| Title | `monitor-infra daily-summary` |
| URL | (collect 와 동일) |
| Schedule | Daily at **00:07 UTC** (= KST 09:07) |
| Request body | `{"ref":"main","inputs":{"mode":"daily-summary"}}` |
| Headers | (collect 와 동일) |

### Step 3. 검증

저장 후 "Execution history" 에서 응답 확인:
- ✅ HTTP **204 No Content** = workflow trigger 성공
- ❌ HTTP 401 = PAT 인증 실패 (재발급 필요)
- ❌ HTTP 404 = repo/workflow path 오타 또는 PAT 권한 부족

5-10분 후 GitHub Actions 탭 → monitor-infra → 새 run 이 `Triggered via workflow dispatch` 로 표시되면 정상 작동.

```sh
gh api 'repos/seheemynamez/Brian/actions/workflows/monitor-infra.yml/runs' \
  --jq '.workflow_runs[0:3] | .[] | "\(.created_at[:19]) event=\(.event)"'
# → event=workflow_dispatch 가 매 30분 보이면 정상
```

---

## 이중 안전망 (선택)

### healthchecks.io — "30분 내 ping 없으면 알림"

cron-job.org PAT 만료 / API 다운 / GitHub 측 이슈로 trigger 실패 시 silent. healthchecks.io 로 이중 감지 가능.

1. healthchecks.io 가입 → "Add Check"
2. Period: 30 min, Grace: 10 min
3. 받은 ping URL (`https://hc-ping.com/<uuid>`) 복사
4. `monitor-infra.yml` 의 마지막 step 에 추가:
   ```yaml
   - name: Healthcheck ping
     if: always()
     run: curl -fsS --retry 3 ${{ secrets.HEALTHCHECK_PING_URL }} || true
   ```
5. GitHub repo Settings → Secrets → `HEALTHCHECK_PING_URL` 등록

→ 30분 내 ping 안 오면 healthchecks.io 가 이메일 알림.

---

## 더 엄격한 SLA 가 필요할 때 — GCP Cloud Scheduler

cron-job.org 무료 plan 의 신뢰도가 부족하면:

1. GCP 프로젝트 + Cloud Scheduler API 활성화
2. Job 생성: HTTP target → 같은 GitHub API URL
3. Auth: Service Account 또는 OIDC
4. Frequency: `*/30 * * * *`

비용: ~$0.01/월 미만. 신뢰도 ~99.9% (Google SLA).

---

## Trade-off 요약

| 옵션 | 신뢰도 | 비용 | 셋업 |
|---|---|---|---|
| **cron-job.org → workflow_dispatch** ⭐ | ~99%+ | 무료 | 5분 |
| GCP Cloud Scheduler → repository_dispatch | ~99.9% | <$0.01/월 | 중간 |
| healthchecks.io (감지만) | — | 무료 | 5분 (위 위에 add-on) |
| GitHub schedule cron (기존) | best-effort | 무료 | 0분 (이미 있음, fallback) |

권장: **cron-job.org primary + healthchecks.io 이중감지** + GitHub schedule 은 fallback 으로 유지.

---

## 참고

- [GitHub: schedule event 가 delay 되는 이유](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#schedule)
- [Community: schedule cron delay 사례 모음 (#156282)](https://github.com/orgs/community/discussions/156282)
- [Healthchecks.io GitHub Actions integration](https://healthchecks.io/docs/github_actions/)
