// The deed card: one card per act of the divine hand. When a god tool, a pair act or a
// divine act succeeds, its status message and the Chronicle's "Divine Hand" entry for it
// (written in the same moment, or within 1.5 s) become a single card — the tool, its
// strength, the sentence — with Undo (when it is still the last act), Inspect and Watch.
// The chronicle entry it absorbs is kept out of the toast column (a toast filter), so the
// act is told once. A continuous stroke updates its card instead of raising new ones.

import { chronicleSince } from '../core/chronicle.js';
import { getTool, TOOL_GROUPS } from '../core/tools.js';
import { settlementAt } from '../core/entities.js';
import { registerToastFilter } from './registry.js';
import { actionToast, statusToast } from './toasts.js';

const MERGE_MS = 1500;     // a chronicle entry this soon after the act belongs to it
const STROKE_MS = 1200;    // applies of one tool this close together are one stroke

export function mount(app) {
  app.deedCards = true;     // input.js and acts.js leave successful acts' messages to us
  let deed = null;          // { toolId, card, t, texts: [], absorbed: Set, ivSeq, target, x, y, label }
  let mark = 0;             // chronicle seq already looked at

  app.on('world', (w) => { mark = w.chronicle.seq; deed = null; });
  app.on('worldRestored', () => { mark = app.world?.chronicle.seq || 0; deed = null; });
  app.on('tick', () => { if (deed && performance.now() - deed.t > MERGE_MS * 4) deed = null; if (app.world && !deed) mark = app.world.chronicle.seq; });

  app.on('toolApplied', (p) => {
    const w = app.world;
    if (!w || !p || !p.result || p.result.ok === false) return;
    const t = getTool(p.id);
    if (!t) return;
    const nowT = performance.now();
    // the divine entries this act wrote, before the hook fired
    const fresh = chronicleSince(w, mark).filter((e) => e.cat === 'divine' || e.day === w.time.day && e.imp >= 2 && (e.x === p.x && e.y === p.y));
    mark = w.chronicle.seq;
    if (deed && deed.toolId === p.id && nowT - deed.t < STROKE_MS && p.kind === 'tool') {
      deed.t = nowT;
      deed.n++;
      for (const e of fresh) absorb(e);
      paint();
      return;
    }
    deed = {
      toolId: p.id, tool: t, t: nowT, n: 1, texts: [], absorbed: new Set(), ivSeq: p.seq,
      kind: p.kind, x: p.x, y: p.y, opts: p.opts || {}, message: p.result.message || '',
      target: p.kind === 'entity' ? p.opts?.target : p.kind === 'pair' ? p.opts?.b : null,
    };
    for (const e of fresh) absorb(e);
    deed.card = actionToast(app, {
      icon: t.icon || t.id, kicker: kicker(t, deed.opts), title: t.label, text: '', ms: 9000, cls: 'is-deed',
      actions: actions(deed),
    });
    paint();
  });

  function absorb(e) {
    if (!deed || deed.absorbed.has(e.seq)) return;
    deed.absorbed.add(e.seq);
    if (deed.texts.length < 2) deed.texts.push(e.text);
  }

  function paint() {
    if (!deed?.card) return;
    const text = deed.texts.length ? deed.texts.join(' ') : deed.message || 'It is done.';
    deed.card.update({ text: deed.n > 1 && !deed.texts.length ? `${text} (${deed.n} touches)` : text });
  }

  function kicker(t, opts) {
    const g = TOOL_GROUPS.find((x) => x.id === t.group)?.label || 'The divine hand';
    const s = t.strength;
    if (s && Number.isFinite(opts.strength) && Number.isFinite(s.min) && Number.isFinite(s.max)) {
      const v = opts.strength;
      const txt = s.unit ? `${v} ${s.unit}` : s.max <= 1.0001 && s.min >= 0 ? Math.round(v * 100) + '%' : Math.abs(v) >= 10 ? String(Math.round(v)) : Number(v).toFixed(1);
      return `${g} · ${s.label || 'Strength'} ${txt}`;
    }
    return g;
  }

  /** What the act touched, as a selection: its target, else the town or ground where it fell. */
  function subjectOf(d) {
    const w = app.world;
    if (!w) return null;
    if (d.target && d.target.kind && d.target.id != null) return { kind: d.target.kind, id: d.target.id };
    if (!Number.isFinite(d.x) || !Number.isFinite(d.y)) return null;
    const x = Math.round(d.x), y = Math.round(d.y);
    if (x < 0 || y < 0 || x >= w.W || y >= w.H) return null;
    const s = settlementAt(w, y * w.W + x);
    if (s && s.alive) return { kind: 'settlement', id: s.id };
    return { kind: 'tile', id: y * w.W + x, x, y };
  }

  function actions(d) {
    const out = [];
    if (app.chrono) out.push({ label: 'Undo', run: () => undoDeed(d) });
    out.push({ label: 'Inspect', run: () => { const s = subjectOf(d); if (s) app.select(s, { focus: true }); } });
    if (app.toggleWatch) out.push({ label: 'Watch', run: () => { const s = subjectOf(d); if (!s) return; const civ = s.kind === 'tile' ? app.world.f.owner[s.id] : -1; app.toggleWatch(s.kind === 'tile' && civ >= 0 ? { kind: 'civ', id: civ } : s); } });
    return out;
  }

  function undoDeed(d) {
    const last = app.chrono?.lastAct?.();
    if (!last) { statusToast(app, 'That act can no longer be undone.', 'info', { icon: 'hourglass' }); return; }
    if (d.ivSeq != null && !(d.ivSeq >= last.seq0 && d.ivSeq < last.seq1)) {
      statusToast(app, `Other acts came after it; undo ${last.label} first (Ctrl Z).`, 'info', { icon: 'hourglass' });
      return;
    }
    app.chrono.undo();
  }

  // the entries a deed card tells are not told again in the toast column
  registerToastFilter((a, e) => {
    if (!deed) return null;
    if (deed.absorbed.has(e.seq)) return { suppress: true };
    if (e.cat === 'divine' && performance.now() - deed.t < MERGE_MS && e.seq > mark - 1) { absorb(e); paint(); return { suppress: true }; }
    return null;
  });
}
