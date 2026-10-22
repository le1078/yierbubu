# 小笨游戏大厅

小程序内的联机/单机游戏集合。数据驱动：新游戏只需在 `pages/games/games.js` 的
`GAMES` 数组加一张卡 + 在 `app.json` 注册分包页面。

`preloadRule` 已预载 `games` 分包（进大厅即下载），新游戏页面零成本搭车。

---

## 一、游戏清单

| 游戏 | 路径 | 模式 | 网络 |
|---|---|---|---|
| 小笨五子棋 | `subpackages/games/gomoku/` | 双人联机（房间制） | 云 watch |
| 五子棋人机对战 | `subpackages/games/gomokuai/` | 单机，三档难度 | 无 |
| 小笨中国象棋 | `subpackages/games/xiangqi/` | 联机 / 同屏 / 人机 | 云 watch |
| 小笨马里奥 | `subpackages/games/mario/` | 双人联机闯关（合作/竞速） | 云 watch |

> 五子棋（gomoku）是线上在跑的老代码，**未做任何重构**。新增的共享能力放在
> `utils/roomkit.js`，gomoku 页仍用内嵌实现。后续若要统一，可择机迁移。

---

## 二、共享基础设施

### `utils/roomkit.js`

从 gomoku 的 400 行房间逻辑抽出的通用能力，象棋/马里奥直接复用：

| 函数 | 用途 |
|---|---|
| `genRoomNo` | 随机 4 位房间号 + 查重重试（撞号重摇） |
| `createRoom` / `findJoinableRoom` | 建房间 / 加入（24h 过期过滤） |
| `startWatch` / `pollRoom` / `closeWatch` | watch + 指数退避重连 3 次 → 降级 2s 轮询兜底 |
| `sweepTimers` | `onUnload` 统一清理所有定时器 |
| `pushChat` / `mergeChat` | 聊天乐观更新（失败回滚）+ 按 `from_ts` 去重合并 |
| `sendPoke` / `buildSharePath` | 戳一戳 / 分享路径 |

### `utils/gomoku_core.js`

五子棋纯逻辑（棋盘/胜负/候选点裁剪），无 wx 依赖，可 node 单测。
`gomoku_ai.js` 与 AI 对战页共用。

### `subpackages/games/gomoku/board_render.js`

棋盘 Canvas 绘制（离屏缓存背景 + 渐变缓存 + 最后一手标记 + 五连高亮 + 命中测试）。
AI 对战页复用，避免两份绘制代码分叉。gomoku 页本身仍用内嵌实现。

---

## 三、五子棋人机对战（gomokuai）

- 三档难度：简单（一层棋型 + 25% 随机）/ 普通（深度 2）/ 困难（深度 4 + 迭代加深 + 700ms 预算）
- 算法：`utils/gomoku_ai.js`
  1. **必杀/必堵**：有成五点直接下，对方有成五点直接堵
  2. **候选点裁剪**：只搜已有棋子周围 2 格内（通常 <40 点，比 225 全盘快一个数量级）
  3. **棋型模式匹配**：活四/冲四/活三/眠三/活二 分级加权，攻守分开
  4. **Alpha-Beta**：在裁剪后的候选点上搜索
- AI 思考用 `setTimeout` 分片 + 「思考中」动画，避免阻塞 UI
- 悔棋：撤回到我方上一手之前，保证悔棋后轮到我方（不触发 AI 连锁下子）

---

## 四、中国象棋（xiangqi）

### 规则引擎 `rules.js`

- 一维 90 格棋盘，`1~7` 红 / `9~15` 黑（高低位区分阵营，`sideOf` 一步位运算）
- 完整规则：车/炮/马(蹩腿)/相(塞象眼+不过河)/仕/帅(九宫)/兵(过河横走)
- **飞将照面**、将军判定、自将过滤
- **将死/困毙**：无合法着法即负（象棋困毙等同负，与国际象棋不同）
- 和棋：自然限着 120 回合 + 三次重复局面
- `boardToStr` / `strToBoard` 序列化（嵌套数组不能直接写云数据库）

**性能**：`isInCheck` 采用「从目标格反向探查」而非「遍历全盘生成伪走法」，
初始局面着法生成从 20s+ 降到 1ms。

### AI `ai.js`

- negamax 形式 Alpha-Beta + 迭代加深 + 时间预算（900ms）
- 子力价值 + 位置表（马/车/炮/兵），黑方上下镜像
- 着法排序（吃子优先）提升剪枝效率
- 难度：简单掺随机 / 普通深度 2 / 困难深度 4

### 三种模式

| 模式 | 说明 |
|---|---|
| 联机 | 走 roomkit，boardStr 同步，房主执红先行；含聊天、离开通知 |
| 同屏 | 一部手机两人轮流，红方在下 |
| 人机 | AI 思考分片 + 「思考中」动画，onHide 暂停避免连走 |

