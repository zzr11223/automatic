/**
 * 实测自动登录
 */
const path = require('path');
const { loadConfig } = require('../src/config');
const { createLogger, ROOT } = require('../src/util');
const { launch, getPage } = require('../src/browser');
const { autoLogin, isLoggedIn } = require('../src/login');

(async () => {
  const cfg = loadConfig();
  const logger = createLogger();
  console.log('=== 自动登录实测 ===');

  const ctx = await launch(cfg, { logger });
  let ok = false;
  try {
    const page = await getPage(ctx);
    const r = await autoLogin(page, cfg, logger, { timeoutSeconds: 40 });

    console.log('\n=== 结果 ===');
    console.log('ok:', r.ok, r.reason ? '| reason: ' + r.reason : '');
    console.log('最终 URL:', page.url());
    console.log('isLoggedIn:', await isLoggedIn(page));

    await page.screenshot({ path: path.join(ROOT, 'logs', 'login-result.png') }).catch(() => {});
    ok = r.ok;

    if (!r.ok) {
      console.log('\n未登录成功，浏览器保持打开 60 秒供观察...');
      console.log('页面提示：' + String(r.body || '').replace(/\s+/g, ' ').slice(0, 300));
      await page.waitForTimeout(60000);
    }
  } finally {
    await ctx.close().catch(() => {});
  }
  console.log(ok ? '\n[SUCCESS] 登录成功，登录状态已保存' : '\n[FAILED] 登录未成功');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('实测失败:', e.message);
  process.exit(1);
});
