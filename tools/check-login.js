/**
 * 自检：浏览器能否启动 + 登录状态检测是否工作
 * 用法: node tools/check-login.js
 */
const path = require('path');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/util');
const { launch, getPage } = require('../src/browser');
const { isLoggedIn } = require('../src/publisher');

(async () => {
  const cfg = loadConfig();
  const logger = createLogger();
  console.log('--- 启动浏览器自检 ---');
  const ctx = await launch(cfg, { logger });
  try {
    const page = await getPage(ctx);
    await page.goto(cfg.site.writerHome, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
      console.log('goto 警告:', e.message.split('\n')[0]);
    });
    await page.waitForTimeout(4000);
    console.log('当前页面地址:', page.url());
    console.log('页面标题:', await page.title());
    const logged = await isLoggedIn(page);
    console.log('登录状态检测结果:', logged ? '已登录' : '未登录');
    console.log(logged ? '=> 登录态可用，可以直接跑发布流程' : '=> 尚未登录，需要先跑「1-首次登录」');
  } finally {
    await ctx.close().catch(() => {});
    console.log('--- 浏览器已关闭，自检结束 ---');
  }
  process.exit(0);
})().catch((e) => {
  console.error('自检失败:', e.message);
  process.exit(1);
});
