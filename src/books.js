/**
 * 多书支持：books/<书名>/ 一本书一个文件夹，各自一套正文 / 拆分结果 / 发布记录。
 *
 * ★★ 为什么必须分开 —— 这是实测出来的，不是预防性设计：
 *
 *   progress.json 判定"这章发过没有"有两条通道，第二条是**认章节序号**
 *   （标题改了也能认出，见 progress.js）。这条通道**跨书会串号**：
 *
 *     第二本书的「第17章 另一个完全不同的故事」
 *       → 命中第一本的「第17章 星海归途」
 *       → 判定"已发布"，直接跳过，**而且不报错**
 *
 *   也就是说共用一份账本会让第二本书静默漏发。所以一本一份。
 *
 * 分开的是"书级"的东西：正文、拆分结果、发布记录、每日字数账本、番茄书名。
 * 共用的是"账号级"的东西：登录态（userdata/）、账号密码（credentials.json）、
 * 浏览器与发布参数（config.json）、日志（logs/）。
 *
 * 当前操作哪一本记在 books/.current（纯文本一行书名）。
 */
const fs = require('fs');
const path = require('path');
const { ROOT, ensureDir } = require('./util');

const BOOKS_DIRNAME = 'books';
const CURRENT_FILE = '.current';
const BOOK_JSON = 'book.json';
const DEFAULT_SOURCE = 'novel.txt';

/** 这些状态算"这一章已经发过了"（和 progress.js 的 DONE_STATES 保持一致） */
const DONE_STATES = new Set(['published', 'draft']);

/* ------------------------- 基础路径 ------------------------- */

function booksRoot(baseDir) {
  return baseDir || path.join(ROOT, BOOKS_DIRNAME);
}

