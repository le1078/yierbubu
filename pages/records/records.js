const cloud = require('../../utils/cloudstore.js');
const dt = require('../../utils/datetime.js');
const { PLATFORMS } = require('../../utils/platforms.js');
const { CLOUD_CACHE_TTL } = require('../../utils/constants.js');

const pad = dt.pad;
const fmtTime = dt.fmtTime;

// 抽取记录来源元数据
const KIND_META = {
  shake:   { label: '摇一摇', icon: '🎲', cls: 'k-shake',   verb: '抽取', unit: '个' },
  scratch: { label: '刮一刮', icon: '🪙', cls: 'k-scratch', verb: '刮开', unit: '张' }
};

// 购物记录的平台识别：单一来源，与生活广场共用 utils/platforms.js
const SHOP_EMOJI = {
  '淘宝': '🛒', '京东': '🐶', '拼多多': '🍑', '小红书': '📕', '抖音': '🎵',
  '唯品会': '💎', 'B站': '📺', '得物': '👟', '网易': '📮', '亚马逊': '📦',
  '1688': '🏭'
};
const SHOP_COLOR = {
  '淘宝': '#FF6A00', '京东': '#E1251B', '拼多多': '#E02E24', '小红书': '#FF2442',
  '抖音': '#161823', '唯品会': '#E4007F', 'B站': '#FB7299', '得物': '#2B2B2B',
  '网易': '#E60012', '亚马逊': '#FF9900', '1688': '#FF7300'
};
const SHOP_OTHER = { name: '链接', emoji: '🔗', color: '#FF8FAB' };

// 平台域名 → 展示元数据（emoji/color 只此一份，域名表用共用的）
const PLAT_META = {};
PLATFORMS.forEach(p => {
  PLAT_META[p.name] = { name: p.name, emoji: SHOP_EMOJI[p.name] || '🔗', color: SHOP_COLOR[p.name] || '#FF8FAB' };
});

function shopPlatOf(link) {
  if (!link) return SHOP_OTHER;
  return PLAT_META[platNameOf(link)] || SHOP_OTHER;
}

// 直接复用共用平台的域名匹配逻辑
function platNameOf(link) {
  const l = String(link).toLowerCase();
  for (const p of PLATFORMS) {
    if (p.hosts.some(d => l.indexOf(d) !== -1)) return p.name;
  }
  return '';
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
    // tab 页每次展示都会走这里：TTL 内的重复展示跳过拉取，避免来回切换就全量读 4 个文档
    if (this._lastLoadAt && Date.now() - this._lastLoadAt < CLOUD_CACHE_TTL) return;
    this.render();
  },

  onUnload() {
    // render() 里有 await：页面在等待期间被销毁时不能再 setData
    this._destroyed = true;
  },

  switchTab(e) {
    this.setData({ activeTab: e.currentTarget.dataset.tab });
  },

  onPullDownRefresh() {
    this._lastLoadAt = 0;
    this.render().then(() => wx.stopPullDownRefresh());
  },

  async render() {
    this.setData({ loading: true, loadError: false });
    try {
      // 一次 Promise.all 拉齐 4 个文档（原来列表与回收站角标分两次拉，trash 读了两遍）
      // 注意：用索引访问而不是数组解构 —— 数组解构会被 SWC 编译成
      // require('@swc/runtime/_array_with_holes.js')，小程序运行时不提供该模块
      const res = await Promise.all([
        cloud.loadRecords(),
        cloud.loadOrders(),
        cloud.loadShopping(),
        cloud.loadTrash()
      ]);
      const recs = res[0], orders = res[1], shopping = res[2], trash = res[3];
      this._lastLoadAt = Date.now();
      if (this._destroyed) return;   // 等待期间页面已卸载，不能再 setData
      this.setData({
        records: this._mapRecords(recs),
        orders: this._mapOrders(orders),
        shopping: this._mapShopping(shopping),
        trashList: this._mapTrashList(trash),
        trashCount: trash.length,
        loading: false
      });
    } catch (e) {
      console.error('记录加载失败', e);
      if (this._destroyed) return;
      this.setData({ loading: false, loadError: true });
      wx.showToast({ title: '加载失败，请下拉重试', icon: 'none' });
    }
  },

  // 回收站列表映射：字段契约与 wxml 弹层一致（tid/type/title/desc/amount/time）
  _mapTrashList(trash) {
    return (trash || []).map(t => {
      const d = t.data || {};
      const base = {
        tid: t.id,
        type: t.type,
        time: fmtTime(t.deletedAt)
      };
      if (t.type === 'order') {
        return Object.assign(base, {
          title: '🍽️ 吃饭记录',
          desc: (d.items || []).map(x => (x.name || '') + '×' + (x.count || 1)).join('、') || '订单',
          amount: '¥' + shopMoney(d.total)
        });
      }
      if (t.type === 'shopping') {
        const plat = shopPlatOf(d.link);
        return Object.assign(base, {
          title: plat.emoji + ' ' + plat.name,
          desc: [d.title || '未命名', d.date || ''].filter(Boolean).join(' · '),
          amount: '¥' + shopMoney(d.price)
        });
      }
      const meta = KIND_META[d.kind] || KIND_META.shake;
      const items = d.items || [];
      const desc = items.length
        ? items.map(it => (it.emoji || '') + (it.name || '')).join('、')
        : (d.emoji || '') + (d.name || '');
      return Object.assign(base, {
        title: meta.icon + ' ' + meta.label,
        desc,
        amount: items.length
          ? String(items.length) + meta.unit
          // 旧版单条记录可能连 number 都没有，直接拼会显示「0undefined」
          : (d.number == null ? '' : ((d.number < 10 ? '0' : '') + d.number))
      });
    });
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
          // 批量软删除：一次操作完成「过滤列表 + 批量入回收站」。
          // 原实现逐条删，每条 6 次云调用，100 条约 600 次且中途失败无法回滚
          const list = isLuck ? await cloud.loadRecords()
            : isFood ? await cloud.loadOrders()
            : await cloud.loadShopping();
          const type = isLuck ? 'record' : isFood ? 'order' : 'shopping';
          const docId = isLuck ? 'shared_records'
            : isFood ? 'shared_orders'
            : 'shared_shopping';
          const items = list.map(it => ({ id: it.id, type, data: it }));
          await cloud.batchSoftRemove(docId, items);

          wx.hideLoading();
          wx.showToast({ title: '已清空', icon: 'success' });
          this._lastLoadAt = 0;
          this.render();
        } catch (e) {
          console.error('清空失败', e);
          wx.hideLoading();
          wx.showToast({ title: '清空失败，请重试', icon: 'none' });
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
      this.setData({ trashList: this._mapTrashList(list), trashCount: list.length });
    } catch (e) {
      console.error('回收站加载失败', e);
      this.setData({ trashList: [] });
    }
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
