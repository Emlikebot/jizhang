'use strict';
const APP_VERSION = '1.0.0';

/* ============ 工具函数 ============ */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const dateStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => dateStr(new Date());
const curYM = () => todayStr().slice(0, 7);
const ymOf = s => s.slice(0, 7);
function shiftYM(ym, delta) {
  let [y, m] = ym.split('-').map(Number);
  m += delta;
  while (m < 1) { m += 12; y--; }
  while (m > 12) { m -= 12; y++; }
  return `${y}-${pad(m)}`;
}
const ymLabel = ym => { const [y, m] = ym.split('-'); return `${y}年${+m}月`; };
const daysInMonth = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 金额一律以“分”为单位的整数保存，避免小数误差
function fmt(cents, { cur = 'CNY', dec = true, sign = false } = {}) {
  const sym = cur === 'USD' ? '$' : '¥';
  const neg = cents < 0;
  const s = (Math.abs(cents) / 100).toLocaleString('zh-CN', {
    minimumFractionDigits: dec ? 2 : 0, maximumFractionDigits: dec ? 2 : 0,
  });
  return (neg ? '-' : sign ? '+' : '') + sym + s;
}
function fmtShort(cents) {
  const v = cents / 100;
  if (v >= 10000) return (v / 10000).toFixed(v >= 100000 ? 0 : 1) + '万';
  return Math.round(v).toLocaleString('zh-CN');
}
function toCents(str) {
  if (!str || str === '.') return 0;
  const [i, f = ''] = str.split('.');
  return parseInt(i || '0', 10) * 100 + parseInt((f + '00').slice(0, 2), 10);
}
function evalExpr(expr) {
  let total = 0, op = '+';
  for (const p of expr.split(/([+\-])/)) {
    if (p === '+' || p === '-') { op = p; continue; }
    const v = toCents(p);
    total = op === '+' ? total + v : total - v;
  }
  return total;
}
function dayLabel(d) {
  const dt = new Date(d + 'T00:00:00');
  const t = todayStr();
  const y = dateStr(new Date(Date.now() - 86400000));
  const base = `${dt.getMonth() + 1}月${dt.getDate()}日 ${WEEK[dt.getDay()]}`;
  return d === t ? `今天 · ${base}` : d === y ? `昨天 · ${base}` : base;
}

/* ============ 本地数据库（IndexedDB） ============ */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('jizhang', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('tx')) d.createObjectStore('tx', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  _run(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  },
  all(store) { return this._run(store, 'readonly', s => s.getAll()); },
  get(store, key) { return this._run(store, 'readonly', s => s.get(key)); },
  put(store, val, key) { return this._run(store, 'readwrite', s => (key === undefined ? s.put(val) : s.put(val, key))); },
  del(store, key) { return this._run(store, 'readwrite', s => s.delete(key)); },
  putMany(store, vals) { return this._run(store, 'readwrite', s => { vals.forEach(v => s.put(v)); }); },
};

/* ============ 默认数据 ============ */
const DEFAULT_CATS = [
  ['餐饮', '🍜', 'out'], ['交通', '🚇', 'out'], ['购物', '🛍️', 'out'], ['日用', '🧻', 'out'],
  ['住房', '🏠', 'out'], ['水电通讯', '📱', 'out'], ['娱乐', '🎮', 'out'], ['医疗', '💊', 'out'],
  ['学习', '📚', 'out'], ['人情', '🎁', 'out'], ['旅行', '✈️', 'out'], ['订阅', '🔁', 'out'], ['其他', '📦', 'out'],
  ['工资', '💰', 'in'], ['奖金', '🧧', 'in'], ['理财', '📈', 'in'], ['退款', '↩️', 'in'], ['其他', '💵', 'in'],
];
const DEFAULT_METHODS = ['支付宝', '微信', '银联借记卡', '数字人民币', 'PayPal', 'Google Pay', 'Apple Pay'];
const DEFAULT_SET = {
  limit: 0,                                           // 月度警戒线（分），0 = 未设置
  rate: { value: 7.1, date: null, source: '默认值' },  // 1 美元 = ? 人民币
  lastBackup: null, lastMethod: null,
};

/* ============ 状态 ============ */
const S = { tx: [], cats: [], methods: [], set: {}, month: curYM(), tab: 'home', statType: 'out', selDay: null, selMonth: null };

async function load() {
  await DB.open();
  S.tx = (await DB.all('tx')) || [];
  S.cats = await DB.get('kv', 'cats');
  if (!S.cats) {
    S.cats = DEFAULT_CATS.map(([name, icon, type], i) => ({ id: 'c' + i, name, icon, type, hidden: false }));
    await DB.put('kv', S.cats, 'cats');
  }
  S.methods = await DB.get('kv', 'methods');
  if (!S.methods) { S.methods = [...DEFAULT_METHODS]; await DB.put('kv', S.methods, 'methods'); }
  S.set = Object.assign({}, DEFAULT_SET, (await DB.get('kv', 'settings')) || {});
}
const saveSet = () => DB.put('kv', S.set, 'settings');
const saveCats = () => DB.put('kv', S.cats, 'cats');
const saveMethods = () => DB.put('kv', S.methods, 'methods');
const catOf = id => S.cats.find(c => c.id === id) || { name: '未分类', icon: '❔' };
const monthList = ym => S.tx.filter(t => t.date.startsWith(ym));
const monthSum = (ym, type = 'out') => S.tx.reduce((s, t) => (t.type === type && t.date.startsWith(ym) ? s + t.cny : s), 0);

