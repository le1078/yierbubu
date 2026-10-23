// 中国象棋规则单测。
// 用法：node tools/xiangqi_logic_test.js
//
// 覆盖：各棋子走法、蹩马腿、塞象眼、炮的隔子吃、兵过河、
//       九宫限制、飞将照面、将军判定、自将非法、将死/困毙、序列化往返。
//
// 所有局面一律用 mk() 构造：引擎要求盘面上双方将帅都在，
// 否则"没有将可保的一方，任何着法都会被判自将"，着法数会全是 0。

const X = require('../subpackages/games/xiangqi/rules.js');

let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

function moveSet(ms) {
  const s = {};
  for (const m of ms) s[m.from + '-' + m.to] = true;
  return s;
}
function has(ms, from, to) { return !!moveSet(ms)[from + '-' + to]; }

const RED = X.RED, BLACK = X.BLACK;

// 默认红帅 (9,4)、黑将 (0,4) 同列会照面，所以黑将放 (0,3)。
// 但 (0,3) 与红帅左移目标 (9,3) 同列，会让"帅可左移"失效，
// 因此默认黑将放 (2,3)（合法位置，且不干扰红帅在九宫内的移动测试）。
function mk(pieces) {
  const b = X.emptyBoard();
  b[X.idx(9, 4)] = X.K;
  b[X.idx(2, 3)] = X.K + 8;
  for (const p of pieces) b[p[0]] = p[1];
  return b;
}

/* ========== 1. 初始局面 ========== */
console.log('\n[1] 初始局面');
{
  const b = X.startBoard();
  check(b.length === 90, '棋盘 90 格');
  check(X.sideOf(b[X.idx(9, 4)]) === RED, '红帅在 (9,4)');
  check(X.sideOf(b[X.idx(0, 4)]) === BLACK, '黑将在 (0,4)');
  check(X.typeOf(b[X.idx(9, 4)]) === X.K, '红帅类型 K');
  check(X.typeOf(b[X.idx(9, 0)]) === X.R, '红车在底线两角');
  check(X.typeOf(b[X.idx(7, 1)]) === X.C, '红炮位置 (7,1)');
  check(X.typeOf(b[X.idx(7, 7)]) === X.C, '红炮位置 (7,7)');
  // 兵/卒 5 个，col 0/2/4/6/8（漏一个会让两将照面，整个引擎错）
  check(X.typeOf(b[X.idx(6, 0)]) === X.P, '红兵 (6,0)');
  check(X.typeOf(b[X.idx(6, 4)]) === X.P, '红兵 (6,4)');
  check(X.typeOf(b[X.idx(6, 8)]) === X.P, '红兵 (6,8)');
  check(X.typeOf(b[X.idx(3, 4)]) === X.P, '黑卒 (3,4)');
  check(X.sideOf(b[X.idx(3, 4)]) === BLACK, '黑卒 (3,4) 属黑方');
  check(X.findKing(b, RED) === X.idx(9, 4), 'findKing 红');
  check(X.findKing(b, BLACK) === X.idx(0, 4), 'findKing 黑');
  check(X.isInCheck(b, RED) === false, '初始红不被将');
  check(X.isInCheck(b, BLACK) === false, '初始黑不被将');
  // 44 是象棋界公认的初始合法着法数
  const red = X.legalMoves(b, RED);
  const black = X.legalMoves(b, BLACK);
  check(red.length === 44, '红方首步 44 个合法着法（实际 ' + red.length + '）');
  check(black.length === 44, '黑方首步 44 个合法着法（实际 ' + black.length + '）');
}

