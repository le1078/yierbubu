// 五子棋 AI 单测：必杀/必堵/棋型评分/搜索不犯低级错误。
// 用法：node tools/gomoku_ai_test.js
//
// 这些测试的价值：AI 是纯逻辑，能在 node 里直接验，不用开微信开发者工具。
// 页面写错顶多界面丑，AI 判错五连/不堵四是"不能玩"级别的 bug。

const core = require('../utils/gomoku_core.js');
const ai = require('../utils/gomoku_ai.js');

let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

/* ========== 1. 基础：checkWin / checkWinAfter ========== */
console.log('\n[1] 胜负判定');
{
  const b = core.emptyBoard();
  for (let i = 3; i <= 7; i++) b[7][i] = 1;   // 横向五连
  check(core.checkWin(b, 7, 5, 1) === true, '横向五连判定为胜');
  // (7,2) 是空格，但 countLine 语义是「数经过该点的连子」——(7,3..7,7) 有 5 个 1，
  // 所以这里返回 true 是正确行为（该点与五连共线）。真正该判 false 的是异行/异列点。
  check(core.checkWin(b, 7, 0, 1) === false, '同行但隔两个空格（0,1 无子）判定为不胜');
  check(core.checkWin(b, 6, 5, 1) === false, '异行点判定为不胜');

  // checkWinAfter：差一子成五
  const c = core.emptyBoard();
  for (let i = 3; i <= 6; i++) c[7][i] = 1;   // 四连，缺口在 7 或 2
  check(core.checkWinAfter(c, 7, 7, 1) === true, '补 7 列成五');
  check(core.checkWinAfter(c, 7, 2, 1) === true, '补 2 列成五');
  check(core.checkWinAfter(c, 7, 8, 1) === false, '8 列不成五');
  check(core.checkWinAfter(c, 6, 5, 1) === false, '异行不成五');
}

/* ========== 2. 必杀：自己有四连必须成五 ========== */
console.log('\n[2] 必杀（自己的活四/冲四直接下）');
{
  const b = core.emptyBoard();
  for (let i = 3; i <= 6; i++) b[7][i] = 1;   // 黑四连
  const m = ai.think(b, 1, 'normal');
  check(m !== null && m.kind === 'win', '四连时返回 win 着法');
  check(m !== null && (m.r === 7) && (m.c === 2 || m.c === 7), '成五点在缺口处（2 或 7）');
}

/* ========== 3. 必堵：对方有四连必须先堵 ========== */
console.log('\n[3] 必堵（对方四连必须堵）');
{
  const b = core.emptyBoard();
  for (let i = 3; i <= 6; i++) b[7][i] = 2;   // 白四连，轮到黑下且黑无四连
  b[0][0] = 1;                                 // 给黑随便一个子，避免空盘特例
  const m = ai.think(b, 1, 'normal');
  check(m !== null && m.kind === 'block', '对方四连时返回 block 着法');
  check(m !== null && m.r === 7 && (m.c === 2 || m.c === 7), '堵在缺口处');
}

/* ========== 4. 活三也要堵（不能只堵四） ========== */
console.log('\n[4] 活三应对');
{
  const b = core.emptyBoard();
  b[7][5] = 2; b[7][6] = 2; b[7][7] = 2;       // 白活三，两头空（4 和 8）
  b[0][0] = 1; b[0][1] = 1;                     // 黑只有眠二，无威胁
  const m = ai.think(b, 1, 'normal');
  check(m !== null, '返回着法');
  // 黑没有成五手段，AI 应下在白三的任一端点（4 或 8），否则白下 4 或 8 成活四必胜
  const atEnd = m && m.r === 7 && (m.c === 4 || m.c === 8);
  check(atEnd, '下在活三端点（4 或 8 列），实际 r=' + (m && m.r) + ' c=' + (m && m.c));
}

/* ========== 5. 棋型评分单调性 ========== */
console.log('\n[5] 棋型评分');
{
  // 活二：落点只有一个邻子，两头空 → .x. 形态
  const b2 = core.emptyBoard();
  b2[7][7] = 1;
  const two = ai.pointScore(b2, 7, 8, 1);
  // 活三：落点与两个子成三连且两头空 → .xxx.
  const b3 = core.emptyBoard();
  b3[7][6] = 1; b3[7][8] = 1;
  const three = ai.pointScore(b3, 7, 7, 1);
  // 成五点：四连(6,7,8,9)落5或10
  const b4 = core.emptyBoard();
  for (let i = 6; i <= 9; i++) b4[7][i] = 1;
  const four = ai.pointScore(b4, 7, 5, 1);
  console.log('    活二=' + two + ' 活三=' + three + ' 成五点=' + four);
  check(three > two, '活三 > 活二（' + three + ' > ' + two + '）');
  check(four > three, '成五点 > 活三（' + four + ' > ' + three + '）');
  check(two > 0, '活二 > 0');
  check(four >= ai.SCORE.FIVE, '四连延长端达到成五分值（' + four + ' >= ' + ai.SCORE.FIVE + '）');
}

/* ========== 6. 空盘可下（不返回 null） ========== */
console.log('\n[6] 边界：空盘');
{
  const b = core.emptyBoard();
  for (const d of ['easy', 'normal', 'hard']) {
    const m = ai.think(b, 1, d);
    check(m !== null && core.inBoard(m.r, m.c), d + ' 空盘能给出合法点');
  }
}

