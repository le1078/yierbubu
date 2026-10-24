// 关卡数据完整性校验：出生点、检查点、金币、敌人、平台、管道目标、Boss
// 是否都在合法位置（不卡在墙里、不悬空、不出界）。
//
// 这类错误不会崩，但会让内容"看得到吃不到"：金币埋进砖里、敌人卡在墙里
// 原地抖动、检查点悬空导致复活即死（1-3 就踩过这个）。
//
// 用法：node tools/level_data_check.js

const path = require('path');
const EN = require(path.join(__dirname, '..', 'subpackages/games/mario/engine.js'));
const LV = require(path.join(__dirname, '..', 'subpackages/games/mario/levels.js'));

let pass = 0, fail = 0;
const problems = [];
function check(cond, name) {
  if (cond) { pass++; return true; }
  fail++;
  problems.push(name);
  console.log('  ❌ ' + name);
  return false;
}

const T = EN.T;
const SOLIDISH = {};
SOLIDISH[T.GROUND] = 1; SOLIDISH[T.BRICK] = 1; SOLIDISH[T.QUESTION] = 1;
SOLIDISH[T.PIPE] = 1; SOLIDISH[T.ICE] = 1; SOLIDISH[T.PLATFORM] = 1;
SOLIDISH[T.LIFT] = 1; SOLIDISH[T.USED] = 1; SOLIDISH[T.HARD] = 1;
SOLIDISH[T.COINBRICK] = 1; SOLIDISH[T.HIDDEN] = 1;

for (let i = 0; i < LV.LEVELS.length; i++) {
  const spec = LV.LEVEL_SPECS[i];
  const lv = EN.loadLevel(LV.LEVELS[i], spec);
  const tag = '第 ' + (i + 1) + ' 关（' + spec.name + '）';
  const inGrid = (c, r) => c >= 0 && c < lv.cols && r >= 0 && r < lv.rowsH;
  const solidAt = (c, r) => !!SOLIDISH[EN.tileAt(lv.grid, c, r)];

  // 出生点/检查点的 row 是「脚底 y」。引擎的支撑判定是
  // supportRow = floor(y + 0.02)，也就是「脚底所在那一行」必须是实心；
  // 上一行要空，否则人一出生就卡在墙里。
  {
    const st = spec.start;
    const ok = inGrid(st.col, st.row) &&
      solidAt(st.col, st.row) && !solidAt(st.col, st.row - 1);
    check(ok, tag + ' 出生点在实地上且头顶有空（' + st.col + ',' + st.row + '）');
  }
  for (const cp of spec.checkpoints || []) {
    const ok = inGrid(cp.col, cp.row) &&
      solidAt(cp.col, cp.row) && !solidAt(cp.col, cp.row - 1);
    check(ok, tag + ' 检查点 ' + cp.col + ',' + cp.row + ' 站在实地上且头顶有空');
  }

  // 金币：不能在实心块里（否则吃不到）
  let coinInWall = 0;
  for (const c of spec.coins || []) {
    if (!inGrid(c.col, c.row)) { coinInWall++; continue; }
    if (solidAt(c.col, c.row)) coinInWall++;
  }
  check(coinInWall === 0, tag + ' 所有金币都不在实心块内（异常 ' + coinInWall + ' 个）');

  // 敌人：出界或卡在实心块里都不对（飞行/食人花允许悬空）
  let badEnemy = 0;
  for (const e of spec.enemies || []) {
    if (!inGrid(e.col, e.row)) { badEnemy++; continue; }
    if (e.type === 'flyer' || e.type === 'piranha') continue;
    // 地面敌人：脚下一格应是实心
    if (!solidAt(e.col, e.row + 1)) badEnemy++;
  }
  check(badEnemy === 0, tag + ' 所有地面敌人脚下都是实地（异常 ' + badEnemy + ' 个）');

  // 平台：参数合法
  let badPlat = 0;
  for (const p of spec.platforms || []) {
    if (!inGrid(p.col, p.row) || !(p.len > 0) || !(p.speed > 0)) badPlat++;
  }
  check(badPlat === 0, tag + ' 平台参数合法（异常 ' + badPlat + ' 个）');

  // 管道目标点：落点不能在墙里
  let badWarp = 0;
  for (const w of lv.warps) {
    const c = Math.floor(w.toX), r = Math.floor(w.toY);
    // 落点是脚底：脚下实心、身体位置（上一行）空
    if (!inGrid(c, r) || !solidAt(c, r) || solidAt(c, r - 1)) badWarp++;
  }
  check(badWarp === 0, tag + ' 管道传送目标不在墙里（异常 ' + badWarp + ' 个）');

  // Boss：在格内、且在旗杆之前（到不了等于没做）
  let flagCol = -1;
  for (let r = 0; r < lv.rowsH && flagCol < 0; r++) {
    flagCol = lv.grid[r].indexOf('F');
  }
  for (const b of lv.bosses || []) {
    check(inGrid(Math.floor(b.homeX), Math.floor(b.y)) && b.homeX < flagCol,
      tag + ' Boss 位置合法且在旗杆前（' + b.homeX + ' < ' + flagCol + '）');
  }
  check(flagCol >= 0, tag + ' 有终点旗');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail > 0) {
  console.log('失败明细：');
  for (const p of problems) console.log('  - ' + p);
  console.log('❌ 关卡数据校验未通过');
  process.exit(1);
}
console.log('✓ 关卡数据校验全部通过');
