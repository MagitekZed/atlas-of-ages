// The World tab: every live parameter as a control (changes apply at once), each marked
// with its genesis value and resettable; the fixed genesis record; and the engine room —
// which systems run, what each costs per simulated year, and anything that went wrong.
// Every change is a logged intervention (setParam … { log: true }), so undo and rewind replay
// it; a run of changes to one setting is one act for the Chronoscope (app.chrono). Settings
// whose visibleIf does not hold (the Mythic sliders in a Historical world) stay hidden, and
// the list follows the world when that changes (Awaken Magic).

import { PARAMS, PARAM_GROUPS, paramVisible } from '../core/params.js';
import { setParam } from '../core/world.js';
import { DAYS_PER_YEAR } from '../core/constants.js';
import { h, clear, setText } from './dom.js';
import { paramControl, tip } from './widgets.js';
import { paramValue, int, span, yearOfDay } from './format.js';
import { confirmDialog } from './widgets.js';
import { statusToast } from './toasts.js';

export function createWorldTab(app) {
  const el = h('div.tabpanel');
  const controls = new Map();
  const groups = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '20px' } });
  const resetAll = h('button.btn.btn-sm', { type: 'button', text: 'Reset all to genesis' });
  resetAll.addEventListener('click', async () => {
    const changed = shownLive(app.world).filter((p) => String(app.world.params[p.key]) !== String(app.world.genesisParams[p.key]));
    if (!changed.length) { statusToast(app, 'Every setting already matches genesis.'); return; }
    const ok = await confirmDialog({ title: 'Reset to genesis?', text: `${changed.length} setting${changed.length === 1 ? '' : 's'} will return to the values this world began with.`, confirmLabel: 'Reset' });
    if (!ok || app.chrono?.busy) return;
    for (const p of changed) set(p.key, app.world.genesisParams[p.key]);
    statusToast(app, 'The world’s settings were returned to genesis.', 'ok', { icon: 'reset' });
  });
  const changedNote = h('span.chron-count');
  const genesisBox = h('dl.kv');
  const engine = h('div.engine');
  const errors = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
  const facts = h('dl.kv');

  el.append(
    h('p.muted', { text: 'These settings shape the world as it runs. Changes take effect immediately; the faint tick on each slider marks its value at genesis.' }),
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' } }, changedNote, resetAll),
    groups,
    h('section.ins-section', null, h('h4.rule-head', { text: 'Genesis record' }), h('p.muted', { text: 'Fixed when the world was made.' }), genesisBox),
    h('section.ins-section', { id: 'engine-room' }, h('h4.rule-head', { text: 'Engine room' }), facts, engine, errors),
  );

  /** A viewer's change: one logged intervention, grouped into an act for undo. */
  function change(key, value) {
    const w = app.world;
    if (!w) return w;
    if (String(w.params[key]) === String(value)) return w.params[key];
    // while the Chronoscope re-writes history this world is about to be replaced: the change
    // would be lost with it, so it is refused and the control shows the world's value again
    if (app.chrono?.busy || app.fastForwarding) { controls.get(key)?.set(w.params[key]); return w.params[key]; }
    const p = PARAMS.find((q) => q.key === key);
    app.chrono?.noteParam?.(key, p ? p.label : key);
    const v = setParam(w, key, value, { log: true });
    app.emit('params', key, v);
    return v;
  }

  function set(key, value) {
    const v = change(key, value);
    controls.get(key)?.set(v);
    syncChanged();
  }

  const shownLive = (w) => PARAMS.filter((p) => p.live && paramVisible(p, w.params));
  let shownSig = '';

  function build() {
    clear(groups); controls.clear();
    const w = app.world;
    if (!w) return;
    const shown = shownLive(w);
    shownSig = shown.map((p) => p.key).join(',');
    for (const g of PARAM_GROUPS) {
      const list = shown.filter((p) => p.group === g.id);
      if (!list.length) continue;
      const box = h('div.param-group');
      for (const p of list) {
        const c = paramControl(p, {
          idPrefix: 'live', value: w.params[p.key], genesisValue: w.genesisParams[p.key],
          onChange: (key, v) => { change(key, v); syncChanged(); },
        });
        const reset = h('button.link', { type: 'button', text: 'genesis', style: { fontSize: '11px', marginRight: '4px' } });
        tip(reset, `Return ${p.label.toLowerCase()} to its value at genesis.`);
        reset.addEventListener('click', () => set(p.key, w.genesisParams[p.key]));
        // the link sits beside the value, in the same grid cell, so showing it never pushes the slider down
        const out = c.el.querySelector('.val, output');
        if (out?.parentElement?.classList.contains('row-end')) out.before(reset);
        else if (out) { const end = h('span.row-end'); out.replaceWith(end); end.append(reset, out); }
        c.resetBtn = reset;
        controls.set(p.key, c);
        box.appendChild(c.el);
      }
      groups.appendChild(h('section.ins-section', null, h('h4.rule-head', { text: g.label }), h('p.muted', { text: g.desc, style: { fontSize: '12.5px', marginTop: '-4px' } }), box));
    }
    clear(genesisBox);
    genesisBox.append(h('dt', { text: 'Seed' }), h('dd', { text: w.seed }));
    for (const p of PARAMS.filter((q) => !q.live && paramVisible(q, w.genesisParams))) genesisBox.append(h('dt', { text: p.label }), h('dd', { text: paramValue(p, w.genesisParams[p.key] ?? w.params[p.key]) }));
    syncChanged();
  }

  function syncChanged() {
    const w = app.world;
    if (!w) return;
    let n = 0;
    for (const [key, c] of controls) {
      const changed = String(w.params[key]) !== String(w.genesisParams[key]);
      if (changed) n++;
      c.resetBtn.hidden = !changed;
    }
    setText(changedNote, n ? `${n} setting${n === 1 ? ' differs' : 's differ'} from genesis` : 'All settings as at genesis');
  }

  function refreshEngine() {
    const w = app.world, sim = app.sim;
    if (!w || !sim) return;
    clear(facts);
    const years = Math.max(1e-6, (w.time.day - (app.simStartDay ?? 0)) / DAYS_PER_YEAR);
    const rows = [
      ['World', `${w.name} · ${w.W} × ${w.H} tiles`],
      ['Simulated', `${span(w.time.day)} (${int(w.time.day)} days)`],
      ['Pace now', app.speed === 0 ? 'Paused' : app.measured.dps > 0 ? `${int(app.measured.dps)} days per second` : 'measuring…'],
      ['Chronicle', `${int(w.chronicle.entries.length)} entries kept, ${int(w.chronicle.seq)} written`],
      ['History', `${int(w.history?.years?.length || 0)} yearly records · ${int(w.history?.atlas?.length || 0)} atlas plates`],
      ['Map renderer', app.renderInfo.fallback ? `Simplified stand-in${app.renderInfo.error ? ' (' + app.renderInfo.error + ')' : ''}` : 'Full atlas renderer'],
      ['World generator', app.modules.gen ? 'Full generator' : app.modules.fallbackGen ? 'Simplified stand-in' : 'Missing'],
    ];
    for (const [k, v] of rows) facts.append(h('dt', { text: k }), h('dd.txt', { text: v }));
    clear(engine);
    engine.appendChild(h('div.sys', { style: { fontSize: '11px', color: 'var(--ink-3)' } }, h('span', { text: 'System' }), h('span', { text: 'ms per sim-year' }), h('span', { text: 'status' })));
    let total = 0;
    for (const s of sim.systems) {
      const ms = (sim.timing[s.id] || 0) / years;
      total += ms;
      const err = sim.errors[s.id];
      engine.appendChild(h('div.sys', null,
        h('span', { text: s.id }),
        h('span.ms', { text: ms.toFixed(1) }),
        h('span.st', { class: err ? 'danger-text' : 'good-text', text: err ? `${err.count} error${err.count === 1 ? '' : 's'}` : 'running' })));
    }
    engine.appendChild(h('div.sys', { style: { fontWeight: '500' } }, h('span', { text: 'All systems' }), h('span.ms', { text: total.toFixed(1) }), h('span.st', { text: '' })));
    clear(errors);
    for (const x of app.loadErrors) errors.appendChild(h('div.notice.is-warn', { text: `Not loaded: ${x.path} — ${x.message}` }));
    for (const [id, e] of Object.entries(sim.errors)) errors.appendChild(h('div.notice.is-error', { text: `${id}: ${e.last}` }));
    for (const e of app.errors.slice(-8).reverse()) errors.appendChild(h('div.notice', { text: `${e.where}${e.day != null ? ' (Y' + yearOfDay(e.day) + ')' : ''}: ${e.message}` }));
  }

  /** Did a setting's visibleIf flip (mythLevel raised mid-run)? */
  const visibleChanged = () => Boolean(app.world) && shownLive(app.world).map((p) => p.key).join(',') !== shownSig;
  // an undo or rewind brings back other values: show them
  app.on('params', () => { if (app.world && controls.size) for (const [k, c] of controls) c.set(app.world.params[k]); });
  // the controls rest while history is re-written (undo, redo, rewind)
  app.on('chronoBusy', (busy) => {
    el.classList.toggle('is-held', Boolean(busy));
    for (const c of controls.values()) { if (c.input) c.input.disabled = Boolean(busy); if (c.resetBtn) c.resetBtn.disabled = Boolean(busy); }
    resetAll.disabled = Boolean(busy);
    if (!busy && app.world) for (const [k, c] of controls) c.set(app.world.params[k]);
  });

  let n = 0;
  app.on('engineRoom', () => setTimeout(() => el.querySelector('#engine-room')?.scrollIntoView({ block: 'start' }), 60));

  return {
    id: 'world', label: 'World', title: 'World', icon: 'world', el,
    show() { if (!controls.size || visibleChanged()) build(); else for (const [k, c] of controls) c.set(app.world.params[k]); syncChanged(); refreshEngine(); },
    refresh() { if (visibleChanged()) build(); if (++n % 4 === 0) refreshEngine(); },
    onWorld() { build(); refreshEngine(); },
  };
}
