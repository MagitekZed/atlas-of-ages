// Camera: view centre (x, y) in map coordinates, where tile (x, y) covers [x, x+1) × [y, y+1)
// (so a tile's centre is x + 0.5), and zoom in CSS pixels per tile.
// Wheel zoom eases toward a target while keeping the point under the cursor fixed;
// focusOn flies along a van Wijk–Nuij optimal zoom/pan path.

import { clamp } from '../core/util.js';

const RHO = Math.SQRT2, RHO2 = 2, RHO4 = 4;

export class Camera {
  constructor() {
    this.x = 0; this.y = 0; this.zoom = 4;
    this.viewW = 1; this.viewH = 1;      // CSS pixels
    this.worldW = 1; this.worldH = 1;    // tiles
    this.minZoom = 0.5; this.maxZoom = 80;
    this.maxZoomCap = 80;                // the renderer raises it to 320 once its chunk pyramid serves deep zoom
    this.insetTop = 0; this.insetBottom = 0;   // CSS px of the view covered by UI (phone sheet, HUD)
    this.reducedMotion = false;
    this._zoomAnim = null;               // { target, sx, sy, tx, ty }
    this._flight = null;                 // { t0, dur, interp }
    this.moving = false;                 // true while any animation runs
  }

  setView(w, h) {
    this.viewW = Math.max(1, w || 1); this.viewH = Math.max(1, h || 1);
    this._limits();
    this.clampPosition();
  }

  /** Parts of the view hidden under UI: the world may pan far enough to show its edges above them. */
  setInsets(top = 0, bottom = 0) {
    const t = Number.isFinite(top) ? Math.max(0, top) : 0, b = Number.isFinite(bottom) ? Math.max(0, bottom) : 0;
    // never let the insets swallow the whole view
    const room = Math.max(0, this.viewH - 48);
    const k = t + b > room && t + b > 0 ? room / (t + b) : 1;
    this.insetTop = t * k; this.insetBottom = b * k;
  }

  setWorld(W, H) {
    this.worldW = Math.max(1, W); this.worldH = Math.max(1, H);
    this._limits();
  }

  _limits() {
    const fit = this.fitZoom();
    this.minZoom = Math.max(0.25, fit * 0.7);
    this.maxZoom = Math.max(this.minZoom * 2, this.maxZoomCap || 80);
  }

  fitZoom() {
    return Math.max(0.05, Math.min(this.viewW / this.worldW, this.viewH / this.worldH) * 0.97);
  }

  fit() {
    this._zoomAnim = null; this._flight = null;
    this.zoom = this.fitZoom();
    this.x = this.worldW / 2; this.y = this.worldH / 2;
  }

  /** Keep the view centre over the world and zoom within limits. */
  clampPosition() {
    if (!Number.isFinite(this.zoom) || this.zoom <= 0) this.zoom = this.fitZoom();
    this.zoom = clamp(this.zoom, this.minZoom, this.maxZoom);
    if (!Number.isFinite(this.x)) this.x = this.worldW / 2;
    if (!Number.isFinite(this.y)) this.y = this.worldH / 2;
    // a world wider than the view may pan until its edge sits an eighth of the way in;
    // a world narrower than the view stays near the middle
    const hw = this.viewW / 2 / this.zoom, hh = this.viewH / 2 / this.zoom;
    const mx = Math.min(hw, (this.viewW * 0.125) / this.zoom), my = Math.min(hh, (this.viewH * 0.125) / this.zoom);
    const ax = hw - mx, ay = hh - my;
    if (this.worldW >= 2 * hw) this.x = clamp(this.x, ax, this.worldW - ax);
    else this.x = clamp(this.x, this.worldW / 2 - (hw - this.worldW / 2) * 0.5, this.worldW / 2 + (hw - this.worldW / 2) * 0.5);
    const iT = this.insetTop || 0, iB = this.insetBottom || 0;
    if (iT > 0 || iB > 0) {
      // part of the view is covered: the edges may come an eighth of the way into the open strip
      const S = Math.max(1, this.viewH - iT - iB);
      const lo = (this.viewH / 2 - iT - 0.125 * S) / this.zoom;
      const hi = this.worldH - (this.viewH / 2 - iB - 0.125 * S) / this.zoom;
      if (lo <= hi) this.y = clamp(this.y, lo, hi);
      else {
        // the world is shorter than the strip: keep it near the strip's middle
        const mid = this.worldH / 2 + (this.viewH / 2 - (iT + S / 2)) / this.zoom;
        const slack = Math.max(0, (S / this.zoom - this.worldH) * 0.25);
        this.y = clamp(this.y, mid - slack, mid + slack);
      }
    } else if (this.worldH >= 2 * hh) this.y = clamp(this.y, ay, this.worldH - ay);
    else this.y = clamp(this.y, this.worldH / 2 - (hh - this.worldH / 2) * 0.5, this.worldH / 2 + (hh - this.worldH / 2) * 0.5);
  }

  screenToWorld(sx, sy) {
    return { x: this.x + (sx - this.viewW / 2) / this.zoom, y: this.y + (sy - this.viewH / 2) / this.zoom };
  }
  worldToScreen(x, y) {
    return { sx: (x - this.x) * this.zoom + this.viewW / 2, sy: (y - this.y) * this.zoom + this.viewH / 2 };
  }

