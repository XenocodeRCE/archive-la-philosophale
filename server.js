'use strict';
// Serveur local en lecture seule : charge les exports JSON et les expose au client.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const SALONS = path.join(ROOT, 'salons');
const PORT = Number(process.env.PORT) || 3000;
const SERVER_NAME = 'La Philosophale';
const CATEGORY_ORDER = ['informations', 'discussion', 'références', 'activités', 'débats', 'poésie et littérature', 'vocal', 'usa, 20ème siècle', 'italie, 20ème siècle'];
const NAMES_FILE = path.join(ROOT, 'noms-des-salons.json');
const VOICE_CATEGORIES = new Set(['vocal']);

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const strip = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const idCmp = (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

const DATE_LINE = /\n(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche) [^\n]* \d{4} à \d{1,2}:\d{2}\s*$/;
const PIN_RE = /^([^\n]*)\n\s*a épinglé un message/;
const THREAD_RE = /^([^\n]*)\n\s*a commencé un fil\s*:\s*([\s\S]*?)\.\s*Voir tous les fils/;

// Nettoie les artefacts du scraping (date en fin de message, "(modifié)", messages système).
function cleanMessage(raw) {
  const out = {
    id: raw.messageId,
    author: raw.author,
    ts: Date.parse(raw.timestamp),
    content: '',
    edited: !!raw.edited,
  };
  let c = raw.content || '';

  const pin = c.match(PIN_RE);
  const thread = c.match(THREAD_RE);
  if (pin) {
    out.author = pin[1].trim() || raw.author;
    out.system = { type: 'pin' };
    return out;
  }
  if (thread) {
    out.author = thread[1].trim() || raw.author;
    out.system = { type: 'thread', name: thread[2].trim() };
    return out;
  }

  c = c.replace(DATE_LINE, '');
  if (/\s*\(modifié\)\s*$/.test(c)) {
    c = c.replace(/\s*\(modifié\)\s*$/, '');
    out.edited = true;
  }
  out.content = c.trim();

  const attachments = [...new Set(raw.attachments || [])];
  if (attachments.length) out.attachments = attachments;
  if (raw.embeds && raw.embeds.length) out.embeds = raw.embeds;
  if (raw.mentions && raw.mentions.length) out.mentions = raw.mentions;
  if (raw.reactions && raw.reactions.length) out.reactions = raw.reactions;
  return out;
}

const channels = new Map();

// Un salon présent dans plusieurs fichiers : on garde l'export le plus complet.
const hasBetter = (id, raw) => channels.has(id) && channels.get(id).messages.length > Object.keys(raw).length;

function addChannel(info, rawMessages) {
  const messages = Object.values(rawMessages)
    .map(cleanMessage)
    .sort((a, b) => a.ts - b.ts || idCmp(a.id, b.id));
  const norm = messages.map((m) =>
    m.system ? '' : strip(m.content + ' ' + (m.embeds || []).map((e) => e.title || '').join(' '))
  );
  const index = new Map(messages.map((m, i) => [m.id, i]));
  channels.set(info.id, { ...info, messages, norm, index });
  return channels.get(info.id);
}

// Les exports de catégorie ne contiennent pas le nom des salons : on le déduit du premier lien Wikipédia.
function guessName(messages) {
  for (const m of messages) {
    const texts = [m.content, ...(m.embeds || []).map((e) => e.url || '')];
    for (const t of texts) {
      const w = t.match(/wikipedia\.org\/wiki\/([^\s#?;]+)/);
      if (!w) continue;
      let slug;
      try {
        slug = decodeURIComponent(w[1]);
      } catch {
        slug = w[1];
      }
      return strip(slug.replace(/_?\(.*?\)/g, '')).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || null;
    }
  }
  return null;
}

function loadNames() {
  if (!fs.existsSync(NAMES_FILE)) return {};
  try {
    return readJson(NAMES_FILE);
  } catch (e) {
    console.warn(`noms-des-salons.json illisible : ${e.message}`);
    return {};
  }
}

function load() {
  const entries = fs
    .readdirSync(SALONS)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .map((f) => ({ file: path.join(SALONS, f) }));

  const singles = [];
  const multis = [];
  for (const e of entries) {
    const base = path.basename(e.file, '.json');
    const data = readJson(e.file);
    const meta = data._meta || {};
    delete data._meta;
    const ids = Object.keys(data);
    if (ids.length === 1) {
      const i = base.indexOf('_');
      const m = meta[ids[0]];
      const named = m && m.name;
      singles.push({
        id: ids[0],
        base,
        category: named && 'category' in m ? m.category : i < 0 ? null : base.slice(0, i),
        name: named ? m.name : i < 0 ? base : base.slice(i + 1),
        order: m && m.order,
        fromMeta: !!named,
        raw: data[ids[0]],
      });
    } else {
      multis.push({ base, data, meta });
    }
  }

  // Fichier sans "_" : on rattache à une catégorie existante si le nom commence par "<catégorie>-".
  const known = new Map(singles.filter((s) => s.category).map((s) => [s.category.toLowerCase(), s.category]));
  for (const s of singles) {
    if (s.category || s.fromMeta) continue;
    const j = s.base.indexOf('-');
    const cat = j > 0 ? known.get(s.base.slice(0, j).toLowerCase()) : null;
    if (cat) {
      s.category = cat;
      s.name = s.base.slice(j + 1);
    }
  }

  for (const s of singles) {
    if (hasBetter(s.id, s.raw)) continue;
    const voice = s.category && VOICE_CATEGORIES.has(s.category.toLowerCase());
    addChannel(
      { id: s.id, name: s.name, category: s.category, type: voice ? 'voice' : 'text', order: s.order, sidebar: s.fromMeta },
      s.raw
    );
  }

  const customNames = loadNames();
  for (const f of multis) {
    const names = customNames[f.base] || {};
    const listed = Object.keys(names);
    const ids = Object.keys(f.data).sort((a, b) => idCmp(a, b));
    let extra = 0;
    for (const id of ids) {
      if (hasBetter(id, f.data[id])) continue;
      const pos = listed.indexOf(id);
      const m = f.meta[id] && f.meta[id].name ? f.meta[id] : null;
      const category = m && 'category' in m ? m.category : f.base;
      const voice = category && VOICE_CATEGORIES.has(category.toLowerCase());
      const c = addChannel(
        {
          id,
          name: '',
          category,
          type: voice ? 'voice' : 'text',
          order: pos >= 0 ? pos : listed.length + (m && m.order != null ? m.order : 100000 + extra++),
          sidebar: pos < 0 && !!m && m.order != null,
        },
        f.data[id]
      );
      if (pos >= 0) c.name = names[id];
      else if (m) c.name = m.name;
      else {
        c.name = guessName(c.messages) || id;
        console.log(`Salon non listé dans noms-des-salons.json : ${f.base} / ${id} -> "${c.name}"`);
      }
    }
  }
}

// Les catégories hors CATEGORY_ORDER suivent l'ordre de la barre latérale Discord quand l'export le fournit.
function categoryRank(cat) {
  if (!cat) return -1;
  const i = CATEGORY_ORDER.indexOf(cat.toLowerCase());
  if (i >= 0) return i;
  let min = Infinity;
  for (const c of channels.values()) if (c.category === cat && c.sidebar && c.order < min) min = c.order;
  return CATEGORY_ORDER.length + (Number.isFinite(min) ? min : 1e6);
}

function summary(c) {
  return { id: c.id, name: c.name, category: c.category, type: c.type, count: c.messages.length };
}

function serverInfo() {
  const ranks = new Map();
  const rank = (cat) => {
    if (!ranks.has(cat)) ranks.set(cat, categoryRank(cat));
    return ranks.get(cat);
  };
  const sorted = [...channels.values()].sort(
    (a, b) =>
      rank(a.category) - rank(b.category) ||
      (a.category || '').localeCompare(b.category || '', 'fr') ||
      (a.order ?? 0) - (b.order ?? 0) ||
      a.name.localeCompare(b.name, 'fr')
  );
  return { name: SERVER_NAME, channels: sorted.map(summary) };
}

const clampInt = (v, def, min, max) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

function getMessages(c, q) {
  const total = c.messages.length;
  const count = clampInt(q.get('count'), 100, 1, 200);
  let start;
  let end;
  let focus = null;
  if (q.has('around')) {
    const i = c.index.get(q.get('around'));
    if (i === undefined) return null;
    focus = i;
    end = Math.min(total, Math.max(0, i - Math.floor(count / 2)) + count);
    start = Math.max(0, end - count);
  } else if (q.has('start') || q.has('end')) {
    end = clampInt(q.get('end'), total, 0, total);
    start = clampInt(q.get('start'), Math.max(0, end - 50), 0, end);
    if (end - start > 200) start = end - 200;
  } else {
    end = total;
    start = Math.max(0, total - 50);
  }
  return { total, start, end, focus, messages: c.messages.slice(start, end) };
}

function getAuthors(c) {
  const counts = new Map();
  for (const m of c.messages) if (!m.system) counts.set(m.author, (counts.get(m.author) || 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

const SEARCH_PAGE = 25;

function search(q) {
  const raw = (q.get('q') || '').trim();
  const offset = clampInt(q.get('offset'), 0, 0, 1e7);
  const terms = [];
  const authors = [];
  for (const tok of raw.match(/"[^"]+"|\S+/g) || []) {
    const from = tok.match(/^(?:from|de):(.+)$/i);
    if (from) authors.push(strip(from[1].replace(/"/g, '')));
    else terms.push(strip(tok.replace(/"/g, '')));
  }
  if (!terms.length && !authors.length) return { total: 0, results: [] };

  const hits = [];
  for (const c of channels.values()) {
    for (let i = 0; i < c.messages.length; i++) {
      const m = c.messages[i];
      if (m.system) continue;
      const n = c.norm[i];
      if (!terms.every((t) => n.includes(t))) continue;
      if (authors.length) {
        const a = strip(m.author);
        if (!authors.every((x) => a.includes(x))) continue;
      }
      hits.push({ c, m });
    }
  }
  hits.sort((a, b) => b.m.ts - a.m.ts);

  const results = hits
    .slice(offset, offset + SEARCH_PAGE)
    .map(({ c, m }) => ({ channelId: c.id, label: c.name, category: c.category, message: m }));
  return { total: hits.length, offset, results };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function handle(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'read-only' });
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/server') return sendJson(res, 200, serverInfo());
  if (url.pathname === '/api/search') return sendJson(res, 200, search(url.searchParams));

  const m = url.pathname.match(/^\/api\/channels\/([^/]+)\/(messages|authors)$/);
  if (m) {
    const c = channels.get(decodeURIComponent(m[1]));
    if (!c) return sendJson(res, 404, { error: 'salon introuvable' });
    if (m[2] === 'authors') return sendJson(res, 200, getAuthors(c));
    const data = getMessages(c, url.searchParams);
    return data ? sendJson(res, 200, data) : sendJson(res, 404, { error: 'message introuvable' });
  }

  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  const file = path.normalize(path.join(PUBLIC, rel === '/' ? 'index.html' : rel));
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

load();
const total = [...channels.values()].reduce((n, c) => n + c.messages.length, 0);
http.createServer(handle).listen(PORT, '127.0.0.1', () => {
  console.log(`${channels.size} salons/fils, ${total} messages chargés. Ouvre http://localhost:${PORT}`);
});
