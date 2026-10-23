// Colours for the hand-tinted atlas: biome tints, data ramps, ink and parchment, plus small
// colour helpers shared by every render module. Pure data + math (no DOM).

import { BIOME, BIOMES, ERAS, RESOURCES } from '../core/constants.js';
import { hexToRgb, hslToRgb, clamp01 } from '../core/util.js';

export const INK = [44, 34, 26];
export const INK_SOFT = [70, 58, 46];
export const PARCHMENT = [238, 228, 204];
export const HALO = [244, 236, 214];
export const BRASS = [214, 172, 92];
export const MAP_BG = '#0b1219';

// Natural-atlas biome tints: `LUSH` is the fully vegetated look, `BARE` the ground beneath.
const B = BIOME;
export const LUSH = [];
export const BARE = [];
LUSH[B.DEEP_OCEAN] = [22, 50, 88]; BARE[B.DEEP_OCEAN] = [22, 50, 88];
LUSH[B.OCEAN] = [52, 112, 140]; BARE[B.OCEAN] = [52, 112, 140];
LUSH[B.LAKE] = [74, 132, 156]; BARE[B.LAKE] = [74, 132, 156];
LUSH[B.ICE] = [234, 239, 242]; BARE[B.ICE] = [226, 232, 236];
LUSH[B.TUNDRA] = [150, 156, 124]; BARE[B.TUNDRA] = [160, 150, 126];
LUSH[B.TAIGA] = [66, 98, 74]; BARE[B.TAIGA] = [132, 122, 98];
LUSH[B.STEPPE] = [170, 176, 104]; BARE[B.STEPPE] = [200, 182, 132];
LUSH[B.SHRUBLAND] = [150, 150, 96]; BARE[B.SHRUBLAND] = [196, 176, 130];
LUSH[B.TEMPERATE_FOREST] = [86, 126, 70]; BARE[B.TEMPERATE_FOREST] = [158, 138, 102];
LUSH[B.TEMPERATE_RAINFOREST] = [56, 104, 76]; BARE[B.TEMPERATE_RAINFOREST] = [128, 118, 94];
LUSH[B.HOT_DESERT] = [228, 204, 152]; BARE[B.HOT_DESERT] = [230, 206, 154];
LUSH[B.COLD_DESERT] = [200, 188, 152]; BARE[B.COLD_DESERT] = [206, 192, 156];
LUSH[B.SAVANNA] = [182, 174, 98]; BARE[B.SAVANNA] = [210, 184, 124];
LUSH[B.TROPICAL_FOREST] = [104, 136, 66]; BARE[B.TROPICAL_FOREST] = [176, 150, 104];
LUSH[B.RAINFOREST] = [46, 104, 58]; BARE[B.RAINFOREST] = [150, 116, 84];
LUSH[B.WETLAND] = [92, 122, 98]; BARE[B.WETLAND] = [128, 124, 100];
LUSH[B.ALPINE] = [148, 144, 132]; BARE[B.ALPINE] = [146, 140, 130];
for (let k = 0; k < BIOMES.length; k++) { if (!LUSH[k]) LUSH[k] = BIOMES[k].color.slice(); if (!BARE[k]) BARE[k] = LUSH[k]; }

/** How strongly each biome turns with the seasons (deciduous leaf-fall, grass curing). */
export const SEASONAL = new Float32Array(BIOMES.length);
SEASONAL[B.TEMPERATE_FOREST] = 1; SEASONAL[B.SHRUBLAND] = 0.55; SEASONAL[B.STEPPE] = 0.6;
SEASONAL[B.TUNDRA] = 0.6; SEASONAL[B.TAIGA] = 0.18; SEASONAL[B.WETLAND] = 0.45;
SEASONAL[B.TROPICAL_FOREST] = 0.35; SEASONAL[B.SAVANNA] = 0.35; SEASONAL[B.TEMPERATE_RAINFOREST] = 0.25;
/** Grassy biomes that cure to straw when the soil dries. */
export const GRASSY = new Float32Array(BIOMES.length);
GRASSY[B.STEPPE] = 1; GRASSY[B.SAVANNA] = 1; GRASSY[B.SHRUBLAND] = 0.7; GRASSY[B.TUNDRA] = 0.4; GRASSY[B.TROPICAL_FOREST] = 0.4;

