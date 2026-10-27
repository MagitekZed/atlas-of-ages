// Record views — the Inspector records for the kinds the built-in views do not cover, each
// registered with src/ui/registry.js registerView so a chronicle ref of any kind opens a page:
//   route      a trade road: its ends, value and traffic over time, its fate
//   figure     a great person's life: birthplace, nation, deeds, armies led, faith founded
//   ruler      a reign (id = the ruler's id, or "civId:reignStart"): deeds, temperament, the
//              realm's fortunes during the reign, predecessor and successor
//   dynasty    a house (id = index in sys.civ.dynasties, or "civId:name"): its lineage ladder
//   wonder     builder, city, the ruler who raised it, its fall
//   fire       a great wildfire (live, or from the catastrophe catalogue)
//   site       a historic site: battlefield, siege-ground, ruin, crater, wreck, plague pit…
//   continent  a named continent (id = world.features index): its peoples, cities, faiths, scars
//   event      a catastrophe from the catalogue (quake, wave, eruption, falling star, storm…)
//   compare    two to four nations side by side (id = "a,b,c"; ../compare.js)
// mount(app) also points the map's footprint layer (render/overlays.js) at every selection,
// registers the 'Record footprints' overlay, a search source over sites, catastrophes,
// records and trade roads, and the developer-records toggle.

import { DAYS_PER_YEAR } from '../../core/constants.js';
import { natureWords, WOUND_WORDS, ILLNESSES, AMBITION_WORDS } from '../../core/character.js';
import { SITE_KINDS, getSite } from '../../core/sites.js';
import { h, Binder } from '../dom.js';
import * as F from '../format.js';
import { registerView, registerOverlay, registerCommand, registerSearchSource, registerTitleAction, registerIcon } from '../registry.js';
import {
  section, kv, cells, linkBtn, textNode, civRef, settleRef, rows, chronicleList, entryAbout,
  ledgerChart, siteTitle, siteSub, siteItems, SITE_ICON, rulerName, rulerId, rulerGloss, deedWords, dynastyName, shareBars, colorOf,
} from '../inspector.js';
import { getRecords } from '../../sim/records.js';
import { getEvent, EVENT_TYPES } from '../../sim/catalogue.js';
import { getPref, setPref } from '../prefs.js';

let overlays = null;
try { overlays = await import('../../render/overlays.js'); } catch (e) { /* no footprints on the map */ }
let compareMod = null;
try { compareMod = await import('../compare.js'); } catch (e) { /* no comparisons */ }
let eventsMod = null;
try { eventsMod = await import('../../sim/events/index.js'); } catch (e) { /* world ages unavailable */ }

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const yearOf = (day) => Math.floor(fin(day) / DAYS_PER_YEAR);
const ok = Number.isFinite;

/** Wrap a view body builder: (app, sel, el, b) → nodes; returns the mount handle. */
function mounted(build) {
  return (app, sel, el) => {
    const b = new Binder();
    let nodes;
    try { nodes = build(app, sel, b); } catch (e) { app.reportError('records.view', e); nodes = [h('p.empty-note', { text: `This record could not be shown: ${e.message}` })]; }
    for (const n of [].concat(nodes)) if (n) el.appendChild(n);
    b.update();
    return { update: () => b.update() };
  };
}
const note = (text) => h('p.empty-note', { text });
const lead = (b, fn) => { const p = h('p.ins-lead'); b.text(p, fn); return p; };
/** Records this entity holds in the Hall of Records, as tags. */
function honours(app, b, kind, id) {
  const box = h('div.tags.honours');
  b.list(box, () => {
    const out = [];
    for (const r of getRecords(app.world)) {
      const k = r.top.findIndex((t) => t.r && t.r.k === kind && String(t.r.id) === String(id));
      if (k >= 0) out.push([r.key, r.label, k]);
    }
    return out.sort((a, c) => a[2] - c[2]).slice(0, 6);
  }, ([key, , k]) => key + k, ([, label, k]) => h('span.tag.is-honour', { text: k === 0 ? label : `${F.ordinal(k + 1)} · ${label.toLowerCase()}` }));
  return box;
}

// ---------------------------------------------------------------------------
// route

function routeOf(w, id) { return w.tradeRoutes[id] || null; }
function routeName(w, rt) {
  if (!rt) return 'A trade road';
  if (rt.name) return F.headName(rt.name);
  const a = w.settlements[rt.aId], b = w.settlements[rt.bId];
  return a && b ? `The ${rt.kind === 'sea' ? 'sea lane' : 'road'} from ${a.name} to ${b.name}` : 'A trade road';
}
function routeBox(w, rt) {
  const pts = [];
  if (Array.isArray(rt.path) && rt.path.length) for (let k = 0; k < rt.path.length; k += Math.max(1, rt.path.length >> 5)) pts.push([rt.path[k] % w.W, (rt.path[k] / w.W) | 0]);
  for (const sid of [rt.aId, rt.bId]) { const s = w.settlements[sid]; if (s) pts.push([s.x, s.y]); }
  if (!pts.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0: x0 - 2, y0: y0 - 2, x1: x1 + 2, y1: y1 + 2 };
}

/** "The Standing Stones of X", "the Hanging Gardens": a plural head noun takes 'were'. */
function pluralName(name) {
  const head = String(name || '').split(/\s+of\s+/i)[0].trim().split(/\s+/).pop() || '';
  return /[^s]s$/i.test(head) && !/(ss|us|is)$/i.test(head);
}

const routeView = {
  label: 'Trade road', icon: 'trade',
  describe(app, sel) { const w = app.world, rt = routeOf(w, sel.id); return rt ? { name: routeName(w, rt), icon: rt.kind === 'sea' ? 'ship' : 'road', sub: `${rt.kind === 'sea' ? 'Sea lane' : 'Overland road'} · ${rt.active ? 'in use' : 'abandoned'}` } : { name: 'A lost road' }; },
  point(w, id) { const b = routeOf(w, id) && routeBox(w, routeOf(w, id)); return b ? { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 } : null; },
  frame(w, id) { const rt = routeOf(w, id); return rt ? routeBox(w, rt) : null; },
  rendererSel(w, id) { const rt = routeOf(w, id); const b = rt && routeBox(w, rt); return b ? { kind: 'box', ...b } : null; },
  mount: mounted((app, sel, b) => {
    const w = app.world, rt = routeOf(w, sel.id);
    if (!rt) return note('That road is not in the record.');
    const A = w.settlements[rt.aId], B = w.settlements[rt.bId];
    const lenTiles = Array.isArray(rt.path) && rt.path.length ? rt.path.length : fin(rt.len);
    return [
      lead(b, () => `${rt.kind === 'sea' ? 'A sea lane' : 'A road'} between ${A?.name || 'a lost town'} and ${B?.name || 'a lost town'}, opened in ${F.year(rt.establishedDay)}${rt.active ? `; it carries ${F.num(rt.value, 1)} crowns of goods a month.` : `, abandoned in ${F.year(rt.endDay)}${rt.cause ? ` (${F.humanize(rt.cause).toLowerCase()})` : ''}.`}`),
      honours(app, b, 'route', sel.id),
      cells(b, [
        { k: 'Value', v: () => F.num(rt.value, 1), s: () => 'crowns a month' },
        { k: 'Peak', v: () => F.num(rt.peakValue ?? rt.value, 1), s: () => 'at its busiest' },
        { k: 'Traffic', v: () => F.num(rt.traffic, 1), s: () => 'loads carried' },
      ]),
      section('The road', kv(b, [
        { k: 'From', ref: () => settleRef(app, rt.aId) },
        { k: 'To', ref: () => settleRef(app, rt.bId) },
        { k: 'Realms', ref: () => (rt.civA === rt.civB ? civRef(app, rt.civA) : { key: `r${rt.civA}:${rt.civB}`, make: () => h('span', null, civRef(app, rt.civA).make(), ' · ', civRef(app, rt.civB).make()) }) },
        { k: 'Kind', v: () => (rt.kind === 'sea' ? 'Sea lane' : 'Overland') },
        { k: 'Length', v: () => (lenTiles > 0 ? F.km(lenTiles) : '—') },
        { k: 'Goods match', v: () => (ok(rt.comp) ? `${rt.comp >= 1.4 ? 'Rich' : rt.comp >= 1.15 ? 'Good' : 'Plain'} (×${rt.comp.toFixed(2)})` : '—'), tip: 'How well the two ends’ goods complement each other.' },
        { k: 'Opened', v: () => F.year(rt.establishedDay) },
        { k: 'Closed', v: () => (rt.active ? 'Still in use' : `${F.year(rt.endDay)}${rt.cause ? ' · ' + F.humanize(rt.cause) : ''}`) },
      ])),
      section('History', chronicleList(app, b, (e) => entryAbout(e, 'route', rt.id, (q) => !q.ref && rt.name && (q.text || '').includes(rt.name)))),
    ];
  }),
};

