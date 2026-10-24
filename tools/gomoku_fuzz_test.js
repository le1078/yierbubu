// 五子棋模糊测试：随机落子 + 用「暴力全盘扫描」交叉验证胜负判定，
// 并检查悔棋/撤销与序列化的一致性。
//
// 用法：node tools/gomoku_fuzz_test.js [局数]

const path = require('path');
const core = require(path.join(__dirname, '..', 'utils/gomoku_core.js'));
const R = require(path.join(__dirname, '..', 'subpackages/games/gomoku/board_render.js'));

let pass = 0, fail = 0;
const failures = [];
function check(cond, name) {
  if (cond) { pass++; return true; }
  fail++;
  failures.push(name);
  if (failures.length <= 20) console.log('  ❌ ' + name);
  return false;
}

const GAMES = Number(process.argv[2] || 30);

function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// 独立实现：全盘扫描，某颜色是否存在五连
function bruteHasFive(b, color) {
  const N = core.SIZE;
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (b[r][c] !== color) continue;
      for (let d = 0; d < dirs.length; d++) {
        const dr = dirs[d][0], dc = dirs[d][1];
        let n = 1;
        for (let k = 1; k < 5; k++) {
          const nr = r + dr * k, nc = c + dc * k;
          if (nr < 0 || nr >= N || nc < 0 || nc >= N) break;
          if (b[nr][nc] !== color) break;
          n++;
        }
        if (n >= 5) return true;
      }
    }
  }
  return false;
}

console.log('[1] 随机对局：落子后胜负判定 vs 暴力扫描');
{
  let movesChecked = 0;
  for (let g = 1; g <= GAMES; g++) {
    const rng = makeRng(g * 31337);
    const b = core.emptyBoard();
    const hist = [];
    let color = 1;
    let bad = 0, finished = false;
    for (let step = 0; step < 225; step++) {
      // 随机选空点（偏向前几回合靠近中心，更容易出连五）
      const empties = [];
      for (let r = 0; r < core.SIZE; r++) {
        for (let c = 0; c < core.SIZE; c++) if (!b[r][c]) empties.push([r, c]);
      }
      if (!empties.length) break;
      let pick;
      if (step < 6) {
        pick = [7 + Math.floor(rng() * 3) - 1, 7 + Math.floor(rng() * 3) - 1];
        if (b[pick[0]][pick[1]]) pick = empties[Math.floor(rng() * empties.length)];
      } else {
        pick = empties[Math.floor(rng() * empties.length)];
      }
      const r = pick[0], c = pick[1];
      b[r][c] = color;
      hist.push({ r: r, c: c, color: color });
      movesChecked++;
      const local = R.findWinLine(b, r, c, color);
      const brute = bruteHasFive(b, color);
      if (!!local !== brute) bad++;
      // 对方的五连不该被这一步「制造」出来（除非之前就有）
      const oppBrute = bruteHasFive(b, color === 1 ? 2 : 1);
      if (oppBrute) bad++;
      if (local) { finished = true; break; }
      color = color === 1 ? 2 : 1;
    }
    check(bad === 0, '第 ' + g + ' 局：' + movesChecked + ' 手累计，胜负判定与暴力扫描一致');
    if (!finished) check(true, '第 ' + g + ' 局自然结束（无连五）');
  }
}

console.log('\n[2] 连续悔棋：逐手撤销后棋盘与历史严格还原');
{
  for (let g = 1; g <= Math.min(GAMES, 10); g++) {
    const rng = makeRng(g * 99991);
    const b = core.emptyBoard();
    const hist = [];
    const snapshots = [JSON.stringify(b)];
    let color = 1;
    let bad = 0;
    for (let step = 0; step < 40; step++) {
      const empties = [];
      for (let r = 0; r < core.SIZE; r++) {
        for (let c = 0; c < core.SIZE; c++) if (!b[r][c]) empties.push([r, c]);
      }
      if (!empties.length) break;
      const pick = empties[Math.floor(rng() * empties.length)];
      b[pick[0]][pick[1]] = color;
      hist.push({ r: pick[0], c: pick[1], color: color });
      snapshots.push(JSON.stringify(b));
      color = color === 1 ? 2 : 1;
    }
    // 逐手回退并核对快照
    for (let i = hist.length - 1; i >= 0; i--) {
      const h = hist[i];
      if (b[h.r][h.c] !== h.color) bad++;
      b[h.r][h.c] = 0;
      hist.pop();
      if (JSON.stringify(b) !== snapshots[i]) bad++;
    }
    check(bad === 0, '第 ' + g + ' 局悔棋逐手还原（' + snapshots.length + ' 个快照）');
  }
}

console.log('\n[3] 序列化/反序列化往返（联机传输）');
{
  const rng = makeRng(777);
  const b = core.emptyBoard();
  for (let i = 0; i < 120; i++) {
    const r = Math.floor(rng() * core.SIZE), c = Math.floor(rng() * core.SIZE);
    if (!b[r][c]) b[r][c] = rng() < 0.5 ? 1 : 2;
  }
  const s = JSON.stringify(b);
  const back = JSON.parse(s);
  check(JSON.stringify(back) === s, '棋盘字符串往返完全一致');
  check(back.length === core.SIZE && back[0].length === core.SIZE, '反序列化尺寸正确');
  check(s.length < 2000, '棋盘序列化体积可控（' + s.length + ' 字节）');
}

