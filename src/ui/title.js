// The title screen: the first thing the atlas shows. A title page stands on the left (the name,
// then a Contents of what to do: Continue the world left open, begin a New World by the rite or
// skip it with Default or Random, Load a World, Every key) and an astrolabe drawn for 45.6° N
// hangs on the right: its rete turns slowly with the sky and its rule settles on today. The map
// of a fresh world lies dimmed behind it all. It opens with a short splash (the page and the
// instrument come in one after the other) and stands aside for whatever is chosen.

import { MONTH_NAMES, DAYS_PER_MONTH, DAYS_PER_YEAR } from '../core/constants.js';
import { h, svgNode, clear } from './dom.js';
import { fixtureFrame } from './frame.js';
import { latestResume, loadSlot, listSlots } from './saves.js';
import { people, int } from './format.js';

const LAT = 45.6;          // the plate is cut for this latitude
const OBLIQUITY = 23.44;

/**
 * Mount the title screen. hooks: { backdrop(canvas), onNew(), onDefault(), onRandom(), onLoad(),
 * onKeys() }. Returns { show(), hide(), get visible() }.
 */
export function mountTitle(app, hooks = {}) {
  const root = h('section.title-screen', { id: 'title', 'aria-label': 'Atlas of Ages', hidden: true });
  const backdrop = h('canvas.ts-backdrop', { 'aria-hidden': 'true' });
  const neat = h('div.ts-neat', { 'aria-hidden': 'true' });

  // --- the title page ----------------------------------------------------------------
  const lockup = h('h1.ts-title', null, h('span.ts-big', { text: 'Atlas' }),
    h('span.ts-of', null, h('span.ts-of-rule'), h('i', { text: 'of' }), h('span.ts-of-rule')), h('span.ts-big', { text: 'Ages' }));
  const contents = h('ol.contents.ts-menu');
  const entry = (n, name, { value = '', gloss = '', act = null, extra = null, cur = false } = {}) => {
    const nameEl = act ? h('button.ct-name', { type: 'button', text: name }) : h('span.ct-name', { text: name });
    if (act) nameEl.addEventListener('click', act);
    const row = h('div.ct', { class: cur ? 'is-cur' : '' }, h('span.ct-n', { text: n }), nameEl, h('span.ct-lead'), extra || h('span.ct-val', { text: value }));
    if (gloss) row.appendChild(h('p.ct-gloss', { text: gloss }));
    const li = h('li', null, row);
    contents.appendChild(li);
    return { li, row, nameEl };
  };

  // Continue: the world left open, with its card (thumbnail, date, numbers)
  const contCard = h('div.ts-save', { hidden: true });
  const cont = entry('I', 'Continue', { value: '', act: () => resume(), cur: true });
  cont.li.appendChild(contCard);
  let resumeMeta = null;
  async function resume() {
    if (!resumeMeta) return;
    cont.nameEl.disabled = true;
    try { await loadSlot(app, resumeMeta.id); hide(); } catch (e) { cont.nameEl.disabled = false; }
  }
  const skip = h('span.ts-skip', null,
    btn('Default', 'Begin at once with the default settings', () => { hide(); hooks.onDefault?.(); }),
    btn('Random', 'Begin at once with a world of chance', () => { hide(); hooks.onRandom?.(); }));
  entry('II', 'New World', { extra: skip, gloss: 'Set the world’s conditions step by step, or skip with the defaults or a world of chance', act: () => { hide(); hooks.onNew?.(); } });
  const load = entry('III', 'Load a World', { value: '', act: () => hooks.onLoad?.() });
  entry('IV', 'Every key', { value: 'Keyboard and mouse', act: () => hooks.onKeys?.() });

  const soundIn = h('input', { id: 'ts-sound', type: 'checkbox' });
  const sound = h('label.switch.ts-sound', { for: 'ts-sound' }, soundIn, h('span.track'), h('span', { text: 'Sound' }));
  soundIn.addEventListener('change', () => app.sound?.setOn(soundIn.checked));
  const foot = h('div.ts-foot', null, sound, h('span.ts-keys', null, h('kbd', { text: 'Enter' }), ' continue  ', h('kbd', { text: '?' }), ' every key'));
  const page = h('div.ts-page', null,
    h('div.ts-page-in', null, h('p.ts-kicker', { text: 'A world simulator that runs by itself' }), lockup, h('div.dbl'), contents, foot));
  const astro = buildAstrolabe();
  root.append(backdrop, neat, page, astro.el);
  document.body.appendChild(root);
  fixtureFrame(page);

  function btn(text, tipText, fn) {
    const b = h('button.btn', { type: 'button', text, title: tipText });
    b.addEventListener('click', fn);
    return b;
  }

  async function refreshSaves() {
    resumeMeta = await latestResume();
    cont.li.hidden = !resumeMeta;
    const NUM = ['I', 'II', 'III', 'IV', 'V'];
    [...contents.children].filter((li) => !li.hidden).forEach((li, k) => { const n = li.querySelector('.ct-n'); if (n) n.textContent = NUM[k]; });
    contents.querySelectorAll('.ct').forEach((r) => r.classList.remove('is-cur'));
    (resumeMeta ? cont.row : contents.querySelectorAll('.ct')[1])?.classList.add('is-cur');
    if (resumeMeta) {
      const m = resumeMeta;
      cont.row.querySelector('.ct-val').textContent = m.worldName || '';
      clear(contCard);
      contCard.hidden = false;
      if (m.thumb) contCard.appendChild(h('img.ts-thumb', { src: m.thumb, alt: '' }));
      contCard.appendChild(h('div.ts-save-t', null,
        h('b', { text: `${m.worldName} · Year ${int(m.year)}` }),
        h('span', { text: `${int(m.nations)} nations · ${people(m.pop)} people` })));
    }
    try {
      const n = (await listSlots()).filter((m) => !m.resume).length;
      load.row.querySelector('.ct-val').textContent = n ? `${n} saved` : 'From a file';
    } catch (e) { /* no saves to count */ }
  }

  function onKey(e) {
    if (root.hidden) return;
    if (e.key === 'Enter' && document.activeElement === document.body) { e.preventDefault(); if (resumeMeta) resume(); else { hide(); hooks.onNew?.(); } }
    else if (e.key === '?' ) { e.preventDefault(); hooks.onKeys?.(); }
  }
  window.addEventListener('keydown', onKey);

  function show() {
    root.hidden = false;
    root.classList.remove('is-intro');
    void root.offsetWidth;
    root.classList.add('is-intro');
    soundIn.checked = Boolean(app.sound?.on);
    astro.settle();
    refreshSaves().catch(() => {});
    try { hooks.backdrop?.(backdrop); } catch (e) { /* the title stands without its map */ }
  }
  function hide() { root.hidden = true; }
  app.on('world', hide);
  return { show, hide, get visible() { return !root.hidden; } };
}

