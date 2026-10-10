#!/usr/bin/env node
/**
 * 命令行入口
 *
 *   node src/cli.js login                 首次登录（保存登录状态）
 *   node src/cli.js split                 把 novel.txt 拆分成章节
 *   node src/cli.js status                查看发布进度
 *   node src/cli.js publish --dry         演练：填好内容但不发布
 *   node src/cli.js publish --limit 1     发布 1 章
 *   node src/cli.js publish --all         发布剩下的全部
 */
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { loadConfig } = require('./config');
const { createLogger, resolvePath, ROOT } = require('./util');
const { loadCredentials, maskPhone } = require('./credentials');
const { splitNovel, loadManifest, getChaptersDir } = require('./split');
const progress = require('./progress');
const daily = require('./daily');
const books = require('./books');
const { launch, getPage } = require('./browser');
const { ensureLoggedIn, applyResolvedBook, importPlatformRecords } = require('./publisher');
const { preflight } = require('./preflight');

const logger = createLogger();

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function waitEnter(promptText) {
  // ★ 和 publisher 里的同名函数一样：非交互窗口（面板/计划任务）不能"等回车"，会挂死。
  if (!process.stdin.isTTY) {
    console.log(promptText);
    console.log('（这里不是交互式窗口 —— 自动继续，不等待按键）');
    return Promise.resolve();
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(promptText, () => {
      rl.close();
      resolve();
    });
  });
}

/**
 * 中文提示统一由 Node 输出（而不是写在 .bat 里）
 * 原因：cmd 默认按 GBK 解析 bat 文件，UTF-8 中文会乱码
 */
function banner(lines = []) {
  console.log('');
  console.log('================================================');
  for (const l of lines) console.log('  ' + l);
  console.log('================================================');
  console.log('');
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (a) => {
      rl.close();
      resolve(String(a || '').trim());
    });
  });
}

/* ------------------------- 命令实现 ------------------------- */

/** 打印"当前这本"的一句话概览，各命令开头都会显示，避免发错书 */
function printBookLine(cfg) {
  const b = cfg && cfg._book;
  if (!b) return;
  console.log(`当前小说：${b.name}　（books\\${b.name}\\）`);
}

/** 相对项目根目录的短路径，用于日志（避免满屏绝对路径） */
function rel(p) {
  const r = path.relative(ROOT, p);
  return r && !r.startsWith('..') ? r : p;
}

/** 列出 books/ 下的所有小说，标出当前这本 */
function printBookList() {
  const all = books.listBooks();
  const cur = books.currentName();
  console.log('');
  console.log('================================================');
  console.log('  本地的小说');
  console.log('================================================');
  console.log('');
  if (!all.length) {
    console.log('  （还没有任何小说）');
    console.log('');
    console.log('  新建一本：node src\\cli.js switch --new "我的新书"');
    return all;
  }
  all.forEach((b, i) => {
    const star = b.name === cur ? '★' : ' ';
    const where = b.hasSource ? `已放正文` : '⚠ 还没有 novel.txt';
    const done = b.total ? `${b.published}/${b.total} 章` : '还没拆分';
    console.log(
      `  ${star} ${String(i + 1).padStart(2, ' ')}. ${b.name.padEnd(20, ' ')}  ${done.padEnd(12, ' ')}  ${where}`
    );
    if (b.name === cur) console.log(`        ↑ 当前要发的是这一本`);
  });
  console.log('');
  console.log(`  ★ = 当前小说${cur ? `：「${cur}」` : '（还没设过，双击 4-一键发布.bat 时会自动选唯一的一本）'}`);
  return all;
}

async function cmdSwitch(cfg, opts) {
  // 新建一本
  if (opts.new && opts.new !== true) {
    const b = books.createBook(String(opts.new), { bookName: opts.bookName }, undefined);
    books.activate(b.name);
    banner(['新建小说：' + b.name]);
    logger.ok(`已新建并切换为当前小说：「${b.name}」`);
    logger.info(`1. 把小说全文存成：books\\${b.name}\\novel.txt（UTF-8）`);
    logger.info(`2. 番茄后台的书名如果和文件夹名不一样，改 books\\${b.name}\\book.json 里的 bookName`);
    logger.info('3. 之后双击 9-检查小说格式.bat 校验，再双击 4-一键发布.bat');
    return;
  }

  // 直接切到指定的一本
  if (opts.to && opts.to !== true) {
    const b = books.activate(String(opts.to));
    banner(['已切换当前小说：' + b.name]);
    if (!b.hasSource) {
      logger.warn(`这本还没有正文文件，请把小说存成：books\\${b.name}\\novel.txt`);
    } else if (!b.hasChapters) {
      logger.info('还没拆分过，发布时会自动拆分（也可以先双击 2-拆分章节.bat）');
    } else {
      logger.ok(`已发 ${b.published} / ${b.total} 章`);
    }
    return;
  }

  // 列出 + 交互选
  const all = printBookList();
  if (!process.stdin.isTTY) {
    // 非交互（管道/自动化）不等待输入，避免卡住
    logger.info('切换：node src\\cli.js switch --to "书名"');
    if (!all.length) logger.info('新建：node src\\cli.js switch --new "我的新书"');
    return;
  }
  console.log('  0. 新建一本');
  console.log('');
  const ans = await ask('请输入编号切换（直接回车 = 不切换）: ');
  if (!ans) {
    console.log('没有切换。');
    return;
  }

  // 新建
  if (ans === '0') {
    const name = await ask('新小说的名字（就是文件夹名，建议和番茄后台书名一致）: ');
    if (!name) {
      console.log('没有输入名字，放弃。');
      return;
    }
    const nb = books.createBook(name, {}, undefined);
    books.activate(nb.name);
    console.log('');
    logger.ok(`已新建并切换为当前小说：「${nb.name}」`);
    logger.info(`把小说全文存成：books\\${nb.name}\\novel.txt（UTF-8）`);
    return;
  }

  const idx = Number(ans);
  let target = null;
  if (Number.isInteger(idx) && idx >= 1 && idx <= all.length) {
    target = all[idx - 1].name;
  } else {
    // 允许直接输入书名
    const hit = all.find((b) => b.name === ans);
    if (!hit) {
      logger.warn(`看不懂「${ans}」—— 请输入 0 新建，或 1~${all.length} 的编号，或完整的书名`);
      return;
    }
    target = hit.name;
  }

  const b = books.activate(target);
  console.log('');
  logger.ok(`已切换为当前小说：「${b.name}」`);
  logger.info('之后双击 4-一键发布.bat 发的就是这一本。');
}

