// Mythic sections — registered Inspector sections for Mythic worlds:
//   civ         race badge and lifespan, temperament and how fast it drifts, the arcane
//               schools and their progress, territory mana, places of power held (the
//               peoples within: ./peoples.js)
//   settlement  the town's people (and a minority note), racial halls, local mana, wards and
//               luck, blessings and curses in force
//   tile        mana and ley here, the nearest place of power, the people this land suits
//   site        the node card for a place of power (WP6 draws the site record itself)
//   religion    the god's domain, favour and answered prayers
// mount(app) also registers the myth glyphs, a search source over the places of power, two
// commands (Arcane map, Legends), and refreshes the tool belt the moment magic awakens.
// Read-only: nothing here writes the world.

import { registerSection, registerIcon, registerCommand, registerSearchSource, registerUntilCondition } from '../registry.js';
import { h, Binder, svgEl } from '../dom.js';
import * as F from '../format.js';
import { RACE_META, WATER } from '../../core/constants.js';
import { getSite } from '../../core/sites.js';
import { chronicleEntry } from '../../core/chronicle.js';
import { effectsOf } from '../../core/effects.js';
import { RACES, RACE_LIST, RACE_IDX, raceAff, raceRel, raceRgb } from '../../sim/myth/races.js';
import { raceBlurb, mythBuildingsOf } from '../../sim/myth/identity.js';
import { schoolProgress } from '../../sim/myth/arcana.js';
import { manaAt, leyNodes } from '../../sim/myth/mana.js';
import { nearestEdge, NODE_KIND_LABEL } from '../../sim/myth/ley.js';
import { domainOf, DOMAIN_LABEL } from '../../sim/myth/divine.js';
import { weaveWord } from '../../sim/myth/fading.js';
import { RACE_GLYPH } from '../peoples.js';
import { mountPeoples } from './peoples.js';
import { leanings, driftWords } from '../temper.js';

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export const mythic = (w) => Boolean(w && w.params && w.params.mythLevel >= 2 && w.sys?.myth?.v != null);

// ---------------------------------------------------------------------------
// Glyphs (24-unit grid, 1.6 line, currentColor)

export const MYTH_ICONS = {
  ley: '<path d="M3 17c3-1 4-8 9-8s6 7 9 6"/><circle cx="3" cy="17" r="1.4"/><circle cx="21" cy="15" r="1.4"/><path d="M12 3.6v2.2M9.4 4.9l1 1.5M14.6 4.9l-1 1.5" stroke-width="1.1"/>',
  wellspring: '<path d="M9 21V9.5c0-1.7 1.3-3 3-3s3 1.3 3 3V21"/><path d="M4 21h16"/><path d="M12 2.6v1.8M8 4.4l1 1.3M16 4.4l-1 1.3" stroke-width="1.2"/><path d="M12 11.3c-1.1 1.3-1.1 3 0 4.3 1.1-1.3 1.1-3 0-4.3z" fill="currentColor" stroke="none"/>',
  awaken: '<path d="M2.5 13.5c2.6-4 5.8-6 9.5-6s6.9 2 9.5 6c-2.6 4-5.8 6-9.5 6s-6.9-2-9.5-6z"/><circle cx="12" cy="13.5" r="2.8"/><path d="M12 2.4v2.4M5.4 4.6l1.4 1.8M18.6 4.6l-1.4 1.8" stroke-width="1.2"/>',
  myth: '<path d="M14.8 3.6a8.6 8.6 0 1 0 5.6 13.6 6.8 6.8 0 0 1-5.6-13.6z"/><path d="M17.4 6.6l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" stroke-width="1.1"/>',
  arcane: '<circle cx="12" cy="12" r="8.6"/><path d="M12 5.2l5.9 10.2H6.1z"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/>',
  node: '<path d="M3 20.5h18"/><path d="M6 20.5v-6.2c0-.9.6-1.5 1.4-1.5s1.4.6 1.4 1.5v6.2M10.6 20.5V11c0-.9.6-1.6 1.4-1.6s1.4.7 1.4 1.6v9.5M15.2 20.5v-5.6c0-.9.6-1.5 1.4-1.5s1.4.6 1.4 1.5v5.6"/><path d="M12 3.2v2.4M8.6 4.6l1.1 1.6M15.4 4.6l-1.1 1.6" stroke-width="1.1"/>',
  legends: '<path d="M4 5.5C6.5 4.5 9.4 4.6 12 6c2.6-1.4 5.5-1.5 8-.5v13c-2.5-1-5.4-.9-8 .5-2.6-1.4-5.5-1.5-8-.5z"/><path d="M12 6v13"/><path d="M6.4 9.6c1.4-.4 2.6-.3 3.6.2M14 9.8c1-.5 2.2-.6 3.6-.2M6.4 13c1.4-.4 2.6-.3 3.6.2" stroke-width="1.1"/>',
  folklore: '<path d="M5 20.5c1.8-5.5 4-8.8 7-8.8s5.2 3.3 7 8.8"/><circle cx="12" cy="7" r="3"/><path d="M4 9.5l2 .8M20 9.5l-2 .8M12 1.8v1.4" stroke-width="1.1"/>',
};
/** Race symbols (RACE_META.symbol) as small filled glyphs (shared with ../peoples.js). */
export const RACE_SYMBOL = RACE_GLYPH;
const svg = (inner, size = 18, extra = '') => svgEl(`<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${inner}</svg>`);

