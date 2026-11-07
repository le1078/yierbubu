// 号码下注 · 来财页第四个栏目
// 移植自 zodiac-web/index.html（同一套规则与结算），改用小程序存储与定时器。
// 规则：号码 1–49，生肖只是分组（当年生肖 5 个号，其余各 4 个）；
//       开奖只开 1 个号码，押中同一个号码才返还 47 倍（含本金）。
// 开奖为真随机，没有任何「按押注方向改结果」的逻辑。
const ZODIAC = [
  { name: '鼠', emoji: '🐭' }, { name: '牛', emoji: '🐮' }, { name: '虎', emoji: '🐯' },
  { name: '兔', emoji: '🐰' }, { name: '龙', emoji: '🐲' }, { name: '蛇', emoji: '🐍' },
  { name: '马', emoji: '🐴' }, { name: '羊', emoji: '🐑' }, { name: '猴', emoji: '🐵' },
  { name: '鸡', emoji: '🐔' }, { name: '狗', emoji: '🐶' }, { name: '猪', emoji: '🐷' }
];

// 与 utils/zodiac.js 完全一致的映射：n % 12 -> 生肖索引；49 跟随当年生肖
const FIXED_BY_MOD12 = [7, 6, 5, 4, 3, 2, 1, 0, 11, 10, 9, 8];
const THIS_YEAR = new Date().getFullYear();
const YEAR_IDX = ((THIS_YEAR - 2020) % 12 + 12) % 12;

const PAYOUT = 47;
const DRAW_MS = 900;
const RESULT_MS = 2900;
const HISTORY_MAX = 100;
const STORE_KEY = 'yb_bet_v1';
const TICK_MS = 100;
const INTERVALS = [
  { sec: 10, label: '10 秒' },
  { sec: 30, label: '30 秒' },
  { sec: 60, label: '1 分钟' },
  { sec: 300, label: '5 分钟' }
];
const MOOD = {
  wait: '/assets/bottom_left.gif',
  win: '/assets/bottom_right.gif',
  lose: '/assets/mascot_right.gif',
  neutral: '/assets/bubu.gif'
};

function zodiacIdxOf(n) {
  return n === 49 ? YEAR_IDX : FIXED_BY_MOD12[n % 12];
}

const MAP = (function () {
  const m = [[], [], [], [], [], [], [], [], [], [], [], []];
  for (let n = 1; n <= 49; n++) m[zodiacIdxOf(n)].push(n);
  return m;
})();

