// 小笨中国象棋 · 页面
// 三种模式共用同一套规则引擎：
//   online 联机对战（云房间，走 roomkit）
//   local  同屏轮流
//   ai     人机对战
//
// 注意：分包里引用主包 utils 要往上三级（subpackages/games/xiangqi → 根目录）

const COLLECTION = 'xiangqi_rooms';
const C = require('../../../utils/constants.js');
const log = require('../../../utils/log.js');
const X = require('./rules.js');
const ai = require('./ai.js');
const roomkit = require('../../../utils/roomkit.js');

Page({
  data: {
    stage: 'menu',          // menu | lobby | waiting | playing | ended
    mode: 'local',          // online | local | ai
    difficulty: 'normal',   // easy | normal | hard
    difficultyText: '普通',

    // 联机
    roomNoInput: '',
    roomNo: '',
    mySide: 1,              // 1红 2黑

    // 对局
    turn: 1,                // 1红 2黑
    statusText: '',
    metaText: '',
    winText: '',
    selectedText: '',       // 选中棋子的可走点提示
    thinking: false,
    oppName: '黑方',

    // UI
    boardW: 320,
    boardH: 356,
    showChat: false,
    chatList: [],
    chatInput: ''
  },

  onLoad(options) {
    // 从分享卡片进入：自动加入房间
    if (options && options.roomNo) {
      this._autoJoin = String(options.roomNo);
      this.setData({ stage: 'lobby', mode: 'online', roomNoInput: String(options.roomNo) });
    }
  },

  onReady() {
    this._measureBoard();
  },

  onUnload() {
    this._destroyed = true;
    roomkit.sweepTimers(this);
    if (this._thinkTimer) { clearTimeout(this._thinkTimer); this._thinkTimer = null; }
  },

  onHide() {
    // 切后台时暂停 AI 思考，避免回来时 AI 已连走多步
    this._paused = true;
  },

  onShow() {
    this._paused = false;
  },

  /* ========== 布局 ========== */

  _measureBoard() {
    // 用安全取值：wx.getWindowInfo 在部分时机返回 null，直接读会崩
    const w = roomkit.getWindowSize().windowWidth;
    const rpx2px = w / 750;
    // 棋盘 9 列 10 行，格距 = 宽 / 8，高 = 格距 * 9
    const boardW = Math.floor(w - 48 * rpx2px);
    const cell = boardW / (X.COLS - 1);
    const boardH = Math.floor(cell * (X.ROWS - 1));
    this._cell = cell;
    this.setData({ boardW, boardH });
  },

  /* ========== 模式选择 ========== */

  pickMode(e) {
    const mode = e.currentTarget.dataset.mode;
    this.setData({ mode });
    if (mode === 'online') {
      this.setData({ stage: 'lobby' });
    } else {
      this._startLocal(mode);
    }
  },

  backToMenu() {
    roomkit.closeWatch(this);
    this._roomId = null;
    this.setData({ stage: 'menu' });
  },

  onRoomNoInput(e) {
    this.setData({ roomNoInput: String(e.detail.value).replace(/\D/g, '').slice(0, 4) });
  },

  /* ========== 开局 ========== */

  // 记录当前局面（棋盘 + 轮到谁走）。
  // key 必须含 turn：象棋规则里「同盘面但轮次不同」不算重复局面，
  // 只用棋盘做 key 会把来回走的对称局面误判成和棋。
  _notePosition() {
    if (!this._board) return;
    const key = X.boardToStr(this._board) + '_' + this.data.turn;
    this._positions[key] = (this._positions[key] || 0) + 1;
  },

  _startLocal(mode) {
    this._board = X.startBoard();
    this._history = [];
    this._lastMove = null;
    this._over = false;
    this._noCapture = 0;         // 自然限着计数
    this._positions = {};        // 重复局面检测
    this.setData({
      stage: 'playing',
      turn: X.RED,
      mySide: X.RED,             // 本地/AI 模式：红方永远在下方
      statusText: '红方走棋',
      winText: '',
      oppName: mode === 'ai' ? 'AI' : '黑方',
      metaText: ''
    }, () => {
      this._notePosition();      // 初始局面也要计入，否则三次回到初始不判和
      this._ensureCanvas();
      if (mode === 'ai' && this.data.mySide !== X.RED) this._aiTurn();
    });
  },

  restart() {
    if (this.data.mode === 'online') {
      wx.showToast({ title: '联机模式请离开后重新建房', icon: 'none' });
      return;
    }
    this._startLocal(this.data.mode);
  },

  /* ========== 联机：创建 / 加入 ========== */

  async createRoom() {
    if (this._creating) return;
    this._creating = true;
    wx.showLoading({ title: '创建中…', mask: true });
    try {
      const res = await roomkit.createRoom(COLLECTION, {
        status: 'waiting',
        side: X.RED,                  // 房主执红先行
        turn: X.RED,
        boardStr: X.boardToStr(X.startBoard()),
        history: [],
        winner: 0,
        lastMove: {},
        moveCount: 0,
        chat: []
      });
      this._roomId = res.roomId;
      this.setData({ stage: 'waiting', roomNo: res.roomNo, mySide: X.RED });
      this._startWatch();
    } catch (err) {
      log.e('[xiangqi] createRoom fail', err);
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
        data: { status: 'playing', turn: X.RED, updatedAt: db.serverDate() }
      });
      this._board = X.strToBoard(room.boardStr);
      this._history = room.history || [];
      this._over = false;
      this._notePosition();
      this.setData({
        stage: 'playing',
        roomNo,
        mySide: X.BLACK,
        turn: X.RED,
        oppName: '红方',
        statusText: '等待对方走棋…',
        metaText: '房间 ' + roomNo
      }, () => this._ensureCanvas());
      this._startWatch();
    } catch (err) {
      log.e('[xiangqi] joinRoom fail', err);
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
    const me = this.data.mySide;

    // 房主在等待页：对方加入后开局
    if (this.data.stage === 'waiting') {
      if (room.status === 'playing') {
        roomkit.closeWatch(this);
        this._board = X.strToBoard(room.boardStr);
        this._history = room.history || [];
        this._over = false;
        this._notePosition();
        this.setData({
          stage: 'playing',
          turn: room.turn || X.RED,
          oppName: '黑方',
          statusText: '轮到你走棋',
          metaText: '房间 ' + this.data.roomNo
        }, () => this._ensureCanvas());
      }
      return;
    }

    // 对方离开
    if (room.status === 'ended' && room.leaver && room.leaver !== me && !this._leaverHandled) {
      this._leaverHandled = true;
      this._over = true;
      roomkit.closeWatch(this);
      this.setData({ stage: 'ended', winText: '对方已离开，对局结束', statusText: '对局结束' });
      return;
    }

    // 棋局同步：只在棋盘真的变了时才反序列化 + 重绘
    const newKey = room.boardStr || '';
    const changed = newKey !== (this._boardKey || '');
    if (changed) {
      this._board = X.strToBoard(newKey);
      this._boardKey = newKey;
      this._history = room.history || [];
      this._notePosition();
    }
    this._lastMove = room.lastMove && room.lastMove.from !== undefined ? room.lastMove : null;

    const patch = {
      turn: room.turn,
      moveCount: room.moveCount || 0,
      metaText: '房间 ' + (room.roomNo || this.data.roomNo) + ' · ' + (room.moveCount || 0) + ' 手'
    };
    if (room.winner) {
      this._over = true;
      patch.stage = 'ended';
      patch.winText = room.winner === me ? '🎉 你赢了！' : '😢 对方获胜';
      patch.statusText = '对局结束';
    } else {
      patch.statusText = room.turn === me ? '轮到你走棋' : '等待对方走棋…';
    }
    patch.selectedText = '';
    this.setData(patch, () => { if (changed) this._drawBoard(); });

    // 聊天
    const merged = roomkit.mergeChat(this.data.chatList, room.chat || [], me);
    if (merged.list.length !== this.data.chatList.length || merged.addedNew) {
      this.setData({ chatList: merged.list });
    }
  },

  /* ========== 走棋 ========== */

  onBoardTap(e) {
    if (this.data.stage !== 'playing' || this._over) return;
    if (this._paused) return;
    if (this.data.mode === 'ai' && this.data.turn !== this.data.mySide) return;
    if (this.data.mode === 'online' && this.data.turn !== this.data.mySide) {
      wx.showToast({ title: '还没轮到你哦', icon: 'none' });
      return;
    }

    const t = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]);
    if (!t || t.x == null || t.y == null) return;
    const hit = this._hitTest(t.x, t.y);
    if (!hit) return;

    const piece = this._board[hit.idx];

    // 已选中自己的子 → 尝试走目标点
    if (this._selected !== null && this._selected !== undefined) {
      const mv = { from: this._selected, to: hit.idx };
      if (X.isLegal(this._board, mv, this.data.turn)) {
        this._doMove(mv);
        return;
      }
      // 点的不是合法目标 → 取消选择，继续下面的「选中新子」逻辑
    }

    // 选中自己的子
    if (piece && X.sideOf(piece) === this.data.turn) {
      this._selected = hit.idx;
      this._drawBoard();
      const moves = X.legalMovesFrom(this._board, hit.idx);
      this.setData({
        selectedText: X.NAMES[X.typeOf(piece)] +
          ' · 可走 ' + moves.length + ' 处，再次点击目标落子'
      });
      return;
    }

    // 点空地或对方子 → 取消选择
    this._selected = null;
    this.setData({ selectedText: '' });
    this._drawBoard();
  },

  // 执行一手棋（已确保合法）
  _doMove(mv) {
    const captured = X.applyMove(this._board, mv);
    const turn = this.data.turn;
    const next = turn === X.RED ? X.BLACK : X.RED;
    this._history.push({ from: mv.from, to: mv.to, captured });
    this._lastMove = mv;
    this._selected = null;
    if (captured) this._noCapture = 0; else this._noCapture++;

    const isCheck = X.isInCheck(this._board, next);
    const mate = isCheck && X.isMate(this._board, next);
    const moveCount = this._history.length;

    this.setData({ selectedText: '', turn: next, moveCount }, () => this._drawBoard());

    if (this.data.mode === 'online') {
      this._syncMove(mv, mate ? turn : 0, moveCount, isCheck);
    }

    if (mate) {
      this._over = true;
      this.setData({
        stage: 'ended',
        winText: turn === this.data.mySide ? '🎉 你赢了！' : '😢 对方获胜',
        statusText: '对局结束'
      });
      return;
    }

    // 和棋：自然限着
    if (this._noCapture >= C.XQ_MAX_NO_CAPTURE) {
      this._over = true;
      this.setData({ stage: 'ended', winText: '🤝 和棋（自然限着）', statusText: '对局结束' });
      return;
    }

    // 和棋：三次重复局面（_notePosition 内部维护计数，key 含轮次）
    this._notePosition();
    if (this._positions[X.boardToStr(this._board) + '_' + this.data.turn] >= 3) {
      this._over = true;
      this.setData({ stage: 'ended', winText: '🤝 和棋（三次重复局面）', statusText: '对局结束' });
      return;
    }

    if (this.data.mode === 'ai' && next !== this.data.mySide) {
      this._aiTurn();
      return;
    }

    this.setData({
      statusText: isCheck ? '⚠️ 对方被将军！' : (next === this.data.mySide ? '轮到你走棋' : '等待对方走棋…')
    });
  },

  // 联机模式：把着法写到云房间
  async _syncMove(mv, winner, moveCount, isCheck) {
    const db = wx.cloud.database();
    try {
      await db.collection(COLLECTION).doc(this._roomId).update({
        data: {
          boardStr: X.boardToStr(this._board),
          history: this._history,
          turn: this.data.turn,
          lastMove: mv,
          moveCount,
          winner,
          updatedAt: db.serverDate()
        }
      });
      this._boardKey = X.boardToStr(this._board);
    } catch (err) {
      log.e('[xiangqi] sync fail', err);
      wx.showToast({ title: '同步失败，请重试', icon: 'none' });
    }
  },

  /* ========== AI ========== */

  _aiTurn() {
    if (this._destroyed || this._over) return;
    this.setData({ thinking: true });
    const board = this._board;
    const side = this.data.turn;
    const difficulty = this.data.difficulty;

    this._thinkTimer = setTimeout(() => {
      if (this._destroyed || this._over) return;
      let mv = null;
      try {
        mv = ai.think(board, side, difficulty, { budgetMs: C.XQ_AI_BUDGET_MS });
      } catch (err) {
        log.e('[xiangqi] ai think fail', err);
      }
      this.setData({ thinking: false });
      if (!mv) return;
      this._doMove(mv);
    }, C.XQ_AI_THINK_MS);
  },

  /* ========== 悔棋 ========== */

  undo() {
    if (!this._history.length) {
      wx.showToast({ title: '无棋可悔', icon: 'none' });
      return;
    }
    if (this.data.mode === 'online') {
      wx.showToast({ title: '联机模式悔棋需实现双方确认，暂不支持', icon: 'none' });
      return;
    }
    // 人机模式：撤到「我上一手之前」；本地模式：撤一手即可
    const mySide = this.data.mySide;
    const popped = [];
    while (this._history.length && popped.length < 2) {
      const last = this._history[this._history.length - 1];
      // 这一手是谁下的：奇偶判断（history[0] 是红方第一手）
      const moverOf = (this._history.length % 2 === 1) ? X.RED : X.BLACK;
      const mv = { from: last.from, to: last.to };
      X.undoMove(this._board, mv, last.captured);
      this._history.pop();
      popped.push(last);
      if (this.data.mode === 'ai' && moverOf === mySide) break;
      if (this.data.mode === 'local') break;
    }
    this._over = false;
    this._selected = null;
    this._lastMove = this._history.length
      ? { from: this._history[this._history.length - 1].from, to: this._history[this._history.length - 1].to }
      : null;
    // 悔棋后轮到谁：撤了几手就反推
    const backTurn = (this._history.length % 2 === 0) ? X.RED : X.BLACK;
    this.setData({
      stage: 'playing',
      turn: backTurn,
      winText: '',
      selectedText: '',
      statusText: '轮到你走棋'
    }, () => this._drawBoard());
  },

  /* ========== 聊天（联机） ========== */

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
      from: this.data.mySide, type: 'text', content: text, ts: Date.now()
    });
  },

  /* ========== 离开 ========== */

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
              data: { status: 'ended', leaver: this.data.mySide, updatedAt: db.serverDate() }
            });
          } catch (e) { log.e('[xiangqi] leave notify fail', e); }
        }
        roomkit.closeWatch(this);
        this._roomId = null;
        this.setData({ stage: 'menu' });
      }
    });
  },

  onShareAppMessage() {
    const no = this.data.roomNo;
    return {
      title: no ? '来和我下中国象棋！房间号 ' + no : '来小笨游戏大厅一起玩！',
      path: no
        ? '/subpackages/games/xiangqi/xiangqi?roomNo=' + no
        : '/pages/games/games'
    };
  },

  /* ========== Canvas ========== */

  _ensureCanvas() {
    if (this._canvas) { this._drawBoard(); return; }
    if (this._destroyed) return;
    const q = wx.createSelectorQuery().in(this);
    q.select('#board').fields({ node: true, size: true }).exec((res) => {
      if (this._destroyed) return;
      const info = res && res[0];
      if (!info || !info.node) {
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
      // 尺寸只在这里定一次，之后 canvas.width、绘制坐标系、命中测试全部用它。
      // 之前的 bug：measureBoard 算的 boardW 与 info.size.width 不一致时，
      // canvas 物理尺寸和 _drawBoard 的坐标系对不上，内容超出画布被切掉
      // （现象：左右两侧棋子只剩一半）。统一以 info.size.width 为准。
      // 不用 info.size（与 wxml 的 {{boardW}} 可能不同步），只用 this.data.boardW
      // 与 _drawBoard 同一套几何：留半格边距，格距 = (bw - 2*margin)/8
      const bw = Math.round(this.data.boardW);
      const margin = (bw / (X.COLS - 1)) * 0.5;
      const cell = (bw - margin * 2) / (X.COLS - 1);
      const bh = Math.round(cell * (X.ROWS - 1) + margin * 2);
      canvas.width = bw * dpr;
      canvas.height = bh * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      this._canvas = canvas;
      this._ctx = ctx;
      this._dpr = dpr;
      this._cell = cell;
      this._bw = bw;
      this._bh = bh;
      log.d('[xiangqi] canvas ' + bw + 'x' + bh + ' cell=' + cell.toFixed(3) + ' dpr=' + dpr);
      if (!this._board) this._board = X.startBoard();
      this._drawBoard();
    });
  },

  // 触摸坐标 → 棋盘索引
  _hitTest(x, y) {
    const cell = this._cell;
    if (!cell) return null;
    const ox = this._ox || 0, oy = this._oy || 0;
    // 必须用与绘制完全相同的坐标系（含 ox/oy 偏移），否则点不中
    const c = Math.round((x - ox) / cell);
    const r = Math.round((y - oy) / cell);
    if (r < 0 || r >= X.ROWS || c < 0 || c >= X.COLS) return null;
    return { r, c, idx: X.idx(r, c) };
  },

  _drawBoard() {
    const ctx = this._ctx;
    if (!ctx || !this._board) return;
    // 用 _ensureCanvas 里确定的尺寸，不能用 this.data.boardW（两者可能不一致）
    const W = this._bw || this.data.boardW, H = this._bh || this.data.boardH;
    if (!W || !H) return;

    // ==== 棋盘留边 ====
    // 若直接用 cell = W/8，最左/最右一列棋子中心就在画布边缘（x=0 与 x=W），
    // 半径 0.42*cell 必然被切掉半边（线上实测：左右两列"车"都成半月形）。
    // 做法：棋盘区左右各留半格，实际格距 = (W - 2*margin) / 8，
    // 棋盘整体居中，最外侧棋子完整显示。
    const margin = (W / (X.COLS - 1)) * 0.5;
    const cell = (W - margin * 2) / (X.COLS - 1);
    const ox = margin, oy = margin;
    this._cell = cell;
    this._ox = ox;
    this._oy = oy;

    ctx.clearRect(0, 0, W, H);

    // 木纹底
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#F7E3C6');
    grad.addColorStop(1, '#EBCD9F');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // 网格：横线 10 条、竖线 9 条（中间竖线在河界处分段）
    ctx.strokeStyle = '#8B6F47';
    ctx.lineWidth = 1;
    for (let r = 0; r < X.ROWS; r++) {
      ctx.beginPath();
      ctx.moveTo(ox, oy + r * cell);
      ctx.lineTo(ox + (X.COLS - 1) * cell, oy + r * cell);
      ctx.stroke();
    }
    for (let c = 0; c < X.COLS; c++) {
      ctx.beginPath();
      const x = ox + c * cell;
      if (c === 0 || c === X.COLS - 1) {
        // 边线通到底
        ctx.moveTo(x, oy);
        ctx.lineTo(x, oy + (X.ROWS - 1) * cell);
      } else {
        // 中间竖线在河界处断开（象棋特有画法）
        ctx.moveTo(x, oy);
        ctx.lineTo(x, oy + 4 * cell);
        ctx.moveTo(x, oy + 5 * cell);
        ctx.lineTo(x, oy + (X.ROWS - 1) * cell);
      }
      ctx.stroke();
    }

    // 九宫斜线（上下两个九宫各两条对角线）
    ctx.beginPath();
    ctx.moveTo(ox + 3 * cell, oy); ctx.lineTo(ox + 5 * cell, oy + 2 * cell);
    ctx.moveTo(ox + 5 * cell, oy); ctx.lineTo(ox + 3 * cell, oy + 2 * cell);
    ctx.moveTo(ox + 3 * cell, oy + 7 * cell); ctx.lineTo(ox + 5 * cell, oy + 9 * cell);
    ctx.moveTo(ox + 5 * cell, oy + 7 * cell); ctx.lineTo(ox + 3 * cell, oy + 9 * cell);
    ctx.stroke();

    // 棋子
    const radius = cell * 0.42;
    for (let i = 0; i < this._board.length; i++) {
      const p = this._board[i];
      if (!p) continue;
      const r = X.rowOf(i), c = X.colOf(i);
      const x = ox + c * cell, y = oy + r * cell;
      const red = X.sideOf(p) === X.RED;

      // 阴影
      ctx.beginPath();
      ctx.arc(x + 1, y + 2, radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.20)';
      ctx.fill();

      // 底盘
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = '#FDF3E0';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = red ? '#C0392B' : '#2C3E50';
      ctx.stroke();

      // 内圈
      ctx.beginPath();
      ctx.arc(x, y, radius * 0.78, 0, Math.PI * 2);
      ctx.lineWidth = 1;
      ctx.stroke();

      // 字
      ctx.fillStyle = red ? '#C0392B' : '#2C3E50';
      ctx.font = 'bold ' + Math.floor(radius * 0.95) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(X.NAMES[X.typeOf(p)], x, y + 1);
    }

    // 选中高亮
    if (this._selected !== null && this._selected !== undefined) {
      const r = X.rowOf(this._selected), c = X.colOf(this._selected);
      ctx.beginPath();
      ctx.arc(ox + c * cell, oy + r * cell, radius * 1.25, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#FF5A5F';
      ctx.stroke();

      // 可走点提示
      const moves = X.legalMovesFrom(this._board, this._selected);
      for (const m of moves) {
        const mr = X.rowOf(m.to), mc = X.colOf(m.to);
        ctx.beginPath();
        ctx.arc(ox + mc * cell, oy + mr * cell, radius * 0.3, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,90,95,0.55)';
        ctx.fill();
      }
    }

    // 最后一手标记（起点圈 + 终点圈）
    // 必须加 ox/oy 偏移，与棋盘同一坐标系，否则标记会整体偏移一个 margin
    if (this._lastMove && this._lastMove.from !== undefined) {
      const fr = X.rowOf(this._lastMove.from), fc = X.colOf(this._lastMove.from);
      const tr = X.rowOf(this._lastMove.to), tc = X.colOf(this._lastMove.to);
      ctx.strokeStyle = '#2980B9';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(ox + fc * cell, oy + fr * cell, radius * 0.9, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(ox + tc * cell, oy + tr * cell, radius * 0.9, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
});