/* ========== 2. 帅/将：九宫限制 ========== */
console.log('\n[2] 帅/将');
{
  // 红帅 (9,4)，黑将 (2,3)（mk 默认）。帅只能直走（上下左右），不能斜走。
  // 左移到 (9,3) 会与黑将同列且中间无子 → 照面，非法。故只有 2 步。
  const b = mk([]);
  const ms = X.legalMovesFrom(b, X.idx(9, 4));
  check(ms.length === 2, '红帅可走 2 步（受照面限制，实际 ' + ms.length + '）');
  check(has(ms, X.idx(9, 4), X.idx(9, 5)), '帅可右移');
  check(has(ms, X.idx(9, 4), X.idx(8, 4)), '帅可前移');
  check(!has(ms, X.idx(9, 4), X.idx(7, 4)), '帅不能出九宫');
  check(!has(ms, X.idx(9, 4), X.idx(9, 3)), '帅不能走进与黑将同列无阻的格子（照面）');
  check(!has(ms, X.idx(9, 4), X.idx(8, 3)), '帅不能斜走');

  // 黑将放远（col 8）时红帅恢复 3 步
  const b2 = mk([]);
  b2[X.idx(2, 3)] = 0;
  b2[X.idx(2, 8)] = X.K + 8;
  const ms2 = X.legalMovesFrom(b2, X.idx(9, 4));
  check(ms2.length === 3, '无照面干扰时红帅可走 3 步（实际 ' + ms2.length + '）');
  check(has(ms2, X.idx(9, 4), X.idx(9, 3)), '帅可左移');

  // 九宫角落的帅：只能直向中心，1 步
  const b3 = mk([]);
  b3[X.idx(9, 4)] = 0;
  b3[X.idx(9, 3)] = X.K;
  b3[X.idx(2, 3)] = 0;
  b3[X.idx(2, 8)] = X.K + 8;
  const ms3 = X.legalMovesFrom(b3, X.idx(9, 3));
  check(ms3.length === 2, '九宫左角帅有 2 步（右移/前移，实际 ' + ms3.length + '）');
  check(has(ms3, X.idx(9, 3), X.idx(9, 4)), '角帅可移向九宫心');
  check(has(ms3, X.idx(9, 3), X.idx(8, 3)), '角帅可前移');
  check(!has(ms3, X.idx(9, 3), X.idx(8, 4)), '角帅不能斜走');
}

/* ========== 3. 飞将（照面） ========== */
console.log('\n[3] 飞将照面');
{
  // 两将同列且中间无子 → 双方都算被将
  const b = X.emptyBoard();
  b[X.idx(9, 4)] = X.K;
  b[X.idx(5, 4)] = X.K + 8;
  check(X.isInCheck(b, RED) === true, '同列无子 → 红被将（照面）');
  check(X.isInCheck(b, BLACK) === true, '同列无子 → 黑也被将（照面对称）');

  // 中间有子则不合面
  const b2 = X.emptyBoard();
  b2[X.idx(9, 4)] = X.K;
  b2[X.idx(7, 4)] = X.K + 8;
  b2[X.idx(8, 4)] = X.P;
  check(X.isInCheck(b2, RED) === false, '同列有子阻挡 → 不合面');

  // 不同列则不合面
  const b3 = X.emptyBoard();
  b3[X.idx(9, 4)] = X.K;
  b3[X.idx(7, 3)] = X.K + 8;
  check(X.isInCheck(b3, RED) === false, '不同列 → 不合面');

  // 帅横移避开照面仍合法（黑将搬到 col 4，则 (9,3) 是唯一合法横移）
  const b4 = mk([]);
  b4[X.idx(2, 3)] = 0;
  b4[X.idx(2, 4)] = X.K + 8;        // 黑将与红帅同列 col 4
  const ms4 = X.legalMovesFrom(b4, X.idx(9, 4));
  check(has(ms4, X.idx(9, 4), X.idx(9, 3)), '帅横移避开照面仍合法');
  check(!has(ms4, X.idx(9, 4), X.idx(8, 4)), '帅不能沿照面列前进');
}

