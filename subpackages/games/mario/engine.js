// 马里奥横版平台跳跃引擎（纯逻辑，无 wx 依赖，可 node 单测）。
//
// 设计约束：这是联机游戏的核心，host 和 guest 必须跑出完全相同的结果，
// 否则客户端预测会和权威状态对不上。所以：
//   1. 固定步长物理：所有调用方按 TICK = 1/60 秒推进，绝不依赖真实帧率
//   2. 纯函数式状态：step 系列函数只读写传入的 level/player，不碰外部变量
//   3. 不用 Math.random() —— 敌人 AI 与砖块掉落都用确定性规则
//
// 坐标系统：单位 = 格（tile），1 格 = 16 逻辑单位。
//   x = 玩家中心；y = 玩家脚底。向右为 x 正，向下为 y 正。
//
// 对齐正版 SMB1 的机制清单：
//   · 变身链：小马里奥 → 超级马里奥（蘑菇）→ 火焰马里奥（花）
//   · 受伤：超级/火焰 → 小（掉一级），小 → 死；受伤后 2 秒无敌闪烁
//   · 火球：火焰状态下按跑键发射，最多 2 颗同屏，落地弹跳
//   · 乌龟：踩一脚变壳，再踩一脚踢出去，壳能撞死其他敌人并连锁
//   · 砖块：小的顶一下，超级状态可顶碎；问号砖出蘑菇/花/金币
//   · 死亡：向上弹起后坠出屏幕，再回检查点重生
//   · 计分：金币 200、踩敌 100、连踩递增、顶砖 50

const C = require('../../../utils/constants.js');

const TICK = 1 / 60;

/* ========== 物理常量 ========== */
// 按正版 SMB1 实测数据（像素/帧 @60fps，1 格 = 16px）换算成格/秒。
// 实测结果：满跳 4.2 格高、走路跳约 6.3 格 / 奔跑跳约 10 格。
const PHYS = {
  GRAVITY: 44,            // 重力加速度（格/秒²）
  GRAVITY_HOLD: 28,       // 按住跳跃键时的重力（跳得更高）
  MAX_FALL: 22,           // 最大下落速度
  WALK_ACCEL: 42,         // 走路加速度（起步有点惯性）
  WALK_MAX: 5.9,          // 最大走路速度
  RUN_MAX: 9.6,           // 奔跑最大速度
  FRICTION: 34,           // 地面摩擦（松手后滑行约 3 格）
  ICE_FRICTION: 8,        // 冰面摩擦（比地面滑，但不至于失控）
  AIR_CONTROL: 0.62,      // 空中操控系数（比地面弱，跳出去后难改向）
  JUMP_VEL: 15.6,         // 起跳初速度（按住跳约 4.2 格，正版小马力欧约 4 格）
  COYOTE: 0.08,           // 土狼时间：离地后仍可起跳的宽限（秒）
  BUFFER: 0.10,           // 跳跃缓冲：落地前按跳也能起跳（秒）
  STOMP_BOUNCE: 12.0,     // 踩敌反弹速度
  STOMP_BOUNCE_HELD: 15.0,// 踩敌时按住跳跃键反弹更高（正版行为）
  DEATH_FALL_Y: 17,       // 掉出地图即死的 y 阈值
  // 火球
  FIREBALL_SPEED: 6.5,
  FIREBALL_BOUNCE: 7.5,
  FIREBALL_MAX: 2,        // 同屏最多 2 颗（正版）
  FIREBALL_LIFE: 3.0,
  FIRE_COOLDOWN: 0.22,    // 发射冷却
  // 无敌
  INVULN_TIME: 2.0,       // 受伤后无敌时长（正版约 2 秒）
  // 龟壳
  SHELL_SPEED: 9.0,
  SHELL_RECOVER: 6.0,     // 踩成壳后多久自动爬出来
  SHELL_KICK_GRACE: 0.35  // 刚变成壳时的免踢窗口（防止连踩即飞）
};

/* ========== 瓦片类型 ========== */
const T = {
  EMPTY: '.', GROUND: '#', BRICK: 'B', QUESTION: '?',
  SPIKE: 'S', PIPE: 'P', FLAG: 'F', ICE: 'I', PLATFORM: '=', LIFT: '^',
  USED: 'U',      // 顶过的砖（空砖）
  HARD: 'X',      // 硬砖（阶梯/城堡/顶棚，不可破坏）
  COINBRICK: 'C', // 多金币砖（连顶最多 10 次）
  FLAGBASE: 'f',  // 旗杆底座
  HIDDEN: 'H'     // 隐藏砖（不画出来，顶一下才显形）
};

// 多金币砖最多出几枚（正版 1-1 的金币砖可顶 10 次）
const COINBRICK_MAX = 10;

// 实心瓦片（会阻挡移动）
const SOLID = {};
SOLID[T.GROUND] = true;
SOLID[T.BRICK] = true;
SOLID[T.QUESTION] = true;
SOLID[T.PIPE] = true;
SOLID[T.ICE] = true;
SOLID[T.PLATFORM] = true;
SOLID[T.LIFT] = true;
SOLID[T.USED] = true;
SOLID[T.HARD] = true;      // 硬砖（阶梯/城堡/顶棚，不可破坏）
SOLID[T.COINBRICK] = true;  // 多金币砖
// 注意：隐藏砖 H 不进 SOLID —— 正版里隐藏砖平时完全虚化
// （不挡移动、可从任意方向穿过），只有从下方顶到才显形变实心。
// 之前把它设成实心，玩家会被看不见的墙挡住、甚至站在空气上。

// 尖刺不阻挡移动，但是致命
const DEADLY = {};
DEADLY[T.SPIKE] = true;

/* ========== 敌人类型 ========== */
const E = {
  GOOMBA: 'goomba',   // 走怪：左右巡逻，踩一下死
  TURTLE: 'turtle',   // 乌龟：巡逻，踩一下变壳，再踩踢出去
  FLYER: 'flyer',     // 飞行怪：正弦上下浮动
  PIRANHA: 'piranha'  // 食人花：从管道口周期冒出，不能踩，怕火球
};

/* ========== 玩家形态 ========== */
const FORM = {
  SMALL: 0,   // 小马里奥
  SUPER: 1,   // 超级马里奥（大）
  FIRE: 2     // 火焰马里奥（大 + 可发火球）
};

/* ========== 工具 ========== */

function makeGrid(rows) {
  const grid = [];
  for (let r = 0; r < rows.length; r++) {
    grid.push(rows[r].split(''));
  }
  return grid;
}

function gridRows(grid) {
  const out = [];
  for (let r = 0; r < grid.length; r++) out.push(grid[r].join(''));
  return out;
}

function tileAt(grid, col, row) {
  if (row < 0 || row >= grid.length) return T.EMPTY;
  const line = grid[row];
  if (col < 0 || col >= line.length) return T.GROUND;   // 左右边界视作实心
  return line[col];
}

function isSolid(grid, col, row) {
  return !!SOLID[tileAt(grid, col, row)];
}

function inGrid(grid, c, r) {
  return r >= 0 && r < grid.length && c >= 0 && c < grid[r].length;
}

// 碰撞盒是否与任何实心瓦片重叠？
//
// 边界约定（关键）：瓦片 row r 占据纵向区间 [r, r+1)。
// 碰撞盒 [y, y+h) 与之重叠的条件是 y < r+1 且 y+h > r，
// 因此行的取值范围是 ceil(y-1) .. ceil(y+h-1)-1。
// 直接用 floor(y)/floor(y+h) 会让「脚底正好等于地面行号」时
// 把脚下那一行也算作重叠 —— 玩家一落地就被地面挡住，站着不能动。
function boxHitsSolid(grid, x, y, w, h) {
  const c0 = Math.floor(x + 0.0001), c1 = Math.floor(x + w - 0.0001);
  const r0 = Math.ceil(y - 1 + 0.0001), r1 = Math.ceil(y + h - 1 - 0.0001);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (isSolid(grid, c, r)) return true;
    }
  }
  return false;
}

// 碰撞盒是否与尖刺重叠
function boxHitsDeadly(grid, x, y, w, h) {
  const c0 = Math.floor(x), c1 = Math.floor(x + w - 0.0001);
  const r0 = Math.floor(y), r1 = Math.floor(y + h - 0.0001);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (DEADLY[tileAt(grid, c, r)]) return true;
    }
  }
  return false;
}

// 是否碰到终点旗（旗杆本体 F 和底座 f 都算）
function boxHitsFlag(grid, x, y, w, h) {
  const c0 = Math.floor(x), c1 = Math.floor(x + w - 0.0001);
  const r0 = Math.floor(y), r1 = Math.floor(y + h - 0.0001);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const ch = tileAt(grid, c, r);
      if (ch === T.FLAG || ch === T.FLAGBASE) return true;
    }
  }
  return false;
}

// 脚下所在瓦片（用于判断冰面）
function groundTileAt(grid, x, y, w, h) {
  const row = Math.floor(y + h + 0.02);
  const c0 = Math.floor(x + 0.02), c1 = Math.floor(x + w - 0.02);
  const counts = {};
  for (let c = c0; c <= c1; c++) {
    const t = tileAt(grid, c, row);
    counts[t] = (counts[t] || 0) + 1;
  }
  let best = T.EMPTY, bestN = 0;
  for (const k in counts) {
    if (counts[k] > bestN) { bestN = counts[k]; best = k; }
  }
  return best;
}

function boxesOverlap(a, b) {
  return a.x - a.w / 2 < b.x + b.w / 2 && a.x + a.w / 2 > b.x - b.w / 2 &&
         a.y - a.h / 2 < b.y + b.h / 2 && a.y + a.h / 2 > b.y - b.h / 2;
}

