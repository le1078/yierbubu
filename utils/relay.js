// 联机实时中继客户端（配合 server/mario-relay/server.js 使用）
//
// 职责：
//   1. wx.connectSocket 连接自建中继服务器，按「房间号 + 座位」入座
//   2. 自动重连（指数退避）；连续连不上则放弃并回调 onGiveUp，
//      页面据此退回云数据库同步（游戏永远可玩，只是回到老通道）
//   3. 应用层心跳（2s 一次 ping），顺带测 RTT
//
// 注意（SWC 白屏陷阱）：不能用数组解构 / 对象展开 / 可选链。

const PING_INTERVAL = 2000;
const CONNECT_TIMEOUT = 6000;   // onOpen 6 秒不来按失败处理（真机存在升级成功但回调永不触发的挂死）

// opts（可选，测试用）：{ giveUpAfter: 连续失败N次放弃, baseDelay: 退避基数ms }
function create(opts) {
  const st = {
    task: null,
    url: '',
    room: '',
    seat: 0,
    ready: false,
    everReady: false,
    closed: false,        // 页面主动关闭，不再重连
    fails: 0,
    dropped: false,       // 单次连接的 onError/onClose 去重
    retryTimer: null,
    pingTimer: null,
    connectTimer: null,
    rttMs: 0,
    giveUpAfter: (opts && opts.giveUpAfter) || 3,
    baseDelay: (opts && typeof opts.baseDelay === 'number') ? opts.baseDelay : 500,
    handlers: {}
  };

  function clearTimers() {
    if (st.retryTimer) { clearTimeout(st.retryTimer); st.retryTimer = null; }
    if (st.pingTimer) { clearInterval(st.pingTimer); st.pingTimer = null; }
    if (st.connectTimer) { clearTimeout(st.connectTimer); st.connectTimer = null; }
  }

  function killTask() {
    if (st.task) {
      try { st.task.close({}); } catch (e) {}
      st.task = null;
    }
  }

  function giveUp() {
    clearTimers();
    st.closed = true;
    st.ready = false;
    // 关键：放弃时必须关掉底层 socket，否则它变成「服务器侧在线、
    // 页面侧已死」的僵尸连接，对端一直看着你在线却收不到任何数据
    killTask();
    if (st.handlers.onGiveUp) st.handlers.onGiveUp();
  }

  // 连接失败/断开：退避重连，连续失败太多次就放弃
  function drop() {
    if (st.dropped) return;   // onError 和 onClose 常会连着各触发一次
    st.dropped = true;
    const wasReady = st.ready;
    st.ready = false;
    st.task = null;
    if (st.pingTimer) { clearInterval(st.pingTimer); st.pingTimer = null; }
    if (st.connectTimer) { clearTimeout(st.connectTimer); st.connectTimer = null; }
    if (st.closed) return;
    st.fails += 1;
    if (st.fails >= st.giveUpAfter) { giveUp(); return; }
    const delay = Math.min(8000, st.baseDelay * Math.pow(2, st.fails));   // 1s/2s/4s…
    st.retryTimer = setTimeout(dial, delay);
    if (wasReady && st.handlers.onDown) st.handlers.onDown();
  }

  function dial() {
    if (st.closed) return;
    st.dropped = false;
    let task = null;
    try {
      task = wx.connectSocket({ url: st.url });
    } catch (e) {
      task = null;
    }
    if (!task || typeof task.onOpen !== 'function') {
      // 基础库过旧 / url 非法：直接按失败处理
      drop();
      return;
    }
    st.task = task;

    // 连接超时看门狗：onOpen 超时即关掉本次连接按失败重试。
    // 真机上存在「服务器侧 101 成功、客户端 onOpen 永不触发」的挂死，
    // 没有看门狗这个 relay 实例就永远卡死（页面也不再走中继）
    st.connectTimer = setTimeout(function () {
      if (st.ready || st.closed) return;
      try { task.close({}); } catch (e) {}
      drop();
    }, CONNECT_TIMEOUT);

    task.onOpen(function () {
      if (st.closed) return;
      if (st.connectTimer) { clearTimeout(st.connectTimer); st.connectTimer = null; }
      st.ready = true;
      st.everReady = true;
      st.fails = 0;
      send({ t: 'hello', room: st.room, seat: st.seat });
      if (st.pingTimer) clearInterval(st.pingTimer);
      st.pingTimer = setInterval(function () {
        send({ t: 'ping', ts: Date.now() });
      }, PING_INTERVAL);
      if (st.handlers.onReady) st.handlers.onReady();
    });

    task.onMessage(function (res) {
      let m = null;
      try { m = JSON.parse(res.data); } catch (e) { return; }
      if (!m) return;
      if (m.t === 'pong') {
        st.rttMs = Date.now() - (m.ts || Date.now());
        return;
      }
      if (m.t === 'peer') {
        if (st.handlers.onPeer) st.handlers.onPeer(!!m.online, m.seat, !!m.bye);
        return;
      }
      if (m.t === 'd') {
        if (st.handlers.onData) st.handlers.onData(m.v);
        return;
      }
    });

    task.onError(function () { drop(); });
    task.onClose(function () { drop(); });
  }

  function connect(url, room, seat, handlers) {
    st.url = String(url || '');
    st.room = String(room || '');
    st.seat = seat === 2 ? 2 : 1;
    st.handlers = handlers || {};
    if (!/^wss?:\/\//.test(st.url)) {
      // 没配或配错：立刻按「放弃」处理，页面走云数据库
      giveUp();
      return;
    }
    dial();
  }

  function send(obj) {
    if (!st.task || !st.ready) return false;
    try {
      st.task.send({ data: JSON.stringify(obj) });
      return true;
    } catch (e) {
      return false;
    }
  }

  // 游戏数据：包成 {t:'d', v} 协议帧，服务器原样转发给对面座位
  function sendData(v) {
    return send({ t: 'd', v: v });
  }

  // 主动离开：服务器会以 bye=1 通知对面（区别于掉线）
  function bye() {
    send({ t: 'bye' });
  }

  // 页面主动关闭（离开对局/切后台）：不再重连
  function close() {
    st.closed = true;
    clearTimers();
    st.ready = false;
    killTask();
  }

  return {
    connect: connect,
    send: sendData,
    bye: bye,
    close: close,
    isReady: function () { return st.ready; },
    everReady: function () { return st.everReady; },
    rtt: function () { return st.rttMs; }
  };
}

module.exports = { create };
