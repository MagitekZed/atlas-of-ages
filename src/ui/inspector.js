// The Inspector: the full record of whatever is selected, humanised, charted and updated in
// place. Views: tile · settlement · civ · army · war · religion · plague · storm · volcano,
// plus a welcome page. Every number has a past (a MiniChart over the entity's ledger), every
// name links to its own record, and Back walks the selection history. A settlement reads as a
// dossier: its character, chain of title and story; a war as a campaign: score and casualties
// over time, every battle, the towns that changed hands, the terms of peace and a theatre map.
// Other packages extend it through src/ui/registry.js: registerView for new selection kinds
// (the Inspector draws the title bar, the view fills the rest), registerSection for extra
// sections on any record, registerTitleAction for extra title-bar buttons. WP6's own record
// views (route, figure, ruler, dynasty, wonder, fire, site, continent, event, compare) live in
// ./views/records.js and build from the blocks exported here.

import { WATER, DAYS_PER_YEAR, RACE_META, RACE_KEYS } from '../core/constants.js';
import { elevationMeters, seasonName, dateString } from '../core/world.js';
import { liveCivs, liveSettlements, civSettlements, areAtWar, nearestSettlement } from '../core/entities.js';
import { sitesNear, SITE_KINDS } from '../core/sites.js';
import { NB, NC, cohortSummary, isSet, ratesOf } from '../core/cohorts.js';
import { NJ, TRADE_LABELS } from '../sim/civ/jobs.js';
import { h, clear, svgEl, svgNode, setText, Binder } from './dom.js';
import { glyph, iconEl } from './icons.js';
import { tip } from './widgets.js';
import * as F from './format.js';
import { MiniChart } from './charts.js';
import { powerOf } from '../sim/stats.js';
import { ownerChain } from '../sim/ledger.js';
import { stormRecord, placeName } from '../sim/catalogue.js';
import { getRecords } from '../sim/records.js';
import { focusEntry } from './toasts.js';
import { getPref } from './prefs.js';
import { getView, sectionsFor, titleActionsFor, onRegistryChange } from './registry.js';
import { temperBlock, strongestBands, article } from './temper.js';

let techMod = null;
try { techMod = await import('../sim/civ/tech.js'); } catch (e) { /* tech table unavailable: show raw keys */ }
let religionMod = null;
try { religionMod = await import('../sim/geo/religion.js'); } catch (e) { /* doctrine labels unavailable */ }
let plateMod = null;
try { plateMod = await import('./plate.js'); } catch (e) { /* no theatre maps */ }

const SETTLEMENT_KEYS = new Set('id name civId originCivId alive x y i foundedDay destroyedDay destroyCause population peakPopulation tier food foodProd foodNeed wealth production tradeIncome housing health happiness unrest loyalty culture defense garrison buildings religion dominantReligion disease immunity coastal harbor siege famine radius flags race effects effectsV traits epithet legend hist own'.split(' '));
const CIV_KEYS = new Set('id alive name baseName adjective language hue color colorHex foundedDay fallenDay fallCause parentId originX originY capitalId settlementIds government ruler rulerHistory dynasty traits tech mods treasury taxRate income expenses stability legitimacy warWeariness prestige military relations allies vassalOf stateReligion goldenAge darkAge population territory wealth peakPopulation peakTerritory flags race effects effectsV style claims temperLog'.split(' '));
const ARMY_KEYS = new Set('id civId warId x y homeId targetId strength morale supply path pathStep state naval general createdDay flags'.split(' '));

const ok = Number.isFinite;
const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const yearOf = (day) => Math.floor(fin(day) / DAYS_PER_YEAR);
/** Developer records (raw flags) are hidden unless the viewer asks for them. */
export const devRecords = () => Boolean(getPref('records.dev', false));

let cur = null;                  // { app, sel, b } while a record is being built
const MISSING = new WeakSet();   // "not in the record" notes take no registered sections
const failed = new Set();        // registered parts already reported as failing
function reportOnce(app, where, e) { if (!failed.has(where)) { failed.add(where); app.reportError(where, e); } }

// ---------------------------------------------------------------------------
// building blocks (exported for ./views/records.js, the Annals and the digest)

export function section(title, ...children) {
  return h('section.ins-section', null, h('h4.rule-head', { text: title }), ...children);
}

/** Key/value rows. item: { k, v: () => text, m: () => 0..1, mc, hide: () => bool, ref: () => ({key, make}) } */
export function kv(b, items) {
  const dl = h('dl.kv');
  for (const it of items) {
    if (!it) continue;
    const dt = h('dt', { text: it.k });
    if (it.tip) tip(dt, it.tip);
    const dd = h('dd', { class: it.ref || it.txt ? 'txt' : '' });
    if (it.ref) b.list(dd, () => [it.ref()], (r) => r.key, (r) => r.make());
    else b.text(dd, it.v);
    if (!it.m) {
      dl.append(dt, dd);
      if (it.hide) { b.hide(dt, it.hide); b.hide(dd, it.hide); }
      continue;
    }
    // a measure reads on one line: its label, its graduated scale with the index at the value,
    // and the value, which turns vermilion when the measure is in a bad way
    const m = h('div.meter', { class: it.mc || '' });
    const row = h('div.gauge-row', { class: it.mc || '' }, dt, m, dd);
    dl.append(row);
    b.meter(m, it.m);
    b.toggle(row, 'is-alarm', () => gaugeAlarm(it.mc, it.m()));
    if (it.hide) b.hide(row, it.hide);
  }
  return dl;
}

/** Is a measure in a bad way? Danger measures (unrest, sickness) when high; the rest when low. */
function gaugeAlarm(mc, v) {
  if (!Number.isFinite(v)) return false;
  if (mc === 'is-danger') return v >= 0.4;
  if (mc === 'is-teal') return false;
  return v < 0.3;
}

/**
 * The siege gauge (Instrument Maker's dial): a half circle graduated 0 to 100 with the progress
 * hatched in vermilion and a needle at it, the figure beside it, then who besieges and with what.
 */
function siegeGauge(app, b, s) {
  const w = app.world;
  const R = 46;
  const svg = svgNode('svg', { class: 'siege-dial', viewBox: '-58 -54 116 66', width: 150, height: 85, 'aria-hidden': 'true' });
  const pt = (f, r) => [-Math.cos(f * Math.PI) * r, -Math.sin(f * Math.PI) * r];
  const arcD = (f0, f1, r) => { const [x0, y0] = pt(f0, r), [x1, y1] = pt(f1, r); return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`; };
  svg.appendChild(svgNode('path', { class: 'sd-rim', d: arcD(0, 1, R) }));
  let ticks = '';
  for (let k = 0; k <= 20; k++) {
    const f = k / 20, [x0, y0] = pt(f, R - (k % 10 === 0 ? 9 : k % 2 === 0 ? 6 : 4)), [x1, y1] = pt(f, R - 1.5);
    ticks += `M${x0.toFixed(2)} ${y0.toFixed(2)}L${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }
  svg.appendChild(svgNode('path', { class: 'sd-ticks', d: ticks }));
  const done = svgNode('path', { class: 'sd-done' });
  const needle = svgNode('path', { class: 'sd-needle' });
  svg.append(done, needle, svgNode('circle', { class: 'sd-hub', r: 3.2 }));
  for (const [f, t] of [[0, '0'], [1, '100']]) {
    const [x, y] = pt(f, R + 0.5);
    svg.appendChild(Object.assign(svgNode('text', { class: 'sd-lab', x: x.toFixed(1), y: (y + 9).toFixed(1), 'text-anchor': 'middle' }), { textContent: t }));
  }
  const pct = h('span.siege-pct');
  const army = () => w.armies.find((q) => q.id === s.siege?.armyId) || null;
  const by = h('div.siege-by');
  b.list(by, () => [civRef(app, s.siege?.civId)], (r) => r.key, (r) => r.make());
  const host = h('p.siege-host');
  b.text(host, () => {
    const a = army();
    if (!a) return s.siege?.startDay != null ? `Since ${F.year(s.siege.startDay)}` : '';
    const g = generalName(w, a.general);
    return `${g !== '—' ? `${g}’s host` : 'The host'}, ${F.people(a.strength)} strong · supply ${F.pct(a.supply)}`;
  });
  b.run(() => {
    const p = Math.max(0, Math.min(1, s.siege?.progress || 0));
    done.setAttribute('d', p > 0.001 ? arcD(0, p, R - 4) : '');
    const [x, y] = pt(p, R - 12);
    needle.setAttribute('d', `M0 0L${x.toFixed(2)} ${y.toFixed(2)}`);
    setText(pct, `${Math.round(p * 100)}%`);
  });
  const sec = section('Siege', h('div.siege', null, svg, h('div.siege-fig', null, pct, h('span.siege-k', { text: 'Done' }))), by, host);
  b.hide(sec, () => !s.siege);
  return sec;
}

/** Chain of title as one bar: each holder's tenure a segment in its colour, oldest first. */
function titleBar(app, b, s) {
  const w = app.world;
  const bar = h('div.title-bar', { role: 'img' });
  const note = h('p.title-note');
  b.list(bar, () => {
    const chain = ownerChain(w, s.id);
    const end = s.alive ? w.time.day : (s.destroyedDay ?? w.time.day);
    return chain.map((o, k) => ({ o, len: Math.max(1, (chain[k + 1]?.day ?? end) - o.day), k }));
  }, (it) => `${it.o.day}:${it.o.civId}:${it.len > 3600 ? Math.round(it.len / 3600) : 0}`, ({ o, len }) => {
    const c = w.civs[o.civId];
    const seg = h('span.title-seg', { style: { flexGrow: String(len), background: c?.colorHex || 'var(--ink-4)' } });
    tip(seg, `${c?.name || 'A forgotten people'}: ${F.ownHow(o.code)} ${F.year(o.day)}`);
    return seg;
  });
  b.text(note, () => {
    const chain = ownerChain(w, s.id), last = chain[chain.length - 1];
    const c = last ? w.civs[last.civId] : null;
    const taken = chain.filter((o) => o.code !== 'f').length;
    const hs = s.hist || {};
    return `${c ? c.name : 'Unheld'} since ${F.year(last?.day ?? s.foundedDay)} · ${chain.length} ${chain.length === 1 ? 'holder' : 'holders'}${hs.sieges ? ` · sieges ${F.int(hs.sieges)}` : ''}${taken ? `, taken ${F.int(taken)}` : ''}`;
  });
  b.attr(bar, 'aria-label', () => `${ownerChain(w, s.id).length} holders`);
  return h('div.title-chain', null, bar, note);
}

export function cells(b, items) {
  const box = h('div.kv-3');
  for (const it of items) {
    const v = h('span.v'), s = h('span.s');
    box.appendChild(h('div.cell', null, h('span.k', { text: it.k }), v, s));
    b.text(v, it.v);
    if (it.s) b.text(s, it.s); else s.remove();
  }
  return box;
}

export function linkBtn(app, sel, label, { swatch = null, strike = false, tipText = '' } = {}) {
  const b = h('button.link', { type: 'button' }, swatch ? h('i.swatch', { style: { '--c': swatch, marginRight: '6px', verticalAlign: '-1px' } }) : null, label);
  if (strike) b.style.textDecorationLine = 'line-through';
  if (tipText) { b.setAttribute('aria-label', String(label)); tip(b, tipText); }
  b.addEventListener('click', (e) => { e.stopPropagation(); app.select(sel, { focus: true }); });
  return b;
}
export const textNode = (t) => h('span', { text: t });

export function civRef(app, id) {
  const c = id != null && id >= 0 ? app.world.civs[id] : null;
  return { key: c ? `c${id}:${c.name}:${c.alive}` : 'none', make: () => (c ? linkBtn(app, { kind: 'civ', id: c.id }, c.name, { swatch: c.colorHex }) : textNode('—')) };
}
export function settleRef(app, id) {
  const s = id != null && id >= 0 ? app.world.settlements[id] : null;
  return { key: s ? `s${id}:${s.name}:${s.alive}` : 'none', make: () => (s ? linkBtn(app, { kind: 'settlement', id: s.id }, s.name + (s.alive ? '' : ' (ruins)')) : textNode('—')) };
}
export function religionRef(app, id) {
  const r = id != null && id >= 0 ? app.world.religions[id] : null;
  return { key: r ? `r${id}:${r.name}` : 'none', make: () => (r ? linkBtn(app, { kind: 'religion', id: r.id }, F.headName(r.name), { swatch: r.colorHex || colorOf(r.color) }) : textNode('Folk beliefs')) };
}
export function figureRef(app, id) {
  const f = id != null ? app.world.figures.find((q) => q.id === id) : null;
  return { key: f ? `f${id}:${f.died}` : 'none', make: () => (f ? linkBtn(app, { kind: 'figure', id: f.id }, f.name) : textNode('—')) };
}
export const colorOf = (c) => (Array.isArray(c) ? `rgb(${c[0]},${c[1]},${c[2]})` : typeof c === 'string' ? c : 'var(--brass)');

/** A link for a chronicle ref { k, id } (or a selection), labelled. */
export function refLink(app, ref, label, opts = {}) {
  if (!ref || ref.k == null) return textNode(label);
  return linkBtn(app, { kind: ref.k, id: ref.id }, label, opts);
}

function title(b, { icon, color, name, sub, subNode, actions = [] }) {
  const emb = h('span.emblem', { class: color ? 'civ' : '', style: color ? { '--c': color } : null });
  if (!color) emb.appendChild(iconEl(icon, { size: 24 }));
  const h3 = h('h3');
  // names like "the Red Death" read mid-sentence elsewhere; as a heading they start with a capital
  b.text(h3, () => F.headName(name()));
  const subEl = h('div.sub');
  if (subNode) b.list(subEl, () => [subNode()], (r) => r.key, (r) => r.make());
  else b.text(subEl, sub);
  return h('div.ins-title', { class: actions.length > 3 ? 'is-crowded' : '' }, emb, h3, h('div.actions', null, ...actions), subEl);
}

function actionBtn(icon, label, fn, pressed = null) {
  const b = h('button.icon-btn', { type: 'button', 'aria-label': label }, svgEl(glyph(icon, 18)));
  tip(b, label);
  if (pressed != null) b.setAttribute('aria-pressed', String(pressed));
  b.addEventListener('click', () => fn(b));
  return b;
}

function standardActions(app, { follow = false } = {}) {
  const sel = app.selection;
  const list = [actionBtn('target', 'Show on the map', () => app.focusSelection())];
  if (follow) {
    const on = app.isFollowing(sel);
    const btn = actionBtn('eye', 'Follow it as it moves', (b) => {
      app.follow = app.isFollowing(sel) || !sel ? null : { kind: sel.kind, id: sel.id };
      const now = app.isFollowing(sel);
      b.classList.toggle('is-on', now);
      b.setAttribute('aria-pressed', String(now));
      if (now) app.focusSelection();
    }, on);
    if (on) btn.classList.add('is-on');
    list.push(btn);
  }
  if (sel) list.push(...registeredActions(app, sel));
  list.push(actionBtn('close', 'Clear the selection', () => app.select(null)));
  return list;
}

/** Title-bar buttons other packages registered for this kind (registerTitleAction). */
function registeredActions(app, sel) {
  const out = [];
  for (const def of titleActionsFor(sel.kind)) {
    if (typeof def.when === 'function') { let show = false; try { show = def.when(app, sel); } catch (e) { reportOnce(app, `titleAction.${def.id}.when`, e); } if (!show) continue; }
    const b = h('button.icon-btn', { type: 'button', 'aria-label': def.label }, iconEl(def.icon, { size: 18, label: def.label }));
    tip(b, def.label);
    b.addEventListener('click', () => { try { def.run(app, sel, b); } catch (e) { app.reportError(`titleAction.${def.id}`, e); } });
    if (typeof def.pressed === 'function' && cur?.b) {
      const pressed = () => { try { return Boolean(def.pressed(app, sel)); } catch (e) { return false; } };
      cur.b.attr(b, 'aria-pressed', () => String(pressed()));
      cur.b.toggle(b, 'is-on', pressed);
    }
    out.push(b);
  }
  return out;
}

/** Shares as labelled bars: items [{ key, label, color, value 0..1, text, sel? }] */
export function shareBars(b, itemsFn, app = null) {
  const box = h('div.bars');
  b.list(box, itemsFn, (it) => `${it.key}:${Math.round(it.value * 200)}:${it.text}`, (it) => {
    const frag = document.createDocumentFragment();
    const m = h('div.meter', { style: { '--mc': it.color } });
    m.style.setProperty('--v', (Math.max(0, Math.min(1, it.value)) * 100).toFixed(1) + '%');
    const label = it.sel && app ? linkBtn(app, it.sel, it.label) : h('b', { text: it.label });
    frag.append(h('span.l', null, it.color ? h('i.swatch', { style: { '--c': it.color } }) : null, label), m, h('span.r', { text: it.text }));
    return frag;
  });
  return box;
}

/** Does a chronicle entry concern { kind, id }? By its ref first; old entries by their fields or text. */
export function entryAbout(e, kind, id, fallback = null) {
  if (e.ref) { if (e.ref.k === kind && e.ref.id === id) return true; }
  if (kind === 'settlement' && e.sid === id) return true;
  if (kind === 'civ' && e.civId === id && (!e.ref || e.ref.k !== 'civ' || e.ref.id === id)) return true;
  return fallback ? Boolean(fallback(e)) : false;
}

export function chronicleList(app, b, filterFn, limit = 12) {
  const box = h('div');
  let lastSeq = -1, cached = null;
  b.list(box, () => {
    const w = app.world;
    if (w.chronicle.seq === lastSeq && cached) return cached;
    lastSeq = w.chronicle.seq;
    const out = [];
    const es = w.chronicle.entries;
    for (let k = es.length - 1; k >= 0 && out.length < limit; k--) if (filterFn(es[k])) out.push(es[k]);
    cached = out.length ? out : [{ seq: -1 }];
    return cached;
  }, (e) => e.seq, (e) => {
    if (e.seq < 0) return h('p.empty-note', { text: 'Nothing recorded yet.' });
    const row = h('div.ins-entry', { role: 'button', tabindex: '0', style: { cursor: 'pointer' } },
      h('span.y', { text: 'Y' + F.yearOfDay(e.day) }), h('span', { text: e.text }));
    row.addEventListener('click', () => focusEntry(app, e, { openTab: false }));
    row.addEventListener('dblclick', () => { app.setTab('chronicle'); app.emit('chronicleScrollTo', e.seq); });
    row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); focusEntry(app, e, { openTab: false }); } });
    tip(row, 'Click to show it on the map; double-click to read it in the Chronicle.');
    return row;
  });
  return box;
}

