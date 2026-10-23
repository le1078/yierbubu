// 小程序兼容性自检：验证所有 require 的相对路径真实存在。
//
// 背景：分包里引用主包 utils 需要多往上几级（subpackages/games/gomoku → ../../..）。
// 路径少写一级不会在 Node 里报错（Node 的模块解析与小程序不同），
// 只有在小程序运行时才抛
//   MiniProgramError: module 'xxx' is not defined, require args is '...'
// 整个页面白屏。
//
// 用法：node tools/wx_require_check.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['pages', 'components', 'subpackages', 'utils'];
const SKIP_DIRS = ['.git', '.preview', '.workbuddy', 'node_modules', '__pycache__'];

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.indexOf(name) !== -1 || name.indexOf('backup') === 0 || name === 'deploy') continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.js$/.test(name)) out.push(p);
  }
  return out;
}

// 去掉注释，避免把注释里写的 require 当成真的。
// 注意：不能把字符串内容替换成空/换引号 —— 后面还要靠 require('...') 提取路径，
// 破坏引号会让自己匹配不到。这里只处理注释，字符串原样保留。
function stripNoise(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const files = [];
SCAN_DIRS.forEach((d) => {
  const abs = path.join(ROOT, d);
  if (fs.existsSync(abs)) walk(abs, files);
});

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

let bad = 0;
for (const file of files) {
  const clean = stripNoise(fs.readFileSync(file, 'utf8'));
  const re = /require\('([^']+)'\)/g;
  let m;
  while ((m = re.exec(clean))) {
    const spec = m[1];
    if (spec.charAt(0) !== '.') continue;   // 跳过裸模块名
    const resolved = path.resolve(path.dirname(file), spec);
    if (!fs.existsSync(resolved)) {
      console.log('❌ ' + rel(file) + ' → ' + spec);
      console.log('     解析为 ' + rel(resolved) + '，文件不存在');
      bad++;
    }
  }
}

if (bad) {
  console.log('\n共 ' + bad + ' 处 require 路径错误（分包需往上多几级）');
  process.exit(1);
}
console.log('✓ require 路径检查通过（' + files.length + ' 个文件）');
