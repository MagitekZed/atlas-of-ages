// Map lettering: text pre-rendered with a parchment halo into cached sprites (optionally
// letter-spaced small capitals or italic), placed greedily by priority with a screen-space
// collision grid so labels never overlap.

import { SpriteCache } from './glyphs.js';
import { makeCanvas } from './terrain.js';

export const MAP_FONT = '"IM Fell English", "IM Fell DW Pica", "Iowan Old Style", "Palatino Linotype", Georgia, serif';
export const MAP_FONT_SC = '"IM Fell English SC", "IM Fell English", "Iowan Old Style", Georgia, serif';
/** Figures (army strengths and the like): lining numerals that stay legible when small. */
export const FIGURE_FONT = '"Alegreya Sans", "Gill Sans", "Segoe UI", system-ui, sans-serif';

const CELL = 40;

export class Labeler {
  constructor() {
    this.cache = new SpriteCache(1400);
    this.sizes = new Map();     // lettering (all but size) → the sizes cached for it
    this.moving = false; this.newThisFrame = 0;
    this.grid = new Map();      // placed lettering
    this.bgrid = new Map();     // icons and banners (block town names, not region names)
    this.sgrid = new Map();     // soft reservations: capitals and their names (region names prefer to avoid)
    this.pgrid = new Map();     // town plans' footprints: only a town's own lettering (and what stands in it) goes there
    this.rects = [];
    this.log = null;            // while set, the lettering rects placed (a placement being cached)
    this.dpr = 1;
    this.fontEpoch = 0;
    this.measureCtx = makeCanvas(4, 4).getContext('2d');
    if (typeof document !== 'undefined' && document.fonts) {
      try {
        const bump = () => { this.cache.clear(); this.sizes.clear(); this.fontEpoch++; };
        document.fonts.addEventListener?.('loadingdone', bump);
        for (const f of ['16px "IM Fell English"', 'italic 16px "IM Fell English"', '16px "IM Fell English SC"', '700 16px "Alegreya Sans"']) {
          document.fonts.load(f).then(bump, () => {});
        }
      } catch (e) { /* font loading API unavailable */ }
    }
  }

  /**
   * Start a frame's lettering. While `moving` (the zoom is changing) a name whose exact size is
   * not cached is shown as a scaled copy of a nearby cached size, and only a few new sizes are
   * lettered per frame, so a zoom sweep does not re-letter the whole map every frame.
   */
  begin(dpr, moving = false) {
    this.dpr = dpr;
    this.moving = moving;
    this.newThisFrame = 0;
    this.grid.clear();
    this.bgrid.clear();
    this.sgrid.clear();
    this.pgrid.clear();
    this.rects.length = 0;
  }

  /** Softly reserve a rect: region names avoid it when they can, town names ignore it. */
  reserve(x0, y0, x1, y1) { this._add(x0, y0, x1, y1, this.sgrid); }

  /** Reserve a screen rect (CSS px) for an icon: town labels avoid it, region names may cross it. */
  block(x0, y0, x1, y1) { this._add(x0, y0, x1, y1, this.bgrid); }

  /**
   * A town plan's footprint, a circle (CSS px) kept as three overlapping rects: site, feature
   * and other minor lettering keeps off it; the town's own name, its epithet and what stands
   * in the town (armies, wonders) may sit on it.
   */
  plan(cx, cy, rad) {
    const a = rad * 0.45, b = rad * 0.7;
    this._add(cx - rad, cy - a, cx + rad, cy + a, this.pgrid);
    this._add(cx - a, cy - rad, cx + a, cy + rad, this.pgrid);
    this._add(cx - b, cy - b, cx + b, cy + b, this.pgrid);
  }

