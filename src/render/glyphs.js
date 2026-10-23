// Procedural map glyphs, pre-rendered into small sprite canvases and cached:
// settlement icons by tier (symbols when small, pictorial when large), army banners,
// warships and merchant ships, trees and peaks for the close-up detail layer.

import { makeCanvas } from './terrain.js';
import { css, darken, lighten, mix3, INK, PARCHMENT } from './palette.js';

/** LRU cache of sprite canvases. */
export class SpriteCache {
  constructor(max = 900) { this.max = max; this.map = new Map(); }
  get(key, make) {
    let v = this.map.get(key);
    if (v) { this.map.delete(key); this.map.set(key, v); return v; }
    v = make();
    this.map.set(key, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return v;
  }
  clear() { this.map.clear(); }
}

/** Create a sprite of CSS size (w, h) at dpr with origin (ox, oy); draw(ctx) in CSS px around the origin. */
function sprite(w, h, ox, oy, dpr, draw) {
  const c = makeCanvas(Math.ceil(w * dpr), Math.ceil(h * dpr));
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, ox * dpr, oy * dpr);
  g.lineJoin = 'round'; g.lineCap = 'round';
  draw(g);
  return { canvas: c, w, h, ox, oy };
}

const INKC = css(INK);
const PARC = css(PARCHMENT);
const GOLD = '#e2b54c';

function star(g, x, y, r, points = 5, inner = 0.45) {
  g.beginPath();
  for (let k = 0; k < points * 2; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / points;
    const rr = k & 1 ? r * inner : r;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
}

// --- building parts for the pictorial icons: the culture's roof form on a body of its wall
//     material, so towns read by people at a glance while their roofs keep the nation's colour

function body(g, x, y, w, h, face, lw) {
  g.fillStyle = face; g.strokeStyle = INKC; g.lineWidth = lw;
  g.beginPath(); g.rect(x - w / 2, y - h, w, h); g.fill(); g.stroke();
}

/** A house: body + roof in the given form. form: pitched | flat | dome | pagoda | thatch | longhouse. */
function house(g, x, y, w, h, roof, lw, form = 'pitched', face = PARC) {
  switch (form) {
    case 'flat': {
      body(g, x, y, w * 1.05, h * 1.05, face, lw);
      g.fillStyle = roof; g.beginPath(); g.rect(x - w * 0.6, y - h * 1.05 - w * 0.14, w * 1.2, w * 0.14); g.fill(); g.stroke();
      g.fillStyle = INKC; g.fillRect(x - w * 0.12, y - h * 0.5, w * 0.24, h * 0.5);
      break;
    }
    case 'dome': {
      body(g, x, y, w, h, face, lw);
      g.fillStyle = roof; g.beginPath(); g.arc(x, y - h, w * 0.46, Math.PI, 0); g.closePath(); g.fill(); g.stroke();
      break;
    }
    case 'pagoda': {
      body(g, x, y, w * 0.86, h, face, lw);
      g.fillStyle = roof;
      g.beginPath(); g.moveTo(x - w * 0.78, y - h + w * 0.04); g.quadraticCurveTo(x - w * 0.5, y - h - w * 0.08, x - w * 0.3, y - h - w * 0.36); g.lineTo(x + w * 0.3, y - h - w * 0.36); g.quadraticCurveTo(x + w * 0.5, y - h - w * 0.08, x + w * 0.78, y - h + w * 0.04); g.closePath(); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(x - w * 0.42, y - h - w * 0.36); g.lineTo(x, y - h - w * 0.66); g.lineTo(x + w * 0.42, y - h - w * 0.36); g.closePath(); g.fill(); g.stroke();
      break;
    }
    case 'thatch': {
      g.fillStyle = face; g.strokeStyle = INKC; g.lineWidth = lw;
      g.beginPath(); g.moveTo(x - w * 0.48, y); g.lineTo(x - w * 0.48, y - h * 0.62); g.lineTo(x + w * 0.48, y - h * 0.62); g.lineTo(x + w * 0.48, y); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = roof; g.beginPath(); g.moveTo(x - w * 0.66, y - h * 0.55); g.quadraticCurveTo(x, y - h - w * 0.9, x + w * 0.66, y - h * 0.55); g.closePath(); g.fill(); g.stroke();
      break;
    }
    case 'longhouse': {
      const W2 = w * 1.35;
      body(g, x, y, W2, h * 0.7, face, lw);
      g.fillStyle = roof; g.beginPath(); g.moveTo(x - W2 * 0.58, y - h * 0.65); g.quadraticCurveTo(x, y - h * 0.7 - w * 0.75, x + W2 * 0.58, y - h * 0.65); g.closePath(); g.fill(); g.stroke();
      break;
    }
    default: {
      body(g, x, y, w, h, face, lw);
      g.fillStyle = roof;
      g.beginPath(); g.moveTo(x - w * 0.62, y - h + 0.2); g.lineTo(x, y - h - w * 0.62); g.lineTo(x + w * 0.62, y - h + 0.2); g.closePath(); g.fill(); g.stroke();
    }
  }
}

function tower(g, x, y, w, h, roof, lw, pointy = true, face = PARC) {
  g.fillStyle = face; g.strokeStyle = INKC; g.lineWidth = lw;
  g.beginPath(); g.rect(x - w / 2, y - h, w, h); g.fill(); g.stroke();
  g.fillStyle = roof;
  g.beginPath();
  if (pointy) { g.moveTo(x - w * 0.65, y - h); g.lineTo(x, y - h - w * 1.1); g.lineTo(x + w * 0.65, y - h); }
  else { g.rect(x - w * 0.62, y - h - w * 0.35, w * 1.24, w * 0.35); }
  g.closePath(); g.fill(); g.stroke();
}

/** The town's sacred building in its people's form: basilica | onion | stupa | ziggurat | pyramid. */
function temple(g, x, y, s, form, roof, lw, face = PARC) {
  g.strokeStyle = INKC; g.lineWidth = lw;
  switch (form) {
    case 'onion': {
      body(g, x, y, s * 0.36, s * 0.62, face, lw);
      g.fillStyle = roof;
      g.beginPath(); g.moveTo(x - s * 0.22, y - s * 0.62); g.bezierCurveTo(x - s * 0.3, y - s * 0.86, x - s * 0.04, y - s * 0.9, x, y - s * 1.08); g.bezierCurveTo(x + s * 0.04, y - s * 0.9, x + s * 0.3, y - s * 0.86, x + s * 0.22, y - s * 0.62); g.closePath(); g.fill(); g.stroke();
      break;
    }
    case 'stupa': {
      g.fillStyle = face;
      g.beginPath(); g.rect(x - s * 0.36, y - s * 0.16, s * 0.72, s * 0.16); g.fill(); g.stroke();
      g.beginPath(); g.arc(x, y - s * 0.16, s * 0.3, Math.PI, 0); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = roof; g.beginPath(); g.moveTo(x - s * 0.06, y - s * 0.44); g.lineTo(x, y - s * 0.86); g.lineTo(x + s * 0.06, y - s * 0.44); g.closePath(); g.fill(); g.stroke();
      break;
    }
    case 'ziggurat': {
      for (let q = 0; q < 3; q++) { const k = 1 - q * 0.3; g.fillStyle = q === 2 ? roof : face; g.beginPath(); g.rect(x - s * 0.42 * k, y - s * (q + 1) * 0.2, s * 0.84 * k, s * 0.2); g.fill(); g.stroke(); }
      break;
    }
    case 'pyramid': {
      g.fillStyle = face; g.beginPath(); g.moveTo(x - s * 0.46, y); g.lineTo(x, y - s * 0.62); g.lineTo(x + s * 0.46, y); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = roof; g.beginPath(); g.moveTo(x - s * 0.12, y - s * 0.46); g.lineTo(x, y - s * 0.62); g.lineTo(x + s * 0.12, y - s * 0.46); g.closePath(); g.fill();
      break;
    }
    default: tower(g, x, y, s * 0.3, s * 0.78, roof, lw, true, face);
  }
}

/** Race symbols at small zoom (RACE_META symbol): round | leaf | diamond | spike | mound | scale. */
function raceSymbol(g, sym, s, fill) {
  g.fillStyle = fill; g.strokeStyle = INKC;
  g.beginPath();
  switch (sym) {
    case 'leaf': g.moveTo(0, -s * 0.95); g.quadraticCurveTo(s * 0.85, -s * 0.2, 0, s * 0.85); g.quadraticCurveTo(-s * 0.85, -s * 0.2, 0, -s * 0.95); break;
    case 'diamond': g.moveTo(0, -s * 0.9); g.lineTo(s * 0.72, 0); g.lineTo(0, s * 0.9); g.lineTo(-s * 0.72, 0); g.closePath(); break;
    case 'spike': for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + (k * Math.PI) / 5, rr = k & 1 ? s * 0.42 : s * 0.92; g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); } g.closePath(); break;
    case 'mound': g.moveTo(-s * 0.9, s * 0.45); g.quadraticCurveTo(0, -s * 1.1, s * 0.9, s * 0.45); g.closePath(); break;
    case 'scale': g.moveTo(0, -s * 0.9); g.quadraticCurveTo(s * 0.9, -s * 0.5, s * 0.6, s * 0.6); g.quadraticCurveTo(0, s * 0.95, -s * 0.6, s * 0.6); g.quadraticCurveTo(-s * 0.9, -s * 0.5, 0, -s * 0.9); break;
    default: g.arc(0, 0, s * 0.62, 0, Math.PI * 2);
  }
  g.fill(); g.stroke();
}

