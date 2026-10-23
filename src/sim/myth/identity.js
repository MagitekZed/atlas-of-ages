// Identity of the peoples of a Mythic world: how each race styles its realms and rulers,
// how it builds, and the halls and wonders only it raises. Reaches the civ module through
// the nameStyle and archStyle providers and the core building and wonder registries
// (core/ext.js registerBuildings / registerWonders, merged by WP3).
//
//   nameStyle(w, civ, govKey) → { styles: ['…{name}…'], titles: { m: [], f: [] } } | null
//     styles use the government tables' placeholders ({name} the base name, {adj} the
//     adjective); a style never begins with "the" (the chronicle adds it) and avoids plurals
//     the civ prose cannot agree with. Each realm gets its own few forms, drawn from its
//     race's vocabulary for the government (VOCAB: hundreds of styles and dozens of titles
//     per race and government, some titles in the realm's own tongue), so the same phrases
//     seldom meet twice across worlds.
//   archStyle(w, civ) → partial civ.style ({ roof, wall, temple, layout, palette, race })
//
// The racial buildings and wonders below are registered by arcana.js registerArcana() when
// the first Mythic world starts (never at import). Racial buildings carry `race`, `available(w, s, civ)` and `smods` (settlement modifier
// keys of core/effects.js per level: add keys summed × level, mul keys as 1 + (v − 1) × level)
// plus `score` (how keenly a town wants it). Humans keep the shared name tables (null answers)
// and raise one hall of their own, the Hall of Tongues, where a town's many peoples meet.

import { registerProvider } from '../../core/ext.js';
import { WATER } from '../../core/constants.js';
import { hashString, hash2i, RNG } from '../../core/rng.js';
import { makeWord, isEnglishWord } from '../../core/names.js';
import { isMythic, RACES, fin, bandOf } from './races.js';

// ---------------------------------------------------------------------------
// Realm names and ruler titles, by race and government family

