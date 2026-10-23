// Prose helpers for the event deck: names of peoples, realms and rulers, numbers in words,
// seasons, geographic phrases from world.features ("on the banks of the Tiren", "by the
// Varan Sea"), and small template utilities. Every random choice draws world.rng, so the
// text is part of the reproducible history. DOM-free; no imports from other packages.

import { BIOME, WATER, DAYS_PER_YEAR, DAYS_PER_MONTH } from '../../core/constants.js';
import { capitalize } from '../../core/util.js';
import { makePerson, makePlace, makeWord } from '../../core/names.js';

export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
export const pick = (world, arr) => arr[Math.floor(world.rng.next() * arr.length)];
/** Fill {key} slots from vars (missing keys stay visible, which tests catch). */
export const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
/** Pick a template and fill it; the first letter of the sentence is capitalised. */
export const say = (world, tpls, vars) => cap(fill(pick(world, tpls), vars));

// ---------------------------------------------------------------------------
// Numbers

export function fmtInt(n) {
  const v = Math.round(Number.isFinite(n) ? n : 0);
  const s = String(Math.abs(v));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return (v < 0 ? '-' : '') + out;
}
/** Rounded headcount: 3,412 → "3,400"; 950 → "950"; 38 → "40". */
export function approx(n) {
  const v = Math.max(0, Number.isFinite(n) ? n : 0);
  if (v < 100) return String(Math.max(1, Math.round(v / 5) * 5 || Math.round(v)));
  const mag = Math.pow(10, Math.floor(Math.log10(v)) - 1);
  return fmtInt(Math.round(v / mag) * mag);
}
const SMALL = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
export const countWord = (n) => (n >= 0 && n <= 12 ? SMALL[n] : fmtInt(n));
const ORD = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
export const ordinal = (n) => (n >= 0 && n <= 10 ? ORD[n] : `${n}th`);
/** "some 3,400 people" / "about a million souls" */
export function peopleCount(world, n, noun = null) {
  const v = Math.max(0, Number.isFinite(n) ? n : 0);
  const word = noun || pick(world, ['people', 'souls', 'people']);
  if (v >= 950000 && v < 1050000) return `about a million ${word}`;
  if (v >= 1e6) return `some ${Math.round(v / 1e5) / 10} million ${word}`;
  if (v < 12) return `${countWord(Math.max(1, Math.round(v)))} ${v < 1.5 ? (word === 'souls' ? 'soul' : 'person') : word}`;
  return `${pick(world, ['some', 'about', 'nearly', 'some'])} ${approx(v)} ${word}`;
}
/** "a tenth", "a fifth", "a third", "half" of a share 0..1. */
export function shareWord(f) {
  if (f >= 0.45) return 'half';
  if (f >= 0.3) return 'a third';
  if (f >= 0.22) return 'a quarter';
  if (f >= 0.17) return 'a fifth';
  if (f >= 0.12) return 'an eighth';
  if (f >= 0.08) return 'a tenth';
  return 'a handful';
}
export function yearsWord(n) {
  const y = Math.max(1, Math.round(n));
  if (y === 1) return 'a year';
  if (y <= 12) return `${SMALL[y]} years`;
  if (y % 10 === 0 && y <= 100) return `${['', 'ten', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'a hundred'][y / 10]} years`;
  return `${y} years`;
}
export const yearOfDay = (day) => Math.floor(day / DAYS_PER_YEAR);
/** "the 490s", or "the years 10 to 19" for the first century. */
export function decadeName(year) {
  const d = Math.floor(year / 10) * 10;
  if (d < 100) return d === 0 ? 'the first years of the world' : `the years ${d} to ${d + 9}`;
  return `the ${d}s`;
}
export function listJoin(items) {
  const a = items.filter(Boolean);
  if (a.length <= 1) return a[0] || '';
  return a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
}

// ---------------------------------------------------------------------------
// Peoples, realms, rulers

