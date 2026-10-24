// 小笨五子棋 · 云开发房间联机
// 集合：gomoku_rooms
// 双方 watch 同一房间文档驱动同步

const COLLECTION = 'gomoku_rooms';
const SIZE = 15; // 15x15 棋盘
// 注意：分包里引用主包 utils 要往上三级（subpackages/games/gomoku → 根目录）
const C = require('../../../utils/constants.js');
const log = require('../../../utils/log.js');
const roomkit = require('../../../utils/roomkit.js');

const AVATARS = ['/assets/avatar_a.gif', '/assets/avatar_b.gif'];

function emptyBoard() {
  const b = [];
  for (let i = 0; i < SIZE; i++) b.push(new Array(SIZE).fill(0));
  return b;
}

// 棋盘字符串序列化/反序列化：只在棋盘真的变了时才重绘
function boardKeyOf(room) {
  return room && room.boardStr ? room.boardStr : '';
}

// 安全返回游戏大厅。
// 不能写成 navigateBack({ fail: () => switchTab(...) })：
// navigateBack 失败时基础库仍在收尾路由，立刻 switchTab 会让
// routeDone 找不到已销毁的 webview，报
// "routeDone with a webviewId N is not found"。
function safeBackToLobby() {
  var stackLen = 1;
  try {
    var pages = getCurrentPages();
    stackLen = pages ? pages.length : 1;
  } catch (e) {
    stackLen = 1;
  }
  if (stackLen > 1) {
    wx.navigateBack({
      fail: function () {
        setTimeout(function () { wx.switchTab({ url: '/pages/games/games' }); }, 60);
      }
    });
  } else {
    wx.switchTab({
      url: '/pages/games/games',
      fail: function () { wx.reLaunch({ url: '/pages/games/games' }); }
    });
  }
}

// 联机棋盘解析：损坏/旧版本的 boardStr 不能把同步回调炸掉（同 gomokuai）
function parseBoardStr(s) {
  if (!s) return emptyBoard();
  try {
    const b = JSON.parse(s);
    if (Array.isArray(b) && b.length === SIZE) {
      for (let r = 0; r < SIZE; r++) {
        if (!Array.isArray(b[r]) || b[r].length !== SIZE) return emptyBoard();
      }
      return b;
    }
  } catch (e) {
    log.e('[gomoku] boardStr 解析失败，已回退空盘', e);
  }
  return emptyBoard();
}

function asHistory(v) {
  return Array.isArray(v) ? v : [];
}

