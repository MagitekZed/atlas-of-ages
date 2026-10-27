// Technology: the 48-tech tree across the eight ERAS, research and diffusion, era
// advancement, and the derived modifier object every other module reads via getMods().
//
// civ.tech = { known: { techId: dayLearned }, points (lifetime research), research (techId
//              being studied | null), progress (points into it), era (0..7),
//              from: { techId: 'h' | 'h:civId' } how each was learned (knowledge.js HOW; missing
//              in an old save: its own research), head: { techId: [points, 'h:civId'] } head
//              starts from conquest, arms, scholars and refugees, cue: [techId, 'h:civId'] the
//              source of the research under way, lost: { techId: day } knowledge lost in a
//              collapse (relearnt at half the cost; knowledge.js), arts: { artId: sid } (arts.js) }
//
// Tiers (docs/design/inventions.md): every tech is common or uncommon (t.tier); a tech with
// t.needs(world, civ) costs ALONE times as much to invent without that land or situation and
// with no teacher in reach (ext 'inventRule' may answer instead). Spread: each contact that
// knows a tech cuts its cost (trade or alliance 22 %, else 14 %; across peoples half, for an
// arcane art, unless the learner is human), so do towns taken from a realm that knows it (up to
// 30 %), all × the realm's openness (1.15 − 0.3 × isolation, ext 'learnRule'), at most 60 %.
//
// Mods (getMods(world, civ) → always a complete object; multipliers default 1):
//   farming        0/1 agriculture known          farmYield, gatherYield, fishYield
//   housing        housing capacity multiplier     health (health target multiplier)
//   birth          birth-rate multiplier           research, culture, production, trade
//   tradeRange     tiles (default 10)              military, defense, siege
//   movement       army tiles/day multiplier       navigation 0 none, 1 coastal, 2 open sea
//   medicine       ≤ 1, multiplies plague lethality
//   sanitation     multiplier (≥ 1 reduces urban disease and crowding deaths)
//   mining         ore/stone extraction multiplier
//   stability      additive (default 0)            expansionRange tiles (default 8)
//   industry       0..1+ (default 0) industrial capacity, drives factories and emissions
//   pollution      default 0, emission intensity per unit of industry
//   plagueResist   additive 0..0.5 (disease module reduces infectivity / lethality)
// Extra keys (civ module, safe for others to read):
//   storage        food-keeping multiplier (spoilage ÷ storage)
//   taxEfficiency  multiplier on collected taxes   adminRange tiles governed without strain (12)
//   seaRange       extra tiles colonists can sail  happiness additive settlement happiness
//   soilCare       0..1 reduces soil exhaustion    irrigation 0/1 irrigated farming near water
// Registered keys (core/ext.js registerModKeys, e.g. arcana, wards, taming, forestFarm,
// deepHalls, mortality in Mythic worlds) join with their own default, limit and kind; a
// registered key is stored on civ.mods only while it differs from its default (else it is
// undefined, which is never saved), so a Historical world's saved mods never depend on which
// modules were loaded. Read them with modValue(mods, key).
//
// computeMods order (contracts §6, §7): techs, government, ruler, temperament, golden / dark
// age, wonders, great figures; then the civ's timed effects (core/effects.js, applyFx
// semantics; an effect counts for the whole month in which it is live, judged at the month's
// first day like settlementMods); then every ext 'mods' provider; then the limits.
// civ.mods carries _v (MODS_VERSION) and _e (the civ.effectsV it was computed from): both are
// saved state, so getMods recomputes exactly when the effects change — in a continuous run
// and in a reloaded one alike. extVersion() (process-local) only keys the merged tables below.
//
// Registered techs (registerTechs) join the tree lazily; branch 'arcane' never counts toward
// the historical eras (computeEra, grantEra, grantWorldKnowledge), available(w, civ) gates
// research, and the optional costMul(w, civ) / researchWeight(w, civ) of a def scale its cost
// and its pull on the research choice (an arcane pick is held to under a quarter of research).

import { DAYS_PER_YEAR, DAYS_PER_MONTH, ERAS, RESOURCES, BIOME } from '../../core/constants.js';
import { emitFx } from '../../core/world.js';
import { emit } from '../../core/hooks.js';
import { concatOf, mulOf, firstOf, hasProviders, extVersion, getModKeys, getRegisteredTechs } from '../../core/ext.js';
import { GOVERNMENTS, RULER_TRAITS, wonderDef, ARTS } from './data.js';
import { fin, record, civTowns } from './state.js';
import { borderNeighbours } from './territory.js';
import { PeopleOf, TheName, theName, peopleOf, pick } from './prose.js';

/** Base cost per era (research points); individual techs vary around it. */
const ERA_COST = [5500, 45000, 430000, 1150000, 2400000, 4000000, 7000000, 16000000];
/** Global calibration of research costs (tuned for the SPEC era pacing at techRate 1). */
export const COST_SCALE = 1;
/** Number of an era's techs needed to enter it. */
export const ERA_ENTRY = 2;

// cat: farm | craft | sea | faith | science | commerce | military | civic | health | industry
// first: completes "…were the first <first>."   deed: what a great scholar did for it.
const T = (id, name, era, prereqs, fx, cat, first, deed, costMul = 1) => ({ id, name, era, prereqs, fx, cat, first, deed, cost: Math.round(ERA_COST[era] * costMul) });

