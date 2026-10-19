const {
  ZODIAC,
  getYearAnimalIndex,
  buildMapping
} = require('../../utils/zodiac.js');
const cloud = require('../../utils/cloudstore.js');
const dt = require('../../utils/datetime.js');
const { sanitizeAmount } = require('../../utils/amount.js');

const pad = dt.pad;

const WIN_MULTIPLIER = 47; // 特码固定赔率：1 赔 47

const ZODIAC_NAMES = ZODIAC.map(z => z.name);

const REGIONS = [
  { key: 'laoAo', label: '老澳' },
  { key: 'xinAo', label: '新澳' },
  { key: 'xiangGang', label: '香港' }
];

function emptyBuyState() { return [{}, {}, {}]; }
function emptyItems() { return [[], [], []]; }
function emptyPick() { return [{ z: 0, n: 0, amount: '' }, { z: 0, n: 0, amount: '' }, { z: 0, n: 0, amount: '' }]; }

function clone(o) { return JSON.parse(JSON.stringify(o)); }

Page({
  data: {
    mode: 'memo',
    cloudReady: false,       // 云端数据是否就绪；false 时禁止编辑（只读态）
    calY: 2026,
    calM: 0,
    monthLabel: '',
    weekdays: ['日', '一', '二', '三', '四', '五', '六'],
    grid: [],
    sheetDate: '',
    year: 2026,
    zodiacList: ZODIAC,
    zodiacNames: ZODIAC_NAMES,
    mapping: {},
    // memo
    memoText: '',
    memoEditing: false,
    // buy
    buyEditing: false,
    regions: REGIONS,
    kZIdx: [0, 0, 0],
    kNums: [['--'], ['--'], ['--']],
    kNIdx: [0, 0, 0],
    kaiValues: [{}, {}, {}],
    buySelected: emptyBuyState(),
    buyItems: emptyItems(),
    pick: emptyPick(),
    pickNums: [['--'], ['--'], ['--']],
    extraAmount: '',
    total: '0.00',
    winStr: '0.00',
    extraStr: '0.00',
    middle: '0.00',
    profit: '0.00',
    profitNeg: false
  },

  onLoad() {
    const d = new Date();
    const year = d.getFullYear();
    this.setData({
      calY: year,
      calM: d.getMonth(),
      year,
      mapping: buildMapping(year)
    });
    // 从云端加载共享日历数据
    this._loadCloud();
  },

  async _loadCloud() {
    // 加载期间置为不可编辑：避免失败后用户基于空数据编辑，把共享数据冲掉
    this.setData({ cloudReady: false });
    try {
      const { memo, buy } = await cloud.loadCalendar();
      this._memoCal = memo;
      this._buyCal = buy;
      this.setData({ cloudReady: true });
    } catch (e) {
      console.error('日历云端加载失败', e);
      // 不初始化空对象：保持 cloudReady=false 进入只读态，所有写操作被拦截
      wx.showToast({ title: '云端加载失败，请下拉重试', icon: 'none' });
    }
    this.renderCalendar();
  },

  // 写操作前置检查：云端未就绪时禁止编辑并提示
  _ensureWritable() {
    if (this.data.cloudReady) return true;
    wx.showToast({ title: '云端未就绪，暂不能编辑', icon: 'none' });
    return false;
  },

  // 只读态下的手动重试入口
  reloadCloud() {
    this._loadCloud();
  },

  setMode(e) {
    const mode = e.currentTarget.dataset.mode;
    this._clearEditState();
    this.setData({ mode, sheetDate: '' });
    this.renderCalendar();
  },

  prevM() {
    let y = this.data.calY, m = this.data.calM - 1;
    if (m < 0) { m = 11; y--; }
    this._clearEditState();
    this.setData({ calY: y, calM: m, mapping: buildMapping(y), sheetDate: '' });
    this.renderCalendar();
  },

  nextM() {
    let y = this.data.calY, m = this.data.calM + 1;
    if (m > 11) { m = 0; y++; }
    this._clearEditState();
    this.setData({ calY: y, calM: m, mapping: buildMapping(y), sheetDate: '' });
    this.renderCalendar();
  },

  renderCalendar() {
    const y = this.data.calY, m = this.data.calM;
    // 优先用内存缓存，极端情况（如缓存未初始化）才回退读 storage
    const memoCal = this._memoCal || (this._memoCal = {});
    const buyCal = this._buyCal || (this._buyCal = {});
    const first = new Date(y, m, 1).getDay();
    const days = new Date(y, m + 1, 0).getDate();
    const t = new Date();
    const today = (t.getFullYear() === y && t.getMonth() === m) ? t.getDate() : -1;
    const grid = [];
    for (let i = 0; i < first; i++) grid.push({ empty: true, key: 'empty-' + i });
    for (let d = 1; d <= days; d++) {
      const ds = y + '-' + pad(m + 1) + '-' + pad(d);
      const hasMemo = !!(memoCal[ds] && memoCal[ds].memo);
      const hasBuy = this.hasBuyData(buyCal[ds]);
      const dots = [];
      if (hasMemo) dots.push('memo');
      if (hasBuy) dots.push('buy');
      // 用日期串作 key：空白天原本没有 ds 字段，wx:key 会全部退化成 undefined
      grid.push({ empty: false, day: d, ds, key: ds, isToday: d === today, isSel: ds === this.data.sheetDate, dots });
    }
    this.setData({ monthLabel: y + '年 ' + (m + 1) + '月', grid });
  },

  hasBuyData(rec) {
    if (!rec) return false;
    if (rec.extra) return true;
    if (rec.kai) {
      for (const k of REGIONS) if (rec.kai[k.key]) return true;
    }
    if (rec.mai) {
      for (const k of REGIONS) {
        const arr = rec.mai[k.key];
        if (Array.isArray(arr) && arr.length) return true;
      }
    }
    return false;
  },

  // 清理编辑快照与待执行定时器：切换日期/模式前必须调用，
  // 否则残留的 _memoSnapshot/_buySnapshotRec 会在下次 cancelEdit 时覆盖新日期的数据
  _clearEditState() {
    clearTimeout(this._memoSaveTimer);
    clearTimeout(this._buySaveTimer);
    delete this._memoSnapshot;
    delete this._buySnapshotRec;
    this.setData({ memoEditing: false, buyEditing: false });
  },

  openDate(e) {
    const ds = e.currentTarget.dataset.ds;
    if (!ds) return;
    this._clearEditState();
    if (this.data.mode === 'memo') {
      const memoCal = this._memoCal;
      this.setData({
        sheetDate: ds,
        memoText: (memoCal[ds] && memoCal[ds].memo) || ''
      });
    } else {
      this.setData({ sheetDate: ds });
      this.initBuyPanel(ds);
    }
  },

  // 编辑门控
  toggleMemoEdit() {
    if (!this._ensureWritable()) return;
    const entering = !this.data.memoEditing;
    if (entering) {
      this._memoSnapshot = (this._memoCal[this.data.sheetDate] && this._memoCal[this.data.sheetDate].memo) || '';
    } else {
      delete this._memoSnapshot;
    }
    this.setData({ memoEditing: entering });
  },
  toggleBuyEdit() {
    if (!this._ensureWritable()) return;
    const entering = !this.data.buyEditing;
    if (entering) {
      const buyCal = this._buyCal;
      this._buySnapshotRec = clone(buyCal[this.data.sheetDate] || { kai: {}, mai: {}, extra: 0 });
    } else {
      delete this._buySnapshotRec;
    }
    this.setData({ buyEditing: entering });
  },

  cancelEdit() {
    const ds = this.data.sheetDate;
    if (this.data.mode === 'memo') {
      clearTimeout(this._memoSaveTimer);
      const memoCal = this._memoCal;
      const snap = this._memoSnapshot || '';
      if (snap) memoCal[ds] = { memo: snap };
      else delete memoCal[ds];
      this._saveMemo(memoCal);
      delete this._memoSnapshot;
      this.setData({ memoText: snap, memoEditing: false });
      this.renderCalendar();
    } else {
      if (this._buySnapshotRec) {
        const buyCal = this._buyCal;
        if (this.hasBuyData(this._buySnapshotRec)) buyCal[ds] = clone(this._buySnapshotRec);
        else delete buyCal[ds];
        this._saveBuy(buyCal);
        delete this._buySnapshotRec;
      }
      this.initBuyPanel(ds);
      this.renderCalendar();
    }
  },

  // ---- memo ----
  onMemoInput(e) {
    this.setData({ memoText: e.detail.value });
    clearTimeout(this._memoSaveTimer);
    this._memoSaveTimer = setTimeout(() => this.persistMemo(), 400);
  },

  persistMemo() {
    const ds = this.data.sheetDate;
    if (!ds) return;
    if (!this._ensureWritable()) return;
    const memoCal = this._memoCal;
    if (this.data.memoText) memoCal[ds] = { memo: this.data.memoText };
    else delete memoCal[ds];
    this._saveMemo(memoCal);
    this.renderCalendar();
  },

  // 统一保存入口：失败时明确提示，不再静默吞掉
  _saveMemo(memoCal) {
    cloud.saveCalendarMemo(memoCal).catch((e) => {
      console.error('备忘保存失败', e);
      wx.showToast({ title: '保存失败，请重试', icon: 'none' });
    });
  },

  _saveBuy(buyCal) {
    cloud.saveCalendarBuy(buyCal).catch((e) => {
      console.error('买码保存失败', e);
      wx.showToast({ title: '保存失败，请重试', icon: 'none' });
    });
  },

  saveMemo() {
    clearTimeout(this._memoSaveTimer);
    this.persistMemo();
    delete this._memoSnapshot;
    this.setData({ memoEditing: false });
  },

  // ---- buy panel ----
  initBuyPanel(ds) {
    const buyCal = this._buyCal;
    let rec = buyCal[ds] || { kai: {}, mai: {}, extra: 0 };

    const mapping = this.data.mapping;
    const kZIdx = [0, 0, 0], kNums = [['--'], ['--'], ['--']], kNIdx = [0, 0, 0];
    const kaiValues = [{}, {}, {}];
    const buySelected = emptyBuyState();
    const buyItems = emptyItems();
    const pick = emptyPick();
    const pickNums = [['--'], ['--'], ['--']];

    REGIONS.forEach((rg, i) => {
      const k = rec.kai && rec.kai[rg.key];
      if (k && k.name) {
        const zi = ZODIAC.findIndex(z => z.name === k.name);
        const nums = ['--'].concat(mapping[k.name]);
        const ni = nums.indexOf(k.number);
        kZIdx[i] = zi + 1;
        kNums[i] = nums;
        kNIdx[i] = Math.max(0, ni);
        const ze = ZODIAC[zi];
        kaiValues[i] = { name: k.name, emoji: ze.emoji, number: k.number };
      }
      const arr = (rec.mai && rec.mai[rg.key]) || [];
      const list = Array.isArray(arr) ? arr : (arr.name ? [arr] : []);
      list.forEach(it => {
        if (!it || !it.name || !it.number) return;
        const ze = ZODIAC.find(z => z.name === it.name);
        buyItems[i].push({ name: it.name, emoji: (ze && ze.emoji) || '', number: it.number, amount: String(it.amount || '') });
        if (!buySelected[i][it.name]) buySelected[i][it.name] = {};
        buySelected[i][it.name][it.number] = true;
      });
    });

    this.setData({
      kZIdx, kNums, kNIdx, kaiValues,
      buySelected, buyItems, pick, pickNums,
      buyEditing: false,
      extraAmount: rec.extra ? String(rec.extra) : ''
    }, () => {
      this.updateTotals();
    });
  },

  computeKaiValue(ri) {
    if (this.data.kZIdx[ri] > 0 && this.data.kNIdx[ri] > 0) {
      const z = ZODIAC[this.data.kZIdx[ri] - 1];
      return {
        name: z.name,
        emoji: z.emoji,
        number: this.data.kNums[ri][this.data.kNIdx[ri]]
      };
    }
    return null;
  },

  updateKaiValues() {
    const kaiValues = [this.computeKaiValue(0), this.computeKaiValue(1), this.computeKaiValue(2)];
    this.setData({ kaiValues });
  },

  updateTotals() {
    let total = 0;
    let win = 0;
    this.data.buyItems.forEach((items, i) => {
      const kai = this.data.kaiValues[i];
      items.forEach(it => {
        const amt = parseFloat(it.amount) || 0;
        total += amt;
        if (kai && it.name === kai.name && it.number === kai.number) win += amt * WIN_MULTIPLIER;
      });
    });
    const extra = parseFloat(this.data.extraAmount) || 0;
    const middle = extra + win;
    const profit = middle - total;
    this.setData({
      total: total.toFixed(2),
      winStr: win.toFixed(2),
      extraStr: extra.toFixed(2),
      middle: middle.toFixed(2),
      profit: profit.toFixed(2),
      profitNeg: profit < 0
    });
  },

  onKaiZodiac(e) {
    const i = +e.currentTarget.dataset.ri;
    const val = +e.detail.value + 1; // picker 索引 -> 1-based
    const kZIdx = this.data.kZIdx.slice();
    const kNums = this.data.kNums.slice();
    const kNIdx = this.data.kNIdx.slice();
    kZIdx[i] = val;
    if (val === 0) {
      kNums[i] = ['--'];
      kNIdx[i] = 0;
    } else {
      kNums[i] = ['--'].concat(this.data.mapping[ZODIAC[val - 1].name]);
      kNIdx[i] = 0;
    }
    this.setData({ kZIdx, kNums, kNIdx }, () => {
      this.updateKaiValues();
      this.updateTotals();
    });
    this.persistBuy();
  },

  onKaiNum(e) {
    const i = +e.currentTarget.dataset.ri;
    const kNIdx = this.data.kNIdx.slice();
    kNIdx[i] = +e.detail.value;
    this.setData({ kNIdx }, () => {
      this.updateKaiValues();
      this.updateTotals();
    });
    this.persistBuy();
  },

  clearKai(e) {
    const i = +e.currentTarget.dataset.ri;
    const kZIdx = this.data.kZIdx.slice();
    const kNums = this.data.kNums.slice();
    const kNIdx = this.data.kNIdx.slice();
    const kaiValues = clone(this.data.kaiValues);
    kZIdx[i] = 0; kNums[i] = ['--']; kNIdx[i] = 0; kaiValues[i] = {};
    this.setData({ kZIdx, kNums, kNIdx, kaiValues }, () => this.updateTotals());
    this.persistBuy();
  },

  // 下拉框：选择待添加生肖
  onPickZodiac(e) {
    const ri = +e.currentTarget.dataset.ri;
    const z = +e.detail.value + 1; // picker 索引 -> 1-based
    const pick = clone(this.data.pick);
    const pickNums = clone(this.data.pickNums);
    pick[ri].z = z;
    pick[ri].n = 0;
    pickNums[ri] = z > 0 ? ['--'].concat(this.data.mapping[ZODIAC[z - 1].name]) : ['--'];
    this.setData({ pick, pickNums });
  },

  onPickNum(e) {
    const ri = +e.currentTarget.dataset.ri;
    const n = +e.detail.value;
    const pick = clone(this.data.pick);
    pick[ri].n = n;
    this.setData({ pick });
  },

  onPickAmount(e) {
    const ri = +e.currentTarget.dataset.ri;
    const pick = clone(this.data.pick);
    pick[ri].amount = String(e.detail.value).replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1');
    this.setData({ pick });
  },

  addBuy(e) {
    const ri = +e.currentTarget.dataset.ri;
    const p = this.data.pick[ri];
    if (p.z <= 0 || p.n <= 0) {
      wx.showToast({ title: '请先选生肖和号码', icon: 'none' });
      return;
    }
    const z = ZODIAC[p.z - 1];
    const name = z.name;
    const emoji = z.emoji;
    const number = this.data.pickNums[ri][p.n];
    const buySelected = clone(this.data.buySelected);
    const buyItems = clone(this.data.buyItems);
    if (!buySelected[ri][name]) buySelected[ri][name] = {};
    buySelected[ri][name][number] = true;
    const exists = buyItems[ri].some(it => it.name === name && it.number === number);
    if (!exists) buyItems[ri].push({ name, emoji, number, amount: p.amount || '' });
    const pick = clone(this.data.pick);
    const pickNums = clone(this.data.pickNums);
    pick[ri] = { z: 0, n: 0, amount: '' };
    pickNums[ri] = ['--'];
    this.setData({ buySelected, buyItems, pick, pickNums }, () => this.updateTotals());
    this.persistBuy();
  },

  onBuyAmount(e) {
    const ri = +e.currentTarget.dataset.ri;
    const idx = +e.currentTarget.dataset.idx;
    const val = sanitizeAmount(e.detail.value);
    // 不可变写法：clone 后修改再 setData，不要直接改 this.data
    const buyItems = clone(this.data.buyItems);
    if (buyItems[ri][idx]) buyItems[ri][idx].amount = val;
    this.setData({ buyItems }, () => {
      this.updateTotals();
      this.persistBuy();
    });
  },

  deleteBuyItem(e) {
    const ri = +e.currentTarget.dataset.ri;
    const idx = +e.currentTarget.dataset.idx;
    const buyItems = clone(this.data.buyItems);
    const it = buyItems[ri][idx];
    buyItems[ri].splice(idx, 1);
    const buySelected = clone(this.data.buySelected);
    if (it && buySelected[ri][it.name]) {
      delete buySelected[ri][it.name][it.number];
      if (Object.keys(buySelected[ri][it.name]).length === 0) delete buySelected[ri][it.name];
    }
    this.setData({ buyItems, buySelected }, () => this.updateTotals());
    this.persistBuy();
  },

  clearMai(e) {
    const ri = +e.currentTarget.dataset.ri;
    const buySelected = clone(this.data.buySelected);
    const buyItems = clone(this.data.buyItems);
    buySelected[ri] = {};
    buyItems[ri] = [];
    this.setData({ buySelected, buyItems }, () => this.updateTotals());
    this.persistBuy();
  },

  onExtraAmount(e) {
    const val = sanitizeAmount(e.detail.value);
    this.setData({ extraAmount: val }, () => {
      this.updateTotals();
      this.persistBuy();
    });
  },

  saveBuy() {
    const ds = this.data.sheetDate;
    // 立即落库：先取消待执行的防抖保存，避免关面板后定时器又跑一次
    clearTimeout(this._buySaveTimer);
    const buyCal = this._buyCal;
    if (!buyCal[ds]) buyCal[ds] = { kai: {}, mai: {}, extra: 0 };
    const rec = buyCal[ds];

    REGIONS.forEach((rg, i) => {
      const kai = this.computeKaiValue(i);
      if (kai) rec.kai[rg.key] = kai;
      else delete rec.kai[rg.key];

      const list = (this.data.buyItems[i] || [])
        .filter(it => it.name && it.number)
        .map(it => ({
          name: it.name,
          number: it.number,
          amount: parseFloat(it.amount) || 0
        }));
      if (list.length) rec.mai[rg.key] = list;
      else delete rec.mai[rg.key];
    });

    rec.extra = parseFloat(this.data.extraAmount) || 0;
    if (!this.hasBuyData(rec)) delete buyCal[ds];
    this._saveBuy(buyCal);
    delete this._buySnapshotRec;
    this.setData({ buyEditing: false });
    this.renderCalendar();
  },

  // 自动保存：任何改动后写入本地，关闭面板不再丢数据
  // 防抖 400ms：输入金额时每敲一个字符都会触发，合并成一次云端写
  persistBuy() {
    const ds = this.data.sheetDate;
    if (!ds) return;
    if (!this._ensureWritable()) return;
    clearTimeout(this._buySaveTimer);
    this._buySaveTimer = setTimeout(() => this._persistBuyNow(), 400);
  },

  _persistBuyNow() {
    const ds = this.data.sheetDate;
    if (!ds) return;
    if (!this._ensureWritable()) return;
    const buyCal = this._buyCal;
    if (!buyCal[ds]) buyCal[ds] = { kai: {}, mai: {}, extra: 0 };
    const rec = buyCal[ds];
    REGIONS.forEach((rg, i) => {
      const kai = this.computeKaiValue(i);
      if (kai) rec.kai[rg.key] = kai;
      else delete rec.kai[rg.key];
      const list = (this.data.buyItems[i] || [])
        .filter(it => it.name && it.number)
        .map(it => ({ name: it.name, number: it.number, amount: parseFloat(it.amount) || 0 }));
      if (list.length) rec.mai[rg.key] = list;
      else delete rec.mai[rg.key];
    });
    rec.extra = parseFloat(this.data.extraAmount) || 0;
    if (!this.hasBuyData(rec)) delete buyCal[ds];
    this._saveBuy(buyCal);
  },

  closePanel() {
    this.setData({ sheetDate: '' });
    this.renderCalendar();
  }
});
