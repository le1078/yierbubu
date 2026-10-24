// 马里奥页面级长跑（10 分钟对局，虚拟时钟）：只测页面主循环本身，
// 不测物理（物理由 engine 模糊测试覆盖）。
//
// 目标：主循环跑了 36 万帧之后仍然
//   - 每帧只调度一个 tick（定时器不增殖）
//   - 世界快照按 150ms 稳定发出（同步调度器不漏拍、不空转）
//   - setData 不是每帧都调（HUD 变化才写，否则桥开销把 UI 拖死）
//   - 实体数组有界、玩家坐标不发散、时间正常推进
//
// 用法：node tools/mario_soak_test.js

const path = require('path');

let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

/* ===== 虚拟时钟（必须在 require 页面之前安装） ===== */
let now = 1762000000000;
const queue = [];
let timerSeq = 0;
const realSetTimeout = global.setTimeout;
global.setTimeout = function (fn, ms) {
  const t = { id: ++timerSeq, at: now + (ms || 0), fn, cancelled: false };
  queue.push(t);
  return t.id;
};
global.clearTimeout = function (id) {
  for (let i = 0; i < queue.length; i++) if (queue[i].id === id) queue[i].cancelled = true;
};
Date.now = function () { return now; };

/* ===== wx 桩 ===== */
let setDataCalls = 0;
let worldSent = 0;
global.wx = {
  showToast: function () {}, showLoading: function () {}, hideLoading: function () {},
  showModal: function () {}, vibrateShort: function () {},
  getStorageSync: function () { return ''; }, setStorageSync: function () {},
  cloud: {
    database: function () {
      return {
        command: {},
        serverDate: function () { return new Date(now); },
        collection: function () {
          return {
            add: function () { return Promise.resolve({ _id: 'r' }); },
            where: function () { return { limit: function () { return this; }, get: function () { return Promise.resolve({ data: [] }); } }; },
            doc: function () {
              return {
                update: function () { return Promise.resolve({}); },
                set: function () { return Promise.resolve({}); },
                get: function () { return Promise.resolve({ data: {} }); },
                watch: function () { return { close: function () {} }; }
              };
            }
          };
        }
      };
    }
  }
};

const PAGE = path.join(__dirname, '..', 'subpackages/games/mario/mario.js');
let def = null;
global.Page = function (d) { def = d; };
require(PAGE);
const page = {};
for (const k of Object.keys(def)) page[k] = def[k];
page.data = JSON.parse(JSON.stringify(def.data || {}));
page.setData = function (patch, cb) {
  setDataCalls++;
  if (patch) for (const k of Object.keys(patch)) this.data[k] = patch[k];
  if (typeof cb === 'function') cb();
};

// 不碰真实 canvas / 字体加载
page._ensureCanvas = function () {};
page._render = function () {};
page._bgCache = { canvas: null, w: 0, h: 0 };
page.setData({
  mode: 'online', mySeat: 1, coop: true, infiniteLives: true,
  canvasW: 350, canvasH: 210, stage: 'playing'
});
page._roomId = 'room-soak';
page._roomNo = page.data.roomNo = '1234';
page._scale = 350 / 15;
page._relay = {
  isReady: function () { return true; },
  send: function (v) { if (v && v.k === 'world') worldSent++; },
  rtt: function () { return 30; },
  close: function () {}, bye: function () {}
};
page._peerOnRelay = true;

page._setupLevel(0, false);
check(page.data.stage === 'playing', '关卡装载完成');
check(!!page._players && page._players.length === 2, '双人玩家就绪');

console.log('\n[1] 虚拟时钟驱动 10 分钟（36 万帧）');
const DURATION = 10 * 60 * 1000;
const endAt = now + DURATION;
const startLevelTime = page._level.time;
page._startLoop();
check(queue.filter(function (t) { return !t.cancelled; }).length === 1, '开局只有一条 tick 链');