/** A race badge: its symbol on a disc of its colour, with its name. */
export function raceBadge(race, { size = 18, label = true, plural = false } = {}) {
  const meta = RACE_META[race];
  if (!meta) return h('span.race-badge', { text: '—' });
  const c = `rgb(${raceRgb(race).join(',')})`;
  const dot = h('span.rb-dot', { style: { '--rc': c } }, svg(RACE_SYMBOL[meta.symbol] || RACE_SYMBOL.round, Math.round(size * 0.72), 'fill="currentColor"'));
  return h('span.race-badge', null, dot, label ? h('span.rb-name', { text: plural ? meta.plural : meta.label }) : null);
}

// ---------------------------------------------------------------------------
// Building blocks

function head(el, title, icon = null) {
  el.classList.add('myth-sec');
  el.appendChild(h('h4.rule-head', null, icon ? svg(MYTH_ICONS[icon] || '', 14) : null, title));
}
function kv(b, items) {
  const dl = h('dl.kv');
  for (const it of items) {
    if (!it) continue;
    const dt = h('dt', { text: it.k });
    const dd = h('dd', { class: it.txt ? 'txt' : '' });
    dl.append(dt, dd);
    if (it.node) b.list(dd, () => [it.node()], (r) => r.key, (r) => r.make());
    else b.text(dd, it.v);
    if (it.hide) { b.hide(dt, it.hide); b.hide(dd, it.hide); }
    if (it.m) {
      const m = h('div.meter', { class: it.mc || '' });
      const row = h('div.meter-row', null, m);
      dl.append(row);
      b.meter(m, it.m);
      if (it.hide) b.hide(row, it.hide);
    }
  }
  return dl;
}
const link = (app, sel, label, swatch = null) => {
  const btn = h('button.link', { type: 'button' }, swatch ? h('i.swatch', { style: { '--c': swatch, marginRight: '6px', verticalAlign: '-1px' } }) : null, label);
  btn.addEventListener('click', () => app.select(sel, { focus: true }));
  return btn;
};
const lifeWord = (life) => (life >= 4 ? 'many human lifetimes' : life >= 2.5 ? 'three human lifetimes' : life > 1.15 ? 'a little longer than men' : life < 0.8 ? 'hard and short' : 'a human span');
const rateWord = (v) => (v >= 1.3 ? 'very fast' : v >= 1.1 ? 'fast' : v > 0.9 ? 'like men' : v >= 0.6 ? 'slow' : 'very slow');
const manaWord = (m) => (m >= 0.8 ? 'blazing' : m >= 0.55 ? 'rich' : m >= 0.35 ? 'steady' : m >= 0.18 ? 'thin' : 'all but dead');
// ---------------------------------------------------------------------------
// Sections

