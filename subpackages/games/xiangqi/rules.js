// 中国象棋规则引擎（纯逻辑，无 wx 依赖，可 node 单测）
//
// 棋盘表示：一维数组，长度 90 = 9 列 × 10 行。
//   索引 = row * 9 + col，row 0 在上方（黑方底线），row 9 在下方（红方底线）。
// 棋子编码：用 1~7 表示红方，9~15 表示黑方，0 为空。
//   高低位区分阵营（piece > 8 为黑），这样「是否同一方」只需比较一次。
//   1 帅  2 仕  3 相  4 马  5 车  6 炮  7 兵
//   9 将 10 士 11 象 12 馬 13 車 14 砲 15 卒
// 为什么用 1..7 / 9..15 而不是 0..6：sideOf(piece) = piece > 8 ? 2 : 1，
// 一步位运算就能判断敌我，比维护两个常量表更不易错。
//
// 走子坐标一律用 { from: idx, to: idx }，页面层负责把 idx 转成行列。
//
// 注意（SWC 白屏陷阱）：不能用数组解构 / 对象展开 / 可选链，
// 会被编译成 require('@swc/runtime/*')，小程序运行时不提供。

const COLS = 9;
const ROWS = 10;

const RED = 1;
const BLACK = 2;

/* ========== 棋子常量 ========== */

// 类型（去掉阵营后的 1~7）
const K = 1, A = 2, B = 3, N = 4, R = 5, C = 6, P = 7;

// 初始局面（row 0 是黑方底线）
// 用字符串写更易读，也便于和资料核对。
// 兵/卒位置是关键：红兵在 row 6 的 col 0/2/4/6/8，黑卒在 row 3 的同 5 列。
// 漏掉中路那一子会让两将一开始就同列照面，整个规则引擎全错。
const START_ROWS = [
  'rnbakabnr',   // 黑：車馬象士将士象馬車
  '.........',
  '.c.....c.',   // 黑砲（col 1 / 7）
  'p.p.p.p.p',   // 黑卒（col 0/2/4/6/8）
  '.........',
  '.........',
  'P.P.P.P.P',   // 红兵（col 0/2/4/6/8）
  '.C.....C.',   // 红炮（col 1 / 7）
  '.........',
  'RNBAKABNR'    // 红：車馬相仕帥仕相馬車
];

// 字符 → 编码
const CHAR2CODE = {
  k: 9,  a: 10, b: 11, n: 12, r: 13, c: 14, p: 15,   // 黑（小写）
  K: 1,  A: 2,  B: 3,  N: 4,  R: 5,  C: 6,  P: 7     // 红（大写）
};

const CODE2CHAR = {};
for (const ch in CHAR2CODE) {
  CODE2CHAR[CHAR2CODE[ch]] = ch;
}

// 棋子中文名（用于 UI 显示）
const NAMES = {
  1: '帅', 2: '仕', 3: '相', 4: '马', 5: '车', 6: '炮', 7: '兵',
  9: '将', 10: '士', 11: '象', 12: '馬', 13: '車', 14: '砲', 15: '卒'
};

/* ========== 基础工具 ========== */

function idx(row, col) { return row * COLS + col; }
function rowOf(i) { return Math.floor(i / COLS); }
function colOf(i) { return i % COLS; }
function inBoard(row, col) { return row >= 0 && row < ROWS && col >= 0 && col < COLS; }

// 阵营：1 红，2 黑，0 空
function sideOf(piece) {
  if (!piece) return 0;
  return piece > 8 ? BLACK : RED;
}

// 去掉阵营的棋子类型 1~7
function typeOf(piece) {
  if (!piece) return 0;
  return piece > 8 ? piece - 8 : piece;
}

function emptyBoard() {
  const b = new Array(COLS * ROWS).fill(0);
  return b;
}

function startBoard() {
  const b = emptyBoard();
  for (let r = 0; r < ROWS; r++) {
    const line = START_ROWS[r];
    for (let c = 0; c < COLS; c++) {
      const ch = line.charAt(c);
      if (ch !== '.') b[idx(r, c)] = CHAR2CODE[ch];
    }
  }
  return b;
}

function cloneBoard(b) {
  return b.slice();
}

