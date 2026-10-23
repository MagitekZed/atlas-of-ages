// Trade (order 60): routes, roads, caravans and ships.
//
// Monthly, settlements with free route slots (cap by tier, × params.tradePropensity) look for
// partners within their civ's trade range — their own towns, or towns of contacted peoples at
// peace whose opinion of them is above −25 — preferring big, complementary markets (different
// resources, biomes, coast vs inland). Land routes follow findPath over the same landmass; sea
// routes need coasts, harbours and navigation (coastal craft ≤ 2.2× range, open-sea ≥ 5×).
// Every month a route's value (size, complementarity, tech, treaties, faith, hazards; each
// route re-appraised every other month) flows into both ends' s.tradeIncome and into the
// civs' relation.trade, which diplomacy turns into goodwill and the civ module counts as
// contact for tech diffusion. Traffic wears tracks into roads and highways along land routes
// (bumping versions.roads). One caravan or ship plies each route (ships sail daily, caravans
// step every other day), carrying goods for the renderer and plagues for disease.js. Routes
// break on war, embargo, destruction or blocked paths; the richest long routes earn names
// ("the Amber Road"). A route's value is also bent by the ext 'routeValue' providers (bandits on
// the road, ages of plenty) and paid out to each end × its settlement 'trade' effects.
//
// Hooks emitted: routeCreated(route), routeBroken(route, cause). Chronicle keys 'trade.first',
// 'trade.famous', 'trade.broken', 'divine.open_route' (ref: the route).
// Exports: system, routesOf(world, sid), breakRoute(world, routeOrId, cause), routeValueOf(world,
//          route), routePlan(world, a, b, opts), openRoute(world, a, b, opts)

import { chronicle } from '../../core/chronicle.js';
import { on } from '../../core/hooks.js';
import {
  liveSettlements, liveCivs, settlementsNear, addIndexed, addEntity, removeEntity, areAtWar, hasContact,
} from '../../core/entities.js';
import { ensureField, bumpVersion } from '../../core/world.js';
import { mulOf, hasProviders } from '../../core/ext.js';
import { settlementMods } from '../../core/effects.js';
import { DAYS_PER_YEAR, DAYS_PER_MONTH, RESOURCES, BIOME, WATER } from '../../core/constants.js';
import { dist, SQRT2, clamp01 } from '../../core/util.js';
import { findPath, sharesSea, sharesSeaPeek, costGrid, maintainPaths } from './pathfinding.js';
import { expose } from './disease.js';
import { civHasTenet } from './religion.js';
import {
  modsOf, civById, civName, peopleOf, pairKey, hasTreaty, routeAdjacency, activeRouteList, touchRoutes, pickOne, rateOk,
  eraOf, finite, capFirst, fmtCount, civsAtWar, emitHook, peekMods,
} from './common.js';
// the live-route index, for packages that reach trade by guarded import (bands)
export { activeRouteList };

const ROUTE_CAP = [0, 1, 2, 3, 4, 6, 8];
const MONTH_DAY = 10;
const MAX_SEARCHES = 10;            // new-route path searches per month
const MAX_CARRIERS = 240;
const CARAVAN_SPEED = 1.6;          // cost units per day
const SHIP_SPEED = 3.2;
const ROAD_T1 = 8, ROAD_T2 = 70, ROAD_T3 = 450;

// ---------------------------------------------------------------------------
// State

function state(world) {
  const st = (world.sys.trade ||= {});
  st.failed ||= {};
  st.firstTrade ||= {};
  st.names ||= {};
  if (st.lastFamousDay == null) st.lastFamousDay = -1e9;
  st.created ||= 0;
  st.broken ||= 0;
  return st;
}

export function routesOf(world, sid) {
  return routeAdjacency(world).get(sid) || [];
}

const harborOk = (s) => Boolean(s && s.coastal && (s.harbor || (s.buildings && s.buildings.harbor) || (s.tier || 0) >= 3));

// ---------------------------------------------------------------------------
// Goods and complementarity

const BIOME_GOODS = {
  [BIOME.TUNDRA]: ['furs', 'ivory', 'whale oil'], [BIOME.TAIGA]: ['furs', 'timber', 'amber'],
  [BIOME.STEPPE]: ['horses', 'wool', 'hides'], [BIOME.SHRUBLAND]: ['olives', 'honey', 'goats'],
  [BIOME.TEMPERATE_FOREST]: ['timber', 'grain', 'wine'], [BIOME.TEMPERATE_RAINFOREST]: ['cedar', 'timber', 'resin'],
  [BIOME.HOT_DESERT]: ['dates', 'incense', 'salt'], [BIOME.COLD_DESERT]: ['salt', 'wool', 'jade'],
  [BIOME.SAVANNA]: ['ivory', 'hides', 'cattle'], [BIOME.TROPICAL_FOREST]: ['spices', 'dyes', 'hardwood'],
  [BIOME.RAINFOREST]: ['spices', 'cacao', 'feathers'], [BIOME.WETLAND]: ['reeds', 'eels', 'rice'],
  [BIOME.ALPINE]: ['obsidian', 'wool', 'silver'], [BIOME.ICE]: ['furs', 'ivory'],
};

/**
 * Resource bitmask and goods words around a settlement (cached for the day: deposits run out
 * and biomes shift, so a value kept from earlier in the year would differ in a reloaded world).
 */
