// Stage 1 · Plates. Noise-warped, additively weighted Voronoi plates; continental cores
// that grow across neighbouring plates into continents; rigid plate motions (drift +
// spin); boundary classification by relative motion (convergent / divergent /
// transform); and the distance-to-own-boundary field the elevation stage builds on.
//
// Every decision that shapes the map (which plates are continental, how large they
// grow, which motion set is used) is made on a fixed coarse grid in normalised
// coordinates, so a preview map and a full-size map of the same seed agree.
// params.continents cores are chosen spread out, central and not tiny; each continent
// keeps a sizeable share of its plate however small the land target, and the relief
// stage parts distinct continents by sea, so the map shows that many land masses.

import { RNG, createNoise2D } from '../core/rng.js';
import { clamp, smoothstep, MinHeap, DX8, DY8, DIST8, weightedIndex } from '../core/util.js';
import { fbmL, octavesFor, chamfer, frameTaper, num } from './grid.js';

const COARSE_ROWS = 60;   // decision grid rows (normalised resolution, map-size independent)
const WARP = 0.16;        // domain-warp amplitude (normalised units)
const WARP_FREQ = 1.7;
const WARP_OCT = 4;
const MOTION_TRIES = 5;

/**
 * Builds plates and writes f.plate and f.plateBoundary. Fills ctx with:
 *   plates  { P, cont (0/1), contId (continent index or −1), dense (oceanic age: the
 *             denser plate subducts), vx, vy, om (drift and spin), cx, cy (centroids),
 *             area (map fraction), sx, sy (seeds) } — all per plate, normalised units
 *   bSrc    Int32Array  nearest own-boundary tile for every tile (−1 if none)
 *   bDn     Float32Array distance to that boundary, normalised units
 *   bOther, bConv, bShear  per boundary tile: neighbouring plate, convergence (−1..1,
 *                          + closing), shear (0..1)
 *   coarse  { CW, CH, plate } decision grid (for resolution-independent lookups)
 */
