// The Annals — the Annals tab (key R). Four leaves:
//   Almanac    every war, plague, faith, eruption, quake, storm, fire, other catastrophe,
//              great figure, wonder, trade road, dynasty, treasure, people, fallen nation, historic site and
//              roaming band that ever was: searchable, sortable (recent, oldest, toll, length,
//              size) and filtered (living or ended); every row opens its record
//   Records    the Hall of Records: the superlatives of this world as cards — holder, value,
//              year, runners-up, and a sparkline of the record being broken over time
//   Centuries  one line per century; each opens its digest card (./digest.js)
//   Stream     the Histomap of empires (./histomap.js)
// Built from world state only when it changes (≤ 4 Hz while visible); the index is a plain list
// rebuilt at most once a sim-year.

import { DAYS_PER_YEAR } from '../core/constants.js';
import { SITE_KINDS } from '../core/sites.js';
import { h, clear, debounce, setText, svgEl } from './dom.js';
import { tip, openPopover, closePopover } from './widgets.js';
import { glyph } from './icons.js';
import * as F from './format.js';
import { fitCanvas, chartTheme } from './charts.js';
import { registerTab, registerIcon } from './registry.js';
import { getPref, setPref } from './prefs.js';
import { getRecords, RECORD_GROUPS, recordsBroken } from '../sim/records.js';
import { EVENT_TYPES } from '../sim/catalogue.js';
import { siteTitle, siteSub, SITE_ICON, icon16, dynastyName } from './inspector.js';
import { digest, openDigest } from './digest.js';
import { createHistomap } from './histomap.js';

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const yearOf = (day) => Math.floor(fin(day) / DAYS_PER_YEAR);

const CATS = [
  ['wars', 'Wars', 'war'], ['plagues', 'Plagues', 'plague'], ['faiths', 'Faiths', 'faith'],
  ['eruptions', 'Eruptions', 'volcano'], ['quakes', 'Quakes', 'quake'], ['storms', 'Storms', 'storm'],
  ['fires', 'Fires', 'wildfire'], ['disasters', 'Other catastrophes', 'flood'], ['figures', 'Great people', 'star'],
  ['wonders', 'Wonders', 'wonder'], ['routes', 'Trade roads', 'trade'], ['dynasties', 'Dynasties', 'crown'], ['treasures', 'Treasures', 'star'], ['peoples', 'Peoples', 'people'],
  ['fallen', 'Fallen nations', 'nations'], ['sites', 'Ruins and sites', 'ruin'], ['bands', 'Bands', 'army'],
];
const SORTS = [['recent', 'Most recent'], ['oldest', 'Oldest first'], ['toll', 'Greatest toll'], ['long', 'Longest'], ['size', 'Greatest']];
const EV_ICON = { quake: 'quake', tsunami: 'tsunami', eruption: 'volcano', impact: 'meteor', flood: 'flood', storm: 'storm', fire: 'wildfire', famine: 'drought', locusts: 'locusts' };

// a bound book with a laurel ribbon, on icons.js's 24-unit grid
const ANNALS_ICON = '<path d="M5 4.5h10.5a3 3 0 0 1 3 3v12H8a3 3 0 0 1-3-3z"/><path d="M5 16.5a3 3 0 0 1 3-3h10.5"/><path d="M9 7.5h6M9 10h4"/><path d="M12 19.5v2.5l1.2-1 1.2 1v-2.5"/>';

// ---------------------------------------------------------------------------
// the Almanac index

function evTitle(e) { return e.n ? F.headName(e.n) : `${EVENT_TYPES[e.t]?.label || F.humanize(e.t)} of Year ${yearOf(e.d)}`; }
function evMag(e) {
  switch (e.t) {
    case 'quake': return 'M' + fin(e.m).toFixed(1);
    case 'eruption': return 'VEI ' + Math.round(e.m);
    case 'impact': return F.km(e.m * 2) + ' crater';
    case 'storm': return e.m > 0 ? `Category ${Math.round(e.m)}` : F.humanize(e.k || 'storm');
    case 'fire': return F.areaShort(e.m);
    case 'famine': return e.mo ? `${e.mo} months` : 'Famine';
    default: return EVENT_TYPES[e.t]?.label || F.humanize(e.t);
  }
}

