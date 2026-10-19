# 小笨游戏大厅 · 联机五子棋

## 新增内容

| 模块 | 文件 | 说明 |
|---|---|---|
| 游戏 tab | `app.json` | 底部第4个 tab「游戏」，图标 `assets/tab_games.png` |
| 云初始化 | `app.js` | `wx.cloud.init`，环境 `cloudbase-d4gqowrctd9dac09f` |
| 游戏大厅 | `pages/games/` | 「小笨游戏大厅」，数据驱动 GAMES 数组 |
| 小笨五子棋 | `subpackages/games/gomoku/` | 分包加载，房间制联机对战 |
| 素材 | `assets/avatar_a.gif` `avatar_b.gif` | 双方形象（随机分配） |
| 逻辑单测 | `tools/gomoku_logic_test.js` | 胜负判定/悔棋/房间号 10 项测试 |

## 云数据库

- **集合**：`gomoku_rooms`（需手动在云开发后台创建）
- **权限**：所有用户可读可写（体验版自用）
- 房间字段：`roomNo / status / avatars / board / history / turn / lastMove / winner / moveCount / undoRequest / rematchRequest / poke / round`

## 功能

- 创建/加入 4 位房间号；分享卡片直达房间
- Canvas 15×15 棋盘，落子实时同步（watch）
- 悔棋：只能撤回自己上一手，需对方同意，支持连续悔棋（history 弹栈）
- 戳一戳：10 秒冷却，对方收到震动 + 浮层提示
- 再来一局：需对方同意，棋盘重置
- 双方形象随机分配（两张一二布布 GIF）

## 上线前待办（体验版无需处理）

1. 云开发后台创建 `gomoku_rooms` 集合，权限设为「所有用户可读可写」
2. 正式版需收紧数据库安全规则
3. 旧房间清理（可加定时云函数）
