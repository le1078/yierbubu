// 云端共享存储：单文档模式，所有用户可读可写
// 集合需在云开发后台手动创建：yb_shared
// 文档 _id 固定，首次使用自动创建
//
// 并发安全设计：
//   1. 写入串行队列 —— 同一进程内的写操作排队执行，避免同页并发互相覆盖
//   2. _rev 版本号 CAS —— 写入前校验版本，版本不符则重读重试（最多 MAX_RETRY 次）
//   3. 批量 API —— 一次操作完成「过滤列表 + 批量入回收站」，避免逐条全量读写

const COLLECTION = 'yb_shared';
const DOC_CALENDAR = 'shared_calendar';  // { memo: {}, buy: {} }
const DOC_RECORDS = 'shared_records';    // { list: [] }
const DOC_ORDERS = 'shared_orders';      // { list: [] } 餐厅订单
const DOC_MENU = 'shared_menu';          // { list: [] } 餐厅菜单
const DOC_SHOPPING = 'shared_shopping';  // { list: [] } 购物记录（小笨生活）
const DOC_TRASH = 'shared_trash';        // { list: [] } 回收站

const MAX_RETRY = 3;   // CAS 冲突重试次数

function db() { return wx.cloud.database(); }

// 注意：不能写成 const _ = db.command;
// db.command 在模块加载时求值，而那时 wx.cloud 可能还没 init 完，
// 取到的是 undefined，后续 _.lte() / _.gte() 会抛
// 「Cannot read properties of undefined (reading 'lte')」，所有云端写入全挂。
// 所以做成 getter，每次用时才取。
function cmd() { return db().command; }

/* ===== 写入串行队列 ===== */
// 保证同一时刻只有一个写操作在执行，避免「读-改-写」交错
let _writeChain = Promise.resolve();
function enqueue(fn) {
  const run = _writeChain.then(fn, fn);   // 前一个失败也不阻塞后续
  _writeChain = run.catch(() => {});
  return run;
}

/* ===== 基础读写 ===== */

// 读取文档（不存在返回 null）。区分「文档不存在」与「网络/权限失败」：
// 返回 { ok: true, data } 或 { ok: false, error }
async function getDoc(docId) {
  try {
    const res = await db().collection(COLLECTION).doc(docId).get();
    return { ok: true, data: res.data || null };
  } catch (e) {
    // 云开发文档不存在时报错，errCode 为 DATABASE_NULL_DATA / -502005 等
    const notExist = /not exist|不存在|DATABASE_NULL_DATA|-502005/i.test(String(e && (e.errCode || e.message || e)));
    if (notExist) return { ok: true, data: null };
    return { ok: false, error: e };
  }
}

// 去掉云数据库保留字段
function strip(doc) {
  if (!doc) return doc;
  delete doc._id;
  delete doc._openid;
  return doc;
}

// 原子更新：先拉最新 → mergeFn 修改 → 带版本号写回，冲突自动重试
// mergeFn(doc) 就地修改 doc；返回最终 doc
//
// 关于并发（重要，别误解）：
//   · 同进程内：enqueue 把写操作串成一条链，读-改-写不会交错 —— 这部分是
//     真实生效的，页面里连点/并发调用都安全。
//   · 跨设备：下面的 condition 字段依赖云 SDK 支持条件更新。微信小程序
//     客户端 SDK 的 doc().update() 并不保证支持 condition；若运行时不支持，
//     该参数被忽略，退化为「后写覆盖先写」（last-write-wins）。
//     对这个双人私用的小程序可以接受（两人极少同时编辑同一份数据），
//     但不能宣称具备强并发保护。真要严格一致需改用云函数/数据库事务。
async function mutateDoc(docId, mergeFn) {
  return enqueue(async () => {
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      const r = await getDoc(docId);
      if (!r.ok) throw r.error;              // 网络/权限失败，直接抛出让调用方感知
      const doc = r.data ? Object.assign({}, r.data) : {};
      const rev = doc._rev || 0;
      mergeFn(doc);
      strip(doc);
      doc._rev = rev + 1;

      const cond = rev === 0
        ? { _rev: cmd().lte(0) }              // 首次创建：确保没有别人抢先建
        : { _rev: rev };                     // 后续更新：版本必须匹配

      try {
        const res = await db().collection(COLLECTION).doc(docId).update({
          data: doc,
          condition: cond
        });
        // 云数据库的 doc().update() 不会创建文档：文档不存在时 updated 为 0
        // （或抛 notExist）。首次写入必须用 set() 显式创建，否则会「提示保存成功
        // 但云端没有数据」——早期版本有 add 兜底，重构时丢了，这里补回来。
        if (rev === 0 && res && res.stats && res.stats.updated === 0) {
          await db().collection(COLLECTION).doc(docId).set({ data: doc });
        }
        return doc;
      } catch (e) {
        // errCode 与 message 拼在一起判：有的错误只带其中一个，
        // 短路写法会漏掉另一半，把可重试的冲突当成致命错误抛给用户
        const errText = String((e && e.errCode) || '') + ' ' +
                        String((e && e.message) || '') + ' ' +
                        String((e && e.errMsg) || '');
        const conflict = /condition|version|conflict|冲突/i.test(errText);
        const notExist = /-502005|DATABASE_NULL_DATA|not exist|不存在/i.test(errText);
        // 首次创建遇到「文档不存在」：直接 set 建文档（update 永远建不出来）
        if (rev === 0 && notExist) {
          await db().collection(COLLECTION).doc(docId).set({ data: doc });
          return doc;
        }
        // 版本/条件冲突（他人已写入），或创建竞争（文档被抢先建）→ 重读重试；
        // 权限/配额等其它错误直接抛出，别白烧 4 次往返
        if (attempt < MAX_RETRY && (conflict || notExist)) {
          continue;
        }
        throw e;
      }
    }
    throw new Error('mutateDoc: 并发冲突重试次数用尽');
  });
}

