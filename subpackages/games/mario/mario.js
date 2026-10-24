// 小笨马里奥 · 页面
// 双人联机闯关：host 权威 + guest 输入中继 + 客户端预测。
//
// ============ 联机同步协议（重点，改前先读） ============
// 云开发 watch 推送延迟 200~500ms，且单文档持续高频写会触发限流。
// 60fps 实时同步不可行，所以：
//
//   mario_rooms 文档：
//     world:  JSON 字符串，只有 host（座位1）写，2.5Hz
//             含双方玩家状态 + 敌人 + 剩余金币 + Boss
//     input2: JSON 字符串，只有 guest（座位2）写，2.5Hz
//             含按键状态 + 已吃掉的金币 id
//
//   每个座位只写自己的字段 → 两个写者永不冲突，
//   不需要 read-modify-write，规避云数据库嵌套数组更新的最大坑。
//
//   host 侧：本地 60Hz 确定性模拟 → 读 input2 → 每 400ms 写一次 world
//   guest 侧：每 400ms 写一次 input2；收到 world 后：
//             · 自己的角色用本地输入做死区推算（手感即时）
//             · host 角色 / 敌人 / 金币 / Boss 用权威值 + 帧间插值
//   金币以 host 为权威：guest 只上报 got:[coinId]，host 校验后移除，不双扣
//
// 预期（必须告知用户）：对手位置仍有约 0.3~0.8 秒延迟，
// 这是云 watch 的固有限制，客户端预测只能掩盖、不能消除。

const COLLECTION = 'mario_rooms';
const C = require('../../../utils/constants.js');
const log = require('../../../utils/log.js');
const roomkit = require('../../../utils/roomkit.js');
const relaykit = require('../../../utils/relay.js');
const EN = require('./engine.js');
const LV = require('./levels.js');
const R = require('./render.js');
const AU = require('./audio.js');

// 联机 world / input 的安全解析：房间文档里可能残留旧版本或损坏的 JSON。
// 直接 JSON.parse 会抛在 watch/轮询回调里（同步从此中断），或在加入房间时
// 让整个加入流程失败。统一在这里兜底，解析失败返回 null 由调用方跳过。
function parseJsonSafe(str, tag) {
  if (!str) return null;
  try {
    const v = JSON.parse(str);
    return (v && typeof v === 'object') ? v : null;
  } catch (e) {
    log.e('[mario] ' + tag + ' 解析失败，已跳过', e);
    return null;
  }
}

