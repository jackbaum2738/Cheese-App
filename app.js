'use strict';

/* Cheese: a personal cheese journal.
   Everything lives on this device in IndexedDB. There is no server and no account. */

const APP_VERSION = '1.0';
const BACKUP_FORMAT = 1;
const MAX_EDGE = 1280;        // photos are shrunk to this many pixels on the long edge
const JPEG_QUALITY = 0.82;
const THUMB_EDGE = 240;       // small copy used in lists
const BACKUP_DUE_DAYS = 14;
const MILKS = ["Cow's", "Goat's", "Sheep's", 'Buffalo', 'Mixed', 'Other'];
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/* ---------- Small helpers ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;
const decode = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };
const icon = (id, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const pad = (n) => String(n).padStart(2, '0');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function parseISO(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function fmtDate(s, withWeekday = false) {
  if (!s) return '';
  const d = parseISO(s);
  if (isNaN(d)) return '';
  const opts = { day: 'numeric', month: 'short', year: 'numeric' };
  if (withWeekday) opts.weekday = 'short';
  return d.toLocaleDateString(undefined, opts);
}
function fmtBytes(n) {
  if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}
const fmtPrice = (p) => `£${Number(p).toFixed(2)} per 100g`;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** Object URLs for Blobs, released in one go when the screen that used them is redrawn. */
function urlBag() {
  let urls = [];
  return {
    url(blob) { const u = URL.createObjectURL(blob); urls.push(u); return u; },
    clear() { urls.forEach((u) => URL.revokeObjectURL(u)); urls = []; },
  };
}
const bags = { tried: urlBag(), wishlist: urlBag(), overlay: urlBag() };

/* ---------- State ---------- */

const state = {
  tried: [],
  wishlist: [],
  meta: {},
  tab: 'tried',
  sort: 'date',
  query: '',
  installPrompt: null,
  persisted: false,
};
let form = null;       // the form that is currently open, if any
let saving = false;

/* ---------- IndexedDB ---------- */

let dbPromise;
function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('cheese', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('tried', { keyPath: 'id' });
        db.createObjectStore('wishlist', { keyPath: 'id' });
        db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
async function getAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
/** Run writes against one or more stores in a single transaction. */
async function write(stores, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, 'readwrite');
    fn(...stores.map((n) => t.objectStore(n)));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Save cancelled'));
  });
}
async function loadAll() {
  [state.tried, state.wishlist] = await Promise.all([getAll('tried'), getAll('wishlist')]);
}
async function loadMeta() {
  const rows = await getAll('meta');
  state.meta = Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
function setMeta(key, value) {
  state.meta[key] = value;
  return write(['meta'], (m) => m.put({ key, value })).catch(() => {});
}
async function refreshLists() {
  await loadAll();
  renderTried();
  renderWishlist();
}

/* ---------- Photos ---------- */

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That photo could not be read.')); };
    img.src = url;
  });
}
function scaleToJpeg(img, maxEdge, quality) {
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;   // images or canvases
  const k = Math.min(1, maxEdge / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';           // transparent PNGs become white instead of black
  g.fillRect(0, 0, cw, ch);
  g.drawImage(img, 0, 0, cw, ch);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('That photo could not be compressed.'))), 'image/jpeg', quality));
}
async function processPhoto(file) {
  const img = await loadImage(file);
  const photo = await scaleToJpeg(img, MAX_EDGE, JPEG_QUALITY);
  const thumb = await scaleToJpeg(img, THUMB_EDGE, 0.75);
  return { photo, thumb };
}
async function makeThumb(blob) {
  return scaleToJpeg(await loadImage(blob), THUMB_EDGE, 0.75);
}

/* ---------- Shared pieces of UI ---------- */

