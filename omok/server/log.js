// ============================================================
// 구조화 로깅 — `[event] key=value key=value` 형식
// ============================================================
// Render 로그에서 사람이 읽기 쉬우면서 grep 도 쉬운 한 줄 포맷.
// 개인정보성(전체 clientId/sessionId, IP 등)은 mask 로 앞 8자만 남긴다.

const mask = (id) => {
  if (!id || typeof id !== 'string') return '?';
  return id.length <= 8 ? id : id.slice(0, 8);
};

const fmt = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  return /[\s="]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
};

const event = (name, fields) => {
  let line = `[${name}]`;
  if (fields) {
    for (const k of Object.keys(fields)) {
      const v = fields[k];
      if (v === undefined) continue;
      line += ` ${k}=${fmt(v)}`;
    }
  }
  console.log(line);
};

module.exports = { event, mask };
