// Event engine: schedules checks over the kernel registry (core/events.js) and fires defs.
//
// Schedule (one check per subject per year, spread over the days so no day is heavy):
//   town   each live settlement on day (id·37) % 360        realm  each live civ on day (id·53) % 360
//   pair   contacted pairs with a shared border on day (a·7 + b) % 360 (a < b)
//   land   each continent on day 90                          world  day 180
// A check draws exactly one world.rng.next() and compares it against min(0.5, Σw), the summed
// weights of the defs in bounds (myth level, era, cooldown), scaled by fortune, the volume
// governor, the ages and fate nudges; only when it fires does it draw one weightedIndex pick. So
// the number of draws never depends on how many defs exist or what they weigh. The draw comes
// first: one of 0.5 or more cannot fire, and then the (pure) weights are never summed.
//
// fire(ctx) writes its entry through record(ctx, …), which adds key 'event.<id>', a ref, the
// cause (the entry whose heat set it off), the divine framing when fate invoked it, and feeds
// the governor. The engine then sets cooldowns, counts the firing and emits eventFired.
// State lives in world.sys.events (JSON); lookups go through indexes in world.cache.

import { getEvents, getEvent, eventsVersion } from '../../core/events.js';
import { chronicle } from '../../core/chronicle.js';
import { emit } from '../../core/hooks.js';
import { addEffect } from '../../core/effects.js';
import { liveCivs } from '../../core/entities.js';
import { mythLevel } from '../../core/params.js';
import { weightedIndex } from '../../core/util.js';
import { DAYS_PER_YEAR } from '../../core/constants.js';
import { EVENT_FAMILIES, FAMILY_KEYS, AGES, NUDGE_MUL, PAIR_GAP_YEARS } from './data.js';
import { SUBJ, heatMap, heatSource, addHeat } from './heat.js';
import { govFactor, govNote } from './governor.js';

// ---------------------------------------------------------------------------
// Published exports of other packages (guarded: each may be missing or half-written)

let peoples = null, tech = null, disease = null, religion = null, trade = null, dynasty = null;
try { peoples = await import('../civ/peoples.js'); } catch (e) { /* splits unavailable */ }
try { tech = await import('../civ/tech.js'); } catch (e) { /* tech grants unavailable */ }
let arts = null;
try { arts = await import('../civ/arts.js'); } catch (e) { /* rare arts unavailable */ }
try { disease = await import('../geo/disease.js'); } catch (e) { /* plagues unavailable */ }
try { religion = await import('../geo/religion.js'); } catch (e) { /* faiths unavailable */ }
try { trade = await import('../geo/trade.js'); } catch (e) { /* route breaks unavailable */ }
try { dynasty = await import('../civ/dynasty.js'); } catch (e) { /* royal marriages fall back to our own match */ }

export const hasTech = (civ, id) => Boolean(civ && civ.tech && civ.tech.known && civ.tech.known[id] != null);
/** Tech defs by id (empty when the civ module is missing). */
export const techDef = (id) => (tech && tech.TECH_BY_ID ? tech.TECH_BY_ID[id] : null) || (tech && Array.isArray(tech.TECHS) ? tech.TECHS.find((t) => t.id === id) : null) || null;
/** Can civ learn tech id now (unknown, prerequisites known)? */
/** The historical tech at archive index k (civ/knowledge.js archives), or null. */
export const techAt = (k) => (tech && Array.isArray(tech.TECHS) && tech.TECHS[k] ? tech.TECHS[k].id : null);
/** Find a lost rare art again in a ruin (civ/arts.js), or false. */
export const rediscoverArt = (world, civ, s, sid) => Boolean(arts && arts.rediscoverArt && arts.rediscoverArt(world, civ, s, sid));

export function canLearn(civ, id) {
  const t = techDef(id);
  if (!t || hasTech(civ, id)) return false;
  return !Array.isArray(t.prereqs) || t.prereqs.every((p) => hasTech(civ, p));
}
/** Grant a tech quietly through WP3 (our entry tells the story). Returns true if learnt. */
export function grantTechTo(world, civ, id, via = 'r') {
  if (!tech || !civ || hasTech(civ, id)) return false;
  try {
    // via: how the realm came by it (civ/knowledge.js HOW): its own people by default, 'u:civId' from a ruin
    if (typeof tech.discover === 'function') tech.discover(world, civ, id, 'grant', null, { via });
    // grantTech(civ, id, day) today; tolerate a (world, civ, id) form (each no-ops on the other)
    if (!hasTech(civ, id) && typeof tech.grantTech === 'function') tech.grantTech(civ, id, world.time.day);
    if (!hasTech(civ, id) && typeof tech.grantTech === 'function') tech.grantTech(world, civ, id);
  } catch (e) { console.error('[events:grantTech]', e); }
  return hasTech(civ, id);
}
/** Start a plague in s. Contract: createPlague(world, sid, { lethalityMul, name, cause });
 * the pre-expansion form createPlague(world, s, cause, opts) is tried when that refuses. */
