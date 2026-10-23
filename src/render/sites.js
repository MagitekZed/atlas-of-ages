// The land remembers: historic sites (battlefields, siege lines, ruins, craters, great
// eruptions and quakes, wrecks, plague pits, treaty grounds, holy places, graves) drawn as
// map symbols sized by their dead from the zoom their kind asks for (the greatest from
// Continent zoom), lettered with their record ("the Crossing at Shybsuq — 4 battles, 10,500
// dead"); graves and cairns baked into the close-zoom chunks round the fields of the slain; the
// ruins of dead towns kept forever, their foundations reclaimed by green, "ruins of X" becoming
// "Ancient X (fl. Y120–Y480)" after three centuries. And the wonders: a gold-ringed symbol by
// their city from afar, a pictorial silhouette from Region zoom (standing on the town's plan),
// the plan's own drawing up close, rubble and "ruins of …" when fallen; the Great Wall along its
// recorded course, the Grand Canal, the Great Dam with its reservoir. Ley nodes and lairs are
// drawn by their owners' render modules (myth.js, bands.js).
//
// Reads world.sites (core/sites.js, SITE_KINDS), world.wonders (path, i), dead settlements.
// Purely cosmetic and read-only.

import { WATER, DAYS_PER_YEAR } from '../core/constants.js';
import { SITE_KINDS } from '../core/sites.js';
import { hash2i } from '../core/rng.js';
import { clamp, smoothstep } from '../core/util.js';
import { makeCanvas } from './terrain.js';
import { css, civRgb, INK } from './palette.js';
import { wonderSprite, qpx } from './glyphs.js';
import { registerPainter, mix } from './lod.js';
import { styleOf, footprints, townsIn, drawRuinPlans } from './cityplan.js';
import { tierRadius } from './entities.js';

const TAU = Math.PI * 2;
const hf = (h, s = 0, bits = 8) => ((h >>> s) & ((1 << bits) - 1)) / ((1 << bits) - 1);
const yearOfDay = (d) => Math.floor((d || 0) / DAYS_PER_YEAR);
const fmtDead = (n) => Math.round(n || 0).toLocaleString('en-US');
const capFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** Kinds drawn by other packages' render modules. */
const FOREIGN = new Set(['node', 'lair']);

// ---------------------------------------------------------------------------
// Site index and ruins

/** Sites by kind with a coarse grid, cached per sites version. */
function siteIndex(r) {
  const w = r.world;
  const key = `${w.versions.sites | 0}|${(w.sites || []).length}`;
  if (r._siteKey === key && r._siteIdx) return r._siteIdx;
  const G = 8, gw = Math.ceil(w.W / G);
  const grid = new Map();
  const ruinsBySid = new Map();
  for (const s of w.sites || []) {
    if (!s || FOREIGN.has(s.kind)) continue;
    const k = Math.floor(clamp(s.y, 0, w.H - 1) / G) * gw + Math.floor(clamp(s.x, 0, w.W - 1) / G);
    let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(s);
    if (s.kind === 'ruin' && s.data && Number.isFinite(s.data.sid)) ruinsBySid.set(s.data.sid, s);
  }
  r._siteIdx = { grid, G, gw, ruinsBySid };
  r._siteKey = key;
  return r._siteIdx;
}
function sitesIn(r, x0, y0, x1, y1) {
  const ix = siteIndex(r), G = ix.G, out = [];
  for (let gy = Math.floor((y0 - 1) / G); gy <= Math.floor((y1 + 1) / G); gy++) for (let gx = Math.floor((x0 - 1) / G); gx <= Math.floor((x1 + 1) / G); gx++) {
    const a = ix.grid.get(gy * ix.gw + gx);
    if (a) for (const s of a) if (s.x >= x0 - 1 && s.x <= x1 + 1 && s.y >= y0 - 1 && s.y <= y1 + 1) out.push(s);
  }
  return out;
}

/**
 * Every ruin worth drawing: ruin sites (with their record), and any dead town the ledger has
 * not (yet) recorded — none is ever forgotten. [{ id, site|null, s, x, y, name, peak, tier,
 * founded, fell, data }] cached by the settlements and sites versions.
 */
