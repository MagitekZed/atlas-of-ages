// The toolbelt: Inspect, then every registered god tool grouped by TOOL_GROUPS, and a
// card for the active tool with its brush radius and strength, its live forecast (the
// tool's preview under the cursor, or why it cannot act there) and, for a pair tool, which
// pick comes next. Tools register themselves when their system modules load, so the belt is
// rebuilt whenever a world starts, and again whenever the tools available in this world
// change (availableTools, contracts §11 — Awaken Magic opens the mythic group mid-run).
// Map tools and pair tools join the belt; tools marked hidden, and entity tools (acts on a
// record, offered in the Inspector by acts.js), stay off it. Q and E step through the belt.
// On a phone the card ends in the aim: a hint until a spot is tapped, then a button named for
// the act (the first words of the tool's description) that uses it there (app.confirmAim).

import { getTools, getTool, TOOL_GROUPS } from '../core/tools.js';
import * as kernelTools from '../core/tools.js';
import { h, clear, isCompact } from './dom.js';
import { iconEl } from './icons.js';
import { tip, rangeInput } from './widgets.js';
import { getPref, setPref } from './prefs.js';
import { registerKey } from './registry.js';
import { fixtureFrame } from './frame.js';

/** The tools the belt offers for the current world. */
function beltTools(app) {
  let avail = null;
  if (app.world && typeof kernelTools.availableTools === 'function') {
    try {
      const list = kernelTools.availableTools(app.world);
      if (Array.isArray(list)) avail = new Set(list.map((t) => (typeof t === 'string' ? t : t?.id)));
    } catch (e) { app.reportError('availableTools', e); }
  }
  // keep getTools()'s order (group, then order, then label)
  return getTools().filter((t) => (!avail || avail.has(t.id)) && !t.hidden && t.target !== 'entity');
}

const TARGET_HINT = {
  tile: 'Click a spot on the map.',
  area: 'Click or drag across the map.',
  settlement: 'Click a settlement.',
  civ: 'Click inside a nation’s lands.',
  pair: 'Click the first, then the second.',
};
const PICK_WORD = { civ: 'a nation', settlement: 'a settlement', tile: 'a spot' };
const OTHER_WORD = { civ: 'another nation', settlement: 'another settlement', tile: 'another spot' };

