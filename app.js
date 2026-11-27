/* Zımba — offline PDF tools. Everything runs in the browser; files never leave the device. */
import * as pdfjsLib from './vendor/pdf.min.js';

const BASE = new URL('./', import.meta.url);
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('vendor/pdf.worker.min.js', BASE).href;
const PDFJS_OPTS = {
  cMapUrl: new URL('vendor/cmaps/', BASE).href, cMapPacked: true,
  standardFontDataUrl: new URL('vendor/standard_fonts/', BASE).href,
  isEvalSupported: false, enableXfa: false
};
const L = window.PDFLib;
const { PDFDocument, degrees, rgb, StandardFonts, PDFName, PDFRawStream, PDFArray, PDFDict, PDFNumber } = L;

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tick = () => new Promise(r => setTimeout(r, 0));
const ABORT = { code: 'abort' };

/* ---------------- i18n ---------------- */
const LANGS = window.ZIMBA_LANGS;
const LANG_ORDER = ['en', 'tr', 'de', 'es', 'fr', 'it', 'pt', 'ru', 'ja', 'zh'];
const qs = new URLSearchParams(location.search);
function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
function detectLang() {
  const q = qs.get('lang'); if (q && LANGS[q]) return q;
  const s = store('zimba.lang'); if (s && LANGS[s]) return s;
  for (const l of (navigator.languages || [navigator.language || 'en'])) { const b = String(l).toLowerCase().split('-')[0]; if (LANGS[b]) return b; }
  return 'en';
}
let lang = detectLang();
let PR = new Intl.PluralRules(LANGS[lang].code);
let NF = new Intl.NumberFormat(LANGS[lang].code);
function t(k, v) {
  const D = LANGS[lang], E = LANGS.en;
  let key = k;
  if (v && typeof v.n === 'number') {
    const c = PR.select(v.n);
    if (D[k + '_' + c] != null) key = k + '_' + c;
    else if (D[k] == null && E[k + '_' + c] != null) key = k + '_' + c;
  }
  let s = D[key] ?? E[key] ?? E[k] ?? k;
  if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => v[n] == null ? m : (typeof v[n] === 'number' ? NF.format(v[n]) : v[n]));
  return s;
}
function fmtSize(b) {
  const code = LANGS[lang].code;
  if (b < 1024 * 1024) return new Intl.NumberFormat(code, { maximumFractionDigits: 0 }).format(Math.max(1, b / 1024)) + ' ' + t('kb');
  const mb = b / 1048576;
  return new Intl.NumberFormat(code, { maximumFractionDigits: mb < 10 ? 1 : 0 }).format(mb) + ' ' + t('mb');
}
function applyI18n() {
  document.documentElement.lang = LANGS[lang].code;
  document.title = t('title');
  for (const el of document.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
  for (const el of document.querySelectorAll('[data-ta]')) { el.setAttribute('aria-label', t(el.dataset.ta)); el.title = t(el.dataset.ta); }
  updateUI();
}
function setupLangSel() {
  const sel = $('#langSel');
  sel.innerHTML = LANG_ORDER.filter(k => LANGS[k]).map(k => `<option value="${k}">${esc(LANGS[k].name)}</option>`).join('');
  sel.value = lang;
  sel.onchange = () => {
    lang = sel.value; store('zimba.lang', lang);
    PR = new Intl.PluralRules(LANGS[lang].code); NF = new Intl.NumberFormat(LANGS[lang].code);
    applyI18n();
  };
}

/* ---------------- state ---------------- */
const COLORS = ['#3B6FE0', '#1F9D6B', '#E0862B', '#8B5CF6', '#E0457B', '#0EA5B7', '#6366F1', '#84A31C'];
const S = { sources: new Map(), pages: [], seq: 1, colorIdx: 0, undo: [], anchor: null, intent: null, focus: null };
const thumbs = new Map(); // "srcId:index" -> {url,w,h}
const cardEls = new Map(); // pageId -> element
const nextColor = () => COLORS[S.colorIdx++ % COLORS.length];
const keyOf = p => p.src + ':' + p.index;
const selected = () => S.pages.filter(p => p.sel);
const isLetter = /-(us|ca|mx|ph|cl|co|ve|pr)$/i.test(navigator.language || '');

function snapshot() { S.undo.push(S.pages.map(p => ({ ...p }))); if (S.undo.length > 80) S.undo.shift(); }
function undo() {
  const prev = S.undo.pop(); if (!prev) return;
  S.pages = prev.filter(p => S.sources.has(p.src)); updateUI();
}

/* ---------------- toasts ---------------- */
function toast(msg, kind = '', ms = 4200, action) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  el.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) { const b = document.createElement('button'); b.type = 'button'; b.textContent = action.label; b.onclick = () => { action.run(); close(); }; el.append(b); }
  $('#toasts').append(el);
  let timer = ms ? setTimeout(close, ms) : null;
  function close() { clearTimeout(timer); el.remove(); }
  return { close };
}

/* ---------------- file intake ---------------- */
async function sniff(file) {
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  let asc = ''; for (let i = 0; i < head.length; i++) asc += String.fromCharCode(head[i]);
  if (asc.includes('%PDF-')) return 'pdf';
  if (head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF) return 'jpeg';
  if (asc.startsWith('\x89PNG')) return 'png';
  if (asc.startsWith('GIF8')) return 'gif';
  if (asc.startsWith('RIFF') && asc.slice(8, 12) === 'WEBP') return 'webp';
  if (asc.startsWith('BM')) return 'bmp';
  if (asc.slice(4, 8) === 'ftyp') { const brand = asc.slice(8, 12); return /hei|hev/.test(brand) ? 'heic' : 'image'; }
  if (/^image\//.test(file.type) || /<svg[\s>]/i.test(asc)) return 'image';
  return null;
}
let addChain = Promise.resolve();
function addFiles(list, intent) {
  const files = [...(list || [])].filter(f => f && f.size !== undefined);
  if (!files.length) return addChain;
  addChain = addChain.then(() => doAdd(files, intent)).catch(e => console.error(e));
  return addChain;
}
async function doAdd(files, intent) {
  showWork(true);
  const busy = toast(t('loading', { name: files.length === 1 ? files[0].name : t('fileCount', { n: files.length }) }), '', 0);
  snapshot();
  let added = 0;
  for (const f of files) {
    try {
      const kind = await sniff(f);
      if (kind === 'pdf') added += await addPdf(f);
      else if (kind) added += await addImage(f, kind);
      else toast(t('errType', { name: f.name }), 'err', 6000);
    } catch (e) {
      if (e && e.code === 'heic') toast(t('errHeic', { name: f.name }), 'err', 7000);
      else if (!(e && e.code === 'cancel')) { console.error(e); toast(t('errRead', { name: f.name }), 'err', 6000); }
    }
    updateUI();
  }
  busy.close();
  if (!added) S.undo.pop();
  if (!S.pages.length) { showWork(false); return; }
  if (!store('zimba.hint1')) showHint(t('hintFirst'), 'zimba.hint1');
  if (intent && added) runIntent(intent);
}
async function addPdf(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let password, pdf;
  for (let attempt = 0; ; attempt++) {
    const task = pdfjsLib.getDocument({ ...PDFJS_OPTS, data: bytes.slice(), password });
    try { pdf = await task.promise; break; }
    catch (e) {
      if (e && e.name === 'PasswordException') {
        const pw = await askPassword(file.name, attempt > 0);
        if (pw == null) throw { code: 'cancel' };
        password = pw; continue;
      }
      throw e;
    }
  }
  let encrypted = !!password;
  try { const md = await pdf.getMetadata(); if (md && md.info && md.info.EncryptFilterName) encrypted = true; } catch (e) {}
  const id = S.seq++;
  const src = { id, kind: 'pdf', name: file.name, size: bytes.length, bytes, pdf, numPages: pdf.numPages, encrypted, color: nextColor(), aspect: 1.414 };
  try { const p1 = await pdf.getPage(1); const vp = p1.getViewport({ scale: 1 }); src.aspect = vp.height / vp.width; } catch (e) {}
  S.sources.set(id, src);
  for (let i = 0; i < pdf.numPages; i++) S.pages.push({ id: S.seq++, src: id, index: i, rot: 0, sel: false });
  if (encrypted) toast(t('encNote', { name: file.name }), '', 6500);
  return pdf.numPages;
}
async function decodeImage(blob) {
  try { return await createImageBitmap(blob); }
  catch (e) {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image(); img.src = url; await img.decode();
      const w = img.naturalWidth || 1200, h = img.naturalHeight || 1200;
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      return await createImageBitmap(c);
    } finally { URL.revokeObjectURL(url); }
  }
}
const MIME = { jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', heic: 'image/heic' };
async function addImage(file, kind) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const blob = new Blob([bytes], { type: file.type || MIME[kind] || '' });
  let bmp;
  try { bmp = await decodeImage(blob); }
  catch (e) { if (kind === 'heic' || /hei[cf]/i.test(file.type + file.name)) throw { code: 'heic' }; throw e; }
  const id = S.seq++;
  const src = { id, kind: 'image', name: file.name || 'image', size: bytes.length, bytes, mime: blob.type, type: kind, w: bmp.width, h: bmp.height,
    orient: kind === 'jpeg' ? exifOrientation(bytes) : 1, color: nextColor(), aspect: bmp.height / bmp.width };
  S.sources.set(id, src);
  thumbs.set(id + ':0', await bitmapThumb(bmp));
  if (bmp.close) bmp.close();
  S.pages.push({ id: S.seq++, src: id, index: 0, rot: 0, sel: false });
  return 1;
}
function exifOrientation(b) {
  if (b[0] !== 0xFF || b[1] !== 0xD8) return 1;
  let o = 2; const n = Math.min(b.length, 262144);
  while (o + 10 < n) {
    if (b[o] !== 0xFF) return 1;
    const m = b[o + 1], len = (b[o + 2] << 8) | b[o + 3];
    if (m === 0xE1 && b[o + 4] === 0x45 && b[o + 5] === 0x78 && b[o + 6] === 0x69 && b[o + 7] === 0x66) {
      const s = o + 10, le = b[s] === 0x49;
      const r16 = i => le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1];
      const r32 = i => (le ? (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) : ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3])) >>> 0;
      const ifd = s + r32(s + 4); if (ifd + 2 > n) return 1;
      const cnt = r16(ifd);
      for (let i = 0; i < cnt; i++) { const e = ifd + 2 + i * 12; if (e + 10 > n) break; if (r16(e) === 0x0112) return r16(e + 8) || 1; }
      return 1;
    }
    if (m === 0xDA || m === 0xD9) return 1;
    o += 2 + len;
  }
  return 1;
}

