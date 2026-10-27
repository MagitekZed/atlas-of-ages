// Diplomacy (order 70): contact, opinion, treaties, alliances, vassals, tribute, betrayal.
//
// Every few months the owner grid is scanned for shared borders, and settlements within
// trade range (or sailing range, for seafaring peoples) reveal neighbours; a first meeting
// creates the relation, may carry a virgin-soil plague, and is chronicled (only peoples who
// have not met are searched, so a settled world pays almost nothing). Every other month each
// civ's opinion of every other drifts toward a target built from border tension (shared
// border length), faith (same +, different −, scaled by religiosity, tolerance and tenets,
// heresy worst of all), trade volume, treaties, decaying war grievance, ruler traits,
// government similarity, fear of stronger neighbours, the aggression trait, shared enemies
// and kinship. Treaties follow opinion and trust: non-aggression pacts, trade agreements,
// defensive alliances (dissolving when opinion sours), voluntary vassalage of the weak to
// the strong with tribute, peaceful release, and the slow annexation of small vassals (soonest
// when content) — the quiet way whole realms disappear. War (war.js) calls
// betrayal() when pacts are broken or allies abandoned, and addTribute()/setVassal() for
// peace terms. Other packages bend opinion through the ext 'opinion' providers (kinship of
// races, common foes), summed into each pair's target.
//
// Every chronicle line carries a key ('diplomacy.contact', 'pact.nap', 'pact.trade',
// 'pact.alliance', 'pact.lapse', 'diplomacy.vassal', 'diplomacy.freed', 'diplomacy.released',
// 'diplomacy.annexed', 'diplomacy.betrayal', 'divine.discord', 'divine.harmony') and a ref to
// the other realm, so the news filter can fold the routine pacts.
//
// Exports: system, civPower(world, civ), addTribute, setVassal, releaseVassal, betrayal,
//          govFamily, refreshTension, addTreaty(world, a, b, kind), ally, unally

import { chronicle } from '../../core/chronicle.js';
import { on } from '../../core/hooks.js';
import { registerTool } from '../../core/tools.js';
import {
  liveCivs, rel, hasContact, areAtWar,
  transferSettlement, endWar, addOpinion,
} from '../../core/entities.js';
import { emitFx, bumpVersion } from '../../core/world.js';
import { touchRecord } from '../../core/keyframe.js';
import { sumOf, hasProviders } from '../../core/ext.js';
import { DAYS_PER_YEAR, DAYS_PER_MONTH } from '../../core/constants.js';
import { clamp01, clamp, dist } from '../../core/util.js';
import { sharesSea } from './pathfinding.js';
import { seedContactPlague } from './disease.js';
import { faithOf } from './religion.js';
import { claimSums, claimsMonthly } from './claims.js';
import { temperOf, skillsOf, TP, SK } from '../../core/character.js';
import { debtsMonthly, housesMonthly } from './debt.js';
import { hostagesMonthly } from './terms.js';
import {
  modsOf, civById, civName, peopleOf, rulerName, rulerHas, pairKey, addTreaty, removeTreaty,
  pickOne, rateOk, pruneRates, eraOf, finite, capFirst, capitalOf, townsOf, civPopulation, hashPick, spanPhrase, countWord,
  enemySet, activeWarList,
} from './common.js';
import { civAtTile, discordTargets, harmonyTargets, discordPreview, harmonyPreview, threadFx, toolLabel, capPoint } from './previews.js';

/** Published (contracts §12): bind a and b by a treaty kind ('nap' | 'alliance' | 'trade' | …), on both sides. */
export { addTreaty };

const MONTH_DAY = 20;
const MAD_MOODS = [0, 0.2, 0.4, 0.6, 0.8, 1];
const SCAN_EVERY = 3;             // months between contact scans
const MAX_ALLIES = 3;

// ---------------------------------------------------------------------------
// State

function state(world) {
  const st = (world.sys.diplomacy ||= {});
  st.tributes ||= [];
  st.vassalSince ||= {};
  if (st.lastScan == null) st.lastScan = -1e9;
  st.contacts ||= 0;
  st.alliances ||= 0;
  st.betrayals ||= 0;
  return st;
}

// ---------------------------------------------------------------------------
// Power

/** Military and economic strength estimate (≥ 0). Cached per day for every civ at once. */
export function civPower(world, civ) {
  if (!civ || !civ.alive) return 0;
  const c = world.cache;
  if (c.civPowerDay !== world.time.day || !c.civPower) {
    c.civPower = computePowers(world);
    c.civPowerDay = world.time.day;
  }
  const p = c.civPower[civ.id];
  return finite(p) ? p : rawPower(world, civ, 0);
}

function rawPower(world, civ, field) {
  const m = modsOf(world, civ);
  const pop = civPopulation(world, civ);
  let manpower = civ.military && finite(civ.military.manpower) && civ.military.manpower > 0 ? civ.military.manpower : pop * 0.03 * m.military;
  const era = eraOf(civ);
  const stab = 0.7 + 0.3 * clamp01(finite(civ.stability) ? civ.stability : 0.6);
  const econ = Math.sqrt(Math.max(0, finite(civ.treasury) ? civ.treasury : 0)) * 3;
  const p = (manpower + field) * (1 + 0.3 * era) * stab + econ;
  return finite(p) && p > 0 ? p : 0;
}

function computePowers(world) {
  const field = {};
  for (const a of world.armies) if (finite(a.strength)) field[a.civId] = (field[a.civId] || 0) + a.strength;
  const out = [];
  const civs = liveCivs(world);
  for (const civ of civs) out[civ.id] = rawPower(world, civ, field[civ.id] || 0);
  for (const civ of civs) {
    if (civ.vassalOf != null && out[civ.vassalOf] != null) out[civ.vassalOf] += 0.3 * out[civ.id];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Government families and small helpers

export function govFamily(g) {
  const s = String(g || '').toLowerCase();
  if (/republic|democra|merchant|commonwealth|league|free cities/.test(s)) return 'republic';
  if (/theocra|holy|church/.test(s)) return 'theocracy';
  if (/dictat|junta|autocra|tyrann/.test(s)) return 'autocracy';
  if (/king|empire|imperial|feudal|monarch|constitutional|realm|sultan/.test(s)) return 'monarchy';
  if (/tribe|chief|clan|band|horde|khan/.test(s)) return 'tribal';
  return 'other';
}

/** Border tension 0..1 from shared border length relative to the smaller realm. */
export function refreshTension(world, a, b, r) {
  const border = r.border || 0;
  const small = Math.max(1, Math.min(a.territory || 0, b.territory || 0));
  const t = border / (8 + 2 * Math.sqrt(small));
  return clamp01(t);
}

// ---------------------------------------------------------------------------
// Contact

/**
 * Shared border length per civ pair over the owner grid, row by row (a kernel over the typed
 * field only, so it stays optimised: the scan ran inside contactScan, which was thrown out of
 * optimised code on almost every call).
 */
function borderCounts(owner, W, H, counts) {
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      const a = owner[i];
      if (a < 0) continue;
      if (x + 1 < W) { const b = owner[i + 1]; if (b >= 0 && b !== a) { const k = a < b ? a * 4096 + b : b * 4096 + a; counts.set(k, (counts.get(k) || 0) + 1); } }
      if (y + 1 < H) { const b = owner[i + W]; if (b >= 0 && b !== a) { const k = a < b ? a * 4096 + b : b * 4096 + a; counts.set(k, (counts.get(k) || 0) + 1); } }
    }
  }
}

