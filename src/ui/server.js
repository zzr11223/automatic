#!/usr/bin/env node
/**
 * 本地管理面板（可视化界面）
 *
 * 只依赖 Node 自带的 http —— 不引入任何新依赖，双击 12-打开管理面板.bat 就能用。
 *
 * 设计原则：
 *   1. **只读状态用进程内模块读**（快），**所有"会改东西"的动作都 spawn 一个子进程跑
 *      `node src/cli.js <命令>`**。这样面板和命令行走的是**同一套生产代码**，
 *      不存在"面板里有一套逻辑、命令行里另一套"的漂移。
 *   2. 发布是长任务（几分钟）→ 用 SSE 把子进程的 stdout 实时推到页面。
 *      看不到过程，用户会以为卡死了。
 *   3. **只监听 127.0.0.1**，不监听 0.0.0.0 —— 这个面板能真的把章节发出去，
 *      绝不能暴露在局域网上。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { ROOT, createLogger } = require('../util');
const { loadConfig } = require('../config');
const books = require('../books');
const progress = require('../progress');
const daily = require('../daily');
const { loadManifest } = require('../split');

const PUBLIC_DIR = path.join(__dirname, 'public');
const CLI = path.join(ROOT, 'src', 'cli.js');
const silent = { info() {}, warn() {}, ok() {}, fail() {}, step() {} };

/** 一次只允许跑一个任务（发布和校验同时跑会互相干扰） */
let running = null;
/**
 * 批量发布的队列。非 null 表示"正在排队发多本"。
 * ★ 队列的**每一步**都是一个独立的 `node src/cli.js publish --book "X"` 子进程 ——
 *   不自己实现发布逻辑，复用生产代码（同"面板不许自己实现一遍发布逻辑"的原则）。
 * ★ 步骤之间 `running` 会短暂为 null，所以"忙不忙"必须看 `running || queue`，
 *   否则别的动作会趁虚而入，或者在队列半途点「停止」会说"没有任务在跑"。
 */
let queue = null;

const isBusy = () => !!running || !!queue;

/* ------------------------- 静态文件 ------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res) {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = rel === '/' ? 'index.html' : rel.replace(/^\/+/, '');
  const full = path.join(PUBLIC_DIR, file);

  // 防目录穿越：解析后必须还在 public 里
  if (!path.resolve(full).startsWith(path.resolve(PUBLIC_DIR))) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(buf);
  });
}

function json(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

/* ------------------------- 状态 ------------------------- */

