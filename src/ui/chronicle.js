// The Chronicle tab: the world's written history, newest first. A virtualised list with
// measured row heights (only visible rows exist in the DOM), category chips, an importance
// filter, full-text search, a "selection only" filter that follows chronicle refs (so the
// history of a plague, a faith, a war or a site is exact, with a text fallback for entries
// written before refs), and a removable year-range chip. Routine entries (fold) are hidden
// from the Notable view and above. Each entry shows what it grew out of ("Because …") and
// what came of it ("Led to …"); the Record button opens the entity it is about. New entries
// arriving while you read older ones do not move the page; a button offers to jump to them.
// App events answered: chronicleScrollTo (seq) scrolls to and flashes an entry, timeTravel
// (year) scrolls to the turn of that year, chronicleRange (fromYear, toYear) narrows the list.

import { CATEGORIES } from '../core/constants.js';
import { chronicleEntry } from '../core/chronicle.js';
import { h, clear, svgEl, debounce, setText, reducedMotion } from './dom.js';
import { glyph } from './icons.js';
import { tip } from './widgets.js';
import { focusEntry, entryHasPlace } from './toasts.js';
import { monthName, int, yearOfDay } from './format.js';
import { getPref, setPref } from './prefs.js';
import { getView, BUILTIN_VIEW_KINDS } from './registry.js';

const EST = 66;            // estimated row height before measuring
const OVERSCAN = 400;      // px rendered above and below the viewport
const IMP_LEVELS = [[1, 'All'], [2, 'Notable'], [3, 'Major'], [4, 'Historic'], [5, 'Epochal']];
const BUILTIN = new Set(BUILTIN_VIEW_KINDS);
const YEAR = 360;

/** Can a chronicle ref be opened as a record (a built-in view with its entity, or a registered view)? */
export function refOpens(app, ref) {
  const w = app.world;
  if (!w || !ref || ref.k == null) return false;
  switch (ref.k) {
    case 'civ': return Boolean(w.civs[ref.id]);
    case 'settlement': return Boolean(w.settlements[ref.id]);
    case 'war': return Boolean(w.wars[ref.id]);
    case 'religion': return Boolean(w.religions[ref.id]);
    case 'plague': return Boolean(w.plagues[ref.id]);
    case 'army': return w.armies.some((q) => q.id === ref.id) || Boolean(w.history?.series?.a?.[ref.id]);
    case 'storm': return w.storms.some((q) => q.id === ref.id) || (w.history?.events || []).some((e) => e.t === 'storm' && e.sid === ref.id);
    case 'volcano': return w.volcanoes.some((q) => q.id === ref.id);
    default: return !BUILTIN.has(ref.k) && Boolean(getView(ref.k));
  }
}

/** Open what an entry is about: its ref's record if there is one, else the place it names. */
export function openEntry(app, e, opts = {}) {
  if (e.ref && refOpens(app, e.ref)) { app.select({ kind: e.ref.k, id: e.ref.id }, { focus: true, openTab: opts.openTab !== false }); return; }
  focusEntry(app, e, opts);
}