function contactScan(world, st) {
  const { W, H, f } = world;
  const counts = new Map();
  borderCounts(f.owner, W, H, counts);
  const civs = liveCivs(world);
  // reset borders, then fill from the scan
  for (const c of civs) for (const k in c.relations) c.relations[k].border = 0;
  for (const [k, n] of counts) {
    const a = Math.floor(k / 4096), b = k % 4096;
    const ca = world.civs[a], cb = world.civs[b];
    if (!ca || !cb || !ca.alive || !cb.alive) continue;
    if (!hasContact(world, a, b)) meet(world, st, ca, cb, 'border', null);
    rel(world, a, b).border = n;
    rel(world, b, a).border = n;
  }
  // Peoples who have not met yet (in a settled world, usually none — then nothing below runs).
  const unmet = [];
  for (let i = 0; i < civs.length; i++) {
    const ca = civs[i];
    if (!ca.settlementIds.length) continue;
    for (let j = i + 1; j < civs.length; j++) {
      const cb = civs[j];
      if (cb.settlementIds.length && !hasContact(world, ca.id, cb.id)) unmet.push(ca, cb);
    }
  }
  if (!unmet.length) return;
  const info = new Map();
  const infoOf = (c) => {
    let o = info.get(c.id);
    if (o) return o;
    const m = modsOf(world, c);
    const towns = townsOf(world, c).sort((p, q) => q.population - p.population);
    const nav = m.navigation, extra = finite(m.seaRange) ? m.seaRange : 0;
    o = {
      towns, top: towns.slice(0, 12),
      range: Math.min(45, Math.max(m.tradeRange * 1.5, 14 + 4 * eraOf(c))),   // hunters, herders and traders range further as ages pass
      ports: towns.filter((t) => t.coastal),
      sea: (nav >= 2 ? 70 : nav >= 1 ? 28 : 9) + extra,                       // rafts and canoes before navigation
    };
    info.set(c.id, o);
    return o;
  };
  const lm = world.f.landmass;
  // overland: explorers from a people's great towns reach the other's towns on the same land
  const overland = (ca, cb) => {
    const A = infoOf(ca), B = infoOf(cb);
    const r2 = A.range * A.range;
    for (const s of A.top) for (const n of B.towns) {
      if (lm[n.i] !== lm[s.i]) continue;
      const dx = s.x - n.x, dy = s.y - n.y;
      if (dx * dx + dy * dy <= r2) { meet(world, st, ca, cb, 'land', { s, n }); return true; }
    }
    return false;
  };
  // seafarers: ports within sailing range on a shared sea
  const bySea = (ca, cb) => {
    const A = infoOf(ca), B = infoOf(cb);
    const reach = Math.max(A.sea, B.sea);
    const sailorA = A.sea >= B.sea;
    for (const p of A.ports) for (const q of B.ports) {
      const dx = p.x - q.x, dy = p.y - q.y;
      if (dx * dx + dy * dy > reach * reach || !sharesSea(world, p.i, q.i)) continue;
      if (sailorA) meet(world, st, ca, cb, 'sea', { s: p, n: q }); else meet(world, st, cb, ca, 'sea', { s: q, n: p });
      return true;
    }
    return false;
  };
  const rest = [];
  for (let k = 0; k < unmet.length; k += 2) {
    const ca = unmet[k], cb = unmet[k + 1];
    if (overland(ca, cb) || overland(cb, ca) || bySea(ca, cb)) continue;
    rest.push(ca, cb);
  }
  // hearsay: word of a neighbour's neighbours travels with traders and envoys
  const rng = world.rng;
  const heard = (ca, cc) => {
    const capA = capitalOf(world, ca), capC = capitalOf(world, cc);
    if (!capA || !capC || dist(capA.x, capA.y, capC.x, capC.y) > 90) return false;
    let via = null, n = 0;
    for (const kb in ca.relations) {
      const rb = ca.relations[kb];
      if (!((rb.trade || 0) > 0 || (rb.border || 0) > 0)) continue;
      const cb = world.civs[kb];
      if (!cb || !cb.alive || !cb.relations[cc.id]) continue;
      n++; via ||= cb;
    }
    if (!n || !rng.chance(1 - Math.pow(0.98, n))) return false;
    meet(world, st, ca, cc, 'hearsay', { s: capA, n: capC, via });
    return true;
  };
  for (let k = 0; k < rest.length; k += 2) if (!heard(rest[k], rest[k + 1])) heard(rest[k + 1], rest[k]);
}

