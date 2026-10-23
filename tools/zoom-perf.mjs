#!/usr/bin/env node
// Zoom performance and close-zoom acceptance for the renderer (WP7), in headless Chrome with
// the GPU on. Serves the project itself, opens the app, waits for a world, then measures:
//
//   1. zoom sweep z 10 → 80 over 90 frames, the GPU flushed every frame: median ≤ 12 ms, p90 ≤ 20 ms
//   2. a second sweep, after the caches have been warmed at every zoom of the sweep: the sprite
//      caches stay stable (≤ 5 % growth). The first sweep's chunk-build budget (2 a frame) never
//      reaches the deep levels, so their sprites would otherwise first appear in the second sweep
//      and read as churn
//   3. panning at z 20: the close-detail layer (chunk upkeep and blits, GPU included) ≤ 8 ms,
//      and the whole frame (GPU flushed, no layer profiling) p90 ≤ 20 ms
//   4. z 80: no magnification blur — the frame's fine structure (mean Laplacian) at least twice
//      that of the bare terrain raster upscaled over the same view
//   5. 50 fps at 1440 × 900 with the simulation running at Normal speed, the app's own loop
//
//   node tools/zoom-perf.mjs [--seed atlas] [--years 300] [--save world.json] [--port 9333]
//                            [--width 1440] [--height 900] [--dpr 1] [--shots dir] [--keep]
//
// --save loads a world saved by `node tools/headless.mjs --save` instead of simulating
// --years in the browser (much faster). The GPU is flushed by reading one pixel through a tiny
// side canvas (renderer.gpuFlush): reading the map canvas itself would make Chrome move it off
// the GPU for good and measure the software path instead. Results are noisy on a busy machine.
// Exit code 1 when a check fails.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const flag = (k) => args.includes('--' + k);
const W = Number(opt('width', 1440)), H = Number(opt('height', 900)), DPR = Number(opt('dpr', 1));
const seed = opt('seed', 'atlas'), years = Number(opt('years', 300));
const savePath = opt('save', null);
const shots = opt('shots', null);
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- a static server for the project (and the save, if any) ---------------------------------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = p === '/__save.json' && savePath ? resolve(savePath) : join(root, normalize(p));
    const st = await stat(file).catch(() => null);
    if (st && st.isDirectory()) file = join(file, 'index.html');
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch (e) { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

// --- headless Chrome over the DevTools protocol --------------------------------------------
const port = Number(opt('port', 9333));
const profile = join(tmpdir(), `atlas-zoom-perf-${port}`);
const chrome = spawn(CHROME, ['--headless=new', '--hide-scrollbars', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
  `--window-size=${W},${H}`, '--no-first-run', '--no-default-browser-check', ...(DPR !== 1 ? [`--force-device-scale-factor=${DPR}`] : []), 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore'] });
const cleanup = () => { try { chrome.kill('SIGKILL'); } catch (e) { /* gone */ } try { server.close(); } catch (e) { /* closed */ } };
process.on('exit', cleanup);
let wsUrl = null;
for (let k = 0; k < 150 && !wsUrl; k++) {
  try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl; } catch (e) { /* not up yet */ }
  if (!wsUrl) await sleep(100);
}
if (!wsUrl) { console.error('Chrome did not start (set CHROME=/path/to/chrome)'); process.exit(2); }
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let nextId = 1;
const pending = new Map();
const errors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
});
const send = (method, params = {}) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: false });
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
const waitFor = async (expr, ms) => { const end = Date.now() + ms; for (;;) { try { if (await ev(expr)) return true; } catch (e) { /* page busy */ } if (Date.now() > end) return false; await sleep(250); } };

