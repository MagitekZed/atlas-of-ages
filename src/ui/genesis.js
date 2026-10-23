// The Genesis screen: choose the age of the world (Historical, Legendary or Mythic), a seed,
// a name, a preset and every genesis parameter, watch a live preview plate redraw as you go,
// then begin history. Parameters honour visibleIf (the Myth & Magic sliders appear with the
// Mythic age); presets are grouped by their mode; a Mythic plate shows the ley network and the
// likely homelands of each race from the myth module's pure mythPreview(world).

import { PARAMS, PARAM_GROUPS, PRESETS, PARAM_BY_KEY, defaultParams, coerceParam, paramVisible } from '../core/params.js';
import { createWorld, elevationMeters } from '../core/world.js';
import { WATER, MAP_SIZES, RACE_META } from '../core/constants.js';
import { h, clear, svgEl, debounce, nextFrame } from './dom.js';
import { glyph } from './icons.js';
import { paramControl, tip, graduationSVG } from './widgets.js';
import { int, pct, listing } from './format.js';
import { getPref, setPref } from './prefs.js';

// the myth module's DOM-free parts (guarded: Genesis works without them)
let mythPrev = null, folklore = null, mythRaces = null;
try { mythPrev = await import('../sim/myth/preview.js'); } catch (e) { /* no Mythic plate overlay */ }
try { folklore = await import('../sim/myth/folklore.js'); } catch (e) { /* no Legendary deck: Legendary stays disabled */ }
try { mythRaces = await import('../sim/myth/races.js'); } catch (e) { /* race colours fall back to RACE_META */ }
const raceColor = (r) => (mythRaces?.raceRgb ? mythRaces.raceRgb(r) : RACE_META[r]?.color || [150, 140, 128]);
/** Legendary needs the folklore deck (src/sim/myth/folklore.js registers it in core/events.js). */
const LEGENDARY_READY = Boolean(folklore && folklore.FOLKLORE_READY);

const SEED_A = ['amber', 'ashen', 'cobalt', 'dusk', 'ember', 'frost', 'gilded', 'hollow', 'iron', 'jade', 'lumen', 'mossy', 'north', 'onyx', 'pale', 'quiet', 'russet', 'salt', 'tidal', 'umber', 'verdant', 'wild', 'zephyr', 'silver', 'storm', 'cinder', 'opal', 'sable'];
const SEED_B = ['reach', 'crown', 'fen', 'spire', 'drift', 'harbor', 'vale', 'mere', 'steppe', 'marches', 'isles', 'deep', 'barrow', 'ridge', 'strand', 'weald', 'tor', 'firth', 'moor', 'holt', 'sound', 'cairn'];

/** A fresh, pronounceable seed. Cosmetic randomness only (never used inside the simulation). */
export function randomSeed() {
  const a = SEED_A[Math.floor(Math.random() * SEED_A.length)];
  const b = SEED_B[Math.floor(Math.random() * SEED_B.length)];
  return `${a}-${b}-${Math.floor(Math.random() * 900 + 100)}`;
}

// ---------------------------------------------------------------------------
// The three ages

