// Selection overlays — owner WP6. The footprint of the selected record, drawn over the live
// map: a war's battlefields (crossed swords sized by the dead, in the victor's colour), the
// towns it took (rings in the taker's colour) and razed (a cross); an army's march; a storm's
// track, live or archived; a plague's front (the towns sick now, or its pits once it passed);
// a faith's reach (every town it holds, its holy city starred); a trade road's way; a
// catalogued catastrophe's place. The UI tells this module what is selected through
// setOverlayTarget (built-in kinds reach the renderer only as a tile highlight); the viewer
// can switch it off with the map dock's 'Record footprints' overlay (r.overlays.footprints).
//
// Two layers through ./layers.js: 'wp6-trails' (overTerritory, world transform: lines) and
// 'wp6-marks' (units, screen space: symbols). The footprint is computed once per selection and
// refreshed at most every 30 sim days; each frame only transforms and culls. Never imports
// ./renderer.js.

import { registerLayer } from './layers.js';

let target = null;       // { kind, id } of the selected record
let cache = null;        // { key, trails, marks }

/** The record whose footprint to draw ({ kind, id } or null). Called by the UI on every selection. */
export function setOverlayTarget(sel) {
  target = sel && sel.kind ? { kind: String(sel.kind), id: sel.id } : null;
  cache = null;
}
export const overlayTarget = () => target;

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const civColor = (w, id) => w.civs[id]?.colorHex || '#c9a466';
const hexA = (hex, a) => {
  const v = parseInt(String(hex || '#c9a466').replace('#', ''), 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
};

// ---------------------------------------------------------------------------
// Footprints (pure reads of the world)

function warPrint(w, war) {
  const marks = [], trails = [];
  const L = war.ledger;
  const seen = [];
  const addBattle = (x, y, dead, winner, n = 1) => {
    for (const q of seen) if (Math.abs(q.x - x) <= 1.2 && Math.abs(q.y - y) <= 1.2) { q.dead += dead; q.n += n; q.r = 5 + 2.4 * Math.log10(1 + q.dead); return; }
    const m = { t: 'battle', x, y, dead, n, color: civColor(w, winner), r: 5 + 2.4 * Math.log10(1 + dead) };
    seen.push(m); marks.push(m);
  };
  if (L && Array.isArray(L.b) && L.b.length) {
    for (const b of L.b) {
      if (!Array.isArray(b)) continue;
      if (b.length >= 6) addBattle(fin(b[1]), fin(b[2]), fin(b[5]), b[3]);
    }
  } else {
    for (const s of w.sites) if ((s.kind === 'battle' || s.kind === 'siege') && s.ref && s.ref.k === 'war' && s.ref.id === war.id) {
      const wins = s.data?.w || {};
      let best = s.civIds?.[0], bn = -1;
      for (const [id, n] of Object.entries(wins)) if (n > bn) { bn = n; best = Number(id); }
      addBattle(s.x, s.y, fin(s.dead), best, s.n || 1);
    }
    for (const e of war.geo?.log || []) if (e && fin(e.dead) >= 20) addBattle(fin(e.x), fin(e.y), fin(e.dead), e.winner);
  }
  // towns taken and razed
  const taken = new Map();
  if (L && Array.isArray(L.t)) {
    for (const t of L.t) {
      if (!Array.isArray(t)) continue;
      const [, sid, , to, code] = t;
      taken.set(sid, { to, code });
    }
  }
  for (const sid of war.captured || []) if (!taken.has(sid)) taken.set(sid, { to: w.settlements[sid]?.civId, code: 'cap' });
  for (const [sid, tk] of taken) {
    const s = w.settlements[sid];
    if (!s) continue;
    const razed = tk.code === 'razed' || tk.code === 'x' || (!s.alive && s.destroyCause === 'razed');
    marks.push({ t: razed ? 'razed' : tk.code === 'returned' ? 'returned' : 'capture', x: s.x, y: s.y, color: civColor(w, tk.to ?? s.civId) });
  }
  // the armies still in the field, with their marches
  for (const a of w.armies) if (a.warId === war.id) {
    const tr = trackOf(w, a.id);
    if (tr.length > 1) trails.push({ pts: tr, color: civColor(w, a.civId), dash: true, width: 1.6, alpha: 0.75 });
  }
  return { marks, trails };
}

function trackOf(w, armyId) {
  const ser = w.history?.series?.a?.[armyId];
  if (!ser || !Array.isArray(ser.v)) return [];
  const C = 5, pts = [];
  for (let k = 0; k + C <= ser.v.length; k += C) pts.push([ser.v[k + 3] / 10, ser.v[k + 4] / 10]);
  if (ser.pn > 0 && Array.isArray(ser.p)) pts.push([ser.p[3] / 10, ser.p[4] / 10]);
  return pts;
}

function armyPrint(w, id) {
  const a = w.armies.find((q) => String(q.id) === String(id));
  const pts = trackOf(w, id);
  if (a) pts.push([a.x, a.y]);
  const color = civColor(w, a ? a.civId : null);
  const marks = pts.length ? [{ t: 'start', x: pts[0][0], y: pts[0][1], color }] : [];
  return { trails: pts.length > 1 ? [{ pts, color, width: 2.2, alpha: 0.9, dash: false }] : [], marks };
}

function stormPrint(w, id) {
  const st = w.storms.find((q) => String(q.id) === String(id));
  let pts = st && Array.isArray(st.track) ? st.track.map((p) => [p[0], p[1], p[2] ?? st.intensity]) : null;
  if (!pts || !pts.length) {
    const list = w.history?.events || [];
    for (let k = list.length - 1; k >= 0; k--) if (list[k].t === 'storm' && String(list[k].sid) === String(id)) { pts = list[k].tr || null; break; }
  }
  if (!pts || !pts.length) return { trails: [], marks: [] };
  if (st) pts = pts.concat([[st.x, st.y, st.intensity]]);
  return { trails: [{ pts, color: '#6fb6cf', width: 2.4, alpha: 0.85, storm: true }], marks: [{ t: 'eye', x: pts[pts.length - 1][0], y: pts[pts.length - 1][1], color: '#6fb6cf' }] };
}

function plaguePrint(w, p) {
  const marks = [];
  const color = p.color || '#8db04a';
  if (p.active) {
    for (const s of w.settlements) if (s && s.alive && s.disease && s.disease.pid === p.id) {
      const I = fin(s.disease.I);
      const frac = I <= 1 ? I : s.population > 0 ? I / s.population : 0;
      marks.push({ t: 'sick', x: s.x, y: s.y, color, r: 6 + 14 * Math.min(1, Math.sqrt(frac * 4)) });
    }
  }
  for (const s of w.sites) if (s.kind === 'plaguepit' && s.ref && s.ref.k === 'plague' && s.ref.id === p.id) marks.push({ t: 'pit', x: s.x, y: s.y, color });
  const o = w.settlements[p.originSid];
  if (o) marks.push({ t: 'origin', x: o.x, y: o.y, color });
  return { trails: [], marks };
}

function faithPrint(w, r) {
  const marks = [];
  const color = r.colorHex || '#b884d8';
  for (const s of w.settlements) if (s && s.alive && s.dominantReligion === r.id) marks.push({ t: 'faith', x: s.x, y: s.y, color, r: 3 + Math.min(5, Math.log10(1 + fin(s.population)) * 1.1) });
  const holy = w.settlements[r.holyCityId];
  if (holy) marks.push({ t: 'holy', x: holy.x, y: holy.y, color });
  return { trails: [], marks };
}

function routePrint(w, rt) {
  const W = w.W;
  const pts = Array.isArray(rt.path) && rt.path.length > 1 ? rt.path.map((i) => [i % W, (i / W) | 0]) : [];
  const a = w.settlements[rt.aId], b = w.settlements[rt.bId];
  if (!pts.length && a && b) pts.push([a.x, a.y], [b.x, b.y]);
  const marks = [];
  if (a) marks.push({ t: 'end', x: a.x, y: a.y, color: '#d99a3e' });
  if (b) marks.push({ t: 'end', x: b.x, y: b.y, color: '#d99a3e' });
  return { trails: pts.length > 1 ? [{ pts, color: '#d99a3e', width: 2.4, alpha: rt.active ? 0.95 : 0.5, dash: !rt.active }] : [], marks };
}

function eventPrint(w, id) {
  const e = (w.history?.events || []).find((q) => String(q.id) === String(id));
  if (!e) return { trails: [], marks: [] };
  const marks = [{ t: 'event', x: e.x, y: e.y, color: '#e2703a', r: 8 + 3 * Math.log10(1 + fin(e.dead)) }];
  for (const sid of e.towns || []) { const s = w.settlements[sid]; if (s) marks.push({ t: 'struck', x: s.x, y: s.y, color: '#e2703a' }); }
  const trails = Array.isArray(e.tr) && e.tr.length > 1 ? [{ pts: e.tr, color: '#6fb6cf', width: 2.4, alpha: 0.85, storm: true }] : [];
  return { trails, marks };
}

function footprint(w, t) {
  switch (t.kind) {
    case 'war': { const war = w.wars[t.id]; return war ? warPrint(w, war) : null; }
    case 'army': return armyPrint(w, t.id);
    case 'storm': return stormPrint(w, t.id);
    case 'plague': { const p = w.plagues[t.id]; return p ? plaguePrint(w, p) : null; }
    case 'religion': { const r = w.religions[t.id]; return r ? faithPrint(w, r) : null; }
    case 'route': { const rt = w.tradeRoutes[t.id]; return rt ? routePrint(w, rt) : null; }
    case 'event': return eventPrint(w, t.id);
    default: return null;
  }
}

function current(r) {
  const w = r.world;
  if (!w || !target || r.overlays?.footprints === false) return null;
  const live = target.kind === 'army' || target.kind === 'storm';
  const key = `${target.kind}:${target.id}:${live ? Math.floor(w.time.day / 3) : Math.floor(w.time.day / 30)}:${w.versions?.sites}:${w.versions?.settlements}`;
  if (!cache || cache.key !== key || cache.world !== w) {
    let fp = null;
    try { fp = footprint(w, target); } catch (e) { fp = null; }
    cache = { key, world: w, trails: fp?.trails || [], marks: (fp?.marks || []).slice(0, 600) };
  }
  return cache;
}

// ---------------------------------------------------------------------------
// Drawing

registerLayer({
  id: 'wp6-trails', slot: 'overTerritory', order: 60,
  draw(r, ctx, env) {
    const c = current(r);
    if (!c || !c.trails.length) return;
    const z = env.z;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const tr of c.trails) {
      const pts = tr.pts;
      // halo then ink, widths in screen px (the transform is in tiles)
      for (const pass of [0, 1]) {
        ctx.beginPath();
        for (let k = 0; k < pts.length; k++) { const [x, y] = pts[k]; if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
        ctx.setLineDash(tr.dash && pass ? [6 / z, 5 / z] : []);
        ctx.lineWidth = (pass ? tr.width : tr.width + 3) / z;
        ctx.strokeStyle = pass ? hexA(tr.color, tr.alpha ?? 0.9) : 'rgba(10,14,20,0.45)';
        ctx.stroke();
      }
      ctx.setLineDash([]);
      if (tr.storm) {
        // intensity beads along a storm's path
        for (const p of pts) {
          const i = fin(p[2], 0.5);
          ctx.beginPath(); ctx.arc(p[0], p[1], (2 + 4 * i) / z, 0, Math.PI * 2);
          ctx.fillStyle = hexA(i > 0.75 ? '#e0664d' : i > 0.45 ? '#e4ab4b' : '#6fb6cf', 0.85); ctx.fill();
        }
      }
    }
  },
});

function swords(ctx, x, y, s, color) {
  ctx.lineCap = 'round';
  for (const pass of [0, 1]) {
    ctx.strokeStyle = pass ? color : 'rgba(12,14,18,0.8)';
    ctx.lineWidth = pass ? 1.8 : 3.6;
    ctx.beginPath();
    ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s);
    ctx.moveTo(x + s, y - s); ctx.lineTo(x - s, y + s);
    // cross-guards
    const g = s * 0.45;
    ctx.moveTo(x - s * 0.45 - g * 0.5, y + s * 0.45 - g * 0.5); ctx.lineTo(x - s * 0.45 + g * 0.5, y + s * 0.45 + g * 0.5);
    ctx.moveTo(x + s * 0.45 + g * 0.5, y + s * 0.45 - g * 0.5); ctx.lineTo(x + s * 0.45 - g * 0.5, y + s * 0.45 + g * 0.5);
    ctx.stroke();
  }
}

