// WXML 列表 key 检查：每个 wx:for 都必须配 wx:key。
// 缺 key 会让微信按索引复用节点 —— 列表顺序变化时节点状态会错位
// （动画重播、输入框串值），开发者工具也会刷 duplicate key 警告。
//
// 用法：node tools/wxml_key_check.js

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
    else if (name.endsWith('.wxml')) out.push(full);
  }
  return out;
}

const files = [];
walk(path.join(ROOT, 'pages'), files);
walk(path.join(ROOT, 'components'), files);
walk(path.join(ROOT, 'subpackages'), files);

console.log('检查 ' + files.length + ' 个 wxml 的列表 key：');
let bad = 0;
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  let idx = 0;
  while ((idx = s.indexOf('wx:for=', idx)) !== -1) {
    // 取整个标签（属性值里的 ">" 要跳过）
    let end = idx;
    let q = null;
    while (end < s.length) {
      const c = s[end];
      if (q) { if (c === q) q = null; }
      else if (c === '"' || c === "'") q = c;
      else if (c === '>') break;
      end++;
    }
    const tag = s.slice(idx, end);
    if (tag.indexOf('wx:key') === -1) {
      const line = s.slice(0, idx).split('\n').length;
      const m = s.slice(idx).match(/wx:for="\{\{([^}]+)\}\}"/);
      console.log('  ❌ ' + path.relative(ROOT, f) + ':' + line +
        '  wx:for="' + (m ? m[1] : '?') + '" 缺少 wx:key');
      bad++;
    }
    idx = end;
  }
}
if (!bad) { pass++; console.log('  ✓ 所有 wx:for 都带 wx:key'); }
else fail++;

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('❌ WXML key 检查未通过');
  process.exit(1);
}
console.log('✓ WXML key 检查全部通过');
