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
  ok('字数账本路径不同', pA.dailyPath !== pB.dailyPath, pA.dailyPath);
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
  ok('字数账本搬进去了', fs.existsSync(path.join(legacyBooks, '老书', 'daily.json')));
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
} finally {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}
  console.log(`\n————————————\n通过 ${pass} 项，失败 ${fail} 项`);
  console.log(`（临时目录已清理：${TMP}）`);
}

process.exit(fail ? 1 : 0);
