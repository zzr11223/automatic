/**
 * 浏览器探测：找出这台机器上能用哪些浏览器，并排出一个"依次尝试"的顺序。
 *
 * ★ 为什么要有这个文件
 *   原来代码里写死 `channel: 'chrome'`，没装 Chrome 的机器就跑不起来（或者被迫退回
 *   自带内核）。实际用户可能是 Edge、Brave、360、QQ 浏览器……
 *   这里把"找浏览器"这件事独立出来，且**不依赖 playwright**（纯文件系统判断），
 *   所以可以离线单测（见 tools/test-browser-detect.js）。
 *
 * ★ 为什么不用注册表
 *   注册表（`App Paths` / `StartMenuInternet`）是更权威的来源，但本机 `reg.exe`
 *   被安全策略拦掉了，而且跨机器读注册表也不如"查文件在不在"稳定可测。
 *   兜底手段是慢速目录扫描（`deepScan`）+ 配置里手填 `browser.executablePath`。
 *
 * ★ 只支持 Chromium 内核
 *   并不是"技术上不能启动 Firefox"（playwright 支持），而是本工具和番茄编辑器的
 *   交互全是按 Chromium 调的：富文本填充、Arco 组件点击、`--disable-blink-features`
 *   这类反检测开关都是 Chromium 专有。所以 Firefox 只做"尽力而为"的通道，
 *   默认不走（见 src/browser.js 的 engine 处理）。
 */
const path = require('path');

/**
 * 已知的 Chromium 内核浏览器。
 *
 * - `channel`：playwright 官方支持的启动通道（由 playwright 自己解析安装路径，最稳）
 * - `exe`：用于"这台机器装没装"的判断，以及给没有 channel 的浏览器做 executablePath
 * - 数组顺序 = `browser.channel: "auto"` 时的优先级
 */
