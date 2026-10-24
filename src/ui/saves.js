// Saving and loading worlds: IndexedDB slots (metadata and gzip data kept in separate
// stores so listing stays light), quick save, an optional autosave every century, and
// export / import as a file. Storage and downloads can be blocked in private windows and
// embedded hosts; every path fails with a plain message and importing a file always works.
// Every slot carries a small map thumbnail. Branch slots (the Chronoscope's "keep as a
// branch") record which world they split from (branchOf) and the day history was rewound to
// (branchDay), and are listed under their world. A resume pair of slots (auto-a / auto-b) is
// written soon after a world begins or opens, soon after a leap, an undo, a rewind or an act,
// then every few minutes of play (deferred while time runs at Max) and when the page is
// hidden, so a returning viewer is offered "Continue" on the Genesis screen. A small marker in
// localStorage (written at once) tells that card when the slot is older than the world left.

import { serializeWorld, compressJSON, decompressJSON } from '../core/serialize.js';
import * as SER from '../core/serialize.js';
import { yearOf } from '../core/world.js';
import { SPEEDS, MAP_SIZES } from '../core/constants.js';
import { liveCivs, liveSettlements } from '../core/entities.js';
import { h, clear, svgEl } from './dom.js';
import { glyph } from './icons.js';
import { openModal, confirmDialog, promptDialog } from './widgets.js';
import { statusToast } from './toasts.js';
import { people, int, monthYear } from './format.js';
import { getPref } from './prefs.js';

const DB_NAME = 'atlas-of-ages';
const DB_VERSION = 1;
let dbPromise = null;
let lastAutosaveYear = null;
let busy = false;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB) throw new Error('This browser offers no IndexedDB storage here.');
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) { reject(e); return; }
    const timer = setTimeout(() => reject(new Error('Browser storage did not respond.')), 5000);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('data')) db.createObjectStore('data', { keyPath: 'id' });
    };
    req.onsuccess = () => { clearTimeout(timer); resolve(req.result); };
    req.onerror = () => { clearTimeout(timer); reject(req.error || new Error('Browser storage refused to open.')); };
    req.onblocked = () => { clearTimeout(timer); reject(new Error('Browser storage is blocked by another open tab.')); };
  }).catch((e) => { dbPromise = null; throw e; });
  return dbPromise;
}

function tx(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    let t;
    try { t = db.transaction(stores, mode); } catch (e) { reject(e); return; }
    let out;
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error || new Error('Storage transaction failed.'));
    t.onabort = () => reject(t.error || new Error('Storage transaction was aborted (the disk may be full).'));
    try { out = fn(t); } catch (e) { try { t.abort(); } catch (e2) { /* already finished */ } reject(e); }
  });
}
const reqP = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

