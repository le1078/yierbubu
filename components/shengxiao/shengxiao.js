// 小笨生肖 · 十二生肖相冲相配
// 迁移自内部测试页（纯前端逻辑，无网络依赖）
// 以自定义组件形式放在主包，供首页「小笨生肖」栏目同页切换展示。
//
// 素材说明（源站 img/yierbubu_nobg_XXXX.gif）：
//   assets/shengxiao/ 下为新增的 11 张；另 3 张与主包已有素材字节完全相同，直接复用：
//   0006 → /assets/bottom_left.gif   0042 → /assets/mascot_right.gif   0065 → /assets/bottom_right.gif
const IMG = (code) => '/assets/shengxiao/yierbubu_nobg_' + code + '.gif';

// 十二生肖：名称 / emoji / 地支 / 五行
const Z = [
  { n: '鼠', e: '🐭', z: '子', wx: '水' },
  { n: '牛', e: '🐮', z: '丑', wx: '土' },
  { n: '虎', e: '🐯', z: '寅', wx: '木' },
  { n: '兔', e: '🐰', z: '卯', wx: '木' },
  { n: '龙', e: '🐲', z: '辰', wx: '土' },
  { n: '蛇', e: '🐍', z: '巳', wx: '火' },
  { n: '马', e: '🐴', z: '午', wx: '火' },
  { n: '羊', e: '🐑', z: '未', wx: '土' },
  { n: '猴', e: '🐵', z: '申', wx: '金' },
  { n: '鸡', e: '🐔', z: '酉', wx: '金' },
  { n: '狗', e: '🐶', z: '戌', wx: '土' },
  { n: '猪', e: '🐷', z: '亥', wx: '水' }
];

// 六冲
const CHONG = { 0: 6, 6: 0, 1: 7, 7: 1, 2: 8, 8: 2, 3: 9, 9: 3, 4: 10, 10: 4, 5: 11, 11: 5 };
// 六合
const LIUHE = { 0: 1, 1: 0, 2: 11, 11: 2, 3: 10, 10: 3, 4: 9, 9: 4, 5: 8, 8: 5, 6: 7, 7: 6 };
// 三合
const SANHE = [[11, 3, 7], [2, 6, 10], [5, 9, 1], [8, 0, 4]];
// 六害
const HAI = { 0: 7, 7: 0, 1: 6, 6: 1, 2: 5, 5: 2, 3: 4, 4: 3, 8: 11, 11: 8, 9: 10, 10: 9 };
// 相刑
const XING = [[2, 5, 8], [1, 7, 10], [0, 3]];
// 自刑
const ZIXING = [4, 6, 9, 11];
// 相破
const PO = { 0: 9, 9: 0, 1: 4, 4: 1, 2: 11, 11: 2, 3: 6, 6: 3, 5: 8, 8: 5, 7: 10, 10: 7 };

const CHONG_DESC = {
  '0-6': '子午冲：水克火，情绪与理智的冲突，易有变动、奔波。',
  '1-7': '丑未冲：土土相冲，观念与习惯的碰撞，易有财务、人际摩擦。',
  '2-8': '寅申冲：金克木，行动与思想的矛盾，易有出行、工作变动。',
  '3-9': '卯酉冲：金克木，人际与感情的冲突，易有口舌、是非。',
  '4-10': '辰戌冲：土土相冲，事业与家庭的矛盾，易有压力、争执。',
  '5-11': '巳亥冲：水克火，内心与外在的拉扯，易有健康、情绪问题。'
};
const HAI_DESC = {
  '0-7': '子未害：名利之害，易有财务纠纷。',
  '1-6': '丑午害：官非之害，易有职场冲突。',
  '2-5': '寅巳害：口舌之害，易有意见不合。',
  '3-4': '卯辰害：感情之害，易有沟通障碍。',
  '8-11': '申亥害：竞争之害，易有利益争夺。',
  '9-10': '酉戌害：邻里之害，易有是非纷争。'
};

// 结果面板贴纸池：每次点生肖随机换一张（与上一张不重复）
const STICKERS = ['0003', '0004', '0063', '0070', '0071', '0072', '0074', '0077', '0085'].map(IMG)
  .concat(['/assets/bottom_left.gif', '/assets/bottom_right.gif']);

const pairKey = (a, b) => [Math.min(a, b), Math.max(a, b)].join('-');
const fmt = (i) => Z[i].e + ' ' + Z[i].n;