const RACE_SYMBOL = { human: 'round', elf: 'leaf', dwarf: 'diamond', orc: 'spike', halfling: 'mound', lizardfolk: 'scale' };
const FACE = { mudbrick: [214, 182, 132], timber: [198, 164, 118], whitewash: [242, 238, 228], stone: [214, 206, 188], brick: [196, 122, 92] };

/**
 * Settlement icon sprite. s = nominal radius in CSS px; the sprite is made at a quantised size
 * sp.s, so draw it scaled by s / sp.s. Cartographic symbols below 6.5 px (a race's own symbol
 * in Mythic worlds), pictorial above, built in the founders' style.
 * opts: { capital, era, style: { roof, wall, temple, race? }, race }.
 */
export function settlementSprite(cache, tier, rgb, s, dpr, opts = {}) {
  const sb = Math.max(2, qpx(s, 8));
  const cap = opts.capital ? 1 : 0;
  const era = opts.era || 0;
  const st = opts.style || null;
  const race = opts.race || st?.race || null;
  // opts.force: 'sym' | 'pic' draws that form whatever the size (for the cross-fade between them)
  const sym = opts.force ? opts.force === 'sym' : sb < 6.5;
  const form = sym ? `sym:${race && race !== 'human' ? race : ''}` : `${st ? `${st.roof}|${st.wall}|${st.temple}` : ''}|${race || ''}`;
  const key = `S${tier}|${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0}|${sb.toFixed(2)}|${cap}|${era >= 7 ? 2 : era >= 6 ? 1 : 0}|${form}|${dpr}`;
  return cache.get(key, () => drawSettlement(tier, rgb, sb, dpr, cap, era, st, race, sym));
}

function drawSettlement(tier, rgb, s, dpr, capital, era, st, race, sym) {
  const pad = 3;
  const W = s * 2.4 + pad * 2 + (capital ? s * 0.6 : 0), Hh = s * 2.6 + pad * 2 + (capital ? s * 0.9 : 0);
  const ox = W / 2, oy = pad + s * 1.4 + (capital ? s * 0.9 : 0);
  const civ = css(rgb);
  const roof = css(darken(rgb, 0.08));
  const roofDark = css(darken(rgb, 0.3));
  const lw = Math.max(0.8, Math.min(1.6, s * 0.11));
  const formRoof = st?.roof || 'pitched';
  const face = st && FACE[st.wall] ? css(FACE[st.wall]) : PARC;
  const tform = st?.temple || 'basilica';
  const sp = sprite(W, Hh, ox, oy, dpr, (g) => {
    if (sym) {
      // cartographic symbols
      g.lineWidth = Math.max(0.9, s * 0.2);
      g.strokeStyle = INKC;
      if (capital) {
        g.fillStyle = civ;
        star(g, 0, 0, s * 1.15, 5, 0.46); g.fill(); g.stroke();
        g.fillStyle = PARC; g.beginPath(); g.arc(0, 0, s * 0.28, 0, Math.PI * 2); g.fill();
        return;
      }
      if (race && race !== 'human' && RACE_SYMBOL[race]) {
        raceSymbol(g, RACE_SYMBOL[race], s * (0.7 + tier * 0.06), civ);
        if (tier >= 3) { g.fillStyle = PARC; g.beginPath(); g.arc(0, 0, s * 0.2, 0, Math.PI * 2); g.fill(); }
        return;
      }
      if (tier <= 1) {
        g.fillStyle = civ; g.beginPath(); g.arc(0, 0, s * 0.55, 0, Math.PI * 2); g.fill(); g.stroke();
      } else if (tier === 2) {
        g.fillStyle = PARC; g.beginPath(); g.arc(0, 0, s * 0.72, 0, Math.PI * 2); g.fill(); g.stroke();
        g.fillStyle = civ; g.beginPath(); g.arc(0, 0, s * 0.38, 0, Math.PI * 2); g.fill();
      } else if (tier <= 4) {
        g.fillStyle = civ; g.beginPath(); g.arc(0, 0, s * 0.88, 0, Math.PI * 2); g.fill(); g.stroke();
        g.fillStyle = PARC; g.beginPath(); g.arc(0, 0, s * 0.36, 0, Math.PI * 2); g.fill();
      } else {
        g.fillStyle = PARC; g.beginPath(); g.arc(0, 0, s * 1.02, 0, Math.PI * 2); g.fill(); g.stroke();
        g.fillStyle = civ; g.beginPath(); g.arc(0, 0, s * 0.7, 0, Math.PI * 2); g.fill(); g.stroke();
        g.fillStyle = PARC; g.beginPath(); g.arc(0, 0, s * 0.24, 0, Math.PI * 2); g.fill();
      }
      return;
    }
    // pictorial icons: ground at y = +0.55 s
    const gy = s * 0.55;
    const capMark = () => {
      if (!capital) return;
      const top = tier >= 6 ? gy - s * 2.35 : tier >= 4 ? gy - s * 1.62 : gy - s * 1.25;
      g.fillStyle = GOLD; g.strokeStyle = INKC; g.lineWidth = Math.max(0.8, lw * 0.8);
      star(g, 0, top - s * 0.28, s * 0.32, 5, 0.45); g.fill(); g.stroke();
    };
    g.fillStyle = 'rgba(30,22,14,0.22)';
    g.beginPath(); g.ellipse(0, gy + 0.6, s * (0.5 + tier * 0.09), s * 0.18, 0, 0, Math.PI * 2); g.fill();
    if (race && race !== 'human' && raceIcon(g, race, tier, s, gy, lw, civ, roof, roofDark)) { capMark(); return; }
    const H = (x, y, w, h, rf = roof) => house(g, x, y, w, h, rf, lw, formRoof, face);
    const pointy = formRoof !== 'flat' && formRoof !== 'dome';
    switch (tier) {
      case 0: { // tent / hut
        if (formRoof === 'thatch' || formRoof === 'longhouse') { H(0, gy, s * 0.9, s * 0.7); break; }
        g.fillStyle = civ; g.strokeStyle = INKC; g.lineWidth = lw;
        g.beginPath(); g.moveTo(-s * 0.62, gy); g.lineTo(0, -s * 0.62); g.lineTo(s * 0.62, gy); g.closePath(); g.fill(); g.stroke();
        g.fillStyle = INKC; g.beginPath(); g.moveTo(-s * 0.14, gy); g.lineTo(0, gy - s * 0.42); g.lineTo(s * 0.14, gy); g.closePath(); g.fill();
        g.beginPath(); g.moveTo(0, -s * 0.62); g.lineTo(-s * 0.12, -s * 0.85); g.moveTo(0, -s * 0.62); g.lineTo(s * 0.14, -s * 0.84); g.stroke();
        break;
      }
      case 1: { // hamlet: two cottages
        H(-s * 0.32, gy, s * 0.62, s * 0.48);
        H(s * 0.36, gy - s * 0.05, s * 0.5, s * 0.4);
        break;
      }
      case 2: { // village: houses round a small temple
        H(-s * 0.52, gy, s * 0.5, s * 0.38);
        temple(g, 0, gy - s * 0.06, s, tform, roofDark, lw, face);
        H(s * 0.5, gy, s * 0.52, s * 0.4);
        H(-s * 0.12, gy + s * 0.1, s * 0.46, s * 0.3);
        break;
      }
      case 3: { // walled town
        wallRing(g, s * 0.95, s * 0.5, gy, lw, st);
        H(-s * 0.35, gy - s * 0.12, s * 0.42, s * 0.42);
        temple(g, s * 0.05, gy - s * 0.16, s * 1.05, tform, roofDark, lw, face);
        H(s * 0.42, gy - s * 0.1, s * 0.42, s * 0.36);
        frontWall(g, s * 0.95, s * 0.5, gy, lw, st);
        break;
      }
      case 4: { // city with towers and keep
        wallRing(g, s * 1.0, s * 0.52, gy, lw, st);
        H(-s * 0.5, gy - s * 0.18, s * 0.38, s * 0.4);
        tower(g, s * 0.02, gy - s * 0.22, s * 0.44, s * 1.0, roof, lw, false, face);
        flag(g, s * 0.02, gy - s * 1.32, s * 0.5, civ, lw);
        H(s * 0.5, gy - s * 0.16, s * 0.38, s * 0.42);
        frontWall(g, s * 1.0, s * 0.52, gy, lw, st);
        tower(g, -s * 0.92, gy + s * 0.02, s * 0.26, s * 0.62, roofDark, lw, pointy, face);
        tower(g, s * 0.92, gy + s * 0.02, s * 0.26, s * 0.62, roofDark, lw, pointy, face);
        break;
      }
      case 5: { // great city: its great temple and spires
        wallRing(g, s * 1.05, s * 0.55, gy, lw, st);
        tower(g, -s * 0.62, gy - s * 0.2, s * 0.24, s * 1.0, roofDark, lw, pointy, face);
        H(-s * 0.3, gy - s * 0.2, s * 0.4, s * 0.45);
        if (tform === 'basilica' || tform === 'onion') {
          g.fillStyle = face; g.strokeStyle = INKC; g.lineWidth = lw;
          g.beginPath(); g.rect(-s * 0.05, gy - s * 0.75, s * 0.6, s * 0.55); g.fill(); g.stroke();
          if (tform === 'onion') temple(g, s * 0.25, gy - s * 0.75, s * 0.9, 'onion', civ, lw, face);
          else { g.fillStyle = civ; g.beginPath(); g.arc(s * 0.25, gy - s * 0.75, s * 0.3, Math.PI, 0); g.closePath(); g.fill(); g.stroke(); g.beginPath(); g.moveTo(s * 0.25, gy - s * 1.05); g.lineTo(s * 0.25, gy - s * 1.25); g.stroke(); }
        } else temple(g, s * 0.25, gy - s * 0.2, s * 1.35, tform, civ, lw, face);
        tower(g, s * 0.75, gy - s * 0.2, s * 0.22, s * 0.95, roofDark, lw, pointy, face);
        frontWall(g, s * 1.05, s * 0.55, gy, lw, st);
        tower(g, -s * 1.0, gy + s * 0.04, s * 0.28, s * 0.66, roofDark, lw, pointy, face);
        tower(g, 0, gy + s * 0.2, s * 0.3, s * 0.5, roofDark, lw, false, face);
        tower(g, s * 1.0, gy + s * 0.04, s * 0.28, s * 0.66, roofDark, lw, pointy, face);
        break;
      }
      default: { // metropolis skyline (glass towers in the modern age)
        const hs = era >= 7 ? [1.1, 1.7, 1.3, 2.2, 1.5, 1.9, 1.15] : [0.9, 1.4, 1.1, 1.85, 1.25, 1.55, 0.95];
        const n = hs.length, bw = (s * 2.0) / n;
        g.lineWidth = lw; g.strokeStyle = INKC;
        for (let k = 0; k < n; k++) {
          const x = -s + k * bw, h = s * hs[k] * (k === 3 ? 1.05 : 1);
          const tint = era >= 7 ? (k % 2 ? [176, 196, 210] : mix3([150, 170, 186], rgb, 0.2)) : k % 2 ? lighten(rgb, 0.55) : mix3(PARCHMENT, rgb, 0.25);
          g.fillStyle = css(tint);
          g.beginPath(); g.rect(x + bw * 0.08, gy - h, bw * 0.84, h); g.fill(); g.stroke();
          g.fillStyle = css(darken(rgb, 0.35), 0.75);
          for (let wy = gy - h + s * 0.18; wy < gy - s * 0.12; wy += s * 0.22) g.fillRect(x + bw * 0.32, wy, bw * 0.36, s * 0.07);
        }
        g.beginPath(); g.moveTo(-s + 3.5 * bw, gy - s * hs[3] * 1.05); g.lineTo(-s + 3.5 * bw, gy - s * hs[3] * 1.05 - s * 0.3); g.stroke();
        if (era >= 6) { g.fillStyle = css(darken(rgb, 0.45)); g.fillRect(s * 0.98, gy - s * 0.9, s * 0.14, s * 0.9); }
        g.fillStyle = css(darken(rgb, 0.15));
        g.beginPath(); g.rect(-s * 1.1, gy - s * 0.12, s * 2.2, s * 0.16); g.fill(); g.stroke();
      }
    }
    if (era >= 6 && tier >= 3 && tier < 6) {
      g.fillStyle = INKC;
      g.fillRect(s * 0.62, gy - s * 0.95, s * 0.12, s * 0.6);
    }
    capMark();
  });
  sp.s = s;
  return sp;
}