async function cmdLogin(cfg, opts = {}) {
  // 面板点「登录番茄账号」时带 --no-wait：登录成功就自动关浏览器、结束任务（面板里等不了按键）
  const noWait = !!opts['no-wait'];
  let cred = null;
  try {
    cred = loadCredentials(cfg);
  } catch (_) {}
  banner([
    '登录（只需要做一次）',
    '',
    cred
      ? `已配置账号：${maskPhone(cred.phone)}，脚本会自动填好账号密码`
      : '未配置账号密码，请在弹出的窗口里扫码（或手机验证码）登录',
    '1. 浏览器会自动打开番茄作家后台',
    cred ? '2. 平台要求滑块/安全验证时，请在弹出的窗口里点一下' : '2. 请用手机扫码完成登录',
    '3. 登录成功后，登录状态会保存在本地 —— 以后发布/刷新后台都会自动登录，不用再手动操作',
  ]);
  logger.step('开始登录流程');
  logger.info(cred ? '接下来：自动填入账号密码并登录。' : '接下来：请在打开的浏览器窗口里扫码登录。');

  // ★ 登录一定要看得见的窗口（扫码/过验证都没法在无头里做）—— 强制有头，不受 config 的 headless 影响
  const ctx = await launch(cfg, { logger, headless: false });
  try {
    const page = await getPage(ctx);
    await ensureLoggedIn(page, cfg, logger, { interactive: true });
    console.log('');
    logger.ok('登录成功！登录状态已保存。');
    logger.info('以后发布章节、刷新后台都会自动登录，无需手动操作。');
    console.log('');
    if (noWait) {
      logger.info('（浏览器会自动关闭）');
    } else {
      await waitEnter('按回车键关闭浏览器...');
    }
  } finally {
    await ctx.close().catch(() => {});
  }
}

function cmdSplit(cfg) {
  banner([
    '拆分章节',
    '',
    `把 ${cfg.novel.sourceFile} 里的整本书，按章节标题切开，`,
    `一章一个文件，放到 ${rel(getChaptersDir())}\\ 目录里`,
  ]);
  logger.step('开始拆分章节');
  const manifest = splitNovel(cfg, logger);
  console.log('');
  logger.ok(`共 ${manifest.length} 章已拆分到 ${rel(getChaptersDir())}\\ 目录`);
  logger.info(`请打开 ${rel(getChaptersDir())}\\ 目录检查一下拆分结果是否正确，再执行发布。`);
}

function cmdStatus(cfg) {
  const manifest = loadManifest();
  if (!manifest) {
    printBookLine(cfg);
    logger.warn('还没有拆分过章节。请先运行「2-拆分章节」。');
    return;
  }
  const state = progress.load();
  console.log('');
  printBookLine(cfg);
  console.log(`目标作品：${cfg.site.bookName || '(未填 site.bookName)'}`);
  console.log(`章节总数：${manifest.count}`);
  console.log('---------------------------------------------');
  let done = 0;
  const renamed = [];
  for (const c of manifest.chapters) {
    const m = progress.matchDone(c.title);
    let mark = '待发布';
    if (m.done) {
      mark = m.record && m.record.status === 'draft' ? '已存草稿' : '已发布';
      if (m.how === 'number') {
        // 标题和账本里记的对不上，但序号发过 —— 提出来，否则用户会以为它没发
        mark += `(按第${m.no}章认出)`;
        renamed.push({ seq: c.seq, title: c.title, by: m.by, no: m.no });
      }
      done++;
    } else {
      const rec = state.chapters[c.title];
      if (rec && rec.status === 'failed') mark = '失败: ' + (rec.reason || '');
    }
    const vol = c.volume ? `「${c.volume}」` : '「(无卷)」';
    console.log(
      `${String(c.seq).padStart(4, ' ')}. ${c.title.padEnd(24, ' ')} ${String(c.chars).padStart(6, ' ')}字  ${vol}  [${mark}]`
    );
  }
  console.log('---------------------------------------------');
  console.log(`进度：${done} / ${manifest.count} 已完成`);
  if (renamed.length) {
    console.log('');
    console.log(`注意：有 ${renamed.length} 章的标题和发布记录里的对不上，是按「章节序号」认出来的：`);
    for (const r of renamed) {
      console.log(`    · 第${r.no}章 —— 现在写的是「${r.title}」，账本里记的是「${r.by}」`);
    }
    console.log('    这一章不会被重发。要重发就先清记录：node src\\cli.js reset --chapter <序号>');
  }

  // 分卷归属汇总（用的是"第几章"那个真序号，不是 chapters 目录里的序号）
  const noOf = (c) => progress.recordNo(c.title, {}) || c.seq;
  const allVols = [...new Set(manifest.chapters.map((c) => c.volume).filter(Boolean))];
  if (allVols.length) {
    console.log('---------------------------------------------');
    console.log(`分卷：共 ${allVols.length} 卷`);
    for (const v of allVols) {
      const inVol = manifest.chapters.filter((c) => c.volume === v);
      console.log(
        `    ${v}：第 ${noOf(inVol[0])} ~ ${noOf(inVol[inVol.length - 1])} 章（${inVol.length} 章）`
      );
    }
    const noVol = manifest.chapters.filter((c) => !c.volume);
    if (noVol.length) console.log(`    (无卷)：第 ${noVol.map(noOf).join('、')} 章`);
  }

  // 今日字数额度（用户最关心的一项，放在最显眼的位置）
  if (daily.isEnabled(cfg)) {
    const s = daily.summary(cfg, manifest);
    console.log('---------------------------------------------');
    console.log(`今日（${s.date}）已发：${s.used} / ${s.limit} 字   还剩 ${s.remain} 字`);
    if (s.chapters.length) {
      for (const c of s.chapters) console.log(`    · ${c.title}  ${c.chars} 字`);
    } else {
      console.log('    （今天还没发过）');
    }
  }

  if (state.lastRun) console.log(`上次运行：${new Date(state.lastRun).toLocaleString('zh-CN', { hour12: false })}`);
  console.log('');
}

