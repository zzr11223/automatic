/**
 * 检查草稿箱里有哪些内容（只读）
 */
const path = require('path');
const { openBrowser, currentBook, chapterManageUrl } = require('./_shared');

const ROOT = path.resolve(__dirname, '..');
// ★ 地址从「当前那本」的 books\<书名>\book.json 来，不写死（见 _shared.js 里的说明）
const URL = chapterManageUrl(currentBook());

(async () => {
  const { ctx, cfg, logger } = await openBrowser('check-drafts');

  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 15; i++) {
    const len = await page.evaluate(() => (document.body ? document.body.innerText.length : 0)).catch(() => 0);
    if (len > 200) break;
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(5000);

  try {
    const t = page.getByText('草稿箱', { exact: true }).first();
    if ((await t.count()) > 0) {
      await t.click({ timeout: 8000 });
      await page.waitForTimeout(5000);
      console.log('已切到「草稿箱」');
    } else {
      console.log('没找到「草稿箱」入口');
    }
  } catch (e) {
    console.log('切换草稿箱失败: ' + e.message.split('\n')[0]);
  }

  const txt = await page.evaluate(() => document.body.innerText || '');
  const idx = txt.indexOf('草稿箱');
  console.log('\n--- 草稿箱区域文本 ---');
  console.log(txt.slice(idx >= 0 ? idx : 0, (idx >= 0 ? idx : 0) + 1500));

  await page.screenshot({ path: path.join(ROOT, 'logs', 'draft-box.png') }).catch(() => {});
  await ctx.close();
  process.exit(0);
})().catch((e) => {
  console.error('失败: ' + e.message);
  process.exit(1);
});
