// The HUD: the cartouche (world name, the age it lives in, seasons, the world's numbers) and
// the time bridge that hangs from the top neatline (the speed governor, the volvelle that turns
// one day a degree under a fixed brass index, the bob that pauses, and the leaps: Leap, Run
// until, Story). On a phone the bridge folds to a compact drive (bob, speed, finder, menu); the
// menu opens the Contents (src/ui/contents.js). The Leap dialog offers "run until…" beside its
// fixed spans; the keyboard card lives in src/ui/keys.js.

import { SPEEDS, MONTH_NAMES, DAYS_PER_YEAR, DAYS_PER_MONTH } from '../core/constants.js';
import { dateString, seasonName, yearOf } from '../core/world.js';
import { h, clear, svgEl, setText, svgNode } from './dom.js';
import { glyph } from './icons.js';
import { tip, openModal, msText, openPopover, closePopover } from './widgets.js';
import { people, eraName, int } from './format.js';
import { summarize } from '../sim/stats.js';
import { openContents } from './contents.js';
import { fixtureFrame } from './frame.js';

// WP1's world ages (pure readers), shown beside the date. Loaded lazily, never as a top-level
// await: the single-file bundle must not wait on the sim modules while the UI mounts.
let eventsMod = null;
import('../sim/events/index.js').then((m) => { eventsMod = m; }).catch(() => { /* no ages without the event deck */ });

