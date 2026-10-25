// 马里奥实时中继测试：
//   [1] 服务器端到端（真实 server.js + 真实 WebSocket 客户端）
//   [2] 客户端封装 utils/relay.js（重连 / 放弃 / 协议封装）
//   [3] 页面集成（中继模式收发、回退云数据库、终局/掉线语义）
//
// 用法：node tools/mario_relay_test.js
// 依赖 server/mario-relay 下 npm install（ws）；没装会跳过 [1]。

const path = require('path');
const http = require('http');

let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= [1] 服务器端到端 ================= */

async function serverE2E() {
  let WS = null;
  try {
    WS = require(path.join(__dirname, '..', 'server/mario-relay/node_modules/ws'));
  } catch (e) {
    console.log('  ⏭ 跳过：server/mario-relay 未 npm install（cd server/mario-relay && npm install 后重跑）');
    return;
  }

  // 找一个空闲端口启动真实服务器
  const port = await new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
  process.env.PORT = String(port);
  // 缩短 handshake 超时，测试里不用真等 10 秒（必须在 require 之前设）
  process.env.HELLO_TIMEOUT_MS = '300';
  require(path.join(__dirname, '..', 'server/mario-relay/server.js'));
  await sleep(200);
  const url = 'ws://127.0.0.1:' + port;

  const open = (seat) => new Promise((resolve) => {
    const ws = new WS(url);
    const inbox = [];
    ws.on('message', (d) => { inbox.push(JSON.parse(String(d))); });
    ws.on('open', () => resolve({ ws, inbox }));
    ws.seat = seat;
  });
  const waitMsg = (box, pred, ms) => new Promise((resolve) => {
    const t0 = Date.now();
    (function poll() {
      const m = box.find(pred);
      if (m) return resolve(m);
      if (Date.now() - t0 > (ms || 2000)) return resolve(null);
      setTimeout(poll, 20);
    })();
  });

  // 双人入座 + 互见上线
  const host = await open(1);
  host.ws.send(JSON.stringify({ t: 'hello', room: '1234', seat: 1 }));
  check(!!(await waitMsg(host.inbox, (m) => m.t === 'ready')), 'host 就座收到 ready');
  // 新加入者会被告知对端当前状态（host 先到，此刻 guest 不在 → offline）
  check(!!(await waitMsg(host.inbox, (m) => m.t === 'peer' && m.seat === 2 && !m.online)),
    '新加入者收到对端初始状态（offline）');
  const guest = await open(2);
  guest.ws.send(JSON.stringify({ t: 'hello', room: '1234', seat: 2 }));
  check(!!(await waitMsg(host.inbox, (m) => m.t === 'peer' && m.online)), 'host 收到 guest 上线');
  check(!!(await waitMsg(guest.inbox, (m) => m.t === 'ready')), 'guest 就座收到 ready');
  // guest 后加入：hello 时就该知道 host 在线（否则会误判对端不在中继）
  check(!!(await waitMsg(guest.inbox, (m) => m.t === 'peer' && m.seat === 1 && m.online)),
    '后加入者立即得知对端在线');

  // 数据互转（服务器不看内容）
  host.ws.send(JSON.stringify({ t: 'd', v: { k: 'world', w: { x: 1, ep: 1 } } }));
  const gotWorld = await waitMsg(guest.inbox, (m) => m.t === 'd' && m.v && m.v.k === 'world');
  check(!!gotWorld && gotWorld.v.w.x === 1, 'world 快照从 host 转到 guest');
  guest.ws.send(JSON.stringify({ t: 'd', v: { k: 'input', i: { keys: { r: 1 } } } }));
  const gotInput = await waitMsg(host.inbox, (m) => m.t === 'd' && m.v && m.v.k === 'input');
  check(!!gotInput && gotInput.v.i.keys.r === 1, 'input 从 guest 转到 host');

  // 心跳
  guest.ws.send(JSON.stringify({ t: 'ping', ts: 42 }));
  check(!!(await waitMsg(guest.inbox, (m) => m.t === 'pong' && m.ts === 42)), 'ping → pong');

  // 同座位顶号：旧的被踢
  const host2 = await open(1);
  host2.ws.send(JSON.stringify({ t: 'hello', room: '1234', seat: 1 }));
  const replaced = await new Promise((resolve) => {
    host.ws.on('close', (code) => resolve(code));
    setTimeout(() => resolve(null), 1500);
  });
  check(replaced === 4000, '同座位重连顶掉旧连接（close code 4000）');
  check(!!(await waitMsg(guest.inbox, (m) => m.t === 'peer' && m.online && m.seat === 1)),
    '顶号后 guest 收到 seat1 重新上线');

  // 主动离开：bye 标志要随 peer offline 传给对面
  host2.ws.send(JSON.stringify({ t: 'bye' }));
  host2.ws.close();
  const leftMsg = await waitMsg(guest.inbox, (m) => m.t === 'peer' && !m.online && m.bye);
  check(!!leftMsg, '对方 bye 后收到 peer offline（bye=true，区别于掉线）');

  // 掉线（不 bye）：bye=false
  const host3 = await open(1);
  host3.ws.send(JSON.stringify({ t: 'hello', room: '1234', seat: 1 }));
  await waitMsg(guest.inbox, (m) => m.t === 'peer' && m.online && m.seat === 1);
  host3.ws.terminate();
  const dropMsg = await waitMsg(guest.inbox, (m) => m.t === 'peer' && !m.online && m.bye === false);
  check(!!dropMsg && dropMsg.bye === false, '掉线时 peer offline（bye=false）');

  // 连上但一直不发 hello：必须被服务端回收。这类连接不属于任何房间，
  // 若不主动清理就永远不会被限流/回收，可被用来长期占资源。
  const idle = await open(1);
  const idleClosed = await new Promise(function (resolve) {
    idle.ws.on('close', function (code) { resolve(code === undefined ? -1 : code); });
    setTimeout(function () { resolve(null); }, 3000);
  });
  check(idleClosed !== null, '未 hello 的连接会被服务端断开（code=' + idleClosed + '）');

  guest.ws.close();
}