/** Every record of the world as almanac rows. Pure. */
export function almanacIndex(w) {
  const out = [];
  const day = w.time.day;
  const civ = (id) => w.civs[id];
  const push = (it) => { it.q = (it.label + ' ' + (it.sub || '')).toLowerCase(); out.push(it); };
  for (const q of w.wars) {
    if (!q) continue;
    const toll = Object.values(q.casualties || {}).reduce((a, v) => a + fin(v), 0);
    push({ cat: 'wars', icon: 'war', label: F.headName(q.name), sub: `${civ(q.attackers[0])?.name || 'Raiders'} against ${civ(q.defenders[0])?.name || 'their foes'} · ${F.lifespan(q.startDay, q.active ? null : q.endDay)}`, n: toll ? F.people(toll) + ' dead' : `${F.int(q.battles || 0)} battles`, toll, size: fin(q.battles), start: q.startDay, end: q.active ? day : q.endDay, live: q.active, sel: { kind: 'war', id: q.id } });
  }
  for (const p of w.plagues) {
    if (!p) continue;
    push({ cat: 'plagues', icon: 'plague', label: F.headName(p.name), sub: `${F.lifespan(p.startDay, p.active ? null : p.endDay)} · ${F.int(p.hit || 0)} towns`, n: F.people(p.deaths) + ' dead', toll: fin(p.deaths), size: fin(p.hit), start: p.startDay, end: p.active ? day : p.endDay, live: p.active, sel: { kind: 'plague', id: p.id } });
  }
  for (const r of w.religions) {
    if (!r) continue;
    push({ cat: 'faiths', icon: 'faith', swatch: r.colorHex, label: F.headName(r.name), sub: `${r.parentId != null ? 'Schism of ' + (w.religions[r.parentId]?.name || 'an older faith') : 'Founded'} · ${F.lifespan(r.foundedDay, r.alive === false ? r.endDay : null)}`, n: r.alive === false ? 'died out' : F.people(r.followers), toll: 0, size: fin(r.peakFollowers, fin(r.followers)), start: r.foundedDay, end: r.alive === false ? r.endDay : day, live: r.alive !== false, sel: { kind: 'religion', id: r.id } });
  }
  for (const e of w.history?.events || []) {
    const cat = e.t === 'eruption' ? 'eruptions' : e.t === 'quake' ? 'quakes' : e.t === 'storm' ? 'storms' : e.t === 'fire' ? 'fires' : 'disasters';
    const sel = e.t === 'storm' && e.sid != null ? { kind: 'storm', id: e.sid } : e.t === 'fire' && e.ref ? { kind: 'fire', id: e.ref.id } : { kind: 'event', id: e.id };
    const towns = (e.towns || []).map((sid) => w.settlements[sid]?.name).filter(Boolean);
    push({ cat, icon: EV_ICON[e.t] || 'volcano', label: evTitle(e), sub: `${evMag(e)} · ${F.monthYear(e.d)}${towns.length ? ' · ' + F.listing(towns, 2) : ''}`, n: e.dead ? F.people(e.dead) + ' dead' : evMag(e), toll: fin(e.dead), size: fin(e.m), start: e.d, end: e.d, live: false, sel });
  }
  for (const s of w.storms) if (s.name && s.kind === 'cyclone') push({ cat: 'storms', icon: 'storm', label: F.headName(s.name), sub: `${F.stormClass(s.kind, s.category)} · raging now`, n: s.deaths ? F.people(s.deaths) + ' dead' : 'at sea', toll: fin(s.deaths), size: fin(s.category), start: fin(s.startDay, day), end: day, live: true, sel: { kind: 'storm', id: s.id } });
  for (const f of w.fires || []) if (f.name && f.active) push({ cat: 'fires', icon: 'wildfire', label: F.headName(f.name), sub: `Burning since ${F.monthYear(f.startDay)}`, n: F.areaShort(f.tiles), toll: 0, size: fin(f.tiles), start: f.startDay, end: day, live: true, sel: { kind: 'fire', id: f.id } });
  for (const f of w.figures) {
    if (!f) continue;
    const c = civ(f.civId);
    push({ cat: 'figures', icon: { general: 'war', prophet: 'prophet', scholar: 'enlighten', merchant: 'prosper', explorer: 'ship', artist: 'miracle', hero: 'star' }[f.kind] || 'star', label: f.name || 'Unknown', sub: `${F.headName(f.kind || 'figure')}${c ? ' of ' + c.name : ''} · ${f.born != null ? 'Y' + yearOf(f.born) : '?'}–${f.died != null ? 'Y' + yearOf(f.died) : ''}`, n: (f.deeds || []).length ? `${(f.deeds || []).length} deeds` : '', toll: 0, size: (f.deeds || []).length, start: fin(f.born, 0), end: f.died ?? day, live: f.died == null, sel: { kind: 'figure', id: f.id } });
  }
  for (const q of w.wonders) {
    if (!q) continue;
    push({ cat: 'wonders', icon: 'wonder', label: F.headName(q.name), sub: `${F.humanize(q.kind || 'wonder')} at ${w.settlements[q.sid]?.name || 'a lost city'} · ${F.year(q.builtDay)}`, n: q.destroyedDay != null ? 'ruined' : 'standing', toll: 0, size: 1, start: q.builtDay, end: q.destroyedDay ?? day, live: q.destroyedDay == null, sel: { kind: 'wonder', id: q.id } });
  }
  const routes = w.tradeRoutes.filter(Boolean);
  const topRoutes = new Set(routes.slice().sort((a, b) => fin(b.peakValue, b.value) - fin(a.peakValue, a.value)).slice(0, 60).map((r) => r.id));
  for (const rt of routes) {
    if (!rt.name && !topRoutes.has(rt.id)) continue;
    const a = w.settlements[rt.aId], b = w.settlements[rt.bId];
    push({ cat: 'routes', icon: rt.kind === 'sea' ? 'ship' : 'trade', label: rt.name ? F.headName(rt.name) : `${a?.name || '?'} to ${b?.name || '?'}`, sub: `${rt.kind === 'sea' ? 'Sea lane' : 'Road'} · ${F.lifespan(rt.establishedDay, rt.active ? null : rt.endDay)}`, n: F.num(fin(rt.peakValue, rt.value), 1) + '/mo', toll: 0, size: fin(rt.peakValue, rt.value), start: rt.establishedDay, end: rt.active ? day : rt.endDay, live: rt.active, sel: { kind: 'route', id: rt.id } });
  }
  // dynasties: the civ ledger of houses when there is one, else runs of rulers by house
  const dyn = w.sys?.civ?.dynasties;
  if (Array.isArray(dyn) && dyn.length) {
    dyn.forEach((d, k) => { if (!d || !d.name) return; const c = civ(d.civId); push({ cat: 'dynasties', icon: 'crown', label: d.name, sub: `${c?.name || '—'} · ${F.lifespan(d.start, d.end)}`, n: `${F.int(Array.isArray(d.rulers) ? d.rulers.length : fin(d.rulers))} rulers`, toll: 0, size: fin(d.end, day) - fin(d.start), start: d.start, end: d.end ?? day, live: d.end == null, sel: { kind: 'dynasty', id: k } }); });
  }
  const seen = new Set(Array.isArray(dyn) ? dyn.filter(Boolean).map((d) => `${d.civId}:${d.name}`) : []);
  for (const c of w.civs) {
    if (!c) continue;
    const all = [...(c.rulerHistory || []), ...(c.ruler ? [c.ruler] : [])];
    const runs = new Map();
    for (const r of all) { const n = dynastyName(r.dynasty); if (!n) continue; const x = runs.get(n) || { n: 0, start: r.reignStart, end: r.reignEnd }; x.n++; x.start = Math.min(fin(x.start, Infinity), fin(r.reignStart, Infinity)); x.end = Math.max(fin(x.end, 0), fin(r.reignEnd ?? r.end, 0)); runs.set(n, x); }
    for (const [n, x] of runs) {
      if (seen.has(`${c.id}:${n}`) || x.n < 2) continue;
      const living = c.alive && dynastyName(c.ruler?.dynasty) === n;
      push({ cat: 'dynasties', icon: 'crown', label: n, sub: `${c.name} · ${F.lifespan(x.start, living ? null : x.end)}`, n: `${x.n} rulers`, toll: 0, size: (living ? day : x.end) - x.start, start: x.start, end: living ? day : x.end, live: living, sel: { kind: 'dynasty', id: `${c.id}:${n}` } });
    }
  }
  // the peoples of a Historical world (sim/geo/folk.js)
  for (const p of w.sys?.civ?.folk?.p || []) {
    push({ cat: 'peoples', icon: 'people', label: F.headName(p.name), sub: `A people since Y${yearOf(p.born)}${p.gone != null ? ` · gone Y${yearOf(p.gone)}` : ''}`, n: p.peak ? F.people(p.peak) + ' at most' : '', toll: 0, size: fin(p.peak), start: p.born, end: p.gone ?? day, live: p.gone == null, sel: { kind: 'folk', id: 'f:' + p.id } });
  }
  // named treasures (sim/civ/treasures.js): where each is now
  for (const t of w.sys?.civ?.art?.t || []) {
    const at = t.at || {};
    const holder = at.k === 'civ' ? civ(at.id)?.name : at.k === 'fig' ? 'borne by a hero' : at.k === 'faith' ? 'kept by its faith' : at.k === 'exile' ? 'in exile' : 'lost';
    push({ cat: 'treasures', icon: 'star', label: F.headName(t.n), sub: `${F.humanize(t.k)} · made Y${yearOf(t.made)}`, n: holder || '—', toll: 0, size: (t.h || []).length, start: t.made, end: day, live: at.k !== 'lost', sel: { kind: 'treasure', id: t.id } });
  }
  for (const c of w.civs) {
    if (!c || c.alive) continue;
    push({ cat: 'fallen', icon: 'nations', swatch: c.colorHex, label: c.name, sub: `${F.lifespan(c.foundedDay, c.fallenDay)} · ${F.humanize(c.fallCause || 'collapse')}`, n: F.people(c.peakPopulation) + ' at peak', toll: 0, size: fin(c.peakPopulation), start: c.foundedDay, end: c.fallenDay, live: false, sel: { kind: 'civ', id: c.id } });
  }
  for (const s of w.sites) {
    push({ cat: 'sites', icon: SITE_ICON[s.kind] || 'pin', label: siteTitle(w, s), sub: siteSub(w, s), n: s.dead > 0 ? F.people(s.dead) + ' dead' : SITE_KINDS[s.kind]?.label || '', toll: fin(s.dead), size: fin(s.fame), start: s.firstDay, end: s.lastDay, live: false, sel: { kind: 'site', id: s.id } });
  }
  for (const b of w.bands || []) push({ cat: 'bands', icon: 'army', label: F.headName(b.name || F.humanize(b.kind)), sub: `${F.humanize(b.kind)} · roaming since ${F.year(b.createdDay)}`, n: b.raids ? `${b.raids} raids` : F.humanize(b.state || ''), toll: fin(b.kills), size: fin(b.strength) || fin(b.power), start: fin(b.createdDay), end: day, live: true, sel: { kind: 'band', id: b.id } });
  for (const b of w.sys?.bands?.archive || []) {
    if (!b || typeof b !== 'object') continue;
    push({ cat: 'bands', icon: 'army', label: F.headName(b.name || F.humanize(b.kind || 'band')), sub: `${F.humanize(b.kind || 'band')} · ${F.lifespan(b.createdDay ?? b.born ?? b.start, b.endDay ?? b.died ?? b.end)}${b.cause ? ' · ' + F.humanize(b.cause) : ''}`, n: b.raids ? `${b.raids} raids` : '', toll: fin(b.kills), size: fin(b.raids), start: fin(b.createdDay ?? b.born ?? b.start), end: fin(b.endDay ?? b.died ?? b.end), live: false, sel: b.id != null ? { kind: 'band', id: b.id } : null });
  }
  return out;
}