const S = (styles, m, f = m) => ({ styles, titles: { m, f } });
const NAME_STYLES = {
  dwarf: {
    tribe: S(['{adj} Clans', 'Clanhold of {name}', 'Deep Clans of {name}'], ['Thane', 'Clan-Father'], ['Thane', 'Clan-Mother']),
    chiefdom: S(['Hold of {name}', '{adj} Hold', 'Thanehold of {name}'], ['High Thane', 'Hold-Lord'], ['High Thane', 'Hold-Lady']),
    kingdom: S(['Under-Kingdom of {name}', 'Mountain-Hold of {name}', '{adj} Under-Realm'], ['Under-King', 'Mountain-King'], ['Under-Queen', 'Mountain-Queen']),
    empire: S(['Deep Empire of {name}', 'Throne of the {adj} Deeps', 'Iron Crown of {name}'], ['Lord of the Deeps', 'High King under the Mountain'], ['Lady of the Deeps', 'High Queen under the Mountain']),
    feudal: S(['Under-Kingdom of {name}', '{adj} Hold-League', 'Hold-Kingdom of {name}'], ['Under-King', 'High Thane'], ['Under-Queen', 'High Thane']),
    theocracy: S(['Rune-Temple of {name}', 'Holy Forge of {name}', '{adj} Rune-Hold'], ['Runelord', 'Forge-Priest'], ['Runelady', 'Forge-Priestess']),
    republic: S(['Free Hold of {name}', '{adj} Guild-League', 'Guild-Hold of {name}'], ['Guildmaster', 'Lawspeaker'], ['Guildmistress', 'Lawspeaker']),
    merchant: S(['Guild-Hold of {name}', '{adj} Merchant-Hold', 'Free Hold of {name}'], ['Guildmaster', 'Master of the Ledger'], ['Guildmistress', 'Mistress of the Ledger']),
    horde: S(['{adj} War-Host', 'Iron Host of {name}'], ['Warthane'], ['Warthane']),
    constitutional: S(['Commonhold of {name}', 'Crowned Hold of {name}'], ['Under-King', 'Hold-King'], ['Under-Queen', 'Hold-Queen']),
    democracy: S(['Commonwealth of the {adj} Hold', 'United Hold of {name}'], ['Speaker of the Holds', 'Lawspeaker']),
    dictatorship: S(['{adj} Iron Hold', 'Anvil State of {name}'], ['Ironlord'], ['Ironlady']),
  },
  elf: {
    tribe: S(['{adj} Kindred', 'Wood-Folk of {name}', 'Kindred of {name}'], ['Elder', 'Wood-Warden'], ['Elder', 'Wood-Warden']),
    chiefdom: S(['Glade of {name}', '{adj} Glade', 'Greenwood of {name}'], ['Lord of the Wood'], ['Lady of the Wood']),
    kingdom: S(['Sylvan Realm of {name}', 'Woodland Realm of {name}', '{adj} Realm'], ['High Lord', 'Elf-King'], ['High Lady', 'Elf-Queen']),
    empire: S(['Star-Throne of {name}', 'High Kingdom of {name}', 'Evenstar Realm of {name}'], ['High King of the Elves', 'Star-King'], ['High Queen of the Elves', 'Star-Queen']),
    feudal: S(['Sylvan Realm of {name}', 'Concord of the {adj} Woods'], ['High Lord', 'Lord of the Wood'], ['High Lady', 'Lady of the Wood']),
    theocracy: S(['Moon-Court of {name}', 'Starlit Court of {name}', '{adj} Moon-Court'], ['Moon-Priest', 'Star-Seer'], ['Moon-Priestess', 'Star-Seer']),
    republic: S(['Council of {name}', '{adj} Conclave', 'Free Glade of {name}'], ['Speaker', 'First of the Council']),
    merchant: S(['Silver Conclave of {name}', '{adj} Conclave'], ['Speaker', 'Keeper of the Silver']),
    horde: S(['{adj} Wild Hunt', 'Wild Hunt of {name}'], ['Huntmaster'], ['Huntmistress']),
    constitutional: S(['Sylvan Commonwealth of {name}', 'Crowned Glade of {name}'], ['High Lord'], ['High Lady']),
    democracy: S(['Free Commonwealth of {name}', '{adj} Assembly'], ['First Speaker', 'Speaker of the Woods']),
    dictatorship: S(['Thorn-Throne of {name}', '{adj} Thorn-Realm'], ['Thorn-Lord'], ['Thorn-Lady']),
  },
  orc: {
    tribe: S(['{adj} Warband', 'Warband of {name}', '{adj} Clans'], ['Warchief', 'Chieftain']),
    chiefdom: S(['Blood-Clan of {name}', '{adj} War-Clan', 'Warband of {name}'], ['Warchief', 'Blood-Chief']),
    kingdom: S(['Overlordship of {name}', '{adj} Dominion', 'Iron Fist of {name}'], ['Overlord', 'War-King'], ['Overlord', 'War-Queen']),
    empire: S(['Black Empire of {name}', 'Iron Dominion of {name}', '{adj} Dominion'], ['Warlord of Warlords', 'Overlord'], ['Warlord of Warlords', 'Overlord']),
    feudal: S(['{adj} Dominion', 'Overlordship of {name}'], ['Overlord', 'War-King'], ['Overlord', 'War-Queen']),
    horde: S(['{adj} Horde', 'Great Horde of {name}', 'Horde of {name}'], ['Great Khan', 'Warlord'], ['Great Khan', 'Warmother']),
    theocracy: S(['Bone-Shrine of {name}', 'Skull-Cult of {name}'], ['Bone-Shaman', 'Skull-Speaker']),
    republic: S(['Moot of {name}', '{adj} Clan-Moot'], ['Moot-Chief', 'Big Chief']),
    merchant: S(['Loot-Moot of {name}', '{adj} Trade-Clan'], ['Loot-Chief', 'Boss of the Moot']),
    constitutional: S(['Crowned Moot of {name}', '{adj} Dominion'], ['Overlord'], ['Overlord']),
    democracy: S(['Great Moot of {name}', '{adj} Clan-Moot'], ['Moot-Chief', 'First Chief']),
    dictatorship: S(['{adj} Iron Horde', 'Tyranny of {name}'], ['Iron Boss', 'Tyrant']),
  },
  halfling: {
    tribe: S(['Shire of {name}', '{adj} Hill-Folk', 'Hollow of {name}'], ['Thain', 'Elder']),
    chiefdom: S(['Shire of {name}', '{adj} Shire', 'Green Hollow of {name}'], ['Thain', 'Shire-Thain']),
    kingdom: S(['Green Kingdom of {name}', '{adj} Shire-Realm', 'Shire-Realm of {name}'], ['Shire-King', 'Thain'], ['Shire-Queen', 'Thain']),
    empire: S(['Great Shire of {name}', '{adj} Shire-Realm'], ['High Thain', 'Shire-King'], ['High Thain', 'Shire-Queen']),
    feudal: S(['Shire-Realm of {name}', '{adj} Shire-Realm'], ['Thain', 'Shire-King'], ['Thain', 'Shire-Queen']),
    theocracy: S(['Hearth-Fold of {name}', 'Green Chapel of {name}'], ['Hearth-Keeper', 'Elder of the Hearth']),
    republic: S(['Free Shire of {name}', '{adj} Shire-Moot', 'Shire-Moot of {name}'], ['Mayor', 'Shire-Reeve']),
    merchant: S(['Free Shire of {name}', '{adj} Market-Moot'], ['Mayor', 'Master of the Market']),
    horde: S(['{adj} Wander-Folk', 'Wagon-Moot of {name}'], ['Wagon-Master'], ['Wagon-Mistress']),
    constitutional: S(['Shire-Realm of {name}', 'Crowned Shire of {name}'], ['Thain'], ['Thain']),
    democracy: S(['Free Shire of {name}', 'Commonshire of {name}'], ['Mayor', 'First Reeve']),
    dictatorship: S(['{adj} Bailiwick', 'Bailiwick of {name}'], ['Shirriff-General']),
  },
  lizardfolk: {
    tribe: S(['Brood of {name}', '{adj} Brood', 'Clutch of {name}'], ['Brood-Father', 'Elder Scale'], ['Egg-Mother', 'Elder Scale']),
    chiefdom: S(['Brood of {name}', '{adj} Clutch-Kin', 'Sun-Brood of {name}'], ['Sun-Speaker', 'Brood-Father'], ['Egg-Mother', 'Sun-Speaker']),
    kingdom: S(['Serpent Kingdom of {name}', 'Sun-Throne of {name}', '{adj} Coil'], ['Serpent-King', 'Sun-King'], ['Serpent-Queen', 'Egg-Queen']),
    empire: S(['Great Coil of {name}', 'Serpent Empire of {name}', '{adj} Sun-Empire'], ['Coil-Emperor', 'Sun-Lord'], ['Coil-Empress', 'Egg-Queen']),
    feudal: S(['Serpent Kingdom of {name}', '{adj} Coil'], ['Serpent-King'], ['Serpent-Queen']),
    theocracy: S(['Sun-Temple of {name}', 'Holy Brood of {name}', 'Coil of the Sun at {name}'], ['Sun-Speaker', 'High Hierophant'], ['Egg-Mother', 'Sun-Speaker']),
    republic: S(['Conclave of {name}', '{adj} Clutch-Council'], ['Elder Scale', 'Speaker of Clutches']),
    merchant: S(['Pearl Conclave of {name}', '{adj} Clutch-Council'], ['Pearl-Speaker', 'Elder Scale']),
    horde: S(['{adj} Swarm', 'Swarm of {name}'], ['Swarm-Lord'], ['Swarm-Mother']),
    constitutional: S(['Crowned Coil of {name}', 'Sun-Throne of {name}'], ['Serpent-King'], ['Serpent-Queen']),
    democracy: S(['Free Clutch of {name}', '{adj} Clutch-Council'], ['First Speaker', 'Speaker of Clutches']),
    dictatorship: S(['{adj} Fang', 'Fang-State of {name}'], ['Fang-Lord'], ['Fang-Mother']),
  },
};

// The tables above are the classic forms. Each realm draws its own from a much wider space:
// a race's realm nouns for the government (H), its themed qualifiers for the government's mood
// (Q) and its ranks (R) with title prefixes (P), combined as
//   styles  '{Q} {H} of {name}' · '{adj} {H}' · '{H} of {name}' · '{H} of the {adj}' · a classic form
//   titles  'R' · 'P-R' · 'High R' (only ranks marked '*' take a prefix) · a classic title
// Heads are singular (or one of the plurals the chronicle agrees with: Clans), never start
// with "the", and every style names the realm ({name} or {adj}), so names stay unique within a
// world. A realm's forms are a pure function of the world seed, its id, race and government
// (cached in world.cache.mythStyles): the civ module's style and title indices pick among them.

