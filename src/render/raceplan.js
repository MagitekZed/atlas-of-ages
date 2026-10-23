// The Mythic peoples' own towns at close zoom. A race town keeps the plan geometry every town
// has (cityplan.js buildPlan: a footprint grown from its peak population, arterials along its
// real roads and river, blocks in growth order lived in up to today's population and left to
// the weeds beyond, walls by level with gates and breaches, landmarks from its buildings) and
// builds on it the way its people build:
//
//   halflings  smials dug into terraced green hills, round doors and kitchen gardens, sandy
//              lanes between hedgerows, a party field with its great tree; hedge walls
//   dwarves    stone houses on terraces cut into the hillside, forges smoking among them, the
//              hold's great gate carved into the rock on the town's high side; stone walls
//   elves      tree-halls in groves, lanterns along the winding paths, a great tree at the
//              heart, moonwells; thorn hedges, then pale walls with tree-towers
//   orcs       hide tents and longhouses in a trampled war-camp, fire pits and beast pens,
//              the war-pit at the heart; a spiked palisade behind a ditch
//   lizardfolk thatched houses on stilts over the lagoon between canals and boardwalks, more
//              out over the shore's water, the ziggurat on its island; reed palisades
//
// Decline shows as it does in any town: blocks beyond today's people stand empty and
// overgrown. Painted once into the plan's cached picture (cityplan.js PlanCache), so the cost
// is paid per build, never per frame. cityplan.js passes the shared painters it owns (rivers
// and bridges, outskirts, siege camps, harbours, the land mask, the ordinary town's blocks)
// as `api`, so this module imports nothing from it.
//
// Quarters (mixed peoples, docs/design/mixed-peoples.md): a town whose second people is a quarter or
// more of it (quarterOf) gives that people a wedge of its blocks, in proportion to its share,
// built their way — a halfling lane of smials inside a human city, an elven grove quarter in a
// dwarf hold, a human ward of roofs and lots in an orcish camp (paintQuarter). The wedge is
// chosen in cityplan.js buildPlan and keyed by the people and its share in tenths, so a plan
// rebuilds only when the quarter changes.

import { css, darken, lighten, mix3, INK } from './palette.js';

// the town's mix comes from the sim's published peoples helpers (no quarters without them,
// unless the town carries its own s.peoples)
let peoplesMod = null;
try { peoplesMod = await import('../sim/myth/index.js'); } catch (e) { /* no quarters */ }

const TAU = Math.PI * 2;
const hf = (h, s = 0, bits = 8) => ((h >>> s) & ((1 << bits) - 1)) / ((1 << bits) - 1);
const nx = (h) => { h = Math.imul((h ^ (h >>> 13)) >>> 0, 0x5bd1e995) >>> 0; return (h ^ (h >>> 15)) >>> 0; };
const SHADOW = 'rgba(30,24,16,0.24)';

/** How much wider than a square each race's heart is (its centrepiece). */
export const RACE_CORE = { halfling: 1.45, dwarf: 1.25, elf: 1.75, orc: 1.55, lizardfolk: 1.85 };

/** The landmarks a race town's buildings give it, most prominent first. */
export function raceLandmarks(race, B, capital, tier) {
  const L = [];
  if (capital) L.push({ key: 'palace', level: tier >= 4 ? 2 : 1, size: tier >= 4 ? 1.1 : 0.85 });
  if (B.temple) L.push({ key: 'temple', level: B.temple, size: [0, 0.42, 0.62, 0.9][Math.min(3, B.temple)] });
  switch (race) {
    case 'halfling':
      if (!capital && (B.smial | 0) >= 2) L.push({ key: 'greatsmial', level: 2, size: 0.9 });
      if (B.pantry) L.push({ key: 'pantry', level: B.pantry, size: B.pantry >= 2 ? 0.85 : 0.62 });
      break;
    case 'dwarf': if (B.runeforge) L.push({ key: 'runeforge', level: 1, size: 0.75 }); break;
    case 'elf': if (B.moonwell) L.push({ key: 'moonwell', level: 1, size: 0.62 }); break;
    case 'orc': if (B.beastpen) L.push({ key: 'beastpen', level: 1, size: 0.9 }); break;
    case 'lizardfolk': if (B.spawnpool) L.push({ key: 'spawnpool', level: 1, size: 0.72 }); break;
    default: break;
  }
  if (B.market >= 2) L.push({ key: 'bazaar', level: B.market, size: 0.7 });
  if (B.magetower) L.push({ key: 'magetower', level: B.magetower, size: B.magetower >= 2 ? 0.6 : 0.46 });
  if (B.university) L.push({ key: 'university', level: 1, size: 0.75 });
  if (B.library) L.push({ key: 'library', level: B.library, size: B.library >= 2 ? 0.72 : 0.5 });
  if (B.theatre) L.push({ key: 'theatre', level: B.theatre, size: 0.62 });
  if (B.bank) L.push({ key: 'bank', level: B.bank, size: 0.48 });
  if (B.hospital) L.push({ key: 'hospital', level: B.hospital, size: 0.55 });
  if (B.barracks) L.push({ key: 'barracks', level: B.barracks, size: B.barracks >= 2 ? 0.8 : 0.62 });
  if (B.workshop) L.push({ key: 'workshop', level: 1, size: 0.5 });
  if (B.railway) L.push({ key: 'station', level: 1, size: 0.7 });
  if (B.granary) L.push({ key: 'granary', level: B.granary, size: B.granary >= 2 ? 0.6 : 0.44 });
  return L;
}

// ---------------------------------------------------------------------------
// Shared pieces

function ctxOf(plan, P, detail, api) {
  const px = 1 / P;
  return {
    plan, P, detail, api, px, d: plan.d, R: plan.R, hub: plan.rHub ?? plan.rCore, wS: plan.wS, wA: plan.wA,
    wob: plan.wob, lw: (v) => Math.max(px, v), ink: css(INK, 0.85), B: plan.B || {},
  };
}
/** A colour washed grey while plague is in the town. */
const sick = (c, rgb) => { if (!c.plan.plague) return rgb; const l = (rgb[0] + rgb[1] + rgb[2]) / 3; return mix3(rgb, [l, l, l * 1.02], 0.4); };
const at = (c, a, rr) => { const k = c.wob(a); return [Math.cos(a) * rr * k, Math.sin(a) * rr * k]; };

/** Path of the ring band a0..a1 between radii r0 and r1, following the town's wobble. */
function bandPath(g, c, a0, a1, r0, r1) {
  const n = Math.max(2, Math.ceil(((a1 - a0) * Math.max(r1, 0.01)) / (c.d * 0.3)));
  for (let q = 0; q <= n; q++) { const p = at(c, a0 + ((a1 - a0) * q) / n, r0); if (q) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); }
  for (let q = n; q >= 0; q--) { const p = at(c, a0 + ((a1 - a0) * q) / n, r1); g.lineTo(p[0], p[1]); }
  g.closePath();
}
/** An open arc a0..a1 at radius rr (following the wobble). */
function arcPath(g, c, a0, a1, rr) {
  const n = Math.max(2, Math.ceil(((a1 - a0) * Math.max(rr, 0.01)) / (c.d * 0.3)));
  for (let q = 0; q <= n; q++) { const p = at(c, a0 + ((a1 - a0) * q) / n, rr); if (q) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); }
}
/** Points spaced about `step` apart along a block's arc at radius rr: [{ x, y, a, k }]. */
function along(c, b, rr, step, inset = 0.5) {
  const n = Math.max(1, Math.round(((b.a1 - b.a0) * rr) / step));
  const out = [];
  for (let q = 0; q < n; q++) { const a = b.a0 + ((b.a1 - b.a0) * (q + inset)) / n; const [x, y] = at(c, a, rr); out.push({ x, y, a, k: q, n }); }
  return out;
}
/** The arterials resampled every `step` tiles from the heart's edge outward, wandering by `wig` tiles. */
function lanes(c, step, wig = 0, from = 0.85) {
  const out = [];
  for (const art of c.plan.arterials) {
    const p = art.pts, pts = [];
    for (let k = 0; k + 3 < p.length; k += 2) {
      const ax = p[k], ay = p[k + 1], bx = p[k + 2], by = p[k + 3];
      const L = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(L / step));
      for (let q = 0; q < n; q++) {
        const t = q / n, x = ax + (bx - ax) * t, y = ay + (by - ay) * t, rho = Math.hypot(x, y);
        if (rho < c.hub * from) continue;
        const o = wig ? Math.sin(rho * 41 + art.k * 2.1) * wig * Math.min(1, (rho - c.hub * from) / (c.d * 2)) : 0;
        pts.push(x - (y / (rho || 1)) * o, y + (x / (rho || 1)) * o);
      }
    }
    if (pts.length >= 4) out.push(pts);
  }
  return out;
}
function strokeLines(g, lines) { g.beginPath(); for (const pts of lines) { g.moveTo(pts[0], pts[1]); for (let k = 2; k < pts.length; k += 2) g.lineTo(pts[k], pts[k + 1]); } g.stroke(); }

/** The town's ground: blocks dilated into their streets, the heart, the forecourts, the arterials. */
function townGround(g, c, rgb, spread = 2.6) {
  const plan = c.plan, api = c.api;
  g.fillStyle = css(rgb); g.strokeStyle = css(rgb); g.lineJoin = 'round'; g.lineCap = 'round';
  g.beginPath(); for (const b of plan.blocks) api.polyPath(g, b.pts);
  g.lineWidth = c.wS * spread; g.fill(); g.stroke();
  g.beginPath(); g.arc(0, 0, c.hub + c.wS * 1.5, 0, TAU);
  for (const lm of plan.landmarks) { g.moveTo(lm.x + lm.size * 1.25 + c.wS, lm.y); g.arc(lm.x, lm.y, lm.size * 1.25 + c.wS, 0, TAU); }
  g.fill();
  g.lineWidth = c.wA * 1.1;
  g.beginPath(); for (const a of plan.arterials) { g.moveTo(a.pts[0], a.pts[1]); for (let k = 2; k < Math.min(a.pts.length, 18); k += 2) g.lineTo(a.pts[k], a.pts[k + 1]); } g.stroke();
}

