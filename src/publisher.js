/**
 * 发布主流程
 *
 * 流程：打开浏览器 -> 确认登录 -> 进入作品 -> 新建章节 -> 填标题+正文 -> 发布/存草稿
 * 任何一步自动识别失败，都会保存诊断文件并给出可操作的提示。
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const {
  ROOT,
  ensureDir,
  sleep,
  randomInt,
  countChars,
  stripChapterPrefix,
  cnNumToInt,
  parseChapterNoFromTitle,
  resolveChapterSelection,
  parseScheduleTime,
} = require('./util');
const { launch, getPage } = require('./browser');
const { loadManifest, loadChapterBody } = require('./split');
const { findTitleInput, findContentEditor, findButton, findDialogOption, findElement, findChapterNoInput } = require('./locator');
const { fillEditor, fillTitle } = require('./editor');
const { autoLogin, isLoggedIn, waitForContent } = require('./login');
const { loadCredentials } = require('./credentials');
const { getMaxChapterNo, resolveBook, fetchPlatformChapters } = require('./site-reader');
const { normalizeVolumeName, matchVolumeOption } = require('./volume');
const progress = require('./progress');
const daily = require('./daily');

/* ------------------------- 小工具 ------------------------- */

function waitEnter(promptText) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(promptText, () => {
      rl.close();
      resolve();
    });
  });
}

/** 保存页面结构诊断文件，方便定位问题时排查 */
async function dumpDiagnostics(page, tag, logger) {
  const dir = ensureDir(path.join(ROOT, 'logs'));
  try {
    const info = await page.evaluate(() => {
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      const d = (el) => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          type: el.type || '',
          placeholder: el.placeholder || '',
          name: el.name || '',
          id: el.id || '',
          cls: String(el.className || '').slice(0, 100),
          text: String(el.innerText || '').trim().slice(0, 50).replace(/\s+/g, ' '),
          rect: { w: Math.round(r.width), h: Math.round(r.height) },
        };
      };
      return {
        url: location.href,
        title: document.title,
        inputs: [...document.querySelectorAll('input,textarea')].filter(vis).map(d),
        editables: [...document.querySelectorAll('[contenteditable="true"]')].filter(vis).map(d),
        buttons: [...document.querySelectorAll('button,a,[role="button"]')].filter(vis).map(d).filter((x) => x.text).slice(0, 60),
        // 弹窗/遮罩：排查"卡在某个对话框"时最有用
        dialogs: [
          ...document.querySelectorAll(
            '.arco-modal,.arco-modal-wrapper,[role="dialog"],[class*="modal"],[class*="dialog"],[class*="Modal"],[class*="Dialog"],[class*="popup"],[class*="Popup"]'
          ),
        ]
          .filter(vis)
          .map(d)
          .slice(0, 10),
        // 单选/开关：排查"必填项没选导致确认按钮禁用"时最有用
        // （番茄「发布设置」弹窗的「是否使用AI」就是这种，不选确认发布点不动）
        choices: [
          ...document.querySelectorAll(
            'input[type="radio"],input[type="checkbox"],.arco-radio,.arco-switch,.arco-checkbox,[role="radio"],[role="switch"],[class*="switch"]'
          ),
        ]
          .filter(vis)
          .map((el) => ({
            ...d(el),
            checked: !!el.checked,
            checkedCls: /checked|selected|active/.test(String(el.className || '')),
          }))
          .slice(0, 20),
        // 弹窗原始 HTML：选择器猜不准时看这个最直接（截断保存）
        modalsHtml: [
          ...document.querySelectorAll('.arco-modal,[role="dialog"]'),
        ]
          .filter(vis)
          .map((el) => String(el.outerHTML || '').slice(0, 6000))
          .slice(-2),
        bodyText: (document.body.innerText || '').slice(0, 2500),
      };
    });
    fs.writeFileSync(path.join(dir, `structure-${tag}.json`), JSON.stringify(info, null, 2), 'utf8');
    await page.screenshot({ path: path.join(dir, `shot-${tag}.png`) }).catch(() => {});
    logger.info(`已保存页面诊断文件：logs/structure-${tag}.json 和 logs/shot-${tag}.png`);
    return info;
  } catch (e) {
    logger.warn('保存诊断文件失败：' + String(e.message).split('\n')[0]);
    return null;
  }
}

/* ------------------------- 提交结果判定 ------------------------- */

/**
 * 页面上是否出现了"成功"类文案。
 *
 * ⚠️ 这里的词表必须**分模式**，而且宁严不宽 —— 踩过的坑：
 * 番茄编辑器顶部常驻一行「已保存到云端 正文字数 1875」，
 * 如果把「已保存」当成成功信号，就会在"点完下一步、弹窗还开着"的时候误判成功、
 * 提前退出，既不点弹窗也不点最终的「发布」，最后谎报"已发布"。
 *
 * 所以：
 *   - 发布模式：只认强信号（发布成功 / 提交成功 / 审核中），**绝不认「已保存」**
 *   - 存草稿模式：才认「已保存 / 保存成功」这类弱信号
 */
async function detectSuccessText(page, { isDraft = false } = {}) {
  const STRONG = ['发布成功', '已成功发布', '发布完成', '提交成功', '提交审核成功', '已提交审核'];
  const WEAK = ['保存成功', '草稿已保存', '已保存'];
  const WORDS = isDraft ? [...STRONG, ...WEAK] : STRONG;

  try {
    const txt = await page.evaluate(() => (document.body.innerText || '').slice(0, 8000));
    for (const w of WORDS) if (txt.includes(w)) return w;
  } catch (_) {}
  return null;
}

/** 页面是否还像"章节编辑页"（还存在富文本正文区） */
async function looksLikeEditorPage(page) {
  try {
    const n = await page.locator('[contenteditable="true"]').count();
    return n > 0;
  } catch (_) {
    return true; // 判断不了就当作还在编辑页，让后续轮次继续尝试
  }
}

/* ------------------------- 各种弹窗 ------------------------- */

/** 弹窗/确认框里绝对不能点的按钮 */
const DIALOG_EXCLUDES = ['取消', '返回', '关闭', '放弃', '不用了', '稍后', '去修改', '我再想想'];

/* ------------------------- 发布设置弹窗 ------------------------- */

/**
 * ★★ 在「发布设置」弹窗里处理「定时发布」开关（平台自带的定时功能）。
 *
 * DOM（2026-10-07 实测，诊断脚本 logs/diag-schedule.js 那轮的结论）：
 *   · 弹窗容器 = 同时含「是否使用AI」和「确认发布」文字的**最小 div**
 *     ★★ 页面上可能有多个 `button.arco-switch`，绝不能拿全页第一个 —— 必须圈定在容器里
 *   · 开关：容器里的 `button.arco-switch`，`arco-switch-checked` / `aria-checked` 表状态
 *   · 开关打开后（有 350ms 展开动画）出现两个 Arco 输入框：
 *       `input[placeholder="请选择日期"]`（默认今天）、`input[placeholder="请选择时间"]`（默认 15:00）
 *     填法：先日期后时间，各 fill 完按 Enter 落值（Arco 的 picker 靠回车提交）
 *   · 打开开关后页面会提示：「章节通过审核后，将向读者展示预计发布时间，请谨慎选择定时发布时间」
 *
 * @param {Page} page
 * @param {{date: Date, text: string}} schedule 已由 parseScheduleTime 解析好的定时时刻
 * @param {Logger} logger
 * @param {string[]} clicks
 * @param {boolean} turningOn true = 这次要定时发布；false = 维持旧行为（确保开关是关的）
 */
