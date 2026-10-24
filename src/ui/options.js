// Options: what this browser keeps for every world, on three leaves. Sound (on, and how loud),
// Notices (what reaches you and what stops time; the leaf until.js builds) and Worlds (the
// forging, the century autosave, the copy kept for Continue). Every change takes effect at once.

import { h, clear } from './dom.js';
import { openModal, syncRange } from './widgets.js';
import { getPref, setPref } from './prefs.js';

/** A setting with its title, a line on what it does, and a switch. */
export function optRow({ id, title, desc = '', checked, onChange }) {
  const box = h('input', { id, type: 'checkbox' });
  box.checked = Boolean(checked);
  const state = h('span.opt-on', { text: box.checked ? 'On' : 'Off' });
  box.addEventListener('change', () => { state.textContent = box.checked ? 'On' : 'Off'; onChange(box.checked); });
  return h('label.opt-row', { for: id },
    h('span.opt-text', null, h('span.opt-title', { text: title }), desc ? h('span.opt-desc', { text: desc }) : null),
    h('span.switch', null, box, h('span.track')), state);
}

const LEAVES = [['sound', 'Sound'], ['notices', 'Notices'], ['worlds', 'Worlds']];

export function openOptions(app, { tab = null, onClose = null } = {}) {
  let cur = tab || getPref('optionsTab', 'sound');
  if (!LEAVES.some(([id]) => id === cur)) cur = 'sound';
  const tabs = h('div.opt-tabs', { role: 'tablist', 'aria-label': 'Options' });
  const pane = h('div.opt-pane', { role: 'tabpanel' });
  const restore = h('button.btn', { type: 'button', text: 'Restore the notice defaults' });
  restore.addEventListener('click', () => { app.resetNotices?.(); show('notices'); });

  const build = {
    sound() {
      if (!app.sound) return h('p.muted', { text: 'Sound did not load in this browser.' });
      const loud = h('input', { id: 'opt-volume', type: 'range', min: 0, max: 1, step: 0.05, 'aria-label': 'Loudness' });
      loud.value = String(app.sound.volume ?? 0.6);
      loud.disabled = !app.sound.on;
      syncRange(loud);
      loud.addEventListener('input', () => { app.sound.setVolume(Number(loud.value)); syncRange(loud); });
      return h('div.opt-col', null,
        h('h3.opt-h', { text: 'The sound of the world' }),
        optRow({ id: 'opt-sound', title: 'Sound', desc: 'Quakes rumble, stars fall with a roar and battles beat their drums. All of it is made on the spot; nothing is downloaded.', checked: app.sound.on, onChange: (v) => { app.sound.setOn(v); loud.disabled = !v; } }),
        h('label.opt-slider', { for: 'opt-volume' }, h('span.opt-title', { text: 'Loudness' }), loud));
    },
    notices() { return app.noticesPanel ? app.noticesPanel() : h('p.muted', { text: 'Notices did not load in this browser.' }); },
    worlds() {
      return h('div.opt-col', null,
        h('h3.opt-h', { text: 'When a world begins' }),
        optRow({ id: 'opt-forging', title: 'Watch each new world forged', desc: 'Plates drift, mountains rise and rivers run before the map opens. Off: the map opens at once.', checked: !getPref('skipForging', false), onChange: (v) => setPref('skipForging', !v) }),
        h('h3.opt-h', { text: 'Keeping worlds' }),
        optRow({ id: 'opt-autosave', title: 'Autosave every century', desc: 'Each time a hundred years pass, the world is written to the Autosave slot in this browser.', checked: app.autosave, onChange: (v) => { app.autosave = v; setPref('autosave', v); } }),
        optRow({ id: 'opt-resume', title: 'Keep where you left off', desc: 'Every few minutes the world is kept for Continue on the title page.', checked: getPref('story.resume', true) !== false, onChange: (v) => setPref('story.resume', v) }));
    },
  };
  function show(id) {
    cur = id;
    setPref('optionsTab', id);
    for (const b of tabs.children) { const on = b.dataset.id === id; b.classList.toggle('is-on', on); b.setAttribute('aria-selected', String(on)); }
    clear(pane);
    pane.append(build[id]());
    pane.dataset.leaf = id;
    restore.hidden = id !== 'notices';
  }
  for (const [id, label] of LEAVES) {
    const b = h('button.opt-tab', { type: 'button', role: 'tab', text: label, dataset: { id } });
    b.addEventListener('click', () => show(id));
    tabs.append(b);
  }
  show(cur);
  const m = openModal({
    kicker: 'Options', title: 'Options', cls: 'is-options',
    lead: 'Kept in this browser, for every world you open.',
    body: h('div.opt', null, tabs, pane),
    actions: [restore, h('span.opt-note', { text: 'Every change takes effect at once.' }), { label: 'Done', cls: 'btn-brass', onClick: (mm) => mm.close() }],
    onClose: () => onClose?.(),
  });
  return m;
}