export function buildPlates(world, ctx) {
  const { W, H, N, f, params } = world;
  const A = W / H;
  const rng = new RNG(world.seed + ':plates');
  const P = clamp(Math.round(num(params.plateCount, 12)), 3, 48);
  const nwx = createNoise2D(world.seed + ':warp-x');
  const nwy = createNoise2D(world.seed + ':warp-y');

  // --- seeds: best-candidate sampling gives even spacing; weights vary plate sizes
  const sx = new Float64Array(P), sy = new Float64Array(P), wt = new Float64Array(P);
  for (let k = 0; k < P; k++) {
    let bx = 0, by = 0, bs = -1;
    for (let c = 0; c < 12; c++) {
      const cx = rng.float(0.05, A - 0.05), cy = rng.float(0.06, 0.94);
      let md = 1e9;
      for (let j = 0; j < k; j++) { const d = (cx - sx[j]) ** 2 + (cy - sy[j]) ** 2; if (d < md) md = d; }
      if (md > bs) { bs = md; bx = cx; by = cy; }
    }
    sx[k] = bx; sy[k] = by; wt[k] = rng.float(0, 0.07);
  }
  const cont = new Uint8Array(P);
  const nearest = (qx, qy, bonus) => {
    let best = 0, bd = Infinity;
    for (let k = 0; k < P; k++) {
      const dx = qx - sx[k], dy = qy - sy[k];
      const d = Math.sqrt(dx * dx + dy * dy) - wt[k] - (cont[k] ? bonus : 0);
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  };

  // --- coarse decision grid
  const CH = COARSE_ROWS, CW = Math.max(8, Math.round(CH * A)), CN = CW * CH;
  const wUsedC = octavesFor(CH, WARP_FREQ, WARP_OCT);
  const cqx = new Float64Array(CN), cqy = new Float64Array(CN), cu = new Float64Array(CN), cv = new Float64Array(CN);
  for (let cy = 0; cy < CH; cy++) for (let cx = 0; cx < CW; cx++) {
    const c = cy * CW + cx, u = (cx + 0.5) / CH, v = (cy + 0.5) / CH;
    cu[c] = u; cv[c] = v;
    cqx[c] = u + WARP * fbmL(nwx, u * WARP_FREQ, v * WARP_FREQ, WARP_OCT, wUsedC);
    cqy[c] = v + WARP * fbmL(nwy, u * WARP_FREQ, v * WARP_FREQ, WARP_OCT, wUsedC);
  }
  const cPlate = new Uint8Array(CN);
  const assignCoarse = (bonus) => { for (let c = 0; c < CN; c++) cPlate[c] = nearest(cqx[c], cqy[c], bonus); };
  assignCoarse(0);
  const area = new Float64Array(P);
  const adj = new Float64Array(P * P);
  const measure = () => {
    area.fill(0); adj.fill(0);
    for (let cy = 0; cy < CH; cy++) for (let cx = 0; cx < CW; cx++) {
      const c = cy * CW + cx, a = cPlate[c];
      area[a] += 1 / CN;
      if (cx + 1 < CW) { const b = cPlate[c + 1]; if (b !== a) { adj[a * P + b]++; adj[b * P + a]++; } }
      if (cy + 1 < CH) { const b = cPlate[c + CW]; if (b !== a) { adj[a * P + b]++; adj[b * P + a]++; } }
    }
  };
  measure();

  // --- continental cores, spread apart and away from the map's side edges
  const oceanCov = clamp(num(params.oceanCoverage, 0.6), 0.05, 0.98);
  const target = clamp((1 - oceanCov) * 1.1, 0.04, 0.97);
  const nc = clamp(Math.round(num(params.continents, 4)), 1, P - 1);
  const central = new Float64Array(P);
  for (let k = 0; k < P; k++) {
    central[k] = 0.06 + smoothstep(0.02, 0.32, Math.min(sx[k], A - sx[k])) * smoothstep(0.02, 0.22, Math.min(sy[k], 1 - sy[k]));
  }
  const contOf = new Int16Array(P).fill(-1);
  const cores = [];
  {
    const w0 = Array.from(central, (c, k) => c * (area[k] + 0.01));
    const first = Math.max(0, weightedIndex(rng, w0));
    cores.push(first); contOf[first] = 0;
    while (cores.length < nc) {
      let best = -1, bs = -1;
      for (let k = 0; k < P; k++) {
        if (contOf[k] >= 0) continue;
        let md = Infinity;
        for (const j of cores) md = Math.min(md, Math.hypot(sx[k] - sx[j], sy[k] - sy[j]));
        const s = md * central[k] * Math.sqrt(area[k] * P + 0.05) * rng.float(0.65, 1.35);   // spread out, central, not tiny
        if (s > bs) { bs = s; best = k; }
      }
      if (best < 0) break;
      contOf[best] = cores.length; cores.push(best);
    }
  }
  // grow continents across neighbouring plates (keeping distinct continents apart)
  const contArea = () => { let s = 0; for (let k = 0; k < P; k++) if (contOf[k] >= 0) s += area[k]; return s; };
  for (let guard = 0; guard < P && contArea() < target * 0.8; guard++) {
    const sizes = cores.map((_, ci) => { let s = 0; for (let k = 0; k < P; k++) if (contOf[k] === ci) s += area[k]; return [ci, s]; });
    sizes.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    let grew = false;
    for (const [ci] of sizes) {
      let best = -1, bs = 0;
      for (let k = 0; k < P; k++) {
        if (contOf[k] >= 0 || area[k] <= 0) continue;
        let shared = 0, foreign = false;
        for (let j = 0; j < P; j++) {
          const a = adj[k * P + j];
          if (!a) continue;
          if (contOf[j] === ci) shared += a;
          else if (contOf[j] >= 0) foreign = true;
        }
        if (!shared || foreign) continue;
        const s = shared * rng.float(0.5, 1.5);
        if (s > bs) { bs = s; best = k; }
      }
      if (best >= 0) { contOf[best] = ci; grew = true; break; }
    }
    if (!grew) break;
  }
  for (let k = 0; k < P; k++) cont[k] = contOf[k] >= 0 ? 1 : 0;

  // --- size continental crust toward the land target (bisection on an additive bonus).
  // The estimate mirrors the relief stage: crust thins over a margin at the plate edge,
  // toward the map frame, and where the crust noise opens inland seas; microcontinents
  // add a little on oceanic plates.
  const nCrust = createNoise2D(world.seed + ':crust');
  const nFrame = createNoise2D(world.seed + ':frame');
  const frag = clamp(num(params.fragmentation, 0.35), 0, 1);
  const cW = new Float64Array(CN), cMicro = new Float64Array(CN);
  for (let c = 0; c < CN; c++) {
    const u = cu[c], v = cv[c];
    const cn = fbmL(nCrust, u * 2.1, v * 2.1, 4, octavesFor(CH, 2.1, 4));
    const edge = frameTaper(u, v, A, 0.07 * fbmL(nFrame, u * 1.5, v * 1.5, 3, octavesFor(CH, 1.5, 3)));
    cW[c] = edge * (1 - 0.6 * smoothstep(0.36 - 0.3 * frag, 0.72 - 0.3 * frag, -cn));
    cMicro[c] = edge * smoothstep(0.6 - 0.16 * frag, 0.68 - 0.1 * frag, cn);
  }
  // distance from every coarse cell to every seed, minus the seed weight (computed once)
  const cdist = new Float64Array(CN * P);
  for (let c = 0; c < CN; c++) for (let k = 0; k < P; k++) cdist[c * P + k] = Math.hypot(cqx[c] - sx[k], cqy[c] - sy[k]) - wt[k];
  const isC = new Uint8Array(CN), cd = new Float64Array(CN), cCont = new Int16Array(CN);
  const contFrac = (bonus) => {
    for (let c = 0; c < CN; c++) {
      let best = 0, bd = Infinity;
      const o = c * P;
      for (let k = 0; k < P; k++) { const d = cdist[o + k] - (cont[k] ? bonus : 0); if (d < bd) { bd = d; best = k; } }
      isC[c] = cont[best]; cCont[c] = contOf[best]; cd[c] = isC[c] ? 1e9 : 0;
    }
    // distinct continents are always parted by sea (see the relief stage): where two
    // meet, the crust tapers as it does toward an ocean
    for (let cy = 0; cy < CH; cy++) for (let cx = 0; cx < CW; cx++) {
      const c = cy * CW + cx;
      if (!isC[c]) continue;
      const k = cCont[c];
      if ((cx + 1 < CW && isC[c + 1] && cCont[c + 1] !== k) || (cy + 1 < CH && isC[c + CW] && cCont[c + CW] !== k)) cd[c] = 0;
    }
    chamfer(CW, CH, cd);
    let s = 0;
    for (let c = 0; c < CN; c++) {
      s += isC[c] ? cW[c] * smoothstep(0, 0.045, cd[c] / CH) : cMicro[c];
    }
    return s / CN;
  };
  // shrinking continental plates toward a small land target must never erase one: each
  // keeps at least 45 % of its unweighted area (the sea level then drowns the rest)
  const cells = new Int32Array(P);
  const plateCells = (bonus) => {
    cells.fill(0);
    for (let c = 0; c < CN; c++) {
      let best = 0, bd = Infinity;
      const o = c * P;
      for (let k = 0; k < P; k++) { const d = cdist[o + k] - (cont[k] ? bonus : 0); if (d < bd) { bd = d; best = k; } }
      cells[best]++;
    }
    return cells;
  };
  const base = Int32Array.from(plateCells(0));
  const keepsAll = (bonus) => {
    const a = plateCells(bonus);
    for (let k = 0; k < P; k++) if (cont[k] && a[k] < 0.45 * base[k]) return false;
    return true;
  };
  let floor = -0.8;
  if (!keepsAll(floor)) {
    let lo = -0.8, hi = 0;
    for (let it = 0; it < 14; it++) { const mid = (lo + hi) / 2; if (keepsAll(mid)) hi = mid; else lo = mid; }
    floor = hi;
  }
  let bonus = 0;
  {
    let lo = floor, hi = 0.6;
    if (contFrac(lo) >= target) bonus = lo;
    else if (contFrac(hi) <= target) bonus = hi;
    else {
      for (let it = 0; it < 16; it++) {
        const mid = (lo + hi) / 2;
        if (contFrac(mid) < target) lo = mid; else hi = mid;
      }
      bonus = (lo + hi) / 2;
    }
  }
  assignCoarse(bonus);
  measure();

  // plate centroids (unwarped), used for spin velocities
  const pcx = new Float64Array(P), pcy = new Float64Array(P), pcn = new Float64Array(P);
  for (let c = 0; c < CN; c++) { const k = cPlate[c]; pcx[k] += cu[c]; pcy[k] += cv[c]; pcn[k]++; }
  for (let k = 0; k < P; k++) {
    if (pcn[k]) { pcx[k] /= pcn[k]; pcy[k] /= pcn[k]; } else { pcx[k] = sx[k]; pcy[k] = sy[k]; }
  }

  // --- plate motions: several candidate sets, keep the one with the most active margins
  const vx = new Float64Array(P), vy = new Float64Array(P), om = new Float64Array(P);
  const dense = new Float64Array(P);
  for (let k = 0; k < P; k++) dense[k] = rng.next();
  let bestScore = -1;
  const tvx = new Float64Array(P), tvy = new Float64Array(P), tom = new Float64Array(P);
  for (let t = 0; t < MOTION_TRIES; t++) {
    for (let k = 0; k < P; k++) {
      const th = rng.float(0, Math.PI * 2), sp = rng.float(0.3, 1.0) * (cont[k] ? 0.72 : 1);
      tvx[k] = Math.cos(th) * sp; tvy[k] = Math.sin(th) * sp; tom[k] = rng.float(-0.9, 0.9);
    }
    let score = 0;
    for (let cy = 0; cy < CH; cy++) for (let cx = 0; cx < CW; cx++) {
      const c = cy * CW + cx, a = cPlate[c];
      for (let s = 0; s < 2; s++) {
        const nxc = cx + (s === 0 ? 1 : 0), nyc = cy + (s === 1 ? 1 : 0);
        if (nxc >= CW || nyc >= CH) continue;
        const b = cPlate[nyc * CW + nxc];
        if (b === a || !(cont[a] || cont[b])) continue;
        const nx = s === 0 ? 1 : 0, ny = s === 1 ? 1 : 0;
        const u = cu[c], v = cv[c];
        const rx = (tvx[a] - tom[a] * (v - pcy[a])) - (tvx[b] - tom[b] * (v - pcy[b]));
        const ry = (tvy[a] + tom[a] * (u - pcx[a])) - (tvy[b] + tom[b] * (u - pcx[b]));
        const conv = rx * nx + ry * ny;
        if (conv > 0.25) score += cont[a] && cont[b] ? 1.4 : 1;
        else if (conv < -0.25) score += 0.25;
      }
    }
    score += rng.next() * 0.5;
    if (score > bestScore) { bestScore = score; vx.set(tvx); vy.set(tvy); om.set(tom); }
  }

  // --- full-resolution plate assignment
  const wUsedF = octavesFor(H, WARP_FREQ, WARP_OCT);
  const plate = f.plate;
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / H;
      const qx = u + WARP * fbmL(nwx, u * WARP_FREQ, v * WARP_FREQ, WARP_OCT, wUsedF);
      const qy = v + WARP * fbmL(nwy, u * WARP_FREQ, v * WARP_FREQ, WARP_OCT, wUsedF);
      plate[y * W + x] = nearest(qx, qy, bonus);
    }
  }

  // --- boundary tiles: neighbouring plate, local normal, relative motion
  const bOther = new Int16Array(N).fill(-1);
  const bConv = new Float32Array(N), bShear = new Float32Array(N);
  const isB = new Uint8Array(N);
  const cnt = new Int32Array(P);
  const R = Math.max(2, Math.round(H / 64));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, a = plate[i];
    let other = -1;
    for (let d = 0; d < 8; d += 2) {
      const nx = x + DX8[d], ny = y + DY8[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (plate[ny * W + nx] !== a) { other = 1; break; }
    }
    if (other < 0) continue;
    // most common foreign plate in the 8-neighbourhood
    let bestB = -1, bestN = 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX8[d], ny = y + DY8[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const b = plate[ny * W + nx];
      if (b === a) continue;
      if (++cnt[b] > bestN) { bestN = cnt[b]; bestB = b; }
    }
    for (let d = 0; d < 8; d++) {
      const nx = x + DX8[d], ny = y + DY8[d];
      if (nx >= 0 && ny >= 0 && nx < W && ny < H) cnt[plate[ny * W + nx]] = 0;
    }
    if (bestB < 0) continue;
    const b = bestB;
    // normal from a toward b, from the plate indicator over a (2R+1)² window
    let nx = 0, ny = 0;
    for (let oy = -R; oy <= R; oy++) {
      const yy = y + oy; if (yy < 0 || yy >= H) continue;
      for (let ox = -R; ox <= R; ox++) {
        const xx = x + ox; if (xx < 0 || xx >= W) continue;
        const p = plate[yy * W + xx];
        if (p === b) { nx += ox; ny += oy; } else if (p === a) { nx -= ox; ny -= oy; }
      }
    }
    let nl = Math.hypot(nx, ny);
    if (nl < 1e-6) { nx = sx[b] - sx[a]; ny = sy[b] - sy[a]; nl = Math.hypot(nx, ny) || 1; }
    nx /= nl; ny /= nl;
    const u = (x + 0.5) / H, v = (y + 0.5) / H;
    const rx = (vx[a] - om[a] * (v - pcy[a])) - (vx[b] - om[b] * (v - pcy[b]));
    const ry = (vy[a] + om[a] * (u - pcx[a])) - (vy[b] + om[b] * (u - pcx[b]));
    bOther[i] = b;
    bConv[i] = clamp((rx * nx + ry * ny) / 1.1, -1, 1);
    bShear[i] = clamp(Math.abs(rx * ny - ry * nx) / 1.1, 0, 1);
    isB[i] = 1;
  }
  // smooth convergence along each boundary (same plate pair) to remove tile noise
  const tmpC = new Float32Array(N), tmpS = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!isB[i]) continue;
    const a = plate[i], b = bOther[i];
    let sc = 0, ss = 0, n = 0;
    for (let oy = -2; oy <= 2; oy++) {
      const yy = y + oy; if (yy < 0 || yy >= H) continue;
      for (let ox = -2; ox <= 2; ox++) {
        const xx = x + ox; if (xx < 0 || xx >= W) continue;
        const j = yy * W + xx;
        if (isB[j] && plate[j] === a && bOther[j] === b) { sc += bConv[j]; ss += bShear[j]; n++; }
      }
    }
    tmpC[i] = n ? sc / n : bConv[i]; tmpS[i] = n ? ss / n : bShear[i];
  }
  for (let i = 0; i < N; i++) if (isB[i]) { bConv[i] = tmpC[i]; bShear[i] = tmpS[i]; }

  // --- distance to the nearest boundary of the tile's own plate (Dijkstra within plates)
  const dist = new Float32Array(N).fill(1e9);
  const bSrc = new Int32Array(N).fill(-1);
  const heap = new MinHeap(Math.max(1024, N >> 2));
  for (let i = 0; i < N; i++) if (isB[i]) { dist[i] = 0.5; bSrc[i] = i; heap.push(i, 0.5); }
  while (heap.size) {
    const pr = heap.peekPriority();
    const c = heap.pop();
    if (pr > dist[c] + 1e-6) continue;
    const pc = plate[c], x = c % W, y = (c / W) | 0, dc = dist[c];
    for (let d = 0; d < 8; d++) {
      const nx = x + DX8[d], ny = y + DY8[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (plate[j] !== pc) continue;
      const nd = dc + DIST8[d];
      if (nd < dist[j]) { dist[j] = nd; bSrc[j] = bSrc[c]; heap.push(j, nd); }
    }
  }
  const bDn = new Float32Array(N);
  for (let i = 0; i < N; i++) bDn[i] = bSrc[i] >= 0 ? dist[i] / H : 10;

  // --- plateBoundary: tectonic stress, 1 at strongly convergent edges
  const pbf = f.plateBoundary;
  for (let i = 0; i < N; i++) {
    const s = bSrc[i];
    if (s < 0) { pbf[i] = 0; continue; }
    const c = bConv[s];
    let k;
    if (c > 0.04) k = 0.6 + 0.4 * smoothstep(0.04, 0.45, c);
    else if (c < -0.04) k = 0.38 + 0.12 * Math.min(1, -c);
    else k = 0.45 + 0.2 * bShear[s];
    pbf[i] = k * Math.exp(-bDn[i] / 0.028);
  }

  ctx.plates = { P, cont, contId: Int16Array.from(contOf), dense, vx, vy, om, cx: pcx, cy: pcy, area: Float64Array.from(area), sx, sy };
  ctx.bSrc = bSrc; ctx.bDn = bDn; ctx.bOther = bOther; ctx.bConv = bConv; ctx.bShear = bShear;
  ctx.coarse = { CW, CH, plate: cPlate };
}

/** Velocity of plate k at normalised point (u, v): drift plus spin about its centroid. */
export function plateVelocity(pl, k, u, v) {
  return [pl.vx[k] - pl.om[k] * (v - pl.cy[k]), pl.vy[k] + pl.om[k] * (u - pl.cx[k])];
}

/** Plate id at a normalised point from the resolution-independent coarse grid. */
export function coarsePlateAt(ctx, u, v) {
  const { CW, CH, plate } = ctx.coarse;
  const cx = clamp(Math.floor(u * CH), 0, CW - 1), cy = clamp(Math.floor(v * CH), 0, CH - 1);
  return plate[cy * CW + cx];
}
