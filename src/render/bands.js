// Roaming powers on the map — owner WP2 (src/sim/bands). Registered through ./layers.js:
//   underIcons  raid arrows of the last two years (in the 'monsters' map mode, or for the
//               selected band), lairs from z ≥ 7 (cave mouth, bones once slain, a gold glint
//               over a hoard, smoke when a dragon sleeps), hunt trails
//   units       a glyph per band (BAND_KINDS): campfire and ragged pennant for outlaws, black
//               sail for pirates, a quartered company banner, a horse-tail standard with dust;
//               beasts as cached two-frame sprites (wings, tentacles, a breathing coil for a
//               sleeping dragon); crossed spears on hunt armies; hit boxes of kind 'band'
//   labels      names of bands at z ≥ 5 (dragons and hosts first)
//   hud         the selected band: a turning ring, its route and its raids
// and the effect types raid, dragonfire, slay and summon. Sprites live in the renderer's
// SpriteCache under 'WP2|' keys. Never imports ./renderer.js (see ./plugins.js).

import { registerLayer, registerFxType } from './layers.js';
import { BAND_KINDS, DAYS_PER_YEAR } from '../core/constants.js';

// ---------------------------------------------------------------------------
// Colours

const INK = 'rgb(44,34,26)';
const PARCH = 'rgb(240,230,206)';
const GOLD = '#e2b54c';
const FAMILY_TONE = { outlaw: [178, 70, 46], host: [176, 118, 54], beast: [140, 98, 196], spirit: [128, 160, 128] };
const DRAGON_TONE = { fire: [176, 46, 34], frost: [176, 206, 226], green: [70, 132, 72], sea: [52, 120, 136] };
const BEAST_TONE = { wyvern: [96, 112, 58], troll: [74, 96, 70], giant: [118, 104, 92], treant: [70, 110, 48], kraken: [104, 72, 128], behemoth: [116, 84, 56], undead: [150, 168, 150] };
const css = (c, a = 1) => (a >= 1 ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.max(0, a).toFixed(3)})`);
const dark = (c, k) => [c[0] * (1 - k), c[1] * (1 - k), c[2] * (1 - k)];
const light = (c, k) => [c[0] + (255 - c[0]) * k, c[1] + (255 - c[1]) * k, c[2] + (255 - c[2]) * k];
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function hashHue(str) {
  let h = 2166136261;
  for (let k = 0; k < str.length; k++) { h ^= str.charCodeAt(k); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 360);
}
function hsl(h, s, l) {
  h /= 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => { if (t < 0) t += 1; if (t > 1) t -= 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

// ---------------------------------------------------------------------------
// Sprites (CSS-px size s, origin at the glyph's foot; cached by kind, size, frame, tone, dpr)

function canvasOf(w, h) {
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return c; }
  return new OffscreenCanvas(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)));
}
function sprite(w, h, ox, oy, dpr, draw) {
  const c = canvasOf(w * dpr, h * dpr);
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, ox * dpr, oy * dpr);
  g.lineJoin = 'round'; g.lineCap = 'round';
  draw(g);
  return { canvas: c, w, h, ox, oy };
}
const FALLBACK = new Map();
function cached(r, key, make) {
  if (r.sprites && typeof r.sprites.get === 'function') return r.sprites.get('WP2|' + key, make);
  let v = FALLBACK.get(key);
  if (!v) { v = make(); FALLBACK.set(key, v); if (FALLBACK.size > 400) FALLBACK.delete(FALLBACK.keys().next().value); }
  return v;
}

function shadow(g, s, k = 0.5) {
  g.fillStyle = 'rgba(20,14,8,0.28)';
  g.beginPath(); g.ellipse(0, 0, s * k, s * 0.15, 0, 0, Math.PI * 2); g.fill();
}

const DRAW = {
  campfire(g, s, f) {
    const lw = Math.max(0.8, s * 0.08);
    shadow(g, s, 0.55);
    // crossed sticks
    g.strokeStyle = 'rgb(92,62,36)'; g.lineWidth = lw * 1.3;
    g.beginPath(); g.moveTo(-s * 0.4, s * 0.05); g.lineTo(s * 0.35, -s * 0.2); g.moveTo(s * 0.4, s * 0.05); g.lineTo(-s * 0.35, -s * 0.2); g.stroke();
    // flame (two frames)
    const fl = f ? 1.08 : 0.94;
    g.fillStyle = 'rgb(232,112,40)'; g.strokeStyle = 'rgba(90,30,10,0.85)'; g.lineWidth = lw * 0.7;
    g.beginPath(); g.moveTo(-s * 0.26, -s * 0.12); g.quadraticCurveTo(-s * 0.3, -s * 0.6 * fl, 0, -s * 0.95 * fl); g.quadraticCurveTo(s * 0.32, -s * 0.55 * fl, s * 0.26, -s * 0.12); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = 'rgb(250,206,96)';
    g.beginPath(); g.moveTo(-s * 0.1, -s * 0.15); g.quadraticCurveTo(-s * 0.1, -s * 0.45 * fl, s * 0.02, -s * 0.6 * fl); g.quadraticCurveTo(s * 0.14, -s * 0.42 * fl, s * 0.1, -s * 0.15); g.closePath(); g.fill();
    // ragged pennant on a spear
    g.strokeStyle = INK; g.lineWidth = lw;
    g.beginPath(); g.moveTo(s * 0.62, s * 0.05); g.lineTo(s * 0.62, -s * 1.55); g.stroke();
    g.fillStyle = 'rgb(150,40,32)';
    g.beginPath(); g.moveTo(s * 0.62, -s * 1.5); g.lineTo(s * 1.35, -s * 1.38); g.lineTo(s * 1.08, -s * 1.22); g.lineTo(s * 1.3, -s * 1.06); g.lineTo(s * 0.62, -s * 1.0); g.closePath(); g.fill(); g.stroke();
  },
  blacksail(g, s, f) {
    const lw = Math.max(0.8, s * 0.08);
    const bob = f ? -s * 0.04 : 0;
    g.translate(0, bob);
    g.strokeStyle = INK; g.lineWidth = lw;
    g.fillStyle = 'rgb(84,56,34)';
    g.beginPath(); g.moveTo(-s * 0.95, -s * 0.2); g.lineTo(s * 0.95, -s * 0.2); g.lineTo(s * 0.62, s * 0.22); g.lineTo(-s * 0.7, s * 0.22); g.closePath(); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(0, -s * 0.2); g.lineTo(0, -s * 1.7); g.stroke();
    g.fillStyle = 'rgb(28,24,26)';
    g.beginPath(); g.moveTo(-s * 0.6, -s * 1.45); g.quadraticCurveTo(0, -s * 1.22, s * 0.6, -s * 1.45); g.lineTo(s * 0.55, -s * 0.48); g.quadraticCurveTo(0, -s * 0.32, -s * 0.55, -s * 0.48); g.closePath(); g.fill(); g.stroke();
    // a pale skull mark
    g.fillStyle = 'rgb(236,226,204)';
    g.beginPath(); g.arc(0, -s * 0.98, s * 0.16, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgb(28,24,26)';
    g.beginPath(); g.arc(-s * 0.06, -s * 1.0, s * 0.04, 0, Math.PI * 2); g.arc(s * 0.06, -s * 1.0, s * 0.04, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgb(150,40,32)';
    g.beginPath(); g.moveTo(0, -s * 1.7); g.lineTo(s * 0.4, -s * 1.62); g.lineTo(0, -s * 1.52); g.closePath(); g.fill();
  },
  banner(g, s, f, tone) {
    const lw = Math.max(0.8, s * 0.08);
    const c = tone || [150, 60, 60];
    shadow(g, s, 0.45);
    g.strokeStyle = INK; g.lineWidth = lw * 1.2;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -s * 2.0); g.stroke();
    g.fillStyle = GOLD; g.beginPath(); g.moveTo(-s * 0.12, -s * 2.0); g.lineTo(0, -s * 2.25); g.lineTo(s * 0.12, -s * 2.0); g.closePath(); g.fill();
    const wv = f ? s * 0.06 : -s * 0.04;
    // a square banner quartered in the company's colour and parchment
    g.lineWidth = lw;
    const x0 = 0, y0 = -s * 1.9, w = s * 1.05, h = s * 0.95;
    g.fillStyle = PARCH; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + w, y0 + wv); g.lineTo(x0 + w, y0 + h + wv); g.lineTo(x0, y0 + h); g.closePath(); g.fill();
    g.fillStyle = css(c);
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + w / 2, y0 + wv / 2); g.lineTo(x0 + w / 2, y0 + h / 2 + wv / 2); g.lineTo(x0, y0 + h / 2); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(x0 + w / 2, y0 + h / 2 + wv / 2); g.lineTo(x0 + w, y0 + h / 2 + wv); g.lineTo(x0 + w, y0 + h + wv); g.lineTo(x0 + w / 2, y0 + h + wv / 2); g.closePath(); g.fill();
    g.strokeStyle = INK;
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + w, y0 + wv); g.lineTo(x0 + w, y0 + h + wv); g.lineTo(x0, y0 + h); g.closePath(); g.stroke();
  },
  horsetail(g, s, f) {
    const lw = Math.max(0.8, s * 0.08);
    // dust of many hooves
    g.fillStyle = 'rgba(176,150,110,0.35)';
    for (let k = 0; k < 4; k++) { g.beginPath(); g.arc(-s * 0.9 + k * s * 0.5, -s * 0.1 - (k & 1) * s * 0.12, s * (0.28 + 0.06 * ((k + (f ? 1 : 0)) % 2)), 0, Math.PI * 2); g.fill(); }
    g.strokeStyle = INK; g.lineWidth = lw * 1.2;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -s * 2.1); g.stroke();
    // crescent finial
    g.strokeStyle = GOLD; g.lineWidth = lw * 1.1;
    g.beginPath(); g.arc(0, -s * 2.25, s * 0.18, Math.PI * 0.15, Math.PI * 0.85, true); g.stroke();
    // a crossbar and three hanging tails, swinging between frames
    g.strokeStyle = INK; g.lineWidth = lw;
    g.beginPath(); g.moveTo(-s * 0.32, -s * 1.95); g.lineTo(s * 0.32, -s * 1.95); g.stroke();
    const sw = f ? s * 0.08 : -s * 0.06;
    for (const [ox, len, col] of [[-s * 0.28, 0.95, 'rgb(70,46,30)'], [0, 1.15, 'rgb(36,28,24)'], [s * 0.28, 0.95, 'rgb(120,84,50)']]) {
      g.strokeStyle = col; g.lineWidth = lw * 2.1;
      g.beginPath(); g.moveTo(ox, -s * 1.95); g.quadraticCurveTo(ox + sw, -s * (1.95 - len * 0.5), ox + sw * 1.6, -s * (1.95 - len)); g.stroke();
    }
  },
  wagons(g, s) {
    const lw = Math.max(0.8, s * 0.08);
    shadow(g, s, 0.7);
    g.strokeStyle = INK; g.lineWidth = lw; g.fillStyle = PARCH;
    g.beginPath(); g.moveTo(-s * 0.7, -s * 0.3); g.quadraticCurveTo(0, -s * 1.2, s * 0.7, -s * 0.3); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = 'rgb(110,80,50)'; g.fillRect(-s * 0.8, -s * 0.3, s * 1.6, s * 0.18); g.strokeRect(-s * 0.8, -s * 0.3, s * 1.6, s * 0.18);
    g.beginPath(); g.arc(-s * 0.45, -s * 0.05, s * 0.16, 0, Math.PI * 2); g.arc(s * 0.45, -s * 0.05, s * 0.16, 0, Math.PI * 2); g.stroke();
  },
  dragon(g, s, f, tone) {
    const c = tone || DRAGON_TONE.fire;
    const lw = Math.max(0.9, s * 0.07);
    g.strokeStyle = INK; g.lineWidth = lw;
    // the far wing
    const up = f ? -1 : 0.35;
    g.fillStyle = css(dark(c, 0.35));
    g.beginPath(); g.moveTo(-s * 0.1, -s * 0.9); g.quadraticCurveTo(-s * 0.4, -s * (0.9 + 0.9 * up), -s * 1.1, -s * (0.9 + 1.1 * up)); g.lineTo(-s * 0.7, -s * (0.85 + 0.35 * up)); g.lineTo(-s * 0.9, -s * (0.75 + 0.2 * up)); g.lineTo(-s * 0.35, -s * 0.72); g.closePath(); g.fill(); g.stroke();
    // body, neck, head, tail
    g.fillStyle = css(c);
    g.beginPath();
    g.moveTo(-s * 1.3, -s * 0.55);
    g.quadraticCurveTo(-s * 0.8, -s * 0.95, -s * 0.2, -s * 0.85);
    g.quadraticCurveTo(s * 0.35, -s * 0.85, s * 0.6, -s * 1.15);
    g.quadraticCurveTo(s * 0.8, -s * 1.45, s * 1.15, -s * 1.38);
    g.lineTo(s * 1.32, -s * 1.22); g.lineTo(s * 1.05, -s * 1.15);
    g.quadraticCurveTo(s * 0.8, -s * 1.05, s * 0.62, -s * 0.78);
    g.quadraticCurveTo(s * 0.3, -s * 0.5, -s * 0.25, -s * 0.55);
    g.quadraticCurveTo(-s * 0.8, -s * 0.6, -s * 1.3, -s * 0.55);
    g.closePath(); g.fill(); g.stroke();
    // belly scales
    g.strokeStyle = css(light(c, 0.45), 0.8); g.lineWidth = lw * 0.7;
    g.beginPath(); g.moveTo(-s * 0.6, -s * 0.6); g.quadraticCurveTo(0, -s * 0.52, s * 0.5, -s * 0.85); g.stroke();
    // eye and horn
    g.fillStyle = 'rgb(250,214,90)'; g.beginPath(); g.arc(s * 1.03, -s * 1.3, s * 0.05, 0, Math.PI * 2); g.fill();
    g.strokeStyle = INK; g.lineWidth = lw;
    g.beginPath(); g.moveTo(s * 0.92, -s * 1.38); g.lineTo(s * 0.8, -s * 1.58); g.stroke();
    // the near wing
    g.fillStyle = css(c);
    g.beginPath(); g.moveTo(s * 0.05, -s * 0.85); g.quadraticCurveTo(s * 0.0, -s * (1.0 + 1.0 * up), -s * 0.55, -s * (1.0 + 1.35 * up)); g.lineTo(-s * 0.3, -s * (0.95 + 0.5 * up)); g.lineTo(-s * 0.5, -s * (0.85 + 0.3 * up)); g.lineTo(-s * 0.05, -s * 0.72); g.closePath(); g.fill(); g.stroke();
  },
  dragonSleep(g, s, f, tone) {
    const c = tone || DRAGON_TONE.fire;
    const lw = Math.max(0.9, s * 0.07);
    const br = f ? 1.04 : 1;
    shadow(g, s, 0.95);
    g.strokeStyle = INK; g.lineWidth = lw;
    g.fillStyle = css(c);
    // a coil: body ring, tail across, head tucked
    g.beginPath(); g.ellipse(0, -s * 0.38 * br, s * 0.9 * br, s * 0.42 * br, 0, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = css(dark(c, 0.3));
    g.beginPath(); g.ellipse(-s * 0.15, -s * 0.5 * br, s * 0.42, s * 0.18, -0.2, 0, Math.PI * 2); g.fill();
    g.fillStyle = css(c);
    g.beginPath(); g.moveTo(s * 0.55, -s * 0.5); g.quadraticCurveTo(s * 0.95, -s * 0.85, s * 1.15, -s * 0.55); g.quadraticCurveTo(s * 0.95, -s * 0.38, s * 0.62, -s * 0.36); g.closePath(); g.fill(); g.stroke();
    g.strokeStyle = INK;
    g.beginPath(); g.moveTo(s * 0.98, -s * 0.6); g.lineTo(s * 1.06, -s * 0.58); g.stroke();   // a closed eye
    // spines along the coiled back
    g.fillStyle = css(dark(c, 0.45));
    for (let k = 0; k < 5; k++) {
      const a = Math.PI * (1.12 + k * 0.17), bx = Math.cos(a) * s * 0.9 * br, by = -s * 0.38 * br + Math.sin(a) * s * 0.42 * br;
      g.beginPath(); g.moveTo(bx - s * 0.08, by + s * 0.02); g.lineTo(bx + Math.cos(a) * s * 0.06, by - s * 0.18); g.lineTo(bx + s * 0.08, by + s * 0.02); g.closePath(); g.fill();
    }
    // the tail wrapped around the front, ending in a spade
    g.strokeStyle = css(dark(c, 0.15)); g.lineWidth = lw * 2;
    g.beginPath(); g.moveTo(-s * 0.85, -s * 0.3); g.quadraticCurveTo(-s * 1.1, s * 0.12, -s * 0.2, s * 0.06); g.stroke();
    g.fillStyle = css(dark(c, 0.3)); g.strokeStyle = INK; g.lineWidth = lw;
    g.beginPath(); g.moveTo(-s * 0.22, s * 0.06); g.lineTo(-s * 0.02, -s * 0.06); g.lineTo(s * 0.02, s * 0.1); g.closePath(); g.fill(); g.stroke();
  },
  wyvern(g, s, f, tone) {
    const c = tone || BEAST_TONE.wyvern;
    const lw = Math.max(0.8, s * 0.08);
    const up = f ? -1 : 0.3;
    g.strokeStyle = INK; g.lineWidth = lw; g.fillStyle = css(c);
    g.beginPath(); g.moveTo(-s * 0.9, -s * 0.6); g.quadraticCurveTo(-s * 0.2, -s * 0.9, s * 0.45, -s * 0.95); g.lineTo(s * 0.8, -s * 1.05); g.lineTo(s * 0.62, -s * 0.85); g.quadraticCurveTo(0, -s * 0.55, -s * 0.9, -s * 0.6); g.closePath(); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(0, -s * 0.85); g.quadraticCurveTo(-s * 0.2, -s * (0.9 + 0.9 * up), -s * 0.8, -s * (1.0 + 1.0 * up)); g.lineTo(-s * 0.45, -s * (0.85 + 0.35 * up)); g.lineTo(-s * 0.2, -s * 0.72); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = 'rgb(240,210,90)'; g.beginPath(); g.arc(s * 0.62, -s * 0.98, s * 0.05, 0, Math.PI * 2); g.fill();
  },
  troll(g, s, f, tone) {
    const c = tone || BEAST_TONE.troll;
    const lw = Math.max(0.8, s * 0.08);
    shadow(g, s, 0.55);
    g.strokeStyle = INK; g.lineWidth = lw; g.fillStyle = css(c);
    const lean = f ? s * 0.05 : 0;
    // a hunched mound of a body, long arms, a club
    g.beginPath(); g.moveTo(-s * 0.45, 0); g.quadraticCurveTo(-s * 0.6, -s * 0.9, -s * 0.1 + lean, -s * 1.15); g.quadraticCurveTo(s * 0.45 + lean, -s * 1.2, s * 0.5, -s * 0.55); g.lineTo(s * 0.4, 0); g.closePath(); g.fill(); g.stroke();
    g.beginPath(); g.arc(s * 0.25 + lean, -s * 1.12, s * 0.2, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = 'rgb(230,190,90)'; g.beginPath(); g.arc(s * 0.32 + lean, -s * 1.15, s * 0.04, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgb(88,62,40)'; g.lineWidth = lw * 2;
    g.beginPath(); g.moveTo(s * 0.45, -s * 0.5); g.lineTo(s * 0.95, -s * (1.0 + (f ? 0.15 : 0))); g.stroke();
  },
  giant(g, s, f, tone) {
    const c = tone || BEAST_TONE.giant;
    const lw = Math.max(0.8, s * 0.08);
    shadow(g, s, 0.5);
    g.strokeStyle = INK; g.lineWidth = lw; g.fillStyle = css(c);
    const st = f ? s * 0.1 : -s * 0.05;
    g.beginPath(); g.moveTo(-s * 0.3 - st, 0); g.lineTo(-s * 0.18, -s * 0.8); g.lineTo(s * 0.18, -s * 0.8); g.lineTo(s * 0.3 + st, 0); g.stroke();
    g.beginPath(); g.moveTo(-s * 0.38, -s * 0.75); g.lineTo(-s * 0.32, -s * 1.7); g.lineTo(s * 0.32, -s * 1.7); g.lineTo(s * 0.38, -s * 0.75); g.closePath(); g.fill(); g.stroke();
    g.beginPath(); g.arc(0, -s * 1.95, s * 0.24, 0, Math.PI * 2); g.fill(); g.stroke();
    // a boulder held overhead
    g.fillStyle = 'rgb(128,118,108)';
    g.beginPath(); g.arc(s * 0.55, -s * (2.2 + (f ? 0.1 : 0)), s * 0.3, 0, Math.PI * 2); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(s * 0.3, -s * 1.6); g.lineTo(s * 0.5, -s * 2.0); g.stroke();
  },
  treant(g, s, f, tone) {
    const c = tone || BEAST_TONE.treant;
    const lw = Math.max(0.8, s * 0.08);
    shadow(g, s, 0.6);
    g.strokeStyle = INK; g.lineWidth = lw;
    g.fillStyle = 'rgb(98,72,46)';
    g.beginPath(); g.moveTo(-s * 0.25, 0); g.lineTo(-s * 0.18, -s * 1.1); g.lineTo(s * 0.18, -s * 1.1); g.lineTo(s * 0.25, 0); g.closePath(); g.fill(); g.stroke();
    // arms like boughs
    const sw = f ? s * 0.12 : 0;
    g.beginPath(); g.moveTo(-s * 0.15, -s * 0.8); g.quadraticCurveTo(-s * 0.6, -s * 0.9 - sw, -s * 0.75, -s * 1.3 - sw); g.moveTo(s * 0.15, -s * 0.8); g.quadraticCurveTo(s * 0.6, -s * 0.9 + sw, s * 0.75, -s * 1.3 + sw); g.stroke();
    g.fillStyle = css(c);
    g.beginPath(); g.arc(0, -s * 1.55, s * 0.6, 0, Math.PI * 2); g.fill(); g.stroke();
    g.beginPath(); g.arc(-s * 0.45, -s * 1.25, s * 0.32, 0, Math.PI * 2); g.arc(s * 0.45, -s * 1.25, s * 0.32, 0, Math.PI * 2); g.fill();
    // a face in the bark: two lamp-bright eyes and a knot of a mouth
    g.fillStyle = 'rgb(250,220,110)';
    g.beginPath(); g.arc(-s * 0.09, -s * 0.86, s * 0.075, 0, Math.PI * 2); g.arc(s * 0.09, -s * 0.86, s * 0.075, 0, Math.PI * 2); g.fill();
    g.strokeStyle = INK; g.lineWidth = lw * 0.9;
    g.beginPath(); g.ellipse(0, -s * 0.62, s * 0.08, s * 0.05, 0, 0, Math.PI * 2); g.stroke();
  },
  kraken(g, s, f, tone) {
    const c = tone || BEAST_TONE.kraken;
    const lw = Math.max(0.8, s * 0.09);
    g.strokeStyle = 'rgba(236,246,250,0.6)'; g.lineWidth = lw;
    g.beginPath(); g.ellipse(0, 0, s * 1.0, s * 0.28, 0, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = css(c); g.lineWidth = lw * 2.2;
    const curl = f ? 1 : -1;
    for (let k = 0; k < 5; k++) {
      const x = -s * 0.8 + k * s * 0.4;
      const h = s * (0.7 + 0.35 * ((k * 7) % 3) / 2);
      g.beginPath(); g.moveTo(x, 0); g.quadraticCurveTo(x + s * 0.25 * curl, -h * 0.6, x + s * 0.05, -h); g.stroke();
    }
    g.strokeStyle = INK; g.lineWidth = lw * 0.6;
    g.beginPath(); g.arc(0, -s * 0.1, s * 0.22, Math.PI, 0); g.stroke();
  },
  behemoth(g, s, f, tone) {
    const c = tone || BEAST_TONE.behemoth;
    const lw = Math.max(0.8, s * 0.08);
    shadow(g, s, 1.0);
    g.strokeStyle = INK; g.lineWidth = lw; g.fillStyle = css(c);
    const st = f ? s * 0.08 : -s * 0.08;
    for (const lx of [-s * 0.7, -s * 0.35, s * 0.35, s * 0.7]) { g.beginPath(); g.moveTo(lx, -s * 0.4); g.lineTo(lx + (lx > 0 ? st : -st), 0); g.stroke(); }
    g.beginPath(); g.ellipse(0, -s * 0.75, s * 1.0, s * 0.48, 0, 0, Math.PI * 2); g.fill(); g.stroke();
    g.beginPath(); g.ellipse(s * 0.95, -s * 0.8, s * 0.32, s * 0.28, 0.3, 0, Math.PI * 2); g.fill(); g.stroke();
    g.strokeStyle = 'rgb(240,232,210)'; g.lineWidth = lw * 1.4;
    g.beginPath(); g.moveTo(s * 1.1, -s * 0.7); g.quadraticCurveTo(s * 1.4, -s * 0.6, s * 1.35, -s * 0.95); g.stroke();
  },
  undead(g, s, f, tone) {
    const c = tone || BEAST_TONE.undead;
    const lw = Math.max(0.8, s * 0.08);
    g.fillStyle = css(c, 0.35);
    for (let k = 0; k < 4; k++) { g.beginPath(); g.arc(-s * 0.75 + k * s * 0.5, -s * 0.15 - ((k + (f ? 1 : 0)) & 1) * s * 0.15, s * 0.35, 0, Math.PI * 2); g.fill(); }
    g.strokeStyle = INK; g.lineWidth = lw * 1.2;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -s * 2.0); g.stroke();
    g.fillStyle = 'rgb(60,66,60)'; g.lineWidth = lw;
    g.beginPath(); g.moveTo(0, -s * 1.95); g.lineTo(s * 0.95, -s * 1.85); g.lineTo(s * 0.8, -s * 1.5); g.lineTo(s * 0.95, -s * 1.2); g.lineTo(0, -s * 1.15); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = 'rgb(228,232,214)';
    g.beginPath(); g.arc(s * 0.42, -s * 1.55, s * 0.18, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgb(40,44,40)';
    g.beginPath(); g.arc(s * 0.36, -s * 1.57, s * 0.04, 0, Math.PI * 2); g.arc(s * 0.48, -s * 1.57, s * 0.04, 0, Math.PI * 2); g.fill();
  },
};

/** A soft parchment ground behind a glyph, so ink reads on snow, forest and sea alike. */
function haloSprite(r, s, dpr) {
  const sb = Math.max(3, Math.round(s));
  return cached(r, `halo|${sb}|${dpr}`, () => {
    const R = sb * 1.35;
    return sprite(R * 2, R * 2, R, R, dpr, (g) => {
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, R);
      gr.addColorStop(0, 'rgba(244,236,214,0.62)');
      gr.addColorStop(0.55, 'rgba(244,236,214,0.38)');
      gr.addColorStop(1, 'rgba(244,236,214,0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.fill();
    });
  });
}

/** The sprite for a band glyph. kind: DRAW key; tone: [r,g,b] | null. */
function glyphSprite(r, kind, s, frame, tone, dpr, flip = false) {
  const sb = Math.max(3, Math.round(s));
  const key = `${kind}|${sb}|${frame}|${tone ? tone.map((v) => v | 0).join(',') : ''}|${dpr}|${flip ? 1 : 0}`;
  return cached(r, key, () => {
    const W = sb * 3.2, H = sb * 3.2;
    const ox = W / 2, oy = H * 0.78;
    return sprite(W, H, ox, oy, dpr, (g) => { if (flip) g.scale(-1, 1); (DRAW[kind] || DRAW.campfire)(g, sb, frame, tone); });
  });
}

// ---------------------------------------------------------------------------
// Which glyph, size and colour for a band

function glyphOf(b) {
  if (b.kind === 'dragon') return b.state === 'sleep' ? 'dragonSleep' : 'dragon';
  const g = BAND_KINDS[b.kind]?.glyph;
  return DRAW[g] ? g : DRAW[b.kind] ? b.kind : 'campfire';
}
function toneOf(b) {
  if (b.kind === 'dragon') return DRAGON_TONE[b.data?.variety] || DRAGON_TONE.fire;
  if (b.kind === 'company') return hsl(hashHue(String(b.name || b.id)), 0.55, 0.42);
  return BEAST_TONE[b.kind] || null;
}
function sizeOf(b, z) {
  const zf = clamp(Math.pow(z / 8, 0.4), 0.8, 1.8);
  if (b.family === 'beast' || b.family === 'spirit') {
    const p = Math.max(1, b.power || 1);
    const k = b.kind === 'dragon' ? 1.45 : b.kind === 'kraken' || b.kind === 'behemoth' || b.kind === 'giant' ? 1.2 : 1.08;
    return clamp(6 + Math.log10(p + 10) * 1.8, 8, 16) * k * zf;
  }
  return clamp(4 + Math.log10((b.strength || 0) + 10) * 2, 5, 13) * (b.kind === 'horde' ? 1.25 : 1) * zf;
}
/** Is this band worth drawing at zoom z (small fry wait until we come closer)? */
function visibleAt(b, z) {
  if (b.state === 'hired' && z < 6) return false;
  if (z >= 3.2) return true;
  return b.kind === 'dragon' || b.kind === 'horde' || b.kind === 'kraken' || (b.strength || 0) >= 300;
}

// ---------------------------------------------------------------------------
// Layers

const frameOf = (r, b) => (r.reducedMotion ? 0 : (Math.floor((r.now || 0) / 420 + b.id * 0.37) & 1));
const onScreen = (r, sx, sy, m) => sx > -m && sy > -m && sx < r.viewW + m && sy < r.viewH + m;
const selBand = (r) => (r.selection && r.selection.kind === 'band' ? r.selection.id : null);
const findArmy = (w, id) => { if (id == null || id < 0) return null; for (const a of w.armies) if (a.id === id) return a; return null; };

registerLayer({
  id: 'wp2-bands', slot: 'units', order: 40,
  draw(r, ctx, env) {
    const w = r.world;
    if (!w || r.snapshot || r.overlays.units === false) return;
    const z = env.z, dpr = env.dpr;
    const sel = selBand(r);
    // crossed spears on hunt armies
    if (z >= 4) {
      for (const a of w.armies) {
        if (!a.flags || a.flags.hunt == null) continue;
        const { sx, sy } = r.e2s(a.x, a.y);
        if (!onScreen(r, sx, sy, 30)) continue;
        const k = clamp(4 + z * 0.2, 4, 8);
        const bx = sx - k * 1.4, by = sy - k * 2.2;
        ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(20,14,8,0.8)'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(bx - k, by - k); ctx.lineTo(bx + k, by + k); ctx.moveTo(bx + k, by - k); ctx.lineTo(bx - k, by + k); ctx.stroke();
        ctx.strokeStyle = 'rgb(236,214,160)'; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(bx - k, by - k); ctx.lineTo(bx + k, by + k); ctx.moveTo(bx + k, by - k); ctx.lineTo(bx - k, by + k); ctx.stroke();
      }
    }
    for (const b of w.bands) {
      if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || !visibleAt(b, z)) continue;
      let x = b.x, y = b.y;
      const hired = b.state === 'hired';
      if (hired) { const a = findArmy(w, b.data?.armyId); if (!a) continue; x = a.x; y = a.y; }
      const { sx: sx0, sy: sy0 } = r.e2s(x, y);
      const s = sizeOf(b, z) * (hired ? 0.6 : 1);
      if (!onScreen(r, sx0, sy0, s * 3)) continue;
      const sx = hired ? sx0 + s * 1.6 : sx0, sy = hired ? sy0 - s * 0.6 : sy0;
      const flip = (b.kind === 'dragon' || b.kind === 'wyvern') && b.targetI >= 0 && (b.targetI % w.W) < b.x - 0.5;
      const sp = glyphSprite(r, glyphOf(b), s, frameOf(r, b), toneOf(b), dpr, flip);
      // a flying dragon casts its shadow on the ground below
      const flying = (b.kind === 'dragon' || b.kind === 'wyvern') && (b.state === 'raid' || b.state === 'return' || b.state === 'roam');
      if (flying) {
        ctx.fillStyle = 'rgba(16,10,6,0.22)';
        ctx.beginPath(); ctx.ellipse(sx, sy + s * 0.5, s * 1.1, s * 0.3, 0, 0, Math.PI * 2); ctx.fill();
      }
      const lift = flying ? s * 0.6 : 0;
      if (b.state === 'tamed' && b.civId >= 0 && w.civs[b.civId]) {
        ctx.strokeStyle = w.civs[b.civId].colorHex || GOLD; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(sx, sy, s * 0.8, s * 0.26, 0, 0, Math.PI * 2); ctx.stroke();
      }
      if (z >= 4.5) { const hl = haloSprite(r, s, dpr); ctx.drawImage(hl.canvas, sx - hl.ox, sy - s * 0.6 - lift - hl.oy, hl.w, hl.h); }
      ctx.globalAlpha = b.state === 'sleep' ? 0.92 : 1;
      ctx.drawImage(sp.canvas, sx - sp.ox, sy - sp.oy - lift, sp.w, sp.h);
      ctx.globalAlpha = 1;
      if (b.state === 'sleep' && !r.reducedMotion && z >= 5) {
        // slow sleep-smoke rising from the coil
        const t = ((r.now || 0) / 2600 + b.id * 0.3) % 1;
        ctx.fillStyle = `rgba(210,206,198,${(0.5 * (1 - t)).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(sx + s * 0.9 + t * s * 0.4, sy - s * 0.6 - t * s * 1.6, s * (0.12 + 0.18 * t), 0, Math.PI * 2); ctx.fill();
      }
      const hs = s * 1.3;
      r.hits.push({ kind: 'band', id: b.id, x0: sx - hs, y0: sy - hs * 1.6 - lift, x1: sx + hs, y1: sy + hs * 0.4, pri: b.id === sel ? 6 : 4.5 });
      if (env.labels && env.labels.blocks) (env.labels.dynBlocks || env.labels.blocks).push([sx - s, sy - s * 1.8 - lift, sx + s, sy + 2]);
    }
  },
});

