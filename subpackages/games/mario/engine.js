// 马里奥横版平台跳跃引擎（纯逻辑，无 wx 依赖，可 node 单测）。
//
// 设计约束：这是联机游戏的核心，host 和 guest 必须跑出完全相同的结果，
// 否则客户端预测会和权威状态对不上。所以：
//   1. 固定步长物理：所有调用方按 TICK = 1/60 秒推进，绝不依赖真实帧率
//   2. 纯函数式状态：step(state, inputs) 返回新状态，不读写外部变量
//   3. 不用 Math.random() —— 敌人 AI 用确定性正弦/计数器驱动
//      （否则双方模拟分叉，联机会看到敌人位置不一致）
//
// 坐标系统：单位 = 格（tile），1 格 = 16 逻辑单位。
//   玩家用浮点坐标 (x, y) 表示「脚底中心点」所在格位置，
//   w/h 为碰撞盒尺寸（格）。
//   向右为 x 正方向，向下为 y 正方向（与瓦片数组 row 索引一致）。

const C = require('../../../utils/constants.js');

const TICK = 1 / 60;

/* ========== 物理常量 ========== */
// 手感调校过的值（格/秒 或 格/秒²）
const PHYS = {
  GRAVITY: 34,            // 重力加速度（格/秒²）
  GRAVITY_HOLD: 18,       // 按住跳跃键时的重力（跳得更高）
  MAX_FALL: 22,           // 最大下落速度
  WALK_ACCEL: 60,         // 走路加速度
  WALK_MAX: 5.2,          // 最大走路速度
  RUN_MAX: 8.0,           // 奔跑最大速度
  FRICTION: 40,           // 地面摩擦
  ICE_FRICTION: 3,        // 冰面摩擦（极低，会打滑）
  AIR_CONTROL: 0.7,       // 空中操控系数
  JUMP_VEL: 11.5,         // 起跳初速度
  JUMP_CUT: 0.42,         // 松键后速度衰减系数（可变跳跃高度）
  COYOTE: 0.10,           // 土狼时间：离地后仍可起跳的宽限（秒）
  BUFFER: 0.12,           // 跳跃缓冲：落地前按跳也能起跳（秒）
  STOMP_BOUNCE: 9.5,      // 踩敌反弹速度
  DEATH_FALL_Y: 17        // 掉出地图即死的 y 阈值
};

/* ========== 瓦片类型 ========== */
const T = {
  EMPTY: '.', GROUND: '#', BRICK: 'B', QUESTION: '?',
  SPIKE: 'S', PIPE: 'P', FLAG: 'F', ICE: 'I', PLATFORM: '=', LIFT: '^'
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
// 尖刺不阻挡移动，但是致命
const DEADLY = {};
DEADLY[T.SPIKE] = true;

/* ========== 敌人类型 ========== */
const E = {
  GOOMBA: 'goomba',   // 走怪：左右巡逻，可被踩
  TURTLE: 'turtle',   // 乌龟：巡逻，踩后变壳
  FLYER: 'flyer'      // 飞行怪：正弦上下浮动
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
  if (col < 0 || col >= line.length) return T.GROUND;   // 左右边界视作实心，防止走出地图
  return line[col];
}

function isSolid(grid, col, row) {
  return !!SOLID[tileAt(grid, col, row)];
}

// AABB 与单个瓦片格重叠？
function overlapsBox(x, y, w, h, col, row) {
  return x < col + 1 && x + w > col && y < row + 1 && y + h > row;
}

// 碰撞盒是否与任何实心瓦片重叠
function boxHitsSolid(grid, x, y, w, h) {
  const c0 = Math.floor(x), c1 = Math.floor(x + w - 0.0001);
  const r0 = Math.floor(y), r1 = Math.floor(y + h - 0.0001);
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
      x: e.col + 0.5,        // 敌人坐标用「中心点」
      y: e.row + 0.5,
      w: 0.8, h: 0.8,
      vx: e.type === E.FLYER ? 0 : -1.0,
      vy: 0,
      dir: -1,
      homeX: e.col + 0.5,
      homeY: e.row + 0.5,
      range: e.range || 3,
      phase: (i * 37) % 100 / 100 * Math.PI * 2,   // 确定性相位，避免随机
      alive: true,
      squashT: 0             // 被踩后的壳状态计时
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
      id: i, type: it.type,
      x: it.col + 0.5, y: it.row + 0.5,
      w: 0.7, h: 0.7,
      vx: 1.2, vy: 0, active: true
    });
  }
  const boss = spec.boss
    ? {
        x: spec.boss.col + 0.5, y: spec.boss.row + 0.5,
        w: 2.0, h: 1.8,
        hp: spec.boss.hp, phase: 1,
        vx: 0, vy: 0, dir: -1,
        hurtT: 0, tick: 0
      }
    : null;

  return {
    grid,
    rows: gridRows(grid),
    cols: grid[0].length,
    rowsH: grid.length,
    coins, enemies, platforms, items, boss,
    start: spec.start || { col: 2, row: 12 },
    checkpoints: spec.checkpoints || [],
    name: spec.name || '',
    time: 0
  };
}

