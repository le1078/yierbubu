// 马里奥（及后续联机游戏）实时中继服务器
//
// 为什么需要它：微信云数据库对单文档高频写会限流（本项目 2.5Hz 已贴线），
// watch 推送延迟 200~500ms 且不稳。把对局实时数据搬到自建 WebSocket 中继后：
//   - 云数据库只承担「建房/加入」等低频操作（保留原有房间号逻辑）
//   - 对局数据（host 的世界快照 / guest 的输入）经本服务器直转，无配额、低延迟
//
// 服务器本身不懂游戏语义：按「房间号 + 座位」配对，收到 {t:'d',v} 原样转发给
// 对面座位。任何游戏（马里奥/象棋/五子棋）都能复用，不需要改这里。
//
// 协议（全部 JSON 文本帧）：
//   客户端 → 服务器：
//     {t:'hello', room:'1234', seat:1|2}   入座（同座位旧连接会被顶下线）
//     {t:'d', v:{...}}                      游戏数据，转发给对面座位
//     {t:'ping', ts:...}                    应用层心跳
//     {t:'bye'}                             主动离开（区别于掉线）
//   服务器 → 客户端：
//     {t:'ready', room, seat}               就座成功
//     {t:'d', v:{...}}                      对面发来的游戏数据
//     {t:'peer', seat, online, bye}         对面上线/掉线/离开
//     {t:'pong', ts}                        心跳回显
//
// 运行：npm install && node server.js   （端口默认 9000，可用 PORT 环境变量改）

const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 9000;
const MAX_MSG_BYTES = 32 * 1024;   // 单条消息上限（世界快照 ~3KB，余量足够）
const RATE_LIMIT_PER_SEC = 120;    // 每连接每秒消息上限（游戏实际用量 < 15）
const SILENCE_KICK_MS = 30 * 1000; // 持续无消息（连 ping 都没有）视为僵尸，踢掉
const MAX_ROOMS = 5000;            // 防滥用：同时存在的房间数上限
// 连上后必须在这么长时间内完成 hello（入座），否则断开。
// 不设这个限制的话，只连不进房的连接不属于任何房间，永远不会被清理。
const HELLO_TIMEOUT_MS = Number(process.env.HELLO_TIMEOUT_MS) || 10 * 1000;

// 所有连接（含还没入座的）：限流/僵尸/handshake 超时都要覆盖到
const conns = new Set();

/* ========== 房间表 ========== */
// roomNo -> { seats: { 1: conn|null, 2: conn|null } }
const rooms = new Map();

function getRoom(no) {
  let r = rooms.get(no);
  if (!r) {
    if (rooms.size >= MAX_ROOMS) {
      // 先回收空房间再判断
      for (const [k, v] of rooms) {
        if (!v.seats[1] && !v.seats[2]) rooms.delete(k);
      }
      if (rooms.size >= MAX_ROOMS) return null;
    }
    r = { seats: { 1: null, 2: null } };
    rooms.set(no, r);
  }
  return r;
}

function sweepRoom(no) {
  const r = rooms.get(no);
  if (r && !r.seats[1] && !r.seats[2]) rooms.delete(no);
}

function sendTo(conn, obj) {
  if (conn && conn.alive) {
    try { conn.ws.send(JSON.stringify(obj)); } catch (e) { /* 对面正在关闭 */ }
  }
}

function broadcastPeer(room, no, seat, online, bye) {
  const other = seat === 1 ? 2 : 1;
  sendTo(room.seats[other], { t: 'peer', seat, online: !!online, bye: !!bye });
}

/* ========== 连接处理 ========== */

const wss = new WebSocketServer({ port: PORT, maxPayload: MAX_MSG_BYTES * 2 });

