const cloud = require('../../utils/cloudstore.js');

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function fmtTime(ts) {
  const d = new Date(ts);
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// 抽取记录来源元数据
const KIND_META = {
  shake:   { label: '摇一摇', icon: '🎲', cls: 'k-shake',   verb: '抽取', unit: '个' },
  scratch: { label: '刮一刮', icon: '🪙', cls: 'k-scratch', verb: '刮开', unit: '张' }
};

// 购物记录的平台识别（与生活广场保持一致）
const SHOP_PLATFORMS = [
  { name: '淘宝', emoji: '🛒', color: '#FF6A00', domains: ['taobao.com', 'tmall.com', 'tb.cn'] },
  { name: '京东', emoji: '🐶', color: '#E1251B', domains: ['jd.com', 'jd.hk', '3.cn'] },
  { name: '拼多多', emoji: '🍑', color: '#E02E24', domains: ['pinduoduo.com', 'yangkeduo.com'] },
  { name: '小红书', emoji: '📕', color: '#FF2442', domains: ['xiaohongshu.com', 'xhslink.com'] },
  { name: '抖音', emoji: '🎵', color: '#161823', domains: ['douyin.com', 'iesdouyin.com'] },
  { name: '唯品会', emoji: '💎', color: '#E4007F', domains: ['vip.com'] },
  { name: '1688', emoji: '🏭', color: '#FF7300', domains: ['1688.com'] },
  { name: '亚马逊', emoji: '📦', color: '#FF9900', domains: ['amazon.cn', 'amazon.com'] }
];
const SHOP_OTHER = { name: '链接', emoji: '🔗', color: '#FF8FAB' };

function shopPlatOf(link) {
  if (!link) return SHOP_OTHER;
  const l = String(link).toLowerCase();
  return SHOP_PLATFORMS.find(p => p.domains.some(d => l.indexOf(d) !== -1)) || SHOP_OTHER;
}

function shopMoney(n) {
  return (Number(n) || 0).toFixed(2);
}

Page({
  data: {
    activeTab: 'luck',      // luck | food | shopping
    records: [],            // 抽取记录
    orders: [],             // 吃饭记录
    shopping: [],           // 购物记录
    loading: false,
    showTrash: false,       // 回收站弹层
    trashList: [],          // 回收站列表
    trashCount: 0           // 回收站数量（角标）
  },

  onShow() {
    this.render();
    this._loadTrashBadge();
  },

  switchTab(e) {
    this.setData({ activeTab: e.currentTarget.dataset.tab });
  },

  async render() {
    this.setData({ loading: true });
    try {
      const [recs, orders, shopping] = await Promise.all([
        cloud.loadRecords().catch(() => []),
        cloud.loadOrders().catch(() => []),
        cloud.loadShopping().catch(() => [])
      ]);
      this.setData({
        records: this._mapRecords(recs),
        orders: this._mapOrders(orders),
        shopping: this._mapShopping(shopping),
        loading: false
      });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  _mapShopping(list) {
    return (list || [])
      .slice()
      .sort((a, b) => {
        const da = String(a.date || ''), db = String(b.date || '');
        if (da !== db) return db.localeCompare(da);
        return (Number(b.ts) || 0) - (Number(a.ts) || 0);
      })
      .map(it => {
        const plat = shopPlatOf(it.link);
        return {
          id: it.id || String(it.ts),
          title: it.title || '未命名',
          priceText: shopMoney(it.price),
          date: it.date || '',
          note: it.note || '',
          tag: it.tag || '',
          bought: !!it.bought,
          platName: plat.name,
          platEmoji: plat.emoji,
          platColor: plat.color
        };
      });
  },

  _mapRecords(recs) {
    return recs.map(r => {
      const meta = KIND_META[r.kind] || KIND_META.shake;
      const time = fmtTime(r.ts);
      if (r.items && r.items.length) {
        return {
          id: r.id || String(r.ts),
          type: 'group',
          kind: meta.cls,
          kindLabel: meta.icon + ' ' + meta.label,
          verb: meta.verb,
          unit: meta.unit,
          count: r.items.length,
          time,
          chips: r.items.map(it => ({
            label: it.emoji + ' ' + it.name + '·' + (it.number < 10 ? '0' : '') + it.number,
            color: it.color
          }))
        };
      }
      return {
        id: r.id || String(r.ts),
        type: 'single',
        kind: meta.cls,
        kindLabel: meta.icon + ' ' + meta.label,
        verb: meta.verb,
        unit: meta.unit,
        emoji: r.emoji,
        name: r.name,
        time,
        number: r.number,
        color: r.color
      };
    });
  },

  _mapOrders(orders) {
    const mapped = orders.map(o => ({
      id: o.id || String(o.ts),
      time: o.time || fmtTime(o.ts),
      remark: o.remark || o.tableNo || '',
      items: o.items || [],
      total: o.total,
      status: o.status || '已下单'
    }));
    return mapped;
  },

  clearAll() {
    const tab = this.data.activeTab;
    const isLuck = tab === 'luck';
    const isFood = tab === 'food';
    const name = isLuck ? '抽取记录' : isFood ? '吃饭记录' : '购物记录';
    wx.showModal({
      title: '提示',
      content: `确定清空所有${name}？（云端同步，删除后可在回收站找回）`,
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '清空中', mask: true });
        try {
          const list = isLuck ? await cloud.loadRecords()
            : isFood ? await cloud.loadOrders()
            : await cloud.loadShopping();
          // 逐条软删除，保证都能进回收站找回
          for (const it of list) {
            if (isLuck) await cloud.trashRecordById(it.id);
            else if (isFood) await cloud.trashOrderById(it.id);
            else await cloud.trashShoppingById(it.id, it);
          }
          wx.hideLoading();
          wx.showToast({ title: '已清空', icon: 'success' });
          this.render();
        } catch (e) {
          wx.hideLoading();
          wx.showToast({ title: '清空失败', icon: 'none' });
        }
      }
    });
  },

  // 删除单条记录：按 id 软删除进回收站，成功后刷新本地列表
  async deleteOne(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.showLoading({ title: '删除中', mask: true });
    try {
      const tab = this.data.activeTab;
      if (tab === 'luck') {
        await cloud.trashRecordById(id);
      } else if (tab === 'food') {
        await cloud.trashOrderById(id);
      } else {
        // 记录页的 shopping 是「展示对象」（priceText/platName…），
        // 不能直接进回收站，否则恢复后价格等字段会丢，这里取原始记录。
        const raw = await cloud.loadShopping();
        const rec = raw.find(s => String(s.id) === String(id))
          || (this.data.shopping || []).find(s => String(s.id) === String(id));
        await cloud.trashShoppingById(id, rec);
      }
      wx.hideLoading();
      wx.showToast({ title: '已删除', icon: 'success' });
      this.render();
      this._loadTrash();
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '删除失败', icon: 'none' });
    }
  },

  /* ===== 回收站 ===== */

  // 只更新角标数字（不渲染列表）
  async _loadTrashBadge() {
    try {
      const list = await cloud.loadTrash();
      if (list.length !== this.data.trashCount) this.setData({ trashCount: list.length });
    } catch (e) {}
  },

  openTrash() {
    this.setData({ showTrash: true });
    this._loadTrash();
  },

  closeTrash() {
    this.setData({ showTrash: false });
  },

  // 阻止点击弹层内容时冒泡关闭
  noop() {},

  async _loadTrash() {
    if (!this.data.showTrash) return;
    try {
      const list = await cloud.loadTrash();
      this.setData({ trashList: list.map(t => this._mapTrash(t)), trashCount: list.length });
    } catch (e) {
      this.setData({ trashList: [] });
    }
  },

  _mapTrash(t) {
    const base = {
      tid: t.id,
      type: t.type,
      time: fmtTime(t.deletedAt)
    };
    if (t.type === 'order') {
      return Object.assign(base, {
        title: '🍽️ 吃饭记录',
        desc: (t.data.items || []).map(d => d.name + '×' + d.count).join('、') || '订单',
        amount: '¥' + (t.data.total || 0)
      });
    }
    // 小笨生活 · 购物记录
    if (t.type === 'shopping') {
      const d = t.data || {};
      return Object.assign(base, {
        title: '🛍️ 购物记录',
        desc: [d.title || '未命名', d.date || ''].filter(Boolean).join(' · '),
        amount: '¥' + (Number(d.price) || 0).toFixed(2)
      });
    }
    const meta = KIND_META[t.data.kind] || KIND_META.shake;
    const items = t.data.items || [];
    const desc = items.length
      ? items.map(it => it.emoji + it.name).join('、')
      : (t.data.emoji || '') + (t.data.name || '');
    return Object.assign(base, {
      title: meta.icon + ' ' + meta.label,
      desc,
      amount: items.length ? String(items.length) + meta.unit : ((t.data.number < 10 ? '0' : '') + t.data.number)
    });
  },

  // 回收站 → 恢复：回填原列表并移出回收站
  async restoreOne(e) {
    const tid = e.currentTarget.dataset.tid;
    if (!tid) return;
    wx.showLoading({ title: '恢复中', mask: true });
    try {
      await cloud.restoreTrashItem(tid);
      wx.hideLoading();
      wx.showToast({ title: '已恢复', icon: 'success' });
      this._loadTrash();
      this.render();
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '恢复失败', icon: 'none' });
    }
  },

  // 回收站 → 彻底删除：不再保留任何数据
  async purgeOne(e) {
    const tid = e.currentTarget.dataset.tid;
    if (!tid) return;
    wx.showModal({
      title: '彻底删除',
      content: '删除后无法恢复，确定删除这条记录吗？',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '删除中', mask: true });
        try {
          await cloud.removeTrashItem(tid);
          wx.hideLoading();
          wx.showToast({ title: '已彻底删除', icon: 'success' });
          this._loadTrash();
        } catch (err) {
          wx.hideLoading();
          wx.showToast({ title: '删除失败', icon: 'none' });
        }
      }
    });
  },

  // 回收站 → 全部彻底清空
  clearTrash() {
    wx.showModal({
      title: '清空回收站',
      content: '回收站内所有记录将被彻底删除，无法恢复。',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '清空中', mask: true });
        try {
          await cloud.saveTrash([]);
          wx.hideLoading();
          wx.showToast({ title: '回收站已清空', icon: 'success' });
          this._loadTrash();
        } catch (err) {
          wx.hideLoading();
          wx.showToast({ title: '清空失败', icon: 'none' });
        }
      }
    });
  }
});
