// Peoples — registered Inspector sections for Mythic worlds' mixed peoples
// (docs/design/mixed-peoples.md, "UI and render"), placed right under each record's summary figures:
//   settlement  "Peoples": the town's mix as a stacked bar in the races' colours, each people
//               with its share and rough headcount, the dominant people named, kinship and old
//               enmities between the peoples who share it, and the change over fifty years
//               when anyone knows it
//   civ         "Peoples of the realm": the realm's mix by population, each people with its
//               share, headcount and the towns where it holds the majority, the ruling people
//               marked, and the makeup over the years (peoplesHistory, closed by today's mix)
//   continent   "Peoples of this land": the same over a continent
// Hidden in Historical and Legendary worlds. Read-only: the numbers come from ../peoples.js
// (the sim's published helpers); nothing here writes the world.

import { registerSection } from '../registry.js';
import { h, Binder } from '../dom.js';
import * as F from '../format.js';
import { RACE_META, DAYS_PER_YEAR } from '../../core/constants.js';
import { raceRel } from '../../sim/myth/races.js';
import {
  peoplesOn, townMix, realmMix, landMix, mixHistory, townMixPast, sampleTownMixes, wholePct, approxPeople,
  peoplesBar, legendRows, drawMixChart, mixKey, mixChange, raceAdjLower,
} from '../peoples.js';

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const plural = (r) => RACE_META[r]?.plural || 'Others';
const lowPlural = (r) => plural(r).toLowerCase();
const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
const aOrAn = (wd) => (/^[aeiou]/i.test(wd) ? 'an ' : 'a ') + wd;
const yearNow = (w) => Math.floor(w.time.day / DAYS_PER_YEAR);

function head(el, title) {
  el.classList.add('pp-sec');
  el.appendChild(h('h4.rule-head', { text: title }));
}

// ---------------------------------------------------------------------------
// Words

/** "Mostly human (82%), with an elven minority (12%) and a few orcs." */
function townLead(w, s, items) {
  if (!items.length) return '';
  const p = wholePct(items);
  const tier = F.tierName(s.tier).toLowerCase();
  const top = items[0];
  const minors = items.slice(1, 3).map((it, k) => (it.share < 0.1 ? `a few ${lowPlural(it.race)}` : `${aOrAn(raceAdjLower(it.race))} minority (${p[k + 1]}%)`));
  let t;
  if (items.length === 1 || p[0] >= 98) t = `A wholly ${raceAdjLower(top.race)} ${tier}: no other people lives here in numbers.`;
  else if (top.share >= 0.8) t = `Mostly ${raceAdjLower(top.race)} (${p[0]}%), with ${F.listing(minors, 2)}.`;
  else if (top.share >= 0.5) t = `${cap(raceAdjLower(top.race))} by a majority of ${p[0]}%, with ${F.listing(minors, 2)}.`;
  else t = `No people holds a majority here: ${items.slice(0, 3).map((it, k) => `${lowPlural(it.race)} ${p[k]}%`).join(', ')}.`;
  // the dominant people (s.race) holds its name until a challenger clearly leads
  if (s.race && s.race !== top.race && RACE_META[s.race]) t += ` It is still reckoned ${aOrAn(raceAdjLower(s.race))} ${tier}, though ${lowPlural(top.race)} now outnumber ${lowPlural(s.race)}.`;
  return t;
}

/** Kinship and old hatreds between the peoples who share a place (each ≥ 10 %). */
function relationNotes(items, where = 'this town') {
  const big = items.filter((it) => it.share >= 0.1);
  const out = [];
  for (let a = 0; a < big.length; a++) for (let c = a + 1; c < big.length; c++) {
    const ra = big[a].race, rb = big[c].race, rel = raceRel(ra, rb);
    if (rel <= -20) out.push({ w: -rel, t: `${cap(lowPlural(ra))} and ${lowPlural(rb)} share ${where} uneasily, across an old enmity.` });
    else if (rel >= 8) out.push({ w: rel, t: `${cap(lowPlural(ra))} and ${lowPlural(rb)} live ${where === 'this town' ? 'here' : 'side by side'} as good neighbours.` });
  }
  return out.sort((p, q) => q.w - p.w).slice(0, 2).map((x) => x.t).join(' ');
}