/* password prompt (separate small dialog built on the shared one) */
function askPassword(name, wrong) {
  return new Promise(resolve => {
    openDialog({
      title: t('pwTitle'), go: t('pwGo'),
      body: `<p class="note">${esc(t('pwText', { name }))}</p>${wrong ? `<p class="err-t">${esc(t('pwWrong'))}</p>` : ''}
        <div class="field"><label class="lbl" for="pwIn">${esc(t('pwLabel'))}</label><input type="password" id="pwIn" name="pw" autocomplete="off"></div>`,
      quick: true,
      onGo: f => { const v = f.elements.pw.value; resolve(v); return 'close'; },
      onCancel: () => resolve(null)
    });
    setTimeout(() => $('#pwIn') && $('#pwIn').focus(), 30);
  });
}

/* ---------------- thumbnails ---------------- */
const THUMB_PX = 360;
function canvasBlob(c, type = 'image/jpeg', q = .85) {
  if (c.convertToBlob) return c.convertToBlob({ type, quality: q });
  return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('toBlob failed')), type, q));
}
async function bitmapThumb(bmp) {
  const s = Math.min(1, THUMB_PX / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.imageSmoothingQuality = 'high'; x.drawImage(bmp, 0, 0, c.width, c.height);
  return { url: URL.createObjectURL(await canvasBlob(c, 'image/jpeg', .82)), w: c.width, h: c.height };
}
const thumbQ = []; const thumbPending = new Set(); let thumbActive = 0;
function wantThumb(key) {
  if (thumbs.has(key) || thumbPending.has(key)) return;
  thumbPending.add(key); thumbQ.unshift(key); pumpThumbs();
}
function pumpThumbs() {
  while (thumbActive < 2 && thumbQ.length) {
    const key = thumbQ.shift(); thumbActive++;
    renderThumb(key).catch(e => console.warn('thumb', e)).finally(() => { thumbActive--; thumbPending.delete(key); pumpThumbs(); });
  }
}
async function renderThumb(key) {
  const [sid, ix] = key.split(':').map(Number);
  const s = S.sources.get(sid); if (!s || s.kind !== 'pdf') return;
  const page = await s.pdf.getPage(ix + 1);
  const vp0 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: THUMB_PX / Math.max(vp0.width, vp0.height) });
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(vp.width)); c.height = Math.max(1, Math.ceil(vp.height));
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  if (!S.sources.has(sid)) return;
  thumbs.set(key, { url: URL.createObjectURL(await canvasBlob(c, 'image/jpeg', .82)), w: c.width, h: c.height });
  page.cleanup();
  for (const p of S.pages) if (keyOf(p) === key) { const el = cardEls.get(p.id); if (el) paintThumb(el, p); }
}
let io;
function setupObserver() {
  io = new IntersectionObserver(entries => {
    for (const en of entries) if (en.isIntersecting) {
      const p = S.pages.find(q => q.id === +en.target.dataset.pid);
      if (p) wantThumb(keyOf(p));
    }
  }, { root: $('#gridwrap'), rootMargin: '700px 0px' });
}

/* ---------------- workspace rendering ---------------- */
const grid = $('#grid');
const ICON = {
  check: '<svg class="i" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  rotl: '<svg class="i" viewBox="0 0 24 24"><path d="M4 4v5h5"/><path d="M4.6 9A8 8 0 1 1 6 16.5"/></svg>',
  rotr: '<svg class="i" viewBox="0 0 24 24"><path d="M20 4v5h-5"/><path d="M19.4 9A8 8 0 1 0 18 16.5"/></svg>',
  del: '<svg class="i" viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  view: '<svg class="i" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2M11 8.5v5M8.5 11h5"/></svg>',
  x: '<svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  lock: '<svg class="i" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  ok: '<svg class="i" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  info: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>'
};
function makeCard(p) {
  const el = document.createElement('div');
  el.className = 'card'; el.setAttribute('role', 'option'); el.tabIndex = -1; el.dataset.pid = p.id;
  el.innerHTML = `<span class="check">${ICON.check}</span><div class="thumb"><img alt="" draggable="false" hidden><div class="ph"></div></div>
    <div class="meta"><span class="dot"></span><span class="num"></span></div>
    <div class="ops"><button type="button" data-op="rotl" tabindex="-1">${ICON.rotl}</button><button type="button" data-op="rotr" tabindex="-1">${ICON.rotr}</button><button type="button" data-op="del" tabindex="-1">${ICON.del}</button><button type="button" data-op="view" tabindex="-1">${ICON.view}</button></div>`;
  return el;
}
function paintThumb(el, p) {
  const th = thumbs.get(keyOf(p)); const img = el.querySelector('img'); const ph = el.querySelector('.ph');
  if (th) {
    if (img.getAttribute('src') !== th.url) img.src = th.url;
    img.hidden = false; ph.hidden = true;
  } else {
    img.hidden = true; ph.hidden = false;
    const s = S.sources.get(p.src); const a = s ? s.aspect : 1.414;
    ph.style.aspectRatio = a > 0 ? `1 / ${a}` : ''; ph.style.height = 'auto';
    ph.style.width = a >= 1 ? 'calc(var(--tw) * .76)' : 'calc(var(--tw) * .95)';
  }
  img.style.transform = p.rot ? `rotate(${p.rot}deg)` : '';
  img.classList.toggle('q', p.rot % 180 !== 0);
}
function updateCard(el, p, i) {
  const s = S.sources.get(p.src);
  el.querySelector('.num').textContent = NF.format(i + 1);
  el.querySelector('.dot').style.setProperty('--c', s.color);
  el.classList.toggle('sel', !!p.sel);
  el.setAttribute('aria-selected', p.sel ? 'true' : 'false');
  const lbl = t('pageLabel', { n: i + 1 }) + ' — ' + t('pageOf', { file: s.name, p: p.index + 1 });
  el.setAttribute('aria-label', lbl); el.title = s.kind === 'pdf' ? t('pageOf', { file: s.name, p: p.index + 1 }) : s.name;
  const ops = el.querySelectorAll('[data-op]');
  for (const b of ops) { const k = { rotl: 'rotL', rotr: 'rotR', del: 'del', view: 'view' }[b.dataset.op]; b.setAttribute('aria-label', t(k)); b.title = t(k); }
  paintThumb(el, p);
}
function renderGrid() {
  const alive = new Set();
  S.pages.forEach((p, i) => {
    let el = cardEls.get(p.id);
    if (!el) { el = makeCard(p); cardEls.set(p.id, el); io.observe(el); }
    alive.add(p.id); updateCard(el, p, i);
  });
  for (const [pid, el] of cardEls) if (!alive.has(pid)) { io.unobserve(el); el.remove(); cardEls.delete(pid); }
  let prev = null;
  for (const p of S.pages) {
    const el = cardEls.get(p.id); const want = prev ? prev.nextSibling : grid.firstChild;
    if (el !== want) grid.insertBefore(el, want);
    prev = el;
  }
  if (S.focus == null || !cardEls.has(S.focus)) S.focus = S.pages[0] ? S.pages[0].id : null;
  for (const [pid, el] of cardEls) el.tabIndex = pid === S.focus ? 0 : -1;
}
function renderChips() {
  const used = new Map();
  for (const p of S.pages) used.set(p.src, (used.get(p.src) || 0) + 1);
  const box = $('#chips'); box.innerHTML = '';
  for (const [sid, n] of used) {
    const s = S.sources.get(sid);
    const c = document.createElement('span'); c.className = 'chip'; c.style.setProperty('--c', s.color);
    c.title = s.name + ' · ' + fmtSize(s.size);
    c.innerHTML = `<span class="dot"></span><span class="nm">${esc(s.name)}</span><span class="ct">${esc(t('pageCount', { n }))}</span>${s.encrypted ? `<span class="lk" title="${esc(t('encShort'))}">${ICON.lock}</span>` : ''}<button type="button" aria-label="${esc(t('removeFile', { name: s.name }))}" title="${esc(t('removeFile', { name: s.name }))}">${ICON.x}</button>`;
    c.querySelector('button').onclick = () => { snapshot(); S.pages = S.pages.filter(p => p.src !== sid); if (!S.pages.length) closeWork(true); else updateUI(); };
    box.append(c);
  }
}
function updateSel() {
  const n = S.pages.length, ns = selected().length;
  const all = $('#selAll'); all.checked = n > 0 && ns === n; all.indeterminate = ns > 0 && ns < n;
  $('#selInfo').textContent = ns ? t('selCount', { n: ns }) : t('selAll');
  for (const p of S.pages) { const el = cardEls.get(p.id); if (el) { el.classList.toggle('sel', !!p.sel); el.setAttribute('aria-selected', p.sel ? 'true' : 'false'); } }
  grid.classList.toggle('selecting', ns > 0);
  $('#delBtn').disabled = !ns;
}
function updateUI() {
  if ($('#work').hidden) return;
  renderChips(); renderGrid(); updateSel();
  const n = S.pages.length, files = new Set(S.pages.map(p => p.src)).size;
  $('#sum').textContent = n ? t('pageCount', { n }) + ' · ' + t('fileCount', { n: files }) : '';
  for (const id of ['#saveBtn', '#splitBtn', '#compBtn', '#imgBtn', '#rotLBtn', '#rotRBtn', '#revBtn']) $(id).disabled = !n;
  $('#splitBtn').disabled = n < 2;
  $('#undoBtn').disabled = !S.undo.length;
  if (!n) grid.innerHTML = '';
}
function showWork(on) {
  $('#home').hidden = on; $('#work').hidden = !on;
  if (on) updateUI();
}
function resetAll() {
  for (const s of S.sources.values()) if (s.pdf) s.pdf.destroy().catch(() => {});
  for (const th of thumbs.values()) URL.revokeObjectURL(th.url);
  thumbs.clear(); thumbQ.length = 0; thumbPending.clear();
  for (const el of cardEls.values()) { io.unobserve(el); el.remove(); }
  cardEls.clear();
  S.sources.clear(); S.pages = []; S.undo = []; S.anchor = null; S.focus = null; S.colorIdx = 0;
  $('#hint').hidden = true;
}
function closeWork(force) {
  const go = () => { resetAll(); showWork(false); $('#pickBtn').focus(); };
  if (force || !S.pages.length) return go();
  openDialog({ title: t('confirmClose'), body: `<p class="note">${esc(t('confirmCloseD'))}</p>`, go: t('confirmCloseBtn'), quick: true, onGo: () => { go(); return 'close'; } });
}
function showHint(text, key) {
  $('#hintText').textContent = text; $('#hint').hidden = false;
  $('#hintClose').onclick = () => { $('#hint').hidden = true; if (key) store(key, '1'); };
}

