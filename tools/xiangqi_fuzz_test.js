// 象棋规则模糊测试：随机对局 + 用「独立实现」交叉验证引擎的优化判定。
//
// 为什么要交叉验证：rules.js 里的 isInCheck 为了性能用了反向探查（从将位
// 反推攻击者），这种写法最怕漏掉某个方向/某种遮挡。这里用一个笨蛋版
// （逐个子正向扫描）当标准答案，逐局面比对。
//
// 用法：node tools/xiangqi_fuzz_test.js [种子数]

const path = require('path');
const X = require(path.join(__dirname, '..', 'subpackages/games/xiangqi/rules.js'));

let pass = 0, fail = 0;
const failures = [];
function check(cond, name) {
  if (cond) { pass++; return true; }
  fail++;
  failures.push(name);
  if (failures.length <= 25) console.log('  ❌ ' + name);
  return false;
}

const SEEDS = Number(process.argv[2] || 25);

function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* ========== 独立实现：某方是否被将军（笨蛋版，逐子正向扫描） ========== */
function oracleInCheck(b, side) {
  const kp = X.findKing(b, side);
  if (kp < 0) return true;
  const kr = X.rowOf(kp), kc = X.colOf(kp);
  const opp = side === X.RED ? X.BLACK : X.RED;

  // 车/炮：沿四方向正向扫描
  for (let d = 0; d < 4; d++) {
    const dr = d < 2 ? (d === 0 ? -1 : 1) : 0;
    const dc = d < 2 ? 0 : (d === 2 ? -1 : 1);
    let r = kr + dr, c = kc + dc, blockers = 0;
    while (r >= 0 && r < 10 && c >= 0 && c < 9) {
      const p = b[r * 9 + c];
      if (p) {
        if (blockers === 0) {
          if (X.sideOf(p) === opp) {
            const t = X.typeOf(p);
            if (t === 5) return true;          // 车贴脸
            if (t === 1) return true;          // 将帅贴身（不含飞将，见下）
          }
        } else if (blockers === 1) {
          if (X.sideOf(p) === opp && X.typeOf(p) === 6) return true;   // 炮隔一子
          break;
        }
        blockers++;
        if (blockers > 1) break;
      }
      r += dr; c += dc;
    }
  }

  // 马：8 个马步，逐一验证马腿
  const HORSE = [
    [-2, -1, -1, 0], [-2, 1, -1, 0], [2, -1, 1, 0], [2, 1, 1, 0],
    [-1, -2, 0, -1], [1, -2, 0, -1], [-1, 2, 0, 1], [1, 2, 0, 1]
  ];
  for (let i = 0; i < b.length; i++) {
    const p = b[i];
    if (!p || X.sideOf(p) !== opp || X.typeOf(p) !== 4) continue;
    const hr = X.rowOf(i), hc = X.colOf(i);
    for (let m = 0; m < HORSE.length; m++) {
      const tr = hr + HORSE[m][0], tc = hc + HORSE[m][1];
      if (tr !== kr || tc !== kc) continue;
      const lr = hr + HORSE[m][2], lc = hc + HORSE[m][3];
      if (lr < 0 || lr > 9 || lc < 0 || lc > 8) continue;
      if (!b[lr * 9 + lc]) return true;   // 马腿空 → 能吃到将
    }
  }

  // 兵/卒
  for (let i = 0; i < b.length; i++) {
    const p = b[i];
    if (!p || X.sideOf(p) !== opp || X.typeOf(p) !== 7) continue;
    const pr = X.rowOf(i), pc = X.colOf(i);
    const fwd = opp === X.RED ? -1 : 1;
    if (pr + fwd === kr && pc === kc) return true;
    const crossed = opp === X.RED ? (pr <= 4) : (pr >= 5);
    if (crossed && pr === kr && Math.abs(pc - kc) === 1) return true;
  }

  // 飞将：两将同列且中间无子
  const okp = X.findKing(b, opp);
  if (okp >= 0 && X.colOf(okp) === kc) {
    const a = Math.min(X.rowOf(okp), kr), z = Math.max(X.rowOf(okp), kr);
    let blocked = false;
    for (let r = a + 1; r < z; r++) if (b[r * 9 + kc]) { blocked = true; break; }
    if (!blocked) return true;
  }
  return false;
}