function civLead(w, c, items) {
  if (!items.length) return '';
  const p = wholePct(items);
  const name = F.theCiv(c);
  if (items.length === 1) return `A realm of ${lowPlural(items[0].race)} alone: no other people lives in ${name} in numbers.`;
  const k = items.findIndex((it) => it.race === c.race);
  const n = items.length;
  const count = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'][n] || String(n);
  if (k === 0) return `${count} peoples live in ${name}; the ruling ${lowPlural(c.race)} are ${p[0]}% of them.`;
  if (k > 0) return `The ${lowPlural(c.race)} rule ${name}, but ${lowPlural(items[0].race)} outnumber them, ${p[0]}% to ${p[k]}%.`;
  return `The ${lowPlural(c.race)} rule ${name}, yet few of them live in its towns: ${items.slice(0, 2).map((it, j) => `${lowPlural(it.race)} ${p[j]}%`).join(', ')}.`;
}

// ---------------------------------------------------------------------------
// Sections

function townSection(app, sel, el) {
  const w = app.world, s = w.settlements[sel.id];
  if (!s) return null;
  const b = new Binder();
  head(el, 'Peoples');
  let mk = null, mv = [];
  const mix = () => { const m = townMix(w, s); const k = mixKey(m); if (k !== mk) { mk = k; mv = m; } return mv; };
  const lead = h('p.pp-lead');
  b.text(lead, () => townLead(w, s, mix()));
  const bar = peoplesBar({ size: 'lg', label: `Peoples of ${s.name}` });
  b.run(() => bar.set(mix()));
  const legend = h('div');
  b.list(legend, () => [mix()], (m) => `${mixKey(m)}:${Math.round(Math.log2(fin(s.population) + 1) * 6)}:${w.civs[s.civId]?.race}`, (m) => legendRows(m, {
    extra: (it) => `about ${approxPeople(it.share * fin(s.population))}`,
    mark: (it) => (m.length > 1 && it.race === w.civs[s.civId]?.race ? 'ruling' : null),
  }));
  const notes = h('p.pp-note');
  b.text(notes, () => relationNotes(mix()));
  b.hide(notes, () => !notes.textContent);
  const change = h('p.pp-change');
  b.text(change, () => {
    const past = townMixPast(w, s, 50);
    if (!past || !past.items.length) return '';
    const moves = mixChange(past.items, mix());
    return moves.length ? `Since Year ${past.year}: ${moves.join(', ')}.` : `Little has changed since Year ${past.year}.`;
  });
  b.hide(change, () => !change.textContent);
  el.append(lead, bar, legend, notes, change);
  b.update();
  return { update: () => b.update() };
}

function civSection(app, sel, el) {
  const w = app.world, c = w.civs[sel.id];
  if (!c) return null;
  const b = new Binder();
  head(el, 'Peoples of the realm');
  let mk = null, mv = [];
  const mix = () => { const m = realmMix(w, c); const k = mixKey(m) + ':' + m.map((it) => it.towns).join(','); if (k !== mk) { mk = k; mv = m; } return mv; };
  const lead = h('p.pp-lead');
  b.text(lead, () => civLead(w, c, mix()));
  const bar = peoplesBar({ size: 'lg', label: `Peoples of ${c.name}` });
  b.run(() => bar.set(mix()));
  // a fallen realm keeps only the record of its peoples over the years
  b.hide(lead, () => !mix().length);
  b.hide(bar, () => !mix().length);
  const legend = h('div');
  b.list(legend, () => [mix()], (m) => `${mixKey(m)}:${m.map((it) => `${it.towns}:${Math.round(Math.log2(fin(it.pop) + 1) * 6)}`).join(',')}:${c.race}`, (m) => legendRows(m, {
    extra: (it) => [
      `about ${approxPeople(it.pop)}`,
      it.towns ? `${it.towns} town${it.towns === 1 ? '' : 's'}` : 'no town of its own',
      it.race !== c.race && raceRel(it.race, c.race) <= -20 ? 'old enmity' : '',
    ].filter(Boolean).join(' · '),
    mark: (it) => (it.race === c.race ? 'ruling' : null),
  }));
  const notes = h('p.pp-note');
  b.text(notes, () => relationNotes(mix(), 'the realm'));
  b.hide(notes, () => !notes.textContent);
  // the makeup over the years
  const cv = h('canvas.pp-chart', { 'aria-label': `The peoples of ${c.name} over the years` });
  const chartBox = h('div', null, h('h5.sub-head', { text: 'Over the years' }), cv);
  let drawn = '';
  b.run(() => {
    const ser = mixHistory(w, 'civ', c.id);
    const last = ser[ser.length - 1];
    // the chart runs to today: a living realm's mix now closes it (so a young realm with one
    // decade sample already shows a chart)
    const now = mix(), yNow = yearNow(w);
    const pts = ser.slice();
    if (now.length && (!last || last[0] < yNow)) {
      const p = wholePct(now), o = {};
      now.forEach((it, k) => { if (p[k] > 0) o[it.race] = p[k]; });
      pts.push([yNow, o]);
    }
    const key = `${ser.length}|${last ? last[0] : ''}|${yNow}|${mixKey(now)}|${cv.clientWidth}|${document.documentElement.dataset.theme || ''}`;
    if (key === drawn || !cv.isConnected || !cv.clientWidth) return;
    drawn = key;
    drawMixChart(cv, pts, { empty: 'The record of its peoples begins after a decade.' });
  });
  el.append(lead, bar, legend, notes, chartBox);
  b.update();
  // the canvas has no width until the record is in the panel
  requestAnimationFrame(() => b.update());
  return { update: () => b.update() };
}

