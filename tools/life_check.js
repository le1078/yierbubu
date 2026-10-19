// 自检：WXML 里绑定的事件/引用是否都存在、标签是否闭合、图片资源是否存在
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pages = [
  'pages/life/life',
  'pages/restaurant/restaurant',
  'components/restaurant/restaurant'
];

let errors = 0;
const err = (m) => { errors++; console.log('  ✗ ' + m); };

function loadConfig(base) {
  let cfg = null;
  new Function('Page', 'Component', 'require', 'wx', 'getApp',
    fs.readFileSync(base + '.js', 'utf8'))(
    (c) => { cfg = c; },
    (c) => { cfg = c; },
    (r) => {
      const p = r.startsWith('.') ? path.resolve(path.dirname(base + '.js'), r) : r;
      const saved = global.wx;
      global.wx = {};
      const m = require(p);
      global.wx = saved;
      return m;
    },
    {},
    () => ({ globalData: {} })
  );
  return cfg;
}

function methodsOf(cfg) {
  const names = new Set(Object.keys(cfg).filter((k) => typeof cfg[k] === 'function'));
  if (cfg.methods) Object.keys(cfg.methods).forEach((k) => {
    if (typeof cfg.methods[k] === 'function') names.add(k);
  });
  return names;
}

for (const rel of pages) {
  const base = path.join(ROOT, rel);
  console.log('\n▶ ' + rel);
  const wxml = fs.readFileSync(base + '.wxml', 'utf8');
  const cfg = loadConfig(base);
  const methods = methodsOf(cfg);

  // 1) 事件绑定
  const bound = new Set();
  const evRe = /\b(?:bind|catch|capture-bind|capture-catch)[:\w-]*\s*=\s*"([^"{}]+)"/g;
  let m;
  while ((m = evRe.exec(wxml))) bound.add(m[1].trim());
  bound.forEach((fn) => {
    if (!methods.has(fn)) err(`事件处理函数不存在: ${fn}`);
  });

  // 2) 标签闭合
  const tags = [];
  const stack = [];
  let i = 0;
  while (i < wxml.length) {
    if (wxml.startsWith('<!--', i)) { i = wxml.indexOf('-->', i); i = i === -1 ? wxml.length : i + 3; continue; }
    if (wxml[i] === '<') {
      const close = wxml.indexOf('>', i);
      if (close === -1) break;
      const raw = wxml.slice(i + 1, close);
      if (raw.startsWith('/')) {
        const name = raw.slice(1).trim();
        const top = stack.pop();
        if (top !== name) err(`标签闭合不匹配: </${name}> 期望 </${top}>`);
      } else if (!/\/\s*$/.test(raw)) {
        stack.push(raw.split(/\s/)[0]);
      }
      i = close + 1;
      continue;
    }
    i++;
  }
  if (stack.length) err('未闭合标签: ' + stack.join(', '));

  // 3) 静态资源
  const imgRe = /src\s*=\s*"(\/assets\/[^"{}]+)"/g;
  while ((m = imgRe.exec(wxml))) {
    const p = path.join(ROOT, m[1].slice(1));
    if (!fs.existsSync(p)) err('图片不存在: ' + m[1]);
  }

  // 4) 数据字段（顶层 data 名）粗查：先去掉字符串字面量与对象字面量的键名
  const data = cfg.data || {};
  const dataKeys = new Set(Object.keys(data));
  const refRe = /\{\{([^}]+)\}\}/g;
  while ((m = refRe.exec(wxml))) {
    let expr = m[1];
    // 去掉 '...' / "..." / `...` 里的内容，避免把样式类名当成变量
    expr = expr.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, ' ');
    // 去掉 ? : 之后常见的字面量分支已随字符串一并清掉
    // 只检查「根变量」：前面不是 '.' 的标识符（item.title 里的 title 不算）
    const ids = [];
    const rootRe = /(^|[^.\w$])([a-zA-Z_$][\w$]*)/g;
    let r;
    while ((r = rootRe.exec(expr))) ids.push(r[2]);
    const local = new Set(['item', 'it', 'index', 'true', 'false', 'null', 'undefined', 'length', 'Math']);
    ids.forEach((id) => {
      if (local.has(id)) return;
      if (!dataKeys.has(id)) err(`data 中缺少字段: ${id}（表达式 {{${m[1].trim()}}}）`);
    });
  }
  console.log(`  事件 ${bound.size} 个 / data 字段 ${dataKeys.size} 个`);
}

console.log(errors ? `\n共 ${errors} 处问题` : '\n全部通过 ✓');
process.exit(errors ? 1 : 0);