const MOOD = {
  tribe: 'rule', chiefdom: 'rule', kingdom: 'rule', empire: 'rule', feudal: 'rule', constitutional: 'rule',
  theocracy: 'holy', republic: 'free', merchant: 'free', democracy: 'free', horde: 'war', dictatorship: 'war',
};
const GOV_IDX = Object.fromEntries(Object.keys(MOOD).map((k, n) => [k, n + 1]));

const VOCAB = {
  dwarf: {
    q: {
      rule: ['Iron', 'Granite', 'Stone', 'Deep', 'Basalt', 'Bronze', 'Silver', 'Copper', 'Golden', 'Obsidian', 'Adamant', 'Grey', 'Marble', 'Flint'],
      holy: ['Holy', 'Hallowed', 'Ancestral', 'Rune-Bound', 'Eternal', 'Sacred', 'Ever-Burning', 'Rune-Lit'],
      free: ['Free', 'Common', 'Sworn', 'Chartered', 'Silver', 'Oath-Bound', 'Ledger-Sworn'],
      war: ['Iron', 'Black', 'Red', 'Grim', 'Steel', 'Ash', 'Axe-Sworn', 'Ember'],
    },
    p: {
      rule: ['Under', 'Mountain', 'Stone', 'Hold', 'Deep', 'Hill', 'Iron', 'Forge'],
      holy: ['Rune', 'Forge', 'Ancestor', 'Stone'],
      free: ['Law', 'Hold', 'Guild', 'Moot'],
      war: ['War', 'Axe', 'Iron', 'Host'],
    },
    h: {
      tribe: ['Clans', 'Clanhold', 'Delving', 'Kin-Hold', 'Hearthfold'],
      chiefdom: ['Hold', 'Thanehold', 'Holdfast', 'Fastness', 'Delve'],
      kingdom: ['Under-Kingdom', 'Mountain-Hold', 'Under-Realm', 'Stone-Kingdom', 'Hill-Kingdom', 'Hold-Kingdom'],
      empire: ['Under-Empire', 'Mountain-Throne', 'Deep-Dominion', 'Stone-Empire', 'Throne-Hold'],
      feudal: ['Hold-League', 'Thanedom', 'Under-Kingdom', 'Hold-Kingdom', 'Thane-Crown'],
      theocracy: ['Rune-Temple', 'Forge-Temple', 'Rune-Hold', 'Ancestor-Hall', 'Forge-Sanctum'],
      republic: ['Commonhold', 'Guild-League', 'Hold-Moot', 'Lawhold', 'Guild-Hold'],
      merchant: ['Guild-Hold', 'Merchant-Hold', 'Ledger-League', 'Coin-Hold', 'Trade-Moot'],
      horde: ['War-Host', 'Host', 'Warband', 'Axe-Host', 'War-Clan'],
      constitutional: ['Commonhold', 'Charter-Hold', 'Charter-Kingdom', 'Crown-Moot'],
      democracy: ['Commonwealth', 'Hold-Union', 'Assembly', 'Moot-Republic', 'Common-Hold'],
      dictatorship: ['Ironhold', 'Anvil-State', 'Ironmark', 'Hammer-State', 'Forge-State'],
    },
    r: {
      tribe: [['*Thane', '*Thane'], ['Clan-Father', 'Clan-Mother'], ['Elder', 'Elder'], ['Hearth-Father', 'Hearth-Mother']],
      chiefdom: [['*Thane', '*Thane'], ['Hold-Lord', 'Hold-Lady'], ['*Lord', '*Lady']],
      kingdom: [['*King', '*Queen'], ['*Lord', '*Lady'], ['*Thane', '*Thane']],
      empire: [['*King', '*Queen'], ['*Emperor', '*Empress'], ['Lord of the Deeps', 'Lady of the Deeps']],
      feudal: [['*King', '*Queen'], ['*Thane', '*Thane']],
      theocracy: [['Runelord', 'Runelady'], ['*Priest', '*Priestess'], ['*Keeper', '*Keeper']],
      republic: [['Guildmaster', 'Guildmistress'], ['Lawspeaker', 'Lawspeaker'], ['*Speaker', '*Speaker']],
      merchant: [['Guildmaster', 'Guildmistress'], ['Master of the Ledger', 'Mistress of the Ledger'], ['*Master', '*Mistress']],
      horde: [['Warthane', 'Warthane'], ['*Lord', '*Lady']],
      constitutional: [['*King', '*Queen'], ['*Thane', '*Thane']],
      democracy: [['Speaker of the Holds', 'Speaker of the Holds'], ['Lawspeaker', 'Lawspeaker'], ['*Speaker', '*Speaker']],
      dictatorship: [['Ironlord', 'Ironlady'], ['*Lord', '*Lady'], ['*Master', '*Mistress']],
    },
  },
  elf: {
    q: {
      rule: ['Silver', 'Golden', 'Green', 'Starlit', 'Moonlit', 'Evening', 'Dawn', 'Evergreen', 'Elder', 'Hidden', 'Twilight', 'Silent', 'Shining', 'Amber'],
      holy: ['Starlit', 'Moonlit', 'Holy', 'Hallowed', 'Silver', 'Dreaming', 'Evenstar'],
      free: ['Free', 'Silver', 'Green', 'Open', 'Gathered', 'Willow'],
      war: ['Wild', 'Grey', 'Red', 'Thorn', 'Shadow', 'Ashen'],
    },
    p: {
      rule: ['Star', 'Moon', 'Wood', 'Leaf', 'Elf', 'Glade'],
      holy: ['Moon', 'Star', 'Dream', 'Grove'],
      free: ['Leaf', 'Glade', 'Wood', 'Willow'],
      war: ['Hunt', 'Thorn', 'Shadow', 'Wild'],
    },
    h: {
      tribe: ['Kindred', 'Wood-Folk', 'Fellowship', 'Grove-Kin', 'Leaf-Kin'],
      chiefdom: ['Glade', 'Greenwood', 'Grove', 'Wood-Realm', 'Bower'],
      kingdom: ['Realm', 'Wood-Realm', 'Leaf-Kingdom', 'Glade-Realm', 'Kingdom', 'Bough-Realm'],
      empire: ['Star-Throne', 'High-Realm', 'Star-Realm', 'Moon-Throne', 'Elder-Realm', 'Dawn-Throne'],
      feudal: ['Concord', 'Wood-Realm', 'Leaf-Realm', 'Bough-Kingdom'],
      theocracy: ['Moon-Court', 'Star-Court', 'Grove-Temple', 'Dream-Court', 'Sanctuary'],
      republic: ['Council', 'Conclave', 'Glade-Council', 'Leaf-Council', 'Assembly'],
      merchant: ['Conclave', 'Silver-Conclave', 'Trade-Concord', 'Amber-Council'],
      horde: ['Hunt', 'Wild-Hunt', 'Hunt-Host', 'Riding'],
      constitutional: ['Commonwealth', 'Crown-Glade', 'Charter-Realm'],
      democracy: ['Commonwealth', 'Assembly', 'Leaf-Assembly', 'Concord'],
      dictatorship: ['Thorn-Throne', 'Thorn-Realm', 'Briar-State', 'Thorn-Court'],
    },
    r: {
      tribe: [['Elder', 'Elder'], ['*Warden', '*Warden'], ['Wood-Warden', 'Wood-Warden']],
      chiefdom: [['Lord of the Wood', 'Lady of the Wood'], ['*Lord', '*Lady'], ['*Warden', '*Warden']],
      kingdom: [['*King', '*Queen'], ['*Lord', '*Lady'], ['High Lord', 'High Lady']],
      empire: [['High King of the Elves', 'High Queen of the Elves'], ['*King', '*Queen'], ['*Emperor', '*Empress']],
      feudal: [['*Lord', '*Lady'], ['*King', '*Queen']],
      theocracy: [['*Priest', '*Priestess'], ['*Seer', '*Seer'], ['Star-Seer', 'Star-Seer']],
      republic: [['*Speaker', '*Speaker'], ['First of the Council', 'First of the Council']],
      merchant: [['*Speaker', '*Speaker'], ['Keeper of the Silver', 'Keeper of the Silver'], ['*Keeper', '*Keeper']],
      horde: [['Huntmaster', 'Huntmistress'], ['*Master', '*Mistress']],
      constitutional: [['*Lord', '*Lady'], ['*King', '*Queen']],
      democracy: [['First Speaker', 'First Speaker'], ['*Speaker', '*Speaker']],
      dictatorship: [['Thorn-Lord', 'Thorn-Lady'], ['*Lord', '*Lady']],
    },
  },
  orc: {
    q: {
      rule: ['Black', 'Red', 'Iron', 'Blood', 'Bone', 'Skull', 'Ash', 'Burning', 'Howling', 'Grim', 'Savage', 'Scarred', 'Broken-Tusk', 'Crow'],
      holy: ['Bone', 'Skull', 'Blood', 'Howling', 'Spirit', 'Ghost', 'Drum'],
      free: ['Free', 'Great', 'Loud', 'Wide', 'Red', 'Many-Clan'],
      war: ['Black', 'Red', 'Iron', 'Blood', 'Bone', 'Howling', 'Burning', 'Crow'],
    },
    p: {
      rule: ['War', 'Blood', 'Over', 'Tusk', 'Skull', 'Iron'],
      holy: ['Bone', 'Skull', 'Spirit', 'Drum'],
      free: ['Moot', 'Clan', 'Loot', 'Shout'],
      war: ['War', 'Iron', 'Blood', 'Horde'],
    },
    h: {
      tribe: ['Warband', 'Clans', 'War-Clan', 'Tusk-Clan', 'Camp'],
      chiefdom: ['Blood-Clan', 'War-Clan', 'Warband', 'Chief-Hold', 'Clan-Fist'],
      kingdom: ['Overlordship', 'Dominion', 'Fist', 'War-Kingdom', 'Overkingdom', 'Throne'],
      empire: ['Dominion', 'Empire', 'Skull-Empire', 'Over-Empire', 'Fist-Empire'],
      feudal: ['Dominion', 'Overlordship', 'Chief-Dominion', 'Tusk-Kingdom'],
      theocracy: ['Bone-Shrine', 'Skull-Cult', 'Spirit-Lodge', 'Drum-Shrine', 'Blood-Cult'],
      republic: ['Moot', 'Clan-Moot', 'War-Moot', 'Shout-Moot'],
      merchant: ['Loot-Moot', 'Trade-Clan', 'Plunder-Moot', 'Barter-Clan'],
      horde: ['Horde', 'War-Horde', 'Host', 'Tusk-Horde', 'Stampede'],
      constitutional: ['Crown-Moot', 'Dominion', 'Oath-Dominion'],
      democracy: ['Moot', 'Clan-Moot', 'All-Moot', 'Shout-Moot'],
      dictatorship: ['Horde', 'Tyranny', 'Fist-State', 'Boss-State', 'Iron-Fist'],
    },
    r: {
      tribe: [['*Chief', '*Chief'], ['Chieftain', 'Chieftain'], ['Warchief', 'Warchief']],
      chiefdom: [['Warchief', 'Warchief'], ['*Chief', '*Chief'], ['Blood-Chief', 'Blood-Chief']],
      kingdom: [['Overlord', 'Overlord'], ['*King', '*Queen'], ['*Boss', '*Boss']],
      empire: [['Warlord of Warlords', 'Warlord of Warlords'], ['Overlord', 'Overlord'], ['*Emperor', '*Empress'], ['*Khan', '*Khan']],
      feudal: [['Overlord', 'Overlord'], ['*King', '*Queen']],
      theocracy: [['*Shaman', '*Shaman'], ['Skull-Speaker', 'Skull-Speaker'], ['*Speaker', '*Speaker']],
      republic: [['*Chief', '*Chief'], ['Big Chief', 'Big Chief'], ['Moot-Chief', 'Moot-Chief']],
      merchant: [['Loot-Chief', 'Loot-Chief'], ['Boss of the Moot', 'Boss of the Moot'], ['*Boss', '*Boss']],
      horde: [['Great Khan', 'Great Khan'], ['*Khan', '*Khan'], ['Warlord', 'Warmother'], ['*Lord', '*Mother']],
      constitutional: [['Overlord', 'Overlord'], ['*King', '*Queen']],
      democracy: [['Moot-Chief', 'Moot-Chief'], ['First Chief', 'First Chief'], ['*Chief', '*Chief']],
      dictatorship: [['Iron Boss', 'Iron Boss'], ['Tyrant', 'Tyrant'], ['*Boss', '*Boss']],
    },
  },
  halfling: {
    q: {
      rule: ['Green', 'Golden', 'Merry', 'Hither', 'Fair', 'Quiet', 'Sunny', 'Mossy', 'Honey', 'Apple', 'Meadow', 'Brambly'],
      holy: ['Hallowed', 'Blessed', 'Green', 'Kindly', 'Harvest', 'Candle-Lit'],
      free: ['Free', 'Common', 'Fair', 'Merry', 'Neighbourly', 'Open-Door'],
      war: ['Wandering', 'Restless', 'Hardy', 'Roving', 'Wayfaring'],
    },
    p: {
      rule: ['Shire', 'Hill', 'Hearth', 'Green', 'Hollow'],
      holy: ['Hearth', 'Harvest', 'Garden'],
      free: ['Shire', 'Moot', 'Market', 'Field'],
      war: ['Wagon', 'Road', 'Wander'],
    },
    h: {
      tribe: ['Hill-Folk', 'Hollow', 'Burrow', 'Shire', 'Hearth-Kin'],
      chiefdom: ['Shire', 'Hollow', 'Green', 'Thainship', 'Burrowstead'],
      kingdom: ['Shire-Realm', 'Kingdom', 'Shire-Kingdom', 'Hill-Kingdom', 'Hearth-Realm'],
      empire: ['Shire', 'Shire-Realm', 'Hearth-Empire', 'Thainship'],
      feudal: ['Shire-Realm', 'Thainship', 'Shire-League', 'Hill-Realm'],
      theocracy: ['Hearth-Fold', 'Chapel', 'Harvest-Fold', 'Hearth-Chapel'],
      republic: ['Shire-Moot', 'Shire', 'Commonshire', 'Moot', 'Reeveship'],
      merchant: ['Market-Moot', 'Market-Shire', 'Fair-Moot', 'Trade-Shire'],
      horde: ['Wander-Folk', 'Wagon-Moot', 'Caravan', 'Wagon-Train'],
      constitutional: ['Shire-Realm', 'Crown-Shire', 'Charter-Shire'],
      democracy: ['Commonshire', 'Shire', 'Moot', 'Shire-Union'],
      dictatorship: ['Bailiwick', 'Shirriffdom', 'Reeve-State'],
    },
    r: {
      tribe: [['Thain', 'Thain'], ['Elder', 'Elder'], ['*Elder', '*Elder']],
      chiefdom: [['*Thain', '*Thain'], ['Thain', 'Thain']],
      kingdom: [['*King', '*Queen'], ['Thain', 'Thain'], ['*Thain', '*Thain']],
      empire: [['High Thain', 'High Thain'], ['*King', '*Queen']],
      feudal: [['*Thain', '*Thain'], ['*King', '*Queen']],
      theocracy: [['Hearth-Keeper', 'Hearth-Keeper'], ['Elder of the Hearth', 'Elder of the Hearth'], ['*Keeper', '*Keeper']],
      republic: [['Mayor', 'Mayor'], ['*Reeve', '*Reeve'], ['*Mayor', '*Mayor']],
      merchant: [['Mayor', 'Mayor'], ['Master of the Market', 'Mistress of the Market'], ['*Master', '*Mistress']],
      horde: [['Wagon-Master', 'Wagon-Mistress'], ['*Master', '*Mistress']],
      constitutional: [['Thain', 'Thain'], ['*Thain', '*Thain']],
      democracy: [['Mayor', 'Mayor'], ['First Reeve', 'First Reeve'], ['*Reeve', '*Reeve']],
      dictatorship: [['Shirriff-General', 'Shirriff-General'], ['*Shirriff', '*Shirriff']],
    },
  },
  lizardfolk: {
    q: {
      rule: ['Sun', 'Jade', 'Golden', 'Emerald', 'Coiled', 'Scaled', 'Green', 'Blackwater', 'Fen', 'Sunken', 'Warm', 'Serpent', 'Reed'],
      holy: ['Sun', 'Holy', 'Burning', 'Golden', 'Egg', 'Dawn', 'Sun-Blooded'],
      free: ['Free', 'Pearl', 'Jade', 'Gathered', 'Many-Clutch'],
      war: ['Black', 'Fanged', 'Venom', 'Red', 'Scarlet', 'Blackwater'],
    },
    p: {
      rule: ['Serpent', 'Sun', 'Coil', 'Scale', 'Fen'],
      holy: ['Sun', 'Egg', 'Dawn', 'Serpent'],
      free: ['Clutch', 'Pearl', 'Nest', 'Reed'],
      war: ['Fang', 'Swarm', 'Venom', 'Coil'],
    },
    h: {
      tribe: ['Brood', 'Clutch', 'Nest', 'Hatching', 'Scale-Kin'],
      chiefdom: ['Brood', 'Clutch-Kin', 'Sun-Brood', 'Nest-Hold', 'Egg-Clan'],
      kingdom: ['Serpent-Kingdom', 'Sun-Throne', 'Coil', 'Scale-Kingdom', 'Fen-Kingdom'],
      empire: ['Coil', 'Serpent-Empire', 'Sun-Empire', 'Coil-Empire', 'Sun-Throne'],
      feudal: ['Serpent-Kingdom', 'Coil', 'Coil-League', 'Fen-Realm'],
      theocracy: ['Sun-Temple', 'Egg-Temple', 'Sun-Coil', 'Serpent-Temple'],
      republic: ['Conclave', 'Clutch-Council', 'Scale-Council', 'Nest-Council'],
      merchant: ['Pearl-Conclave', 'Clutch-Council', 'Pearl-Council', 'Reed-Market'],
      horde: ['Swarm', 'Coil-Swarm', 'Fang-Host', 'Brood-Swarm'],
      constitutional: ['Crown-Coil', 'Sun-Throne', 'Oath-Coil'],
      democracy: ['Clutch', 'Clutch-Council', 'Nest-Assembly'],
      dictatorship: ['Fang', 'Fang-State', 'Venom-State', 'Coil-State'],
    },
    r: {
      tribe: [['Brood-Father', 'Egg-Mother'], ['Elder Scale', 'Elder Scale'], ['*Elder', '*Elder']],
      chiefdom: [['Sun-Speaker', 'Sun-Speaker'], ['Brood-Father', 'Egg-Mother'], ['*Speaker', '*Speaker']],
      kingdom: [['*King', '*Queen'], ['Egg-King', 'Egg-Queen'], ['*Lord', '*Lady']],
      empire: [['*Emperor', '*Empress'], ['Sun-Lord', 'Egg-Queen'], ['*Lord', '*Lady']],
      feudal: [['*King', '*Queen'], ['*Lord', '*Lady']],
      theocracy: [['Sun-Speaker', 'Egg-Mother'], ['High Hierophant', 'High Hierophant'], ['*Hierophant', '*Hierophant']],
      republic: [['Elder Scale', 'Elder Scale'], ['Speaker of Clutches', 'Speaker of Clutches'], ['*Speaker', '*Speaker']],
      merchant: [['Pearl-Speaker', 'Pearl-Speaker'], ['Elder Scale', 'Elder Scale'], ['*Speaker', '*Speaker']],
      horde: [['Swarm-Lord', 'Swarm-Mother'], ['*Lord', '*Mother']],
      constitutional: [['*King', '*Queen'], ['*Lord', '*Lady']],
      democracy: [['First Speaker', 'First Speaker'], ['Speaker of Clutches', 'Speaker of Clutches'], ['*Speaker', '*Speaker']],
      dictatorship: [['Fang-Lord', 'Fang-Mother'], ['*Lord', '*Lady']],
    },
  },
};

