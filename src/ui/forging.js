// The forging: a new world is made before the viewer's eyes. The generator itself takes a
// moment; this plays its stages back at a pace a person can watch, from the states it passed
// through. The plates' seams open and drift; the continents rise out of the sea peaks first, their
// relief shaded; the land weathers into its final shape and its contours are cut; the sea is
// lined in west to east; the rivers run from their springs to their mouths; and the colour is laid
// in by the burin's last pass. Beside it the stages are ticked off as a Contents under a graduated
// progress bar. Any key or a click finishes the plate at once; Cancel (Esc) throws the world away.
// When the plate is done the caller opens the world under it and asks it to dissolve, so the
// engraving melts into the living map as the instruments come in.

import { WATER } from '../core/constants.js';
import { h } from './dom.js';
import { fixtureFrame } from './frame.js';

const INK = '237, 227, 203';
const GROUND = '#0a1017';
const BRASS = '#e8cb90';
const AGE = ['A world of history', 'A world of legend', 'An age of myth'];

// The plate's phases (ms), and which of the generator's stages each one shows.
const PHASES = [
  { id: 'plates', ms: 1900, stages: ['Drifting the plates'] },
  { id: 'raise', ms: 3400, stages: ['Raising the continents'] },
  { id: 'weather', ms: 1200, stages: ['Weathering the land'] },
  { id: 'seas', ms: 1800, stages: ['Filling the seas', 'Stirring the winds'] },
  { id: 'rivers', ms: 2300, stages: ['Carving the rivers'] },
  { id: 'colour', ms: 2700, stages: ['Painting the biomes', 'Seeding the earth'] },
  { id: 'hold', ms: 700, stages: ['Waking the volcanoes', 'Naming the world'] },
];
const TOTAL = PHASES.reduce((a, p) => a + p.ms, 0);

const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const easeOut = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : 1 - Math.pow(1 - t, 3));

/**
 * Play the forging of `world` (already generated). opts: { stages: [{ label, ms }] the
 * generator's own stages, after: [labels] the steps that follow, snaps: { rawElev } the relief
 * before the land weathered, drawColour(world, canvas) }. Resolves, when the plate is done,
 * skipped or thrown away, to { cancelled, dissolve() }; dissolve() melts the overlay away
 * (resolving when it is gone) and ticks off the after-steps as it goes.
 */