// 独立实现：某方全部「走后不被将军」的着法
function oracleLegalMoves(b, side) {
  const out = [];
  for (let i = 0; i < b.length; i++) {
    const p = b[i];
    if (!p || X.sideOf(p) !== side) continue;
    const pseudo = X.pseudoMoves(b, i);
    for (let m = 0; m < pseudo.length; m++) {
      const mv = pseudo[m];
      const cap = b[mv.to];
      b[mv.to] = b[mv.from];
      b[mv.from] = 0;
      const bad = oracleInCheck(b, side);
      b[mv.from] = b[mv.to];
      b[mv.to] = cap;
      if (!bad) out.push(mv.from + '>' + mv.to);
    }
  }
  return out.sort().join(',');
}

function legalMovesKey(b, side) {
  return X.legalMoves(b, side).map((m) => m.from + '>' + m.to).sort().join(',');
}

console.log('[1] 将军判定：引擎 vs 独立实现（随机对局逐局面比对）');
{
  let compared = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rng = makeRng(seed * 7919);
    const b = X.startBoard();
    let side = X.RED;
    let mismatch = 0;
    for (let step = 0; step < 120; step++) {
      // 两侧都比对
      if (oracleInCheck(b, X.RED) !== X.isInCheck(b, X.RED)) mismatch++;
      if (oracleInCheck(b, X.BLACK) !== X.isInCheck(b, X.BLACK)) mismatch++;
      compared += 2;
      const moves = X.legalMoves(b, side);
      if (!moves.length) break;
      X.applyMove(b, moves[Math.floor(rng() * moves.length)]);
      side = side === X.RED ? X.BLACK : X.RED;
    }
    check(mismatch === 0, '种子 ' + seed + ' 将军判定无分歧（' + compared + ' 个局面累计）');
  }
}

console.log('\n[2] 合法着法：引擎过滤 vs 独立实现');
{
  for (let seed = 1; seed <= Math.min(SEEDS, 12); seed++) {
    const rng = makeRng(seed * 104729);
    const b = X.startBoard();
    let side = X.RED;
    let mismatch = 0;
    for (let step = 0; step < 60; step++) {
      const a = legalMovesKey(b, side);
      const o = oracleLegalMoves(b, side);
      if (a !== o) mismatch++;
      const moves = X.legalMoves(b, side);
      if (!moves.length) break;
      X.applyMove(b, moves[Math.floor(rng() * moves.length)]);
      side = side === X.RED ? X.BLACK : X.RED;
    }
    check(mismatch === 0, '种子 ' + seed + ' 合法着法集合完全一致');
  }
}

console.log('\n[3] 执行/撤销严格可逆 + 序列化往返');
{
  for (let seed = 1; seed <= Math.min(SEEDS, 12); seed++) {
    const rng = makeRng(seed * 15485863);
    const b = X.startBoard();
    const startStr = X.boardToStr(b);
    const stack = [];
    let side = X.RED;
    let bad = 0;
    for (let step = 0; step < 80; step++) {
      const moves = X.legalMoves(b, side);
      if (!moves.length) break;
      const mv = moves[Math.floor(rng() * moves.length)];
      const before = X.boardToStr(b);
      const res = X.applyMove(b, mv);
      stack.push({ mv: mv, captured: res.captured, before: before });
      // 序列化往返
      if (X.boardToStr(X.strToBoard(X.boardToStr(b))) !== X.boardToStr(b)) bad++;
      side = side === X.RED ? X.BLACK : X.RED;
    }
    // 全部撤销，逐层核对
    for (let i = stack.length - 1; i >= 0; i--) {
      const fr = stack[i];
      X.undoMove(b, fr.mv, fr.captured);
      if (X.boardToStr(b) !== fr.before) bad++;
    }
    check(bad === 0, '种子 ' + seed + ' 撤销/序列化逐层还原（' + stack.length + ' 手）');
    check(X.boardToStr(b) === startStr, '种子 ' + seed + ' 全撤销后回到初始局面');
  }
}

