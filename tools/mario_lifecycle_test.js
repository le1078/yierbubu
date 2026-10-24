// 马里奥页面生命周期回归：静音偏好跨局记忆 + 终局后停止 4Hz 输入轮询。
//
// 这两个都是「看不见的 bug」：
//   1) 静音开关只存在音频模块（分包单例）里，页面 data 每次新建都是 false。
//      本局静音后退出再进 → 按钮显示🔊但没声音，点一下反而更静音。
//   2) host 的 guest 输入轮询没有终局判断：结算画面挂 1 小时 = 白读 14400 次云库。
//
// 用法：node tools/mario_lifecycle_test.js

const path = require('path');

let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

const store = {};
let inputGets = 0;

global.wx = {
  getStorageSync: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : ''; },
  setStorageSync: function (k, v) { store[k] = v; },
  showToast: function () {},
  showLoading: function () {},
  hideLoading: function () {},
  showModal: function (o) { if (o && o.success) o.success({ confirm: false }); },
  cloud: {
    database: function () {
      return {
        command: {},
        serverDate: function () { return new Date(); },
        collection: function () {
          return {
            add: function () { return Promise.resolve({ _id: 'r1' }); },
            where: function () {
              return { limit: function () { return this; }, get: function () { return Promise.resolve({ data: [] }); } };
            },
            doc: function (id) {
              return {
                update: function () { return Promise.resolve({}); },
                set: function () { return Promise.resolve({}); },
                get: function () {
                  if (String(id).slice(-6) === '_input') inputGets++;
                  return Promise.resolve({ data: {} });
                },
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

function loadPage() {
  let def = null;
  global.Page = function (d) { def = d; };
  delete require.cache[require.resolve(PAGE)];
  require(PAGE);
  const page = {};
  for (const k of Object.keys(def)) page[k] = def[k];
  page.data = JSON.parse(JSON.stringify(def.data || {}));
  page.setData = function (patch, cb) {
    if (patch) for (const k of Object.keys(patch)) this.data[k] = patch[k];
    if (typeof cb === 'function') cb();
  };
  // 只测生命周期，不碰画布/模拟
  page._ensureCanvas = function () {};
  page._render = function () {};
  page._syncHud = function () {};
  page._startLoop = function () {};
  page._setupLevel = function () {};
  page._resetCanvas = function () {};
  page.onLoad({});
  return page;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

(async function run() {
  const AU = require(path.join(__dirname, '..', 'subpackages/games/mario/audio.js'));

  console.log('[1] 静音偏好跨局记忆');
  {
    const p1 = loadPage();
    check(p1.data.muted === false, '首次进入默认不静音');
    p1.toggleMute();
    check(p1.data.muted === true, '点一下变静音');
    check(AU.isMuted() === true, '音频模块同步静音');
    check(store.mario_sfx_muted === true, '静音偏好写入了本地存储');

    // 退出再进：mario.js 重新加载，audio.js 仍是同一个模块（分包单例）
    const p2 = loadPage();
    check(p2.data.muted === true, '重新进入页面：按钮状态跟着偏好走（不再显示🔊却没声音）');
    check(AU.isMuted() === true, '重新进入后音频模块仍静音，UI 与声音一致');
    p2.toggleMute();
    check(p2.data.muted === false && AU.isMuted() === false, '再点一下恢复声音');
    check(store.mario_sfx_muted === false, '恢复声音也持久化');
  }

  console.log('\n[2] 终局后停止 guest 输入轮询，重开时恢复');
  {
    store.mario_sfx_muted = false;
    const p = loadPage();
    p._roomId = 'r1';
    p.data.mode = 'online';
    p.data.mySeat = 1;
    p.data.stage = 'playing';
    p.data.coop = false;

    inputGets = 0;
    p._startInputPoll();
    await sleep(620);
    const during = inputGets;
    check(during >= 2, '对局中 host 持续轮询 guest 输入（' + during + ' 次 / 620ms）');

    // 对方先到终点：本端进入 ended
    p._handleRoomWinner(2, false);
    check(p.data.stage === 'ended', '收到终局后进入结算画面');
    const atEnd = inputGets;
    await sleep(700);
    check(inputGets === atEnd, '结算画面不再继续读云库（' + atEnd + ' → ' + inputGets + '）');

    // host 点「重玩本关」：轮询必须重新挂上，否则之后 guest 的操作全丢
    p.restart();
    check(p.data.stage === 'playing', '重玩后回到对局');
    await sleep(620);
    check(inputGets > atEnd, '重开后轮询恢复（' + atEnd + ' → ' + inputGets + '）');

    p.onUnload();
    const afterUnload = inputGets;
    await sleep(500);
    check(inputGets === afterUnload, '退页后轮询彻底停止');
  }

  console.log('\n[3] 对方离开：立即停止轮询');
  {
    const p = loadPage();
    p._roomId = 'r2';
    p.data.mode = 'online';
    p.data.mySeat = 1;
    p.data.stage = 'playing';
    inputGets = 0;
    p._startInputPoll();
    await sleep(320);
    check(inputGets >= 1, '离开前在轮询');
    p._onRoomUpdate({ status: 'ended', leaver: 2 });
    const after = inputGets;
    await sleep(700);
    check(inputGets === after, '对方离开后停止轮询（' + after + ' → ' + inputGets + '）');
    p.onUnload();
  }

  console.log('\n[4] 中继在线时降低库读频率（guest 的输入文档 2s 才变一次）');
  {
    const p = loadPage();
    p._roomId = 'r3';
    p.data.mode = 'online';
    p.data.mySeat = 1;
    p.data.stage = 'playing';
    p._relay = { isReady: function () { return true; }, close: function () {}, bye: function () {} };
    p._peerOnRelay = true;
    inputGets = 0;
    p._startInputPoll();
    await sleep(700);
    check(inputGets <= 2, '中继正常：700ms 内云读 ≤2 次（实际 ' + inputGets + '）');
    p._peerOnRelay = false;   // 对端掉出中继 → 库写回到 400ms 节奏，本端也该加速
    await sleep(700);
    check(inputGets >= 3, '对端离开中继后恢复快速轮询（实际 ' + inputGets + ' 次）');
    p.onUnload();
  }

  console.log('\n[5] 退页关闭音频上下文（音效不会跟到大厅），再进按需重建');
  {
    let created = 0, closed = 0;
    global.wx.createWebAudioContext = function () {
      created++;
      const node = function () {
        return {
          frequency: { setValueAtTime: function () {}, exponentialRampToValueAtTime: function () {} },
          gain: { setValueAtTime: function () {}, exponentialRampToValueAtTime: function () {} },
          connect: function () {},
          disconnect: function () {},
          start: function () {},
          stop: function () {},
          type: 'square',
          onended: null
        };
      };
      return {
        currentTime: 0,
        destination: {},
        createOscillator: node,
        createGain: node,
        close: function () { closed++; }
      };
    };
    AU.setMuted(false);
    AU.play('coin');
    check(created === 1, '首次播放按需创建上下文');
    AU.dispose();
    check(closed === 1, 'dispose 关闭上下文（停掉已排程的音符）');
    AU.play('coin');
    check(created === 2, '关闭后再播放会重建上下文，不会永久哑掉');
    AU.dispose();
    check(closed === 2, '再次 dispose 正常');
  }

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('❌ 生命周期回归未通过'); process.exit(1); }
  console.log('✓ 生命周期回归全部通过');
  process.exit(0);
})();