function buildState() {
  const cfg = loadConfig();
  const all = books.listBooks();

  let current = null;
  try {
    // activate 会重写 books/.current，但写的值和原来一样，无副作用
    current = books.activate(null);
    books.applyBookToConfig(cfg, current);
  } catch (e) {
    return { ok: false, error: e.message, books: all.map((b) => ({ name: b.name, current: false })) };
  }

  const manifest = loadManifest();
  const chapters = (manifest && manifest.chapters) || [];
  const rec = progress.load();

  const list = chapters.map((c) => {
    const m = progress.matchDone(c.title);
    let status = 'pending';
    if (m.done) status = m.record && m.record.status === 'draft' ? 'draft' : 'published';
    else {
      const r = rec.chapters[c.title];
      if (r && r.status === 'failed') status = 'failed';
    }
    return {
      seq: c.seq,
      // ★ 显示"第几章"而不是 chapters/ 目录里的序号 —— 用户脑子里是第17章，
      //   看到序号列写着 1 而标题是「第17章」会以为对不上（cli status 也踩过这个）
      no: progress.recordNo(c.title, {}) || c.seq,
      title: c.title,
      chars: c.chars,
      volume: c.volume || '',
      status,
      byNo: m.how === 'number' ? m.no : null,
      reason: status === 'failed' ? (rec.chapters[c.title] || {}).reason || '' : '',
    };
  });

  const pending = list.filter((x) => x.status !== 'published' && x.status !== 'draft');
  const quota = daily.summary(cfg, manifest);

  // 本次点发布会发几章
  // ★ 必须用 publisher.planNextRun —— 和自检、和真正的发布走同一套算法。
  //   面板自己拼 applyDailyQuota 的参数踩过坑（把 summary() 当账本传，剩余额度成 NaN）。
  let plan = { count: 0, chars: 0, stopped: false, titles: [], error: '' };
  try {
    const { planNextRun } = require('../publisher');
    const r = planNextRun(cfg, pending.map((p) => ({ ...p })), quota, silent);
    plan = {
      count: r.picked.length,
      chars: r.chars,
      stopped: !!r.stopped,
      remaining: r.remain,
      titles: r.picked.map((x) => x.title),
      error: '',
    };
  } catch (e) {
    plan.error = String(e.message || e).split('\n')[0];
  }

  // 兜底自检：额度明明不够却算出要发 → 说明算法输入又对不上了，宁可显示"算不出来"
  if (!plan.error && plan.count > 0 && Number.isFinite(plan.remaining)) {
    const first = pending[0];
    if (first && plan.remaining < (Number(first.chars) || 0)) {
      plan = { ...plan, count: 0, chars: 0, titles: [], error: '额度算不一致，请用「发布前自检」核对' };
    }
  }

  return {
    ok: true,
    time: new Date().toLocaleString('zh-CN', { hour12: false }),
    project: { root: ROOT },
    current: {
      name: current.name,
      bookName: current.bookName,
      dir: current.dir,
      sourceFile: current.sourceFile,
      progressPath: current.progressPath,
      dailyPath: current.dailyPath,
      hasSource: current.hasSource,
      hasChapters: current.hasChapters,
    },
    books: all.map((b) => ({
      name: b.name,
      current: b.name === current.name,
      published: b.published,
      total: b.total,
      hasSource: b.hasSource,
    })),
    counts: {
      total: list.length,
      published: list.filter((x) => x.status === 'published').length,
      draft: list.filter((x) => x.status === 'draft').length,
      failed: list.filter((x) => x.status === 'failed').length,
      pending: pending.length,
    },
    quota: {
      enabled: quota.enabled,
      date: quota.date,
      limit: quota.limit,
      used: quota.used,
      remain: Number.isFinite(quota.remain) ? quota.remain : null,
      chapters: quota.chapters,
    },
    plan,
    config: {
      mode: cfg.publish.mode,
      dailyCharLimit: cfg.publish.dailyCharLimit,
      maxPerRun: cfg.publish.maxPerRun,
      contentCheck: cfg.publish.contentCheck,
      aiGenerated: cfg.publish.aiGenerated,
      autoFindBook: cfg.site.autoFindBook !== false,
      browserChannel: cfg.browser.channel,
    },
    chapters: list,
    jobs: running
      ? { name: running.name, startedAt: running.startedAt }
      : queue
        ? { name: `批量发布（${queue.index + 1}/${queue.steps.length}）`, startedAt: queue.startedAt }
        : null,
    platform: readPlatformCache(),
  };
}

/* ------------------------- 所有书的概览 ------------------------- */

/**
 * 给「书籍总览」用：一次把 books/ 下**每本书**的情况算出来。
 *
 * ★★ 全程走 `books.summarize()` / `books.pendingOf()` —— 纯读文件，**绝不 activate()**。
 *   循环 activate 会重写 books/.current，中途出错就把「当前小说」留在别的书上了。
 *   一个"看看有什么"的只读接口，不能有这种副作用。
 *
 * ★ 「点一次会发几章」用 `publisher.planNextRun` —— 和面板顶部那张卡、和自检、
 *   和真正的发布是**同一个函数**。面板自己拼参数踩过坑（NaN 导致显示 7 章实际发 0 章）。
 */