/* ============ 汇率 ============ */
async function fetchJSON(url, ms = 6000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}
async function refreshRate(force = false) {
  const today = todayStr();
  if (!force && S.set.rate.date === today) return true;
  const sources = [
    ['ExchangeRate-API', 'https://open.er-api.com/v6/latest/USD', j => j.rates && j.rates.CNY],
    ['Frankfurter', 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY', j => j.rates && j.rates.CNY],
  ];
  for (const [name, url, pick] of sources) {
    try {
      const v = pick(await fetchJSON(url));
      if (v > 0) {
        S.set.rate = { value: +(+v).toFixed(4), date: today, source: name };
        await saveSet();
        return true;
      }
    } catch (e) { /* 换下一个来源 */ }
  }
  return false;
}

/* ============ 渲染：顶栏 ============ */
const ICON_GEAR = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';
function renderTop() {
  const tb = $('#topbar');
  if (S.tab === 'settings') {
    tb.innerHTML = `<button class="icon-btn" data-act="tab" data-v="home" aria-label="返回">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 5l-7 7 7 7"/></svg></button>
      <div class="title">设置</div><div></div>`;
    return;
  }
  const next = S.month < curYM();
  tb.innerHTML = `<div></div>
    <div class="title">
      <button class="mbtn" data-act="month" data-v="-1" aria-label="上个月">‹</button>
      <span class="month-label" data-act="month" data-v="0">${ymLabel(S.month)}</span>
      <button class="mbtn" data-act="month" data-v="1" aria-label="下个月" style="${next ? '' : 'visibility:hidden'}">›</button>
    </div>
    <button class="icon-btn" data-act="tab" data-v="settings" aria-label="设置">${ICON_GEAR}</button>`;
}

/* ============ 渲染：明细页 ============ */
function budgetCard(ym, out) {
  const L = S.set.limit;
  if (!L) {
    return `<div class="card budget none" data-act="goLimit">
      <div class="b-top"><span>${ymLabel(ym)}支出</span></div>
      <div class="b-amount num">${fmt(out)}</div>
      <div class="b-hint">设置一条月度警戒线，超支时会醒目提醒 →</div></div>`;
  }
  const p = out / L;
  const lvl = p >= 1 ? 'over' : p >= 0.8 ? 'warn' : 'ok';
  const msg = lvl === 'over' ? `🚨 已超出警戒线 ${fmt(out - L)}`
    : lvl === 'warn' ? `⚠️ 接近警戒线，只剩 ${fmt(L - out)}`
    : `还可以花 ${fmt(L - out)}`;
  let sub = `已用 ${Math.round(p * 100)}%`;
  if (ym === curYM() && lvl !== 'over') {
    const left = daysInMonth(ym) - new Date().getDate() + 1;
    sub += ` · 剩余 ${left} 天，日均可花 ${fmt(Math.floor((L - out) / left))}`;
  }
  return `<div class="card budget ${lvl}" data-act="goStats">
    <div class="b-top"><span>${ymLabel(ym)}支出</span><span>警戒线 ${fmt(L, { dec: false })}</span></div>
    <div class="b-amount num">${fmt(out)}</div>
    <div class="bar"><div style="width:${Math.min(100, p * 100).toFixed(1)}%"></div><i style="left:80%"></i></div>
    <div class="b-msg">${msg}</div>
    <div class="b-sub">${sub}</div></div>`;
}
function backupBanner() {
  if (S.tx.length < 10) return '';
  const lb = S.set.lastBackup;
  const days = lb ? Math.floor((Date.now() - lb) / 86400000) : null;
  if (days !== null && days < 30) return '';
  return `<div class="banner" data-act="goBackup">💾 ${lb ? `已经 ${days} 天没有备份了` : '你还没有备份过数据'}，点这里去备份</div>`;
}
function txRow(t) {
  const c = catOf(t.categoryId);
  const sub = [t.method, t.currency === 'USD' ? `${fmt(t.amount, { cur: 'USD' })} × ${t.rate}` : ''].filter(Boolean).join(' · ');
  return `<div class="tx" data-act="edit" data-id="${t.id}">
    <div class="ic">${esc(c.icon)}</div>
    <div class="mid"><div class="nm">${esc(c.name)}${t.note ? ` <span class="note">${esc(t.note)}</span>` : ''}</div>
      ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>
    <div class="amt num ${t.type}">${t.type === 'out' ? '-' : '+'}${fmt(t.cny).slice(1)}</div></div>`;
}
function renderHome() {
  const ym = S.month;
  const list = monthList(ym).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  const out = monthSum(ym, 'out'), inc = monthSum(ym, 'in');
  let html = backupBanner() + budgetCard(ym, out);
  html += `<div class="sumrow">
    <div class="card"><div class="k">收入</div><div class="v num">${fmt(inc)}</div></div>
    <div class="card"><div class="k">结余</div><div class="v num">${fmt(inc - out)}</div></div></div>`;
  if (!list.length) {
    html += `<div class="empty">${ymLabel(ym)}还没有记录<br>点下方 <b>＋</b> 记一笔</div>`;
  } else {
    const groups = {};
    list.forEach(t => (groups[t.date] ||= []).push(t));
    for (const d of Object.keys(groups).sort().reverse()) {
      const g = groups[d];
      const dOut = g.reduce((s, t) => (t.type === 'out' ? s + t.cny : s), 0);
      const dIn = g.reduce((s, t) => (t.type === 'in' ? s + t.cny : s), 0);
      const tot = [dOut ? `支出 ${fmt(dOut)}` : '', dIn ? `收入 ${fmt(dIn)}` : ''].filter(Boolean).join('  ');
      html += `<div class="day"><div class="day-h"><span>${dayLabel(d)}</span><span class="num">${tot}</span></div>${g.map(txRow).join('')}</div>`;
    }
  }
  $('#view').innerHTML = html;
}

/* ============ 渲染：统计页 ============ */
function hbars(rows, total) {
  // rows: [{icon,label,value,count}] 已按金额降序
  const max = Math.max(...rows.map(r => r.value), 1);
  return rows.map(r => `<div class="hrow ${r.icon ? '' : 'noic'}">
      ${r.icon ? `<div class="ic">${esc(r.icon)}</div>` : ''}
      <div class="lbl"><span>${esc(r.label)}</span><span>${r.count} 笔 · ${total ? ((r.value / total) * 100).toFixed(1) : 0}%</span></div>
      <div class="val num">${fmt(r.value)}</div>
      <div class="track"><div style="width:${((r.value / max) * 100).toFixed(1)}%"></div></div></div>`).join('');
}
function renderStats() {
  const ym = S.month;
  const list = monthList(ym);
  const out = monthSum(ym, 'out'), inc = monthSum(ym, 'in');
  const dim = daysInMonth(ym);
  const elapsed = ym === curYM() ? new Date().getDate() : ym < curYM() ? dim : 1;
  let html = `<div class="stat-grid">
    <div class="card"><div class="k">支出</div><div class="v num">${fmt(out)}</div></div>
    <div class="card"><div class="k">收入</div><div class="v num">${fmt(inc)}</div></div>
    <div class="card"><div class="k">结余</div><div class="v num">${fmt(inc - out)}</div></div>
    <div class="card"><div class="k">日均支出</div><div class="v num">${fmt(Math.round(out / elapsed))}</div></div></div>`;

  // 分类排行
  const type = S.statType;
  const byCat = {};
  list.filter(t => t.type === type).forEach(t => {
    const r = (byCat[t.categoryId] ||= { value: 0, count: 0 });
    r.value += t.cny; r.count++;
  });
  const catRows = Object.entries(byCat).map(([id, r]) => ({ ...r, icon: catOf(id).icon, label: catOf(id).name })).sort((a, b) => b.value - a.value);
  const catTotal = type === 'out' ? out : inc;
  html += `<div class="card"><div class="card-h"><h3>分类排行</h3>
    <div class="seg"><button class="${type === 'out' ? 'on' : ''}" data-act="statType" data-v="out">支出</button><button class="${type === 'in' ? 'on' : ''}" data-act="statType" data-v="in">收入</button></div></div>
    ${catRows.length ? hbars(catRows, catTotal) : '<div class="hint">这个月还没有记录</div>'}</div>`;

  // 每日支出
  const daily = Array(dim).fill(0);
  list.forEach(t => { if (t.type === 'out') daily[+t.date.slice(8) - 1] += t.cny; });
  const dmax = Math.max(...daily, 1);
  const sel = S.selDay && S.selDay <= dim ? S.selDay : null;
  const readout = sel ? `<b>${+ym.slice(5)}月${sel}日</b> 支出 <b class="num">${fmt(daily[sel - 1])}</b>`
    : `最高一天 <b class="num">${fmt(Math.max(...daily))}</b>　点柱子看每天金额`;
  html += `<div class="card"><h3>每日支出</h3><div class="readout">${readout}</div>
    <div class="vbars">${daily.map((v, i) => `<div class="b ${v ? '' : 'zero'} ${sel === i + 1 ? 'sel' : ''}" data-act="selDay" data-v="${i + 1}"><div style="height:${((v / dmax) * 100).toFixed(1)}%"></div></div>`).join('')}</div>
    <div class="axis">${daily.map((_, i) => `<span>${(i + 1) % 5 === 0 || i === 0 ? i + 1 : ''}</span>`).join('')}</div></div>`;

  // 支付方式
  const byM = {};
  list.filter(t => t.type === 'out').forEach(t => {
    const k = t.method || '未填写';
    const r = (byM[k] ||= { value: 0, count: 0 });
    r.value += t.cny; r.count++;
  });
  const mRows = Object.entries(byM).map(([k, r]) => ({ ...r, label: k, icon: '' })).sort((a, b) => b.value - a.value);
  html += `<div class="card"><h3>支付方式（支出）</h3>${mRows.length ? hbars(mRows, out) : '<div class="hint">这个月还没有支出</div>'}</div>`;

  // 近 6 个月
  const months = [...Array(6)].map((_, i) => shiftYM(ym, i - 5));
  const mv = months.map(m => monthSum(m, 'out'));
  const L = S.set.limit;
  const mmax = Math.max(...mv, L * 1.1, 1);
  const selM = S.selMonth && months.includes(S.selMonth) ? S.selMonth : null;
  const mReadout = selM ? `<b>${ymLabel(selM)}</b> 支出 <b class="num">${fmt(mv[months.indexOf(selM)])}</b>${L ? (mv[months.indexOf(selM)] > L ? ' · 超出警戒线' : ' · 未超警戒线') : ''}`
    : (L ? `红色虚线是警戒线 ${fmt(L, { dec: false })}，超支的月份标红` : '在设置里填警戒线后，这里会显示对比线');
  html += `<div class="card"><h3>近 6 个月支出</h3><div class="readout">${mReadout}</div>
    <div class="vbars mbars">${months.map((m, i) => `<div class="b ${L && mv[i] > L ? 'over' : ''} ${selM === m ? 'sel' : ''}" data-act="selMonth" data-v="${m}">
      <span class="v num">${mv[i] ? fmtShort(mv[i]) : ''}</span><div style="height:${((mv[i] / mmax) * 82).toFixed(1)}%"></div></div>`).join('')}
      ${L ? `<div class="limit" style="bottom:${((L / mmax) * 82).toFixed(1)}%"><span>警戒线</span></div>` : ''}</div>
    <div class="axis" style="gap:10px">${months.map(m => `<span>${+m.slice(5)}月</span>`).join('')}</div></div>`;

  $('#view').innerHTML = html;
}

/* ============ 渲染：设置页 ============ */
function catListHTML(type) {
  const cats = S.cats.filter(c => c.type === type && !c.hidden);
  return cats.map((c, i) => `<div class="srow"><div class="ic">${esc(c.icon)}</div><div class="grow">${esc(c.name)}</div>
      ${i > 0 ? `<button class="sbtn" data-act="catUp" data-id="${c.id}">↑</button>` : ''}
      <button class="sbtn danger" data-act="catDel" data-id="${c.id}">删除</button></div>`).join('') +
    `<div class="inline" style="margin-top:10px"><input class="tinput emoji-in" id="newCatIcon-${type}" placeholder="😀" maxlength="4">
      <input class="tinput" id="newCatName-${type}" placeholder="新分类名称" maxlength="8">
      <button class="pbtn" data-act="catAdd" data-v="${type}">添加</button></div>`;
}
function renderSettings() {
  const r = S.set.rate;
  const lb = S.set.lastBackup ? new Date(S.set.lastBackup).toLocaleString('zh-CN', { hour12: false }) : '从未备份';
  $('#view').innerHTML = `
  <div class="card" id="sec-limit"><h3>🚨 月度警戒线</h3>
    <div class="inline"><span>¥</span><input class="tinput num" id="limitInput" type="number" inputmode="decimal" placeholder="例如 5000" value="${S.set.limit ? S.set.limit / 100 : ''}">
    <button class="pbtn" data-act="saveLimit">保存</button></div>
    <p class="hint">每月支出达到 80% 时黄色提醒，超过时全屏红色提醒，首页卡片也会一直保持红色。填 0 或留空表示关闭。</p></div>

  <div class="card"><h3>💵 美元汇率</h3>
    <div class="inline"><span>1 USD =</span><input class="tinput num" id="rateInput" type="number" inputmode="decimal" step="0.0001" value="${r.value}"><span>CNY</span></div>
    <div class="inline" style="margin-top:10px"><button class="gbtn" style="margin:0" data-act="saveRate">保存手动汇率</button><button class="gbtn" style="margin:0" data-act="refreshRate">联网更新</button></div>
    <p class="hint">当前：${r.source}${r.date ? `，${r.date} 更新` : '（请联网更新或手动填写）'}。每天第一次打开会自动更新。记美元账时可以单独修改那一笔的汇率或人民币金额，以银行实际扣款为准。<br>
    汇率数据来自 <a href="https://www.exchangerate-api.com" target="_blank" rel="noopener">ExchangeRate-API</a></p></div>

  <div class="card"><h3>支出分类</h3>${catListHTML('out')}</div>
  <div class="card"><h3>收入分类</h3>${catListHTML('in')}</div>

  <div class="card"><h3>支付方式</h3>
    ${S.methods.map((m, i) => `<div class="srow"><div class="grow">${esc(m)}</div>
      ${i > 0 ? `<button class="sbtn" data-act="mUp" data-v="${i}">↑</button>` : ''}
      <button class="sbtn danger" data-act="mDel" data-v="${i}">删除</button></div>`).join('')}
    <div class="inline" style="margin-top:10px"><input class="tinput" id="newMethod" placeholder="新支付方式" maxlength="12"><button class="pbtn" data-act="mAdd">添加</button></div></div>

  <div class="card" id="sec-backup"><h3>💾 数据备份</h3>
    <p class="hint" style="margin-top:0">上次备份：${lb}　·　共 ${S.tx.length} 笔记录</p>
    <button class="gbtn" data-act="exportJSON">导出备份文件（可用于恢复）</button>
    <button class="gbtn" data-act="exportCSV">导出表格（CSV，可用 Excel 打开）</button>
    <button class="gbtn" data-act="importJSON">从备份文件恢复</button>
    <p class="hint">数据只保存在这台手机上。建议每月备份一次，在弹出的分享菜单里选「存储到文件」，存进 iCloud 云盘。</p></div>

  <div class="card"><h3>关于</h3>
    <p class="hint" style="margin-top:0">版本 ${APP_VERSION}　·　<span id="persistInfo"></span></p>
    <button class="gbtn" data-act="checkUpdate">检查更新</button></div>`;
  if (navigator.storage && navigator.storage.persisted) {
    navigator.storage.persisted().then(p => { const el = $('#persistInfo'); if (el) el.textContent = p ? '存储已持久化' : '存储未持久化（请从主屏幕图标打开）'; });
  }
}

function render() {
  renderTop();
  $('#tab-home').classList.toggle('on', S.tab === 'home');
  $('#tab-stats').classList.toggle('on', S.tab === 'stats');
  if (S.tab === 'home') renderHome();
  else if (S.tab === 'stats') renderStats();
  else renderSettings();
}

/* ============ 记账面板 ============ */
let F = null; // 正在编辑的表单
function openSheet(tx) {
  if (tx) {
    F = {
      id: tx.id, type: tx.type, cur: tx.currency, expr: String(tx.amount / 100).replace(/\.0+$/, ''),
      rate: tx.rate, cnyOverride: tx.currency === 'USD' ? tx.cny : null, catId: tx.categoryId,
      method: tx.method, date: tx.date, note: tx.note || '',
    };
  } else {
    F = {
      id: null, type: 'out', cur: 'CNY', expr: '', rate: S.set.rate.value, cnyOverride: null,
      catId: null, method: S.set.lastMethod && S.methods.includes(S.set.lastMethod) ? S.set.lastMethod : S.methods[0] || '',
      date: todayStr(), note: '',
    };
  }
  renderSheet();
  $('#mask').classList.add('show');
  $('#sheet').classList.add('show');
}
function closeSheet() {
  $('#mask').classList.remove('show');
  $('#sheet').classList.remove('show');
  F = null;
}
function renderSheet() {
  const cats = S.cats.filter(c => c.type === F.type && (!c.hidden || c.id === F.catId));
  const methods = F.method && !S.methods.includes(F.method) ? [...S.methods, F.method] : S.methods;
  $('#sheet').innerHTML = `
    <div class="sh-head">
      <button class="lnk" data-act="closeSheet">取消</button>
      <div class="seg"><button class="${F.type === 'out' ? 'on' : ''}" data-act="setType" data-v="out">支出</button><button class="${F.type === 'in' ? 'on' : ''}" data-act="setType" data-v="in">收入</button></div>
      ${F.id ? '<button class="lnk danger" data-act="deleteTx">删除</button>' : '<span></span>'}
    </div>
    <div class="sh-body">
      <div class="amt-row">
        <button class="curbtn" data-act="toggleCur">${F.cur === 'USD' ? '$ 美元' : '¥ 人民币'} ⇄</button>
        <div class="amt-disp num" id="amtDisp"></div>
      </div>
      <div class="fx" id="fxRow" style="${F.cur === 'USD' ? '' : 'display:none'}">
        汇率 <input id="fxRate" type="text" inputmode="decimal" value="${F.rate}">
        <span class="sp"></span>折合 ¥ <input id="fxCny" type="text" inputmode="decimal">
      </div>
      <div class="cats">${cats.map(c => `<button class="cat ${c.id === F.catId ? 'on' : ''}" data-act="pickCat" data-id="${c.id}"><span class="e">${esc(c.icon)}</span>${esc(c.name)}</button>`).join('')}</div>
      <div class="chips">${methods.map(m => `<button class="chip ${m === F.method ? 'on' : ''}" data-act="pickMethod" data-v="${esc(m)}">${esc(m)}</button>`).join('')}</div>
      <div class="meta">
        <input type="date" id="fDate" value="${F.date}" max="2099-12-31">
        <input class="note" id="fNote" placeholder="备注（可不填）" maxlength="40" value="${esc(F.note)}">
      </div>
    </div>
    <div class="keypad">
      ${['1', '2', '3', 'back', '4', '5', '6', '+', '7', '8', '9', '-', '.', '0'].map(k =>
        `<button class="${'back+-'.includes(k) ? 'fn' : ''}" data-act="key" data-v="${k}">${k === 'back' ? '⌫' : k === '-' ? '−' : k}</button>`).join('')}
      <button class="ok" data-act="saveTx">${F.id ? '保存修改' : '记一笔'}</button>
    </div>`;
  updateAmount();
}
function usdCny() {
  return F.cnyOverride != null ? F.cnyOverride : Math.round(evalExpr(F.expr) * F.rate);
}
function updateAmount() {
  const d = $('#amtDisp');
  const sym = F.cur === 'USD' ? '$' : '¥';
  if (!F.expr) d.innerHTML = `<span class="ph">${sym}0</span>`;
  else if (/[+\-]/.test(F.expr)) d.innerHTML = `${esc(F.expr.replace(/-/g, '−'))}<span class="eq">= ${fmt(evalExpr(F.expr), { cur: F.cur })}</span>`;
  else d.textContent = sym + F.expr;
  if (F.cur === 'USD') {
    const c = $('#fxCny');
    if (document.activeElement !== c) c.value = F.expr ? (usdCny() / 100).toFixed(2) : '';
  }
}
function keyIn(k) {
  let e = F.expr;
  const last = e.split(/[+\-]/).pop();
  if (k === 'back') e = e.slice(0, -1);
  else if (k === '+' || k === '-') {
    if (!e) return;
    if (/[+\-]$/.test(e)) e = e.slice(0, -1);
    e += k;
  } else if (k === '.') {
    if (last.includes('.')) return;
    e += last === '' ? '0.' : '.';
  } else {
    if (/\.\d{2}$/.test(last)) return;
    if (last.replace('.', '').length >= 9) return;
    if (last === '0') e = e.slice(0, -1);
    e += k;
  }
  F.expr = e;
  F.cnyOverride = null;
  updateAmount();
}
function shake(el) { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); }