function meet(world, st, ca, cb, how, at) {
  const rng = world.rng;
  const ra = rel(world, ca.id, cb.id), rb = rel(world, cb.id, ca.id);
  ra.contactDay = rb.contactDay = world.time.day;
  const kin = ca.parentId === cb.id || cb.parentId === ca.id;
  const sameFaith = ca.stateReligion != null && ca.stateReligion === cb.stateReligion;
  const base = rng.normal(0, 8) + (sameFaith ? 10 : 0) + (kin ? 10 : 0);
  ra.opinion = clamp(base + rng.normal(0, 4), -100, 100);
  rb.opinion = clamp(base + rng.normal(0, 4), -100, 100);
  ra.grievance = ra.grievance || 0; rb.grievance = rb.grievance || 0;
  st.contacts++;
  if (kin || ca.settlementIds.length === 0 || cb.settlementIds.length === 0) return;
  // virgin-soil epidemics: far likelier across the sea
  const capA0 = capitalOf(world, ca), capB0 = capitalOf(world, cb);
  const apart = capA0 && capB0 && world.f.landmass[capA0.i] !== world.f.landmass[capB0.i];
  if (how !== 'hearsay' && rng.chance((apart ? 0.3 : how === 'sea' ? 0.08 : 0.015) * (world.params.plagueRate ?? 1))) {
    const flip = rng.chance(0.5);
    seedContactPlague(world, flip ? ca : cb, flip ? cb : ca);
  }
  const capA = capitalOf(world, ca), capB = capitalOf(world, cb);
  const sA = at ? at.s : capA, sB = at ? at.n : capB;
  const place = sB ? sB.name : sA ? sA.name : null;
  let text;
  if (how === 'sea') {
    text = pickOne(world, [
      `Sailors of ${civName(ca)} sighted the shores of ${civName(cb)} and put in at ${place || 'a strange harbour'}.`,
      `A ${ca.adjective} ship blown off course landed near ${place || 'an unknown shore'}, and ${peopleOf(ca)} learned of ${peopleOf(cb)}.`,
      `Across the water ${peopleOf(ca)} found a new people: ${peopleOf(cb)} of ${place || 'the far coast'}.`,
    ]);
  } else if (how === 'hearsay') {
    const via = at && at.via;
    text = pickOne(world, [
      `Merchants of ${via ? civName(via) : 'a neighbouring people'} brought word of ${civName(cb)} to the court of ${civName(ca)}.`,
      `Through ${via ? peopleOf(via) : 'their neighbours'}, ${peopleOf(ca)} learned of a distant people: ${peopleOf(cb)}.`,
    ]);
  } else if (how === 'land') {
    text = pickOne(world, [
      `Wandering traders brought word of ${civName(cb)} to the halls of ${civName(ca)}.`,
      `Explorers from ${sA ? sA.name : civName(ca)} reached ${place || 'the lands beyond'}, the first of ${peopleOf(ca)} to meet ${peopleOf(cb)}.`,
    ]);
  } else {
    text = pickOne(world, [
      `Hunters of ${civName(ca)} met strangers from ${civName(cb)} at the edge of their lands, the first meeting of the two peoples.`,
      `Scouts of ${civName(ca)} came upon the camps of ${peopleOf(cb)}${place ? ` near ${place}` : ''}, and the two peoples learned of each other.`,
      `${capFirst(peopleOf(ca))} and ${peopleOf(cb)}, long separated by wilderness, met at last${place ? ` near ${place}` : ''}.`,
    ]);
  }
  const at0 = sB || sA;
  chronicle(world, { cat: 'diplomacy', imp: how === 'hearsay' ? 1 : 2, text, x: at0 ? at0.x : null, y: at0 ? at0.y : null, civId: ca.id, sid: at0 ? at0.id : null, icon: 'contact', key: 'diplomacy.contact', ref: { k: 'civ', id: cb.id }, tags: [how] });
}

// ---------------------------------------------------------------------------
// Opinion drift

function monthlyContext(world) {
  const civs = liveCivs(world);
  const ctx = { enemies: {}, power: {}, fam: {}, rul: {}, claims: claimSums(world) };
  for (const c of civs) {
    ctx.enemies[c.id] = enemySet(world, c.id);
    ctx.power[c.id] = civPower(world, c);
    ctx.fam[c.id] = govFamily(c.government);
    // the ruler's temper, once per civ: how they see others, and how others see them
    const has = (t) => rulerHas(c, t);
    ctx.rul[c.id] = {
      self: (has('warlike') ? -8 : 0) + (has('cruel') ? -6 : 0) + (has('greedy') ? -3 : 0) + (has('just') ? 4 : 0) + (has('wise') ? 4 : 0),
      // how others see the realm: the ruler's charm, honour, mercy and skill at diplomacy (core/character.js)
      seen: (has('charismatic') ? 6 : 0) + (c.ruler ? seenBy(world, c) : 0),
      mad: has('mad'), pious: has('pious'), craven: has('craven'),
    };
  }
  return ctx;
}

/** How a ruler's honour, mercy and diplomacy colour others' view of the realm (about −8 to +12). */
function seenBy(world, c) {
  const tp = temperOf(c.ruler, c), sk = skillsOf(c.ruler, world.time.day);
  return 8 * (tp[TP.HON] - 0.5) + 8 * Math.min(0, tp[TP.MER] - 0.3) + 14 * (sk[SK.DIP] - 0.35);
}

function targetOpinion(world, a, b, r, ctx) {
  const ta = a.traits || {}, tb = b.traits || {};
  let T = 0;
  // borders
  r.tension = refreshTension(world, a, b, r);
  T -= 28 * r.tension * (0.6 + 0.5 * (ta.aggression ?? 0.5) + 0.3 * (ta.expansion ?? 0.5));
  // faith
  const fa = faithOf(world, a.stateReligion), fb = faithOf(world, b.stateReligion);
  if (fa && fb) {
    let rf = (0.4 + (ta.religiosity ?? 0.5)) * Math.min(2, world.params.religiosity ?? 1);
    if (ctx.rul[a.id]?.pious) rf *= 1.4;
    if (fa.id === fb.id) T += 18 * rf;
    else {
      let h = 16 * rf * (1 - 0.6 * (ta.tolerance ?? 0.5));
      if (fa.tenets.includes('militant')) h *= 1.5;
      if (fa.tenets.includes('tolerant')) h *= 0.4;
      if (fa.parentId === fb.id || fb.parentId === fa.id) h *= 1.4;   // heresy
      T -= h;
    }
  }
  // commerce
  T += 22 * (1 - Math.exp(-(r.trade || 0) / 25));
  // treaties
  const tr = r.treaties || [];
  if (tr.includes('alliance')) T += 22;
  if (tr.includes('nap')) T += 8;
  if (tr.includes('trade')) T += 6;
  if (a.vassalOf === b.id) T -= 8;
  if (b.vassalOf === a.id) T += 10;
  if (tr.includes('tribute')) T -= 6;
  // old wounds, and lost towns b holds that a still claims (claims.js)
  T -= (r.grievance || 0) * 0.6;
  const cl = ctx.claims.get(a.id);
  if (cl && cl[b.id]) T -= Math.min(25, 10 * cl[b.id]);
  // rulers
  const ra = ctx.rul[a.id], rb = ctx.rul[b.id];
  if (ra) {
    T += ra.self;
    if (ra.mad) T += (hashPick(MAD_MOODS, Math.floor(world.time.day / DAYS_PER_YEAR), a.id, b.id) - 0.5) * 40;
  }
  if (rb) T += rb.seen;
  // government
  const fA = ctx.fam[a.id], fB = ctx.fam[b.id];
  if (fA === fB && fA !== 'tribal' && fA !== 'other') T += 6;
  else if ((fA === 'republic' && fB === 'monarchy') || (fA === 'monarchy' && fB === 'republic') || fA === 'theocracy' || fB === 'theocracy') T -= 4;
  // fear and contempt
  const pa = ctx.power[a.id] || 1, pb = ctx.power[b.id] || 0;
  const ratio = pb / Math.max(1, pa);
  if (ratio > 1.4 && (r.border || 0) > 0) T -= Math.min(18, (ratio - 1.4) * 6) * (0.5 + (tb.aggression ?? 0.5));
  if (ra && ra.craven && ratio > 1.2) T += 6;
  if (ratio < 0.35 && (ta.aggression ?? 0.5) > 0.6) T -= 6;
  // temperament
  T -= ((ta.aggression ?? 0.5) - 0.45) * 22;
  // shared enemies, attacked friends
  const ea = ctx.enemies[a.id], eb = ctx.enemies[b.id];
  if (ea && eb) {
    for (const e of ea) if (eb.has(e)) { T += 20; break; }
    for (const al of a.allies || []) if (eb.has(al)) { T -= 15; break; }
  }
  if (a.parentId === b.id || b.parentId === a.id) T += 6;
  // what other packages know of these two (kinship of races, a common foe …)
  if (hasProviders('opinion')) T += sumOf('opinion', world, a, b);
  if (areAtWar(world, a.id, b.id)) T = Math.min(T, -55);
  if (T > 0) T *= 1 - 0.4 * (ta.isolation ?? 0);
  return clamp(T, -100, 100);
}

