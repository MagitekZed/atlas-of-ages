// Buildings and wonders: what each settlement builds with its production, completion
// effects, wonder bookkeeping (world.wonders, one standing wonder per kind) and the geometry
// of the wonders that reshape the land (the Great Wall's course, the Grand Canal, the Great
// Dam), recorded once at completion for the renderer.
//
// s.buildings = { key: level }   (keys from data.js BUILDINGS, plus registered racial halls)
// s.project   = { kind: 'building'|'wonder', key, level, cost, progress } | null
// world.wonders[id] = { id, name, kind, sid, civId, builtDay, destroyedDay, path, i }
//   path  [tile index] | null   great_wall: ≤ 120 border tiles facing other realms within 12
//                               tiles of the city (a contiguous chain); grand_canal: ≤ 60
//                               tiles from the city to the nearest coast or another river
//   i     tile index | null     great_dam: the river tile below the city it spans
// Hooks: buildingCompleted (world, s, key, level), wonderBuilt (world, w), wonderDestroyed (world, w).

import { addIndexed } from '../../core/entities.js';
import { emitFx } from '../../core/world.js';
import { emit } from '../../core/hooks.js';
import { SETTLEMENT_MOD_KEYS } from '../../core/effects.js';
import { WATER } from '../../core/constants.js';
import { BUILDINGS, buildingName, buildingDef, registeredBuildingKeys, wonderDef, allWonders } from './data.js';
import { hasTech, refreshMods } from './tech.js';
import { fin, record, rateOk, civCache } from './state.js';
import { theName, TheName, rulerShort, pick, peopleOf, fmtInt } from './prose.js';

const eraScale = (era) => 1 + 0.6 * era;

/** May this settlement of civ raise a registered (racial) building at all? */
function regAllowed(world, s, civ, b) {
  if (!b.registered) return true;
  if (!world) return false;
  if (b.race && (s.race || civ.race) !== b.race) return false;
  if (typeof b.available === 'function') {
    try { if (!b.available(world, s, civ)) return false; } catch (e) { return false; }
  }
  return true;
}

/**
 * Highest level of a building the civ's techs and the settlement's tier allow. Registered
 * buildings also need world (their race and available gates).
 */
export function allowedLevel(civ, s, key, world = null) {
  const b = buildingDef(key);
  if (!b) return 0;
  if (b.coastal && !s.coastal) return 0;
  if (b.registered && !regAllowed(world, s, civ, b)) return 0;
  let lvl = 0;
  for (let k = 0; k < b.tech.length; k++) {
    const minTier = Array.isArray(b.minTier) ? b.minTier[k] ?? b.minTier[b.minTier.length - 1] : b.minTier;
    if (hasTech(civ, b.tech[k]) && (s.tier || 0) >= minTier) lvl = k + 1; else break;
  }
  return Math.min(lvl, Array.isArray(b.names) ? b.names.length : lvl);
}

/**
 * allowedLevel(civ, s, key) >= lvl for a built-in (unregistered) building def, without the
 * def lookup and with the level gates per level precomputed: the first lvl techs known, each
 * with the town's tier at its level's minimum, and no more levels than the building has names.
 */
function builtInAllows(b, lvl, known, tier, coastal) {
  if (b.coastal && !coastal) return false;
  const T = b.tech;
  if (lvl > T.length || (Array.isArray(b.names) && lvl > b.names.length)) return false;
  const mt = minTiers(b);
  for (let k = 0; k < lvl; k++) if (!(known && known[T[k]] != null) || !(tier >= mt[k])) return false;
  return true;
}
/** The built-in buildings (data.js BUILDINGS is constant): { key: { b: def, ix } } and key → ix. */
const BUILT = Object.fromEntries(Object.keys(BUILDINGS).map((k, ix) => [k, { b: BUILDINGS[k], ix }]));
const BUILT_IX = new Map(Object.keys(BUILDINGS).map((k, ix) => [k, ix]));
const BUILT_N = BUILT_IX.size;
/** Per-level minimum tiers of a building def, as allowedLevel reads them (cached on constant data). */
const MIN_TIERS = new Map();
function minTiers(b) {
  let mt = MIN_TIERS.get(b);
  if (!mt) {
    mt = b.tech.map((_, k) => (Array.isArray(b.minTier) ? b.minTier[k] ?? b.minTier[b.minTier.length - 1] : b.minTier));
    MIN_TIERS.set(b, mt);
  }
  return mt;
}