export function forgeWorld(app, world, { stages = [], after = [], snaps = {}, drawColour } = {}) {
  return new Promise((resolve) => {
    const root = h('section.forging', { role: 'dialog', 'aria-label': `Forging ${world.name}` });
    const plate = h('canvas.fg-plate', { 'aria-hidden': 'true' });
    const front = h('canvas.fg-front', { 'aria-hidden': 'true' });

    // --- the left fixture: the world, its stages as a Contents, the progress, Cancel ----------
    const known = new Set(PHASES.flatMap((p) => p.stages));
    const genSteps = stages.map((s) => s.label).filter((l) => known.has(l));
    const steps = [...genSteps.map((label) => ({ label, part: 0 })), ...after.map((label) => ({ label, part: 1 }))];
    const list = h('ol.fg-stages');
    const rows = steps.map((s, k) => {
      const li = h('li', { class: s.part ? 'is-part' : '' }, h('span.fg-n', { text: s.part ? roman(k - genSteps.length + 2) : roman(k + 1).toLowerCase() }), h('span.fg-name', { text: s.label }), h('span.fg-lead'), h('span.fg-tick'));
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

    // --- the plate's layers, drawn once at the screen's size ---------------------------------
    const vw = window.innerWidth, vh = window.innerHeight;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const scale = Math.max(vw / world.W, vh / world.H);          // cover the screen, as the map will
    const cw = world.W * scale, chh = world.H * scale;
    const ox = (vw - cw) / 2, oy = (vh - chh) / 2;
    for (const c of [plate, front]) { c.width = Math.round(vw * dpr); c.height = Math.round(vh * dpr); }
    const pw = Math.round(cw * dpr), ph = Math.round(chh * dpr);
    const L = layers(world, snaps, pw, ph, dpr);
    const colour = canvas(pw, ph);
    try { drawColour?.(world, colour); } catch (e) { /* the engraving alone then */ }
    const ctx = plate.getContext('2d'), fctx = front.getContext('2d');

    // the schedule: each stage label ticks while its phase plays
    const sched = new Map();
    let at = 0;
    for (const ph2 of PHASES) {
      ph2.t0 = at; ph2.t1 = at + ph2.ms; at = ph2.t1;
      ph2.stages.forEach((l, k) => sched.set(l, ph2.t0 + (ph2.ms * k) / ph2.stages.length));
    }

    let done = false, raf = 0, lastStep = -2;
    const t0 = performance.now();
    function finishPlate(cancelled) {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey, true);
      if (cancelled) { root.remove(); resolve({ cancelled: true, dissolve: async () => {} }); return; }
      draw(TOTAL); tick(TOTAL);
      root.classList.add('is-done');
      resolve({ cancelled: false, dissolve });
    }
    function onKey(e) { e.preventDefault(); e.stopPropagation(); finishPlate(e.key === 'Escape'); }
    window.addEventListener('keydown', onKey, true);
    root.addEventListener('click', (e) => { if (!done && !cancel.contains(e.target)) finishPlate(false); });
    cancel.addEventListener('click', (e) => { e.stopPropagation(); finishPlate(true); });

    function tick(ms) {
      let step = -1;
      genSteps.forEach((l, k) => { if (ms >= (sched.get(l) ?? 0)) step = k; });
      if (step !== lastStep) {
        lastStep = step;
        rows.forEach((r, k) => { r.classList.toggle('is-done', k < step || (ms >= TOTAL && k <= step)); r.classList.toggle('is-now', k === step && ms < TOTAL); });
        if (step >= 0 && ms < TOTAL) caption.textContent = `${genSteps[step]}…`;
      }
      const prog = (ms / TOTAL) * 0.92;
      pct.textContent = `${Math.round(prog * 100)}%`;
      bar.style.setProperty('--v', `${(prog * 100).toFixed(1)}%`);
    }

    function frame(now) {
      const t = Math.min(TOTAL, now - t0);
      draw(t); tick(t);
      if (t >= TOTAL) { finishPlate(false); return; }
      raf = requestAnimationFrame(frame);
    }

    // --- drawing --------------------------------------------------------------------------
    const phase = (id) => PHASES.find((q) => q.id === id);
    const local = (id, ms) => { const q = phase(id); return Math.max(0, Math.min(1, (ms - q.t0) / q.ms)); };
    const PX = ox * dpr, PY = oy * dpr;
    const tmp = canvas(pw, ph), tg = tmp.getContext('2d');
    const small = canvas(world.W, world.H), sg = small.getContext('2d'), sd = sg.createImageData(world.W, world.H);

    /** The land above height thr (from elevArr), cut out of a shade layer and laid on the plate. */
    function landAbove(layer, elevArr, thr, alpha = 1) {
      for (let i = 0; i < elevArr.length; i++) sd.data[i * 4 + 3] = elevArr[i] >= thr ? 255 : 0;
      sg.putImageData(sd, 0, 0);
      tg.globalCompositeOperation = 'copy';
      tg.drawImage(layer, 0, 0);
      tg.globalCompositeOperation = 'destination-in';
      tg.imageSmoothingEnabled = true;
      tg.drawImage(small, 0, 0, pw, ph);
      tg.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = alpha;
      ctx.drawImage(tmp, PX, PY);
      ctx.globalAlpha = 1;
    }
    function strokeOnPlate(path, style, width, alpha = 1) {
      ctx.save();
      ctx.translate(PX, PY);
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = style; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.stroke(path);
      ctx.restore();
    }
    function sweep(img, f) {
      if (f <= 0) return 0;
      const x = f * pw;
      ctx.save(); ctx.beginPath(); ctx.rect(PX, PY, x, ph); ctx.clip();
      ctx.drawImage(img, PX, PY);
      ctx.restore();
      return x;
    }

    function draw(ms) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = GROUND; ctx.fillRect(0, 0, plate.width, plate.height);
      ctx.fillStyle = 'rgba(237,227,203,0.035)'; ctx.fillRect(PX, PY, pw, ph);
      let frontX = null;
      const plates = local('plates', ms), raise = local('raise', ms), weather = local('weather', ms);
      const seas = local('seas', ms), rivers = local('rivers', ms), col = local('colour', ms);

      // the plates: seams fade in and drift, and go as the land rises
      const seamA = ms < phase('raise').t0 ? ease(plates) : 1 - ease(raise * 1.6);
      if (seamA > 0.01) {
        ctx.globalAlpha = seamA;
        ctx.drawImage(L.plateTone, PX, PY);
        ctx.globalAlpha = 1;
        strokeOnPlate(L.seams, `rgba(${INK}, 0.75)`, Math.max(1, dpr * 1.25), seamA);
        drawDrift(seamA, ms < phase('raise').t0 ? plates : 1 + raise);
      }
      // the continents rise: the land above a falling waterline, its relief shaded, its shore traced
      if (ms >= phase('raise').t0 && weather < 1) {
        const thr = L.rawMax - (L.rawMax - L.sea) * easeOut(raise);
        landAbove(L.shadeRaw, L.rawElev, thr, 1 - ease(weather));
        if (weather < 0.6) strokeOnPlate(isoPath(L.rawElev, world.W, world.H, thr, L.sx, L.sy), `rgba(${INK}, 0.8)`, Math.max(1, dpr * 1.1), 1 - ease(weather / 0.6));
      }
      // the land weathers into its final shape; the contours are cut
      if (weather > 0) {
        ctx.globalAlpha = ease(weather);
        ctx.drawImage(L.shade, PX, PY);
        ctx.globalAlpha = 1;
        strokeOnPlate(L.contours, `rgba(${INK}, 0.3)`, Math.max(1, dpr * 0.7), ease(weather));
        strokeOnPlate(L.coast, `rgba(${INK}, 0.85)`, Math.max(1, dpr * 1.1), ease(weather));
      }
      // the sea is lined in, west to east
      if (seas > 0) {
        const x = sweep(L.hatch, easeOut(seas));
        if (seas < 1) frontX = x;
      }
      // the rivers run from their springs to their mouths
      if (rivers > 0) {
        const n = Math.round(L.rivers.length * easeOut(rivers));
        ctx.save(); ctx.translate(PX, PY);
        ctx.strokeStyle = `rgba(${INK}, 0.9)`; ctx.lineCap = 'round';
        // three weights: the springs and streams, the rivers, the great rivers
        for (const [lo, hi, wgt] of [[0, 1, 0.8], [1, 2, 1.3], [2, 9, 1.9]]) {
          ctx.lineWidth = Math.max(1, dpr * wgt);
          ctx.beginPath();
          for (let k = 0; k < n; k++) { const sg2 = L.rivers[k]; if (sg2[5] >= lo && sg2[5] < hi) { ctx.moveTo(sg2[0], sg2[1]); ctx.lineTo(sg2[2], sg2[3]); } }
          ctx.stroke();
        }
        ctx.restore();
      }
      // the colour, laid in by the last pass of the burin
      if (col > 0) {
        const x = sweep(colour, easeOut(col));
        if (col < 1) frontX = x;
      }
      drawFront(frontX == null ? null : (PX + frontX) / dpr);
    }

    /** Arrows at the plates' centres, drifting the way each plate moves. */
    function drawDrift(alpha, f) {
      ctx.save(); ctx.translate(PX, PY);
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = `rgba(${INK}, 0.85)`; ctx.fillStyle = `rgba(${INK}, 0.85)`; ctx.lineWidth = Math.max(1, dpr * 1.5);
      for (const q of L.drift) {
        const len = (22 + 26 * q.v) * dpr, dx = q.dx * len, dy = q.dy * len, m = 22 * dpr * f;
        const x0 = q.x + q.dx * m, y0 = q.y + q.dy * m;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + dx, y0 + dy); ctx.stroke();
        const a = Math.atan2(dy, dx), hx = x0 + dx, hy = y0 + dy, s = 7 * dpr;
        ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx - s * Math.cos(a - 0.45), hy - s * Math.sin(a - 0.45)); ctx.lineTo(hx - s * Math.cos(a + 0.45), hy - s * Math.sin(a + 0.45)); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }

    /** The burin's front: a graduated meridian with a brass index and its longitude. */
    function drawFront(x) {
      fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fctx.clearRect(0, 0, vw, vh);
      if (x == null || x <= 0 || x >= vw) return;
      fctx.strokeStyle = 'rgba(10,16,23,0.9)'; fctx.lineWidth = 3.5;
      fctx.beginPath(); fctx.moveTo(x, 0); fctx.lineTo(x, vh); fctx.stroke();
      fctx.strokeStyle = `rgba(${INK}, 0.9)`; fctx.lineWidth = 1.5;
      fctx.beginPath(); fctx.moveTo(x, 0); fctx.lineTo(x, vh); fctx.stroke();
      fctx.lineWidth = 1;
      for (let k = 0; k <= 36; k++) {
        const y = oy + (k * chh) / 36, len = k % 6 === 0 ? 9 : 5;
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

    /** Melt the finished plate into the living map, ticking off the steps that follow. */
    function dissolve() {
      return new Promise((gone) => {
        const n0 = genSteps.length, STEP = 260;
        after.forEach((l, k) => setTimeout(() => {
          rows.forEach((r, j) => { r.classList.toggle('is-done', j < n0 + k); r.classList.toggle('is-now', j === n0 + k); });
          caption.textContent = `${l}…`;
          const v = 92 + ((k + 1) / after.length) * 8;
          pct.textContent = `${Math.round(v)}%`; bar.style.setProperty('--v', `${v}%`);
        }, k * STEP));
        setTimeout(() => {
          rows.forEach((r) => { r.classList.add('is-done'); r.classList.remove('is-now'); });
          root.classList.add('is-dissolving');
        }, after.length * STEP);
        setTimeout(() => { root.remove(); gone(); }, after.length * STEP + 1600);
      });
    }

    raf = requestAnimationFrame(frame);
  });
}

// ---------------------------------------------------------------------------
// The plate's layers

function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

/**
 * Everything the plate is cut from, at w×h device pixels: shaded relief before and after the
 * land weathered, the sea's lining, the coast and lake lines, the contours, the plates' seams and
 * drift, and the river segments in the order they fill (springs first).
 */
function layers(world, snaps, w, h, dpr) {
  const { W, H, f } = world;
  const N = W * H;
  const sx = w / W, sy = h / H;
  const water = f.water, elev = f.elevation;
  const sea = world.climate?.seaLevel ?? 0.5;
  const rawElev = snaps.rawElev && snaps.rawElev.length === N ? snaps.rawElev : elev;
  let rawMax = sea + 0.01;
  for (let i = 0; i < N; i++) if (rawElev[i] > rawMax) rawMax = rawElev[i];
  const isSea = (i) => water[i] !== WATER.LAND;

  // shaded relief: the land in plate tones, lit from the north-west, brighter with height
  const shadeOf = (e, landTest) => {
    const img = new ImageData(W, H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!landTest(i)) continue;
        const ex = e[y * W + Math.min(W - 1, x + 1)] - e[y * W + Math.max(0, x - 1)];
        const ey = e[Math.min(H - 1, y + 1) * W + x] - e[Math.max(0, y - 1) * W + x];
        const light = Math.max(0, Math.min(1, 0.5 - (ex + ey) * 9));
        const hgt = Math.max(0, Math.min(1, (e[i] - sea) / Math.max(0.05, rawMax - sea)));
        const k = Math.max(0, Math.min(1, 0.1 + 0.32 * hgt + 0.55 * (light - 0.5)));
        img.data[i * 4] = 22 + (237 - 22) * k;
        img.data[i * 4 + 1] = 33 + (227 - 33) * k;
        img.data[i * 4 + 2] = 45 + (203 - 45) * k;
        img.data[i * 4 + 3] = 255;
      }
    }
    const s = canvas(W, H);
    s.getContext('2d').putImageData(img, 0, 0);
    const big = canvas(w, h), g = big.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.drawImage(s, 0, 0, w, h);
    return big;
  };
  const shadeRaw = shadeOf(rawElev, () => true);
  const shade = shadeOf(elev, (i) => !isSea(i));

  // the sea's lining, masked to the final sea
  const mask = canvas(W, H), mg = mask.getContext('2d'), md = mg.createImageData(W, H);
  for (let i = 0; i < N; i++) md.data[i * 4 + 3] = isSea(i) ? 255 : 0;
  mg.putImageData(md, 0, 0);
  const hatch = canvas(w, h), lg = hatch.getContext('2d');
  lg.strokeStyle = `rgba(${INK}, 0.28)`; lg.lineWidth = Math.max(1, dpr * 0.75);
  const pitch = Math.max(3, Math.round(3.5 * dpr));
  lg.beginPath();
  for (let y = 0.5; y < h; y += pitch) { lg.moveTo(0, y); lg.lineTo(w, y); }
  lg.stroke();
  lg.globalCompositeOperation = 'destination-in';
  lg.imageSmoothingEnabled = true;
  lg.drawImage(mask, 0, 0, w, h);

  // lines: the coast at sea level and round the lakes, and four contours
  const coast = isoPath(elev, W, H, sea, sx, sy);
  const lakeV = new Float32Array(N);
  for (let i = 0; i < N; i++) lakeV[i] = water[i] === WATER.LAKE ? 1 : 0;
  coast.addPath(isoPath(lakeV, W, H, 0.5, sx, sy));
  const contours = new Path2D();
  for (const k of [0.07, 0.14, 0.21, 0.28]) contours.addPath(isoPath(elev, W, H, sea + k, sx, sy));

  // the plates: their seams, and an arrow for each plate's drift
  // the plates: each plate's edge traced smooth, the continental plates a shade lighter
  const seams = new Path2D(), plateF = f.plate;
  const genPlates = world.sys?.gen?.plates || [];
  const toneImg = new ImageData(W, H);
  if (plateF) {
    const ids = new Set(plateF);
    const ind = new Float32Array(N);
    for (const id of ids) {
      for (let i = 0; i < N; i++) ind[i] = plateF[i] === id ? 1 : 0;
      seams.addPath(isoPath(ind, W, H, 0.5, sx, sy));
    }
    for (let i = 0; i < N; i++) {
      if (!genPlates[plateF[i]]?.continental) continue;
      toneImg.data[i * 4] = 237; toneImg.data[i * 4 + 1] = 227; toneImg.data[i * 4 + 2] = 203; toneImg.data[i * 4 + 3] = 16;
    }
  }
  const toneSmall = canvas(W, H);
  toneSmall.getContext('2d').putImageData(toneImg, 0, 0);
  const plateTone = canvas(w, h);
  { const g = plateTone.getContext('2d'); g.imageSmoothingEnabled = true; g.drawImage(toneSmall, 0, 0, w, h); }
  const drift = [];
  let vmax = 1e-6;
  for (const q of genPlates) vmax = Math.max(vmax, Math.hypot(q.vx || 0, q.vy || 0));
  for (const q of genPlates) {
    const v = Math.hypot(q.vx || 0, q.vy || 0);
    if (!(v > 1e-6) || !(q.area > 0.01)) continue;
    // the generator keeps plate centres in map tiles
    const x = ((q.x % W) + W) % W, y = Math.max(0, Math.min(H - 1, q.y));
    drift.push({ x: x * sx, y: y * sy, dx: q.vx / v, dy: q.vy / v, v: v / vmax });
  }

  // rivers, springs first: each river tile to the tile it drains into, by how much flows there
  const segs = [];
  const flow = f.flow, river = f.river, dir = f.flowDir;
  if (river && dir) {
    for (let i = 0; i < N; i++) {
      if (river[i] < 2 || isSea(i)) continue;
      const j = dir[i];
      if (!(j >= 0)) continue;
      segs.push([((i % W) + 0.5) * sx, (((i / W) | 0) + 0.5) * sy, ((j % W) + 0.5) * sx, (((j / W) | 0) + 0.5) * sy, flow ? flow[i] : river[i], Math.max(0, river[i] - 2)]);
    }
    segs.sort((a, b) => a[4] - b[4]);
  }
  return { sea, rawElev, rawMax, shadeRaw, shade, hatch, coast, contours, seams, plateTone, drift, rivers: segs, sx, sy };
}