const KNOWN_BROWSERS = [
  {
    id: 'chrome',
    name: 'Google Chrome',
    channel: 'chrome',
    exe: [
      '%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe',
      '%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe',
      '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe',
    ],
  },
  {
    id: 'msedge',
    name: 'Microsoft Edge',
    channel: 'msedge',
    exe: [
      '%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe',
      '%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe',
      '%LOCALAPPDATA%\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
  },
  {
    id: 'brave',
    name: 'Brave',
    exe: [
      '%ProgramFiles%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      '%ProgramFiles(x86)%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      '%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ],
  },
  {
    id: 'vivaldi',
    name: 'Vivaldi',
    exe: [
      '%LOCALAPPDATA%\\Vivaldi\\Application\\vivaldi.exe',
      '%ProgramFiles%\\Vivaldi\\Application\\vivaldi.exe',
    ],
  },
  {
    id: 'opera',
    name: 'Opera',
    exe: [
      '%LOCALAPPDATA%\\Programs\\Opera\\opera.exe',
      '%LOCALAPPDATA%\\Programs\\Opera GX\\opera.exe',
      '%ProgramFiles%\\Opera\\opera.exe',
    ],
  },
  {
    id: '360x',
    name: '360 极速浏览器',
    exe: [
      '%LOCALAPPDATA%\\360ChromeX\\Chrome\\Application\\360ChromeX.exe',
      '%ProgramFiles(x86)%\\360\\360ChromeX\\Chrome\\Application\\360ChromeX.exe',
    ],
  },
  {
    id: '360se',
    name: '360 安全浏览器',
    exe: [
      '%LOCALAPPDATA%\\360Chrome\\Chrome\\Application\\360chrome.exe',
      '%ProgramFiles(x86)%\\360\\360Chrome\\Chrome\\Application\\360chrome.exe',
      '%ProgramFiles(x86)%\\360\\360se6\\Application\\360se.exe',
    ],
  },
  {
    id: 'qq',
    name: 'QQ 浏览器',
    exe: [
      '%LOCALAPPDATA%\\Tencent\\QQBrowser\\Application\\QQBrowser.exe',
      '%ProgramFiles(x86)%\\Tencent\\QQBrowser\\QQBrowser.exe',
    ],
  },
  {
    id: 'sogou',
    name: '搜狗高速浏览器',
    exe: [
      '%LOCALAPPDATA%\\SogouExplorer\\SogouExplorer.exe',
      '%ProgramFiles(x86)%\\SogouExplorer\\SogouExplorer.exe',
    ],
  },
  {
    id: '2345',
    name: '2345 加速浏览器',
    exe: [
      '%LOCALAPPDATA%\\2345Explorer\\2345Explorer.exe',
      '%ProgramFiles(x86)%\\2345Explorer\\2345Explorer.exe',
    ],
  },
  {
    id: 'liebao',
    name: '猎豹浏览器',
    exe: [
      '%LOCALAPPDATA%\\liebao\\liebao.exe',
      '%ProgramFiles(x86)%\\liebao\\liebao.exe',
    ],
  },
  {
    id: 'maxthon',
    name: '遨游浏览器',
    exe: [
      '%LOCALAPPDATA%\\Maxthon\\Application\\Maxthon.exe',
      '%ProgramFiles(x86)%\\Maxthon\\Application\\Maxthon.exe',
    ],
  },
  {
    // 非 Chromium 内核。仅当 config.json 里 browser.engine = "firefox" 时才会被使用。
    // ★ 没有 `channel`：playwright 的 firefox 通道不走 channel，只能用 executablePath。
    id: 'firefox',
    name: 'Mozilla Firefox',
    engine: 'firefox',
    exe: [
      '%ProgramFiles%\\Mozilla Firefox\\firefox.exe',
      '%ProgramFiles(x86)%\\Mozilla Firefox\\firefox.exe',
      '%LOCALAPPDATA%\\Mozilla Firefox\\firefox.exe',
    ],
  },
];

/** exe 文件名 → 浏览器 id。慢速目录扫描时用这个反查 */
const EXE_INDEX = {
  'chrome.exe': 'chrome',
  'msedge.exe': 'msedge',
  'brave.exe': 'brave',
  'vivaldi.exe': 'vivaldi',
  'opera.exe': 'opera',
  '360chromex.exe': '360x',
  '360chrome.exe': '360se',
  '360se.exe': '360se',
  'qqbrowser.exe': 'qq',
  'sogouexplorer.exe': 'sogou',
  '2345explorer.exe': '2345',
  'liebao.exe': 'liebao',
  'maxthon.exe': 'maxthon',
  'firefox.exe': 'firefox',
};

/** 慢速扫描要跳过的目录名（纯噪音，扫了浪费时间） */
const SCAN_SKIP = new Set([
  'node_modules', '$recycle.bin', 'system volume information', 'windows',
  'winsxs', 'temp', 'tmp', 'cache', 'logs', 'log', 'wersvc', 'driverstore',
]);

/** 把 %VAR% 展开；展开不了就原样留着（调用方 exists 会返回 false，不会误判） */
function expandEnv(p, env) {
  return String(p).replace(/%([^%]+)%/g, (m, name) => {
    const v = env && env[name];
    return v === undefined || v === '' ? m : v;
  });
}

function realExists(exists, p) {
  try {
    return !!exists(p);
  } catch (_) {
    return false;
  }
}

/**
 * 快速探测：只查已知路径（约 40 次 existsSync，毫秒级）。每次启动都会跑这个。
 *
 * @param {object} [env] 环境变量表，默认 process.env
 * @param {Function} [exists] 存在性判断，默认 fs.existsSync（注入便于单测）
 * @returns {Array<{id,name,channel?,executablePath,via:'known-path'}>}
 */
function detectInstalled(env = process.env, exists = require('fs').existsSync) {
  const out = [];
  for (const b of KNOWN_BROWSERS) {
    for (const raw of b.exe) {
      const p = expandEnv(raw, env);
      if (p.includes('%')) continue; // 环境变量没展开，这条路径无效
      if (!realExists(exists, p)) continue;
      out.push({
        id: b.id,
        name: b.name,
        engine: b.engine || 'chromium',
        channel: b.channel, // chrome / msedge 有；其他没有 → 用 executablePath
        executablePath: p,
        via: 'known-path',
      });
      break; // 同一浏览器命中一条就够
    }
  }
  return out;
}

/**
 * 慢速扫描：按 exe 名字在几个常见安装根目录里翻（深度有限、节点数有上限）。
 *
 * 什么时候用：① `node src/cli.js browsers` 想给一份完整清单
 *            ② 快速探测一个都没找到，再努力一把
 * 每次启动都跑会明显变慢，所以**不要**放进常规路径。
 *
 * @param {object} [opt] { env, exists, readdir, maxDepth, budget }
 */
function deepScan(opt = {}) {
  const env = opt.env || process.env;
  const fs = require('fs');
  const exists = opt.exists || fs.existsSync;
  const readdir = opt.readdir || ((p) => fs.readdirSync(p, { withFileTypes: true }));
  const maxDepth = opt.maxDepth == null ? 3 : opt.maxDepth;
  let budget = opt.budget == null ? 30000 : opt.budget; // 最多看 3 万个目录项

  const roots = [
    env['ProgramFiles'],
    env['ProgramFiles(x86)'],
    env['LOCALAPPDATA'],
    env['LOCALAPPDATA'] ? path.join(env['LOCALAPPDATA'], 'Programs') : null,
    env['ProgramW6432'],
  ].filter(Boolean);

  const found = {};
  const walk = (dir, depth) => {
    if (budget <= 0 || depth > maxDepth) return;
    let items;
    try {
      items = readdir(dir);
    } catch (_) {
      return;
    }
    for (const it of items) {
      if (budget-- <= 0) return;
      const name = String(it.name || '');
      const full = path.join(dir, name);
      if (it.isDirectory && it.isDirectory()) {
        if (SCAN_SKIP.has(name.toLowerCase())) continue;
        walk(full, depth + 1);
        continue;
      }
      const id = EXE_INDEX[name.toLowerCase()];
      if (id && !found[id] && realExists(exists, full)) {
        found[id] = { id, name: name, executablePath: full, via: 'deep-scan' };
      }
    }
  };

  for (const r of roots) {
    if (budget <= 0) break;
    if (realExists(exists, r)) walk(r, 0);
  }

  // 补上正式名字 + channel
  return Object.values(found).map((f) => {
    const def = KNOWN_BROWSERS.find((b) => b.id === f.id);
    return {
      id: f.id,
      name: def ? def.name : f.name,
      engine: def ? def.engine || 'chromium' : 'chromium',
      channel: def ? def.channel : undefined,
      executablePath: f.executablePath,
      via: f.via,
    };
  });
}

/**
 * 排"依次尝试"的顺序。
 *
 * 顺序 = ① 用户手填的 exe ② 用户指定的 channel ③ 自动认出来的（按 KNOWN_BROWSERS 顺序）
 *        ④ playwright 自带内核
 *
 * ★ 显式指定只是**优先**，后面仍然会兜底 —— 配置写错一个字不该让整个工具用不了。
 */
function buildChain(cfg, detected, builtin) {
  const b = (cfg && cfg.browser) || {};
  const list = detected || [];
  const chain = [];
  const seen = new Set();

  const push = (item) => {
    if (!item) return;
    const key = item.channel ? 'ch:' + item.channel : 'exe:' + (item.executablePath || item.id);
    if (seen.has(key)) return;
    seen.add(key);
    chain.push(item);
  };

  // ① 用户手填的 exe（最高优先级，用于 360/QQ 这类没有 channel 的浏览器）
  const wantExe = String(b.executablePath || '').trim();
  if (wantExe) {
    push({ id: 'custom', name: `指定的浏览器（${path.basename(wantExe)}）`, executablePath: wantExe, via: 'config' });
  }

  // ② 用户指定的 channel（chrome / msedge / chrome-beta / msedge-beta …）
  const want = String(b.channel || 'auto').trim();
  const wantLower = want.toLowerCase();
  const isAuto = !want || wantLower === 'auto';
  if (!isAuto) {
    push({ id: wantLower, name: `指定的 ${want}`, channel: want, via: 'config' });
  }

  // ③ 自动认出来的
  for (const d of list) {
    push({
      id: d.id,
      name: d.name,
      engine: d.engine || 'chromium',
      channel: d.channel,
      executablePath: d.channel ? undefined : d.executablePath,
      via: d.channel ? `系统已安装（${d.name}）` : `系统已安装（${d.name}，按路径启动）`,
    });
  }

  // ④ 自带内核兜底
  if (builtin && builtin.available) push(builtin.candidate);

  return chain;
}

/** 取某个浏览器在已探测列表里的信息 */
function findById(detected, id) {
  return (detected || []).find((d) => d.id === id) || null;
}

module.exports = {
  KNOWN_BROWSERS,
  EXE_INDEX,
  SCAN_SKIP,
  expandEnv,
  detectInstalled,
  deepScan,
  buildChain,
  findById,
};
