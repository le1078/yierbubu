// 马里奥扩展玩法测试：管道传送、地下金币房、食人花、星星、1UP、隐藏砖。
// 用法：node tools/mario_features_test.js

const EN = require('../subpackages/games/mario/engine.js');
const LV = require('../subpackages/games/mario/levels.js');

let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}
const DT = EN.TICK;
function input(o) { return Object.assign(EN.makeInput(), o || {}); }

console.log('\n[1] 管道传送点');
{
  const l1 = EN.loadLevel(LV.LEVELS[0], LV.LEVEL_SPECS[0]);
  const l3 = EN.loadLevel(LV.LEVELS[2], LV.LEVEL_SPECS[2]);
  check(l1.warps.length === 2, '1-1 有进/出两个传送点');
  check(l3.warps.length === 0, '1-3（空中关）没有管道传送');
  check(l1.warps[0].topRow > 0, '入口管道顶行已解析（row ' + l1.warps[0].topRow + '）');
}

console.log('\n[2] 站管道口按 ↓ 进入金币房 / 再按 ↓ 返回');
{
  const lv = EN.loadLevel(LV.LEVELS[0], LV.LEVEL_SPECS[0]);
  const p = EN.makePlayer(lv, 1);
  const w = lv.warps[0];
  p.x = w.col + 1; p.y = w.topRow; p.onGround = true;
  EN.stepWorld(lv, [p], { 1: input({ down: true }) }, DT);
  check(p.x > 100, '进入金币房（x=' + p.x.toFixed(1) + '）');
  check(p.x === w.toX && p.y === w.toY, '落点与配置一致');
  check(p.warpLock > 0, '传送后有短暂锁，防止连触');

  // 站到出口管道上返回
  const ex = lv.warps[1];
  p.x = ex.col + 1; p.y = ex.topRow; p.onGround = true; p.warpLock = 0;
  EN.stepWorld(lv, [p], { 1: input({ down: true }) }, DT);
  check(p.x < 100, '从金币房回到主关卡（x=' + p.x.toFixed(1) + '）');
  check(p.x === ex.toX, '返回点在入口管道右侧');
}

console.log('\n[3] 金币房内容');
{
  const lv = EN.loadLevel(LV.LEVELS[0], LV.LEVEL_SPECS[0]);
  const bonusCoins = lv.coins.filter(function (c) { return c.col >= 100; });
  check(bonusCoins.length >= 10, '金币房有一排金币（' + bonusCoins.length + ' 枚）');
  let hasH = false, hasQ = false, hasExit = false;
  for (let r = 0; r < lv.rowsH; r++) {
    for (let c = 100; c < lv.cols; c++) {
      if (lv.grid[r][c] === EN.T.HIDDEN) hasH = true;
      if (lv.grid[r][c] === EN.T.QUESTION) hasQ = true;
      if (lv.grid[r][c] === EN.T.PIPE) hasExit = true;
    }
  }
  check(hasH, '金币房有隐藏砖');
  check(hasQ, '金币房有问号砖');
  check(hasExit, '金币房有出口管道');
}

console.log('\n[4] 食人花：冒出 / 靠近缩回 / 不能踩');
{
  const lv = EN.loadLevel(LV.LEVELS[0], LV.LEVEL_SPECS[0]);
  const pir = lv.enemies.filter(function (e) { return e.type === EN.E.PIRANHA; })[0];
  check(!!pir, '1-1 入口管道上有食人花');

  const far = EN.makePlayer(lv, 1);
  far.x = 5; far.y = 14;
  let maxUp = 0;
  for (let f = 0; f < 300; f++) {
    EN.stepEnemy(lv, pir, DT, [far]);
    if (pir.emerge > maxUp) maxUp = pir.emerge;
  }
  check(maxUp > 0.9, '远离时会完全冒出（max=' + maxUp.toFixed(2) + '）');

  const near = EN.makePlayer(lv, 1);
  near.x = pir.x; near.y = pir.homeY;
  EN.stepEnemy(lv, pir, DT, [near]);
  check(pir.emerge === 0, '玩家站到管口时立刻缩回');

  // 冒出状态侧面撞到 → 受伤
  pir.emerge = 1; pir.y = pir.homeY - 0.9;
  const victim = EN.makePlayer(lv, 1);
  victim.x = pir.x; victim.y = pir.y + 0.3;
  EN.resolveEnemyHit(lv, victim, pir);
  check(victim.state === 'dying', '食人花不能踩，碰到就受伤');

  // 火球可以打死
  pir.alive = true;
  lv.fireballs = [{ x: pir.x, y: pir.y, w: 0.4, h: 0.4, vx: 0, vy: 0, life: 1, fromPlayer: true }];
  EN.resolvePlayerFireballHits(lv, [victim]);
  check(pir.alive === false, '火球能打死食人花');
}

