// 平台识别：单一来源，records 与 life 共用
// 字段统一为 { name, hosts }
const PLATFORMS = [
  { name: '淘宝', hosts: ['taobao.com', 'tmall.com', 'tb.cn'] },
  { name: '京东', hosts: ['jd.com', 'jd.hk', '3.cn'] },
  { name: '拼多多', hosts: ['pinduoduo.com', 'yangkeduo.com'] },
  { name: '抖音', hosts: ['douyin.com', 'iesdouyin.com'] },
  { name: '小红书', hosts: ['xiaohongshu.com', 'xhslink.com'] },
  { name: '快手', hosts: ['kuaishou.com'] },
  { name: '唯品会', hosts: ['vip.com'] },
  { name: '微博', hosts: ['weibo.com', 'weibo.cn'] },
  { name: 'B站', hosts: ['bilibili.com', 'b23.tv'] },
  { name: '得物', hosts: ['dewu.com'] },
  { name: '亚马逊', hosts: ['amazon.cn', 'amazon.com'] },
  { name: '网易', hosts: ['163.com'] },
  { name: '1688', hosts: ['1688.com'] }
];

// 按链接域名推断平台名，未知返回 ''
function platOf(url) {
  const u = String(url || '');
  for (const p of PLATFORMS) {
    for (const h of p.hosts) {
      if (u.indexOf(h) !== -1) return p.name;
    }
  }
  return '';
}

module.exports = { PLATFORMS, platOf };
