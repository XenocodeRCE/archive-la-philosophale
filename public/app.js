'use strict';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const strip = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const PAGE = 50;
const GROUP_MS = 7 * 60 * 1000;

const svg = (body, size = 20) =>
  `<svg class="icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  hash: (s) => svg('<path d="M5 9h15M4 15h15M10 3L8 21M16 3l-2 18"/>', s),
  voice: (s) => svg('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z" fill="currentColor"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>', s),
  chevron: (s) => svg('<path d="M6 9l6 6 6-6"/>', s),
  pin: (s) => svg('<path d="M12 16v6M8.5 3h7l-1 6.5L18 13H6l3.5-3.5z"/>', s),
  thread: (s) => svg('<path d="M4 4h16v12H9l-5 4z"/><path d="M8 9h8M8 12h5"/>', s),
  file: (s) => svg('<path d="M6 2h8l5 5v15H6z"/><path d="M14 2v5h5"/>', s),
  close: (s) => svg('<path d="M6 6l12 12M18 6L6 18"/>', s),
};

const state = {
  channels: [],
  byId: new Map(),
  byName: new Map(),
  collapsed: new Set(),
  cur: null,
  token: 0,
  items: [],
  lo: 0,
  hi: 0,
  total: 0,
  loading: false,
  anchor: null,
  membersOpen: true,
  search: null,
};

const el = {
  list: $('#channel-list'),
  left: $('#topbar-left'),
  scroller: $('#scroller'),
  intro: $('#intro'),
  messages: $('#messages'),
  chat: $('#chat'),
  members: $('#members'),
  searchPanel: $('#search-panel'),
  searchInput: $('#search-input'),
  jump: $('#jump-bar'),
  composer: $('#composer'),
  lightbox: $('#lightbox'),
  btnMembers: $('#btn-members'),
};

async function api(path, params) {
  const r = await fetch(params ? `${path}?${new URLSearchParams(params)}` : path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

/* ---------- Mise en forme ---------- */

const PALETTE = ['#5865f2', '#747f8d', '#3ba55d', '#faa61a', '#ed4245', '#eb459e'];
function avatar(name, extra = '') {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)) >>> 0;
  const letter = ((name.match(/[\p{L}\p{N}]/u) || ['?'])[0]).toUpperCase();
  return `<div class="avatar ${extra}" style="background:${PALETTE[h % PALETTE.length]}">${esc(letter)}</div>`;
}

const fmtTime = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
const fmtDate = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtDay = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
const fmtFull = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'full', timeStyle: 'short' });
const dayKey = (ts) => new Date(ts).toDateString();

function stamp(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  if (d.toDateString() === today.toDateString()) return `Aujourd’hui à ${fmtTime.format(d)}`;
  if (d.toDateString() === yesterday.toDateString()) return `Hier à ${fmtTime.format(d)}`;
  return `${fmtDate.format(d)} ${fmtTime.format(d)}`;
}

function trimUrl(u) {
  for (;;) {
    const c = u[u.length - 1];
    if (/[.,;:!?'"»*_]/.test(c)) u = u.slice(0, -1);
    else if (c === ')' && (u.match(/\(/g) || []).length < (u.match(/\)/g) || []).length) u = u.slice(0, -1);
    else return u;
  }
}

function inline(text, mentions) {
  const names = (mentions || []).filter(Boolean).sort((a, b) => b.length - a.length).map(reEsc);
  const parts = ['https?:\\/\\/[^\\s<>]+', '\\u2060[\\p{L}\\p{N}_-]+', '@(?:everyone|here)\\b'];
  if (names.length) parts.push(`(?:${names.join('|')})`);
  const re = new RegExp(parts.join('|'), 'gu');

  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index));
    const tok = m[0];
    if (/^https?:/.test(tok)) {
      const url = trimUrl(tok);
      out += `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>${esc(tok.slice(url.length))}`;
    } else if (tok[0] === '\u2060') {
      const name = tok.slice(1);
      const id = state.byName.get(name);
      out += id
        ? `<a class="mention" href="#/c/${esc(id)}">#${esc(name)}</a>`
        : `<span class="mention">#${esc(name)}</span>`;
    } else {
      out += `<span class="mention">${esc(tok)}</span>`;
    }
    last = m.index + tok.length;
  }
  return out + esc(text.slice(last));
}

