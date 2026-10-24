// 中继客户端回归：重连期间的「迟到回调」必须作废。
//
// 真机常见时序（移动网络）：
//   旧 socket onError → 进入退避重连 → 新 socket 已 onOpen、hello 已发
//   → 旧 socket 的 onClose 才姗姗来迟
// 没有代际令牌时，这个迟到的 close 会把新连接当成自己的：置 ready=false、
// 清空 st.task（但新 socket 还活着）→ 之后 hello 发不出去、收发全断，
// 表现为「明明显示已连接，对方却不动」。
//
// 用法：node tools/relay_client_test.js

const path = require('path');

let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

let tasks = [];
function makeTask() {
  const t = {
    sent: [],
    closed: false,
    onOpen: function (cb) { t._open = cb; return t; },
    onMessage: function (cb) { t._msg = cb; return t; },
    onError: function (cb) { t._err = cb; return t; },
    onClose: function (cb) { t._close = cb; return t; },
    send: function (o) { if (t.closed) throw new Error('socket closed'); t.sent.push(o.data); },
    close: function () { t.closed = true; }
  };
  tasks.push(t);
  return t;
}

global.wx = {
  connectSocket: function () { return makeTask(); }
};

const relaykit = require(path.join(__dirname, '..', 'utils', 'relay.js'));

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

(async function run() {
  console.log('[1] 旧 socket 的迟到 onClose 不能拆掉新连接');
  {
    tasks = [];
    const events = { ready: 0, down: 0, giveup: 0, data: 0 };
    const r = relaykit.create({ giveUpAfter: 10, baseDelay: 5 });
    r.connect('ws://relay.test/abc', '1234', 1, {
      onReady: function () { events.ready++; },
      onDown: function () { events.down++; },
      onGiveUp: function () { events.giveup++; },
      onData: function () { events.data++; },
      onPeer: function () {}
    });
    check(tasks.length === 1, '发起连接');
    const t1 = tasks[0];
    t1._open();
    check(r.isReady() === true, '第一条连接就绪');
    check(t1.sent.length === 1 && t1.sent[0].indexOf('"hello"') !== -1, '已发送 hello');

    t1._err();                       // 掉线，进入退避
    check(r.isReady() === false, '掉线后未就绪');
    check(t1.closed === true, '掉线的旧 socket 被主动关闭（不留半开连接）');
    await sleep(40);
    check(tasks.length === 2, '退避后发起第二条连接');

    const t2 = tasks[1];
    t2._open();
    check(r.isReady() === true, '第二条连接就绪');
    check(events.ready === 2, 'onReady 回调两次');

    // 关键：旧 socket 的 close 现在才到
    t1._close();
    check(r.isReady() === true, '迟到的旧 onClose 不影响新连接就绪状态');
    check(t2.closed === false, '新连接没有被误关');
    await sleep(50);
    check(tasks.length === 2, '没有因为旧回调多拨一条连接');

    r.send({ k: 'world', n: 1 });
    check(t2.sent.length === 2 && t2.sent[1].indexOf('"world"') !== -1, '数据仍然发往新连接');
    t2._msg({ data: '{"t":"d","v":{"k":"input"}}' });
    check(events.data === 1, '新连接的消息正常分发');
    t2._msg({ data: '{"t":"peer","seat":2,"online":false}' });
    t1._msg({ data: '{"t":"d","v":{"k":"stale"}}' });
    check(events.data === 1, '旧连接的残留消息被丢弃');

    r.close();
    const n = tasks.length;
    await sleep(50);
    check(tasks.length === n, '主动关闭后不再重连');
    t2._close();
    check(events.giveup === 0, '主动关闭不触发 onGiveUp');
  }

  console.log('\n[2] 连续失败达到上限：放弃并关掉 socket');
  {
    tasks = [];
    let gaveUp = 0;
    const r = relaykit.create({ giveUpAfter: 2, baseDelay: 5 });
    r.connect('ws://relay.test/abc', '1234', 2, { onGiveUp: function () { gaveUp++; } });
    tasks[0]._err();
    await sleep(40);
    check(tasks.length === 2, '第一次失败后重试');
    tasks[1]._err();
    check(gaveUp === 1, '连续失败到上限触发 onGiveUp');
    check(tasks[1].closed === true, '放弃时关闭底层 socket');
    check(r.isReady() === false, '放弃后未就绪');
    const n = tasks.length;
    await sleep(60);
    check(tasks.length === n, '放弃后不再重试');
  }

  console.log('\n[3] 非法地址直接降级，不抛异常');
  {
    tasks = [];
    let gaveUp = 0;
    const r = relaykit.create({});
    r.connect('http://not-a-ws-url', '1234', 1, { onGiveUp: function () { gaveUp++; } });
    check(gaveUp === 1 && tasks.length === 0, '非 ws 地址立即 onGiveUp，不建连接');
  }

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('❌ 中继客户端回归未通过'); process.exit(1); }
  console.log('✓ 中继客户端回归全部通过');
  process.exit(0);
})();
