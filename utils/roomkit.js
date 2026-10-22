// 联机房间基础设施：从五子棋（gomoku）的 400 行房间逻辑抽出，
// 供马里奥 / 中国象棋复用，避免每个游戏再抄一遍。
//
// 与 gomoku.js 的关系：gomoku.js 保持原样不动（线上在跑，不冒重构风险），
// 新游戏统一走本模块。gomoku 页后续可择机迁移。
//
// 设计要点（踩过的坑）：
//   1. 云数据库不支持嵌套数组直接 update → 棋盘/世界状态一律序列化成字符串
//   2. watch 可能延迟或断链 → 指数退避重连 3 次，之后降级为 2s 轮询兜底
//   3. 加入方必须过滤 24h 内的同名房间，否则会进早已作废的孤儿房间
//   4. 房间号撞号时加入者会进错房间 → 创建时查重重试

const C = require('./constants.js');
const log = require('./log.js');

/* ========== 房间号 ========== */

// 随机 4 位房间号 + 查重重试（撞号重摇，最多 5 次）
async function genRoomNo(collection) {
  const db = wx.cloud.database();
  let roomNo = '';
  let tries = 0;
  while (tries++ < 5) {
    roomNo = String(Math.floor(Math.random() * (C.ROOM_NO_MAX + 1))).padStart(4, '0');
    const dup = await db.collection(collection).where({ roomNo }).limit(1).get();
    if (!dup.data || !dup.data.length) break;
  }
  return roomNo;
}

/* ========== 创建 / 加入 ========== */

// 创建房间。doc 由调用方给全字段（不含 roomNo / createdAt / updatedAt）。
// 返回 { roomId, roomNo }，失败返回 null 并 toast。
async function createRoom(collection, doc) {
  const db = wx.cloud.database();
  const roomNo = await genRoomNo(collection);
  const full = Object.assign({}, doc, {
    roomNo,
    createdAt: db.serverDate(),
    updatedAt: db.serverDate()
  });
  const res = await db.collection(collection).add({ data: full });
  log.d('[roomkit] create ' + collection + ' roomNo=' + roomNo);
  return { roomId: res._id, roomNo };
}

// 把云数据库的常见错误翻译成用户能照着做的提示。
// 联机加入失败里最常见的不是代码问题，而是集合权限/索引没配好。
function joinErrorText(err) {
  const msg = (err && (err.errMsg || err.message)) || '';
  if (/permission|denied|not authorized|-502003|权限/i.test(msg)) {
    return '数据库权限不足：房间集合需设为「所有用户可读写」';
  }
  if (/index|索引/i.test(msg)) {
    return '数据库缺少索引：请给 roomNo 建单字段索引';
  }
  if (/collection.*not exist|集合.*不存在|DATABASE_COLLECTION_NOT_EXIST/i.test(msg)) {
    return '房间集合不存在，请先在云开发后台创建';
  }
  if (/env|环境|invalid.*env/i.test(msg)) {
    return '云环境配置错误，请检查 app.js 的 cloud env';
  }
  return '';
}

// 加入房间。只认 24 小时内、状态为 waiting 的同名房间。
// 返回房间文档；找不到/不可加入时 toast 说明原因并返回 null。
//
// 查询只用 roomNo 单字段，createdAt/status 在本地过滤：
// 1) 避免 where + orderBy 触发复合索引要求（没建索引时直接报错）
// 2) 权限不足时云数据库可能返回空数组而不是报错，这里至少给出可操作的提示
async function findJoinableRoom(collection, roomNo) {
  const db = wx.cloud.database();
  const raw = String(roomNo || '').replace(/\D/g, '');
  if (!raw || raw.length > 4) {
    wx.showToast({ title: '请输入4位房间号', icon: 'none' });
    return null;
  }
  // 房间号是 padStart(4,'0') 的 4 位字符串，用户可能输入 "42"（少了前导 0），
  // 也可能输入 "0042"。两种都要能匹配到，所以按补零后的形式依次尝试。
  const candidates = [];
  const padded = raw.padStart(4, '0');
  if (padded !== raw) candidates.push(padded);
  candidates.push(raw);
  const now = Date.now();
  const since = now - C.ROOM_EXPIRE_MS;
  let best = null;
  let sawStarted = false;

  for (const cand of candidates) {
    let q;
    try {
      q = await db.collection(collection).where({ roomNo: cand }).limit(20).get();
    } catch (err) {
      log.e('[roomkit] find room fail', err);
      const hint = joinErrorText(err);
      wx.showToast({ title: hint || '查询房间失败', icon: 'none', duration: 3000 });
      return null;
    }
    const list = (q && q.data) || [];
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!r) continue;
      // 兼容没有 createdAt 的旧房间；有 createdAt 的必须没过期
      const t = r.createdAt ? new Date(r.createdAt).getTime() : 0;
      if (r.createdAt && t < since) continue;
      if (r.status !== 'waiting') { sawStarted = true; continue; }
      if (!best || t > best.t) best = { room: r, t: t };
    }
    if (best) break;
  }

  if (!best) {
    wx.showToast({
      title: sawStarted ? '房间已开始或已结束' : '房间不存在或无权读取',
      icon: 'none', duration: 3000
    });
    return null;
  }
  return best.room;
}

