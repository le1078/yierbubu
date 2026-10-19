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

  // 云存储
  CLOUD_CACHE_TTL: 5000,      // 短缓存，避免 tab 反复切换重复拉取
  MENU_CACHE_TTL: 30 * 1000   // 菜单缓存
};
