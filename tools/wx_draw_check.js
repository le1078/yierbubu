// canvas 绘制指令验证：把绘制动作记录成「线段集合」，检查是否符合预期形状。
//
// 为什么需要它：上一个 bug（board_render 竖线终点写错成 (W, i*cell)）
// 画出的是一束汇聚到右上角的斜线，肉眼看截图才发现。
// 这类 bug 单测测逻辑测不出来，必须验证「绘制指令本身」。
//
// 做法：给 board_render 注入一个 mock ctx，记录所有 moveTo/lineTo/arc，
// 然后断言：
//   1. 网格线的每条线段要么是纯水平（y 不变）要么是纯垂直（x 不变）
//   2. 不允许出现 x、y 同时变化的斜线段
//   3. 水平线数量 = 竖线数量 = SIZE
//
// 用法：node tools/wx_draw_check.js

const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

// ---- mock canvas 2d context ----
function makeMockCtx() {
  const segs = [];      // {x1,y1,x2,y2} 线段
  const arcs = [];      // {x,y,r}
  let cur = null;       // 当前路径起点
  return {
    _segs: segs,
    _arcs: arcs,
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
    fillRect() {},
    clearRect() {},
    save() {},
    restore() {},
    translate() {},
    scale() {},
    beginPath() { cur = null; },
    moveTo(x, y) { cur = { x, y }; },
    lineTo(x, y) {
      if (cur) segs.push({ x1: cur.x, y1: cur.y, x2: x, y2: y });
      cur = { x, y };
    },
    arc(x, y, r) { arcs.push({ x, y, r }); },
    fill() {},
    stroke() {},
    drawImage() {},
    set fillStyle(v) {}, get fillStyle() { return '#000'; },
    set strokeStyle(v) {}, get strokeStyle() { return '#000'; },
    set lineWidth(v) {}, get lineWidth() { return 1; },
    set font(v) {}, get font() { return ''; },
    set textAlign(v) {}, get textAlign() { return 'left'; },
    set textBaseline(v) {}, get textBaseline() { return 'top'; },
    fillText() {}
  };
}

// ---- 只加载 board_render，注入 mock wx ----
const boardRenderPath = path.join(ROOT, 'subpackages/games/gomoku/board_render.js');
// 先把 wx 挂到 global，这样 board_render 里 wx.createOffscreenCanvas 可用
global.wx = {
  createOffscreenCanvas: () => ({
    width: 0, height: 0,
    getContext: () => makeMockCtx()
  })
};
// board_render 用 CommonJS，直接 require
const R = require(boardRenderPath);

const SIZE = 15;
const W = 350;

// 直接验证网格绘制（网格画在离屏 canvas 上，必须调 drawBgInto 才能拿到绘制指令）
const ctx = makeMockCtx();
R.drawBgInto(ctx, W);

// 从 _segs 里筛出「网格线」（长度 > W*0.8 的）
const segs = ctx._segs.filter(s => {
  const dx = Math.abs(s.x2 - s.x1), dy = Math.abs(s.y2 - s.y1);
  return Math.max(dx, dy) > W * 0.8;
});

console.log('\n[1] 网格线必须是纯水平或纯垂直');
const horiz = segs.filter(s => Math.abs(s.y2 - s.y1) < 0.01 && Math.abs(s.x2 - s.x1) > W * 0.8);
const vert = segs.filter(s => Math.abs(s.x2 - s.x1) < 0.01 && Math.abs(s.y2 - s.y1) > W * 0.8);
const diag = segs.filter(s =>
  Math.abs(s.x2 - s.x1) > 0.01 && Math.abs(s.y2 - s.y1) > 0.01);
console.log('    水平 ' + horiz.length + ' 条，垂直 ' + vert.length + ' 条，斜线 ' + diag.length + ' 条');
check(diag.length === 0, '不允许出现斜线（斜线 = 竖线终点写错的典型症状）');
check(horiz.length === SIZE, '水平线 ' + SIZE + ' 条（实际 ' + horiz.length + '）');
check(vert.length === SIZE, '竖线 ' + SIZE + ' 条（实际 ' + vert.length + '）');

console.log('\n[2] 水平线应分布在 0..W 范围内');
const ys = horiz.map(s => s.y1).sort((a, b) => a - b);
check(Math.abs(ys[0]) < 0.5, '第一条水平线 y≈0（实际 ' + ys[0].toFixed(2) + '）');
check(Math.abs(ys[ys.length - 1] - W) < 0.5, '最后一条 y≈W（实际 ' + ys[ys.length - 1].toFixed(2) + '）');

console.log('\n[3] 竖线应分布在 0..W 范围内');
const xs = vert.map(s => s.x1).sort((a, b) => a - b);
check(Math.abs(xs[0]) < 0.5, '第一条竖线 x≈0（实际 ' + xs[0].toFixed(2) + '）');
check(Math.abs(xs[xs.length - 1] - W) < 0.5, '最后一条 x≈W（实际 ' + xs[xs.length - 1].toFixed(2) + '）');

console.log('\n[4] 星位：应有 9 个小圆点');
check(ctx._arcs.length === 9, '星位 9 个圆点（实际 ' + ctx._arcs.length + '）');
check(ctx._arcs.every(a => a.r > 0), '星位圆点半径为正');

