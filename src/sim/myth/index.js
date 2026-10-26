// Myth (order 86): the Mythic mode — races, ley lines and mana, the arcane schools, the gods'
// answers and the Fading — behind the one dial, mythLevel (core/params.js):
//   0 Historical  nothing: update returns at once, no state, no fields, no rng, every
//                 provider neutral (headless --determinism proves it)
//   1 Legendary   the folklore deck (folklore.js, run by WP1's event engine) and its yearly
//                 bookkeeping only
//   2 Mythic      everything: init wakes the myth (state, the ley network, mana fields,
//                 registries); day 12 of each month mana and civ.arcane, the gods' favour and
//                 answers; Midsummer + 20 the Fading, race milestones and folklore upkeep
// Owned by WP5 (docs/design/expansion-packages.md). Published exports (contracts §12): manaAt,
// weave, RACES (with each race's drift multiplier, RACES[r].adapt), mythPreview, the race
// helpers raceIdentity, adaptWords, raceAdapt and humanEdge (docs/design/temperament-and-names.md §2),
// and the mixed-peoples helpers (docs/design/mixed-peoples.md): townPeoples, civPeoples, landPeoples,
// worldPeoples, peoplesHistory, townPeoplesPast, PEOPLES_MIN.
// Budget: ≤ 8 ms per sim-year at level 2 (measured ≈ 5–6 at Y1000, the peoples pass ≈ 1.6).
//
// Every town of a Mythic world holds a mix of peoples (peoples.js: founding, growth, migration,
// conquest, expulsion, turning; daily, each town once a year).
//
// Providers live with their data: races.js (people, habitat, demography, lifespan, mods,
// loyalty), identity.js (nameStyle, archStyle), mana.js (vegCap, casusBelli), arcana.js
// (battle, siege, damage, opinion), folklore.js (casusBelli for prophecies), and the
// yearRecord provider below. All are registered at import and neutral below their level.

import { on } from '../../core/hooks.js';
import { registerProvider } from '../../core/ext.js';
import { liveCivs, liveSettlements } from '../../core/entities.js';
import { dayOfMonth, dayOfYear, emitFx } from '../../core/world.js';
import { hashString } from '../../core/rng.js';
import { touchRecord } from '../../core/keyframe.js';
import { RACE_META, DAYS_PER_YEAR } from '../../core/constants.js';
import { isMythic, fin, RACES, RACE_LIST, nicheReport, peopleFor, enabledRaces, mixOf, raceLabel, humanEdge, registerRaceProviders } from './races.js';
import './identity.js';
import { activateMyth, ARCANE_TECHS, ARCANE_BY_ID, SCHOOLS } from './arcana.js';
import { manaAt as manaAtImpl, manaStats, monthlyMana, leyNodes, seedArcane, mythState, arcaneKnown } from './mana.js';
import { leyTiles } from './ley.js';
import { fadingYearly } from './fading.js';
import { divineMonthly, pruneDivine } from './divine.js';
import { folkYearly, FOLK_IDS } from './folklore.js';
import { mythPreview as previewImpl } from './preview.js';
import './tools.js';
import './trades.js';
import { record, pickT, fill, placePhrase, listJoin, theName, yearOfDay } from './prose.js';
import { ensurePeoples, peoplesDaily, peoplesYearly, peoplesCounts, mixStats } from './peoples.js';

registerRaceProviders();   // the race table's providers (people, habitat, demography, lifespan, mods, loyalty)

export { RACES };
export { raceIdentity, adaptWords, raceAdapt, humanEdge } from './races.js';
export { townPeoples, civPeoples, landPeoples, worldPeoples, peoplesHistory, townPeoplesPast, PEOPLES_MIN } from './peoples.js';
/** Mana at a point (0 outside Mythic worlds). */
export const manaAt = manaAtImpl;
/** The weave of the world: 1 at genesis, thinning with industry; 0 where there is no magic. */
export const weave = (world) => (isMythic(world) && world.sys.myth?.v != null ? fin(world.sys.myth.weave, 1) : 0);
/** What the genesis plate shows for a Mythic world (pure). */
export const mythPreview = previewImpl;

