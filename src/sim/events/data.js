// Event data: the families events belong to, city specialties and traits, earned epithets,
// the great beasts of the first ages, and the ages of the world. Plain tables, no state; the
// engine, the decks, character.js and ages.js read them. DOM-free.

import { BIOME } from '../../core/constants.js';

// ---------------------------------------------------------------------------
// Families. Every def names one; the governor budgets imp ≥ 2 entries per family per decade,
// the report counts them per century, and the UI colours them (EVENT_FAMILIES export).

export const EVENT_FAMILIES = Object.freeze({
  wild: { label: 'Wild Things', color: '#6aa86a', cat: 'nature', desc: 'Great beasts, hunts, herds and the last of their kind.' },
  dawn: { label: 'First Arts', color: '#43b3a3', cat: 'tech', desc: 'Herds tamed, boats launched, grain sown and caves painted.' },
  sacred: { label: 'Sacred Places', color: '#b884d8', cat: 'religion', desc: 'Standing stones, visions, pilgrims and holy fevers.' },
  feud: { label: 'Feuds & Raids', color: '#c46a4f', cat: 'diplomacy', desc: 'Cattle raids, hunting-ground quarrels and border skirmishes.' },
  envoys: { label: 'Envoys & Intrigue', color: '#5e9fd6', cat: 'diplomacy', desc: 'Embassies, hostages, spies, embargoes and marriages between realms.' },
  fire: { label: 'Fire & Flood', color: '#e2703a', cat: 'disaster', desc: 'Great fires, foul wells and towns rebuilt after the waters.' },
  unrest: { label: 'Riot & Revolt', color: '#d0533f', cat: 'civ', desc: 'Bread riots, guild revolts, panics and persecutions.' },
  fortune: { label: 'Boom & Bust', color: '#d99a3e', cat: 'trade', desc: 'Strikes of silver, ghost towns and the great fairs.' },
  plague: { label: 'Pestilence', color: '#8db04a', cat: 'disease', desc: 'Gates shut against the sickness, and the fear it brings.' },
  civic: { label: 'Civic Life', color: '#e08fb0', cat: 'culture', desc: 'Feasts, refugees, sieges endured and works of pride.' },
  court: { label: 'Court & Crown', color: '#c9a24a', cat: 'civ', desc: 'Intrigue, scandal, royal hunts and weddings.' },
  treasury: { label: 'Coin & Treasury', color: '#b8923e', cat: 'trade', desc: 'Debts, debased coin, defaults and the great counts.' },
  works: { label: 'Great Works', color: '#c7a76b', cat: 'culture', desc: 'Roads, law codes, bridges and the granaries opened.' },
  learning: { label: 'Learning', color: '#4fa7c4', cat: 'tech', desc: 'Scholars in flight and the lore of lost ages dug up.' },
  ruins: { label: 'Ruins', color: '#9c8f7c', cat: 'culture', desc: 'Old cities resettled, looted and remembered.' },
  ages: { label: 'Ages of the World', color: '#6fb6cf', cat: 'civ', desc: 'Long ages, dark years and golden centuries of whole lands.' },
  swan: { label: 'Black Swans', color: '#e8d48a', cat: 'disaster', desc: 'Rare shocks that redraw the map: collapse, comet, pandemic.' },
  character: { label: 'City Character', color: '#d6a0c4', cat: 'culture', desc: 'Epithets earned and lost, and what a town is known for.' },
  annals: { label: 'Annals', color: '#a39887', cat: 'civ', desc: 'The routine of a decade, summed up in one line.' },
  // WP5's Legendary/Mythic folklore deck (src/sim/myth/folklore.js) runs through this engine
  folklore: { label: 'Folklore', color: '#a98be6', cat: 'myth', desc: 'Omens, saints, relics, hauntings and the tales people tell.' },
});
export const FAMILY_KEYS = Object.keys(EVENT_FAMILIES);

// ---------------------------------------------------------------------------
// Tunables

/** Each family may write this many imp ≥ 2 entries per decade before its weights halve
 * (the budget grows with the size of the world, see governor.js). */
export const GOV_BASE = 2;
/** Black swans: at most one per this many years. */
export const SWAN_GAP_YEARS = 200;
/** Fate: a nudge multiplies an event's weight this much for NUDGE_YEARS. */
export const NUDGE_MUL = 5;
export const NUDGE_YEARS = 20;
/** Fate: one invocation per subject per this many years. */
export const INVOKE_GAP_YEARS = 5;
/** Pair incidents: at most one per pair per this many years. */
export const PAIR_GAP_YEARS = 8;
/** Heat decays by this factor every year and is forgotten below HEAT_MIN. */
export const HEAT_DECAY = 0.9;
export const HEAT_MIN = 0.05;

// ---------------------------------------------------------------------------
// City specialties (assigned when a settlement first reaches Town tier; a second at City)
// and traits. Keys are the display phrases the renderer and Inspector show as they are.
// m: permanent settlement effect (SETTLEMENT_MOD_KEYS), each within ±15 %.
// pot = s.flags.pot [wild, fish, farmCap, farmLoad, timber, ore, lux, strat, …] (civ module);
// score(ctx) reads ctx = { s, pot, b (buildings), res (resource ids in reach: Set), biome,
// coastal, river, hills, routes, holy } and returns 0..~2 (0 = not eligible).

const lvl = (b, k) => (b && +b[k]) || 0;
const potOf = (pot, k) => (Array.isArray(pot) && Number.isFinite(pot[k]) ? pot[k] : 0);

