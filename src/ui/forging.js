// The forging: a new world is engraved before the viewer's eyes. The generator itself takes a
// moment; this plays its stages back at a pace a person can watch. The plate is cut in two
// passes, each swept west to east by the burin: first the engraver's first state (the sea lined,
// the coasts, the contours and the rivers), then the full colour of the land. Beside it the
// stages are ticked off as a Contents, under a graduated progress bar. Any key or a click
// finishes the plate at once; Cancel (Esc) throws the world away.

import { WATER } from '../core/constants.js';
import { h } from './dom.js';
import { fixtureFrame } from './frame.js';

const DURATION = 8500;         // ms for the whole plate
const FIRST = 0.45;            // the share of it spent on the first state
const INK = '237, 227, 203';
const GROUND = '#0a1017';
const BRASS = '#e8cb90';
const AGE = ['A world of history', 'A world of legend', 'An age of myth'];

/**
 * Play the forging of `world` (already generated). opts: { stages: [{ label, ms }] the
 * generator's own stages, after: [labels] the steps that follow, drawColour(world, canvas) }.
 * Resolves to { cancelled } when the plate is done, skipped or thrown away.
 */
export function forgeWorld(app, world, { stages = [], after = [], drawColour } = {}) {
  return new Promise((resolve) => {
    const root = h('section.forging', { role: 'dialog', 'aria-label': `Forging ${world.name}` });
    const plate = h('canvas.fg-plate', { 'aria-hidden': 'true' });
    const front = h('canvas.fg-front', { 'aria-hidden': 'true' });

    // the left fixture: the world, its stages as a Contents, the progress, Cancel
    const steps = [...stages.map((s) => ({ label: s.label, part: 0 })), ...after.map((label) => ({ label, part: 1 }))];
    const list = h('ol.fg-stages');
    const rows = steps.map((s, k) => {
      const li = h('li', { class: s.part ? 'is-part' : '' }, h('span.fg-n', { text: s.part ? roman(k - stages.length + 2) : roman(k + 1).toLowerCase() }), h('span.fg-name', { text: s.label }), h('span.fg-lead'), h('span.fg-tick'));
      list.appendChild(li);
      return li;
    });
    const caption = h('span.fg-cap');
    const pct = h('span.fg-pct');
    const bar = h('div.fg-bar', null, h('div.fg-fill'));
    const cancel = h('button.btn.btn-danger.fg-cancel', { type: 'button' }, 'Cancel', h('kbd', { text: 'Esc' }));
    const p = world.params || {};
    const side = h('div.fg-side', null,
      h('div.fg-side-in', null,
        h('p.fg-kicker', { text: 'Forging a world' }),
        h('h2.fg-name-w', { text: world.name }),
        h('p.fg-age', { text: AGE[Math.max(0, Math.min(2, Number(p.mythLevel) || 0))] }),
        h('dl.fg-params', null,
          h('div', null, h('dt', { text: 'Seed' }), h('dd', { text: String(p.seed ?? '—') })),
          h('div', null, h('dt', { text: 'Map' }), h('dd', { text: `${world.W}×${world.H}` })),
          h('div', null, h('dt', { text: 'Tribes' }), h('dd', { text: String(p.civCount ?? '—') }))),
        h('div.rule-loz', { 'aria-hidden': 'true' }, h('span.loz')),
        list,
        h('div.fg-prog', null, h('div.fg-prog-h', null, caption, pct), bar),
        h('div.fg-foot', null, cancel, h('span.fg-hint', { text: 'Click or press any key to finish the plate' }))));
    root.append(plate, front, side);
    document.body.appendChild(root);
    fixtureFrame(side);

    // the two states of the plate, drawn once at the screen's size
    const vw = window.innerWidth, vh = window.innerHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const scale = Math.max(vw / world.W, vh / world.H);         // cover the screen
    const cw = Math.ceil(world.W * scale), chh = Math.ceil(world.H * scale);
    const first = firstState(world, Math.round(cw * dpr), Math.round(chh * dpr), dpr);
    const colour = document.createElement('canvas');
    colour.width = Math.round(cw * dpr); colour.height = Math.round(chh * dpr);
    try { drawColour?.(world, colour); } catch (e) { /* the first state alone then */ }
    for (const c of [plate, front]) { c.width = Math.round(vw * dpr); c.height = Math.round(vh * dpr); }
    const ox = (vw - cw) / 2, oy = (vh - chh) / 2;
    const ctx = plate.getContext('2d'), fctx = front.getContext('2d');

    let done = false, raf = 0;
    const t0 = performance.now();
    const finish = (cancelled) => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey, true);
      root.classList.add('is-leaving');
      setTimeout(() => root.remove(), cancelled ? 0 : 260);
      resolve({ cancelled });
    };
    function onKey(e) {
      e.preventDefault(); e.stopPropagation();
      finish(e.key === 'Escape');
    }
    window.addEventListener('keydown', onKey, true);
    root.addEventListener('click', (e) => { if (!cancel.contains(e.target)) finish(false); });
    cancel.addEventListener('click', (e) => { e.stopPropagation(); finish(true); });

    // the stages' share of the time, by how long each really took (softened), the rest even
    const wts = steps.map((s, k) => (k < stages.length ? Math.sqrt(Math.max(4, stages[k].ms || 4)) : 6));
    const total = wts.reduce((a, b) => a + b, 0);
    const ends = []; let acc = 0;
    for (const w of wts) { acc += w / total; ends.push(acc); }

    let lastStep = -1;
    function frame(now) {
      const t = Math.min(1, (now - t0) / DURATION);
      // a near-even pace, eased a little at the ends
      const prog = Math.max(0, Math.min(1, 0.85 * t + 0.15 * t * t * (3 - 2 * t)));
      draw(prog);
      const step = Math.min(steps.length - 1, ends.findIndex((x) => prog <= x));
      if (step !== lastStep) {
        lastStep = step;
        rows.forEach((r, k) => { r.classList.toggle('is-done', k < step); r.classList.toggle('is-now', k === step); });
        caption.textContent = `${steps[Math.max(0, step)]?.label || ''}…`;
      }
      pct.textContent = `${Math.round(prog * 100)}%`;
      bar.style.setProperty('--v', `${(prog * 100).toFixed(1)}%`);
      if (t >= 1) { setTimeout(() => finish(false), 350); return; }
      raf = requestAnimationFrame(frame);
    }

    function draw(prog) {
      const W = plate.width, H = plate.height;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = GROUND; ctx.fillRect(0, 0, W, H);
      const px = (x) => (ox + x) * dpr;
      const pw = cw * dpr, ph = chh * dpr;
      let fx;
      if (prog < FIRST) {
        // the first pass: the first state cut into the bare plate
        fx = (prog / FIRST) * pw;
        ctx.save(); ctx.beginPath(); ctx.rect(px(0), oy * dpr, fx, ph); ctx.clip();
        ctx.drawImage(first, px(0), oy * dpr);
        ctx.restore();
      } else {
        // the second pass: the colour laid in over the first state
        fx = ((prog - FIRST) / (1 - FIRST)) * pw;
        ctx.drawImage(first, px(0), oy * dpr);
        ctx.save(); ctx.beginPath(); ctx.rect(px(0), oy * dpr, fx, ph); ctx.clip();
        ctx.drawImage(colour, px(0), oy * dpr);
        ctx.restore();
      }
      // the burin's front: a graduated meridian with a brass index and its longitude
      fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fctx.clearRect(0, 0, vw, vh);
      const x = ox + fx / dpr;
      if (x > 0 && x < vw && prog < 1) {
        fctx.strokeStyle = 'rgba(10,16,23,0.9)'; fctx.lineWidth = 3.5;
        fctx.beginPath(); fctx.moveTo(x, 0); fctx.lineTo(x, vh); fctx.stroke();
        fctx.strokeStyle = `rgba(${INK}, 0.9)`; fctx.lineWidth = 1.5;
        fctx.beginPath(); fctx.moveTo(x, 0); fctx.lineTo(x, vh); fctx.stroke();
        fctx.lineWidth = 1;
        const latPx = chh / 36;          // a tick every 5° of latitude
        for (let k = 0; k <= 36; k++) {
          const y = oy + k * latPx, len = k % 6 === 0 ? 9 : 5;
          fctx.beginPath(); fctx.moveTo(x - len, y); fctx.lineTo(x + len, y); fctx.stroke();
        }
        const lon = -180 + 360 * ((x - ox) / cw);
        const txt = `${Math.abs(lon).toFixed(1)}° ${lon >= 0 ? 'E' : 'W'}`;
        fctx.font = '500 11px "Alegreya Sans", sans-serif';
        const tw = fctx.measureText(txt).width;
        fctx.fillStyle = GROUND; fctx.fillRect(x + 8, 10, tw + 10, 16);
        fctx.fillStyle = BRASS; fctx.fillText(txt, x + 13, 22);
        fctx.beginPath(); fctx.moveTo(x - 6, 0); fctx.lineTo(x + 6, 0); fctx.lineTo(x, 9); fctx.closePath(); fctx.fill();
        fctx.beginPath(); fctx.moveTo(x - 6, vh); fctx.lineTo(x + 6, vh); fctx.lineTo(x, vh - 9); fctx.closePath(); fctx.fill();
      }
    }
    raf = requestAnimationFrame(frame);
  });
}

