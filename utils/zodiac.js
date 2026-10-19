// 十二生肖顺序（以 鼠 为索引 0）
// 年份对应规则：2020 年为 鼠年，按 12 年一轮循环
const ZODIAC = [
  { name: '鼠', emoji: '🐭', color: '#7C7C85' },
  { name: '牛', emoji: '🐮', color: '#A0744F' },
  { name: '虎', emoji: '🐯', color: '#FF9F0A' },
  { name: '兔', emoji: '🐰', color: '#FF7AB6' },
  { name: '龙', emoji: '🐲', color: '#FF3B30' },
  { name: '蛇', emoji: '🐍', color: '#34C759' },
  { name: '马', emoji: '🐴', color: '#FF9500' },
  { name: '羊', emoji: '🐑', color: '#AF7BE0' },
  { name: '猴', emoji: '🐵', color: '#C9A227' },
  { name: '鸡', emoji: '🐔', color: '#E8A33D' },
  { name: '狗', emoji: '🐶', color: '#9B7653' },
  { name: '猪', emoji: '🐷', color: '#FF6FB5' }
];

// 当年农历生肖在 ZODIAC 中的索引（2020 = 鼠 = 0）
function getYearAnimalIndex(year) {
  return ((year - 2020) % 12 + 12) % 12;
}

// 号码 1-48 固定映射（与年份无关）：n mod 12 -> 生肖索引
// 1→马 2→蛇 3→龙 4→兔 5→虎 6→牛 7→鼠 8→猪 9→狗 10→鸡 11→猴 0(12)→羊
const FIXED_BY_MOD12 = [7, 6, 5, 4, 3, 2, 1, 0, 11, 10, 9, 8];

// 号码 49 跟随当年生肖（例如鸡年 49→鸡，马年 49→马）
function getZodiacByNumber(year, n) {
  let idx;
  if (n === 49) {
    idx = getYearAnimalIndex(year);
  } else {
    idx = FIXED_BY_MOD12[((n % 12) + 12) % 12];
  }
  return ZODIAC[idx];
}

// 生成当年完整的 生肖 -> 号码数组 映射（按年份缓存，同一年只算一次）
const _mappingCache = {};
function buildMapping(year) {
  if (_mappingCache[year]) return _mappingCache[year];
  const map = {};
  for (let n = 1; n <= 49; n++) {
    const name = getZodiacByNumber(year, n).name;
    if (!map[name]) map[name] = [];
    map[name].push(n);
  }
  _mappingCache[year] = map;
  return map;
}

// 随机抽一次：号码 1-49 均匀随机，生肖由号码推导（完全随机、无预测）
function randomDraw(year) {
  const n = Math.floor(Math.random() * 49) + 1;
  const z = getZodiacByNumber(year, n);
  return { number: n, name: z.name, emoji: z.emoji, color: z.color };
}

module.exports = {
  ZODIAC,
  getYearAnimalIndex,
  getZodiacByNumber,
  buildMapping,
  randomDraw
};