function goodsOf(world, s) {
  const c = (world.cache.tradeGoods ||= {});
  const day = world.time.day;
  const hit = c[s.id];
  if (hit && hit.day === day) return hit;
  const { W, H, f } = world;
  let mask = 0, lux = 0;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const x = s.x + dx, y = s.y + dy;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const i = y * W + x;
    const r = f.resource[i];
    if (r > 0 && r < RESOURCES.length && f.resourceAmt[i] > 0.05) { mask |= 1 << r; lux += RESOURCES[r].value; }
  }
  const words = [];
  for (let r = 1; r < RESOURCES.length; r++) if (mask & (1 << r)) words.push(RESOURCES[r].name.toLowerCase());
  const bw = BIOME_GOODS[f.biome[s.i]] || ['grain'];
  if (s.coastal) words.push('fish');
  for (const w of bw) if (words.length < 4 && !words.includes(w)) words.push(w);
  return (c[s.id] = { day, mask, lux, words, biome: f.biome[s.i] });
}

function popcount(v) { let n = 0; while (v) { n += v & 1; v >>>= 1; } return n; }

function complementarity(world, a, b) {
  const ga = goodsOf(world, a), gb = goodsOf(world, b);
  const diff = popcount(ga.mask ^ gb.mask);
  let c = 1 + 0.22 * Math.min(4, diff);
  if (ga.biome !== gb.biome) c += 0.25;
  if (Boolean(a.coastal) !== Boolean(b.coastal)) c += 0.15;
  c += Math.min(0.5, (ga.lux + gb.lux) * 0.03);
  return c;
}

// ---------------------------------------------------------------------------
// Route lifecycle

function createRoute(world, st, a, b, kind, path, comp, opts = {}) {
  const r = {
    id: -1, aId: a.id, bId: b.id, kind, path: path.slice(), value: 0, active: true,
    establishedDay: world.time.day, civA: a.civId, civB: b.civId,
    len: path.length, comp, name: null, traffic: 0, peakValue: 0,
    carrierId: null, lastCarrierDay: -9999, endDay: null, cause: null,
    gridV: world.sys.path ? world.sys.path.gridV : 0,
  };
  if (opts.divine) r.divine = true;
  addIndexed(world, 'tradeRoutes', r);
  touchRoutes(world);
  st.created++;
  if (a.civId !== b.civId && !opts.quiet) firstTradeNote(world, st, a, b, kind, r);
  emitHook(world, 'routeCreated', r);
  return r;
}

function firstTradeNote(world, st, a, b, kind, r) {
  const key = pairKey(a.civId, b.civId);
  if (st.firstTrade[key] != null) return;
  st.firstTrade[key] = world.time.day;
  const ca = civById(world, a.civId), cb = civById(world, b.civId);
  if (!ca || !cb) return;
  const ga = goodsOf(world, a).words, gb = goodsOf(world, b).words;
  const goodA = ga[0] || 'grain', goodB = gb.find((w) => w !== goodA) || 'pottery';
  const text = kind === 'sea'
    ? pickOne(world, [
      `Ships from ${a.name} put in at the harbour of ${b.name}, and ${peopleOf(cb)} first tasted the ${goodA} of ${civName(ca)}.`,
      `Sailors of ${civName(ca)} opened a sea road to ${b.name}, trading ${goodA} for ${goodB}.`,
    ])
    : pickOne(world, [
      `Caravans from ${a.name} began to reach ${b.name}, opening the first trade between ${peopleOf(ca)} and ${peopleOf(cb)}.`,
      `Merchants of ${civName(ca)} and ${civName(cb)} met at ${b.name} to trade ${goodA} for ${goodB}.`,
      `A trail of pack animals linked ${a.name} to ${b.name}, and ${goodA} flowed one way while ${goodB} flowed the other.`,
    ]);
  chronicle(world, { cat: 'trade', imp: 2, text, x: b.x, y: b.y, civId: a.civId, sid: b.id, icon: kind === 'sea' ? 'ship' : 'trade', key: 'trade.first', ref: { k: 'route', id: r.id } });
}

/**
 * Published: mark a route broken (war, embargo, ruin, blocked, raided …) and recall its carrier.
 * routeOrId: the route or its id. Emits routeBroken(route, cause).
 */
