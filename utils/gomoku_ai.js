// 五子棋 AI：棋型启发式打分 + 候选点裁剪 + Alpha-Beta 搜索。
// 不依赖 wx.*，可在 node 里单测。
//
// 为什么不用暴力全盘搜索：15x15 全盘 225 点、深度 4 的搜索树是 225^4 ≈ 2.5e9 个节点，
// JS 里跑不完。所以走实用路线：
//   1. 必杀/必堵：有成五点直接下 / 对方有成五点直接堵（这是绝大多数对局的胜负手）
//   2. 候选点裁剪：只搜已有棋子周围 2 格内，通常 <40 个点
//   3. 棋型打分：活四/冲四/活三/眠三/活二 分级加权，攻守分开算
//   4. Alpha-Beta：在裁剪后的候选点上做深度搜索，配时间预算

const core = require('./gomoku_core.js');

const SIZE = core.SIZE;
const DIRS = core.DIRS;

/* ========== 棋型常量 ========== */

// 棋型分值：活四 > 双冲四 > 冲四 + 活三 > 冲四 > 活三 > 眠三 > 活二 > 眠二
const SCORE = {
  FIVE: 1000000,     // 成五
  OPEN_FOUR: 100000, // 活四（两头都通）
  FOUR: 10000,       // 冲四（一头被堵，但能成五）
  OPEN_THREE: 8000,  // 活三（两头都通，一步成活四）
  THREE: 1000,       // 眠三
  OPEN_TWO: 100,     // 活二
  TWO: 10,           // 眠二
  ONE: 1
};

/* ========== 单线棋型分析 ========== */

// 取以 (r,c) 为中心、沿 (dr,dc) 的 11 格窗口（前后各 5 格，含中心）。
// 出界记为 '#'（等同对手子阻挡）。
// 5 格足够覆盖五连 + 两端封堵判断，也够覆盖跳子型（如 x.xx.x）。
function lineWindow(board, r, c, dr, dc) {
  const w = [];
  for (let i = -5; i <= 5; i++) {
    const nr = r + dr * i, nc = c + dc * i;
    if (!core.inBoard(nr, nc)) { w.push('#'); continue; }
    const v = board[nr][nc];
    if (v === 0) w.push('.');
    else if (v === 1) w.push('x');
    else w.push('o');
  }
  return w.join('');
}

// 假设在 (r,c) 落 color 子，统计该点形成的棋型得分（四个方向求和）。
// 做法：把中心格置为 color，并把整条线归一化成「我方=x / 对方=o / 空=. / 界=#」，
// 再做模式匹配。这样能正确处理跳子（x.xx 有冲四潜力），紧邻连子法会漏判。
// 归一化是必须的：lineWindow 产出的是真实黑白视角，而模式表只认 x=我方。
function pointScore(board, r, c, color) {
  if (board[r][c]) return 0;
  const myChar = color === 1 ? 'x' : 'o';
  let total = 0;
  for (let d = 0; d < DIRS.length; d++) {
    const raw = lineWindow(board, r, c, DIRS[d][0], DIRS[d][1]);
    const withMe = raw.slice(0, 5) + myChar + raw.slice(6);
    const str = normalizeLine(withMe, myChar);
    total += scoreLine(str);
  }
  return total;
}

// 把一条线归一化：我方→x，对方→o。
// 必须先给「对方」一个中间占位再替换，否则对方是我方字符时会被二次覆盖。
function normalizeLine(raw, myChar) {
  const oppChar = myChar === 'x' ? 'o' : 'x';
  return raw.split(oppChar).join('\u0001').split(myChar).join('x').split('\u0001').join('o');
}