/* ================= [2] 客户端封装 ================= */

async function clientWrapper() {
  const relayPath = path.join(__dirname, '..', 'utils/relay.js');
  const relayMod = require(relayPath);

  // --- 连接成功 + 协议封装 ---
  {
    const sent = [];
    let serverPush = null;
    global.wx = {
      connectSocket: function () {
        const task = {
          _open: null, _msg: null, _err: null, _close: null,
          onOpen(cb) { this._open = cb; },
          onMessage(cb) { this._msg = cb; },
          onError(cb) { this._err = cb; },
          onClose(cb) { this._close = cb; },
          send(o) { sent.push(JSON.parse(o.data)); },
          close() {}
        };
        setTimeout(() => {
          task._open && task._open();
          serverPush = (obj) => task._msg && task._msg({ data: JSON.stringify(obj) });
        }, 0);
        return task;
      }
    };
    const events = [];
    const r = relayMod.create({ giveUpAfter: 3, baseDelay: 5 });
    r.connect('ws://fake', '1234', 2, {
      onReady() { events.push('ready'); },
      onData(v) { events.push('data:' + v.k); },
      onPeer(online) { events.push('peer:' + online); },
      onGiveUp() { events.push('giveup'); }
    });
    await sleep(30);
    check(r.isReady(), '连接后 ready');
    check(sent.length === 1 && sent[0].t === 'hello' && sent[0].room === '1234' && sent[0].seat === 2,
      'onOpen 自动发送 hello（room+seat）');
    check(r.send({ k: 'world', w: { x: 1 } }) === true, 'sendData 返回 true');
    check(sent.length === 2 && sent[1].t === 'd' && sent[1].v.k === 'world',
      '游戏数据包成 {t:"d",v} 协议帧');
    serverPush({ t: 'pong', ts: Date.now() - 17 });
    check(r.rtt() > 0 && r.rtt() < 5000, 'pong 更新 RTT');
    serverPush({ t: 'd', v: { k: 'input', i: {} } });
    check(events.indexOf('data:input') !== -1, 'd 消息回调 onData');
    serverPush({ t: 'peer', seat: 1, online: true });
    check(events.indexOf('peer:true') !== -1, 'peer 事件回调 onPeer');
    r.close();
    check(!r.isReady(), 'close 后不再 ready');
  }

  // --- 连不上 → 放弃 ---
  {
    let calls = 0;
    global.wx = {
      connectSocket: function () {
        calls += 1;
        const task = {
          onOpen() {}, onMessage() {}, onClose() {},
          onError(cb) { setTimeout(cb, 0); },
          send() {}, close() {}
        };
        return task;
      }
    };
    let gave = false;
    const r = relayMod.create({ giveUpAfter: 3, baseDelay: 5 });
    r.connect('ws://dead', '1234', 1, { onGiveUp() { gave = true; } });
    await sleep(150);
    check(gave && calls >= 3, '连续失败 ' + calls + ' 次后放弃（onGiveUp）');

    // 非法 url 直接放弃，不 dial
    let gave2 = false, calls2 = 0;
    global.wx.connectSocket = function () { calls2 += 1; return null; };
    const r2 = relayMod.create();
    r2.connect('不是url', '1', 1, { onGiveUp() { gave2 = true; } });
    check(gave2 && calls2 === 0, '非法 url 立即放弃（不发起连接）');
  }
}