function starsHTML(n, cls = '') {
  let s = '';
  for (let i = 1; i <= 5; i++) s += `<svg class="st${i <= n ? ' on' : ''}" aria-hidden="true"><use href="#star"/></svg>`;
  return `<span class="stars ${cls}" role="img" aria-label="${n} out of 5 stars">${s}</span>`;
}
function thumbHTML(rec, bag) {
  return rec.thumb
    ? `<img src="${bag.url(rec.thumb)}" alt="" loading="lazy" decoding="async">`
    : `<svg class="wedge-ph" aria-hidden="true"><use href="#wedge"/></svg>`;
}
function installCardHTML(dismissible) {
  if (isStandalone()) return '';
  if (dismissible && state.meta.hideInstall) return '';
  let text, btn = '';
  if (state.installPrompt) {
    text = 'Add Cheese to your home screen to use it like an app, even offline.';
    btn = '<button class="btn small primary" data-act="install">Install</button>';
  } else if (isIOS()) {
    text = `Tap ${icon('share', 'inl')} Share, then “Add to Home Screen”.`;
  } else {
    text = 'Open your browser menu and choose “Install app” or “Add to Home screen”.';
  }
  const close = dismissible ? '<button class="x" data-act="dismiss-install" aria-label="Dismiss">×</button>' : '';
  return `<div class="install"><img src="icons/icon-192.png" alt="" width="44" height="44"><div><b>Install Cheese</b>${text}</div><div class="end">${btn}${close}</div></div>`;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

/** Bottom sheet that asks a yes/no question. Resolves true when confirmed. `body` is trusted HTML. */
function confirmSheet({ title, body, confirm, danger = true }) {
  return new Promise((resolve) => {
    $('#toast').classList.remove('show');
    const root = $('#sheet-root');
    root.innerHTML = `<div class="scrim" data-sheet="cancel"></div>
      <div class="bsheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <div class="grab"></div>
        <h3 id="sheet-title">${esc(title)}</h3>
        ${body}
        <button class="btn ${danger ? 'danger' : 'primary'}" data-sheet="ok">${esc(confirm)}</button>
        <button class="btn secondary" data-sheet="cancel" id="sheet-cancel">Cancel</button>
      </div>`;
    root.hidden = false;
    const finish = (v) => { root.hidden = true; root.innerHTML = ''; root.onclick = null; state.closeSheet = null; resolve(v); };
    root.onclick = (e) => { const b = e.target.closest('[data-sheet]'); if (b) finish(b.dataset.sheet === 'ok'); };
    state.closeSheet = () => finish(false);
    $('#sheet-cancel').focus();
  });
}

/* ---------- Navigation (hash routes + history, so the phone's back gesture works) ---------- */

function go(hash, replace = false) {
  if (!replace && location.hash === hash) return;
  const d = (history.state && history.state.d) || 0;
  if (replace) history.replaceState({ d }, '', hash);
  else history.pushState({ d: d + 1 }, '', hash);
  route();
}
function back(fallback) {
  if (history.state && history.state.d > 0) history.back();
  else go(fallback, true);
}

function setTab(tab) {
  state.tab = tab;
  $('#screen-tried').hidden = tab !== 'tried';
  $('#screen-want').hidden = tab !== 'want';
  document.querySelectorAll('.nav [data-tab]').forEach((b) => {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
}

let overlayToken = 0;
async function showOverlay(build) {
  const token = ++overlayToken;
  bags.overlay.clear();
  const html = await build();
  if (token !== overlayToken) return;
  const el = $('#overlay');
  const wasHidden = el.hidden;
  el.innerHTML = html;
  el.hidden = false;
  $('#main').inert = true;
  if (wasHidden) { el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter'); }
  const sc = $('.scroll', el);
  if (sc) sc.scrollTop = 0;
}
function hideOverlay() {
  overlayToken++;
  const el = $('#overlay');
  if (el.hidden) return;
  el.hidden = true;
  el.innerHTML = '';
  bags.overlay.clear();
  form = null;
  $('#main').inert = false;
  if (updatePending) applyUpdate();
}

function route() {
  const [a, b, c] = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decode);
  const find = (list, id) => list.find((r) => r.id === id);
  let tab = state.tab;
  let overlay = null;

  if (a === 'settings') {
    overlay = settingsPage;
  } else if (a === 'want') {
    tab = 'want';
    const w = b && find(state.wishlist, b);
    if (b === 'new') overlay = () => wishForm(null);
    else if (w && c === 'edit') overlay = () => wishForm(w);
    else if (w && c === 'tried') overlay = () => triedForm(null, w);
  } else {
    tab = 'tried';
    const r = b && find(state.tried, b);
    if (a === 'tried' && b === 'new') overlay = () => triedForm(null, null);
    else if (r && c === 'edit') overlay = () => triedForm(r, null);
    else if (r && !c) overlay = () => detailPage(r);
  }
  setTab(tab);
  if (overlay) showOverlay(overlay); else hideOverlay();
}

/* ---------- Tried list ---------- */

const byDate = (a, b) => (b.date || '').localeCompare(a.date || '') || b.createdAt - a.createdAt;
const byRating = (a, b) => (b.rating || 0) - (a.rating || 0) || byDate(a, b);

function triedCard(r) {
  const milk = r.milk ? `<span class="chip">${esc(r.milk)}</span>` : '';
  const rating = r.rating ? starsHTML(r.rating) : '<span class="sub">No rating</span>';
  return `<button class="card" data-go="#/tried/${enc(r.id)}">
    <span class="thumb">${thumbHTML(r, bags.tried)}</span>
    <span class="meta"><span class="name">${esc(r.name)}</span><span class="sub">${esc(fmtDate(r.date))} ${milk}</span>${rating}</span>
  </button>`;
}

function renderTried() {
  bags.tried.clear();
  const el = $('#tried-list');
  if (!state.tried.length) {
    el.innerHTML = `<div class="empty">
        <div class="art"><svg aria-hidden="true"><use href="#wedge"/></svg></div>
        <h2>No cheeses yet. Add your first!</h2>
        <p>Snap a photo, give it a few stars and jot down how it tasted.</p>
      </div>${installCardHTML(true)}`;
    return;
  }
  const q = state.query.trim().toLowerCase();
  const items = state.tried
    .filter((r) => !q || `${r.name} ${r.notes || ''}`.toLowerCase().includes(q))
    .sort(state.sort === 'rating' ? byRating : byDate);
  if (!items.length) {
    el.innerHTML = `<div class="empty"><h2>No matches</h2><p>Nothing in Tried matches “${esc(state.query.trim())}”.</p></div>`;
    return;
  }
  el.innerHTML = `<div class="count">${plural(items.length, 'cheese', 'cheeses')}</div>${items.map(triedCard).join('')}`;
}

function setSort(sort) {
  state.sort = sort === 'rating' ? 'rating' : 'date';
  document.querySelectorAll('[data-sort]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sort === state.sort)));
  setMeta('sort', state.sort);
  renderTried();
  $('#tried-list').scrollTop = 0;
}

/* ---------- Want to try list ---------- */

function wishCard(w) {
  const link = w.video
    ? `<a class="vlink" href="${esc(w.video)}" target="_blank" rel="noopener noreferrer">${icon('play')}Watch video${icon('ext')}</a>`
    : '<span></span>';
  return `<article class="wcard">
    <button class="wmain" data-go="#/want/${enc(w.id)}/edit">
      <span class="thumb">${thumbHTML(w, bags.wishlist)}</span>
      <span><span class="name">${esc(w.name)}</span>${w.notes ? `<p>${esc(w.notes)}</p>` : ''}</span>
    </button>
    <div class="acts">${link}<button class="triedbtn" data-go="#/want/${enc(w.id)}/tried">${icon('check')}Tried it!</button></div>
  </article>`;
}

function renderWishlist() {
  bags.wishlist.clear();
  const el = $('#want-list');
  if (!state.wishlist.length) {
    el.innerHTML = `<div class="empty">
        <div class="art"><svg aria-hidden="true"><use href="#wedge"/></svg></div>
        <h2>Nothing on your list yet</h2>
        <p>Add a cheese you’ve heard about, so you remember to try it.</p>
      </div>`;
    return;
  }
  const items = [...state.wishlist].sort((a, b) => b.createdAt - a.createdAt);
  el.innerHTML = `<div class="count">${plural(items.length, 'cheese', 'cheeses')}</div>${items.map(wishCard).join('')}`;
}

/* ---------- Cheese page ---------- */

function detailPage(r) {
  const hero = r.photo
    ? `<img src="${bags.overlay.url(r.photo)}" alt="Photo of ${esc(r.name)}">`
    : '<svg class="wedge-ph" aria-hidden="true"><use href="#wedge"/></svg>';
  const rows = [['Tried', fmtDate(r.date, true)]];
  if (r.milk) rows.push(['Milk', r.milk]);
  if (r.shop) rows.push(['Bought at', r.shop]);
  if (r.price != null) rows.push(['Price', fmtPrice(r.price)]);
  return `<div class="detail" style="display:contents">
    <div class="scroll">
      <div class="hero${r.photo ? ' has-photo' : ''}">${hero}
        <button class="iconbtn l" data-act="back" data-fallback="#/tried" aria-label="Back">${icon('back')}</button>
        <button class="iconbtn r" data-go="#/tried/${enc(r.id)}/edit" aria-label="Edit">${icon('edit')}</button>
      </div>
      <div class="dbody">
        <h1 class="dname">${esc(r.name)}</h1>
        ${r.rating ? starsHTML(r.rating, 'lg') : ''}
        <dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
        ${r.notes ? `<div class="section-h">Tasting notes</div><p class="notes">${esc(r.notes)}</p>` : ''}
        <button class="btn outline-danger" data-act="delete-tried" data-id="${esc(r.id)}">${icon('trash')}Delete cheese</button>
      </div>
    </div></div>`;
}

async function deleteTried(id) {
  const r = state.tried.find((x) => x.id === id);
  if (!r) return;
  const ok = await confirmSheet({
    title: `Delete “${r.name}”?`,
    body: '<p>This cheese and its photo will be removed from this phone. This can’t be undone.</p>',
    confirm: 'Delete cheese',
  });
  if (!ok) return;
  try { await write(['tried'], (t) => t.delete(id)); } catch (e) { return saveFailed(e); }
  await refreshLists();
  toast('Deleted');
  back('#/tried');
}

/* ---------- Forms ---------- */

function photoAreaHTML() {
  if (form.busy) return '<div class="photo-pick" aria-busy="true">Processing photo…</div>';
  if (!form.photo) {
    return `<div class="photo-row">
      <button type="button" class="photo-pick go" data-act="take-photo">${icon('camera')}Take photo</button>
      <button type="button" class="photo-pick" data-act="choose-photo">${icon('image')}Choose photo</button>
    </div>`;
  }
  if (!form.preview) form.preview = bags.overlay.url(form.photo);
  return `<div class="photo-set">
    <div class="pic"><img src="${form.preview}" alt="Your photo"></div>
    <div class="acts">
      <button type="button" class="chipbtn" data-act="take-photo">${icon('camera')}Retake</button>
      <button type="button" class="chipbtn" data-act="choose-photo">${icon('image')}Choose</button>
      <button type="button" class="chipbtn muted" data-act="remove-photo">Remove</button>
    </div></div>`;
}
function renderPhotoArea() {
  const a = $('#photo-area');
  if (a && form) a.innerHTML = photoAreaHTML();
}
async function handlePhotoChosen(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file || !form) return;
  openCropper(file);   // you choose which square to keep before it is saved
}

/* ---------- Crop screen ----------
   Photos from the library (or the phone's camera app) open here first: drag the photo under a square
   frame and pinch to zoom, and the part inside the frame is what gets saved. */

const crop = { open: false, url: null, img: null, view: null, saving: false };

function refreshInert() {
  const overlayOpen = !$('#overlay').hidden;
  $('#main').inert = overlayOpen || cam.open || crop.open;
  $('#overlay').inert = cam.open || crop.open;
  $('#camera').inert = crop.open;
}

/** Close whichever layers are no longer wanted after the history entry changed. */
function syncLayers(st) {
  const layer = st && st.layer;
  if (layer !== 'crop' && crop.open) closeCropper();
  if (layer !== 'crop' && layer !== 'cam' && cam.open) closeCamera();
}

function openCropper(file) {
  if (crop.open) return;
  crop.open = true; crop.saving = false;
  const el = $('#cropper');
  el.innerHTML = `<div class="crop-top">
      <button type="button" class="cam-btn" data-crop="cancel" aria-label="Cancel">${icon('x')}</button>
      <span class="crop-title">Move and zoom</span><span></span>
    </div>
    <div class="crop-stage" id="crop-stage" tabindex="0" aria-label="Photo. Drag to move, pinch to zoom.">
      <img id="crop-img" alt="" draggable="false">
      <div class="crop-frame" id="crop-frame"></div>
      <p class="crop-loading" id="crop-loading">Loading photo…</p>
    </div>
    <p class="crop-note">Drag to move. Pinch to zoom. Double-tap to zoom in or out.</p>
    <div class="crop-actions">
      <button type="button" class="cam-act" data-crop="cancel">Cancel</button>
      <button type="button" class="cam-act primary" data-crop="use" id="crop-use" disabled>${icon('check')}Use photo</button>
    </div>`;
  el.hidden = false;
  refreshInert();
  const d = (history.state && history.state.d) || 0;
  history.pushState({ d: d + 1, layer: 'crop' }, '', location.href);
  crop.url = URL.createObjectURL(file);
  const img = $('#crop-img');
  crop.img = img;
  img.onload = () => { $('#crop-loading').hidden = true; startCrop(img); };
  img.onerror = () => { toast('That photo could not be read.'); dismissCropper(); };
  img.src = crop.url;
  $('#crop-stage').focus();
}

function startCrop(img) {
  const stage = $('#crop-stage');
  const v = crop.view = { nw: img.naturalWidth, nh: img.naturalHeight, s: 1, tx: 0, ty: 0, min: 1, max: 1, F: { x: 0, y: 0, side: 0 }, sw: 0, sh: 0 };
  img.style.width = v.nw + 'px'; img.style.height = v.nh + 'px';
  fitCrop();
  const apply = () => { clampCrop(); img.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.s})`; };
  crop.apply = apply;
  apply();
  $('#crop-use').disabled = false;

  const pts = new Map();
  let tap = null, lastTap = null;
  const local = (e) => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  stage.onpointerdown = (e) => {
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* synthetic or finished pointer */ }
    pts.set(e.pointerId, local(e));
    tap = pts.size === 1 ? { t: Date.now(), ...local(e), moved: 0 } : null;
    stage.classList.add('grab');
  };
  stage.onpointermove = (e) => {
    if (!pts.has(e.pointerId)) return;
    const prev = [...pts.values()];
    const cur = local(e), old = pts.get(e.pointerId);
    pts.set(e.pointerId, cur);
    if (pts.size === 1) {
      v.tx += cur.x - old.x; v.ty += cur.y - old.y;
      if (tap) tap.moved += Math.abs(cur.x - old.x) + Math.abs(cur.y - old.y);
    } else if (pts.size === 2) {
      tap = null;
      const now = [...pts.values()];
      const mid = (a) => ({ x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2 });
      const dist = (a) => Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1;
      const m0 = mid(prev), m1 = mid(now);
      zoomCrop(dist(now) / dist(prev), m0.x, m0.y);
      v.tx += m1.x - m0.x; v.ty += m1.y - m0.y;
    }
    apply();
  };
  const release = (e) => {
    if (!pts.delete(e.pointerId)) return;
    if (pts.size === 0) stage.classList.remove('grab');
    if (e.type === 'pointerup' && tap && pts.size === 0 && tap.moved < 10 && Date.now() - tap.t < 300) {
      if (lastTap && tap.t - lastTap.t < 350 && Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) < 40) {
        // double-tap: zoom in, or back out if already zoomed
        if (v.s > v.min * 1.05) { v.s = v.min; centreCrop(); } else zoomCrop(2.5, tap.x, tap.y);
        apply(); lastTap = null;
      } else lastTap = tap;
    }
    tap = null;
  };
  stage.onpointerup = release; stage.onpointercancel = release;
  stage.onwheel = (e) => { e.preventDefault(); const p = local(e); zoomCrop(Math.exp(-e.deltaY * 0.002), p.x, p.y); apply(); };
  stage.onkeydown = (e) => {   // keyboard and screen-reader friendly
    const step = 24;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) { v.tx += moves[e.key][0]; v.ty += moves[e.key][1]; }
    else if (e.key === '+' || e.key === '=') zoomCrop(1.15, v.F.x + v.F.side / 2, v.F.y + v.F.side / 2);
    else if (e.key === '-') zoomCrop(1 / 1.15, v.F.x + v.F.side / 2, v.F.y + v.F.side / 2);
    else return;
    e.preventDefault(); apply();
  };
}

/** Size the frame to the screen and show the whole short side of the photo, centred. */
function fitCrop() {
  const v = crop.view, stage = $('#crop-stage'), frame = $('#crop-frame');
  const r = stage.getBoundingClientRect();
  v.sw = r.width; v.sh = r.height;
  const side = Math.max(120, Math.floor(Math.min(r.width - 48, r.height - 24)));
  v.F = { x: Math.round((r.width - side) / 2), y: Math.round((r.height - side) / 2), side };
  frame.style.cssText = `left:${v.F.x}px;top:${v.F.y}px;width:${side}px;height:${side}px`;
  v.min = side / Math.min(v.nw, v.nh);   // the photo always covers the frame
  v.max = v.min * 6;
  v.s = v.min;
  centreCrop();
}
function centreCrop() {
  const v = crop.view;
  v.tx = v.F.x + v.F.side / 2 - (v.nw * v.s) / 2;
  v.ty = v.F.y + v.F.side / 2 - (v.nh * v.s) / 2;
}
function zoomCrop(k, px, py) {
  const v = crop.view;
  const s2 = Math.min(v.max, Math.max(v.min, v.s * k));
  const k2 = s2 / v.s;
  v.tx = px - (px - v.tx) * k2; v.ty = py - (py - v.ty) * k2; v.s = s2;
}
/** Keep the photo covering the whole frame, so there is never a gap inside it. */
function clampCrop() {
  const v = crop.view, F = v.F;
  v.tx = Math.min(F.x, Math.max(F.x + F.side - v.nw * v.s, v.tx));
  v.ty = Math.min(F.y, Math.max(F.y + F.side - v.nh * v.s, v.ty));
}

async function useCrop() {
  const v = crop.view, img = crop.img, f = form;
  if (!v || crop.saving) return;
  crop.saving = true;
  const btn = $('#crop-use');
  btn.disabled = true; btn.lastChild.textContent = 'Saving…';
  try {
    const side = v.F.side / v.s;
    const sx = Math.min(Math.max((v.F.x - v.tx) / v.s, 0), v.nw - side);
    const sy = Math.min(Math.max((v.F.y - v.ty) / v.s, 0), v.nh - side);
    const out = Math.max(1, Math.round(Math.min(side, MAX_EDGE)));
    const canvas = document.createElement('canvas');
    canvas.width = out; canvas.height = out;
    canvas.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, out, out);
    const photo = await scaleToJpeg(canvas, MAX_EDGE, JPEG_QUALITY);
    const thumb = await scaleToJpeg(canvas, THUMB_EDGE, 0.75);
    if (!crop.open) return;
    if (f && form === f) { f.photo = photo; f.thumb = thumb; f.preview = null; f.busy = false; renderPhotoArea(); }
    // Close the crop screen, and the camera underneath it if the photo came from its Library button.
    leaveLayers(1 + (cam.open ? 1 : 0));
  } catch (e) {
    console.error(e);
    toast('That photo could not be used. Please try another.');
    crop.saving = false; btn.disabled = false; btn.lastChild.textContent = 'Use photo';
  }
}

function closeCropper() {
  if (!crop.open) return;
  crop.open = false; crop.view = null; crop.img = null; crop.apply = null;
  if (crop.url) { URL.revokeObjectURL(crop.url); crop.url = null; }
  const el = $('#cropper');
  el.hidden = true; el.innerHTML = '';
  refreshInert();
}
function dismissCropper() {
  if (!crop.open) return;
  if (history.state && history.state.layer === 'crop') history.back();
  else closeCropper();
}
/** Step back through `n` layers in one go. */
function leaveLayers(n) {
  if (history.state && history.state.layer) history.go(-n);
  else { closeCropper(); closeCamera(); }
}

/* ---------- In-app camera ----------
   A full-screen camera with a square frame, so what you frame is exactly what is saved. */

const cam = { open: false, stream: null, facing: 'environment', torch: false, shot: null, mode: 'live' };

function cameraHTML() {
  return `<video id="cam-video" class="cam-video" playsinline muted autoplay></video>
    <div class="cam-frame" id="cam-frame"></div>
    <div class="cam-flash" id="cam-flash"></div>
    <div class="cam-top">
      <button type="button" class="cam-btn" data-cam="close" aria-label="Close camera">${icon('x')}</button>
      <button type="button" class="cam-btn" data-cam="torch" id="cam-torch" aria-label="Flash" aria-pressed="false" hidden>${icon('bolt')}</button>
    </div>
    <p class="cam-hint" id="cam-hint">Fit the cheese inside the frame</p>
    <div class="cam-controls" id="cam-live">
      <button type="button" class="cam-lib" data-cam="library"><span>${icon('image')}</span>Library</button>
      <button type="button" class="cam-shutter" data-cam="shoot" id="cam-shutter" aria-label="Take photo"><i></i></button>
      <button type="button" class="cam-btn" data-cam="flip" id="cam-flip" aria-label="Flip camera">${icon('flip')}</button>
    </div>
    <div class="cam-review" id="cam-review" hidden>
      <img id="cam-shot" alt="The photo you just took">
      <p>Looks good?</p>
      <div class="cam-actions">
        <button type="button" class="cam-act" data-cam="retake">${icon('retake')}Retake</button>
        <button type="button" class="cam-act primary" data-cam="use" id="cam-use">${icon('check')}Use photo</button>
      </div>
    </div>
    <div class="cam-error" id="cam-error" hidden></div>`;
}

function setCamMode(mode) {
  cam.mode = mode;
  $('#cam-live').hidden = mode !== 'live';
  $('#cam-hint').hidden = mode !== 'live';
  $('#cam-review').hidden = mode !== 'review';
  $('#cam-error').hidden = mode !== 'error';
}

async function openCamera() {
  if (cam.open || !form) return;
  cam.open = true; cam.shot = null; cam.torch = false;
  const el = $('#camera');
  el.innerHTML = cameraHTML();
  el.hidden = false;
  refreshInert();
  // Own history entry, so the phone's back gesture closes the camera and not the form behind it.
  const d = (history.state && history.state.d) || 0;
  history.pushState({ d: d + 1, layer: 'cam' }, '', location.href);
  setCamMode('live');
  $('#cam-shutter').focus();
  try { await startStream(); } catch (e) { if (cam.open) showCameraError(e); }
}

function stopStream() {
  if (cam.stream) { cam.stream.getTracks().forEach((t) => t.stop()); cam.stream = null; }
  const v = $('#cam-video');
  if (v) v.srcObject = null;
}

async function startStream() {
  stopStream();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw Object.assign(new Error('Camera not supported'), { name: 'NotSupportedError' });
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: cam.facing }, width: { ideal: 2560 }, height: { ideal: 1440 } },
  });
  if (!cam.open) { stream.getTracks().forEach((t) => t.stop()); return; }   // closed while the permission prompt was up
  cam.stream = stream;
  const v = $('#cam-video');
  v.srcObject = stream;
  v.style.transform = cam.facing === 'user' ? 'scaleX(-1)' : '';   // selfie view is mirrored, the saved photo is not
  await v.play().catch(() => {});
  const track = stream.getVideoTracks()[0];
  const caps = track && track.getCapabilities ? track.getCapabilities() : {};
  cam.torch = false;
  const torch = $('#cam-torch');
  torch.hidden = !caps.torch;
  torch.setAttribute('aria-pressed', 'false');
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    $('#cam-flip').style.visibility = devices.filter((d) => d.kind === 'videoinput').length > 1 ? '' : 'hidden';
  } catch (e) { /* keep the button */ }
}

function showCameraError(e) {
  const name = e && e.name;
  let title = 'Camera is turned off';
  let body = 'Cheese isn’t allowed to use your camera. In Chrome, tap the lock icon next to the address, then Permissions, and allow Camera.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
    title = 'No camera found';
    body = 'This phone didn’t report a camera that Cheese can use.';
  } else if (name === 'NotReadableError' || name === 'AbortError') {
    title = 'Camera is busy';
    body = 'Another app may be using the camera. Close it and try again.';
  } else if (name === 'NotSupportedError' || name === 'SecurityError') {
    title = 'Camera isn’t available here';
    body = 'This browser can’t open the camera inside the app.';
  }
  $('#cam-error').innerHTML = `<div class="cam-sheet">
    <div class="grab"></div>
    <h3>${title}</h3>
    <p>${body} You can still use your phone’s camera app, or pick a photo from your library.</p>
    <button type="button" class="cam-act primary" data-cam="native">${icon('camera')}Use phone camera app</button>
    <button type="button" class="cam-act" data-cam="library">${icon('image')}Choose from library</button>
    <button type="button" class="cam-act quiet" data-cam="close">Close</button>
  </div>`;
  setCamMode('error');
}

/** Copy the part of the live picture inside the square frame onto a canvas. */
function cropToFrame(video, frame) {
  const vr = video.getBoundingClientRect(), fr = frame.getBoundingClientRect();
  const vw = video.videoWidth, vh = video.videoHeight;
  // The video fills the screen and is cut to fit (object-fit: cover); work out where the frame lands in the real picture.
  const scale = Math.max(vr.width / vw, vr.height / vh);
  const offX = vr.left + (vr.width - vw * scale) / 2;
  const offY = vr.top + (vr.height - vh * scale) / 2;
  const side = Math.min(fr.width / scale, vw, vh);
  const sx = Math.min(Math.max((fr.left - offX) / scale, 0), vw - side);
  const sy = Math.min(Math.max((fr.top - offY) / scale, 0), vh - side);
  const out = Math.max(1, Math.round(Math.min(side, MAX_EDGE)));
  const canvas = document.createElement('canvas');
  canvas.width = out; canvas.height = out;
  canvas.getContext('2d').drawImage(video, sx, sy, side, side, 0, 0, out, out);
  return canvas;
}

async function takeShot() {
  const v = $('#cam-video'), btn = $('#cam-shutter');
  if (!cam.stream || !v.videoWidth || btn.disabled) return;
  btn.disabled = true;
  try {
    const canvas = cropToFrame(v, $('#cam-frame'));
    const photo = await scaleToJpeg(canvas, MAX_EDGE, JPEG_QUALITY);
    const thumb = await scaleToJpeg(canvas, THUMB_EDGE, 0.75);
    if (!cam.open) return;
    cam.shot = { photo, thumb, url: URL.createObjectURL(photo) };
    $('#cam-shot').src = cam.shot.url;
    const flash = $('#cam-flash');
    flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go');
    setCamMode('review');
    $('#cam-use').focus();
  } catch (e) {
    console.error(e);
    toast('That photo could not be taken. Please try again.');
  } finally {
    btn.disabled = false;
  }
}

function discardShot() {
  if (cam.shot) { URL.revokeObjectURL(cam.shot.url); cam.shot = null; }
}
function closeCamera() {
  if (!cam.open) return;
  cam.open = false;
  stopStream();
  discardShot();
  const el = $('#camera');
  el.hidden = true;
  el.innerHTML = '';
  refreshInert();
}
function dismissCamera() {
  if (!cam.open) return;
  if (history.state && history.state.layer === 'cam') history.back();   // popstate closes it
  else closeCamera();
}

async function cameraAction(act) {
  if (act === 'close') return dismissCamera();
  if (act === 'shoot') return takeShot();
  if (act === 'library') return $('#photo-input').click();
  if (act === 'native') return $('#camera-input').click();
  if (act === 'retake') { discardShot(); setCamMode('live'); return; }
  if (act === 'use') {
    const f = form;
    if (f && cam.shot) { f.photo = cam.shot.photo; f.thumb = cam.shot.thumb; f.preview = null; f.busy = false; renderPhotoArea(); }
    return dismissCamera();
  }
  if (act === 'flip') {
    cam.facing = cam.facing === 'environment' ? 'user' : 'environment';
    try { await startStream(); } catch (e) { if (cam.open) showCameraError(e); }
    return;
  }
  if (act === 'torch') {
    const track = cam.stream && cam.stream.getVideoTracks()[0];
    if (!track) return;
    const want = !cam.torch;
    try { await track.applyConstraints({ advanced: [{ torch: want }] }); cam.torch = want; } catch (e) { return; }
    $('#cam-torch').setAttribute('aria-pressed', String(cam.torch));
  }
}

function sheetBar(title, cancelFallback, withSave = true) {
  return `<div class="sheetbar">
    <button type="button" class="txtbtn" data-act="back" data-fallback="${esc(cancelFallback)}">Cancel</button>
    <h2 class="t">${esc(title)}</h2>
    ${withSave ? `<button type="submit" form="${form.kind}-form" class="savebtn" id="save-btn">Save</button>` : '<span></span>'}
  </div>`;
}
function nameField(value) {
  return `<div class="field"><label for="f-name">Name <span class="req">*</span></label>
    <input class="ctl" id="f-name" type="text" value="${esc(value)}" placeholder="e.g. Comté 24 months" autocomplete="off" autocapitalize="words" enterkeyhint="done">
    <div class="err" id="f-name-err" hidden>Enter a name for this cheese.</div></div>`;
}
function showNameError() {
  const i = $('#f-name');
  i.setAttribute('aria-invalid', 'true');
  $('#f-name-err').hidden = false;
  i.focus();
}

/* Tried form: new, edit, or "Tried it!" (prefilled from a wishlist item) */
function triedForm(rec, fromWish) {
  const base = fromWish || rec || {};
  form = {
    kind: 'tried',
    id: rec ? rec.id : null,
    wishId: fromWish ? fromWish.id : null,
    photo: base.photo || null,
    thumb: base.thumb || null,
    preview: null,
    rating: rec ? rec.rating || 0 : 0,
    busy: false,
  };
  const title = fromWish ? 'Tried it!' : rec ? 'Edit cheese' : 'New cheese';
  const cancel = fromWish ? '#/want' : rec ? `#/tried/${enc(rec.id)}` : '#/tried';
  const r = rec || {};
  const extrasOpen = rec && (r.milk || r.shop || r.price != null);
  const milkOptions = ['<option value="">Not set</option>']
    .concat(MILKS.map((m) => `<option${r.milk === m ? ' selected' : ''}>${esc(m)}</option>`)).join('');
  return `${sheetBar(title, cancel)}
  <div class="scroll"><form id="tried-form" class="form" novalidate autocomplete="off">
    ${fromWish ? `<div class="banner">${icon('check')}Moves to Tried when you save</div>` : ''}
    <div id="photo-area">${photoAreaHTML()}</div>
    ${nameField(base.name || '')}
    <div class="field"><label for="f-date">Date tried</label>
      <input class="ctl" id="f-date" type="date" value="${esc(r.date || todayISO())}"></div>
    <div class="field"><span class="lbl" id="rating-lbl">Rating</span>
      <div class="rating" id="rating" role="group" aria-labelledby="rating-lbl">${ratingButtons(form.rating)}</div>
      <span class="hint">Tap the same star again to clear the rating.</span></div>
    <div class="field"><label for="f-notes">Tasting notes</label>
      <textarea class="ctl" id="f-notes" placeholder="How did it taste? Texture, smell, what you ate it with…">${esc(rec ? r.notes : base.notes || '')}</textarea></div>
    <details class="more"${extrasOpen ? ' open' : ''}><summary>More details${icon('down')}</summary>
      <div class="form">
        <div class="field"><label for="f-milk">Milk</label>
          <div class="select"><select class="ctl" id="f-milk">${milkOptions}</select>${icon('down')}</div></div>
        <div class="row2">
          <div class="field"><label for="f-shop">Bought at</label>
            <input class="ctl" id="f-shop" type="text" value="${esc(r.shop || '')}" placeholder="Shop" autocomplete="off"></div>
          <div class="field"><label for="f-price">Price</label>
            <div class="affix-wrap"><span>£</span><input id="f-price" type="number" inputmode="decimal" step="0.01" min="0" value="${r.price != null ? esc(r.price) : ''}" placeholder="0.00"></div>
            <span class="hint">per 100g</span></div>
        </div>
      </div></details>
  </form></div>`;
}

function ratingButtons(v) {
  return [1, 2, 3, 4, 5].map((n) =>
    `<button type="button" class="star-btn${n <= v ? ' on' : ''}" data-act="rate" data-v="${n}" aria-label="${n} star${n > 1 ? 's' : ''}" aria-pressed="${n === v}"><svg aria-hidden="true"><use href="#star"/></svg></button>`
  ).join('');
}

async function saveTried() {
  const f = form;
  if (!f || f.kind !== 'tried' || saving) return;
  const name = $('#f-name').value.trim();
  if (!name) return showNameError();
  const priceRaw = parseFloat($('#f-price').value);
  const existing = f.id ? state.tried.find((x) => x.id === f.id) : null;
  const rec = {
    ...(existing || {}),
    id: f.id || uid(),
    createdAt: existing ? existing.createdAt : Date.now(),
    updatedAt: Date.now(),
    name,
    date: $('#f-date').value || todayISO(),
    rating: f.rating || null,
    notes: $('#f-notes').value.trim(),
    milk: $('#f-milk').value,
    shop: $('#f-shop').value.trim(),
    price: isFinite(priceRaw) && priceRaw >= 0 ? Math.round(priceRaw * 100) / 100 : null,
    photo: f.photo,
    thumb: f.thumb,
  };
  saving = true; $('#save-btn').disabled = true;
  try {
    await write(['tried', 'wishlist'], (t, w) => { t.put(rec); if (f.wishId) w.delete(f.wishId); });
  } catch (e) {
    saving = false; $('#save-btn').disabled = false;
    return saveFailed(e);
  }
  saving = false;
  await refreshLists();
  toast(f.wishId ? 'Moved to Tried' : 'Saved');
  if (f.wishId) go('#/tried', true);
  else back(f.id ? `#/tried/${enc(f.id)}` : '#/tried');
}

/* Wishlist form */
function wishForm(rec) {
  form = { kind: 'wish', id: rec ? rec.id : null, photo: rec ? rec.photo : null, thumb: rec ? rec.thumb : null, preview: null, busy: false };
  const r = rec || {};
  return `${sheetBar(rec ? 'Edit cheese' : 'New cheese', '#/want')}
  <div class="scroll"><form id="wish-form" class="form" novalidate autocomplete="off">
    <div id="photo-area">${photoAreaHTML()}</div>
    ${nameField(r.name || '')}
    <div class="field"><label for="f-notes">Notes</label>
      <textarea class="ctl" id="f-notes" placeholder="Where did you see it? Why do you want to try it?">${esc(r.notes || '')}</textarea></div>
    <div class="field"><label for="f-video">Video link</label>
      <input class="ctl" id="f-video" type="url" inputmode="url" autocapitalize="off" value="${esc(r.video || '')}" placeholder="https://…" autocomplete="off">
      <div class="err" id="f-video-err" hidden>Enter a web link, like https://example.com/video</div></div>
    ${rec ? `<button type="button" class="btn outline-danger" data-act="delete-wish" data-id="${esc(rec.id)}">${icon('trash')}Delete cheese</button>` : ''}
  </form></div>`;
}

/** Returns '' for empty, null for invalid, otherwise a clean http(s) URL. */
function normalizeUrl(v) {
  v = v.trim();
  if (!v) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = 'https://' + v;
  try {
    const u = new URL(v);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch (e) { return null; }
}

async function saveWish() {
  const f = form;
  if (!f || f.kind !== 'wish' || saving) return;
  const name = $('#f-name').value.trim();
  if (!name) return showNameError();
  const video = normalizeUrl($('#f-video').value);
  if (video === null) {
    $('#f-video').setAttribute('aria-invalid', 'true');
    $('#f-video-err').hidden = false;
    $('#f-video').focus();
    return;
  }
  const existing = f.id ? state.wishlist.find((x) => x.id === f.id) : null;
  const rec = {
    ...(existing || {}),
    id: f.id || uid(),
    createdAt: existing ? existing.createdAt : Date.now(),
    updatedAt: Date.now(),
    name,
    notes: $('#f-notes').value.trim(),
    video,
    photo: f.photo,
    thumb: f.thumb,
  };
  saving = true; $('#save-btn').disabled = true;
  try { await write(['wishlist'], (w) => w.put(rec)); }
  catch (e) { saving = false; $('#save-btn').disabled = false; return saveFailed(e); }
  saving = false;
  await refreshLists();
  toast('Saved');
  back('#/want');
}

async function deleteWish(id) {
  const w = state.wishlist.find((x) => x.id === id);
  if (!w) return;
  const ok = await confirmSheet({
    title: `Delete “${w.name}”?`,
    body: '<p>This cheese will be removed from your Want to try list. This can’t be undone.</p>',
    confirm: 'Delete cheese',
  });
  if (!ok) return;
  try { await write(['wishlist'], (s) => s.delete(id)); } catch (e) { return saveFailed(e); }
  await refreshLists();
  toast('Deleted');
  back('#/want');
}

function saveFailed(e) {
  console.error(e);
  toast(e && e.name === 'QuotaExceededError' ? 'Not enough storage space on this phone.' : 'Could not save. Please try again.');
}

/* ---------- Settings, export and import ---------- */

async function settingsPage() {
  let persisted = false;
  try { persisted = !!(navigator.storage && navigator.storage.persisted && await navigator.storage.persisted()); } catch (e) { /* ignore */ }
  state.persisted = persisted;

  const all = [...state.tried, ...state.wishlist];
  const photos = all.filter((r) => r.photo);
  const bytes = photos.reduce((n, r) => n + r.photo.size + (r.thumb ? r.thumb.size : 0), 0);
  const last = state.meta.lastExport;
  const days = last ? Math.floor((Date.now() - last) / 86400000) : null;
  const due = (!last && all.length > 0) || (days !== null && days >= BACKUP_DUE_DAYS);
  const headline = !last ? 'No backup yet'
    : days === 0 ? 'Last backup was today'
    : days === 1 ? 'Last backup was yesterday'
    : `Last backup was ${days} days ago`;

  return `<div class="sheetbar">
      <button type="button" class="txtbtn" data-act="back" data-fallback="#/tried">${icon('back')}Back</button>
      <h2 class="t">Settings</h2><span></span>
    </div>
    <div class="scroll"><div class="form">
      <div class="remind${due ? ' due' : ''}">${icon('bell')}
        <div><b>${headline}</b>Your cheeses and photos are only stored on this phone. Export a backup now and then, and save it to Files, iCloud Drive or Google Drive.</div></div>
      <button class="btn primary" data-act="export">${icon('download')}Export backup</button>
      <button class="btn secondary" data-act="import">${icon('upload')}Import backup</button>
      <input id="import-input" type="file" accept="application/json,.json,text/plain,.txt" hidden>
      <div class="hint center">Importing replaces everything currently in the app.</div>
      <div class="section-h">On this phone</div>
      <div class="list">
        <div><span>Storage protection</span><span class="${persisted ? 'ok' : ''}">${persisted ? 'On' : 'Not guaranteed'}</span></div>
        <div><span>Tried</span><span>${plural(state.tried.length, 'cheese', 'cheeses')}</span></div>
        <div><span>Want to try</span><span>${plural(state.wishlist.length, 'cheese', 'cheeses')}</span></div>
        <div><span>Photos</span><span>${photos.length ? `${photos.length} · ${fmtBytes(bytes)}` : 'None'}</span></div>
        <div><span>Last backup</span><span>${last ? esc(fmtDate(todayISOFrom(last))) : 'Never'}</span></div>
      </div>
      ${persisted ? '' : '<div class="hint">Your browser hasn’t promised to keep this data. Adding Cheese to your home screen helps, and so do regular backups.</div>'}
      ${installCardHTML(false)}
      <div class="foot">Cheese ${APP_VERSION} · Works offline</div>
    </div></div>`;
}
function todayISOFrom(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = r.result; resolve(s.slice(s.indexOf(',') + 1)); };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
async function base64ToBlob(data, type) {
  return (await fetch(`data:${type};base64,${data}`)).blob();
}

async function buildBackup() {
  const pack = async (list) => {
    const out = [];
    for (const rec of list) {
      const { photo, thumb, ...rest } = rec;   // thumbnails are rebuilt on import
      out.push({ ...rest, photo: photo ? { type: photo.type || 'image/jpeg', data: await blobToBase64(photo) } : null });
    }
    return out;
  };
  return {
    app: 'cheese',
    version: BACKUP_FORMAT,
    exportedAt: new Date().toISOString(),
    tried: await pack(state.tried),
    wishlist: await pack(state.wishlist),
  };
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** A copy of the backup that phones allow sharing, or null if sharing files isn't possible here.
    Android Chrome refuses .json files, so the shared copy is a plain text file with the same contents. */
function shareableFile(file) {
  if (!navigator.share || !navigator.canShare) return null;
  const copy = new File([file], file.name.replace(/\.json$/, '.txt'), { type: 'text/plain' });
  try { return navigator.canShare({ files: [copy] }) ? copy : null; } catch (e) { return null; }
}

async function markBackedUp(message) {
  await setMeta('lastExport', Date.now());
  toast(message);
  if (location.hash === '#/settings') showOverlay(settingsPage);
}

/** "Backup ready" sheet. Sharing has to start straight from a tap, so the file is built before this opens. */
function backupSheet(file) {
  const root = $('#sheet-root');
  const shareable = shareableFile(file);
  root.innerHTML = `<div class="scrim" data-sheet="close"></div>
    <div class="bsheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <div class="grab"></div>
      <h3 id="sheet-title">Backup ready</h3>
      <p><b>${esc(file.name)}</b><br>${esc(fmtBytes(file.size))}</p>
      ${shareable
        ? '<p>Tap Share or save, then choose <b>Save to Files</b>, Google Drive or another safe place. It is shared as a text file, and importing accepts it.</p><button class="btn primary" data-sheet="share">Share or save…</button>'
        : '<p>This browser can’t open the share menu, so download the file instead.</p>'}
      <button class="btn ${shareable ? 'secondary' : 'primary'}" data-sheet="download">Download file</button>
      <button class="btn link" data-sheet="close" id="sheet-cancel">Close</button>
    </div>`;
  root.hidden = false;
  const close = () => {
    root.hidden = true; root.innerHTML = ''; root.onclick = null; state.closeSheet = null;
    saving = false;
    if (updatePending) applyUpdate();
  };
  state.closeSheet = close;
  root.onclick = (e) => {
    const b = e.target.closest('[data-sheet]');
    if (!b) return;
    if (b.dataset.sheet === 'share') {
      // Called straight from the tap, with no waiting first, or phones refuse to open the menu.
      navigator.share({ files: [shareable], title: 'Cheese backup' })
        .then(() => { close(); markBackedUp('Backup saved'); })
        .catch((err) => {
          if (err && err.name === 'AbortError') return;   // you closed the menu without saving
          toast(`The share menu would not open (${(err && err.name) || 'error'}). Use Download file.`);
        });
    } else if (b.dataset.sheet === 'download') {
      downloadFile(file);
      close();
      markBackedUp('Backup downloaded');
    } else {
      close();
    }
  };
  $('#sheet-cancel').focus();
}

async function exportBackup() {
  saving = true;   // blocks a pending update-reload until the backup is done
  const btns = document.querySelectorAll('[data-act="export"]');
  btns.forEach((b) => (b.disabled = true));
  let sheetOpen = false;
  try {
    toast('Preparing backup…');
    const json = JSON.stringify(await buildBackup());
    const file = new File([json], `cheese-backup-${todayISO()}.json`, { type: 'application/json' });
    $('#toast').classList.remove('show');
    backupSheet(file);
    sheetOpen = true;   // the sheet releases the update block when it closes
  } catch (e) {
    console.error(e);
    toast('Could not create the backup.');
  } finally {
    btns.forEach((b) => (b.disabled = false));
    if (!sheetOpen) {
      saving = false;
      if (updatePending) applyUpdate();
    }
  }
}

/* Turn an untrusted backup file into clean records. Photos become Blobs again and thumbnails are rebuilt. */
const cleanStr = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
async function restorePhoto(p) {
  if (!p || typeof p.data !== 'string') return { photo: null, thumb: null };
  try {
    const photo = await base64ToBlob(p.data, IMAGE_TYPES.includes(p.type) ? p.type : 'image/jpeg');
    return { photo, thumb: await makeThumb(photo) };
  } catch (e) { return { photo: null, thumb: null }; }
}
async function cleanBackup(data) {
  const created = (v) => (Number.isFinite(v) ? v : Date.now());
  const tried = [];
  for (const r of data.tried) {
    if (!r || typeof r !== 'object') continue;
    const rating = Math.round(Number(r.rating));
    const price = r.price === null || r.price === '' ? NaN : Number(r.price);
    tried.push({
      id: uid(),
      createdAt: created(r.createdAt),
      name: cleanStr(r.name, 200).trim() || 'Untitled cheese',
      date: /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : todayISO(),
      rating: rating >= 1 && rating <= 5 ? rating : null,
      notes: cleanStr(r.notes, 20000),
      milk: MILKS.includes(r.milk) ? r.milk : '',
      shop: cleanStr(r.shop, 200),
      price: isFinite(price) && price >= 0 ? price : null,
      ...(await restorePhoto(r.photo)),
    });
  }
  const wishlist = [];
  for (const r of data.wishlist) {
    if (!r || typeof r !== 'object') continue;
    wishlist.push({
      id: uid(),
      createdAt: created(r.createdAt),
      name: cleanStr(r.name, 200).trim() || 'Untitled cheese',
      notes: cleanStr(r.notes, 20000),
      video: normalizeUrl(cleanStr(r.video, 2000)) || '',
      ...(await restorePhoto(r.photo)),
    });
  }
  return { tried, wishlist };
}

async function importBackup(file) {
  saving = true;   // blocks a pending update-reload until the restore has finished
  try { await importBackupFile(file); }
  finally { saving = false; if (updatePending) applyUpdate(); }
}
async function importBackupFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); }
  catch (e) { return toast('That file isn’t a Cheese backup.'); }
  if (!data || data.app !== 'cheese' || !Array.isArray(data.tried) || !Array.isArray(data.wishlist)) {
    return toast('That file isn’t a Cheese backup.');
  }
  if (data.version > BACKUP_FORMAT) return toast('That backup is from a newer version of Cheese.');

  const photoCount = [...data.tried, ...data.wishlist].filter((r) => r && r.photo).length;
  const ok = await confirmSheet({
    title: 'Replace everything?',
    body: `<p>This backup (${esc(file.name)}) has <b>${plural(data.tried.length, 'tried cheese', 'tried cheeses')}</b> and <b>${plural(data.wishlist.length, 'want to try', 'want to try')}</b>, with ${plural(photoCount, 'photo', 'photos')}.</p>
           <p>Your current ${plural(state.tried.length, 'tried cheese', 'tried cheeses')} and ${state.wishlist.length} want to try will be deleted. This can’t be undone.</p>`,
    confirm: 'Replace everything',
  });
  if (!ok) return;

  toast('Restoring…');
  try {
    const clean = await cleanBackup(data);   // all slow work happens before the write
    await write(['tried', 'wishlist'], (t, w) => {
      t.clear(); w.clear();
      clean.tried.forEach((r) => t.put(r));
      clean.wishlist.forEach((r) => w.put(r));
    });
  } catch (e) { return saveFailed(e); }
  await refreshLists();
  toast('Backup restored');
  if (location.hash === '#/settings') showOverlay(settingsPage);
}

/* ---------- Events ---------- */

const actions = {
  back: (el) => back(el.dataset.fallback || '#/tried'),
  'take-photo': () => openCamera(),
  'choose-photo': () => $('#photo-input').click(),
  'remove-photo': () => { if (form) { form.photo = null; form.thumb = null; form.preview = null; renderPhotoArea(); } },
  rate: (el) => {
    if (!form) return;
    const v = Number(el.dataset.v);
    form.rating = form.rating === v ? 0 : v;
    $('#rating').innerHTML = ratingButtons(form.rating);
  },
  'delete-tried': (el) => deleteTried(el.dataset.id),
  'delete-wish': (el) => deleteWish(el.dataset.id),
  export: () => exportBackup(),
  import: () => $('#import-input').click(),
  install: async () => {
    const p = state.installPrompt;
    if (!p) return;
    p.prompt();
    await p.userChoice.catch(() => {});
    state.installPrompt = null;
    renderTried();
  },
  'dismiss-install': () => { setMeta('hideInstall', true); renderTried(); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-go],[data-act],[data-tab],[data-sort],[data-cam],[data-crop]');
  if (!el) return;
  if (el.dataset.cam) return cameraAction(el.dataset.cam);
  if (el.dataset.crop) return el.dataset.crop === 'use' ? useCrop() : dismissCropper();
  if (el.dataset.go) return go(el.dataset.go);
  if (el.dataset.tab) return go(`#/${el.dataset.tab}`, true);
  if (el.dataset.sort) return setSort(el.dataset.sort);
  const fn = actions[el.dataset.act];
  if (fn) fn(el);
});

