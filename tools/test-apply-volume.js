/**
 * 分卷切换实测 —— 直接调用生产的 applyVolume()，不重写一遍逻辑。
 *
 * 目的：验证「创建章节页顶栏的分卷控件」能不能被自动切换。
 * 这是分卷功能唯一还没被验证过的环节。
 *
 * 步骤：
 *   1. 打开创建章节页，读顶栏当前卷 + 下拉里的候选卷
 *   2. applyVolume → 切到「另一个卷」，核对顶栏
 *   3. applyVolume → 切回原来那个卷，核对顶栏（同时把平台状态还原）
 *   4. applyVolume → 再切一次同一个卷，验证"已经对了就不再点"的幂等性
 *   5. 指定一个后台不存在的卷 → 应明确拒绝，而不是瞎点
 *
 * ★ 卷名不写死：从页面下拉的候选里现取。所以这个脚本对谁都能跑，
 *   只要求「番茄后台里至少建了 2 个卷」。
 * ★ 全程不填标题、不填正文、不点发布。
 */
const path = require('path');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/util');
const { applyVolume, readCurrentVolume, readVolumeOptions } = require('../src/publisher');
const { normalizeVolumeName } = require('../src/volume');
const { openBrowser, currentBook, createChapterUrl } = require('./_shared');

const ROOT = path.resolve(__dirname, '..');
// ★ 地址从「当前那本」的 books\<书名>\book.json 来，不写死（见 _shared.js 里的说明）
const CREATE = createChapterUrl(currentBook());

// ★ 卷名不写死 —— 打开页面后从下拉候选里现取（见下面 VOL_A / VOL_B 的赋值）
let VOL_A = '';
let VOL_B = '';

(async () => {
  const cfg = loadConfig();
  const logger = createLogger('volume-test');

  const { ctx } = await openBrowser('test-apply-volume', { cfg, logger });
  const page = ctx.pages()[0] || (await ctx.newPage());

  const results = [];
  /**
   * @param {string} label
   * @param {string} want
   * @param {boolean} [shouldRefuse] true = 这个用例**本来就该被拒绝**（比如指定一个不存在的卷），
   *        拒绝了才算通过。不然汇总里会把"按预期的失败"显示成一个红叉，误导后面看结果的人。
   */
  const step = async (label, want, shouldRefuse = false) => {
    console.log(`\n--- ${label}：目标「${want}」 ---`);
    const r = await applyVolume(page, cfg, { title: '（测试）', volume: want }, logger);
    const now = await readCurrentVolume(page);
    const ok = shouldRefuse
      ? !r.ok // 期望被拒
      : r.ok && normalizeVolumeName(now) === normalizeVolumeName(want);
    console.log(`  结果：${ok ? '✅ 成功' : '❌ 失败'}  |  顶栏现在是「${now}」`);
    if (!r.ok) console.log(`  原因：${r.reason}`);
    results.push({ label, want, ok, now, shouldRefuse, detail: r });
    return ok;
  };

  try {
    console.log('=== 打开创建章节页 ===');
    await page.goto(CREATE, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    for (let i = 0; i < 25; i++) {
      if ((await page.locator('[contenteditable="true"]').count().catch(() => 0)) > 0) break;
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(2500);
    console.log('URL: ' + page.url());
    const ORIG = await readCurrentVolume(page);
    console.log('顶栏初始卷：「' + ORIG + '」');

    // 先看看下拉里到底有哪些卷（手工读一遍，留档）
    const wrap = page.locator('.publish-header-volume-wrap').first();
    await wrap.click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const opts = (await readVolumeOptions(page)).map((s) => String(s).trim()).filter(Boolean);
    console.log('下拉里的候选卷：' + JSON.stringify(opts));
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(1200);

    /* ★ 从候选里现取两个卷名（不写死）。
       A = 切到"另一个卷"；B = 切回原来的卷，顺带把平台状态还原。 */
    if (opts.length < 2) {
      console.log(
        `\n❌ 后台只找到 ${opts.length} 个卷，没法测"来回切换"。\n` +
          '   先去番茄后台的章节管理页点「编辑分卷」建至少 2 个卷，再跑这个脚本。'
      );
      await ctx.close().catch(() => {});
      process.exit(1);
    }
    const nOrig = normalizeVolumeName(ORIG);
    VOL_A = opts.find((o) => normalizeVolumeName(o) !== nOrig) || opts[0];
    VOL_B = nOrig ? ORIG : opts.find((o) => normalizeVolumeName(o) !== normalizeVolumeName(VOL_A));
    console.log(`本次用到的两个卷：A=「${VOL_A}」  B=「${VOL_B}」`);

    await step('第 1 次：切到另一个卷', VOL_A);
    await page.screenshot({ path: path.join(ROOT, 'logs', 'voltest-1-first.png') }).catch(() => {});

    await step('第 2 次：切回原来那个卷', VOL_B);
    await page.screenshot({ path: path.join(ROOT, 'logs', 'voltest-2-back.png') }).catch(() => {});

    await step('第 3 次：再指定一次同一个卷（应识别为"已经是了"，跳过点击）', VOL_B);

    await step('第 4 次：指定一个后台不存在的卷（应明确拒绝，而不是瞎点）', '第九卷：不存在的卷', true);
  } finally {
    await ctx.close().catch(() => {});
  }

  console.log('\n================ 汇总 ================');
  for (const r of results) {
    const tag = r.shouldRefuse ? '（按预期被拒绝）' : '';
    console.log(`${r.ok ? '✅' : '❌'} ${r.label}${tag}  → 顶栏「${r.now}」`);
  }
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass} / ${results.length} 项通过`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error('实测失败: ' + e.message);
  process.exit(1);
});