/* ========== 玩家 ========== */

function makePlayer(level, seat) {
  return {
    seat,
    x: level.start.col + 0.5,
    y: level.start.row + 0.5,
    w: 0.7, h: 0.9,
    vx: 0, vy: 0,
    face: 1,
    onGround: false,
    big: false,             // 是否变大（吃到蘑菇）
    hurtT: 0,               // 受伤无敌时间
    coyote: 0,              // 土狼计时
    buffer: 0,              // 跳跃缓冲计时
    jumpHeld: false,
    lives: C.MARIO_LIVES,
    coins: 0,
    state: 'alive',         // alive | dying | dead | done
    deathT: 0,
    respawnX: level.start.col + 0.5,
    respawnY: level.start.row + 0.5,
    finishT: 0
  };
}

// 玩家输入（联机时就是云端同步的东西）
function makeInput() {
  return { left: false, right: false, up: false, down: false, run: false };
}

/* ========== 单人物理步进 ========== */

// 只推进一个玩家的物理（不含敌人/金币交互，那些在世界层处理）
function stepPlayer(level, p, input, dt) {
  if (p.state === 'dying') {
    p.deathT += dt;
    p.vy += PHYS.GRAVITY * dt * 0.6;
    p.y += p.vy * dt;
    if (p.deathT > C.MARIO_DEATH_RESPAWN_MS / 1000) {
      p.lives -= 1;                      // 先扣命，再决定重生还是彻底死亡
      p.deathT = 0;
      if (p.lives > 0) {
        p.state = 'alive';
        p.x = p.respawnX;
        p.y = p.respawnY;
        p.vx = 0; p.vy = 0;
        p.hurtT = 1.0;
        p.big = false;                   // 重生后回到小形态
      } else {
        p.state = 'dead';
      }
    }
    return;
  }
  if (p.state === 'dead' || p.state === 'done') return;

  if (p.hurtT > 0) p.hurtT -= dt;

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
    // 摩擦减速
    const f = (onIce ? PHYS.ICE_FRICTION : PHYS.FRICTION) * dt;
    if (p.vx > 0) p.vx = Math.max(0, p.vx - f);
    else if (p.vx < 0) p.vx = Math.min(0, p.vx + f);
  }
  // 限速
  if (p.vx > maxSpeed) p.vx = Math.max(maxSpeed, p.vx - accel * dt * 2);
  if (p.vx < -maxSpeed) p.vx = Math.min(-maxSpeed, p.vx + accel * dt * 2);

  // 跳跃：土狼时间 + 输入缓冲，让操作手感宽容
  if (input.up && !p.jumpHeld) p.buffer = PHYS.BUFFER;
  p.jumpHeld = input.up;
  if (p.buffer > 0) p.buffer -= dt;
  if (p.coyote > 0) p.coyote -= dt;
  // 站在地面上时土狼时间始终是满的（这次才真正实现"土狼"语义：
  // 只有刚离开地面的那一小段时间仍允许起跳）
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

  // ---- 移动 + 碰撞（分轴解算，避免卡进墙里）----
  const grid = level.grid;

  // X 轴
  let nx = p.x + p.vx * dt;
  if (boxHitsSolid(grid, nx - p.w / 2, p.y - p.h, p.w, p.h)) {
    // 贴住障碍：二分回退到刚好接触
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
    if (p.vy > 0) landed = true;   // 向下撞 → 落地
    ny = p.y + lo;
    p.vy = 0;
  }
  p.y = ny;

  // 落地状态与土狼时间。
  // 语义：本帧向下碰撞 → landed=true；否则探测脚下是否仍有实心支撑。
  // 注意 hasSupport 必须是一条极薄的探针（不是整个身体）：
  // 若用身体盒去探，走出平台边缘时身体仍可能与身前的墙重叠，被误判为站在地上。
  const supportRow = Math.floor(p.y + 0.02);
  const c0 = Math.floor(p.x - p.w / 2 + 0.02);
  const c1 = Math.floor(p.x + p.w / 2 - 0.02);
  let hasSupport = false;
  for (let c = c0; c <= c1; c++) {
    if (isSolid(grid, c, supportRow)) { hasSupport = true; break; }
  }
  if (landed || hasSupport) {
    p.onGround = true;
    p.coyote = PHYS.COYOTE;
  } else {
    p.onGround = false;
  }

  // 掉出地图
  if (p.y > PHYS.DEATH_FALL_Y && p.state === 'alive') {
    p.state = 'dying';
    p.deathT = 0;
    p.vy = -8;
  }
}

