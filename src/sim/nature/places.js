// Place descriptions for nature prose: turns a tile into "near Oskel",
// "in the Kesh Desert", "off the coast of Varan" or "in the far northern wastes",
// using live settlements, named geography (world.features), territory and latitude.

import { WATER } from '../../core/constants.js';
import { latitude } from '../../core/world.js';
import { nearestSettlement, settlementsNear } from '../../core/entities.js';
import { fin } from './common.js';

const AREA_KINDS = new Set(['desert', 'forest', 'range', 'island', 'continent', 'lake', 'sea', 'ocean']);

/**
 * Rough influence radius (tiles) of a feature: `size` is the tiles it covers; ranges and
 * rivers also carry `len`, their length along the long axis or course.
 */
function featureRadius(ft) {
  const s = fin(ft.size, 0), len = fin(ft.len, 0);
  if (ft.kind === 'range' || ft.kind === 'river') {
    if (len > 0) return Math.max(4, Math.min(60, len * 0.55));
    return Math.max(4, Math.min(60, (ft.kind === 'river' ? s * 0.5 : Math.sqrt(s / Math.PI) * 1.6)));
  }
  if (s <= 0) return ft.kind === 'continent' ? 40 : ft.kind === 'ocean' ? 60 : 6;
  return Math.max(3, Math.min(120, Math.sqrt(s / Math.PI) * 1.15));
}

/** Add "the" where English wants it: "Kesh Desert" → "the Kesh Desert"; "Mount Kel", "Varan" unchanged. */
export function withArticle(name) {
  if (!name) return name;
  if (/^the\s/i.test(name)) return 'the' + name.slice(3);
  if (/^(Mount|Lake|Isle|Cape|Port)\s/.test(name)) return name;
  if (/\s(Desert|Sea|Ocean|Mountains|Range|Hills|Forest|Wood|Woods|Steppe|Plains|Gulf|Bay|River|Waste|Wastes|Highlands|Heights|Peaks|Marsh|Marshes|Sound|Strait|Straits|Deep|Shallows|Isles|Islands|Reach|Expanse|Downs|Fens|Basin|Barrens|Sands|Wilds)$/.test(name)) return 'the ' + name;
  if (/(wood|woods|weald|holt)$/i.test(name) && !/\s/.test(name)) return 'the ' + name;
  return name;
}

function landmassAt(world, x, y) {
  const xi = Math.max(0, Math.min(world.W - 1, Math.round(x))), yi = Math.max(0, Math.min(world.H - 1, Math.round(y)));
  return world.f.landmass[yi * world.W + xi];
}

function compass(dx, dy) {
  const a = Math.atan2(-dy, dx); // north = +y screen up
  const k = Math.round(a / (Math.PI / 4));
  return ['east', 'northeast', 'north', 'northwest', 'west', 'southwest', 'south', 'southeast', 'east'][(k + 8) % 8];
}

/** Best named feature covering (x, y), or null. */
export function featureAt(world, x, y) {
  const feats = world.features || [];
  if (!feats.length) return null;
  const i = Math.max(0, Math.min(world.N - 1, Math.round(y) * world.W + Math.round(x)));
  const land = world.f.water[i] === WATER.LAND;
  const lm = land ? world.f.landmass[i] : -1;
  let best = null, bestScore = Infinity;
  for (const ft of feats) {
    if (!ft || !ft.name || !AREA_KINDS.has(ft.kind)) continue;
    const isWaterKind = ft.kind === 'sea' || ft.kind === 'ocean' || ft.kind === 'lake';
    if (land && (ft.kind === 'sea' || ft.kind === 'ocean')) continue;
    if (!land && !isWaterKind) continue;
    const d = Math.hypot(fin(ft.x) - x, fin(ft.y) - y);
    let R = featureRadius(ft);
    // From land, a lake names only its shores.
    if (land && ft.kind === 'lake') R = Math.min(R, 2.5 + R * 0.8);
    if (ft.kind === 'continent' || ft.kind === 'island') {
      if (lm < 0 || landmassAt(world, ft.x, ft.y) !== lm) continue;
    } else if (d > R) continue;
    // Prefer small, specific features over continents (a lake only describes its shore).
    const rank = ft.kind === 'continent' ? 3 : ft.kind === 'island' ? 2 : ft.kind === 'ocean' ? 2.5 : ft.kind === 'lake' && land ? 1.5 : 1;
    const score = rank * 1000 + d / R;
    if (score < bestScore) { bestScore = score; best = { ft, d, R }; }
  }
  return best;
}

/**
 * Prepositional phrase for a location.
 * opts: { settleDist = 5, useSettlement = true, coastal = false }
 * → { text: 'near Oskel', name: 'Oskel', sid?, kind }
 */