// 对一条已含落点、已归一化（我方=x / 对方=o / 空=. / 界=#）的线做棋型判定。
// 判定顺序从强到弱，命中即返回（一条线只算最强棋型，避免重复计分）。
// 一条线上可能同时存在多个棋型区域（如 xx.xx），取最强。
function scoreLine(line) {
  // 成五
  if (line.indexOf('xxxxx') !== -1) return SCORE.FIVE;

  // 活四：.xxxx. —— 两头皆通，下一步必成五
  if (/\.xxxx\./.test(line)) return SCORE.OPEN_FOUR;

  // 冲四：能成五但只有一头通。含四连被堵 / xxx.x / x.xxx / xx.xx
  if (FOUR_PATTERNS.some(p => p.test(line))) return SCORE.FOUR;

  // 活三：一步能做成活四。含 .xxx. / .xx.x. / .x.xx.
  if (OPEN_THREE_PATTERNS.some(p => p.test(line))) return SCORE.OPEN_THREE;

  // 眠三：能成冲四但不能成活四
  if (THREE_PATTERNS.some(p => p.test(line))) return SCORE.THREE;

  // 活二：一步能成活三
  if (OPEN_TWO_PATTERNS.some(p => p.test(line))) return SCORE.OPEN_TWO;

  if (TWO_PATTERNS.some(p => p.test(line))) return SCORE.TWO;

  return SCORE.ONE;
}