export function breakRoute(world, routeOrId, cause = 'abandoned') {
  const r = typeof routeOrId === 'number' ? world.tradeRoutes[routeOrId] : routeOrId;
  if (!r || !r.active) return;
  r.active = false;
  r.endDay = world.time.day;
  r.cause = cause;
  if (r.carrierId != null) removeEntity(world, 'caravans', r.carrierId);
  r.carrierId = null;
  r.path = [];
  // a broken route is never reopened (a new one is made), and it is saved for ever: keep its numbers short
  for (const k of ['value', 'peakValue', 'traffic']) if (typeof r[k] === 'number') r[k] = Math.round(r[k] * 10) / 10;
  if (typeof r.comp === 'number') r.comp = Math.round(r.comp * 100) / 100;
  delete r.carrierId; delete r.lastCarrierDay; delete r.gridV;   // bookkeeping of a working route only
  touchRoutes(world);
  const st = state(world);
  st.broken++;
  emitHook(world, 'routeBroken', r, cause);
  if (r.name && rateOk(world, `rbreak${r.id}`, 10 * DAYS_PER_YEAR)) {
    const a = world.settlements[r.aId], b = world.settlements[r.bId];
    const why = cause === 'war' ? 'as war closed the way' : cause === 'embargo' ? 'when its masters quarrelled' : cause === 'ruin' ? 'when one of its markets was lost'
      : /raid|bandit|pirat/i.test(String(cause)) ? 'as raiders made every journey a gamble with death' : 'as the way became impassable';
    chronicle(world, {
      cat: 'trade', imp: 2, x: a ? a.x : null, y: a ? a.y : null, civId: r.civA, sid: r.aId, icon: 'trade', key: 'trade.broken', ref: { k: 'route', id: r.id }, tags: [String(cause)],
      text: pickOne(world, [
        `${capFirst(r.name)} fell silent ${why}.`,
        `No more ${r.kind === 'sea' ? 'ships sailed' : 'caravans travelled'} ${r.name} between ${a ? a.name : 'its markets'} and ${b ? b.name : 'the far coast'}, ${why.replace(/^as |^when /, 'for ')}.`,
      ]),
    });
  }
}

/** Interior tiles of a path still passable for its kind? */
function pathValid(world, r) {
  const water = world.f.water;
  const p = r.path;
  if (!p || p.length < 2) return false;
  for (let k = 1; k < p.length - 1; k++) {
    const land = water[p[k]] === WATER.LAND;
    if (r.kind === 'land' ? !land : land) return false;
  }
  return water[p[0]] === WATER.LAND && water[p[p.length - 1]] === WATER.LAND;
}

function routeValue(world, r, a, b, ca, cb, peek = false) {
  const ma = peek ? peekMods(ca) : modsOf(world, ca), mb = peek ? peekMods(cb) : modsOf(world, cb);
  const prop = world.params.tradePropensity ?? 1;
  const sizeF = Math.sqrt(Math.max(0, a.population) * Math.max(0, b.population)) / 1000;
  const lenF = 0.7 + 0.3 * Math.min(1, r.len / 25);
  let v = 4 * sizeF * (r.comp || 1) * ((ma.trade + mb.trade) / 2) * prop * lenF * (r.kind === 'sea' ? 1.2 : 1);
  if (a.civId !== b.civId) {
    v *= 1.2;
    if (hasTreaty(world, a.civId, b.civId, 'trade')) v *= 1.3;
  }
  if (civHasTenet(world, ca, 'mercantile') || civHasTenet(world, cb, 'mercantile')) v *= 1.15;
  if (a.siege || b.siege) v *= 0.3;
  if (a.disease || b.disease) v *= 0.8;
  if ((ca && warBusy(world, ca.id)) || (cb && warBusy(world, cb.id))) v *= 0.75;
  // banditry and ruin along the way
  const p = r.path, dev = world.f.devastation;
  if (p && p.length) {
    let d = 0, n = 0;
    const step = Math.max(1, Math.floor(p.length / 8));
    for (let k = 0; k < p.length; k += step) { d += dev[p[k]]; n++; }
    v *= 1 - 0.7 * clamp01(n ? d / n : 0);
  }
  // what other packages know of the road: robbers on it, an age of plenty …
  if (hasProviders('routeValue')) v *= mulOf('routeValue', world, r);
  return finite(v) && v > 0 ? Math.min(v, 1e7) : 0;
}

/** Published: the value (per month) a route would yield now. Pure (reads, never refreshes). */
export function routeValueOf(world, route) {
  if (!route) return 0;
  const a = world.settlements[route.aId], b = world.settlements[route.bId];
  if (!a || !a.alive || !b || !b.alive) return 0;
  return routeValue(world, route, a, b, civById(world, a.civId), civById(world, b.civId), true);
}

const warBusy = (world, civId) => civsAtWar(world).has(civId);

// ---------------------------------------------------------------------------
// Monthly

