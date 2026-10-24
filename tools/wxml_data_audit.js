// WXML 数据字段审计：{{...}} 里用到的顶层变量，必须在页面 data 或 setData 里出现过。
// 这类缺失的表现是页面上永远空白/undefined，但不会报编译错误。
//
// 用法：node tools/wxml_data_audit.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.wxml')) out.push(full);
  }
  return out;
}

// 从对象字面量里取顶层 key：跳过嵌套 {} [] 和字符串
function topLevelKeys(src, start) {
  const keys = [];
  let depth = 0, i = start, quote = null;
  let buf = '';

  function flushShorthand() {
    const key = buf.trim();
    if (/^[A-Za-z_$][\w$]*$/.test(key)) keys.push(key);
    buf = '';
  }

  for (; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    // 行注释：跳到行尾。不处理的话注释文本会拼进下一个 key，
    // 「值后带注释的字段」会被误判成未定义（raceText 踩过）
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') { depth++; if (depth === 1) continue; }
    else if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      if (depth === 0) { flushShorthand(); break; }
    }
    if (depth === 1) {
      if (ch === ',') { flushShorthand(); continue; }
      if (ch === ':') {
        const key = buf.trim().replace(/^['"]|['"]$/g, '');
        if (/^[A-Za-z_$][\w$]*$/.test(key)) keys.push(key);
        buf = '';
        continue;
      }
      if (ch === '\n' || ch === '\r') { if (!buf.trim()) continue; }
      buf += ch;
    }
  }
  return keys;
}

function collectDataKeys(jsSrc) {
  const keys = {};
  // data: { ... }
  const dataRe = /\bdata\s*:\s*\{/g;
  let m;
  while ((m = dataRe.exec(jsSrc))) {
    const start = m.index + m[0].length - 1;
    for (const k of topLevelKeys(jsSrc, start)) keys[k] = true;
  }
  // setData({ ... })
  const setRe = /setData\s*\(\s*\{/g;
  while ((m = setRe.exec(jsSrc))) {
    const start = m.index + m[0].length - 1;
    for (const k of topLevelKeys(jsSrc, start)) keys[k] = true;
  }
  return keys;
}

const KEYWORDS = {
  true: 1, false: 1, null: 1, undefined: 1, typeof: 1, Math: 1,
  wx: 1, item: 1, index: 1
};

const files = [];
walk(path.join(ROOT, 'pages'), files);
walk(path.join(ROOT, 'subpackages'), files);
// 自定义组件也必须审计：之前漏扫 components/，餐厅/生肖组件的
// WXML 绑定与数据字段从没被检查过
walk(path.join(ROOT, 'components'), files);

let allOk = true;
for (const wxml of files) {
  const js = wxml.replace(/\.wxml$/, '.js');
  if (!fs.existsSync(js)) continue;
  const wxmlSrc = fs.readFileSync(wxml, 'utf8');
  const jsSrc = fs.readFileSync(js, 'utf8');
  const dataKeys = collectDataKeys(jsSrc);

  // 自定义 wx:for-item 变量
  const loopVars = {};
  const loopRe = /wx:for-(?:item|index)\s*=\s*"([A-Za-z_$][\w$]*)"/g;
  let lm;
  while ((lm = loopRe.exec(wxmlSrc))) loopVars[lm[1]] = true;

  const missing = {};
  const exprRe = /\{\{([\s\S]*?)\}\}/g;
  let m;
  while ((m = exprRe.exec(wxmlSrc))) {
    let expr = m[1]
      .replace(/'(?:[^'\\]|\\.)*'/g, '""')
      .replace(/"(?:[^"\\]|\\.)*"/g, '""');
    // 取第一个出现、且前面不是 . 的标识符
    const idRe = /(^|[^.\w$])([A-Za-z_$][\w$]*)/g;
    let im;
    while ((im = idRe.exec(expr))) {
      const name = im[2];
      if (KEYWORDS[name] || loopVars[name]) continue;
      // 排除对象字面量 key（如 {a: 1}）
      const after = expr.slice(im.index + im[0].length).replace(/^\s+/, '');
      if (after[0] === ':') continue;
      if (!dataKeys[name]) missing[name] = true;
    }
  }
  const list = Object.keys(missing);
  if (list.length) {
    allOk = false;
    console.log('❌ ' + path.relative(ROOT, wxml) + ' 未定义的数据字段: ' + list.join(', '));
  }
}
check(allOk, '所有 WXML 数据字段都在 data/setData 里出现过');

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail > 0) {
  console.log('❌ WXML 数据字段审计未通过');
  process.exit(1);
}
console.log('✓ WXML 数据字段审计全部通过');