export const SPECIALTIES = [
  { key: 'salt pans', phrase: 'its salt pans', m: { trade: 1.1, foodYield: 1.04 }, tags: ['trade'],
    score: (c) => (c.res.has(9) ? 1.2 : 0) + (c.coastal && (c.biome === BIOME.HOT_DESERT || c.biome === BIOME.SHRUBLAND || c.biome === BIOME.STEPPE) ? 0.6 : 0) },
  { key: 'shipyards', phrase: 'its shipyards', m: { production: 1.08, trade: 1.08 }, tags: ['sea', 'trade'],
    score: (c) => (c.coastal ? 0.4 + 0.5 * lvl(c.b, 'harbor') + Math.min(0.5, potOf(c.pot, 4) / 60) : 0) },
  { key: 'mines', phrase: 'its mines', m: { production: 1.14 }, tags: ['ore', 'boom'],
    score: (c) => 0.6 * lvl(c.b, 'mine') + Math.min(1, potOf(c.pot, 5) / 8) + (c.res.has(1) || c.res.has(2) || c.res.has(3) ? 0.4 : 0) },
  { key: 'horse fairs', phrase: 'its horse fairs', m: { trade: 1.1, defense: 0.05 }, tags: ['trade', 'horse'],
    score: (c) => (c.res.has(7) ? 1.2 : 0) + (c.biome === BIOME.STEPPE ? 0.45 : 0) },
  { key: 'scriptoria', phrase: 'its scriptoria', m: { research: 1.14, culture: 1.06 }, tags: ['learning'],
    score: (c) => 0.8 * lvl(c.b, 'library') + 0.6 * lvl(c.b, 'university') + 0.3 * lvl(c.b, 'observatory') },
  { key: 'temple city', phrase: 'its temples', m: { culture: 1.12, happiness: 0.03 }, tags: ['faith', 'pilgrims'],
    score: (c) => 0.45 * lvl(c.b, 'temple') + (c.holy ? 1.3 : 0) + (c.sacred ? 0.5 : 0) },
  { key: 'fortress', phrase: 'its fortress', m: { defense: 0.15 }, tags: ['walls'],
    score: (c) => 0.4 * lvl(c.b, 'walls') + 0.4 * lvl(c.b, 'barracks') + (c.hills ? 0.35 : 0) + (c.s.hist && c.s.hist.held ? 0.5 : 0) },
  { key: 'market town', phrase: 'its markets', m: { trade: 1.14 }, tags: ['trade', 'fair'],
    score: (c) => 0.6 * lvl(c.b, 'market') + Math.min(0.9, 0.25 * c.routes) + 0.3 * lvl(c.b, 'bank') },
  { key: 'fishing port', phrase: 'its fishing fleet', m: { foodYield: 1.1 }, tags: ['sea'],
    score: (c) => (c.coastal || c.lake ? Math.min(1.3, potOf(c.pot, 1) / 40) : 0) },
  { key: 'timber town', phrase: 'its timber', m: { production: 1.1 }, tags: ['wood'],
    score: (c) => Math.min(1.2, potOf(c.pot, 4) / 40) },
  { key: 'breadbasket', phrase: 'its wheat fields', m: { foodYield: 1.12 }, tags: ['farm'],
    score: (c) => Math.min(1.3, potOf(c.pot, 2) / Math.max(400, c.s.population * 0.9)) + (c.river ? 0.2 : 0) },
  { key: 'weavers', phrase: 'its weavers', m: { production: 1.06, trade: 1.06 }, tags: ['craft', 'guild'],
    score: (c) => (c.era >= 2 ? 0.35 + 0.4 * lvl(c.b, 'workshop') + Math.min(0.4, potOf(c.pot, 3) / 200) : 0) },
  { key: 'spice market', phrase: 'its spice market', m: { trade: 1.15 }, tags: ['trade', 'luxury'],
    score: (c) => (c.res.has(8) ? 1.4 : 0) },
  { key: 'goldsmiths', phrase: 'its goldsmiths', m: { trade: 1.1, culture: 1.04 }, tags: ['luxury'],
    score: (c) => (c.res.has(4) || c.res.has(5) ? 1.25 : 0) },
  { key: 'quarries', phrase: 'its quarries', m: { production: 1.06, housing: 1.05 }, tags: ['stone'],
    score: (c) => (c.res.has(6) ? 1.2 : 0) + (c.hills ? 0.3 : 0) },
  { key: 'vineyards', phrase: 'its vineyards', m: { happiness: 0.03, trade: 1.06 }, tags: ['luxury', 'farm'],
    score: (c) => (c.biome === BIOME.SHRUBLAND || c.biome === BIOME.TEMPERATE_FOREST ? 0.35 + Math.min(0.4, potOf(c.pot, 3) / 150) : 0) + (c.hills ? 0.2 : 0) },
  { key: 'potters', phrase: 'its potters', m: { production: 1.05, trade: 1.05 }, tags: ['craft'],
    score: (c) => (c.river ? 0.45 : 0.15) },
  { key: 'fur traders', phrase: 'its fur traders', m: { trade: 1.1 }, tags: ['trade', 'wood'],
    score: (c) => (c.res.has(10) ? 1.2 : 0) + (c.biome === BIOME.TAIGA ? 0.4 : 0) },
];
export const SPECIALTY_BY_KEY = Object.fromEntries(SPECIALTIES.map((x) => [x.key, x]));

/** Traits earned from events (not from the land). m: permanent effect where it has one. */
export const TRAITS = {
  'sacred site': { m: { culture: 1.12, happiness: 0.03 }, desc: 'Raised standing stones that drew the faithful.' },
  'rebuilt in stone': { m: { culture: 1.05, fireRisk: 0.3 }, desc: 'Rose again in stone after a great fire.' },
  'horse-tamers': { m: { foodYield: 1.06, defense: 0.05 }, desc: 'First to break the wild horses.' },
  herders: { m: { foodYield: 1.08 }, desc: 'First to tame the wild herds.' },
  boatwrights: { m: { foodYield: 1.06, trade: 1.04 }, desc: 'Launched the first boats.' },
  'painted caves': { m: { culture: 1.1 }, desc: 'Its caves were painted with hunts and stars.' },
  'free city': { m: { trade: 1.1, production: 1.05 }, desc: 'Threw off its overlords and governed itself.' },
  levees: { m: { foodYield: 1.06 }, desc: 'Walled its river after the great flood.' },
  'first fields': { m: { foodYield: 1.08 }, desc: 'Where the wild grasses were first sown.' },
};
export const isSpecialty = (k) => Boolean(SPECIALTY_BY_KEY[k]);

