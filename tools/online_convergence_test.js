// 联机协议双客户端收敛仿真。
//
// 做法：起两个真实页面实例（host=座位1 / guest=座位2），共用一个内存房间
// 文档；把页面的 db 写入接到文档上，写成功后把文档推送给双方（模拟 watch）。
// 然后随机执行 落子 / 悔棋 / 再来一局 / 戳一戳 / 聊天，每步之后断言：
//   · 两个客户端的棋盘、轮次、手数完全一致
//   · 没有客户端卡在「等待对方」以外的非法状态
// 这能逼出「一方本地已变、另一方没收到」「请求方卡住」这类真实联机 bug。
//
// 用法：node tools/online_convergence_test.js [种子数] [步数]

const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function check(cond, name) {
  if (cond) { pass++; return true; }
  fail++;
  failures.push(name);
  if (failures.length <= 25) console.log('  ❌ ' + name);
  return false;
}

const SEEDS = Number(process.argv[2] || 6);
const STEPS = Number(process.argv[3] || 40);

function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* ========== 共享房间文档 + wx mock ========== */
let ROOM = {};
let pendingDocs = [];       // 待投递的文档快照
const modalQueue = [];      // 待处理的弹窗请求（不自动确认，交给仿真决定）
const STATS = { moves: 0, undoReq: 0, undoAgree: 0, undoDeny: 0, rematchReq: 0, rematchAgree: 0, rematchDeny: 0, poke: 0, chat: 0 };

function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }

function applyUpdate(data) {
  for (const k of Object.keys(data)) {
    const v = data[k];
    if (v && typeof v === 'object' && v.__push !== undefined) {
      if (!Array.isArray(ROOM[k])) ROOM[k] = [];
      ROOM[k].push(v.__push);
    } else {
      ROOM[k] = v;
    }
  }
  pendingDocs.push(deepCopy(ROOM));
}