export const AUTUMN = [178, 116, 58];
export const WINTER_BROWN = [128, 114, 94];
export const STRAW = [212, 190, 124];
export const ROCK = [148, 138, 124];
export const SNOW = [244, 246, 249];
export const SEA_ICE = [226, 234, 239];
export const CHARCOAL = [72, 60, 50];
export const RUST = [146, 78, 48];
export const SMOG = [112, 106, 114];
export const URBAN = [150, 132, 116];
export const RIVER = [66, 112, 146];
export const RIVER_MUTED = [112, 148, 170];

/**
 * Building materials of a culture's style (civ.style.wall): ground of its streets, wall faces
 * and flat roofs. Shared by the town plans and the settlement icons.
 */
export const MATERIAL = {
  mudbrick: { ground: [178, 152, 112], face: [214, 182, 132], flat: [214, 186, 140] },
  timber: { ground: [160, 140, 106], face: [198, 164, 118], flat: [164, 128, 90] },
  whitewash: { ground: [178, 166, 142], face: [242, 238, 228], flat: [228, 220, 202] },
  stone: { ground: [164, 158, 144], face: [214, 206, 188], flat: [190, 184, 172] },
  brick: { ground: [168, 150, 126], face: [196, 122, 92], flat: [172, 110, 86] },
};
/** Roof forms (civ.style.roof) and the colour each takes by default. */
export const ROOF_COLOR = { pitched: [168, 82, 58], flat: [206, 176, 128], dome: [226, 220, 204], pagoda: [86, 96, 92], thatch: [196, 168, 104], longhouse: [124, 104, 78] };

// Biome-mode swatches: flatter and more distinct than the natural tints.
export const BIOME_FLAT = [];
BIOME_FLAT[B.DEEP_OCEAN] = [28, 54, 92]; BIOME_FLAT[B.OCEAN] = [54, 104, 146]; BIOME_FLAT[B.LAKE] = [80, 140, 170];
BIOME_FLAT[B.ICE] = [238, 242, 246]; BIOME_FLAT[B.TUNDRA] = [156, 166, 140]; BIOME_FLAT[B.TAIGA] = [56, 104, 92];
BIOME_FLAT[B.STEPPE] = [196, 196, 108]; BIOME_FLAT[B.SHRUBLAND] = [170, 152, 98]; BIOME_FLAT[B.TEMPERATE_FOREST] = [92, 146, 72];
BIOME_FLAT[B.TEMPERATE_RAINFOREST] = [40, 120, 96]; BIOME_FLAT[B.HOT_DESERT] = [238, 210, 140]; BIOME_FLAT[B.COLD_DESERT] = [190, 176, 150];
BIOME_FLAT[B.SAVANNA] = [214, 178, 84]; BIOME_FLAT[B.TROPICAL_FOREST] = [128, 160, 60]; BIOME_FLAT[B.RAINFOREST] = [30, 112, 52];
BIOME_FLAT[B.WETLAND] = [86, 140, 130]; BIOME_FLAT[B.ALPINE] = [150, 140, 150];

// ---------------------------------------------------------------------------
// Ramps: 256-entry RGB lookup tables built from [t, [r,g,b]] stops.

export function makeRamp(stops) {
  const lut = new Uint8Array(256 * 3);
  for (let k = 0; k < 256; k++) {
    const t = k / 255;
    let j = 0;
    while (j < stops.length - 2 && t > stops[j + 1][0]) j++;
    const [t0, c0] = stops[j], [t1, c1] = stops[Math.min(j + 1, stops.length - 1)];
    const u = t1 > t0 ? clamp01((t - t0) / (t1 - t0)) : 0;
    const s = u * u * (3 - 2 * u) * 0.35 + u * 0.65; // slightly eased for painterly bands
    lut[k * 3] = Math.round(c0[0] + (c1[0] - c0[0]) * s);
    lut[k * 3 + 1] = Math.round(c0[1] + (c1[1] - c0[1]) * s);
    lut[k * 3 + 2] = Math.round(c0[2] + (c1[2] - c0[2]) * s);
  }
  return { lut, stops };
}
/** Sample a ramp at t ∈ [0,1] → [r,g,b]. */
export function rampAt(ramp, t) {
  const k = Math.max(0, Math.min(255, Math.round((Number.isFinite(t) ? t : 0) * 255))) * 3;
  return [ramp.lut[k], ramp.lut[k + 1], ramp.lut[k + 2]];
}

