// Mixed peoples (Mythic, docs/design/mixed-peoples.md): every town of a Mythic world holds a changing
// mix of the six races instead of exactly one, and every level (town, realm, continent, world)
// can be read as "34 % human, 20 % elven".
//
//   s.peoples   { [race]: share }, shares in [PEOPLES_MIN, 1] summing to 1 (rounded to 1e-6,
//               keys in RACE_LIST order), plain JSON. On every live town of a Mythic world.
//   s.race      the dominant people; it changes only when a challenger leads it by HYST
//               (buildings, plans and identity never flicker). A change is a "turning".
//   sys.myth.mix  { c: { [civId]: [[year, {race: pct}] …] }, w: [[year, {race: pct}] …] }:
//               realm and world makeup every 10 years (≤ 40 samples a series, the oldest
//               thinned by halving; realms fallen > 100 years dropped), integer pct.
//   s.peoplesPast [[year, {race: pct}] …]: the town's own mix at its yearly pass of every decade
//               year, the last PAST_KEEP of them (≈ 50–60 years back), integer pct; a new array
//               on every write. Read through townPeoplesPast ("since Year X" in the dossier).
//   sys.myth.pp   bookkeeping: last turning / expulsion day per town, the recent world-wide
//               days (rate limits), counters, and the expulsion template told last (lt.e:
//               never twice running).
//
// Mechanics, once a year per town on day (s.id · 29) mod 360 of the year (O(towns / 360) a day):
//   growth      share_r ×= 1 + K_GROWTH·(g_r − ḡ), g_r the race's natural increase per year
//               (RACES birth and mortality, the Fading on elves and lizardfolk)
//   migration   the town relaxes toward a target mix: its neighbours within 12 tiles (weight
//               population / (1 + distance)) and its trade partners (weight ∝ route value), each
//               race weighted by how welcome it is here (kinship and enmity with the dominant
//               people, the ruling realm's tolerance); rate 0.004 × (1 + 0.5·links) × pull,
//               pull growing with tier and prosperity (great cities 2–3×). A people new to the
//               town arrives with PEOPLES_MIN at the odds of its inflow (world.rng). Towns of a
//               human realm are crossroads: other peoples ×1.15 as welcome, the rate ×1.2.
//   expulsion   a people of the town other than the ruling race (a minority of the realm), at
//               20–80 % of the town and at enmity with the ruling race (raceRel ≤ −20), in a
//               restless town (unrest ≥ 0.45), may be driven out: half of it leaves for the
//               nearest town of its own people within 45 tiles, a quarter of those dying on
//               the road (or all are lost when there is none). Rare, chronicled, world.rng.
// and on hooks: settlementCreated (settlers carry the mix of the nearest town of their realm
// within 30 tiles, nudged 15 % toward the realm's race) and settlementTransferred (a conqueror's
// race gains 4–12 %). A share falling below PEOPLES_MIN is dropped, unless that would take a
// people out of the world: mixing alone never ends a race.
//
// Published helpers (re-exported by index.js; pure, no rng, cached per month in world.cache):
// townPeoples, civPeoples, landPeoples, worldPeoples, peoplesHistory, townPeoplesPast,
// PEOPLES_MIN. Everything is
// gated on mythLevel 2: a Historical world never sees a field, a draw or a hook answer.

import { on } from '../../core/hooks.js';
import { liveSettlements, liveCivs, settlementsNear } from '../../core/entities.js';
import { dayOfYear, bumpVersion } from '../../core/world.js';
import { emptySlice, takePeople, addPeople } from '../../core/cohorts.js';
import { DAYS_PER_YEAR, DAYS_PER_MONTH, RACE_META } from '../../core/constants.js';
import { isMythic, fin, RACES, RACE_LIST, RACE_IDX, NR, raceRel } from './races.js';
import { record, pickT, fill, yearOfDay, theName, rulerName, seasonAt, placePhrase, aAn } from './prose.js';

let trade = null;
try { trade = await import('../geo/trade.js'); } catch (e) { /* no trade module: neighbours alone move people */ }

/** Smallest share a people keeps in a town (below it, it is dropped and the rest renormalised). */
export const PEOPLES_MIN = 0.005;
const HYST = 0.05;               // a challenger must lead the dominant people by this to take over
const INV29 = 149;               // 29 · 149 ≡ 1 (mod 360): towns of day d have id ≡ 149·d (mod 360)
const FOUND_R = 30;              // settlers come from the nearest town of the realm within this
const FOUND_NUDGE = 0.15;
const NEIGH_R = 12;
const K_GROWTH = 0.09;           // a 2× birth difference moves a 50/50 town ≈ 1 point a decade
const M_BASE = 0.004;
const LINK_CAP = 4;
const ROUTE_W = 10;              // route value → migration weight (a route of 40 ≈ a town of 2,800 six tiles off)
const TRADE_CAP = 1;             // trade partners weigh at most as much as the neighbours (when there are any)
const TIER_PULL = [0.4, 0.55, 0.75, 1, 1.4, 2, 2.6];
// a conqueror's garrison and settlers: 0.045 × sack (≤ 1.75) × kin (0.55) × size (1.15 … 0.79),
// clamped to 4–12 %. Conquest is the strongest mixer (worlds see 250–450 by Y600): kept low.
const CONQ_BASE = 0.045;
const MIX_EVERY = 10, MIX_MAX = 40, MIX_DROP_YEARS = 100;
const PAST_EVERY = 10, PAST_KEEP = 6;   // a town's own samples: every decade, ≈ 50–60 years back
const TURN_TOWN_YEARS = 100;     // a town's turning is chronicled at most once a century
const TURN_WORLD_DECADE = 4;     // and at most four turnings a decade world-wide
const EXPEL_TOWN_YEARS = 60;
const EXPEL_WORLD_CENTURY = 5;
const EXPEL_MIN_SHARE = 0.2, EXPEL_MAX_SHARE = 0.8, EXPEL_REL = -20, EXPEL_UNREST = 0.45, EXPEL_RANGE = 45;
const Y = DAYS_PER_YEAR;
const HUMAN = RACE_IDX.human;
const COSMO_WELCOME = 1.15, COSMO_PULL = 1.2;   // towns of a human realm: the crossroads

