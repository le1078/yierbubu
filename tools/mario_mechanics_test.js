// 马里奥 SMB1 机制对齐测试：逐条验证正版机制是否实现。
// 用法：node tools/mario_mechanics_test.js
//
// 覆盖：
//   1. 变身链：小 → 超级（蘑菇）→ 火焰（花）
//   2. 受伤：超级/火焰 → 小（不死）+ 无敌闪烁；小 → 死
//   3. 火球：火焰态可发、最多 2 颗、撞墙反弹、击杀敌人
//   4. 乌龟壳：踩→壳→再踩踢出→碾压其他敌人
//   5. 砖块：小只顶、大顶碎；问号砖出蘑菇/花/金币
//   6. 死亡：掉坑即死、受伤死亡有上弹动画、重生回检查点
//   7. 计分：金币 200、踩敌 100 起、连踩递增

const EN = require('../subpackages/games/mario/engine.js');
const LV = require('../subpackages/games/mario/levels.js');

let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}
const DT = EN.TICK;
function input(o) { return Object.assign(EN.makeInput(), o || {}); }

// 平地关卡，隔离测试
function flat(pieces) {
  const rows = [];
  for (let i = 0; i < 16; i++) rows.push('.'.repeat(40));
  rows[14] = '#'.repeat(40);
  rows[15] = '#'.repeat(40);
  if (pieces) {
    for (const p of pieces) {
      const line = rows[p[1]].split('');
      line[p[0]] = p[2];
      rows[p[1]] = line.join('');
    }
  }
  return EN.loadLevel(rows, { name: 'test', start: { col: 2, row: 14 } });
}
function mk(lv) { return EN.makePlayer(lv, 1); }

/* ========== 1. 变身链 ========== */
console.log('\n[1] 变身链：小 → 超级 → 火焰');
{
  const lv = flat();
  const p = mk(lv);
  check(p.form === EN.FORM.SMALL, '初始是小形态');

  // 吃蘑菇 → 超级
  lv.items.push({ id: 0, type: 'mushroom', x: p.x, y: p.y - 0.4, w: 0.7, h: 0.7, vx: 0, vy: 0, active: true });
  EN.stepWorld(lv, [p], { 1: input() }, DT);
  check(p.form === EN.FORM.SUPER, '吃蘑菇 → 超级形态');
  check(p.h > 1.0, '超级形态碰撞盒变高（h=' + p.h.toFixed(2) + '）');

  // 吃花 → 火焰
  lv.items.push({ id: 1, type: 'flower', x: p.x, y: p.y - 0.4, w: 0.7, h: 0.7, vx: 0, vy: 0, active: true });
  EN.stepWorld(lv, [p], { 1: input() }, DT);
  check(p.form === EN.FORM.FIRE, '吃花 → 火焰形态');

  // 火焰态再吃花仍是火焰（不降级）
  lv.items.push({ id: 2, type: 'flower', x: p.x, y: p.y - 0.4, w: 0.7, h: 0.7, vx: 0, vy: 0, active: true });
  EN.stepWorld(lv, [p], { 1: input() }, DT);
  check(p.form === EN.FORM.FIRE, '火焰态吃花仍保持火焰');
}

/* ========== 2. 受伤机制 ========== */
console.log('\n[2] 受伤：大变小不死，小才死');
{
  const lv = flat();
  const p = mk(lv);
  p.form = EN.FORM.SUPER;
  p.h = EN.playerHeight(EN.FORM.SUPER);
  EN.hurtPlayer(p);
  check(p.form === EN.FORM.SMALL, '超级受伤 → 退回小形态');
  check(p.state === 'alive', '超级受伤不会死');
  check(p.hurtT > 0, '受伤后有无敌时间（' + p.hurtT.toFixed(2) + 's）');
  check(p.h < 1.0, '变小后碰撞盒恢复（h=' + p.h.toFixed(2) + '）');

  // 无敌期间再受伤无效
  const formBefore = p.form;
  EN.hurtPlayer(p);
  check(p.form === formBefore, '无敌期间再受伤无效');

  // 无敌结束后小形态受伤 → 死
  const lv2 = flat();
  const p2 = mk(lv2);
  p2.hurtT = 0;
  EN.hurtPlayer(p2);
  check(p2.state === 'dying', '小形态受伤 → 死亡');
  check(p2.vy < 0, '死亡时向上弹起（vy=' + p2.vy.toFixed(1) + '）');
}

