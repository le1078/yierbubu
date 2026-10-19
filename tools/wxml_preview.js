// 小程序页面 → HTML 预览渲染器（网页镜像，非源码）
// 用途：不开微信开发者工具也能在浏览器里核对页面视觉与数据绑定。
// 支持 WXML 子集：{{插值}} / wx:if / wx:for(+wx:for-item / wx:for-index) / 常见标签映射
// 用法：node tools/wxml_preview.js <页面路径，不含扩展名> [--pick=3] [--scrollTo=.sel] [--noAnim] [--debug] [--out=xxx.html] [--width=375]
//   例：node tools/wxml_preview.js subpackages/shengxiao/shengxiao/shengxiao --pick=0 --noAnim --out=.preview/sx.html
//
// 截图注意：
//   1) 有入场动画的页面截图时加 --noAnim，否则可能截到动画起始帧（面板透明/尺寸差 4%）。
//   2) Windows 上无头 Chrome 的窗口宽度有 ~500px 下限（--window-size=375 会被钳制到 ~500），
//      所以截图时窗口宽度要开 ≥520px，否则会得到「按 500px 布局再裁到 375px」的假象（右侧像被裁掉）。
//      预览里 .phone 固定 --width（默认 375）px，页面内部的 rpx→px 换算与真实视口宽度无关，不受此影响。
//      要精确指定手机视口，就把预览页放进一个 width:375px 的 iframe 里。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILE_BASE = 'file:///' + ROOT.replace(/\\/g, '/').replace(/^\/*/, '');

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const pageRel = (argv.find((a) => !a.startsWith('--')) || '').replace(/\\/g, '/');
const opt = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
};
if (!pageRel) {
  console.error('用法: node tools/wxml_preview.js <页面路径，不含扩展名> [--pick=N] [--out=xxx.html] [--width=375]');
  process.exit(1);
}
const pickIdx = opt('pick', null);
const width = Number(opt('width', 375));
const outFile = path.resolve(ROOT, opt('out', `.preview/${pageRel.split('/').pop()}.html`));
const scrollTo = opt('scrollTo', '');
// --set=key=value（可重复）：注入初始 data，便于预览非默认状态（如 --set=tab=shengxiao）
const dataSets = argv.filter((a) => a.startsWith('--set='))
  .map((a) => a.slice('--set='.length))
  .map((s) => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; });
// --noAnim：冻结 CSS 动画。截图时强烈建议带上 —— 否则入场动画（opacity/transform）
// 可能停在起始帧，截出「面板几乎全透明 / 尺寸差 4%」的假象。
const noAnim = argv.includes('--noAnim');
// --setjson=key::<json> 或 --setjson=key::@file.json：注入任意 JSON（可含 _ 开头的实例属性），
// 用于渲染带示例数据的列表。JSON 里常有 '='（如 URL 查询串），所以用 '::' 分隔。
const jsonSets = argv.filter((a) => a.startsWith('--setjson='))
  .map((a) => a.slice('--setjson='.length))
  .map((s) => {
    const i = s.indexOf('::');
    const key = s.slice(0, i);
    let raw = s.slice(i + 2);
    if (raw.charAt(0) === '@') raw = fs.readFileSync(path.resolve(ROOT, raw.slice(1)), 'utf8');
    return [key, JSON.parse(raw)];
  });
// --call=methodName：注入数据后调用页面方法（如 _render）
const calls = argv.filter((a) => a.startsWith('--call=')).map((a) => a.slice('--call='.length));
// --gifStatic：截图时把 .gif 换成首帧 PNG（无头 Chrome 合成动图时偶尔整块空白，属渲染器 bug）
const gifStatic = argv.includes('--gifStatic');
// --skipInit：不执行 onLoad/attached（避免它异步拉云端数据把 --setjson 的示例数据覆盖掉）
const skipInit = argv.includes('--skipInit');
function gifToPng(absGif) {
  const cacheDir = path.join(ROOT, '.preview', '.gifcache');
  const out = path.join(cacheDir, path.relative(ROOT, absGif).split(path.sep).join('_') + '.png');
  try {
    if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(absGif).mtimeMs) return out;
  } catch (e) { /* fallthrough */ }
  fs.mkdirSync(cacheDir, { recursive: true });
  const { execFileSync } = require('child_process');
  execFileSync('python', ['-c',
    'import sys;from PIL import Image;im=Image.open(sys.argv[1]);im.seek(0);im.convert("RGBA").save(sys.argv[2])',
    absGif, out], { stdio: 'ignore' });
  return out;
}