/** Mythic peoples' own towns (pictorial). Returns false for races drawn as ordinary towns. */
function raceIcon(g, race, tier, s, gy, lw, civ, roof, roofDark) {
  g.lineWidth = lw; g.strokeStyle = INKC;
  const big = 0.8 + tier * 0.08;
  switch (race) {
    case 'dwarf': {
      // a gate carved into the mountain: rock face, a dark arch, the clan's banners
      g.fillStyle = '#9a9488';
      g.beginPath(); g.moveTo(-s * 1.05 * big, gy); g.lineTo(-s * 0.4, -s * 0.9 * big); g.lineTo(s * 0.1, -s * 0.55 * big); g.lineTo(s * 0.45, -s * 1.0 * big); g.lineTo(s * 1.05 * big, gy); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = '#6e685e'; g.beginPath(); g.moveTo(s * 0.1, -s * 0.55 * big); g.lineTo(s * 0.45, -s * 1.0 * big); g.lineTo(s * 1.05 * big, gy); g.lineTo(s * 0.2, gy); g.closePath(); g.fill();
      g.fillStyle = '#2a2420'; g.beginPath(); g.moveTo(-s * 0.26, gy); g.lineTo(-s * 0.26, gy - s * 0.4); g.arc(0, gy - s * 0.4, s * 0.26, Math.PI, 0); g.lineTo(s * 0.26, gy); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = civ; for (const x of [-s * 0.48, s * 0.48]) { g.beginPath(); g.rect(x - s * 0.08, gy - s * 0.62, s * 0.16, s * 0.42); g.fill(); g.stroke(); }
      if (tier >= 3) { g.fillStyle = '#ff8a30'; g.beginPath(); g.arc(0, gy - s * 0.18, s * 0.08, 0, Math.PI * 2); g.fill(); }
      return true;
    }
    case 'elf': {
      // a great tree with halls among its boughs
      g.strokeStyle = 'rgba(70,52,34,0.95)'; g.lineWidth = Math.max(lw, s * 0.16);
      g.beginPath(); g.moveTo(0, gy); g.lineTo(0, -s * 0.2); g.moveTo(0, -s * 0.05); g.lineTo(-s * 0.35, -s * 0.4); g.moveTo(0, -s * 0.1); g.lineTo(s * 0.38, -s * 0.45); g.stroke();
      g.lineWidth = lw; g.strokeStyle = INKC;
      g.fillStyle = '#4f8a52'; g.beginPath(); g.arc(-s * 0.35, -s * 0.55, s * 0.42 * big, 0, Math.PI * 2); g.arc(s * 0.38, -s * 0.6, s * 0.44 * big, 0, Math.PI * 2); g.arc(0, -s * 0.9, s * 0.5 * big, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#6aa65e'; g.beginPath(); g.arc(-s * 0.1, -s * 1.0, s * 0.28 * big, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#f2d98a'; for (const [x, y] of [[-s * 0.4, -s * 0.5], [s * 0.36, -s * 0.62], [0, -s * 0.86]]) { g.beginPath(); g.arc(x, y, s * 0.07, 0, Math.PI * 2); g.fill(); }
      g.fillStyle = civ; g.beginPath(); g.moveTo(s * 0.05, -s * 1.3 * big); g.lineTo(s * 0.45, -s * 1.2 * big); g.lineTo(s * 0.05, -s * 1.12 * big); g.fill(); g.stroke();
      return true;
    }
    case 'orc': {
      // a spiked palisade round a hall of hides, a skull totem
      g.fillStyle = roofDark; g.beginPath(); g.moveTo(-s * 0.5, gy - s * 0.15); g.quadraticCurveTo(0, -s * 0.8, s * 0.5, gy - s * 0.15); g.closePath(); g.fill(); g.stroke();
      g.strokeStyle = '#4a3424'; g.lineWidth = Math.max(lw, s * 0.1);
      g.beginPath();
      for (let k = -5; k <= 5; k++) { const x = (k / 5) * s * big, h = s * (0.42 + (k & 1) * 0.18); g.moveTo(x, gy + s * 0.05); g.lineTo(x, gy - h); }
      g.stroke();
      g.fillStyle = '#e8e0cc'; g.strokeStyle = INKC; g.lineWidth = lw; g.beginPath(); g.arc(s * 0.75, gy - s * 0.82, s * 0.13, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = civ; g.beginPath(); g.moveTo(-s * 0.7, gy - s * 0.95); g.lineTo(-s * 0.35, gy - s * 0.85); g.lineTo(-s * 0.7, gy - s * 0.72); g.fill(); g.stroke();
      return true;
    }
    case 'halfling': {
      // grassy mounds with round doors
      const mounds = tier >= 3 ? [[-s * 0.5, 0.55], [s * 0.45, 0.6], [0, 0.75]] : [[-s * 0.3, 0.55], [s * 0.32, 0.6]];
      for (const [x, k] of mounds) {
        g.fillStyle = '#7fa65a'; g.beginPath(); g.ellipse(x, gy, s * k, s * k * 0.8, 0, Math.PI, 0); g.closePath(); g.fill(); g.stroke();
        g.fillStyle = civ; g.beginPath(); g.arc(x, gy - s * 0.04, s * k * 0.26, Math.PI, 0); g.closePath(); g.fill(); g.stroke();
      }
      return true;
    }
    case 'lizardfolk': {
      // a stepped temple and huts raised on stilts over the water
      g.strokeStyle = 'rgba(70,110,140,0.8)'; g.lineWidth = lw; g.beginPath(); g.moveTo(-s, gy - s * 0.02); g.lineTo(s, gy - s * 0.02); g.stroke();
      g.strokeStyle = INKC;
      for (let q = 0; q < 3; q++) { const k = 1 - q * 0.3; g.fillStyle = q === 2 ? civ : '#a8946a'; g.beginPath(); g.rect(-s * 0.5 * k, gy - s * 0.26 * (q + 1), s * k, s * 0.26); g.fill(); g.stroke(); }
      g.beginPath(); g.moveTo(s * 0.62, gy); g.lineTo(s * 0.62, gy - s * 0.3); g.moveTo(s * 0.92, gy); g.lineTo(s * 0.92, gy - s * 0.3); g.stroke();
      g.fillStyle = roof; g.beginPath(); g.moveTo(s * 0.5, gy - s * 0.3); g.lineTo(s * 0.77, gy - s * 0.62); g.lineTo(s * 1.04, gy - s * 0.3); g.closePath(); g.fill(); g.stroke();
      return true;
    }
    default: return false;
  }
}

function wallRing(g, rx, ry, gy, lw, st) {
  // back half of the curtain wall, drawn as an ellipse band in the style's stone
  const c = st && st.wall === 'mudbrick' ? [206, 180, 136] : st && st.wall === 'brick' ? [196, 140, 112] : [208, 192, 160];
  g.fillStyle = css(c); g.strokeStyle = INKC; g.lineWidth = lw;
  g.beginPath(); g.ellipse(0, gy - ry * 0.35, rx, ry, 0, 0, Math.PI * 2); g.fill(); g.stroke();
  g.fillStyle = 'rgba(150,132,104,0.55)';
  g.beginPath(); g.ellipse(0, gy - ry * 0.35, rx * 0.86, ry * 0.78, 0, 0, Math.PI * 2); g.fill();
}
function frontWall(g, rx, ry, gy, lw, st) {
  // front arc with crenellations
  g.strokeStyle = INKC; g.lineWidth = lw * 1.6;
  g.beginPath(); g.ellipse(0, gy - ry * 0.35, rx, ry, 0, 0.12, Math.PI - 0.12); g.stroke();
  g.strokeStyle = st && st.wall === 'brick' ? 'rgba(214,170,140,1)' : 'rgba(232,220,192,1)'; g.lineWidth = lw * 0.7;
  g.beginPath(); g.ellipse(0, gy - ry * 0.35, rx, ry, 0, 0.14, Math.PI - 0.14); g.stroke();
}
function flag(g, x, y, s, color, lw) {
  g.strokeStyle = INKC; g.lineWidth = lw * 0.8;
  g.beginPath(); g.moveTo(x, y + s * 0.6); g.lineTo(x, y - s * 0.1); g.stroke();
  g.fillStyle = color;
  g.beginPath(); g.moveTo(x, y - s * 0.1); g.lineTo(x + s * 0.55, y + s * 0.05); g.lineTo(x, y + s * 0.22); g.closePath(); g.fill(); g.stroke();
}

/** Army banner (or warship when naval). s = flag height in CSS px. Origin at the foot of the pole. */
export function bannerSprite(cache, rgb, s, dpr, naval) {
  const sb = Math.max(4, Math.round(s));
  const key = `B${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0}|${sb}|${naval ? 1 : 0}|${dpr}`;
  return cache.get(key, () => {
    const W = sb * 2.4, H = sb * 2.6;
    const ox = W / 2, oy = H - sb * 0.5;
    const civ = css(rgb), civD = css(darken(rgb, 0.35));
    const lw = Math.max(0.9, sb * 0.08);
    return sprite(W, H, ox, oy, dpr, (g) => {
      g.strokeStyle = INKC; g.lineWidth = lw;
      if (naval) {
        // hull
        g.fillStyle = '#6b4a2e';
        g.beginPath(); g.moveTo(-sb * 0.9, -sb * 0.18); g.lineTo(sb * 0.9, -sb * 0.18); g.lineTo(sb * 0.6, sb * 0.22); g.lineTo(-sb * 0.65, sb * 0.22); g.closePath(); g.fill(); g.stroke();
        // mast + square sail in civ colour
        g.beginPath(); g.moveTo(0, -sb * 0.18); g.lineTo(0, -sb * 1.6); g.stroke();
        g.fillStyle = civ;
        g.beginPath(); g.moveTo(-sb * 0.55, -sb * 1.35); g.quadraticCurveTo(0, -sb * 1.15, sb * 0.55, -sb * 1.35); g.lineTo(sb * 0.5, -sb * 0.45); g.quadraticCurveTo(0, -sb * 0.3, -sb * 0.5, -sb * 0.45); g.closePath(); g.fill(); g.stroke();
        g.fillStyle = civD; g.beginPath(); g.moveTo(0, -sb * 1.6); g.lineTo(sb * 0.45, -sb * 1.5); g.lineTo(0, -sb * 1.4); g.closePath(); g.fill();
        return;
      }
      // shadow
      g.fillStyle = 'rgba(20,14,8,0.28)';
      g.beginPath(); g.ellipse(0, 0, sb * 0.45, sb * 0.14, 0, 0, Math.PI * 2); g.fill();
      // pole
      g.strokeStyle = INKC; g.lineWidth = lw * 1.2;
      g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -sb * 1.9); g.stroke();
      g.fillStyle = GOLD; g.beginPath(); g.arc(0, -sb * 1.95, sb * 0.1, 0, Math.PI * 2); g.fill();
      // swallowtail flag
      g.fillStyle = civ; g.lineWidth = lw;
      g.beginPath();
      g.moveTo(0, -sb * 1.85); g.lineTo(sb * 1.0, -sb * 1.8); g.lineTo(sb * 0.78, -sb * 1.46); g.lineTo(sb * 1.0, -sb * 1.12); g.lineTo(0, -sb * 1.08); g.closePath();
      g.fill(); g.stroke();
      g.fillStyle = civD; g.fillRect(0, -sb * 1.52, sb * 0.72, sb * 0.1);
    });
  });
}

/** Merchant ship (white sail). Origin at the waterline centre. */
export function shipSprite(cache, s, dpr, rgb = null) {
  const sb = Math.max(3, Math.round(s));
  const key = `M${sb}|${dpr}|${rgb ? rgb.join(',') : ''}`;
  return cache.get(key, () => sprite(sb * 2.4, sb * 2.4, sb * 1.2, sb * 1.6, dpr, (g) => {
    const lw = Math.max(0.7, sb * 0.1);
    g.strokeStyle = INKC; g.lineWidth = lw;
    g.fillStyle = '#7a5634';
    g.beginPath(); g.moveTo(-sb * 0.75, -sb * 0.1); g.lineTo(sb * 0.8, -sb * 0.1); g.lineTo(sb * 0.5, sb * 0.25); g.lineTo(-sb * 0.55, sb * 0.25); g.closePath(); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(0, -sb * 0.1); g.lineTo(0, -sb * 1.2); g.stroke();
    g.fillStyle = '#f2ead6';
    g.beginPath(); g.moveTo(sb * 0.05, -sb * 1.15); g.quadraticCurveTo(sb * 0.75, -sb * 0.7, sb * 0.05, -sb * 0.2); g.closePath(); g.fill(); g.stroke();
    if (rgb) { g.fillStyle = css(rgb); g.fillRect(0, -sb * 1.32, sb * 0.4, sb * 0.16); }
  }));
}

// ---------------------------------------------------------------------------
// Detail layer glyphs (close zoom): trees, peaks, hills, dunes, reeds, grass.

export const TREE_KINDS = ['conifer', 'broadleaf', 'rain', 'jungle', 'acacia', 'shrub', 'palm', 'bare'];

/** Quantise a sprite size (px) onto a log grid of `steps` per octave, so a level's set of sizes stays small and fixed. */
export function qpx(v, steps = 6) {
  if (!(v > 0)) return 1;
  return Math.pow(2, Math.round(Math.log2(v) * steps) / steps);
}

// crown colours per kind × season (0 summer, 1 autumn, 2 winter) and a little variety per variant
const CROWN = {
  broadleaf: [['#5b8a48', '#4f7f42', '#669350', '#58863f'], ['#c07a36', '#b0602e', '#c99a3e', '#a8703a'], null],
  rain: [['#2f6a4c', '#2a6046', '#356f50', '#2c6548'], ['#3a6a48', '#40704a', '#36664a', '#3c6c4a'], ['#3a5e4c', '#3a5e4c', '#3a5e4c', '#3a5e4c']],
  jungle: [['#2a6436', '#327440', '#2e6a3a', '#286034'], ['#2a6436', '#327440', '#2e6a3a', '#286034'], ['#2a6436', '#327440', '#2e6a3a', '#286034']],
};

/**
 * Tree sprite. season: 0 summer, 1 autumn, 2 winter (bare / snowy). Origin at the trunk foot.
 * Larger sprites (≥ 9 px) get lobed crowns, a lit side and a soft ground shadow to the
 * south-east; variant (0..3) varies the crown's hue a little so stands do not look stamped.
 */
export function treeSprite(cache, kind, s, dpr, season = 0, snowy = false, variant = 0) {
  const sb = Math.max(3, Math.round(s * 2) / 2);
  const vr = variant & 3;
  const key = `T${kind}|${sb}|${dpr}|${season}|${snowy ? 1 : 0}|${vr}`;
  return cache.get(key, () => sprite(sb * 2.0, sb * 2.0, sb * 0.8, sb * 1.8, dpr, (g) => {
    const big = sb >= 14;
    const lw = Math.max(0.6, sb * 0.07);
    const ink = 'rgba(36,40,26,0.85)';
    g.strokeStyle = ink; g.lineWidth = lw;
    if (big && kind !== 'bare') {
      g.fillStyle = 'rgba(30,26,16,0.2)';
      g.beginPath(); g.ellipse(sb * 0.32, -sb * 0.02, sb * (kind === 'shrub' ? 0.42 : 0.5), sb * 0.14, 0, 0, Math.PI * 2); g.fill();
    }
    const trunk = (h = 0.45) => { g.strokeStyle = 'rgba(60,44,30,0.9)'; g.lineWidth = Math.max(lw, sb * 0.09); g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -sb * h); g.stroke(); g.strokeStyle = ink; g.lineWidth = lw; };
    const fill = (c) => { g.fillStyle = c; g.fill(); g.stroke(); };
    const lobes = (cx, cy, r, col) => {
      if (!big) { g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); fill(col); return; }
      // a crown of overlapping lobes, darker below, lit toward the north-west
      g.beginPath();
      g.arc(cx - r * 0.42, cy + r * 0.18, r * 0.62, 0, Math.PI * 2);
      g.arc(cx + r * 0.44, cy + r * 0.14, r * 0.6, 0, Math.PI * 2);
      g.arc(cx, cy - r * 0.32, r * 0.68, 0, Math.PI * 2);
      g.fillStyle = col; g.fill();
      g.save(); g.clip();
      g.fillStyle = 'rgba(16,24,10,0.22)'; g.beginPath(); g.ellipse(cx + r * 0.3, cy + r * 0.55, r * 1.1, r * 0.55, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,252,220,0.2)'; g.beginPath(); g.arc(cx - r * 0.3, cy - r * 0.45, r * 0.42, 0, Math.PI * 2); g.fill();
      g.restore();
      g.lineWidth = lw * 0.9; g.strokeStyle = 'rgba(36,40,26,0.7)';
      g.beginPath();
      g.arc(cx - r * 0.42, cy + r * 0.18, r * 0.62, Math.PI * 0.55, Math.PI * 1.45);
      g.moveTo(cx + r * 0.44 + r * 0.6 * Math.cos(-0.5), cy + r * 0.14 + r * 0.6 * Math.sin(-0.5));
      g.arc(cx + r * 0.44, cy + r * 0.14, r * 0.6, -0.5, Math.PI * 0.55);
      g.moveTo(cx + r * 0.68 * Math.cos(Math.PI * 1.1), cy - r * 0.32 + r * 0.68 * Math.sin(Math.PI * 1.1));
      g.arc(cx, cy - r * 0.32, r * 0.68, Math.PI * 1.1, Math.PI * 1.95);
      g.stroke();
      g.strokeStyle = ink; g.lineWidth = lw;
    };
    switch (kind) {
      case 'conifer': {
        trunk(0.35);
        const col = season === 2 && snowy ? '#5d7468' : ['#3f6650', '#3a6049', '#456c55', '#3c634c'][vr];
        if (big) {
          // three tiers of boughs
          for (let t = 0; t < 3; t++) {
            const top = -sb * (1.62 - t * 0.36), base = -sb * (0.82 - t * 0.24), hw = sb * (0.26 + t * 0.09);
            g.beginPath(); g.moveTo(0, top); g.lineTo(hw, base); g.lineTo(-hw, base); g.closePath(); fill(col);
            g.fillStyle = 'rgba(16,24,10,0.2)'; g.beginPath(); g.moveTo(0, top); g.lineTo(hw, base); g.lineTo(hw * 0.1, base); g.closePath(); g.fill();
          }
        } else {
          g.beginPath(); g.moveTo(0, -sb * 1.6); g.lineTo(sb * 0.42, -sb * 0.3); g.lineTo(-sb * 0.42, -sb * 0.3); g.closePath();
          fill(col);
        }
        if (snowy) { g.fillStyle = '#f4f6f8'; g.beginPath(); g.moveTo(0, -sb * 1.6); g.lineTo(sb * 0.2, -sb * 1.0); g.lineTo(-sb * 0.2, -sb * 1.0); g.closePath(); g.fill(); }
        break;
      }
      case 'broadleaf': case 'rain': {
        trunk();
        if (season === 2 && kind === 'broadleaf') {
          g.strokeStyle = 'rgba(70,54,40,0.9)';
          g.beginPath(); g.moveTo(0, -sb * 0.45); g.lineTo(-sb * 0.35, -sb * 1.2); g.moveTo(0, -sb * 0.6); g.lineTo(sb * 0.35, -sb * 1.25); g.moveTo(0, -sb * 0.5); g.lineTo(0, -sb * 1.35);
          if (big) { g.moveTo(-sb * 0.2, -sb * 0.9); g.lineTo(-sb * 0.45, -sb * 1.0); g.moveTo(sb * 0.2, -sb * 0.95); g.lineTo(sb * 0.46, -sb * 1.05); }
          g.stroke();
          if (snowy) { g.fillStyle = 'rgba(244,246,248,0.9)'; g.beginPath(); g.arc(0, -sb * 1.2, sb * 0.3, Math.PI, 0); g.fill(); }
          break;
        }
        const pal = CROWN[kind][season] || CROWN[kind][0];
        lobes(0, -sb * 0.98, sb * 0.5, pal[vr]);
        if (!big) { g.fillStyle = 'rgba(255,255,230,0.18)'; g.beginPath(); g.arc(-sb * 0.15, -sb * 1.1, sb * 0.22, 0, Math.PI * 2); g.fill(); }
        break;
      }
      case 'jungle': {
        trunk();
        const pal = CROWN.jungle[0];
        if (big) { lobes(-sb * 0.18, -sb * 0.95, sb * 0.44, pal[vr]); lobes(sb * 0.24, -sb * 1.08, sb * 0.42, pal[(vr + 1) & 3]); }
        else {
          g.beginPath(); g.arc(-sb * 0.2, -sb * 0.95, sb * 0.42, 0, Math.PI * 2); fill(pal[vr]);
          g.beginPath(); g.arc(sb * 0.22, -sb * 1.05, sb * 0.42, 0, Math.PI * 2); fill(pal[(vr + 1) & 3]);
        }
        break;
      }
      case 'acacia': {
        g.strokeStyle = 'rgba(70,52,34,0.9)'; g.lineWidth = Math.max(lw, sb * 0.08);
        g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -sb * 0.8); g.lineTo(-sb * 0.3, -sb * 1.05); g.moveTo(0, -sb * 0.8); g.lineTo(sb * 0.3, -sb * 1.05); g.stroke();
        g.strokeStyle = ink; g.lineWidth = lw;
        g.beginPath(); g.ellipse(0, -sb * 1.12, sb * 0.7, sb * 0.2, 0, 0, Math.PI * 2); fill(season === 1 ? '#a39a4c' : ['#7d8a44', '#768440', '#84904a', '#7a8642'][vr]);
        if (big) { g.fillStyle = 'rgba(255,250,210,0.18)'; g.beginPath(); g.ellipse(-sb * 0.16, -sb * 1.2, sb * 0.4, sb * 0.08, 0, 0, Math.PI * 2); g.fill(); }
        break;
      }
      case 'shrub': {
        const col = season === 1 ? '#a58c52' : ['#7c8452', '#76804c', '#828a58', '#7a8250'][vr];
        if (big) {
          g.beginPath();
          g.ellipse(-sb * 0.22, -sb * 0.24, sb * 0.26, sb * 0.22, 0, 0, Math.PI * 2);
          g.ellipse(sb * 0.2, -sb * 0.22, sb * 0.24, sb * 0.21, 0, 0, Math.PI * 2);
          g.ellipse(0, -sb * 0.4, sb * 0.26, sb * 0.24, 0, 0, Math.PI * 2);
          g.fillStyle = col; g.fill();
          g.strokeStyle = 'rgba(36,40,26,0.6)'; g.stroke();
          g.fillStyle = 'rgba(255,250,210,0.2)'; g.beginPath(); g.arc(-sb * 0.08, -sb * 0.48, sb * 0.1, 0, Math.PI * 2); g.fill();
        } else { g.beginPath(); g.ellipse(0, -sb * 0.3, sb * 0.45, sb * 0.3, 0, 0, Math.PI * 2); fill(col); }
        break;
      }
      case 'palm': {
        g.strokeStyle = 'rgba(80,60,40,0.9)'; g.lineWidth = Math.max(lw, sb * 0.08);
        g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(sb * 0.15, -sb * 0.6, 0, -sb * 1.2); g.stroke();
        g.strokeStyle = ['#3d7a3c', '#367236', '#438240', '#3a763a'][vr]; g.lineWidth = lw * 1.6;
        for (let k = 0; k < 5; k++) { const a = -Math.PI / 2 + (k - 2) * 0.62; g.beginPath(); g.moveTo(0, -sb * 1.2); g.quadraticCurveTo(Math.cos(a) * sb * 0.4, -sb * 1.2 + Math.sin(a) * sb * 0.4 - sb * 0.1, Math.cos(a) * sb * 0.6, -sb * 1.2 + Math.sin(a) * sb * 0.5 + sb * 0.2); g.stroke(); }
        break;
      }
      default: { // bare snag (burned or dead wood)
        g.strokeStyle = 'rgba(58,44,34,0.92)'; g.lineWidth = Math.max(lw, sb * 0.08);
        g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -sb * 1.1); g.moveTo(0, -sb * 0.7); g.lineTo(sb * 0.3, -sb * 1.0); g.moveTo(0, -sb * 0.55); g.lineTo(-sb * 0.24, -sb * 0.78); g.stroke();
      }
    }
  }));
}