// 找某方帅/将的位置
function findKing(b, side) {
  const target = side === RED ? K : K + 8;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === target) return i;
  }
  return -1;
}

/* ========== 单棋子走法生成（伪合法，不含自将检测） ========== */

// 生成 from 位置棋子的所有伪合法目标（不含「走后自己被将」的过滤）
function pseudoMoves(b, from) {
  const piece = b[from];
  if (!piece) return [];
  const side = sideOf(piece);
  const t = typeOf(piece);
  const r = rowOf(from), c = colOf(from);
  const out = [];

  const tryPush = (nr, nc) => {
    if (!inBoard(nr, nc)) return;
    const to = idx(nr, nc);
    const tp = b[to];
    if (tp && sideOf(tp) === side) return;   // 不能吃自己的子
    out.push({ from, to });
  };

  if (t === R || t === C) {
    // 车 / 炮：沿四方向直线推进
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (let d = 0; d < dirs.length; d++) {
      const dr = dirs[d][0], dc = dirs[d][1];
      let nr = r + dr, nc = c + dc;
      let jumped = false;   // 炮专用：是否已越过一个棋子
      while (inBoard(nr, nc)) {
        const to = idx(nr, nc);
        const tp = b[to];
        if (t === R) {
          if (!tp) { out.push({ from, to }); }
          else {
            if (sideOf(tp) !== side) out.push({ from, to });
            break;   // 遇子即停
          }
        } else {
          // 炮：未越子时可走空格，越过恰好一个子后可吃
          if (!jumped) {
            if (!tp) out.push({ from, to });
            else jumped = true;
          } else {
            if (tp) {
              if (sideOf(tp) !== side) out.push({ from, to });
              break;
            }
          }
        }
        nr += dr; nc += dc;
      }
    }
  } else if (t === N) {
    // 马：日字 + 蹩马腿
    // 每个走法：(马步 dr,dc) 对应的马腿位置
    const moves = [
      [-2, -1, -1, 0], [-2, 1, -1, 0],
      [2, -1, 1, 0], [2, 1, 1, 0],
      [-1, -2, 0, -1], [1, -2, 0, -1],
      [-1, 2, 0, 1], [1, 2, 0, 1]
    ];
    for (let m = 0; m < moves.length; m++) {
      const dr = moves[m][0], dc = moves[m][1];
      const lr = r + moves[m][2], lc = c + moves[m][3];
      if (!inBoard(lr, lc) || b[idx(lr, lc)]) continue;   // 蹩马腿
      tryPush(r + dr, c + dc);
    }
  } else if (t === B) {
    // 相/象：田字 + 塞象眼 + 不过河
    const moves = [[-2, -2], [-2, 2], [2, -2], [2, 2]];
    for (let m = 0; m < moves.length; m++) {
      const dr = moves[m][0], dc = moves[m][1];
      const nr = r + dr, nc = c + dc;
      const er = r + dr / 2, ec = c + dc / 2;   // 象眼
      if (!inBoard(nr, nc)) continue;
      if (b[idx(er, ec)]) continue;             // 塞象眼
      if (side === RED && nr < 5) continue;     // 红相不过河
      if (side === BLACK && nr > 4) continue;   // 黑象不过河
      tryPush(nr, nc);
    }
  } else if (t === A) {
    // 仕/士：九宫内斜行一步
    const moves = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    for (let m = 0; m < moves.length; m++) {
      const nr = r + moves[m][0], nc = c + moves[m][1];
      if (!inPalace(nr, nc, side)) continue;
      tryPush(nr, nc);
    }
  } else if (t === K) {
    // 帅/将：九宫内直行一步。
    // 注意：这里不生成"飞将吃对方将"的着法。照面（两将同列中间无子）
    // 本身就是非法局面，只要在 isInCheck 里检测即可；若在这里生成该着法，
    // 会导致试走任何一步后 isInCheck 都因照面判真，把所有合法着法误杀。
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (let d = 0; d < dirs.length; d++) {
      const nr = r + dirs[d][0], nc = c + dirs[d][1];
      if (!inPalace(nr, nc, side)) continue;
      tryPush(nr, nc);
    }
  } else if (t === P) {
    // 兵/卒：向前一步；过河后可横走；永不后退
    const forward = side === RED ? -1 : 1;
    tryPush(r + forward, c);
    const crossed = side === RED ? (r <= 4) : (r >= 5);
    if (crossed) {
      tryPush(r, c - 1);
      tryPush(r, c + 1);
    }
  }

  return out;
}