// ---------------------------------------------------------------------------
// figure

function figureOf(w, id) { return w.figures.find((q) => String(q.id) === String(id)) || null; }
const FIG_WORD = { general: 'general', prophet: 'prophet', scholar: 'scholar', artist: 'artist', explorer: 'explorer', merchant: 'merchant', hero: 'hero', ruler: 'ruler' };

const figureView = {
  label: 'Great figure', icon: 'star',
  describe(app, sel) {
    const f = figureOf(app.world, sel.id);
    if (!f) return { name: 'A figure lost to memory' };
    const c = app.world.civs[f.civId];
    return { name: f.name || 'Unknown', sub: `${F.headName(FIG_WORD[f.kind] || f.kind || 'figure')}${c ? ' of ' + c.name : ''} · ${f.born != null ? 'Y' + yearOf(f.born) : '?'}–${f.died != null ? 'Y' + yearOf(f.died) : ''}` };
  },
  point(w, id) {
    const f = figureOf(w, id);
    if (!f) return null;
    const a = w.armies.find((q) => q.flags?.genId === f.id);
    if (a) return { x: a.x, y: a.y };
    const s = w.settlements[f.sid];
    return s ? { x: s.x, y: s.y } : null;
  },
  mount: mounted((app, sel, b) => {
    const w = app.world, f = figureOf(w, sel.id);
    if (!f) return note('This figure has passed out of memory: the world forgets the least of its dead.');
    const c = w.civs[f.civId], home = w.settlements[f.sid];
    const age = () => ((f.died ?? w.time.day) - fin(f.born, w.time.day)) / DAYS_PER_YEAR;
    const deeds = rows(b, () => (Array.isArray(f.deeds) ? f.deeds : []).slice().reverse().map((d, k) => ({ key: k + ':' + d, icon: 'star', label: F.headName(typeof d === 'string' ? d : d?.text || '—') })), 'No deeds are told of them.', app);
    const armies = rows(b, () => w.armies.filter((a) => a.flags?.genId === f.id).map((a) => ({ key: 'a' + a.id, swatch: w.civs[a.civId]?.colorHex, label: `${w.civs[a.civId]?.adjective || ''} ${a.naval ? 'fleet' : 'army'}`, n: F.people(a.strength), s: F.humanize(a.state || ''), sel: { kind: 'army', id: a.id } })), 'Commands no army now.', app);
    const armySec = section('In the field', armies);
    b.hide(armySec, () => f.kind !== 'general' || !w.armies.some((a) => a.flags?.genId === f.id));
    const faiths = rows(b, () => w.religions.filter((r) => r && r.prophetId === f.id).map((r) => ({ key: 'r' + r.id, swatch: r.colorHex || colorOf(r.color), label: F.headName(r.name), n: r.alive === false ? 'died out' : F.people(r.followers), sel: { kind: 'religion', id: r.id } })), '', app);
    const faithSec = section('The faith they founded', faiths);
    b.hide(faithSec, () => !w.religions.some((r) => r && r.prophetId === f.id));
    const wins = () => fin(f.wins) || (Array.isArray(f.deeds) ? f.deeds.filter((d) => typeof d === 'string' && /^won\b/i.test(d)).length : 0);
    return [
      lead(b, () => `${f.name}, ${FIG_WORD[f.kind] ? 'a ' + FIG_WORD[f.kind] : 'a figure'}${c ? ` of ${F.theCiv(c)}` : ''}${home ? `, born at ${home.name}` : ''}${f.born != null ? ` in ${F.year(f.born)}` : ''}. ${f.died != null ? `Died in ${F.year(f.died)}, aged ${Math.max(0, Math.floor(age()))}.` : `Living, aged ${Math.max(0, Math.floor(age()))}.`}`),
      honours(app, b, 'figure', f.id),
      cells(b, [
        { k: f.died != null ? 'Lived' : 'Age', v: () => `${Math.max(0, Math.floor(age()))} yrs` },
        { k: 'Deeds', v: () => F.int((f.deeds || []).length) },
        { k: f.kind === 'general' ? 'Victories' : 'Skill', v: () => (f.kind === 'general' ? F.int(wins()) : ok(f.skill) ? F.pct(Math.min(1, f.skill / 1.5)) : '—') },
      ]),
      section('Life', kv(b, [
        { k: 'Nation', ref: () => civRef(app, f.civId) },
        { k: 'Birthplace', ref: () => settleRef(app, f.sid) },
        { k: 'Calling', v: () => F.headName(FIG_WORD[f.kind] || f.kind || '—') },
        { k: 'Born', v: () => (f.born != null ? F.year(f.born) : 'Unknown') },
        { k: 'Died', v: () => (f.died != null ? F.year(f.died) : 'Living') },
        { k: 'Epithet', v: () => f.epithet || '—', hide: () => !f.epithet },
        { k: f.died != null ? 'Died wanting' : 'Wants', v: () => ambWords(w, f.am, c), txt: true, hide: () => !f.am },
        { k: 'Ambitions', v: () => ambDone(w, f.done, c), txt: true, hide: () => !(f.done && f.done.length) },
      ])),
      section('Deeds', deeds),
      armySec, faithSec,
      section('In the Chronicle', chronicleList(app, b, (e) => entryAbout(e, 'figure', f.id, (q) => !q.ref && f.name && (q.text || '').includes(f.name)))),
    ];
  }),
};

// ---------------------------------------------------------------------------
// ruler

/** Find a ruler by id (number) or "civId:reignStart". → { civ, r, idx (−1 = reigning), list } | null */
export function findRuler(w, id) {
  const str = String(id);
  const m = /^(\d+):(-?\d+)$/.exec(str);
  for (const c of w.civs) {
    if (!c) continue;
    if (m && Number(m[1]) !== c.id) continue;
    const list = Array.isArray(c.rulerHistory) ? c.rulerHistory : [];
    const match = (r) => r && (m ? String(r.reignStart) === m[2] : r.id != null && String(r.id) === str);
    if (c.ruler && match(c.ruler)) return { civ: c, r: c.ruler, idx: -1, list };
    for (let k = 0; k < list.length; k++) if (match(list[k])) return { civ: c, r: list[k], idx: k, list };
  }
  return null;
}

