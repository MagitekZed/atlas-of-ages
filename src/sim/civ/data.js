// Static tables for the civilization module: governments, ruler traits, buildings and
// wonders. Pure data (plus tiny pure helpers) so tech.js can combine their modifiers
// without import cycles. Modifier deltas use the same keys as getMods():
//   multiplier keys are added to their default of 1 (e.g. trade: 0.2 → ×1.2),
//   additive keys (stability, happiness, tradeRange…) are added to their default.
// Buildings and wonders registered by other packages (core/ext.js registerBuildings /
// registerWonders: the racial halls and wonders of a Mythic world) join through
// buildingDef / wonderDef / allWonders, merged lazily by extVersion(); they carry race and
// available(w, s, civ) gates, and buildings may carry smods (settlement modifiers per level:
// add keys × level, mul keys 1 + (v − 1) × level) and score (how keenly towns want them).

import { extVersion, getRegisteredBuildings, getRegisteredWonders } from '../../core/ext.js';

// ---------------------------------------------------------------------------
// Governments
//
// succession: 'hereditary' (dynasties, crises → civil wars), 'elective' (terms),
//             'council' (theocratic / oligarchic choice for life), 'strongman' (coups)
// capacity:   settlements administered without overextension (before tech bonuses)
// tax:        baseline tax rate the state drifts toward
// crisis:     multiplier on succession-crisis chance
// styles:     display names; {name} = base name, {adj} = adjective, {dem} = plural demonym ("the {dem}")
// titles:     [male, female] ruler titles, alternatives chosen per civ

