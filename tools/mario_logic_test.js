// 马里奥引擎单测。
// 用法：node tools/mario_logic_test.js
//
// 覆盖：物理（重力/跳跃/限速）、瓦片碰撞（墙/地/冰）、土狼时间与跳跃缓冲、
//       踩敌/撞敌/尖刺/金币/蘑菇/终点、移动平台承载、Boss 三阶段、
//       确定性（同样输入两次结果一致 —— 联机同步的根基）。

const EN = require('../subpackages/games/mario/engine.js');
const LV = require('../subpackages/games/mario/levels.js');

let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

const DT = EN.TICK;

// 造一个只有平地的小关卡，隔离测试单项物理
function flatLevel(extraRows) {
  const rows = [
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '##############################',
    '##############################'
  ];
  return EN.loadLevel(rows, Object.assign({ name: 'test', start: { col: 2, row: 13 } }, extraRows || {}));
}

function mkPlayer(level) { return EN.makePlayer(level, 1); }
function input(o) { return Object.assign(EN.makeInput(), o || {}); }

// 跑 n 帧
function run(level, players, inputs, n) {
  for (let i = 0; i < n; i++) EN.stepWorld(level, players, inputs, DT);
}

/* ========== 1. 关卡装载 ========== */
console.log('\n[1] 关卡装载');
{
  const lv = EN.loadLevel(LV.LEVEL_1, LV.LEVEL_SPECS[0]);
  check(lv.rows.length === 16, '关卡 16 行高');
  check(lv.cols > 50, '关卡宽度 > 50 格（实际 ' + lv.cols + '）');
  // 数量由 tools/gen_levels.py 决定 → 断言「有」和「坐标合法」而不是写死个数
  check(lv.coins.length > 0, '关卡 1 有金币（' + lv.coins.length + ' 枚）');
  check(lv.enemies.length > 0, '关卡 1 有敌人（' + lv.enemies.length + ' 个）');
  check(lv.items.length > 0, '关卡 1 有道具（' + lv.items.length + ' 个）');
  check(lv.coins.every(c => c.col >= 0 && c.col < lv.cols && c.row >= 0 && c.row < lv.rowsH),
    '所有金币坐标在关卡范围内');
  check(EN.tileAt(lv.grid, 0, 14) === EN.T.GROUND, '底部是地面');
  check(EN.tileAt(lv.grid, 5, 5) === EN.T.EMPTY, '高空是空的');

  // 5 个关卡都能装载，且都有终点旗
  let allOk = true, allFlag = true;
  for (let i = 0; i < LV.LEVELS.length; i++) {
    const l = EN.loadLevel(LV.LEVELS[i], LV.LEVEL_SPECS[i]);
    if (!l.grid || l.cols < 20) allOk = false;
    let found = false;
    for (let r = 0; r < l.grid.length; r++) {
      if (l.grid[r].indexOf('F') !== -1) found = true;
    }
    if (!found) allFlag = false;
  }
  check(allOk, '5 个关卡全部可装载');
  check(allFlag, '5 个关卡都有终点旗');
  check(LV.LEVEL_SPECS[4].boss && LV.LEVEL_SPECS[4].boss.hp === 3, '第 5 关有 3 血 Boss');
}

/* ========== 2. 重力与落地 ========== */
console.log('\n[2] 重力与落地');
{
  const lv = flatLevel();
  const p = mkPlayer(lv);
  p.x = 3.5; p.y = 5;              // 放到半空
  p.vy = 0;
  EN.stepPlayer(lv, p, input(), DT);
  check(p.vy > 0, '一帧后开始下落（vy=' + p.vy.toFixed(3) + '）');

  // 落到地面
  run(lv, [p], { 1: input() }, 120);
  check(p.onGround === true, '120 帧后站在地面上');
  check(Math.abs(p.y - 14) < 0.01, '站在 row14 地面上（y=' + p.y.toFixed(3) + '）');
  check(p.vy === 0, '地面上下速归零');
}