/* ========== 4. 仕/士 ========== */
console.log('\n[4] 仕/士');
{
  // 红仕在 (9,3)（九宫左下角），只能斜入 (8,4)
  const b = mk([[X.idx(9, 3), X.A]]);
  const ms = X.legalMovesFrom(b, X.idx(9, 3));
  check(ms.length === 1, '红仕在该位只可走 1 步（实际 ' + ms.length + '）');
  check(has(ms, X.idx(9, 3), X.idx(8, 4)), '仕可斜入九宫心');

  // 九宫外的仕：只能斜回九宫。(8,3) 的斜邻是 (9,4)（被帅占）和 (7,4)（九宫内）
  const b2 = mk([[X.idx(8, 3), X.A]]);
  const ms2 = X.legalMovesFrom(b2, X.idx(8, 3));
  check(ms2.length === 1, '九宫外的仕只有 1 个着法（' + ms2.length + '）');
  check(has(ms2, X.idx(8, 3), X.idx(7, 4)), '九宫外仕只能斜走（目标须在九宫内）');
  check(!has(ms2, X.idx(8, 3), X.idx(9, 2)), '仕不能走到九宫外');
  check(!has(ms2, X.idx(8, 3), X.idx(9, 4)), '仕不能吃/落到己方帅上');

  // 中心仕 (8,4) 有 4 个斜向
  const b3 = mk([[X.idx(8, 4), X.A]]);
  const ms3 = X.legalMovesFrom(b3, X.idx(8, 4));
  check(ms3.length === 4, '九宫心仕有 4 步（实际 ' + ms3.length + '）');
}

/* ========== 5. 相/象 ========== */
console.log('\n[5] 相/象');
{
  const b = mk([[X.idx(9, 2), X.B]]);
  const ms = X.legalMovesFrom(b, X.idx(9, 2));
  check(has(ms, X.idx(9, 2), X.idx(7, 0)), '相可走大田字 (7,0)');
  check(has(ms, X.idx(9, 2), X.idx(7, 4)), '相可走大田字 (7,4)');
  check(ms.length === 2, '红相该位 2 个着法（实际 ' + ms.length + '）');

  // 塞象眼：堵住 (7,0) 的象眼 (8,1)
  const b2 = mk([[X.idx(9, 2), X.B], [X.idx(8, 1), X.P]]);
  const ms2 = X.legalMovesFrom(b2, X.idx(9, 2));
  check(!has(ms2, X.idx(9, 2), X.idx(7, 0)), '塞象眼后不能走 (7,0)');
  check(has(ms2, X.idx(9, 2), X.idx(7, 4)), '另一个方向仍可走');

  // 不过河：红相 (5,2) 的目标 row 必须 >= 5
  const b3 = mk([[X.idx(5, 2), X.B]]);
  const ms3 = X.legalMovesFrom(b3, X.idx(5, 2));
  check(ms3.length === 2, '红相 (5,2) 有 2 个着法（实际 ' + ms3.length + '）');
  let allOk = true;
  for (const m of ms3) { if (X.rowOf(m.to) < 5) allOk = false; }
  check(allOk, '红相所有着法都不过河');
  const crossed = ms3.filter(m => X.rowOf(m.to) < 5);
  check(crossed.length === 0, '红相无过河着法');

  // 黑象不能过河到 row > 4
  const b4 = mk([[X.idx(4, 2), X.B + 8]]);
  const ms4 = X.legalMovesFrom(b4, X.idx(4, 2));
  let allOk4 = true;
  for (const m of ms4) { if (X.rowOf(m.to) > 4) allOk4 = false; }
  check(allOk4, '黑象所有着法都不过河');
}