export const GOVERNMENTS = {
  tribe: {
    label: 'Tribal council', succession: 'hereditary', capacity: 3, tax: 0.04, crisis: 0.6, minEra: 0,
    mods: { stability: 0.04, research: -0.05 },
    styles: ['{adj} Tribes', 'Tribe of {name}', '{adj} Clans', 'People of {name}', 'Folk of {name}', '{adj} Kindred', 'Clan of {name}', 'Hearth of {name}', '{adj} Folk', 'Kin of {name}'],
    titles: [['Chief', 'Chieftess'], ['Elder', 'Elder'], ['Headman', 'Headwoman'], ['Hearth-Father', 'Hearth-Mother'], ['Speaker', 'Speaker'], ['Firstborn', 'Firstborn']],
  },
  chiefdom: {
    label: 'Chiefdom', succession: 'hereditary', capacity: 6, tax: 0.07, crisis: 0.9, minEra: 0,
    mods: { stability: 0.02 },
    styles: ['Chiefdom of {name}', '{adj} Chiefdom', 'High Seat of {name}', '{adj} Confederacy', 'Seat of {name}', 'Chieftaincy of {name}', 'Great Hearth of {name}', '{adj} League', 'Paramountcy of {name}'],
    titles: [['High Chief', 'High Chieftess'], ['Warlord', 'Warlady'], ['Paramount Chief', 'Paramount Chieftess'], ['Thane', 'Thane'], ['Jarl', 'Jarl']],
  },
  kingdom: {
    label: 'Monarchy', succession: 'hereditary', capacity: 12, tax: 0.1, crisis: 1, minEra: 1,
    mods: { stability: 0.03, military: 0.05 },
    styles: ['Kingdom of {name}', '{adj} Kingdom', 'Realm of {name}', 'Crown of {name}', 'Kingdom of the {dem}', 'Throne of {name}', 'High Kingdom of {name}', '{adj} Realm', 'Royal Realm of {name}'],
    titles: [['King', 'Queen'], ['Prince', 'Princess'], ['Shah', 'Shahbanu'], ['Raja', 'Rani'], ['Basileus', 'Basilissa'], ['Tsar', 'Tsaritsa']],
  },
  theocracy: {
    label: 'Theocracy', succession: 'council', capacity: 10, tax: 0.12, crisis: 0.5, minEra: 1,
    mods: { stability: 0.06, culture: 0.12, research: -0.05, happiness: 0.02 },
    styles: ['Holy {adj} Theocracy', 'Theocracy of {name}', 'Holy See of {name}', 'Sacred Realm of {name}', 'Hallowed Realm of {name}', 'Temple-State of {name}', '{adj} Holy Dominion', 'Sanctuary of {name}', 'Priest-Kingdom of {name}'],
    titles: [['High Priest', 'High Priestess'], ['Prophet-King', 'Prophet-Queen'], ['Hierarch', 'Hierarch'], ['Patriarch', 'Matriarch'], ['Pontiff', 'Pontiff'], ['Archpriest', 'Archpriestess']],
  },
  horde: {
    label: 'Horde', succession: 'hereditary', capacity: 11, tax: 0.06, crisis: 1.5, minEra: 1,
    mods: { military: 0.25, movement: 0.2, stability: -0.04, research: -0.1, production: -0.05 },
    styles: ['{adj} Horde', 'Khaganate of {name}', '{adj} Khanate', 'Great Horde of {name}', '{adj} Ulus', 'Khanate of {name}', 'Golden Horde of {name}', 'Host of {name}', '{adj} Host'],
    titles: [['Khagan', 'Khatun'], ['Khan', 'Khanum'], ['Great Khan', 'Great Khatun'], ['Warlord', 'Warlady']],
  },
  empire: {
    label: 'Empire', succession: 'hereditary', capacity: 24, tax: 0.14, crisis: 1.2, minEra: 2,
    mods: { military: 0.15, stability: -0.02, culture: 0.05, adminRange: 4 },
    styles: ['{adj} Empire', 'Empire of {name}', 'Imperial {adj} Realm', '{adj} Dominion', 'Imperium of {name}', 'High Empire of {name}', 'Empire of the {dem}', 'Sovereign Empire of {name}', '{adj} Imperium'],
    titles: [['Emperor', 'Empress'], ['King of Kings', 'Queen of Queens'], ['Autocrat', 'Autocratrix'], ['Imperator', 'Imperatrix'], ['High King', 'High Queen']],
  },
  republic: {
    label: 'Republic', succession: 'elective', capacity: 14, tax: 0.11, crisis: 0.3, minEra: 3, term: [5, 10],
    mods: { research: 0.1, trade: 0.1, stability: 0.0, happiness: 0.03 },
    styles: ['Republic of {name}', '{adj} Republic', 'Commonwealth of {name}', 'Free Republic of {name}', 'Consulate of {name}', 'Polity of {name}', 'Civic Republic of {name}', '{adj} Polity'],
    titles: [['Consul', 'Consul'], ['First Citizen', 'First Citizen'], ['Archon', 'Archon'], ['Tribune', 'Tribune'], ['Magistrate', 'Magistrate'], ['Gonfalonier', 'Gonfalonier']],
    singleStyle: 'Free City of {name}',
  },
  merchant: {
    label: 'Merchant republic', succession: 'council', capacity: 10, tax: 0.12, crisis: 0.4, minEra: 3,
    mods: { trade: 0.25, research: 0.05, military: -0.1, tradeRange: 4 },
    styles: ['Free Cities of {name}', 'Most Serene Republic of {name}', '{adj} Merchant League', 'Merchant Republic of {name}', 'Serene Republic of {name}', 'Merchant Princedom of {name}', '{adj} Trading League', 'Guild Republic of {name}', '{adj} Hanse'],
    titles: [['Doge', 'Dogaressa'], ['Grand Burgher', 'Grand Burgher'], ['Prince-Merchant', 'Princess-Merchant'], ['Syndic', 'Syndic'], ['Guildmaster', 'Guildmistress']],
    singleStyle: 'Free City of {name}',
  },
  feudal: {
    label: 'Feudal monarchy', succession: 'hereditary', capacity: 20, tax: 0.09, crisis: 1.5, minEra: 4,
    mods: { defense: 0.2, military: 0.1, stability: -0.03, research: -0.05 },
    styles: ['Realm of {name}', 'Feudal Kingdom of {name}', '{adj} Crown', 'Grand Duchy of {name}', 'Duchy of {name}', 'Principality of {name}', 'Crown of {name}', 'Sovereign Lordship of {name}', '{adj} Principality', 'Great Duchy of {name}'],
    titles: [['High King', 'High Queen'], ['King', 'Queen'], ['Grand Duke', 'Grand Duchess'], ['Duke', 'Duchess'], ['Prince', 'Princess'], ['Margrave', 'Margravine']],
  },
  constitutional: {
    label: 'Constitutional monarchy', succession: 'hereditary', capacity: 32, tax: 0.15, crisis: 0.35, minEra: 5,
    mods: { stability: 0.06, trade: 0.1, research: 0.05, happiness: 0.03 },
    styles: ['United Kingdom of {name}', 'Constitutional Kingdom of {name}', 'Crowned Republic of {name}', 'Kingdom of {name}', 'Crowned Commonwealth of {name}', 'Parliamentary Kingdom of {name}', '{adj} Monarchy'],
    titles: [['King', 'Queen'], ['Sovereign Prince', 'Sovereign Princess'], ['Grand Duke', 'Grand Duchess']],
  },
  democracy: {
    label: 'Democracy', succession: 'elective', capacity: 45, tax: 0.2, crisis: 0.1, minEra: 6, term: [4, 6],
    mods: { research: 0.15, trade: 0.15, stability: 0.04, happiness: 0.05, military: -0.05 },
    styles: ['Federation of {name}', 'Democratic Republic of {name}', '{adj} Commonwealth', 'United Provinces of {name}', 'Republic of {name}', 'Union of {name}', '{adj} Union', 'Commonwealth of {name}', 'Confederation of {name}'],
    titles: [['President', 'President'], ['Chancellor', 'Chancellor'], ['Premier', 'Premier'], ['First Minister', 'First Minister'], ['Prime Minister', 'Prime Minister']],
    singleStyle: 'Free State of {name}',
  },
  dictatorship: {
    label: 'Dictatorship', succession: 'strongman', capacity: 26, tax: 0.22, crisis: 2, minEra: 3,
    mods: { military: 0.25, stability: -0.02, research: -0.05, happiness: -0.06 },
    styles: ['{adj} State', '{adj} Directorate', 'Protectorate of {name}', "People's State of {name}", '{adj} Regime', 'Junta of {name}', 'National State of {name}', '{adj} Protectorate', 'Directorate of {name}'],
    titles: [['Lord Protector', 'Lady Protector'], ['Dictator', 'Dictator'], ['Marshal', 'Marshal'], ['Supreme Leader', 'Supreme Leader'], ['Generalissimo', 'Generalissima']],
  },
};