// ---------------------------------------------------------------------------

function almanacPane(app) {
  let cat = getPref('records.almanacCat', 'wars');
  let sort = getPref('records.almanacSort', 'recent');
  let live = 'all';
  let q = '';
  let limit = 120;
  const search = h('input.field', { id: 'almanac-search', type: 'search', placeholder: 'Search the almanac', autocomplete: 'off', 'aria-label': 'Search the almanac' });
  // what to list: one chooser the width of the pane, opening on every kind of record there is
  let counts = new Map();
  const pickIco = h('span.alm-ico');
  const pickName = h('span.alm-name');
  const pickCount = h('span.alm-count');
  const picker = h('button.alm-pick', { type: 'button', 'aria-haspopup': 'listbox', 'aria-label': 'What to list' }, pickIco, pickName, pickCount, svgEl(glyph('chevron', 14)));
  function syncPicker() {
    const [, label, icon] = CATS.find((c) => c[0] === cat) || CATS[0];
    clear(pickIco); pickIco.append(icon16(icon));
    setText(pickName, label);
    setText(pickCount, counts.get(cat) ? F.int(counts.get(cat)) : '');
  }
  picker.addEventListener('click', () => {
    // the list is as wide as the chooser (less the popover's padding and border)
    const menu = h('div.alm-list', { role: 'listbox', 'aria-label': 'What to list', style: { width: Math.max(200, picker.offsetWidth - 14) + 'px' } });
    for (const [k, label, icon] of CATS) {
      if (!counts.get(k) && k !== cat) continue;
      const b = h('button.menu-item', { type: 'button', role: 'option', 'aria-selected': String(k === cat), class: k === cat ? 'is-on' : '' },
        icon16(icon), h('span.t', { text: label }), h('span.hint', { text: counts.get(k) ? F.int(counts.get(k)) : '' }));
      b.addEventListener('click', () => { closePopover(); cat = k; setPref('records.almanacCat', k); syncPicker(); limit = 120; render(); picker.focus(); });
      menu.appendChild(b);
    }
    if (openPopover(picker, menu, { cls: 'menu alm-pop' })) setTimeout(() => menu.querySelector('.is-on')?.focus({ preventScroll: true }), 0);
  });
  syncPicker();
  const sortSel = h('select.field', { id: 'almanac-sort', 'aria-label': 'Sort by' }, SORTS.map(([k, label]) => h('option', { value: k, text: label, selected: k === sort ? true : null })));
  sortSel.addEventListener('change', () => { sort = sortSel.value; setPref('records.almanacSort', sort); limit = 120; render(); });
  const liveSeg = h('div.seg', { role: 'group', 'aria-label': 'Living or ended' });
  for (const [k, label] of [['all', 'All'], ['live', 'Living'], ['ended', 'Ended']]) {
    const b = h('button', { type: 'button', text: label, 'aria-pressed': String(k === live) });
    b.addEventListener('click', () => { live = k; for (const x of liveSeg.children) x.setAttribute('aria-pressed', String(x === b)); limit = 120; render(); });
    liveSeg.appendChild(b);
  }
  const count = h('span.chron-count');
  const list = h('div.list.almanac-list', { role: 'list' });
  const more = h('button.btn.btn-sm', { type: 'button', hidden: true });
  more.addEventListener('click', () => { limit += 200; render(); });
  search.addEventListener('input', debounce(() => { q = search.value.trim().toLowerCase(); limit = 120; render(); }, 160));
  const el = h('div.annals-pane', null,
    h('div.chron-search', null, icon16('search'), search), picker,
    h('div.almanac-filters', null, liveSeg, h('label.sr-only', { for: 'almanac-sort', text: 'Sort by' }), sortSel), count, list, more);
  let index = [], key = '';

  function refresh(force = false) {
    const w = app.world;
    if (!w) return;
    const k = `${yearOf(w.time.day)}:${w.wars.length}:${w.plagues.length}:${w.religions.length}:${(w.history?.events || []).length}:${w.figures.length}:${w.sites.length}:${w.civs.length}:${w.wonders.length}`;
    if (k === key && !force) return;
    key = k;
    index = almanacIndex(w);
    counts = new Map();
    for (const it of index) counts.set(it.cat, (counts.get(it.cat) || 0) + 1);
    syncPicker();
    render();
  }
  function render() {
    let items = index.filter((it) => it.cat === cat && (live === 'all' || (live === 'live' ? it.live : !it.live)) && (!q || it.q.includes(q)));
    const len = (it) => fin(it.end) - fin(it.start);
    const cmp = { recent: (a, b) => fin(b.start) - fin(a.start), oldest: (a, b) => fin(a.start) - fin(b.start), toll: (a, b) => b.toll - a.toll || b.size - a.size, long: (a, b) => len(b) - len(a), size: (a, b) => b.size - a.size || b.toll - a.toll }[sort];
    items.sort(cmp);
    setText(count, `${F.int(items.length)} ${CATS.find((c) => c[0] === cat)?.[1].toLowerCase() || 'records'}${q ? ` matching “${q}”` : ''}`);
    clear(list);
    if (!items.length) list.appendChild(h('p.empty-note', { text: q ? 'Nothing matches.' : 'Nothing of this kind has happened yet.' }));
    for (const it of items.slice(0, limit)) {
      const row = h('button.row', { type: 'button', role: 'listitem', class: it.live ? 'is-live' : '' },
        it.swatch ? h('i.swatch', { style: { '--c': it.swatch } }) : icon16(it.icon), h('span.t', { text: it.label }), h('span.n', { text: it.n || '' }), h('span.s', { text: it.sub || '' }));
      if (it.sel) row.addEventListener('click', () => app.select(it.sel, { focus: true }));
      else row.disabled = true;
      list.appendChild(row);
    }
    more.hidden = items.length <= limit;
    more.textContent = `Show ${F.int(Math.min(200, items.length - limit))} more`;
  }
  return { el, refresh };
}

