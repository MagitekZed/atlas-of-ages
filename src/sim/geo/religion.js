// Religion (order 50): prophets, named faiths, spread, state religions, schisms and the
// death of faiths.
//
// Settlements begin with folk beliefs (s.religion = {}; the unassigned share is folk).
// Faith names are composed (faithName, schismName) from the doctrine's words, the era's
// institutions and the people's own words: its gods, saints, holy city, land and race.
// Prophets arise in large, cultured, mostly-folk towns (× params.religiosity × the civ's
// religiosity trait) and found a faith: a doctrine (sun worship, ancestor cult, monotheism,
// dualism, the Way…) plus two behavioural tenets that the geo systems honour —
//   militant → holy wars and conversion by the sword (war.js), pacifist → fewer wars,
//   tolerant → milder faith hatred (diplomacy.js), mercantile → richer routes and spread by
//   trade (trade.js), healing → lower plague mortality (disease.js), ascetic → calmer towns,
//   ancestral → loyal towns, hierarchical → eager state churches, proselytizing → faster
//   spread, mystic → schisms, monastic → stubborn converts, apocalyptic → plague panic.
// Every other month each settlement's shares relax toward the pressure from its own faithful,
// nearby towns, trade partners, the state church and holy cities (half the towns each month).
// Civs adopt state religions; big multi-nation faiths split in schisms; faiths with no
// followers for a year die. The chronicle marks a faith's spread across nations and the
// conversion of great cities. Prophets and schisms are scaled by the ext 'rates' keys
// 'prophet' and 'schism' (ages of faith, black swans).
//
// Hooks emitted: religionFounded(religion) for every new faith (schisms too), schism(child,
// parent). Chronicle keys 'faith.*' and 'divine.prophet' / 'divine.miracle', ref the faith.
// Exports: system, TENETS, DOCTRINES, faithOf, hasTenet, civHasTenet, boostFervor,
//          foundReligion(world, s, opts)

import { chronicle } from '../../core/chronicle.js';
import { on } from '../../core/hooks.js';
import { registerTool } from '../../core/tools.js';
import { liveSettlements, liveCivs, settlementsNear, addIndexed, addFigure } from '../../core/entities.js';
import { touchRecord } from '../../core/keyframe.js';
import { emitFx } from '../../core/world.js';
import { mulOf, hasProviders } from '../../core/ext.js';
import { makePerson, composeName, possessive, eraBand, raceWordsOf, terrainWordsAt, isEnglishWord, nameAdjective } from '../../core/names.js';
import { DAYS_PER_YEAR, DAYS_PER_MONTH } from '../../core/constants.js';
import { clamp01, hslToRgb, rgbToHex, dist, withArticle } from '../../core/util.js';
import {
  civById, civName, peopleOf, rulerName, rulerHas, fmtCount, fill, pickOne, rateOk, rateReady,
  eraOf, finite, routeAdjacency, capFirst, bare, spanPhrase, countWord, emitHook, nearestFeature,
} from './common.js';
import { prophetTarget, miracleTargets, prophetPreview, miraclePreview, toolLabel } from './previews.js';

const rate = (world, key) => (hasProviders('rates') ? mulOf('rates', world, key) : 1);

// ---------------------------------------------------------------------------
// Doctrine & tenet tables

export const TENETS = {
  militant: { label: 'militant', desc: 'Spreads by the sword; its rulers wage holy wars.' },
  pacifist: { label: 'pacifist', desc: 'Abhors bloodshed; its nations rarely start wars.' },
  tolerant: { label: 'tolerant', desc: 'Lives easily beside other faiths.' },
  mercantile: { label: 'mercantile', desc: 'Blesses commerce; travels with merchants.' },
  ascetic: { label: 'ascetic', desc: 'Prizes restraint; its towns are calm.' },
  ancestral: { label: 'ancestral', desc: 'Honours the dead; binds towns to their rulers.' },
  hierarchical: { label: 'hierarchical', desc: 'A church of bishops eager to crown kings.' },
  proselytizing: { label: 'proselytizing', desc: 'Preaches to all; spreads quickly.' },
  mystic: { label: 'mystic', desc: 'Seeks visions; prone to schism.' },
  monastic: { label: 'monastic', desc: 'Keeps its faithful close; slow to lose converts.' },
  healing: { label: 'healing', desc: 'Tends the sick; softens plagues.' },
  apocalyptic: { label: 'apocalyptic', desc: 'Awaits the end; plagues and wars inflame it.' },
};
const EXCLUSIVE = [['militant', 'pacifist'], ['militant', 'tolerant'], ['ascetic', 'mercantile'], ['proselytizing', 'monastic']];

