// Mixed peoples (Mythic) for the instrument panels: who lives in a town, a realm, a continent
// and the world, race by race (docs/design/mixed-peoples.md, "UI and render"). The numbers come from
// the sim's published helpers (src/sim/myth/index.js: townPeoples, civPeoples, landPeoples,
// worldPeoples, peoplesHistory) behind a guarded import; while a build lacks them, a small
// fallback reads a town as its `s.peoples` when present, else as one people ({ [s.race]: 1 }).
// The shared pieces every view draws them with live here too:
//   wholePct(items)          whole percentages that sum to 100 (every people present ≥ 1)
//   peoplesBar(opts)         a stacked bar in the races' colours (RACE_META), updated in place
//   peoplesLegend(…)         rows of symbol, name, share, headcount and notes
//   drawMixChart(canvas, …)  the makeup over the years as a stacked area
//   mixPhrase(items, n)      "62% Human · 30% Elf"
// Everything is hidden outside Mythic worlds (peoplesOn). Read-only and pure: nothing here
// writes the world; the fallback's cache lives in a WeakMap keyed by the world, by month.

import { RACE_META, RACE_KEYS, DAYS_PER_YEAR } from '../core/constants.js';
import { liveSettlements } from '../core/entities.js';
import { h, svgEl, cssVar } from './dom.js';
import * as F from './format.js';

let mythMod = null;
try { mythMod = await import('../sim/myth/index.js'); } catch (e) { /* no myth module: the fallback reads s.race */ }

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const fn = (k) => (mythMod && typeof mythMod[k] === 'function' ? mythMod[k] : null);

/** True when the sim publishes its own peoples helpers (else the one-people fallback is used). */
export const hasPeoplesHelpers = () => Boolean(fn('townPeoples') && fn('civPeoples') && fn('worldPeoples'));

/** A Mythic world whose myth is awake: the only worlds that show peoples. */
export const peoplesOn = (w) => Boolean(w && w.params && w.params.mythLevel >= 2 && w.sys?.myth?.v != null);

// ---------------------------------------------------------------------------
// Reading the sim (helpers, else the fallback)

const RACE_SET = new Set(RACE_KEYS);
const fallbackCache = new WeakMap();   // world → { key, towns: Map(sid → items), civ: Map, land: Map, world }
function fbBag(w) {
  const key = `${Math.floor(w.time.day / 30)}|${w.versions?.settlements ?? 0}|${w.versions?.owner ?? 0}|${w.versions?.peoples ?? 0}`;
  let b = fallbackCache.get(w);
  if (!b || b.key !== key) { b = { key, towns: new Map(), civ: new Map(), land: new Map(), world: null }; fallbackCache.set(w, b); }
  return b;
}
function fbTown(w, s) {
  if (!s) return [];
  const b = fbBag(w);
  let v = b.towns.get(s.id);
  if (v) return v;
  const out = [];
  if (s.peoples && typeof s.peoples === 'object') {
    let sum = 0;
    for (const [r, sh] of Object.entries(s.peoples)) if (RACE_SET.has(r) && fin(sh) > 0) { out.push({ race: r, share: fin(sh) }); sum += fin(sh); }
    if (sum > 0) for (const it of out) it.share /= sum;
  }
  if (!out.length) {
    const r = s.race || w.civs[s.civId]?.race;
    if (r && RACE_SET.has(r)) out.push({ race: r, share: 1 });
  }
  out.sort((a, c) => c.share - a.share || RACE_KEYS.indexOf(a.race) - RACE_KEYS.indexOf(c.race));
  b.towns.set(s.id, out);
  return out;
}
function fbSum(w, towns) {
  const acc = new Map();
  let total = 0;
  for (const s of towns) {
    const p = Math.max(0, fin(s.population));
    const mix = fbTown(w, s);
    for (const it of mix) {
      let a = acc.get(it.race);
      if (!a) acc.set(it.race, (a = { race: it.race, share: 0, pop: 0, towns: 0 }));
      a.pop += p * it.share;
    }
    if (mix[0]) { let a = acc.get(mix[0].race); if (!a) acc.set(mix[0].race, (a = { race: mix[0].race, share: 0, pop: 0, towns: 0 })); a.towns++; }
    total += p;
  }
  const out = [...acc.values()].filter((a) => a.pop > 0 || a.towns > 0);
  for (const a of out) a.share = total > 0 ? a.pop / total : 0;
  return out.sort((a, c) => c.pop - a.pop || RACE_KEYS.indexOf(a.race) - RACE_KEYS.indexOf(c.race));
}

