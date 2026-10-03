/**
 * 章节拆分：把一个 txt 变成 chapters/ 下的一章一个文件 + manifest.json
 */
const fs = require('fs');
const path = require('path');
const {
  ROOT,
  resolvePath,
  ensureDir,
  safeFileName,
  normalizeBody,
  countChars,
  createLogger,
} = require('./util');
const { looksLikeVolumeHead, DEFAULT_VOLUME_REGEX } = require('./volume');

/** 「第X章」这部分的匹配（不含后面分隔符） */
const CHAPTER_HEAD_RE = /^\s*第\s*[0-9０-９零〇一二三四五六七八九十百千万两]{1,8}\s*[章节回]/;
/** 「第X章」+ 至少一个分隔符 */
const CHAPTER_HEAD_SEP_RE =
  /^\s*第\s*[0-9０-９零〇一二三四五六七八九十百千万两]{1,8}\s*[章节回][\s:：、.．·-]/;

/**
 * 判断"匹配了标题正则、但其实是一句正文"的行。
 *
 * 例：「第一章的正文从这一行开始。」——正则会把「的正文从这一行开始。」当成标题，
 * 但人一眼就知道这是句子，不是章节名。真实小说里这种段落会让正文被切碎。
 *
 * 判据（命中任一条就当作正文）：
 *   1. 以「。」结尾且不止几个字 —— 章节名不会用句号收尾
 *   2. 中间出现 。！？； —— 章节名一般不用这些标点
 *   3. 「章」后面没有任何分隔符，而且这一行很长 —— 正常写法是「第一章 标题」
 *
 * 注意：逗号、顿号、结尾的问号/感叹号都**不算**证据，
 * 因为「第五章 我是谁？」「第一章 别过来！」这类标题是合法的。
 */
function proseInsteadOfTitle(line) {
  const after = line.replace(CHAPTER_HEAD_RE, '');
  const n = countChars(after);
  if (n === 0) return false; // 「第一章」这种保留

  if (/。$/.test(after) && n > 6) return '以句号结尾，像是一句话而不是章节名';
  if (n > 6 && /[。！？；]/.test(after.slice(0, -1))) {
    return '章节名里出现了句末标点，像是一句话而不是章节名';
  }
  if (!CHAPTER_HEAD_SEP_RE.test(line) && n > 12) {
    return '「章」后面既没有空格也没有标点，而且这一行很长，像是正文';
  }
  return false;
}

/**
 * 逐行扫描，找出所有"章节标题行"
 *
 * 返回：
 *   - marks：认定的标题行
 *   - rejected：匹配了正则、但被判定成正文的行（留给校验脚本提示用户）
 */
function detectChapterMarks(text, chapterRegex) {
  let re;
  try {
    re = new RegExp(chapterRegex);
  } catch (e) {
    throw new Error(`config.json 里的 chapterRegex 不是合法正则：${e.message}`);
  }

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const marks = [];
  const rejected = [];
  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (!t || t.length > 60) return;
    re.lastIndex = 0;
    if (!re.test(t)) return;

    const why = proseInsteadOfTitle(t);
    if (why) rejected.push({ line: i + 1, text: t, why });
    else marks.push({ line: i, title: t });
  });
  return { lines, marks, rejected };
}

/**
 * 逐行扫描，找出所有"卷标题行"（如「第二卷：云隐谷」）。
 *
 * 卷标题行是**独立的一行**，作用是给它后面的章节打上"属于哪一卷"的标记。
 * 它本身不是章节，也不会被算进正文字数。
 *
 * "独立"的判定：前后**至少一侧**是空行，或者紧邻的是一个章节标题行。
 * 这样「第一卷的内容讲的是男主角的往事」这种夹在正文里的句子就不会被误认。
 *
 * @param {string[]} lines
 * @param {string} [volumeRegex]
 * @param {{chapterLines?:Set<number>}} [opts] chapterLines = 章节标题行的行号集合（0 起算）
 */
function detectVolumeMarks(lines, volumeRegex, opts = {}) {
  const re = volumeRegex || DEFAULT_VOLUME_REGEX;
  const chapterLines = opts.chapterLines || null;
  const isBlank = (i) => i < 0 || i >= lines.length || String(lines[i]).trim() === '';

  const marks = [];
  lines.forEach((raw, i) => {
    const v = looksLikeVolumeHead(raw, re);
    if (!v) return;

    const prevSolo = isBlank(i - 1);
    const nextSolo = isBlank(i + 1) || (chapterLines ? chapterLines.has(i + 1) : false);
    if (!prevSolo && !nextSolo) return; // 夹在正文中间 → 大概率是句子

    marks.push({ line: i, ...v });
  });
  return marks;
}

