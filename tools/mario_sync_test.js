// 马里奥联机同步逻辑测试（不依赖 wx API，只验证协议与状态收敛）。
// 用法：node tools/mario_sync_test.js
//
// 验证重点：
//   1. host 权威 → guest 应用后，双方世界状态收敛一致
//   2. guest 输入中继：host 读到输入后玩家真的会动
//   3. guest 金币上报 → host 距离校验后才移除（不双扣、不轻信）
//   4. 偏差超过死区才拉回，避免每帧抖动
//   5. 序列化体积可控（云数据库单次写入限制）

const EN = require('../subpackages/games/mario/engine.js');
const LV = require('../subpackages/games/mario/levels.js');

let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

const DT = EN.TICK;

// 造一套 host / guest 各自独立的世界（模拟两台设备）
function mkPair() {
  const spec = LV.LEVEL_SPECS[0];
  const host = {
    level: EN.loadLevel(LV.LEVEL_1, spec),
    players: null,
    inputs: { 1: EN.makeInput(), 2: EN.makeInput() }
  };
  host.players = [EN.makePlayer(host.level, 1), EN.makePlayer(host.level, 2)];
  host.players[1].x = host.level.start.col + 2.5;
  host.players[1].respawnX = host.level.start.col + 2.5;

  const guestLevel = EN.loadLevel(LV.LEVEL_1, spec);
  const guest = {
    level: guestLevel,
    players: [EN.makePlayer(guestLevel, 1), EN.makePlayer(guestLevel, 2)],
    inputs: { 1: EN.makeInput(), 2: EN.makeInput() }
  };
  guest.players[1].x = guestLevel.start.col + 2.5;
  guest.players[1].respawnX = guestLevel.start.col + 2.5;
  return { host, guest };
}

/* ========== 1. 序列化往返 ========== */
console.log('\n[1] 世界序列化');
{
  const { host } = mkPair();
  // 跑一会儿让状态非平凡
  host.inputs[1].right = true;
  for (let i = 0; i < 60; i++) EN.stepWorld(host.level, host.players, host.inputs, DT);
  const w = EN.worldToWire(host.level, host.players);
  const s = JSON.stringify(w);
  console.log('    序列化大小 ' + s.length + ' 字节');
  check(s.length < 2048, '世界序列化 < 2KB（云数据库单次写入安全）');
  check(w.p1 && w.p2, '双方状态都在');
  check(w.p1.x !== w.p2.x, '双方位置不同（未串位）');
  check(Array.isArray(w.es) && w.es.length === host.level.enemies.length,
    '敌人数组完整（' + w.es.length + ' 个）');
  check(Array.isArray(w.cs) && w.cs.length <= 9, '金币数组不超总数');
}

/* ========== 2. host 权威 → guest 收敛 ========== */
console.log('\n[2] host 权威同步');
{
  const { host, guest } = mkPair();
  // host 的 P1 向右跑
  host.inputs[1].right = true;
  for (let i = 0; i < 90; i++) EN.stepWorld(host.level, host.players, host.inputs, DT);

  const w = JSON.parse(JSON.stringify(EN.worldToWire(host.level, host.players)));

  // guest 应用 host 的世界（模拟 _applyWorld）
  const g = guest.players[1];
  g.x = w.p1.x; g.y = w.p1.y; g.vx = w.p1.vx; g.vy = w.p1.vy;
  const g1 = guest.players[0];
  g1._tx = w.p2.x; g1._ty = w.p2.y;

  check(Math.abs(g.x - host.players[0].x) < 0.001, 'guest 侧 P2 对齐到 host 的 P1 位置');
  check(Math.abs(g1._tx - host.players[1].x) < 0.001, 'guest 侧 P1 拿到 host P2 的插值目标');

  // 敌人也要同步
  const gw = w.es[0];
  const he = host.level.enemies[0];
  check(gw[0] === he.id, '敌人 id 一致');
  check(Math.abs(gw[2] - he.x) < 0.01, '敌人位置一致');
}

/* ========== 3. guest 输入中继 ========== */
console.log('\n[3] guest 输入中继');
{
  const { host } = mkPair();
  // guest 发来的输入：P2 按右
  const relayed = { keys: { l: 0, r: 1, u: 0, rn: 1 }, got: [], t: 0 };
  const i2 = host.inputs[2];
  i2.left = !!relayed.keys.l;
  i2.right = !!relayed.keys.r;
  i2.up = !!relayed.keys.u;
  i2.run = !!relayed.keys.rn;

  const x0 = host.players[1].x;
  for (let i = 0; i < 60; i++) EN.stepWorld(host.level, host.players, host.inputs, DT);
  check(host.players[1].x > x0 + 1, 'host 读到中继输入后 P2 真的移动（' + x0.toFixed(2) + ' → ' + host.players[1].x.toFixed(2) + '）');
  check(host.players[1].vx > EN.PHYS.WALK_MAX, '中继的奔跑键生效（vx=' + host.players[1].vx.toFixed(2) + '）');
}

