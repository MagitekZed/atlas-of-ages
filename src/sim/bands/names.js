// Bands · names. Every roaming power gets a name a chronicler would use: outlaw bands after
// their woods and hills or their captain ("the Wolves of the Fowulwood", "Black Oren's Men"),
// pirate fleets after their seas and isles, free companies after an emblem or a captain, hordes
// after their khan or their steppe, beasts after the wild places they haunt ("the Troll of the
// Hul Spine", "Old Mossback"), and dragons in a tongue of their own with a lair to match
// ("Vharokh the Ashen" of "the Wyrmhold of Mount Veist"). Names come from the local people's
// language (core/names.js) and from named geography (world.features). All draws use world.rng.

import { makePerson, properPlace, makeWord, createLanguage, composeName, freshName, possessive, compound, makeEpithet, nameWord, raceWordsOf, terrainAt, isEnglishWord } from '../../core/names.js';
import { capitalize } from '../../core/util.js';
import { RNG } from '../../core/rng.js';
import { DAYS_PER_YEAR } from '../../core/constants.js';

const pick = (world, arr) => arr[Math.floor(world.rng.next() * arr.length)];
const bare = (n) => (n ? String(n).replace(/^the\s+/i, '') : n);

/** Nearest named feature of the given kinds within maxD tiles (or null). Pure. */
export function featureNear(world, x, y, kinds, maxD = 14) {
  let best = null, bd = maxD * maxD;
  for (const ft of world.features || []) {
    if (!ft || !ft.name || !kinds.includes(ft.kind)) continue;
    const d = (ft.x - x) ** 2 + (ft.y - y) ** 2;
    if (d <= bd) { bd = d; best = ft; }
  }
  return best;
}

/**
 * A feature name ready for mid-sentence use. Gen names already carry their article where they
 * take one ("the Hul Spine", "the Fowulwood") and none where they do not ("Lake Avi", "Sour Isle");
 * a bare "Drimemia Desert" takes one mid-sentence ("the Terror of the Drimemia Desert").
 */
export const featName = (ft) => {
  if (!ft) return null;
  const n = String(ft.name).replace(/^The\s/, 'the ');
  return /\sDesert$/.test(n) && !/^the\s/.test(n) ? 'the ' + n : n;
};

// Every name below is composed from weighted forms (core/names.js composeName): themed words for
// outlaws, sailors, mercenaries and beasts, joined to the world's own words (the captain, the wood,
// the town, the sea, a word of the local tongue), so two worlds seldom share a band's name.

/** Names already carried by a living or remembered band (pure). */
function takenNames(world) {
  const t = new Set();
  for (const b of world.bands) if (b.name) t.add(b.name);
  for (const a of world.sys.bands?.archive || []) if (a.name) t.add(a.name);
  return t;
}
/** A composed name no band has carried yet (a few tries), else the last one made. */
function freshComposed(world, forms, vocab, fallback) {
  const taken = takenNames(world);
  return freshName(() => composeName(world.rng, forms, vocab), (n) => taken.has(n), 6) || fallback;
}

const PREFIX_EPITHETS = ['Black', 'Red', 'Grey', 'Mad', 'Old', 'Long', 'Bloody', 'Lame', 'Fair', 'Little', 'Big', 'Young', 'One-Eyed', 'Lucky',
  'Gentle', 'Sly', 'Bald', 'Squint-Eyed', 'Tall', 'Mother', 'Father', 'Brother'];
const THEME = { bandits: 'outlaw', pirates: 'sea', horde: 'khan' };

/**
 * A captain: { name, short, skill, born }. opts.theme ('outlaw' | 'sea' | 'khan' | 'any') colours the
 * by-name; opts.place (a town or haunt) allows "the Fox of Oskel".
 */
export function makeLeader(world, lang, opts = {}) {
  const rng = world.rng;
  const base = makePerson(lang || world.lang, rng);
  let name = base;
  if (opts.title) name = `${opts.title} ${base}`;
  else if (rng.chance(opts.epithet ?? 0.55)) {
    name = rng.chance(0.14) ? `${pick(world, PREFIX_EPITHETS)} ${base}` : `${base} ${makeEpithet(rng, THEME[opts.theme] || opts.theme || 'outlaw', { place: opts.place || null })}`;
  }
  const age = rng.int(opts.minAge ?? 24, opts.maxAge ?? 48);
  return { name, short: base, skill: Math.round(rng.float(opts.lo ?? 0.75, opts.hi ?? 1.3) * 100) / 100, born: world.time.day - age * DAYS_PER_YEAR };
}

// --- outlaws ------------------------------------------------------------------

const OUTLAW_BEASTS = ['Wolves', 'Ravens', 'Crows', 'Foxes', 'Boars', 'Hounds', 'Jackals', 'Adders', 'Wildcats', 'Rooks', 'Weasels', 'Stoats',
  'Badgers', 'Kites', 'Hawks', 'Rats'];
