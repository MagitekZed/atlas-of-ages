// Dynasties (chunk 9, docs/design/dynasties.md) in the Inspector: a ruler's family and line of
// succession (sections on the ruler's record), any kept person's own record ('person'), a
// house's family tree (a section on the house's record), the realm's royal house and treasures
// (a section in its dossier), and each named treasure's record ('treasure'). Read-only:
// everything comes from sys.civ.kin and sys.civ.art (sim/civ/kin.js, treasures.js).

import { h, Binder } from '../dom.js';
import * as F from '../format.js';
import { registerView, registerSection } from '../registry.js';
import { section, kv, rows, linkBtn, textNode, civRef, religionRef, figureRef, rulerName, rulerId } from '../inspector.js';
import { DAYS_PER_YEAR } from '../../core/constants.js';
import { natureWords } from '../../core/character.js';
import { kinOf, lineOf, relationWords, personView, spouseOf, courtOf } from '../../sim/civ/kin.js';
import { treasuresOf, treasureById } from '../../sim/civ/treasures.js';
import { findRuler, findDynasty } from './records.js';

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const yearOf = (day) => Math.floor(fin(day) / DAYS_PER_YEAR);
const ageOf = (w, p) => Math.floor((fin(p.d, w.time.day) - fin(p.b, w.time.day)) / DAYS_PER_YEAR);
const note = (text) => h('p.empty-note', { text });
const houseWord = (p) => (p.h ? p.h.replace(/^the\s+/i, '') : p.nb ? 'a noble family' : '');
/** "of the House of Arkel", "of House Arkel", "of the Arkel dynasty" (as civ/dynasty.js houseOf). */
const ofHouse = (d) => { const n = String(d).replace(/^the\s+/i, ''); return /^House of /i.test(n) || /dynasty$/i.test(n) ? `of the ${n}` : `of ${n}`; };

function mounted(build) {
  return (app, sel, el) => {
    const b = new Binder();
    let nodes;
    try { nodes = build(app, sel, b); } catch (e) { app.reportError('kin.view', e); nodes = [note(`This record could not be shown: ${e.message}`)]; }
    for (const n of [].concat(nodes)) if (n) el.appendChild(n);
    b.update();
    return { update: () => b.update() };
  };
}

/** A person as a link, with their years and house as its tip. */
function personLink(app, w, p) {
  const yrs = `${yearOf(p.b)}–${p.d != null ? yearOf(p.d) : ''}`;
  return linkBtn(app, { kind: 'person', id: p.id }, p.n, { tipText: [houseWord(p), `Y${yrs}`, p.bas && !p.leg ? 'a bastard' : ''].filter(Boolean).join(' · ') });
}
/** Several people as links, comma-separated, in one cell. */
function peopleRef(app, w, list, empty = '—') {
  const ps = list.filter(Boolean);
  return {
    key: ps.map((p) => `${p.id}:${p.d ?? ''}`).join(',') || 'none',
    make: () => {
      if (!ps.length) return textNode(empty);
      const span = h('span.kin-list');
      ps.forEach((p, k) => { if (k) span.append(', '); span.append(personLink(app, w, p)); if (p.d != null) span.append(h('span.kin-dead', { text: ` (d. Y${yearOf(p.d)})` })); });
      return span;
    },
  };
}
const kidsOf = (w, p) => (p.ch || []).map((id) => kinOf(w, id)).filter(Boolean).sort((a, b) => a.b - b.b);
function siblingsOf(w, p) {
  const out = new Map();
  for (const id of [p.f, p.m]) { const par = kinOf(w, id); for (const k of par ? kidsOf(w, par) : []) if (k.id !== p.id) out.set(k.id, k); }
  return [...out.values()].sort((a, b) => a.b - b.b);
}
const spousesOf = (w, p) => (p.sp || []).map((id) => kinOf(w, id)).filter(Boolean);

/** The family rows of a kept person. */
function familyRows(app, b, w, p) {
  return kv(b, [
    { k: 'Father', ref: () => peopleRef(app, w, [kinOf(w, p.f)]), hide: () => p.f == null || !kinOf(w, p.f) },
    { k: 'Mother', ref: () => peopleRef(app, w, [kinOf(w, p.m)]), hide: () => p.m == null || !kinOf(w, p.m) },
    { k: p.sp && p.sp.length > 1 ? 'Spouses' : 'Spouse', ref: () => peopleRef(app, w, spousesOf(w, p), 'unwed'), hide: () => !(p.sp && p.sp.length) },
    { k: 'Children', ref: () => peopleRef(app, w, kidsOf(w, p)), hide: () => !(p.ch && p.ch.length) },
    { k: 'Brothers and sisters', ref: () => peopleRef(app, w, siblingsOf(w, p)), hide: () => !siblingsOf(w, p).length },
  ]);
}