---

## 五、马里奥（mario）

### 引擎 `engine.js`（纯逻辑，可 node 单测）

- **固定步长确定性物理**：60Hz tick，重力/摩擦/限速/可变跳跃高度。
  host 与 guest 跑同一套公式，才谈得上客户端预测
- 操作宽容度：**土狼时间**（离地 0.1s 仍可跳）+ **跳跃缓冲**（落地前按跳也生效）
- 冰面低摩擦、AABB 分轴碰撞 + 二分贴墙（不卡进墙里）
- 实体：走怪/乌龟/飞行怪/食人花（管道口周期冒出，靠近缩回，不能踩、怕火球）
- **管道传送**：站在管道口按 ↓ 进入地下金币房，出口管道按 ↓ 回到主关卡
- **道具链**：蘑菇（变大）、火焰花（发火球）、星星（10 秒无敌撞飞敌人）、1UP（加命）、隐藏砖
- **单机竞速电脑对手**：`makeAutoInput` 会躲敌人、跳坑/尖刺，5 关都能零死亡通关
- 移动平台：承载玩家一起动（记录上帧位移叠加到玩家坐标）
- **Boss 三阶段**：火球弹幕 → 冲撞 → 虚弱可踩（3 血）
- 玩家状态机：alive/dying/dead/done，3 条命、重生回检查点

### 关卡 `levels.js`

ASCII 地图 + 实体配置。主关卡占 col 0~99，col 100~135 是管道通往的地下金币房
（同一张网格，联机两端不需要切关卡）：
1. 草原 1-1（砖块/管道/旗杆）2. 地下 1-2（管道+砖块走廊）
3. 空中 1-3（悬浮平台+飞行怪）4. 城堡 1-4（尖刺+Boss）
5. 草原 1-1·改（复用 1-1 布局，作为第五关）

### 渲染 `render.js`

- 摄像机跟随**本地玩家**（联机时 guest 跟 P2，不会被锁在 host 身上）
- 天空/云朵离屏缓存；进入金币房自动切成暗色洞窟背景
- 角色用 GIF 抽帧 PNG 直接 `drawImage` 到 canvas（`<image>` 叠加会被原生画布盖住），
  图片未就绪时退回矢量小人
- 经典 SMB1 配色：蓝天、红砖、绿管、棕土

### 联机同步协议（重点）

```
mario_rooms 文档：
  {roomId}          ← 房间元数据 + world（只有 host 写，2.5Hz）
  {roomId}_input    ← guest 输入（只有 guest 写，2.5Hz）
                     含按键状态 + 已吃掉的金币 id

把 world 和 input2 拆成两个文档，是为了避免两个写者并发写同一个
文档触发云数据库单文档写入限流（之前表现为对手 3 秒才动一次）。
```

**每个座位只写自己的字段 → 两个写者永不冲突**，不需要 read-modify-write，
规避云数据库嵌套数组更新的最大坑。

| 环节 | 做法 |
|---|---|
| 延迟掩盖 | guest 自己的角色用本地输入做死区推算（偏差 >0.8 格才拉回），手感即时 |
| 平滑 | host 角色/敌人/金币/Boss 用权威值 + 帧间插值，消除 watch 推送的阶梯感 |
| 限流保护 | 每人 2.5Hz（双人合计 5Hz，避开单文档 5 次/秒限流）；写失败降 1.25Hz → 0.625Hz |
| watch 不可用 | 开发者工具可能报 `reportRealtimeAction:fail not support`；统一加**串行自调度轮询**，按文档 key 去重，watch 正常时几乎零开销 |
| 本地预测被拉回 | P2 走几步就瞬移回原位（橡皮筋） | 自己位置只在小偏差时不校正；仅首次/死亡/复活/偏差 >10 格才对齐 |
| 轮询请求重叠 | get 较慢时旧响应后到，覆盖新状态 | 轮询改成「上一次完成后 200ms 再发下一次」，不再用 setInterval |
| 防作弊 | 金币以 host 为权威：guest 只上报 `got:[id]`，host 做距离校验后才移除 |
| 省额度 | `onHide` 停循环 + 停写入，切回来再续 |

**已知限制（必须告知用户）**：云 watch 推送 + 2.5Hz 同步，对手位置约有 0.3~0.8 秒延迟。
watch 不可用时由 500ms 轮询兜底，延迟会更大一些，但不会出现「对方完全不动」。
客户端预测只能掩盖、不能消除。
若要彻底解决需自建 WebSocket 服务器（需域名 ICP 备案 + 小程序后台配 socket 合法域名）。

---

## 六、云数据库