document.addEventListener('submit', (e) => {
  e.preventDefault();
  if (e.target.id === 'tried-form') saveTried();
  else if (e.target.id === 'wish-form') saveWish();
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'search') { state.query = e.target.value; renderTried(); }
  else if (e.target.id === 'f-name') { e.target.removeAttribute('aria-invalid'); const m = $('#f-name-err'); if (m) m.hidden = true; }
  else if (e.target.id === 'f-video') { e.target.removeAttribute('aria-invalid'); const m = $('#f-video-err'); if (m) m.hidden = true; }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'photo-input' || e.target.id === 'camera-input') handlePhotoChosen(e.target);
  else if (e.target.id === 'import-input') {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) importBackup(file);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (crop.open) dismissCropper();
  else if (cam.open) dismissCamera();
  else if (state.closeSheet) state.closeSheet();
  else if (!$('#overlay').hidden) back('#/tried');
});

window.addEventListener('popstate', () => {
  if (crop.open || cam.open) syncLayers(history.state);   // closing a layer must not rebuild the form behind it
  else route();
});
// Android stops the camera when you switch apps; start it again when you come back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && cam.open && cam.mode === 'live' && (!cam.stream || cam.stream.getTracks().some((t) => t.readyState === 'ended'))) {
    startStream().catch((e) => { if (cam.open) showCameraError(e); });
  }
});
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.installPrompt = e;
  renderTried();
});
window.addEventListener('appinstalled', () => { state.installPrompt = null; renderTried(); });