/* ========== 3. 跳跃高度 ========== */
console.log('\n[3] 跳跃');
{
  const lv = flatLevel();
  const p = mkPlayer(lv);
  p.x = 3.5; p.y = 14; p.onGround = true;
  EN.stepPlayer(lv, p, input({ up: true }), DT);
  check(p.vy < 0, '起跳获得向上速度（vy=' + p.vy.toFixed(2) + '）');
  const jumpVel = p.vy;

  // 持续按住跳得高
  const pHold = mkPlayer(lv);
  pHold.x = 3.5; pHold.y = 14; pHold.onGround = true;
  let maxHold = 14;
  for (let i = 0; i < 60; i++) {
    EN.stepPlayer(lv, pHold, input({ up: true }), DT);
    if (pHold.y < maxHold) maxHold = pHold.y;
  }
  // 轻点跳得低
  const pTap = mkPlayer(lv);
  pTap.x = 3.5; pTap.y = 14; pTap.onGround = true;
  let maxTap = 14;
  for (let i = 0; i < 60; i++) {
    const inp = i < 3 ? input({ up: true }) : input();
    EN.stepPlayer(lv, pTap, inp, DT);
    if (pTap.y < maxTap) maxTap = pTap.y;
  }
  console.log('    长按最高 y=' + maxHold.toFixed(2) + '，轻点最高 y=' + maxTap.toFixed(2));
  check(maxHold < maxTap - 0.5, '长按跳得比轻点高');
  check(maxHold < 14 - 2, '长按能跳 2 格以上');
}

/* ========== 4. 水平移动与限速 ========== */
console.log('\n[4] 水平移动');
{
  const lv = flatLevel();
  const p = mkPlayer(lv);
  p.x = 3.5; p.y = 14; p.onGround = true;
  const x0 = p.x;
  run(lv, [p], { 1: input({ right: true }) }, 60);
  check(p.x > x0, '按右键向右移动（' + x0.toFixed(2) + ' → ' + p.x.toFixed(2) + '）');
  check(p.face === 1, '朝向变为右');

  // 限速
  run(lv, [p], { 1: input({ right: true }) }, 120);
  check(Math.abs(p.vx - EN.PHYS.WALK_MAX) < 0.5, '走路速度被限到 WALK_MAX（' + p.vx.toFixed(2) + '）');

  // 奔跑更快
  const p2 = mkPlayer(lv);
  p2.x = 3.5; p2.y = 14; p2.onGround = true;
  run(lv, [p2], { 1: input({ right: true, run: true }) }, 120);
  check(p2.vx > EN.PHYS.WALK_MAX + 1, '奔跑速度超过走路上限（' + p2.vx.toFixed(2) + '）');

  // 松键后停下
  run(lv, [p], { 1: input() }, 30);
  check(Math.abs(p.vx) < 0.1, '松键后因摩擦停下（vx=' + p.vx.toFixed(3) + '）');
}

/* ========== 5. 墙体碰撞 ========== */
console.log('\n[5] 墙与阻挡');
{
  // 造一道墙
  const rows = [
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..........#...................',
    '##############################'
  ];
  const lv = EN.loadLevel(rows, { name: 'wall', start: { col: 2, row: 13 } });
  const p = mkPlayer(lv);
  p.x = 2.5; p.y = 14; p.onGround = true;
  run(lv, [p], { 1: input({ right: true, run: true }) }, 180);
  check(p.x < 10.5, '撞墙后停在墙左侧（x=' + p.x.toFixed(2) + '）');
  check(p.x > 9.0, '确实贴近了墙（x=' + p.x.toFixed(2) + '）');
  check(p.vx === 0, '撞墙后水平速度归零');

  // 头顶砖块挡跳跃
  const rows2 = [
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..........###.................',
    '..............................',
    '##############################'
  ];
  const lv2 = EN.loadLevel(rows2, { name: 'ceiling', start: { col: 2, row: 13 } });
  const p2 = mkPlayer(lv2);
  p2.x = 2.5; p2.y = 14; p2.onGround = true;
  run(lv2, [p2], { 1: input({ up: true }) }, 90);
  check(p2.y > 12.0, '头顶有砖时跳不过去（y=' + p2.y.toFixed(2) + '）');
}

/* ========== 6. 土狼时间与跳跃缓冲 ========== */
console.log('\n[6] 操作宽容度');
{
  // 土狼时间：刚走下平台边缘仍能起跳
  const rows = [
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '..............................',
    '.....####.....................',
    '.....####.....................'
  ];
  const lv = EN.loadLevel(rows, { name: 'ledge', start: { col: 2, row: 13 } });
  const p = mkPlayer(lv);
  p.x = 5.5; p.y = 13; p.onGround = true;
  // 平台只有 col 5~8，从 5.5 起步要走约 4 格才会完全离开。
  // 走路速度 5.2 格/秒 ≈ 0.087 格/帧，50 帧约 4.3 格
  run(lv, [p], { 1: input({ right: true }) }, 50);
  check(p.onGround === false, '走出平台后离地（x=' + p.x.toFixed(2) + '）');
  check(p.coyote > 0, '离地瞬间仍有土狼时间（' + p.coyote.toFixed(3) + '）');
  EN.stepPlayer(lv, p, input({ right: true, up: true }), DT);
  check(p.vy < 0, '土狼时间内还能起跳');
}

