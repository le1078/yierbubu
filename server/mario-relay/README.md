# 马里奥联机实时中继服务器

> **当前部署状态（2026-10-24）**：已部署在腾讯云 `root@81.70.22.49`（OpenCloudOS 9.6）。
> - 服务：systemd 单元 `mario-relay`（`/etc/systemd/system/mario-relay.service`），代码在 `/opt/mario-relay`
> - 常用命令：`systemctl restart mario-relay` / `journalctl -u mario-relay -f`
> - 入口：nginx（litellm.conf）把 `http://81.70.22.49/e8f31a5c27/` 反代到 127.0.0.1:9000
>   （80/443 安全组原本就开，9000 未放行，走 nginx 免改安全组；随机前缀沿用机房反扫描惯例）
> - 小程序配置：`utils/constants.js` → `MARIO_RELAY_URL: 'ws://81.70.22.49/e8f31a5c27/'`
> - 公网冒烟测试：`node tools/relay_smoke_test.js`

## 为什么要有它

微信云数据库对**单文档高频写会限流**（本项目 2.5Hz 已经贴线），watch 推送延迟
200~500ms 且不稳定——这是马里奥双人「老是同步中断」的根因，靠调参数只能缓解。

把对局实时数据搬到这台自建中继后：

- 云数据库只承担「建房 / 加入 / 离开」等低频操作（原有房间号、分享卡片逻辑不变）
- 对局数据（host 世界快照 6.7Hz + guest 输入 10Hz）经服务器直转，**没有配额限制**，
  延迟从几百 ms 降到几十 ms
- 服务器不懂游戏语义（按「房间号+座位」转发 JSON），象棋 / 五子棋以后接进来不用改这里

小程序端**双车道并存**：中继是加速车道（就绪即 6.7~10Hz 快速同步），云数据库是
永远在线的兜底车道（400ms 慢速）。任何一端连不上中继（真机不允许 ws://IP、
开发者工具没勾豁免、服务器挂了）都自动退回纯云数据库模式；两条车道的数据按
时间戳去重（只认更新的），混合环境（比如开发者工具 + 真机）也不会黑屏。

## 部署（在你的云机器上）

```bash
# 1. 上传这个目录到服务器，例如 /opt/mario-relay
# 2. 安装依赖（只需要 node >= 14 和 ws）
cd /opt/mario-relay
npm install

# 3. 启动（默认端口 9000，可用 PORT 环境变量改）
node server.js

# 4. 常驻运行（推荐 pm2）
npm i -g pm2
pm2 start server.js --name mario-relay
pm2 save && pm2 startup
```

放行安全组 / 防火墙的 9000 端口（或你改的端口）。

## 让小程序连上它

### 阶段一：先跑通（开发者工具 + 手机开发版，5 分钟）

1. `utils/constants.js` 里 `MARIO_RELAY_URL` 已填好（见顶部部署状态）：
   ```js
   MARIO_RELAY_URL: 'ws://81.70.22.49/e8f31a5c27/',
   ```
2. 微信开发者工具右上角「详情 → 本地设置」勾选 **「不校验合法域名…」**；
   手机上用开发版预览时打开调试模式（同样跳过域名校验）。
3. 双开测试：HUD 左上角出现 `⚡xxms` 就是走的中继通道。

### 阶段二：正式发布（需要域名）

正式版小程序**只允许 wss + 已备案域名**，必须做这步：

1. 准备一个已 ICP 备案的域名（云厂商都能买，备案走流程），DNS 解析到这台机器。
2. 用 nginx 反代 WebSocket 并配 HTTPS 证书（certbot 免费证书即可）：

   ```nginx
   server {
     listen 443 ssl;
     server_name your.domain.com;
     ssl_certificate     /etc/letsencrypt/live/your.domain.com/fullchain.pem;
     ssl_certificate_key /etc/letsencrypt/live/your.domain.com/privkey.pem;

     location /mario-relay/ {
       proxy_pass http://127.0.0.1:9000;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_read_timeout 300s;   # 长连接别被掐
     }
   }
   ```

3. 小程序后台「开发管理 → 开发设置 → 服务器域名 → **socket 合法域名**」加上
   `wss://your.domain.com`
4. `constants.js`：`MARIO_RELAY_URL: 'wss://your.domain.com/mario-relay'`

## 协议（想接其它游戏看这里）

全部 JSON 文本帧，服务器只做转发：

| 方向 | 消息 | 说明 |
| --- | --- | --- |
| C→S | `{t:'hello', room, seat}` | 入座；同座位旧连接被顶下线 |
| C→S | `{t:'d', v}` | 游戏数据，原样转发给对面座位 |
| C→S | `{t:'ping', ts}` | 心跳 |
| C→S | `{t:'bye'}` | 主动离开 |
| S→C | `{t:'ready', room, seat}` | 就座成功 |
| S→C | `{t:'d', v}` | 对面发来的数据 |
| S→C | `{t:'peer', seat, online, bye}` | 对面上线 / 掉线 / 离开 |
| S→C | `{t:'pong', ts}` | 心跳回显 |

保护措施：单消息 32KB 上限、每连接 120 msg/s 限流、30 秒无消息踢掉、同房最多
2 个座位、同座位重连自动顶号。

## 客户端集成（utils/relay.js）

```js
const relay = require('../../utils/relay.js').create();
relay.connect(url, roomNo, mySeat, {
  onReady() {},            // 连上：把 DB watch 关掉、同步频率拉高
  onData(v) {},            // 对面数据：v.k === 'world' | 'input' | 'end'
  onPeer(online, seat, bye) {},  // 对面在线状态变化
  onDown() {},             // 掉线（自动重连中）
  onGiveUp() {}            // 连续失败放弃：回退云数据库
});
relay.send({ k: 'world', w });   // 发游戏数据
relay.bye();                     // 主动离开
relay.close();
```
