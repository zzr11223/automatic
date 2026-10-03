/**
 * 探查「下一步」之后的发布设置页结构
 * 安全约束：填测试内容 -> 点"下一步" -> 只 dump 结构 -> 立即关闭
 *          全程不点击任何"发布/确认"类按钮
 */
const fs = require('fs');
const path = require('path');
const { openBrowser, currentBook, createChapterUrl } = require('./_shared');

const ROOT = path.resolve(__dirname, '..');
// ★ 地址从「当前那本」的 books\<书名>\book.json 来，不写死（见 _shared.js 里的说明）
const CREATE_URL = createChapterUrl(currentBook());

(async () => {
  const { ctx, cfg, logger } = await openBrowser('probe-publish-flow');

  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(CREATE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

  for (let i = 0; i < 20; i++) {
    const n = await page.locator('[contenteditable="true"]').count().catch(() => 0);
    if (n > 0) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(3500);
  console.log('编辑页 URL: ' + page.url());

  // 填测试标题
  const title = page.locator('input[placeholder="请输入标题"]').first();
  if ((await title.count()) > 0) {
    await title.fill('【测试】流程探查请忽略');
    console.log('已填测试标题');
  }
  await page.waitForTimeout(600);

  // 填测试正文
  const editor = page.locator('div.ProseMirror').first();
  if ((await editor.count()) > 0) {
    await editor.click();
    await page.keyboard.insertText('这是用于探查发布流程的测试正文，请忽略。');
    console.log('已填测试正文');
  }
  await page.waitForTimeout(1200);

  // 点"下一步"
  const next = page.locator('button', { hasText: '下一步' }).first();
  const n = await next.count();
  console.log('「下一步」按钮数量: ' + n);
  if (n > 0) {
    await next.click({ timeout: 10000 }).catch((e) => console.log('点击失败: ' + e.message.split('\n')[0]));
    console.log('已点击「下一步」');
  }
  await page.waitForTimeout(7000);

  const dump = async (p, tag) => {
    const info = await p.evaluate(() => {
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      const d = (el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        ph: el.placeholder || '',
        cls: String(el.className || '').slice(0, 90),
        text: String(el.innerText || el.value || '').trim().slice(0, 40).replace(/\s+/g, ' '),
      });
      return {
        url: location.href,
        inputs: [...document.querySelectorAll('input,textarea,[contenteditable="true"]')].filter(vis).map(d),
        clickable: [...document.querySelectorAll('button,a,[role="button"]')].filter(vis).map(d).filter((x) => x.text).slice(0, 50),
        bodyText: (document.body.innerText || '').slice(0, 2500),
      };
    });
    console.log('\n########## ' + tag + ' ##########');
    console.log('URL: ' + info.url);
    console.log('--- 正文 ---');
    console.log(info.bodyText);
    console.log('--- 可点击 ---');
    console.log(JSON.stringify(info.clickable, null, 1));
    fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'logs', `publish-flow-${tag}.json`), JSON.stringify(info, null, 2), 'utf8');
    await p.screenshot({ path: path.join(ROOT, 'logs', `publish-flow-${tag}.png`) }).catch(() => {});
    return info;
  };

  if (ctx.pages().length > 1) {
    const np = ctx.pages()[ctx.pages().length - 1];
    await np.bringToFront().catch(() => {});
    await np.waitForTimeout(2500);
    await dump(np, 'new-page');
  } else {
    await dump(page, 'same-page');
  }

  console.log('\n>>> 探查结束，未点击任何发布/确认按钮。');
  await ctx.close();
  process.exit(0);
})().catch((e) => {
  console.error('探查失败: ' + e.message);
  process.exit(1);
});
