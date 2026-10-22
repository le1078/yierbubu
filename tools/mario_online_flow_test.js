// 马里奥联机页面级同步测试：输入中继 / 世界写读 / 模式。
// 这些是页面方法，engine 单测覆盖不到；之前「对方不动」就是 mode 没切回 online。
//
// 用法：node tools/mario_online_flow_test.js

const path = require('path');

let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

let capturedPage = null;
let lastUpdate = null;
let updateError = null;
global.Page = function (def) { capturedPage = def; };
global.getApp = function () { return { globalData: {} }; };
global.wx = {
  showToast: function () {},
  showLoading: function () {},
  hideLoading: function () {},
  showModal: function () {},
  createSelectorQuery: function () {
    const q = { in: function () { return q; }, select: function () { return q; },
      fields: function () { return q; }, exec: function (cb) { if (cb) cb([]); } };
    return q;
  },
  cloud: {
    database: function () {
      return {
        command: {},
        serverDate: function () { return new Date(); },
        collection: function () {
          return {
            add: function (o) { return Promise.resolve({ _id: 'room1' }); },
            where: function () { return { limit: function () { return this; }, get: function () { return Promise.resolve({ data: [] }); } }; },
            doc: function () {
              return {
                update: function (o) {
                  if (updateError) return Promise.reject(updateError);
                  lastUpdate = o && o.data;
                  return Promise.resolve({});
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

const EN = require(path.join(__dirname, '..', 'subpackages/games/mario/engine.js'));
const LV = require(path.join(__dirname, '..', 'subpackages/games/mario/levels.js'));

function loadPage() {
  capturedPage = null;
  delete require.cache[require.resolve(path.join(__dirname, '..', 'subpackages/games/mario/mario.js'))];
  require(path.join(__dirname, '..', 'subpackages/games/mario/mario.js'));
  const def = capturedPage;
  const page = {};
  for (const k of Object.keys(def)) page[k] = def[k];
  page.data = JSON.parse(JSON.stringify(def.data || {}));
  page.setData = function (patch, cb) {
    if (patch) for (const k of Object.keys(patch)) this.data[k] = patch[k];
    if (typeof cb === 'function') cb();
  };
  page._ensureCanvas = function () {};
  page._render = function () {};
  page._syncHud = function () {};
  page._checkEnd = function () {};
  return page;
}

function setupWorld(page) {
  const level = EN.loadLevel(LV.LEVEL_1, LV.LEVEL_SPECS[0]);
  page._level = level;
  page._players = [EN.makePlayer(level, 1), EN.makePlayer(level, 2)];
  page._players[1].x = level.start.col + 2.5;
  page._inputs = { 1: EN.makeInput(), 2: EN.makeInput() };
  page._roomId = 'room1';
  page.data.level = 0;
}

(async function () {
  console.log('\n[1] guest 输入中继 → host 应用');
  {
    const page = loadPage();
    setupWorld(page);
    page._applyInput2({ keys: { l: 0, r: 1, u: 1, d: 1, rn: 1 }, got: [] });
    const i2 = page._inputs[2];
    check(i2.right === true, '右 → host 侧 P2 输入 right=true');
    check(i2.up === true, '跳 → host 侧 P2 输入 up=true');
    check(i2.down === true, '下 → host 侧 P2 输入 down=true');
    check(i2.run === true, '跑 → host 侧 P2 输入 run=true');

    page._applyInput2({ keys: { l: 1, r: 0, u: 0, d: 0, rn: 0 }, got: [] });
    check(i2.left === true && i2.right === false, '松开右键/按左键能正确覆盖');
  }

  console.log('\n[2] host 写权威世界 / guest 写输入');
  {
    // host
    const host = loadPage();
    setupWorld(host);
    host.data.mode = 'online';
    host.data.mySeat = 1;
    lastUpdate = null;
    await host._doSync();
    check(lastUpdate && lastUpdate.world, 'host 写 world 字段');
    if (lastUpdate && lastUpdate.world) {
      const w = JSON.parse(lastUpdate.world);
      check(w.p1 && w.p2 && w.p1.x !== undefined, 'world 含双方玩家');
      check(w.level === 0, 'world 带关卡号');
    }

    // guest
    const guest = loadPage();
    setupWorld(guest);
    guest.data.mode = 'online';
    guest.data.mySeat = 2;
    guest._inputs[2].right = true;
    guest._inputs[2].up = true;
    guest._inputs[2].down = true;
    guest._inputs[2].run = true;
    guest._pendingGot = [3];
    lastUpdate = null;
    await guest._doSync();
    check(lastUpdate && lastUpdate.input2, 'guest 写 input2 字段');
    if (lastUpdate && lastUpdate.input2) {
      const inp = JSON.parse(lastUpdate.input2);
      check(inp.keys.r === 1 && inp.keys.u === 1 && inp.keys.d === 1 && inp.keys.rn === 1,
        'input2 包含 右/跳/下/跑');
      check(inp.got && inp.got.length === 1 && inp.got[0] === 3, 'input2 带上已吃金币 id');
    }

    check(host._txWorld === 1, 'host 写 world 后发送计数 +1');
    check(guest._txInput === 1, 'guest 写 input2 后发送计数 +1');

    // 收到远端数据后接收计数 +1
    host.data.stage = 'playing';
    host._onRoomUpdate({ status: 'playing', input2: JSON.stringify({ keys: { r: 1 }, got: [] }) });
    check(host._rxInput === 1, 'host 收到 input2 后接收计数 +1');
    guest.data.stage = 'playing';
    guest._onRoomUpdate({
      status: 'playing',
      world: JSON.stringify(EN.worldToWire(host._level, host._players))
    });
    check(guest._rxWorld === 1, 'guest 收到 world 后接收计数 +1');

    // 2.5Hz 采样会漏掉快速点按：跳/下的边沿必须锁存到下一次上报
    guest._inputs[2].up = false;
    guest._inputs[2].down = false;
    guest._edgeLatch = { u: true, d: false };
    guest._pendingGot = [];
    lastUpdate = null;
    await guest._doSync();
    const latched = JSON.parse(lastUpdate.input2);
    check(latched.keys.u === 1, '快速点跳的边沿被锁存并上报');
    check(guest._edgeLatch.u === false && guest._edgeLatch.d === false, '上报后锁存清零');
  }

  console.log('\n[3] guest 应用 host 世界：对手目标位置 + 自己不回弹');
  {
    const page = loadPage();
    setupWorld(page);
    page.data.mySeat = 2;
    // 自己先往右走一点（本地预测）
    page._players[1].x = 8;
    page._applyWorld({
      level: 0,
      p1: { x: 12.5, y: 14, vx: 1, vy: 0, f: -1, g: 1, fm: 0, st: 'alive', lv: 3, cn: 0, sc: 0 },
      p2: { x: 8.1, y: 14, vx: 1, vy: 0, f: 1, g: 1, fm: 0, st: 'alive', lv: 3, cn: 0, sc: 0 },
      es: [], cs: []
    }, false);
    check(page._players[0]._tx === 12.5 && page._players[0]._ty === 14,
      'host 的 P1 目标位置写入 guest 的 _tx/_ty');
    check(page._players[0].face === -1, '对手朝向同步');
    check(page._players[1].x === 8, '自己的位置不被小偏差拉回（8 vs 8.1）');
  }

  console.log('');
  console.log('[4] 双端闭环：guest 按键 → host 的 P2 真的会动 → guest 看到 host 移动');
  {
    const host = loadPage();
    setupWorld(host);
    host.data.mode = 'online';
    host.data.mySeat = 1;
    const guest = loadPage();
    setupWorld(guest);
    guest.data.mode = 'online';
    guest.data.mySeat = 2;

    const hostP2Start = host._players[1].x;
    const guestP1Start = guest._players[0].x;
    host._inputs[1].right = true;       // host 自己也在走
    guest._inputs[2].right = true;      // guest 在走

    for (let f = 0; f < 90; f++) {
      EN.stepWorld(guest._level, guest._players, guest._inputs, EN.TICK);
      const payload = {
        keys: {
          l: guest._inputs[2].left ? 1 : 0,
          r: guest._inputs[2].right ? 1 : 0,
          u: guest._inputs[2].up ? 1 : 0,
          d: guest._inputs[2].down ? 1 : 0,
          rn: guest._inputs[2].run ? 1 : 0
        },
        got: []
      };
      host._applyInput2(payload);
      EN.stepWorld(host._level, host._players, host._inputs, EN.TICK);
      guest._applyWorld(JSON.parse(JSON.stringify(EN.worldToWire(host._level, host._players))), false);
      guest._interpolate();
    }

    check(host._players[1].x > hostP2Start + 0.5,
      'host 侧 P2 因 guest 输入而前进（' + hostP2Start.toFixed(1) + '→' + host._players[1].x.toFixed(1) + '）');
    check(guest._players[0]._tx > guestP1Start + 0.5,
      'guest 侧收到 host 的 P1 目标位置（' + guestP1Start.toFixed(1) + '→' +
      (guest._players[0]._tx || 0).toFixed(1) + '）');
  }

  console.log('\n[5] 联机入口必须把 mode 切回 online');
  {
    // 先单机玩一把（mode=solo），再建房/加入，不能沿用 solo
    const page = loadPage();
    page.data.mode = 'solo';
    page.joinRoom = async function () {};
    page._startWatch = function () {};
    page._setupLevel(0);
    page._resetCanvas = function () {};
    page.joinRoom = function () {};

    // 给 createRoom 一个可用的 joinRoom 返回值路径太绕；直接验证 setData 源码
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'subpackages/games/mario/mario.js'), 'utf8');
    check(/stage: 'waiting',\s*mode: 'online'/.test(src), '建房时强制 mode=online');
    check(/stage: 'playing',\s*mode: 'online',\s*\n\s*roomNo,\s*\n\s*mySeat: 2/.test(src),
      '加入房间时强制 mode=online');
    check(/stage: 'playing',\s*mode: 'online',\s*\n\s*statusText: '联机闯关 · P1'/.test(src),
      '房主开局时强制 mode=online');
  }

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail > 0) {
    console.log('❌ 马里奥联机页面同步测试未通过');
    process.exit(1);
  }
  console.log('✓ 马里奥联机页面同步测试全部通过');
})();