/**
 * 没有识别到任何标题时的兜底：按空行分段 + 字数上限切章
 */
function splitByLength(text, maxChars) {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chapters = [];
  let buf = [];
  let len = 0;
  for (const p of paras) {
    buf.push(p);
    len += countChars(p);
    if (len >= maxChars) {
      chapters.push(buf.join('\n\n'));
      buf = [];
      len = 0;
    }
  }
  if (buf.length) chapters.push(buf.join('\n\n'));
  return chapters.map((body, i) => ({ title: `第${i + 1}部分`, body }));
}

/**
 * 纯函数：把整本书的文本切成章节（不落盘）。
 *
 * splitNovel（真实拆分）和 lint（格式校验）共用这一个函数，
 * 这样"校验说的结果"和"实际拆出来的结果"永远不会打架。
 *
 * @returns {{ chapters: Array, marks: Array, notes: Array<{level:string,msg:string}> }}
 */
function planChapters(text, novelCfg) {
  const notes = [];
  const { lines, marks, rejected } = detectChapterMarks(text, novelCfg.chapterRegex);

  // 卷标题行（如「第二卷：云隐谷」）—— 只用来分组，不是章节
  const volumes = detectVolumeMarks(lines, novelCfg.volumeRegex, {
    chapterLines: new Set(marks.map((m) => m.line)),
  });

  let chapters = [];

  if (marks.length === 0) {
    notes.push({ level: 'warn', msg: '没有识别到任何章节标题，会改用「按字数自动切分」兜底' });
    notes.push({ level: 'warn', msg: '想按自己的标题切，请调整 config.json 的 novel.chapterRegex' });
    chapters = splitByLength(text, 2000).map((c, i) => ({
      seq: i + 1,
      title: c.title,
      body: c.body,
      volume: '',
    }));
    return { chapters, marks, volumes, rejected, notes };
  }

  if (volumes.length) {
    notes.push({
      level: 'info',
      msg: `识别到 ${volumes.length} 个卷标题行：${volumes.map((v) => v.text).join('、')}`,
    });
  }

  // 卷标题行本身不能算进正文，切章节正文时要把这些行剔掉
  const volumeLines = new Set(volumes.map((v) => v.line));
  let volIdx = -1;
  let currentVolume = '';

  marks.forEach((m, k) => {
    // 把"这一章标题行之前"的所有卷标记都吃掉，最后一个就是它所属的卷
    while (volIdx + 1 < volumes.length && volumes[volIdx + 1].line < m.line) {
      volIdx++;
      currentVolume = volumes[volIdx].text;
    }

    const start = m.line + 1;
    const end = k + 1 < marks.length ? marks[k + 1].line : lines.length;
    const bodyLines = [];
    for (let i = start; i < end; i++) {
      if (volumeLines.has(i)) continue; // 卷标题行不进正文
      bodyLines.push(lines[i]);
    }
    const body = normalizeBody(bodyLines.join('\n'));

    chapters.push({
      seq: k + 1,
      title: m.title,
      body,
      volume: currentVolume, // 空字符串 = 这一章不属于任何卷
      titleLine: m.line + 1, // 1 起算的行号，方便报错时定位
    });
  });

  // 丢掉空壳 / 太短的（通常是误识别出来的假标题）
  // 注意：「第二卷：云隐谷」这类卷标题行由 detectVolumeMarks 单独认掉了，
  // 根本不会走到这里，所以不用担心卷名被当成章节丢掉。
  const minChars = novelCfg.minChapterChars || 0;
  const dropped = chapters.filter((c) => countChars(c.body) < minChars);
  chapters = chapters.filter((c) => countChars(c.body) >= minChars);
  if (dropped.length) {
    notes.push({
      level: 'warn',
      msg: `已丢弃 ${dropped.length} 个过短的疑似误识别块（阈值 novel.minChapterChars = ${minChars}）`,
    });
    for (const d of dropped.slice(0, 5)) {
      notes.push({
        level: 'info',
        msg: `  丢弃：第 ${d.titleLine} 行「${d.title}」（正文仅 ${countChars(d.body)} 字）`,
      });
    }
  }
  // 重新编号
  chapters.forEach((c, i) => (c.seq = i + 1));

  return { chapters, marks, volumes, rejected, notes };
}

/**
 * ★ 多书支持：拆分输出目录**不是**写死的 —— 由 books.activate() 指到
 * books/<书名>/chapters/。否则两本书的拆分结果会互相覆盖。
 * 默认值只为兼容"没走 books/ 的老调用"。
 */
let CHAPTERS_DIR = path.join(ROOT, 'chapters');

function setChaptersDir(p) {
  CHAPTERS_DIR = p;
}
function getChaptersDir() {
  return CHAPTERS_DIR;
}

