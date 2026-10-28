// Magical sicknesses (chunk 12, docs/design/magical-sicknesses.md) in the Inspector, Mythic worlds
// only: a magical plague's kind, who laid it and the dead it raised (on its record); a town's
// magic drawn against its land, its burnt land and its blighted harvest (in its dossier); a
// realm's Wasting, what its people blame and the truth, and the dread of a grave-caster. Read-only:
// everything comes from sim/myth/sickness.js.

import { h, Binder } from '../dom.js';
import * as F from '../format.js';
import { registerSection } from '../registry.js';
import { kv, civRef } from '../inspector.js';
import { DAYS_PER_YEAR } from '../../core/constants.js';
import { getEffect } from '../../core/effects.js';
import { peopleName } from '../../sim/geo/folk.js';
import { strainOf } from '../../sim/myth/sickness.js';

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const yearOf = (day) => Math.floor(fin(day) / DAYS_PER_YEAR);
const mythic = (w) => fin(w && w.params && w.params.mythLevel) >= 2;
const sick = (w) => (w.sys.myth && w.sys.myth.sick) || null;
const STRAIN_WORD = (v) => (v >= 0.9 ? 'drawn dry' : v >= 0.75 ? 'drawn hard' : v >= 0.5 ? 'overdrawn' : v >= 0.25 ? 'drawn on' : 'at rest');
const WOUND = { curse: 'a necromancer’s curse', beast: 'a wound from a beast of legend', oath: 'an oath broken', desecration: 'a holy place razed', hand: 'the curse of the hand', kinslaying: 'the blood of kin' };
const PATH = { abdicate: 'its ruler means to step down', cure: 'it seeks a cure', endure: 'its ruler will not give up the throne', murder: 'the court plots against its ruler' };

/** The mana cell of town s (as myth/sickness.js keeps its burns). */
function cellOf(w, s) {
  const W2 = w.W >> 1, H2 = w.H >> 1;
  return Math.min(H2 - 1, s.y >> 1) * W2 + Math.min(W2 - 1, s.x >> 1);
}

function townSection(app, sel, el) {
  const w = app.world, s = w.settlements[sel.id];
  if (!s) return null;
  const b = new Binder();
  const blight = () => getEffect(w, { kind: 'settlement', id: s.id }, 'myth.wasting');
  const burnt = () => { const c = cellOf(w, s); return (sick(w)?.burns || []).find((x) => x.c.includes(c)) || null; };
  const mages = () => (s.jobs && s.jobs.length >= 15 ? fin(s.jobs[11]) : 0);
  el.appendChild(h('h4.rule-head', { text: 'Magic and blight' }));
  el.appendChild(kv(b, [
    { k: 'Its magic', v: () => { const g = strainOf(w, s); return `${STRAIN_WORD(g)}: ${F.pct(g)} below what its land would hold${g >= 0.5 ? '; mana-burn may break out among its mages' : ''}`; }, txt: true },
    { k: 'Burnt land', v: () => `burnt by mana-burn; it heals in Year ${yearOf(burnt().u)}`, txt: true, hide: () => !burnt() },
    { k: 'The Wasting', v: () => `its harvests ${F.pct(1 - fin(blight().m.foodYield, 1))} short`, txt: true, hide: () => !blight() },
  ]));
  b.update();
  return { update: () => b.update() };
}

function plagueSection(app, sel, el) {
  const w = app.world, p = w.plagues[sel.id];
  if (!p) return null;
  const b = new Binder();
  const host = () => (p.band != null ? (w.bands || []).find((x) => x && x.id === p.band) || null : null);
  el.appendChild(h('h4.rule-head', { text: 'A magical sickness' }));
  el.appendChild(kv(b, [
    { k: 'Kind', v: () => (p.cause === 'grave' ? 'a grave-plague: its dead do not stay buried' : 'mana-burn: it falls on the magic-touched (elves most; men, halflings and orcs barely), and no custom or quarantine keeps it off'), txt: true },
    { k: 'Laid by', ref: () => civRef(app, p.by), hide: () => !(p.cause === 'grave' && p.by != null && p.by >= 0) },
    { k: 'Laid by', v: () => 'a curse from beyond the world', txt: true, hide: () => !(p.cause === 'grave' && p.by == null) },
    { k: 'Its dead', v: () => { const x = host(); const bd = x && x.data && x.data.bound; return `rose in Year ${yearOf(p.risen)}${x ? (bd && w.civs[bd.c] ? `; bound to ${w.civs[bd.c].name} until Year ${yearOf(bd.u)}` : '; masterless') : '; the host is gone'}`; }, txt: true, hide: () => p.risen == null },
  ]));
  b.update();
  return { update: () => b.update() };
}

function realmSection(app, sel, el) {
  const w = app.world, civ = w.civs[sel.id];
  if (!civ) return null;
  const b = new Binder();
  const x = () => sick(w)?.wast?.[civ.id] || null;
  const dread = () => sick(w)?.dread?.[civ.id];
  const believe = () => {
    const q = x();
    if (q.kn === 2) return 'they know: the land fails with their ruler’s wound';
    const bl = q.bl === 'minority' ? `its ${peopleName(w, q.bk, false)}` : q.bl === 'mages' ? 'its mages' : q.bl === 'neighbour' ? (w.civs[q.bk] ? w.civs[q.bk].name : 'a neighbour') : q.bl === 'gods' ? 'its gods, who have turned away' : 'no one yet';
    return `they blame ${bl}${q.kn === 1 ? '; its ruler knows the truth, and hides it' : ''}`;
  };
  el.appendChild(h('h4.rule-head', { text: 'The Wasting' }));
  el.appendChild(kv(b, [
    { k: 'The wound', v: () => `from ${WOUND[x().c] || 'a curse'}, since Year ${yearOf(x().d)}${x().gone != null ? '; that reign is over' : ''}`, txt: true, hide: () => !x() },
    { k: 'The land', v: () => (x().yrs ? `${x().gone != null ? 'healing; ' : ''}harvests up to ${F.pct(x().lv)} short, out to ${Math.round(x().rad)} tiles from the seat` : 'not yet failing'), txt: true, hide: () => !x() },
    { k: 'Its people', v: believe, txt: true, hide: () => !x() || !x().yrs || x().gone != null },
    { k: 'The truth', v: () => 'the land fails with its ruler’s wound, and will heal when that reign ends or the wound is healed', txt: true, hide: () => !x() || x().kn === 2 || !x().yrs || x().gone != null },
    { k: 'The reckoning', v: () => PATH[x().path], txt: true, hide: () => !x() || !x().path || x().gone != null },
    { k: 'Grave-plague', v: () => `laid one in Year ${yearOf(dread())}; the world dreads it`, txt: true, hide: () => dread() == null || w.time.day - dread() > 100 * DAYS_PER_YEAR },
  ]));
  b.update();
  return { update: () => b.update() };
}

export function mount() {
  registerSection('settlement', { id: 'sickness.town', order: 29, when: (a, sel) => Boolean(mythic(a.world) && a.world.settlements[sel.id]?.alive), mount: townSection });
  registerSection('plague', { id: 'sickness.plague', order: 19, when: (a, sel) => Boolean(a.world && (a.world.plagues[sel.id]?.cause === 'grave' || a.world.plagues[sel.id]?.cause === 'mana')), mount: plagueSection });
  registerSection('civ', { id: 'sickness.realm', order: 32, when: (a, sel) => Boolean(mythic(a.world) && (sick(a.world)?.wast?.[sel.id] || sick(a.world)?.dread?.[sel.id] != null)), mount: realmSection });
}
