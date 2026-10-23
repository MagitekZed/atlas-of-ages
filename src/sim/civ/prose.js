// Prose helpers for civilization chronicle entries: civ and ruler naming, number wording,
// list joining and geographic phrases built from world.features ("on the banks of the
// Tiren", "by the Varan Sea"). All randomness uses world.rng so text is reproducible.

import { BIOME, WATER } from '../../core/constants.js';
import { capitalize } from '../../core/util.js';
import { makePlace, isEnglishWord } from '../../core/names.js';

// Generated words that read as English in a sentence ("the Holy See of The") are never
// used as names of places or peoples (the list lives with the generator: core/names.js).
export const goodName = (name) => typeof name === 'string' && name.length >= 3 && !isEnglishWord(name);

/** Names already used by settlements and nations (cached in the kernel's name set when present). */
function takenNames(world) {
  const c = world.cache;
  if (!c.settleNames) c.settleNames = new Set(world.settlements.map((s) => s.name));
  return c.settleNames;
}

/** A fresh, sensible place name in a language (never a stray English word, rarely a repeat). */
export function freshPlaceName(world, lang) {
  const taken = takenNames(world);
  let name = null;
  for (let k = 0; k < 10; k++) {
    const n = makePlace(lang, world.rng);
    if (!goodName(n)) continue;
    name = n;
    if (!taken.has(n)) break;
  }
  if (!name) name = 'Nova' + makePlace(lang, world.rng).toLowerCase().replace(/[^a-z]/g, '').slice(0, 5);
  return name;   // createSettlement adds it to the shared name set once the town exists
}

/** True if a living nation already goes by this base name. */
export function civNameTaken(world, name) {
  for (const c of world.civs) if (c.alive && c.baseName === name) return true;
  return false;
}

export const pick = (world, arr) => arr[Math.floor(world.rng.next() * arr.length)];

/** Integer with thousands separators (locale-independent so saved text is stable). */
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

/** Rounded headcount for prose: 3,412 → "3,400"; 128,000 → "130,000"; 950 → "950". */
export function approx(n) {
  const v = Math.max(0, Number.isFinite(n) ? n : 0);
  if (v < 100) return String(Math.max(1, Math.round(v / 5) * 5 || Math.round(v)));
  const mag = Math.pow(10, Math.floor(Math.log10(v)) - 1);
  return fmtInt(Math.round(v / mag) * mag);
}

/** "some 3,400 people", "nearly a million souls" */
export function peopleCount(world, n, noun = null) {
  const v = Math.max(0, Number.isFinite(n) ? n : 0);
  const word = noun || pick(world, ['people', 'souls', 'people']);
  if (v >= 950000 && v < 1050000) return `about a million ${word}`;
  if (v >= 1e6) return `some ${(Math.round(v / 1e5) / 10).toString()} million ${word}`;
  return `${pick(world, ['some', 'about', 'nearly', 'some'])} ${approx(v)} ${word}`;
}

export function listJoin(items) {
  const a = items.filter(Boolean);
  if (a.length <= 1) return a[0] || '';
  return a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
}

export function roman(n) {
  const v = Math.max(1, Math.min(3999, Math.round(n)));
  const table = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '', r = v;
  for (const [k, s] of table) while (r >= k) { out += s; r -= k; }
  return out;
}

/** "the Kingdom of Varath" (styled names always take an article mid-sentence). */
export function theName(civ) {
  if (!civ) return 'a forgotten people';
  return civ.flags?.styled ? 'the ' + civ.name : civ.name;
}
export const TheName = (civ) => capitalize(theName(civ));
/** Does the civ's styled name take a plural verb ("the Varathi Clans were…")? */
export const pluralCiv = (civ) => Boolean(civ && /\b(Tribes|Clans|Cities|Provinces)\b|^People of\b/.test(civ.name || ''));
/** Agree a past-tense phrase with a civ name: "was conquered" → "were conquered", its → their. */
export const agree = (civ, phrase) => (pluralCiv(civ) ? phrase.replace(/^was\b/, 'were').replace(/\bits\b/g, 'their') : phrase);
/**
 * Plural demonym from a civ adjective: Mathnian → Mathnians, Uondan → Uondans, Varathi and
 * Elish stay as they are, Zethvic → Zethvic people.
 */
