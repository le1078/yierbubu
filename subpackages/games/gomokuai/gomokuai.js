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
    chatInput: '',

    // 联机互动（悔棋/再来一局/戳一戳/扔水果）
    undoState: null,        // null | 'iRequested' | 'oppRequested'
    rematchState: null,     // null | 'iRequested' | 'oppRequested'
    pokeVisible: false,
    pokeText: '',
    emojiFlying: null
  },

  onLoad(options) {
    // 从分享卡片进入：自动加入房间
    if (options && options.roomNo) {
      this.setData({ roomNoInput: String(options.roomNo) });
      this._autoJoin = String(options.roomNo);
    }
  },

  onReady() {
    // 棋盘尺寸：屏幕宽度 - 页面左右边距 24rpx*2
    // 用安全取值：wx.getWindowInfo 在部分时机返回 null，直接读会崩
    const w = roomkit.getWindowSize().windowWidth;
    const rpx2px = w / 750;
    const boardW = Math.floor(w - 48 * rpx2px);
    this._boardW = boardW;
    this.setData({ boardW });
    if (this._autoJoin) {
      const no = this._autoJoin;
      this._autoJoin = null;
      this.joinRoom(no);
    }
  },

  onUnload() {
    this._destroyed = true;
    this._aiToken = (this._aiToken || 0) + 1;
    // 统一清理，避免回调对已卸载页面 setData
    roomkit.sweepTimers(this);
    ['_thinkTimer', '_canvasRetryTimer'].forEach(k => {
      if (this[k]) { clearTimeout(this[k]); this[k] = null; }
    });
  },

  onHide() {
    // 后台停掉 AI 计时器，回来再继续，避免回来时 AI 已经连下好几手
    this._paused = true;
    this._stopAIThink();
  },

  onShow() {
    this._paused = false;
    if (!this._destroyed && this.data.stage === 'playing' &&
        this.data.mode === 'ai' && !this._over &&
        this.data.turn !== this.data.myColor) {
      this._aiTurn();
    }
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
    this._stopAIThink();
    this._resetCanvas();
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
      thinking: false,
      statusText: mode === 'local' ? '黑方走棋' : '轮到你落子'
    }, () => {
      this._ensureCanvas();
      if (mode === 'ai' && this.data.myColor === 2) this._aiTurn();
    });
  },

  backToMenu() {
    this._stopAIThink();
    this._resetCanvas();
    this.setData({ stage: 'menu' });
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
      // 复位上一局残留：对方离开标记、上一局的胜利连线/最后一手
      this._leaverHandled = false;
      this._prevWinner = 0;   // 终局→进行中的转换基线
      this._winLine = null;
      this._lastMove = null;
      this._board = core.emptyBoard();
      this._history = [];
      this._over = false;
      this.setData({ stage: 'waiting', roomNo: res.roomNo, myColor: 1 });
      this._startWatch();
    } catch (err) {
      log.e('[gomokuai] createRoom fail', err);
      const hint = roomkit.joinErrorText(err);
      wx.showToast({ title: hint || '创建失败，请检查云环境', icon: 'none', duration: 3000 });
    } finally {
      wx.hideLoading();
      this._creating = false;
    }
  },

  async joinRoom(roomNoArg) {
    // bindtap 会把事件对象作为第一个参数传进来；只有字符串才是
    // onLoad/分享卡片主动传的房间号，否则回退到输入框的值。
    const roomNo = (typeof roomNoArg === 'string') ? roomNoArg : this.data.roomNoInput;
    if (!roomNo) {
      wx.showToast({ title: '请输入房间号', icon: 'none' });
      return;
    }
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
      this._leaverHandled = false;
      this._prevWinner = 0;   // 终局→进行中的转换基线
      this._winLine = null;
      this._boardKey = room.boardStr || '';
      this._resetCanvas();
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
      const hint = roomkit.joinErrorText(err);
      wx.showToast({ title: hint || ('加入失败：' + (err.errMsg || '未知错误')), icon: 'none', duration: 3000 });
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
        this._leaverHandled = false;
        this._prevWinner = 0;   // 终局→进行中的转换基线
        this._winLine = null;
        this._boardKey = room.boardStr || '';
        this._resetCanvas();
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
      // 弹窗告知（静默切结算屏不够友好），确认后回菜单
      wx.showModal({
        title: '对方已离开',
        content: '对局已结束，回到大厅吧',
        showCancel: false,
        confirmText: '回到大厅',
        success: () => {
          if (this._destroyed) return;
          this._roomId = null;
          this._resetCanvas();
          this.setData({ stage: 'menu', chatList: [] });
        }
      });
      return;
    }
    // 联机请求状态：悔棋 / 再来一局（双方确认流程）
    if (room.undoRequest && room.undoRequest !== me) {
      if ((this._seenUndoSide || 0) !== room.undoRequest && this.data.stage === 'playing') {
        this._seenUndoSide = room.undoRequest;
        this.setData({ undoState: 'oppRequested' });
        wx.showModal({
          title: '对方请求悔棋',
          content: '同意撤回对方的上一手吗？',
          confirmText: '同意',
          cancelText: '拒绝',
          success: (res) => {
            if (this._destroyed) return;
            if (this.data.stage !== 'playing') return;
            this.respondUndo({ currentTarget: { dataset: { agree: res.confirm ? '1' : '0' } } });
          }
        });
      }
    } else if (room.undoRequest === me) {
      if (this.data.undoState !== 'iRequested') this.setData({ undoState: 'iRequested' });
    } else {
      if (this.data.undoState === 'iRequested') {
        this.setData({ undoState: null });
        this._clearRequestTimeout();
      } else if (this.data.undoState === 'oppRequested') {
        this.setData({ undoState: null });
      }
      this._seenUndoSide = 0;
    }
    if (room.rematchRequest && room.rematchRequest !== me) {
      if ((this._seenRematchSide || 0) !== room.rematchRequest) {
        this._seenRematchSide = room.rematchRequest;
        this.setData({ rematchState: 'oppRequested' });
        wx.showModal({
          title: '对方请求再来一局',
          content: '回到空盘重新开始？',
          confirmText: '同意',
          cancelText: '拒绝',
          success: (res) => {
            if (this._destroyed) return;
            this.respondRematch({ currentTarget: { dataset: { agree: res.confirm ? '1' : '0' } } });
          }
        });
      }
    } else if (room.rematchRequest === me) {
      if (this.data.rematchState !== 'iRequested') this.setData({ rematchState: 'iRequested' });
    } else {
      if (this.data.rematchState === 'iRequested') {
        this.setData({ rematchState: null });
        this._clearRequestTimeout();
      } else if (this.data.rematchState === 'oppRequested') {
        this.setData({ rematchState: null });
      }
      this._seenRematchSide = 0;
    }
    // 戳一戳：ts 严格大于上次才触发
    if (room.poke && room.poke.from && room.poke.from !== me) {
      const ts = room.poke.ts || 0;
      if (ts > (this._lastPokeTs || 0)) {
        this._lastPokeTs = ts;
        this._showPoke();
      }
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
      // winner: 1黑 2白 3和（3 是满盘判和时同步的哨兵值）
      patch.winText = room.winner === 3 ? '🤝 平局' : (room.winner === me ? '🎉 你赢了！' : '😢 对方获胜');
      patch.statusText = '对局结束';
    } else {
      // 终局后退回「进行中」：对方同意悔棋/再来一局会把 winner 清 0。
      // 请求方只靠这里恢复，否则一直卡在结算屏（棋盘已复位却还盖着浮层）
      if (this.data.stage === 'ended' && (this._prevWinner || 0) !== 0) {
        this._over = false;
        this._winLine = null;
        this._leaverHandled = false;
        this._prevWinner = 0;   // 终局→进行中的转换基线
        patch.stage = 'playing';
        patch.winText = '';
        patch.lastMove = this._lastMove;
      }
      patch.statusText = room.turn === me ? '轮到你落子' : '等待对方落子…';
    }
    this._prevWinner = room.winner || 0;
    this.setData(patch, () => { if (changed) this._drawBoard(); });
    const merged = roomkit.mergeChat(this.data.chatList, room.chat || [], me);
    if (merged.list.length !== this.data.chatList.length || merged.addedNew) {
      this.setData({ chatList: merged.list });
      // 对方扔的水果：播飞行动画
      if (merged.addedNew && merged.addedNew.type === 'emoji' && merged.addedNew.from !== me) {
        this._playEmojiFly(merged.addedNew.content);
      }
    }
  },

  onCanvasTap(e) {
    if (this.data.stage !== 'playing' || this._over) return;
    // 同屏模式双方轮流点同一块屏：轮到谁就落谁的颜色，不能用 myColor 拦截，
    // 否则黑方下完（turn=2 ≠ myColor=1）白方永远点不进
    const color = this.data.mode === 'local' ? this.data.turn : this.data.myColor;
    if (this.data.mode !== 'local' && this.data.turn !== this.data.myColor) return;
    if (this._thinking) return;
    if (!this._board) return;

    const t = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]);
    if (!t || t.x == null || t.y == null) return;
    const hit = R.hitTest(t.x, t.y, this._boardW);
    if (!hit) return;
    if (this._board[hit.r][hit.c]) {
      wx.showToast({ title: '这里已经有棋子了', icon: 'none' });
      return;
    }
    this._place(hit.r, hit.c, color);
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
    const draw = !win && count >= core.SIZE * core.SIZE;
    this.setData({ moveCount: count, lastMove: this._lastMove }, () => {
      this._drawBoard();
    });

    // 终局（胜/平）也要同步：_syncMove 是房间文档唯一的写入方，
    // 若先 return，对方永远收不到最后一手，会一直卡在「等待对方落子…」
    if (this.data.mode === 'online') {
      this._syncMove(r, c, color, win ? color : (draw ? 3 : 0), count);
    }

    if (win) {
      this._finish(color);
      return;
    }
    if (draw) {
      this._finish(0);   // 平局
      return;
    }

    const next = color === 1 ? 2 : 1;
    const myColor = this.data.myColor;
    // 同屏模式按颜色提示；「AI 思考中…」只属于人机模式
    const statusText = this.data.mode === 'ai'
      ? (next === myColor ? '轮到你落子' : 'AI 思考中…')
      : (next === 1 ? '黑方走棋' : '白方走棋');
    this.setData({ turn: next, statusText });
    if (this.data.mode === 'ai' && next !== myColor) this._aiTurn();
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
      // 写失败必须回滚本地（棋子/历史/回合/终局状态），否则本地与云端永久分叉，
      // 对方重试也补不回来 —— gomoku.js _placeStone 的失败路径就是这么做的
      this._board[r][c] = 0;
      this._history.pop();
      const prev = this._history[this._history.length - 1];
      this._lastMove = prev ? { r: prev.r, c: prev.c } : null;
      if (winner) {
        this._over = false;
        this._winLine = null;
        this.setData({ stage: 'playing', winText: '', statusText: '轮到你落子' });
      }
      this.setData({ turn: color, moveCount: count - 1 }, () => this._drawBoard());
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

  _stopAIThink(resetUI) {
    this._aiToken = (this._aiToken || 0) + 1;
    if (this._thinkTimer) {
      clearTimeout(this._thinkTimer);
      this._thinkTimer = null;
    }
    this._thinking = false;
    if (resetUI !== false && this.data.thinking) this.setData({ thinking: false });
  },

  _aiTurn() {
    if (this._destroyed || this._over || this._paused) return;
    if (this._thinkTimer) return;   // 已经在思考
    this._aiToken = (this._aiToken || 0) + 1;
    const token = this._aiToken;
    this._thinking = true;
    this.setData({ thinking: true });

    const board = this._board;
    const color = this.data.turn;
    const difficulty = this.data.difficulty;

    // 用 setTimeout 让「思考中」先渲染一帧，也避免困难难度搜索阻塞 UI。
    const delay = C.GOMOKU_AI_THINK_MS;
    this._thinkTimer = setTimeout(() => {
      this._thinkTimer = null;
      if (token !== this._aiToken) return;   // 已被重开/悔棋/离开作废
      if (this._destroyed || this._over || this._paused) { this._thinking = false; return; }
      let move = null;
      try {
        move = ai.think(board, color, difficulty, { budgetMs: C.GOMOKU_AI_BUDGET_MS });
      } catch (err) {
        log.e('[gomokuai] think fail', err);
      }
      if (token !== this._aiToken) return;
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
    if (this.data.mode === 'online') {
      // 联机悔棋走「双方确认」（requestUndo），不再直接拒绝
      this.requestUndo();
      return;
    }
    // AI 正在思考时先停掉，避免它把棋子下到悔棋后的棋盘上
    this._stopAIThink();
    const myColor = this.data.myColor;
    // 我还没落过子就没有可悔的：否则会把 AI 的开局第一手删掉又立刻重下，
    // 看起来像 AI 的棋子凭空挪位
    if (this.data.mode !== 'local' && !this._history.some(h => h.color === myColor)) {
      wx.showToast({ title: '无棋可悔', icon: 'none' });
      return;
    }
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
    this._over = false;
    this._winLine = null;
    const n = this._history.length;
    // 黑棋永远先手：偶数手轮到黑，奇数手轮到白。
    // 不能简单写 turn: myColor —— 如果撤到空盘且我执白，应该轮到 AI（黑）。
    const next = (n % 2 === 0) ? 1 : 2;
    this._lastMove = n
      ? { r: this._history[n - 1].r, c: this._history[n - 1].c }
      : null;
    this.setData({
      stage: 'playing',
      turn: next,
      moveCount: n,
      winText: '',
      statusText: this.data.mode === 'ai'
        ? (next === myColor ? '轮到你落子' : 'AI 思考中…')
        : (next === 1 ? '黑方走棋' : '白方走棋'),
      thinking: false
    }, () => {
      this._drawBoard();
      if (this.data.mode === 'ai' && next !== myColor) this._aiTurn();
    });
  },

  restart() {
    if (this.data.mode === 'online') {
      // 联机重开走「双方确认」（requestRematch），不再直接拒绝
      this.requestRematch();
      return;
    }
    this._startGame(this.data.mode === 'ai' ? 'ai' : 'local');
  },

  /* ========== 联机：悔棋 / 再来一局（双方确认） ========== */

  _armRequestTimeout(stateKey) {
    this._clearRequestTimeout();
    this._requestTimeoutKey = stateKey;
    this._undoTimeoutTimer = setTimeout(() => {
      if (this._destroyed) return;
      this.setData({ [stateKey]: null });
      wx.showToast({ title: '对方未响应', icon: 'none' });
    }, C.UNDO_TIMEOUT_MS);
  },

  _clearRequestTimeout() {
    if (this._undoTimeoutTimer) {
      clearTimeout(this._undoTimeoutTimer);
      this._undoTimeoutTimer = null;
    }
    this._requestTimeoutKey = null;
  },

  async requestUndo() {
    if (this.data.stage !== 'playing' || this._over) return;
    if (this.data.undoState) return;
    const history = this._history || [];
    const last = history[history.length - 1];
    if (!last || last.color !== this.data.myColor) {
      wx.showToast({ title: '只能撤回自己的上一手', icon: 'none' });
      return;
    }
    const db = wx.cloud.database();
    try {
      await db.collection(COLLECTION).doc(this._roomId).update({
        data: { undoRequest: this.data.myColor, updatedAt: db.serverDate() }
      });
      this.setData({ undoState: 'iRequested' });
      this._armRequestTimeout('undoState');
    } catch (e) {
      wx.showToast({ title: '请求失败', icon: 'none' });
    }
  },

  async respondUndo(e) {
    const agree = e.currentTarget.dataset.agree === '1';
    const db = wx.cloud.database();
    try {
      if (agree) {
        // 弹掉请求方的最后一手，turn 还给请求方
        const history = (this._history || []).slice();
        const last = history.pop();
        if (last && this._board[last.r] && this._board[last.r][last.c] === last.color) {
          this._board[last.r][last.c] = 0;
        }
        this._history = history;
        const prevLast = history.length ? history[history.length - 1] : null;
        this._lastMove = prevLast ? { r: prevLast.r, c: prevLast.c } : null;
        const reqColor = last ? last.color : 1;
        await db.collection(COLLECTION).doc(this._roomId).update({
          data: {
            boardStr: JSON.stringify(this._board),
            history,
            turn: reqColor,
            lastMove: prevLast ? { r: prevLast.r, c: prevLast.c } : {},
            moveCount: history.length,
            undoRequest: 0,
            updatedAt: db.serverDate()
          }
        });
        this._boardKey = JSON.stringify(this._board);
        this._seenUndoSide = 0;
        this.setData({ undoState: null, statusText: reqColor === this.data.myColor ? '轮到你落子' : '等待对方落子…' }, () => this._drawBoard());
        wx.showToast({ title: '已同意悔棋', icon: 'none' });
      } else {
        await db.collection(COLLECTION).doc(this._roomId).update({
          data: { undoRequest: 0, updatedAt: db.serverDate() }
        });
        this.setData({ undoState: null });
        wx.showToast({ title: '已拒绝', icon: 'none' });
      }
      this._clearRequestTimeout();
    } catch (e2) {
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  async requestRematch() {
    if (this.data.rematchState) return;
    const db = wx.cloud.database();
    try {
      await db.collection(COLLECTION).doc(this._roomId).update({
        data: { rematchRequest: this.data.myColor, updatedAt: db.serverDate() }
      });
      this.setData({ rematchState: 'iRequested' });
      this._armRequestTimeout('rematchState');
    } catch (e) {
      wx.showToast({ title: '请求失败', icon: 'none' });
    }
  },

  async respondRematch(e) {
    const agree = e.currentTarget.dataset.agree === '1';
    const db = wx.cloud.database();
    try {
      if (agree) {
        this._board = core.emptyBoard();
        this._history = [];
        this._lastMove = null;
        this._winLine = null;
        this._over = false;
        this._leaverHandled = false;
        this._prevWinner = 0;   // 终局→进行中的转换基线
        this.setData({
          stage: 'playing',
          turn: 1,
          moveCount: 0,
          winText: '',
          undoState: null,
          rematchState: null,
          statusText: this.data.myColor === 1 ? '轮到你落子' : '等待对方落子…'
        }, () => this._drawBoard());
        await db.collection(COLLECTION).doc(this._roomId).update({
          data: {
            boardStr: JSON.stringify(this._board),
            history: [],
            turn: 1,
            lastMove: {},
            moveCount: 0,
            winner: 0,
            undoRequest: 0,
            rematchRequest: 0,
            updatedAt: db.serverDate()
          }
        });
        this._boardKey = JSON.stringify(this._board);
        this._seenUndoSide = 0;
        this._seenRematchSide = 0;
        wx.showToast({ title: '新一局开始！黑棋先行', icon: 'none' });
      } else {
        await db.collection(COLLECTION).doc(this._roomId).update({
          data: { rematchRequest: 0, updatedAt: db.serverDate() }
        });
        this.setData({ rematchState: null });
        wx.showToast({ title: '已拒绝', icon: 'none' });
      }
      this._clearRequestTimeout();
    } catch (e2) {
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  /* ========== 戳一戳 + 扔水果 ========== */

  async poke() {
    if (this.data.mode !== 'online' || this.data.stage !== 'playing') return;
    const now = Date.now();
    if (this._lastPokeSent && now - this._lastPokeSent < C.POKE_COOLDOWN) {
      wx.showToast({ title: '戳得太频繁啦', icon: 'none' });
      return;
    }
    this._lastPokeSent = now;
    const db = wx.cloud.database();
    try {
      await db.collection(COLLECTION).doc(this._roomId).update({
        data: { poke: { from: this.data.myColor, ts: now }, updatedAt: db.serverDate() }
      });
    } catch (e) {
      log.e('[gomokuai] poke fail', e);
    }
  },

  _showPoke() {
    if (this._destroyed) return;
    this.setData({ pokeVisible: true, pokeText: '👉 对方戳了戳你：快落子！' });
    clearTimeout(this._pokeTimer);
    this._pokeTimer = setTimeout(() => {
      if (this._destroyed) return;
      this.setData({ pokeVisible: false });
    }, 2500);
  },

  async throwFruit(e) {
    if (this.data.mode !== 'online' || this.data.stage !== 'playing') return;
    const icon = e.currentTarget.dataset.icon;
    if (!icon) return;
    await roomkit.pushChat(this, COLLECTION, {
      from: this.data.myColor, type: 'emoji', content: icon, ts: Date.now()
    });
    this._playEmojiFly(icon);
  },

  _playEmojiFly(icon) {
    if (this._destroyed) return;
    this.setData({ emojiFlying: { icon } });
    clearTimeout(this._emojiFlyTimer);
    this._emojiFlyTimer = setTimeout(() => {
      if (this._destroyed) return;
      this.setData({ emojiFlying: null });
    }, 1200);
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
        this._stopAIThink();
        roomkit.closeWatch(this);
        this._roomId = null;
        this._resetCanvas();
        this.setData({ stage: 'menu' });
      }
    });
  },

  /* ========== 分享 ========== */

  onShareAppMessage() {
    const no = this.data.roomNo;
    return {
      title: no ? '来和我下小笨五子棋！房间号 ' + no : '来小笨游戏大厅一起玩！',
      path: no ? '/subpackages/games/gomokuai/gomokuai?roomNo=' + no : '/pages/games/games'
    };
  },

  /* ========== Canvas ========== */

  // 画布在 wx:if 里，离开对局会被销毁；再进对局必须重新查询节点。
  _resetCanvas() {
    this._canvas = null;
    this._ctx = null;
    this._canvasRetry = 0;
  },

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