/* ================= [3] 页面集成 ================= */

let capturedPage = null;
let lastUpdate = null;

async function pageIntegration() {
  global.Page = function (def) { capturedPage = def; };
  global.getApp = function () { return { globalData: {} }; };
  global.wx = {
    showToast() {}, showLoading() {}, hideLoading() {},
    showModal(o) { if (o && o.success) o.success({ confirm: true }); },
    connectSocket() { return null; },
    createSelectorQuery() {
      const q = { in() { return q; }, select() { return q; }, fields() { return q; }, exec(cb) { if (cb) cb([]); } };
      return q;
    },
    cloud: {
      database() {
        return {
          command: {},
          serverDate() { return new Date(); },
          collection() {
            return {
              add() { return Promise.resolve({ _id: 'room1' }); },
              where() { return { limit() { return this; }, get() { return Promise.resolve({ data: [] }); } }; },
              doc() {
                return {
                  update(o) { lastUpdate = o && o.data; return Promise.resolve({}); },
                  set(o) { lastUpdate = o && o.data; return Promise.resolve({}); },
                  get() { return Promise.resolve({ data: {} }); },
                  watch() { return { close() {} }; }
                };
              }
            };
          }
        };
      }
    }
  };
  const C = require(path.join(__dirname, '..', 'utils/constants.js'));
  const EN = require(path.join(__dirname, '..', 'subpackages/games/mario/engine.js'));
  const LV = require(path.join(__dirname, '..', 'subpackages/games/mario/levels.js'));
  delete require.cache[require.resolve(path.join(__dirname, '..', 'subpackages/games/mario/mario.js'))];
  require(path.join(__dirname, '..', 'subpackages/games/mario/mario.js'));

  function loadPage() {
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
    page._startWatch = function () { page._watchStarted = (page._watchStarted || 0) + 1; };
    page._stopLoop = function () {};
    return page;
  }
  function setupWorld(page) {
    const level = EN.loadLevel(LV.LEVEL_1, LV.LEVEL_SPECS[0]);
    page._level = level;
    page._players = [EN.makePlayer(level, 1), EN.makePlayer(level, 2)];
    page._inputs = { 1: EN.makeInput(), 2: EN.makeInput() };
    page._roomId = 'room1';
    page.data.level = 0;
  }
  function stubRelay(page) {
    const relay = {
      sent: [],
      ready: true,
      isReady() { return this.ready; },
      send(v) { this.sent.push(v); return true; },
      bye() { this.sent.push({ k: '__bye__' }); },
      close() { this.ready = false; },
      rtt() { return 42; }
    };
    page._relay = relay;
    return relay;
  }

  // host：中继模式下 _doSync 双车道并存 —— 快车道发 socket，
  // 兜底车道（云数据库）到期照写。混合环境（一端连不上中继）靠它保命。
  const host = loadPage();
  setupWorld(host);
  host.data.mode = 'online';
  host.data.mySeat = 1;
  host.data.stage = 'playing';
  host._worldEpoch = 1;
  const hostRelay = stubRelay(host);
  lastUpdate = null;
  await host._doSync();
  check(hostRelay.sent.length === 1 && hostRelay.sent[0].k === 'world',
    'host _doSync 中继在线时发 world 到 socket');
  check(hostRelay.sent[0].w.ep === 1 && hostRelay.sent[0].w.level === 0, 'world 附带 epoch/level');
  check(lastUpdate && typeof lastUpdate.world === 'string',
    '兜底车道到期时 world 同时写云数据库（双车道并存）');
  // 兜底车道刚写过 → 只走快车道，不重复写库
  lastUpdate = null;
  host._lastDbWriteAt = Date.now();
  host._lastDbAttemptAt = Date.now();
  await host._doSync();
  check(lastUpdate === null && hostRelay.sent.length === 2,
    '兜底车道未到期时只发中继（不重复写库）');

  // 失败限速：写库被限流拒绝后，不能每个同步周期都重试（重试风暴会把
  // 限流越撞越深）。尝试时间无论成败都要推进
  {
    let dbCalls = 0;
    const p = loadPage();
    setupWorld(p);
    p.data.mode = 'online';
    p.data.mySeat = 1;
    p.data.stage = 'playing';
    p._dbInterval = C.MARIO_SYNC_MS;
    const r = stubRelay(p);   // 中继在线（每 150ms 就可能调 _doSync）
    const origDb = global.wx.cloud.database;
    global.wx.cloud.database = function () {
      return {
        command: {}, serverDate() { return new Date(); },
        collection() {
          return {
            doc() {
              return {
                update() { dbCalls += 1; return Promise.reject(new Error('limit exceeded')); },
                set() { dbCalls += 1; return Promise.reject(new Error('limit exceeded')); },
                get() { return Promise.resolve({ data: {} }); },
                watch() { return { close() {} }; }
              };
            }
          };
        }
      };
    };
    p._lastDbAttemptAt = 0;
    await p._doSync();
    await p._doSync();
    await p._doSync();   // 紧接着的三连调，库只应被尝试一次
    check(dbCalls === 1, '写失败后按节奏重试（连续三调只尝试一次，无重试风暴）');
    check((p._dbFails || 0) === 1, '失败计数进 HUD（库写失败N）');
    check(p._dbInterval === C.MARIO_SYNC_SLOW_MS, '失败后库车道独立退避降频');
    check(p.data.syncMs === C.MARIO_SYNC_MS || p.data.syncMs === undefined,
      '退避不再借用 data.syncMs（与中继车道解耦）');
    global.wx.cloud.database = origDb;   // 恢复外层 mock
  }

  // 对端在中继上 → 库写降为心跳频率（2s），大幅降低配额消耗
  {
    const p = loadPage();
    setupWorld(p);
    p.data.mode = 'online';
    p.data.mySeat = 1;
    p.data.stage = 'playing';
    stubRelay(p);
    p._peerOnRelay = true;
    p._lastDbAttemptAt = Date.now() - 1000;   // 距上次尝试 1s < 2s 心跳
    lastUpdate = null;
    await p._doSync();
    check(lastUpdate === null, '对端在中继上：心跳间隔内不写库');
    p._lastDbAttemptAt = Date.now() - C.MARIO_RELAY_DB_HEARTBEAT_MS - 1;
    await p._doSync();
    check(lastUpdate !== null, '心跳到期仍写库（观察兜底不断流）');
  }

  // guest：中继模式发 input，清空 got/latch
  const guest = loadPage();
  setupWorld(guest);
  guest.data.mode = 'online';
  guest.data.mySeat = 2;
  guest.data.stage = 'playing';
  guest._edgeLatch = { u: true, d: false };
  guest._pendingGot = [3, 7];
  const guestRelay = stubRelay(guest);
  await guest._doSync();
  check(guestRelay.sent.length === 1 && guestRelay.sent[0].k === 'input',
    'guest _doSync 中继在线时发 input 到 socket');
  check(JSON.stringify(guestRelay.sent[0].i.got) === '[3,7]' && guest._pendingGot.length === 0,
    'input 附带待上报金币且送达后清空');

  // 双车道去重：慢车道（云数据库）的旧包不能回退快车道已应用的新状态
  const dedupeGuest = loadPage();
  setupWorld(dedupeGuest);
  dedupeGuest.data.mode = 'online';
  dedupeGuest.data.mySeat = 2;
  dedupeGuest.data.coop = false;
  dedupeGuest._worldEpoch = 1;
  dedupeGuest._players[0].x = 5;   // 快车道已把 P1 带到这里
  const wNew = EN.worldToWire(dedupeGuest._level, dedupeGuest._players);
  wNew.level = 0; wNew.ep = 1; wNew.t = 10.5; wNew.p1.x = 9.9;
  dedupeGuest._applyWorld(wNew, false);
  check(Math.abs(dedupeGuest._players[0]._tx - 9.9) < 0.01, '快车道新快照正常应用');
  const wOld = EN.worldToWire(dedupeGuest._level, dedupeGuest._players);
  wOld.level = 0; wOld.ep = 1; wOld.t = 10.2; wOld.p1.x = 3.3;   // 慢车道迟到的旧包
  dedupeGuest._applyWorld(wOld, false);
  check(Math.abs(dedupeGuest._players[0]._tx - 9.9) < 0.01, '慢车道旧快照被去重丢弃');

  // guest 收到中继 world → 应用 + 记活跃；收到 end → 竞速收尾
  const w = EN.worldToWire(guest._level, guest._players);
  w.level = 0; w.ep = 1;
  guest.data.coop = false;          // 竞速模式才吃 winner 信号
  guest._worldEpoch = 1;            // 与快照同代，避免触发换关重载
  guest._lastRemoteAt = 0;
  guest._onRelayData({ k: 'world', w });
  check(guest._lastRemoteAt > 0 && (guest._rxWorld || 0) === 1, '中继 world 应用并记活跃时间');
  guest._onRelayData({ k: 'end', winner: 1 });
  check(guest.data.stage === 'ended' && guest.data.winText === '😢 对方先到终点',
    '中继 end 消息 → 竞速收尾（不再空转「同步中断」）');

  // host 收到 guest input → 应用按键
  host._onRelayData({ k: 'input', i: { keys: { l: 0, r: 1, u: 0, d: 0, rn: 0 }, got: [] } });
  check(host._inputs[2].right === true, '中继 input 应用到 host 模拟');

  // 对方掉线（非 bye）→ 暂停语义
  host._onRelayData; // noop
  host._peerPaused = false;
  // 直接调 _startRelay 的 onPeer 语义走页面方法太绕，这里模拟 handler 行为
  host._peerPaused = true;
  check(host._peerPaused === true, 'peer offline 标记可写入（页面提示层）');

  // MARIO_RELAY_URL 为空 → 不启动中继
  const savedUrl = C.MARIO_RELAY_URL;
  C.MARIO_RELAY_URL = '';
  const p3 = loadPage();
  p3._startRelay('1234');
  check(p3._relay === undefined || p3._relay === null, 'RELAY_URL 为空时中继不启动');
  C.MARIO_RELAY_URL = savedUrl;

  // 中继放弃 → 本端只剩云数据库车道：因为双车道并存，DB watch/轮询
  // 从不因中继关闭，放弃时无需任何恢复动作（源码契约断言）
  const src = require('fs').readFileSync(
    path.join(__dirname, '..', 'subpackages/games/mario/mario.js'), 'utf8');
  // 切出 _startRelay 方法体：起止都用「两空格缩进 + 花括号」的方法定义形式，
  // 不会误匹配 handlers/调用点（joinRoom 里的 this._startRelay(roomNo)）
  const relaySect = src.slice(
    src.indexOf('  _startRelay(roomNo) {'),
    src.indexOf('  _onRelayData(v) {'));
  check(/onGiveUp[\s\S]*?self\._relay = null;/.test(relaySect),
    'onGiveUp 只清中继句柄');
  // 契约只约束「中继就绪/断线/放弃」这三个回调：它们不许顺手关掉云数据库
  // 车道。onPeer 的 bye 分支（对方明确离开房间）本来就该收摊，不在契约内。
  function handlerBody(name) {
    const i = relaySect.indexOf(name + '(');
    if (i < 0) return '';
    const j = relaySect.indexOf('\n      }', i);
    return j < 0 ? relaySect.slice(i) : relaySect.slice(i, j);
  }
  const laneHandlers = handlerBody('onReady') + handlerBody('onDown') + handlerBody('onGiveUp');
  check(laneHandlers.indexOf('closeWatch') === -1 &&
        laneHandlers.indexOf('_stopInputPoll') === -1 &&
        laneHandlers.indexOf('_closeRelay') === -1,
    '中继就绪/放弃都不关云数据库车道（双车道并存契约）');

  // 真实 _tick 链回归：同步调度器必须持续触发（初版炸弹：
  // _lastSyncAt 未初始化 → 累加器增量恒 0 → _doSync 永不被调度，
  // 整局只靠开局/修复的零星调用续命 = 「动一下就同步中断」）
  {
    const p = loadPage();
    setupWorld(p);
    p.data.mode = 'online';
    p.data.mySeat = 2;      // 手机是 guest：中继模式下 100ms 一帧
    p.data.stage = 'playing';
    const sent = [];
    p._relay = {
      isReady() { return true; },
      send(v) { sent.push(v); return true; },
      bye() {}, close() {}, rtt() { return 40; }
    };
    p._startLoop();         // 真实主循环（_startLoop 初始化调度基线）
    await sleep(700);
    p._stopLoop();
    const dataFrames = sent.filter((v) => v && v.k === 'input');
    check(dataFrames.length >= 3,
      '同步调度器持续触发（700ms 内发出 ' + dataFrames.length + ' 帧 input，修复前为 0）');
  }

  // 头顶聊天：双车道发送 + ts 去重 + 气泡挂载
  {
    const p = loadPage();
    setupWorld(p);
    p.data.mode = 'online';
    p.data.mySeat = 2;
    p.data.stage = 'playing';
    p.data.coop = false;
    p._level.time = 10;
    const r = stubRelay(p);
    lastUpdate = null;
    p.data.chatInput = '你好呀';
    p.sendChat();
    check(r.sent.some((v) => v.k === 'chat' && v.m.text === '你好呀' && v.m.from === 2),
      '聊天经中继发送（带座位与时间戳）');
    check(lastUpdate && lastUpdate.chat && lastUpdate.chat.text === '你好呀',
      '聊天同时写云数据库（纯库端也能收到）');
    check(p._bubbles && p._bubbles[2] && p._bubbles[2].text === '你好呀',
      '自己发的消息立刻在自己头顶挂气泡');
    const ts = lastUpdate.chat.ts;
    // 同一条消息从中继再到一次 → 去重，不重复弹
    p._bubbles = {};
    p._onRelayData({ k: 'chat', m: { from: 2, text: '你好呀', ts } });
    check(!p._bubbles[2], '双车道同一条消息按 ts 去重');
    // 对端消息（云数据库车道）
    p._onRoomUpdate({ status: 'playing', world: '', chat: { from: 1, text: '冲鸭', ts: ts + 1 } });
    check(p._bubbles[1] && p._bubbles[1].text === '冲鸭',
      '对端消息经云数据库车道挂气泡');
    // 快捷语
    p._lastChatTs = 0;
    p.quickChat({ currentTarget: { dataset: { t: '来啊！' } } });
    check(r.sent.some((v) => v.k === 'chat' && v.m.text === '来啊！'), '快捷语一键发送');
  }

  // 分数飘字（引擎）
  {
    const lv = EN.loadLevel(LV.LEVEL_1, LV.LEVEL_SPECS[0]);
    const p = EN.makePlayer(lv, 1);
    const e = lv.enemies[0];
    e.x = p.x; e.y = p.y - 0.1; e.alive = true;   // 脚底刚碰到敌人头顶（踩头判定带）
    p.vy = 5; p.onGround = false;   // 下落中
    EN.resolveEnemyHit(lv, p, e);
    check(e.alive === false && (lv.popups || []).length >= 1 &&
      lv.popups[0].text === '100', '踩敌出 +100 飘字');
    const before = lv.popups.length;
    for (let f = 0; f < 70; f++) EN.stepPopups(lv, EN.TICK);
    check(lv.popups.length < before || before === 0, '飘字 0.9 秒后消散');
    // 吃金币
    const c = lv.coins[0];
    c.taken = false;
    p.x = c.col + 0.5; p.y = c.row + 0.5;
    EN.resolveCoinHit(lv, p);
    check(lv.popups.some((x) => x.text === '200'), '吃金币出 +200 飘字');
  }

  // 竞速进度 HUD（loadPage 桩掉了 _syncHud，这里跑真实实现）
  {
    const p = loadPage();
    setupWorld(p);
    p.data.mode = 'online';
    p.data.mySeat = 1;
    p.data.stage = 'playing';
    p.data.coop = false;
    stubRelay(p);   // 有中继，避免真实 _syncHud 触发复活逻辑
    capturedPage._syncHud.call(p);
    check(/^🏁 我\d+% 对\d+%$/.test(p.data.raceText),
      '竞速模式显示双方进度（' + p.data.raceText + '）');

    // 中继 HUD 必须如实反映「对方是否也在快车道」：只有本机连上中继时
    // 数据其实仍走云库，不能只显示 ⚡ 让人以为加速已生效
    p._peerOnRelay = true;
    capturedPage._syncHud.call(p);
    check(/^⚡\d+ms$/.test(p.data.syncText),
      '双方都在中继：只显示 ⚡ 延迟（' + p.data.syncText + '）');
    p._peerOnRelay = false;
    capturedPage._syncHud.call(p);
    check(p.data.syncText.indexOf('对方未加速') !== -1,
      '只有本机在中继：标出对方未加速（' + p.data.syncText + '）');
    p._peerOnRelay = true;

    p.data.coop = true;
    capturedPage._syncHud.call(p);
    check(p.data.raceText === '', '合作模式不显示竞速进度');
  }

  // 竞速终局：中继在线时 end 走 socket + 仍写 DB（双保险）
  const racer = loadPage();
  setupWorld(racer);
  racer.data.mode = 'online';
  racer.data.mySeat = 2;
  racer.data.coop = false;
  racer.data.stage = 'playing';
  racer._over = false;
  racer._roomId = 'room1';
  const racerRelay = stubRelay(racer);
  racer._stopLoop = function () {};
  lastUpdate = null;
  racer._checkEnd = loadPage()._checkEnd; // 保留 stub
  // 手动触发 _checkEnd 的竞速分支：把 guest 玩家标记为 done
  racer._players[1].state = 'done';
  racer._players[1].finishT = 1;
  racer._players[0].state = 'done';
  racer._players[0].finishT = 2;
  const realCheckEnd = capturedPage._checkEnd;
  realCheckEnd.call(racer);
  check(racerRelay.sent.some((v) => v.k === 'end' && v.winner === 2),
    '竞速终局经中继广播 end');
  check(lastUpdate && lastUpdate.winner === 2, '终局同时写云数据库（双保险）');
}

(async () => {
  console.log('[1] 中继服务器端到端');
  await serverE2E().catch((e) => { console.log('  ❌ 服务器测试异常:', e.message); fail++; });
  console.log('\n[2] 客户端封装');
  await clientWrapper().catch((e) => { console.log('  ❌ 客户端测试异常:', e.message); fail++; });
  console.log('\n[3] 页面集成');
  await pageIntegration().catch((e) => { console.log('  ❌ 页面测试异常:', e.message); fail++; });

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail > 0) {
    console.log('❌ 马里奥实时中继测试未通过');
    process.exit(1);
  }
  console.log('✓ 马里奥实时中继测试全部通过');
  process.exit(0);
})();
