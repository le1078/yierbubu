// 马里奥引擎模糊测试：随机输入长时间运行，断言物理/状态机不变量。
// 目的不是「跑通一遍」，而是用大量随机路径逼出 NaN、越界、状态机非法、
// 数组无限增长这类只有在特定输入序列下才出现的问题。
//
// 用法：node tools/mario_fuzz_test.js [每关种子数]

const path = require('path');
const EN = require(path.join(__dirname, '..', 'subpackages/games/mario/engine.js'));
const LV = require(path.join(__dirname, '..', 'subpackages/games/mario/levels.js'));

let pass = 0, fail = 0;
const failures = [];
function check(cond, name) {
  if (cond) { pass++; return true; }
  fail++;
  failures.push(name);
  if (failures.length <= 20) console.log('  ❌ ' + name);
  return false;
}

const SEEDS = Number(process.argv[2] || 6);
const ALLOWED_STATES = { alive: 1, dying: 1, dead: 1, done: 1 };

// 确定性伪随机（同一种子必复现）
function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function finite(n) {
  return typeof n === 'number' && isFinite(n);
}

function checkPlayer(p, tag) {
  check(finite(p.x) && finite(p.y) && finite(p.vx) && finite(p.vy), tag + ' 坐标/速度是有限数');
  check(!!ALLOWED_STATES[p.state], tag + ' 状态合法（' + p.state + '）');
  check(finite(p.score) && p.score >= 0, tag + ' 分数有效');
  check(finite(p.coins) && p.coins >= 0, tag + ' 金币有效');
  check(finite(p.lives), tag + ' 生命有效');
  check(p.x > -10 && p.x < 200, tag + ' x 未发散（' + p.x.toFixed(1) + '）');
  check(p.y > -30 && p.y < 40, tag + ' y 未发散（' + p.y.toFixed(1) + '）');
  check(p.h === 0.9 || p.h === 1.6, tag + ' 碰撞盒高度与形态一致（' + p.h + '）');
}

console.log('[1] 随机输入长跑（每关 ' + SEEDS + ' 个种子 × 双人）');
{
  for (let li = 0; li < LV.LEVELS.length; li++) {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const lv = EN.loadLevel(LV.LEVELS[li], LV.LEVEL_SPECS[li]);
      const p1 = EN.makePlayer(lv, 1);
      const p2 = EN.makePlayer(lv, 2);
      lv._players = [p1, p2];
      const rng = makeRng(li * 1000 + seed);
      let lastScore1 = 0, lastScore2 = 0;
      let maxItems = 0, maxPopups = 0, maxFireballs = 0;
      let crashed = null;
      const tag = 'L' + (li + 1) + '-seed' + seed;
      let frames = 0;
      for (let f = 0; f < 60 * 90; f++) {
        frames = f;
        const i1 = EN.makeInput();
        const i2 = EN.makeInput();
        // 70% 向右推进，其余随机：既探索正常路线也制造混乱
        i1.right = rng() < 0.7 ? true : rng() < 0.5;
        i1.left = !i1.right && rng() < 0.4;
        i2.right = rng() < 0.7 ? true : rng() < 0.5;
        i2.left = !i2.right && rng() < 0.4;
        i1.up = rng() < 0.3;
        i2.up = rng() < 0.3;
        i1.down = rng() < 0.08;
        i2.down = rng() < 0.08;
        i1.run = rng() < 0.3;
        i2.run = rng() < 0.3;
        try {
          EN.stepWorld(lv, [p1, p2], { 1: i1, 2: i2 }, EN.TICK);
        } catch (e) {
          crashed = e;
          break;
        }
        // 分数/金币只能增（除非重生不该回退）；这些不变量能抓住计数错乱
        if (p1.score < lastScore1 || p2.score < lastScore2) {
          check(false, tag + ' 分数不应回退');
        }
        lastScore1 = p1.score;
        lastScore2 = p2.score;
        maxItems = Math.max(maxItems, lv.items.length);
        maxPopups = Math.max(maxPopups, lv.popups ? lv.popups.length : 0);
        maxFireballs = Math.max(maxFireballs, lv.fireballs.length);
      }
      check(!crashed, tag + ' 长跑无异常' + (crashed ? '：' + crashed.message : ''));
      if (crashed) continue;
      checkPlayer(p1, tag + ' P1');
      checkPlayer(p2, tag + ' P2');
      check(maxItems < 200, tag + ' 道具数组有界（峰值 ' + maxItems + '）');
      check(maxPopups <= 13, tag + ' 飘字数组有界（峰值 ' + maxPopups + '）');
      check(maxFireballs < 200, tag + ' 火球数组有界（峰值 ' + maxFireballs + '）');
      // 网格结构不能被模拟破坏
      check(lv.grid.length === 16 && lv.grid.every((r) => r.length === lv.cols),
        tag + ' 网格尺寸不变');
      // 序列化必须稳定且可 JSON 化
      const w = EN.worldToWire(lv, [p1, p2]);
      let round = null;
      try { round = JSON.parse(JSON.stringify(w)); } catch (e) { /* 下面断言 */ }
      check(!!round && round.p1 && round.p2, tag + ' 世界快照可 JSON 序列化');
      check(round && round.es.length === lv.enemies.length, tag + ' 敌人数量与序列化一致');
      check(frames > 0, tag + ' 真的跑了多帧');
    }
  }
}