const STYLE_N = 4;     // forms offered per realm (the civ module's style index picks one)
const TITLE_N = 3;     // titles offered per realm (its title index picks one)
const at = (list, u) => list[u % list.length];

/** One realm style for a race and government from four hashes (pure). */
function genStyle(V, classic, gov, u, a, b) {
  const mood = MOOD[gov] || 'rule';
  const heads = V.h[gov] || V.h.kingdom;
  const H = at(heads, a);
  const f = u % 20;
  if (f < 8) {                                                    // Jade Sun-Throne of Ixath
    const qs = V.q[mood];
    let Q = at(qs, b);
    // never "Drum Drum-Shrine": a qualifier that repeats the head's own first word
    for (let k = 1; k < qs.length && H.toLowerCase().split(/[- ]/).includes(Q.toLowerCase()); k++) Q = at(qs, b + k);
    return `${Q} ${H} of {name}`;
  }
  if (f < 12) return `{adj} ${H}`;                               // Ixathi Sun-Throne
  if (f < 15) return `${H} of {name}`;                           // Sun-Throne of Ixath
  if (f < 17) return `${H} of the {adj}`;                        // Sun-Throne of the Ixathi
  return classic?.styles?.length ? at(classic.styles, b) : `${H} of {name}`;
}

/**
 * One [m, f] title pair (pure). '*' marks a rank that takes the race's prefixes and "High", or
 * a word of the realm's own tongue (`native`, one syllable: "Dur-Thane", "Ssik-Speaker").
 */
