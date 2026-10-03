/**
 * 自动登录
 *
 * 优先用 credentials.json 里的手机号 + 密码自动登录（密码登录方式）。
 * 如果平台弹出滑块/安全验证，会提示人工在浏览器里完成，脚本继续等待。
 */
const { loadCredentials, maskPhone } = require('./credentials');
const { findElement, findButton } = require('./locator');

async function readBody(page, n = 3000) {
  return await page
    .evaluate((k) => (document.body ? document.body.innerText.slice(0, k) : ''), n)
    .catch(() => '');
}

/** 判断是否已登录作家后台 */
async function isLoggedIn(page) {
  const url = page.url();
  if (/\/writer\/login/.test(url)) return false;
  const txt = await readBody(page, 4000);
  if (!txt) return false;
  // 登录页特征
  if (/验证码登录|扫码登录|登录\/注册/.test(txt)) return false;
  // 后台特征
  return /作品管理|创作中心|我的作品|新建作品|章节管理|作品数据|收益管理/.test(txt);
}

/** 等页面渲染出内容（首次打开常常是空白壳） */
async function waitForContent(page, { minLen = 50, tries = 12, gap = 1200 } = {}) {
  for (let i = 0; i < tries; i++) {
    const len = await page
      .evaluate(() => (document.body ? document.body.innerText.length : 0))
      .catch(() => 0);
    if (len >= minLen) return true;
    await page.waitForTimeout(gap);
  }
  return false;
}

/**
 * 勾选"我已阅读并同意用户协议"
 *
 * 注意：番茄用 Arco Design 组件，勾选框是隐藏的原生 checkbox（自定义样式覆盖），
 * 必须用真实鼠标点击，JS 的 el.click() 不生效。
 */
async function acceptAgreement(page, logger) {
  const isChecked = async () =>
    await page
      .evaluate(() => {
        const c = document.querySelector('input[type="checkbox"]');
        return c ? c.checked : null;
      })
      .catch(() => null);

  if ((await isChecked()) === true) {
    logger.info('用户协议已是勾选状态');
    return 'already';
  }

  // 策略 1：真实点击 checkbox
  try {
    const cb = page.locator('input[type="checkbox"]').first();
    if ((await cb.count()) > 0) {
      await cb.check({ force: true, timeout: 4000 }).catch(() => {});
      if ((await isChecked()) === true) {
        logger.info('已勾选用户协议');
        return 'checkbox';
      }
      // 方案 1b：点它的父元素
      await cb.locator('xpath=..').click({ timeout: 4000, force: true }).catch(() => {});
      if ((await isChecked()) === true) {
        logger.info('已勾选用户协议（点父元素）');
        return 'parent';
      }
    }
  } catch (_) {}

  // 策略 2：点协议容器里的小图标
  try {
    const icons = page.locator('[class*="protocol"] svg, [class*="protocol"] img, [class*="protocol"] i');
    if ((await icons.count()) > 0) {
      await icons.first().click({ timeout: 4000, force: true }).catch(() => {});
      if ((await isChecked()) === true) {
        logger.info('已勾选用户协议（点图标）');
        return 'icon';
      }
    }
  } catch (_) {}

  logger.warn('没能自动勾选"同意协议" —— 如果登录按钮点不动，需要你手动点一下');
  return null;
}

/** 切换到"密码登录"标签（必须真实鼠标点击） */
async function switchToPassword(page, logger) {
  try {
    const btn = page.locator('button', { hasText: '密码登录' }).first();
    if ((await btn.count()) === 0) {
      logger.info('页面上没有「密码登录」按钮，按当前表单继续');
      return false;
    }
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click({ timeout: 10000 });

    // 等密码框渲染出来
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(600);
      if ((await page.locator('input[type="password"]').count()) > 0) {
        logger.info('已切换到「密码登录」');
        return true;
      }
    }
    logger.warn('点了「密码登录」，但密码输入框没有出现');
    return false;
  } catch (e) {
    logger.warn('切换密码登录失败：' + String(e.message).split('\n')[0]);
    return false;
  }
}