/** Hereditary governments whose rulers found dynasties. */
export const isDynastic = (gov) => (GOVERNMENTS[gov]?.succession || 'hereditary') === 'hereditary';

// ---------------------------------------------------------------------------
// Ruler traits. Opposed pairs never co-occur. `w` = relative frequency.
// tax: added to the target tax rate.  coup: multiplier on assassination/coup risk.

export const RULER_TRAITS = {
  wise:        { w: 1.0, mods: { stability: 0.03, research: 0.05 }, opp: ['mad', 'foolish'] },
  foolish:     { w: 0.6, mods: { stability: -0.03, research: -0.04 }, opp: ['wise', 'brilliant'] },
  cruel:       { w: 0.8, mods: { stability: -0.02, happiness: -0.06, military: 0.05 }, tax: 0.02, coup: 1.6, opp: ['just', 'generous'] },
  just:        { w: 0.9, mods: { stability: 0.04, happiness: 0.04 }, opp: ['cruel'] },
  pious:       { w: 1.0, mods: { culture: 0.06, stability: 0.02 }, opp: [] },
  warlike:     { w: 0.9, mods: { military: 0.1 }, opp: ['craven'] },
  craven:      { w: 0.5, mods: { military: -0.1, stability: -0.02 }, coup: 1.3, opp: ['warlike', 'ambitious'] },
  scholarly:   { w: 0.8, mods: { research: 0.1, culture: 0.03 }, opp: [] },
  greedy:      { w: 0.8, mods: { happiness: -0.03 }, tax: 0.04, opp: ['generous'] },
  generous:    { w: 0.7, mods: { happiness: 0.04 }, tax: -0.02, opp: ['greedy', 'cruel'] },
  mad:         { w: 0.25, mods: { stability: -0.08, happiness: -0.03 }, coup: 2.2, opp: ['wise'] },
  charismatic: { w: 0.8, mods: { stability: 0.04, culture: 0.03 }, coup: 0.7, opp: [] },
  ambitious:   { w: 0.8, mods: { military: 0.05, expansionRange: 1 }, opp: ['craven', 'lazy'] },
  industrious: { w: 0.7, mods: { production: 0.08 }, opp: ['lazy'] },
  lazy:        { w: 0.5, mods: { production: -0.05, stability: -0.02 }, opp: ['industrious', 'ambitious'] },
  cautious:    { w: 0.7, mods: { defense: 0.1 }, opp: [] },
  paranoid:    { w: 0.5, mods: { stability: -0.02 }, coup: 0.6, opp: [] },
  brilliant:   { w: 0.4, mods: { research: 0.08, trade: 0.05 }, opp: ['foolish'] },
};

// ---------------------------------------------------------------------------
// Buildings. Gated by tech and tier; levels named individually.
//   cost: production for level 1; higher levels × (1 + 0.8·(level−1)); × era scale.
//   upkeep: wealth per month per level.

