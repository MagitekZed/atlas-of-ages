// Package UI modules (docs/design/expansion-contracts.md §15). Each module below exports
// mount(app) and registers its tabs, views, keys, commands and filters (src/ui/registry.js)
// at import or inside mount. main.js loads them all (in parallel, each behind its own guard,
// before the built-in instruments are mounted, so tabs registered at import are on the
// rail from the start) and calls mountAll(app) once the app is ready, before any world
// begins. A module that fails to load or mount is reported and skipped; the rest carry on.
//
// Every import is a literal path so the single-file build (tools/build-standalone.mjs)
// bundles them; a stub exporting mount() {} exists for each until its package lands.

const MODULES = [
  // WP8 · story, navigation and hands
  ['director', 'WP8', () => import('./director.js')],
  ['until', 'WP8', () => import('./until.js')],
  ['command', 'WP8', () => import('./command.js')],
  ['contextmenu', 'WP8', () => import('./contextmenu.js')],
  ['watch', 'WP8', () => import('./watch.js')],
  ['chrono', 'WP8', () => import('./chrono.js')],
  ['acts', 'WP8', () => import('./acts.js')],
  ['deedcard', 'WP8', () => import('./deedcard.js')],
  ['timeline', 'WP8', () => import('./timeline.js')],
  ['audio', 'WP8', () => import('./audio.js')],
  // WP6 · ledgers, records and the inspector
  ['annals', 'WP6', () => import('./annals.js')],
  ['digest', 'WP6', () => import('./digest.js')],
  ['views/records', 'WP6', () => import('./views/records.js')],
  ['views/knowledge', 'UI', () => import('./views/knowledge.js')],
  // WP2 · roaming powers
  ['views/band', 'WP2', () => import('./views/band.js')],
  // WP5 · mythic
  ['views/myth', 'WP5', () => import('./views/myth.js')],
  ['legends', 'WP5', () => import('./legends.js')],
];

/** The module list: [{ id, owner }] (for the engine room and tests). */
export const MOUNT_MODULES = MODULES.map(([id, owner]) => ({ id, owner }));

let loaded = [];

/**
 * Import every package UI module. onError(path, error) is told about each one that fails.
 * Resolves to [{ id, owner, mod | null, error? }] and never rejects.
 */
export async function loadMounts({ onError = null } = {}) {
  loaded = await Promise.all(MODULES.map(async ([id, owner, load]) => {
    try { return { id, owner, mod: await load(), handle: null, mounted: false }; } catch (e) {
      try { onError?.(`src/ui/${id}.js`, e); } catch (err) { /* reporting must not break loading */ }
      return { id, owner, mod: null, error: e, handle: null, mounted: false };
    }
  }));
  return loaded;
}

/** Call mount(app) on every loaded module, once each. Returns the ids that mounted. */
export function mountAll(app) {
  const ok = [];
  for (const m of loaded) {
    if (m.mounted || typeof m.mod?.mount !== 'function') continue;
    m.mounted = true;
    try { m.handle = m.mod.mount(app) ?? null; ok.push(m.id); } catch (e) { app.reportError(`mount:${m.id}`, e); }
  }
  return ok;
}

/** What loaded and mounted: [{ id, owner, ok, mounted, error }]. */
export const mountStatus = () => loaded.map((m) => ({ id: m.id, owner: m.owner, ok: Boolean(m.mod), mounted: m.mounted, error: m.error ? String(m.error.message || m.error) : null }));
