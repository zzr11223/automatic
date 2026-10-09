/*
 * 面板前端全流程自测：真浏览器 + 拦截 /api/run（不发真请求），验证各种操作组合
 *
 * 为什么存在（2026-10-09 一次审计抓出 3 个真 bug）：
 *   ① /api/run 网络失败会让面板永久卡在"忙"（post() 裸奔 fetch）
 *   ② 顶部统一时间在「发布所选」里被静默忽略（填了 12:00 却立即发）
 *   ③ 确认框少报"要定时"（显示立即发布，实际按 --at 发）
 * 这三个都属于"纯逻辑看着都对、真跑才现形"，钉死在测试里。
 *
 * 用法：node tools\test-ui-flow.js
 * 依赖：当前书要有「待发」章节（没有就跳过场景 1~4，只跑忙闲生命周期）
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { spawn } = require('child_process');
const fs = require('fs');

let pass = 0;
let fail = 0;
const ok = (n, c, e) => {
  if (c) {
    pass++;
    console.log('  ✅ ' + n);
  } else {
    fail++;
    console.log('  ❌ ' + n + (e ? '  → ' + e : ''));
  }
};
const section = (t) => console.log('\n【' + t + '】');

(async () => {
  const { loadConfig } = require(path.join(ROOT, 'src', 'config'));
  const { createLogger } = require(path.join(ROOT, 'src', 'util'));
  const books = require(path.join(ROOT, 'src', 'books'));
  const cfg = loadConfig();
  const logger = createLogger('ui-flow-test');
  books.ensureReady(cfg, logger);
  const PORT = 8899;

  section('1. 起面板 + 开页面');
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'ui', 'server.js'), '--port', String(PORT), '--no-open'], { cwd: ROOT, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 2500));
  const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright-core'));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  const captured = [];
  const dialogLog = [];
  page.on('dialog', (d) => {
    dialogLog.push(d.message());
    try {
      d.accept();
    } catch (_) {}
  });
  await page.route('**/api/run', async (route) => {
    captured.push(JSON.parse(route.request().postData() || '{}'));
    await route.abort(); // ★ 绝不真发请求
  });

  try {
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#chapter-body tr', { timeout: 15000 });
    ok('面板首页可打开、章节表已渲染', true);

    await page.click('.seg-btn[data-filter="pending"]').catch(() => {});
    await page.waitForTimeout(500);
    const n = await page.locator('#chapter-body tr').count();

    if (n >= 3) {
      section('2. 逐章定时 + 顶部统一时间（4 种组合的 --args 核对）');

      // 场景 1：勾 2 章 + 行内时间 → --schedule-map
      await page.locator('#chapter-body .ch-check').nth(0).check();
      await page.locator('#chapter-body .ch-check').nth(1).check();
      await page.locator('#chapter-body select.row-time').nth(0).selectOption('09:00');
      await page.locator('#chapter-body select.row-time').nth(1).selectOption('21:00');
      await page.click('#btn-publish-selected');
      await page.waitForTimeout(700);
      ok(
        '场景1（行内时间）→ 带 --schedule-map 且含两章时间',
        captured[0] && JSON.stringify(captured[0].args).includes('--schedule-map') && /09:00/.test(JSON.stringify(captured[0].args)) && /21:00/.test(JSON.stringify(captured[0].args)),
        JSON.stringify(captured[0] && captured[0].args)
      );
      ok('  确认框逐章列出时间', /⏰ 09:00/.test(dialogLog.at(-1) || ''), (dialogLog.at(-1) || '').slice(0, 80));

      // 场景 2：顶部 08:00、不勾行（保持勾选也行）→ --at
      await page.fill('#schedule-at', '08:00');
      await page.click('#btn-publish');
      await page.waitForTimeout(600);
      ok('场景2（顶部时间 + 开始发布）→ 带 --at 08:00', captured[1] && JSON.stringify(captured[1].args).includes('"08:00"'), JSON.stringify(captured[1] && captured[1].args));

      // 场景 3：顶部 12:00 + 勾第 3 行（行内没填）→ 没填的行用顶部补齐
      await page.fill('#schedule-at', '12:00');
      await page.locator('#chapter-body .ch-check').nth(2).check();
      await page.waitForTimeout(300);
      await page.click('#btn-publish-selected');
      await page.waitForTimeout(700);
      ok(
        '★ 场景3（顶部+部分行内）→ 未填行用顶部时间补齐（不再静默忽略）',
        captured[2] && /12:00/.test(JSON.stringify(captured[2].args)) && JSON.stringify(captured[2].args).includes('--schedule-map'),
        JSON.stringify(captured[2] && captured[2].args)
      );
      ok('  确认框标出「（统一时间）」', /（统一时间）/.test(dialogLog.at(-1) || ''), (dialogLog.at(-1) || '').slice(0, 80));

      // 场景 4：清掉行内时间，只留顶部 → --at（按序铺语义）
      await page.locator('#chapter-body select.row-time').nth(0).selectOption('');
      await page.locator('#chapter-body select.row-time').nth(1).selectOption('');
      await page.fill('#schedule-at', '12:00');
      await page.waitForTimeout(300);
      await page.click('#btn-publish-selected');
      await page.waitForTimeout(700);
      ok(
        '★ 场景4（只有顶部时间）→ 走 --at（确认框也必须别再显示"立即发布"）',
        captured[3] && JSON.stringify(captured[3].args).includes('--at') && !/立即发布/.test(dialogLog.at(-1) || ''),
        JSON.stringify(captured[3] && captured[3].args) + ' ｜ ' + (dialogLog.at(-1) || '').slice(0, 60)
      );
    } else {
      console.log(`  （待发章节只有 ${n} 章，跳过场景 1~4）`);
    }

    section('3. 忙闲生命周期（真跑 lint → 按钮要解锁）');
    await page.unroute('**/api/run');
    await page.fill('#schedule-at', '');
    await page.click('#btn-lint');
    const t0 = Date.now();
    let unlocked = false;
    while (Date.now() - t0 < 60000) {
      if (!(await page.locator('#btn-publish').isDisabled())) {
        unlocked = true;
        break;
      }
      await page.waitForTimeout(500);
    }
    ok('lint 跑完「开始发布」按钮解锁', unlocked);

    section('4. 无 JS 未捕获错误');
    ok('页面无 pageerror', errors.length === 0, errors.slice(0, 2).join(' ｜ '));
  } catch (e) {
    fail++;
    console.log('  ❌ 测试异常：' + String(e.message).split('\n')[0]);
  } finally {
    await browser.close().catch(() => {});
    try {
      child.kill();
    } catch (_) {}
    console.log(`\n————————————\n通过 ${pass} 项，失败 ${fail} 项`);
    process.exit(fail ? 1 : 0);
  }
})();
