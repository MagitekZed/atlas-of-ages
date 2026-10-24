// Past borders: while the Atlas shows a plate, today's map stays under it, dimmed, and the
// plate's borders stand over it in dashed ivory (its frontier with unclaimed land in a finer
// dash), with the land that has changed hands since hatched. Reads renderer.past (built by
// setAtlasSnapshot); draws nothing without it. Never imports ./renderer.js.

import { registerLayer } from './layers.js';

function draw(r, ctx, env) {
  const past = r.past, w = r.world;
  if (!past || !w) return;
  const z = env.z, vb = env.vb;
  ctx.fillStyle = 'rgba(10, 16, 23, 0.45)';
  ctx.fillRect(-0.5, -0.5, w.W, w.H);
  if (past.changed) {
    ctx.save();
    ctx.clip(past.changed);
    ctx.strokeStyle = 'rgba(237, 227, 203, 0.4)';
    ctx.lineWidth = 1 / z;
    const gap = 6 / z, span = vb.y1 - vb.y0;
    ctx.beginPath();
    for (let x = vb.x0 - span; x < vb.x1; x += gap) { ctx.moveTo(x, vb.y1); ctx.lineTo(x + span, vb.y0); }
    ctx.stroke();
    ctx.restore();
  }
  if (!past.borders) return;
  const px = Math.max(1.2, Math.min(2.4, 0.9 + z * 0.05));
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(10, 16, 23, 0.7)';
  ctx.lineWidth = (px + 2) / z;
  past.borders.stroke(ctx, vb);
  ctx.strokeStyle = 'rgba(237, 227, 203, 0.95)';
  ctx.lineWidth = px / z;
  ctx.setLineDash([5 / z, 3.5 / z]);
  past.borders.stroke(ctx, vb);
  if (past.frontier) {
    ctx.strokeStyle = 'rgba(237, 227, 203, 0.55)';
    ctx.setLineDash([2 / z, 3 / z]);
    past.frontier.stroke(ctx, vb);
  }
  ctx.setLineDash([]);
  ctx.lineCap = 'butt';
}

registerLayer({ id: 'atlas.past', slot: 'overTerritory', order: 5, draw });