// 玩家的 p.y 是脚底（AABB 底边），敌人/道具/火球的 y 是中心。
// 不能直接用 boxesOverlap（它把 a.y 当中心），否则玩家从敌人头顶跳过时
// 会被判定成撞到侧面而受伤。
function playerOverlaps(p, b) {
  return p.x - p.w / 2 < b.x + b.w / 2 && p.x + p.w / 2 > b.x - b.w / 2 &&
         p.y - p.h < b.y + b.h / 2 && p.y > b.y - b.h / 2;
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

/* ========== 分数飘字（纯表现，但在引擎里生成保证两端一致） ========== */

// 加分时头顶飘出「+200」小字（正版 SMB1 的经典反馈）
function addPopup(level, x, y, text) {
  if (!level.popups) level.popups = [];
  if (level.popups.length > 12) level.popups.shift();   // 防极端刷屏
  level.popups.push({ x, y, text: String(text), t: 0 });
}

function stepPopups(level, dt) {
  if (!level.popups || !level.popups.length) return;
  const keep = [];
  for (const p of level.popups) {
    p.t += dt;
    if (p.t < 0.9) keep.push(p);
  }
  level.popups = keep;
}

/* ========== 事件钩子（音效/震动的来源，页面层订阅） ========== */
// 页面把回调挂到 level.onEvent 上即可；引擎内只 emit 不实现，
// 保持纯逻辑可单测。事件名固定小写字符串。
function emit(level, name, x, y) {
  // level 可能为 null（手工构造的玩家对象没有 .level 引用）；
  // 属性访问必须在判空之后，否则 null.onEvent 直接抛错，
  // 而 hurtPlayer 等调用点跑在主循环里 —— 一崩就是整局卡死
  if (!level || !level.onEvent) return;
  try { level.onEvent(name, x, y); } catch (e) { /* 表现层异常不影响模拟 */ }
}

/* ========== 关卡装载 ========== */

// 把 ASCII 地图 + spec 组装成可模拟的关卡状态
function loadLevel(rows, spec) {
  const grid = makeGrid(rows);
  const coins = [];
  const coinList = spec.coins || [];
  for (let i = 0; i < coinList.length; i++) {
    coins.push({ id: i, col: coinList[i].col, row: coinList[i].row, taken: false });
  }
  const enemies = [];
  const eList = spec.enemies || [];
  for (let i = 0; i < eList.length; i++) {
    const e = eList[i];
    enemies.push({
      id: i,
      type: e.type,
      x: e.col + 0.5,
      y: e.row + 0.5,
      w: 0.8, h: 0.8,
      vx: (e.type === E.FLYER || e.type === E.PIRANHA) ? 0 : -1.0,
      vy: 0,
      dir: -1,
      homeX: e.col + 0.5,
      homeY: e.row + 0.5,
      range: e.range || 3,
      phase: (i * 37) % 100 / 100 * Math.PI * 2,
      alive: true,
      // 龟壳状态机：'walk' 走路 | 'shell' 静止壳 | 'slide' 滑行壳
      shell: 'walk',
      shellT: 0,
      kicker: 0,        // 最后一个踢壳的玩家座位（防止自己被刚踢的壳撞死）
      kickT: 0,
      emerge: 0         // 食人花：0 缩在管道里 / 1 完全冒出
    });
  }
  const platforms = [];
  const pList = spec.platforms || [];
  for (let i = 0; i < pList.length; i++) {
    const p = pList[i];
    platforms.push({
      id: i,
      x: p.col + 0.5, y: p.row + 0.5,
      w: 1.6, h: 0.4,
      axis: p.axis, len: p.len, speed: p.speed,
      homeX: p.col + 0.5, homeY: p.row + 0.5,
      // 从三角波的零偏移相位起步（t=0 时 off=-len/2，平台会瞬间跳半程），
      // 取 1/4 周期处 off=0，出生位置 = homeX 且之后平滑移动
      t: ((p.len * 2) / p.speed) * 0.25
    });
  }
  const items = [];
  const iList = spec.items || [];
  for (let i = 0; i < iList.length; i++) {
    const it = iList[i];
    items.push({
      id: i,
      type: it.type,          // 'mushroom' | 'flower' | 'star' | 'oneup'
      x: it.col + 0.5, y: it.row + 0.5,
      w: 0.7, h: 0.7,
      vx: it.type === 'flower' ? 0 : (it.type === 'star' ? 2.2 : 1.2),
      vy: 0,
      active: true,
      emerge: it.type === 'flower' ? 0.5 : 0  // 花从砖里冒出来的过程（简化：直接出现）
    });
  }
  // Boss 数组化：一关可以塞多个 Boss（双头城堡关 boss + boss2）。
  // level.boss 保留 = bosses[0] 的引用，老代码（单 Boss 逻辑/渲染/同步）
  // 不用改；bosses 数组供「全部 Boss 血条/全灭判定」使用。
  const bosses = [];
  const makeBoss = (bs) => ({
    x: bs.col + 0.5, y: bs.row + 0.5,
    w: 2.0, h: 1.8,
    hp: bs.hp, phase: 1,
    vx: 0, vy: 0, dir: -1,
    hurtT: 0, tick: 0,
    fireCd: 0,
    homeX: bs.col + 0.5   // 一阶段巡逻的锚点（以出生点为中心）
  });
  if (spec.boss) bosses.push(makeBoss(spec.boss));
  if (spec.boss2) bosses.push(makeBoss(spec.boss2));
  const boss = bosses.length ? bosses[0] : null;

  // 多金币砖的剩余次数（按 "row_col" 索引）—— 顶一次出一枚，最多 10 枚
  const blockState = {};
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      if (grid[r][c] === T.COINBRICK) blockState[r + '_' + c] = COINBRICK_MAX;
    }
  }

  // 管道传送点：spec 里只给列，这里解析出管道口所在的行。
  const warps = [];
  const wList = spec.warps || [];
  for (let i = 0; i < wList.length; i++) {
    const w = wList[i];
    const width = w.width || 2;
    let topRow = -1;
    for (let r = 0; r < grid.length && topRow < 0; r++) {
      for (let c = w.col; c < w.col + width; c++) {
        if (grid[r][c] === T.PIPE) { topRow = r; break; }
      }
    }
    if (topRow >= 0) {
      warps.push({
        col: w.col, width: width, topRow: topRow,
        toX: w.toX, toY: w.toY, label: w.label || ''
      });
    }
  }
  const blockItems = spec.blockItems || {};

  return {
    grid,
    rows: gridRows(grid),
    cols: grid[0].length,
    rowsH: grid.length,
    coins, enemies, platforms, items, boss, bosses,
    blockState, warps, blockItems,
    bonusStart: spec.bonusStart || -1,
    fireballs: [],
    popups: [],                          // 分数飘字（+200 之类）
    start: spec.start || { col: 2, row: 14 },
    checkpoints: spec.checkpoints || [],
    name: spec.name || '',
    theme: spec.theme || 'overworld',   // overworld | underground | castle
    time: 0,
    timeLimit: spec.timeLimit || 400,   // 关卡限时（重生复位用）
    timeLeft: spec.timeLimit || 400,    // 关卡倒计时（秒）
    timeAcc: 0,
    flagY: -1,                          // 旗杆顶端行（用于下滑动画）
    clearPhase: 0                       // 0 正常 / 1 旗杆下滑 / 2 走向城堡 / 3 结算
  };
}

/* ========== 玩家 ========== */

function makePlayer(level, seat) {
  const pl = {
    seat,
    // 坐标约定：x 是中心，y 是脚底。start.row 是「站立的地面行」，脚底 y = start.row
    x: level.start.col + 0.5,
    y: level.start.row,
    w: 0.7, h: 0.9,
    vx: 0, vy: 0,
    face: 1,
    onGround: false,
    form: FORM.SMALL,       // 0 小 / 1 超级 / 2 火焰
    hurtT: 0,               // 无敌时间（受伤后闪烁）
    starT: 0,               // 星星无敌剩余时间（碰到敌人直接撞飞）
    warpLock: 0,            // 管道传送后的短暂锁，防止连续触发
    coyote: 0,
    buffer: 0,
    jumpHeld: false,
    jumpPressT: 0,          // 跳跃键按下多久（控制踩敌反弹高度）
    lives: C.MARIO_LIVES,
    infiniteLives: false,   // 无限生命模式：死亡重生不减命（页面层设置）
    coins: 0,
    score: 0,
    combo: 0,               // 连踩计数（不落地连续踩敌）
    state: 'alive',         // alive | dying | dead | done
    deathT: 0,
    fellInPit: false,
    fireCd: 0,
    respawnX: level.start.col + 0.5,
    respawnY: level.start.row,
    finishT: 0,
    onFlag: false,          // 是否已抓住旗杆
    growT: 0
  };
  // 受伤/死亡音效要从 hurtPlayer 里发，这里带上 level 引用
  pl.level = level;
  return pl;
}

function makeInput() {
  return { left: false, right: false, up: false, down: false, run: false };
}

// 玩家当前高度（小形态 0.9 格，大形态 1.6 格）
function playerHeight(form) {
  return form === FORM.SMALL ? 0.9 : 1.6;
}

/* ========== 玩家物理 ========== */

// 形态变化时调整碰撞盒高度，保持脚底不动（正版变大时是向上长的）
function setForm(p, form) {
  const oldH = p.h;
  p.form = form;
  p.h = playerHeight(form);
  // 脚底 y 不变，头顶自然上移
  p.growT = 0.35;
  return oldH;
}