/* ========== Watch 同步（带退避重连 + 轮询兜底） ========== */

// 订阅房间文档。onChange 收到房间文档。
// 内部维护退避状态，调用方把返回对象挂在 this._watcher 上，
// 用 closeWatch(page) 统一关闭。
function startWatch(page, collection, docId, onChange) {
  closeWatch(page);
  const db = wx.cloud.database();
  page._watchRetry = 0;
  page._watcher = db.collection(collection).doc(docId).watch({
    onChange: (snapshot) => {
      page._watchRetry = 0;
      const docs = snapshot.docs;
      if (!docs || !docs.length) return;
      onChange(docs[0]);
    },
    onError: (err) => {
      log.e('[roomkit] watch error', err);
      page._watcher = null;
      if (page._watchRetry < 3) {
        page._watchRetry += 1;
        const delay = Math.pow(2, page._watchRetry) * 1000;
        setTimeout(() => {
          if (page._destroyed || !docId) return;
          startWatch(page, collection, docId, onChange);
        }, delay);
      } else {
        // 断链：降级为轮询，避免界面永久卡住
        page._usingPoll = true;
        if (page._pollInterval) clearInterval(page._pollInterval);
        page._pollInterval = setInterval(() => {
          pollRoom(page, collection, docId, onChange);
        }, 2000);
      }
    }
  });
}

// 轮询兜底：watch 延迟/断链时也能及时同步
async function pollRoom(page, collection, docId, onChange) {
  if (page._destroyed || !docId) return;
  try {
    const db = wx.cloud.database();
    const res = await db.collection(collection).doc(docId).get();
    if (res.data) onChange(res.data);
  } catch (e) {
    log.e('[roomkit] poll fail', e);
  }
}

function closeWatch(page) {
  if (page._watcher) {
    try { page._watcher.close(); } catch (e) {}
    page._watcher = null;
  }
  if (page._pollInterval) {
    clearInterval(page._pollInterval);
    page._pollInterval = null;
  }
  page._usingPoll = false;
}

/* ========== 定时器统一清理 ========== */

// onUnload 里一把梭：清理本模块 + 页面自己的所有 _xTimer / _pollInterval。
// 漏一个定时器 → 回调对已卸载页面 setData → 控制台刷 "当前页面不存在" 报错
const PAGE_TIMER_KEYS = [
  '_waitPollTimer', '_pokeTimer', '_emojiFlyTimer',
  '_canvasRetryTimer', '_undoTimeoutTimer',
  '_thinkTimer', '_syncTimer', '_rafTimer', '_respawnTimer'
];

function sweepTimers(page) {
  for (const k of PAGE_TIMER_KEYS) {
    if (page[k]) { clearTimeout(page[k]); page[k] = null; }
  }
  closeWatch(page);
}

/* ========== 聊天 / 表情（乐观更新 + 失败回滚） ========== */

// msg: { from, type:'text'|'emoji', content, ts }
async function pushChat(page, collection, msg) {
  // 乐观更新：本地先插一条 pending 气泡，不等云端往返
  const local = Object.assign({}, msg, { pending: true });
  page.setData({ chatList: (page.data.chatList || []).concat([local]) });

  const db = wx.cloud.database();
  const _ = db.command;
  try {
    await db.collection(collection).doc(page._roomId).update({
      data: {
        chat: _.push(msg),
        updatedAt: db.serverDate()
      }
    });
    return true;
  } catch (e) {
    // 发送失败：移除乐观插入的那条
    page.setData({ chatList: (page.data.chatList || []).filter(m => m !== local) });
    wx.showToast({ title: '发送失败', icon: 'none' });
    return false;
  }
}

