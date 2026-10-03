/**
 * 读取番茄后台的作品/章节信息（纯只读操作）
 *
 * ⚠️ 这里有两个"坑"，都是 2026-10 实测踩出来的：
 *
 * 1) 章节管理页会**按当前选中的卷筛选**。切到「第一卷」时页面只显示第1~20章，
 *    切到「第二卷」只显示第21~28章。所以"从章节管理页读最大章节号"是**卷内最大值**，
 *    不是全书最大值 —— 拿它做后台核对会误报。
 *    → 因此 getMaxChapterNo() 改成去**作品管理页**读（那里是全书汇总）。
 *
 * 2) 同一账号下可以有多本书。作品管理页会把它们都列出来，
 *    所以必须**按书名定位到那一本**，再拿它的 bookId 去拼地址。
 *
 * ★ 另一个已修的坑：解析函数必须写成**真函数**传给 page.evaluate，
 *   写成字符串时 Playwright 只当表达式求值（返回 undefined），函数根本不会被调用。
 *   症状是 listBooks() 直接报 "Cannot read properties of undefined"。
 */
const { waitForContent, readBody } = require('./login');

/** 书名匹配用的归一化：去掉所有空白 */
const NORM = `(s) => String(s == null ? '' : s).replace(/\\s+/g, '')`;

/**
 * 从作品管理页的"书卡"里解析出书的信息（纯 DOM 解析，不点任何东西）。
 *
 * @param {string} name 目标书名。传空字符串表示"不做名字过滤，把所有书都读出来"
 */
function readCards(name) {
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '');
  const target = norm(name);

  // 书卡锚点：卡片里一定有一个"章节管理"链接，里面带着 bookId
  const links = [...document.querySelectorAll('a[href*="/chapter-manage/"]')];
  const cands = [];

  for (const a of links) {
    const href = a.getAttribute('href') || '';
    const m = href.match(/chapter-manage\/(\d+)/);
    if (!m) continue;

    let card = null;
    if (target) {
      // 从链接往上找"最近的一个 innerText 里含书名"的祖先，就是这张书卡
      let p = a.parentElement;
      for (let i = 0; i < 8 && p; i++, p = p.parentElement) {
        const txt = p.innerText || '';
        if (txt.length > 3000) break; // 别一路爬到 body
        if (norm(txt).includes(target)) {
          card = p;
          break;
        }
      }
    } else {
      // 不做名字过滤：用最像"卡片"的祖先
      card =
        a.closest('[class*="book-item"],[class*="card"],[class*="book-item-info"],li,article') ||
        (() => {
          let p = a;
          for (let i = 0; i < 4 && p.parentElement; i++) p = p.parentElement;
          return p;
        })();
    }
    if (!card) continue;

    const text = String(card.innerText || '').trim();

    // 书卡里有没有"文字恰好等于书名"的节点 —— 书名有包含关系时用它选最准的那张
    // 注意：不要限定"叶子节点"（el.children.length === 0）。
    // 番茄的书名外面还包了一层，叶子里拿不到完整书名；对任意祖先元素比 textContent 更可靠。
    const exact = target
      ? [...card.querySelectorAll('*')].some((el) => norm(el.textContent) === target)
      : false;

    // 最近更新：第28章 xxx
    const lastM = text.match(/最近更新[：:]\s*第\s*([0-9]{1,5})\s*章/);
    // 总章数：如「28 章」
    const cntM = text.match(/([0-9]{1,5})\s*章/);
    // 创建章节链接
    const createA = card.querySelector('a[href*="/publish/"]');

    cands.push({
      bookId: m[1],
      href,
      exact,
      // 书卡第一行一般是书名
      titleGuess: (text.split('\n')[0] || '').slice(0, 40),
      lastChapterNo: lastM ? Number(lastM[1]) : 0,
      totalChapters: cntM ? Number(cntM[1]) : 0,
      text: text.slice(0, 200),
      createHref: createA ? createA.getAttribute('href') : '',
    });
  }

  // 书名完全相同的那张优先
  cands.sort((x, y) => (y.exact ? 1 : 0) - (x.exact ? 1 : 0));
  return { count: cands.length, best: cands[0] || null, all: cands };
}

/** 打开作品管理页并等它渲染完 */
async function openBookManage(page, cfg, logger) {
  const home = cfg.site.writerHome;
  logger.info('打开作品管理页：' + home);
  await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await waitForContent(page, { tries: 15, gap: 1200 });
  await page.waitForTimeout(4000);
  return home;
}

/**
 * 去作品管理页，把账号里的书都读出来（只读）。
 * @returns {Promise<{list:Array, url:string}>}
 */
async function listBooks(page, cfg, logger) {
  await openBookManage(page, cfg, logger);
  const r = await page.evaluate(readCards, '');
  const list = (r && r.all) || [];

  if (!list.length) {
    logger.warn('页面上一个作品都没读到 —— 可能没登录，或者番茄的页面结构变了');
  } else {
    logger.ok(`读到 ${list.length} 个作品`);
  }
  return { list, url: page.url() };
}

