// Render registries (docs/design/expansion-contracts.md §14): how other packages draw on the map,
// add effect types and add map modes without editing renderer.js, fx.js or modes.js.
//
//   registerLayer({ id, slot, order?, draw(r, ctx, env) })
//   registerFxType(type, { dur, priority?, cap?, draw(fx, ctx, r, t, now), onStart?(fx, r) })
//   registerMapMode({ id, label, desc, when?(world), profile?, territory?(r), legend?(world) })
//
// Layer slots, in drawing order (the renderer sets the transform before each layer and
// restores the context after it):
//   ground         world transform, inside the world clip, just after the terrain raster
//   overTerritory  world transform, inside the world clip, after the borders
//   underIcons     screen space, after fires, volcanoes and resources, before the region
//                  names and the settlements
//   units          screen space, after caravans and armies
//   overUnits      screen space, after storms (before the effects)
//   labels         push label candidates into env.labels (and blockers into
//                  env.labels.blocks) before the place names are placed; do not draw
//   hud            screen space, after the place names, selection marker and brush
// World transform: entity coordinates, where an integer is a tile's centre; one unit is one
// tile. Screen space: CSS pixels (r.e2s(x, y) maps entity coordinates there).
//
// env = { z, dpr, prof, mode, labels, vb, now, dt, worldT(), screenT(), snapshot }
//   z camera zoom (CSS px per tile) · prof the mode's render profile · mode the map mode id ·
//   vb the visible tile range { x0, y0, x1, y1 } (2-tile margin) · now / dt the frame clock
//   (ms / s) · worldT() and screenT() reset the transform · snapshot the atlas snapshot or null.
// A layer that wants to be clickable pushes { kind, id, x0, y0, x1, y1, pri } (screen CSS
// px) into r.hits; pickEntity and pickAll consult them. Built-in priorities: storm 1,
// settlement 2+, army 4.
//
// Every draw is wrapped: a layer that throws is reported once and switched off after three
// failures in a row. With nothing registered the renderer draws exactly what it drew
// before. No imports, so render plugins (src/render/plugins.js) can load it freely.

export const LAYER_SLOTS = Object.freeze(['ground', 'overTerritory', 'underIcons', 'units', 'overUnits', 'labels', 'hud']);
const WORLD_SLOTS = new Set(['ground', 'overTerritory']);
/** Does this slot draw in the world transform (true) or in screen space (false)? */
export const slotIsWorld = (slot) => WORLD_SLOTS.has(slot);

const listeners = [];
let version = 0;
function changed(kind) {
  version++;
  for (const fn of listeners.slice()) {
    try { fn(kind); } catch (e) { console.error('[render registry]', e); }
  }
}
/** Subscribe to registrations: fn(kind), kind ∈ layer fx mode. Returns an unsubscribe function. */
export function onRenderRegistryChange(fn) {
  listeners.push(fn);
  return () => { const k = listeners.indexOf(fn); if (k >= 0) listeners.splice(k, 1); };
}
export const renderRegistryVersion = () => version;
const warn = (msg) => console.warn('[render registry] ' + msg);

// ---------------------------------------------------------------------------
// Layers

const layers = new Map();     // id → def
const EMPTY = Object.freeze([]);
let bySlot = null;            // slot → sorted defs (rebuilt lazily)

/**
 * registerLayer({ id, slot, order?, draw(r, ctx, env) }) → unregister()
 * Lower order draws first within a slot (default 50; ties by id). Same id replaces.
 */
export function registerLayer(def) {
  if (!def || !def.id || typeof def.draw !== 'function' || !LAYER_SLOTS.includes(def.slot)) {
    warn(`registerLayer({ id, slot, draw }) needs an id, a draw() and a slot from ${LAYER_SLOTS.join(', ')}`);
    return () => {};
  }
  const d = { order: 50, ...def, fails: 0, off: false };
  layers.set(d.id, d);
  bySlot = null;
  changed('layer');
  return () => { if (layers.get(d.id) === d) { layers.delete(d.id); bySlot = null; changed('layer'); } };
}

