// 五子棋人机对战（单机）
// 复用 utils/gomoku_core.js（棋盘/胜负）+ utils/gomoku_ai.js（AI 搜索）
// 复用 subpackages/games/gomoku/board_render.js（绘制）
//
// 注意：分包里引用主包 utils 要往上三级（subpackages/games/gomokuai → 根目录）
const COLLECTION = 'gomoku_rooms';
const C = require('../../../utils/constants.js');
const roomkit = require('../../../utils/roomkit.js');
const log = require('../../../utils/log.js');
const core = require('../../../utils/gomoku_core.js');
const ai = require('../../../utils/gomoku_ai.js');
const R = require('../gomoku/board_render.js');

Page({
  data: {
    stage: 'menu',         // menu | aisetup | lobby | waiting | playing | ended
    mode: 'ai',            // online | local | ai
    difficulty: 'normal',
    difficultyText: '普通',
    myColor: 1,            // 1黑 2白
    turn: 1,               // 当前轮谁下
    moveCount: 0,
    statusText: '',
    winText: '',
    thinking: false,
    oppName: 'AI',
    modeText: '人机',
    boardW: 300,
    roomNoInput: '',
    roomNo: '',
    showChat: false,
    chatList: [],
    chatInput: ''
  },

  onLoad() {},

  onReady() {
    // 棋盘尺寸：屏幕宽度 - 页面左右边距 24rpx*2
    // 用安全取值：wx.getWindowInfo 在部分时机返回 null，直接读会崩
    const w = roomkit.getWindowSize().windowWidth;
    const rpx2px = w / 750;
    const boardW = Math.floor(w - 48 * rpx2px);
    this._boardW = boardW;
    this.setData({ boardW });
  },

  onUnload() {
    this._destroyed = true;
    // 统一清理，避免回调对已卸载页面 setData
    roomkit.sweepTimers(this);
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

  pickMode(e) {
    const mode = e.currentTarget.dataset.mode;
    this.setData({ mode });
    if (mode === 'online') {
      this.setData({ stage: 'lobby' });
    } else if (mode === 'ai') {
      this.setData({ stage: 'aisetup' });
    } else {
      this._startGame('local');
    }
  },

  startGame() {
    this._startGame('ai');
  },

  _startGame(mode) {
    this._board = core.emptyBoard();
    this._history = [];
    this._lastMove = null;
    this._winLine = null;
    this._over = false;
    this._thinking = false;
    const oppName = mode === 'ai' ? 'AI' : '对方';
    const modeText = mode === 'ai' ? '人机' : (mode === 'local' ? '同屏' : '联机');
    this.setData({
      stage: 'playing',
      mode,
      turn: 1,
      moveCount: 0,
      winText: '',
      oppName,
      modeText,
      statusText: mode === 'local' ? '黑方走棋' : '轮到你落子'
    }, () => {
      this._ensureCanvas();
      if (mode === 'ai' && this.data.myColor === 2) this._aiTurn();
    });
  },

  backToMenu() {
    this.setData({ stage: 'lobby' });
  },

  /* ========== 落子 ========== */

  /* ========== 联机 ========== */

  onRoomNoInput(e) {
    this.setData({ roomNoInput: String(e.detail.value).replace(/\D/g, '').slice(0, 4) });
  },

  async createRoom() {
    if (this._creating) return;
    this._creating = true;
    wx.showLoading({ title: '创建中…', mask: true });
    try {
      const res = await roomkit.createRoom(COLLECTION, {
        status: 'waiting',
        boardStr: JSON.stringify(core.emptyBoard()),
        history: [],
        turn: 1,
        lastMove: {},
        winner: 0,
        moveCount: 0,
        chat: []
      });
      this._roomId = res.roomId;
      this.setData({ stage: 'waiting', roomNo: res.roomNo, myColor: 1 });
      this._startWatch();
    } catch (err) {
      log.e('[gomokuai] createRoom fail', err);
      wx.showToast({ title: '创建失败，请检查云环境', icon: 'none' });
    } finally {
      wx.hideLoading();
      this._creating = false;
    }
  },

  async joinRoom(roomNoArg) {
    const roomNo = roomNoArg || this.data.roomNoInput;
    if (this._joining) return;
    this._joining = true;
    wx.showLoading({ title: '加入中…', mask: true });
    try {
      const room = await roomkit.findJoinableRoom(COLLECTION, roomNo);
      if (!room) return;
      this._roomId = room._id;
      const db = wx.cloud.database();
      await db.collection(COLLECTION).doc(this._roomId).update({
        data: { status: 'playing', turn: 1, updatedAt: db.serverDate() }
      });
      this._board = room.boardStr ? JSON.parse(room.boardStr) : core.emptyBoard();
      this._history = room.history || [];
      this._over = false;
      this._boardKey = room.boardStr || '';
      this.setData({
        stage: 'playing',
        mode: 'online',
        roomNo,
        myColor: 2,
        turn: 1,
        moveCount: room.moveCount || 0,
        oppName: '对方',
        modeText: '联机',
        statusText: '等待对方落子…'
      }, () => this._ensureCanvas());
      this._startWatch();
    } catch (err) {
      log.e('[gomokuai] joinRoom fail', err);
      wx.showToast({ title: '加入失败：' + (err.errMsg || '未知错误'), icon: 'none' });
    } finally {
      wx.hideLoading();
      this._joining = false;
    }
  },

  _startWatch() {
    roomkit.startWatch(this, COLLECTION, this._roomId, (room) => this._onRoomUpdate(room));
  },

  _onRoomUpdate(room) {
    const me = this.data.myColor;
    if (this.data.stage === 'waiting') {
      if (room.status === 'playing') {
        this._board = room.boardStr ? JSON.parse(room.boardStr) : core.emptyBoard();
        this._history = room.history || [];
        this._over = false;
        this._boardKey = room.boardStr || '';
        this.setData({
          stage: 'playing',
          turn: room.turn || 1,
          moveCount: room.moveCount || 0,
          oppName: '对方',
          modeText: '联机',
          statusText: '轮到你落子'
        }, () => this._ensureCanvas());
      }
      return;
    }
    if (room.status === 'ended' && room.leaver && room.leaver !== me && !this._leaverHandled) {
      this._leaverHandled = true;
      roomkit.closeWatch(this);
      this.setData({ stage: 'ended', winText: '对方已离开，对局结束', statusText: '对局结束' });
      return;
    }
    const newKey = room.boardStr || '';
    const changed = newKey !== (this._boardKey || '');
    if (changed) {
      this._board = newKey ? JSON.parse(newKey) : core.emptyBoard();
      this._boardKey = newKey;
      this._history = room.history || [];
    }
    this._lastMove = room.lastMove && room.lastMove.r !== undefined ? room.lastMove : null;
    const patch = {
      turn: room.turn,
      moveCount: room.moveCount || 0
    };
    if (room.winner) {
      this._over = true;
      patch.stage = 'ended';
      patch.winText = room.winner === me ? '🎉 你赢了！' : '😢 对方获胜';
      patch.statusText = '对局结束';
    } else {
      patch.statusText = room.turn === me ? '轮到你落子' : '等待对方落子…';
    }
    this.setData(patch, () => { if (changed) this._drawBoard(); });
    const merged = roomkit.mergeChat(this.data.chatList, room.chat || [], me);
    if (merged.list.length !== this.data.chatList.length || merged.addedNew) {
      this.setData({ chatList: merged.list });
    }
  },

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
    if (this.data.mode === 'ai' && next !== this.data.myColor) this._aiTurn();
    if (this.data.mode === 'online') this._syncMove(r, c, color, win ? color : 0, count);
  },

  async _syncMove(r, c, color, winner, count) {
    const db = wx.cloud.database();
    try {
      await db.collection(COLLECTION).doc(this._roomId).update({
        data: {
          boardStr: JSON.stringify(this._board),
          history: this._history,
          turn: color === 1 ? 2 : 1,
          lastMove: { r, c },
          moveCount: count,
          winner,
          updatedAt: db.serverDate()
        }
      });
      this._boardKey = JSON.stringify(this._board);
    } catch (err) {
      log.e('[gomokuai] sync fail', err);
      wx.showToast({ title: '同步失败，请重试', icon: 'none' });
    }
  },

  _finish(winner) {
    this._over = true;
    const me = this.data.myColor;
    let text = '🤝 平局';
    if (winner !== 0) {
      if (this.data.mode === 'local') {
        text = winner === 1 ? '⚫ 黑方获胜！' : '⚪ 白方获胜！';
      } else {
        text = winner === me ? '🎉 你赢了！' : '😢 对方获胜';
      }
    }
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

  /* ========== 聊天 ========== */

  toggleChat() {
    this.setData({ showChat: !this.data.showChat });
  },

  onChatInput(e) {
    this.setData({ chatInput: e.detail.value });
  },

  async sendChat() {
    const text = (this.data.chatInput || '').trim();
    if (!text) return;
    this.setData({ chatInput: '' });
    await roomkit.pushChat(this, COLLECTION, {
      from: this.data.myColor, type: 'text', content: text, ts: Date.now()
    });
  },

  leaveRoom() {
    wx.showModal({
      title: '离开对局',
      content: '离开后当前对局将结束，确定吗？',
      success: async (res) => {
        if (!res.confirm) return;
        if (this.data.mode === 'online' && this._roomId) {
          const db = wx.cloud.database();
          try {
            await db.collection(COLLECTION).doc(this._roomId).update({
              data: { status: 'ended', leaver: this.data.myColor, updatedAt: db.serverDate() }
            });
          } catch (e) { log.e('[gomokuai] leave notify fail', e); }
        }
        roomkit.closeWatch(this);
        this._roomId = null;
        this.setData({ stage: 'menu' });
      }
    });
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
      const dpr = roomkit.getDpr();
      // ==== 单一尺寸源 ====
      // 用 wxml 里的 {{boardW}}（即 this.data.boardW）作为唯一真值：
      // CSS 宽、canvas.width/height、绘制坐标系三者必须完全一致。
      // 之前引入 info.size.width 反而制造了三方不一致，导致内容溢出画布
      // （现象：棋盘出现放射状斜线、棋子被切边）。
      // 这里绝不再用 info.size —— 它和 wxml 的 style 值可能不同步。
      const boardW = Math.round(this.data.boardW || this._boardW);
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
      log.d('[gomokuai] canvas ' + boardW + 'x' + boardW + ' dpr=' + dpr + ' (CSS={{boardW}})');
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
