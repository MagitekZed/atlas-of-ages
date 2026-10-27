// The hand's ledger (chunk 10, docs/design/seeing-and-hand.md): every act of the divine hand,
// measured the moment before it, the moment after, when its work is done and a generation later,
// each time beside the same measures for the whole world, so a report can say what came of it.
// An observer: it reads the world, never draws on its chance, and writes only world.sys.hand and
// its own Chronicle lines (key 'hand.report'), which no system reads back for its choices.
//
//   world.sys.hand = { v, n (acts so far), acts: [act] (the last 150), refused: { tool: { reason: n } },
//                      next (the first day a report is due) }
//   act = { id, seq (its intervention, for undo and the deed card), tool, grp, kind ('area' |
//           'town' | 'realm' | 'pair'), day, x, y, r, pts (a stroke's points, ≤ 24), tgt, a, b
//           (pair targets), str (strength), land (the kind of land at the spot), name (the place),
//           sids (a point power's towns, as its forecast named them),
//           m0 (before: { m: [measures], w: [the world's] }), m1 (right after: { m }), end, gen
//           ({ day, m, w } once reported), endDay, genDay, eff (true when the end is a timed
//           effect's); beyond the newest 40, an act with both reports in is folded: its measures
//           go and L = { n, e, g: [[measure index, change]] } (at once, at its end against the
//           world, a generation on) keeps what the lessons read (c: 1) }
// Measures by kind (MEASURES below): the land in the brush and its towns; a town; a realm; or two
// of them and the opinion between. A report is due when the timed effect the act set ends (else 2
// year for the sky (one harvest), 2 for catastrophes, 5 for the rest) and 25 years after the act.
//
// Hooks: toolApplying (before: measure), toolApplied (after: the act, or a refusal counted, or a
// stroke's next point). Exports: system, MEASURES, actOf, reportText, reportRows, whenWords, shareWords,
// levelWords, focusOf, changeOf

import { on } from '../core/hooks.js';
import { getTool, previewTool } from '../core/tools.js';
import { chronicle } from '../core/chronicle.js';
import { DAYS_PER_YEAR as DPY, WATER, BIOME } from '../core/constants.js';

const CAP = 150;
const FULL = 40;   // the newest acts keep every measure; older ones, both reports in, keep their lessons (fold)
const GEN = 25;
const SPAN = { weather: 1, catastrophe: 2, life: 5, peoples: 5, fate: 5, myth: 5, terrain: 5 };
const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const r3 = (v) => { const x = fin(v); return Math.abs(x) >= 100 ? Math.round(x) : Math.round(x * 1000) / 1000; };

/**
 * What each kind of act measures: [id, words, how] where how is 'q' (a quantity, told as a change
 * in hundredths against the world's), 'l' (a level from 0 to 1, told as from and to) or 'n' (a count).
 */
export const MEASURES = {
  area: [['rain', 'rain', 'q'], ['soil', 'the soil’s water', 'l'], ['veg', 'plant growth', 'q'], ['herds', 'the herds', 'q'], ['fish', 'the fish', 'q'],
    ['people', 'people', 'q'], ['harvest', 'harvests', 'q'], ['food', 'food in store', 'q'], ['unrest', 'unrest', 'l'], ['towns', 'towns', 'n']],
  town: [['people', 'people', 'q'], ['harvest', 'harvests', 'q'], ['food', 'food in store', 'q'], ['wealth', 'wealth', 'q'], ['health', 'health', 'l'],
    ['happiness', 'happiness', 'l'], ['unrest', 'unrest', 'l']],
  realm: [['people', 'people', 'q'], ['towns', 'towns', 'n'], ['treasury', 'the treasury', 'q'], ['stability', 'stability', 'l'], ['legitimacy', 'legitimacy', 'l'],
    ['techs', 'inventions known', 'n'], ['wars', 'wars under way', 'n'], ['ruler', 'ruler', 'id']],
};

const LAND = (() => {
  const g = {};
  for (const [k, v] of Object.entries({ WETLAND: 'wetland', STEPPE: 'steppe', SAVANNA: 'savanna', SHRUBLAND: 'dry scrub', HOT_DESERT: 'desert', COLD_DESERT: 'cold desert',
    TEMPERATE_FOREST: 'forest', TEMPERATE_RAINFOREST: 'forest', TROPICAL_FOREST: 'forest', RAINFOREST: 'jungle', TAIGA: 'taiga', TUNDRA: 'tundra', ICE: 'ice',
    ALPINE: 'mountains', OCEAN: 'sea', DEEP_OCEAN: 'open sea', LAKE: 'lake' })) g[BIOME[k]] = v;
  return g;
})();