export const TECHS = [
  // --- Stone Age ----------------------------------------------------------------------
  T('toolmaking', 'Stone Tools', 0, [], { production: 0.1, gatherYield: 0.15 }, 'craft',
    'to knap fine blades of flint', 'shaped the first polished stone axes', 0.8),
  T('fishing', 'Fishing', 0, [], { fishYield: 0.4 }, 'sea',
    'to weave nets and carve bone hooks', 'learned to smoke fish against the winter', 0.8),
  T('mysticism', 'Mysticism', 0, [], { culture: 0.15, stability: 0.03 }, 'faith',
    'to raise shrines to the spirits of the land', 'gave names to the spirits of sky and earth', 0.9),
  T('agriculture', 'Agriculture', 0, ['toolmaking'], { farming: 1, gatherYield: 0.05 }, 'farm',
    'to sow fields of grain', 'learned which wild grasses could be sown and reaped', 1.4),
  T('husbandry', 'Animal Husbandry', 0, ['toolmaking'], { gatherYield: 0.1, farmYield: 0.1, soilCare: 0.15, military: 0.05 }, 'farm',
    'to tame wild herds', 'bred docile herds of goats and cattle', 1.1),
  T('pottery', 'Pottery', 0, ['agriculture'], { storage: 0.3, health: 0.02 }, 'craft',
    'to fire clay into pots and storage jars', 'built a kiln hot enough to fire clay', 1.0),
  T('bow', 'The Bow', 0, ['toolmaking'], { gatherYield: 0.1, military: 0.1 }, 'military',
    'to hunt and fight with the bow', 'strung the first bow of yew and sinew', 0.6),
  T('canoes', 'Rafts and Canoes', 0, ['toolmaking'], { fishYield: 0.15, seaRange: 3, movement: 0.03 }, 'sea',
    'to paddle canoes across the water', 'hollowed a great log into a canoe', 0.6),
  T('weaving', 'Weaving', 0, ['husbandry'], { storage: 0.05, happiness: 0.02, trade: 0.05 }, 'craft',
    'to weave cloth upon the loom', 'built the first upright loom', 0.6),

  // --- Bronze Age ---------------------------------------------------------------------
  T('bronze', 'Bronze Working', 1, ['toolmaking'], { military: 0.25, production: 0.1, mining: 0.3 }, 'military',
    'to smelt copper and tin into bronze', 'found the secret of alloying copper with tin', 1.0),
  T('masonry', 'Masonry', 1, ['toolmaking', 'agriculture'], { defense: 0.3, housing: 0.15 }, 'craft',
    'to raise walls of dressed stone', 'devised the corbelled arch', 0.9),
  T('wheel', 'The Wheel', 1, ['husbandry'], { movement: 0.15, trade: 0.1, tradeRange: 3, adminRange: 2, expansionRange: 1 }, 'commerce',
    'to build wheeled carts', 'built a cart that rolled on spoked wheels', 0.95),
  T('sailing', 'Sailing', 1, ['fishing', 'canoes'], { navigation: 1, fishYield: 0.2, trade: 0.1, seaRange: 10 }, 'sea',
    'to raise sails upon the water', 'rigged a sail upon a reed boat and rode the wind', 1.0),
  T('writing', 'Writing', 1, ['pottery', 'mysticism'], { research: 0.2, culture: 0.1, stability: 0.02, adminRange: 2 }, 'science',
    'to set down words in writing', 'devised a script of signs pressed into clay', 1.15),
  T('irrigation', 'Irrigation', 1, ['agriculture'], { farmYield: 0.25, irrigation: 1 }, 'farm',
    'to dig irrigation canals', 'led the river into the fields through a web of ditches', 1.0),
  T('plough', 'The Plough', 1, ['agriculture', 'husbandry'], { farmYield: 0.15 }, 'farm',
    'to break the soil with the ox-drawn plough', 'yoked oxen to a plough that turned the heavy earth', 0.75),
  T('calendar', 'The Calendar', 1, ['mysticism', 'agriculture'], { farmYield: 0.05, culture: 0.05, stability: 0.02 }, 'science',
    'to reckon the year by the sun and stars', 'set stones to mark the solstices and counted the days of the year', 0.7),
  T('chariot', 'The Chariot', 1, ['wheel', 'husbandry'], { military: 0.15, movement: 0.05 }, 'military',
    'to drive war chariots', 'built a chariot light enough to outrun the wind', 0.85),

  // --- Iron Age -----------------------------------------------------------------------
  T('iron', 'Iron Working', 2, ['bronze'], { military: 0.25, production: 0.15, farmYield: 0.1, mining: 0.2 }, 'military',
    'to forge iron', 'built a furnace hot enough to smelt iron from bog ore', 1.05),
  T('mathematics', 'Mathematics', 2, ['writing'], { research: 0.15, siege: 0.3 }, 'science',
    'to master the art of number', 'set down the rules of geometry', 1.0),
  T('currency', 'Currency', 2, ['writing', 'bronze'], { trade: 0.2, taxEfficiency: 0.1 }, 'commerce',
    'to strike coins', 'struck coins of stamped silver', 0.95),
  T('horseback', 'Horseback Riding', 2, ['husbandry'], { movement: 0.2, military: 0.1, tradeRange: 3, adminRange: 3, expansionRange: 2 }, 'military',
    'to ride to war on horseback', 'broke wild horses to the saddle', 0.95),
  T('laws', 'Code of Laws', 2, ['writing'], { stability: 0.05, taxEfficiency: 0.1, adminRange: 3 }, 'civic',
    'to carve their laws in stone', 'carved the laws of the land upon a pillar of basalt', 1.0),
  T('alphabet', 'The Alphabet', 2, ['writing'], { research: 0.08, culture: 0.05, adminRange: 1 }, 'science',
    'to write with an alphabet', 'reduced a thousand signs to two dozen letters', 0.7),
  T('roads', 'Roads', 2, ['masonry', 'wheel'], { movement: 0.12, trade: 0.05, tradeRange: 3, adminRange: 2 }, 'civic',
    'to pave roads between their towns', 'paved a road straight across the land, town to town', 0.8),
  T('galley', 'The War Galley', 2, ['sailing', 'bronze'], { military: 0.05, seaRange: 4 }, 'sea',
    'to row war galleys with bronze rams', 'fitted a galley with a bronze ram at the waterline', 0.85),

  // --- Classical Age ------------------------------------------------------------------
  T('philosophy', 'Philosophy', 3, ['mathematics', 'laws'], { research: 0.2, culture: 0.2 }, 'science',
    'to found schools of philosophy', 'founded a school that questioned the nature of all things', 1.05),
  T('engineering', 'Engineering', 3, ['mathematics', 'masonry'], { housing: 0.25, defense: 0.2, movement: 0.1, adminRange: 3, health: 0.03 }, 'craft',
    'to build aqueducts and great bridges', 'designed an aqueduct that carried water across a valley', 1.0),
  T('medicine', 'Medicine', 3, ['philosophy'], { health: 0.05, medicine: 0.85, plagueResist: 0.05 }, 'health',
    'to practise the healing arts', 'wrote a great treatise on the healing arts', 0.95),
  T('shipbuilding', 'Shipbuilding', 3, ['sailing', 'iron'], { trade: 0.15, tradeRange: 5, seaRange: 8, fishYield: 0.15, military: 0.05 }, 'sea',
    'to launch oared galleys', 'laid the keel of a great oared galley', 0.95),
  T('drama', 'Drama and Poetry', 3, ['writing', 'mysticism'], { culture: 0.25, happiness: 0.03 }, 'civic',
    'to stage plays before the people', 'wrote a tragedy that moved the whole city to tears', 0.9),
  T('tactics', 'Military Tactics', 3, ['iron', 'horseback'], { military: 0.25, siege: 0.2 }, 'military',
    'to drill disciplined legions', 'wrote a manual of war still studied centuries later', 1.0),
  T('paper', 'Paper', 3, ['writing', 'weaving'], { research: 0.1, culture: 0.05, adminRange: 1 }, 'science',
    'to make paper', 'beat bark and rags into pulp and pressed it into sheets', 0.85),
  T('watermill', 'The Water Mill', 3, ['engineering', 'wheel'], { production: 0.15, farmYield: 0.05 }, 'craft',
    'to grind grain with water mills', 'set a wheel in the millrace to turn the grindstones', 0.8),
  T('siegeengines', 'Siege Engines', 3, ['engineering', 'mathematics'], { siege: 0.3, military: 0.05 }, 'military',
    'to build engines of siege', 'wound ropes of sinew to hurl stones against the walls', 0.9),
  T('maps', 'Maps', 3, ['mathematics'], { expansionRange: 1, tradeRange: 3, seaRange: 3 }, 'science',
    'to draw maps of the known world', 'drew a map of the world ruled by lines of latitude', 0.75),

  // --- Medieval Age -------------------------------------------------------------------
  T('feudalism', 'Feudalism', 4, ['laws', 'tactics'], { defense: 0.3, stability: 0.04, military: 0.1 }, 'civic',
    'to bind lords and vassals by oath', 'codified the oaths of lord and vassal', 1.0),
  T('theology', 'Theology', 4, ['philosophy', 'mysticism'], { culture: 0.15, stability: 0.05, happiness: 0.02 }, 'faith',
    'to write learned works of theology', 'reconciled faith and reason in a great summa', 0.95),
  T('astronomy', 'Astronomy', 4, ['mathematics', 'philosophy', 'calendar'], { research: 0.15, seaRange: 4 }, 'science',
    'to chart the wandering stars', 'charted the courses of the wandering stars', 1.0),
  T('croprotation', 'Crop Rotation', 4, ['plough', 'iron'], { farmYield: 0.35, soilCare: 0.3 }, 'farm',
    'to rotate their fields through the seasons', 'proved that a field rested with clover returns richer', 0.9),
  T('guilds', 'Guilds', 4, ['currency', 'engineering'], { production: 0.2, trade: 0.1 }, 'commerce',
    'to organise their crafts into guilds', 'drew up the charters of the craft guilds', 0.95),
  T('scholasticism', 'Scholasticism', 4, ['philosophy', 'theology'], { research: 0.25, culture: 0.1 }, 'science',
    'to found universities', 'founded a university of masters and students', 1.05),
  T('stirrup', 'The Stirrup', 4, ['horseback', 'iron'], { military: 0.1 }, 'military',
    'to charge with lance and stirrup', 'hung iron stirrups from the saddle and couched the lance', 0.75),
  T('compass', 'The Compass', 4, ['iron', 'sailing'], { seaRange: 10, trade: 0.05 }, 'sea',
    'to steer by the compass', 'floated a lodestone needle that always pointed north', 0.75),
  T('windmill', 'The Windmill', 4, ['engineering', 'weaving'], { production: 0.1, farmYield: 0.05 }, 'craft',
    'to grind grain with windmills', 'raised a mill whose sails turned with the wind', 0.8),
  T('clock', 'The Mechanical Clock', 4, ['guilds', 'astronomy'], { production: 0.05, research: 0.05 }, 'science',
    'to keep the hours with clocks', 'built a clock of weights and an escapement', 0.8),
  T('bookkeeping', 'Double-Entry Bookkeeping', 4, ['mathematics', 'guilds'], { taxEfficiency: 0.1, trade: 0.05 }, 'commerce',
    'to keep accounts by double entry', 'invented double-entry bookkeeping', 0.75),

  // --- Renaissance --------------------------------------------------------------------
  T('navigation', 'Navigation', 5, ['astronomy', 'shipbuilding', 'compass'], { navigation: 2, tradeRange: 10, seaRange: 30, expansionRange: 2 }, 'sea',
    'to sail the open ocean', 'perfected the astrolabe and charted the open ocean', 1.0),
  T('printing', 'Printing Press', 5, ['scholasticism', 'guilds', 'paper'], { research: 0.3, culture: 0.2, stability: 0.03 }, 'science',
    'to print books with movable type', 'built a press of movable type', 1.0),
  T('gunpowder', 'Gunpowder', 5, ['medicine', 'guilds'], { military: 0.45, siege: 0.6 }, 'military',
    'to wield gunpowder in war', 'mixed saltpetre, sulphur and charcoal into black powder', 1.0),
  T('banking', 'Banking', 5, ['currency', 'guilds', 'bookkeeping'], { trade: 0.25, taxEfficiency: 0.15 }, 'commerce',
    'to found banks and letters of credit', 'founded a bank that lent on letters of credit', 0.95),
  T('anatomy', 'Anatomy', 5, ['medicine', 'printing'], { health: 0.05, medicine: 0.8, plagueResist: 0.05 }, 'health',
    'to study the anatomy of the body', 'described the circulation of the blood', 0.95),
  T('science', 'Scientific Method', 5, ['printing', 'astronomy'], { research: 0.4 }, 'science',
    'to test nature by experiment', 'set out the method of experiment and proof', 1.1),
  T('cannon', 'The Cannon', 5, ['gunpowder'], { siege: 0.8, military: 0.1 }, 'military',
    'to batter walls with cannon', 'cast a great bombard that broke walls of stone', 0.9),
  T('telescope', 'The Telescope', 5, ['astronomy', 'guilds'], { research: 0.08, seaRange: 4 }, 'science',
    'to search the heavens with telescopes', 'ground lenses that showed the moons of the wandering stars', 0.8),
  T('company', 'The Chartered Company', 5, ['banking', 'navigation'], { trade: 0.15, seaRange: 15, expansionRange: 2 }, 'commerce',
    'to found chartered trading companies', 'chartered a company to trade beyond the seas', 0.9),

  // --- Industrial Age -----------------------------------------------------------------
  T('steam', 'Steam Power', 6, ['science', 'cannon'], { production: 0.5, industry: 0.5, pollution: 0.4, birth: -0.05 }, 'industry',
    'to harness steam', 'built an engine driven by steam', 1.0),
  T('railways', 'Railways', 6, ['steam'], { movement: 0.6, tradeRange: 15, trade: 0.3, adminRange: 8, expansionRange: 4 }, 'industry',
    'to lay iron railways', 'drove a locomotive along iron rails', 1.0),
  T('sanitation', 'Sanitation', 6, ['anatomy', 'engineering'], { sanitation: 0.6, health: 0.08, housing: 0.5, birth: -0.1 }, 'health',
    'to build sewers beneath their cities', 'traced a cholera outbreak to a single fouled well', 0.95),
  T('chemistry', 'Industrial Chemistry', 6, ['steam', 'science'], { farmYield: 0.6, production: 0.1, industry: 0.2, pollution: 0.3, soilCare: 0.2 }, 'industry',
    'to make fertiliser in factories', 'fixed nitrogen from the air to feed the fields', 1.0),
  T('vaccines', 'Vaccination', 6, ['anatomy', 'science'], { medicine: 0.6, plagueResist: 0.2, health: 0.05 }, 'health',
    'to vaccinate against disease', 'proved that cowpox could guard against the pox', 0.95),
  T('electricity', 'Electricity', 6, ['science', 'steam'], { research: 0.3, production: 0.3, industry: 0.2, pollution: 0.1, housing: 0.3 }, 'industry',
    'to light their cities with electricity', 'tamed the lightning in copper wire', 1.05),
  T('telegraph', 'The Telegraph', 6, ['electricity', 'railways'], { adminRange: 6, stability: 0.03 }, 'industry',
    'to send words by telegraph', 'sent a message along a wire faster than any horse', 0.9),
  T('factory', 'The Factory System', 6, ['steam', 'guilds'], { production: 0.3, industry: 0.3, pollution: 0.2, happiness: -0.02 }, 'industry',
    'to work in factories', 'gathered a hundred looms under one roof and one engine', 0.9),
  T('rifle', 'The Rifle', 6, ['chemistry', 'gunpowder'], { military: 0.3, defense: 0.2 }, 'military',
    'to arm their soldiers with rifles', 'cut spiral grooves in a musket barrel', 0.9),
  T('steamship', 'The Steamship', 6, ['steam', 'navigation'], { seaRange: 30, tradeRange: 10, trade: 0.1 }, 'sea',
    'to cross the oceans under steam', 'drove a ship across the ocean with paddle wheels', 0.9),

  // --- Modern Age ---------------------------------------------------------------------
  T('combustion', 'Combustion Engine', 7, ['railways', 'chemistry'], { movement: 0.5, production: 0.4, industry: 0.2, pollution: 0.4 }, 'industry',
    'to build engines of combustion', 'built an engine that burned oil', 1.0),
  T('flight', 'Flight', 7, ['combustion', 'electricity'], { movement: 0.4, military: 0.4, tradeRange: 20, seaRange: 40 }, 'industry',
    'to take to the skies', 'flew a powered aircraft', 1.0),
  T('antibiotics', 'Antibiotics', 7, ['vaccines', 'chemistry'], { medicine: 0.4, health: 0.1, plagueResist: 0.2, birth: -0.1 }, 'health',
    'to cure infection with antibiotics', 'found a mould that killed the deadliest germs', 0.95),
  T('massmedia', 'Mass Media', 7, ['electricity', 'printing'], { stability: 0.05, culture: 0.3, happiness: 0.03 }, 'civic',
    'to broadcast by radio', 'broadcast a voice across the land', 0.9),
  T('computers', 'Computers', 7, ['electricity', 'massmedia'], { research: 0.6, production: 0.2, birth: -0.05 }, 'science',
    'to build computing machines', 'built a thinking machine of switches and wire', 1.1),
  T('greenrev', 'Green Revolution', 7, ['chemistry', 'combustion'], { farmYield: 1.0 }, 'farm',
    'to breed miracle strains of grain', 'bred a dwarf wheat that doubled the harvest', 1.0),
  T('renewables', 'Renewable Power', 7, ['computers', 'electricity'], { pollution: -0.7, industry: 0.1 }, 'industry',
    'to draw clean power from wind and sun', 'built a great field of sun-mirrors', 1.05),
];

