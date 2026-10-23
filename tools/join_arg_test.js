// 加入房间参数测试：bindtap 会把事件对象传给 joinRoom，
// 不能把它当房间号（否则所有联机都会提示「请输入4位房间号」）。
//
// 用法：node tools/join_arg_test.js

const path = require('path');

let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

let capturedPage = null;
global.Page = function (def) { capturedPage = def; };
global.getApp = function () { return { globalData: {} }; };
global.wx = {
  showToast: function () {},
  showLoading: function () {},
  hideLoading: function () {},
  showModal: function () {},
  createSelectorQuery: function () {
    const q = { in: function () { return q; }, select: function () { return q; },
      fields: function () { return q; }, exec: function (cb) { if (cb) cb([]); } };
    return q;
  },
  cloud: {
    database: function () {
      return {
        command: {},
        serverDate: function () { return new Date(); },
        collection: function () {
          return {
            where: function () { return { limit: function () { return this; }, get: function () { return Promise.resolve({ data: [] }); } }; },
            doc: function () { return { update: function () { return Promise.resolve(); } }; }
          };
        }
      };
    }
  }
};

const roomkit = require(path.join(__dirname, '..', 'utils/roomkit.js'));
const realFind = roomkit.findJoinableRoom;
let seenRoomNo = null;
roomkit.findJoinableRoom = function (collection, roomNo) {
  seenRoomNo = roomNo;
  return Promise.resolve(null);   // 只验证参数，不继续加入流程
};

function loadPage(rel) {
  capturedPage = null;
  delete require.cache[require.resolve(path.join(__dirname, '..', rel))];
  require(path.join(__dirname, '..', rel));
  if (!capturedPage) throw new Error('Page() not called: ' + rel);
  const def = capturedPage;
  const page = {};
  for (const k of Object.keys(def)) page[k] = def[k];
  page.data = JSON.parse(JSON.stringify(def.data || {}));
  page.setData = function (patch, cb) {
    if (patch) for (const k of Object.keys(patch)) this.data[k] = patch[k];
    if (typeof cb === 'function') cb();
  };
  page._ensureCanvas = function () {};
  page._drawBoard = function () {};
  page._measureBoard = function () {};
  page._measure = function () {};
  page._startWatch = function () {};
  return page;
}

const tapEvent = { type: 'tap', currentTarget: { dataset: {} }, detail: { x: 0, y: 0 } };
const pages = [
  ['五子棋联机', 'subpackages/games/gomoku/gomoku.js'],
  ['五子棋人机', 'subpackages/games/gomokuai/gomokuai.js'],
  ['中国象棋', 'subpackages/games/xiangqi/xiangqi.js'],
  ['马里奥', 'subpackages/games/mario/mario.js']
];

(async function () {
  console.log('\n[1] 点「加入」时用输入框里的房间号，而不是 tap 事件对象');
  for (const item of pages) {
    const name = item[0];
    const page = loadPage(item[1]);
    page.data.roomNoInput = '1263';
    seenRoomNo = null;
    await page.joinRoom(tapEvent);
    check(seenRoomNo === '1263', name + '：点加入取到输入框 1263（实际 ' + seenRoomNo + '）');
  }

  console.log('\n[2] 分享卡片/onLoad 主动传字符串时仍按字符串处理');
  for (const item of pages) {
    const name = item[0];
    const page = loadPage(item[1]);
    page.data.roomNoInput = '';
    seenRoomNo = null;
    await page.joinRoom('0421');
    check(seenRoomNo === '0421', name + '：字符串参数 0421 原样传入（实际 ' + seenRoomNo + '）');
  }

  console.log('\n[3] 分享卡片进入自动加入（且马里奥不会落到空白 lobby）');
  {
    // 马里奥
    const mario = loadPage('subpackages/games/mario/mario.js');
    mario.onLoad({ roomNo: '1263' });
    check(mario.data.stage === 'menu' && mario.data.roomNoInput === '1263',
      '马里奥分享进入落到菜单并填入房间号（stage=' + mario.data.stage + '）');
    let autoNo = null;
    mario._autoJoin = '1263';
    mario.joinRoom = function (no) { autoNo = no; };
    mario.onReady();
    check(autoNo === '1263' && !mario._autoJoin, '马里奥 onReady 自动加入分享房间');

    // 象棋
    const xq = loadPage('subpackages/games/xiangqi/xiangqi.js');
    xq.onLoad({ roomNo: '1263' });
    check(xq.data.stage === 'lobby' && xq.data.mode === 'online' && xq.data.roomNoInput === '1263',
      '象棋分享进入落到联机大厅并填入房间号');
    autoNo = null;
    xq._autoJoin = '1263';
    xq.joinRoom = function (no) { autoNo = no; };
    xq.onReady();
    check(autoNo === '1263' && !xq._autoJoin, '象棋 onReady 自动加入分享房间');

    // 五子棋联机
    const g = loadPage('subpackages/games/gomoku/gomoku.js');
    g.onLoad({ roomNo: '1263' });
    autoNo = null;
    g._autoJoin = '1263';
    g.joinRoom = function (no) { autoNo = no; };
    g.onReady();
    check(autoNo === '1263' && !g._autoJoin, '五子棋 onReady 自动加入分享房间');
  }

  roomkit.findJoinableRoom = realFind;

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail > 0) {
    console.log('❌ 加入房间参数测试未通过');
    process.exit(1);
  }
  console.log('✓ 加入房间参数测试全部通过');
})();