let ticks = 0;
let maxQueue = 0;
let inlineError = null;
let fedInputAt = -1;
try {
  while (true) {
    let best = -1;
    for (let i = 0; i < queue.length; i++) {
      if (queue[i].cancelled) continue;
      if (best === -1 || queue[i].at < queue[best].at) best = i;
    }
    if (best === -1) break;
    const t = queue[best];
    if (t.at > endAt) break;
    queue.splice(best, 1);
    now = Math.max(now, t.at);
    t.fn();
    ticks++;
    if (queue.length > maxQueue) maxQueue = queue.length;

    // 模拟对方 10Hz 输入上报（中继车道），让「同步中断」判定不触发
    if (ticks - fedInputAt >= 6) {
      fedInputAt = ticks;
      page._onRelayData({ k: 'input', i: { keys: { l: 0, r: ticks % 12 < 6 ? 1 : 0, u: 0, d: 0, rn: 0 }, got: [] } });
    }
    // 本地玩家：2 秒向右、2 秒向左（不按跳），一直在起始区附近活动
    const phase = Math.floor(ticks / 120) % 2;
    page._inputs[1].right = phase === 0;
    page._inputs[1].left = phase === 1;
  }
} catch (e) {
  inlineError = e;
}

check(!inlineError, '10 分钟长跑无异常' + (inlineError ? '：' + inlineError.message : ''));
check(ticks > 30000, '主循环持续运转（' + ticks + ' 帧）');
check(maxQueue <= 3, '定时器不增殖（队列峰值 ' + maxQueue + '）');
check(page.data.stage === 'playing', '对局未意外结束');

console.log('\n[2] 时间/同步/渲染开销');
{
  const advanced = page._level.time - startLevelTime;
  check(advanced > 590 && advanced < 620, '模拟时间推进 ~600 秒（实际 ' + advanced.toFixed(1) + '）');
  check(page._level.timeLeft > 0 && page._level.timeLeft < 400, '倒计时在走（' + page._level.timeLeft + '）');
  const expectSync = DURATION / 150;
  check(worldSent > expectSync * 0.85 && worldSent < expectSync * 1.15,
    '世界快照按 150ms 稳定发出（' + worldSent + ' 次，期望 ~' + Math.round(expectSync) + '）');
  check(setDataCalls < ticks / 10,
    'setData 不是每帧调用（' + setDataCalls + ' 次 / ' + ticks + ' 帧）');
  check(page.data.syncText.indexOf('同步中断') === -1, '持续有对方数据时不误报同步中断');
}

console.log('\n[3] 实体数组与坐标有界');
{
  const lv = page._level;
  const p1 = page._players[0], p2 = page._players[1];
  const finite = function (n) { return typeof n === 'number' && isFinite(n); };
  check(finite(p1.x) && finite(p1.y) && finite(p2.x) && finite(p2.y), '玩家坐标有限');
  check(p1.x > 0 && p1.x < lv.cols && p2.x > 0 && p2.x < lv.cols, '玩家未跑出关卡（' + p1.x.toFixed(1) + ' / ' + p2.x.toFixed(1) + '）');
  check((lv.items || []).length < 200, '道具数组有界（' + (lv.items || []).length + '）');
  check((lv.popups || []).length <= 13, '飘字数组有界（' + (lv.popups || []).length + '）');
  check((lv.debris || []).length <= 60, '碎片数组有界（' + (lv.debris || []).length + '）');
  check((lv.fireballs || []).length < 200, '火球数组有界（' + (lv.fireballs || []).length + '）');
  check((lv.warpFx || []).length <= 20, '传送特效有界（' + (lv.warpFx || []).length + '）');
  check(Object.keys(page._bubbles || {}).length <= 2, '聊天气泡按座位有界');
}

console.log('\n[4] 停循环后不留尾巴');
{
  page._stopLoop();
  const alive = queue.filter(function (t) { return !t.cancelled; });
  check(alive.length === 0, '停止后没有待执行的定时器（剩 ' + alive.length + '）');
  page._destroyed = true;
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) { console.log('❌ 马里奥长跑测试未通过'); process.exit(1); }
console.log('✓ 马里奥长跑测试全部通过');

// 清掉虚拟时钟，避免影响同进程后续代码（本脚本独立进程，保险起见）
global.setTimeout = realSetTimeout;
