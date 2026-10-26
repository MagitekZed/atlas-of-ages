// The arcane arts: seven schools of magic as a registered branch of the tech tree, the mod
// keys they move, and the providers through which magic touches battle, siege, disaster and
// diplomacy. Effects are real but capped (every key has a hard limit, battle ≤ ×1.6).
//
// Schools (techs with branch 'arcane', school, races, minMana, available, costMul,
// researchWeight; the arcane branch never counts toward the historical eras):
//   Wizardry (human; open to every people) · Sylvan Arts (elf) · Runecraft (dwarf) ·
//   Shamanism (orc) · Hearth-craft (halfling) · Serpent Rites (lizardfolk) · Necromancy (dark).
// A people learns its own school and Wizardry; a foreign race school only from a friendly
// neighbour of that race who knows it (cost × 1.5); Necromancy only under a cruel or
// intolerant crown. Costs fall with territory mana and rise as the weave thins (÷ weave).
//
// Mod keys (registerModKeys): arcana, wards, taming, luck, scrying, gates, necromancy,
// forestFarm, deepHalls, mortality (mul). Providers here: battle (× 1 + 0.5·arcana·mana,
// capped 1.6, plus racial home ground), siege (× 1 + 0.3·arcana, less against wards),
// damage (× 1 − luck for natural causes, × 1 − wards for dragons, curses, rifts and the
// dead), opinion (old enmities and kinship between races; everyone shuns necromancers).
//
// The code registries (mod keys, techs, buildings, wonders) are filled when the first Mythic
// world starts in this process (activateMyth), never at import: a Historical world must not
// see even neutral extra keys in its saved mods (headless --determinism).

import { registerProvider, registerModKeys, registerTechs, registerBuildings, registerWonders } from '../../core/ext.js';
import { BIOME } from '../../core/constants.js';
import { isMythic, fin, raceRel, bandOf } from './races.js';
import { BUILDINGS, WONDERS } from './identity.js';
import { manaCell, setArcaneIds, startMyth } from './mana.js';

let civTech = null;
try { civTech = await import('../civ/tech.js'); } catch (e) { /* civ tech table unavailable: built-in era costs */ }

// ---------------------------------------------------------------------------
// Schools

export const SCHOOLS = {
  wizardry: { id: 'wizardry', label: 'Wizardry', race: 'human', open: true, color: [120, 140, 226], desc: 'Learned magic of books and towers, open to any people who will study it.' },
  sylvan: { id: 'sylvan', label: 'Sylvan Arts', race: 'elf', color: [96, 196, 150], desc: 'Songs that shape the living wood and the moonlight in it.' },
  runecraft: { id: 'runecraft', label: 'Runecraft', race: 'dwarf', color: [214, 156, 82], desc: 'Runes cut in stone and steel, which hold what they are bidden to hold.' },
  shamanism: { id: 'shamanism', label: 'Shamanism', race: 'orc', color: [208, 96, 70], desc: 'Drums, blood and the spirits of the beasts.' },
  hearth: { id: 'hearth', label: 'Hearth-craft', race: 'halfling', color: [226, 196, 110], desc: 'Small, kindly magic of kitchens, gardens and good luck.' },
  serpent: { id: 'serpent', label: 'Serpent Rites', race: 'lizardfolk', color: [86, 178, 122], desc: 'Sun-blood rites and the visions of the egg-temples.' },
  necromancy: { id: 'necromancy', label: 'Necromancy', race: null, dark: true, color: [140, 120, 170], desc: 'The forbidden art of the grave, shunned by every people.' },
};
export const SCHOOL_OF_RACE = Object.fromEntries(Object.values(SCHOOLS).filter((s) => s.race).map((s) => [s.race, s.id]));