export const BUILDINGS = {
  granary:  { names: ['Granary', 'Great Granary'], tech: ['pottery', 'engineering'], minTier: 1, cost: 60, upkeep: 0.05 },
  walls:    { names: ['Palisade', 'Stone Walls', 'Castle', 'Star Fort'], tech: ['toolmaking', 'masonry', 'feudalism', 'cannon'], minTier: [1, 2, 3, 3], cost: 90, upkeep: 0.08 },
  temple:   { names: ['Shrine', 'Temple', 'Cathedral'], tech: ['mysticism', 'masonry', 'theology'], minTier: [1, 2, 3], cost: 70, upkeep: 0.06 },
  harbor:   { names: ['Harbour', 'Great Harbour'], tech: ['sailing', 'navigation'], minTier: [1, 3], cost: 120, upkeep: 0.08, coastal: true },
  mine:     { names: ['Mine', 'Deep Mine'], tech: ['bronze', 'gunpowder'], minTier: [1, 2], cost: 110, upkeep: 0.06, ore: true },
  barracks: { names: ['Barracks', 'Military Academy'], tech: ['bronze', 'tactics'], minTier: [2, 3], cost: 120, upkeep: 0.1 },
  library:  { names: ['Library', 'Great Library'], tech: ['writing', 'paper'], minTier: [2, 3], cost: 150, upkeep: 0.07 },
  market:   { names: ['Market', 'Grand Bazaar'], tech: ['currency', 'guilds'], minTier: [2, 3], cost: 140, upkeep: 0.04 },
  aqueduct: { names: ['Aqueduct'], tech: ['engineering'], minTier: 3, cost: 420, upkeep: 0.12 },
  theatre:  { names: ['Amphitheatre', 'Opera House'], tech: ['drama', 'printing'], minTier: [3, 4], cost: 300, upkeep: 0.1 },
  workshop: { names: ['Guildhall'], tech: ['guilds'], minTier: 3, cost: 380, upkeep: 0.08 },
  university: { names: ['University'], tech: ['scholasticism'], minTier: 3, cost: 700, upkeep: 0.2 },
  observatory: { names: ['Observatory'], tech: ['astronomy'], minTier: 3, cost: 500, upkeep: 0.12 },
  bank:     { names: ['Bank', 'Stock Exchange'], tech: ['banking', 'electricity'], minTier: [3, 4], cost: 600, upkeep: 0.05 },
  hospital: { names: ['Hospital', 'Teaching Hospital'], tech: ['anatomy', 'antibiotics'], minTier: [3, 4], cost: 650, upkeep: 0.2 },
  factory:  { names: ['Factory', 'Industrial Works', 'Assembly Plant'], tech: ['factory', 'electricity', 'combustion'], minTier: [2, 3, 4], cost: 1200, upkeep: 0.25 },
  railway:  { names: ['Railway Station'], tech: ['railways'], minTier: 2, cost: 1100, upkeep: 0.2 },
  sewers:   { names: ['Sewers'], tech: ['sanitation'], minTier: 3, cost: 1300, upkeep: 0.2 },
  powerplant: { names: ['Power Station', 'Clean Power Station'], tech: ['electricity', 'renewables'], minTier: [3, 3], cost: 2200, upkeep: 0.3 },
  airport:  { names: ['Airfield', 'Airport'], tech: ['flight', 'computers'], minTier: [4, 5], cost: 4000, upkeep: 0.4 },
};

/** Display name of a building at a level (1-based). */
export function buildingName(key, level = 1) {
  const b = buildingDef(key);
  if (!b || !Array.isArray(b.names) || !b.names.length) return key;
  return b.names[Math.max(0, Math.min(b.names.length - 1, (level || 1) - 1))];
}

// ---------------------------------------------------------------------------
// Wonders. One standing wonder per kind in the whole world.
//   era: earliest era; tech: required tech; minTier: settlement tier;
//   needs: 'coastal' | 'river' | building key; title(ctx) builds the name.
//   cost: production; mods apply to the owning civ while the wonder stands; prestige.

