// 棋类页面时序测试：AI 计时器作废、请求超时回落。
//
// 这些是「时间维度」的竞态，单次同步调用测不出来：
//   · AI 正在思考（计时器已排程）时悔棋/重开/离开，AI 的棋子不能落到新棋盘上
//   · 悔棋/重开请求超时（对方没响应）后，等待态必须回到可操作
//
// 用法：node tools/game_timing_test.js

const path = require('path');

let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* ========== wx 桩 ========== */
const toasts = [];
let capturedPage = null;
global.Page = function (def) { capturedPage = def; };
global.getApp = function () { return { globalData: {} }; };
global.wx = {
  showToast: function (o) { toasts.push(o && o.title); },
  showModal: function (o) { if (o && o.success) o.success({ confirm: true }); },
  showLoading: function () {}, hideLoading: function () {},
  vibrateShort: function () {},
  createSelectorQuery: function () { return null; },
  getWindowInfo: function () { return { windowWidth: 375, windowHeight: 667, pixelRatio: 2 }; },
  getSystemInfoSync: function () { return { windowWidth: 375, windowHeight: 667, pixelRatio: 2 }; },
  getStorageSync: function () { return ''; },
  setStorageSync: function () {},
  cloud: {
    database: function () {
      return {
        serverDate: function () { return new Date(); },
        command: { push: function (x) { return x; } },
        collection: function () {
          return {
            add: function () { return Promise.resolve({ _id: 'r1' }); },
            where: function () { return { limit: function () { return this; }, get: function () { return Promise.resolve({ data: [] }); } }; },
            doc: function () {
              return {
                get: function () { return Promise.resolve({ data: {} }); },
                set: function () { return Promise.resolve({}); },
                update: function () { return Promise.resolve({}); },
                watch: function () { return { close: function () {} }; }
              };
            }
          };
        }
      };
    }
  }
};

const C = require(path.join(__dirname, '..', 'utils/constants.js'));
const X = require(path.join(__dirname, '..', 'subpackages/games/xiangqi/rules.js'));
const core = require(path.join(__dirname, '..', 'utils/gomoku_core.js'));

function load(rel, stubs) {
  capturedPage = null;
  const file = path.join(__dirname, '..', rel);
  delete require.cache[require.resolve(file)];
  require(file);
  const def = capturedPage;
  const p = {};
  for (const k of Object.keys(def)) p[k] = def[k];
  p.data = JSON.parse(JSON.stringify(def.data || {}));
  p.setData = function (patch, cb) {
    if (patch) for (const k of Object.keys(patch)) this.data[k] = patch[k];
    if (typeof cb === 'function') cb();
  };
  (stubs || []).forEach(function (k) { p[k] = function () {}; });
  return p;
}

