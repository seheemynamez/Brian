// ============================================================
// 모듈-레벨 state — wss 참조 보관.
// 다른 sub-module 에서 wss 가 필요한 경우 getWss() 를 통해 가져간다.
// ============================================================

let wssRef = null;

const init = (wss) => { wssRef = wss; };
const getWss = () => wssRef;

module.exports = { init, getWss };