function otherRecords(b, obj, known) {
  const det = h('details.more');
  const sum = h('summary', { text: 'Developer records' });
  const dl = h('dl.kv');
  det.append(sum, dl);
  b.hide(det, () => !devRecords());
  b.list(dl, () => {
    if (!devRecords()) return [];
    const out = [];
    for (const [k, v] of Object.entries(obj())) {
      if (known.has(k)) continue;
      if (typeof v === 'number') out.push([k, Number.isInteger(v) ? F.int(v) : Math.abs(v) <= 1 ? v.toFixed(3) : F.num(v, 2)]);
      else if (typeof v === 'boolean') out.push([k, v ? 'Yes' : 'No']);
      else if (typeof v === 'string' && v.length < 80) out.push([k, v]);
      else if (Array.isArray(v) && v.length <= 6 && v.every((q) => typeof q === 'number' || typeof q === 'string')) out.push([k, v.join(', ') || '—']);
    }
    const flags = obj().flags;
    if (flags && typeof flags === 'object') for (const [k, v] of Object.entries(flags)) {
      if (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length < 60)) out.push(['flag: ' + k, typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v)]);
    }
    sum.textContent = `Developer records (${out.length})`;
    return out;
  }, ([k, v]) => k + '=' + v, ([k, v]) => {
    const frag = document.createDocumentFragment();
    frag.append(h('dt', { text: k }), h('dd', { text: v }));
    return frag;
  });
  return det;
}

/** A 16 px glyph, falling back to a star for keys the icon set lacks. */
export const icon16 = (key) => svgEl(glyph(key || 'star', 16) || glyph('star', 16));

/** Plain list rows: items() → [{ key, icon, label | node, n, s, sel?, run? }] */
export function rows(b, itemsFn, empty = 'Nothing recorded.', app = null) {
  const box = h('div.list');
  b.list(box, () => { const r = itemsFn(); return r.length ? r : [null]; }, (it) => (it ? it.key : 'none'), (it) => {
    if (!it) return h('p.empty-note', { text: empty });
    const lbl = it.node || h('span.t', { text: it.label });
    const kids = [it.swatch ? h('i.swatch', { style: { '--c': it.swatch } }) : icon16(it.icon), lbl, h('span.n', { text: it.n ?? '' })];
    if (it.s) kids.push(h('span.s', { text: it.s }));
    const tipped = (row) => { if (it.tip) { row.setAttribute('aria-label', [it.label, it.n, it.s].filter(Boolean).join(', ')); tip(row, it.tip); } return row; };
    if (it.sel || it.run) {
      const row = h('button.row', { type: 'button' }, ...kids);
      row.addEventListener('click', () => { if (it.run) it.run(); else app?.select(it.sel, { focus: true }); });
      return tipped(row);
    }
    return tipped(h('div.row', null, ...kids));
  });
  return box;
}

// ---------------------------------------------------------------------------
// ledger charts

const P = (v) => F.people(v), PCT = (v) => F.pct(v), INT = (v) => F.int(v), NUM = (v) => F.num(v, 1);
/** Channels shown per ledger kind: [key, label, fmt] in the order of sim/ledger.js CHANNELS. */
export const LEDGER_VIEW = {
  s: [['pop', 'People', P], ['wealth', 'Wealth', NUM], ['trade', 'Trade', (v) => F.num(v, 1) + '/mo'], ['health', 'Health', PCT], ['happiness', 'Happiness', PCT], ['unrest', 'Unrest', PCT], ['defense', 'Defence', NUM], ['culture', 'Culture', NUM]],
  c: [['pop', 'People', P], ['land', 'Lands', (v) => F.areaShort(v)], ['towns', 'Towns', INT], ['treasury', 'Treasury', NUM], ['stability', 'Stability', PCT], ['manpower', 'Manpower', P], ['era', 'Era', (v) => F.eraName(v)], ['army', 'Soldiers', P], ['wars', 'Wars', INT], ['prestige', 'Prestige', NUM]],
  r: [['followers', 'Faithful', P], ['towns', 'Towns', INT], ['nations', 'Nations', INT], ['fervor', 'Fervour', PCT]],
  w: [['score', 'War score', (v) => F.signed(v, 0)], ['casA', 'Attackers fallen', P], ['casD', 'Defenders fallen', P], ['occA', 'Held by attackers', INT], ['occD', 'Held by defenders', INT], ['menA', 'Attackers in the field', P], ['menD', 'Defenders in the field', P]],
  p: [['infected', 'Sick', P], ['towns', 'Towns', INT], ['deaths', 'Dead', P]],
  a: [['strength', 'Strength', P], ['morale', 'Morale', PCT], ['supply', 'Supply', PCT]],
  b: [['strength', 'Strength', P], ['hp', 'Vigour', PCT], ['morale', 'Morale', PCT], ['loot', 'Loot', INT]],
};

/**
 * A MiniChart over an entity's ledger series, refreshed when the series grows (its sample
 * count, gathering bucket or end change). opts: { color, initial,
 * marks: () => [{ day, color, label }], fallback: () => { days, rows } (old saves), zero,
 * channels: subset of keys, height, live: () => bool }.
 */
export function ledgerChart(app, b, kind, id, opts = {}) {
  const spec = LEDGER_VIEW[kind];
  const pick = opts.channels ? spec.filter((c) => opts.channels.includes(c[0])) : spec;
  const color = opts.color || null;
  const chart = new MiniChart({
    channels: pick.map(([key, label, fmt], k) => ({ key, label, fmt, color: k === 0 && color ? color : null })),
    height: opts.height || 72, prefKey: kind + (opts.prefSuffix || ''), initial: opts.initial || pick[0][0], zero: opts.zero,
    onPick: (day) => app.emit('timeTravel', yearOf(day)),
  });
  let last = null, lastMarks = -1, lastN = -1;
  b.run(() => {
    const w = app.world;
    const raw = w.history?.series?.[kind]?.[id] || null;
    const mk = opts.marks ? Math.floor(w.time.day / 90) : 0;
    const sig = raw ? `${raw.t0}:${raw.st}:${raw.v.length}:${raw.pn}:${raw.e}` : null;
    if (sig === last && mk === lastMarks && raw) return;
    last = sig; lastMarks = mk;
    let days = [], rowsOut = [];
    if (raw && Array.isArray(raw.v)) {
      const s = seriesRows(kind, raw);
      days = s.days; rowsOut = s.rows.map((r) => pick.map(([key]) => r[s.ch.indexOf(key)]));
    } else if (opts.fallback) {
      const f = opts.fallback();
      if (f) { days = f.days; rowsOut = f.rows; }
    }
    if (opts.window && days.length > 2) {
      // only the years asked for (a reign, say), with one sample either side for context
      const [a, z] = opts.window();
      let lo = 0, hi = days.length - 1;
      while (lo < days.length - 1 && days[lo + 1] <= a) lo++;
      while (hi > 0 && days[hi - 1] >= z) hi--;
      if (hi - lo >= 1) { days = days.slice(lo, hi + 1); rowsOut = rowsOut.slice(lo, hi + 1); }
    }
    if (days.length === lastN && !raw && !opts.marks) return;
    lastN = days.length;
    const live = opts.live ? opts.live() : raw ? raw.e == null : true;
    requestAnimationFrame(() => chart.setData({ days, rows: rowsOut, marks: opts.marks ? opts.marks() : [], live }));
  });
  return chart.el;
}

/** Rows of a stored series (the shape sim/ledger.js series() returns), in natural units. */
const SCALES = {
  s: [1, 1, 10, 100, 100, 100, 10, 10], c: [1, 1, 1, 1, 100, 1, 1, 1, 1, 10], r: [1, 1, 1, 100],
  w: [10, 1, 1, 1, 1, 1, 1], p: [1, 1, 1], a: [1, 100, 100, 10, 10], b: [1, 100, 100, 1, 10, 10],
};
const NAMES = {
  s: ['pop', 'wealth', 'trade', 'health', 'happiness', 'unrest', 'defense', 'culture'], c: ['pop', 'land', 'towns', 'treasury', 'stability', 'manpower', 'era', 'army', 'wars', 'prestige'],
  r: ['followers', 'towns', 'nations', 'fervor'], w: ['score', 'casA', 'casD', 'occA', 'occD', 'menA', 'menD'], p: ['infected', 'towns', 'deaths'],
  a: ['strength', 'morale', 'supply', 'x', 'y'], b: ['strength', 'hp', 'morale', 'loot', 'x', 'y'],
};
const AGG_AVG = { s: [1, 1, 1, 1, 1, 1, 1, 1], c: [1, 1, 1, 1, 1, 1, 0, 0, 0, 1], r: [1, 1, 0, 1], w: [1, 0, 0, 0, 0, 1, 1], p: [0, 0, 0], a: [1, 1, 1, 0, 0], b: [1, 1, 1, 0, 0, 0] };
function seriesRows(kind, raw) {
  const sc = SCALES[kind], C = sc.length, avg = AGG_AVG[kind];
  const days = [], out = [];
  const n = Math.floor(raw.v.length / C);
  for (let k = 0; k < n; k++) {
    const r = new Array(C);
    for (let j = 0; j < C; j++) r[j] = raw.v[k * C + j] / sc[j];
    days.push(raw.t0 + k * raw.st); out.push(r);
  }
  if (raw.pn > 0 && Array.isArray(raw.p)) {
    const r = new Array(C);
    for (let j = 0; j < C; j++) r[j] = (avg[j] ? raw.p[j] / raw.pn : raw.p[j]) / sc[j];
    days.push(raw.t0 + n * raw.st); out.push(r);
  }
  return { days, rows: out, ch: NAMES[kind] };
}

// ---------------------------------------------------------------------------
// tile

function terrainClass(e, sea) {
  if (e < sea) {
    const d = sea - e;
    return d > 0.25 ? 'Abyssal deep' : d > 0.08 ? 'Open ocean' : 'Continental shelf';
  }
  if (e >= 0.88) return 'High peaks';
  if (e >= 0.75) return 'Mountains';
  if (e >= 0.62) return 'Hills';
  return 'Lowland';
}

/** The continent feature (index in world.features) a tile stands on, or −1. */
export function continentAt(w, i) {
  const f = w.f;
  if (!f.landmass || f.landmass[i] < 0) return -1;
  for (let k = 0; k < w.features.length; k++) {
    const ft = w.features[k];
    if (ft.kind !== 'continent') continue;
    const fi = Math.round(ft.y) * w.W + Math.round(ft.x);
    if (fi >= 0 && fi < w.N && f.landmass[fi] === f.landmass[i]) return k;
  }
  return -1;
}

/** Historic sites near a point as list items (links to their records). */
export function siteItems(app, x, y, r = 2.5, limit = 8) {
  const w = app.world;
  return sitesNear(w, x, y, r).sort((a, b) => (b.fame || 0) - (a.fame || 0)).slice(0, limit).map((s) => ({
    key: `site${s.id}:${s.n}`, icon: SITE_ICON[s.kind] || 'pin', label: siteTitle(w, s),
    n: s.dead > 0 ? F.people(s.dead) + ' dead' : s.n > 1 ? `${s.n}×` : '', s: siteSub(w, s), sel: { kind: 'site', id: s.id },
  }));
}
export const SITE_ICON = { battle: 'war', siege: 'war', ruin: 'ruin', crater: 'meteor', eruption: 'volcano', quake: 'quake', wreck: 'ship', plaguepit: 'plague', treaty: 'harmony', holy: 'faith', grave: 'ruin', node: 'star', lair: 'predators' };
/** "the Siege of Mou", "Ancient Oskel", "the Peace of Ruhum" — a site's name for people. */
export function siteTitle(w, s) {
  const n = s.name;
  switch (s.kind) {
    case 'battle': { if (n) return `Battlefield of ${n}`; const p = placeName(w, s.x, s.y, { maxTown: 4 }); return p ? `The battlefield near ${p}` : 'A nameless battlefield'; }
    case 'siege': return n ? `The siege-ground of ${n}` : 'A siege-ground';
    case 'ruin': { const age = (w.time.day - fin(s.data?.fellDay, s.lastDay)) / DAYS_PER_YEAR; return n ? (age >= 300 ? `Ancient ${n}` : `The ruins of ${n}`) : 'Nameless ruins'; }
    case 'crater': return n ? `The ${n} crater` : 'A star-crater';
    case 'eruption': return n ? `The lava fields of ${n}` : 'A lava field';
    case 'quake': return n ? `The ${n} rift` : 'A great rift';
    case 'wreck': return n ? `The wrecks off ${n}` : 'Wrecks in the deep';
    case 'plaguepit': return n ? `The plague pits of ${n}` : 'Plague pits';
    case 'treaty': return n ? `The peace of ${n}` : 'A treaty ground';
    case 'holy': return n ? `The holy city of ${n}` : 'A holy place';
    default: return F.headName(n || SITE_KINDS[s.kind]?.label || 'A site');
  }
}
export function siteSub(w, s) {
  const kind = SITE_KINDS[s.kind]?.label || F.humanize(s.kind);
  const when = s.firstDay === s.lastDay || s.kind === 'ruin' ? F.year(s.kind === 'ruin' ? s.data?.fellDay ?? s.firstDay : s.firstDay) : `${F.year(s.firstDay)}–${yearOf(s.lastDay)}`;
  const extra = s.kind === 'battle' && s.n > 1 ? `${s.n} battles` : s.kind === 'ruin' && s.data?.peak ? `once ${F.people(s.data.peak)}` : s.kind === 'eruption' && s.data?.vei ? `VEI ${s.data.vei}` : s.kind === 'quake' && s.data?.mag ? `M${s.data.mag}` : '';
  return [kind, when, extra].filter(Boolean).join(' · ');
}

function tileView(app, sel, b) {
  const w = app.world, f = w.f;
  const i = sel.id, x = i % w.W, y = (i / w.W) | 0;
  const isWater = () => f.water[i] !== WATER.LAND;
  const sea = () => w.climate?.seaLevel ?? 0.5;
  const ck = continentAt(w, i);
  const continent = ck >= 0 ? w.features[ck].name : null;
  let nearSea = null;
  let best = Infinity;
  for (const ft of w.features) {
    if (ft.kind !== 'ocean' && ft.kind !== 'sea') continue;
    const d = (ft.x - x) ** 2 + (ft.y - y) ** 2;
    if (d < best) { best = d; nearSea = ft.name; }
  }
  const lead = h('p.ins-lead');
  b.text(lead, () => {
    const o = f.owner[i] >= 0 ? w.civs[f.owner[i]] : null;
    const bi = F.biomeName(f.biome[i]);
    if (isWater()) return `${f.water[i] === WATER.LAKE ? 'A lake' : bi} ${F.int(-elevationMeters(w, i))} m deep${o ? `, in the waters of ${o.name}` : ''}.`;
    return `${bi}${continent ? ` on ${continent}` : ''}, ${F.int(elevationMeters(w, i))} m above the sea${o ? `, held by ${o.name}` : ', unclaimed'}.`;
  });
  const sites = rows(b, () => siteItems(app, x, y, 3), 'No battle, ruin or wonder of history is remembered here.', app);
  const siteSec = section('Remembered here', sites);
  b.hide(siteSec, () => sitesNear(w, x, y, 3).length === 0);

  return h('div.tabpanel', null,
    title(b, { icon: 'pin', name: () => (isWater() ? (f.water[i] === WATER.LAKE ? 'Lake' : F.biomeName(f.biome[i])) : F.biomeName(f.biome[i])), sub: () => `${F.latLon(w, x, y)} · tile ${x}, ${y}`, actions: standardActions(app) }),
    lead,
    siteSec,
    section('Ground', kv(b, [
      { k: 'Elevation', v: () => (isWater() ? 'Depth ' + F.meters(-elevationMeters(w, i)) : F.meters(elevationMeters(w, i))) },
      { k: 'Terrain', v: () => terrainClass(f.elevation[i], sea()) },
      { k: 'Water', v: () => (f.water[i] === WATER.OCEAN ? 'Ocean' : f.water[i] === WATER.LAKE ? 'Lake' : 'Dry land') },
      { k: 'Continent', ref: () => (ck >= 0 ? { key: 'ct' + ck, make: () => linkBtn(app, { kind: 'continent', id: ck }, continent) } : { key: 'none', make: () => textNode(isWater() ? '—' : 'An unnamed land') }), hide: () => isWater() },
      { k: 'Nearest named sea', v: () => nearSea || '—', hide: () => !isWater() || !nearSea },
      { k: 'River', v: () => F.riverName(f.river[i]), hide: () => isWater() },
      { k: 'Runoff gathered', v: () => F.num(f.flow[i], 1), hide: () => isWater() || f.flow[i] <= 0, tip: 'Rain-weighted catchment draining through this tile.' },
      { k: 'Coast', v: () => (f.coast[i] ? 'On the coast' : isWater() ? '—' : F.km(f.distCoast[i]) + ' inland') },
      { k: 'Tectonic plate', v: () => `No. ${f.plate[i] + 1}`, m: () => f.plateBoundary[i], mc: 'is-warn', tip: 'The bar shows stress near a plate boundary: quakes and volcanoes cluster where it is high.' },
      { k: 'Mineral richness', v: () => F.pct(f.mineral[i]), m: () => f.mineral[i], hide: () => isWater() },
      { k: 'Resource', v: () => (f.resource[i] ? `${F.resourceName(f.resource[i])} · ${F.pct(f.resourceAmt[i])} left` : 'None'), m: () => (f.resource[i] ? f.resourceAmt[i] : 0), mc: 'is-teal', hide: () => !f.resource[i] },
      { k: 'Soil fertility', v: () => F.pct(f.soil[i]), m: () => f.soil[i], mc: 'is-good', hide: () => isWater() },
    ])),
    section('Sky', kv(b, [
      { k: 'Temperature now', v: () => F.temp(f.temp[i]) },
      { k: 'Annual mean', v: () => F.temp(f.annTemp[i]) },
      { k: 'Season here', v: () => seasonName(w, y) },
      { k: 'Rainfall, annual', v: () => F.rain(f.annRain[i]) },
      { k: 'Rain now', v: () => F.rain(f.rain[i]) },
      { k: 'Soil moisture', v: () => F.pct(f.soilWater[i]), m: () => f.soilWater[i], mc: 'is-teal', hide: () => isWater() },
      { k: 'Humidity', v: () => F.pct(f.humidity[i]), m: () => f.humidity[i], mc: 'is-teal' },
      { k: 'Cloud cover', v: () => F.pct(f.cloud[i]), m: () => f.cloud[i] },
      { k: isWater() ? 'Sea ice' : 'Snow and ice', v: () => F.pct(f.snow[i]), m: () => f.snow[i] },
      { k: 'Wind', v: () => F.wind(f.windX[i], f.windY[i]).label },
    ])),
    section('Life', kv(b, [
      { k: 'Vegetation', v: () => `${F.pct(f.veg[i])} of ${F.pct(f.vegCap[i])} possible`, m: () => f.veg[i], mc: 'is-good', hide: () => isWater() },
      { k: 'Fire', v: () => (f.fire[i] > 0 ? 'Burning, ' + F.pct(f.fire[i]) : 'None'), m: () => f.fire[i], mc: 'is-danger', hide: () => isWater() },
      { k: 'Burn scar', v: () => F.pct(f.burnScar[i]), m: () => f.burnScar[i], hide: () => isWater() || f.burnScar[i] < 0.01 },
      { k: 'Grazing herds', v: () => F.pct(f.herb[i]), m: () => f.herb[i], mc: 'is-good', hide: () => isWater() },
      { k: 'Predators', v: () => F.pct(f.pred[i]), m: () => f.pred[i], mc: 'is-warn', hide: () => isWater() },
      { k: 'Fish', v: () => F.pct(f.fish[i]), m: () => f.fish[i], mc: 'is-teal', hide: () => !isWater() },
      { k: 'Biome', v: () => F.biomeName(f.biome[i]) },
    ])),
    section('People', kv(b, [
      { k: 'Nation', ref: () => civRef(app, f.owner[i]) },
      { k: 'Held from', ref: () => settleRef(app, f.ownerSettle[i]), hide: () => f.ownerSettle[i] < 0 },
      { k: 'Settlement here', ref: () => settleRef(app, f.settle[i]), hide: () => f.settle[i] < 0 },
      { k: 'Nearest settlement', ref: () => { const s = nearestSettlement(w, x, y, { maxDist: 12 }); return s ? { key: 'n' + s.id, make: () => h('span', null, linkBtn(app, { kind: 'settlement', id: s.id }, s.name), ` · ${F.km(Math.hypot(s.x - x, s.y - y))}`) } : { key: 'none', make: () => textNode('None within 240 km') }; }, hide: () => f.settle[i] >= 0 },
      { k: 'People living here', v: () => F.people(f.popDensity[i]), hide: () => isWater() },
      { k: 'Farmland', v: () => F.pct(f.farm[i]), m: () => f.farm[i], mc: 'is-good', hide: () => isWater() },
      { k: 'Road', v: () => F.roadName(f.road[i]), hide: () => isWater() },
      { k: 'Devastation', v: () => F.pct(f.devastation[i]), m: () => f.devastation[i], mc: 'is-danger' },
      { k: 'Pollution', v: () => F.pct(f.pollution[i]), m: () => f.pollution[i], mc: 'is-warn', hide: () => f.pollution[i] < 0.005 },
    ])),
  );
}