function renderContent(text, mentions) {
  const lines = text.split('\n');
  let html = '';
  let i = 0;
  const plain = [];
  const flush = () => {
    const t = plain.join('\n').replace(/^\n+|\n+$/g, '');
    if (t) html += inline(t, mentions);
    plain.length = 0;
  };
  while (i < lines.length) {
    const l = lines[i];
    if (/^>\s?/.test(l)) {
      flush();
      const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''));
      html += `<blockquote>${inline(q.join('\n'), mentions)}</blockquote>`;
    } else if (/^\s*[-*]\s+\S/.test(l)) {
      flush();
      const li = [];
      while (i < lines.length && /^\s*[-*]\s+\S/.test(lines[i])) li.push(lines[i++].replace(/^\s*[-*]\s+/, ''));
      html += `<ul>${li.map((x) => `<li>${inline(x, mentions)}</li>`).join('')}</ul>`;
    } else if (/^\s*\d+\.\s+\S/.test(l)) {
      flush();
      const start = parseInt(l, 10);
      const li = [];
      while (i < lines.length && /^\s*\d+\.\s+\S/.test(lines[i])) li.push(lines[i++].replace(/^\s*\d+\.\s+/, ''));
      html += `<ol start="${start}">${li.map((x) => `<li>${inline(x, mentions)}</li>`).join('')}</ol>`;
    } else {
      plain.push(l);
      i++;
    }
  }
  flush();
  return html;
}

const IMG_RE = /\.(png|jpe?g|gif|webp)$/i;
function fileName(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || url);
  } catch {
    return url;
  }
}
function fileCard(url, broken) {
  const name = fileName(url);
  return `<div class="att-file">${ICON.file(32)}<div class="fname"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(name)}</a>${broken ? '<small>Image indisponible (lien expiré)</small>' : ''}</div></div>`;
}

function attachmentsHtml(list) {
  return list
    .map((u) =>
      IMG_RE.test(fileName(u))
        ? `<img class="att-img" src="${esc(u)}" alt="${esc(fileName(u))}" referrerpolicy="no-referrer" data-url="${esc(u)}">`
        : fileCard(u, false)
    )
    .join('');
}

function embedsHtml(list) {
  return list
    .map((e) => {
      const title = e.title || e.url || '';
      return `<div class="embed">${e.provider ? `<div class="embed-provider">${esc(e.provider)}</div>` : ''}${e.author ? `<div class="embed-author">${esc(e.author)}</div>` : ''}${title ? `<a class="embed-title" href="${esc(e.url || '#')}" target="_blank" rel="noopener noreferrer">${esc(title)}</a>` : ''}</div>`;
    })
    .join('');
}

function reactionsHtml(list) {
  return `<div class="reactions">${list
    .map((r) => `<div class="reaction"><span class="emoji">${/^\w+$/.test(r.emoji) ? `:${esc(r.emoji)}:` : esc(r.emoji)}</span><span>${r.count}</span></div>`)
    .join('')}</div>`;
}

function messageBody(m) {
  let h = '';
  if (m.content) h += `<div class="msg-content">${renderContent(m.content, m.mentions)}${m.edited ? '<span class="edited">(modifié)</span>' : ''}</div>`;
  if (m.attachments) h += attachmentsHtml(m.attachments);
  if (m.embeds) h += embedsHtml(m.embeds);
  if (m.reactions) h += reactionsHtml(m.reactions);
  return h;
}

function msgHtml(m, prev) {
  const newDay = !prev || dayKey(prev.ts) !== dayKey(m.ts);
  let html = newDay ? `<div class="day-divider"><span>${fmtDay.format(new Date(m.ts))}</span></div>` : '';
  const full = esc(fmtFull.format(new Date(m.ts)));

  if (m.system) {
    const text =
      m.system.type === 'pin'
        ? `<b>${esc(m.author)}</b> a épinglé un message dans ce salon.`
        : `<b>${esc(m.author)}</b> a commencé un fil : <b>${esc(m.system.name)}</b>`;
    const icon = m.system.type === 'pin' ? ICON.pin(18) : ICON.thread(18);
    html += `<div class="message system" data-id="${m.id}"><div class="sys-icon">${icon}</div>${text}<span class="stamp" title="${full}">${stamp(m.ts)}</span></div>`;
  } else if (prev && !prev.system && !newDay && prev.author === m.author && m.ts - prev.ts < GROUP_MS) {
    html += `<div class="message compact" data-id="${m.id}"><time class="hover-time" title="${full}">${fmtTime.format(new Date(m.ts))}</time>${messageBody(m)}</div>`;
  } else {
    html += `<div class="message" data-id="${m.id}">${avatar(m.author)}<h3 class="msg-header"><span class="author">${esc(m.author)}</span><time class="stamp" title="${full}">${stamp(m.ts)}</time></h3>${messageBody(m)}</div>`;
  }
  return `<div class="msg-wrap" data-id="${m.id}">${html}</div>`;
}

