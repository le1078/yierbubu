// 一键跑全部自动化检查：语法 → 静态契约 → 引擎单测 → 模糊测试 → 联机仿真。
// 用法：node tools/run_all_tests.js [--verbose]
//
// 交付门槛：全部 PASS 才算通过。任何一项失败都会以非 0 退出码结束，
// 便于接入 CI 或提交前自检。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TOOLS = __dirname;
const VERBOSE = process.argv.indexOf('--verbose') !== -1;

/* ========== 1. 语法检查（所有 js 源码） ========== */
function walk(dir, out, exts) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'backup-20260830') continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out, exts);
    else if (exts.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

const srcFiles = [];
walk(path.join(ROOT, 'pages'), srcFiles, ['.js']);
walk(path.join(ROOT, 'components'), srcFiles, ['.js']);
walk(path.join(ROOT, 'subpackages'), srcFiles, ['.js']);
walk(path.join(ROOT, 'utils'), srcFiles, ['.js']);
srcFiles.push(path.join(ROOT, 'app.js'));

console.log('=== 1. 语法检查（' + srcFiles.length + ' 个文件）===');
let syntaxBad = 0;
for (const f of srcFiles) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    syntaxBad++;
    console.log('  ❌ 语法错误: ' + path.relative(ROOT, f));
    if (VERBOSE) console.log(String(e.stderr || e.message));
  }
}
console.log(syntaxBad === 0 ? '  ✓ 全部通过' : '  ❌ ' + syntaxBad + ' 个文件语法错误');

/* ========== 2. 静态契约 & 3. 功能测试 ========== */
// 顺序：先静态契约（快），再引擎，再模糊/仿真（慢）
const ORDER = [
  // 静态契约：页面/wxml/require/兼容性
  'wxml_structure_check.js', 'wxml_key_check.js', 'wxml_event_audit.js', 'wxml_data_audit.js', 'wx_page_check.js',
  'js_method_check.js', 'wx_require_check.js', 'wx_compat_check.js', 'wx_canvas_check.js', 'wx_draw_check.js', 'package_size_check.js', 'wxss_class_check.js', 'assets_check.js',
  // 主包
  'life_check.js', 'life_logic_test.js', 'trash_flow_test.js', 'cloudstore_load_test.js',
  'cloudstore_real_test.js', 'cloudstore_chaos_test.js', 'pages_logic_test.js',
  'page_smoke_test.js',
  'shengxiao_logic_test.js',
  // 联机基础设施
  'join_arg_test.js', 'roomkit_join_test.js', 'roomkit_sync_test.js', 'relay_client_test.js',
  'relay_server_soak_test.js',
  // 五子棋
  'gomoku_logic_test.js', 'gomoku_ai_test.js', 'gomokuai_online_test.js',
  // 象棋
  'xiangqi_logic_test.js', 'xiangqi_ai_test.js', 'xiangqi_online_test.js',
  // 马里奥
  'mario_logic_test.js', 'mario_mechanics_test.js', 'mario_features_test.js',
  'mario_level_test.js', 'level_data_check.js', 'mario_render_test.js', 'mario_sync_test.js',
  'mario_online_flow_test.js', 'mario_page_check.js', 'mario_relay_test.js',
  'mario_lifecycle_test.js', 'mario_soak_test.js',
  // 跨游戏页面流程
  'game_page_flow_test.js',
  // 模糊 / 收敛（较慢）
  'mario_fuzz_test.js', 'xiangqi_fuzz_test.js', 'gomoku_fuzz_test.js',
  'online_convergence_test.js'
];

// 未被 ORDER 列出的测试脚本也要跑（防止新加的测试被漏掉）。
// relay_smoke_test 依赖已部署的服务器与网络，默认跳过；加 --with-relay 才跑。
const WITH_RELAY = process.argv.indexOf('--with-relay') !== -1;
const all = fs.readdirSync(TOOLS)
  .filter((n) => /(_test|_check)\.js$/.test(n) && n !== 'run_all_tests.js')
  .filter((n) => (n === 'relay_smoke_test.js' ? WITH_RELAY : true))
  .sort();
const extra = all.filter((n) => ORDER.indexOf(n) === -1);

const scripts = ORDER.filter((n) => fs.existsSync(path.join(TOOLS, n)))
  .concat(extra);

console.log('\n=== 2. 自动化测试（' + scripts.length + ' 组）===');
const results = [];
let failed = 0;
const t0 = Date.now();
for (let i = 0; i < scripts.length; i++) {
  const name = scripts[i];
  const started = Date.now();
  let ok = true;
  let lastLine = '';
  try {
    const out = execFileSync(process.execPath, [path.join(TOOLS, name)], {
      cwd: ROOT, stdio: 'pipe', timeout: 300000, encoding: 'utf8'
    });
    const lines = String(out).trim().split('\n');
    lastLine = lines[lines.length - 1] || '';
  } catch (e) {
    ok = false;
    const out = String((e.stdout || '') + (e.stderr || ''));
    const lines = out.trim().split('\n');
    lastLine = lines[lines.length - 1] || e.message;
    if (VERBOSE) console.log(out.split('\n').filter((l) => l.indexOf('❌') !== -1).join('\n'));
  }
  const ms = Date.now() - started;
  results.push({ name, ok, lastLine, ms });
  if (!ok) failed++;
  const pad = name + ' '.repeat(Math.max(0, 34 - name.length));
  console.log('  ' + (ok ? '✓' : '❌') + ' ' + pad + (ms + 'ms').padStart(8) +
    (ok ? '' : '  ← ' + lastLine.slice(0, 70)));
}
console.log('\n耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

/* ========== 汇总 ========== */
console.log('\n========================================');
console.log('语法检查: ' + (syntaxBad === 0 ? '通过' : syntaxBad + ' 个失败'));
console.log('测试套件: ' + (scripts.length - failed) + ' / ' + scripts.length + ' 通过');
if (syntaxBad > 0 || failed > 0) {
  console.log('\n❌ 存在失败项，不可交付');
  process.exit(1);
}
console.log('✅ 全部通过，可交付');