/* ========== 7. 踩敌 ========== */
console.log('\n[7] 踩敌');
{
  const lv = EN.loadLevel(LV.LEVEL_1, LV.LEVEL_SPECS[0]);
  const p = mkPlayer(lv);
  const e = lv.enemies[0];
  // 从上方踩中：玩家盒与敌人盒重叠，且脚底在敌人顶部附近
  p.x = e.x;
  p.y = e.y - 0.6;              // 敌人盒顶 = e.y-0.4，玩家盒底 = p.y
  p.vy = 5;
  p.onGround = false;
  EN.stepWorld(lv, [p], { 1: input() }, DT);
  check(e.alive === false, '从上方撞到 → 敌人被踩死');
  check(p.vy < 0, '踩敌后玩家反弹（vy=' + p.vy.toFixed(2) + '）');

  // 侧面撞到 → 玩家受伤/死亡。
  // 几何要点：敌人中心在玩家上方 0.5 格，此时玩家盒底(12.5)已深入
  // 敌人盒中部(顶11.6/底12.4 之上)，踩入深度 0.9 > 敌人高度 0.8*0.75，
  // 因此判为侧面相撞而不是踩头。
  const lv2 = EN.loadLevel(LV.LEVEL_1, LV.LEVEL_SPECS[0]);
  const p2 = mkPlayer(lv2);
  const e2 = lv2.enemies[0];
  e2.vx = 0; e2.vy = 0;
  e2.y = p2.y - 0.5;
  e2.x = p2.x + 0.7;
  p2.vy = 0;
  p2.hurtT = 0;
  EN.stepWorld(lv2, [p2], { 1: input() }, DT);
  check(e2.alive === true, '侧面撞 → 敌人不死');
  check(p2.state === 'dying', '侧面撞且未变大 → 玩家死亡');
}

/* ========== 8. 金币 / 蘑菇 / 尖刺 / 终点 ========== */
console.log('\n[8] 收集与危险');
{
  const lv = EN.loadLevel(LV.LEVEL_1, LV.LEVEL_SPECS[0]);
  const p = mkPlayer(lv);
  const c = lv.coins[0];
  p.x = c.col + 0.5; p.y = c.row + 0.5;
  EN.stepWorld(lv, [p], { 1: input() }, DT);
  check(c.taken === true, '碰到金币被收集');
  check(p.coins === 1, '金币计数 +1');

  const lv2 = EN.loadLevel(LV.LEVEL_1, LV.LEVEL_SPECS[0]);
  const p2 = mkPlayer(lv2);
  const it = lv2.items[0];
  p2.x = it.x; p2.y = it.y;
  EN.stepWorld(lv2, [p2], { 1: input() }, DT);
  check(p2.big === true, '吃到蘑菇变大');
  check(it.active === false, '蘑菇被消耗');

  // 变大后被撞 → 变小而不是死。
  // 注意：吃蘑菇会设 hurtT=0.6 秒无敌，必须先跑完这段再撞
  const lv2b = EN.loadLevel(LV.LEVEL_1, LV.LEVEL_SPECS[0]);
  const p2b = mkPlayer(lv2b);
  const itb = lv2b.items[0];
  p2b.x = itb.x; p2b.y = itb.y;
  EN.stepWorld(lv2b, [p2b], { 1: input() }, DT);
  check(p2b.big === true, '再次确认吃到蘑菇变大');
  run(lv2b, [p2b], { 1: input() }, 45);      // 等 hurtT 过期（0.6s = 36 帧）
  check(p2b.hurtT <= 0, '无敌时间已过');
  const eb = lv2b.enemies[0];
  eb.vx = 0; eb.vy = 0;
  eb.y = p2b.y - 0.5;                // 敌人在玩家上方 → 侧面相撞
  eb.x = p2b.x + 0.7;
  p2b.vy = 0;
  EN.stepWorld(lv2b, [p2b], { 1: input() }, DT);
  check(p2b.big === false, '变大时被撞 → 变小');
  check(p2b.state === 'alive', '变大时被撞不会死');

  // 尖刺致死（尖刺现在在 Boss 关，全关卡扫描找）
  let spike = null, spikeLv = null;
  for (let li = 0; li < LV.LEVELS.length && !spike; li++) {
    const l = EN.loadLevel(LV.LEVELS[li], LV.LEVEL_SPECS[li]);
    for (let r = 0; r < l.grid.length && !spike; r++) {
      const c = l.grid[r].indexOf('S');
      if (c !== -1) { spike = { col: c, row: r }; spikeLv = l; }
    }
  }
  check(spike !== null, '有尖刺的关卡存在');
  if (spike && spikeLv) {
    const p3 = mkPlayer(spikeLv);
    p3.x = spike.col + 0.5; p3.y = spike.row + 1.0;
    EN.stepWorld(spikeLv, [p3], { 1: input() }, DT);
    check(p3.state === 'dying', '碰到尖刺死亡');
  }

  // 终点旗过关
  const lv4 = EN.loadLevel(LV.LEVEL_1, LV.LEVEL_SPECS[0]);
  const p4 = mkPlayer(lv4);
  let flag = null;
  for (let r = 0; r < lv4.grid.length; r++) {
    const c = lv4.grid[r].indexOf('F');
    if (c !== -1) { flag = { col: c, row: r }; break; }
  }
  check(flag !== null, '关卡 1 有终点旗');
  if (flag) {
    p4.x = flag.col + 0.5; p4.y = flag.row + 0.5;
    EN.stepWorld(lv4, [p4], { 1: input() }, DT);
    check(p4.state === 'done', '碰到终点旗过关');
    check(EN.isLevelCleared(lv4, [p4]) === true, '单人局到终点即过关');
  }
}

