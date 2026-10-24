// Fixture frames (docs/design/ui/kit/IDENTITY.md §8.1): the fixtures on the map (cartouche, time
// bridge, legend, instrument case) are opaque plates with re-entrant, cut-in corners, an outer
// rule, a 3px gap and an inner hairline, and a ground keyline against the map. CSS cannot draw
// the cut-in corner, so the frame is an SVG laid behind the fixture's content and redrawn
// whenever the fixture changes size. A fixture hung from the neatline is open at the top; one
// standing on it is open at the bottom.

import { svgNode } from './dom.js';

const R = 10.5;          // corner radius of the outer rule
const INNER = 4;         // the inner hairline stands this far inside

/** The frame's path at inset i (corner radius r), open on one side or closed. */
function framePath(w, h, i, r, open) {
  const a = Math.sqrt(Math.max(0, r * r - i * i));
  const L = i, T = i, Rt = w - i, B = h - i;
  if (open === 'top') {
    // down the left side, across the foot, up the right side: the corners turn the other way
    return `M${L} 0V${h - a}A${r} ${r} 0 0 1 ${a} ${B}H${w - a}A${r} ${r} 0 0 1 ${Rt} ${h - a}V0`;
  }
  if (open === 'bottom') {
    return `M${L} ${h}V${a}A${r} ${r} 0 0 0 ${a} ${T}H${w - a}A${r} ${r} 0 0 0 ${Rt} ${a}V${h}`;
  }
  return `M${a} ${T}H${w - a}A${r} ${r} 0 0 0 ${Rt} ${a}V${h - a}A${r} ${r} 0 0 0 ${w - a} ${B}H${a}A${r} ${r} 0 0 0 ${L} ${h - a}V${a}A${r} ${r} 0 0 0 ${a} ${T}Z`;
}

/**
 * Give el an engraved fixture frame. open: null (closed), 'top' or 'bottom'. The element gets
 * the class "fixture"; its own content must sit above the frame (the CSS puts the frame at z 0).
 */
export function fixtureFrame(el, { open = null } = {}) {
  const svg = svgNode('svg', { class: 'fx-frame', 'aria-hidden': 'true' });
  const fill = svgNode('path', { class: 'fx-fill' });
  const outer = svgNode('path', { class: 'fx-rule' });
  const inner = svgNode('path', { class: 'fx-hair' });
  svg.append(fill, outer, inner);
  el.classList.add('fixture');
  el.prepend(svg);
  let lastW = -1, lastH = -1;
  const draw = () => {
    const w = el.offsetWidth, h = el.offsetHeight;
    if (!w || !h || (w === lastW && h === lastH)) return;
    lastW = w; lastH = h;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', w); svg.setAttribute('height', h);
    const d = framePath(w, h, 0.5, R, open);
    // a closed path fills; an open one is closed along its open side for the fill only
    fill.setAttribute('d', open ? `${d}Z` : d);
    outer.setAttribute('d', d);
    inner.setAttribute('d', framePath(w, h, 0.5 + INNER, R + INNER, open));
  };
  try { new ResizeObserver(draw).observe(el); } catch (e) { /* no observer: drawn once */ }
  draw();
  return { redraw: () => { lastW = -1; draw(); } };
}