const OUTLAW_MEN = ['Men', 'Lads', 'Wolves', 'Riders', 'Boys', 'Band', 'Crew', 'Brothers', 'Blades', 'Knives', 'Hounds', 'Fellows', 'Cutthroats'];
const GANGS = ['Gang', 'Cutthroats', 'Boys', 'Brotherhood', 'Riders', 'Crew', 'Knives', 'Wolves', 'Raiders'];
const ROGUES = ['Footpads', 'Cutthroats', 'Robbers', 'Reivers', 'Brigands', 'Bandits', 'Wolfsheads', 'Rogues', 'Thieves', 'Outlaws', 'Raiders'];
const ROGUES_LATE = ['Highwaymen', 'Road-Agents', 'Desperadoes'];
const GARB_COLOR = ['Red', 'Grey', 'Green', 'Black', 'White', 'Brown', 'Scarlet', 'Yellow', 'Blue', 'Tattered'];
const GARB = ['Hoods', 'Cloaks', 'Caps', 'Masks', 'Jerkins', 'Sashes', 'Feathers', 'Scarves', 'Hats', 'Gloves', 'Mantles', 'Kerchiefs', 'Boots'];
const MEN_ADJ = ['Hollow', 'Barefoot', 'Hungry', 'Masked', 'Laughing', 'Ragged', 'Nameless', 'Landless', 'Hanged', 'Branded', 'Silent', 'Starving',
  'Merry', 'Broken', 'Lost', 'Forsworn', 'Faceless', 'Shoeless'];
const MEN_N = ['Men', 'Brothers', 'Boys', 'Sons', 'Riders', 'Company', 'Brotherhood', 'Fellows', 'Lads', 'Wolves'];
const THINGS = ['Thorn', 'Lantern', 'Gibbet', 'Rook', 'Ash', 'Briar', 'Gallows', 'Moss', 'Bramble', 'Night', 'Crow', 'Rag', 'Bone', 'Hedge', 'Ditch', 'Moor'];
const BROTHERHOODS = ['Gallows', 'Rope', 'Black Hand', 'Broken Sword', 'Empty Purse', 'Long Knife', 'Red Thumb', 'Rusty Key', 'Hanged Man',
  'Grey Goose', 'Last Coin', 'Bent Nail', 'Burning Tree', 'Hollow Oak', 'Crooked Mile', 'Cracked Bell'];
const LAND_MEN = {
  marsh: ['Fen-Runners', 'Marsh-Rats', 'Reed-Men', 'Bog-Wolves'], hills: ['Hill-Wolves', 'Crag-Men', 'Moor-Riders', 'Stone-Men'],
  wood: ['Greenwood Men', 'Leaf-Brothers', 'Forest Wolves', 'Oak-Men'], sands: ['Sand-Riders', 'Dune-Wolves', 'Dust-Men', 'Well-Robbers'],
  plains: ['Grass-Riders', 'Plain-Wolves', 'Horse-Thieves', 'Long Riders'], river: ['River-Rats', 'Ferry-Robbers', 'Ford-Wolves', 'Reed-Men'],
  shore: ['Wreckers', 'Shore-Wolves', 'Strand-Men', 'Cove-Rats'], snows: ['Snow-Wolves', 'Frost-Men', 'White Riders', 'Pine-Men'],
};
const OUTLAW_FORMS = [
  [2.4, '{leaderPos} {Men}'], [2.4, 'the {Beast} of {wood}'], [0.9, 'the Outlaws of {wood}'], [2.4, 'the {Beast} of {hills}'], [0.9, 'the Brigands of {hills}'],
  [1.2, 'the {place} {Gang}'], [1.6, 'the {Rogue} of {town}'], [1, 'the {Rogue} of the {town} Road'], [1.2, 'the {Color} {Garb} of {wood}'],
  [1.2, 'the {Color} {Garb} of {hills}'], [0.9, 'the {Color} {Garb} of {town}'], [1, 'the {LandMen} of {place}'], [0.9, 'the {MenAdj} {MenN} of {town}'],
  [0.6, 'the {Thing} Brothers of {town}'], [0.5, 'the Brotherhood of the {Bro} of {town}'],
  [0.3, 'the {Color} {Garb}'], [0.25, 'the {MenAdj} {MenN}'], [0.12, 'the {Thing}men'], [0.1, 'the {Thing} Brothers'], [0.1, 'the Brotherhood of the {Bro}'],
];

/**
 * An outlaw band's name, from its wood or hills, its captain, the town it preys on or a dark
 * nickname. ctx: { town (name), civ, era } (optional).
 */