| 集合 | 用途 | 写入方 |
|---|---|---|
| `gomoku_rooms` | 五子棋联机 | 双方（回合制，无冲突） |
| `xiangqi_rooms` | 象棋联机 | 双方（回合制，无冲突） |
| `mario_rooms` | 马里奥联机 | **host 只写 world / guest 只写 input2** |

三个集合都需在云开发后台手动创建（env `cloudbase-d4gqowrctd9dac09f`）。

### 加入房间失败排查（按提示对照）

| 提示 | 原因 | 处理 |
|---|---|---|
| `房间不存在或无权读取` | 房间号错 / 房主已离开 / **集合权限是「仅创建者可读写」** | 先核对 4 位房间号；再在云开发控制台把集合权限改成「所有用户可读、所有用户可写」 |
| `数据库权限不足：房间集合需设为「所有用户可读写」` | 加入方没有读/写权限 | 同上，三个房间集合都要改 |
| `房间集合不存在` | 没建 `xiangqi_rooms` / `mario_rooms` | 云开发控制台新建集合 |
| `数据库缺少索引` | 老版本查询用了 where+orderBy | 已改成 roomNo 单字段查询；若仍报，给 roomNo 建单字段索引 |
| `云环境配置错误` | `app.js` 里的 env 与实际云环境不一致 | 改成自己的云环境 ID |

**关键**：本项目是「双方直接读写同一房间文档」的架构，不是 creator-only。
权限必须是「所有用户可读写」，否则加入方读不到房、也写不进座位和走子。

**联机后看不到对方动**：先看马里奥 HUD 的同步计数：

- 房主显示 `发Wx 收Iy`，客人显示 `发Iy 收Wx`
- 两边 `发` 都在涨但 `收` 一直是 0 → 房间文档 ID 不一致，或读取权限/云环境不一致
- 一边 `发` 一直是 0 → 该侧没进入 online 模式或 `_roomId` 为空
- 两边收发都在涨但人物不动 → 应用/插值问题，把计数和 `[mario] sync` 日志发出来

---

## 七、自测工具

```
node tools/wx_compat_check.js     # SWC 白屏陷阱（数组解构/对象展开/可选链）
node tools/wx_require_check.js    # 分包 require 相对路径（少写一级就白屏）
node tools/gomoku_ai_test.js      # 五子棋 AI 27 项（含 AI vs AI 自我对局）
node tools/xiangqi_logic_test.js  # 象棋规则 133 项
node tools/xiangqi_ai_test.js     # 象棋 AI 22 项
node tools/mario_logic_test.js    # 马里奥引擎 94 项（含双跑确定性）
node tools/mario_sync_test.js     # 马里奥联机同步 25 项
node tools/mario_level_test.js    # 马里奥关卡 13 项（含 5 关端到端通关 + 旗杆完整流程）
node tools/mario_mechanics_test.js # 马里奥机制 48 项
node tools/mario_render_test.js   # 马里奥渲染 8 项（角色必须画出来）
node tools/mario_features_test.js # 马里奥扩展玩法 29 项（管道/金币房/食人花/星星/1UP/隐藏砖/电脑对手）
node tools/mario_page_check.js    # 页面-引擎一致性 19 项（含竞速蓝屏回归）
node tools/wxml_event_audit.js    # WXML 事件处理函数是否都在 JS 里定义
node tools/wxml_data_audit.js     # WXML 数据字段是否都在 data/setData 里
node tools/game_page_flow_test.js # 页面流程 34 项（难度选择/悔棋/联机守卫/画布重建/watcher）
node tools/roomkit_join_test.js   # 联机加入查询 16 项（房间号补零/24h过期/权限/集合）
node tools/roomkit_sync_test.js   # 联机同步兜底 14 项（watch 不支持时轮询仍可用）
node tools/join_arg_test.js       # 加入参数 13 项（bindtap 事件对象 / 分享自动加入）
node tools/mario_online_flow_test.js # 马里奥联机页面同步 26 项（输入中继/独立输入文档/闭环/mode/边沿锁存/收发计数）
```

所有测试都是纯 node 可跑，不需要开微信开发者工具。

---

## 八、上线前待办

1. **云开发后台创建三个集合**：`xiangqi_rooms`、`mario_rooms`（`gomoku_rooms` 已存在）
   —— 不建集合则新游戏能建房但加入方读不到
2. **房间集合权限必须是「所有用户可读、所有用户可写」**
   （云开发控制台 → 数据库 → 集合 → 权限设置；自定义规则等价于 `{ "read": true, "write": true }`）
   **千万不要设成「仅创建者可读写」**：加入方需要读取房主创建的房间，
   还要写入座位/走子/世界状态。设成 creator-only 后，加入方会看到
   「房间不存在或无权读取」，所有联机都无法加入。
   `gomoku_rooms`、`xiangqi_rooms`、`mario_rooms` 三个集合都要这样设。