function monthly(world, st) {
  const day = world.time.day;
  const month = Math.floor(day / DAYS_PER_MONTH);
  const towns = liveSettlements(world);
  for (const s of towns) s.tradeIncome = 0;
  const pairTrade = new Map();
  const traffic = ensureField(world, 'tradeTraffic', Float32Array, world.N);
  const gridV = world.sys.path ? world.sys.path.gridV : 0;
  let searches = 0, roadsChanged = false;
  const values = [];
  const prop = world.params.tradePropensity ?? 1;
  for (const r of activeRouteList(world).slice()) {    // breakRoute changes the shared list
    if (!r.active) continue;
    const a = world.settlements[r.aId], b = world.settlements[r.bId];
    if (!a || !a.alive || !b || !b.alive) { breakRoute(world, r, 'ruin'); continue; }
    r.civA = a.civId; r.civB = b.civId;
    const ca = civById(world, a.civId), cb = civById(world, b.civId);
    if (a.civId !== b.civId) {
      if (areAtWar(world, a.civId, b.civId)) { breakRoute(world, r, 'war'); continue; }
      const oa = ca?.relations[b.civId]?.opinion ?? 0, ob = cb?.relations[a.civId]?.opinion ?? 0;
      if (Math.min(oa, ob) < -55) { breakRoute(world, r, 'embargo'); continue; }
    }
    // half the routes are re-appraised each month (alternating): path, value, traffic, roads
    if (((r.id + month) & 1) === 0 || !(r.value > 0)) {
      if (r.gridV !== gridV) {
        if (!pathValid(world, r)) {
          const np = searches < MAX_SEARCHES ? findPath(world, a.i, b.i, { mode: r.kind, civId: a.civId, maxNodes: 12000 }) : null;
          searches++;
          if (!np) { breakRoute(world, r, 'blocked'); continue; }
          r.path = np.slice(); r.len = np.length;
          if (r.carrierId != null) { removeEntity(world, 'caravans', r.carrierId); r.carrierId = null; }
        }
        r.gridV = gridV;
      }
      // merchants give up on dead-end routes now and then; markets re-form elsewhere
      if (world.rng.chance(prop < 0.25 ? 0.1 : 0.0004)) { breakRoute(world, r, 'abandoned'); continue; }
      const nv = routeValue(world, r, a, b, ca, cb);
      r.value = nv;
      if (nv > r.peakValue) r.peakValue = nv;
      r.traffic += 2 * nv;
      if (r.kind === 'land' && r.path.length) roadsChanged = buildRoads(world, r, ca, cb, nv, traffic, 2) || roadsChanged;
    }
    const v = r.value;
    // each market keeps its half × its own trade effects (a blessed fair, a cursed harbour)
    a.tradeIncome += (v / 2) * settlementMods(world, a).trade;
    b.tradeIncome += (v / 2) * settlementMods(world, b).trade;
    values.push(v);
    if (a.civId !== b.civId) { const k = pairKey(a.civId, b.civId); pairTrade.set(k, (pairTrade.get(k) || 0) + v); }
  }
  if (roadsChanged) bumpVersion(world, 'roads');
  // relation.trade (monthly value between two peoples)
  for (const civ of liveCivs(world)) {
    for (const k in civ.relations) {
      const rr = civ.relations[k];
      rr.trade = pairTrade.get(pairKey(civ.id, +k)) || 0;
    }
  }
  establish(world, st, towns, searches);
  famous(world, st, values);
}

function buildRoads(world, r, ca, cb, v, traffic, months = 1) {
  const road = world.f.road;
  const era = Math.max(eraOf(ca), eraOf(cb));
  const inc = (Math.min(25, v) * 0.06 + 0.15) * months;
  let changed = false;
  const p = r.path;
  for (let k = 0; k < p.length; k++) {
    const i = p[k];
    const t = (traffic[i] += inc);
    const lvl = road[i];
    if (lvl >= 3) continue;
    const target = t > ROAD_T3 && era >= 6 ? 3 : t > ROAD_T2 && era >= 2 ? 2 : t > ROAD_T1 ? 1 : 0;
    if (target > lvl) { road[i] = target; changed = true; }
  }
  return changed;
}

function establish(world, st, towns, searchesUsed) {
  const prop = world.params.tradePropensity ?? 1;
  if (!(prop > 0)) return;
  const rng = world.rng;
  const day = world.time.day;
  const month = Math.floor(day / DAYS_PER_MONTH);
  // a private copy of the adjacency: routes founded this month count against the caps at once
  const adj = new Map();
  for (const [k, v] of routeAdjacency(world)) adj.set(k, v.slice());
  let searches = searchesUsed;
  for (const s of towns) {
    if (searches >= MAX_SEARCHES) break;
    if ((s.id + month) % 3 !== 0) continue;
    const tier = s.tier || 0;
    const cap = Math.round(ROUTE_CAP[Math.min(6, tier)] * (0.6 + 0.4 * Math.min(2, prop)));
    if (cap <= 0) continue;
    const mine = adj.get(s.id) || [];
    if (mine.length >= cap) continue;
    const civ = civById(world, s.civId);
    if (!civ) continue;
    const tr = civ.traits || {};
    if (!rng.chance(0.35 * prop * (0.5 + (tr.commerce ?? 0.5)) * (1 - 0.6 * (tr.isolation ?? 0)))) continue;
    const m = modsOf(world, civ);
    const range = m.tradeRange * (0.8 + 0.2 * Math.min(2, prop));
    const seaRange = m.navigation >= 1 && harborOk(s) ? Math.min(90, range * (m.navigation >= 2 ? 5 : 2.2) + m.seaRange) : 0;
    const R = Math.max(range, seaRange);
    let best = null, bestScore = 0, bestLand = false, bestSea = false;
    for (const n of settlementsNear(world, s.x, s.y, R)) {
      if (n === s || (n.tier || 0) < 1) continue;
      const nCap = Math.round(ROUTE_CAP[Math.min(6, n.tier || 0)] * (0.6 + 0.4 * Math.min(2, prop)));
      const nRoutes = adj.get(n.id) || [];
      if (nRoutes.length >= nCap) continue;
      if (mine.some((r) => r.aId === n.id || r.bId === n.id)) continue;
      const same = n.civId === s.civId;
      let treatyF = 1;
      if (!same) {
        if (!hasContact(world, s.civId, n.civId) || areAtWar(world, s.civId, n.civId)) continue;
        const nc = civById(world, n.civId);
        if (!nc) continue;
        const o1 = civ.relations[n.civId]?.opinion ?? 0, o2 = nc.relations[s.civId]?.opinion ?? 0;
        if (o1 <= -25 || o2 <= -25) continue;
        if ((nc.traits?.isolation ?? 0) > 0.85) continue;
        treatyF = hasTreaty(world, s.civId, n.civId, 'trade') ? 1.4 : 1.15;
      }
      const d = dist(s.x, s.y, n.x, n.y);
      const landOk = d <= range && world.f.landmass[s.i] === world.f.landmass[n.i];
      const seaMaybe = seaRange > 0 && d <= seaRange && harborOk(n);
      if (!landOk && !seaMaybe) continue;
      const score = Math.sqrt(Math.max(1, n.population)) * complementarity(world, s, n) * treatyF / (1 + d / 8);
      if (score <= bestScore) continue;
      // the costlier checks only for a candidate that would win
      const fk = s.id < n.id ? `${s.id}:${n.id}` : `${n.id}:${s.id}`;
      if (st.failed[fk] != null && day - st.failed[fk] < 8 * DAYS_PER_YEAR) continue;
      const seaOk = seaMaybe && sharesSea(world, s.i, n.i);
      if (!landOk && !seaOk) continue;
      bestScore = score; best = n; bestLand = landOk; bestSea = seaOk;
    }
    if (!best) continue;
    const d = dist(s.x, s.y, best.x, best.y);
    let kind = bestLand && (!bestSea || d <= range * 0.8) ? 'land' : 'sea';
    let path = findPath(world, s.i, best.i, { mode: kind, civId: s.civId, maxNodes: kind === 'land' ? Math.round(3000 + d * 250) : 14000 });
    searches++;
    if (!path && kind === 'land' && bestSea && searches < MAX_SEARCHES) {
      kind = 'sea';
      path = findPath(world, s.i, best.i, { mode: 'sea', civId: s.civId, maxNodes: 14000 });
      searches++;
    }
    const fk = s.id < best.id ? `${s.id}:${best.id}` : `${best.id}:${s.id}`;
    if (!path) { st.failed[fk] = day; continue; }
    // very winding land routes are not worth the walk
    if (kind === 'land' && path.length > d * 2.6 + 6) { st.failed[fk] = day; continue; }
    const r = createRoute(world, st, s, best, kind, path, complementarity(world, s, best));
    mine.push(r);
    if (!adj.has(s.id)) adj.set(s.id, mine);
    const nb = adj.get(best.id); if (nb) nb.push(r); else adj.set(best.id, [r]);
  }
}