export function buildingCost(key, level, era) {
  const b = buildingDef(key);
  return Math.round((b ? b.cost : 100) * (1 + 0.8 * (level - 1)) * eraScale(era));
}

/** Total upkeep (wealth per month) of a settlement's buildings. */
export function buildingUpkeep(s, era) {
  let u = 0;
  for (const k in s.buildings) u += (buildingDef(k)?.upkeep || 0) * s.buildings[k];
  return u * (1 + 0.2 * era);
}

/**
 * Pick the next project. ctx (from the settlement update): { stockMonths, houseRatio,
 * health, happiness, ore, atWar, borderTown, isCapital, era, mods, production }.
 */
export function chooseProject(world, s, civ, ctx) {
  const st = world.sys.civ;
  const tr = civ.traits || {};
  const ruler = civ.ruler?.traits || [];
  const B = s.buildings;
  const known = civ?.tech?.known;
  const tier = s.tier || 0, coastal = s.coastal;
  let best = null, bestScore = 0.6;
  // the town's levels of the built-in buildings, read in one walk over s.buildings (one keyed
  // read per building it holds rather than per building considered); the values are taken as
  // they stand, so (level || 0) + 1 is exactly what reading s.buildings[key] gives
  const lv = new Array(BUILT_N).fill(0);
  let other = null;   // any other key it holds (registered halls), as read
  for (const k in B) { const j = BUILT_IX.get(k); if (j !== undefined) lv[j] = B[k]; else (other ||= new Map()).set(k, B[k]); }
  // def: a built-in building (its level gate is checked here, exactly as allowedLevel would) or
  // null for a registered one (allowedLevel with its race and availability gates)
  // the next level of key when the town may raise it (else null)
  const nextLevel = (key, def) => {
    const lvl = ((def ? lv[def.ix] : other ? other.get(key) : undefined) || 0) + 1;
    return (def ? builtInAllows(def.b, lvl, known, tier, coastal) : !(lvl > allowedLevel(civ, s, key, world))) ? lvl : null;
  };
  const take = (key, lvl, score) => {
    const sc = score * (0.85 + 0.3 * world.rng.next()) / Math.sqrt(lvl);
    if (sc > bestScore) { bestScore = sc; best = { kind: 'building', key, level: lvl, cost: buildingCost(key, lvl, ctx.era), progress: 0 }; }
  };
  const consider = (key, def, score) => { const lvl = nextLevel(key, def); if (lvl !== null) take(key, lvl, score); };
  const D = BUILT;
  const cautious = ruler.includes('cautious'), pious = ruler.includes('pious'), warlike = ruler.includes('warlike');
  const scholarly = ruler.includes('scholarly'), industrious = ruler.includes('industrious');
  consider('granary', D.granary, 1.6 + (ctx.stockMonths < 3 ? 1.5 : 0) + (s.famine > 0 ? 2 : 0) + Math.min(1.5, s.population / 4000));
  // (walls: the border test, a search of the neighbourhood, only when walls can be raised)
  const lvlW = nextLevel('walls', D.walls);
  if (lvlW !== null) take('walls', lvlW, 0.8 + (ctx.atWar ? 2 : 0) + (ctx.borderTown ? 0.8 : 0) + 0.25 * (s.tier || 0) + (ctx.isCapital ? 0.6 : 0)
    + (cautious ? 0.8 : 0) + fin(tr.militarism) * 0.6 + (s.siege ? 3 : 0));
  consider('temple', D.temple, 1 + Math.max(0, 0.62 - ctx.happiness) * 6 + fin(tr.religiosity) * 1.2 + (pious ? 0.8 : 0));
  consider('harbor', D.harbor, 2 + (ctx.fishShare > 0.2 ? 1 : 0) + fin(tr.commerce) + fin(tr.expansion) * 0.5);
  if (ctx.ore > 0.4) consider('mine', D.mine, 1.6 + Math.min(2, ctx.ore * 0.5));
  consider('barracks', D.barracks, 0.6 + (ctx.atWar ? 1.8 : 0) + fin(tr.militarism) * 1.5 + (warlike ? 0.8 : 0));
  consider('library', D.library, 1.2 + fin(tr.innovation) * 2 + (scholarly ? 1 : 0));
  consider('market', D.market, 1.6 + fin(tr.commerce) * 2 + (fin(s.tradeIncome) > 0 ? 0.8 : 0));
  consider('aqueduct', D.aqueduct, 0.8 + (ctx.houseRatio > 0.7 ? 2.5 : 0) + (ctx.health < 0.6 ? 1.5 : 0));
  consider('theatre', D.theatre, 0.8 + Math.max(0, 0.65 - ctx.happiness) * 4 + fin(tr.tolerance));
  consider('workshop', D.workshop, 1.8 + (industrious ? 0.8 : 0));
  consider('university', D.university, 1.2 + fin(tr.innovation) * 2.2);
  consider('observatory', D.observatory, 0.9 + fin(tr.innovation) * 1.2);
  consider('bank', D.bank, 1.2 + fin(tr.commerce) * 2);
  consider('hospital', D.hospital, 1 + (ctx.health < 0.75 ? 2.5 : 0) + (s.disease ? 1.5 : 0));
  consider('factory', D.factory, 1.5 + 2.5 * fin(ctx.mods.industry));
  consider('railway', D.railway, 2.4);
  consider('sewers', D.sewers, 1 + (ctx.health < 0.78 ? 2 : 0) + (ctx.houseRatio > 0.8 ? 1.5 : 0));
  consider('powerplant', D.powerplant, 1.6 + (B.powerplant && hasTech(civ, 'renewables') ? 2 : 0));
  consider('airport', D.airport, 1.6);
  // a people's own halls (registered, race- and land-gated; none in a Historical world)
  for (const key of registeredBuildingKeys()) {
    const d = buildingDef(key);
    let sc = d.score;
    if (d.smods?.housing > 1 && ctx.houseRatio > 0.8) sc += 0.8;
    if ((d.smods?.health > 0 || d.smods?.foodYield > 1) && (ctx.health < 0.7 || ctx.stockMonths < 2)) sc += 0.6;
    if (d.smods?.defense > 0 && ctx.atWar) sc += 0.6;
    consider(key, null, sc);
  }

  // wonders: great settlements of civs that can afford the decades of work
  if (!civ.flags.wonderSid || !world.settlements[civ.flags.wonderSid]?.alive || world.settlements[civ.flags.wonderSid].civId !== civ.id) {
    civ.flags.wonderSid = null;
    if ((s.tier >= 3 && ctx.isCapital) || s.tier >= 4) {
      const cands = allWonders().filter((w) => w.era <= ctx.era && hasTech(civ, w.tech) && s.tier >= w.minTier
        && st.wonderKinds[w.kind] == null && wonderSiteOk(world, s, w) && wonderGateOk(world, s, civ, w));
      if (cands.length) {
        const w = pick(world, cands);
        const cost = Math.round(w.cost * eraScale(w.era));
        // only start if it could finish within ~60 years of half the city's output
        if (ctx.production * 0.5 * 12 * 60 > cost) {
          const sc = 2 + w.prestige / 12 + fin(tr.religiosity) * 0.3 + (ruler.includes('ambitious') ? 0.8 : 0) + (civ.goldenAge > 0 ? 1 : 0);
          if (sc > bestScore) { bestScore = sc; best = { kind: 'wonder', key: w.kind, level: 1, cost, progress: 0 }; }
        }
      }
    }
  }
  if (best && best.kind === 'wonder') civ.flags.wonderSid = s.id;
  return best;
}

