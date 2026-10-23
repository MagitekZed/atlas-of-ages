// The soundscape: one switch (off until the viewer turns it on), nothing downloaded — every
// sound is synthesised with WebAudio. Great effects get voices as they start on the map
// (renderer.onFx): the low rumble of a quake or an eruption, a falling star's whoosh and
// boom, thunder, the long swell of a wave, muffled drums for battles, a bright chord for a
// founding or a wonder, a bell for a discovery, a dark cluster for plague. Each is panned by
// where it happens on screen and softened with distance. God tools answer the hand with a
// soft "thock", or a dull "thud" when refused. A quiet bed of surf follows how much sea is
// in view. The audio context starts on a gesture, rests while time is paused or the page is
// hidden, and fails silently where sound is not allowed. A one-time card offers sound after
// the first act.

import { registerCommand } from './registry.js';
import { getPref, setPref } from './prefs.js';
import { offerToast } from './toasts.js';

const VOICE_CAP = 14;
const MIN_GAP = { battle: 260, siege: 600, quake: 400, eruption: 900, meteor: 400, tsunami: 900, lightning: 220, founding: 500, wonder: 900, discovery: 700, plague: 1200, divine: 300, newcivs: 900, capture: 700, landfall: 900, flood: 900, fire: 1500, faith: 900, rebellion: 900, raid: 500, famine: 1500 };

