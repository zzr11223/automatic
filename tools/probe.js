/**
 * 页面结构探查脚本（开发调试用，不是日常使用的一部分）
 * 用法: node tools/probe.js [url]
 * 结果写入 logs/probe.json 和 logs/probe.png
 */
const fs = require('fs');
const path = require('path');
const { openBrowser } = require('./_shared');

const ROOT = path.resolve(__dirname, '..');

(async () => {
  const url = process.argv[2] || 'https://fanqienovel.com/main/writer/book-manage';
  const outDir = path.join(ROOT, 'logs');
  fs.mkdirSync(outDir, { recursive: true });

  const { ctx, cfg, logger } = await openBrowser('probe', { userDataDir: 'userdata-probe' });

  const page = ctx.pages()[0] || (await ctx.newPage());
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    console.log('goto warning:', e.message);
  }
  await page.waitForTimeout(6000);
  try {
    await page.waitForLoadState('networkidle', { timeout: 15000 });
  } catch (e) {
    console.log('networkidle timeout (ok)');
  }

  const title = await page.title();
  console.log('FINAL_URL: ' + page.url());
  console.log('TITLE: ' + title);

  const info = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const desc = (el) => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        placeholder: el.placeholder || '',
        name: el.name || '',
        id: el.id || '',
        cls: String(el.className || '').slice(0, 120),
        text: (el.innerText || '').trim().slice(0, 60).replace(/\s+/g, ' '),
        editable: el.isContentEditable,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      };
    };
    return {
      inputs: [...document.querySelectorAll('input,textarea')].filter(vis).map(desc),
      editables: [...document.querySelectorAll('[contenteditable="true"]')].filter(vis).map(desc),
      clickable: [...document.querySelectorAll('button,a,[role="button"]')]
        .filter(vis)
        .map(desc)
        .filter((d) => d.text)
        .slice(0, 80),
      bodyText: (document.body.innerText || '').slice(0, 4000),
    };
  });

  const payload = { url: page.url(), title, ...info };
  fs.writeFileSync(path.join(outDir, 'probe.json'), JSON.stringify(payload, null, 2), 'utf8');

  console.log('\n===== INPUTS / TEXTAREAS =====');
  console.log(JSON.stringify(info.inputs, null, 1));
  console.log('\n===== CONTENTEDITABLE =====');
  console.log(JSON.stringify(info.editables, null, 1));
  console.log('\n===== CLICKABLE (text) =====');
  console.log(JSON.stringify(info.clickable, null, 1));
  console.log('\n===== BODY TEXT =====');
  console.log(info.bodyText.slice(0, 2000));

  await page.screenshot({ path: path.join(outDir, 'probe.png') }).catch(() => {});

  await ctx.close();
  process.exit(0);
})().catch(async (e) => {
  console.error('PROBE FAILED:', e.message);
  process.exit(1);
});
