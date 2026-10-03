/**
 * 小说源文件「格式规范」校验
 *
 * 目的：在拆分/发布之前，把 novel.txt 的格式问题一次性全查出来，
 * 并且给出「哪一行、错在哪、怎么改」这种能直接照着改的结论。
 *
 * 校验顺序：文件 → 编码 → 行尾 → 章节标题行 → 逐章字数/标题 → 结构 → 结论
 */
const fs = require('fs');
const path = require('path');

const { ROOT, resolvePath, countChars, stripChapterPrefix, createLogger } = require('./util');
const { planChapters } = require('./split');

const R = { ok: '[OK]  ', warn: '[WARN]', fail: '[FAIL]', info: '[--]  ', fix: '[FIX] ' };

/* ------------------------- 编码识别 ------------------------- */

/**
 * 把文件字节流解码成文本，并判断原本是什么编码。
 *
 * 判断依据（对中文文本很可靠）：
 *   - 有 BOM 就直接按 BOM 走
 *   - 按 UTF-8 解，出现大量 U+FFFD（替换字符）= 不是 UTF-8
 *   - 零字节占比高 = UTF-16
 *   - 上面都没命中但 UTF-8 解失败，就试 GBK
 */
function decodeSource(buf) {
  if (!buf.length) return { text: '', encoding: 'empty', hadBom: false };

  // UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.slice(3).toString('utf8'), encoding: 'utf-8', hadBom: true };
  }
  // UTF-16 LE BOM
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.slice(2).toString('utf16le'), encoding: 'utf-16le', hadBom: true };
  }
  // UTF-16 BE BOM
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.slice(2));
    swapped.swap16();
    return { text: swapped.toString('utf16le'), encoding: 'utf-16be', hadBom: true };
  }

  // 零字节很多 → 大概率是没带 BOM 的 UTF-16
  let zeros = 0;
  for (let i = 0; i < Math.min(buf.length, 4096); i++) if (buf[i] === 0) zeros++;
  if (zeros > Math.min(buf.length, 4096) * 0.1) {
    return { text: buf.toString('utf16le'), encoding: 'utf-16?', hadBom: false, uncertain: true };
  }

  // 先按 UTF-8 解
  const asUtf8 = buf.toString('utf8');
  const badUtf8 = (asUtf8.match(/\uFFFD/g) || []).length;
  if (badUtf8 === 0) {
    return { text: asUtf8, encoding: 'utf-8', hadBom: false };
  }

  // 再按 GBK 解（Node 自带全量 ICU，支持 gbk）
  try {
    const asGbk = new TextDecoder('gbk').decode(buf);
    const badGbk = (asGbk.match(/\uFFFD/g) || []).length;
    if (badGbk < badUtf8) {
      return { text: asGbk, encoding: 'gbk', hadBom: false, brokenUtf8: true, badChars: badUtf8 };
    }
  } catch (_) {
    /* 环境不支持 gbk 就跳过 */
  }

  return { text: asUtf8, encoding: '未知', hadBom: false, broken: true, badChars: badUtf8 };
}

/** 换行符统计 */
function detectEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const cr = (text.match(/\r/g) || []).length - crlf;
  const lf = (text.match(/\n/g) || []).length - crlf;
  let kind = '混合';
  if (crlf && !lf && !cr) kind = 'CRLF（Windows）';
  else if (lf && !crlf && !cr) kind = 'LF（Unix/macOS）';
  else if (cr && !crlf && !lf) kind = 'CR（老 Mac）';
  else if (!crlf && !cr && !lf) kind = '无换行（单行文件）';
  return { crlf, lf, cr, kind };
}

/* ------------------------- 疑似标题但没认出来 ------------------------- */

