/**
 * 发布前自检
 *
 * 把所有"会导致白跑一趟"的问题提前查出来：
 * 环境、配置、小说文件、章节拆分、字数门槛、标题长度、账号配置。
 * 加 --online 还会开浏览器检查登录态是否有效。
 */
const fs = require('fs');
const path = require('path');

const { ROOT, resolvePath, countChars, stripChapterPrefix, createLogger } = require('./util');
const { loadConfig } = require('./config');
const { loadManifest, loadChapterBody, getChaptersDir } = require('./split');
const { loadCredentials, maskPhone } = require('./credentials');
const progress = require('./progress');
const daily = require('./daily');
const books = require('./books');

/** 相对项目根目录的短路径 */
function rel(p) {
  const r = path.relative(ROOT, p);
  return r && !r.startsWith('..') ? r : p;
}

/** 自检时用来"静默试算"的假 logger —— 试算过程不需要把每一步都打给用户 */
const silentLogger = { info() {}, warn() {}, ok() {}, fail() {}, step() {} };

/**
 * 惰性引入"本次会发哪几章"的规划函数。
 * ⚠️ 不能在文件顶层 require('./publisher')：它会连带加载 playwright-core，
 * 而"依赖没装"正是自检要检出的问题之一 —— 顶层引入会让自检本身直接崩掉。
 *
 * ★ 用的是 publisher 里的 `planNextRun`（不是自己拼 applyDailyQuota 的参数）——
 *   面板也会调同一个函数，这样"自检说的"和"面板显示的"永远一致。
 */
function quotaPlanner() {
  return require('./publisher').planNextRun;
}

const R = { ok: '[OK]  ', warn: '[WARN]', fail: '[FAIL]', info: '[--]  ' };

function makeReport() {
  const lines = [];
  const push = (tag, msg) => lines.push(`${R[tag]} ${msg}`);
  return { lines, push };
}

