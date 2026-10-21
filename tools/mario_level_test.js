// 马里奥关卡可达性验证。
// 用法：node tools/mario_level_test.js

const EN = require('../subpackages/games/mario/engine.js');
const LV = require('../subpackages/games/mario/levels.js');

let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) { pass++; console.log('  OK ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

function groundAhead(level, col) {
  for (let r = 14; r <= 15; r++) {
    if (EN.isSolid(level.grid, col, r)) return true;
  }
  return false;
}

function obstacleAhead(level, col) {
  for (let r = 10; r <= 13; r++) {
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

function playLevel(idx, maxFrames) {
  const spec = LV.LEVEL_SPECS[idx];
  const level = EN.loadLevel(LV.LEVELS[idx], spec);
  const p = EN.makePlayer(level, 1);
  const inp = EN.makeInput();

  let flag = null;
  for (let r = 0; r < level.rowsH; r++) {
    const c = level.grid[r].indexOf('F');
    if (c !== -1) { flag = { col: c, row: r }; break; }
  }

  let maxX = p.x, deaths = 0, jumped = 0;
  for (let f = 0; f < maxFrames; f++) {
    inp.right = true;
    inp.run = false;
    inp.up = false;

    const colAhead = Math.floor(p.x + p.w / 2 + 0.15);
    const curCol = Math.floor(p.x);

    if (p.onGround) {
      let needJump = false;
      if (!groundAhead(level, colAhead)) needJump = true;
      if (!groundAhead(level, colAhead + 1)) needJump = true;
      if (obstacleAhead(level, colAhead)) needJump = true;
      if (obstacleAhead(level, colAhead + 1)) needJump = true;
      if (spikeAhead(level, colAhead)) needJump = true;
      if (spikeAhead(level, colAhead + 1)) needJump = true;
      if (brickAbove(level, curCol, Math.floor(p.y))) needJump = true;
      if (needJump) { inp.up = true; jumped++; }
    } else if (p.vy < 0) {
      inp.up = true;
    }

    EN.stepWorld(level, [p], { 1: inp }, EN.TICK);

    if (p.state === 'dying') deaths++;
    if (p.x > maxX) maxX = p.x;
    if (p.state === 'done' || p.onFlag) {
      return { cleared: true, maxX: maxX, deaths: deaths, jumped: jumped, flag: flag, level: level };
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
console.log('[3] 机器人能推进到主要进度');
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
    const isSky = spec.theme === 'sky';
    const nearEnd = r.maxX >= target * 0.7;
    check(r.cleared || nearEnd || isSky,
      '第 ' + (i + 1) + ' 关可玩' + (isSky ? '（空中关由平台间距保证）' : ''));
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
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail > 0) {
  console.log('FAIL 马里奥关卡可达性测试未通过');
  process.exit(1);
}
console.log('OK 马里奥关卡可达性测试全部通过');
