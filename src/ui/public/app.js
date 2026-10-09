/* 小说自动发布面板 —— 前端逻辑
   状态全部来自 /api/state；会改东西的动作走 POST /api/*，日志通过 /api/log 流式推过来。 */
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let STATE = null;
let BOOKS = null;          // /api/books 的结果（所有书的概览）
const PICKED = new Set();  // 批量排队勾选的书名
let FILTER = 'all';
let busy = false;
/** 批量队列是否在跑 —— 队列每步之间会有一次 job end，靠它避免 busy 状态被误清掉 */
let queueActive = false;
/** 「发布所选」勾选的章节（存 seq） */
const PICKED_CH = new Set();
/** 勾选所属的书 —— 章节表是"当前这本"的，书一变勾选就必须整体清空 */
let PICKED_BOOK = null;
/** ★ 逐章定时：seq → 用户选的时间字符串（"08:00" 或自定义的完整日期；空=立即发布） */
const PICKED_TIME = new Map();
/** ★ 日历+时间选择器（番茄风格，2026-10-09）：状态见 PK（打开时构造） */
let PK = null;

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

/* ---------------- 书籍总览 ---------------- */

/** 这本书现在点一下能发出几章（算不出来 / 额度不够 都算 0） */
function sendable(b) {
  return b && b.plan && !b.plan.error && b.plan.count > 0 ? b.plan.count : 0;
}

function renderOverview(bk) {
  BOOKS = bk;
  const grid = $('book-grid');
  const list = bk.books || [];

  // 书被删掉/改名了，勾选里别留垃圾
  for (const n of [...PICKED]) if (!list.some((b) => b.name === n)) PICKED.delete(n);

  $('ov-count').textContent = list.length ? `（${list.length} 本）` : '';

  if (!list.length) {
    grid.innerHTML = '<p class="muted">books\\ 下还没有小说 —— 点右上角「＋ 新建」建一本。</p>';
    renderAccountQuota(bk);
    return updateBatchButtons();
  }

  grid.innerHTML = list
    .map((b) => {
      const pct = b.total ? (b.published / b.total) * 100 : 0;
      const picked = PICKED.has(b.name);
      const n = sendable(b);

      const flags = [];
      if (b.current) flags.push('<span class="bc-flag on">当前</span>');
      if (!b.hasSource) flags.push('<span class="bc-flag warn">无正文</span>');
      if (!b.hasChapters) flags.push('<span class="bc-flag warn">未拆分</span>');
      if (b.failed) flags.push(`<span class="bc-flag warn">${b.failed} 章失败</span>`);

      let planTxt;
      if (b.plan && b.plan.error) planTxt = '算不出来：' + esc(b.plan.error);
      else if (n) planTxt = `点一次会发 <b>${n}</b> 章 · ${b.plan.chars} 字`;
      else if (!b.hasChapters) planTxt = '还没拆分过章节';
      else if (!b.pending) planTxt = '全部发完了';
      else planTxt = '今天额度放不下下一章';

      return `<div class="book-card${picked ? ' picked' : ''}${b.current ? ' is-current' : ''}">
        <div class="bc-top">
          <input type="checkbox" class="bc-check" data-name="${esc(b.name)}"${picked ? ' checked' : ''}
                 title="勾上就加入批量排队">
          <span class="bc-name" title="${esc(b.bookName)}">${esc(b.name)}</span>
        </div>
        ${flags.length ? `<div class="bc-flags">${flags.join('')}</div>` : ''}
        <div class="bc-line"><span class="muted">已发</span> <b>${b.published}</b><span class="muted"> / ${b.total} 章</span></div>
        <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>
        <div class="bc-grid">
          <div><span class="muted">待发</span><b>${b.pending} 章</b></div>
          <div><span class="muted">这本今天</span><b>${b.todayChapters} 章 · ${b.todayChars} 字</b></div>
        </div>
        <div class="bc-plan">${planTxt}</div>
        <div class="bc-foot">
          <span class="muted">${b.lastAt ? '最后发布 ' + esc(b.lastAt) : '还没发布过'}</span>
          ${b.volumes && b.volumes.length ? `<span class="muted">· ${b.volumes.length} 卷</span>` : ''}
        </div>
        <div class="bc-actions">
          <button class="btn ghost small" data-act="switch" data-name="${esc(b.name)}"${b.current ? ' disabled' : ''}>切到这本</button>
          <button class="btn ghost small" data-act="only" data-name="${esc(b.name)}">只选这本</button>
        </div>
      </div>`;
    })
    .join('');

  renderAccountQuota(bk);
  updateBatchButtons();
}

