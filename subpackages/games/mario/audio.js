// 马里奥 8-bit 音效：用 WebAudio 风格接口在小程序里合成方波/三角波。
// 不带任何音频文件——包体零增加，全部程序化合成（正版 SMB1 就是芯片音乐）。
//
// 接口约束：小程序 wx.createWebAudioContext() 在 iOS 上 1.7+ 支持，
// 部分低版本基础库返回 null —— 一切调用都做防御，音效失败绝不影响游戏。
//
// 注意（SWC 白屏陷阱）：不能用数组解构 / 对象展开 / 可选链。

let ctx = null;
let ctxTried = false;
let muted = false;

function ensureCtx() {
  if (ctxTried) return ctx;
  ctxTried = true;
  try {
    if (typeof wx !== 'undefined' && wx.createWebAudioContext) {
      ctx = wx.createWebAudioContext();
    }
  } catch (e) {
    ctx = null;
  }
  return ctx;
}

function setMuted(m) {
  muted = !!m;
}

function isMuted() {
  return muted;
}

// 单个音符：type='square'|'triangle'，freq(Hz)，时长(秒)，音量 0~1
function tone(type, freq, dur, vol, when) {
  if (muted) return;
  const ac = ensureCtx();
  if (!ac) return;
  try {
    const t0 = ac.currentTime + (when || 0);
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    // 快起音 + 指数衰减，模拟芯片音乐的「啪」感
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol || 0.18, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  } catch (e) { /* 音频失败静默 */ }
}

// 滑音（跳跃/下落用）：从 f0 滑到 f1
function sweep(type, f0, f1, dur, vol) {
  if (muted) return;
  const ac = ensureCtx();
  if (!ac) return;
  try {
    const t0 = ac.currentTime;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol || 0.16, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  } catch (e) { /* 静默 */ }
}

/* ========== 音效表 ========== */

const S = {
  jump()      { sweep('square', 300, 680, 0.16, 0.14); },                     // 起跳：上滑
  coin()      { tone('square', 988, 0.07, 0.15); tone('square', 1319, 0.22, 0.15, 0.07); },  // 金币：B5→E6（正版同款两连音）
  stomp()     { sweep('square', 500, 160, 0.10, 0.16); },                     // 踩敌：短促下滑
  kick()      { tone('square', 220, 0.05, 0.18); tone('square', 330, 0.07, 0.14, 0.05); },   // 踢壳
  powerup()   { // 变身：上行琶音 C E G C E G C
    const seq = [523, 659, 784, 1047, 1319, 1568, 2093];
    for (let i = 0; i < seq.length; i++) tone('square', seq[i], 0.07, 0.13, i * 0.045);
  },
  item()      { // 道具出土：温和的滑音
    sweep('triangle', 200, 500, 0.25, 0.14);
  },
  hurt()      { sweep('square', 400, 90, 0.35, 0.18); },                      // 受伤/变小
  die()       { // 死亡：正版是「短促 + 下坠音列」
    tone('square', 494, 0.1, 0.18);
    sweep('square', 700, 120, 0.6, 0.18);
  },
  oneup()     { // 1UP：上行三连音
    tone('square', 660, 0.08, 0.15);
    tone('square', 880, 0.08, 0.15, 0.09);
    tone('square', 1320, 0.2, 0.15, 0.18);
  },
  fireball()  { sweep('square', 900, 300, 0.09, 0.1); },                      // 发火球
  flag()      { // 抓旗：欢快的小琶音
    const seq = [392, 523, 659, 784, 1047];
    for (let i = 0; i < seq.length; i++) tone('square', seq[i], 0.09, 0.14, i * 0.07);
  },
  clear()     { // 过关：凯旋音列（C E G C5 长音 + 和弦感）
    const seq = [523, 659, 784, 1047, 784, 1047, 1319];
    for (let i = 0; i < seq.length; i++) tone('square', seq[i], i === seq.length - 1 ? 0.4 : 0.1, 0.15, i * 0.11);
  },
  warp()      { sweep('triangle', 700, 150, 0.4, 0.15); },                    // 进管道
  bossHurt()  { tone('sawtooth', 150, 0.15, 0.2); tone('sawtooth', 110, 0.2, 0.2, 0.12); }, // Boss 受击
  chat()      { tone('sine', 880, 0.06, 0.12); tone('sine', 1100, 0.08, 0.12, 0.06); },     // 聊天提示
  star()      { // 无敌星：闪烁琶音
    const seq = [1047, 1319, 1568, 2093, 1568, 1319];
    for (let i = 0; i < seq.length; i++) tone('square', seq[i], 0.06, 0.12, i * 0.05);
  }
};

function play(name) {
  const fn = S[name];
  if (fn) {
    try { fn(); } catch (e) { /* 任何音频异常都不影响游戏 */ }
  }
}

module.exports = { play, setMuted, isMuted };