export function outlawName(world, x, y, leader, lang, ctx = {}) {
  const wood = featureNear(world, x, y, ['forest'], 10);
  const hills = featureNear(world, x, y, ['range'], 10);
  const civ = ctx.civ || null;
  const race = raceWordsOf(civ);
  const late = (civ?.tech?.era || 0) >= 4;
  const land = terrainAt(world, Math.round(y) * world.W + Math.round(x));
  return freshComposed(world, OUTLAW_FORMS, {
    leaderPos: possessive(leader.short), Men: OUTLAW_MEN, Beast: OUTLAW_BEASTS, wood: featName(wood), hills: featName(hills),
    place: () => properPlace(lang || world.lang, world.rng), Gang: GANGS, Rogue: late ? ROGUES.concat(ROGUES_LATE) : ROGUES, town: ctx.town || null,
    Color: GARB_COLOR, Garb: GARB, LandMen: land ? LAND_MEN[land] : null, MenAdj: MEN_ADJ, MenN: MEN_N,
    Thing: race ? THINGS.concat(race.noun) : THINGS, Bro: BROTHERHOODS,
  }, `${possessive(leader.short)} Men`);
}

// --- pirates -----------------------------------------------------------------

const CREWS = ['Sea-Wolves', 'Brethren', 'Reavers', 'Raiders', 'Corsairs', 'Crew', 'Sea-Dogs', 'Freebooters', 'Rovers', 'Wolves', 'Sea-Hawks', 'Buccaneers'];
const SHIP_COLOR = ['Black', 'Red', 'Grey', 'White', 'Crimson', 'Tarred', 'Bloody', 'Ragged', 'Silent', 'Green', 'Yellow', 'Patched'];
const SHIPS = ['Sails', 'Ships', 'Fleet', 'Keels', 'Galleys', 'Oars', 'Flags', 'Prows', 'Hulls', 'Pennants', 'Masts'];
const SEA_BEASTS = ['Sea-Wolves', 'Sea-Dogs', 'Sea-Hawks', 'Sea-Snakes', 'Sea-Crows', 'Salt-Wolves', 'Tide-Rats', 'Wave-Riders', 'Storm-Crows', 'Brine-Dogs', 'Gull-Men'];
const SEA_BRO = ['Black Flag', 'Cutlass', 'Salt', "Rope's End", 'Drowned Man', 'Red Lantern', 'Hook', 'Anchor', 'Broken Oar', 'Last Tide'];
const PIRATE_FORMS = [
  [2.4, '{leaderPos} {Crew}'], [2.2, 'the {Color} {Ships} of {sea}'], [1.6, 'the {Crew} of {sea}'], [2, 'the {Crew} of {isle}'], [1.2, 'the {Color} {Ships} of {isle}'],
  [1.6, 'the {Crew} of {port}'], [1.1, 'the {native} {Crew}'], [0.8, 'the {SeaBeast} of {isle}'],
  [0.45, 'the {Color} {Ships}'], [0.25, 'the {SeaBeast}'], [0.25, 'the Brotherhood of the {SeaBro}'],
];

/** A pirate fleet's name, after its sea, its isle, its home port or its captain. ctx: { port (name), lang } (optional). */
export function pirateName(world, x, y, leader, ctx = {}) {
  const sea = featureNear(world, x, y, ['sea', 'ocean'], 30);
  const isle = featureNear(world, x, y, ['island'], 18);
  return freshComposed(world, PIRATE_FORMS, {
    leaderPos: possessive(leader.short), Crew: CREWS, Color: SHIP_COLOR, Ships: SHIPS, sea: featName(sea),
    isle: isle ? bare(isle.name).replace(/^Isle of /, '').replace(/\s+(Isle|Island)$/, '') : null, port: ctx.port || null,
    native: () => nameWord(ctx.lang || world.lang, world.rng, 1, 2), SeaBeast: SEA_BEASTS, SeaBro: SEA_BRO,
  }, `${possessive(leader.short)} Reavers`);
}

// --- free companies ------------------------------------------------------------

export const EMBLEMS = ['Rose', 'Star', 'Boar', 'Hand', 'Hart', 'Lion', 'Raven', 'Wolf', 'Lantern', 'Spear', 'Bear', 'Wheel', 'Crown', 'Hawk', 'Lily',
  'Tower', 'Sword', 'Bull', 'Griffin', 'Key', 'Anchor', 'Serpent', 'Sun', 'Moon', 'Bell', 'Stag', 'Eagle', 'Hound', 'Axe', 'Ship', 'Horn', 'Gauntlet'];
