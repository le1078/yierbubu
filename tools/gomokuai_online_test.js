// 五子棋（gomokuai 页）联机功能测试：悔棋 / 再来一局 / 戳一戳 / 扔水果 / 离开弹窗
// 用法：node tools/gomokuai_online_test.js

const path = require('path');

let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

let capturedPage = null;
const toasts = [];
const modals = [];
let dbUpdates = [];
global.Page = function (def) { capturedPage = def; };
global.getApp = function () { return { globalData: {} }; };
global.wx = {
  showToast: function (o) { toasts.push(o && o.title); },
  showModal: function (o) { modals.push(o); if (o && o.success) o.success({ confirm: true }); },
  hideLoading() {}, showLoading() {},
  createSelectorQuery() { return null; },
  cloud: {
    database() {
      return {
        serverDate() { return new Date(); },
        command() {},
        collection() {
          return {
            doc() {
              return {
                update(o) { dbUpdates.push(o && o.data); return Promise.resolve({}); },
                set(o) { dbUpdates.push(o && o.data); return Promise.resolve({}); },
                get() { return Promise.resolve({ data: {} }); }
              };
            },
            add() { return Promise.resolve({ _id: 'r1' }); },
            where() { return { limit() { return this; }, get() { return Promise.resolve({ data: [] }); } }; }
          };
        }
      };
    }
  }
};

const core = require(path.join(__dirname, '..', 'utils/gomoku_core.js'));

function loadPage() {
  capturedPage = null;
  delete require.cache[require.resolve(path.join(__dirname, '..', 'subpackages/games/gomokuai/gomokuai.js'))];
  require(path.join(__dirname, '..', 'subpackages/games/gomokuai/gomokuai.js'));
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
  page._resetCanvas = function () {};
  page._stopAIThink = function () {};
  return page;
}