/**
 * 账号级额度条 —— 放在总览标题下，**只放这一处**。
 * ★ 额度是所有书共用的（2026-10-05 确认），别在每张卡上各画一条 ——
 *   那会让人以为每本各 10000，两本一起发就超了。
 */
function renderAccountQuota(bk) {
  const el = $('ov-quota');
  if (!el) return;
  const q = bk.quota || {};
  if (!q.enabled) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  const pct = q.limit ? Math.min(100, (q.used / q.limit) * 100) : 0;
  el.innerHTML =
    `<div class="ovq-line"><span class="muted">账号今日额度 · 所有书共用</span>` +
    `<b>${q.used} / ${q.limit} 字</b>` +
    `<span class="muted">还剩 ${Math.max(0, q.remain)} 字</span></div>` +
    `<div class="bar"><i class="${pct >= 100 ? 'full' : pct >= 80 ? 'warn' : ''}" style="width:${pct.toFixed(1)}%"></i></div>`;
}

function updateBatchButtons() {
  const n = PICKED.size;
  $('btn-ov-publish').textContent = n ? `排队发布（${n} 本）` : '排队发布';
  // 这里的 disabled 由它一个人说了算 —— 散在别处改会被下一次重绘覆盖
  const usable = !busy && n > 0;
  $('btn-ov-publish').disabled = !usable;
  $('btn-ov-lint').disabled = !usable;
  if (!busy) {
    $('ov-hint').innerHTML = n
      ? `已勾选 <b>${n}</b> 本 → 按<b>总览里的顺序</b>依次发，<b>所有书共用同一个日额度</b>（前面那本发掉的字会算进总额），<b>发完不会改动你的「当前小说」</b>。`
      : '勾选 → <b>排队发布</b>：按勾选顺序一本一本发，<b>所有书共用同一个日字数额度</b>，发完不会改动你的「当前小说」。';
  }
}

async function refreshBooks() {
  try {
    const r = await fetch('/api/books', { cache: 'no-store' });
    renderOverview(await r.json());
  } catch (_) {
    /* 概览拉不到不影响主界面 */
  }
}

/** 「定时」列：下拉选项（预设时间 + 自定义 + 立即发布） */
/** 「定时」列：一个按钮，点开日历+时间选择器（像番茄那样的界面） */
function timeBtnHtml(c) {
  const cur = String(PICKED_TIME.get(c.seq) || '');
  return `<button class="row-time-btn${cur ? ' has' : ''}" data-seq="${c.seq}" title="给这一章选发布时间（日历 + 时/分选择器）；「立即发布」= 不定时">${esc(fmtPickValue(cur))}</button>`;
}

/** 只有"还没发出去"的章才能勾（已发/草稿勾了也会被跳过，干脆不让勾） */
const selectable = (c) => c.status === 'pending' || c.status === 'failed';

