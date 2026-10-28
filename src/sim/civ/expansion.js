// Expansion: where peoples live and spread.
//   placeGenesis   the first tribes at the most habitable sites, far apart, across landmasses
//   newPeople      a new civ with its first camp (genesis, emergence, the "tribe" tool)
//   findSite       best spot for settlers within reach (overland) or across the sea (BFS)
//   trySettlers    food/housing pressure sends settlers out (× expansionism × traits)
//   routeMigrants  famine and overcrowding refugees move to a better-fed town or found camps
//   emergence      yearly: new peoples arise in large, empty, habitable regions
// Ext call sites: people (race, temperament and tongue of a new people: at genesis by tribe
// number before its site is chosen, at emergence and for the New People tool by its tile),
// habitat (× habitability for the people's race: dwarves seek the hills), siteBonus (+ score
// of a site, e.g. the ruins of an older town), settleName (the name a new town takes), rates
// 'emergence'. All neutral in a Historical world.

import { WATER, BIOMES, TIERS, DAYS_PER_YEAR } from '../../core/constants.js';
import { createCiv, createSettlement, killCiv, settlementsNear, civSettlements, liveCivs } from '../../core/entities.js';
import { emitFx, yearOf } from '../../core/world.js';
import { emit } from '../../core/hooks.js';
import { clamp, smoothstep } from '../../core/util.js';
import { sliceLike, takePeople, addShaped, shapedSlice } from '../../core/cohorts.js';
import { habitGrid } from './land.js';
import { getMods, grantEra, grantTech, refreshMods, TECHS, hasTech } from './tech.js';
import { fin, record, civCache, div, touchTile, civTowns } from './state.js';
import { placePhrase, seaNameNear, landNameAt, theName, TheName, peopleOf, PeopleOf, pick, peopleCount, freshPlaceName, goodName, civNameTaken } from './prose.js';
import { createLanguage, makeCivName } from '../../core/names.js';
import { mulOf, sumOf, firstOf, hasProviders } from '../../core/ext.js';

/** Habitability of tile i for a people of `race` (× the ext habitat answer; raw when none). */
function habitFor(world, habit, race, i) {
  return hasProviders('habitat') ? habit[i] * mulOf('habitat', world, race ?? null, i) : habit[i];
}
/** The ext siteBonus of a site for civ (0 when none). */
const siteBonus = (world, civ, i) => (hasProviders('siteBonus') ? sumOf('siteBonus', world, civ, i) : 0);
/** Who a new people is (ext people): { race, traits, languageStyle } or null. */
export function peopleAt(world, q) {
  if (!hasProviders('people')) return null;
  const r = firstOf('people', world, q);
  return r && typeof r === 'object' ? r : null;
}
/** civ options from a people answer. */
function peopleOpts(p) {
  if (!p) return {};
  const o = {};
  if (p.race !== undefined) o.race = p.race;
  if (p.traits && typeof p.traits === 'object') o.traits = p.traits;
  if (p.languageStyle && typeof p.languageStyle === 'object') o.languageStyle = p.languageStyle;
  return o;
}
/** A new town's name: the ext settleName answer (an old ruin's name), else a fresh one. */
export function townName(world, civ, i) {
  if (hasProviders('settleName')) {
    const n = firstOf('settleName', world, civ, i);
    if (typeof n === 'string' && n.length >= 2 && n.length <= 40) return n;
  }
  return freshPlaceName(world, civ.language);
}

const MIN_SPACING = 4;
/** Preferred spacing for ordinary settlers (refugees and tools may squeeze in closer). */
const SETTLER_SPACING = 6;
const ERA_POP = [1, 3, 6, 10];

function spacingOk(world, x, y, d = MIN_SPACING) {
  return settlementsNear(world, x, y, d - 0.01).length === 0;
}

// ---------------------------------------------------------------------------
// New peoples

/**
 * Create a people with a first settlement at (x, y). Returns { civ, s } or null.
 * opts: { population, era, techFrom: 'world'|null, civOpts, name (settlement) }
 */