// ---------------------------------------------------------------------------
// the Hall of Records

function breakSpark(canvas, br, color) {
  const W = canvas.clientWidth || 120, H = 26;
  const ctx = fitCanvas(canvas, W, H);
  const t = chartTheme();
  if (br.length < 2) return;
  const d0 = br[0][0], d1 = Math.max(d0 + 1, br[br.length - 1][0]);
  let lo = Infinity, hi = -Infinity;
  for (const [, v] of br) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (hi - lo < 1e-9) hi = lo + 1;
  const X = (d) => 2 + ((d - d0) / (d1 - d0)) * (W - 4), Y = (v) => H - 3 - ((v - lo) / (hi - lo)) * (H - 6);
  ctx.beginPath();
  br.forEach(([d, v], k) => { const x = X(d), y = Y(v); if (!k) ctx.moveTo(x, y); else { ctx.lineTo(x, Y(br[k - 1][1])); ctx.lineTo(x, y); } });
  ctx.lineWidth = 1.5; ctx.strokeStyle = color || t.brass; ctx.stroke();
  for (const [d, v] of br) { ctx.beginPath(); ctx.arc(X(d), Y(v), 2, 0, Math.PI * 2); ctx.fillStyle = color || t.brass; ctx.fill(); }
}

function recordsPane(app) {
  const el = h('div.annals-pane.hall');
  const intro = h('p.ins-lead', { text: 'The greatest of everything this world has seen. When a record falls the Chronicle remembers it; the line under each card traces how the record grew.' });
  const lately = h('div.list.hall-lately');
  const latelySec = h('section.ins-section', null, h('h4.rule-head', { text: 'Lately broken' }), lately);
  const grid = h('div.hall-groups');
  el.append(intro, latelySec, grid);
  let key = '';
  const open = (t) => {
    if (t.r && t.r.k) app.select({ kind: t.r.k, id: t.r.id }, { focus: true });
    else if (Number.isFinite(t.x)) app.focus(t.x, t.y, 12);
  };
  function refresh() {
    const w = app.world;
    if (!w) return;
    const recs = getRecords(w);
    const k = recs.map((r) => `${r.top.length}:${r.top[0]?.v}:${r.br.length}`).join('|') + ':' + yearOf(w.time.day);
    if (k === key) return;
    key = k;
    // the five most recent falls, newest first, each opening the record's present holder
    clear(lately);
    const br = recordsBroken(w, 0, w.time.day).slice(-5).reverse();
    latelySec.hidden = !br.length;
    for (const x of br) {
      const rec = recs.find((r) => r.key === x.key);
      const t = rec?.top.find((q) => q.l === x.holder) || null;
      const row = h('button.row', { type: 'button' }, icon16('star'), h('span.t', { text: `${x.label}: ${F.headName(x.holder)}` }), h('span.n', { text: F.recordValue(x.fmt, x.v, '') }), h('span.s', { text: `Year ${yearOf(x.day)}` }));
      if (t) row.addEventListener('click', () => open(t)); else row.disabled = true;
      lately.appendChild(row);
    }
    clear(grid);
    for (const g of RECORD_GROUPS) {
      const cards = h('div.hall-cards');
      for (const r of recs.filter((q) => q.group === g.id)) {
        const t = r.top[0];
        const card = h('article.rec-card', { class: t ? '' : 'is-empty' }, h('h5', { text: r.label }));
        if (!t) { card.appendChild(h('p.empty-note', { text: 'Not yet set.' })); cards.appendChild(card); continue; }
        const civ = t.c != null ? w.civs[t.c] : null;
        const holder = h('button.rec-holder', { type: 'button' }, h('span.rv', { text: F.recordValue(r.fmt, t.s ?? t.v, r.unit) }), h('span.rl', { text: F.headName(t.l) }));
        if (civ) holder.style.setProperty('--c', civ.colorHex);
        holder.addEventListener('click', () => open(t));
        tip(holder, `Set in Year ${yearOf(t.d)}. Click to open its record.`);
        card.appendChild(holder);
        card.appendChild(h('div.rec-when', { text: `Year ${yearOf(t.d)}${civ ? ' · ' + civ.name : ''}` }));
        if (r.top.length > 1) {
          const ol = h('ol.rec-runners', { start: '2' });
          for (const x of r.top.slice(1)) {
            const b = h('button.link.rn', { type: 'button', text: F.headName(x.l) });
            b.addEventListener('click', () => open(x));
            tip(b, `${F.headName(x.l)}, Year ${yearOf(x.d)}`);
            ol.appendChild(h('li', null, b, h('span.rv2', { text: F.recordValue(r.fmt, x.s ?? x.v, '') })));
          }
          card.appendChild(ol);
        }
        if (r.br.length >= 2) {
          const cv = h('canvas.rec-spark', { 'aria-label': `${r.label} broken ${r.br.length === 1 ? 'once' : r.br.length + ' times'}` });
          card.appendChild(cv);
          card.appendChild(h('div.rec-when', { text: `Broken ${r.br.length} times since Year ${yearOf(r.br[0][0])}` }));
          requestAnimationFrame(() => breakSpark(cv, r.br, civ?.colorHex));
        }
        cards.appendChild(card);
      }
      grid.append(h('h4.rule-head', { text: g.label }), cards);
    }
  }
  return { el, refresh, invalidate: () => { key = ''; } };
}