/** Era base cost: the median cost of the historical techs of that era (civ/tech.js), else the built-in table. */
const ERA_COST_FALLBACK = [5500, 45000, 430000, 1150000, 2400000, 4000000, 7000000, 16000000];
function eraCost(era) {
  const list = civTech?.TECHS?.filter?.((t) => t.era === era && Number.isFinite(t.cost)).map((t) => t.cost).sort((a, b) => a - b);
  return list && list.length ? list[list.length >> 1] : ERA_COST_FALLBACK[era] || ERA_COST_FALLBACK[0];
}

// [id, name, era, prereqs, fx, minMana, first, deed, costMul]
const DEFS = {
  wizardry: [
    ['hedge_magic', 'Hedge Magic', 0, [], { health: 0.02, arcana: 0.1 }, 0.15,
      'to practise hedge magic, charming fevers from the hearth', 'gathered the charms of the village wise-folk into a single grimoire', 0.5],
    ['augury', 'Augury', 1, ['hedge_magic'], { stability: 0.03, scrying: 0.2 }, 0.2,
      'to read the future in the flight of birds', 'foretold an eclipse to the very day', 0.55],
    ['sorcery', 'Sorcery', 2, ['augury'], { arcana: 0.3, military: 0.1 }, 0.3,
      'to bind fire and wind with spoken words', 'spoke the first true word of command over fire', 0.6],
    ['high_wizardry', 'High Wizardry', 4, ['sorcery'], { arcana: 0.4, research: 0.15, wards: 0.2 }, 0.35,
      'to found a college of high wizardry', 'set down the grammar of every school of magic in one great book', 0.6],
    ['waygates', 'Waygates', 5, ['high_wizardry'], { gates: 1, trade: 0.2, tradeRange: 8, movement: 0.1 }, 0.42,
      'to open waygates between distant cities', 'stepped through a ring of standing stones and out of another a hundred leagues away', 0.65],
  ],
  sylvan: [
    ['wood_singing', 'Wood-Singing', 0, [], { forestFarm: 0.5, gatherYield: 0.25 }, 0.2,
      'to sing the trees into giving fruit', 'sang an orchard out of a bare hillside in a single spring', 0.5],
    ['grove_wardens', 'Grove Wardens', 1, ['wood_singing'], { wards: 0.2, defense: 0.1 }, 0.25,
      'to set wardens in the groves who walk unseen', 'taught the forest to close its paths against strangers', 0.55],
    ['moonweaving', 'Moonweaving', 2, ['grove_wardens'], { medicine: 0.75, mortality: 0.88, plagueResist: 0.1 }, 0.3,
      'to weave healing from moonlight', 'healed a dying queen with thread spun from moonlight', 0.55],
    ['starsong', 'Starsong', 3, ['moonweaving'], { research: 0.2, culture: 0.2 }, 0.32,
      'to sing the names of the stars', 'learned the song the stars sing to one another', 0.6],
    ['awakening_trees', 'The Awakening of the Trees', 4, ['starsong'], { arcana: 0.3, defense: 0.15 }, 0.4,
      'to wake the trees and walk them to war', 'woke the eldest oak of the wood, and it walked', 0.65],
  ],
  runecraft: [
    ['deep_delving', 'Deep Delving', 0, [], { deepHalls: 1, mining: 0.3 }, 0.12,
      'to delve great halls beneath the mountains', 'found the stone that sings when a seam of ore runs near', 0.5],
    ['rune_carving', 'Rune-Carving', 1, ['deep_delving'], { defense: 0.35, wards: 0.25 }, 0.2,
      'to bind runes of warding into their walls', 'cut the first rune of warding over a city gate', 0.55],
    ['forge_runes', 'Forge-Runes', 2, ['rune_carving'], { military: 0.25, production: 0.15 }, 0.25,
      'to forge runes into blade and mail', 'forged an axe that would not dull', 0.55],
    ['golemcraft', 'Golemcraft', 4, ['forge_runes'], { production: 0.4 }, 0.32,
      'to raise golems of stone to labour for them', 'woke a man of stone that dug for a hundred years without rest', 0.6],
    ['star_forging', 'Star-Forging', 5, ['golemcraft'], { military: 0.3, siege: 0.4, arcana: 0.2 }, 0.4,
      'to forge weapons of starmetal', 'drew a sword from a fallen star', 0.65],
  ],
  shamanism: [
    ['blood_rites', 'Blood Rites', 0, [], { military: 0.15, stability: 0.02 }, 0.12,
      'to bind warriors to their chiefs in blood', 'drank the blood-oath that bound a hundred clans', 0.5],
    ['beast_calling', 'Beast-Calling', 1, ['blood_rites'], { taming: 0.5, movement: 0.15 }, 0.2,
      'to call the beasts of the wild to their side', 'rode a great wolf into battle', 0.55],
    ['spirit_drums', 'Spirit Drums', 2, ['beast_calling'], { stability: 0.04, military: 0.05 }, 0.25,
      'to beat the drums that call the ancestor spirits', 'drummed for nine nights until the dead answered', 0.55],
    ['storm_calling', 'Storm-Calling', 3, ['spirit_drums'], { arcana: 0.3, siege: 0.15 }, 0.3,
      'to call down the storm on their enemies', 'called a thunderstorm down upon an enemy camp', 0.6],
    ['warchief_ascendance', "Warchief's Ascendance", 4, ['storm_calling'], { military: 0.3, expansionRange: 2 }, 0.32,
      'to raise a warchief above all warchiefs by the spirits’ will', 'was crowned by the storm itself, the old songs say', 0.6],
  ],
  hearth: [
    ['bountiful_hearth', 'Bountiful Hearth', 0, [], { storage: 0.5, farmYield: 0.1 }, 0.1,
      'to bless the hearth so the larder is never bare', 'baked a loaf that fed a village through a hard winter', 0.5],
    ['luck_charms', 'Luck-Charms', 1, ['bountiful_hearth'], { luck: 0.25 }, 0.15,
      'to hang luck-charms over every door', 'walked unharmed out of a burning barn, a charm in each pocket', 0.55],
    ['hidden_ways', 'Hidden Ways', 2, ['luck_charms'], { defense: 0.2, scrying: 0.15 }, 0.2,
      'to hide their roads from unfriendly eyes', 'hid a whole shire from an invading host', 0.55],
    ['green_thumbs', 'Green Thumbs', 3, ['hidden_ways'], { farmYield: 0.3, soilCare: 0.3 }, 0.22,
      'to make any seed grow', 'grew a pumpkin the size of a cart', 0.6],
  ],
  serpent: [
    ['swamp_tending', 'Swamp-Tending', 0, [], { farmYield: 0.15, gatherYield: 0.15 }, 0.15,
      'to tend the swamps like gardens', 'raised floating gardens on the black water', 0.5],
    ['venom_lore', 'Venom Lore', 1, ['swamp_tending'], { military: 0.15, plagueResist: 0.15 }, 0.2,
      'to brew venoms and the cures for them', 'brewed a venom that cured as well as it killed', 0.55],
    ['sunblood_rites', 'Sun-Blood Rites', 2, ['venom_lore'], { birth: 0.2, culture: 0.1 }, 0.25,
      'to warm the eggs of the brood with sun-blood', 'warmed a clutch of stone eggs until they hatched', 0.55],
    ['egg_oracles', 'Egg-Temple Oracles', 3, ['sunblood_rites'], { scrying: 0.3, stability: 0.04 }, 0.28,
      'to read the future in the egg-temples', 'foretold the fall of a kingdom from the cracks of an egg', 0.6],
  ],
  necromancy: [
    ['necromancy', 'Necromancy', 2, [], { necromancy: 0.25, military: 0.1, stability: -0.04 }, 0.3,
      'to raise the dead to serve them', 'raised a dead general and sent him back to war', 0.6],
  ],
};