export function newPeople(world, x, y, opts = {}) {
  const { W, f } = world;
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= world.H) return null;
  const i = y * W + x;
  if (f.water[i] !== WATER.LAND || f.settle[i] >= 0) return null;
  const civOpts = { x, y, ...(opts.civOpts || {}) };
  if (!civOpts.name) {
    // vet the people's name (no stray English words, no living namesake)
    const language = civOpts.language || createLanguage(world.rng, civOpts.languageStyle ?? null);
    civOpts.language = language;
    for (let k = 0; k < 8; k++) {
      const nm = makeCivName(language, world.rng);
      if (!goodName(nm.name) || civNameTaken(world, nm.name)) continue;
      civOpts.name = nm.name; civOpts.adjective = nm.adjective;
      break;
    }
  }
  const civ = createCiv(world, civOpts);
  if (opts.era > 0) grantEra(world, civ, opts.era);
  if (opts.techFrom === 'world') grantWorldKnowledge(world, civ);
  refreshMods(world, civ);
  const pop = opts.population ?? 120;
  // a new people brings stores enough to see it through the seasons before its first harvest
  const s = createSettlement(world, civ.id, x, y, { population: pop, food: pop * 6, name: opts.name || townName(world, civ, i) });
  if (!s) { killCiv(world, civ.id, 'vanished'); return null; }
  s.housing = pop * 1.6;
  if (getMods(world, civ).farming) seedFarms(world, s, 0.25 + 0.1 * (opts.era || 0));
  return { civ, s };
}

/** Knowledge common to most living peoples spreads to newcomers (excluding the newest eras). */
function grantWorldKnowledge(world, civ) {
  const civs = liveCivs(world).filter((c) => c.id !== civ.id);
  if (!civs.length) return;
  const eras = civs.map((c) => c.tech?.era || 0).sort((a, b) => a - b);
  const median = eras[Math.floor(eras.length / 2)];
  const maxEra = Math.max(0, median - 1);
  for (const t of TECHS) {
    if (t.era > maxEra) continue;
    let n = 0;
    for (const c of civs) if (hasTech(c, t.id)) n++;
    if (n / civs.length >= 0.6 && t.prereqs.every((p) => hasTech(civ, p))) grantTech(civ, t.id, world.time.day);
  }
  // prerequisites may have been granted out of order; do a second sweep
  for (const t of TECHS) {
    if (t.era > maxEra || hasTech(civ, t.id)) continue;
    let n = 0;
    for (const c of civs) if (hasTech(c, t.id)) n++;
    if (n / civs.length >= 0.6 && t.prereqs.every((p) => hasTech(civ, p))) grantTech(civ, t.id, world.time.day);
  }
  grantEra(world, civ, 0);
}

/** Pre-farmed fields around a settlement (later starting eras, colonies of farming peoples). */
export function seedFarms(world, s, level) {
  const { W, H, f } = world;
  const r = 2;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = s.x + dx, y = s.y + dy;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const i = y * W + x;
    if (f.water[i] !== WATER.LAND) continue;
    const B = BIOMES[f.biome[i]];
    const want = Math.min(1, B.farm * level * (1 - 0.15 * (dx * dx + dy * dy)));
    if (want > f.farm[i]) { f.farm[i] = want; touchTile(world, i); }
  }
}

// ---------------------------------------------------------------------------
// Genesis

/**
 * Spawn params.civCount tribes at the most habitable, well-separated sites. Each tribe's
 * people is known first (ext people, by tribe number), so its site is chosen by its own
 * habitability: habit × habitat(race, i).
 */
