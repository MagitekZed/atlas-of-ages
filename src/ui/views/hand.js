// The hand (chunk 10, docs/design/seeing-and-hand.md): an act's own record (what was done, where,
// how strongly, its measures before and after, and what came of it), and the Hand tab: your acts,
// newest first, and Lessons of the hand, a card per power gathered from your own history.
// Read-only: everything comes from world.sys.hand (sim/hand.js) and the tools' own definitions.

import { DAYS_PER_YEAR } from '../../core/constants.js';
import { TOOL_GROUPS, getTool } from '../../core/tools.js';
import { h, Binder } from '../dom.js';
import * as F from '../format.js';
import { registerView, registerTab } from '../registry.js';
import { section, kv, cells, rows } from '../inspector.js';
import { setPref, getPref } from '../prefs.js';
import { MEASURES, actOf, reportRows, whenWords, shareWords, focusOf, changeOf } from '../../sim/hand.js';

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const note = (text) => h('p.empty-note', { text });
const yearOf = (day) => Math.floor(fin(day) / DAYS_PER_YEAR);
const GROUP = Object.fromEntries(TOOL_GROUPS.map((g) => [g.id, g.label]));
const labelOf = (act) => { const t = getTool(act.tool); return t ? t.label : act.tool; };

function mounted(build) {
  return (app, sel, el) => {
    const b = new Binder();
    let nodes;
    try { nodes = build(app, sel, b); } catch (e) { app.reportError('hand.view', e); nodes = [note(`This record could not be shown: ${e.message}`)]; }
    for (const n of [].concat(nodes)) if (n) el.appendChild(n);
    b.update();
    return { update: () => b.update() };
  };
}

/** The measures of an act as rows: [label, how, before, after, end, gen]. */
function measureRows(act) {
  const out = [];
  const add = (kind, off, prefix = '') => {
    const defs = MEASURES[kind] || [];
    defs.forEach(([id, words, how], k) => {
      if (how === 'id') return;
      const at = (rep) => (rep && Array.isArray(rep.m) ? rep.m[off + k] : null);
      out.push([`${prefix}${words.replace(/^./, (x) => x.toUpperCase())}`, how, at(act.m0), at(act.m1), at(act.end), at(act.gen)]);
      void id;
    });
    return defs.length;
  };
  if (act.kind === 'pair') {
    const ka = act.a && act.a.kind === 'civ' ? 'realm' : act.a && act.a.kind === 'settlement' ? 'town' : 'area';
    const kb = act.b && act.b.kind === 'civ' ? 'realm' : act.b && act.b.kind === 'settlement' ? 'town' : 'area';
    const na = add(ka, 0, 'First: ');
    add(kb, na, 'Second: ');
  } else add(act.kind, 0);
  return out;
}
const fmt = (how, v) => (v == null ? '—' : how === 'l' ? (Math.round(v * 100) / 100).toFixed(2) : how === 'n' || Math.abs(v) >= 10 ? F.int(Math.round(v)) : (Math.round(v * 100) / 100).toString());

export function showOnHandMap(app) {
  app.r('setMapMode', 'hand');
  setPref('mapMode', 'hand');
  app.emit('mapmode', 'hand');
}

// ---------------------------------------------------------------------------
// An act