export function demonym(adj) {
  const a = String(adj || '');
  if (!a) return 'people';
  if (/(ian|an|ar|ene|er|en|ite)$/i.test(a)) return a + 's';
  if (/ic$/i.test(a)) return a + ' people';
  return a; // -i, -ish, -ese and the like are already plural
}
/** Collective people name: "the Varathi", "the Mathnians". */
export const peopleOf = (civ) => (civ ? 'the ' + demonym(civ.adjective) : 'a forgotten people');
export const PeopleOf = (civ) => capitalize(peopleOf(civ));

/** "Queen Ilsa II the Wise" */
export function rulerName(r, withEpithet = true) {
  if (!r) return 'an unknown ruler';
  const reg = r.regnal > 1 ? ' ' + roman(r.regnal) : '';
  const ep = withEpithet && r.epithet ? ' ' + r.epithet : '';
  return `${r.title ? r.title + ' ' : ''}${r.name}${reg}${ep}`;
}
/** "Ilsa II" */
export function rulerShort(r) {
  if (!r) return 'the ruler';
  return `${r.name}${r.regnal > 1 ? ' ' + roman(r.regnal) : ''}`;
}

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
  const c = (world.cache.civ ||= {});
  const v = world.versions.features || 0;
  if (c.featIdx && c.featIdxV === v && c.featIdxN === world.features.length) return c.featIdx;
  const idx = { river: [], sea: [], lake: [], range: [], desert: [], forest: [], island: [], continent: [] };
  for (const ft of world.features || []) {
    if (!ft || !ft.name || !Number.isFinite(ft.x) || !Number.isFinite(ft.y)) continue;
    const k = ft.kind === 'ocean' ? 'sea' : ft.kind;
    if (idx[k]) idx[k].push(ft);
  }
  c.featIdx = idx; c.featIdxV = v; c.featIdxN = world.features.length;
  return idx;
}

function nearestFeature(list, x, y, maxD) {
  let best = null, bd = maxD * maxD;
  for (const ft of list) {
    const d = (ft.x - x) ** 2 + (ft.y - y) ** 2;
    if (d < bd) { bd = d; best = ft; }
  }
  return best;
}

/** Name of the nearest sea/ocean feature (with article), or null. */
export function seaNameNear(world, x, y, maxD = 60) {
  const ft = nearestFeature(featureIndex(world).sea, x, y, maxD);
  return ft ? withArticle(ft.name, 'sea') : null;
}

/** Name (with article) of the nearest feature of a kind ('river', 'range', 'lake', 'forest', 'desert', 'sea') within maxD tiles, or null. */
export function featureNameNear(world, x, y, kind, maxD = 20) {
  const list = featureIndex(world)[kind];
  const ft = list ? nearestFeature(list, x, y, maxD) : null;
  return ft ? withArticle(ft.name, kind) : null;
}

/** Name of the continent or large island containing (x, y), or null. */
export function landNameAt(world, x, y) {
  const { W, f } = world;
  const i = Math.round(y) * W + Math.round(x);
  const lm = f.landmass[i];
  if (lm == null || lm < 0) return null;
  const idx = featureIndex(world);
  for (const ft of idx.continent.concat(idx.island)) {
    const j = Math.round(ft.y) * W + Math.round(ft.x);
    if (j >= 0 && j < world.N && f.landmass[j] === lm) return withArticle(ft.name, ft.kind);
  }
  return null;
}

const BIOME_PHRASES = {
  [BIOME.TUNDRA]: ['on the frozen tundra', 'on the bleak northern plains', 'amid the tundra mosses'],
  [BIOME.TAIGA]: ['amid the northern pines', 'deep in the boreal woods', 'in the dark taiga'],
  [BIOME.STEPPE]: ['on the open grasslands', 'out on the wide steppe', 'among the tall grasses'],
  [BIOME.SHRUBLAND]: ['in the dry scrublands', 'among the thorny hills', 'in the scrub country'],
  [BIOME.TEMPERATE_FOREST]: ['in the wooded lowlands', 'among the oak forests', 'in a forest clearing'],
  [BIOME.TEMPERATE_RAINFOREST]: ['in the misty rainforests', 'beneath the great dripping trees'],
  [BIOME.HOT_DESERT]: ['in the burning desert', 'at an oasis in the desert', 'among the dunes'],
  [BIOME.COLD_DESERT]: ['in the cold barrens', 'on the windswept plateau'],
  [BIOME.SAVANNA]: ['on the savanna', 'among the acacia plains'],
  [BIOME.TROPICAL_FOREST]: ['in the dry tropical woods', 'in the monsoon forests'],
  [BIOME.RAINFOREST]: ['deep in the rainforest', 'beneath the jungle canopy'],
  [BIOME.WETLAND]: ['among the marshes', 'in the reed-fens', 'on the edge of the great marsh'],
  [BIOME.ALPINE]: ['high in the mountains', 'among the mountain passes'],
  [BIOME.ICE]: ['on the edge of the ice', 'among the glaciers'],
};