function renderChapters(s) {
  if (PK) closePicker(); // 行要重画了，挂着的选择器先收起来
  const tb = $('chapter-body');

  // ★★ 章节表是"当前这本"的 —— 书一变，勾选必须**整体清空**。
  //   光按 seq 清不够：不同书的 seq 会撞（A 书的 seq2 和 B 书的 seq2 是两回事），
  //   用"当前书名"做标记才是干净的（真浏览器测试抓出来的：API 层切书后旧勾选残留）。
  if (PICKED_BOOK !== s.current.name) {
    PICKED_CH.clear();
    PICKED_TIME.clear();
    PICKED_BOOK = s.current.name;
  }
  // 同一本书重新拆分后，勾选里的 seq 可能已经不存在了，也清掉
  // ★ 逐章时间也要跟着清：旧 seq 的定时如果留着，重拆分后可能套到"另一个章"头上
  const alive = new Set(s.chapters.filter(selectable).map((c) => c.seq));
  for (const seq of [...PICKED_CH]) if (!alive.has(seq)) PICKED_CH.delete(seq);
  for (const seq of [...PICKED_TIME.keys()]) if (!alive.has(seq)) PICKED_TIME.delete(seq);

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
      const canPick = selectable(c);
      const picked = PICKED_CH.has(c.seq);
      return `<tr class="${picked ? 'row-picked' : ''}">
        <td class="chk">${
          canPick
            ? `<input type="checkbox" class="ch-check" data-seq="${c.seq}"${picked ? ' checked' : ''} title="勾上就加入「发布所选」">`
            : ''
        }</td>
        <td class="num">第 ${c.no == null ? c.seq : c.no} 章</td>
        <td class="title-cell">${esc(c.title)}${note}</td>
        <td class="num">${c.chars}</td>
        <td class="vol">${esc(c.volume || '—')}</td>
        <td><span class="pill ${c.status}">${LABEL[c.status] || c.status}</span></td>
        <td class="sched">${canPick ? timeBtnHtml(c) : '—'}</td>
      </tr>`;
    })
    .join('');

  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="6" class="muted" style="padding:18px 10px">这个筛选下没有章节</td></tr>`;
  }
  updateSelectedButton();
}

/** 勾选中的章节对象（按书序），供「发布所选」用 */
function selectedChapters() {
  if (!STATE) return [];
  return STATE.chapters.filter((c) => PICKED_CH.has(c.seq));
}

function updateSelectedButton() {
  const btn = $('btn-publish-selected');
  if (!btn) return;
  const items = selectedChapters();
  const total = items.reduce((s, c) => s + (Number(c.chars) || 0), 0);
  btn.textContent = items.length ? `发布所选（${items.length} 章 · ${total} 字）` : '发布所选';
  btn.disabled = busy || !items.length;
  btn.classList.toggle('hidden', !items.length);
  if (!items.length) return;
  const q = STATE && STATE.quota;
  const timed = items.filter((c) => String(PICKED_TIME.get(c.seq) || '').trim()).length;
  const timedNote = timed ? `，其中 ${timed} 章定时` : '';
  btn.title =
    q && q.enabled && total > Math.max(0, q.remain)
      ? `选中共 ${total} 字，账号额度只剩 ${q.remain} 字 → 放得下的先发，放不下的留到明天`
      : `只发勾选的这 ${items.length} 章（共 ${total} 字）${timedNote}。时间在每行最右边的「定时」里填，留空=立即发布`;
}

/* ================= 日历 + 时间选择器（番茄风格） ================= */

/** 把存储值显示成短标签："2026-10-10 08:00" → "10-10 08:00"（今年不显示年）；空 = 立即发布 */
function fmtPickValue(v) {
  const str = String(v || '');
  if (!str) return '立即发布';
  const m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return str;
  const md = String(Number(m[2])).padStart(2, '0') + '-' + String(Number(m[3])).padStart(2, '0');
  const hm = String(Number(m[4])).padStart(2, '0') + ':' + m[5];
  return (Number(m[1]) === new Date().getFullYear() ? md : m[1] + '-' + md) + ' ' + hm;
}

function closePicker() {
  const el = $('picker');
  if (el) el.classList.add('hidden');
  const mask = $('pk-mask');
  if (mask) mask.classList.add('hidden');
  PK = null;
}

/** 打开选择器：anchor=锚点元素，current=当前值，onPick(值)=确定后回调（'' = 立即发布） */
function openPicker(anchor, current, onPick) {
  const m = String(current || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  const now = new Date();
  const sel = m
    ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])
    : new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes() + 1);
  PK = { sel, viewY: sel.getFullYear(), viewM: sel.getMonth(), onPick, anchor };
  const err = $('pk-err');
  err.classList.add('hidden');
  err.textContent = '';
  renderPicker();
  const el = $('picker');
  el.classList.remove('hidden');
  $('pk-mask').classList.remove('hidden');
  // 定位：默认贴锚点下方；越界就往左/往上挪
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth || 344;
  const h = el.offsetHeight || 320;
  let x = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
  let y = r.bottom + 6;
  if (y + h > window.innerHeight - 8) y = Math.max(8, r.top - h - 6);
  el.style.left = x + 'px';
  el.style.top = y + 'px';
}

function renderPicker() {
  if (!PK) return;
  $('pk-title').textContent = PK.viewY + '年' + (PK.viewM + 1) + '月';
  const pad = (x) => String(x).padStart(2, '0');
  const first = new Date(PK.viewY, PK.viewM, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(PK.viewY, PK.viewM + 1, 0).getDate();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push('<span class="pk-day empty"></span>');
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(PK.viewY, PK.viewM, d);
    const past = dt.getTime() < today.getTime();
    const isToday = dt.getTime() === today.getTime();
    const isSel = PK.sel.getFullYear() === PK.viewY && PK.sel.getMonth() === PK.viewM && PK.sel.getDate() === d;
    cells.push(
      '<button class="pk-day' + (past ? ' off' : '') + (isToday ? ' today' : '') + (isSel ? ' sel' : '') + '" data-d="' + d + '"' + (past ? ' disabled' : '') + '>' + d + '</button>'
    );
  }
  $('pk-days').innerHTML = cells.join('');
  const hh = [];
  for (let h = 0; h < 24; h++) hh.push('<button class="pk-item' + (PK.sel.getHours() === h ? ' sel' : '') + '" data-h="' + h + '">' + pad(h) + '</button>');
  const mm = [];
  for (let mi = 0; mi < 60; mi++) mm.push('<button class="pk-item' + (PK.sel.getMinutes() === mi ? ' sel' : '') + '" data-m="' + mi + '">' + pad(mi) + '</button>');
  $('pk-h').innerHTML = hh.join('');
  $('pk-m').innerHTML = mm.join('');
  // 把选中的时/分滚到可视区中间
  setTimeout(() => {
    const hEl = $('pk-h').querySelector('[data-h="' + PK.sel.getHours() + '"]');
    if (hEl) hEl.scrollIntoView({ block: 'center' });
    const mEl = $('pk-m').querySelector('[data-m="' + PK.sel.getMinutes() + '"]');
    if (mEl) mEl.scrollIntoView({ block: 'center' });
  }, 0);
}

// 选择器点击总入口
if ($('picker')) {
  $('pk-mask').addEventListener('click', closePicker);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && PK) closePicker();
  });
  $('picker').addEventListener('click', (e) => {
    if (!PK) return;
    const err = $('pk-err');
    const clearErr = () => {
      err.classList.add('hidden');
      err.textContent = '';
    };
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      const k = Number(nav.dataset.nav);
      if (Math.abs(k) === 12) PK.viewY += k / 12;
      else {
        PK.viewM += k;
        if (PK.viewM < 0) { PK.viewM = 11; PK.viewY--; }
        if (PK.viewM > 11) { PK.viewM = 0; PK.viewY++; }
      }
      renderPicker();
      return;
    }
    const day = e.target.closest('.pk-day');
    if (day && !day.disabled && !day.classList.contains('empty')) {
      PK.sel = new Date(PK.viewY, PK.viewM, Number(day.dataset.d), PK.sel.getHours(), PK.sel.getMinutes());
      renderPicker();
      return;
    }
    const hi = e.target.closest('#pk-h .pk-item');
    if (hi) { PK.sel.setHours(Number(hi.dataset.h)); clearErr(); renderPicker(); return; }
    const mi = e.target.closest('#pk-m .pk-item');
    if (mi) { PK.sel.setMinutes(Number(mi.dataset.m)); clearErr(); renderPicker(); return; }
    if (e.target.closest('#pk-today')) {
      const n = new Date();
      PK.viewY = n.getFullYear();
      PK.viewM = n.getMonth();
      PK.sel = new Date(n.getFullYear(), n.getMonth(), n.getDate(), PK.sel.getHours(), PK.sel.getMinutes());
      renderPicker();
      return;
    }
    if (e.target.closest('#pk-now')) {
      const n = new Date();
      n.setMinutes(n.getMinutes() + 1); // 此刻 = 下一分钟，避免一确定就成过去
      PK.sel = new Date(n.getFullYear(), n.getMonth(), n.getDate(), n.getHours(), n.getMinutes());
      PK.viewY = n.getFullYear();
      PK.viewM = n.getMonth();
      clearErr();
      renderPicker();
      return;
    }
    if (e.target.closest('#pk-clear')) {
      const cb = PK.onPick;
      closePicker();
      if (cb) cb('');
      return;
    }
    if (e.target.closest('#pk-ok')) {
      const pad = (x) => String(x).padStart(2, '0');
      const d = PK.sel;
      const text = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      if (d.getTime() <= Date.now()) {
        err.textContent = '这个时间已经过了，换一个';
        err.classList.remove('hidden');
        return;
      }
      const cb = PK.onPick;
      closePicker();
      if (cb) cb(text);
      return;
    }
  });
}

/** 番茄后台卡片：账号里所有作品 + 本地对应关系 + 记录同步情况 */
function renderPlatform(p) {
  const box = $('platform-body');
  const timeEl = $('platform-time');
  if (!box) return;
  if (!p || !p.books || !p.books.length) {
    box.innerHTML = '<div class="muted" style="padding:10px 12px">还没刷新过（面板打开时会自动刷新一次）</div>';
    if (timeEl) timeEl.textContent = p && p.updatedAt ? '最后刷新：' + p.updatedAt : '还没刷新过';
    return;
  }
  box.innerHTML = p.books
    .map((b) => {
      const local = b.localBook
        ? `<span class="pill published">本地有</span> <b>${esc(b.localBook)}</b>${
            b.note
              ? `　<span class="note">${esc(b.note)}</span>`
              : `　已记 ${b.localPublished} 条${b.imported ? `，本次导入 ${b.imported} 条` : ''}${
                  b.mismatch && b.mismatch.length ? `　<span class="note">⚠ ${b.mismatch.length} 章对不上</span>` : ''
                }`
          }`
        : '<span class="pill pending">本地没有</span>';
      return `<div class="platform-row">
        <div class="pr-name">${esc(b.name)}</div>
        <div class="pr-meta">后台 共 ${b.platformTotal} 章（最新第 ${b.platformLast} 章）${b.platformFetched != null ? `，拉到 ${b.platformFetched} 条` : ''}</div>
        <div class="pr-local">${local}</div>
      </div>`;
    })
    .join('');
  if (timeEl) timeEl.textContent = '最后刷新：' + (p.updatedAt || '?');
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
  // ★★ 忙闲状态以服务端为准对账（2026-10-09）：
  //   漏掉 SSE 的 job 事件、或页面在任务跑着时刷新过 —— 都会让按钮卡在错误的
  //   忙/闲状态；每次 refresh 时和服务端 jobs 对齐一次，自愈。
  const srvBusy = !!(s && s.jobs);
  if (srvBusy && !busy) setBusy(true, s.jobs.name);
  else if (!srvBusy && busy) setBusy(false);
  $('fatal').classList.add('hidden');
  $('main').classList.remove('hidden');
  $('boot').classList.add('hidden');

  renderStats(s);
  renderBooks(s);
  renderChapters(s);
  renderPlatform(s.platform);
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
  await refreshBooks();
}

/* ---------------- 动作 ---------------- */

async function post(url, body) {
  // ★★ 绝不抛出：网络层失败（服务器抖动/刷新/连接断了）或响应不是 JSON 时，
  //   抛出的异常会跳过调用方的收尾逻辑（setBusy(false) 等）—— 实测表现：
  //   「开始发布」之后面板所有按钮永久禁用，只能刷新页面。这里统一兜成 {ok:false}。
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const j = await r.json().catch(() => null);
    if (j == null) return { ok: false, error: '面板返回了看不懂的内容（HTTP ' + r.status + '），刷新页面试试' };
    return j;
  } catch (e) {
    return { ok: false, error: '请求失败（面板可能重启或断开了）：' + ((e && e.message) || e) };
  }
}

function setBusy(on, name) {
  busy = on;
  $('btn-stop').classList.toggle('hidden', !on);
  if (on) {
    for (const id of ['btn-publish', 'btn-dry', 'btn-lint', 'btn-split', 'btn-check']) $(id).disabled = true;
    setHint('正在跑：' + (name || '任务') + '…');
  }
  updateBatchButtons();
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
  // ★ 平台定时发布：输入框填了时间就带上 --at（留空 = 立即发布，旧行为）。
  //   解析/规范化在服务端做（app.js 是浏览器脚本，require 不了 util 模块），
  //   不合法时 /api/run 会返回 400 + 人话原因，走下面的启动失败分支显示出来。
  const at = String(($('schedule-at') || {}).value || '').trim();
  if (at) {
    const segs = at.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    logLine(
      'sys',
      segs.length > 1
        ? `  ⏰ 平台定时：${segs.length} 个时间段（${segs.join('、')}）按发布顺序逐章对应，不够循环、不够晚顺延次日`
        : `  ⏰ 平台定时：将用番茄自带的定时发布，时间 = ${at}（到点才向读者展示）`
    );
    run('publish', ['--at', at], `一键发布（定时 ${at}）`);
    return;
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

/* ---------------- 书籍总览 / 批量排队 ---------------- */

async function doSwitch(name) {
  if (!name || (STATE && STATE.current.name === name)) return;
  PICKED_CH.clear(); // 换了书，章节勾选必须清掉 —— 别把 A 书的 seq 带到 B 书
  logLine('sys', `──── 切换当前小说 → ${name} ────`);
  const r = await post('/api/switch', { name });
  if (!r.ok) logLine('err', r.error || '切换失败');
  else logLine('ok', `已切换到「${r.name}」`);
  await refresh();
}

$('book-select').addEventListener('change', (e) => doSwitch(e.target.value));

// 卡片上的按钮（用事件委托 —— 卡片是整块重绘的，逐个绑会漏）
$('book-grid').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const name = btn.dataset.name;
  if (btn.dataset.act === 'switch') return void doSwitch(name);
  if (btn.dataset.act === 'only') {
    PICKED.clear();
    PICKED.add(name);
    if (BOOKS) renderOverview(BOOKS);
  }
});

// 勾选框
$('book-grid').addEventListener('change', (e) => {
  const cb = e.target.closest('.bc-check');
  if (!cb) return;
  const name = cb.dataset.name;
  if (cb.checked) PICKED.add(name);
  else PICKED.delete(name);
  const card = cb.closest('.book-card');
  if (card) card.classList.toggle('picked', cb.checked);
  updateBatchButtons();
});

$('btn-ov-ready').addEventListener('click', () => {
  if (!BOOKS) return;
  PICKED.clear();
  for (const b of BOOKS.books) if (sendable(b)) PICKED.add(b.name);
  if (!PICKED.size) logLine('warn', '没有「现在点一下就能发」的书 —— 要么都发完了，要么今天的额度用完了。');
  renderOverview(BOOKS);
});

$('btn-ov-none').addEventListener('click', () => {
  PICKED.clear();
  if (BOOKS) renderOverview(BOOKS);
});

$('btn-ov-lint').addEventListener('click', () => runBatch('lint'));
$('btn-ov-publish').addEventListener('click', () => runBatch('publish'));

async function runBatch(cmd) {
  if (busy || !PICKED.size || !BOOKS) return;

  // 按「总览里的显示顺序」排 —— 和用户看到的从上到下一致，不按勾选先后（那没法预期）
  const order = BOOKS.books.map((b) => b.name).filter((n) => PICKED.has(n));
  const lines = order.map((n) => {
    const b = BOOKS.books.find((x) => x.name === n);
    const c = sendable(b);
    return `  · ${n}　${c ? `本次会发 ${c} 章 / ${b.plan.chars} 字` : '现在没有可发的章节'}`;
  });

  if (cmd === 'publish') {
    // ★ 这一步是"控制权留给你"的地方：批量会真发到线上，必须明确确认一次
    const yes = window.confirm(
      `即将依次发布 ${order.length} 本书：\n\n${lines.join('\n')}\n\n` +
        '· 按上面的顺序一本一本发，所有书共用同一个日额度（前面发的字都算进总额）\n' +
        '· 发到线上不可撤销（点「停止」也只停后面的，已发的不会撤回）\n\n确认开始？'
    );
    if (!yes) return;
  }

  const label = cmd === 'publish' ? '批量发布' : '批量校验';
  logLine('sys', `──── 开始：${label}（${order.length} 本）────`);
  for (const l of lines) logLine('sys', l);
  setBusy(true, label);

  const r = await post('/api/batch', { books: order, cmd });
  if (!r.ok) {
    logLine('err', r.error || '启动失败');
    setBusy(false);
    setHint('启动失败', 'err');
  }
}

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
  // ★ 新书防"从头重发"：如果番茄后台已经有这本书的章节（手动发过/别处发过），
  //   拆分完点章节表上方的「导入后台记录」，发布就会自动跳过已发的。
  logLine('sys', '注意：如果这本书在番茄后台已经有发过的章节，拆分后点「导入后台记录」，发布就不会从头重发。');
  await refresh();
});

// ★「刷新后台状态」：连番茄后台 → 列出账号所有作品 + 同步已发/未发记录。
//   章节卡的按钮和「番茄后台」卡片上的按钮是同一个动作。
function refreshBackend() {
  const b = STATE && STATE.current;
  const yes = window.confirm(
    `连上番茄后台刷新状态\n\n` +
      '· 列出你账号里的所有作品（看看有没有以前的旧书）\n' +
      '· 把后台已发的章节记录同步到本地（发布时会自动跳过，防止重发）\n' +
      '· 只读后台，不会发布/修改任何章节\n\n确认开始？' +
      (b ? `\n（当前小说：「${b.name}」）` : '')
  );
  if (!yes) return;
  run('sync-records', b ? ['--book', b.name] : [], '刷新后台状态');
}
$('btn-import-records') && $('btn-import-records').addEventListener('click', refreshBackend);
$('btn-refresh-backend') && $('btn-refresh-backend').addEventListener('click', refreshBackend);

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

/* ---------------- 自选章节发布 ---------------- */

// 章节行是整块重绘的，勾选事件用委托
$('chapter-body').addEventListener('change', (e) => {
  const cb = e.target.closest('.ch-check');
  if (!cb) return;
  const seq = Number(cb.dataset.seq);
  if (cb.checked) PICKED_CH.add(seq);
  else PICKED_CH.delete(seq);
  const tr = cb.closest('tr');
  if (tr) tr.classList.toggle('row-picked', cb.checked);
  updateSelectedButton();
});

// ★ 逐章定时的按钮：点开日历+时间选择器，确定即记（值存 PICKED_TIME，整表重绘不丢）
$('chapter-body').addEventListener('click', (e) => {
  const btn = e.target.closest('.row-time-btn');
  if (!btn) return;
  const seq = Number(btn.dataset.seq);
  openPicker(btn, PICKED_TIME.get(seq) || '', (v) => {
    if (v) PICKED_TIME.set(seq, v);
    else PICKED_TIME.delete(seq);
    btn.textContent = fmtPickValue(v);
    btn.classList.toggle('has', !!v);
    updateSelectedButton();
  });
});

// 顶部「选时间…」：挑一个时间写进统一的定时输入框
$('btn-pick-at') &&
  $('btn-pick-at').addEventListener('click', (e) => {
    const inp = $('schedule-at');
    openPicker(e.currentTarget, String(inp.value || '').trim(), (v) => {
      inp.value = v || '';
    });
  });

$('btn-publish-selected').addEventListener('click', () => {
  const items = selectedChapters();
  if (!items.length || busy) return;

  // ★★ 逐章定时 + 顶部统一时间的联动（2026-10-09 修：之前顶部填了会被静默忽略）：
  //   · 顶部空 → 行内为准，没填的行 = 立即发布
  //   · 顶部有值、行内全没填 → 顶部作为统一时间（--at，按序铺 + 不够顺延次日，原语义）
  //   · 顶部有值、部分行填了 → 填了的用行内时间；**没填的行用顶部时间补齐（循环使用）**
  const topAt = String(($('schedule-at') || {}).value || '').trim();
  const topSegs = topAt ? topAt.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [];
  const anyRowTime = items.some((c) => String(PICKED_TIME.get(c.seq) || '').trim());
  const useTopAsAt = !!topAt && !anyRowTime; // 全都没填 → 走 --at（保留"按序铺、不够顺延"的语义）
  let cycle = 0;
  const rows = items.map((c) => {
    const own = String(PICKED_TIME.get(c.seq) || '').trim();
    let t = own;
    let fromTop = false;
    if (!own && topAt && topSegs.length) {
      if (!useTopAsAt) {
        // 部分行填了时间：没填的用顶部时间补齐（循环使用）
        t = topSegs[cycle++ % topSegs.length];
        fromTop = !!t;
      } else {
        // 全都没填：实际走 --at（按序铺 + 不够顺延次日）——
        // 展示按 时间段的循环顺序，日期以运行日志为准
        t = topSegs[cycle++ % topSegs.length];
        fromTop = true;
      }
    }
    return { c, t, fromTop };
  });
  const mapPairs = [];
  const lines = rows.map(({ c, t, fromTop }) => {
    const no = c.no == null ? c.seq : c.no;
    if (t) {
      if (!useTopAsAt) mapPairs.push(no + '=' + t);
      return `  · ${c.title}（${c.chars} 字）→ ⏰ ${t}${fromTop ? (useTopAsAt ? '（统一时间，日期按运行日志）' : '（统一时间）') : ''}`;
    }
    return `  · ${c.title}（${c.chars} 字）→ 立即发布`;
  });
  const total = items.reduce((s, c) => s + (Number(c.chars) || 0), 0);
  const q = STATE && STATE.quota;
  let quotaNote = '';
  if (q && q.enabled) {
    quotaNote =
      total > Math.max(0, q.remain)
        ? `\n⚠ 选中共 ${total} 字，账号额度只剩 ${q.remain} 字（所有书共用）\n  → 放得下的先发，放不下的留到明天`
        : `\n账号额度还剩 ${q.remain} 字，选中的 ${total} 字放得下`;
  }
  const timedN = rows.filter((r) => r.t).length;
  const schedNote = timedN
    ? `\n定时：${timedN} 章用番茄自带的定时发布（到点才向读者放出）${useTopAsAt ? '，时间按顶部输入框' : ''}\n`
    : '';

  // ★ 发到线上不可撤销，和「排队发布」一样：这一步必须用户自己按
  const yes = window.confirm(
    `即将发布你选的 ${items.length} 章：\n\n${lines.join('\n')}\n${schedNote}${quotaNote}\n\n` +
      '· 发到线上不可撤销\n\n确认开始？'
  );
  if (!yes) return;

  const args = ['--chapter', items.map((c) => c.seq).join(',')];
  if (useTopAsAt) args.push('--at', topAt);
  else if (mapPairs.length) args.push('--schedule-map', mapPairs.join(','));
  const timedCount = rows.filter((r) => r.t).length;
  run('publish', args, `发布所选（${items.length} 章${timedCount ? '，' + timedCount + ' 章定时' : ''}）`);
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
      // ★ 批量队列里每一步都会各来一次 job end —— 这时**不能**清 busy，
      //   否则页面会在步骤之间闪回"就绪"，甚至放开按钮让用户插入别的任务
      if (queueActive) return;
      setBusy(false);
      const bad = d.code !== 0;
      setHint(bad ? `${d.name} 结束（退出码 ${d.code}）` : `${d.name} 完成`, bad ? 'err' : 'ok');
      $('btn-publish').disabled = false;
      await refresh();
    }
  });

  // 批量队列的进度（哪一本、第几本 / 共几本）
  es.addEventListener('queue', async (e) => {
    const d = JSON.parse(e.data);
    if (d.status === 'start') {
      queueActive = true;
      setBusy(true, d.label);
      logLine('sys', `排队顺序：${d.names.join(' → ')}`);
    } else if (d.status === 'step') {
      logLine('sys', `▶ 第 ${d.index + 1}/${d.total} 本：${d.name}`);
      setBusy(true, `${d.label} ${d.index + 1}/${d.total}`);
    } else if (d.status === 'end') {
      queueActive = false;
      logLine('sys', `──── ${d.label}结束${d.aborted ? '（中途停止）' : ''} ────`);
      setBusy(false);
      setHint(d.aborted ? `${d.label}已停止` : `${d.label}完成（${d.total} 本）`, d.aborted ? 'err' : 'ok');
      PICKED.clear();
      await refresh();
    }
  });

  // 面板启动时的「自动同步后台」跑完 → 拉一次最新状态（含 platform 缓存）
  es.addEventListener('platform', async () => {
    await refresh();
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