// Faith names are composed (faithName below): forms × the doctrine's words (voc) × bodies fit for
// the era × the people's own words (its gods, holy city and land; in Mythic worlds its race).
//   adj / noun   "the Covenant of the {Golden} {Disc}"      attr   "the {Thunder} Cult of Oskel"
//   title        "the Faith of Vashti {the Mother}"         pl     "the Faith of the Seven {Stars}"
//   body         the institution: Church, Rite, Lodge …    nums   the numbers its lore counts in
//   forms        doctrine-only forms added to the common ones
export const DOCTRINES = [
  { key: 'sun', label: 'sun worship', minEra: 0, bias: { militant: 2, hierarchical: 2, proselytizing: 1 },
    voc: {
      adj: ['Undying', 'Golden', 'Radiant', 'Burning', 'Risen', 'Blazing', 'Unsetting', 'Brazen', 'Gilded', 'High', 'White', 'Eternal', 'Shining', 'Noonday'],
      noun: ['Sun', 'Disc', 'Eye', 'Flame', 'Dawn', 'Crown', 'Chariot', 'Wheel', 'Fire', 'Face', 'Lord', 'Hearth', 'Throne', 'Day'],
      attr: ['Sun', 'Dawn', 'Solar', 'Noon', 'Fire', 'Daybreak'], title: ['the Bright', 'the Radiant', 'the Sun-Lord', 'the Burning', 'the Dawnbringer', 'the Unsetting'],
      body: ['Church', 'Children', 'Rite', 'Temple', 'Host', 'Faith', 'Covenant', 'Order', 'Priesthood', 'Kindred'], pl: ['Suns', 'Fires', 'Dawns', 'Flames', 'Crowns', 'Rays'],
      forms: [[1, 'the Children of the {Noun}'], [0.8, 'the Dawn Rite of {place}']] } },
  { key: 'ancestors', label: 'ancestor cult', minEra: 0, bias: { ancestral: 4, tolerant: 1, monastic: 1 },
    voc: {
      adj: ['Elder', 'Honoured', 'Sleeping', 'Watching', 'First', 'Old', 'Grey', 'Remembered', 'Silent', 'Long', 'Deathless', 'Patient', 'Ever-Present', 'Hallowed'],
      noun: ['Fathers', 'Mothers', 'Ancestors', 'Grandsires', 'Dead', 'Elders', 'Bones', 'Hearth', 'Barrow', 'Line', 'Kin', 'Forebears', 'Ash', 'Cairn'],
      attr: ['Ancestral', 'Hearth', 'Barrow', 'Cairn', 'Bone', 'Grave'], title: ['the Ancestor', 'the First Father', 'the Old Mother', 'the Remembered', 'the Eldest'],
      body: ['Covenant', 'Remembrance', 'Rite', 'Way', 'Household', 'Kindred', 'Lodge', 'Vigil', 'Faith'], pl: ['Fathers', 'Mothers', 'Hearths', 'Barrows', 'Graves', 'Elders'],
      forms: [[1, 'the Hearth-Faith of {place}'], [0.8, 'the Way of the {Adj} {Noun}']] } },
  { key: 'spirits', label: 'nature spirits', minEra: 0, bias: { tolerant: 2, ascetic: 1, healing: 2 },
    voc: {
      adj: ['Green', 'Thousand', 'Whispering', 'Hidden', 'Wild', 'Old', 'Many', 'Dreaming', 'Deep', 'Wandering', 'Small', 'Living', 'Singing', 'Rustling'],
      noun: ['Spirits', 'Grove', 'Lodge', 'Wood', 'Stones', 'Waters', 'Beasts', 'Winds', 'Roots', 'Rivers', 'Antlers', 'Leaves', 'Totem', 'Spring'],
      attr: ['Spirit', 'Totem', 'Grove', 'Root', 'Beast', 'Green'], title: ['the Wild', 'the Many-Shaped', 'the Antlered', 'the Green Man', 'the Dreamer'],
      body: ['Lodges', 'Way', 'Circle', 'Rite', 'Kindred', 'Dance', 'Song', 'Faith'], pl: ['Spirits', 'Groves', 'Stones', 'Waters', 'Winds', 'Beasts'],
      forms: [[1.2, 'the Old Ways of {place}'], [1, 'the Spirit Lodges of {place}'], [0.6, 'the Old Ways of the {Adj} {Noun}']] } },
  { key: 'storm', label: 'storm gods', minEra: 0, bias: { militant: 3, apocalyptic: 1 },
    voc: {
      adj: ['Thundering', 'Black', 'Iron', 'Roaring', 'Striking', 'Wrathful', 'Howling', 'Grey', 'Riven', 'Hammering', 'Red', 'Wild', 'Rolling', 'Sky-Born'],
      noun: ['Storm', 'Hammer', 'Thunder', 'Sky', 'Lightning', 'Gale', 'Cloud', 'Spear', 'Bolt', 'Tempest', 'Ram', 'Axe', 'Rain', 'Eagle'],
      attr: ['Storm', 'Thunder', 'Sky', 'Lightning', 'Hammer', 'Tempest'], title: ['the Thunderer', 'the Storm-Lord', 'the Sky-Hammer', 'the Cloud-Rider', 'the Rain-Bringer', 'the Wrathful'],
      body: ['Cult', 'Wardens', 'Lords', 'Host', 'Rite', 'Brotherhood', 'Order', 'Faith'], pl: ['Storms', 'Hammers', 'Thunders', 'Skies', 'Winds', 'Spears'],
      forms: [[0.8, 'the Wardens of the {Noun}']] } },
  { key: 'mother', label: 'earth mother', minEra: 0, bias: { healing: 3, tolerant: 2, pacifist: 1 },
    voc: {
      adj: ['Bountiful', 'Green', 'Fruitful', 'Patient', 'Ripe', 'Deep', 'Generous', 'Golden', 'Nursing', 'Kindly', 'Abundant', 'Quiet', 'Full', 'Gentle'],
      noun: ['Mother', 'Harvest', 'Furrow', 'Sheaf', 'Womb', 'Earth', 'Field', 'Orchard', 'Seed', 'Bounty', 'Spring', 'Granary', 'Vine', 'Loam'],
      attr: ['Harvest', 'Earth', 'Sheaf', 'Seed', 'Furrow', 'Field'], title: ['the Mother', 'the Bountiful', 'the Giver', 'the Grain-Mother', 'the Earth-Queen', 'the Nurturer'],
      body: ['Covenant', 'Rite', 'Cult', 'Faith', 'Daughters', 'Sisterhood', 'Children', 'Household'], pl: ['Mothers', 'Harvests', 'Furrows', 'Sheaves', 'Fields', 'Seeds'],
      forms: [[0.8, "the {Adj} Mother's Covenant"]] } },
  { key: 'moon', label: 'moon cult', minEra: 0, bias: { mystic: 3, monastic: 1 },
    voc: {
      adj: ['Pale', 'Silver', 'Horned', 'Waning', 'Waxing', 'Hidden', 'Sleepless', 'White', 'Veiled', 'Silent', 'Thrice-Born', 'Cold', 'Full', 'Dreaming'],
      noun: ['Lady', 'Moon', 'Mirror', 'Night', 'Tide', 'Crescent', 'Huntress', 'Hare', 'Lantern', 'Pearl', 'Sister', 'Queen', 'Owl', 'Dew'],
      attr: ['Moon', 'Silver', 'Night', 'Crescent', 'Tide', 'Lantern'], title: ['the Pale', 'the Silver Lady', 'the Night-Queen', 'the Huntress', 'the Many-Faced', 'the Waning'],
      body: ['Cult', 'Rite', 'Covenant', 'Sisterhood', 'Order', 'Vigil', 'Faith', 'Mysteries'], pl: ['Moons', 'Mirrors', 'Nights', 'Tides', 'Lanterns', 'Sisters'] } },
  { key: 'pantheon', label: 'pantheon of heroes', minEra: 1, bias: { militant: 1, hierarchical: 1, mercantile: 1 },
    voc: {
      adj: ['Hundred', 'Twelve', 'Heroic', 'Many', 'High', 'Undying', 'Shining', 'Laurelled', 'Mountain', 'Feasting', 'Victorious', 'Elder', 'Golden', 'Mighty'],
      noun: ['Gods', 'Heroes', 'Thrones', 'Halls', 'Mountain', 'Feast', 'Court', 'Kin', 'Powers', 'Pantheon', 'Hearth', 'Assembly', 'Laurel', 'Banquet'],
      attr: ['Heroic', 'Hero', 'Temple', 'High', 'Laurel', 'Mountain'], title: ['and the Many', 'the Father of Gods', 'the High King', 'the Hero', 'the Victorious', 'the Wise'],
      body: ['Temple', 'Pantheon', 'Faith', 'Cult', 'Priesthood', 'Rites', 'Children'], pl: ['Gods', 'Heroes', 'Thrones', 'Halls', 'Powers', 'Kings'],
      forms: [[1, 'the Pantheon of {place}'], [0.7, 'the {Num} Gods of {place}']] } },
  { key: 'mystery', label: 'mystery cult', minEra: 1, bias: { mystic: 3, ascetic: 1 },
    voc: {
      adj: ['Veiled', 'Hidden', 'Secret', 'Sealed', 'Silent', 'Inner', 'Twice-Born', 'Nameless', 'Masked', 'Sleeping', 'Unspoken', 'Black', 'Burning', 'Seventh'],
      noun: ['Flame', 'Door', 'Key', 'Cup', 'Serpent', 'Seed', 'Mirror', 'Word', 'Mask', 'Grotto', 'Sign', 'Rose', 'Veil', 'Lamp'],
      attr: ['Veiled', 'Hidden', 'Grotto', 'Serpent', 'Mystery', 'Initiate'], title: ['the Hidden', 'the Veiled', 'the Twice-Born', 'the Unnamed', 'the Sleeper', 'the Keeper of Keys'],
      body: ['Mysteries', 'Cult', 'Initiates', 'Brotherhood', 'Circle', 'Rites', 'Order', 'Society'], pl: ['Keys', 'Doors', 'Cups', 'Seals', 'Masks', 'Veils'],
      forms: [[1.2, 'the {deity} Mysteries'], [1, 'the Mysteries of {place}']] } },
  { key: 'dualism', label: 'dualism', minEra: 2, bias: { militant: 2, proselytizing: 2, apocalyptic: 1 },
    voc: {
      adj: ['Twin', 'Twofold', 'Warring', 'Balanced', 'Divided', 'Bright', 'Dark', 'Opposed', 'Eternal', 'Bound', 'Mirrored', 'Riven'],
      noun: ['Flames', 'Thrones', 'Lights', 'Brothers', 'Powers', 'Scales', 'Wings', 'Faces', 'Fires', 'Princes', 'Spirits', 'Crowns'],
      attr: ['Dualist', 'Twin', 'Twofold', 'Two-Throne'], title: ['the Bright', 'the Just', 'the Lightbringer', 'the Lord of Day', 'the Truthful'],
      body: ['Faith', 'Church', 'Covenant', 'Doctrine', 'Order', 'Communion', 'Confession'], pl: ['Flames', 'Thrones', 'Lights', 'Powers', 'Brothers', 'Crowns'], nums: ['Two', 'Twin'],
      pairs: [['Light', 'Shadow'], ['Day', 'Night'], ['Fire', 'Ash'], ['Gold', 'Iron'], ['the Sun', 'the Serpent'], ['Truth', 'the Lie'], ['Flame', 'Frost'], ['Dawn', 'Dusk'],
        ['Order', 'Chaos'], ['the Wheat', 'the Tares'], ['the Lamp', 'the Dark'], ['Breath', 'Dust'], ['the Eagle', 'the Worm'], ['Honey', 'Gall']],
      forms: [[2, 'the Faith of {pairA} and {pairB}'], [1.2, 'the {deity}–{deity2} Dualism'], [0.8, 'the {Num} {Pl}'], [0.6, 'the {Body} of Saint {saint}']] } },
  { key: 'monotheism', label: 'monotheism', minEra: 2, bias: { proselytizing: 3, hierarchical: 2, militant: 1 },
    voc: {
      adj: ['One', 'Only', 'Living', 'True', 'Unseen', 'Almighty', 'Eternal', 'Merciful', 'Just', 'Most High', 'Hidden', 'Nameless', 'Holy', 'Undivided'],
      noun: ['God', 'Lord', 'Father', 'Throne', 'Name', 'Word', 'Law', 'Light', 'Shepherd', 'King', 'Judge', 'Creator', 'Mercy', 'Promise'],
      attr: ['Holy', 'True', 'Faithful', 'Righteous', 'Living', 'Merciful'], title: ['the One', 'the Most High', 'the Merciful', 'the Living God', 'the Almighty', 'the Just'],
      body: ['Church', 'Covenant', 'Faith', 'Communion', 'Brethren', 'Assembly', 'Congregation', 'House'], pl: ['Prophets', 'Names', 'Laws', 'Commandments', 'Words', 'Seals'],
      nums: ['Seven', 'Ten', 'Twelve', 'Three', 'Hundred'], forms: [[2, '{ism}'], [1, 'the Church of {deity} the One'], [0.9, 'the {Body} of Saint {saint}']] } },
  { key: 'stars', label: 'star lore', minEra: 2, bias: { monastic: 2, mystic: 1 },
    voc: {
      adj: ['Seven', 'Wandering', 'Fixed', 'Northern', 'Burning', 'Silent', 'Turning', 'Watching', 'High', 'Thousand', 'Fallen', 'Morning', 'Evening', 'Cold'],
      noun: ['Stars', 'Spheres', 'Heavens', 'Lamps', 'Watchers', 'Wheel', 'Crown', 'Vault', 'Eyes', 'Orrery', 'Signs', 'Hosts', 'Comet', 'Pole-Star'],
      attr: ['Star', 'Celestial', 'Astral', 'Heavenly', 'Sky', 'Comet'], title: ['the Watcher', 'the Star-Crowned', 'the Pole-Star', 'the Far-Seeing', 'the Lamplighter'],
      body: ['Order', 'Lore', 'Watchers', 'Faith', 'College', 'Observance', 'Brotherhood', 'Circle'], pl: ['Stars', 'Spheres', 'Lamps', 'Heavens', 'Signs', 'Wanderers'],
      forms: [[1, 'the Star Lore of {place}'], [0.8, 'the Watchers of {deity}']] } },
  { key: 'way', label: 'philosophy of the Way', minEra: 3, bias: { ascetic: 2, tolerant: 2, pacifist: 1, monastic: 1 },
    voc: {
      adj: ['Quiet', 'Middle', 'Narrow', 'Still', 'Empty', 'Gentle', 'Even', 'Open', 'Patient', 'Clear', 'Upright', 'Unhurried', 'Simple', 'Level'],
      noun: ['Way', 'Path', 'Balance', 'Mind', 'Water', 'Mean', 'Harmony', 'Stillness', 'Road', 'Gate', 'Ladder', 'Bowl', 'Breath', 'Return'],
      attr: ['Quiet', 'Middle', 'Inner', 'Stillness', 'Balance', 'Mountain'], title: ['the Teacher', 'the Sage', 'the Master', 'the Quiet One', 'the Ferryman'],
      body: ['Way', 'Path', 'Doctrine', 'School', 'Teaching', 'Discipline', 'Brotherhood', 'Hermitage'], pl: ['Paths', 'Gates', 'Steps', 'Virtues', 'Precepts', 'Rivers'],
      nums: ['Three', 'Five', 'Eight', 'Nine', 'Ten', 'Hundred'],
      forms: [[2, 'the Path of {prophet}'], [1.5, 'the Way of {place}'], [1.2, 'the {Adj} Way'], [1, 'the Teaching of {prophet}'], [1, 'the Doctrine of {Noun}']] } },
  { key: 'reason', label: 'rational deism', minEra: 5, bias: { tolerant: 3, mercantile: 2 },
    voc: {
      adj: ['Rational', 'Natural', 'Enlightened', 'Universal', 'Reasoned', 'Moral', 'Clear', 'Free', 'Humane', 'Modern', 'Benevolent', 'Lucid'],
      noun: ['Reason', 'Light', 'Clockmaker', 'Architect', 'Order', 'Law', 'Mind', 'Design', 'Watchmaker', 'Nature', 'Lamp', 'Compass'],
      attr: ['Deist', 'Rational', 'Enlightened', 'Natural', 'Philosophical', 'Humanist'], title: ['the Architect', 'the Clockmaker', 'the Prime Mover', 'the First Cause', 'the Great Geometer'],
      body: ['Church', 'Society', 'Fellowship', 'Assembly', 'Circle', 'Lyceum', 'Union', 'Congregation'], pl: ['Lights', 'Laws', 'Principles', 'Truths', 'Reasons', 'Lamps'],
      forms: [[0.4, 'the Church of {Noun}'], [1, 'the Society of {Adj} {Pl}'], [1, 'the Enlightened Way of {place}']] } },
];
const DOCTRINE_BY_LABEL = Object.fromEntries(DOCTRINES.map((d) => [d.label, d]));