const peoplesOn = (world) => isMythic(world) && world.sys.myth != null && world.sys.myth.v != null;

// ---------------------------------------------------------------------------
// State

/** Fill the peoples bookkeeping on the myth state (idempotent). */
function ppState(st) {
  const pp = (st.pp ||= {});
  pp.turn ||= {};
  pp.expel ||= {};
  pp.recent ||= {};
  pp.recent.turn ||= [];
  pp.recent.expel ||= [];
  pp.n ||= {};
  // turned / told (chronicled), expelled, arrivals (first families), kept (a last-of-a-people
  // share held at PEOPLES_MIN), conquests
  for (const k of ['turned', 'told', 'expelled', 'arrivals', 'kept', 'conquests']) if (!Number.isFinite(pp.n[k])) pp.n[k] = 0;
  const mix = (st.mix ||= {});
  if (!mix.c || typeof mix.c !== 'object' || Array.isArray(mix.c)) mix.c = {};
  if (!Array.isArray(mix.w)) mix.w = [];
  return pp;
}

/** A stored mix is usable: an object of known races with finite positive shares summing to ≈ 1. */
function validMix(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  let sum = 0, n = 0;
  for (const r in p) {
    const v = p[r];
    if (RACE_IDX[r] == null || typeof v !== 'number' || !(v > 0) || v > 1 + 1e-9) return false;
    sum += v; n++;
  }
  return n > 0 && Math.abs(sum - 1) <= 1e-6;
}

/**
 * Give every live town of an awake Mythic world its peoples: an older save, a world woken
 * mid-run or by the Awakening gets { [s.race]: 1 } (or the realm's race). Idempotent, no rng; a
 * valid mix is never rewritten.
 */
export function ensurePeoples(world) {
  if (!peoplesOn(world)) return;
  ppState(world.sys.myth);
  for (const s of world.settlements) {
    if (!s || !s.alive) continue;
    if (validMix(s.peoples)) continue;
    let a = null;
    if (s.peoples && typeof s.peoples === 'object') {
      a = toArr(s.peoples);
      if (!tidy(a, null)) a = null;
    }
    const r = s.race && RACES[s.race] ? s.race : world.civs[s.civId]?.race;
    if (!a) {
      if (!r || !RACES[r]) continue;
      s.peoples = { [r]: 1 };
    } else s.peoples = toObj(a);
    if (!s.race || !RACES[s.race] || s.peoples[s.race] == null) s.race = r && s.peoples[r] != null ? r : leaderOf(s.peoples);
  }
}

// ---------------------------------------------------------------------------
// Mix arithmetic (Float64Array by RACE_IDX; objects keyed in RACE_LIST order)

function toArr(p) {
  const a = new Float64Array(NR);
  if (p) for (let k = 0; k < NR; k++) { const v = p[RACE_LIST[k]]; a[k] = typeof v === 'number' && v > 0 && Number.isFinite(v) ? v : 0; }
  return a;
}
function toObj(a) {
  const o = {};
  for (let k = 0; k < NR; k++) if (a[k] > 0) o[RACE_LIST[k]] = a[k];
  return o;
}
function leaderOf(p) {
  let best = null, bv = -1;
  for (const r of RACE_LIST) { const v = p[r]; if (v != null && v > bv) { bv = v; best = r; } }
  return best;
}

/**
 * Normalise a mix in place: drop shares below PEOPLES_MIN (keep(k) pins one at exactly MIN
 * instead), renormalise, round to 1e-6 with the largest share taking the rounding so the sum is
 * 1. Returns false for an empty mix.
 */
function tidy(a, keep) {
  let sum = 0;
  for (let k = 0; k < NR; k++) { if (!(a[k] > 0) || !Number.isFinite(a[k])) a[k] = 0; sum += a[k]; }
  if (!(sum > 0)) return false;
  for (let k = 0; k < NR; k++) a[k] /= sum;
  let pinned = 0;
  for (let pass = 0; pass < 3; pass++) {
    let fixed = 0, rest = 0, changed = false;
    for (let k = 0; k < NR; k++) {
      if (pinned & (1 << k)) { fixed += PEOPLES_MIN; continue; }
      if (a[k] > 0 && a[k] < PEOPLES_MIN) {
        changed = true;
        if (keep && keep(k)) { a[k] = PEOPLES_MIN; pinned |= 1 << k; fixed += PEOPLES_MIN; } else a[k] = 0;
      } else rest += a[k];
    }
    if (!(rest > 0)) {
      // only pinned peoples left (cannot happen with a dominant people present): share alike
      let n = 0;
      for (let k = 0; k < NR; k++) if (pinned & (1 << k)) n++;
      for (let k = 0; k < NR; k++) a[k] = pinned & (1 << k) ? 1 / n : 0;
      break;
    }
    const sc = (1 - fixed) / rest;
    for (let k = 0; k < NR; k++) if (!(pinned & (1 << k))) a[k] *= sc;
    if (!changed) break;
  }
  let mx = 0;
  for (let k = 0; k < NR; k++) { a[k] = Math.round(a[k] * 1e6) / 1e6; if (a[k] > a[mx]) mx = k; }
  let s2 = 0;
  for (let k = 0; k < NR; k++) if (k !== mx) s2 += a[k];
  a[mx] = Math.round((1 - s2) * 1e6) / 1e6;
  return true;
}