export function mountHud(app) {
  const cart = document.getElementById('cartouche');
  const drive = document.getElementById('drive');
  clear(cart); clear(drive);

  // --- cartouche --------------------------------------------------------------------
  const dial = buildDial();    // the phone's small year-dial; the desktop reads the volvelle
  const name = h('h1.world-name', { text: '' });
  // the year keeps its place on a narrow screen: the month and day give way first
  const dateMD = h('span.date-md', { text: '' });
  const dateY = h('span.date-y', { text: '' });
  const date = h('span.date', null, dateMD, dateY);
  const season = h('span.season', { text: '' });
  const ages = h('button.age-chip', { type: 'button', hidden: true });
  let agesSig = '';
  ages.addEventListener('click', () => { const k = ages.dataset.key; if (k) app.select({ kind: 'event', id: 'age:' + k }); });
  const stats = {
    pop: stat('Pop.', 'statistics', 'World population. Opens the statistics.'),
    civs: stat('Nations', 'nations', 'Living nations. Opens the ledger.'),
    wars: stat('Wars', 'nations', 'Wars being fought now.'),
    faiths: stat('Faiths', 'chronicle', 'Living religions.'),
    plagues: stat('Plagues', 'chronicle', 'Active outbreaks.'),
    era: stat('Era', 'nations', 'The most advanced age any nation has reached.'),
  };
  stats.era.el.classList.add('is-era');   // wraps rather than being cut (styles.css)
  const headline = h('div.headline', null, Object.values(stats).map((s) => s.el));
  const cartIn = h('div.cart-in', null, h('div.cart-name', null, dial.el, name), ages, h('div.date-line', null, date, season),
    h('div.rule-loz', { 'aria-hidden': 'true' }, h('span.loz')), headline);
  cart.append(cartIn);
  fixtureFrame(cart);

  function stat(label, tab, desc) {
    const v = h('span.v', { text: '—' });
    const el = h('button.stat.stat-btn', { type: 'button' }, h('span.k', { text: label }), v);
    tip(el, desc, label);
    el.addEventListener('click', () => { app.setTab(tab); app.emit('layout', 'open-panel'); });   // a folded panel opens to show it
    return { el, v };
  }

  // --- the time bridge ------------------------------------------------------------------
  const play = h('button.play.bob', { type: 'button', 'aria-label': 'Pause' });
  tip(play, 'Pause or resume time.', 'Pause', 'Space');
  play.addEventListener('click', () => app.togglePause());
  // the governor: six detents on one graduated rule, the index under the speed it runs at
  const notches = h('div.seg.governor', { role: 'group', 'aria-label': 'Speed' });
  const notchBtns = [];
  for (let k = 1; k < SPEEDS.length; k++) {
    const s = SPEEDS[k];
    const b = h('button', { type: 'button', text: String(k), 'aria-label': `${s.label} speed` });
    tip(b, s.dps === Infinity ? 'As fast as this device allows.' : `${s.dps} days each second.`, s.label, String(k));
    b.addEventListener('click', () => app.setSpeed(k));
    notches.appendChild(b);
    notchBtns.push(b);
  }
  // on a phone the governor folds to the speed's name over a small rule; a tap lists the speeds
  const cycleName = h('span.sc-name');
  const cycle = h('button.speed-cycle', { type: 'button', 'aria-label': 'Change speed', 'aria-haspopup': 'true' },
    h('span.sc-top', null, cycleName, svgEl(glyph('chevron', 12))), h('span.sc-rule', { 'aria-hidden': 'true' }));
  cycle.addEventListener('click', () => {
    const list = h('div.speed-list', { role: 'listbox', 'aria-label': 'Speed' });
    for (let k = 1; k < SPEEDS.length; k++) {
      const s = SPEEDS[k];
      const on = k === (app.speed || app.lastSpeed || 2);
      const b = h('button.menu-item', { type: 'button', role: 'option', 'aria-selected': String(on), class: on ? 'is-on' : '' },
        h('span.t', { text: s.label }), h('span.hint', { text: s.dps === Infinity ? 'as fast as it goes' : `${s.dps} days a second` }));
      b.addEventListener('click', () => { closePopover(); app.setSpeed(k); });
      list.appendChild(b);
    }
    openPopover(cycle, list, { align: 'end', cls: 'menu' });
  });
  const speedName = h('b.name');
  const speedRate = h('span.rate');
  const speedLabel = h('p.speed-label', null, speedName, h('span.sep-dot', { text: ' · ' }), speedRate);
  const status = h('button.icon-btn.warn-chip', { type: 'button', hidden: true });
  status.appendChild(svgEl(glyph('help', 18)));
  status.addEventListener('click', () => { app.setTab('world'); app.emit('layout', 'open-panel'); app.emit('engineRoom'); });
  const menuBtn = h('button.icon-btn.menu-btn', { type: 'button', 'aria-label': 'Menu', 'aria-haspopup': 'dialog' });
  menuBtn.appendChild(svgEl(glyph('menu', 20)));
  tip(menuBtn, 'Resume, save and load, a new world, options and every key.', 'Contents');
  menuBtn.addEventListener('click', () => openContents(app));
  const layersBtn = h('button.icon-btn.layers-phone', { type: 'button', 'aria-label': 'Map layers' });
  layersBtn.appendChild(svgEl(glyph('layers', 18)));
  layersBtn.addEventListener('click', () => app.emit('toggleDockPhone'));
  // the Director (story mode) and the finder (command palette), when their modules are here
  const storyBtn = h('button.leap-btn.story-btn', { type: 'button', 'aria-label': 'Story mode', 'aria-pressed': 'false', hidden: true }, svgEl(glyph('eye', 20)), h('span.story-label', { text: 'Story' }));
  tip(storyBtn, 'The Director flies to great events as they happen and tells them.', 'Story mode', 'G');
  storyBtn.addEventListener('click', () => app.director?.toggle());
  const findBtn = h('button.icon-btn.find-btn', { type: 'button', 'aria-label': 'Find anything', hidden: true }, svgEl(glyph('search', 18)));
  tip(findBtn, 'Find any place, people, war or command.', 'Find', '/');
  findBtn.addEventListener('click', () => app.openCommand?.(''));
  const leapBtn = h('button.leap-btn', { type: 'button', 'aria-label': 'Leap ahead' }, svgEl(glyph('leap', 20)), h('span', { text: 'Leap' }));
  tip(leapBtn, 'Leap years ahead at full speed.', 'Leap ahead', 'J');
  leapBtn.addEventListener('click', () => openLeap(app));
  const untilBtn = h('button.leap-btn', { type: 'button', 'aria-label': 'Run until', hidden: true }, svgEl(glyph('hourglass', 20)), h('span', { text: 'Run until' }));
  tip(untilBtn, 'Run time on until something happens.', 'Run until', 'U');
  untilBtn.addEventListener('click', () => app.openUntil?.());
  const volvelle = buildVolvelle();
  const gov = h('div.gov', null, notches, speedLabel);
  const leaps = h('nav.leaps', { 'aria-label': 'Leaps in time' }, leapBtn, untilBtn, storyBtn);
  drive.append(gov, volvelle.el, play, leaps, cycle, findBtn, status, layersBtn, menuBtn);
  // on a phone: the map mode and the finder stand over the tab bar
  const modeName = h('span.mc-name');
  const modeChip = h('button.chip-btn.mode-chip', { type: 'button', 'aria-label': 'Map mode, legend and minimap' }, modeName, svgEl(glyph('chevronRight', 14)));
  modeChip.addEventListener('click', () => app.emit('toggleDockPhone'));
  const findChip = h('button.chip-btn.find-chip', { type: 'button', 'aria-label': 'Find anything' }, svgEl(glyph('search', 15)), h('span', { text: 'Find' }));
  findChip.addEventListener('click', () => app.openCommand?.(''));
  const syncMode = () => setText(modeName, app.mapModes?.().find((m) => m.id === (app.renderer?.mapMode || 'terrain'))?.label || 'Terrain');
  app.on('mapmode', syncMode);
  app.on('world', syncMode);
  document.querySelector('.hud-bottom')?.prepend(h('div.phone-chips', null, modeChip, findChip));
  fixtureFrame(drive, { open: 'top' });
  const syncStory = () => {
    storyBtn.hidden = !app.director;
    untilBtn.hidden = !app.openUntil;
    findBtn.hidden = !app.openCommand;
    const on = Boolean(app.director?.on);
    storyBtn.classList.toggle('is-on', on);
    storyBtn.setAttribute('aria-pressed', String(on));
  };
  app.on('director', syncStory);
  app.on('world', syncStory);

  function refreshSpeed() {
    const k = app.speed;
    clear(play);
    play.appendChild(svgEl(glyph(k === 0 ? 'play' : 'pause', 20)));
    play.setAttribute('aria-label', k === 0 ? 'Resume' : 'Pause');
    // paused, the index stays on the speed time will resume at
    const at = k === 0 ? app.lastSpeed || 2 : k;
    notchBtns.forEach((b, j) => {
      b.classList.toggle('is-on', j + 1 === at);
      b.setAttribute('aria-pressed', j + 1 === at ? 'true' : 'false');
    });
    const s = SPEEDS[k];
    setText(speedName, k === 0 ? 'Paused' : s ? s.label : '');
    drive.classList.toggle('is-paused', k === 0);
    setText(cycleName, k === 0 ? 'Paused' : SPEEDS[at].label);
    cycle.style.setProperty('--at', String(at - 1));
    refreshRate();
  }

  function refreshRate() {
    const k = app.speed;
    if (!app.world) { setText(speedRate, ''); return; }
    if (k === 0) { setText(speedRate, 'time stands still'); return; }
    volvelle.setPace(k);
    const dps = app.measured.dps || SPEEDS[k].dps;
    if (!Number.isFinite(dps)) { setText(speedRate, 'measuring…'); return; }   // Max, before its first second
    const ypm = (dps / DAYS_PER_YEAR) * 60;
    const days = Math.round(dps);
    setText(speedRate, dps >= DAYS_PER_YEAR / 2 ? `${ypm >= 100 ? int(ypm) : ypm.toFixed(1)} years a minute` : `${days} ${days === 1 ? 'day' : 'days'} a second`);
  }

  function refresh() {
    const w = app.world;
    if (!w) return;
    setText(name, w.name);
    const ds = dateString(w), cut = ds.lastIndexOf(', Year ');
    setText(dateMD, cut >= 0 ? ds.slice(0, cut + 1) : ds);
    setText(dateY, cut >= 0 ? ds.slice(cut + 2) : '');
    date.title = ds;
    const tilt = Number(w.params.axialTilt);
    if (Number.isFinite(tilt) && tilt < 3) setText(season, 'No seasons: the world stands upright');
    else setText(season, `${seasonName(w, 0)} in the north · ${seasonName(w, w.H - 1)} in the south`);
    dial.set(w.time.day);
    volvelle.set(w.time.day, yearOf(w));
    refreshAges(w);
    const s = summarize(w);
    setText(stats.pop.v, people(s.pop));
    setText(stats.civs.v, String(s.civs));
    setText(stats.wars.v, String(s.wars));
    stats.wars.v.classList.toggle('is-alert', s.wars > 0);
    setText(stats.faiths.v, String(s.faiths));
    setText(stats.plagues.v, String(s.plagues));
    stats.plagues.v.classList.toggle('is-alert', s.plagues > 0);
    stats.plagues.el.hidden = s.plagues === 0;
    headline.classList.toggle('has-plague', s.plagues > 0);
    // a soft hyphen in a long single word (Renaissance) lets it break rather than leave the row
    setText(stats.era.v, eraName(s.era).replace(/\b([A-Za-z]{6})([A-Za-z]{5,})\b/g, '$1\u00ad$2'));
    // an era that had to leave the row starts its own line flush left
    stats.era.el.classList.toggle('is-alone', stats.era.el.offsetTop > stats.pop.el.offsetTop + 4);
    refreshRate();
    const offline = app.loadErrors.length;
    status.hidden = offline === 0 && !app.renderInfo.fallback;
    const msg = app.renderInfo.fallback ? 'The full map renderer is not loaded; a simplified map is shown.' : '';
    tip(status, `${offline ? `${offline} module${offline === 1 ? '' : 's'} did not load. ` : ''}${msg} Open the engine room for details.`, 'Instrument warning');
  }

  /** The age(s) the world is living through (WP1 currentAges): short name, tone, the reason as tooltip. */
  function refreshAges(w) {
    let list = [];
    try { list = eventsMod?.currentAges ? eventsMod.currentAges(w) || [] : []; } catch (e) { list = []; }
    const sig = list.map((a) => a.key + ':' + a.from).join('|');
    if (sig === agesSig) return;
    agesSig = sig;
    ages.hidden = !list.length;
    if (!list.length) return;
    const a = list[0];
    ages.dataset.key = a.key;
    ages.className = `age-chip is-${a.tone || 'neutral'}`;
    const ageName = (n) => (/^the\b/i.test(n) ? n.replace(/^The\b/, 'the') : `the ${n}`);
    setText(ages, `in ${list.map((x) => ageName(x.short || x.name)).join(' · ')}`);
    tip(ages, `${list.map((x) => `${x.name}: ${x.desc || ''}${x.why ? ` (${x.why})` : ''}`).join(' ')} Open its record.`, a.name);
  }

  app.on('speed', refreshSpeed);
  app.on('tick', refresh);
  app.on('world', () => { refresh(); refreshSpeed(); });
  refreshSpeed();
  setTimeout(syncStory, 0);
}