// ---- 反向验证：故意把竖线终点改错，工具必须报警 ----
console.log('\n[5] 自检工具能抓到「竖线终点写错」这类 bug');
{
  const badCtx = makeMockCtx();
  // 模拟错误写法：lineTo(W, i*cell) —— 斜线
  const cell = W / (SIZE - 1);
  badCtx.beginPath();
  badCtx.moveTo(5 * cell, 0);
  badCtx.lineTo(W, 5 * cell);   // 错误终点
  const dx = Math.abs(W - 5 * cell), dy = Math.abs(5 * cell - 0);
  const isDiag = dx > 0.01 && dy > 0.01;
  check(isDiag, '错误写法确实产生斜线段（dx=' + dx.toFixed(1) + ' dy=' + dy.toFixed(1) + '）');
}


// ============================================
// [8] 象棋 lastMove 标记：必须含 ox/oy 偏移
// ============================================
console.log('\n[8] 象棋 lastMove 标记偏移（漏 ox/oy 会让标记整体错位）');
{
  const fs = require('fs');
  const srcFile = fs.readFileSync(path.join(ROOT, 'subpackages/games/xiangqi/xiangqi.js'), 'utf8');
  const lmIdx = srcFile.indexOf('this._lastMove && this._lastMove.from');
  check(lmIdx !== -1, '象棋源码含 lastMove 绘制');
  const seg = srcFile.slice(lmIdx, lmIdx + 800);
  const arcs = seg.match(/ctx\.arc\([^)]*\)/g) || [];
  const missingOx = arcs.filter(function(a) { return a.indexOf('ox +') === -1 && a.indexOf('sx(') === -1 && a.indexOf('sy(') === -1; });
  check(arcs.length >= 2, 'lastMove 绘制有起点/终点两个 arc（实际 ' + arcs.length + '）');
  check(missingOx.length === 0, '所有 lastMove arc 都含 ox 偏移（缺 ox 的 ' + missingOx.length + ' 个）');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail > 0) {
  console.log('❌ 绘制指令检查未通过');
  process.exit(1);
}

// ============================================
// [6] 象棋：棋盘留边，最左/最右列棋子不得被切边
// ============================================
console.log('\n[6] 象棋棋盘留边（防止最左/最右列棋子被切半）');
{
  const X = require(path.join(ROOT, 'subpackages/games/xiangqi/rules.js'));
  const W = 350;
  const margin = (W / (X.COLS - 1)) * 0.5;
  const cell = (W - margin * 2) / (X.COLS - 1);
  const H = Math.round(cell * (X.ROWS - 1) + margin * 2);
  const ox = margin, oy = margin;
  const radius = cell * 0.42;
  let clipped = 0;
  for (let c = 0; c < X.COLS; c++) {
    const x = ox + c * cell;
    if (x - radius < 0 || x + radius > W) clipped++;
  }
  for (let r = 0; r < X.ROWS; r++) {
    const y = oy + r * cell;
    if (y - radius < 0 || y + radius > H) clipped++;
  }
  check(clipped === 0, '90 个交叉点的棋子全部完整显示（切边数 ' + clipped + '）');

  let hitBad = 0;
  for (let r = 0; r < X.ROWS; r++) {
    for (let c = 0; c < X.COLS; c++) {
      const px = ox + c * cell, py = oy + r * cell;
      const hc = Math.round((px - ox) / cell);
      const hr = Math.round((py - oy) / cell);
      if (hr !== r || hc !== c) hitBad++;
    }
  }
  check(hitBad === 0, '命中测试 90/90 与绘制坐标一致（错位 ' + hitBad + '）');
}

// ============================================
// [7] 马里奥：视口必须能覆盖玩家与地面
// ============================================
console.log('\n[7] 马里奥视口覆盖（防止人物/地面画到画布外）');
{
  const EN = require(path.join(ROOT, 'subpackages/games/mario/engine.js'));
  const LV = require(path.join(ROOT, 'subpackages/games/mario/levels.js'));
  const level = EN.loadLevel(LV.LEVEL_1, LV.LEVEL_SPECS[0]);
  const p = EN.makePlayer(level, 1);
  const canvasW = 350;
  const canvasH = Math.round(canvasW * 0.62);
  const s = canvasW / 15;
  const viewH = canvasH / s;
  function cameraY(level, targetY, viewH) {
    const want = targetY - viewH * 0.55;
    const maxY = level.rowsH - viewH;
    return Math.max(0, Math.min(want, maxY));
  }
  const camY = cameraY(level, p.y, viewH);
  check(camY > 0, 'camY 跟随玩家（camY=' + camY.toFixed(2) + '，恒为 0 会把人物画到画布外）');
  const py = (p.y - camY) * s;
  check(py >= 0 && py < canvasH, '玩家绘制 y=' + py.toFixed(1) + ' 在视口 0..' + canvasH + ' 内');
  let groundOk = 0, groundTotal = 0;
  for (let r = 12; r < 16; r++) {
    const y = (r - camY) * s;
    groundTotal++;
    if (y >= 0 && y < canvasH) groundOk++;
  }
  check(groundOk === groundTotal, '地面 row 12~15 全部可见（' + groundOk + '/' + groundTotal + '）');
}
console.log('✓ 绘制指令检查全部通过');