export const WONDERS = [
  { kind: 'stone_circle', era: 0, tech: 'mysticism', minTier: 2, cost: 2500, prestige: 8, mods: { culture: 0.1, stability: 0.02 },
    names: ['the Stone Circle of {city}', 'the Standing Stones of {city}', 'the Sky Mound of {city}'] },
  { kind: 'ziggurat', era: 1, tech: 'masonry', minTier: 3, cost: 7000, prestige: 14, mods: { stability: 0.04, culture: 0.1 },
    names: ['the Great Ziggurat of {city}', 'the Stepped Temple of {city}'] },
  { kind: 'pyramid', era: 1, tech: 'masonry', minTier: 3, cost: 9000, prestige: 18, mods: { stability: 0.05 },
    names: ['the Pyramid of {ruler}', 'the Tomb of {ruler}'] },
  { kind: 'colossus', era: 2, tech: 'bronze', minTier: 3, needs: 'coastal', cost: 12000, prestige: 14, mods: { trade: 0.12, tradeRange: 3 },
    names: ['the Colossus of {city}', 'the Bronze Giant of {city}'] },
  { kind: 'gardens', era: 2, tech: 'irrigation', minTier: 3, cost: 12000, prestige: 14, mods: { health: 0.04, happiness: 0.04 },
    names: ['the Hanging Gardens of {city}', 'the Terraced Gardens of {city}'] },
  { kind: 'great_library', era: 3, tech: 'philosophy', minTier: 4, needs: 'library', cost: 26000, prestige: 22, mods: { research: 0.15, culture: 0.08 },
    names: ['the Great Library of {city}', 'the House of Scrolls at {city}'] },
  { kind: 'lighthouse', era: 3, tech: 'engineering', minTier: 3, needs: 'coastal', cost: 20000, prestige: 16, mods: { trade: 0.08, seaRange: 6 },
    names: ['the Lighthouse of {city}', 'the Pharos of {city}'] },
  { kind: 'great_wall', era: 3, tech: 'engineering', minTier: 3, cost: 30000, prestige: 18, mods: { defense: 0.3 },
    names: ['the Great Wall of the {adj}', 'the {adj} Wall'] },
  { kind: 'colosseum', era: 3, tech: 'drama', minTier: 4, cost: 24000, prestige: 16, mods: { happiness: 0.05, culture: 0.12 },
    names: ['the Grand Amphitheatre of {city}', 'the Colosseum of {city}'] },
  { kind: 'cathedral', era: 4, tech: 'theology', minTier: 4, cost: 50000, prestige: 22, mods: { stability: 0.05, happiness: 0.03, culture: 0.1 },
    names: ['the Great Cathedral of {city}', 'the Basilica of {city}', 'the High Temple of {city}'] },
  { kind: 'citadel', era: 4, tech: 'feudalism', minTier: 4, cost: 42000, prestige: 14, mods: { defense: 0.25, military: 0.05 },
    names: ['the Citadel of {city}', 'the Iron Keep of {city}'] },
  { kind: 'observatory', era: 4, tech: 'astronomy', minTier: 4, cost: 45000, prestige: 16, mods: { research: 0.1, seaRange: 4 },
    names: ['the Star Tower of {city}', 'the Great Observatory of {city}'] },
  { kind: 'grand_canal', era: 4, tech: 'guilds', minTier: 4, needs: 'river', cost: 55000, prestige: 18, mods: { trade: 0.12, farmYield: 0.05 },
    names: ['the Grand Canal of {city}', 'the {adj} Canal'] },
  { kind: 'palace', era: 5, tech: 'banking', minTier: 4, cost: 90000, prestige: 22, mods: { stability: 0.06, culture: 0.08 },
    names: ['the Palace of {ruler}', 'the Summer Palace of {city}', 'the Golden Palace of {city}'] },
  { kind: 'opera', era: 5, tech: 'printing', minTier: 5, cost: 85000, prestige: 18, mods: { culture: 0.2, happiness: 0.03 },
    names: ['the Grand Opera of {city}', 'the Royal Theatre of {city}'] },
  { kind: 'exchange', era: 5, tech: 'banking', minTier: 4, cost: 95000, prestige: 16, mods: { trade: 0.15 },
    names: ['the Grand Exchange of {city}', 'the Bourse of {city}'] },
  { kind: 'crystal_palace', era: 6, tech: 'steam', minTier: 5, cost: 180000, prestige: 20, mods: { production: 0.08, culture: 0.1 },
    names: ['the Crystal Palace of {city}', 'the Great Exhibition Hall of {city}'] },
  { kind: 'iron_tower', era: 6, tech: 'electricity', minTier: 5, cost: 200000, prestige: 24, mods: { culture: 0.15, stability: 0.02 },
    names: ['the Iron Tower of {city}', 'the {adj} Tower'] },
  { kind: 'great_dam', era: 6, tech: 'electricity', minTier: 4, needs: 'river', cost: 240000, prestige: 18, mods: { production: 0.12, farmYield: 0.08 },
    names: ['the Great Dam of {city}', 'the {ruler} Dam'] },
  { kind: 'skyspire', era: 7, tech: 'computers', minTier: 6, cost: 450000, prestige: 26, mods: { research: 0.15, trade: 0.1 },
    names: ['the Skyspire of {city}', 'the Tower of {city}'] },
  { kind: 'world_archive', era: 7, tech: 'massmedia', minTier: 5, cost: 400000, prestige: 22, mods: { research: 0.1, culture: 0.2 },
    names: ['the World Archive of {city}', 'the Memory Vault of {city}'] },
  { kind: 'seed_vault', era: 7, tech: 'greenrev', minTier: 4, cost: 350000, prestige: 16, mods: { farmYield: 0.1, plagueResist: 0.05 },
    names: ['the Seed Vault of {city}', 'the Ark of Seeds at {city}'] },
];
export const WONDER_BY_KIND = Object.fromEntries(WONDERS.map((w) => [w.kind, w]));

