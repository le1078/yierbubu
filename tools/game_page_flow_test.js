// 游戏页面流程测试：不渲染 canvas，只验证「点模式 → 选难度 → 开局 → 返回」
// 这类页面状态流转。重点防：
//   · 象棋进人机后跳过难度页
//   · 武侠/五子棋 AI 计时器在重开/悔棋后把棋下到新棋盘
//   · 五子棋 AI 返回按钮错误地回到联机大厅
//   · 联机模式点重开/悔棋导致本地分叉
//
// 用法：node tools/game_page_flow_test.js

const path = require('path');

let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

// ---- mock 小程序环境 ----
let capturedPage = null;
global.Page = function (def) { capturedPage = def; };
global.getApp = function () { return { globalData: {} }; };
const toasts = [];
global.wx = {
  showToast: function (o) { toasts.push(o && o.title); },
  showModal: function () {},
  hideLoading: function () {},
  showLoading: function () {},
  createSelectorQuery: function () {
    const q = {
      in: function () { return q; },
      select: function () { return q; },
      fields: function () { return q; },
      exec: function (cb) { if (cb) cb([]); }
    };
    return q;
  },
  createOffscreenCanvas: function () {
    return { width: 0, height: 0, getContext: function () { return {}; } };
  },
  cloud: {
    database: function () {
      return {
        collection: function () {
          return {
            doc: function () {
              return { update: function () { return Promise.resolve(); } };
            }
          };
        }
      };
    }
  }
};

function loadPage(rel) {
  capturedPage = null;
  delete require.cache[require.resolve(path.join(__dirname, '..', rel))];
  require(path.join(__dirname, '..', rel));
  if (!capturedPage) throw new Error('Page() not called: ' + rel);
  return capturedPage;
}

function instantiate(def) {
  const page = {};
  for (const k of Object.keys(def)) page[k] = def[k];
  page.data = JSON.parse(JSON.stringify(def.data || {}));
  page.setData = function (patch, cb) {
    if (patch) {
      for (const k of Object.keys(patch)) this.data[k] = patch[k];
    }
    if (typeof cb === 'function') cb();
  };
  // 不碰 canvas：这些方法在页面里只负责绘制/查询
  page._ensureCanvas = function () {};
  page._drawBoard = function () {};
  page._measureBoard = function () {};
  return page;
}

function tap(dataset) {
  return { currentTarget: { dataset: dataset } };
}

/* ============================================================
 * 1. 中国象棋：人机模式必须先进难度选择页
 * ============================================================ */
console.log('\n[1] 象棋人机：模式 → 难度页 → 开局');
{
  const def = loadPage('subpackages/games/xiangqi/xiangqi.js');
  const page = instantiate(def);
  let aiTurns = 0;
  page._aiTurn = function () { aiTurns++; };

  page.pickMode(tap({ mode: 'ai' }));
  check(page.data.stage === 'aisetup', '点人机进入难度选择页（stage=aisetup）');
  check(typeof page.pickDifficulty === 'function', '存在 pickDifficulty 方法');
  check(typeof page.pickSide === 'function', '存在 pickSide 方法');
  check(typeof page.startAiGame === 'function', '存在 startAiGame 方法');

  page.pickDifficulty(tap({ d: 'hard' }));
  check(page.data.difficulty === 'hard' && page.data.difficultyText === '困难',
    '选择困难后 difficulty/difficultyText 同步');

  page.pickSide(tap({ s: '2' }));
  check(page.data.mySide === 2, '选择执黑后 mySide=2');

  page.startAiGame();
  check(page.data.stage === 'playing', '点开始后进入对局');
  check(page.data.oppName.indexOf('困难') !== -1, '对手名显示所选难度（' + page.data.oppName + '）');
  check(aiTurns === 1, '执黑时 AI 先走（_aiTurn 调用 ' + aiTurns + ' 次）');

  page.restart();
  check(page.data.stage === 'playing' && page.data.difficulty === 'hard',
    '重开保持所选难度');

  page.backToMenu();
  check(page.data.stage === 'menu', '返回主菜单（不是联机大厅）');
}