/** A crown of leaves seen from above: shadow, body, lit side. */
function crown(g, x, y, r, dark, mid, lit, shadow = true) {
  if (shadow) { g.fillStyle = SHADOW; g.beginPath(); g.arc(x + r * 0.3, y + r * 0.38, r, 0, TAU); g.fill(); }
  g.fillStyle = css(dark); g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
  g.fillStyle = css(mid); g.beginPath(); g.arc(x - r * 0.14, y - r * 0.16, r * 0.74, 0, TAU); g.fill();
  if (lit) { g.fillStyle = css(lit); g.beginPath(); g.arc(x - r * 0.3, y - r * 0.34, r * 0.38, 0, TAU); g.fill(); }
}
/** A warm light: a soft halo and its flame. */
function lantern(g, x, y, r, rgb = [255, 214, 120]) {
  g.fillStyle = css(rgb, 0.22); g.beginPath(); g.arc(x, y, r * 2.6, 0, TAU); g.fill();
  g.fillStyle = css(lighten(rgb, 0.4)); g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
}
function star(g, x, y, r0, r1, n = 5) {
  g.beginPath();
  for (let q = 0; q < n * 2; q++) { const a = -Math.PI / 2 + (q * Math.PI) / n, rr = q & 1 ? r0 : r1; g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
  g.closePath();
}
function flagAt(g, c, x, y, h, rgb) {
  g.strokeStyle = c.ink; g.lineWidth = c.lw(c.d * 0.02);
  g.beginPath(); g.moveTo(x, y); g.lineTo(x, y - h); g.stroke();
  g.fillStyle = css(rgb); g.beginPath(); g.moveTo(x, y - h); g.lineTo(x + h * 0.6, y - h * 0.82); g.lineTo(x, y - h * 0.64); g.closePath(); g.fill(); g.stroke();
}
/** Ticks along the wall's runs every `step` tiles: fn(x, y, a). */
function alongRuns(G, step, fn) {
  for (const rn of G.runs) {
    let carry = 0;
    for (let k = 0; k + 3 < rn.length; k += 2) {
      const ax = rn[k], ay = rn[k + 1], bx = rn[k + 2], by = rn[k + 3], L = Math.hypot(bx - ax, by - ay);
      let t = carry;
      while (t < L) { const u = t / L, x = ax + (bx - ax) * u, y = ay + (by - ay) * u; fn(x, y, Math.atan2(y, x)); t += step; }
      carry = t - L;
    }
  }
}
function strokeRuns(g, G, dx = 0, dy = 0) {
  g.beginPath();
  for (const rn of G.runs) { g.moveTo(rn[0] + dx, rn[1] + dy); for (let k = 2; k < rn.length; k += 2) g.lineTo(rn[k] + dx, rn[k + 1] + dy); }
  g.stroke();
}
/** The wall's course at another radius (same open stretches): for ditches, banks and second rings. */
function ringRuns(G, rr) {
  const out = []; let cur = null;
  for (let q = 0; q <= G.N; q++) {
    const a = (q / G.N) * TAU;
    if (G.isGate(a) || G.isBreach(a) || G.isOpen(a)) { if (cur && cur.length > 2) out.push(cur); cur = null; continue; }
    (cur ||= []).push(...G.pt(a, rr));
  }
  if (cur && cur.length > 2) out.push(cur);
  return out;
}
/** Rubble spilling out of a breach. */
function breaches(g, c, G, rgb, width) {
  g.fillStyle = css(rgb);
  for (const ba of G.wl.breaches) for (let q = 0; q < 6; q++) {
    const aa = ba + (q - 2.5) * 0.04, rr = G.R * (1.02 + (q % 3) * 0.03);
    g.beginPath(); g.arc(Math.cos(aa) * rr, Math.sin(aa) * rr, width * 0.5, 0, TAU); g.fill();
  }
}

// ---------------------------------------------------------------------------
// Halflings: smials in terraced green hills

const DOORS = [[64, 112, 58], [206, 164, 58], [164, 58, 40], [58, 90, 138], [122, 74, 44]];
const FLOWERS = [[236, 122, 150], [246, 214, 90], [250, 246, 236], [196, 96, 196]];
const GARDENS = [[118, 150, 74], [146, 162, 82], [104, 136, 66], [160, 140, 92], [132, 158, 78]];

const HALFLING = {
  bank: [130, 136, 96], bridge: [176, 142, 96],
  ground(g, c) {
    townGround(g, c, [146, 176, 100], 3.4);
    const L = lanes(c, c.d * 0.25, c.d * 0.2);
    g.lineCap = 'round'; g.lineJoin = 'round';
    if (c.detail >= 1) { g.strokeStyle = css([82, 118, 62]); g.lineWidth = c.wA * 1.2; strokeLines(g, L); }
    g.strokeStyle = css([214, 194, 146]); g.lineWidth = c.wA * 0.6; strokeLines(g, L);
    if (c.detail >= 1) {
      // hedgerow along each lane
      g.strokeStyle = css([96, 138, 70], 0.9); g.lineWidth = c.wA * 0.22; g.setLineDash([c.d * 0.04, c.d * 0.05]);
      strokeLines(g, L); g.setLineDash([]);
      g.strokeStyle = css([214, 194, 146]); g.lineWidth = c.wA * 0.5; strokeLines(g, L);
      // and a hedgerow oak here and there
      for (const pts of L) for (let k = 6; k + 1 < pts.length; k += 10) {
        const dx = pts[Math.min(pts.length - 2, k + 2)] - pts[k], dy = pts[Math.min(pts.length - 1, k + 3)] - pts[k + 1], l = Math.hypot(dx, dy) || 1, sg = (k / 10) & 1 ? 1 : -1;
        crown(g, pts[k] - (dy / l) * c.wA * 0.75 * sg, pts[k + 1] + (dx / l) * c.wA * 0.75 * sg, c.d * 0.13, [64, 104, 52], [86, 132, 66], [120, 162, 88]);
      }
    }
  },
  blocks(g, c) {
    const d = c.d, det = c.detail, ink = c.ink;
    for (const b of c.plan.blocks) {
      if (b.a0 == null) continue;
      const ma = (c.wS * 0.4) / Math.max(0.02, b.r0);
      const a0 = b.a0 + ma, a1 = b.a1 - ma;
      const rh = b.r0 + (b.r1 - b.r0) * 0.64;
      if (b.green) {
        // an orchard
        g.fillStyle = css([128, 160, 88]); g.beginPath(); bandPath(g, c, a0, a1, b.r0, b.r1); g.fill();
        for (const p of along(c, b, (b.r0 + b.r1) / 2, d * 0.32)) {
          crown(g, p.x, p.y, d * 0.12, [80, 122, 62], [100, 146, 74], null, det >= 1);
          if (det >= 1) { g.fillStyle = css(p.k & 1 ? [206, 70, 50] : [236, 200, 70]); g.beginPath(); g.arc(p.x + d * 0.03, p.y - d * 0.02, d * 0.025, 0, TAU); g.fill(); }
        }
        continue;
      }
      const lived = b.state === 1;
      // the hill the smials are dug into: puffy, lit on its crest
      g.save(); g.translate(d * 0.06, d * 0.08); g.fillStyle = SHADOW; g.beginPath(); bandPath(g, c, a0, a1, b.r0, rh); g.fill(); g.restore();
      const hill = sick(c, lived ? [112, 152, 78] : [104, 128, 80]);
      g.fillStyle = css(hill); g.strokeStyle = css(hill); g.lineWidth = d * 0.1; g.lineJoin = 'round';
      g.beginPath(); bandPath(g, c, a0, a1, b.r0 + d * 0.04, rh - d * 0.03); g.fill(); g.stroke();
      if (det >= 1) {
        g.strokeStyle = css(lighten(hill, 0.3), 0.75); g.lineWidth = d * 0.06;
        g.beginPath(); arcPath(g, c, a0 + ma, a1 - ma, b.r0 + (rh - b.r0) * 0.62); g.stroke();
        g.strokeStyle = css(darken(hill, 0.25), 0.7); g.lineWidth = c.lw(d * 0.025);
        g.beginPath(); arcPath(g, c, a0, a1, rh + d * 0.01); g.stroke();
      }
      if (lived) {
        // round doors facing the lane, with windows and chimney pots at street level
        for (const p of along(c, b, b.r0 + d * 0.05, d * 0.36)) {
          const h = nx(b.h + p.k * 977);
          if (det >= 1) { g.fillStyle = css([226, 212, 178]); g.beginPath(); g.arc(p.x, p.y, d * 0.1, 0, TAU); g.fill(); }
          g.fillStyle = css(DOORS[h % DOORS.length]); g.beginPath(); g.arc(p.x, p.y, d * (det ? 0.072 : 0.085), 0, TAU); g.fill();
          if (det >= 1) { g.strokeStyle = ink; g.lineWidth = c.lw(d * 0.012); g.stroke(); g.fillStyle = css([236, 196, 80]); g.beginPath(); g.arc(p.x, p.y, d * 0.014, 0, TAU); g.fill(); }
          if (det >= 2) {
            const ta = p.a + Math.PI / 2, tx = Math.cos(ta), ty = Math.sin(ta);
            g.fillStyle = css([250, 228, 150]);
            for (const sgn of [-1, 1]) { g.beginPath(); g.arc(p.x + tx * sgn * d * 0.15, p.y + ty * sgn * d * 0.15, d * 0.03, 0, TAU); g.fill(); }
            const [hx, hy] = at(c, p.a + (hf(h, 8) - 0.5) * 0.1, b.r0 + (rh - b.r0) * 0.72);
            g.fillStyle = css([150, 84, 60]); g.fillRect(hx - d * 0.025, hy - d * 0.025, d * 0.05, d * 0.05);
          }
        }
        // kitchen gardens behind: rows, flowers, fences between plots
        g.fillStyle = css([124, 152, 80]); g.beginPath(); bandPath(g, c, a0, a1, rh + d * 0.03, b.r1); g.fill();
        if (det >= 1) {
          // plots of greens, beans, barley and turned earth
          const np = Math.max(1, Math.round(((a1 - a0) * (rh + b.r1) / 2) / (d * 0.26)));
          for (let q = 0; q < np; q++) {
            const hq = nx(b.h * 31 + q);
            g.fillStyle = css(GARDENS[hq % GARDENS.length]); g.beginPath();
            bandPath(g, c, a0 + ((a1 - a0) * q) / np + ma * 0.3, a0 + ((a1 - a0) * (q + 1)) / np - ma * 0.3, rh + d * 0.05, b.r1 - d * 0.02); g.fill();
          }
          g.strokeStyle = css([94, 122, 58], 0.85); g.lineWidth = c.lw(d * 0.022);
          g.beginPath();
          for (let q = 1; q <= 3; q++) arcPath(g, c, a0 + ma, a1 - ma, rh + d * 0.03 + ((b.r1 - rh - d * 0.03) * q) / 4);
          g.stroke();
          for (const p of along(c, b, (rh + b.r1) / 2, d * 0.2)) {
            const h = nx(b.h ^ (p.k * 6151));
            if (hf(h, 3) < 0.45) { g.fillStyle = css(FLOWERS[h % FLOWERS.length]); g.beginPath(); g.arc(p.x, p.y, d * 0.03, 0, TAU); g.fill(); }
          }
          if (det >= 2) {
            g.strokeStyle = css([204, 182, 136], 0.9); g.lineWidth = c.lw(d * 0.012);
            g.beginPath();
            for (const p of along(c, b, rh, d * 0.36, 0)) { const [ox, oy] = at(c, p.a, b.r1 - d * 0.02); g.moveTo(p.x, p.y); g.lineTo(ox, oy); }
            g.stroke();
          }
        }
      } else {
        // left: boarded doors, the gardens gone to grass and bramble
        g.fillStyle = css([128, 146, 92]); g.beginPath(); bandPath(g, c, a0, a1, rh + d * 0.03, b.r1); g.fill();
        g.fillStyle = 'rgba(78,104,58,0.85)'; g.beginPath();
        for (let q = 0; q < 3; q++) { const h = nx(b.h + q * 31); const [x, y] = at(c, a0 + (a1 - a0) * hf(h, 2), b.r0 + (b.r1 - b.r0) * hf(h, 12)); const rr = d * (0.07 + 0.06 * hf(h, 20)); g.moveTo(x + rr, y); g.arc(x, y, rr, 0, TAU); }
        g.fill();
        if (det >= 1) {
          g.fillStyle = css([70, 58, 44]);
          for (const p of along(c, b, b.r0 + d * 0.05, d * 0.5)) { g.beginPath(); g.arc(p.x, p.y, d * 0.05, 0, TAU); g.fill(); }
        }
      }
    }
  },
  core(g, c) {
    // the party field, its ring path and the great tree; a striped pavilion for the feasts
    const R0 = c.hub, d = c.d;
    g.fillStyle = css([158, 190, 110]); g.beginPath(); g.arc(0, 0, R0, 0, TAU); g.fill();
    g.strokeStyle = css([214, 196, 150]); g.lineWidth = c.wS * 0.9; g.beginPath(); g.arc(0, 0, R0 - c.wS * 0.5, 0, TAU); g.stroke();
    crown(g, -R0 * 0.08, -R0 * 0.06, R0 * 0.48, [64, 104, 52], [86, 132, 66], [124, 166, 88]);
    if (c.detail >= 1) {
      g.save(); g.translate(R0 * 0.5, R0 * 0.36); g.rotate(-0.3);
      const w = R0 * 0.36, h = R0 * 0.24;
      g.fillStyle = SHADOW; g.fillRect(-w / 2 + d * 0.04, -h / 2 + d * 0.05, w, h);
      for (let q = 0; q < 5; q++) { g.fillStyle = q & 1 ? 'rgb(244,240,226)' : css(c.plan.civRgb || [176, 58, 44]); g.fillRect(-w / 2 + (w * q) / 5, -h / 2, w / 5 + c.px, h); }
      g.strokeStyle = c.ink; g.lineWidth = c.lw(d * 0.015); g.strokeRect(-w / 2, -h / 2, w, h);
      g.restore();
    }
  },
  landmark(g, c, lm) {
    const s = lm.size, d = c.d, ink = c.ink, det = c.detail;
    g.lineWidth = c.lw(d * 0.03); g.strokeStyle = ink;
    switch (lm.key) {
      case 'palace': case 'greatsmial': {
        // the great smial: a whole hill of doors and windows, the family's banner on top
        g.fillStyle = SHADOW; g.beginPath(); g.ellipse(d * 0.1, d * 0.13, s * 1.05, s * 0.8, 0, 0, TAU); g.fill();
        g.fillStyle = css(sick(c, [108, 150, 74])); g.beginPath(); g.ellipse(0, 0, s * 1.05, s * 0.8, 0, 0, TAU); g.fill();
        g.fillStyle = css([150, 186, 104]); g.beginPath(); g.ellipse(-s * 0.12, -s * 0.14, s * 0.75, s * 0.52, 0, 0, TAU); g.fill();
        const n = lm.key === 'palace' ? 5 : 4;
        for (let q = 0; q < n; q++) {
          const a = Math.PI * (0.15 + (0.7 * q) / (n - 1)), x = Math.cos(a) * s * 0.92, y = Math.sin(a) * s * 0.68;
          const big = q === (n >> 1);
          g.fillStyle = css([226, 212, 178]); g.beginPath(); g.arc(x, y, s * (big ? 0.2 : 0.13), 0, TAU); g.fill();
          g.fillStyle = css(big ? [214, 170, 58] : DOORS[q % DOORS.length]); g.beginPath(); g.arc(x, y, s * (big ? 0.15 : 0.09), 0, TAU); g.fill(); if (det >= 1) g.stroke();
        }
        if (det >= 1) for (const [x, y] of [[-s * 0.4, -s * 0.3], [s * 0.2, -s * 0.42], [s * 0.55, -s * 0.15]]) { g.fillStyle = css([150, 84, 60]); g.fillRect(x - s * 0.04, y - s * 0.04, s * 0.08, s * 0.08); }
        flagAt(g, c, -s * 0.1, -s * 0.2, s * 0.55, c.plan.civRgb || [176, 58, 44]);
        return true;
      }
      case 'temple': {
        // a round chapel under a thatched cone, a bell at its crown
        g.fillStyle = SHADOW; g.beginPath(); g.arc(d * 0.08, d * 0.1, s * 0.66, 0, TAU); g.fill();
        g.fillStyle = css([214, 204, 180]); g.beginPath(); g.arc(0, 0, s * 0.66, 0, TAU); g.fill(); g.stroke();
        const th = c.plan.religion ? mix3(c.plan.religion, [198, 170, 106], 0.6) : [198, 170, 106];
        g.fillStyle = css(th); g.beginPath(); g.arc(0, 0, s * 0.54, 0, TAU); g.fill(); g.stroke();
        if (det >= 1) { g.strokeStyle = css(darken(th, 0.3), 0.7); g.lineWidth = c.lw(d * 0.012); g.beginPath(); for (let q = 0; q < 12; q++) { const a = (q / 12) * TAU; g.moveTo(Math.cos(a) * s * 0.08, Math.sin(a) * s * 0.08); g.lineTo(Math.cos(a) * s * 0.52, Math.sin(a) * s * 0.52); } g.stroke(); }
        g.fillStyle = css([226, 186, 84]); g.beginPath(); g.arc(0, 0, s * 0.09, 0, TAU); g.fill();
        return true;
      }
      case 'granary': {
        const n = lm.level >= 2 ? 3 : 2;
        for (let q = 0; q < n; q++) {
          const x = (q - (n - 1) / 2) * s * 0.7;
          g.fillStyle = SHADOW; g.beginPath(); g.arc(x + d * 0.06, d * 0.08, s * 0.32, 0, TAU); g.fill();
          g.fillStyle = css([200, 172, 108]); g.beginPath(); g.arc(x, 0, s * 0.32, 0, TAU); g.fill(); g.stroke();
          if (det >= 1) { g.strokeStyle = 'rgba(120,92,52,0.7)'; g.beginPath(); for (let k = 0; k < 8; k++) { const a = (k / 8) * TAU; g.moveTo(x, 0); g.lineTo(x + Math.cos(a) * s * 0.3, Math.sin(a) * s * 0.3); } g.stroke(); g.strokeStyle = ink; }
        }
        return true;
      }
      case 'pantry': {
        // the larder: a long mound of cellar doors, barrels lined up before it
        g.fillStyle = SHADOW; g.beginPath(); g.ellipse(d * 0.08, d * 0.1, s, s * 0.5, 0, 0, TAU); g.fill();
        g.fillStyle = css(sick(c, [110, 148, 76])); g.beginPath(); g.ellipse(0, 0, s, s * 0.5, 0, 0, TAU); g.fill(); g.stroke();
        g.fillStyle = css([150, 182, 104]); g.beginPath(); g.ellipse(-s * 0.1, -s * 0.12, s * 0.7, s * 0.26, 0, 0, TAU); g.fill();
        const n = lm.level >= 2 ? 5 : 3;
        for (let q = 0; q < n; q++) { const x = (q - (n - 1) / 2) * s * 0.36; g.fillStyle = css([140, 92, 52]); g.beginPath(); g.arc(x, s * 0.36, s * 0.1, 0, TAU); g.fill(); if (det >= 1) g.stroke(); }
        if (det >= 1) for (let q = 0; q < n + 2; q++) { const x = (q - (n + 1) / 2) * s * 0.26; g.fillStyle = css([156, 110, 66]); g.beginPath(); g.arc(x, s * 0.66, s * 0.07, 0, TAU); g.fill(); g.stroke(); }
        return true;
      }
      case 'bazaar': {
        // the market: stalls under striped awnings
        for (let q = 0; q < 5; q++) {
          const x = (q - 2) * s * 0.42, y = (q & 1 ? 0.2 : -0.2) * s, w = s * 0.34, h = s * 0.3;
          g.fillStyle = SHADOW; g.fillRect(x - w / 2 + d * 0.04, y - h / 2 + d * 0.05, w, h);
          for (let k = 0; k < 4; k++) { g.fillStyle = k & 1 ? 'rgb(244,240,226)' : css(q % 2 ? [206, 74, 52] : [214, 170, 58]); g.fillRect(x - w / 2 + (w * k) / 4, y - h / 2, w / 4 + c.px, h); }
          if (det >= 1) g.strokeRect(x - w / 2, y - h / 2, w, h);
        }
        return true;
      }
      case 'wonder': {
        if (lm.kind !== 'hearth_of_plenty' || lm.ruined) return false;
        g.fillStyle = SHADOW; g.beginPath(); g.arc(d * 0.1, d * 0.12, s * 0.9, 0, TAU); g.fill();
        g.fillStyle = css([212, 198, 166]); g.beginPath(); g.arc(0, 0, s * 0.9, 0, TAU); g.fill(); g.stroke();
        g.fillStyle = css([198, 170, 106]); g.beginPath(); g.arc(0, 0, s * 0.75, 0, TAU); g.fill(); g.stroke();
        g.strokeStyle = css([128, 96, 60]); g.lineWidth = c.lw(d * 0.05);
        g.beginPath(); for (let q = 0; q < 6; q++) { const a = (q / 6) * TAU; g.moveTo(Math.cos(a) * s * 0.28, Math.sin(a) * s * 0.28); g.lineTo(Math.cos(a) * s * 0.6, Math.sin(a) * s * 0.6); } g.stroke();
        lantern(g, 0, 0, s * 0.14, [255, 150, 60]);
        return true;
      }
      default: return false;
    }
  },
  walls(g, c) {
    // hedges: a green ring, then an earth bank, then a low stone dyke with round gatehouses
    const G = c.api.wallGeometry(c.plan), lv = G.wl.level, d = c.d;
    const width = d * (0.13 + 0.03 * Math.min(3, lv));
    g.lineCap = 'round'; g.lineJoin = 'round';
    if (lv >= 2) { g.strokeStyle = 'rgba(120,100,70,0.55)'; g.lineWidth = width * 0.7; g.beginPath(); for (const rn of ringRuns(G, G.R + width * 1.3)) { g.moveTo(rn[0], rn[1]); for (let k = 2; k < rn.length; k += 2) g.lineTo(rn[k], rn[k + 1]); } g.stroke(); }
    g.strokeStyle = SHADOW; g.lineWidth = width * 1.4; strokeRuns(g, G, d * 0.05, d * 0.07);
    g.strokeStyle = css([62, 100, 52]); g.lineWidth = width; strokeRuns(g, G);
    if (c.detail >= 1) { g.strokeStyle = css([98, 140, 72]); g.lineWidth = width * 0.5; g.setLineDash([d * 0.01, d * 0.08]); strokeRuns(g, G, -width * 0.12, -width * 0.12); g.setLineDash([]); }
    if (lv >= 3) { g.strokeStyle = css([196, 188, 166]); g.lineWidth = width * 0.35; g.beginPath(); for (const rn of ringRuns(G, G.R - width * 0.95)) { g.moveTo(rn[0], rn[1]); for (let k = 2; k < rn.length; k += 2) g.lineTo(rn[k], rn[k + 1]); } g.stroke(); }
    for (const ga of G.wl.gates) {
      if (G.isOpen(ga)) continue;
      for (const sg of [-1, 1]) {
        const a = ga + sg * ((c.wA * 0.9) / G.R), [x, y] = G.pt(a);
        g.fillStyle = css(lv >= 3 ? [196, 188, 166] : [150, 112, 70]); g.beginPath(); g.arc(x, y, width * (lv >= 3 ? 0.85 : 0.6), 0, TAU); g.fill();
        g.strokeStyle = c.ink; g.lineWidth = c.lw(d * 0.02); g.stroke();
        if (lv >= 3) { g.fillStyle = css([110, 150, 76]); g.beginPath(); g.arc(x, y, width * 0.5, 0, TAU); g.fill(); }
      }
    }
    breaches(g, c, G, [92, 116, 70], width);
  },
};

// ---------------------------------------------------------------------------
// Dwarves: terraces cut into the rock, forges, the hold's gate

const DWARF = {
  bank: [128, 122, 114], bridge: [176, 170, 160],
  ground(g, c) {
    const d = c.d, plan = c.plan;
    townGround(g, c, [152, 146, 136], 2.6);
    // paved roads with stairs where they climb from terrace to terrace
    const L = lanes(c, c.d * 0.3, 0, 0.6);
    g.lineCap = 'butt'; g.lineJoin = 'round';
    g.strokeStyle = css([100, 96, 90]); g.lineWidth = c.wA * 1.0; strokeLines(g, L);
    g.strokeStyle = css([188, 182, 170]); g.lineWidth = c.wA * 0.74; strokeLines(g, L);
    if (c.detail >= 1) {
      const radii = [...new Set(plan.blocks.map((b) => Math.round(b.r1 * 2000)))].map((v) => v / 2000);
      g.strokeStyle = css([110, 104, 96], 0.8); g.lineWidth = c.lw(d * 0.014);
      g.beginPath();
      for (const art of plan.arterials) {
        for (const rr of radii) {
          const a = plan.artAngle(art.k, rr), ca = Math.cos(a), sa = Math.sin(a), tx = -sa, ty = ca;
          for (let q = 0; q < 3; q++) { const t = rr + (q - 1) * d * 0.05; g.moveTo(ca * t - tx * c.wA * 0.36, sa * t - ty * c.wA * 0.36); g.lineTo(ca * t + tx * c.wA * 0.36, sa * t + ty * c.wA * 0.36); }
        }
      }
      g.stroke();
    }
    // the forecourt before the gate, a ring of runes in its paving
    g.fillStyle = css([186, 180, 168]); g.beginPath(); g.arc(0, 0, c.hub, 0, TAU); g.fill();
    g.strokeStyle = css([104, 98, 90]); g.lineWidth = c.lw(d * 0.04); g.stroke();
    if (c.detail >= 1) {
      g.strokeStyle = css([206, 166, 82], 0.9); g.lineWidth = c.lw(d * 0.025);
      g.beginPath(); g.arc(0, 0, c.hub * 0.55, 0, TAU); g.stroke();
      g.beginPath(); for (let q = 0; q < 12; q++) { const a = (q / 12) * TAU; g.moveTo(Math.cos(a) * c.hub * 0.55, Math.sin(a) * c.hub * 0.55); g.lineTo(Math.cos(a) * c.hub * 0.7, Math.sin(a) * c.hub * 0.7); } g.stroke();
    }
    if (plan.mountA != null) mountain(g, c);
  },
  blocks(g, c) {
    const d = c.d, det = c.detail;
    for (const b of c.plan.blocks) {
      if (b.a0 == null) continue;
      const ma = (c.wS * 0.35) / Math.max(0.02, b.r0);
      const a0 = b.a0 + ma, a1 = b.a1 - ma;
      // the terrace: a retaining wall on its downhill side, a lit lip above
      g.strokeStyle = css([86, 80, 74], 0.85); g.lineWidth = d * 0.06; g.beginPath(); arcPath(g, c, b.a0, b.a1, b.r1 + c.wS * 0.35); g.stroke();
      if (det >= 1) { g.strokeStyle = css([206, 200, 188], 0.8); g.lineWidth = c.lw(d * 0.022); g.beginPath(); arcPath(g, c, b.a0, b.a1, b.r0 - c.wS * 0.25); g.stroke(); }
      if (b.state !== 1) {
        // abandoned: roofless shells and rubble
        g.fillStyle = css([128, 122, 114]); g.beginPath(); bandPath(g, c, a0, a1, b.r0 + d * 0.03, b.r1 - d * 0.03); g.fill();
        if (det >= 1) {
          g.fillStyle = 'rgba(70,64,58,0.55)'; g.beginPath(); bandPath(g, c, a0 + ma, a1 - ma, b.r0 + d * 0.12, b.r1 - d * 0.12); g.fill();
          g.fillStyle = css([158, 152, 142]); g.beginPath();
          for (let q = 0; q < 5; q++) { const h = nx(b.h + q * 53); const [x, y] = at(c, a0 + (a1 - a0) * hf(h, 1), b.r0 + (b.r1 - b.r0) * hf(h, 11)); g.moveTo(x + d * 0.04, y); g.arc(x, y, d * 0.04, 0, TAU); }
          g.fill();
        }
        continue;
      }
      g.save(); g.translate(d * 0.06, d * 0.08); g.fillStyle = SHADOW; g.beginPath(); bandPath(g, c, a0, a1, b.r0 + d * 0.03, b.r1 - d * 0.03); g.fill(); g.restore();
      const wallC = [174, 166, 154], slate = sick(c, hf(b.h, 5) < 0.5 ? [92, 98, 110] : [104, 100, 104]);
      if (det >= 2) {
        // street level: one house per lot, slate roofs and their chimneys
        g.fillStyle = css(wallC); g.beginPath(); bandPath(g, c, a0, a1, b.r0 + d * 0.03, b.r1 - d * 0.03); g.fill();
        const n = Math.max(1, Math.round(((a1 - a0) * (b.r0 + b.r1) / 2) / (d * 0.4)));
        for (let q = 0; q < n; q++) {
          const la = a0 + ((a1 - a0) * q) / n, lb = a0 + ((a1 - a0) * (q + 1)) / n, m2 = (d * 0.03) / Math.max(0.02, b.r0);
          const roof = mix3(slate, [120, 124, 132], hf(nx(b.h + q), 4) * 0.4);
          g.fillStyle = css(roof); g.beginPath(); bandPath(g, c, la + m2, lb - m2, b.r0 + d * 0.06, b.r1 - d * 0.06); g.fill();
          g.strokeStyle = css(darken(roof, 0.45), 0.8); g.lineWidth = c.lw(d * 0.012); g.stroke();
          g.strokeStyle = css(lighten(roof, 0.35), 0.7); g.beginPath(); arcPath(g, c, la + m2 * 2, lb - m2 * 2, (b.r0 + b.r1) / 2); g.stroke();
          const [hx, hy] = at(c, la + (lb - la) * 0.3, b.r0 + (b.r1 - b.r0) * 0.7);
          g.fillStyle = css([70, 64, 60]); g.fillRect(hx - d * 0.025, hy - d * 0.025, d * 0.05, d * 0.05);
        }
      } else {
        g.fillStyle = css(wallC); g.beginPath(); bandPath(g, c, a0, a1, b.r0 + d * 0.03, b.r1 - d * 0.03); g.fill();
        g.fillStyle = css(slate); g.beginPath(); bandPath(g, c, a0 + ma * 0.6, a1 - ma * 0.6, b.r0 + d * 0.09, b.r1 - d * 0.09); g.fill();
        if (det >= 1) { g.strokeStyle = css(lighten(slate, 0.35), 0.7); g.lineWidth = c.lw(d * 0.02); g.beginPath(); arcPath(g, c, a0 + ma, a1 - ma, (b.r0 + b.r1) / 2); g.stroke(); }
      }
      if (b.forge) {
        // a forge: its glow through the open roof
        const [x, y] = [b.cx, b.cy];
        g.fillStyle = css([52, 44, 40]); g.fillRect(x - d * 0.12, y - d * 0.12, d * 0.24, d * 0.24);
        lantern(g, x, y, d * 0.06, [255, 132, 44]);
      }
    }
  },
  core() { /* the forecourt is part of the ground; the gate stands in the rock */ },
  landmark(g, c, lm) {
    const s = lm.size, d = c.d, ink = c.ink, det = c.detail;
    g.lineWidth = c.lw(d * 0.032); g.strokeStyle = ink;
    switch (lm.key) {
      case 'palace': {
        // the king's hall: a long hall behind a pillared porch, braziers at its corners
        const W2 = s, H2 = s * 0.6;
        g.fillStyle = SHADOW; g.fillRect(-W2 + d * 0.1, -H2 + d * 0.13, W2 * 2, H2 * 2);
        g.fillStyle = css([184, 176, 162]); g.fillRect(-W2, -H2, W2 * 2, H2 * 2); g.strokeRect(-W2, -H2, W2 * 2, H2 * 2);
        g.fillStyle = css([88, 94, 108]); g.fillRect(-W2 * 0.9, -H2 * 0.75, W2 * 1.8, H2 * 1.1); g.strokeRect(-W2 * 0.9, -H2 * 0.75, W2 * 1.8, H2 * 1.1);
        g.strokeStyle = css([214, 172, 92]); g.lineWidth = c.lw(d * 0.03); g.beginPath(); g.moveTo(-W2 * 0.85, -H2 * 0.2); g.lineTo(W2 * 0.85, -H2 * 0.2); g.stroke();
        if (det >= 1) { g.fillStyle = css([226, 220, 206]); for (let q = -4; q <= 4; q++) { g.beginPath(); g.arc(q * W2 * 0.2, H2 * 0.68, s * 0.05, 0, TAU); g.fill(); } }
        for (const [x, y] of [[-W2, -H2], [W2, -H2], [W2, H2], [-W2, H2]]) lantern(g, x, y, s * 0.06, [255, 140, 52]);
        return true;
      }
      case 'temple': {
        // the hall of the ancestors: an octagon, its runes gilded
        const oct = (rr) => { g.beginPath(); for (let q = 0; q < 8; q++) { const a = (q / 8) * TAU + Math.PI / 8; g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); } g.closePath(); };
        g.save(); g.translate(d * 0.08, d * 0.1); g.fillStyle = SHADOW; oct(s * 0.8); g.fill(); g.restore();
        g.fillStyle = css([178, 172, 162]); oct(s * 0.8); g.fill(); g.stroke();
        const roof = c.plan.religion ? mix3(c.plan.religion, [96, 92, 100], 0.55) : [96, 92, 100];
        g.fillStyle = css(roof); oct(s * 0.56); g.fill(); g.stroke();
        g.strokeStyle = css([214, 172, 92]); g.lineWidth = c.lw(d * 0.025); g.beginPath(); g.arc(0, 0, s * 0.3, 0, TAU); g.stroke();
        if (det >= 1) { g.beginPath(); for (let q = 0; q < 8; q++) { const a = (q / 8) * TAU; g.moveTo(Math.cos(a) * s * 0.18, Math.sin(a) * s * 0.18); g.lineTo(Math.cos(a) * s * 0.3, Math.sin(a) * s * 0.3); } g.stroke(); }
        return true;
      }
      case 'runeforge': {
        g.fillStyle = SHADOW; g.fillRect(-s + d * 0.1, -s * 0.7 + d * 0.12, s * 2, s * 1.4);
        g.fillStyle = css([118, 110, 102]); g.fillRect(-s, -s * 0.7, s * 2, s * 1.4); g.strokeRect(-s, -s * 0.7, s * 2, s * 1.4);
        g.fillStyle = css([64, 58, 54]); g.fillRect(-s * 0.7, -s * 0.45, s * 1.4, s * 0.9);
        lantern(g, 0, 0, s * 0.16, [255, 128, 40]);
        for (const x of [-s * 0.72, s * 0.72]) { g.fillStyle = css([60, 54, 50]); g.beginPath(); g.arc(x, -s * 0.48, s * 0.15, 0, TAU); g.fill(); g.stroke(); }
        if (det >= 1) { g.fillStyle = css([130, 224, 236]); for (let q = 0; q < 8; q++) { const a = (q / 8) * TAU; g.beginPath(); g.arc(Math.cos(a) * s * 0.5, Math.sin(a) * s * 0.32, s * 0.035, 0, TAU); g.fill(); } }
        return true;
      }
      case 'wonder': {
        if (lm.kind !== 'great_delving' || lm.ruined) return false;
        // the Great Delving: a stair-well going down past counting
        for (let q = 0; q < 6; q++) { const k = 1 - q * 0.15; g.fillStyle = css(darken([176, 168, 156], q * 0.13)); g.fillRect(-s * k, -s * k, s * 2 * k, s * 2 * k); g.strokeRect(-s * k, -s * k, s * 2 * k, s * 2 * k); }
        g.strokeStyle = css([214, 172, 92]); g.lineWidth = c.lw(d * 0.04); g.strokeRect(-s, -s, s * 2, s * 2);
        g.fillStyle = '#1c1714'; g.fillRect(-s * 0.12, -s * 0.12, s * 0.24, s * 0.24);
        return true;
      }
      default: return false;
    }
  },
  walls(g, c) {
    const G = c.api.wallGeometry(c.plan), lv = G.wl.level, d = c.d;
    const width = d * (0.1 + 0.035 * Math.min(4, lv)), col = [150, 146, 140];
    g.lineCap = 'butt'; g.lineJoin = 'miter';
    g.strokeStyle = SHADOW; g.lineWidth = width * 1.6; strokeRuns(g, G, d * 0.06, d * 0.08);
    g.strokeStyle = css(darken(col, 0.45)); g.lineWidth = width * 1.35; strokeRuns(g, G);
    g.strokeStyle = css(col); g.lineWidth = width; strokeRuns(g, G);
    if (c.detail >= 1) { g.strokeStyle = css(lighten(col, 0.3), 0.8); g.lineWidth = width * 0.3; g.setLineDash([d * 0.05, d * 0.05]); strokeRuns(g, G); g.setLineDash([]); }
    if (lv >= 2) {
      // square towers, squarer and stouter with the level
      const nT = Math.max(6, Math.round((TAU * G.R) / (d * 1.3)));
      const tw = width * (lv >= 3 ? 1.25 : 1.0);
      for (let q = 0; q < nT; q++) {
        const a = (q / nT) * TAU + 0.11;
        if (G.isGate(a) || G.isBreach(a) || G.isOpen(a)) continue;
        const [x, y] = G.pt(a);
        g.save(); g.translate(x, y); g.rotate(a);
        g.fillStyle = css(col); g.fillRect(-tw, -tw, tw * 2, tw * 2); g.strokeStyle = c.ink; g.lineWidth = c.lw(d * 0.025); g.strokeRect(-tw, -tw, tw * 2, tw * 2);
        g.restore();
      }
    }
    for (const ga of G.wl.gates) {
      if (G.isOpen(ga)) continue;
      const [x, y] = G.pt(ga);
      g.save(); g.translate(x, y); g.rotate(ga);
      const gw = c.wA * 0.9, tw = width * 1.1;
      g.fillStyle = css(darken(col, 0.12)); g.strokeStyle = c.ink; g.lineWidth = c.lw(d * 0.03);
      g.fillRect(-tw, -gw - tw * 1.6, tw * 2, tw * 1.6); g.strokeRect(-tw, -gw - tw * 1.6, tw * 2, tw * 1.6);
      g.fillRect(-tw, gw, tw * 2, tw * 1.6); g.strokeRect(-tw, gw, tw * 2, tw * 1.6);
      g.restore();
    }
    breaches(g, c, G, [140, 134, 124], width);
  },
};