/** The year-dial: twelve month ticks, four season arcs, and a hand on today's date. */
function buildDial() {
  const svg = svgNode('svg', { class: 'dial', viewBox: '-26 -26 52 52', 'aria-hidden': 'true' });
  svg.appendChild(svgNode('circle', { r: 24, fill: 'none', stroke: 'currentColor', 'stroke-opacity': 0.5, 'stroke-width': 1 }));
  svg.appendChild(svgNode('circle', { r: 17.5, fill: 'none', stroke: 'currentColor', 'stroke-opacity': 0.35, 'stroke-width': 0.8 }));
  // season arcs (northern): winter months 11,0,1 … drawn as faint bands
  const seasons = [[-1.5, 1.5, 0.08], [1.5, 4.5, 0.22], [4.5, 7.5, 0.4], [7.5, 10.5, 0.22]];
  for (const [a0, a1, op] of seasons) {
    const t0 = (a0 / 12) * Math.PI * 2 - Math.PI / 2, t1 = (a1 / 12) * Math.PI * 2 - Math.PI / 2;
    const R = 21;
    const d = `M ${Math.cos(t0) * R} ${Math.sin(t0) * R} A ${R} ${R} 0 0 1 ${Math.cos(t1) * R} ${Math.sin(t1) * R}`;
    svg.appendChild(svgNode('path', { d, fill: 'none', stroke: 'currentColor', 'stroke-opacity': op + 0.25, 'stroke-width': 3.2 }));
  }
  for (let m = 0; m < 12; m++) {
    const t = (m / 12) * Math.PI * 2 - Math.PI / 2;
    const r0 = m % 3 === 0 ? 14.5 : 16;
    svg.appendChild(svgNode('line', { x1: Math.cos(t) * r0, y1: Math.sin(t) * r0, x2: Math.cos(t) * 17.5, y2: Math.sin(t) * 17.5, stroke: 'currentColor', 'stroke-width': m % 3 === 0 ? 1.2 : 0.8 }));
  }
  const hand = svgNode('g');
  hand.appendChild(svgNode('line', { x1: 0, y1: 3, x2: 0, y2: -20, stroke: 'var(--brass-hi)', 'stroke-width': 1.6, 'stroke-linecap': 'round' }));
  hand.appendChild(svgNode('circle', { cx: 0, cy: -20, r: 1.6, fill: 'var(--brass-hi)' }));
  svg.appendChild(hand);
  svg.appendChild(svgNode('circle', { r: 2.4, fill: 'var(--slate-1)', stroke: 'var(--brass-hi)', 'stroke-width': 1.2 }));
  const title = svgNode('title');
  svg.appendChild(title);
  let lastDay = -1;
  return {
    el: svg,
    set(day) {
      if (day === lastDay) return;
      lastDay = day;
      const doy = day % DAYS_PER_YEAR;
      hand.setAttribute('transform', `rotate(${((doy / DAYS_PER_YEAR) * 360).toFixed(2)})`);
      title.textContent = MONTH_NAMES[Math.floor(doy / DAYS_PER_MONTH)];
    },
  };
}