const TINCTURES = ['Black', 'Red', 'White', 'Silver', 'Golden', 'Iron', 'Grey', 'Green', 'Azure', 'Crimson', 'Copper', 'Scarlet'];
const PLURAL = { Wolf: 'Wolves', Lily: 'Lilies', Sword: 'Swords', Key: 'Keys', Axe: 'Axes', Hound: 'Hounds', Ship: 'Ships' };
const LANCES = ['Lances', 'Spears', 'Blades', 'Swords', 'Pikes', 'Bows', 'Riders', 'Shields', 'Banners'];
const COMPANY_FORMS = [
  [2.2, 'the Company of the {emblem}'], [2.2, 'the {emblem} Company'], [1.8, 'the Free Company of {leader}'], [1.4, 'the {leader} Company'],
  [1.4, 'the {adj} Free Company'], [1, 'the {emblem} Brotherhood'], [1, 'the {emblem} Banner'], [1, 'the {Lances} of the {emblem}'], [1, '{leaderPos} {Lances}'],
  [0.15, 'the {Size} Company'],
];
const SIZES = ['White', 'Grand', 'Great', 'Black', 'Iron', 'Red', 'Grey', 'Steel', 'Golden', 'Silver', 'Free', 'Old'];

/** A company's device: "Silver Hart", "Black Boar", "Three Crowns" (one or two draws); a race's own charges now and then. */
function emblemOf(world, civ) {
  const race = raceWordsOf(civ);
  const charge = pick(world, race ? EMBLEMS.concat(race.noun) : EMBLEMS);
  const r = world.rng.next();
  if (r < 0.12) return `${pick(world, ['Three', 'Two', 'Seven'])} ${PLURAL[charge] || (/s$/.test(charge) ? charge : charge + 's')}`;
  if (r < 0.25) return charge;
  return `${pick(world, TINCTURES)} ${charge}`;
}

/** A free company: { name, emblem }. */
export function companyName(world, leader, civ) {
  const emblem = emblemOf(world, civ);
  const adj = civ?.adjective && !isEnglishWord(civ.adjective) ? civ.adjective : null;
  const name = freshComposed(world, COMPANY_FORMS, {
    emblem, leader: leader.short, leaderPos: possessive(leader.short), adj, Lances: LANCES, Size: SIZES,
  }, `the Company of the ${emblem}`);
  return { name, emblem };
}

// --- hordes ------------------------------------------------------------------

const HORDE_COLOR = ['Golden', 'White', 'Blue', 'Black', 'Red', 'Grey', 'Iron', 'Silver'];
const HORDE_FORMS = [
  [2, 'the Horde of {leader}'], [1.4, 'the Great Horde of {leader}'], [2, 'the {word} Horde'], [1.2, 'the Riders of {word}'], [1.2, 'the {word} Host'],
  [1.2, 'the Riders of {desert}'], [1, 'the {Color} Horde of {leader}'], [1, 'the {Color} Horde of the {word}'], [0.8, 'the {Color} Host of {steppe}'],
  [0.3, 'the {Color} Horde'],
];

/** A steppe horde's name. lang is the riders' tongue (a new one for steppe peoples). */
export function hordeName(world, leader, lang, x, y) {
  const steppe = featureNear(world, x, y, ['desert', 'continent'], 30);
  const word = makeWord(lang, world.rng, 1, 2);
  return composeName(world.rng, HORDE_FORMS, {
    leader: leader.short, word, desert: steppe && steppe.kind === 'desert' ? featName(steppe) : null,
    steppe: steppe ? featName(steppe) : null, Color: HORDE_COLOR,
  }) || `the Horde of ${leader.short}`;
}

/** A fresh tongue for a people out of the empty steppe. */
export const steppeTongue = (world) => createLanguage(world.rng);

// --- beasts -----------------------------------------------------------------

