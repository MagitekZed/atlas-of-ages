// Watch, pins and the patron people.
//
// The watchlist (world.ui.watch, at most 8, saved with the world and never read by the sim):
// '.' or the star on any record adds or removes it. Watched things sit as chips under the
// cartouche with a live number and a count of what the Chronicle has written about them since
// you last looked (each item keeps the chronicle seq it was last seen at, so the count outlives
// a reload: looking means opening it, from its chip or anywhere else); their
// entries reach the viewer as gilded toasts outside the meter (a toast filter), and watched
// movers that leave the view are pointed at by arrows on the map's edge.
// Pins (world.ui.pins): B keeps the current view under a name; Shift+1–9 flies back to it.
// The patron people (world.ui.patron, world.ui.lineage): a chip with banner, ruler, numbers
// and a sparkline that opens their saga; every notable entry about them is gilded; when they
// fall an elegy offers their successors.
// Follow-anything: a Follow action on nations, wars, plagues and faiths (app.setFollow).

import { DAYS_PER_YEAR } from '../core/constants.js';
import { registerKey, registerCommand, registerTitleAction, registerToastFilter, registerSearchSource } from './registry.js';
import { h, clear, svgEl, setText, isCompact } from './dom.js';
import { glyph, iconEl } from './icons.js';
import { tip, openModal, promptDialog, openPopover, closePopover } from './widgets.js';
import { statusToast, actionToast, focusEntry } from './toasts.js';
import { describeSel, selectionPoint, selectionExists, isMoverKind } from './app.js';
import * as F from './format.js';

const MAX_WATCH = 8;
const MAX_PINS = 9;
const ARROW_HZ = 10;
const FOLLOW_KINDS = new Set(['civ', 'war', 'plague', 'religion']);

