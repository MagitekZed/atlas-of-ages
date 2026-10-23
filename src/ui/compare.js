// Compare: two to four nations side by side and head to head — the 'compare' Inspector record
// (selection { kind: 'compare', id: 'a,b,c' }), registered by ./views/records.js. Shared
// charts of people, land, towns, treasury, stability and era over the centuries from each
// nation's ledger (sim/ledger.js; the yearly records for worlds saved before ledgers), each in
// its nation's colour; their ranks among the living; and the head-to-head ledger of every pair:
// wars and their outcomes, towns that changed hands between them, opinion, treaties, trade.
// The map tints only the compared nations (renderer selection { kind: 'civs', ids }).

import { DAYS_PER_YEAR } from '../core/constants.js';
import { liveCivs, civSettlements } from '../core/entities.js';
import { h, Binder, clear } from './dom.js';
import { TimeChart } from './charts.js';
import * as F from './format.js';
import { section, kv, rows, linkBtn, rulerName } from './inspector.js';

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const MAX = 4;
export const parseIds = (id) => [...new Set(String(id ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 0))].slice(0, MAX);

/** Select a comparison of these nations. */
export function openCompare(app, ids) {
  const list = parseIds(ids.join(',')).filter((id) => app.world?.civs[id]);
  if (list.length < 2) return false;
  app.select({ kind: 'compare', id: list.join(',') }, { focus: false });
  return true;
}

// the civ ledger's stored layout (sim/ledger.js CHANNELS.c)
const CIV_CH = ['pop', 'land', 'towns', 'treasury', 'stability', 'manpower', 'era', 'army', 'wars', 'prestige'];
const CIV_SCALE = [1, 1, 1, 1, 100, 1, 1, 1, 1, 10];

/** One civ's channel at each of the given years (nearest sample at or before; NaN outside its life). */
function civValues(w, id, ch, years) {
  const raw = w.history?.series?.c?.[id];
  const j = CIV_CH.indexOf(ch);
  if (raw && Array.isArray(raw.v) && j >= 0) {
    const C = CIV_CH.length;
    const n = Math.floor(raw.v.length / C);
    const end = raw.e ?? w.time.day;
    return years.map((y) => {
      const d = y * DAYS_PER_YEAR;
      if (d < raw.t0 || d > end + DAYS_PER_YEAR) return NaN;
      const k = Math.min(n - 1, Math.floor((d - raw.t0) / raw.st));
      if (k < 0) return NaN;
      if (k === n - 1 && raw.pn > 0 && Array.isArray(raw.p) && d >= raw.t0 + n * raw.st) return (j === 6 || j === 7 || j === 8 ? raw.p[j] : raw.p[j] / raw.pn) / CIV_SCALE[j];
      return raw.v[k * C + j] / CIV_SCALE[j];
    });
  }
  // fallback: the itemised yearly records [pop, territory, towns, era, power]
  const idx = { pop: 0, land: 1, towns: 2, era: 3 }[ch];
  if (idx == null) return years.map(() => NaN);
  const byYear = new Map();
  for (const r of w.history?.years || []) if (r.civ && r.civ[id]) byYear.set(r.y, r.civ[id][idx]);
  return years.map((y) => (byYear.has(y) ? byYear.get(y) : NaN));
}

/** Wars between two nations: [{ war, aSide: 'attacker'|'defender', won: bool|null }] */
function warsBetween(w, a, b) {
  const out = [];
  for (const q of w.wars) {
    const aAtt = q.attackers.includes(a), aDef = q.defenders.includes(a), bAtt = q.attackers.includes(b), bDef = q.defenders.includes(b);
    if (!((aAtt && bDef) || (aDef && bAtt))) continue;
    const won = q.active ? null : q.outcome === 'attackers' ? aAtt : q.outcome === 'defenders' ? aDef : null;
    out.push({ war: q, aSide: aAtt ? 'attacker' : 'defender', won });
  }
  return out;
}

/** Towns that passed between two nations in either direction (from the chains of title). */
function townsExchanged(w, a, b) {
  let ab = 0, ba = 0;
  for (const s of w.settlements) {
    if (!s || !Array.isArray(s.own)) continue;
    for (let k = 1; k < s.own.length; k++) {
      const from = s.own[k - 1][1], to = s.own[k][1];
      if (from === a && to === b) ab++; else if (from === b && to === a) ba++;
    }
  }
  return { ab, ba };
}

function rankOf(w, id, key) {
  const civs = liveCivs(w).slice().sort((p, q) => fin(q[key]) - fin(p[key]));
  const k = civs.findIndex((c) => c.id === id);
  return k < 0 ? null : k + 1;
}