function buildBooksState() {
  const cfg = loadConfig();
  const all = books.listBooks();
  const current = books.currentName();

  // ★★ 日额度是**账号级**的（2026-10-05 确认：所有书共用 10000 字/天）。
  //   所以账号额度在这里**只算一次**，放进顶层 quota；每本书只带"这本今天发了多少"。
  //   以前每张卡各自显示 10000 额度，是"每本各算各的"那个错误模型留下的 ——
  //   照那个发，两本一起就是 20000，平台只认 10000，必超。
  const daily = require('../daily');
  daily.setFile(daily.accountFile());
  // 补账要扫全部书（不然别的书今天发的字数会被漏掉 → 发超）
  daily.setSources(all.map((b) => ({ progressPath: b.progressPath, manifestPath: b.manifestPath })));
  const quota = daily.summary(cfg, null);

  let planner = null;
  try {
    planner = require('../publisher').planNextRun;
  } catch (_) {
    planner = null;
  }

  const list = all.map((b) => {
    const sum = books.summarize(b);
    let plan = { count: 0, chars: 0, stopped: false, error: '' };
    if (!planner) {
      plan.error = '发布模块没加载起来';
    } else {
      try {
        const pending = books.pendingOf(b);
        // ★★ 这里的形状是 `daily.summary()` 的形状：`{ used, chapters }`。
        //    planNextRun 内部读的是 `quota.used`（不是 `quota.chars`）——
        //    传成 `{chars}` 会变成 Number(undefined)||0 = 0，
        //    也就是"今天一个字都没发" → remain 算成满额度 → 显示"会发 7 章"但实际一章都发不了。
        //    这个坑本项目踩过两次了，改这里之前先看 publisher.js 里那段注释。
        // ★★ `used` 必须是**账号级**的总量 —— 额度是所有书共用的，
        //    只算这本书自己的，另外那本发的字就漏算了 → 发超。
        const r = planner(cfg, pending, { used: quota.used, chapters: [] }, silent);
        plan = { count: r.picked.length, chars: r.chars, stopped: !!r.stopped, remaining: r.remain, titles: r.picked.map((x) => x.title), error: '' };

        // 兜底自检：额度明明放不下第一章，却算出要发 → 说明输入又对不上了，宁可显示"算不出来"
        if (plan.count > 0 && Number.isFinite(plan.remaining) && pending.length) {
          if (plan.remaining < (Number(pending[0].chars) || 0)) {
            plan = { count: 0, chars: 0, stopped: false, remaining: plan.remaining, titles: [], error: '额度算不一致' };
          }
        }
      } catch (e) {
        plan.error = String(e.message || e).split('\n')[0];
      }
    }
    return {
      name: b.name,
      bookName: b.bookName,
      dir: b.dir,
      current: b.name === current,
      hasSource: b.hasSource,
      hasChapters: b.hasChapters,
      total: sum.total,
      published: sum.published,
      draft: sum.draft,
      failed: sum.failed,
      pending: sum.pending,
      volumes: sum.volumes,
      // ★ 这本书**自己**今天发了多少（展示用）；账号总额在上面的 quota 里
      todayChars: sum.todayChars,
      todayChapters: sum.todayChapters,
      lastAt: sum.lastAt,
      plan,
    };
  });

  return {
    ok: true,
    time: new Date().toLocaleString('zh-CN', { hour12: false }),
    current,
    limit: Number(cfg.publish.dailyCharLimit) || 0,
    mode: cfg.publish.mode,
    quota: { enabled: quota.enabled, limit: quota.limit, used: quota.used, remain: quota.remain },
    busy: isBusy(),
    queue: queue
      ? { index: queue.index, total: queue.steps.length, names: queue.steps.map((s) => s.name), aborted: queue.aborted }
      : null,
    books: list,
  };
}

