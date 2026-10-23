// The land deck: continental fates. Once a year (day 90) every continent's ledger is brought
// up to date (people, towns, peoples, highest era, contacts with other continents; sampled
// into sys.events.lands every ten years), and its deck rolls:
//   dark age    the continent lost a sixth of its people within fifty years, or misery (razed
//               towns, famines, plagues, collapse) piled up: culture, learning and trade sink
//               for forty years and its realms totter
//   golden age  it grew by a third in fifty years in relative peace: forty rich years
//   contact     its peoples first met a people of another continent: crops cross the sea both
//               ways (food +5 % for three centuries) and so, perhaps, does sickness
// plus the early deck's herd migrations and extinctions (decks/early.js).

import { registerEvent } from '../../../core/events.js';
import { on } from '../../../core/hooks.js';
import { liveSettlements, liveCivs } from '../../../core/entities.js';
import { BIOME, DAYS_PER_YEAR } from '../../../core/constants.js';
import { record, effect, heat, T, evState } from '../engine.js';
import { SUBJ, addHeat, spendHeat } from '../heat.js';
import { pick, say, peopleOf, PeopleOf, landFeature } from '../prose.js';

const Y = DAYS_PER_YEAR;

// ---------------------------------------------------------------------------
// Ledger

function continents(world) {
  const { W, N, f } = world;
  const out = [];
  const seen = new Set();
  for (const ft of world.features || []) {
    if (!ft || ft.kind !== 'continent') continue;
    const j = Math.round(ft.y) * W + Math.round(ft.x);
    const lm = j >= 0 && j < N && f.landmass[j] >= 0 ? f.landmass[j] : ft.landmass;
    if (lm == null || lm < 0 || seen.has(lm)) continue;
    seen.add(lm);
    out.push({ feature: ft, lm });
  }
  return out;
}

/**
 * Yearly: the transient land list for today's checks, with the saved ledger brought up to
 * date. Returns [{ feature, lm, era, pop, towns: [s], civIds: [id], hunters, contact?, peace }].
 */
export function landsYear(world) {
  const st = evState(world);
  const lands = continents(world);
  if (!lands.length) return lands;
  const byLm = new Map(lands.map((l) => [l.lm, l]));
  for (const l of lands) { l.era = 0; l.pop = 0; l.towns = []; l.civIds = []; l.hunters = 0; }
  const { f } = world;
  for (const s of liveSettlements(world)) {
    const l = byLm.get(f.landmass[s.i]);
    if (!l) continue;
    l.towns.push(s);
    l.pop += s.population;
    const civ = world.civs[s.civId];
    const era = civ?.tech?.era || 0;
    if (era > l.era) l.era = era;
    if (era <= 1) l.hunters++;
    if (!l.civIds.includes(s.civId)) l.civIds.push(s.civId);
  }
  // capitals' continents, for contact between continents
  const capLm = new Map();
  for (const c of liveCivs(world)) {
    const cs = c.capitalId != null ? world.settlements[c.capitalId] : null;
    if (cs && cs.alive && byLm.has(f.landmass[cs.i])) capLm.set(c.id, f.landmass[cs.i]);
  }
  const warring = new Set();
  for (const w of world.wars) if (w && w.active) { for (const x of w.attackers) warring.add(x); for (const x of w.defenders) warring.add(x); }
  const year = Math.floor(world.time.day / Y);
  for (const l of lands) {
    const led = (st.lands[l.lm] ||= { name: l.feature.name, pop: [], peak: 0, peakDay: 0, age: null, contact: {} });
    if (!led.contact) led.contact = {};
    if (l.pop > led.peak) { led.peak = Math.round(l.pop); led.peakDay = world.time.day; }
    if (year % 10 === 0 && (!led.pop.length || led.pop[led.pop.length - 1][0] !== year)) {
      led.pop.push([year, Math.round(l.pop)]);
      if (led.pop.length > 8) led.pop.splice(0, led.pop.length - 8);
    }
    if (led.age && !(led.age.until > world.time.day)) led.age = null;
    l.peace = l.civIds.filter((id) => warring.has(id)).length <= 1;
    l.ledger = led;
    // first meeting with a people of another continent
    for (const id of l.civIds.slice().sort((a, b) => a - b)) {
      if (capLm.get(id) !== l.lm) continue;
      const civ = world.civs[id];
      const keys = Object.keys(civ.relations).map(Number).sort((a, b) => a - b);
      for (const o of keys) {
        const lm2 = capLm.get(o);
        if (lm2 == null || lm2 === l.lm || led.contact[lm2] != null) continue;
        l.contact = { lm2, a: id, b: o };
        break;
      }
      if (l.contact) break;
    }
  }
  scanSeaContact(world, byLm);
  return lands;
}

