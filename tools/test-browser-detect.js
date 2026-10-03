/**
 * 浏览器探测自测。
 *
 * 纯离线：环境变量表、exists、readdir 全是注入的假实现，
 * 不开浏览器、不看真实磁盘（最后一节会读一次真实磁盘，作为"这台机器"的落地校验）。
 *
 * 跑法：node tools\test-browser-detect.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const detect = require(path.join(__dirname, '..', 'src', 'browser-detect.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${extra ? '  → ' + extra : ''}`);
  }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}
function section(t) {
  console.log(`\n【${t}】`);
}

/** 造一个假的"文件系统"：给定存在的路径集合 */
function fakeFs(paths) {
  const set = new Set(paths.map((p) => p.toLowerCase()));
  return {
    exists: (p) => set.has(String(p).toLowerCase()),
    paths: [...set],
  };
}

const ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
};

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CHROME_LOCAL = 'C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const B360 = 'C:\\Program Files (x86)\\360\\360Chrome\\Chrome\\Application\\360chrome.exe';
const QQB = 'C:\\Users\\u\\AppData\\Local\\Tencent\\QQBrowser\\Application\\QQBrowser.exe';
const FIREFOX = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';

/* ---------------- 1. 环境变量展开 ---------------- */
section('① 环境变量展开');
{
  eq('展开 %ProgramFiles%', detect.expandEnv('%ProgramFiles%\\a\\b.exe', ENV), 'C:\\Program Files\\a\\b.exe');
  eq('展开 %ProgramFiles(x86)%', detect.expandEnv('%ProgramFiles(x86)%\\x.exe', ENV), 'C:\\Program Files (x86)\\x.exe');
  eq('多个变量都展开', detect.expandEnv('%LOCALAPPDATA%\\%ProgramFiles%'.replace('%ProgramFiles%', 'p'), ENV), 'C:\\Users\\u\\AppData\\Local\\p');
  eq('认不出的变量原样保留（不会误判成"文件存在"）', detect.expandEnv('%不存在的变量%\\x.exe', ENV), '%不存在的变量%\\x.exe');
  eq('32 位系统上没有 ProgramFiles(x86) → 原样保留', detect.expandEnv('%ProgramFiles(x86)%\\x.exe', { ProgramFiles: 'C:\\Program Files' }), '%ProgramFiles(x86)%\\x.exe');
}

/* ---------------- 2. 快速探测 ---------------- */
section('② 快速探测（查已知路径）');
{
  const r = detect.detectInstalled(ENV, fakeFs([CHROME]).exists);
  eq('只装了 Chrome → 认出 1 个', r.length, 1);
  eq('  是 chrome', r[0] && r[0].id, 'chrome');
  eq('  带 channel（playwright 官方通道）', r[0] && r[0].channel, 'chrome');
  eq('  引擎标成 chromium', r[0] && r[0].engine, 'chromium');
}
{
  const r = detect.detectInstalled(ENV, fakeFs([EDGE]).exists);
  eq('只装了 Edge → 也能认出来', r.length, 1);
  eq('  是 msedge', r[0] && r[0].id, 'msedge');
  eq('  带 channel', r[0] && r[0].channel, 'msedge');
}
{
  const r = detect.detectInstalled(ENV, fakeFs([CHROME, EDGE]).exists);
  eq('两个都装了 → 都认出来', r.length, 2);
  eq('  Chrome 排前面（自动模式的优先级）', r[0] && r[0].id, 'chrome');
  eq('  Edge 排后面', r[1] && r[1].id, 'msedge');
}
{
  const r = detect.detectInstalled(ENV, fakeFs([CHROME_LOCAL]).exists);
  eq('Chrome 只装在用户目录（免安装版）也能认出来', r.length, 1);
  eq('  取到的是用户目录那份', r[0] && r[0].executablePath, CHROME_LOCAL);
}
{
  const r = detect.detectInstalled(ENV, fakeFs([B360]).exists);
  eq('360 安全浏览器能认出来', r.length, 1);
  eq('  是 360se', r[0] && r[0].id, '360se');
  eq('  没有 channel（playwright 不支持它）', r[0] && r[0].channel, undefined);
  ok('  但给了 executablePath，可以按路径启动', !!(r[0] && r[0].executablePath));
}
{
  const r = detect.detectInstalled(ENV, fakeFs([QQB]).exists);
  eq('QQ 浏览器能认出来', r[0] && r[0].id, 'qq');
}
{
  const r = detect.detectInstalled(ENV, fakeFs([FIREFOX]).exists);
  eq('Firefox 能认出来', r[0] && r[0].id, 'firefox');
  eq('  引擎标成 firefox', r[0] && r[0].engine, 'firefox');
}
{
  const r = detect.detectInstalled(ENV, fakeFs([]).exists);
  eq('什么都没装 → 空列表（交给上层报错）', r.length, 0);
}
{
  // exists 抛异常不能把整个流程带崩
  const r = detect.detectInstalled(ENV, () => {
    throw new Error('权限不足');
  });
  eq('exists 抛异常时优雅返回空列表', r.length, 0);
}