function civSection(app, sel, el) {
  const w = app.world, civ = w.civs[sel.id];
  if (!civ) return null;
  const b = new Binder();
  head(el, 'Race & magic', 'myth');
  const badge = h('div.myth-badge-row');
  b.list(badge, () => [civ.race || 'none'], (r) => r, (r) => raceBadge(r, { size: 22, plural: true }));
  const blurb = h('p.myth-blurb');
  b.text(blurb, () => raceBlurb(civ.race));
  el.append(badge, blurb);
  const R = () => RACES[civ.race] || RACES.human;
  el.appendChild(kv(b, [
    { k: 'Lifespan', v: () => `${lifeWord(R().life)} (×${F.num(R().life, 1)})` },
    { k: 'Births · deaths', v: () => `${rateWord(R().birth)} · ${rateWord(R().mortality)}` },
    // the race's leanings and drift speed (the people's own temperament: the Temperament section)
    { k: 'Its race leans', txt: true, v: () => leanings(R().temper, 3).join(', ') || 'no way in particular', hide: () => !R().temper },
    { k: 'Its temper drifts', txt: true, v: () => { const d = driftWords(R().adapt); return d ? `${d.speed} · ${d.detail}` : '—'; }, hide: () => !driftWords(R().adapt) },
    { k: 'Mana in its lands', v: () => `${Math.round(100 * fin(civ.arcane?.mana))} · ${manaWord(fin(civ.arcane?.mana))}`, m: () => Math.min(1, fin(civ.arcane?.mana) / 1.1), mc: 'is-myth' },
  ]));
  // the arts
  const arts = h('div.myth-arts');
  b.list(arts, () => schoolProgress(w, civ), (p) => `${p.school.id}:${p.known.length}:${p.researching?.id || ''}:${p.access}`, (p) => {
    const row = h('div.myth-art', { style: { '--sc': `rgb(${p.school.color.join(',')})` } },
      h('span.ma-name', { text: p.school.label }),
      h('span.ma-count', { text: `${p.known.length} of ${p.total}` }),
      h('div.meter.is-myth', { style: { '--v': `${(100 * p.known.length / p.total).toFixed(0)}%` } }),
      h('span.ma-next', { text: p.researching ? `studying ${p.researching.name}` : p.known.length ? p.known.map((t) => t.name).slice(-2).join(', ') : p.next ? `next: ${p.next.name}${fin(civ.arcane?.mana) < p.next.minMana ? ' (needs more mana)' : ''}` : '' }),
    );
    if (p.access === 'taught') row.appendChild(h('span.ma-tag', { text: 'taught by neighbours' }));
    if (p.access === 'dark') row.appendChild(h('span.ma-tag.is-dark', { text: 'forbidden' }));
    return row;
  });
  el.appendChild(h('h5.myth-sub', { text: 'Arcane arts' }));
  el.appendChild(arts);
  // places of power and the peoples within
  const nodes = h('div.tags');
  b.list(nodes, () => leyNodes(w).filter((n) => w.f.owner[n.i] === civ.id), (n) => n.id + n.name, (n) => h('span.tag.is-link', null, link(app, { kind: 'site', id: n.id }, n.name)));
  const pnodes = h('div', null, h('h5.myth-sub', { text: 'Places of power held' }), nodes);
  b.hide(pnodes, () => !leyNodes(w).some((n) => w.f.owner[n.i] === civ.id));
  el.appendChild(pnodes);
  // the peoples within the realm: the "Peoples of the realm" section (./peoples.js)
  b.update();
  return { update: () => b.update() };
}