export function placePhrase(world, x, y, opts = {}) {
  const { W, H, f } = world;
  const xi = Math.max(0, Math.min(W - 1, Math.round(x))), yi = Math.max(0, Math.min(H - 1, Math.round(y)));
  const i = yi * W + xi;
  const land = f.water[i] === WATER.LAND;
  if (opts.useSettlement !== false) {
    const s = nearestSettlement(world, xi, yi, { maxDist: opts.settleDist ?? 5 });
    if (s) {
      const d = Math.hypot(s.x - xi, s.y - yi);
      if (!land && d > 1.5) return { text: `off the coast of ${s.name}`, name: s.name, sid: s.id, kind: 'settlement' };
      return { text: d <= 1.5 ? `at ${s.name}` : `near ${s.name}`, name: s.name, sid: s.id, kind: 'settlement' };
    }
  }
  const fa = featureAt(world, xi, yi);
  if (fa) {
    const { ft, d, R } = fa;
    const nm = withArticle(ft.name);
    if (ft.kind === 'continent' || ft.kind === 'island') {
      if (d > R * 0.45) return { text: `in the ${compass(xi - ft.x, yi - ft.y)} of ${nm}`, name: nm, kind: ft.kind };
      return { text: ft.kind === 'island' ? `on ${nm}` : `in the heart of ${nm}`, name: nm, kind: ft.kind };
    }
    if (ft.kind === 'range') return { text: /^Mount\s/.test(nm) ? `on the slopes of ${nm}` : `in ${nm}`, name: nm, kind: 'range' };
    if (ft.kind === 'lake' && land) return { text: `on the shores of ${nm}`, name: `the shores of ${nm}`, kind: 'lake' };
    if (ft.kind === 'sea' || ft.kind === 'ocean' || ft.kind === 'lake') return { text: `on ${nm}`, name: nm, kind: ft.kind };
    return { text: `in ${nm}`, name: nm, kind: ft.kind };
  }
  const own = f.owner[i];
  const civ = own >= 0 ? world.civs[own] : null;
  if (civ && civ.alive) return { text: `in ${civ.adjective} lands`, name: `the ${civ.adjective} lands`, kind: 'civ', civId: civ.id };
  if (!land) {
    const s = nearestSettlement(world, xi, yi, { maxDist: 18 });
    if (s) return { text: `in the waters off ${s.name}`, name: s.name, sid: s.id, kind: 'sea' };
  }
  return latitudePhrase(world, xi, yi, land);
}

/** Purely geographic fallback: "in the far northern wastes", "on the open ocean near the equator". */
export function latitudePhrase(world, x, y, land) {
  const lat = latitude(world, y), al = Math.abs(lat);
  const ns = lat >= 0 ? 'northern' : 'southern';
  const ew = x < world.W / 3 ? 'western' : x > (2 * world.W) / 3 ? 'eastern' : '';
  if (!land) {
    if (al > 0.75) return { text: `in the frozen ${ns} seas`, name: `the frozen ${ns} seas`, kind: 'lat' };
    if (al < 0.15) return { text: `on the open ocean near the equator`, name: 'the equatorial ocean', kind: 'lat' };
    const far = ew ? `, far to the ${ew === 'western' ? 'west' : 'east'}` : '';
    return { text: `on the open ${ns} ocean${far}`, name: `the ${ns} ocean`, kind: 'lat' };
  }
  if (al > 0.75) return { text: `in the far ${ns} wastes`, name: `the far ${ns} wastes`, kind: 'lat' };
  if (al > 0.5) return { text: `in the ${ns} wilds`, name: `the ${ns} wilds`, kind: 'lat' };
  if (al < 0.15) return { text: `in the equatorial wilds`, name: `the equatorial wilds`, kind: 'lat' };
  return { text: `in the untamed ${ew ? ew + ' ' : ''}lands`, name: `the untamed ${ew ? ew + ' ' : ''}lands`, kind: 'lat' };
}

/**
 * Noun phrase for a wider area centred on (x, y): "the lands around Oskel",
 * "the Kesh Desert", "the north of Varan". Good as a sentence subject or object.
 */
export function regionName(world, x, y, opts = {}) {
  const near = opts.settleDist ?? 10;
  const s = nearestSettlement(world, Math.round(x), Math.round(y), { maxDist: near, filter: opts.filter });
  const fa = featureAt(world, x, y);
  const xi = Math.max(0, Math.min(world.W - 1, Math.round(x))), yi = Math.max(0, Math.min(world.H - 1, Math.round(y)));
  const onLand = world.f.water[yi * world.W + xi] === WATER.LAND;
  if (fa && fa.ft.kind === 'lake' && onLand) return s && Math.hypot(s.x - x, s.y - y) < fa.d ? `the lands around ${s.name}` : `the shores of ${withArticle(fa.ft.name)}`;
  if (fa && fa.ft.kind !== 'continent' && fa.ft.kind !== 'island' && fa.ft.kind !== 'ocean') return withArticle(fa.ft.name);
  if (s) return `the lands around ${s.name}`;
  if (fa) {
    const nm = withArticle(fa.ft.name);
    if (fa.d > fa.R * 0.45) return `the ${compass(x - fa.ft.x, y - fa.ft.y)} of ${nm}`;
    return `the heart of ${nm}`;
  }
  const p = placePhrase(world, x, y, { useSettlement: false });
  return p.name;
}

/** Largest live settlements near a point (for listing victims). */
export function biggestNear(world, x, y, r, n = 3, filter = null) {
  return settlementsNear(world, x, y, r, filter).sort((a, b) => b.population - a.population).slice(0, n);
}
