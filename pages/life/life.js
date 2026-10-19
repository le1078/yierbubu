// 小笨生活：购物清单 + 小笨餐厅
// 购物记录存云文档 shared_shopping（与全站共享数据一致），失败时回落本地缓存。
const cloud = require('../../utils/cloudstore.js');

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const TAGS = ['生活', '服饰', '零食', '美妆', '数码', '家居'];

// 平台识别表：按域名匹配，顺序即优先级
const PLATFORMS = [
  { key: 'taobao', name: '淘宝', emoji: '🛒', color: '#FF6A00', domains: ['taobao.com', 'tmall.com', 'tb.cn'] },
  { key: 'jd', name: '京东', emoji: '🐶', color: '#E1251B', domains: ['jd.com', 'jd.hk', '3.cn'] },
  { key: 'pdd', name: '拼多多', emoji: '🍑', color: '#E02E24', domains: ['pinduoduo.com', 'yangkeduo.com'] },
  { key: 'xhs', name: '小红书', emoji: '📕', color: '#FF2442', domains: ['xiaohongshu.com', 'xhslink.com'] },
  { key: 'douyin', name: '抖音', emoji: '🎵', color: '#161823', domains: ['douyin.com', 'iesdouyin.com'] },
  { key: 'vip', name: '唯品会', emoji: '💎', color: '#E4007F', domains: ['vip.com'] },
  { key: '1688', name: '1688', emoji: '🏭', color: '#FF7300', domains: ['1688.com'] },
  { key: 'amazon', name: '亚马逊', emoji: '📦', color: '#FF9900', domains: ['amazon.cn', 'amazon.com'] },
  { key: 'other', name: '链接', emoji: '🔗', color: '#FF8FAB', domains: [] }
];
const OTHER_PLAT = PLATFORMS[PLATFORMS.length - 1];

function pad(n) { return n < 10 ? '0' + n : '' + n; }

function todayStr(d) {
  const t = d || new Date();
  return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
}