export function wonderSiteOk(world, s, w) {
  if (!w.needs) return true;
  if (w.needs === 'coastal') return s.coastal;
  if (w.needs === 'river') return world.f.river[s.i] >= 2;
  return (s.buildings[w.needs] || 0) > 0;
}
/** Race and available gates of a registered wonder (shared wonders always pass). */
export function wonderGateOk(world, s, civ, w) {
  if (!w.registered) return true;
  if (w.race && (s.race || civ.race) !== w.race) return false;
  if (typeof w.available === 'function') {
    try { return Boolean(w.available(world, s, civ)); } catch (e) { return false; }
  }
  return true;
}

/** Invest production into the current project; completes it when paid. */
export function progressProject(world, s, civ, invest, ctx) {
  if (!s.project) {
    if (world.time.day < fin(s.flags.planDay, -1)) return;
    s.project = chooseProject(world, s, civ, ctx);
    if (!s.project) { s.flags.planDay = world.time.day + 300; return; }
  }
  const p = s.project;
  if (p.kind === 'wonder') {
    const st = world.sys.civ;
    if (st.wonderKinds[p.key] != null) { // beaten to it
      s.wealth += p.progress * 0.2;
      s.project = null;
      if (civ.flags.wonderSid === s.id) civ.flags.wonderSid = null;
      return;
    }
    // the crown helps pay for wonders
    const subsidy = Math.max(0, Math.min(civ.treasury * 0.04, p.cost * 0.004));
    civ.treasury -= subsidy;
    invest += subsidy;
  }
  p.progress += Math.max(0, fin(invest));
  if (p.progress >= p.cost) {
    s.project = null;
    if (p.kind === 'wonder') completeWonder(world, s, civ, p.key);
    else completeBuilding(world, s, civ, p.key, p.level);
  }
}

