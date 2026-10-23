// Architecture: how each people builds (civ.style, drawn by the renderer's city plans and
// settlement glyphs). Chosen once, when the realm is born, from the hash of its tongue and the
// climate of its homeland — flat-roofed mudbrick on the desert rim, steep timber and
// longhouses in the cold north, pagodas and stupas in the wet tropics. A breakaway realm keeps
// its parent's manner with a small change, so cultural lineages show on the map; conquered
// towns keep their founders' look (the renderer reads the style of s.originCivId). A people's
// own forms (ext 'archStyle', e.g. elven tree-halls) override the drawn ones.
// Pure: no rng, so choosing a style never shifts the world's random stream.
//
// civ.style = { roof, wall, temple, layout, palette: [r, g, b], race? }
//   roof    pitched | flat | dome | pagoda | thatch | longhouse
//   wall    mudbrick | timber | whitewash | stone | brick
//   temple  ziggurat | stupa | basilica | onion | pyramid
//   layout  organic | grid | ring

import { BIOME } from '../../core/constants.js';
import { firstOf, hasProviders } from '../../core/ext.js';

export const ROOFS = ['pitched', 'flat', 'dome', 'pagoda', 'thatch', 'longhouse'];
export const WALLS = ['mudbrick', 'timber', 'whitewash', 'stone', 'brick'];
export const TEMPLES = ['ziggurat', 'stupa', 'basilica', 'onion', 'pyramid'];
export const LAYOUTS = ['organic', 'grid', 'ring'];

/** Roof colour families (the palette is the roof tone, kept within the atlas's ink and parchment). */
const ROOF_TONE = {
  pitched: [152, 78, 56], flat: [196, 168, 124], dome: [206, 198, 180],
  pagoda: [86, 104, 92], thatch: [178, 150, 96], longhouse: [108, 86, 64],
};

