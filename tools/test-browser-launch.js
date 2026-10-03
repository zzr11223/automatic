/**
 * 浏览器启动链路自测：验证"自动挑浏览器 + 逐个回退"这套逻辑真的能跑起来。
 *
 * 为什么单独测这个：探测逻辑（test-browser-detect.js）只能证明"我算出来的候选清单是对的"，
 * 证明不了"拿这份清单去 launch 真能起来"。两者是两回事 —— 探测全绿但一启动就崩的情况
 * 完全可能（playwright 版本不支持某个 channel、exe 路径失效…）。
 *
 * 用无头模式跑，不会弹窗口。全程只启动 + 打开一个空白页，不碰番茄。
 *
 * ★ 登录态目录：只有第 ① 节用正式配置（也就是会碰 `userdata`，但每个浏览器只复用不新建）；
 *   其余几节都改用系统临时目录，**不会在你的项目里堆出 userdata-msedge 之类的空 profile**。
 *   跑完自动删掉临时目录。
 *
 * 跑法：node tools\test-browser-launch.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require(path.join(__dirname, '..', 'src', 'config'));
const { createLogger } = require(path.join(__dirname, '..', 'src', 'util'));
const { launch, inspect } = require(path.join(__dirname, '..', 'src', 'browser'));

/** 临时登录态根目录 —— 其余几节都往这里写，跑完删掉 */
const TMP_UDD = path.join(os.tmpdir(), 'nap-launch-test-' + Date.now());

function tmpCfg(baseCfg) {
  const c = JSON.parse(JSON.stringify(baseCfg));
  c.browser.userDataDir = TMP_UDD;
  return c;
}

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}${extra ? '   ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${extra ? '   → ' + extra : ''}`);
  }
}
function section(t) {
  console.log(`\n【${t}】`);
}

/** 起一次浏览器，拿到"实际用了谁"，然后立刻关掉 */
async function tryLaunch(cfg, label) {
  const logger = createLogger('launch-test');
  const lines = [];
  const spy = {
    info: (m) => lines.push('I ' + m),
    ok: (m) => lines.push('OK ' + m),
    warn: (m) => lines.push('W ' + m),
    error: (m) => lines.push('E ' + m),
    step: (m) => lines.push('S ' + m),
    fail: (m) => lines.push('F ' + m),
  };
  const quiet = { ...logger, ...spy };

  try {
    const ctx = await launch(cfg, { headless: true, logger: quiet });
    const who = (lines.find((l) => l.startsWith('OK 浏览器已启动')) || '').replace('OK 浏览器已启动：', '');
    const page = await ctx.newPage();
    await page.goto('about:blank');
    await ctx.close();
    return { ok: true, who: who.split('，')[0], lines };
  } catch (e) {
    return { ok: false, err: String(e.message), lines };
  }
}

const baseCfg = loadConfig();

