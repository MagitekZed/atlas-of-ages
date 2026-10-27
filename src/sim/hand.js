// The hand's ledger (chunk 10, docs/design/seeing-and-hand.md): every act of the divine hand,
// measured the moment before it, the moment after, when its work is done and a generation later,
// each time beside the same measures for the whole world, so a report can say what came of it.
// An observer: it reads the world, never draws on its chance, and writes only world.sys.hand and
// its own Chronicle lines (key 'hand.report'), which no system reads back for its choices.
//
//   world.sys.hand = { v, n (acts so far), acts: [act] (the last 300), refused: { tool: { reason: n } },
//                      next (the first day a report is due) }
//   act = { id, seq (its intervention, for undo and the deed card), tool, grp, kind ('area' |
//           'town' | 'realm' | 'pair'), day, x, y, r, pts (a stroke's points, ≤ 24), tgt, a, b
//           (pair targets), str (strength), land (the kind of land at the spot), name (the place),
//           m0, m1 (before and right after: { m: [measures], w: [the world's] }), end, gen
//           ({ day, m, w } once reported), endDay, genDay, eff (true when the end is a timed
//           effect's) }
// Measures by kind (MEASURES below): the land in the brush and its towns; a town; a realm; or two
// of them and the opinion between. A report is due when the timed effect the act set ends (else 2
// years for the sky and catastrophes, 5 for the rest) and 25 years after the act.
//
// Hooks: toolApplying (before: measure), toolApplied (after: the act, or a refusal counted, or a
// stroke's next point). Exports: system, MEASURES, actOf, reportText, focusOf

import { on } from '../core/hooks.js';
import { getTool } from '../core/tools.js';
import { chronicle } from '../core/chronicle.js';
import { DAYS_PER_YEAR as DPY, WATER, BIOME } from '../core/constants.js';

const CAP = 300;
const GEN = 25;
const SPAN = { weather: 2, catastrophe: 2, life: 5, peoples: 5, fate: 5, myth: 5, terrain: 5 };
const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const r3 = (v) => Math.round(fin(v) * 1000) / 1000;

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

function measureArea(world, pts, r) {
  const f = world.f;
  let rain = 0, soil = 0, veg = 0, herds = 0, nl = 0, fish = 0, nw = 0;
  const towns = new Set();
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
  if (act.kind === 'area') return { m: measureArea(world, act.pts && act.pts.length ? act.pts : [[act.x, act.y]], act.r), w: worldArea(world) };
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

let pending = null;

on('toolApplying', (world, p) => {
  if (!world.sys || !world.sys.hand || !p || !p.id) { pending = null; return; }
  const sh = shapeOf(world, p);
  const act = { tool: p.id, grp: sh.grp, kind: sh.kind, day: world.time.day, x: Number.isFinite(p.x) ? p.x : null, y: Number.isFinite(p.y) ? p.y : null, r: sh.r || 0,
    tgt: sh.tgt || null, a: sh.a || null, b: sh.b || null, str: Number.isFinite(p.opts?.strength) ? p.opts.strength : null };
  if (act.kind === 'area') act.pts = [[act.x, act.y]];
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
  act.m1 = measure(world, act);
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

const pct = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v * 100))} %`;
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

/** The measures that moved most against the world, the act's own first: [[score, words]], at most n. */
function moves(kind, b, a, wb, wa, n = 3, focus = null) {
  const defs = MEASURES[kind] || [];
  const out = [];
  for (let k = 0; k < defs.length; k++) {
    const [id, words, how] = defs[k];
    const v0 = fin(b[k]), v1 = fin(a[k]), w0 = fin(wb[k]), w1 = fin(wa[k]);
    if (how === 'id') {
      if (v0 >= 0 && v1 !== v0) out.push([2, v1 < 0 ? 'the realm is gone' : 'the ruler is no longer on the throne']);
      else if (v0 >= 0 && focus && focus.includes('ruler')) out.push([0.5, 'the ruler still reigns']);
      else continue;
      if (focus && focus.includes(id)) out[out.length - 1][0] += 10;
      continue;
    }
    if (how === 'q') {
      if (v0 <= 0 && v1 <= 0) continue;
      if (v0 <= 0) { out.push([1, `${words} came where there were none`]); continue; }
      const rel = (v1 - v0) / v0, wrel = w0 > 0 ? (w1 - w0) / w0 : 0;
      const score = Math.abs(rel - wrel);
      if (score < 0.03) continue;
      out.push([score, `${words} ${pct(rel)} (the world: ${pct(wrel)})`]);
    } else if (how === 'l') {
      const d = v1 - v0, wd = w1 - w0;
      const score = Math.abs(d - wd);
      if (score < 0.03) continue;
      out.push([score, `${words} ${lvl(v1)}, ${d >= 0 ? 'up' : 'down'} from ${lvl(v0)}`]);
    } else {
      const d = Math.round(v1 - v0);
      if (!d) continue;
      out.push([Math.abs(d) / Math.max(1, v0), `${words} ${Math.round(v1)}, ${d > 0 ? 'up' : 'down'} from ${Math.round(v0)}`]);
    }
    if (focus && focus.includes(id)) out[out.length - 1][0] += 10;   // what the power is for leads
  }
  return out.sort((p, q) => q[0] - p[0]).slice(0, n);
}

/** The report of an act at its end or a generation on ('end' | 'gen'). */
export function reportText(world, act, which) {
  const rep = act[which];
  if (!rep) return '';
  const t = getTool(act.tool);
  const label = t ? t.label : act.tool;
  const when = which === 'end' && act.eff ? 'when it had run its course' : `${span(rep.day - act.day)} on`;
  let parts;
  if (act.kind === 'pair') {
    const ka = refKind(act.a), kb = refKind(act.b);
    const na = (MEASURES[ka] || []).length, nb = (MEASURES[kb] || []).length;
    const b0 = act.m0.m, b1 = rep.m;
    parts = [...moves(ka, b0.slice(0, na), b1.slice(0, na), act.m0.w.slice(0, na), rep.w.slice(0, na), 1), ...moves(kb, b0.slice(na, na + nb), b1.slice(na, na + nb), act.m0.w.slice(na, na + nb), rep.w.slice(na, na + nb), 1)].map((x) => x[1]);
    const op0 = fin(b0[na + nb]), op1 = fin(b1[na + nb]), war0 = b0[na + nb + 1], war1 = b1[na + nb + 1];
    if (Math.abs(op1 - op0) >= 5) parts.unshift(`their opinion of each other ${Math.round(op1)}, ${op1 >= op0 ? 'up' : 'down'} from ${Math.round(op0)}`);
    if (war0 !== war1) parts.unshift(war1 ? 'they were at war' : 'their war was over');
  } else parts = moves(act.kind, act.m0.m, rep.m, act.m0.w, rep.w, 3, TOOL_FOCUS[act.tool] || FOCUS[act.grp] || null).map((x) => x[1]);
  const body = parts.length ? parts.join('; ') : 'little had changed there beyond the way of the world';
  return `${label} ${act.name || ''}, Year ${Math.floor(act.day / DPY)}: ${when}, ${body}.`.replace(/\s+,/g, ',');
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
  },
};