export const actView = {
  label: 'Act of the hand', icon: 'divine',
  describe(app, sel) {
    const act = actOf(app.world, sel.id);
    if (!act) return { name: 'A forgotten act' };
    return { name: `${labelOf(act)} ${act.name || ''}`.trim(), sub: `Year ${yearOf(act.day)} · ${GROUP[act.grp] || 'The hand'}` };
  },
  point(w, id) { const act = actOf(w, id); return act && Number.isFinite(act.x) ? { x: act.x, y: act.y } : null; },
  mount: mounted((app, sel, b) => {
    const w = app.world, act = actOf(w, sel.id);
    if (!act) return note('This act has passed out of the hand’s record (it keeps the last 150).');
    const btn = h('button.btn', { type: 'button', text: 'See the hand at work on the map' });
    btn.addEventListener('click', () => showOnHandMap(app));
    // What came of it: a small table for each moment, the place beside the world over the same years
    const phase = (which) => {
      const rep = which === 'now' ? act.m1 : act[which];
      const day = which === 'now' ? act.day : rep && typeof rep === 'object' ? rep.day : which === 'end' ? act.endDay : act.genDay;
      const head = h('p.hand-when', { text: `${whenWords(act, which)} · Year ${yearOf(day)}` });
      if (!rep) return h('div.hand-phase', null, head, note(`Not yet: this report comes in Year ${yearOf(day)}.`));
      const list = reportRows(w, act, which, 4);
      if (!list.length) return h('div.hand-phase', null, head, note(which === 'now' ? 'Nothing it measures moved at once.' : 'Little changed there beyond the way of the world.'));
      const cmp = which !== 'now';
      const cell = (words, num, r, cls = '') => h(`td${cls}`, null, r && r.dir ? h(`span.hand-arrow.${r.tone > 0 ? 'boon' : r.tone < 0 ? 'bane' : 'even'}`, { text: r.dir > 0 ? '▲' : '▼' }) : null, words || '—', num ? h('span.hand-num', { text: num }) : null);
      const table = h('table.data.hand-report', null,
        h('thead', null, h('tr', null, h('th'), h('th', { text: 'Here' }), cmp ? h('th', { text: 'Across the world' }) : null)),
        h('tbody', null, ...list.map((r) => h('tr', null, h('th', { scope: 'row', text: r.label }), cell(r.here, r.num, r), cmp ? cell(r.world, r.wnum, null, '.world') : null))));
      return h('div.hand-phase', null, head, table);
    };
    const reports = h('div.hand-reports');
    b.list(reports, () => (act.c ? [{ key: 'folded' }] : [...(act.m1 && act.kind !== 'pair' ? [{ key: 'now', which: 'now' }] : []), ...['end', 'gen'].map((which) => ({ key: `${which}:${Boolean(act[which])}`, which }))]),
      (it) => it.key, (it) => (it.which ? phase(it.which) : h('p.ins-prose', { text: 'This older act has been folded into the Lessons of the hand: its main measures are kept there, and its two reports are in the Chronicle.' })));
    // every measure at the four moments
    const tbody = h('tbody');
    b.list(tbody, () => (act.c ? [] : measureRows(act)).map(([label, how, b0, b1, e, g], k) => ({ key: `m${k}:${e != null}:${g != null}`, label, how, vals: [b0, b1, e, g] })),
      (r) => r.key, (r) => h('tr', null, h('th', { scope: 'row', text: r.label }), ...r.vals.map((v) => h('td', { text: fmt(r.how, v) }))));
    const numbers = act.c ? note('Its numbers were folded into the Lessons of the hand.') : h('table.data.hand-numbers', null,
      h('thead', null, h('tr', null, h('th'), h('th', { text: 'Before' }), h('th', { text: 'Right after' }), h('th', { text: whenWords(act, 'end') }), h('th', { text: 'A generation on' }))), tbody);
    return [
      (() => { const p = h('p.ins-lead'); b.text(p, () => `${labelOf(act)} ${act.name || ''}, in Year ${yearOf(act.day)}${act.str != null ? `, at strength ${F.num(act.str, 1)}` : ''}${act.kind === 'area' ? `, over ${F.int(Math.round(act.r))} ${Math.round(act.r) === 1 ? 'tile' : 'tiles'} around ${act.pts && act.pts.length > 1 ? `${act.pts.length} points` : 'one point'}` : ''}${act.land ? `, on ${act.land}` : ''}.`); return p; })(),
      cells(b, [
        { k: 'Its work', v: () => (w.time.day < act.endDay ? `until Year ${yearOf(act.endDay)}` : 'done') },
        { k: 'Reports', v: () => `${(act.end ? 1 : 0) + (act.gen ? 1 : 0)} of 2` },
        { k: 'Power', v: () => GROUP[act.grp] || 'The hand' },
      ]),
      h('div.ins-actions', null, btn),
      section('What came of it', reports),
      section('The numbers', numbers),
    ];
  }),
};

// ---------------------------------------------------------------------------
// Lessons of the hand: what each power has done, from your own acts

const median = (xs) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };

const say = (how, v) => (how === 'q' ? `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v * 100))} %` : how === 'l' ? `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v * 100)) / 100}` : `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v * 10) / 10)}`);
const words = (act, id) => { const d = (MEASURES[act.kind] || []).find((q) => q[0] === id); return d ? d[1] : id; };

