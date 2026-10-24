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

    console.log('\n========================================');
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    if (fail > 0) {
      console.log('❌ 主包页面逻辑测试未通过');
      process.exit(1);
    }
    console.log('✓ 主包页面逻辑测试全部通过');
  })();
}
