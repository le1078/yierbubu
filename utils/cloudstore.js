// 云端共享存储：单文档模式，所有用户可读可写
// 集合需在云开发后台手动创建：yb_shared
// 文档 _id 固定，首次使用自动创建

const COLLECTION = 'yb_shared';
const DOC_CALENDAR = 'shared_calendar';  // { memo: {}, buy: {} }
const DOC_RECORDS = 'shared_records';    // { list: [] }
const DOC_ORDERS = 'shared_orders';      // { list: [] } 餐厅订单
const DOC_MENU = 'shared_menu';          // { list: [] } 餐厅菜单
const DOC_SHOPPING = 'shared_shopping';  // { list: [] } 购物记录（小笨生活）

function db() { return wx.cloud.database(); }

// 读取文档（不存在返回 null）
async function getDoc(docId) {
  try {
    const res = await db().collection(COLLECTION).doc(docId).get();
    return res.data || null;
  } catch (e) {
    // 文档不存在
    return null;
  }
}

// 写入文档（不存在则创建，存在则整体更新 data 字段）
async function setDoc(docId, data) {
  // update 时不能带 _id/_openid
  const clean = Object.assign({}, data);
  delete clean._id;
  delete clean._openid;
  const existing = await getDoc(docId);
  if (existing) {
    await db().collection(COLLECTION).doc(docId).update({ data: clean });
  } else {
    await db().collection(COLLECTION).add({
      data: Object.assign({ _id: docId }, clean)
    });
  }
}

// 原子更新：先拉最新 → mergeFn 修改 → 写回
async function mutateDoc(docId, mergeFn) {
  const doc = (await getDoc(docId)) || {};
  mergeFn(doc);
  // 去掉云数据库保留字段
  delete doc._id;
  delete doc._openid;
  await setDoc(docId, doc);
  return doc;
}

/* ===== 日历 ===== */

async function loadCalendar() {
  const doc = await getDoc(DOC_CALENDAR);
  return {
    memo: (doc && doc.memo) || {},
    buy: (doc && doc.buy) || {}
  };
}

async function saveCalendarMemo(memoObj) {
  return mutateDoc(DOC_CALENDAR, (doc) => {
    doc.memo = memoObj;
  });
}

async function saveCalendarBuy(buyObj) {
  return mutateDoc(DOC_CALENDAR, (doc) => {
    doc.buy = buyObj;
  });
}

/* ===== 回收站 ===== */

// 回收站文档结构：{ list: [ { type:'record'|'order', data:{...}, deletedAt: ts, id } ] }
const DOC_TRASH = 'shared_trash';

async function loadTrash() {
  const doc = await getDoc(DOC_TRASH);
  return (doc && doc.list) || [];
}

async function saveTrash(list) {
  return mutateDoc(DOC_TRASH, (doc) => {
    doc.list = list;
  });
}

// 软删除：从 list 里取出该条，连同来源类型一起压入回收站
async function softRemove(docId, id, trashItem) {
  return mutateDoc(docId, (doc) => {
    const list = (doc.list || []).filter(it => String(it.id) !== String(id));
    doc.list = list;
  }).then(async () => {
    const trash = await loadTrash();
    trash.unshift(Object.assign({ id: Date.now() + '_' + Math.random().toString(36).slice(2, 8), deletedAt: Date.now() }, trashItem));
    await saveTrash(trash.slice(0, 100));
  });
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
  const doc = await getDoc(DOC_RECORDS);
  return (doc && doc.list) || [];
}

async function saveRecords(list) {
  return mutateDoc(DOC_RECORDS, (doc) => {
    doc.list = list;
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
  const doc = await getDoc(DOC_ORDERS);
  return (doc && doc.list) || [];
}

async function saveOrders(list) {
  return mutateDoc(DOC_ORDERS, (doc) => {
    doc.list = list;
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
  const doc = await getDoc(DOC_MENU);
  return (doc && doc.list) || null;
}

async function saveMenu(list) {
  return mutateDoc(DOC_MENU, (doc) => {
    doc.list = list;
  });
}

/* ===== 小笨生活 · 购物记录 ===== */

// 单条结构：{ id, title, price, link, date, shop, note, tag, bought, ts }
async function loadShopping() {
  const doc = await getDoc(DOC_SHOPPING);
  return (doc && doc.list) || [];
}

async function saveShopping(list) {
  return mutateDoc(DOC_SHOPPING, (doc) => {
    doc.list = list;
  });
}

// 软删除单条购物记录 → 进回收站（type: 'shopping'）
// 注意：小笨生活那边是「先本地删、再写回收站」，此时云端列表里已经没有这条了，
// 所以必须支持传入整条记录；能查到就按 id 删，查不到就直接用传入的数据入回收站。
async function trashShoppingById(id, record) {
  const list = await loadShopping();
  const idx = list.findIndex(r => String(r.id) === String(id));
  const rec = idx !== -1 ? list[idx] : record;
  if (!rec) return;

  if (idx !== -1) {
    // 云端还有这条：从列表里摘掉，再压入回收站
    await saveShopping(list.filter((_, i) => i !== idx));
  }
  const trash = await loadTrash();
  trash.unshift(Object.assign({
    id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    deletedAt: Date.now()
  }, { type: 'shopping', data: rec }));
  await saveTrash(trash.slice(0, 100));
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
  trashOrderById,
  loadTrash,
  saveTrash,
  removeTrashItem,
  restoreTrashItem,
  loadMenu,
  saveMenu,
  loadShopping,
  saveShopping,
  trashShoppingById
};