// ---------------------------------------------------------------------------
// Tiers: what a realm needs to invent a tech alone

/** Three times the cost to invent an uncommon tech without its land and with no teacher in reach. */
export const ALONE = 3;
/** Bits of a town's land scan (s.flags.lnd, civ/settlement.js): one per biome (BIOME ids), then these. */
export const LAND = { river: 1 << 17, hills: 1 << 18, mountains: 1 << 19 };
const B = (...keys) => keys.reduce((m, k) => m | (1 << BIOME[k]), 0);
const RES_ID = Object.fromEntries(RESOURCES.map((r) => [r.key, r.id]));
const hasRes = (civ, key) => (fin(civ.flags?.res) & (1 << RES_ID[key])) !== 0;
const hasLand = (civ, mask) => (fin(civ.flags?.lnd) & mask) !== 0;
const onCoast = (civ) => fin(civ.flags?.coastShare) > 0;
const FOREST_WET = B('TEMPERATE_FOREST', 'TEMPERATE_RAINFOREST', 'TROPICAL_FOREST', 'RAINFOREST', 'WETLAND', 'TAIGA');
const SALTPETRE = B('HOT_DESERT', 'COLD_DESERT', 'SHRUBLAND') | LAND.mountains;
/** A town of city size (tier 4+) with a market: banking's counting houses. */
const cityMarket = (world, civ) => civTowns(world, civ).some((s) => s.tier >= 4 && fin(s.buildings?.market) > 0);

