// cloudstore 混沌测试：随机顺序地做「删除 / 恢复 / 彻底删除 / 批量删除」，
// 验证数据不变量始终成立：
//   1) 每条记录要么在源列表、要么在回收站，不能两边都有，也不能凭空消失
//   2) 回收站不超过 100 条
//   3) 同一 id 不出现重复条目
//   4) 任何一步都不能抛异常
//
// 这能抓出「先插后删」这类两步操作在并发/乱序下的原子性问题。
//
// 用法：node tools/cloudstore_chaos_test.js [步数]

const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function check(cond, name) {
  if (cond) { pass++; return true; }
  fail++;
  failures.push(name);
  if (failures.length <= 15) console.log('  ❌ ' + name);
  return false;
}

const STEPS = Number(process.argv[2] || 200);

/* ========== 内存云数据库（支持 condition / push） ========== */
const DOCS = {};
function clone(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }
const command = {
  lte: (v) => ({ __op: 'lte', v: v }),
  push: (v) => ({ __op: 'push', v: v })
};
function matchCondition(doc, cond) {
  if (!cond) return true;
  for (const k of Object.keys(cond)) {
    const c = cond[k];
    if (c && c.__op === 'lte') { if (!(Number(doc[k] || 0) <= c.v)) return false; }
    else if (doc[k] !== c) return false;
  }
  return true;
}

global.wx = {
  showToast: function () {},
  cloud: {
    database: function () {
      return {
        command: command,
        serverDate: function () { return new Date(); },
        collection: function () {
          return {
            doc: function (id) {
              return {
                get: async function () {
                  if (!DOCS[id]) { const e = new Error('no doc'); e.errCode = -502005; throw e; }
                  return { data: clone(DOCS[id]) };
                },
                update: async function (o) {
                  if (!DOCS[id]) { DOCS[id] = clone(o.data || {}); return { stats: { updated: 1 } }; }
                  if (!matchCondition(DOCS[id], o.condition)) {
                    const e = new Error('condition not match'); e.errCode = -502001; throw e;
                  }
                  for (const k of Object.keys(o.data || {})) {
                    const v = o.data[k];
                    if (v && v.__op === 'push') {
                      if (!Array.isArray(DOCS[id][k])) DOCS[id][k] = [];
                      DOCS[id][k].push(v.v);
                    } else DOCS[id][k] = clone(v);
                  }
                  return { stats: { updated: 1 } };
                },
                set: async function (o) { DOCS[id] = clone(o.data || {}); return {}; }
              };
            }
          };
        }
      };
    }
  }
};

const origError = console.error;
console.error = function () {};

const cloud = require(path.join(__dirname, '..', 'utils/cloudstore.js'));