export function mountPalette(app) {
  const host = document.getElementById('palette');
  clear(host);
  const wrap = h('div.palette-wrap');
  host.replaceWith(wrap);
  wrap.id = 'palette';

  const card = h('div.tool-card.instrument', { hidden: true });
  const belt = h('div.belt', { role: 'toolbar', 'aria-label': 'God tools' });
  const caseName = h('p.case-name', { text: 'Instruments' });
  wrap.append(card, belt);
  fixtureFrame(belt, { open: 'bottom' });
  belt.append(caseName);

  const inspectBtn = h('button.tool-btn.is-inspect', { type: 'button', 'aria-label': 'Inspect', 'aria-pressed': 'true' }, iconEl('inspect', { size: 24 }));
  tip(inspectBtn, 'Click anything on the map to read its record. Drag to pan.', 'Inspect', 'Esc');
  inspectBtn.addEventListener('click', () => app.setTool('inspect'));
  const groupTabs = h('div.group-tabs', { role: 'tablist', 'aria-label': 'Tool groups' });
  const toolRow = h('div.tool-row', { role: 'group' });
  belt.append(h('div.inspect-slot', null, inspectBtn), h('div.belt-main', null, groupTabs, toolRow));

  // fade an edge of a horizontal scroller while there is more to see beyond it
  const syncFade = (el) => {
    const max = el.scrollWidth - el.clientWidth;
    el.classList.toggle('fade-l', max > 2 && el.scrollLeft > 2);
    el.classList.toggle('fade-r', max > 2 && el.scrollLeft < max - 2);
  };
  for (const el of [groupTabs, toolRow]) {
    el.addEventListener('scroll', () => syncFade(el), { passive: true });
    try { new ResizeObserver(() => syncFade(el)).observe(el); } catch (e) { /* no observer */ }
  }

  let group = getPref('toolGroup', TOOL_GROUPS[0].id);
  let buttons = new Map();

  function build() {
    const tools = beltTools(app);
    clear(groupTabs);
    const groups = TOOL_GROUPS.filter((g) => tools.some((t) => t.group === g.id));
    const extra = [...new Set(tools.map((t) => t.group))].filter((g) => !TOOL_GROUPS.some((q) => q.id === g));
    const all = groups.concat(extra.map((id) => ({ id, label: id ? id[0].toUpperCase() + id.slice(1) : 'Other' })));
    if (!all.some((g) => g.id === group)) group = all[0]?.id || TOOL_GROUPS[0].id;
    for (const g of all) {
      const n = tools.filter((t) => t.group === g.id).length;
      const b = h('button', { type: 'button', role: 'tab', 'aria-selected': g.id === group ? 'true' : 'false', class: g.id === group ? 'is-on' : '' },
        shortGroup(g.label), h('span.n', { text: String(n) }));
      tip(b, g.label);
      b.addEventListener('click', () => { group = g.id; setPref('toolGroup', group); build(); });
      groupTabs.appendChild(b);
    }
    clear(toolRow);
    buttons = new Map();
    const list = tools.filter((t) => t.group === group);
    if (!tools.length) {
      toolRow.appendChild(h('span.empty', { text: app.world ? 'No god tools are available: the systems that provide them did not load.' : 'Tools appear when a world begins.' }));
    }
    for (const t of list) {
      const b = h('button.tool-btn', { type: 'button', 'aria-pressed': app.tool === t.id ? 'true' : 'false', class: app.tool === t.id ? 'is-on' : '' },
        iconEl(t.icon || t.id, { size: 22, label: t.label }));
      tip(b, t.desc || '', t.label);
      b.setAttribute('aria-label', t.label);
      b.addEventListener('click', () => app.setTool(app.tool === t.id ? 'inspect' : t.id));
      toolRow.appendChild(b);
      buttons.set(t.id, b);
    }
    syncActive();
    requestAnimationFrame(() => {
      syncFade(groupTabs); syncFade(toolRow);
      // keep the chosen group's tab in view
      groupTabs.querySelector('.is-on')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    });
  }

  function shortGroup(label) {
    // "Shape the Land" → "Land", "Unleash Catastrophe" → "Catastrophe": the last word reads best in a narrow belt
    const words = String(label).split(/\s+/);
    return words.length > 1 ? words[words.length - 1] : label;
  }

  function syncActive() {
    inspectBtn.classList.toggle('is-on', app.tool === 'inspect');
    inspectBtn.setAttribute('aria-pressed', app.tool === 'inspect' ? 'true' : 'false');
    for (const [id, b] of buttons) {
      b.classList.toggle('is-on', id === app.tool);
      b.setAttribute('aria-pressed', id === app.tool ? 'true' : 'false');
    }
    buildCard();
  }

  let cardTool = null;
  function buildCard() {
    const t = app.tool !== 'inspect' ? getTool(app.tool) : null;
    clear(card);
    card.hidden = !t;
    if (!t) { cardTool = null; return; }
    // a newly chosen tool (by key, link or URL) brings its group into view; after that the
    // viewer may browse the other groups while it stays active
    const fresh = t.id !== cardTool;
    cardTool = t.id;
    if (fresh && t.group !== group) { group = t.group; setPref('toolGroup', group); build(); return; }
    const opts = app.toolOptions(t.id);
    const groupLabel = TOOL_GROUPS.find((g) => g.id === t.group)?.label || '';
    const sliders = h('div.sliders');
    const hasRadius = (t.radius ?? 0) > 0 || t.target === 'area' || t.maxRadius != null;
    if (hasRadius) {
      const min = t.minRadius ?? 1, max = t.maxRadius ?? Math.max(16, Math.ceil((t.radius || 4) * 3));
      const out = h('output', { for: 'tool-radius', text: radiusText(opts.radius) });
      const inp = rangeInput({
        id: 'tool-radius', min, max, step: 1, value: Math.max(min, Math.min(max, opts.radius || t.radius || min)), label: 'Brush radius',
        oninput: (v) => { app.setToolOption(t.id, 'radius', v); out.textContent = radiusText(v); app.emit('brush'); },
      });
      sliders.appendChild(h('div.mini-slider', null, h('label', { for: 'tool-radius', text: 'Radius' }), inp, out));
    }
    if (t.strength && Number.isFinite(t.strength.min) && Number.isFinite(t.strength.max)) {
      const s = t.strength;
      const step = s.step ?? niceStep((s.max - s.min) / 100);
      const out = h('output', { for: 'tool-strength', text: strengthText(opts.strength, s) });
      const inp = rangeInput({
        id: 'tool-strength', min: s.min, max: s.max, step, value: opts.strength, label: s.label || 'Strength',
        oninput: (v) => { app.setToolOption(t.id, 'strength', v); out.textContent = strengthText(v, s); },
      });
      sliders.appendChild(h('div.mini-slider', null, h('label', { for: 'tool-strength', text: s.label || 'Strength' }), inp, out));
    }
    // a tool's kinds (the Plague power in a Mythic world)
    const kinds = typeof t.kinds === 'function' && app.world ? t.kinds(app.world) : null;
    if (Array.isArray(kinds) && kinds.length > 1) {
      const row = h('div.tool-kinds', { role: 'radiogroup', 'aria-label': `${t.label}: kind` });
      for (const [v, label] of kinds) {
        const on = opts.kind === v;
        const b = h('button', { type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false', class: on ? 'is-on' : '', text: label });
        b.addEventListener('click', () => {
          app.setToolOption(t.id, 'kind', v);
          for (const x of row.children) { const me = x === b; x.classList.toggle('is-on', me); x.setAttribute('aria-checked', me ? 'true' : 'false'); }
          app.emit('brush');
        });
        row.appendChild(b);
      }
      sliders.appendChild(row);
    }
    const ico = h('span.ico', null, iconEl(t.icon || t.id, { size: 20, label: t.label }));
    card.append(
      ico,
      h('div.name', null, t.label, h('span.grp', { text: groupLabel })),
      h('p.desc', { text: t.desc || '' }),
    );
    if (sliders.childNodes.length) card.appendChild(sliders);
    let coarse = false;
    try { coarse = window.matchMedia('(pointer: coarse)').matches; } catch (e) { /* assume a mouse */ }
    let how = (TARGET_HINT[t.target] || TARGET_HINT.tile);
    if (t.target === 'pair') {
      const pk = Array.isArray(t.pick) && t.pick.length ? t.pick : ['civ', 'civ'];
      const k0 = pk[0], k1 = pk[1] || pk[0];
      const second = k1 === k0 ? (OTHER_WORD[k1] || 'another') : (PICK_WORD[k1] || 'the second');
      how = pairSource && pairSource.tool.id === t.id ? `From ${pairSource.a.label}: now click ${second}.` : `Click ${PICK_WORD[k0] || 'the first'}, then ${second}.`;
    }
    how = how.replace(/^Click/, coarse ? 'Tap' : 'Click').replace(/ click /, coarse ? ' tap ' : ' click ');
    const back = coarse ? 'Tap the magnifier to inspect again.' : t.target === 'pair' && pairSource ? 'Esc lets go of the first.' : 'Esc returns to Inspect.';
    card.appendChild(forecast);
    syncForecast();
    if (isCompact() && t.target !== 'pair') { card.appendChild(aimRow); syncAim(); return; }
    card.appendChild(h('p.hint', { text: `${how}${t.continuous ? ' Hold to keep working.' : ''} ${back}` }));
  }

  // a phone's aim: tap a spot, then the button acts there once
  const aimHint = h('p.hint');
  const aimBtn = h('button.btn.btn-brass.aim-go', { type: 'button' });
  aimBtn.addEventListener('click', () => app.confirmAim?.());
  const aimRow = h('div.aim-row', null, aimHint, aimBtn);
  let aimNow = null;
  function syncAim() {
    const t = app.tool !== 'inspect' ? getTool(app.tool) : null;
    if (!t) return;
    const on = Boolean(aimNow && aimNow.toolId === t.id);
    const first = String(t.desc || '').split('.')[0].trim();
    aimBtn.textContent = first && first.length <= 24 ? first : t.label;
    aimBtn.hidden = !on;
    aimBtn.disabled = Boolean(on && lastForecast && lastForecast.ok === false);
    let risky = false;
    try { risky = typeof t.danger === 'function' && Boolean(t.danger(app.toolOptions(t.id))) && !app.chrono?.canProtect?.(); } catch (e) { risky = false; }
    aimHint.textContent = on
      ? `${risky ? 'At this strength it cannot be undone. ' : ''}Tap another spot to move it, or the magnifier to inspect again.`
      : 'Tap a spot on the map to aim; drag to move the map.';
    aimHint.classList.toggle('is-grave', on && risky);
  }
  app.on('toolAim', (a) => { aimNow = a; syncAim(); });

  // the tool's forecast under the cursor (input.js emits toolPreview as it changes)
  const forecast = h('p.forecast', { hidden: true, 'aria-live': 'polite' });
  let lastForecast = null;
  function syncForecast() {
    const p = lastForecast;
    const text = p ? (p.ok === false ? p.reason || '' : p.text || '') : '';
    forecast.hidden = !text;
    forecast.textContent = text;
    forecast.classList.toggle('is-refused', Boolean(p && p.ok === false));
  }
  let pairSource = null;
  app.on('toolPreview', (p) => { lastForecast = p; syncForecast(); syncAim(); });
  app.on('pairSource', (p) => { pairSource = p; buildCard(); });

  const radiusText = (r) => `${r} ${r === 1 ? 'tile' : 'tiles'}`;
  function strengthText(v, s) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    if (s.unit) return `${n} ${s.unit}`;
    if (s.max <= 1.0001 && s.min >= 0) return Math.round(n * 100) + '%';
    return Math.abs(n) >= 10 ? String(Math.round(n)) : n.toFixed(1);
  }
  function niceStep(x) {
    if (!(x > 0)) return 0.01;
    const p = Math.pow(10, Math.floor(Math.log10(x)));
    return p;
  }

  app.adjustBrush = (delta) => {
    const t = getTool(app.tool);
    // only brushes have a radius ([ and ] do nothing for a single-spot tool such as a quake)
    if (!t || !((t.radius ?? 0) > 0 || t.target === 'area' || t.maxRadius != null)) return;
    const min = t.minRadius ?? 1, max = t.maxRadius ?? Math.max(16, Math.ceil((t.radius || 4) * 3));
    const cur = app.toolOptions(t.id).radius || t.radius || min;
    const next = Math.max(min, Math.min(max, cur + delta));
    app.setToolOption(t.id, 'radius', next);
    buildCard();
    app.emit('brush');
  };

  // Q and E: the previous and next tool on the belt
  const step = (dir) => {
    const tools = beltTools(app);
    if (!tools.length) return;
    const k = tools.findIndex((t) => t.id === app.tool);
    const next = k < 0 ? (dir > 0 ? tools[0] : tools[tools.length - 1]) : tools[(k + dir + tools.length) % tools.length];
    app.setTool(next.id);
  };
  registerKey({ key: 'q', label: 'Previous god tool', group: 'Tools', when: (a) => Boolean(a.world), run: () => step(-1) });
  registerKey({ key: 'e', label: 'Next god tool', group: 'Tools', when: (a) => Boolean(a.world), run: () => step(1) });

  // a tool's availability can change mid-run (a myth level raised): rebuild when the set changes
  let availSig = '';
  let availAt = 0;
  app.on('tick', () => {
    if (!app.world) return;
    const t = performance.now();
    if (t - availAt < 2000) return;
    availAt = t;
    const sig = beltTools(app).map((x) => x.id).join(',');
    if (availSig && sig !== availSig) { availSig = sig; build(); if (app.tool !== 'inspect' && !sig.split(',').includes(app.tool)) app.setTool('inspect'); }
    else availSig = sig;
  });

  app.on('tool', () => { lastForecast = null; syncActive(); });
  app.on('world', () => { availSig = ''; build(); });
  app.on('toolsChanged', build);
  app.on('toolOptions', () => buildCard());
  build();
}
