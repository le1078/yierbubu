// 六合取码 · 来财页第五个栏目
// 规则与 zodiac-web/pick.html 一致：从 1–49 里随机取 1~6 个号，
// 可选 6+1（6 个正码 + 1 个特别号，特别号不会和正码重复）。
// 号码与生肖的映射完全复用 utils/zodiac.js，取码只用 Math.random 洗牌，不做任何人为指定。
//
// 展示区固定 6 个正码位 + 1 个特别号位：选不满时后面留空白位，不改变布局宽度，
// 这样连摇几次不会因为数量变化把整块区域抖来抖去。
const { getZodiacByNumber } = require('../../utils/zodiac.js');
const C = require('../../utils/constants.js');

const OPTIONS = [
  { label: '1', count: 1, special: false },
  { label: '2', count: 2, special: false },
  { label: '3', count: 3, special: false },
  { label: '4', count: 4, special: false },
  { label: '5', count: 5, special: false },
  { label: '6', count: 6, special: false },
  { label: '6+1', count: 6, special: true }
];

const MAIN_SLOTS = 6;        // 正码位固定 6 个
const STORE_KEY = 'yb_pick_v1';
const HIST_MAX = 12;         // 取码记录只留最近 12 条，避免无限膨胀
const MOOD = {
  idle: '/assets/bottom_left.gif',
  win: '/assets/bottom_right.gif'
};

function pad2(n) { return n < 10 ? '0' + n : String(n); }

function makeItem(n, special) {
  const z = getZodiacByNumber(new Date().getFullYear(), n);
  return { num: pad2(n), name: z.name, emoji: z.emoji, color: z.color, special: !!special };
}

// 空白位：占住 6+1 的位置，号码显示为「—」
function blankSlot(i, isSpecial) {
  return {
    i: i,
    filled: false,
    num: '—',
    name: '',
    emoji: '·',
    color: '#F3E9E2',
    special: !!isSpecial
  };
}

// 不放回抽样：先洗牌再切前 k 个，保证同一次取码里没有重复号码
function pickDistinct(k, exclude) {
  const ex = exclude || [];
  const pool = [];
  for (let n = 1; n <= 49; n++) {
    if (ex.indexOf(n) === -1) pool.push(n);
  }
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return pool.slice(0, k);
}

function hintOf(opt) {
  if (!opt) return '';
  return opt.special
    ? '取 6 个正码，再加 1 个特别号（共 7 个，互不重复）'
    : '从 1–49 里取 ' + opt.count + ' 个互不重复的号码';
}

function freshSlots() {
  const arr = [];
  for (let i = 0; i < MAIN_SLOTS; i++) arr.push(blankSlot(i, false));
  return arr;
}

// 存档条目兜底：chips/special 结构不对就丢弃，别让 attached 里的 restore 抛异常
function sanitizeEntry(e) {
  if (!e || typeof e !== 'object' || !Array.isArray(e.chips)) return null;
  const chips = e.chips
    .filter((c) => c && typeof c.num === 'string')
    .slice(0, MAIN_SLOTS);
  if (!chips.length) return null;
  return {
    key: typeof e.key === 'string' && e.key ? e.key : String(Date.now()),
    time: typeof e.time === 'string' ? e.time : '',
    chips: chips,
    special: e.special && typeof e.special.num === 'string' ? e.special : null
  };
}

