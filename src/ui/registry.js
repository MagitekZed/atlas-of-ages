// UI registries (docs/design/expansion-contracts.md §15): the extension points through which other
// packages add to the instrument without editing the built-in UI files.
//
//   registerView(kind, def)            an Inspector record for a new selection kind
//   registerSection(kind | '*', def)   an extra section in an Inspector record
//   registerTitleAction(kind | '*', def) an extra button in a record's title bar
//   registerTab(def)                   a side-panel tab (app.TABS follows)
//   registerKey(def)                   a keyboard shortcut, consulted after the built-ins
//   registerCommand(def)               an action for the command palette (and the menu)
//   registerSearchSource(def)          results for the command palette's search
//   registerContextProvider(fn)        items for the map's context menu
//   registerToastFilter(fn)            suppress or gild chronicle toasts
//   registerUntilCondition(def)        a "run until…" condition
//   registerDirectorSource(fn)         shot candidates for the Director
//   registerOverlay(def)               a map overlay toggle (listed in the map dock)
//   registerIcon(key, svgInner)        a glyph for icons.js
//
// Each register* call returns a function that undoes it. Registering the same id again
// replaces the old entry (hot reload). Registration may happen at module load or later:
// consumers read the registries at the moment of use, and onRegistryChange(fn) tells them
// when something changed. This module is plain data with no imports, so any UI module (and
// any package's module) can import it without cycles. Defs are trusted code from the
// project's own packages; svgInner is hand-written markup, never user text.

const listeners = [];
let version = 0;

function changed(kind) {
  version++;
  for (const fn of listeners.slice()) {
    try { fn(kind); } catch (e) { console.error('[registry]', e); }
  }
}

/** Subscribe to registry changes: fn(kind), kind ∈ view section titleAction tab key command search context toast until director overlay icon. Returns an unsubscribe function. */
export function onRegistryChange(fn) {
  listeners.push(fn);
  return () => { const k = listeners.indexOf(fn); if (k >= 0) listeners.splice(k, 1); };
}

/** Bumped by every registration and removal. */
export const registryVersion = () => version;

const warn = (msg) => console.warn('[registry] ' + msg);
const isFn = (f) => typeof f === 'function';
const byOrder = (a, b) => (a.order ?? 50) - (b.order ?? 50) || String(a.id).localeCompare(String(b.id));

/** A keyed store whose removal callback only removes the exact entry it registered. */
function keyedStore(kind) {
  const map = new Map();
  return {
    map,
    put(key, def) {
      map.set(key, def);
      changed(kind);
      return () => { if (map.get(key) === def) { map.delete(key); changed(kind); } };
    },
  };
}

/** A list of bare functions (providers, filters, sources): the same function is never added twice. */
function fnStore(kind) {
  const list = [];
  return {
    list,
    add(fn) {
      if (!isFn(fn)) { warn(`${kind}: a function is required`); return () => {}; }
      if (!list.includes(fn)) { list.push(fn); changed(kind); }
      return () => { const k = list.indexOf(fn); if (k >= 0) { list.splice(k, 1); changed(kind); } };
    },
  };
}

// ---------------------------------------------------------------------------
// Inspector: views, sections, title actions

/** Selection kinds the Inspector draws itself; registered views are consulted for every other kind. */
export const BUILTIN_VIEW_KINDS = Object.freeze(['tile', 'settlement', 'civ', 'army', 'war', 'religion', 'plague', 'storm', 'volcano']);

const views = keyedStore('view');

/**
 * registerView(kind, { label, icon, mount(app, sel, el) → { update?, destroy? },
 *   describe?(app, sel) → { name, sub, color }, point?(world, id) → { x, y },
 *   frame?(world, id) → { x0, y0, x1, y1 }, rendererSel?(world, id) → renderer selection })
 * The Inspector draws the title bar (from describe, else label) and the standard actions;
 * mount fills `el` below it and update() runs at the panel's refresh rate (≤ 4 Hz).
 * point/frame let app.selectionPoint, follow and framing reach the kind; rendererSel is
 * what renderer.setSelection receives (default: a tile highlight at point()).
 */