export function ruinList(r) {
  const w = r.world;
  const key = `${w.versions.settlements}|${w.versions.sites | 0}|${w.settlements.length}`;
  if (r._ruinKey === key && r._ruinList) return r._ruinList;
  const ix = siteIndex(r);
  const out = [];
  const seen = new Set();
  for (const site of w.sites || []) {
    if (!site || site.kind !== 'ruin') continue;
    const d = site.data || {};
    const s = Number.isFinite(d.sid) ? w.settlements[d.sid] : null;
    if (s && s.alive) continue;   // refounded on its own ruins
    if (s) seen.add(s.id);
    const name = site.name || s?.name || 'a lost town';
    out.push({ id: site.id, site, s, x: site.x, y: site.y, name: String(name).replace(/^(the )?ruins of /i, ''), peak: d.peak ?? s?.peakPopulation ?? 500, tier: d.maxTier ?? s?.tier ?? 2,
      founded: s?.foundedDay ?? site.firstDay, fell: d.fellDay ?? s?.destroyedDay ?? site.firstDay, data: d });
  }
  for (const s of w.settlements) {
    if (!s || s.alive || s.destroyedDay == null || seen.has(s.id) || ix.ruinsBySid.has(s.id)) continue;
    out.push({ id: -1 - s.id, site: null, s, x: s.x, y: s.y, name: s.name, peak: s.peakPopulation || s.population || 100, tier: s.tier ?? 1,
      founded: s.foundedDay, fell: s.destroyedDay, data: { peak: s.peakPopulation, maxTier: s.tier, buildings: s.buildings, civId: s.civId, originCivId: s.originCivId, fellDay: s.destroyedDay, sid: s.id, cause: s.destroyCause } });
  }
  r._ruinList = out; r._ruinKey = key;
  return out;
}

// ---------------------------------------------------------------------------
// Symbols

/** A site's symbol sprite: s = radius in CSS px (quantised), origin at the centre. */
function siteSprite(cache, kind, s, dpr, fresh) {
  const sb = Math.max(3, qpx(s, 6));
  const key = `X${kind}|${sb.toFixed(2)}|${fresh ? 1 : 0}|${dpr}`;
  return cache.get(key, () => {
    const R = sb, W2 = R * 2 + 6;
    const c = makeCanvas(Math.ceil(W2 * dpr), Math.ceil(W2 * dpr));
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, (W2 / 2) * dpr, (W2 / 2) * dpr);
    g.lineJoin = 'round'; g.lineCap = 'round';
    const ink = css(INK, 0.92), lw = Math.max(1, R * 0.16);
    const halo = () => { g.strokeStyle = 'rgba(246,238,216,0.85)'; g.lineWidth = lw + 2.4; g.stroke(); g.strokeStyle = ink; g.lineWidth = lw; g.stroke(); };
    switch (kind) {
      case 'battle': {
        // crossed swords
        g.beginPath(); g.moveTo(-R * 0.8, -R * 0.8); g.lineTo(R * 0.8, R * 0.8); g.moveTo(R * 0.8, -R * 0.8); g.lineTo(-R * 0.8, R * 0.8); halo();
        g.strokeStyle = fresh ? 'rgb(170,40,30)' : 'rgb(130,52,38)'; g.lineWidth = lw * 1.4;
        g.beginPath(); g.moveTo(-R * 0.62, R * 0.25); g.lineTo(-R * 0.25, R * 0.62); g.moveTo(R * 0.62, R * 0.25); g.lineTo(R * 0.25, R * 0.62); g.stroke();
        break;
      }
      case 'siege': {
        g.beginPath(); g.moveTo(-R * 0.5, R * 0.8); g.lineTo(-R * 0.5, -R * 0.55); g.lineTo(-R * 0.2, -R * 0.55); g.lineTo(-R * 0.05, -R * 0.2); g.lineTo(R * 0.15, -R * 0.75); g.lineTo(R * 0.5, -R * 0.75); g.lineTo(R * 0.5, R * 0.8); g.closePath();
        g.fillStyle = 'rgb(196,182,156)'; g.fill(); halo();
        break;
      }
      case 'ruin': {
        g.fillStyle = 'rgb(186,172,148)';
        g.beginPath(); g.rect(-R * 0.75, -R * 0.2, R * 0.32, R * 0.85); g.rect(-R * 0.2, -R * 0.75, R * 0.34, R * 1.4); g.rect(R * 0.38, -R * 0.4, R * 0.32, R * 1.05); g.fill(); halo();
        g.beginPath(); g.moveTo(-R * 0.95, R * 0.68); g.lineTo(R * 0.95, R * 0.68); g.stroke();
        break;
      }
      case 'crater': {
        g.fillStyle = 'rgba(96,84,74,0.5)'; g.beginPath(); g.arc(0, 0, R * 0.62, 0, TAU); g.fill();
        g.beginPath(); g.arc(0, 0, R * 0.62, 0, TAU); halo();
        g.beginPath(); for (let k = 0; k < 10; k++) { const a = k * 0.63; g.moveTo(Math.cos(a) * R * 0.75, Math.sin(a) * R * 0.75); g.lineTo(Math.cos(a) * R, Math.sin(a) * R); } g.stroke();
        break;
      }
      case 'eruption': {
        g.fillStyle = 'rgb(122,102,88)'; g.beginPath(); g.moveTo(-R * 0.9, R * 0.7); g.lineTo(-R * 0.25, -R * 0.2); g.lineTo(R * 0.25, -R * 0.2); g.lineTo(R * 0.9, R * 0.7); g.closePath(); g.fill(); halo();
        g.fillStyle = 'rgb(206,84,40)'; g.beginPath(); g.arc(0, -R * 0.55, R * 0.3, 0, TAU); g.fill();
        break;
      }
      case 'quake': {
        g.beginPath(); g.moveTo(-R, -R * 0.2); g.lineTo(-R * 0.45, R * 0.25); g.lineTo(-R * 0.05, -R * 0.45); g.lineTo(R * 0.35, R * 0.35); g.lineTo(R, -R * 0.15); halo();
        break;
      }
      case 'wreck': {
        g.fillStyle = 'rgb(122,90,62)'; g.beginPath(); g.moveTo(-R * 0.9, R * 0.1); g.lineTo(R * 0.5, R * 0.1); g.lineTo(R * 0.2, R * 0.55); g.lineTo(-R * 0.6, R * 0.55); g.closePath(); g.fill(); halo();
        g.beginPath(); g.moveTo(-R * 0.1, R * 0.1); g.lineTo(R * 0.35, -R * 0.75); g.stroke();
        break;
      }
      case 'plaguepit': {
        g.fillStyle = 'rgb(150,150,110)'; g.beginPath(); g.ellipse(0, R * 0.35, R * 0.85, R * 0.4, 0, 0, TAU); g.fill(); halo();
        g.beginPath(); g.moveTo(0, -R * 0.85); g.lineTo(0, R * 0.2); g.moveTo(-R * 0.35, -R * 0.45); g.lineTo(R * 0.35, -R * 0.45); g.stroke();
        break;
      }
      case 'treaty': {
        g.fillStyle = 'rgb(236,226,196)'; g.beginPath(); g.rect(-R * 0.7, -R * 0.55, R * 1.4, R * 1.0); g.fill(); halo();
        g.fillStyle = 'rgb(176,52,40)'; g.beginPath(); g.arc(R * 0.35, R * 0.35, R * 0.28, 0, TAU); g.fill();
        break;
      }
      case 'holy': {
        g.beginPath(); for (let k = 0; k < 16; k++) { const a = -Math.PI / 2 + (k * Math.PI) / 8, rr = k & 1 ? R * 0.42 : R * 0.95; g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); } g.closePath();
        g.fillStyle = 'rgb(240,214,130)'; g.fill(); halo();
        break;
      }
      default: { // grave: a cairn
        g.fillStyle = 'rgb(168,160,146)';
        g.beginPath(); g.ellipse(0, R * 0.45, R * 0.75, R * 0.35, 0, 0, TAU); g.ellipse(0, 0, R * 0.5, R * 0.3, 0, 0, TAU); g.ellipse(0, -R * 0.4, R * 0.28, R * 0.22, 0, 0, TAU); g.fill(); halo();
      }
    }
    return { canvas: c, w: W2, h: W2, ox: W2 / 2, oy: W2 / 2, s: sb };
  });
}

