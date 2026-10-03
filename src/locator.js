/**
 * 自适应元素定位
 *
 * 设计原则：不写死 CSS 选择器。番茄的页面会改版，写死的选择器一改就废。
 * 这里改成按"语义特征"找元素：placeholder 关键词、按钮文字、元素面积、可见性。
 * 如果自动识别失败，config.json 的 selectors 里可以手动写死 CSS 覆盖。
 */

/** 在页面/iframe 内执行的扫描函数（注意：这个函数会被序列化传到浏览器里跑） */
function scanFn(spec) {
  const { selector, keywords = [], matchText = [], excludeText = [], rank = 'first', minArea = 0 } = spec;

  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.05) return false;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    return true;
  };

  let els = [];
  try {
    els = [...document.querySelectorAll(selector)].filter(vis);
  } catch (e) {
    return null;
  }
  if (minArea) {
    els = els.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width * r.height >= minArea;
    });
  }
  if (!els.length) return null;

  const hintOf = (el) =>
    [
      el.placeholder || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('data-placeholder') || '',
      el.getAttribute('title') || '',
      el.name || '',
      el.id || '',
      String(el.className || ''),
    ]
      .join(' ')
      .toLowerCase();

  const textOf = (el) => String(el.innerText || el.textContent || el.value || '').trim();

  // 1) 关键词匹配（placeholder / aria-label / class 等）
  if (keywords.length) {
    let best = null;
    let bestScore = 0;
    for (const el of els) {
      const h = hintOf(el);
      let score = 0;
      keywords.forEach((k, i) => {
        if (h.includes(String(k).toLowerCase())) score += (keywords.length - i) * 10;
      });
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best; // 没匹配到就返回 null，由上层决定降级策略
  }

  // 2) 按可见文字匹配（按钮类）
  if (matchText.length) {
    const ex = excludeText.map((t) => String(t).toLowerCase());
    const wants = matchText.map((t) => String(t).toLowerCase());
    const cands = els.filter((el) => {
      const t = textOf(el).toLowerCase();
      if (!t || t.length > 20) return false;
      if (ex.some((e) => t.includes(e))) return false;
      return wants.some((m) => t.includes(m));
    });
    if (!cands.length) return null;
    cands.sort((a, b) => {
      const ra = wants.findIndex((m) => textOf(a).toLowerCase().includes(m));
      const rb = wants.findIndex((m) => textOf(b).toLowerCase().includes(m));
      return ra - rb;
    });
    return cands[0];
  }

  // 3) 按面积 / 位置排序
  if (rank === 'largest') {
    els.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
  } else if (rank === 'topmost') {
    els.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  }
  return els[0];
}

/** 在指定 frame 内查找 */
async function findInFrame(frame, spec) {
  let handle = null;
  try {
    handle = await frame.evaluateHandle(scanFn, spec);
  } catch (_) {
    return null;
  }
  if (!handle) return null;
  const el = handle.asElement();
  if (!el) {
    await handle.dispose().catch(() => {});
    return null;
  }
  return el;
}

/** 主页面 + 所有 iframe 里找，返回 { el, frame } */
async function findElement(page, spec, { deep = true } = {}) {
  const main = page.mainFrame();
  const el = await findInFrame(main, spec);
  if (el) return { el, frame: main };

  if (deep) {
    for (const fr of page.frames()) {
      if (fr === main) continue;
      try {
        const e2 = await findInFrame(fr, spec);
        if (e2) return { el: e2, frame: fr };
      } catch (_) {}
    }
  }
  return { el: null, frame: null };
}

/** 用 CSS 选择器直接找（config 手动指定时走这条路） */
async function findByCss(page, css) {
  for (const fr of page.frames()) {
    try {
      const loc = fr.locator(css).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
        return { el: await loc.elementHandle(), frame: fr };
      }
    } catch (_) {}
  }
  return { el: null, frame: null };
}

/* ------------------------- 高层定位器 ------------------------- */

async function findTitleInput(page, cfg) {
  if (cfg.selectors.titleInput) {
    const r = await findByCss(page, cfg.selectors.titleInput);
    if (r.el) return r;
  }
  const keywordSpec = {
    selector: 'input[type="text"], input:not([type]), textarea, [contenteditable="true"]',
    keywords: ['章节标题', '章节名', '章节名称', '标题', 'title', 'chapter'],
  };
  let r = await findElement(page, keywordSpec);
  if (r.el) return r;

  // 降级：页面上第一个可见的短输入框，通常就是标题
  r = await findElement(page, {
    selector: 'input[type="text"], input:not([type])',
    rank: 'topmost',
  });
  return r;
}

