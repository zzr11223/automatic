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
  anyNumToInt,
};
