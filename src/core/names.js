// Procedural languages. Each civilization (and the world itself) owns a language object:
// a plain JSON-serialisable description of its sounds. Names drawn from one language
// share a recognisable flavour, so a nation's towns, rulers and gods sound related.

import { capitalize } from './util.js';
import { BIOME } from './constants.js';

const CONSONANT_STYLES = [
  { onsets: ['k', 'g', 'r', 'd', 't', 'z', 'kh', 'gr', 'dr', 'th', 'v', 'm', 'n', 'b'], codas: ['k', 'r', 'g', 'th', 'z', 'n', 'rk', 'x'] }, // harsh
  { onsets: ['l', 'm', 'n', 's', 'v', 'f', 'h', 'y', 'th', 'el', 'r', 'w'], codas: ['l', 'n', 's', 'th', 'r', 'm', 'nd'] }, // soft
  { onsets: ['p', 't', 'k', 'm', 'n', 'h', 'w', 'l', 'r', 'ts', 'ch'], codas: ['n', 'ng', 'k', 'm', 't'] }, // clipped
  { onsets: ['s', 'sh', 'z', 'q', 'k', 'r', 'd', 'b', 'm', 'n', 'j', 'h'], codas: ['r', 'sh', 'd', 'n', 'm', 'b', 'q'] }, // sibilant
  { onsets: ['b', 'p', 'd', 't', 'g', 'k', 'm', 'n', 'l', 'r', 's', 'v', 'br', 'tr', 'st'], codas: ['n', 's', 'r', 'l', 'st', 'nt', 'd'] }, // plain
  { onsets: ['x', 'tl', 'k', 'ch', 'm', 'n', 'p', 't', 'y', 'h', 'z', 'c'], codas: ['tl', 'n', 'c', 'x', 'l'] }, // nahuatlesque
];
const VOWEL_SETS = [
  ['a', 'e', 'i', 'o', 'u'],
  ['a', 'i', 'u'],
  ['a', 'e', 'o', 'ae', 'ei'],
  ['o', 'u', 'a', 'ou', 'y'],
  ['e', 'i', 'a', 'ia', 'ee'],
  ['a', 'aa', 'i', 'u', 'o'],
];
const ADJ_SUFFIXES = ['ian', 'ese', 'i', 'ic', 'an', 'ish', 'ar', 'ene'];

const strList = (a) => (Array.isArray(a) ? a.filter((s) => typeof s === 'string' && s.length > 0) : []);

/**
 * Create a language from an RNG.
 * style (optional) biases the phonology, e.g. a race's tongue (WP5 people.languageStyle):
 *   { onsets?: [str], codas?: [str], vowels?: [str],   pools replacing the drawn sound sets
 *     minSyl?, maxSyl?,                                 syllable range of words (1..5)
 *     placeSuffixes?: [str], personSuffixes?: [str],    fixed suffixes instead of drawn ones
 *     adjSuffixes?: [str],                              pool for the demonym suffix
 *     apostrophe?: 0..1 }                               chance the tongue uses apostrophes
 * With style null the rng draws are exactly those of the original single-argument form, so
 * every Historical world names itself as it always did.
 */