/** What weakens a person's claim, in words. */
function weakWords(w, civ, p) {
  const out = [];
  if (ageOf(w, p) < 16) out.push('a child');
  if (p.leg) out.push('a bastard made lawful');
  if (p.c !== civ.id) out.push(`at the court of ${w.civs[p.c]?.name || 'another realm'}`);
  return out.join(', ');
}
/** The line after a person (the reigning ruler), as rows. */
function lineRows(app, b, w, civ, meOf) {
  return rows(b, () => { const me = meOf(); return me ? lineOf(w, civ, me, { max: 6 }).map((p, k) => ({
    key: `l${k}:${p.id}:${p.c}:${p.leg || 0}`, icon: k === 0 ? 'crown' : 'people', label: `${k + 1}. ${p.n}`,
    n: `${relationWords(w, me, p) || 'kin'}, ${ageOf(w, p)}`, s: weakWords(w, civ, p), sel: { kind: 'person', id: p.id },
  })) : []; }, 'No one: the house would die out with this ruler.', app);
}

// ---------------------------------------------------------------------------
// the ruler's record: family and line

function rulerSection(app, sel, el) {
  const w = app.world, f = findRuler(w, sel.id);
  const me = f ? kinOf(w, f.r.id) : null;
  if (!me) return null;
  const b = new Binder();
  const reigning = f.idx < 0 && f.civ.alive && f.civ.ruler && f.civ.ruler.id === me.id;
  el.appendChild(h('h4.rule-head', { text: 'Family' }));
  el.appendChild(familyRows(app, b, w, me));
  if (reigning) {
    el.appendChild(h('h4.rule-head', { text: 'The line of succession' }));
    el.appendChild(lineRows(app, b, w, f.civ, () => me));
  }
  b.update();
  return { update: () => b.update() };
}

// ---------------------------------------------------------------------------
// a kept person's own record

const personViewDef = {
  label: 'Person', icon: 'crown',
  describe(app, sel) {
    const w = app.world, p = kinOf(w, sel.id);
    return p ? { name: p.n, sub: [houseWord(p), `Y${yearOf(p.b)}–${p.d != null ? 'Y' + yearOf(p.d) : 'now'}`].filter(Boolean).join(' · '), color: w.civs[p.c]?.colorHex } : { name: 'A forgotten person' };
  },
  point(w, id) { const p = kinOf(w, id); const c = p ? w.civs[p.c] : null; const cap = c && c.capitalId != null ? w.settlements[c.capitalId] : null; return cap ? { x: cap.x, y: cap.y } : null; },
  mount: mounted((app, sel, b) => {
    const w = app.world, p = kinOf(w, sel.id);
    if (!p) return note('This person has passed out of the record.');
    const civ = w.civs[p.c];
    const fa = kinOf(w, p.f), mo = kinOf(w, p.m);
    const child = p.g === 'f' ? 'daughter' : 'son';
    const reign = findRuler(w, p.id);
    const leadText = () => {
      const parents = fa && mo ? `, ${p.bas && !p.leg ? 'bastard ' : ''}${child} of ${fa.n} and ${mo.n}` : fa || mo ? `, ${p.bas && !p.leg ? 'bastard ' : ''}${child} of ${(fa || mo).n}` : '';
      const house = p.h ? ` ${ofHouse(p.h)}` : '';
      const life = p.d != null ? `, born in Year ${yearOf(p.b)}, died in Year ${yearOf(p.d)}${p.dc ? ` (${F.humanize(p.dc).toLowerCase()})` : ''}` : `, born in Year ${yearOf(p.b)}, now ${ageOf(w, p)}`;
      const at = p.d == null && civ ? ` Lives at the court of ${F.theCiv(civ)}${p.dep ? ', set aside' : ''}.` : '';
      return `${p.n}${house}${parents}${life}.${at}`;
    };
    const lead = h('p.ins-lead'); b.text(lead, leadText);
    // the place in the line of the realm they live in
    const place = () => {
      if (p.d != null || !civ || !civ.alive || !civ.ruler) return '';
      if (civ.ruler.id === p.id) return 'Reigns';
      const r = kinOf(w, civ.ruler.id);
      const k = r ? lineOf(w, civ, r, { max: 14 }).findIndex((q) => q.id === p.id) : -1;
      return k >= 0 ? `${['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'][k] || `${k + 1}th`} in line to the throne` : p.dep ? 'Set aside' : 'Not in the line';
    };
    return [
      lead,
      section('The person', kv(b, [
        { k: 'Court', ref: () => civRef(app, p.c), hide: () => !civ },
        { k: 'Place', v: place, txt: true, hide: () => !place() },
        { k: 'Reign', ref: () => (reign ? { key: 'r' + reign.r.reignStart, make: () => linkBtn(app, { kind: 'ruler', id: rulerId(reign.civ, reign.r) }, rulerName(reign.r)) } : { key: 'none', make: () => textNode('—') }), hide: () => !reign },
        { k: 'Nature', v: () => natureWords(personView(p), civ, 3).join(', ') || 'Even-tempered', txt: true, hide: () => p.d != null || p.nb },
        { k: 'Wants', v: () => 'The throne', txt: true, hide: () => !(p.am && p.am.k === 'throne') },
      ])),
      section('Family', familyRows(app, b, w, p)),
    ];
  }),
};