async function saveTx() {
  F.note = $('#fNote').value.trim();
  F.date = $('#fDate').value || todayStr();
  const amount = evalExpr(F.expr);
  if (amount <= 0) { shake($('#amtDisp')); toast('请输入金额'); return; }
  if (!F.catId) { shake($('.cats')); toast('请选择一个分类'); return; }
  if (F.cur === 'USD' && !(F.rate > 0)) { toast('汇率不正确'); return; }
  const old = F.id ? S.tx.find(t => t.id === F.id) : null;
  const t = {
    id: F.id || uid(), type: F.type, amount, currency: F.cur,
    rate: F.cur === 'USD' ? F.rate : 1,
    cny: F.cur === 'USD' ? usdCny() : amount,
    categoryId: F.catId, method: F.method || '', date: F.date, note: F.note,
    createdAt: old ? old.createdAt : Date.now(), updatedAt: Date.now(),
  };
  const ym = ymOf(t.date);
  const before = monthSum(ym, 'out');
  try { await DB.put('tx', t); } catch (e) { alert('保存失败：' + e.message); return; }
  if (old) S.tx[S.tx.indexOf(old)] = t; else S.tx.push(t);
  const after = monthSum(ym, 'out');
  S.set.lastMethod = t.method;
  saveSet();
  closeSheet();
  S.month = ym;
  if (S.tab === 'settings') S.tab = 'home';
  render();
  if (!checkThreshold(ym, before, after, t)) toast(old ? '已保存' : '已记一笔');
}
async function deleteTx() {
  if (!confirm('确定删除这笔记录吗？')) return;
  await DB.del('tx', F.id);
  S.tx = S.tx.filter(t => t.id !== F.id);
  closeSheet();
  render();
  toast('已删除');
}

