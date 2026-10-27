// Civilization system (order 40): peoples, settlements, territory, technology,
// governments, rulers, stability and culture. See the sibling modules for each part.
//
// Daily schedule (d = day of month):
//   d = 0     civ monthly pass for every live civ (civmonth.js)
//   every d   settlements with id % 30 === d run their monthly economy (settlement.js)
//   d = 10    landscape pass (every second month): abandoned fields go wild, popDensity /
//             pollution cleanup
//   d = 15    territory, every fourth month unless a pass ran in the last 60 days (and ≥ 40
//             days after the last pass when the land itself changed: sea level, terraforming);
//             a new settlement claims the ground around it at once (territory.js claimAround)
//   Midsummer (month 6, d = 20): yearly — emergence of new peoples, habitability refresh,
//             world milestones (milestones.js), ageing of unenrolled figures (culture.js),
//             fading claims and plotting exiles (dynasty.js)
//
// Temperament (temper.js): the eight traits drift yearly with the people's history; published
// helpers temperBands / temperWords / temperShifts / TEMPER_LABELS for the UI.
// Expansion modules: dynasty.js (heirs, marriages, claims, personal unions, regencies, exiles,
// restorations; providers allied / casusBelli), acts.js (the divine acts on rulers, realms and
// towns), previews.js (pure tool previews), style.js (civ.style architecture), report.js
// (headless report). Hooks emitted (core/hooks.js catalogue): famine, tierChanged,
// depositExhausted (settlement.js), buildingCompleted, wonderBuilt, wonderDestroyed
// (buildings.js), rulerDied, succession (rulers.js), techDiscovered, eraReached (tech.js),
// figureBorn, figureDied (culture.js). Every chronicle entry carries a key and a ref.
//
// Fields this module reads from other systems when present (never required):
//   s.tradeIncome (trade) · s.disease / s.immunity (disease) · s.religion /
//   s.dominantReligion / civ.stateReligion (religion) · s.siege (war) ·
//   civ.warWeariness (war) · civ.relations (diplomacy, used for tech diffusion).
// Fields other systems rely on (kept meaningful every month):
//   settlements: population, tier, food, foodProd, foodNeed, wealth, production, housing,
//     health, happiness, unrest, loyalty, culture, defense (fortification rating ≈ 0.5
//     open village … 3+ star fort, × mods.defense), garrison (soldiers), buildings,
//     coastal, harbor, famine (consecutive hungry months), radius (catchment tiles)
//   civs: population, territory, wealth, peaks, military.manpower, military.strength (Σ of
//     its armies), mods, tech, government, ruler (traits for diplomacy/war; heir, spouse),
//     stability, legitimacy, treasury, taxRate, prestige, goldenAge / darkAge (years
//     remaining), culture, style, claims

import { on } from '../../core/hooks.js';
import { liveCivs, liveSettlements, destroySettlement, transferSettlement, endWar } from '../../core/entities.js';
import { dayOfMonth, monthOf, ensureField } from '../../core/world.js';
import { touchRecord } from '../../core/keyframe.js';
import { WATER, DAYS_PER_YEAR } from '../../core/constants.js';
import { DX8, DY8 } from '../../core/util.js';
import { newCivState, normaliseCivState, ensureCivFields, ensureSettlementFields, markTerritoryDirty, civCache, record, fin, div, pruneRateLimits, touched, adjustHistory, atWarSet } from './state.js';
import { GOVERNMENTS } from './data.js';
import { getMods, refreshMods } from './tech.js';
import { adoptGovernment, styleName } from './government.js';
import { setupRuler, noteDeed, installRuler, syncRulerDisplay, archiveRuler, endDynasty } from './rulers.js';
import { ensureStyle } from './style.js';
import { figuresYearly, figureDies } from './culture.js';
import { knowledgeYearly, upgradeKnowledge } from './knowledge.js';
import { dynastyYearly, exileOnFall, onCivFall } from './dynasty.js';
import { civReport } from './report.js';
import { roughPower } from './peoples.js';
import { computeTerritory, claimAround } from './territory.js';
import { habitGrid, updateProxies, proxies } from './land.js';
import { placeGenesis, emergence, routeMigrants } from './expansion.js';
import { updateSettlement } from './settlement.js';
import { milestonesYearly } from './milestones.js';
import { peopleWorldYear } from './peoplenews.js';
import { monthlyCiv } from './civmonth.js';
import { wondersOnDestroyed, wondersOnTransferred } from './buildings.js';
import { ensureTemper } from './temper.js';
import { theName, TheName, peopleOf, PeopleOf, placePhrase, listJoin, pick, fmtInt, agree } from './prose.js';
import './tools.js';
import './acts.js';

