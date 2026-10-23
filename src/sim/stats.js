// Statistics: the world's ledger of vital signs.
//   world.history.years   one compact record per sim-year (≤ 1500; older ones thinned), with
//                         the keys of every yearRecord provider merged in under its id
//   world.history.atlas   a border snapshot every ten years (≤ 600 and ~6 MB; older ones thinned)
//   world.history.series  whole-life time series per entity (./ledger.js)
//   world.history.events  the catastrophe catalogue (./catalogue.js)
//   world.sites           historic sites (./sites.js through core/sites.js)
//   world.sys.stats.records  the Hall of Records (./records.js)
//   world.stats           a summary refreshed each month (HUD, panels, headless reports)
// DOM-free. Runs last (order 100) so it sees each day's finished state. Every number it
// stores is finite and rounded, so history stays small and JSON-clean. Draws no rng; the
// chronicle entries it writes (record-breaking moments, the turn of each century) choose their
// sentences by the day, so a history never depends on whether anyone was watching.

import { WATER, DAYS_PER_YEAR, ERAS, TIERS } from '../core/constants.js';
import { isYearStart, isMonthStart, yearOf } from '../core/world.js';
import { liveCivs, liveSettlements } from '../core/entities.js';
import { typedToBase64 } from '../core/serialize.js';
import { chronicle } from '../core/chronicle.js';
import { on } from '../core/hooks.js';
import { mergeOf } from '../core/ext.js';
import { MAX_SITES } from '../core/sites.js';
import { sampleLedger, initLedger, ledgerStats, LEDGER_K, OWN_CAP } from './ledger.js';
import { scanRecords, flushRecordNews, HANDLERS as RECORD_HANDLERS, getRecords, theCiv, mid } from './records.js';
import { HANDLERS as CATALOGUE_HANDLERS, catalogueStats, eventStore, isWaterAt, MAX_EVENTS } from './catalogue.js';
import { HANDLERS as SITE_HANDLERS, seedRuins, unpinRuins, siteStats } from './sites.js';

let diplomacy = null;
try { diplomacy = await import('./geo/diplomacy.js'); } catch (e) { /* civPower unavailable: estimate locally */ }

export const MAX_YEARS = 1500;      // yearly records kept (older ones thinned to every other year, and so on)
export const MAX_ATLAS = 600;
export const ATLAS_EVERY = 10;      // years between border snapshots
export const ATLAS_TOWNS = 150;     // settlements kept per snapshot
export const RECORD_CIVS = 48;      // nations itemised per yearly record (largest first)
export const ATLAS_CIVS = 64;       // nations listed per snapshot (most territory first)

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const r0 = (v) => Math.round(fin(v));
const r1 = (v) => Math.round(fin(v) * 10) / 10;
const r2 = (v) => Math.round(fin(v) * 100) / 100;
const r3 = (v) => Math.round(fin(v) * 1000) / 1000;
const r4 = (v) => Math.round(fin(v) * 10000) / 10000;

/** Sea level relative to genesis, in metres (the land elevation scale of elevationMeters). */
export function seaLevelMeters(world) {
  const c = world.climate || {};
  const base = fin(c.baseSeaLevel, 0.5);
  return ((fin(c.seaLevel, base) - base) / Math.max(1e-6, 1 - base)) * 7000;
}

/**
 * Military/economic strength of a civ: diplomacy's civPower when available, else an estimate.
 * readOnly (for the UI, which runs between simulated days): never trigger diplomacy's per-day
 * power cache, since filling it at a different moment of the day than the simulation would
 * changes what the simulation later reads, and with it the course of history. Reads the
 * cache if it is there; otherwise estimates locally without touching world state.
 */
export function powerOf(world, civ, readOnly = false) {
  if (!civ || !civ.alive) return 0;
  if (readOnly) {
    const cached = world.cache?.civPower;
    const v = cached && typeof cached === 'object' ? cached[civ.id] : undefined;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  } else if (diplomacy?.civPower) {
    try {
      const p = diplomacy.civPower(world, civ);
      if (Number.isFinite(p)) return p;
    } catch (e) { /* fall through to estimate */ }
  }
  const pop = fin(civ.population);
  const manpower = fin(civ.military?.manpower, pop * 0.03);
  const era = fin(civ.tech?.era);
  return (manpower * (1 + 0.35 * era) + Math.sqrt(Math.max(0, fin(civ.treasury))) * 4) / 100;
}

// ---------------------------------------------------------------------------
// Grid survey (one full pass; yearly)