export function createLanguage(rng, style = null) {
  const st = style && typeof style === 'object' ? style : null;
  const base = rng.pick(CONSONANT_STYLES);
  const onsetPool = st && strList(st.onsets).length ? strList(st.onsets) : base.onsets;
  const codaPool = st && strList(st.codas).length ? strList(st.codas) : base.codas;
  const onsets = rng.shuffle(onsetPool.slice()).slice(0, rng.int(Math.min(7, onsetPool.length), onsetPool.length));
  const codas = rng.shuffle(codaPool.slice()).slice(0, rng.int(Math.min(3, codaPool.length), codaPool.length));
  const vowelSet = rng.pick(VOWEL_SETS);
  const vowels = rng.shuffle((st && strList(st.vowels).length ? strList(st.vowels) : vowelSet).slice());
  const adjPool = st && strList(st.adjSuffixes).length ? strList(st.adjSuffixes) : ADJ_SUFFIXES;
  const lang = {
    onsets,
    codas,
    vowels,
    codaChance: rng.float(0.15, 0.55),
    vowelStartChance: rng.float(0.05, 0.3),
    minSyl: rng.int(1, 2),
    maxSyl: rng.int(2, 4),
    adjSuffix: rng.pick(adjPool),
    placeSuffixes: [],
    personSuffixes: [],
    apostrophe: rng.chance(st && Number.isFinite(st.apostrophe) ? Math.max(0, Math.min(1, st.apostrophe)) : 0.12),
  };
  if (st) {
    const lo = Number.isFinite(st.minSyl) ? Math.max(1, Math.min(5, Math.round(st.minSyl))) : lang.minSyl;
    const hi = Number.isFinite(st.maxSyl) ? Math.max(1, Math.min(5, Math.round(st.maxSyl))) : lang.maxSyl;
    lang.minSyl = Math.min(lo, hi);
    lang.maxSyl = Math.max(lo, hi);
  }
  const ps = st ? strList(st.placeSuffixes) : [];
  const qs = st ? strList(st.personSuffixes) : [];
  if (ps.length) lang.placeSuffixes = ps.slice(0, 8);
  else for (let i = 0; i < rng.int(2, 4); i++) lang.placeSuffixes.push(syllable(lang, rng, true));
  if (qs.length) lang.personSuffixes = qs.slice(0, 8);
  else for (let i = 0; i < rng.int(2, 3); i++) lang.personSuffixes.push(syllable(lang, rng, false));
  return lang;
}

function syllable(lang, rng, allowCoda) {
  let s = '';
  if (!rng.chance(lang.vowelStartChance)) s += rng.pick(lang.onsets);
  s += rng.pick(lang.vowels);
  if (allowCoda && rng.chance(lang.codaChance)) s += rng.pick(lang.codas);
  return s;
}

function tidy(word) {
  // collapse triple letters (whatever their case: "Ooondby") and awkward vowel pileups
  return word
    .replace(/(.)\1\1+/gi, '$1$1')
    .replace(/([aeiouy]{3})[aeiouy]+/gi, '$1')
    .replace(/^(.)\1/i, '$1');
}

/** A raw word with syllable count in [minS, maxS]. */
export function makeWord(lang, rng, minS = lang.minSyl, maxS = lang.maxSyl) {
  const n = rng.int(minS, Math.max(minS, maxS));
  let w = '';
  for (let i = 0; i < n; i++) w += syllable(lang, rng, i === n - 1 || rng.chance(0.3));
  if (lang.apostrophe && n > 1 && rng.chance(0.2)) {
    const k = 1 + Math.floor(rng.next() * (w.length - 2));
    w = w.slice(0, k) + "'" + w.slice(k);
  }
  w = tidy(w);
  if (w.length < 3) w = tidy(w + rng.pick(lang.vowels) + rng.pick(lang.codas));
  if (w.length > 12) w = w.slice(0, 10);
  return capitalize(w);
}

/** A place name (town, river, mountain, region). */
export function makePlace(lang, rng) {
  const base = makeWord(lang, rng, 1, Math.max(2, lang.maxSyl - 1));
  if (rng.chance(0.4)) return tidy(base + rng.pick(lang.placeSuffixes));
  return base;
}

/** A personal name. */
export function makePerson(lang, rng) {
  const base = makeWord(lang, rng, 1, Math.max(2, lang.maxSyl - 1));
  if (rng.chance(0.35)) return tidy(base + rng.pick(lang.personSuffixes));
  // a bare name that reads as an English word ("The the Bold") takes a fixed ending (no extra draw)
  return ENGLISH.has(base.toLowerCase()) ? base + (lang.personSuffixes?.[0] || 'a') : base;
}
const ENGLISH = new Set(['the', 'a', 'an', 'and', 'of', 'to', 'in', 'on', 'at', 'by', 'or', 'as', 'is', 'it', 'he', 'she', 'we', 'me', 'be', 'no', 'so']);