/** The first intercontinental sea route (a pandemic of contact may ride it). */
function scanSeaContact(world, byLm) {
  const st = evState(world);
  if (st.pend.contactDone || st.pend.contact) return;
  const { f } = world;
  for (let k = world.tradeRoutes.length - 1; k >= 0; k--) {
    const r = world.tradeRoutes[k];
    if (!r || !r.active || r.kind !== 'sea') continue;
    const a = world.settlements[r.aId], b = world.settlements[r.bId];
    if (!a || !b || !a.alive || !b.alive) continue;
    const la = f.landmass[a.i], lb = f.landmass[b.i];
    if (la !== lb && byLm.has(la) && byLm.has(lb)) { st.pend.contact = { a: a.id, b: b.id, route: r.id, day: world.time.day }; return; }
  }
}
on('routeCreated', (world, r) => {
  const st = world.sys.events;
  if (!st || !r || r.kind !== 'sea' || st.pend.contactDone || st.pend.contact) return;
  const a = world.settlements[r.aId], b = world.settlements[r.bId];
  if (!a || !b) return;
  const la = world.f.landmass[a.i], lb = world.f.landmass[b.i];
  if (la === lb || la < 0 || lb < 0) return;
  const fa = landFeature(world, la), fb = landFeature(world, lb);
  if (fa && fb && fa.kind === 'continent' && fb.kind === 'continent') st.pend.contact = { a: a.id, b: b.id, route: r.id, day: world.time.day };
});

// misery: what drags a continent toward a dark age
on('settlementDestroyed', (world, s) => {
  if (!s || !world.sys.events) return;
  const lm = world.f.landmass[s.i];
  if (lm >= 0) addHeat(world, 'misery', SUBJ.land(lm), s.tier >= 3 ? 0.35 : 0.15);
});
on('plagueEnded', (world, p) => {
  if (!p || !world.sys.events || !(p.deaths > 0)) return;
  const s = world.settlements[p.originSid];
  if (!s) return;
  const lm = world.f.landmass[s.i];
  const share = p.deaths / Math.max(1, p.worldPopAtStart || p.deaths * 20);
  if (lm >= 0 && share >= 0.02) addHeat(world, 'misery', SUBJ.land(lm), Math.min(1, share * 8));
});

// ---------------------------------------------------------------------------
// Defs

function popAgo(l, years) {
  const led = l.ledger;
  if (!led || !led.pop.length) return null;
  const want = led.pop[led.pop.length - 1][0] - years;
  let best = null;
  for (const [y, p] of led.pop) if (y <= want + 5) best = p;
  return best;
}
function peakRecent(l, years) {
  const led = l.ledger;
  if (!led || !led.pop.length) return 0;
  const last = led.pop[led.pop.length - 1][0];
  let m = 0;
  for (const [y, p] of led.pop) if (y >= last - years) m = Math.max(m, p);
  return m;
}
const biggest = (towns, n) => towns.slice().sort((a, b) => b.population - a.population || a.id - b.id).slice(0, n);

