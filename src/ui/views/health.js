// Health and sickness (chunk 11, docs/design/health-and-sickness.md) in the Inspector: why a town
// is healthy or sick (a section in its dossier), whom a plague took and why (on its record), a
// people's frailty and customs (on its record), a realm's physicians and a faith's teaching on
// sickness, and an army's camp fever. Read-only: everything comes from sim/geo/health.js.

import { h, Binder } from '../dom.js';
import * as F from '../format.js';
import { registerSection } from '../registry.js';
import { kv, rows } from '../inspector.js';
import { DAYS_PER_YEAR } from '../../core/constants.js';
import { peopleName } from '../../sim/geo/folk.js';
import {
  healthParts, sparedWhy, peekRec, frailOf, physicOf, teachingOf, CUSTOMS, TEACH, BUILD_WORD,
} from '../../sim/geo/health.js';

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const yearOf = (day) => Math.floor(fin(day) / DAYS_PER_YEAR);
const cap = (s) => String(s || '').replace(/^./, (c) => c.toUpperCase());
const pts = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v * 100))}`;
const HEALTH_WORD = (v) => (v >= 0.85 ? 'hale' : v >= 0.72 ? 'healthy' : v >= 0.6 ? 'middling' : v >= 0.45 ? 'sickly' : 'pestilent');
const FEVER_WORD = (v) => (v >= 0.6 ? 'deep fever country' : v >= 0.3 ? 'fever country' : v >= 0.1 ? 'touched by fever' : 'healthy ground');

function townSection(app, sel, el) {
  const w = app.world, s = w.settlements[sel.id];
  if (!s) return null;
  const b = new Binder();
  const sk = () => s.sick || {};
  el.appendChild(h('h4.rule-head', { text: 'Health and sickness' }));
  el.appendChild(kv(b, [
    { k: 'Health', v: () => `${HEALTH_WORD(fin(s.health))} (${F.pct(fin(s.health))})`, m: () => fin(s.health) },
    { k: 'Built of', v: () => BUILD_WORD[sk().b] || 'timber', txt: true, hide: () => !sk().b },
    { k: 'Slums', v: () => F.pct(fin(sk().sl)), hide: () => !(fin(sk().sl) >= 0.02) },
    { k: 'Ground', v: () => `${FEVER_WORD(fin(sk().fv))}${fin(sk().fv) >= 0.1 ? `; its people ${fin(sk().sn) >= 0.7 ? 'seasoned to it' : fin(sk().sn) >= 0.3 ? 'half seasoned' : 'newcomers to it'}` : ''}${sk().dd ? '; its marshes drained' : sk().dr != null ? '; its marshes being drained' : ''}`, txt: true, hide: () => !(fin(sk().fv) >= 0.1 || sk().dd) },
    { k: 'Sickness spreads', v: () => `×${fin(sk().im, 1).toFixed(2)} for how it lives`, txt: true, hide: () => Math.abs(fin(sk().im, 1) - 1) < 0.02 },
  ]));
  el.appendChild(h('h4.rule-head', { text: 'Why' }));
  el.appendChild(rows(b, () => healthParts(w, s).slice(0, 7).map((x, k) => ({
    key: `h${k}:${x.k}:${Math.round(x.v * 100)}`, icon: x.v >= 0 ? 'cure' : 'plague', label: x.k, n: pts(x.v),
  })), 'Nothing out of the ordinary.', app));
  b.update();
  return { update: () => b.update() };
}

function plagueSection(app, sel, el) {
  const w = app.world, p = w.plagues[sel.id];
  if (!p) return null;
  const b = new Binder();
  el.appendChild(h('h4.rule-head', { text: 'Whom it took' }));
  el.appendChild(kv(b, [
    { k: 'Its people', v: () => (p.op ? `a sickness of ${peopleName(w, p.op)}` : 'unknown'), txt: true },
    { k: 'Gates shut', v: () => `${F.int((p.qs || []).length)} town${(p.qs || []).length === 1 ? '' : 's'}${(p.qx || []).length ? `, ${F.int(p.qx.length)} reached all the same` : ''}`, txt: true, hide: () => !(p.qs && p.qs.length) },
  ]));
  el.appendChild(rows(b, () => {
    const by = Object.entries(p.byP || {}).filter(([, v]) => v[1] >= 20);
    return by.sort((x, y) => y[1][0] - x[1][0]).slice(0, 6).map(([key, [dead, exp]]) => ({
      key: `p${key}:${Math.round(dead)}`, icon: 'people', label: cap(peopleName(w, key, false)),
      n: `${F.people(dead)} (${F.pct(dead / Math.max(1, exp))})`, s: sparedWhy(w, key, p).join(', '), sel: { kind: 'folk', id: key },
    }));
  }, 'No count by people.', app));
  b.update();
  return { update: () => b.update() };
}

function folkSection(app, sel, el) {
  const w = app.world, key = String(sel.id);
  const b = new Binder();
  const r = () => peekRec(w, key);
  el.appendChild(h('h4.rule-head', { text: 'Sickness' }));
  el.appendChild(kv(b, [
    { k: 'Frailty', v: () => { const f = frailOf(w, key); return `${f <= 0.6 ? 'seldom sicken' : f <= 0.85 ? 'hardy' : f >= 1.25 ? 'sicken readily' : 'as most peoples'} (×${f.toFixed(2)})`; }, txt: true },
    { k: 'Hardiness', v: () => `${F.pct(fin(r() && r().h))} from old plagues and crowded cities`, txt: true, hide: () => !(r() && r().h >= 0.01) },
    { k: 'Custom', v: () => { const c = CUSTOMS[r() ? r().c : 'plain']; return `${c.label}: they ${c.desc}${r() && r().sh != null ? `; their bathhouses shut since Year ${yearOf(r().sh)}` : ''}`; }, txt: true, hide: () => !r() },
    { k: 'Has met the sicknesses of', v: () => { const k = (r() ? r().k : []).filter((x) => x !== key); return k.length ? F.listing(k.slice(-6).reverse().map((x) => peopleName(w, x)), 4) : 'no other people'; }, txt: true, hide: () => !r() },
  ]));
  b.update();
  return { update: () => b.update() };
}

function realmSection(app, sel, el) {
  const w = app.world, civ = w.civs[sel.id];
  if (!civ) return null;
  const b = new Binder();
  el.appendChild(h('h4.rule-head', { text: 'Physicians' }));
  el.appendChild(kv(b, [
    { k: 'Theory', v: () => `${cap(physicOf(w, civ).label)}: that ${physicOf(w, civ).held}`, txt: true },
    { k: 'Its faith', v: () => (civ.stateReligion != null && w.religions[civ.stateReligion] ? `${w.religions[civ.stateReligion].name}: ${TEACH[teachingOf(w, civ.stateReligion)].label}` : 'none of state'), txt: true },
    { k: 'Fever ground', v: () => { let n = 0, d = 0; for (const id of civ.settlementIds || []) { const s = w.settlements[id]; if (s && s.alive && s.sick) { if (fin(s.sick.fv) >= 0.3) n++; if (s.sick.dd) d++; } } return `${F.int(n)} town${n === 1 ? '' : 's'} in fever country${d ? `, ${F.int(d)} drained` : ''}`; }, txt: true, hide: () => !(civ.settlementIds || []).some((id) => fin(w.settlements[id]?.sick?.fv) >= 0.3 || w.settlements[id]?.sick?.dd) },
  ]));
  b.update();
  return { update: () => b.update() };
}

function faithSection(app, sel, el) {
  const w = app.world;
  const b = new Binder();
  el.appendChild(h('h4.rule-head', { text: 'On sickness' }));
  el.appendChild(kv(b, [{ k: 'It teaches', v: () => ({ heal: 'to tend the sick: hospitals and nursing orders', purity: 'rites of washing and fasting', penance: 'that sickness is a punishment for sin', fate: 'nothing of sickness' })[teachingOf(w, sel.id)], txt: true }]));
  b.update();
  return { update: () => b.update() };
}

function armySection(app, sel, el) {
  const w = app.world;
  const a = () => (w.armies || []).find((x) => x && x.id === sel.id) || null;
  const b = new Binder();
  el.appendChild(h('h4.rule-head', { text: 'Camp fever' }));
  el.appendChild(kv(b, [
    { k: 'Now', v: () => { const cf = a()?.flags?.cf; return cf ? `in its camps since ${F.monthYear(cf.d)}; ${F.people(fin(cf.n))} lost` : 'none'; }, txt: true },
    { k: 'Lost to sickness', v: () => F.people(fin(a()?.flags?.loss?.plague)), hide: () => !(fin(a()?.flags?.loss?.plague) >= 1) },
  ]));
  b.update();
  return { update: () => b.update() };
}

function warSection(app, sel, el) {
  const w = app.world, war = w.wars[sel.id];
  if (!war) return null;
  const b = new Binder();
  el.appendChild(h('h4.rule-head', { text: 'Sickness in the camps' }));
  el.appendChild(kv(b, [{ k: 'Dead of fever', v: () => { let f = 0, c = 0; for (const k in war.fever || {}) f += war.fever[k]; for (const k in war.casualties || {}) c += war.casualties[k]; return `${F.people(f)} of ${F.people(c)} lost (${F.pct(f / Math.max(1, c))})`; }, txt: true }]));
  b.update();
  return { update: () => b.update() };
}

export function mount() {
  registerSection('settlement', { id: 'health.town', order: 28, when: (a, sel) => Boolean(a.world && a.world.settlements[sel.id]?.alive), mount: townSection });
  registerSection('plague', { id: 'health.plague', order: 20, when: (a, sel) => Boolean(a.world && a.world.plagues[sel.id] && Object.keys(a.world.plagues[sel.id].byP || {}).length), mount: plagueSection });
  registerSection('folk', { id: 'health.folk', order: 20, when: (a) => Boolean(a.world), mount: folkSection });
  registerSection('civ', { id: 'health.realm', order: 31, when: (a, sel) => Boolean(a.world && a.world.civs[sel.id]?.alive), mount: realmSection });
  registerSection('religion', { id: 'health.faith', order: 20, when: (a, sel) => Boolean(a.world && a.world.religions[sel.id]), mount: faithSection });
  registerSection('army', { id: 'health.army', order: 20, when: (a, sel) => Boolean(a.world && (a.world.armies || []).some((x) => x && x.id === sel.id && (x.flags?.cf || fin(x.flags?.loss?.plague) >= 1))), mount: armySection });
  registerSection('war', { id: 'health.war', order: 20, when: (a, sel) => Boolean(a.world && a.world.wars[sel.id] && Object.keys(a.world.wars[sel.id].fever || {}).length), mount: warSection });
}
