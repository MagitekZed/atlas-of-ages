// Atmosphere layers: a soft drifting cloud deck (cloud-field envelope × scrolling puffy
// noise, with its ground shadow baked into the same canvas) and twinkling sun glints on
// open water, drawn as crisp screen-space strokes.

import { makeCanvas, boxH, boxV } from './terrain.js';
import { hash2i } from '../core/rng.js';
import { WATER } from '../core/constants.js';

function tileableNoise(S, cells, seed, octaves = 3) {
  const out = new Float32Array(S * S);
  let amp = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const c = cells << o;
    const g = new Float32Array(c * c);
    for (let k = 0; k < g.length; k++) g[k] = hash2i(k % c, (k / c) | 0, seed + o * 101) / 4294967296;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = (x / S) * c, v = (y / S) * c;
      const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const a = g[(y0 % c) * c + (x0 % c)], b = g[(y0 % c) * c + ((x0 + 1) % c)];
      const cc = g[((y0 + 1) % c) * c + (x0 % c)], d = g[((y0 + 1) % c) * c + ((x0 + 1) % c)];
      out[y * S + x] += ((a + (b - a) * sx) * (1 - sy) + (cc + (d - cc) * sx) * sy) * amp;
    }
    norm += amp; amp *= 0.5;
  }
  for (let k = 0; k < out.length; k++) out[k] /= norm;
  return out;
}

export class Atmosphere {
  constructor(world) {
    this.world = world;
    const W = world.W, H = world.H;
    // cloud envelope from the cloud field (1 px per tile)
    this.env = makeCanvas(W, H);
    this.envCtx = this.env.getContext('2d');
    this.envImg = this.envCtx.createImageData(W, H);
    this.envBuf = new Uint32Array(this.envImg.data.buffer);
    const S = (this.CS = 2);
    this.puff = makeCanvas(W * S, H * S);        // white cloud alpha
    this.puffCtx = this.puff.getContext('2d');
    this.shade = makeCanvas(W * S, H * S);       // dark copy for the shadow
    this.shadeCtx = this.shade.getContext('2d');
    this.comp = makeCanvas(W * S, H * S);        // shadow + cloud, drawn once per frame
    this.compCtx = this.comp.getContext('2d');
    const NS = 128;
    const n = tileableNoise(NS, 6, 7177, 4);
    const tex = makeCanvas(NS, NS), tg = tex.getContext('2d');
    const im = tg.createImageData(NS, NS);
    for (let k = 0; k < NS * NS; k++) {
      let v = (n[k] - 0.38) / 0.26; v = v < 0 ? 0 : v > 1 ? 1 : v;
      v = v * v * (3 - 2 * v);
      im.data[k * 4] = 255; im.data[k * 4 + 1] = 255; im.data[k * 4 + 2] = 255; im.data[k * 4 + 3] = (v * 255) | 0;
    }
    tg.putImageData(im, 0, 0);
    this.tex = tex;
    this.pattern = this.puffCtx.createPattern(tex, 'repeat');
    this.envDay = -1; this.envTime = -1e9;
    this.compAt = -1e9;
    this.ready = false;
  }

  _buildEnvelope(now) {
    const w = this.world, f = w.f, N = w.N, buf = this.envBuf;
    if (w.time.day === this.envDay && now - this.envTime < 2000) return;
    this.envDay = w.time.day; this.envTime = now;
    // soften the cloud field first: it is upsampled from a coarse grid in bands of rows,
    // which would otherwise show as horizontal stripes and hard-edged blocks
    const W = w.W, H = w.H, cl = f.cloud;
    const a = this._blurA && this._blurA.length === N ? this._blurA : (this._blurA = new Float32Array(N));
    const b = this._blurB && this._blurB.length === N ? this._blurB : (this._blurB = new Float32Array(N));
    for (let i = 0; i < N; i++) { const v = cl[i]; a[i] = v > 0 ? (v < 1 ? v : 1) : 0; }
    for (let pass = 0; pass < 2; pass++) { boxH(a, b, W, H, 2); boxV(b, a, W, H, 3); }
    const norm = 1 / 1225; // two passes of a 5-tap (x) × 7-tap (y) box
    for (let i = 0; i < N; i++) {
      const c = a[i] * norm;
      let v = (c - 0.4) / 0.5; v = v < 0 ? 0 : v > 1 ? 1 : v;
      v = v * v * (3 - 2 * v);
      buf[i] = ((((v * 235) | 0) << 24) | 0xffffff) >>> 0;
    }
    this.envCtx.putImageData(this.envImg, 0, 0);
  }

