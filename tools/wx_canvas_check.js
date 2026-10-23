// canvas 尺寸一致性静态检查。
//
// 背景（线上踩过的坑）：页面里 canvas 有三个尺寸来源，
//   1. wxml 的 style="width:{{boardW}}px"     —— CSS 显示尺寸
//   2. canvas.width = <某值> * dpr             —— 物理像素尺寸
//   3. _drawBoard/_render 里的 W / viewW       —— 绘制坐标系尺寸
// 三者必须用同一个变量。一旦不一致（比如一个用 info.size、一个用 this.data），
// 绘制内容就会超出画布被切掉，或被压缩/拉伸出现放射状斜线。
//
// 本检查做两件事：
//   A. 找出页面里所有「设置 canvas.width/height」的地方，记录用到的变量名
//   B. 找出「绘制函数」里的 W / viewW / boardW 取值，确认用的是同一变量
//   C. 提醒：若存在 info.size.width 参与尺寸计算，视为高风险（易与 wxml 不同步）
//
// 用法：node tools/wx_canvas_check.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['pages', 'components', 'subpackages'];

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (name === '.git' || name === 'node_modules' || name.startsWith('backup')) continue;
      walk(p, out);
    } else if (/\.js$/.test(name)) out.push(p);
  }
  return out;
}

function stripNoise(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\\n]|\\.)*`/g, '``');
}

const files = [];
SCAN_DIRS.forEach(d => {
  const abs = path.join(ROOT, d);
  if (fs.existsSync(abs)) walk(abs, files);
});

let problems = 0;
let checked = 0;

for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const raw = fs.readFileSync(file, 'utf8');
  const src = stripNoise(raw);

  // 只关心设置 canvas 尺寸的文件
  if (!/canvas\.width\s*=/.test(src)) continue;
  checked++;

  // A. 记录 canvas.width = <expr> * dpr 里 expr 涉及的标识符
  const widthRe = /canvas\.width\s*=\s*([^;]+);/g;
  const widthExprs = [];
  let m;
  while ((m = widthRe.exec(src))) widthExprs.push(m[1].trim());

  // B. 高风险：info.size 参与尺寸
  if (/info\.size/.test(src)) {
    const lineNo = src.slice(0, src.indexOf('info.size')).split('\n').length;
    console.log('⚠️  ' + rel + ':' + lineNo + '  使用了 info.size 参与 canvas 尺寸');
    console.log('     info.size 与 wxml 的 style 值可能不同步，导致内容溢出画布。');
    console.log('     建议：统一用 this.data.xxx（即 wxml 的 {{xxx}}）作为唯一尺寸源。');
    problems++;
  }

  // C. 找出绘制函数里的尺寸取值，确认与 widthExpr 一致
  //    约定：若 widthExpr 含 this._bw，则绘制里也应出现 this._bw
  const usesBw = widthExprs.some(e => /\b_bw\b/.test(e));
  const usesDataBoard = widthExprs.some(e => /this\.data\.boardW/.test(e));
  const usesBoardW = widthExprs.some(e => /\bboardW\b/.test(e));
  const usesDataCanvas = widthExprs.some(e => /this\.data\.canvasW/.test(e));

  // 检查 _drawBoard / _render 里是否混用了另一套变量
  const drawFnRe = /(_drawBoard|_render|drawFrame)\s*\([^)]*\)\s*\{/g;
  while ((m = drawFnRe.exec(src))) {
    const fnName = m[1];
    // 取函数体（粗略匹配到下一个顶层 })
    const start = m.index + m[0].length;
    const body = src.slice(start, start + 3000);
    // 函数体内若出现 this.data.boardW 但 widthExpr 用的是 _bw → 不一致
    if (usesBw && /this\.data\.boardW/.test(body)) {
      console.log('❌ ' + rel + '  ' + fnName + '() 里混用了 this.data.boardW，而 canvas.width 用的是 this._bw');
      console.log('     两者不一致会导致绘制坐标系与画布物理尺寸错位（内容被切边/拉伸）。');
      problems++;
    }
    if (usesDataBoard && /this\._bw/.test(body)) {
      console.log('❌ ' + rel + '  ' + fnName + '() 里混用了 this._bw，而 canvas.width 用的是 this.data.boardW');
      problems++;
    }
  }
}

if (problems) {
  console.log('\n共 ' + problems + ' 处风险（canvas 尺寸源不一致）');
  process.exit(1);
}
console.log('\n✓ canvas 尺寸一致性检查通过（检查了 ' + checked + ' 个设置 canvas 尺寸的文件）');
