// 小笨生肖 · 迁移一致性测试
// 用「原网页 index.html 的算法」作为基准，逐生肖比对迁移到小程序后的输出是否完全一致。
// 运行： node tools/shengxiao_logic_test.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// 生肖栏目现为首页同页切换的自定义组件（主包），不再是分包页面
const TARGET_JS = path.join(ROOT, 'components/shengxiao/shengxiao.js');

/* ================= 基准：原网页 JS（逐行照抄） ================= */
const Z = [
  {n:'鼠',e:'🐭',z:'子',wx:'水'},{n:'牛',e:'🐮',z:'丑',wx:'土'},
  {n:'虎',e:'🐯',z:'寅',wx:'木'},{n:'兔',e:'🐰',z:'卯',wx:'木'},
  {n:'龙',e:'🐲',z:'辰',wx:'土'},{n:'蛇',e:'🐍',z:'巳',wx:'火'},
  {n:'马',e:'🐴',z:'午',wx:'火'},{n:'羊',e:'🐑',z:'未',wx:'土'},
  {n:'猴',e:'🐵',z:'申',wx:'金'},{n:'鸡',e:'🐔',z:'酉',wx:'金'},
  {n:'狗',e:'🐶',z:'戌',wx:'土'},{n:'猪',e:'🐷',z:'亥',wx:'水'},
];
const CHONG={0:6,6:0,1:7,7:1,2:8,8:2,3:9,9:3,4:10,10:4,5:11,11:5};
const LIUHE={0:1,1:0,2:11,11:2,3:10,10:3,4:9,9:4,5:8,8:5,6:7,7:6};
const SANHE=[[11,3,7],[2,6,10],[5,9,1],[8,0,4]];
const HAI={0:7,7:0,1:6,6:1,2:5,5:2,3:4,4:3,8:11,11:8,9:10,10:9};
const XING=[[2,5,8],[1,7,10],[0,3]];
const ZIXING=[4,6,9,11];
const PO={0:9,9:0,1:4,4:1,2:11,11:2,3:6,6:3,5:8,8:5,7:10,10:7};
const CHONG_DESC={
  '0-6':'子午冲：水克火，情绪与理智的冲突，易有变动、奔波。',
  '1-7':'丑未冲：土土相冲，观念与习惯的碰撞，易有财务、人际摩擦。',
  '2-8':'寅申冲：金克木，行动与思想的矛盾，易有出行、工作变动。',
  '3-9':'卯酉冲：金克木，人际与感情的冲突，易有口舌、是非。',
  '4-10':'辰戌冲：土土相冲，事业与家庭的矛盾，易有压力、争执。',
  '5-11':'巳亥冲：水克火，内心与外在的拉扯，易有健康、情绪问题。'};
const HAI_DESC={
  '0-7':'子未害：名利之害，易有财务纠纷。','1-6':'丑午害：官非之害，易有职场冲突。',
  '2-5':'寅巳害：口舌之害，易有意见不合。','3-4':'卯辰害：感情之害，易有沟通障碍。',
  '8-11':'申亥害：竞争之害，易有利益争夺。','9-10':'酉戌害：邻里之害，易有是非纷争。'};
const okey=(a,b)=>[Math.min(a,b),Math.max(a,b)].join('-');
const ofmt=i=>Z[i].e+' '+Z[i].n;
const STICKER_COUNT = 11;

// 返回原网页点击生肖 i 后的完整预期结果
function baseline(i) {
  const cls = new Array(12).fill('');
  cls[i] = 'sel';
  const heSet = new Set([LIUHE[i]]);
  SANHE.forEach(g => { if (g.includes(i)) g.forEach(x => x !== i && heSet.add(x)); });
  const chong = CHONG[i];
  heSet.delete(chong);
  const badSet = new Set([HAI[i], PO[i]]);
  XING.forEach(g => { if (g.includes(i)) g.forEach(x => x !== i && badSet.add(x)); });
  badSet.delete(chong); heSet.forEach(x => badSet.delete(x));

  heSet.forEach(x => cls[x] = 'he');
  cls[chong] = 'chong';
  badSet.forEach(x => cls[x] = 'bad');

  const z = Z[i];
  const sanheNames = [...heSet].filter(x => x !== LIUHE[i]).map(ofmt).join('、');
  const parts = [];
  badSet.forEach(x => {
    if (HAI[i] === x) parts.push(ofmt(x) + '（相害：' + (HAI_DESC[okey(i, x)] || '暗中损耗') + '）');
    else if (PO[i] === x) parts.push(ofmt(x) + '（相破：易有波折损耗）');
    else parts.push(ofmt(x) + '（相刑：易生是非纠纷）');
  });
  return {
    cls, chong, liuhe: LIUHE[i], sanheNames, badParts: parts.join('；'),
    zixing: ZIXING.includes(i) ? i : -1,
    title: `${z.e} ${z.n} 的相冲相配`,
    meta: `地支：${z.z} · 五行：${z.wx}`,
    chongDesc: CHONG_DESC[okey(i, chong)],
    heSet: [...heSet], badSet: [...badSet]
  };
}