// 生成回收站条目 id（单调递增 + 随机后缀，避免批量时撞号）
let _trashSeq = 0;
function newTrashId() {
  _trashSeq += 1;
  return Date.now().toString(36) + '_' + _trashSeq + '_' + Math.random().toString(36).slice(2, 6);
}

/* ===== 日历 ===== */

async function loadCalendar() {
  const r = await getDoc(DOC_CALENDAR);
  if (!r.ok) throw r.error;
  const doc = r.data;
  return {
    memo: (doc && doc.memo) || {},
    buy: (doc && doc.buy) || {}
  };
}

async function saveCalendarMemo(memoObj) {
  return mutateDoc(DOC_CALENDAR, (doc) => { doc.memo = memoObj; });
}

// 按天写备忘：只改 doc.memo[ds]，不整份覆盖。
// 两个人同一天用两台设备记不同的日子时，整份覆盖会互相抹掉对方的那天。
async function saveCalendarMemoDay(ds, rec) {
  if (!ds) return null;
  return mutateDoc(DOC_CALENDAR, (doc) => {
    const memo = Object.assign({}, doc.memo || {});
    if (rec) memo[ds] = rec;
    else delete memo[ds];
    doc.memo = memo;
  });
}

// 按天写买码记录（同上，只动自己那一天）
async function saveCalendarBuyDay(ds, rec) {
  if (!ds) return null;
  return mutateDoc(DOC_CALENDAR, (doc) => {
    const buy = Object.assign({}, doc.buy || {});
    if (rec) buy[ds] = rec;
    else delete buy[ds];
    doc.buy = buy;
  });
}

async function saveCalendarBuy(buyObj) {
  return mutateDoc(DOC_CALENDAR, (doc) => { doc.buy = buyObj; });
}

/* ===== 回收站 ===== */

async function loadTrash() {
  const r = await getDoc(DOC_TRASH);
  if (!r.ok) throw r.error;
  return (r.data && r.data.list) || [];
}

async function saveTrash(list) {
  return mutateDoc(DOC_TRASH, (doc) => { doc.list = list; });
}

// 从回收站移除（彻底删除）
async function removeTrashItem(trashId) {
  return mutateDoc(DOC_TRASH, (doc) => {
    doc.list = (doc.list || []).filter(it => String(it.id) !== String(trashId));
  });
}

// 清空回收站：只动回收站这一份文档，避免调用方拿旧快照整份覆盖。
async function clearTrash() {
  return mutateDoc(DOC_TRASH, (doc) => { doc.list = []; });
}