registerEvent({
  id: 'land.dark_age', scale: 'land', family: 'ages', cat: 'civ', imp: 4, cooldownYears: 120, chain: ['misery'],
  label: 'Dark age', icon: 'age', hint: ['culture −18%, learning −15%, trade −12% across the continent (40 years)', 'its realms totter'],
  weight(ctx) {
    const l = ctx.land;
    if (!l.ledger || l.ledger.age || l.towns.length < 4) return 0;
    const peak = peakRecent(l, 50);
    const fell = peak >= 3000 && l.pop <= 0.84 * peak;
    const misery = ctx.heat('misery');
    return (fell ? 0.3 : 0) + (misery >= 1.2 ? 0.2 * misery : 0);
  },
  fire(ctx) {
    const { world, land: l } = ctx;
    const towns = biggest(l.towns, 40);
    if (towns.length < 2) return false;
    const name = pick(world, [`the Dark Years of ${l.feature.name}`, `the Long Night of ${l.feature.name}`, `the Fall of ${l.feature.name}`]);
    const peak = peakRecent(l, 50);
    const lost = peak > 0 ? 1 - l.pop / peak : 0;
    const [a, b] = [towns[0], towns[towns.length - 1]];
    record(ctx, { civ: world.civs[a.civId], ref: { k: 'settlement', id: a.id }, x: l.feature.x, y: l.feature.y, text: say(world, [
      'With its cities burned and its fields untilled, {land} entered a dark age; for two generations no new temple rose between {a} and {b}.',
      '{Land} sank into {name}: {lost}the roads emptied, the scribes fell silent and the old lords of {a} ruled over ruins.',
      'The chroniclers of later ages would call it {name}: plague, war and hunger had left {land} poorer than its grandfathers had known it.',
    ], { land: l.feature.name, Land: l.feature.name, a: a.name, b: b.name, name, lost: lost >= 0.1 ? `${Math.round(lost * 100)} people in every hundred were gone, ` : '' }) });
    for (const s of towns) effect(ctx, T.s(s), 'darkyears', { culture: 0.82, research: 0.85, trade: 0.88, unrest: 0.05 }, 40, name);
    for (const id of l.civIds) {
      const c = world.civs[id];
      const cs = c && c.capitalId != null ? world.settlements[c.capitalId] : null;
      if (cs && world.f.landmass[cs.i] === l.lm) effect(ctx, T.c(c), 'darkyears', { stability: -0.06, research: -0.08 }, 30, name);
    }
    l.ledger.age = { kind: 'dark', name, from: world.time.day, until: world.time.day + 40 * Y };
    spendHeat(world, 'misery', ctx.subject, 0.8);
    return true;
  },
});

registerEvent({
  id: 'land.golden_age', scale: 'land', family: 'ages', cat: 'culture', imp: 3, cooldownYears: 150,
  label: 'Golden age', icon: 'age', hint: ['culture +20%, trade +12%, contentment across the continent (40 years)'],
  weight(ctx) {
    const l = ctx.land;
    if (!l.ledger || l.ledger.age || l.towns.length < 6 || l.pop < 15000 || !l.peace) return 0;
    const ago = popAgo(l, 50);
    return ago && l.pop >= 1.35 * ago ? 0.12 : 0;
  },
  fire(ctx) {
    const { world, land: l } = ctx;
    const towns = biggest(l.towns, 40);
    if (towns.length < 2) return false;
    const name = `the Golden Century of ${l.feature.name}`;
    const [a, b] = [towns[0], towns[1] || towns[0]];
    record(ctx, { imp: l.towns.length >= 20 ? 4 : 3, civ: world.civs[a.civId], ref: { k: 'settlement', id: a.id }, x: l.feature.x, y: l.feature.y, text: say(world, [
      'The cities of {land} had never been so rich: {a} and {b} raised temples of gilded stone, and the years that followed were remembered as {name}.',
      'Peace and full granaries made {land} the envy of the world; poets of {a} called the age {name}.',
    ], { land: l.feature.name, a: a.name, b: b.name, name }) });
    for (const s of towns) effect(ctx, T.s(s), 'goldenyears', { culture: 1.2, trade: 1.12, happiness: 0.04 }, 40, name);
    l.ledger.age = { kind: 'golden', name, from: world.time.day, until: world.time.day + 40 * Y };
    return true;
  },
});