const MYTH_KEYS = new Set(PARAMS.filter((p) => p.group === 'myth').map((p) => p.key));
/** Params kept off the screen until something reads them (wildMagic is reserved for wave 2). */
const RESERVED = new Set(['wildMagic']);
const AGES = [
  {
    level: 0, label: 'Historical', kicker: 'A world of history',
    desc: 'Only people: tribes become empires, faiths rise and plagues burn, and nothing walks the world that could not.',
    sub: 'Set the conditions of a new world. Then let the ages run: continents and climates, forests and herds, tribes becoming empires, faiths, plagues and wars.',
    begin: 'Begin history',
    // an astrolabe: the measured world
    emblem: '<circle cx="16" cy="16" r="11"/><ellipse cx="16" cy="16" rx="11" ry="4.4"/><ellipse cx="16" cy="16" rx="4.4" ry="11"/><path d="M5 16h22M16 5v22"/><circle cx="16" cy="16" r="1.6" fill="currentColor" stroke="none"/>',
  },
  {
    level: 1, label: 'Legendary', kicker: 'A world of legend',
    desc: 'Omens, saints and haunted ruins. Comets topple kings and prophecies come true, but wonders live in belief alone.',
    sub: 'Set the conditions of a world that believes in wonders. Then let the ages run: bearded stars and saints’ bones, witch-hunts and haunted ruins, and prophecies that find their way to being true.',
    begin: 'Begin the legend',
    // a comet over the hills
    emblem: '<path d="M4 26c4-4 8-5 12-3s8 1 12-3"/><circle cx="22" cy="9" r="2.6"/><path d="M19.8 10.6 7 18M20.6 11.8 10 20.5M19 9.6 6 14.5" stroke-dasharray="1.4 1.8"/>',
  },
  {
    level: 2, label: 'Mythic', kicker: 'An age of myth',
    desc: 'Elves, dwarves, orcs, halflings and lizardfolk; ley lines and towers of wizardry; dragons in the high places and gods who answer.',
    sub: 'Set the conditions of an age of myth. Then let it run: elder races in the deep woods and under the hills, rivers of magic between the places of power, and the slow fading of wonder as the smoke rises.',
    begin: 'Begin the age of myth',
    // standing stones under a ley spiral
    emblem: '<path d="M6 27h20"/><path d="M9 27v-8.5c0-1 .7-1.7 1.6-1.7s1.6.7 1.6 1.7V27M14.4 27V15.2c0-1 .7-1.8 1.6-1.8s1.6.8 1.6 1.8V27M19.8 27v-7.8c0-1 .7-1.7 1.6-1.7s1.6.7 1.6 1.7V27"/><path d="M16 10.6c-2.8 0-4.4-1.6-4.4-3.6s1.7-3.4 3.6-3.4c1.6 0 2.8 1.1 2.8 2.6 0 1.2-.9 2-2 2-.9 0-1.5-.6-1.5-1.4" />',
  },
];
const ageOf = (level) => AGES[Math.max(0, Math.min(2, Number(level) || 0))];
const presetLevel = (p) => (p.mode === 'mythic' ? Number(p.params?.mythLevel ?? 2) : 0);

/**
 * Mount the Genesis screen.
 * opts: { generate(world, {preview}), renderPreview(world, canvas), genAvailable, onBegin(params), onLoad(), initial }
 */