/* ================= 被测：迁移后的小程序组件 ================= */
let pageCfg = null;
new Function('Page', 'Component', fs.readFileSync(TARGET_JS, 'utf8'))(
  (cfg) => { pageCfg = cfg; },
  (cfg) => { pageCfg = cfg; }
);
// 组件：lifetimes.attached + methods.onPick；页面：onLoad + onPick。两种写法都支持
const initFn = () => (pageCfg.lifetimes && pageCfg.lifetimes.attached) || pageCfg.onLoad;
const pickFn = () => (pageCfg.methods && pageCfg.methods.onPick) || pageCfg.onPick;

function runPage(i) {
  const ctx = {
    data: JSON.parse(JSON.stringify(pageCfg.data)),
    setData(patch) { Object.assign(this.data, patch); }
  };
  initFn().call(ctx);
  pickFn().call(ctx, { currentTarget: { dataset: { i } } });
  return ctx.data;
}

/* ================= 断言 ================= */
let pass = 0, fail = 0;
const problems = [];
function check(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++; problems.push(`${name}${detail ? ' → ' + detail : ''}`);
}

const CLS_MAP = { '': '', sel: 'sel', he: 'r-he', chong: 'r-chong', bad: 'r-bad' };

for (let i = 0; i < 12; i++) {
  const b = baseline(i);
  const d = runPage(i);
  const tag = `[${Z[i].e}${Z[i].n}]`;

  // 1. 按钮着色逐个比对（原网页靠 classList，迁移后靠 cls 字段）
  const gotCls = d.zodiacs.map(z => z.cls);
  const wantCls = b.cls.map(c => CLS_MAP[c]);
  check(`${tag} 生肖按钮着色`, JSON.stringify(gotCls) === JSON.stringify(wantCls),
    `got ${JSON.stringify(gotCls)} want ${JSON.stringify(wantCls)}`);

  // 2. 三个关系集合两两互斥（保证着色不会被后写的规则覆盖）
  const sets = [b.heSet, b.badSet, [b.chong]];
  let disjoint = true;
  for (let a = 0; a < sets.length; a++)
    for (let c = a + 1; c < sets.length; c++)
      if (sets[a].some(x => sets[c].includes(x))) disjoint = false;
  check(`${tag} 相配/相冲/刑害破 集合互斥`, disjoint);

  // 3. 结果面板标题与地支五行
  check(`${tag} 标题`, `${d.pickedEmoji} ${d.pickedName} 的相冲相配` === b.title,
    `${d.pickedEmoji} ${d.pickedName} 的相冲相配 vs ${b.title}`);
  check(`${tag} 地支五行`, `地支：${d.pickedZhi} · 五行：${d.pickedWx}` === b.meta);

  // 4. 相冲行
  check(`${tag} 相冲行`, d.rows[0].label === '相冲 · 六冲'
    && d.rows[0].cls === 'rl-chong'
    && d.rows[0].value === ofmt(b.chong)
    && d.rows[0].desc === b.chongDesc, JSON.stringify(d.rows[0]));

  // 5. 六合行
  check(`${tag} 六合行`, d.rows[1].label === '相配 · 六合'
    && d.rows[1].value === ofmt(b.liuhe) && d.rows[1].desc === '六合暗合，互为贵人，天生一对好拍档～');

  // 6. 三合行（永远存在，2 个）
  check(`${tag} 三合行`, d.rows[2].label === '相配 · 三合'
    && d.rows[2].value === b.sanheNames
    && d.rows[2].value.split('、').length === 2
    && b.sanheNames.split('、').length === 2, `${JSON.stringify(d.rows[2])} vs ${b.sanheNames}`);

  // 7. 刑害破行（原网页只有说明、没有加粗值）
  const badRow = d.rows.find(r => r.label === '刑 · 害 · 破');
  if (b.badParts) {
    check(`${tag} 刑害破行`, !!badRow && badRow.desc === b.badParts && badRow.cls === 'rl-bad' && badRow.value === '',
      `${badRow ? badRow.desc : '缺失'} vs ${b.badParts}`);
  } else {
    check(`${tag} 刑害破行(应为空)`, !badRow);
  }

  // 8. 自刑行
  const zxRow = d.rows.find(r => r.label === '自刑');
  check(`${tag} 自刑行`, b.zixing >= 0
    ? (!!zxRow && zxRow.desc === Z[i].n + ' 带自刑，容易想太多、内耗自己，记得放过自己鸭。')
    : !zxRow);

  // 9. 结果面板显示开关 + 贴纸来自贴纸池
  check(`${tag} 结果面板开启`, d.hasResult === true);
  check(`${tag} 贴纸来自素材池`, /\/assets\/(shengxiao\/)?\w+\.gif$/.test(d.sticker));
}