function stepPlayer(level, p, input, dt) {
  if (p.state === 'dying') {
    p.deathT += dt;
    // 正版死亡动画：先向上弹起，再加速下坠出屏幕。
    // 掉坑死亡不播这个动画（角色已经在屏幕外了）。
    if (!p.fellInPit) {
      p.vy += PHYS.GRAVITY * 0.55 * dt;
      p.y += p.vy * dt;
    }
    if (p.deathT > C.MARIO_DEATH_RESPAWN_MS / 1000) {
      // 无限生命模式：不减命，永远重生（情侣休闲用）
      if (!p.infiniteLives) p.lives -= 1;
      p.deathT = 0;
      if (p.lives > 0 || p.infiniteLives) {
        p.state = 'alive';
        p.x = p.respawnX;
        p.y = p.respawnY;
        p.vx = 0; p.vy = 0;
        p.hurtT = 1.2;
        p.form = FORM.SMALL;
        p.h = playerHeight(FORM.SMALL);
        p.fellInPit = false;
        p.onGround = false;
        p.combo = 0;
        // 时间耗尽导致团灭后重生：倒计时必须复位。否则 timeLeft 永远停在 0，
        // HUD 一直显示 ⏱0（红色紧急态），而关卡实际上再也没有时限。
        // 正常死亡（掉坑/被撞）不动倒计时，避免用送死刷时间。
        if (level.timeLeft <= 0) {
          level.timeLeft = level.timeLimit || 400;
          level.timeAcc = 0;
        }
      } else {
        p.state = 'dead';
      }
    }
    return;
  }
  if (p.state === 'dead' || p.state === 'done') return;

  if (p.hurtT > 0) p.hurtT -= dt;
  if (p.starT > 0) p.starT -= dt;
  if (p.warpLock > 0) p.warpLock -= dt;
  if (p.growT > 0) p.growT -= dt;
  if (p.fireCd > 0) p.fireCd -= dt;

  const onIce = p.onGround && groundTileAt(level.grid, p.x - p.w / 2, p.y - p.h, p.w, p.h) === T.ICE;

  // 水平操控
  // 星星无敌期间跑得更快（正版行为：BGM 变快、速度提升）
  const starBoost = p.starT > 0 ? 1.3 : 1;
  const accel = PHYS.WALK_ACCEL * (p.onGround ? 1 : PHYS.AIR_CONTROL);
  const maxSpeed = (input.run ? PHYS.RUN_MAX : PHYS.WALK_MAX) * starBoost;
  if (input.left && !input.right) {
    p.vx -= accel * dt;
    p.face = -1;
  } else if (input.right && !input.left) {
    p.vx += accel * dt;
    p.face = 1;
  } else if (p.onGround) {
    const f = (onIce ? PHYS.ICE_FRICTION : PHYS.FRICTION) * dt;
    if (p.vx > 0) p.vx = Math.max(0, p.vx - f);
    else if (p.vx < 0) p.vx = Math.min(0, p.vx + f);
  }
  if (p.vx > maxSpeed) p.vx = Math.max(maxSpeed, p.vx - accel * dt * 2);
  if (p.vx < -maxSpeed) p.vx = Math.min(-maxSpeed, p.vx + accel * dt * 2);

  // 跳跃：土狼时间 + 输入缓冲
  if (input.up && !p.jumpHeld) {
    p.buffer = PHYS.BUFFER;
    p.jumpPressT = 0;
  }
  if (input.up) p.jumpPressT += dt;
  p.jumpHeld = input.up;
  if (p.buffer > 0) p.buffer -= dt;
  if (p.coyote > 0) p.coyote -= dt;
  if (p.onGround) p.coyote = PHYS.COYOTE;

  if (p.buffer > 0 && p.coyote > 0) {
    p.vy = -PHYS.JUMP_VEL;
    p.buffer = 0;
    p.coyote = 0;
    p.onGround = false;
    emit(level, 'jump', p.x, p.y);
  }

  // 重力（松键时重力更大 → 可变跳跃高度）
  const g = (p.vy < 0 && input.up) ? PHYS.GRAVITY_HOLD : PHYS.GRAVITY;
  p.vy += g * dt;
  if (p.vy > PHYS.MAX_FALL) p.vy = PHYS.MAX_FALL;

  // ---- 移动 + 碰撞（分轴解算）----
  const grid = level.grid;

  // X 轴
  let nx = p.x + p.vx * dt;
  if (boxHitsSolid(grid, nx - p.w / 2, p.y - p.h, p.w, p.h)) {
    let lo = 0, hi = p.vx * dt;
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) / 2;
      if (boxHitsSolid(grid, p.x + mid - p.w / 2, p.y - p.h, p.w, p.h)) hi = mid;
      else lo = mid;
    }
    nx = p.x + lo;
    p.vx = 0;
  }
  p.x = nx;

  // Y 轴
  let ny = p.y + p.vy * dt;
  let landed = false;
  if (boxHitsSolid(grid, p.x - p.w / 2, ny - p.h, p.w, p.h)) {
    let lo = 0, hi = p.vy * dt;
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) / 2;
      if (boxHitsSolid(grid, p.x - p.w / 2, p.y + mid - p.h, p.w, p.h)) hi = mid;
      else lo = mid;
    }
    if (p.vy > 0) {
      landed = true;
    }
    ny = p.y + lo;
    p.vy = 0;
    // 向上撞 → 顶到头顶的瓦片（问号砖/金币砖/普通砖）。
    // 必须在把 p.y 更新到碰撞位置之后再调用 hitHeadBlock：
    // 它用 p.y - p.h 算头顶所在行，用旧位置会算到还没碰到的行，永远顶不到。
    if (!landed) {
      // 先临时把 y 设到碰撞后的位置，hitHeadBlock 才能算对头顶所在行
      const oldY = p.y;
      p.y = ny;
      hitHeadBlock(level, p);
      p.y = oldY;   // 后面统一赋值，这里恢复避免重复更新
    }
  }
  // 隐藏砖不挡移动（不在 SOLID），上升时单独探测顶头命中
  if (p.vy < 0) hitHiddenBlock(level, p, ny);
  p.y = ny;

  // 落地状态（脚下薄探针）
  const supportRow = Math.floor(p.y + 0.02);
  const c0 = Math.floor(p.x - p.w / 2 + 0.02);
  const c1 = Math.floor(p.x + p.w / 2 - 0.02);
  let hasSupport = false;
  for (let c = c0; c <= c1; c++) {
    if (isSolid(grid, c, supportRow)) { hasSupport = true; break; }
  }
  if (landed || hasSupport) {
    if (!p.onGround) p.combo = 0;   // 落地清空连踩
    p.onGround = true;
    p.coyote = PHYS.COYOTE;
  } else {
    p.onGround = false;
  }

  // 检查点
  if (level.checkpoints && p.state === 'alive') {
    for (const cp of level.checkpoints) {
      if (Math.abs(p.x - (cp.col + 0.5)) < 0.9 && Math.abs(p.y - (cp.row + 0.5)) < 2.0) {
        p.respawnX = cp.col + 0.5;
        p.respawnY = cp.row;
      }
    }
  }

  // 掉出地图 → 立即死亡（不区分大小形态）
  if (p.y > PHYS.DEATH_FALL_Y && p.state === 'alive') {
    p.state = 'dying';
    p.deathT = 0;
    p.vy = 0;
    p.vx = 0;
    p.fellInPit = true;
    p.combo = 0;
  }
}

/* ========== 火球（玩家发射） ========== */

function spawnFireball(level, p) {
  if (p.form !== FORM.FIRE || p.fireCd > 0) return false;
  const own = level.fireballs.filter(f => f.owner === p.seat).length;
  if (own >= PHYS.FIREBALL_MAX) return false;
  level.fireballs.push({
    x: p.x + p.face * 0.5,
    y: p.y - p.h * 0.5,
    w: 0.35, h: 0.35,
    vx: p.face * PHYS.FIREBALL_SPEED,
    vy: 2,
    life: PHYS.FIREBALL_LIFE,
    owner: p.seat,
    fromPlayer: true
  });
  p.fireCd = PHYS.FIRE_COOLDOWN;
  return true;
}

function stepPlayerFireballs(level, dt) {
  const keep = [];
  for (const f of level.fireballs) {
    if (!f.fromPlayer) { keep.push(f); continue; }
    f.life -= dt;
    f.vy += PHYS.GRAVITY * 0.75 * dt;
    f.x += f.vx * dt;
    f.y += f.vy * dt;
    // 撞墙：反弹（正版火球撞墙会弹回来）
    if (boxHitsSolid(level.grid, f.x - f.w / 2, f.y - f.h / 2, f.w, f.h)) {
      f.x -= f.vx * dt;
      f.vx = -f.vx;
    }
    // 落地弹起
    const belowSolid = boxHitsSolid(level.grid, f.x - f.w / 2, f.y - f.h / 2 + 0.08, f.w, f.h);
    if (f.vy > 0 && belowSolid) {
      f.y -= f.vy * dt;
      f.vy = -PHYS.FIREBALL_BOUNCE;
    }
    if (f.life > 0 && f.y < PHYS.DEATH_FALL_Y) keep.push(f);
  }
  level.fireballs = keep;
}

/* ========== 敌人 ========== */