// 把云端 chat 数组合并进本地 chatList，按 from+ts 去重，丢掉已确认的 pending
function mergeChat(existing, cloud, me) {
  const seen = new Set(existing.map(m => m.from + '_' + m.ts));
  const merged = existing.filter(m => !m.pending);
  let addedNew = null;
  for (const m of cloud) {
    const key = m.from + '_' + m.ts;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({
      from: m.from, type: m.type, content: m.content, ts: m.ts,
      mine: m.from === me
    });
    if (!addedNew) addedNew = m;
  }
  return { list: merged, addedNew };
}

/* ========== 戳一戳 ========== */

async function sendPoke(page, collection, from) {
  const db = wx.cloud.database();
  try {
    await db.collection(collection).doc(page._roomId).update({
      data: { poke: { from, ts: Date.now() }, updatedAt: db.serverDate() }
    });
  } catch (e) {
    log.e('[roomkit] poke fail', e);
  }
}

/* ========== 分享 ========== */

function buildSharePath(route, roomNo, fallback) {
  return roomNo ? (route + '?roomNo=' + roomNo) : fallback;
}

/* ========== 导出 ========== */

/* ========== 系统信息（安全取值） ========== */

// 取屏幕信息。微信 API 在某些时机（初始化、切后台、开发者工具重载）会返回 null，
// 直接读 .windowWidth 会抛 "Cannot read properties of null (reading 'screenHeight')"。
// 这里做防御，并给出可用的兜底值，页面拿不到就用默认尺寸也不至于白屏。
function getWindowSize() {
  let info = null;
  try {
    if (wx.getWindowInfo) info = wx.getWindowInfo();
    else if (wx.getSystemInfoSync) info = wx.getSystemInfoSync();
  } catch (e) {
    info = null;
  }
  // 兜底：iPhone 常见尺寸，只在 API 失效时用
  const fallback = { windowWidth: 375, windowHeight: 667, pixelRatio: 2 };
  if (!info || typeof info !== 'object') return fallback;
  return {
    windowWidth: (typeof info.windowWidth === 'number' && info.windowWidth > 0) ? info.windowWidth : fallback.windowWidth,
    windowHeight: (typeof info.windowHeight === 'number' && info.windowHeight > 0) ? info.windowHeight : fallback.windowHeight,
    pixelRatio: (typeof info.pixelRatio === 'number' && info.pixelRatio > 0) ? info.pixelRatio : fallback.pixelRatio
  };
}

// 取设备像素比（绘制用，钳到 2 防止高分屏绘制量爆炸）
function getDpr() {
  return Math.min(getWindowSize().pixelRatio, 2);
}


/* ========== 安全导航 ========== */

// 返回上一页；如果页面栈里没有上一页（比如从分享卡片直接进来），
// 回退到游戏大厅 tab。
//
// 为什么不能写成 `wx.navigateBack({ fail: () => wx.switchTab(...) })`：
// navigateBack 的 fail 回调触发时，基础库仍在收尾上一次路由，
// 此时立刻 switchTab 会让 routeDone 找不到已销毁的 webview，
// 报 "routeDone with a webviewId N is not found"。
// 正确做法是先查页面栈，再决定走哪条路，并加一个极小的延迟让路由收尾。
function goBack(fallbackTab) {
  const tab = fallbackTab || '/pages/games/games';
  let stackLen = 1;
  try {
    const pages = getCurrentPages();
    stackLen = pages ? pages.length : 1;
  } catch (e) {
    stackLen = 1;
  }
  if (stackLen > 1) {
    wx.navigateBack({
      fail: () => {
        // 极少数情况下栈长度与实际不一致，延迟一拍再走 tab
        setTimeout(() => { wx.switchTab({ url: tab }); }, 60);
      }
    });
  } else {
    // 栈里只有当前页 → 直接回 tab（不存在上一个 webview 可退）
    wx.switchTab({
      url: tab,
      fail: () => { wx.reLaunch({ url: tab }); }
    });
  }
}


module.exports = {
  goBack,
  getWindowSize,
  getDpr,
  genRoomNo,
  createRoom,
  findJoinableRoom,
  joinErrorText,
  startWatch,
  pollRoom,
  closeWatch,
  sweepTimers,
  pushChat,
  mergeChat,
  sendPoke,
  buildSharePath,
  PAGE_TIMER_KEYS
};
