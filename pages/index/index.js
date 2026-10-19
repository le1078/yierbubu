const {
  ZODIAC,
  getYearAnimalIndex,
  randomDraw
} = require('../../utils/zodiac.js');
const cloud = require('../../utils/cloudstore.js');
const C = require('../../utils/constants.js');

const COVER_TEXTS = ['刮开有惊喜', '财运亨通', '手气不错', '好运连连', '福气满满', '刮出大运'];
const DEFAULT_COVER = COVER_TEXTS[0];

// 写云端记录：读最新 → unshift → 截断上限 → 写回（cloudstore 内部已串行化）
const RECORD_CAP = 200;

async function pushRecord(item) {
  try {
    const records = await cloud.loadRecords();
    records.unshift(item);
    await cloud.saveRecords(records.slice(0, RECORD_CAP));
  } catch (e) {
    console.error('记录云端写入失败', e);
  }
}

async function removeRecordById(id) {
  try {
    const records = await cloud.loadRecords();
    const next = records.filter(r => r.id !== id);
    if (next.length !== records.length) await cloud.saveRecords(next);
  } catch (e) {
    console.error('记录删除失败', e);
  }
}

Page({
  data: {
    year: 2026,
    yearText: '2026',
    yearAnimal: '',
    counts: [1, 2, 3, 4, 5, 6, 7, 8],
    count: 1,
    results: [],
    rolling: false,

    tab: 'shake',
    scratchCount: 1,
    scratchCards: []
  },

  onLoad(options) {
    const year = new Date().getFullYear();
    this.buildYear(year);
    // 支持分享 / 深链直达某个栏目：?tab=shengxiao
    const t = options && options.tab;
    if (t === 'shake' || t === 'scratch' || t === 'shengxiao') {
      this.setData({ tab: t });
    }
  },

  buildYear(year) {
    const yi = getYearAnimalIndex(year);
    this.setData({
      year,
      yearText: String(year),
      yearAnimal: ZODIAC[yi].name
    });
  },

  setCount(e) {
    this.setData({ count: e.currentTarget.dataset.n });
  },

  // 分享：当前在「小笨生肖」栏目时，分享链接直达该栏目
  onShareAppMessage() {
    const isSx = this.data.tab === 'shengxiao';
    return {
      title: isSx ? '一二布布小笨肖 · 看看谁跟你最合拍' : '一二布布来财啦',
      path: '/pages/index/index' + (isSx ? '?tab=shengxiao' : '')
    };
  },

  onDraw() {
    if (this.data.rolling) return;
    this.setData({ rolling: true });
    let ticks = 0;
    const total = this.data.count;
    let out = [];
    this._timer = setInterval(() => {
      out = [];
      for (let i = 0; i < total; i++) out.push(randomDraw(this.data.year));
      this.setData({ results: out });
      ticks += 1;
      if (ticks >= C.SHAKE_TICKS) {
        clearInterval(this._timer);
        this._timer = null;
        // 一次抽取 N 个 → 合并为 1 条记录（items 数组），写入云端共享
        pushRecord({
          id: Date.now() + '_' + Math.random().toString(36).slice(2),
          ts: Date.now(),
          year: this.data.year,
          kind: 'shake',
          items: out
        });
        // 合并为一次 setData：原来这里重复写了一遍同一个 results 数组
        this.setData({ rolling: false });
      }
    }, 60);
  },

  onHide() {
    // 注意：首页是 tab 页，切 tab 也会触发 onHide，所以这里不能置 _destroyed，
    // 否则切回来 initScratch 会被 _destroyed 拦掉，卡片再也画不上涂层。
    // 只清理定时器（避免后台空跑），canvas 引用保留到 onUnload 再释放。
    this._clearScratchTimers();
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  },

  onUnload() {
    this._destroyed = true;
    this._clearScratchTimers();
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    // canvas 节点与 2d context 引用：页面销毁后必须释放，否则持有已销毁节点造成泄漏
    this._scratch = null;
  },

  // 统一清理刮刮卡相关的定时器（canvas 重试链 + 每张卡的节流帧）
  _clearScratchTimers() {
    if (this._scratchRetryTimer) { clearTimeout(this._scratchRetryTimer); this._scratchRetryTimer = null; }
    if (this._scratch) {
      this._scratch.forEach((s) => {
        if (s && s._throttleTimer) { clearTimeout(s._throttleTimer); s._throttleTimer = null; }
      });
    }
  },

  /* ===== 刮一刮玩法 ===== */
  switchTab(e) {
    const t = e.currentTarget.dataset.t;
    if (t === this.data.tab) return;
    const patch = { tab: t };
    // 切回刮一刮且已有未刮开的卡片时，先把它们的 coated 复位为 false，
    // 让 CSS 覆盖层重新盖住答案；等 initScratch 真正把涂层画上再移除覆盖层。
    // 这样无论 canvas 何时就绪，答案都不会在涂层到位前露出来。
    if (t === 'scratch') {
      const cards = this.data.scratchCards.slice();
      let changed = false;
      cards.forEach((c) => { if (!c.revealed && c.coated) { c.coated = false; changed = true; } });
      if (changed) patch.scratchCards = cards;
    }
    this.setData(patch, () => {
      // 切回刮一刮且已有卡片时，重建 canvas（切走时 canvas 已被销毁）
      if (t === 'scratch' && this.data.scratchCards.length > 0) this.initScratch();
    });
  },

  setScratchCount(e) {
    this.setData({ scratchCount: Number(e.currentTarget.dataset.n) });
  },

  onScratchGenerate() {
    // 重新生成：先清掉上一批次已写入的刮刮记录，避免记录页被重复生成刷屏
    this.clearLastScratchRecord();
    const n = this.data.scratchCount;
    const cards = [];
    for (let i = 0; i < n; i++) {
      cards.push({
        id: Date.now() + '-' + i + '-' + Math.random().toString(36).slice(2),
        result: randomDraw(this.data.year),
        cover: COVER_TEXTS[Math.floor(Math.random() * COVER_TEXTS.length)],
        revealed: false,
        coated: false
      });
    }
    // 注意：记录改为「刮完才写」，这里不再写 yb_records
    // 新卡 coated 默认 false → 由 CSS 覆盖层先盖住答案，initScratch 画好涂层后才移除覆盖层
    this.setData({ scratchCards: cards }, () => { this.initScratch(); });
  },

  initScratch(retry = 0) {
    const q = wx.createSelectorQuery().in(this);
    q.selectAll('.scratch-canvas').fields({ node: true, size: true, dataset: true }).exec((res) => {
      const list = (res && res[0]) || [];
      const expected = this.data.scratchCards.filter(c => !c.revealed && !c.coated).length;
      // 画布尚未布局完成（查到尺寸为 0）或尚未渲染出来：延迟重试。
      // 只要还没成功画上涂层，对应卡片的 coated 就保持 false → CSS 覆盖层一直挡着答案，绝不露底。
      if (retry < C.SCRATCH_INIT_RETRY && (list.length !== expected || list.some(c => !c.width || !c.height))) {
        // 重试 timer 句柄存起来，onUnload 时统一清理，避免对已卸载页面 setData
        this._scratchRetryTimer = setTimeout(() => {
          if (this._destroyed) return;
          this.initScratch(retry + 1);
        }, C.SCRATCH_RETRY_DELAY);
        return;
      }
      if (this._destroyed) return;
      let dpr = Math.min(C.SCRATCH_MAX_DPR, (wx.getWindowInfo && wx.getWindowInfo().pixelRatio) || 2);
      const cards = this.data.scratchCards.slice();
      this._scratch = [];
      let drewAny = false;
      list.forEach((c) => {
        const i = c.dataset ? Number(c.dataset.index) : this._scratch.length;
        const canvas = c.node;
        const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
        if (!ctx) return; // 画布上下文未就绪：保持该卡 covered（安全，不露底）
        canvas.width = Math.round(c.width * dpr);
        canvas.height = Math.round(c.height * dpr);
        ctx.scale(dpr, dpr);
        const w = c.width, h = c.height;
        // 粉箔底渐变
        const grad = ctx.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, '#FFD3E0');
        grad.addColorStop(0.5, '#FFB0C6');
        grad.addColorStop(1, '#FF93B0');
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
        // 斜纹反光（箔质感）
        ctx.save();
        ctx.globalAlpha = 0.10;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        for (let x = -h; x < w; x += 10) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x + h, h);
          ctx.stroke();
        }
        ctx.restore();
        // 随机高光斑点
        ctx.save();
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = '#ffffff';
        for (let k = 0; k < 6; k++) {
          ctx.beginPath();
          ctx.arc(Math.random() * w, Math.random() * h, 4 + Math.random() * 8, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
        // 金属内描边
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 2;
        ctx.strokeRect(4, 4, w - 8, h - 8);
        // 随机文案（按真实卡片索引取，切 tab 重建时不串位）
        const cover = this.data.scratchCards[i] && this.data.scratchCards[i].cover;
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.font = 'bold 16px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(cover || DEFAULT_COVER, w / 2, h / 2);
        this._scratch[i] = { canvas, ctx, w, h, lastX: null, lastY: null };
        if (cards[i]) cards[i].coated = true; // 涂层已真正画上 → 才允许移除 CSS 覆盖层
        drewAny = true;
      });
      // 仅把"已成功画上涂层"的卡标记为 coated；未就绪的卡保持覆盖层（不露底）
      if (drewAny) this.setData({ scratchCards: cards });
    });
  },

  onScratchStart(e) {
    const idx = e.currentTarget.dataset.index;
    const s = this._scratch && this._scratch[idx];
    if (!s) return;
    s.lastX = null; s.lastY = null;
  },

  onScratchMove(e) {
    const idx = e.currentTarget.dataset.index;
    // 已翻开或涂层已销毁的卡直接忽略，避免同帧残留事件把答案抠出来
    const card = this.data.scratchCards[idx];
    if (!card || card.revealed) return;
    const s = this._scratch && this._scratch[idx];
    if (!s) return;
    const t = e.touches[0];
    if (t.x == null || t.y == null) return;
    const x = t.x, y = t.y;

    // 时间节流：touchmove 可达 60~120Hz，每事件都直接画会占满主线程。
    // 16ms 一帧（约 60fps）足够顺滑，且能保证线段的连续性
    const now = Date.now();
    if (s._lastDrawAt && now - s._lastDrawAt < 16) {
      // 缓存最新坐标，下一个帧用线段补上，避免快速滑动出现断点
      s._pendingX = x; s._pendingY = y;
      if (!s._throttleTimer) {
        s._throttleTimer = setTimeout(() => {
          s._throttleTimer = null;
          if (this._destroyed) return;
          this._drawScratchStroke(idx, s._pendingX, s._pendingY);
        }, 16);
      }
      return;
    }
    s._lastDrawAt = now;
    this._drawScratchStroke(idx, x, y);
  },

  // 单次擦除笔画：从上一坐标画线到当前坐标（首次为圆点）
  _drawScratchStroke(idx, x, y) {
    const s = this._scratch && this._scratch[idx];
    if (!s) return;
    const ctx = s.ctx;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = Math.max(18, s.w * 0.18);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (s.lastX == null) {
      ctx.arc(x, y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.moveTo(s.lastX, s.lastY);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    s.lastX = x; s.lastY = y;
    // 实时检测刮开比例：每 N 次 move 检测一次，避免每帧读像素造成卡顿
    s._tick = (s._tick || 0) + 1;
    if (s._tick % C.SCRATCH_CHECK_EVERY === 0) this._checkReveal(idx);
  },

  onScratchEnd(e) {
    const idx = e.currentTarget.dataset.index;
    // 松手时兜底检测一次（刮到 80% 即翻开，未到则保留涂层继续刮）
    this._checkReveal(idx);
  },

  // 计算某张卡的刮开比例，超过阈值自动完全翻开
  _checkReveal(idx) {
    const s = this._scratch && this._scratch[idx];
    if (!s) return;
    const card = this.data.scratchCards[idx];
    if (card && card.revealed) return;
    let clear = 0, total = 0;
    try {
      // 只读画布中心区域（边缘留 10% 边距）：getImageData 是全量拷贝，
      // 卡片尺寸 200x220 * dpr2 ≈ 700KB/次，缩窄范围能显著降低开销
      const cw = s.canvas.width, ch = s.canvas.height;
      const mx = Math.floor(cw * 0.1), my = Math.floor(ch * 0.1);
      const rw = cw - mx * 2, rh = ch - my * 2;
      const img = s.ctx.getImageData(mx, my, rw, rh).data;
      const step = 4 * C.SCRATCH_SAMPLE_STEP; // 采样加密，更接近真实视觉比例
      // alpha < 50 就算已刮开：微信小程序 canvas 擦除边缘会残留半透明像素，人眼已看不见
      for (let i = 3; i < img.length; i += step) { total++; if (img[i] < 50) clear++; }
    } catch (err) { return; }
    const ratio = total > 0 ? clear / total : 0;
    if (ratio > C.SCRATCH_REVEAL_RATIO) {
      const cards = this.data.scratchCards.slice();
      if (cards[idx]) cards[idx].revealed = true;
      this.setData({ scratchCards: cards });
      // 清掉该卡的节流定时器并释放 canvas 引用（已翻开的卡不再需要）
      if (s._throttleTimer) { clearTimeout(s._throttleTimer); s._throttleTimer = null; }
      this._scratch[idx] = null;
      // 全部刮完才写一条合并记录
      if (cards.every(c => c.revealed)) this.flushScratchRecord();
    }
  },

  onScratchRevealAll() {
    const cards = this.data.scratchCards.slice();
    if (!cards.length) return;
    let changed = false;
    cards.forEach((c, i) => {
      if (!c.revealed) { c.revealed = true; this._scratch[i] = null; changed = true; }
    });
    if (!changed) return;
    this.setData({ scratchCards: cards }, () => { this.flushScratchRecord(); });
  },

  flushScratchRecord() {
    if (this._lastScratchRecordId) return; // 已写过则跳过，防重复
    const items = this.data.scratchCards.map(c => c.result);
    if (!items.length) return;
    const rec = { id: Date.now() + '_' + Math.random().toString(36).slice(2), ts: Date.now(), year: this.data.year, kind: 'scratch', items };
    pushRecord(rec);
    this._lastScratchRecordId = rec.id;
  },

  clearLastScratchRecord() {
    if (!this._lastScratchRecordId) return;
    removeRecordById(this._lastScratchRecordId);
    this._lastScratchRecordId = null;
  }
});