// 模式表约定：x=我方，o=对方，.=空，#=出界（等同阻挡）。
const FOUR_PATTERNS = [
  /[o#]xxxx\./,        // 四连一头被堵
  /\.xxxx[o#]/,        // 四连另一头被堵
  /xxx\.x/,            // 跳一子可成五
  /x\.xxx/,            // 跳一子可成五（另一侧）
  /xx\.xx/             // 双侧跳，可成五
];

const OPEN_THREE_PATTERNS = [
  /\.xxx\./,           // 标准活三
  /\.xx\.x\./,         // 跳活三
  /\.x\.xx\./          // 跳活三（另一侧）
];

const THREE_PATTERNS = [
  /[o#]xxx\./,         // 一头堵的眠三
  /\.xxx[o#]/,
  /xx\.x/,             // 跳眠三
  /x\.xx/
];

const OPEN_TWO_PATTERNS = [
  /\.xx\./,            // 标准活二
  /\.x\.x\./           // 跳活二
];

const TWO_PATTERNS = [
  /[o#]xx\./,
  /\.xx[o#]/,
  /xx\./,
  /\.xx/
];


/* ========== 全盘评估 ========== */

// 站在 color 视角评估整个棋盘：自己的棋型分 - 对手棋型分。
//
// 实现：对每个空点算「若我下这里能得多少分」+「若对手下这里能得多少分」，
// 分别累加到 myScore / oppScore。这样活三/眠三会因为两端是否通畅而分值不同，
// AI 才会真的想去堵活三。
// （早期版本用连续子数评估，无视封堵，导致 AI 不堵活三 —— 是实测出来的 bug）
function evaluateBoard(board, color) {
  const opp = color === 1 ? 2 : 1;
  let myScore = 0, oppScore = 0;
  const list = core.candidatesOrCenter(board, 2);
  for (const p of list) {
    const a = pointScore(board, p.r, p.c, color);
    const d = pointScore(board, p.r, p.c, opp);
    myScore += a;
    oppScore += d;
  }
  // 防守加权 1.15：同样分值的威胁，堵比攻更划算（少送对手一步）
  return myScore - oppScore * 1.15;
}

/* ========== 一层：必杀 / 必堵 ========== */

// 返回 { r, c, kind: 'win'|'block'|null }
// win: 自己有一步成五；block: 对方有一步成五必须先堵
function findForced(board, color) {
  const opp = color === 1 ? 2 : 1;
  const list = core.candidatesOrCenter(board, 2);

  for (const p of list) {
    if (core.checkWinAfter(board, p.r, p.c, color)) {
      return { r: p.r, c: p.c, kind: 'win' };
    }
  }
  for (const p of list) {
    if (core.checkWinAfter(board, p.r, p.c, opp)) {
      return { r: p.r, c: p.c, kind: 'block' };
    }
  }
  return null;
}

/* ========== 候选点排序（供搜索用） ========== */

// 按「攻 + 守」启发分降序排，取前 N 个。搜索时优先看好点，剪枝效率高。
function rankCandidates(board, color, maxCount) {
  const opp = color === 1 ? 2 : 1;
  const list = core.candidatesOrCenter(board, 2);
  const scored = [];
  for (const p of list) {
    const atk = pointScore(board, p.r, p.c, color);
    const def = pointScore(board, p.r, p.c, opp);
    scored.push({ r: p.r, c: p.c, score: atk + def * 0.9 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxCount);
}

/* ========== Alpha-Beta 搜索 ========== */

// depth: 剩余搜索层数；alpha/beta: 剪枝窗口
// maximizing: true 表示当前层是 AI（找最大分）
function search(board, depth, alpha, beta, color, maximizing, deadline) {
  // 时间预算到了就地返回，靠上层已保存的最佳着法兜底
  if (Date.now() > deadline) return { score: evaluateBoard(board, color), move: null };

  const opp = color === 1 ? 2 : 1;
  const me = maximizing ? color : opp;

  // 终局：上一层刚落子，检查是谁成五
  const moves = rankCandidates(board, color, depth >= 3 ? 10 : 12);
  if (!moves.length) return { score: evaluateBoard(board, color), move: null };

  if (depth <= 0) {
    return { score: evaluateBoard(board, color), move: null };
  }

  let bestMove = null;
  if (maximizing) {
    let best = -Infinity;
    for (const m of moves) {
      board[m.r][m.c] = me;
      const win = core.checkWin(board, m.r, m.c, me);
      let score;
      if (win) score = SCORE.FIVE;
      else score = search(board, depth - 1, alpha, beta, color, false, deadline).score;
      board[m.r][m.c] = 0;
      if (score > best) { best = score; bestMove = m; }
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;  // 剪枝
      if (Date.now() > deadline) break;
    }
    return { score: best, move: bestMove };
  } else {
    let best = Infinity;
    for (const m of moves) {
      board[m.r][m.c] = me;
      const win = core.checkWin(board, m.r, m.c, me);
      let score;
      if (win) score = -SCORE.FIVE;
      else score = search(board, depth - 1, alpha, beta, color, true, deadline).score;
      board[m.r][m.c] = 0;
      if (score < best) { best = score; bestMove = m; }
      if (best < beta) beta = best;
      if (alpha >= beta) break;
      if (Date.now() > deadline) break;
    }
    return { score: best, move: bestMove };
  }
}

/* ========== 主入口 ========== */

// difficulty: 'easy' | 'normal' | 'hard'
// 返回 { r, c } 或 null（盘面已满）
function think(board, color, difficulty, opts) {
  const conf = opts || {};
  const deadline = Date.now() + (conf.budgetMs || 700);
  const work = core.cloneBoard(board);

  // 1. 必杀 / 必堵永远优先（简单难度也做，否则 AI 会傻到不堵四）
  const forced = findForced(work, color);
  if (forced) return { r: forced.r, c: forced.c, kind: forced.kind };

  if (difficulty === 'easy') {
    // 简单：只看一层棋型，取攻+守最高的点，且故意留 25% 随机性，别太强
    const list = core.candidatesOrCenter(work, 2);
    let best = null, bestScore = -Infinity;
    for (const p of list) {
      const s = pointScore(work, p.r, p.c, color) + pointScore(work, p.r, p.c, color === 1 ? 2 : 1) * 0.9;
      const jitter = s * (0.75 + Math.random() * 0.5);
      if (jitter > bestScore) { bestScore = jitter; best = p; }
    }
    if (best) return { r: best.r, c: best.c, kind: 'heuristic' };
    return null;
  }

  const maxDepth = difficulty === 'hard' ? 4 : 2;

  // 2. 普通/困难：迭代加深，每层保存结果，超时就用上一层的最佳着法
  let best = null;
  for (let d = 2; d <= maxDepth; d++) {
    const res = search(work, d, -Infinity, Infinity, color, true, deadline);
    if (res.move) best = res.move;
    if (Date.now() > deadline) break;
  }
  if (!best) {
    // 搜索没结果（理论上不会）：退回启发式
    const list = rankCandidates(work, color, 1);
    if (!list.length) return null;
    best = list[0];
  }
  return { r: best.r, c: best.c, kind: 'search' };
}

module.exports = {
  SCORE,
  pointScore,
  scoreLine,
  normalizeLine,
  evaluateBoard,
  findForced,
  rankCandidates,
  search,
  think
};