/** The condition to invent each uncommon tech alone. */
const NEEDS = {
  bronze: (w, c) => hasRes(c, 'copper') || hasRes(c, 'tin'),
  horseback: (w, c) => hasRes(c, 'horses'),
  irrigation: (w, c) => hasLand(c, LAND.river | B('LAKE')),
  sailing: (w, c) => onCoast(c) || hasLand(c, B('LAKE')),
  shipbuilding: (w, c) => onCoast(c),
  navigation: (w, c) => hasLand(c, B('DEEP_OCEAN')),
  banking: cityMarket,
  gunpowder: (w, c) => hasLand(c, SALTPETRE),
  steam: (w, c) => hasRes(c, 'coal'),
  railways: (w, c) => hasRes(c, 'coal') && hasRes(c, 'iron'),
  combustion: (w, c) => hasRes(c, 'oil'),
  // the new inventions (phase 2)
  canoes: (w, c) => onCoast(c) || hasLand(c, LAND.river | B('LAKE')),
  chariot: (w, c) => hasRes(c, 'horses'),
  galley: (w, c) => onCoast(c),
  paper: (w, c) => hasLand(c, FOREST_WET),
  watermill: (w, c) => hasLand(c, LAND.river),
  compass: (w, c) => onCoast(c),
  factory: (w, c) => hasRes(c, 'coal'),
  steamship: (w, c) => onCoast(c),
};
/** Common inventions with a need any sensible people meets (boats need water). */
const COMMON_NEED = new Set(['canoes', 'steamship']);
/** The land each condition asks for, in words (dossiers, the invention view). */
export const NEEDS_WORDS = {
  bronze: 'copper or tin', horseback: 'horses', irrigation: 'a river or lake', sailing: 'a coast or lake', shipbuilding: 'a coast',
  navigation: 'a coast on the open sea', banking: 'a city with a market', gunpowder: 'saltpetre (desert, dry scrub or mountains)',
  steam: 'coal', railways: 'coal and iron', combustion: 'oil',
  canoes: 'water: a coast, river or lake', chariot: 'horses', galley: 'a coast', paper: 'fibre plants (forest, rainforest or wetland)',
  watermill: 'a river', compass: 'a coast', factory: 'coal', steamship: 'a coast',
};
for (const t of TECHS) {
  t.tier = NEEDS[t.id] && !COMMON_NEED.has(t.id) ? 'uncommon' : 'common';
  if (NEEDS[t.id]) t.needs = NEEDS[t.id];
}

export const TECH_BY_ID = Object.fromEntries(TECHS.map((t) => [t.id, t]));
/** A historical tech's place in TECHS (archives store these, knowledge.js). */
export const TECH_INDEX = Object.fromEntries(TECHS.map((t, k) => [t.id, k]));
export const TECHS_BY_ERA = ERAS.map((e) => TECHS.filter((t) => t.era === e.id));
const BUILTIN_TECH = new Set(TECHS.map((t) => t.id));

export const hasTech = (civ, id) => Boolean(civ?.tech?.known && civ.tech.known[id] != null);
export const techName = (id) => { syncRegistry(); return TECH_BY_ID[id]?.name || id; };
/** Tech name for use mid-sentence ("the Wheel", not "The Wheel"). */
const midName = (tech) => tech.name.replace(/^The /, 'the ');
/** A tech of the arcane branch (registered by the Mythic module; never counts toward eras). */
export const isArcane = (t) => Boolean(t && t.branch === 'arcane');

// ---------------------------------------------------------------------------
// Mods

export const DEFAULT_MODS = Object.freeze({
  farming: 0, farmYield: 1, gatherYield: 1, fishYield: 1, housing: 1, health: 1, birth: 1,
  research: 1, culture: 1, production: 1, trade: 1, tradeRange: 10, military: 1, defense: 1,
  siege: 1, movement: 1, navigation: 0, medicine: 1, sanitation: 1, mining: 1, stability: 0,
  expansionRange: 8, industry: 0, pollution: 0, plagueResist: 0,
  storage: 1, taxEfficiency: 1, adminRange: 12, seaRange: 0, happiness: 0, soilCare: 0, irrigation: 0,
});
const MODS_VERSION = 4;
const SET_KEYS = new Set(['farming', 'navigation', 'irrigation']);
const MUL_KEYS = new Set(['medicine']);
const LIMITS = {
  tradeRange: [2, 250], expansionRange: [3, 80], adminRange: [4, 150], seaRange: [0, 250],
  medicine: [0.05, 1], plagueResist: [0, 0.5], stability: [-0.5, 0.5], happiness: [-0.4, 0.4],
  industry: [0, 3], pollution: [0, 3], soilCare: [0, 0.9], navigation: [0, 2], farming: [0, 1], irrigation: [0, 1],
};
const GOLDEN = { research: 0.15, culture: 0.3, production: 0.1, trade: 0.1, stability: 0.08, happiness: 0.05 };
const DARK = { research: -0.25, culture: -0.2, production: -0.1, trade: -0.1, stability: -0.1, happiness: -0.05 };

// ---------------------------------------------------------------------------
// Code registries, merged lazily by extVersion(). Module-level, but derived from code only
// (never from a world), so losing it is harmless: the next call rebuilds the same tables.

let regV = -1;
let ALL_TECHS = TECHS;          // historical techs, then registered ones (registration order)
let HIST_BY_ERA = TECHS_BY_ERA; // techs that count toward eras, by era
const MT = { extra: null, set: SET_KEYS, mul: MUL_KEYS, limits: LIMITS };

function normaliseTech(d) {
  const era = Math.max(0, Math.min(ERAS.length - 1, Math.round(fin(d.era, 0))));
  return {
    ...d,
    era,
    prereqs: Array.isArray(d.prereqs) ? d.prereqs.filter((p) => typeof p === 'string') : [],
    fx: d.fx && typeof d.fx === 'object' ? d.fx : {},
    cat: d.cat || (d.branch === 'arcane' ? 'arcane' : 'science'),
    name: String(d.name || d.id),
    first: d.first || `to master ${String(d.name || d.id).toLowerCase()}`,
    deed: d.deed || `mastered ${String(d.name || d.id).toLowerCase()}`,
    cost: Number.isFinite(d.cost) && d.cost > 0 ? d.cost : ERA_COST[era],
    tier: d.tier === 'uncommon' ? 'uncommon' : 'common',
  };
}