/* ---------------- 1. 载入页面逻辑并取数据 ---------------- */
const pageJs = path.join(ROOT, pageRel + '.js');
let cfg = null;
// 页面 JS 里的 require 以页面文件所在目录为基准解析
const pageRequire = (req) => {
  const p = req.startsWith('.') ? path.resolve(path.dirname(pageJs), req) : req;
  return require(p);
};
// 页面用 Page({...})，自定义组件用 Component({...})，两者都接
const collect = (c) => { cfg = c; };
new Function('Page', 'Component', 'require', 'wx', 'getApp', fs.readFileSync(pageJs, 'utf8'))(
  collect,
  collect,
  pageRequire,
  typeof wx === 'undefined' ? {} : wx,
  () => ({ globalData: {} })
);
if (!cfg) { console.error('未找到 Page(...) / Component(...) 定义:', pageJs); process.exit(1); }
// 组件的初始化/事件在 lifetimes 与 methods 下，页面则直接挂在顶层
const initFn = (cfg.lifetimes && cfg.lifetimes.attached) || cfg.onLoad;
const pickFn = (cfg.methods && cfg.methods.onPick) || cfg.onPick;

// 上下文 = 页面所有方法 + data + setData（模拟 this）
const ctx = Object.assign({}, cfg, {
  data: JSON.parse(JSON.stringify(cfg.data || {})),
  setData(patch, cb) { Object.assign(this.data, patch); if (cb) cb.call(this); }
});
Object.keys(cfg).forEach((k) => { if (typeof cfg[k] === 'function') ctx[k] = cfg[k]; });
// 组件的方法在 methods 下，也要挂到上下文里
if (cfg.methods) Object.keys(cfg.methods).forEach((k) => { if (typeof cfg.methods[k] === 'function') ctx[k] = cfg.methods[k]; });
if (typeof initFn === 'function' && !skipInit) initFn.call(ctx);
dataSets.forEach(([k, v]) => { ctx.setData({ [k]: v }); });
jsonSets.forEach(([k, v]) => { ctx[k] = v; ctx.data[k] = v; });
calls.forEach((m) => { if (typeof ctx[m] === 'function') ctx[m].call(ctx); });
if (pickIdx !== null && typeof pickFn === 'function') {
  pickFn.call(ctx, { currentTarget: { dataset: { i: Number(pickIdx) } } });
}
const scope = ctx.data;

/* ---------------- 1.5 自定义组件：内联展开 ---------------- */
const pageJsonPath = path.join(ROOT, pageRel + '.json');
const pageJson = JSON.parse(fs.readFileSync(pageJsonPath, 'utf8'));
const COMPONENTS = pageJson.usingComponents || {};
const compCssRendered = new Set();
const compCss = [];

// 把组件自己的 wxml 用组件 data 展开渲染，样式收集到 compCss，实现「同页内联」的真实预览
function renderComponent(name) {
  const raw = COMPONENTS[name] || '';
  const base = raw.charAt(0) === '/'
    ? path.join(ROOT, raw.slice(1))
    : path.resolve(path.dirname(pageJs), raw);
  let compCfg = null;
  try {
    new Function('Page', 'Component', 'require', 'wx', 'getApp',
      fs.readFileSync(base + '.js', 'utf8'))(
      (c) => { compCfg = c; },
      (c) => { compCfg = c; },
      (req) => require(req.startsWith('.') ? path.resolve(path.dirname(base + '.js'), req) : req),
      {}, () => ({ globalData: {} })
    );
  } catch (e) {
    return `<!-- 组件 ${name} 加载失败: ${e.message} -->`;
  }
  const compCtx = Object.assign({}, compCfg, {
    data: JSON.parse(JSON.stringify(compCfg.data || {})),
    setData(p) { Object.assign(this.data, p); }
  });
  if (compCfg.methods) {
    Object.keys(compCfg.methods).forEach((k) => {
      if (typeof compCfg.methods[k] === 'function') compCtx[k] = compCfg.methods[k];
    });
  }
  const cInit = (compCfg.lifetimes && compCfg.lifetimes.attached) || compCfg.onLoad;
  if (typeof cInit === 'function') cInit.call(compCtx);
  if (pickIdx !== null) {
    const cPick = (compCfg.methods && compCfg.methods.onPick) || compCfg.onPick;
    if (typeof cPick === 'function') {
      cPick.call(compCtx, { currentTarget: { dataset: { i: Number(pickIdx) } } });
    }
  }
  if (!compCssRendered.has(base)) {
    compCssRendered.add(base);
    try { compCss.push(convertWxss(fs.readFileSync(base + '.wxss', 'utf8'))); } catch (e) { /* 无 wxss */ }
  }
  try {
    return renderNode(parseWxml(fs.readFileSync(base + '.wxml', 'utf8')), compCtx.data);
  } catch (e) {
    return `<!-- 组件 ${name} 渲染失败: ${e.message} -->`;
  }
}