// 从回收站取回一条：回填到原始列表头部，并从回收站移除。
//
// 顺序很关键：先「原子地」从回收站移除（同一个 mutateDoc 里查找+删除），
// 成功后再插回目标列表。原来先插列表再删回收站，连点两下「恢复」会让
// 两次调用都读到同一条 → 目标列表里出现两条重复记录。
// 插回失败则把条目塞回回收站，避免「从回收站删掉了却没回到列表」的丢数据。
async function restoreTrashItem(trashId) {
  let removed = null;
  await mutateDoc(DOC_TRASH, (doc) => {
    const list = doc.list || [];
    const idx = list.findIndex(it => String(it.id) === String(trashId));
    if (idx === -1) return;
    removed = list[idx];
    doc.list = list.filter((_, i) => i !== idx);
  });
  if (!removed) return null;   // 已被别的调用取走（连点/多端）——直接忽略

  const data = Object.assign({}, removed.data);
  delete data._restoredAt;
  const docId = removed.type === 'order' ? DOC_ORDERS
    : removed.type === 'shopping' ? DOC_SHOPPING
    : DOC_RECORDS;
  try {
    await mutateDoc(docId, (doc) => {
      const list = (doc.list || []).slice();
      list.unshift(data);
      doc.list = list;
    });
  } catch (e) {
    // 插回失败：把条目放回回收站，保证「要么恢复成功、要么还在回收站」
    try {
      await mutateDoc(DOC_TRASH, (doc) => {
        doc.list = [removed].concat(doc.list || []);
      });
    } catch (e2) { /* 兜底也失败：只能上抛原始错误 */ }
    throw e;
  }
  return removed;
}

/* ===== 记录 ===== */

async function loadRecords() {
  const r = await getDoc(DOC_RECORDS);
  if (!r.ok) throw r.error;
  return (r.data && r.data.list) || [];
}

async function saveRecords(list) {
  return mutateDoc(DOC_RECORDS, (doc) => { doc.list = list; });
}

// 原子追加一条抽取记录。
// 不要在页面里「读全表 → unshift → 整表写回」：另一个设备同时抽奖时，
// 双方读到同一份旧表，后写的会把对方那条记录覆盖掉（丢记录）。
async function pushRecordSafe(item, cap) {
  const limit = cap || 200;
  return mutateDoc(DOC_RECORDS, (doc) => {
    doc.list = [item].concat(doc.list || []).slice(0, limit);
  });
}

// 原子删除一条抽取记录（按 id 过滤，同样避免整表覆盖竞态）
async function removeRecordById(id) {
  return mutateDoc(DOC_RECORDS, (doc) => {
    doc.list = (doc.list || []).filter(r => String(r.id) !== String(id));
  });
}

// 软删除单条抽取记录 → 进回收站
async function trashRecordById(id) {
  const list = await loadRecords();
  const rec = list.find(r => String(r.id) === String(id));
  if (!rec) return;
  await softRemove(DOC_RECORDS, id, { type: 'record', data: rec });
}

/* ===== 餐厅订单 ===== */

async function loadOrders() {
  const r = await getDoc(DOC_ORDERS);
  if (!r.ok) throw r.error;
  return (r.data && r.data.list) || [];
}

async function saveOrders(list) {
  return mutateDoc(DOC_ORDERS, (doc) => { doc.list = list; });
}

// 原子追加订单（避免 load→unshift→save 的竞态）
async function pushOrder(order) {
  return mutateDoc(DOC_ORDERS, (doc) => {
    const list = (doc.list || []).slice();
    list.unshift(order);
    doc.list = list.slice(0, 100);
  });
}

// 软删除单条吃饭记录 → 进回收站
async function trashOrderById(id) {
  const list = await loadOrders();
  const order = list.find(o => String(o.id) === String(id));
  if (!order) return;
  await softRemove(DOC_ORDERS, id, { type: 'order', data: order });
}

/* ===== 餐厅菜单 ===== */

async function loadMenu() {
  const r = await getDoc(DOC_MENU);
  if (!r.ok) throw r.error;
  return (r.data && r.data.list) || null;
}

async function saveMenu(list) {
  return mutateDoc(DOC_MENU, (doc) => { doc.list = list; });
}

/* ===== 小笨生活 · 购物记录 ===== */

async function loadShopping() {
  const r = await getDoc(DOC_SHOPPING);
  if (!r.ok) throw r.error;
  return (r.data && r.data.list) || [];
}

async function saveShopping(list) {
  // 按 id 合并而不是整份替换：另一台设备刚新增的记录不会被这份旧快照覆盖掉。
  // 删除不靠「列表里少了某条」表达，而是走 trashShoppingById / softRemove。
  const local = Array.isArray(list) ? list : [];
  return mutateDoc(DOC_SHOPPING, (doc) => {
    const localIds = new Set(local.map(it => String(it && it.id)));
    const remoteOnly = (Array.isArray(doc.list) ? doc.list : [])
      .filter(it => it && !localIds.has(String(it.id)));
    doc.list = local.concat(remoteOnly);
  });
}