/* ---------------- selection, ops, keyboard ---------------- */
let suppressClick = false;
function idxOf(pid) { return S.pages.findIndex(p => p.id === pid); }
function focusCard(pid) {
  S.focus = pid;
  for (const [id, el] of cardEls) el.tabIndex = id === pid ? 0 : -1;
  const el = cardEls.get(pid); if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest' }); }
}
function rotate(list, d) { if (!list.length) return; snapshot(); for (const p of list) p.rot = ((p.rot + d) % 360 + 360) % 360; updateUI(); }
function removePages(list) {
  if (!list.length) return;
  snapshot();
  const ids = new Set(list.map(p => p.id));
  const firstIdx = S.pages.findIndex(p => ids.has(p.id));
  S.pages = S.pages.filter(p => !ids.has(p.id));
  const nf = S.pages[Math.min(firstIdx, S.pages.length - 1)];
  S.focus = nf ? nf.id : null;
  updateUI();
  toast(t('deleted', { n: list.length }), '', 6000, { label: t('undo'), run: undo });
}
grid.addEventListener('click', e => {
  if (suppressClick) { suppressClick = false; return; }
  const card = e.target.closest('.card'); if (!card) return;
  const pid = +card.dataset.pid, i = idxOf(pid); if (i < 0) return;
  const op = e.target.closest('[data-op]');
  if (op) {
    const p = S.pages[i];
    if (op.dataset.op === 'rotl') rotate([p], -90);
    else if (op.dataset.op === 'rotr') rotate([p], 90);
    else if (op.dataset.op === 'del') removePages([p]);
    else if (op.dataset.op === 'view') openPreview(i);
    return;
  }
  if (e.shiftKey && S.anchor != null && idxOf(S.anchor) >= 0) {
    const a = idxOf(S.anchor), [lo, hi] = a < i ? [a, i] : [i, a];
    for (let k = lo; k <= hi; k++) S.pages[k].sel = true;
  } else { S.pages[i].sel = !S.pages[i].sel; S.anchor = pid; }
  focusCard(pid); updateSel();
});
grid.addEventListener('dblclick', e => { const card = e.target.closest('.card'); if (card && !e.target.closest('[data-op]')) openPreview(idxOf(+card.dataset.pid)); });
function columns() {
  const cards = grid.children; if (!cards.length) return 1;
  const top = cards[0].offsetTop; let c = 0;
  for (const el of cards) { if (el.offsetTop !== top) break; c++; }
  return Math.max(1, c);
}
grid.addEventListener('keydown', e => {
  if (!S.pages.length) return;
  const i = Math.max(0, idxOf(S.focus)); const p = S.pages[i];
  const k = e.key; const mod = e.ctrlKey || e.metaKey;
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns(), ArrowDown: columns(), Home: -1e9, End: 1e9 }[k];
  if (step != null && e.altKey && !mod) {
    e.preventDefault();
    const j = Math.max(0, Math.min(S.pages.length - 1, i + step)); if (j === i) return;
    snapshot(); const [m] = S.pages.splice(i, 1); S.pages.splice(j, 0, m); updateUI(); focusCard(m.id); return;
  }
  if (step != null) {
    e.preventDefault();
    const j = Math.max(0, Math.min(S.pages.length - 1, i + step));
    if (e.shiftKey) { const [lo, hi] = i < j ? [i, j] : [j, i]; for (let q = lo; q <= hi; q++) S.pages[q].sel = true; updateSel(); }
    focusCard(S.pages[j].id); return;
  }
  if (k === ' ') { e.preventDefault(); p.sel = !p.sel; S.anchor = p.id; updateSel(); return; }
  if (k === 'Enter') { e.preventDefault(); openPreview(i); return; }
  if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); removePages(selected().length ? selected() : [p]); return; }
  if ((k === 'r' || k === 'R') && !mod) { e.preventDefault(); rotate(selected().length ? selected() : [p], e.shiftKey ? -90 : 90); return; }
  if (mod && (k === 'a' || k === 'A')) { e.preventDefault(); for (const q of S.pages) q.sel = true; updateSel(); return; }
  if (k === 'Escape' && selected().length) { e.preventDefault(); for (const q of S.pages) q.sel = false; updateSel(); }
});
grid.addEventListener('focusin', e => { const card = e.target.closest('.card'); if (card) { S.focus = +card.dataset.pid; for (const [id, el] of cardEls) el.tabIndex = id === S.focus ? 0 : -1; } });