/** [{ race, share }] of a town, sorted by share; [] outside Mythic worlds. */
export function townMix(w, s) {
  if (!peoplesOn(w) || !s) return [];
  const f = fn('townPeoples');
  if (f) { try { const r = f(w, s); if (Array.isArray(r)) return r; } catch (e) { /* fall through */ } }
  return s.alive === false ? [] : fbTown(w, s);
}

/** [{ race, share, pop, towns }] of a realm's living towns (towns = where the race dominates). */
export function realmMix(w, civ) {
  if (!peoplesOn(w) || !civ) return [];
  const f = fn('civPeoples');
  if (f) { try { const r = f(w, civ); if (Array.isArray(r)) return r; } catch (e) { /* fall through */ } }
  const b = fbBag(w);
  let v = b.civ.get(civ.id);
  if (!v) {
    const towns = [];
    for (const sid of civ.settlementIds || []) { const s = w.settlements[sid]; if (s && s.alive) towns.push(s); }
    v = fbSum(w, towns);
    b.civ.set(civ.id, v);
  }
  return v;
}

/** Same shape over a continent: `lm` is a landmass id (world.f.landmass value). */
export function landMix(w, lm) {
  if (!peoplesOn(w) || !(lm >= 0)) return [];
  const f = fn('landPeoples');
  if (f) { try { const r = f(w, lm); if (Array.isArray(r)) return r; } catch (e) { /* fall through */ } }
  const b = fbBag(w);
  let v = b.land.get(lm);
  if (!v) {
    const L = w.f.landmass;
    v = fbSum(w, liveSettlements(w).filter((s) => L && L[s.i] === lm));
    b.land.set(lm, v);
  }
  return v;
}

/** Same shape over the whole world. */
export function worldMix(w) {
  if (!peoplesOn(w)) return [];
  const f = fn('worldPeoples');
  if (f) { try { const r = f(w); if (Array.isArray(r)) return r; } catch (e) { /* fall through */ } }
  const b = fbBag(w);
  if (!b.world) b.world = fbSum(w, liveSettlements(w));
  return b.world;
}

/** [[year, { race: pct }] …] for kind 'civ' (by id) or 'world'; [] while unknown. */
export function mixHistory(w, kind, id) {
  if (!peoplesOn(w)) return [];
  const f = fn('peoplesHistory');
  if (f) { try { const r = f(w, kind, id); if (Array.isArray(r)) return r; } catch (e) { /* none */ } }
  const mix = w.sys?.myth?.mix;
  const ser = kind === 'world' ? mix?.w : mix?.c?.[id];
  return Array.isArray(ser) ? ser : [];
}

/**
 * The town's mix about `years` ago, when anyone knows it: the sim's own memory (its
 * townPeoplesPast helper, from the town's decade samples), else, in a build without it, what
 * this viewer's session saw (sampled each decade while the panels run).
 * → { year, items: [{ race, share }] } | null
 */
export function townMixPast(w, s, years = 50) {
  if (!peoplesOn(w) || !s) return null;
  const f = fn('townPeoplesPast');
  if (f) { try { const r = f(w, s, years); if (r && Array.isArray(r.items)) return r; } catch (e) { /* none */ } }
  const mem = memory.get(w);
  const ring = mem && mem.towns.get(s.id);
  if (!ring || !ring.length) return null;
  const now = Math.floor(w.time.day / DAYS_PER_YEAR);
  let best = null;
  for (const [y, pct] of ring) {
    const age = now - y;
    if (age < years * 0.8 || age > years * 1.4) continue;
    if (!best || Math.abs(age - years) < Math.abs(now - best[0] - years)) best = [y, pct];
  }
  if (!best) return null;
  const items = Object.entries(best[1]).map(([race, p]) => ({ race, share: p / 100 })).sort((a, c) => c.share - a.share);
  return { year: best[0], items };
}