// ---------------------------------------------------------------------------
// settlement

const TRAIT_WORDS = { port: 'Port', market: 'Market town', mint: 'Mint', granary: 'Granary of the realm', fortress: 'Fortress', shrine: 'Shrine', 'sacred site': 'Sacred site', scholars: 'Seat of learning', mines: 'Mining town', forge: 'Forge-town', fishing: 'Fishing town', crossroads: 'Crossroads' };
const traitWord = (t) => TRAIT_WORDS[t] || F.humanize(t);

/** The story of a settlement in plain sentences, oldest first: [{ key, text, day?, sel? }]. */
function settlementStory(w, s) {
  const out = [];
  const chain = ownerChain(w, s.id);
  const civName = (id) => F.theCiv(w.civs[id]);
  for (const [k, o] of chain.entries()) {
    const c = w.civs[o.civId];
    let text;
    if (o.code === 'f') text = `Founded by ${c ? `${c.adjective} settlers of ${F.theCiv(c)}` : 'unknown hands'}.`;
    else if (o.code === 'x') text = `${s.destroyCause ? F.humanize(s.destroyCause) : 'Destroyed'}${c ? ` while held by ${F.theCiv(c)}` : ''}.`;
    else if (o.code === 'c') text = `Taken by ${civName(o.civId)}.`;
    else if (o.code === 'r') text = `Rose against its masters and went over to ${civName(o.civId)}.`;
    else if (o.code === 's') text = `Broke away to ${o.civId === s.civId ? 'stand with' : 'join'} ${civName(o.civId)}.`;
    else if (o.code === 't') text = `Ceded by treaty to ${civName(o.civId)}.`;
    else if (o.code === 'u') text = `Passed by union to ${civName(o.civId)}.`;
    else if (o.code === 'd') text = `Given by the gods to ${civName(o.civId)}.`;
    else text = `Passed to ${civName(o.civId)}.`;
    out.push({ key: 'o' + k + ':' + o.day, day: o.day, text, sel: c ? { kind: 'civ', id: c.id } : null });
  }
  const fl = s.flags || {};
  if (fl.wasCapital != null && w.civs[fl.wasCapital]) out.push({ key: 'cap', text: `Once the capital of ${F.theCiv(w.civs[fl.wasCapital])}.`, sel: { kind: 'civ', id: fl.wasCapital } });
  if (s.alive && ok(fl.maxTier) && fl.maxTier > (s.tier || 0)) out.push({ key: 'tier', text: `Was once a ${F.tierName(fl.maxTier).toLowerCase()}; it is a ${F.tierName(s.tier).toLowerCase()} now.` });
  const hs = s.hist || {};
  const endured = [['sieges', 'siege'], ['fires', 'great fire'], ['quakes', 'earthquake'], ['plagues', 'plague'], ['riots', 'riot']].filter(([k]) => hs[k] > 0).map(([k, n]) => `${hs[k] === 1 ? 'a' : F.int(hs[k])} ${n}${hs[k] === 1 ? '' : 's'}`);
  if (endured.length) out.push({ key: 'hist', text: `Endured ${F.listing(endured, 5)}.` });
  if (fl.plagueLoss > 0.05) out.push({ key: 'pl', text: `Its latest plague carried off ${F.pct(fl.plagueLoss)} of its people.` });
  // the famine count is of the famine still on; a ruin's is of the famine of its last days
  if (fl.famineDeaths > 0) out.push({ key: 'fam', text: s.alive ? `${F.people(fl.famineDeaths)} have starved in the present famine.` : `${F.people(fl.famineDeaths)} starved in the famine of its last days.` });
  if (ok(fl.lastSettler) && fl.lastSettler > 0) out.push({ key: 'set', day: fl.lastSettler, text: `Last sent out settlers in ${F.year(fl.lastSettler)}.` });
  return out;
}

/** Growth per year over the last n years from the ledger (a fraction), or null. */
function growthOf(w, kind, id, years = 10) {
  const raw = w.history?.series?.[kind]?.[id];
  if (!raw || !Array.isArray(raw.v)) return null;
  const s = seriesRows(kind, raw);
  const n = s.days.length;
  if (n < 2) return null;
  const end = s.rows[n - 1][0];
  let k = n - 2;
  while (k > 0 && s.days[n - 1] - s.days[k] < years * DAYS_PER_YEAR) k--;
  const yrs = (s.days[n - 1] - s.days[k]) / DAYS_PER_YEAR;
  const start = s.rows[k][0];
  if (!(start > 0) || !(yrs > 0)) return null;
  return Math.pow(end / start, 1 / yrs) - 1;
}

function settlementView(app, sel, b) {
  const w = app.world;
  const s = w.settlements[sel.id];
  if (!s) return missing('That settlement is not in the record.');
  const civ = () => w.civs[s.civId];
  const isCap = () => civ()?.capitalId === s.id;
  const tags = h('div.tags');
  b.list(tags, () => {
    const t = [];
    if (!s.alive) {
      // a dead town keeps its character, not the cares of its last day
      t.push(['Ruins', 'is-war']);
      for (const tr of s.traits || []) t.push([traitWord(tr), 'is-trait']);
      return t;
    }
    if (isCap()) t.push(['Capital', '']);
    for (const tr of s.traits || []) t.push([traitWord(tr), 'is-trait']);
    if (s.coastal) t.push(['Coastal', '']);
    if (s.harbor) t.push(['Harbour', 'is-good']);
    if (s.siege) t.push(['Under siege', 'is-war']);
    if (s.famine > 0) t.push([`Famine, ${s.famine} months`, 'is-warn']);
    if (s.disease) t.push(['Plague', 'is-war']);
    if (s.originCivId != null && s.originCivId !== s.civId) t.push([`Founded by ${w.civs[s.originCivId]?.adjective || 'another people'}`, '']);
    return t;
  }, (t) => t.join(':'), ([label, cls]) => h('span.tag', { class: cls, text: label }));

  const epithet = h('p.ins-epithet');
  b.text(epithet, () => (s.epithet ? `${s.name} ${s.epithet}` : ''));
  b.hide(epithet, () => !s.epithet);
  const legend = h('blockquote.ins-legend');
  b.text(legend, () => s.legend?.text || '');
  b.hide(legend, () => !s.legend?.text);

  const lead = h('p.ins-lead');
  b.text(lead, () => {
    const c = civ();
    if (!s.alive) return `${s.name} was ${s.destroyCause ? F.humanize(s.destroyCause).toLowerCase() : 'abandoned'} in ${F.year(s.destroyedDay)}, ${F.span((s.destroyedDay ?? w.time.day) - s.foundedDay)} after its founding. At its height it held ${F.people(s.peakPopulation)} people.`;
    const g = growthOf(w, 's', s.id, 10);
    const trend = g == null ? '' : g > 0.015 ? ', growing fast' : g > 0.003 ? ', growing' : g < -0.015 ? ', emptying' : g < -0.003 ? ', shrinking' : ', holding steady';
    return `A ${F.tierName(s.tier).toLowerCase()} of ${F.people(s.population)}${trend}${c ? `, ${isCap() ? 'capital' : 'part'} of ${F.theCiv(c)}` : ''}, founded in ${F.year(s.foundedDay)}.`;
  });

  const routeRows = rows(b, () => {
    const out = [];
    for (const r of w.tradeRoutes) if (r.active && (r.aId === s.id || r.bId === s.id)) out.push(r);
    out.sort((p, q) => (q.value || 0) - (p.value || 0));
    return out.slice(0, 12).map((r) => {
      const other = w.settlements[r.aId === s.id ? r.bId : r.aId];
      return { key: `${r.id}:${Math.round(r.value || 0)}`, icon: r.kind === 'sea' ? 'ship' : 'trade', label: r.name ? F.headName(r.name) : `To ${other?.name || 'a distant town'}`, n: F.num(r.value, 1) + '/mo', s: `${r.kind === 'sea' ? 'Sea lane' : 'Overland'}${r.name && other ? ' to ' + other.name : ''} · since ${F.year(r.establishedDay)}`, sel: { kind: 'route', id: r.id } };
    });
  }, 'No trade routes.', app);

  const buildings = h('div.tags');
  b.list(buildings, () => {
    const e = Object.entries(s.buildings || {}).filter(([, lv]) => lv > 0);
    return e.length ? e.sort((a, c) => c[1] - a[1]) : [['none', 0]];
  }, ([k, lv]) => k + lv, ([k, lv]) => (k === 'none' ? h('span.empty-note', { text: 'No buildings yet.' }) : h('span.tag', { text: `${F.humanize(k)}${lv > 1 ? ' · level ' + lv : ''}` })));

  const faith = shareBars(b, () => {
    const out = [];
    let sum = 0;
    for (const [rid, share] of Object.entries(s.religion || {})) {
      const r = w.religions[rid];
      if (!r || !(share > 0.004)) continue;
      sum += share;
      out.push({ key: rid, label: F.headName(r.name), color: r.colorHex || colorOf(r.color), value: share, text: F.pct(share), sel: { kind: 'religion', id: r.id } });
    }
    out.sort((a, c) => c.value - a.value);
    if (sum < 0.995) out.push({ key: 'folk', label: 'Folk beliefs', color: 'var(--ink-4)', value: 1 - sum, text: F.pct(1 - sum) });
    return out;
  }, app);

  const disease = kv(b, [
    { k: 'Outbreak', ref: () => { const p = s.disease ? w.plagues[s.disease.pid] : null; return p ? { key: 'p' + p.id, make: () => linkBtn(app, { kind: 'plague', id: p.id }, F.headName(p.name)) } : { key: 'none', make: () => textNode('None') }; } },
    { k: 'Sick', v: () => (s.disease ? sirText(s.disease.I, s.population) : '—'), m: () => (s.disease ? sirFrac(s.disease.I, s.population) : 0), mc: 'is-danger', hide: () => !s.disease },
    { k: 'Recovered', v: () => (s.disease ? sirText(s.disease.R, s.population) : '—'), m: () => (s.disease ? sirFrac(s.disease.R, s.population) : 0), mc: 'is-teal', hide: () => !s.disease },
    { k: 'Immunity', v: () => { const e = Object.entries(s.immunity || {}).filter(([, v]) => v > 0.01); return e.length ? e.map(([pid, v]) => `${F.headName(w.plagues[pid]?.name || 'Old plague')} ${F.pct(v)}`).join(', ') : 'None'; }, txt: true },
  ]);

  const siegeSec = siegeGauge(app, b, s);

  const wonders = rows(b, () => w.wonders.filter((q) => q.sid === s.id).map((q) => ({ key: q.id + ':' + q.destroyedDay, icon: 'wonder', label: F.headName(q.name), n: F.year(q.builtDay), s: `${F.humanize(q.kind || 'wonder')}${q.destroyedDay != null ? ' · destroyed ' + F.year(q.destroyedDay) : ''}`, sel: { kind: 'wonder', id: q.id } })), 'No wonders.', app);
  const wonderSec = section('Wonders', wonders);
  b.hide(wonderSec, () => !w.wonders.some((q) => q.sid === s.id));

  const people = rows(b, () => w.figures.filter((q) => q.sid === s.id).slice(-8).reverse().map((q) => figureItem(w, q)), 'No great people.', app);
  const figSec = section('Great people', people);
  b.hide(figSec, () => !w.figures.some((q) => q.sid === s.id));

  // chain of title
  const chain = rows(b, () => ownerChain(w, s.id).slice().reverse().map((o, k) => {
    const c = w.civs[o.civId];
    return { key: `${o.day}:${o.civId}:${o.code}:${k}`, swatch: c?.colorHex || 'var(--ink-4)', node: c ? linkBtn(app, { kind: 'civ', id: c.id }, c.name, { strike: !c.alive }) : textNode('A forgotten people'), n: F.year(o.day), s: F.ownHow(o.code) };
  }), 'Its holders are not recorded.', app);
  const story = rows(b, () => settlementStory(w, s).map((it) => ({ key: it.key + it.text, icon: it.key.startsWith('o') ? 'crown' : 'chronicle', label: it.text, n: it.day != null ? 'Y' + yearOf(it.day) : '', sel: it.sel })), 'An uneventful life, so far.', app);
  const near = rows(b, () => siteItems(app, s.x, s.y, 3.5), 'No battlefields or ruins nearby.', app);
  const nearSec = section('Remembered nearby', near);
  b.hide(nearSec, () => sitesNear(w, s.x, s.y, 3.5).filter((q) => !(q.kind === 'ruin' && q.data?.sid === s.id)).length === 0);

  const conquestMarks = () => ownerChain(w, s.id).filter((o) => o.code !== 'f').map((o) => ({ day: o.day, color: w.civs[o.civId]?.colorHex || 'var(--danger)', label: `${F.ownHow(o.code)}: ${w.civs[o.civId]?.name || '—'}` }));

  return h('div.tabpanel', null,
    title(b, { icon: s.alive ? 'town' : 'ruin', name: () => s.name, subNode: () => { const c = civ(); return { key: `${s.alive}:${s.tier}:${s.civId}:${c?.name}`, make: () => h('span', null, s.alive ? `${F.tierName(s.tier)} of ` : 'Ruins, last held by ', c ? linkBtn(app, { kind: 'civ', id: c.id }, c.name, { swatch: c.colorHex }) : 'no nation') }; }, actions: standardActions(app) }),
    epithet, tags, legend, lead,
    siegeSec,
    anchored(cells(b, s.alive ? [
      { k: 'People', v: () => F.people(s.population), s: () => 'peak ' + F.people(Math.max(s.peakPopulation || 0, s.population || 0)) },
      { k: 'Food', v: () => monthsOfFood(s), s: () => `${F.num(s.foodProd)} made, ${F.num(s.foodNeed)} eaten / mo` },
      { k: 'Age', v: () => F.span(w.time.day - s.foundedDay), s: () => 'since ' + F.year(s.foundedDay) },
    ] : [
      { k: 'At its height', v: () => F.people(s.peakPopulation), s: () => F.tierName(Math.max(s.tier || 0, s.flags?.maxTier || 0)) },
      { k: 'Fell', v: () => F.year(s.destroyedDay), s: () => F.humanize(s.destroyCause || 'abandoned') },
      { k: 'Lived', v: () => F.span((s.destroyedDay ?? w.time.day) - s.foundedDay), s: () => 'from ' + F.year(s.foundedDay) },
    ]), 'summary'),
    (() => {
      // the ruins themselves, where the land remembers them
      const box = h('div.tags');
      b.list(box, () => { const r = s.alive ? null : w.sites.find((q) => q.kind === 'ruin' && q.data?.sid === s.id); return r ? [r] : []; }, (r) => 'r' + r.id, (r) => h('span.tag.is-link', null, linkBtn(app, { kind: 'site', id: r.id }, siteTitle(w, r))));
      return box;
    })(),
    section('Its life', ledgerChart(app, b, 's', s.id, { marks: conquestMarks, color: civ()?.colorHex })),
    hideFor(b, () => !s.alive || !s.cohorts, section('People', agePyramid(app, b, s))),
    section('Chain of title', titleBar(app, b, s), chain),
    section('Story', story),
    // a ruin has no livelihood: its last day's cares are not shown as if they were today's
    hideFor(b, () => !s.alive, section('Livelihood', kv(b, [
      { k: 'Housing', v: () => F.people(s.housing), tip: 'How many people the town can shelter.' },
      { k: 'Health', v: () => F.pct(s.health), m: () => s.health, mc: 'is-good' },
      { k: 'Happiness', v: () => F.pct(s.happiness), m: () => s.happiness, mc: 'is-good' },
      { k: 'Unrest', v: () => F.pct(s.unrest), m: () => s.unrest, mc: 'is-danger' },
      { k: 'Loyalty', v: () => F.pct(s.loyalty), m: () => s.loyalty },
      { k: 'Culture', v: () => F.num(s.culture, 1) },
      { k: 'Growth', v: () => { const g = growthOf(w, 's', s.id, 10); return g == null ? '—' : F.signed(g * 100, 1, '% a year'); }, tip: 'Average yearly change in people over the last decade of the ledger.' },
      { k: 'Famine', v: () => (s.famine > 0 ? `${s.famine} months` : 'None') },
      { k: 'Food balance', v: () => F.signed((s.foodProd || 0) - (s.foodNeed || 0), 0) + ' / mo' },
    ]))),
    (() => {
      const sec = section('Wealth and works', kv(b, [
        { k: 'Wealth', v: () => F.money(s.wealth), hide: () => !s.alive },
        { k: 'Production', v: () => F.num(s.production, 1), hide: () => !s.alive },
        { k: 'Trade income', v: () => F.num(s.tradeIncome, 1) + ' / mo', hide: () => !s.alive },
        { k: 'Defence', v: () => F.num(s.defense, 1), hide: () => !s.alive },
        { k: 'Garrison', v: () => F.people(s.garrison), hide: () => !s.alive },
        { k: s.alive ? 'Lands worked' : 'Lands it worked', v: () => `${s.radius ?? 0} tiles around (${F.km(s.radius ?? 0)})` },
        { k: 'Location', v: () => F.latLon(w, s.x, s.y) },
      ]));
      // a ruin keeps only where it stood
      b.text(sec.firstChild, () => (s.alive ? 'Wealth and works' : 'Where it stood'));
      return sec;
    })(),
    section('Buildings', buildings),
    section('Faith', faith, kv(b, [{ k: 'Dominant faith', ref: () => religionRef(app, s.dominantReligion) }])),
    hideFor(b, () => !s.alive, section('Health', disease)),
    hideFor(b, () => !s.alive, section('Trade routes', routeRows)),
    wonderSec, figSec, nearSec,
    section('History', chronicleList(app, b, (e) => entryAbout(e, 'settlement', s.id))),
    otherRecords(b, () => s, SETTLEMENT_KEYS),
  );
}