const FAMOUS_GOODS = ['Amber', 'Silk', 'Incense', 'Jade', 'Ivory', 'Pearl', 'Wine', 'Cedar', 'Saffron', 'Indigo', 'Obsidian', 'Tea', 'Copper', 'Tin', 'Salt', 'Spice', 'Fur', 'Gold', 'Horse', 'Marble'];

function famous(world, st, values) {
  const day = world.time.day;
  if (values.length < 4 || day - st.lastFamousDay < 12 * DAYS_PER_YEAR) return;
  const sorted = values.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  let best = null;
  for (const r of activeRouteList(world)) {
    if (!r.active || r.name || r.len < 14) continue;
    if (day - r.establishedDay < 5 * DAYS_PER_YEAR) continue;
    if (r.value < Math.max(25, 2.5 * median)) continue;
    if (!best || r.value > best.value) best = r;
  }
  if (!best) return;
  const a = world.settlements[best.aId], b = world.settlements[best.bId];
  if (!a || !b) return;
  const rng = world.rng;
  const ga = goodsOf(world, a).words.concat(goodsOf(world, b).words);
  const resGood = ga.find((w) => ['salt', 'spices', 'furs', 'gold', 'gems', 'copper', 'tin', 'iron', 'horses', 'marble', 'amber', 'incense', 'jade', 'ivory', 'silver', 'wine', 'cedar'].includes(w));
  const map = { spices: 'Spice', furs: 'Fur', gems: 'Jewel', horses: 'Horse' };
  const good = resGood ? (map[resGood] || capFirst(resGood)) : rng.pick(FAMOUS_GOODS);
  let name = null;
  for (let k = 0; k < 6 && !name; k++) {
    const c = best.kind === 'sea'
      ? rng.pick([`the ${good} Passage`, `the ${good} Sea-lane`, `the ${a.name} Run`, `the ${good} Route`, `the Way of Sails`])
      : rng.pick([`the ${good} Road`, `the ${good} Way`, `the ${a.name} Road`, `the Road of ${good}`, `the King's Road`, `the ${good} Trail`]);
    if (!st.names[c]) name = c;
  }
  if (!name) name = `the ${a.name}–${b.name} ${best.kind === 'sea' ? 'Passage' : 'Road'}`;
  st.names[name] = 1;
  best.name = name;
  st.lastFamousDay = day;
  const ca = civById(world, a.civId), cb = civById(world, b.civId);
  const foreign = a.civId !== b.civId && ca && cb;
  chronicle(world, {
    cat: 'trade', imp: best.value > 6 * median ? 3 : 2, x: a.x, y: a.y, civId: a.civId, sid: a.id, icon: best.kind === 'sea' ? 'ship' : 'trade', key: 'trade.famous', ref: { k: 'route', id: best.id },
    text: pickOne(world, [
      `The ${best.kind === 'sea' ? 'sea road' : 'road'} between ${a.name} and ${b.name} grew so rich that men called it ${name}.`,
      `${capFirst(good.toLowerCase())} and gold flowed so freely between ${a.name} and ${b.name} that the way became famous as ${name}.`,
      foreign
        ? `${capFirst(name)} carried the wealth of ${civName(ca)} to ${civName(cb)} and back, ${fmtCount(Math.round(best.len * 20))} kilometres of ${best.kind === 'sea' ? 'sea' : 'dust and toll-houses'}.`
        : `${capFirst(name)}, ${fmtCount(Math.round(best.len * 20))} kilometres from ${a.name} to ${b.name}, became the busiest ${best.kind === 'sea' ? 'sea-lane' : 'highway'} of ${civName(ca)}.`,
    ]),
  });
}