async function applyScheduleInDialog(page, schedule, logger, clicks, turningOn) {
  // 圈定弹窗容器：同时含「是否使用AI」和「确认发布」的最小 div
  const grab = () =>
    page.evaluate(() => {
      const norm = (s) => String(s || '').replace(/\s+/g, '');
      const els = [...document.querySelectorAll('div')].filter((d) => {
        const t = norm(d.innerText);
        return t.includes('是否使用AI') && t.includes('确认发布');
      });
      els.sort((a, b) => norm(a.innerText).length - norm(b.innerText).length);
      const dlg = els[0];
      if (!dlg) return null;
      const sw = dlg.querySelector('button.arco-switch');
      const state = sw
        ? /arco-switch-checked/.test(String(sw.className)) || sw.getAttribute('aria-checked') === 'true'
          ? 'on'
          : 'off'
        : 'none';
      const dateInput = dlg.querySelector('input[placeholder="请选择日期"]');
      const timeInput = dlg.querySelector('input[placeholder="请选择时间"]');
      return {
        state,
        dateVal: dateInput ? dateInput.value : null,
        timeVal: timeInput ? timeInput.value : null,
        hasDate: !!dateInput,
        hasTime: !!timeInput,
      };
    });

  const clickSwitch = () =>
    page
      .evaluate(() => {
        const norm = (s) => String(s || '').replace(/\s+/g, '');
        const els = [...document.querySelectorAll('div')].filter((d) => {
          const t = norm(d.innerText);
          return t.includes('是否使用AI') && t.includes('确认发布');
        });
        els.sort((a, b) => norm(a.innerText).length - norm(b.innerText).length);
        const sw = els[0] && els[0].querySelector('button.arco-switch');
        if (sw) sw.click();
      })
      .catch(() => {});

  const before = await grab().catch(() => null);
  if (!before || before.state === 'none') {
    throw new Error('发布设置弹窗里没找到「定时发布」开关 —— 页面可能改版了，请先到后台人工核对');
  }

  if (!turningOn) {
    // 旧行为：确保开关是关的（关着 = 过审后立即发布）
    if (before.state === 'on') {
      await clickSwitch();
      await page.waitForTimeout(600);
      logger.info('发布设置：把「定时发布」关掉了（关着才是过审后立即发布）');
      clicks.push('关定时发布');
    }
    return;
  }

  // ---- 要定时：确保开关打开，再填日期和时间 ----
  if (before.state !== 'on') {
    await clickSwitch();
    await page.waitForTimeout(1200); // 等日期/时间控件展开（有 350ms 过渡动画）
  }

  const wantDate = schedule.text.slice(0, 10); // "YYYY-MM-DD"
  const wantTime = schedule.text.slice(11); // "HH:mm"

  for (const [ph, val] of [
    ['请选择日期', wantDate],
    ['请选择时间', wantTime],
  ]) {
    const focused = await page
      .evaluate((ph2) => {
        const norm = (s) => String(s || '').replace(/\s+/g, '');
        const els = [...document.querySelectorAll('div')].filter((d) => {
          const t = norm(d.innerText);
          return t.includes('是否使用AI') && t.includes('确认发布');
        });
        els.sort((a, b) => norm(a.innerText).length - norm(b.innerText).length);
        const inp = els[0] && els[0].querySelector(`input[placeholder="${ph2}"]`);
        if (!inp) return false;
        inp.focus();
        return true;
      }, ph)
      .catch(() => false);
    if (!focused) {
      throw new Error(`「定时发布」打开了，但没找到「${ph}」输入框 —— 页面可能改版了，请先到后台人工核对`);
    }
    const loc = page.locator(`input[placeholder="${ph}"]`).first();
    await loc.fill(val, { timeout: 8000 }).catch(async () => {
      await loc.click({ timeout: 8000 }).catch(() => {});
      await page.keyboard.insertText(val).catch(() => {});
    });
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(600);
  }

  // 回读验证：两个框里必须是我们刚填的值（Arco 面板没关/没落上值时能及时发现）
  const after = await grab().catch(() => null);
  const dateOk = after && String(after.dateVal || '').trim() === wantDate;
  const timeOk = after && String(after.timeVal || '').trim() === wantTime;
  if (!dateOk || !timeOk) {
    logger.warn(
      `定时时间回读不一致：日期框="${after && after.dateVal}"（要 ${wantDate}）、时间框="${after && after.timeVal}"（要 ${wantTime}）`
    );
    logger.warn('  选择器面板可能还开着 —— 按一下 Esc 再补一次');
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(600);
  } else {
    logger.ok(`发布设置：定时发布已打开 → ${schedule.text}（平台到点自动放出）`);
    clicks.push(`定时=${schedule.text}`);
  }
}

/**
 * 番茄的「发布设置」弹窗 —— 在选完内容检测方式之后必弹的一个必填表单。
 *
 * 实测（2026-09；定时部分 2026-10-07 更新）字段与结构：
 *   分卷 / 章节 / 上次提交        只读展示
 *   是否使用AI   ⭘ 是   ⭘ 否     ★必填。不选 → 「确认发布」按钮 disabled，点了完全没反应
 *   定时发布      button.arco-switch + 打开后出现「请选择日期」「请选择时间」两个输入框
 *                 ★ 交互细节与容器圈定规则见 applyScheduleInDialog
 *   取消 / 确认发布
 *
 * DOM：
 *   <div class="arco-radio-group" role="radiogroup">
 *     <label class="arco-radio"><input type="radio" value="1"><span class="arco-radio-text">是</span></label>
 *     <label class="arco-radio"><input type="radio" value="2"><span class="arco-radio-text">否</span></label>
 *   </div>
 *
 * 典型症状（踩过）：日志一直刷「处理弹窗：点击「确认发布」」，但页面纹丝不动，
 * 后台核对也永远不通过 —— 根因就是这个必填单选框没选，按钮始终是禁用的。
 *
 * 本函数只负责"把表单填对"，不点「确认发布」；点确认交给 handleDialogs 统一走，
 * 这样"同一个按钮只点一次"的防抖才有意义（避免重复提交）。
 *
 * @param {Page} page
 * @param {object} cfg
 * @param {Logger} logger
 * @param {string[]} clicks
 * @param {{date: Date, text: string}|null} schedule 定时信息；null = 不定时（开关保持关）
 * @returns {boolean} 是否检测到并处理了这个弹窗
 */
async function fillPublishSettingsIfPresent(page, cfg, logger, clicks, schedule) {
  const present = await page
    .evaluate(() => (document.body.innerText || '').includes('是否使用AI'))
    .catch(() => false);
  if (!present) return false;

  // ---- 1) 必填项：是否使用AI（幂等，已选对就不动）----
  const wantText = cfg.publish.aiGenerated === 'yes' ? '是' : '否';
  const already = await page
    .evaluate((t) => {
      const labels = [...document.querySelectorAll('label.arco-radio')];
      return labels.some((l) => {
        if (String(l.innerText || '').trim() !== t) return false;
        const input = l.querySelector('input[type="radio"]');
        return input ? input.checked : /checked/.test(String(l.className));
      });
    }, wantText)
    .catch(() => false);

  if (!already) {
    // 用 DOM 里真实存在的 .arco-radio-text 精确定位，避免点到整个单选组
    const opt = page
      .locator('label.arco-radio')
      .filter({ has: page.locator('.arco-radio-text', { hasText: new RegExp(`^\\s*${wantText}\\s*$`) }) });
    const n = await opt.count().catch(() => 0);
    if (n) {
      await opt.first().click({ timeout: 8000 }).catch(async () => {
        await opt.first().evaluate((e) => e.click()).catch(() => {});
      });
      await page.waitForTimeout(700);
      logger.info(`发布设置：「是否使用AI」→ 选「${wantText}」`);
      clicks.push(`AI声明=${wantText}`);
    } else {
      logger.warn(`发布设置：没找到「是否使用AI → ${wantText}」这个单选项，确认发布可能仍是禁用的`);
    }
  }

  // ---- 2) 定时发布：按调用方的意图处理 ----
  //   schedule 为空 → 确保开关是关的（关着 = 过审后立即发布，旧行为）
  //   schedule 有值 → 打开开关并填入日期/时间（applyScheduleInDialog 里会回读验证）
  try {
    await applyScheduleInDialog(page, schedule, logger, clicks, !!schedule);
  } catch (e) {
    // 定时失败要让人知道是"定时"环节出的事，不是页面别的部分坏了
    const msg = String(e.message || e).split('\n')[0];
    if (schedule) throw new Error('定时发布设置失败：' + msg);
    logger.warn('处理「定时发布」开关时出错（不影响本次立即发布）：' + msg);
  }

  return true;
}

/**
 * 处理点「下一步」之后可能出现的各种弹窗。
 *
 * 番茄实测流程（2026-09）：
 *   编辑页点「下一步」
 *     → 弹「请选择内容检测方式」：全面检测（每日限次）/ 基础检测（不限次）
 *     → 弹「发布设置」：必填「是否使用AI」，还要确认「定时发布」是关的
 *     → 点「确认发布」→ 才真正提交
 * 也就是说一次发布其实是 3~4 步，而且中间夹着两个必填弹窗。
 *
 * 这个函数循环最多 6 轮，每轮：先填「发布设置」的必填项 → 再找可点的按钮点一个，
 * 直到没有可点的为止。
 *
 * ★ 必须用 findDialogOption 而不是 findButton：
 *   内容检测弹窗的两个选项外面套了一层容器 div，容器的 innerText 是两个选项
 *   文字拼起来的（"仅基础检测\n全面检测"），面积又比按钮大，用 findButton 会
 *   点中容器 —— 等于没点。2026-09 实测踩过这个坑。
 *
 * @returns {string[]} 实际点过的按钮文字
 */
/**
 * ★★ 共享的"后台发布记录导入"：拉后台章节 → 和本地章节配对 → 写 progress → 重算今日额度。
 *
 * 两个调用方（同一件事一处实现）：
 *   · cli 的 sync-records 命令（手动）
 *   · 发布流程的安全网（本地一条记录都没有时自动跑，防"从头重发"）
 *
 * 调用前提：ctx 已登录、cfg.site.bookId 已由 applyResolvedBook 填好。
 * @returns {{pf: object, plan: object, led: object|null}}
 */
async function importPlatformRecords(ctx, cfg, manifest, logger) {
  const pf = await fetchPlatformChapters(ctx, cfg, logger);
  const books = require('./books');
  const plan = books.planRecordImport(manifest.chapters || [], pf.chapters);
  const progress = require('./progress');
  for (const m of plan.toMark) {
    progress.markPublished(m.title, {
      status: 'published',
      mode: 'import',
      chapterNo: m.chapterNo,
      verified: true,
      at: m.at || undefined,
    });
  }
  const daily = require('./daily');
  const led = daily.isEnabled(cfg) ? daily.recountToday(logger) : null;
  return { pf, plan, led };
}

