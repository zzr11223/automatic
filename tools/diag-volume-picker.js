/**
 * 分卷下拉 —— 精细诊断
 *
 * 上一轮实测发现：点了一个卷之后顶栏没变。也就是说"点了个没反应"。
 * 这个脚本把下拉的真实 DOM 和几种点击方式都试一遍，
 * 找出到底是"没点中"还是"点了但平台不认"。
 *
 * ★ 只做选择，不填内容、不提交。
 * ★ 卷名不写死：从下拉候选里现取。想指定就用环境变量 VOL_A=「第二卷：某某」。
 */
const path = require('path');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/util');
const { readVolumeOptions } = require('../src/publisher');
const { openBrowser, currentBook, createChapterUrl } = require('./_shared');

const ROOT = path.resolve(__dirname, '..');
// ★ 地址从「当前那本」的 books\<书名>\book.json 来，不写死（见 _shared.js 里的说明）
const CREATE = createChapterUrl(currentBook());
let VOL_A = process.env.VOL_A || '';

(async () => {
  const cfg = loadConfig();
  const logger = createLogger('volume-diag');

  const { ctx } = await openBrowser('diag-volume-picker', { cfg, logger });
  const page = ctx.pages()[0] || (await ctx.newPage());

  // 记录所有跟 volume 有关的请求（看"选了卷"到底有没有发请求给后端）
  const reqs = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/volume|serial|chapter/i.test(u)) reqs.push(`${r.method()} ${u.slice(0, 160)}`);
  });

  const readHeader = async () => {
    const el = page.locator('.publish-header-volume-name').first();
    if ((await el.count().catch(() => 0)) === 0) return '(读不到)';
    return String((await el.innerText().catch(() => '')) || '').trim();
  };

  const dumpDropdown = () =>
    page.evaluate(() => {
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      const all = [...document.querySelectorAll('[class*="editor-volume"]')].filter(vis);
      const containers = [
        ...document.querySelectorAll('[class*="volume-list"],[class*="volume-select"],[class*="dropdown"],[class*="popup"],[class*="popover"]'),
      ].filter((el) => vis(el) && /卷/.test(el.innerText || ''));

      return {
        editorVolumeNodes: all.map((el) => {
          const r = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            cls: String(el.className || '').slice(0, 120),
            text: String(el.innerText || '').trim().slice(0, 40),
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            childCount: el.children.length,
            html: String(el.outerHTML || '').slice(0, 700),
          };
        }),
        containers: containers.map((el) => ({
          tag: el.tagName.toLowerCase(),
          cls: String(el.className || '').slice(0, 120),
          html: String(el.outerHTML || '').slice(0, 2500),
        })),
      };
    });

  const openDropdown = async () => {
    const wrap = page.locator('.publish-header-volume-wrap').first();
    await wrap.click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2500);
  };

  try {
    console.log('=== 打开创建章节页 ===');
    await page.goto(CREATE, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    for (let i = 0; i < 25; i++) {
      if ((await page.locator('[contenteditable="true"]').count().catch(() => 0)) > 0) break;
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(2500);
    console.log('顶栏初始卷：「' + (await readHeader()) + '」');

    console.log('\n=== 点开下拉，看真实 DOM ===');
    reqs.length = 0;
    await openDropdown();
    const d = await dumpDropdown();
    console.log(`匹配 [class*="editor-volume"] 的可见节点（${d.editorVolumeNodes.length} 个）：`);
    d.editorVolumeNodes.forEach((n, i) => {
      console.log(`  [${i}] ${n.tag} | ${n.cls}`);
      console.log(`      文本「${n.text}」 位置=${JSON.stringify(n.rect)} 子元素=${n.childCount}`);
      console.log(`      HTML: ${n.html}`);
    });
    console.log(`\n外层容器（${d.containers.length} 个）：`);
    d.containers.forEach((c, i) => {
      console.log(`  [${i}] ${c.tag} | ${c.cls}`);
      console.log(`      ${c.html}`);
    });
    await page.screenshot({ path: path.join(ROOT, 'logs', 'voldiag-open.png') }).catch(() => {});

    /* ★ 卷名不写死：从下拉候选里现取一个来试 */
    if (!VOL_A) {
      const opts = (await readVolumeOptions(page).catch(() => []))
        .map((s) => String(s).trim())
        .filter(Boolean);
      VOL_A = opts[1] || opts[0] || '';
      console.log(`\n  （卷名从下拉里现取：候选 ${JSON.stringify(opts)} → 本次试「${VOL_A}」）`);
      if (!VOL_A) {
        console.log('❌ 下拉里读不到任何卷，无法继续。先在后台建好分卷。');
        await ctx.close().catch(() => {});
        process.exit(1);
      }
    }

    /* ---------- 策略 1：locator.click() ---------- */
    console.log('\n=== 策略1：Playwright locator.click() 点最内层 span ===');
    const inner = page.locator('[class*="editor-volume-list-item"]').filter({ hasText: VOL_A });
    console.log(`  匹配数量：${await inner.count().catch(() => 0)}`);
    if ((await inner.count().catch(() => 0)) > 0) {
      const target = inner.last(); // 取最靠后的 = 最内层
      const box = await target.boundingBox().catch(() => null);
      console.log(`  目标位置：${JSON.stringify(box)}`);
      await target.click({ timeout: 8000 }).catch((e) => console.log('  点击异常: ' + e.message.split('\n')[0]));
      await page.waitForTimeout(3500);
      console.log(`  顶栏现在是：「${await readHeader()}」`);
    }

    /* ---------- 策略 2：重新点开 + 真鼠标 down/up ---------- */
    if ((await readHeader()) !== VOL_A) {
      console.log('\n=== 策略2：重新点开下拉 → 先 mouse.move 过去，再分步 down/up ===');
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(1200);
      await openDropdown();

      const box2 = await page
        .locator('[class*="editor-volume-list-item"]')
        .filter({ hasText: VOL_A })
        .last()
        .boundingBox()
        .catch(() => null);
      if (box2) {
        const cx = box2.x + box2.width / 2;
        const cy = box2.y + box2.height / 2;
        console.log(`  坐标：(${Math.round(cx)}, ${Math.round(cy)})`);
        await page.mouse.move(cx, cy);
        await page.waitForTimeout(400);
        await page.mouse.down();
        await page.waitForTimeout(120);
        await page.mouse.up();
        await page.waitForTimeout(3500);
        console.log(`  顶栏现在是：「${await readHeader()}」`);
      } else {
        console.log('  !! 拿不到坐标');
      }
    }

    /* ---------- 策略 3：键盘 ---------- */
    if ((await readHeader()) !== VOL_A) {
      console.log('\n=== 策略3：键盘（点开 → 方向键 → 回车）===');
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(1200);
      await openDropdown();
      for (const k of ['ArrowDown', 'ArrowUp', 'Enter']) {
        await page.keyboard.press(k).catch(() => {});
        await page.waitForTimeout(900);
      }
      await page.waitForTimeout(3000);
      console.log(`  顶栏现在是：「${await readHeader()}」`);
    }

    console.log('\n=== 期间发生的相关请求 ===');
    [...new Set(reqs)].slice(0, 40).forEach((r) => console.log('  ' + r));
    if (!reqs.length) console.log('  （没有任何 volume/chapter 相关请求）');

    await page.screenshot({ path: path.join(ROOT, 'logs', 'voldiag-end.png') }).catch(() => {});
  } finally {
    await ctx.close().catch(() => {});
  }
  process.exit(0);
})().catch((e) => {
  console.error('诊断失败: ' + e.message);
  process.exit(1);
});