const MANA_DAY = 12;            // day of the month for the mana and divine passes
const YEAR_DAY = 200;           // day of the year (Midsummer + 20) for the yearly pass

// ---------------------------------------------------------------------------
// Races at the dawn, and their fates

const DAWN = {
  human: ['{the} lit their first fires {place}', '{the} raised their first huts {place}, already restless', '{the} came wandering {place}, and stayed'],
  elf: ['{the} woke beneath the eaves {place}', '{the} sang in the old woods {place}'],
  dwarf: ['{the} delved the first halls {place}', '{the} kindled their forges {place}'],
  orc: ['{the} ran wild {place}', '{the} raised their war-camps {place}'],
  halfling: ['{the} dug the first smials {place}', '{the} sowed the first gardens {place}'],
  lizardfolk: ['{the} hatched in the warm fens {place}', '{the} built their egg-temples {place}'],
};

/** The genesis entries: the races' dawn and the ley network beneath the young world. */
function dawnChronicle(world, st) {
  const rng = world.rng;
  const firstOf = new Map();
  for (const c of liveCivs(world)) if (c.race && !firstOf.has(c.race)) firstOf.set(c.race, c);
  const clauses = [];
  for (const r of RACE_LIST) {
    const c = firstOf.get(r);
    if (!c) continue;
    const cap = c.capitalId != null ? world.settlements[c.capitalId] : null;
    const place = cap ? placePhrase(world, cap.x, cap.y) || `at ${cap.name}` : 'in the wild places';
    clauses.push(fill(pickT(rng, DAWN[r]), { the: `the ${RACE_META[r].plural} of ${c.baseName}`, place }));
  }
  let dawn = null;
  if (clauses.length) {
    const cap0 = firstOf.values().next().value;
    const cap = cap0 && cap0.capitalId != null ? world.settlements[cap0.capitalId] : null;
    // four clauses or more read better held apart by semicolons
    const body = clauses.length >= 4 ? `${clauses.slice(0, -1).join('; ')}; and ${clauses[clauses.length - 1]}` : listJoin(clauses);
    dawn = record(world, {
      imp: 3, key: 'myth.dawn', tags: ['dawn'],
      text: `In the dawn of the world ${body}`,
      x: cap?.x, y: cap?.y, civId: cap0?.id ?? null, ref: cap0 ? { k: 'civ', id: cap0.id } : null,
    });
  }
  const nodes = leyNodes(world);
  if (nodes.length) {
    const great = nodes.slice().sort((a, b) => fin(b.data?.power) - fin(a.data?.power) || a.id - b.id)[0];
    record(world, {
      imp: 2, key: 'myth.ley', tags: ['ley'], cause: dawn ? dawn.seq : null,
      text: fill(pickT(rng, [
        'Beneath the young world ran {e} ley lines, meeting at {n} places of power; the brightest was {node} {place}.',
        'Rivers of power crossed the young world, {e} of them, gathering at {n} places of power. Brightest of all burned {node} {place}.',
      ]), { e: st.ley.edges.length, n: nodes.length, node: great.name, place: placePhrase(world, great.x, great.y) || 'in the wilds' }),
      x: great.x, y: great.y, ref: { k: 'site', id: great.id },
    });
  }
}

/**
 * Live realms, towns and people of each race: civs = realms of that race, towns = towns where it
 * is the dominant people, pop = Σ population × its share in each town's mix.
 */
export function raceCensus(world) {
  const out = Object.fromEntries(RACE_LIST.map((r) => [r, { civs: 0, towns: 0, pop: 0 }]));
  for (const c of liveCivs(world)) if (c.race && out[c.race]) out[c.race].civs++;
  for (const s of liveSettlements(world)) {
    const r = s.race || world.civs[s.civId]?.race;
    if (r && out[r]) out[r].towns++;
    const p = s.peoples;
    const pop = fin(s.population);
    if (p && typeof p === 'object') {
      for (const k in p) if (out[k] && p[k] > 0) out[k].pop += pop * p[k];
    } else if (r && out[r]) out[r].pop += pop;
  }
  return out;
}