/** Marching squares: the line where field v crosses t, through cell centres, scaled to the plate. */
function isoPath(v, W, H, t, sx, sy) {
  const p = new Path2D();
  const lerp = (a, b) => (Math.abs(b - a) < 1e-9 ? 0.5 : (t - a) / (b - a));
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const i = y * W + x;
      const a = v[i], b = v[i + 1], c = v[i + W + 1], d = v[i + W];
      const m = (a >= t ? 8 : 0) | (b >= t ? 4 : 0) | (c >= t ? 2 : 0) | (d >= t ? 1 : 0);
      if (m === 0 || m === 15) continue;
      const X = (u) => (x + 0.5 + u) * sx, Y = (u) => (y + 0.5 + u) * sy;
      const T = [X(lerp(a, b)), Y(0)], R = [X(1), Y(lerp(b, c))], B = [X(lerp(d, c)), Y(1)], Lf = [X(0), Y(lerp(a, d))];
      const seg = (P, Q) => { p.moveTo(P[0], P[1]); p.lineTo(Q[0], Q[1]); };
      switch (m) {
        case 1: case 14: seg(Lf, B); break;
        case 2: case 13: seg(B, R); break;
        case 3: case 12: seg(Lf, R); break;
        case 4: case 11: seg(T, R); break;
        case 5: seg(Lf, T); seg(B, R); break;
        case 6: case 9: seg(T, B); break;
        case 7: case 8: seg(Lf, T); break;
        case 10: seg(T, R); seg(Lf, B); break;
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