/* drag to reorder (mouse, pen, long-press on touch) */
let drag = null;
grid.addEventListener('pointerdown', e => {
  suppressClick = false;
  if (e.button !== 0 || e.target.closest('.ops') || e.target.closest('.check')) return;
  const card = e.target.closest('.card'); if (!card) return;
  drag = { pid: +card.dataset.pid, x: e.clientX, y: e.clientY, active: false, id: e.pointerId, touch: e.pointerType === 'touch', timer: 0 };
  if (drag.touch) { const d = drag; drag.timer = setTimeout(() => { if (drag === d && !d.active) { startDrag(d.x, d.y); if (navigator.vibrate) navigator.vibrate(15); } }, 400); }
});
window.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.id) return;
  if (!drag.active) {
    const dist = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
    if (drag.touch) { if (dist > 10) { clearTimeout(drag.timer); drag = null; } return; }
    if (dist < 7) return;
    startDrag(e.clientX, e.clientY);
  }
  moveDrag(e.clientX, e.clientY);
});
window.addEventListener('pointerup', e => {
  if (!drag || e.pointerId !== drag.id) return;
  clearTimeout(drag.timer);
  if (drag.active) { endDrag(true); suppressClick = true; }
  drag = null;
});
window.addEventListener('pointercancel', () => { if (drag) { clearTimeout(drag.timer); if (drag.active) endDrag(false); drag = null; } });
grid.addEventListener('touchmove', e => { if (drag && drag.active) e.preventDefault(); }, { passive: false });
grid.addEventListener('contextmenu', e => { if (drag && drag.touch) e.preventDefault(); });
function startDrag(x, y) {
  drag.active = true;
  const p = S.pages.find(q => q.id === drag.pid); if (!p) { drag = null; return; }
  drag.ids = p.sel ? selected().map(q => q.id) : [p.id];
  for (const id of drag.ids) { const el = cardEls.get(id); if (el) el.classList.add('lifted'); }
  const g = document.createElement('div'); g.className = 'dragghost';
  const th = thumbs.get(keyOf(p));
  g.innerHTML = (th ? `<img src="${th.url}" alt="" style="transform:rotate(${p.rot}deg)">` : '<img alt="">') + (drag.ids.length > 1 ? `<b>${NF.format(drag.ids.length)}</b>` : '');
  g.style.setProperty('--tw', getComputedStyle(grid).getPropertyValue('--tw'));
  document.body.append(g); drag.ghost = g;
  document.body.style.cursor = 'grabbing';
  moveDrag(x, y);
}
function clearMark() { if (drag && drag.mark) { drag.mark.classList.remove('ins-before', 'ins-after'); drag.mark = null; } }
function moveDrag(x, y) {
  drag.ghost.style.left = x + 'px'; drag.ghost.style.top = y + 'px';
  clearMark(); drag.target = null;
  let card = document.elementFromPoint(x, y); card = card && card.closest ? card.closest('.card') : null;
  if (!card || !grid.contains(card)) {
    let best = null, bd = Infinity;
    for (const el of grid.children) {
      const r = el.getBoundingClientRect(); if (r.bottom < -50 || r.top > innerHeight + 50) continue;
      const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2)); if (d < bd) { bd = d; best = el; }
    }
    card = best;
  }
  if (card) {
    const r = card.getBoundingClientRect(); const after = x > r.left + r.width / 2;
    card.classList.add(after ? 'ins-after' : 'ins-before'); drag.mark = card;
    drag.target = { pid: +card.dataset.pid, after };
  }
  const wr = $('#gridwrap').getBoundingClientRect(); const edge = 70;
  drag.vy = y < wr.top + edge ? -(wr.top + edge - y) / 4 : y > wr.bottom - edge ? (y - (wr.bottom - edge)) / 4 : 0;
  if (drag.vy && !drag.raf) {
    const loop = () => { if (!drag || !drag.active || !drag.vy) { if (drag) drag.raf = 0; return; } $('#gridwrap').scrollTop += drag.vy; drag.raf = requestAnimationFrame(loop); };
    drag.raf = requestAnimationFrame(loop);
  }
}
function endDrag(commit) {
  clearMark();
  if (drag.ghost) drag.ghost.remove();
  for (const id of drag.ids || []) { const el = cardEls.get(id); if (el) el.classList.remove('lifted'); }
  document.body.style.cursor = '';
  drag.vy = 0;
  const tg = drag.target;
  if (commit && tg && !drag.ids.includes(tg.pid)) {
    snapshot();
    const ids = new Set(drag.ids);
    const moving = S.pages.filter(p => ids.has(p.id)); const rest = S.pages.filter(p => !ids.has(p.id));
    let at = rest.findIndex(p => p.id === tg.pid); if (tg.after) at++;
    rest.splice(at, 0, ...moving); S.pages = rest; updateUI();
  }
}

/* toolbar */
$('#selAll').onchange = e => { const v = e.target.checked; for (const p of S.pages) p.sel = v; updateSel(); };
$('#rotLBtn').onclick = () => rotate(selected().length ? selected() : S.pages, -90);
$('#rotRBtn').onclick = () => rotate(selected().length ? selected() : S.pages, 90);
$('#delBtn').onclick = () => removePages(selected());
$('#revBtn').onclick = () => { if (S.pages.length < 2) return; snapshot(); S.pages.reverse(); updateUI(); };
$('#undoBtn').onclick = undo;
$('#zoom').oninput = e => { grid.style.setProperty('--tw', e.target.value + 'px'); store('zimba.zoom', e.target.value); };
$('#closeBtn').onclick = () => closeWork(false);
$('#addBtn').onclick = () => pick(null);
$('#saveBtn').onclick = () => openSave();
$('#splitBtn').onclick = () => openSplit();
$('#compBtn').onclick = () => openCompress();
$('#imgBtn').onclick = () => openImages();

/* ---------------- dialogs ---------------- */
const dlg = $('#dlg'), form = $('#dlgForm');
let D = null;
function openDialog({ title, body, go, onGo, onInput, onCancel, quick }) {
  if (dlg.open) { if (D && D.onCancel) D.onCancel(); dlg.close(); }
  form.innerHTML = `<h2>${esc(title)}</h2><div class="dlg-body">${body}</div>
    <div class="dlg-run" hidden><div class="prog"><i></i></div><p class="prog-t"></p></div>
    <div class="dlg-res" hidden></div><p class="err-t dlg-err" hidden></p>
    <div class="dlg-foot"><button type="button" class="btn ghost" data-act="cancel">${esc(t('cancel'))}</button><button type="submit" class="btn primary" data-act="go">${esc(go)}</button></div>`;
  D = { onGo, onInput, onCancel, quick, running: false, aborted: false, done: false };
  form.oninput = form.onchange = onInput ? () => onInput(form) : null;
  if (onInput) onInput(form);
  form.querySelector('[data-act=cancel]').onclick = () => cancelDialog();
  dlg.showModal();
  const first = form.querySelector('.dlg-body input:not([type=radio]):not([type=checkbox]), .dlg-body select');
  if (first && first.type === 'text') { first.focus(); first.select(); }
  else form.querySelector('[data-act=go]').focus();
}
function cancelDialog() {
  if (!D) return dlg.close();
  if (D.running) { D.aborted = true; return; }
  const c = D.onCancel; D = null; dlg.close(); if (c) c();
}
dlg.addEventListener('cancel', e => { e.preventDefault(); cancelDialog(); });
form.addEventListener('submit', async e => {
  e.preventDefault();
  if (!D || D.running) return;
  if (D.done) { D = null; dlg.close(); return; }
  const st = D;
  const err = form.querySelector('.dlg-err'); err.hidden = true;
  const run = form.querySelector('.dlg-run'), bar = run.querySelector('.prog'), barI = bar.querySelector('i'), txt = run.querySelector('.prog-t');
  const goB = form.querySelector('[data-act=go]'), cancelB = form.querySelector('[data-act=cancel]');
  const ui = {
    get aborted() { return st.aborted; },
    check() { if (st.aborted) throw ABORT; },
    invalid(msg) { err.textContent = msg; err.hidden = false; },
    start() {
      st.running = true; form.querySelector('.dlg-body').hidden = true; run.hidden = false; goB.disabled = true;
      cancelB.textContent = t('cancel'); ui.progress(0, 0);
    },
    progress(i, n, label) {
      bar.classList.toggle('ind', !n); barI.style.width = n ? Math.min(100, i / n * 100) + '%' : '';
      txt.textContent = label || (n ? t('progPage', { i, n }) : t('working'));
    }
  };
  let res;
  try { res = await st.onGo(form, ui); }
  catch (ex) {
    st.running = false;
    if (ex === ABORT) { D = null; dlg.close(); toast(t('cancelled')); return; }
    console.error(ex);
    run.hidden = true; form.querySelector('.dlg-body').hidden = false; goB.disabled = false;
    err.textContent = t('errFail', { msg: (ex && (ex.message || ex.name)) || String(ex) }); err.hidden = false;
    return;
  }
  st.running = false;
  if (res === 'close') { if (D === st) { D = null; dlg.close(); } return; }
  if (!res) { goB.disabled = false; return; }
  // show result
  st.done = true;
  run.hidden = true; form.querySelector('.dlg-body').hidden = true;
  const box = form.querySelector('.dlg-res'); box.hidden = false;
  box.innerHTML = `<div class="res"><span class="ok${res.warn ? ' warn' : ''}">${res.warn ? ICON.info : ICON.ok}</span><div><b>${esc(res.title || t('done'))}</b><span>${esc(res.text || '')}</span>${res.note ? `<span>${esc(res.note)}</span>` : ''}</div></div>`;
  goB.disabled = false; goB.textContent = t('close');
  if (res.again) { cancelB.textContent = t('downloadAgain'); cancelB.onclick = res.again; }
  else cancelB.hidden = true;
  goB.focus();
});
function scopeField(def) {
  const n = S.pages.length, ns = selected().length;
  if (!ns) return '';
  return `<div class="field"><span class="lbl">${esc(t('scope'))}</span><div class="seg">
    <label><input type="radio" name="scope" value="all" ${def === 'all' ? 'checked' : ''}>${esc(t('scopeAll', { n }))}</label>
    <label><input type="radio" name="scope" value="sel" ${def === 'sel' ? 'checked' : ''}>${esc(t('scopeSel', { n: ns }))}</label></div></div>`;
}
function scopePages(f) { return f.elements.scope && f.elements.scope.value === 'sel' ? selected() : S.pages.slice(); }
function baseName(list) {
  const ids = [...new Set(list.map(p => p.src))];
  if (ids.length !== 1) return null;
  return S.sources.get(ids[0]).name.replace(/\.[a-z0-9]{2,5}$/i, '');
}
function cleanName(s, fallback) {
  s = String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  return (s || fallback || 'document').slice(0, 120);
}
function defaultPdfName(list, scope) {
  const b = baseName(list);
  if (!b) return t('mergedName');
  if (scope === 'sel') return b + '-' + t('pagesSfx');
  return b + '-' + t('editedSfx');
}

