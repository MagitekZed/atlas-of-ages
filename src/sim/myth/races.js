// Races of a Mythic world (mythLevel 2): who lives where, how long, how fast they breed and
// what they are like. The table drives the WP5 ext providers the civ module asks at its
// call sites (core/ext.js): people (race, temperament and tongue of a new people), habitat
// (how a race rates a tile), demography (births and deaths), lifespan (age divisor for
// rulers and figures), mods (racial modifiers) and loyalty (minority towns). In a Mythic world
// a town holds a mix of peoples (s.peoples, src/sim/myth/peoples.js): demography and loyalty
// read the mix, share by share; s.race is its dominant people.
//
// Land niches: AFF[(race·17 + biome)·4 + band] is a race's affinity for a biome at an
// elevation band (lowland, upland, mountain, peak), relative to humans (1 everywhere: the
// generalists). Small live factors refine it — elves love old growth, dwarves ore, halflings
// rich soil by rivers, lizardfolk warmth and water. Each race's niche is normalised so that
// on default worlds every enabled race is the best-suited people on 5–30 % of the land
// (nicheReport, also run by tools/myth-check.mjs).
//
// Every provider is pure (no rng, no mutation) and neutral below mythLevel 2: nothing here
// can change a Historical world.
//
// Humans (docs/design/temperament-and-names.md §2) are no longer the neutral baseline but the
// adaptable, ingenious, restless people: inventive, wandering and trading by temperament, with
// a wider seeded jitter (human peoples differ more from one another than other races do) and
// the fastest temperament drift (adapt 2: the civ module's drift multiplier, read from RACES).
// Two gifts reach the civ mods through the 'mods' provider (humanEdge, pure, recomputed with
// the mods each month):
//   ingenious     research +6 %, and while the tech a human realm studies is already known to
//                 peoples it trades with (+12 % each) or has met (+7 % each), research on it
//                 runs faster, up to +30 % (on top of the shared diffusion discount)
//   cosmopolitan  research and trade + 0.25 × the share of other peoples in its towns
//                 (population-weighted, from each town's s.peoples), at most +10 %; and its
//                 towns are crossroads where other peoples settle more readily (peoples.js)

import { BIOME, BIOMES, WATER, RACE_META, RACE_KEYS, DAYS_PER_YEAR } from '../../core/constants.js';
import { registerProvider, getRegisteredTechs, extVersion } from '../../core/ext.js';
import { hashString, hash2 } from '../../core/rng.js';
import { smoothstep } from '../../core/util.js';

const NB = BIOMES.length;            // 17 biomes
export const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
/** Fast gate: providers run per tile, so read the param directly (core mythLevel semantics). */
export const isMythic = (w) => w != null && w.params != null && w.params.mythLevel >= 2;

// ---------------------------------------------------------------------------
// The six peoples

/**
 * life: age divisor (an elf of 250 lives like a human of 50); birth / mortality: demography
 * multipliers; sickness: × the chance a ruler or great person falls into a lasting illness
 * (civ/rulers.js; the ext 'sickness'); temper: trait offsets from 0.5 (core TRAIT_KEYS); jitter: width of the seeded
 * spread around them (× the shared ±0.28); adapt: how fast the people's temperament drifts with
 * its history (the civ module's multiplier: 2 twice as fast, 0.5 half as fast); mods: racial
 * modifiers (applyFx deltas on the civ mods); school: the arcane school the race founded;
 * strife: how the people fights among itself (core/cohorts.js in-fighting): k extra deaths a year
 * in a town wholly of that people (less as it shares the town), and who dies: its young men, its
 * men and women of fighting age ('adults') or young and old alike ('all');
 * war: how the people fights, as shares of spears, blades, bows, light horse, heavy horse,
 * engineers and war beasts (geo/army.js; humans fight by their era alone);
 * memory: how long the people remembers, in years (e-folding): a town's grudges and gratitude
 * (geo/memory.js) and a realm's claims on lost towns and on towns it founded (geo/claims.js);
 * elder: an old race that wakes first when magic returns; blurb: one line for the Inspector;
 * identity: the race's character and gifts in a few plain clauses (Legends race cards).
 */
