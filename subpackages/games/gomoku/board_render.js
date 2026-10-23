// 五子棋棋盘 Canvas 绘制：从 gomoku.js 的内嵌绘制逻辑抽出为共享模块。
// gomoku.js 本身不改（线上在跑），这里给 AI 对战页复用，避免两份绘制代码分叉。
//
// 用法：
//   const R = require('./board_render.js');
//   R.draw(ctx, { board, boardW, dpr, lastMove, winLine, bgCanvas })
//
// 设计要点（沿用 gomoku 的做法）：
//   1. 木纹底 + 网格只依赖 boardW，用离屏 canvas 缓存，避免每次重绘重建渐变
//   2. 棋子渐变按颜色缓存，只有黑白两种
//   3. 只有 boardW 变了才重建背景缓存
//
// 注意：不能用数组解构等 SWC 会编译成 runtime helper 的语法（页面白屏陷阱）

const SIZE = 15;

// 缓存对象由调用方持有并回传，本模块只负责填充。
// 缓存 key 必须同时含 W 和 dpr：只比 W 的话，dpr 变化时（切后台恢复、
// 屏幕缩放）不会重建离屏画布，drawImage 就会把旧尺寸的背景拉伸到新画布上，
// 表现为网格整体变斜。线上实测过这个坑。
function ensureBg(bgCache, W, dpr) {
  if (bgCache.canvas && bgCache.w === W && bgCache.dpr === dpr) return bgCache.canvas;
  const bg = wx.createOffscreenCanvas ? wx.createOffscreenCanvas({ type: '2d' }) : null;
  if (!bg) {
    bgCache.canvas = null;
    bgCache.w = W;
    bgCache.dpr = dpr;
    return null;
  }
  bg.width = W * dpr;
  bg.height = W * dpr;
  const bctx = bg.getContext('2d');
  bctx.scale(dpr, dpr);
  drawBgInto(bctx, W);
  bgCache.canvas = bg;
  bgCache.w = W;
  bgCache.dpr = dpr;
  return bg;
}