/** The rock the dwarves' hold is cut into, and the great gate in its face. */
function mountain(g, c) {
  const plan = c.plan, d = c.d, A = plan.mountA, Wd = plan.mountW, r0 = plan.mountR;
  const r1 = Math.max(r0 + d * 2.4, plan.ext * 0.94);
  const h0 = (plan.sid * 2654435761) >>> 0;
  const P = (a, rr) => [Math.cos(a) * rr, Math.sin(a) * rr];
  // the massif: crags crowding up from the cliff, shrinking toward its flanks
  const lumps = [];
  const rows = Math.max(2, Math.round((r1 - r0) / (d * 1.25)));
  for (let k = 0; k < rows; k++) {
    const rr = r0 + d * 0.35 + ((k + 0.3) * (r1 - r0 - d * 0.35)) / rows;
    const span = Wd * (1.02 - 0.18 * (k / rows));
    const n = Math.max(2, Math.round((2 * span * rr) / (d * 1.2)));
    for (let q = 0; q < n; q++) {
      const h = nx(h0 + k * 977 + q * 131);
      const a = A - span + (2 * span * (q + 0.5)) / n + (hf(h, 2) - 0.5) * (span / n) * 0.8;
      const edge = Math.min(1, Math.abs(a - A) / Wd);
      const sz = d * (0.55 + 0.4 * hf(h, 10)) * (1.15 - 0.55 * edge * edge) * (0.9 + 0.35 * (k / rows));
      const [x, y] = P(a, rr + (hf(h, 18) - 0.5) * d * 0.35);
      lumps.push({ x, y, s: sz, h });
    }
  }
  const shape = (L, k = 1, ox = 0, oy = 0) => {
    g.beginPath();
    for (let q = 0; q < 7; q++) { const a = (q / 7) * TAU + hf(L.h, 3) * 0.9, rr = L.s * k * (0.72 + 0.28 * hf(nx(L.h + q), 5)); const x = L.x + ox + Math.cos(a) * rr, y = L.y + oy + Math.sin(a) * rr; if (q) g.lineTo(x, y); else g.moveTo(x, y); }
    g.closePath();
  };
  // the apron of rock under the crags
  g.fillStyle = css([136, 128, 116]); g.beginPath();
  const n0 = 16;
  for (let q = 0; q <= n0; q++) { const a = A - Wd + (2 * Wd * q) / n0; const [x, y] = P(a, r0 * (1 + 0.025 * Math.sin(q * 2.3 + h0))); if (q) g.lineTo(x, y); else g.moveTo(x, y); }
  for (let q = n0; q >= 0; q--) { const a = A - Wd * 0.92 + (1.84 * Wd * q) / n0; const [x, y] = P(a, r1 * (0.78 + 0.12 * hf(nx(h0 + q), 4))); g.lineTo(x, y); }
  g.closePath(); g.fill();
  g.fillStyle = 'rgba(30,24,16,0.28)'; for (const L of lumps) { shape(L, 1, L.s * 0.25, L.s * 0.3); g.fill(); }
  g.fillStyle = css([152, 144, 132]); for (const L of lumps) { shape(L); g.fill(); }
  // shaded south-east faces, lit north-west ones, a crest between, and the ink of each crag
  g.fillStyle = css([114, 106, 98]); for (const L of lumps) { shape(L, 0.66, L.s * 0.26, L.s * 0.28); g.fill(); }
  g.fillStyle = css([194, 186, 172]); for (const L of lumps) { shape(L, 0.44, -L.s * 0.26, -L.s * 0.28); g.fill(); }
  if (c.detail >= 1) { g.strokeStyle = css([226, 220, 206], 0.7); g.lineWidth = c.lw(d * 0.025); g.beginPath(); for (const L of lumps) { g.moveTo(L.x - L.s * 0.55, L.y + L.s * 0.1); g.lineTo(L.x - L.s * 0.05, L.y - L.s * 0.08); g.lineTo(L.x + L.s * 0.45, L.y - L.s * 0.5); } g.stroke(); }
  g.strokeStyle = css([70, 64, 58], 0.75); g.lineWidth = c.lw(d * 0.018); for (const L of lumps) { shape(L); g.stroke(); }
  // the cliff face at its foot, hachured
  g.strokeStyle = css([62, 56, 50]); g.lineWidth = d * 0.07; g.lineJoin = 'round';
  g.beginPath(); for (let q = 0; q <= n0; q++) { const a = A - Wd + (2 * Wd * q) / n0; const [x, y] = P(a, r0 * (1 + 0.025 * Math.sin(q * 2.3 + h0))); if (q) g.lineTo(x, y); else g.moveTo(x, y); } g.stroke();
  if (c.detail >= 1) {
    g.strokeStyle = css([70, 64, 58], 0.7); g.lineWidth = c.lw(d * 0.016); g.beginPath();
    const nh = Math.max(8, Math.round((2 * Wd * r0) / (d * 0.07)));
    for (let q = 0; q <= nh; q++) { const a = A - Wd + (2 * Wd * q) / nh, rr = r0 * (1 + 0.025 * Math.sin((q / nh) * n0 * 2.3 + h0)); const [x0, y0] = P(a, rr), [x1, y1] = P(a, rr + d * (0.12 + 0.08 * (q & 1))); g.moveTo(x0, y0); g.lineTo(x1, y1); }
    g.stroke();
  }
  // the gate, grander with the deep-halls behind it
  const grand = (c.B.deephall | 0) >= 2 || plan.capital;
  const gs = Math.min(c.hub * (grand ? 1.35 : 1.05), Wd * r0 * 0.95);
  const [gx, gy] = P(A, r0);
  g.save(); g.translate(gx, gy); g.rotate(A - Math.PI / 2);
  g.fillStyle = SHADOW; g.fillRect(-gs + d * 0.06, -gs * 0.1, gs * 2, gs * 0.6);
  // the carved face: dressed stone stepping back into the rock
  g.fillStyle = css([186, 178, 164]); g.beginPath(); g.moveTo(-gs, -gs * 0.16); g.lineTo(gs, -gs * 0.16); g.lineTo(gs * 0.8, gs * 0.42); g.lineTo(-gs * 0.8, gs * 0.42); g.closePath(); g.fill();
  g.strokeStyle = c.ink; g.lineWidth = c.lw(d * 0.035); g.stroke();
  g.fillStyle = '#211b17'; g.beginPath(); g.moveTo(-gs * 0.36, -gs * 0.16); g.lineTo(-gs * 0.36, gs * 0.1); g.arc(0, gs * 0.1, gs * 0.36, Math.PI, 0, false); g.lineTo(gs * 0.36, -gs * 0.16); g.closePath(); g.fill();
  g.strokeStyle = css([214, 172, 92]); g.lineWidth = c.lw(d * 0.035); g.stroke();
  for (const sx of [-0.66, 0.66]) { g.fillStyle = css([204, 198, 186]); g.beginPath(); g.arc(sx * gs, gs * 0.06, gs * 0.15, 0, TAU); g.fill(); g.strokeStyle = c.ink; g.lineWidth = c.lw(d * 0.025); g.stroke(); }
  // the stair down to the forecourt
  g.strokeStyle = 'rgba(80,74,68,0.75)'; g.lineWidth = c.lw(d * 0.02);
  g.beginPath(); for (let q = 1; q <= 4; q++) { const y = -gs * 0.16 - q * gs * 0.08, w = gs * (0.42 + q * 0.07); g.moveTo(-w, y); g.lineTo(w, y); } g.stroke();
  for (const sx of [-0.85, 0.85]) lantern(g, sx * gs, -gs * 0.22, gs * 0.05, [255, 150, 60]);
  g.restore();
}