/** Merge registered techs and mod keys (cheap when nothing changed). */
export function syncRegistry() {
  const v = extVersion();
  if (v === regV) return;
  regV = v;
  for (const id of Object.keys(TECH_BY_ID)) if (!BUILTIN_TECH.has(id)) delete TECH_BY_ID[id];
  const extra = [];
  for (const d of getRegisteredTechs()) {
    if (!d || typeof d.id !== 'string' || BUILTIN_TECH.has(d.id)) continue; // never shadow a historical tech
    const t = normaliseTech(d);
    extra.push(t);
    TECH_BY_ID[t.id] = t;
  }
  ALL_TECHS = extra.length ? TECHS.concat(extra) : TECHS;
  HIST_BY_ERA = extra.some((t) => !isArcane(t)) ? ERAS.map((e) => ALL_TECHS.filter((t) => t.era === e.id && !isArcane(t))) : TECHS_BY_ERA;
  // registered mod keys: built-in keys keep their own default, limit and kind
  const keys = getModKeys();
  let ex = null;
  const set = new Set(SET_KEYS), mul = new Set(MUL_KEYS), lim = { ...LIMITS };
  for (const k in keys) {
    if (k in DEFAULT_MODS || k.charAt(0) === '_') continue;
    const d = keys[k];
    (ex ||= {})[k] = d.default;
    if (d.kind === 'set') set.add(k); else if (d.kind === 'mul') mul.add(k);
    if (d.limit) lim[k] = d.limit;
  }
  MT.extra = ex; MT.set = set; MT.mul = mul; MT.limits = lim;
}

/** Every tech: the historical tree plus registered ones. */
export function allTechs() { syncRegistry(); return ALL_TECHS; }
/** The def of a tech id (historical or registered), or null. */
export function techDef(id) { syncRegistry(); return TECH_BY_ID[id] || null; }

/** Default of a mod key, built-in or registered (`fallback` for keys nobody registered). */
export function modDefault(key, fallback = 0) {
  if (key in DEFAULT_MODS) return DEFAULT_MODS[key];
  const d = getModKeys()[key];
  return d && Number.isFinite(d.default) ? d.default : fallback;
}
/**
 * A mod value, else its default (registered keys are stored only while not default; a key
 * no module registered reads as `fallback`, e.g. modValue(mods, 'mortality', 1)).
 */
export function modValue(mods, key, fallback = 0) {
  const v = mods ? mods[key] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : modDefault(key, fallback);
}

function applyFx(m, fx, scale = 1) {
  const set = MT.set, mul = MT.mul;
  for (const k in fx) {
    const v = fx[k];
    if (!Number.isFinite(v) || !(k in m)) continue;
    if (set.has(k)) m[k] = Math.max(m[k], v);
    else if (mul.has(k)) m[k] *= scale === 1 ? v : 1 - (1 - v) * scale;
    else m[k] += v * scale;
  }
}

/**
 * The defaults with every known tech's fx applied, in the known techs' order. That order only
 * ever grows at its end (techs are learnt, never forgotten), so the result is kept per known
 * object and reused while no tech has been added (and the registries are unchanged): a copy
 * of exactly what the loop would produce. Cache only (keyed by object identity).
 */
const TECH_PART = new WeakMap();
function techMods(known, extra) {
  let n = 0;
  for (const id in known) n++;
  const hit = TECH_PART.get(known);
  if (hit && hit.n === n && hit.v === regV && hit.extra === extra) return { ...hit.m };
  const m = extra ? { ...DEFAULT_MODS, ...extra } : { ...DEFAULT_MODS };
  for (const id in known) { const t = TECH_BY_ID[id]; if (t) applyFx(m, t.fx); }
  TECH_PART.set(known, { n, v: regV, extra, m: { ...m } });
  return m;
}

/**
 * Compute a fresh mods object: techs, government, ruler, temperament, ages, wonders, figures,
 * then the civ's live effects, then the ext 'mods' providers, then the limits (see the header).
 */
export function computeMods(world, civ) {
  syncRegistry();
  const extra = MT.extra;
  const known = civ?.tech?.known;
  const m = known ? techMods(known, extra) : extra ? { ...DEFAULT_MODS, ...extra } : { ...DEFAULT_MODS };
  const gov = GOVERNMENTS[civ?.government];
  if (gov) applyFx(m, gov.mods);
  const traits = civ?.ruler?.traits;
  if (Array.isArray(traits)) for (const tr of traits) { const d = RULER_TRAITS[tr]; if (d) applyFx(m, d.mods); }
  const tr = civ?.traits;
  if (tr) {
    m.military += 0.2 * (fin(tr.militarism, 0.5) - 0.5);
    m.trade += 0.2 * (fin(tr.commerce, 0.5) - 0.5);
    m.culture += 0.15 * (fin(tr.religiosity, 0.5) - 0.5);
    m.expansionRange += Math.round(2 * (fin(tr.expansion, 0.5) - 0.5));
  }
  // the rare arts it holds (civ/arts.js)
  const arts = civ?.tech?.arts;
  if (arts) for (const a in arts) if (ARTS[a]) applyFx(m, ARTS[a].fx);
  if (fin(civ?.goldenAge) > 0) applyFx(m, GOLDEN);
  if (fin(civ?.darkAge) > 0) applyFx(m, DARK);
  if (world && Array.isArray(world.wonders) && civ && civ.id != null) {
    for (const w of world.wonders) {
      if (!w || w.civId !== civ.id || w.destroyedDay != null) continue;
      const def = wonderDef(w.kind);
      if (def && def.mods) applyFx(m, def.mods);
    }
  }
  const fc = civ?.flags?.figureCounts;
  if (fc) {
    m.military += 0.05 * Math.min(3, fin(fc.general));
    m.research += 0.03 * Math.min(3, fin(fc.scholar));
    m.culture += 0.05 * Math.min(3, fin(fc.artist));
    m.trade += 0.04 * Math.min(3, fin(fc.merchant));
    m.seaRange += 4 * Math.min(3, fin(fc.explorer));
  }
  // timed effects (an effect counts for the whole month in which it is live, as settlementMods)
  const effs = civ?.effects;
  if (Array.isArray(effs) && effs.length) {
    const ms = world?.time ? Math.floor(world.time.day / DAYS_PER_MONTH) * DAYS_PER_MONTH : 0;
    for (const e of effs) if (e && e.m && (e.until < 0 || e.until > ms)) applyFx(m, e.m);
  }
  // ext providers (race mods and the like; neutral in a Historical world)
  if (world && civ && hasProviders('mods')) {
    for (const p of concatOf('mods', world, civ)) if (p && typeof p === 'object') applyFx(m, p);
  }
  // sanitise
  const limits = MT.limits;
  for (const k in m) {
    let v = m[k];
    const def = k in DEFAULT_MODS ? DEFAULT_MODS[k] : extra[k];
    if (!Number.isFinite(v)) v = def;
    const lim = limits[k];
    if (lim) v = Math.min(lim[1], Math.max(lim[0], v));
    else if (def === 1) v = Math.max(0.05, v);
    m[k] = v;
  }
  m.navigation = Math.round(m.navigation);
  m.farming = m.farming >= 0.5 ? 1 : 0;
  m.irrigation = m.irrigation >= 0.5 ? 1 : 0;
  // registered keys are kept only while they matter (a Historical save never carries them):
  // one at its default is left undefined, which is never saved, rather than deleted (a delete
  // turns the object into a slow dictionary, and civ.mods is read everywhere)
  if (extra) for (const k in extra) if (m[k] === extra[k]) m[k] = undefined;
  m._v = MODS_VERSION;
  m._e = civ ? fin(civ.effectsV, 0) | 0 : 0;
  return m;
}

/**
 * The derived modifier object of a civ (SPEC §6.3). Always complete for the built-in keys:
 * unknown civs, ids, dead civs and foreign objects get defaults. Cached on civ.mods (saved),
 * refreshed monthly and whenever its inputs change; recomputed at once when the civ's effects
 * changed since (civ.effectsV ≠ mods._e).
 */
export function getMods(world, civ) {
  if (typeof civ === 'number') civ = world?.civs?.[civ] || null;
  if (!civ || typeof civ !== 'object') return { ...DEFAULT_MODS };
  const cur = civ.mods;
  if (cur && cur._v === MODS_VERSION && cur._e === (fin(civ.effectsV, 0) | 0)) return cur;
  let m;
  try { m = computeMods(world, civ); } catch (e) { console.error('[civ:mods]', e); m = { ...DEFAULT_MODS, _v: MODS_VERSION, _e: fin(civ.effectsV, 0) | 0 }; }
  if (Object.isExtensible(civ)) civ.mods = m;
  return m;
}