/* ============ 超额提醒 ============ */
function checkThreshold(ym, before, after, t) {
  const L = S.set.limit;
  if (!L || t.type !== 'out') return false;
  if (after >= L && before < L) { showAlert('over', ym, after); return true; }
  if (after >= L * 0.8 && before < L * 0.8 && after < L) { showAlert('warn', ym, after); return true; }
  if (after >= L) { toast(`🚨 ${ym === curYM() ? '本月' : ymLabel(ym)}已超支 ${fmt(after - L)}`, 'red', 3000); return true; }
  return false;
}
function showAlert(lvl, ym, out) {
  const L = S.set.limit;
  const mon = ym === curYM() ? '本月' : ymLabel(ym);
  $('#toast').className = 'toast';
  const el = $('#alert');
  el.className = 'alert show ' + lvl;
  el.innerHTML = `<div class="alert-box">
    <div class="alert-emoji">${lvl === 'over' ? '🚨' : '⚠️'}</div>
    <h2>${lvl === 'over' ? `${mon}支出已超过警戒线！` : `${mon}支出已到警戒线的 80%`}</h2>
    <div class="alert-num num">${fmt(out)}</div>
    <p>警戒线 ${fmt(L)}　${lvl === 'over' ? `超出 <b>${fmt(out - L)}</b>` : `只剩 <b>${fmt(L - out)}</b>`}</p>
    <p>${lvl === 'over' ? '接下来的每一笔都想清楚再花 🙏' : '后面的日子省着点花～'}</p>
    <button data-act="closeAlert">我知道了</button></div>`;
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
}