// The town's people by age and sex (core/cohorts.js): a two-sided pyramid, men left and women
// right, the open 80+ band on top, redrawn once a month; the numbers beside it below.
const PYR_W = 300, PYR_ROW = 10, PYR_MID = 30, PYR_H = NB * PYR_ROW;
const raceRgb = (r) => { const m = RACE_META[r]; return m ? `rgb(${m.color.join(',')})` : 'var(--brass)'; };
function agePyramid(app, b, s) {
  const svg = svgNode('svg', { class: 'pyramid', viewBox: `0 0 ${PYR_W} ${PYR_H + 14}`, role: 'img', 'aria-label': 'Age pyramid' });
  const half = (PYR_W - PYR_MID) / 2;
  const bars = svgNode('g'), ages = svgNode('g');
  const lm = svgNode('text', { class: 'pyr-key', x: 0, y: PYR_H + 12 }); lm.textContent = 'Men';
  const lf = svgNode('text', { class: 'pyr-key', x: PYR_W, y: PYR_H + 12, 'text-anchor': 'end' }); lf.textContent = 'Women';
  svg.append(bars, ages, lm, lf);
  // in a Mythic town each people keeps its own bands, stages of its own life: the bars stack the
  // peoples in their colours, and the ages are the main people's
  const legend = h('div.pyr-peoples');
  let last = '';
  b.run(() => {
    const c = s.cohorts;
    const set = isSet(c);
    const key = c ? `${s.id}:${Math.floor(app.world.time.day / 30)}:${Math.round(s.population)}:${set ? Object.keys(c).join() : ''}:${s.race}` : 'none';
    if (key === last) return;
    last = key;
    clear(bars); clear(ages); clear(legend);
    const tabs = set ? RACE_KEYS.filter((r) => c[r]).map((r) => [r, c[r]]) : Array.isArray(c) && c.length === NC ? [[null, c]] : [];
    let top = 0;
    for (let k = 0; k < NC; k++) { let v = 0; for (const [, t] of tabs) v += t[k]; if (v > top) top = v; }
    for (let k = 0; k < NB; k++) {
      const y = PYR_H - (k + 1) * PYR_ROW + 1;
      let xm = half, xf = half + PYR_MID;
      for (const [r, t] of tabs) {
        const wm = top > 0 ? half * t[k] / top : 0, wf = top > 0 ? half * t[NB + k] / top : 0;
        xm -= wm;
        const m = svgNode('rect', { class: 'pyr-m', x: xm.toFixed(1), y, width: wm.toFixed(1), height: PYR_ROW - 2 });
        const f = svgNode('rect', { class: 'pyr-f', x: xf.toFixed(1), y, width: wf.toFixed(1), height: PYR_ROW - 2 });
        if (r) { m.style.fill = raceRgb(r); f.style.fill = raceRgb(r); f.style.opacity = '0.78'; }
        xf += wf;
        bars.append(m, f);
      }
    }
    const L = set ? ratesOf(app.world, s.race && c[s.race] ? s.race : tabs[0]?.[0]).life : 1;
    for (let k = 0; k < NB; k += 2) {
      const t = svgNode('text', { class: 'pyr-age', x: PYR_W / 2, y: PYR_H - (k + 1) * PYR_ROW + PYR_ROW - 2, 'text-anchor': 'middle' });
      t.textContent = k === NB - 1 ? `${Math.round(80 * L)}+` : String(Math.round(5 * k * L));
      ages.append(t);
    }
    if (set && tabs.length) {
      for (const [r] of tabs) legend.append(h('span.pyr-people', null, h('i.swatch', { style: { '--c': raceRgb(r) } }), RACE_META[r]?.plural || r));
      if (tabs.some(([r]) => ratesOf(app.world, r).life !== L)) legend.append(h('span.pyr-note', { text: `Ages are ${RACE_META[s.race]?.plural?.toLowerCase() || 'the main people'}’s; each people's bands are stages of its own life.` }));
    }
  });
  const sum = () => cohortSummary(s.cohorts, townEra(app, s), (r) => ratesOf(app.world, r).life);
  const share = (v) => { const t = sum(); return t.total > 0 ? `${F.people(t[v])} · ${F.pct(t[v] / t.total)}` : '—'; };
  const facts = kv(b, [
    { k: 'Median age', v: () => { const t = sum(); return t.total > 0 ? `${Math.round(t.median)} years` : '—'; } },
    { k: 'Children (under 15)', v: () => share('children'), tip: 'For a long-lived people, the first three stages of its life (an elf is a child until 75).' },
    { k: 'Elders (65 and over)', v: () => share('elders') },
    { k: 'Working hands', v: () => share('working'), tip: 'Ages 15 to 64; before the Medieval Age children of 10 to 14 and elders to 74 work half time too.' },
    { k: 'Men 15–44', v: () => F.people(sum().men), tip: 'Whom the levy calls up, and half of every marriage.' },
    { k: 'Women 15–44', v: () => F.people(sum().women), tip: 'The mothers of the next generation.' },
  ]);
  return h('div.pyramid-box', null, svg, legend, facts, tradesBar(app, b, s));
}

// The town's working hands by trade (sim/civ/jobs.js): one stacked bar, then each trade.
const TRADE_COLORS = ['var(--c-nature)', 'var(--brass-lo)', 'var(--info)', 'var(--ink-3)', 'var(--c-trade)', 'var(--brass)',
  'var(--c-war)', 'var(--c-faith)', 'var(--c-discovery)', 'var(--c-catastrophe)', 'var(--ink-4)',
  // the magical trades (Mythic towns): the Myth colour
  'var(--c-myth)', 'var(--c-myth)', 'var(--c-myth)', 'var(--c-myth)'];
function tradesBar(app, b, s) {
  const bar = h('div.trades-bar', { role: 'img', 'aria-label': 'Working hands by trade' });
  const segs = [];
  for (let t = 0; t < TRADE_COLORS.length; t++) { const g = h('span', { style: { background: TRADE_COLORS[t] } }); segs.push(g); bar.append(g); }
  let last = '';
  b.run(() => {
    const j = s.jobs;
    const key = Array.isArray(j) ? `${s.id}:${Math.floor(app.world.time.day / 30)}` : 'none';
    if (key === last) return;
    last = key;
    let tot = 0;
    const n = Array.isArray(j) ? j.length : 0;
    for (let t = 0; t < n; t++) tot += j[t];
    for (let t = 0; t < segs.length; t++) segs[t].style.flexGrow = tot > 0 && t < n ? String(j[t] / tot) : '0';
  });
  const list = h('div.trades');
  b.list(list, () => {
    const j = s.jobs;
    if (!Array.isArray(j)) return [];
    let tot = 0;
    for (let t = 0; t < j.length; t++) tot += j[t];
    const out = [];
    // the rare magical trades show from a handful of souls; the others from half a percent
    for (let t = 0; t < j.length; t++) if (tot > 0 && (t >= NJ ? j[t] >= 1 : j[t] / tot >= 0.005)) out.push({ t, n: j[t], share: j[t] / tot });
    return out;
  }, (it) => `${it.t}:${Math.round(it.n)}`, (it) => h('span.trade', null,
    h('i.swatch', { style: { '--c': TRADE_COLORS[it.t] } }), h('b', { text: TRADE_LABELS[it.t] }), h('span', { text: `${F.people(it.n)} · ${F.pct(it.share, it.share < 0.01 ? 1 : 0)}` })));
  return h('div.trades-box', null, h('h5.trades-head', { text: 'Trades' }), bar, list);
}
/** The era a town's working ages follow (its realm's). */
const townEra = (app, s) => app.world.civs[s.civId]?.tech?.era | 0;

/** A storm's age: tenths of a day while young, whole days and months after. */
function stormDays(d) {
  if (!(d >= 0)) return '—';
  if (d >= 2) return F.span(d);
  const t = Math.round(d * 10) / 10;
  return `${t} day${t === 1 ? '' : 's'}`;
}

/** Hide a built element while cond() holds (b.hide), and hand it back. */
function hideFor(b, cond, el) { b.hide(el, cond); return el; }

function monthsOfFood(s) {
  const need = s.foodNeed > 0 ? s.foodNeed : s.population;
  if (!(need > 0)) return '—';
  const m = (s.food || 0) / need;
  return m >= 24 ? `${F.int(m / 12)} yrs` : `${m.toFixed(m < 10 ? 1 : 0)} mo`;
}
const sirFrac = (v, pop) => (v <= 1 ? v : pop > 0 ? v / pop : 0);
const sirText = (v, pop) => (v <= 1 ? `${F.pct(v)} (${F.people(v * pop)})` : `${F.people(v)} (${F.pct(pop > 0 ? v / pop : 0)})`);

export const FIG_ICON = { prophet: 'prophet', general: 'war', scholar: 'enlighten', merchant: 'prosper', explorer: 'ship', artist: 'miracle', hero: 'star', ruler: 'crown' };
/** A great figure as a list item (links to the figure record). */
export function figureItem(w, q) {
  const life = `${q.born != null ? 'born ' + F.year(q.born) : ''}${q.died != null ? ' · died ' + F.year(q.died) : ''}`;
  const deeds = Array.isArray(q.deeds) && q.deeds.length ? q.deeds[q.deeds.length - 1] : '';
  return {
    key: q.id + ':' + q.died + ':' + (q.deeds?.length || 0), icon: FIG_ICON[q.kind] || 'star', label: q.name || 'Unknown', n: F.humanize(q.kind || 'figure'),
    s: [life.replace(/^ · /, ''), typeof deeds === 'string' ? deeds : ''].filter(Boolean).join(' · '), sel: { kind: 'figure', id: q.id },
  };
}

// ---------------------------------------------------------------------------
// civ

export function rulerName(r) {
  if (!r) return '—';
  if (typeof r === 'string') return r;
  if (r.display) return [r.display, r.epithet && !String(r.display).includes(r.epithet) ? r.epithet : ''].filter(Boolean).join(' ');
  const ROM = ['', '', ' II', ' III', ' IV', ' V', ' VI', ' VII', ' VIII', ' IX', ' X'];
  return [r.title, (r.name || '') + (r.regnal > 1 ? ROM[r.regnal] || ' ' + r.regnal : ''), r.epithet].filter(Boolean).join(' ');
}
/**
 * The meaning of a ruler's by-name when it is a word of the people's own tongue, for a tooltip:
 * '“Vashtor” means “the Cruel” in the Oskeli tongue.' Empty when the by-name needs no gloss.
 */
export function rulerGloss(r, civ = null) {
  if (!r || typeof r !== 'object' || !r.gloss || !r.epithet) return '';
  const adj = civ && civ.adjective ? String(civ.adjective) : '';
  return `“${r.epithet}” means “${r.gloss}” in ${adj ? `the ${adj}` : 'their own'} tongue.`;
}
export const dynastyName = (d) => (!d ? '' : typeof d === 'string' ? d : d.name || '');
/** The ruler record id the 'ruler' view understands: "civId:reignStart" (stable once archived), else the ruler's id. */
export const rulerId = (c, r) => (r && Number.isFinite(r.reignStart) ? `${c.id}:${r.reignStart}` : r?.id ?? `${c.id}:0`);

function techInfo(id) {
  const T = techMod?.TECHS;
  if (!T) return null;
  if (techMod.TECH_BY_ID) return techMod.TECH_BY_ID[id] || null;
  if (Array.isArray(T)) return T.find((t) => t.id === id || t.key === id) || null;
  return T[id] || null;
}
function techName(id) { return techInfo(id)?.name || F.humanize(id); }

/** The people of a realm: faiths, cultures, tiers, urbanisation (memoised per month). */
function peopleOf(w, c) {
  const key = `${c.id}:${Math.floor(w.time.day / 30)}:${w.versions.settlements}`;
  if (peopleOf.key === key) return peopleOf.val;
  const towns = civSettlements(w, c);
  let pop = 0, urban = 0, coastal = 0;
  const faith = new Map(), culture = new Map(), tiers = [0, 0, 0, 0, 0, 0, 0], tierPop = [0, 0, 0, 0, 0, 0, 0];
  for (const s of towns) {
    const p = fin(s.population);
    pop += p;
    const t = Math.max(0, Math.min(6, s.tier | 0));
    tiers[t]++; tierPop[t] += p;
    if (t >= 3) urban += p;
    if (s.coastal) coastal += p;
    let sum = 0;
    for (const [rid, sh] of Object.entries(s.religion || {})) { if (sh > 0) { faith.set(rid, (faith.get(rid) || 0) + sh * p); sum += sh; } }
    if (sum < 1) faith.set('folk', (faith.get('folk') || 0) + (1 - sum) * p);
    const o = s.originCivId ?? c.id;
    culture.set(o, (culture.get(o) || 0) + p);
  }
  const val = { pop, urban, coastal, faith, culture, tiers, tierPop, towns: towns.length };
  peopleOf.key = key; peopleOf.val = val;
  return val;
}

