// ============================================================
// 2048 초대 링크 동적 OG — /i/2048/{nick}/{score}
// ============================================================
// 메신저 봇이 OG 메타만 읽고, 사람은 canonical 2048 페이지로 redirect.
// CANONICAL_2048_URL env 미설정 시 같은 origin 의 /2048/ 로 (로컬).
'use strict';

const SCORE_MAX = 1_000_000;   // 비현실적 점수 거부

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const sanitizeNick = (raw) => {
  if (typeof raw !== 'string') return '';
  return decodeURIComponent(raw).trim().slice(0, 14);
};

const sanitizeScore = (raw) => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > SCORE_MAX) return null;
  return Math.floor(n);
};

const buildHtml = ({ nick, score, canonicalUrl }) => {
  const titleBase = nick
    ? `${nick} 님 ${score}점 — 도전해보세요!`
    : `2048 — 도전해보세요!`;
  const desc = nick
    ? `${nick} 님이 2048 에서 ${score}점을 기록했어요. 더 높은 점수에 도전!`
    : `클래식 슬라이드 퍼즐 2048. 더 큰 숫자 만들기 도전.`;
  const t = escapeHtml(titleBase);
  const d = escapeHtml(desc);
  const safeUrl = escapeHtml(canonicalUrl);
  const jsUrl = JSON.stringify(canonicalUrl);
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <title>${t}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#faf8ef">
  <meta name="robots" content="noindex, follow">
  <link rel="canonical" href="${safeUrl}">

  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Sehee's Mini Games">
  <meta property="og:title" content="${t}">
  <meta property="og:description" content="${d}">
  <meta property="og:url" content="${safeUrl}">
  <meta property="og:image" content="https://seheemynamez.github.io/og-image.svg">
  <meta property="og:locale" content="ko_KR">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${t}">
  <meta name="twitter:description" content="${d}">
  <meta name="twitter:image" content="https://seheemynamez.github.io/og-image.svg">

  <link rel="icon" type="image/svg+xml" href="https://seheemynamez.github.io/favicon.svg">

  <meta http-equiv="refresh" content="0; url=${safeUrl}">
  <script>setTimeout(function(){location.replace(${jsUrl});},50);</script>
  <style>body{font-family:system-ui,sans-serif;text-align:center;padding:40px;color:#776e65;}</style>
</head>
<body>
<p>2048 로 이동 중… <a href="${safeUrl}">자동 이동 안 되면 클릭</a></p>
</body>
</html>`;
};

// URL 형식: /i/2048 또는 /i/2048/{nick} 또는 /i/2048/{nick}/{score}
const makeShareHandler = ({ canonical2048Url }) => (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    // /i/2048(/...) 만 처리. 다른 path 는 404.
    if (!path.startsWith('/i/2048')) {
      res.writeHead(404); res.end(); return;
    }
    const parts = path.slice('/i/2048'.length).split('/').filter(Boolean);
    const nick  = parts[0] ? sanitizeNick(parts[0]) : '';
    const score = parts[1] ? sanitizeScore(parts[1]) : null;

    let base = canonical2048Url;
    if (!base) {
      const proto = (req.headers['x-forwarded-proto'] || 'http').toString().split(',')[0].trim();
      const host  = (req.headers['x-forwarded-host'] || req.headers.host || 'localhost').toString();
      base = `${proto}://${host}/2048/`;
    }
    if (!base.endsWith('/')) base += '/';
    const canonicalUrl = base;

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    });
    res.end(buildHtml({ nick, score: score || 0, canonicalUrl }));
  } catch {
    res.writeHead(500); res.end();
  }
};

module.exports = { makeShareHandler, sanitizeNick, sanitizeScore };