const NOTABLE = { walls: 2, library: 1, university: 1, aqueduct: 1, harbor: 1, theatre: 1, hospital: 1, factory: 1, railway: 1, sewers: 1, observatory: 1, airport: 1, temple: 3, bank: 1 };

function completeBuilding(world, s, civ, key, level) {
  s.buildings[key] = Math.max(s.buildings[key] || 0, level);
  s.flags.brev = (s.flags.brev | 0) + 1;
  if (key === 'harbor') s.harbor = true;
  if (civ.ruler?.deeds) civ.ruler.deeds.built = (civ.ruler.deeds.built || 0) + 1;
  const def = buildingDef(key);
  const minLvl = def?.registered ? 1 : NOTABLE[key];
  if (minLvl != null && level >= minLvl && s.tier >= (def?.registered ? 2 : 3) && rateOk(world, `bld:${s.id}`, 8)) {
    const name = buildingName(key, level).toLowerCase();
    const plural = /s$/.test(name);              // "stone walls", "sewers"
    const a = plural ? '' : /^[aeiou]/.test(name) ? 'an ' : 'a ';
    const text = plural
      ? pick(world, [`${s.name} completed its ${name}.`, `The people of ${s.name} raised new ${name}.`, `New ${name} were finished in ${s.name}.`])
      : pick(world, [`${s.name} completed its ${name}.`, `The people of ${s.name} raised ${a}${name}.`, `A new ${name} opened in ${s.name}.`]);
    record(world, { cat: 'civ', imp: 1, key: 'building', text, s, tags: [key] });
  }
  emit(world, 'buildingCompleted', s, key, level);
}

/** "the Standing Stones of X were…", "the Hanging Gardens of X were…" */
const pluralName = (name) => /\b(Stones|Gardens|Halls|Deeps)\b/.test(name);
const capFirst = (t) => t.charAt(0).toUpperCase() + t.slice(1);

function wonderName(world, s, civ, def) {
  const tpl = pick(world, def.names);
  return tpl.replace('{city}', s.name).replace('{adj}', civ.adjective).replace('{ruler}', civ.ruler ? rulerShort(civ.ruler) : s.name);
}

/**
 * Raise a wonder at s now (the end of its project, or a divine commission). Returns the
 * wonder, or null when one of that kind already stands. opts: { divine, text, cause }.
 */
