#!/bin/bash
# ============================================================
# Valkey backend 로 recovery 테스트 돌리기.
# VALKEY_URL 은 .env 에서 가져옴. PREFIX 는 omok:test (dev/prod 와 격리).
# 테스트 종료 후 omok:test:* 키 자동 청소.
# ============================================================
set -u

export STORE_BACKEND=valkey
export VALKEY_KEY_PREFIX=omok:test
export BOT_OFFER_DELAY_MS=1000
export DISCONNECT_GRACE_MS=1500
export SPECTATOR_DISCONNECT_GRACE_MS=500
export PORT=18080
export STATIC_ROOT=.

# 서버 띄움 (.env 의 VALKEY_URL 사용)
# stdout 을 임시 파일에도 흘려서 [store_ready] 를 기다림.
LOG=$(mktemp -t omok-test-valkey.XXXXXX.log)
node --env-file-if-exists=.env server.js 2>&1 | tee "$LOG" &
SERVER_PID=$!

# valkey hydrate 완료까지 대기 (Aiven RTT 고려, 최대 20초)
for i in $(seq 1 40); do
  if grep -q "\[store_ready\]" "$LOG" 2>/dev/null; then
    echo "[test-valkey] store ready (after $((i*500))ms)"
    break
  fi
  sleep 0.5
done

# 안전 마진
sleep 0.5

# 테스트 실행
node __tests__/recovery.test.js
TEST_EXIT=$?

# 서버 종료
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
rm -f "$LOG"

# 테스트 prefix 키 청소
node --env-file-if-exists=.env scripts/cleanup-test-keys.js

exit $TEST_EXIT
