// Map modes: the 18 views of the world, their rendering profile and their legends, plus the
// modes other packages register (./layers.js registerMapMode). Registered modes are merged
// into MAP_MODES, MODE_IDS and MODE_PROFILE in place, after the built-ins, as soon as they
// register; mapModesFor(world) is the list the pickers offer (registered modes only while
// their when(world) holds).

import { BIOMES, ERAS, RESOURCES, WATER } from '../core/constants.js';
import { liveCivs } from '../core/entities.js';
import { listMapModes, getMapMode, onRenderRegistryChange } from './layers.js';
import * as P from './palette.js';

export const MAP_MODES = [
  { id: 'terrain', label: 'Terrain', desc: 'The natural atlas: relief, forests, farmland, snow and seas through the seasons.' },
  { id: 'political', label: 'Political', desc: 'Nations, their borders and capitals.' },
  { id: 'elevation', label: 'Elevation', desc: 'Hypsometric tints from ocean trenches to the highest peaks.' },
  { id: 'temperature', label: 'Temperature', desc: 'Current surface temperature, season by season.' },
  { id: 'rainfall', label: 'Rainfall', desc: 'Mean annual precipitation.' },
  { id: 'biome', label: 'Biomes', desc: 'Climate zones from ice sheet to rainforest.' },
  { id: 'vegetation', label: 'Vegetation', desc: 'Living plant biomass; watch forests fall and return.' },
  { id: 'fauna', label: 'Wildlife', desc: 'Herds on land (predators in red) and fish in the waters.' },
  { id: 'population', label: 'Population', desc: 'Where people live, glowing like lamps at night.' },
  { id: 'religion', label: 'Religion', desc: 'The dominant faith of every settlement’s lands.' },
  { id: 'culture', label: 'Culture', desc: 'The people who founded each town, whoever rules it now.' },
  { id: 'tech', label: 'Technology', desc: 'The age each nation has reached.' },
  { id: 'trade', label: 'Trade', desc: 'Roads, caravan trails and shipping lanes.' },
  { id: 'disease', label: 'Disease', desc: 'Active plagues and where they burn.' },
  { id: 'plates', label: 'Tectonics', desc: 'Crustal plates and the stress along their boundaries.' },
  { id: 'resources', label: 'Resources', desc: 'Ore richness and special deposits.' },
  { id: 'devastation', label: 'Devastation', desc: 'Scars of war, fire, storm and catastrophe.' },
  { id: 'pollution', label: 'Pollution', desc: 'Industrial smog and fouled land.' },
];
const BUILTIN_IDS = new Set(MAP_MODES.map((m) => m.id));
export const MODE_IDS = new Set(BUILTIN_IDS);

/**
 * Rendering profile per mode.
 * region: which territory raster to paint (null = none); borders: ink border alpha;
 * settle: settlement icon alpha; labelsCiv: civ-name labels; detail: close-up glyphs;
 * shimmer: animated water; routesK: trade-route emphasis.
 */