const EFFECT_PREFIX = /^(myth|folk)\./;
function townSection(app, sel, el) {
  const w = app.world, s = w.settlements[sel.id];
  if (!s) return null;
  const b = new Binder();
  head(el, 'People & magic', 'myth');
  const civ = () => w.civs[s.civId];
  const race = () => s.race || civ()?.race || null;
  const row = h('div.myth-badge-row');
  b.list(row, () => [race() || 'none'], (r) => r, (r) => raceBadge(r, { size: 20 }));
  const minority = h('p.myth-note');
  b.text(minority, () => {
    const c = civ();
    if (!c || !s.race || !c.race || s.race === c.race) return '';
    const rel = raceRel(s.race, c.race);
    return `${aOrAn(RACE_META[s.race].adjective)} town under ${RACE_META[c.race].adjective.toLowerCase()} rule${rel <= -20 ? ', across an old enmity: its loyalty is brittle' : rel >= 8 ? ', among kin who get on well' : ''}.`;
  });
  b.hide(minority, () => !minority.textContent);
  el.append(row, minority);
  el.appendChild(kv(b, [
    { k: 'Mana here', v: () => `${Math.round(100 * manaAt(w, s.x, s.y))} · ${manaWord(manaAt(w, s.x, s.y))}`, m: () => Math.min(1, manaAt(w, s.x, s.y) / 1.1), mc: 'is-myth' },
    { k: 'Wards', v: () => F.pct(fin(civ()?.mods?.wards)), hide: () => !(fin(civ()?.mods?.wards) > 0) },
    { k: 'Luck', v: () => F.pct(fin(civ()?.mods?.luck)), hide: () => !(fin(civ()?.mods?.luck) > 0) },
  ]));
  const halls = h('div.tags');
  b.list(halls, () => mythBuildingsOf(s), (x) => x.def.id + x.level, (x) => { const t = h('span.tag', { text: x.def.names[Math.min(x.def.names.length - 1, x.level - 1)] }); t.title = x.def.desc; return t; });
  const hb = h('div', null, h('h5.myth-sub', { text: 'Halls of its people' }), halls);
  b.hide(hb, () => !mythBuildingsOf(s).length);
  el.appendChild(hb);
  const fx = h('div.tags');
  b.list(fx, () => effectsOf(w, { kind: 'settlement', id: s.id }).filter((e) => EFFECT_PREFIX.test(e.k)), (e) => e.k + e.until, (e) => h('span.tag.is-myth', { text: e.label || F.humanize(e.k.split('.').pop()) }));
  const fb = h('div', null, h('h5.myth-sub', { text: 'Blessings, curses and tales' }), fx);
  b.hide(fb, () => !effectsOf(w, { kind: 'settlement', id: s.id }).some((e) => EFFECT_PREFIX.test(e.k)));
  el.appendChild(fb);
  b.update();
  return { update: () => b.update() };
}
const aOrAn = (wd) => (/^[aeiou]/i.test(wd) ? 'An ' : 'A ') + wd.toLowerCase();

function nearestNode(w, x, y) {
  let best = null, bd = Infinity;
  for (const n of leyNodes(w)) { const d = Math.hypot(n.x - x, n.y - y); if (d < bd) { bd = d; best = n; } }
  return best ? { n: best, d: bd } : null;
}
function suited(w, i) {
  if (w.f.water[i] !== WATER.LAND) return null;
  let best = null, bv = 0;
  for (const r of RACE_LIST) { const v = raceAff(w, RACE_IDX[r], i); if (v > bv) { bv = v; best = r; } }
  return best;
}
function tileSection(app, sel, el) {
  const w = app.world;
  const x = Number.isFinite(sel.x) ? sel.x : sel.id % w.W, y = Number.isFinite(sel.y) ? sel.y : Math.floor(sel.id / w.W);
  const i = Math.max(0, Math.min(w.N - 1, y * w.W + x));
  const b = new Binder();
  head(el, 'Magic of the land', 'ley');
  el.appendChild(kv(b, [
    { k: 'Mana', v: () => `${Math.round(100 * manaAt(w, x, y))} · ${manaWord(manaAt(w, x, y))}`, m: () => Math.min(1, manaAt(w, x, y) / 1.1), mc: 'is-myth' },
    { k: 'Ley', v: () => { const v = w.f.ley?.[i] || 0; if (v >= 200) return 'on a ley line'; const e = nearestEdge(w.sys.myth.ley.edges, x, y); return e.edge < 0 ? '—' : `${F.km(e.dist)} from a ley line`; } },
    { k: 'Place of power', txt: true, node: () => { const nn = nearestNode(w, x, y); return { key: nn ? nn.n.id + ':' + Math.round(nn.d) : 'none', make: () => (nn ? h('span', null, link(app, { kind: 'site', id: nn.n.id }, nn.n.name), nn.d < 0.8 ? ' · here' : ` · ${F.km(nn.d)}`) : h('span', { text: '—' })) }; } },
    { k: 'Suits best', txt: true, node: () => { const r = suited(w, i); return { key: r || 'none', make: () => (r ? raceBadge(r, { size: 14, plural: true }) : h('span', { text: '—' })) }; } },
  ]));
  b.update();
  return { update: () => b.update() };
}