const SUSPECT_RULES = [
  {
    re: /^\s*第\s*[0-9０-９零〇一二三四五六七八九十百千万两]{1,8}\s*[章节回]/,
    tooLong: true,
    why: '这一行太长（超过 60 字），标题行不能超过 60 字',
  },
  {
    re: /^\s*(chapter|chap\.?)\s*[0-9]/i,
    maxLen: 40,
    why: '英文「Chapter N」写法认不出来，请改成「第N章 标题」',
  },
  {
    re: /^\s*第\s*[0-9０-９零〇一二三四五六七八九十百千万两]{1,8}\s*[篇部集]/,
    maxLen: 40,
    why: '只认「章 / 节 / 回」，不认「篇 / 部 / 集」（「卷」是单独认的，见下面的分卷说明）',
  },
  {
    // "1、" "1," "1:" 这类；点号排除 "1.5" 这种小数
    re: /^\s*[0-9]{1,4}\s*(?:[、,，:：]|[.．](?![0-9]))/,
    maxLen: 20,
    why: '纯数字编号（如「1、」）认不出来，请改成「第1章 标题」',
  },
  {
    re: /^\s*[（(【\[]\s*[0-9一二三四五六七八九十百千两]{1,6}\s*[）)】\]]/,
    maxLen: 20,
    why: '「（一）」这种编号认不出来，请改成「第一章 标题」',
  },
  {
    re: /^\s*[一二三四五六七八九十百千两]{1,6}\s*[、.．]/,
    maxLen: 20,
    why: '「一、」这种编号认不出来，请改成「第一章 标题」',
  },
];

/** 含句末/分句标点的，基本可以断定是正文而不是标题 */
const SENTENCE_PUNCT = /[。！？；…]/;

/**
 * 找"看着像章节标题、但没被规则认出来"的行。
 *
 * 有意做成保守策略，宁漏报不误报：
 *   - 只挑"孤立行"——上一行和下一行都是空行（标题的典型形态）
 *   - 按规则各自限制长度，并且整行不能含句末标点
 * 结果只是"提示"，用户看到明显是正文的行可以忽略。
 */
function findSuspiciousTitleLines(lines, matchedLineSet) {
  const out = [];
  const isBlank = (i) => i < 0 || i >= lines.length || lines[i].trim() === '';
  lines.forEach((raw, i) => {
    if (matchedLineSet.has(i)) return;
    const t = raw.trim();
    if (!t) return;

    for (const rule of SUSPECT_RULES) {
      if (!rule.re.test(t)) continue;
      if (rule.tooLong) {
        if (t.length <= 60) continue;
      } else {
        if (t.length > (rule.maxLen || 40)) continue;
        if (SENTENCE_PUNCT.test(t)) continue; // 像正文
      }
      // 孤立行：前后都必须是空行
      if (!isBlank(i - 1) || !isBlank(i + 1)) continue;
      out.push({ line: i + 1, text: t.slice(0, 40), why: rule.why });
      break;
    }
  });
  return out;
}

/* ------------------------- 主校验 ------------------------- */

/**
 * @param {object} cfg     完整配置
 * @param {object} opts
 *   - fix: 是否顺手把编码转成 UTF-8（会先备份原文件）
 */
