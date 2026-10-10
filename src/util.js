/**
 * 通用工具：日志、路径、等待
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function resolvePath(p) {
  if (!p) return ROOT;
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

const TAGS = { debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR' };

function createLogger(name = 'app') {
  const logDir = ensureDir(path.join(ROOT, 'logs'));
  const logFile = path.join(logDir, `run-${new Date().toISOString().slice(0, 10)}.log`);

  function write(level, msg) {
    const ts = new Date().toLocaleString('zh-CN', { hour12: false });
    const line = `[${ts}] [${TAGS[level]}] ${msg}`;
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
    try {
      fs.appendFileSync(logFile, line + '\n', 'utf8');
    } catch (_) {
      /* 日志写不进去不影响主流程 */
    }
  }

  return {
    debug: (m) => write('debug', m),
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
    step: (m) => write('info', '==> ' + m),
    ok: (m) => write('info', ' OK  ' + m),
    fail: (m) => write('error', 'FAIL ' + m),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** 把字符串变成安全的文件名 */
function safeFileName(s, maxLen = 50) {
  return String(s)
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

/** 去掉每行两端的空白，压缩连续空行 */
function normalizeBody(text) {
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\u3000/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 只统计正文有效字符数（不含空白） */
function countChars(text) {
  return String(text).replace(/\s/g, '').length;
}

/**
 * 剥掉章节标题里的"第X章/节/回"前缀，只留标题文字。
 *
 * 番茄编辑页是「第 [序号] 章 + 标题」两个独立输入框，
 * 所以标题框里不能带"第一章"这种前缀，否则会显示成「第17章 第一章 醒来」。
 */
function stripChapterPrefix(title) {
  return String(title)
    .replace(/^\s*第\s*[0-9０-９零〇一二三四五六七八九十百千万两]{1,8}\s*[章节回卷]\s*[：:、.．·\-—\s]*/, '')
    .trim();
}

/* ------------------------- 中文数字 ------------------------- */

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

/**
 * 中文数字 → 整数（支持 一~九、十、百、千、万 的常见组合，如 十七 / 二十三 / 一百 / 两）。
 * 解析不了返回 0。
 */
function cnNumToInt(s) {
  let total = 0;
  let section = 0;
  let cur = 0;
  for (const ch of String(s)) {
    if (CN_DIGITS[ch] !== undefined) {
      cur = CN_DIGITS[ch];
      continue;
    }
    const u = CN_UNITS[ch];
    if (u === undefined) return 0; // 出现不认识的字符，判为解析失败
    if (u === 10000) {
      section = (section + cur) * u;
      total += section;
      section = 0;
    } else {
      section += (cur || 1) * u;
    }
    cur = 0;
  }
  return total + section + cur;
}

/** 「十七」/「17」/「１７」→ 17；解析不了返回 0 */
function anyNumToInt(raw) {
  const s = String(raw || '').trim();
  if (!s) return 0;
  const half = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const n = /^[0-9]+$/.test(half) ? Number(half) : cnNumToInt(s);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 从源文件标题里解析出章节序号，如「第17章 星海归途」→ 17。
 * 解析不出来返回 0。
 *
 * 放在 util 里（不是 publisher 里）是因为 progress.js 也要用它按序号认章节，
 * 而 progress 是被 publisher 依赖的 —— 反过来 require 会变成循环依赖。
 */
function parseChapterNoFromTitle(title) {
  const m = String(title).match(
    /^\s*第\s*([0-9０-９]{1,5}|[零〇一二三四五六七八九十百千万两]{1,8})\s*[章节回]/
  );
  if (!m) return 0;
  const n = anyNumToInt(m[1]);
  return n > 0 && n < 100000 ? n : 0;
}

/**
 * 把 "--chapter 5,7,9" 这种"自选章节"描述解析成具体的章节对象列表。
 *
 * ★ 两种序号都认（和 reset 一致）：chapters/ 目录里的序号（seq）、标题里写的"第几章"。
 *   同一个数字两种都命中时，**优先按"标题里的第几章"** —— 用户嘴里说的、
 *   平台序号框里填的都是它（比如《示例书A》的 seq 1 是第17章，说 17 就该是第17章，不是 seq17）。
 *
 * @param {{chapters?: object[]}} manifest
 * @param {string} spec 逗号分隔的章号，如 "5,7,9"
 * @returns {{ picked: object[], unknown: number[] }}
 *   picked 保持 manifest 里的**书序**（发布总得按章节顺序来，不是你写的顺序），
 *   并已去重；unknown 是两个序号都对不上的数字
 */
function resolveChapterSelection(manifest, spec) {
  const list = (manifest && manifest.chapters) || [];
  const wants = String(spec || '')
    .split(',')
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  const picked = [];
  const unknown = [];
  for (const want of wants) {
    const byTitle = list.find((c) => parseChapterNoFromTitle(c.title) === want);
    const bySeq = list.find((c) => Number(c.seq) === want);
    const hit = byTitle || bySeq;
    if (!hit) {
      unknown.push(want);
      continue;
    }
    if (!picked.includes(hit)) picked.push(hit);
  }
  picked.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
  return { picked, unknown };
}

/** 定时展示文案 "YYYY-MM-DD HH:mm"（parseScheduleTime 内部也用它做规范化） */
function fmtSchedule(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * ★★ 平台硬规则（2026-10-10 实测）：定时发布的时间必须"至少半小时以后"。
 *
 * 番茄「发布设置」页填了太近的时间会被红字拦住：「请选择半小时以后的时间进行发布」
 * （输入框下面一行红字，提交按钮点不动）。与其等平台拒，不如在所有入口提前拦下：
 * 面板（server 校验 + 前端选择器）、CLI、发布前预检 —— 一处规则，处处生效。
 */
const MIN_SCHEDULE_LEAD_MS = 30 * 60 * 1000;

/**
 * 定时时刻距现在够不够"半小时以后"？
 * @returns {string} '' = 合格；否则返回人话原因（开头就是平台原话）
 */
function checkScheduleLead(date, now) {
  const base = now instanceof Date ? new Date(now.getTime()) : new Date();
  const lead = date.getTime() - base.getTime();
  if (lead >= MIN_SCHEDULE_LEAD_MS) return '';
  const mins = Math.max(0, Math.round(lead / 60000));
  return `请选择半小时以后的时间进行发布（${fmtSchedule(date)} 距现在只有 ${mins} 分钟）`;
}

/**
 * 解析"平台定时发布"的时间（用户口吻的输入 → 具体时刻）。
 *
 * 支持两种写法：
 *   · "08:00"            → **下一次** 08:00（今天还没到就是今天，过了就是明天）
 *   · "2026-10-08 08:00" → 指定日期时刻（也认 2026/10/8 08:00）
 *
 * ★ 会顺带执行平台硬规则：解析出的时刻必须"至少半小时以后"（见 checkScheduleLead），
 *   太近直接 ok:false —— 别把注定被平台拒的时间放进去跑流程。
 *
 * 为什么放 util：自检/面板都可能要先把用户的输入翻译一遍，
 * 而且这是纯函数（now 可注入），好测。
 *
 * @param {string} str 用户输入（允许前后空白）
 * @param {Date} [now] 当前时间（默认真实时间；测试注入）
 * @returns {{ok: true, date: Date, text: string} | {ok: false, reason: string}}
 *   text 是规范化后的展示文案 "YYYY-MM-DD HH:mm"
 */
function parseScheduleTime(str, now) {
  const s0 = String(str == null ? '' : str).trim();
  if (!s0) return { ok: false, reason: '定时时间是空的' };
  const base = now instanceof Date ? new Date(now.getTime()) : new Date();

  // 形态一：只有时刻 "HH:MM"（也认 8:00 / 08:05）
  let m = s0.match(/^([0-9]{1,2}):([0-9]{2})(?::[0-9]{2})?$/);
  if (m) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh > 23 || mm > 59) return { ok: false, reason: `时刻 ${s0} 不合法（小时 0-23，分钟 0-59）` };
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hh, mm, 0, 0);
    // 今天这个时刻已经过了 → 定到明天（用户说"每天 08:00 发"，指的都是下一次 08:00）
    if (d.getTime() <= base.getTime()) d.setDate(d.getDate() + 1);
    // ★ 平台规则：必须"半小时以后"（比如 09:30 说 "09:45" 会被平台拒 —— 直接拦下，别让它白跑）
    const tooSoon1 = checkScheduleLead(d, base);
    if (tooSoon1) return { ok: false, reason: tooSoon1 };
    return { ok: true, date: d, text: fmtSchedule(d) };
  }

  // 形态二：完整日期时刻 "YYYY-MM-DD HH:MM"（分隔符 - / 都认，秒可有可无）
  m = s0.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T]+([0-9]{1,2}):([0-9]{2})(?::[0-9]{2})?$/);
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0);
    const dateOk =
      d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3];
    if (!dateOk) return { ok: false, reason: `日期 ${s0} 不存在（比如 2 月 30 日）` };
    if (+m[4] > 23 || +m[5] > 59) return { ok: false, reason: `时刻 ${s0} 不合法（小时 0-23，分钟 0-59）` };
    if (d.getTime() <= base.getTime()) {
      return { ok: false, reason: `定时时间 ${s0} 已经过去了（现在 ${fmtSchedule(base)}）—— 要定到未来才行` };
    }
    // ★ 平台规则：必须"半小时以后"
    const tooSoon2 = checkScheduleLead(d, base);
    if (tooSoon2) return { ok: false, reason: tooSoon2 };
    return { ok: true, date: d, text: fmtSchedule(d) };
  }

  return {
    ok: false,
    reason: `看不懂的时间写法：「${s0}」。支持两种：每天到点用 "08:00"；指定某天用 "2026-10-08 08:00"`,
  };
}