// ---------------------------------------------------------------------------
// Elves: tree-halls in groves, lanterns, the great tree

const ELF = {
  bank: [96, 120, 80], bridge: [212, 200, 170],
  ground(g, c) {
    townGround(g, c, [104, 138, 84], 3.0);
    g.fillStyle = css([150, 180, 112]); g.beginPath(); g.arc(0, 0, c.hub + c.wS, 0, TAU); g.fill();
    const L = lanes(c, c.d * 0.22, c.d * 0.26);
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.strokeStyle = css([226, 212, 172]); g.lineWidth = c.wA * 0.42; strokeLines(g, L);
    if (c.detail >= 1) {
      // lanterns along the paths
      for (const pts of L) for (let k = 4; k < pts.length; k += 6) lantern(g, pts[k], pts[k + 1], c.d * 0.03);
    }
  },
  blocks(g, c) {
    const d = c.d, det = c.detail, ink = c.ink;
    for (const b of c.plan.blocks) {
      if (b.a0 == null) continue;
      const rm = (b.r0 + b.r1) / 2;
      const lived = b.state === 1;
      if (b.green) {
        g.fillStyle = css([138, 170, 102]); g.beginPath(); bandPath(g, c, b.a0, b.a1, b.r0, b.r1); g.fill();
        if (det >= 1) { g.fillStyle = 'rgb(246,244,236)'; for (const p of along(c, b, rm, d * 0.12)) { g.beginPath(); g.arc(p.x, p.y, d * 0.02, 0, TAU); g.fill(); } }
        continue;
      }
      const trees = along(c, b, rm, d * 0.62);
      for (const p of trees) {
        const h = nx(b.h + p.k * 7919);
        const cr = d * (0.3 + 0.1 * hf(h, 2));
        // the hall woven round the trunk shows on the path side, a lantern at its door
        const ia = p.a + Math.PI, hx = p.x + Math.cos(ia) * cr * 0.62, hy = p.y + Math.sin(ia) * cr * 0.62;
        const cx = p.x + Math.cos(p.a) * cr * 0.2, cy = p.y + Math.sin(p.a) * cr * 0.2;
        if (lived) crown(g, cx, cy, cr, [52, 98, 62], [72, 124, 76], [110, 160, 96], true);
        else crown(g, cx, cy, cr * 0.86, [70, 88, 62], [86, 104, 72], null, true);
        if (lived && det >= 1) {
          // its hall, a leaf-roofed platform woven out from the trunk toward the path
          g.save(); g.translate(hx, hy); g.rotate(p.a + Math.PI / 2);
          g.fillStyle = SHADOW; g.beginPath(); g.ellipse(d * 0.03, d * 0.04, cr * 0.66, cr * 0.32, 0, 0, TAU); g.fill();
          g.fillStyle = css(sick(c, [230, 216, 178])); g.beginPath(); g.moveTo(-cr * 0.68, 0); g.quadraticCurveTo(0, -cr * 0.5, cr * 0.68, 0); g.quadraticCurveTo(0, cr * 0.5, -cr * 0.68, 0); g.fill();
          g.strokeStyle = ink; g.lineWidth = c.lw(d * 0.012); g.stroke();
          g.strokeStyle = 'rgba(150,126,86,0.85)'; g.beginPath(); g.moveTo(-cr * 0.55, 0); g.lineTo(cr * 0.55, 0); g.stroke();
          g.restore();
          lantern(g, hx + Math.cos(ia) * cr * 0.3, hy + Math.sin(ia) * cr * 0.3, d * 0.03);
        } else if (lived) { g.fillStyle = css([236, 220, 170]); g.beginPath(); g.arc(hx, hy, d * 0.07, 0, TAU); g.fill(); }
        else if (det >= 1) { g.fillStyle = 'rgba(150,146,134,0.55)'; g.beginPath(); g.ellipse(hx, hy, cr * 0.45, cr * 0.2, p.a + Math.PI / 2, 0, TAU); g.fill(); }
      }
      // the understory at the grove's edge
      if (det >= 1) for (const p of along(c, b, b.r1 - d * 0.04, d * 0.3, 0.25)) crown(g, p.x, p.y, d * 0.1, [60, 104, 66], [84, 132, 80], null, false);
    }
  },
  core(g, c) {
    // the great tree: a lobed crown wider than any hall, ringed with lanterns
    const T = c.hub * 0.98, d = c.d;
    const big = (c.B.treehall | 0) >= 2 || c.plan.capital;
    const lobes = 7;
    g.fillStyle = SHADOW; g.beginPath(); g.arc(T * 0.22, T * 0.28, T, 0, TAU); g.fill();
    for (const [k, col, off] of [[1, [44, 90, 58], 0], [0.82, [62, 114, 72], 0.08], [0.55, [94, 146, 90], 0.2], [0.26, [130, 176, 108], 0.32]]) {
      g.fillStyle = css(col); g.beginPath();
      const ox = -T * off, oy = -T * off * 1.1;
      g.moveTo(ox + T * k * 0.62, oy); g.arc(ox, oy, T * k * 0.62, 0, TAU);
      if (k > 0.5) for (let q = 0; q < lobes; q++) { const a = (q / lobes) * TAU + k; const x = ox + Math.cos(a) * T * k * 0.5, y = oy + Math.sin(a) * T * k * 0.5; g.moveTo(x + T * k * 0.42, y); g.arc(x, y, T * k * 0.42, 0, TAU); }
      g.fill();
    }
    if (c.detail >= 1) {
      const n = big ? 16 : 10;
      for (let q = 0; q < n; q++) { const a = (q / n) * TAU; lantern(g, Math.cos(a) * T * 1.08, Math.sin(a) * T * 1.08, d * 0.032); }
    }
    if (big) { g.fillStyle = css([236, 214, 140]); star(g, -T * 0.3, -T * 0.34, T * 0.04, T * 0.1, 4); g.fill(); }
  },
  landmark(g, c, lm) {
    const s = lm.size, d = c.d, ink = c.ink, det = c.detail;
    g.lineWidth = c.lw(d * 0.028); g.strokeStyle = ink;
    switch (lm.key) {
      case 'palace': {
        // the moon court: a leaf-shaped hall about a silver dome, gardens either side
        g.fillStyle = SHADOW; g.beginPath(); g.ellipse(d * 0.08, d * 0.1, s, s * 0.55, 0, 0, TAU); g.fill();
        g.fillStyle = css([118, 162, 98]); g.fillRect(-s * 1.05, -s * 0.2, s * 0.35, s * 0.4); g.fillRect(s * 0.7, -s * 0.2, s * 0.35, s * 0.4);
        g.fillStyle = css(sick(c, [232, 226, 206])); g.beginPath(); g.ellipse(0, 0, s * 0.8, s * 0.5, 0, 0, TAU); g.fill(); g.stroke();
        g.fillStyle = css([206, 216, 226]); g.beginPath(); g.arc(0, 0, s * 0.26, 0, TAU); g.fill(); g.stroke();
        if (det >= 1) for (const x of [-s * 0.55, s * 0.55]) lantern(g, x, 0, d * 0.035);
        return true;
      }
      case 'temple': {
        // a moon shrine: a ring of white pillars about a silver disc
        g.fillStyle = css([160, 190, 124]); g.beginPath(); g.arc(0, 0, s * 0.8, 0, TAU); g.fill();
        const disc = c.plan.religion ? mix3(c.plan.religion, [214, 222, 232], 0.6) : [214, 222, 232];
        g.fillStyle = css(disc, 0.35); g.beginPath(); g.arc(0, 0, s * 0.5, 0, TAU); g.fill();
        g.fillStyle = css(disc); g.beginPath(); g.arc(0, 0, s * 0.3, 0, TAU); g.fill(); g.stroke();
        g.fillStyle = 'rgb(242,240,232)';
        for (let q = 0; q < 8; q++) { const a = (q / 8) * TAU; g.beginPath(); g.arc(Math.cos(a) * s * 0.62, Math.sin(a) * s * 0.62, s * 0.08, 0, TAU); g.fill(); if (det >= 1) g.stroke(); }
        return true;
      }
      case 'moonwell': {
        g.fillStyle = css([236, 234, 224]); g.beginPath(); g.arc(0, 0, s * 0.64, 0, TAU); g.fill(); g.stroke();
        g.fillStyle = css([140, 184, 214]); g.beginPath(); g.arc(0, 0, s * 0.52, 0, TAU); g.fill();
        g.fillStyle = 'rgba(220,240,252,0.75)'; g.beginPath(); g.arc(-s * 0.08, -s * 0.08, s * 0.24, 0, TAU); g.fill();
        if (det >= 1) { g.fillStyle = css([170, 170, 164]); for (let q = 0; q < 6; q++) { const a = (q / 6) * TAU + 0.3; g.beginPath(); g.arc(Math.cos(a) * s * 0.8, Math.sin(a) * s * 0.8, s * 0.07, 0, TAU); g.fill(); } }
        return true;
      }
      case 'wonder': {
        if (lm.kind !== 'heartwood_throne' || lm.ruined) return false;
        crown(g, 0, 0, s, [40, 86, 54], [62, 116, 72], [104, 158, 92]);
        g.fillStyle = css([226, 186, 84]); g.beginPath(); g.arc(-s * 0.15, -s * 0.15, s * 0.2, 0, TAU); g.fill(); g.stroke();
        for (let q = 0; q < 12; q++) { const a = (q / 12) * TAU; lantern(g, Math.cos(a) * s * 1.1, Math.sin(a) * s * 1.1, d * 0.03); }
        return true;
      }
      default: return false;
    }
  },
  walls(g, c) {
    const G = c.api.wallGeometry(c.plan), lv = G.wl.level, d = c.d;
    g.lineCap = 'round'; g.lineJoin = 'round';
    if (lv <= 1) {
      // a thorn hedge
      const width = d * 0.13;
      g.strokeStyle = SHADOW; g.lineWidth = width * 1.4; strokeRuns(g, G, d * 0.05, d * 0.07);
      g.strokeStyle = css([52, 86, 52]); g.lineWidth = width; strokeRuns(g, G);
      if (c.detail >= 1) {
        g.strokeStyle = css([40, 66, 40]); g.lineWidth = c.lw(d * 0.014);
        g.beginPath(); alongRuns(G, d * 0.07, (x, y, a) => { const o = a + (((x * 97) | 0) & 1 ? 0.5 : -0.5); g.moveTo(x, y); g.lineTo(x + Math.cos(o) * width * 1.1, y + Math.sin(o) * width * 1.1); }); g.stroke();
      }
    } else {
      // pale walls with trees for towers
      const width = d * (0.08 + 0.02 * lv), col = [226, 224, 212];
      g.strokeStyle = SHADOW; g.lineWidth = width * 1.6; strokeRuns(g, G, d * 0.05, d * 0.07);
      g.strokeStyle = css(darken(col, 0.4)); g.lineWidth = width * 1.3; strokeRuns(g, G);
      g.strokeStyle = css(col); g.lineWidth = width; strokeRuns(g, G);
      const nT = Math.max(6, Math.round((TAU * G.R) / (d * 1.5)));
      for (let q = 0; q < nT; q++) {
        const a = (q / nT) * TAU + 0.2;
        if (G.isGate(a) || G.isBreach(a) || G.isOpen(a)) continue;
        const [x, y] = G.pt(a);
        g.fillStyle = css(col); g.beginPath(); g.arc(x, y, width * 1.1, 0, TAU); g.fill(); g.strokeStyle = c.ink; g.lineWidth = c.lw(d * 0.02); g.stroke();
        crown(g, x, y, width * 0.85, [52, 98, 62], [80, 132, 80], null, false);
      }
    }
    for (const ga of G.wl.gates) {
      if (G.isOpen(ga)) continue;
      for (const sg of [-1, 1]) { const [x, y] = G.pt(ga + sg * ((c.wA * 0.9) / G.R)); lantern(g, x, y, d * 0.04); }
    }
    breaches(g, c, G, lv <= 1 ? [72, 96, 60] : [200, 196, 184], d * 0.12);
  },
};