export { TECHS, getMods } from './tech.js';
export { TEMPER_TRAITS, TEMPER_LABELS, TEMPER_BANDS, TEMPER_CAUSES, temperBand, temperBands, temperWords, temperShifts } from './temper.js';

// ---------------------------------------------------------------------------
// System

export const system = {
  id: 'civ',
  order: 40,

  init(world) {
    // After a load everything below is rebuilt from saved state only (territory, the
    // habitability grid and the genesis soil baseline are saved), so save → load → continue
    // matches an uninterrupted run.
    const fresh = !world.sys.civ;
    if (fresh) {
      world.sys.civ = newCivState();
      habitGrid(world, true);
      const tribes = placeGenesis(world);
      computeTerritory(world);
      genesisChronicle(world, tribes);
    } else {
      normaliseCivState(world.sys.civ);
      upgradeKnowledge(world);
    }
    for (const civ of world.civs) {
      ensureCivFields(civ);
      ensureTemper(world, civ);
      ensureStyle(world, civ);
      if (!civ.alive) continue;
      if (!civ.ruler) setupRuler(world, civ);
      if (!civ.flags.styled) styleName(civ, world);
      if (fresh) refreshMods(world, civ); else getMods(world, civ);
    }
    for (const s of world.settlements) if (s.alive) ensureSettlementFields(s);
    const c = civCache(world);
    // genesis soil fertility (the recovery baseline) is a saved field
    const st = world.sys.civ;
    const soil0 = ensureField(world, 'civSoil0', Float32Array, world.N);
    if (!st.soil0Saved) { soil0.set(world.f.soil); st.soil0Saved = true; }
    c.soil0 = soil0;
    if (fresh || !world.f.civHabit) habitGrid(world, true);
    // the proxy flags judged at this month's start (saved); only a world without them judges anew
    if (fresh || !st.proxy) updateProxies(world); else proxies(world);
    touched(world);
    if (fresh || !world.f.civWaterSettle) computeTerritory(world);
  },

  update(world) {
    const st = world.sys.civ;
    if (!st) return;
    const d = dayOfMonth(world);
    if (d === 0) {
      updateProxies(world);
      for (const civ of liveCivs(world).slice()) if (civ.alive) monthlyCiv(world, civ);
    }
    const ctxs = civCtxs(world);
    const due = dueToday(world, d);
    for (let k = 0; k < due.length; k++) {
      const s = due[k];
      if (!s.alive) continue;
      const civ = world.civs[s.civId];
      if (!civ || !civ.alive) continue;
      updateSettlement(world, s, civ, ctxs.get(civ.id) || civCtx(world, civ, ctxs));
    }
    // territory: every fourth month (unless a pass ran within the last 60 days), and within
    // ~40 days of a change to the land; foundings claim their ground at once, transfers and
    // destructions update tiles in the kernel
    const sinceTerr = world.time.day - st.lastTerrDay;
    if ((d === 15 && monthOf(world) % 4 === 1 && sinceTerr >= 60) || (st.terrDirty && sinceTerr >= 40)) computeTerritory(world);
    if (d === 10 && monthOf(world) % 2 === 0) landscapePass(world);
    if (d === 20 && monthOf(world) === 6) {
      habitGrid(world, true);
      soilRecovery(world);
      emergence(world);
      milestonesYearly(world);
      peopleWorldYear(world);
      figuresYearly(world);
      dynastyYearly(world);
      knowledgeYearly(world);
      pruneRateLimits(world);
      settleIdleWars(world);
      pruneFallen(world);
    }
  },

  report(world) { return civReport(world); },
};