  pan(dx, dy) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this._flight = null;
    this.x -= dx / this.zoom; this.y -= dy / this.zoom;
    this.clampPosition();
    const za = this._zoomAnim;
    if (za) { const w = this.screenToWorld(za.sx, za.sy); za.tx = w.x; za.ty = w.y; }
  }

  /** Zoom by `factor` keeping screen point (sx, sy) fixed. Eased unless `instant`. */
  zoomAt(sx, sy, factor, instant = false) {
    if (!Number.isFinite(factor) || factor <= 0) return;
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) { sx = this.viewW / 2; sy = this.viewH / 2; }
    this._flight = null;
    const cur = this._zoomAnim ? this._zoomAnim.target : this.zoom;
    const target = clamp(cur * factor, this.minZoom, this.maxZoom);
    const w = this.screenToWorld(sx, sy);
    if (instant || this.reducedMotion) {
      this._zoomAnim = null;
      this.zoom = target;
      this._anchor(w.x, w.y, sx, sy);
      return;
    }
    this._zoomAnim = { target, sx, sy, tx: w.x, ty: w.y };
  }

  _anchor(tx, ty, sx, sy) {
    this.x = tx - (sx - this.viewW / 2) / this.zoom;
    this.y = ty - (sy - this.viewH / 2) / this.zoom;
    this.clampPosition();
  }

  /** Fly smoothly to (x, y) at an optional zoom. */
  focusOn(x, y, zoom) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const z1 = clamp(Number.isFinite(zoom) && zoom > 0 ? zoom : Math.max(this.zoom, Math.min(this.maxZoom, 14)), this.minZoom, this.maxZoom);
    this._zoomAnim = null;
    if (this.reducedMotion) { this._flight = null; this.x = x; this.y = y; this.zoom = z1; this.clampPosition(); return; }
    const vw = this.viewW;
    const interp = zoomInterpolator([this.x, this.y, vw / this.zoom], [x, y, vw / z1]);
    const dur = clamp(interp.duration * 0.55, 380, 1700);
    this._flight = { t0: null, dur, interp, x1: x, y1: y, z1 };
  }

  get animating() { return Boolean(this._flight || this._zoomAnim); }

  /** Advance animations. dtMs: elapsed since last frame. */
  update(nowMs, dtMs) {
    this.moving = false;
    const fl = this._flight;
    if (fl) {
      if (fl.t0 == null) fl.t0 = nowMs;
      let t = (nowMs - fl.t0) / fl.dur;
      if (!(t < 1)) t = 1;
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const [ux, uy, w] = fl.interp(e);
      if (Number.isFinite(ux) && Number.isFinite(uy) && Number.isFinite(w) && w > 0) {
        this.x = ux; this.y = uy; this.zoom = this.viewW / w;
      }
      if (t >= 1) { this.x = fl.x1; this.y = fl.y1; this.zoom = fl.z1; this._flight = null; }
      this.clampPosition();
      this.moving = true;
    }
    const za = this._zoomAnim;
    if (za) {
      const k = 1 - Math.exp(-Math.max(1, dtMs || 16) / 65);
      const lz = Math.log(this.zoom), lt = Math.log(za.target);
      let nz = Math.exp(lz + (lt - lz) * k);
      if (Math.abs(lt - lz) < 0.002) { nz = za.target; this._zoomAnim = null; }
      this.zoom = nz;
      this._anchor(za.tx, za.ty, za.sx, za.sy);
      this.moving = true;
    }
  }
}

/** d3-style optimal zoom interpolation between [x, y, viewWidth] triples. */
function zoomInterpolator(p0, p1) {
  const [ux0, uy0, w0] = p0, [ux1, uy1, w1] = p1;
  const dx = ux1 - ux0, dy = uy1 - uy0, d2 = dx * dx + dy * dy;
  let S, f;
  if (d2 < 1e-9) {
    S = Math.log(w1 / w0) / RHO;
    f = (t) => [ux0 + t * dx, uy0 + t * dy, w0 * Math.exp(RHO * t * S)];
  } else {
    const d1 = Math.sqrt(d2);
    const b0 = (w1 * w1 - w0 * w0 + RHO4 * d2) / (2 * w0 * RHO2 * d1);
    const b1 = (w1 * w1 - w0 * w0 - RHO4 * d2) / (2 * w1 * RHO2 * d1);
    const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
    const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
    S = (r1 - r0) / RHO;
    const coshr0 = Math.cosh(r0), sinhr0 = Math.sinh(r0);
    f = (t) => {
      const s = t * S;
      const u = (w0 / (RHO2 * d1)) * (coshr0 * Math.tanh(RHO * s + r0) - sinhr0);
      return [ux0 + u * dx, uy0 + u * dy, (w0 * coshr0) / Math.cosh(RHO * s + r0)];
    };
  }
  const duration = Number.isFinite(S) ? Math.abs(S) * 1000 : 600;
  f.duration = duration;
  return Object.assign(f, { duration });
}
