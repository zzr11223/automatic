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
    jobs: running ? { name: running.name, startedAt: running.startedAt } : null,
  };
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

function runCli(name, cmd, args = [], res) {
  if (running) {
    json(res, { ok: false, error: `已有任务在跑：${running.name}，等它结束或先点「停止」` }, 409);
    return;
  }

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
  });

  json(res, { ok: true, name });
}

/* ------------------------- 路由 ------------------------- */

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const method = req.method.toUpperCase();

  if (url === '/api/state' && method === 'GET') return json(res, buildState());

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
    if (!running) return json(res, { ok: false, error: '当前没有任务在跑' }, 409);
    running.killed = true;
    try {
      running.child.kill();
    } catch (_) {}
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
      };
      if (!ALLOWED[cmd]) return json(res, { ok: false, error: '不允许的命令：' + cmd }, 400);
      return runCli(ALLOWED[cmd], cmd, args, res);
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
    console.log('');
    if (!process.argv.includes('--no-open')) openBrowser(url);
  });
}

const portArg = process.argv.indexOf('--port');
listen(portArg > -1 ? Number(process.argv[portArg + 1]) || 8787 : 8787);