/**
 * ★ 多书支持的核心：按 config 里的书名，定位到正确的那本书。
 *
 * 找不到就返回 null，调用方会退回 config 里写死的地址（不会瞎发到别的书上）。
 *
 * @returns {Promise<{bookId:string,bookName:string,chapterManageUrl:string,createChapterUrl:string,lastChapterNo:number,totalChapters:number}|null>}
 */
async function resolveBook(page, cfg, logger) {
  const want = String((cfg.site && cfg.site.bookName) || '').trim();
  if (!want) {
    logger.info('这本书的 book.json 里没填 bookName —— 不做作品定位，直接用写死的地址');
    return null;
  }

  try {
    logger.info(`在作品管理页按书名定位作品：「${want}」`);
    await openBookManage(page, cfg, logger);

    const r = await page.evaluate(readCards, want);
    const best = r && r.best;

    if (!best) {
      logger.warn(`没在作品管理页找到作品「${want}」`);
      // ★ 再把所有书列一遍，好告诉用户"后台到底有哪些书" ——
      //   否则用户只会看到"没找到"，根本不知道是书名打错了还是没登录
      try {
        const allR = await page.evaluate(readCards, '');
        const all = (allR && allR.all) || [];
        if (all.length) {
          logger.warn(`  账号里现有 ${all.length} 本书：`);
          for (const b of all) logger.warn(`    · 「${b.titleGuess || '(读不到书名)'}」  （第 ${b.lastChapterNo || 0} 章 / 共 ${b.totalChapters || 0} 章）`);
          logger.warn(`  你填的 site.bookName 是「${want}」—— 和上面哪个都不一样。`);
          logger.warn('  请把书名**原样**填进 config.json（可以跑 node src\\cli.js books 看准确书名）。');
        } else {
          logger.warn('  页面上一个作品都没读到 —— 可能是没登录，或番茄的页面结构变了');
        }
      } catch (_) {
        logger.warn('  想列出后台现有作品时出错了，跳过这一步');
      }
      return null;
    }

    if (!best.exact && ((r && r.all) || []).length > 1) {
      logger.warn(`书名「${want}」不是精确匹配，是按包含关系挑的：命中「${best.titleGuess}」`);
    }

    const bookId = best.bookId;
    const out = {
      bookId,
      bookName: want,
      // 章节管理页地址（读后台章节用）
      chapterManageUrl: `https://fanqienovel.com/main/writer/chapter-manage/${bookId}&${encodeURIComponent(want)}?type=1`,
      // 创建章节页地址（发布用）
      createChapterUrl: `https://fanqienovel.com/main/writer/${bookId}/publish/`,
      lastChapterNo: best.lastChapterNo || 0,
      totalChapters: best.totalChapters || 0,
    };

    const extra = out.lastChapterNo ? `，后台最新章节：第 ${out.lastChapterNo} 章` : '';
    logger.ok(`已定位作品「${want}」（bookId=${bookId}${extra}）`);
    return out;
  } catch (e) {
    logger.warn('定位作品失败：' + String(e.message).split('\n')[0]);
    return null;
  }
}

/**
 * 解析出后台已有章节的最大序号（全书范围）。下一章要发的序号 = 返回值 + 1。
 *
 * ★ 为什么要读作品管理页而不是章节管理页：
 *   章节管理页是**按当前选中的卷筛选**的，只读它拿到的是"这一卷里的最大号"。
 *   作品管理页的每张书卡上写着全书汇总（最近更新：第N章 / 共N章），才是对的。
 */
async function getMaxChapterNo(page, cfg, logger) {
  const want = String((cfg.site && cfg.site.bookName) || '').trim();
  const home = cfg.site.writerHome || cfg.site.bookUrl;

  try {
    if (want) {
      logger.info('读取后台已有章节信息（作品管理页，全书汇总）');
      await openBookManage(page, cfg, logger);

      const r = await page.evaluate(readCards, want);
      const best = r && r.best;
      if (best && best.lastChapterNo > 0) {
        logger.info(
          `后台已有章节最大序号：${best.lastChapterNo}（第 ${best.lastChapterNo + 1} 章是下一章）` +
            (best.totalChapters ? `，全书共 ${best.totalChapters} 章` : '')
        );
        return best.lastChapterNo;
      }
      logger.warn(`从作品「${want}」的书卡里没读到章节号，退回按页面文字统计`);
      if (page.url() !== home) {
        await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await waitForContent(page, { tries: 15, gap: 1200 });
        await page.waitForTimeout(4000);
      }
    } else {
      await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await waitForContent(page, { tries: 15, gap: 1200 });
      await page.waitForTimeout(4000);
    }

    // 兜底：读页面上所有「第N章」，取最大
    const txt = await readBody(page, 40000);
    const nums = [...txt.matchAll(/第\s*([0-9]{1,5})\s*[章节回]/g)]
      .map((m) => Number(m[1]))
      .filter((n) => n > 0 && n < 100000);

    const max = nums.length ? Math.max(...nums) : 0;
    logger.info(`后台已有章节最大序号：${max}（下一章为第 ${max + 1} 章）`);
    return max;
  } catch (e) {
    logger.warn('读取后台章节序号失败：' + String(e.message).split('\n')[0]);
    return 0;
  }
}

module.exports = { getMaxChapterNo, resolveBook, listBooks, readCards, NORM };