const BEAST_TITLES = {
  troll: ['Troll', 'Hill-Troll', 'Troll-Wife', 'Bog-Troll', 'Stone-Troll', 'Cave-Troll'],
  giant: ['Giant', 'Giantess', 'Stone Giant', 'Hill Giant', 'Frost Giant', 'Old Giant'],
  wyvern: ['Wyvern', 'Wyrmling', 'Fell-Wing', 'Grey Wyvern', 'Wyvern-Queen'],
  treant: ['Elder Oak', 'Walking Wood', 'Old Ash', 'Greenwarden', 'Wakeful Yew', 'Moss-Father'],
  kraken: ['Kraken', 'Deep-Wyrm', 'Drowner', 'Ship-Eater', 'Many-Armed'],
  behemoth: ['Behemoth', 'Great Beast', 'Thunder-Ox', 'Earth-Shaker', 'Grey Colossus'],
  undead: ['Restless Dead', 'Grey Host', 'Hollow Legion', 'Barrow-Host', 'Pale Legion', 'Silent Host', 'Unquiet Dead', 'Hungry Dead', 'Grave-Walkers', 'Bone Army'],
};
// by-names the frightened give a beast: compound halves (first × second), and an "Old …" form
const BEAST_NICK = {
  troll: { a: ['Bone', 'Stone', 'Moss', 'Bog', 'Grim', 'Gnarl', 'Rock', 'Mud', 'Wart', 'Grey', 'Black', 'Iron'], b: ['tooth', 'jaw', 'fist', 'back', 'belly', 'hide', 'cruncher', 'gnawer', 'beard', 'foot', 'knuckle', 'nose'],
    old: ['Gnarl', 'Mother Hagra', 'Grimtooth', 'Stump', 'Grumble', 'Lumpkin'] },
  giant: { a: ['Thunder', 'Stone', 'Cloud', 'Hill', 'Oak', 'Iron', 'Frost', 'Storm', 'Boulder', 'Long', 'Grey', 'Crag'], b: ['foot', 'brow', 'fist', 'shanks', 'beard', 'stride', 'back', 'shoulders'],
    old: ['Thunderfoot', 'Stonebrow', 'Tallman', 'Mountain'] },
  wyvern: { a: ['Red', 'Ash', 'Scald', 'Shriek', 'Black', 'Grey', 'Hook', 'Venom', 'Night', 'Storm', 'Thorn', 'Blood'], b: ['wing', 'tail', 'claw', 'talon', 'fang', 'eye', 'spur', 'back'],
    old: ['Scald', 'Shrike', 'Leatherwing', 'Screech'] },
  treant: { a: ['Moss', 'Grey', 'Thorn', 'Oak', 'Elder', 'Root', 'Bark', 'Leaf', 'Ash', 'Yew', 'Hollow', 'Lichen'], b: ['back', 'bark', 'father', 'mother', 'beard', 'heart', 'root', 'limb'],
    old: ['Mossback', 'Greybark', 'Thornfather', 'Root-Grandfather'] },
  kraken: { a: ['Black', 'Grey', 'Long', 'Many', 'Ink', 'Deep', 'Salt', 'Wreck', 'Pale', 'Weed'], b: ['arms', 'maw', 'eye', 'grip', 'coils', 'tide', 'beak'],
    old: ['Blackarms', 'Inkmaw', 'Grip', 'Undertow'] },
  behemoth: { a: ['Grey', 'Thunder', 'Earth', 'Dust', 'Iron', 'Stone', 'Mud', 'Great', 'Rumble', 'Mountain', 'Old', 'Hill'], b: ['tusk', 'hide', 'hoof', 'horn', 'back', 'tread', 'bulk', 'shaker', 'belly', 'foot', 'brow', 'bellow'],
    old: ['Tusk', 'Greyhide', 'Grumble', 'Mountain', 'Earthshaker'] },
};
const BEAST_ADJ = ['Grey', 'Old', 'Hungry', 'Dread', 'Pale', 'Black', 'Blind', 'Patient', 'Lame', 'Tall', 'Restless', 'Sleepless'];
const BEAST_FORMS = [
  [3, 'the {Title} of {near}'], [1.6, '{nick}'], [0.2, 'Old {old}'], [1.2, '{word} the {Adj}'], [1.2, '{word} {nick}'],
];

/** A title for the risen dead of a grave or a haunted ruin ("the Barrow-Host"); one draw. */
export const undeadTitle = (world) => pick(world, BEAST_TITLES.undead);

/** A beast's name from the wild place it haunts or a by-name the frightened give it. */
export function beastName(world, kind, x, y) {
  const titles = BEAST_TITLES[kind] || ['Beast'];
  const near = kind === 'kraken' ? featureNear(world, x, y, ['sea', 'ocean'], 40)
    : kind === 'treant' ? featureNear(world, x, y, ['forest'], 14) || featureNear(world, x, y, ['range', 'lake'], 14)
      : featureNear(world, x, y, ['range', 'forest', 'lake', 'desert'], 16);
  const nk = BEAST_NICK[kind];
  const word = nameWord(world.lang, world.rng, 1, 2);
  return freshComposed(world, kind === 'undead' ? BEAST_FORMS.filter((f) => f[1].includes('{Title}')) : BEAST_FORMS, {
    Title: titles, near: featName(near), nick: nk ? () => compound(pick(world, nk.a), pick(world, nk.b)) : null, old: nk ? nk.old : null,
    word, Adj: BEAST_ADJ,
  }, `the ${titles[0]} of ${word}`);
}

// --- dragons ----------------------------------------------------------------