/* ============================================================
 * 2. 五子棋人机：难度页、执子、返回、思考提示位置
 * ============================================================ */
console.log('\n[2] 五子棋人机：模式 → 难度页 → 开局');
{
  const def = loadPage('subpackages/games/gomokuai/gomokuai.js');
  const page = instantiate(def);
  let aiTurns = 0;
  page._aiTurn = function () { aiTurns++; };

  page.pickMode(tap({ mode: 'ai' }));
  check(page.data.stage === 'aisetup', '点人机进入难度选择页');

  page.pickDifficulty(tap({ d: 'easy' }));
  page.pickColor(tap({ c: '1' }));
  page.startGame();
  check(page.data.stage === 'playing' && page.data.mode === 'ai', '开始人机对局');
  check(page.data.difficulty === 'easy' && page.data.myColor === 1, '难度/执子生效');
  check(aiTurns === 0, '我执黑先手时 AI 不先走');

  // 执白：AI 先走
  page.data.myColor = 2;
  page.startGame();
  check(aiTurns === 1, '我执白时 AI 先走');

  page.backToMenu();
  check(page.data.stage === 'menu', '返回主菜单（不是联机大厅）');
}

/* ============================================================
 * 2b. 五子棋悔棋后的轮次必须正确
 * ============================================================ */
console.log('\n[2b] 五子棋悔棋轮次');
{
  const core = require(path.join(__dirname, '..', 'utils/gomoku_core.js'));
  const def = loadPage('subpackages/games/gomokuai/gomokuai.js');
  const page = instantiate(def);
  page.data.mode = 'ai';
  page.data.myColor = 2;
  page.data.stage = 'playing';
  let aiCalls = 0;
  page._aiTurn = function () { aiCalls++; };

  // 我执白，历史里只有 AI 的黑棋首手 → 悔掉后应该还是 AI（黑）先走
  page._board = core.emptyBoard();
  page._board[7][7] = 1;
  page._history = [{ r: 7, c: 7, color: 1 }];
  page.undo();
  check(page.data.turn === 1 && aiCalls === 1,
    '我执白、只剩 AI 首手时悔棋 → 轮到 AI 重走（turn=' + page.data.turn + '）');

  // 我执白，AI 刚下完第二手 → 悔棋后轮到我（白）
  page._board = core.emptyBoard();
  page._board[7][7] = 1; page._board[7][8] = 2; page._board[8][7] = 1;
  page._history = [
    { r: 7, c: 7, color: 1 },
    { r: 7, c: 8, color: 2 },
    { r: 8, c: 7, color: 1 }
  ];
  aiCalls = 0;
  page.undo();
  check(page.data.turn === 2, 'AI 刚走完时悔棋 → 轮到我方（turn=' + page.data.turn + '）');
  check(page._history.length === 1, '撤到「我上一手之前」（剩 ' + page._history.length + ' 手）');
  check(aiCalls === 0, '轮到我方时不会误触发 AI');
}

/* ============================================================
 * 3. 联机模式的危险操作必须被拦住
 * ============================================================ */