/* ---------------- 2. WXML 解析 ---------------- */
function parseAttrs(raw) {
  const attrs = {};
  const re = /([a-zA-Z0-9_:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;
  let m;
  while ((m = re.exec(raw))) {
    if (!m[1]) continue;
    attrs[m[1]] = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : true);
  }
  return attrs;
}

function parseWxml(src) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  // 逐字符扫描，正确处理引号内的 > / <
  let i = 0, last = 0;
  const pushText = (txt) => { if (txt.trim()) stack[stack.length - 1].children.push({ tag: '#text', text: txt }); };
  while (i < src.length) {
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      pushText(src.slice(last, i));
      i = end === -1 ? src.length : end + 3;
      last = i;
      continue;
    }
    const ch = src[i];
    if (ch === '<' && src[i + 1] === '/') {
      const end = src.indexOf('>', i);
      if (end === -1) break;
      pushText(src.slice(last, i));
      if (stack.length > 1) stack.pop();
      i = end + 1; last = i;
      continue;
    }
    if (ch === '<' && /[a-zA-Z]/.test(src[i + 1] || '')) {
      let j = i + 1, quote = null;
      while (j < src.length) {
        const c = src[j];
        if (quote) { if (c === quote) quote = null; }
        else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
        j++;
      }
      if (j >= src.length) break;
      pushText(src.slice(last, i));
      const raw = src.slice(i + 1, j);
      const selfClose = /\/\s*$/.test(raw);
      const m = raw.match(/^([a-zA-Z0-9-]+)([\s\S]*)$/);
      if (m) {
        const node = { tag: m[1], attrs: parseAttrs(m[2].replace(/\/\s*$/, '')), children: [] };
        stack[stack.length - 1].children.push(node);
        if (!selfClose) stack.push(node);
      }
      i = j + 1; last = i;
      continue;
    }
    i++;
  }
  const tail = src.slice(last);
  if (tail.trim()) root.children.push({ tag: '#text', text: tail });
  return root;
}

