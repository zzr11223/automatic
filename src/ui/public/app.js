/* 小说自动发布面板 —— 前端逻辑
   状态全部来自 /api/state；会改东西的动作走 POST /api/*，日志通过 /api/log 流式推过来。 */
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let STATE = null;
let FILTER = 'all';
let busy = false;

/* ---------------- 日志 ---------------- */

function logLine(kind, text) {
  const el = $('log');
  const cls = /OK|✅|成功|完成|已切换/.test(text)
    ? 'l-ok'
    : /FAIL|ERROR|❌|失败|错误/.test(text)
      ? 'l-err'
      : /WARN|⚠/.test(text)
        ? 'l-warn'
        : kind === 'err'
          ? 'l-err'
          : kind === 'sys'
            ? 'l-sys'
            : 'l-out';
  const span = document.createElement('div');
  span.className = cls;
  span.textContent = text;
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}

function logRaw(text) {
  for (const line of String(text).split('\n')) logLine('out', line);
}

/* ---------------- 提示 ---------------- */

function setHint(text, tone) {
  const h = $('job-hint');
  h.textContent = text;
  h.style.color = tone === 'err' ? 'var(--red)' : tone === 'ok' ? 'var(--accent)' : '';
}

function showFatal(msg) {
  $('fatal').classList.remove('hidden');
  $('fatal').innerHTML = '<b>面板读不到状态</b>\n\n' + esc(msg);
  $('main').classList.add('hidden');
  $('boot').classList.add('hidden');
}

/* ---------------- 渲染 ---------------- */

function renderStats(s) {
  $('s-published').textContent = s.counts.published;
  $('s-total').textContent = '/ ' + s.counts.total;

  const pct = s.counts.total ? (s.counts.published / s.counts.total) * 100 : 0;
  $('s-progressbar').style.width = pct.toFixed(1) + '%';

  $('s-pending').textContent = s.counts.pending;

  const badges = [];
  if (s.counts.draft) badges.push(`${s.counts.draft} 章草稿`);
  if (s.counts.failed) badges.push(`${s.counts.failed} 章失败`);
  if (!badges.length) badges.push(s.counts.pending ? '都可以发' : '全部发完了');
  $('s-badges').textContent = badges.join(' · ');

  const q = s.quota;
  if (!q.enabled) {
    $('s-used').textContent = '不限';
    $('s-limit').textContent = '';
    $('s-quotabar').style.width = '0';
    $('s-quotabar').className = '';
  } else {
    $('s-used').textContent = q.used;
    $('s-limit').textContent = '/ ' + q.limit;
    const r = q.limit ? (q.used / q.limit) * 100 : 0;
    const bar = $('s-quotabar');
    bar.style.width = Math.min(100, r).toFixed(1) + '%';
    bar.className = r >= 100 ? 'full' : r >= 80 ? 'warn' : '';
  }

  const p = s.plan || {};
  $('s-plan-count').textContent = p.error ? '?' : p.count;
  $('s-plan-sub').textContent = p.error
    ? '算不出来：' + p.error
    : p.count
      ? `${p.chars} 字${p.stopped ? ' · 后面还有一章放不下' : ''}`
      : q.enabled && q.remain === 0
        ? '今天的额度已用完'
        : s.counts.pending
          ? '剩余额度放不下下一章'
          : '没有待发的章节';
}

function renderBooks(s) {
  const sel = $('book-select');
  sel.innerHTML = '';
  if (!s.books.length) {
    const o = document.createElement('option');
    o.textContent = '（还没有小说）';
    o.value = '';
    sel.appendChild(o);
    return;
  }
  for (const b of s.books) {
    const o = document.createElement('option');
    o.value = b.name;
    o.textContent =
      b.name + (b.total ? `　${b.published}/${b.total} 章` : '　未拆分') + (b.hasSource ? '' : '　⚠ 无正文');
    if (b.current) o.selected = true;
    sel.appendChild(o);
  }
}

