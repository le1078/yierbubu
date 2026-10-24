// 资源引用审计：
//   1) wxml / js 里静态写死的图片路径（/assets/...、/subpackages/...）必须存在
//   2) 页面/组件 json 里的 usingComponents 路径必须能解析到 .js/.json/.wxml
//   3) app.json 的 tabBar 图标必须存在
// 缺文件不会报错，页面上只是空白/裂图，肉眼很容易漏。
//
// 用法：node tools/assets_check.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const problems = [];

function check(cond, name) {
  if (cond) { pass++; return true; }
  fail++;
  problems.push(name);
  console.log('  ❌ ' + name);
  return false;
}

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

const wxmls = [];
walk(path.join(ROOT, 'pages'), ['.wxml'], wxmls);
walk(path.join(ROOT, 'components'), ['.wxml'], wxmls);
walk(path.join(ROOT, 'subpackages'), ['.wxml'], wxmls);

const jss = [];
walk(path.join(ROOT, 'pages'), ['.js'], jss);
walk(path.join(ROOT, 'components'), ['.js'], jss);
walk(path.join(ROOT, 'subpackages'), ['.js'], jss);

// ---- 1) 静态图片路径 ----
let refCount = 0;
const missingAssets = {};
function checkAsset(p, from) {
  if (!p || p.indexOf('/') !== 0) return;          // 只检查以 / 开头的应用内绝对路径
  if (p.indexOf('{{') !== -1) return;              // 动态路径跳过
  if (/^(cloud|http|wxfile|data):/.test(p)) return; // 远程/临时文件跳过
  refCount++;
  const full = path.join(ROOT, p.replace(/^\//, ''));
  if (!fs.existsSync(full)) {
    const key = p + ' ← ' + from;
    if (!missingAssets[key]) { missingAssets[key] = true; console.log('  ❌ 缺文件 ' + key); }
  }
}

for (const f of wxmls) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(ROOT, f);
  // src="/..." / poster="/..." / background 等
  const re = /\b(?:src|poster)\s*=\s*"(\/[^"]*)"/g;
  let m;
  while ((m = re.exec(src))) checkAsset(m[1], rel);
}

for (const f of jss) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(ROOT, f);
  // 只认 '/assets/...' '/subpackages/...' 这样的图片扩展名路径
  const re = /'(\/(?:assets|subpackages|pages|components)\/[^']+\.(?:png|jpg|jpeg|gif|webp|svg))'/g;
  let m;
  while ((m = re.exec(src))) checkAsset(m[1], rel);
}

console.log('  检查了 ' + refCount + ' 处静态图片引用');
check(Object.keys(missingAssets).length === 0,
  '代码引用的静态图片都存在（共检查 ' + refCount + ' 处引用）');

// ---- 2) usingComponents ----
const jsons = [];
walk(path.join(ROOT, 'pages'), ['.json'], jsons);
walk(path.join(ROOT, 'components'), ['.json'], jsons);
walk(path.join(ROOT, 'subpackages'), ['.json'], jsons);

let compCount = 0;
const badComp = [];
for (const f of jsons) {
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {
    badComp.push(path.relative(ROOT, f) + '（JSON 解析失败）');
    continue;
  }
  const using = cfg.usingComponents || {};
  for (const tag of Object.keys(using)) {
    const target = using[tag];
    compCount++;
    if (/^plugin:|^weui-/.test(target)) continue;
    // target 形如 /components/x/x 或 ../../components/x/x
    const abs = target.charAt(0) === '/'
      ? path.join(ROOT, target.slice(1))
      : path.resolve(path.dirname(f), target);
    const ok = fs.existsSync(abs + '.js') && fs.existsSync(abs + '.json') && fs.existsSync(abs + '.wxml');
    if (!ok) badComp.push(path.relative(ROOT, f) + ' → ' + target);
  }
}
console.log('  检查了 ' + compCount + ' 个 usingComponents 声明');
check(badComp.length === 0, '所有 usingComponents 路径可解析（共 ' + compCount + ' 个）' +
  (badComp.length ? '：' + badComp.join('; ') : ''));

// ---- 3) tabBar 图标 ----
const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const tabs = (app.tabBar && app.tabBar.list) || [];
let tabIcons = 0;
const badIcons = [];
for (const t of tabs) {
  for (const k of ['iconPath', 'selectedIconPath']) {
    if (!t[k]) continue;
    tabIcons++;
    if (!fs.existsSync(path.join(ROOT, t[k]))) badIcons.push(t[k]);
  }
}
check(badIcons.length === 0, 'tabBar 图标都存在（共 ' + tabIcons + ' 个）' +
  (badIcons.length ? '：' + badIcons.join(',') : ''));

// ---- 4) app.json 页面文件完整性 ----
const pages = (app.pages || []).slice();
for (const sub of app.subpackages || []) {
  for (const p of sub.pages || []) pages.push(sub.root.replace(/\/$/, '') + '/' + p);
}
const badPages = [];
for (const p of pages) {
  for (const ext of ['.js', '.json', '.wxml']) {
    if (!fs.existsSync(path.join(ROOT, p + ext))) badPages.push(p + ext);
  }
}
check(badPages.length === 0, 'app.json 里 ' + pages.length + ' 个页面的 js/json/wxml 都齐全' +
  (badPages.length ? '：缺 ' + badPages.join(',') : ''));

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('失败明细：');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('✓ 资源引用审计全部通过');