console.log('\n[3] 联机模式：重开/悔棋不能本地分叉');
{
  // 象棋
  const xqDef = loadPage('subpackages/games/xiangqi/xiangqi.js');
  const xq = instantiate(xqDef);
  xq.data.mode = 'online';
  xq.data.stage = 'playing';
  xq._history = [{ from: 0, to: 0, captured: 0 }, { from: 1, to: 1, captured: 0 }];
  const beforeHistory = xq._history.length;
  toasts.length = 0;
  xq.undo();
  check(xq._history.length === beforeHistory, '象棋联机悔棋被拒绝（历史未变）');
  check(toasts.some(function (t) { return t && t.indexOf('暂不支持') !== -1; }),
    '象棋联机悔棋给出提示');
  toasts.length = 0;
  xq.restart();
  check(xq.data.stage === 'playing' && toasts.length > 0, '象棋联机重开被拒绝');

  // 五子棋
  const gDef = loadPage('subpackages/games/gomokuai/gomokuai.js');
  const g = instantiate(gDef);
  g.data.mode = 'online';
  g.data.stage = 'playing';
  g._history = [{ r: 7, c: 7, color: 1 }];
  const gBefore = g._history.length;
  toasts.length = 0;
  g.undo();
  check(g._history.length === gBefore, '五子棋联机悔棋被拒绝（历史未变）');
  check(toasts.some(function (t) { return t && t.indexOf('暂不支持') !== -1; }),
    '五子棋联机悔棋给出提示');
  toasts.length = 0;
  g.restart();
  check(g.data.mode === 'online' && toasts.length > 0,
    '五子棋联机重开被拒绝（不会切成人机）');
}

/* ============================================================
 * 4. 画布重建与 watcher 生命周期
 * ============================================================ */
console.log('\n[4] 重新进入对局：画布必须重新查询');
{
  const xqDef = loadPage('subpackages/games/xiangqi/xiangqi.js');
  check(typeof xqDef._resetCanvas === 'function' &&
        /_resetCanvas/.test(xqDef._startLocal.toString()) &&
        /_resetCanvas/.test(xqDef.backToMenu.toString()),
    '象棋：进对局/返回菜单都会重置画布');

  const gDef = loadPage('subpackages/games/gomokuai/gomokuai.js');
  check(typeof gDef._resetCanvas === 'function' &&
        /_resetCanvas/.test(gDef._startGame.toString()) &&
        /_resetCanvas/.test(gDef.backToMenu.toString()),
    '五子棋人机：进对局/返回菜单都会重置画布');

  const onlineDef = loadPage('subpackages/games/gomoku/gomoku.js');
  check(typeof onlineDef._resetCanvas === 'function' &&
        /_resetCanvas/.test(onlineDef.joinRoom.toString()),
    '五子棋联机：加入房间会重置画布');

  // 房主开局后必须继续 watch 对方落子
  const xqRoom = xqDef._onRoomUpdate.toString();
  const xqWait = xqRoom.indexOf("stage === 'waiting'");
  const xqPlay = xqRoom.indexOf("stage: 'playing'", xqWait);
  const xqSeg = xqRoom.slice(xqWait, xqPlay);
  check(xqWait !== -1 && xqPlay !== -1 && !/roomkit\.closeWatch\s*\(/.test(xqSeg),
    '象棋房主开局后不会关闭 watcher');

  const gRoom = onlineDef._onRoomUpdate.toString();
  const gWait = gRoom.indexOf("stage === 'waiting'");
  const gPlay = gRoom.indexOf("stage: 'playing'", gWait);
  const gSeg = gRoom.slice(gWait, gPlay);
  check(gWait !== -1 && gPlay !== -1 && !/this\._closeWatcher\s*\(/.test(gSeg),
    '五子棋房主开局后不会关闭 watcher');
}

/* ============================================================
 * 4. 思考提示在对手信息里，而不是棋盘中央
 * ============================================================ */
console.log('\n[5] 五子棋 AI 思考提示位置');
{
  const fs = require('fs');
  const wxml = fs.readFileSync(path.join(__dirname, '..', 'subpackages/games/gomokuai/gomokuai.wxml'), 'utf8');
  check(wxml.indexOf('think-mask') === -1, '棋盘中央的 think-mask 已移除');
  check(/p-item[^>]*thinking[^>]*>[\s\S]{0,220}AI 思考中/.test(wxml) ||
        /AI 思考中[\s\S]{0,220}p-item/.test(wxml),
    '思考提示显示在顶部对手棋手位置');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail > 0) {
  console.log('❌ 游戏页面流程测试未通过');
  process.exit(1);
}
console.log('✓ 游戏页面流程测试全部通过');
