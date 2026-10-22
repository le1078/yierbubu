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
                  return Promise.resolve({ data: JSON.parse(JSON.stringify(docData)) });
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
    check(!!page._pollInterval, '无条件轮询定时器已启动');
    if (page._pollInterval) clearInterval(page._pollInterval);

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
    check(!page._pollInterval, 'closeWatch 会清掉轮询');
  }

  console.log('\n[2] watch 正常时轮询去重，避免重复处理');
  {
    watchImpl = 'ok';
    docData = { _id: 'r1', roomNo: '1234', status: 'playing', world: 'x' };
    const page = {};
    let got = 0;
    roomkit.startWatch(page, 'rooms', 'r1', function () { got++; });
    await wait(20);
    check(got === 1, 'watch 回调送达（got=' + got + '）');
    if (page._pollInterval) clearInterval(page._pollInterval);
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
    await wait(20);
    check(page._usingPoll === true, 'onError 后标记轮询');
    check(!!page._pollInterval, '轮询定时器仍然存在');
    if (page._pollInterval) clearInterval(page._pollInterval);
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
    check(/_watchPollInterval\s*=\s*setInterval\(\(\)\s*=>\s*this\._pollRoomStatus\(\),\s*500\)/.test(src),
      'gomoku 启动 500ms 无条件轮询');
    check(/watch unsupported/.test(src), 'gomoku 捕获 watch 不支持');
    check(/_pollKey/.test(src), 'gomoku 轮询按 _pollKey 去重');
  }

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail > 0) {
    console.log('❌ 联机同步兜底测试未通过');
    process.exit(1);
  }
  console.log('✓ 联机同步兜底测试全部通过');
})();