/* ========== 6. 马 ========== */
console.log('\n[6] 马');
{
  // 中心马 (5,4)，8 个走法
  const b = mk([[X.idx(5, 4), X.N]]);
  const ms = X.legalMovesFrom(b, X.idx(5, 4));
  check(ms.length === 8, '中心马有 8 个着法（实际 ' + ms.length + '）');
  check(has(ms, X.idx(5, 4), X.idx(3, 3)), '马可走 (-2,-1)');
  check(has(ms, X.idx(5, 4), X.idx(3, 5)), '马可走 (-2,+1)');
  check(has(ms, X.idx(5, 4), X.idx(7, 3)), '马可走 (+2,-1)');
  check(has(ms, X.idx(5, 4), X.idx(7, 5)), '马可走 (+2,+1)');
  check(has(ms, X.idx(5, 4), X.idx(4, 2)), '马可走 (-1,-2)');
  check(has(ms, X.idx(5, 4), X.idx(6, 6)), '马可走 (+1,+2)');

  // 蹩马腿：堵 (4,4) 禁掉 (-2,±1) 两步
  const b2 = mk([[X.idx(5, 4), X.N], [X.idx(4, 4), X.P]]);
  const ms2 = X.legalMovesFrom(b2, X.idx(5, 4));
  check(!has(ms2, X.idx(5, 4), X.idx(3, 3)), '蹩马腿后不能走 (3,3)');
  check(!has(ms2, X.idx(5, 4), X.idx(3, 5)), '蹩马腿后不能走 (3,5)');
  check(has(ms2, X.idx(5, 4), X.idx(7, 3)), '向下不受影响');
  check(ms2.length === 6, '蹩一腿剩 6 个着法（实际 ' + ms2.length + '）');

  // 角上马只有 2 个着法
  const b3 = mk([[X.idx(0, 0), X.N]]);
  const ms3 = X.legalMovesFrom(b3, X.idx(0, 0));
  check(ms3.length === 2, '角上马只有 2 个着法（实际 ' + ms3.length + '）');
  check(has(ms3, X.idx(0, 0), X.idx(2, 1)), '角马可走 (2,1)');
  check(has(ms3, X.idx(0, 0), X.idx(1, 2)), '角马可走 (1,2)');

  // 马可以吃对方子
  const b4 = mk([[X.idx(5, 4), X.N], [X.idx(3, 3), X.P + 8]]);
  const ms4 = X.legalMovesFrom(b4, X.idx(5, 4));
  check(has(ms4, X.idx(5, 4), X.idx(3, 3)), '马可吃对方子');
}

/* ========== 7. 车 ========== */
console.log('\n[7] 车');
{
  // 注意：红帅占 (9,4)，所以中心车在 col 4 向下的目标是 (6,4)~(8,4)，
  // 少一个 (9,4) → 共 16 个（空盘才 17）
  const b = mk([[X.idx(5, 4), X.R]]);
  const ms = X.legalMovesFrom(b, X.idx(5, 4));
  check(ms.length === 16, '中心车 16 个着法（红帅占一格，实际 ' + ms.length + '）');
  check(has(ms, X.idx(5, 4), X.idx(0, 4)), '车可一路到顶');
  check(has(ms, X.idx(5, 4), X.idx(8, 4)), '车可走到帅前一格');
  check(!has(ms, X.idx(5, 4), X.idx(9, 4)), '车不能落到己方帅上');

  // 遇己方子停
  const b2 = mk([[X.idx(5, 4), X.R], [X.idx(5, 6), X.P]]);
  const ms2 = X.legalMovesFrom(b2, X.idx(5, 4));
  check(has(ms2, X.idx(5, 4), X.idx(5, 5)), '车可走到己方子前一格');
  check(!has(ms2, X.idx(5, 4), X.idx(5, 6)), '车不能吃/越过己方子');
  check(!has(ms2, X.idx(5, 4), X.idx(5, 7)), '车不能越过己方子');

  // 吃对方子后停
  const b3 = mk([[X.idx(5, 4), X.R], [X.idx(5, 6), X.P + 8]]);
  const ms3 = X.legalMovesFrom(b3, X.idx(5, 4));
  check(has(ms3, X.idx(5, 4), X.idx(5, 6)), '车可吃对方子');
  check(!has(ms3, X.idx(5, 4), X.idx(5, 7)), '吃子后不能继续前进');
}

