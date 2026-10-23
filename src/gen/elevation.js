// Stage 2 · Elevation. Composes a raw relief (in rough kilometres) from crust type,
// plate-boundary tectonics, hotspot chains, volcanic cones and fractal detail, then
// normalises it so exactly `oceanCoverage` of the tiles lie below 0.5:
//   ocean — depth below the coastline maps linearly (0.5 = coast, 0 ≈ 8 km deep), so
//           shelves stay shallow (0.45–0.5) and trenches deep;
//   land  — a blend of a rank curve (exponential hypsometry: broad lowlands, few peaks,
//           steeper with params.mountainHeight) and a height curve (km above the coast,
//           Gaussian-shaped so low relief stays low and tectonic ranges keep their
//           stature): at default params the median is ≈ 0.4 km, ~7 % of the land lies
//           above 2 km and ~2 % above 3 km. Peaks approach 1.
// Distinct continents are always parted by a strait (see continentSeparation), so the
// map holds params.continents land masses whatever the land fraction.

import { RNG, createNoise2D } from '../core/rng.js';
import { clamp, clamp01, smoothstep, lerp } from '../core/util.js';
import { fbmL, ridgedL, octavesFor, lowerBound, boxBlur, weightedOrder, frameTaper, chamfer, num } from './grid.js';
import { plateVelocity, coarsePlateAt } from './plates.js';

const g2 = (x) => Math.exp(-x * x);
const RANK_W = 0.4;       // land hypsometry: weight of the rank curve vs the km curve
const VALUE_KM = 2.7;     // km curve 1 − exp(−(h / VALUE_KM)²): land median ≈ 0.4 km, p80 ≈ 1 km, p93 ≈ 2 km
const SHELF_EDGE_KM = -0.8;   // raw level of the shelf edge (heights never count from below it)
const STRAIT_SHIFT = 1e4;     // ranks strait tiles below every other tile
const STRAIT_DEPTH_KM = 0.6;  // least depth of a forced strait

/** Crust profile: abyss (−4.6 km) → slope → shelf (≈ −0.1 km at C 0.5) → interior (+0.5 km). */
function crustHeight(C) {
  if (C <= 0) return -4.6;
  if (C >= 1) return 0.5;
  const s = C < 0.5 ? 0.88 * smoothstep(0, 0.5, C) : 0.88 + 0.24 * (C - 0.5);
  return -4.6 + 5.1 * s;
}

/**
 * Builds ctx.raw (Float64Array, km-ish) plus ctx.volcanoSites and ctx.hotspots.
 * Requires the plate stage (ctx.plates, ctx.bSrc, ...).
 */