/** Recompute and store (call after any change to techs, government, ruler or ages). */
export function refreshMods(world, civ) {
  civ.mods = computeMods(world, civ);
  return civ.mods;
}

// ---------------------------------------------------------------------------
// Eras

/** Highest era whose entry requirement the civ meets (eras are cumulative; arcane arts never count). */
export function computeEra(civ) {
  syncRegistry();
  let era = 0;
  for (let e = 1; e < ERAS.length; e++) {
    let n = 0;
    for (const t of HIST_BY_ERA[e]) if (hasTech(civ, t.id)) n++;
    if (n >= ERA_ENTRY) era = e; else break;
  }
  return era;
}

/** Silently grant a tech (genesis, inheritance, emergence). from: how it came (knowledge.js HOW; 'g' given at birth). */
export function grantTech(civ, id, day = 0, from = 'g') {
  syncRegistry();
  if (!TECH_BY_ID[id] || !civ?.tech || hasTech(civ, id)) return;
  civ.tech.known[id] = day;
  noteFrom(civ, id, from);
  if (civ.tech.research === id) { civ.tech.research = null; civ.tech.progress = 0; }
}

/** Note how civ came by tech id ('t:12': by trade from realm 12). Own research is the default and not stored. */
export function noteFrom(civ, id, from) {
  if (!civ?.tech || !from || from === 'r') return;
  (civ.tech.from ||= {})[id] = from;
  if (civ.tech.head && civ.tech.head[id]) delete civ.tech.head[id];
}

/**
 * Forget techs (knowledge.js, in a collapse): a fresh known object without them (the mods cache
 * is keyed by the object, which only ever grows otherwise), remembered in civ.tech.lost.
 */
export function forgetTechs(world, civ, ids) {
  if (!civ?.tech || !ids.length) return;
  const drop = new Set(ids);
  const known = {};
  for (const id in civ.tech.known) if (!drop.has(id)) known[id] = civ.tech.known[id];
  civ.tech.known = known;
  const lost = (civ.tech.lost ||= {});
  for (const id of ids) { lost[id] = world.time.day; if (civ.tech.from) delete civ.tech.from[id]; }
  if (civ.tech.research && drop.has(civ.tech.research)) { civ.tech.research = null; civ.tech.progress = 0; }
  civ.tech.era = computeEra(civ);
  refreshMods(world, civ);
}

/** Can civ invent t alone (its land or situation; the ext 'inventRule' may answer)? */
export function canInventAlone(world, civ, t) {
  if (hasProviders('inventRule')) { const v = firstOf('inventRule', world, civ, t.id); if (v === true || v === false) return v; }
  return typeof t.needs !== 'function' || !world || Boolean(t.needs(world, civ));
}

/** How readily civ learns from others: × (1.15 − 0.3 × isolation), × the ext 'learnRule'. */
export function learnMul(world, civ) {
  let m = (1.15 - 0.3 * fin(civ?.traits?.isolation, 0.5)) * (hasTech(civ, 'alphabet') ? 1.15 : 1);   // the alphabet: easy letters, easy learning
  if (hasProviders('learnRule')) m *= mulOf('learnRule', world, civ);
  return m;
}

/** A head start toward id (conquest, arms, scholars, refugees): a share of its cost, and whence it came. */
export function headStart(civ, id, frac, from) {
  const t = TECH_BY_ID[id];
  if (!t || !civ?.tech || hasTech(civ, id)) return false;
  const head = (civ.tech.head ||= {});
  const prev = head[id] ? head[id][0] : 0;
  head[id] = [Math.min(t.cost * 0.8, prev + t.cost * frac), from];
  if (civ.tech.research === id) applyHead(civ, id);
  const ids = Object.keys(head);
  if (ids.length > 8) delete head[ids.sort((a, b) => head[a][0] - head[b][0] || (a < b ? -1 : 1))[0]];
  return true;
}
function applyHead(civ, id) {
  const h = civ.tech.head && civ.tech.head[id];
  if (!h) return;
  civ.tech.progress += h[0];
  civ.tech.cue = [id, h[1]];
  delete civ.tech.head[id];
}
const headPts = (civ, id) => (civ.tech.head && civ.tech.head[id] ? civ.tech.head[id][0] : 0);

/**
 * Start a civ in `era`: every tech of earlier eras, plus the cheapest ERA_ENTRY techs of
 * that era whose prerequisites are met (so a Classical start really is Classical).
 * Only the historical tree: magic is learned, never granted by the age.
 */
export function grantEra(world, civ, era) {
  for (const t of TECHS) if (t.era < era) grantTech(civ, t.id, world.time.day);
  if (era > 0 && era < ERAS.length) {
    const cands = TECHS_BY_ERA[era].filter((t) => !hasTech(civ, t.id) && t.prereqs.every((p) => hasTech(civ, p))).sort((a, b) => a.cost - b.cost || (a.id < b.id ? -1 : 1));
    let have = TECHS_BY_ERA[era].filter((t) => hasTech(civ, t.id)).length;
    for (const t of cands) { if (have >= ERA_ENTRY) break; grantTech(civ, t.id, world.time.day); have++; }
  }
  civ.tech.era = Math.max(civ.tech.era || 0, computeEra(civ));
}

// ---------------------------------------------------------------------------
// Research

/** Can civ study t now (its own gate, e.g. mana or race for an arcane art)? */
function gateOk(world, civ, t) {
  if (typeof t.available !== 'function') return true;
  if (!world) return false;
  try { return Boolean(t.available(world, civ)); } catch (e) { return false; }
}

/**
 * Available techs: unknown, all prerequisites known, and (registered techs) available(world,
 * civ). world is needed for gated techs; without it they are left out.
 */
export function availableTechs(civ, world = null) {
  syncRegistry();
  const out = [];
  for (const t of ALL_TECHS) {
    if (hasTech(civ, t.id)) continue;
    let ok = true;
    for (const p of t.prereqs) if (!hasTech(civ, p)) { ok = false; break; }
    if (ok && (t.available == null || gateOk(world, civ, t))) out.push(t);
  }
  return out;
}

/** Contacts used for diffusion: diplomatic relations (and trade), plus bordering civs. */
export function diffusionPeers(world, civ) {
  const peers = [];
  const seen = new Set();
  const rels = civ.relations || {};
  for (const k in rels) {
    const o = world.civs[+k];
    if (!o || !o.alive || o.id === civ.id) continue;
    seen.add(o.id);
    peers.push({ civ: o, trade: fin(rels[k]?.trade) > 0 || (civ.allies || []).includes(o.id) });
  }
  for (const other of borderNeighbours(world, civ.id)) {
    if (seen.has(other)) continue;
    const o = world.civs[other];
    if (!o || !o.alive) continue;
    seen.add(other);
    peers.push({ civ: o, trade: false });
  }
  return peers;
}

/** A registered def's own cost multiplier for this civ (1 without one). */
function defCostMul(world, civ, tech) {
  if (typeof tech.costMul !== 'function' || !world || !civ) return 1;
  let v = 1;
  try { v = Number(tech.costMul(world, civ)); } catch (e) { v = 1; }
  return Number.isFinite(v) && v > 0 ? Math.min(8, Math.max(0.1, v)) : 1;
}

/**
 * Research cost after diffusion from peers who already know the tech and from the towns taken
 * from realms that knew it (× the realm's openness), × ALONE for an uncommon tech with no
 * teacher in reach and no land for it (× a def's own costMul).
 */
