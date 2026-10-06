/**
 * 多书定位 + 全书最大章节号 —— 实测（纯只读，不会建草稿）
 *
 * 为什么要专门测：
 *   `applyResolvedBook()` 现在在 `run()` 的关键路径上，每次发布都会先跑一遍。
 *   如果它解析错了，要么发到别的书，要么退回写死地址 —— 但**都没验过**。
 *
 * 用例：
 *   1. resolveBook 正常路径：按 bookName 定位到正确书籍，返回正确 bookId
 *   2. 书名不存在：应返回 null 并给提示（不是抛异常、不是瞎猜一本）
 *   3. applyResolvedBook 正常覆盖：cfg.site 的地址应被换成解析结果
 *   4. applyResolvedBook 的"写死地址指向另一本书"告警路径
 *   5. bookName 为空：应跳过定位，保留写死地址
 *   6. getMaxChapterNo：必须读到**全书**最大值（不是某一卷内的最大值）
 *      —— 这是修过的 bug：章节管理页会按当前选中的卷筛选
 *
 * 只访问「作品管理页」，不碰创建章节页 → 不会产生草稿壳。
 */
const path = require('path');
const { loadConfig } = require('../src/config');
const { resolveBook, getMaxChapterNo, listBooks, readCards } = require('../src/site-reader');
const { ensureLoggedIn, applyResolvedBook } = require('../src/publisher');
const { openBrowser, currentBook, bookIdFromUrl } = require('./_shared');

const ROOT = path.resolve(__dirname, '..');
/* ★ 不写死书籍 ID / 书名 —— 那是**个人数据**（指向某账号下的某一本书）。
   从 books\ 下挑一本"写了地址（能拿到书籍 ID）"的书来测。
   ★ 多书模式下 book.json 的地址允许留空（定位靠 bookName，2026-10-06 改的），
     所以不能只看"当前那本" —— 当前那本可能恰好是地址留空的。
     一本都没有就退回环境变量 BOOK_URL。 */
const _CUR_BOOK = (() => {
  try {
    const booksMod = require('../src/books');
    for (const b of booksMod.listBooks()) {
      // createChapterUrl 是 /writer/<id>/publish，bookUrl 是 /writer/chapter-manage/<id>… —— 两个都要试
      for (const url of [String(b.createChapterUrl || ''), String(b.bookUrl || '')]) {
        if (/\/writer\/\d+/.test(url)) return { bookName: b.bookName, createChapterUrl: url, bookUrl: url };
      }
    }
  } catch (_) {}
  return currentBook();
})();
const REAL_BOOK_ID = bookIdFromUrl(_CUR_BOOK);
const REAL_BOOK_NAME = _CUR_BOOK.bookName;

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log('  ✅ ' + msg);
  } else {
    fail++;
    console.log('  ❌ ' + msg);
  }
};

/** 收集日志，方便断言"有没有给出应有的警告" */
function makeLogger() {
  const lines = [];
  const push = (tag) => (m) => lines.push(`${tag} ${m}`);
  return {
    lines,
    text: () => lines.join('\n'),
    debug: push('[D]'),
    info: push('[I]'),
    warn: push('[W]'),
    error: push('[E]'),
    step: push('[S]'),
    ok: push('[OK]'),
    fail: push('[FAIL]'),
  };
}