const TP_ROWS = [[0, 'Ambition', 'How much they want: land, glory, a name.'], [1, 'Mercy', 'Low is cruelty: who is spared, who is razed.'], [2, 'Piety', ''], [3, 'Greed', 'High taxes, a hunger for land and gold.'], [4, 'Honour', 'Pacts kept, envoys respected.'], [5, 'Boldness', 'Low is caution.']];
const SK_ROWS = [[0, 'War'], [1, 'Diplomacy'], [2, 'Stewardship'], [3, 'Intrigue'], [4, 'Learning']];
/** "Lost an eye; the wasting sickness; mad from Y812" (core/character.js), or ''. */
function bodyLine(r) {
  const bd = r && r.bd;
  if (!bd) return '';
  const out = (bd.w || []).map((c) => (WOUND_WORDS[c] || c).replace(/^./, (x) => x.toUpperCase()));
  if (bd.ill && ILLNESSES[bd.ill]) out.push(`Suffered ${ILLNESSES[bd.ill]}`);
  if (bd.mad) out.push(`Mad from ${F.year(bd.mad)}`);
  return out.join('; ');
}
/** An ambition in words, from its kind and target (core/character.js AMBITION_WORDS). */
function ambWords(w, am, civ) {
  if (!am || !AMBITION_WORDS[am.k]) return '';
  const s = am.k === 'town' ? w.settlements[am.t] : null, c = am.t != null && am.k !== 'town' ? w.civs[am.t] : null;
  const f = am.k === 'convert' && civ && civ.stateReligion != null ? w.religions[civ.stateReligion] : null;
  const t = AMBITION_WORDS[am.k].replace('{t}', s ? s.name : 'a town').replace('{c}', c ? F.theCiv(c) : 'a neighbour').replace('{f}', f ? f.name : 'the faith').replace('{p}', civ && civ.adjective ? `the ${civ.adjective} people` : 'the people');
  return t.replace(/^./, (x) => x.toUpperCase());
}
const AMB_OUT = { met: 'done', failed: 'given up', gone: 'lost' };
/** "To take Varn (done, Y812); Glory in battle (given up, Y840)", or ''. */
const ambDone = (w, done, civ) => (done || []).map(([k, out, day, t]) => `${ambWords(w, { k, t }, civ)} (${AMB_OUT[out] || out}${ok(day) ? ', ' + F.year(day) : ''})`).join('; ');
const skillWord = (v) => (!Number.isFinite(v) ? '—' : v >= 0.8 ? 'Masterly' : v >= 0.6 ? 'Able' : v >= 0.4 ? 'Fair' : v >= 0.2 ? 'Poor' : 'Hopeless');

const rulerView = {
  label: 'Ruler', icon: 'crown',
  describe(app, sel) {
    const f = findRuler(app.world, sel.id);
    if (!f) return { name: 'A forgotten ruler' };
    const end = f.idx < 0 ? null : f.r.reignEnd ?? f.r.end;
    return { name: rulerName(f.r), sub: `${f.civ.name} · ${F.yearSpan(f.r.reignStart, f.idx < 0 && f.civ.alive ? null : end ?? f.civ.fallenDay)}`, color: f.civ.colorHex };
  },
  point(w, id) { const f = findRuler(w, id); const cap = f && f.civ.capitalId != null ? w.settlements[f.civ.capitalId] : null; return cap ? { x: cap.x, y: cap.y } : f ? { x: f.civ.originX, y: f.civ.originY } : null; },
  mount: mounted((app, sel, b) => {
    const w = app.world, f = findRuler(w, sel.id);
    if (!f) return note('This ruler has passed out of the record.');
    const { civ, r } = f;
    const reigning = f.idx < 0 && civ.alive;
    const end = () => (reigning ? w.time.day : r.reignEnd ?? r.end ?? civ.fallenDay ?? w.time.day);
    const prev = f.idx < 0 ? f.list[f.list.length - 1] : f.list[f.idx - 1];
    const next = f.idx < 0 ? null : f.idx + 1 < f.list.length ? f.list[f.idx + 1] : civ.ruler;
    const link = (q) => (q ? { key: 'q' + rulerName(q) + q.reignStart, make: () => linkBtn(app, { kind: 'ruler', id: rulerId(civ, q) }, rulerName(q), { tipText: rulerGloss(q, civ) }) } : { key: 'none', make: () => textNode('—') });
    const span = () => end() - fin(r.reignStart, end());
    return [
      lead(b, () => `${rulerName(r)} ${reigning ? 'rules' : 'ruled'} ${F.theCiv(civ)}${ok(r.reignStart) ? ` from ${F.year(r.reignStart)}` : ''}${reigning ? '' : ` to ${F.year(end())}`}, ${F.span(span())}${r.relation && r.relation !== 'founder' ? `, coming to the throne as ${r.relation === 'usurper' ? 'a usurper' : r.relation === 'elected' ? 'the elected choice' : `the ${r.relation} of the last ruler`}` : ''}.${!reigning && (r.cause || r.endCause) ? ` The reign ended: ${F.humanize(r.cause || r.endCause).toLowerCase()}.` : ''}`),
      honours(app, b, 'ruler', sel.id),
      cells(b, [
        { k: 'Reign', v: () => F.span(span()) },
        { k: 'Born', v: () => (ok(r.born) ? F.year(r.born) : '—') },
        { k: 'Age at the end', v: () => (ok(r.born) ? `${Math.floor((end() - r.born) / DAYS_PER_YEAR)} yrs` : '—') },
      ]),
      section('The realm in this reign', ledgerChart(app, b, 'c', civ.id, { color: civ.colorHex, channels: ['pop', 'land', 'towns', 'treasury', 'stability'], prefSuffix: 'reign', window: () => [fin(r.reignStart) - 10 * DAYS_PER_YEAR, end() + 10 * DAYS_PER_YEAR], live: () => reigning, marks: () => [{ day: r.reignStart, color: 'var(--brass)', label: 'Came to the throne' }].concat(reigning ? [] : [{ day: end(), color: 'var(--ink-3)', label: 'The reign ended' }]) })),
      section('The ruler', kv(b, [
        { k: 'Realm', ref: () => civRef(app, civ.id) },
        { k: 'Title', v: () => r.title || '—' },
        { k: 'By-name', v: () => (r.gloss ? `${r.epithet} · “${r.gloss}” in ${civ.adjective ? `the ${civ.adjective}` : 'their own'} tongue` : r.epithet || '—'), txt: true, hide: () => !r.epithet },
        { k: 'Temperament', v: () => (r.traits?.length ? r.traits.map(F.humanize).join(', ') : '—'), txt: true },
        { k: 'Nature', v: () => natureWords(r, civ, 3).join(', ') || 'Even-tempered', txt: true, hide: () => !Array.isArray(r.tp) },
        { k: 'Body', v: () => bodyLine(r), txt: true, hide: () => !bodyLine(r) },
        { k: reigning ? 'Wants' : 'Died wanting', v: () => ambWords(w, r.am, civ), txt: true, hide: () => !r.am },
        { k: 'Ambitions', v: () => ambDone(w, r.done, civ), txt: true, hide: () => !(r.done && r.done.length) },
        { k: 'The heir', v: () => `${r.heir.name}, who covets the throne`, txt: true, hide: () => !(reigning && r.heir && r.heir.am && r.heir.am.k === 'throne') },
        { k: 'Deeds', v: () => deedWords(r.deeds) || 'None remembered', txt: true },
        { k: 'Dynasty', ref: () => { const d = dynastyName(r.dynasty); return d ? { key: 'd' + d, make: () => linkBtn(app, { kind: 'dynasty', id: `${civ.id}:${d}` }, d) } : { key: 'none', make: () => textNode('—') }; } },
        { k: 'Came as', v: () => (r.relation ? F.headName(r.relation) : '—'), hide: () => !r.relation },
        { k: 'Before', ref: () => link(prev) },
        { k: 'After', ref: () => link(next), hide: () => reigning },
      ])),
      // temperament and skills (core/character.js), kept while the ruler lives
      (() => { const sec = section('Character', kv(b, TP_ROWS.map(([k, label, tip]) => ({ k: label, v: () => F.pct(r.tp?.[k] ?? 0), m: () => r.tp?.[k] ?? 0, tip })).concat(
        SK_ROWS.map(([k, label]) => ({ k: label, v: () => skillWord(r.sk?.[k]), m: () => r.sk?.[k] ?? 0, mc: 'is-teal', hide: () => !Array.isArray(r.sk) }))))); b.hide(sec, () => !Array.isArray(r.tp)); return sec; })(),
      section('In the Chronicle', chronicleList(app, b, (e) => (e.ref && e.ref.k === 'ruler' && String(e.ref.id) === String(sel.id)) || (e.civId === civ.id && e.day >= fin(r.reignStart) && e.day <= end() && e.imp >= 2 && (e.cat === 'civ' || e.cat === 'war')), 14)),
    ];
  }),
};

// ---------------------------------------------------------------------------
// dynasty

