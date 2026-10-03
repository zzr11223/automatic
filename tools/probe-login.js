/**
 * 对照实验：
 *   A. 点「扫码登录」标签 —— 用来验证"点击方式本身有没有效"
 *   B. 点「密码登录」按钮 —— 用真实鼠标点击
 * 如果 A 有效而 B 无效，说明番茄确实关掉了密码登录。
 */
const path = require('path');
const { openBrowser } = require('./_shared');

const ROOT = path.resolve(__dirname, '..');

async function probe(page, tag) {
  const info = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    return {
      url: location.href,
      inputs: [...document.querySelectorAll('input')]
        .filter(vis)
        .map((e) => `${e.type}:${e.placeholder || e.name || '-'}`),
      hasCanvas: [...document.querySelectorAll('canvas')].filter(vis).length,
      hasImg: [...document.querySelectorAll('img')].filter(vis).length,
      bodyText: (document.body.innerText || '').replace(/\n+/g, ' | ').slice(0, 400),
    };
  });
  console.log(`\n----- ${tag} -----`);
  console.log('URL: ' + info.url);
  console.log('可见输入框: ' + JSON.stringify(info.inputs));
  console.log('canvas 数: ' + info.hasCanvas + ' | img 数: ' + info.hasImg);
  console.log('正文: ' + info.bodyText);
  return info;
}

(async () => {
  const { ctx, cfg, logger } = await openBrowser('probe-login', { userDataDir: 'userdata-probe' });

  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://fanqienovel.com/main/writer/login', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 12; i++) {
    const len = await page.evaluate(() => (document.body ? document.body.innerText.length : 0)).catch(() => 0);
    if (len > 50) break;
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(2000);

  await probe(page, '初始状态');

  // ---- 对照 A：点「扫码登录」标签（真实鼠标点击）----
  console.log('\n>>> [A] 真实点击「扫码登录」标签');
  try {
    const tab = page.locator('div.slogin-pc-form-header__title__tab', { hasText: '扫码登录' }).first();
    await tab.click({ timeout: 8000 });
    await page.waitForTimeout(4000);
    await probe(page, 'A: 点扫码登录之后');
  } catch (e) {
    console.log('点扫码登录失败: ' + e.message.split('\n')[0]);
  }

  // ---- 切回验证码 ----
  try {
    const tab2 = page.locator('div.slogin-pc-form-header__title__tab', { hasText: '验证码登录' }).first();
    await tab2.click({ timeout: 8000 });
    await page.waitForTimeout(2500);
  } catch (_) {}

  // ---- 对照 B：点「密码登录」按钮（真实鼠标点击）----
  console.log('\n>>> [B] 真实点击「密码登录」按钮');
  const pagesBefore = ctx.pages().length;
  try {
    const btn = page.locator('button', { hasText: '密码登录' }).first();
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click({ timeout: 8000 });
    console.log('点击已执行');
  } catch (e) {
    console.log('点密码登录失败: ' + e.message.split('\n')[0]);
  }
  await page.waitForTimeout(6000);
  console.log('标签页数量变化: ' + pagesBefore + ' -> ' + ctx.pages().length);
  if (ctx.pages().length > pagesBefore) {
    const np = ctx.pages()[ctx.pages().length - 1];
    await np.bringToFront().catch(() => {});
    console.log('新页面 URL: ' + np.url());
    await probe(np, 'B 新开的页面');
  } else {
    await probe(page, 'B: 点密码登录之后');
  }

  await ctx.close();
  process.exit(0);
})().catch((e) => {
  console.error('探查失败: ' + e.message);
  process.exit(1);
});
