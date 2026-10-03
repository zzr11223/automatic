/**
 * 浏览器启动：自动挑一个能用的浏览器，持久化用户目录，登录一次之后长期免登。
 *
 * ★ 2026-10-03 改造：不再写死 Google Chrome。
 *
 *   启动顺序（`browser.channel: "auto"` 时）：
 *     ① browser.executablePath（手填的 exe，给 360/QQ 这类浏览器用）
 *     ② browser.channel（显式指定 chrome / msedge / …）
 *     ③ 自动认出来的系统浏览器，按下面这个优先级：
 *        Chrome → Edge → Brave → Vivaldi → Opera → 360极速 → 360安全
 *        → QQ → 搜狗 → 2345 → 猎豹 → 遨游
 *     ④ playwright 自带内核（本机已下载，最后的保险）
 *
 *   每一档失败都会自动试下一档并把原因打出来 —— 某一档不可用不该让整个工具用不了。
 *
 * ★ 登录态目录按浏览器分开
 *   不同浏览器的 profile 格式不完全一样，混用同一个目录可能把登录态搞坏。
 *   规则：`browser.userDataDir` 这份目录由"第一个成功启动的浏览器"占用
 *   （目录里写一个 .browser-id.json 记着是谁在用），之后换浏览器就用
 *   `<userDataDir>-<浏览器id>`。这样既保住了你现有的登录态，又不会互相污染。
 */
const fs = require('fs');
const path = require('path');
const { chromium, firefox } = require('playwright-core');
const { resolvePath, ensureDir, createLogger } = require('./util');
const detect = require('./browser-detect');

/** 支持的引擎。默认 chromium —— Firefox 只是"尽力而为"，没实测过，见文档 */
const ENGINES = { chromium, firefox };

/** 仅 Chromium 认这些参数 */
const CHROMIUM_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-infobars',
  '--no-default-browser-check',
  '--disable-features=IsolateOrigins,site-per-process',
];

const ID_FILE = '.browser-id.json';

/**
 * 下载自带内核的命令。
 *
 * ★ 必须是 `playwright-core`，不是 `playwright` ——
 *   本项目的依赖只有 playwright-core（package.json 里就这一个），
 *   写成 `npx playwright ...` 会让 npx 去临时下载另一个包，慢且容易让人困惑。
 */
function installCommand(engineName) {
  return `npx playwright-core install ${engineName === 'firefox' ? 'firefox' : 'chromium'}`;
}

/**
 * playwright 自带的内核在哪、下载了没有。
 * （`executablePath()` 即使没下载也会返回一个路径，所以要再 existsSync 一下）
 */
function builtinInfo(engineName) {
  const engine = ENGINES[engineName];
  const label = engineName === 'firefox' ? 'Playwright 自带 Firefox' : 'Playwright 自带 Chromium';
  let p = '';
  try {
    p = engine.executablePath();
  } catch (_) {
    return { available: false, name: label, path: '' };
  }
  const available = !!p && fs.existsSync(p);
  return {
    available,
    name: available ? label : `${label}（未下载）`,
    path: p,
    candidate: {
      id: 'builtin',
      name: label,
      engine: engineName,
      executablePath: p,
      via: '内置内核',
    },
  };
}

/**
 * 算出这次用哪个登录态目录。
 * @returns {{dir:string, bind:string|null, note:string}}
 */
function resolveUserDataDir(cfg, browserId, override) {
  if (override) return { dir: ensureDir(resolvePath(override)), bind: null, note: '（外部指定）' };

  const p = planUserDataDir(cfg, browserId);
  return { ...p, dir: ensureDir(p.dir) };
}

/**
 * 只"算"这次会用哪个登录态目录，**不创建它**。
 *
 * 给只读的展示命令用（`cli browsers` / 自检报告）——
 * 一个"看看有什么"的命令不该顺手在你的硬盘上建目录。
 */
