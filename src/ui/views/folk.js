// Peoples and memory (chunk 8, docs/design/peoples-and-memory.md) in the Inspector: a Historical
// town's peoples (a section in its dossier; Mythic towns show their races as before), a realm's
// peoples and each minority's standing (a section in its dossier), and a people's own record
// ('folk', id 'f:12' or 'r:elf'): where it lives and rules, how it regards the others and they
// it, how realms treat it, its migrations. Read-only: everything comes from sim/geo/folk.js.

import { h, Binder } from '../dom.js';
import * as F from '../format.js';
import { registerView, registerSection } from '../registry.js';
import { kv, rows, shareBars, linkBtn, textNode } from '../inspector.js';
import { DAYS_PER_YEAR, RACE_META } from '../../core/constants.js';
import { townMix, realmMix, peopleName, folkById, feel, folkState, standingOf, civPeople } from '../../sim/geo/folk.js';

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const yearOf = (day) => Math.floor(fin(day) / DAYS_PER_YEAR);
const note = (text) => h('p.empty-note', { text });
const cap = (s) => String(s || '').replace(/^./, (c) => c.toUpperCase());
const mythic = (w) => fin(w && w.params && w.params.mythLevel) >= 2;
const STAND_WORD = { equal: 'equal', tolerated: 'tolerated', taxed: 'taxed', persecuted: 'persecuted', expelled: 'expelled' };
const FEEL_WORD = (v) => (v >= 50 ? 'beloved' : v >= 20 ? 'friendly' : v > -20 ? 'indifferent' : v > -50 ? 'resented' : 'hated');

/** A people's colour: its first realm's, or its race's. */
function colorOf(w, key) {
  if (key && key[0] === 'r') { const c = RACE_META[key.slice(2)]?.color; return c ? `rgb(${c.join(',')})` : '#9a8f80'; }
  const P = folkById(w, +String(key).slice(2));
  return (P && w.civs[P.root]?.colorHex) || '#9a8f80';
}
const share = (mix) => { let t = 0; for (const k in mix) t += mix[k]; return Object.entries(mix).filter(([, v]) => v > 0).map(([k, v]) => [k, v / Math.max(1e-9, t)]).sort((a, b) => b[1] - a[1]); };

function townSection(app, sel, el) {
  const w = app.world, s = w.settlements[sel.id];
  if (!s) return null;
  const b = new Binder();
  el.appendChild(h('h4.rule-head', { text: 'Peoples' }));
  el.appendChild(shareBars(b, () => share(townMix(w, s)).slice(0, 6).map(([k, v]) => ({
    key: k, value: v, label: cap(peopleName(w, k, false)), color: colorOf(w, k), sel: { kind: 'folk', id: k },
    text: `${Math.round(v * 100)}%${k !== civPeople(w, w.civs[s.civId]) && standingOf(w.civs[s.civId], k) !== 'tolerated' ? ' · ' + STAND_WORD[standingOf(w.civs[s.civId], k)] : ''}`,
  })), app));
  b.update();
  return { update: () => b.update() };
}

function realmSection(app, sel, el) {
  const w = app.world, civ = w.civs[sel.id];
  if (!civ) return null;
  const b = new Binder();
  el.appendChild(h('h4.rule-head', { text: 'Its peoples' }));
  el.appendChild(shareBars(b, () => {
    const own = civPeople(w, civ);
    return share(realmMix(w, civ)).slice(0, 6).map(([k, v]) => ({
      key: k, value: v, label: cap(peopleName(w, k, false)), color: colorOf(w, k), sel: { kind: 'folk', id: k },
      text: `${Math.round(v * 100)}%${k === own ? ' · ruling' : ' · ' + STAND_WORD[standingOf(civ, k)]}`,
    }));
  }, app));
  b.update();
  return { update: () => b.update() };
}

// ---------------------------------------------------------------------------
// a people's record