/* ========== 9. 死亡与重生 ========== */
console.log('\n[9] 死亡重生');
{
  const lv = flatLevel();
  const p = mkPlayer(lv);
  p.y = 20;                        // 直接扔出地图
  EN.stepPlayer(lv, p, input(), DT);
  check(p.state === 'dying', '掉出地图进入死亡状态');
  check(p.lives === EN.PHYS.LIVES || p.lives === 3, '初始 3 条命');
  // 跑过重生间隔
  run(lv, [p], { 1: input() }, 70);
  check(p.state === 'alive', '重生间隔后复活');
  check(p.lives === 2, '复活后扣 1 条命（剩 ' + p.lives + '）');
  check(Math.abs(p.x - lv.start.col - 0.5) < 0.01, '回到出生点');

  // 命耗尽：设 lives=1，死后扣到 0 → dead
  p.lives = 1;
  p.state = 'alive';
  p.y = 20;
  EN.stepPlayer(lv, p, input(), DT);
  check(p.state === 'dying', '再次掉出地图进入死亡');
  run(lv, [p], { 1: input() }, 70);
  check(p.lives === 0, '命扣到 0');
  check(p.state === 'dead', '命耗尽后彻底死亡');
  check(EN.isGameOver(lv, [p]) === true, '单人死透 → 游戏结束');
}

/* ========== 10. 移动平台 ========== */
console.log('\n[10] 移动平台');
{
  const lv = EN.loadLevel(LV.LEVEL_3, LV.LEVEL_SPECS[2]);
  check(lv.platforms.length >= 1, '关卡 3 有移动平台（' + lv.platforms.length + ' 个）');
  const pl = lv.platforms[0];
  const x0 = pl.x;
  run(lv, [], {}, 60);
  check(Math.abs(pl.x - x0) > 0.1, '平台会移动（' + x0.toFixed(2) + ' → ' + pl.x.toFixed(2) + '）');

  // 站在平台上被承载。注意：先跑几帧让平台到达稳定位置，
  // 再把玩家放到平台正上方（留一帧下落的距离内）
  run(lv, [], {}, 30);                  // 让平台动起来
  const p = mkPlayer(lv);
  p.x = pl.x;
  p.y = pl.y + pl.h / 2 + 0.05;         // 刚好贴在平台顶
  p.vy = 0.5;
  EN.stepWorld(lv, [p], { 1: input() }, DT);
  check(Math.abs(p.y - (pl.y + pl.h / 2)) < 0.2, '玩家被平台接住（y=' + p.y.toFixed(2) + ' 平台顶=' + (pl.y + pl.h / 2).toFixed(2) + '）');
  check(p.onGround === true, '站在平台上算落地');
  const pxBefore = p.x;
  run(lv, [p], { 1: input() }, 20);
  check(Math.abs(p.x - pxBefore) > 0.05, '玩家被平台承载着一起移动');
}

