'use strict';

/**
 * 日字数配额账本。
 *
 * 背景：番茄对"直接发布"有**每日字数上限**（本机配置里是 10000 字/天）。
 * 目标：点一下「一键发布」就把当天的额度用满，但**不超** ——
 * 所以必须记住"今天已经发了多少字"，并且在**下一章放不下时停下来**（不拆章）。
 *
 * 账本文件：**每本书一份** books/<书名>/daily.json（老布局单书时是 data/daily.json）
 *   {
 *     "date": "2026-09-27",
 *     "chars": 3759,
 *     "chapters": [ { "title": "第17章 …", "no": 17, "chars": 1875, "at": "…" } ]
 *   }
 * ★ 路径由 books.activate() 指过来。番茄的每日字数额度是**每本书各算各的**，
 *   所以账本必须按书分开，不能共用。
 *
 * ★ 自愈设计（两条，缺一不可）：
 *   1. 账本里的日期不是今天 → 直接开新账本（跨天自动清零）
 *   2. 开新账本时会**去 progress.json 里翻今天发过的记录补账** ——
 *      这样"这套机制上线之前，今天已经发出去的章节"也会被算进去，不会发超。
 *
 * ⚠️ 脚本只能统计**自己发出去的**。如果用户手动在番茄后台发了章节，
 *    脚本不知道，可能算多。这种情况把 config.json 的 dailyCharLimit 临时调小即可。
 */

const fs = require('fs');
const path = require('path');
const { ROOT, ensureDir } = require('./util');
const progress = require('./progress');

/**
 * ★ 多书支持：账本路径**不是**写死的 —— 由 books.activate() 指到
 * books/<书名>/daily.json。用户确认番茄的每日字数额度是**每本书各算各的**。
 * 默认值只为兼容"没走 books/ 的老调用"。
 */
let DAILY_PATH = path.join(ROOT, 'data', 'daily.json');

function setFile(p) {
  DAILY_PATH = p;
}
function getFile() {
  return DAILY_PATH;
}

/** 本地日期 → "YYYY-MM-DD"（番茄的每日重置按本地时区算） */
function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** progress.json 里的时间格式是 "2026/9/27 10:25:14"，抠出日期部分 */
function dateKeyFromRecord(at) {
  const m = String(at || '').match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (!m) return '';
  return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
}

/** 日字数上限是否启用（<=0 或没配 = 不启用） */
function isEnabled(cfg) {
  const n = Number(cfg && cfg.publish && cfg.publish.dailyCharLimit);
  return Number.isFinite(n) && n > 0;
}

/** 读账本原始文件，坏了就当成没有（不要让一个坏文件把发布流程卡死） */
function readRaw() {
  try {
    if (!fs.existsSync(DAILY_PATH)) return null;
    const d = JSON.parse(fs.readFileSync(DAILY_PATH, 'utf8'));
    if (!d || typeof d !== 'object') return null;
    return {
      date: String(d.date || ''),
      chars: Number(d.chars) || 0,
      chapters: Array.isArray(d.chapters) ? d.chapters : [],
    };
  } catch (_) {
    return null;
  }
}

function writeRaw(led) {
  try {
    ensureDir(path.dirname(DAILY_PATH));
    fs.writeFileSync(DAILY_PATH, JSON.stringify(led, null, 2), 'utf8');
  } catch (_) {
    /* 账本写不进去不该影响发布本身 */
  }
}

/**
 * 从 progress.json 里补出"今天已经发出去"的账。
 * 章节字数以 chapters/manifest.json 为准。
 *
 * 实测对比（2026-10-03，第22~28章 vs 番茄后台「字数」列）：
 *   1717/1901/1962/1918/1547 完全一致；第25章 1535 vs 1533、第27章 1775 vs 1774，
 *   差 1~2 字。差异来自平台自己的字数统计口径，量级可忽略。
 *   ⚠️ 别把"完全一致"写进注释或文档 —— 量级一致就够了，对不上时也别怀疑数据错了。
 */