const CROPS = (world, towns) => {
  const n = {};
  for (const s of towns.slice(0, 20)) { const b = world.f.biome[s.i]; n[b] = (n[b] || 0) + 1; }
  let best = BIOME.TEMPERATE_FOREST, bv = -1;
  for (const k in n) if (n[k] > bv) { bv = n[k]; best = Number(k); }
  switch (best) {
    case BIOME.SAVANNA: case BIOME.TROPICAL_FOREST: return ['millet and sorghum', 'yams and gourds', 'sugar cane'];
    case BIOME.RAINFOREST: case BIOME.WETLAND: return ['rice', 'cassava', 'taro and bananas'];
    case BIOME.TAIGA: case BIOME.TUNDRA: return ['rye and turnips', 'the reindeer sledge'];
    case BIOME.HOT_DESERT: case BIOME.COLD_DESERT: return ['dates', 'the camel', 'figs and pistachios'];
    case BIOME.ALPINE: return ['potatoes', 'quinoa', 'the llama'];
    case BIOME.STEPPE: return ['millet', 'the war-horse', 'buckwheat'];
    default: return ['wheat and barley', 'the plough-ox', 'apples and vines', 'maize and beans'];
  }
};
registerEvent({
  id: 'land.age_of_contact', scale: 'land', family: 'ages', cat: 'trade', imp: 4, cooldownYears: 0, luck: false,
  label: 'Age of Contact', icon: 'ship', hint: ['crops cross the sea: food +5% on both continents (300 years)', 'strange sicknesses may follow'],
  weight(ctx) {
    const c = ctx.land.contact;
    return c && ctx.land.ledger && ctx.land.ledger.contact[c.lm2] == null ? 0.5 : 0;
  },
  fire(ctx) {
    const { world, land: l } = ctx;
    const c = l.contact;
    if (!c || l.ledger.contact[c.lm2] != null) return false;
    const st = evState(world);
    const led2 = (st.lands[c.lm2] ||= { name: landFeature(world, c.lm2)?.name || 'the far shore', pop: [], peak: 0, peakDay: 0, age: null, contact: {} });
    l.ledger.contact[c.lm2] = world.time.day;
    led2.contact ||= {};
    led2.contact[l.lm] = world.time.day;
    const a = world.civs[c.a], b = world.civs[c.b];
    const towns2 = liveSettlements(world).filter((s) => world.f.landmass[s.i] === c.lm2);
    const give = pick(world, CROPS(world, l.towns)), take = pick(world, CROPS(world, towns2));
    const other = led2.name;
    record(ctx, { civ: a, x: l.feature.x, y: l.feature.y, text: say(world, [
      '{A} of {land} met {B} of {other}, and the two halves of the world touched: {give} crossed the sea one way, {take} the other.',
      'For the first time a people of {land} met a people of {other}: {a} and {B} traded {give} for {take}, and nothing would be quite the same.',
    ], { A: PeopleOf(a), a: peopleOf(a), B: peopleOf(b), land: l.feature.name, other, give, take }) });
    for (const s of biggest(l.towns, 30)) effect(ctx, T.s(s), 'crops:' + c.lm2, { foodYield: 1.05 }, 300, `Crops from ${other}`);
    for (const s of biggest(towns2, 30)) effect(ctx, T.s(s), 'crops:' + l.lm, { foodYield: 1.05 }, 300, `Crops from ${l.feature.name}`);
    heat(ctx, 'plague', 0.8, SUBJ.land(l.lm));
    heat(ctx, 'plague', 0.8, SUBJ.land(c.lm2));
    return true;
  },
});