/**
 * Yearly: twenty years after a realm falls or a town is destroyed, it sheds the working state
 * nothing reads any more (it is saved for ever and copied into every keyframe): a fallen realm's
 * stability and capacity tallies, figure counts, levy tally, arcane pool and lapsed effects; a
 * dead town's economic potentials and lapsed effects. Identity, history, rulers, names and
 * peaks stay. Only fields no init or normaliser recreates are dropped (save → load stays equal).
 */
const SHED_DAYS = 20 * DAYS_PER_YEAR;
function pruneFallen(world) {
  const day = world.time.day;
  for (const c of world.civs) {
    if (!c || c.alive || c.flags?.shed || !(day - (c.fallenDay ?? day) >= SHED_DAYS)) continue;
    touchRecord(world, c);   // a closed record changes: keyframes copy it afresh
    const fl = c.flags || (c.flags = {});
    for (const k of ['stab', 'figureCounts', 'capacity', 'levyRaised', 'tacc', 'twhy', 'tctx', 'tlast', 'tmix', 'tmixN', 'tmet', 'tpeace']) delete fl[k];
    fl.shed = 1;
    if (c.arcane) c.arcane = undefined;   // (not saved; a delete would leave the record a slow dictionary)
    if (Array.isArray(c.effects) && c.effects.length) { c.effects = []; c.effectsV = (c.effectsV || 0) + 1; }
  }
  for (const s of world.settlements) {
    if (!s || s.alive || s.flags?.shed || !(day - (s.destroyedDay ?? day) >= SHED_DAYS)) continue;
    touchRecord(world, s);
    const fl = s.flags || (s.flags = {});
    for (const k of ['pot', 'ep', 'famPop0', 'lastSettler', 'planDay', 'emig', 'noSiteDay']) delete fl[k];
    fl.shed = 1;
    if (Array.isArray(s.effects) && s.effects.length) { s.effects = []; s.effectsV = (s.effectsV || 0) + 1; }
  }
}

/**
 * The live settlements whose monthly update falls on day-of-month d (id % 30 === d), in
 * liveSettlements order. Bucketed once per live list (the kernel replaces that array on every
 * founding, transfer and destruction), so the daily pass no longer walks every town. The
 * bucket is a snapshot of the list as it stood when the day began, exactly what iterating
 * the list itself visited: towns founded during the pass wait for next month, and towns
 * destroyed during it are skipped by the caller's alive test.
 */
function dueToday(world, d) {
  const live = liveSettlements(world);
  const c = civCache(world);
  let b = c.dueB;
  if (!b || b.src !== live) {
    const lists = [];
    for (let k = 0; k < 30; k++) lists.push([]);
    for (let k = 0; k < live.length; k++) { const s = live[k]; lists[s.id % 30].push(s); }
    b = c.dueB = { src: live, lists };
  }
  return b.lists[d];
}

/** Per-civ context for settlement updates, rebuilt each month. */
function civCtxs(world) {
  const c = civCache(world);
  const month = Math.floor(world.time.day / 30);
  if (!c.cctx || c.cctxMonth !== month) { c.cctx = new Map(); c.cctxMonth = month; }
  return c.cctx;
}
// Every field reads the civ's current state (a value captured on first use in the month would
// differ in a world reloaded mid-month, which builds its contexts afresh).
function civCtx(world, civ, map) {
  const ctx = {
    get mods() { return getMods(world, civ); },
    get era() { return fin(civ.tech?.era, 0); },
    get capital() { const s = world.settlements[civ.capitalId]; return s && s.alive ? s : null; },
    get atWar() { return atWarSet(world).has(civ.id); },
  };
  map.set(civ.id, ctx);
  return ctx;
}