const folkView = {
  label: 'People', icon: 'people',
  describe(app, sel) {
    const w = app.world, key = String(sel.id);
    const P = key[0] === 'f' ? folkById(w, +key.slice(2)) : null;
    return { name: cap(peopleName(w, key, false)), sub: P ? `A people since Y${yearOf(P.born)}${P.gone != null ? ` · gone Y${yearOf(P.gone)}` : ''}` : 'A people of the world', color: colorOf(w, key) };
  },
  point(w, id) { const key = String(id); const P = key[0] === 'f' ? folkById(w, +key.slice(2)) : null; return P ? { x: P.x, y: P.y } : null; },
  mount(app, sel, el) {
    const w = app.world, key = String(sel.id);
    const b = new Binder();
    const P = key[0] === 'f' ? folkById(w, +key.slice(2)) : null;
    if (key[0] === 'f' && !P) { el.appendChild(note('This people has passed out of the record.')); return { update() {} }; }
    const realms = () => w.civs.filter((c) => c && c.alive && civPeople(w, c) === key);
    const numbers = () => { let n = 0, towns = 0; for (const s of w.settlements) { if (!s || !s.alive) continue; const v = fin(townMix(w, s)[key]); if (v >= 0.05) towns++; n += v * fin(s.population); } return [n, towns]; };
    const lead = h('p.ins-lead');
    b.text(lead, () => {
      const [n, towns] = numbers();
      const from = P && P.from != null ? folkById(w, P.from) : null;
      const root = P ? w.civs[P.root] : null;
      return P
        ? `${cap(peopleName(w, key))}${from ? `, of ${from.adj} stock,` : ''} first appear in Year ${yearOf(P.born)}${root ? ` with ${F.theCiv(root)}` : ''}. ${P.gone != null ? `They were gone by Year ${yearOf(P.gone)}, absorbed by their neighbours.` : `Some ${F.people(n)} live in ${F.int(towns)} town${towns === 1 ? '' : 's'}.`}`
        : `${cap(peopleName(w, key))}: some ${F.people(numbers()[0])} live in ${F.int(numbers()[1])} towns of the world.`;
    });
    el.appendChild(lead);
    el.appendChild(h('h4.rule-head', { text: 'Their realms' }));
    el.appendChild(rows(b, () => realms().map((c) => ({ key: `c${c.id}`, swatch: c.colorHex, label: c.name, n: F.people(c.population), sel: { kind: 'civ', id: c.id } })), 'None: they rule no realm.', app));
    // how they regard the others, and how the others regard them
    const others = () => {
      const set = new Set();
      for (const k of Object.keys(folkState(w)?.fe || {})) { const [a, c] = k.split('>'); if (a === key) set.add(c); if (c === key) set.add(a); }
      return [...set];
    };
    el.appendChild(h('h4.rule-head', { text: 'How they regard the others' }));
    el.appendChild(rows(b, () => others().map((o) => [o, feel(w, key, o)]).sort((x, y) => y[1] - x[1]).filter((_, i, a) => i < 4 || i >= a.length - 4).map(([o, v]) => ({
      key: `t${o}:${Math.round(v)}`, icon: v >= 0 ? 'heart' : 'war', label: cap(peopleName(w, o)), n: `${FEEL_WORD(v)} (${v > 0 ? '+' : ''}${Math.round(v)})`, sel: { kind: 'folk', id: o },
    })), 'No strong feelings yet.', app));
    el.appendChild(h('h4.rule-head', { text: 'How the others regard them' }));
    el.appendChild(rows(b, () => others().map((o) => [o, feel(w, o, key)]).sort((x, y) => y[1] - x[1]).filter((_, i, a) => i < 4 || i >= a.length - 4).map(([o, v]) => ({
      key: `f${o}:${Math.round(v)}`, icon: v >= 0 ? 'heart' : 'war', label: cap(peopleName(w, o)), n: `${FEEL_WORD(v)} (${v > 0 ? '+' : ''}${Math.round(v)})`, sel: { kind: 'folk', id: o },
    })), 'No strong feelings yet.', app));
    el.appendChild(h('h4.rule-head', { text: 'Under other crowns' }));
    el.appendChild(rows(b, () => w.civs.filter((c) => c && c.alive && c.minor && c.minor[key]).map((c) => ({
      key: `m${c.id}:${c.minor[key][0]}`, swatch: c.colorHex, label: c.name, n: STAND_WORD[c.minor[key][0]], s: `since Year ${yearOf(c.minor[key][1])}`, sel: { kind: 'civ', id: c.id },
    })), 'No realm holds them as a minority.', app));
    el.appendChild(h('h4.rule-head', { text: 'Great migrations' }));
    el.appendChild(rows(b, () => (folkState(w)?.waves || []).filter((x) => x.people === key).slice().reverse().map((x, i) => ({
      key: `w${i}:${x.day}`, icon: 'people', label: `Year ${yearOf(x.day)}`, n: `${F.people(x.n)} set out`, s: { hunger: 'driven by hunger', war: 'fleeing war', crowding: 'too many for their land' }[x.why] || '',
    })), 'None.', app));
    b.update();
    return { update: () => b.update() };
  },
};

export function mount() {
  registerView('folk', folkView);
  registerSection('settlement', { id: 'folk.town', order: 27, when: (a, sel) => { const s = a.world && a.world.settlements[sel.id]; return Boolean(s && s.alive && !mythic(a.world) && s.folk); }, mount: townSection });
  registerSection('civ', { id: 'folk.realm', order: 25, when: (a, sel) => { const c = a.world && a.world.civs[sel.id]; return Boolean(c && c.alive && (!mythic(a.world) || (c.minor && Object.keys(c.minor).length))); }, mount: realmSection });
}