export const RACES = {
  human: {
    key: 'human', life: 1, birth: 1, mortality: 1, sickness: 1, elder: false, school: 'wizardry', adapt: 2, jitter: 1.4,
    strife: { k: 0.003, who: 'youngMen' },   // brawls and blood feuds among the young men
    memory: { grudge: 40, thanks: 25, claim: 60, founded: 120 },   // remembers within two generations
    temper: { innovation: 0.12, expansion: 0.08, commerce: 0.05 },
    mods: { trade: 0.05, research: 0.06, expansionRange: 1 },
    blurb: 'Short-lived, restless and everywhere: the people who change, and who learn from everyone they meet.',
    identity: [
      'Adaptable: their ways shift with their fortunes faster than any other people’s, and no two human realms are alike',
      'Ingenious: they study harder than most, and learn fastest what their neighbours and trading partners already know',
      'Cosmopolitan: other peoples settle readily in their towns, and the more of them there are, the richer and cleverer the realm becomes',
    ],
  },
  elf: {
    key: 'elf', life: 5, birth: 0.58, mortality: 0.42, sickness: 0.4, elder: true, school: 'sylvan', adapt: 0.5, jitter: 1,
    strife: { k: 0.001, who: 'adults' },     // rare, cold quarrels of the old houses
    memory: { grudge: 200, thanks: 200, claim: 250, founded: 400 },   // remembers slights and kindnesses alike, for lifetimes of men
    war: [0.2, 0.15, 0.45, 0.15, 0.05, 0, 0],   // archers above all, and swift riders
    temper: { aggression: -0.2, isolation: 0.25, innovation: 0.1, religiosity: 0.05, tolerance: 0.05, expansion: -0.15 },
    mods: { gatherYield: 0.3, culture: 0.15, farmYield: -0.05, research: 0.05, defense: 0.25, stability: 0.05, housing: 0.08, forestFarm: 0.3 },
    blurb: 'Long-lived wardens of the old forests; slow to breed, slow to forget.',
    identity: ['Wardens of the deep woods, at home under old trees', 'Long-lived and slow to breed; their temper hardly changes in a thousand years'],
  },
  dwarf: {
    key: 'dwarf', life: 3, birth: 0.8, mortality: 0.5, sickness: 0.7, elder: true, school: 'runecraft', adapt: 0.6, jitter: 1,
    strife: { k: 0.002, who: 'youngMen' },   // clan grudges, settled in the halls
    memory: { grudge: 250, thanks: 60, claim: 300, founded: 500 },   // remembers a grudge for centuries; a lost hall forever
    war: [0.35, 0.35, 0.2, 0, 0, 0.1, 0],   // armoured blades and spears, and sappers; no horse
    temper: { militarism: 0.15, commerce: 0.15, expansion: -0.15, isolation: 0.15, tolerance: -0.05 },
    mods: { mining: 0.5, defense: 0.35, production: 0.1, gatherYield: 0.25, housing: 0.12, stability: 0.05, deepHalls: 0.5 },
    blurb: 'Delvers of the hills, stubborn as stone; their halls outlast kingdoms.',
    identity: ['Miners and smiths of the high hills, behind walls no army takes lightly', 'Stubborn: grudges and customs alike outlive the generations'],
  },
  orc: {
    key: 'orc', life: 0.7, birth: 1.4, mortality: 1.25, sickness: 1.4, elder: false, school: 'shamanism', adapt: 1, jitter: 1,
    strife: { k: 0.012, who: 'adults' },     // clan wars and challenges; the women fight too
    memory: { grudge: 25, thanks: 12, claim: 35, founded: 70 },   // remembers the last war, not the one before
    war: [0.15, 0.35, 0.1, 0.3, 0, 0, 0.1],   // blades and wolf-riders, and beasts
    temper: { aggression: 0.3, militarism: 0.3, innovation: -0.2, tolerance: -0.2, expansion: 0.15, commerce: -0.1 },
    mods: { military: 0.25, movement: 0.1, research: -0.15, gatherYield: 0.1 },
    blurb: 'Fierce, fast-breeding clans of the open steppe; they live hard and die young.',
    identity: ['Warriors of the open steppe, swift and many', 'They live hard and die young, and their temper turns with the fortunes of war'],
  },
  halfling: {
    key: 'halfling', life: 1.3, birth: 1.15, mortality: 0.9, sickness: 0.9, elder: true, school: 'hearth', adapt: 0.8, jitter: 1,
    strife: { k: 0.006, who: 'all' },        // feuds between families over land and inheritance, young and old alike
    memory: { grudge: 25, thanks: 50, claim: 50, founded: 100 },   // remembers kindness longer than slights
    war: [0.4, 0.05, 0.45, 0.1, 0, 0, 0],   // slingers and spears on ponies
    temper: { aggression: -0.3, commerce: 0.2, militarism: -0.25, tolerance: 0.15, expansion: -0.05 },
    mods: { farmYield: 0.2, storage: 0.3, military: -0.2, happiness: 0.04 },
    blurb: 'Small, merry farmers of the green river lands, who want only to be left alone.',
    identity: ['Farmers of the green river lands, with the fullest larders in the world', 'Peaceable and set in their comfortable ways'],
  },
  lizardfolk: {
    key: 'lizardfolk', life: 0.9, birth: 1.2, mortality: 1.08, sickness: 0.6, elder: true, school: 'serpent', adapt: 0.7, jitter: 1,
    strife: { k: 0.007, who: 'all' },        // brood wars take the young and the old
    memory: { grudge: 60, thanks: 15, claim: 80, founded: 150 },   // remembers a wrong long after a favour
    war: [0.45, 0.2, 0.2, 0, 0, 0, 0.15],   // spears and swamp beasts
    temper: { religiosity: 0.25, isolation: 0.2, commerce: -0.1, tolerance: -0.05 },
    mods: { fishYield: 0.3, plagueResist: 0.1, gatherYield: 0.1 },
    blurb: 'Cold-eyed broods of the steaming swamps, keepers of the oldest sun rites.',
    identity: ['Broods of the warm fens and rivers, hardy against sickness', 'Keepers of old rites who change their ways only slowly'],
  },
};

/** A race's temperament drift multiplier (1 for a people without a race, as in a Historical world). */
export const raceAdapt = (r) => fin(RACES[r]?.adapt, 1);
/** A race's drift speed in plain words, for the Legends race cards: "change quickly" … "slow to change". */
export function adaptWords(r) {
  const a = raceAdapt(r);
  return a >= 1.6 ? 'change quickly' : a >= 0.95 ? 'change with their fortunes' : a >= 0.75 ? 'change slowly' : a >= 0.55 ? 'slow to change' : 'hardly change at all';
}
/** The race's character and gifts for UI cards: { blurb, identity: [clause], adapt, adaptWords }. */
export function raceIdentity(r) {
  const R = RACES[r];
  if (!R) return null;
  return { blurb: R.blurb, identity: (R.identity || []).slice(), adapt: raceAdapt(r), adaptWords: adaptWords(r) };
}
export const RACE_LIST = RACE_KEYS.slice();          // human, elf, dwarf, orc, halfling, lizardfolk
export const RACE_IDX = Object.fromEntries(RACE_LIST.map((k, n) => [k, n]));
export const NR = RACE_LIST.length;
/** Map and badge colours: RACE_META's hue families, nudged apart so elves (sea-green) and
 *  lizardfolk (jade) never read as one people on the Peoples map. */
