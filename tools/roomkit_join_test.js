// 联机加入查询测试：房间号补零、24h 过期、已开局、权限错误、集合不存在。
// 用法：node tools/roomkit_join_test.js

const path = require('path');

let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

let toasts = [];
let docs = [];
let getError = null;

function makeCollection() {
  return {
    where(query) {
      const roomNo = query && query.roomNo;
      const list = docs.filter(function (d) { return !roomNo || d.roomNo === roomNo; });
      return {
        limit() { return this; },
        get() {
          if (getError) return Promise.reject(getError);
          return Promise.resolve({ data: list });
        }
      };
    }
  };
}

global.wx = {
  cloud: {
    database() {
      return {
        command: { gte(v) { return v; } },
        serverDate() { return new Date(); },
        collection() { return makeCollection(); }
      };
    }
  },
  showToast(o) { toasts.push(o && o.title); }
};

const roomkit = require(path.join(__dirname, '..', 'utils/roomkit.js'));

function nowMinus(hours) {
  return new Date(Date.now() - hours * 3600 * 1000);
}

function reset(newDocs, err) {
  docs = newDocs || [];
  getError = err || null;
  toasts = [];
}

console.log('\n[1] 房间号补零');
{
  reset([{ _id: 'r1', roomNo: '0042', status: 'waiting', createdAt: nowMinus(1) }]);
  const room = null;
  roomkit.findJoinableRoom('rooms', '42').then(function (r) {
    check(r && r._id === 'r1', '输入 42 能匹配 0042 房间');

    reset([{ _id: 'r2', roomNo: '0042', status: 'waiting', createdAt: nowMinus(1) }]);
    return roomkit.findJoinableRoom('rooms', '0042');
  }).then(function (r) {
    check(r && r._id === 'r2', '输入 0042 也能匹配');

    console.log('\n[2] 24h 过期 / 已开局');
    reset([{ _id: 'old', roomNo: '0100', status: 'waiting', createdAt: nowMinus(25) }]);
    return roomkit.findJoinableRoom('rooms', '0100');
  }).then(function (r) {
    check(!r, '25 小时前的房间不会被加入');
    check(toasts.indexOf('房间不存在或无权读取') !== -1, '过期房间提示「不存在或无权读取」');

    reset([{ _id: 'playing', roomNo: '0101', status: 'playing', createdAt: nowMinus(1) }]);
    return roomkit.findJoinableRoom('rooms', '0101');
  }).then(function (r) {
    check(!r, '已开局房间不会被加入');
    check(toasts.indexOf('房间已开始或已结束') !== -1, '已开局提示「已开始或已结束」');

    console.log('\n[3] 同号多房间选最新');
    reset([
      { _id: 'a', roomNo: '0200', status: 'waiting', createdAt: nowMinus(20) },
      { _id: 'b', roomNo: '0200', status: 'waiting', createdAt: nowMinus(1) },
      { _id: 'c', roomNo: '0200', status: 'playing', createdAt: nowMinus(0.5) }
    ]);
    return roomkit.findJoinableRoom('rooms', '0200');
  }).then(function (r) {
    check(r && r._id === 'b', '同号时选最新的 waiting 房间（不是已开局的）');

    console.log('\n[4] 权限 / 集合错误');
    reset([], { errMsg: 'database permission denied' });
    return roomkit.findJoinableRoom('rooms', '0300');
  }).then(function (r) {
    check(!r, '权限错误时不返回房间');
    check(toasts.some(function (t) { return t && t.indexOf('数据库权限不足') !== -1; }),
      '权限错误提示「所有用户可读写」');

    reset([], { errMsg: 'collection not exist' });
    return roomkit.findJoinableRoom('rooms', '0400');
  }).then(function (r) {
    check(!r, '集合不存在时不返回房间');
    check(toasts.some(function (t) { return t && t.indexOf('房间集合不存在') !== -1; }),
      '集合不存在提示去后台创建');

    console.log('\n[5] 没有 createdAt 的旧房间');
    reset([{ _id: 'legacy', roomNo: '0500', status: 'waiting' }]);
    return roomkit.findJoinableRoom('rooms', '0500');
  }).then(function (r) {
    check(r && r._id === 'legacy', '兼容没有 createdAt 的旧房间');

    console.log('\n[6] joinErrorText 翻译');
    check(roomkit.joinErrorText({ errMsg: 'permission denied' }).indexOf('所有用户可读写') !== -1,
      'permission denied → 权限提示');
    check(roomkit.joinErrorText({ errMsg: 'index not found' }).indexOf('索引') !== -1,
      'index not found → 索引提示');
    check(roomkit.joinErrorText({ errMsg: 'collection not exist' }).indexOf('集合不存在') !== -1,
      'collection not exist → 集合提示');
    check(roomkit.joinErrorText({ errMsg: 'something else' }) === '',
      '未知错误不强行翻译');

    console.log('\n========================================');
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    if (fail > 0) {
      console.log('❌ 联机加入查询测试未通过');
      process.exit(1);
    }
    console.log('✓ 联机加入查询测试全部通过');
  }).catch(function (e) {
    console.log('❌ 测试异常', e);
    process.exit(1);
  });
}
