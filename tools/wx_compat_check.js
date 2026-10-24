// 小程序兼容性自检：找出会被 SWC 编译成 runtime helper 的语法。
//
// 背景：微信开发者工具的 es6→es5 编译走 SWC，数组解构/对象展开等语法会被编译成
//   require('@swc/runtime/_array_with_holes.js')
//   require('@swc/runtime/_object_spread.js')
// 等。小程序运行时不提供这些模块，一加载就抛
//   MiniProgramError: module '@swc/runtime/xxx.js' is not defined
// 表现为整个页面白屏。
//
// 注意：Node 原生支持这些语法，所以普通 node -c 和单元测试都发现不了，
// 必须靠这个静态扫描。
//
// 用法：node tools/wx_compat_check.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['pages', 'components', 'subpackages', 'utils'];

let problems = 0;

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.js$/.test(name)) out.push(p);
  }
  return out;
}

// 去掉注释和字符串，避免误报（注释里提到解构、字符串里含 ... 都不算）
function stripNoise(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')       // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')  // 行注释（避开 http:// ）
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''") // 单引号字符串
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""') // 双引号字符串
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');  // 模板字符串
}

const CHECKS = [
  {
    name: '数组解构（const/let/var [..] =）',
    helper: '@swc/runtime/_array_with_holes.js',
    re: /\b(?:const|let|var)\s*\[[^\]]*\]\s*=/g
  },
  {
    name: 'for-of 数组解构（for (const [a, b] of ..)）',
    helper: '@swc/runtime/_array_with_holes.js',
    re: /for\s*\(\s*(?:const|let|var)\s*\[[^\]]*\]\s+of\s/g
  },
  {
    name: '对象展开（{ ...expr }）',
    helper: '@swc/runtime/_object_spread.js',
    re: /\{\s*\.\.\./g
  },
  {
    name: '数组展开（[...expr]）',
    helper: '@swc/runtime/_array_with_holes.js',
    re: /\[\s*\.\.\./g
  },
  {
    name: '函数调用展开（fn(...expr)）',
    helper: '@swc/runtime/_array_with_holes.js',
    re: /\(\s*\.\.\./g
  },
  {
    // 项目约定：这两个语法在部分基础库版本的 SWC 产物上行为不稳定，
    // 统一用显式判空代替（不是语法糖禁令，是踩过坑后的保守选择）
    name: '可选链（a?.b / a?.[x] / a?.(x)）',
    helper: '旧基础库上可能编译失败或行为不一致',
    re: /\?\.[A-Za-z_\[(]/g
  },
  {
    name: '空值合并（a ?? b）',
    helper: '旧基础库上可能编译失败或行为不一致',
    re: /\?\?/g
  }
];

const files = [];
SCAN_DIRS.forEach((d) => {
  const abs = path.join(ROOT, d);
  if (fs.existsSync(abs)) walk(abs, files);
});

for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const clean = stripNoise(fs.readFileSync(file, 'utf8'));
  const lines = clean.split('\n');

  lines.forEach((line, i) => {
    for (const chk of CHECKS) {
      chk.re.lastIndex = 0;
      if (chk.re.test(line)) {
        console.log(`❌ ${rel}:${i + 1}  ${chk.name}`);
        console.log(`     → 会被编译成 require('${chk.helper}')，小程序运行时不提供，页面白屏`);
        console.log(`     ${line.trim().slice(0, 100)}`);
        problems++;
      }
    }
  });
}

if (problems) {
  console.log(`\n共 ${problems} 处不兼容，请改用索引访问 / Object.assign`);
  process.exit(1);
}
console.log(`\n✓ 小程序兼容性检查通过（${files.length} 个文件）`);
