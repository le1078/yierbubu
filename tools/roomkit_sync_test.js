// 联机同步兜底测试：watch 不支持时，轮询必须仍然把对方状态送进来。
// 背景：开发者工具/部分基础库会报 "reportRealtimeAction:fail not support"，
// 如果只依赖 watch，双方都会看到对方不动。
//
// 用法：node tools/roomkit_sync_test.js

const path = require('path');

let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

let docData = { _id: 'r1', roomNo: '1234', status: 'playing', input2: 'a' };
let watchImpl = null;
let gets = 0;   // 云读次数（配额观测）
let getDelay = 0;   // 模拟云读耗时（测试关订阅时正卡在 await 的竞态）

global.wx = {
  showToast: function () {},
  cloud: {
    database: function () {
      return {
        command: {},
        serverDate: function () { return new Date(); },
        collection: function () {
          return {
            doc: function () {
              return {
                watch: function (handlers) {
                  if (watchImpl === 'throw') throw new Error('reportRealtimeAction:fail not support');
                  if (watchImpl === 'error') {
                    setTimeout(function () { handlers.onError && handlers.onError(new Error('not support')); }, 0);
                    return { close: function () {} };
                  }
                  if (watchImpl === 'ok') {
                    setTimeout(function () {
                      handlers.onChange && handlers.onChange({ docs: [docData] });
                    }, 0);
                    return { close: function () {} };
                  }
                  return { close: function () {} };
                },
                get: function () {
                  gets++;
                  const snapshot = JSON.parse(JSON.stringify(docData));
                  return new Promise(function (resolve) {
                    setTimeout(function () { resolve({ data: snapshot }); }, getDelay);
                  });
                }
              };
            }
          };
        }
      };
    }
  }
};

const roomkit = require(path.join(__dirname, '..', 'utils/roomkit.js'));