/** The strength band of an act: 'light' | 'middling' | 'strong' | null. */
function band(act) {
  const t = getTool(act.tool);
  if (!t || !t.strength || act.str == null) return null;
  const lo = fin(t.strength.min, 0), hi = fin(t.strength.max, 1);
  const q = hi > lo ? (act.str - lo) / (hi - lo) : 0.5;
  return q < 0.34 ? 'light' : q < 0.67 ? 'middling' : 'strong';
}

/** A Lessons card for one power: its uses and what typically came of it. */
function lessonCard(w, tool, acts, refused) {
  const t = getTool(tool);
  const card = h('article.lesson');
  card.append(h('h4.rule-head', { text: t ? t.label : tool }));
  const last = acts[acts.length - 1];
  const bands = {};
  for (const a of acts) { const k = band(a); if (k) bands[k] = (bands[k] || 0) + 1; }
  const bandWords = Object.entries(bands).map(([k, n]) => `${n} ${k}`).join(', ');
  const used = acts.length === 1 ? `Used once, in Year ${yearOf(last.day)}` : `Used ${acts.length} times, last in Year ${yearOf(last.day)}`;
  card.append(h('p.ins-sub', { text: GROUP[last.grp] || 'The hand' }));
  card.append(h('p.ins-prose', { text: `${used}${bandWords ? `: ${bandWords}` : ''}.` }));
  const lines = [];
  for (const which of ['now', 'end', 'gen']) {
    const done = which === 'now' ? acts.filter((a) => a.m1 || (a.c && a.L && a.L.n && a.L.n.length)) : acts.filter((a) => a[which]);
    if (!done.length) continue;
    const focus = focusOf(done[0]).filter((id) => (MEASURES[done[0].kind] || []).some((d) => d[0] === id)).slice(0, 2);
    for (const id of focus) {
      const all = done.map((a) => changeOf(a, which, id)).filter(Boolean);
      if (!all.length) continue;
      const how = all[0].how;
      const m = median(all.map((x) => x.v));
      // by the kind of land, and by strength, where the acts differ
      const by = (keyFn) => {
        const g = {};
        for (const a of done) { const k = keyFn(a); const c = changeOf(a, which, id); if (k && c) (g[k] ||= []).push(c.v); }
        const ks = Object.keys(g);
        return ks.length > 1 ? ks.sort((p, q) => g[q].length - g[p].length).slice(0, 4).map((k) => `${k} ${say(how, median(g[k]))} (${g[k].length})`).join('; ') : '';
      };
      const land = by((a) => a.land), str = by(band);
      if (how === 'n' ? Math.round(m * 10) === 0 : Math.abs(m) < 0.005) continue;   // (nothing to tell)
      const told = which === 'now' && how === 'q' ? `${shareWords(m)} (${say(how, m)})` : `${say(how, m)}${which === 'now' ? '' : ' against the world'}`;
      lines.push(`${which === 'now' ? 'At once' : which === 'end' ? 'When its work was done' : 'A generation on'}: ${words(done[0], id)} ${told}${all.length > 1 ? ` (the middle of ${all.length} acts)` : ''}${land ? `. By land: ${land}` : ''}${str ? `. By strength: ${str}` : ''}.`);
    }
  }
  if (!lines.length) lines.push('No report has come in yet: the first will come when its work is done.');
  for (const l of lines) card.append(h('p.ins-prose', { text: l }));
  if (refused && Object.keys(refused).length) {
    const n = Object.values(refused).reduce((a, v) => a + v, 0);
    card.append(h('p.ins-prose', { text: `Refused ${n} ${n === 1 ? 'time' : 'times'}: ${Object.entries(refused).sort((p, q) => q[1] - p[1]).slice(0, 3).map(([why, k]) => `“${why.replace(/[.\s]+$/, '')}”${k > 1 ? ` (${k})` : ''}`).join('; ')}.` }));
  }
  return card;
}

// ---------------------------------------------------------------------------
// The Hand tab