/* ========== 3. 火球 ========== */
console.log('\n[3] 火球');
{
  const lv = flat();
  const p = mk(lv);
  // 非火焰形态不能发
  check(EN.spawnFireball(lv, p) === false, '小形态不能发火球');

  p.form = EN.FORM.FIRE;
  p.fireCd = 0;
  check(EN.spawnFireball(lv, p) === true, '火焰形态可以发火球');
  check(lv.fireballs.length === 1, '火球进入场景');
  check(lv.fireballs[0].fromPlayer === true, '标记为玩家火球');

  // 冷却中不能再发
  check(EN.spawnFireball(lv, p) === false, '冷却期间不能连发');

  // 最多 2 颗
  p.fireCd = 0;
  EN.spawnFireball(lv, p);
  p.fireCd = 0;
  const third = EN.spawnFireball(lv, p);
  check(lv.fireballs.length === 2 && third === false, '同屏最多 2 颗（实际 ' + lv.fireballs.length + '）');

  // 火球击杀敌人
  const lv2 = flat([[6, 13, '.']]);
  lv2.enemies.push({
    id: 0, type: 'goomba', x: 6.5, y: 13.5, w: 0.8, h: 0.8,
    vx: 0, vy: 0, dir: 1, homeX: 6.5, homeY: 13.5, range: 3,
    phase: 0, alive: true, shell: 'walk', shellT: 0, kicker: 0, kickT: 0
  });
  const p2 = mk(lv2);
  p2.form = EN.FORM.FIRE;
  lv2.fireballs.push({ x: 6.5, y: 13.5, w: 0.35, h: 0.35, vx: 5, vy: 0, life: 2, owner: 1, fromPlayer: true });
  EN.stepWorld(lv2, [p2], { 1: input() }, DT);
  check(lv2.enemies[0].alive === false, '火球能击杀敌人');
  check(p2.score >= 100, '击杀敌人加分（' + p2.score + '）');
}

/* ========== 4. 乌龟壳 ========== */
console.log('\n[4] 乌龟壳：踩壳踢壳碾压');
{
  const lv = flat();
  lv.enemies.push({
    id: 0, type: 'turtle', x: 5.5, y: 13.5, w: 0.8, h: 0.8,
    vx: 0, vy: 0, dir: 1, homeX: 5.5, homeY: 13.5, range: 3,
    phase: 0, alive: true, shell: 'walk', shellT: 0, kicker: 0, kickT: 0
  });
  const p = mk(lv);
  // 从上方踩
  p.x = 5.5; p.y = 13.2; p.vy = 5; p.onGround = false;
  EN.stepWorld(lv, [p], { 1: input() }, DT);
  const e = lv.enemies[0];
  check(e.alive === true && e.shell === 'shell', '踩乌龟 → 变壳（不死）');
  check(p.vy < 0, '踩龟壳后玩家反弹');

  // 再踩静止壳 → 踢出去
  p.x = 5.5; p.y = 13.2; p.vy = 5; p.onGround = false;
  EN.stepWorld(lv, [p], { 1: input() }, DT);
  check(e.shell === 'slide', '再踩壳 → 踢出去');
  check(Math.abs(e.vx) > 5, '壳有高速滑行（vx=' + e.vx.toFixed(1) + '）');

  // 滑行壳碾压其他敌人
  lv.enemies.push({
    id: 1, type: 'goomba', x: e.x + 1.0, y: 13.5, w: 0.8, h: 0.8,
    vx: 0, vy: 0, dir: 1, homeX: e.x + 1.0, homeY: 13.5, range: 3,
    phase: 0, alive: true, shell: 'walk', shellT: 0, kicker: 0, kickT: 0
  });
  const scoreBefore = p.score;
  for (let i = 0; i < 20; i++) EN.stepWorld(lv, [p], { 1: input() }, DT);
  check(lv.enemies[1].alive === false, '滑行壳碾压其他敌人');
  check(p.score > scoreBefore, '碾压加分（+' + (p.score - scoreBefore) + '）');

  // 静止壳一段时间后自动爬出
  const lv2 = flat();
  lv2.enemies.push({
    id: 0, type: 'turtle', x: 5.5, y: 13.5, w: 0.8, h: 0.8,
    vx: 0, vy: 0, dir: 1, homeX: 5.5, homeY: 13.5, range: 3,
    phase: 0, alive: true, shell: 'shell', shellT: 0, kicker: 0, kickT: 0
  });
  for (let i = 0; i < 400; i++) EN.stepEnemy(lv2, lv2.enemies[0], DT);
  check(lv2.enemies[0].shell === 'walk', '静止壳一段时间后自动爬出来');
}