/* ========== 8. 炮 ========== */
console.log('\n[8] 炮');
{
  const b = mk([[X.idx(5, 4), X.C]]);
  const ms = X.legalMovesFrom(b, X.idx(5, 4));
  check(ms.length === 16, '空路炮 16 个着法（红帅占一格，实际 ' + ms.length + '）');

  // 隔一个子才能吃
  const b2 = mk([[X.idx(5, 4), X.C], [X.idx(5, 5), X.P], [X.idx(5, 7), X.P + 8]]);
  const ms2 = X.legalMovesFrom(b2, X.idx(5, 4));
  check(has(ms2, X.idx(5, 4), X.idx(5, 7)), '炮隔一子可吃对方');
  check(!has(ms2, X.idx(5, 4), X.idx(5, 5)), '炮不能吃紧邻的子（无炮架）');
  check(!has(ms2, X.idx(5, 4), X.idx(5, 6)), '炮不能落在炮架格');
  check(!has(ms2, X.idx(5, 4), X.idx(5, 8)), '隔两个子不能吃');
  check(has(ms2, X.idx(5, 4), X.idx(5, 3)), '无架方向仍可当车走');

  // 无炮架时不能吃紧邻子
  const b3 = mk([[X.idx(5, 4), X.C], [X.idx(5, 6), X.P + 8]]);
  const ms3 = X.legalMovesFrom(b3, X.idx(5, 4));
  check(!has(ms3, X.idx(5, 4), X.idx(5, 6)), '无炮架不能吃紧邻子');
  check(has(ms3, X.idx(5, 4), X.idx(5, 5)), '仍可走到其前一格');

  // 炮架也可以是对方子
  const b4 = mk([[X.idx(5, 4), X.C], [X.idx(5, 5), X.P + 8], [X.idx(5, 7), X.P + 8]]);
  const ms4 = X.legalMovesFrom(b4, X.idx(5, 4));
  check(has(ms4, X.idx(5, 4), X.idx(5, 7)), '对方子也可当炮架');
}

/* ========== 9. 兵/卒 ========== */
console.log('\n[9] 兵/卒');
{
  // 未过河红兵：只能向前（row 减小）
  const b = mk([[X.idx(6, 4), X.P]]);
  const ms = X.legalMovesFrom(b, X.idx(6, 4));
  check(ms.length === 1, '未过河红兵只能前进（' + ms.length + '）');
  check(has(ms, X.idx(6, 4), X.idx(5, 4)), '红兵向前（row 减小）');
  check(!has(ms, X.idx(6, 4), X.idx(6, 3)), '未过河不能横走');
  check(!has(ms, X.idx(6, 4), X.idx(7, 4)), '兵不能后退');

  // 过河红兵：3 个着法
  const b2 = mk([[X.idx(4, 4), X.P]]);
  const ms2 = X.legalMovesFrom(b2, X.idx(4, 4));
  check(ms2.length === 3, '过河红兵有 3 个着法（' + ms2.length + '）');
  check(has(ms2, X.idx(4, 4), X.idx(3, 4)), '过河仍可前进');
  check(has(ms2, X.idx(4, 4), X.idx(4, 3)), '过河可左移');
  check(has(ms2, X.idx(4, 4), X.idx(4, 5)), '过河可右移');
  check(!has(ms2, X.idx(4, 4), X.idx(5, 4)), '过河也不能后退');

  // 河界线上（row 5）算未过河
  const b5 = mk([[X.idx(5, 4), X.P]]);
  const ms5 = X.legalMovesFrom(b5, X.idx(5, 4));
  check(ms5.length === 1, 'row5 红兵仍未过河（' + ms5.length + '）');

  // 黑卒方向相反
  const b3 = mk([[X.idx(3, 4), X.P + 8]]);
  const ms3 = X.legalMovesFrom(b3, X.idx(3, 4));
  check(ms3.length === 1, '未过河黑卒只能前进');
  check(has(ms3, X.idx(3, 4), X.idx(4, 4)), '黑卒向前（row 增大）');
  const b6 = mk([[X.idx(5, 4), X.P + 8]]);
  const ms6 = X.legalMovesFrom(b6, X.idx(5, 4));
  check(ms6.length === 3, '过河黑卒有 3 个着法（' + ms6.length + '）');
}

