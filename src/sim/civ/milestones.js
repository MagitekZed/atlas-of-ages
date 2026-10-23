// World milestones (yearly, at midsummer): turning points of the whole world's history,
// each recorded once at epochal importance —
//   the first city of a million souls (the first great city and first metropolis are
//   recorded by settlement.js as those tiers are reached)
//   humankind reaching one, ten and a hundred million people
//   a realm ruling a third of all the world's towns (hegemony)
//   a continent first united under one realm after several peoples had held parts of it
// State lives in world.sys.civ.worldMarks (JSON only).

import { liveSettlements, liveCivs } from '../../core/entities.js';
import { DAYS_PER_YEAR } from '../../core/constants.js';
import { record, fin } from './state.js';
import { theName, TheName, pick, fmtInt, listJoin } from './prose.js';

const CITY_MARKS = [[1000000, 'a million']];
const POP_MARKS = [[1e6, 'a million'], [1e7, 'ten million'], [1e8, 'a hundred million']];
const HEGEMONY_SHARE = 1 / 3;
const HEGEMONY_MIN_TOWNS = 30;     // a world this crowded before a third of it means much
const HEGEMONY_GAP = 100;          // years between hegemony entries for different realms
const UNITE_MIN_TOWNS = 10;
const UNITE_GAP = 150;             // years before the same continent's unification is news again

function state(world) {
  const st = world.sys.civ;
  return (st.worldMarks ||= { city: 0, pop: 0, hegemon: {}, lastHegemonDay: -1e9, unified: {}, held: {} });
}

export function milestonesYearly(world) {
  const ms = state(world);
  const towns = liveSettlements(world);
  if (!towns.length) return;
  const day = world.time.day;
  const year = Math.floor(day / DAYS_PER_YEAR);

  // the greatest city yet
  let big = towns[0], total = 0;
  for (const s of towns) { total += s.population; if (s.population > big.population) big = s; }
  let mark = ms.city;
  while (mark < CITY_MARKS.length && big.population >= CITY_MARKS[mark][0]) mark++;
  if (mark > ms.city) {
    const words = CITY_MARKS[mark - 1][1];
    const civ = world.civs[big.civId];
    record(world, {
      cat: 'civ', imp: 5, s: big, key: 'world.city.million',
      text: pick(world, [
        `${big.name} of ${theName(civ)} became the first city in the world to hold ${words} souls.`,
        `Never before had so many lived in one place: ${big.name}, the jewel of ${theName(civ)}, now numbered ${words} people.`,
        `In Year ${year} ${big.name} grew past ${words} souls, the greatest city the world had yet known.`,
      ]),
    });
    ms.city = mark;
  }

  // humankind's numbers
  mark = ms.pop;
  while (mark < POP_MARKS.length && total >= POP_MARKS[mark][0]) mark++;
  if (mark > ms.pop) {
    const words = POP_MARKS[mark - 1][1];
    const nations = liveCivs(world).length;
    record(world, {
      cat: 'civ', imp: 5, s: big, key: 'world.population',
      text: pick(world, [
        `By Year ${year} humankind had grown to ${words} souls, living in ${fmtInt(towns.length)} towns under ${fmtInt(nations)} nations.`,
        `For the first time the peoples of the world numbered ${words}; ${big.name} was the greatest of their ${fmtInt(towns.length)} towns.`,
      ]),
    });
    ms.pop = mark;
  }

  // hegemony: one realm holds a third of the world's towns
  if (towns.length >= HEGEMONY_MIN_TOWNS && day - fin(ms.lastHegemonDay, -1e9) >= HEGEMONY_GAP * DAYS_PER_YEAR) {
    for (const civ of liveCivs(world)) {
      if (ms.hegemon[civ.id] != null) continue;
      const n = civ.settlementIds.length;
      if (n < HEGEMONY_SHARE * towns.length) continue;
      ms.hegemon[civ.id] = day;
      ms.lastHegemonDay = day;
      const share = n / towns.length >= 0.5 ? 'half' : 'a third';
      record(world, {
        cat: 'civ', imp: 5, civ, key: 'world.hegemony',
        text: pick(world, [
          `${TheName(civ)} now ruled ${share} of all the towns of the world, the mightiest realm yet seen.`,
          `From ${world.settlements[civ.capitalId]?.name || 'its capital'}, ${theName(civ)} governed ${share} of the world's towns; no realm before it had held so much.`,
        ]),
      });
      break;
    }
  }

  // a continent united under one realm
  const { f, W } = world;
  const byLand = new Map();
  for (const s of towns) {
    const k = f.landmass[s.i];
    if (k < 0) continue;
    let e = byLand.get(k);
    if (!e) byLand.set(k, (e = { n: 0, civs: new Set(), last: null }));
    e.n++; e.civs.add(s.civId); e.last = s;
  }
  for (const feat of world.features) {
    if (feat.kind !== 'continent') continue;
    const ai = Math.round(feat.y) * W + Math.round(feat.x);
    const k = ai >= 0 && ai < world.N && f.landmass[ai] >= 0 ? f.landmass[ai] : feat.landmass;
    const e = byLand.get(k);
    if (!e) continue;
    const held = (ms.held[feat.name] ||= []);
    for (const id of e.civs) if (!held.includes(id) && held.length < 40) held.push(id);
    if (e.n < UNITE_MIN_TOWNS || e.civs.size !== 1 || held.length < 2) continue;
    const civId = e.civs.values().next().value;
    const prev = ms.unified[feat.name];
    if (prev && (prev.civId === civId || day - prev.day < UNITE_GAP * DAYS_PER_YEAR)) continue;
    ms.unified[feat.name] = { civId, day };
    const civ = world.civs[civId];
    const rivals = held.filter((id) => id !== civId).map((id) => world.civs[id]).filter(Boolean);
    const others = rivals.length > 3 ? `${rivals.length} peoples` : listJoin(rivals.map((c) => theName(c)));
    record(world, {
      cat: 'civ', imp: 5, civ, key: 'world.unified', tags: [feat.name],
      text: pick(world, [
        `${TheName(civ)} now held the whole of ${feat.name}, uniting under one realm the lands once divided with ${others}.`,
        `For the first time all of ${feat.name}, from coast to coast, answered to a single realm: ${theName(civ)}.`,
      ]),
    });
  }
}
