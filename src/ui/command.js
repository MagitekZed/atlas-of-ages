// The command palette: '/' or Ctrl/Cmd K. One field that finds anything — nations living and
// fallen, settlements and ruins, wars, faiths, plagues, great people, wonders, the named
// geography, volcanoes, storms, roaming bands, historic sites, map modes, god tools, every
// registered command and search source — and, with '#', the Chronicle's text.
// Prefixes narrow it: '>' commands, '@' places, '#' the Chronicle. Matching is fuzzy and
// blind to accents, apostrophes and hyphens (Yi'thathun is found by "yithat"). Enter flies
// there and opens the record; Alt+Enter opens it without moving the map; Shift+Enter watches
// it. An empty field offers what you opened lately in this world and a few suggestions.
// The index is built when the palette opens (a few ms) and dropped when it closes.

import { DAYS_PER_YEAR, BAND_KINDS, SPEEDS } from '../core/constants.js';
import * as kernelTools from '../core/tools.js';
import { getTools } from '../core/tools.js';
import { liveSettlements } from '../core/entities.js';
import { registerKey, registerCommand, getCommands, getView, searchAll, registryVersion } from './registry.js';
import { h, clear } from './dom.js';
import { iconEl } from './icons.js';
import { getPref, setPref } from './prefs.js';
import { statusToast, focusEntry } from './toasts.js';
import { setTheme } from './theme.js';
import { openSaves, quickSave } from './saves.js';
import { openLeap, showHelp } from './hud.js';
import { OVERLAYS } from './mapdock.js';
import * as F from './format.js';

const MAX_ROWS = 40;
const MAX_CHRON = 8;
const RECENT_MAX = 8;
const REGION_KINDS = new Set(['civ', 'war', 'plague', 'religion']);