/** 读后台状态缓存（sync-records 写的，面板展示用；没有就返回 null） */
function readPlatformCache() {
  try {
    return JSON.parse(require('fs').readFileSync(path.join(ROOT, 'data', 'platform-books.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

/* ------------------------- 跑命令 + SSE 推日志 ------------------------- */

const clients = new Set();

function broadcast(type, payload) {
  const line = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(line);
    } catch (_) {
      clients.delete(res);
    }
  }
}

/**
 * 起一个 `node src/cli.js <cmd>` 子进程，把输出通过 SSE 实时推给页面。
 * 返回 Promise，resolve 成 `{ code, killed }` —— 批量队列靠它串行推进。
 */
function spawnJob(name, cmd, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, cmd, ...args], {
      cwd: ROOT,
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    running = { name, child, startedAt: Date.now() };
    broadcast('job', { status: 'start', name, cmd, args });
    console.log(`[面板] 开始：${name}（node src/cli.js ${cmd} ${args.join(' ')}）`);

    const pump = (stream, kind) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const l of lines) broadcast('log', { kind, text: l });
      });
      stream.on('end', () => {
        if (buf) broadcast('log', { kind, text: buf });
      });
    };
    pump(child.stdout, 'out');
    pump(child.stderr, 'err');

    child.on('error', (e) => {
      broadcast('log', { kind: 'err', text: '启动子进程失败：' + e.message });
    });

    child.on('close', (code, signal) => {
      const killed = !!running && running.killed;
      running = null;
      broadcast('job', { status: 'end', name, code, signal: signal || null, killed });
      console.log(`[面板] 结束：${name}（退出码 ${code}${killed ? '，已手动停止' : ''}）`);
      resolve({ code, killed });
    });
  });
}

function runCli(name, cmd, args = [], res) {
  if (isBusy()) {
    json(res, { ok: false, error: `已有任务在跑：${(running && running.name) || '批量发布'}，等它结束或先点「停止」` }, 409);
    return;
  }
  spawnJob(name, cmd, args);
  json(res, { ok: true, name });
}

/**
 * 批量队列：把选中的书**依次**跑一遍。
 *
 * ★ 每一步都是一次独立的 `node src/cli.js <cmd> --book "X"`：
 *   - 日字数额度是**账号级**的，账本只有一份 data/daily.json ——
 *     排队发的时候，前一本发掉的字会立刻记进同一本账，后一本自然就少了不少
 *     （这正是把账本改成共享的原因：按书分账的话，两本一起发就是 20000，平台只认 10000）
 *   - `--book` 已经修成"不改「当前」"，所以排队跑完不会把你的「当前小说」也带走
 *
 * @param {string} label 显示用的名字（"批量发布" / "批量校验"）
 */
function runQueue(steps, res, label = '批量发布') {
  if (isBusy()) {
    json(res, { ok: false, error: `已有任务在跑：${(running && running.name) || '批量任务'}，等它结束或先点「停止」` }, 409);
    return;
  }
  if (!steps.length) {
    json(res, { ok: false, error: '没有选中任何书' }, 400);
    return;
  }

  queue = { steps, index: 0, aborted: false, startedAt: Date.now(), label };
  const names = steps.map((s) => s.name);
  broadcast('queue', { status: 'start', label, total: steps.length, names });
  console.log(`[面板] ${label}开始：${names.join(' → ')}`);
  json(res, { ok: true, label, total: steps.length, names });

  (async () => {
    let aborted = false;
    for (let i = 0; i < steps.length; i += 1) {
      if (!queue || queue.aborted) {
        aborted = true;
        break;
      }
      queue.index = i;
      broadcast('queue', { status: 'step', index: i, total: steps.length, name: steps[i].name });
      const r = await spawnJob(`${label} ${i + 1}/${steps.length}：${steps[i].name}`, steps[i].cmd, steps[i].args);
      if (r.killed) {
        aborted = true;
        break;
      }
    }
    const total = steps.length;
    broadcast('queue', { status: 'end', label, total, aborted });
    console.log(`[面板] ${label}结束（${aborted ? '中途停止' : '全部跑完'}）`);
    queue = null;
  })();
}

