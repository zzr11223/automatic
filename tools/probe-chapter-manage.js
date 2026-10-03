/**
 * 探查章节管理页：拿到现有章节列表 + 结构（只读）
 */
const fs = require('fs');
const path = require('path');
const { openBrowser, currentBook, chapterManageUrl } = require('./_shared');

const ROOT = path.resolve(__dirname, '..');
// ★ 地址从「当前那本」的 books\<书名>\book.json 来，不写死（见 _shared.js 里的说明）
const URL = chapterManageUrl(currentBook());

(async () => {
  const { ctx, cfg, logger } = await openBrowser('probe-chapter-manage');

  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

  for (let i = 0; i < 15; i++) {
    const len = await page.evaluate(() => (document.body ? document.body.innerText.length : 0)).catch(() => 0);
    if (len > 200) break;
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(5000);

  const info = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const rows = [...document.querySelectorAll('[class*="chapter" i], [class*="row" i], li, tr')]
      .filter(vis)
      .map((el) => String(el.innerText || '').replace(/\s+/g, ' ').trim())
      .filter((t) => t && t.length < 120);
    const uniq = [...new Set(rows)].slice(0, 80);
    return {
      url: location.href,
      bodyText: (document.body.innerText || '').slice(0, 4000),
      candidateRows: uniq,
      clickable: [...document.querySelectorAll('button,a,[role="button"]')]
        .filter(vis)
        .map((el) => String(el.innerText || '').trim().slice(0, 30).replace(/\s+/g, ' '))
        .filter(Boolean)
        .slice(0, 60),
    };
  });

  console.log('URL: ' + info.url);
  console.log('\n========== 正文 ==========');
  console.log(info.bodyText);
  console.log('\n========== 候选行 ==========');
  console.log(JSON.stringify(info.candidateRows, null, 1));
  console.log('\n========== 可点击 ==========');
  console.log(JSON.stringify(info.clickable, null, 1));

  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'logs', 'chapter-manage.json'), JSON.stringify(info, null, 2), 'utf8');
  await page.screenshot({ path: path.join(ROOT, 'logs', 'chapter-manage.png') }).catch(() => {});

  await ctx.close();
  process.exit(0);
})().catch((e) => {
  console.error('探查失败: ' + e.message);
  process.exit(1);
});