export const MODE_PROFILE = {
  terrain: { region: 'glow', borders: 0.85, settle: 1, labelsCiv: true, detail: 'full', shimmer: true, routesK: 0.6, clouds: true },
  political: { region: 'political', borders: 1, settle: 1, labelsCiv: true, detail: 'peaks', shimmer: false, routesK: 0.4, clouds: false },
  religion: { region: 'religion', borders: 0.7, settle: 1, labelsCiv: false, detail: 'peaks', shimmer: false, routesK: 0.3, clouds: false },
  culture: { region: 'culture', borders: 0.7, settle: 1, labelsCiv: false, detail: 'peaks', shimmer: false, routesK: 0.3, clouds: false },
  tech: { region: 'tech', borders: 0.8, settle: 1, labelsCiv: true, detail: 'peaks', shimmer: false, routesK: 0.3, clouds: false },
  trade: { region: 'faint', borders: 0.55, settle: 1, labelsCiv: false, detail: 'peaks', shimmer: false, routesK: 1.6, clouds: false },
  disease: { region: 'disease', borders: 0.6, settle: 1, labelsCiv: false, detail: 'peaks', shimmer: false, routesK: 0.5, clouds: false },
  resources: { region: null, borders: 0.5, settle: 0.8, labelsCiv: false, detail: 'peaks', shimmer: false, routesK: 0.3, clouds: false, resources: true },
  elevation: { region: null, borders: 0.4, settle: 0.7, labelsCiv: false, detail: null, shimmer: false, routesK: 0, clouds: false },
  temperature: { region: null, borders: 0.4, settle: 0.7, labelsCiv: false, detail: null, shimmer: false, routesK: 0, clouds: false },
  rainfall: { region: null, borders: 0.4, settle: 0.7, labelsCiv: false, detail: null, shimmer: false, routesK: 0, clouds: false },
  biome: { region: null, borders: 0.4, settle: 0.7, labelsCiv: false, detail: null, shimmer: false, routesK: 0, clouds: false },
  vegetation: { region: null, borders: 0.4, settle: 0.7, labelsCiv: false, detail: null, shimmer: false, routesK: 0, clouds: false },
  fauna: { region: null, borders: 0.35, settle: 0.6, labelsCiv: false, detail: null, shimmer: false, routesK: 0, clouds: false },
  population: { region: null, borders: 0.35, settle: 0.9, labelsCiv: false, detail: null, shimmer: false, routesK: 0.5, clouds: false, night: true },
  plates: { region: null, borders: 0.3, settle: 0.6, labelsCiv: false, detail: null, shimmer: false, routesK: 0, clouds: false },
  devastation: { region: null, borders: 0.5, settle: 0.8, labelsCiv: false, detail: null, shimmer: false, routesK: 0, clouds: false },
  pollution: { region: null, borders: 0.5, settle: 0.8, labelsCiv: false, detail: null, shimmer: false, routesK: 0, clouds: false },
};

/** What a registered mode starts from before its own profile overrides (a quiet thematic map). */
const REGISTERED_PROFILE = { region: null, borders: 0.5, settle: 0.8, labelsCiv: false, detail: 'peaks', shimmer: false, routesK: 0.3, clouds: false };
const warnedIds = new Set();

/** Rebuild the registered part of MAP_MODES, MODE_IDS and MODE_PROFILE (in place: importers keep their references). */
function syncRegisteredModes() {
  for (let k = MAP_MODES.length - 1; k >= 0; k--) if (!BUILTIN_IDS.has(MAP_MODES[k].id)) MAP_MODES.splice(k, 1);
  for (const id of [...MODE_IDS]) if (!BUILTIN_IDS.has(id)) { MODE_IDS.delete(id); delete MODE_PROFILE[id]; }
  for (const d of listMapModes()) {
    if (BUILTIN_IDS.has(d.id)) {
      if (!warnedIds.has(d.id)) { warnedIds.add(d.id); console.warn(`[render] registerMapMode: “${d.id}” is a built-in map mode`); }
      continue;
    }
    MAP_MODES.push({ id: d.id, label: d.label, desc: d.desc || '' });
    MODE_IDS.add(d.id);
    const prof = { ...REGISTERED_PROFILE, ...(d.profile || {}) };
    delete prof.style;   // the terrain style is read through registeredStyle()
    MODE_PROFILE[d.id] = prof;
  }
}
onRenderRegistryChange((kind) => { if (kind === 'mode') syncRegisteredModes(); });
syncRegisteredModes();

/** The map modes to offer for a world: every built-in, and each registered mode whose when(world) holds. */
export function mapModesFor(world) {
  return MAP_MODES.filter((m) => {
    if (BUILTIN_IDS.has(m.id)) return true;
    const d = getMapMode(m.id);
    if (!d || typeof d.when !== 'function') return Boolean(d);
    try { return Boolean(d.when(world)); } catch (e) { return false; }
  });
}

/** Is this a mode some package registered (rather than a built-in)? */
export const isRegisteredMode = (id) => !BUILTIN_IDS.has(id) && Boolean(getMapMode(id));

/** The terrain raster style a registered mode asks for (profile.style), or null for built-ins. */
export function registeredStyle(id) {
  if (BUILTIN_IDS.has(id)) return null;
  const d = getMapMode(id);
  return d ? (d.profile?.style || 'muted') : null;
}