/* ========== 10. 自将非法 ========== */
console.log('\n[10] 自将非法');
{
  // 场景 A：黑车 (0,4) 照住红帅 (9,4)，红兵 (5,4) 正在挡中路。
  // 红兵横移会离开 col 4 → 中路空 → 自将，非法；
  // 红兵前进仍在 col 4（仍在挡车）→ 合法。
  const b = mk([[X.idx(0, 4), X.R + 8], [X.idx(5, 4), X.P]]);
  check(X.isInCheck(b, RED) === false, '有兵挡着时红不被将');
  const ms = X.legalMovesFrom(b, X.idx(5, 4));
  check(has(ms, X.idx(5, 4), X.idx(4, 4)), '红兵沿挡车列前进仍合法（仍挡中路）');
  check(!has(ms, X.idx(5, 4), X.idx(5, 3)), '红兵横走后中路空 → 自将，非法');
  check(!has(ms, X.idx(5, 4), X.idx(5, 5)), '红兵横走后中路空 → 自将，非法');

  // 场景 B：黑车 (0,4) 照帅，红兵在 (5,0)（不在中路）→ 红已被将
  const b2 = mk([[X.idx(0, 4), X.R + 8], [X.idx(5, 0), X.P]]);
  check(X.isInCheck(b2, RED) === true, '无挡子时红被黑车将');
  const ms2 = X.legalMovesFrom(b2, X.idx(5, 0));
  check(!has(ms2, X.idx(5, 0), X.idx(4, 0)), '被将时红兵走去别处不解将 → 非法');
  check(!has(ms2, X.idx(5, 0), X.idx(5, 1)), '被将时红兵横走不解将 → 非法');

  // 场景 C：被将时红方所有合法着法都必须能解将
  const msAll = X.legalMoves(b2, RED);
  let allEscape = true;
  for (const m of msAll) {
    const cap = X.applyMove(b2, m);
    if (X.isInCheck(b2, RED)) allEscape = false;
    X.undoMove(b2, m, cap.captured);
  }
  check(allEscape, '被将时所有合法着法都能解将（' + msAll.length + ' 个）');
  check(msAll.length > 0, '被将时有应将可走');

  // 场景 D：帅沿被照列移动仍合法（红兵 (5,4) 仍在挡车）
  const b4 = mk([[X.idx(0, 4), X.R + 8], [X.idx(5, 4), X.P]]);
  const msK = X.legalMovesFrom(b4, X.idx(9, 4));
  check(has(msK, X.idx(9, 4), X.idx(8, 4)), '帅沿挡车列上移仍合法（兵仍挡中路）');
  // 但若兵被将掉，帅再走同一条路就自将
  const b5 = mk([[X.idx(0, 4), X.R + 8]]);
  const msK5 = X.legalMovesFrom(b5, X.idx(9, 4));
  check(!has(msK5, X.idx(9, 4), X.idx(8, 4)), '无挡子时帅不能沿被照列上移');
}

/* ========== 11. 将军判定 ========== */
console.log('\n[11] 将军判定');
{
  // 黑车 (5,4) 与红帅 (9,4) 同列且中间无子 → 红被将
  const b = mk([[X.idx(5, 4), X.R + 8]]);
  check(X.isInCheck(b, RED) === true, '黑车同列空 → 红被将');

  // 黑马将军（从 (7,3) 打 (9,4)）
  const b2 = mk([[X.idx(7, 3), X.N + 8]]);
  check(X.isInCheck(b2, RED) === true, '黑马将军');

  // 黑炮隔架将军
  const b3 = mk([[X.idx(5, 4), X.C + 8], [X.idx(7, 4), X.P]]);
  check(X.isInCheck(b3, RED) === true, '黑炮隔架将军');
  b3[X.idx(7, 4)] = 0;
  check(X.isInCheck(b3, RED) === false, '无炮架不成将');

  // 黑卒贴脸
  const b4 = mk([[X.idx(8, 4), X.P + 8]]);
  check(X.isInCheck(b4, RED) === true, '黑卒贴脸将军');

  // 黑卒在 (8,3)：斜的，不将军
  const b5 = mk([[X.idx(8, 3), X.P + 8]]);
  check(X.isInCheck(b5, RED) === false, '斜邻的黑卒不将军');

  // 马被蹩腿时不将军：黑马 (7,4)，马腿 (8,4) 被红兵堵 → 打不到 (9,4)
  const b6 = mk([[X.idx(7, 4), X.N + 8], [X.idx(8, 4), X.P]]);
  check(X.isInCheck(b6, RED) === false, '蹩腿的马不将军');

  // 车被挡住时不将军：黑车 (5,4)，中路 (6,4) 有子
  const b7 = mk([[X.idx(5, 4), X.R + 8], [X.idx(6, 4), X.P]]);
  check(X.isInCheck(b7, RED) === false, '中间有子的车不将军');
}