// ---------------------------------------------------------------------------
// a house's family tree

/** The house's tree: its kept members by descent, the earliest first (rulers marked). */
function treeSection(app, sel, el) {
  const w = app.world, d = findDynasty(w, sel.id);
  if (!d) return null;
  const K = w.sys?.civ?.kin?.p;
  if (!K) return null;
  const members = Object.values(K).filter((p) => p.h === d.name && !p.nb);
  if (!members.length) return null;
  const ids = new Set(members.map((p) => p.id));
  const roots = members.filter((p) => !(ids.has(p.f) || ids.has(p.m))).sort((a, b) => a.b - b.b);
  const ruled = new Set([...(d.civ.rulerHistory || []), ...(d.civ.ruler ? [d.civ.ruler] : [])].map((r) => r.id));
  let budget = 160;
  const node = (p, depth) => {
    if (budget-- <= 0) return null;
    const sp = spousesOf(w, p).map((s) => s.n).join(', ');
    const li = h('li', { class: p.d == null ? 'is-living' : '' },
      h('span.kin-row', null,
        ruled.has(p.id) ? h('span.kin-crown', { text: '♛ ', 'aria-label': 'ruled' }) : null,
        personLink(app, w, p),
        h('span.yrs', { text: ` Y${yearOf(p.b)}–${p.d != null ? 'Y' + yearOf(p.d) : ''}${sp ? ` · m. ${sp}` : ''}${p.bas && !p.leg ? ' · bastard' : ''}` })));
    const kids = depth < 8 ? kidsOf(w, p).filter((k) => ids.has(k.id) || k.h === d.name || ruled.has(k.id)) : [];
    if (kids.length) { const ul = h('ul.kin-tree'); for (const k of kids) { const n = node(k, depth + 1); if (n) ul.appendChild(n); } li.appendChild(ul); }
    return li;
  };
  el.appendChild(h('h4.rule-head', { text: 'Family tree' }));
  const ul = h('ul.kin-tree.is-root');
  for (const r of roots) { const n = node(r, 0); if (n) ul.appendChild(n); }
  el.appendChild(ul);
  el.appendChild(h('p.note', { text: 'Those of the house kept in the record: the living, their forebears, and the house’s last rulers. ♛ ruled.' }));
  return null;
}

// ---------------------------------------------------------------------------
// the realm's royal house and treasures (dossier)

function civSection(app, sel, el) {
  const w = app.world, civ = w.civs[sel.id];
  if (!civ) return null;
  const b = new Binder();
  const me = () => (civ.ruler ? kinOf(w, civ.ruler.id) : null);
  el.appendChild(h('h4.rule-head', { text: 'The royal house' }));
  el.appendChild(kv(b, [
    { k: 'Consort', ref: () => { const m = me(); const s = m ? spouseOf(w, m) : null; return peopleRef(app, w, [s], 'none'); }, hide: () => !me() },
    { k: 'The family', v: () => { const n = courtOf(w, civ.id).length; return `${F.int(n)} at court`; }, hide: () => !me() },
  ]));
  el.appendChild(lineRows(app, b, w, civ, me));
  el.appendChild(h('h4.rule-head', { text: 'Treasures' }));
  el.appendChild(rows(b, () => treasuresOf(w, civ.id).map((t) => ({
    key: `t${t.id}:${t.h.length}`, icon: t.pw ? 'star' : 'crown', label: F.headName(t.n),
    n: t.f === civ.id ? KIND[t.k] || t.k : `${KIND[t.k] || t.k}, of ${w.civs[t.f]?.name || 'another realm'}`, sel: { kind: 'treasure', id: t.id },
  })), 'None.', app));
  b.update();
  return { update: () => b.update() };
}

