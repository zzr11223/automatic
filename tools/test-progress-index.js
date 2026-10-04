/**
 * 发布记录「按标题 / 按章节序号」双通道识别的自测。
 *
 * 纯离线：不碰 data/progress.json（把账本当参数注入），不碰浏览器。
 * 跑法：node tools\test-progress-index.js
 *
 * 背景：账本以标题为 key。标题改一个字就找不到记录了 → 会重发。
 * 所以补了"按章节序号认"这条兜底通道，这个脚本就是验它。
 */
const path = require('path');
const progress = require(path.join(__dirname, '..', 'src', 'progress.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${extra ? '  → ' + extra : ''}`);
  }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}
function section(t) {
  console.log(`\n【${t}】`);
}

/* ---------------- 造一份账本（照搬真实 progress.json 的形状） ---------------- */
const book = {
  chapters: {
    '第17章 星海归途': {
      status: 'published',
      mode: 'publish',
      chapterNo: 17,
      verified: true,
      at: '2026/9/27 10:25:14',
    },
    '第21章 云隐谷的初雪': {
      status: 'published',
      mode: 'publish',
      chapterNo: 21,
      verified: true,
      at: '2026/9/27 10:49:50',
    },
    // ★ 这条就是"改名"场景的源头：账本里记的是旧标题
    '第22章 没人懂的校准滑块': {
      status: 'published',
      mode: 'publish',
      chapterNo: 22,
      verified: true,
      at: '2026/9/28 20:21:00',
      note: '用户在番茄后台手动发布；补记',
    },
    // 一条"点了按钮但没确认"的记录，也应该算已发（防止重发）
    '第23章 第一台原型机': {
      status: 'published',
      chapterNo: 23,
      verified: false,
      at: '2026/9/28 20:24:00',
    },
    // 一条失败记录，不该被当成已发
    '第24章 雷达站的百步穿杨': {
      status: 'failed',
      reason: '正文填充失败',
      chapterNo: 24,
      at: '2026/9/29 22:21:00',
    },
    // 草稿也算"处理过了"
    '第25章 换上旧装备另辟蹊径': {
      status: 'draft',
      chapterNo: 25,
      at: '2026/9/30 22:27:00',
    },
    // 老记录：没有 chapterNo 字段，只能从标题抠
    '第26章 侦察箭矢的震撼': {
      status: 'published',
      at: '2026/9/30 22:29:00',
    },
    // 中文数字序号
    '第二十七章 八百米的穿墙一击': {
      status: 'published',
      chapterNo: 27,
      at: '2026/10/2 23:32:00',
    },
  },
};

/* ---------------- 1. 按标题（主通道） ---------------- */
section('① 按标题命中（主通道）');
{
  const m = progress.matchDone('第17章 星海归途', undefined, book);
  eq('熟悉的标题 → done', m.done, true);
  eq('  依据是 title', m.how, 'title');
  eq('  序号来自记录里的 chapterNo', m.no, 17);
}

/* ---------------- 2. 标题改过 → 靠序号兜住（本轮的核心） ---------------- */
section('② 标题改过 → 靠章节序号兜住');
{
  const m = progress.matchDone('第22章 没人懂的校准', undefined, book); // 抹掉了「滑块」
  eq('改过标题的章节 → 仍然算已发', m.done, true);
  eq('  依据是 number（不是 title）', m.how, 'number');
  eq('  认出是第 22 章', m.no, 22);
  eq('  能报出账本里的旧标题', m.by, '第22章 没人懂的校准滑块');
}
{
  // 标题被大改：连"第X章"都没了，此时只能靠调用方显式传 chapterNo
  const noHint = progress.matchDone('序章 重启', undefined, book);
  eq('标题里没有序号、又不传 chapterNo → 判不出来（保守放过）', noHint.done, false);
  const withHint = progress.matchDone('序章 重启', 21, book);
  eq('显式传 chapterNo=21 → 认出来', withHint.done, true);
  eq('  依据是 number', withHint.how, 'number');
}