/** "the Kingdom of Varath" (styled names take the article mid-sentence), "Varath" otherwise. */
export function civName(civ) {
  if (!civ) return 'a forgotten people';
  return civ.flags?.styled ? 'the ' + civ.name : civ.name;
}
export const CivName = (civ) => capitalize(civName(civ));
export function demonym(adj) {
  const a = String(adj || '');
  if (!a) return 'people';
  if (/(ian|an|ar|ene|er|en|ite)$/i.test(a)) return a + 's';
  if (/ic$/i.test(a)) return a + ' people';
  return a;
}
/** "the Varathi", "the Mathnians". */
export const peopleOf = (civ) => (civ ? 'the ' + demonym(civ.adjective) : 'a forgotten people');
export const PeopleOf = (civ) => capitalize(peopleOf(civ));
export const adjOf = (civ) => (civ ? civ.adjective || civ.baseName || civ.name : 'foreign');
/** Does the realm's name take a plural verb ("the Varathi Clans were…")? */
export const pluralCiv = (civ) => Boolean(civ && /\b(Tribes|Clans|Cities|Provinces)\b|^People of\b/.test(civ.name || ''));
export const was = (civ) => (pluralCiv(civ) ? 'were' : 'was');

const ROMAN = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
export function roman(n) {
  let r = Math.max(1, Math.min(3999, Math.round(n))), out = '';
  for (const [k, s] of ROMAN) while (r >= k) { out += s; r -= k; }
  return out;
}
/** "Queen Ilsa II the Wise" */
export function rulerName(r, withEpithet = true) {
  if (!r || !r.name) return 'the ruler';
  const reg = r.regnal > 1 ? ' ' + roman(r.regnal) : '';
  const ep = withEpithet && r.epithet ? ' ' + r.epithet : '';
  return `${r.title ? r.title + ' ' : ''}${r.name}${reg}${ep}`;
}
/** "Ilsa II" */
export const rulerShort = (r) => (r && r.name ? `${r.name}${r.regnal > 1 ? ' ' + roman(r.regnal) : ''}` : 'the ruler');
export const his = (r) => (r && r.gender === 'f' ? 'her' : 'his');
export const he = (r) => (r && r.gender === 'f' ? 'she' : 'he');
export const rulerHas = (civ, trait) => Boolean(civ && civ.ruler && Array.isArray(civ.ruler.traits) && civ.ruler.traits.includes(trait));
/** Ruler age in years, or null. */
export function rulerAge(world, civ) {
  const r = civ && civ.ruler;
  return r && Number.isFinite(r.born) ? (world.time.day - r.born) / DAYS_PER_YEAR : null;
}
/** "the king" / "the high chieftess" / "the council" — the office, lower case. */
export function office(civ) {
  const r = civ && civ.ruler;
  if (!r || !r.title) return 'the ruler';
  return 'the ' + r.title.toLowerCase();
}

// ---------------------------------------------------------------------------
// Names

const BAD = new Set(('the a an and of to in on at by for from her his him she he it its is was are be been not but or nor so yet '
  + 'war wars king queen god gods sea seas sin die dead hell man men who why how what one two ten we us you me my no yes sir lord lady '
  + 'tin gold iron salt ash fire age old new all any can did do does had has have if into may more most must our out own same than '
  + 'that them then there these they this those too very were when where which while will with would hero kin son sun').split(' '));