// 是否在九宫内
function inPalace(row, col, side) {
  if (col < 3 || col > 5) return false;
  if (side === RED) return row >= 7 && row <= 9;
  return row >= 0 && row <= 2;
}

/* ========== 攻击检测（从目标格反向探查，不遍历全盘） ========== */

// 早期实现是「遍历全盘为每个对方子生成伪走法，看能否打到 kp」。
// 单次调用要生成约 200 个走法，而 legalMoves 要对每个候选着法都调一次，
// 初始局面直接跑 20 秒以上 —— 不可用。
//
// 现在改为反向探查：站在目标格 (kr,kc) 出发，沿各棋子的攻击轨迹反推。
// 单次 O(1)~O(10)，比原来快两个数量级。

// 目标格是否被 opp 方攻击。side 是被攻击方（用于判断兵/卒的前进方向）
function isAttacked(b, kr, kc, side) {
  const opp = side === RED ? BLACK : RED;

  // 1) 兵/卒：对方兵从「它的前方」打过来。
  //    对方兵位于 (kr - oppForward, kc) 时可直进打到 (kr,kc)；
  //    若对方兵已过河，其横向一步也能打到相邻格。
  const oppFwd = opp === RED ? -1 : 1;      // 对方兵的前进方向（row 增量）
  const pr = kr - oppFwd;                    // 能直打到我的对方兵所在行
  if (inBoard(pr, kc)) {
    const p = b[idx(pr, kc)];
    if (p && sideOf(p) === opp && typeOf(p) === P) return true;
  }
  // 对方兵过河后横打：它在 (kr, kc±1) 且已过河
  for (let dc = -1; dc <= 1; dc += 2) {
    const cc = kc + dc;
    if (!inBoard(kr, cc)) continue;
    const p = b[idx(kr, cc)];
    if (!p || sideOf(p) !== opp || typeOf(p) !== P) continue;
    // 该兵是否已过河（过河后才有横走能力）
    const crossed = opp === RED ? (kr <= 4) : (kr >= 5);
    if (crossed) return true;
  }

  // 2) 马：反向找 8 个可能位置，并检查对应马腿是否空
  const horseFrom = [
    [-2, -1, -1, 0], [-2, 1, -1, 0],
    [2, -1, 1, 0], [2, 1, 1, 0],
    [-1, -2, 0, -1], [1, -2, 0, -1],
    [-1, 2, 0, 1], [1, 2, 0, 1]
  ];
  for (let m = 0; m < horseFrom.length; m++) {
    // horseFrom[m] 是「从对方马的位置走到 (kr,kc)」的马步与马腿偏移
    const fr = kr - horseFrom[m][0], fc = kc - horseFrom[m][1];
    if (!inBoard(fr, fc)) continue;
    const p = b[idx(fr, fc)];
    if (!p || sideOf(p) !== opp || typeOf(p) !== N) continue;
    // 马腿在对方马与目标之间：腿相对对方马的偏移
    const lr = fr + horseFrom[m][2], lc = fc + horseFrom[m][3];
    if (inBoard(lr, lc) && !b[idx(lr, lc)]) return true;
  }

  // 3) 车 / 炮 / 将（同列照面由调用方单独处理）
  const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (let d = 0; d < dirs.length; d++) {
    const dr = dirs[d][0], dc = dirs[d][1];
    let nr = kr + dr, nc = kc + dc;
    let seen = 0;    // 沿该方向遇到的第一个棋子之前，是否已越过一个子（炮用）
    while (inBoard(nr, nc)) {
      const p = b[idx(nr, nc)];
      if (p) {
        if (sideOf(p) === opp) {
          const t = typeOf(p);
          if (t === R && seen === 0) return true;         // 车直线打
          if (t === K && seen === 0) return true;         // 将/帅贴身直打
          if (t === C && seen === 1) return true;         // 炮隔一子打
        }
        seen++;
        if (seen > 1) break;   // 炮只需看第一个子之后的第一个子
      }
      nr += dr; nc += dc;
    }
  }

  return false;
}