export function effectiveCost(tech, peers, world = null, civ = null) {
  let disc = 0, taught = false;
  const across = isArcane(tech) && civ && civ.race && civ.race !== 'human';
  const prints = civ && hasTech(civ, 'printing');
  for (const p of peers) {
    if (!hasTech(p.civ, tech.id)) continue;
    taught = true;
    // knowledge flies between realms that print (half again as fast)
    disc += (p.trade ? 0.22 : 0.14) * (across && p.civ.race !== civ.race ? 0.5 : 1) * (prints && hasTech(p.civ, 'printing') ? 1.5 : 1);
  }
  const tb = civ && civ.flags && civ.flags.taught;
  // paper above all is carried off by conquest (the papermakers of Samarkand)
  if (tb && world) for (const [oid, share] of tb) { const o = world.civs[oid]; if (o && hasTech(o, tech.id)) { taught = true; disc += Math.min(0.3, 0.6 * share) * (tech.id === 'paper' ? 2 : 1); } }
  if (civ && world && disc > 0) disc *= learnMul(world, civ);
  let base = tech.cost * COST_SCALE * (1 - Math.min(0.6, disc));
  if (!taught && civ && tech.needs && !canInventAlone(world, civ, tech)) base *= ALONE;
  if (civ && civ.tech && civ.tech.lost && civ.tech.lost[tech.id] != null) base *= 0.5;   // remembered: relearnt at half the cost
  return tech.costMul ? base * defCostMul(world, civ, tech) : base;
}

/**
 * Whence civ learns tech now: the research's cue (a head start's source), else a trading or
 * allied teacher, a neighbour or contact, a realm whose towns it took, or its own research.
 * Returns [code, teacherCiv | null].
 */
function sourceOf(world, civ, tech, peers) {
  const cue = civ.tech.cue;
  if (cue && cue[0] === tech.id && typeof cue[1] === 'string') {
    const [h, idStr] = cue[1].split(':');
    return [h, idStr != null && world.civs[+idStr] ? world.civs[+idStr] : null];
  }
  let border = null;
  for (const p of peers) if (hasTech(p.civ, tech.id)) { if (p.trade) return ['t', p.civ]; border ||= p.civ; }
  if (border) return ['b', border];
  const tb = civ.flags && civ.flags.taught;
  if (tb) for (const [oid] of tb) { const o = world.civs[oid]; if (o && hasTech(o, tech.id)) return ['c', o]; }
  return ['r', null];
}

const CAT_TRAIT = { military: 'militarism', commerce: 'commerce', faith: 'religiosity', science: 'innovation', civic: 'tolerance' };
/** Most of the research choice an arcane art may claim against the historical tree. */
const ARCANE_SHARE = 0.3;

function chooseResearch(world, civ, peers, ctx) {
  const avail = availableTechs(civ, world);
  if (!avail.length) return null;
  let minCost = Infinity, minArc = Infinity;
  // an uncommon tech with no land for it and no teacher in reach is a last resort: a realm without
  // copper or tin waits to learn bronze from a neighbour rather than grind at three times the cost
  const lonely = new Array(avail.length);
  const costs = avail.map((t, k) => {
    const full = effectiveCost(t, peers, world, civ);
    lonely[k] = Boolean(t.needs) && !isArcane(t) && full > t.cost * COST_SCALE * 1.5 * (t.costMul ? defCostMul(world, civ, t) : 1);
    // what is left to learn: a head start (conquest, arms, scholars, refugees) draws a realm on
    const c = Math.max(0.2 * t.cost, full - headPts(civ, t.id));
    if (isArcane(t)) { if (c < minArc) minArc = c; } else if (c < minCost) minCost = c;
    return c;
  });
  const others = lonely.some((x, k) => !x && !isArcane(avail[k]));
  if (!Number.isFinite(minCost)) minCost = minArc;
  let histW = 0, arcW = 0;
  const weights = avail.map((t, k) => {
    if (isArcane(t)) {
      // the arts are pursued for their own sake, not because they are cheap
      let w = Math.pow(Math.min(1.5, minArc / costs[k]), 1.2);
      if (typeof t.researchWeight === 'function') {
        let rw = 1;
        try { rw = Number(t.researchWeight(world, civ)); } catch (e) { rw = 1; }
        w *= Number.isFinite(rw) && rw > 0 ? Math.min(4, rw) : 0;
      }
      arcW += w;
      return w;
    }
    if (lonely[k] && others) return 0;
    let w = Math.pow(minCost / costs[k], 2.2);
    const trait = CAT_TRAIT[t.cat];
    if (trait) w *= 0.6 + fin(civ.traits?.[trait], 0.5);
    if (t.cat === 'sea') w *= ctx.coastShare > 0.15 ? 1.3 : 0.25;
    if (t.cat === 'farm' && !hasTech(civ, 'agriculture')) w *= 1.4;
    if (t.id === 'bronze' && ctx.hasOre) w *= 1.6;
    if (t.id === 'horseback' && ctx.hasHorses) w *= 1.6;
    if (t.cat === 'military' && ctx.atWar) w *= 1.5;
    if (t.cat === 'health' && ctx.plagued) w *= 1.8;
    histW += w;
    return w;
  });
  // the next age calls (chunk 5): with five inventions of its own age known, a realm gives a
  // growing share of its choices to the next age (a fifth at five, two fifths at six, at most
  // three quarters), so it moves on before it has learned everything of its own
  const cur = fin(civ.tech.era, 0);
  let nCur = 0;
  for (const t of HIST_BY_ERA[cur] || []) if (hasTech(civ, t.id)) nCur++;
  const share = Math.min(0.75, 0.2 * (nCur - 4));
  if (share > 0) {
    let ahead = 0;
    for (let j = 0; j < avail.length; j++) if (!isArcane(avail[j]) && avail[j].era > cur) ahead += weights[j];
    const rest = histW - ahead, want = (share / (1 - share)) * rest;
    if (ahead > 0 && rest > 0 && ahead < want) {
      const k = want / ahead;
      for (let j = 0; j < avail.length; j++) if (!isArcane(avail[j]) && avail[j].era > cur) weights[j] *= k;
      histW = rest + want;
    }
  }
  // keep the march of the ages: magic takes at most ARCANE_SHARE of the historical weight
  if (arcW > 0 && histW > 0 && arcW > ARCANE_SHARE * histW) {
    const k = (ARCANE_SHARE * histW) / arcW;
    for (let j = 0; j < avail.length; j++) if (isArcane(avail[j])) weights[j] *= k;
  }
  let total = 0;
  for (const w of weights) total += w;
  if (!(total > 0)) return avail[0].id;
  let r = world.rng.next() * total;
  for (let k = 0; k < avail.length; k++) { r -= weights[k]; if (r <= 0) return avail[k].id; }
  return avail[avail.length - 1].id;
}

/**
 * Monthly research for a civ. ctx: { pop, libBonus, resMul, coastShare, hasOre, hasHorses,
 * atWar, plagued, capital } (from the civ monthly pass; resMul = the people-weighted
 * settlement research modifier).
 */
export function researchMonthly(world, civ, ctx) {
  syncRegistry();
  const t = civ.tech;
  const peers = diffusionPeers(world, civ);
  if (!t.research || hasTech(civ, t.research) || !TECH_BY_ID[t.research]) {
    t.research = chooseResearch(world, civ, peers, ctx);
    if (!t.research) return;
    applyHead(civ, t.research);
  }
  const mods = getMods(world, civ);
  const innov = fin(civ.traits?.innovation, 0.5);
  const pts = 0.085 * Math.pow(Math.max(0, ctx.pop), 0.6) * (0.55 + 0.9 * innov) * mods.research
    * fin(world.params.techRate, 1) * (1 + fin(ctx.libBonus)) * (civ.ruler ? 1 : 0.8) * fin(ctx.resMul, 1)
    * (hasProviders('researchMul') ? mulOf('researchMul', world, civ, t.research) : 1);   // the realm's mages, on an arcane art
  const p = Number.isFinite(pts) && pts > 0 ? pts : 0;
  t.points += p;
  t.progress += p;
  const tech = TECH_BY_ID[t.research];
  const cost = effectiveCost(tech, peers, world, civ);
  if (t.progress >= cost) {
    t.progress = Math.min(cost * 0.5, t.progress - cost);
    const [via, teacher] = sourceOf(world, civ, tech, peers);
    t.cue = null;
    discover(world, civ, tech.id, teacher ? 'diffusion' : 'research', teacher, { via });
  }
}

