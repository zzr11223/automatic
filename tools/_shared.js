/**
 * tools/ 下诊断脚本共用的浏览器启动。
 *
 * ★ 别在各个脚本里自己写 `chromium.launchPersistentContext(..., {channel:'chrome'})` ——
 *   那样每加一个脚本就多一处"只认 Chrome"的硬编码。
 *   统一走 src/browser.js，用哪个浏览器由 config.json 自动挑
 *   （见 tools/test-browser-detect.js 和 node src/cli.js browsers）。
 *
 * 用法：
 *   const { openBrowser } = require('./_shared');
 *   const { ctx, cfg, logger } = await openBrowser('my-diag');
 *
 * 已经自己 loadConfig()/createLogger() 过的脚本，把现成的传进来即可（避免两套日志：
 * 启动信息跑到 A 日志里、脚本自己的输出跑到 B 日志里，排查时会对不上）：
 *   const { ctx } = await openBrowser('my-diag', { cfg, logger });
 *
 * 想用独立的登录态目录（不碰正式那份）：
 *   const { ctx } = await openBrowser('x', { userDataDir: 'userdata-probe' });
 *
 * 还提供「当前那本」的地址解析（★ 别把 bookId 写死进脚本）：
 *   const { currentBook, bookIdFromUrl, chapterManageUrl, createChapterUrl } = require('./_shared');
 *   const book = currentBook();                       // 读 books\<书名>\book.json
 *   const url  = createChapterUrl(book);              // 创建章节页
 *   const url2 = chapterManageUrl(book);              // 章节管理页（?type=1 = 已发布）
 */
const path = require('path');

async function openBrowser(name, opt = {}) {
  const { loadConfig } = require(path.join(__dirname, '..', 'src', 'config'));
  const { createLogger } = require(path.join(__dirname, '..', 'src', 'util'));
  const { launch } = require(path.join(__dirname, '..', 'src', 'browser'));

  const cfg = opt.cfg || loadConfig();
  const logger = opt.logger || createLogger(name || 'tools');
  const ctx = await launch(cfg, { logger, userDataDir: opt.userDataDir || null });
  return { ctx, cfg, logger };
}

const ROOT = path.resolve(__dirname, '..');

/**
 * 取出「当前那本」小说的信息（书名 + 番茄后台地址）。
 *
 * ★★ 为什么要有这个函数 —— 别在脚本里写死 `BOOK_ID = '1234...'`。
 *   那串数字指向**某个具体账号下的某一本书**，属于个人数据：
 *   别人 clone 下去只会拿到"别人书里的页面"，而自己跑不通。
 *   统一从这里取（读 books\<书名>\book.json），脚本对谁都可用。
 *
 * 临时覆盖：环境变量 BOOK_URL / CREATE_CHAPTER_URL
 */
function currentBook() {
  const books = require(path.join(ROOT, 'src', 'books'));
  const b = books.resolveBook(null); // 不传名字 = "当前那本"
  return {
    name: b.name,
    bookName: b.bookName,
    bookUrl: process.env.BOOK_URL || b.bookUrl || '',
    createChapterUrl: process.env.CREATE_CHAPTER_URL || b.createChapterUrl || '',
  };
}

/** 从番茄地址里抠出 bookId（`/writer/<id>/publish/` 和 `/chapter-manage/<id>&…` 都认） */
function bookIdFromUrl(x) {
  const s = typeof x === 'string' ? x : String((x && (x.createChapterUrl || x.bookUrl)) || '');
  const m = s.match(/\/writer\/(\d+)/);
  if (!m) {
    throw new Error(
      '拿不到书籍 ID：请检查 books\\<书名>\\book.json 里的 bookUrl / createChapterUrl\n' +
        '（也可以临时用环境变量 BOOK_URL 指定）'
    );
  }
  return m[1];
}

/** 番茄「章节管理页」地址（`?type=1` = 已发布列表） */
function chapterManageUrl(book, extra = '?type=1') {
  const id = bookIdFromUrl(book);
  const name = encodeURIComponent(book.bookName || '');
  return `https://fanqienovel.com/main/writer/chapter-manage/${id}&${name}${extra}`;
}

/** 番茄「创建章节」地址 */
function createChapterUrl(book) {
  if (book && book.createChapterUrl) return book.createChapterUrl;
  return `https://fanqienovel.com/main/writer/${bookIdFromUrl(book)}/publish/`;
}

module.exports = { openBrowser, currentBook, bookIdFromUrl, chapterManageUrl, createChapterUrl, ROOT };