/* ---------------- 3. 候选顺序 ---------------- */
section('③ 启动候选顺序（buildChain）');
const builtinOK = { available: true, name: 'Playwright 自带 Chromium', candidate: { id: 'builtin', name: 'Playwright 自带 Chromium', executablePath: 'X:\\chromium.exe' } };
const builtinNO = { available: false, name: 'Playwright 自带 Chromium（未下载）' };
const bc = (browser, detected, builtin) => detect.buildChain({ browser }, detected, builtin || builtinNO);
const names = (chain) => chain.map((c) => c.name).join(' | ');

{
  const det = detect.detectInstalled(ENV, fakeFs([CHROME, EDGE]).exists);
  const chain = bc({ channel: 'auto' }, det, builtinOK);
  eq('auto：认出来的 → 自带内核兜底，共 3 档', chain.length, 3);
  eq('  顺序 Chrome → Edge → 自带', names(chain), 'Google Chrome | Microsoft Edge | Playwright 自带 Chromium');
}
{
  const chain = bc({ channel: '' }, [], builtinOK);
  eq('auto（空字符串也算自动）：没有系统浏览器时只剩自带内核', chain.length, 1);
  eq('  就是自带内核', chain[0] && chain[0].id, 'builtin');
}
{
  const chain = bc({ channel: 'auto' }, [], builtinNO);
  eq('一个都没有、自带也没下载 → 空链条（上层会给出人话报错）', chain.length, 0);
}
{
  const det = detect.detectInstalled(ENV, fakeFs([CHROME, EDGE]).exists);
  const chain = bc({ channel: 'msedge' }, det, builtinOK);
  eq('显式指定 msedge → 它排第一', chain[0] && chain[0].channel, 'msedge');
  ok('  后面仍然兜底（配置写错一个字不该让工具用不了）', chain.length > 1);
  eq('  且没有重复的 msedge', chain.filter((c) => c.channel === 'msedge').length, 1);
  ok('  Chrome 作为后备还在', chain.some((c) => c.channel === 'chrome'));
}
{
  const chain = bc({ channel: 'msedge-dev' }, [], builtinOK);
  eq('指定一个本机没装的通道 → 仍然排在前面试一次', chain[0] && chain[0].channel, 'msedge-dev');
  ok('  失败后能退到自带内核', chain[chain.length - 1].id === 'builtin');
}
{
  const det = detect.detectInstalled(ENV, fakeFs([CHROME]).exists);
  const chain = bc({ channel: 'auto', executablePath: B360 }, det, builtinOK);
  eq('手填 exe → 优先级最高', chain[0] && chain[0].executablePath, B360);
  ok('  手填的名字里带上文件名，便于日志辨认', /360chrome\.exe/.test(chain[0].name));
  eq('  一共 3 档（手填 + Chrome + 自带）', chain.length, 3);
}
{
  const det = detect.detectInstalled(ENV, fakeFs([B360]).exists);
  const chain = bc({ channel: 'auto' }, det, builtinOK);
  eq('自动模式也能用上 360（按路径启动）', chain[0] && chain[0].executablePath, B360);
  eq('  它没有 channel，所以用 executablePath', chain[0] && chain[0].channel, undefined);
}

