// ============================================================
// 초대 링크 동적 OG 렌더링 — /i/CODE?n=NICK
// ============================================================
// 메신저(카톡/디스코드/슬랙 등) 크롤러 봇이 가져갈 OG 메타 태그를 동적으로 응답한다.
// 사람이 클릭하면 meta refresh + JS 로 canonical 게임 URL 로 리다이렉트.
//
//   봇  : og:title/description/url 등 메타만 읽고 끝 (보통 redirect 안 따라감)
//   사람: 새 탭에서 잠깐 stub 페이지가 보였다가 곧바로 실제 게임 화면으로 이동
//
// canonical 타깃은 env var CANONICAL_OMOK_URL 로 주입. 미설정 시(로컬 개발) 같은 origin 사용.
// ============================================================

const MAX_NICK_LEN = 12;
const CODE_RE      = /^[A-Z0-9]{1,8}$/; // 서버 genCode 는 4자지만 보수적으로 8자까지 허용

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const sanitizeNick = (raw) => {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, MAX_NICK_LEN);
};

const sanitizeCode = (raw) => {
  if (typeof raw !== 'string') return '';
  const c = raw.toUpperCase().trim();
  return CODE_RE.test(c) ? c : '';
};

const buildTexts = (code, nick) => {
  if (nick) {
    return {
      title: `${nick}님이 오목대전을 신청했어요`,
      desc:  `방 코드 ${code} · 지금 들어가서 같이 두기`,
    };
  }
  return {
    title: `오목대전 초대장 (방 ${code})`,
    desc:  `방 코드 ${code} · 클릭해서 입장`,
  };
};

const renderInviteHtml = ({ code, nick, canonicalUrl }) => {
  const { title, desc } = buildTexts(code, nick);
  const t = escapeHtml(title);
  const d = escapeHtml(desc);
  const safeUrl = escapeHtml(canonicalUrl);
  // 사람용 redirect URL 은 JS 에 그대로 들어가야 하므로 JSON 직렬화로 인용/이스케이프.
  const jsUrl = JSON.stringify(canonicalUrl);

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <title>${t}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0b0a1f">
  <meta name="color-scheme" content="dark">
  <meta name="robots" content="noindex, follow">
  <link rel="canonical" href="${safeUrl}">

  <!-- Open Graph (메신저 프리뷰가 읽는 메인 신호) -->
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Sehee's Mini Games">
  <meta property="og:title" content="${t}">
  <meta property="og:description" content="${d}">
  <meta property="og:url" content="${safeUrl}">
  <meta property="og:image" content="https://seheemynamez.github.io/og-image.svg">
  <meta property="og:locale" content="ko_KR">

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${t}">
  <meta name="twitter:description" content="${d}">
  <meta name="twitter:image" content="https://seheemynamez.github.io/og-image.svg">

  <link rel="icon" type="image/svg+xml" href="https://seheemynamez.github.io/favicon.svg">

  <!-- 사람용 redirect — 봇은 보통 무시 -->
  <meta http-equiv="refresh" content="0; url=${safeUrl}">

  <style>
    body {
      font-family: -apple-system, 'SF Pro Display', BlinkMacSystemFont,
                   system-ui, 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif;
      background: radial-gradient(ellipse at top, #1a1340, #0b0a1f 70%);
      color: #e8e6ff;
      min-height: 100vh;
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      text-align: center;
      line-height: 1.6;
      letter-spacing: -0.01em;
    }
    .stack { max-width: 380px; }
    h1 {
      font-size: 20px;
      font-weight: 800;
      margin: 0 0 10px;
      background: linear-gradient(135deg, #00e5ff, #b388ff 50%, #ff43a8);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    p { font-size: 14px; color: #b0a8d4; margin: 0 0 6px; }
    a { color: #00e5ff; text-decoration: none; border-bottom: 1px dashed currentColor; }
    a:hover { color: #b388ff; }
  </style>
</head>
<body>
  <main class="stack">
    <h1>오목대전 초대장</h1>
    <p>잠시 후 게임 화면으로 이동합니다…</p>
    <p>자동으로 이동되지 않으면 <a href="${safeUrl}">여기를 눌러주세요</a></p>
  </main>
  <script>
    // meta refresh 를 못 따라가는 환경 보조 (검색 봇은 meta refresh 만으로도 OK)
    location.replace(${jsUrl});
  </script>
</body>
</html>`;
};

const makeShareHandler = ({ canonicalOmokUrl } = {}) => {
  // /i/CODE 또는 /i/CODE/ 매칭
  const PATH_RE = /^\/i\/([A-Za-z0-9]{1,8})\/?$/;

  return (req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    const m = url.pathname.match(PATH_RE);
    if (!m) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const code = sanitizeCode(m[1]);
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Invalid invite code');
      return;
    }
    const nick = sanitizeNick(url.searchParams.get('n'));

    // canonical base 결정:
    //   1) 환경변수 우선 (운영: https://seheemynamez.github.io/Brian/omok/)
    //   2) 미설정 시 같은 origin 의 /omok/ 로 (로컬 개발)
    let base = canonicalOmokUrl;
    if (!base) {
      const proto = (req.headers['x-forwarded-proto'] || 'http').toString().split(',')[0].trim();
      const host  = (req.headers['x-forwarded-host'] || req.headers.host || 'localhost').toString();
      base = `${proto}://${host}/omok/`;
    }
    if (!base.endsWith('/')) base += '/';
    const canonicalUrl = `${base}?room=${encodeURIComponent(code)}`;

    const html = renderInviteHtml({ code, nick, canonicalUrl });
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      // 크롤러 캐시 효율 — 같은 (code, nick) 조합은 자주 변하지 않음
      'Cache-Control': 'public, max-age=300',
    });
    res.end(html);
  };
};

module.exports = { makeShareHandler };