(async function run() {
  console.log('[1] 象棋：AI 思考中悔棋 → 计时器作废，不会把棋下到新棋盘');
  {
    const p = load('subpackages/games/xiangqi/xiangqi.js',
      ['_ensureCanvas', '_drawBoard', '_resetCanvas', '_measureBoard']);
    p.data.mode = 'ai';
    p.data.mySide = X.RED;
    p.data.difficulty = 'easy';
    p.data.stage = 'playing';
    p.data.turn = X.BLACK;      // 轮到 AI
    p._board = X.startBoard();
    p._history = [];
    p._positions = {};
    const mv = { from: X.idx(7, 1), to: X.idx(7, 4) };
    X.applyMove(p._board, mv);
    p._history.push({ from: mv.from, to: mv.to, captured: 0 });

    p._aiTurn();
    check(p.data.thinking === true, 'AI 进入思考态');
    p.undo();                    // 悔棋必须把正在思考的计时器作废
    const afterBoard = X.boardToStr(p._board);
    const afterLen = p._history.length;
    await wait((C.XQ_AI_THINK_MS || 400) + 500);
    check(X.boardToStr(p._board) === afterBoard && p._history.length === afterLen,
      '计时器到点后 AI 没有落子（棋盘/手数不变）');
    check(p.data.thinking === false, '思考态已复位');

    // 对照组：不悔棋时 AI 会正常落子 —— 证明计时器确实在跑，
    // 上面「没落子」不是因为计时器压根没排上（假阳性）
    const q = load('subpackages/games/xiangqi/xiangqi.js',
      ['_ensureCanvas', '_drawBoard', '_resetCanvas', '_measureBoard']);
    q.data.mode = 'ai';
    q.data.mySide = X.RED;
    q.data.difficulty = 'easy';
    q.data.stage = 'playing';
    q.data.turn = X.BLACK;
    q._board = X.startBoard();
    q._history = [{ from: X.idx(7, 1), to: X.idx(7, 4), captured: 0 }];
    X.applyMove(q._board, { from: X.idx(7, 1), to: X.idx(7, 4) });
    q._positions = {};
    const lenQ = q._history.length;
    q._aiTurn();
    await wait((C.XQ_AI_THINK_MS || 400) + 800);
    check(q._history.length > lenQ, '对照组：不悔棋时 AI 正常落子');
  }

  console.log('\n[2] 五子棋：AI 思考中悔棋 → 计时器作废');
  {
    const p = load('subpackages/games/gomokuai/gomokuai.js',
      ['_ensureCanvas', '_drawBoard', '_resetCanvas']);
    p.data.mode = 'ai';
    p.data.myColor = 1;
    p.data.difficulty = 'easy';
    p.data.stage = 'playing';
    p.data.turn = 2;             // 轮到 AI
    p._board = core.emptyBoard();
    p._board[7][7] = 1;
    p._history = [{ r: 7, c: 7, color: 1 }];
    p._over = false;

    p._aiTurn();
    check(p.data.thinking !== undefined, 'AI 进入思考态');
    p.undo();
    const snapshot = JSON.stringify(p._board);
    const len = p._history.length;
    await wait((C.GOMOKU_AI_THINK_MS || 320) + 500);
    check(JSON.stringify(p._board) === snapshot && p._history.length === len,
      '计时器到点后 AI 没有落子');
    check(p.data.thinking === false, '思考态已复位');

    // 对照组：不悔棋时 AI 正常落子
    const q = load('subpackages/games/gomokuai/gomokuai.js',
      ['_ensureCanvas', '_drawBoard', '_resetCanvas']);
    q.data.mode = 'ai';
    q.data.myColor = 1;
    q.data.difficulty = 'easy';
    q.data.stage = 'playing';
    q.data.turn = 2;
    q._board = core.emptyBoard();
    q._board[7][7] = 1;
    q._history = [{ r: 7, c: 7, color: 1 }];
    q._over = false;
    const lenQ = q._history.length;
    q._aiTurn();
    await wait((C.GOMOKU_AI_THINK_MS || 320) + 800);
    check(q._history.length > lenQ, '对照组：不悔棋时 AI 正常落子');
  }

  console.log('\n[3] 悔棋请求超时：等待态必须回到可操作');
  {
    const oldXq = C.XQ_MOVE_TIMEOUT_MS;
    C.XQ_MOVE_TIMEOUT_MS = 60;
    toasts.length = 0;
    const p = load('subpackages/games/xiangqi/xiangqi.js',
      ['_ensureCanvas', '_drawBoard', '_resetCanvas', '_measureBoard']);
    p.data.mode = 'online';
    p.data.mySide = X.RED;
    p.data.stage = 'playing';
    p.data.undoState = 'iRequested';
    p._roomId = 'r1';
    p._armRequestTimeout('undoState');
    await wait(200);
    check(p.data.undoState === null, '超时后等待态解除（不会一直显示"等待对方"）');
    check(toasts.indexOf('对方未响应') !== -1, '超时有明确提示');
    C.XQ_MOVE_TIMEOUT_MS = oldXq;
  }

  console.log('\n[4] 五子棋悔棋请求超时：同上');
  {
    const oldG = C.UNDO_TIMEOUT_MS;
    C.UNDO_TIMEOUT_MS = 60;
    toasts.length = 0;
    const p = load('subpackages/games/gomokuai/gomokuai.js',
      ['_ensureCanvas', '_drawBoard', '_resetCanvas']);
    p.data.mode = 'online';
    p.data.myColor = 1;
    p.data.undoState = 'iRequested';
    p._roomId = 'r1';
    p._armRequestTimeout('undoState');
    await wait(200);
    check(p.data.undoState === null, '超时后等待态解除');
    check(toasts.indexOf('对方未响应') !== -1, '超时有明确提示');
    C.UNDO_TIMEOUT_MS = oldG;
  }

  console.log('\n[5] 连点悔棋：只写一次库（第二次被等待态拦住）');
  {
    const p = load('subpackages/games/xiangqi/xiangqi.js',
      ['_ensureCanvas', '_drawBoard', '_resetCanvas', '_measureBoard']);
    let writes = 0;
    const origDb = global.wx.cloud.database;
    global.wx.cloud.database = function () {
      const db = origDb();
      const origCollection = db.collection;
      db.collection = function () {
        const col = origCollection();
        const origDoc = col.doc;
        col.doc = function (id) {
          const d = origDoc(id);
          const origUpdate = d.update;
          d.update = function (o) { writes++; return origUpdate(o); };
          return d;
        };
        return col;
      };
      return db;
    };
    p.data.mode = 'online';
    p.data.mySide = X.RED;
    p.data.stage = 'playing';
    p._roomId = 'r1';
    p._board = X.startBoard();
    p._history = [{ from: X.idx(7, 1), to: X.idx(7, 4), captured: 0 }];
    const p1 = p.requestUndo();
    const p2 = p.requestUndo();   // 第二下必须被 undoState 拦住
    await Promise.all([p1, p2]);
    check(writes === 1, '连点两下只写 1 次（实际 ' + writes + '）');
    const p3 = p.requestUndo();
    await p3;
    check(writes === 1, '等待态期间再点也不写（实际 ' + writes + '）');
    global.wx.cloud.database = origDb;
  }

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) {
    console.log('❌ 棋类时序测试未通过');
    process.exit(1);
  }
  console.log('✓ 棋类时序测试全部通过');
  process.exit(0);
})();