// ---------------------------------------------------------------------------
// a treasure's record

const KIND = { crown: 'a crown', sword: 'a sword of state', seal: 'a great seal', sceptre: 'a sceptre', blade: 'a named sword', relic: 'a holy relic', runeblade: 'a runeblade', starglass: 'a starglass', totem: 'a war-totem', eggstone: 'an egg-stone', book: 'an heirloom book' };
const GIFT = { military: 'its holder’s armies fight harder', research: 'its holder’s scholars learn faster', birth: 'its holder’s people bear more children', happiness: 'its holder’s people are more content' };

function whereRef(app, w, t) {
  const at = t.at || {};
  if (at.k === 'civ') return civRef(app, at.id);
  if (at.k === 'fig') return figureRef(app, at.id);
  if (at.k === 'faith') return religionRef(app, at.id);
  if (at.k === 'exile') { const ex = (w.sys?.civ?.exiles || []).find((e) => e.id === at.id); return { key: 'x' + at.id, make: () => textNode(ex ? `With the court of ${ex.name} in exile` : 'In exile') }; }
  const s = at.sid != null ? w.settlements[at.sid] : null;
  return { key: 'lost' + at.sid, make: () => textNode(s ? `Lost, at ${s.name}${s.alive ? '' : ' (ruins)'}` : 'Lost') };
}

const treasureViewDef = {
  label: 'Treasure', icon: 'crown',
  describe(app, sel) { const t = treasureById(app.world, Number(sel.id)); return t ? { name: F.headName(t.n), sub: `${F.headName(KIND[t.k] || t.k)} · made Y${yearOf(t.made)}` } : { name: 'A lost treasure' }; },
  point(w, id) {
    const t = treasureById(w, Number(id));
    if (!t) return null;
    if (t.at.k === 'civ') { const c = w.civs[t.at.id]; const cap = c && w.settlements[c.capitalId]; if (cap) return { x: cap.x, y: cap.y }; }
    return t.at.x || t.at.y ? { x: t.at.x, y: t.at.y } : null;
  },
  mount: mounted((app, sel, b) => {
    const w = app.world, t = treasureById(w, Number(sel.id));
    if (!t) return note('This treasure has passed out of the record.');
    const made = w.civs[t.f];
    const lead = h('p.ins-lead');
    b.text(lead, () => `${F.headName(t.n)}: ${KIND[t.k] || 'a treasure'}${t.by ? `, made by ${t.by}` : ''}${made ? ` for ${F.theCiv(made)}` : ''} in Year ${yearOf(t.made)}.${t.pw ? ` A treasure of power: ${GIFT[t.pw] || 'it lends its holder its gift'}.` : ''}`);
    return [
      lead,
      section('Where it is', kv(b, [
        { k: 'Now', ref: () => whereRef(app, w, t) },
        { k: 'Made for', ref: () => civRef(app, t.f), hide: () => t.f == null || !w.civs[t.f] },
      ])),
      section('Its story', rows(b, () => t.h.slice().reverse().map((e, k) => ({
        key: `h${k}:${e[0]}:${e[1]}`, icon: 'scroll', label: `Year ${yearOf(e[0])}`, n: F.headName(e[1]), s: e[2] >= 0 ? w.civs[e[2]]?.name || '' : '', ...(e[2] >= 0 && w.civs[e[2]] ? { sel: { kind: 'civ', id: e[2] } } : {}),
      })), 'Nothing recorded.', app)),
    ];
  }),
};

export function mount() {
  registerView('person', personViewDef);
  registerView('treasure', treasureViewDef);
  registerSection('ruler', { id: 'kin.ruler', order: 20, when: (a, sel) => { const f = a.world && findRuler(a.world, sel.id); return Boolean(f && kinOf(a.world, f.r.id)); }, mount: rulerSection });
  registerSection('dynasty', { id: 'kin.tree', order: 20, mount: treeSection });
  registerSection('civ', { id: 'kin.civ', order: 23, when: (a, sel) => { const c = a.world && a.world.civs[sel.id]; return Boolean(c && ((c.ruler && kinOf(a.world, c.ruler.id)) || treasuresOf(a.world, c.id).length)); }, mount: civSection });
}

