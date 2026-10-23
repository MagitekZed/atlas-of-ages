// Shared enums and tables. Every module reads these; only the kernel edits them.

export const DAYS_PER_MONTH = 30;
export const MONTHS_PER_YEAR = 12;
export const DAYS_PER_YEAR = DAYS_PER_MONTH * MONTHS_PER_YEAR; // 360
export const KM_PER_TILE = 20;

/** Northern-hemisphere month names. Month 0 is midwinter in the north. */
export const MONTH_NAMES = [
  'Deepwinter', 'Icemelt', 'Seedtime', 'Rainmoon', 'Bloomtide', 'Highsun',
  'Midsummer', 'Goldfield', 'Harvest', 'Leaffall', 'Frostfall', 'Longnight',
];
export const SEASONS = ['Winter', 'Spring', 'Summer', 'Autumn'];
/** Northern season index for each month. Southern hemisphere = (n + 2) % 4. */
export const MONTH_SEASON = [0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 0];

export const MAP_SIZES = {
  preview: { w: 128, h: 80, label: 'Preview' },
  small: { w: 192, h: 120, label: 'Small' },
  medium: { w: 256, h: 160, label: 'Medium' },
  large: { w: 320, h: 200, label: 'Large' },
  vast: { w: 400, h: 250, label: 'Vast' },
};

export const WATER = { LAND: 0, OCEAN: 1, LAKE: 2 };

export const BIOME = {
  DEEP_OCEAN: 0, OCEAN: 1, LAKE: 2, ICE: 3, TUNDRA: 4, TAIGA: 5, STEPPE: 6, SHRUBLAND: 7,
  TEMPERATE_FOREST: 8, TEMPERATE_RAINFOREST: 9, HOT_DESERT: 10, COLD_DESERT: 11, SAVANNA: 12,
  TROPICAL_FOREST: 13, RAINFOREST: 14, WETLAND: 15, ALPINE: 16,
};

/**
 * Biome table, indexed by biome id.
 * vegMax: max vegetation biomass (0..1)      habit: settlement desirability (0..1)
 * wildFood: hunting/gathering yield factor   farm: agricultural suitability (0..1)
 * move: land travel cost multiplier          fire: flammability (0..1)
 * wood: timber per unit vegetation           herbCap: herbivore carrying capacity factor
 * fish: fish productivity (water biomes)
 */