/**
 * A short locative phrase for a tile, e.g. "on the banks of the Tiren", "by the Varan Sea",
 * "in the foothills of the Kesh Range", "on the open grasslands". Never empty.
 */
export function placePhrase(world, x, y) {
  const { W, f } = world;
  const xi = Math.max(0, Math.min(W - 1, Math.round(x))), yi = Math.max(0, Math.min(world.H - 1, Math.round(y)));
  const i = yi * W + xi;
  const idx = featureIndex(world);
  const opts = [];
  if (f.river[i] >= 2) {
    const r = nearestFeature(idx.river, xi, yi, 16);
    if (r) {
      const n = withArticle(r.name, 'river');
      opts.push(`on the banks of ${n}`, `beside ${n}`, `where ${n} runs`);
    } else opts.push('beside a broad river', 'on the banks of a great river');
  }
  let nearLake = false;
  for (let dy = -1; dy <= 1 && !nearLake; dy++) for (let dx = -1; dx <= 1; dx++) {
    const nx = xi + dx, ny = yi + dy;
    if (nx >= 0 && ny >= 0 && nx < W && ny < world.H && f.water[ny * W + nx] === WATER.LAKE) { nearLake = true; break; }
  }
  if (nearLake) {
    const l = nearestFeature(idx.lake, xi, yi, 14);
    opts.push(l ? `on the shores of ${withArticle(l.name, 'lake')}` : 'on the shore of a lake');
  }
  if (f.coast[i]) {
    const s = nearestFeature(idx.sea, xi, yi, 55);
    if (s) {
      const n = withArticle(s.name, 'sea');
      opts.push(`on the shores of ${n}`, `by ${n}`, `on the coast of ${n}`);
    } else opts.push('on the coast', 'by the sea');
  }
  if (opts.length) return pick(world, opts);
  if (f.elevation[i] >= 0.62) {
    const m = nearestFeature(idx.range, xi, yi, 22);
    if (m) {
      const n = withArticle(m.name, 'range');
      return pick(world, f.elevation[i] >= 0.75 ? [`high in ${n}`, `among the peaks of ${n}`] : [`in the foothills of ${n}`, `in the hills below ${n}`]);
    }
    return f.elevation[i] >= 0.75 ? 'high in the mountains' : pick(world, ['in the hills', 'among rolling hills']);
  }
  const b = f.biome[i];
  if (b === BIOME.HOT_DESERT || b === BIOME.COLD_DESERT) {
    const d = nearestFeature(idx.desert, xi, yi, 26);
    if (d) { const n = withArticle(d.name, 'desert'); return pick(world, [`in ${n}`, `at the edge of ${n}`]); }
  }
  if (b === BIOME.TEMPERATE_FOREST || b === BIOME.TAIGA || b === BIOME.RAINFOREST || b === BIOME.TROPICAL_FOREST || b === BIOME.TEMPERATE_RAINFOREST) {
    const fo = nearestFeature(idx.forest, xi, yi, 20);
    if (fo) { const n = withArticle(fo.name, 'forest'); return pick(world, [`deep in ${n}`, `in ${n}`, `at the eaves of ${n}`]); }
  }
  return pick(world, BIOME_PHRASES[b] || ['in the wilderness']);
}

/** Season word for a settlement's latitude this month ("winter", "summer"…). */
export function seasonWord(world, y) {
  const m = Math.floor(world.time.day / 30) % 12;
  const north = y < world.H / 2;
  const n = [0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 0][m];
  const s = north ? n : (n + 2) % 4;
  return ['winter', 'spring', 'summer', 'autumn'][s];
}