function civView(app, sel, b) {
  const w = app.world;
  const c = w.civs[sel.id];
  if (!c) return missing('That nation is not in the record.');
  const towns = () => civSettlements(w, c);
  const livePeople = () => (c.alive === false ? 0 : towns().reduce((a, s) => a + (s.population || 0), 0) || c.population || 0);
  const lead = h('p.ins-lead');
  b.text(lead, () => {
    const parent = c.parentId != null ? w.civs[c.parentId] : null;
    if (!c.alive) return `${F.TheCiv(c)} fell in ${F.year(c.fallenDay)} (${F.humanize(c.fallCause || 'collapse').toLowerCase()}) after ${F.span((c.fallenDay ?? w.time.day) - c.foundedDay)}. At its height it held ${F.people(c.peakPopulation)} people and ${F.area(c.peakTerritory)}.`;
    const gov = F.humanize(c.government || 'tribe').toLowerCase();
    const age = F.eraName(c.tech?.era);
    const since = parent ? `who broke away from ${F.theCiv(parent)} in ${F.year(c.foundedDay)}` : `first recorded in ${F.year(c.foundedDay)}`;
    const g = growthOf(w, 'c', c.id, 25);
    const trend = g == null ? '' : g > 0.01 ? ' Its people are multiplying.' : g < -0.01 ? ' Its people are dwindling.' : '';
    // its two strongest temperament bands: "a warlike, devout monarchy of the Iron Age"
    const what = [...strongestBands(c, 2), gov].join(', ').replace(/, ([^,]+)$/, ' $1');
    return `The ${c.adjective} people, ${since}: ${article(what)} ${what} of the ${age}.${trend}`;
  });
  const tags = h('div.tags');
  b.list(tags, () => {
    const t = [];
    if (!c.alive) t.push(['Fallen', 'is-war']);
    const wars = w.wars.filter((q) => q.active && (q.attackers.includes(c.id) || q.defenders.includes(c.id)));
    if (wars.length) t.push([wars.length === 1 ? 'At war' : `${wars.length} wars`, 'is-war']);
    if (c.goldenAge > 0) t.push(['Golden age', 'is-good']);
    if (c.darkAge > 0) t.push(['Dark age', 'is-warn']);
    if (c.vassalOf != null) t.push([`Vassal of ${w.civs[c.vassalOf]?.name || 'another'}`, '']);
    return t;
  }, (t) => t.join(':'), ([label, cls]) => h('span.tag', { class: cls, text: label }));

  // fallback for worlds saved before ledgers: the nation's itemised yearly records (gaps stay gaps)
  const civFallback = () => {
    const ys = w.history?.years || [];
    const days = [], out = [];
    for (const r of ys) {
      const v = r.civ && r.civ[c.id];
      if (!v) continue;
      days.push(r.y * DAYS_PER_YEAR);
      out.push([v[0], v[1], v[2], NaN, NaN, NaN, v[3], NaN, NaN, NaN]);
    }
    return { days, rows: out };
  };
  const warMarks = () => w.wars.filter((q) => q.attackers.includes(c.id) || q.defenders.includes(c.id)).map((q) => ({ day: q.startDay, color: 'var(--danger)', label: F.midName(q.name) }));

  const relations = h('div.list');
  b.list(relations, () => {
    const out = [];
    for (const [oid, r] of Object.entries(c.relations || {})) {
      const o = w.civs[oid];
      if (!o || !o.alive) continue;
      out.push({ o, r, war: areAtWar(w, c.id, o.id) });
    }
    out.sort((a, d) => (d.war - a.war) || (d.r.opinion - a.r.opinion));
    return out.length ? out.slice(0, 16) : [null];
  }, (x) => (x ? `${x.o.id}:${Math.round(x.r.opinion / 4)}:${x.war}:${(x.r.treaties || []).join(',')}` : 'none'), (x) => {
    const met = Object.keys(c.relations || {}).length > 0;
    if (!x) return h('p.empty-note', { text: !c.alive ? 'No surviving contacts.' : met ? 'Every nation it has met has fallen; no living neighbour is in contact.' : 'No contact with other nations yet.' });
    const op = Math.max(-100, Math.min(100, x.r.opinion || 0));
    const bar = h('div.meter-mid', { style: { '--a': (op < 0 ? 50 + op / 2 : 50) + '%', '--b': (op > 0 ? 50 + op / 2 : 50) + '%', '--mc': op >= 0 ? 'var(--good)' : 'var(--danger)', gridColumn: '2 / 4', marginTop: '4px' } });
    const treaties = (x.r.treaties || []).map(F.treatyName);
    const wars = w.wars.filter((q) => (q.attackers.includes(c.id) && q.defenders.includes(x.o.id)) || (q.defenders.includes(c.id) && q.attackers.includes(x.o.id))).length;
    const row = h('div.row', null,
      h('i.swatch', { style: { '--c': x.o.colorHex } }),
      linkBtn(app, { kind: 'civ', id: x.o.id }, x.o.name),
      h('span.n', { text: `${op > 0 ? '+' : ''}${Math.round(op)}` }),
      h('span.s', { text: [x.war ? 'At war' : F.opinionWord(op), ...treaties, x.r.truceUntil > w.time.day ? `truce to ${F.year(x.r.truceUntil)}` : '', x.r.trade > 0 ? `trade ${F.num(x.r.trade, 1)}/mo` : '', wars ? `${wars} war${wars === 1 ? '' : 's'} between them` : ''].filter(Boolean).join(' · ') }),
      bar);
    if (x.war) row.querySelector('.s').classList.add('danger-text');
    return row;
  });

  const warList = rows(b, () => {
    const all = w.wars.filter((q) => q.attackers.includes(c.id) || q.defenders.includes(c.id));
    all.sort((a, d) => (d.active - a.active) || (d.startDay - a.startDay));
    return all.slice(0, 12).map((q) => {
      const att = q.attackers.includes(c.id);
      const won = !q.active && ((att && q.outcome === 'attackers') || (!att && q.outcome === 'defenders'));
      const lost = !q.active && ((att && q.outcome === 'defenders') || (!att && q.outcome === 'attackers'));
      return { key: `${q.id}:${q.active}:${Math.round(q.warScore || 0)}`, icon: 'war', label: F.headName(q.name), n: q.active ? 'ongoing' : won ? 'won' : lost ? 'lost' : F.year(q.endDay), s: `${att ? 'Attacker' : 'Defender'} · ${F.lifespan(q.startDay, q.active ? null : q.endDay)}${q.active ? '' : ' · ' + F.outcomeName(q.outcome)}`, sel: { kind: 'war', id: q.id } };
    });
  }, 'Never at war.', app);

  const townList = rows(b, () => towns().sort((a, d) => d.population - a.population).slice(0, 14).map((s) => ({
    key: `${s.id}:${s.tier}:${Math.round(Math.log2(s.population + 1) * 4)}`, icon: s.id === c.capitalId ? 'crown' : 'town', label: s.name, n: F.people(s.population), s: F.tierName(s.tier) + (s.id === c.capitalId ? ' · capital' : '') + (s.originCivId !== c.id && w.civs[s.originCivId] ? ` · founded by the ${w.civs[s.originCivId].adjective}` : ''), sel: { kind: 'settlement', id: s.id },
  })), 'No settlements remain.', app);

  const rulerHist = rows(b, () => (c.rulerHistory || []).slice(-12).reverse().map((r, k) => {
    const start = r.reignStart ?? r.start;
    const end = r.reignEnd ?? r.end ?? r.died ?? r.deathDay;
    const deeds = r.deeds && typeof r.deeds === 'object' ? deedWords(r.deeds) : '';
    return { key: k + ':' + rulerName(r) + ':' + start, icon: 'crown', label: rulerName(r), tip: rulerGloss(r, c), n: ok(start) ? `Y${yearOf(start)}–${ok(end) ? yearOf(end) : ''}` : '', s: [dynastyName(r.dynasty), r.cause || r.fate || r.endCause ? F.humanize(r.cause || r.fate || r.endCause) : '', ok(start) && ok(end) ? 'reigned ' + F.span(end - start) : '', deeds].filter(Boolean).join(' · '), sel: { kind: 'ruler', id: rulerId(c, r) } };
  }), 'No ruler before this one is remembered.', app);

  // temperament: trait bars with band words, founding markers, recent shifts and their chart (./temper.js)
  const temperSec = anchored(section('Temperament', temperBlock(app, b, c)), 'temperament');

  // knowledge timeline: techs by era with the year learned
  const techBox = h('div.tech-time');
  b.list(techBox, () => {
    const known = Object.entries(c.tech?.known || {});
    if (!known.length) return [['none', []]];
    const byEra = new Map();
    for (const [id, day] of known) {
      const e = techInfo(id)?.era ?? 0;
      if (!byEra.has(e)) byEra.set(e, []);
      byEra.get(e).push([id, day]);
    }
    return [...byEra.entries()].sort((a, d) => a[0] - d[0]).map(([e, list]) => [e, list.sort((p, q) => fin(p[1]) - fin(q[1]))]);
  }, ([e, list]) => `${e}:${list.length}`, ([e, list]) => {
    if (e === 'none') return h('span.empty-note', { text: 'Nothing beyond fire and the spear.' });
    const first = w.sys?.civ?.firstTech || {};
    return h('div.tt-era', null, h('b', { text: F.eraName(e) }), h('div.tags', null, list.map(([id, day]) => {
      const t = h('span.tag', { class: first[id] === c.id ? 'is-first' : '', text: `${techName(id)} · Y${yearOf(day)}` });
      if (first[id] === c.id) tip(t, `${c.name} was the first people in the world to learn this.`);
      return t;
    })));
  });

  const mods = h('dl.kv');
  b.list(mods, () => {
    // read the civ's own cached modifiers only: computing them from here would write sim state between days
    const m = c.mods;
    return Object.entries(m && typeof m === 'object' ? m : {}).filter(([k, v]) => typeof v === 'number' && !k.startsWith('_'));
  }, ([k, v]) => k + ':' + (Math.round(v * 100) / 100), ([k, v]) => {
    const frag = document.createDocumentFragment();
    frag.append(h('dt', { text: F.humanize(k) }), h('dd', { text: Math.abs(v) >= 10 ? F.num(v, 1) : (Math.round(v * 100) / 100).toString() }));
    return frag;
  });
  const modsBox = h('details.more', null, h('summary', { text: 'Modifiers from knowledge, government and fortune' }), mods);

  // allies and vassals as links
  const allies = h('div.tags');
  b.list(allies, () => {
    const out = [];
    for (const id of c.allies || []) { const o = w.civs[id]; if (o && o.alive) out.push(['ally', o]); }
    for (const o of w.civs) if (o && o.alive && o.vassalOf === c.id) out.push(['vassal', o]);
    return out.length ? out : [['none', null]];
  }, ([k, o]) => (o ? k + o.id + o.name : 'none'), ([k, o]) => (o ? h('span.tag.is-link', null, linkBtn(app, { kind: 'civ', id: o.id }, o.name, { swatch: o.colorHex }), h('small', { text: k === 'vassal' ? ' vassal' : ' ally' })) : h('span.empty-note', { text: 'No allies and no vassals.' })));

  // conquests and losses from every chain of title
  const conquests = () => {
    let taken = 0, lost = 0;
    const recent = [];
    for (const s of w.settlements) {
      if (!s || !Array.isArray(s.own)) continue;
      for (let k = 1; k < s.own.length; k++) {
        const [day, to, code] = s.own[k];
        if (code !== 'c') continue;
        const from = s.own[k - 1][1];
        if (to === c.id && from !== c.id) { taken++; recent.push({ day, s, verb: 'Took', from }); }
        else if (from === c.id && to !== c.id) { lost++; recent.push({ day, s, verb: 'Lost', to }); }
      }
    }
    recent.sort((a, d) => d.day - a.day);
    return { taken, lost, recent: recent.slice(0, 8) };
  };
  let cqKey = null, cqVal = null;
  const cq = () => { const k = `${w.versions.settlements}:${Math.floor(w.time.day / 90)}`; if (k !== cqKey) { cqKey = k; cqVal = conquests(); } return cqVal; };
  const cqRows = rows(b, () => cq().recent.map((r, k) => ({ key: `${r.day}:${r.s.id}:${k}`, icon: r.verb === 'Took' ? 'army' : 'ruin', label: `${r.verb} ${r.s.name}`, n: F.year(r.day), s: r.verb === 'Took' ? `from ${w.civs[r.from]?.name || 'another'}` : `to ${w.civs[r.to]?.name || 'another'}`, sel: { kind: 'settlement', id: r.s.id } })), 'No town has been taken by or from this nation.', app);

  // the people (who lives here)
  const faithBars = shareBars(b, () => {
    const P0 = peopleOf(w, c);
    if (!(P0.pop > 0)) return [];
    return [...P0.faith.entries()].sort((a, d) => d[1] - a[1]).slice(0, 5).map(([rid, n]) => {
      const r = rid === 'folk' ? null : w.religions[rid];
      return { key: 'f' + rid, label: r ? F.headName(r.name) : 'Folk beliefs', color: r ? r.colorHex || colorOf(r.color) : 'var(--ink-4)', value: n / P0.pop, text: F.pct(n / P0.pop), sel: r ? { kind: 'religion', id: r.id } : null };
    });
  }, app);
  const cultureBars = shareBars(b, () => {
    const P0 = peopleOf(w, c);
    if (!(P0.pop > 0)) return [];
    return [...P0.culture.entries()].sort((a, d) => d[1] - a[1]).slice(0, 5).map(([oid, n]) => {
      const o = w.civs[oid];
      return { key: 'c' + oid, label: o ? (o.id === c.id ? `${o.adjective} (founders)` : `${o.adjective} (conquered)`) : 'Others', color: o?.colorHex || 'var(--ink-4)', value: n / P0.pop, text: F.pct(n / P0.pop), sel: o && o.id !== c.id ? { kind: 'civ', id: o.id } : null };
    });
  }, app);
  const tierBars = shareBars(b, () => {
    const P0 = peopleOf(w, c);
    if (!(P0.pop > 0)) return [];
    const out = [];
    for (let t = 6; t >= 0; t--) if (P0.tiers[t]) out.push({ key: 't' + t, label: `${P0.tiers[t]} ${F.tierName(t).toLowerCase()}${P0.tiers[t] === 1 ? '' : 's'}`, color: 'var(--brass)', value: P0.tierPop[t] / P0.pop, text: F.people(P0.tierPop[t]) });
    return out;
  });
  const peopleKv = kv(b, [
    { k: 'Living in towns and cities', v: () => { const P0 = peopleOf(w, c); return P0.pop > 0 ? F.pct(P0.urban / P0.pop) : '—'; }, tip: 'Share of the people in settlements of town rank or greater.' },
    { k: 'Living by the sea', v: () => { const P0 = peopleOf(w, c); return P0.pop > 0 ? F.pct(P0.coastal / P0.pop) : '—'; } },
  ]);
  const peopleSec = anchored(section('Its people', h('h5.sub-head', { text: 'Faith' }), faithBars, h('h5.sub-head', { text: 'Descent' }), cultureBars, h('h5.sub-head', { text: 'Where they live' }), tierBars, peopleKv), 'people');
  b.hide(peopleSec, () => !c.alive);

  const figs = rows(b, () => w.figures.filter((q) => q.civId === c.id).slice(-10).reverse().map((q) => figureItem(w, q)), 'No great people are remembered.', app);
  const figSec = section('Great people', figs);
  b.hide(figSec, () => !w.figures.some((q) => q.civId === c.id));

  return h('div.tabpanel', null,
    title(b, { color: c.colorHex, name: () => c.name, sub: () => `${F.titleCase(c.government || 'tribe')} · ${F.eraName(c.tech?.era)}`, actions: standardActions(app) }),
    tags, lead,
    anchored(cells(b, [
      { k: 'People', v: () => F.people(livePeople()), s: () => 'peak ' + F.people(Math.max(c.peakPopulation || 0, livePeople())) },
      { k: 'Lands', v: () => F.areaShort(c.territory), s: () => `${towns().length} settlements` },
      { k: 'Power', v: () => F.num(c.alive === false ? 0 : powerOf(w, c, true), 1), s: () => (c.alive === false ? `fell ${F.year(c.fallenDay)}` : `${F.people(c.military?.manpower)} could fight`) },
    ]), 'summary'),
    section('Its fortunes', ledgerChart(app, b, 'c', c.id, { color: c.colorHex, marks: warMarks, fallback: civFallback })),
    section('Ruler', kv(b, [
      { k: 'Ruler', ref: () => (c.ruler ? { key: 'ru' + rulerName(c.ruler) + c.ruler.reignStart, make: () => linkBtn(app, { kind: 'ruler', id: rulerId(c, c.ruler) }, rulerName(c.ruler), { tipText: rulerGloss(c.ruler, c) }) } : { key: 'none', make: () => textNode('—') }) },
      { k: 'Age', v: () => (c.ruler && ok(c.ruler.born) ? F.span(civNow(w, c) - c.ruler.born) : '—'), hide: () => !c.ruler || !ok(c.ruler.born) },
      { k: c.alive === false ? 'Reigned for' : 'Reigning for', v: () => (c.ruler && ok(c.ruler.reignStart) ? F.span(civNow(w, c) - c.ruler.reignStart) : '—'), hide: () => !c.ruler || !ok(c.ruler.reignStart) },
      { k: 'Temperament', v: () => (c.ruler?.traits?.length ? c.ruler.traits.map(F.humanize).join(', ') : '—'), txt: true, hide: () => !c.ruler },
      { k: 'Dynasty', ref: () => { const d = dynastyName(c.ruler?.dynasty) || dynastyName(c.dynasty); return d ? { key: 'dy' + d, make: () => linkBtn(app, { kind: 'dynasty', id: `${c.id}:${d}` }, d) } : { key: 'none', make: () => textNode('—') }; } },
    ]), (() => { const p = h('p.ins-prose'); b.text(p, () => (c.ruler?.deeds && deedWords(c.ruler.deeds) ? `Deeds of the reign: ${deedWords(c.ruler.deeds)}.` : '')); b.hide(p, () => !(c.ruler?.deeds && deedWords(c.ruler.deeds))); return p; })(), rulerHist),
    temperSec,
    section('The state', kv(b, [
      { k: 'Government', v: () => F.titleCase(c.government || 'tribe') },
      { k: 'Since', v: () => (ok(c.flags?.govSince) ? F.year(c.flags.govSince) : '—'), hide: () => !ok(c.flags?.govSince) },
      { k: 'Capital', ref: () => settleRef(app, c.capitalId) },
      { k: 'State faith', ref: () => religionRef(app, c.stateReligion) },
      { k: 'Stability', v: () => F.pct(c.stability), m: () => c.stability, mc: c.stability < 0.35 ? 'is-danger' : 'is-good' },
      { k: 'Legitimacy', v: () => F.pct(c.legitimacy), m: () => c.legitimacy },
      { k: 'War weariness', v: () => F.pct(c.warWeariness), m: () => c.warWeariness, mc: 'is-danger' },
      { k: 'Prestige', v: () => F.num(c.prestige, 1) },
      { k: 'Golden age', v: () => (c.goldenAge > 0 ? F.num(c.goldenAge, 0) + ' left' : 'No'), hide: () => !(c.goldenAge > 0) },
      { k: 'Dark age', v: () => (c.darkAge > 0 ? F.num(c.darkAge, 0) + ' left' : 'No'), hide: () => !(c.darkAge > 0) },
      { k: 'Overlord', ref: () => civRef(app, c.vassalOf), hide: () => c.vassalOf == null },
      { k: 'Broke away from', ref: () => civRef(app, c.parentId), hide: () => c.parentId == null },
    ]), allies),
    section('Treasury', kv(b, [
      { k: 'Treasury', v: () => F.money(c.treasury) },
      { k: 'Income', v: () => F.num(c.income, 1) + ' / mo' },
      { k: 'Expenses', v: () => F.num(c.expenses, 1) + ' / mo' },
      { k: 'Tax rate', v: () => F.pct(c.taxRate) },
      { k: 'Wealth', v: () => F.money(c.wealth) },
    ])),
    section('Armed forces', kv(b, [
      { k: 'Manpower', v: () => F.people(c.military?.manpower) },
      { k: 'Soldiers in the field', v: () => { const a = w.armies.filter((q) => q.civId === c.id); return a.length ? `${F.people(a.reduce((s, q) => s + (q.strength || 0), 0))} in ${a.length} ${a.length === 1 ? 'army' : 'armies'}` : 'None'; } },
      { k: 'Towns taken', v: () => F.int(cq().taken), tip: 'Every conquest in the chains of title of the world’s settlements.' },
      { k: 'Towns lost', v: () => F.int(cq().lost) },
    ]), cqRows),
    peopleSec,
    section('Knowledge', kv(b, [
      { k: 'Era', v: () => F.eraName(c.tech?.era) },
      { k: 'Studying', v: () => (c.tech?.research ? techName(c.tech.research) : '—'), txt: true },
      { k: 'Progress', v: () => researchText(c), m: () => researchFrac(c), mc: 'is-teal', hide: () => !c.tech?.research },
      { k: 'Known', v: () => { const n = Object.keys(c.tech?.known || {}).length; const T = techMod?.TECHS; const total = Array.isArray(T) ? T.length : T ? Object.keys(T).length : 0; return total ? `${n} of ${total}` : String(n); } },
    ]), techBox, modsBox),
    section('Relations', relations),
    section('Wars', warList),
    section('Settlements', townList),
    figSec,
    section('History', chronicleList(app, b, (e) => entryAbout(e, 'civ', c.id))),
    otherRecords(b, () => c, CIV_KEYS),
  );
}