/**
 * Opinion and trust relax toward their targets. Each pair is revisited every other month
 * (alternating by pair), taking two months' step; both directions of a pair move together.
 */
function drift(world, ctx) {
  const rng = world.rng;
  const day = world.time.day;
  const parity = Math.floor(day / DAYS_PER_MONTH) & 1;
  for (const a of liveCivs(world)) {
    for (const k in a.relations) {
      const bid = +k;
      if (((a.id + bid) & 1) !== parity) continue;
      const b = world.civs[bid];
      if (!b || !b.alive) continue;
      const r = a.relations[k];
      const T = targetOpinion(world, a, b, r, ctx);
      let o = finite(r.opinion) ? r.opinion : 0;
      o += (T - o) * 0.0975 + rng.normal(0, 1.7);
      r.opinion = clamp(o, -100, 100);
      r.grievance = finite(r.grievance) ? r.grievance * 0.988 : 0;
      if (r.grievance < 0.05) r.grievance = 0;
      // trust: earned by long peace and kept treaties, lost in war
      let tt = 0.45 + (r.treaties || []).length * 0.08 + (r.opinion > 30 ? 0.1 : 0);
      if (r.lastWarDay >= 0 && day - r.lastWarDay < 30 * DAYS_PER_YEAR) tt -= 0.15;
      if (areAtWar(world, a.id, bid)) tt = 0.05;
      r.trust = clamp01((finite(r.trust) ? r.trust : 0.5) + (tt - r.trust) * 0.059);
    }
  }
}

// ---------------------------------------------------------------------------
// Treaties

function treaties(world, st, ctx) {
  const rng = world.rng;
  const day = world.time.day;
  for (const a of liveCivs(world)) {
    for (const k in a.relations) {
      const bid = +k;
      if (bid <= a.id) continue;
      const b = world.civs[bid];
      if (!b || !b.alive) continue;
      const ra = a.relations[k], rb = rel(world, bid, a.id);
      const oa = ra.opinion, ob = rb.opinion;
      const atWar = areAtWar(world, a.id, bid);
      const tr = ra.treaties || (ra.treaties = []);
      if (atWar) {
        for (const t of ['nap', 'alliance', 'trade']) if (tr.includes(t)) { removeTreaty(world, a.id, bid, t); if (t === 'alliance') unally(a, b); }
        continue;
      }
      // non-aggression pacts
      if (tr.includes('nap') && day > (ra.napUntil ?? 0)) removeTreaty(world, a.id, bid, 'nap');
      else if (!tr.includes('nap') && oa >= 20 && ob >= 20 && ra.trust >= 0.45 && rb.trust >= 0.45 && rng.chance(0.02)) {
        addTreaty(world, a.id, bid, 'nap');
        ra.napUntil = rb.napUntil = day + Math.round((15 + rng.next() * 15) * DAYS_PER_YEAR);
        if (rateOk(world, `nap${pairKey(a.id, bid)}`, 40 * DAYS_PER_YEAR)) note(world, a, b, 1, pickOne(world, [
          `${capFirst(civName(a))} and ${civName(b)} swore a pact of peace${placeClause(world, a, b)}.`,
          `Envoys of ${civName(a)} and ${civName(b)} exchanged oaths of non-aggression${placeClause(world, a, b)}.`,
          `${capFirst(peopleOf(a))} and ${peopleOf(b)} buried a sword between their lands as a pledge of peace.`,
        ]), 'pact.nap');
      }
      // trade agreements
      if (tr.includes('trade') && Math.min(oa, ob) < -15) removeTreaty(world, a.id, bid, 'trade');
      else if (!tr.includes('trade') && (ra.trade || 0) >= 8 && oa >= 5 && ob >= 5 && rng.chance(0.05)) {
        addTreaty(world, a.id, bid, 'trade');
        if (rateOk(world, `tra${pairKey(a.id, bid)}`, 40 * DAYS_PER_YEAR)) note(world, a, b, 1, pickOne(world, [
          `${capFirst(civName(a))} and ${civName(b)} signed a compact of free trade, lowering their tolls to each other's merchants.`,
          `The merchants of ${civName(a)} and ${civName(b)} won a compact of trade: their caravans would pass each other's toll-gates free.`,
        ]), 'pact.trade');
      }
      // defensive alliances
      const allied = tr.includes('alliance');
      if (allied && Math.min(oa, ob) < 8 && day > Math.max(ra.allyUntil ?? 0, rb.allyUntil ?? 0)) {
        removeTreaty(world, a.id, bid, 'alliance');
        unally(a, b);
        note(world, a, b, 2, pickOne(world, [
          `The alliance between ${civName(a)} and ${civName(b)} withered amid mutual suspicion.`,
          `${capFirst(civName(a))} and ${civName(b)} let their old alliance lapse, each blaming the other.`,
        ]), 'pact.lapse');
      } else if (!allied && oa >= 18 && ob >= 18 && ra.trust >= 0.42 && rb.trust >= 0.42
        && (a.allies || []).length < MAX_ALLIES && (b.allies || []).length < MAX_ALLIES
        && a.vassalOf == null && b.vassalOf == null && reasonToAlly(world, a, b, ctx) && rng.chance(0.035)) {
        addTreaty(world, a.id, bid, 'alliance');
        ally(a, b);
        st.alliances++;
        const ra2 = rulerName(a), rb2 = rulerName(b);
        note(world, a, b, 2, pickOne(world, [
          `${capFirst(civName(a))} and ${civName(b)} bound themselves in a defensive alliance${placeClause(world, a, b)}.`,
          ra2 && rb2 ? `${ra2} of ${civName(a)} and ${rb2} of ${civName(b)} sealed an alliance with oaths and the exchange of hostages.` : `${capFirst(peopleOf(a))} and ${peopleOf(b)} swore to stand together against any foe.`,
          `Fearing the same enemies, ${civName(a)} and ${civName(b)} became allies.`,
        ]), 'pact.alliance');
      }
      // voluntary vassalage of the weak to the strong
      if (a.vassalOf == null && b.vassalOf == null && (ra.border || 0) > 0) {
        const pa = ctx.power[a.id] || 0, pb = ctx.power[bid] || 0;
        const [weak, strong, ow, os] = pa < pb ? [a, b, oa, ob] : [b, a, ob, oa];
        const pw = Math.min(pa, pb), ps = Math.max(pa, pb);
        if (pw < 0.2 * ps && weak.settlementIds.length <= 4 && strong.settlementIds.length >= 2 && ow > -10 && os > -25
          && !hasVassals(world, weak.id)) {
          const threatened = ctx.enemies[weak.id]?.size > 0 || (strong.traits?.aggression ?? 0.5) > 0.6;
          if (rng.chance(0.004 * (threatened ? 2.5 : 1) * (1.2 - (weak.traits?.aggression ?? 0.5)))) setVassal(world, weak.id, strong.id, 'submission');
        }
      }
    }
  }
}