export function mount(app) {
  const prefs = { on: false, vol: 0.6, ambient: true, ...(getPref('story.sound', {}) || {}) };
  const save = () => setPref('story.sound', { on: prefs.on, vol: prefs.vol, ambient: prefs.ambient, asked: prefs.asked });
  let ac = null, master = null, comp = null;
  let noise = null;
  let voices = 0;
  const last = new Map();
  let surf = null;

  function ensure() {
    if (ac) return ac;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ac = new AC();
      comp = ac.createDynamicsCompressor();
      comp.threshold.value = -18; comp.ratio.value = 4;
      master = ac.createGain();
      master.gain.value = prefs.vol * 0.7;
      master.connect(comp); comp.connect(ac.destination);
      noise = makeNoise(ac);
    } catch (e) { ac = null; }
    return ac;
  }
  const live = () => prefs.on && ac && ac.state === 'running';

  function makeNoise(ctx) {
    const len = ctx.sampleRate * 2;
    const white = ctx.createBuffer(1, len, ctx.sampleRate), brown = ctx.createBuffer(1, len, ctx.sampleRate);
    const wd = white.getChannelData(0), bd = brown.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) { const r = Math.random() * 2 - 1; wd[i] = r; b = (b + 0.02 * r) / 1.02; bd[i] = b * 3.5; }
    return { white, brown };
  }

  /** A voice: route(src → … → pan → master), cleaned up when it ends. */
  function voice(build, { pan = 0, gain = 1, dur = 1 }) {
    if (!live() || voices >= VOICE_CAP) return;
    voices++;
    const t = ac.currentTime;
    const out = ac.createGain();
    out.gain.value = Math.max(0, Math.min(1.4, gain));
    const p = ac.createStereoPanner ? ac.createStereoPanner() : null;
    if (p) { p.pan.value = Math.max(-1, Math.min(1, pan)); out.connect(p); p.connect(master); } else out.connect(master);
    try { build(t, out); } catch (e) { /* a voice that cannot play is skipped */ }
    setTimeout(() => { voices--; try { out.disconnect(); p?.disconnect(); } catch (e) { /* gone */ } }, (dur + 0.3) * 1000);
  }
  const env = (g, t, a, peak, d) => { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); };
  function noiseSrc(t, kind = 'white', dur = 2) { const s = ac.createBufferSource(); s.buffer = kind === 'brown' ? noise.brown : noise.white; s.loop = true; s.start(t); s.stop(t + dur); return s; }
  function osc(type, f, t, dur) { const o = ac.createOscillator(); o.type = type; o.frequency.value = f; o.start(t); o.stop(t + dur); return o; }
  function filt(type, f, q = 0.7) { const b = ac.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }

  const RECIPES = {
    rumble(t, out, m = 1) { const s = noiseSrc(t, 'brown', 3.4); const f = filt('lowpass', 90); const g = ac.createGain(); env(g, t, 0.25, 0.9 * m, 2.8); s.connect(f); f.connect(g); g.connect(out); },
    thunder(t, out) { const s = noiseSrc(t, 'white', 2.4); const f = filt('lowpass', 1800); f.frequency.setValueAtTime(1800, t); f.frequency.exponentialRampToValueAtTime(120, t + 1.8); const g = ac.createGain(); env(g, t, 0.01, 0.8, 2); s.connect(f); f.connect(g); g.connect(out); },
    meteor(t, out) {
      const s = noiseSrc(t, 'white', 1.2); const f = filt('bandpass', 400, 2); f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(2400, t + 0.9);
      const g = ac.createGain(); env(g, t, 0.7, 0.35, 0.2); s.connect(f); f.connect(g); g.connect(out);
      RECIPES.rumble(t + 0.85, out, 1.3);
      const o = osc('sine', 55, t + 0.85, 1.2); const og = ac.createGain(); env(og, t + 0.85, 0.01, 0.8, 1.1); o.frequency.exponentialRampToValueAtTime(28, t + 2); o.connect(og); og.connect(out);
    },
    swell(t, out) { const s = noiseSrc(t, 'white', 4.5); const f = filt('lowpass', 500); const g = ac.createGain(); env(g, t, 1.6, 0.45, 2.6); s.connect(f); f.connect(g); g.connect(out); },
    drums(t, out) { for (let k = 0; k < 3; k++) { const at = t + k * 0.16 + Math.random() * 0.03; const o = osc('sine', 70 + Math.random() * 15, at, 0.3); o.frequency.exponentialRampToValueAtTime(45, at + 0.25); const g = ac.createGain(); env(g, at, 0.005, 0.5, 0.25); o.connect(g); g.connect(out); } },
    chord(t, out, root = 262, minor = false) { for (const r of [1, minor ? 1.189 : 1.26, 1.498]) { const o = osc('sine', root * r, t, 2.6); const g = ac.createGain(); env(g, t, 0.35, 0.16, 2.1); o.connect(g); g.connect(out); } const s = osc('sawtooth', root / 2, t, 2.4); const sf = filt('lowpass', 600); const sg = ac.createGain(); env(sg, t, 0.5, 0.05, 1.8); s.connect(sf); sf.connect(sg); sg.connect(out); },
    bell(t, out) { for (const [r, a] of [[1, 0.25], [2.76, 0.1], [5.4, 0.05]]) { const o = osc('sine', 660 * r, t, 2.4); const g = ac.createGain(); env(g, t, 0.005, a, 2.2); o.connect(g); g.connect(out); } },
    dark(t, out) { for (const f of [110, 116.5, 98]) { const o = osc('sawtooth', f, t, 3); const lp = filt('lowpass', 420); const g = ac.createGain(); env(g, t, 0.9, 0.06, 2); o.connect(lp); lp.connect(g); g.connect(out); } },
    horn(t, out) { const o = osc('sawtooth', 147, t, 1.3); o.frequency.setValueAtTime(130, t); o.frequency.linearRampToValueAtTime(147, t + 0.2); const f = filt('lowpass', 900); const g = ac.createGain(); env(g, t, 0.12, 0.22, 1); o.connect(f); f.connect(g); g.connect(out); },
    thock(t, out) { const o = osc('triangle', 520, t, 0.15); o.frequency.exponentialRampToValueAtTime(240, t + 0.1); const g = ac.createGain(); env(g, t, 0.003, 0.35, 0.11); o.connect(g); g.connect(out); },
    thud(t, out) { const o = osc('sine', 120, t, 0.2); o.frequency.exponentialRampToValueAtTime(70, t + 0.15); const g = ac.createGain(); env(g, t, 0.004, 0.45, 0.16); o.connect(g); g.connect(out); },
  };
  const FOR = {
    quake: ['rumble', 3], eruption: ['rumble', 3.5], meteor: ['meteor', 3], lightning: ['thunder', 2.4], landfall: ['thunder', 2.4], tsunami: ['swell', 4.5], flood: ['swell', 4.5],
    battle: ['drums', 0.8], siege: ['drums', 0.8], capture: ['horn', 1.4], raid: ['drums', 0.8],
    founding: ['chord', 2.6], wonder: ['chord', 2.6], newcivs: ['chord', 2.6], faith: ['chord', 2.6], divine: ['chord', 2.6],
    discovery: ['bell', 2.4], plague: ['dark', 3], famine: ['dark', 3], rebellion: ['horn', 1.4], fire: ['rumble', 3],
  };

  function onFx(fx, info) {
    if (!live() || app.speed === 0 && fx.src !== 'tool') return;
    const r = FOR[fx.type];
    if (!r) return;
    const now = performance.now();
    if (now - (last.get(fx.type) || 0) < (MIN_GAP[fx.type] || 300)) return;
    last.set(fx.type, now);
    const z = app.renderer?.camera?.zoom || 6;
    const far = Math.max(0, 1 - (info?.dist || 0) / 1500);
    const gain = (info?.onScreen ? 1 : 0.35) * far * (fx.src === 'tool' ? 1.2 : 1) * Math.min(1.2, 0.6 + z / 30);
    if (gain < 0.05) return;
    const pan = info && app.renderer?.viewW ? ((info.sx / app.renderer.viewW) * 2 - 1) * 0.8 : 0;
    const minor = fx.type === 'divine' && fx.tone === 'curse';
    voice((t, out) => (r[0] === 'chord' ? RECIPES.chord(t, out, fx.type === 'wonder' ? 196 : 262, minor) : RECIPES[r[0]](t, out)), { pan, gain, dur: r[1] });
  }

  // hook the renderer's fx announcements, keeping anyone else's listener
  let wired = null;
  function wire() {
    const r = app.renderer;
    if (!r || wired === r) return;
    wired = r;
    const prev = typeof r.onFx === 'function' ? r.onFx : null;
    r.onFx = (fx, info) => { if (prev) { try { prev(fx, info); } catch (e) { /* theirs */ } } try { onFx(fx, info); } catch (e) { /* sound never breaks the map */ } };
  }
  app.on('renderer', wire);
  app.on('world', wire);

  // the hand's own feedback, and the one-time offer
  app.on('toolApplied', (p) => {
    if (live()) voice((t, out) => (p?.result?.ok === false ? RECIPES.thud : RECIPES.thock)(t, out), { gain: 0.8, dur: 0.3 });
    if (!prefs.on && !prefs.asked && p?.result?.ok !== false) {
      prefs.asked = true; save();
      offerToast(app, { icon: 'storm', kicker: 'Sound', title: 'Hear the world?', text: 'Quakes rumble, stars fall with a roar and battles beat their drums. All of it is made on the spot; nothing is downloaded.', ms: 12000, actions: [{ label: 'Turn sound on', primary: true, run: () => setOn(true) }, { label: 'Not now', run: () => {} }] });
    }
  });

  // a bed of surf that follows how much sea is in view
  let surfAt = 0;
  function ambient(t) {
    requestAnimationFrame(ambient);
    if (t - surfAt < 500) return;
    surfAt = t;
    if (!live() || !prefs.ambient || !app.world || document.getElementById('app').dataset.mode !== 'world') { if (surf) surf.g.gain.setTargetAtTime(0, ac?.currentTime || 0, 0.4); return; }
    if (!surf) {
      const s = ac.createBufferSource(); s.buffer = noise.white; s.loop = true;
      const f = filt('lowpass', 520); const g = ac.createGain(); g.gain.value = 0;
      const lfo = ac.createOscillator(); lfo.frequency.value = 0.11; const lg = ac.createGain(); lg.gain.value = 180;
      lfo.connect(lg); lg.connect(f.frequency);
      s.connect(f); f.connect(g); g.connect(master); s.start(); lfo.start();
      surf = { g };
    }
    const r = app.renderer, w = app.world;
    let sea = 0;
    if (r?.camera && w) {
      const cam = r.camera, hw = r.viewW / 2 / cam.zoom, hh = r.viewH / 2 / cam.zoom;
      let n = 0;
      for (let k = 0; k < 25; k++) {
        const x = Math.floor(cam.x - hw + ((k % 5) + 0.5) * (2 * hw / 5)), y = Math.floor(cam.y - hh + (Math.floor(k / 5) + 0.5) * (2 * hh / 5));
        if (x < 0 || y < 0 || x >= w.W || y >= w.H) continue;
        n++;
        if (w.f.water[y * w.W + x] !== 0) sea++;
      }
      sea = n ? sea / n : 0;
    }
    const near = r?.camera ? Math.min(1, r.camera.zoom / 18) : 0;
    surf.g.gain.setTargetAtTime(0.05 * sea * (0.4 + near) * (app.speed === 0 ? 0.6 : 1), ac.currentTime, 0.8);
  }
  requestAnimationFrame(ambient);

  document.addEventListener('visibilitychange', () => { if (!ac) return; if (document.visibilityState === 'hidden') ac.suspend().catch(() => {}); else if (prefs.on) ac.resume().catch(() => {}); });

  function setOn(v) {
    prefs.on = Boolean(v);
    prefs.asked = true;
    save();
    if (prefs.on) { const c = ensure(); c?.resume?.().catch(() => {}); voice((t, out) => RECIPES.bell(t, out), { gain: 0.5, dur: 2.4 }); }
    else if (ac) ac.suspend().catch(() => {});
    app.emit('sound', prefs.on);
  }
  function setVolume(v) { prefs.vol = Math.max(0, Math.min(1, v)); save(); if (master) master.gain.value = prefs.vol * 0.7; }
  app.sound = { get on() { return prefs.on; }, setOn, setVolume, get volume() { return prefs.vol; } };

  // a viewer who chose sound earlier hears it again after their first click
  if (prefs.on) document.addEventListener('pointerdown', () => { const c = ensure(); c?.resume?.().catch(() => {}); }, { once: true, capture: true });

  registerCommand({ id: 'sound.toggle', label: 'Sound on or off', group: 'Sound', icon: 'storm', keywords: ['audio', 'mute', 'music', 'volume'], menu: 'Sound', when: () => true, run: () => setOn(!prefs.on) });
  registerCommand({ id: 'sound.ambient', label: 'Sea sounds on or off', group: 'Sound', icon: 'tsunami', keywords: ['ambience', 'surf', 'audio'], when: () => prefs.on, run: () => { prefs.ambient = !prefs.ambient; save(); } });
  registerCommand({ id: 'sound.louder', label: 'Louder', group: 'Sound', icon: 'storm', keywords: ['volume', 'audio'], when: () => prefs.on, run: () => setVolume(prefs.vol + 0.15) });
  registerCommand({ id: 'sound.softer', label: 'Softer', group: 'Sound', icon: 'storm', keywords: ['volume', 'audio', 'quieter'], when: () => prefs.on, run: () => setVolume(prefs.vol - 0.15) });
}