const stateOf = (world) => {
  const st = (world.sys.hand ||= { v: 1, n: 0, acts: [], refused: {}, next: Infinity });
  if (!Array.isArray(st.acts)) st.acts = [];
  if (!st.refused || typeof st.refused !== 'object') st.refused = {};
  if (!Number.isFinite(st.next)) st.next = Infinity;
  return st;
};

// ---------------------------------------------------------------------------
// Measuring

/** Tiles within r of any of the points (each once). */
function tilesNear(world, pts, r) {
  const W = world.W, H = world.H, out = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const R = Math.max(0.5, r), R2 = (R + 0.5) * (R + 0.5);
  for (let y = Math.max(0, Math.floor(y0 - R)); y <= Math.min(H - 1, Math.ceil(y1 + R)); y++) {
    for (let x = Math.max(0, Math.floor(x0 - R)); x <= Math.min(W - 1, Math.ceil(x1 + R)); x++) {
      for (const [px, py] of pts) { const dx = x - px, dy = y - py; if (dx * dx + dy * dy <= R2) { out.push(y * W + x); break; } }
    }
  }
  return out;
}

const potOf = (s) => (s.flags && Array.isArray(s.flags.pot) ? fin(s.flags.pot[2]) : 0);

/** The towns' part of an area or world measure: [people, harvest, food, unrest (people-weighted), towns]. */
function townsPart(towns) {
  let pop = 0, harvest = 0, food = 0, unrest = 0, n = 0;
  for (const s of towns) {
    if (!s || !s.alive) continue;
    const p = Math.max(0, fin(s.population));
    pop += p; harvest += potOf(s); food += Math.max(0, fin(s.food)); unrest += p * fin(s.unrest); n++;
  }
  return [pop, harvest, food, pop > 0 ? unrest / pop : 0, n];
}

function measureArea(world, pts, r, sids = null) {
  const f = world.f;
  let rain = 0, soil = 0, veg = 0, herds = 0, nl = 0, fish = 0, nw = 0;
  const towns = new Set(Array.isArray(sids) ? sids : []);
  for (const i of tilesNear(world, pts, r)) {
    if (f.water[i] === WATER.LAND) { rain += f.annRain[i]; soil += f.soilWater[i]; veg += f.veg[i]; herds += f.herb[i]; nl++; }
    else { fish += f.fish[i]; nw++; }
    const sid = f.ownerSettle[i];
    if (sid >= 0) towns.add(sid);
  }
  const tp = townsPart([...towns].sort((a, b) => a - b).map((sid) => world.settlements[sid]));
  return [nl ? rain / nl : 0, nl ? soil / nl : 0, nl ? veg / nl : 0, nl ? herds / nl : 0, nw ? fish / nw : 0, ...tp].map(r3);
}

/** The world's area measure: the same means over all land and water, the same towns' totals. */
function worldArea(world) {
  const c = (world.cache.hand ||= {});
  if (c.areaDay === world.time.day && c.area) return c.area;
  const f = world.f, N = world.N;
  let rain = 0, soil = 0, veg = 0, herds = 0, nl = 0, fish = 0, nw = 0;
  for (let i = 0; i < N; i++) {
    if (f.water[i] === WATER.LAND) { rain += f.annRain[i]; soil += f.soilWater[i]; veg += f.veg[i]; herds += f.herb[i]; nl++; } else { fish += f.fish[i]; nw++; }
  }
  const tp = townsPart(world.settlements);
  c.areaDay = world.time.day;
  c.area = [nl ? rain / nl : 0, nl ? soil / nl : 0, nl ? veg / nl : 0, nl ? herds / nl : 0, nw ? fish / nw : 0, ...tp].map(r3);
  return c.area;
}

function measureTown(s) {
  if (!s || !s.alive) return [0, 0, 0, 0, 0, 0, 0];
  return [fin(s.population), potOf(s), fin(s.food), fin(s.wealth), fin(s.health), fin(s.happiness), fin(s.unrest)].map(r3);
}
function worldTown(world) {
  let n = 0;
  const sum = [0, 0, 0, 0, 0, 0, 0];
  for (const s of world.settlements) { if (!s || !s.alive) continue; const m = measureTown(s); for (let k = 0; k < 7; k++) sum[k] += m[k]; n++; }
  return sum.map((v) => r3(n ? v / n : 0));
}