function planUserDataDir(cfg, browserId, override) {
  if (override) return { dir: resolvePath(override), bind: null, note: '（外部指定）' };

  const base = resolvePath(cfg.browser.userDataDir || 'userdata');
  const marker = path.join(base, ID_FILE);

  let bound = null;
  try {
    bound = JSON.parse(fs.readFileSync(marker, 'utf8')).id || null;
  } catch (_) {
    bound = null;
  }

  if (bound === browserId) return { dir: base, bind: null, note: `（沿用 ${browserId} 的登录态）` };

  if (!bound) {
    // 第一次用（或这个目录是以前的老版本建的、还没打过标记）→ 绑定给这次用的浏览器。
    // 这样"老用户直接升级"不会丢掉已有登录态。
    return { dir: base, bind: browserId, note: '（首次绑定登录态目录）' };
  }

  // 已经属于别的浏览器了 → 各用各的，避免 profile 互相污染
  return {
    dir: `${base}-${browserId}`,
    bind: null,
    note: `（${base} 里是 ${bound} 的登录态，本浏览器另用一份）`,
  };
}

function writeMarker(dir, browserId) {
  try {
    fs.writeFileSync(path.join(dir, ID_FILE), JSON.stringify({ id: browserId, at: new Date().toISOString() }, null, 2), 'utf8');
  } catch (_) {
    /* 打标记失败不影响使用 */
  }
}

function buildLaunchOptions(cand, base, engineName) {
  const opts = { ...base };
  if (engineName !== 'chromium') {
    // Firefox 不认 Chromium 的参数，传了会报错
    delete opts.args;
    delete opts.ignoreDefaultArgs;
  }
  if (cand.channel) opts.channel = cand.channel;
  if (cand.executablePath) opts.executablePath = cand.executablePath;
  return opts;
}

/**
 * 「一个可用浏览器都没有」时的报错文案。
 *
 * ★ 提成纯函数（不是内联在 launch 里）是为了能离线单测 —— 这段文字是用户唯一的线索，
 *   "文案里有没有给出下一步"必须能被断言住，不然改着改着就退化成一句 raw 报错。
 */
function noBrowserMessage({ all, builtin, engineName, cfg }) {
  const installCmd = installCommand(engineName);
  return [
    '没找到任何可用的浏览器。', '',
    `本机装了的（我认出来的）：${describeAll(all)}`,
    `playwright 自带内核：${builtin.available ? '已下载' : '未下载'}`,
    '', '怎么办（任选一条）：',
    '  1. 装一个 Chrome 或 Edge（Edge 在 Win10/11 上是自带的，一般不用装）',
    `  2. 让脚本下载自带内核，在本目录执行：${installCmd}`,
    '  3. 如果你用的是 360 / QQ 这类浏览器，把它的 exe 完整路径填到 config.json 的',
    '     browser.executablePath 里（右键浏览器图标 → 属性 → 目标），例如：',
    '     "C:\\\\Program Files (x86)\\\\360\\\\360Chrome\\\\Chrome\\\\Application\\\\360chrome.exe"',
    '', '想看这台机器上到底有哪些浏览器：node src\\\\cli.js browsers',
  ].join('\n');
}

/**
 * 「候选全都启动失败」时的报错文案。同样提出来是为了可测。
 */
function allFailedMessage({ tried, lastErr, engineName, cfg }) {
  const installCmd = installCommand(engineName);
  return [
    '浏览器都启动不了。挨个试过：', ...tried.map((t) => '  · ' + t), '',
    `最后一次的原始错误：${lastErr ? lastErr.message : '(无)'}`, '', '常见原因：',
    '  1. 那个浏览器正开着、占用了登录态目录 → 先把它关掉再试',
    `  2. 自带内核没下载 → 在本目录执行：${installCmd}`,
    `  3. 登录态目录权限有问题 → 删掉 ${resolvePath(cfg.browser.userDataDir || 'userdata')} 再试（会需要重新登录一次）`,
    '', '想看这台机器上到底有哪些浏览器：node src\\cli.js browsers',
  ].join('\n');
}

/**
 * 启动浏览器（失败会自动换下一个候选）。
 *
 * @param {object} cfg  配置
 * @param {object} [opt] { headless, logger, userDataDir }
 */