/** Adjective / demonym for a proper name in this language. */
export function adjectiveOf(name, lang) {
  const n = name.replace(/'/g, '');
  const last = n[n.length - 1];
  if ('aeiouy'.includes(last)) {
    if (last === 'a') return n + 'n';
    if (last === 'i' || last === 'y') return n + 'an';
    return n.slice(0, -1) + (lang?.adjSuffix || 'ian');
  }
  return n + (lang?.adjSuffix || 'ian');
}


// Generated words that read as English in a sentence ("the Holy See of The", a town called
// "Bug") are never used as names of places or peoples.
const BAD_NAMES = new Set(('the a an and of to in on at by for from her his him she he it its is was are be been not but or nor so yet '
  + 'war wars king queen god gods sea seas sin die dead hell man men who why how what one two ten we us you me my no yes sir lord lady '
  + 'tin gold iron salt ash fire age old new all any can did do does had has have if into may more most must our out own same than '
  + 'that them then there these they this those too very was were when where which while will with would hero kin son sun '
  + 'bug bugs fourth bottom butt dung poo pee fart bum pit rot').split(' '));
/** True for a generated name that is an English word ('These', 'Bug', 'Fourth'). */
export const isEnglishWord = (name) => BAD_NAMES.has(String(name || '').toLowerCase().replace(/'/g, ''))
  || /^(the|an?)['’]/i.test(String(name || ''));   // "The'ka" reads as an article: "the The'ka Levy"

/** Base name and adjective for a new nation (never an English word: a few more draws then). */
export function makeCivName(lang, rng) {
  let name = makePlace(lang, rng);
  for (let k = 0; k < 4 && isEnglishWord(name); k++) name = makePlace(lang, rng);
  return { name, adjective: adjectiveOf(name, lang) };
}

/** A sometimes-language-flavoured, sometimes-descriptive name helper for one-off things. */
export function pickName(rng, list) { return rng.pick(list); }

// ---------------------------------------------------------------------------
// Name phrases: the toolkit shared by the combinatorial name generators (faiths, plagues, wars,
// bands, beasts, dragons and lairs, epithets, ages). A generator is a list of weighted forms,
// templates whose {slots} are filled from themed word pools and from the world's own words (a
// people's language, its towns, rivers and gods), so a world draws from thousands of outcomes
// instead of a few dozen fixed phrases. Everything below is pure: the only randomness is the rng
// passed in, and nothing above this line draws differently because of it.

/** One value from [[weight, value], …] (one draw); entries with weight ≤ 0 never win. */
export function pickWeighted(rng, list) {
  let total = 0;
  for (const e of list) if (e && e[0] > 0) total += e[0];
  if (!(total > 0)) return undefined;
  let r = rng.next() * total;
  let last;
  for (const e of list) {
    if (!e || !(e[0] > 0)) continue;
    if (r < e[0]) return e[1];
    r -= e[0];
    last = e[1];
  }
  return last;
}

const SLOT = /\{(\w+)\}/g;
const usableSlot = (v) => v != null && v !== '' && !(Array.isArray(v) && !v.length);

/** Collapse doubled spaces and articles ("the the", "of the The") that filled templates leave. */
export function tidyName(s) {
  return String(s).replace(/\s+/g, ' ').replace(/\b(the|The) the\b/g, '$1').replace(/\b(of|in|for|by) The\b/g, '$1 the').trim();
}

/**
 * Compose a name from weighted forms, e.g.
 *   composeName(rng, [[3, 'the {Adj} {Noun}'], [2, 'the {Noun} of {place}']], { Adj: [...], Noun: [...], place: 'Oskel' })
 * A slot holding an array is drawn from (one draw; the same pool twice in one form gives two
 * different words), a function is called with rng, anything else is used as text. A form with a
 * missing or empty slot is never chosen. Returns null when no form is usable.
 */
export function composeName(rng, forms, vocab) {
  const usable = [];
  for (const f of forms) {
    if (!f || !(f[0] > 0) || typeof f[1] !== 'string') continue;
    let ok = true;
    for (const m of f[1].matchAll(SLOT)) if (!usableSlot(vocab[m[1]])) { ok = false; break; }
    if (ok) usable.push(f);
  }
  const tpl = pickWeighted(rng, usable);
  if (tpl == null) return null;
  const drawn = {};
  const out = tpl.replace(SLOT, (m, k) => {
    const v = vocab[k];
    if (Array.isArray(v)) {
      let j = Math.floor(rng.next() * v.length);
      const seen = drawn[k] || (drawn[k] = []);
      for (let t = 0; t < v.length && seen.includes(v[j]); t++) j = (j + 1) % v.length;
      seen.push(v[j]);
      return String(v[j]);
    }
    if (typeof v === 'function') return String(v(rng));
    return String(v);
  });
  return tidyName(out);
}

/**
 * A name nobody has used yet: up to `tries` calls of make() until isTaken(name) is false; else
 * the last one made (the caller adds its own ordinal or suffix). make may return null (skipped).
 */
export function freshName(make, isTaken, tries = 8) {
  let last = null;
  for (let k = 0; k < tries; k++) {
    const n = make();
    if (!n) continue;
    last = n;
    if (!isTaken(n)) return n;
  }
  return last;
}

/** Drop a leading article: "the Red Hoods" → "Red Hoods". */
export const stripThe = (n) => (n ? String(n).replace(/^the\s+/i, '') : n);

/** "Oren's", "the Brothers'", "Saint Moss'" → possessive of a name or noun phrase. */
export function possessive(name) {
  const n = String(name || '');
  return /s$/.test(n) && !/(ss|us|is)$/.test(n) ? n + "'" : n + "'s";
}

/** "a" or "an" before a word. */
export const indefinite = (word) => (/^(?:[aeiou]|hour|honou?r|heir)/i.test(String(word || '')) && !/^(?:uni|use|eu|one)/i.test(String(word || '')) ? 'an' : 'a');

/** Join two halves into one word: "Iron" + "hand" → "Ironhand"; a doubled or awkward seam takes a hyphen ("Ash-Heart", "One-Eye"). */
export function compound(a, b) {
  const x = String(a || ''), y = String(b || '');
  if (!x) return capitalize(y);
  if (!y) return x;
  const end = x[x.length - 1].toLowerCase(), start = y[0].toLowerCase();
  const hy = end === start || /^(one|half|nine|three|seven|twice|thrice|many|all)$/i.test(x) || x.length + y.length > 13
    || ('aeiou'.includes(end) && 'aeiou'.includes(start)) || /h$/i.test(x) && /^h/i.test(y);
  return hy ? `${x}-${capitalize(y)}` : x + y.toLowerCase();
}

/**
 * An adjective from a generated personal or place name, for "the Arvenite Brethren", "the
 * Oskelan Rite": strips a final vowel, then adds the suffix ('ite', 'ian', 'an').
 */
export function nameAdjective(name, suffix = 'ite') {
  const n = String(name || '').replace(/'/g, '');
  if (!n) return n;
  const base = /[aeiouy]$/i.test(n) ? n.slice(0, -1) : n;
  return base + suffix;
}

/** A generated word fit to stand in a name: 3–10 letters, no apostrophe, never an English word (a few more draws then). */
export function nameWord(lang, rng, minS = 1, maxS = 2) {
  let w = '';
  for (let k = 0; k < 4; k++) {
    w = makeWord(lang, rng, minS, maxS).replace(/'/g, '');
    if (w.length > 10) w = w.slice(0, 9);
    w = capitalize(w.toLowerCase());
    if (w.length >= 3 && !isEnglishWord(w)) return w;
  }
  return w.length >= 3 ? w : w + 'an';
}

/** A place name that is never an English word ("Mount The", "the Bug Gang"): makePlace, with a few more draws only then. */
export function properPlace(lang, rng) {
  let n = makePlace(lang, rng);
  for (let k = 0; k < 4 && isEnglishWord(n); k++) n = makePlace(lang, rng);
  return n;
}

/** Era band of an era index: 0 'tribal', 1–2 'ancient', 3–4 'medieval', 5+ 'modern'. */
export const eraBand = (era) => (!(era > 0) ? 'tribal' : era <= 2 ? 'ancient' : era <= 4 ? 'medieval' : 'modern');

/**
 * Words that colour a name by the people who give it (Mythic races; humans included). Generators
 * mix them in now and then: an elven faith of "the Starlit Bough", a dwarven company of "the
 * Graven Anvil". { adj: [..], noun: [..] } per race key; unknown races get null.
 */
export const RACE_WORDS = {
  human: { adj: ['Wandering', 'Restless', 'Many-Roaded', 'Kindled', 'Tireless', 'Bright'], noun: ['Road', 'Lamp', 'Wheel', 'Crossroads', 'Ship', 'Banner'] },
  elf: { adj: ['Starlit', 'Evergreen', 'Silver', 'Twilight', 'Undying', 'Dreaming', 'Moonlit'], noun: ['Star', 'Leaf', 'Song', 'Bough', 'Dream', 'Willow', 'Glade'] },
  dwarf: { adj: ['Deep', 'Iron', 'Graven', 'Stone', 'Forge-Lit', 'Bearded', 'Rune-Cut'], noun: ['Anvil', 'Forge', 'Hammer', 'Rune', 'Root', 'Hall', 'Vein'] },
  orc: { adj: ['Red', 'Bloody', 'Tusked', 'Howling', 'Scarred', 'Black', 'Bone'], noun: ['Skull', 'Tusk', 'Blood', 'Fist', 'Wolf', 'Brand', 'Drum'] },
  halfling: { adj: ['Kindly', 'Merry', 'Green', 'Hearthside', 'Snug', 'Mossy', 'Honeyed'], noun: ['Hearth', 'Kettle', 'Harvest', 'Hill', 'Garden', 'Pantry', 'Hedge'] },
  lizardfolk: { adj: ['Coiled', 'Scaled', 'Feathered', 'Sun-Warmed', 'Cold-Blooded', 'Jade', 'Mire'], noun: ['Serpent', 'Egg', 'Coil', 'Mire', 'Scale', 'Feather', 'Fen'] },
};
/** The race words for a civ (null in Historical worlds, where civs have no race). */
export const raceWordsOf = (civ) => (civ && typeof civ.race === 'string' && RACE_WORDS[civ.race]) || null;

// Epithets for people: the by-names chroniclers and soldiers give generals, captains and khans.
const EP_ADJ = {
  any: ['the Bold', 'the Red', 'the Grim', 'the Young', 'the Lame', 'the Swift', 'the Black', 'the Tall', 'the Silent', 'the Fair', 'the Proud',
    'the Stern', 'the Wild', 'the Lucky', 'the Wary', 'the Patient', 'the Hard', 'the Cold', 'the Fierce', 'the Fearless', 'the Restless',
    'the Sly', 'the Quiet', 'the Unbowed', 'the Steady', 'the Tireless', 'the Scarred', 'the Grey', 'the Old', 'the Iron', 'the Stubborn', 'the Dour'],
  outlaw: ['the Hanged', 'the Unhanged', 'the Laughing', 'the Hooded', 'the Cutpurse', 'the Butcher', 'the Bastard', 'the Ragged', 'the Mad',
    'the Merry', 'the Faceless', 'the Shadow', 'the Barefoot', 'the Hungry', 'the Branded', 'the Outcast', 'the Gentle', 'the Lean', 'the Smiling'],
  sea: ['the Drowned', 'the Shark', 'the Gull', 'the Eel', 'the Corsair', 'the Wrecker', 'the Salt', 'the Undrowned', 'the Tarred',
    'the Black Flag', 'the Barnacle', 'the Squall', 'the Lucky'],
  khan: ['the Great', 'the Terrible', 'the Scourge', 'the Thunder', 'the Conqueror', 'the Wolf', 'the Burner', 'the Unstoppable', 'the Hawk',
    'the Lord of Horses', 'the Storm', 'the Dread'],
};
const EP_BEAST = ['the Wolf', 'the Lion', 'the Fox', 'the Bear', 'the Hawk', 'the Boar', 'the Bull', 'the Raven', 'the Stag', 'the Viper',
  'the Falcon', 'the Badger', 'the Eagle', 'the Hound', 'the Lynx', 'the Shrike', 'the Otter', 'the Crow', 'the Adder', 'the Kite', 'the Ram', 'the Heron'];
const EP_ROLE = ['the Hammer', 'the Sword', 'the Shield', 'the Spear', 'the Anvil', 'the Scourge', 'the Reaper', 'the Wall', 'the Torch',
  'the Lance', 'the Axe', 'the Fist', 'the Thorn', 'the Arrow', 'the Gate', 'the Brand', 'the Storm', 'the Flail'];
// compounds: each first half with the second halves it sits well with ("Ironhand", "Longspear", "Crookback")
const EP_PAIRS = {
  any: {
    Iron: ['hand', 'fist', 'heart', 'side', 'jaw', 'helm', 'beard', 'brow', 'arm'], Red: ['beard', 'hand', 'mane', 'cloak', 'axe', 'shield', 'locks'],
    Black: ['beard', 'cloak', 'heart', 'hand', 'helm', 'mane', 'tooth', 'shield'], Grey: ['cloak', 'beard', 'mantle', 'locks', 'hood', 'mane', 'wolf'],
    Silver: ['hand', 'tongue', 'locks', 'helm', 'shield', 'beard'], Golden: ['hand', 'helm', 'locks', 'mane', 'shield', 'tongue'],
    Stone: ['heart', 'fist', 'brow', 'hand', 'skull', 'face'], Steel: ['jaw', 'heart', 'eye', 'hand', 'arm'], White: ['beard', 'cloak', 'mane', 'hand', 'shield'],
    Bone: ['hand', 'breaker', 'helm', 'shield'], Ash: ['beard', 'cloak', 'face'], Copper: ['beard', 'helm', 'locks'], Long: ['spear', 'knife', 'bow', 'shanks', 'arm', 'stride', 'beard', 'sword', 'axe'],
    Strong: ['arm', 'hand'], Broad: ['back', 'axe', 'shield', 'blade'], Crook: ['back', 'foot', 'leg', 'nose', 'shank'], Half: ['hand', 'ear', 'beard'],
    One: ['eye', 'hand', 'ear'], Blood: ['axe', 'hand', 'fist', 'beard', 'spear'], Hard: ['heart', 'hand', 'nose'], Cold: ['heart', 'eye', 'hand'],
    Raven: ['locks', 'cloak', 'helm', 'wing'], Wolf: ['cloak', 'heart', 'tooth', 'skin'], Thorn: ['heart', 'hand', 'helm'], Oak: ['heart', 'shield', 'arm'],
    Fire: ['beard', 'heart', 'brand', 'hand'], Frost: ['beard', 'heart', 'eye'], Storm: ['crow', 'brow', 'cloak', 'shield'], Night: ['cloak', 'eye', 'hawk'],
    Swift: ['foot', 'sword', 'spear', 'blade'], Bright: ['blade', 'helm', 'eye', 'shield'], Sharp: ['tongue', 'eye', 'sword'], Lion: ['heart', 'mane'],
  },
  sea: {
    Salt: ['beard', 'eye', 'hand', 'jaw', 'skin'], Tide: ['walker', 'caller', 'hand'], Brine: ['beard', 'eye', 'tooth'], Gull: ['eye', 'cry'],
    Tar: ['beard', 'hand', 'heel'], Squall: ['brow', 'beard'], Wreck: ['maker', 'er'], Kelp: ['beard', 'locks'], Shark: ['tooth', 'eye', 'smile'],
    Storm: ['crow', 'cloak', 'rider'], Sea: ['wolf', 'hawk', 'dog'], Black: ['sail', 'beard', 'flag'], Red: ['sail', 'beard', 'hand'],
  },
};
const EP_AGENT = {
  breaker: ['Oath', 'Wall', 'Shield', 'Spear', 'Gate', 'Chain', 'Bridge', 'Horse', 'Siege', 'Helm', 'Bone'], bane: ['King', 'Wolf', 'Troll', 'Lord'],
  taker: ['Skull', 'Head', 'Town', 'Oath', 'Crown'], cleaver: ['Skull', 'Helm', 'Shield'], splitter: ['Skull', 'Shield', 'Helm', 'Oak'],
  burner: ['Ship', 'Town', 'Bridge', 'Field', 'Hall'], crusher: ['Bone', 'Skull', 'Helm'], slayer: ['Giant', 'Wolf', 'Bear', 'King'],
};
const EP_BORN = ['Storm', 'Fire', 'Snow', 'Sea', 'Iron', 'Battle', 'Blood', 'Ash', 'Thunder', 'Winter', 'Night', 'Field', 'Camp', 'Ship'];
const pairList = (m) => { const out = []; for (const a in m) for (const b of m[a]) out.push([a, b]); return out; };
const EP_COMPOUNDS = { any: pairList(EP_PAIRS.any), sea: pairList(EP_PAIRS.sea).concat(pairList(EP_PAIRS.any)) };
const EP_AGENTS = (() => { const out = []; for (const b in EP_AGENT) for (const a of EP_AGENT[b]) out.push([a, b]); return out; })();

/**
 * A by-name for a person ("the Bold", "Ironhand", "Oathbreaker", "Stormborn", "the Fox of Oskel").
 * theme: 'any' (generals, captains) | 'outlaw' | 'sea' | 'khan'. ctx.place: a home town or region
 * for "the Wolf of Oskel" (rarely). One draw for the form, one or two for its words.
 */
export function makeEpithet(rng, theme = 'any', ctx = {}) {
  const adj = theme !== 'any' && EP_ADJ[theme] ? EP_ADJ[theme].concat(EP_ADJ.any) : EP_ADJ.any;
  const form = pickWeighted(rng, [
    [3, 'adj'], [1.6, 'beast'], [1.2, 'role'], [3.4, 'compound'], [1.1, 'agent'], [0.7, 'born'], [ctx.place ? 1.4 : 0, 'of'],
  ]);
  if (form === 'adj') return rng.pick(adj);
  if (form === 'beast') return rng.pick(EP_BEAST);
  if (form === 'role') return rng.pick(EP_ROLE);
  if (form === 'agent') { const [a, b] = rng.pick(EP_AGENTS); return compound(a, b); }
  if (form === 'born') return compound(rng.pick(EP_BORN), 'born');
  if (form === 'of') return `${rng.pick(rng.chance(0.5) ? EP_BEAST : EP_ROLE)} of ${ctx.place}`;
  const [a, b] = rng.pick(theme === 'sea' ? EP_COMPOUNDS.sea : EP_COMPOUNDS.any);
  return compound(a, b);
}

/** How many distinct by-names makeEpithet can give for a theme (for reports and tests). */
export function epithetVariety(theme = 'any') {
  const adj = theme !== 'any' && EP_ADJ[theme] ? EP_ADJ[theme].length + EP_ADJ.any.length : EP_ADJ.any.length;
  return adj + EP_BEAST.length + EP_ROLE.length + EP_AGENTS.length + EP_BORN.length + (theme === 'sea' ? EP_COMPOUNDS.sea : EP_COMPOUNDS.any).length;
}

// The land a thing is named in: words a faith, a plague or a band of the sands, the fens or the
// high snows may borrow ("the Covenant of the Golden Oasis", "the Fen Ague").
const TERRAIN_WORDS = {
  sands: { adj: ['Sand-Swept', 'Sun-Scorched'], noun: ['Oasis', 'Dune', 'Well', 'Sands'] },
  wood: { adj: ['Green', 'Leafy'], noun: ['Grove', 'Oak', 'Bough', 'Glade'] },
  marsh: { adj: ['Misty', 'Reedy'], noun: ['Fen', 'Reed', 'Mere', 'Marsh'] },
  shore: { adj: ['Sea-Born', 'Salt'], noun: ['Tide', 'Wave', 'Shore', 'Pearl'] },
  hills: { adj: ['High', 'Stony'], noun: ['Peak', 'Height', 'Summit', 'Crag'] },
  snows: { adj: ['Frozen', 'Snow-White'], noun: ['Ice', 'Snow', 'Frost', 'Pine'] },
  plains: { adj: ['Wind-Swept', 'Wide'], noun: ['Grass', 'Horse', 'Wind', 'Plain'] },
  river: { adj: ['Flowing', 'Deep-Running'], noun: ['River', 'Ford', 'Reed', 'Spring'] },
};
/** The kind of land at tile i ('sands', 'wood', 'marsh', 'shore', 'hills', 'snows', 'plains', 'river') or null at sea. Pure. */
export function terrainAt(world, i) {
  const f = world && world.f;
  if (!f || !f.biome || !(i >= 0 && i < f.biome.length)) return null;
  if (f.water && f.water[i]) return null;
  const b = f.biome[i];
  if (f.elevation && f.elevation[i] >= 0.66) return 'hills';
  if (b === BIOME.HOT_DESERT || b === BIOME.COLD_DESERT) return 'sands';
  if (b === BIOME.WETLAND) return 'marsh';
  if (b === BIOME.TUNDRA || b === BIOME.ICE || b === BIOME.ALPINE) return 'snows';
  if (f.coast && f.coast[i]) return 'shore';
  if (f.river && f.river[i] >= 2) return 'river';
  if (b === BIOME.STEPPE || b === BIOME.SAVANNA || b === BIOME.SHRUBLAND) return 'plains';
  if (b === BIOME.TAIGA) return 'snows';
  return 'wood';
}
/** { adj, noun } words of the land at tile i (null at sea). Pure. */
export const terrainWordsAt = (world, i) => TERRAIN_WORDS[terrainAt(world, i)] || null;