function measureRealm(world, c) {
  if (!c || !c.alive) return [0, 0, 0, 0, 0, 0, 0, -1];
  let wars = 0;
  for (const war of world.wars) if (war && war.active && (war.attackers.includes(c.id) || war.defenders.includes(c.id))) wars++;
  return [fin(c.population), c.settlementIds.length, fin(c.treasury), fin(c.stability), fin(c.legitimacy), Object.keys(c.tech?.known || {}).length, wars, c.ruler ? fin(c.ruler.id, -1) : -1].map(r3);
}
function worldRealm(world) {
  let n = 0;
  const sum = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const c of world.civs) { if (!c || !c.alive) continue; const m = measureRealm(world, c); for (let k = 0; k < 7; k++) sum[k] += m[k]; n++; }
  sum[7] = -1;
  return sum.map((v, k) => (k === 7 ? -1 : r3(n ? v / n : 0)));
}

/** The kind of measure for a reference { kind, id, x, y }. */
const refKind = (t) => (t && t.kind === 'civ' ? 'realm' : t && t.kind === 'settlement' ? 'town' : 'area');

function measureRef(world, t, r = 3) {
  if (!t) return [];
  if (t.kind === 'civ') return measureRealm(world, world.civs[t.id]);
  if (t.kind === 'settlement') return measureTown(world.settlements[t.id]);
  return Number.isFinite(t.x) ? measureArea(world, [[t.x, t.y]], r) : [];
}
const worldRef = (world, t) => (refKind(t) === 'realm' ? worldRealm(world) : refKind(t) === 'town' ? worldTown(world) : worldArea(world));

/** The act's measures now: { m, w }. */
function measure(world, act) {
  if (act.kind === 'area') return { m: measureArea(world, act.pts && act.pts.length ? act.pts : [[act.x, act.y]], act.r, act.sids), w: worldArea(world) };
  if (act.kind === 'pair') {
    const ca = act.a && act.a.kind === 'civ' ? act.a.id : null, cb = act.b && act.b.kind === 'civ' ? act.b.id : null;
    const ra = ca != null && world.civs[ca] && world.civs[ca].relations ? world.civs[ca].relations[cb] : null;
    let war = 0;
    if (ca != null && cb != null) for (const q of world.wars) if (q && q.active && ((q.attackers.includes(ca) && q.defenders.includes(cb)) || (q.attackers.includes(cb) && q.defenders.includes(ca)))) war = 1;
    return { m: [...measureRef(world, act.a), ...measureRef(world, act.b), r3(ra ? ra.opinion : 0), war], w: [...worldRef(world, act.a), ...worldRef(world, act.b), 0, 0] };
  }
  const t = act.tgt;
  return { m: measureRef(world, t), w: worldRef(world, t) };
}

/** The kind of land at a tile, for the lessons. */
const landAt = (world, x, y) => {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const i = Math.max(0, Math.min(world.H - 1, Math.round(y))) * world.W + Math.max(0, Math.min(world.W - 1, Math.round(x)));
  return LAND[world.f.biome[i]] || null;
};

/** The place an act is told by: the town nearest the spot, or the target's own name. */
function placeName(world, act) {
  const name = (t) => (t && t.kind === 'civ' ? world.civs[t.id]?.name : t && t.kind === 'settlement' ? world.settlements[t.id]?.name : null);
  if (act.kind === 'pair') { const a = name(act.a), b = name(act.b); return a && b ? `between ${a} and ${b}` : a ? `on ${a}` : b ? `on ${b}` : 'between two places'; }
  if (act.kind !== 'area') { const n = name(act.tgt); return n ? `on ${n}` : 'on a lost place'; }
  let best = null, bd = Infinity;
  for (const s of world.settlements) {
    if (!s || !s.alive) continue;
    const d = Math.hypot(s.x - act.x, s.y - act.y);
    if (d < bd) { bd = d; best = s; }
  }
  if (best && bd <= act.r + 6) return `near ${best.name}`;
  const land = landAt(world, act.x, act.y);
  return land ? `on the ${land}` : 'in the wilds';
}

// ---------------------------------------------------------------------------
// Acts