/** A ruler's deeds as words: "took 6 towns, raised 2 wonders". */
export function deedWords(d) {
  if (!d || typeof d !== 'object') return '';
  const parts = [];
  const add = (k, one, many) => { const n = fin(d[k]); if (n > 0) parts.push(n === 1 ? one : many.replace('#', F.int(n))); };
  add('conquests', 'took a town', 'took # towns');
  add('losses', 'lost a town', 'lost # towns');
  add('wonders', 'raised a wonder', 'raised # wonders');
  add('built', 'built once', 'built # works');
  add('techs', 'saw one discovery', 'saw # discoveries');
  add('colonies', 'founded a colony', 'founded # colonies');
  add('reforms', 'reformed the state', 'made # reforms');
  add('famines', 'weathered a famine', 'weathered # famines');
  add('golden', 'began a golden age', 'began # golden ages');
  return parts.join(', ');
}

/** The day a nation's clock stops: today, or the day it fell. */
function civNow(w, c) { return c.alive === false && ok(c.fallenDay) ? Math.min(w.time.day, c.fallenDay) : w.time.day; }

function researchFrac(c) {
  const t = c.tech;
  if (!t || !t.research) return 0;
  const cost = techInfo(t.research)?.cost;
  if (ok(cost) && cost > 0) return Math.max(0, Math.min(1, (t.progress || 0) / cost));
  return t.progress <= 1 ? t.progress || 0 : 0;
}
function researchText(c) {
  const t = c.tech;
  const cost = techInfo(t?.research)?.cost;
  if (ok(cost) && cost > 0) return `${F.num(t.progress || 0, 0)} of ${F.num(cost, 0)}`;
  return F.num(t?.progress, 1);
}

// ---------------------------------------------------------------------------
// army, war

function generalName(w, g) {
  if (g == null) return '—';
  if (typeof g === 'string') return g;
  if (typeof g === 'number') return w.figures.find((q) => q.id === g)?.name || '—';
  return g.name || '—';
}

/** "Raised 2,400 strong at Eveeth in Year 699; fought 3 battles and won 2; …" from the army's service counters. */
function serviceRecord(w, a) {
  const l = a.flags?.l || {};
  const loss = a.flags?.loss || {};
  const home = w.settlements[a.homeId];
  const parts = [];
  const raised = fin(l.raised ?? l.r0, NaN);
  parts.push(`Raised${ok(raised) ? ` ${F.people(raised)} strong` : ''}${home ? ` at ${home.name}` : ''} in ${F.year(a.createdDay)}`);
  if (fin(l.peak) > 0 && fin(l.peak) > fin(raised)) parts.push(`at its greatest ${F.people(l.peak)}`);
  if (fin(l.battles ?? l.bat) > 0) parts.push(`fought ${F.int(l.battles ?? l.bat)} battle${(l.battles ?? l.bat) === 1 ? '' : 's'} and won ${F.int(l.won || 0)}`);
  if (fin(l.inflicted) > 0) parts.push(`slew ${F.people(l.inflicted)}`);
  const lossParts = [['battle', 'in battle'], ['attrition', 'to hunger and the march'], ['plague', 'to camp fever'], ['band', 'to raiders'], ['beast', 'to beasts']].filter(([k]) => fin(loss[k]) >= 1).map(([k, wds]) => `${F.people(loss[k])} ${wds}`);
  if (lossParts.length) parts.push(`lost ${F.listing(lossParts, 5)}`);
  if (fin(l.dist ?? l.distance) > 0) parts.push(`marched ${F.km(l.dist ?? l.distance)}`);
  if (fin(l.caps ?? l.captures) > 0) parts.push(`took ${F.int(l.caps ?? l.captures)} town${(l.caps ?? l.captures) === 1 ? '' : 's'}`);
  return parts.join('; ') + '.';
}

function armyView(app, sel, b) {
  const w = app.world;
  const get = () => w.armies.find((q) => q.id === sel.id);
  const a0 = get();
  const archived = w.history?.series?.a?.[sel.id];
  if (!a0 && !archived) return missing('That army has disbanded, and its march is no longer remembered.');
  if (!a0) {
    // a force no longer in the field: what the ledger kept of its march
    return h('div.tabpanel', null,
      title(b, { icon: 'army', name: () => 'A disbanded army', sub: () => `Last seen ${F.year(archived.e ?? w.time.day)}`, actions: standardActions(app) }),
      h('p.ins-lead', { text: 'This force has left the field. Its march is drawn on the map; its strength over time is below.' }),
      section('Its campaign', ledgerChart(app, b, 'a', sel.id, { live: () => false })),
    );
  }
  const a = () => get() || a0;
  const gone = () => !get();
  const civ = () => w.civs[a().civId];
  const gen = () => { const id = a().flags?.genId; return id != null ? w.figures.find((q) => q.id === id) : null; };
  return h('div.tabpanel', null,
    title(b, { icon: a0.naval ? 'ship' : 'army', name: () => `${civ()?.adjective || ''} ${a().naval ? 'fleet' : 'army'}${generalName(w, a().general) !== '—' ? ' of ' + generalName(w, a().general) : ''}`.trim(), subNode: () => civRef(app, a().civId), actions: standardActions(app, { follow: true }) }),
    (() => { const p = h('p.ins-lead'); b.text(p, () => (gone() ? 'This force is no longer in the field.' : `${F.humanize(a().state || 'idle')}${a().naval ? ' at sea' : ''}, ${F.people(a().strength)} strong.`)); return p; })(),
    cells(b, [
      { k: 'Strength', v: () => F.people(a().strength) },
      { k: 'Morale', v: () => F.pct(a().morale) },
      { k: 'Supply', v: () => F.pct(a().supply) },
    ]),
    section('Its campaign', ledgerChart(app, b, 'a', sel.id, { color: civ()?.colorHex, live: () => !gone() })),
    section('Service record', (() => { const p = h('p.ins-prose'); b.text(p, () => serviceRecord(w, a())); return p; })()),
    section('Orders', kv(b, [
      { k: 'War', ref: () => { const war = a().warId != null ? w.wars[a().warId] : null; return war ? { key: 'w' + war.id, make: () => linkBtn(app, { kind: 'war', id: war.id }, F.headName(war.name)) } : { key: 'none', make: () => textNode(a().flags?.hunt != null ? 'A hunt' : 'None') }; } },
      { k: 'Objective', ref: () => (w.settlements[a().targetId] ? settleRef(app, a().targetId) : { key: 'none', make: () => textNode(a().targetId != null ? 'An enemy force' : 'None') }) },
      { k: 'Home', ref: () => settleRef(app, a().homeId) },
      { k: 'General', ref: () => { const g = gen(); return g ? { key: 'g' + g.id, make: () => linkBtn(app, { kind: 'figure', id: g.id }, g.name) } : { key: 'n' + generalName(w, a().general), make: () => textNode(generalName(w, a().general)) }; } },
      { k: 'State', v: () => F.humanize(a().state || 'idle') },
      { k: 'At sea', v: () => (a().naval ? 'Yes' : 'No') },
      { k: 'Position', v: () => F.latLon(w, a().x, a().y) },
      { k: 'March remaining', v: () => (Array.isArray(a().path) ? F.km(Math.max(0, a().path.length - (a().pathStep || 0))) : '—') },
      { k: 'Raised', v: () => `${F.year(a().createdDay)} (${F.span(w.time.day - a().createdDay)} ago)` },
    ])),
    otherRecords(b, () => a(), ARMY_KEYS),
  );
}

/** Every battle of a war we know of: [{ day, x, y, winner, loser, dead, name, n }] newest first. */
export function warBattles(w, war) {
  const out = [];
  const L = war.ledger;
  if (L && Array.isArray(L.b) && L.b.length) {
    for (const b of L.b) {
      if (!Array.isArray(b)) continue;
      if (b.length === 3) { out.push({ day: b[0], n: b[1], dead: b[2], skirmishes: true }); continue; }
      const [day, x, y, winner, loser, dead, nameKey] = b;
      out.push({ day, x, y, winner, loser, dead, name: typeof nameKey === 'string' ? nameKey : null });
    }
  } else {
    for (const e of war.geo?.log || []) if (e) out.push({ day: e.day, x: e.x, y: e.y, winner: e.winner, loser: e.loser, dead: e.dead, name: e.name && !/^a skirmish/i.test(e.name) ? e.name : null, skirm: /^a skirmish/i.test(e.name || '') ? e.name : null });
  }
  return out.sort((a, b) => b.day - a.day);
}

/** Battlefields this war left (historic sites with its ref). */
function warSites(w, war) {
  return w.sites.filter((s) => (s.kind === 'battle' || s.kind === 'siege' || s.kind === 'wreck') && s.ref && s.ref.k === 'war' && s.ref.id === war.id);
}

/** Towns that changed hands: [{ day, sid, from, to, code }] (the war ledger, else the captured list). */
function warTransfers(w, war) {
  const L = war.ledger;
  if (L && Array.isArray(L.t) && L.t.length) return L.t.filter(Array.isArray).map(([day, sid, from, to, code]) => ({ day, sid, from, to, code }));
  const out = [];
  for (const sid of war.captured || []) {
    const s = w.settlements[sid];
    if (!s) continue;
    // find the transfer in the town's own chain within the war's span
    let day = null, from = null, to = s.civId, code = 'cap';
    const own = Array.isArray(s.own) ? s.own : [];
    for (let k = own.length - 1; k >= 1; k--) {
      const [d, c] = own[k];
      if (d >= war.startDay && (war.endDay == null || d <= war.endDay + 30)) { day = d; to = c; from = own[k - 1][1]; if (own[k][2] === 'x') code = 'razed'; break; }
    }
    if (!s.alive && s.destroyCause === 'razed') code = 'razed';
    out.push({ day, sid, from, to, code });
  }
  return out;
}

/** "The 14th war between these realms; the Varathi have won 9." */
function rivalryLine(w, war) {
  const a = war.attackers[0], d = war.defenders[0];
  if (a == null || d == null) return '';
  let n = 0, idx = 0, wa = 0, wd = 0;
  for (const q of w.wars) {
    const same = (q.attackers.includes(a) && q.defenders.includes(d)) || (q.attackers.includes(d) && q.defenders.includes(a));
    if (!same) continue;
    n++;
    if (q.id === war.id) idx = n;
    if (q.active) continue;
    const winner = q.outcome === 'attackers' ? q.attackers[0] : q.outcome === 'defenders' ? q.defenders[0] : null;
    if (winner === a) wa++; else if (winner === d) wd++;
  }
  if (n < 2) return '';
  const A = w.civs[a], D = w.civs[d];
  const has = (c) => (F.civPlural(c) ? 'have' : 'has');
  const lead = wa === wd ? `neither side has had the better of it (${wa} victories each)` : wa > wd ? `${F.theCiv(A)} ${has(A)} won ${wa}${wd ? ` to ${wd}` : ''}` : `${F.theCiv(D)} ${has(D)} won ${wd}${wa ? ` to ${wa}` : ''}`;
  return `The ${F.ordinal(idx)} of ${F.int(n)} wars between ${F.theCiv(A)} and ${F.theCiv(D)}; ${lead}.`;
}

function warView(app, sel, b) {
  const w = app.world;
  const war = w.wars[sel.id];
  if (!war) return missing('That war is not in the record.');
  const side = (ids, label) => rows(b, () => ids.map((id) => {
    const c = w.civs[id];
    return { key: `${id}:${c?.alive}:${Math.round((war.casualties?.[id] || 0) / 100)}`, swatch: c?.colorHex || 'var(--ink-3)', node: c ? linkBtn(app, { kind: 'civ', id }, c.name, { strike: !c.alive }) : textNode('Unknown'), n: F.people(war.casualties?.[id] || 0) + ' lost', s: `${label}${c && !c.alive ? ' · fallen' : ''} · ${w.armies.filter((q) => q.civId === id && q.warId === war.id).length} armies in the field` };
  }), 'No one.', app);
  const g = () => war.geo || {};
  // casualty bars per side
  const toll = shareBars(b, () => {
    const all = [...war.attackers, ...war.defenders];
    const tot = all.reduce((a, id) => a + fin(war.casualties?.[id]), 0);
    if (!(tot > 0)) return [];
    return all.filter((id) => fin(war.casualties?.[id]) > 0).sort((p, q) => fin(war.casualties?.[q]) - fin(war.casualties?.[p])).map((id) => {
      const c = w.civs[id];
      return { key: 'k' + id, label: c ? c.name : 'Unknown', color: c?.colorHex || 'var(--ink-3)', value: fin(war.casualties[id]) / tot, text: F.people(war.casualties[id]), sel: c ? { kind: 'civ', id } : null };
    });
  }, app);
  const battleMarks = () => warBattles(w, war).filter((x) => !x.skirmishes).map((x) => ({ day: x.day, color: w.civs[x.winner]?.colorHex || 'var(--danger)', label: x.name ? F.headName(x.name) : `Skirmish (${F.people(x.dead)} dead)` }));
  // battles table
  const battleRows = rows(b, () => {
    const list = warBattles(w, war);
    const full = Boolean(war.ledger && Array.isArray(war.ledger.b) && war.ledger.b.length);
    const named = list.filter((x) => x.name || x.dead >= 100);
    const shown = (full && named.length >= 3 ? named : list).slice(0, 24);
    return shown.map((x, k) => {
      if (x.skirmishes) return { key: `sk${x.day}:${k}`, icon: 'war', label: `${F.int(x.n)} skirmishes`, n: F.people(x.dead) + ' dead', s: F.monthYear(x.day) };
      const wc = w.civs[x.winner];
      return {
        key: `b${x.day}:${x.x}:${x.y}:${k}`, swatch: wc?.colorHex || 'var(--ink-3)', label: x.name ? F.headName(x.name) : x.skirm ? F.headName(x.skirm) : 'A clash of arms', n: F.people(x.dead) + ' dead',
        s: `${F.monthYear(x.day)}${wc ? ' · won by ' + wc.name : ''}`,
        run: Number.isFinite(x.x) ? () => { const s0 = sitesNear(w, x.x, x.y, 1.6).find((q) => q.kind === 'battle' || q.kind === 'siege'); if (s0) app.select({ kind: 'site', id: s0.id }, { focus: true }); else app.focus(x.x, x.y, 14); } : null,
      };
    });
  }, 'No battles have been fought.', app);
  const sitesRows = rows(b, () => warSites(w, war).sort((p, q) => q.dead - p.dead).slice(0, 8).map((s) => ({ key: `st${s.id}:${s.n}`, icon: 'war', label: siteTitle(w, s), n: F.people(s.dead) + ' dead', s: `${s.n} ${s.n === 1 ? 'battle' : 'battles'} · ${siteSub(w, s)}`, sel: { kind: 'site', id: s.id } })), 'No battlefield of this war is remembered.', app);
  // towns that changed hands
  const handRows = rows(b, () => warTransfers(w, war).slice().sort((p, q) => fin(q.day) - fin(p.day)).slice(0, 20).map((t, k) => {
    const s = w.settlements[t.sid], to = w.civs[t.to], from = w.civs[t.from];
    const verb = t.code === 'razed' || t.code === 'x' ? 'Razed' : t.code === 'returned' ? 'Returned' : 'Taken';
    return { key: `h${t.sid}:${t.day}:${t.code}:${k}`, swatch: to?.colorHex || 'var(--ink-3)', label: `${verb}: ${s?.name || 'a town'}`, n: t.day != null ? F.year(t.day) : '', s: [from ? `from ${from.name}` : '', to && verb !== 'Razed' ? `to ${to.name}` : ''].filter(Boolean).join(' '), sel: s ? { kind: 'settlement', id: s.id } : null };
  }), 'No town changed hands.', app);
  // terms of peace
  const terms = kv(b, [
    { k: 'Status', v: () => (war.active ? 'Ongoing' : F.outcomeName(war.outcome)) },
    { k: 'Ended because', v: () => (g().endReason ? F.humanize(g().endReason) : '—'), txt: true, hide: () => !g().endReason },
    { k: 'Ceded', ref: () => termsRef(app, g().terms?.ceded), hide: () => !g().terms?.ceded?.length },
    { k: 'Returned', ref: () => termsRef(app, g().terms?.returned), hide: () => !g().terms?.returned?.length },
    { k: 'Tribute', v: () => (g().terms?.tribute ? (typeof g().terms.tribute === 'number' ? F.num(g().terms.tribute, 1) + ' a month' : 'Yes') : 'None'), hide: () => !g().terms },
    { k: 'Vassalage', v: () => (g().terms?.vassal ? 'The loser bent the knee' : 'None'), hide: () => !g().terms },
    { k: 'Cause', v: () => F.humanize(war.cause || 'conquest') },
    { k: 'War aim', ref: () => settleRef(app, g().goalSid), hide: () => g().goalSid == null },
    { k: 'Began', v: () => dateString(w, war.startDay) },
    { k: 'Ended', v: () => (war.endDay != null ? dateString(w, war.endDay) : '—') },
  ]);
  const armiesRows = rows(b, () => {
    const out = [];
    for (const a of w.armies) if (a.warId === war.id) out.push({ key: `a${a.id}:${Math.round(a.strength / 50)}`, swatch: w.civs[a.civId]?.colorHex, label: `${w.civs[a.civId]?.adjective || ''} ${a.naval ? 'fleet' : 'army'}${generalName(w, a.general) !== '—' ? ' of ' + generalName(w, a.general) : ''}`, n: F.people(a.strength), s: F.humanize(a.state || 'idle'), sel: { kind: 'army', id: a.id } });
    for (const s of (war.ledger?.armies || []).slice(0, 12)) {
      if (!s || typeof s !== 'object') continue;
      out.push({ key: `aa${s.genId ?? ''}:${s.raised ?? s.r0 ?? ''}:${s.civ ?? s.civId ?? ''}:${out.length}`, swatch: w.civs[s.civ ?? s.civId]?.colorHex, label: `${w.civs[s.civ ?? s.civId]?.adjective || ''} host${s.gen ? ' of ' + s.gen : ''}`, n: ok(s.peak) ? F.people(s.peak) + ' at most' : '', s: [ok(s.bat) ? `${s.bat} battles, ${s.won || 0} won` : '', ok(s.dead) ? `${F.people(s.dead)} lost` : '', s.fate ? F.humanize(s.fate) : ''].filter(Boolean).join(' · '), sel: s.genId != null ? { kind: 'figure', id: s.genId } : null });
    }
    return out;
  }, 'No army is in the field.', app);
  const armiesSec = section('Armies', armiesRows);

  const rivalry = h('p.ins-prose');
  b.text(rivalry, () => rivalryLine(w, war));
  b.hide(rivalry, () => !rivalryLine(w, war));

  // the theatre
  const plateBox = h('div.theatre');
  const drawTheatre = () => {
    if (!plateMod || typeof plateMod.drawAtlasPlate !== 'function') { plateBox.hidden = true; return; }
    const pts = [];
    for (const x of warBattles(w, war)) if (Number.isFinite(x.x)) pts.push([x.x, x.y]);
    for (const s of warSites(w, war)) pts.push([s.x, s.y]);
    const trans = warTransfers(w, war);
    for (const t of trans) { const s = w.settlements[t.sid]; if (s) pts.push([s.x, s.y]); }
    for (const id of [...war.attackers, ...war.defenders]) { const c = w.civs[id]; const cap = c && c.capitalId != null ? w.settlements[c.capitalId] : null; if (cap) pts.push([cap.x, cap.y]); }
    if (!pts.length) { plateBox.hidden = true; return; }
    plateBox.hidden = false;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const m = Math.max(6, Math.round(Math.max(x1 - x0, y1 - y0) * 0.15));
    const box = { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m };
    // never so tight that a skirmish fills the plate: at least 72 tiles across, kept on the map
    for (const [a, z, lim] of [['x0', 'x1', w.W], ['y0', 'y1', w.H]]) {
      const need = 72 - (box[z] - box[a]);
      if (need > 0) { box[a] -= need / 2; box[z] += need / 2; }
      if (box[a] < 0) { box[z] -= box[a]; box[a] = 0; }
      if (box[z] > lim - 1) { box[a] -= box[z] - (lim - 1); box[z] = lim - 1; box[a] = Math.max(0, box[a]); }
    }
    const atlas = w.history?.atlas || [];
    const at = war.active ? null : fin(war.endDay, w.time.day);
    let snap = null;
    if (at != null) for (const q of atlas) { if (q.day != null ? q.day <= at + 3600 : q.y * DAYS_PER_YEAR <= at + 3600) snap = q; else break; }
    const marks = [];
    for (const x of warBattles(w, war)) if (Number.isFinite(x.x) && fin(x.dead) >= 20) marks.push({ x: x.x, y: x.y, kind: 'battle', color: w.civs[x.winner]?.colorHex || '#b8322a', r: 2.5 + Math.log10(1 + fin(x.dead)) });
    if (!marks.length) for (const s of warSites(w, war)) marks.push({ x: s.x, y: s.y, kind: 'battle', color: w.civs[s.civIds?.[0]]?.colorHex || '#b8322a', r: 2.5 + Math.log10(1 + s.dead) });
    for (const t of trans) { const s = w.settlements[t.sid]; if (s) marks.push({ x: s.x, y: s.y, kind: t.code === 'razed' ? 'razed' : 'capture', color: t.code === 'razed' ? '#e0664d' : w.civs[t.to]?.colorHex || '#f3ead2', r: 4 }); }
    const canvas = h('canvas.theatre-plate', { role: 'img', 'aria-label': `Theatre of ${war.name}` });
    clear(plateBox);
    plateBox.append(canvas, h('p.rec-caption', { text: `${snap ? `Borders of Year ${snap.y}` : 'Borders today'} · crosses mark battles in the victor’s colour, rings the towns taken, red crosses the towns razed.` }));
    try {
      const P = plateMod.drawAtlasPlate(canvas, w, snap, { box, marks: [] });
      drawTheatreMarks(canvas.getContext('2d'), P, marks);
    } catch (e) { plateBox.hidden = true; }
  };
  let theatreKey = null;
  b.run(() => {
    const k = `${warBattles(w, war).length}:${(war.captured || []).length}:${war.active}:${Math.floor(w.time.day / 180)}`;
    if (k === theatreKey) return;
    theatreKey = k;
    requestAnimationFrame(drawTheatre);
  });

  const parts = new Set([...war.attackers, ...war.defenders]);
  return h('div.tabpanel', null,
    title(b, { icon: 'war', name: () => war.name, sub: () => (war.active ? `Ongoing for ${F.span(w.time.day - war.startDay)}` : `${F.lifespan(war.startDay, war.endDay)}`), actions: standardActions(app) }),
    (() => { const p = h('p.ins-lead'); b.text(p, () => `Begun in ${F.year(war.startDay)} over ${F.humanize(war.cause || 'conquest').toLowerCase()}${g().goalSid != null && w.settlements[g().goalSid] ? `, its prize ${w.settlements[g().goalSid].name}` : ''}. ${war.active ? 'The fighting continues.' : F.outcomeName(war.outcome) + '.'}`); return p; })(),
    rivalry,
    cells(b, [
      { k: 'Battles', v: () => F.int(war.battles || 0) },
      { k: 'Fallen', v: () => F.people(Object.values(war.casualties || {}).reduce((a, v) => a + (v || 0), 0)) },
      { k: 'Towns taken', v: () => F.int(war.captured?.length || 0) },
    ]),
    section('The course of the war', ledgerChart(app, b, 'w', war.id, { zero: true, initial: 'score', marks: battleMarks, live: () => war.active }),
      (() => { const p = h('div.score-legend'); const l = h('span'), r = h('span'); p.append(l, r); b.text(l, () => '▼ defenders ahead'); b.text(r, () => `attackers ahead ▲ · ${war.active ? 'now' : 'final'} ${F.signed(war.warScore || 0, 0)}`); return p; })()),
    section('The fallen', toll),
    section('Theatre of war', plateBox),
    section('Attackers', side(war.attackers, 'Attacker')),
    section('Defenders', side(war.defenders, 'Defender')),
    section('Battles', battleRows),
    section('Battlefields', sitesRows),
    section('Changed hands', handRows),
    armiesSec,
    section('Terms', terms),
    section('Chronicle of the war', chronicleList(app, b, (e) => entryAbout(e, 'war', war.id, (q) => !q.ref && (q.cat === 'war' || q.cat === 'diplomacy') && q.day >= war.startDay && (war.endDay == null || q.day <= war.endDay + 30) && (parts.has(q.civId) || (q.text || '').includes(war.name))), 16)),
  );
}

