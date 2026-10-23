// Ruler epithets (docs/design/temperament-and-names.md §3): a combinatorial generator in place of the
// old fixed lists, so "the Cruel" and "the Builder" no longer greet every world. An epithet is
// drawn from a theme — one of the ruler's traits, a deed (conquest, golden, builder, colonies,
// reform, learning, losses, famine) or a posthumous mark (old, brief, young, accursed) — in one
// of several forms:
//   plain    "the Cruel", "the Pitiless"                     a themed pool (the classic form)
//   adj      "the Iron-Handed", "the Silver-Tongued"         themed compound adjectives
//   by       "Stormhelm", "Pennypincher", "Harefoot"         themed bynames (prefix × suffix)
//   place    "the Lion of Oskel", "the Shield of the Tiren"  a role of the realm's own places
//   pc       "the Kesh-Taker", "the Oskel-Builder"           a place-compound agent (no "of")
//   own      "the Father of the Varathi"                     a role of the ruler's people
//   foe      "the Hammer of the Oskeli", "the Oskeli-Slayer" a role against the foe they beat
//   tongue   "Vashtor" (glossed "the Cruel")                 a word of the people's own language
//   special  "of the Thirty-Seven Days", "the Boy-King", "the Taker of Kesh", "of the Lean Years"
// Proper names of the world (towns, rivers, seas, peoples, gods, the language) make most
// epithets unique to their world; the plain pools keep the old flavour at a smaller share.
// Forms with "of" are held to about a quarter, since the chronicle often goes on "… of the
// Kingdom of Varath", and their places are towns and rivers (short names).
// A ruler's epithet never repeats one already borne in the same realm (a few redraws).
// All randomness is world.rng; the result is a string that reads after the ruler's name
// ("Queen Ilsa II the Lion of Oskel", "King Arkel Stormhelm", "Vorn of the Lean Years").

import { makeWord, isEnglishWord } from '../../core/names.js';
import { peopleOf, pick, seaNameNear, featureNameNear } from './prose.js';

const G = (r, s) => { const k = s.indexOf('|'); return k < 0 ? s : r?.gender === 'f' ? s.slice(k + 1) : s.slice(0, k); };
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * Theme tables. adj: [[A list, B list], …] groups whose members combine freely ("Iron-Handed");
 * by: [prefixes, suffixes] for bynames; place / own / foe: role nouns ("Father|Mother" by gender);
 * foeC: suffixes after the foe's name ("the Oskeli-Slayer").
 */
