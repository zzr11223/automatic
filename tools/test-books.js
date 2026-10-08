/**
 * 多书支持（books/ 目录）的自测。
 *
 * 纯离线：全部在临时目录里造数据，不碰真实的 books/、不碰浏览器。
 * 跑法：node tools\test-books.js
 *
 * ★ 最要紧的一条断言在 §5：
 *   两本书各自一份 progress.json —— 否则第二本书的「第17章」会被第一本的
 *   「第17章」记录按序号命中，判成"已发布"直接跳过，**而且不报错**。
 *   这个坑是实测出来的（用真实账本跑过），不是预防性设计。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const books = require(path.join(SRC, 'books.js'));
const progress = require(path.join(SRC, 'progress.js'));

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

/* ---------------- 临时工作区 ---------------- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nap-books-test-'));
const ROOT = path.join(TMP, 'root'); // 假装的项目根目录（放老布局文件）
const BOOKS_BASE = path.join(ROOT, 'books');
fs.mkdirSync(ROOT, { recursive: true });

const silent = { info() {}, warn() {}, ok() {}, step() {} };

try {
  /* ============ 1. 书名规范化 ============ */
  section('1. 书名 → 安全的文件夹名');
  eq('普通中文书名原样保留（含全角冒号）', books.normalizeName('示例：我的第一本书'), '示例：我的第一本书');
  eq('斜杠/反斜杠换成下划线', books.normalizeName('a/b\\c'), 'a_b_c');
  eq('首尾空白去掉', books.normalizeName('  我的书  '), '我的书');
  eq('空值不炸', books.normalizeName(null), '');

  /* ============ 2. 新建一本 ============ */
  section('2. 新建一本');
  const a1 = books.createBook('甲书', {}, BOOKS_BASE);
  ok('建出了文件夹', fs.existsSync(a1.dir), a1.dir);
  ok('建出了 book.json', fs.existsSync(a1.bookJsonPath));
  eq('bookName 默认取文件夹名', a1.bookName, '甲书');
  eq('正文文件名默认 novel.txt', path.basename(a1.sourceFile), 'novel.txt');

  // 幂等：手改过 book.json 之后，再建一次不能把改动覆盖掉
  const bj = JSON.parse(fs.readFileSync(a1.bookJsonPath, 'utf8'));
  bj.bookName = '番茄后台里的真书名';
  fs.writeFileSync(a1.bookJsonPath, JSON.stringify(bj, null, 2), 'utf8');
  books.createBook('甲书', {}, BOOKS_BASE);
  eq(
    '重复新建不会覆盖已改过的 book.json',
    JSON.parse(fs.readFileSync(a1.bookJsonPath, 'utf8')).bookName,
    '番茄后台里的真书名'
  );

  const a2 = books.createBook('乙书', {}, BOOKS_BASE);

  /* ============ 3. 每本书的路径互相独立（★） ============ */
  section('3. 每本书的路径必须互不相同');
  const pA = books.pathsOf('甲书', BOOKS_BASE);
  const pB = books.pathsOf('乙书', BOOKS_BASE);
  ok('发布记录路径不同', pA.progressPath !== pB.progressPath, pA.progressPath);
  // ★ 日额度是账号级的：账本全账号只有一份，所有书指向同一个文件才是对的
  ok('★ 额度账本是全账号共用一份（不是每本书一份）', pA.dailyPath === pB.dailyPath, pA.dailyPath);
  ok('拆分目录不同', pA.chaptersDir !== pB.chaptersDir, pA.chaptersDir);
  ok('正文文件不同', pA.sourceFile !== pB.sourceFile, pA.sourceFile);
  ok('发布记录放在本书文件夹里', pA.progressPath.startsWith(pA.dir));
  ok('book.json 里的书名会覆盖文件夹名', books.pathsOf('甲书', BOOKS_BASE).bookName === '番茄后台里的真书名');

  /* ============ 4. 列书 / 选书 ============ */
  section('4. 列书与选书');
  const list = books.listBooks(BOOKS_BASE);
  eq('列出 2 本', list.length, 2);
  ok('按名字排序', list[0].name === '乙书' || list[0].name === '甲书', list.map((b) => b.name).join(','));
  ok('还没有正文时 hasSource=false', list[0].hasSource === false);

  eq('没设过当前书时 currentName 为空', books.currentName(BOOKS_BASE), '');

  let threw = '';
  try {
    books.resolveBook(null, BOOKS_BASE);
  } catch (e) {
    threw = e.message;
  }
  ok('两本书又没指定 → 报错而不是乱选一本', !!threw, threw);
  ok('报错里把两本书都列出来', threw.includes('甲书') && threw.includes('乙书'), threw);

  books.setCurrent('甲书', BOOKS_BASE);
  eq('.current 记住了', books.currentName(BOOKS_BASE), '甲书');
  eq('不指定时用 .current', books.resolveBook(null, BOOKS_BASE).name, '甲书');
  eq('显式指定优先', books.resolveBook('乙书', BOOKS_BASE).name, '乙书');

  threw = '';
  try {
    books.resolveBook('丙书', BOOKS_BASE);
  } catch (e) {
    threw = e.message;
  }
  ok('指定了不存在的书 → 报错', !!threw, threw);
  ok('报错里列出已有的书（分清"打错"和"没建"）', threw.includes('甲书'), threw);

  // 只有一本时自动选中
  const onlyBase = path.join(TMP, 'only');
  books.createBook('唯一本', {}, onlyBase);
  eq('只有一本时自动选它', books.resolveBook(null, onlyBase).name, '唯一本');

  /* ============ 5. ★★ 跨书不串号（本功能的意义） ============ */
  section('5. 跨书不串号（最要紧）');
  books.activate('甲书', BOOKS_BASE);
  ok('activate 把发布记录指到甲书', progress.getFile() === pA.progressPath, progress.getFile());
  // 故意**不传 status** —— markPublished 应该自己兜成 published（漏传会让记录不算已完成 → 重发）
  progress.markPublished('第17章 甲书里的一章', { chapterNo: 17, verified: true });
  eq(
    'markPublished 漏传 status 时兜成 published',
    progress.load().chapters['第17章 甲书里的一章'].status,
    'published'
  );

  books.activate('乙书', BOOKS_BASE);
  ok('activate 把发布记录指到乙书', progress.getFile() === pB.progressPath, progress.getFile());

  const crossHit = progress.isDone('第17章 乙书里完全不同的一章', 17);
  ok('★ 乙书的「第17章」不会被甲书的第17章误判成已发布', crossHit === false);
  eq('乙书账本还是空的', books.describeBook('乙书', BOOKS_BASE).published, 0);
  eq('甲书账本仍有 1 条', books.describeBook('甲书', BOOKS_BASE).published, 1);

  books.activate('甲书', BOOKS_BASE);
  ok('切回甲书后，它自己的第17章仍认得出', progress.isDone('第17章 甲书里的一章', 17) === true);

  // 对照：如果把两本合并成一份账本，就会串号（证明"分开"不是多余设计）
  const merged = { chapters: { '第17章 甲书里的一章': { status: 'published', chapterNo: 17, at: '' } } };
  ok(
    '对照实验：共用一份账本时确实会串号（所以必须分开）',
    progress.isDone('第17章 乙书里完全不同的一章', 17, merged) === true
  );

  /* ============ 6. 老布局迁移 ============ */
  section('6. 老布局（单书在根目录）迁移');
  const legacyRoot = path.join(TMP, 'legacy');
  const legacyBooks = path.join(legacyRoot, 'books');
  fs.mkdirSync(path.join(legacyRoot, 'data'), { recursive: true });
  fs.mkdirSync(path.join(legacyRoot, 'chapters'), { recursive: true });

  fs.writeFileSync(path.join(legacyRoot, 'novel.txt'), '第一章 起点\n\n正文正文正文\n\n第二章 继续\n\n正文正文正文\n', 'utf8');
  fs.writeFileSync(path.join(legacyRoot, 'chapters', '0001-第一章 起点.txt'), '正文正文正文', 'utf8');
  fs.writeFileSync(path.join(legacyRoot, 'chapters', '0002-第二章 继续.txt'), '正文正文正文', 'utf8');
  fs.writeFileSync(
    path.join(legacyRoot, 'chapters', 'manifest.json'),
    JSON.stringify({ count: 2, chapters: [{ seq: 1, title: '第一章 起点', file: '0001-第一章 起点.txt', chars: 6 }, { seq: 2, title: '第二章 继续', file: '0002-第二章 继续.txt', chars: 6 }] }),
    'utf8'
  );
  const legacyProgressRaw = JSON.stringify({ chapters: { '第一章 起点': { status: 'published', chapterNo: 1, at: '2026/9/27 10:25:14' }, '第二章 继续': { status: 'published', chapterNo: 2, at: '2026/9/27 10:26:00' } }, lastRun: 'x' }, null, 2);
  fs.writeFileSync(path.join(legacyRoot, 'data', 'progress.json'), legacyProgressRaw, 'utf8');
  fs.writeFileSync(path.join(legacyRoot, 'data', 'daily.json'), JSON.stringify({ date: '2026-09-27', chars: 100, chapters: [] }), 'utf8');

  ok('迁移前能识别出老布局', books.legacyPresent(legacyRoot) === true);

  const migrated = books.migrateLegacy(silent, {
    rootDir: legacyRoot,
    baseDir: legacyBooks,
    bookName: '老书',
    config: { site: { bookName: '老书在番茄的名字', bookUrl: 'u', createChapterUrl: 'c' } },
  });

  ok('迁移返回了这本书', !!migrated && migrated.name === '老书');
  ok('正文搬进去了', fs.existsSync(path.join(legacyBooks, '老书', 'novel.txt')));
  ok('拆分结果搬进去了', fs.existsSync(path.join(legacyBooks, '老书', 'chapters', 'manifest.json')));
  ok('发布记录搬进去了', fs.existsSync(path.join(legacyBooks, '老书', 'progress.json')));
  // ★ 日额度账本是账号级的：老布局的 data\daily.json 本来就在账号级位置，**不该被搬进书目录**
  ok('★ 额度账本没有被搬进书目录（它就是账号级那份）', !fs.existsSync(path.join(legacyBooks, '老书', 'daily.json')));
  ok('★ 额度账本原地未动（迁移不许碰账号级的东西）',
    fs.existsSync(path.join(legacyRoot, 'data', 'daily.json')));
  eq('发布记录还是 2 条', migrated.published, 2);
  eq('拆分的章节数还是 2 章', migrated.total, 2);
  eq('book.json 用 config 里的书名', migrated.bookName, '老书在番茄的名字');
  eq('迁移后自动设为当前小说', books.currentName(legacyBooks), '老书');

  ok('根目录的 novel.txt 已清空（是移动不是复制）', !fs.existsSync(path.join(legacyRoot, 'novel.txt')));
  ok('根目录的 chapters 已清空', !fs.existsSync(path.join(legacyRoot, 'chapters')));
  ok('老的 data/progress.json 已清空', !fs.existsSync(path.join(legacyRoot, 'data', 'progress.json')));

  const baks = fs.readdirSync(path.join(legacyRoot, 'data')).filter((f) => f.startsWith('_迁移备份-'));
  ok('留下了备份目录', baks.length === 1, baks.join(','));
  if (baks.length) {
    const bak = path.join(legacyRoot, 'data', baks[0]);
    ok('备份里有正文', fs.existsSync(path.join(bak, 'novel.txt')));
    ok('备份里有拆分结果', fs.existsSync(path.join(bak, 'chapters', 'manifest.json')));
    eq(
      '备份里的发布记录与原件逐字节一致（记录丢了就再也重建不回来）',
      fs.readFileSync(path.join(bak, 'progress.json'), 'utf8'),
      legacyProgressRaw
    );
  }

  // 幂等：老文件已经全搬走了，再跑应该是"无事可做"
  const again = books.migrateLegacy(silent, {
    rootDir: legacyRoot,
    baseDir: legacyBooks,
    bookName: '老书',
    config: { site: {} },
  });
  ok('再跑一次什么都不做（老文件已搬走，不会重复搬）', again === null);
  eq('数据没被改动', books.describeBook('老书', legacyBooks).published, 2);

  // 半迁移的保护：根目录又冒出一个 novel.txt，但书目录里已经有正文 → 不能覆盖
  fs.writeFileSync(path.join(legacyRoot, 'novel.txt'), '这份是后来冒出来的，不该覆盖已有的', 'utf8');
  const again2 = books.migrateLegacy(silent, {
    rootDir: legacyRoot,
    baseDir: legacyBooks,
    bookName: '老书',
    config: { site: {} },
  });
  ok('书目录里已有 novel.txt 时走"跳过"分支', !!again2 && again2.name === '老书');
  ok(
    '已有的正文没有被覆盖掉',
    fs.readFileSync(path.join(legacyBooks, '老书', 'novel.txt'), 'utf8').includes('第一章 起点')
  );
  fs.unlinkSync(path.join(legacyRoot, 'novel.txt'));

  /* ============ 7. 老布局不存在时不该建东西 ============ */
  section('7. 没有老布局时不动手');
  const cleanRoot = path.join(TMP, 'clean');
  fs.mkdirSync(cleanRoot, { recursive: true });
  eq('没有老文件时 legacyPresent=false', books.legacyPresent(cleanRoot), false);
  eq('迁移函数直接返回 null', books.migrateLegacy(silent, { rootDir: cleanRoot, baseDir: path.join(cleanRoot, 'books') }), null);

  /* ============ 8. 静态断言：路径必须可变 ============ */
  section('8. 静态断言（钉住设计，避免以后被改回写死）');
  const progressSrc = fs.readFileSync(path.join(SRC, 'progress.js'), 'utf8');
  const splitSrc = fs.readFileSync(path.join(SRC, 'split.js'), 'utf8');
  const dailySrc = fs.readFileSync(path.join(SRC, 'daily.js'), 'utf8');
  const booksSrc = fs.readFileSync(path.join(SRC, 'books.js'), 'utf8');

  ok('progress 的账本路径是可变的（let FILE）', /let\s+FILE\s*=/.test(progressSrc));
  ok('split 的拆分目录是可变的（let CHAPTERS_DIR）', /let\s+CHAPTERS_DIR\s*=/.test(splitSrc));
  ok('daily 的账本路径是可变的（let DAILY_PATH）', /let\s+DAILY_PATH\s*=/.test(dailySrc));
  ok('progress 导出了 setFile', /setFile/.test(progressSrc));
  ok('split 导出了 setChaptersDir', /setChaptersDir/.test(splitSrc));
  ok('daily 导出了 setFile', /setFile/.test(dailySrc));
  ok('activate 里三个路径都指过去了', /progress\.setFile/.test(booksSrc) && /split\.setChaptersDir/.test(booksSrc) && /daily\.setFile/.test(booksSrc));
  ok('这三个模块没有反向 require books（会循环依赖）', !/require\(['"]\.\/books['"]\)/.test(progressSrc + splitSrc + dailySrc));

/* ---------------- 9. 书籍概览（面板「书籍总览」用的纯函数） ---------------- */
section('9. 书籍概览 summarize / pendingOf —— 纯读，绝不改状态');
{
  const base = path.join(TMP, 'ov');
  const dir = path.join(base, '概览书');
  fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true });

  const dailyMod = require(path.join(SRC, 'daily.js'));
  // zh-CN 格式的"今天 / 昨天"（progress.json 里的 at 就是这个格式）
  const zh = (d) => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  const TODAY_AT = zh(new Date()) + ' 10:00:00';
  const YESTERDAY_AT = zh(new Date(Date.now() - 86400000)) + ' 10:00:00';

  // 造一本：3 章 / 2 卷；记录里有 1 条今天发的 + 1 条草稿 + 1 条昨天发的 + 1 条失败
  fs.writeFileSync(
    path.join(dir, 'chapters', 'manifest.json'),
    JSON.stringify({
      source: 'novel.txt',
      count: 3,
      volumes: ['第一卷：甲', '第二卷：乙'],
      chapters: [
        { seq: 1, title: '第1章 甲', file: 'a.txt', chars: 1200, volume: '第一卷：甲' },
        { seq: 2, title: '第2章 乙', file: 'b.txt', chars: 1300, volume: '第一卷：甲' },
        { seq: 3, title: '第3章 丙', file: 'c.txt', chars: 1400, volume: '第二卷：乙' },
      ],
    }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(dir, 'progress.json'),
    JSON.stringify({
      chapters: {
        // ★ 今天发的（第1章）→ summarize 的 todayChars 应该数到它
        '第1章 甲': { status: 'published', chapterNo: 1, verified: true, at: TODAY_AT },
        // 草稿：算"已发"但不进"今天发了多少字"（还没真发出去）
        '第2章 乙': { status: 'draft', chapterNo: 2, at: TODAY_AT },
        // 昨天发的：不该算进今天
        '第3章 丙': { status: 'published', chapterNo: 3, verified: true, at: YESTERDAY_AT },
        '某条对不上 manifest 的失败记录': { status: 'failed', reason: '测试用', at: TODAY_AT },
      },
      lastRun: new Date().toISOString(),
    }),
    'utf8'
  );
  // ★ 注意：这里**故意不写** daily.json —— 日额度是账号级的（data/daily.json），
  //   summarize 不该读它，测试更不该往真实的共享账本里写东西

  const book = books.describeBook('概览书', base);
  const s = books.summarize(book);

  eq('总章数 = 3（来自 manifest）', s.total, 3);
  eq('已发 = 2（第1、第3）', s.published, 2);
  eq('草稿 = 1', s.draft, 1);
  eq('★ 草稿算"已发"（不会再发一遍）→ 待发 = 0', s.pending, 0);
  eq('失败 = 1', s.failed, 1);
  eq('卷数 = 2', s.volumes.length, 2);
  eq('★ 这本今天发了 1 章（草稿不算、昨天的也不算）', s.todayChapters, 1);
  eq('★ 这本今天发的字数 = 1200（字数从 manifest 查）', s.todayChars, 1200);
  ok('最后发布时间格式是 YYYY-MM-DD HH:mm', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s.lastAt), s.lastAt);
  eq('有发布记录', s.hasProgress, true);

  const pend = books.pendingOf(book);
  eq('待发章节 = 0（第1已发、第2草稿、第3已发）', pend.length, 0);

  // ★★ 最要紧的一条：这两个函数只读，绝不能有副作用
  books.setCurrent('概览书', base);
  const before = books.currentName(base);
  const accountBefore = fs.existsSync(dailyMod.accountFile())
    ? fs.readFileSync(dailyMod.accountFile(), 'utf8')
    : null;
  books.summarize(books.describeBook('概览书', base));
  books.pendingOf(books.describeBook('概览书', base));
  ok('★★ summarize / pendingOf 不会改动 .current（只读命令不许改状态）', books.currentName(base) === before);
  ok(
    '★★ summarize / pendingOf 也不会碰账号级的共享账本 data/daily.json',
    (fs.existsSync(dailyMod.accountFile()) ? fs.readFileSync(dailyMod.accountFile(), 'utf8') : null) === accountBefore
  );

  books.clearCurrent(base);
  eq('clearCurrent 之后就是"没有当前"，而不是空字符串', books.currentName(base), '');
  books.setCurrent('概览书', base);
  eq('再 setCurrent 又回得来', books.currentName(base), '概览书');
}

/* ---------------- 10. 静态断言：--book 不许改动「当前小说」 ---------------- */
section('10. --book = 临时发另一本，不许动 books/.current');
{
  const cliSrc = fs.readFileSync(path.join(SRC, 'cli.js'), 'utf8');
  ok('cli.js 里记下了原值（prevCurrent）', /prevCurrent/.test(cliSrc));
  ok("★ 恢复挂在 process.on('exit') 上 —— 命令里大量 process.exit()，finally 轮不到执行", /process\.on\(['"]exit['"]/.test(cliSrc));
  ok('  恢复时区分了"本来有没有 current"', /clearCurrent/.test(cliSrc));

  // books.activate 会写 .current —— 上面那套恢复就是为此存在的，这条钉住这个前提
  // （activate 里现在还有迁移账本 + setSources 那几行，所以要往后多找一些）
  const bs = fs.readFileSync(path.join(SRC, 'books.js'), 'utf8');
  const i = bs.indexOf('function activate(');
  ok('★ books.activate 确实会 setCurrent（所以必须靠 cli.js 恢复）', /setCurrent\(/.test(bs.slice(i, i + 900)));
}

/* ---------------- 11. 日额度是账号级的（2026-10-05 用户确认） ---------------- */
section('11. 日额度 = 账号总额度，账本全账号只有一份');
{
  const dailySrc = fs.readFileSync(path.join(SRC, 'daily.js'), 'utf8');
  const booksSrc = fs.readFileSync(path.join(SRC, 'books.js'), 'utf8');

  ok('daily 有 accountFile()（账号级账本的唯一路径来源）', /function accountFile\(/.test(dailySrc));
  ok('★ activate 不再把账本指到某本书下面（旧写法会导致两本一起发 20000）',
    !/daily\.setFile\(book\.dailyPath\)/.test(booksSrc));
  ok('activate 会先把旧的书级账本合并进来（保住今天已经发的字数）', /migrateDailyLedgers/.test(booksSrc));
  ok('★ activate 把"全部书"告诉补账逻辑 —— 漏一本就发超', /setSources/.test(booksSrc));
  ok('★★ 老布局迁移完全不搬 daily（账号级的东西不属于任何一本书）',
    !/moveInto\(l\.daily/.test(booksSrc));
  ok('summarize 不再读每本书自己的 daily.json（额度不是按书算的）',
    !/readJsonFile\(book\.dailyPath\)/.test(booksSrc));
  ok('补账的来源可注入（setSources），且 books.activate 有调它', /function setSources/.test(dailySrc) && /daily\.setSources/.test(booksSrc));
}

/* ---------------- 12. 自选章节（--chapter 5,7,9） ---------------- */
section('12. 自选章节 resolveChapterSelection');
{
  const { resolveChapterSelection } = require(path.join(SRC, 'util.js'));
  // 仿《示例书A》那种"seq 和章节号错位"的书：seq 1 = 第17章
  const manifest = {
    chapters: [
      { seq: 1, title: '第17章 甲', chars: 1200 },
      { seq: 2, title: '第18章 乙', chars: 1300 },
      { seq: 3, title: '第19章 丙', chars: 1400 },
      { seq: 4, title: '第20章 丁', chars: 1500 },
    ],
  };
  const sel = (spec) => resolveChapterSelection(manifest, spec);
  const titles = (r) => r.picked.map((c) => c.title).join('|');

  eq('★ 标题序号优先：17 → 第17章（不是 seq17=第18章）', titles(sel('17')), '第17章 甲');
  eq('★ 多选乱序 → 按书中顺序输出（发布总得按顺序来）', titles(sel('20,17')), '第17章 甲|第20章 丁');
  eq('重复数字只发一次', titles(sel('17,17')), '第17章 甲');
  eq('seq 兜底：标题里没有"第3章"时按目录序号找（seq3=第19章）', titles(sel('3')), '第19章 丙');
  eq('未知章节报进 unknown（让调用方说人话）', sel('17,999').unknown.join(','), '999');
  eq('全部未知 → picked 为空', sel('998,999').picked.length, 0);
  eq('空串 → 不选任何章', sel('').picked.length, 0);
  eq('垃圾字符 → 不选任何章（别抛错，调用方好处理）', sel('abc').picked.length, 0);
  eq('带空格也能解析', titles(sel(' 17 , 19 ')), '第17章 甲|第19章 丙');
  eq('0 和负数不该出现在结果里', sel('0,-3,17').picked.map((c) => c.title).join('|'), '第17章 甲');
}

/* ---------------- 13. 平台定时发布的时间解析（--at） ---------------- */
section('13. 平台定时时间 parseScheduleTime');
{
  const { parseScheduleTime } = require(path.join(SRC, 'util.js'));
  // 固定"现在"：2026-10-08 09:30
  const NOW = new Date(2026, 9, 8, 9, 30, 0, 0);
  const p = (spec) => parseScheduleTime(spec, NOW);

  let r = p('08:00');
  ok('早于现在的时刻 → 定到明天', r.ok && r.text === '2026-10-09 08:00', r.text || r.reason);
  r = p('12:00');
  ok('晚于现在的时刻 → 就是今天', r.ok && r.text === '2026-10-08 12:00', r.text || r.reason);
  r = p('9:30');
  ok('恰好等于现在 → 也算已过 → 明天', r.ok && r.text === '2026-10-09 09:30', r.text || r.reason);
  r = p('9:5');
  ok('分钟必须两位（9:5 拒绝）', !r.ok);
  r = p('25:00');
  ok('小时超界拒绝', !r.ok && /不合法/.test(r.reason));
  r = p('2026-10-09 08:00');
  ok('完整日期时刻可用', r.ok && r.text === '2026-10-09 08:00', r.text || r.reason);
  r = p('2026/10/9 8:00');
  ok('斜杠分隔也认', r.ok && r.text === '2026-10-09 08:00', r.text || r.reason);
  r = p('2026-10-08 09:00');
  ok('指定时刻已过去 → 拒绝并说明现在几点', !r.ok && /已经过去/.test(r.reason), r.reason);
  r = p('2026-02-30 08:00');
  ok('不存在的日期拒绝', !r.ok && /不存在/.test(r.reason), r.reason);
  r = p('明天早上');
  ok('看不懂的写法 → 拒绝并给出两种正确写法', !r.ok && /08:00/.test(r.reason), r.reason);
  r = p('');
  ok('空输入拒绝', !r.ok && /空/.test(r.reason));
}

/* ---------------- 14. 后台发布记录导入的映射（sync-records / 新书自动导入） ---------------- */
section('14. 后台记录映射 planRecordImport');
{
  const { planRecordImport } = require(path.join(SRC, 'books.js'));
  // 本地拆分出的章节（示例书B式：seq 和章节号一致）
  const local = [
    { seq: 1, title: '第1章 开端' },
    { seq: 2, title: '第2章 风起' },
    { seq: 3, title: '第3章 转折' },
    { seq: 4, title: '第4章 落幕' },
  ];
  // 后台：第1~2章已发布（第2章在后台被改过标题 —— 靠章节号也要认出来）
  const platform = [
    { title: '第1章 开端', no: 1, words: 1200, status: 'published', at: '2026/10/6 10:00' },
    { title: '第2章 风起（平台改过名）', no: 2, words: 1300, status: 'published', at: '2026/10/6 10:05' },
  ];
  const plan = planRecordImport(local, platform);

  eq('配对成功的条数 = 2', plan.toMark.length, 2);
  eq('  第1章被标记', plan.toMark[0].title, '第1章 开端');
  eq('  ★ 第2章标题对不上也靠章节号认出', plan.toMark[1].title, '第2章 风起');
  eq('  发布时间用平台侧的', plan.toMark[1].at, '2026/10/6 10:05');
  eq('本地多出的章（后台没有）→ 不标记、单独列出', plan.unmatchedLocal.map((x) => x.no).join(','), '3,4');
  eq('platformOnly 为空（平台条目都被认领）', plan.platformOnly.length, 0);

  // 后台比本地多：本地只有 1~2，后台有 1~3 —— 多出来的第3章进 platformOnly
  const plan2 = planRecordImport(local.slice(0, 2), [
    { title: '第1章 开端', no: 1, status: 'published' },
    { title: '第2章 风起', no: 2, status: 'published' },
    { title: '第3章 转折', no: 3, status: 'published' },
  ]);
  eq('后台多出的章进 platformOnly（提示本地正文没导全）', plan2.platformOnly.map((x) => x.no).join(','), '3');
  eq('  此时该标记的只有 2 条', plan2.toMark.length, 2);

  // 空后台：全新书
  const plan3 = planRecordImport(local, []);
  eq('后台没章节 → 什么都不标记（从第 1 章开始发）', plan3.toMark.length, 0);

  // 标题里的数字优先于 seq（seq 错位也不怕）
  const offset = [{ seq: 1, title: '第17章 甲' }, { seq: 2, title: '第18章 乙' }];
  const pf17 = [{ title: '第17章 甲（后台版）', no: 17, status: 'published', at: '2026/10/7 09:00' }];
  const plan4 = planRecordImport(offset, pf17);
  eq('★ seq 错位的书：17 认的是标题里的第17章', plan4.toMark[0].title, '第17章 甲');
  eq('  chapterNo = 17', plan4.toMark[0].chapterNo, 17);
}

/* ---------------- 15. 单章单独定时 planScheduleForChapters ---------------- */
section('15. 逐章定时排期 planScheduleForChapters');
{
  const { planScheduleForChapters } = require(path.join(SRC, 'util.js'));
  const NOW = new Date(2026, 9, 8, 9, 30); // 2026-10-08 09:30
  const run = (spec, n) => planScheduleForChapters(spec, n, NOW);
  const texts = (r) => (r.ok ? r.schedules.map((x) => x.text).join(' | ') : 'REJECT:' + r.reason);

  // ① 单段 = 所有章同一时刻（旧行为不变）
  eq('单段时间 → 全部同刻', texts(run('08:00', 3)), '2026-10-09 08:00 | 2026-10-09 08:00 | 2026-10-09 08:00');
  // ② 多段逐章对应
  eq('两段铺 4 章 → 循环 + 顺延次日', texts(run('12:00,18:00', 4)), '2026-10-08 12:00 | 2026-10-08 18:00 | 2026-10-09 12:00 | 2026-10-09 18:00');
  eq('三段铺 3 章 → 一一对应', texts(run('12:00,15:00,21:00', 3)), '2026-10-08 12:00 | 2026-10-08 15:00 | 2026-10-08 21:00');
  // ③ 乱序段（10:00,08:00）→ 严格递增，不够晚顺延
  eq('乱序段也严格递增', texts(run('10:00,08:00', 4)), '2026-10-08 10:00 | 2026-10-09 08:00 | 2026-10-09 10:00 | 2026-10-10 08:00');
  // ④ 中文逗号也认
  eq('中文逗号分隔也认', texts(run('12:00，18:00', 2)), '2026-10-08 12:00 | 2026-10-08 18:00');
  // ⑤ 每章一个不同的时间（"单章单独"的最直接用法：几章就给几段）
  eq('每章一段 → 每章自己的时间', texts(run('12:05,12:10,12:15', 3)), '2026-10-08 12:05 | 2026-10-08 12:10 | 2026-10-08 12:15');
  // ⑥ 坏段拒绝：整条 list 里有一段不合法就整体拒绝
  let r = run('08:00,25:00', 2);
  ok('list 里有一段不合法 → 整体拒绝', !r.ok && /不合法/.test(r.reason), r.reason);
  r = run('', 2);
  ok('空输入拒绝', !r.ok && /空/.test(r.reason));
  r = run('08:00', 0);
  ok('0 章 → 空计划（不报错）', r.ok && r.schedules.length === 0);
  // ⑦ 完整日期段也支持（多段里保留日期语义，不够晚才顺延）
  eq('日期段 + 时刻段混用', texts(run('2026-10-10 08:00,12:00', 3)), '2026-10-10 08:00 | 2026-10-10 12:00 | 2026-10-11 08:00');
}

/* ---------------- 16. 静态断言：防"静默丢参数"（--at 事故）与切书恢复 ---------------- */
section('16. 静态断言：cmdPublish 转发 / 崩溃安全恢复');
{
  const PROJ = path.dirname(SRC); // ★ 真实项目根（ROOT 在这个测试里是假的临时根）
  const cliSrc = fs.readFileSync(path.join(PROJ, 'src', 'cli.js'), 'utf8');
  const booksSrc = fs.readFileSync(path.join(PROJ, 'src', 'books.js'), 'utf8');

  // ★★ 2026-10-08 事故：--at 被 cmdPublish 的白名单式转发**静默丢掉** ——
  //   解析出来了却没传给 run()，"定时发布"从 CLI/面板走一直等于"立即发布"。
  ok('cmdPublish 把 --at 转发给了 run()（at: opts.at）', /at:\s*opts\.at/.test(cliSrc));
  ok('  ★ 逐章定时也转发了（scheduleMap: opts[\'schedule-map\']）', /scheduleMap:\s*opts\['schedule-map'\]/.test(cliSrc));
  const runCall = cliSrc.slice(cliSrc.indexOf('await p.run('), cliSrc.indexOf('await p.run(') + 700);
  ok('  dryRun/all/limit/chapter/force/unattended 也都还在', ['opts.dry', 'opts.all', 'opts.limit', 'opts.chapter', 'opts.force', 'opts.unattended'].every((k) => runCall.includes(k)));

  // ★★ --book 的恢复必须崩溃安全：落盘 + 自愈（Windows 强杀不跑 Node 钩子）
  ok('--book 分支会落盘临时切换记录（writeTempSwitch）', /books\.writeTempSwitch\(/.test(cliSrc));
  ok('  正常退出时恢复并清文件（clearTempSwitch）', /books\.clearTempSwitch\(/.test(cliSrc));
  ok('  main() 启动时会自愈（healStaleCurrentSwitch）', /books\.healStaleCurrentSwitch\(logger\)/.test(cliSrc));
  ok('books.js 导出了三个函数', ['writeTempSwitch,', 'clearTempSwitch,', 'healStaleCurrentSwitch,'].every((k) => booksSrc.includes(k)));
}

/* ---------------- 17. 逐章定时映射 parseScheduleMap ---------------- */
section('17. 逐章定时映射 parseScheduleMap');
{
  const { parseScheduleMap } = require(path.join(SRC, 'util.js'));
  const NOW = new Date(2026, 9, 8, 9, 30);
  const m = (spec) => parseScheduleMap(spec, NOW);

  let r = m('8=08:00,9=12:00');
  ok('两条映射解析成功', r.ok && r.map.size === 2, r.reason);
  eq('  8 → 明天 08:00', r.map.get(8).text, '2026-10-09 08:00');
  eq('  9 → 今天 12:00', r.map.get(9).text, '2026-10-08 12:00');

  r = m('10=2026-10-12 20:30');
  ok('支持完整日期时刻', r.ok && r.map.get(10).text === '2026-10-12 20:30', r.reason);

  r = m('8=25:00');
  ok('坏时间拒绝且点明第几章', !r.ok && /第 8 章/.test(r.reason) && /不合法/.test(r.reason), r.reason);

  r = m('第8章=08:00');
  ok('坏格式拒绝并给出写法示例', !r.ok && /8=08:00/.test(r.reason), r.reason);

  r = m('8=08:00,8=09:00');
  ok('同一章写两遍拒绝', !r.ok && /两遍/.test(r.reason), r.reason);

  r = m('8=08:00，9=12:00');
  ok('中文逗号也认', r.ok && r.map.size === 2);

  r = m('');
  ok('空输入拒绝', !r.ok && /空/.test(r.reason));

  // 语义差异：逐章映射不做自动顺延（--at 多段才顺延）
  r = m('8=08:00,9=08:00');
  ok('★ 两章同一时刻允许（就是用户写的，不顺延）', r.ok && r.map.get(8).text === r.map.get(9).text, r.reason);
}

/* ---------------- 16. 静态断言：防"静默丢参数"（--at 事故）与切书恢复 ---------------- */
section('16. 静态断言：cmdPublish 转发 / 崩溃安全恢复');
{
  const cliSrc = fs.readFileSync(path.join(ROOT, 'src', 'cli.js'), 'utf8');
  const booksSrc = fs.readFileSync(path.join(ROOT, 'src', 'books.js'), 'utf8');

  // ★★ 2026-10-08 事故：--at 被 cmdPublish 的白名单式转发**静默丢掉** ——
  //   解析出来了却没传给 run()，"定时发布"从 CLI/面板走一直等于"立即发布"。
  ok('cmdPublish 把 --at 转发给了 run()（at: opts.at）', /at:\s*opts\.at/.test(cliSrc));
  const runCall = cliSrc.slice(cliSrc.indexOf('await p.run('), cliSrc.indexOf('await p.run(') + 700);
  ok('  dryRun/all/limit/chapter/force/unattended 也都还在', ['opts.dry', 'opts.all', 'opts.limit', 'opts.chapter', 'opts.force', 'opts.unattended'].every((k) => runCall.includes(k)));

  // ★★ --book 的恢复必须崩溃安全：落盘 + 自愈（Windows 强杀不跑 Node 钩子）
  ok('--book 分支会落盘临时切换记录（writeTempSwitch）', /books\.writeTempSwitch\(/.test(cliSrc));
  ok('  正常退出时恢复并清文件（clearTempSwitch）', /books\.clearTempSwitch\(/.test(cliSrc));
  ok('  main() 启动时会自愈（healStaleCurrentSwitch）', /books\.healStaleCurrentSwitch\(logger\)/.test(cliSrc));
  ok('books.js 导出了三个函数', ['writeTempSwitch,', 'clearTempSwitch,', 'healStaleCurrentSwitch,'].every((k) => booksSrc.includes(k)));
}
} finally {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}
  console.log(`\n————————————\n通过 ${pass} 项，失败 ${fail} 项`);
  console.log(`（临时目录已清理：${TMP}）`);
}

process.exit(fail ? 1 : 0);