/* ---------------- 4. 慢速扫描 ---------------- */
section('④ 慢速扫描（非标准安装位置）');
{
  // 造目录树：C:\Program Files\SomethingWeird\OurBrowser\browser.exe 之类
  const tree = {
    'C:\\Program Files': [
      { n: 'SomeVendor', d: true },
      { n: 'node_modules', d: true },
      { n: 'readme.txt', d: false },
    ],
    'C:\\Program Files\\SomeVendor': [
      { n: 'Bin', d: true },
      { n: 'chrome.exe', d: false },
    ],
    'C:\\Program Files\\SomeVendor\\Bin': [{ n: 'msedge.exe', d: false }],
    'C:\\Users\\u\\AppData\\Local': [
      { n: 'Tencent', d: true },
      { n: 'Temp', d: true },
    ],
    'C:\\Users\\u\\AppData\\Local\\Tencent': [{ n: 'QQBrowser.exe', d: false }],
    'C:\\Users\\u\\AppData\\Local\\Temp': [{ n: 'chrome.exe', d: false }],
  };
  const readdir = (p) => {
    const items = tree[p];
    if (!items) throw new Error('ENOENT');
    return items.map((it) => ({ name: it.n, isDirectory: () => it.d }));
  };

  const found = detect.deepScan({ env: ENV, readdir, exists: () => true, maxDepth: 3 });
  const ids = found.map((f) => f.id).sort();
  ok('扫到了非标准位置的 chrome', ids.includes('chrome'));
  ok('扫到了非标准位置的 msedge', ids.includes('msedge'));
  ok('扫到了非标准位置的 QQ 浏览器', ids.includes('qq'));
  ok('★ 跳过了 Temp 目录（里面的 chrome.exe 不算）', found.filter((f) => /Temp/i.test(f.executablePath)).length === 0);
  ok('列出了 executablePath，可以直接用', found.every((f) => !!f.executablePath));
  ok('补上了正式名字', found.every((f) => f.name !== f.executablePath));
}
{
  const readdir = () => {
    throw new Error('拒绝访问');
  };
  const found = detect.deepScan({ env: ENV, readdir, exists: () => true });
  eq('目录读不了时返回空列表，不抛异常', found.length, 0);
}
{
  // 深度限制：第 5 层才有的浏览器不该被扫到（默认 maxDepth=3）
  const deep = {
    'C:\\Program Files': [{ n: 'a', d: true }],
    'C:\\Program Files\\a': [{ n: 'b', d: true }],
    'C:\\Program Files\\a\\b': [{ n: 'c', d: true }],
    'C:\\Program Files\\a\\b\\c': [{ n: 'd', d: true }],
    'C:\\Program Files\\a\\b\\c\\d': [{ n: 'chrome.exe', d: false }],
  };
  const readdir = (p) => {
    const items = deep[p];
    if (!items) throw new Error('ENOENT');
    return items.map((it) => ({ name: it.n, isDirectory: () => it.d }));
  };
  const found = detect.deepScan({ env: ENV, readdir, exists: () => true, maxDepth: 3 });
  eq('超出深度限制的不扫（避免扫爆硬盘）', found.length, 0);
}
{
  const readdir = (p) => {
    if (p !== 'C:\\Program Files') throw new Error('ENOENT');
    return [{ name: 'chrome.exe', isDirectory: () => false }];
  };
  const found = detect.deepScan({ env: ENV, readdir, exists: () => true, budget: 0 });
  eq('预算为 0 时立刻停下', found.length, 0);
}

/* ---------------- 5. 候选表自身的完整性 ---------------- */
section('⑤ 候选表完整性');
{
  const ids = detect.KNOWN_BROWSERS.map((b) => b.id);
  eq('浏览器 id 没有重复', new Set(ids).size, ids.length);
  ok('每个浏览器都有名字和至少一条 exe 路径', detect.KNOWN_BROWSERS.every((b) => b.name && b.exe && b.exe.length));
  const badExe = detect.KNOWN_BROWSERS.filter((b) => b.exe.some((p) => !/%[A-Za-z0-9()]+%/.test(p)));
  eq('所有 exe 路径都以环境变量开头（不写死盘符）', badExe.length, 0);
  const missing = [];
  for (const b of detect.KNOWN_BROWSERS) {
    for (const p of b.exe) {
      const base = path.basename(detect.expandEnv(p, ENV)).toLowerCase();
      if (!detect.EXE_INDEX[base]) missing.push(`${b.id}/${base}`);
    }
  }
  eq('每个 exe 文件名都在 EXE_INDEX 里（慢速扫描才认得出）', missing.length, 0);
  ok('chrome / msedge 有 channel（走官方通道最稳）', !!detect.findById(detect.KNOWN_BROWSERS, 'chrome').channel && !!detect.findById(detect.KNOWN_BROWSERS, 'msedge').channel);
  ok('firefox 被标成 firefox 引擎', detect.findById(detect.KNOWN_BROWSERS, 'firefox').engine === 'firefox');
}

