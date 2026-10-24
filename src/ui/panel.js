// The folio: thumb-index tabs (Dossier, Chronicle, Nations, Statistics, World, Atlas) on the
// edge of a leaf that slides out over the map, and the active tab's body under a running head.
// Only the visible tab refreshes (≤ 4 Hz). On desktop the folio stands inside the neatline on
// the right and can widen or fold away to its tabs, with the Menu and Find handles above them;
// on phones the rail is a tab bar along the foot (Dossier, Chronicle, Nations, Annals, More for the
// other folios, and Tools for the god tools' sheet), and the folio a sheet over it with a grip and
// three heights. Tabs other packages register (src/ui/registry.js
// registerTab) join the rail by their order, whenever they register, and hide while their
// when(app) is false. The Chronicle's unread badge starts afresh after a leap, a run until…
// or an undo (Notices › badgeAfterLeap).

import { h, clear, svgEl, setText, isCompact } from './dom.js';
import { glyph, iconEl } from './icons.js';
import { tip, iconButton, openPopover, closePopover } from './widgets.js';
import { getPref, setPref, getNotices } from './prefs.js';
import { createInspector } from './inspector.js';
import { createChronicle } from './chronicle.js';
import { createNations } from './nations.js';
import { createStatistics } from './statistics.js';
import { createWorldTab } from './worldtab.js';
import { createAtlas } from './atlas.js';
import { TABS, selectionPoint } from './app.js';
import { openContents } from './contents.js';
import { BUILTIN_TABS, getTabs, onRegistryChange } from './registry.js';

// the folios a phone's tab bar shows; the rest wait under More
const PHONE_BAR = new Set(['inspector', 'chronicle', 'nations', 'annals']);
const KEYS = { inspector: 'I', chronicle: 'C', nations: 'N', statistics: 'T', world: 'P', atlas: 'L' };
const DESCS = {
  inspector: 'The record of whatever you select on the map.',
  chronicle: 'The written history of the world, newest first.',
  nations: 'Every nation, living and fallen.',
  statistics: 'Population, climate and life over time.',
  world: 'Live settings, and the engine room.',
  atlas: 'Borders of past ages; play history as a timelapse.',
};

