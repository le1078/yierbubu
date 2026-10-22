// 小笨马里奥 · 页面
// 双人联机闯关：host 权威 + guest 输入中继 + 客户端预测。
//
// ============ 联机同步协议（重点，改前先读） ============
// 云开发 watch 推送延迟 200~500ms，且单文档持续高频写会触发限流。
// 60fps 实时同步不可行，所以：
//
//   mario_rooms 文档：
//     world:  JSON 字符串，只有 host（座位1）写，5Hz
//             含双方玩家状态 + 敌人 + 剩余金币 + Boss
//     input2: JSON 字符串，只有 guest（座位2）写，5Hz
//             含按键状态 + 已吃掉的金币 id
//
//   每个座位只写自己的字段 → 两个写者永不冲突，
//   不需要 read-modify-write，规避云数据库嵌套数组更新的最大坑。
//
//   host 侧：本地 60Hz 确定性模拟 → 读 input2 → 每 200ms 写一次 world
//   guest 侧：每 200ms 写一次 input2；收到 world 后：
//             · 自己的角色用本地输入做死区推算（手感即时）
//             · host 角色 / 敌人 / 金币 / Boss 用权威值 + 帧间插值
//   金币以 host 为权威：guest 只上报 got:[coinId]，host 校验后移除，不双扣
//
// 预期（必须告知用户）：对手位置仍有可感知的 200~500ms 延迟，
// 这是云 watch 的固有限制，客户端预测只能掩盖、不能消除。