/* ========== 12. 将死与困毙 ========== */
console.log('\n[12] 将死与困毙');
{
  // 将死：黑将 (0,4)，红车 (2,4) 隔一格将（黑将够不着车），
  // 红车 (0,0) 封底线让黑将无法横移 → 无路可逃
  const b = X.emptyBoard();
  b[X.idx(0, 4)] = X.K + 8;
  b[X.idx(2, 4)] = X.R;
  b[X.idx(0, 0)] = X.R;
  b[X.idx(9, 3)] = X.K;            // 红帅避开 col 4
  check(X.isInCheck(b, BLACK) === true, '黑将被红车将军');
  check(X.isMate(b, BLACK) === true, '黑将无路可逃（将死）');

  // 有子可动则非将死
  const b2 = mk([[X.idx(1, 4), X.A + 8]]);
  check(X.isMate(b2, BLACK) === false, '有子可动则非将死');

  // 不被将但仍有逃点：黑将 (0,4)，红车 (2,4) 本可沿 col 4 将，
  // 但 (1,4) 有子挡住（用黑方自己的士当挡子，避免"红兵贴身将军"的干扰）
  const b4 = X.emptyBoard();
  b4[X.idx(0, 4)] = X.K + 8;
  b4[X.idx(1, 4)] = X.A + 8;        // 黑士挡在 (1,4)
  b4[X.idx(2, 4)] = X.R;            // 红车在士后面
  b4[X.idx(9, 3)] = X.K;
  check(X.isInCheck(b4, BLACK) === false, '有子挡中路黑将不被将');
  const ms4 = X.legalMoves(b4, BLACK);
  check(ms4.length >= 1, '该局面黑方仍有逃点（' + ms4.length + '）');
}

/* ========== 13. 序列化 ========== */
console.log('\n[13] 序列化');
{
  const b = X.startBoard();
  const s = X.boardToStr(b);
  check(s.length === 180, '序列化长度 180（实际 ' + s.length + '）');
  const b2 = X.strToBoard(s);
  let same = true;
  for (let i = 0; i < b.length; i++) {
    if (b[i] !== b2[i]) { same = false; break; }
  }
  check(same, '序列化 → 反序列化完全一致');
  // 损坏数据回退到初始局面，不抛异常
  const b3 = X.strToBoard('garbage');
  check(X.findKing(b3, RED) === X.idx(9, 4), '非法串回退到初始局面');
  const b4 = X.strToBoard('');
  check(X.findKing(b4, RED) === X.idx(9, 4), '空串回退到初始局面');
}

/* ========== 14. 着法执行与撤销 ========== */
console.log('\n[14] 着法执行与撤销');
{
  const b = X.startBoard();
  const before = X.boardToStr(b);
  // 炮二平五：from (7,7) to (7,4)
  const mv = { from: X.idx(7, 7), to: X.idx(7, 4) };
  check(X.isLegal(b, mv, RED) === true, '炮二平五合法');
  const cap = X.applyMove(b, mv);
  check(b[mv.to] === X.C && b[mv.from] === 0, '着法已执行');
  check(cap.captured === 0, '该着法无吃子');
  X.undoMove(b, mv, cap.captured);
  check(X.boardToStr(b) === before, '撤销后完全还原');

  // 走子方不对 → 非法
  check(X.isLegal(b, mv, BLACK) === false, '非当前方走子判非法');
  // 空格起点 → 非法
  check(X.isLegal(b, { from: X.idx(4, 4), to: X.idx(4, 5) }, RED) === false, '空格起点判非法');
  // 吃到对方将（不合法目标）→ 非法
  check(X.isLegal(b, { from: X.idx(9, 0), to: X.idx(0, 0) }, RED) === false, '车一步吃不到对方底线');
}

/* ========== 汇总 ========== */
console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail > 0) {
  console.log('❌ 象棋规则测试未通过');
  process.exit(1);
}
console.log('✓ 中国象棋规则测试全部通过');