/**
 * 自动拆分：小说文件有改动、或还没拆分过 → 自动先跑一遍拆分。
 * 目的：让「一键发布」真的只需要点一次，不用先去点「2-拆分章节」。
 */
function autoSplitIfNeeded(cfg, logger) {
  const manifest = loadManifest();
  const src = resolvePath(cfg.novel.sourceFile);
  const mfPath = path.join(ROOT, 'chapters', 'manifest.json');

  let need = false;
  let why = '';
  if (!manifest || !manifest.chapters || !manifest.chapters.length) {
    need = true;
    why = '还没拆分过章节';
  } else if (fs.existsSync(src)) {
    const srcM = fs.statSync(src).mtimeMs;
    const mfM = fs.existsSync(mfPath) ? fs.statSync(mfPath).mtimeMs : 0;
    if (srcM > mfM + 1000) {
      need = true;
      why = `${cfg.novel.sourceFile} 有更新`;
    }
  }
  if (!need) return;

  logger.step(`检测到${why}，先自动拆分一次`);
  splitNovel(cfg, logger);
  logger.info(`拆分结果在 ${rel(getChaptersDir())}\\ 目录，想核对可以打开看。`);
}

async function cmdLint(cfg, opts) {
  banner([
    '小说文件格式校验',
    '',
    '在拆分和发布之前，把 novel.txt 的格式问题全查一遍：',
    '编码、换行符、章节标题、每章字数、标题长度、结构遗漏',
  ]);

  const { lintNovel, fixEncoding } = require('./lint');
  const r = lintNovel(cfg, { fix: !!opts.fix, quiet: true });
  console.log(r.text);

  // 编码不对时主动问一句要不要转（中文提示放这里，不写进 bat，避免 GBK 乱码）
  if (!opts.fix && r.encodingFixNeeded && process.stdin.isTTY) {
    console.log('');
    const a = await ask(
      `检测到编码是 ${r.encoding}，要现在自动转成 UTF-8 吗？会先把原文件备份一份。(y/N): `
    );
    if (/^y/i.test(a)) {
      const f = fixEncoding(cfg, r.decodedText);
      console.log('');
      console.log((f.ok ? '[OK]  ' : '[FAIL]') + ' ' + f.msg);
      if (f.ok) {
        console.log('      转换完成。再跑一次「9-检查小说格式.bat」，确认还剩哪些内容层面的问题。');
      }
    } else {
      console.log('已跳过转换。');
    }
  }

  return r;
}

async function cmdPublish(cfg, opts) {
  if (opts.mode) cfg.publish.mode = opts.mode;
  if (opts.headless) cfg.browser.headless = true;

  if (opts.dry) {
    banner([
      '试运行（只填写，不发布）',
      '',
      '脚本会自动打开网页、填好标题和正文，',
      '但【不会】点发布按钮，请自己核对填得对不对。',
    ]);
  } else {
    const lines = [
      '自动发布',
      '',
      `发布方式：${cfg.publish.mode === 'draft' ? '只存草稿（不发到线上）' : '直接发布到线上'}`,
      `当前小说：${(cfg._book && cfg._book.name) || '(未指定)'}　→　${rel(getChaptersDir())}`,
      `目标作品：「${cfg.site.bookName || '(未填书名，按 config 里的地址走)'}」`,
    ];
    // 分卷概览：让用户点之前就知道"会往哪几卷里发"
    const mf = loadManifest();
    const vols = mf && mf.chapters ? [...new Set(mf.chapters.map((c) => c.volume).filter(Boolean))] : [];
    if (vols.length) {
      lines.push(`分卷：${vols.join('、')}（发布时自动切换）`);
      if (cfg.novel.fillVolume === false) lines.push('  ⚠ novel.fillVolume = false，实际不会切换分卷');
    } else {
      lines.push('分卷：小说里没写卷，发布会沿用网页上当前选中的卷');
    }
    if (cfg.publish.mode !== 'draft' && daily.isEnabled(cfg)) {
      const s = daily.summary(cfg, loadManifest());
      lines.push(
        `日字数上限：${cfg.publish.dailyCharLimit} 字／天`,
        `今天已发 ${s.used} 字，还剩 ${s.remain} 字 —— 会一直发到下一章放不下为止`
      );
    } else {
      lines.push(`本次最多 ${cfg.publish.maxPerRun || '不限'} 章`);
    }
    lines.push('全程自动：小说有更新会自动拆分，然后填内容、走完发布流程。');
    banner(lines);
  }

  // 先做一次格式校验：致命问题（文件找不到 / 编码乱码 / 没识别到标题）
  // 直接停下，不要白跑一趟去开浏览器
  if (!opts['skip-lint']) {
    const { lintNovel } = require('./lint');
    const lint = lintNovel(cfg, { quiet: true });
    if (lint.fatal > 0) {
      console.log('');
      logger.fail(`小说文件有 ${lint.fatal} 个必须先解决的问题，已停下（完整报告见下）`);
      console.log(lint.text);
      logger.info('改完再双击「4-一键发布.bat」；也可以随时双击「9-检查小说格式.bat」单独看报告。');
      return { published: 0, failed: 0, aborted: true };
    }
    if (lint.warns > 0) {
      logger.warn(`小说文件有 ${lint.warns} 处需注意（能自动跳过的问题会跳过）`);
      logger.info('想看完整报告：双击「9-检查小说格式.bat」');
    } else {
      logger.ok('小说文件格式校验通过');
    }
  }

  // 自动拆分（小说改了 / 没拆过），省掉一次手动操作
  autoSplitIfNeeded(cfg, logger);

  const p = require('./publisher');
  const result = await p.run(
    cfg,
    {
      dryRun: !!opts.dry,
      all: !!opts.all,
      limit: opts.limit,
      chapter: opts.chapter,
      force: !!opts.force,
      unattended: !!opts.unattended,
      // ★★ 2026-10-08 补：--at 之前在这里被静默丢掉 —— 解析出来了却没转发给 run()，
      //    结果定时发布从 CLI/面板走一直等于立即发布（只有直接调 applyScheduleInDialog
      //    的验证脚本能生效，所以没被发现）。test-books §16 有静态断言钉住这行。
      at: opts.at,
      scheduleMap: opts['schedule-map'], // ★ 面板「章节表逐章填时间」走这条
    },
    logger
  );
  return result;
}

