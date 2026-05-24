// ============================================================
// 구조화 로깅 — `[event] key=value key=value` 형식
// ============================================================
// Render 로그에서 사람이 읽기 쉬우면서 grep 도 쉬운 한 줄 포맷.
// 개인정보성(전체 clientId/sessionId, IP 등)은 mask 로 앞 8자만 남긴다.
//
// helper:
//   log.event(name, fields)  — info level (stdout)
//   log.warn(name, fields)   — warn level (stderr)
//   log.error(name, fields)  — error level (stderr)
//
// 모두 같은 `[name] k=v k=v` 포맷. monitor 의 render_search_logs 가 동일하게
// 파싱 가능. console.error/log/warn 직접 호출 대신 이걸 사용 — structured
// 일관성 (PR — N 항목).

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

const _build = (name, fields) => {
  let line = `[${name}]`;
  if (fields) {
    for (const k of Object.keys(fields)) {
      const v = fields[k];
      if (v === undefined) continue;
      line += ` ${k}=${fmt(v)}`;
    }
  }
  return line;
};

const event = (name, fields) => { console.log(_build(name, fields)); };
const warn  = (name, fields) => { console.warn(_build(name, fields)); };
const error = (name, fields) => { console.error(_build(name, fields)); };

module.exports = { event, warn, error, mask };