const T = {
  cruel: {
    pc: ['Burner', 'Butcher', 'Flayer', 'Scourge'],
    plain: ['the Cruel', 'the Terrible', 'the Grim', 'the Merciless', 'the Pitiless', 'the Fell', 'the Dread', 'the Hard', 'the Wicked', 'the Black', 'the Bloody'],
    adj: [[['Iron', 'Stone', 'Black', 'Cold', 'Red', 'Blood', 'Flint'], ['Handed', 'Hearted', 'Fisted', 'Eyed']]],
    by: [['Blood', 'Grim', 'Black', 'Iron', 'Wolf', 'Gall', 'Bone', 'Thorn', 'Ash', 'Skull', 'Gore', 'Flint', 'Raven'], ['hand', 'fist', 'heart', 'tooth', 'claw', 'axe', 'brand', 'helm', 'fang', 'hood', 'cloak', 'maw']],
    place: ['Terror', 'Scourge', 'Butcher', 'Wolf', 'Tyrant', 'Dread', 'Shadow', 'Bane', 'Flayer'],
    own: ['Scourge', 'Terror', 'Tyrant', 'Wolf', 'Bane'],
    foe: ['Butcher', 'Scourge', 'Terror', 'Bane'], foeC: ['Flayer', 'Burner', 'Butcher'],
  },
  just: {
    pc: ['Judge'],
    plain: ['the Just', 'the Fair', 'the Upright', 'the Good', 'the True', 'the Righteous', 'the Honest'],
    adj: [[['Even', 'Clean', 'Fair', 'True', 'Clear', 'Straight', 'Steady'], ['Handed', 'Hearted', 'Eyed', 'Spoken', 'Dealing']]],
    by: [['True', 'Fair', 'Oath', 'Law', 'White', 'Bright', 'Steady', 'Even', 'Truth', 'Right', 'Clear', 'Plain'], ['hand', 'word', 'heart', 'scale', 'staff', 'helm', 'crown', 'oath', 'mantle', 'brow']],
    place: ['Judge', 'Light', 'Shepherd|Shepherdess', 'Guardian', 'Lamp', 'Conscience'],
    own: ['Father|Mother', 'Shepherd|Shepherdess', 'Guardian', 'Judge', 'Friend'],
  },
  pious: {
    pc: ['Saint'],
    plain: ['the Pious', 'the Devout', 'the Holy', 'the Blessed', 'the Godly', 'the Faithful', 'the Chaste', 'the Saintly', 'the Reverent', 'the Pure'],
    adj: [[['God', 'Heaven', 'Star', 'Sun', 'Moon', 'Spirit'], ['Fearing', 'Touched', 'Sent', 'Blessed', 'Crowned', 'Favoured']]],
    by: [['Candle', 'Psalm', 'Altar', 'Halo', 'Prayer', 'Censer', 'Bell', 'Hymn', 'Shrine', 'Incense', 'Vigil', 'Relic', 'Chalice', 'Lamb'], ['keeper', 'bearer', 'singer', 'hand', 'heart', 'light', 'ward', 'crown', 'knee']],
    place: ['Saint', 'Shepherd|Shepherdess', 'Light', 'Lamp', 'Beloved', 'Candle', 'Priest|Priestess'],
    own: ['Shepherd|Shepherdess', 'Saint', 'Father|Mother', 'Light'],
    god: ['Beloved', 'Servant', 'Chosen', 'Voice', 'Hand'],
  },
  warlike: {
    pc: ['Warden', 'Defender', 'Guardian'],
    plain: ['the Bold', 'the Warrior', 'the Fierce', 'the Valiant', 'the Brave', 'the Fearless', 'the Stout', 'the Hardy', 'the Lion', 'the Mighty', 'the Strong'],
    adj: [[['Iron', 'Steel', 'Bronze', 'Red', 'Battle', 'War', 'Storm', 'Spear', 'Shield'], ['Handed', 'Hearted', 'Armed', 'Helmed', 'Fisted']]],
    by: [['Iron', 'Storm', 'Battle', 'War', 'Spear', 'Axe', 'Shield', 'Sword', 'Red', 'Bear', 'Wolf', 'Hawk', 'Thunder', 'Steel', 'Lion', 'Bull'], ['arm', 'hand', 'fist', 'helm', 'shield', 'brand', 'heart', 'axe', 'spear', 'blade', 'mane', 'claw', 'horn', 'hammer']],
    place: ['Sword', 'Shield', 'Spear', 'Lion', 'Bull', 'Hammer', 'Champion', 'Bulwark', 'Wall', 'Hawk'],
    own: ['Sword', 'Shield', 'Champion', 'Lion', 'Spear'],
    foe: ['Hammer', 'Scourge', 'Bane', 'Terror', 'Doom'], foeC: ['Slayer', 'Breaker', 'Bane'],
  },
  craven: {
    plain: ['the Unready', 'the Timid', 'the Fearful', 'the Meek', 'the Trembling', 'the Hesitant', 'the Shy', 'the Soft', 'the Quiet'],
    adj: [[['Faint', 'Soft', 'Pale', 'White', 'Weak', 'Lily', 'Milk'], ['Hearted', 'Livered', 'Kneed', 'Willed']]],
    by: [['Hare', 'Mouse', 'Reed', 'Willow', 'Milk', 'Soft', 'Pale', 'Quail', 'Rabbit', 'Fawn'], ['heart', 'foot', 'hand', 'cloak', 'tail']],
    place: ['Hare', 'Ghost', 'Shadow', 'Mouse', 'Trembler'],
  },
  scholarly: {
    pc: ['Sage'],
    plain: ['the Scholar', 'the Learned', 'the Lettered', 'the Sage', 'the Studious', 'the Bookish', 'the Erudite', 'the Philosopher', 'the Clerk'],
    adj: [[['Ink', 'Quill', 'Chalk'], ['Stained', 'Fingered']], [['Well', 'Wide', 'Deep'], ['Read', 'Learned']], [['Star', 'Moon'], ['Gazing', 'Reading']], [['Lamp', 'Candle'], ['Lit']]],
    by: [['Ink', 'Quill', 'Book', 'Scroll', 'Lamp', 'Candle', 'Star', 'Rune', 'Page', 'Chalk', 'Lore', 'Tablet', 'Letter', 'Owl'], ['hand', 'wise', 'keeper', 'reader', 'wright', 'mind', 'eye', 'brow']],
    place: ['Lamp', 'Light', 'Sage', 'Teacher', 'Scholar', 'Mind'],
    own: ['Teacher', 'Lamp', 'Light'],
  },
  brilliant: {
    plain: ['the Brilliant', 'the Bright', 'the Clever', 'the Shining', 'the Gifted', 'the Quick', 'the Sharp', 'the Dazzling'],
    adj: [[['Quick', 'Keen', 'Sharp', 'Bright'], ['Witted', 'Minded', 'Eyed']], [['Silver', 'Golden'], ['Minded', 'Tongued']]],
    by: [['Bright', 'Star', 'Quick', 'Keen', 'Spark', 'Sun', 'Flame', 'Gold', 'Silver', 'Lantern', 'Comet', 'Day'], ['wit', 'mind', 'eye', 'brow', 'fire', 'spark', 'light']],
    place: ['Star', 'Jewel', 'Wonder', 'Light', 'Flame', 'Marvel'],
    own: ['Star', 'Jewel', 'Wonder'],
  },
  wise: {
    pc: ['Sage'],
    plain: ['the Wise', 'the Sage', 'the Thoughtful', 'the Patient', 'the Sagacious', 'the Discerning', 'the Shrewd'],
    adj: [[['Far', 'Clear', 'Deep', 'Long'], ['Sighted', 'Seeing', 'Minded']]],
    by: [['Grey', 'Owl', 'Far', 'Deep', 'Still', 'Wise', 'Sage', 'Silver', 'Oak', 'Elder', 'Raven', 'Moss'], ['eye', 'mind', 'brow', 'heart', 'staff', 'word', 'counsel', 'cloak']],
    place: ['Sage', 'Oracle', 'Counsellor', 'Owl', 'Lamp', 'Mind', 'Voice'],
    own: ['Counsellor', 'Father|Mother', 'Teacher', 'Sage'],
  },
  foolish: {
    plain: ['the Foolish', 'the Simple', 'the Fool', 'the Witless', 'the Gullible', 'the Dreamer', 'the Muddled', 'the Dull'],
    adj: [[['Feather', 'Empty', 'Thick', 'Addle', 'Muddle', 'Wool'], ['Headed', 'Witted', 'Pated', 'Brained']]],
    by: [['Goose', 'Calf', 'Lack', 'Daft', 'Moon', 'Wool', 'Mutton', 'Feather', 'Pudding', 'Turnip', 'Cabbage', 'Muddle'], ['wit', 'head', 'pate', 'brain', 'skull']],
    place: ['Fool', 'Jest', 'Laughing-Stock'],
    own: ['Fool', 'Shame'],
  },
  greedy: {
    plain: ['the Grasping', 'the Miser', 'the Avaricious', 'the Covetous', 'the Greedy', 'the Mean', 'the Hoarder', 'the Rapacious'],
    adj: [[['Tight', 'Close', 'Iron', 'Gold'], ['Fisted', 'Pursed', 'Fingered']]],
    by: [['Gold', 'Coin', 'Penny', 'Silver', 'Tax', 'Tithe', 'Purse', 'Hoard', 'Copper', 'Ledger', 'Toll', 'Scale'], ['fist', 'grip', 'hand', 'counter', 'pincher', 'grabber', 'clutch']],
    place: ['Miser', 'Leech', 'Tax-Gatherer', 'Moneylender', 'Treasurer'],
    own: ['Leech', 'Miser'],
  },
  generous: {
    pc: ['Friend'],
    plain: ['the Generous', 'the Liberal', 'the Bountiful', 'the Kind', 'the Gracious', 'the Gentle', 'the Giver', 'the Benevolent', 'the Charitable'],
    adj: [[['Open', 'Free', 'Gold', 'Silver', 'Warm', 'Full'], ['Handed', 'Hearted', 'Pursed']]],
    by: [['Gold', 'Bread', 'Gift', 'Alms', 'Bounty', 'Honey', 'Ring', 'Feast', 'Salt', 'Mead', 'Corn', 'Hearth'], ['giver', 'hand', 'heart', 'bringer', 'sharer', 'friend']],
    place: ['Friend', 'Benefactor', 'Provider', 'Bounty', 'Patron', 'Hearth'],
    own: ['Father|Mother', 'Friend', 'Provider', 'Darling'],
  },
  mad: {
    plain: ['the Mad', 'the Strange', 'the Raving', 'the Moonstruck', 'the Possessed', 'the Wild', 'the Fey', 'the Frenzied', 'the Haunted'],
    adj: [[['Moon', 'Wild', 'Storm', 'Fever', 'God'], ['Struck', 'Eyed', 'Touched', 'Haunted']]],
    by: [['Wild', 'Moon', 'Fever', 'Howl', 'Storm', 'Ghost', 'Dream'], ['eye', 'wit', 'song', 'heart']],
    place: ['Madman|Madwoman', 'Ghost', 'Storm', 'Bane', 'Howler'],
  },
  charismatic: {
    plain: ['the Beloved', 'the Radiant', 'the Fair', 'the Golden', 'the Glorious', 'the Gracious', 'the Charming', 'the Splendid', 'the Adored', 'the Handsome|the Beautiful'],
    adj: [[['Silver', 'Golden', 'Honey', 'Sweet', 'Fair'], ['Tongued', 'Voiced', 'Spoken']], [['Bright', 'Sun'], ['Faced', 'Smiling']]],
    by: [['Sun', 'Gold', 'Bright', 'Fair', 'Silver', 'Rose', 'Honey', 'Dawn', 'Star', 'Lark', 'May', 'Amber'], ['smile', 'voice', 'song', 'face', 'heart', 'word', 'tongue', 'locks']],
    place: ['Darling', 'Beloved', 'Sun', 'Star', 'Rose', 'Pride', 'Delight', 'Jewel'],
    own: ['Darling', 'Pride', 'Beloved', 'Sun', 'Delight'],
  },
  ambitious: {
    plain: ['the Ambitious', 'the Restless', 'the Proud', 'the Aspiring', 'the Unbending', 'the Driven', 'the Insatiable'],
    adj: [[['Far', 'High', 'Wide', 'Long'], ['Reaching', 'Grasping', 'Striding']]],
    by: [['High', 'Far', 'Over', 'Sky', 'Crown', 'Star', 'Eagle', 'Throne', 'Peak', 'Summit'], ['reach', 'stride', 'grasp', 'climber', 'seeker', 'hunger']],
    place: ['Eagle', 'Hawk', 'Star', 'Climber', 'Upstart'],
    own: ['Eagle', 'Hope'],
  },
  industrious: {
    plain: ['the Industrious', 'the Diligent', 'the Tireless', 'the Busy', 'the Untiring', 'the Steadfast', 'the Toiler', 'the Thrifty'],
    adjList: ['the Never-Resting', 'the Ever-Waking', 'the Early-Rising', 'the Dawn-Rising', 'the Busy-Handed', 'the Hard-Working'],
    by: [['Anvil', 'Hammer', 'Plough', 'Mill', 'Forge', 'Toil', 'Loom', 'Kiln', 'Furrow', 'Bellows', 'Chisel', 'Spade'], ['hand', 'arm', 'heart', 'wright', 'master', 'back']],
    place: ['Steward', 'Smith', 'Maker', 'Mason', 'Ploughman|Ploughwoman', 'Workhorse'],
    own: ['Steward', 'Provider', 'Workhorse'],
  },
  lazy: {
    plain: ['the Idle', 'the Indolent', 'the Sluggard', 'the Slothful', 'the Sleeper', 'the Slow', 'the Soft', 'the Languid', 'the Drowsy'],
    adjList: ['the Slow-Footed', 'the Late-Rising', 'the Heavy-Lidded', 'the Soft-Handed', 'the Sleepy-Eyed'],
    by: [['Feather', 'Pillow', 'Couch', 'Idle', 'Drowse', 'Down', 'Slug', 'Snail', 'Moss'], ['bed', 'head', 'hand', 'foot', 'bones', 'pace']],
    place: ['Sleeper', 'Sluggard', 'Dreamer', 'Shadow'],
  },
  cautious: {
    pc: ['Warden', 'Keeper'],
    plain: ['the Prudent', 'the Careful', 'the Wary', 'the Patient', 'the Steady', 'the Cautious', 'the Deliberate', 'the Circumspect'],
    adj: [[['Slow', 'Sure', 'Light', 'Soft'], ['Footed', 'Stepping']], [['Long'], ['Waiting']]],
    by: [['Sure', 'Still', 'Steady', 'Slow', 'Wall', 'Moat', 'Gate', 'Ward', 'Watch', 'Tower', 'Bridge', 'Anchor'], ['foot', 'hand', 'keeper', 'ward', 'watch', 'step', 'guard']],
    place: ['Keeper', 'Warden', 'Wall', 'Guardian', 'Anchor', 'Rock'],
    own: ['Keeper', 'Guardian', 'Rock', 'Anchor'],
  },
  paranoid: {
    pc: ['Jailer', 'Watcher'],
    plain: ['the Watchful', 'the Suspicious', 'the Wary', 'the Sleepless', 'the Jealous', 'the Fearful', 'the Secretive', 'the Vigilant'],
    adj: [[['Hawk', 'Sharp', 'Hundred', 'Narrow', 'Cat'], ['Eyed']], [['Never', 'Light'], ['Sleeping']]],
    by: [['Watch', 'Ward', 'Lock', 'Bolt', 'Key', 'Spy', 'Shadow', 'Night', 'Cat', 'Owl', 'Grate', 'Dagger'], ['eye', 'keeper', 'hand', 'ward', 'watch', 'master', 'ear']],
    place: ['Watcher', 'Warden', 'Jailer', 'Shadow', 'Eye', 'Spider'],
    own: ['Jailer', 'Watcher', 'Spider'],
  },
  // deeds
  conquest: {
    pc: ['Taker', 'Breaker', 'Winner', 'Conqueror'],
    plain: ['the Conqueror', 'the Victorious', 'the Great', 'the Invincible', 'the Triumphant', 'the Unconquered', 'the Unbeaten', 'the Mighty'],
    adj: [[['Iron', 'Steel', 'Blood', 'Red'], ['Crowned', 'Shod', 'Handed']]],
    by: [['Sword', 'Spear', 'Iron', 'Storm', 'Battle', 'Crown', 'Land', 'Realm', 'Town', 'Wall', 'Gate', 'Tower', 'Shield', 'Banner', 'Fort'], ['taker', 'winner', 'breaker', 'bringer', 'gainer', 'reaver']],
    place: ['Conqueror', 'Lion', 'Sword', 'Hammer', 'Master|Mistress', 'Taker'],
    own: ['Sword', 'Glory', 'Pride', 'Lion'],
    foe: ['Hammer', 'Scourge', 'Bane', 'Terror', 'Doom', 'Conqueror'], foeC: ['Slayer', 'Breaker', 'Bane', 'Tamer'],
  },
  golden: {
    plain: ['the Great', 'the Magnificent', 'the Golden', 'the Splendid', 'the Glorious', 'the Fortunate', 'the Prosperous', 'the Blessed', 'the Happy', 'the Illustrious'],
    adj: [[['Gold', 'Sun', 'Bright', 'Star'], ['Crowned', 'Touched', 'Blessed']]],
    by: [['Gold', 'Sun', 'Bright', 'Glory', 'Star', 'Amber', 'Summer', 'Honey', 'Harvest', 'Silver', 'Pearl', 'Saffron'], ['crown', 'mantle', 'robe', 'throne', 'helm', 'cloak', 'ring']],
    place: ['Glory', 'Sun', 'Jewel', 'Splendour', 'Crown', 'Light'],
    own: ['Glory', 'Sun', 'Pride', 'Splendour', 'Delight'],
  },
  builder: {
    pc: ['Builder', 'Founder', 'Raiser'],
    plain: ['the Builder', 'the Mason', 'the Maker', 'the Architect', 'the Founder', 'the Raiser'],
    by: [['Stone', 'Marble', 'Brick', 'Tower', 'Bridge', 'Wall', 'Dome', 'Spire', 'Arch', 'Gate', 'Road', 'Canal', 'Temple', 'Keep', 'Tile',
      'Column', 'Granite', 'Cedar', 'Beam', 'Vault', 'Mortar'], ['raiser', 'builder', 'layer', 'wright', 'maker', 'setter', 'hand', 'father|mother']],
    place: ['Builder', 'Maker', 'Founder', 'Raiser', 'Second Founder', 'Mason'],
    own: ['Builder', 'Second Founder', 'Mason'],
  },
  colonies: {
    pc: ['Founder', 'Finder'],
    plain: ['the Navigator', 'the Seafarer', 'the Voyager', 'the Far-Farer', 'the Explorer', 'the Mariner', 'the Wanderer'],
    by: [['Sea', 'Wave', 'Storm', 'Salt', 'Wind', 'Far', 'Ship', 'Tide', 'Foam'], ['farer', 'rider', 'walker', 'strider', 'sailor', 'crown']],
    sea: ['Lord|Lady', 'Master|Mistress', 'Star', 'Admiral'],
    place: ['Founder', 'Navigator', 'Admiral'],
  },
  reform: {
    pc: ['Lawgiver', 'Renewer'],
    plain: ['the Lawgiver', 'the Reformer', 'the Law-Speaker', 'the Renewer', 'the Restorer', 'the Lawmaker', 'the Legislator'],
    by: [['Law', 'Oath', 'Charter', 'Rule', 'Code', 'Writ', 'Seal', 'Scroll', 'Court', 'Rod', 'Ledger', 'Tablet'], ['giver', 'maker', 'wright', 'keeper', 'speaker', 'smith', 'mender']],
    place: ['Lawgiver', 'Reformer', 'Father|Mother', 'Renewer', 'Restorer'],
    own: ['Lawgiver', 'Father|Mother', 'Renewer'],
  },
  learning: {
    plain: ['the Learned', 'the Enlightened', 'the Lettered', 'the Scholar', 'the Inquisitive', 'the Curious', 'the Wise'],
    adj: [[['Well', 'Wide', 'Deep'], ['Read', 'Learned']], [['Star'], ['Gazing']]],
    by: [['Ink', 'Quill', 'Book', 'Scroll', 'Lamp', 'Star', 'Rune', 'Lore'], ['keeper', 'reader', 'wise', 'mind']],
    place: ['Lamp', 'Light', 'Patron', 'Teacher', 'Mind'],
    own: ['Teacher', 'Lamp', 'Light'],
  },
  losses: {
    plain: ['the Unlucky', 'the Lackland', 'the Luckless', 'the Ill-Fated', 'the Unfortunate', 'the Hapless', 'the Landless', 'the Diminished'],
    adj: [[['Broken', 'Empty', 'Bare'], ['Crowned', 'Handed']], [['Ill'], ['Starred', 'Omened']]],
    by: [['Lack', 'Short', 'Half', 'Lost', 'Ash', 'Thin', 'Bare', 'Rag', 'Broken', 'Empty', 'Ill', 'Hollow'], ['land', 'crown', 'luck', 'mantle', 'cloak', 'field', 'purse', 'sword', 'banner', 'shield']],
    place: ['Loser', 'Shadow', 'Ruin'],
    foe: ['Prey', 'Plaything', 'Footstool'],
  },
  famine: {
    plain: ['the Hungry', 'the Ill-Starred', 'the Lean', 'the Barren', 'the Hollow', 'the Starveling', 'the Gaunt'],
    by: [['Lean', 'Thin', 'Gaunt', 'Hollow'], ['belly', 'cheek', 'shanks']],
    place: ['Hunger', 'Bane'],
    of: ['of the Empty Granaries', 'of the Lean Years', 'of the Hungry Years', 'of the Bare Fields', 'of the Bitter Harvests', 'of the Long Hunger'],
  },
  // posthumous
  old: {
    plain: ['the Old', 'the Ancient', 'the Long-Lived', 'the Elder', 'the Venerable', 'the Grey', 'the Aged', 'the Enduring'],
    by: [['Grey', 'Silver', 'White', 'Snow', 'Frost', 'Ash', 'Winter', 'Hoar', 'Salt'], ['beard|locks', 'locks', 'mane', 'crown', 'brow', 'head', 'staff']],
    place: ['Elder', 'Old Oak', 'Grandfather|Grandmother'],
    own: ['Grandfather|Grandmother', 'Elder', 'Old Oak'],
  },
  brief: { plain: ['the Brief', 'the Short-Lived', 'the Fleeting', 'the Ill-Starred'], place: ['Shadow', 'Ghost', 'Lost Hope'] },
  young: {
    plain: ['the Young', 'the Child', 'the Youth', 'the Boy|the Maid', 'the Lost'],
    by: [['Green', 'Spring', 'Fawn', 'Dew', 'May', 'Lamb', 'Sapling', 'Dawn', 'Morning', 'April'], ['leaf', 'cheek', 'bloom', 'bud', 'step', 'song', 'heart']],
    place: ['Flower', 'Hope', 'Blossom', 'Lost Hope', 'Bright Hope'],
  },
  accursed: {
    plain: ['the Accursed', 'the Damned', 'the Doomed', 'the Ill-Omened', 'the Cursed', 'the Godforsaken', 'the Hexed', 'the Unhallowed'],
    place: ['Bane', 'Curse', 'Shadow', 'Doom'],
    own: ['Curse', 'Bane'],
  },
};

