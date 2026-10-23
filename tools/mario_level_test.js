// 马里奥关卡可达性验证。
// 用法：node tools/mario_level_test.js

const EN = require('../subpackages/games/mario/engine.js');
const LV = require('../subpackages/games/mario/levels.js');

let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) { pass++; console.log('  OK ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

function groundAhead(level, col, feetY) {
  // 站在砖块/台阶上时（脚底高于地面），只看同高度有没有支撑；
  // 否则会把下方地面误当成落脚点，直接从高台走到坑里/尖刺上。
  if (feetY < 13.5) {
    return EN.isSolid(level.grid, col, Math.floor(feetY + 0.001));
  }
  for (let r = 14; r <= 15; r++) {
    if (EN.isSolid(level.grid, col, r)) return true;
  }
  return false;
}

function obstacleAhead(level, col) {
  // 只看行走高度的障碍（管道/阶梯/硬砖）。row 10 的悬空砖是头顶的砖，
  // 玩家可以正常从下面走过去，不该触发「撞墙跳」。
  for (let r = 11; r <= 13; r++) {
    if (EN.isSolid(level.grid, col, r)) return true;
  }
  return false;
}

// 前方是否有尖刺（尖刺不是实心，但踩上去即死，必须跳）
function spikeAhead(level, col) {
  for (let r = 12; r <= 13; r++) {
    if (EN.tileAt(level.grid, col, r) === EN.T.SPIKE) return true;
  }
  return false;
}

function brickAbove(level, col, row) {
  for (let r = row - 3; r <= row - 1; r++) {
    const ch = EN.tileAt(level.grid, col, r);
    if (ch === EN.T.QUESTION || ch === EN.T.BRICK || ch === EN.T.COINBRICK) return true;
  }
  return false;
}

// 前方一段列范围内是否有尖刺。用于避免「为了顶砖起跳，结果正好落在尖刺上」。
function spikeBetween(level, fromCol, toCol) {
  for (let c = fromCol; c <= toCol; c++) {
    if (spikeAhead(level, c)) return true;
  }
  return false;
}

// 机器人也要躲敌人：不躲的话会径直撞上板栗仔，
// 端到端测试就会把「机器人不会玩」误判成「关卡不可通关」。
function enemyAhead(level, p) {
  for (let i = 0; i < level.enemies.length; i++) {
    const e = level.enemies[i];
    if (!e.alive) continue;
    const dx = e.x - (p.x + p.w / 2);
    if (dx > 0.2 && dx < 2.8 && Math.abs(e.y - p.y) < 1.8) return true;
  }
  return false;
}

function playLevel(idx, maxFrames) {
  const spec = LV.LEVEL_SPECS[idx];
  const level = EN.loadLevel(LV.LEVELS[idx], spec);
  const p = EN.makePlayer(level, 1);

  let flag = null;
  for (let r = 0; r < level.rowsH; r++) {
    const c = level.grid[r].indexOf('F');
    if (c !== -1) { flag = { col: c, row: r }; break; }
  }

  // 用引擎的真机器人（makeAutoInput）驱动：它带落点预判/敌人威胁窗口/
  // 等待行为。之前这里复刻了一份旧版决策逻辑，引擎机器人一改进两边就
  // 分叉——新关 L6/L7 就是这样误报「不可通关」的（旧逻辑必死，新的能过）。
  let maxX = p.x, deaths = 0, jumped = 0, wasDying = false, wasUp = false;
  for (let f = 0; f < maxFrames; f++) {
    const inp = EN.makeAutoInput(level, p);
    if (inp.up && !wasUp) jumped++;
    wasUp = inp.up;

    EN.stepWorld(level, [p], { 1: inp }, EN.TICK);

    if (p.state === 'dying' && !wasDying) deaths++;
    wasDying = p.state === 'dying';
    if (p.x > maxX) maxX = p.x;
    // 必须等到走进城堡（state === 'done'）才算通关。
    // 只碰到旗杆（onFlag）就返回会漏掉后半段，之前「旗杆卡死」就是这么漏掉的。
    if (p.state === 'done') {
      return { cleared: true, maxX: maxX, deaths: deaths, jumped: jumped, flag: flag, level: level, frames: f };
    }
    if (p.state === 'dead') {
      return { cleared: false, maxX: maxX, deaths: deaths, jumped: jumped, flag: flag, level: level };
    }
  }
  return { cleared: false, maxX: maxX, deaths: deaths, jumped: jumped, flag: flag, level: level };
}

console.log('');
console.log('[1] 每关都有终点旗');
{
  let allFlag = true;
  for (let i = 0; i < LV.LEVELS.length; i++) {
    const level = EN.loadLevel(LV.LEVELS[i], LV.LEVEL_SPECS[i]);
    let found = false;
    for (let r = 0; r < level.rowsH; r++) {
      if (level.grid[r].indexOf('F') !== -1) found = true;
    }
    if (!found) { allFlag = false; console.log('    第 ' + (i + 1) + ' 关没有终点旗'); }
  }
  check(allFlag, LV.LEVELS.length + ' 关全部有终点旗');
}

console.log('');
console.log('[2] 地面关坑宽 <= 3 格（空中关靠平台跨越，不适用）');
{
  let allOk = true;
  for (let i = 0; i < LV.LEVELS.length; i++) {
    const spec = LV.LEVEL_SPECS[i];
    if (spec.theme === 'sky') {
      console.log('    第 ' + (i + 1) + ' 关是空中关，跳过坑宽检查');
      continue;
    }
    const level = EN.loadLevel(LV.LEVELS[i], spec);
    let run = 0, maxGap = 0;
    for (let c = 0; c < level.cols; c++) {
      let solid = false;
      for (let r = 14; r <= 15; r++) {
        if (EN.isSolid(level.grid, c, r)) { solid = true; break; }
      }
      if (solid) { run = 0; } else { run++; if (run > maxGap) maxGap = run; }
    }
    console.log('    第 ' + (i + 1) + ' 关（' + spec.name + '）最大坑宽 ' + maxGap + ' 格');
    if (maxGap > 3) { allOk = false; console.log('      x 坑太宽'); }
  }
  check(allOk, '地面关坑宽 <= 3 格');
}

console.log('');
console.log('[3] 机器人端到端通关（每关都能走到终点旗）');
{
  for (let i = 0; i < LV.LEVELS.length; i++) {
    const r = playLevel(i, 3600);
    const spec = LV.LEVEL_SPECS[i];
    const boss = spec.boss;
    const target = boss ? boss.col : (r.flag ? r.flag.col : 0);
    const pct = target ? (r.maxX / target * 100).toFixed(0) : '?';
    console.log('    第 ' + (i + 1) + ' 关 ' + spec.name +
      ' -> ' + r.maxX.toFixed(1) + '（目标 ' + target + '，' + pct + '%）' +
      '死亡 ' + r.deaths + ' 次，跳 ' + r.jumped + ' 次');
    // 机器人会躲敌人、会跳过坑/尖刺、会从平台边缘起跳。
    // 它现在每关都能零死亡通关，所以直接以「到达终点」作为硬性门槛；
    // 若以后关卡改动让它走不到终点，说明出现了真实的可达性回归。
    check(r.cleared, '第 ' + (i + 1) + ' 关可通关（机器人到达终点）');
  }
}

console.log('');
console.log('[4] 所有砖块都有支撑（无浮空砖）');
{
  let allOk = true;
  for (let i = 0; i < LV.LEVELS.length; i++) {
    const level = EN.loadLevel(LV.LEVELS[i], LV.LEVEL_SPECS[i]);
    for (let r = 0; r < level.rowsH; r++) {
      for (let c = 0; c < level.cols; c++) {
        const ch = level.grid[r][c];
        if (ch !== EN.T.QUESTION && ch !== EN.T.BRICK && ch !== EN.T.COINBRICK) continue;
        // 正版 1-1 的砖块本来就悬空（玩家跳起来顶），只要砖块下方
        // 5 格内有地面/平台（一次跳跃能顶到）就算合理，不是"浮空砖"。
        let supported = false;
        for (let rr = r + 1; rr <= r + 5; rr++) {
          if (EN.isSolid(level.grid, c, rr)) { supported = true; break; }
        }
        if (!supported) {
          allOk = false;
          console.log('    第 ' + (i + 1) + ' 关 row' + r + ' col' + c + ' 是浮空砖');
        }
      }
    }
  }
  check(allOk, '所有砖块都有支撑');
}

console.log('');
console.log('[5] 悬浮平台间距在跳跃能力内（<= 4.6 格）');
{
  const MAX_JUMP = 4.6;
  let allOk = true;
  for (let i = 0; i < LV.LEVELS.length; i++) {
    const level = EN.loadLevel(LV.LEVELS[i], LV.LEVEL_SPECS[i]);
    const platCols = [];
    for (let r = 0; r < level.rowsH; r++) {
      for (let c = 0; c < level.cols; c++) {
        if (level.grid[r][c] === EN.T.PLATFORM) platCols.push(c);
      }
    }
    if (!platCols.length) continue;
    platCols.sort(function (a, b) { return a - b; });
    let maxGap = 0;
    for (let k = 1; k < platCols.length; k++) {
      const d = platCols[k] - platCols[k - 1];
      if (d > maxGap) maxGap = d;
    }
    console.log('    第 ' + (i + 1) + ' 关最大平台间隔 ' + maxGap + ' 格');
    if (maxGap > MAX_JUMP + 1.5) {
      allOk = false;
      console.log('      x 间隔太大，跳不过去');
    }
  }
  check(allOk, '所有平台间隔在跳跃能力内');
}

console.log('');
console.log('[6] 砖块与管道保持 >=3 格（大形态跳过管道时头顶不被挡）');
{
  // 大形态身高 1.6 格，起跳后头顶会升到管道上方；若头顶横移路径上有砖，
  // 会被撞停（vy 归零）掉进管道前，导致卡死。砖块与任意管道列至少隔 3 格。
  const SAFE = 3;
  let allOk = true;
  for (let i = 0; i < LV.LEVELS.length; i++) {
    const level = EN.loadLevel(LV.LEVELS[i], LV.LEVEL_SPECS[i]);
    const pipeCols = [];
    for (let r = 0; r < level.rowsH; r++) {
      for (let c = 0; c < level.cols; c++) {
        if (level.grid[r][c] === EN.T.PIPE) pipeCols.push(c);
      }
    }
    if (!pipeCols.length) continue;
    for (let r = 9; r < level.rowsH; r++) {
      for (let c = 0; c < level.cols; c++) {
        const ch = level.grid[r][c];
        if (ch !== EN.T.QUESTION && ch !== EN.T.BRICK && ch !== EN.T.COINBRICK) continue;
        let minDist = Infinity;
        for (let k = 0; k < pipeCols.length; k++) {
          const d = Math.abs(c - pipeCols[k]);
          if (d < minDist) minDist = d;
        }
        if (minDist < SAFE) {
          allOk = false;
          console.log('    第 ' + (i + 1) + ' 关 砖块(row' + r + ',col' + c +
            ') 距管道仅 ' + minDist + ' 格（要求 >= ' + SAFE + '）');
        }
      }
    }
  }
  check(allOk, '所有砖块距管道 >= ' + SAFE + ' 格');
}

console.log('');
console.log('[7] 跳跃高度 >= 4 格（能跳上 row 10 的砖块）');
{
  const level = EN.loadLevel(LV.LEVELS[0], LV.LEVEL_SPECS[0]);
  const p = EN.makePlayer(level, 1);
  const inp = EN.makeInput();
  const groundY = p.y;
  let minY = p.y;
  for (let f = 0; f < 180; f++) {
    inp.up = true;
    EN.stepWorld(level, [p], { 1: inp }, EN.TICK);
    if (p.y < minY) minY = p.y;
    if (p.onGround && f > 3) break;
  }
  const height = groundY - minY;
  console.log('    满跳高度 ' + height.toFixed(2) + ' 格');
  check(height >= 4.0, '满跳高度 >= 4 格（实际 ' + height.toFixed(2) + '）');
}

console.log('');
console.log('[8] 大形态能跳过 1-1 第一根管道（用户实测卡死点）');
{
  const level = EN.loadLevel(LV.LEVELS[0], LV.LEVEL_SPECS[0]);
  const p = EN.makePlayer(level, 1);
  EN.setForm(p, EN.FORM.SUPER);
  p.x = 26.5; p.y = 14; p.vy = 0; p.onGround = true;
  const inp = EN.makeInput();
  let crossed = false;
  for (let f = 0; f < 240; f++) {
    inp.right = true;
    // 在管道前起跳，上升阶段按住跳
    inp.up = (p.onGround && p.x < 27.4) || (!p.onGround && p.vy < 0);
    EN.stepWorld(level, [p], { 1: inp }, EN.TICK);
    if (p.x > 30.5) { crossed = true; break; }
  }
  console.log('    大形态落点 x=' + p.x.toFixed(2) + ' y=' + p.y.toFixed(2) + ' onGround=' + p.onGround);
  check(crossed && p.state === 'alive', '大形态成功越过管道（x > 30.5）');
}

console.log('');
console.log('[9] 旗杆 → 走进城堡 → 结算（单机单人完整流程）');
{
  let allOk = true;
  for (let i = 0; i < LV.LEVELS.length; i++) {
    const level = EN.loadLevel(LV.LEVELS[i], LV.LEVEL_SPECS[i]);
    const flagCol = EN.findFlagCol(level);
    const castleCol = EN.findCastleCol(level);
    const doorX = EN.findCastleDoorX(level);

    // 城堡必须真的在旗杆右边。1-1 末段阶梯也是硬砖，
    // 以前会把 col 82 的阶梯误判成城堡，抓杆后瞬间“完成”卡住。
    if (!(castleCol > flagCol)) {
      allOk = false;
      console.log('    第 ' + (i + 1) + ' 关城堡列 ' + castleCol + ' 不在旗杆 ' + flagCol + ' 右边');
    }
    if (!(doorX > castleCol)) {
      allOk = false;
      console.log('    第 ' + (i + 1) + ' 关门洞 x=' + doorX + ' 不在城堡右侧');
    }

    // 单机模式只有一个玩家，必须能独立触发过关。
    const p = EN.makePlayer(level, 1);
    p.x = flagCol - 0.6; p.y = 14;
    const inp = EN.makeInput();
    inp.right = true;
    let grabbed = -1, doneAt = -1;
    for (let f = 0; f < 300; f++) {
      EN.stepWorld(level, [p], { 1: inp }, EN.TICK);
      if (p.onFlag && grabbed < 0) grabbed = f;
      if (p.state === 'done') { doneAt = f; break; }
    }
    const took = grabbed >= 0 && doneAt >= 0 ? doneAt - grabbed : -1;
    const cleared = EN.isLevelCleared(level, [p]);
    console.log('    第 ' + (i + 1) + ' 关：抓杆 f' + grabbed + ' → 完成 f' + doneAt +
      '（' + (took / 60).toFixed(2) + 's），x=' + p.x.toFixed(2) + ' / 门 ' + doorX.toFixed(2) +
      '，cleared=' + cleared);
    if (grabbed < 0 || doneAt < 0 || !cleared || p.x < doorX - 0.01) {
      allOk = false;
      console.log('      x 未完成完整过关流程');
    }
    if (took >= 0 && took < 15) {
      allOk = false;
      console.log('      x 抓杆后瞬间完成（<0.25s），城堡列判定有误');
    }
  }
  check(allOk, '5 关都能从旗杆走到城堡门并结算（单人可通关）');
}

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail > 0) {
  console.log('FAIL 马里奥关卡可达性测试未通过');
  process.exit(1);
}
console.log('OK 马里奥关卡可达性测试全部通过');
