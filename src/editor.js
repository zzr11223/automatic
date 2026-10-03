/**
 * 正文填充：多策略 + 自动校验，哪条路走通了就用哪条
 */
const { countChars } = require('./util');

async function readEditorText(el) {
  try {
    return await el.evaluate((e) =>
      e.tagName === 'TEXTAREA' || e.tagName === 'INPUT' ? e.value || '' : e.innerText || e.textContent || ''
    );
  } catch (_) {
    return '';
  }
}

function near(actual, expected, tolerance = 0.03) {
  const a = countChars(actual);
  const e = countChars(expected);
  if (e === 0) return a === 0;
  return Math.abs(a - e) / e <= tolerance;
}

/** 清空编辑器 */
async function clearEditor(page, el) {
  await el.click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(150);
  await page.keyboard.press('Control+A').catch(() => {});
  await page.waitForTimeout(80);
  await page.keyboard.press('Backspace').catch(() => {});
  await page.waitForTimeout(200);
}

/**
 * 往编辑器里填正文。返回 { ok, strategy, chars }
 */
async function fillEditor(page, el, text, logger) {
  const tag = await el.evaluate((e) => e.tagName.toLowerCase()).catch(() => '');
  const expected = countChars(text);

  // 策略 0：原生 input/textarea 直接 fill（最可靠）
  if (tag === 'textarea' || tag === 'input') {
    try {
      await el.fill(text, { timeout: 20000 });
      await page.waitForTimeout(300);
      const got = await readEditorText(el);
      if (near(got, text)) return { ok: true, strategy: '原生 fill', chars: countChars(got) };
      logger.warn(`原生 fill 校验不通过：期望 ~${expected} 字，实际 ~${countChars(got)} 字`);
    } catch (e) {
      logger.warn(`原生 fill 失败：${String(e.message).split('\n')[0]}`);
    }
  }

  const paragraphs = String(text)
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  // 策略 1：逐段 insertText（对 contenteditable 最通用）
  try {
    await clearEditor(page, el);
    await el.click({ timeout: 10000 });
    for (let i = 0; i < paragraphs.length; i++) {
      await page.keyboard.insertText(paragraphs[i]);
      if (i < paragraphs.length - 1) await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(500);
    const got = await readEditorText(el);
    if (near(got, text)) return { ok: true, strategy: '逐段输入', chars: countChars(got) };
    logger.warn(`逐段输入校验不通过：期望 ~${expected} 字，实际 ~${countChars(got)} 字，换下一种方式`);
  } catch (e) {
    logger.warn(`逐段输入出错：${String(e.message).split('\n')[0]}`);
  }

  // 策略 2：模拟粘贴事件（很多富文本编辑器监听 paste）
  try {
    await clearEditor(page, el);
    await el.evaluate((e, t) => {
      e.focus();
      const dt = new DataTransfer();
      dt.setData('text/plain', t);
      e.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, text);
    await page.waitForTimeout(700);
    const got = await readEditorText(el);
    if (near(got, text)) return { ok: true, strategy: '粘贴事件', chars: countChars(got) };
    logger.warn(`粘贴事件校验不通过：期望 ~${expected} 字，实际 ~${countChars(got)} 字`);
  } catch (e) {
    logger.warn(`粘贴事件出错：${String(e.message).split('\n')[0]}`);
  }

  // 策略 3：往页面塞一个临时 textarea 执行 copy，再 Ctrl+V（走真实剪贴板）
  try {
    await clearEditor(page, el);
    await page.evaluate((t) => {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.setAttribute('data-nap-tmp', '1');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }, text);
    await el.click({ timeout: 10000 });
    await page.keyboard.press('Control+V');
    await page.waitForTimeout(900);
    const got = await readEditorText(el);
    if (near(got, text)) return { ok: true, strategy: '真实剪贴板粘贴', chars: countChars(got) };
    logger.warn(`剪贴板粘贴校验不通过：期望 ~${expected} 字，实际 ~${countChars(got)} 字`);
  } catch (e) {
    logger.warn(`剪贴板粘贴出错：${String(e.message).split('\n')[0]}`);
  }

  const finalText = await readEditorText(el);
  return { ok: false, strategy: '全部失败', chars: countChars(finalText) };
}

/** 填标题 */
async function fillTitle(page, el, title, logger) {
  const tag = await el.evaluate((e) => e.tagName.toLowerCase()).catch(() => '');
  try {
    if (tag === 'input' || tag === 'textarea') {
      await el.fill(title, { timeout: 10000 });
    } else {
      await el.click({ timeout: 10000 });
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await page.keyboard.insertText(title);
    }
    await page.waitForTimeout(200);
    const got = await el.evaluate((e) => e.value || e.innerText || e.textContent || '').catch(() => '');
    if (String(got).trim().includes(title.slice(0, 6))) {
      return { ok: true };
    }
    logger.warn(`标题回读不一致：写入「${title}」，页面读到「${String(got).trim().slice(0, 40)}」`);
    return { ok: false };
  } catch (e) {
    logger.warn(`填标题失败：${String(e.message).split('\n')[0]}`);
    return { ok: false };
  }
}

module.exports = { fillEditor, fillTitle, readEditorText, clearEditor };