/** An act's targets and kind from a toolApplying/toolApplied payload. */
function shapeOf(world, p) {
  const t = getTool(p.id);
  const grp = t ? t.group : 'fate';
  if (p.kind === 'pair') return { kind: 'pair', grp, a: p.a || p.opts?.a || null, b: p.b || p.opts?.b || null };
  if (p.kind === 'entity') return { kind: refKind(p.target || p.opts?.target), grp, tgt: p.target || p.opts?.target || null };
  // a map tool: on a realm or a town when that is what a click means, else the land
  if (t && (t.target === 'civ' || t.target === 'settlement') && Number.isFinite(p.x)) {
    const i = p.y * world.W + p.x;
    if (t.target === 'civ') { const c = world.f.owner[i]; if (c >= 0) return { kind: 'realm', grp, tgt: { kind: 'civ', id: c } }; }
    else { const s = world.f.ownerSettle[i]; if (s >= 0) return { kind: 'town', grp, tgt: { kind: 'settlement', id: s } }; }
  }
  const r = fin(p.opts && p.opts.radius, t && Number.isFinite(t.radius) ? t.radius : 3);
  return { kind: 'area', grp, r: Math.max(1, r) };
}

/** The timed effects on an entity: { k: until }. */
function effectsOf(world, t) {
  const e = t && t.kind === 'civ' ? world.civs[t.id] : t && t.kind === 'settlement' ? world.settlements[t.id] : null;
  const out = {};
  if (e && Array.isArray(e.effects)) for (const q of e.effects) if (q && q.k) out[q.k] = q.until;
  return out;
}

/**
 * A power that strikes a point (an earthquake, eruption, falling star, wave, storm): its reach is
 * the first ring its forecast draws (up to 12 tiles, centred where it strikes) and the towns the
 * forecast names, so the act measures what the power reaches, not the clicked tile alone.
 */
function reachOf(world, act, p) {
  let pv = null;
  try { pv = previewTool(world, p.id, p.x, p.y, p.opts || {}); } catch (e) { pv = null; }
  if (!pv || pv.ok === false) return;
  const ring = (pv.rings || []).find((q) => q && Number.isFinite(q.r) && q.r > 0);
  if (ring) {
    act.r = Math.max(1, Math.min(12, Math.round(ring.r * 10) / 10));
    if (Number.isFinite(ring.x) && Number.isFinite(ring.y)) act.pts = [[Math.max(0, Math.min(world.W - 1, Math.floor(ring.x))), Math.max(0, Math.min(world.H - 1, Math.floor(ring.y)))]];
  }
  const sids = (pv.targets || []).filter((q) => q && q.kind === 'settlement' && Number.isFinite(q.id)).map((q) => q.id);
  if (sids.length) act.sids = [...new Set(sids)].sort((a, b) => a - b).slice(0, 40);
}

let pending = null;

on('toolApplying', (world, p) => {
  if (!world.sys || !world.sys.hand || !p || !p.id) { pending = null; return; }
  const sh = shapeOf(world, p);
  const act = { tool: p.id, grp: sh.grp, kind: sh.kind, day: world.time.day, x: Number.isFinite(p.x) ? p.x : null, y: Number.isFinite(p.y) ? p.y : null, r: sh.r || 0,
    tgt: sh.tgt || null, a: sh.a || null, b: sh.b || null, str: Number.isFinite(p.opts?.strength) ? p.opts.strength : null };
  if (act.kind === 'area') act.pts = [[act.x, act.y]];
  const t = getTool(p.id);
  if (act.kind === 'area' && t && !(t.radius > 0) && Number.isFinite(act.x)) reachOf(world, act, p);
  act.m0 = measure(world, act);
  pending = { act, eff: act.tgt ? effectsOf(world, act.tgt) : null, id: p.id };
});