export const ARCANE_TECHS = [];
export const ARCANE_BY_ID = Object.create(null);
for (const [school, list] of Object.entries(DEFS)) {
  for (const [id, name, era, prereqs, fx, minMana, first, deed, cm] of list) {
    const def = {
      id, name, era, prereqs, fx, cat: 'arcane', first, deed, cost: Math.round(eraCost(era) * cm),
      branch: 'arcane', school, races: SCHOOLS[school].race ? [SCHOOLS[school].race] : [], minMana,
      available: (w, civ) => canLearn(w, civ, def),
      costMul: (w, civ) => costMul(w, civ, def),
      researchWeight: (w, civ) => researchWeight(w, civ, def),
    };
    ARCANE_TECHS.push(def);
    ARCANE_BY_ID[id] = def;
  }
}
setArcaneIds(ARCANE_TECHS.map((t) => t.id));
export const schoolTechs = (school) => ARCANE_TECHS.filter((t) => t.school === school);

const knows = (civ, id) => Boolean(civ?.tech?.known && civ.tech.known[id] != null);
/** Does the realm know any art of the school? */
const SCHOOL_IDS = {};
export function knowsSchool(civ, school) {
  const known = civ?.tech?.known;
  if (!known) return false;
  let ids = SCHOOL_IDS[school];
  if (!ids || !ids.length) ids = SCHOOL_IDS[school] = schoolTechs(school).map((t) => t.id);   // the arts are registered once
  for (let k = 0; k < ids.length; k++) if (known[ids[k]] != null) return true;
  return false;
}
const nativeSchool = (civ) => SCHOOL_OF_RACE[civ?.race] || 'wizardry';