/** A site's lettering: its name and its record. */
function siteLabel(w, s) {
  const n = s.n || 1, dead = s.dead || 0;
  const nm = s.name ? capFirst(String(s.name)) : null;
  switch (s.kind) {
    case 'battle': return `${nm || 'A field of battle'} — ${n > 1 ? `${n} battles, ` : ''}${dead >= 1 ? `${fmtDead(dead)} dead` : 'few dead'}`;
    case 'siege': return `${nm || 'Siege lines'}${n > 1 ? ` — besieged ${n} times` : ''}${dead >= 100 ? `, ${fmtDead(dead)} dead` : ''}`;
    case 'crater': return nm || `Star-fall crater (Y${yearOfDay(s.firstDay)})`;
    case 'eruption': return nm ? `${nm}${dead >= 100 ? ` — ${fmtDead(dead)} dead` : ''}` : `Great eruption, Y${yearOfDay(s.firstDay)}`;
    case 'quake': return nm || `Epicentre of the quake of Y${yearOfDay(s.firstDay)}`;
    case 'wreck': return nm || `Wreck${n > 1 ? `s (${n})` : ''}`;
    case 'plaguepit': return nm || `Plague pit${dead >= 100 ? ` — ${fmtDead(dead)} dead` : ''}`;
    case 'treaty': return nm || `Treaty ground (Y${yearOfDay(s.firstDay)})`;
    case 'holy': return nm || 'Holy place';
    case 'grave': return nm || `Graves${dead >= 1 ? ` of ${fmtDead(dead)}` : ''}`;
    default: return nm;
  }
}

/** The town plan on screen ([cx, cy, radius] CSS px, from drawCityPlans) whose footprint holds (sx, sy), or null. */
function planAt(r, sx, sy, margin = 0) {
  const list = r._planRects;
  if (!list || !list.length) return null;
  for (const p of list) if (Math.hypot(sx - p[0], sy - p[1]) < p[2] + margin) return p;
  return null;
}