function hasVassals(world, id) {
  for (const c of liveCivs(world)) if (c.vassalOf === id) return true;
  return false;
}

function reasonToAlly(world, a, b, ctx) {
  const ea = ctx.enemies[a.id], eb = ctx.enemies[b.id];
  if (ea && eb) for (const e of ea) if (eb.has(e)) return true;
  if (a.stateReligion != null && a.stateReligion === b.stateReligion) return true;
  // a common threat: a stronger third power that one of them fears
  const pmax = Math.max(ctx.power[a.id] || 0, ctx.power[b.id] || 0);
  for (const k in a.relations) {
    const cid = +k;
    if (cid === b.id) continue;
    const c = world.civs[cid];
    if (!c || !c.alive || (ctx.power[cid] || 0) < pmax * 0.8) continue;
    const ra = a.relations[k], rb = b.relations[k];
    if ((ra.opinion < -10 && (ra.border || 0) > 0) || (rb && rb.opinion < -10 && (rb.border || 0) > 0)) return true;
  }
  return false;
}

/** Bind a and b as allies (both lists; the treaty is addTreaty's). */
export function ally(a, b) {
  a.allies ||= []; b.allies ||= [];
  if (!a.allies.includes(b.id)) a.allies.push(b.id);
  if (!b.allies.includes(a.id)) b.allies.push(a.id);
}
/** Unbind two allies (both lists). */
export function unally(a, b) {
  if (a.allies) a.allies = a.allies.filter((x) => x !== b.id);
  if (b.allies) b.allies = b.allies.filter((x) => x !== a.id);
}

function placeClause(world, a, b) {
  const ca = capitalOf(world, a), cb = capitalOf(world, b);
  const s = world.rng.chance(0.5) ? ca : cb;
  return s ? ` at ${s.name}` : '';
}

function note(world, a, b, imp, text, key) {
  const s = capitalOf(world, a) || capitalOf(world, b);
  return chronicle(world, { cat: 'diplomacy', imp, text, x: s ? s.x : null, y: s ? s.y : null, civId: a.id, sid: s ? s.id : null, icon: 'diplomacy', key, ref: { k: 'civ', id: b.id } });
}

// ---------------------------------------------------------------------------
// Vassals and tribute

/** Does a realm's styled name take a plural verb ("the Vaunian Clans were…")? */
const pluralName = (civ) => Boolean(civ && /\b(Tribes|Clans|Cities|Provinces)\b|^People of\b/.test(civ.name || ''));

/** Make vassalId a vassal of overlordId. cause: 'submission' | 'conquest' | string. */
export function setVassal(world, vassalId, overlordId, cause = 'submission') {
  const v = civById(world, vassalId), o = civById(world, overlordId);
  if (!v || !o || !v.alive || !o.alive || vassalId === overlordId || o.vassalOf === vassalId) return false;
  const st = state(world);
  // vassals give up their own alliances and vassals
  for (const al of (v.allies || []).slice()) { const c = civById(world, al); if (c) { unally(v, c); removeTreaty(world, v.id, c.id, 'alliance'); } }
  for (const c of liveCivs(world)) if (c.vassalOf === v.id) releaseVassal(world, c.id, 'overlord fell', true);
  if (v.vassalOf != null) releaseVassal(world, v.id, 'transfer', true);
  v.vassalOf = o.id;
  addTreaty(world, v.id, o.id, 'vassal');
  st.vassalSince[v.id] = world.time.day;
  addTribute(world, v.id, o.id, null, 0);
  bumpVersion(world, 'civs');
  const capV = capitalOf(world, v);
  const text = cause === 'submission'
    ? pickOne(world, [
      `Fearing the might of ${civName(o)}, the ${govWord(v)} of ${civName(v)} bent the knee and became its vassal.`,
      `${capFirst(civName(v))} accepted the overlordship of ${civName(o)}, paying tribute in exchange for protection.`,
    ])
    : pickOne(world, [
      `Beaten in war, ${civName(v)} ${pluralName(v) ? 'were' : 'was'} made a vassal of ${civName(o)}.`,
      `${capFirst(civName(v))} swore fealty to ${civName(o)} as the price of peace.`,
    ]);
  chronicle(world, { cat: 'diplomacy', imp: 3, text, x: capV ? capV.x : null, y: capV ? capV.y : null, civId: v.id, sid: capV ? capV.id : null, icon: 'vassal', key: 'diplomacy.vassal', ref: { k: 'civ', id: o.id }, tags: [cause] });
  return true;
}