export function buildRelief(world, ctx) {
  const { W, H, N, f, params } = world;
  const A = W / H;
  const seed = world.seed;
  const pl = ctx.plates;
  const { bSrc, bDn, bOther, bConv, bShear } = ctx;
  const plate = f.plate;
  const frag = clamp01(num(params.fragmentation, 0.35));
  const mh = clamp01(num(params.mountainHeight, 0.5));
  const Mamp = 0.6 + 6.8 * mh;

  const nCoast = createNoise2D(seed + ':coast');
  const nCrust = createNoise2D(seed + ':crust');
  const nInt = createNoise2D(seed + ':interior');
  const nRidge = createNoise2D(seed + ':ridge');
  const nFold = createNoise2D(seed + ':fold');
  const nAlong = createNoise2D(seed + ':along');
  const nArc = createNoise2D(seed + ':arc');
  const nOld = createNoise2D(seed + ':old-orogen');
  const nOldM = createNoise2D(seed + ':old-mask');
  const nDet = createNoise2D(seed + ':detail');
  const nAby = createNoise2D(seed + ':abyss');
  const nPit = createNoise2D(seed + ':pits');
  const nFrame = createNoise2D(seed + ':frame');

  const cf = 3.2 + 5.0 * frag;               // coastline jitter frequency
  const df = 7 + 6 * frag;                   // coastal detail frequency
  const oCoast = octavesFor(H, cf, 6), oCrust = octavesFor(H, 2.1, 4), oInt = octavesFor(H, 2.4, 5);
  const oRidge = octavesFor(H, 7, 5), oFold = octavesFor(H, 5, 3), oAlong = octavesFor(H, 4.5, 3);
  const oArc = octavesFor(H, 13, 3), oOld = octavesFor(H, 5, 4), oOldM = octavesFor(H, 1.6, 3);
  const oDet = octavesFor(H, df, 5), oAby = octavesFor(H, 4, 4), oPit = octavesFor(H, 18, 2);
  const oFrame = octavesFor(H, 1.5, 3);

  const raw = new Float64Array(N);
  const soft = new Float32Array(N);        // broad terms, blurred afterwards (no polygon seams)
  const volcScore = new Float32Array(N);
  const volcKind = new Uint8Array(N);      // 1 arc, 2 island arc, 3 rift, 4 collision
  const crustC = new Float32Array(N);       // continental crust fraction 0..1 per tile
  const sep = continentSeparation(world, pl);
  const sepT = sep ? sep.sep : null;

  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    const alat = Math.abs(1 - 2 * v);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const u = (x + 0.5) / H;
      const p = plate[i];
      const own = pl.cont[p];
      const src = bSrc[i];
      const dn = bDn[i];
      const b = src >= 0 ? bOther[src] : -1;
      const c = src >= 0 ? bConv[src] : 0;
      const s = src >= 0 ? bShear[src] : 0;
      // crust across the boundary counts as continental only within one continent;
      // distinct continents are always parted by sea (a narrow, range-lined sea where
      // they converge, a broad young ocean where they drift apart), so the map holds
      // params.continents land masses
      let oth = b >= 0 ? pl.cont[b] : own;
      if (own && oth && b >= 0 && pl.contId[b] !== pl.contId[p]) oth = 0;

      // ---- crust: continental plates taper to the ocean over their margin
      const coastN = fbmL(nCoast, u * cf, v * cf, 6, oCoast);
      let C;
      if (own) {
        if (oth) C = 1;
        else {
          const mw = lerp(0.075, 0.024, smoothstep(-0.15, 0.45, c));
          C = smoothstep(0, mw, dn + coastN * (0.02 + 0.05 * frag));
        }
      } else C = 0;
      const crustN = fbmL(nCrust, u * 2.1, v * 2.1, 4, oCrust);
      if (!own) C = Math.max(C, smoothstep(0.6 - 0.16 * frag, 0.68 - 0.1 * frag, crustN));     // microcontinents
      else C *= 1 - 0.6 * smoothstep(0.36 - 0.3 * frag, 0.72 - 0.3 * frag, -crustN);          // inland seas, great bays
      // continents thin out toward the frame and corners along a jittered contour
      C *= frameTaper(u, v, A, 0.07 * fbmL(nFrame, u * 1.5, v * 1.5, 3, oFrame) + coastN * 0.045);
      // the crust thins into the strait between two continents (normalizeRelief keeps
      // the strait's axis below the sea, so coastal jitter can never bridge it)
      if (own && sepT) C *= smoothstep(sep.lo, sep.hi, sepT[i]);
      crustC[i] = C;
      let h = crustHeight(C);

      // ---- continental interior: basins and uplands, worn-down ancient ranges
      const Ci = smoothstep(0.35, 0.9, C);
      if (Ci > 0) {
        h += Ci * 0.36 * fbmL(nInt, u * 2.4, v * 2.4, 5, oInt);
        const om = smoothstep(0.25, 0.6, fbmL(nOldM, u * 1.6, v * 1.6, 3, oOldM));
        if (om > 0) { const r = ridgedL(nOld, u * 5, v * 5, 4, oOld); h += Ci * om * 0.8 * r * r; }
        // glacially scoured lowlands at high latitude: a scatter of small basins (lakes)
        if (alat > 0.5) {
          const pit = fbmL(nPit, u * 18, v * 18, 2, oPit) - 0.22;
          if (pit > 0) h -= Ci * 0.55 * smoothstep(0.5, 0.72, alat) * pit;
        }
      }
      // coastal detail: peninsulas, inlets, offshore islets (stronger with fragmentation)
      const mwgt = clamp01(1 - Math.abs(C - 0.6) * 1.8);
      h += (0.16 + 0.62 * frag) * (0.35 + 0.65 * mwgt) * fbmL(nDet, u * df, v * df, 5, oDet);
      // abyssal hills
      h += (1 - C) * 0.42 * fbmL(nAby, u * 4, v * 4, 4, oAby);

      // ---- tectonics from the nearest own-plate boundary
      if (src >= 0) {
        if (c > 0.04) {
          if (own && oth) {
            // continental collision: broad folded ranges and a plateau behind them
            const w = 0.032 + 0.045 * c;
            const prof = g2(dn / w);
            if (prof > 0.002 || dn < w * 3.2) {
              const fold = 0.74 + 0.26 * Math.cos((dn / w) * 6 + 4.5 * fbmL(nFold, u * 5, v * 5, 3, oFold));
              const rid = ridgedL(nRidge, u * 7, v * 7, 5, oRidge);
              const along = 0.78 + 0.4 * fbmL(nAlong, u * 4.5, v * 4.5, 3, oAlong);
              h += Mamp * (0.35 + 0.65 * Math.pow(c, 0.6)) * prof * fold * (0.55 + 0.65 * rid) * along;
              soft[i] += Mamp * 0.3 * c * smoothstep(w * 3.4, w * 0.6, dn);
              volcScore[i] = 0.12 * c * prof; volcKind[i] = 4;
            }
          } else if (own) {
            // active margin: coastal cordillera + volcanic arc, with back-arc ranges
            const prof = g2((dn - 0.028) / 0.02) + 0.35 * g2((dn - 0.068) / 0.026);
            if (prof > 0.002) {
              const rid = ridgedL(nRidge, u * 7, v * 7, 5, oRidge);
              const along = 0.78 + 0.4 * fbmL(nAlong, u * 4.5, v * 4.5, 3, oAlong);
              h += Mamp * 0.9 * (0.3 + 0.7 * Math.pow(c, 0.6)) * prof * (0.55 + 0.65 * rid) * along;
            }
            volcScore[i] = c * g2((dn - 0.03) / 0.012); volcKind[i] = 1;
          } else if (oth || pl.dense[p] > pl.dense[b]) {
            // oceanic plate diving under the neighbour: trench
            h -= 3.4 * Math.pow(c, 0.8) * g2(dn / 0.011);
          } else {
            // overriding oceanic plate: volcanic island arc
            const arc = g2((dn - 0.026) / 0.011);
            if (arc > 0.002) {
              const spots = smoothstep(-0.05, 0.5, fbmL(nArc, u * 13, v * 13, 3, oArc));
              h += (1.6 + 4.6 * spots) * Math.pow(c, 0.55) * arc;
              volcScore[i] = c * arc * (0.3 + 0.7 * spots); volcKind[i] = 2;
            }
          }
        } else if (c < -0.04) {
          const a = -c;
          if (own && oth) {
            // continental rift: trough with raised shoulders (rift lakes, narrow seas)
            h += -1.7 * Math.pow(a, 0.9) * g2(dn / 0.011) + 0.9 * a * g2((dn - 0.03) / 0.016);
            volcScore[i] = 0.35 * a * g2(dn / 0.015); volcKind[i] = 3;
          } else if (!own && !oth) {
            // mid-ocean ridge with axial valley
            soft[i] += 2.1 * (0.45 + 0.55 * a) * Math.exp(-dn / 0.055);
            h -= 0.35 * g2(dn / 0.006);
          } else if (!own) {
            soft[i] += 0.8 * a * Math.exp(-dn / 0.05);
          }
        }
        if (s > 0.25 && Math.abs(c) < 0.3) {
          if (own && oth) h += 0.7 * s * g2(dn / 0.012) * ridgedL(nRidge, u * 7, v * 7, 5, oRidge);
          else if (!own) h -= 0.4 * s * g2(dn / 0.006);
        }
      }
      raw[i] = h;
    }
  }

  // ---- hotspots: chains of shield volcanoes trailing along the plate motion
  const bumps = [];
  const hotspots = [];
  {
    const rng = new RNG(seed + ':hotspots');
    const n = 2 + rng.int(0, 3);
    for (let h = 0; h < n; h++) {
      let hu = 0, hv = 0, ok = false;
      for (let t = 0; t < 24 && !ok; t++) {
        hu = rng.float(0.12, A - 0.12); hv = rng.float(0.16, 0.84);
        const k = coarsePlateAt(ctx, hu, hv);
        const far = hotspots.every((o) => Math.hypot(o.u - hu, o.v - hv) > 0.2);
        ok = far && (!pl.cont[k] || t >= 14);
      }
      if (!ok) continue;
      const k = coarsePlateAt(ctx, hu, hv);
      const [pvx, pvy] = plateVelocity(pl, k, hu, hv);
      let len = Math.hypot(pvx, pvy);
      let dx = pvx, dy = pvy;
      if (len < 0.05) { const th = rng.float(0, Math.PI * 2); dx = Math.cos(th); dy = Math.sin(th); len = 1; }
      dx /= len; dy /= len;
      const L = rng.int(4, 8);
      const continental = pl.cont[k] === 1;
      hotspots.push({ u: hu, v: hv, plate: k, continental });
      if (continental) bumps.push({ u: hu, v: hv, r: 0.05, h: 0.9 });
      for (let j = 0; j < L; j++) {
        const bu = hu + dx * 0.028 * j, bv = hv + dy * 0.028 * j;
        if (bu < 0.03 || bu > A - 0.03 || bv < 0.03 || bv > 0.97) break;
        const age = j / (L + 1);
        bumps.push({ u: bu, v: bv, r: (j === 0 ? 0.016 : 0.012) * (1 - 0.35 * age), h: (continental ? 2.2 : 6.4) * Math.pow(1 - age, 1.1) });
      }
    }
  }

  // ---- volcanic sites along arcs, rifts and hotspot heads
  const sites = [];
  {
    const rng = new RNG(seed + ':volcano-sites');
    const volc = Math.max(0, num(params.volcanism, 1));
    let arcTiles = 0;
    for (let i = 0; i < N; i++) if (volcScore[i] > 0.25 && volcKind[i] <= 2) arcTiles++;
    const arcLen = arcTiles / Math.max(1, 0.024 * H * H);   // ≈ arc length, normalised units
    const base = clamp(Math.round(8 + 3 * arcLen), 6, 24);
    const want = clamp(Math.round(base * volc), 0, 72);
    // no vent in a strait between continents (its island would bridge them)
    const inStrait = (u, v) => {
      if (!sep) return false;
      const x = clamp(Math.floor(u * H), 0, W - 1), y = clamp(Math.floor(v * H), 0, H - 1);
      return sep.sep[y * W + x] < sep.hi + 1;
    };
    for (const hs of hotspots) {
      if (sites.length >= want) break;
      if (inStrait(hs.u, hs.v)) continue;
      sites.push({ u: hs.u, v: hs.v, setting: 'hotspot', cone: hs.continental ? 1.4 : 0 });
    }
    // weighted sampling without replacement (exponential race) with spacing
    const cand = weightedOrder(rng, N, (i) => volcScore[i], 0.18);
    const minSep = 0.045;
    for (const i of cand) {
      if (sites.length >= want) break;
      const u = ((i % W) + 0.5) / H, v = (((i / W) | 0) + 0.5) / H;
      if (sites.some((s) => Math.hypot(s.u - u, s.v - v) < minSep) || inStrait(u, v)) continue;
      const kind = volcKind[i];
      sites.push({ u, v, setting: kind === 1 ? 'arc' : kind === 2 ? 'island arc' : kind === 3 ? 'rift' : 'collision', cone: rng.float(1.2, 2.6) });
    }
    for (const s of sites) if (s.cone > 0) bumps.push({ u: s.u, v: s.v, r: 0.0085, h: s.cone });
  }

  // ---- apply bumps (Gaussian cones) inside their bounding boxes
  for (const bp of bumps) {
    const r3 = bp.r * 3;
    const x0 = Math.max(0, Math.floor((bp.u - r3) * H)), x1 = Math.min(W - 1, Math.ceil((bp.u + r3) * H));
    const y0 = Math.max(0, Math.floor((bp.v - r3) * H)), y1 = Math.min(H - 1, Math.ceil((bp.v + r3) * H));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const du = (x + 0.5) / H - bp.u, dv = (y + 0.5) / H - bp.v;
      const d = Math.sqrt(du * du + dv * dv) / bp.r;
      if (d < 3) raw[y * W + x] += bp.h * Math.exp(-d * d);
    }
  }

  // ---- blur the broad terms (ridges, plateaus) so distance-field seams vanish
  {
    const tmp = new Float32Array(N), out = new Float32Array(N);
    const r = Math.max(1, Math.round(H / 48));
    boxBlur(W, H, soft, out, tmp, r);
    boxBlur(W, H, out, soft, tmp, r);
    for (let i = 0; i < N; i++) raw[i] += soft[i];
  }

  // ---- keep the map's rim oceanic: a broad, gentle falloff so coasts near the frame
  //      follow the land's own contours instead of a ruled line
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    const pv = 4 * Math.pow(1 - smoothstep(0, 0.045, Math.min(v, 1 - v)), 2);
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / H;
      const pu = 6 * Math.pow(1 - smoothstep(0, 0.07, Math.min(u, A - u)), 2);
      raw[y * W + x] -= Math.max(pu, pv);
    }
  }

  ctx.raw = raw;
  ctx.strait = sep ? sep.strait : null;
  ctx.crustC = crustC;
  ctx.volcanoSites = sites;
  ctx.hotspots = hotspots;
}