/** 书名 → 安全的文件夹名（书名里一般不会有这些字符，兜一层） */
function normalizeName(s) {
  return String(s == null ? '' : s)
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

function bookDir(name, baseDir) {
  return path.join(booksRoot(baseDir), normalizeName(name));
}

function readJsonFile(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

/* ------------------------- 一本书的完整路径 ------------------------- */

function readBookJson(dir) {
  return readJsonFile(path.join(dir, BOOK_JSON)) || {};
}

/**
 * 算出这本书的所有路径。★ **只算不建目录** —— 给只读命令用
 * （"看看有哪些书"不该往硬盘上写东西）。
 */
function pathsOf(name, baseDir) {
  const clean = normalizeName(name);
  const dir = bookDir(clean, baseDir);
  const bj = readBookJson(dir);
  const srcRel = String(bj.sourceFile || '').trim() || DEFAULT_SOURCE;
  const chaptersDir = path.join(dir, 'chapters');
  return {
    name: clean,
    dir,
    // 番茄后台里的书名。没写就用文件夹名（多数时候两者本来就一样）
    bookName: String(bj.bookName || '').trim() || clean,
    bookUrl: String(bj.bookUrl || '').trim(),
    createChapterUrl: String(bj.createChapterUrl || '').trim(),
    sourceFile: path.isAbsolute(srcRel) ? srcRel : path.join(dir, srcRel),
    chaptersDir,
    manifestPath: path.join(chaptersDir, 'manifest.json'),
    progressPath: path.join(dir, 'progress.json'),
    // ★ 日额度是**账号级**的（2026-10-05 用户确认：总额度 10000，不是每本各算 10000），
    //   所以"额度账本"全账号只有一份 data/daily.json，不再按书分。
    //   字段名保留 dailyPath 是为了少动显示层 —— 它现在指向共享账本。
    dailyPath: require('./daily').accountFile(),
    bookJsonPath: path.join(dir, BOOK_JSON),
  };
}

/* ------------------------- 列书 / 选书 ------------------------- */

function isBookDir(p) {
  try {
    return fs.statSync(p).isDirectory() && !path.basename(p).startsWith('.');
  } catch (_) {
    return false;
  }
}

/** 这本书发了多少章 / 共多少章（直接读文件，不碰 progress 模块的状态） */
function statsOf(p) {
  const prog = readJsonFile(p.progressPath) || {};
  let published = 0;
  for (const rec of Object.values(prog.chapters || {})) {
    if (rec && DONE_STATES.has(rec.status)) published += 1;
  }
  const mf = readJsonFile(p.manifestPath);
  const total = (mf && Array.isArray(mf.chapters) && mf.chapters.length) || 0;
  return { published, total };
}

function describeBook(name, baseDir) {
  const p = pathsOf(name, baseDir);
  const st = statsOf(p);
  return {
    ...p,
    exists: isBookDir(p.dir),
    hasSource: fs.existsSync(p.sourceFile),
    hasChapters: fs.existsSync(p.manifestPath),
    published: st.published,
    total: st.total,
  };
}

/** books/ 下的所有书，按文件夹名排序 */
function listBooks(baseDir) {
  const root = booksRoot(baseDir);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => describeBook(d.name, baseDir))
    .filter((b) => b.exists)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

function currentName(baseDir) {
  const p = path.join(booksRoot(baseDir), CURRENT_FILE);
  try {
    if (!fs.existsSync(p)) return '';
    return normalizeName(fs.readFileSync(p, 'utf8').split('\n')[0]);
  } catch (_) {
    return '';
  }
}

/* ------------------------- 一本书的概览（纯读，不改全局状态） ------------------------- */

/**
 * 解析时间戳。progress.json 里是 zh-CN 格式 "2026/10/3 11:28:00"，
 * lastRun 是 ISO。★ 不能用字符串比大小 —— "2026/10/13" 会排在 "2026/10/3" 前面。
 */
function parseStamp(v) {
  const s = String(v || '').trim();
  if (!s) return 0;
  const m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

function formatStamp(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 一本书的概览：读它自己的 progress.json / chapters/manifest.json 算出来。
 *
 * ★★ 为什么**不**循环调 `activate()` 再读：
 *   `activate()` 每次都会 `setCurrent()` 重写 `books/.current`，并把 progress / daily /
 *   split 三个模块的指针全指过去。对着每本书来一遍，万一中途抛错，`.current` 就停在
 *   别的书上了 —— **用户下次点「发布」会发错书**。
 *   只想"看一眼"的操作，绝不能顺手改状态。
 *
 * ★★ 日额度是**账号级**的（2026-10-05 确认），所以这里**不算额度**：
 *   - `todayChars` / `todayChapters` = **这本书自己**今天发了多少（从它的 progress.json 数，
 *     字数以它的 manifest 为准）—— 纯展示用
 *   - 账号今天总共发了多少、还剩多少，由调用方用 `daily.summary()` 取**一次**就够了
 *     （每本书都算一遍是浪费，而且容易让人误以为额度是按书分的）
 *
 * @param {object} book `describeBook()` / `listBooks()` 返回的完整描述（含各条路径）
 */
function summarize(book) {
  const prog = readJsonFile(book.progressPath) || {};
  const mf = readJsonFile(book.manifestPath);
  const chapters = mf && Array.isArray(mf.chapters) ? mf.chapters : [];

  let published = 0;
  let draft = 0;
  let failed = 0;
  let newest = 0;
  for (const rec of Object.values(prog.chapters || {})) {
    if (!rec) continue;
    if (rec.status === 'published') published += 1;
    else if (rec.status === 'draft') draft += 1;
    else if (rec.status === 'failed') failed += 1;
    const t = parseStamp(rec.at);
    if (t > newest) newest = t;
  }

  const done = published + draft;
  const total = chapters.length;
  // lastRun 是每次跑完都会刷的，比逐条记录的最大时间更靠谱；没有就退回逐条里最新的
  const last = parseStamp(prog.lastRun) || newest;

  // 这本书今天发了多少：progress 记录里不带字数，得回 manifest 里查
  const dailyMod = require('./daily');
  const today = dailyMod.todayKey();
  const byTitle = new Map(chapters.map((c) => [c.title, c]));
  let todayChars = 0;
  let todayChapters = 0;
  for (const [title, rec] of Object.entries(prog.chapters || {})) {
    if (!rec || rec.status !== 'published') continue;
    if (dailyMod.dateKeyFromRecord(rec.at) !== today) continue;
    todayChars += Number((byTitle.get(title) || {}).chars) || 0;
    todayChapters += 1;
  }

  return {
    total,
    published,
    draft,
    failed,
    pending: Math.max(0, total - done),
    volumes: [...new Set(chapters.map((c) => c.volume).filter(Boolean))],
    todayChars,
    todayChapters,
    lastAt: last ? formatStamp(last) : '',
    hasProgress: Object.keys(prog.chapters || {}).length > 0,
  };
}

/**
 * 这本书还没发的章节（纯读，把账本**注入**给 `progress.matchDone`，不碰全局状态）。
 * 判定口径和面板 / 发布完全一致：标题优先、序号兜底（见 progress.js）。
 */
function pendingOf(book) {
  const prog = readJsonFile(book.progressPath) || { chapters: {} };
  const mf = readJsonFile(book.manifestPath);
  const chapters = mf && Array.isArray(mf.chapters) ? mf.chapters : [];
  const progress = require('./progress');

  const out = [];
  for (const c of chapters) {
    if (progress.matchDone(c.title, undefined, prog).done) continue;
    out.push({ seq: c.seq, title: c.title, chars: c.chars, volume: c.volume || '' });
  }
  return out;
}

function setCurrent(name, baseDir) {
  const clean = normalizeName(name);
  ensureDir(booksRoot(baseDir));
  fs.writeFileSync(path.join(booksRoot(baseDir), CURRENT_FILE), clean + '\n', 'utf8');
  return clean;
}

/**
 * 清掉「当前小说」标记（把 books/.current 删掉）。
 * 给"临时发另一本"用：如果调用前压根没有 .current，恢复时就该恢复成"没有"，
 * 而不是留下一行空字符串。
 */
function clearCurrent(baseDir) {
  try {
    fs.unlinkSync(path.join(booksRoot(baseDir), CURRENT_FILE));
  } catch (_) {
    /* 本来就没有，正常 */
  }
}

/**
 * 定位"要操作哪一本"。优先级：显式指定 → .current → 只有一本就用它。
 * 找不到就抛错，并且把现有的书列出来（用户分不清"名字打错"和"还没建"，是最烦的）。
 */
function resolveBook(nameOrNull, baseDir) {
  const all = listBooks(baseDir);
  const explicit = normalizeName(nameOrNull);

  if (explicit) {
    const hit = all.find((b) => b.name === explicit);
    if (hit) return hit;
    throw new Error(
      `找不到小说「${explicit}」。\n` +
        (all.length
          ? `books\\ 下现有 ${all.length} 本：\n` + all.map((b) => `  · ${b.name}`).join('\n')
          : 'books\\ 下还没有任何小说 —— 先双击「11-切换当前小说.bat」新建一本')
    );
  }

  const cur = currentName(baseDir);
  if (cur) {
    const hit = all.find((b) => b.name === cur);
    if (hit) return hit;
    throw new Error(
      `books\\.current 记的是「${cur}」，但 books\\ 下没有这个文件夹。\n` +
        (all.length
          ? `现有：\n` + all.map((b) => `  · ${b.name}`).join('\n') + '\n用「11-切换当前小说.bat」重新选一个'
          : 'books\\ 下还没有任何小说')
    );
  }

  if (all.length === 1) return all[0];

  if (all.length > 1) {
    throw new Error(
      `books\\ 下有 ${all.length} 本，但不知道要发哪一本。\n` +
        all.map((b) => `  · ${b.name}`).join('\n') +
        '\n双击「11-切换当前小说.bat」选一本'
    );
  }

  throw new Error(
    'books\\ 下还没有任何小说。\n' +
      '双击「11-切换当前小说.bat」新建一本，然后把小说全文存成它的 novel.txt'
  );
}

/* ------------------------- 把书"装上" ------------------------- */

/**
 * 把 book.json 里的书级配置写进 cfg。
 * ★ 地址留空时会**主动清掉** config.json 里写死的地址 ——
 *   否则切到第二本书后，还拿着第一本的书籍 ID 去发，就发错了。
 */
function applyBookToConfig(cfg, book) {
  if (!cfg) return cfg;
  cfg.site = cfg.site || {};
  cfg.site.bookName = book.bookName;
  cfg.site.bookUrl = book.bookUrl;
  cfg.site.createChapterUrl = book.createChapterUrl;
  cfg.novel = cfg.novel || {};
  cfg.novel.sourceFile = book.sourceFile;
  // ★ 存**完整描述**（含 sourceFile / progressPath / dailyPath 等各条路径），
  //   自检与日志都要用。只存 name/dir 的话，取 .progressPath 会拿到 undefined，
  //   然后 path.relative(ROOT, undefined) 直接抛错（踩过）。
  cfg._book = book;
  return cfg;
}

/**
 * ★★ 把旧的"每本书一份 daily.json"合并进账号级共享账本。
 *
 * 背景：2026-10-03 做多书时，以为番茄的日额度是**每本书各算各的**，账本就按书分了。
 * 2026-10-05 用户确认其实是**账号总额度**（两本加起来一天 10000 字）。
 * 如果不合并，每本书的账本都记着"自己今天发了多少"，谁也不知道别的书发了多少
 * → **两本一起发就会发超**。
 *
 * 规则：
 *   · 只合并 `date === 今天` 的账（旧日期的账本来就该被跨天清零，没有保留价值）
 *   · **各书今天的账直接加总**进共享账本 —— 共享文件在书级账本模型下从没人写过
 *     （activate 一直把 daily 指向书级文件），所以不存在重复计算
 *   · 合并完把旧文件改名成 `daily.json.migrated` —— 不再被读，也留个底
 *     （★ 改名而不是删除，是防"重复统计"的根本手段：第二次跑时它自然就不在了）
 *
 * 幂等：跑多少次结果都一样（旧文件改名后，第二次跑找不到可合并的）。
 */
function migrateDailyLedgers(baseDir) {
  const daily = require('./daily');
  const today = daily.todayKey();
  const target = daily.accountFile();

  const shared = readJsonFile(target);
  const sharedIsToday = !!shared && shared.date === today;

  let chars = sharedIsToday ? Number(shared.chars) || 0 : 0;
  const chapters = sharedIsToday ? (shared.chapters || []).slice() : [];
  let touched = false;

  for (const b of listBooks(baseDir)) {
    const oldPath = path.join(b.dir, 'daily.json');
    const old = readJsonFile(oldPath);
    if (!old || old.date !== today) continue; // 不是今天的旧账，跨天清零即可，不用迁

    chars = Math.max(chars, 0) + (Number(old.chars) || 0);
    for (const c of old.chapters || []) {
      if (!chapters.some((x) => x.title === c.title && x.no === c.no && x.at === c.at)) chapters.push(c);
    }
    touched = true;

    try {
      fs.renameSync(oldPath, oldPath + '.migrated');
    } catch (_) {
      // 改名失败就别动它 —— 宁可下次再试，也不能把用户的账弄丢
      continue;
    }
  }

  if (touched || (sharedIsToday && chars !== (Number(shared.chars) || 0))) {
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, JSON.stringify({ date: today, chars, chapters }, null, 2), 'utf8');
  }
  return { migrated: touched, chars };
}

/**
 * 激活一本书：把 progress / split 的路径指到这本书下面；
 * **日额度账本是账号级的，不再按书指** —— 所有书共用一份 data/daily.json。
 * 用惰性 require 是为了避免加载顺序问题（这些模块都不依赖 books.js）。
 */
function activate(nameOrNull, baseDir) {
  const book = resolveBook(nameOrNull, baseDir);
  const progress = require('./progress');
  const split = require('./split');
  const daily = require('./daily');
  progress.setFile(book.progressPath);
  split.setChaptersDir(book.chaptersDir);

  // ★ 先把旧的书级账本并进来（保住今天已经发的字数），再把账本指到共享位置，
  //   最后把"补账要扫哪些书"告诉 daily —— 不扫全部书就会发超
  migrateDailyLedgers(baseDir);
  daily.setFile(daily.accountFile());
  daily.setSources(
    listBooks(baseDir).map((b) => ({ progressPath: b.progressPath, manifestPath: b.manifestPath }))
  );

  setCurrent(book.name, baseDir);
  return book;
}

/* ------------------------- 新建一本 ------------------------- */

function createBook(name, opts = {}, baseDir) {
  const clean = normalizeName(name);
  if (!clean) throw new Error('书名不能为空');

  const dir = ensureDir(bookDir(clean, baseDir));
  const bjPath = path.join(dir, BOOK_JSON);
  const bookName = String(opts.bookName || '').trim() || clean;

  if (!fs.existsSync(bjPath)) {
    const bj = {
      _说明: '这本书的专属设置。改完保存即生效（注意别删引号和逗号）。',
      _说明1: '★ bookName = 番茄后台里的书名，必须一模一样。脚本按它定位作品，账号里有多本书也不会发错',
      bookName,
      _说明2: 'bookUrl / createChapterUrl 可以不填 —— bookName 能找到作品时会自动用正确地址。填了只作兜底',
      bookUrl: String(opts.bookUrl || '').trim(),
      createChapterUrl: String(opts.createChapterUrl || '').trim(),
      _说明3: 'sourceFile = 这本书的正文文件（相对本书文件夹）',
      sourceFile: DEFAULT_SOURCE,
    };
    fs.writeFileSync(bjPath, JSON.stringify(bj, null, 2), 'utf8');
  }

  if (opts.source) {
    const p = pathsOf(clean, baseDir);
    ensureDir(path.dirname(p.sourceFile));
    fs.writeFileSync(p.sourceFile, String(opts.source), 'utf8');
  }

  return describeBook(clean, baseDir);
}

/* ------------------------- 老布局迁移 ------------------------- */

/** 老布局（单书，文件都在根目录）的四个位置。rootDir 只为单测注入，正常用 ROOT */
function legacyPaths(rootDir) {
  const root = rootDir || ROOT;
  return {
    source: path.join(root, 'novel.txt'),
    chapters: path.join(root, 'chapters'),
    progress: path.join(root, 'data', 'progress.json'),
    daily: path.join(root, 'data', 'daily.json'),
  };
}

function legacyPresent(rootDir) {
  const l = legacyPaths(rootDir);
  // ★ **不算 daily** —— 日额度账本是账号级的（data/daily.json），迁移后它永远留在原地；
  //   把它算进来会让"老布局还在"永远为真，迁移被反复触发
  return fs.existsSync(l.source) || fs.existsSync(l.progress) || fs.existsSync(l.chapters);
}

function copyDirSync(src, dest) {
  ensureDir(dest);
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** 先复制到备份目录，成功后再删源；跨盘 rename 失败也能兜住 */
function moveInto(src, dest) {
  ensureDir(path.dirname(dest));
  try {
    fs.renameSync(src, dest);
    return 'moved';
  } catch (_) {
    if (fs.statSync(src).isDirectory()) copyDirSync(src, dest);
    else fs.copyFileSync(src, dest);
    fs.rmSync(src, { recursive: true, force: true });
    return 'copied';
  }
}

function countProgress(file) {
  const d = readJsonFile(file) || {};
  return Object.keys(d.chapters || {}).length;
}

/**
 * 把根目录的老布局搬进 books/<书名>/。
 *
 * ★ 顺序是「先备份 → 再移动 → 再校验条数」，任何一步不对就原样报错，
 *   绝不静默丢记录（那 17 条记录里还有 7 条是用户手动发布后补的，重建不回来）。
 */
function migrateLegacy(logger, opts = {}) {
  const log = logger || { info() {}, ok() {}, warn() {} };
  const baseDir = opts.baseDir;
  const root = opts.rootDir || ROOT;
  const l = legacyPaths(root);

  if (!legacyPresent(root)) return null;

  const wantName =
    normalizeName(opts.bookName) ||
    normalizeName(currentName(baseDir)) ||
    '我的小说';
  const dest = pathsOf(wantName, baseDir);

  if (fs.existsSync(dest.sourceFile)) {
    log.info(`books\\${wantName}\\ 已经有 novel.txt，跳过迁移`);
    return describeBook(wantName, baseDir);
  }

  const stamp = new Date()
    .toLocaleString('zh-CN', { hour12: false })
    .replace(/[\/:\s]/g, '-');
  const backupDir = ensureDir(path.join(root, 'data', `_迁移备份-${stamp}`));

  log.step(`检测到老布局（单书、文件在根目录），搬进 books\\${wantName}\\`);
  log.info(`先把原件备份到：${backupDir}`);

  const before = {};
  if (fs.existsSync(l.source)) fs.copyFileSync(l.source, path.join(backupDir, 'novel.txt'));
  if (fs.existsSync(l.chapters)) copyDirSync(l.chapters, path.join(backupDir, 'chapters'));
  if (fs.existsSync(l.progress)) fs.copyFileSync(l.progress, path.join(backupDir, 'progress.json'));
  if (fs.existsSync(l.daily)) fs.copyFileSync(l.daily, path.join(backupDir, 'daily.json'));
  before.progress = fs.existsSync(l.progress) ? countProgress(l.progress) : 0;
  before.chapters = fs.existsSync(path.join(l.chapters, 'manifest.json'))
    ? ((readJsonFile(path.join(l.chapters, 'manifest.json')) || {}).chapters || []).length
    : 0;
  before.sourceChars = fs.existsSync(l.source)
    ? fs.readFileSync(l.source, 'utf8').replace(/\s/g, '').length
    : 0;
  log.info(`备份完成：${before.progress} 条发布记录、${before.chapters} 章、正文 ${before.sourceChars} 字`);

  ensureDir(dest.dir);
  if (fs.existsSync(l.source)) moveInto(l.source, dest.sourceFile);
  if (fs.existsSync(l.chapters)) moveInto(l.chapters, dest.chaptersDir);
  if (fs.existsSync(l.progress)) moveInto(l.progress, dest.progressPath);
  // ★★ 日额度账本是**账号级**的（data/daily.json），老布局的 daily 本来就在那儿 ——
  //   **完全不搬**。这里曾经写过"把 daily 也搬进书目录"的逻辑，
  //   自从 pathsOf().dailyPath 指向共享账本后，两者是同一个文件；
  //   更糟的是：test-books 的迁移测试用临时 baseDir 时，老账本在 TMP 里、
  //   目标却是**真实的 data/daily.json** → 一跑测试就把用户的今日账本覆盖了
  //   （2026-10-05 真实事故，9899 字的账被测试数据盖掉，靠 progress 补账才救回来）。
  //   账号级的东西不属于任何一本书，迁移时谁也不该动它。

  // book.json：把 config.json 里写死的书名/地址带过来，保证行为和迁移前完全一致
  if (!fs.existsSync(dest.bookJsonPath)) {
    let cfg = opts.config;
    if (!cfg) {
      try {
        cfg = require('./config').loadConfig({ silent: true });
      } catch (_) {
        cfg = { site: {} };
      }
    }
    const site = cfg.site || {};
    // ★ 文件夹名用外面明确给的这个（cli 传的就是 config 的 site.bookName）；
    //   而"番茄后台的书名"以 config 为准 —— 它才是权威来源
    createBook(
      wantName,
      {
        bookName: site.bookName || normalizeName(opts.bookName) || wantName,
        bookUrl: site.bookUrl || '',
        createChapterUrl: site.createChapterUrl || '',
      },
      baseDir
    );
  }

  // 校验：条数必须一致，否则停在这里让人来看备份
  const after = describeBook(wantName, baseDir);
  const problems = [];
  if (after.published !== before.progress) {
    problems.push(`发布记录条数对不上：搬之前 ${before.progress} 条，搬之后 ${after.published} 条`);
  }
  if (after.total !== before.chapters) {
    problems.push(`拆分的章节数对不上：搬之前 ${before.chapters} 章，搬之后 ${after.total} 章`);
  }
  if (problems.length) {
    throw new Error(
      '迁移校验不通过，已停在原地（原件都在备份里，没丢）：\n  · ' +
        problems.join('\n  · ') +
        `\n备份位置：${backupDir}`
    );
  }

  setCurrent(wantName, baseDir);
  log.ok(`迁移完成：books\\${wantName}\\（${after.published} 条发布记录、${after.total} 章）`);
  log.info(`备份留了一份在：${backupDir} —— 确认没问题后可以删掉`);
  return after;
}

/**
 * ★ 各命令的统一入口：必要时迁移老布局，然后激活"当前这本"。
 *
 * @param {object} cfg  loadConfig() 的结果（会被就地改写成"这本书"的配置）
 * @param {object} opts.book  显式指定书名（--book）
 */
function ensureReady(cfg, logger, opts = {}) {
  const baseDir = opts.baseDir;
  const list = listBooks(baseDir);

  // 老布局（根目录还有 novel.txt/chapters/progress.json）→ 先搬
  if (!list.length && legacyPresent()) {
    migrateLegacy(logger, { baseDir, bookName: opts.book || (cfg.site && cfg.site.bookName) });
  }

  const book = activate(opts.book || null, baseDir);
  applyBookToConfig(cfg, book);
  return book;
}

module.exports = {
  BOOKS_DIRNAME,
  CURRENT_FILE,
  BOOK_JSON,
  DEFAULT_SOURCE,
  booksRoot,
  normalizeName,
  bookDir,
  pathsOf,
  describeBook,
  listBooks,
  currentName,
  setCurrent,
  clearCurrent,
  summarize,
  pendingOf,
  resolveBook,
  applyBookToConfig,
  activate,
  createBook,
  migrateDailyLedgers,
  legacyPaths,
  legacyPresent,
  migrateLegacy,
  ensureReady,
};