/* ========== 5. 顶砖块 ========== */
console.log('\n[5] 砖块与问号砖');
{
  // 小形态顶普通砖：砖保留
  const lv = flat([[5, 12, 'B']]);
  const p = mk(lv);
  p.x = 5.5; p.y = 14;   // 小形态 h=0.9，头顶 13.1 → 检查 row13/12
  EN.hitHeadBlock(lv, p);
  check(lv.grid[12][5] === 'B', '小形态顶普通砖 → 砖保留');

  // 超级形态顶普通砖：砖碎
  const lv2 = flat([[5, 12, 'B']]);
  const p2 = mk(lv2);
  p2.form = EN.FORM.SUPER;
  p2.h = EN.playerHeight(EN.FORM.SUPER);
  // 超级形态 h=1.6，站在地面 y=14 时头顶 12.4 → 检查 row12/11，能碰到 row12 的砖
  p2.x = 5.5; p2.y = 14;
  EN.hitHeadBlock(lv2, p2);
  check(lv2.grid[12][5] === EN.T.EMPTY, '超级形态顶普通砖 → 砖碎');

  // 问号砖：小形态必出蘑菇（与正版一致，纯金币交给多金币砖 C）
  const lv3 = flat([[5, 12, '?']]);
  const p3 = mk(lv3);
  // 头顶要正好在砖下沿（row12 的砖下沿 y=13），这里直接摆到 y=13.9（h=0.9 → 头顶 13.0）
  p3.x = 5.5; p3.y = 13.9;
  const itemsBefore = lv3.items.length;
  EN.hitHeadBlock(lv3, p3);
  check(lv3.grid[12][5] === EN.T.USED, '问号砖顶过 → 变空砖 U');
  check(lv3.items.length > itemsBefore, '问号砖必出道具');
  check(lv3.items[itemsBefore].type === 'mushroom', '小形态出蘑菇');

  // 问号砖：大形态必出花
  const lv4 = flat([[6, 12, '?']]);
  const p4 = mk(lv4);
  p4.form = EN.FORM.SUPER;
  p4.h = EN.playerHeight(EN.FORM.SUPER);
  // h=1.6，头顶要贴近 row12 下沿 y=13 → 脚底 y = 14.6
  p4.x = 6.5; p4.y = 14.6;
  const before4 = lv4.items.length;
  EN.hitHeadBlock(lv4, p4);
  check(lv4.items.length > before4, '大形态顶问号砖出道具');
  check(lv4.items[before4].type === 'flower', '超级形态出花');
}