// 金额统一两位小数 + 千分位（¥59.00 / ¥1,280.00）
function money(n) {
  const v = Number(n) || 0;
  return v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function monthLabelOf(key) {
  const p = String(key || '').split('-');
  if (p.length < 2) return '未填日期';
  return p[0] + '年' + Number(p[1]) + '月';
}

function platOf(link) {
  if (!link) return OTHER_PLAT;
  const l = String(link).toLowerCase();
  return PLATFORMS.find(p => p.domains.some(d => l.indexOf(d) !== -1)) || OTHER_PLAT;
}

function shortUrl(link) {
  if (!link) return '';
  const s = String(link).replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return s.length > 28 ? s.slice(0, 26) + '…' : s;
}

// 从分享文案里抽链接 / 价格 / 商品名
// 淘宝/京东等分享文案通常长这样：
//   【淘宝】https://m.tb.cn/h.gXyZ 毛绒拖鞋 38码 https://item.taobao.com/... 点击链接直接打开
//   2👈复制这段内容后打开手机淘宝，查看【奶油色拖鞋】¥39.90 https://m.tb.cn/h.abc
// 目标是尽量只留下「商品名」，别把口令、平台名、营销词留在标题里。
const NOISE_PATTERNS = [
  /复制[^，,。；;]{0,14}[，,。；;]?/g,          // 复制这段内容 / 复制这条信息
  /(打开|点击|长按)(手机)?(淘宝|天猫|京东|拼多多|小红书|抖音|唯品会)?[^，,。；;]{0,6}[，,。；;]?/g,
  /看看|查看/g,
  /(立减|领券|券后|到手价|包邮|秒杀|限时|百亿补贴|官方旗舰店|旗舰店|新品|热卖|正品|单价|价格|现价|售价)/g,
  /(\$[0-9A-Za-z]{6,}\$|￥[0-9A-Za-z]{6,}￥|€[0-9A-Za-z]{6,}€)/g, // 淘口令
  /[（(]\s*[)）]/g
];

// 【】里如果是平台名/营销词就整段丢掉，否则只去掉括号留下商品名
const BRACKET_PLATFORM = /^(淘宝|天猫|京东|拼多多|小红书|抖音|唯品会|1688|闲鱼|好物|推荐|分享|福利|优惠|新品|预售)/;

function parsePaste(text) {
  const raw = String(text || '').replace(/\r/g, ' ').trim();
  let rest = raw;

  // 1) 抽出所有链接，取第一个当主链接
  const links = raw.match(/https?:\/\/[^\s<>"'，。、；;）)】]+/gi) || [];
  const link = links[0] || '';
  links.forEach((u) => { rest = rest.split(u).join(' '); });

  // 2) 价格：优先带货币符号 / 「元」/ 关键词
  let price = '';
  const pricePatterns = [
    /[¥￥]\s*(\d+(?:\.\d{1,2})?)/,
    /(?:到手价|券后价|券后|价格|现价|售价|单价)\s*[:：]?\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)/,
    /(\d+(?:\.\d{1,2})?)\s*元/
  ];
  for (const re of pricePatterns) {
    const m = rest.match(re);
    if (m) {
      price = m[1];
      rest = rest.replace(m[0], ' ');
      break;
    }
  }

  // 3) 【】处理：平台名整段丢，商品名保留内容
  let title = rest.replace(/【([^】]{0,30})】/g, (_, inner) =>
    BRACKET_PLATFORM.test(inner.trim()) ? ' ' : ' ' + inner + ' ');

  // 4) 去噪音词
  NOISE_PATTERNS.forEach((re) => { title = title.replace(re, ' '); });

  // 5) 只去掉「开头的口令序号 / emoji」，别误伤 38码、350ml 这类规格
  title = title
    .replace(/^[\s\d]{0,3}[👈👉👆👇]\s*/, ' ')
    .replace(/^[\s\d]{1,3}\s+(?=[\u4e00-\u9fa5A-Za-z])/, ' ')
    // 表情符号常被拆成孤立代理项，清掉避免出现乱码方块
    .replace(/[\uD800-\uDFFF]/g, ' ')
    .replace(/[\u{1F000}-\u{1FAFF}\u2600-\u27BF]/gu, ' ')
    .replace(/^[\s·•\-—]+/, ' ');

  // 6) 标题里残留的平台名（京东 / 淘宝 …）与尾巴上的动词（买 / 看看）也去掉
  title = title
    .replace(/(淘宝|天猫|京东|拼多多|小红书|抖音|唯品会|1688|闲鱼)/g, ' ')
    .replace(/(买|看看|看看这个|下单|拼单|求链接)$/g, ' ');

  title = title
    .replace(/[\[\]【】]/g, ' ')
    .replace(/[，,。；;:：\s]+/g, ' ')
    .trim();

  if (title.length > 42) title = title.slice(0, 42).trim();
  const plat = platOf(link);
  // 没解析出名字时不要塞「淘宝商品」这类占位词进输入框，交给用户自己填
  return { link, price, title, plat };
}

Page({
  data: {
    view: 'hub',              // hub | buy | restaurant
    dateLabel: '',
    weekLabel: '',

    // 广场
    shopCount: 0,
    shopWish: 0,
    recent: [],
    dishCount: 0,
    menuCats: 0,

    // 统计
    statMonthTotal: '0.00',
    statMonthCount: 0,
    statMonthAvg: '0.00',
    statWish: 0,
    statBought: 0,
    statAllTotal: '0.00',
    statWishTotal: '0.00',

    // 记一笔
    draft: '',
    form: {
      title: '',
      price: '',
      link: '',
      date: '',
      dateShort: '',
      platName: '',
      platEmoji: '',
      linkShort: '',
      note: '',
      tag: '生活'
    },

    // 列表
    filter: 'all',            // all | wish | done
    groups: [],
    groupsCount: 0,
    filteredCount: 0,
    filteredTotal: '0.00',
    tags: TAGS,

    // 编辑
    showEdit: false,
    editForm: { id: '', title: '', price: '', link: '', date: '', note: '', tag: '', bought: false }
  },

  onLoad() {
    const d = new Date();
    const ts = todayStr(d);
    const form = Object.assign({}, this.data.form, { date: ts, dateShort: this._shortDate(ts) });
    this.setData({
      dateLabel: (d.getMonth() + 1) + '月' + d.getDate() + '日',
      weekLabel: WEEK[d.getDay()],
      form
    });
    this._load();
  },

  onShow() {
    // 首次进入已经由 onLoad 拉过；之后每次回到本页再刷新，保证多端同步
    if (this._loaded) this._load();
    else this._loaded = true;
  },

  /* ================= 数据 ================= */

  async _load() {
    let list = [];
    let local = [];
    try { local = wx.getStorageSync('yb_shopping') || []; } catch (e) { local = []; }

    try {
      const remote = await cloud.loadShopping();
      list = (remote && remote.length) ? remote : (local.length ? local : []);
    } catch (e) {
      console.error('购物记录加载失败', e);
      list = local;
    }

    this._items = Array.isArray(list) ? list : [];
    this._render();
    this._loadMenuMeta();
  },

  async _persist(list) {
    wx.setStorageSync('yb_shopping', list);
    try {
      await cloud.saveShopping(list);
    } catch (e) {
      console.error('购物记录云端保存失败', e);
      wx.showToast({ title: '已存本地，云端同步失败', icon: 'none' });
    }
  },

  async _loadMenuMeta() {
    try {
      const menu = await cloud.loadMenu();
      if (menu && menu.length) {
        let n = 0;
        menu.forEach(c => { n += (c.items || []).length; });
        this.setData({ dishCount: n, menuCats: menu.length });
      } else {
        this.setData({ dishCount: 19, menuCats: 5 });
      }
    } catch (e) {
      this.setData({ dishCount: 19, menuCats: 5 });
    }
  },

  // 品牌色 12% 透明底（WXSS 里不支持 8 位 hex，这里预计算）
  _tint(hex) {
    const h = String(hex || '#FF8FAB').replace('#', '');
    const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    const pick = (s, dft) => {
      const v = parseInt(s, 16);
      return isNaN(v) ? dft : v;
    };
    const r = pick(full.slice(0, 2), 255);
    const g = pick(full.slice(2, 4), 143);
    const b = pick(full.slice(4, 6), 171);
    return `rgba(${r},${g},${b},0.12)`;
  },

  _shortDate(ds) {
    const p = String(ds || '').split('-');
    if (p.length < 3) return ds || '';
    return Number(p[1]) + '月' + Number(p[2]) + '日';
  },

  _monthDay(ds) {
    const p = String(ds || '').split('-');
    if (p.length < 3) return '';
    return p[1] + '-' + p[2];
  },

  _decorate(it) {
    const plat = platOf(it.link);
    return Object.assign({}, it, {
      priceText: money(it.price),
      dateShort: this._shortDate(it.date),
      dateMonthDay: this._monthDay(it.date),
      platEmoji: plat.emoji,
      platName: plat.name,
      platColor: plat.color,
      platBg: this._tint(plat.color),
      linkShort: shortUrl(it.link)
    });
  },

  _render() {
    const raw = (this._items || []).slice();
    const filter = this.data.filter;

    const wish = raw.filter(it => !it.bought).length;
    const bought = raw.length - wish;

    // 本月统计：支出只算「已到手」，想买单独汇总（避免把没买的也算成花掉了）
    const now = new Date();
    const mKey = now.getFullYear() + '-' + pad(now.getMonth() + 1);
    let mSpent = 0, mSpentCount = 0, wishTotal = 0, allSpent = 0;
    raw.forEach(it => {
      const p = Number(it.price) || 0;
      const inMonth = String(it.date || '').slice(0, 7) === mKey;
      if (it.bought) {
        allSpent += p;
        if (inMonth) { mSpent += p; mSpentCount += 1; }
      } else {
        wishTotal += p;
      }
    });

    // 筛选 + 排序（日期倒序，同日按创建时间倒序）
    const list = raw
      .filter(it => filter === 'all' ? true : filter === 'wish' ? !it.bought : !!it.bought)
      .sort((a, b) => {
        const da = String(a.date || ''), db = String(b.date || '');
        if (da !== db) return db.localeCompare(da);
        return (Number(b.ts) || 0) - (Number(a.ts) || 0);
      });

    // 按月分组
    const groups = [];
    let fTotal = 0;
    list.forEach(it => {
      const key = String(it.date || '').slice(0, 7) || 'none';
      let g = groups[groups.length - 1];
      if (!g || g.key !== key) {
        g = { key, label: monthLabelOf(key === 'none' ? '' : key), items: [], total: 0 };
        groups.push(g);
      }
      g.items.push(this._decorate(it));
      g.total += Number(it.price) || 0;
      fTotal += Number(it.price) || 0;
    });
    groups.forEach(g => { g.totalText = money(g.total); });

    const recent = raw
      .slice()
      .sort((a, b) => {
        const da = String(a.date || ''), db = String(b.date || '');
        if (da !== db) return db.localeCompare(da);
        return (Number(b.ts) || 0) - (Number(a.ts) || 0);
      })
      .slice(0, 3)
      .map(it => this._decorate(it));

    this.setData({
      shopCount: raw.length,
      shopWish: wish,
      statWish: wish,
      statBought: bought,
      statMonthTotal: money(mSpent),
      statMonthCount: mSpentCount,
      statMonthAvg: money(mSpentCount ? mSpent / mSpentCount : 0),
      statAllTotal: money(allSpent),
      statWishTotal: money(wishTotal),
      groups,
      groupsCount: list.length,
      filteredCount: list.length,
      filteredTotal: money(fTotal),
      recent
    });
  },

  /* ================= 导航 ================= */

  goHub() { this._switchView('hub'); },
  goBuy() { this._switchView('buy'); },
  goRest() { this._switchView('restaurant'); },

  // 换视图时回到顶部，避免从列表底部切过去时停在半截
  _switchView(view) {
    if (this.data.view === view) {
      wx.pageScrollTo({ scrollTop: 0, duration: 0 });
      return;
    }
    this.setData({ view, showEdit: false });
    if (view === 'buy') this._render();
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },

  setFilter(e) {
    this.setData({ filter: e.currentTarget.dataset.f });
    this._render();
  },

  onOrdered() {
    // 餐厅下单成功的提示由餐厅组件自己负责，这里不重复弹
  },

  /* ================= 记一笔 ================= */

  onDraftInput(e) {
    const v = e.detail.value;
    this.setData({ draft: v });
    // 粘贴了链接且名称还空着时，自动识别一次
    if (/https?:\/\//i.test(v) && !this.data.form.title) {
      this._applyParse(parsePaste(v), false);
    }
  },

  pasteFromClipboard() {
    wx.getClipboardData({
      success: (res) => {
        const v = res.data || '';
        if (!v.trim()) {
          wx.showToast({ title: '剪贴板是空的', icon: 'none' });
          return;
        }
        this.setData({ draft: v });
        this._applyParse(parsePaste(v), true);
      },
      fail: () => wx.showToast({ title: '读取剪贴板失败', icon: 'none' })
    });
  },

  smartParse() {
    const v = this.data.draft;
    if (!v.trim()) {
      wx.showToast({ title: '先粘贴点内容吧', icon: 'none' });
      return;
    }
    const r = parsePaste(v);
    if (!r.link && !r.price && !r.title) {
      wx.showToast({ title: '没识别到内容，手动填一下吧', icon: 'none' });
      return;
    }
    this._applyParse(r, true);
  },

  _applyParse(r, withToast) {
    const patch = {
      'form.platName': r.plat.name,
      'form.platEmoji': r.plat.emoji,
      'form.linkShort': shortUrl(r.link)
    };
    if (r.link) patch['form.link'] = r.link;
    if (r.price !== '') patch['form.price'] = String(r.price);
    if (r.title) patch['form.title'] = r.title;
    this.setData(patch);
    if (withToast) {
      const hit = [];
      if (r.title) hit.push('名称');
      if (r.price !== '') hit.push('价格');
      if (r.link) hit.push('链接');
      wx.showToast({ title: hit.length ? '已识别' + hit.join('·') : '没有可识别的内容', icon: 'none' });
    }
  },

  clearLink() {
    this.setData({ 'form.link': '', 'form.linkShort': '', 'form.platName': '', 'form.platEmoji': '' });
  },

  onFormInput(e) {
    this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value });
  },

  onDateChange(e) {
    const ds = e.detail.value;
    this.setData({ 'form.date': ds, 'form.dateShort': this._shortDate(ds) });
  },

  pickTag(e) {
    this.setData({ 'form.tag': e.currentTarget.dataset.tag });
  },

  async quickSave() {
    const f = this.data.form;
    const title = String(f.title || '').trim();
    const price = String(f.price || '').trim();

    if (!title && !f.link) {
      wx.showToast({ title: '先写个商品名吧', icon: 'none' });
      return;
    }
    if (!price) {
      wx.showToast({ title: '别忘了填价格', icon: 'none' });
      return;
    }
    if (isNaN(parseFloat(price))) {
      wx.showToast({ title: '价格格式不对哦', icon: 'none' });
      return;
    }

    const plat = platOf(f.link);
    const item = {
      id: Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      title: title || (f.link ? plat.name + '商品' : '未命名'),
      price: parseFloat(price),
      link: f.link || '',
      date: f.date || todayStr(),
      tag: f.tag || '',
      note: String(f.note || '').trim(),
      bought: false,
      ts: Date.now()
    };

    this._items = [item].concat(this._items || []);
    await this._persist(this._items);
    this._render();

    const d = new Date();
    this.setData({
      draft: '',
      form: {
        title: '',
        price: '',
        link: '',
        date: todayStr(d),
        dateShort: this._shortDate(todayStr(d)),
        platName: '',
        platEmoji: '',
        linkShort: '',
        note: '',
        tag: f.tag || '生活'
      }
    });
    wx.showToast({ title: '记好啦', icon: 'none' });
  },

  /* ================= 列表操作 ================= */

  async toggleBought(e) {
    const id = e.currentTarget.dataset.id;
    const raw = (this._items || []).find(it => String(it.id) === String(id));
    if (!raw) return;
    raw.bought = !raw.bought;
    this._items = (this._items || []).slice();
    await this._persist(this._items);
    this._render();
  },

  copyLink(e) {
    const link = e.currentTarget.dataset.link;
    if (!link) return;
    wx.setClipboardData({
      data: link,
      success: () => wx.showToast({ title: '链接已复制', icon: 'none' })
    });
  },

  /* ================= 编辑 ================= */

  openEdit(e) {
    const id = e.currentTarget.dataset.item && e.currentTarget.dataset.item.id;
    const raw = (this._items || []).find(it => String(it.id) === String(id));
    if (!raw) return;
    this.setData({
      showEdit: true,
      editForm: {
        id: raw.id,
        title: raw.title || '',
        price: String(raw.price === 0 || raw.price ? raw.price : ''),
        link: raw.link || '',
        date: raw.date || todayStr(),
        note: raw.note || '',
        tag: raw.tag || '',
        bought: !!raw.bought
      }
    });
  },

  closeEdit() {
    this.setData({ showEdit: false });
  },

  onEditInput(e) {
    this.setData({ ['editForm.' + e.currentTarget.dataset.field]: e.detail.value });
  },

  onEditDate(e) {
    this.setData({ 'editForm.date': e.detail.value });
  },

  pickEditTag(e) {
    const tag = e.currentTarget.dataset.tag;
    this.setData({ 'editForm.tag': this.data.editForm.tag === tag ? '' : tag });
  },

  toggleBoughtInEdit() {
    this.setData({ 'editForm.bought': !this.data.editForm.bought });
  },

  async saveEdit() {
    const f = this.data.editForm;
    if (!String(f.title || '').trim()) {
      wx.showToast({ title: '商品名称不能为空', icon: 'none' });
      return;
    }
    if (!String(f.price || '').trim() || isNaN(parseFloat(f.price))) {
      wx.showToast({ title: '请填写正确的价格', icon: 'none' });
      return;
    }
    const raw = (this._items || []).find(it => String(it.id) === String(f.id));
    if (!raw) return;

    raw.title = String(f.title).trim();
    raw.price = parseFloat(f.price);
    raw.link = String(f.link || '').trim();
    raw.date = f.date;
    raw.note = String(f.note || '').trim();
    raw.tag = f.tag || '';
    raw.bought = !!f.bought;

    this._items = (this._items || []).slice();
    await this._persist(this._items);
    this._render();
    this.setData({ showEdit: false });
    wx.showToast({ title: '已保存', icon: 'none' });
  },

  deleteEdit() {
    const id = this.data.editForm.id;
    if (!id) return;
    wx.showModal({
      title: '删除记录',
      content: '这条购物记录会被移入「记录 · 回收站」，7 天内都能找回。',
      confirmColor: '#FF5A5F',
      success: async (res) => {
        if (!res.confirm) return;
        const gone = (this._items || []).find(it => String(it.id) === String(id));
        this._items = (this._items || []).filter(it => String(it.id) !== String(id));
        await this._persist(this._items);
        // 与全站一致：同时压入云端回收站，可在「记录」页恢复
        if (gone) this._archiveToTrash(gone);
        this._render();
        this.setData({ showEdit: false });
        wx.showToast({ title: '已删除', icon: 'none' });
      }
    });
  },

  /* ================= 回收站 ================= */

  // 购物记录删除后同时进云回收站（与记录/订单同一套机制），失败不影响本地删除。
  // 这里把整条记录传过去：本地已经从清单里摘掉，云端也同步删过了，
  // 单靠 id 是查不到原记录的。
  async _archiveToTrash(item) {
    try {
      if (cloud.trashShoppingById) {
        await cloud.trashShoppingById(item.id, item);
        return;
      }
      // 兜底：老版本 cloudstore 没有该方法时，手动写一条
      const trash = await cloud.loadTrash();
      trash.unshift({
        id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        deletedAt: Date.now(),
        type: 'shopping',
        data: item
      });
      await cloud.saveTrash(trash.slice(0, 100));
    } catch (e) {
      console.error('购物记录入回收站失败', e);
    }
  },

  /* ================= 分享 ================= */

  onShareAppMessage() {
    return {
      title: '来小笨生活逛逛～',
      path: '/pages/life/life'
    };
  },

  noop() {}
});
