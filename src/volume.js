/**
 * 分卷（卷）支持
 *
 * 背景（2026-10 实测）：
 *   番茄的「卷」不是章节的属性，而是独立的一层分组。章节管理页顶部的分卷下拉
 *   是个**筛选器**（切了它，列表只显示该卷的章节），而新建章节时，卷由
 *   **编辑页顶栏**那个 `span.publish-header-volume-wrap` 决定 —— 点开它会弹出
 *   `.editor-volume-list-item` 列表，选中哪个，这一章就进哪个卷。
 *
 * 本模块只放纯函数：
 *   - 归一化卷名（忽略空格、全半角冒号、连字符差异）
 *   - 判断"某一行是不是卷标题行"
 *   - 从后台的候选卷里挑出最匹配的那个
 * 真正的页面点击在 src/publisher.js 的 applyVolume()。
 */
const { anyNumToInt } = require('./util');

/**
 * 源文件里卷标题行的识别规则（可在 config.json 的 novel.volumeRegex 覆盖）。
 *
 * 认这些写法（都是"整行匹配"）：
 *   第二卷：云隐谷
 *   第二卷 云隐谷
 *   第二卷:云隐谷
 *   第二卷
 * 也就是「第X卷」+ 可选的冒号/空格 + 可选的卷名。
 */
const DEFAULT_VOLUME_REGEX =
  '^\\s*第\\s*[0-9０-９零〇一二三四五六七八九十百千万两]{1,8}\\s*卷\\s*[:：]?\\s*[^\\n]{0,30}$';

/** 「第X卷」这个开头（用于按序号兜底匹配），非卷名返回 '' */
const VOLUME_PREFIX_RE = /^\s*第\s*([0-9０-９零〇一二三四五六七八九十百千万两]{1,8})\s*卷/;

/** 卷标题行不能超过这么长（超过基本是正文里的一句话） */
const MAX_VOLUME_LINE_LEN = 40;

/** 卷名部分最长这么长（卷名都是短名词短语） */
const MAX_VOLUME_NAME_LEN = 20;

/**
 * 卷名不能以这些"虚词 / 标点"开头 —— 出现了就说明是句子而不是卷名。
 * 例：「第一卷的内容讲的是男主角的往事」→ 卷名以「的」开头 → 判定正文。
 */
const NAME_STOP_START = /^[的地得里中内上下是讲说写有会就都也还而但却则把被让使对从向为因所之了吗呢吧啊过着，,、。；;：:！!？?…—]/;

/**
 * 卷名归一化：忽略空格、全角/半角冒号、全角括号、各种连字符的差异。
 * 目的是让「第二卷 云隐谷」和「第二卷：云隐谷」判为同一个卷。
 */
function normalizeVolumeName(s) {
  return String(s == null ? '' : s)
    .replace(/[\s\u3000]+/g, '')
    .replace(/[：:]/g, ':')
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')')
    .replace(/[－—–~～-]/g, '-')
    .trim();
}

/** 「第二卷：云隐谷」→「第二卷」；不是卷格式返回 '' */
function volumeIndexPrefix(s) {
  const m = String(s == null ? '' : s).match(VOLUME_PREFIX_RE);
  if (!m) return '';
  const n = anyNumToInt(m[1]);
  return n > 0 ? `第${n}卷` : '';
}

/** 剥掉「第X卷」和紧跟的冒号，只留卷名。「第二卷：云隐谷」→「云隐谷」 */
function volumeNamePart(s) {
  return String(s == null ? '' : s)
    .replace(VOLUME_PREFIX_RE, '')
    .replace(/^\s*[:：]\s*/, '')
    .trim();
}

/**
 * 判断一行是不是"卷标题行"。
 *
 * 命中返回 { text, prefix, name }，否则 null。
 *
 * 卷标记是**独立的一行**，所以要求：整行匹配 + 够短 + 不含句末标点 + 卷名不以虚词开头。
 * 「第一卷的内容讲的是……」这类正文句子会被这些条件挡掉。
 *
 * 注意：这里只做"单行"判断。真正的"是不是独立一行"由 split.js 的
 * detectVolumeMarks 结合上下文（前后是否空行 / 是否紧邻章节标题）判断。
 */
function looksLikeVolumeHead(line, volumeRegex) {
  const t = String(line == null ? '' : line).trim();
  if (!t || t.length > MAX_VOLUME_LINE_LEN) return null;

  let re;
  try {
    re = new RegExp(volumeRegex || DEFAULT_VOLUME_REGEX);
  } catch (_) {
    return null;
  }
  re.lastIndex = 0;
  if (!re.test(t)) return null;

  // 句末/分句标点 → 是正文里的句子，不是卷名
  if (/[。！？；…]/.test(t)) return null;

  const prefix = volumeIndexPrefix(t);
  if (!prefix) return null;

  const name = volumeNamePart(t);
  if (name.length > MAX_VOLUME_NAME_LEN) return null;
  if (NAME_STOP_START.test(name)) return null;

  return { text: t, prefix, name };
}

/**
 * 从后台给出的候选卷里，挑出和源文件里写的卷最匹配的一个。
 *
 * 匹配优先级（逐级放宽，命中即返回）：
 *   1. 归一化后完全一致
 *   2. 源文件只写了「第X卷」没写卷名 → 按「第X卷」序号匹配
 *   3. 卷名互相包含（两边卷名都 >= 2 个字才算，避免一个字误命中）
 *
 * @param {string} want 源文件里写的卷，如「第二卷：云隐谷」
 * @param {string[]} options 后台下拉里的选项文字，如 ['第一卷：落霞镇','第二卷：云隐谷']
 * @returns {{index:number,text:string,how:string}|null}
 */
function matchVolumeOption(want, options) {
  const list = (options || [])
    .map((text, index) => ({ index, text: String(text == null ? '' : text).trim() }))
    .filter((o) => o.text);
  if (!list.length) return null;

  const w = normalizeVolumeName(want);
  if (!w) return null;

  // 1) 完全一致
  const exact = list.filter((o) => normalizeVolumeName(o.text) === w);
  if (exact.length) {
    return { ...exact[0], how: exact.length > 1 ? '卷名完全一致（有多个同名，取第一个）' : '卷名完全一致' };
  }

  const wPrefix = volumeIndexPrefix(want);
  const wName = normalizeVolumeName(volumeNamePart(want));

  // 2) 源文件只写了「第X卷」
  if (wPrefix && !wName) {
    const byIdx = list.filter((o) => volumeIndexPrefix(o.text) === wPrefix);
    if (byIdx.length) return { ...byIdx[0], how: `按序号匹配（${wPrefix}）` };
  }

  // 3) 卷名互相包含
  if (wName.length >= 2) {
    const byName = list.filter((o) => {
      const n = normalizeVolumeName(volumeNamePart(o.text));
      return n.length >= 2 && (n.includes(wName) || wName.includes(n));
    });
    if (byName.length) {
      return { ...byName[0], how: byName.length > 1 ? '卷名部分匹配（有多个，取第一个）' : '卷名部分匹配' };
    }
  }

  return null;
}

module.exports = {
  DEFAULT_VOLUME_REGEX,
  MAX_VOLUME_LINE_LEN,
  MAX_VOLUME_NAME_LEN,
  normalizeVolumeName,
  volumeIndexPrefix,
  volumeNamePart,
  looksLikeVolumeHead,
  matchVolumeOption,
};