/** Mountain peak glyph: w = half-width in CSS px, h = height. snow: 0..1 cap. */
export function peakSprite(cache, w, h, dpr, snow, variant) {
  const wb = Math.max(3, Math.round(w)), hb = Math.max(3, Math.round(h));
  const sn = snow > 0.66 ? 2 : snow > 0.25 ? 1 : 0;
  const key = `P${wb}|${hb}|${dpr}|${sn}|${variant & 3}`;
  return cache.get(key, () => sprite(wb * 2 + 4, hb + 6, wb + 2, hb + 3, dpr, (g) => {
    const lw = Math.max(0.7, wb * 0.08);
    const skew = ((variant & 3) - 1.5) * 0.12 * wb;
    const apx = skew, apy = -hb;
    // lit west face
    g.fillStyle = '#d9cdb2';
    g.beginPath(); g.moveTo(-wb, 0); g.lineTo(apx, apy); g.lineTo(apx + wb * 0.1, 0); g.closePath(); g.fill();
    // shaded east face
    g.fillStyle = '#9c8c74';
    g.beginPath(); g.moveTo(apx, apy); g.lineTo(wb, 0); g.lineTo(apx + wb * 0.1, 0); g.closePath(); g.fill();
    if (sn) {
      const k = sn === 2 ? 0.55 : 0.3;
      g.fillStyle = '#f6f7f9';
      g.beginPath(); g.moveTo(apx, apy); g.lineTo(apx - wb * k, apy + hb * k); g.lineTo(apx - wb * k * 0.3, apy + hb * k * 0.8); g.lineTo(apx + wb * 0.05, apy + hb * k * 1.05); g.lineTo(apx + wb * k * 0.9, apy + hb * k); g.closePath(); g.fill();
    }
    // hachures on the shaded face
    g.strokeStyle = 'rgba(60,46,32,0.5)'; g.lineWidth = lw * 0.7;
    for (let k = 1; k <= 3; k++) {
      const t = k / 4;
      g.beginPath(); g.moveTo(apx + (wb - apx) * t * 0.5, apy + hb * t * 0.5); g.lineTo(apx + (wb - apx) * t * 0.8, apy + hb * (t * 0.5 + 0.35)); g.stroke();
    }
    g.strokeStyle = 'rgba(44,34,26,0.9)'; g.lineWidth = lw;
    g.beginPath(); g.moveTo(-wb, 0); g.lineTo(apx, apy); g.lineTo(wb, 0); g.stroke();
  }));
}