/* ------------------------- 路由 ------------------------- */

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const method = req.method.toUpperCase();

  if (url === '/api/state' && method === 'GET') return json(res, buildState());

  if (url === '/api/books' && method === 'GET') return json(res, buildBooksState());

  if (url === '/api/log' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url === '/api/stop' && method === 'POST') {
    if (!isBusy()) return json(res, { ok: false, error: '当前没有任务在跑' }, 409);
    // 队列要整条停掉，不能只杀当前那个子进程，否则下一步又起来了
    if (queue) queue.aborted = true;
    if (running) {
      running.killed = true;
      try {
        running.child.kill();
      } catch (_) {}
    }
    return json(res, { ok: true });
  }

  if (url === '/api/run' && method === 'POST') {
    return readBody(req, (body) => {
      const cmd = String(body.cmd || '');
      const args = Array.isArray(body.args) ? body.args.map(String) : [];
      const ALLOWED = {
        publish: '一键发布',
        lint: '格式校验',
        split: '重新拆分章节',
        check: '发布前自检',
        'sync-records': '导入后台发布记录',
      };
      if (!ALLOWED[cmd]) return json(res, { ok: false, error: '不允许的命令：' + cmd }, 400);
      // ★ 自选章节参数只放行"数字和逗号"——别把任意字符串塞给命令行
      if (cmd === 'publish' && args.includes('--chapter')) {
        const v = String(args[args.indexOf('--chapter') + 1] || '');
        if (!/^[\d,\s]+$/.test(v) || !/\d/.test(v)) {
          return json(res, { ok: false, error: `--chapter 只能是数字和逗号，收到的是「${v}」` }, 400);
        }
      }
      // ★ 平台定时：用生产解析器校验 + 规范化再传给 CLI（util.js —— 服务端是 Node，可直接用）
      //   支持单段 "08:00" 和多段 "08:00,12:00,18:00"（单章单独定时）
      if (cmd === 'publish' && args.includes('--at')) {
        const idx = args.indexOf('--at');
        const v = String(args[idx + 1] || '');
        const segs = v.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
        if (!segs.length) {
          return json(res, { ok: false, error: '定时时间：是空的' }, 400);
        }
        const norm = [];
        for (const seg of segs) {
          const parsed = require('../util').parseScheduleTime(seg);
          if (!parsed.ok) {
            return json(res, { ok: false, error: '定时时间：' + parsed.reason }, 400);
          }
          norm.push(parsed.text.slice(11)); // 多段只保留 "HH:mm"（日期由逐章顺延规则决定）
        }
        // 单段保留完整 "YYYY-MM-DD HH:mm"（行为与之前完全一致）
        args[idx + 1] = segs.length === 1 ? norm[0] : norm.join(',');
      }
      // ★ 逐章定时映射（"8=08:00,9=12:00"）：逐条校验时间，规范化后再传
      if (cmd === 'publish' && args.includes('--schedule-map')) {
        const idx = args.indexOf('--schedule-map');
        const v = String(args[idx + 1] || '');
        const { parseScheduleMap } = require('../util');
        const pm = parseScheduleMap(v);
        if (!pm.ok) return json(res, { ok: false, error: '逐章定时：' + pm.reason }, 400);
        // 规范化：时间统一成 HH:mm（面板填的都是当天/次日语义）
        const normalized = [...pm.map.entries()]
          .map(([no, s]) => no + '=' + String(s.text).slice(11))
          .join(',');
        args[idx + 1] = normalized;
      }
      return runCli(ALLOWED[cmd], cmd, args, res);
    });
  }

  // ★ 批量：命令走**白名单**，书名必须在 books/ 里真实存在 ——
  //   不开放"任意命令 + 任意参数"，那等于给页面开了个后门。
  //   `lint` 是只读的，所以它既是"批量校验"功能，也是批量队列的"安全演练档"
  //   （发布那条路没法测 —— 点一次就真发出去了）。
  if (url === '/api/batch' && method === 'POST') {
    return readBody(req, (body) => {
      const names = Array.isArray(body.books) ? body.books.map((s) => String(s || '').trim()).filter(Boolean) : [];
      if (!names.length) return json(res, { ok: false, error: '没有选中任何书' }, 400);

      const cmd = String(body.cmd || 'publish');
      const LABEL = { publish: '批量发布', lint: '批量校验' };
      if (!LABEL[cmd]) return json(res, { ok: false, error: `不允许的批量命令：${cmd}` }, 400);

      const known = books.listBooks();
      const steps = [];
      for (const n of names) {
        const hit = known.find((b) => b.name === n);
        if (!hit) return json(res, { ok: false, error: `找不到小说「${n}」` }, 400);
        steps.push({ name: hit.name, cmd, args: ['--book', hit.name] });
      }
      return runQueue(steps, res, LABEL[cmd]);
    });
  }

  if (url === '/api/switch' && method === 'POST') {
    return readBody(req, (body) => {
      try {
        const b = books.activate(String(body.name || ''));
        broadcast('log', { kind: 'out', text: `已切换当前小说：「${b.name}」` });
        return json(res, { ok: true, name: b.name });
      } catch (e) {
        return json(res, { ok: false, error: e.message }, 400);
      }
    });
  }

  if (url === '/api/newbook' && method === 'POST') {
    return readBody(req, (body) => {
      try {
        const name = String(body.name || '').trim();
        if (!name) return json(res, { ok: false, error: '书名不能为空' }, 400);
        const nb = books.createBook(name, {}, undefined);
        books.activate(nb.name);
        broadcast('log', { kind: 'out', text: `已新建并切换为当前小说：「${nb.name}」` });
        broadcast('log', { kind: 'out', text: `请把正文存成：books\\${nb.name}\\novel.txt` });
        return json(res, { ok: true, name: nb.name });
      } catch (e) {
        return json(res, { ok: false, error: e.message }, 400);
      }
    });
  }

  if (url === '/api/dailyset' && method === 'POST') {
    return readBody(req, (body) => {
      const n = Number(body.value);
      if (!Number.isFinite(n) || n < 0) return json(res, { ok: false, error: '要填一个不小于 0 的数字' }, 400);
      const manifest = loadManifest();
      if (!manifest) return json(res, { ok: false, error: '还没有拆分过章节' }, 400);
      const r = daily.setUsed(manifest, Math.trunc(n));
      broadcast('log', { kind: 'out', text: `今日已发字数手动校准：${r.before} → ${r.after}` });
      return json(res, { ok: true, before: r.before, after: r.after });
    });
  }

  return serveStatic(req, res);
});

