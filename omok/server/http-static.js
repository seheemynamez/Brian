// ============================================================
// HTTP 정적 파일 서빙 (omok/ 폴더)
// ============================================================

const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const makeStaticHandler = (root) => {
  const rootResolved = path.resolve(root);
  return (req, res) => {
    let urlPath = (req.url || '/').split('?')[0];
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = path.normalize(path.join(rootResolved, urlPath));
    // 경로 탈출 방지
    if (!filePath.startsWith(rootResolved + path.sep) && filePath !== rootResolved) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found: ' + urlPath);
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  };
};

module.exports = { makeStaticHandler };