export function registerView(kind, def) {
  if (typeof kind !== 'string' || !kind || !def || !isFn(def.mount)) { warn('registerView(kind, { mount }) requires a kind and mount()'); return () => {}; }
  if (BUILTIN_VIEW_KINDS.includes(kind)) warn(`registerView: “${kind}” is drawn by the Inspector itself; the registered view is only used for other kinds`);
  return views.put(kind, { label: kind, icon: kind, ...def, kind });
}
export const getView = (kind) => views.map.get(kind) || null;
export const listViews = () => [...views.map.values()];

const sections = keyedStore('section');

/**
 * registerSection(kind | '*', { id, order?, when?(app, sel) → bool, after?, mount(app, sel, el) → { update? } })
 * An extra section appended to the records of `kind` ('*' = every record), in order; with
 * `after: anchor` it is placed right after the record's block of that anchor instead (the
 * settlement and civ records mark 'summary', the figures under the lead, and civ 'people').
 */
export function registerSection(kind, def) {
  if (typeof kind !== 'string' || !kind || !def || !def.id || !isFn(def.mount)) { warn('registerSection(kind, { id, mount }) requires a kind, an id and mount()'); return () => {}; }
  return sections.put(`${kind}\u0000${def.id}`, { order: 50, ...def, kind });
}
/** Sections for a record kind: its own and the '*' ones, sorted by order. */
export function sectionsFor(kind) {
  const out = [];
  for (const s of sections.map.values()) if (s.kind === kind || s.kind === '*') out.push(s);
  return out.sort(byOrder);
}

const titleActions = keyedStore('titleAction');

/**
 * registerTitleAction(kind | '*', { id, icon, label, run(app, sel, button), pressed?(app, sel) → bool, when?(app, sel) → bool, order? })
 * An extra icon button in a record's title bar, before the Clear button.
 */
export function registerTitleAction(kind, def) {
  if (typeof kind !== 'string' || !kind || !def || !def.id || !isFn(def.run)) { warn('registerTitleAction(kind, { id, run }) requires a kind, an id and run()'); return () => {}; }
  return titleActions.put(`${kind}\u0000${def.id}`, { order: 50, icon: def.id, label: def.id, ...def, kind });
}
export function titleActionsFor(kind) {
  const out = [];
  for (const a of titleActions.map.values()) if (a.kind === kind || a.kind === '*') out.push(a);
  return out.sort(byOrder);
}

// ---------------------------------------------------------------------------
// Side-panel tabs

/** The built-in tabs, their rail order and their keys. Registered tabs slot in by order (10 = before Inspector … 70 = after Atlas). */
export const BUILTIN_TABS = Object.freeze([
  { id: 'inspector', order: 10, key: 'I' }, { id: 'chronicle', order: 20, key: 'C' }, { id: 'nations', order: 30, key: 'N' },
  { id: 'statistics', order: 40, key: 'T' }, { id: 'world', order: 50, key: 'P' }, { id: 'atlas', order: 60, key: 'L' },
]);

const tabs = keyedStore('tab');

/**
 * registerTab({ id, label, key?, icon?, desc?, order?, when?(app) → bool, mount(app, el) → { update?, show?, hide? } })
 * A tab on the side panel's rail. mount runs once when the panel adds the tab; show() when it
 * becomes the active tab, update() at ≤ 4 Hz while it is visible, hide() when another tab
 * takes its place. key is a single letter that opens it (see RESERVED_KEYS).
 */
export function registerTab(def) {
  if (!def || !def.id || !isFn(def.mount)) { warn('registerTab({ id, mount }) requires an id and mount()'); return () => {}; }
  if (BUILTIN_TABS.some((t) => t.id === def.id)) { warn(`registerTab: “${def.id}” is a built-in tab`); return () => {}; }
  if (def.key && builtinKeyClash({ key: def.key })) { warn(`registerTab: key “${def.key}” is taken by a built-in shortcut`); def = { ...def, key: null }; }
  return tabs.put(def.id, { order: 70, label: def.id, icon: def.id, desc: '', ...def });
}
/** Registered tabs, in rail order. */
export const getTabs = () => [...tabs.map.values()].sort(byOrder);
export const getTab = (id) => tabs.map.get(id) || null;