on('toolApplied', (world, p) => {
  const st = world.sys && world.sys.hand ? stateOf(world) : null;
  const pend = pending;
  pending = null;
  if (!st || !p || !p.id) return;
  if (p.result && p.result.ok === false) {
    const why = String(p.result.message || 'refused').slice(0, 80);
    const r = (st.refused[p.id] ||= {});
    if (r[why] != null || Object.keys(r).length < 8) r[why] = (r[why] || 0) + 1;
    return;
  }
  // a stroke of a continuous power: the same act, one more point
  const last = st.acts[st.acts.length - 1];
  if (last && p.seq != null && last.seq === p.seq && last.tool === p.id) {
    if (last.kind === 'area' && Number.isFinite(p.x) && last.pts.length < 24 && !last.pts.some(([x, y]) => x === p.x && y === p.y)) last.pts.push([p.x, p.y]);
    return;
  }
  if (!pend || pend.id !== p.id) return;
  const act = pend.act;
  act.id = st.n++;
  act.seq = p.seq;
  if (act.x == null && Number.isFinite(p.x)) { act.x = p.x; act.y = p.y; }
  act.land = landAt(world, act.x, act.y);
  act.name = placeName(world, act);
  act.m1 = { m: measure(world, act).m };   // (the world is as it was a moment before)
  if (!act.tgt) delete act.tgt;
  if (!act.a) delete act.a;
  if (!act.b) delete act.b;
  if (act.str == null) delete act.str;
  // the end: the timed effect it set on its target, else a span by power
  let until = -1;
  if (pend.eff) {
    const after = effectsOf(world, act.tgt);
    for (const k in after) if (after[k] > world.time.day && (pend.eff[k] == null || after[k] > pend.eff[k])) until = Math.max(until, after[k]);
  }
  act.eff = until > world.time.day;
  act.endDay = act.eff ? until : world.time.day + Math.round((SPAN[act.grp] || 5) * DPY);
  act.genDay = world.time.day + GEN * DPY;
  act.end = null; act.gen = null;
  st.acts.push(act);
  if (st.acts.length > CAP) st.acts.splice(0, st.acts.length - CAP);
  st.next = Math.min(st.next, act.endDay);
});

// ---------------------------------------------------------------------------
// Reports

const pct = (v) => { const n = Math.round(v * 100); return n === 0 ? '±0 %' : `${n > 0 ? '+' : '−'}${Math.abs(n)} %`; };
const lvl = (v) => (Math.round(v * 100) / 100).toFixed(2);
const YEARS = ['', 'a year', 'two years', 'three years', 'four years', 'five years', 'six years', 'seven years', 'eight years', 'nine years', 'ten years'];
const span = (d) => { const y = Math.round(d / DPY); return y >= GEN - 1 ? 'a generation' : YEARS[y] || `${y} years`; };

/** What each family of powers is for: its measures are told first when they moved at all. */
const FOCUS = {
  weather: ['soil', 'harvest', 'food', 'rain'], catastrophe: ['people', 'towns', 'food'], life: ['herds', 'veg', 'fish', 'harvest', 'food'],
  terrain: ['people', 'towns', 'harvest'], peoples: ['people', 'wealth', 'food', 'stability', 'towns'], fate: ['stability', 'legitimacy', 'ruler', 'treasury', 'people'],
  myth: ['people', 'harvest', 'food'],
};
const TOOL_FOCUS = {
  plague: ['people', 'towns'], disease: ['people', 'towns'], cure: ['people', 'health'], enlighten: ['techs', 'people'], unrest: ['unrest', 'stability', 'happiness'],
  prosper: ['wealth', 'food', 'harvest', 'treasury'], ruin: ['wealth', 'food', 'treasury'], harmony: ['unrest', 'stability'], discord: ['unrest', 'stability'],
  fish: ['fish', 'food'], forest: ['veg', 'harvest'], predators: ['herds'], wildfire: ['veg', 'people', 'towns'], locusts: ['harvest', 'food', 'people'],
};

/** The measures an act's power is for (its report leads with them; the lessons gather them). */
export const focusOf = (act) => TOOL_FOCUS[act.tool] || FOCUS[act.grp] || [];

const DOWN = [[0.1, 'down a tenth'], [0.2, 'down a fifth'], [0.25, 'down a quarter'], [1 / 3, 'down a third'], [0.5, 'halved'], [2 / 3, 'down two thirds'], [0.75, 'down three quarters'], [0.83, 'down four fifths']];
const UP = [[0.1, 'up a tenth'], [0.2, 'up a fifth'], [0.25, 'up a quarter'], [1 / 3, 'up a third'], [0.5, 'up by half'], [2 / 3, 'up two thirds'], [0.75, 'up three quarters']];
const FOLD = ['', '', 'doubled', 'tripled', 'grew fourfold', 'grew fivefold', 'grew sixfold', 'grew sevenfold', 'grew eightfold', 'grew ninefold', 'grew tenfold'];
const nearest = (v, list) => list.reduce((p, q) => (Math.abs(q[0] - v) < Math.abs(p[0] - v) ? q : p))[1];