/**
 * 清除发布记录，让脚本重新发某些章节。
 * 用在"页面误报成功、其实没发出去"这类情况下。
 */
function cmdReset(cfg, opts) {
  const d = progress.load();
  const titles = Object.keys(d.chapters || {});

  if (!titles.length) {
    logger.info('发布记录是空的，没有需要清除的');
    return;
  }

  if (opts.all) {
    progress.save({ chapters: {}, lastRun: d.lastRun });
    logger.ok(`已清空全部 ${titles.length} 条发布记录 —— 下次运行会重新处理所有章节`);
    return;
  }

  if (opts.chapter) {
    const manifest = loadManifest();
    const want = Number(opts.chapter);
    const list = (manifest && manifest.chapters) || [];
    // ★ 两种序号都认：chapters/ 目录里的序号（seq），以及标题里写的"第几章"
    //   —— 用户嘴里说的、我们日志里打的多半是后者（"第22章"），别逼他去数目录
    const targets = list.filter((c) => c.seq === want || progress.recordNo(c.title, {}) === want);
    if (!targets.length) {
      logger.fail(
        `找不到第 ${want} 章（既不是 chapters/ 目录里的序号，也没有哪个章节标题写着「第${want}章」）`
      );
      return;
    }
    const removed = [];
    for (const ch of targets) {
      const no = progress.recordNo(ch.title, {});
      for (const key of Object.keys(d.chapters || {})) {
        const isThisOne = key === ch.title || (no > 0 && progress.recordNo(key, d.chapters[key]) === no);
        if (isThisOne) {
          delete d.chapters[key];
          removed.push(key);
        }
      }
    }
    if (!removed.length) {
      logger.warn(`第 ${want} 章本来就没有发布记录，不用清`);
      return;
    }
    d.lastRun = new Date().toISOString();
    progress.save(d);
    logger.ok(`已清除 ${removed.length} 条发布记录：`);
    removed.forEach((t) => logger.ok(`  · ${t}`));
    logger.info('下次运行会重新发这一章');

    // ★ 额度提示：重置 = "这章不算发过了"，但今天的额度账本里可能还记着它。
    //   平台上删了 → 账该退；平台上还在（只是想重发）→ 账该留 ——
    //   工具分不清是哪种，所以只提醒 + 给出现成的校准命令，不自动动账。
    try {
      const daily = require('./daily');
      if (daily.isEnabled(cfg)) {
        const led = daily.open(manifest, null, { persist: false });
        const hit = (led.chapters || []).filter((c) => removed.includes(c.title));
        if (hit.length) {
          const n = hit.reduce((s, c) => s + (Number(c.chars) || 0), 0);
          logger.warn(`提醒：今天的额度账本里还记着这一章的 ${n} 字（当前 ${led.chars} / ${cfg.publish.dailyCharLimit}）。`);
          logger.warn(`  · 这一章在平台上已删除 → 想退回额度：node src\\cli.js daily --set ${Math.max(0, led.chars - n)}`);
          logger.warn('  · 这一章在平台上还在（只是想重发一遍）→ 什么都不用做，重发会再扣一次');
        }
      }
    } catch (_) {
      /* 额度提示只是锦上添花，别让它把重置本身搞挂 */
    }
    return;
  }

  // 没给参数：把现有记录列出来，方便决定清哪条
  banner(['发布记录']);
  console.log('');
  for (const t of titles) {
    const r = d.chapters[t];
    const flag = r.status === 'published' ? '已发布' : r.status === 'draft' ? '已存草稿' : '失败';
    const v = r.verified === false ? '（当时没能确认结果）' : '';
    console.log(`  [${flag}] ${t}${v}`);
    console.log(`           章节号=${r.chapterNo || '-'}  时间=${r.at || '-'}`);
  }
  console.log('');
  logger.info('清除某一章：node src\\cli.js reset --chapter 22   （写"第几章"或 chapters 目录里的序号都行）');
  logger.info('全部清空：  node src\\cli.js reset --all');
}

/**
 * 查看/校准"今天的字数额度"。
 *
 * 脚本只能统计**自己发出去的**。如果你手动在番茄后台发过章节，脚本不知道，
 * 这里可以手动把数字补上（--set），或者整体清零（--clear）。
 */
function cmdDaily(cfg, opts) {
  const manifest = loadManifest();
  if (!manifest) {
    logger.fail('还没有拆分过章节，先双击「2-拆分章节.bat」');
    return;
  }
  if (!daily.isEnabled(cfg)) {
    logger.warn(`日字数上限当前是关闭状态（config.json 的 publish.dailyCharLimit = ${cfg.publish.dailyCharLimit}）`);
    logger.info('想启用就把它改成正数，比如 10000。');
    return;
  }

  if (opts.set != null && opts.set !== '') {
    const n = Number(opts.set);
    if (!Number.isFinite(n) || n < 0) {
      logger.fail(`--set 需要一个不小于 0 的数字，收到的是「${opts.set}」`);
      return;
    }
    const led = daily.open(manifest, null);
    const r = daily.setUsed(manifest, n);
    logger.ok(
      `今日已发字数：${r.before} → ${r.after}（上限 ${cfg.publish.dailyCharLimit}，剩 ${Math.max(
        0,
        cfg.publish.dailyCharLimit - r.after
      )} 字）`
    );
    return;
  }

  if (opts.clear) {
    const before = daily.summary(cfg, manifest);
    daily.reset(manifest);
    logger.ok(`已把今天的账本清零：${before.used} 字 → 0 字`);
    logger.warn('注意：这只改脚本自己的计数，番茄后台的实际情况没变。');
    logger.warn('      如果你今天其实已经发了不少，清成 0 之后再发可能超出平台额度。');
    return;
  }

  const s = daily.summary(cfg, manifest);
  banner(['今日字数额度（账号级，所有书共用）']);
  console.log('');
  printBookLine(cfg);
  console.log(`  日期：${s.date}`);
  console.log(`  上限：${s.limit} 字／天（全部书加起来共这么多数）`);
  console.log(`  已发：${s.used} 字（${s.chapters.length} 章）`);
  console.log(`  还剩：${s.remain} 字`);
  if (s.chapters.length) {
    console.log('');
    for (const c of s.chapters) console.log(`    · ${c.title}  ${c.chars} 字`);
  }
  console.log('');
  logger.info(`账本文件：${rel(daily.getFile())}（跨天自动清零；全账号只有这一份，不是每本书一份）`);
  logger.info(`手动校准：node src\\cli.js daily --set 5000    清零：node src\\cli.js daily --clear`);
}