function surveyGrid(world) {
  const { f, N } = world;
  const nCivs = world.civs.length;
  let terr = world.cache.statsTerritory;
  if (!terr || terr.length < nCivs) terr = world.cache.statsTerritory = new Int32Array(Math.max(32, nCivs * 2));
  terr.fill(0);
  const water = f.water, annTemp = f.annTemp, veg = f.veg, herb = f.herb, pred = f.pred, fish = f.fish;
  const snow = f.snow, farm = f.farm, soil = f.soil, annRain = f.annRain, poll = f.pollution;
  const dev = f.devastation, owner = f.owner, fire = f.fire, road = f.road;
  let landN = 0, waterN = 0, tAll = 0, tLand = 0, sVeg = 0, sHerb = 0, sPred = 0, sFish = 0;
  let sSnow = 0, sFarm = 0, sSoil = 0, sRain = 0, sPoll = 0, sDev = 0, owned = 0, burning = 0;
  let forest = 0, iceLand = 0, roads = 0;
  for (let i = 0; i < N; i++) {
    const t = annTemp[i];
    tAll += t;
    sSnow += snow[i];
    if (water[i] === WATER.LAND) {
      landN++;
      tLand += t;
      const v = veg[i];
      sVeg += v; sHerb += herb[i]; sPred += pred[i];
      sFarm += farm[i]; sSoil += soil[i]; sRain += annRain[i];
      sPoll += poll[i]; sDev += dev[i];
      if (v > 0.5) forest++;
      if (snow[i] > 0.6) iceLand++;
      if (road[i] > 0) roads++;
      if (fire[i] > 0) burning++;
      const o = owner[i];
      if (o >= 0) { owned++; if (o < terr.length) terr[o]++; }
    } else {
      waterN++;
      sFish += fish[i];
    }
  }
  const L = Math.max(1, landN), Wn = Math.max(1, waterN), A = Math.max(1, N);
  return {
    landTiles: landN,
    temp: fin(tAll / A), landTemp: fin(tLand / L),
    veg: fin(sVeg / L), herb: fin(sHerb / L), pred: fin(sPred / L), fish: fin(sFish / Wn),
    ice: fin(sSnow / A), farm: fin(sFarm / L), soil: fin(sSoil / L), rain: fin(sRain / L),
    poll: fin(sPoll / L), dev: fin(sDev / L), owned: fin(owned / L), forest: fin(forest / L),
    iceLand: fin(iceLand / L), roads, burning,
  };
}

// ---------------------------------------------------------------------------
// Summary (monthly; also callable by the UI at any time)

/**
 * Live members of a list that only grows (wars, trade routes), recounted only when ver (the
 * version its owner bumps on every start and end) or the length changes. Cache only.
 */
function activeCount(world, key, list, ver) {
  const c = (world.cache.statCounts ||= {});
  const e = c[key];
  if (e && e.v === ver && e.n === list.length) return e.k;
  let k = 0;
  for (const x of list) if (x && x.active) k++;
  c[key] = { v: ver, n: list.length, k };
  return k;
}

/** Headline numbers for the world right now. O(entities), no grid pass. */
export function summarize(world) {
  const towns = liveSettlements(world);
  const civs = liveCivs(world);
  let pop = 0, cities = 0, big = null;
  const civPop = Object.create(null);
  for (const s of towns) {
    const p = fin(s.population);
    pop += p;
    if (fin(s.tier) >= 4) cities++;
    if (!big || p > fin(big.population)) big = s;
    civPop[s.civId] = (civPop[s.civId] || 0) + p;
  }
  let era = 0, eraLeader = null, topCiv = null, topPop = -1, treasury = 0, stab = 0;
  for (const c of civs) {
    const e = fin(c.tech?.era);
    if (eraLeader == null || e > era) { era = e; eraLeader = c.id; }
    const p = civPop[c.id] || 0;
    if (p > topPop) { topPop = p; topCiv = c; }
    treasury += fin(c.treasury);
    stab += fin(c.stability);
  }
  // wars and roads only ever accumulate: count the live ones once per change, not every month
  const wars = activeCount(world, 'wars', world.wars, world.versions.wars || 0);
  let plagues = 0;
  for (const p of world.plagues) if (p.active) plagues++;
  let faiths = 0;
  for (const r of world.religions) if (r.alive !== false) faiths++;
  const routes = activeCount(world, 'routes', world.tradeRoutes, world.cache.routeEpoch || 0);
  let fires = 0;
  for (const fr of world.fires) if (fr.active) fires++;
  let wonders = 0;
  for (const w of world.wonders) if (w.destroyedDay == null) wonders++;
  let erupting = 0;
  for (const v of world.volcanoes) if (fin(v.erupting) > 0) erupting++;
  const c = world.climate || {};
  const grid = world.stats?.grid || null;
  return {
    day: world.time.day,
    year: yearOf(world),
    pop: r0(pop),
    civs: civs.length,
    fallen: world.civs.length - civs.length,
    towns: towns.length,
    cities,
    bigCity: big ? { id: big.id, name: big.name, pop: r0(big.population), civId: big.civId, tier: fin(big.tier) } : null,
    topCiv: topCiv ? { id: topCiv.id, name: topCiv.name, pop: r0(topPop) } : null,
    era, eraName: ERAS[era]?.name || ERAS[0].name, eraLeader,
    wars, plagues, faiths, routes, fires, wonders, erupting,
    armies: world.armies.length,
    caravans: world.caravans.length,
    storms: world.storms.length,
    figures: world.figures.length,
    treasury: r0(treasury),
    stability: r3(civs.length ? stab / civs.length : 0),
    tempOffset: r2(c.tempOffset), co2: r1(fin(c.co2, 280)), aerosol: r3(c.aerosol),
    seaM: r1(seaLevelMeters(world)), drought: r3(c.droughtIndex),
    avgTemp: r2(c.avgTemp), avgLandTemp: r2(c.avgLandTemp),
    grid,
  };
}