  /** Recompose the cloud deck (≈ 20 Hz is plenty for a slow drift). */
  updateClouds(now) {
    if (this.ready && now - this.compAt < 50) return;
    this.compAt = now;
    this._buildEnvelope(now);
    this.ready = true;
    const w = this.world, S = this.CS, CW = w.W * S, CH = w.H * S;
    const t = now * 0.001;
    const g = this.puffCtx;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, CW, CH);
    g.imageSmoothingEnabled = true;
    g.drawImage(this.env, 0, 0, CW, CH);
    g.globalCompositeOperation = 'destination-in';
    g.setTransform(0.7, 0, 0, 0.7, (t * 2.2) % (128 * 0.7), (t * 0.55) % (128 * 0.7));
    g.fillStyle = this.pattern; g.fillRect(-256, -256, CW / 0.7 + 512, CH / 0.7 + 512);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    const sg = this.shadeCtx;
    sg.globalCompositeOperation = 'source-over';
    sg.clearRect(0, 0, CW, CH);
    sg.drawImage(this.puff, 0, 0);
    sg.globalCompositeOperation = 'source-in';
    sg.fillStyle = 'rgb(18,24,34)'; sg.fillRect(0, 0, CW, CH);
    sg.globalCompositeOperation = 'source-over';
    const cg = this.compCtx;
    cg.clearRect(0, 0, CW, CH);
    cg.globalAlpha = 0.24;
    cg.drawImage(this.shade, 0.8 * S, 1.1 * S);
    cg.globalAlpha = 1;
    cg.drawImage(this.puff, 0, 0);
  }

  /**
   * Waves on open water at close zoom: short crests lying across the wind, drifting with it and
   * fading in and out, thicker where the wind blows harder. Screen space, a fixed density.
   */
  drawWaves(ctx, r, now, alpha) {
    if (alpha <= 0.02) return;
    const w = this.world, f = w.f, W = w.W;
    const z = r.camera.zoom;
    const vb = r.viewBounds(0);
    const per = Math.max(1, (34 / Math.max(0.5, z)) ** 2);   // one crest per ~34 px of sea
    const sub = Math.max(1, Math.round(Math.sqrt(1 / per)));   // up close, several per tile
    const thresh = Math.min(1024, (1024 * sub * sub) / per) | 0;
    const t = now * 0.001;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgb(232,244,250)';
    ctx.lineWidth = Math.max(0.9, Math.min(2, z * 0.02));
    ctx.beginPath();
    let n = 0;
    for (let y = vb.y0; y <= vb.y1; y++) {
      for (let x = vb.x0; x <= vb.x1; x++) {
        const i = y * W + x;
        if (f.water[i] !== WATER.OCEAN) continue;
        const wx = f.windX[i] || 0, wy = f.windY[i] || 0;
        const ws = Math.min(1.5, Math.hypot(wx, wy));
        const ang = Math.atan2(wy, wx);
        for (let q = 0; q < sub * sub; q++) {
          const h = hash2i(x * 7 + q, y * 13 + q, 6211);
          if ((h & 1023) >= thresh * (0.35 + ws * 0.5)) continue;
          const period = 3 + ((h >>> 10) & 31) / 8;
          const ph = ((t + ((h >>> 15) & 1023) / 97) % period) / period;
          if (ph > 0.6) continue;
          const life = Math.sin((ph / 0.6) * Math.PI);
          const drift = ph * 0.35;
          const jx = ((q % sub) + ((h >>> 20) & 255) / 255) / sub - 0.5 + Math.cos(ang) * drift;
          const jy = (((q / sub) | 0) + ((h >>> 4) & 63) / 63) / sub - 0.5 + Math.sin(ang) * drift;
          const { sx, sy } = r.e2s(x + jx, y + jy);
          const L = Math.min(14, 3 + z * 0.05) * (0.6 + life * 0.6);
          const ca = Math.cos(ang + Math.PI / 2), sa = Math.sin(ang + Math.PI / 2);
          // a crest: a shallow arc bowed downwind
          ctx.moveTo(sx - ca * L, sy - sa * L);
          ctx.quadraticCurveTo(sx + Math.cos(ang) * L * 0.35, sy + Math.sin(ang) * L * 0.35, sx + ca * L, sy + sa * L);
          if (++n > 900) break;
        }
        if (n > 900) break;
      }
      if (n > 900) break;
    }
    ctx.globalAlpha = alpha * 0.42;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineCap = 'butt';
  }

  /**
   * Sun glints on open water: short bright dashes that flash and fade, a fixed density on
   * screen at any zoom. Screen-space, so they stay crisp.
   */
  drawGlints(ctx, r, now, alpha) {
    const w = this.world, f = w.f, W = w.W;
    const z = r.camera.zoom;
    const vb = r.viewBounds(0);
    const spacing = 26; // px between glints on average
    const per = Math.max(1, (spacing / Math.max(0.5, z)) ** 2);
    const thresh = Math.min(1024, (1024 / per) | 0);
    if (thresh <= 0) return;
    const t = now * 0.001;
    const len = Math.max(2, Math.min(7, z * 0.35));
    const paths = [[], [], []];
    for (let y = vb.y0; y <= vb.y1; y++) {
      for (let x = vb.x0; x <= vb.x1; x++) {
        const i = y * W + x;
        if (f.water[i] !== WATER.OCEAN) continue;
        const h = hash2i(x, y, 6203);
        if ((h & 1023) >= thresh) continue;
        // each glint flashes briefly on its own period
        const period = 2.2 + ((h >>> 10) & 31) / 10;
        const ph = ((t + ((h >>> 15) & 1023) / 97) % period) / period;
        if (ph > 0.3) continue;
        const a = Math.sin((ph / 0.3) * Math.PI);
        const b = a > 0.75 ? 2 : a > 0.4 ? 1 : 0;
        const jx = ((h >>> 20) & 255) / 255 - 0.5, jy = ((h >>> 4) & 63) / 63 - 0.5;
        const { sx, sy } = r.e2s(x + jx + Math.sin(t * 0.3 + x) * 0.08, y + jy);
        paths[b].push(sx, sy);
      }
    }
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgb(246,251,255)';
    for (let b = 0; b < 3; b++) {
      const p = paths[b];
      if (!p.length) continue;
      ctx.globalAlpha = alpha * (0.3 + b * 0.32);
      ctx.lineWidth = b === 2 ? 1.6 : 1.1;
      ctx.beginPath();
      const L = len * (0.6 + b * 0.25);
      for (let k = 0; k < p.length; k += 2) { ctx.moveTo(p[k] - L / 2, p[k + 1]); ctx.lineTo(p[k] + L / 2, p[k + 1]); }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.lineCap = 'butt';
  }
}
