// 小程序包体积校验：主包 ≤ 2MB、单分包 ≤ 2MB、总计 ≤ 20MB（微信官方限制）。
// 超限时上传会直接失败，而开发者工具里不一定显眼提示 —— 提交前先算一遍。
//
// 算法：按 project.config.json 的 packOptions.ignore 排除不需要上传的文件，
// 再按 app.json 的分包配置分别累加。
//
// 用法：node tools/package_size_check.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); return true; }
  fail++;
  console.log('  ❌ ' + name);
  return false;
}

const proj = JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'));
const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const ignores = (proj.packOptions && proj.packOptions.ignore) || [];

// 判断相对路径是否被 ignore 命中
function ignored(rel) {
  const norm = rel.split(path.sep).join('/');
  for (const rule of ignores) {
    const v = String(rule.value || '');
    if (rule.type === 'suffix') {
      if (norm.endsWith(v)) return true;
    } else if (rule.type === 'file') {
      if (norm === v || norm.endsWith('/' + v)) return true;
    } else if (rule.type === 'folder') {
      if (norm === v || norm.indexOf(v + '/') === 0 || norm.indexOf('/' + v + '/') !== -1) return true;
    }
  }
  // 隐藏目录与依赖目录一律不上传
  if (norm.indexOf('.git/') === 0 || norm.indexOf('node_modules/') !== -1) return true;
  if (norm.indexOf('.zcode/') === 0) return true;
  return false;
}

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    const rel = path.relative(ROOT, full);
    if (ignored(rel)) continue;
    if (st.isDirectory()) walk(full, out);
    else out.push({ rel: rel.split(path.sep).join('/'), size: st.size });
  }
  return out;
}

// 注意：node_modules 在 server/ 下（已被 ignore），根目录若有也要排除
function walkSafe(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === '.zcode') continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    const rel = path.relative(ROOT, full);
    if (ignored(rel)) continue;
    if (st.isDirectory()) {
      for (const f of walkSafe(full)) out.push(f);
    } else {
      out.push({ rel: rel.split(path.sep).join('/'), size: st.size });
    }
  }
  return out;
}

const all = walkSafe(ROOT);
const subRoots = (app.subpackages || []).map((s) => s.root.replace(/\/$/, ''));

// 分包归属
const subSizes = {};
for (const r of subRoots) subSizes[r] = 0;
let mainSize = 0;
for (const f of all) {
  const sub = subRoots.find((r) => f.rel.indexOf(r + '/') === 0);
  if (sub) subSizes[sub] += f.size;
  else mainSize += f.size;
}
const total = all.reduce((a, f) => a + f.size, 0);

const mb = (n) => (n / 1024 / 1024).toFixed(2) + 'MB';

console.log('按 packOptions.ignore 计算实际上传体积：');
console.log('  主包: ' + mb(mainSize));
for (const r of subRoots) console.log('  分包 ' + r + ': ' + mb(subSizes[r]));
console.log('  合计: ' + mb(total));
console.log('');

check(mainSize <= 2 * 1024 * 1024,
  '主包 ≤ 2MB（当前 ' + mb(mainSize) + '，余量 ' + mb(2 * 1024 * 1024 - mainSize) + '）');
for (const r of subRoots) {
  check(subSizes[r] <= 2 * 1024 * 1024, '分包 ' + r + ' ≤ 2MB（当前 ' + mb(subSizes[r]) + '）');
}
check(total <= 20 * 1024 * 1024, '总计 ≤ 20MB（当前 ' + mb(total) + '）');

// 顺带提示体积最大的几个文件，方便以后优化
const big = all.slice().sort((a, b) => b.size - a.size).slice(0, 5);
console.log('\n最大的 5 个文件：');
for (const f of big) console.log('  ' + (f.size / 1024).toFixed(0) + 'KB  ' + f.rel);

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('❌ 包体积超出微信限制，上传会失败');
  process.exit(1);
}
console.log('✓ 包体积校验通过');
