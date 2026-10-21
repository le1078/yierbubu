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
// 实测结果：满跳 3.38 格高、滞空 0.87 秒、走路跳 4.6 格 / 奔跑跳 6.9 格。
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
  JUMP_VEL: 14.0,         // 起跳初速度（满跳约 3.8 格）
  JUMP_CUT: 0.42,         // 松键后速度衰减系数（可变跳跃高度）
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
  SHELL_KICK_GRACE: 0.25  // 刚变成壳时的免踢窗口（防止连踩即飞）
};

/* ========== 瓦片类型 ========== */
const T = {
  EMPTY: '.', GROUND: '#', BRICK: 'B', QUESTION: '?',
  SPIKE: 'S', PIPE: 'P', FLAG: 'F', ICE: 'I', PLATFORM: '=', LIFT: '^',
  USED: 'U'   // 顶过的砖（空砖，正版里是深色方块）
};

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

// 尖刺不阻挡移动，但是致命
const DEADLY = {};
DEADLY[T.SPIKE] = true;

/* ========== 敌人类型 ========== */
const E = {
  GOOMBA: 'goomba',   // 走怪：左右巡逻，踩一下死
  TURTLE: 'turtle',   // 乌龟：巡逻，踩一下变壳，再踩踢出去
  FLYER: 'flyer'      // 飞行怪：正弦上下浮动
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

// 是否踩在终点旗上
function boxHitsFlag(grid, x, y, w, h) {
  const c0 = Math.floor(x), c1 = Math.floor(x + w - 0.0001);
  const r0 = Math.floor(y), r1 = Math.floor(y + h - 0.0001);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (tileAt(grid, c, r) === T.FLAG) return true;
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

function round3(v) {
  return Math.round(v * 1000) / 1000;
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
      vx: e.type === E.FLYER ? 0 : -1.0,
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
      kickT: 0
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
      t: 0
    });
  }
  const items = [];
  const iList = spec.items || [];
  for (let i = 0; i < iList.length; i++) {
    const it = iList[i];
    items.push({
      id: i,
      type: it.type,          // 'mushroom' | 'flower'
      x: it.col + 0.5, y: it.row + 0.5,
      w: 0.7, h: 0.7,
      vx: it.type === 'flower' ? 0 : 1.2,   // 花不动
      vy: 0,
      active: true,
      emerge: it.type === 'flower' ? 0.5 : 0  // 花从砖里冒出来的过程（简化：直接出现）
    });
  }
  const boss = spec.boss
    ? {
        x: spec.boss.col + 0.5, y: spec.boss.row + 0.5,
        w: 2.0, h: 1.8,
        hp: spec.boss.hp, phase: 1,
        vx: 0, vy: 0, dir: -1,
        hurtT: 0, tick: 0,
        fireCd: 0
      }
    : null;

  return {
    grid,
    rows: gridRows(grid),
    cols: grid[0].length,
    rowsH: grid.length,
    coins, enemies, platforms, items, boss,
    fireballs: [],
    start: spec.start || { col: 2, row: 14 },
    checkpoints: spec.checkpoints || [],
    name: spec.name || '',
    time: 0
  };
}

/* ========== 玩家 ========== */

function makePlayer(level, seat) {
  return {
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
    coyote: 0,
    buffer: 0,
    jumpHeld: false,
    jumpPressT: 0,          // 跳跃键按下多久（控制踩敌反弹高度）
    lives: C.MARIO_LIVES,
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
    // 变大/变小时的过渡动画（正版有短暂定格式的变换过程）
    growT: 0
  };
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
      p.lives -= 1;
      p.deathT = 0;
      if (p.lives > 0) {
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
      } else {
        p.state = 'dead';
      }
    }
    return;
  }
  if (p.state === 'dead' || p.state === 'done') return;

  if (p.hurtT > 0) p.hurtT -= dt;
  if (p.growT > 0) p.growT -= dt;
  if (p.fireCd > 0) p.fireCd -= dt;

  const onIce = p.onGround && groundTileAt(level.grid, p.x - p.w / 2, p.y - p.h, p.w, p.h) === T.ICE;

  // 水平操控
  const accel = PHYS.WALK_ACCEL * (p.onGround ? 1 : PHYS.AIR_CONTROL);
  const maxSpeed = input.run ? PHYS.RUN_MAX : PHYS.WALK_MAX;
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
    } else {
      // 向上撞 → 顶到头顶的瓦片（问号砖/砖块）
      hitHeadBlock(level, p);
    }
    ny = p.y + lo;
    p.vy = 0;
  }
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