// ---------------------------------------------------------------------------
// Yearly record

function sumWarTotals(world) {
  let battles = 0, casualties = 0;
  for (const w of world.wars) {
    battles += fin(w.battles);
    if (w.casualties) for (const k in w.casualties) casualties += fin(w.casualties[k]);
  }
  return { battles, casualties };
}
function sumPlagueDeaths(world) {
  let d = 0;
  for (const p of world.plagues) d += fin(p.deaths);
  return d;
}

/** Build this year's record (does not store it). */
export function buildYearRecord(world, st, grid, warTotals = null) {
  const towns = liveSettlements(world);
  const civs = liveCivs(world);
  let pop = 0, big = 0;
  const civPop = Object.create(null), civTowns = Object.create(null);
  for (const s of towns) {
    const p = fin(s.population);
    pop += p;
    if (p > big) big = p;
    civPop[s.civId] = (civPop[s.civId] || 0) + p;
    civTowns[s.civId] = (civTowns[s.civId] || 0) + 1;
  }
  const terr = world.cache.statsTerritory;
  const civ = {};
  let era = 0, wealth = 0;
  for (const c of civs) {
    const e = fin(c.tech?.era);
    if (e > era) era = e;
    wealth += fin(c.treasury);
  }
  // itemise the largest nations; the rest are implied by pop − Σ civ pops
  const listed = civs.length > RECORD_CIVS
    ? civs.slice().sort((a, b) => (civPop[b.id] || 0) - (civPop[a.id] || 0)).slice(0, RECORD_CIVS)
    : civs;
  for (const c of listed) {
    const e = fin(c.tech?.era);
    civ[c.id] = [
      r0(civPop[c.id] || 0),
      terr && c.id < terr.length ? terr[c.id] : r0(c.territory),
      civTowns[c.id] || 0,
      e,
      r1(powerOf(world, c)),
    ];
  }
  let wars = 0, plagues = 0, faiths = 0, routes = 0;
  for (const w of world.wars) if (w.active) wars++;
  for (const p of world.plagues) if (p.active) plagues++;
  for (const r of world.religions) if (r.alive !== false) faiths++;
  for (const r of world.tradeRoutes) if (r.active) routes++;

  // flows since the previous record
  const ev = {};
  const entries = world.chronicle.entries;
  for (let k = entries.length - 1; k >= 0; k--) {
    const e = entries[k];
    if (e.seq <= st.lastSeq) break;
    if (e.imp >= 2) ev[e.cat] = (ev[e.cat] || 0) + 1;
  }
  const totals = warTotals || sumWarTotals(world);
  const pd = sumPlagueDeaths(world);
  let fell = 0;
  const since = world.time.day - DAYS_PER_YEAR;
  for (const c of world.civs) if (!c.alive && c.fallenDay != null && c.fallenDay > since) fell++;

  // who the people are: the leading faiths, the share living in towns, settlements by tier
  const relPop = Object.create(null);
  const tiers = [0, 0, 0, 0, 0, 0, 0];
  let urban = 0;
  for (const s of towns) {
    const p = fin(s.population);
    const t = Math.max(0, Math.min(6, fin(s.tier) | 0));
    tiers[t]++;
    if (t >= 3) urban += p;
    const rel = s.religion;
    if (rel) for (const rid in rel) { const sh = fin(rel[rid]); if (sh > 0) relPop[rid] = (relPop[rid] || 0) + sh * p; }
  }
  const rel = {};
  for (const [rid, n] of Object.entries(relPop).sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 10)) if (n >= 1) rel[rid] = r0(n);

  const cl = world.climate || {};
  return {
    y: yearOf(world),
    pop: r0(pop),
    civs: civs.length,
    towns: towns.length,
    temp: r2(grid.temp),
    landTemp: r2(grid.landTemp),
    sea: r1(seaLevelMeters(world)),
    co2: r1(fin(cl.co2, 280)),
    ice: r4(grid.ice),
    veg: r4(grid.veg),
    herb: r4(grid.herb),
    pred: r4(grid.pred),
    fish: r4(grid.fish),
    wars,
    plagues,
    faiths,
    era,
    civ,
    // extended vital signs
    big: r0(big),
    routes,
    armies: world.armies.length,
    storms: world.storms.length,
    fires: grid.burning,
    forest: r4(grid.forest),
    farm: r4(grid.farm),
    soil: r4(grid.soil),
    rain: r4(grid.rain),
    poll: r4(grid.poll),
    dev: r4(grid.dev),
    owned: r4(grid.owned),
    roads: grid.roads,
    wealth: r0(wealth),
    aer: r3(cl.aerosol),
    drought: r3(cl.droughtIndex),
    tOff: r2(cl.tempOffset),
    newCivs: Math.max(0, world.civs.length - st.lastCivCount),
    fell,
    newWars: Math.max(0, world.wars.length - st.lastWarCount),
    newPlagues: Math.max(0, world.plagues.length - st.lastPlagueCount),
    battles: r0(Math.max(0, totals.battles - st.lastBattles)),
    casualties: r0(Math.max(0, totals.casualties - st.lastCasualties)),
    pdeaths: r0(Math.max(0, pd - st.lastPlagueDeaths)),
    ev,
    rel,
    urb: pop > 0 ? Math.round((urban / pop) * 1000) : 0,
    tiers,
  };
}

