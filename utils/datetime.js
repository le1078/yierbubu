// 日期时间工具：集中管理 pad / todayStr / nowStr，替代各页面重复实现
function pad(n) { return n < 10 ? '0' + n : '' + n; }

// 补零到指定位数（如房间号 4 位）
function pad4(n) { return String(n).padStart(4, '0'); }

// 本地日期 YYYY-MM-DD
function todayStr(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// 本地时间 YYYY-MM-DD HH:MM
function nowStr(d) {
  d = d || new Date();
  return todayStr(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// 时间戳 -> YYYY-MM-DD HH:MM
function fmtTime(ts) {
  if (!ts) return '';
  return nowStr(new Date(ts));
}

// 时间戳 -> M月D日
function monthDay(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

// 金额格式化：保留两位小数，非法值归零
function money(v) {
  const n = parseFloat(v);
  return isNaN(n) ? '0.00' : n.toFixed(2);
}

module.exports = {
  pad, pad4, todayStr, nowStr, fmtTime, monthDay, money
};