/** A quantity's change rel (after / before − 1) in plain words: 'down a quarter', 'halved', 'grew sixfold', 'all gone'. */
export function shareWords(rel) {
  if (Math.abs(rel) < 0.03) return 'steady';
  if (rel < 0) return rel <= -0.995 ? 'all gone' : rel <= -0.88 ? 'nearly all gone' : rel > -0.07 ? 'down a little' : nearest(-rel, DOWN);
  const r = 1 + rel;
  return rel < 0.07 ? 'up a little' : r >= 10.5 ? 'grew more than tenfold' : r >= 2.75 ? FOLD[Math.round(r)] : r >= 2.25 ? 'more than doubled' : r >= 1.85 ? 'doubled' : nearest(rel, UP);
}

const BANDS = [[0.15, 'very low'], [0.35, 'low'], [0.6, 'moderate'], [0.8, 'high'], [Infinity, 'very high']];
const bandOf = (v) => BANDS.find((q) => v < q[0])[1];

/** A level's move from v0 to v1 (0..1) in plain words: 'up from low to moderate', 'down a little, still high'. */
export function levelWords(v0, v1) {
  const d = v1 - v0;
  if (Math.abs(d) < 0.02) return `steady, ${bandOf(v1)}`;
  const b0 = bandOf(v0), b1 = bandOf(v1), dir = d > 0 ? 'up' : 'down';
  return b0 !== b1 ? `${dir} from ${b0} to ${b1}` : `${dir}${Math.abs(d) < 0.06 ? ' a little' : ''}, still ${b1}`;
}

/** Measures whose rise is a bane (the rest are boons when they rise). */
const BAD_UP = new Set(['unrest', 'wars']);

/**
 * The measures that moved most, the act's own first, at most n: [{ id, label, here, num, world,
 * wnum, dir (−1 | 0 | 1), tone (−1 bane, 0, 1 boon), text, score }]. b → a is the place; wb → wa
 * the world over the same days (null: no comparison, as at once).
 */
function moves(kind, b, a, wb, wa, n = 3, focus = null) {
  const defs = MEASURES[kind] || [];
  const cmp = Boolean(wb && wa);
  const out = [];
  for (let k = 0; k < defs.length; k++) {
    const [id, words, how] = defs[k];
    const v0 = fin(b[k]), v1 = fin(a[k]), w0 = cmp ? fin(wb[k]) : 0, w1 = cmp ? fin(wa[k]) : 0;
    const row = { id, label: words.replace(/^./, (x) => x.toUpperCase()), here: '', num: '', world: null, wnum: '', dir: 0, tone: 0, text: '', score: 0 };
    if (how === 'id') {
      if (v0 >= 0 && v1 !== v0) Object.assign(row, v1 < 0 ? { here: 'the realm is gone', text: 'the realm is gone', tone: -1 } : { here: 'no longer on the throne', text: 'the ruler is no longer on the throne' }, { score: 2 });
      else if (v0 >= 0 && focus && focus.includes('ruler')) Object.assign(row, { here: 'still reigns', text: 'the ruler still reigns', score: 0.5 });
      else continue;
    } else if (how === 'q') {
      if (v0 <= 0 && v1 <= 0) continue;
      if (v0 <= 0) Object.assign(row, { here: 'came where there were none', num: `0 → ${Math.round(v1)}`, dir: 1, score: 1 });
      else {
        const rel = (v1 - v0) / v0, wrel = cmp && w0 > 0 ? (w1 - w0) / w0 : 0;
        row.score = Math.abs(rel - wrel);
        if (row.score < 0.03 || Math.abs(rel) < 0.02) continue;   // (the place itself must have moved)
        Object.assign(row, { here: shareWords(rel), num: pct(rel), dir: Math.sign(rel) });
        if (cmp) Object.assign(row, { world: shareWords(wrel), wnum: pct(wrel) });
      }
    } else if (how === 'l') {
      const d = v1 - v0, wd = w1 - w0;
      row.score = Math.abs(d - wd);
      if (row.score < 0.03 || Math.abs(d) < 0.02) continue;
      Object.assign(row, { here: levelWords(v0, v1), num: `${lvl(v0)} → ${lvl(v1)}`, dir: Math.sign(d) });
      if (cmp) Object.assign(row, { world: levelWords(w0, w1), wnum: `${lvl(w0)} → ${lvl(w1)}` });
    } else {
      const d = Math.round(v1 - v0);
      if (!d) continue;
      Object.assign(row, { here: `${d > 0 ? 'up' : 'down'} from ${Math.round(v0)} to ${Math.round(v1)}`, num: `${d > 0 ? '+' : '−'}${Math.abs(d)}`, dir: Math.sign(d), score: Math.abs(d) / Math.max(1, v0) });
      if (cmp && w0 > 0) Object.assign(row, { world: shareWords((w1 - w0) / w0), wnum: pct((w1 - w0) / w0) });
    }
    if (how !== 'id') row.tone = BAD_UP.has(id) ? -row.dir : row.dir;
    if (!row.text) row.text = `${words} ${row.here}${row.world ? ` (across the world: ${row.world})` : ''}`;
    if (focus && focus.includes(id)) row.score += 10;   // what the power is for leads
    out.push(row);
  }
  return out.sort((p, q) => q.score - p.score).slice(0, n);
}