// ---------------------------------------------------------------------------
// Orcs: a war-camp of hide tents, fire pits and pens round the war-pit

const HIDES = [[150, 104, 66], [126, 94, 62], [170, 130, 86], [112, 84, 58], [142, 82, 54]];

const ORC = {
  bank: [118, 96, 70], bridge: [128, 96, 64],
  ground(g, c) {
    const d = c.d;
    townGround(g, c, [164, 136, 98], 3.0);
    if (c.detail >= 1) {
      // mud where the camp is trampled hardest
      g.fillStyle = 'rgba(126,98,68,0.55)'; g.beginPath();
      const h0 = (c.plan.sid * 40503) >>> 0;
      for (let q = 0; q < 14; q++) { const h = nx(h0 + q * 211), a = hf(h, 0, 10) * TAU, rr = c.R * Math.sqrt(hf(h, 10, 10)), x = Math.cos(a) * rr, y = Math.sin(a) * rr, s = d * (0.15 + 0.2 * hf(h, 20)); g.moveTo(x + s, y); g.ellipse(x, y, s, s * 0.6, a, 0, TAU); }
      g.fill();
    }
    const L = lanes(c, c.d * 0.25, c.d * 0.08, 0.7);
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.strokeStyle = css([134, 104, 72]); g.lineWidth = c.wA * 0.85; strokeLines(g, L);
    if (c.detail >= 1) {
      // ruts of the war-wagons
      g.strokeStyle = css([98, 74, 50], 0.8); g.lineWidth = c.lw(d * 0.016);
      g.beginPath();
      for (const pts of L) for (const sg of [-1, 1]) {
        for (let k = 0; k + 3 < pts.length; k += 2) {
          const dx = pts[k + 2] - pts[k], dy = pts[k + 3] - pts[k + 1], l = Math.hypot(dx, dy) || 1, ox = (-dy / l) * c.wA * 0.2 * sg, oy = (dx / l) * c.wA * 0.2 * sg;
          if (!k) g.moveTo(pts[k] + ox, pts[k + 1] + oy);
          g.lineTo(pts[k + 2] + ox, pts[k + 3] + oy);
        }
      }
      g.stroke();
    }
  },
  blocks(g, c) {
    const d = c.d, det = c.detail, ink = c.ink;
    for (const b of c.plan.blocks) {
      if (b.a0 == null) continue;
      const rm = (b.r0 + b.r1) / 2;
      if (b.state !== 1) {
        // burnt out: charred rings, ash
        for (const p of along(c, b, rm, d * 0.42)) {
          g.fillStyle = 'rgba(70,60,52,0.8)'; g.beginPath(); g.arc(p.x, p.y, d * 0.16, 0, TAU); g.fill();
          g.fillStyle = 'rgba(150,142,132,0.75)'; g.beginPath(); g.arc(p.x - d * 0.03, p.y - d * 0.02, d * 0.07, 0, TAU); g.fill();
        }
        continue;
      }
      if (hf(b.h, 9) < 0.22 && (b.a1 - b.a0) * rm > d * 0.9) {
        // a longhouse of the clan
        const ma = (c.wS * 0.5) / Math.max(0.02, b.r0);
        g.save(); g.translate(d * 0.06, d * 0.08); g.fillStyle = SHADOW; g.beginPath(); bandPath(g, c, b.a0 + ma, b.a1 - ma, b.r0 + d * 0.08, b.r1 - d * 0.08); g.fill(); g.restore();
        const roof = sick(c, [100, 72, 50]);
        g.fillStyle = css(roof); g.beginPath(); bandPath(g, c, b.a0 + ma, b.a1 - ma, b.r0 + d * 0.08, b.r1 - d * 0.08); g.fill();
        if (det >= 1) { g.strokeStyle = ink; g.lineWidth = c.lw(d * 0.014); g.stroke(); g.strokeStyle = css(lighten(roof, 0.3), 0.8); g.lineWidth = c.lw(d * 0.025); g.beginPath(); arcPath(g, c, b.a0 + ma * 2, b.a1 - ma * 2, rm); g.stroke(); }
      } else {
        // hide tents
        const depth = b.r1 - b.r0;
        const rowsR = depth > d * 0.72 ? [b.r0 + depth * 0.3, b.r0 + depth * 0.74] : [rm];
        const tents = [];
        rowsR.forEach((rr, ri) => { for (const p of along(c, b, rr, d * 0.34, ri ? 0.2 : 0.6)) tents.push(p); });
        for (const p of tents) {
          const h = nx(b.h + p.k * 613 + Math.round(p.x * 7919));
          const tr = d * (0.14 + 0.06 * hf(h, 4));
          const x = p.x + Math.cos(p.a) * (hf(h, 12) - 0.5) * d * 0.1, y = p.y + Math.sin(p.a) * (hf(h, 12) - 0.5) * d * 0.1;
          const hide = sick(c, HIDES[h % HIDES.length]);
          g.fillStyle = SHADOW; g.beginPath(); g.arc(x + tr * 0.35, y + tr * 0.45, tr, 0, TAU); g.fill();
          g.fillStyle = css(hide); g.beginPath(); g.arc(x, y, tr, 0, TAU); g.fill();
          if (det >= 1) {
            g.strokeStyle = ink; g.lineWidth = c.lw(d * 0.012); g.stroke();
            g.strokeStyle = css(darken(hide, 0.35), 0.8); g.beginPath();
            for (let q = 0; q < 5; q++) { const a = (q / 5) * TAU + hf(h, 20); g.moveTo(x + Math.cos(a) * tr * 0.2, y + Math.sin(a) * tr * 0.2); g.lineTo(x + Math.cos(a) * tr, y + Math.sin(a) * tr); }
            g.stroke();
          }
          g.fillStyle = 'rgb(42,32,26)'; g.beginPath(); g.arc(x, y, tr * 0.2, 0, TAU); g.fill();
        }
      }
      if (det >= 1) {
        // a fire pit by the tents, and racks of drying hides at street level
        const [fx, fy] = at(c, (b.a0 + b.a1) / 2 + 0.02, b.r1 - d * 0.02);
        g.fillStyle = css([60, 48, 40]); g.beginPath(); g.arc(fx, fy, d * 0.065, 0, TAU); g.fill();
        lantern(g, fx, fy, d * 0.032, [255, 140, 50]);
        if (det >= 2) {
          g.strokeStyle = css([96, 70, 48]); g.lineWidth = c.lw(d * 0.014); g.beginPath();
          const [rx, ry] = at(c, b.a0 + (b.a1 - b.a0) * 0.2, b.r1 - d * 0.04);
          g.moveTo(rx - d * 0.05, ry - d * 0.05); g.lineTo(rx + d * 0.05, ry + d * 0.05); g.moveTo(rx + d * 0.05, ry - d * 0.05); g.lineTo(rx - d * 0.05, ry + d * 0.05); g.stroke();
        }
      }
    }
  },
  core(g, c) {
    const R0 = c.hub, d = c.d, det = c.detail;
    if (c.B.warpit) {
      // the war-pit: a sunken ring of trodden earth, blood on its sand, stakes round its rim
      g.fillStyle = css([118, 90, 62]); g.beginPath(); g.arc(0, 0, R0, 0, TAU); g.fill();
      g.strokeStyle = css([92, 68, 46]); g.lineWidth = c.lw(d * 0.03);
      for (let q = 1; q <= 3; q++) { g.beginPath(); g.arc(0, 0, R0 * (0.62 + q * 0.11), 0, TAU); g.stroke(); }
      g.fillStyle = css([202, 172, 122]); g.beginPath(); g.arc(0, 0, R0 * 0.6, 0, TAU); g.fill();
      g.fillStyle = 'rgba(130,36,26,0.5)'; g.beginPath(); g.ellipse(R0 * 0.12, -R0 * 0.08, R0 * 0.16, R0 * 0.1, 0.6, 0, TAU); g.fill();
      if (det >= 1) {
        g.strokeStyle = css([70, 50, 34]); g.lineWidth = c.lw(d * 0.03); g.beginPath();
        const n = Math.max(16, Math.round((TAU * R0) / (d * 0.12)));
        for (let q = 0; q < n; q++) { const a = (q / n) * TAU; g.moveTo(Math.cos(a) * R0 * 1.02, Math.sin(a) * R0 * 1.02); g.lineTo(Math.cos(a) * R0 * 1.14, Math.sin(a) * R0 * 1.14); }
        g.stroke();
      }
      for (let q = 0; q < 4; q++) { const a = (q / 4) * TAU + 0.4; flagAt(g, c, Math.cos(a) * R0 * 1.1, Math.sin(a) * R0 * 1.1, d * 0.4, c.plan.civRgb || [150, 40, 30]); }
    } else {
      g.fillStyle = css([176, 146, 104]); g.beginPath(); g.arc(0, 0, R0, 0, TAU); g.fill();
      g.fillStyle = css([64, 50, 40]); g.beginPath(); g.arc(0, 0, R0 * 0.3, 0, TAU); g.fill();
      lantern(g, 0, 0, R0 * 0.14, [255, 140, 50]);
    }
  },
  landmark(g, c, lm) {
    const s = lm.size, d = c.d, ink = c.ink, det = c.detail;
    g.lineWidth = c.lw(d * 0.03); g.strokeStyle = ink;
    const skull = (x, y, r) => { g.fillStyle = css([232, 224, 206]); g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); g.stroke(); if (det >= 1) { g.fillStyle = '#1c1612'; g.beginPath(); g.arc(x - r * 0.35, y - r * 0.1, r * 0.22, 0, TAU); g.arc(x + r * 0.35, y - r * 0.1, r * 0.22, 0, TAU); g.fill(); } };
    switch (lm.key) {
      case 'palace': {
        // the chieftain's hall: a long hide roof, skull poles at either end, the clan's banners
        g.fillStyle = SHADOW; g.fillRect(-s + d * 0.1, -s * 0.45 + d * 0.12, s * 2, s * 0.9);
        g.fillStyle = css([92, 66, 46]); g.fillRect(-s, -s * 0.45, s * 2, s * 0.9); g.strokeRect(-s, -s * 0.45, s * 2, s * 0.9);
        g.strokeStyle = css([136, 102, 70]); g.lineWidth = c.lw(d * 0.04); g.beginPath(); g.moveTo(-s * 0.95, 0); g.lineTo(s * 0.95, 0); g.stroke();
        g.strokeStyle = ink; g.lineWidth = c.lw(d * 0.025);
        skull(-s * 1.18, 0, s * 0.12); skull(s * 1.18, 0, s * 0.12);
        flagAt(g, c, -s * 0.5, -s * 0.45, s * 0.5, c.plan.civRgb || [150, 40, 30]); flagAt(g, c, s * 0.5, -s * 0.45, s * 0.5, c.plan.civRgb || [150, 40, 30]);
        return true;
      }
      case 'temple': {
        // a ring of standing stones about the skull totem
        g.fillStyle = css([150, 128, 96]); g.beginPath(); g.arc(0, 0, s * 0.8, 0, TAU); g.fill();
        g.fillStyle = css([140, 136, 128]);
        for (let q = 0; q < 8; q++) { const a = (q / 8) * TAU; g.save(); g.translate(Math.cos(a) * s * 0.66, Math.sin(a) * s * 0.66); g.rotate(a); g.fillRect(-s * 0.09, -s * 0.06, s * 0.18, s * 0.12); g.strokeRect(-s * 0.09, -s * 0.06, s * 0.18, s * 0.12); g.restore(); }
        const tot = c.plan.religion ? mix3(c.plan.religion, [96, 70, 50], 0.5) : [96, 70, 50];
        g.fillStyle = css(tot); g.beginPath(); g.arc(0, 0, s * 0.2, 0, TAU); g.fill(); g.stroke();
        skull(0, 0, s * 0.12);
        return true;
      }
      case 'beastpen': {
        g.fillStyle = css([150, 126, 90]); g.fillRect(-s, -s * 0.7, s * 2, s * 1.4);
        g.strokeStyle = css([96, 70, 46]); g.lineWidth = c.lw(d * 0.03); g.setLineDash([d * 0.06, d * 0.03]); g.strokeRect(-s, -s * 0.7, s * 2, s * 1.4); g.setLineDash([]);
        g.beginPath(); g.moveTo(0, -s * 0.7); g.lineTo(0, s * 0.7); g.stroke();
        g.fillStyle = css([66, 52, 42]);
        for (let q = 0; q < 5; q++) { const x = (q % 3 - 1) * s * 0.55 + (q > 2 ? s * 0.25 : 0), y = (q > 2 ? 0.3 : -0.25) * s; g.beginPath(); g.ellipse(x, y, s * 0.16, s * 0.09, 0.4 * q, 0, TAU); g.fill(); }
        return true;
      }
      case 'granary': {
        // racks of meat curing in the smoke
        g.strokeStyle = css([96, 70, 48]); g.lineWidth = c.lw(d * 0.03);
        for (let q = -1; q <= 1; q++) { g.beginPath(); g.moveTo(-s, q * s * 0.4); g.lineTo(s, q * s * 0.4); g.stroke(); if (det >= 1) { g.fillStyle = css([160, 60, 44]); for (let k = -3; k <= 3; k++) { g.beginPath(); g.arc(k * s * 0.26, q * s * 0.4 + s * 0.06, s * 0.06, 0, TAU); g.fill(); } } }
        return true;
      }
      case 'wonder': {
        if (lm.kind !== 'skull_throne' || lm.ruined) return false;
        for (let q = 0; q < 3; q++) { const k = 1 - q * 0.28; g.fillStyle = css(darken([120, 110, 100], q * 0.15)); g.fillRect(-s * k, -s * k, s * 2 * k, s * 2 * k); g.strokeRect(-s * k, -s * k, s * 2 * k, s * 2 * k); }
        for (let q = 0; q < 7; q++) { const a = (q / 7) * TAU; skull(Math.cos(a) * s * 0.22, Math.sin(a) * s * 0.22, s * 0.1); }
        skull(0, 0, s * 0.13);
        return true;
      }
      default: return false;
    }
  },
  walls(g, c) {
    // a spiked palisade behind its ditch; ramparts and timber towers as it grows
    const G = c.api.wallGeometry(c.plan), lv = G.wl.level, d = c.d;
    const width = d * (0.07 + 0.02 * Math.min(4, lv)), wood = [92, 64, 42];
    g.lineCap = 'butt'; g.lineJoin = 'round';
    g.strokeStyle = 'rgba(96,74,50,0.75)'; g.lineWidth = width * 1.1;
    g.beginPath(); for (const rn of ringRuns(G, G.R + width * 2.2)) { g.moveTo(rn[0], rn[1]); for (let k = 2; k < rn.length; k += 2) g.lineTo(rn[k], rn[k + 1]); } g.stroke();
    if (lv >= 2) { g.strokeStyle = css([142, 116, 82]); g.lineWidth = width * 1.8; g.beginPath(); for (const rn of ringRuns(G, G.R - width * 1.4)) { g.moveTo(rn[0], rn[1]); for (let k = 2; k < rn.length; k += 2) g.lineTo(rn[k], rn[k + 1]); } g.stroke(); }
    g.strokeStyle = SHADOW; g.lineWidth = width * 1.5; strokeRuns(g, G, d * 0.05, d * 0.07);
    g.strokeStyle = css(wood); g.lineWidth = width; strokeRuns(g, G);
    // stakes leaning out
    g.strokeStyle = css(darken(wood, 0.2)); g.lineWidth = c.lw(d * 0.022);
    g.beginPath();
    alongRuns(G, d * (c.detail >= 1 ? 0.08 : 0.14), (x, y, a) => { g.moveTo(x, y); g.lineTo(x + Math.cos(a) * d * 0.16, y + Math.sin(a) * d * 0.16); });
    g.stroke();
    if (lv >= 2) {
      const nT = Math.max(6, Math.round((TAU * G.R) / (d * 1.4)));
      for (let q = 0; q < nT; q++) {
        const a = (q / nT) * TAU + 0.15;
        if (G.isGate(a) || G.isBreach(a) || G.isOpen(a)) continue;
        const [x, y] = G.pt(a), tw = width * 1.3;
        g.save(); g.translate(x, y); g.rotate(a);
        g.fillStyle = css([110, 80, 54]); g.fillRect(-tw, -tw, tw * 2, tw * 2); g.strokeStyle = c.ink; g.lineWidth = c.lw(d * 0.02); g.strokeRect(-tw, -tw, tw * 2, tw * 2);
        g.restore();
      }
    }
    for (const ga of G.wl.gates) {
      if (G.isOpen(ga)) continue;
      for (const sg of [-1, 1]) {
        const [x, y] = G.pt(ga + sg * ((c.wA * 0.9) / G.R));
        g.fillStyle = css([232, 224, 206]); g.beginPath(); g.arc(x, y, width * 0.9, 0, TAU); g.fill(); g.strokeStyle = c.ink; g.lineWidth = c.lw(d * 0.018); g.stroke();
      }
    }
    breaches(g, c, G, [80, 60, 44], width);
  },
};

