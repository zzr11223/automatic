/**
 * 清理草稿箱里"探查过程留下的垃圾草稿"。
 *
 * 只删这两条（2026-10-03 由分卷机制探查产生，0 字、纯垃圾）：
 *   · 「未命名草稿」
 *   · 「第99章 【测试】分卷探查请忽略…」
 *
 * ★ 严格白名单匹配 —— 名字里不含这两个关键词的草稿一律不碰。
 *   （用户手动建过的草稿、试运行留下的有内容草稿，都不在白名单里，不会被误删。）
 *
 * 用法：node tools/clean-junk-drafts.js         先只看，不删
 *       node tools/clean-junk-drafts.js --yes   真的删
 */
const path = require('path');
const { openBrowser, currentBook, chapterManageUrl } = require('./_shared');

const ROOT = path.resolve(__dirname, '..');
// ★ 地址从「当前那本」的 books\<书名>\book.json 来，不写死（见 _shared.js 里的说明）
const MANAGE = chapterManageUrl(currentBook());

/** ★ 白名单：只有名字命中这两个片段的草稿才允许删 */
const WHITELIST = ['未命名草稿', '【测试】分卷探查请忽略', '定时功能诊断（不会发布', '定时验证（不会发布'];

const DO_IT = process.argv.includes('--yes');

const log = (...a) => console.log(...a);

(async () => {
  const { ctx, cfg, logger } = await openBrowser('clean-junk-drafts');
  const page = ctx.pages()[0] || (await ctx.newPage());

  /** 读草稿箱里的所有草稿（名称 + 行序号） */
  const listDrafts = () =>
    page.evaluate(() => {
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      // 草稿区的行：含"名称/字数/修改时间/操作"表头的表格
      const tables = [...document.querySelectorAll('table')].filter(vis);
      const draftTable = tables.find((t) => /修改时间/.test(t.innerText || ''));
      if (!draftTable) return { found: false, rows: [] };

      const rows = [...draftTable.querySelectorAll('tbody tr')]
        .filter(vis)
        .map((tr, i) => {
          const tds = [...tr.querySelectorAll('td')];
          return {
            index: i,
            name: tds[0] ? String(tds[0].innerText || '').trim() : '',
            chars: tds[1] ? String(tds[1].innerText || '').trim() : '',
            time: tds[2] ? String(tds[2].innerText || '').trim() : '',
            // 操作列里的可点元素
            ops: tds[3]
              ? [...tds[3].querySelectorAll('button,a,i,span,div')]
                  .filter(vis)
                  .map((e) => ({
                    tag: e.tagName.toLowerCase(),
                    cls: String(e.className || '').slice(0, 70),
                    text: String(e.innerText || '').trim().slice(0, 10),
                  }))
              : [],
          };
        });
      return { found: true, rows };
    });

  try {
    log('=== 打开章节管理页 → 草稿箱 ===');
    await page.goto(MANAGE, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(8000);

    const tab = page.locator('text=草稿箱').first();
    if ((await tab.count().catch(() => 0)) === 0) throw new Error('找不到「草稿箱」标签');
    await tab.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(7000);

    const before = await listDrafts();
    if (!before.found) throw new Error('没找到草稿箱的表格');

    log(`\n草稿箱现有 ${before.rows.length} 条：`);
    for (const r of before.rows) {
      const hit = WHITELIST.some((w) => r.name.includes(w));
      log(`  [${r.index}] ${hit ? '★待删' : '  保留'}  「${r.name.slice(0, 50)}」 ${r.chars} 字  ${r.time}`);
      log(`        操作列元素：${JSON.stringify(r.ops)}`);
    }

    const targets = before.rows.filter((r) => WHITELIST.some((w) => r.name.includes(w)));
    log(`\n命中白名单 ${targets.length} 条。`);
    if (!targets.length) {
      log('没有需要清理的，结束。');
      await ctx.close();
      return process.exit(0);
    }
    if (!DO_IT) {
      log('\n（这是预演。确认无误后加 --yes 真删）');
      await ctx.close();
      return process.exit(0);
    }

    /* ---------- 逐条删除 ---------- */
    for (const t of targets) {
      log(`\n--- 删除「${t.name.slice(0, 40)}」 ---`);
      // 每次重新定位（删完行会重排），按名字找行
      const row = page
        .locator('table tr')
        .filter({ hasText: t.name.slice(0, 30) })
        .first();
      if ((await row.count().catch(() => 0)) === 0) {
        log('  !! 找不到这一行，跳过');
        continue;
      }
      // 操作列的最后一个可点元素通常就是删除
      const opCells = row.locator('td').last();
      const clickables = opCells.locator('i,button,span,a,div');
      const n = await clickables.count().catch(() => 0);
      log(`  操作列有 ${n} 个可点元素`);
      let clicked = false;
      // 从后往前点（删除一般在最右）
      for (let i = n - 1; i >= 0; i--) {
        const el = clickables.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        await el.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(2000);
        // 看有没有弹出确认框
        const dlg = page.locator('.arco-modal, [role="dialog"], .byte-modal').filter({ hasText: /删除|确定/ });
        if ((await dlg.count().catch(() => 0)) > 0 && (await dlg.first().isVisible().catch(() => false))) {
          const okBtn = dlg
            .first()
            .locator('button')
            .filter({ hasText: /^\s*(确定|确认|删除)\s*$/ })
            .first();
          if ((await okBtn.count().catch(() => 0)) > 0) {
            await okBtn.click({ timeout: 6000 }).catch(() => {});
            log('  已点确认');
            await page.waitForTimeout(3500);
            clicked = true;
            break;
          }
        }
      }
      if (!clicked) log('  !! 没能完成删除（没找到删除入口或确认按钮）');
    }

    /* ---------- 复查 ---------- */
    log('\n=== 复查 ===');
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(8000);
    const tab2 = page.locator('text=草稿箱').first();
    await tab2.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(7000);

    const after = await listDrafts();
    log(`草稿箱现在 ${after.rows.length} 条：`);
    for (const r of after.rows) log(`  · 「${r.name.slice(0, 50)}」 ${r.chars} 字  ${r.time}`);

    const left = after.rows.filter((r) => WHITELIST.some((w) => r.name.includes(w)));
    log(left.length ? `\n⚠️ 还剩 ${left.length} 条没删掉` : '\n✅ 目标草稿已清理干净');
    await page.screenshot({ path: path.join(ROOT, 'logs', 'draft-cleanup-after.png') }).catch(() => {});
  } finally {
    await ctx.close().catch(() => {});
  }
  process.exit(0);
})().catch((e) => {
  console.error('执行失败: ' + e.message);
  process.exit(1);
});