export function createChronicle(app) {
  const el = h('div.tabpanel', { style: { gap: '0', flex: '1', minHeight: '0' } });
  let cats = new Set(getPref('chronCats', []) || []);
  let minImp = getPref('chronImp', 2) || 2;
  let query = '';
  let onlySel = false;
  let range = null;          // { from, to } in years

  // --- filters ---------------------------------------------------------------------------
  const search = h('input.field', { id: 'chron-search', type: 'search', placeholder: 'Search the chronicle', autocomplete: 'off', 'aria-label': 'Search the chronicle' });
  const searchWrap = h('div.chron-search', null, svgEl(glyph('search', 16)), search);
  const chipRow = h('div.chip-row', { role: 'group', 'aria-label': 'Categories' });
  const allChip = h('button.chip', { type: 'button', text: 'All' });
  allChip.addEventListener('click', () => { cats.clear(); saveCats(); syncChips(); refilter(); });
  chipRow.appendChild(allChip);
  const chips = new Map();
  for (const [key, c] of Object.entries(CATEGORIES)) {
    const b = h('button.chip', { type: 'button', style: { '--c': c.color } }, h('i.dot'), c.label);
    b.addEventListener('click', () => { if (cats.has(key)) cats.delete(key); else cats.add(key); saveCats(); syncChips(); refilter(); });
    chips.set(key, b);
    chipRow.appendChild(b);
  }
  const impSeg = h('div.seg', { role: 'group', 'aria-label': 'Importance' });
  const syncImp = () => { for (const x of impSeg.children) x.setAttribute('aria-pressed', String(Number(x.dataset.v) === minImp)); };
  for (const [v, label] of IMP_LEVELS) {
    const b = h('button', { type: 'button', text: label, 'aria-pressed': String(v === minImp), dataset: { v: String(v) } });
    tip(b, v === 1 ? 'Every entry, including routine news and local details.' : `Importance ${v} and above; routine news is folded away.`);
    b.addEventListener('click', () => { minImp = v; setPref('chronImp', v); syncImp(); refilter(); });
    impSeg.appendChild(b);
  }
  const selChip = h('button.chip', { type: 'button', 'aria-pressed': 'false', text: 'Selection only' });
  tip(selChip, 'Show only entries about the selected record: a place, town, nation, war, faith, plague or site.');
  selChip.addEventListener('click', () => { onlySel = !onlySel; selChip.setAttribute('aria-pressed', String(onlySel)); refilter(); });
  const rangeChip = h('button.chip.is-range', { type: 'button', hidden: true, 'aria-label': 'Clear the year range' });
  rangeChip.addEventListener('click', () => setRange(null));
  const count = h('span.chron-count');
  const tools = h('div.chron-tools', null, searchWrap, chipRow, h('div.chron-filter-row', null, impSeg, selChip, rangeChip), count);

  const inner = h('div.vlist-inner');
  const jump = h('button.btn.btn-sm.btn-brass.jump-new', { type: 'button', hidden: true });
  const list = h('div.vlist', { role: 'feed', 'aria-label': 'Chronicle entries', tabindex: '0' }, inner);
  const empty = h('p.vlist-empty', { hidden: true });
  const listWrap = h('div', { style: { position: 'relative', flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' } }, jump, list, empty);
  el.append(tools, listWrap);

  function saveCats() { setPref('chronCats', [...cats]); }
  function syncChips() {
    allChip.setAttribute('aria-pressed', String(cats.size === 0));
    for (const [k, b] of chips) b.setAttribute('aria-pressed', String(cats.has(k)));
  }
  syncChips();
  search.addEventListener('input', debounce(() => { query = search.value.trim().toLowerCase(); refilter(); }, 180));

  function setRange(r) {
    range = r && Number.isFinite(r.from) && Number.isFinite(r.to) ? { from: Math.min(r.from, r.to), to: Math.max(r.from, r.to) } : null;
    rangeChip.hidden = !range;
    if (range) { rangeChip.textContent = `Y${range.from}–Y${range.to}  ×`; tip(rangeChip, 'Only entries from these years. Click to show every year again.'); }
    refilter();
  }

  // --- model --------------------------------------------------------------------------------
  let rows = [];                 // filtered entries, newest first
  let heights = new Map();       // seq → measured px
  let offsets = new Float64Array(1);
  let offsetsDirty = true;
  let lastSeq = 0, firstSeqSeen = null;
  const nodes = new Map();       // seq → element
  let kids = new Map();          // cause seq → [child entries]
  let freshCount = 0;
  let width = 0;

  /** Does an entry concern the current selection? Refs first; old entries by their fields or text. */
  function aboutSelection(e) {
    const s = app.selection, w = app.world;
    if (!s || !w) return false;
    if (e.ref && e.ref.k === s.kind && String(e.ref.id) === String(s.id)) return true;
    switch (s.kind) {
      case 'civ': return e.civId === s.id;
      case 'settlement': return e.sid === s.id || (!e.ref && w.settlements[s.id] && (e.text || '').includes(w.settlements[s.id].name));
      case 'tile': return e.x != null && Math.hypot(e.x - (s.x ?? 0), e.y - (s.y ?? 0)) <= 6;
      case 'war': { const war = w.wars[s.id]; return war && !e.ref ? (e.text || '').includes(war.name) || ((war.attackers.includes(e.civId) || war.defenders.includes(e.civId)) && (e.cat === 'war' || e.cat === 'diplomacy') && e.day >= war.startDay && (war.endDay == null || e.day <= war.endDay)) : false; }
      case 'religion': return !e.ref && (e.text || '').includes(w.religions[s.id]?.name || '\u0000');
      case 'plague': return !e.ref && (e.text || '').includes(w.plagues[s.id]?.name || '\u0000');
      case 'volcano': return !e.ref && (e.text || '').includes(w.volcanoes.find((v) => v.id === s.id)?.name || '\u0000');
      case 'site': { const site = w.sites.find((q) => q.id === s.id); return site && e.x != null ? Math.hypot(e.x - site.x, e.y - site.y) <= 2 : false; }
      case 'compare': { const ids = String(s.id).split(',').map(Number); return ids.includes(e.civId); }
      default: return false;
    }
  }

  function matches(e) {
    if (e.imp < minImp) return false;
    if (e.fold && minImp >= 2) return false;
    if (cats.size && !cats.has(e.cat)) return false;
    if (range) { const y = yearOfDay(e.day); if (y < range.from || y > range.to) return false; }
    if (query && !(e.text || '').toLowerCase().includes(query)) return false;
    if (onlySel && !aboutSelection(e)) return false;
    return true;
  }

  function indexKids(es) {
    kids = new Map();
    for (const e of es) if (e.cause != null) { const k = kids.get(e.cause); if (k) k.push(e); else kids.set(e.cause, [e]); }
  }

  function refilter() {
    const w = app.world;
    rows = [];
    if (w) {
      const es = w.chronicle.entries;
      indexKids(es);
      for (let k = es.length - 1; k >= 0; k--) if (matches(es[k])) rows.push(es[k]);
      lastSeq = w.chronicle.seq;
      firstSeqSeen = es.length ? es[0].seq : null;
    }
    offsetsDirty = true;
    freshCount = 0;
    jump.hidden = true;
    list.scrollTop = 0;
    for (const n of nodes.values()) n.remove();
    nodes.clear();
    render();
    updateCount();
  }

  function updateCount() {
    const total = app.world ? app.world.chronicle.entries.length : 0;
    setText(count, total ? `Showing ${int(rows.length)} of ${int(total)} entries` : '');
    empty.hidden = rows.length > 0;
    if (!rows.length) empty.textContent = total ? 'No entries match these filters.' : 'History has not yet begun to be written.';
  }

  /** Take in entries recorded since the last refresh without disturbing the reader. */
  function ingest() {
    const w = app.world;
    if (!w) return;
    const es = w.chronicle.entries;
    if (es.length && firstSeqSeen != null && es[0].seq !== firstSeqSeen && es[0].seq > firstSeqSeen) {
      // the kernel pruned old entries; drop rows that no longer exist
      const keep = new Set(es.map((e) => e.seq));
      rows = rows.filter((e) => keep.has(e.seq));
      firstSeqSeen = es[0].seq;
      offsetsDirty = true;
    }
    if (w.chronicle.seq === lastSeq) return;
    const fresh = [];
    for (let k = es.length - 1; k >= 0; k--) {
      const e = es[k];
      if (e.seq <= lastSeq) break;
      if (e.cause != null) {
        const list = kids.get(e.cause);
        if (list) list.push(e); else kids.set(e.cause, [e]);
        // the parent row grows a "Led to" line: rebuild it when next drawn
        const n = nodes.get(e.cause);
        if (n) { n.remove(); nodes.delete(e.cause); heights.delete(e.cause); offsetsDirty = true; }
      }
      if (matches(e)) fresh.push(e);
    }
    lastSeq = w.chronicle.seq;
    if (!fresh.length) { updateCount(); if (offsetsDirty) render(); return; }
    const atTop = list.scrollTop < 8;
    rows = fresh.concat(rows);
    offsetsDirty = true;
    if (!atTop) {
      let add = 0;
      for (const e of fresh) add += heights.get(e.seq) || EST;
      list.scrollTop += add;
      freshCount += fresh.length;
      jump.textContent = `${freshCount} new ${freshCount === 1 ? 'entry' : 'entries'}`;
      jump.hidden = false;
    }
    render(fresh.length < 30 ? new Set(fresh.map((e) => e.seq)) : null);
    updateCount();
  }

  // while the list glides up to the newest entries, rows measured on the way must not nudge
  // scrollTop (setting it cancels the smooth scroll part-way)
  let jumping = false, jumpTimer = 0;
  jump.addEventListener('click', () => {
    jumping = true; clearTimeout(jumpTimer); jumpTimer = setTimeout(() => { jumping = false; }, 2000);
    list.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
    freshCount = 0; jump.hidden = true;
  });
  list.addEventListener('scroll', () => {
    if (list.scrollTop < 1) jumping = false;
    if (list.scrollTop < 8 && freshCount) { freshCount = 0; jump.hidden = true; }
    render();
  }, { passive: true });

  function computeOffsets() {
    if (!offsetsDirty) return;
    offsets = new Float64Array(rows.length + 1);
    for (let k = 0; k < rows.length; k++) offsets[k + 1] = offsets[k] + (heights.get(rows[k].seq) || EST);
    inner.style.height = offsets[rows.length] + 'px';
    offsetsDirty = false;
  }

  function firstVisible(y) {
    let lo = 0, hi = rows.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (offsets[mid + 1] <= y) lo = mid + 1; else hi = mid; }
    return lo;
  }

  const clip = (t, n = 96) => (t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t);

  function threadLink(prefix, target, cls) {
    const b = h('button.thread', { type: 'button', class: cls }, h('b', { text: prefix }), ' ', clip(target.text || ''));
    tip(b, `Go to this entry (${'Y' + yearOfDay(target.day)})`);
    b.addEventListener('click', (ev) => { ev.stopPropagation(); scrollTo(target.seq); });
    return b;
  }

  function makeRow(e) {
    const c = CATEGORIES[e.cat] || { label: e.cat, color: 'var(--brass)' };
    const imp = h('span.imp', { 'aria-label': `Importance ${e.imp} of 5` });
    for (let k = 1; k <= 5; k++) imp.appendChild(h('i', { class: k <= e.imp ? 'on' : '' }));
    const placed = entryHasPlace(app, e) || (e.ref && refOpens(app, e.ref));
    const rec = placed ? h('button.rec', { type: 'button', text: 'Record', 'aria-label': 'Open the record of this entry in the Inspector' }) : null;
    const body = [h('div.cat', null, h('i.dot'), c.label, e.fold ? h('span.fold', { text: 'routine' }) : null, imp, rec), h('p.txt', { text: e.text })];
    const w = app.world;
    if (e.cause != null && w) {
      const parent = chronicleEntry(w, e.cause);
      if (parent) body.push(threadLink('Because', parent, 'is-cause'));
    }
    const ch = kids.get(e.seq);
    if (ch && ch.length) {
      for (const k of ch.slice(0, 2)) body.push(threadLink('Led to', k, 'is-effect'));
      if (ch.length > 2) body.push(h('span.thread-more', { text: `and ${ch.length - 2} more` }));
    }
    const row = h('div.centry', { class: `imp-${e.imp}${placed ? ' is-placed' : ''}${e.fold ? ' is-fold' : ''}`, role: 'article', tabindex: '0', style: { '--c': c.color }, dataset: { seq: String(e.seq) } },
      h('span.when', null, h('b', { text: 'Y' + yearOfDay(e.day) }), monthName(e.day)),
      h('div', null, ...body),
    );
    // a click shows the place on the map and keeps you reading; "Record" opens its record
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('.rec')) { openEntry(app, e, { openTab: true }); return; }
      if (ev.target.closest('.thread')) return;
      focusEntry(app, e, { openTab: false });
    });
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && ev.target === row) { ev.preventDefault(); if (ev.shiftKey) openEntry(app, e, { openTab: true }); else focusEntry(app, e, { openTab: false }); }
    });
    return row;
  }

  function render(flash = null, depth = 0) {
    if (el.offsetParent === null) return;
    computeOffsets();
    const top = list.scrollTop, vh = list.clientHeight || 600;
    const a = firstVisible(Math.max(0, top - OVERSCAN));
    let b = a;
    while (b < rows.length && offsets[b] < top + vh + OVERSCAN) b++;
    const want = new Set();
    for (let k = a; k < b; k++) want.add(rows[k].seq);
    for (const [seq, n] of nodes) if (!want.has(seq)) { n.remove(); nodes.delete(seq); }
    for (let k = a; k < b; k++) {
      const e = rows[k];
      let n = nodes.get(e.seq);
      if (!n) {
        n = makeRow(e);
        if (flash && flash.has(e.seq)) n.classList.add('is-new');
        if (anchor && anchor.flashed && anchor.seq === e.seq) n.classList.add('is-flash');   // re-made while it is still asked for
        nodes.set(e.seq, n);
        inner.appendChild(n);
      }
      n.style.transform = `translateY(${offsets[k]}px)`;
    }
    // measure and correct
    let changed = false, aboveDelta = 0;
    for (let k = a; k < b; k++) {
      const e = rows[k];
      const n = nodes.get(e.seq);
      const hgt = n.offsetHeight;
      if (hgt && Math.abs((heights.get(e.seq) || EST) - hgt) > 0.5) {
        if (offsets[k] < top) aboveDelta += hgt - (heights.get(e.seq) || EST);
        heights.set(e.seq, hgt);
        changed = true;
      }
    }
    if (changed) {
      offsetsDirty = true;
      computeOffsets();
      for (let k = a; k < b; k++) { const n = nodes.get(rows[k].seq); if (n) n.style.transform = `translateY(${offsets[k]}px)`; }
      if (aboveDelta && !jumping) list.scrollTop = top + aboveDelta;
    }
    // an entry asked for (scrollTo) stays where it was put while the list lays out around it:
    // the tab opening, the panel's width settling and rows measured on the way all move it
    if (anchor) {
      const k = performance.now() < anchor.until ? rows.findIndex((r) => r.seq === anchor.seq) : -1;
      if (k < 0) { anchor = null; return; }
      const want = Math.max(0, offsets[k] - 24);
      if (Math.abs(list.scrollTop - want) > 1 && depth < 4) { list.scrollTop = want; render(null, depth + 1); return; }
      const n = nodes.get(anchor.seq);
      if (n && !anchor.flashed) { anchor.flashed = true; n.classList.remove('is-flash'); void n.offsetWidth; n.classList.add('is-flash'); }
    }
  }
  let anchor = null;   // { seq, until, flashed }: the entry scrollTo keeps in place for a moment
  // the reader taking the list in hand lets it go
  for (const ev of ['wheel', 'touchstart', 'pointerdown', 'keydown']) list.addEventListener(ev, () => { anchor = null; }, { passive: true });

  /** Scroll to an entry (relaxing the filters that hide it) and flash it. */
  function scrollTo(seq) {
    const w = app.world;
    if (!w) return;
    const e = chronicleEntry(w, seq);
    if (!e) return;
    if (!rows.some((r) => r.seq === seq)) {
      // loosen only what hides it
      if (e.imp < minImp || (e.fold && minImp >= 2)) { minImp = 1; syncImp(); }
      if (cats.size && !cats.has(e.cat)) { cats.clear(); syncChips(); }
      if (query && !(e.text || '').toLowerCase().includes(query)) { query = ''; search.value = ''; }
      if (onlySel && !aboutSelection(e)) { onlySel = false; selChip.setAttribute('aria-pressed', 'false'); }
      if (range) { const y = yearOfDay(e.day); if (y < range.from || y > range.to) { range = null; rangeChip.hidden = true; } }
      refilter();
    }
    const k = rows.findIndex((r) => r.seq === seq);
    if (k < 0) return;
    anchor = { seq, until: performance.now() + 1500, flashed: false };
    computeOffsets();
    list.scrollTop = Math.max(0, offsets[k] - 24);
    render();
  }

  /** Scroll to the first entry of a year (the oldest entry of it in the current list). */
  function scrollToYear(year) {
    if (!rows.length) return;
    // rows are newest first: find the last row whose year is ≥ year
    let k = -1;
    for (let j = 0; j < rows.length; j++) { if (yearOfDay(rows[j].day) >= year) k = j; else break; }
    if (k < 0) k = 0;
    computeOffsets();
    list.scrollTop = Math.max(0, offsets[k] - 24);
    render();
  }

  new ResizeObserver(() => {
    const wdt = list.clientWidth;
    // a hidden tab measures 0 wide: that is no reason to measure every row again when it shows
    if (wdt > 0 && Math.abs(wdt - width) > 1) { width = wdt; heights = new Map(); offsetsDirty = true; render(); }
    else render();
  }).observe(list);

  app.on('select', () => { if (onlySel) refilter(); });
  app.on('chronicleScrollTo', (seq) => {
    if (app.tab !== 'chronicle') app.setTab('chronicle');
    requestAnimationFrame(() => scrollTo(Number(seq)));
  });
  app.on('timeTravel', (year) => { if (app.tab === 'chronicle' && Number.isFinite(year)) scrollToYear(year); else pendingYear = year; });
  app.on('chronicleRange', (from, to) => { setRange(from == null ? null : { from, to }); if (app.tab !== 'chronicle') app.setTab('chronicle'); });
  let pendingYear = null;

  return {
    id: 'chronicle', label: 'Chronicle', title: 'Chronicle', icon: 'chronicle', el, flush: true,
    show() {
      if (!rows.length && app.world?.chronicle.entries.length) refilter(); else { ingest(); render(); }
      if (pendingYear != null) { const y = pendingYear; pendingYear = null; requestAnimationFrame(() => scrollToYear(y)); }
    },
    refresh() { ingest(); },
    onWorld() { heights = new Map(); range = null; rangeChip.hidden = true; refilter(); },
    focusSearch() { search.focus(); },
    clear() { clear(inner); },
    scrollTo, scrollToYear, setRange,
  };
}
