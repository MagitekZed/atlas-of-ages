// Genesis and live parameters. The UI builds every control from PARAMS.
// live: true  → adjustable while the simulation runs (systems must read world.params each time).
// live: false → only meaningful at world generation (setParam refuses them unless forced).
// type: 'range' | 'select' | 'bool' | 'text'.
// visibleIf?: { key, min } — the control is shown only while params[key] >= min
//   (e.g. the Mythic sliders appear once mythLevel reaches 2). Hidden params keep their value.
// Every new param defaults to a neutral value: a world made with the defaults behaves exactly
// as it did before the param existed.

export const PARAM_GROUPS = [
  { id: 'world', label: 'Land & Sea', desc: 'The shape of the planet: continents, mountains, rivers.' },
  { id: 'climate', label: 'Climate', desc: 'Sunlight, seasons, wind and rain.' },
  { id: 'life', label: 'Life', desc: 'Forests, grasslands, herds and their hunters.' },
  { id: 'civ', label: 'Peoples', desc: 'How the first tribes grow, believe, trade and fight.' },
  { id: 'catastrophe', label: 'Catastrophe', desc: 'Quakes, fire mountains, falling stars, storms and plague.' },
  { id: 'myth', label: 'Myth & Magic', desc: 'Elder races, ley lines, dragons and the hands of gods.' },
];