/* save target: native "Save as" where available, otherwise a normal download */
const canPick = typeof window.showSaveFilePicker === 'function' && !navigator.webdriver && window.self === window.top;
async function prepareSave(name, mime) {
  if (!canPick) return { mode: 'dl' };
  const ext = name.slice(name.lastIndexOf('.'));
  try {
    const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: ext.slice(1).toUpperCase(), accept: { [mime]: [ext] } }] });
    return { mode: 'fs', handle };
  } catch (e) { if (e && e.name === 'AbortError') return null; return { mode: 'dl' }; }
}
function download(blob, name) {
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener'; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}
async function writeOut(target, blob, name) {
  if (target.mode === 'fs') {
    try { const w = await target.handle.createWritable(); await w.write(blob); await w.close(); return { name: target.handle.name }; }
    catch (e) { console.warn(e); }
  }
  download(blob, name);
  return { name, again: () => download(blob, name) };
}

/* Save as PDF (merge / organize / extract / page numbers / images to PDF) */
function openSave(opt = {}) {
  if (!S.pages.length) return;
  const scope = opt.scope || (selected().length ? 'sel' : 'all');
  const hasImg = S.pages.some(p => S.sources.get(p.src).kind === 'image');
  let nameTouched = false;
  openDialog({
    title: t('saveTitle'), go: t('saveGo'),
    body: `${scopeField(scope)}
      <div class="field"><label class="lbl" for="fName">${esc(t('fileName'))}</label><input type="text" id="fName" name="fname" value="${esc(defaultPdfName(scope === 'sel' ? selected() : S.pages, scope))}" maxlength="120" autocomplete="off" spellcheck="false"></div>
      <label class="cbx"><input type="checkbox" name="num" ${opt.numbers ? 'checked' : ''}>${esc(t('numbers'))}</label>
      <div class="sub" data-show="num"><div class="row2">
        <div class="field"><label class="lbl">${esc(t('numPos'))}</label><select name="pos"><option value="c">${esc(t('posCenter'))}</option><option value="r">${esc(t('posRight'))}</option></select></div>
        <div class="field"><label class="lbl">${esc(t('numFmt'))}</label><select name="fmt"><option value="n">1, 2, 3</option><option value="of">1 / N</option></select></div>
      </div></div>
      ${hasImg ? `<div class="field"><span class="lbl">${esc(t('imgPages'))}</span><div class="row2">
        <select name="isize" aria-label="${esc(t('pageSize'))}"><option value="a4" ${isLetter ? '' : 'selected'}>A4</option><option value="letter" ${isLetter ? 'selected' : ''}>Letter</option><option value="fit">${esc(t('sizeFit'))}</option></select>
        <select name="imargin" aria-label="${esc(t('margin'))}"><option value="0">${esc(t('marginNone'))}</option><option value="1" selected>${esc(t('marginSmall'))}</option></select></div></div>` : ''}`,
    onInput: f => {
      f.querySelector('[data-show=num]').hidden = !f.elements.num.checked;
      if (document.activeElement === f.elements.fname) nameTouched = true;
      if (!nameTouched && f.elements.scope) { const sc = f.elements.scope.value; f.elements.fname.value = defaultPdfName(sc === 'sel' ? selected() : S.pages, sc); }
    },
    onGo: async (f, ui) => {
      const list = scopePages(f); if (!list.length) { ui.invalid(t('noPages')); return null; }
      const name = cleanName(f.elements.fname.value, t('mergedName')) + '.pdf';
      const target = await prepareSave(name, 'application/pdf'); if (!target) return null;
      ui.start();
      const opts = { numbers: f.elements.num.checked, pos: f.elements.pos.value, fmt: f.elements.fmt.value,
        isize: f.elements.isize ? f.elements.isize.value : 'a4', imargin: f.elements.imargin ? f.elements.imargin.value === '1' : true };
      const bytes = await buildPdf(list, opts, ui);
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const w = await writeOut(target, blob, name);
      return { text: t('savedTo', { name: w.name, size: fmtSize(blob.size) }), note: t('pageCount', { n: list.length }), again: w.again };
    }
  });
}

/* Split */
function parseRanges(str, n) {
  const parts = String(str || '').split(/[,;\s]+/).filter(Boolean); if (!parts.length) return null;
  const out = [];
  for (const raw of parts) {
    const m = raw.match(/^(\d+)?\s*[-–—]\s*(\d+)?$/) || raw.match(/^(\d+)$/);
    if (!m) return null;
    let a, b;
    if (m.length === 2) { a = b = +m[1]; } else { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : n; }
    if (!(a >= 1 && b <= n && a <= b)) return null;
    out.push([a, b]);
  }
  return out;
}
function splitPlan(f) {
  const n = S.pages.length, mode = f.elements.mode.value;
  if (mode === 'each') return S.pages.map((p, i) => [i + 1, i + 1]);
  if (mode === 'n') {
    const k = Math.floor(+f.elements.every.value); if (!(k >= 1 && k <= n)) return null;
    const r = []; for (let a = 1; a <= n; a += k) r.push([a, Math.min(n, a + k - 1)]); return r;
  }
  return parseRanges(f.elements.ranges.value, n);
}
function openSplit() {
  const n = S.pages.length; if (n < 2) return;
  openDialog({
    title: t('splitTitle'), go: t('splitGo'),
    body: `<label class="opt"><input type="radio" name="mode" value="each" checked><div><b>${esc(t('splitEach'))}</b><span>${esc(t('splitEachD', { n }))}</span></div></label>
      <label class="opt"><input type="radio" name="mode" value="n"><div><b>${esc(t('splitN'))}</b><span class="inl">${esc(t('splitNPre'))} <input type="number" name="every" min="1" max="${n}" value="${Math.min(2, n)}" inputmode="numeric"> ${esc(t('splitNPost'))}</span></div></label>
      <label class="opt"><input type="radio" name="mode" value="ranges"><div><b>${esc(t('splitRanges'))}</b><span class="inl"><input type="text" name="ranges" placeholder="${esc(t('rangesHint'))}" autocomplete="off" spellcheck="false"></span></div></label>
      <p class="note" id="splitInfo"></p>`,
    onInput: f => {
      const plan = splitPlan(f); const info = f.querySelector('#splitInfo');
      const empty = f.elements.mode.value === 'ranges' && !f.elements.ranges.value.trim();
      info.classList.toggle('bad', !plan && !empty);
      if (!plan) { info.textContent = empty ? t('rangesHint2', { n }) : t('rangesErr', { n }); return; }
      info.textContent = plan.length === 1 ? t('splitOne') : t('splitInfo', { n: plan.length });
    },
    onGo: async (f, ui) => {
      const plan = splitPlan(f);
      if (!plan) { const info = f.querySelector('#splitInfo'); info.classList.add('bad'); info.textContent = t('rangesErr', { n }); const r = f.elements.mode.value === 'ranges' ? f.elements.ranges : f.elements.every; if (r) r.focus(); return null; }
      const base = cleanName(baseName(S.pages) || t('mergedName'));
      const pad = String(n).length;
      const nm = ([a, b]) => a === b ? `${base}-${String(a).padStart(pad, '0')}.pdf` : `${base}-${String(a).padStart(pad, '0')}-${String(b).padStart(pad, '0')}.pdf`;
      const single = plan.length === 1;
      const outName = single ? nm(plan[0]) : `${base}-${t('splitSfx')}.zip`;
      const target = await prepareSave(outName, single ? 'application/pdf' : 'application/zip'); if (!target) return null;
      ui.start();
      const files = [];
      for (let k = 0; k < plan.length; k++) {
        ui.check(); ui.progress(k, plan.length, t('progPart', { i: k + 1, n: plan.length }));
        const [a, b] = plan[k];
        const bytes = await buildPdf(S.pages.slice(a - 1, b), {}, null, ui);
        files.push({ name: nm(plan[k]), data: bytes });
      }
      ui.progress(plan.length, plan.length, t('progSave'));
      const blob = single ? new Blob([files[0].data], { type: 'application/pdf' }) : makeZip(uniqueNames(files));
      const w = await writeOut(target, blob, outName);
      return { text: t('savedTo', { name: w.name, size: fmtSize(blob.size) }), note: single ? '' : t('splitDone', { n: files.length }), again: w.again };
    }
  });
  setTimeout(() => {
    for (const inp of form.querySelectorAll('.opt input[type=number], .opt input[type=text]'))
      inp.addEventListener('focus', () => { inp.closest('.opt').querySelector('input[type=radio]').checked = true; if (D && D.onInput) D.onInput(form); });
  });
}

/* Compress */
const LEVELS = { light: { max: 2400, q: .8, flate: false }, med: { max: 1700, q: .68, flate: 1.2e6 }, strong: { max: 1150, q: .5, flate: 2.5e5 } };
function openCompress() {
  if (!S.pages.length) return;
  openDialog({
    title: t('compTitle'), go: t('compGo'),
    body: `<label class="opt"><input type="radio" name="lv" value="light"><div><b>${esc(t('compLight'))}</b><span>${esc(t('compLightD'))}</span></div></label>
      <label class="opt"><input type="radio" name="lv" value="med" checked><div><b>${esc(t('compMed'))}</b><span>${esc(t('compMedD'))}</span></div></label>
      <label class="opt"><input type="radio" name="lv" value="strong"><div><b>${esc(t('compStrong'))}</b><span>${esc(t('compStrongD'))}</span></div></label>
      <p class="note">${esc(t('compNote'))}</p>`,
    onGo: async (f, ui) => {
      const list = S.pages.slice();
      const b = baseName(list);
      const name = cleanName(b ? b + '-' + t('compSfx') : t('mergedName') + '-' + t('compSfx')) + '.pdf';
      const target = await prepareSave(name, 'application/pdf'); if (!target) return null;
      ui.start();
      const srcIds = [...new Set(list.map(p => p.src))];
      const before = srcIds.reduce((a, id) => a + S.sources.get(id).size, 0);
      const built = await buildPdf(list, {}, ui);
      const small = await compressBytes(built, LEVELS[f.elements.lv.value], ui);
      let best = small.length < built.length ? small : built;
      // if the workspace is exactly one untouched PDF, never hand back something bigger than the original
      const one = srcIds.length === 1 && S.sources.get(srcIds[0]);
      const untouched = one && one.kind === 'pdf' && list.length === one.numPages && list.every((p, i) => p.index === i && !p.rot);
      if (untouched && best.length >= one.bytes.length) best = one.bytes;
      const blob = new Blob([best], { type: 'application/pdf' });
      const w = await writeOut(target, blob, name);
      const pct = Math.round((1 - blob.size / before) * 100);
      if (pct < 3) return { warn: true, title: t('compNoGainT'), text: t('compNoGain'), note: t('savedTo', { name: w.name, size: fmtSize(blob.size) }), again: w.again };
      return { text: t('compResult', { before: fmtSize(before), after: fmtSize(blob.size), pct }), note: t('savedTo', { name: w.name, size: fmtSize(blob.size) }), again: w.again };
    }
  });
}

/* PDF to images */
function openImages() {
  if (!S.pages.length) return;
  const scope = selected().length ? 'sel' : 'all';
  openDialog({
    title: t('imgTitle'), go: t('imgGo'),
    body: `${scopeField(scope)}
      <div class="field"><span class="lbl">${esc(t('format'))}</span><div class="seg"><label><input type="radio" name="fmt" value="png">PNG</label><label><input type="radio" name="fmt" value="jpg" checked>JPG</label></div></div>
      <div class="field"><span class="lbl">${esc(t('quality'))}</span><div class="seg"><label><input type="radio" name="dpi" value="96">${esc(t('dpi96'))}</label><label><input type="radio" name="dpi" value="150" checked>${esc(t('dpi150'))}</label><label><input type="radio" name="dpi" value="300">${esc(t('dpi300'))}</label></div></div>
      <p class="note" id="imgInfo"></p>`,
    onInput: f => { const n = scopePages(f).length; f.querySelector('#imgInfo').textContent = n > 1 ? t('imgInfoMany', { n }) : t('imgInfoOne'); },
    onGo: async (f, ui) => {
      const list = scopePages(f); const fmt = f.elements.fmt.value, dpi = +f.elements.dpi.value;
      const base = cleanName(baseName(list) || t('mergedName'));
      const pad = String(list.length).length;
      const ext = fmt === 'png' ? 'png' : 'jpg', mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
      const nm = i => list.length === 1 ? `${base}.${ext}` : `${base}-${String(i + 1).padStart(Math.max(2, pad), '0')}.${ext}`;
      const outName = list.length === 1 ? nm(0) : `${base}-${t('imgSfx')}.zip`;
      const target = await prepareSave(outName, list.length === 1 ? mime : 'application/zip'); if (!target) return null;
      ui.start();
      const files = [];
      for (let i = 0; i < list.length; i++) {
        ui.check(); ui.progress(i, list.length, t('progPage', { i: i + 1, n: list.length }));
        const blob = await renderPageImage(list[i], dpi, mime);
        files.push({ name: nm(i), data: new Uint8Array(await blob.arrayBuffer()), blob });
      }
      const out = list.length === 1 ? files[0].blob : makeZip(files);
      const w = await writeOut(target, out, outName);
      return { text: t('savedTo', { name: w.name, size: fmtSize(out.size) }), note: list.length > 1 ? t('imgDone', { n: list.length }) : '', again: w.again };
    }
  });
}

function runIntent(intent) {
  if (intent === 'split' && S.pages.length > 1) openSplit();
  else if (intent === 'compress') openCompress();
  else if (intent === 'pdf2img') openImages();
  else if (intent === 'numbers') openSave({ numbers: true });
  else if (intent === 'extract') showHint(t('hintExtract'));
}

/* ---------------- PDF building ---------------- */
const SIZES = { a4: [595.28, 841.89], letter: [612, 792] };
async function getLibDoc(s) {
  if (s.libDoc !== undefined) return s.libDoc;
  try { s.libDoc = await PDFDocument.load(s.bytes, { updateMetadata: false }); }
  catch (e) { console.warn('pdf-lib could not load', s.name, e && e.message); s.libDoc = null; }
  return s.libDoc;
}
async function buildPdf(list, opts = {}, ui, outerUi) {
  const U = ui || outerUi;
  const out = await PDFDocument.create({ updateMetadata: false });
  const need = new Map();
  for (const p of list) { const s = S.sources.get(p.src); if (s.kind === 'pdf') { if (!need.has(s.id)) need.set(s.id, []); need.get(s.id).push(p.index); } }
  const copied = new Map();
  for (const [sid, idxs] of need) {
    if (U) U.check();
    const s = S.sources.get(sid); const doc = await getLibDoc(s); if (!doc) continue;
    const uniq = [...new Set(idxs)];
    try {
      const pages = await out.copyPages(doc, uniq);
      uniq.forEach((ix, k) => copied.set(sid + ':' + ix, pages[k]));
    } catch (e) { console.warn('copyPages failed, rasterizing', e); }
  }
  let font = null; const N = list.length;
  for (let i = 0; i < N; i++) {
    if (U) U.check();
    if (ui) ui.progress(i, N, t('progPage', { i: i + 1, n: N }));
    const p = list[i]; const s = S.sources.get(p.src); let page;
    if (s.kind === 'image') page = await addImagePage(out, s, opts);
    else {
      const cp = copied.get(s.id + ':' + p.index);
      page = cp ? out.addPage(cp) : await addRasterPage(out, s, p.index);
    }
    if (p.rot) page.setRotation(degrees((((page.getRotation().angle || 0) + p.rot) % 360 + 360) % 360));
    if (opts.numbers) { if (!font) font = await out.embedFont(StandardFonts.Helvetica); drawNumber(page, i + 1, N, opts, font); }
    if (i % 4 === 3) await tick();
  }
  if (ui) ui.progress(N, N, t('progSave'));
  out.setProducer('Zımba'); out.setCreator('Zımba');
  await tick();
  return await out.save({ useObjectStreams: true, objectsPerTick: 200 });
}
async function imageBytesFor(s) {
  if (s.type === 'jpeg' && (!s.orient || s.orient === 1)) return { kind: 'jpg', bytes: s.bytes };
  if (s.type === 'png') return { kind: 'png', bytes: s.bytes };
  const bmp = await decodeImage(new Blob([s.bytes], { type: s.mime }));
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  const x = c.getContext('2d');
  const lossless = s.type === 'gif' || s.type === 'bmp' || /svg/.test(s.mime || '');
  if (!lossless) { x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); }
  x.drawImage(bmp, 0, 0); if (bmp.close) bmp.close();
  const blob = await canvasBlob(c, lossless ? 'image/png' : 'image/jpeg', .92);
  c.width = c.height = 0;
  return { kind: lossless ? 'png' : 'jpg', bytes: new Uint8Array(await blob.arrayBuffer()) };
}
async function addImagePage(out, s, opts) {
  const { kind, bytes } = await imageBytesFor(s);
  const img = kind === 'png' ? await out.embedPng(bytes) : await out.embedJpg(bytes);
  const iw = img.width, ih = img.height;
  let pw, ph, x, y, w, h;
  if (opts.isize === 'fit') {
    const k = Math.min(0.75, 1190 / Math.max(iw, ih));
    pw = w = Math.max(72, iw * k); ph = h = Math.max(72, ih * k); x = y = 0;
  } else {
    let [a, b] = SIZES[opts.isize] || SIZES[isLetter ? 'letter' : 'a4'];
    if (iw > ih) [a, b] = [b, a];
    pw = a; ph = b;
    const m = opts.imargin === false ? 0 : 28;
    const k = Math.min((pw - 2 * m) / iw, (ph - 2 * m) / ih);
    w = iw * k; h = ih * k; x = (pw - w) / 2; y = (ph - h) / 2;
  }
  const page = out.addPage([pw, ph]);
  page.drawImage(img, { x, y, width: w, height: h });
  return page;
}
async function addRasterPage(out, s, index) {
  const page = await s.pdf.getPage(index + 1);
  const vp1 = page.getViewport({ scale: 1 });
  let scale = 160 / 72; const maxPx = 3000;
  if (Math.max(vp1.width, vp1.height) * scale > maxPx) scale = maxPx / Math.max(vp1.width, vp1.height);
  const vp = page.getViewport({ scale });
  const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const blob = await canvasBlob(c, 'image/jpeg', .8); c.width = c.height = 0; page.cleanup();
  const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
  const pg = out.addPage([vp1.width, vp1.height]);
  pg.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
  return pg;
}
function drawNumber(page, n, N, opts, font) {
  const text = opts.fmt === 'of' ? `${n} / ${N}` : String(n);
  const size = 10, m = 22, tw = font.widthOfTextAtSize(text, size);
  const b = page.getCropBox();
  const r = (((page.getRotation().angle || 0) % 360) + 360) % 360;
  const right = opts.pos === 'r';
  let x, y;
  if (r === 90) { x = b.x + b.width - m; y = right ? b.y + b.height - m - tw : b.y + b.height / 2 - tw / 2; }
  else if (r === 180) { y = b.y + b.height - m; x = right ? b.x + m + tw : b.x + b.width / 2 + tw / 2; }
  else if (r === 270) { x = b.x + m; y = right ? b.y + m + tw : b.y + b.height / 2 + tw / 2; }
  else { y = b.y + m; x = right ? b.x + b.width - m - tw : b.x + b.width / 2 - tw / 2; }
  page.drawText(text, { x, y, size, font, color: rgb(0.33, 0.33, 0.33), rotate: degrees(r) });
}