// The session's own memory of town mixes, a sample per decade (only what this viewer saw run).
const memory = new WeakMap();   // world → { y: last decade sampled, towns: Map(sid → [[year, {race: pct}] …]) }
/** Sample every living town's mix once per decade (cheap: O(towns)); call from the UI tick. */
export function sampleTownMixes(w) {
  if (!peoplesOn(w) || fn('townPeoplesPast')) return;
  const dec = Math.floor(w.time.day / DAYS_PER_YEAR / 10);
  let mem = memory.get(w);
  if (!mem) memory.set(w, (mem = { y: -1, towns: new Map() }));
  if (mem.y === dec) return;
  mem.y = dec;
  const year = dec * 10;
  for (const s of liveSettlements(w)) {
    const items = townMix(w, s);
    if (!items.length) continue;
    const pct = {};
    for (const it of items) pct[it.race] = Math.round(it.share * 100);
    let ring = mem.towns.get(s.id);
    if (!ring) mem.towns.set(s.id, (ring = []));
    if (ring.length && ring[ring.length - 1][0] === year) continue;
    ring.push([year, pct]);
    if (ring.length > 8) ring.shift();
  }
}

// ---------------------------------------------------------------------------
// Numbers and words

/**
 * Whole percentages for shares (in the items' order) that sum to exactly 100: largest
 * remainders, and every people present shows at least 1 % (taken from the largest).
 */
export function wholePct(items) {
  const n = items.length;
  if (!n) return [];
  let sum = 0;
  for (const it of items) sum += Math.max(0, fin(it.share));
  if (!(sum > 0)) return items.map(() => 0);
  const raw = items.map((it) => (100 * Math.max(0, fin(it.share))) / sum);
  const out = raw.map((v) => Math.floor(v));
  let left = 100 - out.reduce((a, v) => a + v, 0);
  const order = raw.map((v, k) => [v - Math.floor(v), k]).sort((a, c) => c[0] - a[0] || a[1] - c[1]);
  for (let q = 0; left > 0 && q < order.length; q++, left--) out[order[q][1]]++;
  for (let k = 0; k < n; k++) {
    if (out[k] > 0 || !(raw[k] > 0)) continue;
    let big = 0;
    for (let j = 1; j < n; j++) if (out[j] > out[big]) big = j;
    if (out[big] > 1) { out[big]--; out[k] = 1; }
  }
  return out;
}

/** "about 4,200": a headcount to two significant figures, formatted like the Inspector's. */
export function approxPeople(v) {
  const n = Math.max(0, fin(v));
  if (n < 1) return '0';
  if (n < 100) return F.people(Math.round(n / 5) * 5 || Math.round(n));
  const p = Math.pow(10, Math.floor(Math.log10(n)) - 1);
  const r = Math.round(n / p) * p;
  // compact without a trailing .0 once it is large (410k, 1.2M), grouped below (4,200)
  return r >= 1e5 ? F.axis(r) : F.people(r);
}