/**
 * Straits between continents. For every tile: d1, d2 = distances (tiles) to the nearest
 * and second-nearest continent's crust (distinct continents); sep = d2 − d1 is the
 * distance from a continent's own tiles to the next continent, and ≈ 0 along the line
 * midway between two continents (also across oceanic plates). Tiles with sep below the
 * strait half-width form `strait` (1 = must stay sea): an unbroken channel between every
 * pair of continents, at least ~3 tiles wide, so params.continents land masses survive
 * any land fraction and any coastline noise. Null when the map holds < 2 continents.
 */
function continentSeparation(world, pl) {
  const { W, H, N, f } = world;
  const plate = f.plate;
  let K = 0;
  for (let k = 0; k < pl.P; k++) if (pl.cont[k] && pl.contId[k] + 1 > K) K = pl.contId[k] + 1;
  if (K < 2) return null;
  const cid = new Int16Array(N);
  for (let i = 0; i < N; i++) { const p = plate[i]; cid[i] = pl.cont[p] ? pl.contId[p] : -1; }
  const d1 = new Float32Array(N).fill(1e9), d2 = new Float32Array(N).fill(1e9);
  const d = new Float32Array(N);
  for (let k = 0; k < K; k++) {
    let any = false;
    for (let i = 0; i < N; i++) { const s = cid[i] === k; d[i] = s ? 0 : 1e9; if (s) any = true; }
    if (!any) continue;
    chamfer(W, H, d);
    for (let i = 0; i < N; i++) {
      const v = d[i];
      if (v < d1[i]) { d2[i] = d1[i]; d1[i] = v; } else if (v < d2[i]) d2[i] = v;
    }
  }
  const lo = Math.max(1.5, 0.0094 * H), hi = lo + 1.1, mid = (lo + hi) / 2;
  const sep = new Float32Array(N), strait = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const s = d2[i] >= 1e8 ? 1e9 : d2[i] - d1[i];
    sep[i] = s;
    strait[i] = s < mid ? 1 : 0;
  }
  return { sep, strait, lo, hi };
}