const GONE = {
  elf: ['With the fall of {last} in Year {y}, no realm of the Elves remained in the world; their songs were sung only in the halls of others.'],
  dwarf: ['When {last} fell in Year {y}, the last hold of the Dwarves was broken, and their doors were sealed behind them.'],
  orc: ['The last warband of the Orcs was scattered with {last} in Year {y}; only their war-songs, half-remembered, outlived them.'],
  halfling: ['No shire of the Halflings outlived {last}; after Year {y} their round green doors stood open on empty halls.'],
  lizardfolk: ['With {last} in Year {y} the last brood of the Lizardfolk fell silent, and the fens went back to the herons.'],
  human: [
    'In Year {y}, with {last}, the last realm of Men passed from the world.',
    'With {last} in Year {y} the last realm of Men was gone; their words lived on only in the tongues of the peoples they had traded with.',
  ],
};

/** Yearly: race milestones (first great city, first empire) and the census peak. */
function racesYearly(world) {
  const st = world.sys.myth;
  const day = world.time.day;
  for (const s of liveSettlements(world)) {
    if (s.tier < 4) continue;
    const r = s.race || world.civs[s.civId]?.race;
    if (!r || st.first[`${r}.city`] != null) continue;
    st.first[`${r}.city`] = day;
    const civ = world.civs[s.civId];
    record(world, {
      imp: 2, key: 'myth.race.city', tags: [r],
      text: fill(pickT(world.rng, [
        '{town} became the first great city of the {plural}, {what}.',
        'In Year {y} {town} grew into the first true city the {plural} had ever built, {what}.',
      ]), { town: s.name, plural: RACE_META[r].plural, y: yearOfDay(day), what: CITY_WORD[r] }),
      x: s.x, y: s.y, sid: s.id, civId: civ?.id ?? null, ref: { k: 'settlement', id: s.id },
    });
  }
  const census = raceCensus(world);
  for (const r of RACE_LIST) st.peak[r] = Math.max(fin(st.peak[r], 0), Math.round(census[r].pop));
  cosmopolisYearly(world, st);
}

// A human realm whose towns hold many peoples comes into its cosmopolitan gift (humanEdge): told
// once per realm, when other peoples first make up COSMO_TOLD of its people across at least
// three towns, and at most once every COSMO_GAP years world-wide.
const COSMO_TOLD = 0.35, COSMO_GAP = 30;
const COSMO_TEXT = [
  'Merchants, scholars and interpreters of {list} crowded the streets of {cap}; {the} had made a crossroads of the world, and grew richer and cleverer for it.',
  'In {cap} one could hear the speech of {list} in a single market morning. {The} took what each people knew and made it their own.',
  'By Year {y}, {share} of the people of {realm} were not human at all: {list} lived in its towns, and its schools and counting-houses were the better for every one of them.',
  '{The} had stopped asking where a craftsman was born: {list} worked side by side in {cap}, and the realm prospered on what they taught one another.',
];
const shareWords = (v) => (v >= 0.7 ? 'most' : v >= 0.55 ? 'more than half' : v >= 0.48 ? 'half' : v >= 0.4 ? 'two in five' : 'more than a third');
function cosmopolisYearly(world, st) {
  const day = world.time.day;
  if (st.first['human.cosmo'] != null && day - st.first['human.cosmo'] < COSMO_GAP * DAYS_PER_YEAR) return;
  for (const c of liveCivs(world)) {
    if (c.race !== 'human' || (c.settlementIds || []).length < 3 || st.first[`human.cosmo.${c.id}`] != null) continue;
    const e = humanEdge(world, c);
    if (!e || e.others < COSMO_TOLD) continue;
    const cap = c.capitalId != null ? world.settlements[c.capitalId] : null;
    if (!cap || !cap.alive) continue;
    // the peoples of the realm besides its humans, by headcount
    const heads = {};
    for (const sid of c.settlementIds) {
      const s = world.settlements[sid];
      if (!s || !s.alive || !s.peoples) continue;
      for (const r in s.peoples) if (r !== 'human') heads[r] = (heads[r] || 0) + fin(s.population) * s.peoples[r];
    }
    const others = Object.entries(heads).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3).map(([r]) => RACE_META[r].plural);
    if (!others.length) continue;
    st.first[`human.cosmo.${c.id}`] = day;
    st.first['human.cosmo'] = day;
    const list = listJoin(['Men', ...others]);
    const the = `the ${c.adjective || c.baseName}`;
    record(world, {
      imp: 2, key: 'myth.human.cosmopolis', tags: ['human', 'peoples'],
      text: fill(pickT(world.rng, COSMO_TEXT), {
        list, cap: cap.name, the, The: the.charAt(0).toUpperCase() + the.slice(1),
        y: yearOfDay(day), share: shareWords(e.others), realm: theName(c),
      }),
      x: cap.x, y: cap.y, sid: cap.id, civId: c.id, ref: { k: 'civ', id: c.id },
    });
    return;
  }
}
const CITY_WORD = {
  human: 'a crossroads of markets, smoke and a dozen tongues', elf: 'its halls woven into living trees', dwarf: 'more of it beneath the hill than above',
  orc: 'its walls hung with the banners of beaten clans', halfling: 'a hill riddled with smials and gardens', lizardfolk: 'its stilted halls rising over the warm water',
};

