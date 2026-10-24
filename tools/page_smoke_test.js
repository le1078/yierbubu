// 全页面生命周期冒烟：把每个页面/组件实例化，按真实顺序跑
// onLoad/onShow/onHide/onResize/onReady/onUnload（组件 created/attached/detached），
// 外加分享回调。
//
// 目的：抓「某个生命周期里引用了不存在的字段/方法」「onUnload 漏清理导致
// 回调打到已卸载页面」这类只有进入页面才会炸的问题。这里不校验业务结果，
// 只要求：全程不抛异常、卸载后不再 setData、分享路径合法。
//
// 用法：node tools/page_smoke_test.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

/* ========== wx 桩 ========== */
const storage = {};
let pageAlive = true;
let lateSetData = 0;

function chainGet() { return Promise.resolve({ data: [] }); }
function makeQuery() {
  const q = {
    in: function () { return q; },
    select: function () { return q; },
    selectAll: function () { return q; },
    fields: function () { return q; },
    exec: function (cb) { if (cb) setTimeout(function () { cb([[]]); }, 0); }
  };
  return q;
}

const wxBase = {
  showToast: function () {}, showLoading: function () {}, hideLoading: function () {},
  showModal: function () {}, hideToast: function () {},
  getStorageSync: function (k) { return storage[k] === undefined ? '' : storage[k]; },
  setStorageSync: function (k, v) { storage[k] = v; },
  removeStorageSync: function (k) { delete storage[k]; },
  getWindowInfo: function () { return { windowWidth: 375, windowHeight: 667, pixelRatio: 2 }; },
  getSystemInfoSync: function () { return { windowWidth: 375, windowHeight: 667, pixelRatio: 2 }; },
  createSelectorQuery: makeQuery,
  createWebAudioContext: function () { return null; },   // 音频按不支持处理
  vibrateShort: function () {},
  setNavigationBarTitle: function () {},
  stopPullDownRefresh: function () {},
  getClipboardData: function (o) { if (o && o.success) o.success({ data: '' }); },
  setClipboardData: function () {},
  navigateTo: function () {}, navigateBack: function () {}, switchTab: function () {},
  reLaunch: function () {},
  cloud: {
    init: function () {},
    database: function () {
      return {
        command: {
          push: function (x) { return x; },
          lte: function (x) { return x; },
          gte: function (x) { return x; },
          inc: function (x) { return x; }
        },
        serverDate: function () { return new Date(); },
        collection: function () {
          return {
            add: function () { return Promise.resolve({ _id: 'x' }); },
            where: function () {
              return { limit: function () { return this; }, get: chainGet, orderBy: function () { return this; } };
            },
            doc: function () {
              return {
                get: function () { return Promise.resolve({ data: {} }); },
                set: function () { return Promise.resolve({}); },
                update: function () { return Promise.resolve({}); },
                remove: function () { return Promise.resolve({}); },
                watch: function () { return { close: function () {} }; }
              };
            }
          };
        }
      };
    }
  }
};

global.wx = new Proxy(wxBase, {
  get: function (t, k) {
    if (k in t) return t[k];
    return function () { return undefined; };
  }
});

/* ========== 页面实例化 ========== */
function loadDef(rel, isComponent) {
  const file = path.join(ROOT, rel + '.js');
  let captured = null;
  global.Page = function (d) { captured = d; };
  global.Component = function (d) { captured = d; };
  global.App = function () {};
  delete require.cache[require.resolve(file)];
  require(file);
  if (!captured) throw new Error(rel + ' 没有注册 Page/Component');
  return isComponent ? (captured.methods || {}) : captured;
}

function instantiate(def, isComponent) {
  const src = isComponent ? def : def;
  const inst = {};
  for (const k of Object.keys(src)) {
    if (typeof src[k] === 'function') inst[k] = src[k];
  }
  inst.data = JSON.parse(JSON.stringify(def.data || {}));
  if (isComponent) inst.properties = def.properties || {};
  inst.setData = function (patch, cb) {
    if (!pageAlive) lateSetData++;
    if (patch) {
      for (const k of Object.keys(patch)) {
        if (k.indexOf('.') === -1 && k.indexOf('[') === -1) this.data[k] = patch[k];
      }
    }
    if (typeof cb === 'function') cb();
  };
  inst.triggerEvent = function () {};
  inst.selectComponent = function () { return null; };
  inst.createSelectorQuery = makeQuery;
  return inst;
}

function call(obj, name, arg) {
  if (typeof obj[name] !== 'function') return { skipped: true };
  try {
    obj[name](arg);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e };
  }
}

function release(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

const PAGES = [
  'pages/index/index',
  'pages/calendar/calendar',
  'pages/records/records',
  'pages/games/games',
  'pages/life/life',
  'pages/restaurant/restaurant',
  'subpackages/games/gomoku/gomoku',
  'subpackages/games/gomokuai/gomokuai',
  'subpackages/games/xiangqi/xiangqi',
  'subpackages/games/mario/mario'
];
const COMPONENTS = [
  'components/restaurant/restaurant',
  'components/shengxiao/shengxiao'
];

(async function run() {
  console.log('[1] 页面生命周期');
  for (const rel of PAGES) {
    let err = null;
    let page = null;
    try {
      pageAlive = true;
      lateSetData = 0;
      const def = loadDef(rel, false);
      page = instantiate(def, false);
      const seq = [
        ['onLoad', {}],
        ['onReady', undefined],
        ['onShow', undefined],
        ['onResize', undefined],
        ['onHide', undefined],
        ['onShow', undefined],
        ['onUnload', undefined]
      ];
      for (const s of seq) {
        const r = call(page, s[0], s[1]);
        if (r.ok === false) { err = s[0] + ' 抛异常：' + r.err.message; break; }
        await release(40);   // 给 onLoad 里的异步加载留出执行窗口
      }
      // 卸载后再等一轮：异步回调若没有 _destroyed 守卫，会在这里 setData
      pageAlive = false;
      await release(150);
      if (err) throw new Error(err);
      if (lateSetData > 0) {
        throw new Error('卸载后仍有 ' + lateSetData + ' 次 setData 落到已销毁页面');
      }
      if (typeof page.onShareAppMessage === 'function') {
        const s = page.onShareAppMessage();
        if (!s || typeof s.path !== 'string' || s.path.charAt(0) !== '/') {
          throw new Error('分享路径不合法：' + JSON.stringify(s && s.path));
        }
      }
      check(true, rel + ' 生命周期无异常、卸载后无 setData');
    } catch (e) {
      check(false, rel + ' → ' + e.message);
    } finally {
      pageAlive = true;
    }
  }

  console.log('\n[2] 组件生命周期');
  for (const rel of COMPONENTS) {
    let err = null;
    try {
      pageAlive = true;
      lateSetData = 0;
      const def = loadDef(rel, true);
      const inst = instantiate(def, true);
      inst.attached && inst.attached.call(inst);
      inst.ready && inst.ready.call(inst);
      await release(40);
      inst.detached && inst.detached.call(inst);
      pageAlive = false;
      await release(150);
      if (lateSetData > 0) throw new Error('detached 后仍有 ' + lateSetData + ' 次 setData');
      check(true, rel + ' 组件生命周期无异常');
    } catch (e) {
      check(false, rel + ' → ' + e.message);
    } finally {
      pageAlive = true;
    }
  }

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) {
    console.log('❌ 页面生命周期冒烟未通过');
    process.exit(1);
  }
  console.log('✓ 页面生命周期冒烟全部通过');
  process.exit(0);
})();