export const RACE_HUE = {
  human: [178, 136, 94], elf: [62, 160, 158], dwarf: [116, 126, 146], orc: [180, 82, 50], halfling: [216, 182, 96], lizardfolk: [112, 164, 68],
};
export const raceRgb = (r) => RACE_HUE[r] || RACE_META[r]?.color || [150, 140, 128];
export const raceLabel = (r, plural = false) => (RACE_META[r] ? (plural ? RACE_META[r].plural : RACE_META[r].label) : plural ? 'Peoples' : 'People');
export const raceAdj = (r) => RACE_META[r]?.adjective || '';

/**
 * Genesis weights by raceMix (0 = the race never begins history). emerge: weights for new
 * peoples rising later (Elder Races worlds see the first humans arrive after a while).
 */
export const RACE_MIX = {
  mixed: { genesis: { human: 1.0, elf: 0.85, dwarf: 0.85, orc: 0.85, halfling: 0.7, lizardfolk: 0.7 } },
  humanDominant: { genesis: { human: 3.2, elf: 0.4, dwarf: 0.4, orc: 0.4, halfling: 0.35, lizardfolk: 0.35 } },
  elderRaces: { genesis: { human: 0, elf: 1.2, dwarf: 1.2, orc: 0.55, halfling: 0.8, lizardfolk: 0.7 }, emerge: { human: 0.45 }, humansFrom: 180 },
  monstrous: { genesis: { human: 0.55, elf: 0.3, dwarf: 0.45, orc: 1.7, halfling: 0.3, lizardfolk: 1.35 } },
};
export function mixOf(world) {
  return RACE_MIX[world?.params?.raceMix] || RACE_MIX.mixed;
}
/** Races that take part in this world (genesis weight > 0, or a later arrival). */
export function enabledRaces(world) {
  const m = mixOf(world);
  return RACE_LIST.filter((r) => (m.genesis[r] || 0) > 0 || (m.emerge?.[r] || 0) > 0);
}

// ---------------------------------------------------------------------------
// Niches

// biome affinities, indexed by BIOME id (0..16); humans are 1 everywhere
const B = BIOME;
function biomeRow(def, map) {
  const row = new Float32Array(NB).fill(def);
  for (const [k, v] of Object.entries(map)) row[B[k]] = v;
  row[B.DEEP_OCEAN] = row[B.OCEAN] = row[B.LAKE] = 0;
  return row;
}
const BIOME_AFF = {
  human: biomeRow(1, {}),
  elf: biomeRow(0.55, {
    TEMPERATE_FOREST: 1.7, TEMPERATE_RAINFOREST: 1.8, TAIGA: 1.22, TROPICAL_FOREST: 0.95, RAINFOREST: 1.1,
    WETLAND: 0.7, STEPPE: 0.5, SHRUBLAND: 0.6, SAVANNA: 0.55, TUNDRA: 0.4, HOT_DESERT: 0.2, COLD_DESERT: 0.25, ALPINE: 0.35, ICE: 0.1,
  }),
  dwarf: biomeRow(0.62, {
    ALPINE: 2.2, TUNDRA: 0.75, TAIGA: 0.72, COLD_DESERT: 0.85, SHRUBLAND: 0.72, STEPPE: 0.66, TEMPERATE_FOREST: 0.62,
    HOT_DESERT: 0.5, SAVANNA: 0.5, WETLAND: 0.28, RAINFOREST: 0.3, TROPICAL_FOREST: 0.42, ICE: 0.35,
  }),
  orc: biomeRow(0.72, {
    STEPPE: 1.36, SHRUBLAND: 1.32, COLD_DESERT: 1.34, TUNDRA: 1.42, TAIGA: 1.14, SAVANNA: 0.97, HOT_DESERT: 0.9,
    TEMPERATE_FOREST: 0.8, ALPINE: 0.8, WETLAND: 0.55, RAINFOREST: 0.45, ICE: 0.3,
  }),
  halfling: biomeRow(0.5, {
    STEPPE: 1.2, TEMPERATE_FOREST: 1.06, SHRUBLAND: 1.0, SAVANNA: 0.92, TROPICAL_FOREST: 0.7, WETLAND: 0.55,
    TEMPERATE_RAINFOREST: 0.75, TAIGA: 0.55, HOT_DESERT: 0.25, COLD_DESERT: 0.3, TUNDRA: 0.3, ALPINE: 0.15, ICE: 0.05,
  }),
  lizardfolk: biomeRow(0.4, {
    WETLAND: 2.6, RAINFOREST: 1.9, TROPICAL_FOREST: 1.36, SAVANNA: 0.88, TEMPERATE_RAINFOREST: 0.85, HOT_DESERT: 0.45,
    SHRUBLAND: 0.55, STEPPE: 0.45, TEMPERATE_FOREST: 0.6, TAIGA: 0.25, TUNDRA: 0.1, ALPINE: 0.1, ICE: 0.02,
  }),
};
// elevation bands above the live sea level: lowland < 0.1, upland < 0.22, mountain < 0.35, peak
export const BAND_EDGES = [0.1, 0.22, 0.35];
const BAND_AFF = {
  human: [1, 0.92, 0.7, 0.5],
  elf: [1, 0.82, 0.5, 0.3],
  dwarf: [0.8, 2.35, 2.8, 2.2],
  orc: [1, 1.1, 0.75, 0.45],
  halfling: [1, 0.8, 0.25, 0.1],
  lizardfolk: [1, 0.55, 0.2, 0.08],
};
/** Per-race niche normalisation (tuned so default worlds give every race 5–30 % of the land). */
const NORM = { human: 1, elf: 1, dwarf: 1, orc: 1, halfling: 1, lizardfolk: 1 };