export function completeWonder(world, s, civ, kind, opts = {}) {
  const def = wonderDef(kind);
  const st = world.sys.civ;
  if (!def || !st || st.wonderKinds[kind] != null) return null;
  const name = wonderName(world, s, civ, def);
  const w = addIndexed(world, 'wonders', { id: -1, name, kind, sid: s.id, civId: civ.id, builtDay: world.time.day, destroyedDay: null, path: null, i: null });
  wonderGeometry(world, w, s, civ);
  st.wonderKinds[kind] = w.id;
  s.flags.wonders = (s.flags.wonders || 0) + 1;
  if (civ.flags.wonderSid === s.id) civ.flags.wonderSid = null;
  if (s.project && s.project.kind === 'wonder' && s.project.key === kind) s.project = null;
  civ.prestige = fin(civ.prestige) + def.prestige;
  civ.flags.lastWonderDay = world.time.day;
  if (civ.ruler?.deeds) { civ.ruler.deeds.wonders = (civ.ruler.deeds.wonders || 0) + 1; civ.ruler.flags = { ...(civ.ruler.flags || {}), built: s.name }; }
  refreshMods(world, civ);
  const first = world.wonders.length === 1;
  const ruler = civ.ruler ? `${civ.ruler.title} ${rulerShort(civ.ruler)}` : null;
  const N = capFirst(name);
  const was = pluralName(name) ? 'were' : 'was';
  let text = opts.text ? capFirst(typeof opts.text === 'function' ? opts.text(name) : opts.text.replace('{W}', name)) : pick(world, [
    `${N} ${was} completed after years of labour, and pilgrims came from far beyond the borders of ${theName(civ)} to see it.`,
    ruler ? `${ruler} dedicated ${name}, the pride of ${peopleOf(civ)}.` : `${TheName(civ)} dedicated ${name}.`,
    `In ${s.name} the builders of ${theName(civ)} finished ${name}, a wonder of the age.`,
  ]);
  if (!opts.text && kind === 'great_wall' && w.path) text += ` Its ramparts ran for some ${fmtInt(w.path.length * 20)} km along the marches.`;
  if (!opts.text && kind === 'grand_canal' && w.path) text += ` Its waters were carried ${fmtInt(w.path.length * 20)} km across the land.`;
  record(world, {
    cat: opts.divine ? 'divine' : 'culture', imp: first ? 5 : opts.divine ? 4 : 3, key: opts.divine ? 'divine.commission_wonder' : 'wonder.built',
    text: first ? `${text} It was the first wonder the world had ever seen.` : text, s, ref: { k: 'wonder', id: w.id }, cause: opts.cause ?? null, tags: [kind],
  });
  emitFx(world, { type: 'wonder', x: s.x, y: s.y, civId: civ.id, ...(opts.divine ? { src: 'tool' } : {}) });
  emit(world, 'wonderBuilt', w);
  return w;
}

/** Wonder bookkeeping when a settlement is destroyed. */
export function wondersOnDestroyed(world, s, cause) {
  const st = world.sys.civ;
  for (const w of world.wonders) {
    if (w.sid !== s.id || w.destroyedDay != null) continue;
    w.destroyedDay = world.time.day;
    if (st && st.wonderKinds[w.kind] === w.id) delete st.wonderKinds[w.kind];
    const civ = world.civs[w.civId];
    if (civ && civ.alive) refreshMods(world, civ);
    const are = pluralName(w.name);
    const how = cause === 'razed' ? pick(world, [`${are ? 'were' : 'was'} torn down when ${s.name} was razed`, `${are ? 'were' : 'was'} pulled down stone by stone by the sackers of ${s.name}`])
      : cause === 'sea' || cause === 'flood' ? `vanished beneath the waves with ${s.name}`
        : cause === 'lava' ? `${are ? 'were' : 'was'} buried under the lava that took ${s.name}`
          : cause === 'meteor' ? `${are ? 'were' : 'was'} shattered by the fire that fell on ${s.name}`
            : `fell into ruin with ${s.name} around ${are ? 'them' : 'it'}`;
    record(world, { cat: 'culture', imp: 3, key: 'wonder.destroyed', text: `${capFirst(w.name)} ${how}.`, x: s.x, y: s.y, sid: s.id, civId: w.civId, ref: { k: 'wonder', id: w.id }, tags: [w.kind] });
    emit(world, 'wonderDestroyed', w);
  }
}

/** Wonder ownership follows its settlement. */
export function wondersOnTransferred(world, s, oldCivId, newCivId) {
  let any = false;
  for (const w of world.wonders) {
    if (w.sid === s.id && w.destroyedDay == null) { w.civId = newCivId; any = true; }
  }
  if (!any) return;
  for (const id of [oldCivId, newCivId]) {
    const c = world.civs[id];
    if (c && c.alive) refreshMods(world, c);
  }
}

// ---------------------------------------------------------------------------
// Wonder geometry (once, at completion; plain JSON ints)