export const PARAMS = [
  // --- Land & Sea -----------------------------------------------------------
  { key: 'worldSize', group: 'world', label: 'World size', type: 'select', default: 'medium', live: false,
    options: [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large'], ['vast', 'Vast']],
    desc: 'Map dimensions. Larger worlds hold more nations but simulate more slowly.' },
  { key: 'oceanCoverage', group: 'world', label: 'Ocean coverage', type: 'range', min: 0.25, max: 0.9, step: 0.01, default: 0.6, live: false, unit: '%', display: 'percent',
    desc: 'Share of the surface below sea level.' },
  { key: 'continents', group: 'world', label: 'Continents', type: 'range', min: 1, max: 12, step: 1, default: 4, live: false,
    desc: 'Number of continental plates that rise above the sea.' },
  { key: 'fragmentation', group: 'world', label: 'Coast fragmentation', type: 'range', min: 0, max: 1, step: 0.01, default: 0.35, live: false,
    desc: 'Higher values break coastlines into peninsulas, archipelagos and inlets.' },
  { key: 'mountainHeight', group: 'world', label: 'Mountain height', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5, live: false,
    desc: 'How violently colliding plates fold the crust into ranges.' },
  { key: 'plateCount', group: 'world', label: 'Tectonic plates', type: 'range', min: 4, max: 24, step: 1, default: 12, live: false,
    desc: 'More plates mean more fault lines, ranges and volcanic arcs.' },
  { key: 'erosion', group: 'world', label: 'Erosion', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5, live: false,
    desc: 'Ages of rain carving valleys and softening peaks.' },
  { key: 'riverDensity', group: 'world', label: 'River density', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5, live: false,
    desc: 'How readily runoff gathers into visible rivers.' },
  { key: 'worldName', group: 'world', label: 'World name', type: 'text', default: '', live: false, maxLength: 40,
    desc: 'Name the world yourself, or leave blank for a name in its own first tongue.' },

  // --- Climate --------------------------------------------------------------
  { key: 'baseTemperature', group: 'climate', label: 'Global temperature', type: 'range', min: -12, max: 12, step: 0.5, default: 0, live: true, unit: '°C', display: 'signed',
    desc: 'Offset from an Earth-like baseline. Negative values bring ice ages; positive, a hothouse.' },
  { key: 'axialTilt', group: 'climate', label: 'Axial tilt', type: 'range', min: 0, max: 45, step: 1, default: 23, live: true, unit: '°',
    desc: 'Controls how harsh the seasons are. Zero tilt means an endless spring.' },
  { key: 'humidity', group: 'climate', label: 'Rainfall', type: 'range', min: 0.2, max: 2, step: 0.05, default: 1, live: true, display: 'multiplier',
    desc: 'Multiplier on evaporation and precipitation worldwide.' },
  { key: 'windStrength', group: 'climate', label: 'Wind strength', type: 'range', min: 0, max: 2, step: 0.05, default: 1, live: true, display: 'multiplier',
    desc: 'How far prevailing winds carry moisture inland.' },
  { key: 'climateVolatility', group: 'climate', label: 'Climate volatility', type: 'range', min: 0, max: 1, step: 0.01, default: 0.3, live: true,
    desc: 'Natural drift between warm periods and ice ages.' },
  { key: 'dynamicSeaLevel', group: 'climate', label: 'Ice affects sea level', type: 'bool', default: true, live: true,
    desc: 'Melting ice raises the seas and drowns coasts; growing ice sheets expose land bridges.' },
  { key: 'seaLevelOffset', group: 'climate', label: 'Sea level shift', type: 'range', min: -0.12, max: 0.12, step: 0.005, default: 0, live: true, display: 'signed',
    desc: 'Directly raise or lower the oceans.' },

  // --- Life -----------------------------------------------------------------
  { key: 'soilFertility', group: 'life', label: 'Soil fertility', type: 'range', min: 0.3, max: 2, step: 0.05, default: 1, live: true, display: 'multiplier',
    desc: 'Richness of the land for wild plants and crops.' },
  { key: 'vegetationGrowth', group: 'life', label: 'Plant growth', type: 'range', min: 0.2, max: 3, step: 0.05, default: 1, live: true, display: 'multiplier',
    desc: 'How quickly forests and grasslands regrow.' },
  { key: 'faunaAbundance', group: 'life', label: 'Wild herds', type: 'range', min: 0, max: 2, step: 0.05, default: 1, live: true, display: 'multiplier',
    desc: 'Abundance of grazing animals.' },
  { key: 'predatorRatio', group: 'life', label: 'Predators', type: 'range', min: 0, max: 2, step: 0.05, default: 1, live: true, display: 'multiplier',
    desc: 'Strength of wolves, great cats and other hunters.' },
  { key: 'fishAbundance', group: 'life', label: 'Fish stocks', type: 'range', min: 0, max: 2, step: 0.05, default: 1, live: true, display: 'multiplier',
    desc: 'Richness of seas and lakes.' },
  { key: 'wildfireRate', group: 'life', label: 'Wildfires', type: 'range', min: 0, max: 3, step: 0.05, default: 1, live: true, display: 'multiplier',
    desc: 'Frequency of lightning fires in dry seasons.' },

  // --- Peoples --------------------------------------------------------------
  { key: 'civCount', group: 'civ', label: 'First tribes', type: 'range', min: 0, max: 24, step: 1, default: 7, live: false,
    desc: 'Peoples present at the dawn of history.' },
  { key: 'startingEra', group: 'civ', label: 'Starting era', type: 'select', default: 0, live: false,
    options: [[0, 'Stone Age'], [1, 'Bronze Age'], [2, 'Iron Age'], [3, 'Classical Age']],
    desc: 'Begin history later, with knowledge already won.' },
  { key: 'emergenceRate', group: 'civ', label: 'New peoples', type: 'range', min: 0, max: 3, step: 0.05, default: 1, live: true, display: 'multiplier',
    desc: 'How often new tribes arise in empty, fertile land.' },
  { key: 'birthRate', group: 'civ', label: 'Birth rate', type: 'range', min: 0.5, max: 2, step: 0.05, default: 1, live: true, display: 'multiplier',
    desc: 'Population growth when food is plentiful.' },
  { key: 'techRate', group: 'civ', label: 'Pace of discovery', type: 'range', min: 0.2, max: 5, step: 0.05, default: 1, live: true, display: 'multiplier',
    desc: 'Speed of research and the march through the ages.' },
  { key: 'aggression', group: 'civ', label: 'Aggression', type: 'range', min: 0, max: 2, step: 0.05, default: 1, live: true, display: 'multiplier',
    desc: 'Willingness of nations to go to war.' },
  { key: 'expansionism', group: 'civ', label: 'Expansion', type: 'range', min: 0, max: 2, step: 0.05, default: 1, live: true, display: 'multiplier',
    desc: 'Drive to send settlers and found new towns.' },
  { key: 'religiosity', group: 'civ', label: 'Religiosity', type: 'range', min: 0, max: 2, step: 0.05, default: 1, live: true, display: 'multiplier',
    desc: 'Frequency of prophets and the zeal of their followers.' },
  { key: 'tradePropensity', group: 'civ', label: 'Trade', type: 'range', min: 0, max: 2, step: 0.05, default: 1, live: true, display: 'multiplier',
    desc: 'Appetite for trade routes, caravans and shipping.' },
  { key: 'stabilityFactor', group: 'civ', label: 'Political stability', type: 'range', min: 0.3, max: 2, step: 0.05, default: 1, live: true, display: 'multiplier',
    desc: 'Higher values mean fewer rebellions, civil wars and collapses.' },
  { key: 'migration', group: 'civ', label: 'Migration', type: 'range', min: 0, max: 2, step: 0.05, default: 1, live: true, display: 'multiplier',
    desc: 'How readily people flee famine and war for better lands.' },
  { key: 'fortune', group: 'civ', label: 'Fortune', type: 'range', min: 0, max: 2, step: 0.05, default: 1, live: true, display: 'multiplier',
    desc: 'How often history lurches: fires, riots, booms, black swans and turns of fate.' },
  { key: 'worldAges', group: 'civ', label: 'World ages', type: 'bool', default: true, live: true,
    desc: 'Long ages of plenty, darkness or contact colour whole centuries.' },
  { key: 'banditry', group: 'civ', label: 'Banditry', type: 'range', min: 0, max: 3, step: 0.05, default: 1, live: true, display: 'multiplier',
    desc: 'Brigands, pirates and raiders on the margins of every realm.' },

  // --- Catastrophe ----------------------------------------------------------
  { key: 'disasterRate', group: 'catastrophe', label: 'Disaster frequency', type: 'range', min: 0, max: 3, step: 0.05, default: 1, live: true, display: 'multiplier',
    desc: 'Master multiplier for every natural catastrophe.' },
  { key: 'seismicity', group: 'catastrophe', label: 'Earthquakes', type: 'range', min: 0, max: 3, step: 0.05, default: 1, live: true, display: 'multiplier',
    desc: 'Activity along plate boundaries; undersea quakes raise tsunamis.' },
  { key: 'volcanism', group: 'catastrophe', label: 'Volcanism', type: 'range', min: 0, max: 3, step: 0.05, default: 1, live: true, display: 'multiplier',
    desc: 'Number and temper of volcanoes. Great eruptions darken the sky for years.' },
  { key: 'meteorRate', group: 'catastrophe', label: 'Falling stars', type: 'range', min: 0, max: 3, step: 0.05, default: 0.5, live: true, display: 'multiplier',
    desc: 'Meteor impacts, from village-wreckers to world-enders.' },
  { key: 'stormRate', group: 'catastrophe', label: 'Great storms', type: 'range', min: 0, max: 3, step: 0.05, default: 1, live: true, display: 'multiplier',
    desc: 'Cyclones, blizzards and thunderstorms.' },
  { key: 'plagueRate', group: 'catastrophe', label: 'Plague outbreaks', type: 'range', min: 0, max: 3, step: 0.05, default: 1, live: true, display: 'multiplier',
    desc: 'How often new diseases emerge in crowded places.' },
  { key: 'plagueLethality', group: 'catastrophe', label: 'Plague lethality', type: 'range', min: 0, max: 3, step: 0.05, default: 1, live: true, display: 'multiplier',
    desc: 'How deadly those diseases are.' },

  // --- Myth & Magic ---------------------------------------------------------
  // mythLevel is the one dial (SPEC §11): 0 Historical (nothing mythic), 1 Legendary
  // (belief-only folklore), 2 Mythic (races, magic, beasts). Not live: it changes mid-run only
  // through setParam(world, 'mythLevel', 2, { force: true, log: true }), as the Awaken Magic act
  // does; the myth wakes at once on that change (the paramChanged hook), the old peoples human.
  { key: 'mythLevel', group: 'myth', label: 'Age of the world', type: 'select', default: 0, live: false,
    options: [[0, 'Historical'], [1, 'Legendary'], [2, 'Mythic']],
    desc: 'Historical worlds hold only people. Legendary worlds believe in wonders; Mythic worlds have them.' },
  { key: 'magicStrength', group: 'myth', label: 'Magic', type: 'range', min: 0, max: 2, step: 0.05, default: 1, live: true, display: 'multiplier',
    visibleIf: { key: 'mythLevel', min: 2 },
    desc: 'Strength of the ley lines and of every arcane art drawn from them.' },
  { key: 'monsterAbundance', group: 'myth', label: 'Monsters', type: 'range', min: 0, max: 3, step: 0.05, default: 1, live: true, display: 'multiplier',
    visibleIf: { key: 'mythLevel', min: 2 },
    desc: 'How many dragons, trolls, giants and krakens haunt the wild places.' },
  { key: 'divineIntervention', group: 'myth', label: 'Gods answer', type: 'range', min: 0, max: 3, step: 0.05, default: 1, live: true, display: 'multiplier',
    visibleIf: { key: 'mythLevel', min: 1 },
    desc: 'How often the gods of the faithful answer prayers in sieges, famines and plagues.' },
  { key: 'wildMagic', group: 'myth', label: 'Wild magic', type: 'range', min: 0, max: 3, step: 0.05, default: 1, live: true, display: 'multiplier',
    visibleIf: { key: 'mythLevel', min: 2 },
    desc: 'Rifts, enchanted woods and stranger phenomena where the weave runs thick.' },
  { key: 'raceMix', group: 'myth', label: 'Peoples of the world', type: 'select', default: 'mixed', live: false,
    options: [['mixed', 'Mixed'], ['humanDominant', 'Mostly human'], ['elderRaces', 'Elder races'], ['monstrous', 'Monstrous']],
    visibleIf: { key: 'mythLevel', min: 2 },
    desc: 'Which races the first tribes are drawn from.' },
  { key: 'fading', group: 'myth', label: 'The Fading', type: 'bool', default: true, live: true,
    visibleIf: { key: 'mythLevel', min: 2 },
    desc: 'Smoke and industry thin the weave; magic ebbs as the machine age rises.' },
];

export const PARAM_BY_KEY = Object.fromEntries(PARAMS.map((p) => [p.key, p]));

export function defaultParams() {
  const out = { seed: 'atlas' };
  for (const p of PARAMS) out[p.key] = p.default;
  return out;
}

/** Validate and coerce a value for a param key. Returns the stored value. */
export function coerceParam(key, value) {
  const p = PARAM_BY_KEY[key];
  if (!p) return value;
  if (p.type === 'range') {
    let v = Number(value);
    if (!Number.isFinite(v)) v = p.default;
    return Math.min(p.max, Math.max(p.min, v));
  }
  if (p.type === 'bool') return Boolean(value);
  if (p.type === 'text') {
    // plain single-line text: no control characters, collapsed spaces, bounded length
    const t = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return t.slice(0, p.maxLength || 40);
  }
  if (p.type === 'select') {
    const ok = p.options.find(([v]) => String(v) === String(value));
    return ok ? ok[0] : p.default;
  }
  return value;
}

/** True when the param's visibleIf condition (if any) holds for these params. */
export function paramVisible(p, params) {
  const c = p && p.visibleIf;
  if (!c) return true;
  return Number(params?.[c.key] ?? PARAM_BY_KEY[c.key]?.default ?? 0) >= c.min;
}

/** The world's myth level: 0 Historical, 1 Legendary, 2 Mythic (SPEC §11). */
export function mythLevel(world) {
  const v = Number(world?.params?.mythLevel);
  return v >= 2 ? 2 : v >= 1 ? 1 : 0;
}
/** True when the world is at least at myth level min (default 2, Mythic). */
export const mythOn = (world, min = 2) => mythLevel(world) >= min;

/**
 * Named starting configurations. Each overrides a subset of defaultParams().
 * mode: 'mythic' marks presets that set mythLevel (the genesis screen groups them).
 */
export const PRESETS = [
  { id: 'earthlike', label: 'Earthlike', desc: 'Four continents, temperate seas, seven peoples.', params: {} },
  { id: 'pangaea', label: 'Pangaea', desc: 'One great supercontinent with a dry heart.',
    params: { continents: 1, oceanCoverage: 0.5, fragmentation: 0.2, plateCount: 9, civCount: 10 } },
  { id: 'archipelago', label: 'Archipelago', desc: 'A thousand islands; sailors rule.',
    params: { continents: 10, oceanCoverage: 0.74, fragmentation: 0.85, plateCount: 18, civCount: 9, tradePropensity: 1.4 } },
  { id: 'iceage', label: 'Ice Age', desc: 'Glaciers grip the north; low seas expose land bridges.',
    params: { baseTemperature: -8, oceanCoverage: 0.55, climateVolatility: 0.5, civCount: 6 } },
  { id: 'hothouse', label: 'Hothouse', desc: 'No polar ice, steaming jungles and fierce storms.',
    params: { baseTemperature: 8, humidity: 1.4, stormRate: 2, oceanCoverage: 0.66 } },
  { id: 'dune', label: 'Desert World', desc: 'Scarce water. Every river is a lifeline.',
    params: { oceanCoverage: 0.32, humidity: 0.35, baseTemperature: 4, riverDensity: 0.7, civCount: 6 } },
  { id: 'waterworld', label: 'Waterworld', desc: 'Scattered islands on an endless ocean.',
    params: { oceanCoverage: 0.88, continents: 6, fragmentation: 0.7, civCount: 5 } },
  { id: 'highlands', label: 'Highlands', desc: 'Towering ranges split the land into isolated valleys.',
    params: { mountainHeight: 0.95, plateCount: 20, erosion: 0.3, civCount: 12 } },
  { id: 'garden', label: 'Peaceful Garden', desc: 'Gentle climate, rich soil, slow tempers.',
    params: { aggression: 0.25, soilFertility: 1.5, disasterRate: 0.3, plagueRate: 0.4, stabilityFactor: 1.6 } },
  { id: 'strife', label: 'Age of Strife', desc: 'Many proud peoples, short tempers, frequent plagues.',
    params: { civCount: 16, aggression: 1.8, stabilityFactor: 0.6, plagueRate: 1.6, religiosity: 1.5 } },
  { id: 'cataclysm', label: 'Cataclysm', desc: 'A restless planet of quakes, eruptions and falling stars.',
    params: { disasterRate: 2.2, volcanism: 2.5, seismicity: 2.5, meteorRate: 2, plateCount: 20 } },
  // --- Mythic presets -------------------------------------------------------
  { id: 'highfantasy', mode: 'mythic', label: 'High Fantasy', desc: 'Elves, dwarves and orcs share the land; ley lines hum and dragons sleep.',
    params: { mythLevel: 2 } },
  { id: 'dragons', mode: 'mythic', label: 'Age of Dragons', desc: 'The wild places teem with wyrms, trolls and giants.',
    params: { mythLevel: 2, monsterAbundance: 2.5 } },
  { id: 'twilight', mode: 'mythic', label: 'Twilight of Magic', desc: 'Old kingdoms and a fading weave; the last mages remember.',
    params: { mythLevel: 2, startingEra: 3, magicStrength: 0.7 } },
  { id: 'elder', mode: 'mythic', label: 'Elder Races', desc: 'Few humans; the long-lived peoples hold the world.',
    params: { mythLevel: 2, raceMix: 'elderRaces' } },
  { id: 'legends', mode: 'mythic', label: 'Legends', desc: 'A world of omens, saints and haunted ruins, where wonders live in belief alone.',
    params: { mythLevel: 1 } },
];
