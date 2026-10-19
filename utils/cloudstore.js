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
const _ = db.command;

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
        ? { _rev: _.lte(0) }                 // 首次创建：确保没有别人抢先建
        : { _rev: rev };                     // 后续更新：版本必须匹配

      try {
        await db().collection(COLLECTION).doc(docId).update({
          data: doc,
          condition: cond
        });
        return doc;
      } catch (e) {
        // 版本冲突（他人已写入）→ 重读重试；其它错误抛出
        if (attempt < MAX_RETRY && /condition|version|冲突/i.test(String(e && (e.errCode || e.message || e)))) {
          continue;
        }
        // 首次创建时若条件失败，说明文档已被他人创建，改为重读更新
        if (rev === 0 && attempt < MAX_RETRY) continue;
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

// 从回收站取回一条：回填到原始列表头部，并从回收站移除
async function restoreTrashItem(trashId) {
  const trash = await loadTrash();
  const item = trash.find(it => String(it.id) === String(trashId));
  if (!item) return null;
  const data = Object.assign({}, item.data);
  delete data._restoredAt;
  const docId = item.type === 'order' ? DOC_ORDERS
    : item.type === 'shopping' ? DOC_SHOPPING
    : DOC_RECORDS;
  await mutateDoc(docId, (doc) => {
    const list = (doc.list || []).slice();
    list.unshift(data);
    doc.list = list;
  });
  await removeTrashItem(trashId);
  return item;
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
  return mutateDoc(DOC_SHOPPING, (doc) => { doc.list = list; });
}

// 软删除单条购物记录 → 进回收站（type: 'shopping'）
// 支持传入整条记录：本地已删时云端查不到也能入回收站
async function trashShoppingById(id, record) {
  const list = await loadShopping();
  const idx = list.findIndex(r => String(r.id) === String(id));
  const rec = idx !== -1 ? list[idx] : record;
  if (!rec) return;

  if (idx !== -1) {
    await saveShopping(list.filter((_, i) => i !== idx));
  }
  const trash = await loadTrash();
  trash.unshift(Object.assign({
    id: newTrashId(),
    deletedAt: Date.now()
  }, { type: 'shopping', data: rec }));
  await saveTrash(trash.slice(0, 100));
}

/* ===== 批量操作 ===== */

// 软删除：从 list 里取出该条，连同来源类型一起压入回收站
async function softRemove(docId, id, trashItem) {
  return mutateDoc(docId, (doc) => {
    const list = (doc.list || []).filter(it => String(it.id) !== String(id));
    doc.list = list;
  }).then(async () => {
    const trash = await loadTrash();
    trash.unshift(Object.assign({ id: newTrashId(), deletedAt: Date.now() }, trashItem));
    await saveTrash(trash.slice(0, 100));
  });
}

// 批量软删除：一次操作完成「过滤列表 + 批量入回收站」
// items: [{ id, type, data }] —— type 为 'record' | 'order' | 'shopping'
// 返回实际删除的条数
async function batchSoftRemove(docId, items) {
  if (!items || !items.length) return 0;
  const ids = new Set(items.map(it => String(it.id)));

  // 1) 从源列表移除
  await mutateDoc(docId, (doc) => {
    doc.list = (doc.list || []).filter(it => !ids.has(String(it.id)));
  });

  // 2) 批量压入回收站（保留原顺序，最新在前）
  await mutateDoc(DOC_TRASH, (doc) => {
    const list = (doc.list || []).slice();
    const now = Date.now();
    const entries = items.map((it, i) => Object.assign({
      id: newTrashId(),
      deletedAt: now + i
    }, { type: it.type, data: it.data }));
    doc.list = entries.concat(list).slice(0, 100);
  });

  return items.length;
}

module.exports = {
  loadCalendar,
  saveCalendarMemo,
  saveCalendarBuy,
  loadRecords,
  saveRecords,
  trashRecordById,
  loadOrders,
  saveOrders,
  pushOrder,
  trashOrderById,
  loadTrash,
  saveTrash,
  removeTrashItem,
  restoreTrashItem,
  loadMenu,
  saveMenu,
  loadShopping,
  saveShopping,
  trashShoppingById,
  batchSoftRemove,
  newTrashId
};