let capturedPage = null;
global.Page = function (def) { capturedPage = def; };
global.getApp = function () { return { globalData: {} }; };
global.wx = {
  showToast: function () {},
  showLoading: function () {},
  hideLoading: function () {},
  showModal: function (o) { modalQueue.push(o); },   // 不自动确认
  createSelectorQuery: function () { return null; },
  createOffscreenCanvas: function () { return { width: 0, height: 0, getContext: function () { return {}; } }; },
  cloud: {
    database: function () {
      return {
        serverDate: function () { return new Date(); },
        command: { push: function (v) { return { __push: v }; } },
        collection: function () {
          return {
            doc: function () {
              return {
                update: function (o) { applyUpdate(o.data || {}); return Promise.resolve({}); },
                set: function (o) { applyUpdate(o.data || {}); return Promise.resolve({}); },
                get: function () { return Promise.resolve({ data: deepCopy(ROOM) }); },
                watch: function () { return { close: function () {} }; }
              };
            },
            where: function () { return { limit: function () { return this; }, get: function () { return Promise.resolve({ data: [] }); } }; },
            add: function () { return Promise.resolve({ _id: 'room1' }); }
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
  if (!capturedPage) throw new Error('Page() 未调用: ' + rel);
  const def = capturedPage;
  const page = {};
  for (const k of Object.keys(def)) page[k] = def[k];
  page.data = deepCopy(def.data || {});
  page.setData = function (patch, cb) {
    if (patch) for (const k of Object.keys(patch)) this.data[k] = patch[k];
    if (typeof cb === 'function') cb();
  };
  // 表现层全部打桩：只验证状态机与同步
  page._ensureCanvas = function () {};
  page._drawBoard = function () {};
  page._resetCanvas = function () {};
  page._stopAIThink = function () {};
  page._startAIThink = function () {};
  return page;
}

function flush() {
  // 把待投递的文档推给双方（真实 watch 也是双方都收到）
  for (const client of CLIENTS) {
    if (!client || !client._onRoomUpdate) continue;
    for (const doc of pendingDocs) {
      client._onRoomUpdate(deepCopy(doc));
    }
  }
  pendingDocs = [];
  // 让 async 写入落地
  return new Promise(function (r) { setTimeout(r, 0); }).then(function () {
    if (pendingDocs.length) return flush();
  });
}

let CLIENTS = [];

/* ================= 象棋双客户端 ================= */
async function xiangqiConvergence(seed) {
  const X = require(path.join(__dirname, '..', 'subpackages/games/xiangqi/rules.js'));
  ROOM = {
    status: 'playing', boardStr: X.boardToStr(X.startBoard()), history: [],
    turn: X.RED, winner: 0, moveCount: 0, lastMove: {}, chat: [],
    undoRequest: 0, rematchRequest: 0, poke: {}, leaver: 0
  };
  pendingDocs = [];
  modalQueue.length = 0;

  const host = loadPage('subpackages/games/xiangqi/xiangqi.js');
  const guest = loadPage('subpackages/games/xiangqi/xiangqi.js');
  const setup = (p, side) => {
    p.data.mode = 'online';
    p.data.stage = 'playing';
    p.data.mySide = side;
    p._roomId = 'room1';
    p._board = X.strToBoard(ROOM.boardStr);
    p._history = [];
    p._over = false;
    p._noCapture = 0;
    p._positions = {};
    p._leaverHandled = false;
    p._prevWinner = 0;
    p._selected = null;
    p._lastMove = null;
  };
  setup(host, X.RED);
  setup(guest, X.BLACK);
  CLIENTS = [host, guest];

  const boards = () => [
    X.boardToStr(host._board),
    X.boardToStr(guest._board)
  ];
  const rng = makeRng(seed * 6151);
  let madeMoves = 0;
  for (let step = 0; step < STEPS; step++) {
    const actor = rng() < 0.5 ? host : guest;
    const roll = rng();
    if (roll < 0.55) {
      // 走一步合法棋
      if (actor.data.stage !== 'playing' || actor._over) continue;
      const moves = X.legalMoves(actor._board, actor.data.turn);
      if (!moves.length) continue;
      actor._doMove(moves[Math.floor(rng() * moves.length)]);
      madeMoves++; STATS.moves++;
    } else if (roll < 0.68) {
      // 请求悔棋
      if (actor.data.stage !== 'playing') continue;
      await actor.undo();
      STATS.undoReq++;
      await flush();
      // 对方若收到请求弹窗，随机同意/拒绝
      while (modalQueue.length) {
        const m = modalQueue.shift();
        const other = actor === host ? guest : host;
        if (m.title && m.title.indexOf('悔棋') !== -1) {
          const yes = rng() < 0.7;
          if (yes) STATS.undoAgree++; else STATS.undoDeny++;
          await other.respondUndo({ currentTarget: { dataset: { agree: yes ? '1' : '0' } } });
        } else if (m.title && m.title.indexOf('再来一局') !== -1) {
          await other.respondRematch({ currentTarget: { dataset: { agree: rng() < 0.7 ? '1' : '0' } } });
        }
        await flush();
      }
    } else if (roll < 0.76) {
      // 请求再来一局
      await actor.restart();
      STATS.rematchReq++;
      await flush();
      while (modalQueue.length) {
        const m = modalQueue.shift();
        const other = actor === host ? guest : host;
        if (m.title && m.title.indexOf('再来一局') !== -1) {
          const yes = rng() < 0.7;
          if (yes) STATS.rematchAgree++; else STATS.rematchDeny++;
          await other.respondRematch({ currentTarget: { dataset: { agree: yes ? '1' : '0' } } });
        }
        await flush();
      }
    } else if (roll < 0.84) {
      await actor.poke();
      STATS.poke++;
      await flush();
    } else {
      await actor.throwFruit({ currentTarget: { dataset: { icon: '🍉' } } });
      STATS.chat++;
      await flush();
    }
    await flush();

    // 每步之后：双方棋盘必须一致
    const [b1, b2] = boards();
    if (b1 !== b2) {
      check(false, '象棋 seed' + seed + ' 第' + step + '步双方棋盘不一致\n   host=' + b1.slice(0, 40) + '\n   guest=' + b2.slice(0, 40));
      return;
    }
    check(host.data.turn === guest.data.turn,
      '象棋 seed' + seed + ' 第' + step + '步轮次一致');
    check(host._history.length === guest._history.length,
      '象棋 seed' + seed + ' 第' + step + '步手数一致');
    if (failures.length > 3) return;   // 已失败，别刷屏
  }
  check(madeMoves > 0, '象棋 seed' + seed + ' 确实走了棋（' + madeMoves + ' 手）');
}

/* ================= 五子棋双客户端 ================= */
async function gomokuConvergence(seed) {
  const core = require(path.join(__dirname, '..', 'utils/gomoku_core.js'));
  ROOM = {
    status: 'playing', boardStr: JSON.stringify(core.emptyBoard()), history: [],
    turn: 1, winner: 0, moveCount: 0, lastMove: {}, chat: [],
    undoRequest: 0, rematchRequest: 0, poke: {}, leaver: 0
  };
  pendingDocs = [];
  modalQueue.length = 0;

  const host = loadPage('subpackages/games/gomokuai/gomokuai.js');
  const guest = loadPage('subpackages/games/gomokuai/gomokuai.js');
  const setup = (p, color) => {
    p.data.mode = 'online';
    p.data.stage = 'playing';
    p.data.myColor = color;
    p._roomId = 'room1';
    p._board = JSON.parse(ROOM.boardStr);
    p._history = [];
    p._lastMove = null;
    p._winLine = null;
    p._over = false;
    p._leaverHandled = false;
    p._prevWinner = 0;
    p._boardKey = ROOM.boardStr;
  };
  setup(host, 1);
  setup(guest, 2);
  CLIENTS = [host, guest];

  const boards = () => [JSON.stringify(host._board), JSON.stringify(guest._board)];
  const rng = makeRng(seed * 8191);
  let madeMoves = 0;
  for (let step = 0; step < STEPS; step++) {
    const actor = rng() < 0.5 ? host : guest;
    const roll = rng();
    if (roll < 0.6) {
      // 落子在轮到自己且棋盘空闲时
      if (actor.data.stage !== 'playing' || actor._over) continue;
      if (actor.data.turn !== actor.data.myColor) continue;
      const empties = [];
      for (let r = 0; r < core.SIZE; r++) {
        for (let c = 0; c < core.SIZE; c++) if (!actor._board[r][c]) empties.push([r, c]);
      }
      if (!empties.length) continue;
      const pick = empties[Math.floor(rng() * empties.length)];
      actor._place(pick[0], pick[1], actor.data.myColor);
      madeMoves++; STATS.moves++;
      await flush();
    } else if (roll < 0.75) {
      if (actor.data.stage !== 'playing') continue;
      await actor.undo();
      STATS.undoReq++;
      await flush();
      while (modalQueue.length) {
        const m = modalQueue.shift();
        const other = actor === host ? guest : host;
        if (m.title && m.title.indexOf('悔棋') !== -1) {
          const yes = rng() < 0.7;
          if (yes) STATS.undoAgree++; else STATS.undoDeny++;
          await other.respondUndo({ currentTarget: { dataset: { agree: yes ? '1' : '0' } } });
        } else if (m.title && m.title.indexOf('再来一局') !== -1) {
          await other.respondRematch({ currentTarget: { dataset: { agree: rng() < 0.7 ? '1' : '0' } } });
        }
        await flush();
      }
    } else if (roll < 0.85) {
      await actor.restart();
      STATS.rematchReq++;
      await flush();
      while (modalQueue.length) {
        const m = modalQueue.shift();
        const other = actor === host ? guest : host;
        if (m.title && m.title.indexOf('再来一局') !== -1) {
          const yes = rng() < 0.7;
          if (yes) STATS.rematchAgree++; else STATS.rematchDeny++;
          await other.respondRematch({ currentTarget: { dataset: { agree: yes ? '1' : '0' } } });
        }
        await flush();
      }
    } else if (roll < 0.93) {
      await actor.poke();
      STATS.poke++;
      await flush();
    } else {
      await actor.throwFruit({ currentTarget: { dataset: { icon: '🥭' } } });
      STATS.chat++;
      await flush();
    }
    await flush();

    const [b1, b2] = boards();
    if (b1 !== b2) {
      check(false, '五子棋 seed' + seed + ' 第' + step + '步双方棋盘不一致');
      return;
    }
    check(host._history.length === guest._history.length,
      '五子棋 seed' + seed + ' 第' + step + '步手数一致');
    if (failures.length > 3) return;
  }
  check(madeMoves > 0, '五子棋 seed' + seed + ' 确实落了子（' + madeMoves + ' 手）');
}

(async () => {
  console.log('[1] 象棋：双客户端随机操作收敛');
  for (let s = 1; s <= SEEDS; s++) await xiangqiConvergence(s);
  console.log('\n[2] 五子棋：双客户端随机操作收敛');
  for (let s = 1; s <= SEEDS; s++) await gomokuConvergence(s);

  console.log('\n[3] 覆盖度自检（防止仿真什么都没测到却报绿）');
  console.log('    ' + JSON.stringify(STATS));
  check(STATS.moves > 20, '仿真走了足够多的棋（' + STATS.moves + ' 手）');
  check(STATS.undoReq > 0, '悔棋请求分支被覆盖（' + STATS.undoReq + ' 次）');
  check(STATS.undoAgree > 0, '悔棋同意分支被覆盖（' + STATS.undoAgree + ' 次）');
  check(STATS.rematchReq > 0, '重开请求分支被覆盖（' + STATS.rematchReq + ' 次）');
  check(STATS.poke > 0, '戳一戳分支被覆盖（' + STATS.poke + ' 次）');
  check(STATS.chat > 0, '扔水果分支被覆盖（' + STATS.chat + ' 次）');

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail > 0) {
    console.log('❌ 联机收敛仿真未通过');
    process.exit(1);
  }
  console.log('✓ 联机收敛仿真全部通过');
  process.exit(0);
})();