/**
 * 主函数：拆分并落盘
 */
function splitNovel(cfg, logger = createLogger()) {
  const novelCfg = cfg.novel;
  const srcPath = resolvePath(novelCfg.sourceFile);
  if (!fs.existsSync(srcPath)) {
    throw new Error(`找不到小说源文件：${srcPath}\n请把你的小说全文保存成这个文件（或修改 config.json 里的 novel.sourceFile）`);
  }

  const raw = fs.readFileSync(srcPath, novelCfg.encoding || 'utf8');
  const text = raw.replace(/^\uFEFF/, ''); // 去掉 BOM
  logger.info(`读取源文件：${srcPath}（${countChars(text)} 字）`);

  const { chapters, marks, notes } = planChapters(text, novelCfg);
  logger.info(`识别到 ${marks.length} 个章节标题`);
  for (const n of notes) {
    if (n.level === 'warn') logger.warn(n.msg);
    else logger.info(n.msg);
  }
  if (!chapters.length) {
    throw new Error('拆分结果为空。请检查源文件内容，或调整 config.json 的 novel.chapterRegex');
  }

  // 落盘
  const outDir = ensureDir(CHAPTERS_DIR);
  // 清掉上一轮的旧章节文件（只删自己生成的 .txt，避免误删别的东西）
  for (const f of fs.readdirSync(outDir)) {
    if (/^\d{4}-.*\.txt$/.test(f)) {
      try {
        fs.unlinkSync(path.join(outDir, f));
      } catch (_) {}
    }
  }

  const manifest = [];
  for (const c of chapters) {
    const base = `${String(c.seq).padStart(4, '0')}-${safeFileName(c.title)}`;
    const fileName = `${base}.txt`;
    const bodyPath = path.join(outDir, fileName);
    fs.writeFileSync(bodyPath, c.body, 'utf8');

    const chars = countChars(c.body);
    if (chars > (novelCfg.warnChapterChars || 15000)) {
      logger.warn(`第 ${c.seq} 章「${c.title}」有 ${chars} 字，超过阈值，平台可能限制单章字数`);
    }

    manifest.push({
      seq: c.seq,
      title: c.title,
      file: fileName,
      chars,
      // 卷（分卷）归属，空字符串 = 这一章不属于任何卷，发布时不动页面上默认的卷
      volume: c.volume || '',
    });
  }

  fs.writeFileSync(
    path.join(outDir, 'manifest.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: path.basename(srcPath),
        count: manifest.length,
        volumes: [...new Set(manifest.map((m) => m.volume).filter(Boolean))],
        chapters: manifest,
      },
      null,
      2
    ),
    'utf8'
  );

  logger.ok(`拆分完成：共 ${manifest.length} 章，输出目录 ${path.relative(ROOT, outDir) || outDir}`);
  const preview = manifest.slice(0, 5);
  preview.forEach((m) => logger.info(`   ${String(m.seq).padStart(3, ' ')}. ${m.title}  (${m.chars} 字)`));
  if (manifest.length > preview.length) logger.info(`   ... 还有 ${manifest.length - preview.length} 章`);

  // 卷归属概览：让用户一眼看出"哪几章进了哪一卷"
  const vols = [...new Set(manifest.map((m) => m.volume).filter(Boolean))];
  if (vols.length) {
    logger.info(`分卷：共 ${vols.length} 卷`);
    for (const v of vols) {
      const inVol = manifest.filter((m) => m.volume === v);
      logger.info(`   ${v}：第 ${inVol[0].seq} ~ ${inVol[inVol.length - 1].seq} 章，共 ${inVol.length} 章`);
    }
    const none = manifest.filter((m) => !m.volume);
    if (none.length) {
      logger.warn(`   有 ${none.length} 章没写卷（第 ${none.map((m) => m.seq).join('、')} 章）—— 发布会沿用页面上当前的卷`);
    }
  } else {
    logger.info('源文件里没有卷标题行 —— 所有章节发布会沿用页面上当前选中的卷');
    logger.info('想分卷，就在小说里单独一行写「第二卷：云隐谷」这样的一行（详见 小说文件规范.md）');
  }

  return manifest;
}

/** 读取已拆分的章节 */
function loadManifest() {
  const p = path.join(CHAPTERS_DIR, 'manifest.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function loadChapterBody(chapter) {
  const p = path.join(CHAPTERS_DIR, chapter.file);
  if (!fs.existsSync(p)) throw new Error(`章节文件不存在：${p}`);
  return fs.readFileSync(p, 'utf8');
}

module.exports = {
  splitNovel,
  planChapters,
  loadManifest,
  loadChapterBody,
  detectChapterMarks,
  detectVolumeMarks,
  setChaptersDir,
  getChaptersDir,
};