/** Halve the density of the older half of a list so it never exceeds cap. Keeps the array identity. */
export function thinList(list, cap) {
  if (list.length <= cap) return;
  const half = Math.floor(list.length / 2);
  let w = 0;
  for (let k = 0; k < list.length; k++) {
    if (k >= half || k % 2 === 0 || k === half - 1) list[w++] = list[k];
  }
  list.length = w;
  if (list.length > cap) list.splice(0, list.length - cap);
}

// ---------------------------------------------------------------------------
// Atlas snapshots

/** Border snapshot at half resolution: owner grid as base64 Int16Array + top settlements. */
export function takeSnapshot(world) {
  const { W, H, f } = world;
  const w = Math.ceil(W / 2), h = Math.ceil(H / 2);
  let g = world.cache.statsSnapGrid;
  if (!g || g.length !== w * h) g = world.cache.statsSnapGrid = new Int16Array(w * h);
  const owner = f.owner;
  const counts = Object.create(null);
  for (let cy = 0; cy < h; cy++) {
    const y0 = cy * 2, y1 = Math.min(H - 1, y0 + 1);
    for (let cx = 0; cx < w; cx++) {
      const x0 = cx * 2, x1 = Math.min(W - 1, x0 + 1);
      const a = owner[y0 * W + x0], b = owner[y0 * W + x1], c = owner[y1 * W + x0], d = owner[y1 * W + x1];
      // mode of the 2×2 block; an owned value wins ties against unowned
      let best = a, bn = 1 + (b === a) + (c === a) + (d === a);
      if (b !== a) {
        const n = 1 + (c === b) + (d === b);
        if (n > bn || (n === bn && best < 0 && b >= 0)) { best = b; bn = n; }
      }
      if (c !== a && c !== b) {
        const n = 1 + (d === c);
        if (n > bn || (n === bn && best < 0 && c >= 0)) { best = c; bn = n; }
      }
      if (d !== a && d !== b && d !== c && bn === 1 && best < 0 && d >= 0) best = d;
      g[cy * w + cx] = best;
    }
  }
  for (let k = 0; k < g.length; k++) { const o = g[k]; if (o >= 0) counts[o] = (counts[o] || 0) + 1; }
  const top = liveSettlements(world).slice()
    .sort((p, q) => fin(q.population) - fin(p.population))
    .slice(0, ATLAS_TOWNS);
  const towns = top.map((s) => [s.x, s.y, s.civId, fin(s.tier), s.name]);
  // nations on the map (territory in full-resolution tiles) or holding a listed town
  const present = new Set(Object.keys(counts).map(Number));
  for (const t of towns) present.add(t[2]);
  let civs = [];
  for (const id of present) {
    const c = world.civs[id];
    if (c) civs.push([id, c.name, c.colorHex, (counts[id] || 0) * 4, c.alive ? r0(c.population) : 0]);
  }
  civs.sort((p, q) => q[3] - p[3] || q[4] - p[4]);
  if (civs.length > ATLAS_CIVS) civs = civs.slice(0, ATLAS_CIVS);
  return {
    y: yearOf(world), day: world.time.day, w, h,
    owner: typedToBase64(g),
    towns, civs,
  };
}