export const BIOMES = [
  { id: 0, key: 'deep_ocean', name: 'Deep Ocean', color: [20, 44, 78], water: true, vegMax: 0, habit: 0, wildFood: 0, farm: 0, move: 0, fire: 0, wood: 0, herbCap: 0, fish: 0.35 },
  { id: 1, key: 'ocean', name: 'Coastal Sea', color: [40, 92, 132], water: true, vegMax: 0, habit: 0, wildFood: 0, farm: 0, move: 0, fire: 0, wood: 0, herbCap: 0, fish: 1.0 },
  { id: 2, key: 'lake', name: 'Lake', color: [56, 110, 146], water: true, vegMax: 0, habit: 0, wildFood: 0, farm: 0, move: 0, fire: 0, wood: 0, herbCap: 0, fish: 0.8 },
  { id: 3, key: 'ice', name: 'Ice Sheet', color: [232, 238, 243], water: false, vegMax: 0.02, habit: 0.02, wildFood: 0.05, farm: 0, move: 3.0, fire: 0, wood: 0, herbCap: 0.05, fish: 0 },
  { id: 4, key: 'tundra', name: 'Tundra', color: [148, 154, 128], water: false, vegMax: 0.25, habit: 0.15, wildFood: 0.3, farm: 0.05, move: 1.6, fire: 0.1, wood: 0.05, herbCap: 0.45, fish: 0 },
  { id: 5, key: 'taiga', name: 'Boreal Forest', color: [58, 92, 68], water: false, vegMax: 0.75, habit: 0.3, wildFood: 0.45, farm: 0.2, move: 1.8, fire: 0.6, wood: 1.0, herbCap: 0.5, fish: 0 },
  { id: 6, key: 'steppe', name: 'Grassland', color: [158, 166, 98], water: false, vegMax: 0.45, habit: 0.6, wildFood: 0.6, farm: 0.7, move: 1.0, fire: 0.7, wood: 0.1, herbCap: 0.9, fish: 0 },
  { id: 7, key: 'shrubland', name: 'Shrubland', color: [148, 142, 90], water: false, vegMax: 0.45, habit: 0.6, wildFood: 0.5, farm: 0.6, move: 1.2, fire: 0.9, wood: 0.3, herbCap: 0.6, fish: 0 },
  { id: 8, key: 'temperate_forest', name: 'Temperate Forest', color: [72, 120, 64], water: false, vegMax: 0.9, habit: 0.7, wildFood: 0.7, farm: 0.85, move: 1.5, fire: 0.4, wood: 1.0, herbCap: 0.7, fish: 0 },
  { id: 9, key: 'temperate_rainforest', name: 'Temperate Rainforest', color: [42, 100, 68], water: false, vegMax: 1.0, habit: 0.5, wildFood: 0.6, farm: 0.6, move: 1.9, fire: 0.15, wood: 1.0, herbCap: 0.6, fish: 0 },
  { id: 10, key: 'hot_desert', name: 'Hot Desert', color: [214, 188, 130], water: false, vegMax: 0.06, habit: 0.08, wildFood: 0.1, farm: 0.05, move: 1.6, fire: 0.05, wood: 0, herbCap: 0.1, fish: 0 },
  { id: 11, key: 'cold_desert', name: 'Cold Desert', color: [168, 158, 128], water: false, vegMax: 0.1, habit: 0.1, wildFood: 0.15, farm: 0.08, move: 1.5, fire: 0.05, wood: 0.02, herbCap: 0.2, fish: 0 },
  { id: 12, key: 'savanna', name: 'Savanna', color: [176, 168, 90], water: false, vegMax: 0.5, habit: 0.6, wildFood: 0.75, farm: 0.6, move: 1.1, fire: 1.0, wood: 0.2, herbCap: 1.0, fish: 0 },
  { id: 13, key: 'tropical_forest', name: 'Tropical Dry Forest', color: [94, 134, 60], water: false, vegMax: 0.85, habit: 0.6, wildFood: 0.8, farm: 0.7, move: 1.7, fire: 0.5, wood: 0.9, herbCap: 0.7, fish: 0 },
  { id: 14, key: 'rainforest', name: 'Tropical Rainforest', color: [36, 106, 50], water: false, vegMax: 1.0, habit: 0.35, wildFood: 0.7, farm: 0.4, move: 2.4, fire: 0.1, wood: 1.0, herbCap: 0.6, fish: 0 },
  { id: 15, key: 'wetland', name: 'Wetland', color: [80, 114, 90], water: false, vegMax: 0.8, habit: 0.35, wildFood: 0.8, farm: 0.5, move: 2.2, fire: 0.1, wood: 0.3, herbCap: 0.7, fish: 0.3 },
  { id: 16, key: 'alpine', name: 'Alpine', color: [138, 134, 122], water: false, vegMax: 0.15, habit: 0.1, wildFood: 0.2, farm: 0.05, move: 3.0, fire: 0.1, wood: 0.1, herbCap: 0.3, fish: 0 },
];

export const ERAS = [
  { id: 0, name: 'Stone Age' },
  { id: 1, name: 'Bronze Age' },
  { id: 2, name: 'Iron Age' },
  { id: 3, name: 'Classical Age' },
  { id: 4, name: 'Medieval Age' },
  { id: 5, name: 'Renaissance' },
  { id: 6, name: 'Industrial Age' },
  { id: 7, name: 'Modern Age' },
];

/** Settlement size tiers by population. */
export const TIERS = [
  { id: 0, name: 'Camp', minPop: 0 },
  { id: 1, name: 'Hamlet', minPop: 100 },
  { id: 2, name: 'Village', minPop: 500 },
  { id: 3, name: 'Town', minPop: 2000 },
  { id: 4, name: 'City', minPop: 10000 },
  { id: 5, name: 'Great City', minPop: 50000 },
  { id: 6, name: 'Metropolis', minPop: 250000 },
];
export function tierForPop(pop) {
  for (let t = TIERS.length - 1; t >= 0; t--) if (pop >= TIERS[t].minPop) return t;
  return 0;
}