/**
 * 自动登录主流程
 * 返回 { ok, reason?, body? }
 */
async function autoLogin(page, cfg, logger, opts = {}) {
  const cred = loadCredentials(cfg);
  if (!cred) {
    return { ok: false, reason: 'NO_CREDENTIALS' };
  }

  logger.info(`账号：${maskPhone(cred.phone)}，方式：密码登录`);

  await page.goto(cfg.site.writerHome, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await waitForContent(page);
  await page.waitForTimeout(2000);

  if (await isLoggedIn(page)) {
    logger.ok('登录状态仍然有效，跳过登录');
    return { ok: true, already: true };
  }

  // 如果不在登录页，先找"登录"入口
  if (!/\/login/.test(page.url())) {
    const entry = await findButton(page, ['登录', '立即登录', '请登录'], ['退出', '注销', '取消']);
    if (entry.el) {
      await entry.el.click({ timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(3500);
      await waitForContent(page);
    }
  }

  await switchToPassword(page, logger);

  // ---- 手机号 ----
  const phoneHit = await findElement(page, {
    selector: 'input[type="text"], input[type="tel"], input:not([type])',
    keywords: ['手机号', '手机', '账号', 'username', 'phone'],
  });
  if (!phoneHit.el) {
    return { ok: false, reason: 'NO_PHONE_INPUT', body: await readBody(page, 800) };
  }
  try {
    await phoneHit.el.fill(cred.phone);
  } catch (_) {
    await phoneHit.el.click().catch(() => {});
    await page.keyboard.insertText(cred.phone);
  }
  await page.waitForTimeout(400);

  // ---- 密码 ----
  const passHit = await findElement(page, { selector: 'input[type="password"]' });
  if (!passHit.el) {
    return { ok: false, reason: 'NO_PASSWORD_INPUT', body: await readBody(page, 800) };
  }
  try {
    await passHit.el.fill(cred.password);
  } catch (_) {
    await passHit.el.click().catch(() => {});
    await page.keyboard.insertText(cred.password);
  }
  await page.waitForTimeout(400);
  logger.info('手机号和密码已填入');

  // ---- 协议 ----
  await acceptAgreement(page, logger);
  await page.waitForTimeout(400);

  // ---- 提交 ----
  const btn = await findButton(page, ['登录/注册', '立即登录', '登录'], ['取消', '返回', '退出', '忘记密码', '密码登录']);
  if (!btn.el) {
    return { ok: false, reason: 'NO_LOGIN_BUTTON', body: await readBody(page, 800) };
  }
  const disabled = await btn.el
    .evaluate((e) => e.disabled === true || String(e.className || '').includes('disabled') || e.getAttribute('aria-disabled') === 'true')
    .catch(() => false);
  if (disabled) logger.warn('登录按钮当前是禁用状态，可能有必填项没完成，仍然尝试点击');

  logger.info('提交登录...');
  await btn.el.click({ timeout: 15000 }).catch(async () => {
    await btn.el.evaluate((e) => e.click()).catch(() => {});
  });

  // ---- 等结果 ----
  let deadline = Date.now() + (opts.timeoutSeconds || 25) * 1000;
  let warnedVerify = false;
  let lastBody = '';

  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);

    if (await isLoggedIn(page)) {
      logger.ok('登录成功！登录状态已保存到本地，以后不用再登');
      return { ok: true };
    }

    lastBody = await readBody(page, 2000);

    if (!warnedVerify && /滑块|拖动|安全验证|请完成验证|图形验证|行为验证/.test(lastBody)) {
      warnedVerify = true;
      logger.warn('平台要求额外安全验证 —— 请在浏览器窗口里手动完成（拖动滑块等）');
      logger.warn('脚本会继续等待 3 分钟');
      deadline = Date.now() + 180000;
    }
  }

  return { ok: false, reason: 'LOGIN_TIMEOUT', body: lastBody };
}

module.exports = { autoLogin, isLoggedIn, waitForContent, readBody, acceptAgreement, switchToPassword };