(async () => {
  /* ===== [1] 联机悔棋：双方确认 ===== */
  console.log('\n[1] 联机悔棋（双方确认）');
  {
    // 请求方：最后一手是自己 → 进等待态
    const g = loadPage();
    g.data.mode = 'online';
    g.data.stage = 'playing';
    g.data.myColor = 1;
    g._roomId = 'r1';
    g._board = core.emptyBoard();
    g._board[7][7] = 1;
    g._history = [{ r: 7, c: 7, color: 1 }];
    await g.undo();
    check(g.data.undoState === 'iRequested', '最后一手是自己的 → 进入等待确认态');
    check(g._history.length === 1, '请求方本地棋盘不动');

    // 最后一手是对方的 → 拒绝请求
    const g2 = loadPage();
    g2.data.mode = 'online';
    g2.data.stage = 'playing';
    g2.data.myColor = 2;
    g2._roomId = 'r1';
    g2._board = core.emptyBoard();
    g2._board[7][7] = 1;
    g2._history = [{ r: 7, c: 7, color: 1 }];
    toasts.length = 0;
    await g2.undo();
    check(g2.data.undoState === null, '最后一手不是自己的 → 不发请求');
    check(toasts.some((t) => t && t.indexOf('只能撤回') !== -1), '提示「只能撤回自己的上一手」');

    // 同意方：弹掉请求方的最后一手
    const agree = loadPage();
    agree.data.mode = 'online';
    agree.data.stage = 'playing';
    agree.data.myColor = 2;          // 我白，对方黑请求悔棋
    agree._roomId = 'r1';
    agree._board = core.emptyBoard();
    agree._board[7][7] = 1;          // 黑最后一手
    agree._board[8][7] = 2;          // 白上一手
    agree._board[9][7] = 1;          // 黑上一上一手（history 最后一手应是黑的）
    agree._history = [
      { r: 9, c: 7, color: 1 },
      { r: 8, c: 7, color: 2 },
      { r: 7, c: 7, color: 1 }        // 黑刚下的最后一手
    ];
    dbUpdates = [];
    await agree.respondUndo({ currentTarget: { dataset: { agree: '1' } } });
    check(agree._board[7][7] === 0 && agree._history.length === 2,
      '同意悔棋：弹掉请求方最后一手');
    check(agree._lastMove && agree._lastMove.r === 8 && agree._lastMove.c === 7,
      '最后一手标记回退到白棋');
    const lu = dbUpdates[dbUpdates.length - 1] || {};
    check(lu.turn === 1 && lu.moveCount === 2 && lu.undoRequest === 0,
      '文档写回：turn 还给请求方（黑）、清 undoRequest');

    // 拒绝路径
    const deny = loadPage();
    deny.data.mode = 'online';
    deny.data.stage = 'playing';
    deny.data.myColor = 2;
    deny._roomId = 'r1';
    deny._board = core.emptyBoard();
    deny._board[7][7] = 1;
    deny._history = [{ r: 7, c: 7, color: 1 }];
    dbUpdates = [];
    await deny.respondUndo({ currentTarget: { dataset: { agree: '0' } } });
    check(deny.data.undoState === null && deny._board[7][7] === 1,
      '拒绝悔棋：等待态解除、棋盘不动');
    const du = dbUpdates[dbUpdates.length - 1] || {};
    check(du.undoRequest === 0, '拒绝写回 undoRequest=0');
  }

  /* ===== [2] 再来一局 ===== */
  console.log('\n[2] 联机再来一局');
  {
    const g = loadPage();
    g.data.mode = 'online';
    g.data.stage = 'ended';       // 结算屏发起/同意
    g.data.myColor = 2;
    g._roomId = 'r1';
    g._board = core.emptyBoard();
    g._board[7][7] = 1;
    g._board[8][8] = 2;
    g._history = [{ r: 7, c: 7, color: 1 }, { r: 8, c: 8, color: 2 }];
    g._over = true;
    g._winLine = { r0: 7, c0: 7, r1: 8, c1: 8 };
    dbUpdates = [];
    await g.respondRematch({ currentTarget: { dataset: { agree: '1' } } });
    check(g.data.stage === 'playing' && g._history.length === 0 && g._over === false,
      '同意再来一局：空盘、进对局');
    check(g._winLine === null, '胜利连线清除');
    check(g.data.turn === 1, '新局黑棋先行');
    const lu = dbUpdates[dbUpdates.length - 1] || {};
    check(lu.winner === 0 && lu.moveCount === 0, '文档复位 winner/moveCount');
    // 请求方路径
    const g2 = loadPage();
    g2.data.mode = 'online';
    g2.data.stage = 'ended';
    g2._roomId = 'r1';
    await g2.restart();
    check(g2.data.rematchState === 'iRequested', '结算屏点重开 → 等待确认');
  }

  /* ===== [3] 戳一戳：ts 去重 ===== */
  console.log('\n[3] 戳一戳');
  {
    const g = loadPage();
    g.data.mode = 'online';
    g.data.stage = 'playing';
    g.data.myColor = 1;
    g._lastPokeTs = 0;
    g._onRoomUpdate({ status: 'playing', poke: { from: 2, ts: 100 }, boardStr: '', turn: 1, chat: [] });
    check(g.data.pokeVisible === true, '第一次戳显示横幅');
    g.setData({ pokeVisible: false });
    g._onRoomUpdate({ status: 'playing', poke: { from: 2, ts: 100 }, boardStr: '', turn: 1, chat: [] });
    check(g.data.pokeVisible === false, '同一 ts 不重复弹');
    g._onRoomUpdate({ status: 'playing', poke: { from: 2, ts: 300 }, boardStr: '', turn: 1, chat: [] });
    check(g.data.pokeVisible === true, '新 ts 再次弹');
  }

  /* ===== [4] 扔水果动画 ===== */
  console.log('\n[4] 扔水果');
  {
    const g = loadPage();
    g.data.mode = 'online';
    g.data.stage = 'playing';
    g.data.myColor = 1;
    g._roomId = 'r1';
    g.data.chatList = [];
    g._onRoomUpdate({
      status: 'playing', boardStr: '', turn: 1,
      chat: [{ from: 2, type: 'emoji', content: '🍉', ts: 456 }]
    });
    check(g.data.emojiFlying && g.data.emojiFlying.icon === '🍉',
      '对方扔的西瓜触发飞行动画');
  }

  /* ===== [5] 对方离开弹窗 ===== */
  console.log('\n[5] 对方离开弹窗');
  {
    const g = loadPage();
    g.data.mode = 'online';
    g.data.stage = 'playing';
    g.data.myColor = 1;
    modals.length = 0;
    g._onRoomUpdate({ status: 'ended', leaver: 2, boardStr: '', turn: 1, chat: [] });
    check(modals.length === 1 && modals[0].title === '对方已离开',
      '对方离开弹提示窗');
    check(g.data.stage === 'menu', '确认后回大厅（mock 立即 confirm）');
    g._onRoomUpdate({ status: 'ended', leaver: 2, boardStr: '', turn: 1, chat: [] });
    check(modals.length === 1, '重复离开事件不再弹');
  }

  /* ===== [6] 终局后悔棋/重开：请求方必须回到对局 ===== */
  console.log('\n[6] 终局后退回对局的恢复');
  {
    const g = loadPage();
    g.data.mode = 'online';
    g.data.myColor = 1;
    g.data.stage = 'playing';
    g._roomId = 'r1';
    g._board = core.emptyBoard();
    g._history = [];
    g._prevWinner = 0;
    g._onRoomUpdate({ status: 'playing', winner: 2, boardStr: JSON.stringify(g._board), turn: 2, moveCount: 9, chat: [] });
    check(g.data.stage === 'ended' && g._over === true, '收到 winner 进入结算屏');
    // 对方同意悔棋/再来一局：winner 清 0
    g._onRoomUpdate({ status: 'playing', winner: 0, boardStr: JSON.stringify(g._board), turn: 1, moveCount: 6, chat: [] });
    check(g.data.stage === 'playing' && g._over === false && g.data.winText === '',
      'winner 归零后请求方自动回到对局');
    check(g._winLine === null, '胜利连线清除（不会画在新棋盘上）');
  }

  /* ===== [7] 人机模式悔棋仍是直接悔 ===== */
  console.log('\n[7] 人机模式行为不变');
  {
    const g = loadPage();
    g.data.mode = 'ai';
    g.data.stage = 'playing';
    g.data.myColor = 1;
    g._board = core.emptyBoard();
    g._board[7][7] = 1;
    g._history = [{ r: 7, c: 7, color: 1 }];
    dbUpdates = [];
    g.undo();
    check(g._history.length === 0 && dbUpdates.length === 0,
      '人机悔棋直接本地生效（不走云确认）');
  }

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail > 0) {
    console.log('❌ 五子棋联机功能测试未通过');
    process.exit(1);
  }
  console.log('✓ 五子棋联机功能测试全部通过');
  process.exit(0);
})();