/**
 * Special resource deposits (f.resource ids).
 * kind: 'strategic' | 'luxury' | 'bulk'.  era: era in which it becomes useful.  value: trade value weight.
 */
export const RESOURCES = [
  { id: 0, key: 'none', name: 'None', kind: 'none', era: 0, value: 0, color: [0, 0, 0] },
  { id: 1, key: 'copper', name: 'Copper', kind: 'strategic', era: 1, value: 2, color: [196, 112, 64] },
  { id: 2, key: 'tin', name: 'Tin', kind: 'strategic', era: 1, value: 2, color: [170, 176, 182] },
  { id: 3, key: 'iron', name: 'Iron', kind: 'strategic', era: 2, value: 2.5, color: [120, 110, 112] },
  { id: 4, key: 'gold', name: 'Gold', kind: 'luxury', era: 0, value: 5, color: [232, 192, 64] },
  { id: 5, key: 'gems', name: 'Gems', kind: 'luxury', era: 0, value: 5, color: [170, 70, 200] },
  { id: 6, key: 'marble', name: 'Marble', kind: 'bulk', era: 3, value: 2, color: [236, 232, 222] },
  { id: 7, key: 'horses', name: 'Horses', kind: 'strategic', era: 1, value: 2.5, color: [150, 100, 60] },
  { id: 8, key: 'spices', name: 'Spices', kind: 'luxury', era: 0, value: 4, color: [214, 96, 40] },
  { id: 9, key: 'salt', name: 'Salt', kind: 'bulk', era: 0, value: 2, color: [240, 240, 240] },
  { id: 10, key: 'furs', name: 'Furs', kind: 'luxury', era: 0, value: 3, color: [120, 84, 56] },
  { id: 11, key: 'coal', name: 'Coal', kind: 'strategic', era: 6, value: 3, color: [40, 40, 44] },
  { id: 12, key: 'oil', name: 'Oil', kind: 'strategic', era: 7, value: 4, color: [20, 20, 24] },
  // Mythic deposits. Gen never places these: starmetal comes from starfall and ley workings,
  // dragonbone from a slain dragon's lair (WP2 / WP5).
  { id: 13, key: 'starmetal', name: 'Starmetal', kind: 'strategic', era: 2, value: 6, color: [150, 172, 224] },
  { id: 14, key: 'dragonbone', name: 'Dragonbone', kind: 'luxury', era: 0, value: 5, color: [226, 214, 186] },
];

/** Chronicle categories. color: mid-tone that reads on light and dark grounds. */
export const CATEGORIES = {
  civ: { label: 'Nations', color: '#c9a24a' },
  war: { label: 'War', color: '#d0533f' },
  diplomacy: { label: 'Diplomacy', color: '#5e9fd6' },
  religion: { label: 'Faith', color: '#b884d8' },
  disease: { label: 'Plague', color: '#8db04a' },
  tech: { label: 'Discovery', color: '#43b3a3' },
  culture: { label: 'Culture', color: '#e08fb0' },
  trade: { label: 'Trade', color: '#d99a3e' },
  nature: { label: 'Nature', color: '#6aa86a' },
  climate: { label: 'Climate', color: '#6fb6cf' },
  disaster: { label: 'Catastrophe', color: '#e2703a' },
  divine: { label: 'Divine Hand', color: '#e8d48a' },
  myth: { label: 'Myth & Magic', color: '#a98be6' },
};

/**
 * God-tool palette groups, in display order (core/tools.js re-exports this).
 * A group with no registered tool is never shown.
 */
export const TOOL_GROUPS = [
  { id: 'terrain', label: 'Shape the Land' },
  { id: 'weather', label: 'Command the Sky' },
  { id: 'life', label: 'Tend Life' },
  { id: 'catastrophe', label: 'Unleash Catastrophe' },
  { id: 'peoples', label: 'Guide Peoples' },
  { id: 'fate', label: 'Weave Fate' },
  { id: 'myth', label: 'Stir the Uncanny' },
];

