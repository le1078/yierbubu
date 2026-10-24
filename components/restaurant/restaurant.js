// 小笨餐厅 · 点餐下单（组件版）
// 从 pages/restaurant/restaurant.js 迁移而来，供「小笨生活」内嵌使用；
// pages/restaurant/restaurant 仍保留为独立页（分享/旧路径可用）。
const cloud = require('../../utils/cloudstore.js');
const dt = require('../../utils/datetime.js');
const { MENU_CACHE_TTL } = require('../../utils/constants.js');

const pad = dt.pad;
const nowStr = dt.nowStr;
// 深拷贝：集中一处，避免各方法内联 JSON.parse(JSON.stringify())
function clone(o) { return JSON.parse(JSON.stringify(o)); }

// 默认菜单（首次使用或云端无数据时用）
const DEFAULT_MENU = [
  {
    cat: '招牌菜',
    items: [
      { id: 's1', name: '红烧狮子头', price: 28, emoji: '🦁', desc: '外酥里嫩，酱汁浓郁', taste: '咸鲜', img: '' },
      { id: 's2', name: '糖醋排骨', price: 32, emoji: '🍖', desc: '酸甜开胃，老少皆宜', taste: '酸甜', img: '' },
      { id: 's3', name: '宫保鸡丁', price: 26, emoji: '🐔', desc: '微辣鲜香，下饭神器', taste: '微辣', img: '' },
      { id: 's4', name: '麻婆豆腐', price: 18, emoji: '🌶️', desc: '麻辣嫩滑，川味经典', taste: '麻辣', img: '' }
    ]
  },
  {
    cat: '热炒',
    items: [
      { id: 'h1', name: '青椒肉丝', price: 22, emoji: '🫑', desc: '清爽下饭', taste: '咸鲜', img: '' },
      { id: 'h2', name: '番茄炒蛋', price: 16, emoji: '🍅', desc: '国民家常菜', taste: '酸甜', img: '' },
      { id: 'h3', name: '蒜蓉西兰花', price: 15, emoji: '🥦', desc: '清淡健康', taste: '清淡', img: '' },
      { id: 'h4', name: '干煸豆角', price: 18, emoji: '🫛', desc: '焦香入味', taste: '咸香', img: '' }
    ]
  },
  {
    cat: '汤羹',
    items: [
      { id: 't1', name: '紫菜蛋花汤', price: 8, emoji: '🍲', desc: '清淡鲜美', taste: '清淡', img: '' },
      { id: 't2', name: '玉米排骨汤', price: 22, emoji: '🌽', desc: '滋补养胃', taste: '鲜甜', img: '' },
      { id: 't3', name: '酸辣汤', price: 10, emoji: '🥣', desc: '开胃暖身', taste: '酸辣', img: '' }
    ]
  },
  {
    cat: '主食',
    items: [
      { id: 'z1', name: '米饭', price: 2, emoji: '🍚', desc: '粒粒分明', taste: '', img: '' },
      { id: 'z2', name: '蛋炒饭', price: 12, emoji: '🍳', desc: '金黄诱人', taste: '咸香', img: '' },
      { id: 'z3', name: '阳春面', price: 10, emoji: '🍜', desc: '汤清面滑', taste: '清淡', img: '' },
      { id: 'z4', name: '饺子(10个)', price: 18, emoji: '🥟', desc: '皮薄馅大', taste: '咸鲜', img: '' }
    ]
  },
  {
    cat: '饮品甜点',
    items: [
      { id: 'y1', name: '柠檬蜂蜜水', price: 6, emoji: '🍋', desc: '清爽解腻', taste: '酸甜', img: '' },
      { id: 'y2', name: '红豆双皮奶', price: 10, emoji: '🫘', desc: '香甜滑嫩', taste: '甜', img: '' },
      { id: 'y3', name: '杨枝甘露', price: 14, emoji: '🥭', desc: '果香浓郁', taste: '甜', img: '' },
      { id: 'y4', name: '冰淇淋球', price: 8, emoji: '🍦', desc: '清凉一夏', taste: '甜', img: '' }
    ]
  }
];