export function startPlague(world, s, opts = {}) {
  if (!disease || typeof disease.createPlague !== 'function' || !s || !s.alive) return null;
  let p = null;
  try { p = disease.createPlague(world, s.id, { lethalityMul: opts.lethalityMul ?? 1, name: opts.name, cause: opts.cause || 'contact' }); } catch (e) { p = null; }
  if (!p || typeof p !== 'object') {
    try { p = disease.createPlague(world, s, opts.cause || 'contact', { strength: opts.lethalityMul ?? 1, civB: opts.civB || null }); } catch (e) { console.error('[events:createPlague]', e); p = null; }
  }
  return p && typeof p === 'object' ? p : null;
}
/** Found a faith at s (quietly: our entry tells it). Returns the religion or null. */
export function foundFaith(world, s, opts = {}) {
  if (!religion || typeof religion.foundReligion !== 'function' || !s || !s.alive) return null;
  try { return religion.foundReligion(world, s, { quiet: true, ...opts }) || null; } catch (e) { console.error('[events:foundReligion]', e); return null; }
}
export function boostFaith(world, rid, amt) {
  if (rid == null) return;
  if (religion && typeof religion.boostFervor === 'function') { try { religion.boostFervor(world, rid, amt); } catch (e) { /* ignore */ } }
}
/** Break a trade route (contract: breakRoute(world, routeId, cause); older form takes the route). */
export function breakRouteSafe(world, r, cause) {
  if (!trade || typeof trade.breakRoute !== 'function' || !r || !r.active) return false;
  try { trade.breakRoute(world, r, cause); } catch (e) { /* try the id form */ }
  if (r.active) { try { trade.breakRoute(world, r.id, cause); } catch (e) { /* give up */ } }
  return !r.active;
}
/** Split settlements away into a new realm (WP3 splitCiv). Returns { civ, war } or null. */
export function splitAway(world, civ, sids, opts) {
  if (!peoples || typeof peoples.splitCiv !== 'function' || !civ || !civ.alive) return null;
  try { return peoples.splitCiv(world, civ, sids, opts) || null; } catch (e) { console.error('[events:splitCiv]', e); return null; }
}
/**
 * WP3 royal marriage when it exists: its result ({ ok, entry?, reason? }), or null when WP3 has
 * no marriages (the caller then tells the match itself).
 */
export function marry(world, a, b, opts = {}) {
  if (!dynasty || typeof dynasty.arrangeMarriage !== 'function') return null;
  try { return dynasty.arrangeMarriage(world, a, b, opts) || { ok: false }; } catch (e) { console.error('[events:arrangeMarriage]', e); return { ok: false }; }
}
export const available = () => ({ peoples: Boolean(peoples), tech: Boolean(tech), disease: Boolean(disease), religion: Boolean(religion), trade: Boolean(trade), dynasty: Boolean(dynasty) });

// ---------------------------------------------------------------------------
// State

/** Ensure world.sys.events and every field (idempotent; never draws rng). */
export function evState(world) {
  const st0 = world.sys.events;
  if (st0 && world.cache.evOk === st0) return st0;
  const st = (world.sys.events ||= {});
  if (!Number.isFinite(st.v)) st.v = 1;
  for (const k of ['cd', 'heat', 'hsrc', 'counts', 'byCentury', 'families', 'inv', 'emb', 'lands', 'cm', 'sg', 'pd', 'pend']) {
    if (!st[k] || typeof st[k] !== 'object' || Array.isArray(st[k])) st[k] = {};
  }
  if (!Array.isArray(st.boosts)) st.boosts = [];
  if (!Array.isArray(st.fall)) st.fall = [];
  if (!st.swan || typeof st.swan !== 'object') st.swan = { last: null, hist: [] };
  if (!Array.isArray(st.swan.hist)) st.swan.hist = [];
  if (!st.yr || typeof st.yr !== 'object') st.yr = { y: Math.floor(world.time.day / DAYS_PER_YEAR), cur: {}, last: null };
  if (!st.annals || typeof st.annals !== 'object') st.annals = { seq: world.chronicle.seq, pop: {} };
  if (!st.annals.pop) st.annals.pop = {};
  if (!st.tally || typeof st.tally !== 'object') st.tally = newTally(world);
  if (!Array.isArray(st.tally.gaps)) st.tally.gaps = [];
  world.cache.evOk = st;
  return st;
}

