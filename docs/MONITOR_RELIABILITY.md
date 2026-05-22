# monitor-infra 안정성 — 외부 ping 설정 가이드

## 배경

GitHub Actions 의 `schedule` cron 은 **best-effort** — peak load 시 수십분~수시간 delay 또는 skip 발생. 공식 docs 명시 + paid plan 도 SLA 없음.

- PR #84 (`*/30 * * * *`) → 6시간 동안 schedule event 0건
- PR #89 (`7,37 * * * *`) → 정각 회피 했지만 100% 보장 X

결정: **GitHub `schedule` 완전 제거 + 외부 ping (cron-job.org) primary 만 사용**. workflow 측 trigger 는 `workflow_dispatch` + `repository_dispatch` 만 받음. cron-job.org 가 GitHub API 호출로 trigger.

---

## Setup — cron-job.org (무료, 5분)

### Step 1. GitHub Personal Access Token (PAT) 발급

[GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens](https://github.com/settings/personal-access-tokens/new) → Generate new token

| 필드 | 값 |
|---|---|
| Token name | `monitor-infra-cron` |
| Expiration | 1년 (캘린더 알림 등록 — 만료 silent fail 방지) |
| Repository access | Only select repositories → `seheemynamez/Brian` |
| Permissions → Actions | **Read and write** |
| Permissions → Contents | Read-only |
| 그 외 | No access |

→ token 값 (`github_pat_...`) **한 번만 보임** — 즉시 복사 + 안전한 곳에 보관.

### Step 2. cron-job.org cronjob 2개 등록

cron-job.org → "Cronjobs" → "Create cronjob"

#### Cronjob A — collect (매 5분)

| 필드 | 값 |
|---|---|
| Title | `monitor-infra collect` |
| URL | `https://api.github.com/repos/seheemynamez/Brian/actions/workflows/monitor-infra.yml/dispatches` |
| Request method | **POST** |
| Schedule | Every **5 minutes** (00, 05, 10, …) |
| Request body | `{"ref":"main","inputs":{"mode":"collect"}}` |
| Headers | `Authorization: Bearer <PAT>` <br> `Accept: application/vnd.github+json` <br> `X-GitHub-Api-Version: 2022-11-28` <br> `Content-Type: application/json` |
| Notifications | "On failure" 활성화 (PAT 만료 / API 다운 즉시 알림) |

#### Cronjob B — daily-summary (매일 KST 09:00)

A 와 동일하되:

| 필드 | 값 |
|---|---|
| Title | `monitor-infra daily-summary` |
| Schedule | Daily at **00:00 UTC** (= KST 09:00) |
| Request body | `{"ref":"main","inputs":{"mode":"daily-summary"}}` |

> **collect 와 daily-summary 동시 fire 가능성**: 매일 UTC 00:00 (KST 09:00) 에 두 cronjob 가 동시 trigger. workflow 의 `concurrency.group: monitor-infra` 가 단일 실행 보장 — 먼저 도착한 쪽이 실행되고 다른 쪽은 큐에 대기. 한쪽 lost 가 우려되면 daily-summary 를 KST 09:01 (UTC 00:01) 로 1분 offset 권장.

### Step 3. 검증

cron-job.org "Execution history" 확인:
- ✅ HTTP **204 No Content** = workflow trigger 성공
- ❌ HTTP 401 = PAT 인증 실패 (재발급 필요)
- ❌ HTTP 404 = repo / workflow path 오타 또는 PAT 권한 부족

또는 터미널:
```sh
gh api 'repos/seheemynamez/Brian/actions/workflows/monitor-infra.yml/runs' \
  --jq '.workflow_runs[0:5] | .[] | "\(.created_at[:19]) event=\(.event)"'
```
→ `event=workflow_dispatch` 가 5분 주기로 보이면 ✅ 완료.

---

## 이중 안전망 — healthchecks.io (선택)

PAT 만료 / cron-job.org 다운 / GitHub Actions 측 이슈로 trigger silent fail 시 외부 감지.

1. [healthchecks.io](https://healthchecks.io/) 가입 → "Add Check"
2. Period: 10 min, Grace: 5 min (collect 5분 + 여유)
3. ping URL (`https://hc-ping.com/<uuid>`) 복사
4. `monitor-infra.yml` 의 마지막 step:
   ```yaml
   - name: Healthcheck ping
     if: always()
     run: curl -fsS --retry 3 ${{ secrets.HEALTHCHECK_PING_URL }} || true
   ```
5. GitHub repo Settings → Secrets → `HEALTHCHECK_PING_URL` 등록

→ 10분 내 ping 없으면 healthchecks.io 가 이메일 알림.

---

## 더 엄격한 SLA — GCP Cloud Scheduler (선택)

cron-job.org 무료 plan 의 신뢰도가 부족하면:

1. GCP 프로젝트 + Cloud Scheduler API 활성화
2. Job: HTTP target → GitHub repository_dispatch endpoint
   ```
   POST https://api.github.com/repos/seheemynamez/Brian/dispatches
   Body: {"event_type":"monitor-collect"}
   ```
3. Auth: Service Account 또는 OIDC
4. Frequency: `*/5 * * * *` (5분)

비용: ~$0.01/월 미만. 신뢰도 ~99.9% (Google SLA).

workflow 측은 이미 `repository_dispatch` types `monitor-collect` / `monitor-daily-summary` 받게 준비됨.

---

## Trade-off

| 옵션 | 신뢰도 | 비용 | 셋업 |
|---|---|---|---|
| **cron-job.org → workflow_dispatch** ⭐ | ~99%+ | 무료 | 5분 |
| GCP Cloud Scheduler → repository_dispatch | ~99.9% | <$0.01/월 | 중간 |
| healthchecks.io (감지만 — add-on) | — | 무료 | 5분 |
| ~~GitHub schedule cron~~ | best-effort (수시간 skip) | 무료 | — (이 PR 에서 제거) |

권장: **cron-job.org primary + healthchecks.io 이중감지**. 더 엄격해지면 GCP.

---

## 참고

- [GitHub: schedule event 가 delay 되는 이유](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#schedule)
- [Community: schedule cron delay 사례 모음 (#156282)](https://github.com/orgs/community/discussions/156282)
- [Healthchecks.io GitHub Actions integration](https://healthchecks.io/docs/github_actions/)
