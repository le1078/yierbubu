// WXML 结构校验：标签闭合、属性引号配对。
// 这类问题不会在 node 里报错，只有微信开发者工具编译时才炸（或静默渲染错乱），
// 所以必须静态查。做法是逐字符扫描（不能只用正则，属性值里可能含 ">"）。
//
// 用法：node tools/wxml_structure_check.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;

// WXML 里的自闭合 / 空标签
const VOID = { image: 1, input: 1, icon: 1, progress: 1, 'switch': 1, slider: 1,
  checkbox: 1, radio: 1, textarea: 1, 'import': 1, include: 1, wxs: 1, br: 1 };

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

// 扫描一个 wxml，返回问题列表
function scan(src) {
  const problems = [];
  const stack = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    // 注释
    if (ch === '<' && src.slice(i, i + 4) === '<!--') {
      const end = src.indexOf('-->', i + 4);
      if (end === -1) { problems.push('注释未闭合（位置 ' + i + '）'); break; }
      i = end + 3;
      continue;
    }
    if (ch !== '<') { i++; continue; }
    // 只有 '<' 后紧跟字母/'/'/'!' 才是标签；文案里的 '{{a < b}}' 之类不是
    const nxt = src[i + 1] || '';
    if (!/[a-zA-Z/!]/.test(nxt)) { i++; continue; }
    // 读到标签结束（跳过引号内的 >）
    let j = i + 1;
    let quote = null;
    while (j < n) {
      const c = src[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
      j++;
    }
    if (j >= n) { problems.push('标签未闭合（位置 ' + i + '）'); break; }
    const raw = src.slice(i + 1, j);
    const closing = raw[0] === '/';
    const selfClose = raw[raw.length - 1] === '/';
    const nameMatch = raw.replace(/^\//, '').match(/^([a-zA-Z][\w-]*)/);
    if (!nameMatch) { i = j + 1; continue; }
    const name = nameMatch[1];
    // 属性引号配对
    const body = raw.replace(/^\//, '');
    let q = null, badQuote = false;
    for (let k = 0; k < body.length; k++) {
      const c = body[k];
      if (q) { if (c === q) q = null; }
      else if (c === '"' || c === "'") q = c;
    }
    if (q) badQuote = true;
    if (badQuote) problems.push('<' + name + '> 属性引号未配对（位置 ' + i + '）');

    if (closing) {
      if (!stack.length) {
        problems.push('多余的结束标签 </' + name + '>（位置 ' + i + '）');
      } else {
        const top = stack.pop();
        if (top.name !== name) {
          problems.push('标签不匹配：<' + top.name + '> 被 </' + name + '> 关闭（位置 ' + i + '）');
        }
      }
    } else if (!selfClose) {
      stack.push({ name, at: i });
    }
    i = j + 1;
  }
  for (const s of stack) problems.push('未闭合标签 <' + s.name + '>（位置 ' + s.at + '）');
  return problems;
}

const files = [];
walk(path.join(ROOT, 'pages'), files);
walk(path.join(ROOT, 'components'), files);
walk(path.join(ROOT, 'subpackages'), files);

console.log('检查 ' + files.length + ' 个 wxml 文件：');
let bad = 0;
for (const f of files) {
  const rel = path.relative(ROOT, f);
  let src = '';
  try { src = fs.readFileSync(f, 'utf8'); } catch (e) {
    console.log('  ❌ 读取失败 ' + rel);
    bad++; fail++; continue;
  }
  const problems = scan(src);
  if (problems.length) {
    bad++;
    fail++;
    console.log('  ❌ ' + rel);
    for (const p of problems.slice(0, 6)) console.log('       ' + p);
  }
}
if (!bad) { pass++; console.log('  ✓ 所有 WXML 标签闭合、引号配对正确'); }

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('❌ WXML 结构检查未通过');
  process.exit(1);
}
console.log('✓ WXML 结构检查全部通过');