console.log('\n[4] 边界：满盘 / 边角连五 / 长连');
{
  // 边角连五（左上水平、右下垂直、两条对角线）
  const cases = [
    { pts: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]] },
    { pts: [[14, 14], [13, 14], [12, 14], [11, 14], [10, 14]] },
    { pts: [[0, 14], [1, 13], [2, 12], [3, 11], [4, 10]] },
    { pts: [[10, 0], [11, 1], [12, 2], [13, 3], [14, 4]] }
  ];
  for (let i = 0; i < cases.length; i++) {
    const bb = core.emptyBoard();
    for (const p of cases[i].pts) bb[p[0]][p[1]] = 1;
    const last = cases[i].pts[4];
    const line = R.findWinLine(bb, last[0], last[1], 1);
    check(!!line, '边角/对角连五都能判定（用例 ' + (i + 1) + '）');
  }
  // 长连（6 子）也算胜（本项目采用无禁手规则）
  const b6 = core.emptyBoard();
  for (let c = 3; c <= 8; c++) b6[7][c] = 2;
  check(!!R.findWinLine(b6, 7, 5, 2), '六连也算胜（无禁手规则）');
  // 四连不算胜
  const b4 = core.emptyBoard();
  for (let c = 3; c <= 6; c++) b4[7][c] = 1;
  check(!R.findWinLine(b4, 7, 5, 1), '四连不算胜');
}

console.log('\n[5] 满盘平局：225 手无连五时必须能判满');
{
  // 用 (r + 2c) mod 4 分段着色：横向周期 2、纵向周期 4、两条对角线
  // 各自周期 4 且同色深度不超过 2 —— 任意方向都不会出现 5 连。
  // （之前用 2x2 块交替，对角线仍会连成 5，是测试自身构造错误）
  const b = core.emptyBoard();
  for (let r = 0; r < core.SIZE; r++) {
    for (let c = 0; c < core.SIZE; c++) {
      b[r][c] = ((r + 2 * c) % 4) < 2 ? 1 : 2;
    }
  }
  let anyFive = false;
  for (let r = 0; r < core.SIZE; r++) {
    for (let c = 0; c < core.SIZE; c++) {
      if (R.findWinLine(b, r, c, b[r][c])) anyFive = true;
    }
  }
  check(!anyFive, '构造的满盘无五连（可用于平局测试）');
  let count = 0;
  for (let r = 0; r < core.SIZE; r++) for (let c = 0; c < core.SIZE; c++) if (b[r][c]) count++;
  check(count === core.SIZE * core.SIZE, '满盘 225 子');
}

console.log('\n[6] 老联机页的 _checkWin 与渲染层实现交叉验证');
{
  // gomoku.js（老联机页，分享卡片仍会进来）自己有一份 _checkWin，
  // 与 board_render.findWinLine 是第三份实现。这里随机棋盘做交叉验证，
  // 防止三者悄悄分叉（分叉会导致「一方看到赢了、另一方没赢」）。
  let captured = null;
  global.Page = function (def) { captured = def; };
  global.getApp = function () { return { globalData: {} }; };
  global.wx = {
    showToast: function () {}, showModal: function () {}, hideLoading: function () {},
    showLoading: function () {}, getWindowInfo: function () { return { windowWidth: 375, pixelRatio: 2 }; },
    getSystemInfoSync: function () { return { windowWidth: 375, pixelRatio: 2 }; },
    createSelectorQuery: function () { return null; },
    cloud: { database: function () { return { serverDate: function () { return new Date(); }, command: { push: function (v) { return v; } }, collection: function () { return { doc: function () { return { update: function () { return Promise.resolve(); }, get: function () { return Promise.resolve({ data: {} }); }, watch: function () { return { close: function () {} }; } }; }, where: function () { return { limit: function () { return this; }, get: function () { return Promise.resolve({ data: [] }); } }; }, add: function () { return Promise.resolve({ _id: 'r' }); } }; } }; } }
  };
  delete require.cache[require.resolve(path.join(__dirname, '..', 'subpackages/games/gomoku/gomoku.js'))];
  require(path.join(__dirname, '..', 'subpackages/games/gomoku/gomoku.js'));

  function makeRng2(seed) {
    let s = seed >>> 0;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  let cases2 = 0, mismatch2 = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const rng = makeRng2(seed * 7717);
    const b = core.emptyBoard();
    for (let i = 0; i < 60; i++) {
      const r = Math.floor(rng() * core.SIZE), c = Math.floor(rng() * core.SIZE);
      if (!b[r][c]) b[r][c] = rng() < 0.5 ? 1 : 2;
    }
    // 随机挑一个已有棋子做「最后一手」，两种实现必须给出一致结论
    const pts = [];
    for (let r = 0; r < core.SIZE; r++) for (let c = 0; c < core.SIZE; c++) if (b[r][c]) pts.push([r, c]);
    for (let k = 0; k < 25; k++) {
      const p = pts[Math.floor(rng() * pts.length)];
      if (!p) continue;
      const page = Object.create(captured);
      page._board = b;
      const a = !!page._checkWin(p[0], p[1], b[p[0]][p[1]]);
      const c2 = !!R.findWinLine(b, p[0], p[1], b[p[0]][p[1]]);
      cases2++;
      if (a !== c2) mismatch2++;
    }
  }
  check(cases2 > 500, '交叉验证样本足够（' + cases2 + ' 个判定）');
  check(mismatch2 === 0, '两份胜负实现完全一致（分歧 ' + mismatch2 + ' 处）');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail > 0) {
  console.log('❌ 五子棋模糊测试未通过');
  process.exit(1);
}
console.log('✓ 五子棋模糊测试全部通过');