(async () => {
  console.log('浏览器启动链路自测（无头模式，不会弹窗口）');

  /* ---------------- 0. 先把探测结果打出来 ---------------- */
  section('⓪ 探测结果（决定下面拿什么去启动）');
  const info = inspect(baseCfg);
  console.log(`  引擎：${info.engine}`);
  console.log(`  认出来的浏览器：${info.detected.map((d) => d.name).join('、') || '(无)'}`);
  console.log(`  自带内核：${info.builtin.available ? '已下载' : '未下载'}`);
  console.log(`  候选顺序：${info.chain.map((c) => c.name).join(' → ') || '(空)'}`);
  ok('至少有一个候选可以试', info.chain.length > 0);

  /* ---------------- 1. auto：应该用最优的那个 ---------------- */
  section('① auto 模式：直接启动');
  {
    const cfg = JSON.parse(JSON.stringify(baseCfg));
    cfg.browser.channel = 'auto';
    delete cfg.browser.executablePath;
    const r = await tryLaunch(cfg, 'auto');
    ok('能启动', r.ok, r.ok ? `实际用了：${r.who}` : r.err.split('\n')[0]);
    if (r.ok && info.chain.length) {
      ok('用的就是候选链的第一档', r.who === info.chain[0].name, `期望「${info.chain[0].name}」，实际「${r.who}」`);
    }
  }

  /* ---------------- 2. 依次验证每个候选都能起来 ---------------- */
  section('② 逐个候选：每一个都要真能启动');
  for (const cand of info.chain) {
    // 内置内核没下载时不算"故障"，跳过（它只是最后的保险）
    if (cand.id === 'builtin' && !info.builtin.available) continue;
    const cfg = tmpCfg(baseCfg);
    cfg.browser.channel = 'auto';
    cfg.browser.executablePath = '';
    // 精确指向这一个候选
    if (cand.channel) cfg.browser.channel = cand.channel;
    else if (cand.executablePath) cfg.browser.executablePath = cand.executablePath;

    const r = await tryLaunch(cfg, cand.name);
    // ★ 关键：不能只看 r.ok —— 它失败了会自动换下一档，那样 r.ok 也是 true。
    //   必须确认"第一档就成功了"（日志里没有"启动失败"）。
    const fellBack = r.lines.some((l) => /启动失败/.test(l));
    ok(`「${cand.name}」能启动`, r.ok, r.ok ? `实际用了：${r.who}` : r.err.split('\n')[0]);
    if (r.ok) {
      ok(`  是它自己起的，不是靠回退顶上来的`, !fellBack, fellBack ? '日志里出现了「启动失败」' : '');
    }
  }

  /* ---------------- 3. 回退：第一个用不了要自动换下一个 ---------------- */
  section('③ 回退能力：把第一档弄坏，看它会不会自动换');
  {
    const cfg = tmpCfg(baseCfg);
    cfg.browser.channel = 'auto';
    // 伪造一个不存在的 exe → 第一档必定失败
    cfg.browser.executablePath = 'C:\\这个路径不存在\\nope.exe';
    const r = await tryLaunch(cfg, 'fallback');
    ok('第一档坏掉时仍然启动成功（自动换下一个）', r.ok, r.ok ? `最终用了：${r.who}` : r.err.split('\n')[0]);
    ok('  日志里有"启动失败"的记录', r.lines.some((l) => /启动失败/.test(l)));
  }

  /* ---------------- 4. 系统浏览器全没了 → 应该退到自带内核 ---------------- */
  section('④ 系统浏览器全认不出来时 → 应该退到自带内核继续干活');
  {
    const cfg = tmpCfg(baseCfg);
    cfg.browser.channel = 'auto';
    cfg.browser.executablePath = '';
    const detMod = require(path.join(__dirname, '..', 'src', 'browser-detect'));
    const orig = detMod.detectInstalled;
    detMod.detectInstalled = () => []; // 模拟"一个系统浏览器都没装"
    try {
      const r = await tryLaunch(cfg, 'only-builtin');
      if (info.builtin.available) {
        ok('没有系统浏览器时，靠自带内核也能启动（能自愈）', r.ok, r.ok ? `实际用了：${r.who}` : r.err.split('\n')[0]);
        ok('  用的确实是内置内核', r.ok && /内置|Chromium/.test(r.who), r.who);
      } else {
        ok('没有系统浏览器、自带内核也没下载 → 明确失败', !r.ok);
      }
    } finally {
      detMod.detectInstalled = orig;
    }
  }

  /* ---------------- 5. 报错文案（离线断言，不启动浏览器） ---------------- */
  section('⑤ 两段兜底报错：文案里必须有"下一步怎么做"');
  {
    const { noBrowserMessage, allFailedMessage } = require(path.join(__dirname, '..', 'src', 'browser'));
    const m1 = noBrowserMessage({
      all: [],
      builtin: { available: false },
      engineName: 'chromium',
      cfg: { browser: { userDataDir: 'userdata' } },
    });
    ok('「没有可用浏览器」说清了现状', /没找到任何可用的浏览器/.test(m1));
    ok('  给了三条可执行的出路', /装一个 Chrome 或 Edge/.test(m1) && /npx playwright-core install/.test(m1) && /executablePath/.test(m1));
    ok('  指向了 browsers 命令', /cli\.js browsers/.test(m1));
    ok('  提到 360/QQ 这类国产浏览器怎么办', /360 /.test(m1) || /360\\/.test(m1));

    const m1ff = noBrowserMessage({
      all: [],
      builtin: { available: false },
      engineName: 'firefox',
      cfg: { browser: { userDataDir: 'userdata' } },
    });
    ok('engine=firefox 时不会建议装 chromium（避免指错路）', /playwright-core install firefox/.test(m1ff) && !/install chromium/.test(m1ff));

    const m2 = allFailedMessage({
      tried: ['Google Chrome（spawn 失败）'],
      lastErr: new Error('boom'),
      engineName: 'chromium',
      cfg: { browser: { userDataDir: 'userdata' } },
    });
    ok('「全都启动失败」列出了试过哪些', /挨个试过/.test(m2) && /Google Chrome/.test(m2));
    ok('  保留了原始错误（便于排查）', /boom/.test(m2));
    ok('  讲了最常见的三个原因', /占用了登录态目录/.test(m2) && /npx playwright-core install/.test(m2) && /权限/.test(m2));
  }

  /* ---------------- 6. engine 写错时的提示 ---------------- */
  section('⑥ 配置写错：不能让用户看到一句内部报错');
  {
    const cfg = JSON.parse(JSON.stringify(baseCfg));
    cfg.browser.engine = 'safari';
    const r = await tryLaunch(cfg, 'bad-engine');
    ok('engine 写错时明确失败', !r.ok);
    if (!r.ok) {
      ok('  报错里说清楚了只能填什么', /chromium/.test(r.err) && /firefox/.test(r.err));
    }
  }

  /* ---------------- 7. firefox：没下载时要给可执行的指引 ---------------- */
  section('⑦ firefox 通道（本机没下载的话，要给出下载指引）');
  {
    const cfg = tmpCfg(baseCfg);
    cfg.browser.engine = 'firefox';
    cfg.browser.executablePath = '';
    const r = await tryLaunch(cfg, 'firefox');
    if (r.ok) {
      ok('Firefox 也能启动', true, `实际用了：${r.who}`);
      console.log('     （注意：Firefox 通道没做过端到端发布验证，只是"能起来"）');
    } else {
      const first = r.err.split('\n')[0];
      ok('启动失败时给出了可执行的指引（而不是一句 raw 报错）', /npx playwright-core install|装一个|executablePath|浏览器都启动不了|没找到任何可用/.test(r.err), first);
    }
  }

  /* ---------------- 8. 安装命令必须指向 playwright-core ---------------- */
  section('⑧ 下载内核的命令：必须是 playwright-core（本项目的依赖）');
  {
    const { installCommand } = require(path.join(__dirname, '..', 'src', 'browser'));
    const c1 = installCommand('chromium');
    const c2 = installCommand('firefox');
    ok('chromium → npx playwright-core install chromium', c1 === 'npx playwright-core install chromium', c1);
    ok('firefox  → npx playwright-core install firefox', c2 === 'npx playwright-core install firefox', c2);
    ok('没传引擎名时按 chromium 处理', installCommand() === c1);
    // ★ 项目只依赖 playwright-core（package.json 里就这一个），
    //   写成 `npx playwright ...` 会让 npx 去临时下载另一个包 —— 慢，而且和"依赖已装好"的前提矛盾
    ok('不是裸的 `npx playwright`（那会去装另一个包）', !/npx playwright install/.test(c1));
  }

  // 收尾：临时登录态目录（每个候选一份空 profile，几 MB）删掉，别留在硬盘上
  try {
    fs.rmSync(TMP_UDD, { recursive: true, force: true });
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (f.startsWith(path.basename(TMP_UDD) + '-')) {
        fs.rmSync(path.join(os.tmpdir(), f), { recursive: true, force: true });
      }
    }
    console.log(`\n（临时登录态目录已清理：${TMP_UDD}*）`);
  } catch (_) {}

  console.log(`\n————————————\n通过 ${pass} 项，失败 ${fail} 项\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('自测本身出错了：' + e.message);
  process.exit(1);
});