registerLayer({
  id: 'wp6-marks', slot: 'units', order: 60,
  draw(r, ctx, env) {
    const c = current(r);
    if (!c || !c.marks.length) return;
    const vw = r.viewW || 2000, vh = r.viewH || 2000;
    const pulse = 0.5 + 0.5 * Math.sin((env.now || 0) / 420);
    const zk = Math.max(0.7, Math.min(1.6, Math.sqrt(env.z / 6)));
    for (const m of c.marks) {
      const { sx, sy } = r.e2s(m.x, m.y);
      if (sx < -40 || sy < -40 || sx > vw + 40 || sy > vh + 40) continue;
      switch (m.t) {
        case 'battle': swords(ctx, sx, sy, (m.r || 6) * 0.8 * zk, m.color); break;
        case 'capture': case 'returned':
          ctx.beginPath(); ctx.arc(sx, sy, 11 * zk, 0, Math.PI * 2);
          ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(12,14,18,0.55)'; ctx.stroke();
          ctx.setLineDash(m.t === 'returned' ? [3, 3] : []);
          ctx.lineWidth = 2.2; ctx.strokeStyle = m.color; ctx.stroke(); ctx.setLineDash([]);
          break;
        case 'razed': {
          const s = 8 * zk;
          ctx.lineCap = 'round';
          for (const pass of [0, 1]) {
            ctx.lineWidth = pass ? 2.6 : 5; ctx.strokeStyle = pass ? '#e0664d' : 'rgba(12,14,18,0.7)';
            ctx.beginPath(); ctx.moveTo(sx - s, sy - s); ctx.lineTo(sx + s, sy + s); ctx.moveTo(sx + s, sy - s); ctx.lineTo(sx - s, sy + s); ctx.stroke();
          }
          break;
        }
        case 'sick': case 'event':
          ctx.beginPath(); ctx.arc(sx, sy, (m.r || 8) * (0.85 + 0.25 * pulse) * zk, 0, Math.PI * 2);
          ctx.fillStyle = hexA(m.color, 0.16 + 0.12 * pulse); ctx.fill();
          ctx.lineWidth = 1.6; ctx.strokeStyle = hexA(m.color, 0.9); ctx.stroke();
          break;
        case 'pit': case 'struck': case 'end': case 'start':
          ctx.beginPath(); ctx.arc(sx, sy, 5 * zk, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(12,14,18,0.6)'; ctx.fill();
          ctx.lineWidth = 2; ctx.strokeStyle = m.color; ctx.stroke();
          break;
        case 'origin': case 'holy': case 'eye': {
          const s = 7 * zk;
          ctx.beginPath();
          for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + (k * Math.PI) / 5, rr = k % 2 ? s * 0.45 : s; ctx.lineTo(sx + Math.cos(a) * rr, sy + Math.sin(a) * rr); }
          ctx.closePath();
          ctx.fillStyle = m.color; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(12,14,18,0.8)'; ctx.stroke();
          break;
        }
        case 'faith':
          ctx.beginPath(); ctx.arc(sx, sy, (m.r || 4) * zk, 0, Math.PI * 2);
          ctx.fillStyle = hexA(m.color, 0.3); ctx.fill(); ctx.lineWidth = 1.4; ctx.strokeStyle = hexA(m.color, 0.95); ctx.stroke();
          break;
        default: break;
      }
    }
  },
});