/**
 * Landscape upkeep (every second month) over the sparse set of civ-touched tiles: fields outside every
 * catchment return to the wild, people leave tiles no settlement works, industrial
 * pollution disperses. Tiles that are clean again leave the set.
 */
function landscapePass(world) {
  const { W, f } = world;
  const t = touched(world);
  const S = world.settlements;
  // each settlement's catchment circle, read once (the pass changes no settlement)
  const ns = S.length;
  const live = new Uint8Array(ns), sx = new Float64Array(ns), sy = new Float64Array(ns), rr = new Float64Array(ns);
  for (let k = 0; k < ns; k++) {
    const s = S[k];
    if (!s || !s.alive) continue;
    const r = (s.radius | 0) + 0.5;
    live[k] = 1; sx[k] = s.x; sy[k] = s.y; rr[k] = r * r;
  }
  t.n = landscapeKernel(t.flag, t.list, t.n, W, f.water, f.ownerSettle, f.popDensity, f.farm, f.pollution, live, sx, sy, rr);
}
const LAND_TILE = WATER.LAND;
/** The landscape upkeep over the touched set (landscapePass); returns the set's new size. */
function landscapeKernel(flag, list, n, W, water, ownS, popD, farm, poll, live, sx, sy, rr) {
  for (let k = 0; k < n; k++) {
    const i = list[k];
    if (water[i] !== LAND_TILE) {
      popD[i] = 0; farm[i] = 0;
    } else {
      const sid = ownS[i];
      let inside = false;
      if (sid >= 0 && sid < live.length && live[sid] === 1) {
        const dx = (i % W) - sx[sid], dy = ((i / W) | 0) - sy[sid];
        inside = dx * dx + dy * dy <= rr[sid];
      }
      if (!inside) {
        const fm = farm[i];
        if (fm > 0) farm[i] = fm < 0.01 ? 0 : fm * 0.94;
        popD[i] = 0;
      }
    }
    const p = poll[i];
    if (p > 0) poll[i] = p < 0.002 ? 0 : p * 0.94;
    if (farm[i] === 0 && popD[i] === 0 && poll[i] === 0) {
      flag[i] = 0;
      list[k] = list[--n];
      k--;
    }
  }
  return n;
}

/** Without a live ecology system, exhausted soil slowly recovers toward genesis fertility (yearly). */
function soilRecovery(world) {
  if (!proxies(world).veg) return;
  const soil0 = civCache(world).soil0;
  const { N, f } = world;
  if (!soil0 || soil0.length !== N) return;
  for (let i = 0; i < N; i++) if (f.water[i] === WATER.LAND) f.soil[i] += (soil0[i] - f.soil[i]) * 0.04;
}

function genesisChronicle(world, tribes) {
  if (!tribes.length) return;
  const names = tribes.map((t) => peopleOf(t.civ));
  const n = tribes.length;
  const count = ['', 'One people', 'Two peoples', 'Three peoples', 'Four peoples', 'Five peoples', 'Six peoples', 'Seven peoples', 'Eight peoples', 'Nine peoples', 'Ten peoples', 'Eleven peoples', 'Twelve peoples'][n] || `${n} peoples`;
  record(world, { cat: 'civ', imp: 3, key: 'civ.genesis', x: tribes[0].s.x, y: tribes[0].s.y, text: `${count} walked the young world of ${world.name}: ${listJoin(names)}.` });
  for (const { civ, s } of tribes) {
    record(world, { cat: 'civ', imp: 2, key: 'civ.first_hearth', s, ref: { k: 'civ', id: civ.id }, text: pick(world, [
      `${PeopleOf(civ)} kindled their first hearths at ${s.name}, ${placePhrase(world, s.x, s.y)}.`,
      `${PeopleOf(civ)} made their first home at ${s.name}, ${placePhrase(world, s.x, s.y)}.`,
      `At ${s.name}, ${placePhrase(world, s.x, s.y)}, ${peopleOf(civ)} began their long story.`,
    ]) });
  }
}

