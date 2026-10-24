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
    chatInput: '',

    // 联机互动
    undoState: null,        // null | 'iRequested' | 'oppRequested'
    undoReqSide: 0,         // oppRequested 时的请求方（1红 2黑）
    rematchState: null,     // null | 'iRequested' | 'oppRequested'
    pokeVisible: false,
    pokeText: '',
    emojiFlying: null       // { icon } 飞行动画
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
    // 从分享卡片进入：自动加入房间
    if (this._autoJoin) {
      const no = this._autoJoin;
      this._autoJoin = null;
      this.joinRoom(no);
    }
  },

  onUnload() {
    this._destroyed = true;
    this._aiToken = (this._aiToken || 0) + 1;
    roomkit.sweepTimers(this);
    if (this._thinkTimer) { clearTimeout(this._thinkTimer); this._thinkTimer = null; }
  },

  // 手机横竖屏切换 / 分屏：重算棋盘尺寸并重建 canvas。
  // 不处理的话 CSS 尺寸变了但 canvas 缓冲还是旧值，棋盘会被拉伸或切边。
  onResize() {
    if (this._destroyed) return;
    this._measureBoard();
    this._resetCanvas();
    if (this.data.stage === 'playing' || this.data.stage === 'ended') {
      this._ensureCanvas();
    }
  },

  onHide() {
    // 切后台时停掉 AI 计时器；回来后在 onShow 里继续
    this._paused = true;
    this._stopAIThink();
  },

  onShow() {
    this._paused = false;
    // 后台期间 AI 没下完：回到前台继续思考
    if (!this._destroyed && this.data.stage === 'playing' &&
        this.data.mode === 'ai' && !this._over &&
        this.data.turn !== this.data.mySide) {
      this._aiTurn();
    }
  },

  /* ========== 布局 ========== */

  _measureBoard() {
    // 用安全取值：wx.getWindowInfo 在部分时机返回 null，直接读会崩
    const w = roomkit.getWindowSize().windowWidth;
    const rpx2px = w / 750;
    // 必须与 _ensureCanvas/_drawBoard 同一套几何（左右各留半格 margin），
    // 否则 CSS 高度比画布缓冲高 ~1.4%，整盘被纵向拉伸成微椭圆
    const boardW = Math.floor(w - 48 * rpx2px);
    const margin = boardW / (X.COLS - 1) * 0.5;
    const cell = (boardW - margin * 2) / (X.COLS - 1);
    const boardH = Math.round(cell * (X.ROWS - 1) + margin * 2);
    this._cell = cell;
    this.setData({ boardW, boardH });
  },

  /* ========== 模式选择 ========== */

  pickMode(e) {
    const mode = e.currentTarget.dataset.mode;
    this.setData({ mode });
    if (mode === 'online') {
      this.setData({ stage: 'lobby' });
    } else if (mode === 'ai') {
      // 人机模式先进入难度/执子选择页，不能直接开局
      this.setData({ stage: 'aisetup' });
    } else {
      this._startLocal(mode);
    }
  },

  // 人机设置页：选择难度
  pickDifficulty(e) {
    const d = e.currentTarget.dataset.d;
    const text = d === 'easy' ? '简单' : (d === 'hard' ? '困难' : '普通');
    this.setData({ difficulty: d, difficultyText: text });
  },

  // 人机设置页：选择执红/执黑
  pickSide(e) {
    const s = Number(e.currentTarget.dataset.s);
    this.setData({ mySide: s === 2 ? 2 : 1 });
  },

  // 人机设置页：开始对局
  startAiGame() {
    this.setData({ mode: 'ai' }, () => {
      this._startLocal('ai');
    });
  },

  backToMenu() {
    this._stopAIThink();
    roomkit.closeWatch(this);
    this._roomId = null;
    this._resetCanvas();
    // 联机时 mySide 被设为 2（加入方执黑），回菜单要复位，
    // 否则下次人机设置的「我执」会残留黑方
    this.setData({ stage: 'menu', mySide: X.RED });
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
    // 联机路径（createRoom/joinRoom）不走 _startLocal，这里兜底初始化，
    // 否则 joinRoom / 房主收到对方加入时会 TypeError
    if (!this._positions) this._positions = {};
    const key = X.boardToStr(this._board) + '_' + this.data.turn;
    this._positions[key] = (this._positions[key] || 0) + 1;
  },

  _startLocal(mode) {
    this._stopAIThink();
    this._resetCanvas();
    this._board = X.startBoard();
    this._history = [];
    this._lastMove = null;
    this._over = false;
    this._noCapture = 0;         // 自然限着计数
    this._positions = {};        // 重复局面检测
    // AI 模式：mySide 由 aisetup 页选择（1红先手 / 2黑后手）
    const mySide = mode === 'ai' ? this.data.mySide : X.RED;
    const aiFirst = mode === 'ai' && mySide === X.BLACK;
    this.setData({
      stage: 'playing',
      turn: X.RED,
      mySide,
      statusText: aiFirst ? 'AI 思考中…' : '红方走棋',
      winText: '',
      thinking: false,
      oppName: mode === 'ai' ? ('AI · ' + this.data.difficultyText) : '黑方',
      metaText: mode === 'ai' ? ('人机 · ' + this.data.difficultyText) : ''
    }, () => {
      this._notePosition();      // 初始局面也要计入，否则三次回到初始不判和
      this._ensureCanvas();
      // 我执黑 → AI（红）先走
      if (aiFirst) this._aiTurn();
    });
  },

  // 重开：联机走「双方确认」（requestRematch）；同屏/人机直接重开
  restart() {
    if (this.data.mode === 'online') {
      this.requestRematch();
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
      // 房主侧也要初始化对局状态：对方加入时 _onRoomUpdate 会立刻
      // _notePosition，未初始化会 TypeError，房主永远卡在等待页
      this._board = X.startBoard();
      this._history = [];
      this._over = false;
      this._noCapture = 0;
      this._positions = {};
      this._leaverHandled = false;
      this._prevWinner = 0;   // 终局→进行中的转换基线
      this.setData({ stage: 'waiting', roomNo: res.roomNo, mySide: X.RED });
      this._startWatch();
    } catch (err) {
      log.e('[xiangqi] createRoom fail', err);
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
      this._noCapture = 0;
      this._positions = {};
      this._leaverHandled = false;
      this._prevWinner = 0;   // 终局→进行中的转换基线
      this._notePosition();
      this._resetCanvas();
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
    const me = this.data.mySide;

    // 房主在等待页：对方加入后开局
    if (this.data.stage === 'waiting') {
      if (room.status === 'playing') {
        // 注意：这里不能 closeWatch。房主需要继续接收 guest 的走棋，
        // 关掉 watcher 会导致开局后只有 guest 能看到 host 的棋。
        this._board = X.strToBoard(room.boardStr);
        this._history = room.history || [];
        this._over = false;
        this._noCapture = 0;
        this._positions = {};
        this._leaverHandled = false;
        this._prevWinner = 0;   // 终局→进行中的转换基线
        this._notePosition();
        this._resetCanvas();
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

    // 对方离开：弹窗告知（比静默切结算屏友好），确认后回菜单
    if (room.status === 'ended' && room.leaver && room.leaver !== me && !this._leaverHandled) {
      this._leaverHandled = true;
      this._over = true;
      roomkit.closeWatch(this);
      this._stopAIThink();
      this.setData({ stage: 'ended', winText: '对方已离开，对局结束', statusText: '对局结束' });
      wx.showModal({
        title: '对方已离开',
        content: '对局已结束，回到大厅吧',
        showCancel: false,
        confirmText: '回到大厅',
        success: () => {
          this._roomId = null;
          this._resetCanvas();
          this.setData({ stage: 'menu', mySide: X.RED, chatList: [] });
        }
      });
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
      // winner: 1红 2黑 3和（3 是 _doMove 判和时同步的哨兵值）
      patch.winText = room.winner === 3 ? '🤝 和棋' : (room.winner === me ? '🎉 你赢了！' : '😢 对方获胜');
      patch.statusText = '对局结束';
    } else {
      // 终局后退回「进行中」：对方同意悔棋/再来一局会把 winner 清 0。
      // 请求方自己不发请求也不写盘，只靠这里恢复，否则会一直卡在结算屏
      // （棋盘已经恢复却还盖着「对局结束」浮层，再点重开就重复请求）
      if (this.data.stage === 'ended' && (this._prevWinner || 0) !== 0) {
        this._over = false;
        this._leaverHandled = false;
        this._prevWinner = 0;   // 终局→进行中的转换基线
        patch.stage = 'playing';
        patch.winText = '';
      }
      patch.statusText = room.turn === me ? '轮到你走棋' : '等待对方走棋…';
    }
    this._prevWinner = room.winner || 0;
    patch.selectedText = '';
    this.setData(patch, () => { if (changed) this._drawBoard(); });

    // 悔棋请求：对方发起 → 弹确认；自己发起 → 等待态；
    // 被 clear（0）→ 自己的等待态解除
    if (room.undoRequest && room.undoRequest !== me) {
      if ((this._seenUndoSide || 0) !== room.undoRequest && this.data.stage === 'playing') {
        this._seenUndoSide = room.undoRequest;
        this.setData({ undoState: 'oppRequested', undoReqSide: room.undoRequest });
        wx.showModal({
          title: '对方请求悔棋',
          content: '同意撤回对方的上一手吗？',
          confirmText: '同意',
          cancelText: '拒绝',
          success: (res) => {
            // 弹窗期间页面可能已卸载 / 局面已变（对方离开、重开）
            if (this._destroyed) return;
            if (this.data.stage !== 'playing') return;
            this.respondUndo({ currentTarget: { dataset: { agree: res.confirm ? '1' : '0' } } });
          }
        });
      }
    } else if (room.undoRequest === me) {
      if (this.data.undoState !== 'iRequested') this.setData({ undoState: 'iRequested' });
    } else {
      // undoRequest 归零：自己的等待态解除（对方已处理）
      if (this.data.undoState === 'iRequested') {
        this.setData({ undoState: null });
        this._clearRequestTimeout();
      } else if (this.data.undoState === 'oppRequested') {
        this.setData({ undoState: null });
      }
      this._seenUndoSide = 0;
    }

    // 再来一局请求：对方发起 → 弹确认；自己发起 → 等待态
    if (room.rematchRequest && room.rematchRequest !== me) {
      if ((this._seenRematchSide || 0) !== room.rematchRequest) {
        this._seenRematchSide = room.rematchRequest;
        this.setData({ rematchState: 'oppRequested' });
        wx.showModal({
          title: '对方请求再来一局',
          content: '回到初始局面重新开始？',
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

    // 戳一戳：ts 严格大于上次才触发（同一戳不重复弹）
    if (room.poke && room.poke.from && room.poke.from !== me) {
      const ts = room.poke.ts || 0;
      if (ts > (this._lastPokeTs || 0)) {
        this._lastPokeTs = ts;
        this._showPoke();
      }
    }

    // 聊天
    const merged = roomkit.mergeChat(this.data.chatList, room.chat || [], me);
    if (merged.list.length !== this.data.chatList.length || merged.addedNew) {
      this.setData({ chatList: merged.list });
      // 对方扔的水果：播飞行动画
      if (merged.addedNew && merged.addedNew.type === 'emoji' && merged.addedNew.from !== me) {
        this._playEmojiFly(merged.addedNew.content);
      }
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
    // applyMove 返回 { captured } 对象：必须取 .captured，
    // 否则 history 里存的和 undoMove 还原的都是对象，悔棋直接损坏棋盘
    const res = X.applyMove(this._board, mv);
    const captured = res.captured;
    const turn = this.data.turn;
    const next = turn === X.RED ? X.BLACK : X.RED;
    this._history.push({ from: mv.from, to: mv.to, captured });
    this._lastMove = mv;
    this._selected = null;
    if (captured) this._noCapture = 0; else this._noCapture++;

    // isMate = 无合法着法，将死与困毙都算负（页面提示也写了「困毙同样判负」），
    // 不能用 isCheck && isMate 把困毙短路掉，否则困毙方永远无着可走、对局挂死
    const isCheck = X.isInCheck(this._board, next);
    const mate = X.isMate(this._board, next);
    const moveCount = this._history.length;

    this.setData({ selectedText: '', turn: next, moveCount }, () => this._drawBoard());

    // 和棋判定放在 _syncMove 之前：判和结果要通过 winner=3 同步给对方，
    // 否则只有本地判和，对方继续下、棋盘在「对局结束」横幅下还在变
    const naturalDraw = !mate && this._noCapture >= C.XQ_MAX_NO_CAPTURE;
    let repeatDraw = false;
    if (!mate && !naturalDraw) {
      this._notePosition();
      repeatDraw = this._positions[X.boardToStr(this._board) + '_' + this.data.turn] >= 3;
    }

    if (this.data.mode === 'online') {
      this._syncMove(mv, mate ? turn : (naturalDraw || repeatDraw ? 3 : 0), moveCount, isCheck);
    }

    if (mate) {
      this._over = true;
      const winText = this.data.mode === 'local'
        ? (turn === X.RED ? '🎉 红方获胜' : '⚫ 黑方获胜')
        : (turn === this.data.mySide ? '🎉 你赢了' : '😢 对方获胜');
      this.setData({
        stage: 'ended',
        winText: winText + (isCheck ? '！' : '（困毙）'),
        statusText: '对局结束'
      });
      return;
    }

    if (naturalDraw) {
      this._over = true;
      this.setData({ stage: 'ended', winText: '🤝 和棋（自然限着）', statusText: '对局结束' });
      return;
    }

    if (repeatDraw) {
      this._over = true;
      this.setData({ stage: 'ended', winText: '🤝 和棋（三次重复局面）', statusText: '对局结束' });
      return;
    }

    if (this.data.mode === 'ai' && next !== this.data.mySide) {
      this._aiTurn();
      return;
    }

    // 将军提示要按「被将的是谁」说：轮到我走时被将的是我，不是对方
    const checkText = this.data.mode === 'local'
      ? (next === X.RED ? '⚠️ 红方被将军！' : '⚠️ 黑方被将军！')
      : (next === this.data.mySide ? '⚠️ 你被将军！' : '⚠️ 对方被将军！');
    this.setData({
      statusText: isCheck ? checkText : (next === this.data.mySide ? '轮到你走棋' : '等待对方走棋…')
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

  // 停掉正在进行的 AI 思考。token 让已经进入回调的旧计时器失效，
  // 避免「重开/悔棋/离开时 AI 还把棋子下到新棋盘上」。
  _stopAIThink(resetUI) {
    this._aiToken = (this._aiToken || 0) + 1;
    if (this._thinkTimer) {
      clearTimeout(this._thinkTimer);
      this._thinkTimer = null;
    }
    if (resetUI !== false && this.data.thinking) this.setData({ thinking: false });
  },

  _aiTurn() {
    if (this._destroyed || this._over || this._paused) return;
    if (this._thinkTimer) return;   // 已经在思考，别重复排程
    this._aiToken = (this._aiToken || 0) + 1;
    const token = this._aiToken;
    // 思考状态放顶部信息条（statusText），棋盘中央不放遮罩挡棋盘
    this.setData({ thinking: true, statusText: 'AI 思考中…' });
    // 搜索跑在副本上：万一搜索中途抛异常，真实棋盘不会被半改状态搞坏
    const board = this._board.slice();
    const side = this.data.turn;
    const difficulty = this.data.difficulty;

    this._thinkTimer = setTimeout(() => {
      this._thinkTimer = null;
      if (token !== this._aiToken) return;   // 已被重开/悔棋/离开作废
      if (this._destroyed || this._over || this._paused) return;
      let mv = null;
      try {
        mv = ai.think(board, side, difficulty, { budgetMs: C.XQ_AI_BUDGET_MS });
      } catch (err) {
        log.e('[xiangqi] ai think fail', err);
      }
      if (token !== this._aiToken) return;
      this.setData({ thinking: false });
      if (!mv) return;
      this._doMove(mv);
    }, C.XQ_AI_THINK_MS);
  },

  /* ========== 联机悔棋 / 重开（双方确认） ========== */

  _armRequestTimeout(stateKey) {
    this._clearRequestTimeout();
    this._requestTimeoutKey = stateKey;
    this._undoTimeoutTimer = setTimeout(() => {
      if (this._destroyed) return;
      this.setData({ [stateKey]: null });
      wx.showToast({ title: '对方未响应', icon: 'none' });
    }, C.XQ_MOVE_TIMEOUT_MS);
  },

  _clearRequestTimeout() {
    if (this._undoTimeoutTimer) {
      clearTimeout(this._undoTimeoutTimer);
      this._undoTimeoutTimer = null;
    }
    this._requestTimeoutKey = null;
  },

  async requestUndo() {
    if (this.data.mode !== 'online') { this.undo(); return; }
    if (this.data.stage !== 'playing' || this._over) return;
    if (this.data.undoState) return;   // 已有一个在途请求
    if (!this._history.length) {
      wx.showToast({ title: '还没走棋，无棋可悔', icon: 'none' });
      return;
    }
    const db = wx.cloud.database();
    try {
      await db.collection(COLLECTION).doc(this._roomId).update({
        data: { undoRequest: this.data.mySide, updatedAt: db.serverDate() }
      });
      this.setData({ undoState: 'iRequested' });
      this._armRequestTimeout('undoState');
    } catch (e) {
      log.e('[xiangqi] requestUndo fail', e);
      wx.showToast({ title: '请求失败', icon: 'none' });
    }
  },

  async respondUndo(e) {
    const agree = e.currentTarget.dataset.agree === '1';
    const db = wx.cloud.database();
    try {
      if (agree) {
        // 撤销到「请求方上一步之前」：从 history 尾部弹着法，
        // 直到弹掉了请求方的那一手（history[0] 是红方第一手，
        // history.length 奇数 = 最后一手是红方走的）。
        const reqSide = this.data.undoReqSide;
        const history = this._history.slice();
        let popped = 0;
        while (history.length) {
          const moverOf = (history.length % 2 === 1) ? X.RED : X.BLACK;
          const last = history[history.length - 1];
          const mv = { from: last.from, to: last.to };
          X.undoMove(this._board, mv, last.captured);
          history.pop();
          popped += 1;
          if (moverOf === reqSide) break;   // 弹掉了请求方的那一手，停
        }
        const prevLast = history.length ? history[history.length - 1] : null;
        // 本地 history 必须同步为弹后的版本：不然响应方自己的棋盘/轮次
        // 与刚写进文档的不一致（对端靠 boardStr 重建，自己却留着旧的）
        this._history = history;
        this._over = false;
        this._noCapture = 0;
        this._positions = {};
        this._selected = null;
        this._lastMove = prevLast
          ? { from: prevLast.from, to: prevLast.to }
          : null;
        // 悔棋发生在已分出胜负之后：双方都要回到对局中
        const backTurn = reqSide;
        this.setData({
          stage: 'playing',
          turn: backTurn,
          winText: '',
          undoState: null,
          statusText: backTurn === this.data.mySide ? '轮到你走棋' : '等待对方走棋…'
        }, () => {
          this._notePosition();
          this._drawBoard();
        });
        await db.collection(COLLECTION).doc(this._roomId).update({
          data: {
            boardStr: X.boardToStr(this._board),
            history,
            turn: backTurn,
            moveCount: history.length,
            lastMove: prevLast ? { from: prevLast.from, to: prevLast.to } : {},
            undoRequest: 0,
            winner: 0,
            updatedAt: db.serverDate()
          }
        });
        this._boardKey = X.boardToStr(this._board);
        this._seenUndoSide = 0;
        wx.showToast({ title: '已同意悔棋（撤 ' + popped + ' 手）', icon: 'none' });
      } else {
        await db.collection(COLLECTION).doc(this._roomId).update({
          data: { undoRequest: 0, updatedAt: db.serverDate() }
        });
        this.setData({ undoState: null });
        wx.showToast({ title: '已拒绝', icon: 'none' });
      }
      this._clearRequestTimeout();
    } catch (e2) {
      log.e('[xiangqi] respondUndo fail', e2);
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  async requestRematch() {
    if (this.data.mode !== 'online') { this.restart(); return; }
    if (this.data.rematchState) return;
    const db = wx.cloud.database();
    try {
      await db.collection(COLLECTION).doc(this._roomId).update({
        data: { rematchRequest: this.data.mySide, updatedAt: db.serverDate() }
      });
      this.setData({ rematchState: 'iRequested' });
      this._armRequestTimeout('rematchState');
    } catch (e) {
      log.e('[xiangqi] requestRematch fail', e);
      wx.showToast({ title: '请求失败', icon: 'none' });
    }
  },

  async respondRematch(e) {
    const agree = e.currentTarget.dataset.agree === '1';
    const db = wx.cloud.database();
    try {
      if (agree) {
        // 重开 = 回初始局面（悔棋里已封装好全套本地复位，借它一步到位）
        this._board = X.startBoard();
        this._history = [];
        this._lastMove = null;
        this._over = false;
        this._noCapture = 0;
        this._positions = {};
        this._selected = null;
        this._leaverHandled = false;
        this._prevWinner = 0;   // 终局→进行中的转换基线
        const backTurn = X.RED;
        this.setData({
          stage: 'playing',
          turn: backTurn,
          winText: '',
          rematchState: null,
          undoState: null,
          statusText: backTurn === this.data.mySide ? '轮到你走棋' : '等待对方走棋…'
        }, () => {
          this._notePosition();
          this._drawBoard();
        });
        await db.collection(COLLECTION).doc(this._roomId).update({
          data: {
            boardStr: X.boardToStr(this._board),
            history: [],
            turn: X.RED,
            moveCount: 0,
            lastMove: {},
            winner: 0,
            undoRequest: 0,
            rematchRequest: 0,
            updatedAt: db.serverDate()
          }
        });
        this._boardKey = X.boardToStr(this._board);
        this._seenUndoSide = 0;
        wx.showToast({ title: '新一局开始！红方先行', icon: 'none' });
      } else {
        await db.collection(COLLECTION).doc(this._roomId).update({
          data: { rematchRequest: 0, updatedAt: db.serverDate() }
        });
        this.setData({ rematchState: null });
        wx.showToast({ title: '已拒绝', icon: 'none' });
      }
      this._clearRequestTimeout();
    } catch (e2) {
      log.e('[xiangqi] respondRematch fail', e2);
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  /* ========== 戳一戳 + 扔水果（联机） ========== */

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
        data: { poke: { from: this.data.mySide, ts: now }, updatedAt: db.serverDate() }
      });
    } catch (e) {
      log.e('[xiangqi] poke fail', e);
    }
  },

  _showPoke() {
    if (this._destroyed) return;
    this.setData({ pokeVisible: true, pokeText: '👉 对方戳了戳你：快走棋！' });
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
    // 走聊天通道（roomkit.pushChat 自带乐观更新与去重）
    await roomkit.pushChat(this, COLLECTION, {
      from: this.data.mySide, type: 'emoji', content: icon, ts: Date.now()
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

  /* ========== 悔棋（同屏 / 人机：直接悔） ========== */

  // 悔棋入口：联机走「双方确认」（requestUndo）；同屏/人机直接悔
  undo() {
    if (this.data.mode === 'online') {
      this.requestUndo();
      return;
    }
    if (!this._history.length) {
      wx.showToast({ title: '无棋可悔', icon: 'none' });
      return;
    }
    if (this.data.mode === 'online') {
      wx.showToast({ title: '联机模式悔棋需实现双方确认，暂不支持', icon: 'none' });
      return;
    }
    // 如果 AI 正在思考，先停掉，避免它把棋子下到悔棋后的棋盘上
    this._stopAIThink();
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
    this._noCapture = 0;         // 悔棋后重置自然限着
    this._positions = {};        // 重复局面也从当前局面重新计
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
      thinking: false,
      statusText: '轮到你走棋'
    }, () => {
      this._notePosition();
      this._drawBoard();
      // 极端情况下悔棋后轮到 AI（例如悔到 AI 的回合），继续让它走
      if (this.data.mode === 'ai' && this.data.turn !== this.data.mySide) this._aiTurn();
    });
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
        this._stopAIThink();
        roomkit.closeWatch(this);
        this._roomId = null;
        this._resetCanvas();
        this.setData({ stage: 'menu', mySide: X.RED });
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

  // 画布在 wx:if 里，离开对局会被销毁；再进对局必须重新查询节点，
  // 否则 _ctx 指向旧节点，新棋盘永远空白。
  _resetCanvas() {
    this._canvas = null;
    this._ctx = null;
    this._canvasRetry = 0;
  },

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
    let c = Math.round((x - ox) / cell);
    let r = Math.round((y - oy) / cell);
    if (r < 0 || r >= X.ROWS || c < 0 || c >= X.COLS) return null;
    // 黑方视角：屏幕坐标反翻转回逻辑坐标（绘制时 180° 旋转过，点击要转回来）
    if (this.data.mySide === X.BLACK) {
      r = X.ROWS - 1 - r;
      c = X.COLS - 1 - c;
    }
    return { r, c, idx: X.idx(r, c) };
  },

  _drawBoard() {
    const ctx = this._ctx;
    if (!ctx || !this._board) return;
    // 用 _ensureCanvas 里确定的尺寸，不能用 this.data.boardW（两者可能不一致）
    const W = this._bw || this.data.boardW, H = this._bh || this.data.boardH;
    if (!W || !H) return;

    // ==== 视角翻转 ====
    // 执黑方（mySide=2）看到的棋盘要 180° 翻转：自己的黑棋在下方、
    // 红棋在上方。翻转只影响绘制/命中，不碰 _board 的真实存储。
    // flip() 把逻辑坐标 (r,c) 映射到屏幕坐标，所有绘制点统一过它换算。
    const flipped = this.data.mySide === X.BLACK;
    const flip = (r, c) => flipped ? { r: X.ROWS - 1 - r, c: X.COLS - 1 - c } : { r, c };
    const sx = (c) => ox + c * cell;   // 屏幕像素
    const sy = (r) => oy + r * cell;

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

    // 棋子（屏幕坐标过 flip()：黑方视角下 180° 旋转）
    const radius = cell * 0.42;
    for (let i = 0; i < this._board.length; i++) {
      const p = this._board[i];
      if (!p) continue;
      const pos = flip(X.rowOf(i), X.colOf(i));
      const x = sx(pos.c), y = sy(pos.r);
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
      const sp = flip(X.rowOf(this._selected), X.colOf(this._selected));
      ctx.beginPath();
      ctx.arc(sx(sp.c), sy(sp.r), radius * 1.25, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#FF5A5F';
      ctx.stroke();

      // 可走点提示
      const moves = X.legalMovesFrom(this._board, this._selected);
      for (const m of moves) {
        const mp = flip(X.rowOf(m.to), X.colOf(m.to));
        ctx.beginPath();
        ctx.arc(sx(mp.c), sy(mp.r), radius * 0.3, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,90,95,0.55)';
        ctx.fill();
      }
    }

    // 最后一手标记（起点圈 + 终点圈）
    // 必须加 ox/oy 偏移，与棋盘同一坐标系，否则标记会整体偏移一个 margin
    if (this._lastMove && this._lastMove.from !== undefined) {
      const fp = flip(X.rowOf(this._lastMove.from), X.colOf(this._lastMove.from));
      const tp = flip(X.rowOf(this._lastMove.to), X.colOf(this._lastMove.to));
      ctx.strokeStyle = '#2980B9';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx(fp.c), sy(fp.r), radius * 0.9, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(sx(tp.c), sy(tp.r), radius * 0.9, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
});