/** Resolve a dynasty id: index in sys.civ.dynasties, or "civId:name". → { name, civ, rulers: [ruler], start, end, endCause } */
export function findDynasty(w, id) {
  const list = w.sys?.civ?.dynasties;
  let civ = null, name = null, rec = null;
  if (typeof id === 'number' || /^\d+$/.test(String(id))) {
    rec = Array.isArray(list) ? list[Number(id)] : null;
    if (!rec) return null;
    civ = w.civs[rec.civId]; name = rec.name;
  } else {
    const k = String(id).indexOf(':');
    if (k < 0) return null;
    civ = w.civs[Number(String(id).slice(0, k))]; name = String(id).slice(k + 1);
    if (Array.isArray(list)) rec = list.find((d) => d && d.civId === civ?.id && d.name === name) || null;
  }
  if (!civ) return null;
  const all = [...(civ.rulerHistory || []), ...(civ.ruler ? [civ.ruler] : [])];
  const rulers = all.filter((r) => dynastyName(r.dynasty) === name);
  const start = rec?.start ?? (rulers[0]?.reignStart ?? null);
  const living = civ.alive && dynastyName(civ.ruler?.dynasty) === name;
  const end = living ? null : rec?.end ?? (rulers.length ? rulers[rulers.length - 1].reignEnd ?? civ.fallenDay : null);
  return { name, civ, rulers, start, end, endCause: rec?.endCause || null, count: fin(rec?.rulers?.length ?? rec?.rulers, rulers.length) || rulers.length, living };
}

const dynastyView = {
  label: 'Dynasty', icon: 'crown',
  describe(app, sel) { const d = findDynasty(app.world, sel.id); return d ? { name: d.name, sub: `${d.civ.name} · ${F.yearSpan(d.start, d.end)}`, color: d.civ.colorHex } : { name: 'A forgotten house' }; },
  point(w, id) { const d = findDynasty(w, id); const cap = d && d.civ.capitalId != null ? w.settlements[d.civ.capitalId] : null; return cap ? { x: cap.x, y: cap.y } : null; },
  mount: mounted((app, sel, b) => {
    const w = app.world, d = findDynasty(w, sel.id);
    if (!d) return note('This house is not in the record.');
    const ladder = h('ol.lineage');
    b.list(ladder, () => d.rulers.slice().reverse(), (r) => rulerName(r) + r.reignStart, (r) => {
      const end = r === d.civ.ruler && d.civ.alive ? null : r.reignEnd ?? r.end;
      const li = h('li', null,
        h('span.rel', { text: r.relation ? F.headName(r.relation) : '' }),
        linkBtn(app, { kind: 'ruler', id: rulerId(d.civ, r) }, rulerName(r), { tipText: rulerGloss(r, d.civ) }),
        h('span.yrs', { text: `${F.yearSpan(r.reignStart, end)}${ok(r.reignStart) && ok(end) ? ' · ' + F.span(end - r.reignStart) : ''}` }));
      return li;
    });
    const span = () => fin(d.end, w.time.day) - fin(d.start, w.time.day);
    return [
      lead(b, () => `${d.name} ${d.living ? 'has held' : 'held'} the throne of ${F.theCiv(d.civ)} ${ok(d.start) ? `since ${F.year(d.start)}` : ''}${d.living ? '' : ` until ${F.year(d.end)}`}: ${F.span(span())} and ${F.int(d.count)} ${d.count === 1 ? 'ruler' : 'rulers'} remembered.${d.endCause ? ` It ended in ${F.humanize(d.endCause).toLowerCase()}.` : ''}`),
      honours(app, b, 'dynasty', sel.id),
      cells(b, [
        { k: 'Held power', v: () => F.span(span()) },
        { k: 'Rulers', v: () => F.int(d.count) },
        { k: 'Realm', v: () => d.civ.name },
      ]),
      section('Lineage', d.rulers.length ? ladder : note('No ruler of this house is remembered by name.')),
    ];
  }),
};

// ---------------------------------------------------------------------------
// wonder

function wonderOf(w, id) { return w.wonders.find((q) => String(q.id) === String(id)) || null; }
function rulerAt(civ, day) {
  if (!civ) return null;
  const all = [...(civ.rulerHistory || []), ...(civ.ruler ? [civ.ruler] : [])];
  for (let k = all.length - 1; k >= 0; k--) { const r = all[k]; if (fin(r.reignStart, Infinity) <= day && fin(r.reignEnd ?? r.end, Infinity) >= day) return r; }
  return null;
}

const wonderView = {
  label: 'Wonder', icon: 'wonder',
  describe(app, sel) { const q = wonderOf(app.world, sel.id); return q ? { name: q.name, sub: `${F.humanize(q.kind || 'wonder')} · ${q.destroyedDay != null ? 'ruined' : 'standing'}` } : { name: 'A lost wonder' }; },
  point(w, id) { const q = wonderOf(w, id); if (!q) return null; if (ok(q.i)) return { x: q.i % w.W, y: (q.i / w.W) | 0 }; const s = w.settlements[q.sid]; return s ? { x: s.x, y: s.y } : null; },
  mount: mounted((app, sel, b) => {
    const w = app.world, q = wonderOf(w, sel.id);
    if (!q) return note('That wonder is not in the record.');
    const civ = w.civs[q.civId], s = w.settlements[q.sid];
    const ruler = rulerAt(civ, q.builtDay);
    return [
      lead(b, () => { const pl = pluralName(q.name); return `${F.headName(q.name)} ${pl ? 'were' : 'was'} raised at ${s?.name || 'a lost city'}${civ ? ` by ${F.theCiv(civ)}` : ''} in ${F.year(q.builtDay)}${ruler ? `, in the reign of ${rulerName(ruler)}` : ''}. ${q.destroyedDay != null ? `${pl ? 'They were' : 'It was'} destroyed in ${F.year(q.destroyedDay)}.` : `${pl ? 'They have' : 'It has'} stood for ${F.span(w.time.day - q.builtDay)}.`}`; }),
      section('The wonder', kv(b, [
        { k: 'Kind', v: () => F.humanize(q.kind || 'wonder') },
        { k: 'City', ref: () => settleRef(app, q.sid) },
        { k: 'Builders', ref: () => civRef(app, q.civId) },
        { k: 'Ruler', ref: () => (ruler ? { key: 'r' + rulerName(ruler), make: () => linkBtn(app, { kind: 'ruler', id: rulerId(civ, ruler) }, rulerName(ruler)) } : { key: 'none', make: () => textNode('—') }) },
        { k: 'City now held by', ref: () => civRef(app, s?.civId), hide: () => !s || s.civId === q.civId },
        { k: 'Built', v: () => F.year(q.builtDay) },
        { k: 'Destroyed', v: () => (q.destroyedDay != null ? F.year(q.destroyedDay) : 'Still standing') },
      ])),
      section('In the Chronicle', chronicleList(app, b, (e) => entryAbout(e, 'wonder', q.id, (x) => !x.ref && (x.text || '').includes(q.name)))),
    ];
  }),
};

// ---------------------------------------------------------------------------
// fire

function fireOf(w, id) {
  const live = (w.fires || []).find((q) => String(q.id) === String(id));
  if (live) return { fire: live, ev: null };
  const ev = (w.history?.events || []).find((e) => e.t === 'fire' && e.ref && String(e.ref.id) === String(id));
  return ev ? { fire: null, ev } : null;
}

const fireView = {
  label: 'Wildfire', icon: 'wildfire',
  describe(app, sel) { const f = fireOf(app.world, sel.id); if (!f) return { name: 'A forgotten fire' }; const n = f.fire?.name || f.ev?.n; const tiles = f.fire?.tiles ?? f.ev?.m; return { name: n || 'A great fire', sub: `${F.areaShort(tiles)} burned · ${F.year(f.fire?.startDay ?? f.ev?.d)}` }; },
  point(w, id) { const f = fireOf(w, id); return f ? { x: f.fire?.x ?? f.ev.x, y: f.fire?.y ?? f.ev.y } : null; },
  mount: mounted((app, sel, b) => {
    const w = app.world, f = fireOf(w, sel.id);
    if (!f) return note('That fire is no longer remembered.');
    const fire = f.fire, ev = f.ev;
    const tiles = () => fire?.tiles ?? ev?.m;
    return [
      lead(b, () => `${F.headName(fire?.name || ev?.n || 'The fire')} ${fire?.active ? 'is burning' : 'burned'} across ${F.area(tiles())}${fire?.cause ? `, kindled by ${fire.cause === 'lightning' ? 'lightning' : fire.cause === 'heat' ? 'the heat of a dry season' : F.humanize(fire.cause).toLowerCase()}` : ''}.`),
      honours(app, b, 'fire', sel.id),
      cells(b, [
        { k: 'Burned', v: () => F.areaShort(tiles()) },
        { k: 'Began', v: () => F.year(fire?.startDay ?? ev?.d) },
        { k: 'Lasted', v: () => (fire && fire.endDay != null ? F.span(fire.endDay - fire.startDay) : fire?.active ? 'burning' : '—') },
      ]),
      section('Towns touched', rows(b, () => (ev?.towns || []).map((sid) => w.settlements[sid]).filter(Boolean).map((s) => ({ key: 's' + s.id, icon: 'town', label: s.name, sel: { kind: 'settlement', id: s.id } })), 'No town was touched.', app)),
      section('In the Chronicle', chronicleList(app, b, (e) => entryAbout(e, 'fire', Number(sel.id), (x) => !x.ref && (fire?.name || ev?.n) && (x.text || '').includes(fire?.name || ev?.n)))),
    ];
  }),
};