/** Does this lettering only repeat the name of a living town at the site? (kept per settlements version) */
function townNamed(r, site, text) {
  const w = r.world;
  const key = `${w.versions.settlements}|${w.settlements.length}`;
  if (r._townNamedKey !== key || !r._townNamed) { r._townNamed = new Map(); r._townNamedKey = key; }
  const mk = `${site.id}|${text}`;
  const hit = r._townNamed.get(mk);
  if (hit !== undefined) return hit;
  const t = String(text).trim().toLowerCase();
  let same = false;
  for (const fp of townsIn(r, site.x - 1.5, site.y - 1.5, site.x + 1.5, site.y + 1.5)) {
    const s = w.settlements[fp.id];
    if (s && s.name && String(s.name).trim().toLowerCase() === t) { same = true; break; }
  }
  if (r._townNamed.size > 2000) r._townNamed.clear();
  r._townNamed.set(mk, same);
  return same;
}

/** Ruin lettering: "ruins of X", then "Ancient X (fl. Y120–Y480)" after three centuries. */
function ruinLabel(w, rn) {
  const age = (w.time.day - (rn.fell ?? w.time.day)) / DAYS_PER_YEAR;
  if (age >= 300) return `Ancient ${rn.name} (fl. Y${yearOfDay(rn.founded)}–Y${yearOfDay(rn.fell)})`;
  return `ruins of ${rn.name}`;
}

/**
 * Historic sites and ruins (screen space, beneath the settlements): symbols, lettering, hits.
 * Ruin foundations at close zoom are drawn by drawRuinPlans in the world pass.
 */