/** AFF[(r·17 + b)·4 + band]: the static part of every race's affinity. */
export const AFF = new Float32Array(NR * NB * 4);
for (let r = 0; r < NR; r++) {
  const key = RACE_LIST[r];
  for (let b = 0; b < NB; b++) for (let e = 0; e < 4; e++) AFF[(r * NB + b) * 4 + e] = BIOME_AFF[key][b] * BAND_AFF[key][e] * NORM[key];
}

/** Elevation band of a tile (0 lowland … 3 peak), relative to the live sea level. */
export function bandOf(world, i) {
  const h = world.f.elevation[i] - fin(world.climate?.seaLevel, 0.5);
  return h < BAND_EDGES[0] ? 0 : h < BAND_EDGES[1] ? 1 : h < BAND_EDGES[2] ? 2 : 3;
}

const FOREST = new Uint8Array(NB);
for (const k of ['TAIGA', 'TEMPERATE_FOREST', 'TEMPERATE_RAINFOREST', 'TROPICAL_FOREST', 'RAINFOREST']) FOREST[B[k]] = 1;
const VEGMAX = Float32Array.from(BIOMES, (b) => Math.max(0.05, b.vegMax));

/**
 * Affinity of race index r for land tile i (0 on water). Static table × live refinements:
 * elves × old growth, dwarves × ore, halflings × soil and fresh water, lizardfolk × warmth
 * and water, orcs × open ground. Pure; a handful of field reads.
 */
export function raceAff(world, r, i) {
  const f = world.f;
  if (f.water[i] !== WATER.LAND) return 0;
  const b = f.biome[i];
  let a = AFF[(r * NB + b) * 4 + bandOf(world, i)];
  switch (r) {
    case 1: { // elf: the deeper and older the wood, the better
      const v = f.veg[i] / VEGMAX[b];
      a *= FOREST[b] ? 0.72 + 0.42 * (v > 1 ? 1 : v) : 1;
      break;
    }
    case 2: // dwarf: ore under the hill
      a *= 0.88 + 0.5 * f.mineral[i];
      break;
    case 3: // orc: wide open ground, thin soil
      a *= 1.06 - 0.16 * f.soil[i];
      break;
    case 4: { // halfling: rich soil, and a river or lake at the door
      a *= 0.66 + 0.8 * (f.soil[i] > 1 ? 1 : f.soil[i]);
      if (f.river[i] > 0) a *= 1.25;
      break;
    }
    case 5: { // lizardfolk: warm and wet, never cold
      a *= smoothstep(5, 15, f.annTemp[i]);
      if (f.river[i] > 0 || f.coast[i]) a *= 1.12;
      break;
    }
    default: break;
  }
  return a;
}

/** The race whose niche tile i fits best among `races` (keys), or null on water. */
export function bestRaceAt(world, i, races = RACE_LIST, weights = null) {
  let best = null, bv = 0;
  for (const k of races) {
    const w = weights ? fin(weights[k], 0) : 1;
    if (w <= 0) continue;
    const v = raceAff(world, RACE_IDX[k], i) * (weights ? Math.sqrt(w) : 1);
    if (v > bv) { bv = v; best = k; }
  }
  return best;
}

/**
 * Share of land where each enabled race is the best-suited people (stride sampling).
 * Returns { shares: { race: 0..1 }, land } — the niche normalisation target is 5–30 %.
 */
export function nicheReport(world, stride = 2) {
  const races = enabledRaces(world).filter((r) => (mixOf(world).genesis[r] || 0) > 0);
  const counts = Object.fromEntries(races.map((r) => [r, 0]));
  let land = 0;
  const { W, H, f } = world;
  for (let y = 0; y < H; y += stride) for (let x = 0; x < W; x += stride) {
    const i = y * W + x;
    if (f.water[i] !== WATER.LAND) continue;
    land++;
    const b = bestRaceAt(world, i, races);
    if (b) counts[b]++;
  }
  const shares = {};
  for (const r of races) shares[r] = land ? counts[r] / land : 0;
  return { shares, land };
}

// ---------------------------------------------------------------------------
// Tongues (core/names.js createLanguage style)