export const raceRgbOf = (r) => RACE_META[r]?.color || [150, 140, 128];
export const raceCss = (r, a = 1) => { const c = raceRgbOf(r); return a >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`; };
const label = (r, plural) => (RACE_META[r] ? (plural ? RACE_META[r].plural : RACE_META[r].label) : 'Others');

/** "62% Human · 30% Elf · 8% Orc" for the first n peoples (shares rounded over all of them). */
export function mixPhrase(items, n = 3, sep = ' · ') {
  const p = wholePct(items);
  return items.slice(0, n).map((it, k) => `${p[k]}% ${label(it.race, false)}`).join(sep);
}

/** A short signature of a mix (for keyed lists): races and whole percentages. */
export const mixKey = (items) => { const p = wholePct(items); return items.map((it, k) => `${it.race}${p[k]}`).join(','); };

/** The adjective of a race, lower case ("elven"). */
export const raceAdjLower = (r) => (RACE_META[r]?.adjective || '').toLowerCase();

// ---------------------------------------------------------------------------
// Drawing: the race symbol, the stacked bar, the legend

/** Race symbols (RACE_META.symbol) as small filled glyphs on a 24-unit grid. */
export const RACE_GLYPH = {
  round: '<circle cx="12" cy="12" r="6"/>',
  leaf: '<path d="M6 18C6 10.5 10.5 6 18 6c0 7.5-4.5 12-12 12z"/><path d="M6 18l7-7" stroke-width="1.1"/>',
  diamond: '<path d="M12 3.5l6.5 8.5-6.5 8.5L5.5 12z"/><path d="M5.5 12h13" stroke-width="1"/>',
  spike: '<path d="M12 3.5l7.5 15h-15z"/><path d="M12 9v5" stroke-width="1.1"/>',
  mound: '<path d="M3.5 17.5c1.6-6 4.6-9 8.5-9s6.9 3 8.5 9z"/><circle cx="12" cy="14" r="1.8"/>',
  scale: '<path d="M5 7c2 9 5 12 7 12s5-3 7-12c-2.3 2-4.6 3-7 3S7.3 9 5 7z"/>',
};

/** The race's symbol on a disc of its colour (a legend key). */
export function raceDot(race, size = 16) {
  const meta = RACE_META[race];
  const inner = RACE_GLYPH[meta?.symbol] || RACE_GLYPH.round;
  const s = Math.round(size * 0.72);
  return h('span.pp-dot', { style: { '--rc': raceCss(race), width: size + 'px', height: size + 'px' }, 'aria-hidden': 'true' },
    svgEl(`<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`));
}

/**
 * A stacked bar of a mix: one segment per people in its colour, widths by share. Returns the
 * element; set(items) redraws it in place (only when the whole percentages change).
 * opts: { size: 'lg' | 'md' | 'sm', label: aria label prefix }
 */
export function peoplesBar(opts = {}) {
  const el = h('div.pp-bar', { class: opts.size ? 'is-' + opts.size : '', role: 'img' });
  let last = null;
  el.set = (items) => {
    const k = mixKey(items || []);
    if (k === last) return el;
    last = k;
    while (el.firstChild) el.removeChild(el.firstChild);
    const list = items || [];
    const p = wholePct(list);
    list.forEach((it, j) => {
      if (!(p[j] > 0)) return;
      el.appendChild(h('span.pp-seg', { style: { '--rc': raceCss(it.race), flexGrow: String(Math.max(0.0001, fin(it.share))) }, dataset: { race: it.race } }));
    });
    const txt = list.map((it, j) => `${label(it.race, true)} ${p[j]}%`).join(', ');
    el.setAttribute('aria-label', (opts.label ? opts.label + ': ' : '') + (txt || 'no people'));
    el.title = txt;
    el.classList.toggle('is-empty', !list.length);
    return el;
  };
  return el;
}

/**
 * Legend rows for a mix: symbol, name, whole percentage, then `extra(it)` (headcount, towns,
 * notes) in a quiet second column. items: [{ race, share, … }].
 */
export function legendRows(items, { extra = null, mark = null, plural = true } = {}) {
  const p = wholePct(items);
  const box = h('div.pp-legend');
  items.forEach((it, k) => {
    const tag = mark ? mark(it) : null;
    const x = extra ? extra(it) : '';
    // symbol | name (and the quiet details, which wrap under it on a narrow panel) | share
    box.appendChild(h('div.pp-row', { dataset: { race: it.race } },
      raceDot(it.race, 16),
      h('span.pp-mid', null,
        h('span.pp-name', null, label(it.race, plural), tag ? h('span.pp-tag', { text: tag }) : null),
        x ? h('span.pp-x', { text: x }) : null),
      h('span.pp-pct', { text: `${p[k]}%` }),
    ));
  });
  return box;
}

/** The hover card's line: a thin bar and the first three peoples ("62% Human · 30% Elf"). */
export function hoverPeoples(items) {
  if (!items || !items.length) return null;
  const bar = peoplesBar({ size: 'sm' }).set(items);
  return h('div.hc-pp', null, bar, h('span.hc-pp-t', { text: mixPhrase(items, 3) }));
}

// ---------------------------------------------------------------------------
// The makeup over time

/**
 * Draw a stacked-area chart of mixes over the years onto a canvas sized by CSS.
 * series: [[year, { race: pct }] …] (pct 0–100, or any non-negative weights). Races stack in
 * RACE_KEYS order (humans at the bottom), each band in its colour, with a hairline between
 * bands so neighbours of a similar hue stay apart. Empty or one-sample series show a note.
 */
export function drawMixChart(canvas, series, { empty = 'The record of its peoples begins after a decade.' } = {}) {
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const cssW = canvas.clientWidth || 300, cssH = canvas.clientHeight || 90;
  const W = Math.round(cssW * dpr), H = Math.round(cssH * dpr);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const pad = { l: 3, r: 3, t: 4, b: 15 };
  const gw = cssW - pad.l - pad.r, gh = cssH - pad.t - pad.b;
  const ink3 = cssVar('--ink-3', '#8f8877');
  ctx.strokeStyle = cssVar('--chart-grid', 'rgba(237,227,203,0.07)');
  ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) { const y = Math.round(pad.t + (gh * k) / 4) + 0.5; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + gw, y); ctx.stroke(); }
  const pts = (series || []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && p[1] && typeof p[1] === 'object');
  if (pts.length < 2) {
    ctx.fillStyle = ink3;
    ctx.font = 'italic 12.5px "IM Fell English", Georgia, serif';
    ctx.textAlign = 'center';
    ctx.fillText(empty, cssW / 2, pad.t + gh / 2 + 4);
    return;
  }
  const y0 = pts[0][0], y1 = pts[pts.length - 1][0];
  const X = (y) => pad.l + (y1 > y0 ? ((y - y0) / (y1 - y0)) * gw : 0);
  const tot = pts.map((p) => { let t = 0; for (const v of Object.values(p[1])) t += Math.max(0, fin(v)); return t; });
  const base = new Float64Array(pts.length);
  const tops = [];
  for (const r of RACE_KEYS) {
    const top = pts.map((p, k) => base[k] + (tot[k] > 0 ? Math.max(0, fin(p[1][r])) / tot[k] : 0));
    if (top.every((v, k) => v - base[k] < 1e-4)) continue;
    ctx.fillStyle = raceCss(r, 0.9);
    ctx.beginPath();
    pts.forEach((p, k) => { const x = X(p[0]), y = pad.t + gh * (1 - top[k]); if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    for (let k = pts.length - 1; k >= 0; k--) ctx.lineTo(X(pts[k][0]), pad.t + gh * (1 - base[k]));
    ctx.closePath(); ctx.fill();
    tops.push(top.slice());
    for (let k = 0; k < pts.length; k++) base[k] = top[k];
  }
  // hairlines between the bands
  ctx.strokeStyle = 'rgba(20,16,12,0.35)'; ctx.lineWidth = 0.8;
  for (const top of tops.slice(0, -1)) {
    ctx.beginPath();
    pts.forEach((p, k) => { const x = X(p[0]), y = pad.t + gh * (1 - top[k]); if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.stroke();
  }
  ctx.fillStyle = ink3;
  ctx.font = '10.5px "IBM Plex Mono", ui-monospace, Menlo, monospace';
  ctx.textAlign = 'left'; ctx.fillText(`Y${y0}`, pad.l, cssH - 3);
  ctx.textAlign = 'right'; ctx.fillText(`Y${y1}`, pad.l + gw, cssH - 3);
}

/** The change between two mixes as words: "humans 70% → 58%, elves 22% → 31%" (≥ 3 points). */
export function mixChange(before, now, min = 3) {
  const pb = wholePct(before), pn = wholePct(now);
  const a = new Map(before.map((it, k) => [it.race, pb[k]]));
  const b = new Map(now.map((it, k) => [it.race, pn[k]]));
  const races = RACE_KEYS.filter((r) => a.has(r) || b.has(r));
  const moves = races.map((r) => ({ r, from: a.get(r) || 0, to: b.get(r) || 0 })).filter((m) => Math.abs(m.to - m.from) >= min);
  moves.sort((p, q) => Math.abs(q.to - q.from) - Math.abs(p.to - p.from));
  return moves.slice(0, 3).map((m) => (m.from === 0 ? `${label(m.r, true).toLowerCase()} arrived (${m.to}%)` : m.to === 0 ? `${label(m.r, true).toLowerCase()} gone (were ${m.from}%)` : `${label(m.r, true).toLowerCase()} ${m.from}% → ${m.to}%`));
}