const MAX_FAITHS = 16;
const SPREAD_DAY = 5;
const CONV_RATE = 0.06;

// ---------------------------------------------------------------------------
// Queries

export function faithOf(world, rid) {
  if (rid == null || rid < 0) return null;
  const r = world.religions[rid];
  return r && r.alive !== false ? r : null;
}
export function hasTenet(world, rid, t) {
  const r = faithOf(world, rid);
  return Boolean(r && Array.isArray(r.tenets) && r.tenets.includes(t));
}
/** True when the civ's state religion holds tenet t. */
export const civHasTenet = (world, civ, t) => Boolean(civ && hasTenet(world, civ.stateReligion, t));

/** Published: stir (or, with a negative amt, cool) the zeal of faith rid. */
export function boostFervor(world, rid, amt) {
  const r = faithOf(world, rid);
  if (r) r.fervor = clamp01((r.fervor || 0) + amt);
}

function state(world) {
  const st = (world.sys.religion ||= {});
  st.names ||= {};
  st.empty ||= {};
  st.founded ||= 0;
  st.schisms ||= 0;
  return st;
}

// ---------------------------------------------------------------------------
// Founding

function faithColor(world) {
  const used = world.religions.filter((r) => r.alive !== false).map((r) => r.hue ?? 0);
  let best = 0, bestScore = -1;
  for (let k = 0; k < 16; k++) {
    const h = world.rng.next() * 360;
    let minD = 360;
    for (const u of used) { let d = Math.abs(h - u); d = Math.min(d, 360 - d); if (d < minD) minD = d; }
    if (minD > bestScore) { bestScore = minD; best = h; }
  }
  const color = hslToRgb(best, 0.5 + world.rng.next() * 0.25, 0.55 + world.rng.next() * 0.1);
  return { hue: best, color, colorHex: rgbToHex(color) };
}

function pickTenets(world, doctrine, exclude = []) {
  const keys = Object.keys(TENETS);
  const out = [];
  for (let n = 0; n < 2; n++) {
    const w = keys.map((k) => {
      if (out.includes(k) || exclude.includes(k)) return 0;
      for (const [a, b] of EXCLUSIVE) if ((out.includes(a) && k === b) || (out.includes(b) && k === a)) return 0;
      return 1 + (doctrine.bias[k] || 0);
    });
    let total = 0; for (const x of w) total += x;
    let r = world.rng.next() * total;
    for (let i = 0; i < keys.length; i++) { if (r < w[i]) { out.push(keys[i]); break; } r -= w[i]; }
  }
  return out;
}

