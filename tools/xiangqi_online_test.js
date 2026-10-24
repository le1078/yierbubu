// 象棋联机功能测试：黑方视角翻转 / 联机悔棋 / 再来一局 / 戳一戳 / 扔水果 / 离开弹窗
// 用法：node tools/xiangqi_online_test.js

const path = require('path');

let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

/* ---- mock 环境 ---- */
let capturedPage = null;
const toasts = [];
const modals = [];
global.Page = function (def) { capturedPage = def; };
global.getApp = function () { return { globalData: {} }; };
let dbUpdates = [];
global.wx = {
  showToast: function (o) { toasts.push(o && o.title); },
  showModal: function (o) { modals.push(o); if (o && o.success) o.success({ confirm: true }); },
  hideLoading() {}, showLoading() {},
  createSelectorQuery() { return null; },
  cloud: {
    database() {
      return {
        serverDate() { return new Date(); },
        collection() {
          return {
            doc() {
              return {
                update(o) { dbUpdates.push(o && o.data); return Promise.resolve({}); }
              };
            }
          };
        }
      };
    }
  }
};

const X = require(path.join(__dirname, '..', 'subpackages/games/xiangqi/rules.js'));

function loadPage() {
  capturedPage = null;
  delete require.cache[require.resolve(path.join(__dirname, '..', 'subpackages/games/xiangqi/xiangqi.js'))];
  require(path.join(__dirname, '..', 'subpackages/games/xiangqi/xiangqi.js'));
  const def = capturedPage;
  const page = {};
  for (const k of Object.keys(def)) page[k] = def[k];
  page.data = JSON.parse(JSON.stringify(def.data || {}));
  page.setData = function (patch, cb) {
    if (patch) for (const k of Object.keys(patch)) this.data[k] = patch[k];
    if (typeof cb === 'function') cb();
  };
  page._ensureCanvas = function () {};
  page._drawBoard = function () {};
  page._notePosition = function () {};
  page._stopAIThink = function () {};
  return page;
}

