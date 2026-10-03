/**
 * 探查登录后的作家后台结构（只读，不点任何危险操作）
 */
const fs = require('fs');
const path = require('path');
const { openBrowser } = require('./_shared');

const ROOT = path.resolve(__dirname, '..');

(async () => {
  const { ctx, cfg, logger } = await openBrowser('probe-writer');

  const page = ctx.pages()[0] || (await ctx.newPage());
  await page
    .goto('https://fanqienovel.com/main/writer/book-manage', { waitUntil: 'domcontentloaded', timeout: 60000 })
    .catch(() => {});

  for (let i = 0; i < 15; i++) {
    const len = await page.evaluate(() => (document.body ? document.body.innerText.length : 0)).catch(() => 0);
    if (len > 50) break;
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(3500);

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
        text: String(el.innerText || '').trim().slice(0, 40).replace(/\s+/g, ' '),
        cls: String(el.className || '').slice(0, 90),
        href: el.href || '',
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      };
    };
    return {
      url: location.href,
      clickable: [...document.querySelectorAll('button,a,[role="button"]')]
        .filter(vis)
        .map(d)
        .filter((x) => x.text)
        .slice(0, 90),
      inputs: [...document.querySelectorAll('input,textarea')].filter(vis).map(d),
      bodyText: (document.body.innerText || '').slice(0, 4000),
    };
  });

  console.log('URL: ' + info.url);
  console.log('\n========== 页面正文 ==========');
  console.log(info.bodyText);
  console.log('\n========== 可点击元素 ==========');
  console.log(JSON.stringify(info.clickable, null, 1));
  console.log('\n========== 输入框 ==========');
  console.log(JSON.stringify(info.inputs, null, 1));

  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'logs', 'writer-home.json'), JSON.stringify(info, null, 2), 'utf8');
  await page.screenshot({ path: path.join(ROOT, 'logs', 'writer-home.png') }).catch(() => {});

  await ctx.close();
  process.exit(0);
})().catch((e) => {
  console.error('探查失败: ' + e.message);
  process.exit(1);
});