function continentSection(app, sel, el) {
  const w = app.world;
  const ft = w.features?.[sel.id];
  if (!ft || ft.kind !== 'continent') return null;
  const fi = Math.round(ft.y) * w.W + Math.round(ft.x);
  const lm = fi >= 0 && fi < w.N && w.f.landmass ? w.f.landmass[fi] : -1;
  const b = new Binder();
  head(el, 'Peoples of this land');
  let mk = null, mv = [];
  const mix = () => { const m = landMix(w, lm); const k = mixKey(m) + ':' + m.map((it) => it.towns).join(','); if (k !== mk) { mk = k; mv = m; } return mv; };
  const bar = peoplesBar({ size: 'lg', label: `Peoples of ${ft.name}` });
  b.run(() => bar.set(mix()));
  const legend = h('div');
  b.list(legend, () => [mix()], (m) => `${mixKey(m)}:${m.map((it) => `${it.towns}:${Math.round(Math.log2(fin(it.pop) + 1) * 6)}`).join(',')}`, (m) => legendRows(m, {
    extra: (it) => `about ${approxPeople(it.pop)} · ${it.towns ? `${it.towns} town${it.towns === 1 ? '' : 's'}` : 'no town of its own'}`,
  }));
  const none = h('p.empty-note', { text: 'No people lives on this land yet.' });
  b.hide(none, () => mix().length > 0);
  b.hide(bar, () => !mix().length);
  el.append(bar, legend, none);
  b.update();
  return { update: () => b.update() };
}

// ---------------------------------------------------------------------------
// Mount

let mounted = false;
/** Register the peoples sections (called by ./myth.js mount). */
export function mountPeoples(app) {
  if (mounted) return;
  mounted = true;
  const live = (a) => peoplesOn(a.world);
  registerSection('settlement', { id: 'myth.peoples', order: 5, after: 'summary', when: (a, sel) => live(a) && Boolean(a.world.settlements[sel.id]?.alive), mount: townSection });
  registerSection('civ', { id: 'myth.peoples', order: 5, after: 'summary', when: (a, sel) => live(a) && Boolean(a.world.civs[sel.id]) && realmMixShown(a.world, a.world.civs[sel.id]), mount: civSection });
  registerSection('continent', { id: 'myth.peoples', order: 5, when: (a) => live(a), mount: continentSection });
  // the session's memory of town mixes (for "since Year …" where the sim keeps none)
  app.on('tick', () => { try { sampleTownMixes(app.world); } catch (e) { /* a reading, never fatal */ } });
}
/** A realm's block shows while it has people or a record of them. */
function realmMixShown(w, c) {
  if (realmMix(w, c).length) return true;
  return mixHistory(w, 'civ', c.id).length >= 2;
}

/** For tests and the console: the town lead and notes as the Inspector words them. */
export const peoplesWords = { townLead, civLead, relationNotes, yearNow };