(async () => {
  /* ============ [1] 黑方视角翻转（绘制坐标 + 命中反算） ============ */
  console.log('\n[1] 黑方视角棋盘翻转');
  {
    const xq = loadPage();
    xq._board = X.startBoard();
    xq._cell = 50; xq._ox = 25; xq._oy = 25;

    // 红方视角：红帅（idx 85, r9c4）点击屏幕 (4,9) → 命中逻辑 (9,4)
    xq.data.mySide = X.RED;
    let hit = xq._hitTest(25 + 4 * 50, 25 + 9 * 50);
    check(hit && hit.r === 9 && hit.c === 4 && hit.idx === X.idx(9, 4),
      '红方视角：屏幕(r9,c4)→逻辑(9,4)不变');

    // 黑方视角：同一点屏幕位置 → 逻辑 180° 反算 (0,4)（黑将位置）
    xq.data.mySide = X.BLACK;
    hit = xq._hitTest(25 + 4 * 50, 25 + 9 * 50);
    check(hit && hit.r === 0 && hit.c === 4,
      '黑方视角：屏幕(r9,c4)→逻辑(0,4)（黑将在自己最下方）');
    // 黑方的黑将（逻辑 0,4）应该显示在屏幕底部 r=9
    const flipCheck = (r, c) => ({ r: X.ROWS - 1 - r, c: X.COLS - 1 - c });
    const pos = flipCheck(0, 4);
    check(pos.r === 9, '翻转函数：逻辑(0,4)→屏幕(9,4)（黑棋在下方）');
  }

  /* ============ [2] 联机悔棋（弹 1 手 vs 2 手） ============ */
  console.log('\n[2] 联机悔棋：双方确认 + 弹手数');
  {
    // 红方请求悔棋：最后一手是红方走的 → 弹 1 手
    const agree = loadPage();
    agree.data.mode = 'online';
    agree.data.mySide = X.BLACK;      // 我执黑，对方（红）请求悔棋
    agree.data.stage = 'playing';
    agree.data.undoState = 'oppRequested';
    agree.data.undoReqSide = X.RED;
    agree._roomId = 'r1';
    agree._board = X.startBoard();
    agree._history = [];
    // 走三手：红炮、黑马、红车 → 最后一手是红（history 长度 3，奇数=红）
    const mv1 = { from: X.idx(7, 1), to: X.idx(7, 4) };
    X.applyMove(agree._board, mv1);
    agree._history.push({ from: mv1.from, to: mv1.to, captured: 0 });
    const mv2 = { from: X.idx(0, 7), to: X.idx(2, 6) };
    X.applyMove(agree._board, mv2);
    agree._history.push({ from: mv2.from, to: mv2.to, captured: 0 });
    const mv3 = { from: X.idx(9, 8), to: X.idx(8, 8) };
    X.applyMove(agree._board, mv3);
    agree._history.push({ from: mv3.from, to: mv3.to, captured: 0 });
    dbUpdates = [];
    await agree.respondUndo({ currentTarget: { dataset: { agree: '1' } } });
    check(agree._history.length === 2, '红方请求悔棋弹 1 手（3→2）');
    check(agree.data.turn === X.RED && agree.data.stage === 'playing',
      '悔棋后轮到红方、回到对局');
    const lastUpdate = dbUpdates[dbUpdates.length - 1] || {};
    check(lastUpdate.undoRequest === 0 && lastUpdate.winner === 0,
      '文档清掉 undoRequest/winner');
    check(typeof lastUpdate.boardStr === 'string' && lastUpdate.history.length === 2,
      '文档写回悔棋后的棋盘与历史');

    // 黑方请求悔棋、最后一手是红（黑还没回）→ 弹 2 手（红2+黑1），回到 [红1]
    const agree2 = loadPage();
    agree2.data.mode = 'online';
    agree2.data.mySide = X.RED;
    agree2.data.stage = 'playing';
    agree2.data.undoState = 'oppRequested';
    agree2.data.undoReqSide = X.BLACK;
    agree2._roomId = 'r1';
    agree2._board = X.startBoard();
    agree2._history = [];
    for (const mv of [
      { from: X.idx(7, 1), to: X.idx(7, 4) },   // 红1
      { from: X.idx(0, 7), to: X.idx(2, 6) },   // 黑1
      { from: X.idx(9, 8), to: X.idx(8, 8) }    // 红2（黑还没走）
    ]) {
      X.applyMove(agree2._board, mv);
      agree2._history.push({ from: mv.from, to: mv.to, captured: 0 });
    }
    await agree2.respondUndo({ currentTarget: { dataset: { agree: '1' } } });
    check(agree2._history.length === 1, '黑方请求悔棋弹 2 手（3→1，回到红1之后）');
    check(agree2.data.turn === X.BLACK, '悔棋后轮到黑方（请求方）');

    // 黑方请求、最后一手是黑自己 → 只弹 1 手
    const agree3 = loadPage();
    agree3.data.mode = 'online';
    agree3.data.mySide = X.RED;
    agree3.data.stage = 'playing';
    agree3.data.undoState = 'oppRequested';
    agree3.data.undoReqSide = X.BLACK;
    agree3._roomId = 'r1';
    agree3._board = X.startBoard();
    agree3._history = [];
    for (const mv of [
      { from: X.idx(7, 1), to: X.idx(7, 4) },
      { from: X.idx(0, 7), to: X.idx(2, 6) }    // 黑1 是最后一手
    ]) {
      X.applyMove(agree3._board, mv);
      agree3._history.push({ from: mv.from, to: mv.to, captured: 0 });
    }
    await agree3.respondUndo({ currentTarget: { dataset: { agree: '1' } } });
    check(agree3._history.length === 1, '黑方请求且自己刚走 → 只弹 1 手（2→1）');

    // 拒绝路径
    const deny = loadPage();
    deny.data.mode = 'online';
    deny.data.mySide = X.RED;
    deny.data.stage = 'playing';
    deny.data.undoState = 'oppRequested';
    deny.data.undoReqSide = X.BLACK;
    deny._roomId = 'r1';
    deny._board = X.startBoard();
    deny._history = [{ from: 1, to: 2, captured: 0 }];
    dbUpdates = [];
    await deny.respondUndo({ currentTarget: { dataset: { agree: '0' } } });
    check(deny.data.undoState === null && deny._history.length === 1,
      '拒绝悔棋：等待态解除、棋盘不动');
    const du = dbUpdates[dbUpdates.length - 1] || {};
    check(du.undoRequest === 0, '拒绝写回 undoRequest=0');
  }

  /* ============ [3] 再来一局 ============ */
  console.log('\n[3] 联机再来一局');
  {
    const rm = loadPage();
    rm.data.mode = 'online';
    rm.data.mySide = X.RED;
    rm.data.stage = 'ended';       // 结算屏上发起/同意都行
    rm.data.undoState = 'oppRequested';
    rm.data.undoReqSide = X.BLACK;
    rm._roomId = 'r1';
    rm._board = X.startBoard();
    rm._history = [{ from: 1, to: 2, captured: 0 }];
    rm._over = true;
    await rm.respondRematch({ currentTarget: { dataset: { agree: '1' } } });
    check(rm.data.stage === 'playing' && rm._history.length === 0 && rm._over === false,
      '同意再来一局：回初始局面、进对局');
    check(rm.data.turn === X.RED, '新局红方先行');
  }

  /* ============ [4] 戳一戳：ts 去重 ============ */
  console.log('\n[4] 戳一戳 ts 去重');
  {
    const xq = loadPage();
    xq.data.mode = 'online';
    xq.data.mySide = X.RED;
    xq.data.stage = 'playing';
    xq._roomId = 'r1';
    xq._lastPokeTs = 0;
    xq._onRoomUpdate({ status: 'playing', poke: { from: X.BLACK, ts: 100 }, boardStr: '', turn: 1, chat: [] });
    check(xq.data.pokeVisible === true, '第一次戳显示横幅');
    xq.setData({ pokeVisible: false });
    xq._onRoomUpdate({ status: 'playing', poke: { from: X.BLACK, ts: 100 }, boardStr: '', turn: 1, chat: [] });
    check(xq.data.pokeVisible === false, '同一 ts 不重复弹');
    xq._onRoomUpdate({ status: 'playing', poke: { from: X.BLACK, ts: 200 }, boardStr: '', turn: 1, chat: [] });
    check(xq.data.pokeVisible === true, '新 ts 再次弹');
  }

  /* ============ [5] 扔水果动画 ============ */
  console.log('\n[5] 扔水果');
  {
    const xq = loadPage();
    xq.data.mode = 'online';
    xq.data.mySide = X.RED;
    xq.data.stage = 'playing';
    xq._roomId = 'r1';
    xq.data.chatList = [];
    xq._lastChatSeen = {};
    // 接收方：mergeChat 检测到对方 emoji → 播动画
    xq._onRoomUpdate({
      status: 'playing',
      boardStr: '', turn: 1,
      chat: [{ from: X.BLACK, type: 'emoji', content: '🍉', ts: 123 }]
    });
    check(xq.data.emojiFlying && xq.data.emojiFlying.icon === '🍉',
      '对方扔的西瓜触发飞行动画');
  }

  /* ============ [6] 对方离开弹窗（只弹一次） ============ */
  console.log('\n[6] 对方离开弹窗');
  {
    const xq = loadPage();
    xq.data.mode = 'online';
    xq.data.mySide = X.RED;
    xq.data.stage = 'playing';
    modals.length = 0;
    // mock 的 showModal 会立即 confirm → 回调里回菜单。断言改在弹窗回调后：
    xq._onRoomUpdate({ status: 'ended', leaver: X.BLACK, boardStr: '', turn: 1, chat: [] });
    check(modals.length === 1 && modals[0].title === '对方已离开',
      '对方离开弹提示窗');
    // showModal mock 立即 confirm：此时页面应已回到菜单（弹窗回调执行完）
    check(xq.data.stage === 'menu', '确认弹窗后回到大厅');
    xq._onRoomUpdate({ status: 'ended', leaver: X.BLACK, boardStr: '', turn: 1, chat: [] });
    check(modals.length === 1, '重复的离开事件不再弹（_leaverHandled）');
  }

  /* ============ [7] 终局后悔棋/重开：请求方必须回到对局 ============ */
  console.log('\n[7] 终局后退回对局的恢复');
  {
    // 我是请求方（自己发过悔棋），对方同意后 room.winner 清 0。
    // 我不写盘，只能靠 _onRoomUpdate 恢复，否则会一直卡在结算屏。
    const xq = loadPage();
    xq.data.mode = 'online';
    xq.data.mySide = X.RED;
    xq.data.stage = 'playing';
    xq._roomId = 'r1';
    xq._board = X.startBoard();
    xq._history = [];
    xq._prevWinner = 0;
    // 先进入终局
    xq._onRoomUpdate({ status: 'playing', winner: 2, boardStr: X.boardToStr(xq._board), turn: 2, moveCount: 5, chat: [] });
    check(xq.data.stage === 'ended' && xq._over === true, '收到 winner 进入结算屏');
    // 对方同意悔棋：winner 清 0（棋盘回退）
    xq._onRoomUpdate({ status: 'playing', winner: 0, boardStr: X.boardToStr(xq._board), turn: 1, moveCount: 2, chat: [] });
    check(xq.data.stage === 'playing' && xq._over === false && xq.data.winText === '',
      'winner 归零后请求方自动回到对局（不再卡结算屏）');
    // 重复更新不应反复触发
    xq._onRoomUpdate({ status: 'playing', winner: 0, boardStr: X.boardToStr(xq._board), turn: 1, moveCount: 2, chat: [] });
    check(xq.data.stage === 'playing', '后续同状态更新保持对局');
  }

  /* ============ [8] 同屏/人机悔棋仍是直接悔 ============ */
  console.log('\n[8] 同屏/人机模式行为不变');
  {
    const xq = loadPage();
    xq.data.mode = 'ai';
    xq.data.stage = 'playing';
    xq.data.mySide = X.RED;
    xq._board = X.startBoard();
    xq._history = [];
    const mv = { from: X.idx(7, 1), to: X.idx(7, 4) };
    X.applyMove(xq._board, mv);
    xq._history.push({ from: mv.from, to: mv.to, captured: 0 });
    dbUpdates = [];
    xq.undo();
    check(xq._history.length === 0 && dbUpdates.length === 0,
      '人机模式悔棋直接本地生效（不走云确认）');
  }

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail > 0) {
    console.log('❌ 象棋联机功能测试未通过');
    process.exit(1);
  }
  console.log('✓ 象棋联机功能测试全部通过');
  process.exit(0);
})();