// ---------------------------------------------------------------------------
// Hooks

on('civCreated', (world, civ) => {
  if (!world.sys.civ) return;
  ensureCivFields(civ);
  ensureTemper(world, civ);   // birth temperament (temper0) before the first ruler is drawn from it
  const parent = civ.parentId != null ? world.civs[civ.parentId] : null;
  if (parent && parent.tech) {
    for (const id in parent.tech.known) if (civ.tech.known[id] == null) { civ.tech.known[id] = parent.tech.known[id]; (civ.tech.from ||= {})[id] = `i:${parent.id}`; }
    civ.tech.era = Math.max(civ.tech.era || 0, parent.tech.era || 0);
    civ.taxRate = fin(parent.taxRate, 0.08);
    if (parent.stateReligion != null && civ.stateReligion == null) civ.stateReligion = parent.stateReligion;
  }
  if (!GOVERNMENTS[civ.government]) civ.government = 'tribe';
  adoptGovernment(world, civ, civ.government, { silent: true });
  setupRuler(world, civ);
  ensureStyle(world, civ);
  refreshMods(world, civ);
});

on('settlementCreated', (world, s) => {
  if (!world.sys.civ) return;
  ensureSettlementFields(s);
  claimAround(world, s);
  const civ = world.civs[s.civId];
  if (civ && civ.flags?.styled) styleName(civ, world);
});

on('settlementTransferred', (world, s, oldCivId, newCivId, cause) => {
  if (!world.sys.civ) return;
  ensureSettlementFields(s);
  // the kernel already moved the town's tiles to the new owner; borders settle at the next pass
  wondersOnTransferred(world, s, oldCivId, newCivId);
  const oc = world.civs[oldCivId], nc = world.civs[newCivId];
  if (s.project) {
    if (s.project.kind === 'wonder' && oc?.flags?.wonderSid === s.id) oc.flags.wonderSid = null;
    s.project = null;
  }
  const day = world.time.day;
  s.flags.grieve = 0;
  const political = cause === 'rebellion' || cause === 'secession' || cause === 'collapse' || cause === 'civil war' || cause === 'defection' || cause === 'union';
  if (oc) adjustHistory(oc, { leftShare: div(s.population, Math.max(1, fin(oc.population)), 0), dTowns: political ? -1 : 0 });
  if (nc) adjustHistory(nc, { joined: s.population, dTowns: 1 });
  // a realm retaking its own breakaway province (or a town it founded) restores order
  // rather than imposing a foreign yoke
  const reclaim = s.originCivId === newCivId
    || (oc && oc.parentId === newCivId && day - fin(oc.flags?.independence, fin(oc.foundedDay)) < 80 * DAYS_PER_YEAR);
  if (cause === 'conquest' || cause === 'capture' || cause === 'razed') {
    if (reclaim) {
      s.flags.pacified = day;
      s.flags.assim = Math.max(fin(s.flags.assim), 0.85);
      s.loyalty = Math.max(s.loyalty, 0.45);
      s.unrest = Math.min(s.unrest, 0.3);
    } else {
      s.flags.conqueredDay = day;
      s.flags.assim = Math.min(fin(s.flags.assim), 0.2);
    }
    if (nc) { nc.flags ||= {}; nc.flags.conquests = fin(nc.flags.conquests) + 1; noteDeed(nc, 'conquests'); }
    if (oc) { oc.flags ||= {}; oc.flags.losses = fin(oc.flags.losses) + 1; noteDeed(oc, 'losses'); }
    // what the rulers' epithets may remember: the town taken or lost, and from whom (a fresh
    // flags object: a crowned claimant may share its flags with the record it was copied from)
    if (nc?.ruler) nc.ruler.flags = { ...(nc.ruler.flags || {}), took: s.name, foe: oldCivId };
    if (oc?.ruler) oc.ruler.flags = { ...(oc.ruler.flags || {}), lost: s.name, foe: newCivId };
  } else if (cause === 'reconquest' || cause === 'reunification' || cause === 'treaty') {
    if (reclaim) { s.flags.pacified = day; s.loyalty = Math.max(s.loyalty, 0.45); s.unrest = Math.min(s.unrest, 0.3); }
  }
  if (s.originCivId === newCivId) s.flags.assim = 1;
  if (oc && oc.alive) {
    if (oc.flags?.capitalSid === s.id || oc.capitalId == null) { oc.legitimacy = Math.max(0, fin(oc.legitimacy) - 0.12); oc.stability = Math.max(0, fin(oc.stability) - 0.08); }
    if (oc.flags?.styled) styleName(oc, world);
  }
  if (nc && nc.alive && nc.flags?.styled) styleName(nc, world);
});