function newTally(world) {
  return {
    seq: world.chronicle.seq, // last chronicle seq tallied
    n2: 0, n2early: 0, n2late: 0, war2late: 0, civ2: 0, succ2: 0, n3: 0,
    first4: null, last3: null, gaps: [], // gaps: histogram of years between imp ≥ 3 entries (index = years, last bin = 40+)
    ev2: 0, // our own imp ≥ 2 entries
    byCat: {},
  };
}

/**
 * Active trade routes per settlement, counted once a year at New Year and saved
 * (sys.events.rc = { sid: n }), so every check of the year, and every preview, reads the same
 * numbers whether or not the world was loaded since.
 */
export function countRoutes(world) {
  const rc = {};
  for (const r of world.tradeRoutes) {
    if (!r || !r.active) continue;
    rc[r.aId] = (rc[r.aId] || 0) + 1;
    rc[r.bId] = (rc[r.bId] || 0) + 1;
  }
  world.sys.events.rc = rc;
}
export const routesOf = (world, sid) => { const rc = world.sys.events && world.sys.events.rc; return (rc && rc[sid]) || 0; };

// ---------------------------------------------------------------------------
// Def tables per scale (filtered by the myth level; cached by registry version)

const SCALES = ['town', 'realm', 'pair', 'land', 'world'];
// family → slot in the per-check memo (the last slot holds any family not in EVENT_FAMILIES)
const FAMILY_IX = Object.fromEntries(FAMILY_KEYS.map((k, i) => [k, i]));
const FAMILY_N = FAMILY_KEYS.length + 1;
function defsFor(world, scale) {
  const lvl = mythLevel(world);
  const c = (world.cache.evDefs ||= {});
  const key = eventsVersion() * 4 + lvl;
  let e = c[scale];
  if (!e || e.key !== key) e = c[scale] = table(getEvents(scale).filter((d) => d.minMyth <= lvl && lvl <= d.maxMyth), key);
  return e;
}
/** A def list with its per-def lookups laid out flat for the hot loop in check(). */
function table(list, key = 0) {
  const n = list.length;
  const fi = new Int32Array(n), luck = new Uint8Array(n), era = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const d = list[k];
    fi[k] = FAMILY_IX[d.family] ?? FAMILY_N - 1;
    luck[k] = d.luck !== false ? 1 : 0;
    era[k] = d.minEra != null || d.maxEra != null ? 1 : 0;
  }
  return { key, list, w: new Float64Array(n), fi, luck, era };
}

// cooldown index: subject → { id: untilDay }  (saved form: sys.events.cd['id|subject'] = untilDay)
function cdIndex(world) {
  const c = world.cache;
  if (c.evCd) return c.evCd;
  const idx = Object.create(null);
  const cd = world.sys.events.cd;
  for (const k in cd) {
    const bar = k.indexOf('|');
    if (bar < 0) continue;
    (idx[k.slice(bar + 1)] ||= Object.create(null))[k.slice(0, bar)] = cd[k];
  }
  return (c.evCd = idx);
}
function setCooldown(world, id, subj, until) {
  const st = world.sys.events;
  const k = id + '|' + subj;
  if ((st.cd[k] || 0) >= until) return;
  st.cd[k] = until;
  const idx = cdIndex(world);
  (idx[subj] ||= Object.create(null))[id] = until;
}
/** Day the def rests until on subject (0 when free). */
export function cooldownUntil(world, id, subj) {
  const m = cdIndex(world)[subj];
  return (m && m[id]) || 0;
}
/** Yearly: forget cooldowns that have run out. */
export function pruneCooldowns(world) {
  const st = world.sys.events, day = world.time.day;
  let any = false;
  for (const k of Object.keys(st.cd)) if (!(st.cd[k] > day)) { delete st.cd[k]; any = true; }
  for (const k of Object.keys(st.inv)) if (day - st.inv[k] > 50 * DAYS_PER_YEAR) delete st.inv[k];
  if (any) world.cache.evCd = null;
}

// ---------------------------------------------------------------------------
// Multipliers

/** Ages multiplier on a family's weights (pure). */
export function ageFamilyMul(world, family) {
  const ages = world.sys.events?.ages;
  if (!ages || !Array.isArray(ages.cur) || !ages.cur.length || world.params.worldAges === false) return 1;
  let m = 1;
  for (const a of ages.cur) {
    const def = AGES[a.key];
    const v = def && def.ev ? def.ev[family] : undefined;
    if (typeof v === 'number') m *= v;
  }
  return m;
}
const fortune = (world) => { const f = Number(world.params.fortune); return Number.isFinite(f) ? Math.max(0, f) : 1; };