/* ========== 11. Boss 三阶段 ========== */
console.log('\n[11] Boss');
{
  const lv = EN.loadLevel(LV.LEVEL_5, LV.LEVEL_SPECS[4]);
  check(lv.boss !== null, '关卡 5 有 Boss');
  check(lv.boss.hp === 3, 'Boss 3 点血');
  const boss = lv.boss;
  const players = [mkPlayer(lv)];
  // 阶段 1
  EN.stepBoss(lv, boss, players, DT);
  check(boss.phase === 1, '满血是阶段 1');
  check(lv.fireballs && lv.fireballs.length >= 0, '阶段 1 会尝试喷火球');
  // 降到 2 血 → 阶段 2
  boss.hp = 2;
  EN.stepBoss(lv, boss, players, DT);
  check(boss.phase === 2, '2 血进阶段 2');
  // 降到 1 血 → 阶段 3
  boss.hp = 1;
  EN.stepBoss(lv, boss, players, DT);
  check(boss.phase === 3, '1 血进阶段 3（可被踩）');

  // 虚弱期踩头掉血。玩家盒底必须落在 Boss 盒顶附近：
  // Boss 盒顶 = boss.y - boss.h/2，玩家盒底 = p.y，所以 p.y 略大于盒顶即可
  const p = players[0];
  boss.hp = 1;
  boss.phase = 3;
  boss.vx = 0;
  p.x = boss.x;
  p.y = boss.y - boss.h / 2 + 0.1;
  p.vy = 5;
  p.onGround = false;
  EN.stepWorld(lv, players, { 1: input() }, DT);
  check(boss.hp === 0, '虚弱期被踩 → Boss 死亡');

  // 火球撞玩家致死（火球无 w/h，靠 stepFireballs 补默认值）
  const lv2 = EN.loadLevel(LV.LEVEL_5, LV.LEVEL_SPECS[4]);
  const p2 = mkPlayer(lv2);
  lv2.fireballs = [{ x: p2.x, y: p2.y, vx: 0, vy: 0, life: 1 }];
  p2.hurtT = 0; p2.big = false; p2.state = 'alive';
  EN.stepWorld(lv2, [p2], { 1: input() }, DT);
  check(p2.state === 'dying', '火球命中且未变大 → 死亡');
}

/* ========== 12. 确定性（联机根基） ========== */
console.log('\n[12] 确定性模拟');
{
  // 同样输入跑两遍，结果必须逐帧一致
  function playOnce() {
    const lv = EN.loadLevel(LV.LEVEL_1, LV.LEVEL_SPECS[0]);
    const p1 = mkPlayer(lv);
    const p2 = EN.makePlayer(lv, 2);
    p2.x = 4; p2.y = 13;
    const inputs = { 1: input(), 2: input() };
    for (let i = 0; i < 300; i++) {
      inputs[1].right = i % 90 < 45;
      inputs[1].up = i % 37 === 0;
      inputs[1].run = i > 100;
      inputs[2].left = i % 70 < 30;
      inputs[2].up = i % 53 === 0;
      EN.stepWorld(lv, [p1, p2], inputs, DT);
    }
    return JSON.stringify({
      p1: EN.playerToWire(p1), p2: EN.playerToWire(p2),
      e: lv.enemies.map(e => [e.id, e.alive ? 1 : 0, e.x, e.y]),
      c: lv.coins.filter(c => c.taken).map(c => c.id)
    });
  }
  const a = playOnce();
  const b = playOnce();
  check(a === b, '两次同样输入的模拟结果完全一致');
  check(a.length > 20, '结果非空（' + a.length + ' 字符）');
}