const DRAGON_TONGUE = {
  onsets: ['v', 'k', 'gr', 'dr', 'th', 'sk', 'z', 'r', 'n', 'kh', 'sm', 'f', 'g'],
  codas: ['r', 'kh', 'x', 'th', 'n', 'rg', 'sk', 'l'],
  vowels: ['a', 'o', 'au', 'y', 'e', 'aa', 'u'],
  minSyl: 2, maxSyl: 3, apostrophe: 0.15,
};
// Dragon by-names per variety: "the {Adj}", a compound of its element and a part of it
// ("Cinderjaw", "Rimeclaw"), a role ("the Devourer"), or a dread it is known for in the land.
const DRAGON_WORDS = {
  fire: { adj: ['Ashen', 'Red', 'Burning', 'Smouldering', 'Golden', 'Scorching', 'Crimson', 'Molten', 'Brazen', 'Blackened', 'Ruinous', 'Furnace-Hearted'],
    elem: ['Ember', 'Cinder', 'Ash', 'Flame', 'Smoke', 'Soot', 'Brand', 'Pyre', 'Char', 'Scorch', 'Sun', 'Coal'], role: ['Kindler', 'Devourer', 'Burner', 'Destroyer', 'Tyrant', 'Despoiler'] },
  frost: { adj: ['White', 'Pale', 'Cold', 'Silent', 'Hoar', 'Frozen', 'Glittering', 'Bitter', 'Blue', 'Winter-Born', 'Grey', 'Merciless'],
    elem: ['Rime', 'Frost', 'Ice', 'Snow', 'Sleet', 'Hail', 'Winter', 'Glacier', 'Shiver', 'Chill', 'Blizzard', 'Icicle'], role: ['Silence', 'Long Winter', 'Starver', 'Entomber', 'Glacier-King', 'Freezer'] },
  green: { adj: ['Green', 'Coiled', 'Rotting', 'Venomous', 'Creeping', 'Mossy', 'Sly', 'Poisoned', 'Whispering', 'Bloated', 'Jade', 'Fen-Born'],
    elem: ['Venom', 'Mire', 'Bile', 'Rot', 'Moss', 'Thorn', 'Fen', 'Blight', 'Gall', 'Poison', 'Sump', 'Leech'], role: ['Poisoner', 'Strangler', 'Corrupter', 'Whisperer', 'Fen-King', 'Defiler'] },
  sea: { adj: ['Drowned', 'Grey', 'Briny', 'Deep', 'Salt-Crusted', 'Tidal', 'Storm-Grey', 'Sunken', 'Foam-Flecked', 'Barnacled', 'Fathomless', 'Rolling'],
    elem: ['Storm', 'Brine', 'Tide', 'Wave', 'Salt', 'Foam', 'Wreck', 'Squall', 'Surge', 'Kelp', 'Spray', 'Undertow'], role: ['Drowner', 'Wrecker', 'Ship-Breaker', 'Tide-King', 'Harbour-Bane', 'Storm-Bringer'] },
};
const DRAGON_PART = ['heart', 'jaw', 'wing', 'claw', 'scale', 'tongue', 'maw', 'fang', 'crown', 'tail', 'breath', 'eye', 'hide', 'spine'];
const DRAGON_EATS = ['King', 'Ship', 'Horse', 'Ox', 'Hero', 'Knight', 'Town', 'Gold', 'Sheep', 'Priest', 'Maiden', 'Bridge'];
const DRAGON_FORMS = [
  [3, 'the {Adj}'], [3.2, '{comp}'], [1.1, 'the {Role}'], [1.4, 'the {Dread} of {town}'], [1.2, 'the {Dread} of {feat}'], [0.9, 'the {Eats}-Eater'], [0.8, 'the {Adj} {Role}'],
];
const DRAGON_DREAD = ['Terror', 'Scourge', 'Dread', 'Bane', 'Shadow', 'Curse', 'Tyrant', 'Doom', 'Lord', 'Ruin'];

/** The dragons' harsh shared tongue: drawn from the seed alone (never world.rng), so it can live in the cache. */
function dragonTongue(world) {
  const c = world.cache;
  if (!c.dragonTongue || c.dragonTongueSeed !== world.seed) {
    c.dragonTongue = createLanguage(new RNG(`${world.seed}|dragon-tongue`), DRAGON_TONGUE);
    c.dragonTongueSeed = world.seed;
  }
  return c.dragonTongue;
}

/** A dragon: { name, epithet }. x, y (optional): its lair, for a by-name the land gave it ("Bane of Oskel"). */
export function dragonName(world, variety, x = null, y = null) {
  const lang = dragonTongue(world);
  const name = makeWord(lang, world.rng, 2, 3);
  const w = DRAGON_WORDS[variety] || DRAGON_WORDS.fire;
  const town = x != null ? nearestTown(world, x, y, 25) : null;
  const feat = x != null ? featureNear(world, x, y, variety === 'sea' ? ['sea', 'ocean', 'island'] : ['range', 'forest', 'lake', 'desert'], 16) : null;
  const epithet = composeName(world.rng, DRAGON_FORMS, {
    Adj: w.adj, Role: w.role, comp: () => compound(pick(world, w.elem), pick(world, DRAGON_PART)), town, feat: featName(feat), Eats: DRAGON_EATS, Dread: DRAGON_DREAD,
  }) || `the ${w.adj[0]}`;
  return { name: capitalize(name.toLowerCase()), epithet };
}

/** The nearest live town within r tiles (its name), or null. Pure. */
function nearestTown(world, x, y, r) {
  let best = null, bd = r * r;
  for (const s of world.settlements) {
    if (!s || !s.alive) continue;
    const d = (s.x - x) ** 2 + (s.y - y) ** 2;
    if (d <= bd) { bd = d; best = s; }
  }
  return best ? best.name : null;
}