function nodeSection(app, sel, el) {
  const w = app.world;
  const n = getSite(w, Number(sel.id));
  if (!n || n.kind !== 'node') return null;
  const b = new Binder();
  head(el, 'Place of power', 'node');
  const edges = () => w.sys.myth.ley.edges.filter((e) => e.a === n.id || e.b === n.id);
  const owner = () => { const o = w.f.owner[n.i]; return o >= 0 ? w.civs[o] : null; };
  const lead = h('p.myth-blurb');
  b.text(lead, () => {
    const kind = NODE_KIND_LABEL[n.data?.nk] || 'a place of power';
    const o = owner();
    const origin = n.data?.origin === 'tool' ? 'raised by an unseen hand' : n.data?.origin === 'gen' ? 'old as the world' : 'woken with the magic';
    return `${kind[0].toUpperCase() + kind.slice(1)}, ${origin}. ${edges().length} ley line${edges().length === 1 ? '' : 's'} meet here${o ? `, in the lands of ${o.name}` : ', in no one’s lands'}.`;
  });
  el.appendChild(lead);
  el.appendChild(kv(b, [
    { k: 'Power', v: () => F.pct(fin(n.data?.power, 0.8)), m: () => fin(n.data?.power, 0.8), mc: 'is-myth' },
    { k: 'Mana here', v: () => `${Math.round(100 * manaAt(w, n.x, n.y))} · ${manaWord(manaAt(w, n.x, n.y))}` },
    { k: 'Held by', txt: true, node: () => { const o = owner(); return { key: o ? 'c' + o.id + o.name : 'none', make: () => (o ? link(app, { kind: 'civ', id: o.id }, o.name, o.colorHex) : h('span', { text: 'the wild' })) }; } },
    { k: 'Coveted by', txt: true, v: () => {
      const o = owner();
      const out = [];
      for (const c of w.civs) {
        if (!c || !c.alive || c === o || !(fin(c.arcane?.known) > 0 || c.race === 'elf')) continue;
        let d = Infinity;
        for (const sid of c.settlementIds || []) { const s = w.settlements[sid]; if (s && s.alive) d = Math.min(d, Math.hypot(s.x - n.x, s.y - n.y)); }
        if (d <= 26) out.push(c.name);
      }
      return out.length ? F.listing(out, 3) : 'no one yet';
    }, hide: () => !owner() },
  ]));
  b.update();
  return { update: () => b.update() };
}

function godSection(app, sel, el) {
  const w = app.world;
  const r = w.religions?.[sel.id];
  if (!r) return null;
  const b = new Binder();
  head(el, 'The god', 'myth');
  el.appendChild(kv(b, [
    { k: 'God', v: () => r.deity || '—' },
    { k: 'Domain', v: () => { const d = domainOf(r); return d ? DOMAIN_LABEL[d] : 'none (the god never answers)'; } },
    { k: 'Favour', v: () => F.pct(fin(w.sys.myth.favor?.[String(r.id)])), m: () => fin(w.sys.myth.favor?.[String(r.id)]), mc: 'is-myth', hide: () => !domainOf(r) },
    { k: 'Prayers answered', v: () => F.int(fin(w.sys.myth.divine?.byFaith?.[String(r.id)])), hide: () => !domainOf(r) },
  ]));
  b.update();
  return { update: () => b.update() };
}

// ---------------------------------------------------------------------------
// Mount