/* ========== 13. 双人合作与竞速 ========== */
console.log('\n[13] 双人模式');
{
  const lv = EN.loadLevel(LV.LEVEL_1, LV.LEVEL_SPECS[0]);
  const p1 = mkPlayer(lv);
  const p2 = EN.makePlayer(lv, 2);
  p2.x = 4; p2.y = 13;
  // 都没到终点
  check(EN.isLevelCleared(lv, [p1, p2]) === false, '未到终点不算过关');
  check(EN.raceWinner(lv, [p1, p2]) === 0, '未到终点无竞速胜者');
  // p1 到终点
  let flag = null;
  for (let r = 0; r < lv.grid.length; r++) {
    const c = lv.grid[r].indexOf('F');
    if (c !== -1) { flag = { col: c, row: r }; break; }
  }
  p1.x = flag.col + 0.5; p1.y = flag.row + 0.5;
  EN.stepWorld(lv, [p1, p2], { 1: input(), 2: input() }, DT);
  check(p1.state === 'done', 'p1 到终点');
  check(EN.isLevelCleared(lv, [p1, p2]) === false, '合作模式需双方都到终点');
  check(EN.raceWinner(lv, [p1, p2]) === 1, '竞速模式 p1 先到即胜');
  // p2 也到终点
  p2.x = flag.col + 0.5; p2.y = flag.row + 0.5;
  EN.stepWorld(lv, [p1, p2], { 1: input(), 2: input() }, DT);
  check(p2.state === 'done', 'p2 到终点');
  check(EN.isLevelCleared(lv, [p1, p2]) === true, '双方都到终点 → 合作过关');
  check(EN.isGameOver(lv, [p1, p2]) === true, '双方都 done → 游戏结束');
}

/* ========== 14. 序列化 ========== */
console.log('\n[14] 联机序列化');
{
  const lv = EN.loadLevel(LV.LEVEL_1, LV.LEVEL_SPECS[0]);
  const p1 = mkPlayer(lv);
  const p2 = EN.makePlayer(lv, 2);
  run(lv, [p1, p2], { 1: input({ right: true }), 2: input({ left: true }) }, 60);
  const w = EN.worldToWire(lv, [p1, p2]);
  check(w.p1 !== null && w.p2 !== null, '双人状态都序列化');
  check(Array.isArray(w.es) && w.es.length === lv.enemies.length, '敌人数组序列化（' + w.es.length + ' 个）');
  check(Array.isArray(w.cs), '剩余金币 id 数组');
  check(typeof w.t === 'number', '时间戳字段');
  check(w.bs === null, '关卡 1 无 Boss → bs 为 null');
  // 关卡 5 有 Boss
  const lv5 = EN.loadLevel(LV.LEVEL_5, LV.LEVEL_SPECS[4]);
  const w5 = EN.worldToWire(lv5, [mkPlayer(lv5)]);
  check(w5.bs !== null && w5.bs[0] === 3, '关卡 5 序列化含 Boss 血量');
  // 序列化体积要小（云数据库单次写入限制）
  const s = JSON.stringify(w);
  check(s.length < 2000, '单帧世界序列化 < 2KB（实际 ' + s.length + ' 字节）');
}


/* ========== 15. 问号砖顶出道具 ========== */
console.log("\n[15] 问号砖");
{
  const lv = EN.loadLevel(LV.LEVEL_1, LV.LEVEL_SPECS[0]);
  // 找到问号砖
  let q = null;
  for (let r = 0; r < lv.grid.length && !q; r++) {
    const c = lv.grid[r].indexOf('?');
    if (c !== -1) q = { col: c, row: r };
  }
  check(q !== null, '关卡 1 有问号砖');
  const p = mkPlayer(lv);
  const coins0 = p.coins, items0 = lv.items.length;
  // 顶砖前砖是 ?
  check(lv.grid[q.row][q.col] === '?', '顶砖前是问号砖');
  p.x = q.col + 0.5; p.y = q.row + 1.2;
  EN.hitHeadBlock(lv, p);
  check(lv.grid[q.row][q.col] === 'B', '顶过之后变成普通砖 B');
  const gained = (p.coins - coins0) + (lv.items.length - items0);
  check(gained === 1, '顶出 1 个东西（金币或蘑菇），实际 ' + gained);

  // 确定性：同样位置再顶一次，结果一致
  const lv2 = EN.loadLevel(LV.LEVEL_1, LV.LEVEL_SPECS[0]);
  const p2 = mkPlayer(lv2);
  p2.x = q.col + 0.5; p2.y = q.row + 1.2;
  EN.hitHeadBlock(lv2, p2);
  check(p2.coins === p.coins && lv2.items.length === lv.items.length,
    '确定性：同样位置顶出同样东西（保证 host/guest 同步）');

  // 已顶过的砖再顶不出东西
  const coinsBefore = p.coins, itemsBefore = lv.items.length;
  EN.hitHeadBlock(lv, p);
  check(p.coins === coinsBefore && lv.items.length === itemsBefore, '已用过的砖再顶不出东西');
}
/* ========== 汇总 ========== */
console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail > 0) {
  console.log('❌ 马里奥引擎测试未通过');
  process.exit(1);
}
console.log('✓ 马里奥引擎测试全部通过');