function readBody(req, cb) {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (c) => {
    raw += c;
    if (raw.length > 1e6) req.destroy();
  });
  req.on('end', () => {
    try {
      cb(raw ? JSON.parse(raw) : {});
    } catch (_) {
      cb({});
    }
  });
}

/* ------------------------- 启动 ------------------------- */

function openBrowser(url) {
  // 用 rundll32 打开默认浏览器 —— 不经过 cmd.exe，避免被安全策略拦
  try {
    const p = spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' });
    p.unref();
    return true;
  } catch (_) {
    return false;
  }
}

function listen(port, attempt = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempt < 10) {
      console.log(`端口 ${port} 被占用，换 ${port + 1} 试试…`);
      listen(port + 1, attempt + 1);
    } else {
      console.error('启动失败：' + e.message);
      process.exit(1);
    }
  });
  // ★ 只监听 127.0.0.1：这个面板能真的发布章节，不能暴露到局域网
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log('');
    console.log('================================================');
    console.log('  小说管理面板已启动');
    console.log('================================================');
    console.log('');
    console.log('  地址：' + url);
    console.log('  （已尝试自动打开浏览器；没弹出来的话，手动把上面这行复制到浏览器）');
    console.log('');
    console.log('  只监听本机，局域网里别的电脑访问不到。');
    console.log('  想关掉面板：直接关掉这个黑窗口。');

    // ★★ 面板打开（启动）后自动同步一次番茄后台状态：
    //   列出账号所有作品 + 把已发/未发记录同步到本地（写 data/platform-books.json）。
    //   跑成普通任务（可见、可停）；手动重启面板想跳过时加 --no-autosync（测试脚本用）。
    if (!process.argv.includes('--no-autosync')) {
      setTimeout(() => {
        if (running || queue) return; // 正忙就不插队
        console.log('[面板] 自动同步后台状态…');
        spawnJob('自动同步后台', 'sync-records', ['--auto']);
      }, 1500);
    }
    console.log('');
    if (!process.argv.includes('--no-open')) openBrowser(url);
  });
}

const portArg = process.argv.indexOf('--port');
listen(portArg > -1 ? Number(process.argv[portArg + 1]) || 8787 : 8787);
