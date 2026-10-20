// 马里奥 Canvas 2d 渲染层。
// 与 engine.js 分离的原因：engine 是纯逻辑（可 node 单测），
// 这里依赖 wx 的 canvas/离屏 canvas，只能在页面里跑。
//
// 渲染策略：
//   1. 摄像机跟随玩家，只画视口内的瓦片（80 格宽的关卡不用全画）
//   2. 静态背景（天空渐变 + 远景山）用离屏 canvas 缓存，尺寸与视口相同
//   3. 瓦片按类型分色绘制，问号砖加「?」字，尖刺画三角
//   4. 玩家/敌人/Boss 用矢量图形（圆 + 矩形）拼，零素材依赖
//      —— 日后要换皮只需替换 drawPlayer/drawEnemy 里的贴图调用

const TILE = 16;        // 每格像素（逻辑尺寸，实际乘 scale）

// 调色板（沿用项目粉色系做 UI，游戏内用经典马里奥配色）
const PAL = {
  sky0: '#5C94FC',
  sky1: '#9BD1FF',
  ground: '#C84C0C',
  groundTop: '#E89040',
  brick: '#B5451B',
  question: '#F8B800',
  questionDark: '#C07800',
  spike: '#7A7A7A',
  pipe: '#00A800',
  pipeDark: '#007800',
  ice: '#A8D8F0',
  iceTop: '#E0F4FF',
  flag: '#00C000',
  flagPole: '#888888',
  platform: '#D8A050',
  coin: '#FFD700',
  coinDark: '#C8A000',
  playerA: '#E52521',     // 玩家 1（红）
  playerB: '#1E90FF',     // 玩家 2（蓝）
  playerSkin: '#FFCC99',
  enemy: '#8B4513',
  enemyDark: '#5C2E0B',
  boss: '#2C3E50',
  bossHurt: '#E74C3C'
};

/* ========== 摄像机 ========== */

// 摄像机 x：让目标玩家保持在视口 40% 处，并夹在关卡边界内
function cameraX(level, targetX, viewW) {
  const want = targetX - viewW * 0.4;
  const maxX = level.cols - viewW;
  if (maxX <= 0) return 0;
  if (want < 0) return 0;
  if (want > maxX) return maxX;
  return want;
}

// 摄像机 y：让玩家保持在视口 55% 处。
// 关卡高 16 行，而视口通常只有 ~9 格高，若 camY 恒为 0，
// 玩家起点在 row 12、地面在 row 14~15，全部落在视口下方 → 画不出来
// （线上实测：只看到天空，人物和地面全在画布外）。
// 让 camY 跟随玩家，就能让可玩区始终在视口内。
function cameraY(level, targetY, viewH) {
  const want = targetY - viewH * 0.55;
  const maxY = level.rowsH - viewH;
  if (maxY <= 0) return 0;
  if (want < 0) return 0;
  if (want > maxY) return maxY;
  return want;
}

/* ========== 背景缓存 ========== */

function ensureBackground(cache, w, h) {
  if (cache.canvas && cache.w === w && cache.h === h) return cache.canvas;
  const bg = wx.createOffscreenCanvas ? wx.createOffscreenCanvas({ type: '2d' }) : null;
  if (!bg) { cache.canvas = null; cache.w = w; cache.h = h; return null; }
  bg.width = w;
  bg.height = h;
  const c = bg.getContext('2d');
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, PAL.sky0);
  g.addColorStop(1, PAL.sky1);
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  // 简单的云（确定性位置，不用随机）
  c.fillStyle = 'rgba(255,255,255,0.85)';
  const clouds = [[0.15, 0.15, 1.0], [0.45, 0.25, 0.7], [0.75, 0.12, 1.2], [0.9, 0.3, 0.8]];
  for (const cl of clouds) {
    const cx = cl[0] * w, cy = cl[1] * h, s = cl[2];
    c.beginPath();
    c.arc(cx, cy, 14 * s, 0, Math.PI * 2);
    c.arc(cx + 16 * s, cy - 6 * s, 11 * s, 0, Math.PI * 2);
    c.arc(cx + 30 * s, cy, 13 * s, 0, Math.PI * 2);
    c.fill();
  }
  cache.canvas = bg;
  cache.w = w;
  cache.h = h;
  return bg;
}

/* ========== 瓦片 ========== */