console.log('\n[2] 序列化体积稳定（云数据库单次写入限制）');
{
  for (let li = 0; li < LV.LEVELS.length; li++) {
    const lv = EN.loadLevel(LV.LEVELS[li], LV.LEVEL_SPECS[li]);
    const pl = [EN.makePlayer(lv, 1), EN.makePlayer(lv, 2)];
    const s = JSON.stringify(EN.worldToWire(lv, pl));
    check(s.length < 4000, '第 ' + (li + 1) + ' 关世界快照 < 4KB（实际 ' + s.length + ' 字节）');
  }
}

console.log('\n[3] 边界输入：长时间按住不放 / 疯狂抖动 / 同时按左右');
{
  const lv = EN.loadLevel(LV.LEVELS[0], LV.LEVEL_SPECS[0]);
  const p = EN.makePlayer(lv, 1);
  let crashed = null;
  try {
    for (let f = 0; f < 60 * 30; f++) {
      const i = EN.makeInput();
      const phase = Math.floor(f / 30) % 3;
      if (phase === 0) { i.right = true; i.run = true; i.up = true; }
      else if (phase === 1) { i.left = true; i.right = true; i.up = true; i.down = true; }
      else { i.left = true; i.run = true; }
      EN.stepWorld(lv, [p], { 1: i }, EN.TICK);
    }
  } catch (e) { crashed = e; }
  check(!crashed, '极端输入组合不崩' + (crashed ? '：' + crashed.message : ''));
  checkPlayer(p, '极端输入后');
}

console.log('\n[4] 超长时间（10 分钟模拟）不泄漏不跑飞');
{
  const lv = EN.loadLevel(LV.LEVELS[1], LV.LEVEL_SPECS[1]);
  const p = EN.makePlayer(lv, 1);
  p.infiniteLives = true;
  let crashed = null;
  try {
    for (let f = 0; f < 60 * 600; f++) {
      const i = EN.makeInput();
      i.right = true;
      if (f % 40 < 6) i.up = true;
      EN.stepWorld(lv, [p], { 1: i }, EN.TICK);
    }
  } catch (e) { crashed = e; }
  check(!crashed, '10 分钟模拟无异常' + (crashed ? '：' + crashed.message : ''));
  checkPlayer(p, '长跑后');
  check((lv.popups || []).length <= 13, '飘字池未泄漏（' + (lv.popups || []).length + '）');
  check((lv.debris || []).length <= 60, '碎片池未泄漏（' + (lv.debris || []).length + '）');
  check(lv.timeLeft >= 0, '倒计时不为负（' + lv.timeLeft + '）');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail > 0) {
  console.log('失败样例（最多 20 条）:');
  for (const f of failures.slice(0, 20)) console.log('  - ' + f);
  console.log('❌ 马里奥模糊测试未通过');
  process.exit(1);
}
console.log('✓ 马里奥模糊测试全部通过');