/* ---------------- compression (re-encode large images, keep text and links) ---------------- */
const nameStr = v => v instanceof PDFName ? v.toString() : '';
const numVal = v => v instanceof PDFNumber ? v.asNumber() : (v && typeof v.asNumber === 'function' ? v.asNumber() : NaN);
async function compressBytes(bytes, lv, ui) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const all = ctx.enumerateIndirectObjects();
  const images = all.filter(([, o]) => o instanceof PDFRawStream && nameStr(ctx.lookup(o.dict.get(PDFName.of('Subtype')))) === '/Image');
  const masks = new Set();
  for (const [, o] of images) for (const k of ['SMask', 'Mask']) { const v = o.dict.get(PDFName.of(k)); if (v && v.objectNumber !== undefined) masks.add(v.toString()); }
  let i = 0;
  for (const [ref, o] of images) {
    ui.check(); ui.progress(i++, images.length, t('progImg', { i, n: images.length }));
    if (masks.has(ref.toString())) continue;
    try { const r = await shrinkImage(ctx, o, lv); if (r) ctx.assign(ref, r); } catch (e) { console.warn('image skipped', e); }
    if (i % 2 === 0) await tick();
  }
  ui.progress(images.length, images.length, t('progSave'));
  await tick();
  return await doc.save({ useObjectStreams: true, objectsPerTick: 200 });
}
function csComponents(ctx, cs) {
  cs = ctx.lookup(cs); if (!cs) return 0;
  if (cs instanceof PDFName) { const n = cs.toString(); return n === '/DeviceRGB' || n === '/CalRGB' ? 3 : n === '/DeviceGray' || n === '/CalGray' ? 1 : 0; }
  if (cs instanceof PDFArray) {
    const kind = nameStr(ctx.lookup(cs.get(0)));
    if (kind === '/ICCBased') { const st = ctx.lookup(cs.get(1)); const N = st && st.dict ? numVal(ctx.lookup(st.dict.get(PDFName.of('N')))) : 0; return N === 1 || N === 3 ? N : 0; }
    if (kind === '/CalRGB') return 3; if (kind === '/CalGray') return 1;
  }
  return 0;
}
const PRE_FILTERS = new Set(['/ASCII85Decode', '/ASCIIHexDecode', '/FlateDecode', '/LZWDecode', '/RunLengthDecode']);
async function inflateBytes(u8) {
  const ds = new DecompressionStream('deflate');
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer());
}
// decode a chain of standard (non-image) filters
async function decodeChain(ctx, st, chain) {
  if (!chain.length) return st.contents;
  if (chain.length === 1 && chain[0] === '/FlateDecode') { try { return await inflateBytes(st.contents); } catch (e) {} }
  const d = ctx.obj({ Filter: chain.map(f => f.slice(1)) });
  return L.decodePDFRawStream(PDFRawStream.of(d, st.contents)).decode();
}
function unPredict(data, w, bpp) {
  const rowLen = w * bpp, rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen); let prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const f = data[r * (rowLen + 1)], so = r * (rowLen + 1) + 1, cur = out.subarray(r * rowLen, (r + 1) * rowLen);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0; let x = data[so + i];
      if (f === 1) x += a; else if (f === 2) x += b; else if (f === 3) x += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); x += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = x & 255;
    }
    prev = cur;
  }
  return out;
}
async function shrinkImage(ctx, st, lv) {
  const d = st.dict; const get = k => ctx.lookup(d.get(PDFName.of(k)));
  const W = numVal(get('Width')), H = numVal(get('Height'));
  if (!(W > 0 && H > 0) || W * H < 150000 || W * H > 4.5e7) return null;
  const im = get('ImageMask'); if (im && String(im) === 'true') return null;
  if (d.has(PDFName.of('Decode')) || get('Mask') instanceof PDFArray || d.has(PDFName.of('SMaskInData'))) return null;
  if (numVal(get('BitsPerComponent')) !== 8) return null;
  const fv = get('Filter');
  const filters = fv instanceof PDFArray ? fv.asArray().map(x => nameStr(ctx.lookup(x))) : fv ? [nameStr(fv)] : [];
  const comps = csComponents(ctx, get('ColorSpace')); if (comps !== 1 && comps !== 3) return null;
  const last = filters[filters.length - 1], pre = filters.slice(0, -1);
  if (!last || !pre.every(f => PRE_FILTERS.has(f))) return null;
  let bmp;
  if (last === '/DCTDecode') {
    const jpg = await decodeChain(ctx, st, pre);
    bmp = await createImageBitmap(new Blob([jpg], { type: 'image/jpeg' }));
    if (bmp.width !== W || bmp.height !== H) { bmp.close(); return null; }
  } else if (last === '/FlateDecode') {
    if (!lv.flate || W * H < lv.flate) return null;
    let raw = await decodeChain(ctx, st, filters);
    let parms = get('DecodeParms');
    if (parms instanceof PDFArray) parms = ctx.lookup(parms.get(parms.size() - 1));
    const pred = parms instanceof PDFDict ? (numVal(ctx.lookup(parms.get(PDFName.of('Predictor')))) || 1) : 1;
    if (pred >= 10) raw = unPredict(raw, W, comps); else if (pred !== 1) return null;
    if (raw.length < W * H * comps) return null;
    const px = new Uint8ClampedArray(W * H * 4);
    if (comps === 3) for (let i = 0, j = 0, k = 0; i < W * H; i++, j += 3, k += 4) { px[k] = raw[j]; px[k + 1] = raw[j + 1]; px[k + 2] = raw[j + 2]; px[k + 3] = 255; }
    else for (let i = 0, k = 0; i < W * H; i++, k += 4) { const v = raw[i]; px[k] = px[k + 1] = px[k + 2] = v; px[k + 3] = 255; }
    bmp = await createImageBitmap(new ImageData(px, W, H));
  } else return null;
  const s = Math.min(1, lv.max / Math.max(W, H));
  const nw = Math.max(1, Math.round(W * s)), nh = Math.max(1, Math.round(H * s));
  const c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(nw, nh) : Object.assign(document.createElement('canvas'), { width: nw, height: nh });
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, nw, nh); x.imageSmoothingQuality = 'high';
  x.drawImage(bmp, 0, 0, nw, nh); bmp.close();
  const jpg = new Uint8Array(await (await canvasBlob(c, 'image/jpeg', lv.q)).arrayBuffer());
  if (jpg.length >= st.contents.length * 0.9) return null;
  const nd = ctx.obj({ Type: 'XObject', Subtype: 'Image', Width: nw, Height: nh, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' });
  for (const k of ['SMask', 'Mask', 'Intent', 'Interpolate']) {
    const v = d.get(PDFName.of(k)); if (!v) continue;
    if (k === 'Mask' && ctx.lookup(v) instanceof PDFArray) continue;
    nd.set(PDFName.of(k), v);
  }
  return PDFRawStream.of(nd, jpg);
}

/* ---------------- rendering pages to images ---------------- */
async function renderPageImage(p, dpi, mime) {
  const s = S.sources.get(p.src);
  let c;
  if (s.kind === 'pdf') {
    const page = await s.pdf.getPage(p.index + 1);
    const rotation = ((page.rotate || 0) + p.rot) % 360;
    let scale = dpi / 72;
    const v0 = page.getViewport({ scale, rotation });
    const maxArea = 6e7, maxSide = 14000;
    let k = Math.min(1, Math.sqrt(maxArea / (v0.width * v0.height)), maxSide / Math.max(v0.width, v0.height));
    const vp = page.getViewport({ scale: scale * k, rotation });
    c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise; page.cleanup();
  } else {
    const bmp = await decodeImage(new Blob([s.bytes], { type: s.mime }));
    const q = p.rot % 180 !== 0;
    c = document.createElement('canvas'); c.width = q ? bmp.height : bmp.width; c.height = q ? bmp.width : bmp.height;
    const ctx = c.getContext('2d');
    if (mime === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
    ctx.translate(c.width / 2, c.height / 2); ctx.rotate(p.rot * Math.PI / 180); ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
    if (bmp.close) bmp.close();
  }
  const blob = await canvasBlob(c, mime, .9);
  c.width = c.height = 0;
  return blob;
}

/* ---------------- zip (store) ---------------- */
const CRC_T = (() => { const tb = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; tb[n] = c >>> 0; } return tb; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function uniqueNames(files) {
  const seen = new Map();
  return files.map(f => { let n = f.name; const k = n.toLowerCase(); if (seen.has(k)) { const c = seen.get(k) + 1; seen.set(k, c); n = n.replace(/(\.[^.]+)$/, ` (${c})$1`); } else seen.set(k, 1); return { ...f, name: n }; });
}
function makeZip(files) {
  const enc = new TextEncoder(); const parts = [], central = []; let off = 0;
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
    central.push(ch.buffer, name);
    off += 30 + name.length + size;
  }
  const cdSize = central.reduce((a, b) => a + b.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

/* ---------------- preview ---------------- */
const pv = $('#pv'); let pvIdx = 0, pvUrl = null, pvToken = 0;
async function openPreview(i) { if (i < 0 || !S.pages[i]) return; pvIdx = i; if (!pv.open) pv.showModal(); await showPv(); }
async function showPv() {
  const my = ++pvToken; const p = S.pages[pvIdx]; const s = S.sources.get(p.src);
  $('#pvInfo').textContent = `${NF.format(pvIdx + 1)} / ${NF.format(S.pages.length)} · ${s.name}`;
  $('#pvPrev').disabled = pvIdx === 0; $('#pvNext').disabled = pvIdx === S.pages.length - 1;
  const th = thumbs.get(keyOf(p)); const img = $('#pvImg');
  if (th) { img.src = th.url; img.style.transform = p.rot ? `rotate(${p.rot}deg)` : ''; }
  const stage = img.parentElement.getBoundingClientRect();
  const dpr = Math.min(2, devicePixelRatio || 1);
  let blob;
  if (s.kind === 'pdf') {
    const page = await s.pdf.getPage(p.index + 1); const rotation = ((page.rotate || 0) + p.rot) % 360;
    const v1 = page.getViewport({ scale: 1, rotation });
    const k = Math.min(stage.width / v1.width, stage.height / v1.height) * dpr;
    const vp = page.getViewport({ scale: k, rotation });
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    blob = await canvasBlob(c, 'image/jpeg', .9);
  } else blob = await renderPageImage(p, 0, 'image/jpeg');
  if (my !== pvToken) return;
  if (pvUrl) URL.revokeObjectURL(pvUrl);
  pvUrl = URL.createObjectURL(blob); img.src = pvUrl; img.style.transform = '';
}
$('#pvPrev').onclick = () => { if (pvIdx > 0) { pvIdx--; showPv(); } };
$('#pvNext').onclick = () => { if (pvIdx < S.pages.length - 1) { pvIdx++; showPv(); } };
$('#pvClose').onclick = () => pv.close();
pv.addEventListener('keydown', e => { if (e.key === 'ArrowLeft') $('#pvPrev').click(); else if (e.key === 'ArrowRight') $('#pvNext').click(); });
pv.addEventListener('click', e => { if (e.target === pv) pv.close(); });
pv.addEventListener('close', () => { const el = S.pages[pvIdx] && cardEls.get(S.pages[pvIdx].id); if (el) focusCard(S.pages[pvIdx].id); });

/* ---------------- intake wiring ---------------- */
const fileIn = $('#fileIn');
const ACCEPT_ALL = 'application/pdf,.pdf,image/*';
function pick(intent) {
  S.intent = intent;
  fileIn.accept = intent === 'img2pdf' ? 'image/*' : ['split', 'compress', 'pdf2img', 'numbers', 'extract', 'organize'].includes(intent) ? 'application/pdf,.pdf' : ACCEPT_ALL;
  fileIn.click();
}
fileIn.onchange = () => { const files = [...fileIn.files]; const intent = S.intent; S.intent = null; fileIn.value = ''; addFiles(files, intent); };
$('#pickBtn').onclick = () => pick(null);
$('#drop').addEventListener('click', e => { if (e.target === $('#drop')) pick(null); });
for (const b of document.querySelectorAll('.tool')) b.onclick = () => pick(b.dataset.intent);
$('#brand').onclick = () => { if (!$('#work').hidden) closeWork(false); };

let dragDepth = 0;
const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('#dropOverlay').hidden = false; });
window.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropOverlay').hidden = true; });
window.addEventListener('drop', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; $('#dropOverlay').hidden = true; if (!dlg.open) addFiles(e.dataTransfer.files); });
document.addEventListener('paste', e => {
  if (dlg.open || pv.open || /^(INPUT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName)) return;
  const files = [...((e.clipboardData && e.clipboardData.files) || [])];
  if (!files.length) return;
  e.preventDefault();
  const d = new Date(), z = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}.${z(d.getMinutes())}.${z(d.getSeconds())}`;
  addFiles(files.map((f, i) => f.name && f.name !== 'image.png' ? f : new File([f], `${t('pasted')} ${stamp}${i ? '-' + i : ''}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type })));
});
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z') && !dlg.open && !pv.open && !$('#work').hidden && !/^(INPUT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName)) { e.preventDefault(); undo(); }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O') && !dlg.open) { e.preventDefault(); pick(null); }
});