/**
 * The volvelle: a dial hung from the top neatline whose rings turn one day a degree under a
 * fixed brass index (360 days, twelve months of thirty). Day ticks, five-day ticks and month
 * ticks are dashes on circles (pathLength 360); today's month is lettered in brass between its
 * neighbours, and its arc on the inner ring is drawn in brass. The day and the year are lettered
 * upright in the dial's open lower half. Below the index hangs the bob (the pause button).
 */
function buildVolvelle() {
  const R = 108;
  const svg = svgNode('svg', { class: 'volvelle', viewBox: `${-R - 4} 0 ${2 * R + 8} ${R + 18}`, 'aria-hidden': 'true' });
  const ring = (r, w, dash, off, cls, extra = {}) => svgNode('circle', { r, fill: 'none', 'stroke-width': w, pathLength: 360, 'stroke-dasharray': dash, 'stroke-dashoffset': off, class: cls, ...extra });
  svg.appendChild(svgNode('circle', { r: R + 2.5, fill: 'none', class: 'vv-case' }));
  svg.appendChild(svgNode('circle', { r: R, class: 'vv-face' }));
  svg.appendChild(svgNode('circle', { r: R - 3, fill: 'none', class: 'vv-hair' }));
  const turn = svgNode('g', { class: 'vv-turn' });
  turn.appendChild(ring(R - 5.5, 5, '0.22 0.78', 0.11, 'vv-days dayticks'));
  turn.appendChild(ring(R - 7, 8, '0.3 4.7', 0.15, 'vv-fives'));
  turn.appendChild(ring(R - 8, 10, '0.5 29.5', 0.25, 'vv-months'));
  turn.appendChild(ring(84, 4, '0.5 29.5', 0.25, 'vv-months'));
  turn.appendChild(svgNode('circle', { r: 82, fill: 'none', class: 'vv-inner' }));
  const arc = svgNode('path', { class: 'vv-arc' });
  turn.appendChild(arc);
  const labels = [0, 1, 2].map(() => { const t = svgNode('text', { class: 'vv-month', 'text-anchor': 'middle' }); turn.appendChild(t); return t; });
  svg.appendChild(turn);
  const dayT = svgNode('text', { class: 'vv-day', x: 0, y: 34, 'text-anchor': 'middle' });
  const yearT = svgNode('text', { class: 'vv-year', x: 0, y: 66, 'text-anchor': 'middle' });
  svg.append(dayT, yearT);
  // the fixed index at six o'clock, and the stem down to the bob
  svg.appendChild(svgNode('path', { class: 'vv-stem', d: `M0 ${R - 8}V${R - 1}` }));
  svg.appendChild(svgNode('path', { class: 'vv-index', d: `M0 ${R + 1.5}L5.5 ${R + 9}H-5.5Z` }));
  svg.appendChild(svgNode('path', { class: 'vv-stem2', d: `M0 ${R + 9}V${R + 18}` }));
  const pt = (deg, r) => { const t = (deg * Math.PI) / 180; return [r * Math.cos(t), r * Math.sin(t)]; };
  let lastDay = -1, lastMonth = -1;
  return {
    el: svg,
    /** Faster than Normal, the rings jump instead of easing from day to day. */
    setPace(k) { svg.classList.toggle('is-fast', k > 2); },
    set(day, year) {
      if (day === lastDay) return;
      // a leap, a load or a rewind jumps the rings; day to day they turn
      svg.classList.toggle('is-jump', lastDay < 0 || Math.abs(day - lastDay) > 20);
      lastDay = day;
      const doy = ((day % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR;
      const m = Math.floor(doy / DAYS_PER_MONTH);
      // the days run anticlockwise round the rings (day d at −d°), so yesterday sits left of the
      // index and tomorrow right of it; today's tick turns to 90°, under the index. The angle runs
      // on with the days rather than wrapping, so the turn never spins back at the new year.
      turn.style.transform = `rotate(${(90 + day).toFixed(1)}deg)`;
      dayT.textContent = `${MONTH_NAMES[m]} ${doy % DAYS_PER_MONTH + 1}`;
      yearT.textContent = `Year ${year}`;
      if (m === lastMonth) return;
      lastMonth = m;
      const [x0, y0] = pt(-(m + 1) * DAYS_PER_MONTH, 82), [x1, y1] = pt(-m * DAYS_PER_MONTH, 82);
      arc.setAttribute('d', `M${x0.toFixed(2)} ${y0.toFixed(2)}A82 82 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`);
      [-1, 0, 1].forEach((d, i) => {
        const mm = (m + d + 12) % 12, mid = mm * DAYS_PER_MONTH + DAYS_PER_MONTH / 2;
        const [x, y] = pt(-mid, 91.5);
        labels[i].textContent = MONTH_NAMES[mm];
        labels[i].setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${(-mid - 90).toFixed(2)})`);
        labels[i].classList.toggle('is-now', d === 0);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Menu


/** Measured cost of one simulated year on this device (ms), or null before there is enough to go on. */
export function msPerSimYear(app) {
  const sim = app.sim, w = app.world;
  if (!sim || !w) return null;
  const days = w.time.day - (app.simStartDay ?? 0);
  if (days < 60) return null;
  let total = 0;
  for (const v of Object.values(sim.timing)) total += v;
  const ms = (total / days) * DAYS_PER_YEAR;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

const LEAPS = [10, 50, 100, 250, 500, 1000];

/** Leap ahead: run a span of history at full speed, with progress and a stop button. */
export function openLeap(app) {
  if (!app.world || !app.leapAhead || app.fastForwarding) return;
  const y = yearOf(app.world);
  const per = msPerSimYear(app);
  const grid = h('div.presets.leap-grid');
  let modal = null;
  for (const n of LEAPS) {
    const est = per ? (per * n) / 0.85 : null;
    const b = h('button.preset', { type: 'button' },
      h('span.pn', { text: `${int(n)} years` }),
      h('span.pd', { text: `to Year ${int(y + n)}${est ? ' · about ' + msText(Math.max(400, est)) : ''}` }));
    b.addEventListener('click', () => { modal?.close(true); app.leapAhead(n); });
    grid.appendChild(b);
  }
  const until = typeof app.untilQuick === 'function' ? app.untilQuick(() => modal?.close(true)) : null;
  modal = openModal({
    title: 'Leap ahead', small: true,
    body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      h('p', { text: 'Run history as fast as this device allows. Every day is still simulated; the map keeps drawing, and you can stop at any moment.' }),
      grid,
      until ? h('h4.rule-head', { text: 'Or run until…' }) : null,
      until,
      per ? h('p.gen-note', { text: `This world costs about ${msText(per)} of computing per simulated year here.` }) : null),
    actions: [{ label: 'Cancel', onClick: (m) => m.close() }],
  });
}

export { showHelp } from './keys.js';