export async function listSlots() {
  const db = await openDB();
  let rows = [];
  await tx(db, ['meta'], 'readonly', (t) => { reqP(t.objectStore('meta').getAll()).then((r) => { rows = r || []; }); });
  return rows.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

async function packWorld(world) {
  // one pass where the kernel offers it: the save text straight from the world, then gzip
  // (no deep copy of the world, no second stringify: about two thirds less main-thread work)
  const bytes = typeof SER.serializeWorldText === 'function' && typeof SER.compressText === 'function'
    ? await SER.compressText(SER.serializeWorldText(world))
    : await compressJSON(serializeWorld(world));
  return { bytes, gz: bytes[0] === 0x1f && bytes[1] === 0x8b };
}

/** The identity branches are grouped by: the world they split from. */
export const worldKey = (world) => `${world.seed}|${world.name}`;

function metaFor(world, id, name, bytes, extra = {}) {
  return {
    id, name, worldName: world.name, seed: world.seed, size: world.params.worldSize,
    year: yearOf(world), day: world.time.day,
    nations: liveCivs(world).length, towns: liveSettlements(world).length,
    pop: liveSettlements(world).reduce((a, s) => a + (s.population || 0), 0),
    bytes: bytes.length, savedAt: Date.now(), format: 1, key: worldKey(world),
    ...extra,
  };
}

/** A small picture of the whole world as the minimap draws it (webp data URL, about 12 KB), or null. */
export function thumbnail(app, world = app.world) {
  try {
    if (!world || !app.renderer || typeof app.renderer.drawMinimap !== 'function' || app.world !== world) return null;
    const c = document.createElement('canvas');
    // drawn twice the size the rows show it, so the Archive's large plate stays sharp
    c.width = 320; c.height = Math.max(80, Math.round(320 * (world.H / world.W)));
    const ctx = c.getContext('2d');
    app.renderer.drawMinimap(ctx, c.width, c.height, { viewport: false });
    let url = c.toDataURL('image/webp', 0.7);
    if (!url.startsWith('data:image/webp')) url = c.toDataURL('image/jpeg', 0.7);
    return url.length < 60000 ? url : null;
  } catch (e) { return null; }
}

async function putSlot(app, world, id, name, extra = {}) {
  const { bytes } = await packWorld(world);
  const db = await openDB();
  const meta = metaFor(world, id, name, bytes, { thumb: thumbnail(app, world), ...extra });
  await tx(db, ['meta', 'data'], 'readwrite', (t) => {
    t.objectStore('data').put({ id, bytes });
    t.objectStore('meta').put(meta);
  });
  return meta;
}

export async function saveSlot(app, id, name) {
  if (!app.world) throw new Error('There is no world to save yet.');
  return putSlot(app, app.world, id, name);
}

/**
 * Keep the present as a branch before history is rewound to branchDay (the Chronoscope).
 * The slot is listed under its world in Save and load.
 */
export async function saveBranch(app, world, { branchDay, name = null } = {}) {
  if (!world) throw new Error('There is no world to keep.');
  const y0 = Math.floor((branchDay || 0) / 360), y1 = yearOf(world);
  const id = 'branch-' + Date.now().toString(36);
  return putSlot(app, world, id, name || `Years ${int(y0)}–${int(y1)}`, { branchOf: worldKey(world), branchDay: branchDay ?? null });
}

export async function loadSlot(app, id) {
  const db = await openDB();
  let rec = null;
  await tx(db, ['data'], 'readonly', (t) => { reqP(t.objectStore('data').get(id)).then((r) => { rec = r; }); });
  if (!rec || !rec.bytes) throw new Error('That save slot is empty.');
  const obj = await decompressJSON(new Uint8Array(rec.bytes));
  return app.loadWorldData(obj, 'saved world');
}

export async function deleteSlot(id) {
  const db = await openDB();
  await tx(db, ['meta', 'data'], 'readwrite', (t) => { t.objectStore('meta').delete(id); t.objectStore('data').delete(id); });
}

/** Ctrl+S: save to the quick slot. */
export async function quickSave(app) {
  if (!app.world || busy) return;
  busy = true;
  statusToast(app, 'Saving…', 'info', { icon: 'save' });
  try {
    const m = await saveSlot(app, 'quick', 'Quick save');
    statusToast(app, `Saved “${m.worldName}” at Year ${m.year} to the quick slot.`, 'ok', { icon: 'save' });
  } catch (e) {
    statusToast(app, `Could not save in this browser: ${e.message} Export the world to a file instead (Menu › Save and load).`, 'error');
  } finally { busy = false; }
}

/** Called from the main loop at ≤ 4 Hz: autosave each time a century passes. */
export function autosaveTick(app) {
  const w = app.world;
  if (!w) return;
  const y = yearOf(w);
  if (lastAutosaveYear == null || y < lastAutosaveYear) { lastAutosaveYear = y; return; }
  if (!app.autosave || busy || y - lastAutosaveYear < 100) return;
  lastAutosaveYear = y;
  busy = true;
  saveSlot(app, 'autosave', 'Autosave')
    .then((m) => statusToast(app, `Autosaved at Year ${m.year}.`, 'ok', { icon: 'save', ms: 2500 }))
    .catch((e) => { app.autosave = false; statusToast(app, `Autosave is off: this browser would not store the world (${e.message}).`, 'error'); })
    .finally(() => { busy = false; });
}

// --- resume: a rotating pair of slots written as the viewer plays ------------------------------

const RESUME_MS = 3 * 60 * 1000;
const RESUME_SOON_MS = 15 * 1000;   // after a world begins or opens, a leap, an undo, a rewind or an act
const MARKER_KEY = 'atlas.story.lastWorld';
let resumeAt = 0, resumeMark = '', resumeTurn = 0, resumeBusy = false, resumeDue = Infinity;
const resumeOn = () => getPref('story.resume', true) !== false;
const markOf = (w) => `${worldKey(w)}|${w.time.day}|${(w.interventions || []).length}`;

/** The world the viewer was last in, kept at once (localStorage is synchronous): what the resume card checks its slot against. */
function noteLastWorld(w) {
  try { localStorage.setItem(MARKER_KEY, JSON.stringify({ key: worldKey(w), name: w.name, year: yearOf(w), day: w.time.day, at: Date.now() })); } catch (e) { /* storage blocked */ }
}
function lastWorld() {
  try { const v = JSON.parse(localStorage.getItem(MARKER_KEY) || 'null'); return v && typeof v.key === 'string' ? v : null; } catch (e) { return null; }
}

/** Ask for a resume write within delay ms (sooner than the regular cadence). */
function resumeSoon(delay = RESUME_SOON_MS) { resumeDue = Math.min(resumeDue, performance.now() + delay); }

/** Write the resume slot if the world changed since the last one. force: when the page is being hidden. */
async function writeResume(app, force = false) {
  const w = app.world;
  if (!w || !resumeOn() || resumeBusy || busy || app.fastForwarding || app.chrono?.busy) return;
  const mark = markOf(w);
  if (mark === resumeMark) return;
  const nowT = performance.now();
  if (!force) {
    const due = nowT >= resumeDue;
    if (!due && nowT - resumeAt < RESUME_MS) return;
    // at Max speed the regular write would stall the run it records: it waits for a slower pace,
    // a pause or the page hiding (for up to three periods)
    if (!due && app.speed >= SPEEDS.length - 1 && nowT - resumeAt < 3 * RESUME_MS) return;
  }
  resumeAt = nowT;
  resumeDue = Infinity;
  resumeBusy = true;
  const id = resumeTurn++ % 2 ? 'auto-b' : 'auto-a';
  noteLastWorld(w);
  try {
    await putSlot(app, w, id, 'Where you left off', { resume: true });
    resumeMark = mark;
  } catch (e) { /* storage may be unavailable; resume is a convenience */ }
  finally { resumeBusy = false; }
}

export function initSaves(app) {
  app.on('world', (w) => {
    lastAutosaveYear = yearOf(w);
    resumeMark = markOf(w);
    if (app.restoring) { resumeSoon(); return; }    // an undo or rewind: the same world, another moment
    resumeAt = performance.now();
    noteLastWorld(w);
    // a world just begun or opened gets its slot soon, so leaving within minutes still finds it
    resumeMark = '';
    resumeSoon();
  });
  app.on('leapDone', () => resumeSoon(2000));
  app.on('toolApplied', () => resumeSoon());
  app.on('tick', () => { if (app.world) writeResume(app); });
  const away = () => { if (app.world && document.visibilityState === 'hidden') { noteLastWorld(app.world); writeResume(app, true); } };
  document.addEventListener('visibilitychange', away);
  window.addEventListener('pagehide', () => { if (app.world) { noteLastWorld(app.world); writeResume(app, true); } });
}

/** Keep the world for Continue now, whatever the cadence (Return to the title). */
export async function keepResume(app) {
  if (!app.world) return;
  noteLastWorld(app.world);
  await writeResume(app, true);
}

/** When the slot is older than the world the viewer last had open (a session too short to be written, or its last minutes): say so. */
function staleNote(m) {
  const last = lastWorld();
  if (!last || !(last.at > (m.savedAt || 0) + 5000)) return null;
  const text = last.key !== m.key
    ? `Your last world, ${last.name} (Year ${int(last.year)}), was not kept before you left.`
    : last.day > (m.day ?? 0) ? `You had reached Year ${int(last.year)}; the years since this was kept are lost.` : null;
  return text ? h('span.resume-stale', { text }) : null;
}

/** The newest resume slot's meta (for the Genesis screen's Continue card), or null. */
export async function latestResume() {
  try {
    const rows = await listSlots();
    return rows.find((m) => m.resume) || null;
  } catch (e) { return null; }
}

/**
 * On the Genesis screen at start-up: offer to continue the world the viewer left. Shown once,
 * over the Genesis screen, and gone as soon as a world begins.
 */
export async function offerResume(app) {
  if (!resumeOn()) return;
  const m = await latestResume();
  if (!m || app.world) return;
  const host = document.getElementById('genesis');
  if (!host || host.hidden) return;
  const go = h('button.btn.btn-brass', { type: 'button', text: 'Continue' });
  const no = h('button.icon-btn', { type: 'button', 'aria-label': 'Dismiss' }, svgEl(glyph('close', 16)));
  const thumb = m.thumb ? h('img.resume-thumb', { src: m.thumb, alt: '' }) : null;
  const card = h('aside.resume-card.instrument', { 'aria-label': 'Continue where you left off' },
    thumb,
    h('div.resume-text', null,
      h('span.resume-k', { text: 'Where you left off' }),
      h('b', { text: `${m.worldName} · Year ${int(m.year)}` }),
      h('span.muted', { text: `${m.nations} nations · ${people(m.pop)} people · ${whenText(m.savedAt)}` }),
      staleNote(m)),
    h('div.resume-actions', null, go, no));
  const close = () => card.remove();
  go.addEventListener('click', async () => {
    go.disabled = true;
    try { await loadSlot(app, m.id); } catch (e) { statusToast(app, `That world could not be reopened: ${e.message}`, 'error'); go.disabled = false; return; }
    close();
  });
  no.addEventListener('click', close);
  app.on('world', close);
  // in the page's own flow, under the Begin row (on phones the row is a dock: the card then follows the plate)
  const row = host.querySelector('.begin-row');
  if (row) row.after(card); else host.appendChild(card);
}

// Inside a Claude Artifact the page cannot start downloads itself; the viewer's `downloads`
// capability offers the file instead (its allowlist has .json but not .gz). Elsewhere
// window.claude is absent and a plain link download is used.
let downloadsCap;
function hostDownloads() {
  if (downloadsCap === undefined) {
    downloadsCap = typeof window !== 'undefined' && window.claude && typeof window.claude.use === 'function'
      ? window.claude.use('downloads').catch(() => null)
      : Promise.resolve(null);
  }
  return downloadsCap;
}

/**
 * Offer a file to the viewer, wherever the page runs (contracts change request from WP6): inside a
 * Claude Artifact through the host's downloads capability, elsewhere as a plain link download.
 * data: string | Uint8Array | Blob. Resolves to true when offered, false when the viewer declined.
 */
export async function saveFile(data, filename, type = 'application/octet-stream') {
  const host = await hostDownloads();
  if (host) {
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    try { await host.save({ filename, data: blob }); return true; } catch (e) { if (e?.code === 'declined') return false; throw e; }
  }
  const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : typeof data === 'string' ? new TextEncoder().encode(data) : data;
  download(bytes, filename, type);
  return true;
}

export function download(bytes, filename, type) {
  const blob = new Blob([bytes], { type });
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 30000);
}