const good = (n) => typeof n === 'string' && n.length >= 3 && !BAD.has(n.toLowerCase().replace(/'/g, ''));
const langOf = (world, civ) => (civ && civ.language) || world.lang;
/** A personal name in the civ's tongue (never a stray English word). */
export function personName(world, civ) {
  const lang = langOf(world, civ);
  let n = makePerson(lang, world.rng);
  for (let k = 0; k < 4 && !good(n); k++) n = makePerson(lang, world.rng);
  return n;
}
/** A place-like word in the civ's tongue. */
export function placeWord(world, civ) {
  const lang = langOf(world, civ);
  let n = makePlace(lang, world.rng);
  for (let k = 0; k < 4 && !good(n); k++) n = makePlace(lang, world.rng);
  return n;
}
/** A short word in the civ's tongue (for comets, fairs, revolts). */
export function shortWord(world, civ) {
  const lang = langOf(world, civ);
  let n = makeWord(lang, world.rng, 1, 2);
  for (let k = 0; k < 4 && !good(n); k++) n = makeWord(lang, world.rng, 1, 2);
  return n;
}

// ---------------------------------------------------------------------------
// Time and seasons

const SEASON_N = [0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 0];
/** Season index 0 winter … 3 autumn at row y this month. */
export function seasonIdx(world, y) {
  const m = Math.floor(world.time.day / DAYS_PER_MONTH) % 12;
  const n = SEASON_N[m];
  return y < world.H / 2 ? n : (n + 2) % 4;
}
export const seasonWord = (world, y) => ['winter', 'spring', 'summer', 'autumn'][seasonIdx(world, y)];
/** "in the summer of Year 412" */
export const seasonOfYear = (world, y) => `in the ${seasonWord(world, y)} of Year ${yearOfDay(world.time.day)}`;

// ---------------------------------------------------------------------------
// Geography

function withArticle(name, kind) {
  if (!name) return name;
  if (/^the\s/i.test(name)) return 'the ' + name.slice(4);
  if (kind === 'lake' && /^lake\s/i.test(name)) return name;
  if (kind === 'island' || kind === 'continent' || kind === 'lake') return name;
  if (/^(mount|lake|isle|cape)\s/i.test(name)) return name;
  return 'the ' + name;
}

function featureIndex(world) {
  const c = world.cache;
  const n = world.features ? world.features.length : 0;
  const v = world.versions.features || 0;
  if (c.evFeat && c.evFeat.v === v && c.evFeat.n === n) return c.evFeat.idx;
  const idx = { river: [], sea: [], lake: [], range: [], desert: [], forest: [], island: [], continent: [] };
  for (const ft of world.features || []) {
    if (!ft || !ft.name || !Number.isFinite(ft.x) || !Number.isFinite(ft.y)) continue;
    const k = ft.kind === 'ocean' ? 'sea' : ft.kind;
    if (idx[k]) idx[k].push(ft);
  }
  c.evFeat = { v, n, idx };
  return idx;
}
function nearest(list, x, y, maxD) {
  let best = null, bd = maxD * maxD;
  for (const ft of list) {
    const d = (ft.x - x) ** 2 + (ft.y - y) ** 2;
    if (d < bd) { bd = d; best = ft; }
  }
  return best;
}
/** Feature of one kind near (x, y) as a name with its article, or null. */
export function featureNear(world, kind, x, y, maxD = 20) {
  const ft = nearest(featureIndex(world)[kind] || [], x, y, maxD);
  return ft ? withArticle(ft.name, kind) : null;
}
/** Continent or island feature holding landmass lm (the feature object), or null. */
export function landFeature(world, lm) {
  if (lm == null || lm < 0) return null;
  const { W, f } = world;
  const idx = featureIndex(world);
  for (const ft of idx.continent.concat(idx.island)) {
    const j = Math.round(ft.y) * W + Math.round(ft.x);
    const k = j >= 0 && j < world.N && f.landmass[j] >= 0 ? f.landmass[j] : ft.landmass;
    if (k === lm) return ft;
  }
  return null;
}
/** Name of the continent or island at (x, y), or null. */
export function landNameAt(world, x, y) {
  const i = Math.round(y) * world.W + Math.round(x);
  const ft = landFeature(world, world.f.landmass[i]);
  return ft ? withArticle(ft.name, ft.kind) : null;
}

const BIOME_PHRASES = {
  [BIOME.TUNDRA]: ['on the frozen tundra', 'on the bleak northern plains'],
  [BIOME.TAIGA]: ['amid the northern pines', 'deep in the boreal woods'],
  [BIOME.STEPPE]: ['on the open grasslands', 'out on the wide steppe'],
  [BIOME.SHRUBLAND]: ['in the dry scrublands', 'among the thorny hills'],
  [BIOME.TEMPERATE_FOREST]: ['in the wooded lowlands', 'among the oak forests'],
  [BIOME.TEMPERATE_RAINFOREST]: ['in the misty rainforests', 'beneath the great dripping trees'],
  [BIOME.HOT_DESERT]: ['in the burning desert', 'among the dunes'],
  [BIOME.COLD_DESERT]: ['in the cold barrens', 'on the windswept plateau'],
  [BIOME.SAVANNA]: ['on the savanna', 'among the acacia plains'],
  [BIOME.TROPICAL_FOREST]: ['in the dry tropical woods', 'in the monsoon forests'],
  [BIOME.RAINFOREST]: ['deep in the rainforest', 'beneath the jungle canopy'],
  [BIOME.WETLAND]: ['among the marshes', 'in the reed-fens'],
  [BIOME.ALPINE]: ['high in the mountains', 'among the mountain passes'],
  [BIOME.ICE]: ['on the edge of the ice'],
};

/** A short locative phrase for a tile: "on the banks of the Tiren", "by the Varan Sea". */
export function placePhrase(world, x, y) {
  const { W, f } = world;
  const xi = Math.max(0, Math.min(W - 1, Math.round(x))), yi = Math.max(0, Math.min(world.H - 1, Math.round(y)));
  const i = yi * W + xi;
  const idx = featureIndex(world);
  const opts = [];
  if (f.river[i] >= 2) {
    const r = nearest(idx.river, xi, yi, 16);
    if (r) { const n = withArticle(r.name, 'river'); opts.push(`on the banks of ${n}`, `beside ${n}`); }
  }
  if (f.coast[i]) {
    const s = nearest(idx.sea, xi, yi, 55);
    if (s) { const n = withArticle(s.name, 'sea'); opts.push(`on the shores of ${n}`, `by ${n}`); }
  }
  if (opts.length) return pick(world, opts);
  if (f.elevation[i] >= 0.62) {
    const m = nearest(idx.range, xi, yi, 22);
    if (m) return `in the hills below ${withArticle(m.name, 'range')}`;
  }
  const b = f.biome[i];
  if (b === BIOME.HOT_DESERT || b === BIOME.COLD_DESERT) {
    const d = nearest(idx.desert, xi, yi, 26);
    if (d) return `at the edge of ${withArticle(d.name, 'desert')}`;
  }
  if (b === BIOME.TEMPERATE_FOREST || b === BIOME.TAIGA || b === BIOME.RAINFOREST || b === BIOME.TROPICAL_FOREST || b === BIOME.TEMPERATE_RAINFOREST) {
    const fo = nearest(idx.forest, xi, yi, 20);
    if (fo) return `in ${withArticle(fo.name, 'forest')}`;
  }
  return pick(world, BIOME_PHRASES[b] || ['in the wilderness']);
}
/** The named river nearest a tile (with article), if the tile is on a river. */
export function riverAt(world, x, y) {
  const i = Math.round(y) * world.W + Math.round(x);
  if (!(world.f.river[i] >= 1)) return null;
  return featureNear(world, 'river', x, y, 16);
}
/** "the hills", "the coast" — what lies around a town, for flavour. */
export function terrainNoun(world, s) {
  const { f } = world;
  if (f.coast[s.i]) return 'the coast';
  if (f.river[s.i] >= 2) return 'the river';
  if (f.elevation[s.i] >= 0.62) return 'the hills';
  const b = f.biome[s.i];
  if (b === BIOME.STEPPE || b === BIOME.SAVANNA) return 'the plains';
  if (b === BIOME.WETLAND) return 'the marshes';
  return 'the woods';
}
export const isLakeside = (world, s) => {
  const { W, H, f } = world;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = s.x + dx, y = s.y + dy;
    if (x >= 0 && y >= 0 && x < W && y < H && f.water[y * W + x] === WATER.LAKE) return true;
  }
  return false;
};

/** A quarter of a town, for fires, riots and plague. */
export function quarter(world, s) {
  const pool = ['the potters’ quarter', 'the tanners’ lanes', 'the old market', 'the weavers’ street', 'the lower town', 'the temple hill', 'the bakers’ row'];
  if (world.f.coast[s.i]) pool.push('the harbour quarter', 'the fish market');
  if (world.f.river[s.i] >= 1) pool.push('the river quarter', 'the mills by the river');
  return pick(world, pool);
}