(async () => {
  const { ctx } = await openBrowser('test-resolve-book');
  const page = ctx.pages()[0] || (await ctx.newPage());

  try {
    const cfg = loadConfig();
    console.log('=== 登录 ===');
    const lg = makeLogger();
    await ensureLoggedIn(page, cfg, lg, { interactive: true });
    console.log('  已登录');

    /* ---------- 0. listBooks ---------- */
    console.log('\n=== [0] listBooks：列出账号里的作品 ===');
    const lb = makeLogger();
    const books = await listBooks(page, cfg, lb);
    console.log(`  读到 ${books.list.length} 本：`);
    books.list.forEach((b) =>
      console.log(`    「${b.titleGuess}」 id=${b.bookId} 最新章节=${b.lastChapterNo} 总章数=${b.totalChapters} exact=${b.exact}`)
    );
    ok(books.list.length >= 1, `至少读到 1 本书（实得 ${books.list.length}）`);
    ok(
      books.list.some((b) => b.bookId === REAL_BOOK_ID),
      `读到的 bookId 包含 ${REAL_BOOK_ID}`
    );

    /* ---------- 1. resolveBook 正常路径 ---------- */
    console.log('\n=== [1] resolveBook 正常路径 ===');
    const l1 = makeLogger();
    // ★ 多书模式：config.json 的 site.bookName 已清空（书名在 book.json 里），
    //   所以这里必须显式把 REAL_BOOK_NAME 塞进 site —— 和发布时的 cfg 形状一致
    const r1 = await resolveBook(page, { ...cfg, site: { ...cfg.site, bookName: REAL_BOOK_NAME } }, l1);
    console.log(l1.text().split('\n').map((s) => '    ' + s).join('\n'));
    ok(!!r1, '返回了结果（不是 null）');
    if (r1) {
      ok(r1.bookId === REAL_BOOK_ID, `bookId 正确（${r1.bookId}）`);
      ok(
        r1.createChapterUrl === `https://fanqienovel.com/main/writer/${REAL_BOOK_ID}/publish/`,
        `createChapterUrl 拼对了：${r1.createChapterUrl}`
      );
      ok(r1.chapterManageUrl.includes(`/chapter-manage/${REAL_BOOK_ID}&`), `章节管理页地址带上了 bookId`);
      ok(r1.lastChapterNo > 0, `读到了最新章节号：第 ${r1.lastChapterNo} 章`);
    }

    /* ---------- 2. 书名不存在 ---------- */
    console.log('\n=== [2] 书名不存在 → 应干净地返回 null 并提示 ===');
    const l2 = makeLogger();
    const r2 = await resolveBook(page, { ...cfg, site: { ...cfg.site, bookName: '这本小说根本不存在' } }, l2);
    console.log(l2.text().split('\n').map((s) => '    ' + s).join('\n'));
    ok(r2 === null, '返回 null');
    ok(/没在作品管理页找到作品/.test(l2.text()), '给出了"没找到作品"的警告');
    ok(!/TypeError|undefined|Cannot read/.test(l2.text()), '没有抛异常');

    /* ---------- 3. applyResolvedBook 正常覆盖 ---------- */
    console.log('\n=== [3] applyResolvedBook：正常覆盖写死地址 ===');
    const cfg3 = JSON.parse(JSON.stringify(cfg));
    // ★ 多书模式：书名来自 book.json，必须显式给（发布时 applyBookToConfig 会做同样的事）
    cfg3.site.bookName = REAL_BOOK_NAME;
    // 故意先塞一个错的 bookId，看它会不会被纠正
    cfg3.site.createChapterUrl = 'https://fanqienovel.com/main/writer/9999999999999999999/publish/';
    cfg3.site.bookUrl = 'https://fanqienovel.com/main/writer/chapter-manage/9999999999999999999&x?type=1';
    const l3 = makeLogger();
    const r3 = await applyResolvedBook(page, cfg3, l3);
    console.log(l3.text().split('\n').map((s) => '    ' + s).join('\n'));
    ok(!!r3 && r3.bookId === REAL_BOOK_ID, '解析到了正确的书');
    ok(cfg3.site.createChapterUrl.includes(`/${REAL_BOOK_ID}/publish/`), `createChapterUrl 已被覆盖为正确的书`);
    ok(cfg3.site.bookUrl.includes(`chapter-manage/${REAL_BOOK_ID}`), 'bookUrl 已被覆盖为正确的书');
    ok(cfg3.site.bookId === REAL_BOOK_ID, `cfg.site.bookId 已写入（${cfg3.site.bookId}）`);
    ok(/指向的是另一本书/.test(l3.text()), '★ 给出了"写死地址指向另一本书"的告警');

    /* ---------- 4. bookName 为空 ---------- */
    console.log('\n=== [4] bookName 为空 → 跳过定位，保留写死地址 ===');
    const cfg4 = JSON.parse(JSON.stringify(cfg));
    cfg4.site.bookName = '';
    cfg4.site.createChapterUrl = 'https://fanqienovel.com/main/writer/8888888888888888888/publish/';
    const l4 = makeLogger();
    const r4 = await applyResolvedBook(page, cfg4, l4);
    console.log(l4.text().split('\n').map((s) => '    ' + s).join('\n'));
    ok(r4 === null, '返回 null（跳过定位）');
    ok(
      cfg4.site.createChapterUrl === 'https://fanqienovel.com/main/writer/8888888888888888888/publish/',
      '写死地址没有被改动'
    );

    /* ---------- 5. autoFindBook = false ---------- */
    console.log('\n=== [5] autoFindBook = false → 完全不定位 ===');
    const cfg5 = JSON.parse(JSON.stringify(cfg));
    cfg5.site.autoFindBook = false;
    const keep = cfg5.site.createChapterUrl;
    const l5 = makeLogger();
    const r5 = await applyResolvedBook(page, cfg5, l5);
    ok(r5 === null, '返回 null');
    ok(cfg5.site.createChapterUrl === keep, '地址没被改动');
    ok(/autoFindBook = false/.test(l5.text()), '日志说明了原因');

    /* ---------- 6. getMaxChapterNo 必须是全书最大值 ---------- */
    console.log('\n=== [6] getMaxChapterNo：必须是全书最大（不是卷内最大） ===');
    const cfg6 = JSON.parse(JSON.stringify(cfg));
    const l6 = makeLogger();
    const max = await getMaxChapterNo(page, cfg6, l6);
    console.log(l6.text().split('\n').map((s) => '    ' + s).join('\n'));
    ok(max >= 28, `读到全书最大章节号 ${max}（应 >= 28）`);
    // 反证：去**章节管理页**读，如果当前选中的是第二卷，会读到 28；如果切到第一卷就会读到 20
    const volumeScoped = await page.evaluate(() => {
      const t = document.body ? document.body.innerText : '';
      const nums = [...t.matchAll(/第\s*([0-9]{1,5})\s*[章节回]/g)].map((m) => Number(m[1]));
      return nums.length ? Math.max(...nums) : 0;
    });
    console.log(`  （对照：此刻页面上的最大章节号 = ${volumeScoped}）`);
    ok(
      cfg6.site.bookName === '' || l6.text().includes('作品管理页'),
      '读的是作品管理页（全书汇总），不是被卷筛选过的章节管理页'
    );

    /* ---------- 7. ★★ 回归：2026-10-06 发错书事故 ---------- */
    /* 事故：目标书不是第一张时，从第一张书的链接往上爬会爬到"同时包着两张卡的
       列表容器"—— 它的 innerText 里含目标书名 → 容器被当成书卡 →
       容器里第一个章节链接（第一本书）被当成命中 → 章节发进了别人的书。
       用合成 DOM 复现：第一本书排第一、目标书排第二，外面包一个共享容器。 */
    console.log('\n=== [7] 回归：两张书卡共享一个容器时，必须各自匹配各自的 ===');
    const INCIDENT_HTML = `<!DOCTYPE html><html><body>
      <div class="list">
        <div class="book-item">
          <div class="book-item-info">
            <a href="/main/writer/chapter-manage/111&amp;x?type=1">章节管理</a>
            <span class="title">星海拾荒客</span>
            <span>最近更新：第 43 章 · 43 章</span>
          </div>
        </div>
        <div class="book-item">
          <div class="book-item-info">
            <a href="/main/writer/chapter-manage/222&amp;y?type=1">章节管理</a>
            <!-- 故意放两个指向同一本书的链接：书卡里有重复链接不该被当成"包着多本书" -->
            <a href="/main/writer/chapter-manage/222&amp;y?type=2">数据</a>
            <span class="title">山南遗事</span>
            <span>0 章</span>
          </div>
        </div>
      </div>
    </body></html>`;
    await page.setContent(INCIDENT_HTML);
    const WANT = '山南遗事';
    const hit = await page.evaluate(readCards, WANT);
    ok(!!hit && hit.count >= 1, '能读到候选卡片');
    ok(hit.best && hit.best.bookId === '222',
      `★ 目标书排第二也要定位到它（bookId=${hit.best && hit.best.bookId}）`);
    ok(!(hit.all || []).some((c) => c.bookId === '111'),
      '★ 第一本书（示例书A）绝不能出现在候选里');
    ok(hit.best && hit.best.exact === true, '命中的是精确匹配');
    ok(hit.best && hit.best.totalChapters === 0, '新书卡（0 章）也能读出来');
    // 反向：找第一本也得对
    const hitBack = await page.evaluate(readCards, '星海拾荒客');
    ok(hitBack.best && hitBack.best.bookId === '111',
      `反向定位也正确（bookId=${hitBack.best && hitBack.best.bookId}）`);
  } finally {
    await ctx.close().catch(() => {});
  }

  console.log('\n================ 汇总 ================');
  console.log(`${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('实测失败: ' + e.message);
  process.exit(1);
});
