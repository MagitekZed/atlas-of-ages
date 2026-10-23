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
import { SPEEDS } from '../core/constants.js';
import { liveCivs, liveSettlements } from '../core/entities.js';
import { h, clear, svgEl } from './dom.js';
import { glyph } from './icons.js';
import { openModal, confirmDialog, promptDialog } from './widgets.js';
import { statusToast } from './toasts.js';
import { people, int } from './format.js';
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

/** A small picture of the world as the minimap draws it (webp data URL, about 8 KB), or null. */
export function thumbnail(app, world = app.world) {
  try {
    if (!world || !app.renderer || typeof app.renderer.drawMinimap !== 'function' || app.world !== world) return null;
    const c = document.createElement('canvas');
    c.width = 160; c.height = Math.max(40, Math.round(160 * (world.H / world.W)));
    const ctx = c.getContext('2d');
    app.renderer.drawMinimap(ctx, c.width, c.height);
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

export function openSaves(app) {
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } });
  const notice = h('div.notice', { hidden: true });
  const slotsBox = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
  const fileInput = h('input', { type: 'file', accept: '.json,.gz,.atlas,application/json,application/gzip', id: 'import-file', hidden: true });

  const current = app.world ? h('div.slot', null,
    h('span.sn', { text: app.world.name }),
    h('span.sm', { text: `Now: Year ${yearOf(app.world)} · ${liveCivs(app.world).length} nations · ${people(liveSettlements(app.world).reduce((a, s) => a + (s.population || 0), 0))} people` }),
    h('span.sa', null,
      h('button.btn.btn-brass.btn-sm', { type: 'button', text: 'Save to a new slot', onclick: () => saveNew() }),
    ),
  ) : h('p.muted', { text: 'Begin or open a world to save it.' });

  const exportBtn = h('button.btn', { type: 'button', disabled: !app.world }, svgEl(glyph('exportFile', 16)), 'Export to a file');
  const importBtn = h('button.btn', { type: 'button' }, svgEl(glyph('importFile', 16)), 'Import a file');
  exportBtn.addEventListener('click', () => doExport());
  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => doImport(fileInput.files?.[0]));

  body.append(
    h('h3.rule-head', { text: 'This world' }), current,
    h('h3.rule-head', { text: 'Saved in this browser' }), notice, slotsBox,
    h('h3.rule-head', { text: 'Files' }),
    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, exportBtn, importBtn, fileInput),
    h('p.gen-note', { text: 'Some embedded views block downloads. If no file appears after exporting, keep the world in a browser slot instead; importing a file always works.' }),
  );

  const modal = openModal({ title: 'Save and load', body, actions: [{ label: 'Close', onClick: (m) => m.close() }] });

  async function refresh() {
    clear(slotsBox);
    let rows;
    try { rows = await listSlots(); notice.hidden = true; }
    catch (e) {
      notice.hidden = false; notice.className = 'notice is-warn';
      notice.textContent = `Browser storage is not available here (${e.message}). You can still export the world to a file and import it later.`;
      return;
    }
    if (!rows.length) { slotsBox.appendChild(h('p.muted', { text: 'No saved worlds yet.' })); return; }
    // branches sit under the newest slot of the world they split from
    const parents = new Map();
    for (const m of rows) if (!m.branchOf && m.key && !parents.has(m.key)) parents.set(m.key, m);
    const under = new Map();
    for (const m of rows) if (m.branchOf && parents.has(m.branchOf)) { if (!under.has(m.branchOf)) under.set(m.branchOf, []); under.get(m.branchOf).push(m); }
    for (const m of rows) {
      if (m.branchOf && parents.has(m.branchOf)) continue;
      slotsBox.appendChild(slotRow(m, false));
      if (!m.branchOf && m.key && parents.get(m.key) === m) for (const b of under.get(m.key) || []) slotsBox.appendChild(slotRow(b, true));
    }
  }

  function slotRow(m, nested) {
    const open = h('button.btn.btn-sm', { type: 'button', text: 'Open' });
    const over = h('button.btn.btn-sm', { type: 'button', text: 'Overwrite', disabled: !app.world || Boolean(m.resume) });
    const del = h('button.btn.btn-sm.btn-quiet', { type: 'button', 'aria-label': `Delete ${m.name}` }, svgEl(glyph('trash', 15)));
    open.addEventListener('click', () => doLoad(m));
    over.addEventListener('click', () => doOverwrite(m));
    del.addEventListener('click', () => doDelete(m));
    const tag = m.branchOf ? h('span.tag', { text: m.branchDay != null ? `Branch · from Year ${int(Math.floor(m.branchDay / 360))}` : 'Branch' }) : m.resume ? h('span.tag', { text: 'Resume' }) : null;
    return h('div.slot', { class: nested ? 'is-branch' : '' },
      m.thumb ? h('img.slot-thumb', { src: m.thumb, alt: '' }) : h('span.slot-thumb.is-empty'),
      h('span.sn', null, `${m.name} · ${m.worldName}`, tag ? ' ' : '', tag),
      h('span.sm', { text: `Year ${m.year} · ${m.nations} nations · ${people(m.pop)} people · ${sizeText(m.bytes || 0)} · saved ${whenText(m.savedAt)}` }),
      h('span.sa', null, open, over, del),
    );
  }

  async function saveNew() {
    const name = await promptDialog({ title: 'Name this save', label: 'Slot name', value: `${app.world.name}, Year ${yearOf(app.world)}` });
    if (!name) return;
    const id = 'slot-' + Date.now().toString(36);
    await run(`Saving “${name}”…`, async () => { await saveSlot(app, id, name); return `Saved “${name}”.`; });
  }

  async function doOverwrite(m) {
    const ok = await confirmDialog({ title: 'Overwrite this save?', text: `“${m.name}” (${m.worldName}, Year ${m.year}) will be replaced by the world as it is now.`, confirmLabel: 'Overwrite' });
    if (!ok) return;
    await run('Saving…', async () => { await saveSlot(app, m.id, m.name); return `Overwrote “${m.name}”.`; });
  }

  async function doDelete(m) {
    const ok = await confirmDialog({ title: 'Delete this save?', text: `“${m.name}” (${m.worldName}, Year ${m.year}) will be removed from this browser. This cannot be undone.`, confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    await run('Deleting…', async () => { await deleteSlot(m.id); return `Deleted “${m.name}”.`; });
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
      return `Exported ${name} (${sizeText(bytes.length)}). If no download appeared, this view blocks downloads.`;
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
      notice.hidden = false; notice.className = 'notice is-error';
      const why = e instanceof SyntaxError || /JSON|gzip|decod|format/i.test(e.message || '')
        ? 'it is not an Atlas of Ages world file (exported files end in .atlas.json.gz or .atlas.json).'
        : e.message;
      notice.textContent = `“${file.name}” could not be opened: ${why}`;
    } finally { fileInput.value = ''; }
  }

  async function run(label, fn, reload = true) {
    if (busy) return;
    busy = true;
    notice.hidden = false; notice.className = 'notice'; notice.textContent = label;
    try {
      const msg = await fn();
      notice.textContent = msg;
      statusToast(app, msg, 'ok', { icon: 'save' });
    } catch (e) {
      notice.className = 'notice is-error';
      notice.textContent = `That did not work: ${e.message}`;
    } finally {
      busy = false;
      if (reload) await refresh();
    }
  }

  refresh();
}
