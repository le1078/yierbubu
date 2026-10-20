// 五子棋人机对战（单机）
// 复用 utils/gomoku_core.js（棋盘/胜负）+ utils/gomoku_ai.js（AI 搜索）
// 复用 subpackages/games/gomoku/board_render.js（绘制）
//
// 注意：分包里引用主包 utils 要往上三级（subpackages/games/gomokuai → 根目录）
const C = require('../../../utils/constants.js');
const log = require('../../../utils/log.js');
const core = require('../../../utils/gomoku_core.js');
const ai = require('../../../utils/gomoku_ai.js');
const R = require('../gomoku/board_render.js');

Page({
  data: {
    stage: 'lobby',        // lobby | playing | ended
    difficulty: 'normal',  // easy | normal | hard
    difficultyText: '普通',
    myColor: 1,            // 1黑 2白
    turn: 1,               // 当前轮谁下
    moveCount: 0,
    statusText: '',
    winText: '',
    thinking: false,
    boardW: 300
  },

  onLoad() {},

  onReady() {
    // 棋盘尺寸：屏幕宽度 - 页面左右边距 24rpx*2
    const sys = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const w = sys.windowWidth;
    const rpx2px = w / 750;
    const boardW = Math.floor(w - 48 * rpx2px);
    this._boardW = boardW;
    this.setData({ boardW });
  },

  onUnload() {
    this._destroyed = true;
    // 统一清理，避免回调对已卸载页面 setData
    ['_thinkTimer', '_canvasRetryTimer'].forEach(k => {
      if (this[k]) { clearTimeout(this[k]); this[k] = null; }
    });
  },

  /* ========== 大厅 ========== */

  pickDifficulty(e) {
    const d = e.currentTarget.dataset.d;
    const text = d === 'easy' ? '简单' : (d === 'hard' ? '困难' : '普通');
    this.setData({ difficulty: d, difficultyText: text });
  },

  pickColor(e) {
    const c = Number(e.currentTarget.dataset.c);
    this.setData({ myColor: c === 2 ? 2 : 1 });
  },

  startGame() {
    this._board = core.emptyBoard();
    this._history = [];
    this._lastMove = null;
    this._winLine = null;
    this._over = false;
    this._thinking = false;
    this.setData({
      stage: 'playing',
      turn: 1,
      moveCount: 0,
      winText: '',
      statusText: '轮到你落子'
    }, () => {
      this._ensureCanvas();
      // 玩家执白时 AI（黑）先走
      if (this.data.myColor === 2) this._aiTurn();
    });
  },

  backToLobby() {
    this.setData({ stage: 'lobby' });
  },

  /* ========== 落子 ========== */

  onCanvasTap(e) {
    if (this.data.stage !== 'playing' || this._over) return;
    if (this.data.turn !== this.data.myColor) return;
    if (this._thinking) return;

    const t = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]);
    if (!t || t.x == null || t.y == null) return;
    const hit = R.hitTest(t.x, t.y, this._boardW);
    if (!hit) return;
    if (this._board[hit.r][hit.c]) {
      wx.showToast({ title: '这里已经有棋子了', icon: 'none' });
      return;
    }
    wx.vibrateShort({ type: 'light' });
    this._place(hit.r, hit.c, this.data.myColor);
  },

  // 落子并推进回合。color: 1黑 2白
  _place(r, c, color) {
    this._board[r][c] = color;
    this._history.push({ r, c, color });
    this._lastMove = { r, c };

    const winLine = R.findWinLine(this._board, r, c, color);
    const win = !!winLine;
    if (win) this._winLine = winLine;

    const count = this._history.length;
    this.setData({ moveCount: count, lastMove: this._lastMove }, () => {
      this._drawBoard();
    });

    if (win) {
      this._finish(color);
      return;
    }
    if (count >= core.SIZE * core.SIZE) {
      this._finish(0);   // 平局
      return;
    }

    const next = color === 1 ? 2 : 1;
    this.setData({
      turn: next,
      statusText: next === this.data.myColor ? '轮到你落子' : 'AI 思考中…'
    });
    if (next !== this.data.myColor) this._aiTurn();
  },

  _finish(winner) {
    this._over = true;
    const text = winner === 0 ? '🤝 平局'
      : (winner === this.data.myColor ? '🎉 你赢了！' : '😢 AI 获胜');
    this.setData({
      stage: 'ended',
      winText: text,
      statusText: '对局结束',
      thinking: false
    });
  },

  /* ========== AI 回合 ========== */

  _aiTurn() {
    if (this._destroyed || this._over) return;
    this._thinking = true;
    this.setData({ thinking: true });

    const board = this._board;
    const color = this.data.turn;
    const difficulty = this.data.difficulty;

    // 用 setTimeout 让「思考中」先渲染一帧，避免 AI 瞬移出招显得突兀，
    // 也避免困难难度的搜索阻塞 UI 线程。
    const delay = C.GOMOKU_AI_THINK_MS;
    this._thinkTimer = setTimeout(() => {
      if (this._destroyed || this._over) { this._thinking = false; return; }
      let move = null;
      try {
        move = ai.think(board, color, difficulty, { budgetMs: C.GOMOKU_AI_BUDGET_MS });
      } catch (err) {
        log.e('[gomokuai] think fail', err);
      }
      this._thinking = false;
      this.setData({ thinking: false });
      if (!move) {
        // 理论上不会发生（空盘也有解）；兜底找任意空点
        move = this._anyEmpty();
        if (!move) { this._finish(0); return; }
      }
      this._place(move.r, move.c, color);
    }, delay);
  },

  _anyEmpty() {
    for (let r = 0; r < core.SIZE; r++) {
      for (let c = 0; c < core.SIZE; c++) {
        if (!this._board[r][c]) return { r, c };
      }
    }
    return null;
  },

  /* ========== 悔棋 ========== */

  // 悔棋 = 回到「我上一手之前」的局面。人机对局无需对方同意，直接生效。
  // 关键：必须保证悔棋后轮到我方，否则会触发 AI 自动下子造成连锁。
  undo() {
    if (!this._history.length) {
      wx.showToast({ title: '无棋可悔', icon: 'none' });
      return;
    }
    const myColor = this.data.myColor;
    const popped = [];
    // 最多撤两手：把「AI 那一手 + 我那一手」一起撤掉；
    // 如果上一手本来就是我的（AI 尚未应招），只撤一手。
    while (this._history.length && popped.length < 2) {
      const last = this._history[this._history.length - 1];
      if (popped.length === 1 && last.color !== myColor) break;  // 已撤了我方一手，停
      this._board[last.r][last.c] = 0;
      this._history.pop();
      popped.push(last);
      if (last.color === myColor) break;   // 撤到我自己那一手为止
    }
    if (!popped.length) {
      wx.showToast({ title: '无棋可悔', icon: 'none' });
      return;
    }
    // 若此刻最后一手是对手的（极端情况，如连续悔棋到中局），继续撤一手确保轮到我方
    while (this._history.length &&
           this._history[this._history.length - 1].color !== myColor) {
      const last = this._history[this._history.length - 1];
      this._board[last.r][last.c] = 0;
      this._history.pop();
    }

    this._over = false;
    this._winLine = null;
    const n = this._history.length;
    this._lastMove = n
      ? { r: this._history[n - 1].r, c: this._history[n - 1].c }
      : null;
    this.setData({
      stage: 'playing',
      turn: myColor,
      moveCount: n,
      winText: '',
      statusText: '轮到你落子',
      thinking: false
    }, () => this._drawBoard());
  },

  restart() {
    this.startGame();
  },

  /* ========== Canvas ========== */

  _ensureCanvas() {
    if (this._canvas) { this._drawBoard(); return; }
    if (this._destroyed) return;
    const q = wx.createSelectorQuery().in(this);
    q.select('#gboard').fields({ node: true, size: true }).exec((res) => {
      if (this._destroyed) return;
      const info = res && res[0];
      if (!info || !info.node) {
        // canvas 尚未挂载（wx:if 未渲染）——带上限重试
        this._canvasRetry = (this._canvasRetry || 0) + 1;
        if (this._canvasRetry > C.CANVAS_RETRY_MAX) {
          wx.showToast({ title: '棋盘加载失败，请重进', icon: 'none' });
          return;
        }
        this._canvasRetryTimer = setTimeout(() => this._ensureCanvas(), C.CANVAS_RETRY_DELAY);
        return;
      }
      const canvas = info.node;
      const dpr = Math.min((wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : 2) || 2, 2);
      // 关键：用 canvas 的「实际渲染宽度」而不是 onReady 里估算的 boardW。
      // 估算值依赖 rpx 换算，与真实 CSS 宽度可能有 1px 级误差；
      // 一旦 canvas.width 与 CSS 宽度不匹配，绘制内容就会被压缩/拉伸，
      // 网格和棋子全部变形（线上表现为棋盘出现放射状斜线）。
      // info.size.width 是布局完成后的真实值，用它最稳。
      const realW = (info.size && info.size.width) ? info.size.width : this._boardW;
      const boardW = Math.floor(realW);
      canvas.width = boardW * dpr;
      canvas.height = boardW * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      this._canvas = canvas;
      this._ctx = ctx;
      this._dpr = dpr;
      this._boardW = boardW;
      // 尺寸基准变了，背景缓存必须作废
      this._bgCache = { canvas: null, w: 0, dpr: 0 };
      this._grads = { grads: null, cell: 0 };
      log.d('[gomokuai] canvas ready boardW=' + boardW + ' realW=' + realW + ' dpr=' + dpr);
      if (!this._board) this._board = core.emptyBoard();
      this._drawBoard();
    });
  },

  _drawBoard() {
    const ctx = this._ctx;
    if (!ctx || !this._board) return;
    R.draw(ctx, {
      board: this._board,
      boardW: this._boardW,
      dpr: this._dpr,
      lastMove: this._lastMove,
      winLine: this._winLine,
      bgCache: this._bgCache,
      grads: this._grads
    });
  }
});