export const PHONOLOGY = {
  human: null,
  elf: {
    onsets: ['l', 'th', 's', 'f', 'v', 'n', 'r', 'm', 'el', 'gl', 'c', 'h', 'ar'], codas: ['l', 'n', 's', 'th', 'r', 'nd', 'dh', 'nn'],
    vowels: ['a', 'e', 'i', 'ae', 'ei', 'ia', 'ie', 'io'], minSyl: 2, maxSyl: 4,
    placeSuffixes: ['iel', 'wen', 'lond', 'andor', 'ion', 'aran', 'ithil', 'orn'], personSuffixes: ['iel', 'wen', 'ion', 'ir', 'las', 'dor'],
    adjSuffixes: ['i', 'ian', 'in'], apostrophe: 0.02,
  },
  dwarf: {
    onsets: ['kh', 'dr', 'b', 'g', 'th', 'z', 'gr', 'd', 't', 'br', 'n', 'm', 'k', 'thr'], codas: ['rn', 'k', 'm', 'z', 'rd', 'r', 'n', 'l', 'g', 'zh'],
    vowels: ['a', 'u', 'o', 'i', 'a', 'u'], minSyl: 1, maxSyl: 3,
    placeSuffixes: ['heim', 'dun', 'grim', 'dor', 'zad', 'khaz', 'mund', 'barak'], personSuffixes: ['in', 'ur', 'ak', 'or', 'im', 'li'],
    adjSuffixes: ['ish', 'ar', 'i'], apostrophe: 0.05,
  },
  orc: {
    onsets: ['gr', 'g', 'k', 'z', 'sh', 'b', 'ug', 'm', 'n', 'd', 'r', 'kr', 'gh', 'th'], codas: ['k', 'g', 'sh', 'rk', 'z', 'zg', 'gh', 'r', 'b'],
    vowels: ['u', 'a', 'o', 'u', 'a'], minSyl: 1, maxSyl: 2,
    placeSuffixes: ['gash', 'uk', 'mog', 'zug', 'ash', 'bur', 'gul', 'thak'], personSuffixes: ['ug', 'ash', 'ok', 'uk', 'gor', 'bag'],
    adjSuffixes: ['ish', 'i', 'uk'], apostrophe: 0.15,
  },
  halfling: {
    onsets: ['b', 'p', 'd', 't', 'm', 'n', 'l', 'r', 's', 'w', 'h', 'f', 'br', 'st', 'g', 'c', 'p', 'm'], codas: ['n', 's', 'r', 'l', 'nd', 'm', 'ck', 't', 'ns'],
    vowels: ['a', 'e', 'i', 'o', 'u', 'ee', 'oo'], minSyl: 1, maxSyl: 2,
    placeSuffixes: ['by', 'wick', 'bottom', 'hollow', 'burrow', 'ton', 'field', 'mead', 'hill', 'brook'], personSuffixes: ['o', 'bo', 'wise', 'kin', 'ry', 'ett'],
    adjSuffixes: ['ish', 'er', 'an'], apostrophe: 0,
  },
  lizardfolk: {
    onsets: ['ss', 'sh', 'x', 'q', 'k', 's', 'z', 'th', 'ch', 't', 'ix', 'h'], codas: ['ss', 'x', 'k', 'th', 'sh', 'q', 's'],
    vowels: ['a', 'i', 'e', 'aa', 'u', 'ii'], minSyl: 2, maxSyl: 3,
    placeSuffixes: ["'sa", 'ix', 'ath', 'ssi', "'ka", 'xa', 'thas'], personSuffixes: ['ssa', 'ix', "'th", 'ek'],
    adjSuffixes: ['i', 'an', 'ix'], apostrophe: 0.6,
  },
};

// ---------------------------------------------------------------------------
// Choosing a people's race (the 'people' provider)

const TRAITS = ['aggression', 'expansion', 'religiosity', 'commerce', 'innovation', 'tolerance', 'militarism', 'isolation'];
const seedHash = (world) => (world.cache && world.cache.mythSeedHash != null ? world.cache.mythSeedHash : hashString(String(world.seed) + ':races'));

/**
 * Temperament of a new people of race r: racial offsets around 0.5 with a seeded jitter of
 * ±0.28 × the race's jitter (humans ×1.4: their peoples differ the most).
 */
export function traitsFor(world, r, salt) {
  const t = RACES[r]?.temper || {};
  const spread = 0.56 * fin(RACES[r]?.jitter, 1);
  const h = seedHash(world);
  const out = {};
  for (let k = 0; k < TRAITS.length; k++) {
    const key = TRAITS[k];
    const j = (hash2(salt | 0, k * 131 + 7, h) - 0.5) * spread;
    const v = 0.5 + fin(t[key], 0) + j;
    out[key] = v < 0.05 ? 0.05 : v > 0.95 ? 0.95 : v;
  }
  return out;
}

function countRaces(world) {
  const n = Object.fromEntries(RACE_LIST.map((r) => [r, 0]));
  let all = 0;
  for (const c of world.civs) if (c && c.race && n[c.race] != null) { n[c.race]++; all++; }
  return { n, all };
}

/**
 * The genesis roster: which race the k-th first people is, when the civ module asks before
 * choosing a site. A seeded, weighted draw by raceMix with a ×0.35 penalty per earlier pick
 * of the same race, and at least three races once civCount ≥ 4. Pure and cached by seed.
 */
export function genesisRoster(world) {
  const n = Math.max(0, Math.round(fin(world.params.civCount, 7)));
  const key = `${world.seed}|${world.params.raceMix}|${n}`;
  const c = world.cache;
  if (c.mythRoster && c.mythRosterKey === key) return c.mythRoster;
  const w0 = mixOf(world).genesis;
  const races = RACE_LIST.filter((r) => (w0[r] || 0) > 0);
  const used = Object.fromEntries(races.map((r) => [r, 0]));
  const out = [];
  const h = hashString(String(world.seed) + ':roster');
  for (let k = 0; k < n; k++) {
    const distinct = races.filter((r) => used[r] > 0).length;
    const left = n - k;
    const need = Math.min(3, races.length) - distinct;
    const pool = n >= 4 && need > 0 && left <= need ? races.filter((r) => used[r] === 0) : races;
    let tot = 0;
    const ws = pool.map((r) => { const v = w0[r] * Math.pow(0.35, used[r]); tot += v; return v; });
    let u = hash2(k, 911, h) * tot, pickR = pool[pool.length - 1];
    for (let m = 0; m < pool.length; m++) { if (u < ws[m]) { pickR = pool[m]; break; } u -= ws[m]; }
    used[pickR]++;
    out.push(pickR);
  }
  c.mythRoster = out; c.mythRosterKey = key;
  return out;
}

/** Weights for a new people rising at tile i after genesis (emergence, tools, awakening). */
function emergenceWeights(world) {
  const m = mixOf(world);
  const st = world.sys.myth;
  const yrs = world.time.day / DAYS_PER_YEAR;
  const out = {};
  for (const r of RACE_LIST) {
    let v = m.genesis[r] || 0;
    if (m.emerge && m.emerge[r] != null && yrs >= fin(m.humansFrom, 0)) v = Math.max(v, m.emerge[r]);
    // magic newly awakened: the elder races come out of the wild places for fifty years
    if (st && st.awakenedDay != null && world.time.day - st.awakenedDay < 50 * DAYS_PER_YEAR && RACES[r].elder) v *= 3.2;
    out[r] = v;
  }
  return out;
}