// ---------------------------------------------------------------------------
// Routes opened by a god's hand (geo/acts.js open_route)

/**
 * How a route between towns a and b would run: { ok, kind, path, reason? }. Land when they
 * share a landmass and the way is not absurdly winding, else by sea between coasts that share
 * a body of water and a people that can sail. opts.peek: for previews — never refreshes saved
 * state (the pathfinder's snapshot is read as it stands). Pure in peek mode.
 */
export function routePlan(world, a, b, opts = {}) {
  const peek = Boolean(opts.peek);
  if (!a || !a.alive || !b || !b.alive) return { ok: false, reason: 'Choose two living towns.' };
  if (a.id === b.id) return { ok: false, reason: 'A town cannot trade with itself.' };
  for (const r of routesOf(world, a.id)) if (r.active && (r.aId === b.id || r.bId === b.id)) return { ok: false, reason: `${a.name} and ${b.name} already trade${r.name ? ` along ${r.name}` : ''}.` };
  if (a.civId !== b.civId) {
    if (areAtWar(world, a.civId, b.civId)) return { ok: false, reason: 'Their masters are at war; no caravan would pass.' };
    const ca = civById(world, a.civId), cb = civById(world, b.civId);
    const oa = ca?.relations[b.civId]?.opinion ?? 0, ob = cb?.relations[a.civId]?.opinion ?? 0;
    if (Math.min(oa, ob) < -55) return { ok: false, reason: 'Their masters hate each other too much to trade (try Harmony first).' };
  }
  const f = world.f;
  const d = dist(a.x, a.y, b.x, b.y);
  const mods = (c) => (peek ? peekMods(c) : modsOf(world, c));
  const nav = Math.max(mods(civById(world, a.civId)).navigation, mods(civById(world, b.civId)).navigation);
  if (f.landmass[a.i] === f.landmass[b.i]) {
    const p = findPath(world, a.i, b.i, { mode: 'land', navigation: nav, maxNodes: Math.round(4000 + d * 300), peek });
    if (p && p.length <= d * 3.2 + 8) return { ok: true, kind: 'land', path: p };
  }
  if (a.coastal && b.coastal) {
    const shares = peek ? sharesSeaPeek(world, a.i, b.i) : sharesSea(world, a.i, b.i);
    if (shares) {
      if (nav < 1) return { ok: false, reason: 'The sea divides them, and neither people has learned to sail it.' };
      const p = findPath(world, a.i, b.i, { mode: 'sea', navigation: nav, maxNodes: 24000, peek });
      if (p) return { ok: true, kind: 'sea', path: p };
      if (nav < 2) return { ok: false, reason: 'Their ships hug the coasts; the open sea between them is beyond them yet.' };
    }
  }
  if (f.landmass[a.i] !== f.landmass[b.i]) return { ok: false, reason: a.coastal && b.coastal ? 'No sea road joins their coasts.' : 'The sea lies between them, and one of them has no harbour.' };
  return { ok: false, reason: 'No road can be found between them.' };
}

/**
 * Published: open a trade route between towns a and b now (a divine act): the route, its first
 * track worn into the land, goodwill between their peoples. Returns { ok, route?, message }.
 */
export function openRoute(world, a, b, opts = {}) {
  const st = state(world);
  const plan = routePlan(world, a, b);
  if (!plan.ok) return { ok: false, message: plan.reason };
  const r = createRoute(world, st, a, b, plan.kind, plan.path, complementarity(world, a, b), { divine: true, quiet: true });
  const ca = civById(world, a.civId), cb = civById(world, b.civId);
  r.value = routeValue(world, r, a, b, ca, cb);
  r.peakValue = r.value;
  if (plan.kind === 'land') {
    const traffic = ensureField(world, 'tradeTraffic', Float32Array, world.N);
    if (buildRoads(world, r, ca, cb, Math.max(10, r.value), traffic, 6)) bumpVersion(world, 'roads');
  }
  if (ca && cb && ca.id !== cb.id) {
    for (const [p, q] of [[ca, cb], [cb, ca]]) {
      const rr = p.relations[q.id];
      if (rr) rr.opinion = Math.max(-100, Math.min(100, (rr.opinion || 0) + 8));
    }
    st.firstTrade[pairKey(ca.id, cb.id)] ??= world.time.day;
  }
  const g = goodsOf(world, a).words, h = goodsOf(world, b).words;
  const goodA = g[0] || 'grain', goodB = h.find((w) => w !== goodA) || 'cloth';
  const km = fmtCount(Math.round(plan.path.length * 20));
  const text = plan.kind === 'sea'
    ? pickOne(world, [
      `A fair wind that never failed carried the first ships from ${a.name} to ${b.name}; ${goodA} went out and ${goodB} came home.`,
      `Sailors swore a pillar of light had shown them the way from ${a.name} to ${b.name}, and a sea road ${km} kilometres long was opened.`,
    ])
    : pickOne(world, [
      `A road appeared between ${a.name} and ${b.name} as if trodden by a thousand years of caravans; ${goodA} and ${goodB} began to flow along it.`,
      `Guided by dreams, merchants of ${a.name} found an easy way to ${b.name}, ${km} kilometres of good road where none had been.`,
    ]);
  chronicle(world, { cat: 'divine', imp: 2, text, x: b.x, y: b.y, civId: a.civId, sid: b.id, icon: plan.kind === 'sea' ? 'ship' : 'trade', key: 'divine.open_route', ref: { k: 'route', id: r.id }, ...(opts.cause != null ? { cause: opts.cause } : {}) });
  return { ok: true, route: r, message: `A ${plan.kind === 'sea' ? 'sea road' : 'trade road'} joins ${a.name} and ${b.name}.` };
}

