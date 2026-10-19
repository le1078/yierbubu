// 金额输入清洗：只留数字和一个小数点，空串/'0.' 等中间态放行
// 返回值已保证 parseFloat 可安全解析（除非空串）
function sanitizeAmount(v) {
  let s = String(v == null ? '' : v).replace(/[^\d.]/g, '');
  // 只保留第一个小数点
  const i = s.indexOf('.');
  if (i !== -1) {
    s = s.slice(0, i + 1) + s.slice(i + 1).replace(/\./g, '');
  }
  // 去掉前导零（保留 0.xx）
  if (s.length > 1 && s[0] === '0' && s[1] !== '.') {
    s = s.replace(/^0+/, '');
  }
  return s;
}

// 解析为数字，非法值返回 fallback（默认 0）
function toAmount(v, fallback) {
  const n = parseFloat(v);
  return isNaN(n) ? (fallback === undefined ? 0 : fallback) : n;
}

module.exports = { sanitizeAmount, toAmount };