// ---------------------------------------------------------------------------
// The system

/** A provider's answer as plain, finite JSON (anything else is dropped). */
function jsonSafe(v, depth = 0) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : 0;
  if (typeof v === 'string' || typeof v === 'boolean' || v === null) return v;
  if (depth > 4 || typeof v !== 'object') return null;
  if (Array.isArray(v)) return v.slice(0, 64).map((x) => jsonSafe(x, depth + 1));
  const o = {};
  for (const [k, x] of Object.entries(v)) if (typeof x !== 'function' && x !== undefined) o[k] = jsonSafe(x, depth + 1);
  return o;
}

function ensureState(world) {
  if (!world.history || typeof world.history !== 'object') world.history = { years: [], atlas: [] };
  if (!Array.isArray(world.history.years)) world.history.years = [];
  if (!Array.isArray(world.history.atlas)) world.history.atlas = [];
  eventStore(world);
  const st = (world.sys.stats ||= {});
  st.lastSeq ??= world.chronicle?.seq ?? 0;
  st.lastCivCount ??= world.civs.length;
  st.lastWarCount ??= world.wars.length;
  st.lastPlagueCount ??= world.plagues.length;
  st.lastBattles ??= sumWarTotals(world).battles;
  st.lastCasualties ??= sumWarTotals(world).casualties;
  st.lastPlagueDeaths ??= sumPlagueDeaths(world);
  if (!world.stats || typeof world.stats !== 'object') world.stats = {};
  return st;
}

function recordYear(world) {
  const st = ensureState(world);
  const years = world.history.years;
  const y = yearOf(world);
  if (years.length && years[years.length - 1].y >= y) return;
  const grid = surveyGrid(world);
  const totals = sumWarTotals(world);   // one pass serves the record and next year's baselines
  const rec = buildYearRecord(world, st, grid, totals);
  // other packages' yearly keys (contracts §7 yearRecord), each under its provider id
  const extra = mergeOf('yearRecord', world);
  if (extra) for (const [id, v] of Object.entries(extra)) if (!(id in rec) && v != null && typeof v !== 'function') rec[id] = jsonSafe(v);
  years.push(rec);
  thinList(years, MAX_YEARS);
  // remember flow baselines for next year
  st.lastSeq = world.chronicle.seq;
  st.lastCivCount = world.civs.length;
  st.lastWarCount = world.wars.length;
  st.lastPlagueCount = world.plagues.length;
  st.lastBattles = totals.battles;
  st.lastCasualties = totals.casualties;
  st.lastPlagueDeaths = sumPlagueDeaths(world);
  st.genesis ||= { veg: rec.veg, herb: rec.herb, pred: rec.pred, fish: rec.fish, landTemp: rec.landTemp, pop: rec.pop, y };
  world.stats = summarize(world);
  world.stats.grid = {
    temp: r2(grid.temp), landTemp: r2(grid.landTemp), veg: r4(grid.veg), herb: r4(grid.herb),
    pred: r4(grid.pred), fish: r4(grid.fish), ice: r4(grid.ice), forest: r4(grid.forest),
    farm: r4(grid.farm), owned: r4(grid.owned), poll: r4(grid.poll), year: y,
  };
}

/** Snapshot cap: 600, or fewer so the atlas stays under ~6 MB of base64 (older ones thinned). */
export function atlasCap(world) {
  const cells = Math.ceil(world.W / 2) * Math.ceil(world.H / 2);
  const bytes = Math.ceil((cells * 2) / 3) * 4 + 6000;   // base64 grid + towns list
  return Math.max(120, Math.min(MAX_ATLAS, Math.floor(6e6 / bytes)));
}

function recordAtlas(world) {
  const atlas = world.history.atlas;
  const y = yearOf(world);
  if (atlas.length && atlas[atlas.length - 1].y >= y) return;
  atlas.push(takeSnapshot(world));
  thinList(atlas, atlasCap(world));
}

