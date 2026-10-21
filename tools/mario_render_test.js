// 马里奥渲染回归测试：确认角色真的被画出来（不是只剩名牌）。
// 用法：node tools/mario_render_test.js
//
// 背景：之前玩家形象用 <image> 叠在 canvas 上，部分基础库会把原生 canvas
// 盖在上层，实际表现是「只看得见 P1/P2 名牌，角色消失」。
// 现在改为把 GIF 抽出的 PNG 帧直接 drawImage 到 canvas，这个测试守住这条路。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EN = require(path.join(ROOT, 'subpackages/games/mario/engine.js'));
const LV = require(path.join(ROOT, 'subpackages/games/mario/levels.js'));

let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

function makeMockCtx() {
  const draws = [], texts = [], arcs = [];
  return {
    _draws: draws, _texts: texts, _arcs: arcs,
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
    fillRect() {}, clearRect() {}, strokeRect() {},
    save() {}, restore() {}, translate() {}, scale() {}, rotate() {},
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    arc(x, y, r) { arcs.push({ x: x, y: y, r: r }); },
    ellipse() {},
    fill() {}, stroke() {},
    drawImage(img, dx, dy, dw, dh) { draws.push({ img: img, dx: dx, dy: dy, dw: dw, dh: dh }); },
    fillText(t, x, y) { texts.push({ t: t, x: x, y: y }); },
    set fillStyle(v) {}, get fillStyle() { return '#000'; },
    set strokeStyle(v) {}, get strokeStyle() { return '#000'; },
    set lineWidth(v) {}, get lineWidth() { return 1; },
    set font(v) {}, get font() { return ''; },
    set textAlign(v) {}, get textAlign() { return 'left'; },
    set textBaseline(v) {}, get textBaseline() { return 'top'; }
  };
}

// render.js 在离屏 canvas 可用时才缓存背景；测试里不提供，
// 走渐变分支，这样 drawImage 只会是玩家角色帧。
global.wx = {};

const R = require(path.join(ROOT, 'subpackages/games/mario/render.js'));

console.log('\n[1] 角色帧素材齐全（GIF 抽帧 PNG）');
{
  const dir = path.join(ROOT, 'subpackages/games/mario/img');
  let ok = true;
  for (let i = 0; i < 2; i++) {
    if (!fs.existsSync(path.join(dir, 'avatar_a_' + i + '.png'))) { ok = false; console.log('    缺少 avatar_a_' + i + '.png'); }
  }
  for (let i = 0; i < 6; i++) {
    if (!fs.existsSync(path.join(dir, 'avatar_b_' + i + '.png'))) { ok = false; console.log('    缺少 avatar_b_' + i + '.png'); }
  }
  check(ok, '小熊 2 帧 + 熊猫 6 帧都存在');
}

function setup() {
  const level = EN.loadLevel(LV.LEVELS[0], LV.LEVEL_SPECS[0]);
  const players = [EN.makePlayer(level, 1), EN.makePlayer(level, 2)];
  players[1].x = level.start.col + 2.5;
  return { level: level, players: players };
}

const W = 350, H = 217, S = W / 15;

console.log('\n[2] 图片未就绪时退回矢量小人（角色不会消失）');
{
  const st = setup();
  const ctx = makeMockCtx();
  R.drawFrame(ctx, {
    ctx: ctx, level: st.level, players: st.players, time: 1,
    viewW: W, viewH: H, scale: S, bgCache: { canvas: null, w: 0, h: 0 },
    cam: 0, camY: 7, sprites: null
  });
  // 矢量小人会画脑袋（arc）、身体和腿；至少要有若干 arc
  check(ctx._arcs.length > 0, '绘制了矢量角色（arc ' + ctx._arcs.length + ' 个）');
  const tags = ctx._texts.filter(function (t) { return t.t === 'P1' || t.t === 'P2'; });
  check(tags.length === 2, '两个名牌都在（' + tags.length + '/2）');
}

console.log('\n[3] 图片就绪时优先画角色帧');
{
  const st = setup();
  const ctx = makeMockCtx();
  const fakeA = [{ width: 128 }, { width: 128 }];
  const fakeB = [{ width: 128 }, { width: 128 }, { width: 128 },
                 { width: 128 }, { width: 128 }, { width: 128 }];
  R.drawFrame(ctx, {
    ctx: ctx, level: st.level, players: st.players, time: 1.2,
    viewW: W, viewH: H, scale: S, bgCache: { canvas: null, w: 0, h: 0 },
    cam: 0, camY: 7, sprites: { 1: fakeA, 2: fakeB }
  });
  check(ctx._draws.length === 2, '两个玩家都用 drawImage 画出（' + ctx._draws.length + '/2）');
  let inside = true;
  for (const d of ctx._draws) {
    if (d.dx < -S || d.dx > W + S || d.dy < -S * 2 || d.dy > H + S) inside = false;
  }
  check(inside, '角色绘制位置在画布范围内');
  check(ctx._draws[0].dw > S * 0.9 && ctx._draws[0].dw < S * 1.5,
    '小形态角色尺寸约 1.3 格（' + (ctx._draws[0].dw / S).toFixed(2) + ' 格）');
}

console.log('\n[4] 死亡角色不绘制');
{
  const st = setup();
  st.players[1].state = 'dead';
  const ctx = makeMockCtx();
  const fake = [{ width: 128 }];
  R.drawFrame(ctx, {
    ctx: ctx, level: st.level, players: st.players, time: 1,
    viewW: W, viewH: H, scale: S, bgCache: { canvas: null, w: 0, h: 0 },
    cam: 0, camY: 7, sprites: { 1: fake, 2: fake }
  });
  check(ctx._draws.length === 1, '只画存活的 P1（' + ctx._draws.length + ' 个）');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail > 0) {
  console.log('❌ 马里奥渲染测试未通过');
  process.exit(1);
}
console.log('✓ 马里奥渲染测试全部通过');