function wonderGeometry(world, w, s, civ) {
  try {
    if (w.kind === 'great_wall') w.path = wallPath(world, s, civ);
    else if (w.kind === 'grand_canal') w.path = canalPath(world, s);
    else if (w.kind === 'great_dam') w.i = damTile(world, s);
  } catch (e) {
    console.error('[civ:wonderGeometry]', e);
  }
}

const N4X = [1, -1, 0, 0], N4Y = [0, 0, 1, -1];

/**
 * The Great Wall: the realm's border tiles within 12 tiles of the city that face another
 * realm (else, for a realm with no neighbours there, the wild frontier), chained into one
 * contiguous course from end to end. ≤ 120 tiles.
 */
function wallPath(world, s, civ) {
  const { W, H, f } = world;
  const R = 12;
  const foreign = [], wild = [], coast = [], ring = [];
  for (let dy = -R; dy <= R; dy++) {
    const y = s.y + dy;
    if (y < 0 || y >= H) continue;
    for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy * dy > R * R) continue;
      const x = s.x + dx;
      if (x < 0 || x >= W) continue;
      const i = y * W + x;
      if (f.water[i] !== WATER.LAND || f.owner[i] !== civ.id) continue;
      let faceForeign = false, faceWild = false, faceSea = false;
      for (let d = 0; d < 4; d++) {
        const nx = x + N4X[d], ny = y + N4Y[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (f.water[j] !== WATER.LAND) { faceSea = true; continue; }
        const o = f.owner[j];
        if (o >= 0 && o !== civ.id) faceForeign = true;
        else if (o < 0) faceWild = true;
      }
      if (faceForeign) foreign.push(i); else if (faceWild) wild.push(i);
      else if (faceSea) coast.push(i);
      else if (dx * dx + dy * dy >= (R - 2) * (R - 2)) ring.push(i);
    }
  }
  // a realm with no march in reach walls its shore, or rings its heartland (the wonder always has a course)
  let cands = foreign.length >= 6 ? foreign : foreign.concat(wild);
  if (cands.length < 2) cands = coast.length >= 2 ? coast : ring;
  if (cands.length < 2) return null;
  return chain(world, cands, s, 120);
}

