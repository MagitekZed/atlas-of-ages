// Sieges and walls (chunk 6, docs/design/sieges-and-walls.md) in the Inspector: a town's walls
// (a section in its dossier) and the famous sieges remembered on a siege ground (a section on the
// site's record). The siege under way is told by the siege gauge (inspector.js). Read-only:
// everything comes from s.wall, s.buildings.walls and site.data.famous (sim/geo/siege.js).

import { h, Binder } from '../dom.js';
import * as F from '../format.js';
import { registerSection } from '../registry.js';
import { kv, rows } from '../inspector.js';
import { getSite } from '../../core/sites.js';
import { DAYS_PER_YEAR } from '../../core/constants.js';
import { wallName, storeTarget } from '../../sim/geo/siege.js';

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const yearOf = (day) => Math.floor(fin(day) / DAYS_PER_YEAR);
const pct = (v) => `${Math.round(fin(v) * 100)}%`;
const GROUND = [[2, 'on a crag'], [1, 'on a hill'], [16, 'by the sea'], [4, 'on a river'], [8, 'in the marsh']];
const STATE = (c) => (c >= 0.9 ? 'sound' : c >= 0.7 ? 'worn' : c >= 0.4 ? 'battered' : 'breached');
const HOW = { stormed: 'stormed', mined: 'mined and stormed', surrender: 'surrendered', betrayed: 'betrayed', gates: 'opened its gates' };

function wallsSection(app, sel, el) {
  const w = app.world, s = w.settlements[sel.id];
  if (!s) return null;
  const b = new Binder();
  const lv = () => fin(s.buildings && s.buildings.walls);
  const W = () => s.wall || {};
  el.appendChild(h('h4.rule-head', { text: 'Walls' }));
  el.appendChild(kv(b, [
    { k: 'Walls', v: () => (lv() ? wallName(w, s) : 'None: an open town'), txt: true },
    { k: 'Condition', v: () => `${STATE(fin(W().c, 1))} (${pct(fin(W().c, 1))})${W().br ? ', a breach not yet mended' : ''}`, m: () => fin(W().c, 1), hide: () => !lv() },
    { k: 'Towers', v: () => (fin(W().tw) ? F.int(W().tw) : 'none'), hide: () => !lv() },
    { k: 'Moat', v: () => (W().mo === 2 ? 'water' : W().mo === 1 ? 'a dug ditch' : 'none'), hide: () => !lv() },
    { k: 'Citadel', v: () => (W().cit ? 'a keep within the walls' : 'none'), txt: true, hide: () => !lv() },
    { k: 'Ground', v: () => GROUND.filter(([bit]) => fin(W().n) & bit).map(([, t]) => t).join(', ') || 'open ground', txt: true, hide: () => !s.wall },
    { k: 'Stores', v: () => { const t = storeTarget(w, s, w.civs[s.civId]); return `${fin(W().st).toFixed(1)} months laid by against a siege${t > fin(W().st) + 0.05 ? ` (up to ${t.toFixed(1)} in war)` : ''}`; }, txt: true, hide: () => !lv() },
    { k: 'Sieges', v: () => { const hst = s.hist || {}; return `${F.int(hst.sieges | 0)}: held ${F.int(hst.held | 0)}, taken ${F.int(hst.conquered | 0)}`; }, txt: true, hide: () => !((s.hist && s.hist.sieges) > 0) },
  ]));
  b.update();
  return { update: () => b.update() };
}

function famousSection(app, sel, el) {
  const w = app.world, site = getSite(w, sel.id);
  const list = () => (site && Array.isArray(site.data?.famous) ? site.data.famous : []);
  const b = new Binder();
  el.appendChild(h('h4.rule-head', { text: 'Famous sieges' }));
  el.appendChild(rows(b, () => list().slice().reverse().map((f, k) => ({
    key: `f${k}:${f[0]}:${f[1]}`, icon: 'walls', label: F.headName(f[0]), n: `Y${yearOf(f[1])} · ${F.span(fin(f[4]) * 1)}`,
    s: f[2] === 'captured' || f[2] === 'razed' ? `fell: ${HOW[f[3]] || 'taken'}${f[2] === 'razed' ? ', and razed' : ''}` : f[2] === 'broken' ? 'relieved' : 'held out',
  })), 'None.', app));
  b.update();
  return { update: () => b.update() };
}

export function mount() {
  registerSection('settlement', { id: 'siege.walls', order: 26, when: (a, sel) => { const s = a.world && a.world.settlements[sel.id]; return Boolean(s && s.alive && (fin(s.buildings?.walls) > 0 || (s.hist && s.hist.sieges > 0))); }, mount: wallsSection });
  registerSection('site', { id: 'siege.famous', order: 20, when: (a, sel) => { const st = a.world && getSite(a.world, sel.id); return Boolean(st && st.kind === 'siege' && Array.isArray(st.data?.famous) && st.data.famous.length); }, mount: famousSection });
}