/** Volcano cone. state: 0 dormant, 1 smoking, 2 erupting. Origin at base centre. */
export function volcanoSprite(cache, s, dpr, state) {
  const sb = Math.max(4, Math.round(s));
  const key = `V${sb}|${dpr}|${state}`;
  return cache.get(key, () => sprite(sb * 2.4, sb * 1.8, sb * 1.2, sb * 1.4, dpr, (g) => {
    const lw = Math.max(0.8, sb * 0.09);
    g.strokeStyle = INKC; g.lineWidth = lw;
    g.fillStyle = '#8a7462';
    g.beginPath(); g.moveTo(-sb, 0); g.lineTo(-sb * 0.25, -sb * 0.95); g.lineTo(sb * 0.25, -sb * 0.95); g.lineTo(sb, 0); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#5e4c40';
    g.beginPath(); g.moveTo(sb * 0.05, -sb * 0.95); g.lineTo(sb * 0.25, -sb * 0.95); g.lineTo(sb, 0); g.lineTo(sb * 0.3, 0); g.closePath(); g.fill();
    g.fillStyle = state === 2 ? '#ff7a2a' : '#3a2e28';
    g.beginPath(); g.ellipse(0, -sb * 0.95, sb * 0.25, sb * 0.08, 0, 0, Math.PI * 2); g.fill(); g.stroke();
    if (state === 2) {
      g.strokeStyle = '#ff6a20'; g.lineWidth = lw * 1.4;
      g.beginPath(); g.moveTo(-sb * 0.05, -sb * 0.9); g.quadraticCurveTo(-sb * 0.3, -sb * 0.5, -sb * 0.45, -sb * 0.05); g.stroke();
      g.beginPath(); g.moveTo(sb * 0.1, -sb * 0.9); g.quadraticCurveTo(sb * 0.35, -sb * 0.4, sb * 0.5, 0); g.stroke();
    }
  }));
}