/**
 * 列出账号里的所有作品。
 *
 * 同一账号下有多本书时，靠这个确认 config.json 的 site.bookName 该填什么 ——
 * 填错书名的后果是"发到别的书里"，所以先看一眼最保险。
 */
/**
 * ★★ 从番茄后台导入这本书已有的章节发布记录。
 *
 * 解决的问题：一本在后台已经有章节的书（手动发过/别处发过/换工具），
 * 本地 progress.json 是空的 —— 不导入的话，发布流程会以为从第 1 章开始，
 * **把已发的章节再发一遍（后台重章）**。
 *
 * 做法：按书名定位作品 → 调后台接口拉全部章节（逐卷）→ 和本地拆分的章节
 * 按章节号配对 → 配上的标记为已发布（发布时间用平台侧的）→ 重算今日额度账本。
 *
 * 也挂在两个地方自动跑（best-effort，失败不影响主流程）：
 *   · publish 时若发现这本书本地一条记录都没有（防"从头重发"的安全网）
 *   · 面板「＋新建」之后（新书若在后台已有章节，拆分完就会提示导入）
 */
/**
 * ★★ 刷新后台状态（面板打开时自动跑 + 面板按钮手动跑）：
 *   ① 连上番茄后台，列出**账号里所有作品**（看有没有以前的旧书）
 *   ② 逐本和本地对账：后台多少章 / 本地记了多少条 / 有没有对不上的
 *   ③ 把后台已有的章节导入本地记录（防止重发；含其他书）
 *   ④ 写一份缓存（data/platform-books.json）给面板展示
 *
 * 两种模式：
 *   · --auto    面板启动自动跑：无头浏览器、不打扰（登录失效就跳过并提示）
 *   · 手动      面板按钮/CLI：有头浏览器，登录失效时能当场重新登录
 */