  _cells(x0, y0, x1, y1, fn) {
    const cx0 = Math.floor(x0 / CELL), cx1 = Math.floor(x1 / CELL), cy0 = Math.floor(y0 / CELL), cy1 = Math.floor(y1 / CELL);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) if (fn(cx * 73856093 ^ cy * 19349663) === false) return false;
    return true;
  }
  _add(x0, y0, x1, y1, grid = this.grid) {
    const r = [x0, y0, x1, y1];
    this.rects.push(r);
    if (this.log && grid === this.grid) this.log.push(r);
    this._cells(x0, y0, x1, y1, (k) => { const a = grid.get(k); if (a) a.push(r); else grid.set(k, [r]); });
  }
  _free(grid, x0, y0, x1, y1) {
    return this._cells(x0, y0, x1, y1, (k) => {
      const a = grid.get(k);
      if (!a) return true;
      for (const r of a) if (x0 < r[2] && x1 > r[0] && y0 < r[3] && y1 > r[1]) return false;
      return true;
    });
  }
  /**
   * Is the rect clear? Always of lettering; of town plans unless `overPlan` (or `mode` is
   * 'over'); of icons unless `mode` is true / 'over' / 'soft'; of soft reservations when `mode`
   * is 'soft'.
   */
  free(x0, y0, x1, y1, mode = false, overPlan = false) {
    if (!this._free(this.grid, x0, y0, x1, y1)) return false;
    if (!overPlan && mode !== 'over' && this.pgrid.size && !this._free(this.pgrid, x0, y0, x1, y1)) return false;
    if (mode === 'soft') return this._free(this.sgrid, x0, y0, x1, y1);
    return mode === true || mode === 'over' || this._free(this.bgrid, x0, y0, x1, y1);
  }

  /**
   * Text sprite. style: { size, italic, sc, bold, figures (sans lining numerals), color, halo, haloW, spacing }.
   * Returns { canvas, w, h, tw } in CSS px (centre origin).
   */
  sprite(text, st) {
    // sizes snap to a grid of 12 steps per octave; halo and letter-spacing scale with them
    const want = Math.max(6, st.size);
    const size = Math.max(6, Math.round(Math.pow(2, Math.round(Math.log2(want) * 12) / 12) * 4) / 4);
    const k = size / want;
    const haloW = st.halo ? (st.haloW ?? Math.max(2, want * 0.18)) * k : 0;
    const spacing = (st.spacing || 0) * k;
    const base = `${text}|${st.italic ? 1 : 0}${st.sc ? 1 : 0}${st.bold ? 1 : 0}${st.figures ? 1 : 0}|${st.color}|${st.halo || ''}|${Math.round((haloW / size) * 40)}|${Math.round((spacing / size) * 40)}|${this.dpr}|${this.fontEpoch}`;
    const key = base + '|' + size;
    const hit = this.cache.map.get(key);
    if (hit) { this.cache.map.delete(key); this.cache.map.set(key, hit); return hit; }
    if (this.moving || this.newThisFrame >= 24) {
      // stand in a cached size of the same lettering, scaled (re-lettered once the zoom settles)
      const sizes = this.sizes.get(base);
      if (sizes) {
        let best = null, br = Infinity;
        for (const sz of sizes) {
          const sp = this.cache.map.get(base + '|' + sz);
          if (!sp) { sizes.delete(sz); continue; }
          const r = Math.abs(Math.log(sz / size));
          if (r < br) { br = r; best = sp; }
        }
        if (best && (br < 0.45 || this.newThisFrame >= 24)) {
          const sc = size / best.size;
          return { canvas: best.canvas, w: best.w * sc, h: best.h * sc, tw: best.tw * sc, size, scaled: true };
        }
      }
    }
    this.newThisFrame++;
    let sizes = this.sizes.get(base);
    if (!sizes) { sizes = new Set(); this.sizes.set(base, sizes); if (this.sizes.size > 4000) this.sizes.delete(this.sizes.keys().next().value); }
    sizes.add(size);
    return this.cache.get(key, () => {
      const dpr = this.dpr;
      const font = `${st.italic ? 'italic ' : ''}${st.bold ? (st.figures ? '700 ' : '600 ') : ''}${size}px ${st.figures ? FIGURE_FONT : st.sc ? MAP_FONT_SC : MAP_FONT}`;
      const m = this.measureCtx;
      m.font = font;
      const chars = spacing ? Array.from(text) : null;
      let tw;
      if (chars) { tw = 0; for (const ch of chars) tw += m.measureText(ch).width + spacing; tw -= spacing; }
      else tw = m.measureText(text).width;
      const pad = Math.ceil(haloW + 2);
      const w = Math.ceil(tw + pad * 2), h = Math.ceil(size * 1.3 + pad * 2);
      const c = makeCanvas(Math.max(1, Math.ceil(w * dpr)), Math.max(1, Math.ceil(h * dpr)));
      const g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.font = font;
      g.textBaseline = 'middle';
      g.lineJoin = 'round';
      const y = h / 2 + size * 0.04;
      const drawText = (fnName) => {
        if (!chars) { g[fnName](text, pad, y); return; }
        let x = pad;
        for (const ch of chars) { g[fnName](ch, x, y); x += m.measureText(ch).width + spacing; }
      };
      if (haloW > 0) {
        g.strokeStyle = st.halo; g.lineWidth = haloW * 2;
        drawText('strokeText');
      }
      g.fillStyle = st.color;
      drawText('fillText');
      return { canvas: c, w, h, tw, size };
    });
  }

  /**
   * Try to place a label centred at (x, y) (CSS px) with rotation `angle`.
   * Returns the sprite if placed (caller draws it), else null.
   */
  tryPlace(text, st, x, y, angle = 0, margin = 2, viewW = Infinity, viewH = Infinity, mode = false, overPlan = false) {
    if (!text || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    const sp = this.sprite(text, st);
    const tw = sp.tw + 4, th = (sp.size || st.size) * 1.05;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const c = Math.abs(ca), s = Math.abs(sa);
    const hw = (tw * c + th * s) / 2 + margin, hh = (tw * s + th * c) / 2 + margin;
    // keep lettering wholly on screen
    if (x - hw < 1 || y - hh < 1 || x + hw > viewW - 1 || y + hh > viewH - 1) return null;
    if (s < 0.06) {
      const x0 = x - hw, y0 = y - hh, x1 = x + hw, y1 = y + hh;
      if (!this.free(x0, y0, x1, y1, mode, overPlan)) return null;
      this._add(x0, y0, x1, y1);
      return sp;
    }
    // rotated lettering: a chain of small boxes along the baseline rather than one big
    // axis-aligned box, so slanted names pack as tightly as they look
    const n = Math.max(2, Math.ceil(tw / (th * 1.4)));
    const seg = tw / n;
    const bw = (seg * c + th * s) / 2 + margin, bh = (seg * s + th * c) / 2 + margin;
    const boxes = [];
    for (let k = 0; k < n; k++) {
      const d = -tw / 2 + seg * (k + 0.5);
      const cx = x + ca * d, cy = y + sa * d;
      const b = [cx - bw, cy - bh, cx + bw, cy + bh];
      if (!this.free(b[0], b[1], b[2], b[3], mode, overPlan)) return null;
      boxes.push(b);
    }
    for (const b of boxes) this._add(b[0], b[1], b[2], b[3]);
    return sp;
  }

  draw(ctx, sp, x, y, angle = 0, alpha = 1) {
    const dpr = this.dpr;
    ctx.globalAlpha = alpha;
    if (angle) {
      ctx.save();
      ctx.translate(x, y); ctx.rotate(angle);
      ctx.drawImage(sp.canvas, -sp.w / 2, -sp.h / 2, sp.w, sp.h);
      ctx.restore();
    } else {
      ctx.drawImage(sp.canvas, Math.round((x - sp.w / 2) * dpr) / dpr, Math.round((y - sp.h / 2) * dpr) / dpr, sp.w, sp.h);
    }
    ctx.globalAlpha = 1;
  }
}
