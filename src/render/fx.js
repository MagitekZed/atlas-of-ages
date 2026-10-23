// Transient visual effects: drains world.fx into timed animations (meteor strikes, quake
// ripples, tsunami rings, eruptions, lightning, battles, sieges, captures, plague pulses,
// faith rays, wonders, foundings, rebellions, floods, divine acts, famine, discoveries) and
// the intervention kit that gives each divine act its own feel (bless, curse, terraform,
// sprout, spawn, raincall, parch, thread, label, swirl, rewind, riot, fair), plus a pooled
// particle system for smoke, embers, ash, sparks, dust, steam, spray, gold motes, leaves,
// rain and feathers. Effects the viewer's own hand caused (src: 'tool') are never shortened at
// a racing pace, outrank everything, tint the screen's edge by their polarity and, when they
// land off screen, raise a chevron at the edge that points (and flies) to them. Types it does
// not draw itself are looked up in the registry (./layers.js registerFxType). Every effect
// that starts is kept briefly in a ring (recentFx) and announced to an optional onFx callback.
// Purely cosmetic: Math.random is fine here.

import { css, civRgb, parseColor, lighten, darken } from './palette.js';
import { blobSprite } from './glyphs.js';
import { getFxType } from './layers.js';

const DUR = {
  meteor: 5200, quake: 2600, tsunami: 4400, eruption: 5600, lightning: 450, landfall: 2600,
  battle: 2100, siege: 1900, capture: 2800, plague: 3200, faith: 3400, wonder: 4600,
  founding: 2500, newcivs: 3800, rebellion: 2800, fire: 2300, flood: 3400, divine: 2800,
  famine: 3000, discovery: 2600,
  // the intervention kit
  bless: 2800, curse: 3000, terraform: 1900, sprout: 2400, spawn: 2800, raincall: 3200, parch: 3200,
  thread: 2900, label: 2700, swirl: 2600, rewind: 1700, riot: 2600, fair: 3000,
};
const PRIORITY = {
  meteor: 9, eruption: 8, tsunami: 8, wonder: 7, newcivs: 7, quake: 6, capture: 6, rebellion: 6,
  divine: 6, landfall: 5, plague: 5, faith: 5, flood: 4, battle: 4, famine: 4, founding: 3,
  discovery: 3, siege: 2, fire: 2, lightning: 1,
  rewind: 8, label: 7, bless: 6, curse: 6, terraform: 5, spawn: 5, raincall: 5, parch: 5, thread: 5,
  riot: 5, swirl: 5, sprout: 4, fair: 4,
};
const MAX_ACTIVE = 160;
const TYPE_CAP = {
  lightning: 8, siege: 16, battle: 16, fire: 20, founding: 12, discovery: 10, famine: 10, capture: 12, plague: 12, faith: 12,
  label: 24, thread: 24, terraform: 12, sprout: 16, spawn: 12, raincall: 10, parch: 10, riot: 12, fair: 10, swirl: 10,
};
const RECENT_MAX = 64;        // effects remembered for recentFx()
const TOOL_PRIORITY = 10;     // an effect the viewer's own hand caused (src: 'tool') outranks everything
const POINTER_MS = 3000;      // how long an off-screen act keeps its edge chevron

/** Edge tint (vignette) by the kit type's polarity: [r, g, b] and a weight. */
const POLARITY_TINT = {
  bless: [[255, 214, 120], 1], sprout: [[150, 220, 120], 0.7], fair: [[255, 206, 140], 0.7], raincall: [[110, 160, 220], 0.8],
  curse: [[90, 20, 70], 1.2], riot: [[200, 60, 40], 1], parch: [[220, 130, 50], 0.9], terraform: [[150, 110, 70], 0.8],
  spawn: [[180, 200, 140], 0.6], swirl: [[150, 170, 200], 0.7], rewind: [[214, 190, 140], 1], thread: [[220, 200, 160], 0.5],
  meteor: [[255, 170, 90], 1.1], quake: [[150, 110, 80], 1], eruption: [[255, 110, 40], 1.1], tsunami: [[110, 170, 210], 1],
  plague: [[120, 150, 60], 1], divine: [[255, 226, 150], 0.9], flood: [[100, 150, 200], 0.8], fire: [[255, 120, 40], 0.8],
};
/** Thread colours by tone. */
const THREAD = {
  hate: [196, 46, 36], war: [196, 46, 36], peace: [244, 244, 236], trade: [226, 176, 70], alliance: [92, 150, 214],
  marriage: [226, 140, 170], boon: [236, 196, 100], bane: [176, 52, 60],
};
/** Floating-label colours by tone. */
const LABEL_TONE = {
  bane: ['rgb(150,30,26)', 'rgba(255,240,226,0.92)'], hate: ['rgb(150,30,26)', 'rgba(255,240,226,0.92)'],
  boon: ['rgb(122,84,10)', 'rgba(255,248,222,0.92)'], peace: ['rgb(40,88,120)', 'rgba(244,250,255,0.92)'],
  neutral: ['rgb(44,34,26)', 'rgba(246,238,216,0.92)'],
};

/** Queue priority of an incoming effect (built-in table, else its registered type). */
function priorityOf(e) {
  if (e.src === 'tool') return TOOL_PRIORITY;
  return PRIORITY[e.type] || (DUR[e.type] ? 0 : getFxType(e.type)?.priority || 0);
}

// ---------------------------------------------------------------------------
// Particles (struct of arrays)

export const PK = { SMOKE: 0, EMBER: 1, SPARK: 2, ASH: 3, DUST: 4, STEAM: 5, SPRAY: 6, GOLD: 7, LEAF: 8, RAIN: 9, FEATHER: 10 };
const PK_COLOR = [[120, 116, 112], [255, 140, 48], [255, 226, 130], [70, 64, 62], [196, 170, 128], [236, 240, 244], [214, 236, 240], [255, 214, 110], [104, 158, 70], [150, 186, 230], [36, 30, 34]];
const PK_ADD = [false, true, true, false, false, false, false, true, false, false, false];