/** Can this realm study the school at all (natively, by teaching, or by dark choice)? */
export function schoolAccess(world, civ, school) {
  const S = SCHOOLS[school];
  if (!S || !civ) return null;
  if (school === nativeSchool(civ) || S.open) return 'native';
  if (S.dark) {
    const cruel = (civ.ruler?.traits || []).some((t) => t === 'cruel' || t === 'mad');
    return cruel || fin(civ.traits?.tolerance, 0.5) < 0.32 ? 'dark' : null;
  }
  // a foreign race school: taught by a friendly neighbour of that race who knows its first art
  const first = DEFS[school]?.[0]?.[0];
  for (const k in civ.relations || {}) {
    const o = world.civs[+k];
    if (!o || !o.alive || o.race !== S.race || !knows(o, first)) continue;
    if (fin(civ.relations[k]?.opinion, 0) > 10) return 'taught';
  }
  return null;
}

function canLearn(world, civ, def) {
  if (!isMythic(world) || !civ || !civ.alive) return false;
  if (fin(civ.tech?.era, 0) < def.era) return false;
  const acc = schoolAccess(world, civ, def.school);
  if (!acc) return false;
  const need = def.minMana * (acc === 'native' ? 1 : 1.15);
  return fin(civ.arcane?.mana, 0) >= need;
}

function costMul(world, civ, def) {
  if (!isMythic(world)) return 1;
  const acc = schoolAccess(world, civ, def.school);
  const m = Math.min(1, fin(civ?.arcane?.mana, 0));
  const weave = Math.max(0.2, fin(world.sys.myth?.weave, 1));
  return ((acc === 'native' || acc == null) ? 1 : 1.5) * (1.25 - 0.35 * m) / weave;
}

function researchWeight(world, civ, def) {
  if (!isMythic(world) || !civ) return 0;
  const m = Math.min(1, fin(civ.arcane?.mana, 0));
  const t = civ.traits || {};
  const native = def.school === nativeSchool(civ) ? 1.15 : def.school === 'wizardry' ? 0.85 : 0.6;
  return (0.4 + 1.2 * m) * (0.6 + fin(t.innovation, 0.5) + fin(t.religiosity, 0.5)) / 2 * native;
}

// ---------------------------------------------------------------------------
// Registration (first Mythic world in this process)