function drawTile(ctx, ch, x, y, s) {
  switch (ch) {
    case '#':   // 地面
      ctx.fillStyle = PAL.ground;
      ctx.fillRect(x, y, s, s);
      ctx.fillStyle = PAL.groundTop;
      ctx.fillRect(x, y, s, s * 0.22);
      break;
    case 'B':   // 砖块
      ctx.fillStyle = PAL.brick;
      ctx.fillRect(x, y, s, s);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
      ctx.beginPath();
      ctx.moveTo(x, y + s / 2); ctx.lineTo(x + s, y + s / 2);
      ctx.moveTo(x + s / 2, y); ctx.lineTo(x + s / 2, y + s / 2);
      ctx.moveTo(x + s / 4, y + s / 2); ctx.lineTo(x + s / 4, y + s);
      ctx.moveTo(x + s * 0.75, y + s / 2); ctx.lineTo(x + s * 0.75, y + s);
      ctx.stroke();
      break;
    case '?':   // 问号砖
      ctx.fillStyle = PAL.question;
      ctx.fillRect(x, y, s, s);
      ctx.strokeStyle = PAL.questionDark;
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, s - 2, s - 2);
      ctx.fillStyle = PAL.questionDark;
      ctx.font = 'bold ' + Math.floor(s * 0.7) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', x + s / 2, y + s / 2 + 1);
      break;
    case 'S':   // 尖刺
      ctx.fillStyle = PAL.spike;
      const n = 3, w = s / n;
      for (let i = 0; i < n; i++) {
        ctx.beginPath();
        ctx.moveTo(x + i * w, y + s);
        ctx.lineTo(x + i * w + w / 2, y + s * 0.2);
        ctx.lineTo(x + (i + 1) * w, y + s);
        ctx.closePath();
        ctx.fill();
      }
      break;
    case 'P':   // 管道
      ctx.fillStyle = PAL.pipe;
      ctx.fillRect(x, y, s, s);
      ctx.fillStyle = PAL.pipeDark;
      ctx.fillRect(x, y, s * 0.2, s);
      ctx.fillRect(x + s * 0.8, y, s * 0.2, s);
      break;
    case 'I':   // 冰面
      ctx.fillStyle = PAL.ice;
      ctx.fillRect(x, y, s, s);
      ctx.fillStyle = PAL.iceTop;
      ctx.fillRect(x, y, s, s * 0.18);
      break;
    case '=':   // 移动平台（静态瓦片版，实际平台由实体绘制）
      ctx.fillStyle = PAL.platform;
      ctx.fillRect(x, y, s, s * 0.5);
      break;
    case '^':   // 升降台
      ctx.fillStyle = PAL.platform;
      ctx.fillRect(x, y + s * 0.3, s, s * 0.4);
      break;
    case 'F':   // 终点旗
      ctx.fillStyle = PAL.flagPole;
      ctx.fillRect(x + s * 0.45, y, s * 0.1, s);
      ctx.fillStyle = PAL.flag;
      ctx.beginPath();
      ctx.moveTo(x + s * 0.55, y + s * 0.08);
      ctx.lineTo(x + s, y + s * 0.28);
      ctx.lineTo(x + s * 0.55, y + s * 0.48);
      ctx.closePath();
      ctx.fill();
      break;
    default:
      break;
  }
}

/* ========== 角色 ========== */

// 玩家：圆头 + 身体 + 腿，seat 决定颜色
function drawPlayer(ctx, p, x, y, s, time) {
  const color = p.seat === 1 ? PAL.playerA : PAL.playerB;
  const big = p.big ? 1.25 : 1;
  const bodyH = s * 0.55 * big;
  const headR = s * 0.28 * big;

  // 受伤闪烁
  if (p.hurtT > 0 && Math.floor(p.hurtT * 12) % 2 === 0) return;

  // 腿（走路时交替）
  const walking = Math.abs(p.vx) > 0.5 && p.onGround;
  const legPhase = walking ? Math.sin(time * 14) : 0;
  ctx.strokeStyle = '#3A2A1A';
  ctx.lineWidth = Math.max(2, s * 0.1);
  ctx.beginPath();
  ctx.moveTo(x - s * 0.12, y - bodyH);
  ctx.lineTo(x - s * 0.12 + legPhase * s * 0.14, y);
  ctx.moveTo(x + s * 0.12, y - bodyH);
  ctx.lineTo(x + s * 0.12 - legPhase * s * 0.14, y);
  ctx.stroke();

  // 身体
  ctx.fillStyle = color;
  ctx.fillRect(x - s * 0.26 * big, y - bodyH - headR * 1.6, s * 0.52 * big, bodyH + headR * 0.4);

  // 头
  ctx.fillStyle = PAL.playerSkin;
  ctx.beginPath();
  ctx.arc(x, y - bodyH - headR * 1.5, headR, 0, Math.PI * 2);
  ctx.fill();

  // 帽子（朝向前方）
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y - bodyH - headR * 1.6, headR, Math.PI, 0);
  ctx.fill();
  ctx.fillRect(x + (p.face > 0 ? 0 : -s * 0.3), y - bodyH - headR * 1.7, s * 0.3, headR * 0.35);

  // 眼睛
  ctx.fillStyle = '#1A1A1A';
  ctx.beginPath();
  ctx.arc(x + p.face * headR * 0.35, y - bodyH - headR * 1.45, headR * 0.13, 0, Math.PI * 2);
  ctx.fill();
}