async function handleDialogs(page, cfg, logger, clicks, schedule) {
  // 内容检测方式：默认用「基础检测」（不限次数）。想用全面检测就改 config.json
  const contentTexts =
    cfg.publish.contentCheck === 'full' ? ['全面检测'] : ['仅基础检测', '基础检测'];
  // 确认类只保留"指向明确"的词。
  // 故意不带通用的「确认」「确定」—— 万一页面别处有个无关的「确定」，
  // 会在这里被误点。通用词交给主流程最后几轮的 finalTexts 去匹配。
  const confirmTexts = ['确认发布', '确定发布', '继续发布', '仍要发布', '确认提交'];
  const groups = [contentTexts, confirmTexts];

  const done = [];
  const clicked = new Set(); // 防抖：同一个按钮别连点好几次（避免重复提交）
  for (let i = 0; i < 6; i++) {
    // ★ 每轮先填「发布设置」里的必填项。
    //   不填的话「确认发布」永远禁用，点了没反应 —— 实测踩过的坑。
    await fillPublishSettingsIfPresent(page, cfg, logger, clicks, schedule);

    let hitLabel = null;
    let isContentCheck = false;
    for (const texts of groups) {
      // 精确定位：只在弹窗里找"真按钮"，绝不点包着多个选项的容器
      let el = await findDialogOption(page, texts);
      if (!el) {
        // 兜底：某些弹窗的按钮不是 <button>
        const fb = await findButton(page, texts, DIALOG_EXCLUDES);
        el = fb.el || null;
      }
      if (!el) continue;

      const label = await el
        .evaluate((e) => String(e.innerText || '').trim().slice(0, 20))
        .catch(() => '');
      const key = label || '(无文字按钮)';
      if (clicked.has(key)) continue; // 这轮已经点过同样的按钮了，别再点

      // 禁用状态的按钮点了也白点，明确告诉用户还差什么
      const disabled = await el
        .evaluate((e) => e.disabled === true || /disabled/.test(String(e.className || '')))
        .catch(() => false);
      if (disabled) {
        logger.warn(`弹窗里的「${key}」是禁用状态（还有必填项没填），先不点它`);
        clicked.add(key);
        continue;
      }

      clicked.add(key);
      logger.info(`处理弹窗：点击「${key}」`);
      await el.click({ timeout: 10000 }).catch(async () => {
        await el.evaluate((e) => e.click()).catch(() => {});
      });
      isContentCheck = texts === contentTexts;
      // 选完内容检测方式后要等检测跑完、下一步的弹窗渲染出来
      await page.waitForTimeout(isContentCheck ? 5000 : 4000);
      clicks.push(key);
      done.push(key);
      hitLabel = key;
      break;
    }
    if (!hitLabel) break; // 没有可点的弹窗按钮了
  }
  return done;
}

/* ------------------------- 登录 ------------------------- */

/**
 * 确保处于登录状态，按优先级依次尝试：
 *   1. 已有登录态 → 直接用（最快）
 *   2. credentials.json 里配了账号密码 → 自动登录
 *   3. 退回人工登录（无人值守模式下直接报错退出）
 */
async function ensureLoggedIn(page, cfg, logger, { interactive = true } = {}) {
  await page.goto(cfg.site.writerHome, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await waitForContent(page);
  await page.waitForTimeout(1500);

  if (await isLoggedIn(page)) {
    logger.ok('登录状态有效，无需重新登录');
    return true;
  }

  // ---- 尝试自动登录 ----
  let cred = null;
  try {
    cred = loadCredentials(cfg);
  } catch (e) {
    logger.warn('credentials.json 读不了（格式错误？）：' + String(e.message).split('\n')[0]);
  }
  if (cred) {
    logger.info('检测到未登录，使用配置的账号自动登录...');
    const r = await autoLogin(page, cfg, logger, { timeoutSeconds: 30 });
    if (r.ok) return true;
    logger.warn(`自动登录没成功（原因：${r.reason}）`);
    if (r.body) logger.warn('页面提示：' + String(r.body).replace(/\s+/g, ' ').slice(0, 200));
  } else {
    logger.warn('没有配置账号密码（credentials.json 缺失或为空）');
  }

  // ---- 人工兜底 ----
  if (!interactive) {
    throw new Error('未登录，且无人值守模式无法人工介入。请先运行一次「1-首次登录」完成登录。');
  }

  logger.warn('请在浏览器窗口里手动完成登录（扫码 或 手机验证码），脚本会自动等待。');
  logger.warn(`最多等待 ${cfg.browser.loginTimeoutSeconds} 秒...`);

  const deadline = Date.now() + cfg.browser.loginTimeoutSeconds * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    if (await isLoggedIn(page)) {
      logger.ok('登录成功，登录状态已保存到本地，下次不用再登');
      await page.waitForTimeout(1500);
      return true;
    }
  }
  throw new Error('等待登录超时。请重新运行登录流程。');
}

/* ------------------------- 进入章节编辑页 ------------------------- */

/** 点击后可能开新标签页，这里统一处理并返回真正承载编辑器的 page */
async function clickAndFollow(page, ctx, el, logger) {
  const before = ctx.pages().length;
  await el.click({ timeout: 15000 }).catch(async (e) => {
    logger.warn('直接点击失败，尝试用 JS 点击：' + String(e.message).split('\n')[0]);
    await el.evaluate((e2) => e2.click()).catch(() => {});
  });
  await page.waitForTimeout(3500);

  let target = page;
  if (ctx.pages().length > before) {
    target = ctx.pages()[ctx.pages().length - 1];
    logger.info('编辑器在新标签页中打开');
  }
  await target.bringToFront().catch(() => {});
  await target.waitForLoadState('domcontentloaded').catch(() => {});
  await target.waitForTimeout(3000);
  return target;
}

/**
 * 进入"新建章节"编辑页。
 * 先尝试全自动找到入口；找不到就降级为半自动（提示用户自己点进去，回车后脚本接管）。
 */
