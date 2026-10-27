// The hand (chunk 10, docs/design/seeing-and-hand.md): an act's own record (what was done, where,
// how strongly, its measures before and after, and what came of it), and the Hand tab: your acts,
// newest first, and Lessons of the hand, a card per power gathered from your own history.
// Read-only: everything comes from world.sys.hand (sim/hand.js) and the tools' own definitions.

import { DAYS_PER_YEAR } from '../../core/constants.js';
import { TOOL_GROUPS, getTool } from '../../core/tools.js';
import { h, Binder } from '../dom.js';
import * as F from '../format.js';
import { registerView } from '../registry.js';
import { section, kv, cells, rows } from '../inspector.js';
import { setPref } from '../prefs.js';
import { MEASURES, actOf, reportText } from '../../sim/hand.js';

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
const fmt = (how, v) => (v == null ? '—' : how === 'l' ? (Math.round(v * 100) / 100).toFixed(2) : how === 'n' ? F.int(v) : Math.abs(v) >= 1000 ? F.int(v) : (Math.round(v * 100) / 100).toString());

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
    if (!act) return note('This act has passed out of the hand’s record (it keeps the last 300).');
    const btn = h('button.btn', { type: 'button', text: 'See the hand at work on the map' });
    btn.addEventListener('click', () => showOnHandMap(app));
    const repLine = (which) => {
      const p = h('p.ins-prose');
      b.text(p, () => (act[which] ? reportText(w, act, which) : `Not yet: ${which === 'end' ? 'when its work is done' : 'a generation on'}, in Year ${yearOf(which === 'end' ? act.endDay : act.genDay)}.`));
      return p;
    };
    const table = rows(b, () => measureRows(act).map(([label, how, b0, b1, e, g], k) => ({
      key: `m${k}:${e != null}:${g != null}`, label, n: `${fmt(how, b0)} → ${fmt(how, b1)}`, s: `at its end ${fmt(how, e)} · a generation on ${fmt(how, g)}`,
    })), 'Nothing was measured.', app);
    return [
      (() => { const p = h('p.ins-lead'); b.text(p, () => `${labelOf(act)} ${act.name || ''}, in Year ${yearOf(act.day)}${act.str != null ? `, at strength ${F.num(act.str, 1)}` : ''}${act.kind === 'area' ? `, over ${F.int(Math.round(act.r))} tiles around ${act.pts && act.pts.length > 1 ? `${act.pts.length} points` : 'one point'}` : ''}${act.land ? `, on ${act.land}` : ''}.`); return p; })(),
      cells(b, [
        { k: 'Its work', v: () => (w.time.day < act.endDay ? `until Year ${yearOf(act.endDay)}` : 'done') },
        { k: 'Reports', v: () => `${(act.end ? 1 : 0) + (act.gen ? 1 : 0)} of 2` },
        { k: 'Power', v: () => GROUP[act.grp] || 'The hand' },
      ]),
      h('div.ins-actions', null, btn),
      section('What came of it', repLine('end'), repLine('gen')),
      section('Before → right after', table),
    ];
  }),
};

export function mount(app) {
  registerView('act', actView);
}