/**
 * What came of an act, as the rows a report tells (at most n; see moves): at once ('now': right
 * after against right before, no world beside it), when its work was done ('end') or a generation
 * on ('gen'), each against the world over the same years. [] before the report is in.
 */
export function reportRows(world, act, which, n = 4) {
  if (act.c || !act.m0) return [];
  if (which === 'now') return act.m1 && act.kind !== 'pair' ? moves(act.kind, act.m0.m, act.m1.m, null, null, n, focusOf(act).filter((id) => id !== 'ruler')) : [];
  const rep = act[which];
  if (!rep || typeof rep !== 'object') return [];
  if (act.kind !== 'pair') return moves(act.kind, act.m0.m, rep.m, act.m0.w, rep.w, n, focusOf(act));
  const ka = refKind(act.a), kb = refKind(act.b);
  const na = (MEASURES[ka] || []).length, nb = (MEASURES[kb] || []).length;
  const b0 = act.m0.m, b1 = rep.m;
  const nameOf = (t) => (t && t.kind === 'civ' ? world.civs[t.id]?.name : t && t.kind === 'settlement' ? world.settlements[t.id]?.name : null) || 'one of them';
  const op0 = fin(b0[na + nb]), op1 = fin(b1[na + nb]), war0 = b0[na + nb + 1], war1 = b1[na + nb + 1];
  // each side's own largest move (beyond the war itself, told once below)
  const side = (kind, off, len, t) => moves(kind, b0.slice(off, off + len), b1.slice(off, off + len), act.m0.w.slice(off, off + len), rep.w.slice(off, off + len), 2)
    .filter((r) => war0 === war1 || r.id !== 'wars').slice(0, 1)
    .map((r) => ({ ...r, label: `${r.label}, ${nameOf(t)}`, text: `in ${nameOf(t)}, ${r.text}` }));
  const out = [...side(ka, 0, na, act.a), ...side(kb, na, nb, act.b)];
  const up = op1 >= op0, sn = (v) => (Math.round(v) < 0 ? `−${Math.abs(Math.round(v))}` : String(Math.round(v)));
  if (Math.abs(op1 - op0) >= 5) out.unshift({ id: 'opinion', label: 'Their opinion of each other', here: `${up ? 'up' : 'down'} from ${sn(op0)} to ${sn(op1)}`, num: `${up ? '+' : '−'}${Math.abs(Math.round(op1 - op0))}`, world: null, wnum: '', dir: up ? 1 : -1, tone: up ? 1 : -1, text: `their opinion of each other ${up ? 'rose' : 'fell'} from ${sn(op0)} to ${sn(op1)}`, score: 20 });
  if (war0 !== war1) out.unshift({ id: 'war', label: 'Between them', here: war1 ? 'at war' : 'at peace again', num: '', world: null, wnum: '', dir: 0, tone: war1 ? -1 : 1, text: war1 ? 'they were at war' : 'their war was over', score: 30 });
  return out;
}

/** When a report is made, in words: 'At once', 'Two years on', 'When it had run its course', 'A generation on'. */
export function whenWords(act, which) {
  if (which === 'now') return 'At once';
  if (which === 'end' && act.eff) return 'When it had run its course';
  const rep = act[which];
  const d = rep && typeof rep === 'object' ? rep.day - act.day : which === 'gen' ? GEN * DPY : fin(act.endDay) - act.day;
  return `${span(d)} on`.replace(/^./, (x) => x.toUpperCase());
}