function lintNovel(cfg, opts = {}) {
  const lines = [];
  const push = (tag, msg) => lines.push(`${R[tag]} ${msg}`);
  let fatal = 0;
  let warns = 0;
  const fixes = [];

  const srcName = cfg.novel.sourceFile || 'novel.txt';
  const srcPath = resolvePath(srcName);

  push('info', '===== 小说文件格式校验 =====');
  lines.push('');
  // 多书改造后文件在 books\<书名>\ 下，不再是"项目根目录"了 —— 这里显示真实相对路径
  const shownPath = (() => {
    const r = path.relative(ROOT, srcPath);
    return r && !r.startsWith('..') ? r : srcPath;
  })();
  push('info', `目标文件：${shownPath}`);

  /* ---------- 1. 文件存在 ---------- */
  if (!fs.existsSync(srcPath)) {
    push('fail', `找不到 ${srcName}`);
    push('info', `      应该放在：${srcPath}`);
    fatal++;
    lines.push('');
    push('fail', `发现 ${fatal} 个必须解决的问题`);
    const text = lines.join('\n');
    console.log(text);
    return { fatal, warns, text, chapters: [], fixes };
  }
  const buf = fs.readFileSync(srcPath);
  const sizeKb = (buf.length / 1024).toFixed(1);
  push('ok', `文件存在（${sizeKb} KB）`);

  /* ---------- 2. 编码 ---------- */
  const dec = decodeSource(buf);
  if (dec.encoding === 'utf-8' && !dec.hadBom) {
    push('ok', '编码：UTF-8（无 BOM）—— 最理想');
  } else if (dec.encoding === 'utf-8' && dec.hadBom) {
    push('warn', '编码：UTF-8 带 BOM —— 能用（脚本会自动去掉 BOM），但不推荐');
    warns++;
  } else if (dec.encoding === 'gbk') {
    push('fail', `编码：GBK / GB18030 —— 脚本会按 UTF-8 读，中文会全变成乱码`);
    push('info', '      修复：用记事本打开 →「另存为」→ 编码选「UTF-8」');
    push('info', `      或者双击「9-检查小说格式.bat」加参数自动转换（会先备份原文件）`);
    fatal++;
  } else if (dec.encoding.startsWith('utf-16')) {
    push('fail', `编码：${dec.encoding} —— 请另存为 UTF-8`);
    fatal++;
  } else {
    push('fail', `编码识别不出来，可能有二进制内容或编码损坏（异常字符 ${dec.badChars || 0} 个）`);
    fatal++;
  }

  /* ---------- 3. 行尾 ---------- */
  const eol = detectEol(dec.text);
  if (eol.kind.includes('无换行')) {
    push('fail', '整个文件只有一行 —— 章节标题必须各自独占一行');
    fatal++;
  } else if (eol.kind === '混合') {
    push('warn', `换行符混合（CRLF ${eol.crlf} 处 / LF ${eol.lf} 处）—— 能跑，但建议统一`);
    warns++;
  } else {
    push('ok', `换行符：${eol.kind}`);
  }

  /* ---------- 4. 总量 ---------- */
  const totalChars = countChars(dec.text);
  const totalLines = dec.text.replace(/\r\n/g, '\n').split('\n').length;
  push('ok', `总字数：${totalChars} 字（${totalLines} 行）`);

  /* ---------- 5. 章节识别（用真实的拆分逻辑，保证结论一致） ---------- */
  lines.push('');
  push('info', '----- 章节标题识别 -----');

  let plan;
  try {
    plan = planChapters(dec.text.replace(/^\uFEFF/, ''), cfg.novel);
  } catch (e) {
    push('fail', '章节识别失败：' + String(e.message).split('\n')[0]);
    fatal++;
    lines.push('');
    const text = lines.join('\n');
    console.log(text);
    return { fatal, warns, text, chapters: [], fixes };
  }

  const { chapters, marks, volumes, rejected } = plan;
  push('info', `识别规则：${cfg.novel.chapterRegex}`);

  if (!marks.length) {
    push('fail', '一个章节标题都没认出来 —— 会退化成"按字数自动切"，切出来的章名是「第1部分」这种假的');
    push('info', '      检查标题是不是写成了「第1章 xxx」或「第一章 xxx」这种形式');
    fatal++;
  } else {
    push('ok', `识别到 ${marks.length} 个标题行，切出 ${chapters.length} 章`);
    if (!chapters.length) {
      push('fail', `标题认出来了，但切出来 0 章 —— 每一块正文都短于 minChapterChars(${cfg.novel.minChapterChars})，会被全部丢弃`);
      push('info', '      这种情况拆分阶段会直接报错退出，先按下面的提示处理');
      fatal++;
    }
  }

  // 拆分的告警原样转发
  for (const n of plan.notes) push(n.level, '      ' + n.msg);

  // 命中了标题正则、但被判定成"其实是一句话"的行
  if (rejected && rejected.length) {
    lines.push('');
    push('warn', `有 ${rejected.length} 行"长得像章节标题、但被判定成正文"，会被并进上一章：`);
    for (const r of rejected.slice(0, 8)) {
      push('info', `      第 ${r.line} 行：「${String(r.text).slice(0, 40)}」`);
      push('info', `        原因：${r.why}`);
    }
    if (rejected.length > 8) push('info', `      … 还有 ${rejected.length - 8} 行`);
    push('info', '      如果这确实是你想要的分章标题：把它缩短，并在「章」后面加一个空格');
    warns += rejected.length;
  }

  // 疑似标题漏网
  const matchedLineSet = new Set([
    ...marks.map((m) => m.line),
    ...(volumes || []).map((v) => v.line), // 卷标题行是认出来的，不该再被当成"漏网标题"
  ]);
  const normLines = dec.text.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '').split('\n');
  const suspects = findSuspiciousTitleLines(normLines, matchedLineSet);
  if (suspects.length) {
    lines.push('');
    push('warn', `有 ${suspects.length} 行"看着像章节标题但没认出来"，它们会混进上一章的正文里：`);
    for (const s of suspects.slice(0, 10)) {
      push('info', `      第 ${s.line} 行：「${s.text}」`);
      push('info', `        原因：${s.why}`);
    }
    if (suspects.length > 10) push('info', `      … 还有 ${suspects.length - 10} 行`);
    push('info', '      这只是猜测：如果这些其实是你正文里的句子，忽略即可，不影响发布');
    warns += suspects.length;
  }

  // 第一个标题之前有内容
  const firstTitleLine = marks.length ? marks[0].line : normLines.length;
  const preface = normLines
    .slice(0, firstTitleLine)
    .join('\n')
    .trim();
  if (preface && countChars(preface) > 0) {
    lines.push('');
    push('warn', `第 1 个章节标题之前有 ${countChars(preface)} 字内容（前言/引子？）—— 这部分会被整段丢掉`);
    push('info', '      想保留就把它们放进第一章，或在前面加一行「序章 xxx」');
    warns++;
  }

  /* ---------- 5.5 分卷 ---------- */
  lines.push('');
  if ((volumes || []).length) {
    push('info', '----- 分卷 -----');
    push('ok', `识别到 ${volumes.length} 个卷标题行（它们本身不是章节，不会占正文字数）`);
    for (const v of volumes) {
      const inVol = chapters.filter((c) => c.volume === v.text);
      const range = inVol.length
        ? `第 ${inVol[0].seq} ~ ${inVol[inVol.length - 1].seq} 章（${inVol.length} 章）`
        : '（后面没有章节）';
      push('info', `      第 ${v.line + 1} 行「${v.text}」→ ${range}`);
    }
    const noVol = chapters.filter((c) => !c.volume);
    if (noVol.length) {
      push('warn', `有 ${noVol.length} 章不在任何卷里（第 ${noVol.map((c) => c.seq).join('、')} 章），发布会沿用网页上当前的卷`);
      warns++;
    }
    push('info', '      发布时脚本会自动把章节的「分卷」切到对应的卷上');
    push('info', '      前提：这些卷要已经在番茄后台建好了（章节管理页 →「编辑分卷」）');
    if (cfg.novel.fillVolume === false) {
      push('warn', '      但 config.json 里 novel.fillVolume = false，实际发布时不会去切卷');
      warns++;
    }
  } else {
    push('info', '----- 分卷 -----');
    push('info', '没有识别到卷标题行 —— 所有章节发布会沿用网页上当前选中的卷');
    push('info', '      想分卷：在小说里单独占一行写「第二卷：云隐谷」，前后留空行（或紧贴在章节标题的上一行）');
  }

  /* ---------- 6. 逐章校验 ---------- */
  const minPublish = (cfg.safety && cfg.safety.minCharsForPublish) || 1000;
  const maxPer = (cfg.safety && cfg.safety.maxCharsPerChapter) || 30000;
  const minBlock = cfg.novel.minChapterChars || 0;

  let tooShort = 0;
  let tooLong = 0;
  let titleBad = 0;
  const problems = [];

  for (const c of chapters) {
    const n = countChars(c.body);
    const pure = cfg.novel.stripChapterPrefix === false ? c.title : stripChapterPrefix(c.title);
    const pureLen = countChars(pure);

    if (n === 0) {
      problems.push(`第 ${c.seq} 章「${c.title}」正文是空的`);
      titleBad++;
      continue;
    }
    if (n < minBlock) {
      problems.push(`第 ${c.seq} 章「${c.title}」只有 ${n} 字，低于 minChapterChars(${minBlock})，拆分时会被直接丢弃`);
      tooShort++;
      continue;
    }
    if (n < minPublish) {
      problems.push(`第 ${c.seq} 章「${c.title}」只有 ${n} 字，不足发布门槛 ${minPublish} 字 → 发布时会被跳过`);
      tooShort++;
    }
    if (n > maxPer) {
      problems.push(`第 ${c.seq} 章「${c.title}」有 ${n} 字，超过 ${maxPer} 字上限 → 发布时会被跳过`);
      tooLong++;
    }
    if (!pure) {
      problems.push(`第 ${c.seq} 章标题「${c.title}」剥掉"第X章"后是空的 → 番茄的标题框会是空的，发布会失败`);
      titleBad++;
    } else if (pureLen > 30) {
      problems.push(`第 ${c.seq} 章标题「${pure}」有 ${pureLen} 字，超过番茄 30 字上限 → 发布会失败`);
      titleBad++;
    }
  }

  // 标题重复
  const seen = new Map();
  for (const c of chapters) {
    const pure = cfg.novel.stripChapterPrefix === false ? c.title : stripChapterPrefix(c.title);
    if (!pure) continue;
    seen.set(pure, (seen.get(pure) || 0) + 1);
  }
  const dup = [...seen.entries()].filter(([, n]) => n > 1);

  if (chapters.length) {
    lines.push('');
    push('info', `----- 逐章校验（当前模式：${cfg.publish.mode === 'draft' ? '只存草稿' : '直接发布'}）-----`);
    if (!problems.length) {
      push('ok', `全部 ${chapters.length} 章都合规，可以直接发布`);
    } else {
      for (const p of problems) push('warn', p);
      warns += problems.length;
    }
    if (dup.length) {
      push('warn', `有 ${dup.length} 个标题重复：${dup.map(([t, n]) => `「${t}」×${n}`).join('、')}`);
      warns++;
    }

    // 概览表
    lines.push('');
    push('info', '----- 章节概览 -----');
    const show = chapters.slice(0, 20);
    for (const c of show) {
      const n = countChars(c.body);
      const pure = cfg.novel.stripChapterPrefix === false ? c.title : stripChapterPrefix(c.title);
      const flag = n < minPublish ? '  ← 字数不够' : n > maxPer ? '  ← 太长' : '';
      const vol = c.volume ? `  「${c.volume}」` : '';
      push('info', `第${String(c.seq).padStart(3, ' ')}章  ${pure.padEnd(20, ' ')} ${String(n).padStart(6, ' ')}字${vol}${flag}`);
    }
    if (chapters.length > show.length) push('info', `      … 还有 ${chapters.length - show.length} 章`);
  }

  /* ---------- 7. 结构提示 ---------- */
  if (chapters.length) {
    lines.push('');
    push('info', '----- 提示 -----');
    push('info', '章节序号不用你管：脚本会读后台已有章节数，自动接着编号');
    const perRun = Number(cfg.publish.maxPerRun);
    const dailyLimit = Number(cfg.publish.dailyCharLimit);
    if (perRun > 0) {
      push('info', `本次点一下最多发 ${perRun} 章（publish.maxPerRun）`);
    } else if (dailyLimit > 0) {
      push('info', `本次点一下会一直发，直到当天的 ${dailyLimit} 字额度放不下下一章（publish.dailyCharLimit）`);
    } else {
      push('info', '本次点一下会把还没发的章节全部发完（maxPerRun 和 dailyCharLimit 都是 0）');
    }
    const publishable = chapters.filter((c) => {
      const n = countChars(c.body);
      return n >= minPublish && n <= maxPer;
    }).length;
    push('info', `按当前规则，一共 ${publishable} / ${chapters.length} 章是"可发布"的状态`);
  }

  /* ---------- 8. 结论 ---------- */
  lines.push('');
  push('info', '----- 结论 -----');
  if (fatal > 0) {
    push('fail', `发现 ${fatal} 个必须解决的问题 —— 先按上面的建议改，再发布`);
  } else if (warns > 0) {
    push('warn', `${warns} 处需要注意（见上面 WARN）—— 能被跳过的问题会自动跳过，不会中断整个流程`);
    const bits = [];
    if (tooShort) bits.push(`${tooShort} 章字数不足（会被跳过）`);
    if (tooLong) bits.push(`${tooLong} 章太长（会被跳过）`);
    if (titleBad) bits.push(`${titleBad} 章标题有问题（发布会失败）`);
    if (bits.length) push('info', '      具体：' + bits.join('，'));
  } else {
    push('ok', '格式完全合规，可以直接发布');
  }

  /* ---------- 9. 编码修复（--fix） ---------- */
  const needFix = (dec.encoding !== 'utf-8' || dec.hadBom) && !dec.broken;
  if (opts.fix) {
    lines.push('');
    if (!needFix) {
      push('fix', '编码已经是 UTF-8 无 BOM，不需要转换');
    } else {
      const f = fixEncoding(cfg, dec.text);
      if (f.ok) {
        push('fix', f.msg);
        fixes.push({ backup: f.backup });
        push('fix', '编码已修好 —— 建议再跑一次校验，确认剩下的是内容问题还是格式问题');
      } else {
        push('fail', f.msg);
      }
    }
  } else if (needFix) {
    lines.push('');
    push('info', '想自动转成 UTF-8？在本窗口按提示输入 y 即可（会先备份原文件）。');
  }

  lines.push('');
  const text = lines.join('\n');
  if (!opts.quiet) console.log(text);

  return {
    fatal,
    warns,
    text,
    chapters,
    fixes,
    /** 是否建议做编码转换（cli 会据此询问用户） */
    encodingFixNeeded: needFix,
    encoding: dec.encoding,
    /** 已按正确编码解码出来的全文，转换时直接用这个，避免重复解码 */
    decodedText: dec.text,
  };
}

/**
 * 把源文件转成 UTF-8 无 BOM。会先把原文件复制成带时间戳的 .backup-*.txt。
 */
function fixEncoding(cfg, decodedText) {
  const srcPath = resolvePath(cfg.novel.sourceFile);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backup = `${srcPath.replace(/\.txt$/i, '')}.backup-${stamp}.txt`;
  try {
    fs.copyFileSync(srcPath, backup);
    fs.writeFileSync(srcPath, decodedText, 'utf8');
    return {
      ok: true,
      backup,
      msg: `已把编码转成 UTF-8 无 BOM（原文件已备份为 ${path.basename(backup)}）`,
    };
  } catch (e) {
    return { ok: false, msg: '转换失败：' + String(e.message).split('\n')[0] };
  }
}

module.exports = { lintNovel, fixEncoding, decodeSource, detectEol };
