// The map's context menu: a right-click without a drag, or a long-press in Inspect on touch
// (input.js emits 'mapContext'). It names the ground under the pointer (biome, height,
// holder), lists everything stacked there (pickAll) so overlapping icons stay reachable, and
// offers what can be done on that spot: inspect, follow, watch, pin the view, zoom in, run
// until something happens here, use the last god tool here, see this land in the Atlas a
// century ago, copy a link to this view — plus whatever other packages registered
// (registerContextProvider). Arrow keys move, Enter acts, Esc closes.

import { WATER, DAYS_PER_YEAR } from '../core/constants.js';
import { elevationMeters } from '../core/world.js';
import { getTool } from '../core/tools.js';
import { defaultParams, PARAMS } from '../core/params.js';
import { settlementAt } from '../core/entities.js';
import { contextItems } from './registry.js';
import { h } from './dom.js';
import { iconEl } from './icons.js';
import { closePopover, openModal } from './widgets.js';
import { statusToast } from './toasts.js';
import { describeSel, isMoverKind, kindLabel, followMode } from './app.js';
import * as F from './format.js';

const MAX_PICKS = 6;

export function mount(app) {
  let menu = null;    // { el, items: [button], prevFocus }

  function close() {
    if (!menu) return;
    const m = menu;
    menu = null;
    m.el.remove();
    try { if (m.prevFocus && m.prevFocus.isConnected) m.prevFocus.focus({ preventScroll: true }); } catch (e) { /* gone */ }
  }

  app.on('mapContext', (ctx) => {
    if (!app.world) return;
    try { openAt(ctx); } catch (e) { app.reportError('contextmenu', e); }
  });

  function openAt(ctx) {
    close();
    closePopover();
    const w = app.world;
    const canvas = document.getElementById('map');
    const cr = canvas.getBoundingClientRect();
    const items = [];
    const add = (icon, label, run, sub = '', cls = '') => items.push({ icon, label, run, sub, cls });
    const sep = (label = '') => items.push({ sep: true, label });
    const t = ctx.tile;
    const i = t ? t.i : -1;

    // what lies here
    const picks = [];
    const seen = new Set();
    for (const p of Array.isArray(ctx.picks) ? ctx.picks : []) {
      if (!p || p.kind == null || p.id == null || p.kind === 'fxPointer') continue;
      const k = p.kind + ':' + p.id;
      if (seen.has(k)) continue;
      seen.add(k);
      picks.push({ kind: p.kind, id: p.id });
    }
    if (t) { const s = settlementAt(w, i); if (s && s.alive && !seen.has('settlement:' + s.id)) picks.push({ kind: 'settlement', id: s.id }); }
    const owner = t && w.f.owner[i] >= 0 ? w.civs[w.f.owner[i]] : null;

    // the roads a town's caravans travel come as one row, not one per caravan
    const roads = picks.filter((p) => p.kind === 'caravan');
    let roadsShown = false;
    for (const p of picks.slice(0, MAX_PICKS)) {
      if (p.kind === 'pin') { const info = app.pinInfo?.(p.id); if (info) add('chronicle', info.title, () => app.emit('pinPicked', p.id), info.text); continue; }
      if (p.kind === 'caravan' && roads.length > 1) {
        if (roadsShown) continue;
        roadsShown = true;
        const d = describeSel(app, p);
        add(d.icon || 'road', `Inspect ${d.name}`, () => app.select(p, { focus: false }), `${F.int(roads.length)} roads meet here · ${roads.length - 1} more under the pointer`);
        continue;
      }
      const d = describeSel(app, p);
      const kl = p.kind === 'caravan' ? ((w.caravans || []).find((q) => q.id === p.id)?.kind === 'ship' ? 'Ship' : 'Caravan') : kindLabel(p.kind);
      add(d.icon || p.kind, `Inspect ${d.name}`, () => app.select(p, { focus: false }), `${kl}${d.sub ? ' · ' + d.sub : ''}`);
    }
    if (owner && !picks.some((p) => p.kind === 'civ' && p.id === owner.id)) add('nations', `Inspect ${owner.name}`, () => app.select({ kind: 'civ', id: owner.id }, { frame: true }), 'The nation that holds this ground');
    if (t) add('pin', 'Inspect this ground', () => app.select({ kind: 'tile', id: i, x: t.x, y: t.y }, { focus: false }));

    // follow and watch
    // a town, a band or an army is what the viewer means here, before a passing caravan
    const rank = (p) => (p.kind === 'settlement' ? 0 : p.kind === 'band' ? 1 : p.kind === 'army' ? 2 : p.kind === 'caravan' ? 9 : 5);
    const ranked = picks.filter((p) => p.kind !== 'pin').sort((a, b) => rank(a) - rank(b));
    const subject = ranked[0] || (owner ? { kind: 'civ', id: owner.id } : null);
    const mover = ranked.find((p) => isMoverKind(p.kind) && p.kind !== 'caravan');
    const follow = mover || (ranked[0] && ranked[0].kind === 'settlement' ? ranked[0] : null) || ranked.find((p) => p.kind === 'caravan') || (owner ? { kind: 'civ', id: owner.id } : null);
    if (follow || subject) sep();
    if (follow) {
      const d = describeSel(app, follow);
      if (app.isFollowing(follow)) add('eye', `Stop following ${d.name}`, () => { app.follow = null; });
      else add('eye', `Follow ${d.name}`, () => app.setFollow(follow), followMode(follow) === 'point' ? 'Keep it in the middle of the map' : 'Keep its lands framed');
    }
    if (subject && app.toggleWatch) {
      const d = describeSel(app, subject);
      add('star', app.isWatched?.(subject) ? `Stop watching ${d.name}` : `Watch ${d.name}`, () => app.toggleWatch(subject), 'Its news reaches you as gilded notices');
    }

    // run until… for this place or people
    const town = picks.find((p) => p.kind === 'settlement' && w.settlements[p.id]?.alive);
    if (app.runUntil && (town || owner)) {
      sep('Run until…');
      if (town) {
        const s = w.settlements[town.id];
        add('hourglass', `${s.name} changes hands`, () => app.runUntil('townHands', { sid: s.id }));
        add('hourglass', `${s.name} is besieged`, () => app.runUntil('townSiege', { sid: s.id }));
        if ((s.tier ?? 0) < 6) add('hourglass', `${s.name} grows into a ${F.tierName((s.tier ?? 0) + 1).toLowerCase()}`, () => app.runUntil('townTier', { sid: s.id }));
      }
      if (owner) {
        add('hourglass', `${owner.name} goes to war`, () => app.runUntil('war', { scope: 'civ', civId: owner.id }));
        add('hourglass', `${owner.name} falls`, () => app.runUntil('civFalls', { civId: owner.id }));
      }
    }

    // the view and the hand
    sep();
    if (t) add('target', 'Zoom in here', () => { app.emit('userCamera', { how: 'context' }); app.r('focusOn', t.x + 0.5, t.y + 0.5, Math.min(app.renderer?.camera?.maxZoom || 80, Math.max(14, (app.renderer?.camera?.zoom || 6) * 3))); });
    add('pin', 'Pin this view', () => app.emit('pinView'), 'B');
    const last = app.lastTool ? getTool(app.lastTool) : null;
    if (t && last && app.useToolAt) add(last.icon || last.id, `${last.label} here`, () => app.useToolAt(last.id, { x: ctx.sx, y: ctx.sy }), 'The god tool you used last');
    const atlas = w.history?.atlas || [];
    if (t && atlas.length > 1) {
      const want = Math.max(atlas[0].y, Math.floor(w.time.day / DAYS_PER_YEAR) - 100);
      let k = 0, bd = Infinity;
      atlas.forEach((sn, j) => { const d = Math.abs(sn.y - want); if (d < bd) { bd = d; k = j; } });
      add('atlas', `This land in Year ${F.int(atlas[k].y)}`, () => { app.setTab('atlas'); app.emit('layout', 'open-panel'); app.emit('atlasGoto', k); app.focus(t.x, t.y, Math.max(4, Math.min(10, app.renderer?.camera?.zoom || 6))); }, 'In the historical atlas');
    }
    if (t) add('open', 'Copy a link to this view', () => copyLink(t));

    // other packages
    let extra = [];
    try { extra = contextItems(app, { tile: t, picks, sx: ctx.sx, sy: ctx.sy }); } catch (e) { extra = []; }
    if (extra.length) { sep(); for (const it of extra) add(it.icon || 'star', it.label, it.run, it.sub || ''); }

    // the header: the ground under the pointer
    let headT = 'Beyond the edge of the world', headS = '';
    if (t) {
      const water = w.f.water[i] !== WATER.LAND;
      const m = elevationMeters(w, i);
      headT = water ? (w.f.water[i] === WATER.LAKE ? 'Lake' : 'Open sea') : F.biomeName(w.f.biome[i]);
      headS = `${water ? 'depth ' + F.int(-m) : F.int(m)} m${owner ? ' · ' + owner.name : water ? '' : ' · unclaimed'}`;
    }
    const el = h('div.ctx-menu', { role: 'menu', 'aria-label': `Actions here: ${headT}` },
      h('div.ctx-head', null, h('b', { text: headT }), headS ? h('span', { text: headS }) : null));
    const buttons = [];
    let lastSep = true;
    for (const it of items) {
      if (it.sep) {
        if (lastSep && !it.label) continue;
        el.appendChild(it.label ? h('div.menu-label', { text: it.label }) : h('div.menu-sep'));
        lastSep = true;
        continue;
      }
      const b = h('button.menu-item', { type: 'button', role: 'menuitem', tabindex: '-1' },
        iconEl(it.icon, { size: 18, label: it.label }),
        h('span.ctx-l', null, h('span', { text: it.label }), it.sub ? h('small', { text: it.sub }) : null));
      b.addEventListener('click', () => {
        // the finger that long-pressed is still lifting when the menu appears under it: that release is not a choice
        if (menu && performance.now() - menu.openedAt < 450) return;
        close(); try { it.run(); } catch (e) { app.reportError('contextmenu.item', e); }
      });
      el.appendChild(b);
      buttons.push(b);
      lastSep = false;
    }
    document.body.appendChild(el);
    // place it at the pointer, kept on screen
    const vw = window.innerWidth, vh = window.innerHeight;
    const mw = el.offsetWidth, mh = el.offsetHeight;
    let x = cr.left + ctx.sx + 4, y = cr.top + ctx.sy + 4;
    if (x + mw > vw - 8) x = Math.max(8, cr.left + ctx.sx - mw - 4);
    if (y + mh > vh - 8) y = Math.max(8, vh - mh - 8);
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';
    menu = { el, items: buttons, prevFocus: document.activeElement, openedAt: performance.now() };
    el.addEventListener('keydown', (e) => {
      const k = buttons.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(k + 1) % buttons.length]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(k - 1 + buttons.length) % buttons.length]?.focus(); }
      else if (e.key === 'Home') { e.preventDefault(); buttons[0]?.focus(); }
      else if (e.key === 'End') { e.preventDefault(); buttons[buttons.length - 1]?.focus(); }
      else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); close(); }
    });
    setTimeout(() => buttons[0]?.focus({ preventScroll: true }), 0);
  }

  // close on a click elsewhere, a wheel, a resize or a new world
  // (a press on the map that only dismisses the menu goes no further: it must not also select the ground under it)
  document.addEventListener('pointerdown', (e) => {
    if (!menu || menu.el.contains(e.target)) return;
    close();
    if (e.button === 0 && e.target === document.getElementById('map')) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  document.addEventListener('wheel', (e) => { if (menu && !menu.el.contains(e.target)) close(); }, { capture: true, passive: true });
  document.addEventListener('keydown', (e) => { if (menu && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }, true);
  window.addEventListener('resize', close);
  app.on('world', close);

  /** A link that rebuilds this world (seed and settings) at this year, looking at this spot. */
  function shareURL(t) {
    const w = app.world;
    const u = new URL(location.href.split('?')[0].split('#')[0]);
    const q = u.searchParams;
    q.set('autostart', '1');
    q.set('seed', String(w.seed));
    const defs = defaultParams();
    const set = [];
    for (const p of PARAMS) {
      if (p.key === 'seed') continue;
      const v = w.genesisParams?.[p.key];
      if (v === undefined || String(v) === String(defs[p.key])) continue;
      const s = String(v);
      if (/[,:]/.test(s)) continue;   // the set= format cannot carry these
      set.push(`${p.key}:${s}`);
    }
    if (set.length) q.set('set', set.join(','));
    q.set('years', String(Math.floor(w.time.day / DAYS_PER_YEAR)));
    if (t) q.set('select', `tile:${t.x},${t.y}`);
    const z = app.renderer?.camera?.zoom;
    if (Number.isFinite(z)) q.set('zoom', String(Math.round(z * 10) / 10));
    if (app.renderer?.mapMode && app.renderer.mapMode !== 'terrain') q.set('mode', app.renderer.mapMode);
    q.set('speed', '0');
    return u.toString();
  }

  async function copyLink(t) {
    const link = shareURL(t);
    const note = (app.world.interventions || []).length ? ' Your own acts are not part of it: the link rebuilds the world’s history as it would run untouched.' : '';
    try {
      await navigator.clipboard.writeText(link);
      statusToast(app, `A link to this view was copied.${note}`, 'ok', { icon: 'open', ms: 6000 });
    } catch (e) {
      const input = h('input.field', { type: 'text', value: link, readonly: true, 'aria-label': 'Link to this view' });
      openModal({ title: 'A link to this view', small: true, body: h('div', null, h('p.muted', { text: `Copy this link to share the view.${note}` }), input), actions: [{ label: 'Close', cls: 'btn-brass', onClick: (m) => m.close() }] });
      setTimeout(() => { input.focus(); input.select(); }, 30);
    }
  }
  app.shareURL = shareURL;
}