/** Themes this module can name (ruler traits, deeds, posthumous marks). */
export const EPITHET_THEMES = Object.keys(T);

// how often each form is drawn (renormalised over the forms a theme and ruler allow)
const W = { plain: 0.06, adj: 0.05, by: 0.15, place: 0.15, pc: 0.12, own: 0.06, foe: 0.08, foeC: 0.1, tongue: 0.16, special: 0.1 };

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
/** 37 → "Thirty-Seven", 112 → "Hundred and Twelve" (1–999, title case). */
export function numberWords(n) {
  const v = Math.max(1, Math.min(999, Math.round(n)));
  const h = Math.floor(v / 100), r = v % 100;
  const low = r < 20 ? ONES[r] : TENS[Math.floor(r / 10)] + (r % 10 ? '-' + ONES[r % 10] : '');
  if (!h) return low;
  const hund = h === 1 ? 'Hundred' : `${ONES[h]} Hundred`;
  return low ? `${hund} and ${low}` : hund;
}

/** Candidate places of a realm, weighted: the capital, a deed's town, a great town, nearby land and water. */
function placesOf(world, civ, r, theme) {
  const out = [];
  const capS = civ.capitalId != null ? world.settlements[civ.capitalId] : null;
  if (capS && capS.alive) out.push([capS.name, 3]);
  const fl = r?.flags || {};
  if (theme === 'conquest' && fl.took) out.push([fl.took, 5]);
  if (theme === 'losses' && fl.lost) out.push([fl.lost, 5]);
  if (theme === 'builder' && fl.built) out.push([fl.built, 5]);
  if (theme === 'colonies' && fl.colony) out.push([fl.colony, 3]);
  let big = null;
  for (const id of civ.settlementIds || []) {
    const s = world.settlements[id];
    if (s && s.alive && s.id !== civ.capitalId && (!big || s.population > big.population)) big = s;
  }
  if (big) out.push([big.name, 1]);
  const x = capS ? capS.x : civ.originX, y = capS ? capS.y : civ.originY;
  const river = featureNameNear(world, x, y, 'river', 14);
  if (river) out.push([river.replace(/ River$/, ''), 1.4]);   // "the Shield of the Tiren"
  return out;
}
function pickW(world, list) {
  let tot = 0;
  for (const [, w] of list) tot += w;
  let x = world.rng.next() * tot;
  for (const [v, w] of list) { x -= w; if (x <= 0) return v; }
  return list[list.length - 1][0];
}

