/**
 * 配置加载：config.json 与默认值深合并
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./util');

const CONFIG_PATH = path.join(ROOT, 'config.json');

const DEFAULTS = {
  site: {
    name: '番茄小说',
    writerHome: 'https://fanqienovel.com/main/writer/book-manage',
    // 只处理这一本书。★ 同一账号下有多本书时，就靠这个书名定位到正确的那本
    //   （脚本会去作品管理页按书名找到它，自动拿到它的书籍 ID）
    bookName: '',
    // 下面两个地址可以不填 —— 填了会被当作"线索"，但 bookName 始终优先。
    // 账号里只有一本书、又懒得填书名时，把 createChapterUrl 填上也能直接跑。
    bookUrl: '',
    // 创建章节页地址：填了就直奔这里，省掉"自动找入口"这一步（最稳）
    createChapterUrl: '',
    // 是否允许脚本自己去作品管理页按书名定位作品（多书账号必须开着）
    autoFindBook: true,
  },
  login: {
    credentialsFile: 'credentials.json',
  },
  novel: {
    sourceFile: 'novel.txt',
    encoding: 'utf8',
    // 章节标题行的识别正则（逐行匹配）
    chapterRegex: '^\\s*第\\s*[0-9０-９零〇一二三四五六七八九十百千万两]{1,8}\\s*[章节回][\\s:：、.．·-]{0,3}[^\\n]{0,40}$',
    // 少于这个字数的"章节"会被当成误识别丢弃
    minChapterChars: 80,
    // 一章超过这个字数会告警（平台一般有上限）
    warnChapterChars: 15000,
    // 标题是否自动剥掉"第X章"前缀（番茄的序号和标题是两个独立输入框）
    stripChapterPrefix: true,
    // 是否自动读后台、推算章节序号
    fillChapterNo: true,
    // 标题里写了「第17章 xxx」时，是否优先用标题里的 17。
    // 比"后台最大号+1"更稳：不受后台草稿/测试章节影响。标题没写数字时才用后台推算。
    preferSourceChapterNo: true,
    // 卷标题行的识别规则（逐行、整行匹配）。
    // 认「第二卷：云隐谷」「第二卷 云隐谷」「第二卷:云隐谷」「第二卷」这几种写法。
    // 卷标题行必须单独占一行，它本身不是章节，也不会算进正文字数。
    volumeRegex: '^\\s*第\\s*[0-9０-９零〇一二三四五六七八九十百千万两]{1,8}\\s*卷\\s*[:：]?\\s*[^\\n]{0,30}$',
    // 发布时是否自动把「分卷」切到该章所属的卷
    fillVolume: true,
  },
  publish: {
    // publish = 直接发布到线上（当前默认，用户要求不需要自己做选择）
    // draft   = 只保存草稿
    mode: 'publish',
    // 每次运行最多发几章：
    //   >0 = 硬上限（如 1 = 点一次只发 1 章）
    //   0  = 不限章数 —— 交给下面的 dailyCharLimit 去卡，
    //        这样"点一下"就能把当天的字数额度发满
    maxPerRun: 0,
    // ★ 每天能发布的正文总字数上限（番茄的限制，本机是 10000）。
    //   点一次「一键发布」会一直发，直到"下一章放不下剩余额度"为止 ——
    //   不会为了凑满而截断某一章。设 0 = 关闭这个限制。
    //   账本在 data/daily.json，跨天自动清零。
    dailyCharLimit: 10000,
    // 两章之间的间隔基准秒数 / 随机浮动秒数（模拟人工，降低风控）
    intervalSeconds: 15,
    jitterSeconds: 8,
    // 已成稿的章节是否跳过
    skipPublished: true,
    // 是否自动点击最终确认弹窗 / 内容检测方式选择
    autoConfirm: true,
    // 点「下一步」后番茄会要求选内容检测方式：
    //   basic = 仅基础检测（不限次数，默认）
    //   full  = 全面检测（有每日次数限制，番茄实测只有 2 次/天）
    contentCheck: 'basic',
    // 「发布设置」弹窗里的必填项「是否使用AI」：
    //   yes = 选「是」；no = 选「否」
    // ⚠️ 这一项不选，番茄的「确认发布」按钮是**禁用**的，怎么点都发不出去
    aiGenerated: 'yes',
    // 番茄是"多步"流程（编辑页→内容检测→发布设置→发布），
    // 最多往下推进几轮，直到出现成功提示为止
    maxSubmitRounds: 5,
  },
  selectors: {
    // 留空 = 自动识别。页面改版后可以在这里手动写死 CSS 选择器
    titleInput: '',
    contentEditor: '',
    publishButton: '',
    saveDraftButton: '',
    newChapterButton: '',
  },
  browser: {
    // 用哪个内核：chromium（默认，Chrome/Edge/Brave/360/QQ 都算）| firefox（尽力而为，没实测过）
    engine: 'chromium',
    // 用哪个浏览器：
    //   "auto"  = 自动挑（推荐）—— 依次试 手填的exe → 本项指定 → Chrome → Edge → Brave
    //             → Vivaldi → Opera → 360极速 → 360安全 → QQ → 搜狗 → 2345 → 猎豹 → 遨游
    //             → playwright 自带内核。某一档不能用会自动换下一档。
    //   也可以显式写死：chrome / msedge / chrome-beta / msedge-beta / msedge-dev
    channel: 'auto',
    // 手填浏览器 exe 的完整路径。给"没有官方通道"的浏览器用（360、QQ、搜狗…）。
    // 填了它优先级最高。例：C:\\Program Files (x86)\\360\\360Chrome\\Chrome\\Application\\360chrome.exe
    executablePath: '',
    userDataDir: 'userdata',
    headless: false,
    viewport: { width: 1440, height: 900 },
    // 首次登录/人工介入时，脚本最多等多少秒
    loginTimeoutSeconds: 300,
    slowMoMs: 0,
  },
  safety: {
    // true = 即使不加 --dry 参数也默认只演练不发布，强制用户显式开启
    requireExplicitPublish: false,
    // 单章最大字数保护，超过直接跳过并告警
    maxCharsPerChapter: 30000,
    // 番茄"直接发布"要求正文至少这么多字（存草稿不受此限）
    minCharsForPublish: 1000,
  },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  if (!isPlainObject(override)) return out;
  for (const [k, v] of Object.entries(override)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

function loadConfig({ silent = false } = {}) {
  let user = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
      throw new Error(`config.json 格式错误（JSON 解析失败）：${e.message}`);
    }
  } else if (!silent) {
    console.warn('[WARN ] 未找到 config.json，使用默认配置');
  }
  return deepMerge(DEFAULTS, user);
}

function writeDefaultConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2), 'utf8');
  }
}

module.exports = { loadConfig, writeDefaultConfig, DEFAULTS, CONFIG_PATH };