registerLayer({
  id: 'wp2-lairs', slot: 'underIcons', order: 60,
  draw(r, ctx, env) {
    const w = r.world;
    if (!w || r.snapshot) return;
    const z = env.z;
    const sel = selBand(r);
    const now = r.now || 0;
    // raid arrows: everything in the monsters mode, else only the selected band's
    const log = w.sys?.bands?.log;
    if (log && log.length && (env.mode === 'monsters' || sel != null)) {
      const day = w.time.day;
      for (const e of log) {
        const [d, bandId, x0, y0, x1, y1, ki, sev] = e;
        const age = (day - d) / DAYS_PER_YEAR;
        if (age > 2 || age < 0 || (sel != null && bandId !== sel)) continue;
        const kind = Object.keys(BAND_KINDS)[ki] || 'bandits';
        const fam = BAND_KINDS[kind]?.family || 'outlaw';
        const col = kind === 'dragon' ? [230, 112, 40] : FAMILY_TONE[fam] || FAMILY_TONE.outlaw;
        arrow(r, ctx, x0, y0, x1, y1, col, (1 - age / 2) * (sel != null ? 0.95 : 0.7), 1 + (sev || 0.5) * 1.6);
      }
    }
    // hunt trails toward their quarry
    if (z >= 6 || sel != null) {
      for (const a of w.armies) {
        if (!a.flags || a.flags.hunt == null || a.flags.hret) continue;
        if (sel != null && a.flags.hunt !== sel && z < 6) continue;
        const b = w.bands.find((q) => q.id === a.flags.hunt);
        if (!b) continue;
        const p = r.e2s(a.x, a.y), q = r.e2s(b.x, b.y);
        if (!onScreen(r, p.sx, p.sy, 400) && !onScreen(r, q.sx, q.sy, 400)) continue;
        ctx.strokeStyle = 'rgba(236,214,160,0.55)'; ctx.lineWidth = 1.2;
        ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.moveTo(p.sx, p.sy); ctx.lineTo(q.sx, q.sy); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // lairs
    if (z < 7) return;
    const a0 = clamp((z - 7) / 3, 0, 1);
    for (const site of w.sites) {
      if (site.kind !== 'lair') continue;
      const { sx, sy } = r.e2s(site.x, site.y);
      const s = clamp(3 + z * 0.35, 4, 14);
      if (!onScreen(r, sx, sy, s * 3)) continue;
      ctx.globalAlpha = 0.35 + 0.65 * a0;
      lairGlyph(ctx, sx, sy, s, site, now, r.reducedMotion);
      ctx.globalAlpha = 1;
      // a lair opens its dragon's record (an archived one once the dragon is dead)
      if (site.data && Number.isFinite(site.data.bandId) && site.data.bandId >= 0) r.hits.push({ kind: 'band', id: site.data.bandId, x0: sx - s, y0: sy - s, x1: sx + s, y1: sy + s * 0.4, pri: 2.5 });
    }
  },
});

function arrow(r, ctx, x0, y0, x1, y1, col, a, wdt) {
  const p = r.e2s(x0, y0), q = r.e2s(x1, y1);
  const dx = q.sx - p.sx, dy = q.sy - p.sy, d = Math.hypot(dx, dy);
  if (d < 6) return;
  if (!onScreen(r, p.sx, p.sy, d) && !onScreen(r, q.sx, q.sy, d)) return;
  // a bowed line, like a cartographer's raid arrow
  const mx = (p.sx + q.sx) / 2 - dy * 0.18, my = (p.sy + q.sy) / 2 + dx * 0.18;
  ctx.strokeStyle = css([20, 14, 8], a * 0.5); ctx.lineWidth = wdt + 2;
  ctx.beginPath(); ctx.moveTo(p.sx, p.sy); ctx.quadraticCurveTo(mx, my, q.sx, q.sy); ctx.stroke();
  ctx.strokeStyle = css(col, a); ctx.lineWidth = wdt;
  ctx.beginPath(); ctx.moveTo(p.sx, p.sy); ctx.quadraticCurveTo(mx, my, q.sx, q.sy); ctx.stroke();
  const tx = q.sx - mx, ty = q.sy - my, tl = Math.hypot(tx, ty) || 1;
  const ux = tx / tl, uy = ty / tl, hl = 5 + wdt * 2;
  ctx.fillStyle = css(col, a);
  ctx.beginPath(); ctx.moveTo(q.sx, q.sy); ctx.lineTo(q.sx - ux * hl - uy * hl * 0.5, q.sy - uy * hl + ux * hl * 0.5); ctx.lineTo(q.sx - ux * hl + uy * hl * 0.5, q.sy - uy * hl - ux * hl * 0.5); ctx.closePath(); ctx.fill();
}

function lairGlyph(ctx, sx, sy, s, site, now, still) {
  const slain = Boolean(site.data?.bones || site.data?.slain);
  // a rocky mound with a dark cave mouth
  ctx.fillStyle = 'rgb(126,114,100)'; ctx.strokeStyle = INK; ctx.lineWidth = Math.max(0.8, s * 0.08);
  ctx.beginPath(); ctx.moveTo(sx - s * 1.2, sy + s * 0.3); ctx.quadraticCurveTo(sx - s * 0.9, sy - s * 0.9, sx, sy - s * 1.0); ctx.quadraticCurveTo(sx + s * 0.95, sy - s * 0.9, sx + s * 1.2, sy + s * 0.3); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgb(28,22,20)';
  ctx.beginPath(); ctx.moveTo(sx - s * 0.45, sy + s * 0.3); ctx.quadraticCurveTo(sx - s * 0.42, sy - s * 0.45, sx, sy - s * 0.5); ctx.quadraticCurveTo(sx + s * 0.42, sy - s * 0.45, sx + s * 0.45, sy + s * 0.3); ctx.closePath(); ctx.fill();
  if (slain) {
    // bleached bones before the mouth: a rib cage and a long skull
    ctx.strokeStyle = 'rgb(236,228,206)'; ctx.lineWidth = Math.max(0.8, s * 0.09);
    for (let k = 0; k < 4; k++) { ctx.beginPath(); ctx.arc(sx - s * 0.2 + k * s * 0.18, sy + s * 0.32, s * 0.2, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(sx - s * 0.9, sy + s * 0.38); ctx.lineTo(sx + s * 0.9, sy + s * 0.38); ctx.stroke();
    ctx.fillStyle = 'rgb(236,228,206)';
    ctx.beginPath(); ctx.ellipse(sx + s * 0.95, sy + s * 0.28, s * 0.28, s * 0.13, -0.2, 0, Math.PI * 2); ctx.fill();
    return;
  }
  if ((site.data?.hoard || 0) > 0) {
    // the glint of gold deep in the dark
    const tw = still ? 0.8 : 0.55 + 0.45 * Math.sin(now * 0.004 + site.id * 1.7);
    ctx.fillStyle = `rgba(242,200,92,${(0.55 + 0.4 * tw).toFixed(3)})`;
    ctx.beginPath(); ctx.ellipse(sx, sy + s * 0.12, s * 0.28, s * 0.1, 0, 0, Math.PI * 2); ctx.fill();
    const k = s * 0.22 * tw;
    ctx.strokeStyle = `rgba(255,240,190,${(0.4 + 0.5 * tw).toFixed(3)})`; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(sx + s * 0.12 - k, sy - s * 0.05); ctx.lineTo(sx + s * 0.12 + k, sy - s * 0.05); ctx.moveTo(sx + s * 0.12, sy - s * 0.05 - k); ctx.lineTo(sx + s * 0.12, sy - s * 0.05 + k); ctx.stroke();
  }
}

registerLayer({
  id: 'wp2-labels', slot: 'labels', order: 50,
  draw(r, ctx, env) {
    const w = r.world;
    if (!w || r.snapshot || !env.labels || !r.overlays.labels) return;
    const z = env.z;
    const sel = selBand(r);
    if (z >= 5) {
      // out at Continent zoom the map names peoples first: of the lesser powers only an elder,
      // the selected one and those that raided lately are named before Region zoom
      let raiders = null;
      if (z < 10) {
        raiders = new Set();
        const log = w.sys?.bands?.log || [];
        for (let k = log.length - 1; k >= 0 && w.time.day - log[k][0] <= 2 * 360; k--) raiders.add(log[k][1]);
      }
      for (const b of w.bands) {
        if (!b.name || b.state === 'hired' || !visibleAt(b, z)) continue;
        const big = b.kind === 'dragon' || b.kind === 'horde' || b.kind === 'kraken';
        if (!big && z < 7 && b.id !== sel) continue;
        if (!big && raiders && b.id !== sel && !b.data?.elder && !raiders.has(b.id)) continue;
        const { sx, sy } = r.e2s(b.x, b.y);
        if (!onScreen(r, sx, sy, 80)) continue;
        const s = sizeOf(b, z);
        const fs = clamp(9 + z * 0.12, 9.5, 13) * (big ? 1.08 : 1);
        const tone = b.kind === 'dragon' ? [120, 28, 20] : b.family === 'beast' ? [72, 44, 110] : b.family === 'host' ? [96, 60, 22] : b.family === 'spirit' ? [60, 80, 60] : [112, 34, 24];
        const text = b.kind === 'dragon' && b.epithet ? `${b.name} ${b.epithet}` : b.name.replace(/^the\s+/i, (m) => m[0].toUpperCase() + m.slice(1));
        env.labels.push({
          pri: (b.id === sel ? 70 : big ? 44 : 30) + Math.log10((b.power || b.strength || 1) + 1),
          text, x: sx, y: sy + fs * 0.9 + 3, alt: fs * 1.1, dyn: true,
          st: { size: fs, italic: true, color: css(tone), halo: 'rgba(248,240,220,0.88)', haloW: 2.4 },
        });
      }
    }
    if (z >= 10) {
      for (const site of w.sites) {
        if (site.kind !== 'lair' || !site.name) continue;
        const { sx, sy } = r.e2s(site.x, site.y);
        if (!onScreen(r, sx, sy, 80)) continue;
        const fs = clamp(9 + z * 0.08, 9.5, 12);
        env.labels.push({ pri: 26, text: site.name.replace(/^the\s+/i, (m) => m[0].toUpperCase() + m.slice(1)), x: sx, y: sy + fs + 6, alt: fs * 1.1, st: { size: fs, sc: true, spacing: 0.06, color: 'rgb(78,60,44)', halo: 'rgba(248,240,220,0.85)', haloW: 2.2 } });
      }
    }
  },
});

registerLayer({
  id: 'wp2-selection', slot: 'hud', order: 40,
  draw(r, ctx, env) {
    const w = r.world;
    const id = selBand(r);
    if (!w || id == null) return;
    const b = w.bands.find((q) => q.id === id);
    if (!b) return;
    let x = b.x, y = b.y;
    if (b.state === 'hired') { const a = findArmy(w, b.data?.armyId); if (a) { x = a.x; y = a.y; } }
    const { sx, sy } = r.e2s(x, y);
    // the planned road, dashed
    if (Array.isArray(b.path) && b.path.length > 1 && b.pathStep < b.path.length - 1) {
      ctx.strokeStyle = 'rgba(240,206,120,0.8)'; ctx.lineWidth = 1.6; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(sx, sy);
      for (let k = Math.max(0, b.pathStep | 0) + 1; k < b.path.length; k++) { const i = b.path[k]; const q = r.e2s(i % w.W, (i / w.W) | 0); ctx.lineTo(q.sx, q.sy); }
      ctx.stroke(); ctx.setLineDash([]);
    } else if (b.targetI >= 0 && (b.state === 'raid' || b.state === 'return' || b.state === 'roam')) {
      const q = r.e2s(b.targetI % w.W, (b.targetI / w.W) | 0);
      ctx.strokeStyle = 'rgba(240,206,120,0.8)'; ctx.lineWidth = 1.6; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(q.sx, q.sy); ctx.stroke(); ctx.setLineDash([]);
    }
    const rad = sizeOf(b, env.z) * 1.6 + 6;
    const t = r.reducedMotion ? 0 : (r.now || 0) * 0.002;
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(20,14,8,0.6)';
    ctx.beginPath(); ctx.arc(sx, sy - rad * 0.3, rad + 1, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgb(240,206,120)'; ctx.lineWidth = 1.6;
    for (let k = 0; k < 4; k++) { ctx.beginPath(); ctx.arc(sx, sy - rad * 0.3, rad, t + k * Math.PI / 2, t + k * Math.PI / 2 + Math.PI / 3); ctx.stroke(); }
  },
});

// ---------------------------------------------------------------------------
// Effects

/** A tiny deterministic noise per effect for particle placement (cosmetic only). */
const rnd = (seed, k) => { const v = Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453; return v - Math.floor(v); };

registerFxType('raid', {
  dur: 2000, priority: 4, cap: 14,
  draw(fx, ctx, r, t) {
    const { sx, sy } = r.e2s(fx.x, fx.y);
    const z = r.camera.zoom;
    const R = Math.max(14, (fx.r || 1.4) * z * 1.15);
    if (!onScreen(r, sx, sy, R * 3)) return;
    const flick = r.reducedMotion ? 1 : 0.8 + 0.2 * Math.sin(t * 40 + fx.seed);
    const a = Math.min(1, t * 6) * (1 - t) * (0.6 + 0.5 * (fx.intensity ?? 0.7));
    const rr = R * (0.7 + 0.5 * t);
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, rr);
    g.addColorStop(0, `rgba(255,190,90,${(0.85 * a * flick).toFixed(3)})`);
    g.addColorStop(0.45, `rgba(222,92,36,${(0.5 * a).toFixed(3)})`);
    g.addColorStop(1, 'rgba(120,30,10,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(sx, sy, rr, 0, Math.PI * 2); ctx.fill();
    // tongues of flame licking up from the roofs
    for (let k = 0; k < 5; k++) {
      const ox = (rnd(fx.seed, k + 40) - 0.5) * R * 0.9;
      const hgt = R * (0.35 + 0.4 * rnd(fx.seed, k + 50)) * (r.reducedMotion ? 1 : 0.8 + 0.3 * Math.sin(t * 30 + k * 2 + fx.seed));
      ctx.fillStyle = `rgba(255,${150 + ((k * 23) % 70)},60,${(0.8 * a).toFixed(3)})`;
      ctx.beginPath(); ctx.moveTo(sx + ox - R * 0.08, sy + R * 0.05); ctx.quadraticCurveTo(sx + ox - R * 0.06, sy - hgt * 0.6, sx + ox, sy - hgt); ctx.quadraticCurveTo(sx + ox + R * 0.06, sy - hgt * 0.6, sx + ox + R * 0.08, sy + R * 0.05); ctx.closePath(); ctx.fill();
    }
    // smoke and sparks rising
    for (let k = 0; k < 7; k++) {
      const ox = (rnd(fx.seed, k) - 0.5) * R * 0.9, rise = t * R * (0.9 + rnd(fx.seed, k + 9));
      ctx.fillStyle = `rgba(62,56,52,${(0.4 * (1 - t)).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(sx + ox, sy - R * 0.4 - rise, R * (0.14 + 0.22 * t), 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = `rgba(255,214,120,${(0.95 * (1 - t)).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(sx + ox * 0.6, sy - rise * 1.3, 1.3, 0, Math.PI * 2); ctx.fill();
    }
  },
});

registerFxType('dragonfire', {
  dur: 2800, priority: 7, cap: 4,
  draw(fx, ctx, r, t) {
    const { sx, sy } = r.e2s(fx.x, fx.y);
    const z = r.camera.zoom;
    const R = Math.max(14, (fx.r || 2) * z);
    if (!onScreen(r, sx, sy, R * 4)) return;
    const o = r.e2s(Number.isFinite(fx.x2) ? fx.x2 : fx.x + 1.5, Number.isFinite(fx.y2) ? fx.y2 : fx.y - 1.5);
    const ang = Math.atan2(sy - o.sy, sx - o.sx);
    const len = Math.max(R * 1.4, Math.hypot(sx - o.sx, sy - o.sy));
    const breath = t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45;
    const flick = r.reducedMotion ? 1 : 0.85 + 0.15 * Math.sin(t * 50 + fx.seed);
    // the breath: a widening cone of fire from the dragon's jaws to the town
    ctx.save();
    ctx.translate(o.sx, o.sy); ctx.rotate(ang);
    const g = ctx.createLinearGradient(0, 0, len * 1.1, 0);
    g.addColorStop(0, `rgba(255,244,190,${(0.9 * breath).toFixed(3)})`);
    g.addColorStop(0.35, `rgba(255,150,40,${(0.75 * breath * flick).toFixed(3)})`);
    g.addColorStop(0.8, `rgba(200,50,20,${(0.5 * breath).toFixed(3)})`);
    g.addColorStop(1, 'rgba(120,20,10,0)');
    ctx.fillStyle = g;
    const spread = R * 0.55 * (0.8 + 0.4 * Math.min(1, t * 3));
    // three overlapping tongues of fire, each wavering on its own
    for (let k = 0; k < 3; k++) {
      const wv = r.reducedMotion ? 0 : Math.sin(t * 26 + k * 2.1 + fx.seed) * spread * 0.18;
      const sp = spread * (1 - k * 0.22);
      ctx.globalAlpha = k === 0 ? 0.75 : 0.55;
      ctx.beginPath(); ctx.moveTo(0, 0);
      ctx.bezierCurveTo(len * 0.35, -sp * 0.25 + wv, len * 0.75, -sp * 0.9 - wv, len * 1.1, -sp + wv);
      ctx.quadraticCurveTo(len * 1.22, wv * 0.5, len * 1.1, sp + wv);
      ctx.bezierCurveTo(len * 0.75, sp * 0.9 - wv, len * 0.35, sp * 0.25 + wv, 0, 0);
      ctx.closePath(); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // the white-hot core of the breath
    ctx.strokeStyle = `rgba(255,248,220,${(0.7 * breath).toFixed(3)})`; ctx.lineWidth = Math.max(1.5, R * 0.08);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(len * 0.8, 0); ctx.stroke();
    ctx.restore();
    // the town burning beneath
    const ga = Math.min(1, t * 2.5) * (1 - t * 0.6) * (fx.intensity ?? 1);
    const gl = ctx.createRadialGradient(sx, sy, 0, sx, sy, R * 1.3);
    gl.addColorStop(0, `rgba(255,150,60,${(0.65 * ga).toFixed(3)})`);
    gl.addColorStop(0.6, `rgba(190,50,20,${(0.3 * ga).toFixed(3)})`);
    gl.addColorStop(1, 'rgba(90,20,10,0)');
    ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(sx, sy, R * 1.3, 0, Math.PI * 2); ctx.fill();
    // embers drifting on the hot wind
    const n = r.reducedMotion ? 8 : 18;
    for (let k = 0; k < n; k++) {
      const a0 = rnd(fx.seed, k) * Math.PI * 2, d0 = rnd(fx.seed, k + 31) * R * 1.2;
      const ex = sx + Math.cos(a0) * d0 + (rnd(fx.seed, k + 7) - 0.5) * R * t, ey = sy + Math.sin(a0) * d0 * 0.6 - t * R * (0.6 + rnd(fx.seed, k + 3));
      ctx.fillStyle = `rgba(255,${180 + ((k * 13) % 60)},90,${(0.9 * (1 - t)).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(ex, ey, 1 + rnd(fx.seed, k + 5) * 1.4, 0, Math.PI * 2); ctx.fill();
    }
  },
});

registerFxType('slay', {
  dur: 2600, priority: 8, cap: 3,
  draw(fx, ctx, r, t) {
    const { sx, sy } = r.e2s(fx.x, fx.y);
    const z = r.camera.zoom;
    const R = Math.max(16, (fx.r || 2) * z);
    if (!onScreen(r, sx, sy, R * 3)) return;
    const a = 1 - t;
    ctx.strokeStyle = `rgba(242,206,110,${(0.9 * a).toFixed(3)})`; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(sx, sy, R * (0.3 + 1.1 * t), 0, Math.PI * 2); ctx.stroke();
    // rays
    ctx.lineWidth = 1.6;
    for (let k = 0; k < 8; k++) {
      const ang = k * Math.PI / 4 + (r.reducedMotion ? 0 : t * 0.6);
      ctx.beginPath(); ctx.moveTo(sx + Math.cos(ang) * R * 0.4, sy + Math.sin(ang) * R * 0.4); ctx.lineTo(sx + Math.cos(ang) * R * (0.6 + 0.6 * t), sy + Math.sin(ang) * R * (0.6 + 0.6 * t)); ctx.stroke();
    }
    // a raised sword
    const k = R * 0.45 * Math.min(1, t * 3);
    ctx.strokeStyle = `rgba(20,14,8,${(0.7 * a).toFixed(3)})`; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(sx, sy + k * 0.6); ctx.lineTo(sx, sy - k * 1.2); ctx.moveTo(sx - k * 0.35, sy + k * 0.15); ctx.lineTo(sx + k * 0.35, sy + k * 0.15); ctx.stroke();
    ctx.strokeStyle = `rgba(250,240,214,${a.toFixed(3)})`; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(sx, sy + k * 0.6); ctx.lineTo(sx, sy - k * 1.2); ctx.moveTo(sx - k * 0.35, sy + k * 0.15); ctx.lineTo(sx + k * 0.35, sy + k * 0.15); ctx.stroke();
  },
});

registerFxType('summon', {
  dur: 2400, priority: 6, cap: 4,
  draw(fx, ctx, r, t) {
    const { sx, sy } = r.e2s(fx.x, fx.y);
    const z = r.camera.zoom;
    const R = Math.max(14, (fx.r || 2) * z);
    if (!onScreen(r, sx, sy, R * 3)) return;
    const col = fx.color || [169, 139, 230];
    const a = t < 0.2 ? t / 0.2 : 1 - (t - 0.2) / 0.8;
    const rr = R * (1.2 - 0.5 * t);
    const rot = r.reducedMotion ? 0 : t * Math.PI;
    ctx.strokeStyle = css(col, 0.85 * a); ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]); ctx.lineDashOffset = -rot * 20;
    ctx.beginPath(); ctx.arc(sx, sy, rr, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]); ctx.lineDashOffset = 0;
    ctx.beginPath(); ctx.arc(sx, sy, rr * 0.72, 0, Math.PI * 2); ctx.stroke();
    // six rune marks around the ring
    for (let k = 0; k < 6; k++) {
      const ang = rot + k * Math.PI / 3;
      const px = sx + Math.cos(ang) * rr * 0.86, py = sy + Math.sin(ang) * rr * 0.86;
      ctx.beginPath(); ctx.moveTo(px - 3, py - 4); ctx.lineTo(px + 3, py + 4); ctx.moveTo(px + 3, py - 4); ctx.lineTo(px, py); ctx.stroke();
    }
    // motes rising from the circle
    for (let k = 0; k < 10; k++) {
      const ang = rnd(fx.seed, k) * Math.PI * 2, d = rnd(fx.seed, k + 11) * rr;
      ctx.fillStyle = css(light(col, 0.4), (1 - t) * 0.9);
      ctx.beginPath(); ctx.arc(sx + Math.cos(ang) * d, sy + Math.sin(ang) * d * 0.6 - t * R, 1.5, 0, Math.PI * 2); ctx.fill();
    }
  },
});
