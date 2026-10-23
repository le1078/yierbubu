// 五子棋纯逻辑：棋盘 / 胜负判定 / 候选点裁剪。
// 不依赖任何 wx.* API，可在 node 里直接跑单测（见 tools/gomoku_ai_test.js）。
//
// 注意（SWC 白屏陷阱）：不能用数组解构 for (const [a,b] of ..)，
// 会被编译成 require('@swc/runtime/_array_with_holes.js')，小程序运行时不提供。
// 一律用索引访问。

const SIZE = 15;

// 四个主方向：横 / 竖 / 撇 / 捺
const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

function emptyBoard() {
  const b = [];
  for (let i = 0; i < SIZE; i++) b.push(new Array(SIZE).fill(0));
  return b;
}

function cloneBoard(b) {
  const out = [];
  for (let i = 0; i < SIZE; i++) out.push(b[i].slice());
  return out;
}

function inBoard(r, c) {
  return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
}

// 从 (r,c) 出发，沿 (dr,dc) 正反两个方向数连子数（含自身）
function countLine(board, r, c, dr, dc, color) {
  let n = 1;
  for (let s = 0; s < 2; s++) {
    const step = s === 0 ? 1 : -1;
    let nr = r + dr * step, nc = c + dc * step;
    while (inBoard(nr, nc) && board[nr][nc] === color) {
      n++;
      nr += dr * step;
      nc += dc * step;
    }
  }
  return n;
}

// 落一子后是否五连（只判断该点所在四条线，不扫全盘）
function checkWin(board, r, c, color) {
  for (let i = 0; i < DIRS.length; i++) {
    if (countLine(board, r, c, DIRS[i][0], DIRS[i][1], color) >= 5) return true;
  }
  return false;
}

// 试探：假设在 (r,c) 落 color，是否会成五。不改原棋盘。
function checkWinAfter(board, r, c, color) {
  if (!inBoard(r, c) || board[r][c]) return false;
  for (let i = 0; i < DIRS.length; i++) {
    // countLine 内部从 n=1 起数（已把中心点算作 color），所以这里不能再 +1，
    // 否则三连会被误判成"落点即成五"（曾经踩过：AI 因此到处乱下）
    if (countLine(board, r, c, DIRS[i][0], DIRS[i][1], color) >= 5) return true;
  }
  return false;
}

// 在 (r,c) 放 color 后，该点沿某方向能成的最大连子数（用于棋型评估）
function lineLengthAt(board, r, c, dr, dc, color) {
  return countLine(board, r, c, dr, dc, color);
}

/* ========== 候选点裁剪 ========== */

// 全盘 225 个空点逐一搜索太慢。只取「已有棋子周围 N 格内」的空点，
// 15x15 上一局通常不到 40 个，搜索量降一个数量级。
function candidates(board, radius) {
  const marks = [];
  for (let i = 0; i < SIZE; i++) marks.push(new Array(SIZE).fill(false));
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (!board[r][c]) continue;
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          const nr = r + dr, nc = c + dc;
          if (!inBoard(nr, nc) || marks[nr][nc]) continue;
          if (!board[nr][nc]) marks[nr][nc] = true;
        }
      }
    }
  }
  const out = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (marks[r][c]) out.push({ r, c });
    }
  }
  return out;
}

// 空盘时给天元，避免候选点为空导致 AI 无处可下
function candidatesOrCenter(board, radius) {
  const list = candidates(board, radius);
  if (list.length) return list;
  const mid = Math.floor(SIZE / 2);
  return [{ r: mid, c: mid }];
}

module.exports = {
  SIZE,
  DIRS,
  emptyBoard,
  cloneBoard,
  inBoard,
  countLine,
  lineLengthAt,
  checkWin,
  checkWinAfter,
  candidates,
  candidatesOrCenter
};