// 木纹底 + 网格 + 星位
function drawBgInto(ctx, W) {
  const cell = W / (SIZE - 1);
  const grad = ctx.createLinearGradient(0, 0, W, W);
  grad.addColorStop(0, '#F5DEB3');
  grad.addColorStop(1, '#E8C999');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, W);
  ctx.strokeStyle = '#8B6F47';
  ctx.lineWidth = 1;
  for (let i = 0; i < SIZE; i++) {
    // 水平线：(0, y) → (W, y)
    ctx.beginPath(); ctx.moveTo(0, i * cell); ctx.lineTo(W, i * cell); ctx.stroke();
    // 竖线：(x, 0) → (x, W)。注意终点是 (i*cell, W) 不是 (W, i*cell)，
    // 写错会画出一束汇聚到右上角的斜线（线上实测过这个 bug）
    ctx.beginPath(); ctx.moveTo(i * cell, 0); ctx.lineTo(i * cell, W); ctx.stroke();
  }
  const stars = [3, 7, 11];
  ctx.fillStyle = '#8B6F47';
  for (let i = 0; i < stars.length; i++) {
    for (let j = 0; j < stars.length; j++) {
      ctx.beginPath();
      ctx.arc(stars[j] * cell, stars[i] * cell, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// 渐变按颜色缓存：只有黑白两种，不要每颗都 new。
// 渐变以原点为中心创建，绘制前必须 translate 到目标坐标。
// 缓存由 opts.grads 持有（调用方创建一次：{ v: null }），cell 变了要置 null 重建。
//
// 注意：这里刻意改用「纯色」而非 createRadialGradient。
// 原因：radial gradient 对象在多个 translate 后的 context 上复用时，
// 部分小程序基础库版本会把渐变换算到错误的坐标系，表现为棋子被拉出
// 放射状斜线（线上实测：iOS 3.17.2）。纯色 + 单独画高光点更稳。
function ensurePieceGrads(ctx, cell, cache) {
  if (cache.colors && cache.cell === cell) return cache.colors;
  cache.colors = { 1: '#1A1A1A', 2: '#FDFDFD' };
  cache.cell = cell;
  return cache.colors;
}

// 主绘制入口
// opts: { board, boardW, dpr, lastMove, winLine, bgCache, grads }
function draw(ctx, opts) {
  const board = opts.board;
  const W = opts.boardW;
  const dpr = opts.dpr;
  const cell = W / (SIZE - 1);
  if (!board || !W) return;

  // 背景：优先用离屏缓存，不可用时直接画
  const bg = ensureBg(opts.bgCache, W, dpr);
  ctx.clearRect(0, 0, W, W);
  if (bg) {
    // 源用物理尺寸（bg.width/height），目标用逻辑尺寸（W,W）——
    // 当前 ctx 已 scale(dpr)，这样正好 1:1 映射，绝不拉伸
    ctx.drawImage(bg, 0, 0, bg.width, bg.height, 0, 0, W, W);
  } else {
    drawBgInto(ctx, W);
  }

  if (!opts.grads) opts.grads = { grads: null, cell: 0 };
  const colors = ensurePieceGrads(ctx, cell, opts.grads);

  // 棋子
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const v = board[r][c];
      if (!v) continue;
      const x = c * cell, y = r * cell;
      // 阴影
      ctx.beginPath();
      ctx.arc(x + 1, y + 2, cell * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fill();
      // 本体：纯色（渐变在部分基础库上复用会串坐标系，见 ensurePieceGrads 注释）
      ctx.beginPath();
      ctx.arc(x, y, cell * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = colors[v];
      ctx.fill();
      // 白棋加描边，否则白底上看不见
      if (v === 2) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(0,0,0,0.28)';
        ctx.stroke();
      }
      // 高光小点（左上角），让棋子有立体感
      ctx.beginPath();
      ctx.arc(x - cell * 0.13, y - cell * 0.13, cell * 0.1, 0, Math.PI * 2);
      ctx.fillStyle = v === 1 ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.10)';
      ctx.fill();
    }
  }

  // 最后一手红点标记
  const lm = opts.lastMove;
  if (lm && lm.r !== undefined && lm.c !== undefined) {
    ctx.beginPath();
    ctx.arc(lm.c * cell, lm.r * cell, cell * 0.14, 0, Math.PI * 2);
    ctx.fillStyle = '#FF3B30';
    ctx.fill();
  }

  // 胜利连线高亮（可选）：winLine = [[r,c],...]
  const wl = opts.winLine;
  if (wl && wl.length >= 2) {
    ctx.strokeStyle = '#FF3B30';
    ctx.lineWidth = Math.max(3, cell * 0.12);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(wl[0][1] * cell, wl[0][0] * cell);
    for (let i = 1; i < wl.length; i++) {
      ctx.lineTo(wl[i][1] * cell, wl[i][0] * cell);
    }
    ctx.stroke();
  }
}

// 触摸坐标 → 棋盘格（与 draw 的 cell 算法保持一致）
function hitTest(touchX, touchY, boardW) {
  const cell = boardW / (SIZE - 1);
  const c = Math.round(touchX / cell);
  const r = Math.round(touchY / cell);
  if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return null;
  return { r, c };
}

// 找出 (r,c) 这一手的五连坐标（用于高亮）
function findWinLine(board, r, c, color) {
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (let d = 0; d < dirs.length; d++) {
    const dr = dirs[d][0], dc = dirs[d][1];
    const line = [[r, c]];
    for (let s = 0; s < 2; s++) {
      const step = s === 0 ? 1 : -1;
      let nr = r + dr * step, nc = c + dc * step;
      while (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && board[nr][nc] === color) {
        line.push([nr, nc]);
        nr += dr * step;
        nc += dc * step;
      }
    }
    if (line.length >= 5) return line;
  }
  return null;
}

module.exports = {
  SIZE,
  draw,
  ensureBg,
  drawBgInto,
  ensurePieceGrads,
  hitTest,
  findWinLine
};