/**
 * ★★ 单章单独定时：把"时间写法"铺成**每章一个时刻**的计划。
 *
 * 支持：
 *   · 单段 "08:00"           → 所有章同一时刻（旧行为，不滚动）
 *   · 多段 "08:00,12:00,18:00" → 按**发布顺序**逐章对应；不够就循环；
 *     且必须**严格晚于上一章** —— 不够晚就自动顺延到次日
 *     （所以 "08:00,12:00" 发 4 章 = 08:00、12:00、次日 08:00、次日 12:00）
 *
 * 顺序 = 发布顺序（书里的章节顺序），这样"哪章对应哪段"是确定的、可预告的。
 *
 * @param {string} spec 用户输入（可含逗号分隔的多段）
 * @param {number} count 要发的章节数
 * @param {Date} [now] 基准时间（默认真实时间；测试注入）
 * @returns {{ok: true, schedules: {date: Date, text: string}[], times: number}
 *          | {ok: false, reason: string}}
 */
function planScheduleForChapters(spec, count, now) {
  const parts = String(spec == null ? '' : spec)
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return { ok: false, reason: '定时时间是空的' };
  const parsed = [];
  for (const p of parts) {
    const r = parseScheduleTime(p, now);
    if (!r.ok) return r;
    parsed.push(r);
  }
  const base = now instanceof Date ? new Date(now.getTime()) : new Date();
  const single = parsed.length === 1;
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const schedules = [];
  let prev = base;
  for (let i = 0; i < n; i++) {
    const d = new Date(parsed[i % parsed.length].date.getTime());
    if (!single) {
      // 多段：必须严格晚于上一章；不够晚就往后滚天数（防呆上限 400 天）
      let guard = 0;
      while (d.getTime() <= prev.getTime() && guard < 400) {
        d.setDate(d.getDate() + 1);
        guard++;
      }
    }
    prev = d;
    schedules.push({ date: d, text: fmtSchedule(d) });
  }
  return { ok: true, schedules, times: parsed.length };
}