/* ---------- Updates ---------- */

// When a new version of the app has been installed, reload into it. If you are in the middle of
// editing or restoring a backup, wait until that is finished so nothing is lost.
let updatePending = false;
function applyUpdate() {
  if (form || saving) { updatePending = true; return; }
  try { sessionStorage.setItem('cheese-updated', '1'); } catch (e) { /* ignore */ }
  location.reload();
}

/* ---------- Start ---------- */

function showFatal(message) {
  $('#main').innerHTML = `<div class="empty"><h2>Cheese can’t save data here</h2><p>${esc(message)}</p></div>`;
}

async function boot() {
  // The photo pickers live outside the pages so they survive redraws.
  // One opens the camera directly, the other the photo library or files.
  for (const [id, capture] of [['photo-input', false], ['camera-input', true]]) {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*'; input.id = id; input.hidden = true;
    if (capture) input.setAttribute('capture', 'environment');
    document.body.appendChild(input);
  }

  try {
    await loadMeta();
    await loadAll();
  } catch (e) {
    console.error(e);
    return showFatal('Your browser is blocking on-device storage. Try again outside private browsing.');
  }
  state.sort = state.meta.sort === 'rating' ? 'rating' : 'date';
  document.querySelectorAll('[data-sort]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sort === state.sort)));

  if (!history.state) history.replaceState({ d: 0 }, '', location.hash || '#/tried');
  renderTried();
  renderWishlist();
  route();

  // Ask the browser to keep our data even when the phone is short on space.
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persisted()
      .then((already) => already || navigator.storage.persist())
      .then((granted) => { state.persisted = !!granted; })
      .catch(() => {});
  }
  if ('serviceWorker' in navigator) {
    // On the very first visit the worker also takes control; only reload for real updates.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) applyUpdate(); });
    navigator.serviceWorker.register('sw.js').then((reg) => {
      // Look for a new version each time the app comes back to the foreground.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch((e) => console.warn('Offline mode unavailable', e));
  }
  try {
    if (sessionStorage.getItem('cheese-updated')) { sessionStorage.removeItem('cheese-updated'); toast('Updated to the latest version'); }
  } catch (e) { /* ignore */ }
}
boot();