function makeRng(seed) {
  let s = seed >>> 0;
  return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

(async () => {
  const rng = makeRng(20261025);

  // 初始 30 条购物记录
  let seq = 0;
  const seedItems = [];
  for (let i = 0; i < 30; i++) seedItems.push({ id: 'i' + (seq++), title: '物品' + i, price: 10 + i });
  DOCS.shared_shopping = { _rev: 1, list: seedItems };
  DOCS.shared_trash = { _rev: 1, list: [] };

  const everExisted = new Set(seedItems.map((x) => x.id));
  let ops = 0, ghostLoss = 0, duplicates = 0, bothPlaces = 0, trashOverflow = 0, threw = 0;

  function audit(tag) {
    const shop = (DOCS.shared_shopping || {}).list || [];
    const trash = (DOCS.shared_trash || {}).list || [];
    if (trash.length > 100) trashOverflow++;
    const seen = {};
    for (const it of shop) {
      if (seen[it.id]) duplicates++;
      seen[it.id] = 'shop';
    }
    for (const t of trash) {
      const id = t && t.data && t.data.id;
      if (!id) continue;
      if (seen[id] === 'shop') bothPlaces++;
      if (seen[id]) duplicates++;
      seen[id] = 'trash';
    }
    // 不能凭空消失（除非被彻底删除 —— 那种情况从 everExisted 里移除）
    for (const it of shop) if (!everExisted.has(it.id)) ghostLoss++;
  }

  for (let step = 0; step < STEPS; step++) {
    const shop = (DOCS.shared_shopping || {}).list || [];
    const trash = (DOCS.shared_trash || {}).list || [];
    const roll = rng();

    try {
      if (roll < 0.35 && shop.length) {
        // 删除一条（进回收站）
        const victim = shop[Math.floor(rng() * shop.length)];
        await cloud.trashShoppingById(victim.id);
        ops++;
      } else if (roll < 0.6 && trash.length) {
        // 从回收站恢复
        const t = trash[Math.floor(rng() * trash.length)];
        await cloud.restoreTrashItem(t.id);
        ops++;
      } else if (roll < 0.75 && trash.length) {
        // 彻底删除
        const t = trash[Math.floor(rng() * trash.length)];
        const goneId = t && t.data && t.data.id;
        await cloud.removeTrashItem(t.id);
        if (goneId) everExisted.delete(goneId);
        ops++;
      } else if (roll < 0.85 && shop.length >= 2) {
        // 批量软删除
        const n = 1 + Math.floor(rng() * Math.min(3, shop.length));
        const picks = [];
        for (let i = 0; i < n; i++) {
          const it = shop[Math.floor(rng() * shop.length)];
          if (picks.every((p) => p.id !== it.id)) picks.push({ id: it.id, type: 'shopping', data: it });
        }
        if (picks.length) { await cloud.batchSoftRemove('shared_shopping', picks); ops++; }
      } else if (roll < 0.95) {
        // 新增一条（走保存整表：模拟页面层行为）
        const item = { id: 'i' + (seq++), title: '新增' + seq, price: 20 };
        everExisted.add(item.id);
        await cloud.saveShopping([item].concat(shop));
        ops++;
      } else {
        // 重复恢复同一条（模拟连点）
        if (trash.length) {
          const t = trash[0];
          await Promise.all([
            cloud.restoreTrashItem(t.id),
            cloud.restoreTrashItem(t.id)
          ]);
          ops++;
        }
      }
    } catch (e) {
      threw++;
      if (threw <= 3) console.log('  ❌ 第 ' + step + ' 步抛异常: ' + e.message);
    }
    audit('step' + step);
  }

  const finalShop = (DOCS.shared_shopping || {}).list || [];
  const finalTrash = (DOCS.shared_trash || {}).list || [];
  console.log('  执行 ' + ops + ' 次操作后：购物 ' + finalShop.length + ' 条，回收站 ' + finalTrash.length + ' 条');

  check(threw === 0, '随机操作全程无异常（异常 ' + threw + ' 次）');
  check(trashOverflow === 0, '回收站始终不超过 100 条');
  check(duplicates === 0, '没有重复 id 条目');
  check(bothPlaces === 0, '同一条记录不会同时存在于两处（' + bothPlaces + ' 次）');
  check(ghostLoss === 0, '没有凭空丢失的记录（' + ghostLoss + ' 次）');
  // 总量守恒：现存 + 回收站 == 曾经存在的（减去被彻底删除的）
  const alive = new Set();
  for (const it of finalShop) alive.add(it.id);
  for (const t of finalTrash) if (t && t.data && t.data.id) alive.add(t.data.id);
  let missing = 0;
  for (const id of everExisted) if (!alive.has(id)) missing++;
  check(missing === 0, '所有未被彻底删除的记录都还在（缺 ' + missing + ' 条）');

  console.error = origError;
  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail > 0) {
    console.log('❌ 数据层混沌测试未通过');
    process.exit(1);
  }
  console.log('✓ 数据层混沌测试全部通过');
  process.exit(0);
})();