function genTitle(V, classic, gov, u, a, b, native) {
  const mood = MOOD[gov] || 'rule';
  const ranks = V.r[gov] || V.r.kingdom;
  const [m0, f0] = at(ranks, a);
  const bare = (s) => s.replace(/^\*/, '');
  if (m0[0] !== '*') {
    const f = u % 6;
    if (f === 5 && classic?.titles?.m?.length) { const k = b % classic.titles.m.length; return [classic.titles.m[k], (classic.titles.f || classic.titles.m)[k] || classic.titles.m[k]]; }
    return [m0, f0];
  }
  const f = u % 10;
  if (f < 2) return [bare(m0), bare(f0)];                                         // Thane
  if (f < 3) return [`High ${bare(m0)}`, `High ${bare(f0)}`];                     // High Thane
  if (f < 6 && native) return [`${native}-${bare(m0)}`, `${native}-${bare(f0)}`]; // Dur-Thane
  const P = at(V.p[mood], b);
  return [`${P}-${bare(m0)}`, `${P}-${bare(f0)}`];                                 // Under-King, Under-Queen
}

const RUDE = /^(?:dik|dick|dic|cum|cock|cok|fuk|fuck|shit|tit|tits|ass|arse|piss|poo|poop|dong|dung|wank|knob|slut|twat|nob|fag|gay|nig|jap|kike|spic)$/i;
/** A one-syllable word of the realm's own tongue for its titles, or null (pure: a local RNG). */
function nativeWord(civ, seed) {
  const L = civ.language;
  if (!L || !Array.isArray(L.onsets) || !L.onsets.length || !Array.isArray(L.vowels) || !L.vowels.length || !Array.isArray(L.codas)) return null;
  const rng = new RNG(seed);
  for (let k = 0; k < 4; k++) {
    const w = makeWord({ ...L, apostrophe: false }, rng, 1, 1);
    if (w.length >= 2 && w.length <= 5 && !/'/.test(w) && !isEnglishWord(w) && !RUDE.test(w)) return w;
  }
  return null;
}

/** A realm's own forms: { styles: [STYLE_N], titles: { m: [TITLE_N], f: [TITLE_N] } } (pure, cached). */
function realmForms(world, civ, gov) {
  const race = civ.race;
  const V = VOCAB[race];
  const classic = NAME_STYLES[race]?.[gov] || NAME_STYLES[race]?.kingdom || null;
  if (!V) return classic;
  const key = `${civ.id}|${race}|${gov}|${civ.baseName}|${civ.foundedDay}`;   // (ids are never reused, but be sure)
  const c = world.cache;
  const cache = c.mythStyles && c.mythStylesSeed === world.seed ? c.mythStyles : (c.mythStylesSeed = world.seed, c.mythStyles = Object.create(null));
  const hit = cache[key];
  if (hit) return hit;
  const h = hashString(`${world.seed}:realm-forms:${race}`);
  const id = (fin(civ.id, 0) | 0) * 16 + (GOV_IDX[gov] || 0);
  const styles = [];
  for (let k = 0; styles.length < STYLE_N && k < 24; k++) {
    const s = genStyle(V, classic, gov, hash2i(id, k * 4 + 1, h), hash2i(id, k * 4 + 2, h), hash2i(id, k * 4 + 3, h));
    if (!styles.includes(s)) styles.push(s);
  }
  const native = nativeWord(civ, hash2i(id, 999, h));
  const m = [], f = [], seen = new Set();
  for (let k = 0; m.length < TITLE_N && k < 24; k++) {
    const t = genTitle(V, classic, gov, hash2i(id, 1000 + k * 4 + 1, h), hash2i(id, 1000 + k * 4 + 2, h), hash2i(id, 1000 + k * 4 + 3, h), native);
    const norm = t[0].toLowerCase().replace(/-/g, ' ');           // "Big Chief" and "Big-Chief" are one title
    if (!seen.has(norm)) { seen.add(norm); m.push(t[0]); f.push(t[1]); }
  }
  const out = { styles, titles: { m, f } };
  cache[key] = out;
  return out;
}

function nameStyle(world, civ, govKey) {
  if (!isMythic(world) || !civ || !civ.race) return null;
  if (!NAME_STYLES[civ.race]) return null;
  const gov = MOOD[govKey] ? govKey : 'kingdom';
  return realmForms(world, civ, gov);
}

/**
 * Every ruler title a race may give its rulers under a government ({ m: [], f: [] }: the classic
 * titles and every generated form), for UI and prose; null for humans (the shared tables).
 */
export function raceTitles(race, govKey) {
  const V = VOCAB[race];
  if (!V) return null;
  const gov = MOOD[govKey] ? govKey : 'kingdom';
  const mood = MOOD[gov];
  const m = [], f = [];
  const add = (a, b) => { if (!m.includes(a)) { m.push(a); f.push(b); } };
  const cl = NAME_STYLES[race]?.[gov]?.titles;
  if (cl) cl.m.forEach((t, k) => add(t, (cl.f || cl.m)[k] || t));
  for (const [m0, f0] of V.r[gov] || []) {
    if (m0[0] !== '*') { add(m0, f0); continue; }
    const bm = m0.slice(1), bf = f0.replace(/^\*/, '');
    add(bm, bf); add(`High ${bm}`, `High ${bf}`);
    for (const P of V.p[mood]) add(`${P}-${bm}`, `${P}-${bf}`);
  }
  return { m, f };
}

/** How many distinct realm styles (with {name} unfilled) and titles a race has for a government. */
export function realmFormCounts(race, govKey) {
  const V = VOCAB[race];
  if (!V) return { styles: 0, titles: 0 };
  const gov = MOOD[govKey] ? govKey : 'kingdom';
  const heads = (V.h[gov] || []).length;
  const q = V.q[MOOD[gov]].length;
  const classic = (NAME_STYLES[race]?.[gov]?.styles || []).length;
  return { styles: heads * (q + 3) + classic, titles: raceTitles(race, gov).m.length };
}

// ---------------------------------------------------------------------------
// Architecture (civ.style, drawn by WP7)

const ARCH = {
  elf: { roof: 'pagoda', wall: 'timber', temple: 'stupa', layout: 'organic', palette: [126, 168, 142], race: 'elf' },
  dwarf: { roof: 'flat', wall: 'stone', temple: 'pyramid', layout: 'grid', palette: [124, 120, 128], race: 'dwarf' },
  orc: { roof: 'longhouse', wall: 'timber', temple: 'ziggurat', layout: 'ring', palette: [150, 92, 64], race: 'orc' },
  halfling: { roof: 'thatch', wall: 'whitewash', temple: 'basilica', layout: 'organic', palette: [196, 176, 118], race: 'halfling' },
  lizardfolk: { roof: 'thatch', wall: 'mudbrick', temple: 'ziggurat', layout: 'ring', palette: [96, 146, 112], race: 'lizardfolk' },
};
function archStyle(world, civ) {
  if (!isMythic(world) || !civ || !civ.race) return null;
  return ARCH[civ.race] || null;
}

registerProvider('nameStyle', 'myth', nameStyle);
registerProvider('archStyle', 'myth', archStyle);

// ---------------------------------------------------------------------------
// Racial buildings

const gate = (race, extra = null) => (world, s, civ) => {
  if (!isMythic(world) || !s || !civ) return false;
  if ((s.race || civ.race) !== race) return false;
  return extra ? extra(world, s, civ) : true;
};
/** Is the town on raised ground (a hall can be dug into the hillside)? */
function onHigh(world, s) {
  const { W, H } = world;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = s.x + dx, y = s.y + dy;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const i = y * W + x;
    if (world.f.water[i] === WATER.LAND && bandOf(world, i) >= 1) return true;
  }
  return false;
}
const forestAround = (world, s) => {
  const v = world.f.veg[s.i];
  return Number.isFinite(v) && v > 0.35;
};
const watery = (world, s) => world.f.river[s.i] > 0 || s.coastal || world.f.biome[s.i] === 15;
/** Share of a town's people who are not human (its s.peoples mix; 0 for a pure or unmixed town). */
function othersIn(s) {
  const p = s.peoples;
  if (!p || typeof p !== 'object') return 0;
  let o = 0;
  for (const r in p) if (r !== 'human' && p[r] > 0) o += p[r];
  return o;
}