/* ---------------- 3. 表达式求值 ---------------- */
const exprCache = {};
function evalExpr(raw, sc) {
  const code = String(raw).replace(/^\{\{/, '').replace(/\}\}$/, '').trim();
  if (!code) return '';
  if (!exprCache[code]) {
    exprCache[code] = new Function('__s', 'with(__s){ return (' + code + '); }');
  }
  try { return exprCache[code](sc); } catch (e) { return ''; }
}
function interp(str, sc) {
  return String(str).replace(/\{\{([\s\S]*?)\}\}/g, (_, e) => {
    const v = evalExpr(e, sc);
    return v === undefined || v === null ? '' : String(v);
  });
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---------------- 4. 渲染 ---------------- */
const TAG_MAP = { view: 'div', text: 'span', image: 'img', canvas: 'canvas', button: 'button', 'scroll-view': 'div' };
const SKIP_ATTR = /^(wx:|bind|catch|capture-|hover-|data-|mode$|lazy-load|show-menu-by-longpress)/;

function renderNode(node, sc) {
  if (node.tag === '#text') return esc(interp(node.text, sc));
  const attrs = node.attrs;

  if (attrs['wx:if'] !== undefined) {
    const v = evalExpr(attrs['wx:if'], sc);
    if (!v) return '';
  }

  if (attrs['wx:for'] !== undefined) {
    const list = evalExpr(attrs['wx:for'], sc) || [];
    const itemName = attrs['wx:for-item'] || 'item';
    const idxName = attrs['wx:for-index'] || 'index';
    return list.map((it, ix) => {
      const child = Object.assign({}, sc);
      child[itemName] = it;
      child[idxName] = ix;
      return renderElement(node, child);
    }).join('');
  }

  return renderElement(node, sc);
}

function renderElement(node, sc) {
  if (node.tag === 'block' || node.tag === '#root') {
    return node.children.map((c) => renderNode(c, sc)).join('');
  }
  if (COMPONENTS[node.tag]) return renderComponent(node.tag);

  const outTag = TAG_MAP[node.tag] || node.tag;
  const parts = [];

  Object.keys(node.attrs).forEach((k) => {
    if (SKIP_ATTR.test(k) || k.startsWith('wx:')) return;
    let v = interp(node.attrs[k], sc);
    // 以 / 开头的资源路径（小程序里指向包根）→ 转成相对路径，便于离线预览
    if (k === 'src' && v.charAt(0) === '/') v = path.relative(path.dirname(outFile), path.join(ROOT, v.slice(1))).split(path.sep).join('/');
    if (gifStatic && k === 'src' && /\.gif$/i.test(v)) {
      try {
        const abs = path.resolve(path.dirname(outFile), v);
        v = path.relative(path.dirname(outFile), gifToPng(abs)).split(path.sep).join('/');
      } catch (e) { console.warn('动图取帧失败:', v, e.message); }
    }
    if (k === 'src' && !v) return;
    parts.push(`${k}="${esc(v)}"`);
  });

  // image 的 mode → object-fit
  if (node.tag === 'image' && node.attrs.mode === 'aspectFit') {
    parts.push('style="object-fit:contain"', 'data-wx="image"');
  }

  const inner = node.children.map((c) => renderNode(c, sc)).join('');
  if (outTag === 'img') return `<img ${parts.join(' ')} />`;
  return `<${outTag} ${parts.join(' ')}>${inner}</${outTag}>`;
}

/* ---------------- 5. WXSS 转换 ---------------- */
function convertWxss(css) {
  return css
    .replace(/(-?[\d.]+)rpx/g, (_, n) => `${(parseFloat(n) * (width / 750)).toFixed(3).replace(/\.?0+$/, '')}px`)
    .replace(/(^|[\s,{}])page(\s*[{,])/g, '$1.screen$2');
}

/* ---------------- 6. 输出 ---------------- */
const wxml = fs.readFileSync(path.join(ROOT, pageRel + '.wxml'), 'utf8');
const wxss = convertWxss(fs.readFileSync(path.join(ROOT, pageRel + '.wxss'), 'utf8'));
const jsonCfg = JSON.parse(fs.readFileSync(path.join(ROOT, pageRel + '.json'), 'utf8'));

const body = renderNode(parseWxml(wxml), scope);

// --debug：把关键节点的实测几何/字号写进 DOM，配合 chrome --dump-dom 做数值核对
const DEBUG_SCRIPT = `
<script>
window.addEventListener('load', function () {
  var sels = ['.phone', '.sx-hd', '.sx-card', '.sx-tip', '.sx-tip-img', '.sx-tip-txt', '.zgrid', '.zbtn',
    '.legend', '.lg', '.empty', '.result', '.result-body', '.rel-row', '.rel-label', '.rel-main', '.r-h3',
    '.rel-val', '.rel-desc', '.meta', '.sx-foot', '.foot-img'];
  var lines = ['viewport=' + window.innerWidth + 'x' + window.innerHeight + ' dpr=' + window.devicePixelRatio];
  sels.forEach(function (s) {
    var e = document.querySelector(s);
    if (!e) { lines.push(pad(s) + ' MISSING'); return; }
    var r = e.getBoundingClientRect();
    var c = getComputedStyle(e);
    lines.push(pad(s) + ' x=' + Math.round(r.left) + ' w=' + Math.round(r.width) + ' h=' + Math.round(r.height)
      + ' | content=' + c.width + ' pad=' + c.padding + ' bd=' + c.borderWidth + ' mg=' + c.margin
      + ' | font=' + c.fontSize + ' ' + c.display + ' ' + c.boxSizing);
  });
  function pad(s) { while (s.length < 14) s += ' '; return s; }
  var pre = document.createElement('pre');
  pre.id = '__measure';
  pre.textContent = lines.join('\\n');
  document.body.appendChild(pre);
});
</script>`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${jsonCfg.navigationBarTitleText || pageRel}</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#FFE8E0;
  font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;}
body{display:flex;justify-content:center;min-height:100vh}
.phone{width:${width}px;max-width:100%;background:#fff;min-height:100vh;display:flex;flex-direction:column;
  box-shadow:0 24px 60px rgba(255,138,171,.25);overflow:hidden}
.navbar{flex:none;height:44px;display:flex;align-items:center;justify-content:center;
  color:#fff;font-size:17px;font-weight:500;
  background:${jsonCfg.navigationBarBackgroundColor || '#FF8FAB'};
  ${jsonCfg.navigationBarTextStyle === 'black' ? 'color:#000;' : ''}}
.screen{flex:1;overflow-y:auto}
/* WXML 的 view/text/image 在预览里被换成 div/span/img，这里补齐等价的 box-sizing */
.screen *{box-sizing:border-box}
${noAnim ? '.screen *{animation:none !important;transition:none !important}' : ''}
${wxss}
${compCss.join('\n')}
</style>
</head>
<body>
<div class="phone">
  <div class="navbar">${jsonCfg.navigationBarTitleText || ''}</div>
  <div class="screen">${body}</div>
</div>
${scrollTo ? `<script>window.addEventListener('load',function(){setTimeout(function(){var e=document.querySelector(${JSON.stringify(scrollTo)});if(e)e.scrollIntoView({block:'start'});},200);});</script>` : ''}
${argv.includes('--debug') ? DEBUG_SCRIPT : ''}
</body>
</html>
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html);
console.log(`已生成预览：${path.relative(ROOT, outFile)}  (${(html.length / 1024).toFixed(1)} KB)`);
if (pickIdx !== null) console.log(`  数据状态：已点击第 ${pickIdx} 个生肖`);