on('civCreated', (world, civ) => {
  if (!isMythic(world)) return;
  // every people of a Mythic world belongs to a race: a realm the civ module made without
  // asking the people provider takes the race its land favours
  if (civ.race == null) {
    const x = Math.round(fin(civ.originX)), y = Math.round(fin(civ.originY));
    const i = Math.max(0, Math.min(world.N - 1, y * world.W + x));
    const genesis = world.time.day === 0 && !(world.sys.myth && world.sys.myth.v != null);
    const p = peopleFor(world, { genesis, i, k: world.civs.length - 1 });
    if (p && p.race) civ.race = p.race;
  }
  if (world.sys.myth?.v != null) seedArcane(world, civ);
});

on('civDestroyed', (world, civ) => {
  if (!isMythic(world) || !civ || !civ.race) return;
  const st = world.sys.myth;
  if (!st || st.v == null) return;
  for (const c of liveCivs(world)) if (c.race === civ.race) return;
  for (const s of liveSettlements(world)) if (s.race === civ.race) return;   // a people may live on under another's rule
  if (st.first[`${civ.race}.gone`] != null && st.first[`${civ.race}.back`] == null) return;
  st.first[`${civ.race}.gone`] = world.time.day;
  delete st.first[`${civ.race}.back`];
  record(world, {
    imp: 4, key: 'myth.race.gone', tags: [civ.race],
    text: fill(pickT(world.rng, GONE[civ.race] || GONE.human), { last: theName(civ), y: yearOfDay(world.time.day) }),
    x: fin(civ.originX), y: fin(civ.originY), civId: civ.id, ref: { k: 'civ', id: civ.id },
  });
});

// Kinstrife: a realm born today by breaking away takes the blood of its first town. When the
// civ module did not ask the people provider for a split, this keeps elven towns that rise
// against a human crown elven (and gives a vanished people a realm of its own again).
on('settlementTransferred', (world, s, oldCivId, newCivId) => {
  if (!isMythic(world) || !s || !s.race) return;
  const st = world.sys.myth;
  if (!st || st.v == null) return;
  const civ = world.civs[newCivId], old = world.civs[oldCivId];
  if (!civ || civ.parentId == null || civ.foundedDay !== world.time.day || civ.race === s.race) return;
  if ((civ.settlementIds || []).length !== 1) return;
  let had = false;
  for (const c of liveCivs(world)) if (c.id !== civ.id && c.race === s.race) { had = true; break; }
  civ.race = s.race;
  seedArcane(world, civ);
  if (had) return;
  const gone = st.first[`${s.race}.gone`];
  record(world, {
    imp: 3, key: 'myth.kinstrife', tags: [s.race],
    text: fill(pickT(world.rng, [
      'The {plural} of {town} would bow no longer to {old}; they raised a banner of their own, and the {plural} had a realm again{since}.',
      'In Year {y} {town} broke from {old}. Its people were {plural}, and with it their kind had a crown of their own once more{since}.',
    ]), { plural: RACE_META[s.race].plural, town: s.name, old: theName(old), y: yearOfDay(world.time.day), since: gone != null ? ` for the first time since Year ${yearOfDay(gone)}` : '' }),
    x: s.x, y: s.y, sid: s.id, civId: civ.id, ref: { k: 'civ', id: civ.id },
  });
  delete st.first[`${s.race}.gone`];
});