/** A scholar's breakthrough: a burst of progress on the current research. */
export function researchBurst(world, civ, fraction) {
  syncRegistry();
  const t = civ.tech;
  if (!t.research || !TECH_BY_ID[t.research]) {
    t.research = chooseResearch(world, civ, diffusionPeers(world, civ), { coastShare: civ.flags?.coastShare || 0 });
    if (!t.research) return null;
    applyHead(civ, t.research);
  }
  const tech = TECH_BY_ID[t.research];
  t.progress += tech.cost * COST_SCALE * fraction;
  if (t.progress >= effectiveCost(tech, diffusionPeers(world, civ), world, civ)) {
    t.progress = 0;
    discover(world, civ, tech.id, 'figure');
  }
  return tech;
}

/**
 * Techs a civ could be given now (unknown, prerequisites known, and its gate open): the
 * Gift a Technology picker. Historical techs first by era, then the arts.
 */
export function giftableTechs(world, civ) {
  if (!civ || !civ.tech) return [];
  return availableTechs(civ, world).slice().sort((a, b) => (isArcane(a) - isArcane(b)) || a.era - b.era || a.name.localeCompare(b.name));
}

const LEARN = ['learned the art of {tech}', 'mastered {tech}', 'took up {tech}', 'came to know {tech}'];
/** The code of a discovery's kind (knowledge.js HOW); a diffusion's own code comes as opts.via. */
const HOW_OF = { research: 'r', figure: 'r', divine: 'd', grant: 'g', diffusion: 'b' };
const NO_TEACHER = new Set(['r', 'g', 'd']);
/** How a realm learned from a teacher, opening its Chronicle line. */
const VIA_TEXT = {
  t: (T) => `Through its trade with ${T}`,
  b: (T) => `Learning from ${T}`,
  c: (T) => `From the towns it had taken from ${T}`,
  a: (T) => `Beaten by the arms of ${T}`,
  s: (T) => `Taught by a scholar of ${T}`,
  f: (T) => `Helped by refugees from ${T}`,
};
const LEARN_ARCANE = ['learned the art of {tech}', 'were initiated into {tech}', 'took up the secrets of {tech}'];

/**
 * Record a discovery: update knowledge, mods and era; chronicle, hooks and fx.
 * how: 'research' | 'diffusion' | 'figure' | 'divine' | 'grant' (no discovery entry: the
 * caller tells the story; a first entry into an era is still chronicled).
 * opts: { quiet (as 'grant', keeping how for the hook), cause (seq of the caller's entry) }.
 * Emits techDiscovered(world, civ, id, how, first) and eraReached(world, civ, era, first);
 * the first realm into each era is noted in sys.civ.eraFirst[era] = { civId, day }.
 */
export function discover(world, civ, id, how = 'research', teacher = null, opts = {}) {
  syncRegistry();
  const tech = TECH_BY_ID[id];
  if (!tech || !civ?.tech || hasTech(civ, id)) return false;
  const st = world.sys.civ;
  civ.tech.known[id] = world.time.day;
  if (civ.tech.research === id) civ.tech.research = null;
  if (civ.tech.cue && civ.tech.cue[0] === id) civ.tech.cue = null;
  const regained = Boolean(civ.tech.lost && civ.tech.lost[id] != null);
  if (regained) { delete civ.tech.lost[id]; if (!Object.keys(civ.tech.lost).length) delete civ.tech.lost; }
  // how it came (knowledge.js HOW): the caller's via, else by the kind of discovery
  const via = opts.via || HOW_OF[how] || 'r';
  noteFrom(civ, id, teacher && !NO_TEACHER.has(via) ? `${via}:${teacher.id}` : via);
  refreshMods(world, civ);
  if (civ.ruler?.deeds) civ.ruler.deeds.techs = (civ.ruler.deeds.techs || 0) + 1;
  const cap = civ.capitalId != null ? world.settlements[civ.capitalId] : null;
  const arcane = isArcane(tech);
  const firstInWorld = Boolean(st && st.firstTech[id] == null);
  if (st && firstInWorld) { st.firstTech[id] = civ.id; (st.firstWhere ||= {})[id] = [cap ? cap.id : null, world.time.day]; }
  let entry = null;
  const quiet = how === 'grant' || Boolean(opts.quiet);
  if (!quiet) {
    const cat = arcane ? 'myth' : 'tech';
    const key = `tech.${arcane ? 'arcane.' : ''}${firstInWorld ? 'first' : how === 'diffusion' ? 'diffused' : 'learned'}`;
    if (firstInWorld) {
      const city = cap ? cap.name : null;
      const text = city
        ? pick(world, [`${PeopleOf(civ)} of ${city} were the first ${tech.first}.`, `At ${city}, ${peopleOf(civ)} became the first ${tech.first}.`])
        : `${PeopleOf(civ)} were the first ${tech.first}.`;
      entry = record(world, { cat, imp: 2, key, text, civ, tags: [id] });   // (integration: arcane firsts are notable like any other first)
    } else if (regained) {
      entry = record(world, { cat, imp: 2, key: 'tech.found', text: `${TheName(civ)} recovered the lost art of ${midName(tech)}${teacher ? `, learning it anew from ${theName(teacher)}` : ''}.`, civ, tags: [id] });
    } else if (how === 'diffusion' && teacher) {
      const lead = (VIA_TEXT[via] || VIA_TEXT.b)(theName(teacher));
      entry = record(world, { cat, imp: 1, key, text: `${lead}, ${theName(civ)} ${pick(world, arcane ? LEARN_ARCANE : LEARN).replace('{tech}', midName(tech))}.`, civ, tags: [id] });
    } else {
      entry = record(world, { cat, imp: 1, key, text: `${TheName(civ)} ${pick(world, arcane ? LEARN_ARCANE : LEARN).replace('{tech}', midName(tech))}.`, civ, tags: [id] });
    }
    if (cap) emitFx(world, { type: 'discovery', x: cap.x, y: cap.y, civId: civ.id });
  }
  emit(world, 'techDiscovered', civ, id, how, firstInWorld);
  if (arcane) return true;
  const era = computeEra(civ);
  if (era > civ.tech.era) {
    const prev = civ.tech.era;
    civ.tech.era = era;
    let first = false;
    if (st) {
      const n = (st.eraReached[era] = (st.eraReached[era] || 0) + 1);
      first = st.eraFirst[era] == null;
      if (first) st.eraFirst[era] = { civId: civ.id, day: world.time.day };
      const eraName = ERAS[era].name;
      let text, imp;
      if (first) {
        imp = 5;
        text = pick(world, [
          `With ${midName(tech)}, ${theName(civ)} became the first people of the world to enter the ${eraName}.`,
          `${TheName(civ)} led the world into the ${eraName}, mastering ${midName(tech)} before any other people.`,
        ]);
      } else {
        imp = n <= 3 ? 3 : 2;
        text = pick(world, [
          `${TheName(civ)} entered the ${eraName}.`,
          `With the mastery of ${midName(tech)}, ${theName(civ)} passed into the ${eraName}.`,
          `${TheName(civ)} left the ${ERAS[prev].name} behind and entered the ${eraName}.`,
        ]);
      }
      if (!quiet || first) record(world, { cat: 'tech', imp, key: first ? 'era.first' : 'era.reached', text, civ, cause: entry ? entry.seq : opts.cause ?? null, tags: [`era${era}`] });
    }
    emit(world, 'eraReached', civ, era, first);
  }
  return true;
}

/** Does the civ's territory hold usable deposits of a resource key? (for research bias) */
export function resourceKeyId(key) {
  const r = RESOURCES.find((x) => x.key === key);
  return r ? r.id : -1;
}

export const yearsKnown = (world, civ, id) => (hasTech(civ, id) ? (world.time.day - civ.tech.known[id]) / DAYS_PER_YEAR : -1);