function entityFor(world, scale, ctx) {
  if (scale === 'town') return ctx.s;
  if (scale === 'realm') return ctx.civ;
  return null;
}
/** Defs fate has nudged on the subject entity (live effects 'fate:<id>'): { id: true } or null. */
function nudgesOf(world, ent) {
  const list = ent && ent.effects;
  if (!list || !list.length) return null;
  const day = world.time.day;
  let out = null;
  for (let k = 0; k < list.length; k++) {
    const e = list[k];
    if (e.k.charCodeAt(0) === 102 /* f */ && e.k.startsWith('fate:') && (e.until < 0 || e.until > day)) (out ||= Object.create(null))[e.k.slice(5)] = true;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Contexts (one scratch object per scale, refilled for every check)

function blankCtx(scale) {
  const ctx = {
    world: null, day: 0, era: 0, scale, subject: '', mythLevel: 0,
    s: null, civ: null, a: null, b: null, ra: null, rb: null, land: null,
    def: null, entry: null, cause: null, divine: false, invoked: false, live: false,
    _hs: null, _hc: null, _hl: null, _routes: -1, _towns: null, _fortune: 1, _gen: 0, _hills: -1,
    _fmv: new Float64Array(FAMILY_N), _fmg: new Int32Array(FAMILY_N),
    heat: null, heatCiv: null, heatLand: null,
  };
  ctx.heat = (tag) => (ctx._hs && ctx._hs[tag]) || 0;
  ctx.heatCiv = (tag) => (ctx._hc && ctx._hc[tag]) || 0;
  ctx.heatLand = (tag) => (ctx._hl && ctx._hl[tag]) || 0;
  return ctx;
}
const CTX = Object.fromEntries(SCALES.map((s) => [s, blankCtx(s)]));
const PREVIEW = Object.fromEntries(SCALES.map((s) => [s, blankCtx(s)]));
for (const s of SCALES) CTX[s].live = true;

function reset(ctx, world) {
  ctx.world = world; ctx.day = world.time.day; ctx.mythLevel = mythLevel(world);
  ctx.s = null; ctx.civ = null; ctx.a = null; ctx.b = null; ctx.ra = null; ctx.rb = null; ctx.land = null;
  ctx.def = null; ctx.entry = null; ctx.cause = null; ctx.divine = false; ctx.invoked = false;
  ctx._hs = null; ctx._hc = null; ctx._hl = null; ctx._routes = -1; ctx._towns = null; ctx._hills = -1;
  ctx._fortune = fortune(world);
  ctx._gen = (ctx._gen + 1) | 0;
  ctx.era = 0;
  return ctx;
}
const eraOf = (civ) => (civ && civ.tech && Number.isFinite(civ.tech.era) ? civ.tech.era : 0);
function landKeyOf(world, s) { const lm = world.f.landmass[s.i]; return lm >= 0 ? SUBJ.land(lm) : null; }

export function townCtx(world, s, preview = false) {
  const ctx = reset((preview ? PREVIEW : CTX).town, world);
  ctx.s = s; ctx.civ = world.civs[s.civId] || null; ctx.era = eraOf(ctx.civ);
  ctx.subject = SUBJ.town(s.id);
  ctx._hs = heatMap(world, ctx.subject);
  ctx._hc = ctx.civ ? heatMap(world, SUBJ.realm(ctx.civ.id)) : null;
  const lk = landKeyOf(world, s);
  ctx._hl = lk ? heatMap(world, lk) : null;
  return ctx;
}
export function realmCtx(world, civ, preview = false) {
  const ctx = reset((preview ? PREVIEW : CTX).realm, world);
  ctx.civ = civ; ctx.era = eraOf(civ);
  ctx.s = civ.capitalId != null ? world.settlements[civ.capitalId] || null : null;
  ctx.subject = SUBJ.realm(civ.id);
  ctx._hs = heatMap(world, ctx.subject);
  ctx._hc = ctx._hs;
  const lk = ctx.s ? landKeyOf(world, ctx.s) : null;
  ctx._hl = lk ? heatMap(world, lk) : null;
  return ctx;
}
export function pairCtx(world, a, b, preview = false) {
  const ctx = reset((preview ? PREVIEW : CTX).pair, world);
  ctx.a = a; ctx.b = b; ctx.civ = a;
  ctx.ra = a.relations[b.id] || null; ctx.rb = b.relations[a.id] || null;
  ctx.era = Math.max(eraOf(a), eraOf(b));
  ctx.subject = SUBJ.pair(a.id, b.id);
  ctx._hs = heatMap(world, ctx.subject);
  ctx._hc = heatMap(world, SUBJ.realm(a.id));
  return ctx;
}
export function landCtx(world, land, preview = false) {
  const ctx = reset((preview ? PREVIEW : CTX).land, world);
  ctx.land = land;
  ctx.era = land.era || 0;
  ctx.subject = SUBJ.land(land.lm);
  ctx._hs = heatMap(world, ctx.subject);
  ctx._hl = ctx._hs;
  return ctx;
}
export function worldCtx(world, preview = false) {
  const ctx = reset((preview ? PREVIEW : CTX).world, world);
  let era = 0;
  for (const c of liveCivs(world)) era = Math.max(era, eraOf(c));
  ctx.era = era;
  ctx.subject = SUBJ.world;
  ctx._hs = heatMap(world, SUBJ.world);
  return ctx;
}

// ---------------------------------------------------------------------------
// Weights

/**
 * The town defs a settlement of this tier in a realm of this era could fire, cached per
 * (tier, era): a pure narrowing of the scale's list (defs left out would weigh 0 anyway, and
 * the order is kept, so the draws and the pick are exactly those over the full list).
 */
function townDefs(world, tier, era) {
  const tab = defsFor(world, 'town');
  const c = (tab.byTE ||= new Map());
  const k = tier * 16 + era;
  let e = c.get(k);
  if (!e) {
    e = table(tab.list.filter((d) => (d.minTier == null || tier >= d.minTier) && (d.maxTier == null || tier <= d.maxTier)
      && (d.minEra == null || era >= d.minEra) && (d.maxEra == null || era <= d.maxEra)));
    e.preFiltered = true;
    c.set(k, e);
  }
  return e;
}

/** Effective weight of def k in an already-filled context (0 when out of bounds or resting). */
function effWeight(world, d, ctx, cdm, nudged, invoking = false) {
  if (d.minEra != null && ctx.era < d.minEra) return 0;
  if (d.maxEra != null && ctx.era > d.maxEra) return 0;
  if (ctx.s && ctx.scale === 'town' && ((d.minTier != null && ctx.s.tier < d.minTier) || (d.maxTier != null && ctx.s.tier > d.maxTier))) return 0;
  // consequence defs that only stir when their subject is primed (def.needs: heat tags)
  if (d.needs && !invoking) {
    const hs = ctx._hs;
    let hot = false;
    if (hs) for (let k = 0; k < d.needs.length; k++) if (hs[d.needs[k]] > 0) { hot = true; break; }
    if (!hot) return 0;
  }
  if (!invoking && cdm && cdm[d.id] > ctx.day) return 0;
  let w = 0;
  try { w = d.weight(ctx); } catch (e) { reportOnce(d.id, e); return 0; }
  if (!(w > 0) || !Number.isFinite(w)) return 0;
  if (invoking) return w;
  if (d.luck !== false) w *= ctx._fortune;
  // governor × ages per family, memoised for this check (both are fixed while it runs)
  const fi = FAMILY_IX[d.family] ?? FAMILY_N - 1;
  if (ctx._fmg[fi] !== ctx._gen) { ctx._fmg[fi] = ctx._gen; ctx._fmv[fi] = govFactor(world, d.family) * ageFamilyMul(world, d.family); }
  w *= ctx._fmv[fi];
  if (nudged && nudged[d.id]) w *= NUDGE_MUL;
  return w;
}
const ERR = Object.create(null);
function reportOnce(id, e) {
  ERR[id] = (ERR[id] || 0) + 1;
  if (ERR[id] <= 2) console.error(`[events:${id}] weight failed`, e);
}

/**
 * The hot loop: every def's effective weight into tab.w, returning the sum. Same arithmetic as
 * effWeight (era and tier bounds are already settled for pre-filtered town lists).
 */
function sumWeights(world, tab, ctx, cdm, nudged) {
  const list = tab.list, W = tab.w, FI = tab.fi, LUCK = tab.luck, ERA = tab.era, n = list.length;
  const day = ctx.day, era = ctx.era, hs = ctx._hs, fv = ctx._fortune, gen = ctx._gen, fmg = ctx._fmg, fmv = ctx._fmv;
  const pre = tab.preFiltered === true;
  let total = 0;
  for (let k = 0; k < n; k++) {
    const d = list[k];
    let w = 0;
    if (!pre && ERA[k] === 1 && ((d.minEra != null && era < d.minEra) || (d.maxEra != null && era > d.maxEra))) { W[k] = 0; continue; }
    if (cdm !== undefined && cdm[d.id] > day) { W[k] = 0; continue; }
    const needs = d.needs;
    if (needs) {
      let hot = false;
      if (hs) for (let j = 0; j < needs.length; j++) if (hs[needs[j]] > 0) { hot = true; break; }
      if (!hot) { W[k] = 0; continue; }
    }
    w = d.weight(ctx);
    if (w > 0 && w < Infinity) {
      if (LUCK[k] === 1) w *= fv;
      const fi = FI[k];
      if (fmg[fi] !== gen) { fmg[fi] = gen; fmv[fi] = govFactor(world, d.family) * ageFamilyMul(world, d.family); }
      w *= fmv[fi];
      if (nudged !== null && nudged[d.id]) w *= NUDGE_MUL;
    } else w = 0;
    W[k] = w;
    total += w;
  }
  return total;
}

/**
 * One check: exactly one rng.next(), plus one weightedIndex pick when it fires.
 * Returns the fired def or null.
 */
export function check(world, scale, ctx) {
  // The check's one draw comes first: the odds are capped at 0.5, so a draw of 0.5 or more can
  // never fire, and the weights (pure, like every def.weight) need not be summed at all. The
  // draw and the outcome are exactly those of summing first and drawing after.
  const r = world.rng.next();
  if (r >= 0.5) return null;
  const tab = scale === 'town' ? townDefs(world, Math.max(0, Math.min(7, ctx.s.tier | 0)), Math.max(0, Math.min(15, ctx.era | 0))) : defsFor(world, scale);
  const list = tab.list, W = tab.w, n = list.length;
  const cdm = cdIndex(world)[ctx.subject];
  const nudged = nudgesOf(world, entityFor(world, scale, ctx));
  let total = 0;
  if (!(scale === 'pair' && cdm && cdm['*'] > ctx.day)) {
    try {
      total = sumWeights(world, tab, ctx, cdm, nudged);
    } catch (e) {
      // a def threw: weigh them one by one, so only the broken one is left out
      total = 0;
      for (let k = 0; k < n; k++) { const w = effWeight(world, list[k], ctx, cdm, nudged); W[k] = w; total += w; }
    }
  } else W.fill(0);
  const p = Math.min(0.5, total);
  if (!(r < p) || total <= 0) return null;
  const k = weightedIndex(world.rng, W);
  if (k < 0) return null;
  const d = list[k];
  return fire(world, d, ctx) ? d : null;
}

/**
 * Fire a def in a filled context. opts: { divine } (fate's Invoke). Returns true when the def
 * reported that something happened.
 */
export function fire(world, d, ctx, opts = {}) {
  ctx.def = d; ctx.entry = null;
  ctx.divine = Boolean(opts.divine); ctx.invoked = Boolean(opts.divine);
  ctx.cause = opts.cause ?? causeFor(world, d, ctx);
  let ok;
  try { ok = d.fire(ctx); } catch (e) { console.error(`[events:${d.id}] fire failed`, e); ok = false; }
  if (ok === false) return false;
  const st = world.sys.events;
  const day = world.time.day;
  if (d.cooldownYears > 0) setCooldown(world, d.id, ctx.subject, day + Math.round(d.cooldownYears * DAYS_PER_YEAR));
  if (ctx.scale === 'pair') setCooldown(world, '*', ctx.subject, day + PAIR_GAP_YEARS * DAYS_PER_YEAR);
  st.counts[d.id] = (st.counts[d.id] || 0) + 1;
  st.families[d.family] = (st.families[d.family] || 0) + 1;
  const c = String(Math.floor(day / (DAYS_PER_YEAR * 100)));
  const bc = (st.byCentury[c] ||= {});
  bc[d.family] = (bc[d.family] || 0) + 1;
  st.yr.cur[d.family] = (st.yr.cur[d.family] || 0) + 1;
  emit(world, 'eventFired', { id: d.id, family: d.family, scale: d.scale, subject: subjectDesc(ctx), seq: ctx.entry ? ctx.entry.seq : null });
  return true;
}

function subjectDesc(ctx) {
  switch (ctx.scale) {
    case 'town': return { kind: 'settlement', id: ctx.s ? ctx.s.id : null };
    case 'realm': return { kind: 'civ', id: ctx.civ ? ctx.civ.id : null };
    case 'pair': return { kind: 'pair', a: ctx.a ? ctx.a.id : null, b: ctx.b ? ctx.b.id : null };
    case 'land': return { kind: 'land', lm: ctx.land ? ctx.land.lm : null, name: ctx.land ? ctx.land.feature.name : null };
    default: return { kind: 'world' };
  }
}

/** The entry whose heat set this def off: the hottest of def.chain on the subject, realm or land. */
function causeFor(world, d, ctx) {
  const chain = d.chain;
  if (!chain || !chain.length) return null;
  let best = 0, src = null;
  for (const tag of chain) {
    const pairs = [[ctx._hs, ctx.subject], [ctx._hc, ctx.civ ? SUBJ.realm(ctx.civ.id) : null], [ctx._hl, ctx.land ? SUBJ.land(ctx.land.lm) : ctx.s ? landKeyOf(world, ctx.s) : null]];
    for (const [m, subj] of pairs) {
      if (!m || !subj) continue;
      const v = m[tag] || 0;
      if (v > best) { const s = heatSource(world, tag, subj); if (s != null) { best = v; src = s; } }
    }
  }
  return src;
}

// ---------------------------------------------------------------------------
// Helpers for fire()

const DIVINE = [
  'Men swore that fate itself had willed it.',
  'The priests said the hand of heaven had moved.',
  'Some called it a sign from beyond the world.',
  'It was as though an unseen hand had tipped the scales.',
];

/**
 * Write the def's chronicle entry. e: { text, imp?, cat?, s?, civ?, x?, y?, sid?, civId?, ref?,
 * key?, cause?, tags?, fold?, icon? }. Location and ref default to the subject.
 */
export function record(ctx, e) {
  const world = ctx.world, d = ctx.def;
  let x = e.x ?? null, y = e.y ?? null, sid = e.sid ?? null, civId = e.civId ?? null;
  // town events sit on their town; realm, pair and land events on the realm (never on its
  // capital's history unless the def names a town)
  const s = e.s || (ctx.scale === 'town' && !e.civ ? ctx.s : null);
  const civ = e.civ || (s ? world.civs[s.civId] : null) || ctx.civ || ctx.a || null;
  if (s) { x ??= s.x; y ??= s.y; sid ??= s.id; civId ??= s.civId; }
  if (civ) {
    civId ??= civ.id;
    if (x == null) {
      const cap = civ.capitalId != null ? world.settlements[civ.capitalId] : null;
      if (cap) { x = cap.x; y = cap.y; } else { x = civ.originX ?? null; y = civ.originY ?? null; }
    }
  }
  if (x == null && ctx.land) { x = ctx.land.feature.x; y = ctx.land.feature.y; }
  let ref = e.ref || null;
  if (!ref) {
    if (s) ref = { k: 'settlement', id: s.id };
    else if (civ) ref = { k: 'civ', id: civ.id };
  }
  const fam = EVENT_FAMILIES[d.family];
  let text = e.text;
  if (ctx.divine) text = `${text} ${DIVINE[Math.floor(world.rng.next() * DIVINE.length)]}`;
  const entry = chronicle(world, {
    cat: ctx.divine ? 'divine' : e.cat || d.cat || (fam ? fam.cat : 'civ'),
    // what the player's own hand caused is never routine
    imp: ctx.divine ? Math.max(2, e.imp ?? d.imp ?? 2) : e.imp ?? d.imp ?? 2,
    text, x, y, civId, sid,
    icon: e.icon ?? d.icon ?? null,
    ref: ref || undefined,
    key: 'event.' + (e.key || d.id),
    cause: e.cause ?? ctx.cause ?? undefined,
    tags: e.tags,
    fold: (e.fold && !ctx.divine) || undefined,
  });
  if (!ctx.entry) ctx.entry = entry;
  govNote(world, d.family, entry);
  return entry;
}

export const T = {
  s: (s) => ({ kind: 'settlement', id: s.id }),
  c: (civ) => ({ kind: 'civ', id: civ.id }),
};
/** Add a timed effect from this event (years < 0: permanent). Source = this event's entry. */
export function effect(ctx, target, k, m, years, label = null) {
  const world = ctx.world;
  const until = years < 0 ? -1 : world.time.day + Math.round(years * DAYS_PER_YEAR);
  return addEffect(world, target, { k, until, m, src: ctx.entry ? ctx.entry.seq : undefined, label: label || ctx.def.label || ctx.def.id });
}
/** Heat a tag on this subject (or another subject key), sourced to this event's entry. */
export function heat(ctx, tag, amt, subj = ctx.subject) {
  const src = ctx.entry ? ctx.entry.seq : null;
  const v = addHeat(ctx.world, tag, subj, amt, src);
  // a quarrel or a friendship between two realms is felt, more faintly, in each of them
  if (ctx.scale === 'pair' && subj === ctx.subject && ctx.a && ctx.b && amt > 0) {
    addHeat(ctx.world, tag, SUBJ.realm(ctx.a.id), amt * 0.5, src);
    addHeat(ctx.world, tag, SUBJ.realm(ctx.b.id), amt * 0.5, src);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Fate support: what could happen to a subject (pure), and firing on demand

/** Fill a preview context for a subject; null when it no longer exists. */
export function previewCtx(world, subject) {
  if (!subject) return null;
  if (subject.kind === 'settlement') {
    const s = world.settlements[subject.id];
    return s && s.alive ? townCtx(world, s, true) : null;
  }
  if (subject.kind === 'civ') {
    const c = world.civs[subject.id];
    return c && c.alive ? realmCtx(world, c, true) : null;
  }
  if (subject.kind === 'pair') {
    const a = world.civs[subject.a], b = world.civs[subject.b];
    if (!a || !b || !a.alive || !b.alive || !a.relations[b.id]) return null;
    return pairCtx(world, a, b, true);
  }
  return null;
}
const SCALE_OF = { settlement: 'town', civ: 'realm', pair: 'pair' };

/**
 * Defs that could fire on a subject: [{ def, w, wRaw, p, pDecade, until }] (sorted by p).
 * Pure: weights only, no rng, no writes outside world.cache.
 */
export function eligibleFor(world, subject) {
  const scale = SCALE_OF[subject?.kind];
  const ctx = scale ? previewCtx(world, subject) : null;
  if (!ctx) return [];
  const tab = defsFor(world, scale);
  const cdm = cdIndex(world)[ctx.subject];
  const nudged = nudgesOf(world, entityFor(world, scale, ctx));
  const gap = scale === 'pair' && cdm && cdm['*'] > ctx.day ? cdm['*'] : 0;
  const out = [];
  let total = 0;
  for (const d of tab.list) {
    const raw = effWeight(world, d, ctx, null, null, true);
    if (!(raw > 0)) continue;
    const until = Math.max(gap, (cdm && cdm[d.id]) || 0);
    const w = until > ctx.day ? 0 : effWeight(world, d, ctx, null, nudged);
    out.push({ def: d, w, wRaw: raw, until: until > ctx.day ? until : 0, p: 0, pDecade: 0 });
    total += w;
  }
  const pFire = Math.min(0.5, total);
  for (const o of out) {
    o.p = total > 0 ? pFire * (o.w / total) : 0;
    o.pDecade = 1 - Math.pow(1 - o.p, 10);
  }
  out.sort((x, y) => y.pDecade - x.pDecade || y.wRaw - x.wRaw || (x.def.id < y.def.id ? -1 : 1));
  return out;
}

/** Fire def id on a subject now (fate's Invoke). Returns { ok, entry?, message? }. */
export function invokeOn(world, subject, id) {
  const d = getEvent(id);
  const scale = SCALE_OF[subject?.kind];
  if (!d || d.scale !== scale) return { ok: false, message: 'That thread does not run through here.' };
  const lvl = mythLevel(world);
  if (d.minMyth > lvl || d.maxMyth < lvl) return { ok: false, message: 'That thread does not run through this world.' };
  const pv = previewCtx(world, subject);
  if (!pv) return { ok: false, message: 'There is nothing there for fate to touch.' };
  if (!(effWeight(world, d, pv, null, null, true) > 0)) return { ok: false, message: `${d.label || d.id} cannot happen there now.` };
  // fire in the live context (the preview one may be reused by the UI)
  const ctx = scale === 'town' ? townCtx(world, pv.s) : scale === 'realm' ? realmCtx(world, pv.civ) : pairCtx(world, pv.a, pv.b);
  const ok = fire(world, d, ctx, { divine: true });
  return ok ? { ok: true, entry: ctx.entry } : { ok: false, message: 'Fate stirred, but nothing came of it.' };
}

/**
 * An entry written outside a def's fire (city character, ages, ruins, annals): same keys, refs
 * and governor accounting. e as record(); family and key ('event.' + key unless e.fullKey).
 */
export function recordFree(world, family, key, e) {
  let x = e.x ?? null, y = e.y ?? null, sid = e.sid ?? null, civId = e.civId ?? null;
  const s = e.s || null;
  const civ = e.civ || (s ? world.civs[s.civId] : null) || null;
  if (s) { x ??= s.x; y ??= s.y; sid ??= s.id; civId ??= s.civId; }
  if (civ) {
    civId ??= civ.id;
    if (x == null) {
      const cap = civ.capitalId != null ? world.settlements[civ.capitalId] : null;
      if (cap) { x = cap.x; y = cap.y; } else { x = civ.originX ?? null; y = civ.originY ?? null; }
    }
  }
  const ref = e.ref || (s ? { k: 'settlement', id: s.id } : civ ? { k: 'civ', id: civ.id } : null);
  const fam = EVENT_FAMILIES[family];
  const entry = chronicle(world, {
    cat: e.cat || (fam ? fam.cat : 'civ'), imp: e.imp ?? 2, text: e.text, x, y, civId, sid,
    icon: e.icon ?? null, ref: ref || undefined, key: e.fullKey || 'event.' + key,
    cause: e.cause ?? undefined, tags: e.tags, fold: e.fold || undefined,
  });
  govNote(world, family, entry);
  const st = world.sys.events;
  if (st && !e.noCount) {
    st.counts[key] = (st.counts[key] || 0) + 1;
    st.families[family] = (st.families[family] || 0) + 1;
    const c = String(Math.floor(world.time.day / (DAYS_PER_YEAR * 100)));
    const bc = (st.byCentury[c] ||= {});
    bc[family] = (bc[family] || 0) + 1;
    if (st.yr) st.yr.cur[family] = (st.yr.cur[family] || 0) + 1;
  }
  return entry;
}