const COLLECTION = 'mario_rooms';
const C = require('../../../utils/constants.js');
const log = require('../../../utils/log.js');
const roomkit = require('../../../utils/roomkit.js');
const EN = require('./engine.js');
const LV = require('./levels.js');
const R = require('./render.js');

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
    landscape: false
  },

  onLoad(options) {
    if (options && options.roomNo) {
      this._autoJoin = String(options.roomNo);
      this.setData({ stage: 'lobby', roomNoInput: String(options.roomNo) });
    }
  },

  onReady() {
    this._measure();
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
    // 切后台：停循环 + 停写入（否则白烧云数据库额度）
    this._paused = true;
    this._stopLoop();
  },

  onShow() {
    if (this.data.stage === 'playing' && !this._paused) this._startLoop();
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

  /* ========== 菜单 ========== */

  pickMode(e) {
    this.setData({ mode: e.currentTarget.dataset.mode });
  },

  toggleCoop() {
    this.setData({ coop: !this.data.coop });
  },

  startSolo() {
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
    roomkit.closeWatch(this);
    this._roomId = null;
    this._stopLoop();
    this.setData({ stage: 'menu' });
  },

  /* ========== 关卡装载 ========== */

  _setupLevel(idx, solo) {
    const spec = LV.LEVEL_SPECS[idx];
    const level = EN.loadLevel(LV.LEVELS[idx], spec);
    this._level = level;
    this._players = solo
      ? [EN.makePlayer(level, 1)]
      : [EN.makePlayer(level, 1), EN.makePlayer(level, 2)];
    if (!solo) {
      // 双人出生点错开，避免叠在一起
      this._players[1].x = level.start.col + 2.5;
      this._players[1].respawnX = level.start.col + 2.5;
    }
    this._inputs = { 1: EN.makeInput(), 2: EN.makeInput() };
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
    const n = (this.data.level + 1) % LV.LEVEL_SPECS.length;
    this._setupLevel(n, this.data.mode === 'solo');
    this.setData({ stage: 'playing', winText: '' }, () => {
      this._over = false;
      this._startLoop();
    });
  },

  restart() {
    this._setupLevel(this.data.level, this.data.mode === 'solo');
    this.setData({ stage: 'playing', winText: '' }, () => {
      this._over = false;
      this._startLoop();
    });
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
        input2: JSON.stringify({ t: 0, keys: { l: 0, r: 0, u: 0 }, got: [] }),
        winner: 0
      });
      this._roomId = res.roomId;
      this._setupLevel(0);
      this.setData({ stage: 'waiting', roomNo: res.roomNo, mySeat: 1 });
      this._startWatch();
    } catch (err) {
      log.e('[mario] createRoom fail', err);
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
        data: {
          status: 'playing',
          'seats.2': 1,
          level: room.level || 0,
          updatedAt: db.serverDate()
        }
      });
      const lvIdx = room.level || 0;
      this._setupLevel(lvIdx);
      // guest 是座位 2，先按 host 的世界快照对齐一帧
      if (room.world) this._applyWorld(JSON.parse(room.world), true);
      this.setData({
        stage: 'playing',
        roomNo,
        mySeat: 2,
        coop: room.coop === 1,
        statusText: '联机闯关 · P2'
      });
      this._startWatch();
      this._startLoop();
    } catch (err) {
      log.e('[mario] joinRoom fail', err);
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
    const me = this.data.mySeat;

    // host 在等待页：对方加入后开局
    if (this.data.stage === 'waiting') {
      if (room.status === 'playing') {
        this.setData({
          stage: 'playing',
          statusText: '联机闯关 · P1',
          metaText: '房间 ' + (room.roomNo || this.data.roomNo) + ' · ' + (this.data.coop ? '合作' : '竞速')
        }, () => {
          this._over = false;
          this._startLoop();
        });
      }
      return;
    }

    // 对方离开
    if (room.status === 'ended' && room.leaver && room.leaver !== me && !this._leaverHandled) {
      this._leaverHandled = true;
      this._stopLoop();
      roomkit.closeWatch(this);
      this.setData({ stage: 'ended', winText: '对方已离开房间', statusText: '对局结束' });
      return;
    }

    if (me === 2 && room.world) {
      // guest：应用 host 的权威世界
      try {
        this._applyWorld(JSON.parse(room.world), false);
      } catch (e) {
        log.e('[mario] parse world fail', e);
      }
    }
    if (me === 1 && room.input2) {
      // host：读取 guest 的输入
      try {
        this._applyInput2(JSON.parse(room.input2));
      } catch (e) {
        log.e('[mario] parse input2 fail', e);
      }
    }
  },

  // 把 host 的权威世界套到本地（guest 侧）
  _applyWorld(w, initial) {
    if (!this._level || !w) return;
    // 换关卡了要重载
    if (w.level !== undefined && w.level !== this.data.level) {
      this._setupLevel(w.level);
    }
    // 自己的角色：死区推算，不直接用权威值（否则延迟直接体现在手感上）
    const me = this._players[this.data.mySeat - 1];
    const myW = this.data.mySeat === 1 ? w.p1 : w.p2;
    if (myW && me) {
      const dx = Math.abs(myW.x - me.x);
      const dy = Math.abs(myW.y - me.y);
      // 偏差超过阈值才拉回（死区），避免每帧抖动
      if (dx > 0.8 || dy > 0.8 || initial) {
        me.x = myW.x; me.y = myW.y;
        me.vx = myW.vx; me.vy = myW.vy;
        me.lives = myW.lv;
        me.coins = myW.cn;
        if (myW.st === 'dead' || myW.st === 'done') me.state = myW.st;
      }
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
      opp.lives = oppW.lv;
      opp.coins = oppW.cn;
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
    if (w.bs && this._level.boss) {
      this._level.boss.hp = w.bs[0];
      this._level.boss.phase = w.bs[1];
      this._level.boss._tx = w.bs[2];
    }
  },

  // 把 guest 的输入套到本地（host 侧）
  _applyInput2(inp) {
    if (!inp || !this._inputs) return;
    const i2 = this._inputs[2];
    if (!i2) return;
    i2.left = !!inp.keys.l;
    i2.right = !!inp.keys.r;
    i2.up = !!inp.keys.u;
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
    // canvas 在 wx:if 渲染完成后才挂载，主循环里轮询获取（比猜时机可靠）
    if (!this._ctx) this._ensureCanvas();

    const now = Date.now();
    // 累积真实经过时间，按固定 1/60 步长消耗（掉帧时不会变速）
    this._acc += Math.min(now - this._lastFrame, 250);   // 钳 250ms，防切后台后暴冲
    this._lastFrame = now;
    let steps = 0;
    while (this._acc >= C.MARIO_TICK_MS && steps < 8) {
      EN.stepWorld(this._level, this._players, this._inputs, EN.TICK);
      this._acc -= C.MARIO_TICK_MS;
      steps++;
    }

    this._interpolate();
    this._render();
    this._syncHud();

    // 胜负检查
    this._checkEnd();

    // 云同步（5Hz）
    this._syncAcc += (now - (this._lastSyncAt || now));
    if (this._syncAcc >= this.data.syncMs) {
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
    // 倒计时
    if (this._level && this._level.timeLeft !== this.data.timeLeft) {
      patch.timeLeft = this._level.timeLeft;
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
    if (this._level.boss && this._level.boss._tx !== undefined) {
      this._level.boss.x = lerp(this._level.boss.x, this._level.boss._tx);
    }
  },

  _render() {
    const ctx = this._ctx;
    if (!ctx || !this._level) return;
    const cam = R.cameraX(this._level, (this._players[0] || { x: 0 }).x, this.data.canvasW / this._scale);
    const camY = R.cameraY(this._level, (this._players[0] || { y: 0 }).y, this.data.canvasH / this._scale);
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
      sprites: this._sprites
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
    const cleared = this.data.coop
      ? EN.isLevelCleared(this._level, this._players)
      : EN.raceWinner(this._level, this._players) !== 0;
    if (cleared) {
      this._over = true;
      this._stopLoop();
      const w = this.data.coop ? null : EN.raceWinner(this._level, this._players);
      const text = this.data.mode === 'solo'
        ? '🎉 通关！'
        : (this.data.coop
          ? '🎉 合作通关！'
          : (w === this.data.mySeat ? '🎉 你赢了！' : '😢 对方先到终点'));
      this.setData({ stage: 'ended', winText: text, statusText: '本关完成' });
      if (this.data.mode === 'online' && this._roomId) {
        const db = wx.cloud.database();
        db.collection(COLLECTION).doc(this._roomId).update({
          data: { winner: this.data.mySeat }
        }).catch(e => log.e('[mario] set winner fail', e));
      }
      return;
    }
    if (EN.isGameOver(this._level, this._players)) {
      this._over = true;
      this._stopLoop();
      this.setData({ stage: 'ended', winText: '💀 游戏结束', statusText: '命用完了' });
    }
  },

  /* ========== 云同步 ========== */

  async _doSync() {
    if (this._destroyed || !this._roomId) return;
    const db = wx.cloud.database();
    const me = this.data.mySeat;
    try {
      if (me === 1) {
        // host 写权威世界
        const w = EN.worldToWire(this._level, this._players);
        w.level = this.data.level;
        await db.collection(COLLECTION).doc(this._roomId).update({
          data: { world: JSON.stringify(w) }
        });
      } else {
        // guest 只写输入 + 已吃金币
        const i2 = this._inputs[2];
        const payload = {
          t: Math.round(this._level.time * 1000),
          keys: { l: i2.left ? 1 : 0, r: i2.right ? 1 : 0, u: i2.up ? 1 : 0, rn: i2.run ? 1 : 0 },
          got: this._pendingGot || []
        };
        await db.collection(COLLECTION).doc(this._roomId).update({
          data: { input2: JSON.stringify(payload) }
        });
        this._pendingGot = [];
      }
      // 写成功：逐步恢复同步频率
      if (!this._lastSyncOk) {
        this._lastSyncOk = true;
        this.setData({ syncMs: C.MARIO_SYNC_MS });
      }
    } catch (err) {
      log.e('[mario] sync fail', err && err.errMsg);
      // 写失败（多半是限流）：自动降频，避免连续失败被云数据库封
      if (this._lastSyncOk) {
        this._lastSyncOk = false;
        const slow = this.data.syncMs >= C.MARIO_SYNC_MS ? C.MARIO_SYNC_SLOW_MS : C.MARIO_SYNC_MIN_MS;
        this.setData({ syncMs: slow });
        wx.showToast({ title: '网络不稳定，已降低同步频率', icon: 'none' });
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
    else if (k === 'u') i.up = true;
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
        roomkit.closeWatch(this);
        this._roomId = null;
        this._stopLoop();
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