/**
 * The astrolabe, cut for latitude 45.6° N: the mater's limb graduated one day a degree and
 * lettered with the months, a plate (tympan) with the tropics, the equator, the horizon and the
 * almucantars, the twilight band hatched, the rete with the ecliptic and a few star pointers
 * (it turns slowly, as the sky does), and the rule, which settles on today when the page opens.
 */
function buildAstrolabe() {
  const S = 300;
  const svg = svgNode('svg', { class: 'astrolabe', viewBox: `${-S} ${-S - 44} ${2 * S} ${2 * S + 50}`, 'aria-hidden': 'true' });
  const defs = svgNode('defs');
  const hatch = svgNode('pattern', { id: 'as-hatch', width: 5, height: 5, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(-45)' });
  hatch.appendChild(svgNode('line', { x1: 0, y1: 0, x2: 0, y2: 5, class: 'as-hatch-line' }));
  const clip = svgNode('clipPath', { id: 'as-plate-clip' });
  const Re = 150;
  const tanHalf = (deg) => Math.tan(((deg / 2) * Math.PI) / 180);
  const Rk = Re * tanHalf(90 + OBLIQUITY), Rc = Re * tanHalf(90 - OBLIQUITY);
  clip.appendChild(svgNode('circle', { r: Rk }));
  defs.append(hatch, clip);
  svg.appendChild(defs);

  // the mater: throne and shackle at the top, the limb
  const add = (tag, attrs, parent = svg) => { const n = svgNode(tag, attrs); parent.appendChild(n); return n; };
  add('path', { class: 'as-throne', d: `M-26 ${-S + 6}Q0 ${-S - 30} 26 ${-S + 6}` });
  add('circle', { class: 'as-ring', cy: -S - 26, r: 11 });
  add('circle', { class: 'as-ring-in', cy: -S - 26, r: 6.5 });
  add('circle', { class: 'as-case', r: S - 2 });
  add('circle', { class: 'as-face', r: S - 4 });
  add('circle', { class: 'as-l1', r: S - 18 });
  add('circle', { class: 'as-days dayticks', r: S - 22, pathLength: 360, 'stroke-dasharray': '0.18 0.82', 'stroke-dashoffset': 0.09 });
  add('circle', { class: 'as-fives', r: S - 23.5, pathLength: 360, 'stroke-dasharray': '0.3 4.7', 'stroke-dashoffset': 0.15 });
  add('circle', { class: 'as-l1', r: S - 28 });
  add('circle', { class: 'as-months', r: S - 40, pathLength: 360, 'stroke-dasharray': '0.4 29.6', 'stroke-dashoffset': 0.2 });
  add('circle', { class: 'as-l2', r: S - 52 });
  // months lettered on the limb, upright wherever they fall; the year starts at the top
  const monthAngle = (m) => -90 + (m + 0.5) * DAYS_PER_MONTH;
  const monthLabels = MONTH_NAMES.map((name, m) => {
    const a = monthAngle(m), t = (a * Math.PI) / 180, r = S - 40;
    const x = Math.cos(t) * r, y = Math.sin(t) * r;
    const rot = a > 0 && a < 180 ? a - 90 : a + 90;
    const tx = add('text', { class: 'as-month', 'text-anchor': 'middle', 'dominant-baseline': 'middle', transform: `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rot.toFixed(1)})` });
    tx.textContent = name;
    return tx;
  });

  // the plate: tropics, equator, horizon and almucantars (stereographic, from the south pole)
  const plate = add('g', { class: 'as-plate', 'clip-path': 'url(#as-plate-clip)' });
  const phi = (LAT * Math.PI) / 180;
  const alm = (altDeg) => {
    const a = (altDeg * Math.PI) / 180, k = Math.sin(phi) + Math.sin(a);
    return { cy: -Re * Math.cos(phi) / k, r: Re * Math.cos(a) / k };
  };
  const tw = alm(-18), hz = alm(0);
  add('path', { class: 'as-twilight', 'fill-rule': 'evenodd', d: `${circleD(0, tw.cy, tw.r)}${circleD(0, hz.cy, hz.r)}` }, plate);
  add('circle', { class: 'as-l2', r: Rc }, plate);
  add('circle', { class: 'as-l2', r: Re }, plate);
  add('circle', { class: 'as-l2', r: Rk }, plate);
  for (let alt = 0; alt <= 80; alt += 10) { const c = alm(alt); add('circle', { class: alt === 0 ? 'as-horizon' : 'as-alm', cy: c.cy.toFixed(2), r: c.r.toFixed(2) }, plate); }
  add('path', { class: 'as-l1', d: `M0 ${-Rk}V${Rk}M${-Rk} 0H${Rk}` }, plate);
  const lat = add('text', { class: 'as-lat', y: (Re * 0.62).toFixed(1), 'text-anchor': 'middle' }, plate);
  lat.textContent = 'Latitude 45.6° North';

  // the rete: the ecliptic ring and star pointers; it turns with the sky
  const rete = add('g', { class: 'as-rete' });
  const eclR = (Rk + Rc) / 2, eclOff = (Rk - Rc) / 2;
  add('circle', { class: 'as-ecl', cy: -eclOff.toFixed(2), r: eclR.toFixed(2) }, rete);
  add('circle', { class: 'as-ecl-in', cy: -eclOff.toFixed(2), r: (eclR - 9).toFixed(2) }, rete);
  add('circle', { class: 'as-l1', r: Rk }, rete);
  for (const [ang, r] of [[18, 196], [75, 120], [140, 205], [205, 168], [262, 112], [318, 182]]) {
    const t = (ang * Math.PI) / 180, x = Math.cos(t) * r, y = Math.sin(t) * r;
    const x0 = Math.cos(t) * (r + 26), y0 = Math.sin(t) * (r + 26);
    add('path', { class: 'as-star', d: `M${x0.toFixed(1)} ${y0.toFixed(1)}L${x.toFixed(1)} ${y.toFixed(1)}` }, rete);
    add('path', { class: 'as-loz', d: `M${x.toFixed(1)} ${(y - 4).toFixed(1)}L${(x + 3).toFixed(1)} ${y.toFixed(1)}L${x.toFixed(1)} ${(y + 4).toFixed(1)}L${(x - 3).toFixed(1)} ${y.toFixed(1)}Z` }, rete);
  }
  // the rule: a brass bar through the pin, pointing at today on the limb
  const rule = add('g', { class: 'as-rule' });
  // the rule reaches the inner edge of the lettered ring, so it points at the month, never across it
  add('path', { class: 'as-rule-bar', d: `M${-S + 54} -3L${S - 66} -1.2L${S - 66} 1.2L${-S + 54} 3Z` }, rule);
  add('path', { class: 'as-rule-tip', d: `M${S - 54} 0L${S - 68} -5L${S - 68} 5Z` }, rule);
  add('circle', { class: 'as-pin', r: 7 });
  add('circle', { class: 'as-pin-in', r: 2.5 });

  return {
    el: svg,
    /** Bring the rule round to today (the newest saved world's day, else midwinter), and letter its month in brass. */
    settle(day = null) {
      const d = Number.isFinite(day) ? day : Math.floor(Date.now() / 86400000) % DAYS_PER_YEAR;
      const doy = ((d % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR;
      const m = Math.floor(doy / DAYS_PER_MONTH);
      monthLabels.forEach((t, k) => t.classList.toggle('is-now', k === m));
      rule.style.transform = 'rotate(-200deg)';
      void rule.getBoundingClientRect();
      requestAnimationFrame(() => { rule.style.transform = `rotate(${(-90 + doy).toFixed(1)}deg)`; });
    },
  };
}

const circleD = (cx, cy, r) => `M${(cx - r).toFixed(2)} ${cy.toFixed(2)}a${r.toFixed(2)} ${r.toFixed(2)} 0 1 0 ${(2 * r).toFixed(2)} 0a${r.toFixed(2)} ${r.toFixed(2)} 0 1 0 ${(-2 * r).toFixed(2)} 0Z`;
