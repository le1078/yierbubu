// 静态检查：页面/组件里 this.foo(...) 调用的方法必须真的定义过。
// 这类笔误（改名字、删方法后忘改调用点）只有在用户点到那一屏时才报
// "this.xxx is not a function"，测试跑不到就发现不了。这里做静态配对。
//
// 用法：node tools/js_method_check.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'backup-20260830') continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

// 平台/框架注入的、不属于页面自定义方法的名字
const BUILTIN = {
  setData: 1, data: 1, properties: 1, triggerEvent: 1, selectComponent: 1,
  selectAllComponents: 1, createSelectorQuery: 1, animate: 1, getTabBar: 1,
  hasBehavior: 1, groupSetData: 1, getOpenerEventChannel: 1, route: 1,
  __route__: 1, is: 1, id: 1, dataset: 1
};

const files = [];
walk(path.join(ROOT, 'pages'), files);
walk(path.join(ROOT, 'components'), files);
walk(path.join(ROOT, 'subpackages'), files);

let problems = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(ROOT, f);

  // 定义的方法：行首两空格 + 可选 async + 名字 + '('
  const defined = {};
  const defRe = /^\s{2,8}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = defRe.exec(src))) defined[m[1]] = true;

  // 自定义属性的“方法式”调用：this.foo(...)
  const callRe = /this\.([A-Za-z_$][\w$]*)\s*\(/g;
  const missing = {};
  while ((m = callRe.exec(src))) {
    const name = m[1];
    if (BUILTIN[name]) continue;
    if (defined[name]) continue;
    // this._x && this._x() 这种存在性判断也放过（动态注入的方法）
    const before = src.slice(Math.max(0, m.index - 80), m.index);
    if (/this\.\w+\s*&&\s*$/.test(before)) continue;
    if (/typeof\s+this\.\w+\s*===\s*/.test(before)) continue;
    missing[name] = true;
  }

  const list = Object.keys(missing);
  if (list.length) {
    problems += list.length;
    console.log('  ❌ ' + rel + ' 调用了未定义的方法: ' + list.join(', '));
  }
}
if (!problems) {
  pass++;
  console.log('  ✓ 所有 this.xxx() 调用都有对应的方法定义');
} else fail++;

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('❌ 方法调用检查未通过');
  process.exit(1);
}
console.log('✓ 方法调用检查全部通过');