/** Index of the dominant people: the current one unless a challenger leads it by HYST. */
function dominantIdx(a, cur) {
  let best = -1;
  for (let k = 0; k < NR; k++) if (a[k] > 0 && (best < 0 || a[k] > a[best])) best = k;
  if (cur == null || cur < 0 || !(a[cur] > 0)) return best;
  return a[best] >= a[cur] + HYST ? best : cur;
}

/** "elf|halfling": the dominant people and a second one at ≥ 25 % (what the Peoples map shows). */
function sigOf(p, race) {
  let second = null, sv = 0.25;
  for (const r of RACE_LIST) if (r !== race && p[r] != null && p[r] >= sv) { sv = p[r]; second = r; }
  return second ? `${race}|${second}` : race || '';
}

/** Natural increase of a race per year (base birth 0.044 × birth, death 0.02 × mortality; the Fading thins the elder births). */
function growthOf(world, k) {
  const r = RACE_LIST[k];
  const R = RACES[r];
  let birth = R.birth;
  if (r === 'elf' || r === 'lizardfolk') birth *= 0.6 + 0.4 * fin(world.sys.myth?.weave, 1);
  return 0.044 * birth - 0.02 * R.mortality;
}

/** Is race index k still found (≥ PEOPLES_MIN) in some live town other than s? */
function presentElsewhere(world, s, k) {
  for (const t of liveSettlements(world)) {
    if (t === s || !t.peoples) continue;
    if (mixArr(world, t)[k] >= PEOPLES_MIN) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Founding and conquest

on('settlementCreated', (world, s) => {
  if (!isMythic(world) || !s) return;
  const civ = world.civs[s.civId];
  const own = s.race && RACES[s.race] ? s.race : civ?.race;
  if (!own || !RACES[own]) return;   // ensurePeoples gives it one when the myth wakes
  // the settlers' origin: the nearest live town of the same realm within 30 tiles
  let src = null, bd = Infinity;
  for (const t of settlementsNear(world, s.x, s.y, FOUND_R)) {
    if (t === s || t.civId !== s.civId || !validMix(t.peoples)) continue;
    const d = (t.x - s.x) * (t.x - s.x) + (t.y - s.y) * (t.y - s.y);
    if (d < bd || (d === bd && src && t.id < src.id)) { bd = d; src = t; }
  }
  if (!src) { s.peoples = { [own]: 1 }; s.race = own; return; }
  const a = toArr(src.peoples);
  for (let k = 0; k < NR; k++) a[k] *= 1 - FOUND_NUDGE;
  const cr = civ?.race && RACES[civ.race] ? civ.race : own;
  a[RACE_IDX[cr]] += FOUND_NUDGE;
  tidy(a, null);
  s.peoples = toObj(a);
  // a tie goes to the realm's own people
  const top = dominantIdx(a, -1);
  s.race = a[RACE_IDX[cr]] >= a[top] ? cr : RACE_LIST[top];
});

on('settlementTransferred', (world, s, oldCivId, newCivId, cause) => {
  if (cause !== 'conquest' || !peoplesOn(world) || !s || !s.alive) return;
  const civ = world.civs[newCivId];
  const cr = civ?.race;
  if (!cr || !RACES[cr]) return;
  if (!validMix(s.peoples)) ensurePeoples(world);
  if (!validMix(s.peoples)) return;
  const pp = ppState(world.sys.myth);
  const a = toArr(s.peoples);
  // garrison and settlers: more under a cruel or warlike conqueror (the town is sacked and
  // resettled), less between kin, and a small town is changed more than a great city
  const cruel = Array.isArray(civ.ruler?.traits) && civ.ruler.traits.includes('cruel');
  const sack = 1 + (cruel ? 0.35 : 0) + 0.4 * Math.max(0, Math.min(1, (fin(civ.traits?.aggression, 0.5) - 0.5) / 0.3));
  const dom = s.race && RACES[s.race] ? s.race : RACE_LIST[dominantIdx(a, -1)];
  const kin = dom === cr || raceRel(dom, cr) >= 8 ? 0.55 : 1;
  const size = 1.15 - 0.06 * Math.max(0, Math.min(6, fin(s.tier, 0)));
  const g = Math.max(0.04, Math.min(0.12, CONQ_BASE * sack * kin * size));
  for (let k = 0; k < NR; k++) a[k] *= 1 - g;
  a[RACE_IDX[cr]] += g;
  tidy(a, null);
  pp.n.conquests++;
  settle(world, pp, s, a, { conquest: civ });
});

/**
 * Store a town's new mix, move its dominant people with hysteresis and note a turning; bumps
 * versions.peoples when what the Peoples map shows (dominant, second ≥ 25 %) changes.
 */
function settle(world, pp, s, a, why) {
  const before = sigOf(s.peoples || {}, s.race);
  const old = s.race;
  const curIdx = old != null && RACE_IDX[old] != null ? RACE_IDX[old] : -1;
  const di = dominantIdx(a, curIdx);
  s.peoples = toObj(a);
  const nu = RACE_LIST[di];
  if (nu !== old) {
    s.race = nu;
    if (old && RACES[old]) turned(world, pp, s, old, nu, why);
  }
  if (sigOf(s.peoples, s.race) !== before) bumpVersion(world, 'peoples');
}

// ---------------------------------------------------------------------------
// The yearly pass

/** Daily: the towns whose day of the year it is (O(towns / 360)). */
export function peoplesDaily(world) {
  const st = world.sys.myth;
  const pp = st.pp && st.pp.n ? st.pp : ppState(st);   // filled at wake
  const d = dayOfYear(world);
  const list = world.settlements;
  let sc = null;
  for (let id = (d * INV29) % DAYS_PER_YEAR; id < list.length; id += DAYS_PER_YEAR) {
    const s = list[id];
    if (!s || !s.alive) continue;
    if (!sc) {
      sc = scratch(world);
      for (let k = 0; k < NR; k++) sc.g[k] = growthOf(world, k);
    }
    townYear(world, pp, s, sc);
  }
}

/** Reusable buffers for the yearly pass (world.cache: safe to lose). */
function scratch(world) {
  return (world.cache.ppScratch ||= { a: new Float64Array(NR), had: new Float64Array(NR), g: new Float64Array(NR), T: new Float64Array(NR), TR: new Float64Array(NR) });
}

/**
 * A town's mix as a Float64Array by RACE_IDX (read-only), cached in world.cache by the identity
 * of s.peoples: every write stores a new object, so a changed mix is never read stale.
 */
function mixArr(world, s) {
  const c = (world.cache.ppArr ||= []);
  const e = c[s.id];
  if (e !== undefined && e.o === s.peoples) return e.a;
  const a = toArr(s.peoples);
  c[s.id] = { o: s.peoples, a };
  return a;
}

/** How welcome race k is in a town whose dominant people is dom, under a realm of tolerance tol. */
function welcome(k, dom, tol) {
  const v = 1 + raceRel(RACE_LIST[k], dom) / 40 + 0.3 * (tol - 0.5);
  return v < 0.15 ? 0.15 : v > 1.6 ? 1.6 : v;
}

/** Migration rate multiplier of a town: tier and prosperity (a town 1, great cities 2–3×), capitals a little more. */
function pullOf(world, s, civ) {
  const tier = Math.max(0, Math.min(6, fin(s.tier, 0) | 0));
  const pop = Math.max(1, fin(s.population, 1));
  const prosp = Math.max(0, Math.min(1, 0.6 * fin(s.happiness, 0.5) + 0.4 * Math.tanh(Math.max(0, fin(s.wealth, 0)) / pop)));
  let p = TIER_PULL[tier] * (0.8 + 0.4 * prosp);
  if (civ && civ.capitalId === s.id) p *= 1.2;
  return p < 0.3 ? 0.3 : p > 3 ? 3 : p;
}

/** T[k] += w × m[k]. */
function addMix(T, m, w) {
  for (let k = 0; k < NR; k++) { const v = m[k]; if (v > 0) T[k] += w * v; }
}

function townYear(world, pp, s, sc) {
  if (!s.peoples || typeof s.peoples !== 'object') {
    ensurePeoples(world);
    if (!validMix(s.peoples)) return;
  }
  const civ = world.civs[s.civId];
  const a = sc.a, had = sc.had, g = sc.g, T = sc.T, TR = sc.TR;
  const cur = mixArr(world, s);
  // 1. differential growth
  let gbar = 0;
  for (let k = 0; k < NR; k++) { a[k] = had[k] = cur[k]; if (a[k] > 0) gbar += a[k] * g[k]; }
  for (let k = 0; k < NR; k++) if (a[k] > 0) a[k] *= 1 + K_GROWTH * (g[k] - gbar);
  // 2. migration toward the neighbours and trade partners
  const dom = s.race && RACES[s.race] ? s.race : RACE_LIST[dominantIdx(a, -1)];
  const tol = fin(civ?.traits?.tolerance, 0.5);
  T.fill(0); TR.fill(0);
  let wn = 0, wt = 0;
  const near = settlementsNear(world, s.x, s.y, NEIGH_R);
  for (let j = 0; j < near.length; j++) {
    const t = near[j];
    if (t === s || !t.peoples) continue;
    const dx = t.x - s.x, dy = t.y - s.y;
    const w = Math.max(0, fin(t.population)) / (1 + Math.sqrt(dx * dx + dy * dy));
    if (!(w > 0)) continue;
    addMix(T, mixArr(world, t), w);
    wn += w;
  }
  let links = 0;
  const routes = trade && typeof trade.routesOf === 'function' ? trade.routesOf(world, s.id) : null;
  if (routes) for (let j = 0; j < routes.length; j++) {
    const r = routes[j];
    if (!r || !r.active) continue;
    const t = world.settlements[r.aId === s.id ? r.bId : r.aId];
    if (!t || !t.alive || !t.peoples) continue;
    links++;
    const w = ROUTE_W * Math.max(0, fin(r.value));
    if (!(w > 0)) continue;
    addMix(TR, mixArr(world, t), w);
    wt += w;
  }
  // trade partners weigh by route value, but never more than the neighbours together
  const tf = wn > 0 && wt > TRADE_CAP * wn ? (TRADE_CAP * wn) / wt : 1;
  let tsum = 0;
  // a human realm is a crossroads (races.js humanEdge): other peoples are more welcome in its
  // towns and come and go faster
  const cosmo = civ && civ.race === 'human';
  for (let k = 0; k < NR; k++) {
    T[k] += tf * TR[k];
    if (T[k] > 0) T[k] *= welcome(k, dom, tol) * (cosmo && k !== HUMAN ? COSMO_WELCOME : 1);
    tsum += T[k];
  }
  let arrived = 0;
  if (tsum > 0) {
    const m = M_BASE * (1 + 0.5 * Math.min(LINK_CAP, links)) * pullOf(world, s, civ) * (cosmo ? COSMO_PULL : 1);
    for (let k = 0; k < NR; k++) {
      const tk = T[k] / tsum;
      if (a[k] > 0) { a[k] += m * (tk - a[k]); continue; }
      const x = m * tk;
      if (!(x > 0)) continue;
      // a people new to the town: the first families settle at the odds of the inflow
      if (x >= PEOPLES_MIN || world.rng.chance(x / PEOPLES_MIN)) {
        a[k] = Math.max(x, PEOPLES_MIN);
        arrived |= 1 << k;
        pp.n.arrivals++;
      }
    }
  }
  // 3. tidy: a share below the floor is dropped, unless the newcomers just arrived or it is
  // the last of a people anywhere (mixing alone never ends a race)
  tidy(a, (k) => {
    if (arrived & (1 << k)) return true;
    if (!(had[k] > 0)) return false;
    if (presentElsewhere(world, s, k)) return false;
    pp.n.kept++;
    return true;
  });
  settle(world, pp, s, a, null);
  // the town's own memory, once a decade (no rng: for the dossier's "since Year X")
  const y = yearOfDay(world.time.day);
  if (y % PAST_EVERY === 0) {
    const old = Array.isArray(s.peoplesPast) ? s.peoplesPast : [];
    if (!old.length || old[old.length - 1][0] !== y) {
      const items = [];
      for (const r of RACE_LIST) { const v = s.peoples[r]; if (v != null) items.push({ race: r, pop: v }); }
      const nu = old.slice(Math.max(0, old.length - (PAST_KEEP - 1)));
      nu.push([y, pctOf(items)]);
      s.peoplesPast = nu;
    }
  }
  // 4. expulsion
  if (civ && civ.alive && civ.race) maybeExpel(world, pp, s, civ);
}

// ---------------------------------------------------------------------------
// Turning

const QUARTER = {
  river: ['river quarter', 'lanes along the river', 'mill-quarter by the water'],
  coast: ['harbour quarter', 'old fish-market', 'streets above the quay'],
  high: ['old town on the hill', 'upper town', 'lanes beneath the old keep'],
  plain: ['old quarter', 'lanes behind the old market', 'oldest streets', 'quarter by the old well'],
};
/** What a people brings when it fills a town (a clause, past tense). */
const BRINGS = {
  human: ['timber houses crowded every lane', 'the markets rang with haggling in the human tongues', 'new walls went up of brick and timber'],
  elf: ['groves were planted in the squares', 'lamps hung in the trees of the market', 'the streets grew quiet and green'],
  dwarf: ['new halls were dug beneath the hill', 'the forges never went cold', 'the old wooden houses were rebuilt in stone'],
  orc: ['war-drums sounded from the old square', 'the beast-pens spread beyond the gate', 'the walls were hung with clan-banners'],
  halfling: ['round green doors appeared in every bank', 'gardens and smials crept over the slopes', 'the inns were never empty'],
  lizardfolk: ['stilt-houses rose over the shallows', 'egg-shrines were raised by the water', 'the reed-beds were dammed into warm pools'],
};
const TURN_TEXT = [
  'By Year {y} {town} had become {aNew} town; the old {oldAdjL} families kept to the {quarter}',
  'Generation by generation {town} changed without a battle: by Year {y} the {newPl} outnumbered the {oldPl}, and {brings}',
  'In Year {y} the {newPl} of {town} at last outnumbered the {oldPl}; {brings}, and the old {oldAdjL} names lived on only in the {quarter}',
  '{Town} was {aNew} town by Year {y}. The {newPl} who had come as {comers} were now the most of its people, and the {oldPl} who stayed were a people of the {quarter}',
  'Few remembered when it happened, but by Year {y} {town} was {aNew} town: {brings}, while the {oldPl} kept their temples in the {quarter}',
];
const TURN_CONQUEST = [
  'After {realm} took {town}, {newPl} followed the banners; by Year {y} they outnumbered the {oldPl}, who kept to the {quarter}',
  'The garrison {realm} left in {town} became a people: by Year {y} the {newPl} were the most of the town, and {brings}',
];

/**
 * A template pool without the one told last (pp.lt[kind], an index into all): the same single
 * rng draw either way, so the choice changes the words, never the world (only where nothing
 * after the pick draws by template: expulsions).
 */
function freshPool(pp, kind, pool, all) {
  const last = (pp.lt ||= {})[kind];
  if (pool.length < 2 || !(last >= 0)) return pool;
  const out = pool.filter((t) => t !== all[last]);
  return out.length ? out : pool;
}

function quarterOf(world, s) {
  const f = world.f;
  const pool = f.river[s.i] > 0 ? QUARTER.river : s.coastal ? QUARTER.coast : (f.elevation[s.i] - fin(world.climate?.seaLevel, 0.5)) >= 0.1 ? QUARTER.high : QUARTER.plain;
  return pool[s.id % pool.length];
}
function comersOf(world, s, nu, why) {
  if (why?.conquest) return 'conquerors';
  const civ = world.civs[s.civId];
  if (civ && civ.race === nu) return pickT(world.rng, ['settlers from the heart of the realm', 'officials and their households', 'soldiers and settlers']);
  const links = trade && typeof trade.routesOf === 'function' ? trade.routesOf(world, s.id).length : 0;
  return links >= 2 ? pickT(world.rng, ['merchants', 'traders and caravan-folk']) : pickT(world.rng, ['farmhands and refugees', 'hired hands', 'newcomers from across the border']);
}

function turned(world, pp, s, old, nu, why) {
  const day = world.time.day;
  pp.n.turned++;
  if (why?.expel) { pp.turn[s.id] = day; return; }
  const last = pp.turn[s.id];
  const recent = pp.recent.turn = pp.recent.turn.filter((d) => day - d < 10 * Y);
  if ((last != null && day - last < TURN_TOWN_YEARS * Y) || recent.length >= TURN_WORLD_DECADE) return;
  pp.turn[s.id] = day;
  recent.push(day);
  pp.n.told++;
  const civ = world.civs[s.civId];
  const conq = why?.conquest || null;
  const big = fin(s.tier, 0) >= 4 || (civ && civ.capitalId === s.id);
  // (no template memory here: a template with {comers} draws once more, so the choice must
  // stay the plain one to keep the world as it is)
  const tpl = conq && world.rng.chance(0.6) ? pickT(world.rng, TURN_CONQUEST) : pickT(world.rng, TURN_TEXT);
  const vars = {
    y: yearOfDay(day), town: s.name, Town: s.name,
    aNew: aAn(RACE_META[nu].adjective.toLowerCase()),
    newPl: RACE_META[nu].plural.toLowerCase(), oldPl: RACE_META[old].plural.toLowerCase(),
    oldAdjL: RACE_META[old].adjective.toLowerCase(),
    quarter: quarterOf(world, s),
    brings: pickT(world.rng, BRINGS[nu] || BRINGS.human),
    comers: '', realm: theName(conq || civ),
  };
  if (tpl.includes('{comers}')) vars.comers = comersOf(world, s, nu, why);
  record(world, {
    imp: big ? 3 : 2, key: 'myth.turned', tags: ['peoples', nu, old],
    text: fill(tpl, vars),
    x: s.x, y: s.y, sid: s.id, civId: s.civId, ref: { k: 'settlement', id: s.id },
  });
}

// ---------------------------------------------------------------------------
// Expulsion and flight

const EXPEL_TEXT = [
  'In the {season} of Year {y} the {rulerAdj} masters of {town} drove out its {victims}; {n} of them took the road to {dest}, and not all of them reached it',
  '{Ruler} ordered the {victims} of {town} beyond the walls in Year {y}. They went with what they could carry, {n} souls, and found refuge among their kin at {dest}',
  'Old hatred boiled over in {town} in Year {y}: the {rulerAdj} garrison turned the {victims} out of their homes, and a long column of exiles, {n} strong, wound its way to {dest}',
  'In Year {y} {town} cast out its {victims}. Their quarter was burned behind them, and {n} survivors were taken in by their kin at {dest}',
  'The {victims} of {town} had lived beside the {rulerPl} for generations, but in the {season} of Year {y} they were driven out; {n} of them reached {dest} with nothing but the clothes they wore',
];
const EXPEL_LOST = [
  'In the {season} of Year {y} the {victims} of {town} were driven out by its {rulerAdj} lords; {n} of them set out {wild} and were never heard of again',
  '{Ruler} drove the {victims} from {town} in Year {y}. With no town of their own kind within reach, {n} exiles scattered {wild}, and few survived the road',
];
const EXPEL_ALL = EXPEL_TEXT.concat(EXPEL_LOST);

/** "some 4,000" / "a few dozen": a headcount for prose. */
function roundCount(n) {
  if (n < 60) return 'a few dozen';
  if (n < 150) return 'about a hundred';
  const p = Math.pow(10, Math.max(1, Math.floor(Math.log10(n)) - 1));
  // thousands separators by hand (no locale tables in the sim)
  return 'some ' + String(Math.round(n / p) * p).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function maybeExpel(world, pp, s, civ) {
  const ruler = civ.race;
  if (!RACES[ruler] || !(fin(s.unrest, 0) >= EXPEL_UNREST)) return;
  const p = s.peoples;
  let victim = null, vs = 0;
  for (const r of RACE_LIST) {
    if (r === ruler) continue;
    const v = p[r];
    if (v == null || v < EXPEL_MIN_SHARE || v > EXPEL_MAX_SHARE || v <= vs || raceRel(r, ruler) > EXPEL_REL) continue;
    victim = r; vs = v;
  }
  if (!victim) return;
  const day = world.time.day;
  const last = pp.expel[s.id];
  if (last != null && day - last < EXPEL_TOWN_YEARS * Y) return;
  const recent = pp.recent.expel = pp.recent.expel.filter((d) => day - d < 100 * Y);
  if (recent.length >= EXPEL_WORLD_CENTURY) return;
  const tol = fin(civ.traits?.tolerance, 0.5);
  const cruel = Array.isArray(civ.ruler?.traits) && civ.ruler.traits.includes('cruel');
  const odds = Math.min(0.45, (0.08 + 0.6 * (fin(s.unrest, 0) - EXPEL_UNREST)) * (1.3 - tol) * (cruel ? 1.6 : 1));
  if (!world.rng.chance(odds)) return;
  expel(world, pp, s, civ, victim);
}

function expel(world, pp, s, civ, victim) {
  const day = world.time.day;
  const a = toArr(s.peoples);
  const vk = RACE_IDX[victim];
  const share = a[vk];
  const pop = Math.max(0, fin(s.population));
  const moved = Math.min(Math.max(0, pop - 8), pop * share / 2);
  a[vk] = share / 2;
  tidy(a, null);
  // the exiles go to the nearest town where their people dominates (or are lost on the road)
  let dest = null, bd = EXPEL_RANGE * EXPEL_RANGE;
  for (const t of settlementsNear(world, s.x, s.y, EXPEL_RANGE)) {
    if (t === s || t.race !== victim || !validMix(t.peoples)) continue;
    const d = (t.x - s.x) * (t.x - s.x) + (t.y - s.y) * (t.y - s.y);
    if (d < bd || (d === bd && dest && t.id < dest.id)) { bd = d; dest = t; }
  }
  const sl = emptySlice();
  takePeople(world, s, moved, 'all', sl, civ);
  settle(world, pp, s, a, { expel: true });   // a turning it causes is told by the expulsion
  if (dest && moved > 0) {
    const arrive = moved * 0.75;   // a quarter die on the road
    const dp = Math.max(0, fin(dest.population));
    const b = toArr(dest.peoples);
    for (let k = 0; k < NR; k++) b[k] *= dp;
    b[vk] += arrive;
    tidy(b, null);
    if (!(dest.population >= 0)) dest.population = dp;
    addPeople(world, dest, sl, arrive);
    settle(world, pp, dest, b, { expel: true });
  }
  pp.expel[s.id] = day;
  pp.recent.expel.push(day);
  pp.n.expelled++;
  const rn = rulerName(civ);
  const vars = {
    y: yearOfDay(day), season: seasonAt(world, s.y, day), town: s.name,
    rulerAdj: RACE_META[civ.race].adjective.toLowerCase(), victims: RACE_META[victim].plural.toLowerCase(),
    n: roundCount(moved), dest: dest ? dest.name : '',
    rulerPl: RACE_META[civ.race].plural.toLowerCase(),
    Ruler: rn || `The ${RACE_META[civ.race].adjective.toLowerCase()} lords of ${theName(civ)}`,
    wild: placePhrase(world, s.x, s.y) ? 'into the wild country ' + placePhrase(world, s.x, s.y) : 'into the wild country',
  };
  // a "long column" needs a crowd; never the template told last
  const tpl = pickT(world.rng, freshPool(pp, 'e', dest ? (moved >= 300 ? EXPEL_TEXT : EXPEL_TEXT.filter((t) => !t.includes('long column'))) : EXPEL_LOST, EXPEL_ALL));
  pp.lt.e = EXPEL_ALL.indexOf(tpl);
  record(world, {
    imp: fin(s.tier, 0) >= 4 ? 3 : 2, key: 'myth.expulsion', tags: ['peoples', victim, civ.race],
    text: fill(tpl, vars),
    x: s.x, y: s.y, sid: s.id, civId: civ.id, ref: { k: 'settlement', id: s.id },
  });
}

// ---------------------------------------------------------------------------
// History for charts (every 10 years, at the yearly myth pass)

/** Whole percentages that sum to 100 (largest remainder), zeros left out. */
function pctOf(items) {
  let tot = 0;
  for (const it of items) tot += it.pop;
  const out = {};
  if (!(tot > 0)) return out;
  const raw = items.map((it) => ({ r: it.race, v: (100 * it.pop) / tot }));
  let given = 0;
  for (const x of raw) { x.f = Math.floor(x.v); x.rem = x.v - x.f; given += x.f; }
  const order = raw.slice().sort((p, q) => q.rem - p.rem || RACE_IDX[p.r] - RACE_IDX[q.r]);
  for (let k = 0; k < 100 - given && k < order.length; k++) order[k].f++;
  for (const r of RACE_LIST) { const x = raw.find((z) => z.r === r); if (x && x.f > 0) out[r] = x.f; }
  return out;
}

function pushSample(series, sample) {
  series.push(sample);
  if (series.length <= MIX_MAX) return series;
  // thin the oldest half by keeping every other sample
  const half = series.length >> 1;
  const out = [];
  for (let k = 0; k < series.length; k++) if (k >= half || k % 2 === 0) out.push(series[k]);
  return out;
}

/** Yearly (the myth's yearly pass): sample realm and world makeup every MIX_EVERY years. */
export function peoplesYearly(world) {
  const st = world.sys.myth;
  const pp = ppState(st);
  const day = world.time.day;
  // forget old bookkeeping
  for (const k of Object.keys(pp.turn)) if (day - pp.turn[k] >= TURN_TOWN_YEARS * Y || !world.settlements[k]?.alive) delete pp.turn[k];
  for (const k of Object.keys(pp.expel)) if (day - pp.expel[k] >= EXPEL_TOWN_YEARS * Y || !world.settlements[k]?.alive) delete pp.expel[k];
  const y = yearOfDay(day);
  if (y % MIX_EVERY !== 0) return;
  const sum = computeSummary(world);   // fresh: never the UI's monthly cache
  const mix = st.mix;
  for (const civ of liveCivs(world)) {
    const items = sum.civ.get(civ.id);
    if (!items || !items.length) continue;
    mix.c[civ.id] = pushSample(mix.c[civ.id] || [], [y, pctOf(items)]);
  }
  if (sum.world.length) mix.w = pushSample(mix.w, [y, pctOf(sum.world)]);
  for (const k of Object.keys(mix.c)) {
    const civ = world.civs[k];
    if (!civ || (!civ.alive && day - fin(civ.fallenDay, day) > MIX_DROP_YEARS * Y)) delete mix.c[k];
  }
}

// ---------------------------------------------------------------------------
// Published helpers (pure)

/** The items of a town: [{ race, share }] by share (desc), [] outside Mythic worlds. */
export function townPeoples(world, s) {
  if (!isMythic(world) || !s) return [];
  const out = [];
  if (validMix(s.peoples)) {
    for (const r of RACE_LIST) { const v = s.peoples[r]; if (v != null) out.push({ race: r, share: v }); }
  } else {
    const r = s.race || world.civs[s.civId]?.race;
    if (r && RACES[r]) out.push({ race: r, share: 1 });
  }
  return out.sort((p, q) => q.share - p.share || RACE_IDX[p.race] - RACE_IDX[q.race]);
}

/** One pass over the live towns: per realm, per landmass and world-wide { race, share, pop, towns }. */
function computeSummary(world) {
  const civ = new Map(), land = new Map(), wld = new Map();
  const lm = world.f.landmass;
  const bump = (bag, key, r, pop, dom) => {
    let m = bag.get(key);
    if (!m) bag.set(key, (m = new Map()));
    let e = m.get(r);
    if (!e) m.set(r, (e = { race: r, share: 0, pop: 0, towns: 0 }));
    e.pop += pop;
    if (dom) e.towns++;
  };
  for (const s of liveSettlements(world)) {
    const items = townPeoples(world, s);
    if (!items.length) continue;
    const pop = Math.max(0, fin(s.population));
    const dom = s.race && RACES[s.race] ? s.race : items[0].race;
    const li = lm ? lm[s.i] : -1;
    for (const it of items) {
      const pr = pop * it.share, d = it.race === dom;
      bump(civ, s.civId, it.race, pr, d);
      bump(land, li, it.race, pr, d);
      bump(wld, 0, it.race, pr, d);
    }
    // a dominant people missing from the mix (cannot happen) still counts its town
    if (!items.some((it) => it.race === dom)) { bump(civ, s.civId, dom, 0, true); bump(land, li, dom, 0, true); bump(wld, 0, dom, 0, true); }
  }
  const finish = (m) => {
    const out = [...m.values()];
    let tot = 0;
    for (const e of out) tot += e.pop;
    for (const e of out) e.share = tot > 0 ? e.pop / tot : 0;
    return out.sort((p, q) => q.pop - p.pop || q.towns - p.towns || RACE_IDX[p.race] - RACE_IDX[q.race]);
  };
  const res = { civ: new Map(), land: new Map(), world: [] };
  for (const [k, m] of civ) res.civ.set(k, finish(m));
  for (const [k, m] of land) res.land.set(k, finish(m));
  res.world = wld.has(0) ? finish(wld.get(0)) : [];
  return res;
}

/** The summary, cached per month (and per settlements / peoples version) for the UI. */
function summary(world) {
  const c = world.cache;
  const key = `${Math.floor(world.time.day / DAYS_PER_MONTH)}|${world.versions.settlements || 0}|${world.versions.peoples || 0}`;
  if (c.peoplesSum && c.peoplesSumKey === key) return c.peoplesSum;
  c.peoplesSum = computeSummary(world);
  c.peoplesSumKey = key;
  return c.peoplesSum;
}
const copyItems = (items) => (items ? items.map((e) => ({ race: e.race, share: e.share, pop: e.pop, towns: e.towns })) : []);

/** A realm's peoples across its live towns: [{ race, share, pop, towns }] by population (desc). */
export function civPeoples(world, civ) {
  if (!isMythic(world) || !civ) return [];
  const id = typeof civ === 'number' ? civ : civ.id;
  return copyItems(summary(world).civ.get(id));
}
/** The peoples of a continent or island (world.f.landmass id), same shape. */
export function landPeoples(world, landmassId) {
  if (!isMythic(world)) return [];
  return copyItems(summary(world).land.get(landmassId));
}
/** The peoples of the world, same shape. */
export function worldPeoples(world) {
  if (!isMythic(world)) return [];
  return copyItems(summary(world).world);
}
/** Makeup over time: [[year, { race: pct }] …] for kind 'civ' (by id) or 'world'; [] when none. */
export function peoplesHistory(world, kind, id) {
  const mix = isMythic(world) ? world.sys.myth?.mix : null;
  if (!mix) return [];
  const s = kind === 'world' ? mix.w : kind === 'civ' ? mix.c?.[id] : null;
  return Array.isArray(s) ? s.slice() : [];
}

/**
 * A town's mix about `years` ago, from its own decade samples (s.peoplesPast): the sample whose
 * age is nearest `years`, between 0.8× and 1.4× it → { year, items: [{ race, share }] by share
 * (desc) }, or null while the town is younger than that or outside Mythic worlds. Pure.
 */
export function townPeoplesPast(world, s, years = 50) {
  if (!isMythic(world) || !s || !Array.isArray(s.peoplesPast)) return null;
  const now = yearOfDay(world.time.day);
  const want = Math.max(1, fin(years, 50));
  let best = null, bd = Infinity;
  for (const smp of s.peoplesPast) {
    if (!Array.isArray(smp) || !Number.isFinite(smp[0]) || !smp[1] || typeof smp[1] !== 'object') continue;
    const age = now - smp[0];
    if (age < want * 0.8 || age > want * 1.4) continue;
    const d = Math.abs(age - want);
    if (d < bd) { bd = d; best = smp; }
  }
  if (!best) return null;
  const items = [];
  for (const r of RACE_LIST) { const v = best[1][r]; if (typeof v === 'number' && v > 0) items.push({ race: r, share: v / 100 }); }
  if (!items.length) return null;
  items.sort((p, q) => q.share - p.share || RACE_IDX[p.race] - RACE_IDX[q.race]);
  return { year: best[0], items };
}

/** Counters for reports and tests: turnings, chronicled turnings, expulsions, arrivals, kept, conquests. */
export function peoplesCounts(world) {
  const pp = world.sys.myth?.pp;
  return pp && pp.n ? { ...pp.n } : null;
}

/**
 * Mixing statistics of the live towns (for reports and tests): towns, towns with a minority
 * ≥ 10 %, cities (tier ≥ 4) with three peoples ≥ 10 %, invalid mixes.
 */
export function mixStats(world) {
  let towns = 0, mixed = 0, three = 0, threeAny = 0, bad = 0, domOk = 0;
  const examples = [];
  for (const s of liveSettlements(world)) {
    towns++;
    if (!validMix(s.peoples) || s.peoples[s.race] == null) { bad++; continue; }
    const items = townPeoples(world, s);
    if (items.some((it) => it.race !== s.race && it.share >= 0.1)) mixed++;
    const n10 = items.filter((it) => it.share >= 0.1).length;
    if (n10 >= 3) { threeAny++; if (fin(s.tier, 0) >= 4) { three++; examples.push({ id: s.id, name: s.name, tier: s.tier, mix: items.map((it) => `${it.race} ${Math.round(100 * it.share)}`).join(' / ') }); } }
    if (items[0].race === s.race || items[0].share - s.peoples[s.race] < HYST) domOk++;
  }
  return { towns, mixed, three, threeAny, bad, domOk, examples: examples.slice(0, 6) };
}
