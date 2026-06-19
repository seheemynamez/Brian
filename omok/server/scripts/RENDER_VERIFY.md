# Render 프로덕션 검증 가이드

PR 머지 후 Render auto-deploy 가 정상 동작하는지 확인하는 절차.

## 0. 머지 전 준비 — Render env vars 미리 세팅

Render dashboard → omok-server → Environment 에 다음 키가 있는지 확인:

| Key | Value |
|---|---|
| `STORE_BACKEND` | `valkey` |
| `VALKEY_URL` | `rediss://default:<rotated-password>@valkey-11525e60-emfoa23-4031.e.aivencloud.com:23140` |
| `VALKEY_KEY_PREFIX` | `omok:prod` |
| `PORT` | (Render 자동 — 비워둠) |

**중요**: VALKEY_URL 의 password 는 채팅에 노출됐던 이전 값이 아닌 **rotation 후 새 값**.

API 로 키 이름만 확인:
```bash
export RENDER_API_TOKEN=<your-token>
curl -sS -H "Authorization: Bearer $RENDER_API_TOKEN" \
  https://api.render.com/v1/services/srv-d85rt4n7f7vs73cr7h00/env-vars \
  | python3 -c "import sys,json; [print(e['envVar']['key']) for e in json.load(sys.stdin)]"
```

미리 세팅 안 된 키가 있으면 머지 후 첫 부팅이 valkey 폴백 (memory) 으로 빠짐.

---

## 1. 머지 → auto-deploy 트리거

PR #37 머지하면 base 브랜치 (`feature/issue-31-connection-identity`) 가 업데이트 → Render auto-deploy.

PR #38 머지 시 base 가 `feature/issue-31-...` 또는 main 일 텐데, Render 의 deploy 브랜치 설정 확인.

---

## 2. Deploy 로그 폴링

```bash
SVC=srv-d85rt4n7f7vs73cr7h00
# 가장 최근 deploy
curl -sS -H "Authorization: Bearer $RENDER_API_TOKEN" \
  "https://api.render.com/v1/services/$SVC/deploys?limit=1" \
  | python3 -c "import sys,json; d=json.load(sys.stdin)[0]['deploy']; print(f\"id={d['id']} status={d['status']} commit={d['commit']['id'][:8]}\")"
```

기대 상태 진행: `created` → `build_in_progress` → `live`.

`live` 가 안 되거나 `build_failed` / `deactivated` 면 build log 확인.

---

## 3. 핵심 부팅 로그 확인

Render dashboard → Logs (또는 API 로 stream — 단 free plan 은 제한적).

확인할 라인:

```
[valkey] connecting...
[valkey] ready
[valkey] hydrated (prefix=omok:prod): rooms=N sessions=N queue=N botOffer=N
[store_ready] backend=valkey
[server_start] port=... store=valkey
```

**경고 신호:**
- `store=memory` → env 미세팅, valkey 폴백
- `[valkey] error: ...` → 연결 실패 (URL/방화벽/인증)
- `[valkey] connection closed` 반복 → 네트워크 불안정

---

## 4. 스모크 — 핵심 흐름 (10분)

브라우저에서:

- [ ] https://omok-server-dorf.onrender.com 접속 → 로비 표시
- [ ] 봇 게임 (easy) 1판 — 정상 종료
- [ ] PVP 방 만들기 → URL 복사 → 다른 브라우저에서 입장 → 게임 시작
- [ ] PVP 도중 한쪽 새로고침 → resume 성공, 보드 보존
- [ ] (선택) 봇 게임 도중 새로고침 → resume 성공

**이게 가장 중요**: 자동 테스트가 cover 못 하는 "실제 prod valkey + Render 인프라" 결합.

---

## 5. Aiven 측 확인 (선택)

valkey 키가 prod prefix 로 쌓이는지 확인:

```bash
# (참고) Aiven API 는 valkey 의 키 직접 조회 안 제공.
# 직접 redis-cli 로 붙어서 확인:
redis-cli -u "$VALKEY_URL" --tls KEYS 'omok:prod:*' | head
```

`omok:prod:room:XXXX`, `omok:prod:session:XXXX`, `omok:prod:sessions`, `omok:prod:rooms` 등이 보여야 정상.

---

## 6. 롤백 절차 (만일 검증 실패 시)

1. Render dashboard → 이전 deploy 의 "Redeploy" 버튼
2. 또는: 문제 commit revert + push → 자동 redeploy
3. Aiven 데이터는 그대로 보존됨 (prefix 안 바뀜)

---

## 검증 통과 기준

- [ ] Deploy status = `live`
- [ ] Boot 로그에 `store=valkey` + `[valkey] hydrated`
- [ ] 봇 게임 1판 정상 종료
- [ ] PVP + resume 동작
- [ ] Aiven 에 `omok:prod:*` 키 누적