export function mountGenesis(app, opts) {
  const root = document.getElementById('genesis');
  const body = document.getElementById('genesis-body');
  clear(body);

  const initial = opts.initial || {};
  let params = { ...defaultParams(), ...(getPref('genesisParams') || {}), worldName: '', ...initial };
  for (const k of Object.keys(params)) params[k] = coerceParam(k, params[k]);
  if (!initial.seed) params.seed = randomSeed();
  if (!LEGENDARY_READY && Number(params.mythLevel) === 1) params.mythLevel = 0;
  let presetId = initial.preset || null;
  if (presetId) {
    const p = PRESETS.find((q) => q.id === presetId);
    const { preset: _drop, ...overrides } = initial;   // ?set=… still applies on top of a ?preset=…
    if (p) params = { ...defaultParams(), ...p.params, ...overrides, seed: params.seed, worldSize: params.worldSize };
  }
  let presetDirty = false;
  const controls = new Map();

  // --- left column: the age, seed, name, size, presets, parameter groups ---------------
  const ageBtns = new Map();
  const ageBox = h('div.gen-ages', { role: 'radiogroup', 'aria-label': 'Age of the world' });
  for (const a of AGES) {
    const disabled = a.level === 1 && !LEGENDARY_READY;
    const b = h('button.gen-age', { type: 'button', role: 'radio', 'aria-checked': 'false', id: `gen-age-${a.level}`, dataset: { level: String(a.level) }, disabled: disabled || null },
      h('span.ga-emblem', { html: `<svg viewBox="0 0 32 32" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${a.emblem}</svg>` }),
      h('span.ga-text', null, h('span.ga-name', { text: a.label }), h('span.ga-desc', { text: disabled ? 'Coming: omens, saints and haunted ruins for worlds of history.' : a.desc })),
    );
    b.addEventListener('click', () => setAge(a.level));
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
      let lv = Number(params.mythLevel) || 0;
      for (let k = 0; k < 3; k++) { lv = (lv + dir + 3) % 3; if (lv !== 1 || LEGENDARY_READY) break; }
      setAge(lv);
      ageBtns.get(lv)?.focus();
    });
    ageBtns.set(a.level, b);
    ageBox.appendChild(b);
  }

  const seedInput = h('input.field.mono', { id: 'gen-seed', type: 'text', value: params.seed, maxlength: 64, autocomplete: 'off', spellcheck: 'false' });
  seedInput.value = params.seed;
  const reroll = h('button.btn', { type: 'button', 'aria-label': 'New random seed' }, svgEl(glyph('dice', 18)), 'Reroll');
  tip(reroll, 'Draw a new random seed: a different world under the same conditions.');
  const nameP = PARAM_BY_KEY.worldName;
  const nameInput = h('input.field', { id: 'gen-name', type: 'text', maxlength: nameP?.maxLength || 40, autocomplete: 'off', spellcheck: 'false', placeholder: 'Named in its own first tongue' });
  nameInput.value = params.worldName || '';
  const sizeParam = PARAM_BY_KEY.worldSize;
  const sizeSel = h('select.field', { id: 'gen-size' });
  for (const [v, lab] of sizeParam.options) {
    const s = MAP_SIZES[v];
    sizeSel.appendChild(h('option', { value: v, text: s ? `${lab} · ${s.w}×${s.h}` : lab }));
  }
  sizeSel.value = params.worldSize;

  const seedRow = h('div.gen-row', null,
    h('div.grow', null, h('label.gen-label', { for: 'gen-seed', text: 'Seed' }), seedInput),
    reroll,
  );
  const nameRow = nameP ? h('div', null, h('label.gen-label', { for: 'gen-name', text: 'World name' }), nameInput,
    h('p.gen-note', { text: nameP.desc, style: { marginTop: '5px' } })) : null;
  const sizeRow = h('div', null, h('label.gen-label', { for: 'gen-size', text: 'World size' }), sizeSel,
    h('p.gen-note', { text: sizeParam.desc, style: { marginTop: '5px' } }));

  const presetBox = h('div.gen-presets');
  const presetBtns = new Map();
  for (const p of PRESETS) {
    const lv = presetLevel(p);
    const b = h('button.preset', { type: 'button', role: 'listitem', 'aria-pressed': 'false', class: lv ? 'is-mythic' : '' },
      h('span.pn', { text: p.label }), h('span.pd', { text: p.desc }));
    b.addEventListener('click', () => applyPreset(p.id));
    presetBtns.set(p.id, b);
  }

  const groupsBox = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } });
  const groupMeta = new Map();
  const openGroups = getPref('genesisOpen', ['world', 'climate']);
  for (const g of PARAM_GROUPS) {
    const list = PARAMS.filter((p) => p.group === g.id && p.key !== 'worldSize' && p.type !== 'text' && !RESERVED.has(p.key));
    if (!list.length) continue;
    const modified = h('span.gm');
    const det = h('details.pgroup', { open: openGroups.includes(g.id) || null, class: g.id === 'myth' ? 'is-myth' : '' },
      h('summary', null,
        h('span.gt', { text: g.label }),
        h('span', { style: { display: 'inline-flex', gap: '10px', alignItems: 'center' } }, modified, svgEl(glyph('chevron', 16, 'chev'))),
        h('span.gd', { text: g.desc }),
      ),
    );
    det.addEventListener('toggle', () => {
      const open = PARAM_GROUPS.filter((q) => groupsBox.querySelector(`details[data-g="${q.id}"]`)?.open).map((q) => q.id);
      setPref('genesisOpen', open);
    });
    det.dataset.g = g.id;
    const inner = h('div.params');
    for (const p of list) {
      const c = paramControl(p, { idPrefix: 'gen', value: params[p.key], onChange: onParam });
      controls.set(p.key, c);
      inner.appendChild(c.el);
    }
    const resetG = h('button.link', { type: 'button', text: 'Reset this group to defaults', style: { fontSize: '12.5px', alignSelf: 'flex-start' } });
    resetG.addEventListener('click', () => {
      const d = defaultParams();
      for (const p of list) {
        if (p.key === 'mythLevel') continue;   // the age is the switch's to change
        params[p.key] = d[p.key]; controls.get(p.key)?.set(d[p.key]);
      }
      presetDirty = true; refreshPresetMarks(); refreshGroupCounts(); refreshVisible(); persist(); schedulePreview();
    });
    inner.appendChild(resetG);
    det.appendChild(inner);
    groupsBox.appendChild(det);
    groupMeta.set(g.id, { list, modified, det });
  }
  // the age select inside Myth & Magic follows the switch; Legendary waits for its deck
  const ageSel = controls.get('mythLevel')?.input;
  if (ageSel && !LEGENDARY_READY) {
    const o = ageSel.querySelector('option[value="1"]');
    if (o) { o.disabled = true; o.textContent = 'Legendary (coming)'; }
  }

  const controlsCol = h('div.gen-controls', null,
    h('div', null, h('span.gen-label', { text: 'Age of the world' }), ageBox),
    seedRow, nameRow, sizeRow,
    h('div', null, h('span.gen-label', { text: 'Presets' }), presetBox),
    h('div', null, h('span.gen-label', { text: 'Conditions' }), groupsBox),
  );

  // --- right column: preview plate --------------------------------------------------
  const canvas = h('canvas', { width: 640, height: 400, 'aria-label': 'Preview of the world map' });
  const busy = h('span.busy', { text: 'Surveying…', hidden: true });
  const grads = h('div.grads', { html: graduationSVG() });
  const plate = h('div.plate-frame.ticked', null, h('div.neat', null, canvas, grads), busy);
  const plateNo = h('span.pl', { text: 'Plate I · Preview' });
  const worldName = h('span.wn', { text: '' });
  const facts = h('div.plate-facts');
  const featureLine = h('p.plate-features');
  const mythLine = h('p.plate-myth', { hidden: true });
  const genWarn = h('p.gen-warn', { hidden: true });
  const beginBtn = h('button.btn.btn-brass.btn-lg', { type: 'button', id: 'gen-begin' }, 'Begin history');
  const START_OPTS = [[0, 'At the dawn of history'], [100, 'After 100 years'], [250, 'After 250 years'], [500, 'After 500 years'], [1000, 'After 1,000 years']];
  const startSel = h('select.field', { id: 'gen-start' });
  for (const [v, lab] of START_OPTS) startSel.appendChild(h('option', { value: String(v), text: lab }));
  const savedStart = Number(getPref('genesisStart', 0));
  startSel.value = String(START_OPTS.some(([v]) => v === savedStart) ? savedStart : 0);
  const startRow = h('div.start-row', null, h('label.gen-label', { for: 'gen-start', text: 'Start watching' }), startSel);
  tip(startSel, 'Let the first centuries run at full speed before you take the helm. Every day is still simulated; you can stop early.');
  const syncBeginLabel = () => { beginBtn.textContent = Number(startSel.value) > 0 ? 'Begin and leap ahead' : ageOf(params.mythLevel).begin; };
  startSel.addEventListener('change', () => { setPref('genesisStart', Number(startSel.value)); syncBeginLabel(); });
  const loadBtn = h('button.btn.btn-lg', { type: 'button', id: 'gen-load' }, svgEl(glyph('open', 18)), 'Load a saved world');
  const returnBtn = h('button.btn.btn-lg.btn-quiet', { type: 'button', id: 'gen-return', hidden: true });
  returnBtn.addEventListener('click', () => opts.onReturn?.());
  beginBtn.addEventListener('click', () => { flushPreview.cancel?.(); opts.onBegin({ ...params }, { years: Number(startSel.value) || 0 }); });
  loadBtn.addEventListener('click', () => opts.onLoad?.());
  const beginNote = h('p.gen-note');
  const plateCol = h('div.gen-plate', null,
    plate,
    h('div.plate-caption', null, worldName, plateNo),
    facts, featureLine, mythLine, genWarn,
    startRow,
    h('div.begin-row.is-dock', null, beginBtn, loadBtn, returnBtn),
    beginNote,
  );

  const head = root.querySelector('.genesis-head');
  if (head) controlsCol.prepend(head);
  const kickerEl = head?.querySelector('.genesis-kicker'), subEl = head?.querySelector('.genesis-sub');
  body.appendChild(controlsCol);
  body.appendChild(plateCol);

  // --- behaviour ----------------------------------------------------------------------
  function persist() {
    const keep = { ...params };
    delete keep.seed;
    delete keep.worldName;   // a name belongs to one world, not to every world after it
    setPref('genesisParams', keep);
  }

  function onParam(key, value) {
    params[key] = coerceParam(key, value);
    presetDirty = true;
    refreshPresetMarks();
    refreshGroupCounts();
    persist();
    if (key === 'mythLevel') { refreshAge(); refreshVisible(); drawOverlay(); refreshFacts(lastPreview); return; }
    refreshVisible();
    if (MYTH_KEYS.has(key)) { drawOverlay(); refreshFacts(lastPreview); return; }   // the land is the same; only the myth changes
    if (PARAM_BY_KEY[key]?.group !== 'civ') schedulePreview();
    else refreshFacts(lastPreview);
  }

  function setAge(level) {
    const lv = Math.max(0, Math.min(2, Number(level) || 0));
    if (lv === 1 && !LEGENDARY_READY) return;
    if (Number(params.mythLevel) === lv) return;
    params.mythLevel = lv;
    controls.get('mythLevel')?.set(lv);
    // a preset of another age no longer describes this world
    const p = PRESETS.find((q) => q.id === presetId);
    if (p && presetLevel(p) && presetLevel(p) !== lv) presetDirty = true;
    refreshAge(); refreshVisible(); refreshPresetMarks(); refreshGroupCounts(); persist();
    drawOverlay(); refreshFacts(lastPreview);
  }

  function applyPreset(id) {
    const p = PRESETS.find((q) => q.id === id);
    if (!p) return;
    const keepSeed = params.seed, keepSize = params.worldSize, keepName = params.worldName;
    const prev = params;
    params = { ...defaultParams(), ...p.params, seed: keepSeed, worldSize: keepSize, worldName: keepName };
    // a land preset keeps the age and the myth the viewer already chose
    if (!p.mode) for (const k of MYTH_KEYS) params[k] = prev[k];
    for (const [k, c] of controls) c.set(params[k]);
    presetId = id; presetDirty = false;
    refreshAge(); refreshVisible(); refreshPresetMarks(); refreshGroupCounts(); persist();
    schedulePreview();
  }

  /** Lay out the presets for the age: its own worlds first, then the lands (which keep the age). */
  function layoutPresets() {
    const lv = Number(params.mythLevel) || 0;
    clear(presetBox);
    const own = PRESETS.filter((p) => p.mode === 'mythic' && presetLevel(p) === lv);
    const lands = PRESETS.filter((p) => !p.mode);
    const others = PRESETS.filter((p) => p.mode === 'mythic' && presetLevel(p) !== lv && (presetLevel(p) !== 1 || LEGENDARY_READY));
    const group = (title, list, cls = '') => {
      if (!list.length) return;
      const box = h('div.presets', { role: 'list', 'aria-label': title });
      for (const p of list) box.appendChild(presetBtns.get(p.id));
      presetBox.appendChild(h('div.gen-pgroup', { class: cls }, h('span.gen-psub', { text: title }), box));
    };
    if (lv === 2) { group('Ages of myth', own, 'is-mythic'); group('Lands', lands); }
    else if (lv === 1) { group('Worlds of legend', own, 'is-legendary'); group('Lands', lands); }
    else { group('Worlds', lands); group('Or a world of legend and myth', others, 'is-mythic is-tease'); }
  }

  function refreshAge() {
    const lv = Number(params.mythLevel) || 0;
    const a = ageOf(lv);
    for (const [k, b] of ageBtns) {
      const on = k === lv;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    root.dataset.myth = String(lv);
    if (kickerEl) kickerEl.textContent = a.kicker;
    if (subEl) subEl.textContent = a.sub;
    plateNo.textContent = lv === 2 ? 'Plate I · Preview · ley lines and likely homelands' : 'Plate I · Preview';
    syncBeginLabel();
    layoutPresets();
  }

  function refreshVisible() {
    for (const [key, c] of controls) {
      const p = PARAM_BY_KEY[key];
      // the age of the world is the cards' to choose (its select stays, hidden, for them to drive)
      const vis = key !== 'mythLevel' && paramVisible(p, params);
      if (c.el.hidden === !vis) continue;
      c.el.hidden = !vis;
    }
    // a group with nothing left to set (Myth & Magic in a Historical world) is not offered at all
    for (const [, meta] of groupMeta) {
      const empty = !meta.list.some((p) => p.key !== 'mythLevel' && paramVisible(p, params));
      if (meta.det.hidden !== empty) meta.det.hidden = empty;
    }
  }

  function refreshPresetMarks() {
    for (const [id, b] of presetBtns) {
      const on = id === presetId;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      const pn = b.querySelector('.pn');
      const label = PRESETS.find((q) => q.id === id).label;
      pn.textContent = on && presetDirty ? `${label}, adjusted` : label;
    }
  }

  function refreshGroupCounts() {
    const d = defaultParams();
    for (const [, meta] of groupMeta) {
      const n = meta.list.filter((p) => paramVisible(p, params) && String(params[p.key]) !== String(d[p.key])).length;
      meta.modified.textContent = n ? `${n} changed` : '';
    }
  }

  seedInput.addEventListener('input', () => { params.seed = seedInput.value.trim() || 'atlas'; schedulePreview(); });
  // a new seed is surveyed at once (calling the debounced function only queued it, with no busy mark)
  reroll.addEventListener('click', () => { params.seed = randomSeed(); seedInput.value = params.seed; flushPreview.flush(); });
  nameInput.addEventListener('input', () => {
    params.worldName = coerceParam('worldName', nameInput.value);
    persist();
    worldName.textContent = params.worldName || genName || '';
    worldName.classList.toggle('is-chosen', Boolean(params.worldName));
  });
  sizeSel.addEventListener('change', () => { params.worldSize = coerceParam('worldSize', sizeSel.value); persist(); refreshFacts(lastPreview); });

  let lastPreview = null, lastMyth = null, lastMythKey = null;
  let genName = '';
  let previewSeq = 0;

  /** Back the preview canvas at its displayed size × device pixel ratio, so the plate is sharp. */
  function fitPreviewCanvas() {
    const cssW = canvas.clientWidth;
    if (!(cssW > 0)) return false;
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const wpx = Math.min(2048, Math.round(cssW * dpr));
    const hpx = Math.round(wpx * 5 / 8);
    if (canvas.width === wpx && canvas.height === hpx) return false;
    canvas.width = wpx; canvas.height = hpx;
    return true;
  }
  // redraw the last surveyed world when the plate changes size (window resize, rotation)
  const redrawPreview = debounce(() => {
    if (!lastPreview || root.hidden) return;
    if (fitPreviewCanvas()) { try { opts.renderPreview(lastPreview, canvas); drawOverlay(false); } catch (e) { app.reportError('genesis.preview', e); } }
  }, 120);
  try { new ResizeObserver(() => redrawPreview()).observe(canvas); } catch (e) { /* no observer: the plate keeps its first size */ }
  const flushPreview = debounce(() => runPreview(), 250);
  function schedulePreview() { busy.hidden = false; flushPreview(); }

  async function runPreview() {
    const seq = ++previewSeq;
    busy.hidden = false;
    await nextFrame();
    if (seq !== previewSeq) return;
    let w = null;
    try {
      // the generated name is drawn whatever the chosen one, so the field can offer it
      w = createWorld({ ...params, worldName: '', worldSize: 'preview' });
      const t0 = performance.now();
      opts.generate(w, { preview: true });
      w.cache.previewMs = performance.now() - t0;
      fitPreviewCanvas();
      opts.renderPreview(w, canvas);
      genWarn.hidden = opts.genAvailable;
      if (!opts.genAvailable) genWarn.textContent = 'The world generator did not load, so this plate uses a simplified stand-in. Begin still works, with plainer terrain.';
    } catch (e) {
      app.reportError('genesis.preview', e);
      genWarn.hidden = false;
      genWarn.textContent = `The preview could not be drawn: ${e.message}`;
    }
    if (seq !== previewSeq) return;
    busy.hidden = true;
    lastPreview = w;
    lastMyth = null; lastMythKey = null;
    drawOverlay(false);
    refreshFacts(w);
  }

  /** The myth of the previewed land under the current age and peoples (cached by those). */
  function mythOf(w) {
    if (!w || !mythPrev || Number(params.mythLevel) < 2) return null;
    const key = `${params.raceMix}`;
    if (lastMyth && lastMythKey === key) return lastMyth;
    w.params.mythLevel = 2;
    w.params.raceMix = params.raceMix;
    try { lastMyth = mythPrev.mythPreview(w); } catch (e) { app.reportError('genesis.mythPreview', e); lastMyth = null; }
    lastMythKey = key;
    return lastMyth;
  }

  /** Paint ley lines, places of power and likely homelands over the plate (Mythic only). */
  function drawOverlay(repaint = true) {
    const w = lastPreview;
    if (!w) return;
    const mythic = Number(params.mythLevel) >= 2;
    // leaving the Mythic age: repaint the clean plate
    if (repaint && (!mythic || plate.dataset.overlay === '1')) {
      try { opts.renderPreview(w, canvas); } catch (e) { app.reportError('genesis.preview', e); }
    }
    plate.dataset.overlay = '0';
    const m = mythic ? mythOf(w) : null;
    mythLine.hidden = !m;
    if (!m) return;
    const ctx = canvas.getContext('2d');
    const cw = canvas.width, ch = canvas.height;
    const sc = Math.min(cw / w.W, ch / w.H);
    const ox = (cw - w.W * sc) / 2, oy = (ch - w.H * sc) / 2;
    const k = Math.max(0.72, Math.min(2.5, sc / 6));
    ctx.save();
    ctx.setTransform(sc, 0, 0, sc, ox + 0.5 * sc, oy + 0.5 * sc);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const path = new Path2D();
    for (const e of m.edges) {
      const p = e.pts;
      path.moveTo(p[0], p[1]);
      for (let j = 2; j + 1 < p.length; j += 2) path.lineTo(p[j], p[j + 1]);
    }
    ctx.strokeStyle = 'rgba(176,140,255,0.28)'; ctx.lineWidth = 3.4 * k / sc; ctx.stroke(path);
    ctx.strokeStyle = 'rgba(214,190,255,0.85)'; ctx.lineWidth = 1.1 * k / sc;
    ctx.setLineDash([3 * k / sc, 2.2 * k / sc]); ctx.stroke(path); ctx.setLineDash([]);
    ctx.restore();
    ctx.save();
    const toPx = (x, y) => [ox + (x + 0.5) * sc, oy + (y + 0.5) * sc];
    for (const n of m.nodes) {
      const [px, py] = toPx(n.x, n.y);
      const r = (2.6 + 1.8 * n.power) * k;
      const g = ctx.createRadialGradient(px, py, 0, px, py, r * 2.6);
      g.addColorStop(0, 'rgba(236,222,255,0.95)'); g.addColorStop(0.35, 'rgba(176,140,255,0.55)'); g.addColorStop(1, 'rgba(176,140,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, r * 2.6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(250,246,255,0.95)'; ctx.beginPath(); ctx.arc(px, py, r * 0.55, 0, Math.PI * 2); ctx.fill();
    }
    // homelands: the race's symbol on a disc of its colour, with its name
    const fs = Math.max(10, Math.min(16, 9.5 * k));
    ctx.font = `italic ${fs}px "IM Fell English", Georgia, serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const placed = [];
    for (const hl of m.homelands) {
      const meta = RACE_META[hl.race];
      if (!meta) continue;
      const [px, py] = toPx(hl.x, hl.y);
      if (placed.some(([x, y]) => Math.abs(x - px) < 60 * k && Math.abs(y - py) < 24 * k)) continue;
      placed.push([px, py]);
      const r = 8 * k;
      const rc = raceColor(hl.race);
      ctx.fillStyle = `rgba(${rc[0]},${rc[1]},${rc[2]},0.92)`;
      ctx.strokeStyle = 'rgba(22,18,14,0.9)'; ctx.lineWidth = 1.3 * k;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      raceGlyph(ctx, meta.symbol, px, py, r * 0.62, k);
      const label = meta.plural;
      ctx.lineWidth = 3 * k; ctx.strokeStyle = 'rgba(244,236,214,0.85)';
      ctx.strokeText(label, px, py + r + 2 * k);
      ctx.fillStyle = 'rgb(40,30,22)';
      ctx.fillText(label, px, py + r + 2 * k);
    }
    ctx.restore();
    plate.dataset.overlay = '1';
    const shares = Object.entries(m.shares).sort((a, b) => b[1] - a[1]).map(([r, v]) => `${RACE_META[r].plural} ${pct(v)}`);
    mythLine.textContent = `${m.nodes.length} places of power joined by ${m.edges.length} ley lines. Likely homelands by the lie of the land: ${listing(shares, 6)}.`;
  }

  function refreshFacts(w) {
    clear(facts);
    if (!w) return;
    genName = w.name;
    worldName.textContent = params.worldName || w.name;
    worldName.classList.toggle('is-chosen', Boolean(params.worldName));
    nameInput.placeholder = w.name ? `${w.name} (its own name)` : 'Named in its own first tongue';
    const f = w.f;
    let land = 0, peak = -Infinity, tSum = 0;
    for (let i = 0; i < w.N; i++) {
      if (f.water[i] === WATER.LAND) {
        land++; tSum += f.annTemp[i];
        if (f.elevation[i] > peak) peak = f.elevation[i];
      }
    }
    let peakM = 0;
    if (land) { for (let i = 0; i < w.N; i++) if (f.water[i] === WATER.LAND && f.elevation[i] === peak) { peakM = elevationMeters(w, i); break; } }
    // count landmasses holding ≥ 2% of the land (the generator's rule for naming a continent)
    const sizes = new Map();
    for (let i = 0; i < w.N; i++) { const m = f.landmass[i]; if (m >= 0) sizes.set(m, (sizes.get(m) || 0) + 1); }
    let continents = 0;
    for (const n of sizes.values()) if (n >= land * 0.02) continents++;
    if (!continents) continents = w.features.filter((q) => q.kind === 'continent').length;
    const size = MAP_SIZES[params.worldSize] || MAP_SIZES.medium;
    const myth = Number(params.mythLevel) >= 2 ? mythOf(w) : null;
    const items = [
      ['Land', pct(land / Math.max(1, w.N))],
      ['Continents', continents ? String(continents) : '—'],
      ['Highest peak', land ? int(peakM) + ' m' : '—'],
      ['Mean land temp', land ? (tSum / land).toFixed(1).replace('-', '−') + ' °C' : '—'],
      ['Volcanoes', String(w.volcanoes.length)],
      ['First tribes', String(params.civCount)],
      ...(myth ? [['Places of power', String(myth.nodes.length)]] : []),
      ['Map', `${size.w}×${size.h}`],
    ];
    for (const [k, v] of items) facts.appendChild(h('span', null, k + ' ', h('b', { text: v })));
    const named = w.features.slice().sort((a, b) => (b.size || 0) - (a.size || 0)).slice(0, 5).map((q) => q.name);
    featureLine.textContent = named.length ? `Charted: ${listing(named, 5)}.` : '';
    const ms = w.cache.previewMs;
    beginNote.textContent = Number.isFinite(ms) ? `Preview surveyed in ${Math.round(ms)} ms at ${w.W}×${w.H}. The full world is generated at ${size.w}×${size.h} when you begin.` : '';
  }

  refreshAge();
  refreshVisible();
  refreshPresetMarks();
  refreshGroupCounts();
  runPreview();

  return {
    show({ canReturn = false } = {}) {
      root.hidden = false;
      returnBtn.hidden = !canReturn || !app.world;
      if (app.world) { clear(returnBtn); returnBtn.append(svgEl(glyph('back', 18)), `Return to ${app.world.name}`); }
      root.scrollTop = 0;
      document.getElementById('app').dataset.mode = 'genesis';
      runPreview();
      setTimeout(() => beginBtn.focus({ preventScroll: true }), 50);
    },
    hide() { root.hidden = true; },
    get params() { return { ...params }; },
    setBusy(b) { beginBtn.disabled = b; loadBtn.disabled = b; },
  };
}

/** The small race symbols of RACE_META (round, leaf, diamond, spike, mound, scale) in ink. */
function raceGlyph(ctx, kind, x, y, s, k) {
  ctx.save();
  ctx.fillStyle = 'rgba(24,18,12,0.88)';
  ctx.strokeStyle = 'rgba(24,18,12,0.88)';
  ctx.lineWidth = 1 * k;
  ctx.beginPath();
  switch (kind) {
    case 'leaf': ctx.ellipse(x, y, s * 0.42, s * 0.85, Math.PI / 4, 0, Math.PI * 2); ctx.fill(); break;
    case 'diamond': ctx.moveTo(x, y - s * 0.85); ctx.lineTo(x + s * 0.6, y); ctx.lineTo(x, y + s * 0.85); ctx.lineTo(x - s * 0.6, y); ctx.closePath(); ctx.fill(); break;
    case 'spike': ctx.moveTo(x, y - s * 0.9); ctx.lineTo(x + s * 0.72, y + s * 0.62); ctx.lineTo(x - s * 0.72, y + s * 0.62); ctx.closePath(); ctx.fill(); break;
    case 'mound': ctx.moveTo(x - s * 0.85, y + s * 0.45); ctx.quadraticCurveTo(x, y - s * 1.0, x + s * 0.85, y + s * 0.45); ctx.closePath(); ctx.fill(); break;
    case 'scale': ctx.moveTo(x - s * 0.72, y - s * 0.32); ctx.quadraticCurveTo(x, y + s * 1.1, x + s * 0.72, y - s * 0.32); ctx.quadraticCurveTo(x, y + s * 0.1, x - s * 0.72, y - s * 0.32); ctx.closePath(); ctx.fill(); break;
    default: ctx.arc(x, y, s * 0.5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}