Page({
  data: {
    stage: 'lobby',          // lobby | waiting | playing | ended
    roomNoInput: '',
    roomNo: '',
    myColor: 0,              // 1黑 2白
    myColorText: '',
    myAvatar: '',
    oppAvatar: '',
    turn: 1,
    isMyTurn: false,
    statusText: '',
    winner: 0,
    winText: '',
    lastMove: {},
    moveCount: 0,
    round: 1,                // 第几局（由云文档回读）
    // 悔棋
    undoState: null,         // null | 'iRequested' | 'oppRequested'
    // 戳一戳
    pokeVisible: false,
    pokeText: '',
    // 再来一局
    rematchState: null,      // null | 'iRequested' | 'oppRequested'
    // 申请先手
    firstState: null,        // null | 'iRequested' | 'oppRequested'
    // 聊天
    chatList: [],            // [{from, type, content, ts, mine}]
    chatInput: '',
    showEmojiPanel: false,
    emojis: [
      { key: 'egg',   icon: '🥚', label: '扔鸡蛋' },
      { key: 'melon', icon: '🍉', label: '扔西瓜' },
      { key: 'durian',icon: '🍈', label: '扔榴莲' },
      { key: 'berry', icon: '🍓', label: '扔草莓' },
      { key: 'ginseng',icon:'🫐', label: '扔蓝莓' }
    ],
    emojiFlying: null,       // { icon } 当前飞行动画
    boardW: 300              // canvas 尺寸（px），onReady 时计算
  },

  onLoad(options) {
    // 从分享卡片进入：自动加入房间
    if (options && options.roomNo) {
      this.setData({ roomNoInput: String(options.roomNo) });
      this._autoJoin = String(options.roomNo);
    }
  },

  onReady() {
    // 计算棋盘尺寸：屏幕宽度 - 页面左右边距 24rpx*2 - board-wrap 内边距 20rpx*2
    // wx.getWindowInfo() 在部分时机返回 null，需防御
    let sys = null;
    try {
      sys = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    } catch (e) {
      sys = null;
    }
    const w = (sys && typeof sys.windowWidth === 'number' && sys.windowWidth > 0) ? sys.windowWidth : 375;
    // rpx 转 px：1rpx = w/750 px
    const rpx2px = w / 750;
    const boardW = Math.floor(w - 88 * rpx2px); // 24*2 + 20*2 = 88rpx
    this._boardW = boardW;
    this.setData({ boardW });
    log.d('[gomoku] onReady boardW=' + boardW + ' screenW=' + w);
    if (this._autoJoin) {
      const no = this._autoJoin;
      this._autoJoin = null;
      this.joinRoom(no);   // 显式传参，避免依赖 setData 异步 flush 后的 this.data
    }
  },

  onUnload() {
    this._destroyed = true;
    this._closeWatcher();
    // 统一清理所有定时器，避免回调对已卸载页面 setData
    ['_waitPollTimer', '_pokeTimer', '_emojiFlyTimer', '_canvasRetryTimer', '_undoTimeoutTimer'].forEach(k => {
      if (this[k]) { clearTimeout(this[k]); this[k] = null; }
    });
    if (this._waitPollInterval) { clearInterval(this._waitPollInterval); this._waitPollInterval = null; }
  },

  /* ========== 大厅操作 ========== */

  onRoomNoInput(e) {
    this.setData({ roomNoInput: String(e.detail.value).replace(/\D/g, '').slice(0, 4) });
  },

  async createRoom() {
    if (this._creating) return;
    this._creating = true;
    wx.showLoading({ title: '创建中…', mask: true });
    try {
      const db = wx.cloud.database();
      // 房间号查重：撞号时重试，避免加入者进错房间
      let roomNo = '', tries = 0;
      while (tries++ < 5) {
        roomNo = String(Math.floor(Math.random() * (C.ROOM_NO_MAX + 1))).padStart(4, '0');
        const dup = await db.collection(COLLECTION).where({ roomNo }).limit(1).get();
        if (!dup.data || !dup.data.length) break;
      }
      // 随机双方形象：房主拿一个，对方拿另一个
      const myAvatarIdx = Math.random() < 0.5 ? 0 : 1;
      const doc = {
        roomNo,
        status: 'waiting',
        avatars: { black: AVATARS[myAvatarIdx], white: AVATARS[1 - myAvatarIdx] },
        boardStr: JSON.stringify(emptyBoard()),
        history: [],           // 落子历史 [{r,c,color}]，支持连续悔棋
        turn: 1,
        lastMove: {},          // 空对象占位，避免 null → object 类型冲突
        winner: 0,
        moveCount: 0,
        undoRequest: 0,        // 0无 1黑请求 2白请求
        rematchRequest: 0,
        firstRequest: 0,       // 申请先手：0无 1黑请求 2白请求
        chat: [],              // 聊天记录 [{from:1|2, type:'text'|'emoji', content, ts}]
        poke: {},              // { from: 1|2, ts }
        round: 1,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      };
      const res = await db.collection(COLLECTION).add({ data: doc });
      this._roomId = res._id;
      this._resetCanvas();
      this.setData({
        stage: 'waiting',
        roomNo,
        myColor: 1,
        myColorText: '⚫ 黑棋（先手）',
        myAvatar: AVATARS[myAvatarIdx],
        oppAvatar: AVATARS[1 - myAvatarIdx],
        statusText: '等待好友加入…'
      });
      this._startWatch();
      // 轮询兜底：防止 watch 延迟导致创建者卡在等待页
      if (this._waitPollInterval) clearInterval(this._waitPollInterval);
      this._waitPollInterval = setInterval(() => this._pollRoomStatus(), 2000);
    } catch (err) {
      log.e('createRoom fail', err);
      wx.showToast({ title: '创建失败，请检查云环境', icon: 'none' });
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
      const db = wx.cloud.database();
      // 统一走 roomkit：单字段查询（不依赖复合索引）+ 24h 过期过滤
      // + 权限/集合不存在的中文提示。
      const room = await roomkit.findJoinableRoom(COLLECTION, roomNo);
      if (!room) return;
      this._roomId = room._id;
      this._isJoiner = true;
      await db.collection(COLLECTION).doc(this._roomId).update({
        data: {
          status: 'playing',
          turn: 1,
          updatedAt: db.serverDate()
        }
      });
      this._resetCanvas();
      this.setData({
        stage: 'playing',
        roomNo: room.roomNo || roomNo,
        myColor: 2,
        myColorText: '⚪ 白棋（后手）',
        myAvatar: room.avatars.white,
        oppAvatar: room.avatars.black,
        turn: 1,
        isMyTurn: false,
        statusText: '等待对方落子…',
        moveCount: room.moveCount || 0,
        round: room.round || 1,
        lastMove: room.lastMove || {}
      }, () => {
        this._board = parseBoardStr(room.boardStr);
        this._history = asHistory(room.history);
        this._ensureCanvas();
      });
      this._startWatch();
    } catch (err) {
      console.error('joinRoom fail', err);
      const hint = roomkit.joinErrorText(err);
      wx.showToast({ title: hint || ('加入失败：' + (err.errMsg || '未知错误')), icon: 'none', duration: 3000 });
    } finally {
      wx.hideLoading();
      this._joining = false;
    }
  },

  /* ========== Watch 同步 ========== */

  _startWatch(isRetry) {
    this._closeWatcher();
    const db = wx.cloud.database();
    if (!isRetry) this._watchRetry = 0;   // 重连保留计数，避免无限重试
    this._pollKey = null;
    try {
      this._watcher = db.collection(COLLECTION).doc(this._roomId).watch({
        onChange: (snapshot) => {
          this._watchRetry = 0;
          const docs = snapshot.docs;
          if (!docs || !docs.length) return;
          const key = JSON.stringify(docs[0]);
          if (key === this._pollKey) return;
          this._pollKey = key;
          this._onRoomUpdate(docs[0]);
        },
        onError: (err) => {
          log.e('watch error', err);
          this._watcher = null;
          this._usingPoll = true;
          // 指数退避重连；轮询一直在跑，watch 不可用也不会卡住
          if (this._watchRetry < 3) {
            this._watchRetry += 1;
            const delay = Math.pow(2, this._watchRetry) * 1000;
            if (this._watchRetryTimer) clearTimeout(this._watchRetryTimer);
            this._watchRetryTimer = setTimeout(() => {
              if (this._destroyed || !this._roomId) return;
              this._startWatch(true);
            }, delay);
          }
        }
      });
    } catch (err) {
      // 部分基础库/开发者工具不支持实时推送
      log.e('watch unsupported', err);
      this._watcher = null;
      this._usingPoll = true;
    }

    // 无条件轮询兜底：watch 正常时按 _pollKey 去重，几乎零开销。
    // watch 在开发者工具里可能返回 reportRealtimeAction:fail not support，
    // 没有这条轮询就会「双方都看不到对方动」。
    // 用串行自调度，避免 get 慢时多个请求重叠、旧响应覆盖新状态。
    this._startPolling();
  },

  _startPolling(delay) {
    if (this._pollTimer) clearTimeout(this._pollTimer);
    this._pollTimer = setTimeout(async () => {
      this._pollTimer = null;
      if (this._destroyed) return;
      await this._pollRoomStatus();
      if (this._destroyed) return;
      this._startPolling(200);
    }, delay || 0);
  },

  _closeWatcher() {
    if (this._watchRetryTimer) {
      clearTimeout(this._watchRetryTimer);
      this._watchRetryTimer = null;
    }
    if (this._watcher) {
      try { this._watcher.close(); } catch (e) {}
      this._watcher = null;
    }
    if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; }
    ['_waitPollInterval', '_watchPollInterval'].forEach(k => {
      if (this[k]) { clearInterval(this[k]); this[k] = null; }
    });
    this._pollKey = null;
  },

  // 轮询兜底：watch 延迟/断链时也能及时同步（等待页与对局中都可用）
  async _pollRoomStatus() {
    if (this._destroyed || !this._roomId) return;
    try {
      const db = wx.cloud.database();
      const res = await db.collection(COLLECTION).doc(this._roomId).get();
      const room = res.data;
      if (!room) return;
      const key = JSON.stringify(room);
      if (key === this._pollKey) return;
      this._pollKey = key;
      if (room.status === 'playing' && this.data.stage === 'waiting') {
        this._onRoomUpdate(room);
      } else if (this.data.stage === 'playing' || this.data.stage === 'ended') {
        // ended 也要喂给 _onRoomUpdate：再来一局的复位、对方离开的提示
        // 都在 stage==='ended' 时到达；watch 挂掉只靠轮询时会漏掉
        this._onRoomUpdate(room);
      }
    } catch (e) {
      log.e('poll fail', e);
    }
  },

  _onRoomUpdate(room) {
    let me = this.data.myColor;

    // 检测先后手互换（仅在对局中且非初始 join 时检测）
    if (this.data.stage !== 'waiting' && !this._isJoiner &&
        room.avatars && this.data.myAvatar && room.avatars.black && room.avatars.white) {
      const myCurrentAvatar = me === 1 ? room.avatars.black : room.avatars.white;
      if (myCurrentAvatar !== this.data.myAvatar) {
        me = me === 1 ? 2 : 1;
        const newMyAvatar = me === 1 ? room.avatars.black : room.avatars.white;
        const newOppAvatar = me === 1 ? room.avatars.white : room.avatars.black;
        this.setData({
          myColor: me,
          myColorText: me === 1 ? '⚫ 黑棋（先手）' : '⚪ 白棋（后手）',
          myAvatar: newMyAvatar,
          oppAvatar: newOppAvatar
        });
        wx.showToast({ title: '先后手已交换', icon: 'none' });
      }
    }
    // 首次 join 标记只跳过一次
    if (this._isJoiner) this._isJoiner = false;

    // 首次收到完整房间数据（房主在 waiting 阶段）
    if (this.data.stage === 'waiting') {
      if (room.status === 'playing') {
        // 不能关闭 watcher：开局后还要继续接收对方落子。
        // 关掉后只有本端能写、看不到对方，联机会变成各下各的。
        const turnNow = room.turn || 1;
        // 棋盘先就位再切 stage：setData 的数据立即生效而回调晚一帧，
        // 期间若用户点了棋盘，_board 还没建好会直接抛错
        this._board = parseBoardStr(room.boardStr);
        this._history = asHistory(room.history);
        // 开局了就停掉等待页的 2 秒轮询，200ms 串行轮询已在跑
        if (this._waitPollInterval) {
          clearInterval(this._waitPollInterval);
          this._waitPollInterval = null;
        }
        this._resetCanvas();
        this.setData({
          stage: 'playing',
          turn: turnNow,
          isMyTurn: turnNow === me,
          round: room.round || 1,
          statusText: turnNow === me ? '轮到你落子' : '等待对方落子…'
        }, () => {
          this._ensureCanvas();
        });
      }
      return;
    }

    // 对局中的更新
    const patch = {
      turn: room.turn,
      lastMove: room.lastMove,
      winner: room.winner,
      moveCount: room.moveCount || 0,
      round: room.round || this.data.round,
      isMyTurn: room.turn === me
    };

    // 棋盘变化：boardStr 反序列化。只有棋盘真的变了才重绘，
    // 否则一条聊天消息/戳一戳都会触发全画布重绘（渐变底 + 225 个棋子）
    const newBoardKey = boardKeyOf(room);
    const boardChanged = newBoardKey !== (this._boardKey || '');
    if (boardChanged) {
      this._board = parseBoardStr(room.boardStr);
      this._boardKey = newBoardKey;
      this._history = asHistory(room.history);
      // 最后一手跟着房间走：否则对方的落子/悔棋/新一局都不会更新红点标记
      this._lastMove = room.lastMove && room.lastMove.r !== undefined ? room.lastMove : null;
    }
    if (!this._canvas) {
      // canvas 首次渲染完成后再画
      this.setData(patch, () => this._ensureCanvas());
    } else if (boardChanged) {
      this._drawBoard();
    }

    // 戳一戳
    if (room.poke && room.poke.from && room.poke.from !== me) {
      const ts = room.poke.ts || 0;
      // 同一个 poke（同一 ts）只触发一次：ts 来自发送方、对其单调，
      // 用「容差」比较会让早已过去的戳在每次房间写入后反复弹横幅
      if (ts > (this._lastPokeTs || 0)) {
        this._lastPokeTs = ts;
        this._showPoke(room.poke.from);
      }
    }

    // 聊天 & 表情
    // 本地可能有 pending 乐观消息，不能简单用长度比较；按 from+ts 去重
    const chat = room.chat || [];
    const existing = this.data.chatList || [];
    const seen = new Set(existing.map(m => m.from + '_' + m.ts));
    const cloudKeys = new Set(chat.map(m => m.from + '_' + m.ts));
    const merged = existing.filter(m => !m.pending || !cloudKeys.has(m.from + '_' + m.ts));
    let addedNew = null;
    for (const m of chat) {
      const key = m.from + '_' + m.ts;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({
        from: m.from, type: m.type, content: m.content, ts: m.ts,
        key,
        // 用局部变量 me（可能已被翻转为新颜色）
        mine: m.from === me
      });
      if (!addedNew) addedNew = m;
    }
    patch.chatList = merged;
    // 新消息是表情且来自对方 → 播放飞行动画
    if (addedNew && addedNew.type === 'emoji' && addedNew.from !== me) {
      this._playEmojiFly(addedNew.content);
    }

    // 悔棋请求
    if (room.undoRequest && room.undoRequest !== me) {
      patch.undoState = 'oppRequested';
    } else if (room.undoRequest === me) {
      patch.undoState = 'iRequested';
    } else {
      patch.undoState = null;
    }

    // 申请先手
    if (room.firstRequest && room.firstRequest !== me) {
      patch.firstState = 'oppRequested';
    } else if (room.firstRequest === me) {
      patch.firstState = 'iRequested';
    } else {
      patch.firstState = null;
    }

    // 再来一局
    if (room.rematchRequest && room.rematchRequest !== me) {
      patch.rematchState = 'oppRequested';
    } else if (room.rematchRequest === me) {
      patch.rematchState = 'iRequested';
    } else {
      patch.rematchState = null;
      // rematchRequest 从非0变0且 winner=0 且 moveCount=0 → 新的一局已开始
      if (this.data.winner !== 0 && room.winner === 0 && (room.moveCount || 0) === 0) {
        patch.stage = 'playing';
        patch.lastMove = {};  // 清空上一局的最后一手标记
        patch.statusText = room.turn === me ? '新一局开始，轮到你' : '新一局开始，等待对方…';
        wx.showToast({ title: '新一局开始', icon: 'none' });
      }
    }

    // 胜负
    if (room.winner) {
      patch.stage = 'ended';
      // winner: 1黑 2白 3和（满盘无胜局时的哨兵值）
      patch.winText = room.winner === 3 ? '🤝 平局，棋盘已满' : (room.winner === me ? '🎉 你赢了！' : '😢 对方获胜');
      patch.statusText = '对局结束';
    } else if (room.status === 'playing') {
      patch.isMyTurn = room.turn === me;
      patch.statusText = room.turn === me ? '轮到你落子' : '等待对方落子…';
    }

    // 对方已应答（请求标志被清空）：撤掉「对方未响应」定时器，
    // 否则 60 秒后照样弹「对方未响应」，甚至打断已经开始的新一局
    ['undoState', 'firstState', 'rematchState'].forEach(k => {
      if (patch[k] === null && this._requestTimeoutKey === k) this._clearRequestTimeout();
    });

    // 对方离开：加「已处理」标记，否则房间文档后续任何写入都会重复弹窗
    if (room.status === 'ended' && room.leaver && room.leaver !== me && !this._leaverHandled) {
      this._leaverHandled = true;
      patch.stage = 'ended';
      patch.statusText = '对方已离开';
      patch.winText = '对方已离开房间，对局结束';
      this._closeWatcher();
      wx.showModal({
        title: '提示',
        content: '对方已离开房间，对局结束',
        showCancel: false,
        confirmText: '知道了',
        success: () => {
          safeBackToLobby();
        }
      });
    }

    this.setData(patch);
  },

  /* ========== 棋盘绘制 ========== */

  _drawBoard() {
    const canvas = this._canvas;
    if (!canvas || !this._board) return;
    const ctx = this._ctx;
    const dpr = this._dpr;
    const W = this._boardW;
    const cell = W / (SIZE - 1);

    // 木纹底与网格只依赖 W，缓存起来避免每次重绘都重建渐变对象
    if (!this._bgCanvas || this._bgW !== W) {
      const bg = wx.createOffscreenCanvas
        ? wx.createOffscreenCanvas({ type: '2d' })
        : null;
      if (bg) {
        bg.width = W * dpr;
        bg.height = W * dpr;
        const bctx = bg.getContext('2d');
        bctx.scale(dpr, dpr);
        const grad = bctx.createLinearGradient(0, 0, W, W);
        grad.addColorStop(0, '#F5DEB3');
        grad.addColorStop(1, '#E8C999');
        bctx.fillStyle = grad;
        bctx.fillRect(0, 0, W, W);
        bctx.strokeStyle = '#8B6F47';
        bctx.lineWidth = 1;
        for (let i = 0; i < SIZE; i++) {
          bctx.beginPath(); bctx.moveTo(0, i * cell); bctx.lineTo(W, i * cell); bctx.stroke();
          bctx.beginPath(); bctx.moveTo(i * cell, 0); bctx.lineTo(i * cell, W); bctx.stroke();
        }
        const stars = [3, 7, 11];
        bctx.fillStyle = '#8B6F47';
        stars.forEach(r => stars.forEach(c => {
          bctx.beginPath(); bctx.arc(c * cell, r * cell, 3, 0, Math.PI * 2); bctx.fill();
        }));
        this._bgCanvas = bg;
        this._bgW = W;
      } else {
        this._bgCanvas = null;
      }
    }

    ctx.clearRect(0, 0, W, W);
    if (this._bgCanvas) {
      ctx.drawImage(this._bgCanvas, 0, 0, W, W);
    } else {
      // 离屏 canvas 不可用时的降级：直接画
      const grad = ctx.createLinearGradient(0, 0, W, W);
      grad.addColorStop(0, '#F5DEB3');
      grad.addColorStop(1, '#E8C999');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, W);
      ctx.strokeStyle = '#8B6F47';
      ctx.lineWidth = 1;
      for (let i = 0; i < SIZE; i++) {
        ctx.beginPath(); ctx.moveTo(0, i * cell); ctx.lineTo(W, i * cell); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(i * cell, 0); ctx.lineTo(i * cell, W); ctx.stroke();
      }
    }

    // 棋子渐变按颜色缓存：只有黑白两种，不要每颗都 new
    if (!this._pieceGrads) {
      this._pieceGrads = {};
      [1, 2].forEach(v => {
        const g = ctx.createRadialGradient(-cell * 0.15, -cell * 0.15, cell * 0.08, 0, 0, cell * 0.45);
        if (v === 1) { g.addColorStop(0, '#666'); g.addColorStop(1, '#111'); }
        else { g.addColorStop(0, '#FFF'); g.addColorStop(1, '#CCC'); }
        this._pieceGrads[v] = g;
      });
    }

    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const v = this._board[r][c];
        if (!v) continue;
        const x = c * cell, y = r * cell;
        // 阴影
        ctx.beginPath();
        ctx.arc(x + 1, y + 2, cell * 0.42, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fill();
        // 本体（复用缓存渐变，平移到当前坐标）
        const pg = this._pieceGrads[v];
        ctx.save();
        ctx.translate(x, y);
        ctx.beginPath();
        ctx.arc(0, 0, cell * 0.42, 0, Math.PI * 2);
        ctx.fillStyle = pg;
        ctx.fill();
        ctx.restore();
      }
    }

    // 最后一手标记
    const lm = this._lastMove;
    if (lm && lm.r !== undefined && lm.c !== undefined) {
      ctx.beginPath();
      ctx.arc(lm.c * cell, lm.r * cell, cell * 0.14, 0, Math.PI * 2);
      ctx.fillStyle = '#FF3B30';
      ctx.fill();
    }
  },

  onCanvasTap(e) {
    if (this.data.stage !== 'playing' || this.data.winner) return;
    if (!this.data.isMyTurn) {
      wx.showToast({ title: '还没轮到你哦', icon: 'none' });
      return;
    }
    if (this._moving) return;

    // touchend 事件：坐标在 changedTouches 里（手指抬起前最后位置）
    const t = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]);
    if (!t) return;
    const x = t.x, y = t.y;
    if (x == null || y == null) return;
    const cell = this._boardW / (SIZE - 1);
    const c = Math.round(x / cell);
    const r = Math.round(y / cell);
    if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return;
    if (!this._board) return;   // 开局瞬间棋盘尚未就位（setData 回调前）
    if (this._board[r][c]) {
      wx.showToast({ title: '这里已经有棋子了', icon: 'none' });
      return;
    }
    // 落子轻震动反馈
    wx.vibrateShort({ type: 'light' });
    this._placeStone(r, c);
  },

  async _placeStone(r, c) {
    this._moving = true;   // 实例字段，不走 setData 数据桥
    const me = this.data.myColor;
    this._board[r][c] = me;
    this._drawBoard();

    const win = this._checkWin(r, c, me);
    // 满盘无五连 = 平局：不判定的话双方都点不进任何格子、也永不结束
    const draw = !win && (this._history || []).length + 1 >= SIZE * SIZE;
    const db = wx.cloud.database();
    const history = (this._history || []).concat([{ r, c, color: me }]);
    const prevHistory = this._history;
    this._history = history;
    // 云数据库不支持嵌套数组直接 update，board 序列化为字符串
    const update = {
      boardStr: JSON.stringify(this._board),
      history,
      turn: me === 1 ? 2 : 1,
      lastMove: { r, c },
      moveCount: (this.data.moveCount || 0) + 1,
      updatedAt: db.serverDate()
    };
    if (win) update.winner = me;
    else if (draw) update.winner = 3;

    try {
      await db.collection(COLLECTION).doc(this._roomId).update({ data: update });
      this._lastMove = { r, c };
      this._boardKey = update.boardStr;
      if (win) {
        this.setData({
          stage: 'ended',
          winner: me,
          winText: '🎉 你赢了！',
          statusText: '对局结束'
        });
      } else if (draw) {
        this.setData({
          stage: 'ended',
          winner: 3,
          winText: '🤝 平局，棋盘已满',
          statusText: '对局结束'
        });
      } else {
        this.setData({ isMyTurn: false, statusText: '等待对方落子…' });
      }
    } catch (err) {
      log.e('[gomoku] place fail', err && err.errMsg, err && err.errCode);
      // 乐观更新回滚：棋盘与历史必须同进同退，否则双方历史分叉、对局永久损坏
      this._board[r][c] = 0;
      this._history = prevHistory;
      this._drawBoard();
      wx.showToast({ title: '落子失败，请重试', icon: 'none' });
    } finally {
      this._moving = false;
    }
  },

  _checkWin(r, c, color) {
    const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
    // 不用 for (const [dr, dc] of dirs)：数组解构会被 SWC 编译成
    // require('@swc/runtime/_array_with_holes.js')，小程序运行时不提供该模块
    for (let i = 0; i < dirs.length; i++) {
      const dr = dirs[i][0], dc = dirs[i][1];
      let count = 1;
      for (const s of [1, -1]) {
        let nr = r + dr * s, nc = c + dc * s;
        while (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && this._board[nr][nc] === color) {
          count++;
          nr += dr * s;
          nc += dc * s;
        }
      }
      if (count >= 5) return true;
    }
    return false;
  },

  /* ========== 悔棋（需对方同意） ========== */

  async requestUndo() {
    if (this.data.stage !== 'playing' || this.data.undoState) return;
    if ((this.data.moveCount || 0) === 0) {
      wx.showToast({ title: '还没落子，无棋可悔', icon: 'none' });
      return;
    }
    // 悔棋语义 = 撤回「自己的上一手」，因此全局最后一手必须是自己下的
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
    if (this._respondingUndo) return;   // 防连点：双击「同意」会执行两次悔棋
    this._respondingUndo = true;
    const agree = e.currentTarget.dataset.agree === '1';
    const db = wx.cloud.database();
    try {
      if (agree) {
        // 撤销最后一手：从 history 弹栈，board 同步清空，turn 还给请求方
        const history = (this._history || []).slice();
        const last = history.pop();
        if (last && this._board[last.r] && this._board[last.r][last.c] === last.color) {
          this._board[last.r][last.c] = 0;
        }
        this._history = history;
        this._boardKey = '';
        const prevLast = history.length ? history[history.length - 1] : null;
        this._lastMove = prevLast ? { r: prevLast.r, c: prevLast.c } : null;
        await db.collection(COLLECTION).doc(this._roomId).update({
          data: {
            boardStr: JSON.stringify(this._board),
            history,
            turn: last ? last.color : 1, // 轮到被撤子方重新下
            lastMove: prevLast ? { r: prevLast.r, c: prevLast.c } : {},
            moveCount: history.length,
            undoRequest: 0,
            updatedAt: db.serverDate()
          }
        });
        wx.showToast({ title: '已同意悔棋', icon: 'none' });
      } else {
        await db.collection(COLLECTION).doc(this._roomId).update({
          data: { undoRequest: 0, updatedAt: db.serverDate() }
        });
        wx.showToast({ title: '已拒绝', icon: 'none' });
      }
      this.setData({ undoState: null });
      this._clearRequestTimeout();
    } catch (e) {
      wx.showToast({ title: '操作失败', icon: 'none' });
    } finally {
      this._respondingUndo = false;
    }
  },

  // 申请类操作统一超时：对方不响应时自动关闭弹层，避免永远卡在「等待对方同意」
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

  /* ========== 戳一戳 ========== */

  async poke() {
    if (this.data.stage !== 'playing') return;
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
      wx.showToast({ title: '已戳了对方一下 👉', icon: 'none' });
    } catch (e) {
      log.e('poke fail', e);
    }
  },

  _showPoke(fromColor) {
    if (this._destroyed) return;
    this.setData({ pokeVisible: true, pokeText: '👉 对方戳了戳你：快落子！' });
    clearTimeout(this._pokeTimer);
    this._pokeTimer = setTimeout(() => {
      if (this._destroyed) return;
      this.setData({ pokeVisible: false });
    }, 2500);
  },

  /* ========== 再来一局 ========== */

  async requestRematch() {
    if (this.data.stage !== 'ended' || this.data.rematchState) return;
    const db = wx.cloud.database();
    try {
      await db.collection(COLLECTION).doc(this._roomId).update({
        data: { rematchRequest: this.data.myColor, updatedAt: db.serverDate() }
      });
      this.setData({ rematchState: 'iRequested' });
      this._armRequestTimeout('rematchState');
    } catch (e) {
      log.e('requestRematch fail', e);
      wx.showToast({ title: '请求失败', icon: 'none' });
    }
  },

  async respondRematch(e) {
    if (this._respondingRematch) return;
    this._respondingRematch = true;
    const agree = e.currentTarget.dataset.agree === '1';
    const db = wx.cloud.database();
    try {
      if (agree) {
        // 重置棋盘与历史
        this._board = emptyBoard();
        this._history = [];
        this._boardKey = '';
        this._lastMove = null;
        await db.collection(COLLECTION).doc(this._roomId).update({
          data: {
            boardStr: JSON.stringify(this._board),
            history: [],
            turn: 1,
            lastMove: {},
            winner: 0,
            moveCount: 0,
            rematchRequest: 0,
            undoRequest: 0,
            round: (this.data.round || 1) + 1,
            updatedAt: db.serverDate()
          }
        });
        // 本地也清空红点标记
        this.setData({ lastMove: {} });
      } else {
        await db.collection(COLLECTION).doc(this._roomId).update({
          data: { rematchRequest: 0, updatedAt: db.serverDate() }
        });
      }
      this.setData({ rematchState: null });
      this._clearRequestTimeout();
    } catch (e) {
      log.e('respondRematch fail', e);
      wx.showToast({ title: '操作失败', icon: 'none' });
    } finally {
      this._respondingRematch = false;
    }
  },

  /* ========== 申请先手（随时可申请，同意后立刻重新开局） ========== */

  async requestFirst() {
    if (this.data.firstState) return;
    const db = wx.cloud.database();
    try {
      await db.collection(COLLECTION).doc(this._roomId).update({
        data: { firstRequest: this.data.myColor, updatedAt: db.serverDate() }
      });
      this.setData({ firstState: 'iRequested' });
      this._armRequestTimeout('firstState');
    } catch (e) {
      log.e('requestFirst fail', e);
      wx.showToast({ title: '请求失败', icon: 'none' });
    }
  },

  async respondFirst(e) {
    if (this._respondingFirst) return;
    this._respondingFirst = true;
    const agree = e.currentTarget.dataset.agree === '1';
    const db = wx.cloud.database();
    try {
      if (agree) {
        // 交换先后手 + 立刻重新开局：avatars 互换、棋盘清空、turn=1（新黑方先行）
        const newAvatars = {
          black: this.data.oppAvatar,
          white: this.data.myAvatar
        };
        this._board = emptyBoard();
        this._history = [];
        this._boardKey = '';
        this._lastMove = null;
        await db.collection(COLLECTION).doc(this._roomId).update({
          data: {
            avatars: newAvatars,
            boardStr: JSON.stringify(this._board),
            history: [],
            turn: 1,
            lastMove: {},
            winner: 0,
            moveCount: 0,
            undoRequest: 0,
            rematchRequest: 0,
            firstRequest: 0,
            status: 'playing',
            round: (this.data.round || 1) + 1,
            updatedAt: db.serverDate()
          }
        });
        // 本地也清空红点标记
        this.setData({ lastMove: {} });
        wx.showToast({ title: '已交换先后手，重新开局', icon: 'none' });
      } else {
        await db.collection(COLLECTION).doc(this._roomId).update({
          data: { firstRequest: 0, updatedAt: db.serverDate() }
        });
      }
      this.setData({ firstState: null });
      this._clearRequestTimeout();
    } catch (e) {
      log.e('respondFirst fail', e);
      wx.showToast({ title: '操作失败', icon: 'none' });
    } finally {
      this._respondingFirst = false;
    }
  },

  /* ========== 聊天 & 表情互动 ========== */

  onChatInput(e) {
    this.setData({ chatInput: e.detail.value });
  },

  async sendChat() {
    const text = (this.data.chatInput || '').trim();
    if (!text) return;
    if (text.length > 50) {
      wx.showToast({ title: '消息太长了', icon: 'none' });
      return;
    }
    if (this._sendingChat) return;   // 防连点：弱网下连点会真的发出多条
    this._sendingChat = true;
    this.setData({ chatInput: '' });
    await this._pushChat({ from: this.data.myColor, type: 'text', content: text, ts: Date.now() });
    this._sendingChat = false;
  },

  toggleEmojiPanel() {
    this.setData({ showEmojiPanel: !this.data.showEmojiPanel });
  },

  async sendEmoji(e) {
    const icon = e.currentTarget.dataset.icon;
    if (!icon) return;
    if (this._sendingChat) return;
    this._sendingChat = true;
    this.setData({ showEmojiPanel: false });
    await this._pushChat({ from: this.data.myColor, type: 'emoji', content: icon, ts: Date.now() });
    // 本地也播一次动画（对方那边由 watch 触发）
    this._playEmojiFly(icon);
    this._sendingChat = false;
  },

  async _pushChat(msg) {
    // 乐观更新：本地先插一条 pending 气泡，不等云端往返
    const local = Object.assign({}, msg, { pending: true, key: msg.from + '_' + msg.ts + '_p' });
    const optimistic = (this.data.chatList || []).concat([local]);
    this.setData({ chatList: optimistic });

    const db = wx.cloud.database();
    const _ = db.command;
    try {
      await db.collection(COLLECTION).doc(this._roomId).update({
        data: {
          chat: _.push(msg),
          updatedAt: db.serverDate()
        }
      });
    } catch (e) {
      // 发送失败：移除乐观插入的那条
      this.setData({ chatList: (this.data.chatList || []).filter(m => m !== local) });
      wx.showToast({ title: '发送失败', icon: 'none' });
    }
  },

  _playEmojiFly(icon) {
    if (this._destroyed) return;
    this.setData({ emojiFlying: { icon } });
    clearTimeout(this._emojiFlyTimer);
    this._emojiFlyTimer = setTimeout(() => {
      if (this._destroyed) return;
      this.setData({ emojiFlying: null });
    }, C.POKE_COOLDOWN * 2);
  },

  /* ========== 离开房间 ========== */

  async leaveRoom() {
    wx.showModal({
      title: '离开房间',
      content: '离开后当前对局将结束，确定吗？',
      success: async (res) => {
        if (!res.confirm) return;
        // 通知对方离开（失败也照样退出，不要把用户困在房间里）
        const db = wx.cloud.database();
        try {
          await db.collection(COLLECTION).doc(this._roomId).update({
            data: {
              status: 'ended',
              leaver: this.data.myColor,
              updatedAt: db.serverDate()
            }
          });
        } catch (e) {
          log.e('leaveRoom notify fail', e);
        }
        this._closeWatcher();
        safeBackToLobby();
      }
    });
  },

  /* ========== 分享 ========== */

  onShareAppMessage() {
    const no = this.data.roomNo;
    return {
      title: no ? `来和我下小笨五子棋！房间号 ${no}` : '来小笨游戏大厅一起玩！',
      path: no ? `/subpackages/games/gomoku/gomoku?roomNo=${no}` : '/pages/games/games'
    };
  },

  /* ========== Canvas 初始化（wxml canvas 准备好后调用） ========== */

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
        // canvas 尚未挂载（wx:if 未渲染）——带上限重试，避免无限循环
        this._canvasRetry = (this._canvasRetry || 0) + 1;
        if (this._canvasRetry > C.CANVAS_RETRY_MAX) {
          wx.showToast({ title: '棋盘加载失败，请重进房间', icon: 'none' });
          return;
        }
        this._canvasRetryTimer = setTimeout(() => this._ensureCanvas(), C.CANVAS_RETRY_DELAY);
        return;
      }
      const canvas = info.node;
      // wx.getWindowInfo() 返回 null 时不能直接读 pixelRatio
      let dpr = 2;
      try {
        const info2 = wx.getWindowInfo ? wx.getWindowInfo() : null;
        if (info2 && typeof info2.pixelRatio === 'number' && info2.pixelRatio > 0) {
          dpr = Math.min(info2.pixelRatio, 2);
        }
      } catch (e) {
        dpr = 2;
      }
      // 用 onReady 计算的 boardW 作为 canvas 实际尺寸，确保坐标基准一致
      const boardW = this.data.boardW;
      canvas.width = boardW * dpr;
      canvas.height = boardW * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      this._canvas = canvas;
      this._ctx = ctx;
      this._dpr = dpr;
      this._boardW = boardW;
      // 尺寸变了要重建缓存的背景
      this._bgCanvas = null;
      this._pieceGrads = null;
      log.d('[gomoku] canvas ready boardW=' + boardW + ' dpr=' + dpr);
      if (!this._board) this._board = emptyBoard();
      this._drawBoard();
    });
  },

  onCanvasReady() {
    this._ensureCanvas();
  }
});