/**
 * ★★ 逐章定时映射（面板"章节表里逐章填时间"用）。
 *
 * 写法：「章节号=时间」用逗号分隔，如 `8=08:00,9=2026-10-09 12:00`。
 * 没列到的章节**立即发布**（不受影响）。这和 --at 的多段"逐章顺延"是两套语义：
 *   · --at "08:00,12:00"  → 按顺序铺，不够循环 + 自动顺延
 *   · --schedule-map "8=08:00" → 只给第 8 章定时，别的章不动，时间就是你写的那个
 * 面板里是逐行填的，用户看得见每一章的时间，所以不做任何自动顺延。
 *
 * @param {string} spec
 * @param {Date} [now]
 * @returns {{ok: true, map: Map<number, {date: Date, text: string}>} | {ok: false, reason: string}}
 */
function parseScheduleMap(spec, now) {
  const parts = String(spec == null ? '' : spec)
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return { ok: false, reason: '逐章定时是空的' };
  const map = new Map();
  for (const p of parts) {
    const m = p.match(/^(\d+)\s*=\s*(.+)$/);
    if (!m) {
      return { ok: false, reason: `看不懂「${p}」—— 逐章定时要写成 "8=08:00" 这样（章节号 = 时间）` };
    }
    const no = Number(m[1]);
    const r = parseScheduleTime(m[2], now);
    if (!r.ok) return { ok: false, reason: `第 ${no} 章的时间有问题：${r.reason}` };
    if (map.has(no)) return { ok: false, reason: `第 ${no} 章的定时写了两遍` };
    map.set(no, { date: r.date, text: r.text });
  }
  return { ok: true, map };
}

module.exports = {
  ROOT,
  resolvePath,
  ensureDir,
  createLogger,
  sleep,
  randomInt,
  safeFileName,
  normalizeBody,
  countChars,
  stripChapterPrefix,
  cnNumToInt,
  anyNumToInt,
  parseChapterNoFromTitle,
  resolveChapterSelection,
  fmtSchedule,
  MIN_SCHEDULE_LEAD_MS,
  checkScheduleLead,
  parseScheduleTime,
  planScheduleForChapters,
  parseScheduleMap,
};
