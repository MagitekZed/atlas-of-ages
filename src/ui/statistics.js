// The Statistics tab: the world's vital signs over time, drawn from world.history.years.
// Headline tiles (the largest city named and linked), the World Ledger of lifetime totals, a
// shared time range (presets, or drag across any chart to zoom), and charts that share one
// crosshair; click a chart to travel the Atlas and Chronicle to that year. Great wars, plagues
// and epochal events are marked on the population charts. Measures with different units are
// never forced onto one axis: climate is three small charts, and the living world is indexed
// to its genesis value (= 100). Nations missing from a year's itemised list are filled in from
// their ledgers, so a fragmented world shows no false collapses.

import { CATEGORIES, DAYS_PER_YEAR } from '../core/constants.js';
import { h, clear, setText } from './dom.js';
import { TimeChart } from './charts.js';
import { tip } from './widgets.js';
import * as F from './format.js';
import { getPref, setPref } from './prefs.js';

const RANGES = [[0, 'All'], [1000, '1,000 yrs'], [250, '250 yrs'], [50, '50 yrs']];
const STACK_N = 7;
const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** A civ's people at a year from its ledger (nearest sample at or before), or NaN. */
function ledgerPop(w, id, year) {
  const raw = w.history?.series?.c?.[id];
  if (!raw || !Array.isArray(raw.v)) return NaN;
  const d = year * DAYS_PER_YEAR;
  if (d < raw.t0 || (raw.e != null && d > raw.e)) return NaN;
  const n = Math.floor(raw.v.length / 10);
  const k = Math.min(n - 1, Math.floor((d - raw.t0) / raw.st));
  return k >= 0 ? raw.v[k * 10] : NaN;
}

/** The World Ledger: lifetime totals from every system's counters. [label, value, sub, tip] */
function ledgerTiles(w) {
  const s = w.sys || {};
  const war = s.war || {}, dis = s.disasters?.counts || {}, wx = s.weather?.counts || {}, eco = s.ecology?.counts || {};
  const dz = s.disease || {}, rel = s.religion || {}, tr = s.trade || {}, cc = s.civ?.counters || {};
  const fallen = w.civs.filter((c) => c && !c.alive).length;
  const out = [
    ['Battles fought', war.battles, war.declared != null ? `in ${F.int(war.declared)} wars` : ''],
    ['Towns taken', war.captures, war.razed ? `${F.int(war.razed)} razed` : ''],
    ['Nations', w.civs.length, `${F.int(fallen)} fallen`],
    ['Earthquakes', dis.quakes, dis.quakes6 ? `${F.int(dis.quakes6)} of magnitude 6+` : ''],
    ['Eruptions', dis.eruptions, dis.eruptions4 ? `${F.int(dis.eruptions4)} great` : ''],
    ['Cyclones', wx.cyclones, wx.landfalls ? `${F.int(wx.landfalls)} landfalls, ${F.people(wx.cycloneDeaths || 0)} dead` : ''],
    ['Wildfires', eco.fires, eco.biggestFire ? `largest ${F.areaShort(eco.biggestFire)}` : ''],
    ['Plagues', dz.outbreaks, dz.deaths ? `${F.people(dz.deaths)} dead` : ''],
    ['Faiths founded', rel.founded, rel.schisms ? `${F.int(rel.schisms)} schisms` : ''],
    ['Trade roads', tr.created, tr.broken != null ? `${F.int(tr.broken)} broken` : ''],
    ['Great droughts', wx.greatDroughts, wx.droughts ? `${F.int(wx.droughts)} droughts` : ''],
    ['Floods', dis.floods, dis.floodDeaths ? `${F.people(dis.floodDeaths)} drowned` : ''],
    ['Rebellions', cc.rebellions, cc.civilWars ? `${F.int(cc.civilWars)} civil wars` : ''],
    ['Colonies', cc.colonies, cc.emerged ? `${F.int(cc.emerged)} peoples emerged` : ''],
    ['Lightning', wx.strikes, wx.lightningFires ? `${F.int(wx.lightningFires)} fires lit` : ''],
    ['Great people', w.figures.length, `${F.int(w.figures.filter((f) => f.died == null).length)} living`],
    ['Wonders', w.wonders.length, `${F.int(w.wonders.filter((q) => q.destroyedDay != null).length)} ruined`],
    ['Historic sites', w.sites.length, `${F.int(w.sites.filter((q) => q.kind === 'ruin').length)} ruins`],
  ];
  return out.filter(([, v]) => Number.isFinite(v));
}