/* ---------------- 6. 登录态目录的归属 ---------------- */
section('⑥ 登录态目录按浏览器分开（不互相污染）');
{
  const { resolveUserDataDir, planUserDataDir } = require(path.join(__dirname, '..', 'src', 'browser.js'));
  const tmp = path.join(os.tmpdir(), 'nap-udd-test-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  const cfg = { browser: { userDataDir: tmp } };
  try {
    const a = resolveUserDataDir(cfg, 'chrome', null);
    eq('第一次用 → 用基础目录本身', a.dir, tmp);
    eq('  并要求打上归属标记', a.bind, 'chrome');

    // 打上标记（模拟一次成功启动）
    fs.writeFileSync(path.join(tmp, '.browser-id.json'), JSON.stringify({ id: 'chrome' }));

    const b = resolveUserDataDir(cfg, 'chrome', null);
    eq('同一个浏览器再来 → 还是用基础目录', b.dir, tmp);
    eq('  不需要重复打标记', b.bind, null);

    const c = resolveUserDataDir(cfg, 'msedge', null);
    eq('换浏览器 → 另开一份（不碰 Chrome 的登录态）', c.dir, tmp + '-msedge');

    const d = resolveUserDataDir(cfg, 'chrome', tmp + '-forced');
    eq('外部显式指定目录时直接用它', d.dir, path.resolve(tmp + '-forced'));

    // ★ planUserDataDir 只算不建 —— 只读命令（cli browsers）用它，不该在你硬盘上建目录
    const ghost = path.join(tmp, 'should-not-be-created');
    const p = planUserDataDir({ browser: { userDataDir: ghost } }, 'msedge', null);
    eq('planUserDataDir 算出的目录是对的', p.dir, ghost);
    eq('  但它没有把目录建出来', fs.existsSync(ghost), false);
    const r = resolveUserDataDir({ browser: { userDataDir: ghost } }, 'msedge', null);
    eq('resolveUserDataDir 会真的建出来', fs.existsSync(r.dir), true);
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(tmp + '-msedge', { recursive: true, force: true });
      fs.rmSync(path.resolve(tmp + '-forced'), { recursive: true, force: true });
    } catch (_) {}
  }
}

/* ---------------- 7. 这台机器上真实的落地校验 ---------------- */
section('⑦ 真实磁盘校验（这台机器）');
{
  const real = detect.detectInstalled();
  ok(`本机认出来 ${real.length} 个浏览器：${real.map((d) => d.name).join('、') || '(一个都没有)'}`, real.length >= 1);
  const chrome = real.find((d) => d.id === 'chrome');
  const edge = real.find((d) => d.id === 'msedge');
  ok('本机 Chrome / Edge 至少有一个（Win10+ 一般都有 Edge）', !!chrome || !!edge);
  if (real.length) {
    const chain = detect.buildChain({ browser: { channel: 'auto' } }, real, { available: true, candidate: { id: 'builtin', name: '内置' } });
    eq('真机上的候选链 = 认出来的 + 内置兜底', chain.length, real.length + 1);
    ok('链条第一档就是最优选择', !!chain[0]);
  }
}

/* ---------------- 8. tools 里的调用点写法（静态检查） ---------------- */
section('⑧ tools 里 openBrowser 的调用点都得解构');
{
  // ★ 为什么要有这条：openBrowser 返回的是 { ctx, cfg, logger }。
  //   写成 `const ctx = await openBrowser(...)` 拿到的是那个包装对象，
  //   后面 ctx.pages() 就会报 "ctx.pages is not a function"。
  //   语法检查抓不到（合法 JS），只有真跑才会炸 —— 所以在这里静态钉住。
  const TOOLS_DIR = path.join(__dirname, '..', 'tools');
  const bad = [];
  const callers = [];
  for (const f of fs.readdirSync(TOOLS_DIR)) {
    if (!f.endsWith('.js') || f === '_shared.js') continue;
    const src = fs.readFileSync(path.join(TOOLS_DIR, f), 'utf8');
    // 去掉注释行，避免文档里的示例被误判
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');
    if (!/await openBrowser\(/.test(code)) continue;
    callers.push(f);
    if (/const\s+ctx\s*=\s*await\s+openBrowser\(/.test(code)) bad.push(f);
  }
  ok(`有 ${callers.length} 个脚本在用 openBrowser`, callers.length >= 8);
  eq('没有"忘了解构"的调用点', bad.join('、'), '');
}

console.log(`\n————————————\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