async function preflight(cfg, { online = false, logger = createLogger() } = {}) {
  const { lines, push } = makeReport();
  let fatal = 0;
  let warns = 0;

  push('info', '===== 发布前自检 =====');
  lines.push('');

  /* ---------- 1. 环境 ---------- */
  push('ok', `Node 版本：${process.version}`);

  let depOk = true;
  try {
    require.resolve('playwright-core');
  } catch (_) {
    depOk = false;
  }
  if (depOk) push('ok', '依赖已安装（playwright-core）');
  else {
    push('fail', '依赖没装 —— 请先双击「0-安装依赖.bat」');
    fatal++;
  }

  const nodeMajor = Number(process.version.replace('v', '').split('.')[0]);
  if (nodeMajor < 18) {
    push('fail', `Node 版本太低（${process.version}），需要 18 以上`);
    fatal++;
  }

  /* ---------- 2. 配置 ---------- */
  let cfgOk = true;
  try {
    loadConfig();
    push('ok', 'config.json 格式正确');
  } catch (e) {
    push('fail', 'config.json 有问题：' + e.message);
    cfgOk = false;
    fatal++;
  }

  /* ---------- 3. 账号 ---------- */
  let cred = null;
  try {
    cred = loadCredentials(cfg);
  } catch (e) {
    push('fail', 'credentials.json 格式错误：' + e.message);
    fatal++;
  }
  if (cred) push('ok', `账号已配置：${maskPhone(cred.phone)}`);
  else push('warn', '没有配置账号密码 —— 登录态过期时需要你手动登录一次'), warns++;

  /* ---------- 3.5 浏览器 ---------- */
  try {
    const { inspect, installCommand } = require('./browser');
    const bi = inspect(cfg);
    // ★ 依赖没装时，"系统里有哪些浏览器"照样能列出来，但一个也起不来。
    //   这时不能说 [OK] 浏览器：Chrome（用户会以为发布没问题），也不能建议去下载自带内核
    //   （那条命令现在跑必然失败）。第 1 节已经报过 [FAIL] 依赖没装，这里只需说明连带影响。
    if (!depOk) {
      push('info', '浏览器：依赖没装，暂时探测不了 —— 装完依赖再自检一次就能看到');
    } else if (bi.chain.length) {
      push('ok', `浏览器：${bi.chain[0].name}`);
      if (bi.chain.length > 1) {
        push('info', `  用不了会自动换下一个：${bi.chain.slice(1).map((c) => c.name).join(' → ')}`);
      }
      if (!bi.builtin.available) {
        push('info', `  （自带内核没下载，不影响；想下载：${installCommand(bi.engine)}）`);
      }
    } else {
      push('fail', '没有找到任何可用的浏览器 —— 发布会起不来');
      push('info', '  装个 Chrome 或 Edge；或执行 ' + installCommand(bi.engine));
      push('info', '  360/QQ 这类浏览器就把 exe 路径填到 config.json 的 browser.executablePath');
      fatal++;
    }
    if (String(cfg.browser.engine || 'chromium').toLowerCase() !== 'chromium') {
      push('warn', `  browser.engine = ${cfg.browser.engine} —— 这条通道没实测过，出问题请改回 chromium`);
      warns++;
    }
  } catch (e) {
    push('warn', '浏览器探测出错（不影响其它检查）：' + String(e.message).split('\n')[0]);
    warns++;
  }

  /* ---------- 3.8 当前小说（books/ 目录）---------- */
  {
    const all = books.listBooks();
    // cfg._book 正常是完整描述；万一拿到的是残缺对象（只有 name），就地补全再取路径
    let cur = cfg._book || null;
    if (cur && !cur.progressPath && cur.name) {
      try {
        cur = books.describeBook(cur.name);
      } catch (_) {}
    }
    if (cur && cur.progressPath) {
      push('ok', `当前小说：「${cur.name}」`);
      push('info', `  正文：${rel(cur.sourceFile)}`);
      push('info', `  发布记录：${rel(cur.progressPath)}　（每本书一份，互不串号）`);
      push('info', `  今日额度账本：${rel(cur.dailyPath)}`);
      if (!cur.hasSource) {
        push('fail', `  这本书还没有正文文件：${rel(cur.sourceFile)}`);
        fatal++;
      }
      if (all.length > 1) {
        push('info', `  books\\ 下共 ${all.length} 本：${all.map((b) => b.name).join('、')}`);
        push('info', '  要换一本：双击「11-切换当前小说.bat」');
      }
    } else {
      push('warn', '没有确定要发哪一本小说（books\\ 下为空，或没设过"当前小说"）');
      warns++;
    }
  }

  /* ---------- 4. 目标作品 ---------- */
  if (cfg.site.bookName) {
    push('ok', `目标作品：「${cfg.site.bookName}」`);
    if (cfg.site.autoFindBook === false) {
      push('warn', '  site.autoFindBook = false —— 不会按书名去后台找，直接用写死的地址');
      push('info', '  账号下只有一本书时没问题；有多本书时建议改成 true，免得发错书');
      warns++;
    } else {
      push('info', '  发布前会去作品管理页按这个书名定位作品，自动拿到它的书籍 ID（多书账号也发不错）');
    }
    if (cfg.site.createChapterUrl) {
      const id = String(cfg.site.createChapterUrl).match(/\/writer\/(\d+)\/publish/);
      if (id) push('info', `  book.json 里写死的书籍 ID：${id[1]}（按书名定位成功时会被自动覆盖）`);
    }
  } else if (cfg.site.createChapterUrl || cfg.site.bookUrl) {
    push('warn', `没填 site.bookName —— 只能用写死的地址发。账号下有多本书时容易发错书`);
    warns++;
  } else {
    push('fail', '没有指定目标作品（bookName 没填，createChapterUrl / bookUrl 也空）—— 脚本只能靠"自动找入口"，很不稳');
    fatal++;
  }

  /* ---------- 4.5 分卷 ---------- */
  const manifestEarly = loadManifest();
  if (manifestEarly && manifestEarly.chapters && manifestEarly.chapters.length) {
    const vols = [...new Set(manifestEarly.chapters.map((c) => c.volume).filter(Boolean))];
    if (vols.length) {
      if (cfg.novel.fillVolume === false) {
        push('warn', `小说里写了 ${vols.length} 个卷（${vols.join('、')}），但 novel.fillVolume = false，发布时不会切换分卷`);
        warns++;
      } else {
        push('ok', `分卷：${vols.length} 卷（${vols.join('、')}）—— 发布会自动切换`);
        push('info', '  这些卷必须是番茄后台已经建好的；没建的话脚本会停下并告诉你缺哪一卷');
      }
      const noVol = manifestEarly.chapters.filter((c) => !c.volume);
      if (noVol.length) {
        push('warn', `  有 ${noVol.length} 章没写卷，发布会沿用网页上当前的卷`);
        warns++;
      }
    } else {
      push('info', '分卷：小说里没有卷标题行，发布时沿用网页上当前选中的卷');
    }
  }

  /* ---------- 5. 小说源文件 ---------- */
  const srcPath = resolvePath(cfg.novel.sourceFile);
  let srcText = '';
  if (!fs.existsSync(srcPath)) {
    push('fail', `找不到小说文件：${cfg.novel.sourceFile} —— 把你的小说存成这个名字放在本文件夹里`);
    fatal++;
  } else {
    srcText = fs.readFileSync(srcPath, cfg.novel.encoding || 'utf8');
    const n = countChars(srcText);
    if (n < 100) {
      push('fail', `小说文件几乎没有内容（${n} 字）`);
      fatal++;
    } else {
      push('ok', `小说文件：${cfg.novel.sourceFile}（${n} 字）`);
    }
  }

  /* ---------- 6. 章节拆分 ---------- */
  let chapters = [];
  const manifest = loadManifest();
  if (!manifest || !manifest.chapters || !manifest.chapters.length) {
    push('warn', '还没有拆分过章节 —— 请先双击「2-拆分章节.bat」');
    warns++;
  } else {
    chapters = manifest.chapters;
    push('ok', `已拆分 ${chapters.length} 章（${rel(getChaptersDir())}\\ 目录）`);
  }

  /* ---------- 7. 逐章校验 ---------- */
  const isPublishMode = cfg.publish.mode !== 'draft';
  const minChars = (cfg.safety && cfg.safety.minCharsForPublish) || 1000;
  const maxChars = (cfg.safety && cfg.safety.maxCharsPerChapter) || 30000;

  const pending = chapters.filter((c) => !progress.isDone(c.title));

  if (chapters.length) {
    lines.push('');
    push('info', `----- 章节校验（当前模式：${isPublishMode ? '直接发布' : '只存草稿'}）-----`);

    const shortList = [];
    const tooLong = [];
    const titleTooLong = [];

    for (const c of chapters) {
      let body = '';
      try {
        body = loadChapterBody(c);
      } catch (_) {}
      const n = countChars(body);
      if (n < minChars) shortList.push({ c, n });
      if (n > maxChars) tooLong.push({ c, n });

      const pure = cfg.novel.stripChapterPrefix === false ? c.title : stripChapterPrefix(c.title);
      if (countChars(pure) > 30) titleTooLong.push({ c, len: countChars(pure) });
    }

    // 草稿模式不限字数，这时字数不足只是提醒；发布模式才算硬伤
    const blockingShort = isPublishMode ? shortList : [];

    if (!blockingShort.length && !tooLong.length && !titleTooLong.length) {
      push('ok', '章节字数与标题长度都合规');
    }
    for (const { c, n } of blockingShort) {
      push('warn', `「${c.title}」只有 ${n} 字，不足发布要求的 ${minChars} 字，会被跳过`);
      warns++;
    }
    if (!isPublishMode && shortList.length) {
      push('info', `提醒：有 ${shortList.length} 章不足 ${minChars} 字。`);
      push('info', '      当前是"只存草稿"模式，不受字数限制，没问题；');
      push('info', '      但切到"直接发布"模式时，这些章节会被自动跳过。');
    }
    for (const { c, n } of tooLong) {
      push('warn', `「${c.title}」有 ${n} 字，超过安全上限 ${maxChars} 字`);
      warns++;
    }
    for (const { c, len } of titleTooLong) {
      push('warn', `「${c.title}」标题 ${len} 字，超过番茄的 30 字上限`);
      warns++;
    }
  }

  /* ---------- 8. 待发布清单 ---------- */
  if (chapters.length) {
    lines.push('');

    // 日字数配额：告诉用户"这一下点下去会发几章"，避免心里没底
    if (isPublishMode && daily.isEnabled(cfg)) {
      const s = daily.summary(cfg, manifest);
      push('info', `----- 今日字数额度（点一次会发满这个额度）-----`);
      push('info', `今日（${s.date}）已发 ${s.used} / ${s.limit} 字，还剩 ${s.remain} 字`);
      for (const c of s.chapters) push('info', `  · 今天已发：${c.title}  ${c.chars} 字`);

      if (s.remain <= 0) {
        push('warn', '今天的额度已用完，现在发布不会发任何章节（明天再点）');
        warns++;
      } else if (!pending.length) {
        push('info', '没有待发布的章节 —— 所有章节都处理过了，今天不用再点');
      } else {
        // 用和发布时完全相同的算法算一遍，保证自检结论和实际行为一致
        const q = quotaPlanner()(cfg, pending, s, silentLogger);
        const total = s.used + q.chars;
        if (!q.picked.length) {
          push('warn', `剩余 ${s.remain} 字放不下下一章「${pending[0].title}」（${pending[0].chars} 字）`);
          warns++;
        } else {
          push(
            'ok',
            `现在点发布会发 ${q.picked.length} 章（共 ${q.chars} 字）：${q.picked.map((c) => c.title).join('、')}`
          );
          push('info', `发完累计 ${total} / ${s.limit} 字`);
          if (q.stopped) {
            const nx = pending[q.picked.length];
            push('info', `下一章「${nx.title}」（${nx.chars} 字）会超出额度，本次不发，留到明天`);
          }
        }
      }
      lines.push('');
    }

    push('info', `----- 待发布（${pending.length} 章）-----`);
    const doneCount = chapters.length - pending.length;
    if (doneCount > 0) push('info', `已完成 ${doneCount} 章（记录在 ${rel(progress.getFile())}）`);

    // 标题改过、但章节序号发过的 —— 说清楚，否则用户会疑惑"我改了标题怎么没重发"
    const renamed = chapters
      .map((c) => ({ c, m: progress.matchDone(c.title) }))
      .filter((x) => x.m.done && x.m.how === 'number');
    if (renamed.length) {
      push('warn', `有 ${renamed.length} 章的标题和发布记录对不上，是按「章节序号」认出已发的（所以不会重发）：`);
      for (const r of renamed) {
        push('info', `    · 第${r.m.no}章 —— 现在写的是「${r.c.title}」，账本里记的是「${r.m.by}」`);
      }
      push('info', '      确实想重发就先清记录：node src\\cli.js reset --chapter ' + renamed[0].m.no);
    }
    if (!pending.length) {
      push('info', '没有待发布的章节 —— 所有章节都处理过了');
    } else {
      const show = pending.slice(0, 10);
      for (const c of show) {
        const body = (() => {
          try {
            return loadChapterBody(c);
          } catch (_) {
            return '';
          }
        })();
        const vol = c.volume ? `  「${c.volume}」` : '';
        // 标题里已经带"第29章"了，前面不要再挂一个目录序号（会看成两个编号）
        push('info', `${c.title}  ${countChars(body)} 字${vol}`);
      }
      if (pending.length > show.length) push('info', `… 还有 ${pending.length - show.length} 章`);
    }
  }

  /* ---------- 9. 登录态（可选联网检查）---------- */
  if (online && fatal === 0) {
    lines.push('');
    push('info', '----- 登录态检查（会打开浏览器）-----');
    try {
      const { launch, getPage } = require('./browser');
      const { isLoggedIn, waitForContent } = require('./login');
      const ctx = await launch(cfg, { logger });
      try {
        const page = await getPage(ctx);
        await page.goto(cfg.site.writerHome, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await waitForContent(page);
        await page.waitForTimeout(2000);
        if (await isLoggedIn(page)) push('ok', '登录状态有效');
        else {
          push('warn', '当前未登录 —— 双击「1-首次登录.bat」重新登录');
          warns++;
        }
      } finally {
        await ctx.close().catch(() => {});
      }
    } catch (e) {
      push('fail', '浏览器检查失败：' + String(e.message).split('\n')[0]);
      fatal++;
    }
  }

  /* ---------- 结论 ---------- */
  lines.push('');
  push('info', '----- 结论 -----');
  if (fatal > 0) {
    push('fail', `发现 ${fatal} 个必须解决的问题，先处理完再发布`);
  } else if (warns > 0) {
    push('warn', `没有致命问题，但有 ${warns} 处需要注意（见上面 WARN）`);
    push('info', '可以运行「3-试运行(不发布).bat」先演练一次');
  } else {
    push('ok', '一切就绪！可以运行「3-试运行(不发布).bat」或「4-一键发布.bat」');
  }

  lines.push('');
  const text = lines.join('\n');
  console.log(text);

  return { fatal, warns, pending: pending.length, text };
}

module.exports = { preflight };