function govWord(civ) {
  const f = govFamily(civ.government);
  return f === 'tribal' ? 'chiefs' : f === 'republic' ? 'councils' : f === 'theocracy' ? 'priest-lords' : 'lords';
}

export function releaseVassal(world, vassalId, cause = 'release', quiet = false) {
  const v = civById(world, vassalId);
  if (!v || v.vassalOf == null) return;
  const o = civById(world, v.vassalOf);
  const oid = v.vassalOf;
  v.vassalOf = null;
  removeTreaty(world, vassalId, oid, 'vassal');
  const st = state(world);
  delete st.vassalSince[vassalId];
  st.tributes = st.tributes.filter((t) => !(t.from === vassalId && t.to === oid && t.vassal));
  if (!hasTributeBetween(st, vassalId, oid)) removeTreaty(world, vassalId, oid, 'tribute');
  bumpVersion(world, 'civs');
  if (quiet || !o || !o.alive || !v.alive) return;
  const capV = capitalOf(world, v);
  const text = cause === 'independence'
    ? pickOne(world, [
      `${capFirst(civName(v))} threw off the yoke of ${civName(o)} and stood free once more.`,
      `After long years of tribute, ${civName(v)} won back its freedom from ${civName(o)}.`,
    ])
    : `${capFirst(civName(o))} released ${civName(v)} from vassalage in a gesture of goodwill.`;
  chronicle(world, { cat: 'diplomacy', imp: cause === 'independence' ? 3 : 2, text, x: capV ? capV.x : null, y: capV ? capV.y : null, civId: v.id, sid: capV ? capV.id : null, icon: 'vassal', key: cause === 'independence' ? 'diplomacy.freed' : 'diplomacy.released', ref: { k: 'civ', id: o.id } });
}

function hasTributeBetween(st, a, b) {
  return st.tributes.some((t) => t.from === a && t.to === b);
}

function monthlyIncome(civ) {
  if (finite(civ.income) && civ.income > 0) return civ.income;
  return Math.max(1, (civ.population || 0) * 0.002);
}

/**
 * Oblige `from` to pay `to` tribute. amount per month (null = 12% of income), years 0 = while a
 * vassal. Marks the 'tribute' treaty. Returns the tribute record { from, to, amount, … }.
 */
export function addTribute(world, from, to, amount = null, years = 15) {
  const a = civById(world, from), b = civById(world, to);
  if (!a || !b || !a.alive || !b.alive) return;
  const st = state(world);
  const amt = finite(amount) && amount > 0 ? amount : monthlyIncome(a) * 0.12;
  const t = { from, to, amount: amt, start: world.time.day, until: years > 0 ? world.time.day + Math.round(years * DAYS_PER_YEAR) : null, vassal: years <= 0 };
  st.tributes.push(t);
  addTreaty(world, from, to, 'tribute');
  return t;
}

function tributes(world, st) {
  const day = world.time.day;
  const keep = [], dropped = [];
  for (const t of st.tributes) {
    const a = world.civs[t.from], b = world.civs[t.to];
    const vassalOk = !t.vassal || (a && a.vassalOf === t.to);
    if (!a || !b || !a.alive || !b.alive || !vassalOk || (t.until != null && day > t.until)) { dropped.push(t); continue; }
    keep.push(t);
    if (areAtWar(world, t.from, t.to)) continue;          // no tribute flows across a battle line
    if (t.vassal) t.amount = monthlyIncome(a) * 0.12;
    const pay = Math.min(t.amount, Math.max(0, finite(a.treasury) ? a.treasury : 0) * 0.5);
    if (pay > 0) { a.treasury -= pay; b.treasury = (finite(b.treasury) ? b.treasury : 0) + pay; }
    const r = rel(world, t.from, t.to);
    r.grievance = Math.min(100, (r.grievance || 0) + 0.25);
  }
  st.tributes = keep;
  for (const t of dropped) {
    if (keep.some((x) => x.from === t.from && x.to === t.to)) continue;
    if (world.civs[t.from] && world.civs[t.to]) removeTreaty(world, t.from, t.to, 'tribute');
  }
}

function vassalUpkeep(world, st, ctx) {
  const rng = world.rng;
  const day = world.time.day;
  for (const v of liveCivs(world)) {
    if (v.vassalOf == null) continue;
    const o = world.civs[v.vassalOf];
    if (!o || !o.alive) { releaseVassal(world, v.id, 'overlord fell', true); continue; }
    if (st.vassalSince[v.id] == null) st.vassalSince[v.id] = day;
    const years = (day - st.vassalSince[v.id]) / DAYS_PER_YEAR;
    const rv = rel(world, v.id, o.id), ro = rel(world, o.id, v.id);
    // peaceful release by a fond overlord
    if (ro.opinion > 60 && rv.opinion > 30 && rng.chance(0.0015)) { releaseVassal(world, v.id, 'release'); continue; }
    // a small vassal is slowly drawn into its overlord's realm: soonest when content, though
    // even a resentful one may be swallowed after generations of tribute
    const pv = ctx.power[v.id] || 0, po = ctx.power[o.id] || 1;
    if (years > 25 && pv < 0.3 * po && v.settlementIds.length <= 5) {
      const mood = rv.opinion > 20 ? 1 : rv.opinion > -20 ? 0.5 : 0.15;
      if (rng.chance(0.0025 * Math.min(3, years / 25) * mood * (v.settlementIds.length <= 2 ? 1.5 : 1))) annex(world, v, o, years, mood >= 1);
    }
  }
}

function annex(world, v, o, years, willing = true) {
  const capV = capitalOf(world, v);
  const name = civName(v);
  const big = v.settlementIds.length >= 3 || civPopulation(world, v) > 20000;
  const text = willing
    ? pickOne(world, [
      `After ${spanPhrase(years * DAYS_PER_YEAR)} of vassalage, ${name} was peacefully absorbed into ${civName(o)}.`,
      `The last ${govWord(v)} of ${name} surrendered their seals to ${civName(o)}, and ${peopleOf(v)} became its subjects.`,
    ])
    : pickOne(world, [
      `${capFirst(civName(o))} deposed the ${govWord(v)} of ${name} and annexed the vassal realm outright after ${spanPhrase(years * DAYS_PER_YEAR)} of tribute.`,
      `Its tribute long unpaid and its ${govWord(v)} cowed, ${name} was swallowed by ${civName(o)}.`,
    ]);
  chronicle(world, { cat: 'diplomacy', imp: big ? 3 : 2, text, x: capV ? capV.x : null, y: capV ? capV.y : null, civId: o.id, sid: capV ? capV.id : null, icon: 'vassal', key: 'diplomacy.annexed', ref: { k: 'civ', id: v.id } });
  for (const sid of v.settlementIds.slice()) transferSettlement(world, sid, o.id, 'annexation');
}