function stepEnemy(level, e, dt) {
  if (!e.alive) return;

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
      if (owner) owner.score += 200;
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
    pl.px = pl.x;
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
    if (Math.abs(boss.x - 30.5) > 4) boss.vx = -boss.vx;
    if (!boss.fireCd) boss.fireCd = 0;
    boss.fireCd -= dt;
    if (boss.fireCd <= 0) {
      boss.fireCd = 2.0;
      const target = nearestPlayer(players, boss.x);
      if (target) {
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
      if (owner) owner.score += 100;
    }
    // 火球打 Boss
    if (level.boss && level.boss.hp > 0 && boxesOverlap(f, level.boss)) {
      level.boss.hp -= 1;
      level.boss.hurtT = 0.5;
      f.life = 0;
    }
  }
}

/* ========== 碰撞与交互 ========== */

// 玩家受伤：超级/火焰 → 变小；小 → 死
function hurtPlayer(p) {
  if (p.hurtT > 0 || p.state !== 'alive') return;
  if (p.form !== FORM.SMALL) {
    setForm(p, FORM.SMALL);
    p.hurtT = PHYS.INVULN_TIME;    // 变小后无敌闪烁
  } else {
    p.state = 'dying';
    p.deathT = 0;
    p.vy = -9;                     // 正版死亡动画：向上弹起
    p.fellInPit = false;
  }
  p.combo = 0;
}

// 玩家与敌人：踩头 / 侧撞；乌龟有壳状态机
function resolveEnemyHit(level, p, e) {
  if (!e.alive || p.state !== 'alive') return;
  if (!boxesOverlap(p, e)) return;

  const enemyTop = e.y - e.h / 2;
  const stompDepth = p.y - enemyTop;
  const feetAboveEnemyTop = p.y >= enemyTop - 0.15;
  const notTooDeep = stompDepth < e.h * 0.75;
  const falling = p.vy > 0.5;
  const stomping = feetAboveEnemyTop && notTooDeep && (falling || !p.onGround);

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
    p.score += comboScore[Math.min(p.combo - 1, comboScore.length - 1)];

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
  e.kickT = 0.35;
  p.score += 100;
}

// 玩家与 Boss
function resolveBossHit(level, p, boss) {
  if (!boss || boss.hp <= 0 || p.state !== 'alive') return;
  if (!boxesOverlap(p, boss)) return;

  const bossTop = boss.y - boss.h / 2;
  const stompDepth = p.y - bossTop;
  const fromAbove = p.y >= bossTop - 0.15 && stompDepth < boss.h * 0.75 &&
                    (p.vy > 0.5 || !p.onGround);

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
    if (boxesOverlap(p, f)) {
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
      // 每 100 金币 +1 命（正版机制，这里保留）
      if (p.coins % 100 === 0) p.lives += 1;
    }
  }
}