export function mountPanel(app) {
  const panel = document.getElementById('panel');
  clear(panel);
  const appEl = document.getElementById('app');

  const tabs = [createInspector(app), createChronicle(app), createNations(app), createStatistics(app), createWorldTab(app), createAtlas(app)];
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const ORDER = new Map(BUILTIN_TABS.map((t) => [t.id, t.order]));

  const grip = h('div.sheet-grip', { role: 'separator', 'aria-label': 'Drag to resize the panel' });
  const rail = h('nav.rail', { role: 'tablist', 'aria-label': 'Instruments', 'aria-orientation': 'vertical' });
  const tabBtns = new Map();
  const badges = new Map();
  function tabButton(t) {
    const badge = h('span.badge');
    const b = h('button.tab', { type: 'button', role: 'tab', id: `tab-${t.id}`, 'aria-controls': `pane-${t.id}`, 'aria-selected': 'false', class: PHONE_BAR.has(t.id) ? '' : 'off-bar' },
      t.def ? iconEl(t.icon, { size: 22, label: t.label }) : svgEl(glyph(t.icon, 22)), h('span', { text: t.label }), badge);
    tip(b, t.def ? t.def.desc || '' : DESCS[t.id], t.title, t.def ? t.def.key || '' : KEYS[t.id]);
    b.addEventListener('click', () => onTabClick(t.id));
    tabBtns.set(t.id, b);
    badges.set(t.id, badge);
    return b;
  }
  // the handles above the tabs: the menu and the finder
  const menuHandle = h('button.ehandle', { type: 'button', 'aria-label': 'Menu', 'aria-haspopup': 'dialog' }, svgEl(glyph('menu', 18)));
  tip(menuHandle, 'New world, saving, notices and shortcuts.', 'Menu');
  menuHandle.addEventListener('click', () => openContents(app));
  const findHandle = h('button.ehandle', { type: 'button', 'aria-label': 'Find anything' }, svgEl(glyph('search', 18)));
  tip(findHandle, 'Find any place, people, war or command.', 'Find', '/');
  findHandle.addEventListener('click', () => app.openCommand?.(''));
  rail.append(menuHandle, findHandle, h('span.handle-gap'));
  for (const t of tabs) rail.appendChild(tabButton(t));
  const wideBtn = iconButton('expand', 'Expand the folio', () => setWide(!panel.classList.contains('is-wide')), { cls: 'wide-btn' });
  const foldBtn = iconButton('back', 'Fold the panel', () => setCollapsed(!panel.classList.contains('is-collapsed')), { key: '\\' });
  const railSpacer = h('span.spacer');
  rail.append(railSpacer, h('div.rail-extra', null, foldBtn));
  // on a phone the rail is the tab bar: four folios, More for the rest, and the Tools sheet
  const moreBtn = h('button.tab.phone-slot.more-slot', { type: 'button', 'aria-haspopup': 'true', 'aria-selected': 'false' });
  moreBtn.addEventListener('click', () => {
    const list = h('div.more-list');
    for (const t of tabs) {
      if (PHONE_BAR.has(t.id) || tabBtns.get(t.id)?.hidden) continue;
      const item = h('button.menu-item', { type: 'button', class: t.id === active ? 'is-on' : '' }, t.def ? iconEl(t.icon, { size: 18, label: t.label }) : svgEl(glyph(t.icon, 18)), h('span', { text: t.label }));
      item.addEventListener('click', () => { closePopover(); onTabClick(t.id); });
      list.append(item);
    }
    openPopover(moreBtn, list, { side: 'above', align: 'end', cls: 'menu' });
  });
  function syncMore() {
    const t = active && !PHONE_BAR.has(active) ? byId.get(active) : null;
    clear(moreBtn);
    moreBtn.append(t ? (t.def ? iconEl(t.icon, { size: 22, label: t.label }) : svgEl(glyph(t.icon, 22))) : iconEl('more', { size: 22, label: 'More' }), h('span', { text: t ? t.label : 'More' }));
    moreBtn.setAttribute('aria-selected', String(Boolean(t)));
  }
  const toolsBtn = h('button.tab.phone-slot.tools-slot', { type: 'button', 'aria-selected': 'false' }, iconEl('brush', { size: 22, label: 'Tools' }), h('span', { text: 'Tools' }));
  toolsBtn.addEventListener('click', () => setTools(!appEl.classList.contains('is-tools')));
  /** The god tools as a sheet over the tab bar (phones); the folio's sheet folds while it is up. */
  function setTools(on) {
    appEl.classList.toggle('is-tools', on);
    toolsBtn.setAttribute('aria-selected', String(on));
    if (on && isCompact() && panel.classList.contains('is-open')) setSheet('closed');
  }
  rail.append(moreBtn, toolsBtn);

  const headTitle = h('h2');
  const sheetX = iconButton('close', 'Close the sheet', () => setSheet('closed'), { cls: 'sheet-x' });
  const tabActs = h('div.head-acts');   // the active tab's own head buttons (Nations: Compare)
  const headActions = h('div', { style: { display: 'flex', gap: '2px' } }, tabActs, wideBtn, sheetX);
  const head = h('div.panel-head', null, headTitle, headActions);
  const scroll = h('div.panel-scroll');
  const panes = new Map();
  function tabPane(t) {
    const pane = h('div', { id: `pane-${t.id}`, role: 'tabpanel', 'aria-labelledby': `tab-${t.id}`, hidden: true, style: t.flush ? { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' } : null }, t.el);
    panes.set(t.id, pane);
    return pane;
  }
  for (const t of tabs) scroll.appendChild(tabPane(t));
  const body = h('div.panel-body', null, head, scroll);
  panel.append(grip, rail, body);

  // --- registered tabs (src/ui/registry.js) ----------------------------------------------------
  /** Wrap a registered tab def in the shape the built-in tabs have. Its mount runs now, once. */
  function adaptTab(def) {
    const el = h('div.tabpanel');
    let handle = null;
    try { handle = def.mount(app, el) || null; } catch (e) { app.reportError(`tab.${def.id}.mount`, e); }
    const call = (fn) => {
      if (!handle || typeof handle[fn] !== 'function') return;
      try { handle[fn](); } catch (e) { app.reportError(`tab.${def.id}.${fn}`, e); }
    };
    return {
      id: def.id, label: def.label, title: def.label, icon: def.icon, el, def, flush: Boolean(def.flush),
      show() { call('show'); }, refresh() { call('update'); }, hide() { call('hide'); },
    };
  }
  const allowed = (t) => {
    if (!t.def || typeof t.def.when !== 'function') return true;
    try { return Boolean(t.def.when(app)); } catch (e) { return false; }
  };
  function addRegistered(def) {
    const t = adaptTab(def);
    ORDER.set(t.id, def.order ?? 70);
    tabs.push(t);
    tabs.sort((a, b) => (ORDER.get(a.id) ?? 70) - (ORDER.get(b.id) ?? 70));
    byId.set(t.id, t);
    const b = tabButton(t);
    const next = tabs[tabs.indexOf(t) + 1];
    rail.insertBefore(b, next ? tabBtns.get(next.id) : railSpacer);
    scroll.appendChild(tabPane(t));
    b.hidden = !allowed(t);
  }
  function removeRegistered(t) {
    if (active === t.id) show('inspector');
    if (app.tab === t.id) app.setTab('inspector');
    tabs.splice(tabs.indexOf(t), 1);
    byId.delete(t.id);
    tabBtns.get(t.id)?.remove(); panes.get(t.id)?.remove();
    tabBtns.delete(t.id); badges.delete(t.id); panes.delete(t.id);
  }
  function syncRegistered() {
    const defs = getTabs();
    for (const t of tabs.slice()) if (t.def && !defs.includes(t.def)) removeRegistered(t);
    for (const def of defs) if (!byId.has(def.id)) addRegistered(def);
  }
  /** Show or hide registered tabs by their when(app); leave one that just went away. */
  function syncAllowed() {
    for (const t of tabs) {
      if (!t.def) continue;
      const on = allowed(t);
      const b = tabBtns.get(t.id);
      if (b && b.hidden === on) b.hidden = !on;
      if (!on && active === t.id) show('inspector');
    }
  }

  // --- state -----------------------------------------------------------------------------
  let active = null;
  const scrollPos = new Map();
  let unread = 0;

  function show(id) {
    let t = byId.get(id) || byId.get('inspector');
    if (t.def && !allowed(t)) t = byId.get('inspector');
    if (active && active !== t.id) {
      scrollPos.set(active, scroll.scrollTop);
      const prev = byId.get(active);
      if (prev?.def) prev.hide();
    }
    active = t.id;
    for (const [k, b] of tabBtns) b.setAttribute('aria-selected', String(k === t.id));
    for (const [k, p] of panes) p.hidden = k !== t.id;
    scroll.classList.toggle('is-flush', Boolean(t.flush));
    setText(headTitle, t.headTitle ? t.headTitle() : t.title);
    clear(tabActs);
    for (const b of t.headActions || []) tabActs.append(b);
    if (t.id === 'chronicle') { unread = 0; setText(badges.get('chronicle'), ''); }
    syncMore();
    if (app.world) { try { t.show(); } catch (e) { app.reportError(`panel.${t.id}.show`, e); } }
    scroll.scrollTop = scrollPos.get(t.id) || 0;
  }

  function visible() {
    if (appEl.classList.contains('ui-hidden')) return false;
    if (isCompact()) return panel.classList.contains('is-open');
    return !panel.classList.contains('is-collapsed');
  }

  function onTabClick(id) {
    if (isCompact()) {
      setTools(false);
      if (panel.classList.contains('is-open') && active === id) { setSheet('closed'); return; }
      setSheet(panel.classList.contains('is-tall') ? 'tall' : 'open');
    } else if (panel.classList.contains('is-collapsed')) setCollapsed(false);
    else if (active === id && !isCompact()) { setCollapsed(true); return; }
    app.setTab(id);
  }

  /** How much of the map's right side the folio covers (CSS px), for the HUD and the camera. */
  function syncCover() {
    const r = panel.getBoundingClientRect();
    const cover = isCompact() ? 0 : Math.max(0, (window.innerWidth || 0) - r.left);
    appEl.style.setProperty('--folio-cover', Math.round(cover) + 'px');
  }
  app.folioCover = () => { if (isCompact()) return 0; const r = panel.getBoundingClientRect(); return Math.max(0, (window.innerWidth || 0) - r.left); };
  window.addEventListener('resize', syncCover);
  panel.addEventListener('transitionend', syncCover);

  function setCollapsed(on) {
    panel.classList.toggle('is-collapsed', on);
    requestAnimationFrame(syncCover);
    setPref('panelCollapsed', on);
    clear(foldBtn);
    foldBtn.appendChild(svgEl(glyph('back', 18)));
    foldBtn.firstChild.style.transform = on ? 'scaleX(-1)' : '';
    tip(foldBtn, on ? 'Open the panel' : 'Fold the panel', '', '\\');
    if (!on && active) byId.get(active)?.show();
    requestAnimationFrame(() => app.r('resize'));
    setTimeout(() => app.r('resize'), 260);
  }
  function setWide(on) {
    panel.classList.toggle('is-wide', on);
    requestAnimationFrame(syncCover);
    setPref('panelWide', on);
    clear(wideBtn);
    wideBtn.appendChild(svgEl(glyph(on ? 'collapse' : 'expand', 18)));
    wideBtn.setAttribute('aria-label', on ? 'Narrow the folio' : 'Expand the folio');
    wideBtn.setAttribute('aria-pressed', String(on));
    tip(wideBtn, on ? 'Narrow the folio' : 'Expand the folio');
    setTimeout(() => { app.r('resize'); if (active) byId.get(active)?.show(); }, 240);
  }
  // --- phone sheet: peek (rail only), open (about half the screen) or tall ----------------------
  // Heights are set here, not only in CSS, so the map can be framed above the sheet's final edge
  // while it is still sliding.
  const sheetState = () => (panel.classList.contains('is-tall') ? 'tall' : panel.classList.contains('is-open') ? 'open' : 'closed');
  function sheetPx(state) {
    const vh = window.innerHeight || 800;
    if (state === 'tall') return Math.max(240, vh - 56);
    if (state === 'open') return Math.round(Math.max(220, Math.min(vh * 0.52, 520)));
    return null;
  }
  function applySheetHeight() {
    const px = isCompact() ? sheetPx(sheetState()) : null;
    if (px == null) panel.style.removeProperty('--sheet-h'); else panel.style.setProperty('--sheet-h', px + 'px');
  }
  function setSheet(state) {
    if (state !== 'closed' && appEl.classList.contains('is-tools')) setTools(false);
    panel.classList.toggle('is-open', state !== 'closed');
    panel.classList.toggle('is-tall', state === 'tall');
    applySheetHeight();
    syncInsets();
    if (state !== 'closed' && active) byId.get(active)?.show();
  }
  window.addEventListener('resize', applySheetHeight);

  /** The open strip of map above an open sheet (canvas px), or null when nothing covers the map. */
  function openStrip() {
    if (!isCompact()) return null;
    const px = sheetPx(sheetState());
    if (px == null) return null;
    const canvas = document.getElementById('map');
    const cr = canvas.getBoundingClientRect();
    const hud = document.querySelector('.hud-top')?.getBoundingClientRect();
    const top = hud && hud.height ? hud.bottom - cr.top + 8 : 8;
    const bottom = window.innerHeight - px - cr.top - 8;
    return bottom - top >= 48 ? { top, bottom, height: cr.height, width: cr.width } : null;
  }
  // where app.focus should put its target: the middle of the open strip, as an offset from the canvas centre
  app.viewBias = () => { const st = openStrip(); syncInsets(st); return st ? (st.top + st.bottom) / 2 - st.height / 2 : 0; };
  /** Height (CSS px) of the map left open above a phone's sheet, or null when the whole map shows (app.frameBox). */
  app.openStripHeight = () => { const st = openStrip(); return st ? st.bottom - st.top : null; };
  /** Tell the camera which part of the map the sheet hides, so places near the world's edge can be framed above it. */
  function syncInsets(st = openStrip()) {
    if (st) app.r('setViewInsets', Math.max(0, st.top - 8), Math.max(0, st.height - st.bottom - 8));
    else app.r('setViewInsets', 0, 0);
    // overlays on the map (the Director's caption, the timeline) rise above an open sheet
    const cover = isCompact() ? (sheetPx(sheetState()) ?? 0) : 0;
    const stage = document.getElementById('stage');
    stage?.style.setProperty('--sheet-cover', Math.round(cover) + 'px');
    // and draw in as it rises: half open they keep to a line or two, raised tall they step aside
    if (stage) stage.dataset.sheet = isCompact() ? sheetState() : '';
  }
  app.syncViewInsets = () => syncInsets();
  window.addEventListener('resize', () => syncInsets());

  /** On a phone, bring a selection out from under the sheet into the open strip. */
  const POINT_KINDS = new Set(['tile', 'settlement', 'army', 'storm', 'volcano']);
  let revealTimer = 0;
  function revealSelection() {
    const st = openStrip();
    // nations, wars and faiths are regions: they are framed when focused, never chased on a tap
    const p = st && app.selection && POINT_KINDS.has(app.selection.kind) ? selectionPoint(app, app.selection) : null;
    const cam = app.renderer?.camera;
    if (!p || !cam) return;
    const sp = app.r('tileToScreen', p.x + 0.5, p.y + 0.5);
    if (!sp || (sp.sy >= st.top + 16 && sp.sy <= st.bottom - 16 && sp.sx >= 16 && sp.sx <= st.width - 16)) return;
    const z = cam.zoom;
    app.r('focusOn', p.x + 0.5, p.y + 0.5 - app.viewBias() / z, z);
  }

  // grip drag (phones): the sheet follows the finger, then settles on the nearest height,
  // nudged by the direction and speed of the flick. A tap toggles between peek and open.
  let drag = null;   // { y0, h0, lastY, lastT, v, moved }
  const peekPx = () => { const v = parseFloat(getComputedStyle(panel).getPropertyValue('--sheet-peek')); return Number.isFinite(v) ? v : 68; };
  grip.addEventListener('pointerdown', (e) => {
    if (!isCompact()) return;
    e.preventDefault();
    try { grip.setPointerCapture(e.pointerId); } catch (err) { /* synthetic event */ }
    const h0 = panel.getBoundingClientRect().height;
    drag = { y0: e.clientY, h0, lastY: e.clientY, lastT: performance.now(), v: 0, moved: false };
    panel.classList.add('is-dragging');
  });
  grip.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const t = performance.now();
    const dt = Math.max(1, t - drag.lastT);
    drag.v = 0.7 * drag.v + 0.3 * ((e.clientY - drag.lastY) / dt);   // px per ms, + is downward
    drag.lastY = e.clientY; drag.lastT = t;
    if (Math.abs(e.clientY - drag.y0) > 4) drag.moved = true;
    if (!drag.moved) return;
    const vh = window.innerHeight || 800;
    const hNow = Math.max(peekPx(), Math.min(vh - 40, drag.h0 - (e.clientY - drag.y0)));
    panel.style.setProperty('--sheet-h', Math.round(hNow) + 'px');
  });
  const endDrag = (e) => {
    if (!drag) return;
    const d = drag; drag = null;
    panel.classList.remove('is-dragging');
    const cur = sheetState();
    if (!d.moved) { setSheet(cur === 'closed' ? 'open' : 'closed'); return; }
    const vh = window.innerHeight || 800;
    const hEnd = d.h0 - ((e?.clientY ?? d.lastY) - d.y0);
    // project the flick a little way forward, then pick the closest resting height
    const projected = hEnd - d.v * 180;
    const options = [['closed', peekPx()], ['open', sheetPx('open')], ['tall', sheetPx('tall') ?? vh - 56]];
    let best = options[0], bd = Infinity;
    for (const o of options) { const dd = Math.abs(o[1] - projected); if (dd < bd) { bd = dd; best = o; } }
    setSheet(best[0]);
  };
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);

  setCollapsed(getPref('panelCollapsed', false));
  setWide(getPref('panelWide', false));

  // --- events --------------------------------------------------------------------------
  app.on('tab', (id) => show(id));
  app.on('select', () => {
    const t = byId.get('inspector');
    scrollPos.delete('inspector');   // a new record opens at its top, not where the last one was left
    t.onSelect();
    if (active === 'inspector') setText(headTitle, t.headTitle());
    if (isCompact() && app.selection) {
      if (!panel.classList.contains('is-open')) setSheet('open');
      // wait out a possible double tap before moving the map under the finger
      clearTimeout(revealTimer);
      revealTimer = setTimeout(revealSelection, 420);
    }
  });
  app.on('world', () => {
    for (const t of tabs) { try { t.onWorld?.(); } catch (e) { app.reportError(`panel.${t.id}.onWorld`, e); } }
    unread = 0;
    syncAllowed();
    show(TABS.includes(app.tab) ? app.tab : 'inspector');
  });
  app.on('tick', () => {
    const w = app.world;
    if (!w) return;
    if (tabs.length > BUILTIN_TABS.length) syncAllowed();
    if (active !== 'chronicle') {
      const n = countNewMajor(w);
      if (n !== unread) { unread = n; setText(badges.get('chronicle'), unread ? (unread > 99 ? '99+' : String(unread)) : ''); }
    } else seenSeq = w.chronicle.seq;
    if (!visible() || !active) return;
    const t = byId.get(active);
    try { t.refresh(); } catch (e) { app.reportError(`panel.${active}.refresh`, e); }
  });
  app.on('worldEdited', () => { if (visible() && active) byId.get(active)?.refresh(); });
  app.on('layout', (what) => {
    if (what === 'toggle-panel') { if (isCompact()) setSheet(panel.classList.contains('is-open') ? 'closed' : 'open'); else setCollapsed(!panel.classList.contains('is-collapsed')); }
    else if (what === 'open-panel' || what === 'open') { if (isCompact()) setSheet('open'); else setCollapsed(false); }
    else if (what === 'collapsed') setCollapsed(true);
    else if (what === 'wide') { setCollapsed(false); setWide(true); }
    else if (what === 'hide-ui' || what === 'toggle-ui') {
      const hide = what === 'hide-ui' ? true : !appEl.classList.contains('ui-hidden');
      appEl.classList.toggle('ui-hidden', hide);
      const hint = document.getElementById('ui-hint');
      if (hint) {
        hint.hidden = !hide;
        if (hide) {
          let coarse = false;
          try { coarse = window.matchMedia('(pointer: coarse)').matches; } catch (e) { /* assume a mouse */ }
          hint.textContent = coarse ? 'Tap here to show the instruments' : 'Press H, or click here, to show the instruments';
          hint.style.animation = 'none'; void hint.offsetWidth; hint.style.animation = '';
        }
      }
      setTimeout(() => app.r('resize'), 30);
    }
  });

  document.getElementById('ui-hint')?.addEventListener('click', () => app.emit('layout', 'toggle-ui'));

  let seenSeq = 0;
  function countNewMajor(w) {
    if (!seenSeq) seenSeq = w.chronicle.seq;
    let n = 0;
    const es = w.chronicle.entries;
    for (let k = es.length - 1; k >= 0; k--) { if (es[k].seq <= seenSeq) break; if (es[k].imp >= 3) n++; }
    return n;
  }
  app.on('world', (w) => { seenSeq = w.chronicle.seq; });
  // after a leap (or a run until…) the badge starts afresh, unless the viewer asked to keep the count
  const clearBadge = () => {
    if (!app.world || !getNotices().badgeAfterLeap) return;
    seenSeq = app.world.chronicle.seq;
    unread = 0;
    setText(badges.get('chronicle'), '');
  };
  app.on('leapDone', clearBadge);
  app.on('historySkipped', clearBadge);
  app.on('worldRestored', clearBadge);

  syncRegistered();
  onRegistryChange((kind) => { if (kind === 'tab') syncRegistered(); });

  show(app.tab);
}