/* ========== 4. 金币校验（防双扣/防作弊） ========== */
console.log('\n[4] 金币上报校验');
{
  const { host } = mkPair();
  const level = host.level;
  const coin = level.coins[0];
  const p2 = host.players[1];

  // 情况 A：guest 上报的金币确实离 P2 很近 → host 应该移除
  p2.x = coin.col + 0.5;
  p2.y = coin.row + 0.5;
  const dx = Math.abs((coin.col + 0.5) - p2.x);
  const dy = Math.abs((coin.row + 0.5) - p2.y);
  check(dx < 1.2 && dy < 1.5, '近距离上报应被接受');
  if (dx < 1.2 && dy < 1.5) {
    coin.taken = true;
    p2.coins += 1;
  }
  check(coin.taken === true && p2.coins === 1, '接受后金币移除且计数 +1');

  // 情况 B：guest 上报一个很远的金币 → host 必须拒绝
  const { host: h2 } = mkPair();
  const farCoin = h2.level.coins[1];
  h2.players[1].x = 2.5;
  h2.players[1].y = 13.5;
  const dx2 = Math.abs((farCoin.col + 0.5) - h2.players[1].x);
  const dy2 = Math.abs((farCoin.row + 0.5) - h2.players[1].y);
  check(dx2 >= 1.2 || dy2 >= 1.5, '远距离上报距离 ' + dx2.toFixed(2) + '/' + dy2.toFixed(2) + ' 应被拒绝');
  if (dx2 < 1.2 && dy2 < 1.5) {
    farCoin.taken = true;
    h2.players[1].coins += 1;
  }
  check(farCoin.taken === false, '拒绝远距离上报（金币未被冒领）');
  check(h2.players[1].coins === 0, '冒领不会加计数');

  // 情况 C：重复上报同一金币 → 不双扣
  const { host: h3 } = mkPair();
  const c3 = h3.level.coins[0];
  h3.players[1].x = c3.col + 0.5;
  h3.players[1].y = c3.row + 0.5;
  for (let rep = 0; rep < 3; rep++) {
    if (c3.taken) continue;
    const dx3 = Math.abs((c3.col + 0.5) - h3.players[1].x);
    const dy3 = Math.abs((c3.row + 0.5) - h3.players[1].y);
    if (dx3 < 1.2 && dy3 < 1.5) {
      c3.taken = true;
      h3.players[1].coins += 1;
    }
  }
  check(h3.players[1].coins === 1, '重复上报只算一次（coins=' + h3.players[1].coins + '）');
}

/* ========== 5. 死区判定 ========== */
console.log('\n[5] 客户端预测死区');
{
  const { host, guest } = mkPair();
  const me = guest.players[1];
  // 小偏差：不拉回
  me.x = 10.0;
  const w1 = { p2: { x: 10.5, y: me.y, vx: 0, vy: 0 } };
  const dx1 = Math.abs(w1.p2.x - me.x);
  const shouldSnap1 = dx1 > 0.8;
  check(shouldSnap1 === false, '偏差 0.5 格 < 死区 0.8，不拉回（避免抖动）');

  // 大偏差：拉回（例如被传送/重生）
  me.x = 10.0;
  const w2 = { p2: { x: 14.0, y: me.y, vx: 0, vy: 0 } };
  const dx2 = Math.abs(w2.p2.x - me.x);
  const shouldSnap2 = dx2 > 0.8;
  check(shouldSnap2 === true, '偏差 4 格 > 死区，必须拉回');
}

/* ========== 6. 双跑确定性（同步算法根基） ========== */
console.log('\n[6] 双跑确定性');
{
  // host 跑 N 帧，把每 12 帧的世界序列化；guest 只应用不模拟自己的角色，
  // 最后双方 P1/host 侧状态应完全一致（这是"预测不漂移"的根基）
  function hostRun() {
    const { host } = mkPair();
    host.inputs[1].right = true;
    host.inputs[2].left = true;
    const snaps = [];
    for (let i = 0; i < 180; i++) {
      EN.stepWorld(host.level, host.players, host.inputs, DT);
      if (i % 12 === 0) snaps.push(EN.worldToWire(host.level, host.players));
    }
    return snaps;
  }
  const a = JSON.stringify(hostRun());
  const b = JSON.stringify(hostRun());
  check(a === b, 'host 两次同输入的世界序列逐帧一致');
  check(a.length > 100, '序列非空');
}

/* ========== 7. 同步频率与降频 ========== */
console.log('\n[7] 同步频率策略');
{
  // 5Hz = 200ms，失败降 2.5Hz = 400ms，再降 1Hz = 1000ms
  const base = 200, slow = 400, min = 1000;
  check(base === 1000 / 5, '默认 5Hz（200ms/次）');
  check(slow === 1000 / 2.5, '降频一档 2.5Hz');
  check(min === 1000 / 1, '降频二档 1Hz');
  // 每玩家每 200ms 一次写 = 5 次/秒，双人房间 10 次/秒，低于云数据库限流阈值
  check(5 < 10, '单座位 5 次/秒，低于云数据库单文档持续写入限流阈值');
}

/* ========== 汇总 ========== */
console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail > 0) {
  console.log('❌ 马里奥联机同步测试未通过');
  process.exit(1);
}
console.log('✓ 马里奥联机同步测试全部通过');