// 软删除单条购物记录 → 进回收站（type: 'shopping'）
// 支持传入整条记录：本地已删时云端查不到也能入回收站
// 顺序：先写回收站，再从清单移除 —— 任一步失败都不会出现「清单删了、回收站没有」。
async function trashShoppingById(id, record) {
  const list = await loadShopping();
  const idx = list.findIndex(r => String(r.id) === String(id));
  const rec = idx !== -1 ? list[idx] : record;
  if (!rec) return;

  const entry = Object.assign({ id: newTrashId(), deletedAt: Date.now() },
    { type: 'shopping', data: rec });
  await mutateDoc(DOC_TRASH, (doc) => {
    doc.list = [entry].concat(doc.list || []);
  });
  if (idx === -1) return;

  try {
    await mutateDoc(DOC_SHOPPING, (doc) => {
      doc.list = (doc.list || []).filter(it => String(it.id) !== String(id));
    });
  } catch (e) {
    // 清单没删掉 → 把刚写进回收站的条目摘掉，避免同一条记录两处都有
    try {
      await mutateDoc(DOC_TRASH, (doc) => {
        doc.list = (doc.list || []).filter(it => String(it.id) !== String(entry.id));
      });
    } catch (e2) { /* 兜底也失败：宁可在回收站多一条，也不能丢数据 */ }
    throw e;
  }
}

/* ===== 批量操作 ===== */

// 软删除：从 list 里取出该条，连同来源类型一起压入回收站
// 同样是「先入回收站，再删源列表」，失败会摘掉刚写的回收站条目。
async function softRemove(docId, id, trashItem) {
  const entry = Object.assign({ id: newTrashId(), deletedAt: Date.now() }, trashItem);
  await mutateDoc(DOC_TRASH, (doc) => {
    doc.list = [entry].concat(doc.list || []);
  });
  try {
    await mutateDoc(docId, (doc) => {
      doc.list = (doc.list || []).filter(it => String(it.id) !== String(id));
    });
  } catch (e) {
    try {
      await mutateDoc(DOC_TRASH, (doc) => {
        doc.list = (doc.list || []).filter(it => String(it.id) !== String(entry.id));
      });
    } catch (e2) { /* 兜底失败：多一条回收站记录，不丢数据 */ }
    throw e;
  }
}

// 批量软删除：一次操作完成「批量入回收站 + 从源列表移除」
// items: [{ id, type, data }] —— type 为 'record' | 'order' | 'shopping'
// 返回实际删除的条数
async function batchSoftRemove(docId, items) {
  if (!items || !items.length) return 0;

  // 先确认哪些记录还在源列表里：过期快照里的 id 不能重复入回收站
  const r = await getDoc(docId);
  if (!r.ok) throw r.error;
  const srcList = Array.isArray(r.data && r.data.list) ? r.data.list : [];
  const ids = new Set(srcList.map(it => String(it && it.id)));
  const actual = items.filter(it => it && ids.has(String(it.id)));
  if (!actual.length) return 0;

  const now = Date.now();
  const entries = actual.map((it, i) => Object.assign({
    id: newTrashId(),
    deletedAt: now + i
  }, { type: it.type, data: it.data }));

  // 1) 先入回收站：失败的话源列表还没动，用户重试即可
  await mutateDoc(DOC_TRASH, (doc) => {
    doc.list = entries.concat(doc.list || []);
  });

  // 2) 再从源列表移除：失败就把刚写的条目摘掉，宁可留在列表里也不丢
  const removeIds = new Set(actual.map(it => String(it.id)));
  try {
    await mutateDoc(docId, (doc) => {
      doc.list = (doc.list || []).filter(it => !removeIds.has(String(it.id)));
    });
  } catch (e) {
    const entryIds = new Set(entries.map(it => String(it.id)));
    try {
      await mutateDoc(DOC_TRASH, (doc) => {
        doc.list = (doc.list || []).filter(it => !entryIds.has(String(it.id)));
      });
    } catch (e2) { /* 兜底失败：多一条回收站记录，不丢数据 */ }
    throw e;
  }

  return actual.length;
}

module.exports = {
  loadCalendar,
  saveCalendarMemo,
  saveCalendarBuy,
  saveCalendarMemoDay,
  saveCalendarBuyDay,
  loadRecords,
  saveRecords,
  pushRecordSafe,
  removeRecordById,
  trashRecordById,
  loadOrders,
  saveOrders,
  pushOrder,
  trashOrderById,
  loadTrash,
  saveTrash,
  removeTrashItem,
  clearTrash,
  restoreTrashItem,
  loadMenu,
  saveMenu,
  loadShopping,
  saveShopping,
  trashShoppingById,
  batchSoftRemove,
  newTrashId
};
