// 部署后的公网冒烟测试：两客户端经 nginx + 中继完成握手/配对/互转/心跳
// 用法：node tools/relay_smoke_test.js [ws://host/prefix/]

const path = require('path');
const WS = require(path.join(__dirname, '..', 'server/mario-relay/node_modules/ws'));

const URL = process.argv[2] || 'ws://81.70.22.49/e8f31a5c27/';
const start = Date.now();
const log = [];

function cleanup(a, b, code) {
  try { a && a.close(); } catch (e) {}
  try { b && b.close(); } catch (e) {}
  console.log(code === 0 ? '=== 部署验证通过 ===' : '=== 验证失败 ===');
  console.log(log.join('\n'));
  process.exit(code);
}

const a = new WS(URL);
let b = null;

const failTimer = setTimeout(() => cleanup(a, b, 1), 10000);

a.on('error', (e) => { log.push('A错误: ' + e.message); clearTimeout(failTimer); cleanup(a, b, 1); });
a.on('open', () => {
  log.push('A 握手 ' + (Date.now() - start) + 'ms → hello seat1');
  a.send(JSON.stringify({ t: 'hello', room: 'SMOKE' + Date.now() % 100000, seat: 1 }));
});
a.on('message', (d) => {
  const m = JSON.parse(String(d));
  log.push('A ← ' + JSON.stringify(m));
  if (m.t === 'ready' && !b) {
    b = new WS(URL);
    b.on('error', (e) => { log.push('B错误: ' + e.message); clearTimeout(failTimer); cleanup(a, b, 1); });
    b.on('message', (d2) => {
      const m2 = JSON.parse(String(d2));
      log.push('B ← ' + JSON.stringify(m2) +
        (m2.t === 'pong' ? ' (RTT ' + (Date.now() - m2.ts) + 'ms)' : ''));
      if (m2.t === 'd' && m2.v && m2.v.k === 'world') {
        clearTimeout(failTimer);
        cleanup(a, b, 0);   // 全链路打通
      }
    });
    b.on('open', () => {
      log.push('B 握手 → hello seat2');
      b.send(JSON.stringify({ t: 'hello', room: roomNo, seat: 2 }));
    });
  }
  if (m.t === 'peer' && m.online && b) {
    a.send(JSON.stringify({ t: 'd', v: { k: 'world', w: { x: 7.5 } } }));
    a.send(JSON.stringify({ t: 'ping', ts: Date.now() }));
  }
});

let roomNo = '';
const origSend = a.send.bind(a);
a.send = (data) => {
  try { const o = JSON.parse(data); if (o.t === 'hello') roomNo = o.room; } catch (e) {}
  origSend(data);
};