// 贴纸随机不重复（连续 200 次不应出现相邻相同）
{
  const ctx = { data: JSON.parse(JSON.stringify(pageCfg.data)), setData(p) { Object.assign(this.data, p); } };
  initFn().call(ctx);
  let last = null, same = 0;
  for (let k = 0; k < 200; k++) {
    pickFn().call(ctx, { currentTarget: { dataset: { i: k % 12 } } });
    if (ctx.data.sticker === last) same++;
    last = ctx.data.sticker;
  }
  check('贴纸连续不重复', same === 0, `相邻重复 ${same} 次`);
}

// 贴纸池：迁移后用到的贴纸总数应与原网页 STICKERS 一致（11 张）
{
  const src = fs.readFileSync(TARGET_JS, 'utf8');
  const seg = src.slice(src.indexOf('const STICKERS'), src.indexOf('const pairKey'));
  const n = (seg.match(/'(\d{4})'/g) || []).length + (seg.match(/'(\/assets\/[^']+\.gif)'/g) || []).length;
  check('贴纸池数量与原网页一致', n === STICKER_COUNT, `迁移后 ${n} 张，原网页 ${STICKER_COUNT} 张`);
}

// 越界入参保护
{
  const ctx = { data: JSON.parse(JSON.stringify(pageCfg.data)), setData(p) { Object.assign(this.data, p); } };
  initFn().call(ctx);
  const before = JSON.stringify(ctx.data);
  pickFn().call(ctx, { currentTarget: { dataset: { i: 99 } } });
  pickFn().call(ctx, { currentTarget: { dataset: { i: 'x' } } });
  check('非法入参不改变状态', before === JSON.stringify(ctx.data));
}

/* ================= 素材引用检查 ================= */
{
  const src = fs.readFileSync(TARGET_JS, 'utf8');
  // 字面路径 + IMG('0000') 形式拼出的路径，统一收齐后逐个校验文件是否存在
  const literal = [...new Set([...src.matchAll(/'(\/assets\/[^']+\.gif)'/g)].map(m => m[1]))];
  const codes = [...new Set([...src.matchAll(/'(\d{4})'/g)].map(m => m[1]))];
  const all = [...new Set(literal.concat(codes.map(c => `/assets/shengxiao/yierbubu_nobg_${c}.gif`)))];
  // 11 张贴纸 + 提示图 + 空状态图 + 页脚图 = 14 张，与原网页一致
  check('引用的素材总数与原网页一致', all.length === 14, `实际 ${all.length}: ${all.join(',')}`);
  all.forEach(p => check(`素材存在 ${p}`, fs.existsSync(path.join(ROOT, p))));
}

/* ================= 结果 ================= */
console.log(`\n小笨生肖迁移一致性测试：通过 ${pass} 项，失败 ${fail} 项\n`);
if (fail) {
  problems.forEach(p => console.log('  ✗ ' + p));
  process.exit(1);
}
console.log('  ✓ 与原网页的算法输出完全一致（12 生肖全覆盖）');