export function mount(app) {
  const stage = document.getElementById('stage');
  const strip = h('div.story-strip', { role: 'toolbar', 'aria-label': 'Watched' });
  const arrows = h('div.edge-arrows', { 'aria-hidden': 'true' });
  stage.append(strip, arrows);

  const ui = () => app.world?.ui || null;
  const same = (a, b) => a && b && a.kind === b.kind && a.id === b.id;
  const watched = () => ui()?.watch || [];
  const isWatched = (sel) => watched().some((q) => same(q, sel));
  const news = new Map();     // 'kind:id' → unread count (not saved)
  let lastSeq = 0;

  // ---------------------------------------------------------------------------
  // Watching

  function toggleWatch(sel, { quiet = false } = {}) {
    const w = app.world;
    if (!w || !sel || sel.kind === 'tile') { if (sel?.kind === 'tile') statusToast(app, 'Bare ground cannot be watched; pin the view instead (B).', 'info', { icon: 'star' }); return false; }
    const list = w.ui.watch;
    const k = list.findIndex((q) => same(q, sel));
    const d = describeSel(app, sel);
    if (k >= 0) {
      list.splice(k, 1);
      news.delete(sel.kind + ':' + sel.id);
      if (!quiet) statusToast(app, `${d.name} is no longer watched.`, 'info', { icon: 'star' });
    } else {
      if (list.length >= MAX_WATCH) { statusToast(app, `You can watch ${MAX_WATCH} things at once. Unwatch one first.`, 'warn', { icon: 'star' }); return false; }
      list.push({ kind: sel.kind, id: sel.id, since: w.time.day, seen: w.chronicle.seq });
      if (!quiet) statusToast(app, `Watching ${d.name}: what befalls it will find you.`, 'ok', { icon: 'star' });
    }
    app.emit('watch');
    render();
    return k < 0;
  }
  app.toggleWatch = toggleWatch;
  app.isWatched = isWatched;

  /** Is this chronicle entry about a watched thing (or the patron)? Returns the watch keys it touches. */
  function concerns(e) {
    const w = app.world;
    const out = [];
    if (!w) return out;
    const sCiv = e.sid != null ? w.settlements[e.sid]?.civId : null;
    for (const q of watched()) {
      let hit = false;
      if (q.kind === 'civ') hit = e.civId === q.id || sCiv === q.id || (e.ref?.k === 'civ' && e.ref.id === q.id);
      else if (q.kind === 'settlement') hit = e.sid === q.id || (e.ref?.k === 'settlement' && e.ref.id === q.id);
      else hit = e.ref?.k === q.kind && e.ref.id === q.id;
      if (!hit && q.kind === 'war' && e.ref?.k === 'war') hit = e.ref.id === q.id;
      if (hit) out.push(q.kind + ':' + q.id);
    }
    const p = ui()?.patron;
    if (p != null && (e.civId === p || sCiv === p || (e.ref?.k === 'civ' && e.ref.id === p))) out.push('patron');
    return out;
  }

  app.watchConcerns = (e) => concerns(e).length > 0;

  registerToastFilter((a, e) => {
    if (!a.world || e.imp < 2) return null;
    const c = concerns(e);
    return c.length ? { watched: true } : null;
  });

  // ---------------------------------------------------------------------------
  // The strip

  function liveValue(sel) {
    const w = app.world;
    switch (sel.kind) {
      case 'civ': { const c = w.civs[sel.id]; return c ? (c.alive === false ? `fell ${F.year(c.fallenDay)}` : F.people(c.population)) : '—'; }
      case 'settlement': { const s = w.settlements[sel.id]; return s ? (s.alive === false ? 'ruins' : F.people(s.population)) : '—'; }
      case 'army': { const a = w.armies.find((q) => q.id === sel.id); return a ? F.people(Math.round(a.strength || 0)) : 'gone'; }
      case 'storm': { const s = w.storms.find((q) => q.id === sel.id); return s ? Math.round((s.intensity || 0) * 100) + '%' : 'spent'; }
      case 'war': { const war = w.wars[sel.id]; return war ? (war.active ? F.span(w.time.day - war.startDay) : 'ended') : '—'; }
      case 'plague': { const p = w.plagues[sel.id]; return p ? `${F.people(p.deaths || 0)} dead` : '—'; }
      case 'religion': { const r = w.religions[sel.id]; return r ? (r.alive === false ? 'dead' : F.people(r.followers || 0)) : '—'; }
      default: { const d = describeSel(app, sel); return d.alive === false ? 'gone' : ''; }
    }
  }

  let stripSig = '';
  function render() {
    const w = app.world;
    const list = watched();
    const patron = ui()?.patron;
    const sig = w ? `${patron}|${list.map((q) => q.kind + q.id).join(',')}` : '';
    if (sig !== stripSig) { stripSig = sig; build(); }
    update();
  }

  const chipEls = new Map();
  let patronEl = null;
  function build() {
    clear(strip);
    chipEls.clear();
    patronEl = null;
    const w = app.world;
    if (!w) { strip.hidden = true; return; }
    const p = ui().patron;
    if (p != null && w.civs[p]) strip.appendChild(patronEl = patronChip(p));
    for (const q of watched()) {
      const el = watchChip(q);
      chipEls.set(q.kind + ':' + q.id, el);
      strip.appendChild(el);
    }
    strip.hidden = !strip.childElementCount;
    place();
  }

  function watchChip(q) {
    const d = describeSel(app, q);
    const val = h('span.wv');
    const dot = h('i.news', { hidden: true });
    const sw = d.color ? h('i.swatch', { style: { '--c': d.color } }) : iconEl(d.icon || q.kind, { size: 14, label: d.name });
    const b = h('button.watch-chip', { type: 'button' }, sw, h('span.wn', { text: d.name }), val, dot);
    tip(b, `${d.sub || ''}${d.sub ? '. ' : ''}Click to go there; right-click for more.`, d.name);
    b.addEventListener('click', () => {
      markSeen(q);
      if (selectionExists(app, q)) app.select(q, { frame: !isMoverKind(q.kind) && q.kind !== 'settlement', focus: true });
      update();
    });
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); chipMenu(b, q); });
    let press = 0;
    b.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') press = setTimeout(() => { press = 0; chipMenu(b, q); }, 550); });
    const stop = () => { if (press) { clearTimeout(press); press = 0; } };
    b.addEventListener('pointerup', stop); b.addEventListener('pointerleave', stop); b.addEventListener('pointercancel', stop);
    b._val = val; b._dot = dot; b._sel = q;
    return b;
  }

  function chipMenu(anchor, q) {
    const item = (icon, label, fn) => { const x = h('button.menu-item', { type: 'button' }, svgEl(glyph(icon, 18)), h('span', { text: label })); x.addEventListener('click', () => { closePopover(); fn(); }); return x; };
    const d = describeSel(app, q);
    openPopover(anchor, h('div', null,
      h('div.menu-label', { text: d.name }),
      item('target', 'Show on the map', () => app.select(q, { focus: true })),
      item('eye', app.isFollowing(q) ? 'Stop following' : 'Follow', () => app.setFollow(app.isFollowing(q) ? null : q)),
      item('close', 'Stop watching', () => toggleWatch(q)),
    ), { cls: 'menu' });
  }

  function patronChip(cid) {
    const w = app.world;
    const c = w.civs[cid];
    const name = h('span.pn');
    const ruler = h('span.pr');
    const nums = h('span.pv');
    const badges = h('span.pb');
    const spark = h('canvas.pspark', { width: 72, height: 20, 'aria-hidden': 'true' });
    const banner = h('i.banner', { style: { '--c': c?.colorHex || 'var(--brass)' } });
    const b = h('button.patron-chip', { type: 'button', 'aria-haspopup': 'dialog' }, banner, h('span.pt', null, h('span.pk', { text: 'Your people' }), name, ruler), h('span.pside', null, nums, spark, badges));
    tip(b, 'The people you watch over. Click for their saga.', 'Patron');
    b.addEventListener('click', () => openSaga());
    b._name = name; b._ruler = ruler; b._nums = nums; b._badges = badges; b._spark = spark; b._banner = banner;
    return b;
  }

  let sparkAt = -1;
  function update() {
    const w = app.world;
    if (!w) return;
    for (const el of chipEls.values()) {
      const q = el._sel;
      setText(el._val, liveValue(q));
      const n = news.get(q.kind + ':' + q.id) || 0;
      el._dot.hidden = !n;
      setText(el._dot, n > 9 ? '9+' : String(n));
      el._dot.title = n ? `${n} new since you looked` : '';
      const d = describeSel(app, q);
      el.classList.toggle('is-gone', d.alive === false);
      el.classList.toggle('is-following', app.isFollowing(q));
    }
    if (patronEl) {
      const c = w.civs[ui().patron];
      if (!c) return;
      setText(patronEl._name, c.name);
      setText(patronEl._ruler, c.alive === false ? `Fell ${F.year(c.fallenDay)}` : c.ruler ? c.ruler.display || `${c.ruler.title || ''} ${c.ruler.name}`.trim() : F.titleCase(c.government || 'tribe'));
      setText(patronEl._nums, c.alive === false ? '' : `${F.people(c.population)} · ${F.eraName(c.tech?.era)}`);
      patronEl._banner.style.setProperty('--c', c.colorHex || 'var(--brass)');
      const atWar = w.wars.some((q) => q.active && (q.attackers.includes(c.id) || q.defenders.includes(c.id)));
      const marks = [];
      if (atWar) marks.push('At war');
      if (c.goldenAge > 0) marks.push('Golden age');
      if (c.darkAge > 0) marks.push('Dark age');
      setText(patronEl._badges, marks.join(' · '));
      patronEl._badges.className = 'pb' + (atWar ? ' is-war' : c.goldenAge > 0 ? ' is-gold' : '');
      const n = w.history?.years?.length || 0;
      if (n !== sparkAt) { sparkAt = n; drawSpark(patronEl._spark, c.id); }
      patronEl.classList.toggle('is-fallen', c.alive === false);
    }
  }

  function drawSpark(canvas, cid) {
    const w = app.world;
    const ys = (w.history?.years || []).slice(-80);
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = 72, ch = 20;
    if (canvas.width !== cw * dpr) { canvas.width = cw * dpr; canvas.height = ch * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const v = ys.map((r) => (r.civ && r.civ[cid] ? Number(r.civ[cid][0]) || 0 : 0));
    const max = Math.max(1, ...v);
    if (v.length < 2) return;
    ctx.beginPath();
    v.forEach((p, k) => { const x = (k / (v.length - 1)) * (cw - 2) + 1, y = ch - 2 - (p / max) * (ch - 4); if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = getComputedStyle(canvas).color || '#c9a466';
    ctx.stroke();
  }

  /** Keep the strip just under the cartouche (or the top bar on a phone). */
  function place() {
    const hud = document.querySelector('.hud-top');
    const cart = document.getElementById('cartouche');
    const sr = stage.getBoundingClientRect();
    const ref = isCompact() ? hud : cart;
    const r = ref?.getBoundingClientRect();
    if (!r || !r.height) return;
    strip.style.top = Math.round(r.bottom - sr.top + 8) + 'px';
    strip.style.left = Math.round(r.left - sr.left) + 'px';
    strip.style.maxWidth = isCompact() ? `calc(100% - ${Math.round(r.left - sr.left) * 2}px)` : Math.round(Math.max(r.width, 360)) + 'px';
  }
  try { new ResizeObserver(() => place()).observe(document.querySelector('.hud-top')); } catch (e) { /* no observer */ }
  window.addEventListener('resize', place);

  // ---------------------------------------------------------------------------
  // News dots, the patron's fall

  let lastCapital = new Map();   // patron civ id → its last capital (for the elegy's successors)
  function scanNews() {
    const w = app.world;
    if (!w || w.chronicle.seq === lastSeq) return;
    const es = w.chronicle.entries;
    for (let k = es.length - 1; k >= 0 && es[k].seq > lastSeq; k--) {
      const e = es[k];
      if (e.fold || e.imp < 2) continue;
      for (const key of concerns(e)) if (key !== 'patron') news.set(key, (news.get(key) || 0) + 1);
    }
    lastSeq = w.chronicle.seq;
    const sel = app.selection;
    if (sel) markSeen(sel);
  }
  /** The viewer has looked at a watched thing: its count starts again from now. */
  function markSeen(sel) {
    const q = watched().find((x) => same(x, sel));
    if (q && app.world) q.seen = app.world.chronicle.seq;
    news.delete(sel.kind + ':' + sel.id);
  }
  /** Count what was written about each watched thing since it was last seen (a world opens). */
  function recount() {
    const w = app.world;
    news.clear();
    if (!w) return;
    const list = watched();
    for (const q of list) if (!Number.isFinite(q.seen)) q.seen = w.chronicle.seq;
    const from = list.length ? Math.min(...list.map((q) => q.seen)) : w.chronicle.seq;
    const seenOf = new Map(list.map((q) => [q.kind + ':' + q.id, q.seen]));
    const es = w.chronicle.entries;
    for (let k = es.length - 1; k >= 0 && es[k].seq > from; k--) {
      const e = es[k];
      if (e.fold || e.imp < 2) continue;
      for (const key of concerns(e)) if (key !== 'patron' && e.seq > seenOf.get(key)) news.set(key, (news.get(key) || 0) + 1);
    }
  }

  let elegyShownFor = null;
  function watchPatron() {
    const w = app.world;
    const p = ui()?.patron;
    if (p == null || !w) return;
    const c = w.civs[p];
    if (!c) return;
    if (c.alive !== false) { if (c.capitalId != null) lastCapital.set(p, c.capitalId); return; }
    if (elegyShownFor === `${w.seed}|${p}` || app.fastForwarding) return;
    elegyShownFor = `${w.seed}|${p}`;
    elegy(c);
  }

  function successorsOf(c) {
    const w = app.world;
    const out = [];
    const add = (civ, why) => { if (civ && civ.alive !== false && civ.id !== c.id && !out.some((q) => q.civ.id === civ.id)) out.push({ civ, why }); };
    for (const x of w.civs) if (x && x.parentId === c.id) add(x, 'born of them');
    const capId = lastCapital.get(c.id);
    const cap = capId != null ? w.settlements[capId] : null;
    if (cap && cap.alive) add(w.civs[cap.civId], `holds ${cap.name}, their old capital`);
    if (c.parentId != null) add(w.civs[c.parentId], 'their parent people');
    // whoever took the most of their towns
    const took = new Map();
    for (const s of w.settlements) if (s && s.alive && s.originCivId === c.id) took.set(s.civId, (took.get(s.civId) || 0) + 1);
    const best = [...took.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) add(w.civs[best[0]], `rules ${best[1]} of their towns`);
    return out.slice(0, 4);
  }

  function elegy(c) {
    const w = app.world;
    const reigns = (c.rulerHistory?.length || 0) + (c.ruler ? 1 : 0);
    const years = Math.max(0, Math.round(((c.fallenDay ?? w.time.day) - (c.foundedDay || 0)) / DAYS_PER_YEAR));
    const cause = c.fallCause ? F.humanize(c.fallCause).toLowerCase() : 'the turning of the ages';
    const succ = successorsOf(c);
    const body = h('div.elegy', null,
      h('i.banner.is-large', { style: { '--c': c.colorHex || 'var(--brass)' } }),
      h('p.elegy-lead', { text: `${c.name} is no more. ${years > 1 ? `For ${F.int(years)} years` : 'For a little while'} they endured, from ${F.year(c.foundedDay)} until ${F.year(c.fallenDay)}, and fell to ${cause}.` }),
      h('dl.kv', null,
        h('dt', { text: 'At their height' }), h('dd', { text: `${F.people(c.peakPopulation || c.population || 0)} people` }),
        h('dt', { text: 'Rulers' }), h('dd', { text: F.int(Math.max(1, reigns)) }),
        h('dt', { text: 'Last ruler' }), h('dd', { text: c.ruler?.display || c.rulerHistory?.at?.(-1)?.name || '—' })),
      succ.length ? h('p', { text: 'Their story goes on in others. Whom will you watch over now?' }) : h('p.muted', { text: 'No people carries their name or their towns.' }),
    );
    const actions = succ.map((s) => ({ label: s.civ.name, cls: 'btn-brass', onClick: (m) => { m.close(); setPatron(s.civ.id, { lineage: true }); } }));
    actions.push({ label: 'Let them rest', onClick: (m) => { m.close(); setPatron(null, { quiet: true }); } });
    const m = openModal({ title: `The fall of ${c.name}`, small: true, body, actions });
    // name the reason for each successor beside its button
    succ.forEach((s, k) => { const btn = m.box.querySelectorAll('.modal-foot .btn')[k]; if (btn) tip(btn, `Watch over ${s.civ.name}: ${s.why}.`, s.civ.name); });
  }

  function setPatron(cid, { lineage = false, quiet = false } = {}) {
    const w = app.world;
    if (!w) return;
    const prev = w.ui.patron;
    if (cid != null && prev === cid) { cid = null; }
    if (lineage && prev != null && !w.ui.lineage.includes(prev)) w.ui.lineage.push(prev);
    if (!lineage) w.ui.lineage = cid == null ? w.ui.lineage : [];
    w.ui.patron = cid;
    elegyShownFor = null;
    if (cid != null && w.civs[cid]?.capitalId != null) lastCapital.set(cid, w.civs[cid].capitalId);
    if (!quiet) {
      const c = cid != null ? w.civs[cid] : null;
      if (c) statusToast(app, lineage ? `The saga goes on with ${c.name}.` : `You watch over ${c.name}. Their deeds will find you.`, 'ok', { icon: 'crown' });
      else if (prev != null) statusToast(app, `You no longer watch over ${w.civs[prev]?.name || 'that people'}.`, 'info', { icon: 'crown' });
    }
    app.emit('patron', cid);
    render();
  }
  app.setPatron = setPatron;

  /** The saga: the patron's chronicle, newest first, in centuries; with its lineage before it. */
  function openSaga() {
    const w = app.world;
    const p = ui()?.patron;
    const c = p != null ? w.civs[p] : null;
    if (!c) return;
    const line = [...(ui().lineage || []), p];
    const ids = new Set(line);
    const sidCiv = (sid) => w.settlements[sid]?.civId;
    const entries = w.chronicle.entries.filter((e) => e.imp >= 2 && !e.fold && (ids.has(e.civId) || (e.sid != null && ids.has(sidCiv(e.sid))) || (e.ref?.k === 'civ' && ids.has(e.ref.id))));
    const list = h('div.saga-list');
    let century = null;
    for (const e of entries.slice(-160).reverse()) {
      const cy = Math.floor(e.day / DAYS_PER_YEAR / 100);
      if (cy !== century) { century = cy; list.appendChild(h('h4.rule-head', { text: cy === 0 ? 'The first century' : `The ${ordinal(cy + 1)} century` })); }
      const row = h('button.saga-entry', { type: 'button', class: `imp-${e.imp}` }, h('span.y', { text: 'Y' + F.yearOfDay(e.day) }), h('span.t', { text: e.text }));
      row.addEventListener('click', () => { m.close(); focusEntry(app, e); });
      list.appendChild(row);
    }
    if (!entries.length) list.appendChild(h('p.muted', { text: 'Nothing of note has been written about them yet.' }));
    const lineage = line.length > 1 ? h('p.muted', { text: `Their line: ${line.map((id) => w.civs[id]?.name || '?').join(' → ')}` }) : null;
    const m = openModal({
      title: `The saga of ${c.name}`,
      body: h('div.saga', null,
        h('p.lead', { text: c.alive === false ? `${c.name} fell in ${F.year(c.fallenDay)}.` : `${c.ruler?.display ? c.ruler.display + ' rules ' : ''}${F.people(c.population)} people in ${F.int(c.settlementIds.length)} settlement${c.settlementIds.length === 1 ? '' : 's'} · ${F.eraName(c.tech?.era)}.` }),
        lineage, list),
      actions: [
        { label: 'Release them', onClick: (mm) => { mm.close(); setPatron(null); } },
        { label: 'Show their lands', onClick: (mm) => { mm.close(); app.select({ kind: 'civ', id: c.id }, { frame: true }); } },
        { label: 'Close', cls: 'btn-brass', onClick: (mm) => mm.close() },
      ],
    });
  }

  // ---------------------------------------------------------------------------
  // Pins

  function pinName() {
    const w = app.world, cam = app.renderer?.camera;
    if (!w || !cam) return 'A view';
    const x = Math.round(cam.x - 0.5), y = Math.round(cam.y - 0.5);
    const z = cam.zoom;
    let best = null, bd = Infinity;
    for (const s of w.settlements) {
      if (!s || !s.alive) continue;
      const d = (s.x - x) ** 2 + (s.y - y) ** 2 - Math.log10((s.population || 1) + 1) * 4;
      if (d < bd) { bd = d; best = s; }
    }
    const i = Math.max(0, Math.min(w.N - 1, Math.max(0, Math.min(w.H - 1, y)) * w.W + Math.max(0, Math.min(w.W - 1, x))));
    const owner = w.f.owner[i] >= 0 ? w.civs[w.f.owner[i]] : null;
    if (z < 3) return 'The whole world';
    if (z < 7 && owner) return `The lands of ${owner.name}`;
    if (best && Math.sqrt(Math.max(0, bd)) < 24 / Math.max(1, z / 6)) return `Near ${best.name}`;
    if (owner) return `In ${owner.name}`;
    let fbest = null, fd = Infinity;
    for (const f of w.features || []) { const d = (f.x - x) ** 2 + (f.y - y) ** 2; if (d < fd) { fd = d; fbest = f; } }
    return fbest ? `By ${fbest.name}` : `View ${x}, ${y}`;
  }

  function pinView() {
    const w = app.world, cam = app.renderer?.camera;
    if (!w || !cam) return;
    const pins = w.ui.pins;
    let n = 1;
    while (pins.some((p) => p.n === n) && n <= MAX_PINS) n++;
    if (n > MAX_PINS) n = pins.slice().sort((a, b) => (a.at || 0) - (b.at || 0))[0].n;   // reuse the oldest
    const k = pins.findIndex((p) => p.n === n);
    const pin = { n, name: pinName(), x: +cam.x.toFixed(2), y: +cam.y.toFixed(2), zoom: +cam.zoom.toFixed(3), mode: app.renderer?.mapMode || 'terrain', at: w.time.day };
    if (k >= 0) pins.splice(k, 1, pin); else pins.push(pin);
    pins.sort((a, b) => a.n - b.n);
    app.emit('pins');
    actionToast(app, {
      icon: 'pin', kicker: `Pinned view ${n}`, title: pin.name, text: `Shift ${n} brings you back here.`, ms: 5000,
      actions: [{ label: 'Rename', run: () => renamePin(n) }],
    });
  }

  async function renamePin(n) {
    const pin = app.world?.ui.pins.find((p) => p.n === n);
    if (!pin) return;
    const name = await promptDialog({ title: `Name pin ${n}`, label: 'Name', value: pin.name });
    if (name) { pin.name = name.slice(0, 48); app.emit('pins'); }
  }

  function gotoPin(n) {
    const w = app.world;
    const pin = w?.ui.pins.find((p) => p.n === n);
    if (!pin) { statusToast(app, `No view is pinned to ${n}. Press B to pin this one.`, 'info', { icon: 'pin' }); return; }
    app.emit('userCamera', { how: 'pin' });
    app.r('focusOn', pin.x, pin.y, pin.zoom);
    if (pin.mode && pin.mode !== app.renderer?.mapMode && app.mapModes().some((m) => m.id === pin.mode)) { app.r('setMapMode', pin.mode); app.emit('mapmode', pin.mode); }
  }
  app.gotoPin = gotoPin;

  function openPins() {
    const w = app.world;
    if (!w) return;
    const list = h('div.list');
    const fill = () => {
      clear(list);
      if (!w.ui.pins.length) list.appendChild(h('p.muted', { text: 'No pinned views yet. Press B over any view to keep it here.' }));
      for (const p of w.ui.pins) {
        const go = h('button.row', { type: 'button' }, h('span.pin-n', { text: String(p.n) }), h('span.t', { text: p.name }), h('span.s', { text: `${F.humanize(p.mode || 'terrain')} · pinned ${F.year(p.at)}` }));
        go.addEventListener('click', () => { m.close(); gotoPin(p.n); });
        const del = h('button.icon-btn', { type: 'button', 'aria-label': `Remove pin ${p.n}` }, svgEl(glyph('trash', 15)));
        del.addEventListener('click', () => { w.ui.pins = w.ui.pins.filter((q) => q !== p); app.emit('pins'); fill(); });
        const ren = h('button.icon-btn', { type: 'button', 'aria-label': `Rename pin ${p.n}` }, svgEl(glyph('pin', 15)));
        ren.addEventListener('click', () => renamePin(p.n).then(fill));
        list.appendChild(h('div.pin-row', null, go, ren, del));
      }
    };
    fill();
    const m = openModal({ title: 'Pinned views', small: true, body: h('div', null, list), actions: [{ label: 'Pin this view', onClick: () => { pinView(); fill(); } }, { label: 'Close', cls: 'btn-brass', onClick: (mm) => mm.close() }] });
  }

  // ---------------------------------------------------------------------------
  // Edge arrows for watched movers out of view

  const arrowEls = new Map();
  let arrowAt = 0;
  function arrowsFrame(t) {
    requestAnimationFrame(arrowsFrame);
    if (t - arrowAt < 1000 / ARROW_HZ) return;
    arrowAt = t;
    const w = app.world;
    const r = app.renderer;
    const movers = [];
    if (w && r && document.getElementById('app').dataset.mode === 'world' && !document.getElementById('app').classList.contains('ui-hidden')) {
      for (const q of watched()) if (isMoverKind(q.kind)) movers.push(q);
      if (app.follow && isMoverKind(app.follow.kind) && !movers.some((q) => same(q, app.follow))) movers.push(app.follow);
    }
    const keep = new Set();
    const cw = r?.viewW || 0, ch = r?.viewH || 0;
    for (const q of movers) {
      const p = selectionPoint(app, q);
      if (!p) continue;
      const s = app.r('tileToScreen', p.x + 0.5, p.y + 0.5);
      if (!s) continue;
      const m = 22;
      if (s.sx >= 0 && s.sy >= 0 && s.sx <= cw && s.sy <= ch) continue;
      const key = q.kind + ':' + q.id;
      keep.add(key);
      let el = arrowEls.get(key);
      if (!el) {
        const d = describeSel(app, q);
        el = h('button.edge-arrow', { type: 'button', 'aria-label': `${d.name}, off the map` }, h('span.ea-tip'), h('span.ea-label', { text: d.name }));
        el.style.setProperty('--c', d.color || 'var(--brass)');
        el.addEventListener('click', () => app.select(q, { focus: true }));
        arrows.appendChild(el);
        arrowEls.set(key, el);
      }
      const cx = cw / 2, cy = ch / 2;
      const dx = s.sx - cx, dy = s.sy - cy;
      const k = Math.min((cw / 2 - m) / Math.max(1e-6, Math.abs(dx)), (ch / 2 - m) / Math.max(1e-6, Math.abs(dy)));
      const ax = cx + dx * k, ay = cy + dy * k;
      el.style.transform = `translate(${Math.round(ax)}px, ${Math.round(ay)}px)`;
      el.style.setProperty('--a', Math.atan2(dy, dx) + 'rad');
      const tiles = Math.hypot(dx, dy) / Math.max(1e-6, r.camera.zoom);
      el.title = `${el.getAttribute('aria-label').replace(', off the map', '')} · ${F.int(tiles * 20)} km`;
    }
    for (const [key, el] of arrowEls) if (!keep.has(key)) { el.remove(); arrowEls.delete(key); }
  }
  requestAnimationFrame(arrowsFrame);

  // ---------------------------------------------------------------------------
  // Registry: keys, title actions, commands, search

  registerKey({ key: '.', label: 'Watch or unwatch the selection', group: 'Watch', when: (a) => Boolean(a.selection), run: (a) => toggleWatch(a.selection) });
  registerKey({ key: 'b', label: 'Pin this view', group: 'Watch', run: () => pinView() });
  for (let n = 1; n <= MAX_PINS; n++) registerKey({ code: 'Digit' + n, shift: true, label: n === 1 ? 'Fly to a pinned view' : `Fly to pinned view ${n}`, display: n === 1 ? 'Shift 1–9' : undefined, hidden: n > 1, group: 'Watch', run: () => gotoPin(n) });

  registerTitleAction('*', {
    id: 'story.watch', icon: 'star', label: 'Watch (.)', order: 20,
    when: (a, sel) => sel && sel.kind !== 'tile',
    pressed: (a, sel) => isWatched(sel),
    run: (a, sel) => toggleWatch(sel),
  });
  registerTitleAction('*', {
    id: 'story.follow', icon: 'eye', label: 'Follow: keep it framed', order: 21,
    when: (a, sel) => sel && FOLLOW_KINDS.has(sel.kind),
    pressed: (a, sel) => a.isFollowing(sel),
    run: (a, sel) => a.setFollow(a.isFollowing(sel) ? null : sel),
  });
  registerTitleAction('civ', {
    id: 'story.patron', icon: 'crown', label: 'Watch over this people', order: 22,
    pressed: (a, sel) => a.world?.ui?.patron === sel.id,
    run: (a, sel) => setPatron(sel.id),
  });

  registerCommand({ id: 'watch.toggle', label: 'Watch or unwatch the selection', group: 'Watch', icon: 'star', keys: '.', keywords: ['star', 'favourite', 'follow news'], when: (a) => Boolean(a.selection && a.selection.kind !== 'tile'), run: (a) => toggleWatch(a.selection) });
  registerCommand({ id: 'watch.pin', label: 'Pin this view', group: 'Watch', icon: 'pin', keys: 'B', keywords: ['bookmark', 'save view'], when: (a) => Boolean(a.world), run: () => pinView() });
  registerCommand({ id: 'watch.pins', label: 'Pinned views…', group: 'Watch', icon: 'pin', keywords: ['bookmarks', 'views'], menu: 'Watch', when: (a) => Boolean(a.world), run: () => openPins() });
  registerCommand({ id: 'watch.follow', label: 'Follow the selection', group: 'Watch', icon: 'eye', keywords: ['track', 'camera'], when: (a) => Boolean(a.selection && a.selection.kind !== 'tile'), run: (a) => a.setFollow(a.selection) });
  registerCommand({ id: 'watch.unfollow', label: 'Stop following', group: 'Watch', icon: 'eye', when: (a) => Boolean(a.follow), run: (a) => { a.follow = null; } });
  registerCommand({ id: 'watch.frame', label: 'Frame the selection', group: 'Watch', icon: 'fit', keys: 'Z', when: (a) => Boolean(a.selection), run: (a) => a.frameSelection() });
  registerCommand({ id: 'watch.patron', label: 'Watch over the selected people', group: 'Watch', icon: 'crown', keywords: ['patron', 'adopt', 'my people', 'saga'], when: (a) => a.selection?.kind === 'civ', run: (a) => setPatron(a.selection.id) });
  registerCommand({ id: 'watch.saga', label: 'Your people’s saga', group: 'Watch', icon: 'crown', keywords: ['patron', 'story', 'history'], menu: 'Watch', when: (a) => a.world?.ui?.patron != null, run: () => openSaga() });

  registerSearchSource({
    id: 'story.pins', label: 'Pinned views',
    search(a, q) {
      const w = a.world;
      if (!w || !w.ui.pins.length) return [];
      const n = q.trim().toLowerCase();
      return w.ui.pins.filter((p) => !n || p.name.toLowerCase().includes(n) || String(p.n) === n).map((p) => ({
        kind: 'pin', id: p.n, label: p.name, sub: `Pinned view ${p.n} · Shift ${p.n}`, icon: 'pin', score: n ? 40 : 10, run: () => gotoPin(p.n),
      }));
    },
  });

  // ---------------------------------------------------------------------------
  // Wiring

  app.on('world', (w) => {
    lastSeq = w.chronicle.seq;
    if (app.restoring) { stripSig = ''; render(); return; }
    recount();
    lastCapital = new Map();
    elegyShownFor = null;
    stripSig = '';
    render();
  });
  app.on('worldRestored', () => { stripSig = ''; render(); });
  app.on('tick', () => { if (!app.world) return; scanNews(); watchPatron(); render(); });
  app.on('select', (sel) => { if (sel) { markSeen(sel); update(); } });
  app.on('follow', () => update());
  app.on('pinView', () => pinView());
  app.on('layout', () => setTimeout(place, 40));
  strip.hidden = true;
}

function ordinal(n) {
  const words = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth'];
  if (n < words.length) return words[n];
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