/** Battle crosses, capture rings and razing crosses over a theatre plate, each with a dark halo. */
function drawTheatreMarks(ctx, P, marks) {
  const k = Math.max(1, P.scale / 5);
  ctx.lineCap = 'round';
  for (const m of marks.slice().sort((a, b) => (a.kind === 'battle') - (b.kind === 'battle'))) {
    const [px, py] = P.toPx(m.x, m.y);
    const r = (m.r || 3) * k * 0.9;
    for (const pass of [0, 1]) {
      ctx.lineWidth = pass ? 1.8 * Math.sqrt(k) : 4 * Math.sqrt(k);
      ctx.strokeStyle = pass ? m.color : 'rgba(10,12,16,0.85)';
      ctx.beginPath();
      if (m.kind === 'capture') ctx.arc(px, py, r + 2, 0, Math.PI * 2);
      else { ctx.moveTo(px - r, py - r); ctx.lineTo(px + r, py + r); ctx.moveTo(px + r, py - r); ctx.lineTo(px - r, py + r); }
      ctx.stroke();
    }
  }
}

function termsRef(app, list) {
  const ids = (list || []).filter((sid) => app.world.settlements[sid]);
  return { key: 't' + ids.join(','), make: () => h('span', null, ...ids.slice(0, 8).flatMap((sid, k) => [k ? ', ' : '', linkBtn(app, { kind: 'settlement', id: sid }, app.world.settlements[sid].name)])) };
}

// ---------------------------------------------------------------------------
// faith, plague, storm, volcano

const DOCTRINE_WORDS = { sun: 'Sun worship', ancestors: 'Ancestor cult', storm: 'Storm gods', earth: 'Earth mother', moon: 'Moon cult', pantheon: 'Pantheon', mystery: 'Mystery cult', dualism: 'Dualism', mono: 'Monotheism', monotheism: 'Monotheism', stars: 'Star lore' };
function doctrineName(key) {
  const d = religionMod?.DOCTRINES?.find?.((q) => q.key === key);
  return d?.label ? F.headName(d.label) : DOCTRINE_WORDS[key] || F.humanize(key || 'faith');
}

function religionView(app, sel, b) {
  const w = app.world;
  const r = w.religions[sel.id];
  if (!r) return missing('That faith is not in the record.');
  const followers = () => {
    let n = 0, towns = 0;
    for (const s of liveSettlements(w)) { const sh = s.religion?.[r.id] || 0; n += sh * s.population; if (s.dominantReligion === r.id) towns++; }
    return { n: ok(r.followers) && r.followers > 0 ? r.followers : n, towns };
  };
  const tenets = h('div.tags');
  b.list(tenets, () => (r.tenets?.length ? r.tenets : ['none']), (t) => t, (t) => {
    if (t === 'none') return h('span.empty-note', { text: 'No written tenets.' });
    const tag = h('span.tag', { text: F.humanize(t) });
    const desc = religionMod?.TENETS?.[t]?.desc;
    if (desc) tip(tag, desc);
    return tag;
  });
  const schisms = rows(b, () => {
    const out = [];
    const parent = r.parentId != null ? w.religions[r.parentId] : null;
    if (parent) out.push({ key: 'p' + parent.id, swatch: parent.colorHex || colorOf(parent.color), label: F.headName(parent.name), n: 'mother faith', s: `It broke from it in ${F.year(r.foundedDay)}`, sel: { kind: 'religion', id: parent.id } });
    for (const q of w.religions) if (q && q.parentId === r.id) out.push({ key: 'c' + q.id, swatch: q.colorHex || colorOf(q.color), label: F.headName(q.name), n: q.alive === false ? 'died out' : F.people(q.followers), s: `Broke away in ${F.year(q.foundedDay)}`, sel: { kind: 'religion', id: q.id } });
    return out;
  }, 'No schism has divided it.', app);
  const byNation = shareBars(b, () => {
    const per = new Map();
    let tot = 0;
    for (const s of liveSettlements(w)) { const sh = s.religion?.[r.id] || 0; if (sh <= 0) continue; const n = sh * s.population; per.set(s.civId, (per.get(s.civId) || 0) + n); tot += n; }
    if (!(tot > 0)) return [];
    return [...per.entries()].sort((a, d) => d[1] - a[1]).slice(0, 6).map(([id, n]) => ({ key: 'n' + id, label: w.civs[id]?.name || 'Unknown', color: w.civs[id]?.colorHex || 'var(--ink-3)', value: n / tot, text: F.people(n), sel: { kind: 'civ', id } }));
  }, app);
  const prophetId = r.prophetId ?? (typeof r.prophet === 'number' ? r.prophet : null);
  return h('div.tabpanel', null,
    title(b, { color: r.colorHex || colorOf(r.color), name: () => r.name, sub: () => (r.alive === false ? `A dead faith · ${F.lifespan(r.foundedDay, r.endDay)}` : `${doctrineName(r.doctrine)} · founded ${F.year(r.foundedDay)}`), actions: standardActions(app) }),
    (() => { const p = h('p.ins-lead'); b.text(p, () => `${F.headName(r.name)}${r.deity ? `, the faith of ${r.deity}` : ''}, was revealed${r.holyCityId != null && w.settlements[r.holyCityId] ? ` at ${w.settlements[r.holyCityId].name}` : ''} in ${F.year(r.foundedDay)}. ${r.alive === false ? `It died out in ${F.year(r.endDay)}.` : `At its height it held ${F.people(r.peakFollowers || followers().n)} souls${ok(r.peakDay) ? ` (Year ${yearOf(r.peakDay)})` : ''}.`}`); return p; })(),
    cells(b, [
      { k: 'Followers', v: () => F.people(followers().n), s: () => 'peak ' + F.people(r.peakFollowers || 0) },
      { k: 'Fervour', v: () => F.pct(r.fervor) },
      { k: 'Holds sway in', v: () => F.int(followers().towns), s: () => `towns · ${F.int(r.nations || 0)} nations` },
    ]),
    section('Its spread', ledgerChart(app, b, 'r', r.id, { color: r.colorHex || colorOf(r.color) })),
    section('Teachings', kv(b, [
      { k: 'Doctrine', v: () => doctrineName(r.doctrine) },
      { k: 'Deity', v: () => r.deity || '—', hide: () => !r.deity },
    ]), tenets),
    section('Origins', kv(b, [
      { k: 'Prophet', ref: () => (prophetId != null && w.figures.some((q) => q.id === prophetId) ? figureRef(app, prophetId) : { key: 'p' + (r.prophet?.name || r.prophet), make: () => textNode(typeof r.prophet === 'string' ? r.prophet : r.prophet?.name || '—') }) },
      { k: 'Holy city', ref: () => settleRef(app, r.holyCityId) },
      { k: 'Born among', ref: () => civRef(app, r.founderCivId) },
      { k: 'State faith of', v: () => liveCivs(w).filter((c) => c.stateReligion === r.id).map((c) => c.name).join(', ') || 'No nation', txt: true },
    ])),
    section('Its faithful by nation', byNation),
    section('Schisms', schisms),
    section('History', chronicleList(app, b, (e) => entryAbout(e, 'religion', r.id, (q) => !q.ref && q.cat === 'religion' && (q.text || '').includes(r.name)))),
  );
}

const CAUSE_WORDS = { crowd: 'Bred in crowded, unwashed streets', livestock: 'Leapt from herds to their keepers', contact: 'Carried by strangers at first meeting', divine: 'Sent by an angry heaven', return: 'An old sickness returned' };

function plagueView(app, sel, b) {
  const w = app.world;
  const p = w.plagues[sel.id];
  if (!p) return missing('That plague is not in the record.');
  const sick = rows(b, () => {
    const out = liveSettlements(w).filter((s) => s.disease && s.disease.pid === p.id);
    out.sort((a, c) => c.population - a.population);
    return out.slice(0, 12).map((s) => ({ key: 's' + s.id, icon: 'plague', label: s.name, n: sirText(s.disease.I, s.population), sel: { kind: 'settlement', id: s.id } }));
  }, p.active ? 'No settlement is sick at this moment.' : 'The plague has passed.', app);
  const strains = rows(b, () => {
    const out = [];
    const parent = p.strainOf != null ? w.plagues[p.strainOf] : null;
    if (parent) out.push({ key: 'p' + parent.id, icon: 'plague', label: F.headName(parent.name), n: F.people(parent.deaths) + ' dead', s: `The first visitation, ${F.lifespan(parent.startDay, parent.endDay)}`, sel: { kind: 'plague', id: parent.id } });
    for (const q of w.plagues) if (q && q.strainOf === p.id) out.push({ key: 'c' + q.id, icon: 'plague', label: F.headName(q.name), n: F.people(q.deaths) + ' dead', s: `Returned ${F.year(q.startDay)}`, sel: { kind: 'plague', id: q.id } });
    return out;
  }, 'No other strain is known.', app);
  const nations = h('div.tags');
  b.list(nations, () => (p.civsHit || []).filter((id) => w.civs[id]), (id) => id, (id) => h('span.tag.is-link', null, linkBtn(app, { kind: 'civ', id }, w.civs[id].name, { swatch: w.civs[id].colorHex })));
  const pits = rows(b, () => w.sites.filter((s) => s.kind === 'plaguepit' && s.ref && s.ref.k === 'plague' && s.ref.id === p.id).map((s) => ({ key: 'pit' + s.id, icon: 'plague', label: siteTitle(w, s), n: s.data?.frac ? F.pct(s.data.frac) + ' lost' : F.people(s.dead), sel: { kind: 'site', id: s.id } })), 'No town lost a quarter of its people.', app);
  return h('div.tabpanel', null,
    title(b, { icon: 'plague', name: () => p.name, sub: () => (p.active ? `Spreading since ${F.year(p.startDay)}` : F.lifespan(p.startDay, p.endDay)), actions: standardActions(app) }),
    (() => { const el = h('p.ins-lead'); b.text(el, () => `${CAUSE_WORDS[p.cause] || 'A sickness of unknown birth'}${p.symptom ? `, a ${String(p.symptom).toLowerCase()}` : ''}. ${p.active ? `It has struck ${F.int(p.hit || 0)} town${p.hit === 1 ? '' : 's'} so far.` : `It struck ${F.int(p.hit || 0)} town${p.hit === 1 ? '' : 's'} in ${F.int((p.civsHit || []).length)} nation${(p.civsHit || []).length === 1 ? '' : 's'} before it passed.`}${p.worst && p.worst.frac >= 0.05 ? ` Worst hit was ${p.worst.name}, which lost ${F.pct(p.worst.frac)} of its people.` : ''}`); return el; })(),
    cells(b, [
      { k: 'Dead', v: () => F.people(p.deaths || 0), s: () => `${F.int(p.hit || 0)} town${(p.hit || 0) === 1 ? '' : 's'} struck` },
      { k: 'Spread', v: () => `R ≈ ${fin(p.infectivity).toFixed(1)}`, s: () => F.rNumber(p.infectivity).replace(/^R ≈ [\d.]+ · /, '') },
      { k: 'Lethality', v: () => F.pct(p.lethality), s: () => F.lethalWord(p.lethality) },
    ]),
    section('Its course', ledgerChart(app, b, 'p', p.id, { color: p.color || 'var(--chart-2)', live: () => p.active })),
    section('Course', kv(b, [
      { k: 'First case', ref: () => settleRef(app, p.originSid) },
      { k: 'Worst hit', ref: () => (p.worst ? { key: 'w' + p.worst.sid, make: () => h('span', null, linkBtn(app, { kind: 'settlement', id: p.worst.sid }, p.worst.name), ` lost ${F.pct(p.worst.frac)}`) } : { key: 'none', make: () => textNode('—') }) },
      { k: 'Peak sick at once', v: () => F.people(p.peakInfected || 0) },
      { k: 'Began', v: () => dateString(w, p.startDay) },
      { k: 'Ended', v: () => (p.endDay != null ? dateString(w, p.endDay) : 'Still spreading') },
      { k: 'Natural course', v: () => (ok(p.duration) ? F.span(p.duration) : '—'), tip: 'How long the strain keeps its strength before it weakens and burns out.' },
    ])),
    section('Nations struck', nations),
    section('Sick now', sick),
    section('Plague pits', pits),
    section('Strains', strains),
    section('History', chronicleList(app, b, (e) => entryAbout(e, 'plague', p.id, (q) => !q.ref && q.cat === 'disease' && (q.text || '').includes(p.name)))),
  );
}

