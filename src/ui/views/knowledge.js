// Knowledge (chunk 5, docs/design/inventions.md): the invention and rare-art records, the
// Knowledge sections of a realm's and a town's dossier, search for inventions and arts, and the
// Knowledge map's picker (an invention's "Show its spread on the map").

import { ERAS } from '../../core/constants.js';
import { h, Binder } from '../dom.js';
import * as F from '../format.js';
import { registerView, registerSection, registerSearchSource } from '../registry.js';
import { section, kv, cells, rows, civRef, settleRef } from '../inspector.js';
import { setPref } from '../prefs.js';
import { techDef, allTechs, isArcane, NEEDS_WORDS, TECHS } from '../../sim/civ/tech.js';
import { ARTS, ART_IDS } from '../../sim/civ/data.js';
import { HOW, fromOf } from '../../sim/civ/knowledge.js';

let knowRender = null;
try { knowRender = await import('../../render/knowledge.js'); } catch (e) { /* no Knowledge map */ }

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const note = (text) => h('p.empty-note', { text });
const lead = (b, fn) => { const p = h('p.ins-lead'); b.text(p, fn); return p; };
const known = (c, id) => (c && c.tech && c.tech.known ? c.tech.known[id] : undefined);
const ageName = (t) => (ERAS[t.era] ? ERAS[t.era].name : 'an unknown age');
const civOf = (w, id) => (id != null && w.civs[id] ? w.civs[id] : null);

const VIA = {
  t: (X) => `trade with ${X}`, b: (X) => `learned from ${X}`, c: (X) => `from towns taken from ${X}`, a: (X) => `the arms of ${X}`,
  s: (X) => `a scholar of ${X}`, f: (X) => `refugees from ${X}`, u: (X) => `a ruin of ${X}`, i: (X) => `inherited from ${X}`,
};
/** "trade with the Varathi", "its own research". */
function howWords(w, civ, id) {
  const [h0, from] = fromOf(civ, id);
  const src = civOf(w, from);
  if (h0 === 'r') return 'its own research';
  if (h0 === 'd') return 'a gift of the gods';
  if (h0 === 'g') return 'known from its founding';
  return src && VIA[h0] ? VIA[h0](F.theCiv(src)) : HOW[h0] || 'its own research';
}

function mounted(build) {
  return (app, sel, el) => {
    const b = new Binder();
    let nodes;
    try { nodes = build(app, sel, b); } catch (e) { app.reportError('knowledge.view', e); nodes = [note(`This record could not be shown: ${e.message}`)]; }
    for (const n of [].concat(nodes)) if (n) el.appendChild(n);
    b.update();
    return { update: () => b.update() };
  };
}

function showOnMap(app, id) {
  if (!knowRender) return;
  knowRender.setKnowledgeTech(id);
  app.r('setMapMode', 'knowledge');
  setPref('mapMode', 'knowledge');
  app.emit('mapmode', 'knowledge');
}

// ---------------------------------------------------------------------------
// An invention