// 吃蘑菇/花
function resolveItemHit(level, p) {
  for (const it of level.items) {
    if (!it.active) continue;
    if (boxesOverlap(p, it)) {
      it.active = false;
      if (it.type === 'mushroom') {
        // 蘑菇：小 → 超级；已经是超级则加分
        if (p.form === FORM.SMALL) {
          setForm(p, FORM.SUPER);
          p.hurtT = 0.5;
        }
        p.score += 1000;
      } else {
        // 花：小/超级 → 火焰
        setForm(p, FORM.FIRE);
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
  if (boxHitsFlag(level.grid, p.x - p.w / 2, p.y - p.h, p.w, p.h)) {
    p.state = 'done';
    p.finishT = level.time;
    // 过关加分：剩余时间换算（简化：固定奖励）
    p.score += 5000;
  }
}

/* ========== 顶砖块 / 问号砖 ========== */

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

  for (let rowOff = 0; rowOff <= 1; rowOff++) {
    const headRow = Math.floor(headY - 0.02) - rowOff;
    for (let c = c0; c <= c1; c++) {
      if (!inGrid(grid, c, headRow)) continue;
      const ch = grid[headRow][c];
      if (ch !== T.QUESTION && ch !== T.BRICK) continue;

      if (ch === T.QUESTION) {
        grid[headRow][c] = T.USED;
        p.score += 200;
        // 确定性决定内容：按列+行奇偶。
        //   偶数 → 金币（直接加）
        //   奇数 → 道具（小马里奥给蘑菇，大马里奥给花）
        const isCoin = ((c + headRow) % 2 === 0);
        if (isCoin) {
          p.coins += 1;
          p.score += 200;
          if (p.coins % 100 === 0) p.lives += 1;
        } else {
          const isBig = p.form !== FORM.SMALL;
          level.items.push({
            id: level.items.length,
            type: isBig ? 'flower' : 'mushroom',
            x: c + 0.5, y: headRow + 0.5,
            w: 0.7, h: 0.7,
            vx: isBig ? 0 : 1.2,
            vy: 0,
            active: true,
            emerge: 0.3
          });
        }
      } else {
        // 普通砖：大马里奥顶碎，小马里奥只顶一下（砖块保留）
        if (p.form !== FORM.SMALL) {
          grid[headRow][c] = T.EMPTY;   // 顶碎
          p.score += 50;
        } else {
          p.score += 10;
        }
      }
      return;
    }
  }
}

/* ========== 世界步进 ========== */

// inputs: { seat: input }，缺省的座位用空输入
function stepWorld(level, players, inputs, dt) {
  level.time += dt;

  // 平台先动（玩家本帧要能踩到新位置）
  for (const pl of level.platforms) stepPlatform(level, pl, dt);
  for (const it of level.items) stepItem(level, it, dt);
  for (const e of level.enemies) stepEnemy(level, e, dt);
  stepFireballs(level, dt);
  stepPlayerFireballs(level, dt);

  // 玩家物理
  for (const p of players) {
    const inp = inputs[p.seat] || makeInput();
    stepPlayer(level, p, inp, dt);
    resolvePlatformRide(level, p, dt);
    // 跑键连发火球（正版是单按一次发一颗，这里用冷却控制节奏）
    if (p.form === FORM.FIRE && inp.run && p.state === 'alive' && p.fireCd <= 0) {
      spawnFireball(level, p);
    }
  }

  // 交互
  for (const p of players) {
    if (p.state !== 'alive') continue;
    resolveCoinHit(level, p);
    resolveItemHit(level, p);
    for (const e of level.enemies) resolveEnemyHit(level, p, e);
    resolveBossHit(level, p, level.boss);
    resolveFireballHit(level, p);
    resolveHazards(level, p);
  }

  resolveShellHits(level, players);
  resolvePlayerFireballHits(level, players);

  // 敌人自己的计时（滑行壳被踢后的保护时间）
  for (const e of level.enemies) {
    if (e.kickT > 0) e.kickT -= dt;
  }

  if (level.boss) stepBoss(level, level.boss, players, dt);
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

/* ========== 序列化（联机同步） ========== */

function playerToWire(p) {
  return {
    x: round3(p.x), y: round3(p.y), vx: round3(p.vx), vy: round3(p.vy),
    f: p.face, g: p.onGround ? 1 : 0,
    fm: p.form,
    st: p.state, lv: p.lives, cn: p.coins, sc: p.score
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
    p1: playerToWire(players[0]),
    p2: players[1] ? playerToWire(players[1]) : null,
    es,
    cs,
    bs: level.boss ? [level.boss.hp, level.boss.phase, round3(level.boss.x)] : null
  };
}

module.exports = {
  TICK, PHYS, T, E, FORM, SOLID, DEADLY,
  makeGrid, gridRows, tileAt, isSolid, inGrid,
  boxHitsSolid, boxHitsDeadly, boxHitsFlag, groundTileAt, boxesOverlap,
  loadLevel, makePlayer, makeInput, playerHeight, setForm,
  stepPlayer, stepEnemy, stepPlatform, stepItem, stepBoss,
  stepFireballs, stepPlayerFireballs, stepWorld,
  resolveEnemyHit, resolveBossHit, resolveFireballHit,
  resolveCoinHit, resolveItemHit, resolveHazards, resolvePlatformRide,
  resolveShellHits, resolvePlayerFireballHits,
  hitHeadBlock, hurtPlayer, kickShell, spawnFireball,
  isLevelCleared, raceWinner, isGameOver,
  playerToWire, worldToWire, round3
};
