/**
 * 探查章节编辑页结构（只读！不填任何内容、不点任何提交按钮）
 * 用法: node tools/probe-editor.js <url>
 */
const fs = require('fs');
const path = require('path');
const { openBrowser, currentBook, createChapterUrl } = require('./_shared');

const ROOT = path.resolve(__dirname, '..');

(async () => {
  // ★ 不写死地址：默认用「当前那本」book.json 里记的创建章节页（见 _shared.js 里的说明）
  const url = process.argv[2] || createChapterUrl(currentBook());
  const { ctx, cfg, logger } = await openBrowser('probe-editor');

  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

  for (let i = 0; i < 15; i++) {
    const len = await page.evaluate(() => (document.body ? document.body.innerText.length : 0)).catch(() => 0);
    if (len > 50) break;
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(6000);

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
        ph: el.placeholder || '',
        name: el.name || '',
        cls: String(el.className || '').slice(0, 100),
        text: String(el.innerText || el.value || '').trim().slice(0, 40).replace(/\s+/g, ' '),
        visible: vis(el),
        editable: el.isContentEditable,
        area: Math.round(r.width) * Math.round(r.height),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      };
    };
    return {
      url: location.href,
      title: document.title,
      allInputs: [...document.querySelectorAll('input,textarea,[contenteditable="true"]')].map(d),
      clickable: [...document.querySelectorAll('button,a,[role="button"]')]
        .filter(vis)
        .map(d)
        .filter((x) => x.text)
        .slice(0, 60),
      iframes: [...document.querySelectorAll('iframe')].map((f) => ({ src: f.src, w: f.getBoundingClientRect().width })),
      bodyText: (document.body.innerText || '').slice(0, 3000),
    };
  });

  console.log('URL: ' + info.url);
  console.log('TITLE: ' + info.title);
  console.log('\n========== 正文 ==========');
  console.log(info.bodyText);
  console.log('\n========== 所有输入框 / 可编辑区 ==========');
  console.log(JSON.stringify(info.allInputs, null, 1));
  console.log('\n========== 可点击元素 ==========');
  console.log(JSON.stringify(info.clickable, null, 1));
  console.log('\n========== iframe ==========');
  console.log(JSON.stringify(info.iframes, null, 1));

  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'logs', 'editor-page.json'), JSON.stringify(info, null, 2), 'utf8');
  await page.screenshot({ path: path.join(ROOT, 'logs', 'editor-page.png') }).catch(() => {});

  await ctx.close();
  process.exit(0);
})().catch((e) => {
  console.error('探查失败: ' + e.message);
  process.exit(1);
});