/**
 * people provider: (w, { genesis, k?, i?, parentCivId? }) → { race, traits, languageStyle } | null.
 * Splits inherit the parent's race (and keep its temperament); a first people with a site
 * takes the race its land favours (weighted by raceMix, with repeats penalised and at least
 * three races at genesis); without a site the genesis roster decides.
 */
export function peopleFor(world, q = {}) {
  if (!isMythic(world)) return null;
  const i = Number.isFinite(q.i) && q.i >= 0 && q.i < world.N ? q.i : -1;
  if (q.parentCivId != null) {
    // a realm breaking away takes the blood of the towns that rise, not of the crown they
    // leave: elven towns under a human king secede as elves (kinstrife)
    const sid = i >= 0 ? world.f.settle[i] : -1;
    const town = sid >= 0 ? world.settlements[sid] : null;
    if (town && town.race && RACES[town.race]) return { race: town.race, languageStyle: PHONOLOGY[town.race] || null };
    const p = world.civs[q.parentCivId];
    if (p && p.race) return { race: p.race, languageStyle: PHONOLOGY[p.race] || null };
  }
  let race;
  if (q.genesis) {
    const w0 = mixOf(world).genesis;
    const races = RACE_LIST.filter((r) => (w0[r] || 0) > 0);
    if (!races.length) return null;
    if (i < 0) race = genesisRoster(world)[Math.max(0, fin(q.k, 0) | 0)] || races[0];
    else {
      const { n } = countRaces(world);
      const total = Math.max(0, Math.round(fin(world.params.civCount, 7)));
      const k = Number.isFinite(q.k) ? q.k : world.civs.length;
      const distinct = races.filter((r) => n[r] > 0).length;
      const need = Math.min(3, races.length) - distinct;
      const forced = total >= 4 && need > 0 && total - k <= need;
      const pool = forced ? races.filter((r) => n[r] === 0) : races;
      race = pickBySite(world, i, pool, w0, n, k);
    }
  } else {
    const ew = emergenceWeights(world);
    const races = RACE_LIST.filter((r) => ew[r] > 0);
    if (!races.length) return null;
    race = i >= 0 ? pickBySite(world, i, races, ew, countRaces(world).n, world.civs.length) : races.reduce((a, b) => (ew[b] > ew[a] ? b : a));
  }
  const salt = i >= 0 ? i : 7919 * (fin(q.k, 0) + 1);
  return { race, traits: traitsFor(world, race, salt + world.civs.length * 104729), languageStyle: PHONOLOGY[race] || null };
}

/** Weighted, seeded pick of a race for the land at tile i: affinity² × weight × 0.35^repeats. */
function pickBySite(world, i, pool, weights, counts, salt) {
  let tot = 0;
  const ws = new Array(pool.length);
  for (let m = 0; m < pool.length; m++) {
    const r = pool[m];
    const a = raceAff(world, RACE_IDX[r], i);
    const v = a * a * fin(weights[r], 0) * Math.pow(0.35, fin(counts?.[r], 0));
    ws[m] = v; tot += v;
  }
  if (!(tot > 0)) return pool[0];
  let u = hash2(i, salt | 0, seedHash(world) ^ 0x5bd1) * tot;
  for (let m = 0; m < pool.length; m++) { if (u < ws[m]) return pool[m]; u -= ws[m]; }
  return pool[pool.length - 1];
}

// ---------------------------------------------------------------------------
// Providers

/** habitat: how race rates tile i (× the civ module's habitability). null race: the best-suited enabled race. */
function habitat(world, race, i) {
  if (!isMythic(world) || !(i >= 0 && i < world.N)) return 1;
  if (race && RACE_IDX[race] != null) {
    const a = raceAff(world, RACE_IDX[race], i);
    // squash the extremes: a niche guides where a people settles, it does not forbid
    return 0.2 + 0.8 * a;
  }
  // no race yet (a first people choosing ground before it knows who it is): plain good land
  // decides, with only a gentle lift where some people's niche is strong, so the first
  // tribes are not all drawn into the swamps and mountains
  const w0 = mixOf(world).genesis;
  let best = 0;
  for (let r = 0; r < NR; r++) {
    if ((w0[RACE_LIST[r]] || 0) <= 0) continue;
    const a = raceAff(world, r, i);
    if (a > best) best = a;
  }
  return best > 0 ? 0.85 + 0.15 * Math.min(2.2, best) : 1;
}

/** Race of a settlement (its own people), else its realm's. */
export const raceOfTown = (world, s, civ) => (s && s.race) || (civ && civ.race) || null;

/**
 * demography: births and deaths of a town are the share-weighted averages of its peoples
 * (s.peoples, src/sim/myth/peoples.js), else of its one race; the Fading thins the births of
 * the elder races of the weave (elves, lizardfolk).
 */
function demography(world, s, civ) {
  if (!isMythic(world)) return null;
  const p = s && s.peoples;
  const weaveF = 0.6 + 0.4 * fin(world.sys.myth?.weave, 1);
  if (p && typeof p === 'object') {
    let b = 0, m = 0, tot = 0;
    for (const r in p) {
      const R = RACES[r];
      const sh = p[r];
      if (!R || !(sh > 0)) continue;
      b += sh * (r === 'elf' || r === 'lizardfolk' ? R.birth * weaveF : R.birth);
      m += sh * R.mortality;
      tot += sh;
    }
    if (tot > 0) return { birth: b / tot, mortality: m / tot };
  }
  const race = raceOfTown(world, s, civ);
  const R = race && RACES[race];
  if (!R) return null;
  let birth = R.birth;
  // the Fading: the old magical peoples grow barren as the weave thins
  if (race === 'elf' || race === 'lizardfolk') birth *= weaveF;
  return { birth, mortality: R.mortality };
}