export function createStatistics(app) {
  const el = h('div.tabpanel');
  let range = getPref('statsRange', 0);
  let zoom = null;          // { y0, y1 } dragged out on a chart
  let table = false;
  let logPop = Boolean(getPref('records.statsLog', false));

  const tiles = h('div.stat-tiles');
  const T = {
    pop: tile('People'), civs: tile('Nations'), towns: tile('Settlements'),
    temp: tile('Land temperature'), sea: tile('Sea level'), co2: tile('Carbon dioxide'),
  };
  tiles.append(...Object.values(T).map((t) => t.el));
  const bigLink = h('button.link.tile-link', { type: 'button' });
  bigLink.addEventListener('click', () => { const b = app.world?.stats?.bigCity; if (b) app.select({ kind: 'settlement', id: b.id }, { focus: true }); });

  const seg = h('div.seg', { role: 'group', 'aria-label': 'Time range' });
  for (const [v, label] of RANGES) {
    const b = h('button', { type: 'button', text: label, 'aria-pressed': String(v === range && !zoom) });
    b.addEventListener('click', () => { range = v; zoom = null; setPref('statsRange', v); syncRange(); sig = ''; refresh(); });
    seg.appendChild(b);
  }
  const zoomChip = h('button.chip.is-range', { type: 'button', hidden: true, 'aria-label': 'Clear the zoom' });
  zoomChip.addEventListener('click', () => { zoom = null; syncRange(); sig = ''; refresh(); });
  function syncRange() {
    for (const [k, b] of Array.from(seg.children).entries()) b.setAttribute('aria-pressed', String(!zoom && RANGES[k][0] === range));
    zoomChip.hidden = !zoom;
    if (zoom) zoomChip.textContent = `Y${zoom.y0}–Y${zoom.y1}  ×`;
  }
  const tableBtn = h('button.btn.btn-sm', { type: 'button', text: 'Show as a table', 'aria-pressed': 'false' });
  tableBtn.addEventListener('click', () => { table = !table; tableBtn.textContent = table ? 'Show as charts' : 'Show as a table'; tableBtn.setAttribute('aria-pressed', String(table)); sig = ''; refresh(); });
  const controls = h('div.stats-controls', null, seg, zoomChip, tableBtn);
  const hint = h('p.gen-note.stats-hint', { text: 'Drag across a chart to zoom into those years; click to travel there in the Atlas and Chronicle.' });

  const onHover = (y) => { for (const c of charts) c.setHoverYear(y); };
  const onPick = (y) => app.emit('timeTravel', y);
  const onRange = (y0, y1) => { zoom = { y0, y1 }; syncRange(); sig = ''; refresh(); };
  const C0 = { onHover, onPick, onRange };
  const pop = new TimeChart({ title: 'World population', height: 140, yFormat: F.axis, tipFormat: (v) => F.people(v), log: logPop, ...C0 });
  const stack = new TimeChart({ title: 'Population by nation', height: 170, mode: 'stack', yFormat: F.axis, tipFormat: (v) => F.people(v), ...C0 });
  const toll = new TimeChart({ title: 'The toll of the years', sub: 'dead each year', height: 120, mode: 'stack', agg: 'max', yFormat: F.axis, tipFormat: (v) => F.people(v), ...C0 });
  const pulse = new TimeChart({ title: 'The pulse of history', sub: 'notable events each year', height: 130, mode: 'stack', agg: 'max', intTicks: true, yFormat: (v) => F.int(v), tipFormat: (v) => F.int(v), ...C0 });
  const tempC = new TimeChart({ title: 'Land temperature', sub: 'annual mean, °C', height: 96, yMin: null, yFormat: (v) => v.toFixed(1), tipFormat: (v) => F.temp(v, 2), ...C0 });
  const seaC = new TimeChart({ title: 'Sea level', sub: 'metres from genesis', height: 96, yMin: null, yFormat: (v) => F.int(v), tipFormat: (v) => F.signed(v, 1, ' m'), ...C0 });
  const co2C = new TimeChart({ title: 'Carbon dioxide', sub: 'parts per million', height: 96, yMin: null, yFormat: (v) => F.int(v), tipFormat: (v) => F.int(v) + ' ppm', ...C0 });
  const skyC = new TimeChart({ title: 'Drought and veiled skies', sub: 'drought index · aerosol veil', height: 96, yFormat: (v) => Math.round(v * 100) + '%', tipFormat: (v) => F.pct(v, 1), agg: 'max', ...C0 });
  const life = new TimeChart({ title: 'The living world', sub: 'genesis = 100', height: 140, yFormat: (v) => F.int(v), tipFormat: (v) => F.int(v), ...C0 });
  const fishC = new TimeChart({ title: 'Fish stocks', sub: 'genesis = 100', height: 90, yFormat: (v) => F.int(v), tipFormat: (v) => F.int(v), ...C0 });
  const scars = new TimeChart({ title: 'Scars on the land', sub: 'share of land devastated or polluted', height: 96, yFormat: (v) => (v * 100).toFixed(1) + '%', tipFormat: (v) => F.pct(v, 2), ...C0 });
  const conflict = new TimeChart({ title: 'Wars, plagues and faiths', sub: 'active each year', height: 120, agg: 'max', intTicks: true, yFormat: (v) => F.int(v), tipFormat: (v) => F.int(v), ...C0 });
  const townsC = new TimeChart({ title: 'Settlements', height: 100, intTicks: true, yFormat: (v) => F.int(v), tipFormat: (v) => F.int(v), ...C0 });
  const urbC = new TimeChart({ title: 'Life in towns', sub: 'share of people in towns and cities', height: 96, yFormat: (v) => Math.round(v) + '%', tipFormat: (v) => v.toFixed(1) + '%', ...C0 });
  const faithC = new TimeChart({ title: 'Faiths of the world', sub: 'followers', height: 140, mode: 'stack', yFormat: F.axis, tipFormat: (v) => F.people(v), ...C0 });
  const tradeC = new TimeChart({ title: 'Trade roads', sub: 'in use each year', height: 96, intTicks: true, yFormat: (v) => F.int(v), tipFormat: (v) => F.int(v), ...C0 });
  const wealthC = new TimeChart({ title: 'The wealth of nations', sub: 'treasuries in all', height: 96, yFormat: F.axis, tipFormat: (v) => F.money(v), ...C0 });
  const landUse = new TimeChart({ title: 'Land use', sub: 'share of all land', height: 110, yFormat: (v) => Math.round(v * 100) + '%', tipFormat: (v) => F.pct(v, 1), ...C0 });
  // the world's people by age and trade (yearly record .people, sim/civ/peoplenews.js)
  const agesC = new TimeChart({ title: 'Ages', sub: 'median age · life expectancy at birth, years', height: 100, yFormat: (v) => F.int(v), tipFormat: (v) => v.toFixed(1) + ' years', ...C0 });
  const vitalC = new TimeChart({ title: 'Births and deaths', sub: 'a year per 1,000 people (deaths of age, sickness, hunger and feuds; war and plague above)', height: 100, yFormat: (v) => F.int(v), tipFormat: (v) => v.toFixed(1) + ' ‰', ...C0 });
  const workC = new TimeChart({ title: 'Working hands by trade', sub: 'share of all working hands', height: 130, mode: 'stack', yFormat: (v) => Math.round(v * 100) + '%', tipFormat: (v) => F.pct(v, 1), ...C0 });
  const charts = [pop, stack, toll, pulse, tempC, seaC, co2C, skyC, life, fishC, scars, conflict, townsC, urbC, faithC, agesC, vitalC, workC, tradeC, wealthC, landUse];
  const logBtn = h('button.chip', { type: 'button', text: 'Log scale', 'aria-pressed': String(logPop) });
  tip(logBtn, 'Show the population on a logarithmic scale, so the first tribal centuries read as clearly as the great empires.');
  logBtn.addEventListener('click', () => { logPop = !logPop; setPref('records.statsLog', logPop); logBtn.setAttribute('aria-pressed', String(logPop)); pop.setLog(logPop); });
  pop.el.querySelector('.ch-head').appendChild(logBtn);

  const ledgerBox = h('div.stat-tiles.ledger-tiles');
  const ledgerSec = h('details.more.world-ledger', { open: getPref('records.ledgerOpen', true) ? true : null }, h('summary', { text: 'The World Ledger: lifetime totals' }), ledgerBox);
  ledgerSec.addEventListener('toggle', () => setPref('records.ledgerOpen', ledgerSec.open));

  const chartBox = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '20px' } },
    pop.el, stack.el, toll.el, pulse.el,
    h('h4.rule-head', { text: 'Climate' }), tempC.el, seaC.el, co2C.el, skyC.el,
    h('h4.rule-head', { text: 'Life' }), life.el, fishC.el, scars.el,
    h('h4.rule-head', { text: 'Peoples' }), conflict.el, townsC.el, urbC.el, faithC.el,
    h('h4.rule-head', { text: 'Ages and trades' }), agesC.el, vitalC.el, workC.el,
    h('h4.rule-head', { text: 'Trade and wealth' }), tradeC.el, wealthC.el, landUse.el,
  );
  const tableBox = h('div.table-wrap', { hidden: true });
  const note = h('p.gen-note');
  el.append(tiles, ledgerSec, controls, hint, chartBox, tableBox, note);

  function tile(label) {
    const v = h('span.v'), d = h('span.d');
    return { el: h('div.stat-tile', null, h('span.k', { text: label }), v, d), v, d };
  }

  let sig = '';
  function slice() {
    const ys = app.world?.history?.years || [];
    if (!ys.length) return ys;
    if (zoom) return ys.filter((r) => r.y >= zoom.y0 && r.y <= zoom.y1);
    if (!range) return ys;
    const last = ys[ys.length - 1].y;
    let k = ys.length - 1;
    while (k > 0 && ys[k - 1].y >= last - range) k--;
    return ys.slice(k);
  }

  function updateTiles() {
    const w = app.world;
    const all = w.history.years;
    const last = all[all.length - 1];
    const ago = (n) => { for (let k = all.length - 1; k >= 0; k--) if (all[k].y <= last.y - n) return all[k]; return all[0]; };
    const c100 = ago(100);
    const g = w.sys?.stats?.genesis || all[0];
    setText(T.pop.v, F.people(last.pop));
    delta(T.pop.d, last.pop, c100.pop, 'in a century', (a, b) => (b > 0 ? F.signed(((a - b) / b) * 100, 0, '%') : '—'));
    setText(T.civs.v, String(last.civs));
    setText(T.civs.d, `${w.civs.length - last.civs} fallen in all`);
    T.civs.d.className = 'd';
    setText(T.towns.v, F.int(last.towns));
    const big = w.stats?.bigCity;
    clear(T.towns.d);
    T.towns.d.className = 'd';
    if (big) { bigLink.textContent = `${big.name}, ${F.people(big.pop)}`; T.towns.d.append('largest ', bigLink); } else setText(T.towns.d, `largest ${F.people(last.big || 0)}`);
    setText(T.temp.v, F.temp(last.landTemp));
    delta(T.temp.d, last.landTemp, g.landTemp, 'since genesis', (a, b) => F.signed(a - b, 1, ' °C'), true);
    setText(T.sea.v, F.signed(last.sea, 0, ' m'));
    delta(T.sea.d, last.sea, c100.sea, 'in a century', (a, b) => F.signed(a - b, 0, ' m'), true);
    setText(T.co2.v, F.int(last.co2) + ' ppm');
    delta(T.co2.d, last.co2, 280, 'over 280 baseline', (a, b) => F.signed(a - b, 0), true);
    clear(ledgerBox);
    for (const [label, v, sub] of ledgerTiles(w)) ledgerBox.appendChild(h('div.stat-tile', null, h('span.k', { text: label }), h('span.v', { text: F.int(v) }), h('span.d', { text: sub || '' })));
  }

  function delta(elD, a, b, label, fmt, neutral = false) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) { setText(elD, ''); return; }
    setText(elD, `${fmt(a, b)} ${label}`);
    elD.className = 'd' + (neutral ? '' : a > b ? ' up' : a < b ? ' down' : '');
  }

  /** Bands for the deadliest wars and plagues, ticks for epochal events (≤ 14 marks). */
  function historyMarks(w, x0, x1) {
    const marks = [];
    const toll = (q) => Object.values(q.casualties || {}).reduce((a, v) => a + fin(v), 0);
    const wars = w.wars.filter((q) => q && Math.floor(fin(q.endDay ?? w.time.day) / DAYS_PER_YEAR) >= x0 && Math.floor(q.startDay / DAYS_PER_YEAR) <= x1).sort((a, b) => toll(b) - toll(a)).slice(0, 5);
    for (const q of wars) if (toll(q) > 0) marks.push({ y: Math.floor(q.startDay / DAYS_PER_YEAR), y2: Math.max(Math.floor(q.startDay / DAYS_PER_YEAR) + 1, Math.floor(fin(q.endDay ?? w.time.day) / DAYS_PER_YEAR)), color: '#d0533f', label: `${F.headName(F.midName(q.name))}: ${F.people(toll(q))} dead` });
    const plagues = w.plagues.filter((p) => p && fin(p.deaths) > 0).sort((a, b) => b.deaths - a.deaths).slice(0, 3);
    for (const p of plagues) marks.push({ y: Math.floor(p.startDay / DAYS_PER_YEAR), y2: Math.max(Math.floor(p.startDay / DAYS_PER_YEAR) + 1, Math.floor(fin(p.endDay ?? w.time.day) / DAYS_PER_YEAR)), color: '#8db04a', label: `${F.headName(p.name)}: ${F.people(p.deaths)} dead` });
    let n = 0;
    for (const e of w.chronicle.entries) if (e.imp >= 5 && n < 6) { const y = Math.floor(e.day / DAYS_PER_YEAR); if (y >= x0 && y <= x1) { marks.push({ y, color: '#c9a466', label: e.text.length > 90 ? e.text.slice(0, 88) + '…' : e.text }); n++; } }
    return marks;
  }

  function refresh() {
    const w = app.world;
    if (!w) return;
    const ys = slice();
    const all = w.history?.years || [];
    if (!all.length) { note.textContent = 'The record will begin at the turn of the first year.'; return; }
    const s = `${all.length}:${all[all.length - 1].y}:${range}:${table}:${zoom ? zoom.y0 + '-' + zoom.y1 : ''}`;
    if (s === sig) return;
    sig = s;
    updateTiles();
    chartBox.hidden = table;
    tableBox.hidden = !table;
    hint.hidden = table;
    note.textContent = `${F.int(all.length)} yearly records from Year ${all[0].y}; the oldest are thinned as history grows.`;
    if (table) { buildTable(ys); return; }
    const xs = ys.map((r) => r.y);
    const col = (k) => ys.map((r) => r[k]);
    const C = chartColors();
    const marks = xs.length ? historyMarks(w, xs[0], xs[xs.length - 1]) : [];
    pop.o.marks = marks;
    pop.setData({ xs, series: [{ label: 'People', color: C[0], values: col('pop') }] });

    // stacked by nation: the nations with the most people in range, then "Other"; a nation not
    // itemised in some year is read from its ledger instead of dropping to zero
    const peak = new Map();
    for (const r of ys) for (const [id, v] of Object.entries(r.civ || {})) peak.set(id, Math.max(peak.get(id) || 0, v[0] || 0));
    const top = [...peak.entries()].sort((a, b) => b[1] - a[1]).slice(0, STACK_N).map(([id]) => id);
    const civVal = (r, id) => {
      if (r.civ?.[id]) return r.civ[id][0];
      const c = w.civs[id];
      if (!c || c.foundedDay > r.y * DAYS_PER_YEAR || (!c.alive && fin(c.fallenDay) < r.y * DAYS_PER_YEAR)) return 0;
      const v = ledgerPop(w, id, r.y);
      return Number.isFinite(v) ? v : 0;
    };
    const series = top.map((id) => {
      const c = w.civs[id];
      return { label: c ? c.name + (c.alive ? '' : ' †') : 'Nation ' + id, color: c?.colorHex || C[3], values: ys.map((r) => civVal(r, id)) };
    });
    const other = ys.map((r, k) => {
      let s2 = 0;
      for (const se of series) s2 += se.values[k];
      return Math.max(0, (r.pop || 0) - s2);
    });
    // rounding leaves a few people unaccounted for; only show "All others" when it is a real share
    if (other.some((v, k) => v > Math.max(50, (ys[k].pop || 0) * 0.01))) series.push({ label: 'All others', color: 'rgba(143,136,119,0.75)', values: other });
    stack.o.marks = marks.filter((m) => m.y2 == null);
    stack.setData({ xs, series });

    // flows over a long span read better as decades: sum each decade's years
    const span = xs.length ? xs[xs.length - 1] - xs[0] : 0;
    const bin = span > 160 ? 10 : 1;
    const bins = [], binOf = new Map();
    for (const r of ys) { const b0 = Math.floor(r.y / bin) * bin; if (!binOf.has(b0)) { binOf.set(b0, bins.length); bins.push({ y: b0, rows: [] }); } bins[binOf.get(b0)].rows.push(r); }
    const bxs = bins.map((q) => q.y);
    const bsum = (fn) => bins.map((q) => q.rows.reduce((a, r) => a + fin(fn(r)), 0));
    toll.setSub(bin > 1 ? 'dead each decade' : 'dead each year');
    toll.setData({ xs: bxs, series: [
      { label: 'Fallen in war', color: C[2], values: bsum((r) => r.casualties) },
      { label: 'Dead of plague', color: C[1], values: bsum((r) => r.pdeaths) },
    ] });
    const catKeys = Object.keys(CATEGORIES).filter((k) => ys.some((r) => r.ev?.[k]));
    pulse.setSub(bin > 1 ? 'notable events each decade' : 'notable events each year');
    pulse.setData({ xs: bxs, series: catKeys.map((k) => ({ label: CATEGORIES[k].label, color: CATEGORIES[k].color, values: bsum((r) => r.ev?.[k]) })) });

    tempC.setData({ xs, series: [{ label: 'Land temperature', color: C[2], values: col('landTemp') }] });
    seaC.setData({ xs, series: [{ label: 'Sea level', color: C[3], values: col('sea') }] });
    co2C.setData({ xs, series: [{ label: 'CO₂', color: C[0], values: col('co2') }] });
    skyC.setData({ xs, series: [
      { label: 'Drought', color: C[0], values: col('drought') },
      { label: 'Aerosol veil', color: C[3], values: col('aer') },
    ] });

    const g = w.sys?.stats?.genesis || all[0];
    const idx = (k) => ys.map((r) => (g[k] > 1e-6 ? (r[k] / g[k]) * 100 : NaN));
    // multi-line charts use colour sets validated across all pairs: {1,2,4} or {2,3,4}, never 1 with 3
    life.setData({ xs, series: [
      { label: 'Vegetation', color: C[1], values: idx('veg') },
      { label: 'Herds', color: C[3], values: idx('herb') },
      { label: 'Predators', color: C[2], values: idx('pred') },
    ] });
    fishC.setData({ xs, series: [{ label: 'Fish', color: C[0], values: idx('fish') }] });
    scars.setData({ xs, series: [
      { label: 'Devastation', color: C[2], values: col('dev') },
      { label: 'Pollution', color: C[3], values: col('poll') },
    ] });
    conflict.setData({ xs, series: [
      { label: 'Wars', color: C[2], values: col('wars') },
      { label: 'Plagues', color: C[1], values: col('plagues') },
      { label: 'Faiths', color: C[3], values: col('faiths') },
    ] });
    townsC.setData({ xs, series: [{ label: 'Settlements', color: C[0], values: col('towns') }] });
    urbC.setData({ xs, series: [{ label: 'In towns and cities', color: C[3], values: ys.map((r) => (Number.isFinite(r.urb) ? r.urb / 10 : NaN)) }] });
    // faiths: the five greatest in range, from each year's leading faiths
    const fpeak = new Map();
    for (const r of ys) for (const [rid, n] of Object.entries(r.rel || {})) fpeak.set(rid, Math.max(fpeak.get(rid) || 0, n));
    const ftop = [...fpeak.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([rid]) => rid);
    faithC.el.hidden = !ftop.length;
    if (ftop.length) faithC.setData({ xs, series: ftop.map((rid) => { const r = w.religions[rid]; return { label: r ? F.headName(r.name) + (r.alive === false ? ' †' : '') : 'A faith', color: r?.colorHex || C[3], values: ys.map((q) => fin(q.rel?.[rid])) }; }) });
    const pp = (k) => ys.map((r) => (Number.isFinite(r.people?.[k]) ? r.people[k] : NaN));
    agesC.setData({ xs, series: [{ label: 'Median age', color: C[0], values: pp('med') }, { label: 'Life expectancy at birth', color: C[3], values: pp('le') }] });
    vitalC.setData({ xs, series: [{ label: 'Births', color: C[1], values: pp('bpk') }, { label: 'Deaths', color: C[2], values: pp('dpk') }] });
    // the trades in groups (jobs.js order), per mille → shares
    const tr = (idx) => ys.map((r) => { const t = r.people?.tr; return Array.isArray(t) ? idx.reduce((a, k) => a + (t[k] || 0), 0) / 1000 : NaN; });
    const magic = tr([11, 12, 13, 14]);
    workC.setData({ xs, series: [
      { label: 'Farmers, herders and fishers', color: C[1], values: tr([0, 1, 2]) },
      { label: 'Craftsmen, miners and builders', color: C[0], values: tr([3, 4, 9]) },
      { label: 'Merchants', color: C[3], values: tr([5]) },
      { label: 'Clergy and scholars', color: '#b884d8', values: tr([7, 8]) },
      { label: 'Soldiers', color: C[2], values: tr([6]) },
      { label: 'Labourers', color: 'rgba(143,136,119,0.75)', values: tr([10]) },
      // the magical trades only where the world has them (Mythic)
      ...(magic.some((v) => v > 0) ? [{ label: 'Magical trades', color: '#a98be6', values: magic }] : []),
    ] });
    tradeC.setData({ xs, series: [{ label: 'Trade roads', color: C[0], values: col('routes') }] });
    wealthC.setData({ xs, series: [{ label: 'Treasuries', color: C[1], values: col('wealth') }] });
    landUse.setData({ xs, series: [
      { label: 'Farmland', color: C[0], values: col('farm') },
      { label: 'Claimed by nations', color: C[3], values: col('owned') },
      { label: 'Forest cover', color: C[1], values: col('forest') },
    ] });
  }

  function chartColors() {
    const cs = getComputedStyle(document.documentElement);
    return ['--chart-1', '--chart-2', '--chart-3', '--chart-4'].map((k, i) => cs.getPropertyValue(k).trim() || ['#bf8a2a', '#16a085', '#e0603f', '#5a86e0'][i]);
  }

  function buildTable(ys) {
    clear(tableBox);
    const cols = [
      ['Year', (r) => r.y], ['People', (r) => F.people(r.pop)], ['Nations', (r) => r.civs], ['Towns', (r) => r.towns],
      ['Land °C', (r) => F.fixed(r.landTemp, 1)], ['Sea m', (r) => F.signed(r.sea, 0)], ['CO₂', (r) => F.int(r.co2)],
      ['Forest', (r) => F.pct(r.forest)], ['Herds', (r) => F.fixed(r.herb, 3)], ['Wars', (r) => r.wars], ['Fallen', (r) => F.people(r.casualties || 0)],
      ['Plagues', (r) => r.plagues], ['Plague dead', (r) => F.people(r.pdeaths || 0)], ['Faiths', (r) => r.faiths], ['Roads', (r) => F.int(r.routes || 0)],
      ['Era', (r) => F.eraName(r.era)],
    ];
    const step = Math.max(1, Math.ceil(ys.length / 60));
    const rows = [];
    for (let k = ys.length - 1; k >= 0; k -= step) rows.push(ys[k]);
    const t = h('table.data', null,
      h('thead', null, h('tr', null, cols.map(([c]) => h('th', { scope: 'col', text: c })))),
      h('tbody', null, rows.map((r) => h('tr', null, cols.map(([, f]) => h('td', { text: String(f(r)) }))))),
    );
    tableBox.appendChild(t);
  }

  new ResizeObserver(() => { if (el.offsetParent !== null && !table) for (const c of charts) c.draw(); }).observe(el);
  app.on('theme', () => { sig = ''; if (el.offsetParent !== null) refresh(); });

  return {
    id: 'statistics', label: 'Statistics', title: 'Statistics', icon: 'statistics', el,
    show() { sig = ''; refresh(); },
    refresh,
    onWorld() { sig = ''; zoom = null; syncRange(); },
  };
}