export const RAMPS = {
  seaNatural: makeRamp([[0, [112, 172, 172]], [0.035, [80, 148, 160]], [0.1, [56, 118, 146]], [0.24, [36, 84, 124]], [0.5, [24, 56, 96]], [1, [16, 38, 72]]]),
  seaMuted: makeRamp([[0, [204, 216, 210]], [0.08, [186, 204, 204]], [0.3, [166, 188, 196]], [1, [146, 170, 186]]]),
  seaData: makeRamp([[0, [96, 116, 128]], [0.3, [70, 88, 104]], [1, [46, 60, 78]]]),
  seaHypso: makeRamp([[0, [176, 214, 222]], [0.06, [132, 186, 210]], [0.2, [86, 146, 194]], [0.5, [48, 98, 160]], [1, [24, 52, 108]]]),
  landHypso: makeRamp([[0, [86, 138, 86]], [0.04, [116, 156, 94]], [0.12, [170, 180, 112]], [0.24, [214, 200, 136]], [0.38, [196, 156, 104]], [0.55, [160, 116, 86]], [0.72, [142, 120, 112]], [0.86, [204, 198, 196]], [1, [250, 250, 252]]]),
  temperature: makeRamp([[0, [42, 40, 120]], [0.17, [60, 96, 180]], [0.33, [120, 176, 216]], [0.45, [210, 232, 230]], [0.55, [246, 236, 196]], [0.66, [246, 196, 110]], [0.78, [228, 120, 62]], [0.9, [176, 44, 44]], [1, [100, 16, 40]]]),
  rainfall: makeRamp([[0, [196, 150, 96]], [0.08, [222, 196, 132]], [0.2, [208, 214, 140]], [0.35, [134, 188, 112]], [0.55, [66, 156, 120]], [0.75, [44, 120, 150]], [1, [36, 66, 140]]]),
  vegetation: makeRamp([[0, [226, 210, 168]], [0.15, [206, 196, 132]], [0.35, [160, 176, 98]], [0.6, [96, 148, 72]], [0.8, [52, 112, 56]], [1, [24, 76, 40]]]),
  herb: makeRamp([[0, [236, 230, 210]], [0.2, [220, 206, 156]], [0.45, [186, 170, 96]], [0.7, [136, 128, 60]], [1, [88, 82, 38]]]),
  fish: makeRamp([[0, [190, 206, 214]], [0.3, [126, 170, 196]], [0.6, [62, 128, 176]], [1, [24, 78, 140]]]),
  population: makeRamp([[0, [34, 38, 52]], [0.15, [60, 52, 60]], [0.35, [126, 76, 50]], [0.55, [206, 128, 52]], [0.75, [246, 196, 96]], [0.9, [255, 236, 176]], [1, [255, 252, 240]]]),
  devastation: makeRamp([[0, [226, 216, 190]], [0.25, [214, 170, 120]], [0.5, [192, 112, 66]], [0.75, [150, 58, 40]], [1, [86, 22, 24]]]),
  pollution: makeRamp([[0, [222, 220, 204]], [0.25, [190, 186, 182]], [0.5, [150, 140, 156]], [0.75, [108, 92, 120]], [1, [62, 46, 72]]]),
  era: makeRamp([[0, [120, 98, 120]], [0.14, [92, 104, 160]], [0.28, [60, 136, 168]], [0.43, [64, 160, 132]], [0.57, [130, 180, 90]], [0.71, [214, 190, 76]], [0.86, [232, 128, 64]], [1, [196, 56, 76]]]),
  mineral: makeRamp([[0, [0, 0, 0]], [1, [190, 110, 60]]]),
  stress: makeRamp([[0, [0, 0, 0]], [0.5, [214, 120, 60]], [1, [190, 40, 40]]]),
};