on('settlementDestroyed', (world, s, cause) => {
  if (!world.sys.civ) return;
  wondersOnDestroyed(world, s, cause);
  // the kernel already released its tiles; neighbours spread into them at the next pass
  const civ = world.civs[s.civId];
  if (civ && civ.flags?.wonderSid === s.id) civ.flags.wonderSid = null;
});

const FALL = {
  conquest: ['was conquered', 'fell to its enemies', 'was overrun'],
  razed: ['was put to the torch', 'was wiped from the map'],
  abandoned: ['faded away as its last people scattered', 'dwindled and was gone'],
  dwindled: ['faded away as its last people scattered'],
  famine: ['perished in famine'],
  vanished: ['vanished from history'],
  sea: ['was swallowed by the sea'],
  rebellion: ['was undone by rebellion'],
  'civil war': ['was destroyed by civil war'],
  defection: ['lost its last city to defectors'],
  secession: ['lost its last city to secession'],
  treaty: ['signed away its last town and passed from history'],
  lava: ['was buried beneath the lava'],
  flood: ['was swept away by the floods'],
  meteor: ['was annihilated by fire from the sky'],
  ruin: ['was ruined beyond recovery'],
  sack: ['was sacked and never recovered'],
};
/** Ends already narrated where they happened (union treaties, collapses, crushed risings). */
const SILENT_FALL = new Set(['union', 'collapse', 'reconquest', 'reunification', 'annexation']);
/** Ends the war module narrates itself ("…passed from history into the hands of…"). */
const WAR_FALL = new Set(['conquest', 'razed', 'sack']);
on('civDestroyed', (world, civ, cause) => {
  if (!world.sys.civ) return;
  // a court in exile, a broken union, the house's record, the realm's great people
  exileOnFall(world, civ, cause);
  onCivFall(world, civ);
  if (civ.ruler) {
    archiveRuler(world, civ, civ.ruler, 'fall');
    // the last ruler's reign ends with the realm (the record stays for the ledger)
    civ.ruler.reignEnd = world.time.day;
    civ.ruler.termEnd = null;
  }
  endDynasty(world, civ, cause === 'union' ? 'union' : 'fall of the realm');
  for (const fg of world.figures) if (fg && fg.died == null && fg.civId === civ.id && fg.kind !== 'prophet') figureDies(world, fg, 'fell with the realm', civ);
  if (SILENT_FALL.has(cause)) return;
  const years = Math.max(1, Math.round((world.time.day - fin(civ.foundedDay)) / DAYS_PER_YEAR));
  const verb = agree(civ, pick(world, FALL[cause] || ['was destroyed', 'passed from history']));
  const peak = fin(civ.peakPopulation);
  const big = peak >= 20000;
  // a small or young realm taken in war is already narrated by the war's own chronicle; only
  // great or ancient realms get an epitaph
  if (WAR_FALL.has(cause) && !big && years < 100) return;
  const imp = big ? 4 : years >= 60 || peak >= 4000 ? 3 : 2;
  const text = years < 15 && !big
    ? pick(world, [`The short-lived ${civ.flags?.styled ? civ.name : theName(civ)} ${verb} after only ${years} year${years === 1 ? '' : 's'}.`,
      `After barely ${years} year${years === 1 ? '' : 's'} of independence, ${theName(civ)} ${verb}.`].slice(0, civ.parentId != null ? 2 : 1))
    : `After ${years} year${years === 1 ? '' : 's'}, ${theName(civ)} ${verb}${big ? `; at its height it had ruled ${fmtInt(peak)} people` : ''}.`;
  record(world, { cat: 'civ', imp, key: 'civ.fall', x: civ.originX, y: civ.originY, civId: civ.id, ref: { k: 'civ', id: civ.id }, tags: [cause], text });
});