// ---------------------------------------------------------------------------
// Lizardfolk: stilt houses over the lagoon, the ziggurat on its island

const WATERC = [88, 136, 138];

const LIZARD = {
  bank: [96, 116, 84], bridge: [150, 120, 84],
  ground(g, c) {
    const d = c.d, plan = c.plan;
    townGround(g, c, [100, 126, 88], 3.2);
    // canals along the arterials, a boardwalk beside each
    const L = lanes(c, c.d * 0.25, c.d * 0.05, 0.9);
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.strokeStyle = css(WATERC); g.lineWidth = c.wA * 0.95; strokeLines(g, L);
    g.strokeStyle = css([150, 120, 84]); g.lineWidth = c.wA * 0.3;
    g.beginPath();
    for (const pts of L) for (let k = 0; k + 3 < pts.length; k += 2) {
      const dx = pts[k + 2] - pts[k], dy = pts[k + 3] - pts[k + 1], l = Math.hypot(dx, dy) || 1, ox = (-dy / l) * c.wA * 0.62, oy = (dx / l) * c.wA * 0.62;
      if (!k) g.moveTo(pts[k] + ox, pts[k + 1] + oy);
      g.lineTo(pts[k + 2] + ox, pts[k + 3] + oy);
    }
    g.stroke();
    if (c.detail >= 1) {
      // ring canals under each row of houses
      g.strokeStyle = css(WATERC); g.lineWidth = c.wS * 1.5; g.lineCap = 'butt';
      g.beginPath(); for (const b of plan.blocks) if (b.a0 != null) arcPath(g, c, b.a0, b.a1, b.r0 - c.wS * 0.5); g.stroke();
      // reeds at the water's edge
      g.strokeStyle = css([150, 160, 92], 0.85); g.lineWidth = c.lw(d * 0.012); g.beginPath();
      for (const b of plan.blocks) {
        if (b.a0 == null || !(hf(b.h, 14) < 0.6)) continue;
        for (const p of along(c, b, b.r0 - c.wS * 0.1, d * 0.12)) { g.moveTo(p.x, p.y); g.lineTo(p.x + d * 0.02, p.y - d * 0.07); }
      }
      g.stroke();
    }
  },
  blocks(g, c) {
    const d = c.d, det = c.detail, ink = c.ink;
    for (const b of c.plan.blocks) {
      if (b.a0 == null) continue;
      const ma = (c.wS * 0.3) / Math.max(0.02, b.r0);
      const lived = b.state === 1;
      // the houses stand over water
      g.fillStyle = css(lived ? WATERC : [78, 116, 112]); g.beginPath(); bandPath(g, c, b.a0 + ma, b.a1 - ma, b.r0 + d * 0.02, b.r1 - d * 0.02); g.fill();
      if (b.green) {
        g.fillStyle = css([110, 150, 112]); for (const p of along(c, b, (b.r0 + b.r1) / 2, d * 0.3)) { g.beginPath(); g.ellipse(p.x, p.y, d * 0.12, d * 0.07, p.a, 0, TAU); g.fill(); }
        continue;
      }
      const rm = (b.r0 + b.r1) / 2;
      for (const p of along(c, b, rm, d * (det >= 2 ? 0.36 : 0.42))) {
        const h = nx(b.h + p.k * 389);
        if (!lived) {
          if (det >= 1 && hf(h, 3) < 0.6) { g.fillStyle = 'rgba(104,84,60,0.7)'; g.save(); g.translate(p.x, p.y); g.rotate(p.a + 0.4); g.fillRect(-d * 0.12, -d * 0.12, d * 0.2, d * 0.12); g.restore(); }
          continue;
        }
        const ps = d * 0.15, hr = d * (0.11 + 0.03 * hf(h, 6));
        g.save(); g.translate(p.x, p.y); g.rotate(p.a);
        if (det >= 2) { g.fillStyle = css([60, 46, 34]); for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { g.beginPath(); g.arc(sx * ps * 1.12, sy * ps * 1.12, d * 0.018, 0, TAU); g.fill(); } }
        g.fillStyle = SHADOW; g.fillRect(-ps + d * 0.04, -ps + d * 0.05, ps * 2, ps * 2);
        g.fillStyle = css([126, 100, 70]); g.fillRect(-ps, -ps, ps * 2, ps * 2);
        if (det >= 1) { g.strokeStyle = ink; g.lineWidth = c.lw(d * 0.012); g.strokeRect(-ps, -ps, ps * 2, ps * 2); }
        // a walk of planks to the canal
        if (det >= 1) { g.strokeStyle = css([150, 120, 84]); g.lineWidth = c.lw(d * 0.04); g.beginPath(); g.moveTo(-ps, 0); g.lineTo(-(rm - b.r0 + c.wS * 0.4), 0); g.stroke(); }
        g.restore();
        const th = sick(c, [192, 166, 106]);
        g.fillStyle = css(th); g.beginPath(); g.arc(p.x, p.y, hr, 0, TAU); g.fill();
        if (det >= 1) {
          g.strokeStyle = ink; g.lineWidth = c.lw(d * 0.012); g.stroke();
          g.strokeStyle = css(darken(th, 0.3), 0.75); g.beginPath();
          for (let q = 0; q < 6; q++) { const a = (q / 6) * TAU; g.moveTo(p.x, p.y); g.lineTo(p.x + Math.cos(a) * hr, p.y + Math.sin(a) * hr); }
          g.stroke();
        }
        g.fillStyle = css(darken(th, 0.45)); g.beginPath(); g.arc(p.x, p.y, hr * 0.2, 0, TAU); g.fill();
      }
    }
  },
  core(g, c) {
    // the ziggurat on its island in a moat; the sun-altar gilds its crown
    const R0 = c.hub, d = c.d, det = c.detail, ink = c.ink;
    const rot = c.plan.arterials.length ? c.plan.arterials[0].a : 0;
    g.fillStyle = css(WATERC); g.beginPath(); g.arc(0, 0, R0 + c.wS, 0, TAU); g.fill();
    g.fillStyle = css([170, 156, 120]); g.beginPath(); g.arc(0, 0, R0 * 0.92, 0, TAU); g.fill();
    g.save(); g.rotate(rot);
    const s0 = R0 * 0.72, n = 3 + ((c.plan.tier | 0) >= 4 ? 1 : 0) + (c.B.sunaltar ? 1 : 0);
    g.fillStyle = SHADOW; g.fillRect(-s0 + d * 0.12, -s0 + d * 0.15, s0 * 2, s0 * 2);
    g.lineWidth = c.lw(d * 0.025); g.strokeStyle = ink;
    for (let q = 0; q < n; q++) {
      const k = 1 - q / (n + 0.7);
      g.fillStyle = css(lighten([190, 164, 112], q * 0.06)); g.fillRect(-s0 * k, -s0 * k, s0 * 2 * k, s0 * 2 * k); g.strokeRect(-s0 * k, -s0 * k, s0 * 2 * k, s0 * 2 * k);
    }
    // stairs up all four faces
    g.fillStyle = css([146, 122, 84]);
    const sw = s0 * 0.14, top = s0 * (1 - (n - 1) / (n + 0.7));
    for (let q = 0; q < 4; q++) { g.save(); g.rotate((q * Math.PI) / 2); g.fillRect(-sw / 2, top, sw, s0 - top); if (det >= 1) { g.strokeStyle = 'rgba(70,52,34,0.6)'; g.lineWidth = c.lw(d * 0.01); g.beginPath(); for (let y = top; y < s0; y += d * 0.05) { g.moveTo(-sw / 2, y); g.lineTo(sw / 2, y); } g.stroke(); } g.restore(); }
    if (c.B.sunaltar) {
      g.fillStyle = css([236, 196, 84]); g.beginPath(); g.arc(0, 0, top * 0.62, 0, TAU); g.fill(); g.strokeStyle = ink; g.lineWidth = c.lw(d * 0.02); g.stroke();
      if (det >= 1) { g.strokeStyle = css([236, 196, 84], 0.8); g.beginPath(); for (let q = 0; q < 8; q++) { const a = (q / 8) * TAU; g.moveTo(Math.cos(a) * top * 0.7, Math.sin(a) * top * 0.7); g.lineTo(Math.cos(a) * top * 0.95, Math.sin(a) * top * 0.95); } g.stroke(); }
    } else { g.fillStyle = css(c.plan.civRgb || [150, 90, 60]); g.fillRect(-top * 0.45, -top * 0.45, top * 0.9, top * 0.9); }
    g.restore();
  },
  landmark(g, c, lm) {
    const s = lm.size, d = c.d, ink = c.ink, det = c.detail;
    g.lineWidth = c.lw(d * 0.028); g.strokeStyle = ink;
    switch (lm.key) {
      case 'palace': {
        g.fillStyle = css(WATERC); g.beginPath(); g.arc(0, 0, s, 0, TAU); g.fill();
        g.fillStyle = SHADOW; g.fillRect(-s * 0.8 + d * 0.08, -s * 0.8 + d * 0.1, s * 1.6, s * 1.6);
        g.fillStyle = css([126, 100, 70]); g.fillRect(-s * 0.8, -s * 0.8, s * 1.6, s * 1.6); g.strokeRect(-s * 0.8, -s * 0.8, s * 1.6, s * 1.6);
        g.fillStyle = css(sick(c, [200, 172, 110])); g.beginPath(); g.arc(0, 0, s * 0.62, 0, TAU); g.fill(); g.stroke();
        if (det >= 1) { g.strokeStyle = 'rgba(130,104,62,0.8)'; g.beginPath(); for (let q = 0; q < 10; q++) { const a = (q / 10) * TAU; g.moveTo(0, 0); g.lineTo(Math.cos(a) * s * 0.6, Math.sin(a) * s * 0.6); } g.stroke(); }
        flagAt(g, c, s * 0.62, -s * 0.5, s * 0.5, c.plan.civRgb || [80, 140, 100]);
        return true;
      }
      case 'temple': {
        const rel = c.plan.religion ? mix3(c.plan.religion, [190, 164, 112], 0.5) : [214, 180, 96];
        for (let q = 0; q < 3; q++) { const k = 1 - q * 0.3; g.fillStyle = css(q === 2 ? rel : lighten([180, 156, 110], q * 0.08)); g.fillRect(-s * k, -s * k, s * 2 * k, s * 2 * k); g.strokeRect(-s * k, -s * k, s * 2 * k, s * 2 * k); }
        return true;
      }
      case 'spawnpool': {
        g.fillStyle = css([104, 150, 128]); g.beginPath(); g.arc(0, 0, s * 0.66, 0, TAU); g.fill(); g.stroke();
        g.fillStyle = css([236, 230, 200]);
        for (let q = 0; q < 9; q++) { const a = (q / 9) * TAU, rr = s * (0.25 + 0.2 * (q % 3) / 2); g.beginPath(); g.arc(Math.cos(a) * rr, Math.sin(a) * rr, s * 0.06, 0, TAU); g.fill(); }
        if (det >= 1) { g.strokeStyle = css([150, 160, 92]); g.lineWidth = c.lw(d * 0.014); g.beginPath(); for (let q = 0; q < 18; q++) { const a = (q / 18) * TAU, x = Math.cos(a) * s * 0.72, y = Math.sin(a) * s * 0.72; g.moveTo(x, y); g.lineTo(x + Math.cos(a) * s * 0.12, y + Math.sin(a) * s * 0.12 - s * 0.05); } g.stroke(); }
        return true;
      }
      case 'granary': {
        // racks of fish drying in the sun
        g.strokeStyle = css([120, 94, 64]); g.lineWidth = c.lw(d * 0.028);
        for (let q = -1; q <= 1; q++) { g.beginPath(); g.moveTo(-s, q * s * 0.42); g.lineTo(s, q * s * 0.42); g.stroke(); if (det >= 1) { g.fillStyle = css([196, 204, 206]); for (let k = -3; k <= 3; k++) { g.beginPath(); g.ellipse(k * s * 0.26, q * s * 0.42 + s * 0.08, s * 0.03, s * 0.08, 0, 0, TAU); g.fill(); } } }
        return true;
      }
      case 'wonder': {
        if (lm.kind !== 'serpent_ziggurat' || lm.ruined) return false;
        for (let q = 0; q < 5; q++) { const k = 1 - q * 0.17; g.fillStyle = css(lighten([196, 166, 112], q * 0.06)); g.fillRect(-s * k, -s * k, s * 2 * k, s * 2 * k); g.strokeRect(-s * k, -s * k, s * 2 * k, s * 2 * k); }
        // the stone serpent winding up it, its head to the sun
        g.strokeStyle = css([64, 124, 84]); g.lineWidth = c.lw(s * 0.1); g.lineCap = 'round';
        g.beginPath(); for (let q = 0; q <= 40; q++) { const t = q / 40, a = t * TAU * 1.6, rr = s * (1.05 - t * 0.8); g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); } g.stroke();
        g.fillStyle = css([236, 196, 84]); g.beginPath(); g.arc(0, 0, s * 0.14, 0, TAU); g.fill();
        return true;
      }
      default: return false;
    }
  },
  walls(g, c) {
    const G = c.api.wallGeometry(c.plan), lv = G.wl.level, d = c.d;
    g.lineCap = 'butt'; g.lineJoin = 'round';
    if (lv <= 1) {
      // a reed palisade
      const width = d * 0.08, col = [178, 158, 106];
      g.strokeStyle = SHADOW; g.lineWidth = width * 1.5; strokeRuns(g, G, d * 0.04, d * 0.06);
      g.strokeStyle = css(col); g.lineWidth = width; strokeRuns(g, G);
      if (c.detail >= 1) { g.strokeStyle = css(darken(col, 0.35)); g.lineWidth = width * 0.6; g.setLineDash([d * 0.012, d * 0.022]); strokeRuns(g, G); g.setLineDash([]); }
    } else {
      const width = d * (0.1 + 0.02 * lv), col = [178, 146, 104];
      g.strokeStyle = SHADOW; g.lineWidth = width * 1.6; strokeRuns(g, G, d * 0.05, d * 0.07);
      g.strokeStyle = css(darken(col, 0.4)); g.lineWidth = width * 1.3; strokeRuns(g, G);
      g.strokeStyle = css(col); g.lineWidth = width; strokeRuns(g, G);
      const nT = Math.max(6, Math.round((TAU * G.R) / (d * 1.5)));
      for (let q = 0; q < nT; q++) {
        const a = (q / nT) * TAU + 0.3;
        if (G.isGate(a) || G.isBreach(a) || G.isOpen(a)) continue;
        const [x, y] = G.pt(a);
        g.fillStyle = css(col); g.beginPath(); g.arc(x, y, width * 1.15, 0, TAU); g.fill(); g.strokeStyle = c.ink; g.lineWidth = c.lw(d * 0.02); g.stroke();
        g.fillStyle = css([196, 170, 108]); g.beginPath(); g.arc(x, y, width * 0.7, 0, TAU); g.fill();
      }
    }
    breaches(g, c, G, [150, 128, 92], d * 0.1);
  },
  overWater(g, c) {
    // houses on stilts out over the shore's water, each with its walk back to land
    const d = c.d, det = c.detail, ink = c.ink;
    for (const q of c.plan.stilts || []) {
      const ps = d * 0.15, hr = d * (0.11 + 0.03 * hf(q.h, 6));
      const back = q.shore - d * 0.1;
      g.strokeStyle = css([150, 120, 84], q.lived ? 1 : 0.5); g.lineWidth = c.lw(d * 0.045); g.lineCap = 'butt';
      g.beginPath(); g.moveTo(q.x, q.y); g.lineTo(Math.cos(q.a) * back, Math.sin(q.a) * back); g.stroke();
      g.save(); g.translate(q.x, q.y); g.rotate(q.a);
      if (det >= 1) { g.fillStyle = 'rgba(40,30,22,0.8)'; for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { g.beginPath(); g.arc(sx * ps * 1.1, sy * ps * 1.1, d * 0.02, 0, TAU); g.fill(); } }
      if (!q.lived) { g.fillStyle = 'rgba(104,84,60,0.75)'; g.fillRect(-ps, -ps, ps * 1.3, ps * 0.9); g.restore(); continue; }
      g.fillStyle = 'rgba(20,30,34,0.3)'; g.fillRect(-ps + d * 0.05, -ps + d * 0.06, ps * 2, ps * 2);
      g.fillStyle = css([126, 100, 70]); g.fillRect(-ps, -ps, ps * 2, ps * 2);
      if (det >= 1) { g.strokeStyle = ink; g.lineWidth = c.lw(d * 0.012); g.strokeRect(-ps, -ps, ps * 2, ps * 2); }
      g.restore();
      const th = sick(c, [192, 166, 106]);
      g.fillStyle = css(th); g.beginPath(); g.arc(q.x, q.y, hr, 0, TAU); g.fill();
      if (det >= 1) { g.strokeStyle = ink; g.lineWidth = c.lw(d * 0.012); g.stroke(); }
      g.fillStyle = css(darken(th, 0.45)); g.beginPath(); g.arc(q.x, q.y, hr * 0.2, 0, TAU); g.fill();
    }
  },
};

