// 中继服务器端到端浸泡测试：拉起真实 server.js（本地测试端口），
// 用真实 WebSocket 客户端跑多房间并发 + 异常输入 + 顶号 + 掉线/退出，
// 验证转发、peer 广播、bye 区分、握手超时回收都按协议工作。
//
// 线上冒烟（relay_smoke_test.js）只验一条链路；这里补服务器端的清理与抗异常。
//
// 用法：node tools/relay_server_soak_test.js

const path = require('path');
const { spawn } = require('child_process');

const SERVER_DIR = path.join(__dirname, '..', 'server', 'mario-relay');
let WebSocket = null;
try {
  WebSocket = require(path.join(SERVER_DIR, 'node_modules', 'ws'));
} catch (e) {
  // 服务器依赖没装（新克隆的仓库）：跳过而不是判失败
  console.log('（跳过）server/mario-relay 未安装依赖，先执行 cd server/mario-relay && npm install');
  process.exit(0);
}
const PORT = 19091;
const HELLO_TIMEOUT = 600;

let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

function wait(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

function waitFor(cond, timeoutMs, label) {
  const started = Date.now();
  return new Promise(function (resolve, reject) {
    (function loop() {
      if (cond()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('超时：' + label));
      setTimeout(loop, 20);
    })();
  });
}

const URL = 'ws://127.0.0.1:' + PORT + '/soak';

function client() {
  const ws = new WebSocket(URL);
  const c = { ws, msgs: [], closed: false, closeCode: 0 };
  ws.on('message', function (raw) {
    let m = null;
    try { m = JSON.parse(String(raw)); } catch (e) { return; }
    c.msgs.push(m);
  });
  ws.on('close', function (code) { c.closed = true; c.closeCode = code; });
  ws.on('error', function () {});
  c.open = new Promise(function (resolve, reject) {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  c.send = function (obj) { try { ws.send(JSON.stringify(obj)); } catch (e) {} };
  c.hello = async function (room, seat) {
    await c.open;
    c.send({ t: 'hello', room, seat });
    await waitFor(function () { return c.msgs.some(function (m) { return m.t === 'ready'; }); },
      2000, 'ready');
    return c;
  };
  c.find = function (pred) { return c.msgs.filter(pred); };
  return c;
}

(async function run() {
  let out = '';
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: SERVER_DIR,
    env: Object.assign({}, process.env, { PORT: String(PORT), HELLO_TIMEOUT_MS: String(HELLO_TIMEOUT) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stdout.on('data', function (d) { out += String(d); });
  srv.stderr.on('data', function (d) { out += String(d); });

  try {
    await waitFor(function () { return out.indexOf('listening') !== -1; }, 8000, '服务器启动');
    check(true, '服务器启动（PORT=' + PORT + '）');

    console.log('\n[1] 多房间并发转发');
    {
      const rooms = [];
      const pairs = [];
      for (let i = 0; i < 12; i++) {
        const no = 'R' + i + 'X';
        rooms.push(no);
        pairs.push([client(), client()]);
      }
      for (let i = 0; i < pairs.length; i++) {
        await pairs[i][0].hello(rooms[i], 1);
        await pairs[i][1].hello(rooms[i], 2);
      }
      let ok = true;
      for (let i = 0; i < pairs.length; i++) {
        pairs[i][0].send({ t: 'd', v: { k: 'world', i: i } });
      }
      await wait(200);
      for (let i = 0; i < pairs.length; i++) {
        const got = pairs[i][1].find(function (m) { return m.t === 'd' && m.v && m.v.i === i; });
        if (got.length !== 1) ok = false;
      }
      check(ok, '12 个房间互不串台，各收到且仅收到自己房间的数据');
      check(pairs[0][1].find(function (m) { return m.t === 'peer' && m.seat === 1 && m.online; }).length >= 1,
        '入座后通知对端在线');
      for (const [a, b] of pairs) { a.ws.close(); b.ws.close(); }
      await wait(300);
    }

    console.log('\n[2] bye 与掉线的区分');
    {
      const a = client();
      const b = client();
      await a.hello('BYE1', 1);
      await b.hello('BYE1', 2);
      a.send({ t: 'bye' });
      await wait(150);
      const byeMsg = b.find(function (m) { return m.t === 'peer' && m.bye === true && m.online === false; });
      check(byeMsg.length === 1, '主动 bye → 对端收到 peer offline + bye');

      const c = client();
      await c.hello('DROP', 1);
      const d = client();
      await d.hello('DROP', 2);
      c.ws.close();   // 非 bye 的掉线
      await wait(150);
      const dropMsg = d.find(function (m) { return m.t === 'peer' && m.bye === false && m.online === false; });
      check(dropMsg.length === 1, '直接断开 → 对端收到 offline 但不带 bye');
      b.ws.close(); d.ws.close();
      await wait(100);
    }

    console.log('\n[3] 同座位顶号');
    {
      const oldGuy = client();
      await oldGuy.hello('TAKE', 1);
      const newGuy = client();
      await newGuy.hello('TAKE', 1);
      await wait(150);
      check(oldGuy.closed === true, '旧连接被服务器断开');
      check(oldGuy.closeCode === 4000, '断开码 4000（replaced）');

      const peer = client();
      await peer.hello('TAKE', 2);
      newGuy.send({ t: 'd', v: { k: 'x' } });
      await wait(100);
      check(peer.find(function (m) { return m.t === 'd'; }).length === 1, '顶号后的新连接收发正常');
      newGuy.ws.close(); peer.ws.close();
      await wait(100);
    }

    console.log('\n[4] 异常输入不能打垮服务器');
    {
      const a = client();
      await a.hello('BAD1', 1);
      const b = client();
      await b.hello('BAD1', 2);
      b.ws.send('not json');
      b.ws.send('{');
      b.ws.send('[]');
      b.ws.send('{"t":123}');
      b.ws.send('{"t":"d"}');                 // 缺 v
      b.ws.send(JSON.stringify({ t: 'd', v: { k: 'big', s: 'x'.repeat(20000) } }));
      b.ws.send(Buffer.from([0, 1, 2, 3]));   // 二进制帧
      await wait(150);
      b.send({ t: 'ping', ts: 42 });
      await wait(120);
      check(b.find(function (m) { return m.t === 'pong' && m.ts === 42; }).length === 1,
        '脏数据之后仍在正常工作（pong 正常返回）');
      check(a.find(function (m) { return m.t === 'd' && m.v && m.v.k === 'big'; }).length === 1,
        '2 万字节的合法数据仍能转发');
      a.ws.close(); b.ws.close();
      await wait(100);
    }

    console.log('\n[5] 只连不入座的连接会被回收');
    {
      const idle = client();
      await idle.open;
      await wait(HELLO_TIMEOUT + 900);
      check(idle.closed === true, '握手超时后服务器主动断开（不占资源）');
    }

    console.log('\n[6] 浸泡后服务器仍然健康');
    {
      const probe = client();
      await probe.hello('ALIVE', 1);
      probe.send({ t: 'ping', ts: 7 });
      await wait(120);
      check(probe.find(function (m) { return m.t === 'pong' && m.ts === 7; }).length === 1, '服务器仍有响应');
      probe.ws.close();
      await wait(100);
    }

    check(!/Uncaught|UnhandledPromiseRejection|\n\s+at /.test(out), '全程没有未捕获异常/堆栈');
  } catch (e) {
    check(false, '测试执行异常：' + e.message);
  } finally {
    srv.kill('SIGINT');
    // Windows 下 Node 不能真正给子进程发 POSIX 信号（走 TerminateProcess），
    // 所以这里只断言「进程确实退出了」，优雅退出处理在 Linux 部署环境生效
    const gone = await new Promise(function (res) {
      if (srv.exitCode !== null || srv.signalCode) return res(true);
      srv.once('exit', function () { res(true); });
      setTimeout(function () { res(false); }, 2000);
    });
    if (!gone) { try { srv.kill('SIGKILL'); } catch (e) {} }
    check(gone, '关闭后进程已退出（exitCode=' + srv.exitCode + ', signal=' + srv.signalCode + '）');
  }

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) {
    console.log('❌ 中继服务器浸泡测试未通过');
    process.exit(1);
  }
  console.log('✓ 中继服务器浸泡测试全部通过');
  process.exit(0);
})();