/* ---------- Barre latérale ---------- */

function buildSidebar() {
  const groups = [];
  for (const c of state.channels) {
    const key = c.category || '';
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) groups.push((g = { key, items: [] }));
    g.items.push(c);
  }
  const activeId = state.cur;

  const item = (c) => {
    const icon = c.type === 'voice' ? ICON.voice(20) : ICON.hash(20);
    return `<a class="channel${c.id === activeId ? ' active' : ''}" href="#/c/${esc(c.id)}" data-id="${esc(c.id)}">${icon}<span class="name">${esc(c.name)}</span></a>`;
  };

  el.list.innerHTML = groups
    .map((g) => {
      if (!g.key) return g.items.map(item).join('');
      const collapsed = state.collapsed.has(g.key);
      const shown = collapsed ? g.items.filter((c) => c.id === activeId) : g.items;
      return `<div class="cat-header${collapsed ? ' collapsed' : ''}" data-cat="${esc(g.key)}">${ICON.chevron(12)}<span>${esc(g.key)}</span></div>${shown.map(item).join('')}`;
    })
    .join('');
}

el.list.addEventListener('click', (e) => {
  const h = e.target.closest('.cat-header');
  if (!h) return;
  const k = h.dataset.cat;
  state.collapsed.has(k) ? state.collapsed.delete(k) : state.collapsed.add(k);
  buildSidebar();
});

/* ---------- Navigation ---------- */