// 敌人
function drawEnemy(ctx, e, x, y, s, time) {
  if (e.type === 'flyer') {
    // 飞行怪：椭圆身 + 翅膀
    const flap = Math.sin(time * 10 + e.phase) * 0.4 + 0.6;
    ctx.fillStyle = '#C0392B';
    ctx.beginPath();
    ctx.ellipse(x, y, s * 0.3, s * 0.24, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#E74C3C';
    ctx.beginPath();
    ctx.ellipse(x - s * 0.2, y - s * 0.1 * flap, s * 0.18, s * 0.1, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(x + s * 0.2, y - s * 0.1 * flap, s * 0.18, s * 0.1, 0.5, 0, Math.PI * 2);
    ctx.fill();
    // 眼睛
    ctx.fillStyle = '#FFF';
    ctx.beginPath();
    ctx.arc(x - s * 0.1, y - s * 0.05, s * 0.07, 0, Math.PI * 2);
    ctx.arc(x + s * 0.1, y - s * 0.05, s * 0.07, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  if (e.type === 'turtle') {
    // 乌龟：壳 + 头
    ctx.fillStyle = '#27AE60';
    ctx.beginPath();
    ctx.ellipse(x, y, s * 0.32, s * 0.28, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1E8449';
    ctx.beginPath();
    ctx.ellipse(x + e.dir * s * 0.28, y - s * 0.05, s * 0.14, s * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#145A32';
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(x, y - s * 0.12 + i * s * 0.12, s * 0.08, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  // 走怪：棕色圆身体 + 怒眉
  ctx.fillStyle = PAL.enemy;
  ctx.beginPath();
  ctx.ellipse(x, y, s * 0.32, s * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = PAL.enemyDark;
  ctx.fillRect(x - s * 0.32, y - s * 0.34, s * 0.64, s * 0.1);
  ctx.fillStyle = '#FFF';
  ctx.beginPath();
  ctx.arc(x - s * 0.12, y - s * 0.02, s * 0.08, 0, Math.PI * 2);
  ctx.arc(x + s * 0.12, y - s * 0.02, s * 0.08, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1A1A1A';
  ctx.beginPath();
  ctx.arc(x - s * 0.12, y - s * 0.02, s * 0.04, 0, Math.PI * 2);
  ctx.arc(x + s * 0.12, y - s * 0.02, s * 0.04, 0, Math.PI * 2);
  ctx.fill();
}

// Boss：大方块 + 尖角 + 血条
function drawBoss(ctx, boss, x, y, s) {
  const hurt = boss.hurtT > 0;
  ctx.fillStyle = hurt ? PAL.bossHurt : PAL.boss;
  const w = boss.w * s, h = boss.h * s;
  ctx.fillRect(x - w / 2, y - h / 2, w, h);
  // 尖角
  ctx.beginPath();
  ctx.moveTo(x - w / 2, y - h / 2);
  ctx.lineTo(x, y - h / 2 - s * 0.25);
  ctx.lineTo(x + w / 2, y - h / 2);
  ctx.closePath();
  ctx.fill();
  // 眼
  ctx.fillStyle = '#FFE000';
  ctx.beginPath();
  ctx.arc(x - w * 0.18, y - h * 0.1, s * 0.14, 0, Math.PI * 2);
  ctx.arc(x + w * 0.18, y - h * 0.1, s * 0.14, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1A1A1A';
  ctx.beginPath();
  ctx.arc(x - w * 0.18, y - h * 0.1, s * 0.06, 0, Math.PI * 2);
  ctx.arc(x + w * 0.18, y - h * 0.1, s * 0.06, 0, Math.PI * 2);
  ctx.fill();
  // 嘴（阶段 3 虚弱时下垂）
  ctx.strokeStyle = '#FFF';
  ctx.lineWidth = s * 0.08;
  ctx.beginPath();
  if (boss.phase === 3) {
    ctx.arc(x, y + h * 0.18, w * 0.2, Math.PI, 0);   // 倒弧 = 不高兴
  } else {
    ctx.arc(x, y + h * 0.05, w * 0.2, 0, Math.PI);   // 正弧 = 笑
  }
  ctx.stroke();
}

/* ========== 主绘制 ========== */

// 画一帧。opts:
//   ctx, level, players, time, viewW, viewH, scale, bgCache
function drawFrame(ctx, opts) {
  const level = opts.level;
  const players = opts.players;
  const s = opts.scale;                       // 每格像素
  const viewW = opts.viewW / s;               // 视口宽（格）
  const viewH = opts.viewH / s;               // 视口高（格）
  const bg = ensureBackground(opts.bgCache, opts.viewW, opts.viewH);

  // 摄像机：跟随 seat 1（host），合作模式下最直观。
  // x 和 y 都要跟随，否则纵向视口太短时地面/人物会画到画布外。
  const focus = players.find(p => p.state === 'alive') || players[0];
  const cam = cameraX(level, focus.x, viewW);
  const camY = cameraY(level, focus.y, viewH);

  // 背景
  if (bg) ctx.drawImage(bg, 0, 0, opts.viewW, opts.viewH);
  else {
    const g = ctx.createLinearGradient(0, 0, 0, opts.viewH);
    g.addColorStop(0, PAL.sky0);
    g.addColorStop(1, PAL.sky1);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, opts.viewW, opts.viewH);
  }

  // 瓦片（只画视口内的）
  const c0 = Math.max(0, Math.floor(cam) - 1);
  const c1 = Math.min(level.cols - 1, Math.ceil(cam + viewW) + 1);
  const r0 = 0, r1 = level.rowsH - 1;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const ch = level.grid[r][c];
      if (ch === '.') continue;
      drawTile(ctx, ch, (c - cam) * s, (r - camY) * s, s);
    }
  }

  // 金币
  for (const coin of level.coins) {
    if (coin.taken) continue;
    if (coin.col < cam - 1 || coin.col > cam + viewW + 1) continue;
    const cx = (coin.col + 0.5 - cam) * s;
    const cy = (coin.row + 0.5 - camY) * s;
    // 旋转效果（用宽度变化模拟）
    const w = Math.abs(Math.sin(opts.time * 4 + coin.id)) * s * 0.3 + s * 0.08;
    ctx.fillStyle = PAL.coin;
    ctx.beginPath();
    ctx.ellipse(cx, cy, w, s * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = PAL.coinDark;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // 道具（蘑菇）
  for (const it of level.items) {
    if (!it.active) continue;
    if (it.x < cam - 1 || it.x > cam + viewW + 1) continue;
    const ix = (it.x - cam) * s, iy = (it.y - camY) * s;
    ctx.fillStyle = '#E52521';
    ctx.beginPath();
    ctx.arc(ix, iy - s * 0.15, s * 0.3, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = '#FFF';
    ctx.fillRect(ix - s * 0.14, iy - s * 0.15, s * 0.28, s * 0.3);
    // 白点
    ctx.fillStyle = '#FFF';
    ctx.beginPath();
    ctx.arc(ix - s * 0.12, iy - s * 0.24, s * 0.07, 0, Math.PI * 2);
    ctx.arc(ix + s * 0.12, iy - s * 0.24, s * 0.07, 0, Math.PI * 2);
    ctx.fill();
  }

  // 移动平台
  for (const pl of level.platforms) {
    if (pl.x < cam - 3 || pl.x > cam + viewW + 3) continue;
    const px = (pl.x - cam) * s, py = (pl.y - camY) * s;
    ctx.fillStyle = PAL.platform;
    ctx.fillRect(px - pl.w * s / 2, py - pl.h * s / 2, pl.w * s, pl.h * s);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(px - pl.w * s / 2, py + pl.h * s / 2 - 2, pl.w * s, 2);
  }

  // 敌人
  for (const e of level.enemies) {
    if (!e.alive) continue;
    if (e.x < cam - 2 || e.x > cam + viewW + 2) continue;
    drawEnemy(ctx, e, (e.x - cam) * s, (e.y - camY) * s, s, opts.time);
  }

  // 火球
  if (level.fireballs) {
    for (const f of level.fireballs) {
      if (f.x < cam - 1 || f.x > cam + viewW + 1) continue;
      const fx = (f.x - cam) * s, fy = (f.y - camY) * s;
      ctx.fillStyle = '#FF6B00';
      ctx.beginPath();
      ctx.arc(fx, fy, s * 0.22, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#FFD700';
      ctx.beginPath();
      ctx.arc(fx, fy, s * 0.11, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Boss
  if (level.boss && level.boss.hp > 0) {
    drawBoss(ctx, level.boss, (level.boss.x - cam) * s, (level.boss.y - camY) * s, s);
  }

  // 玩家（最后画，压在最上层）
  for (const p of players) {
    if (p.state === 'dead') continue;
    if (p.x < cam - 2 || p.x > cam + viewW + 2) continue;
    drawPlayer(ctx, p, (p.x - cam) * s, (p.y - camY) * s, s, opts.time);
    // 玩家名牌
    ctx.fillStyle = p.seat === 1 ? PAL.playerA : PAL.playerB;
    ctx.font = 'bold ' + Math.floor(s * 0.42) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('P' + p.seat, (p.x - cam) * s, (p.y - camY) * s - s * 1.0);
  }
}

module.exports = {
  PAL, TILE,
  cameraX, cameraY, ensureBackground, drawTile,
  drawPlayer, drawEnemy, drawBoss, drawFrame
};