function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function fmt(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function fmtCd(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return String(sec);
  return Math.floor(sec / 60) + ':' + pad2(sec % 60);
}
function intervalLabel(sec) {
  for (let i = 0; i < INTERVALS.length; i++) {
    if (INTERVALS[i].sec === sec) return INTERVALS[i].label;
  }
  return sec + ' 秒';
}
function toast(title) {
  wx.showToast({ title: title, icon: 'none', duration: 1600 });
}

function freshState(chips) {
  return {
    totalIn: chips,
    bankroll: chips,
    round: 0,
    bets: [],
    staging: [],
    interval: 10,
    roundMs: 10000,
    selZ: -1,
    selN: 0,
    phase: 'idle',
    deadline: 0,
    drawAt: 0,
    resultAt: 0,
    pending: null,
    history: [],
    lastBets: [],
    stats: { rounds: 0, betRounds: 0, stake: 0, ret: 0, hits: 0, curMiss: 0, bestMiss: 0 }
  };
}

function isFiniteNum(v) { return typeof v === 'number' && isFinite(v); }
function validN(n) { return typeof n === 'number' && n >= 1 && n <= 49 && n === Math.floor(n); }
// 押注条目：号码合法 + 金额是正的有限数（z 由号码推导，不信任存档里的旧值）
function sanitizeBet(b) {
  if (!b || !validN(b.n) || !isFiniteNum(b.amount) || b.amount < 1) return null;
  return { z: zodiacIdxOf(b.n), n: b.n, amount: Math.floor(b.amount) };
}

function loadState() {
  try {
    const d = wx.getStorageSync(STORE_KEY);
    if (!d || typeof d !== 'object') return null;
    if (!isFiniteNum(d.bankroll) || !isFiniteNum(d.totalIn) || d.bankroll < 0 || d.totalIn < 0) return null;
    const s = freshState(Math.floor(d.totalIn));
    s.bankroll = Math.floor(d.bankroll);
    s.round = isFiniteNum(d.round) ? Math.max(0, Math.floor(d.round)) : 0;
    s.interval = INTERVALS.some((x) => x.sec === d.interval) ? d.interval : 10;
    s.roundMs = s.interval * 1000;
    s.staging = Array.isArray(d.staging) ? d.staging.map(sanitizeBet).filter(Boolean) : [];
    s.history = (Array.isArray(d.history) ? d.history : []).filter((h) =>
      h && validN(h.n) && isFiniteNum(h.stake) && isFiniteNum(h.ret)).slice(0, HISTORY_MAX);
    s.lastBets = (Array.isArray(d.lastBets) ? d.lastBets : []).map(sanitizeBet).filter(Boolean);
    if (d.stats && typeof d.stats === 'object') {
      const st = s.stats;
      ['rounds', 'betRounds', 'stake', 'ret', 'hits', 'curMiss', 'bestMiss'].forEach((k) => {
        if (isFiniteNum(d.stats[k]) && d.stats[k] >= 0) st[k] = Math.floor(d.stats[k]);
      });
      if (typeof d.stats.betRounds !== 'number') st.betRounds = st.hits || 0;
    }
    // 局中状态（下注中/开奖中/展示中）一并恢复：杀进程/被系统回收后接着这一局，
    // 不会出现「扣押的筹码蒸发、这一局从历史里消失」。
    const phase = ['betting', 'drawing', 'result'].indexOf(d.phase) !== -1 ? d.phase : 'idle';
    s.selZ = (d.selZ === -1 || (typeof d.selZ === 'number' && d.selZ >= 0 && d.selZ <= 11)) ? d.selZ : -1;
    s.selN = validN(d.selN) ? d.selN : 0;
    if (phase === 'idle') return s;
    s.phase = phase;
    s.deadline = isFiniteNum(d.deadline) ? d.deadline : 0;
    s.drawAt = isFiniteNum(d.drawAt) ? d.drawAt : 0;
    s.resultAt = isFiniteNum(d.resultAt) ? d.resultAt : 0;
    s.roundMs = isFiniteNum(d.roundMs) && d.roundMs > 0 ? d.roundMs : s.roundMs;
    s.bets = (Array.isArray(d.bets) ? d.bets : []).map(sanitizeBet).filter(Boolean);
    if (d.pending && validN(d.pending.n) && isFiniteNum(d.pending.stake) && d.pending.stake >= 0) {
      s.pending = { n: d.pending.n, z: zodiacIdxOf(d.pending.n), stake: d.pending.stake };
    } else if (phase !== 'betting') {
      // 开奖信息丢了没法结算：把已扣押的本局押注退回筹码，退回空闲
      s.bankroll += s.bets.reduce((a, b) => a + b.amount, 0);
      s.bets = [];
      s.phase = 'idle';
    }
    return s;
  } catch (e) {
    return null;
  }
}

Component({
  properties: {
    // 由首页传入：只有当前栏目可见时才走计时，切走就暂停（deadline 顺延）
    active: {
      type: Boolean,
      value: false,
      observer(v) {
        if (!this._loaded) return;
        if (v) this._activate(); else this._deactivate();
      }
    }
  },

  data: {
    // 钱包
    totalInText: '0',
    bankrollText: '0',
    netText: '0',
    netClass: '',
    // 回合
    round: 0,
    cdText: '10',
    cdUrgent: false,
    phaseLabel: '等待开始',
    barPct: 100,
    barClosed: false,
    ballText: '--',
    ballClass: 'idle',
    speech: '选个号码，押一点点就好～',
    mood: MOOD.wait,
    resultText: '',
    resultClass: '',
    // 间隔
    intervals: INTERVALS,
    interval: 10,
    // 选号
    zlist: [],
    nums: [],
    amtText: '',
    quick: [10, 50, 100, 500],
    // 备码区
    staging: [],
    stagingTotalText: '0',
    stageHint: '选好号码和金额，先放这里',
    // 本局押注
    bets: [],
    betsTotalText: '0',
    betsMaxWinText: '0',
    betsAvailText: '可用 —',
    // 记录 / 账本
    history: [],
    stRounds: '0',
    stStake: '0',
    stRet: '0',
    stRtp: '—',
    stRtpClass: '',
    stHits: '0',
    stHitText: '理论 2.04%',
    stMiss: '0',
    stMissNow: '当前 0 局',
    bars: [],
    mathOpen: false,
    // 弹窗
    showStart: false,
    startPick: 5000,
    startCustom: '',
    showTopup: false,
    topupPick: 2000,
    topupCustom: '',
    showRuin: false,
    ruin: { rounds: '0', inText: '0', stakeText: '0', rtp: '—', hits: '0', lossText: '0' },
    ruinNote: ''
  },

  lifetimes: {
    attached() {
      this._loaded = true;
      this._s = loadState();
      this._amtRaw = '';
      // 没有存档（第一次进来）就先亮开局弹窗，和网页版一致
      if (!this._s) this.setData({ showStart: true });
      this._sync();
      if (this.data.active) this._activate();
    },
    detached() {
      this._stopClock();
      this._loaded = false;
    }
  },

  pageLifetimes: {
    show() {
      if (this._loaded && this.data.active) this._startClock();
    },
    hide() {
      this._stopClock();
    }
  },

  methods: {
    /* ================= 计时 ================= */
    _activate() {
      const s = this._s;
      if (!s) {
        this.setData({ showStart: true });
        return;
      }
      this.setData({ showStart: false });
      this._sync();
      if (s.phase === 'idle') {
        // 筹码见底（含强杀后重进、存档里 bankroll=0）：直接进破产结算，
        // 不能用 0 筹码开一局空转
        if (s.bankroll <= 0) {
          this._showRuin();
          return;
        }
        this._startRound();
      } else if (s.phase === 'result') {
        // 结果页的文案没有存档，恢复时直接走「结算后」：进下一局或破产
        this._afterResult();
      } else {
        // betting / drawing：接着这一局继续（deadline 是绝对时间，顺延由
        // _startClock 里的暂停补偿负责）
        this._restoreRoundView();
      }
      this._startClock();
    },

    // 恢复局中视图：phaseLabel / 倒计时 / 开奖球都按存档时的阶段重建
    _restoreRoundView() {
      const s = this._s;
      const now = Date.now();
      if (s.phase === 'betting') {
        const left = Math.max(0, s.deadline - now);
        const sec = Math.ceil(left / 1000);
        this.setData({
          phaseLabel: '下注中', barClosed: false, cdUrgent: sec <= 3,
          cdText: fmtCd(sec),
          barPct: Math.max(0, Math.min(100, left / (s.roundMs || 10000) * 100)),
          ballText: '--', ballClass: 'idle', resultText: '', resultClass: ''
        });
      } else if (s.phase === 'drawing') {
        this.setData({
          phaseLabel: '封盘开奖', cdText: '0', cdUrgent: false,
          barClosed: true, barPct: 100, ballClass: 'rolling', ballText: '??',
          resultText: '', resultClass: ''
        });
      }
      this._sync();
    },

    _deactivate() {
      this._stopClock();
    },

    _startClock() {
      if (this._ticker) return;
      if (!this._s) return;
      // 暂停期间（切栏目 / 小程序进后台）的时长要顺延，否则回来会一次结算好几局
      if (this._pausedAt) {
        const d = Date.now() - this._pausedAt;
        if (this._s.deadline) this._s.deadline += d;
        if (this._s.drawAt) this._s.drawAt += d;
        if (this._s.resultAt) this._s.resultAt += d;
        this._pausedAt = 0;
      }
      this._lastSec = -1;
      this._ticker = setInterval(() => this._tick(), TICK_MS);
      this._tick();
    },

    _stopClock() {
      if (this._ticker) {
        clearInterval(this._ticker);
        this._ticker = null;
        this._pausedAt = Date.now();
      }
    },

    _tick() {
      const s = this._s;
      if (!s) return;
      const now = Date.now();
      if (s.phase === 'betting') {
        const left = s.deadline - now;
        if (left <= 0) { this._lock(); return; }
        const sec = Math.ceil(left / 1000);
        if (sec !== this._lastSec) {
          this._lastSec = sec;
          this.setData({
            cdText: fmtCd(sec),
            cdUrgent: sec <= 3,
            barPct: Math.max(0, Math.min(100, left / (s.roundMs || 10000) * 100))
          });
        }
      } else if (s.phase === 'drawing') {
        if (s.drawAt - now <= 0) this._settle();
      } else if (s.phase === 'result') {
        if (s.resultAt - now <= 0) this._afterResult();
      }
    },

    /* ================= 回合 ================= */
    _startRound() {
      const s = this._s;
      // 新开的局从「现在」起算：清掉上一段停留（切栏目/重置弹窗）的暂停时间戳，
      // 否则 _startClock 会把这段停留加到新一局的 deadline 上
      this._pausedAt = 0;
      s.phase = 'betting';
      s.round += 1;
      s.bets = [];
      s.pending = null;
      s.roundMs = s.interval * 1000;
      s.deadline = Date.now() + s.roundMs;
      this.setData({
        ballText: '--', ballClass: 'idle', resultText: '', resultClass: '',
        phaseLabel: '下注中', barClosed: false, cdUrgent: false,
        cdText: fmtCd(s.interval), barPct: 100,
        speech: '选个号码，押一点点就好～', mood: MOOD.wait
      });
      this._sync();
      this._save();
    },

    _lock() {
      const s = this._s;
      let stake = 0;
      s.bets.forEach((b) => { stake += b.amount; });
      if (stake > s.bankroll) { stake = 0; s.bets = []; }

      s.bankroll -= stake;
      const n = Math.floor(Math.random() * 49) + 1;
      s.pending = { n: n, z: zodiacIdxOf(n), stake: stake };
      s.phase = 'drawing';
      s.drawAt = Date.now() + DRAW_MS;

      this.setData({
        phaseLabel: '封盘开奖', cdText: '0', cdUrgent: false, barClosed: true, barPct: 100,
        ballClass: 'rolling', ballText: '??', resultText: '',
        speech: '转啊转～转啊转～'
      });
      this._sync();
      // 扣款 + 待开奖状态立刻落盘：杀进程后这一局也要结算，不能凭空消失
      this._save();
    },

    _settle() {
      const s = this._s;
      const p = s.pending;
      if (!p) return;
      const stake = p.stake;
      let ret = 0;
      s.bets.forEach((b) => { if (b.n === p.n) ret += b.amount * PAYOUT; });
      const hit = ret > 0;

      s.bankroll += ret;

      const st = s.stats;
      st.rounds += 1;
      st.stake += stake;
      st.ret += ret;
      // 只有真的下了注才谈得上中/不中；空局不刷新连不中
      if (stake > 0) {
        st.betRounds += 1;
        if (hit) { st.hits += 1; st.curMiss = 0; }
        else { st.curMiss += 1; if (st.curMiss > st.bestMiss) st.bestMiss = st.curMiss; }
      }

      s.history.unshift({
        r: s.round, n: p.n, z: p.z, stake: stake, ret: ret, hit: hit,
        bk: s.bankroll, dep: s.totalIn
      });
      if (s.history.length > HISTORY_MAX) s.history.length = HISTORY_MAX;
      s.lastBets = s.bets.map((b) => ({ z: b.z, n: b.n, amount: b.amount }));

      const z = ZODIAC[p.z];
      let resultText;
      let mood;
      if (hit) {
        const d = ret - stake;
        resultText = '开出 ' + pad2(p.n) + '（' + z.name + '组）· 中了！返还 ' + fmt(ret);
        if (d > 0) { mood = MOOD.win; toast('中奖 +' + fmt(d)); }
        else { mood = MOOD.win; toast('中了，可还是少了 ' + fmt(-d)); }
        try { wx.vibrateShort({ type: 'light' }); } catch (e) {}
      } else {
        resultText = '开出 ' + pad2(p.n) + '（' + z.name + '组）· 没中';
        mood = stake > 0 ? MOOD.lose : MOOD.neutral;
      }

      s.phase = 'result';
      s.resultAt = Date.now() + RESULT_MS;
      s.pending = null;

      this.setData({
        ballClass: hit ? 'win' : '',
        ballText: pad2(p.n),
        resultText: resultText,
        resultClass: hit ? 'win' : 'lose',
        speech: hit ? '哇，中啦！不过别上头哦～'
                    : (stake > 0 ? '没中没中～ 喝口水，别急着追。' : '这一局你没押，看看就好～'),
        mood: mood
      });
      this._sync();
      this._save();
    },

    _afterResult() {
      if (this._s.bankroll <= 0) {
        this._showRuin();
        this._s.phase = 'idle';
        return;
      }
      this._startRound();
    },

    /* ================= 同步视图 ================= */
    _sync() {
      const s = this._s;
      if (!s) return;
      const st = s.stats;
      const net = s.bankroll - s.totalIn;

      // 生肖
      const zlist = ZODIAC.map((z, i) => ({
        i: i, name: z.name, emoji: z.emoji, cnt: MAP[i].length, on: s.selZ === i
      }));

      // 号码（已押 / 已备码的都打勾）
      const picked = {};
      s.bets.forEach((b) => { picked[b.n] = true; });
      s.staging.forEach((b) => { picked[b.n] = true; });
      const nums = s.selZ < 0 ? [] : MAP[s.selZ].map((n) => ({
        n: n, nText: pad2(n), on: s.selN === n, picked: !!picked[n]
      }));

      // 备码区
      let stageTotal = 0;
      const staging = s.staging.map((it) => {
        stageTotal += it.amount;
        const z = ZODIAC[it.z] || ZODIAC[0];
        return {
          key: it.n, n: it.n, nText: pad2(it.n),
          zName: z.name, emoji: z.emoji,
          amount: it.amount, amountText: fmt(it.amount),
          backText: fmt(it.amount * PAYOUT)
        };
      });

      // 本局押注
      let betsTotal = 0;
      let maxWin = 0;
      const bets = s.bets.map((b) => {
        betsTotal += b.amount;
        if (b.amount * PAYOUT > maxWin) maxWin = b.amount * PAYOUT;
        const z = ZODIAC[b.z] || ZODIAC[0];
        return {
          key: b.n, n: b.n, nText: pad2(b.n),
          zName: z.name, emoji: z.emoji,
          amount: b.amount, amountText: fmt(b.amount),
          backText: fmt(b.amount * PAYOUT)
        };
      });

      // 记录
      const history = s.history.slice(0, HISTORY_MAX).map((h) => {
        const z = ZODIAC[h.z] || ZODIAC[0];
        const d = h.ret - h.stake;
        const good = h.stake > 0 && d > 0;
        return {
          key: h.r, r: h.r, nText: pad2(h.n), zName: z.name, emoji: z.emoji,
          stakeText: h.stake ? '押 ' + fmt(h.stake) : '本局没押',
          resText: h.stake === 0 ? '没押' : (d > 0 ? '+' + fmt(d) : (d < 0 ? '-' + fmt(-d) : '±0')),
          resClass: good ? 'win' : 'lose',
          rowClass: good ? 'win' : ''
        };
      });

      // 小柱状图：最近 20 局的净盈亏
      const recent = s.history.slice(0, 20).reverse();
      let maxAbs = 1;
      recent.forEach((h) => {
        const v = Math.abs(h.ret - h.stake);
        if (v > maxAbs) maxAbs = v;
      });
      const bars = recent.map((h) => {
        const v = h.ret - h.stake;
        return {
          h: Math.max(5, Math.round(Math.abs(v) / maxAbs * 64)),
          color: v > 0 ? '#3FBF8F' : (v < 0 ? '#FF8FAB' : '#E7DAD2')
        };
      });

      const rtp = st.stake > 0 ? st.ret / st.stake * 100 : null;

      this.setData({
        totalInText: fmt(s.totalIn),
        bankrollText: fmt(s.bankroll),
        netText: (net > 0 ? '+' : '') + fmt(net),
        netClass: net > 0 ? 'green' : (net < 0 ? 'red' : ''),
        round: s.round,
        interval: s.interval,
        zlist: zlist,
        nums: nums,
        staging: staging,
        stagingTotalText: fmt(stageTotal),
        stageHint: stageTotal === 0 ? '选好号码和金额，先放这里'
          : (s.bankroll - betsTotal >= stageTotal ? '点「一起下注」押进本局' : '筹码不够，先减一点'),
        bets: bets,
        betsTotalText: fmt(betsTotal),
        betsMaxWinText: fmt(maxWin),
        // 封盘后本局押注已经从余额里扣掉了，不能再减一次 betsTotal（会显示成负数）
        betsAvailText: '可用 ' + fmt(s.phase === 'betting' ? s.bankroll - betsTotal : s.bankroll)
          + (s.phase === 'betting' ? '' : ' · 已封盘'),
        history: history,
        stRounds: fmt(st.rounds),
        stStake: fmt(st.stake),
        stRet: fmt(st.ret),
        stRtp: rtp === null ? '—' : rtp.toFixed(1) + '%',
        stRtpClass: rtp === null ? '' : (rtp >= 95.92 ? 'green' : 'red'),
        stHits: fmt(st.hits),
        stHitText: st.betRounds
          ? '实际 ' + (st.hits / st.betRounds * 100).toFixed(2) + '% · 理论 2.04%'
          : '理论 2.04%',
        stMiss: fmt(st.bestMiss),
        stMissNow: '当前 ' + st.curMiss + ' 局',
        bars: bars
      });
    },

    _save() {
      const s = this._s;
      if (!s) return;
      try {
        wx.setStorageSync(STORE_KEY, {
          totalIn: s.totalIn, bankroll: s.bankroll, round: s.round,
          interval: s.interval, staging: s.staging,
          history: s.history.slice(0, HISTORY_MAX), lastBets: s.lastBets, stats: s.stats,
          // 局中状态一并落盘：封盘扣款后强杀/被回收，重进还能把这一局结算完
          phase: s.phase, deadline: s.deadline, drawAt: s.drawAt, resultAt: s.resultAt,
          roundMs: s.roundMs, pending: s.pending, bets: s.bets, selZ: s.selZ, selN: s.selN
        });
      } catch (e) {}
    },

    /* ================= 交互 ================= */
    onPickInterval(e) {
      const sec = Number(e.currentTarget.dataset.sec);
      if (!this._s || this._s.interval === sec) return;
      this._s.interval = sec;
      this.setData({ interval: sec });
      this._save();
      toast('开奖间隔：' + intervalLabel(sec) + '（下局生效）');
    },

    onPickZodiac(e) {
      if (!this._s) return;
      const i = Number(e.currentTarget.dataset.i);
      this._s.selZ = this._s.selZ === i ? -1 : i;
      this._s.selN = 0;
      this._sync();
    },

    onPickNumber(e) {
      if (!this._s) return;
      const n = Number(e.currentTarget.dataset.n);
      this._s.selN = this._s.selN === n ? 0 : n;
      this._sync();
    },

    onAmtInput(e) {
      this._amtRaw = e.detail.value;
      this.setData({ amtText: e.detail.value });
    },

    onQuick(e) {
      const q = Number(e.currentTarget.dataset.q);
      this._amtRaw = String(q);
      this.setData({ amtText: String(q) });
    },

    onStageAdd() {
      const s = this._s;
      if (!s) return;
      if (s.selZ < 0 || !s.selN) { toast('先选生肖，再挑号码'); return; }
      const amt = parseInt(this._amtRaw, 10);
      if (!amt || amt < 1) { toast('先填个押注金额'); return; }

      let exist = null;
      for (let i = 0; i < s.staging.length; i++) {
        if (s.staging[i].n === s.selN) { exist = s.staging[i]; break; }
      }
      if (exist) exist.amount += amt;
      // 分组直接由号码推导，保证「蛇组 12」这种错配不可能出现
      else s.staging.push({ z: zodiacIdxOf(s.selN), n: s.selN, amount: amt });

      this._sync();
      this._save();
      toast('已放入备码区：' + pad2(s.selN) + ' · ' + fmt(amt));
    },

    onStageDel(e) {
      const s = this._s;
      if (!s) return;
      const i = Number(e.currentTarget.dataset.i);
      s.staging.splice(i, 1);
      this._sync();
      this._save();
    },

    onStageClear() {
      const s = this._s;
      if (!s || !s.staging.length) return;
      s.staging = [];
      this._sync();
      this._save();
    },

    onSubmitStage() {
      const s = this._s;
      if (!s) return;
      if (!s.staging.length) { toast('备码区还是空的'); return; }
      if (s.phase !== 'betting') { toast('本局已封盘，等下一局再一起下注'); return; }

      let total = 0;
      let used = 0;
      s.staging.forEach((it) => { total += it.amount; });
      s.bets.forEach((b) => { used += b.amount; });
      if (used + total > s.bankroll) {
        toast('筹码不够：可用 ' + fmt(s.bankroll - used));
        return;
      }

      let count = 0;
      s.staging.forEach((it) => {
        let ex = null;
        for (let i = 0; i < s.bets.length; i++) {
          if (s.bets[i].n === it.n) { ex = s.bets[i]; break; }
        }
        if (ex) ex.amount += it.amount;
        else s.bets.push({ z: it.z, n: it.n, amount: it.amount });
        count++;
      });
      s.staging = [];

      this._sync();
      this._save();
      toast('已下注 ' + count + ' 注 · 共 ' + fmt(total));
    },

    onBetsDel(e) {
      const s = this._s;
      if (!s) return;
      if (s.phase !== 'betting') { toast('本局已经封盘啦'); return; }
      const i = Number(e.currentTarget.dataset.i);
      s.bets.splice(i, 1);
      this._sync();
      this._save();
    },

    onClearBets() {
      const s = this._s;
      if (!s) return;
      if (s.phase !== 'betting') { toast('本局已经封盘啦'); return; }
      s.bets = [];
      this._sync();
      this._save();
    },

    onRepeatLast() {
      const s = this._s;
      if (!s) return;
      if (s.phase !== 'betting') { toast('本局已经封盘啦'); return; }
      if (!s.lastBets.length) { toast('上一局没有押注'); return; }
      let used = 0;
      s.bets.forEach((b) => { used += b.amount; });
      let added = 0;
      s.lastBets.forEach((lb) => {
        // 存档损坏/旧版本残留的脏条目直接跳过，别把 undefined 押进本局
        if (!lb || !isFiniteNum(lb.amount) || lb.amount < 1 || !validN(lb.n)) return;
        if (used + lb.amount > s.bankroll) return;
        let ex = null;
        for (let i = 0; i < s.bets.length; i++) {
          if (s.bets[i].n === lb.n) { ex = s.bets[i]; break; }
        }
        if (ex) ex.amount += lb.amount;
        else s.bets.push({ z: lb.z, n: lb.n, amount: lb.amount });
        used += lb.amount;
        added++;
      });
      if (!added) toast('筹码不够，没法重复');
      this._sync();
      this._save();
    },

    onToggleMath() {
      this.setData({ mathOpen: !this.data.mathOpen });
    },

    /* ================= 开局 / 补充 / 破产 ================= */
    onStartPick(e) {
      this.setData({ startPick: Number(e.currentTarget.dataset.c), startCustom: '' });
    },

    onStartCustom(e) {
      this.setData({ startCustom: e.detail.value });
    },

    onStartGame() {
      const custom = parseInt(this.data.startCustom, 10);
      const chips = custom > 0 ? custom : this.data.startPick;
      if (!chips || chips < 1) { toast('筹码至少 1 哦'); return; }
      this._s = freshState(chips);
      this.setData({ showStart: false });
      this._sync();
      this._activate();
    },

    onTopupOpen() {
      if (!this._s) return;
      this.setData({ showTopup: true, topupCustom: '', topupPick: 2000 });
    },

    onTopupClose() {
      // 破产弹窗 → 「算了，不补了」：回到破产弹窗，不能停在既不开局也不破产的死状态
      if (this._s && this._s.bankroll <= 0 && this._s.phase === 'idle') {
        this._showRuin();
        return;
      }
      this.setData({ showTopup: false });
    },

    onTopupPick(e) {
      this.setData({ topupPick: Number(e.currentTarget.dataset.c), topupCustom: '' });
    },

    onTopupCustom(e) {
      this.setData({ topupCustom: e.detail.value });
    },

    onTopupOk() {
      const s = this._s;
      if (!s) return;
      const custom = parseInt(this.data.topupCustom, 10);
      const v = custom > 0 ? custom : this.data.topupPick;
      if (!v || v < 1) { toast('至少补 1 吧'); return; }
      s.bankroll += v;
      s.totalIn += v;
      this.setData({ showTopup: false });
      this._sync();
      this._save();
      toast('已补 ' + fmt(v) + ' · 累计投入 ' + fmt(s.totalIn));
      if (s.phase === 'idle') this._activate();
    },

    onReset() {
      wx.showModal({
        title: '确定重置吗？',
        content: '当前筹码和记录会全部清空。',
        confirmText: '重置',
        confirmColor: '#FF5A5F',
        success: (r) => {
          if (!r.confirm) return;
          try { wx.removeStorageSync(STORE_KEY); } catch (e) {}
          this._stopClock();
          this._s = null;
          this.setData({
            showRuin: false, showTopup: false, showStart: true,
            round: 0, zlist: [], nums: [], staging: [], bets: [], history: [], bars: [],
            totalInText: '0', bankrollText: '0', netText: '0', netClass: '',
            ballText: '--', ballClass: 'idle', resultText: '', phaseLabel: '等待开始'
          });
        }
      });
    },

    _showRuin() {
      const s = this._s;
      const st = s.stats;
      this.setData({
        showRuin: true,
        showTopup: false,
        ruin: {
          rounds: fmt(st.rounds),
          inText: fmt(s.totalIn),
          stakeText: fmt(st.stake),
          rtp: st.stake ? (st.ret / st.stake * 100).toFixed(1) + '%' : '—',
          hits: fmt(st.hits),
          lossText: fmt(s.totalIn - s.bankroll)
        },
        ruinNote: '你一共投进去 ' + fmt(s.totalIn) + '，玩了 ' + st.rounds + ' 局，现在剩 ' +
          fmt(s.bankroll) + '。这个游戏返还率 95.92%，每一局都在往庄家口袋里放 4.08%。' +
          '不是你运气差——是这个算式只有一个终点。'
      });
    },

    onRuinReset() {
      try { wx.removeStorageSync(STORE_KEY); } catch (e) {}
      this._stopClock();
      this._s = null;
      this.setData({ showRuin: false, showStart: true, round: 0, history: [], bars: [] });
    },

    onRuinTopup() {
      this.setData({ showRuin: false, showTopup: true, topupCustom: '', topupPick: 2000 });
    }
  }
});