// ---------------------------------------------------------------------------
// the centuries

function centuriesPane(app) {
  const el = h('div.annals-pane');
  const list = h('div.list');
  el.append(h('p.ins-lead', { text: 'Every century, told in brief. Open one for its full review, with the borders before and after.' }), list);
  let key = '';
  const cache = new Map();
  function refresh() {
    const w = app.world;
    if (!w) return;
    const y = yearOf(w.time.day);
    const k = `${Math.floor(y / 100)}:${w.history?.years?.length}`;
    if (k === key) return;
    key = k;
    clear(list);
    const last = Math.floor(y / 100);
    for (let c = last; c >= 0; c--) {
      const from = c * 100, to = Math.min(y, from + 100);
      if (to <= from && c > 0) continue;
      const ck = `${c}:${to}`;
      let head = cache.get(ck);
      if (!head) { try { const d = digest(w, from * DAYS_PER_YEAR, to * DAYS_PER_YEAR); head = d.headline.join(' ') || 'A quiet age.'; } catch (e) { head = ''; } cache.set(ck, head); }
      const row = h('button.row', { type: 'button' }, icon16('chronicle'), h('span.t', { text: `The ${F.ordinal(c + 1)} century${to < from + 100 ? ' (so far)' : ''}` }), h('span.n', { text: `Y${from}–Y${to}` }), h('span.s', { text: head }));
      row.addEventListener('click', () => openDigest(app, from * DAYS_PER_YEAR, to * DAYS_PER_YEAR));
      list.appendChild(row);
    }
  }
  return { el, refresh, reset: () => { cache.clear(); key = ''; } };
}