const LOOKS = { halfling: HALFLING, dwarf: DWARF, elf: ELF, orc: ORC, lizardfolk: LIZARD };

// ---------------------------------------------------------------------------
// Quarters of a second people

/** A second people this large builds a quarter of its own. */
export const QUARTER_MIN = 0.25;
/** Each race's ground between its houses (as its look paints the town's ground). */
const QUARTER_GROUND = { halfling: [146, 176, 100], dwarf: [152, 146, 136], elf: [104, 138, 84], orc: [164, 136, 98], lizardfolk: [100, 126, 88] };
const quarterCache = new WeakMap();   // world → { key, m: Map(sid → { race, share } | null) }

/**
 * The second people of a living Mythic town that builds its own quarter: the largest people
 * other than the dominant one (s.race) with a share ≥ QUARTER_MIN, its share rounded to
 * tenths (what a plan is keyed by), or null. Pure; cached per world by month and version.
 */
export function quarterOf(world, s) {
  if (!world || !s || !s.alive || !(world.params && world.params.mythLevel >= 2)) return null;
  const key = `${Math.floor(world.time.day / 30)}|${world.versions?.settlements ?? 0}|${world.versions?.peoples ?? 0}`;
  let e = quarterCache.get(world);
  if (!e || e.key !== key) { e = { key, m: new Map() }; quarterCache.set(world, e); }
  if (e.m.has(s.id)) return e.m.get(s.id);
  let mix = null;
  const f = peoplesMod && typeof peoplesMod.townPeoples === 'function' ? peoplesMod.townPeoples : null;
  if (f) { try { mix = f(world, s); } catch (err) { mix = null; } }
  if ((!mix || !mix.length) && s.peoples && typeof s.peoples === 'object') mix = Object.entries(s.peoples).map(([race, share]) => ({ race, share })).sort((a, b) => b.share - a.share);
  let out = null;
  const dom = s.race || (mix && mix[0] ? mix[0].race : null);
  if (Array.isArray(mix)) for (const it of mix) {
    if (!it || it.race === dom || !(it.share >= QUARTER_MIN)) continue;
    if (it.race !== 'human' && !LOOKS[it.race]) continue;
    out = { race: it.race, share: Math.round(it.share * 10) / 10 };
    break;
  }
  e.m.set(s.id, out);
  return out;
}