/** 32-bit FNV-1a over a string. */
function fnv(str, h = 0x811c9dc5) {
  for (let k = 0; k < str.length; k++) { h ^= str.charCodeAt(k); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
const mix = (h, salt) => { let x = (h ^ Math.imul(salt + 0x9e3779b9, 0x85ebca6b)) >>> 0; x ^= x >>> 15; x = Math.imul(x, 0x2c1b3c6d) >>> 0; x ^= x >>> 12; return x >>> 0; };
const choose = (arr, h) => arr[h % arr.length];

/** A stable hash of a people's tongue (its sounds and suffixes). */
function tongueHash(civ) {
  const L = civ.language || {};
  const parts = [L.onsets, L.codas, L.vowels, L.placeSuffixes].map((a) => (Array.isArray(a) ? a.join(',') : '')).join('|');
  return fnv(parts + '|' + (L.adjSuffix || '') + '|' + (civ.baseName || civ.name || ''));
}

function homeland(world, civ) {
  const W = world.W, H = world.H;
  const cap = civ.capitalId != null ? world.settlements[civ.capitalId] : null;
  const x = Math.max(0, Math.min(W - 1, Math.round(Number.isFinite(civ.originX) ? civ.originX : cap ? cap.x : W / 2)));
  const y = Math.max(0, Math.min(H - 1, Math.round(Number.isFinite(civ.originY) ? civ.originY : cap ? cap.y : H / 2)));
  const i = y * W + x;
  return { b: world.f.biome[i], t: world.f.annTemp ? world.f.annTemp[i] : 12, hill: world.f.elevation[i] >= 0.62 };
}

/** Draw a style for a people with no parent to follow. */
function freshStyle(world, civ) {
  const h = tongueHash(civ);
  const { b, t, hill } = homeland(world, civ);
  const hot = t > 19, cold = t < 5;
  const dry = b === BIOME.HOT_DESERT || b === BIOME.COLD_DESERT || b === BIOME.SAVANNA || b === BIOME.SHRUBLAND || b === BIOME.STEPPE;
  const wet = b === BIOME.RAINFOREST || b === BIOME.TROPICAL_FOREST || b === BIOME.WETLAND;
  const h1 = mix(h, 1), h2 = mix(h, 2), h3 = mix(h, 3), h4 = mix(h, 4);
  let roof, wall, temple;
  if (hot && dry) { roof = choose(['flat', 'flat', 'dome', 'flat'], h1); wall = choose(['mudbrick', 'whitewash', 'mudbrick', 'stone'], h2); temple = choose(['ziggurat', 'pyramid', 'onion', 'ziggurat'], h3); }
  else if (hot && wet) { roof = choose(['thatch', 'pagoda', 'thatch', 'pagoda'], h1); wall = choose(['timber', 'mudbrick', 'timber'], h2); temple = choose(['stupa', 'pyramid', 'ziggurat', 'stupa'], h3); }
  else if (cold) { roof = choose(['pitched', 'longhouse', 'pitched', 'longhouse'], h1); wall = choose(['timber', 'stone', 'timber'], h2); temple = choose(['basilica', 'onion', 'stupa', 'onion'], h3); }
  else if (dry) { roof = choose(['flat', 'pitched', 'dome', 'thatch'], h1); wall = choose(['mudbrick', 'stone', 'whitewash', 'brick'], h2); temple = choose(['ziggurat', 'basilica', 'onion', 'pyramid'], h3); }
  else { roof = choose(['pitched', 'pitched', 'pagoda', 'thatch', 'dome'], h1); wall = choose(['timber', 'stone', 'brick', 'whitewash'], h2); temple = choose(['basilica', 'onion', 'stupa', 'ziggurat'], h3); }
  if (hill && wall === 'timber' && (h4 & 3) === 0) wall = 'stone';
  const layout = choose(['organic', 'organic', 'grid', 'ring', 'organic'], mix(h, 5));
  return { roof, wall, temple, layout, palette: tone(roof, mix(h, 6)) };
}

/** The roof tone of a style, jittered a little per people. */
function tone(roof, h) {
  const base = ROOF_TONE[roof] || ROOF_TONE.pitched;
  const j = ((h % 1000) / 1000 - 0.5) * 0.16;
  return [Math.round(base[0] * (1 + j)), Math.round(base[1] * (1 + j * 0.6)), Math.round(base[2] * (1 - j * 0.4))].map((v) => Math.max(0, Math.min(255, v)));
}

/** A daughter realm's style: the parent's, with one thing done differently now and then. */
function inherited(world, civ, ps) {
  const h = mix(tongueHash(civ), 7 + civ.id);
  const st = { roof: ps.roof, wall: ps.wall, temple: ps.temple, layout: ps.layout, palette: Array.isArray(ps.palette) ? ps.palette.slice(0, 3) : tone(ps.roof, h) };
  if (ps.race) st.race = ps.race;
  const pick = h % 8;
  if (pick === 0) st.layout = choose(LAYOUTS, mix(h, 11));
  else if (pick === 1) st.temple = choose(TEMPLES, mix(h, 12));
  else if (pick === 2) st.wall = choose(WALLS, mix(h, 13));
  const j = ((mix(h, 14) % 1000) / 1000 - 0.5) * 0.08;
  st.palette = st.palette.map((v) => Math.max(0, Math.min(255, Math.round(v * (1 + j)))));
  return st;
}

function valid(st) {
  return st && ROOFS.includes(st.roof) && WALLS.includes(st.wall) && TEMPLES.includes(st.temple) && LAYOUTS.includes(st.layout)
    && Array.isArray(st.palette) && st.palette.length >= 3 && st.palette.every(Number.isFinite);
}

/** Choose a civ's style (pure). */
export function pickStyle(world, civ) {
  const parent = civ.parentId != null ? world.civs[civ.parentId] : null;
  let st = parent && valid(parent.style) ? inherited(world, civ, parent.style) : freshStyle(world, civ);
  if (hasProviders('archStyle')) {
    const own = firstOf('archStyle', world, civ);
    if (own && typeof own === 'object') {
      st = { ...st };
      if (ROOFS.includes(own.roof)) st.roof = own.roof;
      if (WALLS.includes(own.wall)) st.wall = own.wall;
      if (TEMPLES.includes(own.temple)) st.temple = own.temple;
      if (LAYOUTS.includes(own.layout)) st.layout = own.layout;
      if (Array.isArray(own.palette) && own.palette.length >= 3 && own.palette.every(Number.isFinite)) st.palette = own.palette.slice(0, 3).map((v) => Math.round(v));
      if (typeof own.race === 'string') st.race = own.race;
    }
  }
  if (civ.race && !st.race) st.race = civ.race;
  return st;
}

/** Give a civ its style if it has none (new realms, and realms from saves made before styles). */
export function ensureStyle(world, civ) {
  if (!civ || valid(civ.style)) return civ?.style ?? null;
  civ.style = pickStyle(world, civ);
  return civ.style;
}

const ROOF_WORD = { pitched: 'steep-roofed', flat: 'flat-roofed', dome: 'domed', pagoda: 'pagoda-roofed', thatch: 'thatched', longhouse: 'longhouse' };
const WALL_WORD = { mudbrick: 'mudbrick', timber: 'timber', whitewash: 'whitewashed', stone: 'stone', brick: 'brick' };
const TEMPLE_WORD = { ziggurat: 'ziggurats', stupa: 'stupas', basilica: 'basilicas', onion: 'onion-domed temples', pyramid: 'pyramid temples' };
/** "whitewashed, domed houses and ziggurats" — for the Inspector and prose. */
export function styleWords(st) {
  if (!valid(st)) return '';
  const house = st.roof === 'longhouse' ? `${WALL_WORD[st.wall]} longhouses` : `${WALL_WORD[st.wall]}, ${ROOF_WORD[st.roof]} houses`;
  return `${house} and ${TEMPLE_WORD[st.temple]}`;
}