async function cmdSyncRecords(cfg, opts) {
  const auto = !!opts.auto;
  banner([auto ? '自动同步番茄后台' : '刷新后台状态']);
  const fsy = require('fs');
  const pathy = require('path');
  const { ROOT: PROJ_ROOT, ensureDir } = require('./util');
  const booksMod = require('./books');
  const progress = require('./progress');
  const { listBooks: platformListBooks, fetchPlatformChapters } = require('./site-reader');
  const daily = require('./daily');
  const norm = (s) => String(s || '').replace(/\s+/g, '');

  // 本地书清单（bookName 优先、文件夹名兜底，用来和后台作品对上号）
  const locals = booksMod.listBooks().map((b) => {
    let bookName = b.name;
    try {
      bookName = JSON.parse(fsy.readFileSync(pathy.join(b.dir, 'book.json'), 'utf8')).bookName || b.name;
    } catch (_) {}
    return { ...b, bookName };
  });
  const matchLocal = (pname) => locals.find((b) => norm(b.bookName) === norm(pname)) || null;
  const cur = booksMod.currentName();
  const curBook = cur ? booksMod.describeBook(cur) : null;
  const origProgressPath = curBook ? curBook.progressPath : null;

  logger.info(auto ? '正在连番茄后台…（无头模式，不会弹窗口）' : '正在连番茄后台…（只读，不会发布/修改任何章节）');
  const { launch, getPage } = require('./browser');
  const ctx = await launch(cfg, { logger, headless: auto ? true : null });
  try {
    const page = await getPage(ctx);
    const logged = await ensureLoggedIn(page, cfg, logger, { interactive: !auto && !opts.unattended });
    if (!logged) {
      logger.fail('登录态无效。' + (auto ? '（自动同步跳过 —— 点面板上的「登录番茄账号」重新登录一次即可）' : ''));
      return;
    }

    // ① 后台作品列表
    const r = await platformListBooks(page, cfg, logger);
    const seen = new Set();
    const works = [];
    for (const c of r.list || []) {
      const name = String(c.titleGuess || '').trim();
      if (!name || seen.has(c.bookId)) continue;
      seen.add(c.bookId);
      works.push({ name, bookId: c.bookId, lastChapterNo: c.lastChapterNo || 0, totalChapters: c.totalChapters || 0 });
    }
    if (!works.length) logger.warn('账号里一个作品都没读到 —— 网页结构可能变了，或登录有问题');
    logger.info('后台作品一览（' + works.length + ' 本）：');
    for (const w of works) {
      const lb = matchLocal(w.name);
      logger.info(
        '  · 「' + w.name + '」 共 ' + w.totalChapters + ' 章（最新第 ' + w.lastChapterNo + ' 章）　→ ' +
          (lb ? '本地对应「' + lb.name + '」' : '本地没有')
      );
    }

    // ② 逐本对账 + 导入
    const overview = [];
    for (const w of works) {
      const lb = matchLocal(w.name);
      const row = {
        name: w.name,
        bookId: w.bookId,
        platformTotal: w.totalChapters,
        platformLast: w.lastChapterNo,
        localBook: lb ? lb.name : '',
        localPublished: 0,
        imported: 0,
        mismatch: [],
        note: '',
      };
      if (!lb) {
        overview.push(row);
        continue;
      }
      try {
        let mf = null;
        try {
          mf = JSON.parse(fsy.readFileSync(lb.manifestPath, 'utf8'));
        } catch (_) {}
        if (!mf || !mf.chapters || !mf.chapters.length) {
          row.note = '本地还没拆过章节';
          overview.push(row);
          continue;
        }
        const pf = await fetchPlatformChapters(ctx, { site: { bookId: w.bookId } }, logger);
        row.platformFetched = pf.chapters.length;
        const plan = booksMod.planRecordImport(mf.chapters, pf.chapters);

        // 本地"记了已发但后台没有"的（可能后台删了/审核没过）→ 只报告，不自动改
        let prog = {};
        try {
          prog = JSON.parse(fsy.readFileSync(lb.progressPath, 'utf8')).chapters || {};
        } catch (_) {}
        const markedTitles = new Set(plan.toMark.map((x) => x.title));
        for (const c of mf.chapters) {
          const rec = prog[c.title];
          if (rec && (rec.status === 'published' || rec.status === 'draft') && !markedTitles.has(c.title)) {
            row.mismatch.push(c.title);
          }
        }

        if (plan.toMark.length) {
          try {
            progress.setFile(lb.progressPath);
            for (const m of plan.toMark) {
              progress.markPublished(m.title, {
                status: 'published',
                mode: 'import',
                chapterNo: m.chapterNo,
                verified: true,
                at: m.at || undefined,
              });
            }
            row.imported = plan.toMark.length;
          } finally {
            if (origProgressPath) progress.setFile(origProgressPath);
          }
        }

        let prog2 = {};
        try {
          prog2 = JSON.parse(fsy.readFileSync(lb.progressPath, 'utf8')).chapters || {};
        } catch (_) {}
        row.localPublished = Object.values(prog2).filter((x) => x.status === 'published' || x.status === 'draft').length;
      } catch (e) {
        row.note = '对账失败：' + String(e.message).split('\n')[0].slice(0, 60);
      }
      overview.push(row);
    }

    // ③ 逐本小结
    for (const row of overview) {
      if (!row.localBook || row.note) continue;
      logger.info(
        '「' + row.localBook + '」：后台 ' + (row.platformFetched || 0) + ' 章 / 本地已记 ' + row.localPublished + ' 条' +
          (row.imported ? '（新导入 ' + row.imported + ' 条）' : '（无新增）')
      );
      if (row.mismatch.length) {
        logger.warn('  ⚠ 有 ' + row.mismatch.length + ' 章本地记着「已发」但后台没有：' + row.mismatch.slice(0, 4).join('、') + (row.mismatch.length > 4 ? '…' : ''));
        logger.warn('  （可能是后台删了或审核没过。确认没发出去的话，切到这本书跑 reset --chapter 重置记录）');
      }
    }

    // ④ 写缓存（面板展示用）
    try {
      ensureDir(pathy.join(PROJ_ROOT, 'data'));
      fsy.writeFileSync(
        pathy.join(PROJ_ROOT, 'data', 'platform-books.json'),
        JSON.stringify(
          { updatedAt: new Date().toLocaleString('zh-CN', { hour12: false }), currentBook: cur || '', books: overview },
          null,
          2
        ),
        'utf8'
      );
    } catch (e) {
      logger.warn('写后台缓存失败：' + String(e.message).split('\n')[0]);
    }

    // ⑤ 今日额度重算（导入的记录里可能含"今天"创建的）
    if (daily.isEnabled(cfg)) daily.recountToday(logger);

    logger.ok(
      '后台状态已刷新：' + works.length + ' 本作品' + (overview.some((x) => x.imported) ? '（有记录更新）' : '（本地记录已是最新）')
    );
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function cmdBooks(cfg) {
  banner([
    '查看账号里的作品',
    '',
    '会打开浏览器去作品管理页，把账号里的书列出来',
    '看清楚了再把这个书名原样填进 config.json 的 site.bookName',
  ]);

  const { launch, getPage } = require('./browser');
  const { listBooks } = require('./site-reader');

  const ctx = await launch(cfg, { logger });
  let list = [];
  try {
    const page = await getPage(ctx);
    await ensureLoggedIn(page, cfg, logger, { interactive: true });
    const r = await listBooks(page, cfg, logger);
    list = r.list || [];
  } finally {
    await ctx.close().catch(() => {});
    logger.info('浏览器已关闭');
  }

  console.log('');
  if (!list.length) {
    logger.warn('一个作品都没读到 —— 确认账号下确实有作品，或者番茄的页面结构变了。');
    return;
  }

  // ★ 多书模式：书名在 book.json 里，config.json 的 site.bookName 已经清空了。
  //   这里要看的是"当前那本书的 bookName"，不是 config 里的旧字段 ——
  //   不然明明填好了，这里却永远报"书名为空"吓人。
  const cur = (() => {
    try {
      const name = books.currentName();
      return String((name && books.describeBook(name).bookName) || '').trim();
    } catch (_) {
      return '';
    }
  })();
  console.log(`账号下共 ${list.length} 本书：`);
  console.log('');
  for (const b of list) {
    const isCur = cur && (b.titleGuess === cur || String(b.text || '').includes(cur));
    console.log(`  · ${b.titleGuess}${isCur ? '    ← 当前 config.json 用的就是这本' : ''}`);
    console.log(`      书籍 ID：${b.bookId}`);
    if (b.lastChapterNo) console.log(`      最新章节：第 ${b.lastChapterNo} 章`);
    if (b.totalChapters) console.log(`      总章数：${b.totalChapters} 章`);
    if (!b.exact && cur && isCur) console.log('      （书名不是完全一致，是按包含关系匹配的，留意一下）');
  }
  console.log('');
  logger.info('把书名原样填进**当前那本小说**的 book.json（books\\<书名>\\book.json 里的 bookName）就行 —— 书籍 ID 脚本自己会取。');
  if (!cur) {
    logger.warn('现在书名为空（book.json 里的 bookName 没填）—— 建议马上填上：账号有多本书时，不填会发错书。');
  }
  console.log('');
}

/* ------------------------- 浏览器 ------------------------- */

/**
 * 列出本机可用的浏览器，并说明发布会用哪一个。
 * 用途：换了台电脑、或者怀疑"是不是因为没装 Chrome 才跑不起来"时看一眼。
 */
async function cmdBrowsers(cfg) {
  const { inspect, installCommand } = require('./browser');

  let info;
  try {
    info = inspect(cfg);
  } catch (e) {
    logger.fail('探测浏览器时出错：' + String(e.message).split('\n')[0]);
    return;
  }

  banner(['本机可用的浏览器', '', '发布会自动挑一个能用的，用不着你手动指定']);

  console.log('');
  if (info.detected.length) {
    console.log('这台机器上认出来的浏览器（按脚本的尝试顺序）：');
    console.log('');
    info.detected.forEach((d, i) => {
      const mark = i === 0 ? '   ← 优先用这个' : '';
      console.log(`  ${i + 1}. ${d.name}${mark}`);
      console.log(`     ${d.executablePath}`);
    });
  } else {
    console.log('常见安装位置里一个浏览器都没认出来（Chrome / Edge / Brave / 360 / QQ …）。');
  }

  // 快速探测漏掉的，再扫一遍常见安装目录（慢，所以只在看清单时才做）
  let deep = [];
  try {
    deep = info.deep || [];
  } catch (_) {
    deep = [];
  }
  if (deep.length) {
    console.log('');
    console.log('另外在非标准位置扫到的（这些也能用）：');
    for (const d of deep) console.log(`  · ${d.name}\n     ${d.executablePath}`);
  }

  // ★ 依赖没装时，页面上的浏览器照样能列出来，但"自带内核"和"发布"都用不了。
  //   这时给的一句必须是"去装依赖"，而不是"去下载内核" —— 后者现在跑必然失败。
  const depsMissing = info.builtin.reason === 'deps-missing';
  if (depsMissing) {
    console.log('');
    logger.warn('依赖还没装（缺 playwright-core）—— 上面的列表能看，但现在还启动不了浏览器。');
    console.log('  让它能用：双击「0-安装依赖.bat」（或在本目录执行 npm install）');
  }

  console.log('');
  console.log(`Playwright 自带内核（${info.engine === 'firefox' ? 'Firefox' : 'Chromium'}）：${info.builtin.available ? '已下载' : '未下载'}`);
  if (info.builtin.path) console.log(`  ${info.builtin.path}`);
  if (depsMissing) {
    console.log('  依赖没装，查不到它 —— 装完依赖再看（双击「0-安装依赖.bat」）');
  } else if (!info.builtin.available) {
    console.log('  想下载它：' + installCommand(info.engine));
  }

  console.log('');
  console.log('config.json 里的浏览器配置：');
  console.log(`  engine          = ${info.engine}`);
  console.log(`  channel         = ${cfg.browser.channel || 'auto'}`);
  console.log(`  executablePath  = ${cfg.browser.executablePath || '(空)'}`);
  console.log(`  userDataDir     = ${cfg.browser.userDataDir}`);

  console.log('');
  if (depsMissing) {
    console.log('依赖没装，现在发布还起不来 —— 先双击「0-安装依赖.bat」，再回来跑这个命令。');
  } else if (info.chain.length) {
    console.log(`发布时会用：${info.chain[0].name}`);
    if (info.chain.length > 1) {
      console.log(`  如果它用不了，会自动依次尝试：${info.chain.slice(1).map((c) => c.name).join(' → ')}`);
    }
    // 用 planUserDataDir 而不是 resolveUserDataDir —— 这是只读命令，不该顺手建目录
    const { planUserDataDir } = require('./browser');
    const udd = planUserDataDir(cfg, info.chain[0].id, null);
    console.log(`  登录态目录：${udd.dir} ${udd.note}`);
  } else {
    logger.warn('没有可用浏览器 —— 发布一定会失败。按下面的提示处理一下：');
    console.log('');
    console.log('  办法一：装个 Chrome 或 Edge（Edge 在 Win10/11 上本来就自带）');
    console.log('  办法二：下载自带内核 —— ' + installCommand(info.engine));
    console.log('  办法三：你用的是 360 / QQ 这类浏览器的话，把它的 exe 路径填到');
    console.log('          config.json 的 browser.executablePath（右键图标 → 属性 → 目标）');
  }
  console.log('');
}

/* ------------------------- 定时任务 ------------------------- */

const TASK_NAME = 'NovelAutoPublish';

async function cmdTimerSet(opts) {
  banner([
    '设置每日定时自动发布',
    '',
    '到点后电脑会自动发一章（只会发还没发过的章节）',
    '注意：需要电脑处于开机状态，且已经完成过首次登录',
  ]);

  const input = opts.time ? String(opts.time) : await ask('请输入每天发布的时间（24小时制，例如 08:00），直接回车使用 08:00：');
  const time = input || '08:00';

  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) {
    logger.fail(`时间格式不对：「${time}」。请用 24 小时制，例如 08:00 或 20:30`);
    return;
  }

  const bat = path.join(ROOT, 'silent-publish.bat');
  logger.info(`正在创建计划任务「${TASK_NAME}」，每天 ${time} 执行`);

  const r = spawnSync(
    'schtasks',
    ['/Create', '/TN', TASK_NAME, '/TR', `"${bat}"`, '/SC', 'DAILY', '/ST', time, '/F'],
    { encoding: 'utf8' }
  );

  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status === 0) {
    console.log('');
    logger.ok(`定时发布设置成功：每天 ${time} 自动发布一章`);
    logger.info('执行日志会写到 logs\\scheduled.log');
    logger.info('取消定时：运行「7-取消定时发布.bat」');
  } else {
    logger.fail('创建计划任务失败');
    if (out) console.log(out);
    logger.warn('如果提示权限不足，请右键「6-设置每日定时发布.bat」选择「以管理员身份运行」');
  }
}