const t0 = Date.now();
if (savePath) {
  await send('Page.navigate', { url: `${base}index.html` });
  if (!await waitFor('window.atlasReady === true', 120000)) { console.error('the app did not start'); process.exit(2); }
  const ok = await ev(`(async () => { const ser = await import('/src/core/serialize.js'); const w = ser.deserializeWorld(await (await fetch('/__save.json')).json()); return atlas.app.restoreWorld(w, { reason: 'zoom-perf' }); })()`);
  if (!ok) { console.error('the save could not be opened'); process.exit(2); }
} else {
  await send('Page.navigate', { url: `${base}index.html?autostart=1&seed=${encodeURIComponent(seed)}&years=${years}&speed=0&ui=hidden` });
  if (!await waitFor('window.atlasReady === true && !!(window.atlas && atlas.world)', 900000)) { console.error('no world after the leap'); process.exit(2); }
}
await ev(`(() => { atlas.app.setSpeed(0); atlas.app.emit('layout', 'hide-ui'); for (const d of document.querySelectorAll('dialog[open]')) { try { d.close(); } catch (e) {} } return true; })()`);
await sleep(1500);
const world = await ev(`({ year: Math.floor(atlas.world.time.day / 360), towns: atlas.world.settlements.filter(s => s && s.alive).length, gpu: (() => { const gl = document.createElement('canvas').getContext('webgl'); const e = gl && gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; })() })`);
console.log(`World at Year ${world.year}, ${world.towns} towns · ${W}×${H} @${DPR}x · GPU ${world.gpu} · ready in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

// --- 1 & 2: zoom sweeps --------------------------------------------------------------------
const sweep = `new Promise((res) => {
  const r = atlas.renderer, c = r.camera, w = atlas.world;
  const S = w.settlements.filter((s) => s && s.alive).sort((a, b) => b.population - a.population)[0];
  c._flight = null; c._zoomAnim = null; c.x = S.x + 0.5; c.y = S.y + 0.5; c.zoom = 10;
  atlas.app.running = false;
  const count = () => r.sprites.map.size + r.labeler.cache.map.size + r.lod.sprites.reduce((a, s) => a + s.map.size, 0);
  const before = count();
  let n = 0; const ms = []; const N = 90;
  const step = () => {
    c.zoom = 10 * Math.pow(8, n / N);
    const t0 = performance.now(); r.render(performance.now()); r.gpuFlush(); ms.push(performance.now() - t0);
    if (++n < N) requestAnimationFrame(step);
    else { atlas.app.running = true; const s = ms.slice().sort((a, b) => a - b); res({ med: s[N >> 1], p90: s[Math.floor(N * 0.9)], max: s[N - 1], before, after: count() }); }
  };
  requestAnimationFrame(step);
})`;
const s1 = await ev(sweep);
// warm: hold each zoom of the sweep until its chunks and plans are built (at most 3 s each)
const warm = await ev(`new Promise((res) => {
  const r = atlas.renderer, c = r.camera;
  atlas.app.running = false;
  let k = 0, f = 0; const steps = 12;
  const step = () => {
    c.zoom = 10 * Math.pow(8, k / steps);
    r.render(performance.now());
    f++;
    if ((r.lod.stats.queue === 0 && f > 4) || f > 180) { k++; f = 0; }
    if (k <= steps) requestAnimationFrame(step); else { atlas.app.running = true; res({ chunks: r.lod.map.size }); }
  };
  requestAnimationFrame(step);
})`);
const s2 = await ev(sweep);
const checks = [];
const check = (ok, label) => { checks.push({ ok, label }); console.log(`  ${ok ? 'ok' : '!!'} ${label}`); };
console.log('Zoom sweep z 10 → 80 (GPU flushed every frame)');
check(s1.med <= 12 && s1.p90 <= 20, `first sweep: median ${s1.med.toFixed(1)} ms (≤ 12), p90 ${s1.p90.toFixed(1)} ms (≤ 20), worst ${s1.max.toFixed(1)} ms`);
check(s2.med <= 12 && s2.p90 <= 20, `second sweep: median ${s2.med.toFixed(1)} ms, p90 ${s2.p90.toFixed(1)} ms, worst ${s2.max.toFixed(1)} ms`);
const growth = (s2.after - s2.before) / Math.max(1, s2.before);
check(growth <= 0.05, `sprite caches stable on the second sweep (after warming ${warm.chunks} chunks): ${s2.before} → ${s2.after} (${(growth * 100).toFixed(1)} %, ≤ 5 %); the first sweep grew them ${s1.before} → ${s1.after}`);

// --- 3: panning at z 20 --------------------------------------------------------------------
const pan = await ev(`new Promise((res) => {
  const r = atlas.renderer, c = r.camera;
  c.zoom = 20; atlas.app.running = false;
  r.profileLayers = true; r.stats.layers = {};
  let n = 0; const x0 = c.x; const det = [], tot = [];
  const step = () => {
    c.x = x0 + n * 0.25;
    const t0 = performance.now(); r.render(performance.now()); r.gpuFlush(); tot.push(performance.now() - t0);
    det.push(r.stats.layers.detail || 0);
    if (++n < 60) requestAnimationFrame(step);
    else { r.profileLayers = false; atlas.app.running = true; const d = det.slice(10).sort((a, b) => a - b), t = tot.slice(10).sort((a, b) => a - b); res({ detail: d[d.length >> 1], detailP90: d[Math.floor(d.length * 0.9)], frame: t[t.length >> 1], builds: r.lod.stats.builds }); }
  };
  requestAnimationFrame(step);
})`);
// the whole frame while panning, without per-layer profiling (whose flushes would inflate it)
const panFrame = await ev(`new Promise((res) => {
  const r = atlas.renderer, c = r.camera;
  c.zoom = 20; atlas.app.running = false; r.profileLayers = false;
  let n = 0; const x0 = c.x; const tot = [];
  const step = () => {
    c.x = x0 - n * 0.25;
    const t0 = performance.now(); r.render(performance.now()); r.gpuFlush(); tot.push(performance.now() - t0);
    if (++n < 70) requestAnimationFrame(step);
    else { atlas.app.running = true; const t = tot.slice(10).sort((a, b) => a - b); res({ med: t[t.length >> 1], p90: t[Math.floor(t.length * 0.9)] }); }
  };
  requestAnimationFrame(step);
})`);
console.log('Panning at z 20');
check(pan.detail <= 8, `close-detail layer ${pan.detail.toFixed(2)} ms median, p90 ${pan.detailP90.toFixed(2)} ms (≤ 8; layer timing includes a GPU flush), whole frame ${pan.frame.toFixed(1)} ms with profiling`);
check(panFrame.p90 <= 20, `whole frame while panning: median ${panFrame.med.toFixed(1)} ms, p90 ${panFrame.p90.toFixed(1)} ms (≤ 20, GPU flushed)`);

// --- 4: no magnification blur at z 80 ------------------------------------------------------
const blur = await ev(`new Promise((res) => {
  const r = atlas.renderer, c = r.camera;
  c.zoom = 80;
  const done = () => {
    // fine structure: mean |Laplacian| of luminance, of the frame and of the bare raster upscaled
    const cw = Math.min(800, r.canvas.width), ch = Math.min(600, r.canvas.height);
    const ox = (r.canvas.width - cw) >> 1, oy = (r.canvas.height - ch) >> 1;
    const lap = (src, sx, sy, sw, sh) => {
      const t = document.createElement('canvas'); t.width = cw; t.height = ch;
      const g = t.getContext('2d', { willReadFrequently: true });
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'low';
      g.drawImage(src, sx, sy, sw, sh, 0, 0, cw, ch);
      const d = g.getImageData(0, 0, cw, ch).data;
      const L = new Float32Array(cw * ch);
      for (let i = 0; i < cw * ch; i++) L[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
      let s = 0, n = 0;
      for (let y = 1; y < ch - 1; y++) for (let x = 1; x < cw - 1; x++) { const i = y * cw + x; s += Math.abs(4 * L[i] - L[i - 1] - L[i + 1] - L[i - cw] - L[i + cw]); n++; }
      return s / n;
    };
    const frame = lap(r.canvas, ox, oy, cw, ch);
    // the same view of the raster alone: the canvas region (device px) back to raster px
    const T = r.terrain.T, z = c.zoom * r.dpr;
    const wx0 = c.x - (r.viewW / 2) / c.zoom + ox / z, wy0 = c.y - (r.viewH / 2) / c.zoom + oy / z;
    const raster = lap(r.terrain.canvas, wx0 * T, wy0 * T, (cw / z) * T, (ch / z) * T);
    res({ frame, raster, k: r.lod.stats.k, fallback: r.lod.stats.fallback, queue: r.lod.stats.queue });
  };
  let n = 0;
  const step = () => { if (++n < 90 && atlas.renderer.lod.stats.queue > 0) requestAnimationFrame(step); else setTimeout(done, 400); };
  requestAnimationFrame(step);
})`);
console.log('Deep zoom z 80');
check(blur.frame >= blur.raster * 2 && blur.fallback === 0, `fine structure ${blur.frame.toFixed(2)} vs the bare raster's ${blur.raster.toFixed(2)} (×${(blur.frame / Math.max(1e-6, blur.raster)).toFixed(1)}, ≥ ×2), detail level ${blur.k}, ${blur.fallback} chunks on fallback`);
if (shots) {
  await mkdir(shots, { recursive: true });
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(shots, 'zoom-perf-z80.png'), Buffer.from(shot.data, 'base64'));
  console.log(`  (screenshot ${join(shots, 'zoom-perf-z80.png')})`);
}

// --- 5: frame rate with the world running ----------------------------------------------------
const fps = await ev(`new Promise((res) => {
  const r = atlas.renderer, c = r.camera;
  c.zoom = 14; atlas.app.running = true; atlas.app.setSpeed(2);
  const f0 = r.stats.frames, t0 = performance.now();
  setTimeout(() => { const f = (r.stats.frames - f0) / ((performance.now() - t0) / 1000); atlas.app.setSpeed(0); res({ fps: f, frameMs: r.stats.frameMs }); }, 4000);
})`);
console.log('Running at Normal speed, z 14');
check(fps.fps >= 50, `${fps.fps.toFixed(1)} fps (≥ 50), render ${fps.frameMs.toFixed(1)} ms a frame (script)`);

if (errors.length) { console.log(`Page errors (${errors.length}):`); for (const e of errors.slice(0, 5)) console.log('  ' + String(e).split('\n')[0]); }
const failed = checks.filter((c) => !c.ok).length;
console.log(failed ? `${failed} check(s) failed` : 'All checks passed');
ws.close();
if (!flag('keep')) cleanup();
process.exit(failed || errors.length ? 1 : 0);
