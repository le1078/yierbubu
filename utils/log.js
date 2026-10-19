// 日志收口：生产环境静默，开发时可开
// 用法：log.d('tag', ...)   —— 默认关闭，需要时设全局开关
var _enabled = false;

function d() {
  if (!_enabled) return;
  // eslint-disable-next-line no-console
  console.log.apply(console, ['[dev]'].concat([].slice.call(arguments)));
}

function e() {
  // eslint-disable-next-line no-console
  console.error.apply(console, ['[err]'].concat([].slice.call(arguments)));
}

function setEnabled(v) { _enabled = !!v; }

module.exports = { d, e, setEnabled };