async function enterNewChapter(ctx, page, cfg, logger, { interactive = true } = {}) {
  // 0) 配了「创建章节页」地址 → 直奔编辑页（最稳，推荐）
  if (cfg.site.createChapterUrl) {
    logger.info('直接打开创建章节页：' + cfg.site.createChapterUrl);
    await page.goto(cfg.site.createChapterUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await waitForContent(page, { tries: 15, gap: 1200 });
    await page.waitForTimeout(4000);
    // 等富文本编辑器渲染出来
    for (let i = 0; i < 15; i++) {
      const n = await page.locator('[contenteditable="true"]').count().catch(() => 0);
      if (n > 0) break;
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(1500);
    logger.ok('已进入章节编辑页：' + page.url());
    return page;
  }

  // 1) 直接给定了作品地址，就跳过去
  if (cfg.site.bookUrl) {
    logger.info('按 config.json 指定的作品地址打开：' + cfg.site.bookUrl);
    await page.goto(cfg.site.bookUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(4000);
  } else {
    // 2) 回到作品管理页
    logger.info('打开作品管理页');
    await page.goto(cfg.site.writerHome, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(4000);

    // 如果配了书名，先点进这本书
    if (cfg.site.bookName) {
      const bookLink = await findElement(page, {
        selector: 'a, div[class*="book"], div[class*="item"], li',
        matchText: [cfg.site.bookName],
      });
      if (bookLink.el) {
        logger.info(`找到作品「${cfg.site.bookName}」，点进去`);
        page = await clickAndFollow(page, ctx, bookLink.el, logger);
      } else {
        logger.warn(`没找到作品「${cfg.site.bookName}」的入口，继续在当前页面找"新建章节"`);
      }
    }
  }

  // 3) 找"写新章节 / 新建章节"按钮
  const entryTexts = ['写新章节', '新建章节', '新增章节', '添加章节', '创建章节', '写章节', '新建作品章节', '继续创作', '开始创作', '新建'];
  const found = await findButton(page, entryTexts, ['取消', '删除', '退出', '关闭']);
  if (found.el) {
    const label = await found.el.evaluate((e) => String(e.innerText || '').trim().slice(0, 20)).catch(() => '');
    logger.ok(`找到章节入口：「${label}」`);
    return await clickAndFollow(page, ctx, found.el, logger);
  }

  logger.warn('没能自动找到"新建章节"入口。');
  await dumpDiagnostics(page, 'no-entry', logger);

  if (!interactive) {
    throw new Error('无人值守模式下无法自动进入编辑器，已跳过。请检查 logs/ 下的诊断文件。');
  }

  logger.warn('===== 需要你手动操作一下 =====');
  logger.warn('请在浏览器里自己点到「写新章节」的编辑页面（能看到标题框和正文输入区）。');
  await waitEnter('点好后回到这个窗口，按回车键继续...');
  const target = ctx.pages()[ctx.pages().length - 1];
  await target.bringToFront().catch(() => {});
  await target.waitForTimeout(2000);
  logger.ok('已接管当前页面：' + target.url());
  return target;
}

/* ------------------------- 分卷 ------------------------- */

/** 编辑页顶栏那个"卷名"（.publish-header-volume-name）当前显示什么；没有返回 null */
async function readCurrentVolume(page) {
  const el = page.locator('.publish-header-volume-name').first();
  if ((await el.count().catch(() => 0)) === 0) return null;
  return String((await el.innerText().catch(() => '')) || '').trim();
}

/**
 * 等编辑页顶栏的分卷控件渲染出来。
 *
 * ★ 必须等，不能"读一次没有就判失败"：
 *   刚 goto 进编辑页时顶栏可能还没渲染完，如果此时直接判"找不到分卷控件"，
 *   就会变成**每一章都因为分卷问题而不发**（而且是静默的连累）。
 */
async function waitForVolumeControl(page, tries = 15, gap = 800) {
  for (let i = 0; i < tries; i++) {
    if ((await page.locator('.publish-header-volume-name').count().catch(() => 0)) > 0) return true;
    await page.waitForTimeout(gap);
  }
  return false;
}

/** 点开顶栏的分卷控件后，读出下拉里的候选卷 */
async function readVolumeOptions(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden';
    };

    // ★ 只取最内层的 .editor-volume-list-item-normal（它的 innerText 恰好就是卷名）。
    // 不要取外层的 .editor-volume-list-item / .editor-volume-list ——
    // 它们的 innerText 是"所有卷名拼在一起"，会被当成一个假选项。
    const nodes = [...document.querySelectorAll('.editor-volume-list-item-normal')].filter(vis);

    const out = [];
    for (const n of nodes) {
      const t = String(n.innerText || '').trim();
      if (!t || t.length > 40) continue;
      if (out.includes(t)) continue;
      out.push(t);
    }
    // 兜底：万一番茄换了类名，用宽泛选择器再捞一次
    if (!out.length) {
      for (const n of [...document.querySelectorAll('[class*="editor-volume-list-item"],[class*="volume-list-item"]')].filter(vis)) {
        const t = String(n.innerText || '').trim();
        if (!t || t.length > 40 || t.includes('\n') || out.includes(t)) continue;
        out.push(t);
      }
    }
    return out;
  });
}

/**
 * 把编辑页的「分卷」切到这一章该去的卷。
 *
 * ★ 这是 2026-10 实测出来的机制（踩了一次坑才搞明白）：
 *
 *   番茄的卷**不是**章节的字段，而是编辑页顶栏一个独立的选择器
 *   （span.publish-header-volume-wrap）。点它弹出的是一个**带「确定」按钮的弹窗**：
 *
 *     div.serial-modal.editor-volume.byte-modal
 *       ├ byte-modal-title        「分卷」
 *       ├ .editor-volume-list
 *       │   └ .editor-volume-list-item
 *       │       └ .editor-volume-list-item-normal[.selected]
 *       │           ├ <span>卷名</span>
 *       │           ├ <i class="tomato-delete">
 *       │           └ <i class="tomato-edit">
 *       └ .editor-volume-footer
 *           ├ .editor-volume-footer-add-volume 「新建分卷」
 *           └ .editor-volume-footer-buttons
 *               ├ <button> 取消
 *               └ <button> 确定   ← ★★ 必须点这个才真正生效！
 *
 *   只点卷名只是把那一行打上 selected 高亮，**顶栏不会变**，
 *   必须再点「确定」。第一版就是漏了这一步，导致"点了没反应"。
 *
 * @returns {{ok:boolean, skipped?:boolean, current?:string, changed?:boolean, reason?:string}}
 */
async function applyVolume(page, cfg, chapter, logger) {
  const want = String((chapter && chapter.volume) || '').trim();

  if (!want) return { ok: true, skipped: true, reason: '源文件没写这一章属于哪一卷' };
  if (cfg.novel && cfg.novel.fillVolume === false) {
    return { ok: true, skipped: true, reason: 'config.json 里 novel.fillVolume = false' };
  }

  // ★ 先等控件渲染出来再读。刚进编辑页时顶栏可能还没画完，
  //   若此时直接判"找不到控件"，就会变成"每一章都因为分卷问题不发"（静默连累全部章节）。
  const ready = await waitForVolumeControl(page);
  const cur = ready ? await readCurrentVolume(page) : null;
  if (cur === null) {
    return {
      ok: false,
      reason:
        '等了 12 秒也没在编辑页上找到分卷控件（.publish-header-volume-name）。' +
        '原因通常是番茄改版了，或者这本书后台还没建过分卷。' +
        '如果你确认编辑页上确实没有"卷"这个东西，就把 config.json 里的 novel.fillVolume 改成 false，' +
        '之后就不再做分卷切换了。另外把 logs/ 下的诊断文件给我看，我来对一下页面结构。',
    };
  }

  if (normalizeVolumeName(cur) === normalizeVolumeName(want)) {
    logger.info(`分卷已经是「${cur}」，不用切`);
    return { ok: true, current: cur, changed: false };
  }

  logger.info(`分卷需要切换：「${cur || '(空)'}」→「${want}」`);

  const wrap = page.locator('.publish-header-volume-wrap').first();
  if ((await wrap.count().catch(() => 0)) === 0) {
    return { ok: false, reason: '找不到分卷控件的可点区域（.publish-header-volume-wrap）' };
  }
  await wrap.click({ timeout: 10000 }).catch(async () => {
    await wrap.evaluate((e) => e.click()).catch(() => {});
  });

  // 等"分卷"弹窗真的弹出来
  const modal = page.locator('.serial-modal.editor-volume, .editor-volume.byte-modal, .editor-volume').first();
  const appeared = await modal
    .waitFor({ state: 'visible', timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    await page.keyboard.press('Escape').catch(() => {});
    return { ok: false, reason: '点击分卷控件后没弹出「分卷」弹窗' };
  }
  await page.waitForTimeout(1200);

  const options = await readVolumeOptions(page);
  if (!options.length) {
    await closeVolumeModal(page, logger);
    return {
      ok: false,
      reason: '分卷弹窗里没读到任何卷 —— 番茄可能要你先在后台建卷',
    };
  }
  logger.info(`后台现有分卷：${options.join(' / ')}`);

  const hit = matchVolumeOption(want, options);
  if (!hit) {
    await closeVolumeModal(page, logger);
    return {
      ok: false,
      reason:
        `后台没有「${want}」这个卷（现有：${options.join('、')}）。` +
        `请先在番茄后台的章节管理页点「编辑分卷」把这一卷建出来，再重新发布。`,
    };
  }

  // ① 点选那一行（只是高亮）
  const picked = await clickVolumeOption(page, hit.text);
  if (!picked) {
    await closeVolumeModal(page, logger);
    return { ok: false, reason: `分卷弹窗里点不到「${hit.text}」` };
  }
  logger.info(`已点选「${hit.text}」（${hit.how}）`);
  await page.waitForTimeout(800);

  // ② ★ 点「确定」—— 漏了这一步，前面全白干
  const confirmed = await confirmVolumeModal(page);
  if (!confirmed) {
    await closeVolumeModal(page, logger);
    return { ok: false, reason: '分卷弹窗里没找到「确定」按钮，切换没提交' };
  }
  logger.info('已点「确定」');
  await page.waitForTimeout(3000);

  // 切卷有可能触发页面重载，等编辑器和分卷控件一起回来再继续
  for (let i = 0; i < 12; i++) {
    if ((await page.locator('[contenteditable="true"]').count().catch(() => 0)) > 0) break;
    await page.waitForTimeout(800);
  }
  await waitForVolumeControl(page, 10, 800); // ★ 重载后顶栏也要等它画出来，否则会误判"没切成功"
  await page.waitForTimeout(1500);

  const after = await readCurrentVolume(page);
  // 终判：顶栏现在显示的这一卷，是不是我们要的那一卷。
  // 不直接比字符串 —— 顶栏的写法可能和后台列表、源文件里的写法不完全一致
  // （冒号全角半角、少个书名号、只写了「第X卷」…），所以用同一套匹配规则再认一遍。
  const matchedNow =
    after !== null &&
    (normalizeVolumeName(after) === normalizeVolumeName(hit.text) || !!matchVolumeOption(want, [after]));
  if (!matchedNow) {
    return {
      ok: false,
      reason: `切卷没生效：点了「${hit.text}」并确认，顶栏显示的还是「${after || '(读不到)'}」`,
    };
  }

  logger.ok(`分卷已切到「${after}」`);
  return { ok: true, current: after, changed: true, how: hit.how };
}

/**
 * 在「分卷」弹窗里点选某一卷。
 * 严格按文字**完全相等**匹配 —— 避免「第一卷：落霞镇」和「第一卷：落霞镇东区」撞车。
 */
async function clickVolumeOption(page, text) {
  const nodes = page.locator('.editor-volume-list-item-normal');
  const n = await nodes.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = nodes.nth(i);
    const t = String((await el.innerText().catch(() => '')) || '').trim();
    if (t !== text) continue;
    await el.click({ timeout: 8000 }).catch(async () => {
      await el.evaluate((e) => e.click()).catch(() => {});
    });
    return true;
  }
  return false;
}

/** 点「分卷」弹窗右下角的「确定」 */
async function confirmVolumeModal(page) {
  const byClass = page.locator('.editor-volume-footer-buttons button.byte-btn-primary').first();
  if ((await byClass.count().catch(() => 0)) > 0) {
    await byClass.click({ timeout: 8000 }).catch(async () => {
      await byClass.evaluate((e) => e.click()).catch(() => {});
    });
    return true;
  }
  // 类名变了就按文字找
  const byText = page.locator('.editor-volume-footer button, .editor-volume button').filter({ hasText: /^\s*确定\s*$/ }).first();
  if ((await byText.count().catch(() => 0)) > 0) {
    await byText.click({ timeout: 8000 }).catch(async () => {
      await byText.evaluate((e) => e.click()).catch(() => {});
    });
    return true;
  }
  return false;
}

/** 关掉「分卷」弹窗（点「取消」，失败就按 Esc）——失败路径收尾用，避免弹窗挡住后续操作 */
async function closeVolumeModal(page, logger) {
  try {
    const cancel = page.locator('.editor-volume-footer-buttons button.byte-btn-default').first();
    if ((await cancel.count().catch(() => 0)) > 0) {
      await cancel.click({ timeout: 5000 }).catch(() => {});
    } else {
      await page.keyboard.press('Escape').catch(() => {});
    }
  } catch (_) {
    await page.keyboard.press('Escape').catch(() => {});
  }
  await page.waitForTimeout(1000);
  if (logger) logger.info('已关掉分卷弹窗（没有改动）');
}

/* ------------------------- 单章发布 ------------------------- */

async function publishOne(ctx, cfg, chapter, body, opts, logger, chapterNo = 0) {
  const pagesBefore = new Set(ctx.pages());
  try {
    return await publishOneInner(ctx, cfg, chapter, body, opts, logger, chapterNo);
  } finally {
    // 关掉本章新开出来的标签页，避免连发多章时标签页越堆越多
    for (const p of [...ctx.pages()]) {
      if (!pagesBefore.has(p)) {
        await p.close().catch(() => {});
      }
    }
  }
}

async function publishOneInner(ctx, cfg, chapter, body, opts, logger, chapterNo = 0) {
  // 番茄的「第 [序号] 章」和标题是两个独立输入框，标题里不能再带"第一章"
  const pureTitle =
    cfg.novel.stripChapterPrefix === false ? chapter.title : stripChapterPrefix(chapter.title);
  const finalTitle = pureTitle || chapter.title;

  logger.step(`开始处理：${chapter.title}（${countChars(body)} 字）`);

  const page = await getPage(ctx);
  const editorPage = await enterNewChapter(ctx, page, cfg, logger, { interactive: !opts.unattended });

  // ---- 分卷：先把目标卷切对，再填内容 ----
  // 必须放在填标题/正文之前 —— 切卷有可能导致页面重载，先填会被清掉。
  const volRes = await applyVolume(editorPage, cfg, chapter, logger);
  if (volRes.skipped) {
    logger.info(`跳过分卷设置（${volRes.reason}）`);
  } else if (!volRes.ok) {
    // 卷对不上就绝不发 —— 发到错误的卷里比不发更麻烦（线上要手动挪）
    logger.fail(`分卷没处理好，这一章先不发：${volRes.reason}`);
    await dumpDiagnostics(editorPage, 'volume-failed', logger);
    return { ok: false, reason: `分卷处理失败：${volRes.reason}` };
  }

  // ---- 标题 ----
  const titleHit = await findTitleInput(editorPage, cfg);
  if (!titleHit.el) {
    await dumpDiagnostics(editorPage, 'no-title', logger);
    logger.fail('没找到标题输入框');
    return { ok: false, reason: '未找到标题输入框' };
  }
  // 给标题元素打标记，避免后面把标题框误判成正文编辑器
  await titleHit.el.evaluate((e) => e.setAttribute('data-nap-title', '1')).catch(() => {});

  // ---- 章节序号（"第 [ ] 章"）----
  if (chapterNo > 0) {
    const noEl = await findChapterNoInput(editorPage, cfg, titleHit.el);
    if (noEl) {
      try {
        await noEl.fill(String(chapterNo));
      } catch (_) {
        await noEl.click().catch(() => {});
        await editorPage.keyboard.insertText(String(chapterNo)).catch(() => {});
      }
      await editorPage.waitForTimeout(300);
      logger.info(`章节序号已填入：第 ${chapterNo} 章`);
    } else {
      logger.warn('没找到章节序号输入框 —— 番茄可能自动编号，继续只填标题');
    }
  }

  const tr = await fillTitle(editorPage, titleHit.el, finalTitle, logger);
  logger.info(tr.ok ? `标题已填入：${finalTitle}` : `标题可能没填好：${finalTitle}`);

  // ---- 正文 ----
  const editorHit = await findContentEditor(editorPage, cfg);
  if (!editorHit.el) {
    await dumpDiagnostics(editorPage, 'no-editor', logger);
    logger.fail('没找到正文编辑器');
    return { ok: false, reason: '未找到正文编辑器' };
  }
  const size = await editorHit.el
    .evaluate((e) => {
      const r = e.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    })
    .catch(() => ({ w: 0, h: 0 }));
  logger.info(`正文编辑器定位成功（${size.w}x${size.h}）`);

  const fillResult = await fillEditor(editorPage, editorHit.el, body, logger);
  if (!fillResult.ok) {
    await dumpDiagnostics(editorPage, 'fill-failed', logger);
    logger.fail(`正文填充失败（写入 ${fillResult.chars} 字 / 应写 ${countChars(body)} 字）`);
    return { ok: false, reason: '正文填充失败' };
  }
  logger.ok(`正文已填入（${fillResult.chars} 字，方式：${fillResult.strategy}）`);

  // ---- 提交按钮候选规则（演练预演和正式提交共用）----
  // 排序即优先级：scanFn 按 findIndex 取最靠前的关键词，所以顺序很关键
  const isDraft = cfg.publish.mode === 'draft';
  const firstTexts = isDraft
    ? ['存草稿', '保存草稿', '存为草稿', '草稿']
    : ['发布章节', '立即发布', '确认发布', '保存并发布', '提交审核', '提交', '发布', '下一步'];
  // 第二步（"发布设置"页）上真正点下去的那个按钮
  const finalTexts = ['立即发布', '确认发布', '确定发布', '继续发布', '发布章节', '保存并发布', '提交审核', '发布', '提交', '确认', '确定'];

  const baseExcludes = [
    '取消', '删除', '返回', '退出', '关闭', '上一步', '上一章', '下一章',
    '作者有话说', '人物设定', '作品大纲', '章节目录', '草稿箱',
    '存草稿', '保存草稿', '存为草稿', '存入草稿',
    '定时发布', '预览', '导入', '排版', '自动保存',
  ];
  // 存草稿模式下必须避开"下一步"（点了会进入发布流程）
  const excludes = isDraft ? [...baseExcludes, '下一步'] : baseExcludes;

  // ---- 演练模式：到此为止 ----
  if (opts.dryRun) {
    await dumpDiagnostics(editorPage, 'dry-run', logger);

    // 预演：告诉用户"正式运行时会点哪个按钮"，这里绝不点击
    try {
      const previewHit = await findButton(editorPage, firstTexts, excludes);
      if (previewHit.el) {
        const l = await previewHit.el
          .evaluate((e) => String(e.innerText || '').trim().slice(0, 20))
          .catch(() => '');
        logger.info(`预演：正式运行时会先点击「${l}」按钮（演练模式不会真的点）`);
        if (!isDraft) {
          logger.info(
            `预演：接下来会自动处理弹窗、并继续点「${finalTexts.slice(0, 3).join(' / ')}…」这类按钮，直到出现成功提示`
          );
          logger.info(
            `预演：内容检测方式会用「${
              cfg.publish.contentCheck === 'full' ? '全面检测' : '仅基础检测'
            }」（改 config.json 的 publish.contentCheck 可切换）`
          );
        }
      } else {
        logger.warn('预演：按当前配置没找到可提交的按钮，切到正式运行可能会失败');
      }
    } catch (_) {}

    logger.warn('=== 演练模式：内容已填好，但没有点提交按钮 ===');
    logger.warn('请到浏览器里自己核对一下标题和正文是否正确。');
    if (!opts.unattended) {
      await waitEnter('核对完按回车键，脚本就结束（浏览器会关闭）...');
    } else {
      await sleep(20000);
    }
    return { ok: true, reason: 'dry-run', status: 'dry' };
  }

  // ---- 正式提交 ----
  // 番茄是**多步**流程：编辑页点「下一步」→ 弹「请选择内容检测方式」选一个
  // → 可能还有风险提示 → 最后才是真正的「发布」。实测步骤数比预期的多，
  // 所以这里做成"最多 N 轮"的推进：每轮找一个可点的推进按钮点下去，
  // 直到看到成功提示、或再也找不到按钮为止。
  // 好处：不管平台是 1 步、2 步还是 4 步，这套逻辑都能走完。
  const maxRounds = Number(cfg.publish.maxSubmitRounds || 5);
  const clicks = [];
  let successText = null;
  let redirected = false;
  const url0 = editorPage.url();

  for (let round = 1; round <= maxRounds; round++) {
    // 保险：如果已经跳回作品/章节管理页，说明提交生效了，别再往下找按钮
    // （否则可能在管理页上误点到"新建/发布章节"之类的入口）
    if (round > 1) {
      const u = editorPage.url();
      if (u !== url0 && /(chapter-manage|book-manage|chapter-list)/.test(u)) {
        logger.info('页面已跳回作品/章节管理页，说明提交已经生效，停止推进');
        redirected = true;
        break;
      }
    }

    const texts = round === 1 ? firstTexts : finalTexts;
    const btnHit = await findButton(editorPage, texts, excludes);

    if (!btnHit.el) {
      if (round === 1) {
        await dumpDiagnostics(editorPage, 'no-button', logger);
        logger.fail(`没找到「${isDraft ? '存草稿' : '发布'}」按钮，内容已填好但没有提交`);
        if (!opts.unattended) await waitEnter('你可以手动点发布，或按回车跳过...');
        return { ok: false, reason: '未找到发布按钮' };
      }
      logger.info(`第 ${round} 轮：页面上已经没有可点的提交按钮了，结束推进`);
      break;
    }

    const btnLabel = await btnHit.el
      .evaluate((e) => String(e.innerText || '').trim().slice(0, 20))
      .catch(() => '');
    logger.info(`第 ${round} 轮：点击「${btnLabel || '(无文字按钮)'}」`);
    await btnHit.el.click({ timeout: 15000 }).catch(async () => {
      await btnHit.el.evaluate((e) => e.click()).catch(() => {});
    });
    await editorPage.waitForTimeout(3500);
    clicks.push(btnLabel || '(无文字按钮)');

    // ---- 处理点完之后冒出来的各种弹窗（内容检测方式 / 二次确认）----
    // 注意：必须在判断"是否成功"之前处理，否则弹窗还开着就可能被误判成已完成
    if (cfg.publish.autoConfirm !== false) {
      await handleDialogs(editorPage, cfg, logger, clicks, opts.schedule);
    }

    successText = await detectSuccessText(editorPage, { isDraft });
    if (successText) {
      logger.ok(`检测到提交成功提示：「${successText}」`);
      break;
    }

    // 存草稿一般一击结束，不用再往下推
    if (isDraft) break;

    const onEditor = await looksLikeEditorPage(editorPage);
    logger.info(
      onEditor
        ? '  → 仍在章节编辑页，继续查找最终「发布」按钮'
        : '  → 已离开章节编辑页，继续判断是否需要最终确认'
    );
  }

  await dumpDiagnostics(editorPage, `after-${isDraft ? 'draft' : 'publish'}`, logger);

  if (successText || redirected) {
    logger.ok(
      `已提交：${chapter.title}（${isDraft ? '保存草稿' : '发布'}，点击顺序：${clicks.join(' → ')}）`
    );
    return {
      ok: true,
      status: isDraft ? 'draft' : 'published',
      verified: true,
      evidence: successText ? `成功提示「${successText}」` : '页面已跳回章节管理页',
      clicks,
    };
  }

  logger.warn(`已点击：${clicks.join(' → ')}，但页面上没出现可识别的成功提示`);
  logger.warn('请到番茄后台确认这一章的状态（可能已发布成功，也可能卡在"发布设置"页等必填项）');
  return {
    ok: true,
    status: isDraft ? 'draft' : 'published',
    verified: false,
    clicks,
  };
}

/* ------------------------- 章节序号 ------------------------- */

/**
 * 从源文件标题里解析出章节序号，如「第17章 星海归途」→ 17。解析不出来返回 0。
 * （实现已挪到 util.js —— progress.js 也要用它，细节见那边的注释）
 */
// parseChapterNoFromTitle 由 util 提供，见文件顶部 require

/**
 * 决定这一章该填什么序号。
 *
 * 优先用**标题里写好的数字**（「第17章 xxx」→ 17）：
 * 那是作者自己排好的，而且不受后台草稿、测试记录之类的东西影响。
 * 标题里没有数字时，才退回"后台最大章节号 + 1"。
 */
function decideChapterNo(cfg, chapter, fallbackNo, logger) {
  if (cfg.novel.preferSourceChapterNo === false) return fallbackNo;

  const fromTitle = parseChapterNoFromTitle(chapter.title);
  if (!fromTitle) return fallbackNo;

  if (fromTitle !== fallbackNo) {
    logger.info(`序号取自标题「第${fromTitle}章」（按后台推算本来是 ${fallbackNo}）`);
  }
  return fromTitle;
}

/* ------------------------- 本次处理多少章 ------------------------- */

/**
 * 本次运行最多处理几章。
 *   --all        → 不限
 *   --limit N    → N
 *   maxPerRun>0  → N（硬上限）
 *   maxPerRun=0  → 不限章数，交给日字数上限去卡（"点一下发满当天额度"就是这个用法）
 *
 * ⚠️ 不能写成 `maxPerRun || 1` —— `0 || 1` 会变成 1，把"不限"悄悄变成"只发一章"。
 */
function resolveRunLimit(cfg, opts) {
  if (opts.all) return Infinity;
  if (opts.limit != null && opts.limit !== '') {
    const n = Number(opts.limit);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const c = Number(cfg.publish.maxPerRun);
  if (c === 0) return Infinity;
  return Number.isFinite(c) && c > 0 ? c : 1;
}

/**
 * 按日字数上限裁剪本次要发的章节。
 *
 * 规则（用户明确要求）：**顺序往后发，下一章放不下就停，不为了凑满而截断某一章。**
 * 比如额度剩 1000 字、下一章 1800 字 → 这一章不发，留到明天再发。
 * （不能挑着发后面的小章节：那样章节顺序就乱了。）
 *
 * @returns {{ picked: object[], chars: number, stopped: boolean, remain: number }}
 */
function applyDailyQuota(cfg, todo, limit, led, logger) {
  const remain = daily.remaining(cfg, led);
  const picked = [];
  let chars = 0;
  let stopped = false;

  for (const c of todo) {
    const n = Number(c.chars) || 0;
    if (chars + n > remain) {
      logger.info(
        `「${c.title}」（${n} 字）放不进今天剩下的 ${remain - chars} 字额度里 → 本次到此为止，明天再发`
      );
      stopped = true;
      break;
    }
    picked.push(c);
    chars += n;
    if (picked.length >= limit) break;
  }

  return { picked, chars, stopped, remain };
}

/** 什么都不打的 logger（试算用） */
const NOOP_LOGGER = { debug() {}, info() {}, warn() {}, ok() {}, fail() {}, step() {} };

/**
 * 算出"现在点一下会发哪几章"。★ 自检（preflight）和本地面板（ui/server）**都调它**。
 *
 * ★★ 为什么要抽出来 —— 这里踩过一次：
 *   面板原来自己拼参数，把 `daily.summary()` 的返回值直接当账本传进了 `applyDailyQuota`。
 *   但 `remaining(cfg, led)` 读的是 `led.chars`，而 summary() 里叫 `used`：
 *   → `Number(limit) - undefined` = NaN → `Math.max(0, NaN)` = NaN
 *   → `chars + n > NaN` 恒为 false → 永不停止 → 面板显示"本次会发 7 章"，
 *     而实际一章都发不了（剩余额度 1755 字，下一章 1780 字）。
 *   一时看不出错，因为算出来的是个"看起来合理"的数字。
 *
 * → 教训：**同一件事只有一处实现时，两边才不会算出两种答案。**
 *
 * @param {object} quota `daily.summary()` 的返回值（只需要其中的 used / chapters）
 */
function planNextRun(cfg, pending, quota, logger) {
  const max = Number(cfg.publish.maxPerRun) > 0 ? Number(cfg.publish.maxPerRun) : Infinity;
  return applyDailyQuota(
    cfg,
    pending,
    max,
    // ★ 必须是"账本形状" { chars, chapters }，不是 summary() 的形状
    { chars: Number(quota && quota.used) || 0, chapters: (quota && quota.chapters) || [] },
    logger || NOOP_LOGGER
  );
}

/* ------------------------- 发布前校验 ------------------------- */
/**
 * 番茄的硬性限制（探到的真实规则）：
 *   直接发布：正文字数 >= 1000，标题 <= 30 字，章节序号必须是阿拉伯数字
 *   存草稿：无字数限制
 * 不满足就跳过，避免白跑一趟还触发风控。
 */
function checkBeforePublish(cfg, chapter, body, logger, { dryRun = false } = {}) {
  const chars = countChars(body);
  const isPublishMode = cfg.publish.mode !== 'draft';
  const minPublishChars = (cfg.safety && cfg.safety.minCharsForPublish) || 1000;
  const maxChars = (cfg.safety && cfg.safety.maxCharsPerChapter) || 30000;

  if (chars > maxChars) {
    logger.warn(`「${chapter.title}」有 ${chars} 字，超过安全上限 ${maxChars} 字，跳过`);
    return false;
  }

  if (isPublishMode && chars < minPublishChars) {
    if (dryRun) {
      // 演练模式放行，让用户能看到完整流程长什么样
      logger.warn(`「${chapter.title}」只有 ${chars} 字，不足发布要求的 ${minPublishChars} 字`);
      logger.warn('  演练模式继续执行，但正式发布会自动跳过这一章');
    } else {
      logger.warn(`「${chapter.title}」只有 ${chars} 字，少于番茄"直接发布"要求的 ${minPublishChars} 字，跳过`);
      logger.warn('  这是番茄的硬性规则，绕不过去 —— 把这一章补到 1000 字以上再发');
      return false;
    }
  }

  const pureTitle = cfg.novel.stripChapterPrefix === false ? chapter.title : stripChapterPrefix(chapter.title);
  if (countChars(pureTitle) > 30) {
    logger.warn(`「${chapter.title}」标题超过番茄要求的 30 字（${countChars(pureTitle)} 字），发布会失败，跳过`);
    return false;
  }

  return true;
}

/* ------------------------- 主入口 ------------------------- */

/**
 * ★ 同一账号多本书：按 config 里的书名，定位到正确的那一本。
 *
 * 定位成功后，用这本书的 bookId 覆盖掉 cfg.site 里写死的地址 ——
 * 这样"发错书"这件事从根上就不可能发生（书名是唯一依据）。
 * ★ 书名填了却定位不到、book.json 里又没写地址时 → **直接中断发布**（抛错），
 *   绝不"自动找入口" —— 那会落到浏览器 session 里最后待过的那本书
 *   （2026-10-06 真实事故：新书发进了账号里的另一本书）。
 *   只有 book.json / config 里写死了地址（用户显式配置）才允许退回。
 */
async function applyResolvedBook(page, cfg, logger) {
  if (cfg.site.autoFindBook === false) {
    logger.info('config.json 的 site.autoFindBook = false —— 不做作品定位，直接用写死的地址');
    return null;
  }

  const r = await resolveBook(page, cfg, logger);
  if (!r) {
    if (cfg.site.createChapterUrl || cfg.site.bookUrl) {
      logger.warn('没能按书名定位作品，退回用 book.json / config 里写死的地址');
    } else {
      // ★★ 书名填了却定位不到 → **必须停**，不能"自动找入口"。
      //   自动找入口落到哪本书全看浏览器 session 的痕迹 —— 2026-10-06 用户的新书
      //   就是这么发进账号里另一本书的。宁可中断这次发布，也不能发错书。
      throw new Error(
        `按书名「${cfg.site.bookName || ''}」定位不到作品，且 book.json 里也没写地址 —— 已停止发布（防止发错书）。` +
          '请跑 node src\\cli.js books 核对后台的准确书名，再原样填进这本书的 book.json'
      );
    }
    return null;
  }

  // 写死的地址如果指向另一本书，明确说出来 ——
  // 免得出现"以为在发 A 书、其实发进了 B 书"这种最难查的问题
  const staticId = String(cfg.site.createChapterUrl || '').match(/\/writer\/(\d+)\/publish/);
  if (staticId && staticId[1] !== r.bookId) {
    logger.warn(
      `⚠️ config.json 里的 createChapterUrl 指向的是另一本书（书籍 ID ${staticId[1]}），` +
        `已按 site.bookName「${cfg.site.bookName}」自动改用 ${r.bookId}`
    );
  }

  cfg.site.bookId = r.bookId;
  cfg.site.bookUrl = r.chapterManageUrl;
  cfg.site.createChapterUrl = r.createChapterUrl;
  return r;
}

async function run(cfg, opts, logger) {
  const manifest = loadManifest();
  if (!manifest || !manifest.chapters || !manifest.chapters.length) {
    throw new Error('还没有可发布的章节，请先运行「拆分章节」');
  }

  let todo = manifest.chapters.slice();
  // ★ 自选章节：--chapter 5 或 --chapter 5,7,9（逗号分隔）。
  //   两种序号都认（标题里的"第几章"优先，目录序号兜底），选完按书序发布。
  let chapterPicked = false;
  if (opts.chapter) {
    const sel = resolveChapterSelection(manifest, String(opts.chapter));
    if (sel.unknown.length) {
      throw new Error(
        `找不到这些章节：${sel.unknown.join('、')}（既不是 chapters/ 目录里的序号，也没有标题写着「第N章」）`
      );
    }
    if (!sel.picked.length) throw new Error(`--chapter 没有选中任何章节：${opts.chapter}`);
    todo = sel.picked;
    chapterPicked = true;
    logger.info(`已锁定你选的 ${todo.length} 章（按书中顺序发布）：${todo.map((c) => c.title).join('、')}`);
  }
  if (cfg.publish.skipPublished && !opts.force) {
    const before = todo.length;
    const renamed = [];
    todo = todo.filter((c) => {
      const m = progress.matchDone(c.title);
      // how === 'number'：标题没匹配上，是靠章节序号兜住的 → 说明标题被改过了
      if (m.done && m.how === 'number') {
        renamed.push(`第${m.no}章 —— 本地标题「${c.title}」，账本里记的是「${m.by}」`);
      }
      return !m.done;
    });
    if (before !== todo.length) logger.info(`已跳过 ${before - todo.length} 个发过的章节`);
    if (renamed.length) {
      logger.warn(`其中 ${renamed.length} 章的标题和账本里不一样，但章节序号发过，按序号跳过了：`);
      renamed.forEach((t) => logger.warn(`  · ${t}`));
      logger.warn('  这是为了防止重发。如果你确实想重发，先跑：node src\\cli.js reset --chapter <序号>');
    }
  }

  // 自选章节却全都发过了 —— 说清楚原因，别让用户以为坏了
  if (chapterPicked && !todo.length && !opts.force) {
    logger.warn('你选的章节都已经发过了。');
    logger.warn('  要重发先清记录：node src\\cli.js reset --chapter <序号>；或者这次加 --force 忽略已发记录。');
    return { published: 0, failed: 0 };
  }

  // ★ 自选章节 = 明确意图，不再受 maxPerRun 卡（他选了几章就该发几章）
  const limit = chapterPicked ? Infinity : resolveRunLimit(cfg, opts);
  // 试运行只是让用户核对"填得对不对"，1 章就够，别让他等 3 章
  const effectiveLimit = opts.dryRun ? 1 : limit;

  // ---- 平台定时发布：--at "08:00" 或 config 的 publish.scheduledAt ----
  // 定到时刻后，章节创建流程照旧（照常过审），只是番茄到点才向读者放出。
  // 优先级：命令行 --at > config.publish.scheduledAt > 不定时（立即发布，旧行为）
  let schedule = null;
  const atSpec = String(opts.at || cfg.publish.scheduledAt || '').trim();
  if (atSpec) {
    const parsed = parseScheduleTime(atSpec);
    if (!parsed.ok) throw new Error('定时时间解析失败：' + parsed.reason);
    schedule = { date: parsed.date, text: parsed.text };
    logger.info(
      `平台定时发布：本次的章节将定到 ${parsed.text} 自动放出（用番茄自带的定时功能，到点前读者看不到）`
    );
    if (opts.dryRun) logger.info('（试运行模式：不会点「确认发布」，定时设置也只是在弹窗里走一遍）');
  }
  opts.schedule = schedule; // 传给 publishOne → handleDialogs → 发布设置弹窗

  // ---- 日字数配额：点一下就把当天的额度发满，但绝不超 ----
  // 账本跨天自动清零，并会自动从发布记录里补出"今天已经发出去的"章节。
  const led = daily.isEnabled(cfg) ? daily.open(manifest, logger) : null;
  // ★ 日额度是**账号级**的（所有书共用 10000 字/天），自选章节也一样受它管 ——
  //   超了平台会拒，与其让用户白跑一趟，不如在这里拦住：放得下的先发，放不下的留到明天。
  //   （旧版本对 --chapter 跳过配额，是"每本各算"时期的产物，2026-10-05 已改。）
  const quotaActive = !!led && cfg.publish.mode !== 'draft';

  if (led) {
    logger.info(
      `今日已发 ${led.chars} / ${cfg.publish.dailyCharLimit} 字，剩余额度 ${Math.max(
        0,
        daily.remaining(cfg, led)
      )} 字`
    );
    if (led.chapters.length) {
      logger.info(`  （今天发过：${led.chapters.map((c) => c.title).join('、')}）`);
    }
    if (chapterPicked && cfg.publish.mode !== 'draft') {
      const remain = Math.max(0, daily.remaining(cfg, led));
      const total = todo.reduce((s, c) => s + (Number(c.chars) || 0), 0);
      if (total > remain) {
        logger.warn(`选中的 ${todo.length} 章共 ${total} 字，今天只剩 ${remain} 字额度（账号级，所有书共用）`);
        logger.warn('  放得下的会先发，放不下的留到明天。想今天就全发：调大 config.json 的 publish.dailyCharLimit');
      } else {
        logger.info(`选中的 ${todo.length} 章共 ${total} 字，当前额度放得下（还剩 ${remain} 字）`);
      }
    }
  }

  if (quotaActive) {
    if (daily.remaining(cfg, led) <= 0) {
      logger.warn('今天的字数额度已经用完了，本次不发。');
      logger.warn(`  想今天就发，可以调大 config.json 的 publish.dailyCharLimit（当前 ${cfg.publish.dailyCharLimit}）`);
      return { published: 0, failed: 0 };
    }
    todo = applyDailyQuota(cfg, todo, effectiveLimit, led, logger).picked;
  } else {
    todo = todo.slice(0, effectiveLimit);
  }

  if (!todo.length) {
    logger.ok('没有需要发布的章节（都发过了，或今天的额度放不下任何一章）');
    return { published: 0, failed: 0 };
  }

  const planChars = todo.reduce((s, c) => s + (Number(c.chars) || 0), 0);
  logger.step(
    `本次计划处理 ${todo.length} 章（共 ${planChars} 字）：${todo.map((c) => c.title).join('、')}`
  );
  // 卷归属提前说清楚，方便用户对照后台
  const planVols = [...new Set(todo.map((c) => c.volume).filter(Boolean))];
  if (planVols.length) {
    for (const v of planVols) {
      logger.info(`   分卷「${v}」：${todo.filter((c) => c.volume === v).map((c) => c.title).join('、')}`);
    }
    if (cfg.novel.fillVolume === false) {
      logger.warn('   （config.json 的 novel.fillVolume = false，发布时不会真的切换分卷）');
    }
  }

  const ctx = await launch(cfg, { logger });
  let ok = 0;
  let failed = 0;
  const unverified = [];
  let maxUsedNo = 0; // 本次实际提交过的最大章节号

  try {
    const page = await getPage(ctx);
    await ensureLoggedIn(page, cfg, logger, { interactive: !opts.unattended });

    // ★ 多书支持：账号下有多本书时，按 site.bookName 定位到正确的那一本
    await applyResolvedBook(page, cfg, logger);

    // ★★ 安全网：这本书本地一条发布记录都没有 → 先查后台是否已有章节。
    //   一本在后台已经发过的书（手动发过/别处发过/换工具），本地记录是空的 ——
    //   不导入就会以为从第 1 章开始，**把已发的章节再发一遍（后台重章）**。
    //   自动导入（best-effort）：拉后台章节 → 按章节号配对 → 标记已发布 → 重算今日额度。
    try {
      const recCount = Object.keys(require('./progress').load().chapters || {}).length;
      if (recCount === 0) {
        logger.info('这本书本地还没有发布记录 —— 先查一下番茄后台是否已有章节（防止从头重发）…');
        const imported = await importPlatformRecords(ctx, cfg, manifest, logger);
        if (imported.plan.toMark.length) {
          // 记录变了 → 之前基于"空记录"算出的 todo 必须按导入结果重新筛
          const doneNos = new Set(imported.plan.toMark.map((x) => x.chapterNo));
          const before = todo.length;
          todo = todo.filter((c) => !doneNos.has(parseChapterNoFromTitle(c.title) || Number(c.seq) || 0));
          logger.ok(
            '已从后台导入 ' +
              imported.plan.toMark.length +
              ' 条发布记录 —— 本次不会重发这些章节，从第 ' +
              (Math.max(...imported.plan.toMark.map((x) => x.chapterNo)) + 1) +
              ' 章继续'
          );
          logger.info('按导入的记录重新核对待发列表：剩 ' + todo.length + ' 章待发（原 ' + before + ' 章）');
        } else if (imported.pf.chapters.length === 0) {
          logger.info('后台还没有这本书的章节 —— 正常，从第 1 章开始发');
        } else {
          logger.warn(
            '后台有 ' +
              imported.pf.chapters.length +
              ' 章但和本地章节都对不上 —— 如果那批内容和本地是同一份，请先跑 node src\\cli.js sync-records 人工核对，避免重章'
          );
        }
      }
    } catch (e) {
      logger.warn('后台记录自动导入没成功（不影响继续，但请留意可能重发）：' + String(e.message).split('\n')[0]);
    }

    // 后台已有章节的推算值（真正用不用得上，取决于标题里有没有写序号）
    let baseNo = 0;
    if (cfg.novel.fillChapterNo !== false) {
      baseNo = await getMaxChapterNo(page, cfg, logger);
    }

    for (let i = 0; i < todo.length; i++) {
      const ch = todo[i];
      const chapterNo = decideChapterNo(cfg, ch, baseNo + i + 1, logger);
      if (chapterNo > maxUsedNo) maxUsedNo = chapterNo;
      try {
        const body = loadChapterBody(ch);

        if (!checkBeforePublish(cfg, ch, body, logger, { dryRun: !!opts.dryRun })) {
          failed++;
          progress.markFailed(ch.title, '发布前校验不通过');
          continue;
        }

        const r = await publishOne(ctx, cfg, ch, body, opts, logger, chapterNo);
        if (r.ok) {
          ok++;
          if (r.status !== 'dry') {
            progress.markPublished(ch.title, {
              status: r.status,
              mode: cfg.publish.mode,
              chapterNo,
              verified: r.verified !== false,
            });
            // 立刻记账：即使这次运行后面崩了，"今天已经发出去多少字"也是准的
            if (led && r.status === 'published') {
              daily.record(led, cfg, ch, chapterNo, logger);
            }
            if (r.verified === false) {
              unverified.push(ch.title);
              logger.warn(`⚠️ 「${ch.title}」没能确认提交结果：点了按钮，但页面上没看到成功提示。`);
              logger.warn('   已记入进度以免重复发布。请去后台确认；确实没发出去的话用 --force 重发。');
            }
          }
        } else {
          failed++;
          progress.markFailed(ch.title, r.reason);
        }
      } catch (e) {
        failed++;
        logger.fail(`第 ${ch.seq} 章「${ch.title}」处理出错：${String(e.message).split('\n')[0]}`);
        progress.markFailed(ch.title, String(e.message).split('\n')[0]);
      }

      if (i < todo.length - 1) {
        const wait = (cfg.publish.intervalSeconds || 10) + randomInt(0, cfg.publish.jitterSeconds || 5);
        logger.info(`等待 ${wait} 秒再继续（模拟人工节奏）...`);
        await sleep(wait * 1000);
      }
    }

    // ---- 独立核对：再读一次后台，用外部事实验证到底有没有发出去 ----
    // 这一层是为了兜住"页面文案误判"这种情况：页面可能骗人，后台的章节数不会。
    if (!opts.dryRun && ok > 0 && cfg.novel.fillChapterNo !== false && baseNo > 0) {
      try {
        const after = await getMaxChapterNo(page, cfg, logger);
        const before = Math.max(baseNo, maxUsedNo > 0 ? maxUsedNo - 1 : 0);
        if (after > before) {
          logger.ok(`后台核对通过：最多章节号已从 ${before} 变为 ${after}，发布确实生效了`);
        } else {
          logger.warn(`后台核对未通过：最多章节号仍是 ${after}（发之前是 ${before}）`);
          logger.warn('  可能原因：进了审核队列还没显示 / 内容检测没过 / 弹窗没点掉导致没提交');
          logger.warn('  建议去后台章节列表确认一眼；确实没发出去就用 --force 重发');
        }
      } catch (e) {
        logger.warn('后台核对失败（不影响本次结果）：' + String(e.message).split('\n')[0]);
      }
    }
  } finally {
    await ctx.close().catch(() => {});
    logger.info('浏览器已关闭');
  }

  logger.step(`本次完成：成功 ${ok} 章，失败 ${failed} 章`);

  // 收尾时把"今天的额度"再报一次，方便用户判断要不要再点一次
  if (led && cfg.publish.mode !== 'draft') {
    const limit = Number(cfg.publish.dailyCharLimit);
    const left = Math.max(0, limit - led.chars);
    if (left > 0) {
      const next = (loadManifest().chapters || []).find((c) => !progress.isDone(c.title));
      const nextTxt = next ? `下一章「${next.title}」${next.chars} 字，` : '';
      logger.info(`今日额度还剩 ${left} 字（${led.chars} / ${limit}）。${nextTxt}放得下就可以再点一次`);
    } else {
      logger.ok(`今天的 ${limit} 字额度已经发满了，明天再点（账本：data/daily.json）`);
    }
  }

  if (unverified.length) {
    logger.warn(`其中有 ${unverified.length} 章没能确认结果（${unverified.join('、')}）—— 建议去后台看一眼`);
  }
  return { published: ok, failed, unverified };
}

module.exports = {
  run,
  ensureLoggedIn,
  isLoggedIn,
  dumpDiagnostics,
  parseChapterNoFromTitle,
  cnNumToInt,
  decideChapterNo,
  detectSuccessText,
  handleDialogs,
  resolveRunLimit,
  applyDailyQuota,
  planNextRun,
  applyVolume,
  readCurrentVolume,
  readVolumeOptions,
  applyResolvedBook,
  enterNewChapter,
  applyScheduleInDialog,
  importPlatformRecords,
};