on('settlementCreated', (world, s) => {
  if (!isMythic(world)) return;
  const st = world.sys.myth;
  const r = s.race || world.civs[s.civId]?.race;
  if (!st || st.v == null || !r || st.first[`${r}.gone`] == null || st.first[`${r}.back`] != null) return;
  st.first[`${r}.back`] = world.time.day;
  record(world, {
    imp: 3, key: 'myth.race.back', tags: [r],
    text: `In Year ${yearOfDay(world.time.day)} the ${RACE_META[r].plural} returned to the world: ${s.name} was raised ${placePhrase(world, s.x, s.y) || 'in the wild country'}`,
    x: s.x, y: s.y, sid: s.id, civId: s.civId, ref: { k: 'settlement', id: s.id },
  });
});

// Spells you can see: a rune circle at the capital when a realm learns an arcane art, and at a
// town when its mage tower rises (visual only: world.fx is never saved or read by the sim).
on('techDiscovered', (world, civ, techId) => {
  if (!isMythic(world) || !civ) return;
  const t = ARCANE_BY_ID[techId];
  const cap = t && civ.capitalId != null ? world.settlements[civ.capitalId] : null;
  if (cap) emitFx(world, { type: 'spell', x: cap.x, y: cap.y, r: 2.5, color: SCHOOLS[t.school]?.color || [180, 140, 255] });
});
on('buildingCompleted', (world, s, key) => {
  if (!isMythic(world) || !s || key !== 'magetower') return;
  emitFx(world, { type: 'spell', x: s.x, y: s.y, r: 2, color: [176, 140, 255] });
});

// ---------------------------------------------------------------------------
// Statistics

registerProvider('yearRecord', 'myth', (world) => {
  if (!isMythic(world) || world.sys.myth?.v == null) return null;
  const census = raceCensus(world);
  const races = {};
  for (const r of RACE_LIST) if (census[r].pop > 0 || census[r].civs > 0) races[r] = Math.round(census[r].pop);
  const m = manaStats(world);
  return { weave: Math.round(fin(world.sys.myth.weave, 1) * 1000) / 1000, mana: Math.round(m.mean * 1000) / 1000, races };
});

// ---------------------------------------------------------------------------
// System

/**
 * Bring the myth up in a Mythic world: at genesis (races by niche, the dawn chronicle), after a
 * load, or mid-run when mythLevel was raised without the Awaken Magic act (setParam with force:
 * the paramChanged hook below), where, as in an awakening, the peoples of the old world were
 * always human. Waking at once (not at the next myth update) keeps a world saved or keyframed
 * right after the change equal to the running one.
 */