function joinBy(a, b) {
  const tail = b.toLowerCase();
  const word = /[aeiou]$/i.test(a) && /^[aeiou]/.test(tail) ? `${a}-${tail}` : a + tail;
  return word.replace(/(.)\1\1/g, '$1$1');
}

/** The foe a ruler beat (r.flags.foe), a live or remembered realm, or null. */
function foeOf(world, civ, r) {
  const id = r?.flags?.foe;
  const f = id != null ? world.civs[id] : null;
  return f && f.id !== civ.id && f.adjective ? f : null;
}

function special(world, civ, r, theme) {
  const days = Math.max(1, Math.round(world.time.day - (Number.isFinite(r?.reignStart) ? r.reignStart : world.time.day)));
  // the title's head noun: "High Chief" → Chief, "King of Kings" → King (hyphenated titles are left out)
  const tw = String(r?.title || '').split(' ');
  const head = tw.includes('of') ? tw[0] : tw[tw.length - 1];
  const title = head && !head.includes('-') ? head : '';
  switch (theme) {
    case 'brief':
      return pick(world, days <= 1 ? ['of a Single Day'] : [`of the ${numberWords(days)} Days`, `of the ${numberWords(days)} Days`,
        `the ${pick(world, ['Winter', 'Summer', 'Spring', 'Autumn'])} ${title || G(r, 'King|Queen')}`]);
    case 'young':
      return title ? `the ${G(r, 'Boy|Girl')}-${title}` : null;
    case 'famine':
      return pick(world, T.famine.of);
    case 'conquest':
      return r?.flags?.took ? pick(world, [`the Taker of ${r.flags.took}`, `the Conqueror of ${r.flags.took}`]) : null;
    case 'colonies': {
      const capS = civ.capitalId != null ? world.settlements[civ.capitalId] : null;
      const sea = capS ? seaNameNear(world, capS.x, capS.y, 40) : null;
      return sea ? `the ${G(r, pick(world, T.colonies.sea))} of ${sea}` : null;
    }
    case 'pious': {
      const faith = civ.stateReligion != null ? world.religions[civ.stateReligion] : null;
      const god = faith && typeof faith.deity === 'string' && faith.deity ? faith.deity : null;
      return god ? `the ${pick(world, T.pious.god)} of ${god}` : null;
    }
    default: return null;
  }
}