// ---------------------------------------------------------------------------

export function mount(app) {
  registerIcon('annals', ANNALS_ICON);
  registerTab({
    id: 'annals', label: 'Annals', key: 'R', icon: 'annals', order: 45,
    desc: 'The Almanac of everything that ever was, the Hall of Records, the centuries in review and the stream of empires.',
    mount(app2, el) {
      const leaves = [['almanac', 'Almanac'], ['records', 'Records'], ['centuries', 'Centuries'], ['stream', 'Stream']];
      let leaf = getPref('records.annalsLeaf', 'almanac');
      if (!leaves.some((l) => l[0] === leaf)) leaf = 'almanac';
      const seg = h('div.seg.annals-nav', { role: 'tablist', 'aria-label': 'Annals' });
      const almanac = almanacPane(app2), hall = recordsPane(app2), cents = centuriesPane(app2), stream = createHistomap(app2);
      const panes = { almanac: almanac.el, records: hall.el, centuries: cents.el, stream: h('div.annals-pane', null, stream.el) };
      const refreshers = { almanac: () => almanac.refresh(), records: () => hall.refresh(), centuries: () => cents.refresh(), stream: () => stream.update() };
      for (const [k, label] of leaves) {
        const b = h('button', { type: 'button', role: 'tab', text: label, 'aria-selected': String(k === leaf), 'aria-pressed': String(k === leaf) });
        b.addEventListener('click', () => { leaf = k; setPref('records.annalsLeaf', k); sync(); refreshers[leaf](); });
        seg.appendChild(b);
      }
      function sync() {
        for (const b of seg.children) { const on = b.textContent === leaves.find((l) => l[0] === leaf)[1]; b.setAttribute('aria-selected', String(on)); b.setAttribute('aria-pressed', String(on)); }
        for (const [k, p] of Object.entries(panes)) p.hidden = k !== leaf;
      }
      el.classList.add('annals');
      el.append(seg, ...Object.values(panes));
      sync();
      app2.on('world', () => { cents.reset(); hall.invalidate(); });
      return {
        show() { if (app2.world) refreshers[leaf](); },
        update() { if (app2.world) refreshers[leaf](); },
      };
    },
  });
}