/** The report of an act at its end or a generation on ('end' | 'gen'), in short sentences. */
export function reportText(world, act, which) {
  const rep = act[which];
  if (!rep) return '';
  const t = getTool(act.tool);
  const label = t ? t.label : act.tool;
  const told = reportRows(world, act, which, 3).map((r) => r.text);
  const body = told.length ? told.join('; ') : 'little had changed there beyond the way of the world';
  // the first report also tells what the act did at once (right after against right before)
  let now = '';
  if (which === 'end') {
    const at = reportRows(world, act, 'now', 2).filter((r) => r.score >= 10).map((r) => r.text);
    if (at.length) now = ` At once: ${at.join('; ')}.`;
  }
  return `${label} ${act.name || ''}, Year ${Math.floor(act.day / DPY)}.${now} ${whenWords(act, which)}: ${body}.`.replace(/\s+,/g, ',');
}

function report(world, act, which) {
  act[which] = { day: world.time.day, ...measure(world, act) };
  const text = reportText(world, act, which);
  const civ = act.tgt && act.tgt.kind === 'civ' ? act.tgt.id : act.tgt && act.tgt.kind === 'settlement' ? world.settlements[act.tgt.id]?.civId ?? null : null;
  chronicle(world, {
    cat: 'divine', imp: 2, key: 'hand.report', text, x: act.x, y: act.y, civId: civ, sid: act.tgt && act.tgt.kind === 'settlement' ? act.tgt.id : null,
    ref: { k: 'act', id: act.id }, tags: [act.tool, which === 'end' ? 'hand.end' : 'hand.gen'],
  });
}

/**
 * An act's change in measure id: at once ('now': right after against right before), or at a report
 * ('end' | 'gen') against the world's change over the same years. { v, how } or null.
 */
export function changeOf(act, which, id) {
  if (act.c) {
    const defs = MEASURES[act.kind] || [];
    const k = defs.findIndex((d) => d[0] === id);
    const e = (act.L && act.L[which === 'now' ? 'n' : which === 'end' ? 'e' : 'g']) || [];
    const hit = k >= 0 ? e.find((x) => x[0] === k) : null;
    return hit ? { v: hit[1], how: defs[k][2] } : null;
  }
  const rep = which === 'now' ? (act.m1 ? { m: act.m1.m, w: act.m0.w } : null) : act[which];
  if (!rep || act.kind === 'pair') return null;
  const defs = MEASURES[act.kind] || [];
  const k = defs.findIndex((d) => d[0] === id);
  if (k < 0) return null;
  const how = defs[k][2];
  const v0 = fin(act.m0.m[k]), v1 = fin(rep.m[k]), w0 = fin(act.m0.w[k]), w1 = fin(rep.w[k]);
  if (how === 'q') return v0 > 0 ? { v: (v1 - v0) / v0 - (w0 > 0 ? (w1 - w0) / w0 : 0), how } : null;
  if (how === 'l') return { v: (v1 - v0) - (w1 - w0), how };
  if (how === 'n') return { v: v1 - v0, how };
  return null;
}

/** Fold an act with both reports in: keep only its changes in the measures its power is for. */
function fold(act) {
  if (act.c || !act.end || !act.gen) return;
  const ids = focusOf(act).filter((id) => (MEASURES[act.kind] || []).some((d) => d[0] === id));
  const L = { n: [], e: [], g: [] };
  const defs = MEASURES[act.kind] || [];
  for (const [which, k] of [['now', 'n'], ['end', 'e'], ['gen', 'g']]) for (const id of ids) { const c = changeOf(act, which, id); if (c && (k !== 'n' || Math.abs(c.v) > 1e-4)) L[k].push([defs.findIndex((d) => d[0] === id), Math.round(c.v * 1000) / 1000]); }
  act.L = L;
  act.c = 1;
  act.end = 1; act.gen = 1;
  for (const k of ['m0', 'm1', 'pts', 'r', 'seq', 'eff', 'endDay', 'genDay', 'tgt', 'a', 'b', 'sids']) delete act[k];
}

/** The act with id, or null. */
export const actOf = (world, id) => (world.sys && world.sys.hand ? world.sys.hand.acts.find((a) => a.id === Number(id)) || null : null);

export const system = {
  id: 'hand',
  order: 99,
  init(world) { stateOf(world); },
  update(world) {
    const st = stateOf(world);
    const day = world.time.day;
    if (day < st.next) return;
    let next = Infinity;
    for (const act of st.acts) {
      if (!act.end && act.endDay <= day) report(world, act, 'end');
      if (!act.gen && act.genDay <= day) report(world, act, 'gen');
      if (!act.end) next = Math.min(next, act.endDay);
      if (!act.gen) next = Math.min(next, act.genDay);
    }
    st.next = next;
    for (let k = 0; k < st.acts.length - FULL; k++) fold(st.acts[k]);
  },
};
