// 样式类名审计：wxml 里静态书写的 class 必须在对应 wxss 里定义过。
// 拼错类名不会报错，只是"没样式"——布局塌了也说不清原因，肉眼很难发现。
//
// 规则（按小程序作用域）：
//   页面 wxml  → 同名 wxss + app.wxss
//   组件 wxml  → 同名 wxss + app.wxss
// 含 {{ }} 的动态类名跳过（无法静态确定）。
//
// 用法：node tools/wxss_class_check.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;

function walk(dir, exts, out) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'backup-20260830') continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

// 从 wxss 里提取类选择器名
function classesOf(file) {
  const set = {};
  if (!fs.existsSync(file)) return set;
  const src = fs.readFileSync(file, 'utf8');
  // 去掉注释，避免注释里的 .xxx 被当成定义
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /\.([A-Za-z_][\w-]*)/g;
  let m;
  while ((m = re.exec(clean))) set[m[1]] = true;
  return set;
}

const appCss = classesOf(path.join(ROOT, 'app.wxss'));
// 纯结构包裹类：只作为 wx:if 分支的语义标记，刻意不加样式
// （加了反而会改变各页已调好的间距）。审计时放行。
const STRUCTURAL = { menu: 1, lobby: 1, waiting: 1, game: 1 };

const wxmls = [];
walk(path.join(ROOT, 'pages'), ['.wxml'], wxmls);
walk(path.join(ROOT, 'components'), ['.wxml'], wxmls);
walk(path.join(ROOT, 'subpackages'), ['.wxml'], wxmls);

let problems = 0;
console.log('检查 ' + wxmls.length + ' 个 wxml 的静态 class：');
for (const f of wxmls) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(ROOT, f);
  const cssFile = f.replace(/\.wxml$/, '.wxss');
  const defined = Object.assign({}, appCss, classesOf(cssFile));
  // 分包/组件可能复用同目录其它 wxss？不做跨文件查找，保持严格

  const missing = {};
  // 匹配 class="..." / class='...'（只取静态文本）
  const re = /class\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(src))) {
    const raw = m[2] !== undefined ? m[2] : m[3];
    if (raw.indexOf('{{') !== -1) continue;   // 动态类名，跳过整条
    const tokens = raw.split(/\s+/);
    for (const t of tokens) {
      if (!t) continue;
      if (t.indexOf('{{') !== -1 || t.indexOf('}}') !== -1) continue;
      if (!/^[A-Za-z_][\w-]*$/.test(t)) continue;
      if (STRUCTURAL[t]) continue;
      if (!defined[t]) missing[t] = true;
    }
  }
  const list = Object.keys(missing);
  if (list.length) {
    problems += list.length;
    console.log('  ❌ ' + rel + ' 使用了未定义的 class: ' + list.join(', '));
  }
}

if (!problems) {
  pass++;
  console.log('  ✓ 所有静态 class 都有对应样式定义');
} else fail++;

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('❌ 样式类名审计未通过');
  process.exit(1);
}
console.log('✓ 样式类名审计全部通过');
