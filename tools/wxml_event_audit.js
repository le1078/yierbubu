// WXML 事件绑定审计：WXML 里 bindtap/bindtouchend/... 指向的方法，
// 页面 JS 里必须真的存在。这类缺失在开发者工具里不会报编译错误，
// 只会在用户点击时抛 "is not a function"（象棋难度选择就是这样漏的）。
//
// 用法：node tools/wxml_event_audit.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

function walk(dir, out) {
  const list = fs.readdirSync(dir);
  for (const name of list) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith('.wxml')) out.push(full);
  }
  return out;
}

const files = [];
walk(path.join(ROOT, 'pages'), files);
walk(path.join(ROOT, 'subpackages'), files);
// 自定义组件也必须审计：之前漏扫 components/，餐厅/生肖组件的
// WXML 绑定与数据字段从没被检查过
walk(path.join(ROOT, 'components'), files);

console.log('');
console.log('扫描 ' + files.length + ' 个 WXML 页面');
console.log('');

let allOk = true;
const skipped = [];

for (const wxml of files) {
  const js = wxml.replace(/\.wxml$/, '.js');
  if (!fs.existsSync(js)) { skipped.push(path.relative(ROOT, wxml) + '（无同名 JS）'); continue; }
  const wxmlSrc = fs.readFileSync(wxml, 'utf8');
  const jsSrc = fs.readFileSync(js, 'utf8');
  const handlerRe = /\b(?:bind|catch):?([A-Za-z]+)\s*=\s*"([^"]+)"/g;
  const missing = [];
  let m;
  while ((m = handlerRe.exec(wxmlSrc))) {
    const handler = m[2].trim();
    if (!handler || handler.indexOf('{{') !== -1) continue;
    // Page 简写方法 / 属性函数 / 函数声明都算
    const re = new RegExp('(?:^|[\\s,{])' + handler.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      '\\s*(?:\\(|:\\s*(?:function|\\())', 'm');
    if (!re.test(jsSrc)) missing.push(handler);
  }
  if (missing.length) {
    allOk = false;
    console.log('❌ ' + path.relative(ROOT, wxml) + ' 缺少方法: ' + missing.join(', '));
  }
}

if (skipped.length) {
  console.log('跳过: ' + skipped.join('; '));
}
check(allOk, '所有 WXML 事件处理函数都在对应 JS 里定义');

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail > 0) {
  console.log('❌ WXML 事件绑定审计未通过');
  process.exit(1);
}
console.log('✓ WXML 事件绑定审计全部通过');