// ---------------------------------------------------------------------------
// site

const RUIN_CAUSE = { razed: 'razed by its conquerors', abandoned: 'abandoned', lava: 'buried under lava', sea: 'swallowed by the sea', meteor: 'struck from the sky', earthquake: 'thrown down by the earth', ruin: 'brought to ruin', famine: 'emptied by famine', plague: 'emptied by plague' };

function siteLead(w, s) {
  const d = s.data || {};
  const span = s.firstDay === s.lastDay ? `in ${F.year(s.firstDay)}` : `between ${F.year(s.firstDay)} and ${F.year(s.lastDay)}`;
  switch (s.kind) {
    case 'battle': return `${s.n === 1 ? 'A battle was' : `${F.int(s.n)} battles were`} fought here ${span}; ${F.people(s.dead)} fell.${d.big ? ` The worst day of it cost ${F.people(d.big)}.` : ''}`;
    case 'siege': { const o = d.o || {}; const parts = Object.entries(o).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k === 'captured' ? 'ended in its fall' : k === 'razed' ? 'ended in fire' : k === 'lifted' ? 'were lifted' : 'were broken'}`); return `${s.name || 'This town'} was besieged ${s.n === 1 ? 'once' : `${F.int(s.n)} times`} ${span}${parts.length ? `: ${F.listing(parts)}` : ''}.${d.days ? ` The longest siege lasted ${F.span(d.days)}.` : ''}`; }
    case 'ruin': { const civ = w.civs[d.civId]; const age = (w.time.day - fin(d.fellDay, s.lastDay)) / DAYS_PER_YEAR; return `${age >= 300 ? 'Ancient' : 'The ruins of'} ${s.name || 'a town'}: once a ${F.tierName(d.maxTier).toLowerCase()} of ${F.people(d.peak)}${civ ? ` of ${F.theCiv(civ)}` : ''}, ${RUIN_CAUSE[d.cause] || F.humanize(d.cause || 'abandoned').toLowerCase()} in ${F.year(d.fellDay)}.${age >= 1 ? ` Its stones have lain ${F.span(age * DAYS_PER_YEAR)}.` : ''}`; }
    case 'crater': return `A star fell here in ${F.year(s.firstDay)}, leaving a crater ${F.km(fin(d.r) * 2)} across${s.dead ? ` and ${F.people(s.dead)} dead` : ''}.`;
    case 'eruption': return `${s.name || 'The mountain'} poured out its fire here ${span}${d.vei ? `, the greatest blast of force ${d.vei}` : ''}${s.dead ? `; ${F.people(s.dead)} died` : ''}.`;
    case 'quake': return `The earth tore open here ${span}${d.mag ? `, a quake of magnitude ${d.mag}` : ''}${s.dead ? `, killing ${F.people(s.dead)}` : ''}.`;
    case 'wreck': return `Ships went down here ${span}${d.cause === 'storm' ? ' in a great storm' : d.cause === 'raid' ? ' to pirates' : ' in battle'}${s.dead ? `; ${F.people(s.dead)} drowned` : ''}.`;
    case 'plaguepit': return `The dead of ${s.name || 'this town'} were buried here${d.frac ? `: ${F.pct(d.frac)} of its people` : ''}${s.dead ? `, ${F.people(s.dead)} souls` : ''}.`;
    case 'treaty': return `Peace was made at ${s.name || 'this place'} ${s.n === 1 ? 'once' : `${F.int(s.n)} times`} ${span}.`;
    case 'holy': return `${s.name || 'This city'} is holy ground, where a faith was first revealed in ${F.year(s.firstDay)}.`;
    case 'node': return `${F.headName(s.name || 'A ley node')}, where the lines of power cross.`;
    case 'lair': return `${F.headName(s.name || 'A lair')}, the den of a beast.`;
    default: return `${F.headName(s.name || 'A place')} remembered since ${F.year(s.firstDay)}.`;
  }
}

const siteView = {
  label: 'Historic site', icon: 'pin',
  describe(app, sel) { const s = getSite(app.world, Number(sel.id)); return s ? { name: siteTitle(app.world, s), sub: siteSub(app.world, s) } : { name: 'A forgotten place' }; },
  point(w, id) { const s = getSite(w, Number(id)); return s ? { x: s.x, y: s.y } : null; },
  mount: mounted((app, sel, b) => {
    const w = app.world, s = getSite(w, Number(sel.id));
    if (!s) return note('The land has forgotten this place: only the greatest sites are remembered for ever.');
    const d = s.data || {};
    const civs = h('div.tags');
    b.list(civs, () => (s.civIds || []).filter((id) => w.civs[id]), (id) => id, (id) => h('span.tag.is-link', null, linkBtn(app, { kind: 'civ', id }, w.civs[id].name, { swatch: w.civs[id].colorHex })));
    const parts = [lead(b, () => siteLead(w, s))];
    parts.push(cells(b, [
      { k: s.kind === 'battle' ? 'Battles' : s.kind === 'siege' ? 'Sieges' : 'Events', v: () => F.int(s.n) },
      { k: 'Dead', v: () => F.people(s.dead) },
      { k: 'Fame', v: () => F.num(s.fame, 1), s: () => (s.pinned ? 'remembered for ever' : '') },
    ]));
    const refRow = s.ref && s.ref.k ? { k: 'Belongs to', ref: () => ({ key: 'ref' + s.ref.k + s.ref.id, make: () => linkBtn(app, { kind: s.ref.k, id: s.ref.id }, refLabel(w, s.ref)) }) } : null;
    parts.push(section('The place', kv(b, [
      { k: 'Kind', v: () => SITE_KINDS[s.kind]?.label || F.humanize(s.kind) },
      refRow,
      { k: 'First', v: () => F.monthYear(s.firstDay) },
      { k: 'Last', v: () => F.monthYear(s.lastDay), hide: () => s.lastDay === s.firstDay },
      { k: 'Location', v: () => F.latLon(w, s.x, s.y) },
    ].filter(Boolean)), civs));
    if (s.kind === 'battle') {
      if (Array.isArray(d.names) && d.names.length) parts.push(section('Battles fought here', rows(b, () => d.names.slice().reverse().map((n, k) => ({ key: k + n, icon: 'war', label: F.headName(n) })), '', app)));
      const tally = shareBars(b, () => {
        const wins = Object.entries(d.w || {});
        const tot = wins.reduce((a, [, n]) => a + n, 0);
        return tot ? wins.sort((p, q) => q[1] - p[1]).map(([id, n]) => ({ key: 'w' + id, label: w.civs[id]?.name || 'Unknown', color: w.civs[id]?.colorHex || 'var(--ink-3)', value: n / tot, text: `${n} won`, sel: { kind: 'civ', id: Number(id) } })) : [];
      }, app);
      parts.push(section('Victories', tally));
    }
    if (s.kind === 'ruin') {
      const blds = Object.entries(d.buildings || {}).filter(([, lv]) => lv > 0);
      parts.push(section('What stood here', kv(b, [
        { k: 'Town', ref: () => settleRef(app, d.sid) },
        { k: 'At its height', v: () => `${F.people(d.peak)} · ${F.tierName(d.maxTier)}` },
        { k: 'Last held by', ref: () => civRef(app, d.civId) },
        { k: 'Founded by', ref: () => civRef(app, d.originCivId), hide: () => d.originCivId == null || d.originCivId === d.civId },
        { k: 'Fell', v: () => `${F.year(d.fellDay)} · ${F.headName(RUIN_CAUSE[d.cause] || F.humanize(d.cause || 'abandoned'))}` },
        // what came after the fall (events ruins.js writes): resettled, looted, excavated
        { k: 'Resettled', ref: () => ({ key: 'rs' + d.resettledBy, make: () => h('span', null, w.settlements[d.resettledBy] ? linkBtn(app, { kind: 'settlement', id: d.resettledBy }, w.settlements[d.resettledBy].name) : 'by new settlers', ok(d.resettledDay) ? ` · ${F.year(d.resettledDay)}` : '') }), hide: () => d.resettledBy == null },
        { k: 'Looted', ref: () => ({ key: 'lt' + d.lootedBy, make: () => h('span', null, w.settlements[d.lootedBy] ? linkBtn(app, { kind: 'settlement', id: d.lootedBy }, `from ${w.settlements[d.lootedBy].name}`) : 'by treasure-seekers', ok(d.looted) ? ` · ${F.year(d.looted)}` : '') }), hide: () => d.looted == null },
        { k: 'Excavated', ref: () => ({ key: 'ex' + d.excavatedBy, make: () => h('span', null, w.settlements[d.excavatedBy] ? linkBtn(app, { kind: 'settlement', id: d.excavatedBy }, `by ${w.settlements[d.excavatedBy].name}`) : 'by scholars', ok(d.excavated) ? ` · ${F.year(d.excavated)}` : '') }), hide: () => d.excavated == null },
        { k: 'Lost art recovered', v: () => F.humanize(d.lostTech || ''), hide: () => !d.lostTech },
        ...Object.entries(d).filter(([k, v]) => !['peak', 'maxTier', 'buildings', 'civId', 'originCivId', 'wonderIds', 'cause', 'fellDay', 'sid', 'resettledBy', 'resettledDay', 'looted', 'lootedBy', 'excavated', 'excavatedBy', 'lostTech'].includes(k) && (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean')).map(([k, v]) => ({ k: F.humanize(k), v: () => (typeof v === 'number' && v > 1000 && /day/i.test(k) ? F.year(v) : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v)) })),
      ]), blds.length ? h('div.tags', null, blds.map(([k, lv]) => h('span.tag', { text: `${F.humanize(k)}${lv > 1 ? ' · ' + lv : ''}` }))) : null,
      rows(b, () => (d.wonderIds || []).map((id) => w.wonders.find((q) => q.id === id)).filter(Boolean).map((q) => ({ key: 'wd' + q.id, icon: 'wonder', label: F.headName(q.name), sel: { kind: 'wonder', id: q.id } })), '', app)));
    }
    parts.push(section('Nearby', rows(b, () => siteItems(app, s.x, s.y, 3).filter((it) => it.sel.id !== s.id), 'Nothing else is remembered nearby.', app)));
    parts.push(section('What the Chronicle says of this place', chronicleList(app, b, (e) => (e.ref && s.ref && e.ref.k === s.ref.k && e.ref.id === s.ref.id && e.x != null && Math.hypot(e.x - s.x, e.y - s.y) <= 2.5) || (e.x != null && e.y != null && Math.hypot(e.x - s.x, e.y - s.y) <= 2 && e.day >= s.firstDay - 30 && e.day <= s.lastDay + 60 && e.imp >= 2), 14)));
    return parts;
  }),
};

function refLabel(w, ref) {
  switch (ref.k) {
    case 'war': return F.headName(w.wars[ref.id]?.name || 'a war');
    case 'settlement': return w.settlements[ref.id]?.name || 'a town';
    case 'civ': return w.civs[ref.id]?.name || 'a nation';
    case 'religion': return F.headName(w.religions[ref.id]?.name || 'a faith');
    case 'plague': return F.headName(w.plagues[ref.id]?.name || 'a plague');
    case 'volcano': return w.volcanoes.find((v) => v.id === ref.id)?.name || 'a volcano';
    case 'band': return (w.bands || []).find((x) => x.id === ref.id)?.name || 'a band';
    case 'storm': return 'the storm';
    default: return F.humanize(ref.k);
  }
}

// ---------------------------------------------------------------------------
// continent

function continentSurvey(w, k) {
  const ft = w.features[k];
  if (!ft || ft.kind !== 'continent') return null;
  const key = `${k}:${Math.floor(w.time.day / 30)}:${w.versions.owner}:${w.versions.water}`;
  if (continentSurvey.cache?.key === key) return continentSurvey.cache.val;
  const f = w.f, W = w.W;
  const fi = Math.round(ft.y) * W + Math.round(ft.x);
  const lm = f.landmass[fi];
  let tiles = 0, land = 0, owned = 0, forest = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const holders = new Map();
  for (let i = 0; i < w.N; i++) {
    if (f.water[i] !== WATER_LAND) continue;
    land++;
    if (f.landmass[i] !== lm) continue;
    tiles++;
    const x = i % W, y = (i / W) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (f.veg[i] > 0.5) forest++;
    const o = f.owner[i];
    if (o >= 0) { owned++; holders.set(o, (holders.get(o) || 0) + 1); }
  }
  const towns = w.settlements.filter((s) => s && s.alive && f.landmass[s.i] === lm);
  const ruins = w.settlements.filter((s) => s && !s.alive && f.landmass[s.i] === lm).length;
  const faith = new Map();
  let pop = 0;
  for (const s of towns) { pop += fin(s.population); for (const [rid, sh] of Object.entries(s.religion || {})) faith.set(rid, (faith.get(rid) || 0) + sh * s.population); }
  const val = { ft, lm, tiles, land, owned, forest, holders, towns, ruins, faith, pop, box: { x0, y0, x1, y1 } };
  continentSurvey.cache = { key, val };
  return val;
}
const WATER_LAND = 0;

const continentView = {
  label: 'Continent', icon: 'atlas',
  describe(app, sel) { const ft = app.world.features[sel.id]; return ft ? { name: ft.name, sub: 'Continent' } : { name: 'An unnamed land' }; },
  point(w, id) { const ft = w.features[id]; return ft ? { x: ft.x, y: ft.y } : null; },
  frame(w, id) { const s = continentSurvey(w, Number(id)); return s ? s.box : null; },
  rendererSel(w, id) { const s = continentSurvey(w, Number(id)); return s ? { kind: 'box', ...s.box } : null; },
  mount: mounted((app, sel, b) => {
    const w = app.world;
    const S = () => continentSurvey(w, Number(sel.id));
    if (!S()) return note('That land is not in the record.');
    const peoples = shareBars(b, () => {
      const s = S();
      if (!s || !s.tiles) return [];
      const out = [...s.holders.entries()].sort((a, c) => c[1] - a[1]).slice(0, 8).map(([id, n]) => ({ key: 'h' + id, label: w.civs[id]?.name || 'Unknown', color: w.civs[id]?.colorHex || 'var(--ink-3)', value: n / s.tiles, text: F.pct(n / s.tiles), sel: { kind: 'civ', id } }));
      if (s.tiles > s.owned) out.push({ key: 'wild', label: 'Unclaimed wilds', color: 'var(--ink-4)', value: (s.tiles - s.owned) / s.tiles, text: F.pct((s.tiles - s.owned) / s.tiles) });
      return out;
    }, app);
    const faiths = shareBars(b, () => {
      const s = S();
      if (!s || !(s.pop > 0)) return [];
      return [...s.faith.entries()].sort((a, c) => c[1] - a[1]).slice(0, 4).map(([rid, n]) => { const r = w.religions[rid]; return { key: 'r' + rid, label: r ? F.headName(r.name) : 'Folk beliefs', color: r?.colorHex || 'var(--ink-4)', value: n / s.pop, text: F.pct(n / s.pop), sel: r ? { kind: 'religion', id: r.id } : null }; });
    }, app);
    const cities = rows(b, () => S().towns.slice().sort((a, c) => c.population - a.population).slice(0, 8).map((s) => ({ key: s.id + ':' + s.tier, icon: 'town', label: s.name, n: F.people(s.population), s: `${F.tierName(s.tier)} of ${w.civs[s.civId]?.name || '—'}`, sel: { kind: 'settlement', id: s.id } })), 'No town stands on it.', app);
    const scars = rows(b, () => {
      const s = S();
      const out = [];
      for (const site of w.sites) if (w.f.landmass[site.i] === s.lm && (site.kind === 'battle' || site.kind === 'crater' || site.kind === 'eruption' || site.kind === 'quake' || site.kind === 'ruin')) out.push(site);
      return out.sort((p, q) => (q.fame || 0) - (p.fame || 0)).slice(0, 10).map((site) => ({ key: 'st' + site.id + ':' + site.n, icon: SITE_ICON[site.kind] || 'pin', label: siteTitle(w, site), n: site.dead > 0 ? F.people(site.dead) + ' dead' : '', s: siteSub(w, site), sel: { kind: 'site', id: site.id } }));
    }, 'No great battle or catastrophe has marked it.', app);
    const fury = rows(b, () => {
      const s = S();
      return (w.history?.events || []).filter((e) => { const i = Math.round(e.y) * w.W + Math.round(e.x); return i >= 0 && i < w.N && w.f.landmass[i] === s.lm; }).sort((p, q) => q.dead - p.dead || q.m - p.m).slice(0, 8).map((e) => eventItem(w, e));
    }, 'No great catastrophe is catalogued here.', app);
    return [
      lead(b, () => { const s = S(); const top = [...s.holders.entries()].sort((a, c) => c[1] - a[1])[0]; return `${s.ft.name} covers ${F.area(s.tiles)}, ${F.pct(s.tiles / Math.max(1, s.land))} of the world’s land. ${F.people(s.pop)} people live in its ${F.int(s.towns.length)} settlements${top ? `; ${F.theCiv(w.civs[top[0]])} holds the most of it` : ''}.${s.ruins ? ` ${F.int(s.ruins)} towns lie in ruins.` : ''}`; }),
      cells(b, [
        { k: 'Area', v: () => F.areaShort(S().tiles) },
        { k: 'People', v: () => F.people(S().pop), s: () => `${S().towns.length} settlements` },
        { k: 'Forest', v: () => F.pct(S().forest / Math.max(1, S().tiles)), s: () => `${F.pct(S().owned / Math.max(1, S().tiles))} claimed` },
      ]),
      section('Who holds it', peoples),
      section('Faiths', faiths),
      section('Greatest cities', cities),
      section('Scars of history', scars),
      section('Nature’s fury', fury),
    ];
  }),
};

// ---------------------------------------------------------------------------
// event (catastrophe catalogue)

const EV_ICON = { quake: 'quake', tsunami: 'tsunami', eruption: 'volcano', impact: 'meteor', flood: 'flood', storm: 'storm', fire: 'wildfire', famine: 'drought', locusts: 'locusts' };
export function eventTitle(e) {
  if (e.n) return F.headName(e.n);
  const t = EVENT_TYPES[e.t]?.label || F.humanize(e.t);
  return `${t} of Year ${yearOf(e.d)}`;
}
export function eventMagnitude(e) {
  switch (e.t) {
    case 'quake': return F.magWord(e.m);
    case 'eruption': return F.veiWord(e.m);
    case 'impact': return `${F.km(e.m * 2)} crater`;
    case 'storm': return F.stormClass(e.k, e.m);
    case 'fire': return F.areaShort(e.m) + ' burned';
    case 'tsunami': return `wave ${F.pct(e.m)}`;
    case 'famine': return e.mo ? `${e.mo} months of hunger` : 'famine';
    case 'flood': return `${F.int(e.m)} towns flooded`;
    case 'locusts': return `${F.num(e.m, 0)} food eaten`;
    default: return F.num(e.m, 1);
  }
}
export function eventItem(w, e) {
  return { key: 'ev' + e.id, icon: EV_ICON[e.t] || 'disaster', label: eventTitle(e), n: e.dead ? F.people(e.dead) + ' dead' : '', s: `${eventMagnitude(e)} · ${F.monthYear(e.d)}`, sel: e.t === 'storm' && e.sid != null ? { kind: 'storm', id: e.sid } : e.t === 'fire' && e.ref ? { kind: 'fire', id: e.ref.id } : { kind: 'event', id: e.id } };
}
function eventLead(w, e) {
  const where = (() => { const s = (e.towns || []).map((sid) => w.settlements[sid]).filter(Boolean); return s.length ? ` ${e.t === 'famine' ? 'in' : 'striking'} ${F.listing(s.map((q) => q.name), 3)}` : ''; })();
  const dead = e.dead ? `; ${F.people(e.dead)} died` : '';
  const when = F.monthYear(e.d);
  switch (e.t) {
    case 'quake': return `In ${when} the earth shook with a quake of magnitude ${fin(e.m).toFixed(1)}${e.u ? ' beneath the sea' : ''}${where}${dead}.`;
    case 'tsunami': return `A great wave rose in ${when}${where}${dead}.`;
    case 'eruption': return `${F.headName(e.n || 'A mountain')} erupted in ${when} with a blast of VEI ${Math.round(e.m)}${where}${dead}.`;
    case 'impact': return `A star fell ${e.o ? 'into the sea' : 'to earth'} in ${when}, ${e.o ? 'raising a mountain of water' : `gouging a crater ${F.km(e.m * 2)} across`}${where}${dead}.`;
    case 'flood': return `The rivers burst their banks in ${when}${where}${dead}.`;
    case 'storm': return `${F.headName(e.n || 'A storm')}, a ${F.stormClass(e.k, e.m).toLowerCase()}, blew itself out in ${when}${e.lf ? ` after ${e.lf} landfall${e.lf === 1 ? '' : 's'}` : ''}${dead}.`;
    case 'fire': return `${F.headName(e.n || 'A great fire')} burned ${F.area(e.m)} in ${when}${where}${dead}.`;
    case 'famine': return `Hunger came to ${w.settlements[e.towns?.[0]]?.name || 'the land'} in ${when}${e.mo ? ` and lasted ${e.mo} months` : ''}${dead}.`;
    case 'locusts': return `A swarm of locusts darkened the sky in ${when}, eating ${F.num(e.m, 0)} of food.`;
    default: return `${eventTitle(e)}, ${when}${dead}.`;
  }
}

/**
 * A world event that is not a catalogued catastrophe: the event deck's world ages ("age:<key>")
 * and black swans ("swan:<kind>:<year>") share the 'event' ref kind with string ids. Its record
 * is what the Chronicle says of it, plus the age's span when the ages export is there.
 */
function worldEvent(w, id) {
  const sid = String(id);
  const entries = w.chronicle.entries.filter((e) => e.ref && e.ref.k === 'event' && String(e.ref.id) === sid);
  let title = null, sub = '', desc = '', from = entries[0]?.day ?? null, to = null;
  const age = /^age:(.+)$/.exec(sid);
  if (age) {
    let hist = [];
    try { hist = eventsMod?.agesHistory ? eventsMod.agesHistory(w) || [] : []; } catch (e) { hist = []; }
    const runs = hist.filter((x) => x.key === age[1]);
    const run = runs[runs.length - 1];
    let cur = null;
    try { cur = eventsMod?.currentAges ? (eventsMod.currentAges(w) || []).find((x) => x.key === age[1]) : null; } catch (e) { cur = null; }
    title = run?.name || cur?.name || `The ${F.humanize(age[1]).toLowerCase()} age`;
    desc = cur?.desc || '';
    if (run) { from = run.from; to = run.to; }
    sub = `An age of the world · ${F.yearSpan(from, to)}${runs.length > 1 ? ` · ${runs.length} times` : ''}`;
  } else {
    const swan = /^swan:([^:]+)(?::(\d+))?/.exec(sid);
    title = swan ? `The ${F.humanize(swan[1]).toLowerCase()} of Year ${swan[2] ?? yearOf(from)}` : F.headName(F.humanize(sid));
    sub = swan ? 'A turn of fortune' : 'A world event';
  }
  if (!entries.length && !age) return null;
  return { title: F.headName(title), sub, desc, entries, from, to, x: entries.find((e) => e.x != null)?.x ?? null, y: entries.find((e) => e.y != null)?.y ?? null };
}

const eventView = {
  label: 'World event', icon: 'quake',   // catastrophes, ages of the world and black swans alike
  describe(app, sel) {
    const e = getEvent(app.world, sel.id);
    if (e) return { name: eventTitle(e), sub: `${eventMagnitude(e)} · ${F.monthYear(e.d)}` };
    const we = worldEvent(app.world, sel.id);
    return we ? { name: we.title, sub: we.sub } : { name: 'A forgotten catastrophe' };
  },
  point(w, id) { const e = getEvent(w, id); if (e) return { x: e.x, y: e.y }; const we = worldEvent(w, id); return we && Number.isFinite(we.x) ? { x: we.x, y: we.y } : null; },
  mount: mounted((app, sel, b) => {
    const w = app.world, e = getEvent(w, sel.id);
    if (!e) {
      const we = worldEvent(w, sel.id);
      if (!we) return note('This catastrophe has slipped from the catalogue: only the five hundred greatest are kept.');
      return [
        lead(b, () => we.desc || we.entries[0]?.text || we.title),
        cells(b, [
          { k: 'Began', v: () => (Number.isFinite(we.from) ? F.year(we.from) : '—') },
          { k: we.to != null ? 'Ended' : 'Lasting', v: () => (we.to != null ? F.year(we.to) : Number.isFinite(we.from) ? F.span(w.time.day - we.from) : '—') },
          { k: 'Told', v: () => `${F.int(we.entries.length)} time${we.entries.length === 1 ? '' : 's'}` },
        ]),
        section('In the Chronicle', chronicleList(app, b, (q) => q.ref && q.ref.k === 'event' && String(q.ref.id) === String(sel.id), 20)),
      ];
    }
    return [
      lead(b, () => eventLead(w, e)),
      honours(app, b, 'event', e.id),
      cells(b, [
        { k: 'Force', v: () => eventMagnitude(e).split(' · ')[0] },
        { k: 'Dead', v: () => F.people(e.dead || 0) },
        { k: 'Towns', v: () => F.int((e.towns || []).length) },
      ]),
      e.ref && e.ref.k ? section('Belongs to', kv(b, [{ k: F.humanize(e.ref.k), ref: () => ({ key: 'r', make: () => linkBtn(app, { kind: e.ref.k, id: e.ref.id }, refLabel(w, e.ref)) }) }])) : null,
      section('Towns struck', rows(b, () => (e.towns || []).map((sid) => w.settlements[sid]).filter(Boolean).map((s) => ({ key: 's' + s.id, icon: 'town', label: s.name, n: s.alive ? F.people(s.population) : 'ruins', s: w.civs[s.civId]?.name || '', sel: { kind: 'settlement', id: s.id } })), 'No town was struck.', app)),
      section('Remembered nearby', rows(b, () => siteItems(app, e.x, e.y, 3), 'No site marks the place.', app)),
      section('In the Chronicle', chronicleList(app, b, (q) => (q.ref && q.ref.k === 'event' && q.ref.id === e.id) || (Math.abs(q.day - e.d) <= 40 && q.x != null && Math.hypot(q.x - e.x, q.y - e.y) <= 6 && (q.cat === 'disaster' || q.cat === 'nature' || q.cat === 'civ' || q.cat === 'climate')), 10)),
    ];
  }),
};

// ---------------------------------------------------------------------------
// search: sites, catastrophes, records and roads (the command palette)

function norm(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, '').toLowerCase(); }
function searchRecords(app, q, limit) {
  const w = app.world;
  if (!w || !q || q.length < 2) return [];
  const nq = norm(q);
  const out = [];
  const score = (text) => { const t = norm(text); const k = t.indexOf(nq); return k < 0 ? 0 : (k === 0 ? 3 : 2) + nq.length / Math.max(8, t.length); };
  for (const s of w.sites) {
    const t = siteTitle(w, s);
    const sc = score(t);
    if (sc) out.push({ kind: 'site', id: s.id, label: t, sub: siteSub(w, s), icon: SITE_ICON[s.kind] || 'pin', score: sc + Math.min(1, (s.fame || 0) / 10) });
  }
  for (const e of w.history?.events || []) {
    const t = eventTitle(e);
    const sc = score(t);
    if (sc) { const it = eventItem(w, e); out.push({ kind: it.sel.kind, id: it.sel.id, label: t, sub: it.s, icon: it.icon, score: sc + Math.log10(1 + e.dead) / 6 }); }
  }
  for (const rt of w.tradeRoutes) {
    if (!rt || !rt.name) continue;
    const sc = score(rt.name);
    if (sc) out.push({ kind: 'route', id: rt.id, label: F.headName(rt.name), sub: `${rt.kind === 'sea' ? 'Sea lane' : 'Trade road'} · ${rt.active ? 'in use' : 'abandoned'}`, icon: rt.kind === 'sea' ? 'ship' : 'road', score: sc });
  }
  for (const r of getRecords(w)) {
    const t = r.top[0];
    if (!t) continue;
    const sc = Math.max(score(r.label), score(t.l) * 0.8);
    if (sc && t.r) out.push({ kind: t.r.k, id: t.r.id, label: `${r.label}: ${F.headName(t.l)}`, sub: `${F.recordValue(r.fmt, t.s ?? t.v, r.unit)} · ${F.year(t.d)}`, icon: 'star', score: sc + 0.5 });
  }
  return out.sort((a, c) => c.score - a.score).slice(0, limit);
}

// ---------------------------------------------------------------------------

export function mount(app) {
  // an overland road (sea lanes keep the ship): a way running off between its milestones
  registerIcon('road', '<path d="M8.5 21 11 3M15.5 21 13 3"/><path d="M12 19.5v-2.4M12 13.6v-2M12 8.4V7" stroke-width="1.3"/><path d="M4 21h16" stroke-width="1.2"/>');
  registerView('route', routeView);
  registerView('figure', figureView);
  registerView('ruler', rulerView);
  registerView('dynasty', dynastyView);
  registerView('wonder', wonderView);
  registerView('fire', fireView);
  registerView('site', siteView);
  registerView('continent', continentView);
  registerView('event', eventView);
  if (compareMod?.compareView) registerView('compare', compareMod.compareView);

  if (compareMod?.openCompare) {
    registerTitleAction('civ', {
      id: 'compare', icon: 'nations', label: 'Compare with its greatest rival', order: 40,
      run(a, sel) {
        const w = a.world;
        // the nation it has fought most, else the greatest living other nation
        const n = new Map();
        for (const q of w.wars) {
          const att = q.attackers.includes(sel.id), def = q.defenders.includes(sel.id);
          if (!att && !def) continue;
          for (const o of att ? q.defenders : q.attackers) if (w.civs[o]) n.set(o, (n.get(o) || 0) + 1);
        }
        let rival = [...n.entries()].sort((p, q) => q[1] - p[1] || p[0] - q[0])[0]?.[0];
        if (rival == null) rival = w.civs.filter((c) => c && c.alive && c.id !== sel.id).sort((p, q) => fin(q.population) - fin(p.population))[0]?.id;
        if (rival != null) compareMod.openCompare(a, [sel.id, rival]);
      },
    });
  }
  registerOverlay({ id: 'footprints', label: 'Record footprints', desc: 'Draw the selected war’s battles and conquests, an army’s march, a storm’s track, a plague’s front or a faith’s reach.', default: true });
  registerSearchSource({ id: 'records', label: 'Records and sites', search: searchRecords });
  registerCommand({
    id: 'records.dev', label: 'Show developer records in the Inspector', group: 'Records', keywords: ['raw', 'flags', 'debug', 'developer'],
    run() { setPref('records.dev', !getPref('records.dev', false)); app.emit('select', app.selection); },
  });

  // the footprint layer follows every selection (built-in kinds reach the renderer only as a tile)
  const point = (sel) => { try { overlays?.setOverlayTarget?.(sel); } catch (e) { app.reportError('records.overlay', e); } };
  app.on('select', point);
  app.on('world', () => point(app.selection));
}