/** Registered layers of a slot, in drawing order (a shared frozen empty list when none). */
export function layersFor(slot) {
  if (!layers.size) return EMPTY;
  if (!bySlot) {
    bySlot = Object.create(null);
    for (const d of layers.values()) (bySlot[d.slot] ||= []).push(d);
    for (const k of Object.keys(bySlot)) bySlot[k].sort((a, b) => a.order - b.order || String(a.id).localeCompare(String(b.id)));
  }
  return bySlot[slot] || EMPTY;
}
export const hasLayers = () => layers.size > 0;
export const listLayers = () => [...layers.values()].map((d) => ({ id: d.id, slot: d.slot, order: d.order, off: d.off, fails: d.fails }));

/** Draw one registered layer, guarded (the renderer calls this). */
export function drawLayer(d, r, ctx, env) {
  if (d.off) return;
  ctx.save();
  try {
    d.draw(r, ctx, env);
    d.fails = 0;
  } catch (e) {
    d.fails++;
    if (d.fails === 1) console.error(`[layer:${d.id}]`, e);
    if (d.fails >= 3) { d.off = true; console.warn(`[layer:${d.id}] switched off after repeated failures`); }
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Effect types

const fxTypes = new Map();    // type → def

/**
 * registerFxType(type, { dur, priority?, cap?, draw(fx, ctx, r, t, now), onStart?(fx, r) }) → unregister()
 * Consulted by fx.js for types it does not draw itself. dur is the base lifetime in ms;
 * priority (0–10) decides who survives a crowded queue; cap limits how many of the type
 * live at once. draw runs in screen space inside save/restore, with t ∈ [0, 1] the
 * effect's progress; fx carries the emitFx fields (type x y r civId intensity text color
 * x2 y2 tone sign glyph size src) plus t0, dur and seed. onStart runs once on arrival.
 */
export function registerFxType(type, def) {
  if (typeof type !== 'string' || !type || !def || typeof def.draw !== 'function' || !(def.dur > 0)) {
    warn('registerFxType(type, { dur, draw }) needs a type, a positive dur and draw()');
    return () => {};
  }
  const d = { priority: 3, cap: 0, ...def, type, fails: 0 };
  fxTypes.set(type, d);
  changed('fx');
  return () => { if (fxTypes.get(type) === d) { fxTypes.delete(type); changed('fx'); } };
}
export const getFxType = (type) => fxTypes.get(type) || null;
export const listFxTypes = () => [...fxTypes.keys()];

// ---------------------------------------------------------------------------
// Map modes

const modes = new Map();      // id → def

/**
 * registerMapMode({ id, label, desc, when?(world) → bool, profile?, territory?(r) → spec | null, legend?(world) → legend })
 * profile: overrides of the render profile (see modes.js MODE_PROFILE: region, borders,
 *   settle, labelsCiv, detail, shimmer, routesK, clouds, night) plus style, the terrain
 *   raster style (natural, muted, elevation, … as in terrain.js; default muted).
 * territory(r): the territory wash for the mode, { key, catFn(i) → category | -1,
 *   colorFn(category) → [r, g, b, a?], fillA?, glowA?, glowTiles?, coastK? }; key must
 *   change whenever the categories or colours do.
 * legend(world): a getLegend() object ({ title, type: 'gradient' | 'swatches', stops?, items? }).
 * when(world) hides the mode from the pickers while false (for example below mythLevel 2).
 */
export function registerMapMode(def) {
  if (!def || !def.id || typeof def.id !== 'string') { warn('registerMapMode({ id, label }) needs an id'); return () => {}; }
  const d = { label: def.id, desc: '', ...def };
  modes.set(d.id, d);
  changed('mode');
  return () => { if (modes.get(d.id) === d) { modes.delete(d.id); changed('mode'); } };
}
export const getMapMode = (id) => modes.get(id) || null;
export const listMapModes = () => [...modes.values()];