/** Display label for any s.traits key (UI helper; keys are already readable phrases). */
export function traitLabel(key) {
  if (!key) return '';
  return String(key).replace(/^./, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Epithets, in priority order (a higher one replaces a lower one; a contradicted one is lost).
// Only towns (tier ≥ 3) earn them; rare ones are notable news, the rest local history.
// test(c) with c = { s, hist, cm (sys.events.cm[sid] or {}), holy, wealthRank (0 = richest
// share), age (years), traits, capitalYears }.

export const EPITHETS = [
  { key: 'holy', text: 'the Holy', rare: true, test: (c) => c.holy && c.s.tier >= 3 },
  { key: 'unbowed', text: 'the Unbowed', rare: true, test: (c) => (c.cm.hc || 0) >= 2 && c.s.tier >= 3 },
  { key: 'free', text: 'the Free', rare: true, test: (c) => c.traits.includes('free city') },
  { key: 'great', text: 'the Great', rare: true, test: (c) => c.s.tier >= 5, keep: (c) => c.s.tier >= 4 },
  { key: 'golden', text: 'the Golden', rare: true, test: (c) => c.wealthRank <= 0.05 && c.s.tier >= 4, keep: (c) => c.wealthRank <= 0.15 && c.s.tier >= 3 },
  { key: 'phoenix', text: 'the Phoenix', rare: true, test: (c) => c.hist.fires >= 2 && c.traits.includes('rebuilt in stone') && c.s.tier >= 3 },
  { key: 'thriceburned', text: 'the Thrice-Burned', test: (c) => c.hist.fires >= 3 && c.s.tier >= 3 },
  { key: 'weeping', text: 'the Weeping', test: (c) => c.hist.plagues >= 1 && c.s.tier >= 3 && (c.cm.pday == null || c.year - c.cm.pday < 150), keep: (c) => (c.cm.pday == null || c.year - c.cm.pday < 150) },
  { key: 'twiceburned', text: 'the Twice-Burned', test: (c) => c.hist.fires >= 2 && c.s.tier >= 3 },
  { key: 'ofttaken', text: 'the Oft-Taken', test: (c) => c.hist.conquered >= 4 && c.s.tier >= 3 },
  { key: 'learned', text: 'the Learned', test: (c) => c.traits.includes('scriptoria') && c.s.tier >= 4 },
  { key: 'fair', text: 'of the Fairs', test: (c) => (c.cm.fairs || 0) >= 3 && c.s.tier >= 3 },
  { key: 'shaken', text: 'the Shaken', test: (c) => c.hist.quakes >= 3 && c.s.tier >= 3 },
  { key: 'restless', text: 'the Restless', test: (c) => c.hist.riots >= 4 && c.s.tier >= 3 },
  { key: 'ancient', text: 'the Ancient', test: (c) => c.age >= 700 && c.s.tier >= 4 },
];
export const EPITHET_BY_TEXT = Object.fromEntries(EPITHETS.map((e) => [e.text, e]));
/** EPITHETS by key (a town's current epithet is found by the key in sys.events.cm[sid].ek). */
export const EPITHET_BY_KEY = Object.fromEntries(EPITHETS.map((e) => [e.key, e]));

/**
 * The words a town's epithet is composed from (character.js epithetText): per key, weighted forms
 * over a few plain epithets ({Bare}), fixed combinations ({Adj} {Noun}) and the town's own world
 * — {people} (its realm's people, "the Varathi"), {realm} (the realm's short name), {region} (the
 * nearest named sea, range, wood or river) and {deity} (the god of the faith it is holy to). The
 * plain form `text` above stays the canonical epithet (older saves store it).
 */
export const EPITHET_FORMS = {};
// Per key: Bare (plain epithets), fixed (forms over set words, Fixed or combinations), N (nouns for
// "the {N} of {people|region|realm}"), extra (forms of its own). Plain and fixed forms are kept
// rare: they are the ones every world shares.
const EP_DEFS = {
  holy: { Bare: ['the Holy', 'the Blessed', 'the Hallowed', 'the Sacred', 'the Sanctified', 'the Consecrated'],
    fixed: [[1, 'of the {Num} {Shrines}']], N: ['Lamp', 'Eye', 'Bride', 'Beloved', 'Seat', 'Hearth', 'Gate', 'Altar', 'Throne', 'Cradle', 'Jewel', 'Heart', 'Light'],
    extra: [[3, 'the {N} of {deity}'], [1.2, 'the {deity}-{Blessed}'], [1, 'the Holy City of {people}']],
    words: { Num: ['Hundred', 'Thousand', 'Seven', 'Nine', 'Twelve', 'Many'], Shrines: ['Shrines', 'Temples', 'Bells', 'Altars', 'Saints', 'Pilgrims', 'Domes', 'Lamps', 'Spires', 'Relics'],
      Blessed: ['Blessed', 'Beloved', 'Chosen', 'Hallowed'] } },
  unbowed: { Bare: ['the Unbowed', 'the Unbroken', 'the Unconquered', 'the Steadfast', 'the Undaunted', 'the Stubborn'],
    fixed: [[1, 'the {Adj} {Wall}']], N: ['Shield', 'Bulwark', 'Rampart', 'Sword', 'Gate', 'Wall', 'Guardian', 'Watchtower', 'Bastion', 'Anvil', 'Rock', 'Spear'],
    words: { Adj: ['Iron', 'Stone', 'Brazen', 'Unbroken', 'Red', 'Grey', 'Old'], Wall: ['Wall', 'Gate', 'Shield', 'Tower', 'Rampart', 'Anvil'] } },
  free: { Bare: ['the Free', 'the Unchained', 'the Masterless', 'the Self-Ruled', 'the Unbound'],
    fixed: [[1, 'of the {Free} {Burghers}']], N: ['Pride', 'Thorn', 'Free City', 'Commune', 'Liberty', 'Free Hearth', 'Hope', 'Free Port'],
    words: { Free: ['Free', 'Proud', 'Hundred', 'Sworn', 'Many'], Burghers: ['Burghers', 'Guilds', 'Citizens', 'Charters', 'Bells', 'Oaths', 'Councils'] } },
  great: { Bare: ['the Great', 'the Vast', 'the Mighty', 'the Teeming', 'the Magnificent'],
    fixed: [[0.7, 'of the {Num} {Gates}'], [0.3, 'the Many-{Gated}']], N: ['Crown', 'Heart', 'Queen', 'Eye', 'Mother', 'Glory', 'Wonder', 'Marvel', 'Mistress', 'Light', 'Navel'],
    words: { Num: ['Hundred', 'Thousand', 'Seven', 'Twelve', 'Many', 'Countless'], Gates: ['Gates', 'Towers', 'Roofs', 'Bridges', 'Domes', 'Hearths', 'Streets', 'Wells', 'Markets', 'Spires'],
      Gated: ['Gated', 'Towered', 'Bridged', 'Domed', 'Spired', 'Peopled', 'Walled'] } },
  golden: { Bare: ['the Golden', 'the Gilded', 'the Rich', 'the Opulent', 'the Splendid'],
    fixed: [[0.7, 'of the {Metal} {Domes}'], [0.3, 'the {Metal2}-{Roofed}']], N: ['Jewel', 'Pearl', 'Purse', 'Treasury', 'Gem', 'Coffer', 'Gold', 'Strongbox', 'Ornament', 'Treasure', 'Gilded Heart'],
    words: { Metal: ['Golden', 'Gilded', 'Silver', 'Copper', 'Amber', 'Brazen'], Domes: ['Domes', 'Roofs', 'Gates', 'Towers', 'Bells', 'Spires', 'Markets', 'Wharves'],
      Metal2: ['Silver', 'Gold', 'Copper', 'Bronze', 'Amber', 'Marble'], Roofed: ['Roofed', 'Gated', 'Towered', 'Domed'] } },
  phoenix: { Bare: ['the Phoenix', 'the Reborn', 'the Twice-Risen', 'the Ever-Rising', 'the Undying'],
    fixed: [[1, 'the {Risen} City']], N: ['Phoenix', 'Ember', 'Undying Hearth', 'Rising Flame', 'Reborn Heart', 'Firebird', 'Ever-Burning Lamp'],
    words: { Risen: ['Risen', 'Reborn', 'Rekindled', 'Unburnt', 'Ash-Born'] } },
  thriceburned: { Bare: ['the Thrice-Burned', 'the Thrice-Kindled', 'the Charred', 'the Smoke-Black'],
    fixed: [[1, 'of the Three {Fires}']], N: ['Tinderbox', 'Pyre', 'Ash-Heap', 'Torch', 'Bonfire', 'Kindling', 'Cinder', 'Smoking Ruin', 'Brand'],
    words: { Fires: ['Fires', 'Burnings', 'Pyres', 'Blazes'] } },
  weeping: { Bare: ['the Weeping', 'the Mourning', 'the Grieving', 'the Widowed', 'the Bereft', 'the Sorrowful'],
    fixed: [[1, '{Fixed}']], N: ['Tears', 'Widow', 'Grief', 'Sorrow', 'Mourner', 'Lament', 'Wound', 'Heartache', 'Black Bell'],
    words: { Fixed: ['of the Black Bells', 'of the Silent Bells', 'of the Tolling Bells', 'of the Muffled Bells', 'of the Empty Streets', 'of the Silent Streets', 'of the Shuttered Doors',
      'of the Cold Hearths', 'of the Empty Hearths', 'of the Many Graves', 'of the Pyres', 'of the Lamentations', 'of the Chalked Doors', 'of the Long Mourning'] } },
  twiceburned: { Bare: ['the Twice-Burned', 'the Scorched', 'the Smoke-Blackened', 'the Fire-Scarred'],
    fixed: [[1, 'of the Two {Fires}']], N: ['Kindling', 'Cinder', 'Scorched Jewel', 'Smoking Heart', 'Charred Crown', 'Ember', 'Tinder', 'Burnt Offering'],
    words: { Fires: ['Fires', 'Burnings', 'Pyres', 'Blazes'] } },
  ofttaken: { Bare: ['the Oft-Taken', 'the Many-Mastered', 'the Fickle', 'the Coveted', 'the Ever-Taken', 'the Bartered'],
    fixed: [[0.6, 'the Prize of {Kings}'], [0.4, 'of Many {Banners}']], N: ['Prize', 'Spoil', 'Pawn', 'Plaything', 'Bride', 'Booty', 'Bauble', 'Trophy'],
    words: { Kings: ['Kings', 'Conquerors', 'Captains', 'Princes', 'Warlords'], Banners: ['Banners', 'Masters', 'Flags', 'Crowns', 'Lords'] } },
  learned: { Bare: ['the Learned', 'the Wise', 'the Lettered', 'the Bookish', 'the Erudite'],
    fixed: [[1, 'of the {Num} {Scrolls}']], N: ['Lamp', 'Library', 'Mind', 'Teacher', 'School', 'Scholar', 'Memory', 'Quill', 'Light'],
    words: { Num: ['Hundred', 'Thousand', 'Seven', 'Many'], Scrolls: ['Scrolls', 'Schools', 'Scribes', 'Books', 'Masters', 'Sages', 'Libraries', 'Lecterns'] } },
  fair: { Bare: ['of the Fairs', 'of the Markets', 'of the Stalls', 'of the Booths'],
    fixed: [[1, 'of the {Many} {Stalls}']], N: ['Market', 'Crossroads', 'Fairground', 'Purse', 'Exchange', 'Marketplace', 'Scales', 'Counting-House'],
    words: { Many: ['Hundred', 'Thousand', 'Great', 'Seven', 'Many', 'Winter', 'Summer', 'Spring'], Stalls: ['Fairs', 'Stalls', 'Markets', 'Roads', 'Booths', 'Scales', 'Caravans', 'Bazaars'] } },
  shaken: { Bare: ['the Shaken', 'the Trembling', 'the Cracked', 'the Quaking', 'the Split'],
    fixed: [[1, 'of the {Fallen} {Towers}']], N: ['Broken Crown', 'Cracked Bell', 'Trembling Jewel', 'Restless Stone', 'Quaking Heart', 'Shaken Pillar', 'Split Rock'],
    words: { Fallen: ['Fallen', 'Broken', 'Leaning', 'Cracked', 'Tumbled'], Towers: ['Towers', 'Walls', 'Spires', 'Domes', 'Gates', 'Bridges'] } },
  restless: { Bare: ['the Restless', 'the Unruly', 'the Turbulent', 'the Rebellious', 'the Riotous', 'the Ungovernable'],
    fixed: [[1, '{Fixed}']], N: ['Thorn', 'Torch', 'Firebrand', 'Bane', 'Hornet', 'Wildfire', 'Thistle', 'Wasp'],
    words: { Fixed: ['of the Thousand Grievances', 'of the Hundred Riots', 'of the Barricades', 'of the Burning Banners', 'of the Broken Shutters', 'of the Cobblestones',
      'of the Angry Bells', 'of the Hundred Mobs', 'of the Torn Edicts', 'of the Burning Tollhouses', 'of the Seven Risings', 'of the Hanged Governors'] } },
  ancient: { Bare: ['the Ancient', 'the Old', 'the Elder', 'the Eldest', 'the Venerable', 'the Hoary', 'the Timeless'],
    fixed: [[1, 'of the {Old} {Stones}']], N: ['Mother', 'Eldest', 'First City', 'Grandmother', 'Elder', 'Memory', 'Oldest Hearth', 'Root'],
    words: { Old: ['Old', 'Grey', 'Worn', 'Ancient', 'First', 'Mossy'], Stones: ['Stones', 'Walls', 'Gates', 'Kings', 'Roads', 'Wells'] } },
};
const EP_PLAIN = 0.55, EP_FIXED = 0.55;
for (const [key, d] of Object.entries(EP_DEFS)) {
  EPITHET_FORMS[key] = {
    forms: [[EP_PLAIN, '{Bare}'], ...d.fixed.map(([w, f]) => [w * EP_FIXED, f]),
      [2.4, 'the {N} of {people}'], [2.4, 'the {N} of {region}'], [1.6, 'the {N} of {realm}'], ...(d.extra || [])],
    words: { ...d.words, Bare: d.Bare, N: d.N },
  };
}

/**
 * The counter behind each epithet earned by what befell a town. One that was lost or displaced
 * comes back only when its counter has grown since (a new plague, fire, siege held…), so a town
 * is not re-announced as the Weeping every decade for the same old grief. Epithets of standing
 * (holy, free, great, golden, learned, ancient) may return with standing.
 */
export const EPITHET_SIG = {
  unbowed: (c) => c.cm.hc || 0,
  weeping: (c) => c.hist.plagues || 0,
  phoenix: (c) => c.hist.fires || 0,
  thriceburned: (c) => c.hist.fires || 0,
  twiceburned: (c) => c.hist.fires || 0,
  ofttaken: (c) => c.hist.conquered || 0,
  fair: (c) => c.cm.fairs || 0,
  shaken: (c) => c.hist.quakes || 0,
  restless: (c) => c.hist.riots || 0,
};

// ---------------------------------------------------------------------------
// Great beasts of the first ages: 2–4 named herds per continent (sys.events.beasts).
// group: which biomes they roam; pred: a hunter rather than a grazer.

const B = BIOME;
export const BEAST_KINDS = [
  { key: 'mammoth', name: 'Woolly Mammoths', one: 'mammoth', biomes: [B.TUNDRA, B.TAIGA, B.STEPPE, B.COLD_DESERT], meat: 1.3 },
  { key: 'rhino', name: 'Woolly Rhinoceroses', one: 'woolly rhinoceros', biomes: [B.TUNDRA, B.STEPPE, B.COLD_DESERT], meat: 1 },
  { key: 'muskox', name: 'Woolly Oxen', one: 'woolly ox', biomes: [B.TUNDRA, B.TAIGA], meat: 1 },
  { key: 'elk', name: 'Great Elk', one: 'great elk', biomes: [B.TAIGA, B.TEMPERATE_FOREST, B.TEMPERATE_RAINFOREST, B.WETLAND], meat: 1 },
  { key: 'aurochs', name: 'Aurochs', one: 'aurochs', biomes: [B.STEPPE, B.TEMPERATE_FOREST, B.SHRUBLAND], meat: 1.1 },
  { key: 'bison', name: 'Steppe Bison', one: 'steppe bison', biomes: [B.STEPPE, B.SHRUBLAND, B.COLD_DESERT], meat: 1.1 },
  { key: 'cavebear', name: 'Cave Bears', one: 'cave bear', biomes: [B.TAIGA, B.TEMPERATE_FOREST, B.ALPINE], meat: 0.6, pred: true },
  { key: 'sabrecat', name: 'Sabre-toothed Cats', one: 'sabre-toothed cat', biomes: [B.SAVANNA, B.STEPPE, B.SHRUBLAND, B.TROPICAL_FOREST], meat: 0.4, pred: true },
  { key: 'buffalo', name: 'Giant Buffalo', one: 'giant buffalo', biomes: [B.SAVANNA, B.TROPICAL_FOREST, B.WETLAND], meat: 1.2 },
  { key: 'terrorbird', name: 'Terror Birds', one: 'terror bird', biomes: [B.SAVANNA, B.SHRUBLAND, B.HOT_DESERT], meat: 0.5, pred: true },
  { key: 'sloth', name: 'Giant Ground Sloths', one: 'giant sloth', biomes: [B.TROPICAL_FOREST, B.RAINFOREST, B.SAVANNA], meat: 1.1 },
  { key: 'glyptodon', name: 'Glyptodons', one: 'glyptodon', biomes: [B.SAVANNA, B.SHRUBLAND, B.STEPPE], meat: 0.9 },
  { key: 'tuskers', name: 'Straight-tusked Elephants', one: 'straight-tusked elephant', biomes: [B.TEMPERATE_FOREST, B.TROPICAL_FOREST, B.SAVANNA], meat: 1.4 },
  { key: 'tapir', name: 'Giant Tapirs', one: 'giant tapir', biomes: [B.RAINFOREST, B.TROPICAL_FOREST, B.WETLAND], meat: 0.9 },
  { key: 'camel', name: 'Giant Camels', one: 'giant camel', biomes: [B.HOT_DESERT, B.COLD_DESERT, B.SHRUBLAND], meat: 0.9 },
  { key: 'beaver', name: 'Giant Beavers', one: 'giant beaver', biomes: [B.WETLAND, B.TAIGA, B.TEMPERATE_FOREST], meat: 0.6 },
  { key: 'moa', name: 'Moa', one: 'moa', biomes: [B.TEMPERATE_RAINFOREST, B.TEMPERATE_FOREST, B.SHRUBLAND, B.ALPINE], meat: 0.8 },
];
export const BEAST_BY_KEY = Object.fromEntries(BEAST_KINDS.map((b) => [b.key, b]));

// ---------------------------------------------------------------------------
// Ages of the world (ages.js). Each is a bundle of multipliers read through the ext providers:
//   rates: { key: mul } for the 'rates' point (prophet, schism, plagueEmergence, quake,
//          volcano, meteor, storm, wildfire, emergence, figureBirth, bandSpawn, horde, beastSpawn)
//   war: warAppetite multiplier; route / routeSea: routeValue multipliers (all / sea routes)
//   ev: { family: mul } for this deck's own weights
//   civ: a civ effect (mods deltas, applyFx) every living realm carries while the age lasts
// era: [lo, hi] world era (highest era any people has reached) when the age may be rolled.
// weight(world, f) → relative chance when rolled; f = facts (see ages.js rollFacts).
// tone: 'dark' | 'bright' | 'neutral' (the HUD tints the chip).

export const AGES = {
  prophets: {
    name: 'the Age of Prophets', short: 'Age of Prophets', tone: 'bright',
    desc: 'Seers walk every road; new faiths are born and old ones split.',
    civ: { culture: 0.05, stability: 0.02 },
    rates: { prophet: 2.2, schism: 1.5 }, ev: { sacred: 1.8 }, era: [0, 5],
    weight: (w, f) => 0.7 * f.religiosity,
  },
  restless: {
    name: 'the Age of the Restless Earth', short: 'Restless Earth', tone: 'dark',
    desc: 'The ground will not lie still: quakes and fire mountains everywhere.',
    civ: { production: -0.03, culture: 0.02 },
    rates: { quake: 2.2, volcano: 2.2 }, ev: { fire: 1.3, swan: 1.2 }, era: [0, 7],
    weight: (w, f) => 0.25 + 0.35 * (f.seismicity + f.volcanism),
  },
  plagues: {
    name: 'the Age of Plagues', short: 'Age of Plagues', tone: 'dark',
    desc: 'Sickness follows the roads; every crowded quarter dreads the next.',
    civ: { health: -0.03, birth: -0.03 },
    rates: { plagueEmergence: 1.6 }, war: 0.9, ev: { plague: 1.8, unrest: 1.2 }, era: [1, 7],
    weight: (w, f) => 0.35 * f.plagueRate,
  },
  horselords: {
    name: 'the Age of the Horse Lords', short: 'Horse Lords', tone: 'dark',
    desc: 'Riders out of the grass seas sweep across settled lands.',
    civ: { military: 0.08, movement: 0.05 },
    rates: { horde: 3, bandSpawn: 1.4 }, war: 1.2, ev: { feud: 1.5 }, era: [1, 5],
    weight: (w, f) => (f.steppe > 0.06 ? 0.4 + 3 * f.steppe : 0.05),
  },
  peace: {
    name: 'the Long Peace', short: 'Long Peace', tone: 'bright',
    desc: 'Swords rust; roads fill with merchants and the cities grow rich.',
    civ: { trade: 0.08, stability: 0.03, military: -0.05 },
    rates: { figureBirth: 1.3 }, war: 0.6, route: 1.2, ev: { fortune: 1.4, works: 1.3, civic: 1.2, feud: 0.6 }, era: [1, 7],
    weight: (w, f) => 0.5 / Math.max(0.3, f.aggression),
  },
  winter: {
    name: 'the Long Winter', short: 'Long Winter', tone: 'dark',
    desc: 'Cold summers and hungry winters; the herds and harvests fail.',
    civ: { farmYield: -0.1, gatherYield: -0.08 },
    rates: { storm: 1.4, wildfire: 0.6, emergence: 0.7 }, ev: { wild: 1.4, unrest: 1.25, works: 1.2 }, era: [0, 7],
    weight: (w, f) => 0.15 + 0.9 * f.volatility + (f.cold ? 1.5 : 0),
  },
  searovers: {
    name: 'the Age of Sea Rovers', short: 'Sea Rovers', tone: 'dark',
    desc: 'Black sails off every coast; no harbour sleeps easy.',
    civ: { trade: -0.04, military: 0.03 },
    rates: { bandSpawn: 1.6 }, routeSea: 0.8, ev: { envoys: 1.2, fortune: 1.1 }, era: [1, 6],
    weight: (w, f) => (f.navigators ? 0.6 : 0),
  },
  discovery: {
    name: 'the Age of Discovery', short: 'Age of Discovery', tone: 'bright',
    desc: 'Ships cross the open ocean and the far shores meet.',
    civ: { trade: 0.05, tradeRange: 4, seaRange: 6 },
    rates: { figureBirth: 1.3 }, routeSea: 1.3, ev: { ages: 1.8, learning: 1.3, fortune: 1.2 }, era: [4, 7],
    weight: (w, f) => (f.oceanGoing ? 1.2 : 0.2),
  },
  fire: {
    name: 'the Burning Years', short: 'Burning Years', tone: 'dark',
    desc: 'Dry winds and red skies: forests and cities alike catch fire.',
    civ: { farmYield: -0.04, production: 0.02 },
    rates: { wildfire: 1.8, storm: 1.15 }, ev: { fire: 1.8 }, era: [0, 7],
    weight: (w, f) => 0.15 + 0.4 * f.wildfire + (f.hot ? 0.8 : 0),
  },
  strife: {
    name: 'the Age of Iron and Blood', short: 'Iron and Blood', tone: 'dark',
    desc: 'Every border bleeds; warlords and free companies prosper.',
    civ: { military: 0.1, stability: -0.03 },
    rates: { bandSpawn: 1.3, figureBirth: 1.1 }, war: 1.45, ev: { feud: 1.4, unrest: 1.3, court: 1.2 }, era: [1, 7],
    weight: (w, f) => 0.45 * f.aggression,
  },
  learning: {
    name: 'the Age of Learning', short: 'Age of Learning', tone: 'bright',
    desc: 'Scholars are honoured, books copied and the old lore rediscovered.',
    civ: { research: 0.1, culture: 0.05 },
    rates: { figureBirth: 1.5, schism: 1.2 }, ev: { learning: 1.8, works: 1.3 }, era: [2, 7],
    weight: (w, f) => 0.35 + 0.3 * f.techRate,
  },
  wanderings: {
    name: 'the Age of Wanderings', short: 'Wanderings', tone: 'neutral',
    desc: 'Whole peoples take to the road in search of new lands.',
    civ: { expansionRange: 2, stability: -0.02 },
    rates: { emergence: 1.8, horde: 1.4, bandSpawn: 1.2 }, ev: { wild: 1.2, envoys: 1.1 }, era: [0, 3],
    weight: (w, f) => 0.3 + 0.4 * f.emergence,
  },
  omens: {
    name: 'the Age of Omens', short: 'Age of Omens', tone: 'neutral',
    desc: 'Stars fall and comets burn; seers read doom in every sky.',
    civ: { stability: -0.02, culture: 0.03 },
    rates: { meteor: 1.8, prophet: 1.3 }, ev: { sacred: 1.3, swan: 1.6 }, era: [0, 7],
    weight: (w, f) => 0.12 + 0.3 * f.meteorRate,
  },
  plenty: {
    name: 'the Age of Plenty', short: 'Age of Plenty', tone: 'bright',
    desc: 'Mild seasons and full granaries; markets and feasts abound.',
    civ: { farmYield: 0.08, happiness: 0.02, birth: 0.03 },
    rates: { wildfire: 0.8, storm: 0.85, figureBirth: 1.15 }, ev: { fortune: 1.5, civic: 1.3, unrest: 0.8 }, era: [0, 7],
    weight: (w, f) => (f.cold ? 0.1 : 0.55),
  },
};
/**
 * Age names (ages.js ageName): per key, weighted forms over themed words, with {adj} the people
 * that called the age up (a hegemon's Peace, a navigator's Voyages) and {world} the world's name.
 * The `name` above stays the canonical one; a composed name is saved on the age record.
 */
export const AGE_FORMS = {
  prophets: { forms: [[1, 'the Age of Prophets'], [2, 'the Age of {Adj} {Noun}'], [1.5, 'the Years of {Adj} {Noun}'], [1, 'the Time of {Noun}']],
    words: { Adj: ['Wandering', 'Burning', 'Many', 'New', 'Wild', 'Countless', 'Barefoot', 'Weeping'], Noun: ['Prophets', 'Seers', 'Saints', 'Visions', 'Gods', 'Voices', 'Preachers', 'Oracles'] } },
  restless: { forms: [[1, 'the Age of the Restless Earth'], [2, 'the {Adj} Years'], [1.5, 'the Age of {Noun} and {Noun}'], [1.2, 'the Years of the {Adj2} Ground']],
    words: { Adj: ['Shaking', 'Trembling', 'Burning', 'Restless', 'Cracking', 'Smoking'], Noun: ['Ash', 'Thunder', 'Fire', 'Stone', 'Smoke', 'Ruin'], Adj2: ['Broken', 'Restless', 'Split', 'Trembling', 'Burning'] } },
  plagues: { forms: [[1, 'the Age of Plagues'], [2, 'the {Adj} Years'], [1.5, 'the Years of the {Color} {Death}'], [1.2, 'the Time of {Noun}'], [2.5, 'the Years of {plague}']],
    words: { Adj: ['Pestilent', 'Coughing', 'Sickly', 'Fevered', 'Burying', 'Shuttered'], Color: ['Grey', 'Black', 'Red', 'Pale', 'Yellow', 'Sallow'], Death: ['Death', 'Fever', 'Cough', 'Pox', 'Sweat'],
      Noun: ['Fevers', 'Burials', 'Plagues', 'Shut Doors', 'Pyres', 'Bells'] } },
  horselords: { forms: [[1, 'the Age of the Horse Lords'], [2, 'the Age of the {Noun}'], [1.4, 'the Years of the {Noun}'], [1, 'the Time of the {Thing}']],
    words: { Noun: ['Riders', 'Horse Lords', 'Khans', 'Hordes', 'Horse-Peoples', 'Steppe Lords', 'Horse-Archers'], Thing: ['Hooves', 'Saddle', 'Bow', 'Whip', 'Long Ride'] } },
  peace: { forms: [[1, 'the Long Peace'], [2, 'the {Adj} {Noun}'], [1.4, 'the Years of {Thing}'], [3, 'the {adj} Peace']],
    words: { Adj: ['Long', 'Great', 'Quiet', 'Golden', 'Gentle', 'Halcyon', 'Deep'], Noun: ['Peace', 'Quiet', 'Concord', 'Calm', 'Truce', 'Accord'], Thing: ['Rusting Swords', 'Open Roads', 'Full Markets', 'Concord', 'Idle Spears'] } },
  winter: { forms: [[1, 'the Long Winter'], [2, 'the {Adj} {Noun}'], [1.4, 'the Years of {Thing}'], [1, 'the Age of {Ice}']],
    words: { Adj: ['Long', 'Great', 'White', 'Hungry', 'Iron', 'Bitter', 'Grey', 'Silent'], Noun: ['Winter', 'Cold', 'Frost', 'Dark', 'Snows', 'Freeze'],
      Thing: ['No Summer', 'Hunger', 'the Wolf Winters', 'Late Springs', 'Thin Harvests'], Ice: ['Ice', 'Snow', 'Frost', 'Hunger'] } },
  searovers: { forms: [[1, 'the Age of Sea Rovers'], [2, 'the Age of {Color} Sails'], [1.4, 'the Years of the {Noun}'], [1, 'the Time of Burning {Coasts}']],
    words: { Color: ['Black', 'Red', 'Grey', 'Ragged'], Noun: ['Reavers', 'Corsairs', 'Sea-Wolves', 'Raiders', 'Longships', 'Sea Rovers'], Coasts: ['Coasts', 'Harbours', 'Shores', 'Quays'] } },
  discovery: { forms: [[1, 'the Age of Discovery'], [2, 'the Age of {Noun}'], [1.4, 'the Years of the {Thing}'], [3, 'the {adj} Voyages']],
    words: { Noun: ['Sails', 'New Shores', 'Charts', 'Far Voyages', 'Navigators', 'Compasses'], Thing: ['Open Sea', 'Far Shores', 'Long Voyages', 'New Stars'] } },
  fire: { forms: [[1, 'the Burning Years'], [2, 'the {Adj} {Noun}'], [1.4, 'the Age of {Ash}'], [1, 'the Time of {Ash}']],
    words: { Adj: ['Burning', 'Red', 'Smoking', 'Dry', 'Scorched', 'Kindling'], Noun: ['Years', 'Summers', 'Seasons', 'Skies'], Ash: ['Ash', 'Embers', 'Smoke', 'Red Skies', 'Cinders'] } },
  strife: { forms: [[1, 'the Age of Iron and Blood'], [2, 'the Age of {Noun} and {Noun}'], [1.4, 'the {Adj} Centuries'], [1, 'the Years of the {Beast}']],
    words: { Noun: ['Iron', 'Blood', 'Swords', 'Ruin', 'Fire', 'Spears', 'Crows', 'Ashes'], Adj: ['Red', 'Warring', 'Iron', 'Bloody', 'Broken', 'Burning'], Beast: ['Wolf', 'Crow', 'Sword', 'Vulture', 'Spear'] } },
  learning: { forms: [[1, 'the Age of Learning'], [2, 'the Age of {Noun}'], [1.4, 'the {Adj} Centuries'], [1, 'the Years of the {Thing}']],
    words: { Noun: ['Scholars', 'Books', 'Lamps', 'Learning', 'Libraries', 'Sages', 'Letters'], Adj: ['Bright', 'Lettered', 'Lamplit', 'Learned', 'Golden'], Thing: ['Quill', 'Lamp', 'Open Book', 'Scribes'] } },
  wanderings: { forms: [[1, 'the Age of Wanderings'], [2, 'the Great {Noun}'], [1.4, 'the Time of {Thing}'], [1, 'the Years of the {Who}']],
    words: { Noun: ['Migrations', 'Wanderings', 'Treks', 'Exodus', 'Uprooting'], Thing: ['Long Roads', 'Carts and Herds', 'Wandering Peoples', 'the Uprooted'], Who: ['Uprooted', 'Wanderers', 'Wagons', 'Herds'] } },
  omens: { forms: [[1, 'the Age of Omens'], [2, 'the Age of {Noun}'], [1.4, 'the Years of {Thing}'], [1, 'the {Adj} Skies']],
    words: { Noun: ['Omens', 'Comets', 'Signs', 'Portents', 'Falling Stars', 'Wonders'], Thing: ['Falling Stars', 'Comets', 'Red Moons', 'Dark Signs'], Adj: ['Uneasy', 'Burning', 'Weeping', 'Restless'] } },
  plenty: { forms: [[1, 'the Age of Plenty'], [2, 'the {Adj} {Noun}'], [1.4, 'the Years of {Thing}'], [1, 'the Age of {Gift}']],
    words: { Adj: ['Golden', 'Fat', 'Green', 'Full', 'Sweet', 'Kindly'], Noun: ['Harvests', 'Years', 'Summers', 'Centuries', 'Seasons'], Thing: ['Full Barns', 'Honey', 'Plenty', 'Fat Cattle'], Gift: ['Plenty', 'Honey', 'Bread', 'Abundance'] } },
};
export const AGE_KEYS = Object.keys(AGES);
/** Ages that cannot run together. */
export const AGE_CLASH = [['peace', 'strife'], ['winter', 'fire'], ['winter', 'plenty'], ['plenty', 'plagues'], ['peace', 'horselords']];