// ---------------------------------------------------------------------------
// Keys

/**
 * Keys set aside for the expansion packages (contracts §15). Packages register them with
 * registerKey (or registerTab's key). No registration may take a built-in key.
 */
export const RESERVED_KEYS = Object.freeze([
  { keys: 'G', owner: 'WP8', use: 'Director' },
  { keys: 'U, Shift U', owner: 'WP8', use: 'Run until (Shift repeats the last condition)' },
  { keys: '/, Ctrl/Cmd K', owner: 'WP8', use: 'Command palette' },
  { keys: '.', owner: 'WP8', use: 'Watch' },
  { keys: 'B, Shift 1–9', owner: 'WP8', use: 'Pin the view; jump to a pin' },
  { keys: 'Y', owner: 'WP8', use: 'Timeline' },
  { keys: 'Z', owner: 'WP8', use: 'Frame the selection' },
  { keys: 'Ctrl/Cmd Z, Ctrl/Cmd Shift Z', owner: 'WP8', use: 'Undo and redo' },
  { keys: 'Q, E', owner: 'WP8', use: 'Previous and next tool' },
  { keys: 'R', owner: 'WP6', use: 'Annals tab' },
  { keys: 'O', owner: 'WP5', use: 'Legends tab' },
]);

// The shortcuts src/ui/input.js handles itself (letters are matched with or without Shift).
const BUILTIN_CHARS = new Set([' ', '0', '1', '2', '3', '4', '5', '6', 'w', 'a', 's', 'd', '+', '=', '-', '_', 'm', 'h', 'f', '[', ']', '?', 'j', '\\', 'i', 'c', 'n', 't', 'p', 'l']);
const BUILTIN_NAMED = new Set(['escape', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
const BUILTIN_MOD = new Set(['s']);   // Ctrl/Cmd S: quick save

/** The character a code produces without Shift (KeyM → m, Digit1 → 1), or null. */
function codeChar(code) {
  const m = /^Key([A-Z])$/.exec(code || '') || /^(?:Digit|Numpad)([0-9])$/.exec(code || '');
  return m ? m[1].toLowerCase() : code === 'Space' ? ' ' : code === 'Slash' ? '/' : code === 'Period' ? '.' : null;
}

function builtinKeyClash({ key, code, shift, mod }) {
  const k = key != null ? String(key) : null;
  if (k && k.length > 1) return !mod && BUILTIN_NAMED.has(k.toLowerCase());
  const ch = k ? k.toLowerCase() : codeChar(code);
  if (!ch) return false;
  if (mod) return BUILTIN_MOD.has(ch);
  // with Shift a digit key types a symbol (Shift 1 → !), which no built-in uses
  if (shift && /[0-9]/.test(ch)) return false;
  return BUILTIN_CHARS.has(ch);
}

const keys = keyedStore('key');
const comboOf = (d) => `${d.code ? 'code:' + d.code : 'key:' + String(d.key).toLowerCase()}|${d.shift ? 1 : 0}|${d.mod ? 1 : 0}`;

/**
 * registerKey({ key? | code?, shift?, mod?, label, group?, when?(app, e) → bool, run(app, e) })
 * key matches KeyboardEvent.key (letters case-insensitively), code matches .code exactly.
 * shift: true needs Shift held; otherwise a letter or code key must be pressed without it.
 * mod: true needs Ctrl or Cmd. Alt combinations are never matched. Built-in keys are
 * refused; the same combination registered twice replaces the first (with a warning).
 */
export function registerKey(def) {
  if (!def || (def.key == null && !def.code) || !isFn(def.run)) { warn('registerKey({ key | code, run }) requires a key or code and run()'); return () => {}; }
  if (builtinKeyClash(def)) { warn(`registerKey: ${describeKey(def)} is a built-in shortcut`); return () => {}; }
  const combo = comboOf(def);
  const prev = keys.map.get(combo);
  if (prev && prev.label !== def.label) warn(`registerKey: ${describeKey(def)} (“${prev.label}”) is replaced by “${def.label}”`);
  return keys.put(combo, { group: 'More', label: describeKey(def), ...def });
}

/** Registered keys, for the help sheet. */
export const listKeys = () => [...keys.map.values()];

/** The registered key a keydown event triggers (or null). Respects when(app, e). */
export function matchKey(app, e) {
  if (!keys.map.size || e.altKey) return null;
  const mod = Boolean(e.ctrlKey || e.metaKey);
  const k = e.key || '';
  const letterLike = k.length === 1 && /[a-z]/i.test(k);
  for (const d of keys.map.values()) {
    if (Boolean(d.mod) !== mod) continue;
    if (d.code) { if (d.code !== e.code) continue; if (Boolean(d.shift) !== Boolean(e.shiftKey)) continue; }
    else {
      if (String(d.key).toLowerCase() !== k.toLowerCase()) continue;
      if (d.shift ? !e.shiftKey : (letterLike && e.shiftKey)) continue;
    }
    if (isFn(d.when)) { let ok = false; try { ok = d.when(app, e); } catch (err) { ok = false; } if (!ok) continue; }
    return d;
  }
  return null;
}

/** "Shift U", "Ctrl K", "." — a key combination as the help sheet prints it. */
export function describeKey(d) {
  if (!d) return '';
  let base = d.code ? (codeChar(d.code) || d.code).toUpperCase() : String(d.key);
  if (base.length === 1) base = base.toUpperCase();
  if (base === ' ') base = 'Space';
  return [d.mod ? 'Ctrl' : '', d.shift ? 'Shift' : '', base].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Commands and search

const commands = keyedStore('command');

/**
 * registerCommand({ id, label, group?, keywords?: [string], keys?: string, icon?, when?(app) → bool,
 *   run(app, arg), menu?: true | string })
 * keys is the shortcut shown beside it (display only; bind it with registerKey). menu lists
 * the command in the HUD menu (a string names its heading).
 */
export function registerCommand(def) {
  if (!def || !def.id || !isFn(def.run)) { warn('registerCommand({ id, run }) requires an id and run()'); return () => {}; }
  return commands.put(def.id, { label: def.id, group: 'Commands', ...def });
}
/** Registered commands; with app, only those whose when(app) holds. */
export function getCommands(app = null) {
  const out = [];
  for (const c of commands.map.values()) {
    if (app && isFn(c.when)) { let ok = false; try { ok = c.when(app); } catch (e) { ok = false; } if (!ok) continue; }
    out.push(c);
  }
  return out;
}
export const getCommand = (id) => commands.map.get(id) || null;
/** Run a registered command by id. Returns true when it ran. */
export function runCommand(app, id, arg) {
  const c = commands.map.get(id);
  if (!c) return false;
  try { c.run(app, arg); } catch (e) { app?.reportError?.(`command:${id}`, e); }
  return true;
}

const searchSources = keyedStore('search');

/** registerSearchSource({ id, label, search(app, q, limit) → [{ kind, id, label, sub, icon, color?, score, run? }] }) */
export function registerSearchSource(def) {
  if (!def || !def.id || !isFn(def.search)) { warn('registerSearchSource({ id, search }) requires an id and search()'); return () => {}; }
  return searchSources.put(def.id, { label: def.id, ...def });
}
export const getSearchSources = () => [...searchSources.map.values()];
/** Ask every source; results tagged with their source id, best score first. */
export function searchAll(app, q, limit = 20) {
  const out = [];
  for (const s of searchSources.map.values()) {
    let r = null;
    try { r = s.search(app, q, limit); } catch (e) { app?.reportError?.(`search:${s.id}`, e); }
    if (Array.isArray(r)) for (const it of r) if (it) out.push({ ...it, source: s.id });
  }
  return out.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Map context menu, toasts, run-until, Director

const contextProviders = fnStore('context');

/** registerContextProvider(fn(app, { tile, picks, sx, sy }) → [{ label, icon?, run }]) */
export const registerContextProvider = (fn) => contextProviders.add(fn);
export const getContextProviders = () => contextProviders.list.slice();
/** Every provider's items for a map spot (providers that throw are skipped). */
export function contextItems(app, ctx) {
  const out = [];
  for (const fn of contextProviders.list) {
    let r = null;
    try { r = fn(app, ctx); } catch (e) { app?.reportError?.('contextProvider', e); }
    if (Array.isArray(r)) for (const it of r) if (it && it.label && isFn(it.run)) out.push(it);
  }
  return out;
}

const toastFilters = fnStore('toast');

/** registerToastFilter(fn(app, entry) → null | { suppress: true } | { watched: true }) */
export const registerToastFilter = (fn) => toastFilters.add(fn);
export const getToastFilters = () => toastFilters.list.slice();
/**
 * The combined verdict for one chronicle entry: suppress wins over watched; null when no
 * filter has an opinion (or none is registered).
 */
export function toastVerdict(app, entry) {
  if (!toastFilters.list.length) return null;
  let watched = false;
  for (const fn of toastFilters.list) {
    let r = null;
    try { r = fn(app, entry); } catch (e) { app?.reportError?.('toastFilter', e); }
    if (r && r.suppress) return { suppress: true };
    if (r && r.watched) watched = true;
  }
  return watched ? { watched: true } : null;
}

const untilConditions = keyedStore('until');

/**
 * registerUntilCondition({ id, label, params?, arm(app, args) → state, test(world, state) → { text, x, y, ref? } | null, disarm?(app, state) })
 * test runs once per simulated day during app.fastForward(…, { until }); it must be cheap and read-only.
 */
export function registerUntilCondition(def) {
  if (!def || !def.id || !isFn(def.arm) || !isFn(def.test)) { warn('registerUntilCondition({ id, arm, test }) requires an id, arm() and test()'); return () => {}; }
  return untilConditions.put(def.id, { label: def.id, ...def });
}
export const getUntilConditions = () => [...untilConditions.map.values()];
export const getUntilCondition = (id) => untilConditions.map.get(id) || null;

const directorSources = fnStore('director');

/** registerDirectorSource(fn(app, nowMs) → [{ type, x, y, zoom?, box?, score, caption?, ref? }]) */
export const registerDirectorSource = (fn) => directorSources.add(fn);
export const getDirectorSources = () => directorSources.list.slice();

// ---------------------------------------------------------------------------
// Map overlays and icons

/** Overlay toggles the renderer and the map dock know themselves. */
export const BUILTIN_OVERLAYS = Object.freeze(['borders', 'labels', 'features', 'rivers', 'roads', 'routes', 'units', 'clouds', 'grid']);

const overlays = keyedStore('overlay');

/**
 * registerOverlay({ id, label, desc?, default: bool })
 * A toggle in the map dock's overlay list; the renderer stores it in r.overlays[id] for the
 * package's layer to read. The viewer's choice is remembered; default applies until then.
 */
export function registerOverlay(def) {
  if (!def || !def.id) { warn('registerOverlay({ id }) requires an id'); return () => {}; }
  if (BUILTIN_OVERLAYS.includes(def.id)) { warn(`registerOverlay: “${def.id}” is a built-in overlay`); return () => {}; }
  return overlays.put(def.id, { label: def.id, desc: '', default: false, ...def });
}
export const getOverlays = () => [...overlays.map.values()];

const icons = keyedStore('icon');

/** registerIcon(key, svgInner): inner markup on icons.js's 24-unit grid, drawn in currentColor. Built-in glyphs keep their keys. */
export function registerIcon(key, svgInner) {
  if (typeof key !== 'string' || !key || typeof svgInner !== 'string') { warn('registerIcon(key, svgInner) requires two strings'); return () => {}; }
  return icons.put(key, svgInner);
}
export const getIcon = (key) => icons.map.get(key) ?? null;
export const hasIcons = () => icons.map.size > 0;