// Lairs: "the {Adj} {Hall} of {place}" in the dragon's element, its own "Vharokh's Hold", or an old form.
const LAIR_WORDS = {
  fire: { adj: ['Ember', 'Burning', 'Smoking', 'Cinder', 'Ashen', 'Brazen', 'Red', 'Molten', 'Scorched', 'Black'], old: ['the Wyrmhold of {p}', 'the Burning Throne of {p}'] },
  frost: { adj: ['Frost', 'White', 'Rime', 'Frozen', 'Ice', 'Silent', 'Glittering', 'Blue', 'Snow', 'Hoar'], old: ['the Frost-Throne of {p}', 'the White Hall of {p}'] },
  green: { adj: ['Green', 'Mossy', 'Rotting', 'Slimy', 'Dripping', 'Venom', 'Sunken', 'Reeking', 'Thorny', 'Drowned'], old: ['the Coils of {p}', 'the Wyrm-Mere of {p}'] },
  sea: { adj: ['Sunken', 'Drowned', 'Salt', 'Tidal', 'Grey', 'Echoing', 'Wrecked', 'Weedy', 'Storm', 'Hollow'], old: ['the Sunken Hoard of {p}', 'the Sea-Caves of {p}'] },
};
const LAIR_HALLS = {
  fire: ['Halls', 'Hold', 'Throne', 'Caves', 'Deeps', 'Hollow', 'Keep', 'Pit', 'Forge', 'Crown', 'Eyrie', 'Vault'],
  frost: ['Halls', 'Hold', 'Throne', 'Caves', 'Deeps', 'Keep', 'Vault', 'Crown', 'Eyrie', 'Hollow', 'Spire', 'Tomb'],
  green: ['Hollow', 'Den', 'Caves', 'Mere', 'Bower', 'Pit', 'Coils', 'Deeps', 'Sump', 'Barrow', 'Nest', 'Grotto'],
  sea: ['Caves', 'Hoard', 'Grotto', 'Deeps', 'Hold', 'Vault', 'Halls', 'Arch', 'Wreck', 'Hollow', 'Throne', 'Pool'],
};

/** A lair: "the Ember Halls of Mount Veist", "Vharokh's Hold". owner (optional): the dragon's name. */
export function lairName(world, variety, x, y, volcano = null, owner = null) {
  let place = volcano?.name || null;
  if (!place) {
    const r = featureNear(world, x, y, variety === 'sea' ? ['island', 'sea'] : variety === 'green' ? ['forest', 'lake'] : ['range'], 12);
    place = r ? featName(r) : `Mount ${nameWord(world.lang, world.rng, 1, 2)}`;
  }
  const w = LAIR_WORDS[variety] || LAIR_WORDS.fire;
  const halls = LAIR_HALLS[variety] || LAIR_HALLS.fire;
  const name = composeName(world.rng, [
    [4, 'the {Adj} {Hall} of {p}'], [1.4, '{ownerPos} {Hall}'], [1.2, 'the {Hall} of {p}'], [1, '{old}'],
  ], { Adj: w.adj, Hall: halls, p: place, ownerPos: owner ? possessive(owner) : null, old: w.old.map((t) => t.replace('{p}', place)) });
  return name || `the Wyrmhold of ${place}`;
}

