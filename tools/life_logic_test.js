// 小笨生活 · 逻辑自测（node 里模拟 wx 环境跑真实页面方法）
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let failures = 0;
function ok(cond, label, extra) {
  if (cond) { console.log('  ✓ ' + label); }
  else { failures++; console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}

// ---- 极简 wx 模拟 ----
const calls = { toast: [], storage: {}, clipboard: '' };
global.wx = {
  getStorageSync: (k) => calls.storage[k],
  setStorageSync: (k, v) => { calls.storage[k] = v; },
  getClipboardData: ({ success }) => success({ data: calls.clipboard }),
  setClipboardData: ({ data, success }) => { calls.lastCopied = data; success && success(); },
  showToast: (o) => calls.toast.push(o.title),
  showModal: (o) => o.success && o.success({ confirm: true }),
  vibrateShort: () => {},
  cloud: {}
};

const cloudStub = {
  loadShopping: async () => calls.remote || [],
  saveShopping: async (list) => { calls.saved = JSON.parse(JSON.stringify(list)); },
  loadMenu: async () => null,
  loadOrders: async () => [],
  saveOrders: async () => {}
};

function loadPage(rel, stubs) {
  const base = path.join(ROOT, rel);
  let cfg = null;
  const req = (r) => {
    if (r.indexOf('cloudstore') !== -1) return stubs;
    return require(r.startsWith('.') ? path.resolve(path.dirname(base + '.js'), r) : r);
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
  if (cfg.methods) Object.keys(cfg.methods).forEach((k) => { if (typeof cfg.methods[k] === 'function') ctx[k] = cfg.methods[k]; });
  return ctx;
}

(async function main() {
  console.log('\n▶ 小笨生活');

  // 1) 有云端数据时加载
  calls.remote = [{
    id: 'x1', title: '测试拖鞋', price: 39.9, link: 'https://item.taobao.com/item.htm?id=1',
    date: '2026-10-10', tag: '生活', note: '', bought: false, ts: 1
  }];
  const page = loadPage('pages/life/life', cloudStub);
  page.onLoad();
  await new Promise((r) => setTimeout(r, 10));
  ok(page.data.shopCount === 1, '加载云端购物记录', page.data.shopCount);
  ok(page.data.groups.length === 1, '按月分组', page.data.groups.length);
  ok(page.data.groups[0].items[0].platName === '淘宝', '识别平台', page.data.groups[0].items[0].platName);
  ok(page.data.statMonthTotal === '0.00', '未到手不计入本月支出', page.data.statMonthTotal);

  // 2) 粘贴识别 → 保存
  calls.clipboard = '【淘宝】https://m.tb.cn/h.abc 奶油色毛绒拖鞋 38码 ¥39.90 点击链接直接打开';
  page.setData({ view: 'buy' });
  page.pasteFromClipboard();
  ok(page.data.form.title === '奶油色毛绒拖鞋 38码', '识别商品名', page.data.form.title);
  ok(page.data.form.price === '39.90', '识别价格', page.data.form.price);
  ok(page.data.form.link.indexOf('tb.cn') !== -1, '识别链接', page.data.form.link);
  ok(page.data.form.platName === '淘宝', '识别平台名', page.data.form.platName);

  await page.quickSave();
  ok(page.data.shopCount === 2, '保存后条数 +1', page.data.shopCount);
  ok(page.data.form.title === '', '保存后表单清空', page.data.form.title);
  ok(calls.saved && calls.saved.length === 2, '写回云端', calls.saved && calls.saved.length);
  ok(calls.storage['yb_shopping'].length === 2, '写回本地缓存', calls.storage['yb_shopping'].length);
  ok(page.data.showPop === undefined, '保存后不再弹表情包（已按要求移除）');

  // 3) 标记已到手
  const newest = page._items[0];
  await page.toggleBought({ currentTarget: { dataset: { id: newest.id } } });
  ok(newest.bought === true, '标记已到手');
  ok(page.data.statBought === 1, '已到手计数 +1', page.data.statBought);
  ok(page.data.statMonthTotal !== '0.00', '到手后计入本月支出', page.data.statMonthTotal);

  // 4) 编辑
  page.openEdit({ currentTarget: { dataset: { item: newest } } });
  ok(page.data.showEdit === true && page.data.editForm.id === newest.id, '打开编辑弹层');
  page.setData({ 'editForm.title': '改过名字的拖鞋', 'editForm.price': '49.5' });
  await page.saveEdit();
  ok(page._items.find((i) => i.id === newest.id).title === '改过名字的拖鞋', '保存改名');
  ok(page._items.find((i) => i.id === newest.id).price === 49.5, '保存改价', page._items.find((i) => i.id === newest.id).price);
  ok(page.data.showEdit === false, '编辑后关闭弹层');

  // 5) 筛选
  page.setFilter({ currentTarget: { dataset: { f: 'done' } } });
  ok(page.data.groupsCount === 1, '已到手筛选', page.data.groupsCount);
  page.setFilter({ currentTarget: { dataset: { f: 'wish' } } });
  ok(page.data.groupsCount === 1, '想买筛选', page.data.groupsCount);
  page.setFilter({ currentTarget: { dataset: { f: 'all' } } });
  ok(page.data.groupsCount === 2, '全部筛选', page.data.groupsCount);

  // 6) 删除
  page.openEdit({ currentTarget: { dataset: { item: page._items[0] } } });
  await page.deleteEdit();
  ok(page._items.length === 1, '删除一条', page._items.length);
  ok(calls.saved.length === 1, '删除同步云端', calls.saved.length);

  // 7) 复制链接
  page.copyLink({ currentTarget: { dataset: { link: 'https://a.com/x' } } });
  ok(calls.lastCopied === 'https://a.com/x', '复制链接');

  // 等 showModal 里 async 回调的 toast 落定
  await new Promise((r) => setTimeout(r, 20));

  // 8) 校验：空标题 + 空链接不允许保存；有链接但没价格也要拦下
  page.setData({ 'form.title': '', 'form.price': '', 'form.link': '' });
  const before = page._items.length;
  await page.quickSave();
  ok(page._items.length === before, '空表单不落库');
  ok(calls.toast[calls.toast.length - 1] === '先写个商品名吧', '空表单有提示', calls.toast[calls.toast.length - 1]);

  page.setData({ 'form.link': 'https://item.jd.com/1.html' });
  await page.quickSave();
  ok(page._items.length === before, '只有链接没价格也拦下');
  ok(calls.toast[calls.toast.length - 1] === '别忘了填价格', '缺价格有提示', calls.toast[calls.toast.length - 1]);

  // 9) 回落到本地缓存（云端失败）
  const failing = Object.assign({}, cloudStub, { loadShopping: async () => { throw new Error('offline'); } });
  calls.storage['yb_shopping'] = [{ id: 'l1', title: '本地记录', price: 1, date: '2026-10-01', bought: false, ts: 1 }];
  const p2 = loadPage('pages/life/life', failing);
  p2.onLoad();
  await new Promise((r) => setTimeout(r, 10));
  ok(p2.data.shopCount === 1 && p2.data.groups[0].items[0].title === '本地记录', '云端失败回落本地缓存');


  // 10) 平台识别必须按主机名匹配，不能整串包含（防误判）
  const plat = require('../utils/platforms.js');
  const platCases = [
    ['https://item.taobao.com/item.htm?id=1', '淘宝'],
    ['https://m.tb.cn/h.abc', '淘宝'],
    ['https://item.jd.com/1.html', '京东'],
    ['m.tb.cn/h.xyz', '淘宝'],
    ['https://user:pw@item.jd.com:443/x', '京东'],
    ['https://evil.com/?ref=taobao.com', ''],
    ['https://taobao.com.evil.com/', ''],
    ['https://notjd.com.evil.com/x', ''],
    ['', '']
  ];
  let platBad = 0;
  for (const c of platCases) {
    const got = plat.platOf(c[0]);
    if (got !== c[1]) {
      platBad++;
      console.log('  平台误判:', JSON.stringify(c[0]), '期望', JSON.stringify(c[1]), '实际', JSON.stringify(got));
    }
  }
  ok(platBad === 0, '平台识别按主机名后缀匹配（' + platCases.length + ' 个用例，含钓鱼式 URL）');

  // 11) 粘贴后立刻保存：延迟的自动解析不能把已清空的表单又填回去
  const p3 = loadPage('pages/life/life', cloudStub);
  p3.onLoad();
  await new Promise((r) => setTimeout(r, 10));
  const beforeCount = p3.data.shopCount;
  p3.setData({ 'form.title': '拖鞋', 'form.price': '39.9' });
  p3.onDraftInput({ detail: { value: '【淘宝】https://m.tb.cn/h.abc 奶油拖鞋 ¥59.90' } });
  p3.onFormInput({ currentTarget: { dataset: { field: 'title' } }, detail: { value: '拖鞋' } });
  await p3.quickSave();
  await new Promise((r) => setTimeout(r, 500));   // 等过 300ms 防抖窗口
  ok(p3.data.form.title === '', '保存后表单保持清空（不被延迟解析回填）：' + JSON.stringify(p3.data.form.title));
  ok(p3.data.shopCount === beforeCount + 1, '保存后列表只 +1 条（没有重复记录）：' + beforeCount + '→' + p3.data.shopCount);
  if (p3._parseTimer) clearTimeout(p3._parseTimer);

  console.log(failures ? `\n共 ${failures} 项失败` : '\n全部通过 ✓');
  process.exit(failures ? 1 : 0);
})();