// ---------------------------------------------------------------------------
// Registered buildings and wonders (merged lazily; derived from code, safe to lose)

let regV = -1;
let ALL_WONDERS = WONDERS;
const REG_BUILDING = Object.create(null);
let REG_BUILDING_KEYS = [];
const REG_WONDER = Object.create(null);
const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

function syncDefs() {
  const v = extVersion();
  if (v === regV) return;
  regV = v;
  for (const k of Object.keys(REG_BUILDING)) delete REG_BUILDING[k];
  for (const k of Object.keys(REG_WONDER)) delete REG_WONDER[k];
  const keys = [];
  for (const d of getRegisteredBuildings()) {
    const key = d && typeof d.id === 'string' ? d.id : null;
    if (!key || BUILDINGS[key]) continue;            // never shadow a shared building
    const tech = arr(d.tech).filter((t) => typeof t === 'string');
    const names = arr(d.names).filter((n) => typeof n === 'string');
    if (!tech.length || !names.length) continue;
    REG_BUILDING[key] = {
      ...d, key, names, tech,
      minTier: Array.isArray(d.minTier) ? d.minTier.map((t) => (Number.isFinite(t) ? t : 1)) : Number.isFinite(d.minTier) ? d.minTier : 1,
      cost: Number.isFinite(d.cost) && d.cost > 0 ? d.cost : 100,
      upkeep: Number.isFinite(d.upkeep) && d.upkeep >= 0 ? d.upkeep : 0.05,
      score: Number.isFinite(d.score) ? d.score : 1.2,
      registered: true,
    };
    keys.push(key);
  }
  REG_BUILDING_KEYS = keys;
  const extra = [];
  for (const d of getRegisteredWonders()) {
    const kind = d && typeof (d.kind || d.id) === 'string' ? (d.kind || d.id) : null;
    if (!kind || WONDER_BY_KIND[kind]) continue;
    const names = arr(d.names).filter((n) => typeof n === 'string');
    if (!names.length) continue;
    const w = {
      ...d, kind, names,
      era: Number.isFinite(d.era) ? d.era : 0,
      minTier: Number.isFinite(d.minTier) ? d.minTier : 3,
      cost: Number.isFinite(d.cost) && d.cost > 0 ? d.cost : 10000,
      prestige: Number.isFinite(d.prestige) ? d.prestige : 12,
      mods: d.mods && typeof d.mods === 'object' ? d.mods : {},
      registered: true,
    };
    REG_WONDER[kind] = w;
    extra.push(w);
  }
  ALL_WONDERS = extra.length ? WONDERS.concat(extra) : WONDERS;
}

/** A building def by key (shared table first, then registered ones), or null. */
export function buildingDef(key) {
  const b = BUILDINGS[key];
  if (b) return b;
  syncDefs();
  return REG_BUILDING[key] || null;
}
/** Keys of the registered buildings (empty in a Historical world). */
export function registeredBuildingKeys() { syncDefs(); return REG_BUILDING_KEYS; }
/** A wonder def by kind (shared table first, then registered ones), or null. */
export function wonderDef(kind) {
  const w = WONDER_BY_KIND[kind];
  if (w) return w;
  syncDefs();
  return REG_WONDER[kind] || null;
}
/** Every wonder def: the shared table, then registered ones. */
export function allWonders() { syncDefs(); return ALL_WONDERS; }
/** The extVersion the merged tables were last built at (for caches in world.cache). */
export function defsVersion() { syncDefs(); return regV; }