async function findContentEditor(page, cfg) {
  if (cfg.selectors.contentEditor) {
    const r = await findByCss(page, cfg.selectors.contentEditor);
    if (r.el) return r;
  }
  // 富文本编辑器：取面积最大的可编辑区域
  let r = await findElement(page, {
    selector: '[contenteditable="true"]:not([data-nap-title="1"])',
    rank: 'largest',
    minArea: 40000,
  });
  if (r.el) return r;

  // 降级：面积最大的 textarea
  r = await findElement(page, {
    selector: 'textarea:not([data-nap-title="1"])',
    rank: 'largest',
    minArea: 20000,
  });
  return r;
}

async function findButton(page, texts, excludes = []) {
  return await findElement(page, {
    selector: 'button, a, [role="button"], div[class*="btn"], span[class*="btn"], div[class*="Button"]',
    matchText: texts,
    excludeText: excludes,
  });
}

/**
 * 在弹窗里找一个"选项按钮"。
 *
 * 为什么不直接用 findButton：
 *   findButton 的候选包含 div[class*="btn"]，而番茄「请选择内容检测方式」弹窗
 *   的两个选项外面套了一层容器 div。容器的 innerText 会把两个选项的文字拼在
 *   一起（"仅基础检测\n全面检测"），面积又比单个按钮大 —— findElement 按面积
 *   排序，于是容器被优先选中。点容器等于没点，弹窗纹丝不动。
 *   2026-09 实测踩坑：日志里连续三轮都在点「仅基础检测\n全面检测」。
 *
 * 策略：只在弹窗范围内找，且优先只认真正的 <button>；
 *       放宽到 div[class*="btn"] 时要求"元素自身文字完全等于目标"，
 *       容器因为文字被拼接而必然落选。
 *
 * @param {import('playwright-core').Page} page
 * @param {string[]} texts 目标文字，数组顺序 = 优先级
 * @returns {Promise<import('playwright-core').Locator|null>}
 */
async function findDialogOption(page, texts) {
  const modalSel = '.arco-modal, [role="dialog"], [class*="modal-wrapper"], [class*="modal"]';
  const scopes = page.locator(modalSel);
  const scopeCount = await scopes.count().catch(() => 0);
  if (!scopeCount) return null;

  const passes = ['button', '[role="button"], div[class*="btn"], span[class*="btn"]'];
  for (const sel of passes) {
    const strict = sel === 'button'; // 真按钮：允许前缀匹配（可能带"（不限次数）"后缀）
    let best = null;

    for (let i = 0; i < Math.min(scopeCount, 8); i++) {
      const scope = scopes.nth(i);
      if (!(await scope.isVisible().catch(() => false))) continue;

      const cands = scope.locator(sel);
      const n = await cands.count().catch(() => 0);
      for (let j = 0; j < n; j++) {
        const b = cands.nth(j);
        if (!(await b.isVisible().catch(() => false))) continue;
        const t = String((await b.innerText().catch(() => '')) || '').trim();
        if (!t) continue;
        const rank = texts.findIndex((w) => (strict ? t === w || t.startsWith(w) : t === w));
        if (rank === -1) continue;
        if (!best || rank < best.rank) best = { el: b, rank };
      }
    }
    if (best) return best.el;
  }
  return null;
}

/**
 * 找「第 [ ] 章」里的章节序号输入框。
 * 特征：紧挨在标题框左边（或同一行靠前）的一个很窄的可见输入框。
 */
async function findChapterNoInput(page, cfg, titleEl) {
  if (!titleEl) return null;
  const handle = await page
    .evaluateHandle((t) => {
      if (!t) return null;
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 8 && r.height > 8 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      const tr = t.getBoundingClientRect();
      const cands = [...document.querySelectorAll('input[type="text"], input:not([type])')]
        .filter((el) => el !== t && vis(el))
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width <= 160 && r.height <= 60 && Math.abs(r.top - tr.top) < 70 && r.left <= tr.left + 10;
        });
      if (!cands.length) return null;
      cands.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const da = Math.abs(tr.left - ra.right) + Math.abs(tr.top - ra.top);
        const db = Math.abs(tr.left - rb.right) + Math.abs(tr.top - rb.top);
        return da - db;
      });
      return cands[0];
    }, titleEl)
    .catch(() => null);
  if (!handle) return null;
  return handle.asElement();
}

module.exports = {
  findElement,
  findByCss,
  findTitleInput,
  findContentEditor,
  findButton,
  findDialogOption,
  findChapterNoInput,
};