/* ---------------- 3. 失败记录不能算已发 ---------------- */
section('③ 失败记录不算已发（否则会漏发）');
{
  const m = progress.matchDone('第24章 雷达站的百步穿杨', undefined, book);
  eq('failed 的记录 → 不算已发', m.done, false);
}

/* ---------------- 4. 草稿 / 未确认 都算已发 ---------------- */
section('④ 草稿、未确认结果都算已发（宁可漏发也不重发）');
{
  const d = progress.matchDone('第25章 换上旧装备另辟蹊径', undefined, book);
  eq('draft → 算已处理', d.done, true);
  const u = progress.matchDone('第23章 第一台原型机', undefined, book);
  eq('published 但 verified=false → 仍算已发', u.done, true);
  eq('  记录里能看出它当时没确认', u.record && u.record.verified, false);
}

/* ---------------- 5. 老记录缺 chapterNo → 从标题抠 ---------------- */
section('⑤ 老记录没有 chapterNo 字段 → 从标题抠序号');
{
  eq('recordNo 从标题解析出 26', progress.recordNo('第26章 侦察箭矢的震撼', {}), 26);
  const m = progress.matchDone('第26章 完全换了个标题', undefined, book);
  eq('旧记录没有 chapterNo，改名后仍能靠标题解析兜住', m.done, true);
  eq('  认出是第 26 章', m.no, 26);
}

/* ---------------- 6. 中文数字序号 ---------------- */
section('⑥ 中文数字序号（第二十七章）也要认');
{
  const m = progress.matchDone('第二十七章 八百米的穿墙一击', undefined, book);
  eq('账本里是中文数字 → 按标题命中', m.done, true);
  eq('  序号解析成 27', m.no, 27);
  const renamed = progress.matchDone('第27章 八百米的穿墙一击（微调）', undefined, book);
  eq('改成阿拉伯数字 + 改标题 → 靠序号兜住', renamed.done, true);
  eq('  依据是 number', renamed.how, 'number');
}

/* ---------------- 7. 真的没发过的，必须判"没发" ---------------- */
section('⑦ 真没发过的别误判成已发');
{
  const m = progress.matchDone('第29章 垄断方的断供与打压', undefined, book);
  eq('第29章 → 没发过', m.done, false);
  const m2 = progress.matchDone('第28章 创立星轨工坊', undefined, book);
  eq('第28章 → 没发过', m2.done, false);
  const m3 = progress.matchDone('第22章 xxx', 22, { chapters: {} });
  eq('空账本 → 什么都没发过', m3.done, false);
}

/* ---------------- 8. 同序号两条记录：已发的更权威 ---------------- */
section('⑧ 同一序号有两条记录（改名 + 一条失败）→ 已发的赢');
{
  const weird = {
    chapters: {
      '第30章 断供那就吃你的运输车': { status: 'published', chapterNo: 30, at: 'x' },
      '第30章 断供那就吃你的运输车（改名后重试失败）': { status: 'failed', reason: 'x', chapterNo: 30, at: 'y' },
    },
  };
  const idx = progress.indexByNo(weird);
  eq('序号 30 保留的是已发布那条', idx[30].status, 'published');
  ok('  是已发布的那条赢', progress.isDoneRecord(idx[30]));
  eq('靠序号 30 判定 → 算已发（哪怕标题完全对不上）', progress.isDone('第30章 随便什么标题', undefined, weird), true);
  eq('  这一份假账本之外的章节仍然不算已发', progress.isDone('第31章 别的', undefined, weird), false);
}