export const MOD_KEYS = {
  arcana: { default: 0, limit: [0, 1.2], kind: 'add' },
  wards: { default: 0, limit: [0, 0.9], kind: 'add' },
  taming: { default: 0, limit: [0, 1], kind: 'add' },
  luck: { default: 0, limit: [0, 0.5], kind: 'add' },
  scrying: { default: 0, limit: [0, 1], kind: 'add' },
  gates: { default: 0, limit: [0, 1], kind: 'set' },
  necromancy: { default: 0, limit: [0, 1], kind: 'add' },
  forestFarm: { default: 0, limit: [0, 1], kind: 'add' },
  deepHalls: { default: 0, limit: [0, 1.5], kind: 'add' },
  mortality: { default: 1, limit: [0.5, 1.5], kind: 'mul' },
};
let registered = false;
/** Fill the code registries once (mod keys, arcane techs, racial buildings and wonders). */
export function registerArcana() {
  if (registered) return;
  registered = true;
  registerModKeys(MOD_KEYS);
  registerTechs(ARCANE_TECHS);
  registerBuildings(BUILDINGS);
  registerWonders(WONDERS);
}
export const arcanaRegistered = () => registered;

/** Wake the myth on a Mythic world: registries, state, fields and the ley network. */
export function activateMyth(world) {
  registerArcana();
  return startMyth(world);
}

// ---------------------------------------------------------------------------
// Providers

const civOf = (world, x) => (x == null ? null : typeof x === 'number' ? world.civs[x] || null : x.civId != null ? world.civs[x.civId] || null : null);
const modOf = (civ, k) => { const v = civ?.mods?.[k]; return typeof v === 'number' && Number.isFinite(v) ? v : 0; };
const isDefender = (side) => side === 'defender' || side === 'd' || side === -1 || side === 'def';
const FORESTS = new Set([BIOME.TAIGA, BIOME.TEMPERATE_FOREST, BIOME.TEMPERATE_RAINFOREST, BIOME.TROPICAL_FOREST, BIOME.RAINFOREST]);
const SWAMPS = new Set([BIOME.WETLAND, BIOME.RAINFOREST]);
const OPEN = new Set([BIOME.STEPPE, BIOME.SHRUBLAND, BIOME.SAVANNA, BIOME.COLD_DESERT, BIOME.TUNDRA]);

/** battle: magic in the field and racial home ground. ≤ × 1.6 (the point clamps to [0.5, 1.6]). */
function battle(world, q) {
  if (!isMythic(world) || !q || !q.army) return 1;
  const civ = civOf(world, q.army);
  if (!civ) return 1;
  const foe = civOf(world, q.enemy);
  const i = Number.isFinite(q.i) && q.i >= 0 && q.i < world.N ? q.i : Math.max(0, Math.min(world.N - 1, Math.round(fin(q.army.y)) * world.W + Math.round(fin(q.army.x))));
  const arc = Math.min(1.2, modOf(civ, 'arcana'));
  const mana = Math.min(1.2, manaCell(world, i));
  let m = 1 + 0.5 * arc * mana * (1 - 0.6 * Math.min(0.9, modOf(foe, 'wards')));
  m *= 1 + 0.08 * modOf(civ, 'scrying') + 0.18 * modOf(civ, 'necromancy');
  const b = world.f.biome[i];
  const def = isDefender(q.side);
  switch (civ.race) {
    case 'elf': if (FORESTS.has(b)) m *= knows(civ, 'grove_wardens') ? 1.22 : def ? 1.12 : 1.05; break;
    case 'dwarf': if (bandOf(world, i) >= 1) m *= def ? 1.15 : 1.06; break;
    case 'lizardfolk': if (SWAMPS.has(b)) m *= 1.12; break;
    case 'orc': if (OPEN.has(b) && !def) m *= 1.08; break;
    case 'halfling': if (def && knows(civ, 'hidden_ways')) m *= 1.1; break;
    default: break;
  }
  return m > 1.6 ? 1.6 : m;
}

