// 回收站滚动修复回归：
//   1) 长列表 → scroll-view 拿到确定 px 高度（小程序 scroll-view 必须有确定高度才会滚动）
//   2) 短列表 / 空列表 → 高度置 0，交回内容自适应（不出现大片空白）
//   3) 没有 createSelectorQuery 的旧基础库/测试桩下不报错
// 同时校验 wxml/wxss 的修复确实是「确定高度 + 内层 padding」这一套。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0;
function ok(cond, label, extra) {
  if (cond) console.log('  ✓ ' + label);
  else { failures++; console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}

/* ---------- 假云端：回收站 12 条 ---------- */
const trash = [];
for (let i = 0; i < 12; i++) {
  trash.push({
    id: 't' + i,
    type: 'order',
    deletedAt: 1760000000000 + i * 1000,
    data: { total: 20 + i, items: [{ name: '测试菜', count: 1 }] }
  });
}
const fakeCloud = {
  async loadRecords() { return []; },
  async loadOrders() { return []; },
  async loadShopping() { return []; },
  async loadTrash() { return trash.slice(); }
};

/* ---------- 可控的布局测量 ---------- */
const rects = {
  head: { height: 40 },
  tip: { height: 35 },
  inner: { height: 900 }
};
let queryCount = 0;
function makeQuery() {
  const sel = [];
  return {
    select(s) { sel.push(s); return this; },
    boundingClientRect() { return this; },
    exec(cb) {
      queryCount++;
      cb(sel.map((s) => (s === '.tp-head' ? rects.head : s === '.tp-tip' ? rects.tip : rects.inner)));
    }
  };
}

global.wx = {
  showToast() {},
  showLoading() {},
  hideLoading() {},
  showModal() {},
  getWindowInfo: () => ({ windowHeight: 800 }),
  createSelectorQuery: makeQuery
};

/* ---------- 页面加载（与 tools/trash_flow_test.js 同一套桩） ---------- */
function loadPage(rel, stubs) {
  const base = path.join(ROOT, rel);
  let cfg = null;
  const req = (r) => {
    if (r.indexOf('cloudstore') !== -1) return stubs;
    if (r.indexOf('datetime.js') !== -1) return require(path.join(ROOT, 'utils/datetime.js'));
    if (r.indexOf('platforms.js') !== -1) return require(path.join(ROOT, 'utils/platforms.js'));
    if (r.indexOf('constants.js') !== -1) return require(path.join(ROOT, 'utils/constants.js'));
    return {};
  };
  new Function('Page', 'Component', 'require', 'wx', 'getApp',
    fs.readFileSync(base + '.js', 'utf8'))(
    (c) => { cfg = c; }, (c) => { cfg = c; }, req, global.wx, () => ({ globalData: {} })
  );
  const ctx = Object.assign({}, cfg, {
    data: JSON.parse(JSON.stringify(cfg.data || {})),
    setData(patch, cb) {
      Object.keys(patch).forEach((k) => { this.data[k] = patch[k]; });
      if (cb) cb.call(this);
    }
  });
  return ctx;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function main() {
  console.log('\n▶ 回收站滚动区高度');

  const page = loadPage('pages/records/records', fakeCloud);
  page.openTrash();
  await sleep(20);

  // 800px 高屏：0.64*800=512，0.8*800-40-35=565 → 取 512
  ok(page.data.showTrash === true, '回收站已打开');
  ok(page.data.trashList.length === 12, '回收站读到 12 条', page.data.trashList.length);
  ok(page.data.trashBodyH === 512, '长列表：滚动区拿到确定高度 512px', page.data.trashBodyH);
  ok(queryCount > 0, '确实做了布局测量', queryCount);

  // 内容变矮（恢复/清空后）→ 高度归零，交回自适应
  rects.inner.height = 200;
  await page._loadTrash();
  ok(page.data.trashBodyH === 0, '短列表：高度归零（按内容自适应）', page.data.trashBodyH);

  // 关闭弹层也会复位
  rects.inner.height = 900;
  await page._loadTrash();
  ok(page.data.trashBodyH === 512, '再次变长：重新拿到确定高度', page.data.trashBodyH);
  page.closeTrash();
  ok(page.data.trashBodyH === 0, '关闭回收站后高度复位', page.data.trashBodyH);

  // 旧基础库 / 测试桩没有 createSelectorQuery 时不能抛错
  const saved = global.wx.createSelectorQuery;
  global.wx.createSelectorQuery = undefined;
  let threw = false;
  try {
    page.setData({ showTrash: true });
    page._fitTrashBody();
  } catch (e) { threw = true; }
  global.wx.createSelectorQuery = saved;
  page.setData({ showTrash: false, trashBodyH: 0 });
  ok(threw === false, '无 createSelectorQuery 时安全跳过');

  /* ---------- 静态契约 ---------- */
  console.log('\n▶ wxml / wxss 修复方式');
  const wxml = fs.readFileSync(path.join(ROOT, 'pages/records/records.wxml'), 'utf8');
  const wxss = fs.readFileSync(path.join(ROOT, 'pages/records/records.wxss'), 'utf8');
  ok(/<scroll-view scroll-y class="tp-body" style="\{\{trashBodyH \? 'height:' \+ trashBodyH \+ 'px' : ''\}\}">/.test(wxml),
    'scroll-view 绑定了确定高度的 inline style');
  ok(/<view class="tp-inner">/.test(wxml), 'padding 放在内层 .tp-inner');
  ok(/\.tp-body\s*\{\s*max-height:\s*64vh;\s*\}/.test(wxss), 'wxss 保留 max-height 兜底');
  ok(!/\.tp-body[^}]*padding/.test(wxss), '.tp-body 上不再有 padding');

  console.log('\n' + (failures === 0 ? '全部通过 ✓' : failures + ' 项失败 ✗'));
  process.exit(failures === 0 ? 0 : 1);
})();