// side 方的帅/将是否被攻击（含照面）
function isInCheck(b, side) {
  const kp = findKing(b, side);
  if (kp < 0) return true;   // 将没了视同被将（理论不出现）
  const kr = rowOf(kp), kc = colOf(kp);
  const opp = side === RED ? BLACK : RED;

  // 照面（飞将）：两将同列且中间无子
  const okp = findKing(b, opp);
  if (okp >= 0 && colOf(okp) === kc) {
    // 从己方将走向对方将的方向：红方在下方(row 大)，要往上(row 减小)
    const step = rowOf(okp) > kr ? 1 : -1;
    let blocked = false;
    for (let rr = kr + step; rr !== rowOf(okp); rr += step) {
      if (b[idx(rr, kc)]) { blocked = true; break; }
    }
    if (!blocked) return true;
  }

  return isAttacked(b, kr, kc, side);
}

/* ========== 合法着法 ========== */

// 单棋子合法着法：伪合法 + 走后自己不被将
function legalMovesFrom(b, from) {
  const pseudo = pseudoMoves(b, from);
  const side = sideOf(b[from]);
  const out = [];
  for (let m = 0; m < pseudo.length; m++) {
    const mv = pseudo[m];
    const captured = b[mv.to];
    b[mv.to] = b[mv.from];
    b[mv.from] = 0;
    const bad = isInCheck(b, side);
    b[mv.from] = b[mv.to];
    b[mv.to] = captured;
    if (!bad) out.push(mv);
  }
  return out;
}

// 某方全部合法着法
function legalMoves(b, side) {
  const out = [];
  for (let i = 0; i < b.length; i++) {
    if (sideOf(b[i]) !== side) continue;
    const ms = legalMovesFrom(b, i);
    for (let m = 0; m < ms.length; m++) out.push(ms[m]);
  }
  return out;
}

// 该着法是否合法（含 turn 是否正确）
function isLegal(b, mv, turn) {
  const piece = b[mv.from];
  if (!piece) return false;
  if (sideOf(piece) !== turn) return false;
  const ms = legalMovesFrom(b, mv.from);
  for (let m = 0; m < ms.length; m++) {
    if (ms[m].to === mv.to) return true;
  }
  return false;
}

// 执行着法（不校验合法性，调用方先 isLegal）。返回 { captured }
function applyMove(b, mv) {
  const captured = b[mv.to];
  b[mv.to] = b[mv.from];
  b[mv.from] = 0;
  return { captured };
}

function undoMove(b, mv, captured) {
  b[mv.from] = b[mv.to];
  b[mv.to] = captured;
}

// 是否将死（无合法着法且被将）/ 困毙（无合法着法但未被将）
// 注意：象棋规则中困毙同样判负，与国际象棋不同
function isMate(b, side) {
  return legalMoves(b, side).length === 0;
}

/* ========== FEN 式序列化（用于云同步与重复局面检测） ========== */

// 把棋盘转成紧凑字符串：每格两位（00~15），共 180 字符。
// 云数据库不能直接更新嵌套数组，所以用字符串传输（与五子棋 boardStr 同一思路）
function boardToStr(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    const v = b[i];
    s += (v < 10 ? '0' : '') + v;
  }
  return s;
}

function strToBoard(s) {
  const b = emptyBoard();
  if (!s || s.length < b.length * 2) return startBoard();
  for (let i = 0; i < b.length; i++) {
    b[i] = parseInt(s.substr(i * 2, 2), 10) || 0;
  }
  return b;
}

/* ========== 导出 ========== */

module.exports = {
  COLS, ROWS, RED, BLACK,
  K, A, B, N, R, C, P,
  NAMES, CODE2CHAR, CHAR2CODE,
  idx, rowOf, colOf, inBoard,
  sideOf, typeOf,
  emptyBoard, startBoard, cloneBoard, findKing,
  inPalace,
  pseudoMoves, legalMovesFrom, legalMoves, isLegal,
  applyMove, undoMove, isInCheck, isMate,
  boardToStr, strToBoard
};