/**
 * Entity kinds a chronicle entry may reference: entry.ref = { k: REF_KIND, id }.
 * The UI opens the matching view (src/ui/registry.js registerView) for each.
 */
export const REF_KINDS = [
  'civ', 'settlement', 'war', 'army', 'plague', 'religion', 'volcano', 'storm', 'figure',
  'route', 'wonder', 'fire', 'band', 'site', 'ruler', 'dynasty', 'event',
];

/**
 * Peoples of a Mythic world (mythLevel 2). civ.race / settlement.race hold one of these keys
 * or null (Historical worlds: everyone is simply people). The races themselves — niches,
 * lifespans, tongues — are WP5's (src/sim/myth/races.js); this is display metadata only.
 * color: [r, g, b] hue family; symbol: glyph drawn at small zoom.
 */
export const RACE_META = {
  human: { label: 'Human', plural: 'Humans', adjective: 'Human', color: [178, 136, 94], symbol: 'round' },
  elf: { label: 'Elf', plural: 'Elves', adjective: 'Elven', color: [62, 160, 158], symbol: 'leaf' },
  dwarf: { label: 'Dwarf', plural: 'Dwarves', adjective: 'Dwarven', color: [116, 126, 146], symbol: 'diamond' },
  orc: { label: 'Orc', plural: 'Orcs', adjective: 'Orcish', color: [180, 82, 50], symbol: 'spike' },
  halfling: { label: 'Halfling', plural: 'Halflings', adjective: 'Halfling', color: [216, 182, 96], symbol: 'mound' },
  lizardfolk: { label: 'Lizardfolk', plural: 'Lizardfolk', adjective: 'Saurian', color: [112, 164, 68], symbol: 'scale' },
};
export const RACE_KEYS = Object.keys(RACE_META);

/**
 * Roaming band kinds (core/bands.js; behaviour is WP2's). family: outlaw | host | beast | spirit.
 * glyph: renderer glyph key. flags: sea (moves on water), fly (ignores terrain),
 * mythic (exists only when mythOn(world)).
 */
export const BAND_KINDS = {
  bandits: { label: 'Bandits', family: 'outlaw', glyph: 'campfire', flags: {} },
  pirates: { label: 'Pirates', family: 'outlaw', glyph: 'blacksail', flags: { sea: true } },
  company: { label: 'Free Company', family: 'outlaw', glyph: 'banner', flags: {} },
  horde: { label: 'Horde', family: 'host', glyph: 'horsetail', flags: {} },
  migration: { label: 'Migration', family: 'host', glyph: 'wagons', flags: {} },
  dragon: { label: 'Dragon', family: 'beast', glyph: 'dragon', flags: { fly: true, mythic: true } },
  wyvern: { label: 'Wyvern', family: 'beast', glyph: 'wyvern', flags: { fly: true, mythic: true } },
  troll: { label: 'Troll', family: 'beast', glyph: 'troll', flags: { mythic: true } },
  giant: { label: 'Giant', family: 'beast', glyph: 'giant', flags: { mythic: true } },
  treant: { label: 'Treant', family: 'beast', glyph: 'treant', flags: { mythic: true } },
  kraken: { label: 'Kraken', family: 'beast', glyph: 'kraken', flags: { sea: true, mythic: true } },
  behemoth: { label: 'Behemoth', family: 'beast', glyph: 'behemoth', flags: { mythic: true } },
  undead: { label: 'Undead', family: 'spirit', glyph: 'undead', flags: { mythic: true } },
};
export const BAND_STATES = ['lair', 'sleep', 'roam', 'raid', 'return', 'hired', 'tamed', 'settling'];

/** Simulation speeds in simulated days per real second. */
export const SPEEDS = [
  { id: 'pause', label: 'Paused', dps: 0 },
  { id: 'slow', label: 'Slow', dps: 2 },
  { id: 'normal', label: 'Normal', dps: 8 },
  { id: 'fast', label: 'Fast', dps: 30 },
  { id: 'faster', label: 'Faster', dps: 120 },
  { id: 'rapid', label: 'Rapid', dps: 360 },
  { id: 'max', label: 'Max', dps: Infinity },
];