3. **旧房间清理**：可加定时云函数删除 24h 前的房间，以及 `{roomId}_input` 输入文档，避免集合无限增长
4. **真机联调**：watch 行为在模拟器与真机上有差异，马里奥/象棋联机必须两台真机验证
5. **主包体积**：当前新增只进分包，主包余量仍约 320KB

---

## 九、踩过的坑（改代码前先读）

| 坑 | 现象 | 对策 |
|---|---|---|
| SWC 编译 runtime helper | 数组解构/对象展开/可选链 → 页面白屏 | 一律用索引访问/`Object.assign`，跑 `wx_compat_check` |
| 分包 require 少一级 | Node 里不报错，小程序运行时才白屏 | 分包引用主包 utils 要往上三级 |
| 云数据库嵌套数组 | 不能直接 update 数组字段 | 序列化成字符串（boardStr/world） |
| watch 断链 | 界面永久卡住 | 指数退避重连 3 次 → 降级轮询兜底 |
| 象棋 `isInCheck` 全盘扫描 | 初始局面跑 20s+ | 改为从目标格反向探查 |
| 马里奥 `onGround` 用身体盒探测 | 走出平台边缘仍判落地 | 改用脚下一行薄探针 |
| 马里奥踩头容差过松 | 侧面蹭到也判踩头，敌人白死 | 加「踩入深度 < 敌人高度 3/4」 |
| 移动平台不承载玩家 | 站上去几帧就掉 | 记录平台上帧位移，叠加到玩家坐标 |
| WXML 绑了不存在的方法 | 点击时报 `is not a function`（象棋难度页） | `wxml_event_audit.js` 静态扫描 |
| AI 计时器跨局存活 | 重开/悔棋后 AI 把棋子下到新棋盘 | `_stopAIThink()` + token 作废旧回调 |
| 开局时关掉 watch | 联机只有一方能看到对方落子 | 等待页→对局时保持 watcher |
| 画布节点被 wx:if 重建 | 再进对局棋盘/画面全空 | 离开对局时 `_resetCanvas()` |
| 联机点重开/悔棋 | 本地棋盘与云端分叉 | 联机模式直接拦截并提示 |
| `bindtap="joinRoom"` 把事件对象当房间号 | 所有联机点加入都提示「请输入4位房间号」 | `joinRoom` 只接受字符串参数，其余回退 `roomNoInput` |
| 玩过单机后直接联机 | `mode` 还是 `solo`，不写 world/input2，对方永远不动 | 建房/加入/房主开局都强制 `mode='online'` |
| 双端各 5Hz 写同一房间文档 | 单文档 10 次/秒，被云数据库限流，对方像卡死 | 每人 2.5Hz（合计 5Hz），跳/下用边沿锁存，失败再降频 |
| 分不清是延迟还是断链 | 看不到对方动，不知道同步有没有到 | HUD 显示「发W/收I」计数；3 秒无新数据自动重启 watch/轮询并显示「同步中断」 |
| 旗杆判定只看 `onFlag` | 单机抓杆后关卡不结束，看起来像卡死 | 单机只生成 P1；过关必须等到 `state==='done'`；城堡列要排除末段阶梯 |

---

## 十、开发者工具里的三条「吓人但无害」的报错

在开发者工具 3.17.2 + Windows 上，热重载/重新编译时常见这三条，**都不是本项目代码抛的**：

| 报错 | 结论 | 怎么确认/处理 |
|---|---|---|
| `Cannot read properties of null (reading 'screenHeight')` | 基础库内部错误。调用栈全在 `WAServiceMainContext.js`；项目里没有任何地方直接读 `screenHeight`，所有 `getWindowInfo/getSystemInfoSync` 调用都有 try/catch + 空值兜底（`wx_page_check.js` 会拦） | 关闭「自动热重载」后重新编译；或换调试基础库 3.7.x / 3.8.x |
| `Page route 错误(system error)` | 热重载时旧 webview 还没销毁，基础库收尾失败 | 同上。功能正常时可直接忽略 |
| `routeDone with a webviewId N is not found` | 与上一条同源；项目里只有五子棋会主动 `navigateBack`，且已改成 `safeBackToLobby`（先查页面栈、失败延迟 60ms 再 switchTab），马里奥/象棋页面没有任何 `navigateBack` 调用 | 关闭自动热重载；若仍出现，确认页面是否还能正常操作，能则为基础库噪音 |

判断标准：**报错弹出时功能是否正常**（能建房间、能走、能顶砖）。功能正常就不用管；如果功能也卡住，再把控制台完整日志发出来。