/** Building keys this package registers (mana sources and drains read them). */
export const MYTH_BUILDINGS = new Set(['treehall', 'moonwell', 'deephall', 'runeforge', 'warpit', 'beastpen', 'smial', 'pantry', 'spawnpool', 'sunaltar', 'tonguehall', 'magetower']);

export const BUILDINGS = [
  { id: 'treehall', race: 'elf', names: ['Tree-Hall', 'Great Tree-Hall'], tech: ['toolmaking', 'masonry'], minTier: [1, 3], cost: 80, upkeep: 0.04,
    available: gate('elf', forestAround), smods: { housing: 1.12, happiness: 0.02 }, score: 1.9,
    desc: 'Homes woven into living trees: room for many without felling a single one.' },
  { id: 'moonwell', race: 'elf', names: ['Moonwell'], tech: ['mysticism'], minTier: 2, cost: 140, upkeep: 0.05,
    available: gate('elf'), smods: { health: 0.04, research: 1.05 }, score: 1.3, mana: 0.012,
    desc: 'A still pool that gathers moonlight; the sick are brought to drink, and magic wells up around it.' },
  { id: 'deephall', race: 'dwarf', names: ['Deep-Hall', 'Grand Deep-Hall'], tech: ['toolmaking', 'masonry'], minTier: [1, 3], cost: 100, upkeep: 0.05,
    available: gate('dwarf', onHigh), smods: { housing: 1.18, defense: 0.12 }, score: 2,
    desc: 'Halls hewn into the hillside, warm in winter and proof against any siege.' },
  { id: 'runeforge', race: 'dwarf', names: ['Rune-Forge'], tech: ['bronze'], minTier: 2, cost: 160, upkeep: 0.06,
    available: gate('dwarf'), smods: { production: 1.12, defense: 0.08 }, score: 1.5,
    desc: 'A forge whose anvils are carved with runes of making.' },
  { id: 'warpit', race: 'orc', names: ['War-Pit'], tech: ['toolmaking'], minTier: 1, cost: 70, upkeep: 0.04,
    available: gate('orc'), smods: { defense: 0.14, unrest: -0.03 }, score: 1.6,
    desc: 'A fighting pit where the young warriors are blooded and the restless are given work.' },
  { id: 'beastpen', race: 'orc', names: ['Beast-Pen'], tech: ['husbandry'], minTier: 1, cost: 70, upkeep: 0.03,
    available: gate('orc'), smods: { foodYield: 1.06 }, score: 1.2,
    desc: 'Pens of half-tamed beasts: meat for the clans, mounts for the raids.' },
  { id: 'smial', race: 'halfling', names: ['Smial', 'Great Smial'], tech: ['toolmaking', 'masonry'], minTier: [1, 3], cost: 70, upkeep: 0.03,
    available: gate('halfling'), smods: { housing: 1.12, happiness: 0.04 }, score: 1.9,
    desc: 'Snug burrows dug into the hillocks, with round green doors and deep pantries.' },
  { id: 'pantry', race: 'halfling', names: ['Pantry', 'Great Larder'], tech: ['pottery', 'engineering'], minTier: [1, 3], cost: 60, upkeep: 0.03,
    available: gate('halfling'), smods: { foodYield: 1.07, health: 0.02 }, score: 1.6,
    desc: 'Cellars of cheeses, hams and preserves against the lean months.' },
  { id: 'spawnpool', race: 'lizardfolk', names: ['Spawning Pool'], tech: ['fishing'], minTier: 1, cost: 80, upkeep: 0.04,
    available: gate('lizardfolk', watery), smods: { birth: 1.12 }, score: 1.6,
    desc: 'Warm shallows where the broods lay their eggs in the reeds.' },
  { id: 'sunaltar', race: 'lizardfolk', names: ['Sun-Altar'], tech: ['mysticism'], minTier: 2, cost: 120, upkeep: 0.05,
    available: gate('lizardfolk'), smods: { culture: 1.15, unrest: -0.04 }, score: 1.3,
    desc: 'A stepped altar where the sun-speakers greet the dawn.' },
  // humans: a hall where the peoples of a mixed town meet (a human town, or a town of a human
  // realm, where other peoples make up at least a tenth)
  { id: 'tonguehall', race: null, names: ['Hall of Tongues', 'College of Tongues'], tech: ['writing', 'printing'], minTier: [2, 3], cost: 130, upkeep: 0.05,
    available: (world, s, civ) => isMythic(world) && Boolean(s && civ) && (civ.race === 'human' || s.race === 'human') && othersIn(s) >= 0.1,
    smods: { research: 1.04, trade: 1.06, attract: 1.05 }, score: 1.3,
    desc: 'Scribes and interpreters of every people in the town, who copy one another’s books and settle one another’s bargains.' },
  // the wizards' tower: any people that has learned Sorcery
  { id: 'magetower', race: null, names: ['Mage Tower', 'High Tower'], tech: ['sorcery', 'high_wizardry'], minTier: [2, 3], cost: 260, upkeep: 0.1,
    available: (world, s, civ) => isMythic(world) && Boolean(civ?.tech?.known && civ.tech.known.sorcery != null) && fin(civ.arcane?.mana, 0) >= 0.2,
    smods: { research: 1.12, defense: 0.1 }, score: 1.4, mana: -0.018,
    desc: 'A tower of study and summoning. Its mages draw on the ley around the town and leave it thin.' },
];

