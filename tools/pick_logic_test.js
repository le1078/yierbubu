// 六合取码组件逻辑测试：不依赖开发者工具，直接 mock wx / Component / 定时器跑组件方法。
// 覆盖：号码池映射、摇号特效时序、固定 6+1 七个位置、1~6 与 6+1 的取码数量、
//       同组去重、特别号不撞正码、记录上限与单条删除/一键清空、复制文本、本地存储恢复。
//
// 用法：node tools/pick_logic_test.js

const path = require('path');

let pass = 0, fail = 0;
function check(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); }
}

/* ---------- mock 小程序运行时 ---------- */
const storage = {};
let clipboard = null;
let toasts = [];
let modalQueue = [];
global.wx = {
  getStorageSync(k) { return storage[k] === undefined ? '' : JSON.parse(JSON.stringify(storage[k])); },
  setStorageSync(k, v) { storage[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync(k) { delete storage[k]; },
  showToast(o) { toasts.push(o.title); },
  setClipboardData(o) { clipboard = o.data; },
  showModal(o) { modalQueue.push(o); }
};

/* 定时器：不真的等待，由测试手动推进 */
let intervals = [];
global.setInterval = (fn, ms) => { const t = { fn: fn, ms: ms, cleared: false }; intervals.push(t); return t; };
global.clearInterval = (t) => { if (t) t.cleared = true; };

let comp = null;
global.Component = (opts) => { comp = opts; };
require(path.join(__dirname, '..', 'components', 'pick', 'pick.js'));

const ref = require(path.join(__dirname, '..', 'utils', 'zodiac.js'));
const C = require(path.join(__dirname, '..', 'utils', 'constants.js'));
const YEAR = new Date().getFullYear();
const YEAR_IDX = ((YEAR - 2020) % 12 + 12) % 12;

function makeInst() {
  const inst = {
    data: JSON.parse(JSON.stringify(comp.data)),
    setData(patch) { Object.assign(this.data, patch); }
  };
  Object.keys(comp.methods).forEach((k) => { inst[k] = comp.methods[k].bind(inst); });
  return inst;
}

function tap(inst, method, dataset) {
  return inst[method]({ currentTarget: { dataset: dataset || {} } });
}

function roll(inst, ticks) {
  const t = intervals[intervals.length - 1];
  for (let i = 0; i < ticks; i++) {
    if (!t || t.cleared) break;
    t.fn();
  }
}

function gen(inst) {
  inst.onGenerate();
  roll(inst, C.SHAKE_TICKS);
}

function filledNums(inst) {
  return inst.data.slots.filter((s) => s.filled).map((s) => Number(s.num));
}

console.log('\n[1] 号码池映射（与 utils/zodiac.js 一致）');
check(ref.getZodiacByNumber(YEAR, 10).name === '鸡', '10 → 鸡');
check(ref.getZodiacByNumber(YEAR, 7).name === '鼠', '07 → 鼠');
check(ref.getZodiacByNumber(YEAR, 45).name === '狗', '45 → 狗');
check(ref.getZodiacByNumber(YEAR, 49).name === ref.ZODIAC[YEAR_IDX].name,
  '49 → 当年生肖（' + ref.ZODIAC[YEAR_IDX].name + '）');

console.log('\n[2] 初始状态：固定 6+1 七个位置');
const inst = makeInst();
comp.lifetimes.attached.call(inst);
check(inst.data.options.length === 7, '共 7 个数量选项');
check(inst.data.optIdx === 6, '默认选中 6+1');
check(inst.data.slots.length === 6, '正码位固定 6 个');
check(inst.data.slots.every((s) => !s.filled), '初始 6 个都是空白位');
check(!!inst.data.special && inst.data.special.filled === false, '特别号位也一直存在（空白）');
check(inst.data.slots.length + 1 === 7, '合计 7 个位置（6 正码 + 1 特别）');
check(inst.data.rolling === false, '初始不在摇号中');

console.log('\n[3] 摇号特效时序（与「摇一摇」一致：60ms × 10 次）');
inst.onGenerate();
const timer = intervals[intervals.length - 1];
check(inst.data.rolling === true, '点击后进入摇号中');
check(timer.ms === C.SHAKE_INTERVAL, '滚动间隔 ' + C.SHAKE_INTERVAL + 'ms');
roll(inst, 1);
check(inst.data.slots.filter((s) => s.filled).length > 0, '滚动过程中已经在换号码');
check(inst.data.rolling === true, '滚动中还没有定稿');
roll(inst, C.SHAKE_TICKS - 1);
check(inst.data.rolling === false, '跑满 ' + C.SHAKE_TICKS + ' 次后定稿');
check(timer.cleared === true, '定时器已清理，不会继续跑');

console.log('\n[4] 6+1 结果');
let nums = filledNums(inst);
check(nums.length === 6, '6 个正码', nums);
check(inst.data.special.filled === true, '特别号已填');
check(new Set(nums).size === 6, '正码互不重复', nums);
check(nums.indexOf(Number(inst.data.special.num)) === -1, '特别号不与正码重复');
check(nums.concat([Number(inst.data.special.num)]).every((n) => n >= 1 && n <= 49), '号码都在 1–49');
check(inst.data.special.special === true, '特别号带标记');
check(inst.data.slots.every((s) => s.special === false), '正码不带特别标记');
check(inst.data.slots.every((s) => {
  const z = ref.getZodiacByNumber(YEAR, Number(s.num));
  return s.name === z.name && s.emoji === z.emoji && s.color === z.color;
}), '每个号码的生肖/表情/颜色都正确');

console.log('\n[5] 选 5 个：第 6 位和特别号位留空白');
tap(inst, 'setOpt', { i: '4' });
gen(inst);
check(inst.data.slots.length === 6, '仍然渲染 6 个正码位');
check(inst.data.slots.filter((s) => s.filled).length === 5, '只填 5 个');
check(inst.data.slots[5].filled === false && inst.data.slots[5].num === '—', '第 6 位是空白（—）');
check(inst.data.special.filled === false && inst.data.special.num === '—', '特别号位空白');

console.log('\n[6] 1~6 的取码数量');
for (let i = 0; i <= 5; i++) {
  tap(inst, 'setOpt', { i: String(i) });
  gen(inst);
  check(inst.data.slots.filter((s) => s.filled).length === i + 1,
    '选 ' + (i + 1) + ' 个 → 填 ' + inst.data.slots.filter((s) => s.filled).length + ' 个');
  check(inst.data.special.filled === false, '选 ' + (i + 1) + ' 个时特别号位为空');
}

console.log('\n[7] 随机质量（200 次 6+1）');
tap(inst, 'setOpt', { i: '6' });
const seen = {};
let dupInSet = 0, specialClash = 0, outOfRange = 0;
for (let i = 0; i < 200; i++) {
  const out = inst._draw({ count: 6, special: true });
  const ns = out.items.map((x) => Number(x.num));
  const sp = Number(out.special.num);
  if (new Set(ns).size !== 6) dupInSet++;
  if (ns.indexOf(sp) !== -1) specialClash++;
  ns.concat([sp]).forEach((n) => {
    if (n < 1 || n > 49) outOfRange++;
    seen[n] = (seen[n] || 0) + 1;
  });
}
check(dupInSet === 0, '200 次里没有一次正码重复');
check(specialClash === 0, '200 次里特别号从未撞正码');
check(outOfRange === 0, '200 次里没有越界号码');
check(Object.keys(seen).length >= 45, '200 次覆盖到 ' + Object.keys(seen).length + ' 个号码（应≥45）');

console.log('\n[8] 记录上限 12 条');
for (let i = 0; i < 20; i++) gen(inst);
check(inst.data.history.length === 12, '历史上限 12 条（实际 ' + inst.data.history.length + '）');
check(inst.data.history[0].chips[0].num === inst.data.slots[0].num, '最新一条排在最前');

console.log('\n[9] 复制文本');
inst.onCopy();
const parts = String(clipboard || '').split(' ');
check(parts.length === 7, '复制 6 个正码 + 1 个特别号', clipboard);
check(/^\+\d{2}$/.test(parts[6]), '最后一个是 +特别号', parts[6]);

console.log('\n[10] 单条删除');
const beforeLen = inst.data.history.length;
const delKey = inst.data.history[1].key;
tap(inst, 'onDeleteEntry', { key: delKey });
check(inst.data.history.length === beforeLen - 1, '删除一条后少一条');
check(inst.data.history.every((h) => h.key !== delKey), '被删的那条不在了');
check(storage['yb_pick_v1'].history.length === inst.data.history.length, '删除后同步写回本地');

console.log('\n[11] 一键清空');
toasts = [];
tap(inst, 'onClearHistory');
check(modalQueue.length === 1, '弹出确认框');
modalQueue.shift().success({ confirm: false });
check(inst.data.history.length > 0, '点取消不会删除');
tap(inst, 'onClearHistory');
modalQueue.shift().success({ confirm: true });
check(inst.data.history.length === 0, '确认后清空');
check(storage['yb_pick_v1'].history.length === 0, '本地存储也清空');

console.log('\n[12] 本地存储恢复');
gen(inst);
const inst2 = makeInst();
comp.lifetimes.attached.call(inst2);
check(inst2.data.optIdx === inst.data.optIdx, '恢复上次选中的数量选项');
check(inst2.data.history.length === 1, '恢复历史记录');
check(inst2.data.slots.filter((s) => s.filled).length === 6, '恢复上次结果');
check(inst2.data.speech.indexOf('上次') !== -1, '恢复后提示是「上次摇到的」');

console.log('\n[13] 摇号中禁止重复点/复制');
inst2.onGenerate();
inst2.onGenerate();
const live = intervals[intervals.length - 1];
check(live.cleared === false, '摇号中重复点击不会新起定时器');
toasts = [];
inst2.onCopy();
check(toasts.indexOf('正在摇，稍等一下') !== -1, '摇号中复制被拦住');
roll(inst2, C.SHAKE_TICKS);
check(inst2.data.rolling === false, '摇号结束回到正常态');

console.log('\n[14] 切走栏目 / 进后台：摇号立刻停，不偷偷摇完');
{
  const a = makeInst();
  comp.lifetimes.attached.call(a);
  const histBefore = a.data.history.length;
  a.onGenerate();
  check(a.data.rolling === true, '摇号中');
  // 模拟切到别的栏目（active observer）与整个小程序进后台（pageLifetimes.hide）
  comp.properties.active.observer.call(a, false);
  const t = intervals[intervals.length - 1];
  check(t.cleared === true, '定时器被清掉');
  check(a.data.rolling === false, '「正在摇」状态复位');
  const histAfterSwitch = a.data.history.length;
  roll(a, C.SHAKE_TICKS);
  check(a.data.history.length === histAfterSwitch, '切走后摇号不会继续跑完写记录');
  check(a.data.speech.indexOf('打断') !== -1, '提示被打断，可以再摇');

  a.onGenerate();
  comp.pageLifetimes.hide.call(a);
  check(intervals[intervals.length - 1].cleared === true, '进后台同样停摇');
  check(a.data.rolling === false, '进后台后状态复位');
  check(a.data.history.length === histAfterSwitch, '进后台不产生新记录');
}

console.log('\n[15] 损坏存档兜底：optIdx=2.5 / history 里混脏数据');
{
  storage.yb_pick_v1 = {
    optIdx: 2.5,
    history: [
      null,
      { key: 'k1', time: '12:00', chips: [{ num: '07', name: '鼠', emoji: '🐭', color: '#000' }], special: null },
      { key: 'k2', time: '12:01', chips: 'not-an-array', special: null },
      { key: 'k3', time: '12:02', chips: [], special: null }
    ]
  };
  const a = makeInst();
  let threw = false;
  try { comp.lifetimes.attached.call(a); } catch (e) { threw = true; }
  check(threw === false, 'attached 不抛异常');
  check(a.data.optIdx === 6, '非法 optIdx（2.5）回退默认 6');
  check(a.data.history.length === 1 && a.data.history[0].key === 'k1', '脏记录被过滤，只留干净的');
  check(a.data.slots.filter((s) => s.filled).length === 1, '只恢复干净条目的号码');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail === 0) console.log('✓ 六合取码组件逻辑测试全部通过');
else process.exit(1);
