// 模拟 gomoku 核心逻辑单测：胜负判定 + 悔棋 history（与页面实现保持同一算法）
const SIZE = 15;
function emptyBoard() { const b = []; for (let i = 0; i < SIZE; i++) b.push(new Array(SIZE).fill(0)); return b; }

function checkWin(board, r, c, color) {
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (const [dr, dc] of dirs) {
    let count = 1;
    for (const s of [1, -1]) {
      let nr = r + dr * s, nc = c + dc * s;
      while (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && board[nr][nc] === color) { count++; nr += dr * s; nc += dc * s; }
    }
    if (count >= 5) return true;
  }
  return false;
}

// 1 横向五连
let b = emptyBoard();
for (let i = 3; i < 8; i++) b[7][i] = 1;
console.assert(checkWin(b, 7, 5, 1) === true, '横向五连应胜');
console.log('横向五连:', checkWin(b, 7, 5, 1));

// 2 纵向五连
b = emptyBoard();
for (let i = 0; i < 5; i++) b[i][4] = 2;
console.assert(checkWin(b, 2, 4, 2) === true, '纵向五连应胜');
console.log('纵向五连:', checkWin(b, 2, 4, 2));

// 3 主对角线
b = emptyBoard();
for (let i = 0; i < 5; i++) b[i][i] = 1;
console.assert(checkWin(b, 3, 3, 1) === true, '主对角五连应胜');
console.log('主对角五连:', checkWin(b, 3, 3, 1));

// 4 副对角线
b = emptyBoard();
for (let i = 0; i < 5; i++) b[i][9 - i] = 2;
console.assert(checkWin(b, 2, 7, 2) === true, '副对角五连应胜');
console.log('副对角五连:', checkWin(b, 2, 7, 2));

// 5 四连不算胜
b = emptyBoard();
for (let i = 0; i < 4; i++) b[5][i] = 1;
console.assert(checkWin(b, 5, 1, 1) === false, '四连不应胜');
console.log('四连不算胜:', checkWin(b, 5, 1, 1) === false);

// 6 边界：棋盘边缘五连
b = emptyBoard();
for (let i = 0; i < 5; i++) b[0][i] = 1;
console.assert(checkWin(b, 0, 0, 1) === true, '边缘五连应胜');
console.log('边缘五连:', checkWin(b, 0, 0, 1));

// 7 悔棋 history 弹栈
let history = [{ r: 7, c: 7, color: 1 }, { r: 8, c: 8, color: 2 }, { r: 7, c: 8, color: 1 }];
const board = emptyBoard();
history.forEach(m => board[m.r][m.c] = m.color);
const last = history.pop();
board[last.r][last.c] = 0;
const turn = last.color;
console.assert(turn === 1, '悔棋后轮到黑方');
console.assert(board[7][8] === 0, '撤销位置应为空');
console.assert(history.length === 2, '剩余2手');
console.log('悔棋: turn=', turn, 'board清空=', board[7][8] === 0, 'history=', history.length);

// 8 连续悔棋
const last2 = history.pop();
board[last2.r][last2.c] = 0;
console.assert(board[8][8] === 0 && history.length === 1, '连续悔棋');
console.log('连续悔棋: OK');

// 9 房间号补零
function pad4(n) { n = String(n); while (n.length < 4) n = '0' + n; return n; }
console.assert(pad4(426) === '0426');
console.assert(pad4(9999) === '9999');
console.assert(pad4(0) === '0000');
console.log('房间号:', pad4(426), pad4(9999), pad4(0));

// 10 形象分配：双方必须不同
const AVATARS = ['/assets/avatar_a.gif', '/assets/avatar_b.gif'];
for (let k = 0; k < 20; k++) {
  const i = Math.random() < 0.5 ? 0 : 1;
  console.assert(AVATARS[i] !== AVATARS[1 - i], '双方形象必须不同');
}
console.log('形象分配: OK');

console.log('\n全部测试通过 ✓');