function stepEnemy(level, e, dt, players) {
  if (!e.alive) return;

  // 食人花：在管道口周期冒出/缩回；玩家靠近时主动缩回
  if (e.type === E.PIRANHA) {
    e.phase += dt;
    const cycle = e.phase % 4.2;
    let up;
    if (cycle < 0.6) up = cycle / 0.6;
    else if (cycle < 2.2) up = 1;
    else if (cycle < 2.8) up = (2.8 - cycle) / 0.6;
    else up = 0;
    let near = false;
    if (players) {
      for (const p of players) {
        if (p.state === 'alive' && Math.abs(p.x - e.x) < 1.6 && p.y > e.homeY - 2) near = true;
      }
    }
    if (near) up = 0;   // 玩家靠近立刻缩回，避免刚站上管道就被咬
    e.emerge = Math.max(0, Math.min(1, up));
    e.y = e.homeY - e.emerge * 0.9;
    e.vx = 0;
    e.vy = 0;
    return;
  }

  // 龟壳：静止壳计时后自动爬出来；滑行壳撞墙反弹
  if (e.shell === 'shell') {
    e.shellT += dt;
    if (e.shellT > PHYS.SHELL_RECOVER) {
      e.shell = 'walk';
      e.shellT = 0;
      e.vx = -PHYS.SHELL_SPEED * 0.25;
      e.dir = -1;
    }
    return;   // 静止壳不动
  }

  if (e.type === E.FLYER) {
    e.x += e.vx * dt;
    if (Math.abs(e.x - e.homeX) > e.range) {
      e.vx = -e.vx;
      e.dir = e.vx > 0 ? 1 : -1;
    }
    e.y = e.homeY + Math.sin(level.time * 2.2 + e.phase) * 1.1;
    return;
  }

  // 走怪 / 乌龟 / 滑行壳：受重力、撞墙转向
  e.vy += PHYS.GRAVITY * dt;
  if (e.vy > PHYS.MAX_FALL) e.vy = PHYS.MAX_FALL;

  let nx = e.x + e.vx * dt;
  if (boxHitsSolid(level.grid, nx - e.w / 2, e.y - e.h / 2, e.w, e.h)) {
    e.vx = -e.vx;
    e.dir = e.vx > 0 ? 1 : -1;
    nx = e.x;
  }
  // 巡逻范围限制（滑行壳不受限）
  if (e.shell !== 'slide' && Math.abs(nx - e.homeX) > e.range) {
    e.vx = -e.vx;
    e.dir = e.vx > 0 ? 1 : -1;
    nx = e.x;
  }
  e.x = nx;

  let ny = e.y + e.vy * dt;
  if (boxHitsSolid(level.grid, e.x - e.w / 2, ny - e.h / 2, e.w, e.h)) {
    let lo = 0, hi = e.vy * dt;
    for (let i = 0; i < 6; i++) {
      const mid = (lo + hi) / 2;
      if (boxHitsSolid(level.grid, e.x - e.w / 2, e.y + mid - e.h / 2, e.w, e.h)) hi = mid;
      else lo = mid;
    }
    ny = e.y + lo;
    e.vy = 0;
  }
  e.y = ny;

  if (e.y > PHYS.DEATH_FALL_Y) e.alive = false;
}

// 滑行壳碾压其他敌人（正版：一壳可连撞多个，每个都有分）
function resolveShellHits(level, players) {
  const shells = level.enemies.filter(e => e.alive && e.shell === 'slide');
  for (const sh of shells) {
    for (const other of level.enemies) {
      if (!other.alive || other === sh) continue;
      if (!boxesOverlap(sh, other)) continue;
      other.alive = false;
      // 给踢壳的人加分
      const owner = players[sh.kicker - 1];
      if (owner) {
        owner.score += 200;
        addPopup(level, other.x, other.y - 0.6, '200');
      }
    }
  }
  // 滑行壳也能干掉 Boss 的火球
  for (const sh of shells) {
    if (!level.fireballs) break;
    for (const f of level.fireballs) {
      if (f.fromPlayer) continue;
      if (boxesOverlap(sh, f)) f.life = 0;
    }
  }
}

/* ========== 蘑菇 / 花 ========== */

function stepItem(level, it, dt) {
  if (!it.active) return;
  if (it.type === 'flower') {
    // 花不动（简化：从砖里直接出现）
    return;
  }
  it.vy += PHYS.GRAVITY * dt;
  let nx = it.x + it.vx * dt;
  if (boxHitsSolid(level.grid, nx - it.w / 2, it.y - it.h / 2, it.w, it.h)) it.vx = -it.vx;
  else it.x = nx;
  let ny = it.y + it.vy * dt;
  if (boxHitsSolid(level.grid, it.x - it.w / 2, ny - it.h / 2, it.w, it.h)) {
    it.vy = 0;
    ny = it.y;
  }
  it.y = ny;
  if (it.y > PHYS.DEATH_FALL_Y) it.active = false;
}

/* ========== 移动平台 ========== */

function stepPlatform(level, pl, dt) {
  // 先记下移动前的位置：本帧所有站在平台上的玩家都要按同一增量被带走
  // （之前 px 在逐个玩家的 ride 处理里更新，第二个玩家拿到的增量恒为 0）
  pl.px = pl.x;
  pl.t += dt;
  const period = (pl.len * 2) / pl.speed;
  const u = (pl.t % period) / period;
  const tri = u < 0.5 ? u * 2 : 2 - u * 2;
  const off = (tri - 0.5) * pl.len;
  if (pl.axis === 'h') pl.x = pl.homeX + off;
  else pl.y = pl.homeY + off;
}

// 移动平台承载玩家
function resolvePlatformRide(level, p, dt) {
  if (p.state !== 'alive') return;
  for (const pl of level.platforms) {
    const platTop = pl.y + pl.h / 2;
    const horiz = p.x + p.w / 2 > pl.x - pl.w / 2 - 0.05 && p.x - p.w / 2 < pl.x + pl.w / 2 + 0.05;
    const vertClose = p.y >= platTop - 0.45 && p.y <= platTop + 0.25;
    if (horiz && vertClose && p.vy >= 0) {
      p.y = platTop;
      p.vy = 0;
      p.onGround = true;
      p.coyote = PHYS.COYOTE;
      if (pl.px !== undefined) p.x += (pl.x - pl.px);
    }
  }
}

/* ========== Boss ========== */