// 联机模式：'online' | 'solo'（solo = 单机试玩/开发用）
Page({
  data: {
    stage: 'menu',        // menu | lobby | waiting | playing | ended
    mode: 'online',
    level: 0,
    levelName: '',
    roomNoInput: '',
    roomNo: '',
    mySeat: 1,            // 1 host / 2 guest
    coop: true,           // true 合作闯关 / false 竞速
    statusText: '',
    metaText: '',
    winText: '',
    syncMs: C.MARIO_SYNC_MS,
    canvasW: 350,
    canvasH: 350,
    p1Lives: C.MARIO_LIVES,
    p2Lives: C.MARIO_LIVES,
    p1Score: 0,
    p2Score: 0,
    p1Coins: 0,
    p2Coins: 0,
    timeLeft: 400,
    landscape: false,
    syncText: '',         // 联机同步状态：长时间收不到远端数据时提示
    raceText: '',         // 竞速模式：双方进度百分比
    showChat: false,      // 聊天面板开关（联机）
    chatInput: '',
    infiniteLives: false, // 无限生命模式：死亡不减命（情侣休闲）
    muted: false          // 音效开关
  },

  onLoad(options) {
    if (options && options.roomNo) {
      this._autoJoin = String(options.roomNo);
      // 马里奥没有独立的 lobby 视图，直接回到菜单（菜单里有房间号输入）
      this.setData({ stage: 'menu', roomNoInput: String(options.roomNo) });
    }
  },

  onReady() {
    this._measure();
    // 从分享卡片进入：自动加入房间
    if (this._autoJoin) {
      const no = this._autoJoin;
      this._autoJoin = null;
      this.joinRoom(no);
    }
  },

  // 屏幕方向/尺寸变化（用户旋转手机）时重新计算布局。
  // 不处理的话，横竖屏切换后画布尺寸和按键区会错位。
  onResize() {
    if (this._destroyed) return;
    this._measure();
    // 画布尺寸变了，背景缓存要作废
    this._bgCache = { canvas: null, w: 0, h: 0 };
    this._canvas = null;
    this._ctx = null;
    this._ensureCanvas();
  },

  onUnload() {
    this._destroyed = true;
    this._stopLoop();
    this._stopInputPoll();
    this._closeRelay();
    roomkit.sweepTimers(this);
    // 通知对方离开
    if (this._roomId && this.data.mode === 'online') {
      const db = wx.cloud.database();
      db.collection(COLLECTION).doc(this._roomId).update({
        data: { status: 'ended', leaver: this.data.mySeat }
      }).catch(e => log.e('[mario] leave notify fail', e));
    }
  },

  onHide() {
    // 切后台：停循环 + 停写入 + 关订阅（watch/200ms 轮询在后台还会
    // 持续读云数据库，白烧额度）
    this._paused = true;
    this._stopLoop();
    this._stopInputPoll();
    if (this._roomId && this.data.mode === 'online') {
      // 给对方留个标记：区分「人切后台了」和「同步坏了」，
      // 否则对方只会看到吓人的「⚠️ 同步中断」。
      // 中继模式下 socket 断开本身就是标记（服务器广播 peer offline）。
      if (!(this._relay && this._relay.isReady()) &&
          this.data.stage === 'playing' && !this._over) {
        this._markPause(this.data.mySeat);
      }
      this._closeRelay();
      roomkit.closeWatch(this);
    }
  },

  onShow() {
    // 从后台/其他页面回来：必须清掉暂停标记再重启循环。
    // 之前 onShow 里判断 !this._paused，而 onHide 把 _paused 置 true，
    // 导致回到页面后循环永远不恢复（画布只剩 CSS 蓝底）。
    if (this.data.stage === 'playing') {
      this._paused = false;
      this._startLoop();
      if (this.data.mode === 'online' && this._roomId) {
        // 回来了：清掉自己的暂停标记，对方好恢复正常提示
        this._markPause(0);
        // 中继优先：先连中继；没就绪前由云数据库兜底，
        // 中继 onReady 会自动把 DB watch/轮询关掉
        this._startRelay();
        this._startWatch();
        if (this.data.mySeat === 1) {
          this._startInputPoll();
        }
      }
    } else if (this.data.stage === 'waiting' && this._roomId &&
               this.data.mode === 'online') {
      // 等待页也要恢复订阅，否则收不到对方加入
      this._startRelay();
      this._startWatch();
    }
  },

  // 写「谁切后台了」标记到房间文档（0 = 都在）。失败无所谓，尽力而为。
  _markPause(seat) {
    if (!this._roomId) return;
    try {
      const db = wx.cloud.database();
      db.collection(COLLECTION).doc(this._roomId).update({
        data: { pause: seat }
      }).catch(() => {});
    } catch (e) { /* 云未初始化等极端情况直接忽略 */ }
  },

  /* ========== 布局 ========== */

  _measure() {
    // 用安全取值：wx.getWindowInfo 在部分时机返回 null，直接读会崩
    const win = roomkit.getWindowSize();
    const w = win.windowWidth;
    const rpx2px = w / 750;
    // 竖屏布局：画面占满宽度，按键在画面下方
    const canvasW = Math.floor(w - 32 * rpx2px);
    // 视口 15 格宽 × 9 格高（竖屏下这对比例最舒服，能看清地面与头顶砖）
    const cols = 15;
    const rows = 9;
    this._scale = canvasW / cols;
    const canvasH = Math.floor(this._scale * rows);
    this.setData({ canvasW, canvasH, landscape: false });
  },

  // 对局画布在 wx:if 里，离开 playing 时会被销毁、再进入时重建。
  // 旧 _ctx 指向已销毁的节点，继续画只会得到一块空蓝底 —— 每次进入
  // 新对局都重置，让 _ensureCanvas 重新查询新节点。
  _resetCanvas() {
    this._canvas = null;
    this._ctx = null;
    this._sprites = null;
    this._bgCache = { canvas: null, w: 0, h: 0 };
    // 重试预算也要复位：上一局积累的失败次数不清零的话，
    // 新对局 canvas 挂载稍慢就直接撞上限、永远不再尝试
    this._canvasRetry = 0;
  },

  /* ========== 菜单 ========== */

  pickMode(e) {
    this.setData({ mode: e.currentTarget.dataset.mode });
  },

  toggleCoop() {
    this.setData({ coop: !this.data.coop });
  },

  // 无限生命模式（情侣休闲）：死亡原地重生不减命，永远玩下去
  toggleInfiniteLives() {
    const on = !this.data.infiniteLives;
    this.setData({ infiniteLives: on });
    // 对局中切换立即生效（下一关 _setupLevel 也会重新注入）
    if (this._players) {
      for (const p of this._players) p.infiniteLives = on;
    }
  },

  // 音效开关
  toggleMute() {
    const muted = !this.data.muted;
    AU.setMuted(muted);
    this.setData({ muted });
  },

  startSolo() {
    this._resetCanvas();
    // 单机只有一个真人玩家：不要再生成一个站在起点不动的 P2，
    // 否则合作模式的「双方都到终点」永远无法满足，碰到旗杆就会卡死。
    this._setupLevel(0, true);
    // 必须在 setData 回调里启动循环：_tick 会检查 this.data.stage === 'playing'，
    // 而 setData 是异步的，提前启动会导致第一帧就 return、且不再续 timer
    this.setData({ stage: 'playing', mode: 'solo', mySeat: 1, statusText: '单机试玩 · P1' }, () => {
      this._over = false;
      this._startLoop();
    });
  },

  backToMenu() {
    this._stopInputPoll();
    this._closeRelay();
    roomkit.closeWatch(this);
    this._roomId = null;
    this._stopLoop();
    this._resetCanvas();
    this.setData({ stage: 'menu' });
  },

  /* ========== 关卡装载 ========== */

  _setupLevel(idx, solo) {
    const spec = LV.LEVEL_SPECS[idx];
    const level = EN.loadLevel(LV.LEVELS[idx], spec);
    this._level = level;
    // 引擎事件 → 音效（钩子挂关卡上，换关自动带走；星星和踩敌等
    // 只有表现层差异，不影响模拟结果，两端各自发声即可）
    level.onEvent = (name, x, y) => {
      AU.play(name);
      // 踩敌/受击给一下轻震动（手上有反馈，手游玩平台跳跃很需要）
      if (name === 'stomp' || name === 'hurt' || name === 'die') {
        try { wx.vibrateShort({ type: 'light' }); } catch (e) {}
      }
      // 死亡回放镜头：联机时对方死了，镜头短暂切过去看一眼再回来
      if ((name === 'die' || name === 'hurt') && this.data.mode === 'online' &&
          this._players && this._players.length > 1) {
        const victim = this._players[0].state === 'dying' || name === 'die'
          ? this._players.find((q) => q.state === 'dying')
          : null;
        if (victim && victim.seat !== this.data.mySeat) {
          this._replayFocus = victim.seat;
          this._replayUntil = Date.now() + 1400;   // 1.4 秒切镜
        }
      }
    };
    // 单机合作只需要 P1；单机竞速生成一个电脑 P2 和你比赛。
    const withAI = !!solo && !this.data.coop;
    this._aiSeat = withAI ? 2 : 0;
    this._players = (solo && !withAI)
      ? [EN.makePlayer(level, 1)]
      : [EN.makePlayer(level, 1), EN.makePlayer(level, 2)];
    if (!solo || withAI) {
      // 双人出生点错开，避免叠在一起
      this._players[1].x = level.start.col + 2.5;
      this._players[1].respawnX = level.start.col + 2.5;
    }
    // 道具共享（合作模式）：引擎 resolveItemHit 按 level._players 同步变身
    level._players = this._players;
    // 无限生命模式：引擎按玩家字段判断，两关设置都注入
    if (this.data.infiniteLives) {
      for (const p of this._players) p.infiniteLives = true;
    }
    this._inputs = { 1: EN.makeInput(), 2: EN.makeInput() };
    // 2.5Hz 输入采样会漏掉「快速点一下跳/下」，用边沿锁存到下一次上报
    this._edgeLatch = { u: false, d: false };
    // 上一关吃剩的金币 id 必须清掉：新关卡金币 id 重新编号，
    // 残留 id 恰好命中新关卡里 P2 身边的金币会被误判成已吃
    this._pendingGot = [];
    // 双车道去重的时间戳基线也要重置：新关卡 level.time 归零，旧基线会把
    // 新关卡前几百毫秒的合法快照全部误判成「过期」丢掉
    this._lastWorldT = -1;
    this._lastInputT = -1;
    this._lastDbWriteAt = 0;
    this._lastDbAttemptAt = 0;
    this._dbFails = 0;
    // 聊天气泡（seat -> {text, until}）：until 用关卡时间，换关自动清
    this._bubbles = {};
    this._lastChatTs = 0;
    // 竞速进度条的目标（旗杆列），进度百分比用它算
    this._raceGoal = EN.findFlagCol(level);
    // 云数据库兜底车道的节奏（独立于中继车道退避/恢复；
    // 用实例字段而不是 data，避免中继成功把库车道的退避抵消掉）
    this._dbInterval = C.MARIO_SYNC_MS;
    this._lastSyncOk = true;
    this._acc = 0;                 // 物理累时器（固定步长的关键）
    this._syncAcc = 0;
    this._lastSyncOk = true;
    this.setData({
      level: idx,
      levelName: spec.name || ('第 ' + (idx + 1) + ' 关'),
      metaText: '第 ' + (idx + 1) + ' 关 · ' + (spec.name || '')
    });
  },

  nextLevel() {
    // 联机时只有房主能推进关卡；guest 端由 world 里的 epoch 驱动重载
    if (this.data.mode === 'online' && this.data.mySeat === 2) {
      wx.showToast({ title: '联机模式由房主（P1）切换关卡', icon: 'none' });
      return;
    }
    const n = (this.data.level + 1) % LV.LEVEL_SPECS.length;
    this._worldEpoch = (this._worldEpoch || 0) + 1;
    this._resetRoomEndFlags();
    this._setupLevel(n, this.data.mode === 'solo');
    this.setData({ stage: 'playing', winText: '' }, () => {
      this._over = false;
      this._startLoop();
    });
  },

  restart() {
    if (this.data.mode === 'online' && this.data.mySeat === 2) {
      wx.showToast({ title: '联机模式由房主（P1）重开本关', icon: 'none' });
      return;
    }
    this._worldEpoch = (this._worldEpoch || 0) + 1;
    this._resetRoomEndFlags();
    this._setupLevel(this.data.level, this.data.mode === 'solo');
    this.setData({ stage: 'playing', winText: '' }, () => {
      this._over = false;
      this._startLoop();
    });
  },

  // 开新一局前清掉房间文档里上一局的终局/暂停标记，
  // 否则 guest 在换关瞬间会把残留的 winner 误判成「对方先到终点」
  _resetRoomEndFlags() {
    this._seenRoomWinner = 0;
    if (this.data.mode !== 'online' || !this._roomId) return;
    try {
      const db = wx.cloud.database();
      db.collection(COLLECTION).doc(this._roomId).update({
        data: { winner: 0, pause: 0 }
      }).catch(() => {});
    } catch (e) { /* 忽略：best effort */ }
  },

  /* ========== 联机 ========== */

  async createRoom() {
    if (this._creating) return;
    this._creating = true;
    wx.showLoading({ title: '创建中…', mask: true });
    try {
      const res = await roomkit.createRoom(COLLECTION, {
        status: 'waiting',
        level: 0,
        coop: this.data.coop ? 1 : 0,
        seats: { 1: 1, 2: 0 },
        world: JSON.stringify({ level: 0, t: 0, p1: null, p2: null, es: [], cs: [] }),
        input2: JSON.stringify({ t: 0, keys: { l: 0, r: 0, u: 0, d: 0, rn: 0 }, got: [] }),
        winner: 0
      });
      this._roomId = res.roomId;
      this._worldEpoch = (this._worldEpoch || 0) + 1;
      this._setupLevel(0);
      this._closeRelay();
      this._resetCanvas();
      this.setData({ stage: 'waiting', mode: 'online', roomNo: res.roomNo, mySeat: 1 });
      this._startWatch();
      this._startRelay(res.roomNo);   // 实时中继（可选通道，连不上自动回退）
    } catch (err) {
      log.e('[mario] createRoom fail', err);
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
        data: {
          status: 'playing',
          'seats.2': 1,
          level: room.level || 0,
          updatedAt: db.serverDate()
        }
      });
      const lvIdx = room.level || 0;
      this._setupLevel(lvIdx);
      this._resetCanvas();
      // guest 是座位 2，先按 host 的世界快照对齐一帧
      const initWorld = parseJsonSafe(room.world, 'world');
      if (initWorld) this._applyWorld(initWorld, true);
      this.setData({
        stage: 'playing',
        mode: 'online',
        roomNo,
        mySeat: 2,
        coop: room.coop === 1,
        statusText: '联机闯关 · P2'
      }, () => {
        // 与 startSolo/nextLevel 相同的模式：在 setData 回调里启动，
        // _tick 会检查 stage==='playing'，提前启动的第一帧会直接 return
        // 且不再续 timer（代码库里已踩过的坑）
        this._startWatch();
        this._startLoop();
        this._startRelay(roomNo);   // 实时中继（可选通道，连不上自动回退）
        this._doSync();   // 开局立刻上报一次输入
      });
    } catch (err) {
      log.e('[mario] joinRoom fail', err);
      const hint = roomkit.joinErrorText(err);
      wx.showToast({ title: hint || ('加入失败：' + (err.errMsg || '未知错误')), icon: 'none', duration: 3000 });
    } finally {
      wx.hideLoading();
      this._joining = false;
    }
  },

  // host 侧：轮询 guest 的独立输入文档。串行自调度，避免请求重叠。
  _startInputPoll() {
    if (this._inputPollTimer) {
      clearTimeout(this._inputPollTimer);
      this._inputPollTimer = null;
    }
    // 代际令牌：上一条链可能正卡在 await 上（此时它的 timer 句柄已是
    // null，clearTimeout 清不到它）。它恢复后会盲目覆盖新链的 timer
    // 句柄 → 两条链并行、读数翻倍。令牌不一致的旧链直接退出不再自调度。
    this._pollGen = (this._pollGen || 0) + 1;
    const gen = this._pollGen;
    const tick = async () => {
      if (gen !== this._pollGen) return;   // 已被更新的链取代
      this._inputPollTimer = null;
      if (this._destroyed || this.data.mode !== 'online' ||
          this.data.mySeat !== 1 || !this._roomId) return;
      const docId = this._roomId + '_input';
      try {
        const db = wx.cloud.database();
        const res = await db.collection(COLLECTION).doc(docId).get();
        if (gen !== this._pollGen) return;   // await 期间被新链取代
        if (res && res.data && res.data.input2 && res.data.input2 !== this._lastInputRaw) {
          this._lastInputRaw = res.data.input2;
          const inputPayload = parseJsonSafe(res.data.input2, 'input2');
          if (inputPayload) this._applyInput2(inputPayload);
          this._lastRemoteAt = Date.now();
          this._rxInput = (this._rxInput || 0) + 1;
        }
      } catch (e) {
        // 输入文档还没创建（guest 首次写入前）——下一轮再试
      }
      if (this._destroyed || gen !== this._pollGen) return;
      this._inputPollTimer = setTimeout(tick, 250);
    };
    tick();
  },

  _stopInputPoll() {
    if (this._inputPollTimer) {
      clearTimeout(this._inputPollTimer);
      this._inputPollTimer = null;
    }
  },

  /* ========== 自建 WebSocket 中继（加速车道，与云数据库并存） ========== */
  // 云数据库单文档高频写会限流，是「同步中断」的根因。有自建服务器时
  // （constants.MARIO_RELAY_URL），对局数据走中继（6.7~10Hz，低延迟）。
  //
  // 重要架构约束：中继是「加速车道」而不是「替代车道」。云数据库的
  // watch/输入轮询/低频写全程保持——任何一端连不上中继（真机不允许
  // ws://IP、开发者工具没勾豁免、服务器挂了），它就自动只用云数据库。
  // 两条车道的数据按时间戳去重（见 _applyWorld/_applyInput2），
  // 混合环境（比如开发者工具 + 真机）也不会出现各说各话的黑屏。

  _startRelay(roomNo) {
    if (!C.MARIO_RELAY_URL || this._relay) return;
    const self = this;
    const no = String(roomNo || this.data.roomNo || '');
    if (!no) return;
    this._relay = relaykit.create();
    this._relay.connect(C.MARIO_RELAY_URL, no, this.data.mySeat, {
      onReady() {
        if (self._destroyed) return;
        log.d('[mario] relay ready room=' + no + ' seat=' + self.data.mySeat);
        self._lastRemoteAt = Date.now();
        // 立刻推一帧（快车道首帧），别等下一个同步周期
        self._doSync();
      },
      onData(v) { self._onRelayData(v); },
      onPeer(online, seat, bye) {
        if (self._destroyed || seat === self.data.mySeat) return;
        // 对端是否在中继上：决定本端云数据库兜底车道的频率。
        // 对端在快车道 → 库写降为心跳（省配额、避限流）；
        // 对端不在 → 库写保持 _dbInterval（他是纯库端，全靠这条车道）
        self._peerOnRelay = !!online;
        if (bye) {
          // 对方主动离开（离开房间按钮）：和云数据库车道的 leaver 一样弹窗告知
          if (!self._leaverHandled && self.data.stage !== 'menu') {
            self._leaverHandled = true;
            self._over = true;
            self._stopLoop();
            self._closeRelay();
            self.setData({ stage: 'ended', winText: '对方已离开房间', statusText: '对局结束' });
            self._notifyPeerLeft();
          }
          return;
        }
        self._peerPaused = !online;
        // 对方（重）上线：host 立刻推一帧世界，让他尽快追上进度
        if (online && self.data.mySeat === 1 && self.data.stage === 'playing') self._doSync();
      },
      onDown() {
        // 自己的中继断了（重连中）：对端在不在线变成未知，
        // 保守起见立刻回到 400ms 库写节奏，别让对端饿着
        self._peerOnRelay = false;
      },
      onGiveUp() {
        // 服务器连不上（多半是手机没开调试模式连不了 ws://）：
        // 云数据库兜底车道一直在，游戏照常可玩（HUD 显示收发计数、
        // 延迟略高），不是故障——不弹窗打扰。
        // 不是终态——_syncHud 里每 10 秒会尝试复活（手机网络抖动很常见）。
        if (self._destroyed) return;
        log.d('[mario] relay unavailable, cloud-db lane only');
        self._relay = null;
        self._peerOnRelay = false;
      }
    });
  },

  _closeRelay() {
    if (this._relay) {
      this._relay.close();
      this._relay = null;
    }
  },

  // 中继上的对局数据：语义与云数据库路径完全一致，只是通道不同
  _onRelayData(v) {
    if (!v || this._destroyed) return;
    this._lastRemoteAt = Date.now();
    if (v.k === 'world') {
      let reloaded = false;
      try {
        reloaded = this._applyWorld(v.w, false);
        this._rxWorld = (this._rxWorld || 0) + 1;
      } catch (e) {
        log.e('[mario] relay world fail', e);
      }
      this._handleRoomWinner(v.winner, reloaded);
    } else if (v.k === 'input') {
      this._applyInput2(v.i);
      this._rxInput = (this._rxInput || 0) + 1;
    } else if (v.k === 'end') {
      this._handleRoomWinner(v.winner, false);
    } else if (v.k === 'chat') {
      this._receiveChat(v.m);
    }
  },

  /* ========== 头顶聊天（双车道都通） ========== */

  toggleChatPanel() {
    this.setData({ showChat: !this.data.showChat });
  },

  onChatInput(e) {
    this.setData({ chatInput: e.detail.value });
  },

  quickChat(e) {
    const t = e.currentTarget.dataset.t;
    if (t) this._sendChat(t);
  },

  sendChat() {
    const text = (this.data.chatInput || '').trim();
    if (!text) return;
    this._sendChat(text);
  },

  _sendChat(text) {
    if (this.data.stage !== 'playing') return;
    const m = {
      from: this.data.mySeat,
      text: String(text).slice(0, 20),
      ts: Date.now()
    };
    this.setData({ chatInput: '' });
    // 自己先显示（不等往返），两条车道照发：谁连中继谁秒收，
    // 纯云数据库端由房间文档 watch/轮询收到
    this._receiveChat(m);
    AU.play('chat');
    if (this._relay && this._relay.isReady()) {
      this._relay.send({ k: 'chat', m });
    }
    try {
      const db = wx.cloud.database();
      db.collection(COLLECTION).doc(this._roomId).update({
        data: { chat: m }
      }).catch(e => log.e('[mario] chat db fail', e));
    } catch (e) { /* 云不可用就算了，中继那条可能已送达 */ }
  },

  // 收到聊天（自己的/中继的/云数据库的）：ts 去重，气泡挂 3 秒
  _receiveChat(m) {
    if (!m || !m.from || !m.text) return;
    if (m.ts <= (this._lastChatTs || 0)) return;
    this._lastChatTs = m.ts;
    if (!this._level) return;
    this._bubbles = this._bubbles || {};
    this._bubbles[m.from] = {
      text: String(m.text).slice(0, 20),
      until: this._level.time + 3
    };
    // 对方的消息来一声提示音（自己的已经发过了）
    if (m.from !== this.data.mySeat) AU.play('chat');
  },

  _startWatch() {
    roomkit.startWatch(this, COLLECTION, this._roomId, (room) => this._onRoomUpdate(room));
  },

  // 对方离开的统一提示（中继/云数据库两条车道共用）
  _notifyPeerLeft() {
    if (this._destroyed) return;
    wx.showModal({
      title: '对方已离开',
      content: '对局已结束，回到大厅吧',
      showCancel: false,
      confirmText: '回到大厅',
      success: () => {
        if (this._destroyed) return;
        this._roomId = null;
        this._resetCanvas();
        this.setData({ stage: 'menu' });
      }
    });
  },

  // 竞速终局统一入口：云数据库路径（房间文档 winner 字段）和
  // 中继路径（end 消息）都走这里。reloaded = 本帧刚好换关，
  // 此时 winner 是上一局残留，不能当本局终局。
  _handleRoomWinner(winner, reloaded) {
    if (!winner || reloaded) return;
    if (this._over || this.data.stage !== 'playing') return;
    if (this.data.coop) return;                          // 合作模式两端各自收敛
    if (winner === (this._seenRoomWinner || 0)) return;  // 只处理一次（上升沿）
    this._seenRoomWinner = winner;
    if (winner === this.data.mySeat) return;             // 自己赢，本地已结算
    this._over = true;
    this._stopLoop();
    this.setData({ stage: 'ended', winText: '😢 对方先到终点', statusText: '本关完成' });
  },

  _onRoomUpdate(room) {
    const me = this.data.mySeat;

    // host 在等待页：对方加入后开局
    if (this.data.stage === 'waiting') {
      if (room.status === 'playing') {
        this._resetCanvas();
        this.setData({
          stage: 'playing',
          mode: 'online',
          statusText: '联机闯关 · P1',
          metaText: '房间 ' + (room.roomNo || this.data.roomNo) + ' · ' + (this.data.coop ? '合作' : '竞速')
        }, () => {
          this._over = false;
          this._startLoop();
          this._startInputPoll();   // host 轮询 guest 的输入（云数据库兜底车道）
          // 等待期间中继若放弃过，开局立刻重连（不用等 10s 的复活周期）
          if (!this._relay) this._startRelay();
          this._doSync();           // 开局立刻写一次世界
        });
      }
      return;
    }

    // 对方离开（云数据库车道）
    if (room.status === 'ended' && room.leaver && room.leaver !== me && !this._leaverHandled) {
      this._leaverHandled = true;
      this._stopLoop();
      this._closeRelay();
      roomkit.closeWatch(this);
      this.setData({ stage: 'ended', winText: '对方已离开房间', statusText: '对局结束' });
      this._notifyPeerLeft();
      return;
    }

    if (me === 2 && room.world) {
      // guest：应用 host 的权威世界（reloaded = 本帧刚好换了关卡/重开）
      let reloaded = false;
      try {
        const w = parseJsonSafe(room.world, 'world');
        if (w) reloaded = this._applyWorld(w, false);
        this._lastRemoteAt = Date.now();
        this._rxWorld = (this._rxWorld || 0) + 1;
      } catch (e) {
        log.e('[mario] parse world fail', e);
      }
      // 竞速终局：对方到终点后本地结束、停写数据，本端模拟可能永远
      // 等不到他的终局帧（缺最后几百毫秒输入）→ 不处理就会一直
      // 「同步中断」地空跑。对方结束时会把 winner 写进房间文档。
      this._handleRoomWinner(room.winner, reloaded);
    } else if (me === 1) {
      // host：guest 先到终点（guest 不写 world，只能从房间文档感知）
      this._handleRoomWinner(room.winner, false);
    }
    // 对方是否切后台了（onHide 时对方会写 pause 标记）
    if (room.pause && room.pause !== me && this.data.stage === 'playing') {
      this._peerPaused = true;
    } else if (!room.pause || room.pause === me) {
      this._peerPaused = false;
    }
    // 聊天（云数据库车道）：中继不通的端靠这里收到气泡。
    // 与中继同一条消息按 ts 去重（_receiveChat 内）
    if (room.chat) this._receiveChat(room.chat);
    // host 的 guest 输入从独立的 {roomId}_input 文档读取（见 _startInputPoll），
    // 房间文档里的 input2 只是旧版本兼容字段，不再使用。
  },

  // 把 host 的权威世界套到本地（guest 侧）。
  // 返回 true 表示本帧刚好重载了关卡（换关/重开）。
  _applyWorld(w, initial) {
    if (!this._level || !w) return false;
    // epoch：host 每次建房/换关/重开时 +1。只比 w.level 不够 ——
    // 同一关重开时 level 不变，guest 端被消灭的敌人/吃掉的金币会残留
    const curEp = this._worldEpoch || 0;
    // 代际只增不减：迟到的旧代际包（慢车道/重连补发）必须丢弃，
    // 否则会把已经进入新关的 guest 反向重载回上一局
    if (w.ep !== undefined && w.ep < curEp) return false;
    const epMismatch = w.ep !== undefined && w.ep !== curEp;
    if (w.ep !== undefined) this._worldEpoch = w.ep;
    const lvChanged = w.level !== undefined && w.level !== this.data.level;
    if (!initial && (lvChanged || epMismatch)) {
      this._setupLevel(w.level !== undefined ? w.level : this.data.level);
      // 新一局：上一局的 winner 记录作废，避免把残留值当成本局终局
      this._seenRoomWinner = 0;
      // host 已开新关/重开：还在结算屏的 guest 也要回到对局
      this._over = false;
      this.setData({ stage: 'playing', winText: '' }, () => this._startLoop());
      return true;
    }
    // 双车道去重：同一世界快照会从中继（快）和云数据库（慢）各到一次，
    // 慢车道的旧包也可能晚于快车道的新包到达 —— 只应用更新的（t 随关卡走）
    if (!initial && typeof w.t === 'number') {
      if (w.t <= (this._lastWorldT === undefined ? -1 : this._lastWorldT)) return false;
      this._lastWorldT = w.t;
    }
    // 倒计时以 host 为准（两端帧率钳制差异会让本地倒数漂移）
    if (w.tl !== undefined) this._level.timeLeft = w.tl;
    // 自己的角色：死区推算，不直接用权威值（否则延迟直接体现在手感上）
    const me = this._players[this.data.mySeat - 1];
    const myW = this.data.mySeat === 1 ? w.p1 : w.p2;
    if (myW && me) {
      const dx = Math.abs(myW.x - me.x);
      const dy = Math.abs(myW.y - me.y);
      // 自己用本地预测，不要被权威位置的小偏差反复拉回（橡皮筋）。
      // 只有这些情况才强制对齐：首次同步、死亡/过关、复活、偏差大到明显脱节。
      const stateChanged = myW.st !== me.state;
      const respawn = stateChanged && myW.st === 'alive';
      const hardState = myW.st === 'dead' || myW.st === 'done';
      const huge = dx > 10 || dy > 6;
      if (initial || hardState || respawn || huge) {
        me.x = myW.x; me.y = myW.y;
        me.vx = myW.vx; me.vy = myW.vy;
      }
      // 本地预测可能「幻觉死亡/复活」（敌我位置有延迟差），状态必须跟权威走：
      // 只同步 dead/done 的话，本地一旦误判死亡就永远起不来（host 看他还在玩）
      if (hardState || respawn) {
        me.state = myW.st;
        if (myW.st === 'alive') me.fellInPit = false;
        if (myW.st === 'done') me.finishT = myW.ft || 0;
      }
      // 形态/生命/金币/星星/分数/状态始终同步（这些不是位置预测）
      me.starT = myW.sr || 0;
      me.lives = myW.lv;
      me.coins = myW.cn;
      me.score = myW.sc || 0;
      // 无限生命跟 host 权威（guest 本地开关否则无效：lives 每帧被覆盖）
      if (myW.il !== undefined) me.infiniteLives = !!myW.il;
      // 形态必须始终同步（不能只在拉回时同步，否则吃蘑菇对方看不到）。
      // 用 setForm 而不仅是赋值：它同时更新碰撞盒高度 h。
      const myForm = (myW.fm !== undefined) ? myW.fm : 0;
      if (me.form !== myForm) {
        EN.setForm(me, myForm);
      }
    }
    // 对方角色 + 世界实体：用权威值 + 插值目标
    const oppIdx = this.data.mySeat === 1 ? 1 : 0;
    const oppW = this.data.mySeat === 1 ? w.p2 : w.p1;
    if (oppW && this._players[oppIdx]) {
      const opp = this._players[oppIdx];
      opp._tx = oppW.x; opp._ty = oppW.y;
      opp.vx = oppW.vx; opp.vy = oppW.vy;
      opp.starT = oppW.sr || 0;
      opp.lives = oppW.lv;
      opp.coins = oppW.cn;
      if (oppW.sc !== undefined) opp.score = oppW.sc;
      // 对端的无限生命标记也照抄（本地预测端不该把对端判成死亡）
      if (oppW.il !== undefined) opp.infiniteLives = !!oppW.il;
      // 过关用时也要同步：竞速模式 raceWinner 靠它判定
      if (oppW.ft !== undefined) opp.finishT = oppW.ft;
      if (oppW.f !== undefined) opp.face = oppW.f;
      if (oppW.g !== undefined) opp.onGround = !!oppW.g;
      opp.state = oppW.st === 'dead' ? 'dead' : (oppW.st === 'done' ? 'done' : 'alive');
      const oppForm = (oppW.fm !== undefined) ? oppW.fm : 0;
      if (opp.form !== oppForm) EN.setForm(opp, oppForm);
      if (initial) { opp.x = oppW.x; opp.y = oppW.y; }
    }
    // 敌人
    if (w.es && this._level.enemies) {
      for (const e of w.es) {
        const eid = e[0], alive = e[1], ex = e[2], ey = e[3], shell = e[4];
        const en = this._level.enemies[eid];
        if (!en) continue;
        en._tx = ex; en._ty = ey;
        if (initial) { en.x = ex; en.y = ey; }
        if (!alive) en.alive = false;
        // 乌龟壳状态也要同步（否则 guest 看到的是走路态）
        if (shell && en.shell !== shell) {
          en.shell = shell;
          if (shell === 'shell') en.vx = 0;
        }
      }
    }
    // 金币：以 host 为准，本地多吃的要吐回来（host 校验距离后才移除）
    if (w.cs && this._level.coins) {
      const aliveIds = {};
      for (const id of w.cs) aliveIds[id] = true;
      for (const c of this._level.coins) {
        if (!aliveIds[c.id]) {
          c.taken = true;
        } else if (c.taken) {
          // 本地吃过但 host 还没移除：保持 taken，但上报给 host
          if (!this._pendingGot) this._pendingGot = [];
          if (this._pendingGot.indexOf(c.id) === -1) this._pendingGot.push(c.id);
        }
      }
    }
    // Boss
    // Boss：w.bs 是 [[hp,phase,x], ...]（多 Boss 关有多个）
    if (w.bs && w.bs.length) {
      const localBosses = this._level.bosses ||
        (this._level.boss ? [this._level.boss] : []);
      for (let bi = 0; bi < w.bs.length && bi < localBosses.length; bi++) {
        localBosses[bi].hp = w.bs[bi][0];
        localBosses[bi].phase = w.bs[bi][1];
        localBosses[bi]._tx = w.bs[bi][2];
      }
    }
  },

  // 把 guest 的输入套到本地（host 侧）
  _applyInput2(inp) {
    if (!inp || !this._inputs) return;
    const i2 = this._inputs[2];
    if (!i2) return;
    // 双车道去重：同一条输入会从中继（快）和云数据库（慢）各到一次，
    // 慢车道的旧包也可能晚于快车道的新包到达 —— 只应用更新的快照。
    // 关卡代际变化时时间戳会归零，必须先重置基线再比较。
    if (typeof inp.ep === 'number' && inp.ep !== this._lastInputEpoch) {
      this._lastInputEpoch = inp.ep;
      this._lastInputT = -1;
    }
    if (typeof inp.t === 'number') {
      if (inp.t <= (this._lastInputT === undefined ? -1 : this._lastInputT)) return;
      this._lastInputT = inp.t;
    }
    i2.left = !!inp.keys.l;
    i2.right = !!inp.keys.r;
    i2.up = !!inp.keys.u;
    i2.down = !!inp.keys.d;
    i2.run = !!inp.keys.rn;
    // guest 上报吃掉的金币：host 做距离校验，防作弊/防双扣
    if (inp.got && inp.got.length && this._level) {
      const p2 = this._players[1];
      for (const id of inp.got) {
        const c = this._level.coins[id];
        if (!c || c.taken) continue;
        const dx = Math.abs((c.col + 0.5) - p2.x);
        const dy = Math.abs((c.row + 0.5) - p2.y);
        if (dx < 1.2 && dy < 1.5) {
          c.taken = true;
          p2.coins += 1;
          // 分数与百金币加命要和 resolveCoinHit 一致，
          // 否则 guest 端 HUD 分数一收到权威值就回落
          p2.score += 200;
          if (p2.coins % 100 === 0) p2.lives += 1;
        }
      }
    }
  },

  /* ========== 主循环 ========== */

  _startLoop() {
    this._stopLoop();
    if (this._destroyed) return;
    this._paused = false;
    this._lastFrame = Date.now();
    // 同步调度器的基线必须在这里初始化：_tick 里那句
    // acc += (now - (this._lastSyncAt || now)) 在未初始化时增量恒为 0，
    // 累加器永远不涨 → _doSync 永远不会被调度（只靠开局/修复的零星调用
    // 续命，表现为「动一下就同步中断」——从初版就存在的隐藏炸弹）
    this._lastSyncAt = Date.now();
    this._syncAcc = 0;
    this._rafTimer = setTimeout(() => this._tick(), C.MARIO_TICK_MS);
  },

  _stopLoop() {
    if (this._rafTimer) {
      clearTimeout(this._rafTimer);
      this._rafTimer = null;
    }
  },

  _tick() {
    if (this._destroyed || this._paused || this.data.stage !== 'playing') return;
    // 兜底：竞速/单机切换时如果关卡或玩家没建好，先补建，
    // 否则 stepWorld 会直接抛错、循环断掉，画布只剩蓝底。
    if (!this._level || !this._players || !this._players.length) {
      this._setupLevel(this.data.level || 0, this.data.mode === 'solo');
    }
    // canvas 在 wx:if 渲染完成后才挂载，主循环里轮询获取（比猜时机可靠）
    if (!this._ctx) this._ensureCanvas();

    const now = Date.now();
    // 累积真实经过时间，按固定 1/60 步长消耗（掉帧时不会变速）
    this._acc += Math.min(now - this._lastFrame, 250);   // 钳 250ms，防切后台后暴冲
    this._lastFrame = now;
    let steps = 0;
    while (this._acc >= C.MARIO_TICK_MS && steps < 8) {
      if (this._aiSeat && this._players[this._aiSeat - 1]) {
        this._inputs[this._aiSeat] = EN.makeAutoInput(this._level, this._players[this._aiSeat - 1]);
      }
      EN.stepWorld(this._level, this._players, this._inputs, EN.TICK);
      this._acc -= C.MARIO_TICK_MS;
      steps++;
    }

    this._interpolate();
    this._render();
    this._syncHud();

    // 胜负检查
    this._checkEnd();

    // 云同步调度：中继就绪走快车道节奏（host 6.7Hz / guest 10Hz），
    // 否则按兜底车道节奏（_dbInterval，默认 400ms）。_doSync 内部两条车道并存。
    const relayUp = !!(this._relay && this._relay.isReady());
    const interval = relayUp
      ? (this.data.mySeat === 1 ? C.MARIO_RELAY_WORLD_MS : C.MARIO_RELAY_INPUT_MS)
      : (this._dbInterval || C.MARIO_SYNC_MS);
    this._syncAcc += (now - (this._lastSyncAt || now));
    if (this._syncAcc >= interval) {
      this._syncAcc = 0;
      this._lastSyncAt = now;
      if (this.data.mode === 'online' && this._roomId) this._doSync();
    }

    this._rafTimer = setTimeout(() => this._tick(), C.MARIO_TICK_MS);
  },

  // 把生命/金币同步到 UI（走 setData 数据桥，每帧一次，量很小）
  _syncHud() {
    if (!this._players) return;
    const a = this._players[0], b = this._players[1];
    const patch = {};
    if (a.lives !== this.data.p1Lives) patch.p1Lives = a.lives;
    if (a.score !== this.data.p1Score) patch.p1Score = a.score;
    if (a.coins !== this.data.p1Coins) patch.p1Coins = a.coins;
    if (b) {
      if (b.lives !== this.data.p2Lives) patch.p2Lives = b.lives;
      if (b.score !== this.data.p2Score) patch.p2Score = b.score;
      if (b.coins !== this.data.p2Coins) patch.p2Coins = b.coins;
    }
    // 竞速模式：双方到旗杆的进度百分比（一眼看出领先多少）
    if (!this.data.coop && this._level) {
      const goal = this._raceGoal || this._level.cols - 5;
      const pct = (x) => Math.max(0, Math.min(100, Math.round(x / goal * 100)));
      const mine = pct((a.x || 0));
      const theirs = b ? pct(b.x || 0) : 0;
      const raceText = '🏁 我' + mine + '% 对' + theirs + '%';
      if (raceText !== this.data.raceText) patch.raceText = raceText;
    } else if (this.data.raceText) {
      patch.raceText = '';
    }
    // 倒计时
    if (this._level && this._level.timeLeft !== this.data.timeLeft) {
      patch.timeLeft = this._level.timeLeft;
    }
    // 联机同步健康度：显示收发计数；持续收不到对方才提示中断
    if (this.data.mode === 'online') {
      if (this._lastRemoteAt === undefined) this._lastRemoteAt = Date.now();
      const isHost = this.data.mySeat === 1;
      const tx = isHost ? (this._txWorld || 0) : (this._txInput || 0);
      const rx = isHost ? (this._rxInput || 0) : (this._rxWorld || 0);
      // 中继模式显示实时延迟；云数据库模式显示收发计数
      let syncText = (isHost ? '发W' : '发I') + tx + ' ' + (isHost ? '收I' : '收W') + rx;
      if (this._relay && this._relay.isReady()) {
        const rtt = this._relay.rtt();
        syncText = '⚡' + (rtt || '—') + 'ms';
      }
      // 兜底车道写失败计数（限流/配额）：直接暴露在 HUD 上，
      // 否则只能靠控制台日志定位（真机上看不到）
      if (this._dbFails > 0) {
        syncText += ' 库写失败' + this._dbFails + (this._lastDbErr ? '(' + this._lastDbErr + ')' : '');
      }
      // 阈值 5 秒：云 watch/轮询正常也会抖 2~4 秒，3 秒就报会频繁误报
      const stale = this._lastRemoteAt && Date.now() - this._lastRemoteAt > 5000;
      if (stale) {
        syncText = this._peerPaused ? '⏸ 对方暂时离开…' : '⚠️ 同步中断';
      }

      // 中继死掉（挂死/放弃）后自动复活：giveUp 不是终态，
      // 手机网络抖一下就可能救回来，每 10 秒重试一次
      if (!this._relay && C.MARIO_RELAY_URL && this.data.stage === 'playing' &&
          Date.now() - (this._lastRelayReviveAt || 0) > 10000) {
        this._lastRelayReviveAt = Date.now();
        this._startRelay();
      }

      // 持续收不到对方：重启订阅/轮询。对方已知切后台时不必折腾
      // （重启也救不回一个不在前台的人，反而多烧读配额），
      // 也不再强制补写——常规节奏 400ms 内本来就会写，多写只会加重限流。
      if (stale && !this._peerPaused && Date.now() - (this._lastRepairAt || 0) > 5000) {
        this._lastRepairAt = Date.now();
        log.d('[mario] sync repair: restart watch/poll');
        this._startWatch();
        if (this.data.mySeat === 1) this._startInputPoll();
      }

      // 每 5 秒打一条同步计数日志，方便定位是哪一侧没写/没收到
      if (!this._lastSyncLog || Date.now() - this._lastSyncLog > 5000) {
        this._lastSyncLog = Date.now();
        log.d('[mario] sync ' + (isHost ? 'host' : 'guest') +
          ' txW=' + (this._txWorld || 0) + ' txI=' + (this._txInput || 0) +
          ' rxW=' + (this._rxWorld || 0) + ' rxI=' + (this._rxInput || 0) +
          ' mode=' + this.data.mode);
      }
      if (syncText !== this.data.syncText) patch.syncText = syncText;
    } else if (this.data.syncText) {
      patch.syncText = '';
    }
    if (Object.keys(patch).length) this.setData(patch);
  },

  // 帧间插值：把 _tx/_ty 目标值向当前值靠近，掩盖 watch 推送的阶梯感
  _interpolate() {
    const k = 0.25;
    const lerp = (cur, tgt) => (tgt === undefined ? cur : cur + (tgt - cur) * k);
    for (const p of this._players) {
      if (this.data.mySeat === 2 && p.seat === 2) continue;   // 自己用本地预测，不插值
      if (p.seat === 1 && this.data.mySeat === 2) {
        p.x = lerp(p.x, p._tx);
        p.y = lerp(p.y, p._ty);
      }
    }
    for (const e of this._level.enemies) {
      e.x = lerp(e.x, e._tx);
      e.y = lerp(e.y, e._ty);
    }
    // Boss 插值（多 Boss 关逐个）
    const bossList = this._level.bosses ||
      (this._level.boss ? [this._level.boss] : []);
    for (const bs of bossList) {
      if (bs._tx !== undefined) {
        bs.x = lerp(bs.x, bs._tx);
      }
    }
  },

  _render() {
    const ctx = this._ctx;
    if (!ctx || !this._level) return;
    // 摄像机跟随「自己」：联机时 guest 的 mySeat=2，不能一直跟着 host，
    // 否则 guest 进管道/走到别处时画面会停在 host 身上。
    // 死亡回放：对方死亡后 1.4 秒内镜头切到对方身上看一眼。
    let focusIdx = this.data.mode === 'online' ? Math.max(0, this.data.mySeat - 1) : 0;
    if (this._replayFocus && this._replayUntil > Date.now()) {
      const idx = this._replayFocus - 1;
      if (this._players[idx] && this._players[idx].state === 'dying') {
        focusIdx = idx;
      } else {
        this._replayFocus = null;
      }
    } else if (this._replayFocus) {
      this._replayFocus = null;
    }
    const focus = this._players[focusIdx] || this._players[0] || { x: 0, y: 0 };
    const cam = R.cameraX(this._level, focus.x, this.data.canvasW / this._scale);
    const camY = R.cameraY(this._level, focus.y, this.data.canvasH / this._scale);
    R.drawFrame(ctx, {
      ctx,
      level: this._level,
      players: this._players,
      time: this._level.time,
      viewW: this.data.canvasW,
      viewH: this.data.canvasH,
      scale: this._scale,
      bgCache: this._bgCache || (this._bgCache = { canvas: null, w: 0, h: 0 }),
      cam,
      camY,
      // 玩家形象帧（PNG）：直接画进 canvas，避免 <image> 被原生画布盖住
      sprites: this._sprites,
      bubbles: this._bubbles || null
    });
  },

  // 把两个玩家的 GIF 抽帧 PNG 载入为 canvas image。
  // 图片异步加载，未就绪时渲染层会退回矢量小人，角色不会消失。
  _loadSprites(canvas) {
    if (this._sprites || !canvas || !canvas.createImage) return;
    const make = (src) => {
      const img = canvas.createImage();
      img.src = src;
      return img;
    };
    const a = [], b = [];
    for (let i = 0; i < 2; i++) a.push(make('/subpackages/games/mario/img/avatar_a_' + i + '.png'));
    for (let i = 0; i < 6; i++) b.push(make('/subpackages/games/mario/img/avatar_b_' + i + '.png'));
    this._sprites = { 1: a, 2: b };
  },

  _checkEnd() {
    if (this._over) return;
    if (!this._level || !this._players || !this._players.length) return;
    const cleared = this.data.coop
      ? EN.isLevelCleared(this._level, this._players)
      : EN.raceWinner(this._level, this._players) !== 0;
    if (cleared) {
      this._over = true;
      this._stopLoop();
      const w = this.data.coop ? null : EN.raceWinner(this._level, this._players);
      const text = this.data.mode === 'solo'
        ? (this.data.coop ? '🎉 通关！'
          : (w === 1 ? '🎉 你赢了电脑！' : '🤖 电脑先到终点'))
        : (this.data.coop
          ? '🎉 合作通关！'
          : (w === this.data.mySeat ? '🎉 你赢了！' : '😢 对方先到终点'));
      this.setData({ stage: 'ended', winText: text, statusText: '本关完成' });
      // 竞速模式要把终局写到房间文档：对方（尤其 host 侧）可能永远
      // 等不到本端模拟的终局帧——本端结束后停写数据，对方只能靠这个
      // 字段收尾。合作模式两端各自收敛，不写（写了反而会被误读成终局）。
      if (this.data.mode === 'online' && this._roomId && !this.data.coop) {
        // 中继在线：走实时通道通知（对面 watch 可能已关）
        if (this._relay && this._relay.isReady()) {
          this._relay.send({ k: 'end', winner: this.data.mySeat });
        }
        const db = wx.cloud.database();
        db.collection(COLLECTION).doc(this._roomId).update({
          data: { winner: this.data.mySeat }
        }).catch(e => log.e('[mario] set winner fail', e));
      }
      return;
    }
    // 合作模式：有人命用完就判负。只靠 isGameOver（要全员阵亡）会死锁：
    // 过关要全员 done、gameOver 要全员 dead，「一人活着+一人阵亡」两边
    // 都不成立 —— 对局永久卡住（实测确认）。
    // 竞速模式不受影响：另一方还能跑到终点。
    if (EN.isGameOver(this._level, this._players) ||
        (this.data.coop && EN.anyPlayerDead(this._players))) {
      this._over = true;
      this._stopLoop();
      const coopDeath = this.data.coop && EN.anyPlayerDead(this._players) &&
        !EN.isGameOver(this._level, this._players);
      this.setData({
        stage: 'ended',
        winText: coopDeath ? '💀 队友倒下了，本关失败' : '💀 游戏结束',
        statusText: coopDeath ? '有人的命用完了' : '命用完了'
      });
    }
  },

  /* ========== 云同步 ========== */

  async _doSync() {
    if (this._destroyed || !this._roomId) return;
    const now = Date.now();
    const relayUp = !!(this._relay && this._relay.isReady());
    // 云数据库兜底车道。节奏按「尝试时间」而非「成功时间」计算：
    // 限流拒绝也算一次尝试，否则失败后每个同步周期都会重试（6.7Hz
    // 的失败风暴把限流越撞越深，双车道全灭永不恢复——实测踩过）。
    // 对端在中继上时降为心跳频率（数据走快车道，库只留观察兜底）。
    const dbInterval = this._peerOnRelay
      ? C.MARIO_RELAY_DB_HEARTBEAT_MS
      : (this._dbInterval || C.MARIO_SYNC_MS);
    const dbDue = now - (this._lastDbAttemptAt || 0) >= dbInterval;
    const db = wx.cloud.database();
    const me = this.data.mySeat;
    let dbWritten = false;   // 本次是否真的写成功过库（恢复节奏只看库本身）
    try {
      if (me === 1) {
        const w = EN.worldToWire(this._level, this._players);
        w.level = this.data.level;
        w.ep = this._worldEpoch || 0;
        const payload = JSON.stringify(w);
        if (relayUp) {
          this._relay.send({ k: 'world', w });
          this._txWorld = (this._txWorld || 0) + 1;
        }
        if (!relayUp || dbDue) {
          this._lastDbAttemptAt = now;
          await db.collection(COLLECTION).doc(this._roomId).update({
            data: { world: payload }
          });
          this._lastDbWriteAt = Date.now();
          this._dbFails = 0;
          this._txWorld = (this._txWorld || 0) + 1;
          dbWritten = true;
        }
      } else {
        const i2 = this._inputs[2];
        // 防御：边沿锁存必须存在（_setupLevel 初始化；异常路径缺失时
        // 构建输入会抛错，而它在两条车道的发送之前——一炸双车道全灭）
        if (!this._edgeLatch) this._edgeLatch = { u: false, d: false };
        const input = {
          t: Math.round(this._level.time * 1000),
          // 关卡代际：换关/重开后本端 level.time 归零，host 侧的
          // 「只应用更新的输入」判据必须跟着重置，否则会一直丢弃
          // 新输入直到时间追回旧值（最长几十秒的假死）
          ep: this._worldEpoch || 0,
          keys: {
            l: i2.left ? 1 : 0, r: i2.right ? 1 : 0,
            u: (i2.up || this._edgeLatch.u) ? 1 : 0,
            d: (i2.down || this._edgeLatch.d) ? 1 : 0,
            rn: i2.run ? 1 : 0
          },
          got: this._pendingGot || []
        };
        let delivered = false;
        if (relayUp) {
          delivered = this._relay.send({ k: 'input', i: input });
          if (delivered) this._txInput = (this._txInput || 0) + 1;
        }
        if (!relayUp || dbDue) {
          this._lastDbAttemptAt = now;
          await db.collection(COLLECTION).doc(this._roomId + '_input').set({
            data: { input2: JSON.stringify(input), updatedAt: db.serverDate() }
          });
          this._lastDbWriteAt = Date.now();
          this._dbFails = 0;
          this._txInput = (this._txInput || 0) + 1;
          delivered = true;
          dbWritten = true;
        }
        if (delivered) {
          // 金币/边沿锁存只要有一条车道送达就算消耗，不能双扣也不能丢
          this._pendingGot = [];
          this._edgeLatch.u = false;
          this._edgeLatch.d = false;
        }
      }
      // 库写成功：兜底车道节奏逐步恢复（×0.7 回落到 400ms）。
      // 只有真的写库成功才恢复——中继发送成功不能替库「疗伤」，
      // 否则退避立刻被抵消，限流压力降不下来。
      if (dbWritten && (this._dbInterval || C.MARIO_SYNC_MS) > C.MARIO_SYNC_MS) {
        this._dbInterval = Math.max(C.MARIO_SYNC_MS,
          Math.round((this._dbInterval || C.MARIO_SYNC_MS) * 0.7));
      }
    } catch (err) {
      log.e('[mario] db sync fail', err && (err.errCode || err.errMsg), err);
      this._dbFails = (this._dbFails || 0) + 1;
      this._lastDbErr = String(err && (err.errCode || err.errMsg) || '').slice(0, 60);
      // 兜底车道写失败（多半是限流）：独立加倍退避
      // 400 → 800 → 1600（C.MARIO_SYNC_MIN_MS 封顶）
      // 中继在跑时静默处理，不弹 toast（快车道上的对局不受影响）。
      const cur = this._dbInterval || C.MARIO_SYNC_MS;
      this._dbInterval = Math.min(C.MARIO_SYNC_MIN_MS, cur * 2);
      if (this._lastSyncOk) {
        this._lastSyncOk = false;
        if (!relayUp) wx.showToast({ title: '网络不稳定，已降低同步频率', icon: 'none' });
      }
    }
  },

  /* ========== 虚拟按键 ========== */

  onBtnDown(e) {
    const k = e.currentTarget.dataset.k;
    if (!this._inputs) return;
    const seat = this.data.mode === 'online' ? this.data.mySeat : 1;
    const i = this._inputs[seat];
    if (!i) return;
    if (k === 'l') i.left = true;
    else if (k === 'r') i.right = true;
    else if (k === 'u') { i.up = true; this._edgeLatch.u = true; }
    else if (k === 'd') { i.down = true; this._edgeLatch.d = true; }
    else if (k === 'run') i.run = true;
  },

  onBtnUp(e) {
    const k = e.currentTarget.dataset.k;
    if (!this._inputs) return;
    const seat = this.data.mode === 'online' ? this.data.mySeat : 1;
    const i = this._inputs[seat];
    if (!i) return;
    if (k === 'l') i.left = false;
    else if (k === 'r') i.right = false;
    else if (k === 'u') i.up = false;
    else if (k === 'd') i.down = false;
    else if (k === 'run') i.run = false;
  },

  /* ========== 大厅输入 ========== */

  onRoomNoInput(e) {
    this.setData({ roomNoInput: String(e.detail.value).replace(/\D/g, '').slice(0, 4) });
  },

  leaveRoom() {
    wx.showModal({
      title: '离开对局',
      content: '离开后当前闯关将结束，确定吗？',
      success: async (res) => {
        if (!res.confirm) return;
        if (this._roomId) {
          const db = wx.cloud.database();
          try {
            await db.collection(COLLECTION).doc(this._roomId).update({
              data: { status: 'ended', leaver: this.data.mySeat }
            });
          } catch (e) { log.e('[mario] leave notify fail', e); }
        }
        // 中继在线：发 bye 让对方立刻收到「已离开」（区别于掉线）
        if (this._relay) this._relay.bye();
        this._stopInputPoll();
        this._closeRelay();
        roomkit.closeWatch(this);
        this._roomId = null;
        this._stopLoop();
        this._resetCanvas();
        this.setData({ stage: 'menu' });
      }
    });
  },

  onShareAppMessage() {
    const no = this.data.roomNo;
    return {
      title: no ? '来和我一起闯关！房间号 ' + no : '来小笨游戏大厅一起玩！',
      path: no
        ? '/subpackages/games/mario/mario?roomNo=' + no
        : '/pages/games/games'
    };
  },

  /* ========== Canvas ========== */

  _ensureCanvas() {
    if (this._canvas) return;
    const q = wx.createSelectorQuery().in(this);
    q.select('#gcanvas').fields({ node: true, size: true }).exec((res) => {
      if (this._destroyed) return;
      const info = res && res[0];
      if (!info || !info.node) {
        // canvas 尚未挂载（wx:if 刚渲染）——主循环会持续重试，带硬上限防死循环
        this._canvasRetry = (this._canvasRetry || 0) + 1;
        if (this._canvasRetry > C.CANVAS_RETRY_MAX) {
          wx.showToast({ title: '画面加载失败，请重进房间', icon: 'none' });
          return;
        }
        this._canvasRetryTimer = setTimeout(() => this._ensureCanvas(), C.CANVAS_RETRY_DELAY);
        return;
      }
      const canvas = info.node;
      const dpr = roomkit.getDpr();
      // 用实际渲染尺寸而非 _measure 的估算值，避免 canvas.width 与 CSS 宽度
      // 不匹配导致画面被拉伸（表现为瓦片/人物变形或干脆画丢）
      // ==== 单一尺寸源 ====
      // 用 wxml 的 {{canvasW}}/{{canvasH}}（this.data）作为唯一真值：
      // CSS 宽、canvas.width、绘制坐标系（viewW/viewH）、_scale 全部同源。
      // 之前用 info.size 改 _scale 而 viewW 仍用 this.data.canvasW，两者不同
      // → 格距与画布可见范围对不上 → 人物画到画布外（只看到天空）。
      const cw = Math.round(this.data.canvasW);
      const ch = Math.round(this.data.canvasH);
      canvas.width = cw * dpr;
      canvas.height = ch * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      this._canvas = canvas;
      this._ctx = ctx;
      // 载入玩家形象帧（异步；未就绪时渲染层用矢量兜底）
      this._loadSprites(canvas);
      // 每格像素与 viewW 必须同源（20 格宽）
      this._scale = cw / 15;
      log.d('[mario] canvas ' + cw + 'x' + ch + ' scale=' + this._scale.toFixed(2));
      this._canvasRetry = 0;
    });
  }
});
