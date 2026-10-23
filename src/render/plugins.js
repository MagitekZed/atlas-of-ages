// Render plugins (docs/design/expansion-contracts.md §14): other packages' render modules, which
// register their layers, effect types and map modes (./layers.js) when imported. The
// renderer imports this file once, behind a guard, before it is first used; each plugin is
// imported behind its own guard, so a missing or broken one only loses its own drawing.
//
// Plugins import ./layers.js, ./palette.js, ./glyphs.js and kernel modules as they need,
// but never ./renderer.js (that would be an import cycle through this file). Each import
// is a literal path so the single-file build bundles it. WP7 adds its own new modules here.

const PLUGINS = [
  ['bands', 'WP2', () => import('./bands.js')],
  ['myth', 'WP5', () => import('./myth.js')],
  ['overlays', 'WP6', () => import('./overlays.js')],
  ['pins', 'WP8', () => import('./pins.js')],
];

const status = [];

await Promise.all(PLUGINS.map(async ([id, owner, load]) => {
  try { await load(); status.push({ id, owner, ok: true }); } catch (e) {
    status.push({ id, owner, ok: false, error: String(e?.message || e) });
    console.warn(`[render] plugin ./${id}.js unavailable:`, e);
  }
}));

/** Which plugins loaded: [{ id, owner, ok, error? }]. */
export const pluginStatus = () => status.slice();