function parseHash() {
  const m = location.hash.match(/^#\/c\/([^/]+)(?:\/(\d+))?$/);
  return m ? { id: decodeURIComponent(m[1]), msg: m[2] || null } : null;
}

function goTo(id, msg) {
  const h = `#/c/${encodeURIComponent(id)}${msg ? `/${msg}` : ''}`;
  if (location.hash === h) openChannel(id, msg);
  else location.hash = h;
}

function route() {
  const r = parseHash();
  if (!r || !state.byId.has(r.id)) {
    const first = state.channels.find((c) => c.type === 'text');
    location.replace(`#/c/${encodeURIComponent(first.id)}`);
    return;
  }
  openChannel(r.id, r.msg);
}

function updateTopbar(ch) {
  el.left.innerHTML = `${ch.type === 'voice' ? ICON.voice(24) : ICON.hash(24)}<span class="title">${esc(ch.name)}</span>`;
}

function updateRight() {
  const searching = !!state.search;
  el.searchPanel.hidden = !searching;
  el.members.hidden = searching;
  el.members.classList.toggle('off', !state.membersOpen);
  el.btnMembers.classList.toggle('on', state.membersOpen && !searching);
}

async function openChannel(id, focusId) {
  const ch = state.byId.get(id);
  const token = ++state.token;
  const same = state.cur === id;
  state.cur = id;
  state.anchor = null;
  buildSidebar();
  updateTopbar(ch);
  updateRight();

  if (same && focusId && el.messages.querySelector(`.msg-wrap[data-id="${focusId}"]`)) {
    focusMessage(focusId);
    return;
  }

  el.messages.innerHTML = '<div class="loading">Chargement…</div>';
  el.intro.hidden = true;
  el.jump.hidden = true;
  state.items = [];
  state.loading = false;
  if (!same || !focusId) el.members.innerHTML = '';

  let data;
  try {
    data = await api(`/api/channels/${encodeURIComponent(id)}/messages`, focusId ? { around: focusId, count: PAGE * 2 } : {});
  } catch {
    if (token === state.token) el.messages.innerHTML = '<div class="loading">Impossible de charger ce salon.</div>';
    return;
  }
  if (token !== state.token) return;

  state.total = data.total;
  state.lo = data.start;
  state.hi = data.end;
  state.items = data.messages;
  renderAll(ch);
  if (focusId) focusMessage(focusId);
  else setAnchor(() => (el.scroller.scrollTop = el.scroller.scrollHeight));

  api(`/api/channels/${encodeURIComponent(id)}/authors`).then((list) => {
    if (token === state.token) renderMembers(list);
  });
}

function renderAll(ch) {
  el.messages.innerHTML = state.items.map((m, i) => msgHtml(m, state.items[i - 1])).join('');
  const label = `#${ch.name}`;
  el.intro.innerHTML = `<div class="big">${ICON.hash(40)}</div><h1>Bienvenue dans ${esc(label)} !</h1><p>C’est le début du salon ${esc(label)}.</p>`;
  el.intro.hidden = state.lo > 0;
  updateJump();
  setTimeout(onScroll, 0);
}

function updateJump() {
  el.jump.hidden = state.hi >= state.total;
}

/* ---------- Défilement / chargement incrémental ---------- */

function setAnchor(fn) {
  state.anchor = fn;
  fn();
  clearTimeout(setAnchor.timer);
  setAnchor.timer = setTimeout(() => (state.anchor = null), 3000);
}
for (const ev of ['wheel', 'touchmove', 'keydown', 'pointerdown']) {
  el.scroller.addEventListener(ev, () => (state.anchor = null), { passive: true });
}
el.scroller.addEventListener('load', () => state.anchor && state.anchor(), true);
el.scroller.addEventListener(
  'error',
  (e) => {
    const t = e.target;
    if (t.tagName === 'IMG' && t.classList.contains('att-img')) t.outerHTML = fileCard(t.dataset.url, true);
  },
  true
);

function focusMessage(id) {
  const wrap = el.messages.querySelector(`.msg-wrap[data-id="${id}"]`);
  if (!wrap) return;
  const target = wrap.querySelector('.message');
  setAnchor(() => wrap.scrollIntoView({ block: 'center' }));
  target.classList.remove('flash');
  void target.offsetWidth;
  target.classList.add('flash');
}

async function onScroll() {
  if (state.loading || el.chat.hidden || !state.items.length) return;
  const s = el.scroller;
  if (s.scrollTop < 600 && state.lo > 0) await loadMore('up');
  else if (s.scrollHeight - s.scrollTop - s.clientHeight < 600 && state.hi < state.total) await loadMore('down');
}
el.scroller.addEventListener('scroll', onScroll, { passive: true });

async function loadMore(dir) {
  const token = state.token;
  const id = state.cur;
  state.loading = true;
  try {
    const params = dir === 'up' ? { start: Math.max(0, state.lo - PAGE), end: state.lo } : { start: state.hi, end: Math.min(state.total, state.hi + PAGE) };
    const data = await api(`/api/channels/${encodeURIComponent(id)}/messages`, params);
    if (token !== state.token) return;
    dir === 'up' ? prepend(data.messages, data.start) : append(data.messages, data.end);
  } catch {
    /* réessai au prochain défilement */
  } finally {
    if (token === state.token) {
      state.loading = false;
      setTimeout(onScroll, 0);
    }
  }
}

function prepend(msgs, newLo) {
  const s = el.scroller;
  const oldWrap = el.messages.firstElementChild;
  const oldFirst = state.items[0];
  const prevH = s.scrollHeight;
  const prevTop = s.scrollTop;

  el.messages.insertAdjacentHTML('afterbegin', msgs.map((m, i) => msgHtml(m, msgs[i - 1])).join(''));
  if (oldWrap && oldFirst) oldWrap.outerHTML = msgHtml(oldFirst, msgs[msgs.length - 1]);
  state.items = msgs.concat(state.items);
  state.lo = newLo;
  el.intro.hidden = state.lo > 0;
  s.scrollTop = prevTop + (s.scrollHeight - prevH);
}

function append(msgs, newHi) {
  let prev = state.items[state.items.length - 1];
  let html = '';
  for (const m of msgs) {
    html += msgHtml(m, prev);
    prev = m;
  }
  el.messages.insertAdjacentHTML('beforeend', html);
  state.items = state.items.concat(msgs);
  state.hi = newHi;
  updateJump();
}

$('#btn-jump').addEventListener('click', () => goTo(state.cur));

el.messages.addEventListener('click', (e) => {
  const img = e.target.closest('.att-img');
  if (img) {
    $('img', el.lightbox).src = img.src;
    el.lightbox.hidden = false;
  }
});
el.lightbox.addEventListener('click', () => (el.lightbox.hidden = true));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') el.lightbox.hidden = true;
});

/* ---------- Participants ---------- */

function renderMembers(list) {
  el.members.innerHTML =
    `<h2 class="panel-title">Participants — ${list.length}</h2>` +
    list.map((a) => `<div class="member" title="${a.count} message${a.count > 1 ? 's' : ''}">${avatar(a.name)}<span class="mname">${esc(a.name)}</span></div>`).join('');
}

