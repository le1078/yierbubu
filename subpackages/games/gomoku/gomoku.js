// 小笨五子棋 · 云开发房间联机
// 集合：gomoku_rooms
// 双方 watch 同一房间文档驱动同步

const COLLECTION = 'gomoku_rooms';
const SIZE = 15; // 15x15 棋盘

const AVATARS = ['/assets/avatar_a.gif', '/assets/avatar_b.gif'];

function emptyBoard() {
  const b = [];
  for (let i = 0; i < SIZE; i++) b.push(new Array(SIZE).fill(0));
  return b;
}

function pad4(n) {
  n = String(n);
  while (n.length < 4) n = '0' + n;
  return n;
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
    oppJoined: false,
    turn: 1,
    isMyTurn: false,
    statusText: '',
    winner: 0,
    winText: '',
    lastMove: {},
    moveCount: 0,
    moving: false,           // 防连点锁
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
      { key: 'ginseng',icon:'🫐', label: '扔人参果' }
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
    const sys = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const w = sys.windowWidth;
    // rpx 转 px：1rpx = w/750 px
    const rpx2px = w / 750;
    const boardW = Math.floor(w - 88 * rpx2px); // 24*2 + 20*2 = 88rpx
    this._boardW = boardW;
    this.setData({ boardW });
    console.log('[gomoku] onReady boardW=' + boardW + ' screenW=' + w + ' rpx2px=' + rpx2px);
    if (this._autoJoin) {      this._autoJoin = null;
      this.joinRoom();
    }
  },

  onUnload() {
    this._closeWatcher();
  },

  onHide() {
    // 不切后台就不管；切后台保持 watch（回来还能收到）
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
      const roomNo = pad4(Math.floor(Math.random() * 10000));
      // 随机双方形象：房主拿一个，对方拿另一个
      const myAvatarIdx = Math.random() < 0.5 ? 0 : 1;
      const doc = {
        roomNo,
        status: 'waiting',
        players: { black: true, white: false }, // 占位标记，身份由创建者/加入者角色决定
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
      this.setData({
        stage: 'waiting',
        roomNo,
        myColor: 1,
        myColorText: '⚫ 黑棋（先手）',
        myAvatar: AVATARS[myAvatarIdx],
        oppAvatar: AVATARS[1 - myAvatarIdx],
        oppJoined: false,
        statusText: '等待好友加入…'
      });
      this._startWatch();
      // 轮询兜底：防止 watch 延迟导致创建者卡在等待页
      this._waitPollTimer = setInterval(() => this._pollRoomStatus(), 2000);
    } catch (err) {
      console.error('createRoom fail', err);
      wx.showToast({ title: '创建失败，请检查云环境', icon: 'none' });
    } finally {
      wx.hideLoading();
      this._creating = false;
    }
  },

  async joinRoom() {
    const roomNo = this.data.roomNoInput;
    if (!roomNo || roomNo.length !== 4) {
      wx.showToast({ title: '请输入4位房间号', icon: 'none' });
      return;
    }
    if (this._joining) return;
    this._joining = true;
    wx.showLoading({ title: '加入中…', mask: true });
    try {
      const db = wx.cloud.database();
      const q = await db.collection(COLLECTION).where({ roomNo }).orderBy('createdAt', 'desc').limit(1).get();
      if (!q.data || !q.data.length) {
        wx.showToast({ title: '房间不存在', icon: 'none' });
        return;
      }
      const room = q.data[0];
      if (room.status !== 'waiting') {
        wx.showToast({ title: '房间已开始或已结束', icon: 'none' });
        return;
      }
      this._roomId = room._id;
      this._isJoiner = true;
      await db.collection(COLLECTION).doc(this._roomId).update({
        data: {
          status: 'playing',
          turn: 1,
          updatedAt: db.serverDate()
        }
      });
      this.setData({
        stage: 'playing',
        roomNo,
        myColor: 2,
        myColorText: '⚪ 白棋（后手）',
        myAvatar: room.avatars.white,
        oppAvatar: room.avatars.black,
        oppJoined: true,
        turn: 1,
        isMyTurn: false,
        statusText: '等待对方落子…',
        moveCount: room.moveCount || 0,
        lastMove: room.lastMove || {}
      }, () => {
        this._board = room.boardStr ? JSON.parse(room.boardStr) : emptyBoard();
        this._history = room.history || [];
        this._ensureCanvas();
      });
      this._startWatch();
    } catch (err) {
      console.error('joinRoom fail', err);
      wx.showToast({ title: '加入失败：' + (err.errMsg || '未知错误'), icon: 'none' });
    } finally {
      wx.hideLoading();
      this._joining = false;
    }
  },

  /* ========== Watch 同步 ========== */

  _startWatch() {
    this._closeWatcher();
    const db = wx.cloud.database();
    this._watcher = db.collection(COLLECTION).doc(this._roomId).watch({
      onChange: (snapshot) => {
        const docs = snapshot.docs;
        if (!docs || !docs.length) return;
        this._onRoomUpdate(docs[0]);
      },
      onError: (err) => {
        console.error('watch error', err);
      }
    });
  },

  _closeWatcher() {
    if (this._watcher) {
      try { this._watcher.close(); } catch (e) {}
      this._watcher = null;
    }
    if (this._waitPollTimer) {
      clearInterval(this._waitPollTimer);
      this._waitPollTimer = null;
    }
  },

  // 创建者等待页轮询兜底：watch 延迟时也能及时进入对局
  async _pollRoomStatus() {
    if (this.data.stage !== 'waiting' || !this._roomId) {
      if (this._waitPollTimer) { clearInterval(this._waitPollTimer); this._waitPollTimer = null; }
      return;
    }
    try {
      const db = wx.cloud.database();
      const res = await db.collection(COLLECTION).doc(this._roomId).get();
      const room = res.data;
      if (room && room.status === 'playing' && this.data.stage === 'waiting') {
        this._onRoomUpdate(room);
      }
    } catch (e) {}
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
        if (this._waitPollTimer) { clearInterval(this._waitPollTimer); this._waitPollTimer = null; }
        const turnNow = room.turn || 1;
        this.setData({
          stage: 'playing',
          oppJoined: true,
          turn: turnNow,
          isMyTurn: turnNow === me,
          statusText: turnNow === me ? '轮到你落子' : '等待对方落子…'
        }, () => {
          this._board = room.boardStr ? JSON.parse(room.boardStr) : emptyBoard();
          this._history = room.history || [];
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
      isMyTurn: room.turn === me
    };

    // 棋盘变化：boardStr 反序列化
    this._board = room.boardStr ? JSON.parse(room.boardStr) : (room.board ? room.board : emptyBoard());
    this._history = room.history || [];
    if (!this._canvas) {
      // canvas 首次渲染完成后再画
      this.setData(patch, () => this._ensureCanvas());
    } else {
      this._drawBoard();
    }

    // 戳一戳
    if (room.poke && room.poke.from && room.poke.from !== me) {
      const ts = room.poke.ts || 0;
      if (ts > (this._lastPokeTs || 0)) {
        this._lastPokeTs = ts;
        this._showPoke(room.poke.from);
      }
    }

    // 聊天 & 表情
    const chat = room.chat || [];
    if (chat.length > (this.data.chatList || []).length) {
      const newMsgs = chat.slice((this.data.chatList || []).length);
      const me2 = this.data.myColor;
      const mapped = chat.map(m => ({
        from: m.from,
        type: m.type,
        content: m.content,
        ts: m.ts,
        mine: m.from === me2
      }));
      patch.chatList = mapped;
      // 新消息是表情且来自对方 → 播放飞行动画
      const lastNew = newMsgs[newMsgs.length - 1];
      if (lastNew && lastNew.type === 'emoji' && lastNew.from !== me2) {
        this._playEmojiFly(lastNew.content);
      }
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
      patch.winText = room.winner === me ? '🎉 你赢了！' : '😢 对方获胜';
      patch.statusText = '对局结束';
    } else if (room.status === 'playing') {
      patch.isMyTurn = room.turn === me;
      patch.statusText = room.turn === me ? '轮到你落子' : '等待对方落子…';
    }

    // 对方离开
    if (room.status === 'ended' && room.leaver && room.leaver !== me) {
      patch.stage = 'ended';
      patch.statusText = '对方已离开';
      patch.winText = '对方已离开房间，对局结束';
      wx.showModal({
        title: '提示',
        content: '对方已离开房间，对局结束',
        showCancel: false,
        confirmText: '知道了',
        success: () => {
          wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/games/games' }) });
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

    ctx.clearRect(0, 0, W, W);
    // 木纹底
    const grad = ctx.createLinearGradient(0, 0, W, W);
    grad.addColorStop(0, '#F5DEB3');
    grad.addColorStop(1, '#E8C999');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, W);

    // 网格
    ctx.strokeStyle = '#8B6F47';
    ctx.lineWidth = 1;
    for (let i = 0; i < SIZE; i++) {
      ctx.beginPath();
      ctx.moveTo(0, i * cell);
      ctx.lineTo(W, i * cell);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(i * cell, 0);
      ctx.lineTo(i * cell, W);
      ctx.stroke();
    }

    // 星位
    const stars = [3, 7, 11];
    ctx.fillStyle = '#8B6F47';
    stars.forEach(r => stars.forEach(c => {
      ctx.beginPath();
      ctx.arc(c * cell, r * cell, 3, 0, Math.PI * 2);
      ctx.fill();
    }));

    // 棋子
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
        // 本体
        const pg = ctx.createRadialGradient(x - cell * 0.15, y - cell * 0.15, cell * 0.08, x, y, cell * 0.45);
        if (v === 1) {
          pg.addColorStop(0, '#666');
          pg.addColorStop(1, '#111');
        } else {
          pg.addColorStop(0, '#FFF');
          pg.addColorStop(1, '#CCC');
        }
        ctx.beginPath();
        ctx.arc(x, y, cell * 0.42, 0, Math.PI * 2);
        ctx.fillStyle = pg;
        ctx.fill();
      }
    }

    // 最后一手标记
    const lm = this.data.lastMove;
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
    if (this.data.moving) return;

    // touchstart 事件：e.touches[0].x/y 是相对 canvas 左上角的坐标
    const t = e.touches && e.touches[0];
    if (!t) return;
    const x = t.x, y = t.y;
    if (x == null || y == null) return;
    const cell = this._boardW / (SIZE - 1);
    const c = Math.round(x / cell);
    const r = Math.round(y / cell);
    console.log('[gomoku] tap x=' + x + ' y=' + y + ' -> r=' + r + ' c=' + c + ' boardW=' + this._boardW);    if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return;
    if (this._board[r][c]) {
      wx.showToast({ title: '这里已经有棋子了', icon: 'none' });
      return;
    }
    this._placeStone(r, c);
  },

  async _placeStone(r, c) {
    this.setData({ moving: true });
    const me = this.data.myColor;
    this._board[r][c] = me;
    this._drawBoard();

    const win = this._checkWin(r, c, me);
    const db = wx.cloud.database();
    const history = (this._history || []).concat([{ r, c, color: me }]);
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

    try {
      await db.collection(COLLECTION).doc(this._roomId).update({ data: update });
      if (win) {
        this.setData({
          stage: 'ended',
          winner: me,
          winText: '🎉 你赢了！',
          statusText: '对局结束',
          moving: false
        });
      } else {
        this.setData({ isMyTurn: false, statusText: '等待对方落子…', moving: false });
      }
    } catch (err) {
      console.error('[gomoku] place fail err=', err, 'errMsg=', err && err.errMsg, 'code=', err && err.errCode);
      this._board[r][c] = 0;
      this._drawBoard();
      this.setData({ moving: false });
      wx.showToast({ title: '落子失败:' + (err && err.errMsg || '未知'), icon: 'none' });
    }
  },

  _checkWin(r, c, color) {
    const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (const [dr, dc] of dirs) {
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
    } catch (e) {
      wx.showToast({ title: '请求失败', icon: 'none' });
    }
  },

  async respondUndo(e) {
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
        const prevLast = history.length ? history[history.length - 1] : null;
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
    } catch (e) {
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  /* ========== 戳一戳 ========== */

  async poke() {
    if (this.data.stage !== 'playing') return;
    const now = Date.now();
    if (this._lastPokeSent && now - this._lastPokeSent < 10000) {
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
    } catch (e) {}
  },

  _showPoke(fromColor) {
    this.setData({ pokeVisible: true, pokeText: '👉 对方戳了戳你：快落子！' });
    clearTimeout(this._pokeTimer);
    this._pokeTimer = setTimeout(() => {
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
    } catch (e) {}
  },

  async respondRematch(e) {
    const agree = e.currentTarget.dataset.agree === '1';
    const db = wx.cloud.database();
    try {
      if (agree) {
        // 重置棋盘与历史
        this._board = emptyBoard();
        this._history = [];
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
    } catch (e) {}
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
    } catch (e) {}
  },

  async respondFirst(e) {
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
    } catch (e) {}
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
    await this._pushChat({ from: this.data.myColor, type: 'text', content: text, ts: Date.now() });
    this.setData({ chatInput: '' });
  },

  toggleEmojiPanel() {
    this.setData({ showEmojiPanel: !this.data.showEmojiPanel });
  },

  async sendEmoji(e) {
    const icon = e.currentTarget.dataset.icon;
    if (!icon) return;
    this.setData({ showEmojiPanel: false });
    await this._pushChat({ from: this.data.myColor, type: 'emoji', content: icon, ts: Date.now() });
    // 本地也播一次动画（对方那边由 watch 触发）
    this._playEmojiFly(icon);
  },

  async _pushChat(msg) {
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
      wx.showToast({ title: '发送失败', icon: 'none' });
    }
  },

  _playEmojiFly(icon) {
    this.setData({ emojiFlying: { icon } });
    clearTimeout(this._emojiFlyTimer);
    this._emojiFlyTimer = setTimeout(() => {
      this.setData({ emojiFlying: null });
    }, 1800);
  },

  /* ========== 离开房间 ========== */

  async leaveRoom() {
    wx.showModal({
      title: '离开房间',
      content: '离开后当前对局将结束，确定吗？',
      success: async (res) => {
        if (!res.confirm) return;
        // 通知对方离开
        const db = wx.cloud.database();
        try {
          await db.collection(COLLECTION).doc(this._roomId).update({
            data: {
              status: 'ended',
              leaver: this.data.myColor,
              updatedAt: db.serverDate()
            }
          });
        } catch (e) {}
        this._closeWatcher();
        wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/games/games' }) });
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

  _ensureCanvas() {
    if (this._canvas) { this._drawBoard(); return; }
    const q = wx.createSelectorQuery().in(this);
    q.select('#gboard').fields({ node: true, size: true }).exec((res) => {
      const info = res && res[0];
      if (!info || !info.node) {
        // canvas 尚未挂载（wx:if 未渲染）——稍后重试
        setTimeout(() => this._ensureCanvas(), 60);
        return;
      }
      const canvas = info.node;
      const dpr = (wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : 2) || 2;
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
      console.log('[gomoku] canvas ready boardW=' + boardW + ' dpr=' + dpr + ' info.width=' + info.width);
      if (!this._board) this._board = emptyBoard();
      this._drawBoard();
    });
  },

  onCanvasReady() {
    this._ensureCanvas();
  }
});