const inventionView = {
  label: 'Invention', icon: 'book',
  describe(app, sel) {
    const t = techDef(sel.id);
    return t ? { name: t.name, sub: `${isArcane(t) ? 'An arcane art' : ageName(t)} · ${t.tier === 'uncommon' ? 'uncommon' : 'common'}` } : { name: 'A lost invention' };
  },
  point(w, id) {
    const fw = w.sys.civ && w.sys.civ.firstWhere && w.sys.civ.firstWhere[id];
    const s = fw && fw[0] != null ? w.settlements[fw[0]] : null;
    return s ? { x: s.x, y: s.y } : null;
  },
  mount: mounted((app, sel, b) => {
    const w = app.world, t = techDef(sel.id);
    if (!t) return note('That invention is not in the record.');
    const st = w.sys.civ || {};
    const firstCiv = civOf(w, st.firstTech ? st.firstTech[t.id] : null);
    const fw = st.firstWhere && st.firstWhere[t.id];
    const holders = () => w.civs.filter((c) => c && c.alive && known(c, t.id) != null).sort((a, c) => known(a, t.id) - known(c, t.id) || a.id - c.id);
    const lost = () => w.civs.filter((c) => c && c.alive && c.tech && c.tech.lost && c.tech.lost[t.id] != null);
    const live = () => w.civs.filter((c) => c && c.alive).length;
    const btn = h('button.btn', { type: 'button', text: 'Show its spread on the map' });
    btn.addEventListener('click', () => showOnMap(app, t.id));
    return [
      lead(b, () => {
        const first = firstCiv ? `${F.theCiv(firstCiv).replace(/^./, (x) => x.toUpperCase())} found it first${fw && fw[0] != null && w.settlements[fw[0]] ? `, at ${w.settlements[fw[0]].name}` : ''}${fw ? `, in ${F.year(fw[1])}` : ''}.` : 'No people has found it yet.';
        return `${t.name}, ${isArcane(t) ? 'an arcane art' : `an invention of the ${ageName(t)}`}. ${first} ${holders().length ? `${F.int(holders().length)} of ${F.int(live())} living realms know it now.` : ''}`;
      }),
      cells(b, [
        { k: 'Known by', v: () => `${F.int(holders().length)} realms` },
        { k: 'First found', v: () => (fw ? F.year(fw[1]) : '—') },
        { k: 'Tier', v: () => (t.tier === 'uncommon' ? 'Uncommon' : 'Common') },
      ]),
      knowRender ? h('div.ins-actions', null, btn) : null,
      section('The invention', kv(b, [
        { k: 'Age', v: () => (isArcane(t) ? 'Arcane' : ageName(t)) },
        { k: 'Needs', v: () => t.prereqs.map((p) => (techDef(p) ? techDef(p).name : p)).join(', ') || 'Nothing before it', txt: true },
        { k: 'To invent alone', v: () => (NEEDS_WORDS[t.id] ? `needs ${NEEDS_WORDS[t.id]}; else three times the cost, or learned from others` : 'anyone may'), txt: true },
        { k: 'Found first by', ref: () => civRef(app, firstCiv ? firstCiv.id : null) },
        { k: 'Where', ref: () => settleRef(app, fw ? fw[0] : null), hide: () => !fw || fw[0] == null },
      ])),
      section('Who knows it', rows(b, () => holders().map((c) => ({
        key: `k${c.id}:${known(c, t.id)}`, swatch: c.colorHex, label: c.name, n: F.year(known(c, t.id)), s: howWords(w, c, t.id), sel: { kind: 'civ', id: c.id },
      })), 'No living realm knows it.', app)),
      section('Lost, and remembered', rows(b, () => lost().map((c) => ({
        key: `l${c.id}`, swatch: c.colorHex, label: c.name, n: F.year(c.tech.lost[t.id]), s: 'forgotten in a collapse', sel: { kind: 'civ', id: c.id },
      })), 'No realm has lost it.', app)),
    ];
  }),
};

// ---------------------------------------------------------------------------
// A rare art

const PEOPLE = { elf: 'the elves', dwarf: 'the dwarves', orc: 'the orcs', halfling: 'the halflings', lizardfolk: 'the lizardfolk' };
const artKind = (a) => (a.kind === 'people' ? `an art of ${PEOPLE[a.people] || 'one people'}` : a.kind === 'open' ? 'a Mythic art, open to every people' : 'a secret open to every people');