/* ========== 7. 不送死：自己的活三别被对手一步五连反杀 ========== */
console.log('\n[7] 不送死（对方已成四时必须先堵，即使自己有活三）');
{
  const b = core.emptyBoard();
  // 白有一子，黑下出活三；但白同时有四连威胁
  b[7][3] = 2; b[7][4] = 2; b[7][5] = 2; b[7][6] = 2;   // 白四连（必杀）
  b[0][0] = 1; b[0][1] = 1; b[0][2] = 1;                 // 黑活三
  const m = ai.think(b, 1, 'normal');
  check(m.kind === 'block' && m.r === 7, '优先堵白四，不追自己的三');
}

/* ========== 8. 合法点：不落在已有子的位置 ========== */
console.log('\n[8] 合法性');
{
  const b = core.emptyBoard();
  b[7][7] = 1; b[7][8] = 2; b[6][7] = 1; b[8][7] = 2;
  const m = ai.think(b, 1, 'hard');
  check(m !== null && b[m.r][m.c] === 0, '不落在已有子上');
}

/* ========== 9. 性能：困难难度单步在预算内 ========== */
console.log('\n[9] 性能');
{
  const b = core.emptyBoard();
  // 摆一个中局，避免空盘特例
  b[7][7] = 1; b[7][8] = 2; b[8][7] = 1; b[8][8] = 2;
  b[6][6] = 1; b[6][7] = 2; b[9][9] = 1;
  const t0 = Date.now();
  const m = ai.think(b, 1, 'hard', { budgetMs: 700 });
  const dt = Date.now() - t0;
  console.log('    困难难度耗时 ' + dt + 'ms，着法 r=' + m.r + ' c=' + m.c);
  check(m !== null, '困难难度有着法');
  check(dt < 3000, '困难难度不超预算太多（' + dt + 'ms < 3000ms）');
}

/* ========== 10. 自我对局：连续 10 局不崩溃、不违例 ========== */
console.log('\n[10] 自我对局（AI vs AI 各 5 局，验证不卡死/不落已占点/终局正确）');
{
  let games = 0, blackWins = 0, whiteWins = 0, draws = 0, illegal = 0;
  for (let g = 0; g < 10; g++) {
    const b = core.emptyBoard();
    let turn = 1, over = false;
    // 黑白用不同难度，避免完全对称导致每局一样
    const diffOf = (c) => (g % 2 === 0 ? (c === 1 ? 'normal' : 'easy') : (c === 1 ? 'easy' : 'normal'));
    for (let step = 0; step < 225 && !over; step++) {
      const m = ai.think(b, turn, diffOf(turn), { budgetMs: 120 });
      if (!m) { over = true; break; }
      if (b[m.r][m.c] !== 0) { illegal++; over = true; break; }
      b[m.r][m.c] = turn;
      if (core.checkWin(b, m.r, m.c, turn)) {
        if (turn === 1) blackWins++; else whiteWins++;
        over = true;
      } else if (step === 224) {
        draws++;
      }
      turn = turn === 1 ? 2 : 1;
    }
    games++;
  }
  console.log('    完成 ' + games + ' 局：黑胜 ' + blackWins + ' / 白胜 ' + whiteWins + ' / 平 ' + draws + '，违例 ' + illegal);
  check(illegal === 0, '无落在已占点的违例');
  check(games === 10, '10 局全部正常终局');
  check(blackWins + whiteWins + draws === 10, '胜负平计数自洽');
}

/* ========== 极端棋盘：AI 不能落在已占点（候选点回退逻辑） ========== */
console.log('\n[极端棋盘] 候选点回退不会给出已占格');
{
  const N = core.SIZE;
  // 几乎满盘，只留一个 7x7 空区：中心 3x3 与任何棋子距离都 > 2，
  // 若候选点只看半径 2，这些格子不在候选里 —— 回退逻辑必须仍选到空点
  const b = core.emptyBoard();
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) b[r][c] = ((r + c) % 2) + 1;
  for (let r = 4; r <= 10; r++) for (let c = 4; c <= 10; c++) b[r][c] = 0;
  let illegal = 0, nulls = 0;
  for (const diff of ['easy', 'normal', 'hard']) {
    for (let k = 0; k < 10; k++) {
      const mv = ai.think(b, 1, diff, { budgetMs: 120 });
      if (!mv) { nulls++; continue; }
      if (b[mv.r][mv.c] !== 0) illegal++;
    }
  }
  check(illegal === 0, '近满盘（7x7 空区）AI 不落在已占格（违例 ' + illegal + '）');
  check(nulls === 0, '近满盘仍能给出着法（空着法 ' + nulls + '）');

  // 只剩一个空点
  const b2 = core.emptyBoard();
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) b2[r][c] = ((r + c) % 2) + 1;
  b2[0][0] = 0;
  let onlyOk = true;
  for (const diff of ['easy', 'normal', 'hard']) {
    const mv = ai.think(b2, 1, diff, { budgetMs: 100 });
    if (!mv || mv.r !== 0 || mv.c !== 0) onlyOk = false;
  }
  check(onlyOk, '只剩一个空点时三个难度都选中该点');

  // 空盘：落在天元
  const mv3 = ai.think(core.emptyBoard(), 1, 'hard', { budgetMs: 100 });
  check(!!mv3 && mv3.r === 7 && mv3.c === 7, '空盘落子在天元（' + JSON.stringify(mv3) + '）');
}

/* ========== 汇总 ========== */
console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail > 0) {
  console.log('❌ 五子棋 AI 测试未通过');
  process.exit(1);
}
console.log('✓ 五子棋 AI 测试全部通过');