function backfillFromProgress(manifest) {
  const state = progress.load();
  const today = todayKey();
  const byTitle = new Map(((manifest && manifest.chapters) || []).map((c) => [c.title, c]));

  const chapters = [];
  let chars = 0;
  for (const [title, rec] of Object.entries(state.chapters || {})) {
    if (!rec || rec.status !== 'published') continue;
    if (dateKeyFromRecord(rec.at) !== today) continue;
    const meta = byTitle.get(title);
    const n = Number(meta && meta.chars) || 0;
    chars += n;
    chapters.push({ title, no: rec.chapterNo || 0, chars: n, at: rec.at || '' });
  }
  return { chars, chapters };
}

/**
 * 打开（必要时重建）今天的账本。
 * @param {object} manifest chapters/manifest.json
 * @param {object} [logger]
 * @param {{persist?: boolean}} [opts] persist=false 时只读不落盘（给 status 这类只读命令用）
 */
function open(manifest, logger, opts = {}) {
  const persist = opts.persist !== false;
  const today = todayKey();
  const led = readRaw();

  if (led && led.date === today) return led;

  // 账本缺失 / 不是今天的 → 开新账本，并从发布记录里补今天的账
  const bf = backfillFromProgress(manifest);
  const fresh = { date: today, chars: bf.chars, chapters: bf.chapters };
  if (bf.chars > 0 && logger) {
    logger.info(
      `新的一天，日字数账本从 0 开始。补账：今天已发 ${bf.chapters.length} 章、共 ${bf.chars} 字`
    );
  }
  if (persist) writeRaw(fresh);
  return fresh;
}

/** 今天还能发多少字（未启用上限时返回 Infinity） */
function remaining(cfg, led) {
  if (!isEnabled(cfg)) return Infinity;
  return Math.max(0, Number(cfg.publish.dailyCharLimit) - led.chars);
}

/**
 * 记一笔：某章刚刚发出去，累计到今天的账上并落盘。
 * 放在"发布成功之后"立刻调用 —— 这样即使后面崩了，已经发出去的账也是准的。
 */
function record(led, cfg, chapter, chapterNo, logger) {
  // 万一这次运行跨过了零点，直接开新账本
  if (led.date !== todayKey()) {
    led.date = todayKey();
    led.chars = 0;
    led.chapters = [];
  }
  const chars = Number(chapter && chapter.chars) || 0;
  led.chars += chars;
  led.chapters.push({
    title: (chapter && chapter.title) || '',
    no: chapterNo || 0,
    chars,
    at: new Date().toLocaleString('zh-CN', { hour12: false }),
  });
  writeRaw(led);

  if (isEnabled(cfg) && logger) {
    const limit = Number(cfg.publish.dailyCharLimit);
    logger.info(`今日进度：${led.chars} / ${limit} 字（还可发 ${Math.max(0, limit - led.chars)} 字）`);
  }
  return led.chars;
}

/** 今天的使用情况（给 status / check 展示用，只读） */
function summary(cfg, manifest) {
  const limit = isEnabled(cfg) ? Number(cfg.publish.dailyCharLimit) : 0;
  const led = open(manifest, null, { persist: false });
  return {
    enabled: isEnabled(cfg),
    date: led.date,
    limit,
    used: led.chars,
    remain: limit > 0 ? Math.max(0, limit - led.chars) : Infinity,
    count: led.chapters.length,
    chapters: led.chapters,
  };
}

/** 清空今天的账本（用户手动在后台发过、或想重来一次时用） */
function reset(manifest) {
  const fresh = { date: todayKey(), chars: 0, chapters: [] };
  writeRaw(fresh);
  return fresh;
}

/**
 * 手动把"今天已发字数"设成一个指定值。
 * 用途：用户自己手动在番茄后台发过章节 —— 脚本统计不到那部分，只能人工补上。
 * @returns {{before: number, after: number}}
 */
function setUsed(manifest, n) {
  const led = open(manifest, null);
  const before = led.chars;
  led.chars = n;
  led.chapters = [
    {
      title: '（手动校准）',
      no: 0,
      chars: n,
      at: new Date().toLocaleString('zh-CN', { hour12: false }),
    },
  ];
  writeRaw(led);
  return { before, after: n };
}

module.exports = {
  isEnabled,
  open,
  remaining,
  record,
  summary,
  reset,
  setUsed,
  todayKey,
  setFile,
  getFile,
};