/**
 * Normalise ctx.raw into f.elevation: exactly round(N·oceanCoverage) tiles below 0.5.
 * Strait tiles (ctx.strait) are ranked below everything else, so they always count
 * among the ocean tiles (with at least a shallow strait's depth). Returns the ocean
 * tile count k.
 */
export function normalizeRelief(world, ctx) {
  const { N, f, params } = world;
  const raw = ctx.raw;
  const e = f.elevation;
  const oc = clamp(num(params.oceanCoverage, 0.6), 0.05, 0.98);
  const k = clamp(Math.round(N * oc), 1, N - 1);
  let strait = ctx.strait || null;
  if (strait) {
    let ns = 0;
    for (let i = 0; i < N; i++) ns += strait[i];
    if (ns > 0.85 * k) strait = null;       // straits alone would fill the sea: rely on relief
  }
  const key = new Float64Array(N);
  const fillKeys = () => {
    for (let i = 0; i < N; i++) {
      const r = Number.isFinite(raw[i]) ? raw[i] : 0;
      key[i] = (strait && strait[i] ? r - STRAIT_SHIFT : r) + i * 1e-11;
    }
  };
  fillKeys();
  if (raiseDrownedContinents(world, ctx, key, k, strait)) fillKeys();
  const sorted = key.slice().sort();
  const t = sorted[k];
  // land heights are measured from the coastline, or from the edge of the continental
  // shelf when the sea is so small that the coast lies down on the old ocean floor
  const tv = Math.max(t, SHELF_EDGE_KM);
  const mh = clamp01(num(params.mountainHeight, 0.5));
  const L = lerp(10, 5, mh);
  const eL = 1 - Math.exp(-L);
  // taller tectonics (mountainHeight > 0.5) widen the km curve with the square root of the
  // fold amplitude, so towering ranges stand out instead of whole regions saturating
  const vKm = VALUE_KM * Math.max(1, Math.sqrt((0.6 + 6.8 * mh) / 4));
  const nLand = N - k;
  for (let i = 0; i < N; i++) {
    const kv = key[i];
    if (kv < t) {
      const forced = strait && strait[i];
      const depth = forced ? Math.max(STRAIT_DEPTH_KM, t - (kv + STRAIT_SHIFT)) : t - kv;
      e[i] = 0.5 - 0.5 * clamp(depth / 8, 0.0012, 0.996);
    } else {
      // blend of a rank curve (guaranteed hypsometry: broad lowlands, few peaks) and a
      // value curve (km above the coast: low relief stays low, real ranges keep their
      // stature)
      const rank = lowerBound(sorted, kv);
      const r = clamp((rank - k) / Math.max(1, nLand - 1), 0, 1);
      const byRank = -Math.log(1 - r * eL) / L;
      const x = (kv - tv) / vKm;
      const byValue = x > 0 ? 1 - Math.exp(-x * x) : 0;
      e[i] = 0.5004 + 0.4996 * clamp01(RANK_W * byRank + (1 - RANK_W) * byValue);
    }
  }
  ctx.oceanK = k;
  return k;
}