el.btnMembers.addEventListener('click', () => {
  if (state.search) closeSearch();
  else state.membersOpen = !state.membersOpen;
  updateRight();
});

/* ---------- Recherche ---------- */

let searchTimer;
el.searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(0), 350);
});
el.searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    clearTimeout(searchTimer);
    runSearch(0);
  } else if (e.key === 'Escape') {
    el.searchInput.value = '';
    closeSearch();
    updateRight();
    el.searchInput.blur();
  }
});

function closeSearch() {
  state.search = null;
  el.searchPanel.innerHTML = '';
}

async function runSearch(offset) {
  const q = el.searchInput.value.trim();
  if (q.length < 2) {
    if (state.search) {
      closeSearch();
      updateRight();
    }
    return;
  }
  const data = await api('/api/search', { q, offset });
  if (el.searchInput.value.trim() !== q) return;
  if (offset === 0 || !state.search) state.search = { q, results: [], total: 0 };
  state.search.results.push(...data.results);
  state.search.total = data.total;
  renderSearch();
  updateRight();
}

function highlight(text, terms) {
  const n = strip(text);
  if (n.length !== text.length) return esc(text);
  const ranges = [];
  for (const t of terms) {
    for (let i = n.indexOf(t); i >= 0 && t; i = n.indexOf(t, i + t.length)) ranges.push([i, i + t.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [a, b] of ranges) {
    if (a < pos) continue;
    out += esc(text.slice(pos, a)) + `<mark>${esc(text.slice(a, b))}</mark>`;
    pos = b;
  }
  return out + esc(text.slice(pos));
}

function searchSnippet(content, terms) {
  const n = strip(content);
  let first = -1;
  if (n.length === content.length) for (const t of terms) { const i = n.indexOf(t); if (i >= 0 && (first < 0 || i < first)) first = i; }
  const start = Math.max(0, first - 80);
  const part = content.slice(start, start + 400);
  const prefix = start > 0 ? '…' : '';
  const suffix = start + 400 < content.length ? '…' : '';
  return prefix + highlight(part, terms) + suffix;
}

function renderSearch() {
  const { q, results, total } = state.search;
  const terms = (q.match(/"[^"]+"|\S+/g) || []).filter((t) => !/^(from|de):/i.test(t)).map((t) => strip(t.replace(/"/g, '')));
  const body = results.length
    ? results
        .map((r) => {
          const m = r.message;
          const text = m.content ? searchSnippet(m.content, terms) : esc((m.embeds || []).map((e) => e.title).filter(Boolean).join(' · '));
          return `<div class="sr" data-ch="${esc(r.channelId)}" data-msg="${m.id}"><div class="sr-channel">${r.category ? esc(r.category) + ' › ' : ''}#${esc(r.label)}</div><div class="message">${avatar(m.author)}<h3 class="msg-header"><span class="author">${esc(m.author)}</span><span class="stamp">${stamp(m.ts)}</span></h3><div class="msg-content">${text}</div></div></div>`;
        })
        .join('')
    : '<div class="sp-empty">Aucun résultat.</div>';
  const more = results.length < total ? '<button class="sp-more" type="button">Afficher plus de résultats</button>' : '';
  el.searchPanel.innerHTML = `<div class="sp-head"><span>${total} résultat${total > 1 ? 's' : ''}</span><button class="icon-btn" id="sp-close" type="button" title="Fermer">${ICON.close(20)}</button></div><div class="sp-body">${body}${more}</div>`;
}

el.searchPanel.addEventListener('click', (e) => {
  if (e.target.closest('#sp-close')) {
    el.searchInput.value = '';
    closeSearch();
    updateRight();
    return;
  }
  if (e.target.closest('.sp-more')) {
    runSearch(state.search.results.length);
    return;
  }
  const r = e.target.closest('.sr');
  if (r) goTo(r.dataset.ch, r.dataset.msg);
});

/* ---------- Démarrage ---------- */

async function boot() {
  try {
    const data = await api('/api/server');
    state.channels = data.channels;
  } catch {
    el.messages.innerHTML = '<div class="loading">Impossible de joindre le serveur local.</div>';
    return;
  }
  for (const c of state.channels) {
    state.byId.set(c.id, c);
    if (c.type === 'text' || c.type === 'voice') state.byName.set(c.name, c.id);
  }
  window.addEventListener('hashchange', route);
  route();
}
boot();
