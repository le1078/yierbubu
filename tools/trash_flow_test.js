// 回收站链路自测：购物记录 删除 → 进回收站 → 恢复
// 用内存版云文档模拟 cloudstore 的单文档读写行为。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0;
function ok(cond, label, extra) {
  if (cond) console.log('  ✓ ' + label);
  else { failures++; console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}

/* ---------- 内存数据库 ---------- */
const store = {};
function clone(o) { return JSON.parse(JSON.stringify(o)); }

const fakeCloud = {
  _shopping: [],
  _trash: [],
  async loadRecords() { return []; },
  async loadOrders() { return []; },
  async loadShopping() { return clone(this._shopping); },
  async saveShopping(list) { this._shopping = clone(list); },
  async loadTrash() { return clone(this._trash); },
  async saveTrash(list) { this._trash = clone(list); },
  // 被测试的同名逻辑（跟 utils/cloudstore.js 里保持一致）
  async trashShoppingById(id, record) {
    const list = await this.loadShopping();
    const idx = list.findIndex((r) => String(r.id) === String(id));
    const rec = idx !== -1 ? list[idx] : record;
    if (!rec) return;
    if (idx !== -1) await this.saveShopping(list.filter((_, i) => i !== idx));
    const trash = await this.loadTrash();
    trash.unshift(Object.assign({
      id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      deletedAt: Date.now()
    }, { type: 'shopping', data: rec }));
    await this.saveTrash(trash.slice(0, 100));
  },
  async restoreTrashItem(trashId) {
    const trash = await this.loadTrash();
    const item = trash.find((it) => String(it.id) === String(trashId));
    if (!item) return null;
    await this.saveShopping([item.data].concat(await this.loadShopping()));
    await this.saveTrash(trash.filter((it) => String(it.id) !== String(trashId)));
    return item;
  }
};

/* ---------- 页面加载器 ---------- */
// 真实模块白名单：页面里 require 的 utils 模块给真实实现，其余返回空桩
const REAL_MODULES = {
  'datetime.js': require(path.join(ROOT, 'utils/datetime.js')),
  'platforms.js': require(path.join(ROOT, 'utils/platforms.js')),
  'amount.js': require(path.join(ROOT, 'utils/amount.js')),
  'constants.js': require(path.join(ROOT, 'utils/constants.js')),
  'log.js': require(path.join(ROOT, 'utils/log.js'))
};
function loadPage(rel, stubs) {
  const base = path.join(ROOT, rel);
  let cfg = null;
  const req = (r) => {
    if (r.indexOf('cloudstore') !== -1) return stubs;
    for (const name of Object.keys(REAL_MODULES)) {
      if (r.indexOf(name) !== -1) return REAL_MODULES[name];
    }
    return {};
  };
  new Function('Page', 'Component', 'require', 'wx', 'getApp',
    fs.readFileSync(base + '.js', 'utf8'))(
    (c) => { cfg = c; }, (c) => { cfg = c; }, req, global.wx, () => ({ globalData: {} })
  );
  const ctx = Object.assign({}, cfg, {
    data: JSON.parse(JSON.stringify(cfg.data || {})),
    setData(patch, cb) {
      Object.keys(patch).forEach((k) => {
        if (k.indexOf('.') === -1) { this.data[k] = patch[k]; return; }
        const parts = k.split('.');
        let o = this.data;
        for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
        o[parts[parts.length - 1]] = patch[k];
      });
      if (cb) cb.call(this);
    }
  });
  if (cfg.methods) Object.keys(cfg.methods).forEach((k) => {
    if (typeof cfg.methods[k] === 'function') ctx[k] = cfg.methods[k];
  });
  return ctx;
}

const toastLog = [];
global.wx = {
  getStorageSync: () => undefined,
  setStorageSync: () => {},
  showToast: (o) => toastLog.push(o.title),
  showModal: (o) => o.success && o.success({ confirm: true }),
  showLoading: () => {},
  hideLoading: () => {},
  getClipboardData: ({ success }) => success({ data: '' }),
  setClipboardData: ({ success }) => success && success(),
  vibrateShort: () => {},
  pageScrollTo: () => {},
  cloud: {}
};

(async function main() {
  console.log('\n▶ 购物记录 → 回收站 → 恢复');

  fakeCloud._shopping = [
    { id: 's1', title: '想删掉的拖鞋', price: 39.9, link: 'https://item.taobao.com/item.htm?id=1', date: '2026-10-19', tag: '生活', note: '要 38 码', bought: false, ts: 1 },
    { id: 's2', title: '留下的杯子', price: 25, link: '', date: '2026-10-18', tag: '', note: '', bought: true, ts: 2 }
  ];

  const life = loadPage('pages/life/life', fakeCloud);
  await life._load();
  ok(life._items.length === 2, '初始读到 2 条', life._items.length);

  // 1) 在生活广场删除一条
  life.openEdit({ currentTarget: { dataset: { item: life._items[0] } } });
  await life.deleteEdit();
  await new Promise((r) => setTimeout(r, 30));

  ok(life._items.length === 1, '生活广场已移除', life._items.length);
  ok(fakeCloud._shopping.length === 1, '云端清单已移除', fakeCloud._shopping.length);
  ok(fakeCloud._trash.length === 1, '★ 回收站收到 1 条（原来的 bug 这里是 0）', fakeCloud._trash.length);
  ok(fakeCloud._trash[0].type === 'shopping', '回收站类型为 shopping', fakeCloud._trash[0].type);
  ok(fakeCloud._trash[0].data.title === '想删掉的拖鞋', '回收站保留了完整内容', fakeCloud._trash[0].data.title);

  // 2) 记录页能看到它（含标题/价格/备注）
  const records = loadPage('pages/records/records', fakeCloud);
  records.setData({ activeTab: 'shopping' });
  await records.render();
  ok(records.data.shopping.length === 1, '记录页购物 tab 显示 1 条', records.data.shopping.length);
  const shown = records.data.shopping[0];
  ok(shown.title === '留下的杯子', '记录页标题正确', shown.title);
  ok(shown.priceText === '25.00', '记录页价格格式化', shown.priceText);
  ok(shown.platName === '链接', '无链接时平台显示「链接」', shown.platName);
  ok(shown.bought === true, '到手状态正确');

  // 3) 回收站列表映射（记录页弹层）
  await records._loadTrash();
  records.setData({ showTrash: true });
  await records._loadTrash();
  const mapped = records._mapTrashList(fakeCloud._trash)[0];
  // 该条链接是 item.taobao.com → 应识别为「淘宝」
  ok(mapped.title.indexOf('淘宝') !== -1, '回收站标题显示平台名', mapped.title);
  ok(mapped.desc.indexOf('想删掉的拖鞋') !== -1, '回收站显示商品名', mapped.desc);
  ok(mapped.amount === '¥39.90', '回收站显示金额', mapped.amount);

  // 4) 恢复
  const tid = fakeCloud._trash[0].id;
  await fakeCloud.restoreTrashItem(tid);
  ok(fakeCloud._shopping.length === 2, '恢复后回到购物清单', fakeCloud._shopping.length);
  ok(fakeCloud._trash.length === 0, '回收站已清空该条', fakeCloud._trash.length);
  ok(fakeCloud._shopping[0].note === '要 38 码', '恢复后备注还在', fakeCloud._shopping[0].note);

  // 5) 记录页删除购物记录（走同一条链路，且必须存原始记录而不是展示对象）
  fakeCloud._shopping = [{ id: 's9', title: '记录页删除测试', price: 10, date: '2026-10-19', bought: false, ts: 3 }];
  fakeCloud._trash = [];
  const r2 = loadPage('pages/records/records', fakeCloud);
  r2.setData({ activeTab: 'shopping' });
  await r2.render();
  await r2.deleteOne({ currentTarget: { dataset: { id: 's9' } } });
  ok(fakeCloud._shopping.length === 0, '记录页删除后清单为空', fakeCloud._shopping.length);
  ok(fakeCloud._trash.length === 1, '记录页删除也能进回收站', fakeCloud._trash.length);
  ok(fakeCloud._trash[0].data.price === 10, '★ 回收站存的是原始 price 而非 priceText', fakeCloud._trash[0].data.price);

  console.log(failures ? `\n共 ${failures} 项失败` : '\n全部通过 ✓');
  process.exit(failures ? 1 : 0);
})();
