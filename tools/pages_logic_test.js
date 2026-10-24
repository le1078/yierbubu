// 主包页面/组件逻辑测试：日历网格与结算、记录映射、餐厅购物车与菜单编辑。
// 这些模块此前只有静态检查，没有任何行为断言。
//
// 用法：node tools/pages_logic_test.js

const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function check(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); return true; }
  fail++;
  failures.push(name);
  console.log('  ❌ ' + name);
  return false;
}

/* ========== mock 环境 ========== */
let captured = null;
const modals = [];
global.Page = function (def) { captured = def; };
global.Component = function (def) { captured = def; };
global.getApp = function () { return { globalData: {} }; };
global.wx = {
  showToast: function () {},
  showModal: function (o) { modals.push(o); if (o && o.success) o.success({ confirm: true }); },
  hideLoading: function () {},
  showLoading: function () {},
  getStorageSync: function () { return null; },
  setStorageSync: function () {},
  createSelectorQuery: function () { return null; },
  cloud: {
    database: function () {
      return {
        serverDate: function () { return new Date(); },
        command: { push: function (v) { return { __push: v }; }, lte: function (v) { return { __op: 'lte', v: v }; } },
        collection: function () {
          return {
            doc: function () {
              return {
                get: function () { return Promise.resolve({ data: { list: [] } }); },
                update: function () { return Promise.resolve({}); },
                set: function () { return Promise.resolve({}); },
                watch: function () { return { close: function () {} }; }
              };
            },
            add: function () { return Promise.resolve({ _id: 'x' }); },
            where: function () { return { limit: function () { return this; }, get: function () { return Promise.resolve({ data: [] }); } }; }
          };
        }
      };
    }
  }
};

function loadDef(rel) {
  captured = null;
  delete require.cache[require.resolve(path.join(__dirname, '..', rel))];
  require(path.join(__dirname, '..', rel));
  if (!captured) throw new Error('Page/Component 未注册: ' + rel);
  return captured;
}

function instantiate(def, isComponent) {
  const src = isComponent ? (def.methods || {}) : def;
  const page = {};
  for (const k of Object.keys(src)) {
    if (typeof src[k] === 'function') page[k] = src[k];
  }
  // 组件属性也挂上（有些方法用 this.properties）
  for (const k of Object.keys(def)) {
    if (k !== 'methods' && k !== 'data') page[k] = def[k];
  }
  page.data = JSON.parse(JSON.stringify(def.data || {}));
  page.properties = def.properties || {};
  page.setData = function (patch, cb) {
    if (patch) for (const k of Object.keys(patch)) this.data[k] = patch[k];
    if (typeof cb === 'function') cb();
  };
  page.triggerEvent = function () {};
  page._destroyed = false;
  return page;
}

/* ================= 1. 日历 ================= */
console.log('[1] 日历：网格 / 闰年 / 今日标记');
{
  const def = loadDef('pages/calendar/calendar.js');
  const cal = instantiate(def, false);
  cal.data.mapping = {};

  // 2024-02 闰年：29 天，1 号是周四（getDay=4）
  cal.data.calY = 2024;
  cal.data.calM = 1;
  cal._memoCal = {};
  cal._buyCal = {};
  cal.renderCalendar();
  const grid = cal.data.grid;
  const days = grid.filter((g) => !g.empty);
  check(days.length === 29, '2024 年 2 月 29 天（闰年，实际 ' + days.length + '）');
  check(grid.filter((g) => g.empty).length === 4, '前方留白 4 格（周四起，实际 ' + grid.filter((g) => g.empty).length + '）');
  check(cal.data.monthLabel === '2024年 2月', '月份标题正确（' + cal.data.monthLabel + '）');
  // 每格 key 唯一
  const keys = grid.map((g) => g.key);
  check(new Set(keys).size === keys.length, '网格 key 全部唯一（wx:key 不会重复）');
  const ds = days[0].ds;
  check(ds === '2024-02-01', '日期串补零正确（' + ds + '）');

  // 2025-02 平年 28 天
  cal.data.calM = 1;
  cal.data.calY = 2025;
  cal.renderCalendar();
  check(cal.data.grid.filter((g) => !g.empty).length === 28, '2025 年 2 月 28 天（平年）');

  // 12 月有 31 天
  cal.data.calY = 2026;
  cal.data.calM = 11;
  cal.renderCalendar();
  check(cal.data.grid.filter((g) => !g.empty).length === 31, '12 月 31 天');
}