/** siege: an attacker's magic speeds the siege, the defender's wards and deep halls slow it. */
function siege(world, q) {
  if (!isMythic(world) || !q || !q.army) return 1;
  const att = civOf(world, q.army);
  const s = q.s;
  const def = s ? world.civs[s.civId] : null;
  let m = (1 + 0.3 * Math.min(1.2, modOf(att, 'arcana'))) * (1 - 0.3 * Math.min(0.9, modOf(def, 'wards')));
  if (s && (s.race || def?.race) === 'dwarf' && fin(s.buildings?.deephall, 0) > 0) m *= 0.85;
  return m;
}

const NATURAL = /\b(?:earthquake|quake|storm|cyclone|hurricane|typhoon|flood|tsunami|eruption|erupt\w*|volcan\w*|lava|ashfall|fire|wildfire|blaze|meteor\w*|impact|locusts?|blizzard|drought|lightning|landfall)\b/;
const UNCANNY = /\b(?:dragon\w*|wyverns?|curse\w*|rifts?|undead|ghouls?|wights?|trolls?|giants?|krakens?|behemoths?|treants?|beasts?|blight\w*|wild ?magic|necro\w*)\b/;
/** damage: luck turns aside natural disaster, wards the uncanny. */
function damage(world, s, cause) {
  if (!isMythic(world) || !s) return 1;
  const civ = world.civs[s.civId];
  if (!civ) return 1;
  const c = typeof cause === 'string' ? cause.toLowerCase() : '';
  if (!c) return 1;
  let m = 1;
  if (UNCANNY.test(c)) m *= 1 - Math.min(0.9, modOf(civ, 'wards'));
  else if (NATURAL.test(c)) m *= (1 - Math.min(0.5, modOf(civ, 'luck'))) * (1 - 0.15 * Math.min(1, modOf(civ, 'scrying')));
  return m;
}

/** opinion (a of b): kinship and old hatreds between peoples; necromancers are shunned. */
function opinion(world, a, b) {
  if (!isMythic(world)) return 0;
  const A = civOf(world, a), Bc = civOf(world, b);
  if (!A || !Bc || A === Bc) return 0;
  let o = 0;
  if (A.race && Bc.race) o += raceRel(A.race, Bc.race) * (0.5 + (1 - fin(A.traits?.tolerance, 0.5)));
  const nb = modOf(Bc, 'necromancy');
  if (nb > 0 && modOf(A, 'necromancy') <= 0) o -= 20 * Math.min(1, nb / 0.25);
  return o;
}

registerProvider('battle', 'myth', battle);
registerProvider('siege', 'myth', siege);
registerProvider('damage', 'myth', damage);
registerProvider('opinion', 'myth', opinion);

// ---------------------------------------------------------------------------
// Reading a realm's arts (UI and reports)

/** A realm's progress in each school it can study: [{ school, known: [tech], next, access }]. */
export function schoolProgress(world, civ) {
  const out = [];
  if (!civ) return out;
  for (const S of Object.values(SCHOOLS)) {
    const techs = schoolTechs(S.id);
    const known = techs.filter((t) => knows(civ, t.id));
    const access = schoolAccess(world, civ, S.id);
    if (!known.length && !access) continue;
    const next = techs.find((t) => !knows(civ, t.id) && t.prereqs.every((p) => knows(civ, p))) || null;
    out.push({ school: S, known, total: techs.length, next, access, researching: civ.tech?.research && ARCANE_BY_ID[civ.tech.research]?.school === S.id ? ARCANE_BY_ID[civ.tech.research] : null });
  }
  return out;
}
/** Short label of a race's arts, e.g. "Runecraft". */
export const schoolLabel = (id) => SCHOOLS[id]?.label || 'Wizardry';
export const raceSchool = (race) => SCHOOLS[SCHOOL_OF_RACE[race] || 'wizardry'];