function cmdTimerRemove() {
  banner(['取消定时发布']);
  const r = spawnSync('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status === 0) {
    logger.ok('定时发布已取消');
  } else {
    logger.warn('没找到这个定时任务，或者权限不足');
    if (out) console.log(out);
  }
}

/* ------------------------- 分发 ------------------------- */

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  // ★ 上次若有 --book 临时切换被强杀，这里自愈（绝大多数命令都走 main）——
  //   放在最前面：后面任何读 .current 的逻辑看到的都是恢复后的值
  books.healStaleCurrentSwitch(logger);
  const cmd = opts._[0] || 'help';

  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    console.error('读取 config.json 失败：' + e.message);
    process.exit(1);
  }

  // ★ 老布局（单书、文件都在根目录）→ 自动搬进 books/<书名>/。
  //   只在 books/ 还是空的、根目录又确实有老文件时才动手（幂等、带备份、带校验）。
  if (!books.listBooks().length && books.legacyPresent()) {
    try {
      books.migrateLegacy(logger, { bookName: cfg.site && cfg.site.bookName });
    } catch (e) {
      console.error('');
      console.error(e.message);
      console.error('');
      process.exit(1);
    }
  }

  // 需要"某一本书"的命令：先确定是哪本，再把三个模块的路径指过去
  const NEEDS_BOOK = new Set([
    'split',
    'lint',
    'check-novel',
    'reset',
    'status',
    'daily',
    'publish',
    'check',
    'sync-records',
  ]);
  if (NEEDS_BOOK.has(cmd)) {
    // ★★ `--book` 的语义是"临时发另一本，**不改「当前」**"（见下面 help 里那句）。
    //   但 `books.activate()` 内部总会 `setCurrent()` 重写 books/.current ——
    //   实测确认过：activate('乙书') 之后 .current 就变成乙书了。
    //   所以显式指定 --book 时，这里自己把原值记下来、跑完恢复回去。
    //
    //   ★ 用 process.on('exit') 而不是 try/finally：命令实现里有大量 `process.exit()`，
    //     finally 根本轮不到执行，恢复逻辑会静默失效。
    //   ★ 批量发布（面板的「一次发多本」）就踩在这个点上 ——
    //     不修的话，排队发完 A→B→C 之后，「当前小说」会悄悄变成 C。
    if (opts.book && opts.book !== true) {
      const prevCurrent = books.currentName();
      // ★★ 崩溃安全：Windows 上 SIGTERM/SIGKILL（taskkill、timeout、面板"停止"）
      //   **不会跑任何 Node 钩子** —— 只靠 process.on('exit') 恢复，一旦被强杀就永久卡住
      //   （2026-10-08 实测踩到：.current 卡在临时书上）。所以：
      //   ① 把"临时切换前的值"落盘（books/.current-temp.json，含 pid）
      //   ② 正常退出时恢复 + 删文件
      //   ③ 下次任何命令启动时自愈（见 healStaleCurrentSwitch，pid 还活着就不动）
      books.writeTempSwitch(prevCurrent, process.pid);
      const restoreCurrent = () => {
        try {
          if (prevCurrent) books.setCurrent(prevCurrent);
          else books.clearCurrent();
          books.clearTempSwitch();
        } catch (_) {
          /* 恢复失败不该影响退出码 */
        }
      };
      process.on('exit', restoreCurrent);
      process.on('SIGINT', () => {
        restoreCurrent();
        process.exit(130);
      });
    }

    let book;
    try {
      book = books.activate(opts.book && opts.book !== true ? String(opts.book) : null);
    } catch (e) {
      console.error('');
      console.error(e.message);
      console.error('');
      process.exit(1);
    }
    books.applyBookToConfig(cfg, book);
  }

  switch (cmd) {
    case 'login':
      await cmdLogin(cfg, opts);
      break;
    case 'split':
      cmdSplit(cfg);
      break;
    case 'lint':
    case 'check-novel':
      await cmdLint(cfg, opts);
      break;
    case 'reset':
      cmdReset(cfg, opts);
      break;    case 'status':
      cmdStatus(cfg);
      break;
    case 'daily':
      cmdDaily(cfg, opts);
      break;
    case 'switch':
      await cmdSwitch(cfg, opts);
      break;
    case 'sync-records':
      await cmdSyncRecords(cfg, opts);
      break;
    case 'books':
      await cmdBooks(cfg);
      break;
    case 'browsers':
      await cmdBrowsers(cfg);
      break;
    case 'publish':
      await cmdPublish(cfg, opts);
      break;
    case 'check':
      banner(['发布前自检', '', '把所有可能导致白跑一趟的问题提前查出来']);
      await preflight(cfg, { online: !!opts.online });
      break;
    case 'timer-set':
      await cmdTimerSet(opts);
      break;
    case 'timer-remove':
      cmdTimerRemove();
      break;
    case 'help':
    default:
      console.log(`
小说自动发布工具

  node src/cli.js login                首次登录（保存登录状态，只需做一次）
  node src/cli.js switch               列出本地的小说 / 切换当前要发哪一本
                                       --to "书名"   直接切到某一本
                                       --new "书名"  新建一本（建 books\\书名\\ 和 book.json）
  node src/cli.js lint                 校验小说文件格式（编码/标题/字数，发布前必跑）
                                       加 --fix 会把编码自动转成 UTF-8（先备份原文件）
  node src/cli.js split                把 novel.txt 拆分成章节（含分卷）
  node src/cli.js books                列出**番茄账号里**的作品（多书账号用来确认填哪本书名）
                                       注意：这和 switch 不是一回事 —— switch 管的是本地文件
  node src/cli.js sync-records         刷新后台状态：列出账号所有作品 + 同步已发/未发记录（面板打开时自动跑）
  node src/cli.js browsers             列出本机可用的浏览器（发布时会自动挑一个）
  node src/cli.js status               查看发布进度 + 今日字数额度
  node src/cli.js daily                查看今天的字数额度用了多少
                                       --set 5000 手动把今日已发改成 5000（你在后台手动发过时用）
                                       --clear    把今天的账本清零
  node src/cli.js reset                查看/清除发布记录（误报成功时用它重发）
                                       --chapter 22 清某一章（写"第几章"或目录序号都行）；--all 全部清空
  node src/cli.js check                发布前自检（建议每次发布前跑一下）
                                       加 --online 会额外检查登录态（会开浏览器）

  node src/cli.js publish --dry        演练：打开网页填好内容，但不点发布
  node src/cli.js publish              一键发布：一直发到当天的字数额度放不下下一章为止
                                       章数由 dailyCharLimit 控制（默认 10000 字/天）
  node src/cli.js publish --limit 1    只发 1 章（临时覆盖 maxPerRun）
  node src/cli.js publish --all        忽略章数上限，把没发过的章节全部发完
  node src/cli.js publish --chapter 5    只发第 5 章（写"第几章"或目录序号都行）
  node src/cli.js publish --at 08:00     用番茄自带的定时发布：定到下一次 08:00
                                         （也支持 "2026-10-08 08:00"；每天固定时间就把
                                           config.json 的 publish.scheduledAt 填成 "08:00"）
  node src/cli.js publish --at "08:00,12:00,18:00"
                                         ★ 单章单独定时：多段按发布顺序逐章对应，
                                           不够循环、不够晚自动顺延次日（3 段铺 6 章 =
                                           今天 8/12/18 点各一章，明天同表再来一遍）
  node src/cli.js publish --chapter 5,7,9
                                         只发自选的这几章（逗号分隔，按书中顺序发）
                                         照样受日字数额度管：放不下的会留到明天

  可选参数：
    --mode draft       只存草稿（对应 config.json 的 publish.mode）
    --mode publish     直接发布
    --force            忽略"已发布"记录，强制重发
    --unattended       无人值守模式（不等待人工操作，适合定时任务）
    --skip-lint        发布前跳过小说文件格式校验

  node src/cli.js timer-set --time 08:00    设置每天定时自动发布
  node src/cli.js timer-remove              取消定时自动发布
`);
      break;
  }
}

main().catch((e) => {
  logger.fail(String(e.message || e));
  process.exit(1);
});