Component({
  // 默认 isolated：组件样式不污染小笨生活页面，也不被页面样式影响
  data: {
    // 头部牌子
    chefLeft: '/assets/chef_left.gif',
    chefRight: '/assets/chef_right.gif',
    // 菜单
    menu: DEFAULT_MENU,
    activeCat: 0,
    // 购物车
    cart: {},
    cartList: [],
    cartCount: 0,
    cartTotal: '0.00',
    showCart: false,
    // 下单
    tableNo: '',
    orderSubmitting: false,
    // 餐厅改造
    showMenuEditor: false,
    editCat: 0,
    editingDish: null,
    form: { name: '', price: '', taste: '', desc: '', emoji: '', img: '' },
    // 页面状态
    today: nowStr().split(' ')[0]
  },

  lifetimes: {
    attached() {
      this._menuSnapshot = clone(this.data.menu);
      this._loadMenu();
      this._todayTimer = setInterval(() => {
        this.setData({ today: dt.todayStr() });
      }, 60000);
    },
    detached() {
      // 异步回调（加载/保存/下单）可能在组件销毁后才返回，标记后不再 setData
      this._detached = true;
      if (this._todayTimer) clearInterval(this._todayTimer);
      this._todayTimer = null;
      if (this._catNameTimer) clearTimeout(this._catNameTimer);
      this._catNameTimer = null;
    }
  },

  pageLifetimes: {
    show() {
      // 缓存未过期则跳过，避免每次切 tab 都全量拉取（与 attached 重复）
      if (this._menuCacheAt && Date.now() - this._menuCacheAt < MENU_CACHE_TTL) return;
      this._loadMenu();
    }
  },

  methods: {
    /* ========== 菜单加载（云端共享） ========== */

    async _loadMenu() {
      // 并发保护：避免 attached 与 pageLifetimes.show 同时发起两次请求互相覆盖
      if (this._menuLoading) return;
      this._menuLoading = true;
      try {
        const menu = await cloud.loadMenu();
        if (this._detached) return;
        if (menu && menu.length) {
          this._menuCacheAt = Date.now();
          this._menuSnapshot = clone(menu);
          this.setData({ menu });
        }
      } catch (e) {
        // 加载失败保留当前菜单（可能是本地默认菜单），不清空用户已有数据
        console.error('菜单加载失败，保留当前菜单', e);
      } finally {
        this._menuLoading = false;
      }
    },

    // 保存菜单：失败时回滚到改动前快照，避免下次 show 拉旧数据时用户改动被静默还原
    async _saveMenu(menu) {
      const snapshot = this._menuSnapshot || clone(menu);
      try {
        await cloud.saveMenu(menu);
        this._menuSnapshot = clone(menu);
        return true;
      } catch (e) {
        if (this._detached) return false;
        this.setData({ menu: snapshot });
        this._menuSnapshot = snapshot;
        wx.showToast({ title: '保存失败，已还原', icon: 'none' });
        return false;
      }
    },

    /* ========== 菜单浏览 ========== */

    switchCat(e) {
      this.setData({ activeCat: Number(e.currentTarget.dataset.idx) });
    },

    addToCart(e) {
      const item = e.currentTarget.dataset.item;
      const cart = Object.assign({}, this.data.cart);
      // 不可变写法：替换条目对象而非就地改 count，否则 setData 前后引用相同、diff 不到变化
      const prev = cart[item.id];
      cart[item.id] = prev
        ? { item: prev.item, count: prev.count + 1 }
        : { item, count: 1 };
      this._updateCart(cart);
    },

    minusFromCart(e) {
      const item = e.currentTarget.dataset.item;
      const cart = Object.assign({}, this.data.cart);
      const prev = cart[item.id];
      if (prev && prev.count > 0) {
        if (prev.count === 1) {
          delete cart[item.id];
        } else {
          cart[item.id] = { item: prev.item, count: prev.count - 1 };
        }
      }
      this._updateCart(cart);
    },

    _updateCart(cart) {
      let count = 0, total = 0;
      const cartList = [];
      Object.keys(cart).forEach((id) => {
        const { item, count: c } = cart[id];
        count += c;
        total += item.price * c;
        cartList.push({
          id: item.id,
          emoji: item.emoji,
          img: item.img || '',
          name: item.name,
          price: item.price,
          count: c,
          subtotal: (item.price * c).toFixed(2)
        });
      });
      this.setData({
        cart,
        cartList,
        cartCount: count,
        cartTotal: total.toFixed(2)
      });
    },

    toggleCart() {
      this.setData({ showCart: !this.data.showCart });
    },

    /* ========== 下单 ========== */

    onTableNoInput(e) {
      this.setData({ tableNo: e.detail.value });
    },

    async submitOrder() {
      const { cart, cartCount, cartTotal, tableNo } = this.data;
      if (cartCount === 0) {
        wx.showToast({ title: '还没选菜哦', icon: 'none' });
        return;
      }
      if (this.data.orderSubmitting) return;
      this.setData({ orderSubmitting: true });

      const items = Object.values(cart).map(({ item, count }) => ({
        id: item.id,
        name: item.name,
        price: item.price,
        count,
        subtotal: (item.price * count).toFixed(2)
      }));

      const order = {
        id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        time: nowStr(),
        remark: tableNo || '',
        items,
        total: cartTotal,
        status: '已下单',
        ts: Date.now()
      };

      try {
        // 原子追加：避免 load→unshift→save 的竞态覆盖他人订单
        await cloud.pushOrder(order);
        if (this._detached) return;

        wx.showToast({ title: '下单成功！', icon: 'success' });
        this.setData({
          cart: {},
          cartList: [],
          cartCount: 0,
          cartTotal: '0.00',
          showCart: false,
          tableNo: '',
          orderSubmitting: false
        });
        this.triggerEvent('ordered', { order });
      } catch (err) {
        console.error('下单失败', err);
        wx.showToast({ title: '下单失败，请重试', icon: 'none' });
        this.setData({ orderSubmitting: false });
      }
    },

    /* ========== 餐厅改造 ========== */

    openMenuEditor() {
      this.setData({
        showMenuEditor: true,
        editCat: this.data.activeCat,
        editingDish: null,
        form: { name: '', price: '', taste: '', desc: '', emoji: '', img: '' }
      });
    },

    closeMenuEditor() {
      this.setData({ showMenuEditor: false, editingDish: null });
    },

    switchEditCat(e) {
      this.setData({ editCat: Number(e.currentTarget.dataset.idx) });
    },

    onCatNameInput(e) {
      const idx = Number(e.currentTarget.dataset.idx);
      // 路径 setData：只更新分类名字符串，避免整份菜单深拷贝 + 全量 diff
      this.setData({ [`menu[${idx}].cat`]: e.detail.value });
      // 改名也要持久化：只 setData 的话，菜单缓存过期重读/下次进页就打回原名
      if (this._catNameTimer) clearTimeout(this._catNameTimer);
      this._catNameTimer = setTimeout(() => {
        this._catNameTimer = null;
        this._saveMenu(this.data.menu);
      }, 500);
    },

    addCat() {
      const newMenu = clone(this.data.menu);
      newMenu.push({ cat: '新分类', items: [] });
      this.setData({ menu: newMenu, editCat: newMenu.length - 1 });
      this._saveMenu(newMenu);
    },

    deleteCat(e) {
      const idx = Number(e.currentTarget.dataset.idx);
      const cat = this.data.menu[idx];
      wx.showModal({
        title: '提示',
        content: `确定删除分类「${cat.cat}」吗？里面的菜品也会一起删除。`,
        success: async (res) => {
          if (!res.confirm) return;
          const newMenu = JSON.parse(JSON.stringify(this.data.menu));
          newMenu.splice(idx, 1);
          // activeCat 也要夹紧：删掉最后一个分类后它仍指向旧下标，
          // menu[activeCat] 为 undefined，菜品列表渲染成空白
          this.setData({
            menu: newMenu,
            editCat: Math.max(0, idx - 1),
            activeCat: Math.min(this.data.activeCat, newMenu.length - 1)
          });
          await this._saveMenu(newMenu);
          wx.showToast({ title: '已删除分类', icon: 'success' });
        }
      });
    },

    editDish(e) {
      const item = e.currentTarget.dataset.item;
      this.setData({
        editingDish: item,
        form: {
          name: item.name || '',
          price: String(item.price || ''),
          taste: item.taste || '',
          desc: item.desc || '',
          emoji: item.emoji || '',
          img: item.img || ''
        }
      });
    },

    onFormInput(e) {
      const field = e.currentTarget.dataset.field;
      this.setData({ [`form.${field}`]: e.detail.value });
    },

    chooseFormImg() {
      wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        success: (res) => {
          const tempPath = res.tempFiles[0].tempFilePath;
          wx.showLoading({ title: '上传中…', mask: true });
          const cloudPath = `dish-images/${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
          wx.cloud.uploadFile({
            cloudPath,
            filePath: tempPath,
            success: (uploadRes) => {
              wx.hideLoading();
              this.setData({ 'form.img': uploadRes.fileID });
              wx.showToast({ title: '图片已上传', icon: 'success' });
            },
            fail: (err) => {
              wx.hideLoading();
              console.error('图片上传失败', err);
              wx.showToast({ title: '图片上传失败', icon: 'none' });
            }
          });
        }
      });
    },

    removeFormImg() {
      this.setData({ 'form.img': '' });
    },

    resetForm() {
      this.setData({
        editingDish: null,
        form: { name: '', price: '', taste: '', desc: '', emoji: '', img: '' }
      });
    },

    async saveDish() {
      const { form, editCat, editingDish, menu } = this.data;
      if (!form.name.trim()) {
        wx.showToast({ title: '请输入菜品名称', icon: 'none' });
        return;
      }
      // 严格校验：parseFloat('12abc')=12、parseFloat('-5')=-5 都能通过旧判断
      const price = Number(String(form.price).trim());
      if (!Number.isFinite(price) || price < 0) {
        wx.showToast({ title: '请输入正确的价格', icon: 'none' });
        return;
      }

      const newMenu = clone(menu);
      const catItems = newMenu[editCat].items;

      if (editingDish) {
        const idx = catItems.findIndex(it => it.id === editingDish.id);
        // 找不到目标（编辑中切换了分类）→ 取消保存并明确提示，不要静默丢弃用户输入
        if (idx === -1) {
          wx.showToast({ title: '该菜品不在当前分类，已取消', icon: 'none' });
          return;
        }
        // 用 Object.assign 而不是对象展开：对象展开会被 SWC 编译成
        // require('@swc/runtime/_object_spread.js')，小程序运行时不提供该模块
        catItems[idx] = Object.assign({}, catItems[idx], {
          name: form.name.trim(),
          price,
          taste: form.taste.trim(),
          desc: form.desc.trim(),
          emoji: form.emoji.trim() || catItems[idx].emoji,
          img: form.img || ''
        });
      } else {
        const newId = 'd' + Date.now().toString(36);
        catItems.push({
          id: newId,
          name: form.name.trim(),
          price,
          taste: form.taste.trim(),
          desc: form.desc.trim(),
          emoji: form.emoji.trim() || '🍽️',
          img: form.img || ''
        });
      }

      this.setData({ menu: newMenu, showMenuEditor: false, editingDish: null });
      const ok = await this._saveMenu(newMenu);
      if (ok) {
        wx.showToast({ title: editingDish ? '已保存修改' : '已添加菜品', icon: 'success' });
      } else {
        // 保存失败时面板已回滚，重新打开让用户能找回输入
        this.setData({ showMenuEditor: true, editingDish });
      }
    },

    async deleteDish() {
      const { editingDish, editCat, menu } = this.data;
      if (!editingDish) return;
      wx.showModal({
        title: '提示',
        content: `确定删除「${editingDish.name}」吗？`,
        success: async (res) => {
          if (!res.confirm) return;
          const newMenu = clone(menu);
          const catItems = newMenu[editCat].items;
          const idx = catItems.findIndex(it => it.id === editingDish.id);
          if (idx === -1) {
            wx.showToast({ title: '该菜品不在当前分类，已取消', icon: 'none' });
            return;
          }
          catItems.splice(idx, 1);
          this.setData({ menu: newMenu, showMenuEditor: false, editingDish: null });
          await this._saveMenu(newMenu);
          wx.showToast({ title: '已删除', icon: 'success' });
        }
      });
    },

    noop() {}
  }
});
