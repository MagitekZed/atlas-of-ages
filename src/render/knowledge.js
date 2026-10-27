// The Knowledge map mode (chunk 5, docs/design/inventions.md): how far one invention has spread.
// Realms are shaded by when they learned it (darkest first, palest last), the realm that found
// it first in gold, the rest of the world blank. The invention shown is the one the Inspector's
// invention view last asked for (setKnowledgeTech), else the newest invention found in the world.

import { registerMapMode } from './layers.js';
import * as P from './palette.js';
import { DAYS_PER_YEAR } from '../core/constants.js';
import { techDef } from '../sim/civ/tech.js';

let chosen = null;

/** Show invention id on the Knowledge map (ui/views/knowledge.js). */
export function setKnowledgeTech(id) { chosen = typeof id === 'string' && id ? id : null; }

const BUCKETS = 8;
const RAMP = P.makeRamp([[0, [74, 44, 112]], [0.5, [168, 92, 140]], [1, [240, 206, 156]]]);
const FIRST = [244, 196, 92];
const UNKNOWN = [120, 112, 104];

/** The invention the map shows: the chosen one, else the newest first found in the world. */
export function knowledgeTech(world) {
  if (chosen) return chosen;
  const fw = world && world.sys && world.sys.civ && world.sys.civ.firstWhere;
  let best = null, day = -Infinity;
  if (fw) for (const id in fw) if (fw[id] && fw[id][1] > day) { day = fw[id][1]; best = id; }
  return best;
}

const known = (c, id) => (c && c.tech && c.tech.known ? c.tech.known[id] : undefined);

registerMapMode({
  id: 'knowledge', label: 'Knowledge', desc: 'How far an invention has spread: realms shaded by when they learned it, the first in gold.',
  profile: { style: 'muted', region: null, borders: 0.7, settle: 1, labelsCiv: true, detail: 'peaks', routesK: 0.2, clouds: false },
  territory(r) {
    const w = r.world;
    const id = knowledgeTech(w);
    if (!w || !id || !w.f || !w.f.owner) return null;
    const st = w.sys.civ || {};
    let first = st.firstWhere && st.firstWhere[id] ? st.firstWhere[id][1] : Infinity;
    for (const c of w.civs) { const d = known(c, id); if (d != null && d < first) first = d; }
    const span = Math.max(DAYS_PER_YEAR, w.time.day - (Number.isFinite(first) ? first : w.time.day));
    const firstCiv = st.firstTech ? st.firstTech[id] : null;
    const cat = new Int16Array(w.civs.length).fill(-1);
    for (let k = 0; k < w.civs.length; k++) {
      const c = w.civs[k];
      if (!c || !c.alive) continue;
      const d = known(c, id);
      cat[k] = d == null ? BUCKETS : c.id === firstCiv ? BUCKETS + 1 : Math.max(0, Math.min(BUCKETS - 1, Math.floor(((d - first) / span) * BUCKETS)));
    }
    const owner = w.f.owner, v = w.versions || {};
    return {
      key: `${v.owner}|${v.civs}|${id}|${Math.floor(w.time.day / DAYS_PER_YEAR)}`,
      catFn: (i) => { const c = owner[i]; return c >= 0 && c < cat.length ? cat[c] : -1; },
      colorFn: (k) => {
        if (k === BUCKETS) return [UNKNOWN[0], UNKNOWN[1], UNKNOWN[2], 0.3];
        if (k === BUCKETS + 1) return [FIRST[0], FIRST[1], FIRST[2], 0.72];
        const c = P.rampAt(RAMP, k / (BUCKETS - 1));
        return [c[0], c[1], c[2], 0.62];
      },
      fillA: 0.55, glowA: 0.3, glowTiles: 1.2, coastK: 0.35,
    };
  },
  legend(w) {
    const id = knowledgeTech(w);
    const t = id ? techName(w, id) : null;
    return {
      title: t ? `${t}: when each realm learned it` : 'Knowledge', type: 'gradient',
      // the dock shows the mode's own label, so the invention is named on the gradient
      stops: [0, 0.25, 0.5, 0.75, 1].map((x) => [x, P.css(P.rampAt(RAMP, x))]), minLabel: t ? `${t}: early` : 'Early', maxLabel: 'Lately',
      items: [{ label: 'Found it first', color: P.css(FIRST) }, { label: 'Not yet known', color: `rgba(${UNKNOWN.join(',')},0.45)` }],
    };
  },
});

const techName = (world, id) => (techDef(id) ? techDef(id).name : id);