const artView = {
  label: 'Rare art', icon: 'wonder',
  describe(app, sel) { const a = ARTS[sel.id]; return a ? { name: a.name, sub: `Rare art · ${a.kind === 'people' ? PEOPLE[a.people] : a.kind === 'open' ? 'Mythic' : 'any people'}` } : { name: 'A lost art' }; },
  point(w, id) {
    const r = w.sys.civ && w.sys.civ.arts && w.sys.civ.arts[id];
    const sid = r ? (r.held[0] ? r.held[0][1] : r.first ? r.first[1] : null) : null;
    const s = sid != null ? w.settlements[sid] : null;
    return s ? { x: s.x, y: s.y } : null;
  },
  mount: mounted((app, sel, b) => {
    const w = app.world, a = ARTS[sel.id];
    if (!a) return note('That art is not in the record.');
    const rec = () => (w.sys.civ && w.sys.civ.arts && w.sys.civ.arts[sel.id]) || null;
    return [
      lead(b, () => {
        const r = rec();
        if (!r || !r.first) return `${a.name}: ${artKind(a)}. No realm has found it yet.`;
        const fc = civOf(w, r.first[0]), fs = w.settlements[r.first[1]];
        const now = r.held.length ? `${F.int(r.held.length)} ${r.held.length === 1 ? 'realm keeps' : 'realms keep'} it now.` : 'It has been lost.';
        return `${a.name}: ${artKind(a)}, the secret ${a.first.replace(/^to /, 'of how to ')}. ${fc ? `${F.theCiv(fc).replace(/^./, (x) => x.toUpperCase())} found it first` : 'It was found first'}${fs ? ` at ${fs.name}` : ''}, in ${F.year(r.first[2])}. ${now}`;
      }),
      section('The art', kv(b, [
        { k: 'Gives', v: () => a.what, txt: true },
        { k: 'Kind', v: () => artKind(a).replace(/^./, (x) => x.toUpperCase()), txt: true },
      ])),
      section('Kept by', rows(b, () => (rec() ? rec().held : []).map(([cid, sid, since]) => {
        const c = civOf(w, cid), s = w.settlements[sid];
        return { key: `h${cid}:${sid}`, swatch: c ? c.colorHex : null, label: c ? c.name : 'A fallen realm', n: `since ${F.year(since)}`, s: s ? `practised at ${s.name}` : '', sel: c ? { kind: 'civ', id: c.id } : null };
      }), 'No realm keeps it now.', app)),
      section('Lost', rows(b, () => (rec() ? rec().lost : []).slice().reverse().map(([cid, sid, day, why]) => {
        const c = civOf(w, cid), s = w.settlements[sid];
        return { key: `x${cid}:${day}`, swatch: c ? c.colorHex : null, label: s ? s.name : c ? c.name : 'A lost town', n: F.year(day), s: why === 'razed' ? 'burned with its town' : why === 'fall' ? 'with the fall of its realm' : 'its masters scattered', sel: s ? { kind: 'settlement', id: s.id } : null };
      }), 'Never lost.', app)),
    ];
  }),
};

// ---------------------------------------------------------------------------
// Dossier sections

function civSection(app, sel, el) {
  const w = app.world, civ = w.civs[sel.id];
  if (!civ || !civ.tech) return null;
  const b = new Binder();
  el.appendChild(h('h4.rule-head', { text: 'Learning and secrets' }));
  const hist = () => Object.keys(civ.tech.known).filter((id) => techDef(id) && !isArcane(techDef(id)));
  const learned = () => hist().filter((id) => { const f = fromOf(civ, id)[0]; return f !== 'r' && f !== 'g' && f !== 'i'; }).length;
  const arts = () => (civ.tech.arts ? Object.entries(civ.tech.arts) : []);
  const lost = () => (civ.tech.lost ? Object.keys(civ.tech.lost) : []);
  const libs = () => civ.settlementIds.filter((sid) => { const s = w.settlements[sid]; return s && Array.isArray(s.archive) && s.archive.length; }).length;
  el.appendChild(kv(b, [
    { k: 'Learned from others', v: () => `${F.int(learned())} (trade, neighbours, conquest, scholars, refugees)`, txt: true, hide: () => !learned() },
    { k: 'Libraries keeping archives', v: () => F.int(libs()), hide: () => !libs() },
    { k: 'Lost, and remembered', v: () => lost().map((id) => techDef(id)?.name || id).join(', '), txt: true, hide: () => !lost().length },
  ]));
  el.appendChild(rows(b, () => arts().map(([a, sid]) => ({
    key: `a${a}:${sid}`, icon: 'wonder', label: ARTS[a] ? ARTS[a].name : a, n: 'rare art', s: w.settlements[sid] ? `practised at ${w.settlements[sid].name}` : '', sel: { kind: 'art', id: a },
  })), 'It keeps no rare art.', app));
  const latest = () => hist().sort((a, c) => known(civ, c) - known(civ, a) || (a < c ? -1 : 1)).slice(0, 6);
  el.appendChild(rows(b, () => latest().map((id) => ({
    key: `t${id}:${known(civ, id)}`, icon: 'book', label: techDef(id).name, n: F.year(known(civ, id)), s: howWords(w, civ, id), sel: { kind: 'invention', id },
  })), 'It knows no invention yet.', app));
  b.update();
  return { update: () => b.update() };
}