/** Order scattered tiles into one walkable course: start at an end, step to the nearest neighbour. */
function chain(world, cands, s, cap) {
  const W = world.W;
  const n = cands.length;
  const xs = new Float64Array(n), ys = new Float64Array(n);
  for (let k = 0; k < n; k++) { xs[k] = cands[k] % W; ys[k] = (cands[k] / W) | 0; }
  // start just after the widest angular gap around the city, so the course never wraps
  const ang = Array.from({ length: n }, (_, k) => [Math.atan2(ys[k] - s.y, xs[k] - s.x), k]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let gapAt = 0, gap = -1;
  for (let k = 0; k < n; k++) {
    const a0 = ang[k][0], a1 = k + 1 < n ? ang[k + 1][0] : ang[0][0] + 2 * Math.PI;
    if (a1 - a0 > gap) { gap = a1 - a0; gapAt = (k + 1) % n; }
  }
  const used = new Uint8Array(n);
  let cur = ang[gapAt][1];
  const out = [cands[cur]];
  used[cur] = 1;
  while (out.length < cap) {
    let best = -1, bd = 9.5; // at most three tiles to the next stretch
    for (let k = 0; k < n; k++) {
      if (used[k]) continue;
      const d = (xs[k] - xs[cur]) ** 2 + (ys[k] - ys[cur]) ** 2;
      if (d < bd || (d === bd && k < best)) { bd = d; best = k; }
    }
    if (best < 0) break;
    used[best] = 1;
    out.push(cands[best]);
    cur = best;
  }
  return out.length >= 2 ? out : null;
}

/** The city's river course downstream (a set of tiles), up to `max` steps. */
function downstream(world, i, max) {
  const set = new Set([i]);
  let cur = i;
  for (let k = 0; k < max; k++) {
    const nx = world.f.flowDir[cur];
    if (nx < 0 || set.has(nx)) break;
    set.add(nx);
    cur = nx;
  }
  return set;
}

/** Does river tile j drain into the city's tile within `max` steps (its own upper course)? */
function drainsTo(world, j, target, max) {
  let cur = j;
  for (let k = 0; k < max; k++) {
    if (cur === target) return true;
    cur = world.f.flowDir[cur];
    if (cur < 0) return false;
  }
  return false;
}

/**
 * The Grand Canal: a breadth-first cut across the land from the city to the nearest sea
 * coast, lake shore or other river, ≤ 60 tiles; without one in reach, the river below the
 * city is canalised instead.
 */
function canalPath(world, s) {
  const { W, H, N, f } = world;
  const MAX = 60;
  const down = downstream(world, s.i, 200);
  const prev = new Int32Array(N).fill(-2);
  const dist = new Uint8Array(N);
  const q = new Int32Array(Math.min(N, 16384));
  let qh = 0, qt = 0;
  q[qt++] = s.i; prev[s.i] = -1;
  let goal = -1;
  while (qh < qt && goal < 0) {
    const i = q[qh++];
    const d = dist[i];
    if (d >= MAX) continue;
    const x = i % W, y = (i / W) | 0;
    for (let dy = -1; dy <= 1 && goal < 0; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (prev[j] !== -2 || f.water[j] !== WATER.LAND) continue;
      prev[j] = i; dist[j] = d + 1;
      const far = d + 1 >= 4;
      if (far && (f.coast[j] || nearLakeTile(world, nx, ny))) { goal = j; break; }
      if (far && f.river[j] >= 2 && !down.has(j) && !drainsTo(world, j, s.i, 60)) { goal = j; break; }
      if (qt < q.length) q[qt++] = j;
    }
  }
  if (goal >= 0) {
    const path = [];
    for (let c = goal; c >= 0 && path.length <= MAX; c = prev[c]) path.push(c);
    path.reverse();
    return path.length >= 2 ? path : null;
  }
  const course = [...down].slice(0, 30);
  return course.length >= 2 ? course : null;
}

function nearLakeTile(world, x, y) {
  const { W, H, f } = world;
  for (let d = 0; d < 4; d++) {
    const nx = x + N4X[d], ny = y + N4Y[d];
    if (nx >= 0 && ny >= 0 && nx < W && ny < H && f.water[ny * W + nx] === WATER.LAKE) return true;
  }
  return false;
}

/** The Great Dam: the first strong river tile below the city (else the city's own reach of river). */
function damTile(world, s) {
  const f = world.f;
  let cur = s.i;
  for (let k = 0; k < 8; k++) {
    const nx = f.flowDir[cur];
    if (nx < 0 || f.water[nx] !== WATER.LAND) break;
    cur = nx;
    if (k >= 0 && f.river[cur] >= 2) return cur;
  }
  if (f.river[s.i] > 0) return s.i;
  const { W, H } = world;
  let best = -1, bv = 0;
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const x = s.x + dx, y = s.y + dy;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const i = y * W + x;
    if (f.water[i] === WATER.LAND && f.river[i] > bv) { bv = f.river[i]; best = i; }
  }
  return best >= 0 ? best : s.i;
}

/** Registered building smods for a settlement, cached by its buildings revision. */
export function buildingSmods(world, s) {
  const keys = registeredBuildingKeys();
  if (!keys.length) return null;
  const c = civCache(world);
  const cache = (c.bsm ||= {});
  const rev = s.flags?.brev | 0;
  const hit = cache[s.id];
  if (hit && hit.rev === rev && hit.n === keys.length) return hit.val;
  let val = null;
  for (const k of keys) {
    const lv = fin(s.buildings?.[k], 0);
    if (!(lv > 0)) continue;
    const sm = buildingDef(k)?.smods;
    if (!sm) continue;
    val ||= {};
    for (const m in sm) {
      const v = sm[m];
      const spec = SETTLEMENT_MOD_KEYS[m];
      if (!spec || !Number.isFinite(v)) continue;
      // add keys × level; mul keys as 1 + (v − 1) × level (contracts §6 key kinds)
      if (spec.kind === 'mul') val[m] = (val[m] ?? 1) * Math.max(0, 1 + (v - 1) * lv);
      else val[m] = (val[m] ?? 0) + v * lv;
    }
  }
  cache[s.id] = { rev, n: keys.length, val };
  return val;
}

export { BUILDINGS };