export class Particles {
  constructor(cap = 900) {
    this.cap = cap; this.n = 0;
    this.x = new Float32Array(cap); this.y = new Float32Array(cap);
    this.vx = new Float32Array(cap); this.vy = new Float32Array(cap);
    this.life = new Float32Array(cap); this.max = new Float32Array(cap);
    this.size = new Float32Array(cap); this.grow = new Float32Array(cap);
    this.kind = new Uint8Array(cap); this.alpha = new Float32Array(cap);
    this.seed = new Float32Array(cap);
  }
  /** x, y in tiles; vx, vy in tiles/s; size in tiles; life in s. */
  spawn(kind, x, y, vx, vy, size, life, grow = 0, alpha = 1) {
    if (this.n >= this.cap) return;
    const k = this.n++;
    this.kind[k] = kind; this.x[k] = x; this.y[k] = y; this.vx[k] = vx; this.vy[k] = vy;
    this.size[k] = size; this.grow[k] = grow; this.life[k] = life; this.max[k] = life; this.alpha[k] = alpha;
    this.seed[k] = Math.random() * 100;
  }
  update(dt) {
    let k = 0;
    while (k < this.n) {
      this.life[k] -= dt;
      if (this.life[k] <= 0) { this._kill(k); continue; }
      const kd = this.kind[k];
      if (kd === PK.LEAF || kd === PK.FEATHER) {
        // flutter: drifting down while swinging side to side
        const sw = Math.sin((this.max[k] - this.life[k]) * (kd === PK.LEAF ? 5 : 2.6) + this.seed[k]);
        this.x[k] += (this.vx[k] + sw * (kd === PK.LEAF ? 0.35 : 0.22)) * dt; this.y[k] += this.vy[k] * dt;
        this.vx[k] *= 1 - 0.6 * dt; this.vy[k] += (kd === PK.LEAF ? 0.12 : 0.06) * dt;
      } else {
        this.x[k] += this.vx[k] * dt; this.y[k] += this.vy[k] * dt;
        if (kd === PK.SMOKE || kd === PK.STEAM || kd === PK.ASH) { this.vx[k] *= 1 - 0.25 * dt; this.vy[k] *= 1 - 0.25 * dt; }
        if (kd === PK.EMBER || kd === PK.SPARK || kd === PK.SPRAY) this.vy[k] += 0.6 * dt; // gravity-ish (screen-down)
      }
      this.size[k] += this.grow[k] * dt;
      k++;
    }
  }
  _kill(k) {
    const l = --this.n;
    if (k === l) return;
    this.x[k] = this.x[l]; this.y[k] = this.y[l]; this.vx[k] = this.vx[l]; this.vy[k] = this.vy[l];
    this.life[k] = this.life[l]; this.max[k] = this.max[l]; this.size[k] = this.size[l]; this.grow[k] = this.grow[l];
    this.kind[k] = this.kind[l]; this.alpha[k] = this.alpha[l]; this.seed[k] = this.seed[l];
  }
  clear() { this.n = 0; }
  draw(ctx, r) {
    if (!this.n) return;
    const z = r.camera.zoom, dpr = r.dpr;
    const sc = r.sprites;
    // seen from afar, overlapping smoke and ash puffs pile into an opaque blot on the map:
    // thin them at world zoom (a plume reads as a haze there), full strength from z ≈ 12
    const hazeA = Math.min(1, 0.22 + z / 15);
    let shaped = 0;
    for (let pass = 0; pass < 2; pass++) {
      ctx.globalCompositeOperation = pass ? 'lighter' : 'source-over';
      for (let k = 0; k < this.n; k++) {
        const kd = this.kind[k];
        if (PK_ADD[kd] !== (pass === 1)) continue;
        if (kd >= PK.LEAF) { shaped++; continue; }
        const { sx, sy } = r.e2s(this.x[k], this.y[k]);
        let px = this.size[k] * z;
        if (px < 1.2) px = 1.2; else if (px > 90) px = 90;
        if (sx < -px || sy < -px || sx > r.viewW + px || sy > r.viewH + px) continue;
        const t = this.life[k] / this.max[k];
        const fade = kd === PK.SMOKE || kd === PK.ASH || kd === PK.STEAM ? Math.min(1, (1 - t) * 4) * t : t;
        const haze = kd === PK.SMOKE || kd === PK.ASH || kd === PK.STEAM || kd === PK.DUST ? hazeA : 1;
        ctx.globalAlpha = Math.max(0, Math.min(1, fade * this.alpha[k] * haze));
        const sp = blobSprite(sc, PK_COLOR[kd], Math.min(48, Math.max(2, Math.round(px))), dpr, kd === PK.SPARK || kd === PK.EMBER ? 1 : 0);
        ctx.drawImage(sp.canvas, sx - px, sy - px, px * 2, px * 2);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    if (shaped) this._drawShaped(ctx, r, z);
    ctx.globalAlpha = 1;
  }
  /** Leaves, rain streaks and feathers: small vector shapes rather than soft blobs. */
  _drawShaped(ctx, r, z) {
    for (let k = 0; k < this.n; k++) {
      const kd = this.kind[k];
      if (kd < PK.LEAF) continue;
      const { sx, sy } = r.e2s(this.x[k], this.y[k]);
      if (sx < -20 || sy < -20 || sx > r.viewW + 20 || sy > r.viewH + 20) continue;
      const t = this.life[k] / this.max[k];
      const a = Math.max(0, Math.min(1, Math.min(1, (1 - t) * 5) * Math.min(1, t * 3) * this.alpha[k]));
      if (a <= 0.02) continue;
      const px = Math.max(1.6, Math.min(9, this.size[k] * z));
      ctx.globalAlpha = a;
      if (kd === PK.RAIN) {
        ctx.strokeStyle = 'rgba(170,200,236,0.9)'; ctx.lineWidth = Math.max(0.8, px * 0.18);
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx - this.vx[k] * 0.06 * z, sy - Math.max(3, this.vy[k] * 0.06 * z)); ctx.stroke();
      } else if (kd === PK.LEAF) {
        const rot = this.seed[k] + (this.max[k] - this.life[k]) * 4;
        ctx.fillStyle = (this.seed[k] | 0) % 3 === 0 ? 'rgb(196,170,70)' : 'rgb(98,156,70)';
        ctx.beginPath(); ctx.ellipse(sx, sy, px * 0.6, px * 0.28, rot, 0, Math.PI * 2); ctx.fill();
      } else {
        const rot = Math.sin(this.seed[k] + (this.max[k] - this.life[k]) * 2.6) * 0.8;
        ctx.save(); ctx.translate(sx, sy); ctx.rotate(rot);
        ctx.fillStyle = 'rgb(34,28,36)';
        ctx.beginPath(); ctx.moveTo(-px * 0.7, 0); ctx.quadraticCurveTo(0, -px * 0.4, px * 0.7, 0); ctx.quadraticCurveTo(0, px * 0.25, -px * 0.7, 0); ctx.fill();
        ctx.restore();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// FX system

let UID = 1;

export class FxSystem {
  constructor() {
    this.list = [];
    this.particles = new Particles();
    this.shake = 0;          // px amplitude
    this.flash = 0;          // 0..1 white overlay
    this.flashColor = [255, 250, 236];
    this.vignette = { rgb: [0, 0, 0], a: 0 };   // edge tint by the last act's polarity (decays)
    this.reducedMotion = false;
    this.dps = 0;
    this.recent = [];        // ring of { type, x, y, r, civId, t } for the effects that started
    this.pointers = [];      // off-screen acts: { uid, fx, until }
  }
  clear() { this.list.length = 0; this.particles.clear(); this.shake = 0; this.flash = 0; this.vignette.a = 0; this._rateT = null; this.dps = 0; this.recent.length = 0; this.pointers.length = 0; }

  /** Effects that started at or after sinceMs (the frame clock), oldest first. */
  recentSince(sinceMs = -Infinity) {
    const out = [];
    for (const e of this.recent) if (e.t >= sinceMs) out.push({ ...e });
    return out;
  }

  /** The act an off-screen pointer leads to (by its uid), or null: { type, x, y, text }. */
  pointerTarget(uid) {
    const p = this.pointers.find((q) => q.uid === uid);
    return p ? { type: p.fx.type, x: p.fx.x, y: p.fx.y, text: p.fx.text || null } : null;
  }

  /** Pull new effects from world.fx (draining it). */
  ingest(world, now, r) {
    // how fast is history running? (sim days per real second, smoothed)
    const day = world.time?.day ?? 0;
    if (this._rateT == null || now < this._rateT) { this._rateT = now; this._rateDay = day; this.dps = 0; }
    else if (now - this._rateT > 500) {
      const inst = Math.max(0, (day - this._rateDay) / ((now - this._rateT) / 1000));
      this.dps = this.dps ? this.dps * 0.6 + inst * 0.4 : inst;
      this._rateT = now; this._rateDay = day;
    }
    const q = world.fx;
    if (!q || !q.length) return;
    const incoming = q.splice(0, q.length);
    // most important first when a burst arrives (Max speed)
    if (incoming.length > 40) incoming.sort((a, b) => priorityOf(b) - priorityOf(a));
    const counts = {};
    for (const e of this.list) counts[e.type] = (counts[e.type] || 0) + 1;
    const today = world.time?.day ?? 0;
    for (const e of incoming) {
      if (!e || !Number.isFinite(e.x) || !Number.isFinite(e.y)) continue;
      const reg = DUR[e.type] ? null : getFxType(e.type);
      if (!DUR[e.type] && !reg) continue;
      // effects queued long ago (a leap through the years, a hidden tab) are history now
      if (Number.isFinite(e.day) && today - e.day > 90) continue;
      const cap = reg ? reg.cap : TYPE_CAP[e.type];
      if (cap && (counts[e.type] || 0) >= cap) continue;
      const prio = priorityOf(e);
      if (this.list.length >= MAX_ACTIVE) {
        // replace the least important effect
        let worst = -1, wp = 99;
        for (let k = 0; k < this.list.length; k++) { const p = this.list[k].prio; if (p < wp) { wp = p; worst = k; } }
        if (wp >= prio) continue;
        this.list.splice(worst, 1);
      }
      counts[e.type] = (counts[e.type] || 0) + 1;
      const fx = {
        uid: UID++,
        type: e.type, x: e.x, y: e.y, r: Number.isFinite(e.r) && e.r > 0 ? e.r : defaultR(e.type),
        intensity: Number.isFinite(e.intensity) ? Math.max(0, Math.min(1.5, e.intensity)) : 0.6,
        civId: e.civId ?? null, color: parseColor(e.color) || null, text: e.text != null ? String(e.text) : null,
        // the rest of the emitFx fields, for the kit and registered types
        x2: e.x2, y2: e.y2, tone: e.tone ?? null, sign: e.sign, glyph: e.glyph ?? null, size: e.size, src: e.src ?? null,
        // at a racing pace effects are briefer, so the map does not silt up with them (never the viewer's own acts)
        t0: now, dur: (reg ? reg.dur : DUR[e.type]) * (e.src === 'tool' ? 1 : this.dps > 150 ? 0.55 : this.dps > 40 ? 0.75 : 1), seed: Math.random() * 1000, spawned: 0,
        prio, reg,
      };
      if (fx.civId != null) fx.civColor = civRgb(world, fx.civId);
      if (fx.type === 'label') {
        // labels rising from one place stack upward instead of overprinting
        let st = 0;
        for (const o of this.list) if (o.type === 'label' && Math.abs(o.x - fx.x) < 1.2 && Math.abs(o.y - fx.y) < 1.2 && now - o.t0 < o.dur * 0.7) st = Math.max(st, (o.stack || 0) + 1);
        fx.stack = Math.min(5, st);
      }
      this.list.push(fx);
      this._remember(fx, now, r);
      this._onStart(fx, r, now);
    }
  }

  /** Keep the effect in the recentFx ring and tell renderer.onFx about it. */
  _remember(fx, now, r) {
    this.recent.push({ type: fx.type, x: fx.x, y: fx.y, r: fx.r, civId: fx.civId, t: now });
    if (this.recent.length > RECENT_MAX) this.recent.splice(0, this.recent.length - RECENT_MAX);
    if (typeof r.onFx !== 'function') return;
    try {
      const { sx, sy } = r.e2s(fx.x, fx.y);
      const onScreen = sx >= 0 && sy >= 0 && sx <= r.viewW && sy <= r.viewH;
      r.onFx(fx, { sx, sy, onScreen, dist: Math.hypot(sx - r.viewW / 2, sy - r.viewH / 2) });
    } catch (e) { console.error('[renderer.onFx]', e); }
  }

  _onStart(fx, r, now) {
    if (fx.reg) {
      if (typeof fx.reg.onStart === 'function') { try { fx.reg.onStart(fx, r); } catch (e) { console.error(`[fx:${fx.type}] onStart`, e); } }
      return;
    }
    // the viewer's own acts: an edge tint by polarity and, when out of sight, a pointer
    if (fx.src === 'tool' && fx.type !== 'label' && fx.type !== 'thread') {
      const { sx, sy } = r.e2s(fx.x, fx.y);
      const off = sx < 0 || sy < 0 || sx > r.viewW || sy > r.viewH;
      if (off && !this.pointers.some((p) => Math.abs(p.fx.x - fx.x) < 0.5 && Math.abs(p.fx.y - fx.y) < 0.5)) {
        this.pointers.push({ uid: fx.uid, fx, until: now + POINTER_MS });
        if (this.pointers.length > 6) this.pointers.shift();
      }
      const tint = POLARITY_TINT[fx.type];
      if (tint && !off && !this.reducedMotion) {
        // impact: how big the act was (radius, intensity, a magnitude on the label)
        const I = Math.max(0, Math.min(1.2, (fx.r || 2) / 10 + (fx.intensity || 0.5) * 0.45));
        const a = (0.1 + 0.25 * Math.min(1, I)) * tint[1];
        if (a >= this.vignette.a * 0.6) { this.vignette.rgb = tint[0]; this.vignette.a = Math.max(this.vignette.a, a); }
        if (fx.type === 'terraform' || fx.type === 'curse' || fx.type === 'riot') this.shake = Math.max(this.shake, 2 + 8 * Math.min(1, I));
      }
    }
    const near = r.isNear(fx.x, fx.y, 40);
    if (this.reducedMotion || !near) return;
    const z = Math.min(1.5, r.camera.zoom / 8);
    if (fx.type === 'quake') this.shake = Math.max(this.shake, (3 + fx.intensity * 9) * Math.max(0.4, z));
    if (fx.type === 'meteor') { this.shake = Math.max(this.shake, 6 + Math.min(14, fx.r * 1.5)); this.flash = Math.max(this.flash, 0.55); }
    if (fx.type === 'eruption' && fx.intensity > 0.55) { this.shake = Math.max(this.shake, 3 + fx.intensity * 6); this.flash = Math.max(this.flash, 0.18); }
    if (fx.type === 'tsunami') this.shake = Math.max(this.shake, 3);
    if (fx.type === 'rewind') this.flash = Math.max(this.flash, 0.12), this.flashColor = [236, 214, 170];
  }

  /** Drop the effects and off-screen pointers whose time is up (update does this; renderer.skipFrame too). */
  expire(now) {
    const keep = [];
    for (const fx of this.list) if (now - fx.t0 < fx.dur) keep.push(fx);
    this.list = keep;
    if (this.pointers.length) this.pointers = this.pointers.filter((p) => p.until > now);
  }

  update(dt, now) {
    this.expire(now);
    this.particles.update(dt);
    this.shake *= Math.exp(-dt * 6);
    if (this.shake < 0.2) this.shake = 0;
    this.flash *= Math.exp(-dt * 5);
    if (this.flash < 0.01) { this.flash = 0; this.flashColor = [255, 250, 236]; }
    this.vignette.a *= Math.exp(-dt * 1.8);
    if (this.vignette.a < 0.005) this.vignette.a = 0;
  }

  shakeOffset(now) {
    if (!this.shake) return [0, 0];
    return [Math.sin(now * 0.091) * this.shake * 0.7 + Math.sin(now * 0.153) * this.shake * 0.3, Math.cos(now * 0.077) * this.shake * 0.6 + Math.sin(now * 0.131) * this.shake * 0.4];
  }

  draw(ctx, r, now) {
    const P = this.particles;
    for (const fx of this.list) {
      const t = (now - fx.t0) / fx.dur;
      if (t < 0 || t > 1) continue;
      if (fx.reg) { drawRegistered(ctx, fx, r, t, now); continue; }
      if (fx.type === 'thread') { ctx.save(); drawThread(ctx, fx, t, r, now); ctx.restore(); continue; }
      const { sx, sy } = r.e2s(fx.x, fx.y);
      const z = r.camera.zoom;
      const R = Math.max(10, fx.r * z);
      if (sx < -R * 3 - 80 || sy < -R * 3 - 80 || sx > r.viewW + R * 3 + 80 || sy > r.viewH + R * 3 + 80) continue;
      ctx.save();
      if (fx.type === 'label') drawLabel(ctx, fx, t, sx, sy, r);
      else if (KIT[fx.type]) KIT[fx.type](ctx, fx, t, sx, sy, R, z, now, P);
      else drawOne(ctx, fx, t, sx, sy, R, z, now, P);
      ctx.restore();
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }

  /**
   * Edge chevrons for the viewer's acts that landed out of sight (screen space): each points
   * to its act, lettered, and is a hit { kind: 'fxPointer', id: uid, ex, ey } that flies there.
   */
  drawPointers(ctx, r, now) {
    if (!this.pointers.length) return;
    const vw = r.viewW, vh = r.viewH, inset = 28;
    const cx = vw / 2, cy = vh / 2;
    for (const p of this.pointers) {
      const { sx, sy } = r.e2s(p.fx.x, p.fx.y);
      if (sx >= 0 && sy >= 0 && sx <= vw && sy <= vh) continue;   // in view now
      const dx = sx - cx, dy = sy - cy;
      const k = Math.min((vw / 2 - inset) / Math.max(1e-6, Math.abs(dx)), (vh / 2 - inset) / Math.max(1e-6, Math.abs(dy)));
      const x = cx + dx * k, y = cy + dy * k;
      const ang = Math.atan2(dy, dx);
      const left = (p.until - now) / POINTER_MS;
      const a = Math.min(1, left * 3) * (0.75 + 0.25 * Math.sin(now * 0.01));
      const tint = POLARITY_TINT[p.fx.type]?.[0] || [236, 200, 120];
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(x, y); ctx.rotate(ang);
      ctx.fillStyle = 'rgba(14,18,26,0.82)'; ctx.strokeStyle = css(tint); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, 15, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = css(lighten(tint, 0.2));
      ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(-4, -7); ctx.lineTo(-1, 0); ctx.lineTo(-4, 7); ctx.closePath(); ctx.fill();
      ctx.restore();
      const text = p.fx.text || POINTER_LABEL[p.fx.type] || '';
      if (text) {
        const sp = r.labeler.sprite(text.length > 28 ? text.slice(0, 27) + '…' : text, { size: 11, italic: true, color: 'rgb(246,232,200)', halo: 'rgba(14,18,26,0.85)', haloW: 3 });
        const tx = Math.max(sp.w / 2 + 4, Math.min(vw - sp.w / 2 - 4, x - Math.cos(ang) * 34)), ty = Math.max(sp.h / 2 + 4, Math.min(vh - sp.h / 2 - 4, y - Math.sin(ang) * 30));
        ctx.globalAlpha = a; ctx.drawImage(sp.canvas, tx - sp.w / 2, ty - sp.h / 2, sp.w, sp.h); ctx.globalAlpha = 1;
      }
      r.hits.push({ kind: 'fxPointer', id: p.uid, ex: p.fx.x, ey: p.fx.y, x0: x - 18, y0: y - 18, x1: x + 18, y1: y + 18, pri: 9 });
    }
  }

  /** The polarity vignette (screen space, device px; call with an identity transform). */
  drawVignette(ctx, w, h) {
    const v = this.vignette;
    if (!v.a || this.reducedMotion) return;
    const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.32, w / 2, h / 2, Math.hypot(w, h) * 0.58);
    g.addColorStop(0, css(v.rgb, 0));
    g.addColorStop(1, css(v.rgb, Math.min(0.4, v.a)));
    ctx.globalAlpha = 1; ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }
}

const POINTER_LABEL = { bless: 'Blessing', curse: 'Curse', terraform: 'The land moves', sprout: 'Green growth', spawn: 'New life', raincall: 'Rain', parch: 'Drought', swirl: 'A storm', rewind: 'Rewound', riot: 'Riot', fair: 'A fair', meteor: 'Falling star', quake: 'Earthquake', eruption: 'Eruption', tsunami: 'Great wave', plague: 'Plague', divine: 'Divine hand', flood: 'Flood', fire: 'Wildfire' };

/** A registered effect type draws itself (it culls as it sees fit: a thread spans the screen). */
function drawRegistered(ctx, fx, r, t, now) {
  const d = fx.reg;
  if (d.fails >= 3) return;
  ctx.save();
  try { d.draw(fx, ctx, r, t, now); d.fails = 0; } catch (e) {
    d.fails++;
    if (d.fails === 1) console.error(`[fx:${fx.type}]`, e);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// The intervention kit

/** Floating text: rises and fades; stacked labels climb above one another. */
function drawLabel(ctx, fx, t, sx, sy, r) {
  if (!fx.text) return;
  const tone = LABEL_TONE[fx.tone] || LABEL_TONE.neutral;
  const size = Math.max(10, Math.min(24, Number(fx.size) || 14));
  const sp = r.labeler.sprite(fx.text, { size, bold: size >= 16, color: fx.color ? css(fx.color) : tone[0], halo: tone[1], haloW: Math.max(2.5, size * 0.22) });
  const rise = (1 - Math.pow(1 - t, 2)) * 26;
  const y = sy - 14 - (fx.stack || 0) * size * 1.25 - rise;
  const a = t < 0.12 ? t / 0.12 : t > 0.7 ? (1 - t) / 0.3 : 1;
  const sc = t < 0.12 ? 0.8 + 0.2 * (t / 0.12) : 1;
  ctx.globalAlpha = Math.max(0, a);
  ctx.drawImage(sp.canvas, sx - (sp.w * sc) / 2, y - (sp.h * sc) / 2, sp.w * sc, sp.h * sc);
}

/** A thread between two places: jagged and red for hatred, flowing white for peace, gold for trade … */
function drawThread(ctx, fx, t, r, now) {
  if (!Number.isFinite(fx.x2) || !Number.isFinite(fx.y2)) return;
  const a0 = r.e2s(fx.x, fx.y), a1 = r.e2s(fx.x2, fx.y2);
  const col = THREAD[fx.tone] || fx.color || THREAD.peace;
  const grow = Math.min(1, t / 0.3);
  const fade = t > 0.65 ? (1 - t) / 0.35 : 1;
  const dx = a1.sx - a0.sx, dy = a1.sy - a0.sy, L = Math.hypot(dx, dy) || 1;
  const nx = -dy / L, ny = dx / L;
  const hate = fx.tone === 'hate' || fx.tone === 'war' || fx.tone === 'bane';
  const N = Math.max(8, Math.min(48, Math.round(L / 14)));
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const path = () => {
    ctx.beginPath();
    for (let k = 0; k <= N * grow; k++) {
      const u = k / N;
      // an arc lifted off the land, jagged or rippling along its length
      const lift = Math.sin(u * Math.PI) * Math.min(80, L * 0.18);
      const wob = hate ? (k % 2 ? 1 : -1) * 4 * Math.sin(u * Math.PI) : Math.sin(u * 14 - now * 0.008) * 2.2 * Math.sin(u * Math.PI);
      const x = a0.sx + dx * u + nx * wob, y = a0.sy + dy * u + ny * wob - lift;
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
  };
  ctx.globalAlpha = 0.55 * fade; ctx.strokeStyle = 'rgba(14,12,10,0.7)'; ctx.lineWidth = 5; path(); ctx.stroke();
  ctx.globalAlpha = fade; ctx.strokeStyle = css(col); ctx.lineWidth = hate ? 2.6 : 2.2;
  if (!hate) { ctx.setLineDash([10, 6]); ctx.lineDashOffset = -now * 0.04; }
  path(); ctx.stroke(); ctx.setLineDash([]);
  // the far end blooms when the thread arrives
  if (grow >= 1) { ring(ctx, a1.sx, a1.sy, 6 + (t - 0.3) * 30, css(col), fade * 0.8, 2); }
  ring(ctx, a0.sx, a0.sy, 5 + t * 12, css(col), fade * 0.6, 1.6);
}

const KIT = {
  bless(ctx, fx, t, sx, sy, R, z, now, P) {
    const fade = kitFade(t), ease = 1 - Math.pow(1 - t, 3);
    glow(ctx, sx, sy, R * 1.3 + 18, [255, 226, 150], fade * 0.6);
    rays(ctx, sx, sy, R * 0.25, R * 1.25 + 24, 18, [255, 236, 170], fade * 0.75, now * 0.0005 + fx.seed, 1.6);
    ring(ctx, sx, sy, R * (0.3 + ease * 0.9), 'rgb(255,224,140)', (1 - t) * 0.85, 2.2);
    if (fx.spawned < 60 && t < 0.7) { for (let k = 0; k < 3; k++, fx.spawned++) P.spawn(PK.GOLD, fx.x + (Math.random() - 0.5) * fx.r, fx.y + (Math.random() - 0.5) * fx.r, (Math.random() - 0.5) * 0.3, -0.5 - Math.random() * 0.7, 0.08 + Math.random() * 0.06, 1.2 + Math.random() * 0.8, 0, 1); }
  },
  curse(ctx, fx, t, sx, sy, R, z, now, P) {
    const fade = kitFade(t);
    // a violet-black ring collapsing inward
    const rr = R * (1.5 - 1.1 * Math.min(1, t * 1.4));
    glow(ctx, sx, sy, R * 1.4, [60, 10, 50], fade * 0.55);
    ring(ctx, sx, sy, rr, 'rgb(60,16,58)', fade * 0.9, 3.5);
    ring(ctx, sx, sy, rr * 0.86, 'rgb(150,40,90)', fade * 0.6, 1.4);
    // red fissures
    ctx.globalAlpha = fade * 0.85; ctx.strokeStyle = 'rgb(176,30,24)'; ctx.lineWidth = Math.max(1.2, Math.min(2.6, z * 0.1));
    let rnd = fx.seed;
    const rand = () => { rnd = (rnd * 9301 + 49297) % 233280; return rnd / 233280; };
    ctx.beginPath();
    const grow = Math.min(1, t * 2.5);
    for (let k = 0; k < 6; k++) {
      let a = rand() * Math.PI * 2, x = sx, y = sy;
      ctx.moveTo(x, y);
      for (let j = 0; j < 4; j++) { a += (rand() - 0.5) * 1.1; x += Math.cos(a) * R * 0.16 * grow; y += Math.sin(a) * R * 0.16 * grow; ctx.lineTo(x, y); }
    }
    ctx.stroke();
    if (fx.spawned < 40 && t < 0.6) {
      for (let k = 0; k < 2; k++, fx.spawned++) P.spawn(PK.ASH, fx.x + (Math.random() - 0.5) * fx.r * 1.4, fx.y - fx.r * 0.6, (Math.random() - 0.5) * 0.2, 0.3 + Math.random() * 0.3, 0.12 + Math.random() * 0.1, 2 + Math.random(), 0.05, 0.7);
      if (fx.spawned % 5 === 0) P.spawn(PK.FEATHER, fx.x + (Math.random() - 0.5) * fx.r, fx.y - fx.r * 0.3, (Math.random() - 0.5) * 0.6, -0.25, 0.12, 2.2, 0, 0.9);
    }
  },
  terraform(ctx, fx, t, sx, sy, R, z, now, P) {
    const fade = kitFade(t), ease = 1 - Math.pow(1 - t, 2);
    const up = (fx.sign ?? 1) >= 0;
    const I = Math.max(0.3, Math.min(1.5, fx.intensity || 0.6));
    // a dust ring thrown out by a rise, drawn in by a sinking
    const rr = up ? R * (0.4 + ease * 1.1) : R * (1.5 - ease * 1.0);
    ring(ctx, sx, sy, rr, 'rgb(150,118,80)', fade * 0.7 * I, 4 * I);
    ring(ctx, sx, sy, rr + 3, 'rgb(236,214,170)', fade * 0.35, 1.4);
    if (fx.spawned < 40 * I && t < 0.5) {
      for (let k = 0; k < 4; k++, fx.spawned++) {
        const a = Math.random() * Math.PI * 2, v = (up ? 1 : -0.6) * (0.4 + Math.random() * 1.2);
        P.spawn(PK.DUST, fx.x + Math.cos(a) * fx.r * (up ? 0.3 : 1), fx.y + Math.sin(a) * fx.r * (up ? 0.3 : 1), Math.cos(a) * v, Math.sin(a) * v - 0.2, 0.25 + Math.random() * 0.3, 1.2 + Math.random(), 0.3, 0.6);
        if (k === 0) P.spawn(PK.SPARK, fx.x, fx.y, Math.cos(a) * 1.6, Math.sin(a) * 1.6 - 0.8, 0.05, 0.6, 0, 0.6);
      }
    }
  },
  sprout(ctx, fx, t, sx, sy, R, z, now, P) {
    const fade = kitFade(t), ease = 1 - Math.pow(1 - t, 3);
    glow(ctx, sx, sy, R * 1.1, [140, 210, 110], fade * 0.45);
    ring(ctx, sx, sy, R * (0.3 + ease), 'rgb(120,190,90)', (1 - t) * 0.8, 2);
    if (fx.spawned < 50 && t < 0.7) for (let k = 0; k < 3; k++, fx.spawned++) P.spawn(PK.LEAF, fx.x + (Math.random() - 0.5) * fx.r * 1.4, fx.y + (Math.random() - 0.5) * fx.r * 1.2, (Math.random() - 0.5) * 0.5, -0.45 - Math.random() * 0.4, 0.14 + Math.random() * 0.08, 1.6 + Math.random(), 0, 1);
  },
  spawn(ctx, fx, t, sx, sy, R, z, now, P) {
    const fade = kitFade(t);
    const glyph = fx.glyph || 'herd';
    let rnd = fx.seed;
    const rand = () => { rnd = (rnd * 9301 + 49297) % 233280; return rnd / 233280; };
    if (glyph === 'fish') {
      // fish leaping in arcs
      ctx.strokeStyle = 'rgb(220,236,244)'; ctx.lineWidth = 1.6;
      for (let k = 0; k < 9; k++) {
        const ph = (t * 2.2 + rand()) % 1, a = rand() * Math.PI * 2, d = rand() * R;
        const x = sx + Math.cos(a) * d, y = sy + Math.sin(a) * d;
        const h = Math.sin(ph * Math.PI) * (6 + R * 0.12);
        ctx.globalAlpha = fade * Math.sin(ph * Math.PI);
        ctx.fillStyle = 'rgb(176,206,220)';
        ctx.beginPath(); ctx.ellipse(x + (ph - 0.5) * 12, y - h, 3, 1.4, (ph - 0.5) * 1.4, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(x, y, 3 + ph * 4, 0, Math.PI * 2); ctx.globalAlpha *= 0.5; ctx.stroke();
      }
    } else if (glyph === 'pred') {
      // eyes in the dark, blinking
      for (let k = 0; k < 7; k++) {
        const a = rand() * Math.PI * 2, d = R * (0.3 + rand() * 0.8);
        const x = sx + Math.cos(a) * d, y = sy + Math.sin(a) * d;
        const blink = Math.sin(now * 0.006 + k * 1.7) > -0.6 ? 1 : 0.1;
        ctx.globalAlpha = fade * blink;
        ctx.fillStyle = 'rgb(255,214,90)';
        ctx.beginPath(); ctx.arc(x - 2.2, y, 1.4, 0, Math.PI * 2); ctx.arc(x + 2.2, y, 1.4, 0, Math.PI * 2); ctx.fill();
      }
    } else {
      // a herd running outward
      ctx.fillStyle = 'rgb(92,70,50)';
      for (let k = 0; k < 16; k++) {
        const a = rand() * Math.PI * 2, d0 = rand() * R * 0.3;
        const d = d0 + t * R * (0.8 + rand() * 0.6);
        const x = sx + Math.cos(a) * d, y = sy + Math.sin(a) * d;
        ctx.globalAlpha = fade;
        ctx.beginPath(); ctx.ellipse(x, y, 2.6, 1.6, a, 0, Math.PI * 2); ctx.fill();
        if (t < 0.6 && k % 3 === 0) { ctx.globalAlpha = fade * 0.35; ctx.beginPath(); ctx.arc(x - Math.cos(a) * 5, y - Math.sin(a) * 5, 2.5, 0, Math.PI * 2); ctx.fillStyle = 'rgb(196,170,128)'; ctx.fill(); ctx.fillStyle = 'rgb(92,70,50)'; }
      }
    }
    ring(ctx, sx, sy, R * (0.4 + t * 0.8), 'rgb(200,220,170)', (1 - t) * 0.5, 1.4);
  },
  raincall(ctx, fx, t, sx, sy, R, z, now, P) {
    const fade = kitFade(t);
    ctx.globalAlpha = fade * 0.28; ctx.fillStyle = 'rgb(40,60,90)';
    ctx.beginPath(); ctx.arc(sx, sy, R * 1.15, 0, Math.PI * 2); ctx.fill();
    if (fx.spawned < 160 && t < 0.8) for (let k = 0; k < 6; k++, fx.spawned++) P.spawn(PK.RAIN, fx.x + (Math.random() - 0.5) * fx.r * 2, fx.y + (Math.random() - 0.5) * fx.r * 2 - fx.r * 0.4, -0.3, 3 + Math.random() * 1.5, 0.12, 0.35 + Math.random() * 0.25, 0, 0.9);
    for (let k = 0; k < 3; k++) { const p = (t * 1.8 + k / 3) % 1; ring(ctx, sx + Math.sin(k * 2.1) * R * 0.4, sy + Math.cos(k * 1.7) * R * 0.3, 3 + p * 10, 'rgb(190,214,236)', fade * (1 - p) * 0.7, 1); }
  },
  parch(ctx, fx, t, sx, sy, R, z, now, P) {
    const fade = kitFade(t), ease = 1 - Math.pow(1 - t, 2);
    glow(ctx, sx, sy, R * 1.2, [255, 160, 60], fade * 0.32);
    // cracking ochre rings
    ctx.globalAlpha = fade * 0.75; ctx.strokeStyle = 'rgb(150,96,40)'; ctx.lineWidth = 1.6;
    let rnd = fx.seed;
    const rand = () => { rnd = (rnd * 9301 + 49297) % 233280; return rnd / 233280; };
    for (let k = 1; k <= 3; k++) {
      ctx.beginPath();
      for (let q = 0; q <= 24; q++) { const a = (q / 24) * Math.PI * 2, rr = R * (0.3 * k) * ease * (1 + (rand() - 0.5) * 0.25); if (q) ctx.lineTo(sx + Math.cos(a) * rr, sy + Math.sin(a) * rr); else ctx.moveTo(sx + Math.cos(a) * rr, sy + Math.sin(a) * rr); }
      ctx.stroke();
    }
    // heat shimmer
    ctx.globalAlpha = fade * 0.4; ctx.strokeStyle = 'rgb(255,236,190)'; ctx.lineWidth = 1.2;
    for (let k = 0; k < 4; k++) {
      ctx.beginPath();
      const y0 = sy - R * 0.4 + k * R * 0.25;
      for (let q = 0; q <= 16; q++) { const x = sx - R * 0.6 + (q / 16) * R * 1.2, y = y0 + Math.sin(q * 0.9 + now * 0.012 + k) * 2.4 - t * 10; if (q) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
      ctx.stroke();
    }
  },
  swirl(ctx, fx, t, sx, sy, R, z, now, P) {
    const fade = kitFade(t);
    const rot = now * 0.006;
    ctx.globalAlpha = fade * 0.8; ctx.strokeStyle = 'rgb(232,240,248)'; ctx.lineWidth = 2;
    for (let arm = 0; arm < 3; arm++) {
      ctx.beginPath();
      for (let k = 0; k <= 20; k++) { const q = k / 20, a = rot + arm * 2.09 - q * 3.2, rr = R * (0.15 + q * 0.9) * (0.6 + t * 0.6); const x = sx + Math.cos(a) * rr, y = sy + Math.sin(a) * rr; if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
      ctx.stroke();
    }
  },
  rewind(ctx, fx, t, sx, sy, R, z, now, P) {
    const fade = kitFade(t);
    const RR = Math.max(26, R);
    glow(ctx, sx, sy, RR * 1.3, [236, 214, 170], fade * 0.4);
    ring(ctx, sx, sy, RR, 'rgb(236,214,170)', fade * 0.9, 2.4);
    // the hand of a clock sweeping backward, with ticks
    ctx.globalAlpha = fade; ctx.strokeStyle = 'rgb(236,214,170)'; ctx.lineWidth = 2;
    const a = -Math.PI / 2 - t * Math.PI * 4;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + Math.cos(a) * RR * 0.8, sy + Math.sin(a) * RR * 0.8); ctx.stroke();
    ctx.beginPath(); for (let k = 0; k < 12; k++) { const b = (k / 12) * Math.PI * 2; ctx.moveTo(sx + Math.cos(b) * RR * 0.86, sy + Math.sin(b) * RR * 0.86); ctx.lineTo(sx + Math.cos(b) * RR, sy + Math.sin(b) * RR); } ctx.stroke();
    // counter-clockwise arrowhead
    const b = a + 0.0, ax = sx + Math.cos(b) * RR, ay = sy + Math.sin(b) * RR;
    ctx.fillStyle = 'rgb(236,214,170)'; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax + Math.cos(b + 2.4) * 8, ay + Math.sin(b + 2.4) * 8); ctx.lineTo(ax + Math.cos(b - 0.9) * 7, ay + Math.sin(b - 0.9) * 7); ctx.closePath(); ctx.fill();
  },
  riot(ctx, fx, t, sx, sy, R, z, now, P) {
    const fade = kitFade(t);
    const fl = 0.7 + 0.3 * Math.sin(now * 0.04 + fx.seed);
    glow(ctx, sx, sy, R * 1.1 * fl, [230, 90, 40], fade * 0.5);
    ctx.globalAlpha = fade * 0.9; ctx.strokeStyle = 'rgb(170,36,30)'; ctx.lineWidth = 2.2;
    const rr = R * (0.6 + 0.2 * Math.sin(now * 0.02));
    ctx.beginPath();
    for (let k = 0; k <= 20; k++) { const a = (k / 20) * Math.PI * 2; const q = k & 1 ? rr * 0.78 : rr; ctx.lineTo(sx + Math.cos(a) * q, sy + Math.sin(a) * q); }
    ctx.stroke();
    // torches
    for (let k = 0; k < 6; k++) {
      const a = fx.seed + k * 1.05 + Math.sin(now * 0.003 + k) * 0.3, d = R * 0.45;
      const x = sx + Math.cos(a) * d, y = sy + Math.sin(a) * d;
      glow(ctx, x, y, 5 + 2 * Math.sin(now * 0.05 + k), [255, 170, 60], fade * 0.9);
    }
    if (fx.spawned < 30 && Math.random() < 0.5) { fx.spawned++; P.spawn(PK.EMBER, fx.x + (Math.random() - 0.5) * fx.r, fx.y, (Math.random() - 0.5) * 0.8, -0.8 - Math.random(), 0.07, 0.8, 0, 1); }
  },
  fair(ctx, fx, t, sx, sy, R, z, now, P) {
    const fade = kitFade(t);
    // bunting strung round the market: coloured pennants on a ring
    const rr = R * 0.7;
    const cols = ['rgb(214,72,60)', 'rgb(236,196,80)', 'rgb(80,140,200)', 'rgb(110,170,90)', 'rgb(200,110,170)'];
    ctx.globalAlpha = fade; ctx.strokeStyle = 'rgba(80,60,40,0.8)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(sx, sy, rr, 0, Math.PI * 2); ctx.stroke();
    for (let k = 0; k < 18; k++) {
      const a = (k / 18) * Math.PI * 2 + now * 0.0004, x = sx + Math.cos(a) * rr, y = sy + Math.sin(a) * rr;
      ctx.fillStyle = cols[k % cols.length];
      ctx.beginPath(); ctx.moveTo(x - 3, y); ctx.lineTo(x + 3, y); ctx.lineTo(x, y + 6); ctx.closePath(); ctx.fill();
    }
    if (fx.spawned < 60 && t < 0.7) for (let k = 0; k < 2; k++, fx.spawned++) P.spawn(PK.GOLD, fx.x + (Math.random() - 0.5) * fx.r, fx.y - fx.r * 0.3, (Math.random() - 0.5) * 0.8, -0.6 - Math.random() * 0.5, 0.06, 1.2, 0, 1);
  },
};
const kitFade = (t) => (t < 0.08 ? t / 0.08 : 1 - Math.pow(Math.max(0, (t - 0.08) / 0.92), 1.5));

function defaultR(type) {
  return { meteor: 3, quake: 6, tsunami: 14, eruption: 4, landfall: 4, flood: 3, divine: 3, fire: 2, plague: 3, faith: 3,
    raincall: 2.5, parch: 2.5, rewind: 3, riot: 1.5, fair: 1.5, label: 1, thread: 1 }[type] || 2;
}

function ring(ctx, x, y, r, color, a, w) {
  if (r <= 0 || a <= 0) return;
  ctx.globalAlpha = Math.min(1, a);
  ctx.strokeStyle = color; ctx.lineWidth = w;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
}
function glow(ctx, x, y, r, rgb, a) {
  if (r <= 0 || a <= 0) return;
  const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
  gr.addColorStop(0, css(rgb, Math.min(1, a)));
  gr.addColorStop(0.4, css(rgb, Math.min(1, a) * 0.45));
  gr.addColorStop(1, css(rgb, 0));
  ctx.globalAlpha = 1;
  ctx.fillStyle = gr;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}
function rays(ctx, x, y, r0, r1, n, rgb, a, rot, w) {
  ctx.globalAlpha = Math.min(1, a);
  ctx.strokeStyle = css(rgb); ctx.lineWidth = w;
  ctx.beginPath();
  for (let k = 0; k < n; k++) {
    const ang = rot + (k / n) * Math.PI * 2;
    ctx.moveTo(x + Math.cos(ang) * r0, y + Math.sin(ang) * r0);
    ctx.lineTo(x + Math.cos(ang) * r1, y + Math.sin(ang) * r1);
  }
  ctx.stroke();
}
function bannerFx(ctx, x, y, s, rgb, a) {
  ctx.globalAlpha = a;
  ctx.strokeStyle = 'rgb(44,34,26)'; ctx.lineWidth = Math.max(1, s * 0.1);
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - s * 1.8); ctx.stroke();
  ctx.fillStyle = css(rgb);
  ctx.beginPath(); ctx.moveTo(x, y - s * 1.8); ctx.lineTo(x + s, y - s * 1.6); ctx.lineTo(x, y - s * 1.1); ctx.closePath(); ctx.fill(); ctx.stroke();
}
function bolt(ctx, x0, y0, x1, y1, seed, w, scale = 1) {
  const n = 7;
  let rnd = seed;
  const rand = () => { rnd = (rnd * 9301 + 49297) % 233280; return rnd / 233280 - 0.5; };
  ctx.beginPath(); ctx.moveTo(x0, y0);
  for (let k = 1; k < n; k++) {
    const t = k / n;
    ctx.lineTo(x0 + (x1 - x0) * t + rand() * 14 * scale, y0 + (y1 - y0) * t + rand() * 5 * scale);
  }
  ctx.lineTo(x1, y1);
  ctx.lineWidth = w; ctx.stroke();
}

function drawOne(ctx, fx, t, sx, sy, R, z, now, P) {
  const fade = t < 0.1 ? t / 0.1 : 1 - Math.pow(Math.max(0, (t - 0.1) / 0.9), 1.6);
  const ease = 1 - Math.pow(1 - t, 3);
  const civ = fx.civColor || [214, 172, 92];
  const col = fx.color || civ;
  const lw = Math.max(1, Math.min(3, z * 0.12));
  switch (fx.type) {
    case 'meteor': {
      const tStrike = 0.12;
      if (t < tStrike) {
        const p = t / tStrike;
        const hx = sx - 260 * (1 - p), hy = sy - 340 * (1 - p);
        const gr = ctx.createLinearGradient(hx - 120, hy - 160, hx, hy);
        gr.addColorStop(0, 'rgba(255,200,120,0)'); gr.addColorStop(1, 'rgba(255,246,220,0.95)');
        ctx.strokeStyle = gr; ctx.lineWidth = 3 + Math.min(6, fx.r);
        ctx.beginPath(); ctx.moveTo(hx - 120, hy - 160); ctx.lineTo(hx, hy); ctx.stroke();
        glow(ctx, hx, hy, 16 + fx.r * 2, [255, 236, 190], 1);
      } else {
        const p = (t - tStrike) / (1 - tStrike);
        if (p < 0.08) glow(ctx, sx, sy, R * (2 + p * 20), [255, 250, 230], 1 - p / 0.08);
        ring(ctx, sx, sy, R * (0.6 + p * 4.5), 'rgb(255,236,200)', (1 - p) * 0.8, Math.max(1.5, 4 * (1 - p)));
        ring(ctx, sx, sy, R * (0.4 + p * 3), 'rgb(120,90,70)', (1 - p) * 0.5, Math.max(1, 3 * (1 - p)));
        glow(ctx, sx, sy, R * 1.2, [255, 120, 40], (1 - p) * 0.9);
        if (fx.spawned < 40 && p < 0.3) {
          for (let k = 0; k < 6; k++, fx.spawned++) {
            const a = Math.random() * Math.PI * 2, v = 0.6 + Math.random() * 2;
            P.spawn(PK.DUST, fx.x, fx.y, Math.cos(a) * v, Math.sin(a) * v, 0.5 + Math.random() * 0.6, 2 + Math.random() * 2, 0.4, 0.8);
            P.spawn(PK.EMBER, fx.x, fx.y, Math.cos(a) * v * 1.5, Math.sin(a) * v * 1.5 - 1, 0.12, 1 + Math.random(), 0, 1);
          }
        }
      }
      break;
    }
    case 'quake': {
      const amp = 0.4 + fx.intensity;
      for (let k = 0; k < 3; k++) {
        const p = t * 1.3 - k * 0.15;
        if (p <= 0 || p >= 1) continue;
        ring(ctx, sx, sy, R * p * amp, 'rgb(96,64,40)', (1 - p) * 0.75, lw * 1.6);
        ring(ctx, sx, sy, R * p * amp + 2, 'rgb(244,226,190)', (1 - p) * 0.35, lw);
      }
      // ground cracks
      ctx.globalAlpha = fade * 0.7; ctx.strokeStyle = 'rgb(60,40,28)'; ctx.lineWidth = lw;
      let rnd = fx.seed;
      const rand = () => { rnd = (rnd * 9301 + 49297) % 233280; return rnd / 233280; };
      ctx.beginPath();
      for (let k = 0; k < 5; k++) {
        let a = rand() * Math.PI * 2, x = sx, y = sy;
        ctx.moveTo(x, y);
        for (let j = 0; j < 4; j++) { a += (rand() - 0.5) * 0.9; x += Math.cos(a) * R * 0.12 * ease; y += Math.sin(a) * R * 0.12 * ease; ctx.lineTo(x, y); }
      }
      ctx.stroke();
      break;
    }
    case 'tsunami': {
      for (let k = 0; k < 4; k++) {
        const p = t * 1.2 - k * 0.12;
        if (p <= 0 || p >= 1) continue;
        ring(ctx, sx, sy, R * p, 'rgb(230,246,248)', (1 - p) * 0.85, lw * 2.2);
        ring(ctx, sx, sy, R * p - lw * 2.5, 'rgb(40,110,150)', (1 - p) * 0.5, lw * 1.2);
      }
      break;
    }
    case 'eruption': {
      const pulse = 0.75 + 0.25 * Math.sin(now * 0.02 + fx.seed);
      glow(ctx, sx, sy, R * (1.3 + fx.intensity) * pulse, [255, 110, 30], fade * 0.9);
      ring(ctx, sx, sy, R * (0.5 + ease * 2.5), 'rgb(255,190,120)', (1 - t) * 0.6, lw * 1.5);
      if (fx.spawned < 160) {
        const n = 3;
        for (let k = 0; k < n; k++, fx.spawned++) {
          P.spawn(PK.ASH, fx.x + (Math.random() - 0.5) * 0.4, fx.y, (Math.random() - 0.3) * 0.5, -0.8 - Math.random() * 1.2, 0.5 + Math.random() * 0.7 * (0.5 + fx.intensity), 3 + Math.random() * 3, 0.45, 0.8);
          P.spawn(PK.EMBER, fx.x, fx.y, (Math.random() - 0.5) * 2.4, -1.5 - Math.random() * 2.5, 0.1 + Math.random() * 0.08, 0.8 + Math.random() * 0.8, 0, 1);
        }
      }
      break;
    }
    case 'lightning': {
      // a flicker at world scale, a forked bolt up close
      const a = t < 0.15 ? 1 : 1 - (t - 0.15) / 0.85;
      const k = Math.max(0.3, Math.min(1.2, z / 12));
      glow(ctx, sx, sy, (16 + z * 1.2) * k, [220, 230, 255], a * 0.55);
      if (k > 0.35) {
        const top = sy - (26 + z * 2.4) * k, dx = ((fx.seed % 30) - 15) * k;
        ctx.globalAlpha = a * 0.6; ctx.strokeStyle = 'rgba(170,190,255,1)';
        bolt(ctx, sx + dx, top, sx, sy, fx.seed, 4.5 * k, k);
        ctx.globalAlpha = a; ctx.strokeStyle = 'rgba(250,250,255,1)';
        bolt(ctx, sx + dx, top, sx, sy, fx.seed, Math.max(1, 2 * k), k);
      }
      break;
    }
    case 'landfall': {
      const rot = now * 0.006;
      for (let k = 0; k < 3; k++) {
        ctx.globalAlpha = fade * 0.6;
        ctx.strokeStyle = 'rgb(236,244,248)'; ctx.lineWidth = lw * 2;
        ctx.beginPath(); ctx.arc(sx, sy, R * (0.6 + k * 0.35 + ease * 0.6), rot + k * 2.1, rot + k * 2.1 + 2.2); ctx.stroke();
      }
      if (fx.spawned < 30) for (let k = 0; k < 2; k++, fx.spawned++) P.spawn(PK.SPRAY, fx.x, fx.y, (Math.random() - 0.5) * 3, -Math.random() * 2, 0.15, 1, 0, 0.8);
      break;
    }
    case 'battle': {
      const pop = Math.min(1, t * 6);
      const s = (7 + fx.intensity * 6) * (0.7 + 0.3 * pop) * Math.max(0.8, Math.min(1.8, z / 10));
      glow(ctx, sx, sy, s * 2.2, [255, 120, 60], fade * 0.55);
      ctx.globalAlpha = fade; ctx.strokeStyle = 'rgb(40,30,22)'; ctx.lineWidth = 3.2;
      ctx.beginPath(); ctx.moveTo(sx - s, sy - s); ctx.lineTo(sx + s, sy + s); ctx.moveTo(sx + s, sy - s); ctx.lineTo(sx - s, sy + s); ctx.stroke();
      ctx.strokeStyle = 'rgb(236,230,216)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(sx - s, sy - s); ctx.lineTo(sx + s, sy + s); ctx.moveTo(sx + s, sy - s); ctx.lineTo(sx - s, sy + s); ctx.stroke();
      ctx.strokeStyle = 'rgb(214,172,92)'; ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.moveTo(sx - s * 0.5, sy + s * 0.2); ctx.lineTo(sx - s * 0.2, sy + s * 0.5); ctx.moveTo(sx + s * 0.5, sy + s * 0.2); ctx.lineTo(sx + s * 0.2, sy + s * 0.5); ctx.stroke();
      if (fx.spawned < 24 && Math.random() < 0.6) { fx.spawned++; const a = Math.random() * Math.PI * 2; P.spawn(PK.SPARK, fx.x, fx.y, Math.cos(a) * 1.5, Math.sin(a) * 1.5 - 0.5, 0.08, 0.5 + Math.random() * 0.4, 0, 1); }
      break;
    }
    case 'siege': {
      const pulse = 0.5 + 0.5 * Math.sin(now * 0.012 + fx.seed);
      ctx.setLineDash([4, 4]);
      ring(ctx, sx, sy, 10 + z * 0.9 + pulse * 3, 'rgb(208,72,52)', fade * 0.85, 2);
      ctx.setLineDash([]);
      // projectile arcs
      ctx.globalAlpha = fade * 0.8; ctx.strokeStyle = 'rgb(60,40,28)'; ctx.lineWidth = 1.2;
      const p = (t * 2) % 1;
      const ax = sx - 22, ay = sy + 4;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(sx - 10, sy - 26, sx, sy); ctx.stroke();
      ctx.fillStyle = 'rgb(255,170,90)';
      const bx = (1 - p) * (1 - p) * ax + 2 * (1 - p) * p * (sx - 10) + p * p * sx;
      const by = (1 - p) * (1 - p) * ay + 2 * (1 - p) * p * (sy - 26) + p * p * sy;
      ctx.beginPath(); ctx.arc(bx, by, 2, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case 'capture': {
      ring(ctx, sx, sy, 8 + ease * (24 + z), css(civ), (1 - t) * 0.9, 3);
      bannerFx(ctx, sx, sy - 2 - (1 - Math.min(1, t * 3)) * 10, 9, civ, fade);
      break;
    }
    case 'plague': {
      for (let k = 0; k < 3; k++) {
        const p = (t * 1.5 + k / 3) % 1;
        ring(ctx, sx, sy, R * (0.3 + p * 1.2), css(col), fade * (1 - p) * 0.8, lw * 1.4);
      }
      glow(ctx, sx, sy, R * 0.8, col, fade * 0.35);
      break;
    }
    case 'faith': {
      rays(ctx, sx, sy, 6, 14 + R * (0.8 + ease), 12, lighten(col, 0.3), fade * 0.75, now * 0.0008 + fx.seed, 1.6);
      glow(ctx, sx, sy, R * 0.9, lighten(col, 0.4), fade * 0.5);
      break;
    }
    case 'wonder': {
      rays(ctx, sx, sy, 8, 22 + R * 1.6 * ease, 16, [255, 220, 130], fade * 0.85, now * 0.0005, 2);
      glow(ctx, sx, sy, 26 + R, [255, 214, 120], fade * 0.6);
      ring(ctx, sx, sy, 10 + ease * (30 + R), 'rgb(255,230,160)', (1 - t) * 0.7, 2);
      if (fx.spawned < 40 && Math.random() < 0.7) { fx.spawned++; P.spawn(PK.GOLD, fx.x + (Math.random() - 0.5), fx.y + (Math.random() - 0.5), (Math.random() - 0.5) * 0.4, -0.6 - Math.random() * 0.6, 0.1, 1.2 + Math.random(), 0, 1); }
      break;
    }
    case 'founding': {
      ring(ctx, sx, sy, 5 + ease * (16 + z * 0.6), css(civ), (1 - t) * 0.85, 2);
      bannerFx(ctx, sx, sy - 1, 6 + Math.min(4, z * 0.2), civ, fade);
      break;
    }
    case 'newcivs': {
      rays(ctx, sx, sy, 10, 20 + 40 * ease, 10, lighten(civ, 0.2), fade * 0.8, now * 0.0007, 2.4);
      ring(ctx, sx, sy, 12 + ease * (40 + z), css(civ), (1 - t) * 0.9, 3);
      bannerFx(ctx, sx, sy - 2, 11, civ, fade);
      break;
    }
    case 'rebellion': {
      ctx.globalAlpha = fade * 0.9; ctx.strokeStyle = 'rgb(176,40,34)'; ctx.lineWidth = 2.4;
      const rr = 10 + ease * (24 + z * 0.8);
      ctx.beginPath();
      for (let k = 0; k <= 16; k++) { const a = (k / 16) * Math.PI * 2; const q = k & 1 ? rr * 0.72 : rr; ctx.lineTo(sx + Math.cos(a) * q, sy + Math.sin(a) * q); }
      ctx.stroke();
      glow(ctx, sx, sy, rr * 0.8, [200, 60, 40], fade * 0.35);
      if (fx.spawned < 16) { fx.spawned++; P.spawn(PK.EMBER, fx.x, fx.y, (Math.random() - 0.5) * 1.6, -1 - Math.random(), 0.1, 1, 0, 1); }
      break;
    }
    case 'fire': {
      const fl = 0.7 + 0.3 * Math.sin(now * 0.03 + fx.seed);
      glow(ctx, sx, sy, R * 1.4 * fl, [255, 140, 40], fade * 0.8);
      if (fx.spawned < 20) { fx.spawned++; P.spawn(PK.SMOKE, fx.x, fx.y, 0.1, -0.4, 0.5, 3, 0.5, 0.6); }
      break;
    }
    case 'flood': {
      ctx.globalAlpha = fade * 0.32; ctx.fillStyle = 'rgb(70,130,180)';
      ctx.beginPath(); ctx.arc(sx, sy, R * (0.5 + ease * 0.9), 0, Math.PI * 2); ctx.fill();
      for (let k = 0; k < 3; k++) { const p = (t * 1.4 + k / 3) % 1; ring(ctx, sx, sy, R * (0.3 + p * 1.2), 'rgb(200,228,240)', fade * (1 - p) * 0.8, lw); }
      break;
    }
    case 'divine': {
      glow(ctx, sx, sy, R * 1.5 + 20, [255, 236, 160], fade * 0.7);
      rays(ctx, sx, sy, R * 0.3, R * 1.4 + 26, 20, [255, 240, 190], fade * 0.6, now * 0.0004, 1.4);
      ring(ctx, sx, sy, R * (0.4 + ease * 1.2), 'rgb(255,226,140)', (1 - t) * 0.9, 2.2);
      break;
    }
    case 'famine': {
      ring(ctx, sx, sy, 8 + ease * (20 + z * 0.6), 'rgb(150,112,60)', fade * 0.8, 2);
      ctx.globalAlpha = fade * 0.7; ctx.fillStyle = 'rgb(120,90,50)';
      for (let k = 0; k < 6; k++) { const a = fx.seed + k; const d = 6 + ((t * 40 + k * 7) % 18); ctx.beginPath(); ctx.arc(sx + Math.cos(a) * 12, sy - 6 + d, 1.6, 0, Math.PI * 2); ctx.fill(); }
      break;
    }
    case 'discovery': {
      const s = 6 + Math.sin(t * Math.PI) * 6;
      ctx.globalAlpha = fade; ctx.fillStyle = 'rgb(140,236,220)';
      ctx.beginPath();
      for (let k = 0; k < 8; k++) { const a = -Math.PI / 2 + (k * Math.PI) / 4; const q = k & 1 ? s * 0.35 : s; ctx.lineTo(sx + Math.cos(a) * q, sy - 12 + Math.sin(a) * q); }
      ctx.closePath(); ctx.fill();
      ring(ctx, sx, sy, 6 + ease * (16 + z * 0.4), 'rgb(67,179,163)', (1 - t) * 0.8, 1.6);
      break;
    }
  }
}