function handTab(app, el) {
  const b = new Binder();
  el.classList.add('hand-tab');
  const leaves = [['acts', 'Your acts'], ['lessons', 'Lessons of the hand']];
  let leaf = getPref('hand.leaf', 'acts');
  const seg = h('div.seg', { role: 'tablist', 'aria-label': 'The hand' });
  const lead = h('p.ins-lead');
  const mapBtn = h('button.btn', { type: 'button', text: 'See the hand at work on the map' });
  mapBtn.addEventListener('click', () => showOnHandMap(app));
  const actsBox = h('div.hand-acts'), lessonsBox = h('div.hand-lessons');
  const btns = leaves.map(([id, label]) => {
    const x = h('button', { type: 'button', role: 'tab', text: label });
    x.addEventListener('click', () => { leaf = id; setPref('hand.leaf', id); paint(true); });
    return [id, x];
  });
  for (const [, x] of btns) seg.appendChild(x);
  const st = () => (app.world && app.world.sys && app.world.sys.hand) || { acts: [], refused: {} };
  const actRows = rows(b, () => st().acts.slice(-80).reverse().map((a) => {
    const w = app.world, day = w.time.day;
    const status = day < a.endDay ? `at work until Year ${yearOf(a.endDay)}` : a.gen ? 'both reports in' : a.end ? `reported; a generation on in Year ${yearOf(a.genDay)}` : 'reporting soon';
    return { key: `a${a.id}:${Boolean(a.end)}:${Boolean(a.gen)}:${day < a.endDay}`, icon: 'divine', label: `${labelOf(a)} ${a.name || ''}`.trim(), n: `Year ${yearOf(a.day)}`, s: status, sel: { kind: 'act', id: a.id } };
  }), 'You have not yet reached into this world. Every act of the hand will be listed here, and will report back what came of it.', app);
  actsBox.append(actRows);
  el.append(lead, seg, h('div.ins-actions', null, mapBtn), actsBox, lessonsBox);
  b.text(lead, () => {
    const s = st(), n = s.acts.length;
    const reps = s.acts.reduce((k, a) => k + (a.end ? 1 : 0) + (a.gen ? 1 : 0), 0);
    return n ? `${F.int(n)} ${n === 1 ? 'act' : 'acts'} of your hand remembered, ${F.int(reps)} ${reps === 1 ? 'report' : 'reports'} come in. Each act reports when its work is done and again a generation later, beside the rest of the world over the same years.` : 'The hand has not yet touched this world.';
  });
  let lessonsKey = '';
  const paint = (force = false) => {
    for (const [id, x] of btns) x.setAttribute('aria-selected', String(id === leaf));
    actsBox.hidden = leaf !== 'acts';
    lessonsBox.hidden = leaf !== 'lessons';
    if (leaf !== 'lessons') return;
    const s = st();
    const key = `${s.n}:${s.acts.reduce((k, a) => k + (a.end ? 1 : 0) + (a.gen ? 1 : 0), 0)}:${JSON.stringify(s.refused).length}`;
    if (!force && key === lessonsKey) return;
    lessonsKey = key;
    lessonsBox.textContent = '';
    const byTool = new Map();
    for (const a of s.acts) (byTool.get(a.tool) || byTool.set(a.tool, []).get(a.tool)).push(a);
    const tools = [...byTool.entries()].sort((p, q) => q[1].length - p[1].length);
    for (const id of Object.keys(s.refused || {})) if (!byTool.has(id)) tools.push([id, []]);
    if (!tools.length) { lessonsBox.append(note('Lessons come from your own acts: use a power, and what came of it will be gathered here.')); return; }
    for (const [id, acts] of tools) {
      if (!acts.length) { const card = h('article.lesson'); card.append(h('h4.rule-head', { text: getTool(id)?.label || id })); lessonsBox.append(card); lessonsCardRefusals(card, s.refused[id]); continue; }
      lessonsBox.append(lessonCard(app.world, id, acts, s.refused[id]));
    }
  };
  paint(true);
  b.update();
  return { update: () => { b.update(); paint(); }, show: () => { b.update(); paint(true); } };
}

function lessonsCardRefusals(card, refused) {
  const n = Object.values(refused || {}).reduce((a, v) => a + v, 0);
  card.append(h('p.ins-prose', { text: n ? `Never done; refused ${n} ${n === 1 ? 'time' : 'times'}: ${Object.entries(refused).sort((p, q) => q[1] - p[1]).slice(0, 3).map(([why, k]) => `“${why.replace(/[.\s]+$/, '')}”${k > 1 ? ` (${k})` : ''}`).join('; ')}.` : 'Never done.' }));
}

export function mount(app) {
  registerView('act', actView);
  registerTab({
    id: 'hand', label: 'Hand', key: 'J', icon: 'divine', order: 55,
    desc: 'Your acts of the divine hand, what came of each, and the lessons they teach about every power.',
    mount: handTab,
  });
}