function nearestPlayer(players, x) {
  let best = null, bd = Infinity;
  for (const p of players) {
    if (p.state !== 'alive') continue;
    const d = Math.abs(p.x - x);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

function stepBoss(level, boss, players, dt) {
  if (!boss || boss.hp <= 0) return;
  boss.tick += dt;
  if (boss.hurtT > 0) boss.hurtT -= dt;

  if (boss.phase === 1 && boss.hp <= 2) boss.phase = 2;
  if (boss.phase === 2 && boss.hp <= 1) boss.phase = 3;

  if (boss.phase === 1) {
    if (boss.vx === 0) boss.vx = 1.0;
    boss.x += boss.vx * dt;
    // 巡逻以出生点为锚（之前写死 30.5，城堡关 Boss 出生在 col 72，
    // |72.5-30.5|>4 每帧都成立 → 每帧翻转速度，原地抖动不巡逻）。
    // 半径 2.5：Boss 判定盒宽 2，巡逻左缘 [69,71] 正好避开 col 66-68
    // 的阶梯坡——玩家/电脑在坡上跳跃的高度带与 Boss 重叠，半径大了
    // Boss 会巡到坡上把跳跃中的人撞死。
    if (Math.abs(boss.x - boss.homeX) > 2.5) boss.vx = -boss.vx;
    if (!boss.fireCd) boss.fireCd = 0;
    boss.fireCd -= dt;
    if (boss.fireCd <= 0) {
      boss.fireCd = 2.0;
      const target = nearestPlayer(players, boss.x);
      // 近身 4 格内不放火球：Boss 悬空、判定盒正压在玩家跳跃弧线里，
      // 贴脸火球会逼玩家起跳，一起跳就撞上 Boss 本体——必死且无解
      // （实测：双 Boss 关机器人反复撞死在同一格）。留出反应距离。
      if (target && Math.abs(target.x - boss.x) >= 4) {
        if (!level.fireballs) level.fireballs = [];
        level.fireballs.push({
          x: boss.x, y: boss.y - 0.5,
          w: 0.5, h: 0.5,
          vx: (target.x - boss.x) > 0 ? 3 : -3,
          vy: -1.5, life: 3,
          fromPlayer: false
        });
      }
    }
  } else if (boss.phase === 2) {
    const target = nearestPlayer(players, boss.x);
    if (target) boss.vx = (target.x - boss.x) > 0 ? 5.5 : -5.5;
    boss.x += boss.vx * dt;
  } else {
    boss.vx = 0;
  }

  if (boss.x < 26) boss.x = 26;
  if (boss.x > level.cols - 4) boss.x = level.cols - 4;
}

function stepFireballs(level, dt) {
  if (!level.fireballs) return;
  const keep = [];
  for (const f of level.fireballs) {
    if (f.fromPlayer) continue;   // 玩家火球由 stepPlayerFireballs 处理
    f.life -= dt;
    if (f.w === undefined) { f.w = 0.5; f.h = 0.5; }
    f.vy += PHYS.GRAVITY * 0.35 * dt;
    f.x += f.vx * dt;
    f.y += f.vy * dt;
    // 落地即熄：不这么做的话火球会继续穿过地面、从站在地上的玩家身上
    // 穿过去（视觉上明明在脚下爆炸）——既不公平也很难躲（实测双 Boss 关
    // 机器人反复被远距离火球穿身击杀）。正版里火球打到地面就消失。
    const groundRow = Math.floor(f.y + 0.05);
    if (isSolid(level.grid, Math.floor(f.x), groundRow)) {
      if (!level.debris) level.debris = [];
      level.debris.push({ x: f.x, y: f.y, t: 0, kind: 'coin' });   // 复用金币特效当爆点
      continue;
    }
    if (f.life > 0 && f.y < PHYS.DEATH_FALL_Y) keep.push(f);
  }
  // 保留玩家火球
  for (const f of level.fireballs) {
    if (f.fromPlayer) keep.push(f);
  }
  level.fireballs = keep;
}

/* ========== 玩家火球命中敌人 ========== */

function resolvePlayerFireballHits(level, players) {
  const shooters = {};
  for (const p of players) shooters[p.seat] = p;
  for (const f of level.fireballs) {
    if (!f.fromPlayer || f.life <= 0) continue;
    for (const e of level.enemies) {
      if (!e.alive) continue;
      if (!boxesOverlap(f, e)) continue;
      e.alive = false;
      f.life = 0;
      const owner = shooters[f.owner];
      if (owner) {
        owner.score += 100;
        addPopup(level, e.x, e.y - 0.6, '100');
      }
      break;   // 火球已熄灭，同帧不再打中第二个敌人（正版一颗火球只烧一个）
    }
    // 火球打 Boss（多 Boss 逐个判定）
    const bossList = level.bosses || (level.boss ? [level.boss] : []);
    for (const bs of bossList) {
      if (bs.hp > 0 && boxesOverlap(f, bs)) {
        bs.hp -= 1;
        bs.hurtT = 0.5;
        f.life = 0;
        emit(level, 'bossHurt', bs.x, bs.y);
        break;   // 一颗火球只打一个 Boss
      }
    }
  }
}

/* ========== 碰撞与交互 ========== */

// 玩家受伤：超级/火焰 → 变小；小 → 死
function hurtPlayer(p) {
  // 星星无敌：碰到敌人不掉形态、不死（尖刺/掉坑仍然即死，不经过这里）
  if (p.starT > 0) return;
  if (p.hurtT > 0 || p.state !== 'alive') return;
  if (p.form !== FORM.SMALL) {
    setForm(p, FORM.SMALL);
    p.hurtT = PHYS.INVULN_TIME;    // 变小后无敌闪烁
    emit(p.level || null, 'hurt', p.x, p.y);   // p.level 页面层注入（见 makePlayer）
  } else {
    p.state = 'dying';
    p.deathT = 0;
    p.vy = -9;                     // 正版死亡动画：向上弹起
    p.fellInPit = false;
    emit(p.level || null, 'die', p.x, p.y);
  }
  p.combo = 0;
}

// 玩家与敌人：踩头 / 侧撞；乌龟有壳状态机
function resolveEnemyHit(level, p, e) {
  if (!e.alive || p.state !== 'alive') return;
  if (!playerOverlaps(p, e)) return;

  // 星星无敌：碰到任何敌人直接撞飞
  if (p.starT > 0) {
    e.alive = false;
    p.score += 200;
    addPopup(level, e.x, e.y - 0.6, '200');
    return;
  }

  // 食人花：缩在管道里时没有判定，冒出来时不能踩，只能火球/星星/躲开
  if (e.type === E.PIRANHA) {
    if ((e.emerge || 0) < 0.35) return;
    hurtPlayer(p);
    return;
  }

  const enemyTop = e.y - e.h / 2;
  const stompDepth = p.y - enemyTop;
  const feetAboveEnemyTop = p.y >= enemyTop - 0.15;
  const notTooDeep = stompDepth < e.h * 0.75;
  // 只有下落中才算踩头（正版：上升途中撞到敌人是受伤，不是踩）
  const falling = p.vy > 0.5;
  const stomping = feetAboveEnemyTop && notTooDeep && falling;

  // 滑行壳：只有侧面撞才受伤，踩上去会停住（正版行为）
  if (e.shell === 'slide') {
    if (stomping) {
      // 踩住滑行壳 → 变静止壳
      e.shell = 'shell';
      e.shellT = 0;
      e.vx = 0;
      p.vy = p.jumpHeld ? -PHYS.STOMP_BOUNCE_HELD : -PHYS.STOMP_BOUNCE;
      p.onGround = false;
      p.score += 100;
      return;
    }
    // 侧面撞：如果刚被自己踢出，短暂保护不受伤
    if (e.kicker === p.seat && e.kickT > 0) return;
    hurtPlayer(p);
    return;
  }

  if (stomping) {
    // 踩中
    p.vy = p.jumpHeld ? -PHYS.STOMP_BOUNCE_HELD : -PHYS.STOMP_BOUNCE;
    p.onGround = false;
    p.combo += 1;
    // 连踩加分：100/200/400/500/800/1000...
    const comboScore = [100, 200, 400, 500, 800, 1000];
    const sc = comboScore[Math.min(p.combo - 1, comboScore.length - 1)];
    p.score += sc;
    addPopup(level, e.x, e.y - 0.6, String(sc));
    emit(level, 'stomp', e.x, e.y);

    if (e.type === E.TURTLE && e.shell === 'walk') {
      // 乌龟第一次被踩 → 变壳
      e.shell = 'shell';
      e.shellT = 0;
      e.vx = 0;
      e.kicker = 0;
    } else if (e.shell === 'shell') {
      // 再踩静止壳 → 踢出去
      kickShell(e, p);
    } else {
      e.alive = false;
    }
    return;
  }

  // 侧面撞到静止壳 → 踢出去
  if (e.shell === 'shell') {
    kickShell(e, p);
    return;
  }

  hurtPlayer(p);
}

function kickShell(e, p) {
  // 从玩家中心指向壳的方向决定踢出方向（贴边也能踢对）
  const dir = (e.x >= p.x) ? 1 : -1;
  e.shell = 'slide';
  e.vx = dir * PHYS.SHELL_SPEED;
  e.dir = dir;
  e.kicker = p.seat;
  e.kickT = PHYS.SHELL_KICK_GRACE;
  p.score += 100;
  emit(p.level || null, 'kick', e.x, e.y);
}

// 玩家与 Boss
function resolveBossHit(level, p, boss) {
  if (!boss || boss.hp <= 0 || p.state !== 'alive') return;
  if (!playerOverlaps(p, boss)) return;

  const bossTop = boss.y - boss.h / 2;
  const stompDepth = p.y - bossTop;
  // 与敌人判定一致：只有下落中才算从上方踩
  const fromAbove = p.y >= bossTop - 0.15 && stompDepth < boss.h * 0.75 && p.vy > 0.5;

  if (fromAbove && boss.phase === 3) {
    boss.hp -= 1;
    boss.hurtT = 0.8;
    p.vy = -PHYS.STOMP_BOUNCE;
    p.onGround = false;
    p.score += 500;
    return;
  }
  if (fromAbove) {
    p.vy = -PHYS.STOMP_BOUNCE;
    p.onGround = false;
    hurtPlayer(p);
    return;
  }
  hurtPlayer(p);
}

// 玩家撞上敌人的火球
function resolveFireballHit(level, p) {
  if (!level.fireballs || p.state !== 'alive') return;
  for (const f of level.fireballs) {
    if (f.fromPlayer) continue;
    if (playerOverlaps(p, f)) {
      f.life = 0;
      hurtPlayer(p);
    }
  }
}

// 吃金币
function resolveCoinHit(level, p) {
  for (const c of level.coins) {
    if (c.taken) continue;
    if (Math.abs(p.x - (c.col + 0.5)) < 0.6 && Math.abs(p.y - (c.row + 0.5)) < 0.8) {
      c.taken = true;
      p.coins += 1;
      p.score += 200;
      addPopup(level, c.col + 0.5, c.row, '200');
      emit(level, 'coin', c.col, c.row);
      // 每 100 金币 +1 命（正版机制，这里保留）
      if (p.coins % 100 === 0) p.lives += 1;
    }
  }
}

// 吃蘑菇/花。
// 合作模式道具共享（情侣模式）：任一方吃到变身道具，双方同步升一级——
// 一人吃蘑菇两人变大。星星/1UP 仍然只作用本人（星星给两人就无挑战了）。
function resolveItemHit(level, p) {
  const players = level._players || [p];
  for (const it of level.items) {
    if (!it.active) continue;
    if (playerOverlaps(p, it)) {
      it.active = false;
      addPopup(level, it.x, it.y - 0.8, '1000');
      emit(level, it.type === 'oneup' ? 'oneup' : 'powerup', it.x, it.y);
      if (it.type === 'mushroom') {
        for (const q of players) {
          if (q.state !== 'alive' && q.state !== 'dying') continue;
          if (q.form === FORM.SMALL) {
            setForm(q, FORM.SUPER);
            if (q !== p) q.hurtT = Math.max(q.hurtT || 0, 0.5);   // 共享方也给点闪烁
          }
        }
        p.score += 1000;
      } else if (it.type === 'star') {
        // 星星：10 秒无敌，碰到敌人直接撞飞（正版还有加速，见 stepPlayer）
        p.starT = Math.max(p.starT || 0, 10);
        p.score += 1000;
        emit(level, 'star', it.x, it.y);
      } else if (it.type === 'oneup') {
        // 1-UP 蘑菇：加一条命
        p.lives += 1;
        p.score += 1000;
      } else {
        for (const q of players) {
          if (q.state !== 'alive' && q.state !== 'dying') continue;
          if (q.form !== FORM.FIRE) {
            setForm(q, FORM.FIRE);
            if (q !== p) q.hurtT = Math.max(q.hurtT || 0, 0.5);
          }
        }
        p.hurtT = 0.5;
        p.score += 1000;
      }
    }
  }
}

// 尖刺 + 终点旗
function resolveHazards(level, p) {
  if (p.state !== 'alive') return;
  if (boxHitsDeadly(level.grid, p.x - p.w / 2, p.y - p.h, p.w, p.h)) {
    // 尖刺：直接死亡（正版里尖刺是即死，不管大小）
    p.state = 'dying';
    p.deathT = 0;
    p.vy = -9;
    p.fellInPit = false;
    return;
  }
  // 碰到旗杆 → 进入下滑动画（正版：抓住旗杆滑到底，再走向城堡）
  if (boxHitsFlag(level.grid, p.x - p.w / 2, p.y - p.h, p.w, p.h)) {
    if (!p.onFlag) {
      p.onFlag = true;
      p.vx = 0;
      p.vy = 0;
      p.x = findFlagCol(level) + 0.5;
      emit(level, 'flag', p.x, p.y);
      // 抓杆高度越高，得分越多（正版：100~5000 分）
      const flagTop = findFlagTop(level);
      const height = Math.max(0, (flagTop - p.y) / 8);
      p.score += Math.round(100 + height * 4900);
    }
  }
}

// 找旗杆所在列（FLAG 或 FLAGBASE）
function findFlagCol(level) {
  for (let r = 0; r < level.rowsH; r++) {
    for (let c = 0; c < level.cols; c++) {
      const ch = level.grid[r][c];
      if (ch === T.FLAG || ch === T.FLAGBASE) return c;
    }
  }
  return level.cols - 5;
}

// 旗杆顶端所在行
function findFlagTop(level) {
  for (let r = 0; r < level.rowsH; r++) {
    for (let c = 0; c < level.cols; c++) {
      if (level.grid[r][c] === T.FLAG) return r;
    }
  }
  return 4;
}

// 旗杆下滑与过关流程推进（每帧调用）
// 阶段：0 正常 → 1 抓杆下滑 → 2 走向城堡 → 3 结算完成
function stepClearSequence(level, players, dt) {
  for (const p of players) {
    if (!p.onFlag || p.state === 'done') continue;
    const baseRow = findFlagBottom(level);
    if (p.y < baseRow) {
      // 沿旗杆下滑
      p.y = Math.min(baseRow, p.y + 4.5 * dt);
      p.vy = 0;
      p.vx = 0;
    } else {
      // 到达杆底：自动向右走进城堡门洞
      p.face = 1;
      p.x += 3.2 * dt;
      const doorX = findCastleDoorX(level);
      if (p.x >= doorX) {
        p.x = doorX;
        p.state = 'done';
        p.finishT = level.time;
        // 剩余时间换算成分数（正版每单位时间 50 分）
        p.score += Math.max(0, Math.floor(level.timeLeft)) * 50;
        emit(level, 'clear', p.x, p.y);
      }
    }
  }
}

function findFlagBottom(level) {
  let last = level.rowsH - 3;
  for (let r = 0; r < level.rowsH; r++) {
    for (let c = 0; c < level.cols; c++) {
      if (level.grid[r][c] === T.FLAG) last = r;
    }
  }
  // 滑到旗杆底座顶面（底座 'f' 在 last+1 行）：站在底座上脚底 = last+1。
  // 之前直接用杆底 last，角色悬在半空、比城门洞高一格
  return last + 1;
}

// 找终点城堡所在列。
// 不能简单取「关卡末尾的硬砖」：1-1 末段的阶梯也是硬砖，
// 而且关卡右侧还有地下金币房的墙。城堡一定是旗杆右边的第一段硬砖。
function findCastleCol(level) {
  const row = level.rowsH - 6;
  if (row < 0 || row >= level.rowsH) return level.cols - 4;
  const flag = findFlagCol(level);
  let c = flag + 1;
  while (c < level.cols && level.grid[row][c] !== T.HARD) c++;
  if (c >= level.cols) return level.cols - 4;
  while (c > 0 && level.grid[row][c - 1] === T.HARD) c--;
  return c;
}

// 城堡门洞：城堡底行里第一个不是硬砖的格子（生成器在 c+2 留门）。
// 城堡底行是 GROUND-1，即 rowsH-3；不能用 rowsH-1（那是地面，永远不是硬砖）。
function findCastleDoorX(level) {
  const c0 = findCastleCol(level);
  const row = level.rowsH - 3;
  for (let c = c0; c < level.cols; c++) {
    if (level.grid[row][c] !== T.HARD) return c + 0.5;
  }
  return c0 + 2.5;
}

/* ========== 顶砖块 / 问号砖 ========== */

// 问号砖/隐藏砖显形：变 USED + 给内容（金币或道具）。
// 顶出的道具站在砖顶上沿：底边只比砖顶高一点点。
// 之前出生在 headRow-0.1（半埋进刚变 USED 的实心砖里），
// stepItem 的水平探测永远被挡 → 蘑菇原地抖动永远走不出来。
function openBlock(level, p, headRow, c, ch) {
  level.grid[headRow][c] = T.USED;
  const key = headRow + '_' + c;
  let itemType = level.blockItems && level.blockItems[key];
  if (!itemType) {
    itemType = ch === T.HIDDEN ? 'coin'
      : (p.form !== FORM.SMALL ? 'flower' : 'mushroom');
  }
  if (itemType === 'coin') {
    // 出金币只算一次 200（之前砖块 +200 和金币 +200 叠成 400，正版是 200）
    p.coins += 1;
    p.score += 200;
    if (p.coins % 100 === 0) p.lives += 1;
    addPopup(level, c + 0.5, headRow - 0.5, '200');
    if (!level.debris) level.debris = [];
    level.debris.push({ x: c + 0.5, y: headRow + 0.5, t: 0, kind: 'coin' });
  } else {
    level.items.push({
      id: level.items.length,
      type: itemType,
      x: c + 0.5, y: headRow - 0.4,
      w: 0.7, h: 0.7,
      vx: itemType === 'flower' ? 0 : (itemType === 'star' ? 2.2 : 1.2),
      vy: 0,
      active: true,
      emerge: 0.3
    });
    emit(level, 'item', c + 0.5, headRow);
  }
}

// 隐藏砖：不挡移动（不在 SOLID 里），只有上升中头顶撞到才显形。
// 扫描本帧头顶扫过的行，命中即变 USED 出内容并把玩家顶停。
function hitHiddenBlock(level, p, ny) {
  const grid = level.grid;
  const c0 = Math.floor(p.x - p.w / 2 + 0.02);
  const c1 = Math.floor(p.x + p.w / 2 - 0.02);
  const rFrom = Math.ceil(p.y - p.h - 0.02) - 1;   // 旧头顶所在行
  const rTo = Math.ceil(ny - p.h - 0.02) - 1;      // 新头顶所在行（更靠上）
  for (let row = rFrom; row >= rTo; row--) {
    for (let c = c0; c <= c1; c++) {
      if (!inGrid(grid, c, row)) continue;
      if (grid[row][c] !== T.HIDDEN) continue;
      openBlock(level, p, row, c, T.HIDDEN);
      p.vy = 0;   // 撞停，之后重力把玩家拉回去
      return true;
    }
  }
  return false;
}

// 玩家向上撞到头顶瓦片。
// 正版规则：
//   · 问号砖 → 出道具（小马里奥出蘑菇、超级/火焰出花；有些砖只出金币）
//   · 普通砖 → 小马里奥只顶一下（砖块弹动），超级/火焰直接顶碎
//   · 顶碎/顶过的砖变成 USED（空砖）
function hitHeadBlock(level, p) {
  const grid = level.grid;
  const headY = p.y - p.h;
  const c0 = Math.floor(p.x - p.w / 2 + 0.02);
  const c1 = Math.floor(p.x + p.w / 2 - 0.02);

  // 玩家撞到砖块下边界时，头顶 y 恰好等于砖块的 row 值（比如撞 row10 的砖，
  // 头顶就是 10.0）。floor(10.0 - 0.02) = 9 会漏判，所以探测范围要覆盖
  // 「头顶所在行」和「头顶上一行」两种情况。
  for (let rowOff = 0; rowOff <= 2; rowOff++) {
    const headRow = Math.ceil(headY - 0.02) - 1 + rowOff;
    for (let c = c0; c <= c1; c++) {
      if (!inGrid(grid, c, headRow)) continue;
      const ch = grid[headRow][c];
      // 注意：多金币砖 C / 隐藏砖 H 也要进这个分支
      if (ch !== T.QUESTION && ch !== T.BRICK && ch !== T.COINBRICK &&
          ch !== T.HIDDEN) continue;

      // 多金币砖：顶一次出一枚，最多 COINBRICK_MAX 次（正版金币砖）
      if (ch === T.COINBRICK) {
        const key = headRow + '_' + c;
        const left = level.blockState[key] || 0;
        if (left > 0) {
          level.blockState[key] = left - 1;
          p.coins += 1;
          p.score += 200;
          if (p.coins % 100 === 0) p.lives += 1;
          addPopup(level, c + 0.5, headRow - 0.5, '200');
          if (left - 1 === 0) grid[headRow][c] = T.USED;   // 用完了变空砖
        }
        // 记录碎片特效（纯表现，不影响逻辑）
        if (!level.debris) level.debris = [];
        level.debris.push({ x: c + 0.5, y: headRow + 0.5, t: 0, kind: 'coin' });
        return;
      }

      if (ch === T.QUESTION || ch === T.HIDDEN) {
        openBlock(level, p, headRow, c, ch);
      } else if (ch === T.BRICK) {
        // 普通砖：大马里奥顶碎，小马里奥只顶一下（砖块保留）
        if (p.form !== FORM.SMALL) {
          grid[headRow][c] = T.EMPTY;   // 顶碎
          p.score += 50;
          // 碎片特效（正版砖块碎裂有 4 块飞散）
          if (!level.debris) level.debris = [];
          for (let k = 0; k < 4; k++) {
            level.debris.push({
              x: c + 0.25 + (k % 2) * 0.5,
              y: headRow + 0.25 + Math.floor(k / 2) * 0.5,
              vx: (k % 2 ? 1 : -1) * 2.5,
              vy: -6 - Math.floor(k / 2) * 1.5,
              t: 0,
              kind: 'brick'
            });
          }
        } else {
          p.score += 10;
          if (!level.debris) level.debris = [];
          level.debris.push({ x: c + 0.5, y: headRow + 0.5, t: 0, kind: 'bump' });
        }
      }
      return;
    }
  }
}

// 管道传送：站在管道口（脚底 = 管道顶行）按 ↓ 进入/返回。
// 入口和出口都写在 spec.warps 里，联机两端用同一份数据，不需要切关卡。
function tryPipeWarp(level, p, inp) {
  if (!level.warps || !level.warps.length) return false;
  if (!inp || !inp.down) return false;
  if (p.state !== 'alive' || !p.onGround || p.onFlag) return false;
  if (p.warpLock > 0) return false;
  for (let i = 0; i < level.warps.length; i++) {
    const w = level.warps[i];
    if (p.x < w.col - 0.2 || p.x > w.col + w.width + 0.2) continue;
    if (Math.abs(p.y - w.topRow) > 0.3) continue;
    // 传送
    p.x = w.toX;
    p.y = w.toY;
    p.vx = 0;
    p.vy = 0;
    p.onGround = false;
    p.warpLock = 0.6;
    p.hurtT = Math.max(p.hurtT || 0, 1.0);  // 落地前短暂保护
    emit(level, 'warp', w.col, w.topRow);
    if (!level.warpFx) level.warpFx = [];
    level.warpFx.push({ x: w.col + w.width / 2, y: w.topRow, t: 0 });
    level.warpFx.push({ x: w.toX, y: w.toY, t: 0 });
    return true;
  }
  return false;
}

/* ========== 世界步进 ========== */

// inputs: { seat: input }，缺省的座位用空输入
function stepWorld(level, players, inputs, dt) {
  level.time += dt;

  // 倒计时（正版 400 秒，每 0.4 秒扣 1，这里每秒扣 1 更宽松）
  if (level.timeLeft > 0) {
    level.timeAcc += dt;
      if (level.timeAcc >= 1) {
        level.timeAcc -= 1;
        level.timeLeft -= 1;
        // 时间耗尽 → 所有存活玩家死亡。
        // 已抓住旗杆的不算：他们几秒内就滑到底过关（正版同理），
        // 而且旗杆阶段跳过常规物理，dying 动画永远走不完。
        if (level.timeLeft <= 0) {
          for (const p of players) {
            if (p.state === 'alive' && !p.onFlag) {
              p.state = 'dying';
              p.deathT = 0;
              p.vy = -9;
              p.fellInPit = false;
            }
          }
        }
      }
  }

  // 砖块碎片（纯表现，但放引擎里方便联机时两端一致）
  if (level.debris && level.debris.length) {
    const keep = [];
    for (const d of level.debris) {
      d.t += dt;
      if (d.kind === 'brick') {
        d.vy += PHYS.GRAVITY * dt;
        d.x += d.vx * dt;
        d.y += d.vy * dt;
      }
      if (d.t < 0.9) keep.push(d);
    }
    level.debris = keep;
  }

  // 管道传送的闪光特效（纯表现）
  if (level.warpFx && level.warpFx.length) {
    const keep = [];
    for (const fx of level.warpFx) {
      fx.t += dt;
      if (fx.t < 0.45) keep.push(fx);
    }
    level.warpFx = keep;
  }

  // 旗杆下滑阶段：这些玩家不受常规输入控制
  stepClearSequence(level, players, dt);
  stepPopups(level, dt);

  // 平台先动（玩家本帧要能踩到新位置）
  for (const pl of level.platforms) stepPlatform(level, pl, dt);
  for (const it of level.items) stepItem(level, it, dt);
  for (const e of level.enemies) stepEnemy(level, e, dt, players);
  stepFireballs(level, dt);
  stepPlayerFireballs(level, dt);

  // 玩家物理（抓杆下滑中的玩家跳过常规物理）
  for (const p of players) {
    if (p.onFlag) continue;
    const inp = inputs[p.seat] || makeInput();
    stepPlayer(level, p, inp, dt);
    tryPipeWarp(level, p, inp);
    resolvePlatformRide(level, p, dt);
    // 跑键连发火球（正版是单按一次发一颗，这里用冷却控制节奏）
    if (p.form === FORM.FIRE && inp.run && p.state === 'alive' && p.fireCd <= 0) {
      if (spawnFireball(level, p)) emit(level, 'fireball', p.x, p.y);
    }
  }

  // 交互
  for (const p of players) {
    if (p.state !== 'alive' || p.onFlag) continue;
    resolveCoinHit(level, p);
    resolveItemHit(level, p);
    for (const e of level.enemies) resolveEnemyHit(level, p, e);
    // 多 Boss：逐个判定（bosses 为空时跳过，老单 Boss 关也走这里）
    if (level.bosses) {
      for (const bs of level.bosses) resolveBossHit(level, p, bs);
    } else if (level.boss) {
      resolveBossHit(level, p, level.boss);
    }
    resolveFireballHit(level, p);
    resolveHazards(level, p);
  }

  resolveShellHits(level, players);
  resolvePlayerFireballHits(level, players);

  // 敌人自己的计时（滑行壳被踢后的保护时间）
  for (const e of level.enemies) {
    if (e.kickT > 0) e.kickT -= dt;
  }

  if (level.bosses) {
    for (const bs of level.bosses) stepBoss(level, bs, players, dt);
  } else if (level.boss) {
    stepBoss(level, level.boss, players, dt);
  }
}

/* ========== 胜负判定 ========== */

function isLevelCleared(level, players) {
  for (const p of players) {
    if (p.state !== 'done') return false;
  }
  return true;
}

function raceWinner(level, players) {
  let best = null, bt = Infinity;
  for (const p of players) {
    if (p.state === 'done' && p.finishT < bt) { bt = p.finishT; best = p; }
  }
  return best ? best.seat : 0;
}

function isGameOver(level, players) {
  for (const p of players) {
    if (p.state !== 'dead' && p.state !== 'done') return false;
  }
  return true;
}

// 任意一人命用完（state='dead'）。
// 合作模式必须用它判负：过关要求「全员 done」、全员死才算 gameOver，
// 于是「一人活着 + 一人阵亡」两边条件都不成立 —— 对局永久卡死（实测确认）。
function anyPlayerDead(players) {
  for (const p of players) {
    if (p.state === 'dead') return true;
  }
  return false;
}

/* ========== 序列化（联机同步） ========== */

function playerToWire(p) {
  return {
    x: round3(p.x), y: round3(p.y), vx: round3(p.vx), vy: round3(p.vy),
    f: p.face, g: p.onGround ? 1 : 0,
    fm: p.form,
    sr: round3(p.starT || 0),
    st: p.state, lv: p.lives, cn: p.coins, sc: p.score,
    // 过关用时必须同步：竞速模式的 raceWinner 比的是 finishT，
    // 缺了它 guest 端永远算不出 host 的获胜者，两边各宣布自己赢
    ft: round3(p.finishT || 0),
    // 无限生命也要同步：host 权威，否则 guest 单方面打开开关不生效
    //（guest 的 lives 每次世界更新都会被 host 的权威值覆盖）
    il: p.infiniteLives ? 1 : 0
  };
}

function worldToWire(level, players) {
  const es = [];
  for (const e of level.enemies) {
    es.push([e.id, e.alive ? 1 : 0, round3(e.x), round3(e.y), e.shell]);
  }
  const cs = [];
  for (const c of level.coins) if (!c.taken) cs.push(c.id);
  return {
    t: round3(level.time),
    // 倒计时以 host 为准同步：两端帧率钳制差异会让各自倒数漂移
    tl: level.timeLeft,
    p1: playerToWire(players[0]),
    p2: players[1] ? playerToWire(players[1]) : null,
    es,
    cs,
    // 多 Boss：[[hp,phase,x], ...]；老对局只有一个（单元素数组，向后兼容）
    bs: (level.bosses || (level.boss ? [level.boss] : [])).map(function (b) {
      return [b.hp, b.phase, round3(b.x)];
    })
  };
}

/* ========== 单机竞速的电脑对手 ========== */
// 一个“会玩”的自动输入：一直向右，遇到坑/管道/尖刺/敌人才跳。
// 和关卡测试里的机器人同一套规则，全 7 关都能通关。

function autoGroundAhead(level, col, feetY) {
  if (feetY < 13.5) return isSolid(level.grid, col, Math.floor(feetY + 0.001));
  for (let r = 14; r <= 15; r++) {
    if (isSolid(level.grid, col, r)) return true;
  }
  return false;
}

function autoObstacleAhead(level, col) {
  for (let r = 11; r <= 13; r++) {
    if (isSolid(level.grid, col, r)) return true;
  }
  return false;
}

function autoSpikeAhead(level, col) {
  for (let r = 12; r <= 13; r++) {
    if (tileAt(level.grid, col, r) === T.SPIKE) return true;
  }
  return false;
}

function autoBrickAbove(level, col, row) {
  for (let r = row - 3; r <= row - 1; r++) {
    const ch = tileAt(level.grid, col, r);
    if (ch === T.QUESTION || ch === T.BRICK || ch === T.COINBRICK) return true;
  }
  return false;
}

function autoSpikeBetween(level, fromCol, toCol) {
  for (let c = fromCol; c <= toCol; c++) {
    if (autoSpikeAhead(level, c)) return true;
  }
  return false;
}

function autoEnemyAhead(level, p) {
  for (let i = 0; i < level.enemies.length; i++) {
    const e = level.enemies[i];
    if (!e.alive || e.type === E.PIRANHA) continue;
    const dx = e.x - (p.x + p.w / 2);
    // 3.5 格：迎面敌人相对速度 ~7格/秒，窗口太小时起跳后半路相撞
    // （跳到 1 格高需要 0.25s，此时敌人已前进 ~1.7 格——L7 实测死法）
    if (dx > 0.2 && dx < 3.5 && Math.abs(e.y - p.y) < 1.8) return true;
  }
  return false;
}

// 敌人逼近的紧急程度：<1.8 格（迎面走来很快相撞）→ 必须立即跳；
// 1.8~2.8 格 → 可以再走一步等更好的起跳点。机器人只看 autoEnemyAhead
// 时经常踩着敌人碰撞盒前缘才起跳，起跳帧正好被撞（L7 死因）。
function autoEnemyVeryClose(level, p) {
  for (let i = 0; i < level.enemies.length; i++) {
    const e = level.enemies[i];
    if (!e.alive || e.type === E.PIRANHA) continue;
    const dx = e.x - (p.x + p.w / 2);
    if (dx > 0.2 && dx < 1.8 && Math.abs(e.y - p.y) < 1.8) return true;
  }
  return false;
}

// 前方近处敌人是否与机器人同向行走（vx>0 且朝右）：同向时相对速度慢，
// 跟在后面走是安全的（会先撞墙弹回再处理），不用停步等待
function autoEnemySameDir(level, p) {
  for (let i = 0; i < level.enemies.length; i++) {
    const e = level.enemies[i];
    if (!e.alive || e.type === E.PIRANHA || e.type === E.FLYER) continue;
    const dx = e.x - p.x;
    if (dx > 0.2 && dx < 2.0 && e.vx > 0 && Math.abs(e.y - p.y) < 1.8) return true;
  }
  return false;
}

// 正前方 4 格内有地面敌人（不管朝向）：跳坑的相遇风险。
// 迎面（vx<0）相对速度 ~6格/秒必撞；同向的也可能刚被墙弹回（vx 翻转
// 瞬间就是迎面）。等敌人走过去/被踩掉再跳坑，稳。
function autoEnemyApproachingPit(level, p) {
  for (let i = 0; i < level.enemies.length; i++) {
    const e = level.enemies[i];
    if (!e.alive || e.type === E.PIRANHA || e.type === E.FLYER) continue;
    const dx = e.x - p.x;
    if (dx > 0.2 && dx < 4.0 && Math.abs(e.y - p.y) < 1.8) return true;
  }
  return false;
}

// Boss 悬空（判定底沿高过站立角色头顶），地面通行时从它脚下穿过即可，
// 不要为它起跳——跳跃弧线恰好穿过 Boss 的判定带，反而会被撞。
// 只需要躲它的火球（autoFireballAhead）。

// Boss 的火球贴地飞来：提前跳过它（不会踩灭，只能躲）
function autoFireballAhead(level, p) {
  if (!level.fireballs) return false;
  for (let i = 0; i < level.fireballs.length; i++) {
    const f = level.fireballs[i];
    if (f.fromPlayer || f.life <= 0) continue;
    const dx = f.x - p.x;
    if (dx > 0.2 && dx < 3.2 && Math.abs(f.y - (p.y - 0.45)) < 1.3) return true;
  }
  return false;
}

// 起跳落点预判：以当前速度模拟一次普通跳跃，看落点（和路径）是否安全。
// 机器人之前「见到坑/尖刺就跳」，起跳时机与障碍形状不匹配时会跳进
// 尖刺或跳进坑（尖刺+坑组合尤其致命）。预判通过才跳，否则继续走
// （走到坑沿前再判断一次，此时剩余距离短，自然放弃或找到好时机）。
function autoJumpLandingSafe(level, p) {
  // 简化弧线模拟：x 匀速（当前 vx，至少 1 格/秒避免原地跳），
  // y 用 JUMP_VEL/GRAVITY 数值积分，落到支撑面即停
  const vx = Math.max(1, Math.abs(p.vx) || 3);
  let x = p.x, y = p.y, vy = -PHYS.JUMP_VEL;
  const dt = 1 / 30;
  for (let step = 0; step < 45; step++) {
    x += vx * dt;
    vy += PHYS.GRAVITY * dt;
    y += vy * dt;
    if (y > PHYS.DEATH_FALL_Y) return false;              // 弧线坠坑
    // 落到支撑面：脚底行有实心
    if (vy > 0) {
      const row = Math.floor(y + 0.05);
      const c0 = Math.floor(x - p.w / 2 + 0.02);
      const c1 = Math.floor(x + p.w / 2 - 0.02);
      for (let c = c0; c <= c1; c++) {
        if (isSolid(level.grid, c, row)) {
          // 落点本身是实心上 —— 再确认落点周围 1 格没有尖刺（防止贴着尖刺落地）
          if (DEADLY[tileAt(level.grid, c, row - 1)] ||
              DEADLY[tileAt(level.grid, Math.min(c + 1, level.cols - 1), row - 1)]) return false;
          return true;
        }
      }
    }
  }
  return false;   // 45 步没落地（长弧线跨大坑），视为不安全
}

// 敌人威胁窗口：迎面（vx<0，相对速度 ~6格/秒）4.5 格就该起跳；
// 同向（vx>0，相对慢）2.5 格。之前统一 3.5 格，同向弹回瞬间变迎面
// 的场景会半路相撞（L7 goomba 城堡关实测死法）。
function autoEnemyThreat(level, p) {
  for (let i = 0; i < level.enemies.length; i++) {
    const e = level.enemies[i];
    if (!e.alive || e.type === E.PIRANHA) continue;
    const dx = e.x - (p.x + p.w / 2);
    if (dx <= 0.2 || dx > 4.5 || Math.abs(e.y - p.y) >= 1.8) continue;
    if (e.vx < 0) return true;              // 迎面：远窗口
    if (dx < 2.5) return true;              // 同向：近窗口（贴身了必须处理）
  }
  return false;
}

function makeAutoInput(level, p) {
  const inp = makeInput();
  inp.right = true;
  const ahead = Math.floor(p.x + p.w / 2 + 0.15);
  const cur = Math.floor(p.x);
  if (p.onGround) {
    let jump = false;
    let pitJump = false;   // 坑跳跃：受落点预判约束
    // 坑要提前跳：只看 ahead 一格时，人到坑沿才起跳，助跑距离不足
    // 弧线跨不过 2 格宽的坑。站上坑沿前 2 格就起跳。
    // 例外：正前方 4 格内有地面敌人时推迟起跳——坑沿正好是
    // 敌我的相遇点，跳坑弧线低点会撞上，让它先走过去。
    if ((!autoGroundAhead(level, ahead, p.y) ||
         !autoGroundAhead(level, ahead + 1, p.y) ||
         !autoGroundAhead(level, ahead + 2, p.y)) &&
        !autoEnemyApproachingPit(level, p)) { jump = true; pitJump = true; }
    if (autoObstacleAhead(level, ahead) ||
        autoObstacleAhead(level, ahead + 1)) jump = true;
    if (autoSpikeAhead(level, ahead) ||
        autoSpikeAhead(level, ahead + 1)) jump = true;
    if (autoBrickAbove(level, cur, Math.floor(p.y)) &&
        !autoSpikeBetween(level, cur, cur + 6)) jump = true;
    if (autoEnemyThreat(level, p)) jump = true;
    if (autoFireballAhead(level, p)) jump = true;
    // 落点预判只约束「跳坑」：跳坑落点不安全（对岸贴尖刺/弧线不够远）
    // 时改走短跳或放弃；而障碍/敌人/火球必须跳，预判不安全也跳
    if (pitJump && !autoJumpLandingSafe(level, p)) jump = false;
    inp.up = jump;
    // 敌人迎面但跳不安全（落点预判失败）→ 原地等待，让敌人先走远。
    if (!jump && autoEnemyVeryClose(level, p) && !autoEnemySameDir(level, p)) {
      inp.right = false;
    }
  } else if (p.vy < 0) {
    inp.up = true;
  }
  return inp;
}

module.exports = {
  TICK, PHYS, T, E, FORM, SOLID, DEADLY, COINBRICK_MAX,
  makeGrid, gridRows, tileAt, isSolid, inGrid,
  boxHitsSolid, boxHitsDeadly, boxHitsFlag, groundTileAt, boxesOverlap, playerOverlaps,
  loadLevel, makePlayer, makeInput, playerHeight, setForm,
  stepPlayer, stepEnemy, stepPlatform, stepItem, stepBoss,
  stepFireballs, stepPlayerFireballs, stepWorld,
  resolveEnemyHit, resolveBossHit, resolveFireballHit,
  resolveCoinHit, resolveItemHit, resolveHazards, resolvePlatformRide,
  resolveShellHits, resolvePlayerFireballHits,
  hitHeadBlock, hitHiddenBlock, openBlock, hurtPlayer, kickShell, spawnFireball,
  addPopup, stepPopups,
  tryPipeWarp, stepClearSequence, findFlagCol, findFlagTop, findCastleCol, findCastleDoorX,
  isLevelCleared, raceWinner, isGameOver, anyPlayerDead,
  playerToWire, worldToWire, round3, makeAutoInput
};
