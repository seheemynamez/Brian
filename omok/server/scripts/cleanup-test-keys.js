// ============================================================
// Valkey 의 테스트용 prefix 키만 청소. dev/prod 는 거부.
// 호출 예: VALKEY_KEY_PREFIX=omok:test node --env-file-if-exists=.env scripts/cleanup-test-keys.js
// ============================================================

'use strict';

const Redis = require('ioredis');

const url = process.env.VALKEY_URL;
const prefix = process.env.VALKEY_KEY_PREFIX || 'omok:test';

if (!url) {
  console.error('[cleanup] VALKEY_URL not set; skipping');
  process.exit(0);
}

// dev / prod / 무 prefix 는 실수로 청소하면 안 되니 거부.
const FORBIDDEN = new Set(['omok', 'omok:dev', 'omok:prod']);
if (FORBIDDEN.has(prefix)) {
  console.error(`[cleanup] refusing to clean prefix '${prefix}' — only test prefixes allowed`);
  process.exit(1);
}

(async () => {
  const client = new Redis(url, { connectTimeout: 10000, maxRetriesPerRequest: 3 });
  try {
    let cursor = '0';
    let total = 0;
    const pattern = `${prefix}:*`;
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) {
        await client.del(...keys);
        total += keys.length;
      }
    } while (cursor !== '0');
    console.log(`[cleanup] deleted ${total} keys matching ${pattern}`);
  } catch (e) {
    console.error('[cleanup] failed:', e && e.message);
    process.exitCode = 1;
  } finally {
    await client.quit();
  }
})();
