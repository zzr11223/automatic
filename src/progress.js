/**
 * 发布进度记录：**每本书一份** books/<书名>/progress.json
 * （老布局单书时是 data/progress.json，已由 books.migrateLegacy 搬走）
 *
 * 判定"这一章发过没有"有**两条通道**，缺一不可：
 *
 *   ① 按标题认（主通道）—— 账本里以标题为 key，最直观
 *   ② 按章节序号认（兜底通道）—— ★ 2026-10-03 补
 *
 * 为什么要 ②：
 *   标题只要改动一个字（哪怕只是把平台上的「…校准」补成「…校准滑块」），
 *   ①里就找不到了 → 脚本会当成新章节**重发一遍**。
 *   所以再从"已发记录"里摊出一张「序号 → 记录」的表兜一层：
 *   序号 22 发过，那不管标题怎么改，第22章都不再发。
 *
 * ★ 但不做持久化的独立索引，而是每次读的时候**从 chapters 现摊**：
 *   两张表存同一件事迟早会对不上（改了 A 忘了改 B），
 *   单一数据源（chapters）最不容易出错，也省掉了老账本的数据迁移。
 */
const fs = require('fs');
const path = require('path');
const { ROOT, ensureDir, parseChapterNoFromTitle } = require('./util');

/**
 * ★ 多书支持：账本路径**不是**写死的 —— 由 books.activate() 指到
 * books/<书名>/progress.json。**一本一份账本**，否则第二本书的「第17章」
 * 会被第一本的「第17章」记录按序号命中，判成已发布而静默漏发。
 *
 * 默认值只为兼容"没走 books/ 的老调用"（比如直接跑单测）。
 */
let FILE = path.join(ROOT, 'data', 'progress.json');

function setFile(p) {
  FILE = p;
}
function getFile() {
  return FILE;
}

/** 这些状态都算"这一章的活干完了，别再发一次" */
const DONE_STATES = new Set(['published', 'draft']);

function isDoneRecord(rec) {
  return !!rec && DONE_STATES.has(rec.status);
}

function load() {
  if (!fs.existsSync(FILE)) return { chapters: {}, lastRun: null };
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!d.chapters) d.chapters = {};
    return d;
  } catch (_) {
    return { chapters: {}, lastRun: null };
  }
}

function save(data) {
  ensureDir(path.dirname(FILE));
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
}

/** 从一条记录推出它的章节序号（记录里存的优先，没有就从标题里抠） */
function recordNo(title, rec) {
  const n = Number(rec && rec.chapterNo);
  if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  return parseChapterNoFromTitle(title);
}

/**
 * 把「章节序号 → 该号的记录」摊成一张表。
 * 同一个序号有多条记录时（改过名字就会有），**已发布的那条更权威**。
 */
function indexByNo(data) {
  const d = data || load();
  const idx = {};
  for (const [title, rec] of Object.entries(d.chapters || {})) {
    const no = recordNo(title, rec);
    if (!no) continue;
    const prev = idx[no];
    if (prev && isDoneRecord(prev) && !isDoneRecord(rec)) continue;
    idx[no] = { title, ...rec };
  }
  return idx;
}

/**
 * 这一章到底发过没有？给个明确结论 + 依据，方便日志里说人话。
 *
 * @param {string} title 章节标题
 * @param {number} [chapterNo] 已知的章节序号（没有就从标题里解析）
 * @param {object} [data] 直接给一份账本（单测用；不给就读 data/progress.json）
 * @returns {{done:boolean, how:'title'|'number'|null, by?:string, no?:number, record?:object}}
 *          how='title' 按标题命中；how='number' 标题没命中、靠序号兜住的（说明标题改过）
 */
function matchDone(title, chapterNo, data) {
  const d = data || load();
  const rec = d.chapters[title];
  if (isDoneRecord(rec)) {
    return { done: true, how: 'title', by: title, no: recordNo(title, rec), record: rec };
  }

  const no = Number(chapterNo) || parseChapterNoFromTitle(String(title || ''));
  if (!no) return { done: false, how: null };

  const hit = indexByNo(d)[no];
  if (hit && isDoneRecord(hit)) {
    return { done: true, how: 'number', by: hit.title, no, record: hit };
  }
  return { done: false, how: null, no };
}

/** 这一章发过没有（只看结论，不看依据） */
function isDone(title, chapterNo, data) {
  return matchDone(title, chapterNo, data).done;
}

function markPublished(title, info = {}) {
  const d = load();
  const at = new Date().toLocaleString('zh-CN', { hour12: false });
  // ★ status 缺省兜成 published 再让 info 覆盖。
  //   这个函数的名字就是"标记为已发布"，漏传 status 会让这条记录**不算已完成**
  //   （DONE_STATES 里没有 undefined），于是下一轮又把它发一遍。
  //   调用方（publisher）会传 r.status 覆盖成 publish/draft，顺序不能反。
  d.chapters[title] = { status: 'published', ...info, at: info.at || at };
  d.lastRun = new Date().toISOString();
  save(d);
}

function markFailed(title, reason, info = {}) {
  const d = load();
  const at = new Date().toLocaleString('zh-CN', { hour12: false });
  d.chapters[title] = { status: 'failed', reason, ...info, at };
  d.lastRun = new Date().toISOString();
  save(d);
}

/**
 * 列出"已发章节"的序号集合 + 一份概览，给 status / check 用。
 */
function summary() {
  const d = load();
  const idx = indexByNo(d);
  const nos = Object.keys(idx)
    .map(Number)
    .filter((n) => isDoneRecord(idx[n]))
    .sort((a, b) => a - b);
  return { count: nos.length, nos, byNo: idx, total: Object.keys(d.chapters || {}).length };
}

module.exports = {
  load,
  save,
  markPublished,
  markFailed,
  isDone,
  matchDone,
  indexByNo,
  recordNo,
  summary,
  isDoneRecord,
  setFile,
  getFile,
};