// ---------------------------------------------------------------------------
// Betrayal

/** Record a betrayal. kind: 'nap' | 'alliance' | 'abandon' | 'vassal'. */
export function betrayal(world, betrayerId, victimId, kind = 'nap') {
  const a = civById(world, betrayerId), b = civById(world, victimId);
  if (!a || !b) return;
  const st = state(world);
  st.betrayals++;
  const r = rel(world, victimId, betrayerId);
  r.opinion = clamp((r.opinion || 0) - 40, -100, 100);
  r.trust = 0.05;
  r.grievance = Math.min(100, (r.grievance || 0) + 35);
  // every court that knows the betrayer remembers
  for (const c of liveCivs(world)) {
    if (c.id === betrayerId || c.id === victimId || !c.relations[betrayerId]) continue;
    const rc = c.relations[betrayerId];
    rc.opinion = clamp(rc.opinion - 8, -100, 100);
    rc.trust = clamp01((rc.trust ?? 0.5) * 0.8);
  }
  for (const t of ['nap', 'alliance', 'trade']) removeTreaty(world, betrayerId, victimId, t);
  unally(a, b);
  const cap = capitalOf(world, b) || capitalOf(world, a);
  const ra = rulerName(a);
  let text;
  if (kind === 'nap') text = pickOne(world, [
    `${capFirst(civName(a))} broke its sworn pact of peace with ${civName(b)}, and every court of the world marked the treachery.`,
    `${ra ? `${ra} of ${civName(a)}` : capFirst(civName(a))} tore up the oaths of peace with ${civName(b)} before the ink was old.`,
  ]);
  else if (kind === 'alliance') text = `${capFirst(civName(a))} turned its spears on its own ally ${civName(b)}, a betrayal sung of for generations.`;
  else if (kind === 'abandon') text = pickOne(world, [
    `${capFirst(civName(a))} ignored the summons of its ally ${civName(b)}, and the old alliance died in bitterness.`,
    `When ${civName(b)} called for aid, ${civName(a)} found reasons to stay at home; the alliance did not survive the insult.`,
  ]);
  else return;   // a vassal's rising is told by the declaration of its war
  chronicle(world, { cat: 'diplomacy', imp: 3, text, x: cap ? cap.x : null, y: cap ? cap.y : null, civId: a.id, sid: cap ? cap.id : null, icon: 'betrayal', key: 'diplomacy.betrayal', ref: { k: 'civ', id: b.id }, tags: [kind] });
}

// ---------------------------------------------------------------------------
// System

export const system = {
  id: 'diplomacy',
  order: 70,
  init(world) {
    const st = state(world);
    // ally lists must be symmetric and alive
    for (const c of world.civs) {
      if (!Array.isArray(c.allies)) c.allies = [];
      c.allies = c.allies.filter((id) => world.civs[id] && world.civs[id].alive && id !== c.id);
      for (const k in c.relations) {
        const r = c.relations[k];
        if (!Array.isArray(r.treaties)) r.treaties = [];
        if (!finite(r.opinion)) r.opinion = 0;
        if (!finite(r.trust)) r.trust = 0.5;
      }
    }
    st.tributes = st.tributes.filter((t) => world.civs[t.from] && world.civs[t.to]);
  },
  update(world) {
    const day = world.time.day;
    if (day % DAYS_PER_MONTH !== MONTH_DAY) return;
    const st = state(world);
    const month = Math.floor(day / DAYS_PER_MONTH);
    if (month - st.lastScan >= SCAN_EVERY) { contactScan(world, st); st.lastScan = month; }
    const ctx = monthlyContext(world);
    drift(world, ctx);
    treaties(world, st, ctx);
    tributes(world, st);
    vassalUpkeep(world, st, ctx);
    claimsMonthly(world, st);
    debtsMonthly(world, st);
    housesMonthly(world);
    hostagesMonthly(world);
    if (month % 12 === 7) {
      pruneRelations(world);
      // rate-limit keys outlive their purpose once older than the longest limit (120 years,
      // the world war), so pruning past that age changes nothing but the save
      pruneRates(world, 120 * DAYS_PER_YEAR);
    }
  },
};

/**
 * Relations with peoples gone for 20 years are forgotten (live civs only), and the fallen
 * keep no relations at all: relation maps would otherwise grow with every civ ever born.
 */
function pruneRelations(world) {
  const day = world.time.day;
  for (const c of world.civs) {
    if (!c.alive) {
      if (c.fallenDay != null && day - c.fallenDay > 20 * DAYS_PER_YEAR && Object.keys(c.relations).length) { c.relations = {}; touchRecord(world, c); }
      continue;
    }
    for (const k in c.relations) {
      const o = world.civs[k];
      if (!o || (!o.alive && o.fallenDay != null && day - o.fallenDay > 20 * DAYS_PER_YEAR)) delete c.relations[k];
    }
  }
}

// A people born of another (secession, civil war, fragments) already knows its parent's
// world: it inherits the parent's contacts, with half the parent's feelings either way.
on('civCreated', (world, civ) => {
  if (!civ || civ.parentId == null) return;
  const parent = world.civs[civ.parentId];
  if (!parent) return;
  const day = world.time.day;
  const pr = rel(world, civ.id, parent.id), rp = rel(world, parent.id, civ.id);
  pr.contactDay = rp.contactDay = day;
  for (const k in parent.relations) {
    const other = world.civs[k];
    if (!other || !other.alive || other.id === civ.id) continue;
    const src = parent.relations[k];
    const back = other.relations[parent.id];
    const a = rel(world, civ.id, other.id), b = rel(world, other.id, civ.id);
    a.opinion = clamp((src.opinion || 0) * 0.5, -100, 100);
    b.opinion = clamp(((back && back.opinion) || 0) * 0.5, -100, 100);
    a.grievance = (src.grievance || 0) * 0.5;
    b.grievance = ((back && back.grievance) || 0) * 0.5;
    a.contactDay = b.contactDay = day;
  }
});

// Dead civs: drop their tributes; their vassals go free (the kernel clears vassalOf).
on('civDestroyed', (world, civ) => {
  if (!civ) return;
  const st = state(world);
  st.tributes = st.tributes.filter((t) => t.from !== civ.id && t.to !== civ.id);
  delete st.vassalSince[civ.id];
  for (const c of world.civs) if (c.alive && c.relations[civ.id]) c.relations[civ.id].treaties = [];
});