export function placeGenesis(world) {
  const n = Math.max(0, Math.round(fin(world.params.civCount, 7)));
  if (!n) return [];
  const { N, W, f } = world;
  const habit = habitGrid(world, true);
  const era = Math.max(0, Math.min(3, Math.round(fin(Number(world.params.startingEra), 0))));
  let land = 0;
  const lmSize = new Map();
  for (let i = 0; i < N; i++) if (f.water[i] === WATER.LAND) { land++; const lm = f.landmass[i]; lmSize.set(lm, (lmSize.get(lm) || 0) + 1); }
  if (!land) return [];
  // the first peoples do not camp on the flanks of a fire mountain (a lava flow in Year 4
  // would end a people before its history began)
  const nearVent = new Uint8Array(N);
  for (const v of world.volcanoes || []) {
    if (!v || !Number.isFinite(v.x) || !Number.isFinite(v.y)) continue;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = Math.round(v.x) + dx, y = Math.round(v.y) + dy;
      if (x >= 0 && y >= 0 && x < W && y < world.H && dx * dx + dy * dy <= 16) nearVent[y * W + x] = 1;
    }
  }
  // candidate pool per people: the best ~8% of land for them (at least the top 400 tiles)
  const pools = new Map();
  const poolFor = (race) => {
    const key = race ?? '';
    if (pools.has(key)) return pools.get(key);
    const hv = race == null ? habit : new Float32Array(N);
    if (race != null) for (let i = 0; i < N; i++) if (f.water[i] === WATER.LAND) hv[i] = habitFor(world, habit, race, i);
    const vals = [];
    for (let i = 0; i < N; i++) if (f.water[i] === WATER.LAND && hv[i] > 0.05) vals.push(hv[i]);
    vals.sort((a, b) => b - a);
    const thr = vals.length ? vals[Math.min(vals.length - 1, Math.max(400, Math.floor(vals.length * 0.08)))] : 0;
    const cands = [];
    for (let i = 0; i < N; i++) if (f.water[i] === WATER.LAND && hv[i] >= thr && hv[i] > 0.05 && !nearVent[i]) cands.push(i);
    const pool = { hv, cands };
    pools.set(key, pool);
    return pool;
  };
  const peoples = [];
  for (let k = 0; k < n; k++) peoples.push(peopleAt(world, { genesis: true, k }));
  const D = Math.sqrt(land / n) * 0.8;
  let dMin = Math.max(8, D * 0.55);
  const chosen = [];
  const usedLm = new Set();
  while (chosen.length < n && dMin >= 3) {
    const { hv, cands } = poolFor(peoples[chosen.length]?.race ?? null);
    let best = -1, bs = -1;
    for (const i of cands) {
      const x = i % W, y = (i / W) | 0;
      let dm = Infinity;
      for (const j of chosen) { const d = Math.hypot(x - (j % W), y - ((j / W) | 0)); if (d < dm) dm = d; }
      if (dm < dMin) continue;
      const lm = f.landmass[i];
      const lmBonus = !usedLm.has(lm) && (lmSize.get(lm) || 0) >= 120 ? 1.3 : 1;
      const sc = hv[i] * Math.min(1, dm / D) * lmBonus * (0.85 + 0.3 * world.rng.next());
      if (sc > bs) { bs = sc; best = i; }
    }
    if (best < 0) { dMin *= 0.7; continue; }
    chosen.push(best);
    usedLm.add(f.landmass[best]);
  }
  const out = [];
  chosen.forEach((i, k) => {
    const x = i % W, y = (i / W) | 0;
    const pop = world.rng.int(80, 200) * ERA_POP[era];
    const r = newPeople(world, x, y, { population: pop, era, civOpts: peopleOpts(peoples[k]) });
    if (!r) return;
    out.push(r);
    // later starting eras begin with a few daughter villages
    for (let q = 0; q < era; q++) {
      const site = findSite(world, r.s, r.civ, { range: 7 });
      if (!site) break;
      const vp = Math.round(pop * world.rng.float(0.3, 0.6));
      const v = createSettlement(world, r.civ.id, site.x, site.y, { population: vp, food: vp * 3, name: townName(world, r.civ, site.i) });
      if (v) { v.housing = vp * 1.6; if (getMods(world, r.civ).farming) seedFarms(world, v, 0.2 + 0.1 * era); }
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Site search

/**
 * Best settlement site for settlers from `from` (settlement) of `civ`.
 * opts: { range, overseas: bool, minHabit }
 * Returns { i, x, y, overseas } or null.
 */
export function findSite(world, from, civ, opts = {}) {
  if (opts.overseas) return findOverseasSite(world, from, civ, opts);
  const { W, H, f } = world;
  const habit = habitGrid(world);
  const mods = getMods(world, civ);
  const R = Math.max(4, Math.min(40, opts.range ?? mods.expansionRange));
  const lm = f.landmass[from.i];
  const minH = opts.minHabit ?? 0.22;
  const top = [];
  const R2 = R * R;
  for (let dy = -R; dy <= R; dy++) {
    const y = from.y + dy;
    if (y < 0 || y >= H) continue;
    for (let dx = -R; dx <= R; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > R2 || d2 < 16) continue;
      const x = from.x + dx;
      if (x < 0 || x >= W) continue;
      const i = y * W + x;
      if (f.water[i] !== WATER.LAND || f.settle[i] >= 0 || f.landmass[i] !== lm) continue;
      const o = f.owner[i];
      if (o >= 0 && o !== civ.id) continue;
      const h = habitFor(world, habit, civ.race, i);
      if (h < minH) continue;
      const d = Math.sqrt(d2);
      let sc = h * (1 - Math.abs(d - 6.5) * 0.04) * (o < 0 ? 1.1 : 1);
      if (f.river[i]) sc += 0.04;
      if (f.coast[i]) sc += 0.03;
      if (f.resource[i]) sc += 0.05;
      sc += siteBonus(world, civ, i);
      sc += world.rng.next() * 0.05;
      insertTop(top, sc, i, 8);
    }
  }
  const sp = opts.spacing ?? SETTLER_SPACING;
  for (const [, i] of top) {
    const x = i % W, y = (i / W) | 0;
    if (spacingOk(world, x, y, sp)) return { i, x, y, overseas: false };
  }
  return null;
}

function insertTop(top, sc, i, k) {
  if (top.length >= k && sc <= top[top.length - 1][0]) return;
  let p = top.length;
  while (p > 0 && top[p - 1][0] < sc) p--;
  top.splice(p, 0, [sc, i]);
  if (top.length > k) top.pop();
}

function bfsBuffers(world) {
  const c = civCache(world);
  if (!c.bfs || c.bfs.stamp.length !== world.N) c.bfs = { stamp: new Int32Array(world.N), dist: new Uint16Array(world.N), q: new Int32Array(world.N), gen: 0 };
  return c.bfs;
}

/** Sail outward from a harbour over the ocean (≤ seaRange steps) and pick a far coast. */
function findOverseasSite(world, from, civ, opts) {
  const { W, H, f } = world;
  const mods = getMods(world, civ);
  if (mods.navigation < 1 || !from.coastal) return null;
  const range = Math.max(4, Math.min(250, (opts.range ?? 0) || (mods.seaRange + (mods.navigation >= 2 ? 10 : 4))));
  const b = bfsBuffers(world);
  const gen = ++b.gen;
  let qh = 0, qt = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = from.x + dx, y = from.y + dy;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const j = y * W + x;
    if (f.water[j] === WATER.OCEAN && b.stamp[j] !== gen) { b.stamp[j] = gen; b.dist[j] = 1; b.q[qt++] = j; }
  }
  if (!qt) return null;
  const habit = habitGrid(world);
  const homeLm = f.landmass[from.i];
  const top = [];
  const maxNodes = 30000;
  while (qh < qt && qh < maxNodes) {
    const j = b.q[qh++];
    const dj = b.dist[j];
    const x = j % W, y = (j / W) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const k = ny * W + nx;
      if (b.stamp[k] === gen) continue;
      b.stamp[k] = gen;
      const w = f.water[k];
      if (w === WATER.OCEAN) {
        if (dj < range) { b.dist[k] = dj + 1; b.q[qt++] = k; }
      } else if (w === WATER.LAND) {
        if (f.settle[k] >= 0) continue;
        const o = f.owner[k];
        if (o >= 0 && o !== civ.id) continue;
        const h = habitFor(world, habit, civ.race, k);
        if (h < 0.3) continue;
        const otherLand = f.landmass[k] !== homeLm;
        const far = Math.hypot(nx - from.x, ny - from.y);
        if (!otherLand && far < 12) continue;
        const sc = h + (otherLand ? 0.18 : 0) + (o < 0 ? 0.08 : 0) + siteBonus(world, civ, k) + world.rng.next() * 0.08;
        insertTop(top, sc, k, 8);
      }
    }
  }
  for (const [, i] of top) {
    const x = i % W, y = (i / W) | 0;
    if (spacingOk(world, x, y, SETTLER_SPACING)) return { i, x, y, overseas: true, newLand: f.landmass[i] !== homeLm };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Founding

/** Found a settlement for civ and chronicle it. opts: { from, overseas, refugees, divine, cohorts (the founders' age bands) } */
export function foundSettlement(world, civ, x, y, pop, opts = {}) {
  const i0 = Math.round(y) * world.W + Math.round(x);
  const s = createSettlement(world, civ.id, x, y, { population: pop, food: pop * 4, name: townName(world, civ, i0), cohorts: opts.cohorts });
  if (!s) return null;
  const from = opts.from || null;
  if (from) emit(world, 'settled', s, from);   // the settlers carry their town's peoples (geo/folk.js)
  s.housing = pop * 1.6;
  s.health = from ? Math.max(0.6, fin(from.health, 0.75)) : 0.75;
  s.happiness = 0.62; s.loyalty = 0.78;
  if (getMods(world, civ).farming) seedFarms(world, s, 0.12);
  const st = world.sys.civ;
  const lm = world.f.landmass[s.i];
  const firstOnLand = !civSettlements(world, civ).some((o) => o.id !== s.id && world.f.landmass[o.i] === lm);
  const place = placePhrase(world, s.x, s.y);
  let text, imp = 1;
  if (opts.divine) {
    const sea = opts.overseas && from ? seaNameNear(world, (from.x + s.x) / 2, (from.y + s.y) / 2) : null;
    text = from
      ? pick(world, [
        `Guided by a vision, settlers from ${from.name} ${opts.overseas ? `crossed ${sea || 'the sea'}` : 'set out'} and founded ${s.name} ${place}.`,
        `A light in the sky led ${peopleOf(civ)} of ${from.name} ${opts.overseas ? `over ${sea || 'the water'}` : 'into new country'}, and where it came to rest they founded ${s.name}, ${place}.`,
      ])
      : `Guided by an unseen hand, ${peopleOf(civ)} founded ${s.name} ${place}.`;
    imp = 2;
  } else if (opts.overseas && from) {
    const sea = seaNameNear(world, (from.x + s.x) / 2, (from.y + s.y) / 2) || 'the sea';
    const land = landNameAt(world, s.x, s.y);
    text = pick(world, [
      `Sailing from ${from.name}, ${civ.adjective} colonists crossed ${sea} and founded ${s.name}${land && firstOnLand ? ' on ' + land : ''}.`,
      `${PeopleOf(civ)} of ${from.name} planted the colony of ${s.name} across ${sea}.`,
      `Ships from ${from.name} carried settlers over ${sea} to found ${s.name} ${place}.`,
    ]);
    imp = firstOnLand ? 2 : 1;
    if (st) st.counters.colonies++;
    if (civ.ruler?.deeds) { civ.ruler.deeds.colonies = (civ.ruler.deeds.colonies || 0) + 1; civ.ruler.flags = { ...(civ.ruler.flags || {}), colony: s.name }; }
  } else if (opts.refugees && from) {
    text = pick(world, [
      `Refugees fleeing hunger in ${from.name} founded ${s.name} ${place}.`,
      `Driven from ${from.name} by famine, ${peopleCount(world, pop)} made a new home at ${s.name}.`,
    ]);
  } else if (from) {
    text = pick(world, [
      `Settlers from ${from.name} founded ${s.name} ${place}.`,
      `A band from ${from.name} set out and founded ${s.name} ${place}.`,
      `${PeopleOf(civ)} of ${from.name} built a new home at ${s.name}, ${place}.`,
    ]);
    if (firstOnLand) imp = 2;
  } else {
    text = `${TheName(civ)} founded ${s.name} ${place}.`;
  }
  const key = opts.divine ? 'divine.settle' : opts.overseas ? 'settlement.colony' : opts.refugees ? 'settlement.refugees' : 'settlement.founded';
  record(world, { cat: opts.divine ? 'divine' : 'civ', imp, key, text, s, cause: opts.cause ?? null });
  emitFx(world, { type: 'founding', x: s.x, y: s.y, civId: civ.id, ...(opts.divine ? { src: 'tool' } : {}) });
  return s;
}

/**
 * Settlers leave a pressured settlement. ctx: { pressure, houseRatio, mods }.
 * Returns the new settlement or null.
 */
export function trySettlers(world, s, civ, ctx) {
  const mods = ctx.mods;
  const pop = s.population;
  if (pop < (mods.farming ? 260 : 150)) return null;
  const day = world.time.day;
  if (day - s.flags.lastSettler < 5 * DAYS_PER_YEAR) return null;
  if (day - fin(civ.flags.lastSettlerDay, -1e9) < 45) return null;
  const drive = Math.max(ctx.pressure - 0.72, ctx.houseRatio - 0.8, 0) * 2.5;
  const base = 0.015 * fin(civ.traits?.expansion, 0.5); // restless peoples wander even when fed
  const over = fin(civ.flags.overext);
  const crowd = civ.settlementIds.length > fin(civ.flags.capacity, 6) ? 0.35 : 1;
  const p = (Math.min(1, drive) * 0.1 + base) * crowd * fin(world.params.expansionism, 1)
    * (0.4 + 1.2 * fin(civ.traits?.expansion, 0.5)) * (over > 0 ? Math.max(0.12, 1 - over) : 1)
    * (s.siege ? 0 : 1) * (civ.ruler?.traits?.includes('ambitious') ? 1.3 : 1);
  if (!(p > 0) || !world.rng.chance(p)) return null;
  // Remember failed searches so a full land is not searched every month: a settlement
  // that found no room waits 3, 6, 12… years; a civ whose towns keep failing pauses all
  // overland (or overseas) searches for a while. Success resets both.
  const fl = civ.flags;
  const canSail = mods.navigation >= 1 && s.coastal && (s.harbor || mods.navigation >= 2)
    && day >= fin(s.flags.noSeaDay, -1) && day >= fin(fl.noSeaDay, -1);
  let site = null;
  if (day >= fin(s.flags.noSiteDay, -1) && day >= fin(fl.noRoomDay, -1)) {
    site = findSite(world, s, civ);
    if (!site) {
      const n = Math.min(4, fin(s.flags.noSiteN) + 1);
      s.flags.noSiteN = n;
      s.flags.noSiteDay = day + 3 * DAYS_PER_YEAR * (1 << (n - 1));
      fl.roomFails = fin(fl.roomFails) + 1;
      if (fl.roomFails >= 4) { fl.noRoomDay = day + Math.min(12, fl.roomFails) * DAYS_PER_YEAR; }
    } else { s.flags.noSiteN = 0; fl.roomFails = 0; }
  }
  // a chartered company sends colonists beyond the seas twice as readily (tech.js)
  const company = hasTech(civ, 'company') ? 2 : 1;
  if ((!site && canSail && world.rng.chance(0.7)) || (site && canSail && world.rng.chance(0.12 * company * (0.5 + fin(civ.traits?.expansion))))) {
    const sea = findSite(world, s, civ, { overseas: true });
    if (sea) { site = sea; fl.seaFails = 0; }
    else {
      s.flags.noSeaDay = day + 8 * DAYS_PER_YEAR;
      fl.seaFails = fin(fl.seaFails) + 1;
      if (fl.seaFails >= 3) fl.noSeaDay = day + Math.min(15, 2 * fl.seaFails) * DAYS_PER_YEAR;
    }
  }
  if (!site) return null;
  const n = clamp(pop * world.rng.float(0.1, 0.18), 40, 5000);
  const sl = sliceLike(s);
  takePeople(world, s, n, 'movers', sl, civ);
  s.flags.lastSettler = day;
  civ.flags.lastSettlerDay = day;
  return foundSettlement(world, civ, site.x, site.y, n * 0.92, { from: s, overseas: site.overseas, cohorts: sl });
}

/**
 * Move refugees from s to a better-fed settlement of the same civ (within reach), or let a
 * large band found a camp. Returns the number of people placed.
 */
export function routeMigrants(world, s, civ, n) {
  if (!(n >= 1)) return 0;
  const range = Math.max(12, getMods(world, civ).adminRange * 1.5);
  let best = null, bs = -Infinity;
  for (const t of civTowns(world, civ)) {
    if (t.id === s.id || t.siege || !t.alive || t.civId !== civ.id) continue;
    const d = Math.hypot(t.x - s.x, t.y - s.y);
    if (d > range) continue;
    const stock = div(t.food, t.population, 0);
    const hr = div(t.population, t.housing, 2);
    if (stock < 1.5 || hr > 0.95) continue;
    const sc = Math.min(6, stock) - d / 8 - hr * 2;
    if (sc > bs) { bs = sc; best = t; }
  }
  if (best) { addShaped(world, best, n * 0.85, 'movers', civ); emit(world, 'migrants', s, best, n * 0.85); return n * 0.85; }
  if (n >= 50 && world.rng.chance(0.35 * fin(world.params.migration, 1))) {
    const site = findSite(world, s, civ, { minHabit: 0.18, spacing: MIN_SPACING });
    if (site) { foundSettlement(world, civ, site.x, site.y, n * 0.75, { from: s, refugees: true, cohorts: shapedSlice(world, n, 'movers', civ) }); return n * 0.75; }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Emergence

/** Yearly: a new people may arise in a large empty habitable region. */
export function emergence(world) {
  const rate = fin(world.params.emergenceRate, 1);
  if (rate <= 0) return null;
  const { W, H, f } = world;
  const yr = yearOf(world);
  const ramp = 0.25 + 0.75 * smoothstep(80, 450, yr);
  const habit = habitGrid(world);
  const B = 8;
  const cands = [];
  const raced = hasProviders('habitat');
  for (let by = 0; by < H; by += B) for (let bx = 0; bx < W; bx += B) {
    let land = 0, free = 0, hs = 0, bi = -1, bh = 0;
    for (let y = by; y < Math.min(H, by + B); y++) for (let x = bx; x < Math.min(W, bx + B); x++) {
      const i = y * W + x;
      if (f.water[i] !== WATER.LAND) continue;
      land++;
      if (f.owner[i] >= 0) continue;
      // any people's view of the land (a race-free habitat answer: the best-suited people)
      const h = raced ? habitFor(world, habit, null, i) : habit[i];
      free++; hs += h;
      if (h > bh) { bh = h; bi = i; }
    }
    if (land < 24 || free < land * 0.92 || bi < 0) continue;
    const mh = hs / free;
    if (mh < 0.36) continue;
    cands.push([bi, mh]);
  }
  if (!cands.length) return null;
  const rm = hasProviders('rates') ? mulOf('rates', world, 'emergence') : 1;
  const p = Math.min(0.2, 0.016 * rate * ramp * rm * Math.min(1.5, Math.sqrt(cands.length / 6)));
  if (!world.rng.chance(p)) return null;
  const weights = cands.map(([, mh]) => mh * mh);
  let tot = 0; for (const w of weights) tot += w;
  let r = world.rng.next() * tot, k = 0;
  for (; k < cands.length - 1; k++) { r -= weights[k]; if (r <= 0) break; }
  const i = cands[k][0];
  const x = i % W, y = (i / W) | 0;
  if (!spacingOk(world, x, y, 9)) return null;
  const res = newPeople(world, x, y, { population: world.rng.int(90, 220), techFrom: 'world', civOpts: peopleOpts(peopleAt(world, { genesis: false, i })) });
  if (!res) return null;
  const { civ, s } = res;
  const st = world.sys.civ;
  if (st) st.counters.emerged++;
  const place = placePhrase(world, x, y);
  const text = pick(world, [
    `A new people, ${theName(civ)}, arose ${place} and built their first hearths at ${s.name}.`,
    `Far from the old nations, ${peopleOf(civ)} gathered ${place} and founded ${s.name}.`,
    `In lands no nation claimed, ${peopleOf(civ)} emerged as a people of their own at ${s.name}, ${place}.`,
  ]);
  record(world, { cat: 'civ', imp: 4, key: 'people.emerged', text, s, ref: { k: 'civ', id: civ.id } });
  emitFx(world, { type: 'newcivs', x, y, civId: civ.id });
  return civ;
}

export { spacingOk, MIN_SPACING, TIERS };