function townSection(app, sel, el) {
  const w = app.world, s = w.settlements[sel.id];
  if (!s) return null;
  const b = new Binder();
  el.appendChild(h('h4.rule-head', { text: 'Learning' }));
  const arch = () => (Array.isArray(s.archive) ? s.archive : []);
  const shops = () => { const c = w.civs[s.civId]; return c && c.tech && c.tech.arts ? Object.keys(c.tech.arts).filter((a) => c.tech.arts[a] === s.id) : []; };
  el.appendChild(kv(b, [
    { k: 'Archive', v: () => `${F.int(arch().length)} inventions written down${fin(s.buildings?.library) >= 2 ? ' (a Great Library)' : ''}`, txt: true, hide: () => !arch().length },
    { k: 'Among them', v: () => arch().slice(-3).map((k) => (TECHS[k] ? TECHS[k].name : '')).filter(Boolean).join(', '), txt: true, hide: () => !arch().length },
  ]));
  el.appendChild(rows(b, () => shops().map((a) => ({ key: `w${a}`, icon: 'wonder', label: ARTS[a].name, n: 'workshop', s: ARTS[a].what, sel: { kind: 'art', id: a } })), '', app));
  b.update();
  return { update: () => b.update() };
}

// ---------------------------------------------------------------------------
// Search

function search(app, q, limit) {
  const w = app.world;
  if (!w || !q || q.length < 2) return [];
  const nq = q.toLowerCase();
  const out = [];
  for (const t of allTechs()) {
    const k = t.name.toLowerCase().indexOf(nq);
    if (k < 0) continue;
    const n = w.civs.filter((c) => c && c.alive && known(c, t.id) != null).length;
    out.push({ kind: 'invention', id: t.id, label: t.name, sub: `${isArcane(t) ? 'Arcane art' : `Invention · ${ageName(t)}`} · known by ${n}`, icon: 'book', score: (k === 0 ? 3 : 2) + nq.length / Math.max(8, t.name.length) });
  }
  for (const a of ART_IDS) {
    const nm = ARTS[a].name, k = nm.toLowerCase().indexOf(nq);
    if (k < 0 || (ARTS[a].kind !== 'hist' && !(w.params.mythLevel >= 2))) continue;
    out.push({ kind: 'art', id: a, label: nm, sub: 'Rare art', icon: 'wonder', score: (k === 0 ? 3 : 2) + nq.length / Math.max(8, nm.length) });
  }
  return out.sort((x, y) => y.score - x.score).slice(0, limit);
}

let done = false;
export function mount(app) {
  if (done) return;
  done = true;
  registerView('invention', inventionView);
  registerView('art', artView);
  registerSection('civ', { id: 'knowledge.civ', order: 30, when: (a, sel) => Boolean(a.world && a.world.civs[sel.id]), mount: civSection });
  registerSection('settlement', { id: 'knowledge.town', order: 30, when: (a, sel) => { const s = a.world && a.world.settlements[sel.id]; if (!s) return false; const c = a.world.civs[s.civId]; return (Array.isArray(s.archive) && s.archive.length > 0) || Boolean(c && c.tech && c.tech.arts && Object.values(c.tech.arts).includes(s.id)); }, mount: townSection });
  registerSearchSource({ id: 'knowledge', label: 'Inventions and rare arts', search });
}