/* ============ 提示 ============ */
let toastTimer;
function toast(msg, cls = '', ms = 1600) {
  const el = $('#toast');
  el.className = 'toast show ' + cls;
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast ' + cls; }, ms);
}

/* ============ 备份 ============ */
async function shareOrDownload(blob, name) {
  try {
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
      return true;
    }
  } catch (e) {
    if (e.name === 'AbortError') return false;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  return true;
}
async function exportJSON() {
  const data = { app: 'jizhang', version: 1, exportedAt: new Date().toISOString(), tx: S.tx, cats: S.cats, methods: S.methods, settings: S.set };
  const ok = await shareOrDownload(new Blob([JSON.stringify(data)], { type: 'application/json' }), `记账备份-${todayStr()}.json`);
  if (ok) { S.set.lastBackup = Date.now(); await saveSet(); render(); toast('备份已导出'); }
}
async function exportCSV() {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['日期', '类型', '分类', '原币金额', '币种', '汇率', '人民币金额', '支付方式', '备注']];
  [...S.tx].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt).forEach(t => rows.push([
    t.date, t.type === 'out' ? '支出' : '收入', catOf(t.categoryId).name, (t.amount / 100).toFixed(2), t.currency,
    t.rate, (t.cny / 100).toFixed(2), t.method, t.note,
  ]));
  const csv = '﻿' + rows.map(r => r.map(q).join(',')).join('\r\n');
  await shareOrDownload(new Blob([csv], { type: 'text/csv' }), `记账明细-${todayStr()}.csv`);
}
async function importJSON(file) {
  let d;
  try { d = JSON.parse(await file.text()); } catch { alert('文件读取失败，不是有效的备份文件'); return; }
  if (!d || d.app !== 'jizhang' || !Array.isArray(d.tx)) { alert('这不是本应用导出的备份文件'); return; }
  const when = d.exportedAt ? new Date(d.exportedAt).toLocaleString('zh-CN', { hour12: false }) : '未知时间';
  if (!confirm(`备份文件导出于 ${when}，包含 ${d.tx.length} 笔记录。\n\n导入后会与现有数据合并（同一笔记录以备份为准），不会删除现有记录。继续吗？`)) return;
  const valid = d.tx.filter(t => t && t.id && t.date && Number.isInteger(t.cny));
  await DB.putMany('tx', valid);
  if (Array.isArray(d.cats)) {
    d.cats.forEach(c => {
      const i = S.cats.findIndex(x => x.id === c.id);
      if (i >= 0) S.cats[i] = c; else S.cats.push(c);
    });
    await saveCats();
  }
  if (Array.isArray(d.methods)) {
    d.methods.forEach(m => { if (!S.methods.includes(m)) S.methods.push(m); });
    await saveMethods();
  }
  if (d.settings && !S.set.limit && d.settings.limit) { S.set.limit = d.settings.limit; await saveSet(); }
  S.tx = await DB.all('tx');
  render();
  toast(`已导入 ${valid.length} 笔记录`);
}