async function launch(cfg, { headless = null, logger = createLogger(), userDataDir = null } = {}) {
  const engineName = String((cfg.browser && cfg.browser.engine) || 'chromium').toLowerCase();
  const engine = ENGINES[engineName];
  if (!engine) {
    throw new Error(
      `config.json 里 browser.engine 填的是「${engineName}」，不认识。只能填 chromium 或 firefox。\n` +
        '（一般保持 chromium 就好 —— Chrome、Edge、Brave、360、QQ 浏览器这些全是 Chromium 内核）'
    );
  }
  if (engineName === 'firefox') {
    logger.warn('browser.engine = firefox：这条通道是尽力而为，没有实测过。');
    logger.warn('  如果发布过程出问题，请把 config.json 改回 "chromium"。');
  }

  // ---- 挑候选 ----
  const all = detect.detectInstalled();
  const detected = all.filter((d) => (d.engine || 'chromium') === engineName);
  const builtin = builtinInfo(engineName);
  const chain = detect.buildChain(cfg, detected, builtin);

  if (!chain.length) {
    throw new Error(noBrowserMessage({ all, builtin, engineName, cfg }));
  }

  const base = {
    headless: headless === null ? !!cfg.browser.headless : headless,
    viewport: cfg.browser.viewport,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    slowMo: cfg.browser.slowMoMs || 0,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [...CHROMIUM_ARGS],
  };

  let lastErr = null;
  const tried = [];
  for (const cand of chain) {
    const udd = resolveUserDataDir(cfg, cand.id, userDataDir);
    try {
      const ctx = await engine.launchPersistentContext(udd.dir, buildLaunchOptions(cand, base, engineName));
      await ctx.addInitScript(() => {
        try {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] });
          Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        } catch (_) {}
      });
      ctx.setDefaultTimeout(30000);
      ctx.setDefaultNavigationTimeout(60000);
      if (udd.bind) writeMarker(udd.dir, udd.bind);

      logger.ok(`浏览器已启动：${cand.name}${cand.via ? '，' + cand.via : ''}`);
      logger.info(`  登录态目录：${udd.dir} ${udd.note}`);
      if (tried.length) {
        logger.warn(`  （前面 ${tried.length} 个候选不能用，已自动换到这个：${tried.join('、')}）`);
      }
      return ctx;
    } catch (e) {
      const msg = String(e.message).split('\n')[0];
      lastErr = e;
      tried.push(`${cand.name}（${msg}）`);
      logger.warn(`用「${cand.name}」启动失败：${msg}`);
    }
  }

  // 全挂了的兜底：给最实用的建议
  throw new Error(allFailedMessage({ tried, lastErr, engineName, cfg }));
}

function describeAll(list) {
  if (!list || !list.length) return '（一个都没认出来）';
  return list.map((d) => d.name).join('、');
}

/**
 * 给 `cli browsers` / 自检报告用：这台机器上有哪些浏览器、默认会用哪个、内置内核在不在。
 */
function inspect(cfg) {
  const all = detect.detectInstalled();
  const engineName = String((cfg.browser && cfg.browser.engine) || 'chromium').toLowerCase();
  const detected = all.filter((d) => (d.engine || 'chromium') === engineName);
  const builtin = builtinInfo(engineName);
  const chain = detect.buildChain(cfg, detected, builtin);

  let deep = [];
  let deepRan = false;
  return {
    engine: engineName,
    all,
    detected,
    builtin,
    chain,
    get deep() {
      if (!deepRan) {
        deepRan = true;
        try {
          const scanned = detect.deepScan();
          const ids = new Set(all.map((d) => d.id));
          deep = scanned.filter((s) => !ids.has(s.id));
        } catch (_) {
          deep = [];
        }
      }
      return deep;
    },
  };
}

async function getPage(ctx) {
  const pages = ctx.pages();
  if (pages.length) return pages[0];
  return await ctx.newPage();
}

module.exports = {
  launch,
  getPage,
  inspect,
  ENGINES,
  builtinInfo,
  resolveUserDataDir,
  planUserDataDir,
  noBrowserMessage,
  allFailedMessage,
  installCommand,
};