/**
 * The engraver's first state of the world at w×h device pixels: the sea lined with horizontal
 * hatching, the coasts and lakes cut as rules, the land's contours at four heights, the rivers.
 */
function firstState(world, w, h, dpr) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const { W, H, f } = world;
  const sx = w / W, sy = h / H;
  const water = f.water, elev = f.elevation;
  const isSea = (i) => water[i] !== WATER.LAND;
  // the sea, lined
  g.fillStyle = 'rgba(237,227,203,0.05)';
  g.fillRect(0, 0, w, h);
  const mask = document.createElement('canvas');
  mask.width = W; mask.height = H;
  const mg = mask.getContext('2d'), md = mg.createImageData(W, H);
  for (let i = 0; i < W * H; i++) md.data[i * 4 + 3] = isSea(i) ? 255 : 0;
  mg.putImageData(md, 0, 0);
  const lines = document.createElement('canvas');
  lines.width = w; lines.height = h;
  const lg = lines.getContext('2d');
  lg.strokeStyle = `rgba(${INK}, 0.28)`; lg.lineWidth = Math.max(1, dpr * 0.75);
  const pitch = Math.max(3, Math.round(3.5 * dpr));
  lg.beginPath();
  for (let y = 0.5; y < h; y += pitch) { lg.moveTo(0, y); lg.lineTo(w, y); }
  lg.stroke();
  lg.globalCompositeOperation = 'destination-in';
  lg.imageSmoothingEnabled = true;
  lg.drawImage(mask, 0, 0, w, h);
  g.drawImage(lines, 0, 0);
  // the coast and the contours as smooth lines: marching squares over the elevation (the coast
  // at sea level, four contours above it), the lakes over their own mask
  const sea = world.climate?.seaLevel ?? 0.5;
  const coast = isoLines(elev, W, H, sea, sx, sy);
  const contours = new Path2D();
  for (const k of [0.07, 0.14, 0.21, 0.28]) contours.addPath(isoLines(elev, W, H, sea + k, sx, sy));
  const lakeV = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) lakeV[i] = water[i] === WATER.LAKE ? 1 : 0;
  const lakes = isoLines(lakeV, W, H, 0.5, sx, sy);
  g.lineCap = 'round'; g.lineJoin = 'round';
  g.strokeStyle = `rgba(${INK}, 0.3)`; g.lineWidth = Math.max(1, dpr * 0.7); g.stroke(contours);
  g.strokeStyle = `rgba(${INK}, 0.85)`; g.lineWidth = Math.max(1, dpr * 1.1); g.stroke(coast); g.stroke(lakes);
  // rivers, from each river tile to the tile it drains into
  const river = f.river, flow = f.flowDir;
  if (river && flow) {
    const rp = new Path2D();
    for (let i = 0; i < W * H; i++) {
      if (river[i] < 2 || isSea(i)) continue;
      const j = flow[i];
      if (!(j >= 0)) continue;
      const x0 = ((i % W) + 0.5) * sx, y0 = (((i / W) | 0) + 0.5) * sy;
      const x1 = ((j % W) + 0.5) * sx, y1 = (((j / W) | 0) + 0.5) * sy;
      rp.moveTo(x0, y0); rp.lineTo(x1, y1);
    }
    g.strokeStyle = `rgba(${INK}, 0.6)`; g.lineWidth = Math.max(1, dpr * 0.9); g.stroke(rp);
  }
  return c;
}