function renderChapters(s) {
  const tb = $('chapter-body');
  const rows = s.chapters.filter((c) => {
    if (FILTER === 'pending') return c.status === 'pending' || c.status === 'failed';
    if (FILTER === 'published') return c.status === 'published' || c.status === 'draft';
    return true;
  });

  const LABEL = { published: '已发布', draft: '已存草稿', pending: '待发布', failed: '失败' };

  tb.innerHTML = rows
    .map((c) => {
      let note = '';
      if (c.byNo) note = `<span class="note">标题和记录对不上，按第 ${c.byNo} 章认出</span>`;
      if (c.status === 'failed' && c.reason) note = `<span class="note">${esc(c.reason)}</span>`;
      return `<tr>
        <td class="num">第 ${c.no == null ? c.seq : c.no} 章</td>
        <td class="title-cell">${esc(c.title)}${note}</td>
        <td class="num">${c.chars}</td>
        <td class="vol">${esc(c.volume || '—')}</td>
        <td><span class="pill ${c.status}">${LABEL[c.status] || c.status}</span></td>
      </tr>`;
    })
    .join('');

  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="5" class="muted" style="padding:18px 10px">这个筛选下没有章节</td></tr>`;
  }
}

function renderDetail(s) {
  $('d-dir').textContent = s.current.dir;
  $('d-src').textContent = s.current.sourceFile;
  $('d-prog').textContent = s.current.progressPath;
  $('d-daily').textContent = s.current.dailyPath;

  const cfg = s.config;
  $('d-mode').textContent = cfg.mode === 'draft' ? '只存草稿' : '直接发布到线上';
  $('d-browser').textContent = 'channel = ' + cfg.browserChannel;
  $('d-check').textContent =
    (cfg.contentCheck === 'full' ? '全面检测' : '仅基础检测') +
    `　｜　是否使用AI = ${cfg.aiGenerated === 'no' ? '否' : '是'}`;

  $('foot-time').textContent = '状态更新于 ' + s.time;
}

function render(s) {
  STATE = s;
  if (!s.ok) return showFatal(s.error);
  $('fatal').classList.add('hidden');
  $('main').classList.remove('hidden');
  $('boot').classList.add('hidden');

  renderStats(s);
  renderBooks(s);
  renderChapters(s);
  renderDetail(s);

  const canPublish = (s.plan && s.plan.count > 0) || (s.counts.pending > 0 && !s.quota.enabled);
  $('publish-label').textContent =
    !busy && s.plan && s.plan.count ? `开始发布（本次 ${s.plan.count} 章）` : '开始发布';

  for (const id of ['btn-publish', 'btn-dry', 'btn-lint', 'btn-split', 'btn-check']) {
    $(id).disabled = busy;
  }
  if (!busy) $('btn-publish').disabled = !canPublish;

  if (!busy) {
    if (!s.counts.total) setHint('还没有拆分过章节 —— 点「重新拆分」');
    else if (!s.counts.pending) setHint('全部发完了', 'ok');
    else if (s.plan && !s.plan.count) setHint('今天额度放不下下一章，明天再发');
    else setHint('就绪');
  }
}

async function refresh() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    render(await r.json());
  } catch (e) {
    showFatal('连不上本地服务：' + e.message);
  }
}

/* ---------------- 动作 ---------------- */

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return r.json();
}

function setBusy(on, name) {
  busy = on;
  $('btn-stop').classList.toggle('hidden', !on);
  if (on) {
    for (const id of ['btn-publish', 'btn-dry', 'btn-lint', 'btn-split', 'btn-check']) $(id).disabled = true;
    setHint('正在跑：' + (name || '任务') + '…');
  }
}

async function run(cmd, args, label) {
  if (busy) return;
  setBusy(true, label);
  logLine('sys', `──── 开始：${label} ────`);
  const r = await post('/api/run', { cmd, args });
  if (!r.ok) {
    logLine('err', r.error || '启动失败');
    setBusy(false);
    setHint('启动失败', 'err');
    await refresh();
    return;
  }
  await refresh();
}

$('btn-publish').addEventListener('click', () => {
  const p = STATE && STATE.plan;
  if (p && p.count) {
    logLine('sys', `──── 开始：一键发布（本次 ${p.count} 章 / ${p.chars} 字）────`);
    if (p.titles.length) logLine('sys', '  ' + p.titles.join('、'));
  }
  run('publish', [], '一键发布');
});

$('btn-dry').addEventListener('click', () => {
  logLine('sys', '注意：试运行会打开编辑页填内容但不发布，可能在后台留下一个空草稿壳。');
  run('publish', ['--dry'], '试运行');
});

$('btn-lint').addEventListener('click', () => run('lint', [], '格式校验'));
$('btn-split').addEventListener('click', () => run('split', [], '重新拆分'));
$('btn-check').addEventListener('click', () => run('check', [], '发布前自检'));

$('btn-stop').addEventListener('click', async () => {
  logLine('warn', '正在请求停止…（已经发出去的那几章不会回退）');
  const r = await post('/api/stop');
  if (!r.ok) logLine('err', r.error || '停止失败');
});

$('btn-refresh').addEventListener('click', refresh);
$('btn-clearlog').addEventListener('click', () => ($('log').innerHTML = ''));

$('book-select').addEventListener('change', async (e) => {
  const name = e.target.value;
  if (!name || (STATE && STATE.current.name === name)) return;
  logLine('sys', `──── 切换当前小说 → ${name} ────`);
  const r = await post('/api/switch', { name });
  if (!r.ok) logLine('err', r.error || '切换失败');
  else logLine('ok', `已切换到「${r.name}」`);
  await refresh();
});

$('btn-newbook').addEventListener('click', async () => {
  const name = window.prompt('新小说的名字（就是文件夹名，建议和番茄后台的书名一致）：');
  if (!name) return;
  const r = await post('/api/newbook', { name });
  if (!r.ok) {
    logLine('err', r.error || '新建失败');
    window.alert(r.error || '新建失败');
    return;
  }
  logLine('ok', `已新建并切换为当前小说：「${r.name}」`);
  logLine('sys', `下一步：把正文存成 books\\${r.name}\\novel.txt，然后点「格式校验」`);
  await refresh();
});

$('btn-dailyset').addEventListener('click', async () => {
  const v = Number($('dailyset').value);
  if (!Number.isFinite(v) || v < 0) return window.alert('请填一个不小于 0 的数字');
  const r = await post('/api/dailyset', { value: v });
  if (!r.ok) return window.alert(r.error || '校准失败');
  logLine('sys', `今日已发字数手动校准：${r.before} → ${r.after}`);
  $('dailyset').value = '';
  await refresh();
});

$('filter-seg').addEventListener('click', (e) => {
  const b = e.target.closest('.seg-btn');
  if (!b) return;
  FILTER = b.dataset.filter;
  for (const x of document.querySelectorAll('.seg-btn')) x.classList.toggle('active', x === b);
  if (STATE) renderChapters(STATE);
});

/* ---------------- 日志流 ---------------- */

function connect() {
  const es = new EventSource('/api/log');

  es.addEventListener('hello', () => {
    $('conn-dot').className = 'dot on';
    if (!$('log').dataset.greeted) {
      $('log').dataset.greeted = '1';
      logLine('sys', '面板已就绪 —— 这里的日志会实时显示命令行的输出。');
      logLine('sys', '左侧点「格式校验」「发布前自检」先看一遍，确认没问题再点「开始发布」。');
      logLine('sys', '');
    }
  });

  es.addEventListener('log', (e) => {
    const d = JSON.parse(e.data);
    logLine(d.kind, d.text);
  });

  es.addEventListener('job', async (e) => {
    const d = JSON.parse(e.data);
    if (d.status === 'start') {
      setBusy(true, d.name);
    } else if (d.status === 'end') {
      logLine('sys', `──── 结束：${d.name}（退出码 ${d.code}${d.killed ? '，已手动停止' : ''}）────`);
      setBusy(false);
      const bad = d.code !== 0;
      setHint(bad ? `${d.name} 结束（退出码 ${d.code}）` : `${d.name} 完成`, bad ? 'err' : 'ok');
      $('btn-publish').disabled = false;
      await refresh();
    }
  });

  es.onerror = () => {
    $('conn-dot').className = 'dot off';
    // EventSource 自己会重连（服务端设了 retry），这里只更新指示灯
  };
}

/* ---------------- 启动 ---------------- */

connect();
refresh();
setInterval(() => {
  if (!busy) refresh();
}, 20000);
