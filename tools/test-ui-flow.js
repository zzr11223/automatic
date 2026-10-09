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
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'ui', 'server.js'), '--port', String(PORT), '--no-open', '--no-autosync'], { cwd: ROOT, stdio: 'ignore' });
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

    // ── 顶部「选时间…」：选择器挑一个时间写进输入框（2026-10-09 新增）
    {
      const hasBtn = (await page.locator('#btn-pick-at').count()) === 1;
      ok('顶部有「选时间…」按钮', hasBtn);
      if (hasBtn) {
        await page.click('#btn-pick-at');
        await page.waitForTimeout(300);
        const visible = await page.locator('#picker:not(.hidden)').count();
        ok('  点开出现日历+时间选择器', visible === 1);
        await page.click('#pk-now');
        await page.click('#pk-ok');
        await page.waitForTimeout(200);
        const v = await page.inputValue('#schedule-at');
        ok('  确定后写进输入框（完整日期时刻）', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(v), v);
        await page.fill('#schedule-at', '');
      }
    }

    // ── 番茄后台卡片 + 「刷新后台状态」按钮（2026-10-09 新增；拦截 /api/run，不发真请求）
    {
      const hasCard = (await page.locator('#platform-body').count()) === 1;
      ok('「番茄后台」卡片在', hasCard);
      const hasBtn = (await page.locator('#btn-refresh-backend').count()) === 1;
      ok('  卡片上有「刷新后台状态」按钮', hasBtn);
      if (hasBtn) {
        const before = captured.length;
        await page.click('#btn-refresh-backend');
        await page.waitForTimeout(800);
        const last = captured[captured.length - 1];
        ok('  点按钮 → 发起 sync-records', captured.length > before && last && last.cmd === 'sync-records', JSON.stringify(last && last.args));
      }
    }

    if (n >= 3) {
      section('2. 逐章定时 + 顶部统一时间（4 种组合的 --args 核对）');
      // ★ 每点一次按钮前记一次长度，断言"最新一条"——场景2 在额度禁用时不产生请求，
      //   固定下标会错位（2026-10-09 踩过）
      const lastReq = () => captured[captured.length - 1];

      // 场景 1：勾 2 章 + 用「日历+时间选择器」给每章选时间 → --schedule-map
      //   （点行内按钮 → 选择器 → 「此刻」保证是未来时间 → 确定）
      const pickNow = async (idx) => {
        await page.locator('#chapter-body .row-time-btn').nth(idx).click();
        await page.click('#pk-now');
        await page.click('#pk-ok');
        return (await page.locator('#chapter-body .row-time-btn').nth(idx).textContent()).trim();
      };
      await page.locator('#chapter-body .ch-check').nth(0).check();
      await page.locator('#chapter-body .ch-check').nth(1).check();
      const t0 = await pickNow(0);
      const t1 = await pickNow(1);
      const hm0 = t0.split(' ').pop();
      const hm1 = t1.split(' ').pop();
      ok('选择器确定后行内按钮显示所选时间', !!hm0 && /^\d{2}:\d{2}$/.test(hm0) && !/立即发布/.test(t0), t0);
      let b0 = captured.length;
      await page.click('#btn-publish-selected');
      await page.waitForTimeout(700);
      ok(
        '场景1（逐章选择器时间）→ 带 --schedule-map 且含两章时间',
        captured.length > b0 && /--schedule-map/.test(JSON.stringify(lastReq().args)) && lastReq().args.join(',').includes(hm0) && lastReq().args.join(',').includes(hm1),
        JSON.stringify(lastReq() && lastReq().args)
      );
      ok('  确认框逐章列出时间', /⏰/.test(dialogLog.at(-1) || ''), (dialogLog.at(-1) || '').slice(0, 80));

      // 场景 2：顶部 08:00 + 开始发布 → --at。
      //   ★ 若今日额度放不下下一章，按钮会按设计禁用（按钮 title 写明额度）——两种状态分别断言
      await page.fill('#schedule-at', '08:00');
      if (await page.locator('#btn-publish').isDisabled()) {
        // 按钮禁用时原因是显示在提示行里的（不是 title）
        const hint = (await page.textContent('#job-hint')) || '';
        ok('场景2（额度不够 → 开始发布被正确禁用）', /放不下|额度/.test(hint), hint.slice(0, 60));
      } else {
        b0 = captured.length;
        await page.click('#btn-publish');
        await page.waitForTimeout(600);
        ok('场景2（顶部时间 + 开始发布）→ 带 --at 08:00', captured.length > b0 && /"08:00"/.test(JSON.stringify(lastReq().args)), JSON.stringify(lastReq() && lastReq().args));
      }

      // 场景 3：顶部 12:00 + 勾第 3 行（行内没填）→ 没填的行用顶部补齐
      await page.fill('#schedule-at', '12:00');
      await page.locator('#chapter-body .ch-check').nth(2).check();
      await page.waitForTimeout(300);
      b0 = captured.length;
      await page.click('#btn-publish-selected');
      await page.waitForTimeout(700);
      ok(
        '★ 场景3（顶部+部分行内）→ 未填行用顶部时间补齐（不再静默忽略）',
        captured.length > b0 && /12:00/.test(JSON.stringify(lastReq().args)) && /--schedule-map/.test(JSON.stringify(lastReq().args)),
        JSON.stringify(lastReq() && lastReq().args)
      );
      ok('  确认框标出「（统一时间）」', /（统一时间）/.test(dialogLog.at(-1) || ''), (dialogLog.at(-1) || '').slice(0, 80));

      // 场景 4：清掉行内时间（选择器里的「设为立即发布」），只留顶部 → --at（按序铺语义）
      await page.locator('#chapter-body .row-time-btn').nth(0).click();
      await page.click('#pk-clear');
      await page.locator('#chapter-body .row-time-btn').nth(1).click();
      await page.click('#pk-clear');
      await page.fill('#schedule-at', '12:00');
      await page.waitForTimeout(300);
      b0 = captured.length;
      await page.click('#btn-publish-selected');
      await page.waitForTimeout(700);
      ok(
        '★ 场景4（只有顶部时间）→ 走 --at（确认框也必须别再显示"立即发布"）',
        captured.length > b0 && /--at/.test(JSON.stringify(lastReq().args)) && !/立即发布/.test(dialogLog.at(-1) || ''),
        JSON.stringify(lastReq() && lastReq().args) + ' ｜ ' + (dialogLog.at(-1) || '').slice(0, 60)
      );
    } else {
      console.log(`  （待发章节只有 ${n} 章，跳过场景 1~4）`);
    }

    section('3. 忙闲生命周期（真跑 lint → 按钮要解锁）');
    await page.unroute('**/api/run');
    await page.fill('#schedule-at', '');
    await page.click('#btn-lint');
    // ★ btn-lint 只在 busy 时被禁用，是干净的忙闲信号（btn-publish 额度不够时本来就禁用）。
    //   lint 在这个小书上可能 1 秒内就跑完 —— 用 60ms 紧轮询抓「忙」窗口，别睡大觉
    let sawBusy = false;
    let unlocked = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const dis = await page.locator('#btn-lint').isDisabled();
      if (dis) sawBusy = true;
      else if (sawBusy) {
        unlocked = true;
        break;
      } else if (Date.now() - t0 > 8000) {
        break; // 8 秒还没见过忙 = 异常，别再等
      }
      await page.waitForTimeout(60);
    }
    ok('lint 跑起来时进入「忙」', sawBusy);
    ok('lint 跑完按钮解锁（生命周期闭环）', unlocked);

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
