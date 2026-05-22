// ============================================================
// 구조화 로깅 — `[event] key=value` 형식 (omok 의 log.js 와 동일)
// ============================================================
'use strict';

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
