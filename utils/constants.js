// 全局常量：替代散落各文件的魔法数字
module.exports = {
  // 摇一摇
  SHAKE_TICKS: 10,            // 滚动次数
  SHAKE_INTERVAL: 60,         // 每次滚动间隔 ms
  SHAKE_RECORD_MAX: 15,       // 首页最多展示几条记录

  // 刮刮卡
  SCRATCH_REVEAL_RATIO: 0.7,  // 刮开比例阈值
  SCRATCH_SAMPLE_STEP: 48,    // 像素采样步长
  SCRATCH_CHECK_EVERY: 6,     // 每 N 次 touchmove 检测一次
  SCRATCH_MAX_DPR: 2,
  SCRATCH_INIT_RETRY: 10,     // canvas 就绪重试次数
  SCRATCH_RETRY_DELAY: 40,    // 重试间隔 ms

  // 回收站 / 列表上限
  TRASH_MAX: 100,
  ORDER_MAX: 100,
  RECENT_MAX: 3,              // 首页「最近」展示条数
  TITLE_MAX: 42,              // 清单标题截断长度
  URL_MAX: 28,                // 链接展示截断长度

  // 生肖贴纸
  STICKER_MIN_POOL: 2,        // 少于这个数就不做「不重复」随机

  // 五子棋
  ROOM_NO_MAX: 9999,
  ROOM_EXPIRE_MS: 24 * 3600 * 1000,   // 房间过期时间
  UNDO_TIMEOUT_MS: 60 * 1000,         // 悔棋/先手/再来一局申请超时
  POKE_COOLDOWN: 640,                 // 戳一戳冷却 ms
  CANVAS_RETRY_MAX: 20,
  CANVAS_RETRY_DELAY: 60,
  CHAT_MAX: 100,

  // 五子棋 AI
  GOMOKU_AI_THINK_MS: 320,            // 「思考中」最短展示时长，避免 AI 瞬移出招显得突兀
  GOMOKU_AI_DEPTH_EASY: 1,            // 简单：只看一步棋型
  GOMOKU_AI_DEPTH_NORMAL: 2,          // 普通：两步搜索
  GOMOKU_AI_DEPTH_HARD: 4,            // 困难：四步 + 迭代加深
  GOMOKU_AI_BUDGET_MS: 700,           // 困难难度的时间预算上限
  GOMOKU_AI_CANDIDATE_RADIUS: 2,      // 候选点裁剪半径（已有棋子周围 N 格内）
  GOMOKU_AI_CANDIDATE_MAX: 40,        // 候选点数量上限，超出按启发分截断

  // 中国象棋
  XQ_COLS: 9,                         // 棋盘宽 9 列
  XQ_ROWS: 10,                        // 棋盘高 10 行
  XQ_MOVE_TIMEOUT_MS: 60 * 1000,      // 悔棋/再来一局申请超时
  XQ_AI_THINK_MS: 400,                // 「思考中」最短展示时长
  XQ_AI_DEPTH_EASY: 1,
  XQ_AI_DEPTH_NORMAL: 2,
  XQ_AI_DEPTH_HARD: 4,
  XQ_AI_BUDGET_MS: 900,               // 困难难度搜索时间预算
  XQ_MAX_NO_CAPTURE: 120,             // 自然限着：双方 120 回合无吃子判和

  // 马里奥
  MARIO_TICK_MS: 1000 / 60,           // 固定物理步长 60Hz（host/guest 必须完全一致才谈得上预测）
  // 同一房间文档由 host 写 world、guest 写 input2，两个写者合计才是文档写入频率。
  // 云数据库单文档持续写入 >5 次/秒容易被限流，所以每人 2.5Hz（合计 5Hz）。
  MARIO_SYNC_MS: 400,                 // 每人 2.5Hz（双人合计 5Hz）
  MARIO_SYNC_SLOW_MS: 800,            // 写失败降频：每人 1.25Hz
  MARIO_SYNC_MIN_MS: 1600,            // 再失败降频（也是退避上限）：每人 0.625Hz
  MARIO_LIVES: 3,                     // 每人命数
  MARIO_DEATH_RESPAWN_MS: 900,        // 死亡到重生的间隔

  // 自建 WebSocket 实时中继（server/mario-relay/，部署在你的云机器上）。
  // 云数据库限流是同步中断的根因；中继没有配额限制，延迟也从 200~500ms 降到几十 ms。
  // 生产需 wss://已备案域名（小程序后台配 socket 合法域名）；
  // 开发调试用 ws://（开发者工具勾选「不校验合法域名」）。
  // 留空 '' = 不用中继，走云数据库同步（老通道，仍完整可用）。
  // 已部署（2026-10-24）：腾讯云 root@81.70.22.49，systemd 服务名 mario-relay，
  // nginx 按机房惯例把随机前缀反代到 127.0.0.1:9000（配置在 litellm.conf）。
  MARIO_RELAY_URL: 'ws://81.70.22.49/e8f31a5c27/',
  MARIO_RELAY_WORLD_MS: 150,          // 中继模式：host 世界快照 ~6.7Hz
  MARIO_RELAY_INPUT_MS: 100,          // 中继模式：guest 输入上报 10Hz
  MARIO_RELAY_DB_HEARTBEAT_MS: 2000,  // 对端也在中继上时，云数据库兜底降为 0.5Hz 心跳

  // 云存储
  CLOUD_CACHE_TTL: 5000,      // 短缓存，避免 tab 反复切换重复拉取
  MENU_CACHE_TTL: 30 * 1000   // 菜单缓存
};