// ---------------------------------------------------------------------------
// Fallbacks: until another package emits a hook (contracts §5), read the same moments from
// the state it already keeps, so the ledgers fill in either way. Each switches off for good
// the first time its hook is seen (sys.stats.hk), and its cursor lives in sys.stats.fb so a
// saved world resumes exactly.

const MODULE_HANDLERS = [RECORD_HANDLERS, CATALOGUE_HANDLERS, SITE_HANDLERS];
const WATCHED_HOOKS = ['battle', 'quake', 'eruption', 'impact', 'plagueEnded', 'fireEnded', 'religionFounded'];
// a battle hook only stands in for the war battle log when it comes from a war (bands emit
// their own clashes, kind 'band' / 'beast', before or without any war emitter)
for (const name of WATCHED_HOOKS) {
  on(name, (world, payload) => {
    if (name === 'battle' && (!payload || payload.warId == null || payload.kind === 'band' || payload.kind === 'beast')) return;
    const st = (world.sys.stats ||= {});
    (st.hk ||= {})[name] = 1;
  });
}

function dispatch(world, name, payload) {
  for (const hs of MODULE_HANDLERS) {
    const fn = hs[name];
    if (typeof fn === 'function') { try { fn(world, payload); } catch (e) { console.error(`[stats:fallback:${name}]`, e); } }
  }
}

function fallbacks(world) {
  const st = world.sys.stats;
  const hk = (st.hk ||= {});
  const fb = (st.fb ||= {});
  const day = world.time.day;
  // battles from each war's own battle log
  if (!hk.battle) {
    const bd = fin(fb.bd, -1);
    for (const w of world.wars) {
      if (!w || (!w.active && fin(w.endDay) < bd)) continue;
      const log = w.geo?.log;
      if (!Array.isArray(log)) continue;
      for (const e of log) {
        if (!e || !(e.day > bd && e.day <= day)) continue;
        const named = typeof e.name === 'string' && !/^an?\s/i.test(e.name);
        dispatch(world, 'battle', {
          day: e.day, x: fin(e.x), y: fin(e.y), warId: w.id, kind: 'field',
          attackerId: w.attackers[0] ?? null, defenderId: w.defenders[0] ?? null,
          winnerCivId: e.winner ?? -1, loserCivId: e.loser ?? -1, dead: { a: 0, d: fin(e.dead) },
          engaged: 0, name: named ? e.name : null, great: fin(e.dead) >= 2500,
        });
      }
    }
  }
  fb.bd = day;
  // quakes, eruptions and falling stars from the disasters' recent list
  const recent = world.sys.disasters?.recent;
  if (Array.isArray(recent)) {
    const rd = fin(fb.rd, -1);
    for (const r of recent) {
      if (!r || !(r.day > rd && r.day <= day)) continue;
      if (r.kind === 'quake' && !hk.quake) dispatch(world, 'quake', { x: r.x, y: r.y, mag: fin(r.M), deaths: fin(r.deaths), towns: [], undersea: isWaterAt(world, r.x, r.y) });
      else if (r.kind === 'eruption' && !hk.eruption) {
        const v = world.volcanoes.find((o) => o.name === r.name) || world.volcanoes.find((o) => o.x === r.x && o.y === r.y) || null;
        dispatch(world, 'eruption', { volcanoId: v ? v.id : null, x: r.x, y: r.y, vei: fin(r.vei), deaths: fin(r.deaths), towns: [] });
      } else if (r.kind === 'meteor' && !hk.impact) dispatch(world, 'impact', { x: r.x, y: r.y, r: fin(r.R), deaths: fin(r.deaths), ocean: isWaterAt(world, r.x, r.y), towns: [] });
    }
  }
  fb.rd = day;
  // ended plagues and fires, newly founded faiths
  const pd = fin(fb.pd, -1);
  if (!hk.plagueEnded) for (const p of world.plagues) if (p && !p.active && p.endDay > pd && p.endDay <= day) dispatch(world, 'plagueEnded', p);
  fb.pd = day;
  const fd = fin(fb.fd, -1);
  if (!hk.fireEnded) for (const f of world.fires) if (f && !f.active && f.endDay > fd && f.endDay <= day) dispatch(world, 'fireEnded', f);
  fb.fd = day;
  const rf = fin(fb.rf, -1);
  if (!hk.religionFounded) for (const r of world.religions) if (r && r.foundedDay > rf && r.foundedDay <= day) dispatch(world, 'religionFounded', r);
  fb.rf = day;
}