export function drawSites(r, ctx, labels) {
  const w = r.world, z = r.camera.zoom, dpr = r.dpr;
  if (r.snapshot || z < 5.5) return;
  const vw = r.viewW, vh = r.viewH;
  const night = r.profile.night;
  const vb = r.viewBounds(1);
  const day = w.time.day;
  // sites
  for (const s of sitesIn(r, vb.x0, vb.y0, vb.x1, vb.y1)) {
    const meta = SITE_KINDS[s.kind] || { minZoom: 12 };
    if (s.kind === 'ruin') continue;   // ruins below
    const dead = s.dead || 0;
    const major = dead >= 3000 || s.kind === 'crater' || (s.fame || 0) >= 3;
    const minZ = major ? Math.min(6, meta.minZoom) : meta.minZoom;
    if (z < minZ) continue;
    const { sx, sy } = r.e2s(s.x, s.y);
    if (sx < -30 || sy < -30 || sx > vw + 30 || sy > vh + 30) continue;
    const rad = clamp(3.6 + Math.log10(1 + dead + (s.n || 1) * 40) * 1.5, 4, 11) * clamp(0.85 + z / 80, 0.9, 1.5);
    const fresh = day - (s.lastDay ?? 0) < DAYS_PER_YEAR;
    const a = smoothstep(minZ, minZ + 2, z);
    const sp = siteSprite(r.sprites, s.kind, rad, dpr, fresh);
    const k = rad / sp.s;
    ctx.globalAlpha = a * (s.kind === 'grave' && z > 30 ? 0.6 : 1);
    ctx.drawImage(sp.canvas, sx - sp.ox * k, sy - sp.oy * k, sp.w * k, sp.h * k);
    r.hits.push({ kind: 'site', id: s.id, x0: sx - rad - 2, y0: sy - rad - 2, x1: sx + rad + 2, y1: sy + rad + 2, pri: 1.5 });
    if (r.overlays.labels && (z >= minZ + 4 || (major && z >= 10))) {
      const text = siteLabel(w, s);
      // a site in a town whose plan shows is lettered beneath the plan, never across its
      // streets; one that only repeats the town's own name (its holy place) is not lettered
      const pr = planAt(r, sx, sy);
      if (text && !townNamed(r, s, text)) {
        const st = { size: 9.5, italic: true, color: night ? 'rgba(236,214,190,0.9)' : 'rgba(96,52,40,0.95)', halo: night ? 'rgba(10,14,22,0.6)' : 'rgba(244,236,214,0.78)', haloW: 2 };
        if (pr) labels.push({ pri: 8 + Math.log10(1 + dead) * 2 + (s.fame || 0), text, x: pr[0], y: pr[1] + pr[2] + 10, alt: 15, st });
        // beside a plan, the lettering may go above its symbol when the plan takes the space below
        else labels.push({ pri: 8 + Math.log10(1 + dead) * 2 + (s.fame || 0), text, x: sx, y: sy + rad + 8, alt: planAt(r, sx, sy + rad + 8, 14) ? rad * 2 + 16 : undefined, st });
      }
    }
  }
  // ruins: a symbol until their foundations take over
  if (z >= 7) {
    for (const rn of ruinList(r)) {
      if (rn.x < vb.x0 - 1 || rn.x > vb.x1 + 1 || rn.y < vb.y0 - 1 || rn.y > vb.y1 + 1) continue;
      const small = (rn.peak || 0) < 400;
      if (small && z < 12) continue;
      const { sx, sy } = r.e2s(rn.x, rn.y);
      const planA = r._ruinPlanAlpha ? (r._ruinPlanAlpha.get(rn.id) || 0) : 0;
      const rad = Math.max(3.4, tierRadius(Math.min(4, rn.tier || 2), z) * 0.78);
      if (planA < 0.9) {
        const sp = siteSprite(r.sprites, 'ruin', rad, dpr, false);
        const k = rad / sp.s;
        ctx.globalAlpha = (1 - planA) * smoothstep(7, 9, z) * (small ? 0.8 : 1);
        ctx.drawImage(sp.canvas, sx - sp.ox * k, sy - sp.oy * k, sp.w * k, sp.h * k);
      }
      r.hits.push(rn.site ? { kind: 'site', id: rn.site.id, x0: sx - rad - 2, y0: sy - rad - 2, x1: sx + rad + 2, y1: sy + rad + 2, pri: 1.4 }
        : { kind: 'settlement', id: rn.s.id, x0: sx - rad - 2, y0: sy - rad - 2, x1: sx + rad + 2, y1: sy + rad + 2, pri: 1.4 });
      if (r.overlays.labels && z >= (small ? 16 : 11)) {
        labels.push({ pri: 6 + Math.log10(1 + (rn.peak || 0)) * 1.5, text: ruinLabel(w, rn), x: sx, y: sy + rad + 8 + (planA > 0.5 ? (r._ruinPlanR?.get(rn.id) || 0) * z * 0.6 : 0),
          st: { size: 9.5, italic: true, color: night ? 'rgba(222,208,186,0.9)' : 'rgba(92,78,66,0.95)', halo: night ? 'rgba(10,14,22,0.6)' : 'rgba(240,232,212,0.75)', haloW: 2 } });
      }
    }
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// Graves, baked into the close-zoom chunks round the fields of the slain

function graveSites(r, x0, y0, x1, y1) {
  return sitesIn(r, x0, y0, x1, y1).filter((s) => (s.kind === 'battle' || s.kind === 'siege' || s.kind === 'grave' || s.kind === 'plaguepit') && (s.dead || 0) >= 120);
}
function paintGraves(g, info) {
  const { world: w, k, P, ax0, ay0, ax1, ay1, px, py, seed } = info;
  const sites = graveSites(info.r, ax0, ay0, ax1, ay1);
  if (!sites.length) return;
  const Lv = info.terr.Lv, W = w.W, H = w.H;
  const day = w.time.day;
  for (const s of sites) {
    const n = Math.min(40, Math.max(1, Math.round((s.dead || 0) / 250)));
    const fresh = day - (s.lastDay ?? 0) < DAYS_PER_YEAR;
    const civ = s.civIds && s.civIds.length ? s.civIds[0] : -1;
    const st = civ >= 0 ? styleOf(info.r, civ) : null;
    const form = st && st.temple === 'basilica' && (w.civs[civ]?.tech?.era | 0) >= 3 ? 'cross' : st && (st.temple === 'stupa' || st.temple === 'onion') ? 'stela' : 'cairn';
    const spread = 0.1 + 0.035 * Math.sqrt(n);
    // trampled, darker earth for a fresh field
    if (fresh) { g.fillStyle = 'rgba(96,72,48,0.28)'; g.beginPath(); g.ellipse(px(s.x), py(s.y), spread * P * 1.5, spread * P * 1.1, 0, 0, TAU); g.fill(); }
    let hh = hash2i(s.id, 77, 911 ^ seed);
    const sz = Math.max(1.4, P * 0.022);
    for (let q = 0; q < n; q++) {
      hh = Math.imul(hh ^ (hh >>> 13), 0x5bd1e995) >>> 0;
      const a = hf(hh, 0, 10) * TAU, d = Math.sqrt(hf(hh, 10, 10)) * spread;
      const x = s.x + Math.cos(a) * d, y = s.y + Math.sin(a) * d * 0.75;
      if (bilLv(Lv, W, H, x, y) < 0.03) continue;
      const X = px(x), Y = py(y);
      if (k <= 1) { g.fillStyle = 'rgba(110,104,96,0.85)'; g.fillRect(X - sz * 0.5, Y - sz * 0.5, sz, sz); continue; }
      g.fillStyle = 'rgba(30,24,16,0.25)'; g.beginPath(); g.ellipse(X + sz * 0.4, Y + sz * 0.2, sz * 0.9, sz * 0.35, 0, 0, TAU); g.fill();
      if (form === 'cross') {
        g.strokeStyle = 'rgba(206,198,184,0.95)'; g.lineWidth = Math.max(1, sz * 0.35);
        g.beginPath(); g.moveTo(X, Y); g.lineTo(X, Y - sz * 1.6); g.moveTo(X - sz * 0.5, Y - sz * 1.1); g.lineTo(X + sz * 0.5, Y - sz * 1.1); g.stroke();
      } else if (form === 'stela') {
        g.fillStyle = 'rgb(196,188,172)'; g.strokeStyle = 'rgba(60,50,40,0.7)'; g.lineWidth = Math.max(0.6, sz * 0.15);
        g.beginPath(); g.rect(X - sz * 0.35, Y - sz * 1.4, sz * 0.7, sz * 1.4); g.fill(); g.stroke();
      } else {
        g.fillStyle = 'rgb(160,152,138)'; g.strokeStyle = 'rgba(60,50,40,0.6)'; g.lineWidth = Math.max(0.6, sz * 0.15);
        g.beginPath(); g.ellipse(X, Y - sz * 0.3, sz * 0.7, sz * 0.45, 0, 0, TAU); g.ellipse(X, Y - sz * 0.8, sz * 0.4, sz * 0.3, 0, 0, TAU); g.fill(); g.stroke();
      }
    }
    // the weapons of the fallen, the first year
    if (fresh && k >= 2) {
      g.strokeStyle = 'rgba(60,52,46,0.75)'; g.lineWidth = Math.max(0.8, P * 0.006);
      g.beginPath();
      for (let q = 0; q < Math.min(60, n * 3); q++) {
        hh = Math.imul(hh ^ (hh >>> 13), 0x5bd1e995) >>> 0;
        const a = hf(hh, 0, 10) * TAU, d = Math.sqrt(hf(hh, 10, 10)) * spread * 1.6;
        const X = px(s.x + Math.cos(a) * d), Y = py(s.y + Math.sin(a) * d), L = P * 0.025, b = hf(hh, 20) * Math.PI;
        g.moveTo(X - Math.cos(b) * L, Y - Math.sin(b) * L); g.lineTo(X + Math.cos(b) * L, Y + Math.sin(b) * L);
      }
      g.stroke();
    }
  }
}
function bilLv(F, W, H, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const cx0 = clamp(x0, 0, W - 1), cx1 = clamp(x0 + 1, 0, W - 1), cy0 = clamp(y0, 0, H - 1), cy1 = clamp(y0 + 1, 0, H - 1);
  return F[cy0 * W + cx0] * (1 - fx) * (1 - fy) + F[cy0 * W + cx1] * fx * (1 - fy) + F[cy1 * W + cx0] * (1 - fx) * fy + F[cy1 * W + cx1] * fx * fy;
}
registerPainter('graves', 1, paintGraves, {
  order: 70, apron: 1,
  sig: (w, x0, y0, x1, y1, k, r) => {
    let h = 29;
    const day = w.time.day;
    for (const s of graveSites(r, x0, y0, x1, y1)) { h = mix(h, s.id); h = mix(h, Math.round((s.dead || 0) / 250)); h = mix(h, day - (s.lastDay ?? 0) < DAYS_PER_YEAR ? 1 : 0); }
    return h;
  },
});

// ---------------------------------------------------------------------------
// Ruin foundations (world pass; the plan machinery draws them)

/** Foundations of the ruins in view (world transform), from Province zoom. */
export function drawRuins(r, ctx, z) {
  r._ruinPlanAlpha = r._ruinPlanAlpha || new Map();
  r._ruinPlanAlpha.clear();
  if (r.snapshot || z < 14) return;
  const vb = r.viewBounds(2);
  const vis = ruinList(r).filter((rn) => rn.x >= vb.x0 - 1 && rn.x <= vb.x1 + 1 && rn.y >= vb.y0 - 1 && rn.y <= vb.y1 + 1);
  if (vis.length) drawRuinPlans(r, ctx, z, vis);
}

// ---------------------------------------------------------------------------
// Wonders

/** Where a wonder stands (entity coords) and its city, or null. */
function wonderPlace(r, wd) {
  const w = r.world;
  const s = w.settlements[wd.sid];
  if (!s) return null;
  const pic = r._planLast?.get(s.id);
  const lm = pic && pic.plan ? pic.plan.landmarks.find((l) => l.key === 'wonder' && l.id === wd.id) : null;
  if (lm) return { s, x: s.x + pic.plan.ox + lm.x, y: s.y + pic.plan.oy + lm.y, onPlan: true };
  const a = hf(hash2i(wd.id, 3, 4111), 0, 10) * TAU;
  return { s, x: s.x + Math.cos(a) * 0.32, y: s.y + Math.sin(a) * 0.32, a, onPlan: false };
}

/**
 * Wonders (screen space, after the settlements): a gold-ringed symbol by the city from
 * Continent zoom, a silhouette from Region zoom until the town plan shows it, lettered from
 * z 12; fallen ones as rubble. Hits kind 'wonder'.
 */
export function drawWonders(r, ctx, labels) {
  const w = r.world, z = r.camera.zoom, dpr = r.dpr;
  if (r.snapshot || z < 5 || !w.wonders || !w.wonders.length) return;
  const vw = r.viewW, vh = r.viewH;
  const night = r.profile.night;
  for (const wd of w.wonders) {
    if (!wd || wd.sid == null) continue;
    const P = wonderPlace(r, wd);
    if (!P) continue;
    const ruined = wd.destroyedDay != null || !P.s.alive;
    const { sx: cx, sy: cy } = r.e2s(P.s.x, P.s.y);
    if (cx < -80 || cy < -80 || cx > vw + 80 || cy > vh + 80) continue;
    const icon = tierRadius(P.s.tier || 3, z);
    const pic = smoothstep(14, 18, z);          // symbol → silhouette
    const planShows = 1 - smoothstep(46, 70, z); // the plan's own drawing takes over
    let hx, hy, hr;
    if (pic < 1) {
      // a gold ring beside the city
      const a = P.a ?? hf(hash2i(wd.id, 3, 4111), 0, 10) * TAU;
      const R = clamp(4 + z * 0.35, 5, 9);
      const sx = cx + Math.cos(a) * (icon + R + 5), sy = cy + Math.sin(a) * (icon + R + 5);
      const sp = wonderSprite(r.sprites, wd.kind, R, dpr, 'sym', ruined);
      const k = R / sp.s;
      ctx.globalAlpha = (1 - pic) * smoothstep(5, 6.5, z);
      ctx.drawImage(sp.canvas, sx - sp.ox * k, sy - sp.oy * k, sp.w * k, sp.h * k);
      hx = sx; hy = sy; hr = R + 2;
    }
    if (pic > 0 && planShows > 0) {
      const { sx, sy } = r.e2s(P.x, P.y);
      const S = clamp(z * 0.22, 7, 22) * (ruined ? 0.8 : 1);
      const sp = wonderSprite(r.sprites, wd.kind, S, dpr, 'pic', ruined);
      const k = S / sp.s;
      ctx.globalAlpha = pic * planShows;
      ctx.drawImage(sp.canvas, sx - sp.ox * k, sy - sp.oy * k, sp.w * k, sp.h * k);
      if (pic > 0.5) { hx = sx; hy = sy - S; hr = S * 1.1; }
    }
    if (hx == null) { const { sx, sy } = r.e2s(P.x, P.y); hx = sx; hy = sy; hr = Math.max(8, z * 0.3); }
    r.hits.push({ kind: 'wonder', id: wd.id, x0: hx - hr, y0: hy - hr, x1: hx + hr, y1: hy + hr, pri: 3.2 });
    if (r.overlays.labels && z >= 12 && wd.name) {
      const text = ruined ? `ruins of ${wd.name.replace(/^the /i, 'the ')}` : capFirst(wd.name);
      labels.push({ pri: 44 + (ruined ? -10 : 0), text, x: hx, y: hy + hr + 9, overPlan: P.onPlan || undefined, st: { size: clamp(9 + z * 0.06, 9.5, 12.5), italic: true, color: ruined ? (night ? 'rgba(220,206,186,0.85)' : 'rgba(110,92,70,0.95)') : night ? 'rgb(244,214,140)' : 'rgb(140,98,24)', halo: night ? 'rgba(10,14,22,0.65)' : 'rgba(250,242,220,0.85)', haloW: 2.2 } });
    }
  }
  ctx.globalAlpha = 1;
}

/** The works that shape the land: the Great Wall's course, the Grand Canal, the Great Dam (world transform). */
export function drawWonderWorks(r, ctx, z) {
  const w = r.world;
  if (r.snapshot || z < 3.5 || !w.wonders || !w.wonders.length) return;
  const W = w.W, N = w.N;
  const vb = r.viewBounds(4);
  for (const wd of w.wonders) {
    if (!wd) continue;
    const ruined = wd.destroyedDay != null;
    if ((wd.kind === 'great_wall' || wd.kind === 'grand_canal') && Array.isArray(wd.path) && wd.path.length >= 2) {
      const pts = [];
      let inView = false;
      for (const i of wd.path) {
        if (!Number.isInteger(i) || i < 0 || i >= N) continue;
        const x = i % W, y = (i / W) | 0;
        pts.push(x, y);
        if (x >= vb.x0 && x <= vb.x1 && y >= vb.y0 && y <= vb.y1) inView = true;
      }
      if (!inView || pts.length < 4) continue;
      const path = smoothPath(pts);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      if (wd.kind === 'great_wall') {
        // a rampart: dark footing, stone walk, then towers as squat blocks along its course
        const wpx = Math.max(1.8, Math.min(0.1 * z, 9));
        ctx.strokeStyle = 'rgba(30,22,16,0.32)'; ctx.lineWidth = (wpx + 3) / z;
        ctx.save(); ctx.translate(1.2 / z, 1.6 / z); ctx.stroke(path); ctx.restore();
        ctx.strokeStyle = 'rgba(52,40,30,0.92)'; ctx.lineWidth = (wpx + 1.6) / z;
        if (ruined) ctx.setLineDash([wpx * 3 / z, wpx * 1.8 / z]);
        ctx.stroke(path);
        ctx.strokeStyle = ruined ? 'rgb(168,160,142)' : 'rgb(214,198,164)'; ctx.lineWidth = wpx / z;
        ctx.stroke(path);
        ctx.setLineDash([]);
        if (z >= 9) {
          const t = (wpx * 0.95) / z;
          ctx.fillStyle = ruined ? 'rgb(160,152,136)' : 'rgb(196,180,146)'; ctx.strokeStyle = 'rgba(40,30,22,0.9)'; ctx.lineWidth = 1.1 / z;
          for (let q = 0; q < pts.length; q += 4) {
            if (ruined && (q / 4) % 2) continue;
            ctx.beginPath(); ctx.rect(pts[q] - t, pts[q + 1] - t, t * 2, t * 2); ctx.fill(); ctx.stroke();
            ctx.fillStyle = 'rgba(30,22,16,0.4)'; ctx.fillRect(pts[q] - t * 0.5, pts[q + 1] - t * 0.5, t, t);
            ctx.fillStyle = ruined ? 'rgb(160,152,136)' : 'rgb(196,180,146)';
          }
        }
      } else {
        const wpx = Math.max(1.2, Math.min(0.07 * z, 6));
        ctx.strokeStyle = ruined ? 'rgba(150,160,140,0.8)' : 'rgba(214,206,186,0.9)'; ctx.lineWidth = (wpx + 2.2) / z; ctx.stroke(path);
        ctx.strokeStyle = ruined ? 'rgba(110,140,130,0.7)' : 'rgb(84,132,170)'; ctx.lineWidth = wpx / z; ctx.stroke(path);
      }
    } else if (wd.kind === 'great_dam' && Number.isInteger(wd.i) && wd.i >= 0 && wd.i < N) {
      const x = wd.i % W, y = (wd.i / W) | 0;
      if (x < vb.x0 || x > vb.x1 || y < vb.y0 || y > vb.y1) continue;
      // the reservoir: the river's course a few tiles upstream, widened into a lake
      const f = w.f;
      let cur = wd.i;
      const up = [];
      for (let q = 0; q < 6; q++) {
        let best = -1, bf = -1;
        const cx = cur % W, cy = (cur / W) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = cx + dx, yy = cy + dy;
          if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= W || yy >= w.H) continue;
          const j = yy * W + xx;
          if (f.flowDir[j] === cur && f.river[j] > 0 && f.flow[j] > bf) { bf = f.flow[j]; best = j; }
        }
        if (best < 0) break;
        up.push(best); cur = best;
      }
      if (!ruined && up.length) {
        ctx.fillStyle = 'rgba(70,122,156,0.55)';
        ctx.beginPath();
        up.forEach((j, q) => { const rr = 0.42 - q * 0.04; ctx.moveTo((j % W) + rr, (j / W) | 0); ctx.arc(j % W, (j / W) | 0, rr, 0, TAU); });
        ctx.fill();
      }
      const d = f.flowDir[wd.i];
      const ang = d >= 0 ? Math.atan2(((d / W) | 0) - y, (d % W) - x) + Math.PI / 2 : 0;
      ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
      const L = 0.42, T = Math.max(1.5 / z, 0.07);
      ctx.fillStyle = ruined ? 'rgb(160,154,144)' : 'rgb(206,202,192)'; ctx.strokeStyle = 'rgba(40,30,22,0.85)'; ctx.lineWidth = 1.2 / z;
      ctx.beginPath(); ctx.moveTo(-L, -T); ctx.quadraticCurveTo(0, -T * 2.2, L, -T); ctx.lineTo(L, T); ctx.quadraticCurveTo(0, -T * 0.2, -L, T); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
  }
}

function smoothPath(pts) {
  const p = new Path2D();
  const n = pts.length / 2;
  p.moveTo(pts[0], pts[1]);
  if (n === 2) { p.lineTo(pts[2], pts[3]); return p; }
  p.lineTo((pts[0] + pts[2]) / 2, (pts[1] + pts[3]) / 2);
  for (let k = 1; k < n - 1; k++) p.quadraticCurveTo(pts[k * 2], pts[k * 2 + 1], (pts[k * 2] + pts[k * 2 + 2]) / 2, (pts[k * 2 + 1] + pts[k * 2 + 3]) / 2);
  p.lineTo(pts[(n - 1) * 2], pts[(n - 1) * 2 + 1]);
  return p;
}