on('waterChanged', (world) => {
  if (!world.sys.civ) return;
  const { f, W, H } = world;
  const drowned = { lake: [], sea: [] };
  for (const s of liveSettlements(world).slice()) {
    if (!s.alive) continue;
    if (f.water[s.i] !== WATER.LAND) {
      const civ = world.civs[s.civId];
      const lake = f.water[s.i] === WATER.LAKE;
      if (civ && civ.alive && s.population > 10) routeMigrants(world, s, civ, s.population * 0.6);
      drowned[lake ? 'lake' : 'sea'].push({ s, name: s.name, pop: s.population, x: s.x, y: s.y, civId: s.civId });
      destroySettlement(world, s.id, 'sea');
      continue;
    }
    let coastal = false;
    const x = s.x, y = s.y;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX8[d], ny = y + DY8[d];
      if (nx >= 0 && ny >= 0 && nx < W && ny < H && f.water[ny * W + nx] === WATER.OCEAN) { coastal = true; break; }
    }
    s.coastal = coastal;
    if (!coastal) s.harbor = false;
  }
  // one entry per kind of flooding, however many towns it took
  for (const kind of ['lake', 'sea']) {
    const list = drowned[kind].sort((a, b) => b.pop - a.pop);
    if (!list.length) continue;
    const top = list[0], pop = list.reduce((a, d) => a + d.pop, 0);
    const names = list.length > 4 ? `${list.slice(0, 3).map((d) => d.name).join(', ')} and ${list.length - 3} more towns` : listJoin(list.map((d) => d.name));
    const text = kind === 'lake'
      ? (list.length === 1 ? `The waters rose over ${top.name}, and the town vanished beneath a new lake.`
        : pick(world, [`The waters rose over ${names}; all of them vanished beneath a new lake.`, `A new lake spread across the lowlands and drowned ${names}.`]))
      : (list.length === 1 ? pick(world, [`The rising sea swallowed ${top.name}; its people fled inland.`, `${top.name} was lost beneath the waves as the sea crept in.`])
        : pick(world, [`The rising sea swallowed ${names}; their people fled inland.`, `As the sea crept in, ${names} were lost beneath the waves.`]));
    record(world, { cat: 'disaster', imp: pop >= 20000 || list.length >= 4 ? 4 : 3, key: 'settlement.drowned', x: top.x, y: top.y, sid: top.s.id, civId: top.civId, ref: { k: 'settlement', id: top.s.id }, tags: [kind], text });
  }
  markTerritoryDirty(world);
});