/**
 * Every continent must break the surface: one whose crust would hold less than ~30 % of
 * a fair share of the land (or of its own crust) — a small plate, thin crust under a deep
 * sea level, a plate squeezed against the map frame — is uplifted as a block (weighted by
 * crust, so its margins keep their slope) until it does. Edits ctx.raw; returns true if
 * anything moved.
 */
function raiseDrownedContinents(world, ctx, key, k, strait) {
  const { N, f } = world;
  const pl = ctx.plates, crustC = ctx.crustC, raw = ctx.raw;
  if (!pl || !crustC) return false;
  let K = 0;
  for (let p = 0; p < pl.P; p++) if (pl.cont[p] && pl.contId[p] + 1 > K) K = pl.contId[p] + 1;
  if (K < 2) return false;
  const t = key.slice().sort()[k];
  const fair = (N - k) / K;
  const plate = f.plate;
  const members = Array.from({ length: K }, () => []);
  for (let i = 0; i < N; i++) {
    const p = plate[i];
    if (!pl.cont[p] || (strait && strait[i]) || crustC[i] < 0.15) continue;
    members[pl.contId[p]].push(i);
  }
  const wOf = (i) => smoothstep(0.15, 0.6, crustC[i]);
  let moved = false;
  for (let c = 0; c < K; c++) {
    const m = members[c];
    if (!m.length) continue;
    const want = Math.max(1, Math.floor(Math.min(0.3 * fair, 0.6 * m.length)));
    const count = (d) => { let n = 0; for (const i of m) if (raw[i] + d * wOf(i) > t) n++; return n; };
    if (count(0) >= want) continue;
    let lo = 0, hi = 0.5;
    while (count(hi) < want && hi < 12) hi *= 2;
    for (let it = 0; it < 22; it++) { const mid = (lo + hi) / 2; if (count(mid) < want) lo = mid; else hi = mid; }
    const d = hi + 0.08;
    for (const i of m) raw[i] += d * wOf(i);
    moved = true;
  }
  return moved;
}

/**
 * After erosion and island-raising: restore exactly k tiles below 0.5 with a minimal,
 * monotonic adjustment near the coastline (depths and heights elsewhere untouched).
 */
export function fixSeaFraction(world, k) {
  const { N, f } = world;
  const e = f.elevation;
  const key = new Float64Array(N);
  for (let i = 0; i < N; i++) { const v = e[i]; key[i] = (Number.isFinite(v) ? v : 0.5) + i * 1e-12; }
  const sorted = key.slice().sort();
  const kk = clamp(k, 1, N - 1);
  const t2 = sorted[kk], oMax = sorted[kk - 1];
  const dO = 0.4995 - oMax;            // < 0 → ocean top too high
  const dL = 0.5005 - t2;              // > 0 → land bottom too low
  for (let i = 0; i < N; i++) {
    let v = e[i];
    if (key[i] < t2) {
      if (dO < 0) v += dO * clamp01((v - (oMax - 0.08)) / 0.08);
      v = clamp(v, 0.0005, 0.4995);
    } else {
      if (dL > 0) v += dL * (1 - clamp01((v - t2) / 0.1));
      v = clamp(v, 0.5005, 1);
    }
    e[i] = v;
  }
}
