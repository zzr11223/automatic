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
const { parseChapterNoFromTitle } = require('./util');

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
          // ★★ 包着 ≥2 本书的 = 列表容器，不是书卡；再往上只会更大，直接放弃这条链接。
          //   （2026-10-06 真实事故：目标书不是第一张时，从第一张书的链接往上爬
          //     会爬到同时包着两张卡的列表容器 —— 它的 innerText 里当然含目标书名 ——
          //     容器被当成书卡，容器里第一个章节链接（= 第一本书）被当成命中，
          //     章节就这么发进了别人的书里。而日志只回显"要找的名字"，看着像成功了。）
          const ids = new Set(
            [...p.querySelectorAll('a[href*="/chapter-manage/"]')]
              .map((x) => ((x.getAttribute('href') || '').match(/chapter-manage\/(\d+)/) || [])[1])
              .filter(Boolean)
          );
          if (ids.size > 1) break;
          card = p;
          break;
        }
      }
      // 爬到头也没有"只属于这一本书、又含书名"的祖先 → 这个书名不属于这条链接
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
    // ★ 日志必须带上**实际匹配到的卡片标题** —— 只回显"要找的名字"的话，
    //   匹配错了也看不出来（2026-10-06 发错书的事故就是这样，日志看着完全正常）
    logger.ok(
      `已定位作品「${want}」→ 实际匹配卡片「${best.titleGuess || '(读不到)'}」（bookId=${bookId}${extra}）`
    );
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

/**
 * ★★ 从番茄作者后台的 JSON 接口拉取这本书的**全部章节**（含已发布/审核中/定时）。
 *
 * 为什么不用章节管理页的 HTML 表格：那个页面有分卷筛选 + 分页，解析又脆又漏
 * （实测 示例书A 43 章只显示最近 7 条）。
 *
 * 后台接口（2026-10-07 实测，浏览器登录态直接可用，ctx.request 自动带 cookie）：
 *   GET /api/author/volume/volume_list/v1?aid=2503&app_name=muye_novel&book_id=<id>
 *     → data.volume_list: [{ volume_id, volume_name, item_count }]
 *   GET /api/author/chapter/chapter_list/v1?aid=2503&app_name=muye_novel&book_id=<id>&volume_id=<vid>&page_index=0&page_count=100
 *     → data.total_count + data.item_list: [{ title, word_number, article_status, timer_time, create_time }]
 *
 * ★★ 实测要点：
 *   · **不带 volume_id 只返回一个卷**的章节 —— 必须逐卷拉
 *   · 一卷一次 page_count=100 就能拿全（实测 page_index 参数无效，每页都从头返回；
 *     目前单卷最多 20 章，远够。哪天单卷超 100 章再回来补真翻页）
 *   · 章节号要从 title 里解析（item.index 是平台内部排序值，不是章节号）
 *   · article_status=1 = 已发布；timer_time 非空 = 定时发布中
 *
 * @param {BrowserContext} ctx  已登录的浏览器上下文（request 共享 cookie）
 * @param {object} cfg  site.bookId 必须已由 applyResolvedBook 填好
 * @param {Logger} logger
 * @returns {{volumes: {name: string, count: number}[], chapters: {title: string, no: number, words: number, status: string, timer: string, at: string}[]}}
 */
async function fetchPlatformChapters(ctx, cfg, logger) {
  const bookId = String((cfg.site && cfg.site.bookId) || '');
  if (!bookId) throw new Error('还没有书籍 ID —— 请先按书名定位作品（sync-records 流程里会自动做）');
  const base = 'https://fanqienovel.com';
  const jget = async (pathQs) => {
    const res = await ctx.request.get(base + pathQs, { timeout: 30000 });
    const j = await res.json().catch(() => null);
    if (!j || j.code !== 0 || !j.data) {
      throw new Error('作者接口返回异常：' + JSON.stringify(j || {}).slice(0, 150));
    }
    return j.data;
  };

  const vd = await jget(`/api/author/volume/volume_list/v1?aid=2503&app_name=muye_novel&book_id=${bookId}`);
  const volumes = vd.volume_list || [];
  const chapters = [];
  for (const v of volumes) {
    const d = await jget(
      `/api/author/chapter/chapter_list/v1?aid=2503&app_name=muye_novel&book_id=${bookId}&volume_id=${v.volume_id}&page_index=0&page_count=100`
    );
    const its = d.item_list || [];
    const total = Number(d.total_count) || its.length;
    if (its.length < total) {
      logger.warn(`卷「${v.volume_name}」后台有 ${total} 章，接口只返回了 ${its.length} 条（超过单次上限）—— 缺的部分请到后台人工核对`);
    }
    for (const it of its) {
      const atSec = Number(it.create_time) || 0;
      const at = atSec ? new Date(atSec * 1000) : null;
      chapters.push({
        title: String(it.title || ''),
        no: parseChapterNoFromTitle(it.title),
        words: Number(it.word_number) || 0,
        status: Number(it.article_status) === 1 ? 'published' : 'other',
        timer: String(it.timer_time || ''),
        at: at
          ? `${at.getFullYear()}/${at.getMonth() + 1}/${at.getDate()} ${at.getHours()}:${String(at.getMinutes()).padStart(2, '0')}`
          : '',
      });
    }
  }
  logger.ok(
    `后台章节拉取完成：${volumes.length} 卷 / ${chapters.length} 章（${volumes.map((v) => v.volume_name + ' ' + v.item_count + '章').join('、')}）`
  );
  return { volumes: volumes.map((v) => ({ name: v.volume_name, count: Number(v.item_count) || 0 })), chapters };
}

module.exports = {
  getMaxChapterNo,
  resolveBook,
  listBooks,
  readCards,
  fetchPlatformChapters,
  NORM,
};