/** Marching squares: the line where field v crosses t, through cell centres, scaled to the plate. */
function isoLines(v, W, H, t, sx, sy) {
  const p = new Path2D();
  const lerp = (a, b) => (Math.abs(b - a) < 1e-9 ? 0.5 : (t - a) / (b - a));
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const i = y * W + x;
      const a = v[i], b = v[i + 1], c = v[i + W + 1], d = v[i + W];
      const m = (a >= t ? 8 : 0) | (b >= t ? 4 : 0) | (c >= t ? 2 : 0) | (d >= t ? 1 : 0);
      if (m === 0 || m === 15) continue;
      // edge points (in cell-centre units): top, right, bottom, left
      const X = (u) => (x + 0.5 + u) * sx, Y = (u) => (y + 0.5 + u) * sy;
      const T = [X(lerp(a, b)), Y(0)], R = [X(1), Y(lerp(b, c))], B = [X(lerp(d, c)), Y(1)], L = [X(0), Y(lerp(a, d))];
      const seg = (P, Q) => { p.moveTo(P[0], P[1]); p.lineTo(Q[0], Q[1]); };
      switch (m) {
        case 1: case 14: seg(L, B); break;
        case 2: case 13: seg(B, R); break;
        case 3: case 12: seg(L, R); break;
        case 4: case 11: seg(T, R); break;
        case 5: seg(L, T); seg(B, R); break;
        case 6: case 9: seg(T, B); break;
        case 7: case 8: seg(L, T); break;
        case 10: seg(T, R); seg(L, B); break;
      }
    }
  }
  return p;
}

function roman(n) {
  const R = [['X', 10], ['IX', 9], ['V', 5], ['IV', 4], ['I', 1]];
  let s = '', k = Math.max(1, n | 0);
  for (const [r, v] of R) while (k >= v) { s += r; k -= v; }
  return s;
}
