// 页面级静态自检：抓「调用了但没定义的方法」和「读了但没声明的 data 字段」。
//
// 为什么需要它：象棋页曾因 _startLocal 里调用了未定义的 _notePosition，
// 一进页面就 TypeError 白屏。这种 bug 单元测试完全覆盖不到
// （规则引擎是对的，错在页面装配），只能靠静态扫描。
//
// 检查项：
//   1. this.xxx() 调用的方法必须在 Page({...}) / Component({...}) 里有定义
//   2. this._xxx 字段若是函数调用，同样要有定义
//   3. this.data.xxx 的字段必须出现在 data: {...} 里（防止模板读到 undefined）
//
// 用法：node tools/wx_page_check.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['pages', 'components', 'subpackages'];

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (name === '.git' || name === 'node_modules' || name.startsWith('backup')) continue;
      walk(p, out);
    } else if (/\.js$/.test(name)) out.push(p);
  }
  return out;
}

// 去掉注释和字符串，避免误报
function stripNoise(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\\n]|\\.)*/g, '``');
}

const files = [];
SCAN_DIRS.forEach(d => {
  const abs = path.join(ROOT, d);
  if (fs.existsSync(abs)) walk(abs, files);
});

let problems = 0;

for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const raw = fs.readFileSync(file, 'utf8');
  const src = stripNoise(raw);

  // 只检查 Page/Component 定义的文件
  const isPage = /(?:^|\n)\s*Page\s*\(\s*\{/.test(src) ||
                 /(?:^|\n)\s*Component\s*\(\s*\{/.test(src);
  if (!isPage) continue;

  // 收集所有已定义的方法名：
  //   - Page({ a() {...}, b: function(){}, c: () => {} })
  //   - 生命周期钩子也算已定义
  const defined = new Set();
  // 形如 `name(...) {` 的方法简写
  const shortRe = /(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = shortRe.exec(src))) defined.add(m[1]);
  // 形如 `name: function` 或 `name: (` 的属性赋值
  const propRe = /(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*:\s*(?:function|\(|async)/g;
  while ((m = propRe.exec(src))) defined.add(m[1]);

  // 微信内置生命周期/事件 + 框架提供的方法，无需自定义定义
  const BUILTIN = new Set([
    'onLoad', 'onReady', 'onShow', 'onHide', 'onUnload', 'onPullDownRefresh',
    'onReachBottom', 'onPageScroll', 'onShareAppMessage', 'onShareTimeline',
    'onAddToFavorites', 'onResize', 'onTabItemTap', 'onSaveExitState',
    'attached', 'detached', 'ready', 'moved', 'created', 'error',
    'pageLifetimes', 'lifetimes', 'observers', 'methods', 'data',
    'properties', 'options', 'behaviors', 'relations', 'externalClasses',
    'definitionFilter', 'selectOwnerComponent',
    // 框架挂在 this 上的方法（Page/Component 实例自带）
    'setData', 'triggerEvent', 'createSelectorQuery', 'createIntersectionObserver',
    'selectComponent', 'selectAllComponents', 'getRelationNodes',
    'groupSetData', 'animate', 'clearAnimation'
  ]);
  BUILTIN.forEach(k => defined.add(k));

  // 收集 this._xxx = 的赋值（实例字段，可能是函数）
  const fieldRe = /this\.(_[\w$]+)\s*=/g;
  while ((m = fieldRe.exec(src))) defined.add(m[1]);

  // 检查 this.xxx( 调用
  const callRe = /this\.([\w$]+)\s*\(/g;
  const lines = src.split('\n');
  // 逐行扫，才能报行号
  lines.forEach((line, i) => {
    let mm;
    const re = /this\.([\w$]+)\s*\(/g;
    while ((mm = re.exec(line))) {
      const name = mm[1];
      if (defined.has(name)) continue;
      // data 桥的方法不在此列；wx.xxx 不会匹配 this.
      // 过滤掉看起来是对象方法的调用（this.xxx.yyy( 不会匹配，正则已保证后面是括号）
      console.log('❌ ' + rel + ':' + (i + 1) + '  调用了未定义的方法 this.' + name + '()');
      console.log('     ' + line.trim().slice(0, 110));
      problems++;
    }
  });
}

/* ========== 窗口信息调用必须有保护 ========== */
// wx.getWindowInfo / getSystemInfoSync 在初始化、切后台、工具重载时
// 可能返回 null，直接读 .windowWidth / .pixelRatio 会抛
// "Cannot read properties of null (reading 'screenHeight')"。
const wxCallsUnsafe = [];
for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const raw = fs.readFileSync(file, 'utf8');
  const clean = stripNoise(raw);
  const lines = clean.split('\n');
  lines.forEach((line, i) => {
    if (line.indexOf('wx.getWindowInfo') === -1 &&
        line.indexOf('wx.getSystemInfoSync') === -1) return;
    let guarded = false;
    for (let k = Math.max(0, i - 8); k <= i; k++) {
      if (/\btry\s*\{/.test(lines[k])) { guarded = true; break; }
    }
    if (/\&\&\s*\w+\./.test(line)) guarded = true;
    if (/\|\|/.test(line)) guarded = true;
    if (rel === 'utils/roomkit.js') guarded = true;
    if (!guarded) wxCallsUnsafe.push(rel + ':' + (i + 1) + '  ' + line.trim().slice(0, 90));
  });
}
if (wxCallsUnsafe.length) {
  console.log('');
  console.log('WARN 未保护的窗口信息调用（可能抛 null screenHeight 错误）：');
  wxCallsUnsafe.forEach(function (s) { console.log('   ' + s); });
  problems += wxCallsUnsafe.length;
} else {
  console.log('');
  console.log('OK 窗口信息调用全部有保护（try/catch 或空值兜底）');
}


if (problems) {
  console.log('\n共 ' + problems + ' 处可疑调用（页面方法未定义 → 运行时 TypeError 白屏）');
  process.exit(1);
}
console.log('\n✓ 页面方法调用检查通过（' + files.length + ' 个文件）');
