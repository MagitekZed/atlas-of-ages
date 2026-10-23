// Things on the map: settlements (icons in their founders' architecture, giving way to their
// ground plans up close, with epithets), armies and fleets, caravans and merchant ships, trade
// routes, storms, wildfires, volcanoes and resource deposits. Drawn in screen space at
// camera-scaled sizes; records hit boxes for picking.

import { WATER, RESOURCES, TIERS } from '../core/constants.js';
import { liveSettlements } from '../core/entities.js';
import { smoothstep, clamp } from '../core/util.js';
import { styleOf, footprints } from './cityplan.js';
import { settlementSprite, volcanoSprite, blobSprite, puffSprite } from './glyphs.js';
import { css, civRgb, plagueRgb, darken, INK } from './palette.js';
import { PK } from './fx.js';

const TIER_R = [2.2, 2.7, 3.3, 4.1, 5.0, 6.1, 7.2];
export const tierRadius = (tier, zoom) => (TIER_R[Math.max(0, Math.min(6, tier | 0))] || 3) * Math.max(0.85, Math.min(4.6, Math.pow(Math.max(0.1, zoom) / 6, 0.85)));

/** Settlement list with icon data, sorted by y (cached per settlements/civs version). */
export function settlementList(r) {
  const w = r.world;
  if (r.snapshot) return r.snapshot.towns;
  const key = `${w.versions.settlements}|${w.versions.civs}|${w.versions.owner}`;
  if (r._settleKey === key && r._settleList) return r._settleList;
  const out = [];
  for (const s of liveSettlements(w)) {
    const civ = w.civs[s.civId];
    out.push({ id: s.id, s, x: s.x, y: s.y, tier: s.tier | 0, civId: s.civId, name: s.name, capital: civ && civ.capitalId === s.id, pop: s.population || 0 });
  }
  out.sort((a, b) => a.y - b.y || a.x - b.x);
  r._settleKey = key; r._settleList = out;
  return out;
}

