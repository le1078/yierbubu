// 中国象棋 AI：Minimax + Alpha-Beta + 迭代加深 + 时间预算。
// 纯逻辑，无 wx 依赖，可 node 单测。
//
// 为什么不用暴力：初始局面 44 个着法，深度 4 就是 44^4 ≈ 3.7M 个节点，
// 每节点还要做合法性校验（生成着法 + 试走 + 将军检测）。JS 里跑不动。
// 所以走实用路线：
//   1. 着法排序：先看吃子大的、再看威胁大的，剪枝效率高一个数量级
//   2. 静态评估：子力价值 + 位置表（piece-square table）
//   3. Alpha-Beta 剪枝
//   4. 迭代加深 + 时间预算：超时就用上一层的最佳着法，保证不卡死
//
// 注意（SWC 白屏陷阱）：不能用数组解构 / 对象展开 / 可选链。

const X = require('./rules.js');

/* ========== 子力价值 ========== */

// 以"兵"为 1 个基准单位的经验值。车接近两个马，炮略高于马。
const VALUE = {
  1: 10000,   // 帅（实际不会被我方走到，权重给大是为了评估"即将被杀"）
  2: 120,     // 仕
  3: 120,     // 相
  4: 290,     // 马
  5: 600,     // 车
  6: 300,     // 炮
  7: 30,      // 兵
  8: 0        // 无
};
// 黑方同型棋子价值一致（typeOf 已把 9~15 映射回 1~7）

/* ========== 位置价值表 ========== */

// 位置表让 AI 懂得"抢占要津"（如中路、河口、肋道）。
// 索引 = row * 9 + col，row 0 在上方。按红方视角给分，
// 评估黑方时上下镜像（row → 9 - row）。
// 简化处理：只为马/炮/兵/车做表，仕相帅用固定值即可（活动范围本就受限）。

// 兵/卒：过河后价值大涨，靠近对方将台更值钱
const PAWN_TABLE = [
  0,  0,  0,  0,  0,  0,  0,  0,  0,
  0,  0,  0,  0,  0,  0,  0,  0,  0,
  0,  0,  0,  0,  0,  0,  0,  0,  0,
  0,  0,  0,  0,  0,  0,  0,  0,  0,
  0,  0,  0,  0,  0,  0,  0,  0,  0,
  10, 10, 10, 20, 25, 20, 10, 10, 10,   // 河界附近
  20, 25, 30, 40, 45, 40, 30, 25, 20,   // 过河
  30, 40, 50, 60, 70, 60, 50, 40, 30,
  40, 50, 60, 75, 85, 75, 60, 50, 40,
  40, 50, 60, 75, 85, 75, 60, 50, 40
];

// 马：中心活跃，边角差
const HORSE_TABLE = [
  0,  0,  0,  0,  0,  0,  0,  0,  0,
  0,  5, 10, 10, 10, 10, 10,  5,  0,
  0, 10, 15, 20, 20, 20, 15, 10,  0,
  0, 10, 20, 25, 30, 25, 20, 10,  0,
  0, 10, 20, 30, 35, 30, 20, 10,  0,
  0, 10, 20, 30, 35, 30, 20, 10,  0,
  0, 10, 20, 25, 30, 25, 20, 10,  0,
  0, 10, 15, 20, 20, 20, 15, 10,  0,
  0,  5, 10, 10, 10, 10, 10,  5,  0,
  0,  0,  0,  0,  0,  0,  0,  0,  0
];

// 炮：中路和河口佳
const CANNON_TABLE = [
  0,  0,  0,  0,  0,  0,  0,  0,  0,
  0,  0,  5, 10, 10, 10,  5,  0,  0,
  0,  5, 10, 15, 15, 15, 10,  5,  0,
  0,  5, 10, 15, 20, 15, 10,  5,  0,
  0,  5, 10, 15, 20, 15, 10,  5,  0,
  0,  5, 10, 15, 20, 15, 10,  5,  0,
  0,  5, 10, 15, 20, 15, 10,  5,  0,
  0,  5, 10, 15, 15, 15, 10,  5,  0,
  0,  0,  5, 10, 10, 10,  5,  0,  0,
  0,  0,  0,  0,  0,  0,  0,  0,  0
];

// 车：横竖都要活，别窝在角落
const ROOK_TABLE = [
  0,  0,  0,  0,  0,  0,  0,  0,  0,
  0, 10, 15, 20, 20, 20, 15, 10,  0,
  0, 10, 15, 20, 25, 20, 15, 10,  0,
  0, 10, 15, 20, 25, 20, 15, 10,  0,
  0, 10, 15, 20, 25, 20, 15, 10,  0,
  0, 10, 15, 20, 25, 20, 15, 10,  0,
  0, 10, 15, 20, 25, 20, 15, 10,  0,
  0, 10, 15, 20, 25, 20, 15, 10,  0,
  0, 10, 15, 20, 20, 20, 15, 10,  0,
  0,  0,  0,  0,  0,  0,  0,  0,  0
];

const TABLE_OF = {
  4: HORSE_TABLE,
  5: ROOK_TABLE,
  6: CANNON_TABLE,
  7: PAWN_TABLE
};

/* ========== 静态评估 ========== */

