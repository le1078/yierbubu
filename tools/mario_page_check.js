// 页面-引擎一致性检查：防「引擎接口改了，页面没跟着改」这类 bug。
//
// 背景：引擎从 p.big 改成 p.form 后，页面层还在读写 p.big，
// 导致联机时形态不同步（吃蘑菇对方看不到，自己也回退）。
// 这类 bug 单元测试测不出来（引擎是对的），必须静态扫描页面代码。
//
// 检查项：
//   1. 页面/渲染层不得引用已废弃的字段（p.big）
//   2. 页面读写的引擎属性必须真实存在于引擎对象上
//   3. 页面用到的引擎导出函数必须存在
//   4. 序列化字段（worldToWire 产出）与页面读取的字段一一对应
//
// 用法：node tools/mario_page_check.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MARIO_DIR = path.join(ROOT, 'subpackages/games/mario');

let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) { pass++; console.log('  OK ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

const pageSrc = fs.readFileSync(path.join(MARIO_DIR, 'mario.js'), 'utf8');
const renderSrc = fs.readFileSync(path.join(MARIO_DIR, 'render.js'), 'utf8');
const engineSrc = fs.readFileSync(path.join(MARIO_DIR, 'engine.js'), 'utf8');
const EN = require(path.join(MARIO_DIR, 'engine.js'));

console.log('');
console.log('[1] 不得引用已废弃字段');
{
  // p.big 已在引擎里被 p.form 取代
  const badPage = /\.big\b/.test(pageSrc);
  check(!badPage, 'mario.js 不再使用 p.big（已改为 p.form）');
  // render.js 允许有兼容分支，但不该主打 big
  const bigInRender = (renderSrc.match(/p\.big/g) || []).length;
  check(bigInRender <= 1, 'render.js 只在兼容分支里提 p.big（' + bigInRender + ' 处）');
}

console.log('');
console.log('[2] 页面读取的引擎对象字段必须存在');
{
  // 造一个真实关卡 + 玩家，检查页面里用到的字段名都在
  const LV = require(path.join(MARIO_DIR, 'levels.js'));
  const level = EN.loadLevel(LV.LEVELS[0], LV.LEVEL_SPECS[0]);
  const p = EN.makePlayer(level, 1);
  const levelKeys = Object.keys(level);
  const playerKeys = Object.keys(p);

  // 页面里 this._level.xxx 与 this._players[i].xxx 的用法
  const levelFieldRe = /this\._level\.([A-Za-z_$][\w$]*)/g;
  const playerFieldRe = /this\._players\[[^\]]+\]\.([A-Za-z_$][\w$]*)/g;

  let m, missingLevel = [], missingPlayer = [];
  while ((m = levelFieldRe.exec(pageSrc))) {
    const f = m[1];
    if (levelKeys.indexOf(f) === -1 && f !== 'length') missingLevel.push(f);
  }
  while ((m = playerFieldRe.exec(pageSrc))) {
    const f = m[1];
    if (playerKeys.indexOf(f) === -1) missingPlayer.push(f);
  }
  check(missingLevel.length === 0,
    '页面用到的 level 字段全部存在' + (missingLevel.length ? '（缺: ' + missingLevel.join(',') + '）' : ''));
  check(missingPlayer.length === 0,
    '页面用到的 player 字段全部存在' + (missingPlayer.length ? '（缺: ' + missingPlayer.join(',') + '）' : ''));
}

console.log('');
console.log('[3] 页面调用的引擎函数必须导出');
{
  const exported = Object.keys(EN);
  const callRe = /EN\.([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  const missing = [];
  while ((m = callRe.exec(pageSrc))) {
    if (exported.indexOf(m[1]) === -1) missing.push(m[1]);
  }
  check(missing.length === 0,
    '页面调用的 EN.* 函数全部已导出' + (missing.length ? '（缺: ' + missing.join(',') + '）' : ''));
}

console.log('');
console.log('[4] 序列化字段与页面读取一致');
{
  const LV = require(path.join(MARIO_DIR, 'levels.js'));
  const level = EN.loadLevel(LV.LEVELS[0], LV.LEVEL_SPECS[0]);
  const p = EN.makePlayer(level, 1);
  const w = EN.worldToWire(level, [p, EN.makePlayer(level, 2)]);
  const wireKeys = Object.keys(w.p1);

  // 页面里 w.p1.xxx / myW.xxx / oppW.xxx 的读取
  const reads = [];
  const re = /(?:w\.p1|w\.p2|myW|oppW)\.([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(pageSrc))) reads.push(m[1]);
  const uniq = reads.filter(function (v, i, a) { return a.indexOf(v) === i; });
  const missing = uniq.filter(function (f) { return wireKeys.indexOf(f) === -1; });
  check(missing.length === 0,
    '页面读取的序列化字段都存在' + (missing.length ? '（缺: ' + missing.join(',') + '）' : ''));
  check(wireKeys.indexOf('fm') !== -1, '序列化包含形态字段 fm');
  check(wireKeys.indexOf('sc') !== -1, '序列化包含分数字段 sc');
}

console.log('');
console.log('[5] 渲染层引用的瓦片类型都存在');
{
  // render.js 的 drawTile 里 case 'X' 之类必须都在 T 里
  const caseRe = /case '([^']+)':/g;
  const tiles = Object.keys(EN.T).map(function (k) { return EN.T[k]; });
  let m;
  const unknown = [];
  while ((m = caseRe.exec(renderSrc))) {
    const ch = m[1];
    // 跳过非瓦片的 case（比如状态字符串）
    if (tiles.indexOf(ch) === -1 && ch.length === 1 && ch !== ' ') {
      unknown.push(ch);
    }
  }
  check(unknown.length === 0,
    '渲染层所有 case 都是已知瓦片' + (unknown.length ? '（未知: ' + unknown.join(',') + '）' : ''));
}

console.log('');
console.log('[6] 关键玩法字段在页面层有同步');
{
  // 形态、壳状态、分数、倒计时必须被页面同步
  check(/\.form\b/.test(pageSrc), '页面同步玩家形态 form');
  check(/\.shell\b/.test(pageSrc), '页面同步龟壳状态 shell');
  check(/\.score\b/.test(pageSrc), '页面同步分数 score');
  check(/timeLeft/.test(pageSrc), '页面同步倒计时 timeLeft');
  check(/onFlag/.test(pageSrc) || /state === 'done'/.test(pageSrc) ||
        /isLevelCleared/.test(pageSrc) || /raceWinner/.test(pageSrc),
    '页面处理过关状态（isLevelCleared / raceWinner / onFlag 任一）');
}

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail > 0) {
  console.log('FAIL 页面-引擎一致性检查未通过');
  process.exit(1);
}
console.log('OK 页面-引擎一致性检查全部通过');
