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
  MARIO_SYNC_MS: 200,                 // 云同步周期 5Hz
  MARIO_SYNC_SLOW_MS: 400,            // 写失败降频：2.5Hz
  MARIO_SYNC_MIN_MS: 1000,            // 再失败降频：1Hz
  MARIO_INTERP_MS: 160,               // guest 端对 host 实体的插值窗口
  MARIO_LIVES: 3,                     // 每人命数
  MARIO_LEVEL_COUNT: 5,               // 关卡数
  MARIO_BOSS_HITS: 3,                 // Boss 需踩头次数
  MARIO_DEATH_RESPAWN_MS: 900,        // 死亡到重生的间隔

  // 云存储
  CLOUD_CACHE_TTL: 5000,      // 短缓存，避免 tab 反复切换重复拉取
  MENU_CACHE_TTL: 30 * 1000   // 菜单缓存
};