/** Soft radial blob for smoke / glow particles. */
export function blobSprite(cache, rgb, r, dpr, hard = 0) {
  const rb = Math.max(2, Math.round(r));
  const key = `G${rgb.join(',')}|${rb}|${dpr}|${hard}`;
  return cache.get(key, () => sprite(rb * 2, rb * 2, rb, rb, dpr, (g) => {
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, rb);
    gr.addColorStop(0, css(rgb, 1));
    gr.addColorStop(hard ? 0.5 : 0.25, css(rgb, hard ? 0.8 : 0.5));
    gr.addColorStop(1, css(rgb, 0));
    g.fillStyle = gr; g.fillRect(-rb, -rb, rb * 2, rb * 2);
  }));
}

/** Cloud puff: a broad soft disc (full opacity to ~40 % of the radius, then easing out). */
export function puffSprite(cache, rgb, r, dpr) {
  const rb = Math.max(4, Math.round(r));
  const key = `F${rgb.join(',')}|${rb}|${dpr}`;
  return cache.get(key, () => sprite(rb * 2, rb * 2, rb, rb, dpr, (g) => {
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, rb);
    gr.addColorStop(0, css(rgb, 1));
    gr.addColorStop(0.4, css(rgb, 0.92));
    gr.addColorStop(0.7, css(rgb, 0.5));
    gr.addColorStop(1, css(rgb, 0));
    g.fillStyle = gr; g.fillRect(-rb, -rb, rb * 2, rb * 2);
  }));
}

// ---------------------------------------------------------------------------
// Wonders: a side-view silhouette for each of the great works (origin at the base centre,
// about 2 s tall), shown standing by their city from the Region zoom, and inside a gold ring
// as a symbol from afar. Unknown kinds (a people's own wonders) get an obelisk.

const WONDER_INK = 'rgba(40,30,22,0.95)';
const STONE = '#ddd2b6', STONE_D = '#b8a988', BRONZE = '#b07a3e', GOLDC = '#e2b54c', GLASS = '#bcd6de';