function stormView(app, sel, b) {
  const w = app.world;
  const get = () => w.storms.find((q) => q.id === sel.id);
  const s0 = get();
  const arch = s0 ? null : stormRecord(w, sel.id);
  if (!s0 && !arch) return missing('That storm has blown itself out, and no record of it was kept.');
  if (!s0) {
    // an archived storm from the catastrophe catalogue (its track is drawn on the map)
    const struck = rows(b, () => (arch.towns || []).map((sid) => w.settlements[sid]).filter(Boolean).map((s) => ({ key: 's' + s.id, icon: 'town', label: s.name, n: s.alive ? F.people(s.population) : 'ruins', sel: { kind: 'settlement', id: s.id } })), 'No town was struck.', app);
    return h('div.tabpanel', null,
      title(b, { icon: arch.k === 'blizzard' ? 'blizzard' : 'storm', name: () => arch.n || F.humanize(arch.k || 'storm'), sub: () => `${F.stormClass(arch.k, arch.m)} · ${F.monthYear(arch.d)}`, actions: standardActions(app) }),
      h('p.ins-lead', { text: `${F.headName(arch.n || 'The storm')} blew itself out in ${F.monthYear(arch.d)}${arch.lf ? ` after ${F.int(arch.lf)} landfall${arch.lf === 1 ? '' : 's'}` : ''}${arch.dead ? `, leaving ${F.people(arch.dead)} dead` : ''}. Its track is drawn on the map.` }),
      cells(b, [
        { k: 'Category', v: () => (arch.m > 0 ? String(Math.round(arch.m)) : '—'), s: () => (arch.pk ? `peak ${F.pct(arch.pk)}` : '') },
        { k: 'Landfalls', v: () => F.int(arch.lf || 0) },
        { k: 'Dead', v: () => F.people(arch.dead || 0) },
      ]),
      section('Towns struck', struck),
    );
  }
  const s = () => get() || s0;
  const struck = rows(b, () => (s().damaged || []).map((d) => ({ key: 'd' + d.sid + ':' + d.killed, icon: 'town', label: d.name || w.settlements[d.sid]?.name || 'a town', n: d.killed ? F.people(d.killed) + ' dead' : '', s: d.gone ? 'destroyed' : '', sel: { kind: 'settlement', id: d.sid } })), 'No town struck yet.', app);
  return h('div.tabpanel', null,
    title(b, { icon: s0.kind === 'blizzard' ? 'blizzard' : s0.kind === 'thunderstorm' ? 'lightning' : 'storm', name: () => s().name || F.humanize(s().kind || 'storm'), sub: () => (!get() ? 'Dissipated' : F.stormClass(s().kind, s().category)), actions: standardActions(app, { follow: true }) }),
    cells(b, [
      { k: 'Intensity', v: () => F.pct(s().intensity), s: () => (ok(s().peak) ? `peak ${F.pct(s().peak)}` : '') },
      { k: 'Landfalls', v: () => F.int(s().landfalls || 0), s: () => `reach ${F.km(s().radius || 0)}` },
      { k: 'Dead', v: () => F.people(s().deaths || 0), s: () => `age ${F.span(s().age || 0)}` },
    ]),
    section('Track', kv(b, [
      { k: 'Category', v: () => (fin(s().category) > 0 ? `${Math.round(s().category)}` : 'Below cyclone strength') },
      { k: 'Position', v: () => F.latLon(w, s().x, s().y) },
      { k: 'Heading', v: () => F.wind(s().vx || 0, s().vy || 0).toward || '—' },
      // a storm lives on past its expected span while it fades (it ends a few days later, or when it weakens away)
      { k: 'Lifespan', v: () => { const a = s().age || 0, m = s().maxAge; return !ok(m) ? '—' : a > m ? `${stormDays(a)} · spent, fading` : `${stormDays(a)} of about ${stormDays(m)}`; }, m: () => (s().maxAge > 0 ? Math.min(1, (s().age || 0) / (s().maxAge + 4)) : 0) },
      { k: 'Hemisphere', v: () => (s().hemisphere > 0 || s().hemisphere === 'north' ? 'Northern' : 'Southern') },
    ])),
    section('Towns struck', struck),
  );
}

function volcanoView(app, sel, b) {
  const w = app.world;
  const v = w.volcanoes.find((q) => q.id === sel.id);
  if (!v) return missing('That volcano is not in the record.');
  const erupts = rows(b, () => (w.history?.events || []).filter((e) => e.t === 'eruption' && e.ref && e.ref.k === 'volcano' && e.ref.id === v.id).slice(-12).reverse().map((e) => ({ key: 'e' + e.id, icon: 'eruption', label: F.veiWord(e.m), n: e.dead ? F.people(e.dead) + ' dead' : '', s: F.monthYear(e.d), sel: { kind: 'event', id: e.id } })), 'No great eruption is recorded.', app);
  const temperWord = (t) => (!ok(t) ? '—' : t >= 0.55 ? 'Restless and violent' : t >= 0.4 ? 'Uneasy' : t >= 0.25 ? 'Sleepy' : 'Deeply dormant');
  return h('div.tabpanel', null,
    title(b, { icon: 'volcano', name: () => v.name, sub: () => `${F.headName(v.kind || 'volcano')}${v.erupting > 0 ? ' · erupting' : ''}`, actions: standardActions(app) }),
    (() => { const p = h('p.ins-lead'); b.text(p, () => `${F.headName(v.kind || 'A volcano')} of the ${v.setting || 'deep fire'}${v.island ? ', rising from the sea as an island' : ''}; ${!(v.eruptions > 0) ? 'it has not erupted in recorded history' : `it has erupted ${v.eruptions === 1 ? 'once' : F.int(v.eruptions) + ' times'}${v.lastEruption != null ? `, last in ${F.year(v.lastEruption)}` : ''}`}.`); return p; })(),
    cells(b, [
      { k: 'Eruptions', v: () => F.int(v.eruptions || 0) },
      { k: 'Last force', v: () => (ok(v.lastVEI) ? 'VEI ' + v.lastVEI : '—') },
      { k: 'Height', v: () => F.meters(elevationMeters(w, v.i)) },
    ]),
    section('Activity', kv(b, [
      { k: 'Restlessness', v: () => F.pct(v.activity), m: () => v.activity, mc: 'is-danger' },
      { k: 'Temper', v: () => temperWord(v.temper) },
      { k: 'Eruption', v: () => (v.erupting > 0 ? `${F.span(v.erupting)} more` : 'Quiet') },
      { k: 'Last eruption', v: () => (v.lastEruption != null ? F.year(v.lastEruption) : 'None recorded') },
      { k: 'Setting', v: () => F.headName(v.setting || '—') },
      { k: 'Location', v: () => F.latLon(w, v.x, v.y) },
    ])),
    section('Great eruptions', erupts),
    section('History', chronicleList(app, b, (e) => entryAbout(e, 'volcano', v.id, (q) => !q.ref && (q.text || '').includes(v.name)))),
  );
}

export function missing(text) { const n = h('div.tabpanel', null, h('p.empty-note', { text })); MISSING.add(n); return n; }

// ---------------------------------------------------------------------------
// registered views and sections (src/ui/registry.js)

/** A record for a kind some package registered: the standard title bar, then the view's own content. */
function registeredView(app, sel, b, def, handles) {
  const desc = () => {
    if (typeof def.describe !== 'function') return {};
    try { return def.describe(app, sel) || {}; } catch (e) { reportOnce(app, `view.${def.kind}.describe`, e); return {}; }
  };
  const d0 = desc();
  const body = h('div.reg-view');
  const movable = typeof def.point === 'function' || typeof def.frame === 'function';
  const node = h('div.tabpanel', null,
    title(b, { icon: d0.icon || def.icon || def.kind, color: d0.color || null, name: () => desc().name || def.label, sub: () => desc().sub || '', actions: standardActions(app, { follow: movable }) }),
    body);
  const handle = def.mount(app, sel, body) || null;
  keepHandle(app, b, handle, handles, `view.${def.kind}`);
  return node;
}

function keepHandle(app, b, handle, handles, where) {
  if (!handle || typeof handle !== 'object') return;
  handles.push(handle);
  if (typeof handle.update === 'function') b.run(() => { try { handle.update(); } catch (e) { reportOnce(app, where + '.update', e); } });
}

/**
 * Sections other packages registered for this kind (or '*'), in order, before "Developer
 * records" — or, for a section with `after: anchor`, right after the record's block marked
 * data-anchor="anchor" (settlement and civ: 'summary', the figures under the lead; civ:
 * 'people', its people), when the record has one.
 */
function appendSections(app, sel, b, node, handles) {
  const list = sectionsFor(sel.kind);
  if (!list.length) return;
  const more = Array.from(node.children).find((c) => c.matches('details.more')) || null;
  const lastAt = new Map();   // anchor → the last section placed after it (keeps their order)
  for (const def of list) {
    const el = h('section.ins-section', { dataset: { section: def.id } });
    if (typeof def.when === 'function') b.hide(el, () => !def.when(app, sel));
    let handle = null;
    try { handle = def.mount(app, sel, el) || null; } catch (e) { reportOnce(app, `section.${def.id}`, e); continue; }
    keepHandle(app, b, handle, handles, `section.${def.id}`);
    const anchor = typeof def.after === 'string' ? Array.from(node.children).find((c) => c.dataset?.anchor === def.after) || null : null;
    if (anchor) {
      const prev = lastAt.get(def.after) || anchor;
      node.insertBefore(el, prev.nextSibling);
      lastAt.set(def.after, el);
    } else node.insertBefore(el, more);
  }
}
/** Mark a record's block as an anchor registered sections can follow (appendSections). */
function anchored(el, name) { el.dataset.anchor = name; return el; }

// ---------------------------------------------------------------------------
// welcome (nothing selected)

function welcomeView(app, b) {
  const w = app.world;
  const top = rows(b, () => liveCivs(w).slice().sort((a, c) => (c.population || 0) - (a.population || 0)).slice(0, 6).map((c) => ({ key: `${c.id}:${c.name}:${Math.round(Math.log2((c.population || 0) + 1) * 3)}`, swatch: c.colorHex, label: c.name, n: F.people(c.population), s: `${F.titleCase(c.government || 'tribe')} · ${F.eraName(c.tech?.era)}`, sel: { kind: 'civ', id: c.id } })), 'No nation has risen yet.', app);
  const cities = rows(b, () => liveSettlements(w).slice().sort((a, c) => c.population - a.population).slice(0, 5).map((s) => ({ key: `${s.id}:${Math.round(Math.log2(s.population + 1) * 3)}`, icon: 'town', label: s.name, n: F.people(s.population), s: `${F.tierName(s.tier)} of ${w.civs[s.civId]?.name || '—'}`, sel: { kind: 'settlement', id: s.id } })), 'No town stands yet.', app);
  const recent = chronicleList(app, b, (e) => e.imp >= 3 && !e.fold, 6);
  // three of the Hall of Records, to tempt the reader into the Annals
  const HALL = ['city.peak', 'civ.peakLand', 'battle.dead', 'war.dead', 'faith.peak', 'quake.mag'];
  const hall = rows(b, () => {
    const recs = getRecords(w).filter((r) => HALL.includes(r.key) && r.top[0]);
    return recs.slice(0, 4).map((r) => {
      const t = r.top[0];
      return { key: r.key + ':' + t.v + ':' + t.l, icon: 'star', label: `${r.label}: ${F.headName(t.l)}`, n: F.recordValue(r.fmt, t.s ?? t.v, ''), s: `Set in ${F.year(t.d)}`, sel: t.r ? { kind: t.r.k, id: t.r.id } : null, run: !t.r && Number.isFinite(t.x) ? () => app.focus(t.x, t.y, 12) : null };
    });
  }, 'No records have been set yet.', app);
  let touch = false;
  try { touch = window.matchMedia('(pointer: coarse)').matches; } catch (e) { /* assume a mouse */ }
  const keys = touch
    ? [['Tap', 'Inspect a place, town, army or storm'], ['Double-tap', 'Open the nation that holds that ground'], ['Drag', 'Pan the map'], ['Pinch', 'Zoom in and out']]
    : [['Click', 'Inspect a place, town, army or storm'], ['Double-click', 'Open the nation that holds that ground'], ['Drag', 'Pan; the wheel zooms'], ['Space', 'Pause or resume time'], ['R', 'The Annals: every record of this world']];
  const annals = h('button.btn.btn-sm', { type: 'button', text: 'Open the Annals' });
  annals.addEventListener('click', () => { if (app.TABS.includes('annals')) app.setTab('annals'); });
  b.hide(annals, () => !app.TABS.includes('annals'));
  return h('div.welcome', null,
    h('p.lead', { text: `${touch ? 'Tap' : 'Click'} anything on the map to read its record: a stretch of ground, a town, a nation’s lands, an army on the march.` }),
    h('div.keys', null, keys.map(([k, d]) => [h('span', null, h('kbd', { text: k })), h('span', { text: d })])),
    section('Largest nations', top),
    section('Greatest cities', cities),
    section('Recent great events', recent),
    section('Records of this world', hall),
    section('This world', kv(b, [
      { k: 'Seed', v: () => w.seed },
      { k: 'Map', v: () => `${w.W} × ${w.H} tiles (${F.int(w.W * 20)} × ${F.int(w.H * 20)} km)` },
      { k: 'Age', v: () => F.span(w.time.day) },
      { k: 'Today', v: () => dateString(w) },
    ]), annals),
  );
}

// ---------------------------------------------------------------------------

const VIEWS = { tile: tileView, settlement: settlementView, civ: civView, army: armyView, war: warView, religion: religionView, plague: plagueView, storm: stormView, volcano: volcanoView };
const KIND_LABEL = { tile: 'Ground', settlement: 'Settlement', civ: 'Nation', army: 'Army', war: 'War', religion: 'Faith', plague: 'Plague', storm: 'Storm', volcano: 'Volcano' };

export function createInspector(app) {
  const el = h('div.tabpanel');
  let binder = null;
  let built = null;
  let handles = [];     // what registered views and sections returned from mount()
  let dirty = false;    // a registration changed what the current record should show

  function teardown() {
    for (const hd of handles) {
      if (typeof hd.destroy === 'function') { try { hd.destroy(); } catch (e) { app.reportError('inspector.destroy', e); } }
    }
    handles = [];
  }

  function build() {
    teardown();
    dirty = false;
    clear(el);
    binder = new Binder();
    const w = app.world;
    const sel = app.selection;
    if (!w) { el.appendChild(h('p.empty-note', { text: 'No world yet.' })); built = null; return; }
    if (sel && app.history.length) {
      const prev = app.history[app.history.length - 1];
      const back = h('button.btn.btn-sm.btn-quiet', { type: 'button' }, svgEl(glyph('back', 14)), `Back to ${describe(app, prev)}`);
      back.addEventListener('click', () => app.back());
      el.appendChild(h('div.crumbs', null, back));
    }
    let node;
    cur = { app, sel, b: binder };
    try {
      const reg = sel && !VIEWS[sel.kind] ? getView(sel.kind) : null;
      node = sel ? (VIEWS[sel.kind] ? VIEWS[sel.kind](app, sel, binder) : reg ? registeredView(app, sel, binder, reg, handles) : missing('Nothing to show for this selection.')) : welcomeView(app, binder);
      if (sel && !MISSING.has(node)) appendSections(app, sel, binder, node, handles);
    } catch (e) {
      app.reportError('inspector', e);
      node = missing(`This record could not be shown: ${e.message}`);
    } finally {
      cur = null;
    }
    el.appendChild(node);
    built = sel ? `${sel.kind}:${sel.id}` : 'welcome';
    binder.update();
  }

  // canvases in a record (the life charts) take their colours from the theme
  app.on('theme', () => { if (app.world && app.selection && app.tab === 'inspector') build(); });
  // a view, section or title action registered (or removed) later: rebuild at the next refresh
  onRegistryChange((kind) => { if (kind === 'view' || kind === 'section' || kind === 'titleAction') dirty = true; });

  return {
    id: 'inspector', label: 'Dossier', title: 'Dossier', icon: 'inspect', el,
    headTitle() { const s = app.selection; return s ? `Dossier · ${KIND_LABEL[s.kind] || getView(s.kind)?.label || 'Record'}` : 'Dossier'; },
    show() { const s = app.selection; const key = s ? `${s.kind}:${s.id}` : 'welcome'; if (key !== built || dirty) build(); else binder?.update(); },
    refresh() { if (dirty && app.world) build(); else binder?.update(); },
    onSelect() { build(); (el.closest('.panel-scroll') || el.parentElement)?.scrollTo?.({ top: 0 }); },   // the scroller is the panel's, not the pane
    onWorld() { build(); },
  };
}

function describe(app, sel) {
  const w = app.world;
  if (!sel || !w) return 'previous';
  switch (sel.kind) {
    case 'settlement': return w.settlements[sel.id]?.name || 'settlement';
    case 'civ': return w.civs[sel.id]?.name || 'nation';
    case 'war': return F.midName(w.wars[sel.id]?.name) || 'war';
    case 'religion': return w.religions[sel.id]?.name || 'faith';
    case 'plague': return w.plagues[sel.id]?.name || 'plague';
    case 'volcano': return w.volcanoes.find((q) => q.id === sel.id)?.name || 'volcano';
    default: {
      if (KIND_LABEL[sel.kind]) return KIND_LABEL[sel.kind].toLowerCase();
      const v = getView(sel.kind);
      if (!v) return 'previous';
      try { const d = typeof v.describe === 'function' ? v.describe(app, sel) : null; if (d?.name) return d.name; } catch (e) { /* fall back to the label */ }
      return String(v.label || 'previous').toLowerCase();
    }
  }
}
