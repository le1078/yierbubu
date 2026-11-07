// 号码下注组件逻辑测试：不依赖开发者工具，直接 mock wx / Component 跑状态机。
// 覆盖：号码池映射、备码区增删合并、一起下注、封盘结算（输/赢）、
//       开奖间隔切换、空局不计入连不中、历史记录截断。
//
// 用法：node tools/bet_logic_test.js

const path = require('path');

let pass = 0, fail = 0;
function check(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); }
}

/* ---------- mock 小程序运行时 ---------- */
const storage = {};
let toasts = [];
global.wx = {
  getStorageSync(k) { return storage[k] === undefined ? '' : JSON.parse(JSON.stringify(storage[k])); },
  setStorageSync(k, v) { storage[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync(k) { delete storage[k]; },
  showToast(o) { toasts.push(o.title); },
  vibrateShort() {},
  showModal() {}
};

let comp = null;
global.Component = (opts) => { comp = opts; };
require(path.join(__dirname, '..', 'components', 'bet', 'bet.js'));

function makeInst() {
  const inst = {
    data: JSON.parse(JSON.stringify(comp.data)),
    setData(patch) { Object.assign(this.data, patch); },
    _loaded: false
  };
  Object.keys(comp.methods).forEach((k) => { inst[k] = comp.methods[k].bind(inst); });
  // 测试里不要真的起定时器，回合推进由 _tick() 手动驱动
  inst._startClock = function () {};
  inst._stopClock = function () {};
  return inst;
}

function tap(inst, method, dataset, detail) {
  return inst[method]({ currentTarget: { dataset: dataset || {} }, detail: detail || {} });
}

function forceDraw(n) {
  const orig = Math.random;
  Math.random = () => (n - 0.5) / 49;
  return () => { Math.random = orig; };
}

// 生肖/号码是开关式的：已经选中就不要再点，否则会被取消
function pickZ(inst, i) { if (inst._s.selZ !== i) tap(inst, 'onPickZodiac', { i }); }
function pickN(inst, n) { if (inst._s.selN !== n) tap(inst, 'onPickNumber', { n }); }

console.log('\n[1] 号码池与生肖分组');
const inst = makeInst();
comp.lifetimes.attached.call(inst);
tap(inst, 'onStartPick', { c: 5000 });
inst.onStartGame();

check(inst._s && inst._s.bankroll === 5000, '开局筹码 5000');
check(inst.data.zlist.length === 12, '12 个生肖');
const counts = inst.data.zlist.map((z) => z.cnt);
check(counts.filter((c) => c === 5).length === 1, '当年生肖占 5 个号');
check(counts.filter((c) => c === 4).length === 11, '其余生肖各 4 个号');
check(counts.reduce((a, b) => a + b, 0) === 49, '号码合计 49 个');
check(inst._s.phase === 'betting' && inst._s.round === 1, '开局进入第 1 期下注');

console.log('\n[2] 选号 + 备码区');
tap(inst, 'onPickZodiac', { i: 0 });   // 鼠
check(inst.data.nums.map((x) => x.n).join(',') === '7,19,31,43', '鼠组号码 07/19/31/43');

pickN(inst, 7);
inst.onAmtInput({ detail: { value: '100' } });
inst.onStageAdd();
check(inst.data.staging.length === 1 && inst.data.staging[0].amount === 100, '第 1 注进备码区');

pickN(inst, 19);
inst.onAmtInput({ detail: { value: '50' } });
inst.onStageAdd();
check(inst.data.staging.length === 2 && inst.data.stagingTotalText === '150', '第 2 注进备码区，合计 150');

pickN(inst, 7);
inst.onAmtInput({ detail: { value: '25' } });
inst.onStageAdd();
const s7 = inst.data.staging.filter((x) => x.n === 7)[0];
check(inst.data.staging.length === 2 && s7.amount === 125, '同号继续备码会合并（07 → 125）');
check(inst._s.bets.length === 0, '备码期间还没真正下注');

console.log('\n[3] 一起下注');
inst.onSubmitStage();
check(inst._s.bets.length === 2, '备码 2 注转入本局押注');
check(inst.data.betsTotalText === '175', '本局押注合计 175');
check(inst.data.staging.length === 0, '备码区已清空');
check(inst.data.nums.filter((x) => x.picked).length === 2, '押过的号码在选号区打勾');

console.log('\n[4] 封盘 + 开奖（未中）');
let restore = forceDraw(8);
inst._s.deadline = Date.now() - 1;
inst._tick();                                  // → _lock（用固定随机数开 08）
restore();
check(inst._s.phase === 'drawing', '到时封盘，进入开奖');
check(inst._s.bankroll === 4825, '封盘先扣本金 175（5000 → 4825）');
inst._s.drawAt = Date.now() - 1;
inst._tick();                                  // → _settle
check(inst._s.phase === 'result', '开奖后进入结果展示');
check(inst._s.bankroll === 4825, '没中不返还，余额 4825');
check(inst._s.history.length === 1 && inst._s.history[0].hit === false, '写入 1 条未中记录');
check(inst._s.stats.curMiss === 1, '连不中 +1');
check(inst._s.history[0].n === 8, '开奖号码为 08');

console.log('\n[5] 空局不计入连不中');
inst._afterResult();                            // 进入下一期
check(inst._s.phase === 'betting' && inst._s.round === 2, '自动进入第 2 期');
restore = forceDraw(49);
inst._s.deadline = Date.now() - 1;
inst._tick();
restore();
inst._s.drawAt = Date.now() - 1;
inst._tick();
check(inst._s.stats.curMiss === 1, '没押注的空局不刷新连不中');
check(inst._s.history.length === 2 && inst._s.history[0].stake === 0, '空局也记录（stake 0）');

console.log('\n[6] 中奖返还 47 倍');
inst._afterResult();
pickZ(inst, 0);
pickN(inst, 7);
inst.onAmtInput({ detail: { value: '100' } });
inst.onStageAdd();
inst.onSubmitStage();
const before = inst._s.bankroll;
restore = forceDraw(7);
inst._s.deadline = Date.now() - 1;
inst._tick();
restore();
inst._s.drawAt = Date.now() - 1;
inst._tick();
check(inst._s.bankroll === before - 100 + 4700, '押 100 中 07，返还 4700（净 +4600）');
check(inst._s.stats.hits === 1 && inst._s.stats.curMiss === 0, '命中计数 +1，连不中断掉');
check(inst.data.resultClass === 'win' && inst.data.ballClass === 'win', '结果与开奖球进入中奖态');

console.log('\n[7] 开奖间隔');
inst._afterResult();
tap(inst, 'onPickInterval', { sec: 30 });
check(inst._s.interval === 30 && inst.data.interval === 30, '间隔切到 30 秒');
inst._s.deadline = Date.now() - 1;
inst._tick();       // 本局仍按旧间隔封盘
inst._s.drawAt = Date.now() - 1;
inst._tick();
inst._afterResult();
check(inst._s.roundMs === 30000, '下一期按 30 秒计时');
const left = inst._s.deadline - Date.now();
check(left > 29000 && left <= 30000, '倒计时约 30 秒', left);
check(inst.data.cdText === '30', '界面倒计时显示 30');
tap(inst, 'onPickInterval', { sec: 300 });
check(inst.data.cdText !== undefined, '5 分钟档位可选中');

console.log('\n[8] 补充筹码与净盈亏');
const bankBefore = inst._s.bankroll;
const inBefore = inst._s.totalIn;
inst.onTopupPick({ currentTarget: { dataset: { c: 2000 } } });
inst.onTopupOk();
check(inst._s.bankroll === bankBefore + 2000, '补充 2000 进入筹码');
check(inst._s.totalIn === inBefore + 2000, '补充额计入累计投入');
// 补充会同时加筹码和累计投入，净盈亏应保持不变并重新渲染
const netAfter = inst._s.bankroll - inst._s.totalIn;
const netText = (netAfter > 0 ? '+' : '') + String(Math.round(netAfter)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
check(inst.data.netText === netText, '净盈亏按余额与投入重算', { got: inst.data.netText, expect: netText });
check(inst.data.netClass === (netAfter > 0 ? 'green' : netAfter < 0 ? 'red' : ''), '净盈亏颜色跟随正负');

console.log('\n[9] 历史只留最近 100 期');
inst._s.history = [];
for (let i = 0; i < 150; i++) {
  inst._s.history.push({ r: 150 - i, n: 1, z: 0, stake: 10, ret: 0, hit: false, bk: 5000, dep: 5000 });
}
inst._save();
check(storage.yb_bet_v1.history.length === 100, '存档只写 100 条');
inst._s.history.length = 150;
inst._sync();
check(inst.data.history.length === 100, '界面只渲染 100 条');

const reloaded = makeInst();
comp.lifetimes.attached.call(reloaded);
check(reloaded._s.history.length === 100, '重新加载后仍是 100 条');

console.log('\n[10] 封盘后强杀进程，重进接着结算（不丢局、不能赖账）');
{
  const a = makeInst();
  comp.lifetimes.attached.call(a);
  a.onReset();                                  // 清掉 [9] 留下的存档
  tap(a, 'onStartPick', { c: 3000 });
  a.onStartGame();
  pickZ(a, 0);
  pickN(a, 7);
  a.onAmtInput({ detail: { value: '200' } });
  a.onStageAdd();
  a.onSubmitStage();
  check(a._s.bets.length === 1, '下注 1 注');

  let r = forceDraw(20);
  a._s.deadline = Date.now() - 1;
  a._tick();                                    // → _lock
  r();
  check(a._s.phase === 'drawing' && a._s.pending.n === 20, '封盘进入开奖');
  const snap = JSON.parse(JSON.stringify(storage.yb_bet_v1));
  check(snap.phase === 'drawing' && snap.pending && snap.pending.n === 20, '扣款与待开奖状态已落盘');
  check(snap.bankroll === 2800, '扣押本金后的余额已落盘（3000-200）');
  check(a.data.ballText === '??', '开奖阶段界面不泄露号码');

  // 模拟强杀：拿同一份存档重新加载一个实例
  const b = makeInst();
  comp.lifetimes.attached.call(b);
  check(b._s && b._s.phase === 'drawing' && b._s.pending.n === 20, '重进后恢复到开奖阶段');
  check(b._s.bankroll === 2800, '余额保持扣押后状态');
  b._activate();
  check(b.data.phaseLabel === '封盘开奖' && b.data.ballText === '??', '恢复到封盘开奖视图且不泄露号码');
  b._s.drawAt = Date.now() - 1;
  b._tick();                                    // → _settle
  check(b._s.phase === 'result' && b._s.history[0].n === 20, '恢复后完成结算');
  check(b._s.history[0].stake === 200 && b._s.history[0].hit === false, '这一局进了历史（押 200 未中）');
  check(b._s.bankroll === 2800 && b._s.stats.stake === 200, '余额与统计一致，无法靠杀进程取消亏损');
}

console.log('\n[11] 下注中强杀，重进接着倒计时');
{
  const a = makeInst();
  comp.lifetimes.attached.call(a);
  a.onReset();
  tap(a, 'onStartPick', { c: 2000 });
  a.onStartGame();
  a._s.deadline = Date.now() + 9999;            // 还剩 ~10 秒
  a._save();
  const b = makeInst();
  comp.lifetimes.attached.call(b);
  check(b._s.phase === 'betting' && b._s.deadline > Date.now() + 9000, '下注中恢复，倒计时继续');
  b._activate();
  check(b.data.phaseLabel === '下注中' && b.data.cdText === '10', '恢复下注中视图');
}

console.log('\n[12] 暂停补偿：切走顺延，新局不吃停留时间');
{
  const a = makeInst();
  comp.lifetimes.attached.call(a);
  a.onReset();
  tap(a, 'onStartPick', { c: 1000 });
  a.onStartGame();
  // 开局弹窗里停留 60 秒（真实场景是 _stopClock 记下的 _pausedAt）
  a._pausedAt = Date.now() - 60000;
  a._startRound();
  check(a._pausedAt === 0, '开新局会清掉暂停时间戳');
  const left = a._s.deadline - Date.now();
  check(left > 9000 && left <= 10000, '新局倒计时是完整的 10 秒', left);
  // 局中切走再回来：停留时间要顺延到 deadline（原有设计，防止回归）
  a._pausedAt = Date.now() - 60000;
  a._s.deadline = Date.now() + 10000;
  a._tick = function () {};                     // interval 回调在测试里空转
  comp.methods._startClock.call(a);             // 用真实的 _startClock 验证补偿
  clearInterval(a._ticker);
  a._ticker = null;
  const left2 = a._s.deadline - Date.now();
  check(left2 > 65000 && left2 <= 70000, '局中暂停 60 秒 → deadline 顺延 60 秒', left2);
}

console.log('\n[13] 余额 0 的存档重进 → 破产弹窗，不开 0 筹码空局');
{
  storage.yb_bet_v1 = {
    totalIn: 1000, bankroll: 0, round: 5, interval: 10,
    staging: [], history: [], lastBets: [], stats: {}
  };
  const a = makeInst();
  comp.lifetimes.attached.call(a);
  check(a._s && a._s.bankroll === 0 && a._s.round === 5, '载入 0 余额存档');
  a._activate();
  check(a.data.showRuin === true, '直接进破产弹窗');
  check(a._s.round === 5 && a._s.phase === 'idle', '没有开新局');
  a.onRuinTopup();
  check(a.data.showTopup === true && a.data.showRuin === false, '破产 → 补充筹码弹窗');
  a.onTopupClose();
  check(a.data.showRuin === true && a.data.showTopup === false, '「算了，不补了」回到破产弹窗，不再卡死');
}

console.log('\n[14] 损坏存档兜底');
{
  storage.yb_bet_v1 = { totalIn: 'abc', bankroll: 'x', round: 1, interval: 10 };
  const a = makeInst();
  comp.lifetimes.attached.call(a);
  check(!a._s, '余额不是数字 → 不载入存档');
  check(a.data.showStart === true, '回到开局弹窗');

  storage.yb_bet_v1 = {
    totalIn: 1000, bankroll: 1000, round: 3, interval: 10,
    staging: [], history: [{ r: 1, n: 99, stake: 1, ret: 0 }, { r: 2, n: 7, stake: 10, ret: 0 }],
    lastBets: [{ z: 0, n: 7, amount: 'x' }, { z: 0, n: 7, amount: 50 }],
    stats: { stake: NaN, ret: 0, rounds: 2 }
  };
  const b = makeInst();
  comp.lifetimes.attached.call(b);
  check(b._s.lastBets.length === 1 && b._s.lastBets[0].amount === 50, '脏 lastBets 被过滤');
  check(b._s.history.length === 1 && b._s.history[0].n === 7, '脏历史（号码越界）被过滤');
  check(b._s.stats.stake === 0, '非数值统计回退为 0');
  b._activate();
  b.onRepeatLast();
  check(b._s.bets.length === 1 && b._s.bets[0].amount === 50, '重复上局只加进干净的 50');
  check(b._s.bankroll === 1000, '余额没被污染');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exit(1);
console.log('✓ 号码下注组件逻辑测试全部通过');