// ---------------------------------------------------------------------------
// Caravans and ships (daily)

/**
 * Per-route travel profile (world.cache): cumulative cost along the path and tile coords, so
 * a carrier advances in O(1) per day. Rebuilt when the route's path array is replaced.
 */
function routeGeom(world, r, land) {
  const c = (world.cache.routeGeom ||= new Map());
  // keyed by the cost-grid generation too: a refreshed grid re-profiles every route at once,
  // exactly as a reload (empty cache) would
  const gv = world.sys.path?.gridV ?? 0;
  let g = c.get(r.id);
  if (g && g.path === r.path && g.gridV === gv) return g;
  const p = r.path, n = p.length, W = world.W;
  const cum = new Float64Array(n), xs = new Int16Array(n), ys = new Int16Array(n);
  const ship = r.kind === 'sea';
  for (let k = 0; k < n; k++) {
    const i = p[k];
    xs[k] = i % W; ys[k] = (i / W) | 0;
    if (k === 0) continue;
    let cost = ship ? 1 : (land[i] > 0 ? land[i] : 1);
    if (xs[k] !== xs[k - 1] && ys[k] !== ys[k - 1]) cost *= SQRT2;
    cum[k] = cum[k - 1] + cost;
  }
  g = { path: p, cum, xs, ys, total: cum[n - 1], gridV: gv };
  c.set(r.id, g);
  if (c.size > 4 * MAX_CARRIERS) c.delete(c.keys().next().value);
  return g;
}

/**
 * Per-carrier references (route, geometry) aligned with world.caravans, so the daily walk
 * touches as little as possible. Revalidated whenever the route set (epoch) or the carrier
 * list changes. world.cache only.
 */
function carrierRefs(world) {
  const c = world.cache;
  const epoch = c.routeEpoch || 0, n = world.caravans.length;
  let ref = c.carRefs;
  if (!ref || ref.epoch !== epoch || ref.n !== n) ref = c.carRefs = { epoch, n, list: new Array(n) };
  return ref;
}

function carriers(world) {
  const day = world.time.day;
  const { land } = costGrid(world);
  const cars = world.caravans;
  const refs = carrierRefs(world).list;
  // move existing carriers along their route profile (pos = cost units from the a-end)
  for (let k = cars.length - 1; k >= 0; k--) {
    const c = cars[k];
    let e = refs[k];
    if (!e || e.c !== c) {
      const r0 = world.tradeRoutes[c.routeId];
      if (!r0 || !r0.active || !r0.path || r0.path.length < 2 || r0.carrierId !== c.id) { cars.splice(k, 1); if (r0 && r0.carrierId === c.id) r0.carrierId = null; continue; }
      e = refs[k] = { c, r: r0, ship: c.kind === 'ship' };
    }
    // ships sail daily; caravans plod, moving every other day twice as far
    const ship = e.ship;
    if (!ship && ((day + c.id) & 1)) continue;
    if (c.wait > 0) { c.wait -= ship ? 1 : 2; continue; }
    const r = e.r;
    let g = e.g;
    if (!g || g.path !== r.path || g.gridV !== (world.sys.path?.gridV ?? 0)) g = e.g = routeGeom(world, r, land);
    if (c.path !== r.path) { c.path = r.path; c.pos = c.dir > 0 ? 0 : g.total; c.pathStep = c.dir > 0 ? 0 : r.path.length - 1; }
    const cum = g.cum, last = r.path.length - 1;
    let pos = (finite(c.pos) ? c.pos : 0) + c.dir * (ship ? SHIP_SPEED : 2 * CARAVAN_SPEED);
    let step = c.pathStep > last ? last : c.pathStep < 0 ? 0 : c.pathStep;
    let arrived = false;
    if (c.dir > 0) {
      if (pos >= g.total) { pos = g.total; step = last; arrived = true; }
      else while (step < last && cum[step + 1] <= pos) step++;
    } else {
      if (pos <= 0) { pos = 0; step = 0; arrived = true; }
      else { if (step >= last) step = last - 1; while (step > 0 && cum[step] > pos) step--; }
    }
    c.pos = pos;
    c.pathStep = step;
    if (step < last) {
      const seg = cum[step + 1] - cum[step];
      const t = seg > 0 ? (pos - cum[step]) / seg : 0;
      c.x = g.xs[step] + (g.xs[step + 1] - g.xs[step]) * t;
      c.y = g.ys[step] + (g.ys[step + 1] - g.ys[step]) * t;
    } else { c.x = g.xs[last]; c.y = g.ys[last]; }
    if (arrived) {
      const dest = world.settlements[c.dir > 0 ? r.bId : r.aId];
      if (c.plague != null && dest && dest.alive) expose(world, dest, c.plague, { kind: ship ? 'ship' : 'caravan', fromSid: c.dir > 0 ? r.aId : r.bId, routeId: r.id });
      c.dir = -c.dir;
      c.wait = 3 + ((c.id + day) % 5);
      c.value = r.value;
      c.civId = dest ? dest.civId : c.civId;
      c.plague = pickupPlague(world, dest);
    }
  }
  // dispatch carriers on routes that lack one
  if (day % 3 !== 0 || cars.length >= MAX_CARRIERS) return;
  let n = cars.length;
  const W = world.W;
  for (const r of activeRouteList(world)) {
    if (n >= MAX_CARRIERS) break;
    if (!r.active || r.carrierId != null || !r.path || r.path.length < 2) continue;
    if (day - r.lastCarrierDay < 20) continue;
    const a = world.settlements[r.aId];
    if (!a || !a.alive) continue;
    const i0 = r.path[0];
    const c = addEntity(world, 'caravans', {
      routeId: r.id, civId: a.civId, x: i0 % W, y: (i0 / W) | 0, path: r.path, pathStep: 0, pos: 0,
      kind: r.kind === 'sea' ? 'ship' : 'caravan', value: r.value, dir: 1, wait: 0,
      plague: pickupPlague(world, a),
    }, 'caravan');
    r.carrierId = c.id;
    r.lastCarrierDay = day;
    n++;
  }
}