/** g, s → draws the kind's silhouette. */
export const WONDER_GLYPHS = {
  stone_circle(g, s) {
    g.fillStyle = '#a8a294';
    for (let k = -2; k <= 2; k++) { const h = s * (k % 2 ? 0.75 : 0.9); g.beginPath(); g.rect(k * s * 0.42 - s * 0.12, -h, s * 0.24, h); g.fill(); g.stroke(); }
    g.beginPath(); g.rect(-s * 0.56, -s * 1.02, s * 0.66, s * 0.14); g.fill(); g.stroke();
    g.beginPath(); g.rect(s * 0.28, -s * 1.02, s * 0.6, s * 0.14); g.fill(); g.stroke();
  },
  ziggurat(g, s) {
    for (let q = 0; q < 4; q++) { const k = 1 - q * 0.22; g.fillStyle = q % 2 ? STONE_D : '#c9a46e'; g.beginPath(); g.rect(-s * k, -s * 0.38 * (q + 1), s * 2 * k, s * 0.38); g.fill(); g.stroke(); }
    g.fillStyle = GOLDC; g.beginPath(); g.rect(-s * 0.14, -s * 1.75, s * 0.28, s * 0.24); g.fill(); g.stroke();
    g.strokeStyle = 'rgba(70,50,30,0.7)'; g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -s * 1.5); g.stroke(); g.strokeStyle = WONDER_INK;
  },
  pyramid(g, s) {
    g.fillStyle = 'rgba(30,22,14,0.25)'; g.beginPath(); g.moveTo(s * 0.2, 0); g.lineTo(s * 2.2, 0); g.lineTo(0, -s * 1.5); g.closePath(); g.fill();
    g.fillStyle = '#e6d5a6'; g.beginPath(); g.moveTo(-s * 1.15, 0); g.lineTo(0, -s * 1.6); g.lineTo(s * 0.25, 0); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#c4ae7c'; g.beginPath(); g.moveTo(s * 0.25, 0); g.lineTo(0, -s * 1.6); g.lineTo(s * 1.15, 0); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = GOLDC; g.beginPath(); g.moveTo(-s * 0.12, -s * 1.43); g.lineTo(0, -s * 1.6); g.lineTo(s * 0.12, -s * 1.43); g.closePath(); g.fill();
  },
  colossus(g, s) {
    g.fillStyle = STONE_D; g.beginPath(); g.rect(-s * 0.5, -s * 0.3, s, s * 0.3); g.fill(); g.stroke();
    g.fillStyle = BRONZE;
    g.beginPath(); g.moveTo(-s * 0.25, -s * 0.3); g.lineTo(-s * 0.15, -s * 1.1); g.lineTo(s * 0.15, -s * 1.1); g.lineTo(s * 0.25, -s * 0.3); g.closePath(); g.fill(); g.stroke();
    g.beginPath(); g.arc(0, -s * 1.28, s * 0.16, 0, Math.PI * 2); g.fill(); g.stroke();
    g.lineWidth *= 1.6; g.strokeStyle = BRONZE; g.beginPath(); g.moveTo(s * 0.12, -s * 1.05); g.lineTo(s * 0.45, -s * 1.75); g.stroke(); g.lineWidth /= 1.6; g.strokeStyle = WONDER_INK;
    g.fillStyle = '#ffcf6a'; g.beginPath(); g.arc(s * 0.47, -s * 1.85, s * 0.12, 0, Math.PI * 2); g.fill();
  },
  gardens(g, s) {
    for (let q = 0; q < 3; q++) { const k = 1 - q * 0.26; g.fillStyle = STONE; g.beginPath(); g.rect(-s * k, -s * 0.42 * (q + 1), s * 2 * k, s * 0.42); g.fill(); g.stroke(); g.fillStyle = '#5f9a4e'; g.beginPath(); g.ellipse(0, -s * 0.42 * (q + 1), s * k, s * 0.1, 0, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = '#4f8a42'; for (const x of [-0.6, 0.6, 0]) { g.beginPath(); g.arc(x * s, -s * (x ? 0.95 : 1.5), s * 0.18, 0, Math.PI * 2); g.fill(); }
  },
  great_library(g, s) {
    g.fillStyle = '#c9c3b2'; g.beginPath(); g.arc(0, -s * 0.95, s * 0.45, Math.PI, 0); g.fill(); g.stroke();
    g.fillStyle = STONE; g.beginPath(); g.rect(-s, -s * 0.9, s * 2, s * 0.9); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(-s * 1.08, -s * 0.9); g.lineTo(0, -s * 1.3); g.lineTo(s * 1.08, -s * 0.9); g.closePath(); g.fill(); g.stroke();
    g.strokeStyle = 'rgba(80,64,48,0.75)'; g.beginPath(); for (let k = -3; k <= 3; k++) { g.moveTo(k * s * 0.28, -s * 0.82); g.lineTo(k * s * 0.28, -s * 0.08); } g.stroke(); g.strokeStyle = WONDER_INK;
  },
  lighthouse(g, s) {
    g.fillStyle = STONE_D; g.beginPath(); g.rect(-s * 0.55, -s * 0.4, s * 1.1, s * 0.4); g.fill(); g.stroke();
    g.fillStyle = STONE; g.beginPath(); g.moveTo(-s * 0.36, -s * 0.4); g.lineTo(-s * 0.22, -s * 1.7); g.lineTo(s * 0.22, -s * 1.7); g.lineTo(s * 0.36, -s * 0.4); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#ffd36a'; g.beginPath(); g.rect(-s * 0.2, -s * 2.0, s * 0.4, s * 0.3); g.fill(); g.stroke();
    g.fillStyle = 'rgba(255,224,140,0.35)'; g.beginPath(); g.moveTo(0, -s * 1.85); g.lineTo(s * 1.4, -s * 2.15); g.lineTo(s * 1.4, -s * 1.6); g.closePath(); g.fill();
  },
  great_wall(g, s) {
    g.fillStyle = '#b9ac90';
    g.beginPath(); g.moveTo(-s * 1.2, 0); g.lineTo(-s * 1.2, -s * 0.6); g.lineTo(s * 1.2, -s * 0.8); g.lineTo(s * 1.2, 0); g.closePath(); g.fill(); g.stroke();
    for (const x of [-1.2, 0, 1.2]) { g.beginPath(); g.rect(x * s - s * 0.2, -s * (1.0 + x * 0.08), s * 0.4, s * (1.0 + x * 0.08)); g.fill(); g.stroke(); }
    g.beginPath(); for (let k = 0; k < 8; k++) { const x = -s * 1.2 + k * s * 0.3; g.rect(x, -s * (0.68 + k * 0.025) - s * 0.08, s * 0.14, s * 0.08); } g.fill();
  },
  colosseum(g, s) {
    g.fillStyle = '#d8c7a2'; g.beginPath(); g.moveTo(-s * 1.2, 0); g.lineTo(-s * 1.2, -s * 1.0); g.quadraticCurveTo(0, -s * 1.25, s * 1.2, -s * 1.0); g.lineTo(s * 1.2, 0); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = 'rgba(70,52,34,0.8)';
    for (let row = 0; row < 3; row++) for (let k = -4; k <= 4; k++) { g.beginPath(); g.arc(k * s * 0.26, -s * (0.18 + row * 0.32), s * 0.08, Math.PI, 0); g.lineTo(k * s * 0.26 + s * 0.08, -s * (0.06 + row * 0.32)); g.lineTo(k * s * 0.26 - s * 0.08, -s * (0.06 + row * 0.32)); g.closePath(); g.fill(); }
  },
  cathedral(g, s) {
    g.fillStyle = STONE; g.beginPath(); g.rect(-s * 0.7, -s * 1.0, s * 1.4, s); g.fill(); g.stroke();
    for (const x of [-0.7, 0.7]) { g.beginPath(); g.rect(x * s - s * 0.22, -s * 1.5, s * 0.44, s * 1.5); g.fill(); g.stroke(); g.fillStyle = STONE_D; g.beginPath(); g.moveTo(x * s - s * 0.24, -s * 1.5); g.lineTo(x * s, -s * 2.2); g.lineTo(x * s + s * 0.24, -s * 1.5); g.closePath(); g.fill(); g.stroke(); g.fillStyle = STONE; }
    g.fillStyle = '#7a8fb8'; g.beginPath(); g.arc(0, -s * 0.62, s * 0.2, 0, Math.PI * 2); g.fill(); g.stroke();
  },
  citadel(g, s) {
    g.fillStyle = '#b9b2a2'; g.beginPath(); g.rect(-s * 1.1, -s * 0.7, s * 2.2, s * 0.7); g.fill(); g.stroke();
    g.beginPath(); g.rect(-s * 0.45, -s * 1.45, s * 0.9, s * 1.45); g.fill(); g.stroke();
    for (const x of [-1.1, 1.1]) { g.beginPath(); g.rect(x * s - s * 0.2, -s * 1.0, s * 0.4, s); g.fill(); g.stroke(); }
    g.fillStyle = WONDER_INK; for (let k = -2; k <= 2; k++) g.fillRect(k * s * 0.18 - s * 0.05, -s * 1.55, s * 0.1, s * 0.1);
  },
  observatory(g, s) {
    g.fillStyle = STONE; g.beginPath(); g.rect(-s * 0.45, -s * 1.1, s * 0.9, s * 1.1); g.fill(); g.stroke();
    g.fillStyle = '#9fb3bd'; g.beginPath(); g.arc(0, -s * 1.1, s * 0.55, Math.PI, 0); g.closePath(); g.fill(); g.stroke();
    g.strokeStyle = 'rgba(40,40,50,0.9)'; g.beginPath(); g.moveTo(-s * 0.08, -s * 1.6); g.lineTo(s * 0.35, -s * 1.95); g.stroke(); g.strokeStyle = WONDER_INK;
  },
  grand_canal(g, s) {
    g.fillStyle = '#6a9ab8'; g.beginPath(); g.rect(-s * 1.2, -s * 0.3, s * 2.4, s * 0.3); g.fill();
    g.fillStyle = STONE; g.beginPath(); g.moveTo(-s * 1.2, -s * 0.3); g.lineTo(-s * 1.2, -s * 0.6); g.quadraticCurveTo(0, -s * 1.4, s * 1.2, -s * 0.6); g.lineTo(s * 1.2, -s * 0.3); g.quadraticCurveTo(0, -s * 0.95, -s * 1.2, -s * 0.3); g.fill(); g.stroke();
  },
  palace(g, s) {
    g.fillStyle = '#e4d8bc'; g.beginPath(); g.rect(-s * 1.25, -s * 0.75, s * 2.5, s * 0.75); g.fill(); g.stroke();
    g.beginPath(); g.rect(-s * 0.45, -s * 1.15, s * 0.9, s * 1.15); g.fill(); g.stroke();
    g.fillStyle = GOLDC; g.beginPath(); g.arc(0, -s * 1.15, s * 0.42, Math.PI, 0); g.fill(); g.stroke();
    g.fillStyle = 'rgba(80,64,48,0.6)'; for (let k = -5; k <= 5; k++) if (Math.abs(k) > 1) g.fillRect(k * s * 0.21 - s * 0.04, -s * 0.55, s * 0.08, s * 0.3);
  },
  opera(g, s) {
    g.fillStyle = '#e8dcc0'; g.beginPath(); g.rect(-s * 1.1, -s * 0.9, s * 2.2, s * 0.9); g.fill(); g.stroke();
    g.fillStyle = '#5e7f8c'; g.beginPath(); g.moveTo(-s * 1.1, -s * 0.9); g.quadraticCurveTo(0, -s * 1.65, s * 1.1, -s * 0.9); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = 'rgba(70,52,34,0.8)'; for (let k = -2; k <= 2; k++) { g.beginPath(); g.arc(k * s * 0.4, -s * 0.4, s * 0.12, Math.PI, 0); g.lineTo(k * s * 0.4 + s * 0.12, 0); g.lineTo(k * s * 0.4 - s * 0.12, 0); g.closePath(); g.fill(); }
  },
  exchange(g, s) {
    g.fillStyle = STONE; g.beginPath(); g.rect(-s, -s * 0.9, s * 2, s * 0.9); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(-s * 1.08, -s * 0.9); g.lineTo(0, -s * 1.35); g.lineTo(s * 1.08, -s * 0.9); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#fff6dc'; g.beginPath(); g.arc(0, -s * 1.08, s * 0.13, 0, Math.PI * 2); g.fill(); g.stroke();
    g.strokeStyle = 'rgba(80,64,48,0.75)'; g.beginPath(); for (let k = -3; k <= 3; k++) { g.moveTo(k * s * 0.28, -s * 0.82); g.lineTo(k * s * 0.28, -s * 0.06); } g.stroke(); g.strokeStyle = WONDER_INK;
  },
  crystal_palace(g, s) {
    g.fillStyle = GLASS; g.beginPath(); g.moveTo(-s * 1.3, 0); g.lineTo(-s * 1.3, -s * 0.6); g.quadraticCurveTo(0, -s * 1.7, s * 1.3, -s * 0.6); g.lineTo(s * 1.3, 0); g.closePath(); g.fill(); g.stroke();
    g.strokeStyle = 'rgba(70,90,100,0.6)'; g.beginPath(); for (let k = -5; k <= 5; k++) { g.moveTo(k * s * 0.24, 0); g.lineTo(k * s * 0.24, -s * (1.2 - Math.abs(k) * 0.1)); } g.moveTo(-s * 1.3, -s * 0.4); g.lineTo(s * 1.3, -s * 0.4); g.stroke(); g.strokeStyle = WONDER_INK;
  },
  iron_tower(g, s) {
    g.fillStyle = '#7a6656';
    g.beginPath(); g.moveTo(-s * 0.8, 0); g.quadraticCurveTo(-s * 0.15, -s * 0.8, -s * 0.07, -s * 2.3); g.lineTo(s * 0.07, -s * 2.3); g.quadraticCurveTo(s * 0.15, -s * 0.8, s * 0.8, 0); g.lineTo(s * 0.45, 0); g.quadraticCurveTo(0, -s * 0.55, -s * 0.45, 0); g.closePath(); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(-s * 0.45, -s * 0.7); g.lineTo(s * 0.45, -s * 0.7); g.moveTo(-s * 0.22, -s * 1.4); g.lineTo(s * 0.22, -s * 1.4); g.stroke();
  },
  great_dam(g, s) {
    g.fillStyle = '#6a9ab8'; g.beginPath(); g.rect(-s * 1.3, -s * 1.15, s * 0.9, s * 0.25); g.fill();
    g.fillStyle = '#c7c3ba'; g.beginPath(); g.moveTo(-s * 1.3, 0); g.lineTo(-s * 0.4, -s * 1.2); g.lineTo(s * 1.3, -s * 1.2); g.lineTo(s * 1.3, 0); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = 'rgba(220,240,250,0.85)'; for (let k = 0; k < 3; k++) g.fillRect(s * (0.0 + k * 0.4), -s * 0.9, s * 0.12, s * 0.9);
  },
  skyspire(g, s) {
    g.fillStyle = '#a9c0cc'; g.beginPath(); g.moveTo(-s * 0.45, 0); g.lineTo(-s * 0.25, -s * 2.0); g.lineTo(s * 0.25, -s * 2.0); g.lineTo(s * 0.45, 0); g.closePath(); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(0, -s * 2.0); g.lineTo(0, -s * 2.6); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.6)'; g.beginPath(); for (let k = 1; k < 8; k++) { g.moveTo(-s * (0.45 - k * 0.025), -k * s * 0.25); g.lineTo(s * (0.45 - k * 0.025), -k * s * 0.25); } g.stroke(); g.strokeStyle = WONDER_INK;
  },
  world_archive(g, s) {
    g.fillStyle = '#d6d6d0'; g.beginPath(); g.rect(-s * 1.1, -s * 0.8, s * 2.2, s * 0.8); g.fill(); g.stroke();
    g.fillStyle = '#8fa6ae'; g.beginPath(); g.arc(0, -s * 0.8, s * 0.6, Math.PI, 0); g.fill(); g.stroke();
    g.fillStyle = 'rgba(60,70,80,0.7)'; for (let k = -4; k <= 4; k++) g.fillRect(k * s * 0.24 - s * 0.05, -s * 0.6, s * 0.1, s * 0.45);
  },
  seed_vault(g, s) {
    g.fillStyle = '#e8eef2'; g.beginPath(); g.moveTo(-s * 1.4, 0); g.lineTo(-s * 0.3, -s * 1.3); g.lineTo(s * 1.4, 0); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#5a6a78'; g.beginPath(); g.moveTo(-s * 0.2, 0); g.lineTo(-s * 0.2, -s * 0.55); g.lineTo(s * 0.25, -s * 0.75); g.lineTo(s * 0.25, 0); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#7fd0e0'; g.fillRect(-s * 0.1, -s * 0.5, s * 0.25, s * 0.12);
  },
  obelisk(g, s) {
    g.fillStyle = STONE_D; g.beginPath(); g.rect(-s * 0.45, -s * 0.25, s * 0.9, s * 0.25); g.fill(); g.stroke();
    g.fillStyle = STONE; g.beginPath(); g.moveTo(-s * 0.22, -s * 0.25); g.lineTo(-s * 0.14, -s * 1.8); g.lineTo(0, -s * 2.05); g.lineTo(s * 0.14, -s * 1.8); g.lineTo(s * 0.22, -s * 0.25); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = GOLDC; g.beginPath(); g.moveTo(-s * 0.14, -s * 1.8); g.lineTo(0, -s * 2.05); g.lineTo(s * 0.14, -s * 1.8); g.closePath(); g.fill();
  },
};