wss.on('connection', (ws) => {
  const conn = {
    ws,
    room: null,       // 房间号
    connectedAt: Date.now(),   // 「连上但一直不 hello」的超时回收基准
    seat: 0,
    alive: true,
    saidBye: false,   // 主动离开（区别于掉线）：close 广播时要带上
    msgCount: 0,      // 每秒限流计数
    totalMsgs: 0,     // 连接生命周期累计消息数（排障用：连着但没数据的僵尸一眼可见）
    lastSeen: Date.now()
  };
  conns.add(conn);

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    conn.lastSeen = Date.now();
    conn.msgCount += 1;
    conn.totalMsgs += 1;

    let m = null;
    try { m = JSON.parse(String(data)); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'hello') {
      const no = String(m.room || '').slice(0, 16);
      const seat = m.seat === 2 ? 2 : 1;
      if (!no) { sendTo(conn, { t: 'error', msg: 'room required' }); ws.close(1008); return; }
      const room = getRoom(no);
      if (!room) { sendTo(conn, { t: 'error', msg: 'server busy' }); ws.close(1013); return; }
      // 同座位顶号：旧连接直接断开（它会触发 peer offline）
      const old = room.seats[seat];
      if (old && old !== conn && old.alive) {
        room.seats[seat] = null;
        try { old.ws.close(4000, 'replaced'); } catch (e) {}
      }
      // 换房：从旧房间摘除
      if (conn.room && conn.room !== no && conn.seat) {
        const prev = rooms.get(conn.room);
        if (prev && prev.seats[conn.seat] === conn) {
          prev.seats[conn.seat] = null;
          broadcastPeer(prev, conn.room, conn.seat, false, true);
          sweepRoom(conn.room);
        }
      }
      conn.room = no;
      conn.seat = seat;
      room.seats[seat] = conn;
      sendTo(conn, { t: 'ready', room: no, seat });
      // 告诉新加入者对端的当前状态（对端早就坐在房间里时，
      // 新加入者收不到任何 peer 事件，会误以为对端不在线）
      const other = seat === 1 ? 2 : 1;
      const otherConn = room.seats[other];
      sendTo(conn, { t: 'peer', seat: other, online: !!(otherConn && otherConn.alive), bye: false });
      broadcastPeer(room, no, seat, true, false);
      console.log('[mario-relay] join room=' + no + ' seat=' + seat +
        ' peers=' + (room.seats[1] ? 1 : 0) + '+' + (room.seats[2] ? 1 : 0));
      return;
    }

    if (!conn.room || !conn.seat) return;   // 必须先 hello

    if (m.t === 'ping') {
      sendTo(conn, { t: 'pong', ts: m.ts });
      return;
    }
    if (m.t === 'bye') {
      conn.saidBye = true;
      try { ws.close(1000); } catch (e) {}
      return;
    }
    if (m.t === 'd') {
      // 游戏数据：原样转发给对面座位（不解析内容）
      const room = rooms.get(conn.room);
      if (!room) return;
      const other = conn.seat === 1 ? 2 : 1;
      const payload = JSON.stringify({ t: 'd', v: m.v });
      if (room.seats[other] && room.seats[other].alive) {
        try { room.seats[other].ws.send(payload); } catch (e) {}
      }
      return;
    }
  });

  ws.on('close', () => {
    conn.alive = false;
    conns.delete(conn);
    if (conn.room && conn.seat) {
      const room = rooms.get(conn.room);
      if (room && room.seats[conn.seat] === conn) {
        room.seats[conn.seat] = null;
        broadcastPeer(room, conn.room, conn.seat, false, conn.saidBye);
        console.log('[mario-relay] leave room=' + conn.room + ' seat=' + conn.seat +
          (conn.saidBye ? ' (bye)' : ' (drop)'));
        sweepRoom(conn.room);
      }
    }
  });

  ws.on('error', () => {
    conn.alive = false;
    try { ws.close(); } catch (e) {}
  });
});

/* ========== 流量透视（每 30 秒一行/房间，排障用） ========== */
// 「连着但没数据」的僵尸连接在这里一眼可见：totalMsgs 停着不动。
setInterval(() => {
  for (const [no, room] of rooms) {
    const s1 = room.seats[1], s2 = room.seats[2];
    if (!s1 && !s2) continue;
    const fmt = (c) => c
      ? c.totalMsgs + 'msg/' + ((Date.now() - c.lastSeen) / 1000).toFixed(0) + 's前'
      : '-';
    console.log('[mario-relay] stat room=' + no + ' s1=' + fmt(s1) + ' s2=' + fmt(s2));
  }
}, 30000).unref();

/* ========== 限流 + 僵尸回收 + handshake 超时（每秒一轮） ========== */
// 遍历「所有连接」而不是只遍历房间里的座位：只连接不 hello 的连接
// 不在任何房间，之前永远不会被限流/回收（可被用来长期占资源）。
setInterval(() => {
  const now = Date.now();
  for (const c of conns) {
    if (!c.alive) continue;
    // 每秒消息数超限
    if (c.msgCount > RATE_LIMIT_PER_SEC) {
      c.alive = false;
      try { c.ws.close(1008); } catch (e) {}
      continue;
    }
    c.msgCount = 0;
    // 连上却一直不入座
    if (!c.room && now - c.connectedAt > HELLO_TIMEOUT_MS) {
      c.alive = false;
      try { c.ws.close(1008); } catch (e) {}
      continue;
    }
    // 长期无消息（含 ping）
    if (now - c.lastSeen > SILENCE_KICK_MS) {
      c.alive = false;
      try { c.ws.close(1000); } catch (e) {}
    }
  }
  // 空房间回收
  for (const no of Array.from(rooms.keys())) sweepRoom(no);
}, 1000).unref();

/* ========== 启动 ========== */
wss.on('listening', () => {
  console.log('[mario-relay] listening on :' + PORT +
    '  (ws://<host>:' + PORT + '，生产环境建议套 nginx 走 wss，见 README)');
});

process.on('SIGINT', () => {
  console.log('\n[mario-relay] shutting down');
  for (const [, room] of rooms) {
    for (const seat of [1, 2]) {
      if (room.seats[seat]) { try { room.seats[seat].ws.close(1001); } catch (e) {} }
    }
  }
  process.exit(0);
});