// 站在 side 视角打分：我方子力+位置 - 对方子力+位置
function evaluate(b, side) {
  let score = 0;
  for (let i = 0; i < b.length; i++) {
    const p = b[i];
    if (!p) continue;
    const t = X.typeOf(p);
    const mine = X.sideOf(p) === side;
    let v = VALUE[t];
    // 位置加成：黑方视角要上下镜像
    const table = TABLE_OF[t];
    if (table) {
      let pi = i;
      if (!mine && X.sideOf(p) === X.BLACK) {
        // 黑方棋子：镜像 row
        const r = X.rowOf(i);
        pi = (9 - r) * X.COLS + X.colOf(i);
      }
      v += table[pi];
    }
    score += mine ? v : -v;
  }
  return score;
}

/* ========== 着法排序（剪枝效率关键） ========== */

// 按「吃子价值 + 位置改善」降序。好吃的先看，剪掉更多分支。
function orderMoves(b, moves, side) {
  const scored = [];
  for (const m of moves) {
    const cap = b[m.to];
    let s = 0;
    if (cap) s += VALUE[X.typeOf(cap)] * 10;
    // 轻微鼓励向中心/对方半场移动
    const fromR = X.rowOf(m.from), toR = X.rowOf(m.to);
    if (side === X.RED) s += (9 - toR) - (9 - fromR);
    else s += toR - fromR;
    scored.push({ m, s });
  }
  scored.sort((a, c) => c.s - a.s);
  const out = [];
  for (const x of scored) out.push(x.m);
  return out;
}

/* ========== Alpha-Beta ========== */

// 注意这里是 negamax 形式：每一层都以「当前走子方」为视角打分，
// 走子方总是取最大（对手的最优对我即最劣，已由递归+取反体现）。
// 早期版本混用了 minimax（固定 side 视角 + maximizing 标志），导致
// 对方层取 min 时把「己方分低」当好事，AI 会避开白吃的子 —— 实测出来的 bug。
function alphabeta(b, depth, alpha, beta, mover, deadline, nodes) {
  nodes.n++;
  // 时间预算到了就地返回静态评估，靠上层已保存的最佳着法兜底
  if ((nodes.n & 255) === 0 && Date.now() > deadline) {
    return { score: evaluate(b, mover), move: null };
  }

  if (depth <= 0) {
    return { score: evaluate(b, mover), move: null };
  }

  const moves = X.legalMoves(b, mover);
  if (!moves.length) {
    // 当前走子方无合法着法 → 判负（象棋困毙也判负）
    // depth 作为 tie-breaker：越早将死越好，越晚被将死越好
    return { score: -90000 - depth, move: null };
  }
  const ordered = orderMoves(b, moves, mover);

  let best = -Infinity;
  let bestMove = null;
  for (const m of ordered) {
    const cap = X.applyMove(b, m);
    // 吃到对方将 = 立即取胜（legalMoves 理论上已过滤，防御性判断）
    const win = cap.captured !== 0 && X.typeOf(cap.captured) === X.K;
    let score;
    if (win) {
      score = 90000 + depth;
    } else {
      const next = mover === X.RED ? X.BLACK : X.RED;
      // negamax：对手层的分数取反后就是我的视角
      score = -alphabeta(b, depth - 1, -beta, -alpha, next, deadline, nodes).score;
    }
    X.undoMove(b, m, cap.captured);

    if (score > best) { best = score; bestMove = m; }
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;                 // 剪枝
    if (Date.now() > deadline) break;
  }
  return { score: best, move: bestMove };
}

/* ========== 主入口 ========== */

// difficulty: 'easy' | 'normal' | 'hard'
// 返回 { from, to } 或 null（无着法 = 已被将死）
function think(b, side, difficulty, opts) {
  const conf = opts || {};
  const budgetMs = conf.budgetMs || 900;
  const deadline = Date.now() + budgetMs;
  const nodes = { n: 0 };

  const moves = X.legalMoves(b, side);
  if (!moves.length) return null;      // 已被将死/困毙
  if (moves.length === 1) return { from: moves[0].from, to: moves[0].to };

  // 简单：只做一层，且故意掺入随机性，让玩家能赢
  if (difficulty === 'easy') {
    const ordered = orderMoves(b, moves, side);
    // 在前 60% 的好着法里随机挑一个（不是最优，也不会太糟）
    const pool = ordered.slice(0, Math.max(1, Math.ceil(ordered.length * 0.6)));
    const pick = pool[Math.floor(Math.random() * pool.length)];
    return { from: pick.from, to: pick.to };
  }

  const maxDepth = difficulty === 'hard' ? 4 : 2;

  // 迭代加深：每层保存结果，超时就用上一层的最佳着法
  let best = null;
  for (let d = 1; d <= maxDepth; d++) {
    const res = alphabeta(b, d, -Infinity, Infinity, side, deadline, nodes);
    if (res.move) best = res.move;
    if (Date.now() > deadline) break;
  }
  if (!best) {
    // 搜索没结果（理论上不会）：退回排序第一
    const ordered = orderMoves(b, moves, side);
    best = ordered[0];
  }
  return { from: best.from, to: best.to };
}

/* ========== 导出 ========== */

module.exports = {
  VALUE,
  evaluate,
  orderMoves,
  alphabeta,
  think
};