function pickupPlague(world, s) {
  if (!s || !s.alive || !s.disease) return null;
  const sick = s.disease.I * s.population;
  if (sick < 3) return null;
  return world.rng.chance(Math.min(0.6, s.disease.I * 25)) ? s.disease.pid : null;
}

// ---------------------------------------------------------------------------
// Yearly: traffic fades, neglected roads crumble

function yearly(world, st) {
  const traffic = world.f.tradeTraffic;
  const road = world.f.road;
  if (!traffic) return;
  let changed = false;
  const rng = world.rng;
  for (let i = 0; i < world.N; i++) {
    const t = traffic[i];
    if (t > 0) traffic[i] = t < 0.05 ? 0 : t * 0.8;
    if (road[i] && traffic[i] < 0.5 && rng.chance(0.04)) { road[i]--; changed = true; }
  }
  if (changed) bumpVersion(world, 'roads');
  const day = world.time.day;
  for (const k of Object.keys(st.failed)) if (day - st.failed[k] > 8 * DAYS_PER_YEAR) delete st.failed[k];
  world.cache.tradeGoods = null;
}

// ---------------------------------------------------------------------------
// System

export const system = {
  id: 'trade',
  order: 60,
  init(world) {
    const st = state(world);
    ensureField(world, 'tradeTraffic', Float32Array, world.N);
    // carriers must point at live routes; routes must not point at missing carriers
    const ids = new Set(world.caravans.map((c) => c.id));
    for (const r of world.tradeRoutes) {
      if (r.carrierId != null && !ids.has(r.carrierId)) r.carrierId = null;
      if (!Array.isArray(r.path)) r.path = [];
      if (!finite(r.value)) r.value = 0;
    }
    world.caravans = world.caravans.filter((c) => {
      const r = world.tradeRoutes[c.routeId];
      if (!r || !r.active || r.carrierId !== c.id) return false;
      c.path = r.path;
      return true;
    });
    touchRoutes(world);
    void st;
  },
  update(world) {
    maintainPaths(world);
    const st = state(world);
    const day = world.time.day;
    if (day % DAYS_PER_MONTH === MONTH_DAY) monthly(world, st);
    if (day % DAYS_PER_YEAR === 130) yearly(world, st);
    if (world.tradeRoutes.length) carriers(world);
  },
};

// ---------------------------------------------------------------------------
// Hooks

on('settlementDestroyed', (world, s) => {
  if (!s) return;
  for (const r of routesOf(world, s.id).slice()) if (r.active) breakRoute(world, r, 'ruin');
});

on('settlementTransferred', (world, s, oldCivId, newCivId) => {
  if (!s) return;
  for (const r of routesOf(world, s.id).slice()) {
    if (!r.active) continue;
    const other = world.settlements[r.aId === s.id ? r.bId : r.aId];
    if (r.aId === s.id) r.civA = newCivId; else r.civB = newCivId;
    if (other && other.civId !== newCivId && areAtWar(world, other.civId, newCivId)) breakRoute(world, r, 'war');
  }
});

on('warStarted', (world, war) => {
  if (!war) return;
  const att = new Set(war.attackers), def = new Set(war.defenders);
  for (const r of activeRouteList(world).slice()) {
    if (!r.active) continue;
    const a = world.settlements[r.aId], b = world.settlements[r.bId];
    if (!a || !b) continue;
    if ((att.has(a.civId) && def.has(b.civId)) || (def.has(a.civId) && att.has(b.civId))) breakRoute(world, r, 'war');
  }
});