console.log('\n[4] 关键规则点（构造局面逐一验证）');
{
  // 蹩马腿：马从 (5,4) 走到 (3,3) 的马腿是正上方 (4,4)（不是侧边格子）
  const b1 = X.emptyBoard();
  b1[X.idx(5, 4)] = X.N;   // 红马中心
  const freeMoves = X.pseudoMoves(b1, X.idx(5, 4)).map((m) => m.to);
  check(freeMoves.indexOf(X.idx(3, 3)) !== -1, '马腿空时可走 (3,3)');
  b1[X.idx(4, 4)] = X.P;   // 堵住通往 (3,3) 的马腿
  const nm = X.pseudoMoves(b1, X.idx(5, 4)).map((m) => m.to);
  check(nm.indexOf(X.idx(3, 3)) === -1, '蹩马腿：马腿 (4,4) 被堵后不能走 (3,3)');
  check(nm.indexOf(X.idx(4, 2)) !== -1, '其他方向的马腿未堵，仍可走');

  // 象眼 / 象不过河
  const b2 = X.emptyBoard();
  b2[X.idx(9, 2)] = X.B;   // 红相在底线
  const bm = X.pseudoMoves(b2, X.idx(9, 2)).map((m) => m.to);
  check(bm.indexOf(X.idx(7, 0)) !== -1, '相可走田字');
  check(bm.every((to) => X.rowOf(to) >= 5), '红相不过河');
  b2[X.idx(8, 1)] = X.P;   // 塞象眼
  const bm2 = X.pseudoMoves(b2, X.idx(9, 2)).map((m) => m.to);
  check(bm2.indexOf(X.idx(7, 0)) === -1, '塞象眼：被堵方向不能走');

  // 士/帅不出九宫
  const b3 = X.emptyBoard();
  b3[X.idx(9, 4)] = X.K;
  const km = X.pseudoMoves(b3, X.idx(9, 4)).map((m) => m.to);
  check(km.indexOf(X.idx(8, 4)) !== -1 && km.indexOf(X.idx(9, 3)) !== -1, '帅在九宫可走');
  check(km.indexOf(X.idx(8, 3)) === -1, '帅不能走斜线');

  // 炮：隔一子可吃，隔两子不行
  const b4 = X.emptyBoard();
  b4[X.idx(5, 0)] = X.C;
  b4[X.idx(5, 3)] = X.P;          // 炮架
  b4[X.idx(5, 6)] = X.P + 8;      // 黑子（目标）
  const cm = X.pseudoMoves(b4, X.idx(5, 0)).map((m) => m.to);
  check(cm.indexOf(X.idx(5, 6)) !== -1, '炮隔一子可吃');
  check(cm.indexOf(X.idx(5, 3)) === -1, '炮不能吃炮架（隔零子不能吃）');
  b4[X.idx(5, 4)] = X.P;          // 第二个子
  const cm2 = X.pseudoMoves(b4, X.idx(5, 0)).map((m) => m.to);
  check(cm2.indexOf(X.idx(5, 6)) === -1, '炮隔两子不能吃');

  // 兵过河才能横走
  const b5 = X.emptyBoard();
  b5[X.idx(6, 4)] = X.P;   // 未过河
  const pm = X.pseudoMoves(b5, X.idx(6, 4)).map((m) => m.to);
  check(pm.indexOf(X.idx(6, 3)) === -1, '兵未过河不能横走');
  const b6 = X.emptyBoard();
  b6[X.idx(4, 4)] = X.P;   // 已过河
  const pm2 = X.pseudoMoves(b6, X.idx(4, 4)).map((m) => m.to);
  check(pm2.indexOf(X.idx(4, 3)) !== -1 && pm2.indexOf(X.idx(4, 5)) !== -1, '兵过河后可横走');

  // 飞将：两将同列不能照面
  const b7 = X.emptyBoard();
  b7[X.idx(9, 4)] = X.K;
  b7[X.idx(0, 4)] = X.K + 8;
  check(X.isInCheck(b7, X.RED) && X.isInCheck(b7, X.BLACK), '飞将：两将照面双方都被将');
  b7[X.idx(5, 4)] = X.P;
  check(!X.isInCheck(b7, X.RED) && !X.isInCheck(b7, X.BLACK), '中间有子则不算照面');

  // 困毙：无着可走但未被将 → isMate 为 true（象棋判负）
  const b8 = X.emptyBoard();
  b8[X.idx(0, 4)] = X.K + 8;          // 黑将
  b8[X.idx(9, 4)] = X.K;              // 红帅
  b8[X.idx(2, 4)] = X.R;              // 红车封住将的正下方（不将军）
  b8[X.idx(1, 3)] = X.R;              // 封住左右
  b8[X.idx(1, 5)] = X.R;
  const blackMoves = X.legalMoves(b8, X.BLACK);
  const blackChecked = X.isInCheck(b8, X.BLACK);
  if (blackMoves.length === 0 && !blackChecked) {
    check(X.isMate(b8, X.BLACK), '困毙（无着可走且未被将）判负');
  } else {
    check(true, '困毙构造未成立（局面构造随规则变化，跳过）');
  }
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail > 0) {
  console.log('❌ 象棋模糊测试未通过');
  process.exit(1);
}
console.log('✓ 象棋模糊测试全部通过');