/**
 * A people's rates for its own age bands in town s (core/cohorts.js 'peopleRates'): its birth
 * and mortality against a human's, the Fading thinning the elder births, and its life (an elf's
 * bands are stages five times as long). Elves breed with the magic around them: their births
 * × (0.7 + 0.8 × mana at the town), from 0.7 where the weave is gone to 1.6, about 1 at an elf
 * town's usual mana; they thrive in the old magical forests and fade as the weave thins. One
 * object per people, refreshed on each call.
 */
const RATES = {};
let manaReader = null;   // mana.js manaAt, set by mana.js (it imports this module)
export function setManaReader(fn) { manaReader = fn; }
function peopleRates(world, key, s) {
  if (!isMythic(world)) return null;
  const R = RACES[key];
  if (!R) return null;
  const o = (RATES[key] ||= { birth: 1, mortality: 1, life: 1 });
  o.birth = key === 'elf' || key === 'lizardfolk' ? R.birth * (0.6 + 0.4 * fin(world.sys.myth?.weave, 1)) : R.birth;
  if (key === 'elf' && s && manaReader) o.birth *= Math.min(1.6, 0.7 + 0.8 * Math.max(0, manaReader(world, s.x, s.y)));
  o.mortality = R.mortality;
  o.life = R.life;
  return o;
}

/**
 * How a people fights among itself (core/cohorts.js 'strife'): its race's strife. A realm's own
 * ways (a code of law, a warrior faith, an era of order) may vary it later, through this point.
 */
/**
 * armyMix: a people fights in its own way, blended toward its era's mix as the ages turn
 * (modern armies look alike); its war beasts come only where its beast-keepers are.
 */
function armyMix(world, civ) {
  if (!isMythic(world) || !civ || !civ.race) return null;
  const mine = RACES[civ.race]?.war;
  if (!mine) return null;
  const era = Math.max(0, Math.min(7, civ.tech && Number.isFinite(civ.tech.era) ? civ.tech.era : 0));
  const w = Math.max(0.2, Math.min(0.8, (era - 3) / 4));
  const base = ERA_WAR[era];
  const v = mine.map((x, k) => (1 - w) * x + w * base[k]);
  if (v[6] > 0) {
    let keepers = 0;
    for (const sid of civ.settlementIds) { const s = world.settlements[sid]; const j = s && s.alive ? s.jobs : null; if (Array.isArray(j) && j[14] > 0) keepers += j[14]; }
    if (!(keepers > 0)) { v[1] += v[6]; v[6] = 0; }
  }
  return v;
}
// the era's own mix (as geo/army.js ERA_MIX), for blending a people's way of war into the age
const ERA_WAR = [
  [0.55, 0.15, 0.30, 0, 0, 0, 0], [0.45, 0.20, 0.25, 0.08, 0.02, 0, 0], [0.35, 0.25, 0.20, 0.13, 0.05, 0.02, 0], [0.30, 0.30, 0.15, 0.12, 0.08, 0.05, 0],
  [0.30, 0.20, 0.20, 0.10, 0.15, 0.05, 0], [0.25, 0.10, 0.40, 0.10, 0.08, 0.07, 0], [0.06, 0.03, 0.62, 0.08, 0.06, 0.15, 0], [0.05, 0.03, 0.60, 0.07, 0.10, 0.15, 0],
];

/** claimRule: a realm remembers its lost towns for its people's span. */
function claimRule(world, civ) {
  if (!isMythic(world) || !civ || !civ.race) return null;
  const m = RACES[civ.race]?.memory;
  return m ? { tau: m.claim, foundedTau: m.founded } : null;
}

/** memoryRule: a town remembers for the span of its largest people (its race when unmixed). */
function memoryRule(world, s) {
  if (!isMythic(world) || !s) return null;
  let race = s.race;
  const p = s.peoples;
  if (p && typeof p === 'object') { let best = 0; for (const r in p) if (p[r] > best && RACES[r]) { best = p[r]; race = r; } }
  const m = race ? RACES[race]?.memory : null;
  return m ? { grudge: m.grudge, thanks: m.thanks } : null;
}

function strife(world, key, civ) {
  if (!isMythic(world)) return null;
  const R = RACES[key];
  return R && R.strife ? R.strife : null;
}

function lifespan(world, civ, person) {
  if (!isMythic(world)) return 1;
  const race = (person && person.race) || (civ && civ.race);
  return race && RACES[race] ? RACES[race].life : 1;
}
/** sickness: how readily a people's notables fall into a lasting illness (elves seldom, orcs often). */
function sickness(world, civ, person) {
  if (!isMythic(world)) return 1;
  const race = (person && person.race) || (civ && civ.race);
  return race && RACES[race] ? fin(RACES[race].sickness, 1) : 1;
}

// ---------------------------------------------------------------------------
// The human gifts: ingenious (learning from others) and cosmopolitan

const LEARN_TRADE = 0.12;     // research on a tech a trading partner knows
const LEARN_CONTACT = 0.07;   // … that a people met (no trade) knows
const LEARN_CAP = 0.3;
const COSMO_K = 0.25;         // research and trade per unit share of other peoples
const COSMO_CAP = 0.1;

// arcane arts are taught by their own rules (arcana.js schoolAccess), never by this: the ids
// of the registered arcane techs, rebuilt when the registries change (code-derived, safe to lose)
let arcV = -1, ARC = new Set();
function isArcaneId(id) {
  const v = extVersion();
  if (v !== arcV) {
    arcV = v;
    ARC = new Set(getRegisteredTechs().filter((d) => d && d.branch === 'arcane').map((d) => d.id));
  }
  return ARC.has(id);
}