const fileSafe = (s) => String(s || 'world').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'world';
function sizeText(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB'; }
function whenText(ms) {
  if (!ms) return '';
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  try { return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; }
}

// ---------------------------------------------------------------------------
// The dialog

/** The Archive: every world kept in this browser, grouped by world with its branches under it, the
 * copies kept for you apart; the chosen save shown large on the right with what it holds. */
export function openSaves(app) {
  const notice = h('p.arc-notice', { hidden: true });
  const list = h('div.arc-list');
  const detail = h('div.arc-detail');
  const fileInput = h('input', { type: 'file', accept: '.json,.gz,.atlas,application/json,application/gzip', id: 'import-file', hidden: true });
  const importBtn = h('button.btn', { type: 'button' }, svgEl(glyph('importFile', 16)), 'Import a file');
  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => doImport(fileInput.files?.[0]));
  const delBtn = h('button.btn.btn-quiet', { type: 'button', text: 'Delete' });
  const overBtn = h('button.btn', { type: 'button', text: 'Overwrite' });
  const openBtn = h('button.btn.btn-brass', { type: 'button', text: 'Open' });
  delBtn.addEventListener('click', () => chosen && doDelete(chosen));
  overBtn.addEventListener('click', () => chosen && doOverwrite(chosen));
  openBtn.addEventListener('click', () => chosen && doLoad(chosen));
  let rows = [], chosen = null;

  // this world, when one is open: save it to a slot or a file
  let now = null;
  if (app.world) {
    const w = app.world;
    const exportBtn = h('button.btn', { type: 'button' }, svgEl(glyph('exportFile', 16)), 'Export to a file');
    exportBtn.addEventListener('click', () => doExport());
    const pic = thumbnail(app);
    now = h('div.arc-now', null,
      pic ? h('img.arc-thumb', { src: pic, alt: '' }) : h('span.arc-thumb.is-empty'),
      h('div.arc-text', null,
        h('span.arc-name', { text: `${w.name}, Year ${int(yearOf(w))}` }),
        h('i.arc-date', { text: 'Open now: not saved until you save it' }),
        h('span.arc-meta', { text: `${liveCivs(w).length} nations · ${people(liveSettlements(w).reduce((a, s) => a + (s.population || 0), 0))} people · ${int(liveSettlements(w).length)} towns` })),
      h('div.arc-acts', null, h('button.btn.btn-brass', { type: 'button', text: 'Save to a new slot', onclick: () => saveNew() }), exportBtn));
  }

  const modal = openModal({
    kicker: 'The archive · kept in this browser', title: app.world ? 'Save and load' : 'Load a World', cls: 'is-archive',
    lead: 'Each slot keeps a map of its world. A branch stands under the save it left.',
    body: h('div.arc', null,
      h('div.arc-left', null, now ? h('h3.arc-h', null, h('span', { text: 'This world' })) : null, now, notice, list),
      detail),
    actions: [delBtn, overBtn, h('span.arc-gap'), openBtn],
  });
  modal.box.querySelector('.modal-head').append(h('div.arc-import', null, importBtn, fileInput,
    h('span.arc-import-note', { text: 'An .atlas.json from another browser. Importing always works.' })));

  const kindOf = (m) => (m.resume ? 'Kept' : m.id === 'autosave' ? 'Autosave' : m.id === 'quick' ? 'Quick save' : m.branchOf ? 'Branch' : 'Saved');
  const titleOf = (m) => (m.resume || m.id === 'autosave' || m.id === 'quick' ? `${m.worldName}, Year ${int(m.year)}` : m.name);
  const metaLine = (m) => `${int(m.nations)} nations · ${people(m.pop)} people${m.towns != null ? ` · ${int(m.towns)} towns` : ''}`;

  function row(m, cls = '') {
    const b = h('button.arc-row', { type: 'button', class: cls, dataset: { id: m.id } },
      m.thumb ? h('img.arc-thumb', { src: m.thumb, alt: '' }) : h('span.arc-thumb.is-empty'),
      h('span.arc-text', null,
        m.branchOf ? h('span.arc-kick', { text: m.branchDay != null ? `Branch · from Year ${int(Math.floor(m.branchDay / 360))}` : 'Branch' }) : null,
        h('span.arc-name', { text: m.resume ? 'Where you left off' : m.id === 'autosave' ? 'Autosave' : titleOf(m) }),
        h('i.arc-date', { text: m.resume ? `${m.worldName} · ${monthYear(m.day)} · the resume copy` : m.id === 'autosave' ? `${m.worldName} · Year ${int(m.year)} · written each time a century passes` : monthYear(m.day) }),
        m.resume || m.id === 'autosave' ? null : h('span.arc-meta', { text: metaLine(m) })),
      h('span.arc-when', null, h('span.arc-kind', { text: kindOf(m) }), h('span', { text: whenText(m.savedAt) }), h('span', { text: sizeText(m.bytes || 0) })));
    b.addEventListener('click', () => choose(m));
    b.addEventListener('dblclick', () => doLoad(m));
    return b;
  }

  function choose(m) {
    chosen = m;
    for (const r of list.querySelectorAll('.arc-row')) r.classList.toggle('is-on', r.dataset.id === m?.id);
    clear(detail);
    delBtn.disabled = overBtn.disabled = openBtn.disabled = !m;
    if (!m) { openBtn.textContent = 'Open'; detail.append(h('p.arc-empty', { text: 'Nothing is kept in this browser yet. Save the world you have open, or import a file.' })); return; }
    overBtn.disabled = !app.world || Boolean(m.resume);
    overBtn.hidden = !app.world;
    openBtn.textContent = `Open ${m.worldName}`;
    const stat = (k, v) => h('div.pm-stat', null, h('span.k', { text: k }), h('span.v', { text: v }));
    detail.append(
      m.thumb ? h('img.arc-big', { src: m.thumb, alt: `${m.worldName}, the whole world as it was saved in Year ${int(m.year)}` }) : h('div.arc-big.is-empty'),
      h('div.arc-cap', null, h('i', { text: 'The whole world, as it was saved' }), h('span', { text: MAP_SIZES[m.size] ? `${MAP_SIZES[m.size].label} · ${MAP_SIZES[m.size].w} × ${MAP_SIZES[m.size].h}` : '' })),
      h('h3.arc-world', { text: m.worldName }),
      h('i.arc-date', { text: `${monthYear(m.day)}${m.branchOf ? ' · a branch' : ''}` }),
      h('div.rule-loz', { 'aria-hidden': 'true' }, h('span.loz')),
      h('div.pm-stats', null, stat('Pop.', people(m.pop)), stat('Nations', int(m.nations)), m.towns != null ? stat('Towns', int(m.towns)) : null, stat('Year', int(m.year))),
      h('dl.arc-facts', null,
        h('dt', { text: kindOf(m) === 'Kept' ? 'Kept' : 'Saved' }), h('dd', { text: whenText(m.savedAt) }),
        h('dt', { text: 'Size' }), h('dd', { text: sizeText(m.bytes || 0) }),
        h('dt', { text: 'Slot' }), h('dd', { text: m.resume ? 'Where you left off' : m.name })),
      staleNote(m) || '');
  }

  async function refresh() {
    clear(list);
    try { rows = await listSlots(); }
    catch (e) {
      notice.hidden = false; notice.className = 'arc-notice is-warn';
      notice.textContent = `Browser storage is not available here (${e.message}). You can still export the world to a file and import it later.`;
      rows = [];
    }
    // the copies kept for you stand apart; the rest gather under their world, branches under the save they left
    const kept = rows.filter((m) => m.resume || m.id === 'autosave');
    const own = rows.filter((m) => !kept.includes(m));
    const worlds = new Map();
    for (const m of own) { const k = m.branchOf || m.key || m.worldName; if (!worlds.has(k)) worlds.set(k, []); worlds.get(k).push(m); }
    for (const [, ms] of worlds) {
      const mains = ms.filter((m) => !m.branchOf), branches = ms.filter((m) => m.branchOf);
      const name = (mains[0] || ms[0]).worldName;
      list.append(h('h3.arc-h', null, h('span', { text: name }), h('span.arc-h-note', { text: `${ms.length === 1 ? 'one save' : `${int(ms.length)} saves`}${branches.length ? ` · ${branches.length === 1 ? 'a branch' : `${branches.length} branches`}` : ''}` })));
      for (const m of mains) list.append(row(m));
      for (const m of branches) list.append(row(m, 'is-branch'));
    }
    if (kept.length) {
      list.append(h('h3.arc-h', null, h('span', { text: 'Kept for you' }), h('span.arc-h-note', { text: 'Written as you play, each over the last' })));
      for (const m of kept) list.append(row(m, 'is-kept'));
    }
    if (!rows.length && !now) list.append(h('p.muted', { text: 'No saved worlds yet.' }));
    const pick = (chosen && rows.find((m) => m.id === chosen.id)) || own.find((m) => app.world && m.key === worldKey(app.world)) || own[0] || kept[0] || null;
    choose(pick);
  }

  async function saveNew() {
    const name = await promptDialog({ title: 'Name this save', label: 'Slot name', value: `${app.world.name}, Year ${yearOf(app.world)}` });
    if (!name) return;
    const id = 'slot-' + Date.now().toString(36);
    await run(`Saving “${name}”…`, async () => { const m = await saveSlot(app, id, name); chosen = m; return `Saved “${name}”.`; });
  }

  async function doOverwrite(m) {
    const ok = await confirmDialog({ title: 'Overwrite this save?', text: `“${m.name}” (${m.worldName}, Year ${m.year}) will be replaced by the world as it is now.`, confirmLabel: 'Overwrite' });
    if (!ok) return;
    await run('Saving…', async () => { await saveSlot(app, m.id, m.name); return `Overwrote “${m.name}”.`; });
  }

  async function doDelete(m) {
    const ok = await confirmDialog({ title: 'Delete this save?', text: `“${m.name}” (${m.worldName}, Year ${m.year}) will be removed from this browser. This cannot be undone.`, confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    await run('Deleting…', async () => { await deleteSlot(m.id); chosen = null; return `Deleted “${m.name}”.`; });
  }

  async function doLoad(m) {
    if (app.world) {
      const ok = await confirmDialog({ title: 'Open this world?', text: `The current world, ${app.world.name}, will be closed. Anything since your last save will be lost.`, confirmLabel: 'Open' });
      if (!ok) return;
    }
    modal.close();
    try { await loadSlot(app, m.id); } catch (e) { statusToast(app, `That save could not be opened: ${e.message}`, 'error'); }
  }

  async function doExport() {
    if (!app.world) return;
    const host = await hostDownloads();
    if (host) {
      await run('Preparing the file…', async () => {
        const name = `${fileSafe(app.world.name)}-year-${yearOf(app.world)}.atlas.json`;
        // the save text in one pass where the kernel offers it (same bytes, no deep copy)
        const text = typeof SER.serializeWorldText === 'function' ? SER.serializeWorldText(app.world) : JSON.stringify(serializeWorld(app.world));
        const blob = new Blob([text], { type: 'application/json' });
        try { await host.save({ filename: name, data: blob }); }
        catch (e) {
          if (e?.code === 'declined') return 'Export cancelled. The world is unchanged.';
          if (e?.code === 'rate_limited') throw new Error('another save prompt is still open; finish it, then try again');
          if (e?.code === 'too_large') throw new Error('the file is too large for this view; keep the world in a browser slot instead');
          throw new Error('this view cannot save files; keep the world in a browser slot instead');
        }
        return `Exported ${name} (${sizeText(blob.size)}).`;
      }, false);
      return;
    }
    await run('Preparing the file…', async () => {
      const { bytes, gz } = await packWorld(app.world);
      const name = `${fileSafe(app.world.name)}-year-${yearOf(app.world)}.atlas${gz ? '.json.gz' : '.json'}`;
      try { download(bytes, name, gz ? 'application/gzip' : 'application/json'); }
      catch (e) { throw new Error(`the download was blocked (${e.message})`); }
      return `Exported ${name} (${sizeText(bytes.length)}). If no download appeared, this view blocks downloads; keep the world in a browser slot instead.`;
    }, false);
  }

  async function doImport(file) {
    if (!file) return;
    if (app.world) {
      const ok = await confirmDialog({ title: 'Import this world?', text: `The current world, ${app.world.name}, will be closed. Anything since your last save will be lost.`, confirmLabel: 'Import' });
      if (!ok) { fileInput.value = ''; return; }
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const obj = await decompressJSON(bytes);
      modal.close();
      await app.loadWorldData(obj, 'imported world');
    } catch (e) {
      notice.hidden = false; notice.className = 'arc-notice is-error';
      const why = e instanceof SyntaxError || /JSON|gzip|decod|format/i.test(e.message || '')
        ? 'it is not an Atlas of Ages world file (exported files end in .atlas.json.gz or .atlas.json).'
        : e.message;
      notice.textContent = `“${file.name}” could not be opened: ${why}`;
    } finally { fileInput.value = ''; }
  }

  async function run(label, fn, reload = true) {
    if (busy) return;
    busy = true;
    notice.hidden = false; notice.className = 'arc-notice'; notice.textContent = label;
    try {
      const msg = await fn();
      notice.textContent = msg;
      statusToast(app, msg, 'ok', { icon: 'save' });
    } catch (e) {
      notice.className = 'arc-notice is-error';
      notice.textContent = `That did not work: ${e.message}`;
    } finally {
      busy = false;
      if (reload) await refresh();
    }
  }

  refresh();
}