/** One draw of an epithet in a theme: { epithet, gloss } (gloss: the meaning of a tongue word). */
function draw(world, civ, r, theme) {
  const t = T[theme] || T.wise;
  const foe = foeOf(world, civ, r);
  const forms = [];
  if (t.plain) forms.push(['plain', W.plain]);
  if (t.adj || t.adjList) forms.push(['adj', W.adj]);
  if (t.by) forms.push(['by', W.by]);
  if (t.place) forms.push(['place', W.place]);
  if (t.pc) forms.push(['pc', W.pc]);
  if (t.own && !/ people$/.test(peopleOf(civ))) forms.push(['own', W.own]);
  if (t.foe && foe) forms.push(['foe', W.foe]);
  if (t.foeC && foe) forms.push(['foeC', W.foeC]);
  if (t.plain && civ.language) forms.push(['tongue', W.tongue]);
  if (theme === 'brief' || theme === 'young' || theme === 'famine' || (theme === 'conquest' && r?.flags?.took) || theme === 'colonies' || theme === 'pious') forms.push(['special', W.special]);
  const form = pickW(world, forms);
  switch (form) {
    case 'adj': {
      if (t.adjList && (!t.adj || world.rng.chance(0.5))) return { epithet: pick(world, t.adjList) };
      const [A, B] = pick(world, t.adj);
      return { epithet: `the ${pick(world, A)}-${pick(world, B)}` };
    }
    case 'by': {
      const pre = pick(world, t.by[0]);
      let post = G(r, pick(world, t.by[1]));
      if (post === pre.toLowerCase()) post = G(r, t.by[1][(t.by[1].indexOf(post) + 1) % t.by[1].length]);   // never "Shieldshield"
      return { epithet: joinBy(pre, post) };
    }
    case 'place': {
      const pl = placesOf(world, civ, r, theme);
      if (!pl.length) break;
      return { epithet: `the ${G(r, pick(world, t.place))} of ${pickW(world, pl)}` };
    }
    case 'pc': {
      const towns = placesOf(world, civ, r, theme).filter(([n]) => !/^the /.test(n) && !/[\s-]/.test(n));
      if (!towns.length) break;
      return { epithet: `the ${pickW(world, towns)}-${pick(world, t.pc)}` };
    }
    case 'own': return { epithet: `the ${G(r, pick(world, t.own))} of ${peopleOf(civ)}` };
    case 'foe': return { epithet: `the ${G(r, pick(world, t.foe))} of ${peopleOf(foe)}` };
    case 'foeC': return { epithet: `the ${foe.adjective}-${pick(world, t.foeC)}` };
    case 'tongue': {
      let w = null;
      for (let k = 0; k < 4 && !w; k++) { const c = makeWord(civ.language, world.rng, 2, 2).replace(/'/g, ''); if (c.length >= 4 && c.length <= 8 && !isEnglishWord(c)) w = cap(c); }
      if (!w) break;
      return { epithet: w, gloss: G(r, pick(world, t.plain)) };
    }
    case 'special': { const s = special(world, civ, r, theme); if (s) return { epithet: s }; break; }
    default: break;
  }
  return { epithet: G(r, pick(world, t.plain || T.wise.plain)) };
}

/**
 * A fresh epithet for ruler r of civ in a theme (trait key, deed or posthumous mark): never one
 * already borne in this realm when a few draws can avoid it. Returns { epithet, gloss|null }.
 */
export function epithetFor(world, civ, r, theme) {
  const used = new Set();
  for (const h of civ?.rulerHistory || []) if (h && h.epithet) used.add(h.epithet);
  let e = null;
  for (let k = 0; k < 4; k++) {
    e = draw(world, civ, r, theme);
    if (!used.has(e.epithet)) break;
  }
  return { epithet: e.epithet, gloss: e.gloss || null };
}