// 12 个生肖按钮是静态数据，提为模块级常量：
// 原来每次 attached 都重新 map 一遍并 setData，切 tab 重建组件就多一次无谓渲染
const ZODIAC_BUTTONS = Z.map((z, i) => ({ i, n: z.n, e: z.e, cls: '' }));

Component({
  data: {
    zodiacs: ZODIAC_BUTTONS,
    rows: [],
    hasResult: false,
    sticker: '/assets/shengxiao/yierbubu_nobg_0004.gif',
    pickedEmoji: '',
    pickedName: '',
    pickedZhi: '',
    pickedWx: '',
    tipImg: '/assets/mascot_right.gif',
    emptyImg: '/assets/shengxiao/yierbubu_nobg_0018.gif',
    footImg: '/assets/shengxiao/yierbubu_nobg_0011.gif'
  },

  lifetimes: {
    attached() {
      this._lastSticker = -1;
    }
  },

  methods: {
    onPick(e) {
      const i = Number(e.currentTarget.dataset.i);
      if (isNaN(i) || i < 0 || i > 11) return;

      // 相配集合：六合 + 三合（去掉与自身相冲的）
      const heSet = new Set([LIUHE[i]]);
      SANHE.forEach((g) => {
        if (g.indexOf(i) >= 0) g.forEach((x) => { if (x !== i) heSet.add(x); });
      });
      const chong = CHONG[i];
      heSet.delete(chong);

      // 刑 · 害 · 破集合
      const badSet = new Set([HAI[i], PO[i]]);
      XING.forEach((g) => {
        if (g.indexOf(i) >= 0) g.forEach((x) => { if (x !== i) badSet.add(x); });
      });
      badSet.delete(chong);
      heSet.forEach((x) => badSet.delete(x));

      // 生肖按钮着色：选中 > 相冲 > 相配 > 刑害破（三个集合互斥，无覆盖冲突）
      const zodiacs = Z.map((z, idx) => ({ i: idx, n: z.n, e: z.e, cls: '' }));
      zodiacs[i].cls = 'sel';
      zodiacs[chong].cls = 'r-chong';
      heSet.forEach((x) => { zodiacs[x].cls = 'r-he'; });
      badSet.forEach((x) => { zodiacs[x].cls = 'r-bad'; });

      const z = Z[i];
      // 与原网页结果面板结构一一对应：标签 + 加粗值 + 说明（三个同级 flex 项，说明自然换行占满整行）
      const rows = [];
      rows.push({
        label: '相冲 · 六冲',
        cls: 'rl-chong',
        value: fmt(chong),
        desc: CHONG_DESC[pairKey(i, chong)]
      });
      rows.push({
        label: '相配 · 六合',
        cls: 'rl-he',
        value: fmt(LIUHE[i]),
        desc: '六合暗合，互为贵人，天生一对好拍档～'
      });

      const sanheVals = [];
      heSet.forEach((x) => { if (x !== LIUHE[i]) sanheVals.push(fmt(x)); });
      if (sanheVals.length) {
        rows.push({
          label: '相配 · 三合',
          cls: 'rl-he',
          value: sanheVals.join('、'),
          desc: '三合明合，志同道合，一起做事特别顺。'
        });
      }

      if (badSet.size) {
        const parts = [];
        badSet.forEach((x) => {
          if (HAI[i] === x) parts.push(fmt(x) + '（相害：' + (HAI_DESC[pairKey(i, x)] || '暗中损耗') + '）');
          else if (PO[i] === x) parts.push(fmt(x) + '（相破：易有波折损耗）');
          else parts.push(fmt(x) + '（相刑：易生是非纠纷）');
        });
        rows.push({ label: '刑 · 害 · 破', cls: 'rl-bad', value: '', desc: parts.join('；') });
      }

      if (ZIXING.indexOf(i) >= 0) {
        rows.push({
          label: '自刑',
          cls: 'rl-bad',
          value: '',
          desc: z.n + ' 带自刑，容易想太多、内耗自己，记得放过自己鸭。'
        });
      }

      // 随机换贴纸，避免与上一张相同。
      // 池长度 <=1 时没有「不重复」可选，直接取第一张，否则 do...while 会死循环
      let s = 0;
      if (STICKERS.length > 1) {
        do { s = Math.floor(Math.random() * STICKERS.length); } while (s === this._lastSticker);
      }
      this._lastSticker = s;

      this.setData({
        zodiacs,
        rows,
        hasResult: true,
        sticker: STICKERS[s],
        pickedEmoji: z.e,
        pickedName: z.n,
        pickedZhi: z.z,
        pickedWx: z.wx
      });
    }
  }
});