function ismOf(name) {
  const n = name.replace(/'/g, '');
  return (/[aeiouy]$/.test(n) ? n.slice(0, -1) : n) + 'ism';
}

// Forms every doctrine shares (weights); the doctrine adds its own (voc.forms).
const FAITH_FORMS = [
  [3, 'the {Body} of the {Adj} {Noun}'], [2.2, 'the {Attr} {Body} of {place}'], [2.2, 'the {Body} of {deity}'],
  [1.5, 'the {Body} of {deity} {Title}'], [1, '{deityPos} {Body}'], [1.2, 'the {Adj} {Noun}'], [1, 'the {Adj} {Body} of {region}'],
  [0.8, 'the {Body} of the {Num} {Pl}'], [0.9, 'the {people} {Body}'], [0.7, 'the {Body} of the {Noun} of {place}'], [0.6, 'the {Adj} {Noun} of {deity}'],
];
// the institutions a people of each era would found (merged with the doctrine's own), and those it would not
const ERA_BODIES = {
  tribal: ['Rite', 'Way', 'Circle', 'Lodge'], ancient: ['Cult', 'Temple', 'Mysteries', 'Priesthood'],
  medieval: ['Church', 'Order', 'Communion', 'Confession'], modern: ['Society', 'Fellowship', 'Assembly', 'Movement'],
};
const LATE_BODIES = {
  tribal: new Set(['Church', 'Order', 'Society', 'Fellowship', 'Assembly', 'Communion', 'Confession', 'Congregation', 'Union', 'Lyceum', 'College', 'Movement', 'Priesthood', 'Doctrine', 'School', 'Observance', 'Brethren']),
  ancient: new Set(['Society', 'Fellowship', 'Assembly', 'Union', 'Movement', 'Congregation', 'Confession']),
  medieval: new Set(['Society', 'Movement', 'Union', 'Fellowship']),
  modern: new Set(),
};
const NUMS = ['Three', 'Seven', 'Nine', 'Twelve', 'Hundred', 'Thousand'];

/**
 * A faith's name from its doctrine's words, the era's institutions and the people's own words:
 * its god (deity, deity2), prophet, holy city s and the land around it, its people and, in
 * Mythic worlds, its race. Several thousand outcomes per doctrine; draws world.rng.
 */
function faithName(world, s, civ, doctrine, era, w) {
  const rng = world.rng;
  const v = doctrine.voc;
  const band = eraBand(era);
  const late = LATE_BODIES[band];
  const body = [...v.body, ...ERA_BODIES[band]].filter((b, k, a) => !late.has(b) && a.indexOf(b) === k);
  let adj = v.adj, noun = v.noun;
  const race = raceWordsOf(civ);
  if (race && rng.chance(0.45)) { adj = adj.concat(race.adj); noun = noun.concat(race.noun); }
  const land = terrainWordsAt(world, s.i);
  if (land && rng.chance(0.35)) noun = noun.concat(land.noun);
  const region = nearestFeature(world, s.x, s.y, ['forest', 'range', 'lake', 'desert', 'river', 'island'], 10);
  const pair = v.pairs ? rng.pick(v.pairs) : null;
  const forms = v.forms ? FAITH_FORMS.concat(v.forms) : FAITH_FORMS;
  return composeName(rng, forms, {
    Body: body.length ? body : ['Faith'], Adj: adj, Noun: noun, Attr: v.attr, Title: v.title, Pl: v.pl, Num: v.nums || NUMS,
    place: s.name, deity: w.deity, deity2: w.deity2, deityPos: possessive(w.deity), prophet: w.prophet, ism: ismOf(w.prophet),
    region: region ? region.name.replace(/^The\s/, 'the ') : null, people: civ && civ.adjective && !isEnglishWord(civ.adjective) ? civ.adjective : null,
    pairA: pair && pair[0], pairB: pair && pair[1], saint: () => makePerson(civ ? civ.language : world.lang, rng),
  }) || `the Faith of ${w.deity}`;
}

function uniqueName(world, make) {
  const st = state(world);
  for (let k = 0; k < 8; k++) {
    const nm = make();
    if (!st.names[nm]) { st.names[nm] = 1; return nm; }
  }
  const nm = make();
  st.names[nm] = (st.names[nm] || 0) + 1;
  return `${nm} of ${world.rng.pick(['the East', 'the West', 'the North', 'the South', 'the Hills', 'the Coast'])}`;
}

// Schisms: a reforming word before the parent's name, or the seat, the people, or the reformer's own.
const SCHISM_MODS = {
  tribal: ['New', 'True', 'Old', 'Elder', 'Pure'],
  ancient: ['New', 'True', 'Old', 'Purified', 'Elder', 'Strict', 'Restored'],
  medieval: ['Reformed', 'Orthodox', 'True', 'Old', 'Purified', 'Restored', 'Strict', 'Primitive', 'Unbroken', 'Universal'],
  modern: ['Reformed', 'Open', 'Free', 'United', 'Awakened', 'Restored', 'Modern', 'Orthodox'],
};
const SCHISM_SEAT = ['Confession', 'Heresy', 'Reform', 'Rite', 'Observance', 'Communion', 'Dissent', 'Covenant', 'Synod', 'Schism'];
const SCHISM_BAND = ['Followers', 'Disciples', 'Brethren', 'Penitents', 'Seekers', 'Hearers', 'Companions', 'Children'];
const SCHISM_ITE = ['Brethren', 'Church', 'Rite', 'Heresy', 'Confession', 'Way', 'Communion'];

function schismName(world, parent, civ, seat, reformer, doctrine) {
  const band = eraBand(eraOf(civ));
  const pb = bare(parent.name);
  const long = pb.split(' ').length > 4;
  const adjOk = civ && civ.adjective && !isEnglishWord(civ.adjective);
  return composeName(world.rng, [
    [long ? 1.5 : 4, 'the {Mod} {pb}'], [adjOk ? 1.4 : 0, 'the {people} {Seat}'], [2.2, 'the {seat} {Seat}'], [1.4, '{ism}'],
    [1.4, 'the {Band} of {reformer}'], [1.1, 'the {ite} {Ite}'], [band === 'tribal' ? 0 : 0.9, 'the Free {Body} of {seat}'],
    [band === 'medieval' || band === 'modern' ? 0.8 : 0, 'the {High} Church of {seat}'],
  ], {
    Mod: SCHISM_MODS[band], pb, people: adjOk ? civ.adjective : null, Seat: SCHISM_SEAT, seat: seat.name, ism: ismOf(reformer),
    Band: SCHISM_BAND, reformer, ite: nameAdjective(reformer, 'ite'), Ite: SCHISM_ITE, Body: doctrine.voc.body, High: ['High', 'Low', 'Free', 'Old'],
  }) || `the Reformed ${pb}`;
}

/**
 * Published: found a new faith at settlement s. opts: { doctrine (key), tenets, parentId, name,
 * prophet, quiet, divine, cause (seq) }. Emits religionFounded. Returns the religion or null.
 */
export function foundReligion(world, s, opts = {}) {
  if (!s || !s.alive) return null;
  const st = state(world);
  const civ = civById(world, s.civId);
  const lang = civ ? civ.language : world.lang;
  const rng = world.rng;
  const era = eraOf(civ);
  let doctrine = opts.doctrine ? DOCTRINES.find((d) => d.key === opts.doctrine) : null;
  if (!doctrine) {
    const pool = DOCTRINES.filter((d) => d.minEra <= era);
    // prefer doctrines not already alive in the world
    const alive = new Set(world.religions.filter((r) => r.alive !== false).map((r) => r.doctrine));
    const w = pool.map((d) => (alive.has(d.key) ? 0.4 : 1.5) + (d.minEra === era ? 0.5 : 0));
    let total = 0; for (const x of w) total += x;
    let r = rng.next() * total;
    doctrine = pool[pool.length - 1];
    for (let i = 0; i < pool.length; i++) { if (r < w[i]) { doctrine = pool[i]; break; } r -= w[i]; }
  }
  const prophet = opts.prophet || makePerson(lang, rng);
  const deity = makePerson(lang, rng);
  let deity2 = makePerson(lang, rng);
  if (deity2 === deity) deity2 = deity + 'ar';
  const tenets = opts.tenets || pickTenets(world, doctrine);
  const name = opts.name || uniqueName(world, () => faithName(world, s, civ, doctrine, era, { deity, deity2, prophet }));
  const col = faithColor(world);
  const r = {
    id: -1, name, color: col.color, colorHex: col.colorHex, hue: col.hue,
    alive: true, foundedDay: world.time.day, endDay: null,
    holyCityId: s.id, founderCivId: s.civId,
    prophet, prophetId: null, deity,
    doctrine: doctrine.key,
    tenets: [doctrine.label, ...tenets],
    fervor: 0.85, parentId: opts.parentId ?? null,
    followers: 0, peakFollowers: 0, nations: 0, reach: 0,
  };
  addIndexed(world, 'religions', r);
  st.founded++;
  // the holy city converts at once
  const sh = s.religion || (s.religion = {});
  const take = 0.6;
  for (const k of Object.keys(sh)) sh[k] *= 1 - take;
  sh[r.id] = (sh[r.id] || 0) + take;
  normalise(sh);
  s.dominantReligion = r.id;
  r.followers = s.population * (sh[r.id] || 0);
  const fig = addFigure(world, { name: prophet, kind: 'prophet', civId: s.civId, sid: s.id, born: world.time.day - Math.round((25 + rng.next() * 25) * DAYS_PER_YEAR), deeds: [`founded ${name}`] });
  r.prophetId = fig.id;
  emitFx(world, { type: 'faith', x: s.x, y: s.y, color: r.colorHex, ...(opts.divine ? { src: 'tool' } : {}) });
  if (!opts.quiet) {
    const nth = world.religions.filter((x) => x.parentId == null).length;
    const t2 = tenets.map((t) => TENETS[t].label);
    const text = opts.divine
      ? pickOne(world, [
        `A voice from heaven called ${prophet} of ${s.name}, who rose to preach ${name}.`,
        `Touched by a power beyond the world, ${prophet} of ${s.name} founded ${name}.`,
      ])
      : pickOne(world, [
        `The prophet ${prophet} began to preach in ${s.name}, and from the ${doctrine.label} of the hills grew ${name}, ${withArticle(t2[0])} and ${t2[1]} faith.`,
        `In ${s.name} the prophet ${prophet} spoke of ${deity}, and those who listened became ${name}.`,
        `${prophet} of ${s.name} gathered disciples around a new teaching; history would know it as ${name}.`,
        `Visions came to ${prophet}, a ${rng.pick(['shepherd', 'potter', 'scribe', 'weaver', 'fisher', 'widow', 'soldier', 'beggar'])} of ${s.name}, and ${name} was born of them.`,
      ]);
    const firstFaith = nth === 1 ? ' It was the first faith of the world to outgrow the gods of a single people.' : '';
    const e = chronicle(world, {
      // the world's first faith is one milestone (imp 4), whichever system writes it (the early
      // deck's shaman faith is imp 4 too)
      cat: opts.divine ? 'divine' : 'religion', imp: nth <= 3 ? 4 : 3, text: fixDoctrine(text, doctrine) + firstFaith, x: s.x, y: s.y, civId: s.civId, sid: s.id, icon: 'faith',
      key: opts.divine ? 'divine.prophet' : 'faith.founded', ref: { k: 'religion', id: r.id }, ...(opts.cause != null ? { cause: opts.cause } : {}), tags: [doctrine.key],
    });
    r.seq = e.seq;
  }
  emitHook(world, 'religionFounded', r);
  return r;
}

// "from the sun worship of the hills" reads well only for folk-rooted doctrines
function fixDoctrine(text, d) {
  if (['sun', 'ancestors', 'spirits', 'storm', 'mother', 'moon'].includes(d.key)) return text;
  return text.replace(`from the ${d.label} of the hills grew `, `there arose `);
}

function normalise(sh) {
  let total = 0;
  for (const k of Object.keys(sh)) {
    const v = sh[k];
    if (!finite(v) || v < 0.01) { delete sh[k]; continue; }
    total += v;
  }
  if (total > 1) for (const k of Object.keys(sh)) sh[k] /= total;
}

// ---------------------------------------------------------------------------
// Monthly spread

function spreadFactor(r) {
  let f = 0.5 + (r.fervor || 0);
  const t = r.tenets || [];
  if (t.includes('proselytizing')) f *= 1.6;
  if (t.includes('mystic')) f *= 0.85;
  return f;
}

/**
 * Flat [id, proximity, id, proximity, …] list of towns within 8 tiles (world.cache, rebuilt
 * yearly and whenever a settlement is founded, transferred or lost — a list kept from before
 * would differ in a world reloaded since; destroyed ones are also skipped on read).
 */
function neighbours(world, s) {
  const year = Math.floor(world.time.day / DAYS_PER_YEAR);
  const v = world.versions.settlements || 0;
  let c = world.cache.faithNb;
  if (!c || c.year !== year || c.v !== v) c = world.cache.faithNb = { year, v, map: new Map() };
  let list = c.map.get(s.id);
  if (!list) {
    list = [];
    for (const n of settlementsNear(world, s.x, s.y, 8)) if (n !== s) list.push(n.id, 1 / (1 + dist(s.x, s.y, n.x, n.y) / 3));
    c.map.set(s.id, list);
  }
  return list;
}

function spread(world, st) {
  const towns = liveSettlements(world);
  const T = towns.length;
  if (!T) return;
  const adj = routeAdjacency(world);
  const rels = world.religions;
  const R = rels.length;
  if (!R) return;
  const rp = world.params.religiosity ?? 1;
  // Half the towns are visited each month (alternating), each taking two months' step.
  const r1 = Math.min(0.5, CONV_RATE * Math.sqrt(Math.max(0.05, rp)));
  const rate = 1 - (1 - r1) * (1 - r1);
  const parity = Math.floor(world.time.day / DAYS_PER_MONTH) & 1;
  // per-faith constants
  const sf = new Float64Array(R), merc = new Float64Array(R);
  for (let r = 0; r < R; r++) {
    const f = rels[r];
    if (!f || f.alive === false) continue;
    sf[r] = spreadFactor(f);
    merc[r] = Array.isArray(f.tenets) && f.tenets.includes('mercantile') ? 2 : 1;
  }
  // holy cities
  const holy = new Map();
  for (let r = 0; r < R; r++) {
    const f = rels[r];
    if (!sf[r] || f.holyCityId == null) continue;
    let l = holy.get(f.holyCityId);
    if (!l) holy.set(f.holyCityId, (l = []));
    l.push(r);
  }
  // compact snapshot of every town's living-faith shares (one property walk per town)
  const kOf = new Int32Array(world.settlements.length).fill(-1);
  const start = new Int32Array(T + 1), sum = new Float64Array(T), rootP = new Float64Array(T);
  const ids = [], vals = [];
  for (let k = 0; k < T; k++) {
    const s = towns[k];
    kOf[s.id] = k;
    start[k] = ids.length;
    rootP[k] = Math.sqrt(Math.max(1, s.population));
    const sh = s.religion;
    let tot = 0;
    if (sh) for (const key in sh) {
      const rid = +key, v = sh[key];
      if (!(rid >= 0 && rid < R) || !sf[rid] || !(v > 0)) continue;
      ids.push(rid); vals.push(v); tot += v;
    }
    sum[k] = tot;
  }
  start[T] = ids.length;
  // accumulators reused for every town
  const P = new Float64Array(R), O = new Float64Array(R);
  const mark = new Uint8Array(R), touched = new Int32Array(R);
  const next = new Array(T);
  for (let k = 0; k < T; k++) {
    const s = towns[k];
    if ((s.id & 1) !== parity) { next[k] = null; continue; }
    let nt = 0, rid = 0;
    const domR = faithOf(world, s.dominantReligion);
    const inertia = domR && (domR.tenets.includes('monastic') || domR.tenets.includes('ancestral')) ? 1.35 : 1;
    // own faithful (P/O are reset lazily the first time a faith is touched for this town)
    for (let e = start[k], e1 = start[k + 1]; e < e1; e++) {
      rid = ids[e];
      if (!mark[rid]) { mark[rid] = 1; touched[nt++] = rid; P[rid] = 0; }
      P[rid] += vals[e] * inertia;
      O[rid] = vals[e];
    }
    let F = Math.max(0, 1 - sum[k]);
    const sp = rootP[k];
    // neighbours
    const nb = neighbours(world, s);
    for (let q = 0; q < nb.length; q += 2) {
      const kn = kOf[nb[q]];
      if (kn < 0) continue;
      const np = rootP[kn];
      const w = 0.3 * np / (sp + np) * nb[q + 1] * (towns[kn].civId === s.civId ? 1 : 0.5);
      for (let e = start[kn], e1 = start[kn + 1]; e < e1; e++) {
        rid = ids[e];
        if (!mark[rid]) { mark[rid] = 1; touched[nt++] = rid; P[rid] = 0; O[rid] = 0; }
        P[rid] += w * vals[e] * sf[rid];
      }
      F += w * Math.max(0, 1 - sum[kn]) * 0.6;
    }
    // trade partners
    const routes = adj.get(s.id);
    if (routes) for (const r of routes) {
      const kn = kOf[r.aId === s.id ? r.bId : r.aId];
      if (!(kn >= 0)) continue;
      for (let e = start[kn], e1 = start[kn + 1]; e < e1; e++) {
        rid = ids[e];
        if (!mark[rid]) { mark[rid] = 1; touched[nt++] = rid; P[rid] = 0; O[rid] = 0; }
        P[rid] += 0.18 * merc[rid] * vals[e] * sf[rid];
      }
    }
    // the state church and holy-city pull
    const civ = civById(world, s.civId);
    const sr = civ ? faithOf(world, civ.stateReligion) : null;
    const extra = (r0, v) => { if (!mark[r0]) { mark[r0] = 1; touched[nt++] = r0; P[r0] = 0; O[r0] = 0; } P[r0] += v; };
    if (sr && sr.id < R) {
      const tol = civ.traits ? civ.traits.tolerance || 0 : 0;
      extra(sr.id, 0.15 * (sr.tenets.includes('hierarchical') ? 1.6 : 1) * (0.5 + (civ.traits?.religiosity ?? 0.5)) * (1 - 0.5 * tol));
    }
    const hs = holy.get(s.id);
    if (hs) for (const h of hs) extra(h, sr && sr.id !== h ? 0.35 : 1.2);
    let total = F;
    for (let t = 0; t < nt; t++) total += P[touched[t]];
    const out = {};
    if (total > 0) {
      for (let t = 0; t < nt; t++) {
        rid = touched[t];
        const v = (1 - rate) * O[rid] + rate * P[rid] / total;
        if (v >= 0.01) out[rid] = v;
      }
      normalise(out);
    } else {
      for (let e = start[k]; e < start[k + 1]; e++) out[ids[e]] = vals[e];
    }
    for (let t = 0; t < nt; t++) mark[touched[t]] = 0;
    next[k] = out;
  }
  for (let k = 0; k < T; k++) if (next[k]) towns[k].religion = next[k];
}

// Followers, dominant faith, per-civ shares; returns { [civId]: { pop, by: { rid: people } } }.
function tally(world) {
  const rels = world.religions;
  const R = rels.length;
  const civsOf = new Array(R);          // rid → Map(civId → followers), local scratch
  for (let r = 0; r < R; r++) if (rels[r].alive !== false) { rels[r].followers = 0; civsOf[r] = new Map(); }
  const byCiv = {};
  let worldPop = 0;
  for (const s of liveSettlements(world)) {
    const pop = Math.max(0, s.population || 0);
    worldPop += pop;
    let best = null, bestV = 0, sum = 0;
    const sh = s.religion || {};
    const cv = (byCiv[s.civId] ||= { pop: 0, by: {} });
    cv.pop += pop;
    for (const key in sh) {
      const rid = +key;
      const r = rels[rid];
      const v = sh[key];
      if (!r || r.alive === false) { delete sh[key]; continue; }
      sum += v;
      const n = pop * v;
      r.followers += n;
      const m = civsOf[rid];
      m.set(s.civId, (m.get(s.civId) || 0) + n);
      cv.by[key] = (cv.by[key] || 0) + n;
      if (v > bestV) { bestV = v; best = rid; }
    }
    const dom = best != null && bestV >= 0.2 && bestV >= 1 - sum ? best : null;
    if (dom !== s.dominantReligion && dom != null && s.dominantReligion != null && (s.tier || 0) >= 4) conversionNote(world, s, s.dominantReligion, dom);
    s.dominantReligion = dom;
  }
  for (let rid = 0; rid < R; rid++) {
    const r = rels[rid];
    if (r.alive === false) continue;
    r.followers = Math.round(r.followers);
    if (r.followers > r.peakFollowers) { r.peakFollowers = r.followers; r.peakDay = world.time.day; }
    let nations = 0;
    for (const v of civsOf[rid].values()) if (v > 200) nations++;
    r.nations = nations;
    milestones(world, r, worldPop);
  }
  return byCiv;
}

/** A great city changes its faith (rate-limited per city and worldwide). */
function conversionNote(world, s, fromId, toId) {
  const a = faithOf(world, fromId), b = faithOf(world, toId);
  if (!a || !b || !rateReady(world, `conv${s.id}`, 60 * DAYS_PER_YEAR) || !rateOk(world, 'conv', 3 * DAYS_PER_YEAR)) return;
  rateOk(world, `conv${s.id}`, 60 * DAYS_PER_YEAR);
  const civ = civById(world, s.civId);
  const forced = civ && civ.stateReligion === toId;
  const text = forced
    ? pickOne(world, [
      `Under the pressure of the priests of ${civName(civ)}, most of ${s.name} forsook ${a.name} for ${b.name}.`,
      `The old temples of ${a.name} in ${s.name} stood empty as the city went over to ${b.name}, the faith of its rulers.`,
    ])
    : pickOne(world, [
      `Preachers of ${b.name} won over the people of ${s.name}, long a stronghold of ${a.name}.`,
      `In ${s.name} the faithful of ${b.name} came to outnumber those of ${a.name}.`,
    ]);
  chronicle(world, { cat: 'religion', imp: 2, text, x: s.x, y: s.y, civId: s.civId, sid: s.id, icon: 'faith', key: 'faith.convert', ref: { k: 'religion', id: b.id } });
}

/** Chronicle a faith's rise the first time it crosses each threshold of reach. */
function milestones(world, r, worldPop) {
  const share = worldPop > 0 ? r.followers / worldPop : 0;
  const lvl = share >= 0.5 && r.nations >= 4 ? 3 : share >= 0.25 && r.nations >= 3 ? 2 : share >= 0.1 && r.nations >= 2 ? 1 : 0;
  if (!(lvl > (r.reach || 0))) return;
  r.reach = lvl;
  if (worldPop < 20000) return;                       // a village faith in an empty world is no news
  const hc = world.settlements[r.holyCityId];
  const n = countWord(r.nations);
  const text = lvl === 3
    ? pickOne(world, [
      `${capFirst(r.name)} had become the faith of half the world, worshipped in ${n} nations from ${hc ? hc.name : 'its holy city'} to the farthest coasts.`,
      `More souls now prayed in the manner of ${r.name} than in all other faiths together.`,
    ])
    : lvl === 2
      ? pickOne(world, [
        `${capFirst(r.name)} was now the creed of a quarter of humankind, preached in ${n} nations.`,
        `From ${hc ? hc.name : 'its holy city'} the teaching of ${r.name} had spread to ${n} nations; one soul in four now followed it.`,
      ])
      : pickOne(world, [
        `${capFirst(r.name)} spread beyond the land of its birth, gaining followers in ${n} nations.`,
        `Missionaries carried ${r.name} far from ${hc ? hc.name : 'its first temples'}; it was now professed in ${n} nations.`,
      ]);
  chronicle(world, { cat: 'religion', imp: lvl === 3 ? 5 : lvl + 1, text, x: hc ? hc.x : null, y: hc ? hc.y : null, civId: r.founderCivId, sid: hc ? hc.id : null, icon: 'faith', key: 'faith.reach', ref: { k: 'religion', id: r.id }, ...(r.seq != null ? { cause: r.seq } : {}) });
}

// ---------------------------------------------------------------------------
// State religions

function stateReligions(world, byCiv) {
  const rng = world.rng;
  for (const civ of liveCivs(world)) {
    const cv = byCiv[civ.id];
    if (!cv || !(cv.pop > 0)) continue;
    let best = null, bestV = 0;
    for (const key in cv.by) if (cv.by[key] > bestV) { bestV = cv.by[key]; best = +key; }
    const bestShare = bestV / cv.pop;
    const cur = faithOf(world, civ.stateReligion);
    if (civ.stateReligion != null && !cur) civ.stateReligion = null;
    const pious = rulerHas(civ, 'pious') || civ.government === 'theocracy';
    const relig = (civ.traits?.religiosity ?? 0.5) * (world.params.religiosity ?? 1);
    if (!cur) {
      if (best == null) continue;
      const need = pious ? 0.2 : 0.35;
      const hier = hasTenet(world, best, 'hierarchical') ? 1.6 : 1;
      if (bestShare >= need && rng.chance(0.06 * (0.4 + relig) * hier)) adopt(world, civ, best, null);
    } else {
      const curShare = (cv.by[cur.id] || 0) / cv.pop;
      // (a faith imposed at a peace is kept while the truce lasts: imposeFaith)
      const held = finite(civ.flags.faithHeld) && civ.flags.faithHeld > world.time.day;
      if (best != null && best !== cur.id && curShare < 0.12 && bestShare >= 0.45 && !held && rng.chance(0.05 * (0.5 + relig))) adopt(world, civ, best, cur);
    }
  }
}

/**
 * A peace makes rid the state faith of civ (war.js, a holy war's terms). Its towns keep their
 * own faiths and follow slowly; the crown keeps the imposed faith at least `years` (the truce).
 * The treaty line tells of it. Returns true when the faith changed.
 */
export function imposeFaith(world, civ, rid, years = 10) {
  if (!civ || !faithOf(world, rid) || civ.stateReligion === rid) return false;
  civ.stateReligion = rid;
  civ.flags.faithHeld = world.time.day + Math.round(years * DAYS_PER_YEAR);
  return true;
}

function adopt(world, civ, rid, old) {
  const r = faithOf(world, rid);
  if (!r) return;
  civ.stateReligion = rid;
  const who = rulerName(civ);
  const cap = civ.capitalId != null ? world.settlements[civ.capitalId] : null;
  let text;
  if (old) {
    text = pickOne(world, [
      `${who || `The rulers of ${civName(civ)}`} forsook ${old.name} for ${r.name}, and the old temples of ${civName(civ)} were given to new priests.`,
      `${capFirst(civName(civ))} turned from ${old.name} to ${r.name}${who ? ` under ${who}` : ''}.`,
    ]);
  } else {
    text = pickOne(world, [
      `${who || `The rulers of ${civName(civ)}`} embraced ${r.name}, making it the creed of the realm.`,
      `${capFirst(civName(civ))} took ${r.name} as its state faith${cap ? `, raising a great temple in ${cap.name}` : ''}.`,
      `${who ? `${who} of ${civName(civ)}` : `The court of ${civName(civ)}`} was ${r.doctrine === 'monotheism' || r.doctrine === 'dualism' ? 'baptised' : 'initiated'} into ${r.name}, and ${peopleOf(civ)} followed.`,
    ]);
  }
  chronicle(world, { cat: 'religion', imp: 3, text, x: cap ? cap.x : null, y: cap ? cap.y : null, civId: civ.id, sid: cap ? cap.id : null, icon: 'faith', key: 'faith.adopted', ref: { k: 'religion', id: r.id } });
  if (cap) emitFx(world, { type: 'faith', x: cap.x, y: cap.y, color: r.colorHex });
}

// ---------------------------------------------------------------------------
// Prophets

function prophets(world, st) {
  const rng = world.rng;
  const rp = world.params.religiosity ?? 1;
  if (!(rp > 0)) return;
  const alive = world.religions.reduce((n, r) => n + (r.alive !== false ? 1 : 0), 0);
  if (alive >= MAX_FAITHS) return;
  // the first great faiths come quickly once villages settle; each new one makes the next rarer
  const crowd = (alive ? 1 : 2) / (1 + alive / 3);
  const mul = rate(world, 'prophet');
  if (!(mul > 0)) return;
  for (const s of liveSettlements(world)) {
    if ((s.tier || 0) < 1 || s.population < 200) continue;
    const civ = civById(world, s.civId);
    if (!civ) continue;
    let sum = 0;
    for (const k in s.religion || {}) sum += s.religion[k];
    const folk = Math.max(0, 1 - sum);
    if (folk < 0.25) continue;
    const temple = s.buildings && (s.buildings.temple || s.buildings.shrine) ? 1.5 : 1;
    const cultured = Math.min(3, Math.max(0.3, (finite(s.culture) ? s.culture : 0) / 120 + 0.15 * ((s.tier || 1) - 1)));
    const pious = rulerHas(civ, 'pious') ? 1.4 : 1;
    const p = 5e-5 * rp * (0.3 + (civ.traits?.religiosity ?? 0.5)) * cultured * folk * folk * temple * crowd * pious * mul;
    if (rng.chance(p)) { foundReligion(world, s); return; }
  }
}

// ---------------------------------------------------------------------------
// Fervor, tenet effects, holy cities, deaths

function upkeep(world, st, byCiv) {
  const rng = world.rng;
  for (const r of world.religions) {
    if (r.alive === false) continue;
    const t = r.tenets || [];
    const base = 0.35 + (t.includes('militant') ? 0.12 : 0) + (t.includes('apocalyptic') ? 0.12 : 0) + (t.includes('proselytizing') ? 0.08 : 0);
    r.fervor = clamp01((r.fervor || 0) + (base - r.fervor) * 0.012);
    // a lost holy city is replaced by the faith's greatest remaining town
    const hc = world.settlements[r.holyCityId];
    if (!hc || !hc.alive) {
      let best = null, bv = 0;
      for (const s of liveSettlements(world)) {
        const v = (s.religion?.[r.id] || 0) * s.population;
        if (v > bv) { bv = v; best = s; }
      }
      if (best) {
        const old = hc ? hc.name : 'the old holy city';
        r.holyCityId = best.id;
        if (r.followers > 1000) chronicle(world, { cat: 'religion', imp: 2, text: pickOne(world, [`With ${old} lost, the faithful of ${r.name} made ${best.name} their new holy city.`, `The relics of ${r.name} were carried from ${old} to ${best.name}, its new holy city.`]), x: best.x, y: best.y, civId: best.civId, sid: best.id, icon: 'faith', key: 'faith.holycity', ref: { k: 'religion', id: r.id } });
      }
    }
    // death
    if (r.followers < 30) st.empty[r.id] = (st.empty[r.id] || 0) + 1; else delete st.empty[r.id];
    if ((st.empty[r.id] || 0) >= 12) killFaith(world, st, r);
  }
  // tenet effects on the towns a faith dominates
  for (const s of liveSettlements(world)) {
    const r = faithOf(world, s.dominantReligion);
    if (!r) continue;
    const t = r.tenets;
    if (t.includes('ascetic')) s.unrest = clamp01((s.unrest || 0) - 0.01);
    if (t.includes('ancestral')) s.loyalty = clamp01((s.loyalty ?? 0.8) + 0.004);
    if (t.includes('apocalyptic') && s.disease) s.unrest = clamp01((s.unrest || 0) + 0.01);
  }
  for (const civ of liveCivs(world)) {
    const r = faithOf(world, civ.stateReligion);
    if (r && r.tenets.includes('hierarchical') && finite(civ.legitimacy)) civ.legitimacy = clamp01(civ.legitimacy + 0.002);
  }
}

function killFaith(world, st, r) {
  r.alive = false;
  r.endDay = world.time.day;
  r.followers = 0;
  delete st.empty[r.id];
  for (const civ of world.civs) if (civ.stateReligion === r.id) { civ.stateReligion = null; touchRecord(world, civ); }   // (fallen realms too)
  for (const s of world.settlements) if (s && s.religion && s.religion[r.id] != null) delete s.religion[r.id];
  const hc = world.settlements[r.holyCityId];
  const big = r.peakFollowers > 50000;
  const text = pickOne(world, [
    `The last followers of ${r.name} passed away; the faith that had once ${big ? `held ${fmtCount(r.peakFollowers)} souls` : 'burned in ' + (hc ? hc.name : 'its holy city')} was remembered only in ruins.`,
    `${capFirst(r.name)} died out after ${spanPhrase(r.endDay - r.foundedDay)}, its shrines ${big ? 'turned to the use of other gods' : 'abandoned to the wind'}.`,
    `No one was left to keep the rites of ${r.name}; its prayers were forgotten.`,
  ]);
  chronicle(world, { cat: 'religion', imp: big ? 3 : 2, text, x: hc ? hc.x : null, y: hc ? hc.y : null, civId: r.founderCivId, sid: hc ? hc.id : null, icon: 'faith', key: 'faith.dead', ref: { k: 'religion', id: r.id } });
}

// ---------------------------------------------------------------------------
// Yearly: schisms and the deaths of prophets

function schisms(world, st) {
  const rng = world.rng;
  const rp = world.params.religiosity ?? 1;
  const alive = world.religions.filter((r) => r.alive !== false);
  const mul = rate(world, 'schism');
  if (alive.length >= MAX_FAITHS || !(rp > 0) || !(mul > 0)) return;
  for (const r of alive) {
    const age = (world.time.day - r.foundedDay) / DAYS_PER_YEAR;
    if (age < 120 || r.followers < 15000 || (r.nations || 0) < 2) continue;
    if (r.lastSchismDay != null && world.time.day - r.lastSchismDay < 90 * DAYS_PER_YEAR) continue;
    const t = r.tenets;
    let p = 0.008 * rp * mul * (t.includes('mystic') ? 2 : 1) * (t.includes('hierarchical') ? 0.65 : 1) * (1 + ((r.nations || 2) - 2) * 0.35) * (0.6 + r.fervor) * (alive.length > 10 ? 0.4 : 1);
    if (!rng.chance(p)) continue;
    schism(world, st, r);
    return;
  }
}

function schism(world, st, parent) {
  const rng = world.rng;
  const hc = world.settlements[parent.holyCityId];
  // the breakaway region: a nation holding the faith, other than the holy city's
  const cands = [];
  for (const civ of liveCivs(world)) {
    if (hc && civ.id === hc.civId) continue;
    const towns = civ.settlementIds.map((id) => world.settlements[id]).filter((s) => s && s.alive && (s.religion?.[parent.id] || 0) > 0.3);
    if (!towns.length) continue;
    const d = hc ? dist(hc.x, hc.y, towns[0].x, towns[0].y) : 10;
    cands.push({ civ, towns, w: towns.length * (1 + d / 30) * (civ.stateReligion === parent.id ? 2 : 1) });
  }
  if (!cands.length) return;
  let total = 0; for (const c of cands) total += c.w;
  let x = rng.next() * total, pick = cands[0];
  for (const c of cands) { if (x < c.w) { pick = c; break; } x -= c.w; }
  const { civ, towns } = pick;
  towns.sort((a, b) => b.population - a.population);
  const seat = towns[0];
  const reformer = makePerson(civ.language, rng);
  const doctrine = DOCTRINES.find((d) => d.key === parent.doctrine) || DOCTRINES[0];
  const keep = parent.tenets.slice(1);
  const drop = rng.pick(keep);
  const kept = keep.filter((k) => k !== drop);
  const fresh = pickTenets(world, doctrine, [...keep]).filter((k) => !EXCLUSIVE.some(([a, b]) => (kept.includes(a) && k === b) || (kept.includes(b) && k === a)));
  const tenets = [...kept, fresh[0] || 'mystic'].slice(0, 2);
  const name = uniqueName(world, () => schismName(world, parent, civ, seat, reformer, doctrine));
  const child = foundReligion(world, seat, { doctrine: doctrine.key, tenets, parentId: parent.id, name, prophet: reformer, quiet: true });
  if (!child) return;
  st.schisms++;
  parent.lastSchismDay = world.time.day;
  child.fervor = 0.9;
  parent.fervor = clamp01(parent.fervor + 0.1);
  for (const s of towns) {
    const sh = s.religion;
    const v = sh[parent.id] || 0;
    const moved = v * (0.5 + rng.next() * 0.3);
    sh[parent.id] = v - moved;
    sh[child.id] = (sh[child.id] || 0) + moved;
    normalise(sh);
  }
  const ruler = rulerName(civ);
  let sided = false;
  if (civ.stateReligion === parent.id && rng.chance(0.7)) { civ.stateReligion = child.id; sided = true; }
  const fig = world.figures.find((f) => f.id === child.prophetId);
  if (fig) fig.deeds = [`led the schism that founded ${name}`];
  const pron = rng.chance(0.4) ? 'her' : 'his';
  const text = pickOne(world, [
    `The preacher ${reformer} of ${seat.name} denounced the corruption of ${parent.name}; ${sided ? `${ruler || `the court of ${civName(civ)}`} took the reformers' side, and` : `${pron} followers broke away and`} ${name} was born.`,
    `${capFirst(parent.name)} split in two when the faithful of ${civName(civ)} rejected the priests of ${hc ? hc.name : 'the old holy city'} and followed ${reformer} into ${name}.`,
    `In the Great Schism of ${seat.name}, ${reformer} broke with ${parent.name}${sided ? `, and ${civName(civ)} embraced ${name}` : `, founding ${name}`}.`,
  ]);
  const e = chronicle(world, { cat: 'religion', imp: 3, text, x: seat.x, y: seat.y, civId: civ.id, sid: seat.id, icon: 'faith', key: 'faith.schism', ref: { k: 'religion', id: child.id }, ...(parent.seq != null ? { cause: parent.seq } : {}) });
  child.seq = e.seq;
  emitHook(world, 'schism', child, parent);
}

function prophetDeaths(world) {
  for (const f of world.figures) {
    if (f.kind !== 'prophet' || f.died != null || !finite(f.born)) continue;
    const age = (world.time.day - f.born) / DAYS_PER_YEAR;
    if (age < 55 || !world.rng.chance(0.08 + (age - 55) * 0.02)) continue;
    f.died = world.time.day;
    const r = world.religions.find((x) => x.prophetId === f.id);
    if (r && r.alive !== false && r.followers > 2000 && rateOk(world, `pdeath${r.id}`, DAYS_PER_YEAR)) {
      const s = world.settlements[f.sid];
      chronicle(world, {
        cat: 'religion', imp: 2, icon: 'faith', x: s ? s.x : null, y: s ? s.y : null, civId: f.civId, sid: f.sid, key: 'faith.prophet.died', ref: { k: 'figure', id: f.id },
        text: pickOne(world, [
          `${f.name}, founder of ${r.name}, died ${s ? 'in ' + s.name : 'among the faithful'} at the age of ${Math.round(age)}, and pilgrims came from far lands to the tomb.`,
          `The prophet ${f.name} was laid to rest${s ? ' in ' + s.name : ''}; ${fmtCount(r.followers)} believers mourned.`,
        ]),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// System

export const system = {
  id: 'religion',
  order: 50,
  init(world) {
    state(world);
    for (const s of world.settlements) {
      if (!s) continue;
      if (!s.religion || typeof s.religion !== 'object') s.religion = {};
      if (s.dominantReligion != null && !world.religions[s.dominantReligion]) s.dominantReligion = null;
    }
    let wp = 0;
    for (const s of world.settlements) if (s && s.alive && finite(s.population)) wp += s.population;
    for (const r of world.religions) {
      if (!Array.isArray(r.tenets)) r.tenets = [];
      if (!finite(r.fervor)) r.fervor = 0.4;
      if (!finite(r.followers)) r.followers = 0;
      if (r.hue == null) r.hue = 0;
      if (!finite(r.reach)) {   // worlds saved before reach was tracked: no burst of old news
        const share = wp > 0 ? r.followers / wp : 0;
        r.reach = share >= 0.5 ? 3 : share >= 0.25 ? 2 : share >= 0.1 ? 1 : 0;
      }
    }
  },
  update(world) {
    const day = world.time.day;
    if (day % DAYS_PER_MONTH !== SPREAD_DAY) return;
    const st = state(world);
    prophets(world, st);
    spread(world, st);
    const byCiv = tally(world);
    stateReligions(world, byCiv);
    upkeep(world, st, byCiv);
    if (Math.floor(day / DAYS_PER_MONTH) % 12 === 3) { schisms(world, st); prophetDeaths(world); }
  },
};

// ---------------------------------------------------------------------------
// Hooks: conversion by conquest, the fall of holy cities

on('settlementTransferred', (world, s, oldCivId, newCivId, cause) => {
  if (!s || !s.alive) return;
  const civ = civById(world, newCivId);
  const sr = civ ? faithOf(world, civ.stateReligion) : null;
  if (sr && (cause === 'conquest' || cause === 'treaty')) {
    const shift = sr.tenets.includes('militant') ? 0.25 : 0.06;
    const sh = s.religion || (s.religion = {});
    for (const k of Object.keys(sh)) if (+k !== sr.id) sh[k] *= 1 - shift;
    let sum = 0; for (const k of Object.keys(sh)) sum += sh[k];
    sh[sr.id] = Math.min(1, (sh[sr.id] || 0) + shift * Math.max(0, 1 - (sh[sr.id] || 0)));
    normalise(sh);
  }
  if (cause !== 'conquest') return;
  for (const r of world.religions) {
    if (r.alive === false || r.holyCityId !== s.id || !civ || civ.stateReligion === r.id) continue;
    r.fervor = clamp01(r.fervor + 0.2);
    if (r.followers > 5000 && rateOk(world, `holy${r.id}`, 20 * DAYS_PER_YEAR)) {
      chronicle(world, {
        cat: 'religion', imp: 3, x: s.x, y: s.y, civId: newCivId, sid: s.id, icon: 'faith', key: 'faith.holycity.fell', ref: { k: 'religion', id: r.id },
        text: pickOne(world, [
          `The fall of ${s.name}, holy city of ${r.name}, to ${peopleOf(civ)} enraged the faithful from one end of the world to the other.`,
          `${capFirst(peopleOf(civ))} took ${s.name}, holiest shrine of ${r.name}, and its believers swore to win it back.`,
        ]),
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Tools (targets shared with their previews in previews.js)

registerTool({
  id: 'prophet', label: 'Prophet', group: 'fate', icon: 'prophet', order: 30, polarity: 'boon',
  desc: 'Raise a prophet in the nearest town, founding a new faith there.',
  target: 'settlement', radius: 0,
  preview: prophetPreview,
  apply(world, x, y) {
    const s = prophetTarget(world, x, y);
    if (!s) return { ok: false, message: 'No town lies close enough to hear a prophet.' };
    const alive = world.religions.filter((r) => r.alive !== false).length;
    if (alive >= MAX_FAITHS + 8) return { ok: false, message: 'The world already teems with gods.' };
    const r = foundReligion(world, s, { divine: true });
    if (!r) return { ok: false, message: 'The prophet found no listeners.' };
    emitFx(world, { type: 'bless', x: s.x, y: s.y, r: 3, src: 'tool' });
    toolLabel(world, s.x, s.y, r.name, 'boon');
    return { ok: true, message: `${r.prophet} preaches ${r.name} in ${s.name}.` };
  },
});

registerTool({
  id: 'miracle', label: 'Miracle', group: 'fate', icon: 'miracle', order: 35, polarity: 'boon',
  desc: 'Work a miracle: a wave of fervour for the faith of the area (or the nearest faith).',
  target: 'area', radius: 6, minRadius: 2, maxRadius: 30,
  preview: miraclePreview,
  apply(world, x, y, { radius }) {
    const { towns, faith: r, r: r0 } = miracleTargets(world, x, y, radius);
    if (!towns.length) return { ok: false, message: 'There is no one here to witness a miracle.' };
    if (!r) return { ok: false, message: 'No faith is near enough to kindle; raise a prophet first.' };
    r.fervor = clamp01(r.fervor + 0.25);
    for (const s of towns) {
      const sh = s.religion || (s.religion = {});
      const cur = sh[r.id] || 0;
      const add = 0.3 * (1 - cur);
      for (const k of Object.keys(sh)) if (+k !== r.id) sh[k] *= 1 - add;
      sh[r.id] = cur + add;
      normalise(sh);
      s.unrest = clamp01((s.unrest || 0) - 0.1);
      s.happiness = clamp01((s.happiness ?? 0.6) + 0.1);
    }
    emitFx(world, { type: 'bless', x, y, r: r0, src: 'tool' });
    emitFx(world, { type: 'faith', x, y, color: r.colorHex, src: 'tool' });
    toolLabel(world, x, y, `${towns.length} town${towns.length === 1 ? '' : 's'} kindled`, 'boon');
    const big = towns.slice().sort((a, b) => b.population - a.population)[0];
    if (rateOk(world, `miracle${r.id}`, DAYS_PER_YEAR)) {
      chronicle(world, {
        cat: 'divine', imp: 2, x, y, civId: big.civId, sid: big.id, icon: 'miracle', key: 'divine.miracle', ref: { k: 'religion', id: r.id },
        text: pickOne(world, [
          `A light descended over ${big.name}; thousands flocked to ${r.name}.`,
          `Wonders were seen in the skies above ${big.name}, and the faithful of ${r.name} were filled with zeal.`,
          `The sick rose from their beds in ${big.name}, and all who saw it praised ${r.deity || 'the gods'} of ${r.name}.`,
          `A weeping statue in the temple of ${big.name} drew pilgrims from ${countWord(Math.min(12, towns.length))} towns to ${r.name}.`,
        ]),
      });
    }
    return { ok: true, message: `Fervour for ${r.name} sweeps ${towns.length} town${towns.length === 1 ? '' : 's'}.` };
  },
});
