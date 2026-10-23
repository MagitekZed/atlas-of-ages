// Registry of simulation system modules. Each module exports `system` (see core/sim.js)
// and may register god tools / hooks / ext providers at import time. Paths are relative to
// this file. Loaders use literal import() paths so a bundler can follow them
// (tools/build-standalone.mjs). Listed in system order (SPEC §6); the Simulation sorts by
// `order` anyway: terraform 5, climate 10, weather 15, ecology 20, disasters 25, civ 40,
// religion 50, disease 55, trade 60, diplomacy 70, war 80, bands 82, events 84, myth 86,
// stats 100.

const LOADERS = {
  './gen/terraform.js': () => import('./gen/terraform.js'),
  './sim/climate.js': () => import('./sim/climate.js'),
  './sim/weather.js': () => import('./sim/weather.js'),
  './sim/ecology.js': () => import('./sim/ecology.js'),
  './sim/disasters.js': () => import('./sim/disasters.js'),
  './sim/civ/index.js': () => import('./sim/civ/index.js'),
  './sim/geo/religion.js': () => import('./sim/geo/religion.js'),
  './sim/geo/disease.js': () => import('./sim/geo/disease.js'),
  './sim/geo/trade.js': () => import('./sim/geo/trade.js'),
  './sim/geo/diplomacy.js': () => import('./sim/geo/diplomacy.js'),
  './sim/geo/war.js': () => import('./sim/geo/war.js'),
  './sim/bands/index.js': () => import('./sim/bands/index.js'),
  './sim/events/index.js': () => import('./sim/events/index.js'),
  './sim/myth/index.js': () => import('./sim/myth/index.js'),
  './sim/stats.js': () => import('./sim/stats.js'),
};

export const SYSTEM_MODULES = Object.keys(LOADERS);

/**
 * Import every system module. Missing or broken modules are reported through onError
 * and skipped, so one failure never stops the world.
 * only: optional array of path fragments to restrict loading (headless testing).
 * exclude: optional array of path fragments never to load (e.g. ['myth'] for the
 *          determinism check: the module is not even imported, so its providers are absent).
 */
export async function loadSystems({ onError = null, only = null, exclude = null } = {}) {
  const out = [];
  for (const p of SYSTEM_MODULES) {
    if (only && !only.some((frag) => p.includes(frag))) continue;
    if (exclude && exclude.some((frag) => p.includes(frag))) continue;
    try {
      const m = await LOADERS[p]();
      if (m.system) out.push(m.system);
      else onError?.(p, new Error('module has no `system` export'));
    } catch (e) {
      onError?.(p, e);
    }
  }
  return out;
}