/** The quarter's own ground under its blocks: its people's lawns, stone or trodden earth. */
function quarterGround(g, c, rgb) {
  g.fillStyle = css(rgb); g.strokeStyle = css(rgb); g.lineJoin = 'round'; g.lineCap = 'round';
  g.beginPath(); for (const b of c.plan.blocks) c.api.polyPath(g, b.pts);
  g.lineWidth = c.wS * 1.8; g.fill(); g.stroke();
}

/**
 * Paint a plan's quarter (plan.quarter = { race, blocks, style? }) in its people's own way, over
 * the host town's ground and before its landmarks. Humans' quarters are the ordinary town's
 * roofs and lots (api.paintHumanBlocks) in a human style of the founders' homeland.
 */
export function paintQuarter(g, plan, P, detail, api) {
  const q = plan.quarter;
  if (!q || !q.blocks || !q.blocks.length) return;
  const qp = { ...plan, blocks: q.blocks, race: q.race };
  const c = ctxOf(qp, P, detail, api);
  g.lineJoin = 'round'; g.lineCap = 'round';
  if (q.race === 'human') {
    const st = q.style || plan.style;
    const groundC = (api.MATERIAL && api.MATERIAL[st.wall]?.ground) || [176, 160, 132];
    quarterGround(g, c, groundC);
    if (api.paintHumanBlocks) api.paintHumanBlocks(g, { ...qp, style: st, race: null }, P, detail, q.blocks, groundC);
    return;
  }
  const look = LOOKS[q.race];
  if (!look) return;
  quarterGround(g, c, QUARTER_GROUND[q.race] || [150, 140, 120]);
  look.blocks(g, c);
}

/**
 * Paint a race town's plan at P px per tile (g's transform: plan-local tiles → canvas px).
 * detail: 0 province (masses), 1 town (blocks), 2 street (buildings). api: cityplan.js's
 * shared painters. opts.river: the river colour of the map style.
 */
export function paintRaceTown(g, plan, P, detail, api, opts = {}) {
  const look = LOOKS[plan.race];
  if (!look) return;
  // a second people's quarter is theirs to build: the host's look paints the other blocks
  const host = plan.quarter && plan.quarter.blocks.length ? { ...plan, blocks: plan.blocks.filter((b) => !b.q) } : plan;
  const c = ctxOf(host, P, detail, api);
  g.lineJoin = 'round'; g.lineCap = 'round';
  look.ground(g, c);
  api.paintTownRivers(g, plan, P, detail, opts.river, look.bank, look.bridge);
  look.blocks(g, c);
  if (host !== plan) paintQuarter(g, plan, P, detail, api);
  look.core(g, c);
  for (const lm of plan.landmarks) {
    g.save(); g.translate(lm.x, lm.y); g.rotate(lm.rot || 0);
    const done = look.landmark(g, c, lm);
    g.restore();
    if (!done) api.paintLandmark(g, plan, lm, P, detail);
  }
  if (plan.walls) look.walls(g, c);
  g.lineCap = 'round'; g.lineJoin = 'round';
  for (const e of plan.extras) api.paintExtra(g, plan, e, P, detail);
  if (plan.siege) api.paintSiege(g, plan, P, detail);
  api.applyLandMask(g, plan);
  if (plan.piers.length) api.paintHarbour(g, plan, P, detail);
  if (look.overWater) look.overWater(g, c);
}
