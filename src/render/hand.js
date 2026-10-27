// The hand on the map (chunk 10, docs/design/seeing-and-hand.md): a map mode that rings every act of
// the divine hand still at work (sim/hand.js: before its endDay) in the power's tone, at its brush,
// its town or its realm's seat, a thread between the two things a pair act joined, and a label
// with the power and the time it has left. The rings are clickable (r.hits, kind 'act').

import { registerLayer, registerMapMode } from './layers.js';
import * as P from './palette.js';
import { getTool } from '../core/tools.js';
import { DAYS_PER_YEAR, DAYS_PER_MONTH } from '../core/constants.js';

const TONE = { boon: [240, 198, 96], bane: [208, 70, 56], neutral: [214, 210, 196] };
const toneOf = (id) => TONE[(getTool(id) || {}).polarity] || TONE.neutral;

/** The acts still at work, with where to draw them: [{ act, pts, r, line }]. */
function atWork(w) {
  const h = w && w.sys && w.sys.hand;
  if (!h || !Array.isArray(h.acts)) return [];
  const day = w.time.day, out = [];
  const where = (t) => {
    if (!t) return null;
    if (t.kind === 'settlement') { const s = w.settlements[t.id]; return s && s.alive ? [s.x, s.y, 2] : null; }
    if (t.kind === 'civ') { const c = w.civs[t.id]; const s = c && c.alive ? w.settlements[c.capitalId] : null; return s ? [s.x, s.y, 3.5] : null; }
    return Number.isFinite(t.x) ? [t.x, t.y, 2] : null;
  };
  for (const act of h.acts) {
    if (!(act.endDay > day)) continue;
    if (act.kind === 'area') out.push({ act, pts: act.pts && act.pts.length ? act.pts : [[act.x, act.y]], r: Math.max(1.5, act.r) });
    else if (act.kind === 'pair') {
      const a = where(act.a), b = where(act.b);
      if (a || b) out.push({ act, pts: [a, b].filter(Boolean).map((q) => [q[0], q[1]]), r: 2, line: a && b ? [a, b] : null });
    } else { const q = where(act.tgt); if (q) out.push({ act, pts: [[q[0], q[1]]], r: q[2] }); }
  }
  return out;
}

const left = (d) => {
  const y = Math.floor(d / DAYS_PER_YEAR), m = Math.floor((d % DAYS_PER_YEAR) / DAYS_PER_MONTH);
  return y ? `${y} yr${m ? ` ${m} mo` : ''} left` : `${Math.max(1, m)} mo left`;
};

registerMapMode({
  id: 'hand', label: 'The hand', desc: 'Where your acts are still at work, and how long each has left.',
  profile: { style: 'muted', region: null, borders: 0.6, settle: 1, labelsCiv: true, detail: 'peaks', routesK: 0, clouds: false },
  legend: () => ({
    title: 'The hand at work', type: 'swatches',
    items: [{ label: 'A blessing', color: P.css(TONE.boon) }, { label: 'A curse or a catastrophe', color: P.css(TONE.bane) }, { label: 'Other acts', color: P.css(TONE.neutral) }],
  }),
});

registerLayer({
  id: 'hand.rings', slot: 'overTerritory', order: 60,
  draw(r, ctx, env) {
    if (env.mode !== 'hand') return;
    const z = env.z, pulse = 0.8 + 0.2 * Math.sin(env.now * 0.003);
    for (const it of atWork(r.world)) {
      const rgb = toneOf(it.act.tool);
      if (it.line) {
        ctx.strokeStyle = P.css(rgb, 0.85); ctx.lineWidth = 2 / z; ctx.setLineDash([5 / z, 4 / z]);
        ctx.beginPath(); ctx.moveTo(it.line[0][0], it.line[0][1]); ctx.lineTo(it.line[1][0], it.line[1][1]); ctx.stroke(); ctx.setLineDash([]);
      }
      for (const [x, y] of it.pts) {
        ctx.beginPath(); ctx.arc(x, y, it.r, 0, Math.PI * 2);
        ctx.fillStyle = P.css(rgb, 0.1); ctx.fill();
        ctx.strokeStyle = 'rgba(16,10,8,0.5)'; ctx.lineWidth = 4 / z; ctx.stroke();
        ctx.strokeStyle = P.css(rgb, 0.9 * pulse); ctx.lineWidth = 2 / z; ctx.stroke();
      }
    }
  },
});

registerLayer({
  id: 'hand.labels', slot: 'hud', order: 60,
  draw(r, ctx, env) {
    if (env.mode !== 'hand') return;
    const w = r.world, day = w.time.day;
    ctx.font = '600 11px "Cormorant Garamond", Georgia, serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const it of atWork(w)) {
      const [x, y] = it.pts[0];
      const { sx, sy } = r.e2s(x, y);
      const t = getTool(it.act.tool);
      const text = `${t ? t.label : it.act.tool} · ${left(it.act.endDay - day)}`;
      const ty = sy - (it.r * env.z) - 10;
      const tw = ctx.measureText(text).width + 10;
      ctx.fillStyle = 'rgba(20,14,10,0.72)'; ctx.fillRect(sx - tw / 2, ty - 8, tw, 16);
      ctx.fillStyle = P.css(toneOf(it.act.tool), 1); ctx.fillText(text, sx, ty);
      const rr = Math.max(10, it.r * env.z);
      (r.hits ||= []).push({ kind: 'act', id: it.act.id, x0: sx - rr, y0: sy - rr, x1: sx + rr, y1: sy + rr, pri: 3 });
    }
  },
});