// Slayers' by-names: the beast's kind made a compound ("Trollhewer"), a role ("the Giant-Feller"),
// the beast's own name ("Bane of Vharokh", "Mossback's Bane") or its haunt ("Wyrmbane of the Hul
// Spine"). The old fixed titles stay as a rare form.
const SLAYERS = {
  dragon: { stem: ['Dragon', 'Wyrm', 'Drake', 'Worm'], role: ['Dragon-Slayer', 'Wyrm-Slayer', 'Dragon-Queller', 'Wyrm-Killer', 'Drake-Breaker', 'Dragon-Bane', 'Scale-Splitter', 'Hoard-Winner'],
    fixed: ['Dragonsbane', 'Wyrmslayer', 'Wyrmbane', 'the Dragon-Slayer'] },
  wyvern: { stem: ['Wyvern', 'Wing', 'Sky'], role: ['Wyvern-Killer', 'Wing-Cutter', 'Wyvern-Slayer', 'Sky-Hunter', 'Wing-Breaker', 'Talon-Cutter'], fixed: ['Wyvernslayer', 'Wingcutter', 'the Wyvern-Killer'] },
  troll: { stem: ['Troll', 'Stone', 'Bog'], role: ['Troll-Killer', 'Troll-Slayer', 'Stone-Breaker', 'Troll-Hunter', 'Bridge-Clearer', 'Hill-Warden'], fixed: ['Trollbane', 'Trollslayer', 'Stonebreaker'] },
  giant: { stem: ['Giant', 'Hill', 'Crag'], role: ['Giant-Feller', 'Giant-Killer', 'Giant-Toppler', 'Hill-Warden', 'Tall-Feller', 'Stone-Thrower'], fixed: ['Giantsbane', 'Giantkiller', 'the Giant-Feller'] },
  treant: { stem: ['Oak', 'Tree', 'Root', 'Bark'], role: ['Oak-Feller', 'Tree-Feller', 'Axe of the Wood', 'Root-Cutter', 'Wood-Breaker', 'Firebrand'], fixed: ['Oakfeller', 'Treefeller', 'the Axe of the Wood'] },
  kraken: { stem: ['Kraken', 'Deep', 'Sea'], role: ['Kraken-Slayer', 'Sea-Champion', 'Deep-Harrower', 'Arm-Cutter', 'Tide-Warden', 'Harpooner'], fixed: ['Krakenbane', 'Krakenslayer', 'the Sea-Champion'] },
  behemoth: { stem: ['Beast', 'Tusk', 'Horn'], role: ['Huntsman', 'Great Hunter', 'Beast-Killer', 'Beast-Queller', 'Tusk-Taker', 'Horn-Breaker'], fixed: ['the Huntsman', 'Beastbane', 'the Great Hunter'] },
  undead: { stem: ['Grave', 'Ghost', 'Death', 'Barrow', 'Bone'], role: ['Grave-Sealer', 'Gravewarden', 'Ghost-Breaker', 'Barrow-Warden', 'Dead-Layer', 'Lantern-Bearer'],
    fixed: ['Gravewarden', 'Ghostbane', 'the Grave-Sealer', 'Deathsbane'] },
};
const SLAYER_SUFFIX = ['bane', 'slayer', 'breaker', 'feller', 'killer', 'hewer', 'cleaver', 'queller', 'scourge', 'render'];
const SLAYER_HAUNT = { dragon: ['range', 'forest', 'lake', 'desert', 'island', 'sea'], kraken: ['sea', 'ocean', 'island'], treant: ['forest', 'lake', 'range'] };
const SLAYER_FORMS = [
  [2.6, '{Comp} of {haunt}'], [2.2, 'Bane of {foe}'], [1.8, '{foePos} Bane'], [2, 'the {Role} of {haunt}'], [1.6, 'the Slayer of {foe}'],
  [1.2, '{foeComp}'], [1.2, '{Comp} of {town}'], [0.9, 'the {Role} of {town}'], [0.35, '{Comp}'], [0.3, 'the {Role}'], [0.25, '{fixed}'],
];
/** The beast's own short name for "Bane of …" ("Mossback", "Vharokh"); null for "the Troll of the Hul Spine". */
function foeWord(band) {
  const n = String(band?.name || '').trim();
  if (!n || /\sof\s/.test(n)) return null;
  let bare = n.replace(/^the\s+/i, '').replace(/^Old\s+/, '');
  const m = /^(\S+) the \S+$/.exec(bare);      // "Ruvek the Pale" → "Ruvek"
  if (m) bare = m[1];
  return bare && bare.length <= 16 && !/\s/.test(bare) ? bare : null;
}
/**
 * The by-name a beast's slayer earns ("Trollhewer of the Hul Spine", "Bane of Vharokh", "the Giant-Feller
 * of Oskel"). A pure function of the world seed and the beast (its id, kind, name and haunt), drawn
 * from a private RNG: no world.rng draw, and the same answer every time it is asked.
 */
export const slayerTitle = (band, world = null) => {
  const l = SLAYERS[band && band.kind];
  if (!l) return 'the Bold';
  const rng = new RNG(`${world?.seed ?? ''}|slayer|${band.id | 0}|${band.kind}|${band.name || ''}`);
  let haunt = null, town = null;
  if (world && Number.isFinite(band.homeI) && world.W > 0) {
    const x = band.homeI % world.W, y = (band.homeI / world.W) | 0;
    haunt = featName(featureNear(world, x, y, SLAYER_HAUNT[band.kind] || ['range', 'forest', 'lake', 'desert'], 16));
    town = nearestTown(world, x, y, 20);
  }
  const foe = foeWord(band);
  const stem = () => rng.pick(l.stem);
  const suf = () => SLAYER_SUFFIX[Math.floor(rng.next() * SLAYER_SUFFIX.length)];
  return composeName(rng, SLAYER_FORMS, {
    Comp: () => compound(stem(), suf()), Role: l.role, haunt, town, foe, foePos: foe ? possessive(foe) : null,
    foeComp: foe && foe.length <= 9 ? () => `${foe}-${capitalize(suf())}` : null, fixed: l.fixed,
  }) || l.fixed[Math.abs(band.id | 0) % l.fixed.length];
};

/** A hero for a monster-slaying: the slayer's personal name in their people's tongue. */
export const heroName = (world, civ) => makePerson(civ?.language || world.lang, world.rng);