console.log('\n[2] 日历：跨年翻页 / 结算金额');
{
  const def = loadDef('pages/calendar/calendar.js');
  const cal = instantiate(def, false);
  cal.data.mapping = {};
  cal._memoCal = {};
  cal._buyCal = {};

  // 12 月 → 下一月应变成次年 1 月
  cal.data.calY = 2026;
  cal.data.calM = 11;
  cal.renderCalendar();
  cal.nextM();
  check(cal.data.calY === 2027 && cal.data.calM === 0, '12 月翻到次年 1 月（' + cal.data.calY + '-' + (cal.data.calM + 1) + '）');
  cal.prevM();
  check(cal.data.calY === 2026 && cal.data.calM === 11, '再翻回 2026 年 12 月');
  // 1 月 → 上一月应变成上一年 12 月
  cal.data.calY = 2026;
  cal.data.calM = 0;
  cal.prevM();
  check(cal.data.calY === 2025 && cal.data.calM === 11, '1 月翻到上一年 12 月');

  // 结算：三注 10 元 + 一注命中（赔率 47）+ 额外 5 元
  cal.data.buyItems = [
    [{ name: '马', number: 7, amount: '10' }],
    [{ name: '蛇', number: 6, amount: '10' }],
    [{ name: '龙', number: 5, amount: '10' }]
  ];
  cal.data.kaiValues = [{ name: '马', number: 7 }, null, null];
  cal.data.extraAmount = '5';
  cal.updateTotals();
  check(cal.data.total === '30.00', '总投入 30.00（实际 ' + cal.data.total + '）');
  check(cal.data.winStr === '470.00', '中奖 470.00（实际 ' + cal.data.winStr + '）');
  check(cal.data.middle === '475.00', '合计 475.00（实际 ' + cal.data.middle + '）');
  check(cal.data.profit === '445.00' && cal.data.profitNeg === false, '盈亏 445.00');
  // 未命中 → 亏损
  cal.data.kaiValues = [{ name: '兔', number: 4 }, null, null];
  cal.updateTotals();
  check(cal.data.winStr === '0.00' && cal.data.profit === '-25.00' && cal.data.profitNeg === true,
    '未中奖时亏损 -25.00（额外 5 - 投入 30）');
}

/* ================= 3. 记录页映射 ================= */
console.log('\n[3] 记录页：回收站/购物映射健壮性');
{
  const def = loadDef('pages/records/records.js');
  const rec = instantiate(def, false);

  // 旧版记录：没有 items、没有 number —— 不能显示 "0undefined"
  const legacy = rec._mapTrashList([
    { id: 't1', type: 'record', deletedAt: Date.now(), data: { kind: 'shake' } }
  ]);
  check(legacy.length === 1, '旧记录能映射');
  check(String(legacy[0].amount).indexOf('undefined') === -1,
    '旧记录不出现 undefined 文案（实际 "' + legacy[0].amount + '"）');

  // 新版多注记录：显示注数
  const multi = rec._mapTrashList([
    { id: 't2', type: 'record', deletedAt: Date.now(),
      data: { kind: 'shake', items: [{ name: '马', emoji: '🐴' }, { name: '羊', emoji: '🐑' }] } }
  ]);
  check(/2/.test(multi[0].amount), '多注记录显示 2 注（实际 "' + multi[0].amount + '"）');
  check(multi[0].desc.indexOf('🐴') !== -1, '多注记录描述含生肖');

  // 购物记录：金额与平台
  const shop = rec._mapTrashList([
    { id: 't3', type: 'shopping', deletedAt: Date.now(),
      data: { title: '耳机', price: 199.5, link: 'https://item.jd.com/1.html' } }
  ]);
  check(shop[0].amount === '¥199.50', '购物金额两位小数（实际 ' + shop[0].amount + '）');
  check(shop[0].title.indexOf('京东') !== -1, '按链接识别出京东');

  // 订单
  const ord = rec._mapTrashList([
    { id: 't4', type: 'order', deletedAt: Date.now(),
      data: { items: [{ name: '炒饭', count: 2 }], total: 28 } }
  ]);
  check(ord[0].desc.indexOf('炒饭×2') !== -1, '订单描述含数量（' + ord[0].desc + '）');
  check(ord[0].amount === '¥28.00', '订单金额格式化');
}

