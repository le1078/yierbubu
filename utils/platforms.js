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

// 取 URL 的主机名（小写，去 userinfo / 端口）。
// 不能用「整串包含域名」判断：https://evil.com/?ref=taobao.com 会被误判成淘宝，
// taobao.com.evil.com / notjd.com.evil.com 也一样 —— 必须按主机名做后缀匹配。
function hostOf(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  let h = '';
  const m = s.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/);
  if (m) {
    h = m[1];
  } else {
    // 没有协议头：取第一段（如 m.tb.cn/h.xxx）
    h = s.split(/[/?#]/)[0];
  }
  h = h.replace(/^[^@]*@/, '');   // 去掉 user:pass@
  h = h.split(':')[0];            // 去掉端口
  return h.toLowerCase();
}

// 按链接域名推断平台名，未知返回 ''
function platOf(url) {
  const h = hostOf(url);
  if (!h) return '';
  for (const p of PLATFORMS) {
    for (const host of p.hosts) {
      // 精确命中或在子域上（m.tb.cn 命中 tb.cn）；反向不成立
      if (h === host || h.slice(-(host.length + 1)) === '.' + host) return p.name;
    }
  }
  return '';
}

module.exports = { PLATFORMS, platOf, hostOf };