// ---------------------------------------------------------------------------
// Tools (targets shared with their previews in previews.js)

const PLURAL = /\b(Tribes|Clans|Cities|Provinces|Isles|Lands|Peoples)\b|^People of\b/;

registerTool({
  id: 'discord', label: 'Discord', group: 'fate', icon: 'discord', order: 10, polarity: 'bane',
  desc: 'Sow hatred between the nation here and all its neighbours.',
  target: 'civ', radius: 0,
  preview: discordPreview,
  apply(world, x, y) {
    const civ = civAtTile(world, x, y);
    if (!civ || !civ.alive) return { ok: false, message: 'No nation holds this land.' };
    const list = discordTargets(world, civ);
    for (const b of list) {
      addOpinion(world, civ.id, b.id, -45);
      for (const [p, q] of [[civ.id, b.id], [b.id, civ.id]]) {
        const rr = rel(world, p, q);
        rr.grievance = Math.min(100, (rr.grievance || 0) + 25);
        rr.trust = 0.1;
      }
      for (const t of ['nap', 'alliance', 'trade']) removeTreaty(world, civ.id, b.id, t);
      unally(civ, b);
      threadFx(world, civ, b, 'hate');
    }
    const n = list.length;
    const at = capPoint(world, civ);
    emitFx(world, { type: 'curse', x: at.x, y: at.y, r: 6, src: 'tool' });
    if (!n) return { ok: true, message: `${capFirst(civName(civ))} ${PLURAL.test(civ.name || '') ? 'have' : 'has'} no neighbours to quarrel with yet.` };
    toolLabel(world, at.x, at.y, `${n} realm${n === 1 ? '' : 's'} embittered`, 'bane');
    if (rateOk(world, `discord${civ.id}`, DAYS_PER_YEAR)) {
      chronicle(world, {
        cat: 'divine', imp: 3, x: at.x, y: at.y, civId: civ.id, sid: at.sid, icon: 'discord', key: 'divine.discord', ref: { k: 'civ', id: civ.id },
        text: pickOne(world, [
          `Whispers of treachery poisoned every court around ${civName(civ)}, and old friends became enemies overnight.`,
          `An ill wind blew through ${civName(civ)}; envoys were insulted, pacts torn up, and ${countWord(n)} neighbours swore vengeance.`,
          `Forged letters and slandered envoys set ${civName(civ)} against ${n === 1 ? civName(list[0]) : `${countWord(n)} of its neighbours`}; no one could say who had begun it.`,
        ]),
      });
    }
    return { ok: true, message: `Discord sown between ${civName(civ)} and ${n} neighbour${n === 1 ? '' : 's'}.` };
  },
});

registerTool({
  id: 'harmony', label: 'Harmony', group: 'fate', icon: 'harmony', order: 20, polarity: 'boon',
  desc: 'Bring peace and goodwill to the nation here: its wars end and old grudges fade.',
  target: 'civ', radius: 0,
  preview: harmonyPreview,
  apply(world, x, y) {
    const civ = civAtTile(world, x, y);
    if (!civ || !civ.alive) return { ok: false, message: 'No nation holds this land.' };
    const { civs, wars } = harmonyTargets(world, civ);
    let ended = 0;
    for (const w of wars) {
      if (!w.active) continue;
      const inA = w.attackers.includes(civ.id), inD = w.defenders.includes(civ.id);
      if (!inA && !inD) continue;
      const side = inA ? w.attackers : w.defenders;
      if (side.length <= 1) {
        if (w.geo) { w.geo.endReason = 'divine'; w.geo.terms ||= { ceded: [], returned: [], tribute: false, vassal: false, reunified: false, divine: true }; }
        endWar(world, w.id, 'white_peace', 20);
        ended++;
      } else {
        const k = side.indexOf(civ.id);
        side.splice(k, 1);
        bumpVersion(world, 'wars');
        const other = inA ? w.defenders : w.attackers;
        const until = world.time.day + 20 * DAYS_PER_YEAR;
        for (const o of other) if (world.civs[o]) { rel(world, civ.id, o).truceUntil = until; rel(world, o, civ.id).truceUntil = until; }
        for (const a of world.armies) {
          if (a.civId !== civ.id || a.warId !== w.id) continue;
          // lift the siege it leads, or the town starves under a phantom siege until the war's monthly sweep
          const s = a.targetId != null ? world.settlements[a.targetId] : null;
          if (s && s.siege && s.siege.armyId === a.id) s.siege = null;
          a.warId = null; a.state = 'returning'; a.path = null; a.targetId = null;
        }
        ended++;
      }
    }
    for (const b of civs) {
      addOpinion(world, civ.id, b.id, 40);
      for (const [p, q] of [[civ.id, b.id], [b.id, civ.id]]) {
        const rr = rel(world, p, q);
        rr.grievance = (rr.grievance || 0) * 0.3;
        rr.trust = Math.max(rr.trust ?? 0.5, 0.6);
      }
      threadFx(world, civ, b, 'peace');
    }
    civ.warWeariness = 0;
    const at = capPoint(world, civ);
    emitFx(world, { type: 'bless', x: at.x, y: at.y, r: 6, src: 'tool' });
    if (ended) toolLabel(world, at.x, at.y, `${ended} war${ended === 1 ? '' : 's'} ended`, 'boon');
    if (rateOk(world, `harmony${civ.id}`, DAYS_PER_YEAR)) {
      chronicle(world, {
        cat: 'divine', imp: 3, x: at.x, y: at.y, civId: civ.id, sid: at.sid, icon: 'harmony', key: 'divine.harmony', ref: { k: 'civ', id: civ.id },
        text: ended
          ? pickOne(world, [
            `A great calm settled over ${civName(civ)}; its generals laid down their swords and ${countWord(ended)} war${ended === 1 ? '' : 's'} ended without another blow.`,
            `As if waking from a fever, ${peopleOf(civ)} and their enemies stopped fighting; ${countWord(ended)} war${ended === 1 ? '' : 's'} ended in a single season.`,
          ])
          : pickOne(world, [
            `Goodwill flowed from ${civName(civ)} to every neighbour, and old grudges were forgotten.`,
            `Envoys of ${civName(civ)} were feasted in every court that knew them, and old quarrels were laid to rest.`,
          ]),
      });
    }
    return { ok: true, message: ended ? `Peace: ${ended} war${ended === 1 ? '' : 's'} ended for ${civName(civ)}.` : `Goodwill spreads from ${civName(civ)}.` };
  },
});