/* file handling (Open with…), share target, service worker, install */
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async params => {
    if (!params.files || !params.files.length) return;
    const files = []; for (const h of params.files) { try { files.push(await h.getFile()); } catch (e) {} }
    addFiles(files);
  });
}
async function takeShared() {
  if (qs.get('share') !== '1' || !('caches' in window)) return;
  history.replaceState(null, '', location.pathname);
  try {
    const c = await caches.open('zimba-share'); const keys = await c.keys(); const files = [];
    for (const k of keys) { const r = await c.match(k); if (r) files.push(new File([await r.blob()], decodeURIComponent(r.headers.get('x-name') || 'file'), { type: r.headers.get('content-type') || '' })); await c.delete(k); }
    addFiles(files);
  } catch (e) { console.warn(e); }
}
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; if (!matchMedia('(display-mode: standalone)').matches) $('#installBtn').hidden = false; });
$('#installBtn').onclick = async () => { if (!installEvt) return; installEvt.prompt(); try { await installEvt.userChoice; } catch (e) {} installEvt = null; $('#installBtn').hidden = true; };
window.addEventListener('appinstalled', () => { $('#installBtn').hidden = true; });

/* ---------------- init ---------------- */
setupObserver();
setupLangSel();
const z = store('zimba.zoom'); if (z && +z >= 100 && +z <= 260) { $('#zoom').value = z; grid.style.setProperty('--tw', z + 'px'); }
applyI18n();
takeShared();
window.__zimba = { S, addFiles, buildPdf, compressBytes, renderPageImage, makeZip, parseRanges, openSave, openSplit, openCompress, openImages, undo, t, setLang: l => { $('#langSel').value = l; $('#langSel').onchange(); } };