export function drawSettlements(r, ctx, prof, labels) {
  const w = r.world, z = r.camera.zoom, dpr = r.dpr;
  const list = settlementList(r);
  const vw = r.viewW, vh = r.viewH;
  const alpha = prof.settle ?? 1;
  const minTier = z < 2.5 ? 4 : z < 3.6 ? 2 : 0;
  const now = r.now;
  const diseaseMode = r.mapMode === 'disease';
  const night = r.profile.night;
  ctx.globalAlpha = alpha;
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'medium';
  for (const e of list) {
    if (e.tier < minTier && !e.capital) continue;
    const { sx, sy } = r.e2s(e.x, e.y);
    const rad = tierRadius(e.tier, z) * (e.capital ? 1.12 : 1);
    if (sx < -rad * 3 || sy < -rad * 3 || sx > vw + rad * 3 || sy > vh + rad * 3) continue;
    const rgb = civRgb(w, e.civId);
    const civ = w.civs[e.civId];
    const era = civ?.tech?.era || 0;
    const s = e.s;
    const style = s && !r.snapshot ? styleOf(r, s.originCivId ?? s.civId, s.race) : null;
    const race = s ? s.race || style?.race || null : null;
    // the town's ground plan takes over from its icon as it grows on screen
    const planA = r._planAlpha ? (r._planAlpha.get(e.id) || 0) : 0;
    const iconA = planA > 0 ? 1 - smoothstep(0.35, 1, planA) * 0.92 : 1;
    if (s && s.siege && planA < 0.6) {
      const pulse = 0.5 + 0.5 * Math.sin(now * 0.008 + e.id);
      ctx.globalAlpha = alpha * (0.5 + 0.4 * pulse);
      ctx.strokeStyle = 'rgb(206,62,46)'; ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(sx, sy, rad * 1.7 + 4 + pulse * 2, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = alpha;
    }
    if (s && s.disease && (diseaseMode || z >= 10)) {
      const pr = plagueRgb(w, s.disease.pid);
      const pulse = 0.5 + 0.5 * Math.sin(now * 0.005 + e.id * 1.7);
      const pr2 = planA > 0.5 ? Math.max(rad * 1.5 + 3, (footprints(r).byId.get(e.id)?.r || 0) * z * 1.05) : rad * 1.5 + 3;
      ctx.globalAlpha = alpha * (diseaseMode ? 0.75 : 0.4) * (0.6 + 0.4 * pulse) * (planA > 0.5 ? 0.6 : 1);
      ctx.fillStyle = css(pr, planA > 0.5 ? 0.12 : 0.35); ctx.strokeStyle = css(pr);
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(sx, sy, pr2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.globalAlpha = alpha;
    }
    if (iconA > 0.02) {
      // symbol and picture cross-fade over a band of sizes instead of switching at one
      const opts = { capital: e.capital, era, style, race };
      const pic = smoothstep(5.6, 7.4, rad);
      if (pic > 0.02 && pic < 0.98) {
        blitIcon(ctx, settlementSprite(r.sprites, e.tier, rgb, rad, dpr, { ...opts, force: 'sym' }), sx, sy, rad, alpha * iconA * (1 - pic));
        blitIcon(ctx, settlementSprite(r.sprites, e.tier, rgb, rad, dpr, { ...opts, force: 'pic' }), sx, sy, rad, alpha * iconA * pic);
      } else blitIcon(ctx, settlementSprite(r.sprites, e.tier, rgb, rad, dpr, { ...opts, force: pic >= 0.98 ? 'pic' : 'sym' }), sx, sy, rad, alpha * iconA);
    }
    ctx.globalAlpha = alpha;
    const hx0 = sx - rad * 1.1, hy0 = sy - rad * (rad >= 6.5 ? 1.9 : 1.1), hx1 = sx + rad * 1.1, hy1 = sy + rad * 1.1;
    r.hits.push({ kind: 'settlement', id: e.id, x0: hx0 - 2, y0: hy0 - 2, x1: hx1 + 2, y1: hy1 + 2, pri: 2 + e.tier * 0.1 });
    if (iconA > 0.3) labels.blocks.push([hx0, hy0, hx1, hy1]);
    // label candidate: beside the icon, or over the town's square once its plan has taken over
    if (r.overlays.labels) {
      const show = e.capital ? z >= 2.2 : e.tier >= 5 ? z >= 2.6 : e.tier >= 4 ? z >= 4.2 : e.tier >= 3 ? z >= 7 : e.tier >= 2 ? z >= 11 : z >= 18;
      if (show) {
        const fp = planA > 0.5 ? footprints(r).byId.get(e.id) : null;
        const planPx = planA > 0.5 && fp ? fp.r * z : 0;
        const big = planPx > 34;
        const fs = (([9, 9.5, 10, 11, 12.5, 14, 15.5][e.tier] || 10) * Math.max(0.95, Math.min(1.35, 0.85 + z / 50)) + (e.capital ? 1 : 0)) * (big ? clamp(planPx / 60, 1.1, 1.6) : 1);
        const st = {
          size: fs, sc: e.capital || big, bold: e.tier >= 5,
          color: night ? 'rgb(246,232,200)' : e.capital ? 'rgb(36,26,18)' : 'rgb(48,38,28)',
          halo: night ? 'rgba(14,18,28,0.8)' : 'rgba(246,238,216,0.86)', haloW: Math.max(2, fs * 0.2),
          spacing: e.capital || big ? fs * 0.08 : 0,
        };
        // once the plan is big its name stands just outside the walls (kept on screen), not on its streets
        const lx = big ? (fp ? r.e2s(fp.x, fp.y).sx : sx) : sx, ly = big ? Math.max(fs * 0.9 + 4, (fp ? r.e2s(fp.x, fp.y).sy : sy) - planPx - fs * 1.45) : sy;
        if (big) labels.push({ pri: 90 + e.tier * 2 + Math.log10(1 + e.pop), text: e.name, x: lx, y: ly, alt: fs * 1.3, st, overPlan: true });
        else labels.push({ pri: (e.capital ? 60 : 30) + e.tier * 6 + Math.log10(1 + e.pop), text: e.name, x: sx, y: sy, rad: Math.max(rad, planPx * 0.85), st, anchor: 'icon', overPlan: true });
        // the town's character: its epithet, then (closer) its callings
        if (s && z >= 8 && e.tier >= 2) {
          let sub = s.epithet ? String(s.epithet) : '';
          if (!sub && z >= 16 && Array.isArray(s.traits) && s.traits.length) sub = s.traits.slice(0, 3).map(traitLabel).filter(Boolean).join(' · ');
          if (sub) {
            const fs2 = Math.max(8.5, fs * 0.72);
            const yy = big ? ly + fs * 0.95 : sy + Math.max(rad, planPx * 0.85) + fs2 * 1.1 + 4;
            labels.push({ pri: (big ? 80 : (e.capital ? 52 : 22) + e.tier * 5), text: sub, x: lx, y: yy, overPlan: true, st: { size: fs2, italic: true, color: night ? 'rgba(236,222,190,0.92)' : 'rgba(78,60,44,0.92)', halo: st.halo, haloW: Math.max(1.8, fs2 * 0.2) } });
          }
        }
      }
    }
  }
  ctx.globalAlpha = 1;
}

/** Draw a quantised icon sprite at radius rad (its natural radius is sp.s). */
function blitIcon(ctx, sp, sx, sy, rad, a) {
  if (a <= 0.01) return;
  const k = sp.s ? rad / sp.s : 1;
  ctx.globalAlpha = a;
  ctx.drawImage(sp.canvas, sx - sp.ox * k, sy - sp.oy * k, sp.w * k, sp.h * k);
}

/** A trait key as a few words of lettering ("river_port" → "river port"). */
const traitLabel = (t) => (typeof t === 'string' ? t.replace(/[_-]+/g, ' ').trim() : t && t.label ? String(t.label) : '');

/**
 * Softly reserve capitals and great cities (icon + the likely spot of their name) so the
 * large region names lettered beneath them steer clear when they can.
 */
export function reserveCapitals(r, L, z) {
  const list = settlementList(r);
  const vw = r.viewW, vh = r.viewH;
  for (const e of list) {
    if (!e.capital && e.tier < 5) continue;
    if (e.capital ? z < 2.2 : z < 2.6) continue;
    const { sx, sy } = r.e2s(e.x, e.y);
    if (sx < -60 || sy < -30 || sx > vw + 60 || sy > vh + 30) continue;
    const rad = tierRadius(e.tier, z) * (e.capital ? 1.12 : 1);
    const fs = ([9, 9.5, 10, 11, 12.5, 14, 15.5][e.tier] || 10) * Math.max(0.95, Math.min(1.35, 0.85 + z / 50)) + 1;
    const tw = String(e.name || '').length * fs * 0.62 + 8;
    L.reserve(sx - rad * 1.2, sy - rad * 1.6, sx + rad * 1.2 + 3 + tw, sy + rad * 1.2);
  }
}

// ---------------------------------------------------------------------------
// Trade routes

function routePath(r, route) {
  const key = route.id;
  const path = route.path;
  if (!Array.isArray(path) || path.length < 2) return null;
  const c = r._routeCache.get(key);
  const sig = path.length * 31 + path[0] * 7 + path[path.length - 1];
  if (c && c.sig === sig) return c.p;
  const W = r.world.W, N = r.world.N;
  const pts = [];
  for (const i of path) { if (Number.isInteger(i) && i >= 0 && i < N) pts.push(i % W, (i / W) | 0); }
  const n = pts.length / 2;
  if (n < 2) return null;
  const p = new Path2D();
  p.moveTo(pts[0], pts[1]);
  if (n === 2) p.lineTo(pts[2], pts[3]);
  else {
    p.lineTo((pts[0] + pts[2]) / 2, (pts[1] + pts[3]) / 2);
    for (let k = 1; k < n - 1; k++) p.quadraticCurveTo(pts[k * 2], pts[k * 2 + 1], (pts[k * 2] + pts[k * 2 + 2]) / 2, (pts[k * 2 + 1] + pts[k * 2 + 3]) / 2);
    p.lineTo(pts[(n - 1) * 2], pts[(n - 1) * 2 + 1]);
  }
  r._routeCache.set(key, { sig, p });
  if (r._routeCache.size > 3000) r._routeCache.delete(r._routeCache.keys().next().value);
  return p;
}

/** Trade routes, drawn in world transform. k = emphasis (0 hides). */
export function drawRoutes(r, ctx, k) {
  const w = r.world, z = r.camera.zoom;
  if (k <= 0 || !w.tradeRoutes || !w.tradeRoutes.length) return;
  if (z < 2.5 && k < 1) return;
  // the abstract lanes give way to the roads and towns themselves as we descend (the trade
  // map keeps them)
  if (k < 1) { const fade = 1 - smoothstep(26, 56, z); if (fade <= 0.02) return; k *= fade; }
  // the routes in use, gathered at most twice a second (a late world keeps thousands of dead
  // ones in w.tradeRoutes; walking them all three times a frame cost more than drawing)
  let ar = r._activeRoutes;
  if (!ar || ar.world !== w || ar.len !== w.tradeRoutes.length || r.now - ar.at > 500 || r.now < ar.at) {
    const list = [];
    let mv = 1;
    for (const rt of w.tradeRoutes) if (rt && rt.active) { list.push(rt); if (rt.value > mv) mv = rt.value; }
    ar = r._activeRoutes = { world: w, len: w.tradeRoutes.length, at: r.now, list, maxV: mv };
  }
  const maxV = ar.maxV;
  const t = r.now * 0.001;
  for (let pass = 0; pass < 2; pass++) {
    for (const rt of ar.list) {
      if (!rt || !rt.active) continue;
      const p = routePath(r, rt);
      if (!p) continue;
      const v = Math.sqrt(Math.max(0, rt.value || 0) / maxV);
      const sea = rt.kind === 'sea';
      const px = (0.8 + v * 2.2) * Math.min(1.6, k);
      if (pass === 0) {
        if (k < 1) continue;
        ctx.strokeStyle = sea ? 'rgba(220,236,244,0.45)' : 'rgba(250,236,200,0.45)';
        ctx.lineWidth = (px + 2.2) / z;
        ctx.setLineDash([]);
        ctx.stroke(p);
        continue;
      }
      ctx.strokeStyle = sea ? `rgba(60,112,164,${Math.min(1, 0.32 * k + 0.1)})` : `rgba(206,140,52,${Math.min(1, 0.36 * k + 0.1)})`;
      ctx.lineWidth = px / z;
      ctx.setLineDash(sea ? [1.5 / z, 4 / z] : [5 / z, 3.5 / z]);
      ctx.lineDashOffset = (-t * (sea ? 6 : 4)) / z;
      ctx.stroke(p);
    }
  }
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
}

// ---------------------------------------------------------------------------
// Caravans & ships live in ./traffic.js (kept here as drawCaravans for existing importers)

export { drawTraffic as drawCaravans } from './traffic.js';

// ---------------------------------------------------------------------------
// Locust swarms (world.sys.disasters.swarms: map coordinates, tile centre at +0.5)

/** Each swarm as a shimmering speckle cloud drifting on the wind; hits kind 'swarm'. */
export function drawSwarms(r, ctx) {
  const w = r.world, z = r.camera.zoom;
  const list = w.sys?.disasters?.swarms;
  if (!Array.isArray(list) || !list.length || r.snapshot) return;
  const t = r.now * 0.001;
  for (const sw of list) {
    if (!sw || !Number.isFinite(sw.x) || !Number.isFinite(sw.y)) continue;
    const size = Math.max(0.05, Math.min(1, sw.size || 0.4));
    const R = Math.max(10, (1.5 + 3 * size) * z * 0.85);
    const { sx, sy } = r.e2s(sw.x - 0.5, sw.y - 0.5);
    if (sx < -R || sy < -R || sx > r.viewW + R || sy > r.viewH + R) continue;
    // a brown haze beneath the cloud
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, R);
    g.addColorStop(0, `rgba(96,84,40,${0.32 * size + 0.1})`); g.addColorStop(1, 'rgba(96,84,40,0)');
    ctx.globalAlpha = 1; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(sx, sy, R, 0, Math.PI * 2); ctx.fill();
    // the speckle: each insect circles its own small orbit, the whole drifting with the swarm
    const n = Math.round(40 + 110 * size) * (z < 6 ? 0.5 : 1);
    const vx = Number.isFinite(sw.vx) ? sw.vx : 0, vy = Number.isFinite(sw.vy) ? sw.vy : 0;
    ctx.fillStyle = 'rgb(58,52,26)';
    ctx.beginPath();
    let h = ((sw.id || 1) * 2654435761) >>> 0;
    const dot = Math.max(0.9, Math.min(2.2, z * 0.06));
    for (let k = 0; k < n; k++) {
      h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
      const a0 = ((h & 1023) / 1023) * Math.PI * 2, d = Math.sqrt(((h >>> 10) & 1023) / 1023) * R * 0.9;
      const om = 1.5 + ((h >>> 20) & 15) / 6;
      const x = sx + Math.cos(a0) * d + Math.cos(t * om + k) * 3 + vx * 4 * Math.sin(t * 0.7 + k), y = sy + Math.sin(a0) * d * 0.75 + Math.sin(t * om * 1.3 + k) * 2.5;
      ctx.moveTo(x + dot, y); ctx.arc(x, y, dot, 0, Math.PI * 2);
    }
    ctx.globalAlpha = 0.75 + 0.2 * Math.sin(t * 6 + (sw.id || 0));
    ctx.fill();
    ctx.globalAlpha = 1;
    const hr = Math.min(R, 30);
    r.hits.push({ kind: 'swarm', id: sw.id, ex: sw.x - 0.5, ey: sw.y - 0.5, x0: sx - hr, y0: sy - hr, x1: sx + hr, y1: sy + hr, pri: 1.2 });
  }
}

// ---------------------------------------------------------------------------
// Armies live in ./armies.js (re-exported here for existing importers)

export { drawArmies, fmtStrength } from './armies.js';

// ---------------------------------------------------------------------------
// Storms (world transform not used: screen space)

export function drawStorms(r, ctx, labels) {
  const w = r.world, z = r.camera.zoom;
  const list = w.storms;
  if (!list || !list.length) return;
  const t = r.now * 0.001;
  const vw = r.viewW, vh = r.viewH;
  for (const s of list) {
    if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
    const { sx, sy } = r.e2s(s.x, s.y);
    const R = Math.max(8, (Number.isFinite(s.radius) ? s.radius : 4) * z);
    if (sx < -R || sy < -R || sx > vw + R || sy > vh + R) continue;
    const I = Math.max(0.15, Math.min(1, Number.isFinite(s.intensity) ? s.intensity : 0.5));
    const life = Number.isFinite(s.age) && Number.isFinite(s.maxAge) && s.maxAge > 0 ? Math.min(1, s.age / 6, (s.maxAge - s.age) / 6) : 1;
    const A = Math.max(0.15, life);
    r.hits.push({ kind: 'storm', id: s.id, x0: sx - Math.min(R, 26), y0: sy - Math.min(R, 26), x1: sx + Math.min(R, 26), y1: sy + Math.min(R, 26), pri: 1 });
    const white = puffSprite(r.sprites, [252, 253, 255], 32, r.dpr);
    const shade = puffSprite(r.sprites, [24, 30, 44], 32, r.dpr);
    // a cloud mass: a soft shadow cast to the south-east, then the bright top
    const mass = (x, y, rr, a) => {
      ctx.globalAlpha = a * 0.32; ctx.drawImage(shade.canvas, x - rr + rr * 0.18, y - rr + rr * 0.24, rr * 2, rr * 2);
      ctx.globalAlpha = a; ctx.drawImage(white.canvas, x - rr, y - rr, rr * 2, rr * 2);
    };
    switch (s.kind) {
      case 'cyclone': {
        const dir = (s.hemisphere ?? (s.y < w.H / 2 ? 1 : -1)) >= 0 ? -1 : 1;
        const rot = t * (0.6 + I * 0.9) * dir;
        mass(sx, sy, R * 0.85, 0.82 * A * (0.65 + 0.35 * I));
        ctx.lineCap = 'round';
        for (let pass = 0; pass < 2; pass++) {
          for (let arm = 0; arm < 4; arm++) {
            ctx.beginPath();
            const base = rot + (arm * Math.PI) / 2;
            for (let k = 0; k <= 28; k++) {
              const q = k / 28;
              const rr = R * (0.12 + q * 0.95);
              const a = base - dir * q * 3.1;
              const x = sx + Math.cos(a) * rr + (pass ? 0 : R * 0.04), y = sy + Math.sin(a) * rr + (pass ? 0 : R * 0.05);
              if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            const lw = Math.max(1.4, R * 0.085 * (0.5 + I * 0.5));
            ctx.strokeStyle = pass ? `rgba(255,255,255,${0.78 * A})` : `rgba(20,28,44,${0.22 * A})`;
            ctx.lineWidth = pass ? lw : lw * 1.5;
            ctx.stroke();
          }
        }
        ctx.lineCap = 'butt';
        // the eye
        ctx.globalAlpha = A;
        ctx.fillStyle = 'rgba(36,54,76,0.6)';
        ctx.beginPath(); ctx.arc(sx, sy, Math.max(1.6, R * 0.075), 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
        if (s.name && r.overlays.labels && z >= 2.5) {
          labels.push({ pri: 40 + I * 10, text: s.name, x: sx, y: sy + R * 0.62 + 8, dyn: true, st: { size: 10.5, italic: true, color: 'rgb(30,52,76)', halo: 'rgba(240,246,250,0.85)', haloW: 2 } });
        }
        break;
      }
      case 'blizzard': {
        // a pale grey-blue squall with driving snow streaks along the wind
        const ang = Math.atan2(Number.isFinite(s.vy) ? s.vy : 0, Number.isFinite(s.vx) && (s.vx || s.vy) ? s.vx : 1);
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const grey = puffSprite(r.sprites, [150, 166, 186], 32, r.dpr);
        ctx.globalAlpha = 0.62 * A; ctx.drawImage(grey.canvas, sx - R, sy - R * 0.8, R * 2, R * 1.6);
        mass(sx - ca * R * 0.2, sy - sa * R * 0.2, R * 0.62, 0.75 * A);
        ctx.globalAlpha = 0.85 * A;
        ctx.strokeStyle = 'rgb(255,255,255)'; ctx.lineWidth = Math.max(0.9, Math.min(1.8, z * 0.06)); ctx.lineCap = 'round';
        ctx.beginPath();
        for (let k = 0; k < 18; k++) {
          const lane = ((k * 53) % 18) / 17 - 0.5;
          const run = ((t * 0.6 + k * 0.173) % 1) * 2 - 1;
          const cx = sx + ca * run * R * 0.85 - sa * lane * R * 1.1, cy = sy + sa * run * R * 0.85 + ca * lane * R * 1.1;
          const L = R * 0.12;
          ctx.moveTo(cx - ca * L, cy - sa * L + L * 0.4); ctx.lineTo(cx + ca * L, cy + sa * L - L * 0.4);
        }
        ctx.stroke();
        ctx.lineCap = 'butt';
        ctx.globalAlpha = 1;
        if (s.name && r.overlays.labels && z >= 4) labels.push({ pri: 22, text: s.name, x: sx, y: sy + R * 0.7 + 8, dyn: true, st: { size: 9.5, italic: true, color: 'rgb(40,60,80)', halo: 'rgba(240,246,250,0.85)', haloW: 2 } });
        break;
      }
      case 'thunderstorm': {
        // a towering cell: bright anvil top over a dark core, a skirt of rain, and flashes
        const core = puffSprite(r.sprites, [74, 82, 102], 32, r.dpr);
        ctx.globalAlpha = 0.6 * A; ctx.drawImage(core.canvas, sx - R * 0.9 + R * 0.15, sy - R * 0.7 + R * 0.25, R * 1.8, R * 1.5);
        for (let k = 0; k < 4; k++) {
          const a = k * 1.7 + s.id, rr = R * 0.32;
          const bx = sx + (k ? Math.cos(a) * rr : 0), by = sy + (k ? Math.sin(a) * rr * 0.6 : 0) - R * 0.12;
          mass(bx, by, R * (k ? 0.45 : 0.6), (k ? 0.7 : 0.9) * A);
        }
        // rain shafts
        ctx.globalAlpha = 0.35 * A; ctx.strokeStyle = 'rgb(70,86,110)'; ctx.lineWidth = Math.max(0.8, z * 0.04);
        ctx.beginPath();
        for (let k = 0; k < 7; k++) {
          const x = sx + (k / 6 - 0.5) * R * 0.9, y = sy + R * 0.25;
          ctx.moveTo(x, y); ctx.lineTo(x - R * 0.12, y + R * 0.45);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
        const ph = (t * (1.3 + I) + s.id * 0.37) % 1;
        if (ph < 0.07) {
          const bx = sx + Math.sin(s.id * 9 + Math.floor(t * 2)) * R * 0.35, by = sy;
          const gl = blobSprite(r.sprites, [236, 240, 255], 32, r.dpr, 0);
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = 0.6; ctx.drawImage(gl.canvas, bx - R, by - R, R * 2, R * 2);
          ctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = 1;
          ctx.strokeStyle = 'rgba(255,255,236,0.95)'; ctx.lineWidth = Math.max(1.2, Math.min(2, z * 0.07));
          ctx.beginPath(); ctx.moveTo(bx, by - R * 0.45); ctx.lineTo(bx + R * 0.1, by - R * 0.12); ctx.lineTo(bx - R * 0.06, by); ctx.lineTo(bx + R * 0.06, by + R * 0.4); ctx.stroke();
        }
        break;
      }
      case 'sandstorm': {
        // a dust plume strung out along the wind: soft ochre-brown puffs with a darker
        // leading edge and streaming streaks, readable over pale desert as well as sea
        const ang = Math.atan2(Number.isFinite(s.vy) ? s.vy : 0, Number.isFinite(s.vx) && (s.vx || s.vy) ? s.vx : 1);
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const dust = puffSprite(r.sprites, [176, 124, 70], 32, r.dpr);
        const lite = puffSprite(r.sprites, [226, 196, 150], 32, r.dpr);
        for (let k = 0; k < 8; k++) {
          const q = (k / 7 - 0.5) * 1.6;
          const wob = Math.sin(t * 0.7 + k * 1.9 + s.id) * 0.18;
          const px = sx + ca * q * R - sa * wob * R, py = sy + sa * q * R + ca * wob * R;
          const rr = R * (0.55 + 0.25 * Math.cos(k * 2.3 + s.id)) * (1 - Math.abs(q) * 0.22);
          const a = A * Math.sqrt(I) * (1 - Math.abs(q) * 0.3);
          ctx.globalAlpha = 0.85 * a; ctx.drawImage(dust.canvas, px - rr, py - rr, rr * 2, rr * 2);
          ctx.globalAlpha = 0.45 * a; ctx.drawImage(lite.canvas, px - rr * 0.6 - ca * rr * 0.2, py - rr * 0.6 - sa * rr * 0.2, rr * 1.2, rr * 1.2);
        }
        ctx.globalAlpha = 0.6 * A;
        ctx.strokeStyle = 'rgb(122,82,44)'; ctx.lineWidth = Math.max(0.9, Math.min(1.8, z * 0.06)); ctx.lineCap = 'round';
        ctx.beginPath();
        for (let k = 0; k < 10; k++) {
          const lane = ((k * 37) % 10) / 9 - 0.5;
          const run = ((t * 0.35 + k * 0.137) % 1) * 2 - 1;
          const cx = sx + ca * run * R * 0.9 - sa * lane * R * 0.8, cy = sy + sa * run * R * 0.9 + ca * lane * R * 0.8;
          const L = R * 0.22;
          ctx.moveTo(cx - ca * L, cy - sa * L);
          ctx.quadraticCurveTo(cx - sa * L * 0.25, cy + ca * L * 0.25, cx + ca * L, cy + sa * L);
        }
        ctx.stroke();
        ctx.lineCap = 'butt';
        ctx.globalAlpha = 1;
        break;
      }
      default: {
        const gr = ctx.createRadialGradient(sx, sy, 0, sx, sy, R);
        gr.addColorStop(0, `rgba(230,234,240,${0.4 * A})`); gr.addColorStop(1, 'rgba(230,234,240,0)');
        ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(sx, sy, R, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Fires & volcanoes

/** Rescan the fire field for burning tiles (throttled). */
export function scanFires(r) {
  const w = r.world, f = w.f, N = w.N;
  if (r._fireScanDay === w.time.day && r.now - r._fireScanAt < 700) return r._fireList;
  r._fireScanDay = w.time.day; r._fireScanAt = r.now;
  const out = r._fireList || [];
  out.length = 0;
  const fire = f.fire;
  for (let i = 0; i < N; i++) {
    const v = fire[i];
    if (v > 0.02) { out.push(i); if (out.length > 1500) break; }
  }
  r._fireList = out;
  return out;
}

export function drawFires(r, ctx, dt) {
  const w = r.world, f = w.f, W = w.W, z = r.camera.zoom, dpr = r.dpr;
  const list = scanFires(r);
  if (!list.length) return;
  const vb = r.viewBounds(1);
  const P = r.fx.particles;
  const now = r.now;
  ctx.globalCompositeOperation = 'lighter';
  const glowR = Math.max(2.5, z * 0.75);
  const sp = blobSprite(r.sprites, [255, 120, 36], 24, dpr, 0);
  let visible = 0;
  for (const i of list) {
    const x = i % W, y = (i / W) | 0;
    if (x < vb.x0 || x > vb.x1 || y < vb.y0 || y > vb.y1) continue;
    visible++;
    const v = Math.min(1, f.fire[i]);
    const fl = 0.65 + 0.35 * Math.sin(now * 0.017 + i * 1.3) * Math.sin(now * 0.011 + i);
    const { sx, sy } = r.e2s(x, y);
    const rr = glowR * (0.7 + v * 0.8) * fl;
    ctx.globalAlpha = Math.min(1, 0.55 + v * 0.45);
    ctx.drawImage(sp.canvas, sx - rr, sy - rr, rr * 2, rr * 2);
    if (z >= 10) {
      ctx.fillStyle = `rgba(255,236,160,${0.6 * fl})`;
      ctx.beginPath(); ctx.arc(sx, sy, Math.max(1, z * 0.08 * fl), 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  // smoke plumes from a sample of visible fires
  const want = Math.min(10, visible * 0.25) * Math.min(3, dt * 60);
  for (let k = 0; k < want; k++) {
    const i = list[(Math.random() * list.length) | 0];
    const x = i % W, y = (i / W) | 0;
    if (x < vb.x0 || x > vb.x1 || y < vb.y0 || y > vb.y1) continue;
    const wx = (f.windX[i] || 0) * 0.35, wy = (f.windY[i] || 0) * 0.35;
    P.spawn(PK.SMOKE, x + (Math.random() - 0.5) * 0.6, y + (Math.random() - 0.5) * 0.6, wx, wy - 0.25, 0.25 + Math.random() * 0.25, 3 + Math.random() * 3, 0.35, 0.5);
    if (Math.random() < 0.3) P.spawn(PK.EMBER, x, y, (Math.random() - 0.5) * 0.6, -0.5 - Math.random() * 0.5, 0.06, 0.6 + Math.random() * 0.6, 0, 1);
  }
}

export function drawVolcanoes(r, ctx, dt, labels) {
  const w = r.world, z = r.camera.zoom, dpr = r.dpr;
  const list = w.volcanoes;
  if (!list || !list.length) return;
  const vw = r.viewW, vh = r.viewH;
  const P = r.fx.particles;
  for (const v of list) {
    if (!v || !Number.isFinite(v.x) || !Number.isFinite(v.y)) continue;
    const { sx, sy } = r.e2s(v.x, v.y);
    if (sx < -60 || sy < -80 || sx > vw + 60 || sy > vh + 60) continue;
    const erupting = (v.erupting || 0) > 0;
    const active = (v.activity || 0) > 0.45;
    const state = erupting ? 2 : active ? 1 : 0;
    const s = Math.max(3.5, Math.min(16, 2.5 + z * 0.42));
    if (z >= 3.5 || erupting) {
      const sp = volcanoSprite(r.sprites, s, dpr, state);
      ctx.drawImage(sp.canvas, sx - sp.ox, sy - sp.oy + s * 0.4, sp.w, sp.h);
      r.hits.push({ kind: 'volcano', id: v.id, x0: sx - s, y0: sy - s * 0.7, x1: sx + s, y1: sy + s * 0.5, pri: 1.6 });
    }
    if (erupting) {
      const pulse = 0.7 + 0.3 * Math.sin(r.now * 0.012 + v.id);
      ctx.globalCompositeOperation = 'lighter';
      const sp = blobSprite(r.sprites, [255, 96, 24], 32, dpr, 0);
      const rr = (s * 2.2 + 6) * pulse;
      ctx.globalAlpha = 0.85;
      ctx.drawImage(sp.canvas, sx - rr, sy - s * 0.6 - rr, rr * 2, rr * 2);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      if (Math.random() < dt * 30) P.spawn(PK.ASH, v.x + (Math.random() - 0.5) * 0.3, v.y - 0.5, (w.f.windX[v.i] || 0) * 0.3 + (Math.random() - 0.5) * 0.3, -0.7 - Math.random() * 0.6, 0.35 + Math.random() * 0.4, 4 + Math.random() * 3, 0.5, 0.8);
      if (Math.random() < dt * 25) P.spawn(PK.EMBER, v.x, v.y - 0.45, (Math.random() - 0.5) * 1.5, -1.2 - Math.random() * 1.5, 0.08, 0.8 + Math.random() * 0.5, 0, 1);
    } else if (active && z >= 3) {
      if (Math.random() < dt * 4 * (v.activity || 0.5)) P.spawn(PK.SMOKE, v.x, v.y - 0.45, (w.f.windX[v.i] || 0) * 0.25, -0.3, 0.18 + Math.random() * 0.12, 3 + Math.random() * 2, 0.22, 0.45);
    }
    if (r.overlays.labels && v.name && ((z >= 9 && (active || erupting)) || (erupting && z >= 4))) {
      labels.push({ pri: erupting ? 45 : 12, text: v.name, x: sx, y: sy + s * 0.9 + 6, st: { size: 9.5, italic: true, color: erupting ? 'rgb(150,40,20)' : 'rgb(82,60,44)', halo: 'rgba(244,236,214,0.8)', haloW: 2 } });
    }
  }
}

/** Named wildfire labels from world.fires. */
export function fireLabels(r, labels) {
  const w = r.world, z = r.camera.zoom;
  if (!r.overlays.labels || z < 5 || !w.fires) return;
  for (const fe of w.fires) {
    if (!fe || !fe.active || !fe.name || !Number.isFinite(fe.x)) continue;
    const { sx, sy } = r.e2s(fe.x, fe.y);
    labels.push({ pri: 18, text: fe.name, x: sx, y: sy - 12, dyn: true, st: { size: 9.5, italic: true, color: 'rgb(150,56,24)', halo: 'rgba(250,236,210,0.8)', haloW: 2 } });
  }
}

// ---------------------------------------------------------------------------
// Resource deposits (resources mode)

export function drawResources(r, ctx) {
  const w = r.world, f = w.f, W = w.W, z = r.camera.zoom;
  if (z < 1.5) return;
  const vb = r.viewBounds(0);
  const rad = Math.max(2.3, Math.min(7, z * 0.24));
  for (let y = vb.y0; y <= vb.y1; y++) {
    for (let x = vb.x0; x <= vb.x1; x++) {
      const i = y * W + x;
      const id = f.resource[i];
      if (!id || f.water[i] !== WATER.LAND) continue;
      const res = RESOURCES[id];
      if (!res) continue;
      const amt = Math.max(0.2, Math.min(1, f.resourceAmt[i] || 0));
      const { sx, sy } = r.e2s(x, y);
      ctx.globalAlpha = 0.45 + amt * 0.55;
      // map key symbols: diamonds for luxuries, squares for strategic ores, discs for bulk
      // goods, each on a parchment halo so dark deposits (coal, oil) still read
      const shape = () => {
        ctx.beginPath();
        if (res.kind === 'luxury') { ctx.moveTo(sx, sy - rad * 1.25); ctx.lineTo(sx + rad * 1.05, sy); ctx.lineTo(sx, sy + rad * 1.25); ctx.lineTo(sx - rad * 1.05, sy); ctx.closePath(); }
        else if (res.kind === 'strategic') ctx.rect(sx - rad * 0.85, sy - rad * 0.85, rad * 1.7, rad * 1.7);
        else ctx.arc(sx, sy, rad, 0, Math.PI * 2);
      };
      shape();
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(246,238,216,0.85)'; ctx.stroke();
      ctx.fillStyle = css(res.color); ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = css(darken(res.color, 0.6)); ctx.stroke();
      if (z >= 16) {
        const sp = r.labeler.sprite(res.name, { size: 9, italic: true, color: css(INK), halo: 'rgba(244,236,214,0.8)', haloW: 2 });
        r.labeler.draw(ctx, sp, sx, sy + rad + 7);
      }
    }
  }
  ctx.globalAlpha = 1;
}

export { TIERS };