function wake(world) {
  world.cache.mythSeedHash = hashString(String(world.seed) + ':races');
  const genesis = !(world.sys.myth && world.sys.myth.v != null) && world.time.day === 0;
  const { st, fresh } = activateMyth(world);
  if (fresh) {
    for (const c of world.civs) {
      if (!c || c.race != null) continue;
      touchRecord(world, c);   // (the fallen too: keyframes copy them afresh)
      if (!genesis) { c.race = 'human'; continue; }
      const cap = c.capitalId != null ? world.settlements[c.capitalId] : null;
      const i = cap ? cap.i : Math.round(fin(c.originY)) * world.W + Math.round(fin(c.originX));
      const p = peopleFor(world, { genesis, i, k: c.id });
      if (p) c.race = p.race;
    }
    for (const s of world.settlements) if (s && s.race == null) s.race = world.civs[s.civId]?.race ?? (genesis ? null : 'human');
    const nr = nicheReport(world, 2);
    st.niche = Object.fromEntries(Object.entries(nr.shares).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
  }
  for (const c of world.civs) if (c && c.alive && !c.arcane) seedArcane(world, c);
  // every live town holds a mix of peoples (an older save or a world woken mid-run: pure towns)
  ensurePeoples(world);
  if (fresh && genesis) dawnChronicle(world, st);
}

// The Awakening act (tools.js) wakes the myth without wake(): its old towns are human
on('mythAwakened', (world) => { if (isMythic(world)) ensurePeoples(world); });

on('paramChanged', (world, key, v) => {
  if (key !== 'mythLevel' || !(v >= 2) || world.cache?.mythAwakening) return;
  if (world.sys.myth && world.sys.myth.v != null) return;
  if (!world.sys.civ) return;   // not yet woken: system.init does it
  wake(world);
});

export const system = {
  id: 'myth',
  order: 86,

  init(world) {
    if (!isMythic(world)) return;
    wake(world);
  },

  update(world) {
    const lv = world.params.mythLevel;
    if (!(lv >= 1)) return;
    if (lv < 2) {
      if (dayOfYear(world) === YEAR_DAY) folkYearly(world);
      return;
    }
    const st = world.sys.myth;
    if (!st || st.v == null) return;
    peoplesDaily(world);
    if (dayOfMonth(world) === MANA_DAY) {
      monthlyMana(world);
      divineMonthly(world);
    }
    if (dayOfYear(world) === YEAR_DAY) {
      fadingYearly(world);
      racesYearly(world);
      peoplesYearly(world);
      folkYearly(world);
      pruneDivine(world);
    }
  },

  report(world) {
    const lv = world.params.mythLevel;
    if (!(lv >= 2)) {
      const clean = !world.f.ley && !world.f.mana && !world.f.manaBase && !(world.sys.myth && world.sys.myth.v != null);
      const folk = world.sys.myth?.folk;
      return {
        title: 'Myth',
        lines: [lv >= 1 ? `Legendary world: ${fin(folk?.n, 0)} folklore entries, ${Object.keys(folk?.saints || {}).length} saints, ${(folk?.prophecies || []).length} prophecies remembered` : 'Historical world: the myth is dormant'],
        checks: [{ ok: clean, label: 'no myth state or fields below mythLevel 2' }],
      };
    }
    const st = mythState(world);
    if (!st || st.v == null) return { title: 'Myth', lines: ['Mythic world, but the myth never woke'], checks: [{ ok: false, label: 'myth state present at mythLevel 2' }] };
    const census = raceCensus(world);
    const enabled = enabledRaces(world).filter((r) => (mixOf(world).genesis[r] || 0) > 0);
    const totalPop = Object.values(census).reduce((a, c) => a + c.pop, 0) || 1;
    const lines = [];
    lines.push('Races at Y' + yearOfDay(world.time.day) + ': ' + RACE_LIST.filter((r) => census[r].civs || census[r].towns || enabled.includes(r)).map((r) => `${raceLabel(r, true)} ${census[r].civs} realms · ${census[r].towns} towns · ${(100 * census[r].pop / totalPop).toFixed(0)}%${census[r].civs || census[r].towns ? '' : ' (gone)'}`).join('; '));
    if (st.niche) lines.push('Niche shares at genesis: ' + Object.entries(st.niche).map(([r, v]) => `${r} ${(100 * v).toFixed(0)}%`).join(', ') + ' (target 5–30 %)');
    const m = manaStats(world);
    const nodes = leyNodes(world);
    const gen = nodes.filter((n) => n.data?.origin === 'gen').length;
    lines.push(`Ley: ${nodes.length} nodes (${gen} at genesis), ${st.ley.edges.length} lines over ${leyTiles(world.f.ley)} tiles · mana land mean ${m.mean.toFixed(2)}, ${(100 * m.rich).toFixed(0)}% above 0.6, ${(100 * m.drained).toFixed(1)}% drained · weave ${fin(st.weave, 1).toFixed(2)}`);
    const bySchool = {};
    let learned = 0;
    for (const c of liveCivs(world)) {
      const k = arcaneKnown(c);
      if (k) learned++;
      for (const t of ARCANE_TECHS) if (c.tech?.known?.[t.id] != null) bySchool[t.school] = (bySchool[t.school] || 0) + 1;
    }
    lines.push(`Arcane arts: ${learned}/${liveCivs(world).length} realms learned; ` + (Object.keys(bySchool).length ? Object.entries(bySchool).map(([s, n]) => `${SCHOOLS[s].label} ${n}`).join(', ') : 'none yet'));
    lines.push(`Gods answered ${fin(st.divine?.n, 0)} times${Object.keys(st.divine?.byDomain || {}).length ? ' (' + Object.entries(st.divine.byDomain).map(([d, n]) => `${d} ${n}`).join(', ') + ')' : ''}; folklore ${fin(st.folk?.n, 0)}; ley lines drawn ${fin(st.counts?.lines, 0)}, wellsprings ${fin(st.counts?.wells, 0)}${st.awakenedDay != null ? `; awakened in Year ${yearOfDay(st.awakenedDay)}` : ''}`);
    {
      // the human gifts right now (humanEdge): learning from others, cosmopolitan
      let n = 0, learn = 0, on = 0, cosmo = 0, others = 0;
      for (const c of liveCivs(world)) {
        const e = humanEdge(world, c);
        if (!e) continue;
        n++; learn += e.learn; cosmo += e.cosmo; others += e.others;
        if (e.learn > 0) on++;
      }
      if (n) lines.push(`Human gifts: ${n} realms · learning from others on in ${on} (mean +${(100 * learn / n).toFixed(0)}% research) · cosmopolitan +${(100 * cosmo / n).toFixed(1)}% research and trade (other peoples ${(100 * others / n).toFixed(0)}% of their towns)`);
    }
    const ms = mixStats(world);
    const pc = peoplesCounts(world) || {};
    lines.push(`Peoples: ${ms.towns ? (100 * ms.mixed / ms.towns).toFixed(0) : 0}% of ${ms.towns} towns hold a minority ≥ 10%, ${ms.three} cities (${ms.threeAny} towns) three peoples ≥ 10% · ${fin(pc.turned)} turnings (${fin(pc.told)} chronicled), ${fin(pc.expelled)} expulsions, ${fin(pc.conquests)} conquests, ${fin(pc.arrivals)} arrivals, ${fin(pc.kept)} last-of-a-people holds`);
    const fade = st.fade?.marks || {};
    if (Object.keys(fade).length) lines.push('Fading marks: ' + Object.entries(fade).map(([k, d]) => `${k} in Y${yearOfDay(d)}`).join(', '));
    let finite = true;
    for (const a of [world.f.mana, world.f.manaBase]) for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i]) || a[i] < 0 || a[i] > 1.6) { finite = false; break; }
    const raced = liveCivs(world).every((c) => c.race && RACES[c.race]);
    const arcane = liveCivs(world).every((c) => c.arcane && Number.isFinite(c.arcane.mana));
    const w = fin(st.weave, 1);
    return {
      title: 'Myth (mythLevel 2)',
      lines,
      checks: [
        { ok: finite, label: 'mana fields finite and within 0..1.6' },
        { ok: w >= 0.15 && w <= 1, label: `weave ${w.toFixed(2)} within 0.15..1` },
        { ok: gen === 0 || (gen >= 12 && gen <= 24), label: `${gen} genesis ley nodes (18–24 on a medium map)` },
        { ok: raced, label: 'every living realm has a race' },
        { ok: arcane, label: 'every living realm has an arcane sample' },
        { ok: ms.bad === 0, label: `every live town holds a valid mix of peoples (${ms.bad} invalid)` },
        { ok: ms.domOk === ms.towns - ms.bad, label: 'every town\'s race is its dominant people (within the hysteresis)' },
      ],
    };
  },
};

/** The arcane tech defs, the schools and the folklore deck ids (for tools and tests). */
export { ARCANE_TECHS, ARCANE_BY_ID, SCHOOLS, FOLK_IDS };