const METRICS = [
  ['pop', 'People', (v) => F.axis(v), (v) => F.people(v)],
  ['land', 'Lands', (v) => F.axis(v * 400), (v) => F.areaShort(v)],
  ['towns', 'Settlements', (v) => F.int(v), (v) => F.int(v)],
  ['treasury', 'Treasury', (v) => F.axis(v), (v) => F.money(v)],
  ['stability', 'Stability', (v) => Math.round(v * 100) + '%', (v) => F.pct(v)],
  ['era', 'Era', (v) => F.int(v), (v) => F.eraName(v)],
];

export const compareView = {
  label: 'Comparison', icon: 'nations',
  describe(app, sel) {
    const ids = parseIds(sel.id).filter((id) => app.world.civs[id]);
    return { name: ids.map((id) => app.world.civs[id].name).join(' · ') || 'A comparison', sub: `${ids.length} nations side by side` };
  },
  point(w, id) {
    const pts = parseIds(id).map((c) => w.civs[c]).filter(Boolean).map((c) => w.settlements[c.capitalId] || { x: c.originX, y: c.originY });
    if (!pts.length) return null;
    return { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
  },
  frame(w, id) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const cid of parseIds(id)) { const c = w.civs[cid]; if (!c) continue; for (const s of civSettlements(w, c)) { x0 = Math.min(x0, s.x); y0 = Math.min(y0, s.y); x1 = Math.max(x1, s.x); y1 = Math.max(y1, s.y); } }
    return Number.isFinite(x0) ? { x0: x0 - 3, y0: y0 - 3, x1: x1 + 3, y1: y1 + 3 } : null;
  },
  rendererSel(w, id) { return { kind: 'civs', ids: parseIds(id).filter((c) => w.civs[c]) }; },
  mount(app, sel, el) {
    const w = app.world;
    const ids = parseIds(sel.id).filter((id) => w.civs[id]);
    const b = new Binder();
    if (ids.length < 2) { el.appendChild(h('p.empty-note', { text: 'Pick at least two nations to compare.' })); return null; }
    const civs = ids.map((id) => w.civs[id]);
    // the roster: remove one, add another
    const roster = h('div.tags.compare-roster');
    for (const c of civs) {
      const x = h('button.tag.is-link', { type: 'button', 'aria-label': `Remove ${c.name}` }, h('i.swatch', { style: { '--c': c.colorHex } }), c.name, ids.length > 2 ? h('span.x', { text: ' ×' }) : null);
      if (ids.length > 2) x.addEventListener('click', () => openCompare(app, ids.filter((q) => q !== c.id)));
      roster.appendChild(x);
    }
    if (ids.length < MAX) {
      const pick = h('select.field.compare-add', { 'aria-label': 'Add a nation to the comparison', id: 'compare-add' }, h('option', { value: '', text: 'Add a nation…' }),
        ...liveCivs(w).filter((c) => !ids.includes(c.id)).sort((p, q) => fin(q.population) - fin(p.population)).slice(0, 30).map((c) => h('option', { value: String(c.id), text: c.name })));
      pick.addEventListener('change', () => { if (pick.value !== '') openCompare(app, [...ids, Number(pick.value)]); });
      roster.appendChild(pick);
    }
    // charts
    const charts = [];
    const onHover = (y) => { for (const c of charts) c.setHoverYear(y); };
    const chartBox = h('div.compare-charts');
    for (const [key, label, axis, tipF] of METRICS) {
      const ch = new TimeChart({ title: label, height: 104, yFormat: axis, tipFormat: tipF, onHover, yMin: key === 'stability' ? 0 : 0, intTicks: key === 'towns' || key === 'era', agg: key === 'era' ? 'max' : 'mean', onPick: (y) => app.emit('timeTravel', y) });
      charts.push({ key, ch });
      chartBox.appendChild(ch.el);
    }
    let sig = '';
    const drawCharts = () => {
      const ys = w.history?.years || [];
      const first = Math.min(...civs.map((c) => Math.floor(fin(c.foundedDay) / DAYS_PER_YEAR)));
      const years = ys.map((r) => r.y).filter((y) => y >= first);
      const s = `${years.length}:${years[years.length - 1]}`;
      if (s === sig) return;
      sig = s;
      for (const { key, ch } of charts) ch.setData({ xs: years, series: civs.map((c, k) => ({ label: c.name + (c.alive ? '' : ' †'), color: c.colorHex, dash: k >= 2 ? [5, 3] : undefined, values: civValues(w, c.id, key, years) })) });
    };
    b.run(() => requestAnimationFrame(drawCharts));
    // standings today
    const table = h('table.data.compare-table');
    let tableAt = -1e9;
    b.run(() => {
      // standings move slowly: rebuild at most once a sim-month (links stay put under the pointer)
      if (Math.abs(w.time.day - tableAt) < 30) return;
      tableAt = w.time.day;
      clear(table);
      const rowsDef = [
        ['', (c) => h('span', null, h('i.swatch', { style: { '--c': c.colorHex } }), ' ', linkBtn(app, { kind: 'civ', id: c.id }, c.name, { strike: !c.alive }))],
        ['Government', (c) => F.titleCase(c.government || 'tribe')],
        ['Ruler', (c) => (c.ruler ? rulerName(c.ruler) : '—')],
        ['People', (c) => `${F.people(c.population)}${c.alive ? ` (#${rankOf(w, c.id, 'population')})` : ''}`],
        ['Lands', (c) => `${F.areaShort(c.territory)}${c.alive ? ` (#${rankOf(w, c.id, 'territory')})` : ''}`],
        ['Stability', (c) => F.pct(c.stability)],
        ['Treasury', (c) => F.money(c.treasury)],
        ['In the field', (c) => F.people(w.armies.filter((a) => a.civId === c.id).reduce((a, q) => a + fin(q.strength), 0))],
        ['Knowledge', (c) => `${F.eraName(c.tech?.era)} · ${Object.keys(c.tech?.known || {}).length} arts`],
        ['State faith', (c) => (c.stateReligion != null && w.religions[c.stateReligion] ? F.headName(w.religions[c.stateReligion].name) : 'Folk beliefs')],
        ['Fortune', (c) => (c.goldenAge > 0 ? 'Golden age' : c.darkAge > 0 ? 'Dark age' : c.alive ? 'Ordinary times' : `Fell ${F.year(c.fallenDay)}`)],
      ];
      for (const [label, fn] of rowsDef) {
        const tr = h('tr', null, h('th', { scope: 'row', text: label }));
        for (const c of civs) { const v = fn(c); tr.appendChild(h('td', null, typeof v === 'string' ? v : v)); }
        table.appendChild(tr);
      }
    });
    // head to head
    const pairs = [];
    for (let i = 0; i < civs.length; i++) for (let j = i + 1; j < civs.length; j++) pairs.push([civs[i], civs[j]]);
    const h2h = h('div.compare-h2h');
    for (const [A, B] of pairs) {
      const box = h('div.h2h');
      const head = h('h5.sub-head', null, h('i.swatch', { style: { '--c': A.colorHex } }), ` ${A.name} and `, h('i.swatch', { style: { '--c': B.colorHex } }), ` ${B.name}`);
      const facts = kv(b, [
        { k: 'Wars between them', v: () => { const ws = warsBetween(w, A.id, B.id); const won = ws.filter((x) => x.won === true).length, lost = ws.filter((x) => x.won === false).length; return ws.length ? `${ws.length} · ${A.adjective} won ${won}, lost ${lost}` : 'Never at war'; } },
        { k: 'Fallen in those wars', v: () => F.people(warsBetween(w, A.id, B.id).reduce((a, x) => a + fin(x.war.casualties?.[A.id]) + fin(x.war.casualties?.[B.id]), 0)) },
        { k: 'Towns exchanged', v: () => { const t = townsExchanged(w, A.id, B.id); return t.ab + t.ba ? `${t.ba} to ${A.name}, ${t.ab} to ${B.name}` : 'None'; }, txt: true },
        { k: 'Opinion', v: () => { const r = A.relations?.[B.id]; return r ? `${F.opinionWord(r.opinion)} (${F.signed(r.opinion, 0)})` : 'No contact'; } },
        { k: 'Treaties', v: () => (A.relations?.[B.id]?.treaties || []).map(F.treatyName).join(', ') || 'None', txt: true },
        { k: 'Trade', v: () => { const r = A.relations?.[B.id]; return r && r.trade > 0 ? F.num(r.trade, 1) + ' a month' : 'None'; } },
        { k: 'Truce', v: () => { const r = A.relations?.[B.id]; return r && r.truceUntil > w.time.day ? `until ${F.year(r.truceUntil)}` : 'None'; } },
      ]);
      const list = rows(b, () => warsBetween(w, A.id, B.id).slice().reverse().slice(0, 8).map((x) => ({ key: 'w' + x.war.id + x.war.active, icon: 'war', label: F.headName(x.war.name), n: x.war.active ? 'ongoing' : x.won === true ? `${A.adjective} won` : x.won === false ? `${B.adjective} won` : 'no victor', s: F.lifespan(x.war.startDay, x.war.endDay), sel: { kind: 'war', id: x.war.id } })), 'They have never fought.', app);
      box.append(head, facts, list);
      h2h.appendChild(box);
    }
    el.append(section('Nations', roster), section('Over the centuries', chartBox), section('Standing today', h('div.table-wrap', null, table)), section('Head to head', h2h));
    b.update();
    return { update: () => b.update() };
  },
};