Component({
  properties: {
    // 首页用 display 保活，切走只是隐藏：摇号必须跟着停，
    // 不能在看不见的地方继续摇完并把结果写进「上次摇到」
    active: {
      type: Boolean,
      value: false,
      observer(v) {
        if (!this._loaded) return;
        if (!v) this._deactivate();
      }
    }
  },

  data: {
    options: OPTIONS.map((o) => ({ label: o.label })),
    optIdx: 6,
    optHint: hintOf(OPTIONS[6]),
    slots: freshSlots(),
    special: blankSlot(MAIN_SLOTS, true),
    rolling: false,
    speech: '选好个数，我来帮你摇～',
    mood: MOOD.idle,
    history: []
  },

  lifetimes: {
    attached() {
      this._loaded = true;
      this.restore();
    },
    detached() {
      this._stopRoll();
      this._loaded = false;
    }
  },

  pageLifetimes: {
    // 小程序整个退到后台时同样停摇（组件还在，定时器不能空跑）
    hide() {
      this._deactivate();
    }
  },

  methods: {
    // 切走/进后台：停掉摇号并把「正在摇」状态复位，回来可以直接再摇
    _deactivate() {
      if (!this._timer) return;
      this._stopRoll();
      if (this.data.rolling) {
        this.setData({ rolling: false, speech: '刚才摇到一半被打断了，再摇一次吧～' });
      }
    },
    setOpt(e) {
      const i = Number(e.currentTarget.dataset.i);
      if (isNaN(i) || i === this.data.optIdx || this.data.rolling) return;
      this.setData({ optIdx: i, optHint: hintOf(OPTIONS[i]) });
      this.persist();
    },

    // 一次取码：只产出数据，不碰历史，滚动预览和最终结果共用
    _draw(opt) {
      const nums = pickDistinct(opt.count);
      const items = nums.map((n) => makeItem(n));
      const slots = freshSlots();
      items.forEach((it, i) => {
        slots[i] = Object.assign({ i: i, filled: true }, it);
      });
      let special = blankSlot(MAIN_SLOTS, true);
      if (opt.special) {
        special = Object.assign(
          { i: MAIN_SLOTS, filled: true },
          makeItem(pickDistinct(1, nums)[0], true)
        );
      }
      return { slots: slots, special: special, items: items };
    },

    _stopRoll() {
      if (this._timer) {
        clearInterval(this._timer);
        this._timer = null;
      }
    },

    // 和「摇一摇来财啦」同一套节奏：每 60ms 换一批号，连跑 10 次再定稿
    onGenerate() {
      if (this.data.rolling) return;
      const opt = OPTIONS[this.data.optIdx];

      this.setData({ rolling: true, speech: '摇一摇…', mood: MOOD.idle });
      let ticks = 0;

      this._timer = setInterval(() => {
        ticks += 1;
        if (ticks >= C.SHAKE_TICKS) {
          this._stopRoll();
          this._settle(opt);
          return;
        }
        const preview = this._draw(opt);
        this.setData({ slots: preview.slots, special: preview.special });
      }, C.SHAKE_INTERVAL);
    },

    _settle(opt) {
      const out = this._draw(opt);

      const now = new Date();
      const entry = {
        key: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 6),
        time: pad2(now.getHours()) + ':' + pad2(now.getMinutes()),
        chips: out.items,
        special: opt.special ? out.special : null
      };
      const history = [entry].concat(this.data.history).slice(0, HIST_MAX);

      this.setData({
        slots: out.slots,
        special: out.special,
        rolling: false,
        history: history,
        mood: MOOD.win,
        speech: opt.special
          ? '摇好啦：' + out.items.length + ' 个正码 ＋ 1 个特别号～'
          : '摇好啦：' + out.items.length + ' 个号。随手一摇，别当真哦～'
      });
      this.persist();
    },

    onCopy() {
      if (this.data.rolling) {
        wx.showToast({ title: '正在摇，稍等一下', icon: 'none' });
        return;
      }
      const arr = this.data.slots.filter((s) => s.filled).map((s) => s.num);
      if (this.data.special.filled) arr.push('+' + this.data.special.num);
      if (!arr.length) {
        wx.showToast({ title: '先摇一组号码吧', icon: 'none' });
        return;
      }
      wx.setClipboardData({ data: arr.join(' ') });
    },

    // ---------- 记录 ----------
    onClearHistory() {
      const n = this.data.history.length;
      if (!n) {
        wx.showToast({ title: '还没有记录', icon: 'none' });
        return;
      }
      wx.showModal({
        title: '清空取码记录',
        content: '确定删除全部 ' + n + ' 条记录吗？删掉就找不回来了。',
        confirmText: '清空',
        confirmColor: '#FF5A5F',
        success: (res) => {
          if (!res.confirm) return;
          this.setData({ history: [] });
          this.persist();
          wx.showToast({ title: '已清空', icon: 'none' });
        }
      });
    },

    onDeleteEntry(e) {
      const key = e.currentTarget.dataset.key;
      const list = this.data.history.filter((h) => h.key !== key);
      if (list.length === this.data.history.length) return;
      this.setData({ history: list });
      this.persist();
    },

    persist() {
      try {
        wx.setStorageSync(STORE_KEY, {
          optIdx: this.data.optIdx,
          history: this.data.history
        });
      } catch (e) {
        console.error('取码记录本地保存失败', e);
      }
    },

    _applyEntry(entry) {
      const slots = freshSlots();
      (entry.chips || []).forEach((c, i) => {
        if (i < MAIN_SLOTS) slots[i] = Object.assign({ i: i, filled: true }, c);
      });
      const special = entry.special
        ? Object.assign({ i: MAIN_SLOTS, filled: true }, entry.special)
        : blankSlot(MAIN_SLOTS, true);
      this.setData({ slots: slots, special: special });
    },

    restore() {
      let saved = null;
      try {
        saved = wx.getStorageSync(STORE_KEY) || null;
      } catch (e) {
        saved = null;
      }
      if (!saved) return;

      const patch = {};
      // optIdx 必须是范围内的整数（2.5 / 越界 / 非数字都会让 OPTIONS[idx] 变 undefined）
      if (Number.isInteger(saved.optIdx) && saved.optIdx >= 0 && saved.optIdx < OPTIONS.length) {
        patch.optIdx = saved.optIdx;
        patch.optHint = hintOf(OPTIONS[saved.optIdx]);
      }
      if (Array.isArray(saved.history) && saved.history.length) {
        const history = saved.history.map(sanitizeEntry).filter(Boolean).slice(0, HIST_MAX);
        if (history.length) {
          patch.history = history;
          patch.speech = '这是上次摇到的，再摇一次也可以～';
        }
      }
      if (Object.keys(patch).length) this.setData(patch);

      // 恢复上次结果，切回栏目时不用重新摇
      if (patch.history && patch.history.length) {
        this._applyEntry(patch.history[0]);
      }
    }
  }
});