let mounted = false;
export function mount(app) {
  if (mounted) return;
  mounted = true;
  for (const [k, v] of Object.entries(MYTH_ICONS)) registerIcon(k, v);
  mountPeoples(app);
  const live = (a) => mythic(a.world);
  registerSection('civ', { id: 'myth.civ', order: 22, when: (a, sel) => live(a) && Boolean(a.world.civs[sel.id]), mount: civSection });
  registerSection('settlement', { id: 'myth.town', order: 22, when: (a, sel) => live(a) && Boolean(a.world.settlements[sel.id]), mount: townSection });
  registerSection('tile', { id: 'myth.tile', order: 30, when: (a) => live(a), mount: tileSection });
  registerSection('site', { id: 'myth.node', order: 10, when: (a, sel) => live(a) && getSite(a.world, Number(sel.id))?.kind === 'node', mount: nodeSection });
  registerSection('religion', { id: 'myth.god', order: 40, when: (a, sel) => live(a) && Boolean(a.world.religions?.[sel.id]), mount: godSection });
  registerCommand({
    id: 'myth.arcane', label: 'Arcane map: mana and ley lines', group: 'Map', keywords: ['magic', 'mana', 'ley', 'nodes', 'arcane'], icon: 'ley',
    when: live, run: (a) => { a.r?.('setMapMode', 'arcane'); a.emit('mapmode', 'arcane'); },
  });
  registerCommand({
    id: 'myth.peoples', label: 'Peoples map: the races of the world', group: 'Map', keywords: ['race', 'elves', 'dwarves', 'orcs', 'halflings', 'lizardfolk', 'peoples'], icon: 'myth',
    when: live, run: (a) => { a.r?.('setMapMode', 'peoples'); a.emit('mapmode', 'peoples'); },
  });
  registerSearchSource({
    id: 'myth.nodes', label: 'Places of power',
    search(a, q, limit) {
      const w = a.world;
      if (!mythic(w) || !q) return [];
      const ql = String(q).toLowerCase();
      const out = [];
      for (const n of leyNodes(w)) {
        const name = String(n.name || '');
        const k = name.toLowerCase().indexOf(ql);
        if (k < 0) continue;
        out.push({ kind: 'site', id: n.id, label: name, sub: 'Place of power', icon: 'node', score: 60 - k - name.length * 0.1, run: (ap) => ap.select({ kind: 'site', id: n.id }, { focus: true }) });
        if (out.length >= limit) break;
      }
      return out;
    },
  });
  // run-until conditions for worlds that have them (listed only while they make sense)
  let untilOff = [];
  const syncUntil = () => {
    for (const off of untilOff) off();
    untilOff = [];
    const w = app.world;
    if (!w || !(w.params?.mythLevel >= 1)) return;
    const hit = (world, seq, fallback, at) => {
      const e = seq != null ? chronicleEntry(world, seq) : null;
      return { text: e ? e.text : fallback, x: at?.x ?? e?.x ?? 0, y: at?.y ?? e?.y ?? 0, ref: e?.ref || null };
    };
    untilOff.push(registerUntilCondition({
      id: 'myth.tale', label: 'A tale is told', icon: 'folklore', group: 'Myth & Magic', live: true,
      describe: () => 'The next omen, saint or tale of the folk',
      arm: (a) => ({ n: fin(a.world.sys.myth?.folk?.n, 0) }),
      test: (world, st) => {
        const f = world.sys.myth?.folk;
        if (!f || fin(f.n, 0) <= st.n) return null;
        return hit(world, f.lastAt?.seq, 'A new tale was told.', f.lastAt);
      },
    }));
    if (mythic(w)) {
      untilOff.push(registerUntilCondition({
        id: 'myth.miracle', label: 'The gods answer', icon: 'myth', group: 'Myth & Magic', live: true,
        describe: () => 'A god answers the prayers of a town in need',
        arm: (a) => ({ n: fin(a.world.sys.myth?.divine?.n, 0) }),
        test: (world, st) => {
          const d = world.sys.myth?.divine;
          if (!d || fin(d.n, 0) <= st.n) return null;
          return hit(world, d.lastAt?.seq, 'A god answered.', d.lastAt);
        },
      }));
    }
  };
  app.on('world', syncUntil);
  app.on('worldRestored', syncUntil);
  // the moment magic wakes, the belt, the map modes and the conditions change
  app.on('toolApplied', (p) => {
    if (!p || p.id !== 'awaken_magic' || !p.result?.ok || app.world?.cache?.replaying) return;
    app.emit('toolsChanged');
    app.emit('params');
    syncUntil();
  });
}

/** The weave in a word, for the HUD and Legends. */
export const weaveLabel = (w) => (mythic(w) ? `${weaveWord(fin(w.sys.myth.weave, 1))} (${Math.round(100 * fin(w.sys.myth.weave, 1))}%)` : '');