function wait(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

(async function () {
  console.log('\n[1] watch 直接抛「不支持」时，仍然启动轮询');
  {
    watchImpl = 'throw';
    const page = {};
    let got = 0;
    roomkit.startWatch(page, 'rooms', 'r1', function () { got++; });
    check(page._usingPoll === true, '标记使用轮询');
    check(!!page._pollTimer, '无条件轮询定时器已启动');
    if (page._pollTimer) { clearTimeout(page._pollTimer); page._pollTimer = null; }

    // 手动触发一次轮询（避免测试等 800ms）
    page._pollKey = null;
    await roomkit.pollRoom(page, 'rooms', 'r1', function () { got++; });
    check(got === 1, '轮询能拿到房间文档并回调（got=' + got + '）');

    // 同一份文档不重复回调
    await roomkit.pollRoom(page, 'rooms', 'r1', function () { got++; });
    check(got === 1, '文档没变时不重复回调（去重）');

    // 文档变化 → 回调
    docData = { _id: 'r1', roomNo: '1234', status: 'playing', input2: 'b' };
    await roomkit.pollRoom(page, 'rooms', 'r1', function () { got++; });
    check(got === 2, '文档变化后回调（got=' + got + '）');

    roomkit.closeWatch(page);
    check(!page._pollTimer, 'closeWatch 会清掉轮询');
  }

  console.log('\n[2] watch 正常时轮询去重，避免重复处理');
  {
    watchImpl = 'ok';
    docData = { _id: 'r1', roomNo: '1234', status: 'playing', world: 'x' };
    const page = {};
    let got = 0;
    roomkit.startWatch(page, 'rooms', 'r1', function () { got++; });
    // 先停掉 0ms 的兜底轮询，确保这次 got 来自 watch
    if (page._pollTimer) { clearTimeout(page._pollTimer); page._pollTimer = null; }
    await wait(20);
    check(got === 1, 'watch 回调送达（got=' + got + '）');
    await roomkit.pollRoom(page, 'rooms', 'r1', function () { got++; });
    check(got === 1, '同一文档轮询不重复回调（watch 已设置 _pollKey）');
    roomkit.closeWatch(page);
  }

  console.log('\n[3] watch onError 时轮询保持可用');
  {
    watchImpl = 'error';
    const page = {};
    let got = 0;
    roomkit.startWatch(page, 'rooms', 'r1', function () { got++; });
    check(!!page._pollTimer, '轮询定时器已启动');
    // 停掉 0ms 的首次轮询，让 got 只统计后面的手动 poll
    if (page._pollTimer) { clearTimeout(page._pollTimer); page._pollTimer = null; }
    await wait(20);
    check(page._usingPoll === true, 'onError 后标记轮询');
    page._pollKey = null;
    docData = { _id: 'r1', roomNo: '1234', status: 'playing', world: 'y' };
    await roomkit.pollRoom(page, 'rooms', 'r1', function () { got++; });
    check(got === 1, 'onError 后仍能通过轮询收到更新（got=' + got + '）');
    roomkit.closeWatch(page);
  }

  console.log('\n[4] 五子棋自己的 watch 也必须有轮询兜底');
  {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'subpackages/games/gomoku/gomoku.js'), 'utf8');
    check(/_startPolling\s*\(/.test(src) && /_pollTimer\s*=\s*setTimeout/.test(src),
      'gomoku 启动串行自调度轮询');
    check(/watch unsupported/.test(src), 'gomoku 捕获 watch 不支持');
    check(/_pollKey/.test(src), 'gomoku 轮询按 _pollKey 去重');
  }

  console.log('\n[5] 乱序保护：迟到的旧快照不能把棋局回滚');
  {
    // watch 与轮询是两条独立通道，可能交错投递；页面收到旧快照会按
    // boardStr 重建棋盘 —— 等于回滚。用服务端 updatedAt 单调过滤。
    const page = {};
    const seen = [];
    const onChange = function (d) { seen.push(d.boardStr || 'none'); };
    const makeDoc = function (t, board) {
      return { _id: 'r1', roomNo: '1234', status: 'playing', boardStr: board, updatedAt: new Date(t) };
    };
    const t0 = 1761300000000;

    docData = makeDoc(t0 + 5000, 'move5');
    await roomkit.pollRoom(page, 'rooms', 'r1', onChange);
    check(seen.length === 1 && seen[0] === 'move5', '最新快照正常送达');

    // 迟到的旧快照（第 3 手）必须丢弃
    docData = makeDoc(t0 + 3000, 'move3');
    await roomkit.pollRoom(page, 'rooms', 'r1', onChange);
    check(seen.length === 1, '更旧的快照被丢弃（棋盘不回滚）');

    // 更新的快照继续放行
    docData = makeDoc(t0 + 9000, 'move9');
    await roomkit.pollRoom(page, 'rooms', 'r1', onChange);
    check(seen.length === 2 && seen[1] === 'move9', '更新的快照继续送达');

    // 没有 updatedAt 的文档（如马里奥只写 world 字段）必须一律放行
    page._pollKey = null;
    docData = { _id: 'r1', status: 'playing', world: 'w1' };
    await roomkit.pollRoom(page, 'rooms', 'r1', onChange);
    check(seen.length === 3, '无 updatedAt 的文档不被顺序过滤挡掉');
    docData = { _id: 'r1', status: 'playing', world: 'w2' };
    await roomkit.pollRoom(page, 'rooms', 'r1', onChange);
    check(seen.length === 4, '无时间戳的连续更新都能送达');

    // 关闭订阅要清掉顺序基线（换房间不能沿用上一局时间）
    roomkit.closeWatch(page);
    check(page._lastDocAt === 0, 'closeWatch 清空顺序基线');
  }

  console.log('\n[6] 轮询节奏自适应：watch 健康时不烧云读');
  {
    // 背景：原来无论 watch 是否正常都 200ms 读一次，两人对局 ≈ 3.6 万读/小时，
    // 免费额度几小时就穿。watch 有推送时轮询只该当 2s 安全网。
    watchImpl = 'ok';
    docData = { _id: 'r1', roomNo: '1234', status: 'playing', world: 'h1' };
    const page = {};
    gets = 0;
    roomkit.startWatch(page, 'rooms', 'r1', function () {});
    await wait(460);
    check(gets <= 2, 'watch 健康：460ms 内云读 ≤2 次（实际 ' + gets + '）');
    roomkit.closeWatch(page);

    watchImpl = 'throw';
    docData = { _id: 'r1', roomNo: '1234', status: 'playing', world: 'h2' };
    const page2 = {};
    gets = 0;
    roomkit.startWatch(page2, 'rooms', 'r1', function () {});
    await wait(460);
    check(gets >= 3, 'watch 不可用：仍保持 200ms 快速轮询（实际 ' + gets + ' 次）');
    roomkit.closeWatch(page2);

    // 观察期结束且 watch 没有推送过（可能静默失效）：降到 2s，但仍在同步
    const page3 = { _watchStartAt: Date.now() - 20000, _watchOkAt: 0, _watchFail: false };
    const delay = (function () {
      // 通过私有行为观察：直接检查文件里的常量契约
      const src = require('fs').readFileSync(path.join(__dirname, '..', 'utils/roomkit.js'), 'utf8');
      return /function pollDelay\(page\)[\s\S]*?return 2000;[\s\S]*?\}/.test(src);
    })();
    check(delay === true, '观察期后即使 watch 沉默也降为 2s 安全网');
  }

  console.log('\n[7] 聊天合并：去重 / pending 保留 / 本地列表封顶');
  {
    const C = require(path.join(__dirname, '..', 'utils/constants.js'));
    const existing = [];
    for (let i = 0; i < 150; i++) {
      existing.push({ from: 1, type: 'text', content: 'm' + i, ts: 1000 + i, key: '1_' + (1000 + i) });
    }
    const cloud = existing.slice(0, 100).map(function (m) {
      return { from: m.from, type: m.type, content: m.content, ts: m.ts };
    });
    const r = roomkit.mergeChat(existing, cloud, 2);
    check(r.list.length === C.CHAT_MAX, '本地聊天列表封顶到 CHAT_MAX（实际 ' + r.list.length + '）');
    check(r.list[r.list.length - 1].content === 'm149', '封顶后保留最新消息');

    const pending = [{ from: 1, type: 'text', content: 'hi', ts: 9999, pending: true, key: '1_9999_p' }];
    const r2 = roomkit.mergeChat(pending, [{ from: 1, type: 'text', content: 'old', ts: 1000 }], 1);
    check(r2.list.length === 2 && r2.list.some(function (m) { return m.pending; }),
      '云端快照里还没有它时，pending 气泡不被冲掉');
    const r3 = roomkit.mergeChat(pending, [{ from: 1, type: 'text', content: 'hi', ts: 9999 }], 1);
    check(r3.list.length === 1 && !r3.list[0].pending, '云端已确认后不重复显示');

    // 脏数据：chat/本地列表不是数组时不能抛，也不能生成假消息
    let crash = false;
    let bad = null;
    try {
      bad = roomkit.mergeChat(null, 'not-an-array', 1);
      bad = roomkit.mergeChat(null, { a: 1 }, 1);
      bad = roomkit.mergeChat('oops', [], 1);
    } catch (e) { crash = true; }
    check(!crash, 'chat 脏数据不抛异常');
    check(bad && bad.list.length === 0, 'chat 脏数据不会生成假气泡');
  }

  console.log('\n[8] 关闭订阅时正卡在云读上：恢复后不能自己续期');
  {
    // 背景：轮询链是「await get 之后再排下一次」。closeWatch 只能清掉
    // 定时器句柄；若此刻正卡在 await 里（句柄为 null），恢复后它会照样
    // 自调度 —— 等于关掉订阅后仍在后台 5Hz 读库。
    watchImpl = 'throw';   // 保持 200ms 快速轮询，放大会漏读的差异
    docData = { _id: 'r1', roomNo: '1234', status: 'playing', world: 'z' };
    getDelay = 200;
    const page = {};
    gets = 0;
    roomkit.startWatch(page, 'rooms', 'r1', function () {});
    await wait(60);        // 第一轮 get 已发出（200ms 后才回来）
    roomkit.closeWatch(page);
    await wait(800);
    check(gets === 1, 'closeWatch 后在途的一轮结束即停（期望 1 次，实际 ' + gets + '）');
    getDelay = 0;
  }

  console.log('\n[9] 五子棋页自己的轮询：关订阅时在途的一轮也不能续期');
  {
    let def = null;
    global.Page = function (d) { def = d; };
    const gmPath = path.join(__dirname, '..', 'subpackages/games/gomoku/gomoku.js');
    delete require.cache[require.resolve(gmPath)];
    require(gmPath);
    const p = {};
    for (const k of Object.keys(def)) if (typeof def[k] === 'function') p[k] = def[k];
    p.data = JSON.parse(JSON.stringify(def.data || {}));
    p.setData = function (patch, cb) {
      if (patch) for (const k of Object.keys(patch)) this.data[k] = patch[k];
      if (cb) cb();
    };
    p._ensureCanvas = function () {};
    p._roomId = 'r1';
    let polls = 0;
    p._pollRoomStatus = function () {
      return new Promise(function (r) {
        setTimeout(function () { polls++; r(); }, 200);
      });
    };
    watchImpl = 'throw';   // watch 不可用 → 200ms 快速轮询
    p._startWatch();
    await wait(60);
    p._closeWatcher();
    await wait(800);
    check(polls === 1, '五子棋关订阅后在途轮询不再续期（期望 1 次，实际 ' + polls + '）');
  }

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail > 0) {
    console.log('❌ 联机同步兜底测试未通过');
    process.exit(1);
  }
  console.log('✓ 联机同步兜底测试全部通过');
})();