function wonderRubble(g, s) {
  g.fillStyle = '#b4a88e';
  const blocks = [[-1.0, 0.0, 0.5, 0.35], [-0.4, -0.05, 0.6, 0.45], [0.3, 0, 0.55, 0.3], [0.85, -0.02, 0.35, 0.25], [-0.2, -0.45, 0.35, 0.3], [0.1, -0.35, 0.25, 0.65], [-0.75, -0.3, 0.2, 0.55]];
  for (const [x, y, w, h] of blocks) { g.beginPath(); g.rect(x * s, (y - h) * s, w * s, h * s); g.fill(); g.stroke(); }
  g.strokeStyle = 'rgba(80,110,60,0.8)'; g.beginPath(); g.moveTo(-s * 1.1, 0); g.lineTo(s * 1.2, 0); g.stroke();
}

/**
 * A wonder's sprite. mode: 'pic' (silhouette, s = half-width in CSS px, origin at its foot)
 * or 'sym' (a gold ring holding a small silhouette; s = ring radius, origin at the centre).
 * ruined: rubble instead of the work.
 */
export function wonderSprite(cache, kind, s, dpr, mode = 'pic', ruined = false) {
  const sb = Math.max(3, qpx(s, 6));
  const key = `W${kind}|${sb.toFixed(2)}|${mode}|${ruined ? 1 : 0}|${dpr}`;
  return cache.get(key, () => {
    const fn = ruined ? wonderRubble : WONDER_GLYPHS[kind] || WONDER_GLYPHS.obelisk;
    let sp;
    if (mode === 'sym') {
      const R = sb;
      sp = sprite(R * 2 + 4, R * 2 + 4, R + 2, R + 2, dpr, (g) => {
        g.fillStyle = 'rgba(250,240,214,0.95)'; g.strokeStyle = GOLDC; g.lineWidth = Math.max(1.2, R * 0.16);
        g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.fill(); g.stroke();
        g.strokeStyle = 'rgba(60,40,20,0.85)'; g.lineWidth = Math.max(0.6, R * 0.06);
        g.beginPath(); g.arc(0, 0, R + Math.max(0.8, R * 0.1), 0, Math.PI * 2); g.stroke();
        g.save(); g.translate(0, R * 0.5); g.strokeStyle = WONDER_INK; g.lineWidth = Math.max(0.5, R * 0.05);
        fn(g, R * 0.42); g.restore();
      });
    } else {
      const S = sb;
      sp = sprite(S * 3.2, S * 3.0, S * 1.6, S * 2.75, dpr, (g) => {
        g.strokeStyle = WONDER_INK; g.lineWidth = Math.max(0.8, S * 0.06);
        g.fillStyle = 'rgba(30,22,14,0.2)'; g.beginPath(); g.ellipse(S * 0.2, 0, S * 1.3, S * 0.2, 0, 0, Math.PI * 2); g.fill();
        fn(g, S);
      });
    }
    sp.s = sb;
    return sp;
  });
}