/* ================= 4. 餐厅组件 ================= */
console.log('\n[4] 餐厅组件：购物车与菜单编辑');
{
  const def = loadDef('components/restaurant/restaurant.js');
  const r = instantiate(def, true);
  r.data.menu = [{ cat: '招牌', items: [{ id: 'd1', name: '炒饭', price: 18 }] }];
  r.data.cart = {};
  r.data.cartList = [];
  r.data.cartCount = 0;
  r.data.cartTotal = '0.00';
  r.data.activeCat = 0;

  // 加两次同一道菜 → 数量 2、金额 36
  const dish = { id: 'd1', name: '炒饭', price: 18 };
  r.addToCart({ currentTarget: { dataset: { item: dish } } });
  r.addToCart({ currentTarget: { dataset: { item: dish } } });
  check(r.data.cartCount === 2, '加两次数量为 2（实际 ' + r.data.cartCount + '）');
  check(r.data.cartTotal === '36.00', '合计 36.00（实际 ' + r.data.cartTotal + '）');

  // 减一次 → 数量 1（WXML 传的是整条菜品对象）
  r.minusFromCart({ currentTarget: { dataset: { item: dish } } });
  check(r.data.cartCount === 1 && r.data.cartTotal === '18.00', '减一次后回退到 1 份 18.00');

  // 再减一次 → 自动移出购物车（组件没有单独的删除按钮，减到 0 即移除）
  r.minusFromCart({ currentTarget: { dataset: { item: dish } } });
  check(r.data.cartCount === 0 && Object.keys(r.data.cart).length === 0, '减到 0 后自动移出购物车');
  // 对不存在的菜减一不能崩
  let crashed = false;
  try { r.minusFromCart({ currentTarget: { dataset: { item: dish } } }); } catch (e) { crashed = true; }
  check(!crashed, '对不在购物车里的菜点减号不报错');

  // 非法价格不能保存菜品
  r.data.showMenuEditor = true;
  r.data.editCat = 0;
  r.data.menu = [{ cat: '招牌', items: [] }];
  r.data.form = { name: '测试菜', price: 'abc', taste: '', desc: '', emoji: '', img: '' };
  return (async () => {
    await r.saveDish();
    const saved = r.data.menu[0].items.filter((x) => x.name === '测试菜');
    check(saved.length === 0, '非法价格不会写入菜单');

    // 合法价格可保存
    r.data.form = { name: '测试菜', price: '12.5', taste: '咸', desc: '', emoji: '', img: '' };
    await r.saveDish();
    const okDish = r.data.menu[0].items.filter((x) => x.name === '测试菜');
    check(okDish.length === 1 && okDish[0].price === 12.5, '合法价格正常保存（price=' + (okDish[0] && okDish[0].price) + '）');

    // 删除最后一个分类时 activeCat 必须夹紧，否则菜品列表渲染成空白
    r.data.menu = [{ cat: 'A', items: [] }, { cat: 'B', items: [] }];
    r.data.activeCat = 1;
    r.deleteCat({ currentTarget: { dataset: { idx: 1 } } });
    check(r.data.menu.length === 1, '删除分类后菜单剩 1 个');
    check(r.data.activeCat === 0, 'activeCat 被夹紧到 0（实际 ' + r.data.activeCat + '）');
    check(!!r.data.menu[r.data.activeCat], 'activeCat 指向的分类存在（不会渲染空白）');

    /* ===== [5] 屏幕尺寸变化：三款游戏都要重算并重建画布 ===== */
    console.log('\n[5] 横竖屏切换：画布重算与重建');
    {
      const cases = [
        ['象棋', 'subpackages/games/xiangqi/xiangqi.js'],
        ['五子棋(人机)', 'subpackages/games/gomokuai/gomokuai.js'],
        ['五子棋(联机)', 'subpackages/games/gomoku/gomoku.js']
      ];
      const realInfo = global.wx.getWindowInfo;
      let width = 375;
      global.wx.getWindowInfo = function () { return { windowWidth: width, windowHeight: 700, pixelRatio: 2 }; };
      global.wx.getSystemInfoSync = global.wx.getWindowInfo;

      for (const c of cases) {
        const def = loadDef(c[1]);
        const p = instantiate(def, false);
        p._ensureCanvas = function () { p._rebuilt = true; };
        p._resetCanvas = function () {};
        p.data.stage = 'playing';
        if (typeof p.onResize !== 'function') {
          check(false, c[0] + ' 实现了 onResize（旋转屏幕不拉伸）');
          continue;
        }
        width = 375; p.onResize();
        const small = p.data.boardW;
        width = 812; p.onResize();
        const large = p.data.boardW;
        check(large > small && p._rebuilt,
          c[0] + ' 会随屏幕宽度重算棋盘并重建画布（' + small + '→' + large + 'px）');
      }
      global.wx.getWindowInfo = realInfo;
    }

    /* ===== [6] 日历买码面板：录入 → 结算 → 落盘 → 重开还原 ===== */
    console.log('\n[6] 日历买码面板端到端');
    {
      const { buildMapping } = require('../utils/zodiac.js');
      const def2 = loadDef('pages/calendar/calendar.js');
      const cal2 = instantiate(def2, false);
      const DS = '2026-10-05';
      cal2.data.calY = 2026;
      cal2.data.mapping = buildMapping(2026);
      cal2._memoCal = {};
      cal2._buyCal = {};
      cal2.data.sheetDate = DS;
      cal2.data.cloudReady = true;   // 云端未就绪时页面是只读态，不会落盘（设计如此）
      cal2.initBuyPanel(DS);

      // 选第 1 个区域的生肖：picker 索引 6 → 马（索引从 0 开始，代码里 +1）
      cal2.onKaiZodiac({ currentTarget: { dataset: { ri: '0' } }, detail: { value: '6' } });
      check(cal2.data.kZIdx[0] === 7, '选中生肖后 kZIdx 正确（' + cal2.data.kZIdx[0] + '）');
      check(Array.isArray(cal2.data.kNums[0]) && cal2.data.kNums[0].length > 1,
        '号码下拉被填充（' + cal2.data.kNums[0].length + ' 项）');
      // 选号码
      cal2.onKaiNum({ currentTarget: { dataset: { ri: '0' } }, detail: { value: '1' } });
      const kai0 = cal2.data.kaiValues[0];
      check(!!kai0 && !!kai0.name && kai0.number !== undefined,
        '开奖号码算出（' + (kai0 && kai0.name) + ' ' + (kai0 && kai0.number) + '）');

      // 下注：选同一生肖同号码，金额 20
      cal2.onPickZodiac({ currentTarget: { dataset: { ri: '0' } }, detail: { value: '6' } });
      cal2.onPickNum({ currentTarget: { dataset: { ri: '0' } }, detail: { value: '1' } });
      cal2.onPickAmount({ currentTarget: { dataset: { ri: '0' } }, detail: { value: '20' } });
      cal2.addBuy({ currentTarget: { dataset: { ri: '0' } } });
      check(cal2.data.buyItems[0].length === 1, '加注成功（1 条）');
      check(cal2.data.buyItems[0][0].amount === '20', '金额被带入（' + cal2.data.buyItems[0][0].amount + '）');
      check(cal2.data.pick[0].z === 0, '加注后输入区被重置');
      // 命中 → 中奖 20×47
      check(cal2.data.total === '20.00' && cal2.data.winStr === '940.00',
        '结算：投入 20 / 中奖 940（实际 ' + cal2.data.total + ' / ' + cal2.data.winStr + '）');

      // 重复加同一注不会产生第二条
      cal2.addBuy({ currentTarget: { dataset: { ri: '0' } } });
      check(cal2.data.buyItems[0].length === 1, '同号码重复加注被去重');

      // 改金额
      cal2.onBuyAmount({ currentTarget: { dataset: { ri: '0', idx: '0' } }, detail: { value: 'abc35.5x' } });
      check(cal2.data.buyItems[0][0].amount === '35.5', '金额清洗只留数字和小数点（' + cal2.data.buyItems[0][0].amount + '）');
      check(cal2.data.total === '35.50', '改金额后总额更新（' + cal2.data.total + '）');

      // 额外金额
      cal2.onExtraAmount({ detail: { value: '10' } });
      check(cal2.data.extraAmount === '10' && cal2.data.middle === (940 * 35.5 / 20 + 10).toFixed(2),
        '额外金额计入合计');

      // 落盘 + 重开面板还原
      cal2._persistBuyNow();
      const saved = cal2._buyCal[DS];
      check(!!saved && !!saved.mai && !!saved.mai.laoAo && saved.mai.laoAo.length === 1,
        '买码记录写入内存（含 mai.laoAo）');
      check(saved.extra === 10, '额外金额一并保存（' + saved.extra + '）');

      cal2.data.buyItems = [[], [], []];
      cal2.data.buySelected = [{}, {}, {}];
      cal2.initBuyPanel(DS);
      check(cal2.data.buyItems[0].length === 1 && cal2.data.buyItems[0][0].amount === '35.5',
        '重新打开面板后注单被还原（金额 ' + (cal2.data.buyItems[0][0] || {}).amount + '）');
      check(!!(cal2.data.kaiValues[0] || {}).name, '开奖号码一并还原');
      check(cal2.data.extraAmount === '10', '额外金额一并还原');

      // 删除注单
      cal2.deleteBuyItem({ currentTarget: { dataset: { ri: '0', idx: '0' } } });
      check(cal2.data.buyItems[0].length === 0, '删除注单生效');
      check(cal2.data.total === '0.00', '删除后投入归零（' + cal2.data.total + '）');
      check(Object.keys(cal2.data.buySelected[0]).length === 0, '删除后选中态同步清理');

      // 清空某区域
      cal2.clearMai({ currentTarget: { dataset: { ri: '1' } } });
      check(cal2.data.buyItems[1].length === 0, '清空区域不报错');
      // 清空开奖
      cal2.clearKai({ currentTarget: { dataset: { ri: '0' } } });
      check(cal2.data.kZIdx[0] === 0 && !(cal2.data.kaiValues[0] || {}).name, '清空开奖号码生效');
      if (cal2._buySaveTimer) { clearTimeout(cal2._buySaveTimer); cal2._buySaveTimer = null; }
    }

    /* ===== [7] 餐厅：编辑/删除菜品 ===== */
    console.log('\n[7] 餐厅：编辑与删除菜品');
    {
      const def3 = loadDef('components/restaurant/restaurant.js');
      const rc = instantiate(def3, true);
      rc.data.menu = [{ cat: '招牌', items: [{ id: 'd1', name: '炒饭', price: 18, emoji: '🍚' }] }];
      rc.data.editCat = 0;
      rc.data.activeCat = 0;
      rc.data.showMenuEditor = true;

      // 编辑现有菜品：改名改价，不能新增一条
      rc.editDish({ currentTarget: { dataset: { item: rc.data.menu[0].items[0] } } });
      check(rc.data.editingDish && rc.data.editingDish.id === 'd1', '点菜品进入编辑态');
      check(rc.data.form.name === '炒饭' && rc.data.form.price === '18', '表单回填原值');
      rc.data.form = Object.assign({}, rc.data.form, { name: '蛋炒饭', price: '22' });
      await rc.saveDish();
      const items = rc.data.menu[0].items;
      check(items.length === 1, '编辑后没有新增重复菜品（' + items.length + ' 条）');
      check(items[0].name === '蛋炒饭' && items[0].price === 22,
        '改名改价生效（' + items[0].name + ' / ' + items[0].price + '）');
      check(items[0].id === 'd1', '保持原 id（不会被当成新菜）');
      check(rc.data.showMenuEditor === false, '保存后关闭编辑面板');

      // 空名字拒绝
      rc.data.showMenuEditor = true;
      rc.data.editingDish = null;
      rc.data.form = { name: '   ', price: '10', taste: '', desc: '', emoji: '', img: '' };
      const before = rc.data.menu[0].items.length;
      await rc.saveDish();
      check(rc.data.menu[0].items.length === before, '空名字不会新增菜品');

      // 删除菜品（modal 回调异步，等一拍）
      rc.data.showMenuEditor = true;
      rc.data.editingDish = rc.data.menu[0].items[0];
      await rc.deleteDish();
      await new Promise((r) => setTimeout(r, 20));
      check(rc.data.menu[0].items.length === 0, '删除后菜品移除（' + rc.data.menu[0].items.length + '）');
      check(rc.data.editingDish === null, '删除后清空编辑态');

      // 编辑中切了分类导致目标不存在 → 明确取消而不是静默丢输入
      rc.data.menu = [{ cat: 'A', items: [{ id: 'a1', name: '菜A', price: 5 }] }, { cat: 'B', items: [] }];
      rc.data.editCat = 1;                 // 面板停在 B
      rc.data.editingDish = { id: 'a1', name: '菜A', price: 5 };
      rc.data.form = { name: '菜A改', price: '6', taste: '', desc: '', emoji: '', img: '' };
      await rc.saveDish();
      check(rc.data.menu[0].items[0].name === '菜A', '错分类保存被拒绝（原菜不变）');
    }

    /* ===== [8] 日历：输入后立刻切日期，内容不能丢 ===== */
    console.log('\n[8] 日历：防抖输入在切换日期/翻月/退页时必须落盘');
    {
      const { buildMapping } = require('../utils/zodiac.js');
      const def4 = loadDef('pages/calendar/calendar.js');
      const cal = instantiate(def4, false);
      cal.data.cloudReady = true;
      cal.data.calY = 2026;
      cal.data.calM = 9;
      cal.data.mapping = buildMapping(2026);
      cal._memoCal = {};
      cal._buyCal = {};
      cal.renderCalendar();

      // 备忘：输入后马上切到另一天
      cal.openDate({ currentTarget: { dataset: { ds: '2026-10-01' } } });
      cal.toggleMemoEdit();
      cal.onMemoInput({ detail: { value: '写到一半就跑' } });
      cal.openDate({ currentTarget: { dataset: { ds: '2026-10-02' } } });
      check(cal._memoCal['2026-10-01'] && cal._memoCal['2026-10-01'].memo === '写到一半就跑',
        '切日期前把备忘落盘（不丢字）');

      // 备忘：输入后马上翻月
      cal.toggleMemoEdit();
      cal.onMemoInput({ detail: { value: '翻月前的输入' } });
      cal.nextM();
      check(cal._memoCal['2026-10-02'] && cal._memoCal['2026-10-02'].memo === '翻月前的输入',
        '翻月前把备忘落盘');

      // 备忘：输入后直接退页
      cal.openDate({ currentTarget: { dataset: { ds: '2026-10-03' } } });
      cal.toggleMemoEdit();
      cal.onMemoInput({ detail: { value: '退页前的输入' } });
      cal.onUnload();
      check(cal._memoCal['2026-10-03'] && cal._memoCal['2026-10-03'].memo === '退页前的输入',
        '退页前把备忘落盘');

      // 买码：输入后马上切日期
      const cal2 = instantiate(loadDef('pages/calendar/calendar.js'), false);
      cal2.data.cloudReady = true;
      cal2.data.calY = 2026;
      cal2.data.mapping = buildMapping(2026);
      cal2._memoCal = {};
      cal2._buyCal = {};
      cal2.data.mode = 'buy';
      cal2.openDate({ currentTarget: { dataset: { ds: '2026-10-05' } } });
      cal2.data.extraAmount = '88';
      cal2.persistBuy();                       // 排入 400ms 防抖
      cal2.openDate({ currentTarget: { dataset: { ds: '2026-10-06' } } });
      const savedBuy = cal2._buyCal['2026-10-05'];
      check(!!savedBuy && savedBuy.extra === 88,
        '切日期前把买码记录落盘（extra=' + (savedBuy && savedBuy.extra) + '）');

      // cancelEdit 语义相反：取消要丢弃挂起输入并回滚
      const cal3 = instantiate(loadDef('pages/calendar/calendar.js'), false);
      cal3.data.cloudReady = true;
      cal3.data.mapping = buildMapping(2026);
      cal3._memoCal = { '2026-10-07': { memo: '原来的备忘' } };
      cal3._buyCal = {};
      cal3.openDate({ currentTarget: { dataset: { ds: '2026-10-07' } } });
      cal3.toggleMemoEdit();
      cal3.onMemoInput({ detail: { value: '改了但要取消' } });
      cal3.cancelEdit();
      check(cal3._memoCal['2026-10-07'].memo === '原来的备忘', '点取消回滚到原文');
      check(cal3.data.memoText === '原来的备忘', '取消后输入框恢复原文');

      if (cal._memoSaveTimer) clearTimeout(cal._memoSaveTimer);
      if (cal2._buySaveTimer) clearTimeout(cal2._buySaveTimer);
      if (cal3._memoSaveTimer) clearTimeout(cal3._memoSaveTimer);
    }

    /* ===== [9] 刮刮卡：刮开比例判定 ===== */
    console.log('\n[9] 刮刮卡：刮开比例与翻开判定');
    {
      const C = require('../utils/constants.js');      const def5 = loadDef('pages/index/index.js');
      const idx = instantiate(def5, false);
      idx.data.scratchCards = [
        { id: 'c0', revealed: false, coated: true, result: { number: 1 } },
        { id: 'c1', revealed: false, coated: true, result: { number: 2 } }
      ];
      idx._scratch = [null, null];

      // 假 canvas：按「请求区域」生成数据——该区域内前 clearRatio 的像素 alpha=0
      const W = 200, H = 220;
      function fakeStroke(clearRatio) {
        return {
          canvas: { width: W, height: H },
          ctx: {
            getImageData: function (x, y, rw, rh) {
              const n = rw * rh;
              const cleared = Math.floor(n * clearRatio);
              const out = new Uint8ClampedArray(n * 4);
              for (let i = 0; i < n; i++) {
                out[i * 4] = 200; out[i * 4 + 1] = 150; out[i * 4 + 2] = 180;
                out[i * 4 + 3] = i < cleared ? 0 : 255;
              }
              return { data: out };
            }
          },
          w: W, h: H, lastX: null, lastY: null
        };
      }

      // 刮开 20%：不该翻开
      idx._scratch[0] = fakeStroke(0.2);
      idx._checkReveal(0);
      check(idx.data.scratchCards[0].revealed === false, '刮开 20% 不翻开');

      // 刮开 50%（低于阈值 0.7）：不该翻开
      idx._scratch[0] = fakeStroke(0.5);
      idx._checkReveal(0);
      check(idx.data.scratchCards[0].revealed === false, '刮开 50% 仍不翻开（阈值 70%）');

      // 刮开 95%：翻开，并释放 canvas 引用
      idx._scratch[0] = fakeStroke(0.95);
      idx._checkReveal(0);
      check(idx.data.scratchCards[0].revealed === true, '刮开 95% 自动翻开');
      check(idx._scratch[0] === null, '翻开后释放 canvas 引用');

      // 未刮开的卡保持覆盖层
      check(idx.data.scratchCards[1].revealed === false, '其他卡不受影响');

      // 全部翻开后才写一条记录（这里用假 push：直接检查 flush 的幂等标记）
      idx._lastScratchRecordId = 'rec1';
      idx.flushScratchRecord();
      check(idx._lastScratchRecordId === 'rec1', '已有记录时 flush 不重复写入');
    }

    /* ===== [10] 餐厅：云端菜单结构异常时不能崩 ===== */
    console.log('\n[10] 餐厅：云端菜单缺 items 时仍可保存菜品');
    {
      const cs = require('../utils/cloudstore.js');
      const originLoad = cs.loadMenu;
      const originSave = cs.saveMenu;
      // 旧版本/手工改过的菜单：分类存在但 items 缺失或不是数组
      cs.loadMenu = async function () {
        return [{ cat: '招牌' }, { cat: '主食', items: null }, { cat: '混合', items: [{}, { name: '有名字', price: 5 }] }];
      };
      cs.saveMenu = async function () {};
      const def6 = loadDef('components/restaurant/restaurant.js');
      const rc2 = instantiate(def6, true);
      rc2.data.editCat = 0;
      rc2.data.activeCat = 0;
      rc2.data.showMenuEditor = true;
      await rc2._loadMenu();
      check(rc2.data.menu.length === 3, '异常菜单仍能加载出 3 个分类');
      check(Array.isArray(rc2.data.menu[0].items), '缺 items 的分类被补成空数组');
      check(rc2.data.menu[2].items.length === 1, '无效条目被过滤（只留有名字的）');

      rc2.data.form = { name: '新菜', price: '12', taste: '', desc: '', emoji: '', img: '' };
      let threw = false;
      try { await rc2.saveDish(); } catch (e) { threw = true; }
      check(!threw, '在缺 items 的分类下保存菜品不抛错');
      check(rc2.data.menu[0].items.length === 1, '菜品被正常加入');

      cs.loadMenu = originLoad;
      cs.saveMenu = originSave;
    }

    console.log('\n========================================');
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    if (fail > 0) {
      console.log('❌ 主包页面逻辑测试未通过');
      process.exit(1);
    }
    console.log('✓ 主包页面逻辑测试全部通过');
  })();
}