/* ---------------- 9. 序号集合概览 ---------------- */
section('⑨ 已发序号集合（summary 用的就是这套算法）');
{
  const s = (() => {
    const idx = progress.indexByNo(book);
    const nos = Object.keys(idx)
      .map(Number)
      .filter((n) => progress.isDoneRecord(idx[n]))
      .sort((a, b) => a - b);
    return { count: nos.length, nos };
  })();
  // 17,21,22,23,25,26,27 已发/草稿；24 是 failed 不算
  eq('已处理的章节数 = 7', s.count, 7);
  eq('序号集合正确', s.nos.join(','), '17,21,22,23,25,26,27');
  ok('失败的第24章不在里面', !s.nos.includes(24));
}

/* ---------------- 10. 真实账本（有就测真的；没有就造一本临时的） ---------------- */
section('⑩ 真实账本（books\\<当前小说>\\progress.json）');
{
  const fsMod = require('fs');
  const osMod = require('os');
  const books = require(path.join(__dirname, '..', 'src', 'books.js'));

  let book = null;
  let usingTemp = false;
  let tmpBase = null;

  try {
    book = books.resolveBook(null);
  } catch (_) {}

  if (!book) {
    // ★★ 这里以前直接判"失败"—— 但别人刚 clone 下来时 books/ 是空的（.gitignore 排除了），
    //    结果**新用户跑仓库自带的测试，第一条就红**，以为项目是坏的。
    //    意图本来就是"找不到则跳过"，实现却写反了。
    //    现在改成：自己造一本带已知账本的临时书，把同一套断言跑一遍 ——
    //    测试在任何机器上（有没有发过小说）都能自洽。
    usingTemp = true;
    tmpBase = fsMod.mkdtempSync(path.join(osMod.tmpdir(), 'nap-ledger-'));
    book = books.createBook('账本测试书', {}, tmpBase);
    fsMod.writeFileSync(
      book.progressPath,
      JSON.stringify({
        chapters: {
          '第1章 开端': { status: 'published', chapterNo: 1, verified: true, at: '2026/1/1 10:00:00' },
          '第2章 转折': { status: 'published', chapterNo: 2, verified: true, at: '2026/1/1 10:05:00' },
        },
        lastRun: '2026-01-01T02:00:00.000Z',
      }),
      'utf8'
    );
    console.log('  （books\\ 下还没有小说 —— 用一本临时书代替，测的是同一套东西）');
  }

  const label = usingTemp ? '临时账本' : '真实账本';
  progress.setFile(book.progressPath);
  const real = progress.load();
  const n = Object.keys(real.chapters || {}).length;
  ok(`${label} ${book.progressPath} 有 ${n} 条记录且能解析`, n > 0);

  // ★ 不写死章节号 —— 用户每发一章就会过期。改成从账本里现推。
  const doneNos = Object.entries(real.chapters || {})
    .filter(([, r]) => progress.isDoneRecord(r))
    .map(([t, r]) => progress.recordNo(t, r))
    .filter((x) => x > 0)
    .sort((a, b) => a - b);
  const lastDone = doneNos[doneNos.length - 1];
  ok(`账本里已发的最大序号是 ${lastDone}`, !!lastDone);
  ok(
    `按序号仍认得出第${lastDone}章（哪怕标题被改）`,
    progress.matchDone(`第${lastDone}章 一个被改过的标题`, lastDone).done === true
  );

  // 改名兜底通道：把一条已发记录的标题截短，模拟"平台上的标题被人改过"
  const pick = Object.keys(real.chapters || {}).find((t) => progress.isDoneRecord(real.chapters[t]));
  if (pick) {
    const no = progress.recordNo(pick, real.chapters[pick]);
    const mangled = String(pick).slice(0, Math.max(6, String(pick).length - 2));
    const m = progress.matchDone(mangled, no);
    ok(`标题被截短成「${mangled}」后仍认得出`, m.done === true);
    eq('  依据是 number（不是靠标题）', m.how, 'number');
  }

  ok('账本路径确实指向 books\\ 里面（不是老的 data\\progress.json）', book.progressPath.includes('books'));

  if (usingTemp) {
    try {
      fsMod.rmSync(tmpBase, { recursive: true, force: true });
    } catch (_) {}
  }
}

console.log(`\n————————————\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