/* ============ 设置操作 ============ */
const actions = {
  tab: el => { S.tab = el.dataset.v; S.selDay = S.selMonth = null; render(); window.scrollTo(0, 0); },
  month: el => {
    const v = +el.dataset.v;
    S.month = v === 0 ? curYM() : shiftYM(S.month, v);
    if (S.month > curYM()) S.month = curYM();
    S.selDay = S.selMonth = null;
    render();
  },
  add: () => openSheet(null),
  edit: el => openSheet(S.tx.find(t => t.id === el.dataset.id)),
  closeSheet,
  goLimit: () => { S.tab = 'settings'; render(); setTimeout(() => $('#limitInput').focus(), 50); },
  goStats: () => { S.tab = 'stats'; render(); window.scrollTo(0, 0); },
  goBackup: () => { S.tab = 'settings'; render(); $('#sec-backup').scrollIntoView({ behavior: 'smooth' }); },
  statType: el => { S.statType = el.dataset.v; render(); },
  selDay: el => { S.selDay = +el.dataset.v; renderStats(); },
  selMonth: el => { S.selMonth = el.dataset.v; renderStats(); },

  setType: el => { if (F.type === el.dataset.v) return; F.type = el.dataset.v; F.catId = null; renderSheet(); },
  toggleCur: () => {
    F.cur = F.cur === 'USD' ? 'CNY' : 'USD';
    F.cnyOverride = null;
    if (F.cur === 'USD' && !F.id) F.rate = S.set.rate.value;
    F.note = $('#fNote').value; F.date = $('#fDate').value;
    renderSheet();
  },
  pickCat: el => { F.catId = el.dataset.id; $$('.cat').forEach(c => c.classList.toggle('on', c === el)); },
  pickMethod: el => { F.method = el.dataset.v; $$('.chip').forEach(c => c.classList.toggle('on', c === el)); },
  key: el => keyIn(el.dataset.v),
  saveTx,
  deleteTx,
  closeAlert: () => { $('#alert').className = 'alert'; },

  saveLimit: async () => {
    const v = parseFloat($('#limitInput').value);
    S.set.limit = v > 0 ? Math.round(v * 100) : 0;
    await saveSet();
    toast(S.set.limit ? `警戒线已设为 ${fmt(S.set.limit, { dec: false })}` : '已关闭警戒线');
    render();
  },
  saveRate: async () => {
    const v = parseFloat($('#rateInput').value);
    if (!(v > 0)) { toast('请输入正确的汇率'); return; }
    S.set.rate = { value: +v.toFixed(4), date: todayStr(), source: '手动设置' };
    await saveSet(); toast('汇率已保存'); render();
  },
  refreshRate: async () => {
    toast('正在获取汇率…');
    const ok = await refreshRate(true);
    toast(ok ? `已更新：1 USD = ${S.set.rate.value} CNY` : '获取失败，请检查网络或手动填写');
    render();
  },
  catAdd: async el => {
    const type = el.dataset.v;
    const name = $(`#newCatName-${type}`).value.trim();
    const icon = $(`#newCatIcon-${type}`).value.trim() || '🏷️';
    if (!name) { toast('请输入分类名称'); return; }
    if (S.cats.some(c => c.type === type && !c.hidden && c.name === name)) { toast('已有同名分类'); return; }
    S.cats.push({ id: 'c' + uid(), name, icon, type, hidden: false });
    await saveCats(); render(); toast('已添加');
  },
  catDel: async el => {
    const c = S.cats.find(x => x.id === el.dataset.id);
    const used = S.tx.filter(t => t.categoryId === c.id).length;
    if (!confirm(used ? `「${c.name}」下有 ${used} 笔记录。删除后记录仍保留并显示原分类名，只是记账时不再出现这个分类。确定删除吗？` : `确定删除「${c.name}」吗？`)) return;
    if (used) c.hidden = true; else S.cats.splice(S.cats.indexOf(c), 1);
    await saveCats(); render();
  },
  catUp: async el => {
    const c = S.cats.find(x => x.id === el.dataset.id);
    const same = S.cats.filter(x => x.type === c.type && !x.hidden);
    const prev = same[same.indexOf(c) - 1];
    if (!prev) return;
    const i = S.cats.indexOf(c), j = S.cats.indexOf(prev);
    [S.cats[i], S.cats[j]] = [S.cats[j], S.cats[i]];
    await saveCats(); render();
  },
  mAdd: async () => {
    const v = $('#newMethod').value.trim();
    if (!v) { toast('请输入名称'); return; }
    if (S.methods.includes(v)) { toast('已经有了'); return; }
    S.methods.push(v); await saveMethods(); render(); toast('已添加');
  },
  mDel: async el => {
    const i = +el.dataset.v;
    if (!confirm(`删除「${S.methods[i]}」？已有记录不受影响。`)) return;
    S.methods.splice(i, 1); await saveMethods(); render();
  },
  mUp: async el => {
    const i = +el.dataset.v;
    [S.methods[i - 1], S.methods[i]] = [S.methods[i], S.methods[i - 1]];
    await saveMethods(); render();
  },
  exportJSON, exportCSV,
  importJSON: () => $('#importFile').click(),
  checkUpdate: async () => {
    const reg = navigator.serviceWorker && (await navigator.serviceWorker.getRegistration());
    if (!reg) { location.reload(); return; }
    toast('正在检查更新…');
    try { await reg.update(); } catch { toast('检查失败，请检查网络'); return; }
    const w = reg.installing || reg.waiting;
    if (!w) { toast('已经是最新版本'); return; }
    toast('发现新版本，正在更新…');
    const done = () => location.reload();
    if (w.state === 'activated') done();
    w.addEventListener('statechange', () => { if (w.state === 'activated') done(); });
  },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = actions[el.dataset.act];
  if (fn) fn(el, e);
});
document.addEventListener('input', e => {
  if (!F) return;
  if (e.target.id === 'fxRate') {
    const v = parseFloat(e.target.value);
    if (v > 0) { F.rate = +v.toFixed(4); F.cnyOverride = null; updateAmount(); }
  } else if (e.target.id === 'fxCny') {
    const v = parseFloat(e.target.value);
    if (v >= 0) {
      F.cnyOverride = Math.round(v * 100);
      const usd = evalExpr(F.expr);
      if (usd > 0 && v > 0) { F.rate = +(F.cnyOverride / usd).toFixed(4); $('#fxRate').value = F.rate; }
    }
  }
});
$('#importFile').addEventListener('change', e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) importJSON(f);
});
// 回到前台时，如果跨月/跨天了就刷新
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !F) {
    refreshRate().then(() => { if (S.tab === 'settings') render(); });
    render();
  }
});

/* ============ 启动 ============ */
(async function start() {
  try {
    await load();
  } catch (e) {
    document.body.innerHTML = `<div style="padding:60px 24px;text-align:center">无法打开本地数据库：${esc(e.message)}<br><br>如果在无痕模式下，请改用普通模式或从主屏幕图标打开。</div>`;
    return;
  }
  render();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  refreshRate().then(() => { if (S.tab === 'settings') render(); });
})();
