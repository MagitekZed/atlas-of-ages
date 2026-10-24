// The Contents: the game's menu, a plate over the paused table. Esc opens it when there is
// nothing left to step back from, as does the Menu handle. Opening it stops time; Resume lets
// time run on, and leaving it any other way puts the speed back as it was. Options and Every
// key open over it; the rest close it first.

import { SPEEDS, DAYS_PER_YEAR } from '../core/constants.js';
import { dateString, seasonName } from '../core/world.js';
import { liveSettlements } from '../core/entities.js';
import { h } from './dom.js';
import { openModal, confirmDialog } from './widgets.js';
import { people, eraName, int } from './format.js';
import { summarize } from '../sim/stats.js';
import { openSaves, listSlots, keepResume } from './saves.js';
import { showHelp } from './keys.js';
import { openOptions } from './options.js';

const NUM = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];
const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

function rateText(k) {
  const dps = SPEEDS[k]?.dps || 0;
  if (!Number.isFinite(dps)) return 'as fast as the world can be reckoned';
  if (dps >= DAYS_PER_YEAR / 2) return `${int((dps / DAYS_PER_YEAR) * 60)} years a minute`;
  return `${dps} ${dps === 1 ? 'day' : 'days'} a second`;
}

let open = null;

export function openContents(app) {
  const w = app.world;
  if (!w || open) return;
  const was = app.speed;
  const runAt = was > 0 ? was : (app.lastSpeed || 2);
  app.pause();

  // the world as it stands: name, date, age and season, then its numbers
  const lead = h('p.pm-lead', { text: `${dateString(w)} · ${seasonName(w, 0)} in the north` });
  import('../sim/events/index.js').then((m) => {
    const a = m.currentAges?.(w)?.[0];
    if (a) lead.textContent = `${dateString(w)} · in ${/^the\b/i.test(a.short || a.name) ? (a.short || a.name).replace(/^The\b/, 'the') : `the ${a.short || a.name}`} · ${seasonName(w, 0)} in the north`;
  }).catch(() => { /* no ages without the event deck */ });
  const s = summarize(w);
  const stat = (k, v) => h('div.pm-stat', null, h('span.k', { text: k }), h('span.v', { text: v }));
  const stats = h('div.pm-stats', null,
    stat('Pop.', people(s.pop)), stat('Nations', String(s.civs)), stat('Towns', int(liveSettlements(w).length)),
    stat('Wars', String(s.wars)), stat('Faiths', String(s.faiths)), stat('Era', eraName(s.era)));

  const list = h('ol.contents.pm-list');
  let n = 0;
  const entry = (name, { value = '', gloss = null, act, extra = null, cur = false }) => {
    const nameEl = h('button.ct-name', { type: 'button', text: name });
    nameEl.addEventListener('click', act);
    const row = h('div.ct', { class: cur ? 'is-cur' : '' }, h('span.ct-n', { text: NUM[n++] }), nameEl, h('span.ct-lead'), extra || h('span.ct-val', { text: value }));
    if (gloss) row.appendChild(h('p.ct-gloss', null, ...gloss));
    list.appendChild(h('li', null, row));
    return row;
  };
  const kbd = (t) => h('kbd.kbd', { text: t });
  const leave = (how, then) => () => { m.close(how); then?.(); };

  entry('Resume', { value: `at ${SPEEDS[runAt].label}`, cur: true, gloss: [`Time runs on at ${rateText(runAt)} · `, kbd('Space')], act: leave('resume') });
  const saves = entry('Save and load', { value: ' ', gloss: ['Save into a slot or to a file, or open another world · ', kbd('Ctrl S'), ' saves at once'], act: leave('stay', () => openSaves(app)) });
  listSlots().then((rows) => {
    const k = new Set(rows.filter((r) => !r.resume && r.id !== 'autosave').map((r) => r.key || r.worldName)).size;
    saves.querySelector('.ct-val').textContent = `${WORDS[k] || int(k)} world${k === 1 ? '' : 's'}${k ? '' : ' saved'}`;
  }).catch(() => { saves.querySelector('.ct-val').textContent = 'To a file'; });
  if (app.chrono) entry('Rewind history', { value: 'to an earlier year', gloss: ['Choose a year; everything after it is unwritten, or kept as a branch'], act: leave('stay', () => app.chrono.openRewind()) });
  const quick = (random) => async () => {
    const ok = await confirmDialog({ title: 'Begin a new world?', text: `${w.name} will be closed. Anything since your last save will be lost.`, confirmLabel: 'Begin' });
    if (!ok) return;
    m.close('stay');
    app.beginQuick?.(random);
  };
  const skip = h('span.ts-skip', null,
    h('button.btn', { type: 'button', text: 'Default', onclick: quick(false) }),
    h('button.btn', { type: 'button', text: 'Random', onclick: quick(true) }));
  entry('New World', { extra: skip, gloss: ['Eight steps from the age of the world to its myths, or skip the rite'], act: leave(false, () => app.newWorld()) });
  const opts = entry('Options', { value: `Sound ${app.sound?.on ? 'on' : 'off'}`, act: () => openOptions(app, { onClose: () => { opts.querySelector('.ct-val').textContent = `Sound ${app.sound?.on ? 'on' : 'off'}`; } }) });
  entry('Every key', { value: 'Keyboard and mouse', act: () => showHelp(app) });
  entry('Return to the title', { value: 'autosaved', gloss: [`${w.name} waits on the title page, under Continue`], act: leave('stay', async () => { await keepResume(app); app.showTitle?.(); }) });

  const hint = (keys, text) => h('span.pm-hint', null, ...keys.map(kbd), h('span', { text }));
  const foot = h('div.pm-foot', null, hint(['▲', '▼'], 'choose'), hint(['Enter'], 'open'), hint(['?'], 'every key'), hint(['Esc'], 'back to the table'));

  const m = openModal({
    title: w.name, cls: 'is-contents',
    body: h('div.pm', null, lead, h('div.rule-loz', { 'aria-hidden': 'true' }, h('span.loz')), stats, list),
    actions: [foot],
    onClose: (how) => {
      open = null;
      if (how === 'resume') app.setSpeed(runAt);
      else if (how !== 'stay' && was > 0 && app.world === w) app.setSpeed(was);
    },
  });
  open = m;
  // ▲ ▼ walk the entries; ? opens every key over the Contents
  function onKey(e) {
    const names = [...list.querySelectorAll('.ct-name')];
    const k = names.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      names[(k < 0 ? (d > 0 ? 0 : names.length - 1) : (k + d + names.length) % names.length)]?.focus();
    } else if (e.key === '?') { e.preventDefault(); showHelp(app); }
  }
  m.box.addEventListener('keydown', onKey);
  setTimeout(() => list.querySelector('.ct-name')?.focus(), 0);
}