/**
 * The human gifts of a realm now: { learn, cosmo, others } (learn: research bonus on the tech it
 * studies, from the peoples it has met or trades with who know it; cosmo: the research and
 * trade bonus of a cosmopolitan realm; others: the share of other peoples in its towns), or
 * null for a realm that is not human or outside Mythic worlds. Pure: reads the realm's
 * relations, its peers' known techs and its towns' mixes (O(contacts + towns)).
 */
export function humanEdge(world, civ) {
  if (!isMythic(world) || !civ || civ.race !== 'human') return null;
  let learn = 0;
  const id = civ.tech?.research;
  if (typeof id === 'string' && !isArcaneId(id)) {
    const rels = civ.relations || {};
    for (const k in rels) {
      const o = world.civs[+k];
      if (!o || !o.alive || o.id === civ.id || !o.tech?.known || o.tech.known[id] == null) continue;
      learn += fin(rels[k]?.trade) > 0 ? LEARN_TRADE : LEARN_CONTACT;
      if (learn >= LEARN_CAP) { learn = LEARN_CAP; break; }
    }
  }
  let pop = 0, other = 0;
  for (const sid of civ.settlementIds || []) {
    const s = world.settlements[sid];
    if (!s || !s.alive) continue;
    const p = Math.max(0, fin(s.population));
    pop += p;
    const mix = s.peoples;
    if (mix && typeof mix === 'object') other += p * Math.max(0, 1 - fin(mix.human, 0));
    else if (s.race && s.race !== 'human') other += p;
  }
  const others = pop > 0 ? Math.min(1, other / pop) : 0;
  return { learn, cosmo: Math.min(COSMO_CAP, COSMO_K * others), others };
}

/** mods: the race's own modifiers, and for a human realm its gifts of the moment. */
function raceMods(world, civ) {
  if (!isMythic(world) || !civ || !civ.race) return null;
  const base = RACES[civ.race]?.mods || null;
  if (civ.race !== 'human') return base;
  const e = humanEdge(world, civ);
  if (!e || (e.learn <= 0 && e.cosmo <= 0)) return base;
  return [base, { research: e.learn + e.cosmo, trade: e.cosmo }];
}

/** Kinship and old hatreds between peoples (opinion and loyalty terms), −40 … +20. */
export const RACE_REL = (() => {
  const t = {};
  const set = (a, b, v) => { (t[a] ||= {})[b] = v; (t[b] ||= {})[a] = v; };
  for (const a of RACE_LIST) for (const b of RACE_LIST) set(a, b, a === b ? 10 : 0);
  // the old hatreds run deep (they are where every people's feelings return to, geo/folk.js)
  set('elf', 'orc', -60); set('dwarf', 'orc', -55); set('elf', 'dwarf', -15);
  set('human', 'halfling', 12); set('dwarf', 'halfling', 8); set('elf', 'halfling', 6);
  set('human', 'orc', -30); set('halfling', 'orc', -35);
  for (const r of RACE_LIST) if (r !== 'lizardfolk') set('lizardfolk', r, -20);
  set('orc', 'orc', -5);
  return t;
})();
export const raceRel = (a, b) => (a && b && RACE_REL[a] ? fin(RACE_REL[a][b], 0) : 0);

/** How much less loyal people of race r are under a crown of another race (single-race formula). */
function loyaltyTerm(r, civ) {
  const tol = fin(civ.traits?.tolerance, 0.5);
  const rel = raceRel(r, civ.race);
  return -0.08 * (1.3 - tol) - (rel <= -20 ? 0.06 : 0) + (rel >= 8 ? 0.03 : 0);
}
/**
 * loyalty: the peoples of a town who are not the ruling race are less content, the more so
 * across an old enmity: Σ share_r × term(r) over r ≠ the ruling race (a pure town of the
 * ruling race 0, a pure foreign town the single-race value).
 */
function loyalty(world, s, civ) {
  if (!isMythic(world) || !s || !civ || !civ.race) return 0;
  const p = s.peoples;
  if (p && typeof p === 'object') {
    let v = 0;
    for (const r in p) if (r !== civ.race && RACES[r] && p[r] > 0) v += p[r] * loyaltyTerm(r, civ);
    return v;
  }
  if (!s.race || s.race === civ.race) return 0;
  return loyaltyTerm(s.race, civ);
}

/**
 * Register the race providers. Called once by the myth module's index.js (not at import), so a
 * module that only reads the race table (civ/temper.js reads RACES[r].adapt) loads no myth
 * provider: `headless --determinism` then still runs its myth-free child without any of them.
 */
export function registerRaceProviders() {
  registerProvider('people', 'myth', peopleFor);
  registerProvider('habitat', 'myth', habitat);
  registerProvider('demography', 'myth', demography);
  registerProvider('lifespan', 'myth', lifespan);
  registerProvider('sickness', 'myth', sickness);
  registerProvider('peopleRates', 'myth', peopleRates);
  registerProvider('strife', 'myth', strife);
  registerProvider('claimRule', 'myth', claimRule);
  registerProvider('armyMix', 'myth', armyMix);
  registerProvider('memoryRule', 'myth', memoryRule);
  // the races' feelings start from the old fixed table (geo/folk.js)
  registerProvider('kinRule', 'myth', (world, a, b) => (isMythic(world) && a && b && a[0] === 'r' && b[0] === 'r' ? raceRel(a.slice(2), b.slice(2)) : null));
  registerProvider('mods', 'myth', raceMods);
  registerProvider('loyalty', 'myth', loyalty);
}