// ---------------------------------------------------------------------------
// The turn of each century: one deterministic sentence from the century's own numbers

const ORDINALS = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth'];
const ordinal = (n) => ORDINALS[n] || `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;
const NUMW = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const numw = (n) => NUMW[n] ?? fmtInt(n);
function fmtInt(n) { return String(Math.round(fin(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function rough(n) {
  const v = Math.round(fin(n));
  if (v < 1000) return fmtInt(v);
  const p = Math.pow(10, Math.floor(Math.log10(v)) - 1);
  return fmtInt(Math.round(v / p) * p);
}
const cap1 = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);

function centuryEntry(world, y) {
  const years = world.history.years;
  let wars = 0, dead = 0, pdead = 0, risen = 0, fell = 0;
  let prev = null;
  for (const r of years) {
    if (r.y <= y - 100) { prev = r; continue; }
    if (r.y > y) break;
    wars += fin(r.newWars); dead += fin(r.casualties); pdead += fin(r.pdeaths); risen += fin(r.newCivs); fell += fin(r.fell);
  }
  const civs = liveCivs(world);
  if (!civs.length) return;
  const towns = liveSettlements(world);
  let pop = 0, big = null;
  for (const s of towns) { pop += fin(s.population); if (!big || s.population > big.population) big = s; }
  const top = civs.slice().sort((a, b) => fin(b.population) - fin(a.population) || a.id - b.id)[0];
  const grow = prev && prev.pop > 0 ? pop / prev.pop : null;
  const growWord = grow == null ? '' : grow >= 3.6 ? `, many times more than a hundred years before` : grow >= 2.7 ? `, three times as many as a hundred years before` : grow >= 1.85 ? `, twice as many as a hundred years before` : grow >= 1.3 ? `, a third more than a hundred years before` : grow >= 1.08 ? `, more than a hundred years before` : grow <= 0.55 ? `, half as many as a hundred years before` : grow <= 0.9 ? `, fewer than a hundred years before` : '';
  let worst = null;
  for (const e of eventStore(world)) if (e.d > (y - 100) * DAYS_PER_YEAR && e.dead > 0 && (!worst || e.dead > worst.dead)) worst = e;
  const nth = ordinal(y / 100);
  const head = [
    () => `The ${nth} century closed with ${numw(civs.length)} nation${civs.length === 1 ? '' : 's'} under heaven and ${rough(pop)} souls${growWord}`,
    () => `So ended the ${nth} century: ${rough(pop)} people in ${numw(civs.length)} realm${civs.length === 1 ? '' : 's'}${growWord}`,
    () => `When the ${nth} century turned, ${rough(pop)} people lived in ${numw(civs.length)} nation${civs.length === 1 ? '' : 's'}${growWord}`,
  ][(y / 100) % 3]();
  const lead = `${theCiv(top)} ${civs.length > 1 ? 'was the greatest of them' : 'alone remained'}${big ? `, ${big.name} the greatest city` : ''}`;
  const parts = [];
  if (wars > 0) parts.push(`${rough(dead)} fell in ${numw(wars)} war${wars === 1 ? '' : 's'}`);
  if (pdead >= 100) parts.push(`plague took ${rough(pdead)}${parts.length ? ' more' : ''}`);
  let tail = parts.length ? ` In those hundred years ${parts.join(' and ')}.` : ' It had been a quiet hundred years.';
  if (risen > 0 || fell > 0) {
    const a = risen ? `${numw(risen)} new ${risen === 1 ? 'people' : 'peoples'} arose` : '';
    const b = fell ? `${numw(fell)} ${fell === 1 ? "realm" : "realms"} passed away` : '';
    tail += ` ${cap1([a, b].filter(Boolean).join(' and '))}.`;
  }
  const fury = worst && worst.n && worst.dead >= 500 ? ` Men remembered ${mid(worst.n)} longest of all.` : '';
  chronicle(world, {
    cat: 'civ', imp: 3, key: 'annals.century', tags: ['century'],
    text: `${cap1(head)}; ${lead}.${tail}${fury}`,
    civId: top.id, ref: { k: 'civ', id: top.id },
  });
}

// ---------------------------------------------------------------------------
// The system

export const system = {
  id: 'stats',
  order: 100,
  init(world) {
    ensureState(world);
    initLedger(world);
    unpinRuins(world);
    seedRuins(world);
    // a genesis record and snapshot, so charts and the atlas start at the dawn of history
    if (!world.history.years.length) recordYear(world);
    if (!world.history.atlas.length) recordAtlas(world);
    if (world.stats.day == null) {
      const grid = world.stats.grid;
      world.stats = summarize(world);
      world.stats.grid = grid || null;
    }
  },
  update(world) {
    const day = world.time.day;
    sampleLedger(world);
    // the year's work is staggered over its first days, off New Year's crowded day (climate,
    // ecology and the month's civ passes): the record on day 0, the records scan on day 2, the
    // atlas snapshot on day 4
    const doy = day % DAYS_PER_YEAR, y = yearOf(world);
    if (isYearStart(world)) {
      recordYear(world);
      if (y >= 100 && y % 100 === 0) centuryEntry(world, y);
    } else if (isMonthStart(world)) {
      const grid = world.stats?.grid || null;
      world.stats = summarize(world);
      world.stats.grid = grid;
    }
    if (doy === 2) scanRecords(world, ((y % 4) + 4) % 4);
    if (doy === 4 && y % ATLAS_EVERY === 0) recordAtlas(world);
    if (day % 30 === 15) fallbacks(world);
    flushRecordNews(world);
  },
  /** Headless report (tools/headless.mjs): ledger, sites, catalogue and records, with budget checks. */
  report(world) {
    const L = ledgerStats(world);
    const S = siteStats(world);
    const C = catalogueStats(world);
    const recs = getRecords(world);
    const held = recs.filter((r) => r.top.length).length;
    const breaks = recs.reduce((a, r) => a + r.br.length, 0);
    const news = world.chronicle.entries.filter((e) => e.key === 'record.broken').length;
    const centuries = world.chronicle.entries.filter((e) => e.key === 'annals.century').length;
    let own = 0, ownMax = 0;
    for (const s of world.settlements) { const n = Array.isArray(s?.own) ? s.own.length : 0; own += n; if (n > ownMax) ownMax = n; }
    const years = Math.max(1, yearOf(world));
    const kb = (b) => (b / 1024).toFixed(0) + ' KB';
    const hist = world.history || {};
    const sitesBytes = JSON.stringify(world.sites || []).length;
    const recBytes = JSON.stringify(world.sys.stats?.records || {}).length;
    const ownBytes = own * 18;
    const total = L.bytes + sitesBytes + C.bytes + recBytes + ownBytes;
    const top = (key) => { const r = recs.find((q) => q.key === key); const t = r?.top[0]; return t ? `${t.l} (${fmtInt(t.s ?? t.v)})` : '—'; };
    const fmtKinds = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none';
    return {
      title: 'Ledgers, records and sites (WP6)',
      lines: [
        `series: ${fmtKinds(L.kinds)} (${L.series} in all, ${kb(L.bytes)}, longest ${L.maxSamples} samples)`,
        `owner chains: ${fmtInt(own)} entries over ${world.settlements.length} settlements (longest ${ownMax})`,
        `sites: ${S.n} (${S.pinned} pinned) — ${fmtKinds(S.byKind)}, ${kb(sitesBytes)}`,
        `catalogue: ${C.n} events — ${fmtKinds(C.byType)}, ${kb(C.bytes)}`,
        `records: ${held}/${recs.length} held, ${breaks} breaks, ${news} announced (${(news / years * 100).toFixed(1)} per century), ${centuries} century entries, ${kb(recBytes)}`,
        `largest city ${top('city.peak')} · greatest empire ${top('civ.peakLand')} · bloodiest battle ${top('battle.dead')} · deadliest war ${top('war.dead')}`,
        `WP6 state ≈ ${kb(total)} at Y${yearOf(world)} (fallbacks active: ${WATCHED_HOOKS.filter((h) => !world.sys.stats?.hk?.[h]).join(', ') || 'none'})`,
      ],
      checks: [
        { ok: L.bad === 0, label: 'every series is whole and finite' },
        { ok: L.maxSamples <= LEDGER_K + 1, label: `series stay within ${LEDGER_K} samples per channel` },
        { ok: ownMax <= OWN_CAP, label: `owner chains within ${OWN_CAP}` },
        { ok: S.n - S.pinned <= MAX_SITES, label: `unpinned sites within ${MAX_SITES}` },
        { ok: C.n <= MAX_EVENTS, label: `catalogue within ${MAX_EVENTS}` },
        { ok: total <= 2.0e6 * Math.max(1, years / 1000), label: 'WP6 state within +2 MB per 1,000 years' },
        { ok: news / years <= 0.05, label: 'record-breaking news at most 5 per century' },
      ],
    };
  },
};

/** Tier name helper shared with UI code that reads snapshots. */
export const tierName = (t) => TIERS[Math.max(0, Math.min(TIERS.length - 1, t | 0))].name;