console.log('\n[5] 星星无敌');
{
  const lv = EN.loadLevel(LV.LEVELS[0], LV.LEVEL_SPECS[0]);
  const p = EN.makePlayer(lv, 1);
  p.x = 121.5; p.y = 10;           // 金币房 ? 砖 (row 9, col 121) 下方
  EN.hitHeadBlock(lv, p);
  const star = lv.items.filter(function (it) { return it.type === 'star'; })[0];
  check(!!star, '金币房问号砖出星星');
  p.x = star.x; p.y = 10;
  EN.stepWorld(lv, [p], { 1: input() }, DT);
  check(p.starT > 0, '吃到星星进入无敌（' + p.starT.toFixed(1) + 's）');

  // 无敌时撞敌人 → 敌人死
  const e = lv.enemies[0];
  e.alive = true; e.x = p.x; e.y = p.y - 0.5;
  EN.resolveEnemyHit(lv, p, e);
  check(e.alive === false, '星星状态下碰到敌人直接撞飞');
  check(p.state === 'alive', '自己不会受伤');

  // 无敌时 hurtPlayer 无效
  const hp = EN.makePlayer(lv, 1);
  hp.starT = 5;
  EN.hurtPlayer(hp);
  check(hp.state === 'alive' && hp.form === EN.FORM.SMALL, '星星期间受伤无效');
}

console.log('\n[6] 1UP 蘑菇与隐藏砖');
{
  const lv = EN.loadLevel(LV.LEVELS[0], LV.LEVEL_SPECS[0]);
  const p = EN.makePlayer(lv, 1);
  p.x = 112.5; p.y = 12;           // 隐藏砖 (row 11, col 112) 下方
  const livesBefore = p.lives;
  EN.hitHeadBlock(lv, p);
  check(lv.grid[11][112] === EN.T.USED, '隐藏砖被顶后显形为空砖');
  const up = lv.items.filter(function (it) { return it.type === 'oneup'; })[0];
  check(!!up, '隐藏砖出 1UP 蘑菇');
  p.x = up.x; p.y = 12;
  EN.stepWorld(lv, [p], { 1: input() }, DT);
  check(p.lives === livesBefore + 1, '吃到 1UP 加一条命（' + livesBefore + '→' + p.lives + '）');
}

console.log('\n[7] 竞速/单机结束条件');
{
  const lv = EN.loadLevel(LV.LEVELS[0], LV.LEVEL_SPECS[0]);
  const p = EN.makePlayer(lv, 1);
  check(EN.raceWinner(lv, [p]) === 0, '单机未到终点时没有胜者');
  p.state = 'done'; p.finishT = 1;
  check(EN.raceWinner(lv, [p]) === 1, '单机到终点即获胜');
  check(EN.isLevelCleared(lv, [p]) === true, '单机一个玩家也能判定通关');
}

console.log('\n========================================');
console.log('\n[8] 单机竞速的电脑对手能通关');
{
  let allOk = true;
  for (let i = 0; i < LV.LEVELS.length; i++) {
    const lv = EN.loadLevel(LV.LEVELS[i], LV.LEVEL_SPECS[i]);
    const p = EN.makePlayer(lv, 1);
    let done = -1;
    for (let f = 0; f < 4000; f++) {
      EN.stepWorld(lv, [p], { 1: EN.makeAutoInput(lv, p) }, DT);
      if (p.state === 'done') { done = f; break; }
    }
    console.log('    第 ' + (i + 1) + ' 关：' +
      (done >= 0 ? (done / 60).toFixed(1) + 's 到达终点' : '未通关') +
      '，剩余 ' + p.lives + ' 条命');
    if (done < 0) allOk = false;
  }
  check(allOk, '5 关电脑对手都能到达终点（可作单人竞速对手）');
}

console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail > 0) {
  console.log('❌ 马里奥扩展玩法测试未通过');
  process.exit(1);
}
console.log('✓ 马里奥扩展玩法测试全部通过');