/* ========== 敌人 ========== */

function stepEnemy(level, e, dt) {
  if (!e.alive) return;
  e.tick = (e.tick || 0) + dt;

  if (e.type === E.FLYER) {
    // 飞行怪：水平巡逻 + 正弦上下，全部确定性计算
    e.x += e.vx * dt;
    if (Math.abs(e.x - e.homeX) > e.range) {
      e.vx = -e.vx;
      e.dir = e.vx > 0 ? 1 : -1;
    }
    e.y = e.homeY + Math.sin(level.time * 2.2 + e.phase) * 1.1;
    return;
  }

  // 走怪 / 乌龟：受重力、撞墙转向
  e.vy += PHYS.GRAVITY * dt;
  if (e.vy > PHYS.MAX_FALL) e.vy = PHYS.MAX_FALL;

  let nx = e.x + e.vx * dt;
  if (boxHitsSolid(level.grid, nx - e.w / 2, e.y - e.h / 2, e.w, e.h)) {
    e.vx = -e.vx;
    e.dir = e.vx > 0 ? 1 : -1;
    nx = e.x;
  }
  // 巡逻范围限制（防止走太远掉坑里没人管）
  if (Math.abs(nx - e.homeX) > e.range) {
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

  // 掉坑
  if (e.y > PHYS.DEATH_FALL_Y) e.alive = false;
}

function stepPlatform(level, pl, dt) {
  pl.t += dt;
  const period = (pl.len * 2) / pl.speed;
  const u = (pl.t % period) / period;
  // 三角波 0→1→0
  const tri = u < 0.5 ? u * 2 : 2 - u * 2;
  const off = (tri - 0.5) * pl.len;
  if (pl.axis === 'h') pl.x = pl.homeX + off;
  else pl.y = pl.homeY + off;
}

function stepItem(level, it, dt) {
  if (!it.active) return;
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

/* ========== Boss ========== */

// Boss 三阶段：1 火球弹幕 → 2 冲撞 → 3 虚弱（可被踩）
function stepBoss(level, boss, players, dt) {
  if (!boss || boss.hp <= 0) return;
  boss.tick += dt;
  if (boss.hurtT > 0) boss.hurtT -= dt;

  // 阶段随血量切换
  if (boss.phase === 1 && boss.hp <= 2) boss.phase = 2;
  if (boss.phase === 2 && boss.hp <= 1) boss.phase = 3;

  if (boss.phase === 1) {
    // 缓慢横向移动 + 定期喷火球
    boss.x += boss.vx * dt;
    if (Math.abs(boss.x - 30.5) > 4) boss.vx = -boss.vx;
    if (boss.vx === 0) boss.vx = 1.0;
    // 每 2 秒在玩家位置生成一个火球（确定性：按 tick 计数触发）
    if (!boss.fireCd) boss.fireCd = 0;
    boss.fireCd -= dt;
    if (boss.fireCd <= 0) {
      boss.fireCd = 2.0;
      const target = nearestPlayer(players, boss.x);
      if (target) {
        if (!level.fireballs) level.fireballs = [];
        level.fireballs.push({
          x: boss.x, y: boss.y - 0.5,
          vx: (target.x - boss.x) > 0 ? 3 : -3,
          vy: -1.5, life: 3
        });
      }
    }
  } else if (boss.phase === 2) {
    // 冲撞：朝最近的玩家高速冲
    const target = nearestPlayer(players, boss.x);
    if (target) boss.vx = (target.x - boss.x) > 0 ? 5.5 : -5.5;
    boss.x += boss.vx * dt;
  } else {
    // 虚弱：原地颤抖，可被踩
    boss.vx = 0;
    boss.x = boss.homeXOf ? boss.homeXOf : boss.x;
  }

  // 限制在关卡内
  const cols = level.cols;
  if (boss.x < 26) boss.x = 26;
  if (boss.x > cols - 4) boss.x = cols - 4;
}

function nearestPlayer(players, x) {
  let best = null, bd = Infinity;
  for (const p of players) {
    if (p.state !== 'alive') continue;
    const d = Math.abs(p.x - x);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

function stepFireballs(level, dt) {
  if (!level.fireballs) return;
  const keep = [];
  for (const f of level.fireballs) {
    f.life -= dt;
    // 火球没有 w/h 会域，补默认值（否则 boxesOverlap 全为 false，永远打不中玩家）
    if (f.w === undefined) { f.w = 0.5; f.h = 0.5; }
    f.vy += PHYS.GRAVITY * 0.35 * dt;
    f.x += f.vx * dt;
    f.y += f.vy * dt;
    if (f.life > 0 && f.y < PHYS.DEATH_FALL_Y) keep.push(f);
  }
  level.fireballs = keep;
}

/* ========== 交互 ========== */

function boxesOverlap(a, b) {
  return a.x - a.w / 2 < b.x + b.w / 2 && a.x + a.w / 2 > b.x - b.w / 2 &&
         a.y - a.h / 2 < b.y + b.h / 2 && a.y + a.h / 2 > b.y - b.h / 2;
}

// 玩家与敌人的碰撞：踩头 / 被撞。
// 判据说明：p.y 是玩家「脚底」，e.y - e.h/2 是敌人「头顶」。
// 踩头的充要条件是「脚底落在敌人头顶附近且深度不大」——深度用玩家盒底
// 与敌人盒底的距离衡量：若玩家盒底已经掉到敌人盒底以下，那就是侧面/下方撞到。
// 早期版本只写「脚底 >= 敌人顶 - 0.25」，容差太松，玩家从侧面甚至下方蹭到
// 都会被判成踩头，敌人白死。现在用「踩入深度 < 敌人半高」严格判定。
function resolveEnemyHit(level, p, e) {
  if (!e.alive || p.state !== 'alive') return;
  if (!boxesOverlap(p, e)) return;

  const enemyTop = e.y - e.h / 2;
  const enemyBottom = e.y + e.h / 2;
  const feetAboveEnemyTop = p.y >= enemyTop - 0.15;
  const stompDepth = p.y - enemyTop;              // 脚底踩进敌人盒多深
  const notTooDeep = stompDepth < e.h * 0.75;     // 深度小于敌人 3/4 高度算踩
  const falling = p.vy > 0.5;

  if (feetAboveEnemyTop && notTooDeep && (falling || !p.onGround)) {
    // 踩中：敌人死，玩家反弹
    e.alive = false;
    p.vy = -PHYS.STOMP_BOUNCE;
    p.onGround = false;
    return;
  }
  // 侧面/下方撞到：受伤或死亡
  if (p.hurtT <= 0) {
    if (p.big) {
      p.big = false;
      p.hurtT = 1.5;
    } else {
      p.state = 'dying';
      p.deathT = 0;
      p.vy = -8;
    }
  }
}

// 玩家与 Boss 的碰撞。踩头判据同 resolveEnemyHit：
// 脚底落在 Boss 头顶附近且踩入深度不大，才算踩头。
function resolveBossHit(level, p, boss) {
  if (!boss || boss.hp <= 0 || p.state !== 'alive') return;
  if (!boxesOverlap(p, boss)) return;

  const bossTop = boss.y - boss.h / 2;
  const stompDepth = p.y - bossTop;
  const feetAboveBossTop = p.y >= bossTop - 0.15;
  const notTooDeep = stompDepth < boss.h * 0.75;
  const falling = p.vy > 0.5;
  const fromAbove = feetAboveBossTop && notTooDeep && (falling || !p.onGround);

  if (fromAbove && boss.phase === 3) {
    // 虚弱期才能被踩掉血
    boss.hp -= 1;
    boss.hurtT = 0.8;
    p.vy = -PHYS.STOMP_BOUNCE;
    p.onGround = false;
    return;
  }
  if (fromAbove) {
    // 非虚弱期踩到也会弹，但 Boss 不掉血；玩家反而可能受伤
    p.vy = -PHYS.STOMP_BOUNCE;
    p.onGround = false;
    if (p.hurtT <= 0) {
      if (p.big) { p.big = false; p.hurtT = 1.5; }
      else {
        p.state = 'dying';
        p.deathT = 0;
        p.vy = -8;
      }
    }
    return;
  }
  // 侧面撞 Boss
  if (p.hurtT <= 0) {
    if (p.big) { p.big = false; p.hurtT = 1.5; }
    else {
      p.state = 'dying';
      p.deathT = 0;
      p.vy = -8;
    }
  }
}

function resolveFireballHit(level, p) {
  if (!level.fireballs || p.state !== 'alive') return;
  for (const f of level.fireballs) {
    if (boxesOverlap(p, f) && p.hurtT <= 0) {
      f.life = 0;
      if (p.big) { p.big = false; p.hurtT = 1.5; }
      else {
        p.state = 'dying';
        p.deathT = 0;
        p.vy = -8;
      }
    }
  }
}

function resolveCoinHit(level, p) {
  for (const c of level.coins) {
    if (c.taken) continue;
    if (Math.abs(p.x - (c.col + 0.5)) < 0.6 && Math.abs(p.y - (c.row + 0.5)) < 0.8) {
      c.taken = true;
      p.coins += 1;
    }
  }
}

function resolveItemHit(level, p) {
  for (const it of level.items) {
    if (!it.active) continue;
    if (boxesOverlap(p, it)) {
      it.active = false;
      p.big = true;
      p.hurtT = 0.6;
    }
  }
}

function resolveHazards(level, p) {
  if (p.state !== 'alive') return;
  if (boxHitsDeadly(level.grid, p.x - p.w / 2, p.y - p.h, p.w, p.h)) {
    p.state = 'dying';
    p.deathT = 0;
    p.vy = -8;
    return;
  }
  if (boxHitsFlag(level.grid, p.x - p.w / 2, p.y - p.h, p.w, p.h)) {
    p.state = 'done';
    p.finishT = level.time;
  }
}

// 移动平台承载玩家：站在平台上时跟着平台一起动，且被平台"接住"。
// 判定要宽松：平台每帧在动，玩家下落速度也可能很快（最多 22 格/秒 ≈ 0.37 格/帧），
// 所以容差取 0.45 格（略大于单帧最大下落位移），否则高速下落会穿过平台。
//
// 注意：平台承载必须「带着玩家走」，否则玩家站在水平平台上会原地打滑
// （平台跑了自己没动，几帧后就掉下来）。做法是把平台本帧位移叠加到玩家 x/y 上。
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
      // 记录平台位移量，让玩家跟着走（首次接触时无上次位置，跳过）
      if (pl.px !== undefined) {
        p.x += (pl.x - pl.px);
      }
    }
    pl.px = pl.x;   // 供下一帧计算位移
  }
}

/* ========== 世界步进 ========== */

// 推进整个世界一帧。
// inputs: { seat: input }，缺省的座位用空输入（保持重力等物理继续跑）
function stepWorld(level, players, inputs, dt) {
  level.time += dt;

  // 平台先动（玩家本帧要能踩到新位置）
  for (const pl of level.platforms) stepPlatform(level, pl, dt);
  for (const it of level.items) stepItem(level, it, dt);
  for (const e of level.enemies) stepEnemy(level, e, dt);
  stepFireballs(level, dt);

  // 玩家物理
  for (const p of players) {
    const inp = inputs[p.seat] || makeInput();
    stepPlayer(level, p, inp, dt);
    resolvePlatformRide(level, p, dt);
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

  if (level.boss) stepBoss(level, level.boss, players, dt);
}

/* ========== 胜负判定 ========== */

// 合作模式：所有人都到终点才算过关
function isLevelCleared(level, players) {
  for (const p of players) {
    if (p.state !== 'done') return false;
  }
  return true;
}

// 竞速模式：第一个到终点的人赢
function raceWinner(level, players) {
  let best = null, bt = Infinity;
  for (const p of players) {
    if (p.state === 'done' && p.finishT < bt) { bt = p.finishT; best = p; }
  }
  return best ? best.seat : 0;
}

// 是否全部结束（无人还能继续）
function isGameOver(level, players) {
  for (const p of players) {
    if (p.state !== 'dead' && p.state !== 'done') return false;
  }
  return true;
}

/* ========== 序列化（联机同步用） ========== */

function playerToWire(p) {
  return {
    x: round3(p.x), y: round3(p.y), vx: round3(p.vx), vy: round3(p.vy),
    f: p.face, g: p.onGround ? 1 : 0, b: p.big ? 1 : 0,
    st: p.state, lv: p.lives, cn: p.coins
  };
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

function worldToWire(level, players) {
  const es = [];
  for (const e of level.enemies) {
    es.push([e.id, e.alive ? 1 : 0, round3(e.x), round3(e.y)]);
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

/* ========== 导出 ========== */

module.exports = {
  TICK, PHYS, T, E, SOLID, DEADLY,
  makeGrid, gridRows, tileAt, isSolid,
  boxHitsSolid, boxHitsDeadly, boxHitsFlag, groundTileAt, overlapsBox, boxesOverlap,
  loadLevel, makePlayer, makeInput,
  stepPlayer, stepEnemy, stepPlatform, stepItem, stepBoss, stepFireballs,
  stepWorld,
  resolveEnemyHit, resolveBossHit, resolveFireballHit,
  resolveCoinHit, resolveItemHit, resolveHazards, resolvePlatformRide,
  isLevelCleared, raceWinner, isGameOver,
  playerToWire, worldToWire, round3
};