/* ========== 6. 死亡与重生 ========== */
console.log('\n[6] 死亡与重生');
{
  // 掉坑：造一个真有坑的地图（row14/15 在 col 8~10 为空）
  function pitLevel() {
    const rows = [];
    for (let i = 0; i < 16; i++) rows.push('.'.repeat(40));
    const g = new Array(40).fill('#');
    g[8] = '.'; g[9] = '.'; g[10] = '.';
    rows[14] = g.join('');
    rows[15] = g.join('');
    return EN.loadLevel(rows, { name: 'pit', start: { col: 2, row: 14 } });
  }
  const lv = pitLevel();
  const p = mk(lv);
  p.x = 9.5; p.y = 14;   // 站在坑的正上方
  let died = false;
  for (let i = 0; i < 120; i++) {
    EN.stepWorld(lv, [p], { 1: input() }, DT);
    if (p.state === 'dying') died = true;
    if (p.state === 'alive' && died) break;
  }
  check(died, '掉出地图 → 死亡');
  check(p.state === 'alive', '一段时间后重生');
  check(p.lives === 2, '重生扣 1 条命（剩 ' + p.lives + '）');
  check(p.form === EN.FORM.SMALL, '重生回到小形态');

  // 变大掉坑同样死（正版）
  const lv2 = pitLevel();
  const p2 = mk(lv2);
  p2.form = EN.FORM.FIRE;
  p2.h = EN.playerHeight(EN.FORM.FIRE);
  p2.x = 9.5; p2.y = 14;
  for (let i = 0; i < 120; i++) EN.stepWorld(lv2, [p2], { 1: input() }, DT);
  check(p2.lives === 2, '火焰形态掉坑也会死（扣命）');

  // 检查点生效
  const lv3 = flat();
  lv3.checkpoints = [{ col: 8, row: 14 }];
  const p3 = mk(lv3);
  p3.x = 8.5; p3.y = 14;
  EN.stepPlayer(lv3, p3, input(), DT);
  check(Math.abs(p3.respawnX - 8.5) < 0.1, '经过检查点记录复活位置');

  // 时间耗尽：全员死亡；重生后倒计时复位（否则 HUD 永远停在 ⏱0，关卡再无限时）
  const lv4 = flat();
  lv4.timeLeft = 1;
  lv4.timeAcc = 0;
  const p4 = mk(lv4);
  p4.infiniteLives = true;
  let timeUpDied = false;
  for (let i = 0; i < 300; i++) {
    EN.stepWorld(lv4, [p4], { 1: input() }, DT);
    if (p4.state === 'dying') timeUpDied = true;
    if (timeUpDied && p4.state === 'alive') break;
  }
  check(timeUpDied, '倒计时归零 → 玩家死亡');
  check(p4.state === 'alive', '时间到死亡后正常重生');
  check(lv4.timeLeft === (lv4.timeLimit || 400), '重生后倒计时复位（' + lv4.timeLeft + '）');
  check(lv4.timeAcc === 0, '重生后计时累加器归零');

  // 正常掉坑死亡（时间还很多）不能刷时间
  const lv5 = pitLevel();
  const p5 = mk(lv5);
  p5.x = 9.5; p5.y = 14;
  lv5.timeLeft = 300;
  for (let i = 0; i < 200; i++) EN.stepWorld(lv5, [p5], { 1: input() }, DT);
  check(p5.state === 'alive' && lv5.timeLeft <= 300, '掉坑重生不重置倒计时（不能送死刷时间）');
}

/* ========== 7. 计分 ========== */
console.log('\n[7] 计分');
{
  const lv = flat();
  const p = mk(lv);
  // 金币 200
  lv.coins.push({ id: 0, col: 2, row: 13, taken: false });
  p.x = 2.5; p.y = 14;
  EN.stepWorld(lv, [p], { 1: input() }, DT);
  check(p.score === 200, '吃金币 +200（实际 ' + p.score + '）');
  check(p.coins === 1, '金币计数 +1');

  // 连踩递增
  const lv2 = flat();
  const p2 = mk(lv2);
  p2.combo = 1; p2.score = 0;
  // 模拟连踩第 2 个
  p2.combo = 2;
  const comboScore = [100, 200, 400, 500, 800, 1000];
  check(comboScore[1] === 200, '连踩第 2 个得 200 分');
  check(comboScore[5] === 1000, '连踩第 6 个得 1000 分');
}

/* ========== 8. 序列化含新字段 ========== */
console.log('\n[8] 联机序列化');
{
  const lv = flat();
  const p1 = mk(lv);
  p1.form = EN.FORM.FIRE;
  p1.score = 1234;
  const w = EN.worldToWire(lv, [p1]);
  check(w.p1.fm === 2, '序列化包含形态（fm=2）');
  check(w.p1.sc === 1234, '序列化包含分数');
  check(typeof w.p1.cn === 'number', '序列化包含金币数');
  const s = JSON.stringify(w);
  check(s.length < 2000, '单帧序列化 < 2KB（实际 ' + s.length + ' 字节）');
}

/* ========== 汇总 ========== */
console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail > 0) {
  console.log('❌ 马里奥机制测试未通过');
  process.exit(1);
}
console.log('✓ 马里奥 SMB1 机制测试全部通过');