/** Era colour for the tech map mode. */
export const eraColor = (era) => rampAt(RAMPS.era, clamp01((era || 0) / Math.max(1, ERAS.length - 1)));

/** Distinct colour for plate k. */
const PLATE_INKS = [
  [205, 186, 150], [168, 190, 168], [184, 170, 196], [210, 172, 150], [160, 186, 198], [212, 200, 152],
  [186, 160, 168], [150, 176, 160], [196, 184, 176], [176, 196, 186], [204, 164, 176], [172, 172, 150],
  [190, 204, 172], [168, 160, 186], [214, 188, 170], [156, 170, 186],
];
/** Plate k's ink: muted survey-sheet colours (ochre, sage, slate, rose, sand…). */
export function plateColor(k) {
  const n = PLATE_INKS.length, base = PLATE_INKS[((k % n) + n) % n];
  if (k < n) return base;
  const t = ((k * 0.618034) % 1) * 0.16 - 0.08; // later plates: slight variations
  return [base[0] * (1 + t), base[1] * (1 - t * 0.5), base[2] * (1 + t * 0.3)];
}

export const resourceColor = (id) => (RESOURCES[id] ? RESOURCES[id].color : [0, 0, 0]);

// ---------------------------------------------------------------------------
// Colour helpers

/** Accepts [r,g,b], '#rgb', '#rrggbb', 'rgb(...)', 'hsl(h, s%, l%)' → [r,g,b]; null if unparseable. */
export function parseColor(c) {
  if (!c) return null;
  if (Array.isArray(c)) return c.length >= 3 && c.every((v) => Number.isFinite(v)) ? [c[0], c[1], c[2]] : null;
  if (typeof c !== 'string') return null;
  const s = c.trim();
  if (s[0] === '#') {
    if (s.length === 4) return [parseInt(s[1] + s[1], 16), parseInt(s[2] + s[2], 16), parseInt(s[3] + s[3], 16)];
    if (s.length >= 7) { const v = hexToRgb(s.slice(0, 7)); return v.every(Number.isFinite) ? v : null; }
    return null;
  }
  let m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  m = s.match(/^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/i);
  if (m) return hslToRgb(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100);
  return null;
}

export const css = (c, a = 1) => (a >= 1 ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.max(0, a).toFixed(3)})`);
export const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const darken = (c, k) => [c[0] * (1 - k), c[1] * (1 - k), c[2] * (1 - k)];
export const lighten = (c, k) => [c[0] + (255 - c[0]) * k, c[1] + (255 - c[1]) * k, c[2] + (255 - c[2]) * k];
/** Rec. 601 luma 0..255. */
export const luma = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
/** Pull a colour toward a cartographic tint: slightly desaturated and warm. */
export function inkTint(c, k = 0.18) {
  const l = luma(c);
  return [c[0] + (l - c[0]) * k + 6 * k, c[1] + (l - c[1]) * k + 3 * k, c[2] + (l - c[2]) * k - 4 * k];
}

/** Civ colour as [r,g,b] (falls back to a neutral when the civ or its colour is missing). */
export function civRgb(world, id) {
  const c = id != null && id >= 0 ? world.civs[id] : null;
  return (c && (parseColor(c.color) || parseColor(c.colorHex))) || [150, 140, 128];
}
/** Religion colour [r,g,b]. */
export function religionRgb(world, rid) {
  const r = rid != null && rid >= 0 ? world.religions?.[rid] : null;
  return (r && (parseColor(r.color) || parseColor(r.colorHex))) || [180, 170, 150];
}
/** Plague colour [r,g,b]. */
export function plagueRgb(world, pid) {
  const p = pid != null && pid >= 0 ? world.plagues?.[pid] : null;
  return (p && (parseColor(p.color) || parseColor(p.colorHex))) || [138, 168, 72];
}