// Civil wars this module starts end with political consequences: a crushed rising is
// reabsorbed; a victorious claimant takes the throne and reunites the realm; victorious
// loyalists restore the old order. Independence wars that the rebels survive stand.
on('warEnded', (world, war) => {
  if (!world.sys.civ || !war) return;
  if (war.cause !== 'civil war' && war.cause !== 'independence') return;
  const rebel = world.civs[war.attackers?.[0]], parent = world.civs[war.defenders?.[0]];
  if (!rebel || !parent || !rebel.alive || !parent.alive || rebel.parentId !== parent.id) return;
  const out = war.outcome;
  const warRef = String(war.name || 'the war').replace(/^The /, 'the ');
  if (out === 'defenders') {
    const seat = world.settlements[rebel.capitalId];
    const back = rebel.settlementIds.slice();
    for (const sid of back) transferSettlement(world, sid, parent.id, 'reconquest');
    for (const sid of back) {
      const s = world.settlements[sid];
      if (!s || !s.alive || s.civId !== parent.id) continue;
      s.flags.pacified = world.time.day; s.flags.grieve = 0;
      s.loyalty = 0.45; s.unrest = Math.min(s.unrest, 0.3);
    }
    record(world, { cat: 'war', imp: 3, key: 'war.civil.end', civ: parent, ref: { k: 'war', id: war.id }, text: `With the end of ${warRef}, the rebels of ${seat ? seat.name : 'the provinces'} submitted, and ${theName(rebel)} was reabsorbed into ${theName(parent)}.` });
    return;
  }
  if (out !== 'attackers') return;
  if (war.cause === 'civil war' && /Succession/.test(war.name || '') && rebel.ruler) {
    const claimant = rebel.ruler;
    for (const sid of rebel.settlementIds.slice()) transferSettlement(world, sid, parent.id, 'reunification');
    const crowned = { ...claimant, deeds: { ...(claimant.deeds || {}) }, traits: (claimant.traits || []).slice() };
    installRuler(world, parent, crowned, 'deposed', { how: 'civil war' });
    if (crowned.dynasty) parent.dynasty = crowned.dynasty;
    syncRulerDisplay(crowned);
    parent.legitimacy = 0.55;
    const cap = world.settlements[parent.capitalId];
    record(world, { cat: 'war', imp: 3, key: 'war.civil.end', civ: parent, ref: { k: 'war', id: war.id }, tags: ['civil-war'], text: `Victorious in ${warRef}, ${crowned.display} was crowned${cap ? ' at ' + cap.name : ''}, and the realm was whole again.` });
    return;
  }
  if (war.cause === 'civil war' && /Revolution/.test(war.name || '')) {
    for (const sid of parent.settlementIds.slice()) transferSettlement(world, sid, rebel.id, 'reunification');
    record(world, { cat: 'war', imp: 3, key: 'war.civil.end', civ: rebel, ref: { k: 'war', id: war.id }, text: `The loyalists triumphed in ${warRef}, and the old order was restored as ${theName(rebel)}.` });
  }
});

/**
 * Wars this module started (civil wars, wars of independence) are fought by the war
 * system. If none is running — no battles and no armies after 25 years — settle them here
 * by relative strength so divided realms do not stay frozen forever.
 */
function settleIdleWars(world) {
  const day = world.time.day;
  for (const war of world.wars) {
    if (!war.active || (war.cause !== 'civil war' && war.cause !== 'independence')) continue;
    if (day - fin(war.startDay) < 25 * DAYS_PER_YEAR || fin(war.battles) > 0) continue;
    if (world.armies.some((a) => a.warId === war.id)) continue;
    const pa = war.attackers.reduce((a, id) => a + roughPower(world, world.civs[id]), 0);
    const pd = war.defenders.reduce((a, id) => a + roughPower(world, world.civs[id]), 0);
    const outcome = world.rng.next() * (pa + pd) < pa ? 'attackers' : 'defenders';
    const winner = world.civs[outcome === 'attackers' ? war.attackers[0] : war.defenders[0]];
    const yrs = Math.round((day - war.startDay) / DAYS_PER_YEAR);
    record(world, { cat: 'war', imp: 3, key: 'war.end', civ: winner, ref: { k: 'war', id: war.id }, text: `${war.name} ended after ${yrs} years of skirmish and siege, in victory for ${theName(winner)}.` });
    endWar(world, war.id, outcome, 15);
  }
}

on('terrainChanged', (world) => {
  if (!world.sys.civ) return;
  markTerritoryDirty(world);
});

export { TheName, theName };
/** Internals exposed for headless profiling and tests. */
export const _internal = { landscapePass, soilRecovery, civCtxs, civCtx };
