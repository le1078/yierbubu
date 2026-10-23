// cloudstore 自测：验证在「wx.cloud 尚未 init」的时序下也能正常工作。
//
// 背景：曾经把 db.command 写成模块级 const _ = db.command，在模块加载时就求值。
// 而 utils/cloudstore.js 是被各个页面 require 的，页面加载时 wx.cloud.init 可能
// 还没执行完，取到的 db 没有 command 属性 → _ 是 undefined →
//   TypeError: Cannot read properties of undefined (reading 'lte')
// 所有云端写入（下单、摇一摇记录、备忘保存）全部失败。
//
// Node 的单元测试如果预先 mock 好了 wx.cloud.database() 就发现不了，
// 必须像下面这样：先加载 cloudstore，再让 wx.cloud 变得可用。
//
// 用法：node tools/cloudstore_load_test.js

const path = require('path');
const ROOT = path.join(__dirname, '..');

let failures = 0;
function ok(cond, label, extra) {
  if (cond) console.log('  ✓ ' + label);
  else { failures++; console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}

/* ---------- 分阶段的 wx mock ---------- */

// 阶段 1：wx.cloud 存在，但 database() 返回的对象还没有 command
// （模拟页面加载早于 wx.cloud.init 完成的时序）
let phase = 'beforeInit';
const calls = [];
global.wx = {
  cloud: {
    init() { phase = 'ready'; },
    database() {
      if (phase !== 'ready') {
        // 未 init：返回一个没有 command 的对象（真实 SDK 的行为）
        return {
          collection() { throw new Error('wx.cloud 未初始化'); },
          command: undefined
        };
      }
      return makeDb();
    }
  }
};

function makeDb() {
  const command = {
    lte: (v) => ({ op: 'lte', v }),
    gte: (v) => ({ op: 'gte', v }),
    neq: (v) => ({ op: 'neq', v })
  };
  return {
    command,
    serverDate: () => 'SERVER_DATE',
    collection(name) {
      return {
        doc(id) {
          return {
            async get() {
              calls.push(['get', name, id]);
              if (store[id]) return { data: clone(store[id]) };
              const e = new Error('document not exists');
              e.errCode = 'DATABASE_NULL_DATA';
              throw e;
            },
            async update({ data, condition }) {
              calls.push(['update', name, id]);
              const cur = store[id];
              // 校验 condition（_rev 乐观锁）
              if (condition && condition._rev && condition._rev.op === 'lte') {
                if (cur && (cur._rev || 0) > condition._rev.v) {
                  const e = new Error('condition failed');
                  e.errCode = 'DATABASE_PERMISSION_DENIED';
                  throw e;
                }
              } else if (condition && typeof condition._rev === 'number') {
                if (!cur || (cur._rev || 0) !== condition._rev) {
                  const e = new Error('condition failed');
                  e.errCode = 'DATABASE_PERMISSION_DENIED';
                  throw e;
                }
              }
              store[id] = clone(data);
              return { stats: { updated: 1 } };
            }
          };
        },
        async add({ data }) { calls.push(['add', name]); store[data._id] = clone(data); return { _id: data._id }; }
      };
    }
  };
}

const store = {};
function clone(o) { return JSON.parse(JSON.stringify(o)); }

console.log('\n▶ cloudstore 加载时序测试');

// 阶段 2：在 wx.cloud 还没 init 时就加载 cloudstore（模块级代码此时执行）
const cloud = require(path.join(ROOT, 'utils/cloudstore.js'));
ok(true, '模块加载时 wx.cloud 未 init 也不抛错（模块级不能访问 db.command）');

// 阶段 3：init 之后正常写入
wx.cloud.init();
ok(phase === 'ready', 'wx.cloud.init 已执行');

(async () => {
  try {
    await cloud.saveRecords([{ id: 'r1', name: '测试' }]);
    ok(store['shared_records'] && store['shared_records'].list.length === 1,
      'init 后写入正常', store['shared_records']);
    ok(store['shared_records']._rev === 1, '版本号从 0 递增到 1', store['shared_records']._rev);

    await cloud.saveRecords([{ id: 'r1' }, { id: 'r2' }]);
    ok(store['shared_records']._rev === 2, '第二次写入版本号递增到 2', store['shared_records']._rev);

    const loaded = await cloud.loadRecords();
    ok(loaded.length === 2, '能读回刚写入的数据', loaded.length);

    // 批量软删除
    await cloud.batchSoftRemove('shared_records', [{ id: 'r1', type: 'record', data: { id: 'r1' } }]);
    const afterBatch = await cloud.loadRecords();
    ok(afterBatch.length === 1, 'batchSoftRemove 移除了一条', afterBatch.length);
    const trash = await cloud.loadTrash();
    ok(trash.length === 1 && trash[0].type === 'record', '该条进了回收站', trash[0]);
    ok(trash[0].id && trash[0].id.indexOf('_') !== -1, '回收站 id 带随机后缀（批量不撞号）', trash[0].id);

    // pushOrder 原子追加
    await cloud.pushOrder({ id: 'o1', total: '10.00' });
    const orders = await cloud.loadOrders();
    ok(orders.length === 1 && orders[0].id === 'o1', 'pushOrder 原子追加订单', orders.length);

    // 乐观锁：版本不匹配时重读重试，最终成功
    store['shared_records']._rev = 99;   // 模拟他人已写入
    await cloud.saveRecords([{ id: 'x' }]);
    ok(store['shared_records']._rev === 100, '版本冲突时自动重读重试', store['shared_records']._rev);
  } catch (e) {
    failures++;
    console.log('  ✗ 执行过程抛错: ' + (e && e.message));
    console.log(e && e.stack);
  }

  console.log(failures ? `\n共 ${failures} 项失败` : '\n全部通过 ✓');
  process.exit(failures ? 1 : 0);
})();