// ---------------------------------------------------------------------------
// Racial wonders (one standing per kind in the world, like the shared wonders)

const W = (o) => ({ ...o, id: o.kind, available: (world, s, civ) => isMythic(world) && Boolean(civ) && (!o.race || (s?.race || civ.race) === o.race) });
export const WONDERS = [
  W({ kind: 'heartwood_throne', race: 'elf', era: 1, tech: 'wood_singing', minTier: 3, cost: 14000, prestige: 18,
    mods: { culture: 0.15, stability: 0.05, arcana: 0.1 },
    names: ['the Heartwood Throne of {city}', 'the Throne of the Elder Tree at {city}'],
    desc: 'A throne grown, not carved, from the heart of the oldest tree in the world.' }),
  W({ kind: 'great_delving', race: 'dwarf', era: 1, tech: 'deep_delving', minTier: 3, cost: 16000, prestige: 18,
    mods: { production: 0.12, mining: 0.3, defense: 0.1 },
    names: ['the Great Delving of {city}', 'the Deeps of {city}', 'the Thousand Halls of {city}'],
    desc: 'A city beneath the city, its stairs going down farther than any dwarf has counted.' }),
  W({ kind: 'skull_throne', race: 'orc', era: 1, tech: 'blood_rites', minTier: 3, cost: 11000, prestige: 16,
    mods: { military: 0.15, stability: 0.04 },
    names: ['the Skull Throne of {ruler}', 'the Skull Throne of {city}'],
    desc: 'A seat of conquered skulls; whoever holds it speaks for every clan.' }),
  W({ kind: 'hearth_of_plenty', race: 'halfling', era: 1, tech: 'bountiful_hearth', minTier: 3, cost: 11000, prestige: 14,
    mods: { farmYield: 0.12, happiness: 0.05, health: 0.03 },
    names: ['the Hearth of Plenty at {city}', 'the Great Larder of {city}'],
    desc: 'A hearth whose fire has not gone out in living memory, and whose table is never bare.' }),
  W({ kind: 'serpent_ziggurat', race: 'lizardfolk', era: 2, tech: 'sunblood_rites', minTier: 3, cost: 18000, prestige: 18,
    mods: { culture: 0.15, stability: 0.05, birth: 0.05 },
    names: ['the Serpent Ziggurat of {city}', 'the Sun-Coil of {city}'],
    desc: 'A stepped pyramid wound about by a stone serpent, its head raised to the sun.' }),
  W({ kind: 'arcanum', race: null, era: 4, tech: 'high_wizardry', minTier: 4, cost: 60000, prestige: 22,
    mods: { research: 0.15, arcana: 0.2, wards: 0.1 },
    names: ['the Arcanum of {city}', 'the Tower of Stars at {city}', 'the Library of Spells at {city}'],
    desc: 'A college of the high arts, where every school of magic sends its masters.' }),
];

/** Racial and arcane buildings a town holds: [{ def, level }] (for the Inspector and mana). */
export function mythBuildingsOf(s) {
  const out = [];
  if (!s || !s.buildings) return out;
  for (const b of BUILDINGS) {
    const lvl = fin(s.buildings[b.id], 0);
    if (lvl > 0) out.push({ def: b, level: lvl });
  }
  return out;
}

/** The race's blurb, for the Inspector. */
export const raceBlurb = (r) => RACES[r]?.blurb || '';