const g = (ramp, n = 9) => {
  const out = [];
  for (let k = 0; k < n; k++) { const t = k / (n - 1); out.push([t, P.css(P.rampAt(ramp, t))]); }
  return out;
};

/**
 * Legend for the current mode. Gradient legends carry end labels (as minLabel / maxLabel
 * and the aliases min / max) and optional ticks [[t, label]].
 */
export function buildLegend(world, mode, extra = {}) {
  const lg = legendFor(world, mode, extra);
  if (lg && lg.type === 'gradient') {
    if (lg.min == null && lg.minLabel != null) lg.min = lg.minLabel;
    if (lg.max == null && lg.maxLabel != null) lg.max = lg.maxLabel;
  }
  return lg;
}

function legendFor(world, mode, extra) {
  switch (mode) {
    case 'terrain': return {
      title: 'Natural atlas', type: 'swatches', items: [
        { label: 'Deep ocean', color: P.css(P.rampAt(P.RAMPS.seaNatural, 0.6)) },
        { label: 'Shelf seas', color: P.css(P.rampAt(P.RAMPS.seaNatural, 0.06)) },
        { label: 'Forest', color: P.css(P.LUSH[8]) },
        { label: 'Grassland', color: P.css(P.LUSH[6]) },
        { label: 'Desert', color: P.css(P.LUSH[10]) },
        { label: 'Tundra', color: P.css(P.LUSH[4]) },
        { label: 'Farmland', color: 'rgb(196,176,88)' },
        { label: 'Burn scar', color: P.css(P.CHARCOAL) },
        { label: 'Snow & ice', color: P.css(P.SNOW) },
      ] };
    case 'political': case 'tech': {
      if (mode === 'tech') {
        return { title: 'Age of each nation', type: 'swatches', items: ERAS.map((e) => ({ label: e.name, color: P.css(P.eraColor(e.id)) })) };
      }
      const civs = extra.snapshotCivs || liveCivs(world).slice().sort((a, b) => (b.territory || 0) - (a.territory || 0) || (b.population || 0) - (a.population || 0));
      const items = civs.slice(0, 14).map((c) => ({ label: c.name, color: P.css(P.civRgb(world, c.id)) }));
      if (civs.length > 14) items.push({ label: `and ${civs.length - 14} more`, color: 'rgba(150,140,128,0.6)' });
      if (!items.length) items.push({ label: 'No nations yet', color: 'rgba(150,140,128,0.6)' });
      return { title: extra.snapshotYear != null ? `Nations in Year ${extra.snapshotYear}` : 'Nations', type: 'swatches', items };
    }
    case 'elevation': return { title: 'Elevation', type: 'gradient', stops: [...g(P.RAMPS.seaHypso, 5).reverse().map(([t, c]) => [(1 - t) * 0.4, c]), ...g(P.RAMPS.landHypso, 7).map(([t, c]) => [0.4 + t * 0.6, c])], minLabel: '−8000 m', maxLabel: '7000 m', ticks: [[0, '−8 km'], [0.4, 'sea level'], [0.7, '3.5 km'], [1, '7 km']] };
    case 'temperature': return { title: 'Temperature', type: 'gradient', stops: g(P.RAMPS.temperature), minLabel: '−40 °C', maxLabel: '45 °C', ticks: [[0, '−40°'], [40 / 85, '0°'], [60 / 85, '20°'], [1, '45°']] };
    case 'rainfall': return { title: 'Annual rainfall', type: 'gradient', stops: g(P.RAMPS.rainfall), minLabel: '0 mm', maxLabel: '3000 mm', ticks: [[0, '0'], [Math.sqrt(250 / 3000), '250'], [Math.sqrt(1000 / 3000), '1000'], [1, '3000 mm']] };
    case 'biome': {
      const present = new Set();
      const f = world.f;
      for (let i = 0; i < world.N; i += 3) present.add(f.biome[i]);
      return { title: 'Biomes', type: 'swatches', items: BIOMES.filter((b) => present.has(b.id)).map((b) => ({ label: b.name, color: P.css(P.BIOME_FLAT[b.id]) })) };
    }
    case 'vegetation': return { title: 'Plant biomass', type: 'gradient', stops: g(P.RAMPS.vegetation), minLabel: 'Bare', maxLabel: 'Dense forest' };
    case 'fauna': return { title: 'Wildlife', type: 'gradient', stops: g(P.RAMPS.herb), minLabel: 'Empty', maxLabel: 'Great herds', items: [{ label: 'Predators', color: 'rgb(178,54,42)' }, { label: 'Fish stocks', color: P.css(P.rampAt(P.RAMPS.fish, 0.7)) }] };
    case 'population': return { title: 'People per tile', type: 'gradient', stops: g(P.RAMPS.population), minLabel: '1', maxLabel: '150k+', ticks: [[0, '1'], [2 / 5.2, '100'], [4 / 5.2, '10k'], [1, '150k']] };
    case 'religion': {
      const rel = (world.religions || []).filter((r) => r && r.alive !== false);
      rel.sort((a, b) => (b.followers || 0) - (a.followers || 0));
      const items = rel.slice(0, 14).map((r) => ({ label: r.name, color: P.css(P.religionRgb(world, r.id)) }));
      items.push({ label: 'Folk beliefs', color: 'rgb(178,168,148)' });
      return { title: 'Faiths', type: 'swatches', items };
    }
    case 'culture': {
      const ids = new Set();
      for (const s of world.settlements) if (s && s.alive) ids.add(s.originCivId ?? s.civId);
      const civs = [...ids].map((id) => world.civs[id]).filter(Boolean).slice(0, 14);
      return { title: 'Founding peoples', type: 'swatches', items: civs.map((c) => ({ label: c.adjective || c.name, color: P.css(P.civRgb(world, c.id)) })) };
    }
    case 'trade': return {
      title: 'Trade', type: 'swatches', items: [
        { label: 'Track', color: 'rgb(150,112,72)' }, { label: 'Road', color: 'rgb(132,80,48)' }, { label: 'Highway', color: 'rgb(140,52,38)' },
        { label: 'Caravan route', color: 'rgb(214,150,60)' }, { label: 'Sea lane', color: 'rgb(70,120,170)' },
        { label: 'Caravan', color: 'rgb(232,170,60)' }, { label: 'Merchant ship', color: 'rgb(242,234,214)' },
      ] };
    case 'disease': {
      const pl = (world.plagues || []).filter((p) => p && p.active);
      const items = pl.slice(0, 12).map((p) => ({ label: p.name, color: P.css(P.plagueRgb(world, p.id)) }));
      if (!items.length) items.push({ label: 'No active plagues', color: 'rgba(150,140,128,0.6)' });
      items.push({ label: 'Recovering', color: 'rgb(160,176,150)' });
      return { title: 'Plagues', type: 'swatches', items };
    }
    case 'plates': return { title: 'Tectonic plates', type: 'gradient', stops: [[0, 'rgb(196,192,176)'], [0.5, 'rgb(206,132,84)'], [1, 'rgb(168,44,36)']], minLabel: 'Stable interior', maxLabel: 'Boundary stress' };
    case 'resources': {
      const present = new Set();
      const f = world.f;
      for (let i = 0; i < world.N; i++) if (f.resource[i] && f.water[i] === WATER.LAND) present.add(f.resource[i]);
      const items = RESOURCES.filter((r) => r.id && present.has(r.id)).map((r) => ({ label: r.name, color: P.css(r.color) }));
      items.unshift({ label: 'Ore richness', color: 'rgb(192,132,84)' });
      return { title: 'Resources', type: 'swatches', items };
    }
    case 'devastation': return { title: 'Devastation', type: 'gradient', stops: g(P.RAMPS.devastation), minLabel: 'Untouched', maxLabel: 'Ravaged' };
    case 'pollution': return { title: 'Pollution', type: 'gradient', stops: g(P.RAMPS.pollution), minLabel: 'Clean', maxLabel: 'Choked' };
    default: {
      const d = isRegisteredMode(mode) ? getMapMode(mode) : null;
      if (d && typeof d.legend === 'function') {
        try { const lg = d.legend(world); if (lg && typeof lg === 'object') return { title: d.label, type: 'swatches', items: [], ...lg }; } catch (e) { console.error(`[mapmode:${mode}] legend`, e); }
      }
      return { title: d ? d.label : 'Map', type: 'swatches', items: [] };
    }
  }
}