/** Lower case without accents, apostrophes or hyphens: what matching compares. */
export function norm(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’‘`ʼ\-‐–]/g, '').toLowerCase();
}

// names repeat across opens: normalise each string once
const normCache = new Map();
function normC(s) {
  let v = normCache.get(s);
  if (v === undefined) {
    v = norm(s);
    if (normCache.size > 30000) normCache.clear();
    normCache.set(s, v);
  }
  return v;
}

/** How well query q (normalised) matches text t (normalised): 0 for no match, up to ~120. */
export function matchScore(q, t) {
  if (!q) return 1;
  if (!t) return 0;
  if (t === q) return 120;
  if (t.startsWith(q)) return 100 + (q.length / t.length) * 15;
  const at = t.indexOf(q);
  if (at > 0) {
    const wordStart = /[\s(,.]/.test(t[at - 1]);
    return (wordStart ? 85 : 62) - Math.min(20, at * 0.4);
  }
  // subsequence, rewarding runs and word starts
  let qi = 0, score = 0, run = 0, last = -2;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] !== q[qi]) continue;
    const start = i === 0 || /[\s(,.]/.test(t[i - 1]);
    run = i === last + 1 ? run + 1 : 0;
    score += 2 + run * 2 + (start ? 4 : 0);
    last = i; qi++;
  }
  if (qi < q.length) return 0;
  return Math.min(55, 12 + score * (q.length / Math.max(q.length, t.length / 2)));
}

export function mount(app) {
  let el = null;        // the open palette { scrim, input, list, rows, index, sel }
  let lastQuery = '';

  // ---------------------------------------------------------------------------
  // The index

  // the index is kept between opens while the world has not moved on much (half a month)
  let cache = null;
  function indexKey() {
    const w = app.world;
    if (!w) return 'none';
    return [w.seed, w.name, Math.floor(w.time.day / 15), w.civs.length, w.settlements.length, w.wars.length, w.religions.length, w.plagues.length, w.figures.length, w.wonders.length, w.storms.length, (w.bands || []).length, (w.sites || []).length, registryVersion()].join('|');
  }
  /** The world's things (cached while the world has not moved on), then the actions (always fresh: they depend on the selection). */
  function getIndex() {
    const key = indexKey();
    if (!(cache && cache.key === key && cache.world === app.world)) cache = { key, world: app.world, index: buildWorldIndex() };
    return cache.index.concat(buildActionIndex());
  }
  const addTo = (out) => (o) => { o.n = normC(o.label) + (o.alt ? ' ' + normC(o.alt) : ''); out.push(o); };

  // records that can no longer change (a fallen nation, a ruin, an ended war, a dead faith, a
  // spent plague, a dead figure, a lost wonder) are indexed once per world and reused: a late
  // world holds thousands of them, and rebuilding their rows made each open slower with age
  let closed = { world: null, map: new Map() };
  function once(key, make) {
    if (closed.world !== app.world) closed = { world: app.world, map: new Map() };
    let e = closed.map.get(key);
    if (e === undefined) {
      const o = make();
      e = o ? { ...o, n: normC(o.label) + (o.alt ? ' ' + normC(o.alt) : '') } : null;
      closed.map.set(key, e);
    }
    return e;
  }

  // a world just opened is indexed in idle time, so the first open is as quick as the rest
  app.on('world', (w) => {
    const warm = () => { if (app.world === w && !el && !app.fastForwarding) { try { cache = { key: indexKey(), world: w, index: buildWorldIndex() }; } catch (e) { cache = null; } } };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 8000 }); else setTimeout(warm, 2000);
  });

  function buildWorldIndex() {
    const w = app.world;
    const out = [];
    const add = addTo(out);
    const kept = (e) => { if (e) out.push(e); };
    if (w) {
      for (const c of w.civs) {
        if (!c) continue;
        if (c.alive === false) {
          kept(once('c' + c.id, () => ({ group: 'Nations', kind: 'civ', id: c.id, label: c.name, alt: c.baseName !== c.name ? c.baseName : '', icon: 'nations', color: c.colorHex,
            sub: `Fell ${F.year(c.fallenDay)} · ${F.lifespan(c.foundedDay, c.fallenDay)}`, w: Math.log10((c.population || c.peakPopulation || 1) + 1), sel: { kind: 'civ', id: c.id } })));
          continue;
        }
        add({ group: 'Nations', kind: 'civ', id: c.id, label: c.name, alt: c.baseName !== c.name ? c.baseName : '', icon: 'nations', color: c.colorHex,
          sub: c.alive === false ? `Fell ${F.year(c.fallenDay)} · ${F.lifespan(c.foundedDay, c.fallenDay)}` : `${F.titleCase(c.government || 'tribe')} · ${F.eraName(c.tech?.era)} · ${F.people(c.population)}`,
          w: (c.alive === false ? 0 : 3) + Math.log10((c.population || c.peakPopulation || 1) + 1), sel: { kind: 'civ', id: c.id } });
      }
      for (const s of w.settlements) {
        if (!s) continue;
        const c = w.civs[s.civId];
        if (s.alive) add({ group: 'Places', kind: 'settlement', id: s.id, label: s.name, alt: s.epithet || '', icon: 'town', color: c?.colorHex, sub: `${F.tierName(s.tier)} · ${F.people(s.population)}${c ? ' · ' + c.name : ''}`, w: 3 + Math.log10((s.population || 1) + 1), sel: { kind: 'settlement', id: s.id }, place: true });
        else kept(once('s' + s.id, () => ({ group: 'Places', kind: 'settlement', id: s.id, label: `Ruins of ${s.name}`, alt: s.name, icon: 'ruin', sub: `${s.destroyCause ? F.humanize(s.destroyCause) + ' · ' : ''}${F.year(s.destroyedDay)} · once ${F.people(s.peakPopulation || 0)}`, w: Math.log10((s.peakPopulation || 1) + 1) * 0.6, sel: { kind: 'settlement', id: s.id }, place: true })));
      }
      const warRow = (war) => {
        const dead = Object.values(war.casualties || {}).reduce((a, v) => a + (Number(v) || 0), 0);
        return { group: 'Wars', kind: 'war', id: war.id, label: war.name, icon: 'war', color: w.civs[war.attackers?.[0]]?.colorHex,
          sub: `${war.active ? 'Ongoing since ' + F.year(war.startDay) : F.lifespan(war.startDay, war.endDay)}${dead > 0 ? ' · ' + F.people(dead) + ' dead' : ''}`,
          w: (war.active ? 4 : 0) + Math.log10(dead + 1) * 0.5, sel: { kind: 'war', id: war.id } };
      };
      for (const war of w.wars) {
        if (!war) continue;
        if (war.active) add(warRow(war)); else kept(once('w' + war.id, () => warRow(war)));
      }
      for (const r of w.religions) {
        if (!r) continue;
        if (r.alive === false) kept(once('r' + r.id, () => ({ group: 'Faiths', kind: 'religion', id: r.id, label: r.name, icon: 'faith', color: r.colorHex, sub: 'A dead faith', w: 0, sel: { kind: 'religion', id: r.id } })));
        else add({ group: 'Faiths', kind: 'religion', id: r.id, label: r.name, icon: 'faith', color: r.colorHex, sub: `Founded ${F.year(r.foundedDay)}`, w: 2, sel: { kind: 'religion', id: r.id } });
      }
      for (const p of w.plagues) {
        if (!p) continue;
        if (p.active) add({ group: 'Plagues', kind: 'plague', id: p.id, label: p.name, icon: 'plague', sub: `Spreading since ${F.year(p.startDay)}`, w: 3 + Math.log10((p.deaths || 0) + 1) * 0.4, sel: { kind: 'plague', id: p.id } });
        else kept(once('p' + p.id, () => ({ group: 'Plagues', kind: 'plague', id: p.id, label: p.name, icon: 'plague', sub: `${F.lifespan(p.startDay, p.endDay)} · ${F.people(p.deaths || 0)} dead`, w: Math.log10((p.deaths || 0) + 1) * 0.4, sel: { kind: 'plague', id: p.id } })));
      }
      const figView = getView('figure');
      for (const f of w.figures) {
        if (!f || !f.name) continue;
        const s = f.sid != null ? w.settlements[f.sid] : null;
        const sel = figView ? { kind: 'figure', id: f.id } : s ? { kind: 'settlement', id: s.id } : f.civId != null && w.civs[f.civId] ? { kind: 'civ', id: f.civId } : null;
        if (!sel) continue;
        const row = () => ({ group: 'People', kind: 'figure', id: f.id, label: f.name, icon: f.kind === 'general' ? 'army' : f.kind === 'prophet' ? 'prophet' : 'people', sub: `${F.humanize(f.kind || 'figure')}${w.civs[f.civId] ? ' of ' + w.civs[f.civId].name : ''}${f.died != null ? ' · died ' + F.year(f.died) : ''}`, w: (f.deeds?.length || 0) * 0.3 + (f.died == null ? 1 : 0), sel });
        if (f.died != null) kept(once('f' + f.id, row)); else add(row());
      }
      const wonderView = getView('wonder');
      for (const wd of w.wonders) {
        if (!wd || !wd.name) continue;
        const s = w.settlements[wd.sid];
        const sel = wonderView ? { kind: 'wonder', id: wd.id } : s ? { kind: 'settlement', id: s.id } : null;
        if (!sel) continue;
        add({ group: 'Wonders', kind: 'wonder', id: wd.id, label: wd.name, icon: 'miracle', sub: `${F.humanize(wd.kind)}${s ? ' · ' + s.name : ''}${wd.destroyedDay != null ? ' · destroyed ' + F.year(wd.destroyedDay) : ' · built ' + F.year(wd.builtDay)}`, w: wd.destroyedDay == null ? 2 : 0.5, sel });
      }
      (w.features || []).forEach((ft, k) => {
        if (!ft || !ft.name) return;
        add({ group: 'Geography', kind: 'feature', id: k, label: ft.name, icon: FEATURE_ICON[ft.kind] || 'world', sub: F.humanize(ft.kind), w: Math.log10((ft.size || 1) + 1), feature: ft, place: true });
      });
      for (const v of w.volcanoes) if (v && v.name) add({ group: 'Volcanoes', kind: 'volcano', id: v.id, label: v.name, icon: 'volcano', sub: v.erupting > 0 ? 'Erupting now' : v.lastEruption != null ? `Last erupted ${F.year(v.lastEruption)}` : 'Volcano', w: v.erupting > 0 ? 4 : 1, sel: { kind: 'volcano', id: v.id }, place: true });
      for (const s of w.storms) if (s) add({ group: 'Storms', kind: 'storm', id: s.id, label: s.name || F.humanize(s.kind), icon: 'storm', sub: `${F.humanize(s.kind)} · intensity ${Math.round((s.intensity || 0) * 100)}%`, w: 2 + (s.intensity || 0), sel: { kind: 'storm', id: s.id } });
      const bandView = getView('band');
      for (const b of w.bands || []) {
        if (!b) continue;
        const meta = BAND_KINDS[b.kind];
        const sel = bandView ? { kind: 'band', id: b.id } : null;
        add({ group: 'Bands', kind: 'band', id: b.id, label: b.name || meta?.label || 'Band', alt: b.epithet || '', icon: b.family === 'beast' ? 'predators' : 'army', sub: `${meta?.label || F.humanize(b.kind)}${b.state ? ' · ' + F.humanize(b.state).toLowerCase() : ''}`, w: 1.5, sel, x: b.x, y: b.y });
      }
      const siteView = getView('site');
      for (const st of w.sites || []) {
        if (!st || !st.name) continue;
        add({ group: 'Sites', kind: 'site', id: st.id, label: st.name, icon: st.kind === 'battle' || st.kind === 'siege' ? 'war' : st.kind === 'ruin' ? 'ruin' : 'pin', sub: `${F.humanize(st.kind)}${st.firstDay != null ? ' · ' + F.year(st.firstDay) : ''}`, w: Math.min(3, st.fame || 0), sel: siteView ? { kind: 'site', id: st.id } : null, x: st.x, y: st.y, place: true });
      }
    }
    return out;
  }

  function buildActionIndex() {
    const w = app.world;
    const out = [];
    const add = addTo(out);
    for (const m of app.mapModes()) add({ group: 'Map modes', kind: 'mode', id: m.id, label: `${m.label} map`, alt: m.label, icon: 'layers', sub: m.desc || 'Map mode', w: 1, run: () => setMode(m.id) });
    const tools = w && typeof kernelTools.availableTools === 'function' ? kernelTools.availableTools(w) : getTools();
    for (const t of tools) {
      if (!t || t.hidden || t.target === 'entity') continue;
      add({ group: 'God tools', kind: 'tool', id: t.id, label: t.label, icon: t.icon || t.id, sub: t.desc || 'God tool', w: 1, run: () => app.setTool(t.id) });
    }
    for (const c of getCommands(app)) add({ group: c.group || 'Commands', kind: 'command', id: c.id, label: c.label, alt: (c.keywords || []).join(' '), icon: c.icon || 'menu', sub: c.keys ? `Shortcut ${c.keys}` : (c.group || 'Command'), w: 1.2, cmd: c });
    return out;
  }

  function setMode(id) {
    app.r('setMapMode', id);
    setPref('mapMode', id);
    app.emit('mapmode', id);
  }

  // ---------------------------------------------------------------------------
  // Searching

  function search(raw) {
    const idx = el.index;
    let q = raw.trim();
    let scope = null;
    if (q[0] === '>' || q[0] === '@' || q[0] === '#') { scope = q[0]; q = q.slice(1).trim(); }
    const nq = norm(q);
    const out = [];
    if (scope === '#') return chronicleRows(nq, 30);
    if (!nq && !scope) return suggestions();
    for (const e of idx) {
      if (scope === '>' && !(e.kind === 'command' || e.kind === 'mode' || e.kind === 'tool')) continue;
      if (scope === '@' && !e.place) continue;
      const m = matchScore(nq, e.n);
      if (m <= 0) continue;
      out.push({ e, score: m + e.w * 2.2 });
    }
    if (scope !== '@') for (const x of numberRows(q, scope)) out.push({ e: x, score: 160 });
    if (!scope && nq.length >= 1) {
      try { for (const r of searchAll(app, q, 12)) out.push({ e: { group: r.source || 'More', kind: r.kind, id: r.id, label: r.label, sub: r.sub, icon: r.icon, color: r.color, run: r.run, sel: !r.run && r.kind != null && r.id != null ? { kind: r.kind, id: r.id } : null }, score: Number(r.score) || 30 }); } catch (e) { app.reportError('command.search', e); }
    }
    out.sort((a, b) => b.score - a.score);
    const rows = out.slice(0, MAX_ROWS).map((o) => o.e);
    if (!scope && nq.length >= 3) rows.push(...chronicleRows(nq, MAX_CHRON));
    return rows;
  }

  /** '>leap 500', 'year 312', 'rewind 200': numbers become actions. */
  function numberRows(q, scope) {
    const w = app.world;
    if (!w) return [];
    const m = /^(leap|skip|ahead|forward|rewind|back|until|year|go to)?\s*(?:year\s*)?(\d{1,4})\s*(years?)?$/i.exec(q.trim());
    if (!m) return [];
    const verb = (m[1] || '').toLowerCase();
    const n = Number(m[2]);
    const now = Math.floor(w.time.day / DAYS_PER_YEAR);
    const rows = [];
    if ((!verb || ['leap', 'skip', 'ahead', 'forward'].includes(verb)) && n > 0 && n <= 5000 && (verb || m[3])) rows.push({ group: 'Commands', kind: 'command', id: 'leap.n', label: `Leap ${F.int(n)} years ahead`, icon: 'leap', sub: `To Year ${F.int(now + n)}`, run: () => app.leapAhead?.(n) });
    if ((verb === 'year' || verb === 'go to' || verb === 'until' || !verb) && n > now && n - now <= 5000) rows.push({ group: 'Commands', kind: 'command', id: 'until.year', label: `Run until Year ${F.int(n)}`, icon: 'hourglass', sub: `${F.int(n - now)} years from now`, run: () => app.runUntil ? app.runUntil('year', { year: n }) : app.leapAhead?.(n - now) });
    if ((verb === 'rewind' || verb === 'back' || verb === 'year' || verb === 'go to' || !verb) && n < now && app.chrono && n * DAYS_PER_YEAR >= app.chrono.earliestDay()) rows.push({ group: 'Chronoscope', kind: 'command', id: 'rewind.n', label: `Rewind to Year ${F.int(n)}`, icon: 'hourglass', sub: `${F.int(now - n)} years back · asks first`, run: () => app.chrono.rewindTo(n * DAYS_PER_YEAR) });
    return scope === '>' || verb || m[3] || rows.length ? rows : [];
  }

  function chronicleRows(nq, cap) {
    const w = app.world;
    if (!w || nq.length < 2) return [];
    const out = [];
    const es = w.chronicle.entries;
    for (let k = es.length - 1; k >= 0 && out.length < cap; k--) {
      const e = es[k];
      if (!normC(e.text).includes(nq)) continue;
      out.push({ group: 'Chronicle', kind: 'entry', id: e.seq, label: e.text, icon: 'chronicle', sub: `${F.monthYear(e.day)} · ${F.humanize(e.cat)}`, entry: e, long: true });
    }
    return out;
  }

  function suggestions() {
    const w = app.world;
    const rows = [];
    const recents = recentList().map((r) => el.index.find((e) => e.kind === r.kind && e.id === r.id)).filter(Boolean);
    for (const e of recents) rows.push({ ...e, group: 'Recent' });
    if (!w) return rows;
    const live = liveSettlements(w);
    const big = live.slice().sort((a, b) => (b.population || 0) - (a.population || 0))[0];
    if (big) rows.push({ ...el.index.find((e) => e.kind === 'settlement' && e.id === big.id), group: 'Suggestions', sub: `The largest city · ${F.people(big.population)}` });
    const top = w.civs.filter((c) => c && c.alive !== false).sort((a, b) => (b.population || 0) - (a.population || 0))[0];
    if (top) rows.push({ ...el.index.find((e) => e.kind === 'civ' && e.id === top.id), group: 'Suggestions', sub: `The greatest nation · ${F.people(top.population)}` });
    for (const war of w.wars.filter((q) => q.active).slice(-3).reverse()) rows.push({ ...el.index.find((e) => e.kind === 'war' && e.id === war.id), group: 'Suggestions' });
    for (const id of ['until.open', 'director.toggle', 'chrono.undo', 'leap.open', 'timeline.toggle']) {
      if (id === 'chrono.undo' && !app.chrono?.canUndo?.()) continue;
      const c = el.index.find((e) => e.kind === 'command' && e.id === id);
      if (c) rows.push({ ...c, group: 'Suggestions' });
    }
    return rows.filter((r) => r && r.label).slice(0, MAX_ROWS);
  }

  // ---------------------------------------------------------------------------
  // Recents (per world seed)

  function recentList() {
    const w = app.world;
    if (!w) return [];
    const all = getPref('story.cmdRecent', {}) || {};
    return Array.isArray(all[w.seed]) ? all[w.seed] : [];
  }
  function remember(e) {
    const w = app.world;
    if (!w || !e || e.kind === 'command' || e.kind === 'entry' || e.kind === 'mode' || e.kind === 'tool') return;
    const all = getPref('story.cmdRecent', {}) || {};
    const list = (Array.isArray(all[w.seed]) ? all[w.seed] : []).filter((r) => !(r.kind === e.kind && r.id === e.id));
    list.unshift({ kind: e.kind, id: e.id });
    all[w.seed] = list.slice(0, RECENT_MAX);
    const seeds = Object.keys(all);
    if (seeds.length > 12) for (const s of seeds.slice(0, seeds.length - 12)) delete all[s];
    setPref('story.cmdRecent', all);
  }

  // ---------------------------------------------------------------------------
  // Acting

  function act(e, how = 'go') {
    if (!e) return;
    close();
    remember(e);
    try {
      if (e.kind === 'entry') { focusEntry(app, e.entry); app.emit('chronicleScrollTo', e.entry.seq); return; }
      if (e.cmd) { e.cmd.run(app); return; }
      if (e.run && !e.sel) { e.run(); return; }
      if (e.feature) { flyToFeature(e.feature); return; }
      if (e.sel) {
        if (how === 'watch') { app.toggleWatch ? app.toggleWatch(e.sel) : statusToast(app, 'Watching is not available.', 'warn'); return; }
        const region = REGION_KINDS.has(e.sel.kind);
        if (how === 'open') { app.select(e.sel, { focus: false }); app.emit('layout', 'open-panel'); return; }
        app.select(e.sel, { frame: region, focus: !region });
        return;
      }
      if (Number.isFinite(e.x) && Number.isFinite(e.y)) { app.focus(e.x, e.y, Math.max(app.renderer?.camera?.zoom || 8, 12)); return; }
      if (e.run) e.run();
    } catch (err) { app.reportError('command.act', err); }
  }

  function flyToFeature(ft) {
    const w = app.world;
    const r = Math.max(4, Math.sqrt(ft.size || 16));
    if (Number.isFinite(ft.x) && Number.isFinite(ft.y)) app.frameBox({ x0: ft.x - r, y0: ft.y - r, x1: ft.x + r, y1: ft.y + r });
    const x = Math.round(ft.x), y = Math.round(ft.y);
    if (w && x >= 0 && y >= 0 && x < w.W && y < w.H) app.select({ kind: 'tile', id: y * w.W + x, x, y }, { openTab: false });
  }

  // ---------------------------------------------------------------------------
  // The overlay

  function open(initial = '') {
    if (el) { el.input.focus(); el.input.select(); return; }
    const t0 = performance.now();
    const input = h('input.cmdk-input', { type: 'text', id: 'cmdk-input', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'cmdk-list', 'aria-autocomplete': 'list', autocomplete: 'off', spellcheck: 'false', placeholder: 'Find a place, people, war… or type > for commands, # to search the Chronicle' });
    const list = h('div.cmdk-list', { id: 'cmdk-list', role: 'listbox', 'aria-label': 'Results' });
    const foot = h('div.cmdk-foot', null,
      h('span', null, h('kbd', { text: 'Enter' }), ' go'), h('span', null, h('kbd', { text: 'Alt Enter' }), ' open'), h('span', null, h('kbd', { text: 'Shift Enter' }), ' watch'),
      h('span', null, h('kbd', { text: '>' }), ' commands'), h('span', null, h('kbd', { text: '@' }), ' places'), h('span', null, h('kbd', { text: '#' }), ' chronicle'));
    const closeBtn = h('button.icon-btn.cmdk-close', { type: 'button', 'aria-label': 'Close' }, iconEl('close', { size: 18 }));
    const box = h('div.cmdk', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Find anything' },
      h('div.cmdk-head', null, iconEl('search', { size: 18 }), input, closeBtn), list, foot);
    const scrim = h('div.cmdk-scrim', null, box);
    document.body.appendChild(scrim);
    const ti = performance.now();
    el = { scrim, input, list, rows: [], index: getIndex(), sel: 0, prevFocus: document.activeElement, opened: performance.now() };
    el.indexMs = performance.now() - ti;
    input.value = initial;
    input.addEventListener('input', () => refresh());
    input.addEventListener('keydown', onKey);
    closeBtn.addEventListener('click', () => close());
    scrim.addEventListener('pointerdown', (ev) => { if (ev.target === scrim) close(); });
    refresh();
    input.focus();
    app.emit('commandOpen');
    el.openMs = performance.now() - t0;
    app.commandOpenMs = el.openMs;
    app.commandOpenStats = { index: el.indexMs, total: el.openMs, rows: el.rows.length, entries: el.index.length };
  }

  function close() {
    if (!el) return;
    lastQuery = el.input.value;
    const prev = el.prevFocus;
    el.scrim.remove();
    el = null;
    try { if (prev && prev.isConnected) prev.focus({ preventScroll: true }); } catch (e) { /* gone */ }
  }

  function refresh() {
    if (!el) return;
    el.rows = search(el.input.value);
    el.sel = 0;
    draw();
  }

  function draw() {
    const { list, rows } = el;
    clear(list);
    if (!rows.length) {
      list.appendChild(h('p.cmdk-empty', { text: el.input.value.trim() ? 'Nothing by that name. Try fewer letters, or # to search the Chronicle.' : 'Type to find anything in this world.' }));
      el.input.removeAttribute('aria-activedescendant');
      return;
    }
    let group = null;
    rows.forEach((e, k) => {
      if (e.group !== group) { group = e.group; list.appendChild(h('div.cmdk-group', { text: group, role: 'presentation' })); }
      const sw = e.color ? h('i.swatch', { style: { '--c': e.color } }) : null;
      const row = h('div.cmdk-row', { id: `cmdk-o${k}`, role: 'option', 'aria-selected': k === el.sel ? 'true' : 'false', class: (k === el.sel ? 'is-on' : '') + (e.long ? ' is-long' : '') },
        h('span.ci', null, iconEl(e.icon || e.kind, { size: 18, label: e.label })),
        h('span.cl', null, sw, h('span.ct', { text: e.label }), e.sub ? h('span.cs', { text: e.sub }) : null),
        h('span.ck', { text: KIND_TAG[e.kind] || '' }));
      row.addEventListener('pointermove', () => { if (el && el.sel !== k) { el.sel = k; mark(); } });
      row.addEventListener('click', (ev) => act(e, ev.altKey ? 'open' : ev.shiftKey ? 'watch' : 'go'));
      list.appendChild(row);
    });
    mark();
  }

  function mark() {
    const rows = el.list.querySelectorAll('.cmdk-row');
    rows.forEach((r, k) => { const on = k === el.sel; r.classList.toggle('is-on', on); r.setAttribute('aria-selected', on ? 'true' : 'false'); });
    const cur = rows[el.sel];
    if (cur) { el.input.setAttribute('aria-activedescendant', cur.id); cur.scrollIntoView({ block: 'nearest' }); }
  }

  function onKey(e) {
    if (!el) return;
    const n = el.rows.length;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (el.input.value) { el.input.value = ''; refresh(); } else close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); if (n) { el.sel = (el.sel + 1) % n; mark(); } return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); if (n) { el.sel = (el.sel - 1 + n) % n; mark(); } return; }
    if (e.key === 'PageDown') { e.preventDefault(); if (n) { el.sel = Math.min(n - 1, el.sel + 8); mark(); } return; }
    if (e.key === 'PageUp') { e.preventDefault(); if (n) { el.sel = Math.max(0, el.sel - 8); mark(); } return; }
    if (e.key === 'Enter') { e.preventDefault(); act(el.rows[el.sel], e.altKey ? 'open' : e.shiftKey ? 'watch' : 'go'); return; }
    if (e.key === 'Tab') { e.preventDefault(); if (n) { el.sel = (el.sel + (e.shiftKey ? -1 : 1) + n) % n; mark(); } }
  }

  // keep the palette above the map's keys: while it is open, its field owns the keyboard
  document.addEventListener('keydown', (e) => { if (el && e.target !== el.input && e.key === 'Escape') { e.preventDefault(); close(); } }, true);
  app.on('world', () => close());

  app.openCommand = open;

  // ---------------------------------------------------------------------------
  // Keys and the built-in commands the palette (and other modules) can run

  registerKey({ key: '/', label: 'Find anything: places, peoples, wars, commands (also Ctrl K)', group: 'Find', when: (a) => Boolean(a.world), run: () => open('') });
  registerKey({ key: 'k', mod: true, label: 'Find anything', group: 'Find', hidden: true, run: () => open('') });

  const cmd = (id, label, run, extra = {}) => registerCommand({ id, label, group: extra.group || 'Commands', icon: extra.icon || 'menu', keys: extra.keys, keywords: extra.keywords, when: extra.when || ((a) => Boolean(a.world)), run });
  cmd('time.toggle', 'Pause or resume time', (a) => a.togglePause(), { icon: 'pause', keys: 'Space', keywords: ['stop', 'play', 'resume'], group: 'Time' });
  SPEEDS.forEach((s, k) => { if (k > 0) cmd(`time.speed.${s.id}`, `${s.label} speed`, (a) => a.setSpeed(k), { icon: 'leap', keys: String(k), keywords: ['speed', 'pace', 'faster', 'slower'], group: 'Time' }); });
  cmd('leap.open', 'Leap ahead…', (a) => openLeap(a), { icon: 'leap', keys: 'J', keywords: ['skip', 'fast forward', 'years'], group: 'Time' });
  for (const n of [10, 50, 100, 500]) cmd(`leap.${n}`, `Leap ${n} years ahead`, (a) => a.leapAhead?.(n), { icon: 'leap', keywords: ['skip', 'fast forward'], group: 'Time' });
  cmd('world.save', 'Save and load…', (a) => openSaves(a), { icon: 'save', keywords: ['open', 'export', 'import', 'branch'], when: () => true });
  cmd('world.quicksave', 'Quick save', (a) => quickSave(a), { icon: 'save', keys: 'Ctrl S' });
  cmd('world.new', 'New world…', (a) => a.newWorld?.(), { icon: 'newWorld', keywords: ['genesis', 'restart'], when: () => true });
  cmd('view.fit', 'Show the whole world', (a) => { a.r('fitWorld'); a.emit('userCamera', { how: 'fit' }); }, { icon: 'fit', keys: 'F', group: 'Map' });
  cmd('view.hide', 'Hide the instruments', (a) => a.emit('layout', 'hide-ui'), { icon: 'eyeOff', keys: 'H', keywords: ['cinema', 'screenshot'], group: 'Map' });
  cmd('help.keys', 'Keyboard and mouse', (a) => showHelp(a), { icon: 'keyboard', keys: '?', keywords: ['help', 'shortcuts', 'keys'], when: () => true });
  for (const [v, lab] of [['light', 'Light theme'], ['dark', 'Dark theme'], ['system', 'Follow the system theme']]) cmd(`theme.${v}`, lab, (a) => setTheme(a, v), { icon: v === 'light' ? 'sun' : 'moon', keywords: ['theme', 'colours', 'night', 'day'], group: 'Look', when: () => true });
  for (const [key, label] of OVERLAYS) cmd(`overlay.${key}`, `Show or hide ${label.toLowerCase()}`, (a) => toggleOverlay(a, key), { icon: 'layers', keywords: ['overlay', 'layer', key], group: 'Map' });
  for (const [id, label] of [['inspector', 'Inspector'], ['chronicle', 'Chronicle'], ['nations', 'Nations ledger'], ['statistics', 'Statistics'], ['world', 'World settings'], ['atlas', 'Historical atlas']]) cmd(`tab.${id}`, `Open the ${label}`, (a) => { a.setTab(id); a.emit('layout', 'open-panel'); }, { icon: id === 'inspector' ? 'inspect' : id, keywords: ['tab', 'panel'], group: 'Panels' });

  function toggleOverlay(a, key) {
    const o = a.renderer?.overlays;
    const on = !(o && o[key] !== false);
    a.r('setOverlay', key, on);
    const saved = getPref('overlays', {}) || {};
    saved[key] = on;
    setPref('overlays', saved);
    a.emit('overlays');
    statusToast(a, `${OVERLAYS.find((x) => x[0] === key)?.[1] || key} ${on ? 'shown' : 'hidden'}.`, 'info', { icon: 'layers', ms: 1800 });
  }
}

const FEATURE_ICON = { continent: 'world', ocean: 'tsunami', sea: 'tsunami', island: 'island', range: 'mountain', lake: 'rain', river: 'rain', desert: 'drought', forest: 'forest' };
const KIND_TAG = { civ: 'Nation', settlement: 'Place', war: 'War', religion: 'Faith', plague: 'Plague', figure: 'Person', wonder: 'Wonder', feature: 'Land', volcano: 'Volcano', storm: 'Storm', band: 'Band', site: 'Site', mode: 'Map', tool: 'Tool', command: '', entry: 'Chronicle', pin: 'Pin' };
