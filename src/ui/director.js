// The Director: story mode. G or the Story button on the time drive hands the camera to an
// auto-cinematographer that finds the story as it happens and tells it.
//
// Shots come from four places: chronicle entries of importance 3 or more that happened
// somewhere (2 or more for the patron people; routine entries never), live scans of the
// world (sieges, erupting volcanoes, storms near land, great fires, plague fronts), the
// renderer's recent effects (battles, falling stars, quakes, waves) and registered director
// sources. Each is scored  base × (1 + imp²/5) × novelty × freshness  — novelty falls for a
// place or people shown in the last few shots, freshness decays over about eight seconds —
// and the camera only cuts when a shot beats the current one by half again or its time is up.
// It frames each with app.frameBox / app.focus (cutting instead of flying under reduced
// motion) and captions it in a lower third: the chronicle's sentence typed out, with
// Inspect, Follow and Skip.
// Pacing (optional): action slows time to Fast at most; empty stretches run at Rapid with a
// "quiet years" chip; the viewer's own speed comes back when the Director stops, and a speed
// the viewer picks meanwhile is respected. Moving the map, selecting or following something
// yourself suspends it for 20 s. While it runs, major notices it may caption are left out of
// the toast column (a toast filter); news about what you watch still comes through.
// It is offered (never forced) on a first world and on phones.

import { chronicleSince } from '../core/chronicle.js';
import { yearOf } from '../core/world.js';
import { registerKey, registerCommand, registerToastFilter, getDirectorSources } from './registry.js';
import { h, clear, svgEl, setText, isCompact, reducedMotion } from './dom.js';
import { glyph, iconEl } from './icons.js';
import { tip, openModal } from './widgets.js';
import { getPref, setPref, urlOptions } from './prefs.js';
import { offerToast, entryIcon } from './toasts.js';
import { entrySel, entryPoint, selectionFrame, selectionPoint, describeSel, categoryOf } from './app.js';
import * as F from './format.js';

const SUSPEND_MS = 20000;
const MIN_DWELL = 4500;        // a shot holds at least this long…
const EPOCH_CUT = 2200;        // …unless something epochal happens
const SWITCH_RATIO = 1.5;
const FRESH_MS = 8000;
const QUIET_SCORE = 0.9;       // below this nothing is worth a shot
const QUIET_AFTER = 4000;      // ms without a shot before the quiet years run fast
const COOLDOWN_MS = 60000;     // a place just shown is worth little for a minute
const FAST = 3, RAPID = 5;
const TYPE_CPS = 55;           // caption typewriter, characters a second

const CAT_BASE = { war: 1.15, disaster: 1.3, divine: 1.1, myth: 1.25, civ: 1, religion: 0.95, disease: 1.05, diplomacy: 0.7, tech: 0.75, culture: 0.8, trade: 0.55, nature: 0.85, climate: 0.8 };
const FX_BASE = { battle: [0.9, 3], siege: [0.8, 3], capture: [1, 3], eruption: [1.3, 4], meteor: [1.5, 5], quake: [1, 3], tsunami: [1.2, 4], landfall: [0.6, 2], founding: [0.5, 2], wonder: [0.8, 3], newcivs: [0.9, 3], rebellion: [0.8, 3], awaken: [1.2, 4], dragonfire: [1.3, 4], raid: [0.7, 3] };
const AMBIENT_FX = new Set(['landfall', 'founding', 'raid']);   // effects that colour quiet years rather than make news
// what an effect is about (caption category) and its glyph
const FX_CAT = { battle: 'war', capture: 'war', siege: 'war', raid: 'war', rebellion: 'war', dragonfire: 'myth', awaken: 'myth', newcivs: 'civ', founding: 'civ', wonder: 'culture', landfall: 'nature' };
const FX_ICON = { battle: 'war', capture: 'war', siege: 'war', raid: 'war', rebellion: 'rebellion', eruption: 'volcano', meteor: 'meteor', quake: 'quake', tsunami: 'tsunami', landfall: 'storm', dragonfire: 'dragon', awaken: 'miracle', newcivs: 'people', founding: 'town', wonder: 'wonder' };
const FX_NEAR = 3, FX_NEAR_MS = 2500;   // an effect where a story already told is happening adds nothing
const ACTION = new Set(['war', 'disaster', 'siege', 'eruption', 'storm', 'fire', 'battle', 'meteor', 'quake', 'tsunami', 'capture', 'landfall', 'raid', 'dragonfire']);

export function mount(app) {
  const stage = document.getElementById('stage');
  const settings = { shotSec: 8, pacing: true, captions: true, ...(getPref('story.director', {}) || {}) };
  const saveSettings = () => setPref('story.director', { shotSec: settings.shotSec, pacing: settings.pacing, captions: settings.captions });

  let on = false;
  let suspendedUntil = 0;
  let current = null;          // the shot on screen
  let pool = new Map();        // key → candidate
  const shown = new Map();     // key → when it was last shown
  let recent = [];             // last shots: { x, y, civId }
  let lastSeq = 0, fxSince = 0;
  let quiet = false;
  let base = null;             // the viewer's own pace, which the Director returns to
  let pacedTo = null;          // the speed the Director set last
  let storyAt = 0;             // when the last story (not ambient) shot began
  let pacingHeld = false;      // the viewer chose a speed: no more pacing this session
  let moving = false;          // our own camera move / selection in progress
  let ownSelect = false;
  let offer = null;            // the Director's offer card while it is up or waiting its turn

  // --- the caption -------------------------------------------------------------------------
  const capIcon = h('span.dc-ico');
  const capKick = h('span.dc-kick');
  const capText = h('p.dc-text', { 'aria-live': 'polite' });
  const btnInspect = h('button.btn.btn-sm', { type: 'button', text: 'Inspect' });
  const btnFollow = h('button.btn.btn-sm', { type: 'button', text: 'Follow' });
  const btnSkip = h('button.btn.btn-sm', { type: 'button', text: 'Skip' });
  const btnStop = h('button.icon-btn.dc-stop', { type: 'button', 'aria-label': 'Stop the Director (G)' }, svgEl(glyph('close', 16)));
  const btnSet = h('button.icon-btn.dc-set', { type: 'button', 'aria-label': 'Director settings' }, svgEl(glyph('menu', 16)));
  tip(btnStop, 'Stop the Director and keep the camera.', 'Stop', 'G');
  tip(btnSet, 'Shot length, pacing and captions.', 'Director settings');
  const caption = h('div.story-caption', { hidden: true, role: 'region', 'aria-label': 'The Director' },
    h('div.dc-head', null, capIcon, capKick, h('span.dc-sp'), btnSet, btnStop),
    capText,
    h('div.dc-actions', null, btnInspect, btnFollow, btnSkip));
  const chip = h('button.story-chip', { type: 'button', hidden: true });
  stage.append(caption, chip);
  btnStop.addEventListener('click', () => stop());
  btnSet.addEventListener('click', () => openSettings());
  btnSkip.addEventListener('click', () => skip());
  btnInspect.addEventListener('click', () => { if (current?.sel) { ownSelect = true; app.select(current.sel, { focus: false }); ownSelect = false; app.emit('layout', 'open-panel'); suspend('inspect'); } });
  btnFollow.addEventListener('click', () => { const s = current?.followSel || current?.sel; if (s) { app.setFollow(s); suspend('follow'); } });
  chip.addEventListener('click', () => { if (quiet) return; suspendedUntil = 0; tick(true); });

  let typing = null;   // { text, shown, t0 }
  function typeCaption(text) {
    typing = { text, t0: performance.now() };
    if (reducedMotion()) { setText(capText, text); typing = null; return; }
    setText(capText, '');
    requestAnimationFrame(typeFrame);
  }
  function typeFrame(t) {
    if (!typing) return;
    const n = Math.min(typing.text.length, Math.floor(((t - typing.t0) / 1000) * TYPE_CPS));
    capText.textContent = typing.text.slice(0, n);
    if (n < typing.text.length) requestAnimationFrame(typeFrame); else typing = null;
  }

  function showCaption(c) {
    if (!settings.captions || !c) { caption.hidden = true; return; }
    const cat = categoryOf(c.cat);
    caption.style.setProperty('--c', cat.color);
    clear(capIcon);
    capIcon.appendChild(iconEl(c.icon || 'chronicle', { size: 18, label: cat.label }));
    setText(capKick, [cat.label, c.place, c.when].filter(Boolean).join(' · '));
    typeCaption(c.text);
    btnInspect.hidden = !c.sel;
    btnFollow.hidden = !(c.followSel || c.sel);
    caption.hidden = false;
    caption.classList.remove('is-in'); void caption.offsetWidth; caption.classList.add('is-in');
  }

  // --- candidates ----------------------------------------------------------------------------
  function freshEntries(nowT) {
    const w = app.world;
    if (w.chronicle.seq === lastSeq) return;
    const patron = w.ui?.patron;
    for (const e of chronicleSince(w, lastSeq)) {
      if (e.fold) continue;
      const mine = patron != null && (e.civId === patron || (e.sid != null && w.settlements[e.sid]?.civId === patron));
      if (e.imp < (mine ? 2 : 3)) continue;
      const p = entryPoint(app, e);
      if (!p) continue;
      // a war's letter opens the war (a claim sworn, a ruler taken, a town that held: still the war)
      const sel = (e.cat === 'war' ? warSelOf(app, e) : null) || entrySel(app, e);
      const region = e.ref && (e.ref.k === 'civ' || e.ref.k === 'war' || e.ref.k === 'plague') ? { kind: e.ref.k, id: e.ref.id } : (!e.sid && e.x == null && e.civId != null ? { kind: 'civ', id: e.civId } : null);
      add({
        key: 'e' + e.seq, type: 'entry', cat: e.cat, imp: e.imp + (mine ? 1 : 0), x: p.x, y: p.y, born: nowT,
        base: CAT_BASE[e.cat] ?? 0.8, civId: e.civId ?? (e.sid != null ? w.settlements[e.sid]?.civId : null),
        box: region ? selectionFrame(app, region) : null, zoom: zoomFor(e), sel, seq: e.seq,
        caption: { text: e.text, cat: e.cat, icon: entryIcon(e), place: placeName(e), when: F.monthYear(e.day), sel, followSel: region },
      });
    }
    lastSeq = w.chronicle.seq;
  }

  function zoomFor(e) {
    if (e.cat === 'war') return 13;
    if (e.cat === 'disaster') return 9;
    if (e.cat === 'climate' || e.cat === 'nature') return 7;
    if (e.sid != null) return 12;
    return 9;
  }
  /**
   * The war a war entry belongs to, as a selection: its own reference, else the war its realm (or
   * its town's, or its ruler's) was fighting that day, the one named in the text first. Or null.
   */
  function warSelOf(app, e) {
    const w = app.world;
    if (e.ref && e.ref.k === 'war' && w.wars[e.ref.id]) return { kind: 'war', id: e.ref.id };
    const civs = new Set();
    const add = (id) => { if (id != null && Number.isFinite(Number(id))) civs.add(Number(id)); };
    add(e.civId);
    if (e.sid != null) add(w.settlements[e.sid]?.civId);
    if (e.ref?.k === 'civ') add(e.ref.id);
    if (e.ref?.k === 'settlement') add(w.settlements[e.ref.id]?.civId);
    if (e.ref?.k === 'ruler') add(parseInt(String(e.ref.id), 10));
    const text = (e.text || '').toLowerCase();
    let fought = null;
    for (let k = w.wars.length - 1; k >= 0; k--) {
      const q = w.wars[k];
      if (!q || q.startDay > e.day || (!q.active && q.endDay != null && q.endDay < e.day)) continue;
      if (q.name && text.includes(String(q.name).toLowerCase())) return { kind: 'war', id: q.id };
      if (!fought && [...civs].some((c) => q.attackers.includes(c) || q.defenders.includes(c))) fought = { kind: 'war', id: q.id };
    }
    return fought;
  }

  function placeName(e) {
    const w = app.world;
    if (e.sid != null && w.settlements[e.sid]) return w.settlements[e.sid].name;
    if (e.civId != null && w.civs[e.civId]) return w.civs[e.civId].name;
    return '';
  }

  /** What is going on right now: sieges, eruptions, storms near land, great fires, plague fronts. */
  function liveScan(nowT) {
    const w = app.world;
    const f = w.f;
    for (const s of w.settlements) {
      if (!s || !s.alive || !s.siege) continue;
      const c = w.civs[s.siege.civId];
      const pct = Math.round(Math.max(0, Math.min(1, s.siege.progress || 0)) * 100);
      // sieges are many and long: a routine one weighs less than its fall or a great city's
      add({ key: 'siege' + s.id, type: 'siege', cat: 'war', imp: 3 + (s.tier >= 4 ? 1 : 0), x: s.x, y: s.y, live: true, base: pct > 60 || s.tier >= 4 ? 1 : 0.7, civId: s.civId, zoom: 14,
        sel: { kind: 'settlement', id: s.id },
        caption: { text: `${c ? c.adjective + ' troops' : 'An army'} ${pct > 60 ? 'are breaking into' : 'have ringed'} ${s.name}${pct > 0 ? ` — the walls are ${pct}% breached` : ''}.`, cat: 'war', icon: 'war', place: s.name, when: F.monthYear(w.time.day), sel: { kind: 'settlement', id: s.id } } }, nowT);
    }
    for (const v of w.volcanoes) {
      if (!(v.erupting > 0)) continue;
      add({ key: 'erupt' + v.id, type: 'eruption', cat: 'disaster', imp: 4, x: v.x, y: v.y, live: true, base: 1.4, zoom: 10, sel: { kind: 'volcano', id: v.id },
        caption: { text: `${v.name} is erupting: ash rises over the land around it.`, cat: 'disaster', icon: 'volcano', place: v.name, when: F.monthYear(w.time.day), sel: { kind: 'volcano', id: v.id } } }, nowT);
    }
    for (const s of w.storms) {
      // the great storms only: named cyclones and fierce blizzards, not every passing squall
      if (!s || (s.intensity || 0) < 0.65 || !(s.kind === 'cyclone' || (s.kind === 'blizzard' && s.intensity >= 0.8)) || !s.name) continue;
      const x = Math.round(s.x), y = Math.round(s.y);
      if (x < 0 || y < 0 || x >= w.W || y >= w.H) continue;
      const i = y * w.W + x;
      const near = f.water[i] === 0 || (f.distCoast && f.distCoast[i] <= 3);
      if (!near) continue;
      const name = s.name || F.humanize(s.kind);
      add({ key: 'storm' + s.id, type: 'storm', cat: 'disaster', imp: s.intensity >= 0.85 ? 3 : 2, x: s.x, y: s.y, live: true, ambient: true, base: 0.55 * (0.5 + s.intensity), zoom: 7, follow: { kind: 'storm', id: s.id }, followSel: { kind: 'storm', id: s.id },
        caption: { text: `${cap(name)} ${f.water[i] === 0 ? 'is tearing across the land' : 'is bearing down on the coast'} at ${Math.round(s.intensity * 100)}% of its fury.`, cat: 'disaster', icon: 'storm', place: name, when: F.monthYear(w.time.day), sel: { kind: 'storm', id: s.id }, followSel: { kind: 'storm', id: s.id } } }, nowT);
    }
    for (const fr of w.fires) {
      if (!fr || !fr.active || (fr.tiles || 0) < 40) continue;
      add({ key: 'fire' + fr.id, type: 'fire', cat: 'nature', imp: fr.tiles > 160 ? 3 : 2, x: fr.x, y: fr.y, live: true, ambient: true, base: 0.6, zoom: 9,
        caption: { text: `${cap(fr.name || 'A wildfire')} burns across ${F.area(fr.tiles)}.`, cat: 'nature', icon: 'wildfire', place: fr.name || '', when: F.monthYear(w.time.day) } }, nowT);
    }
    for (const p of w.plagues) {
      if (!p || !p.active) continue;
      const box = selectionFrame(app, { kind: 'plague', id: p.id });
      if (!box) continue;
      let towns = 0;
      for (const s of w.settlements) if (s && s.alive && s.disease && s.disease.pid === p.id) towns++;
      if (towns < 2) continue;
      add({ key: 'plague' + p.id, type: 'plague', cat: 'disease', imp: 3, x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2, live: true, base: 0.75, box, sel: { kind: 'plague', id: p.id },
        caption: { text: `${cap(p.name)} is spreading through ${towns} towns; ${F.people(p.deaths || 0)} have died.`, cat: 'disease', icon: 'plague', place: '', when: F.monthYear(w.time.day), sel: { kind: 'plague', id: p.id }, followSel: { kind: 'plague', id: p.id } } }, nowT);
    }
  }

  function fxScan(nowT) {
    const r = app.renderer;
    if (!r || typeof r.recentFx !== 'function') return;
    let list = [];
    try { list = r.recentFx(fxSince) || []; } catch (e) { list = []; }
    fxSince = nowT;
    const w = app.world;
    for (const fx of list) {
      const b = FX_BASE[fx.type];
      if (!b || !Number.isFinite(fx.x) || !Number.isFinite(fx.y)) continue;
      // the chronicle or a director source already tells what happens here (a named dragon's raid, a siege by name)
      if (toldNear(fx.x, fx.y, fx.t ?? nowT)) continue;
      const near = nearestTown(fx.x, fx.y);
      const cat = FX_CAT[fx.type] || 'disaster';
      const beast = fx.type === 'dragonfire' ? nearestBand(fx.x, fx.y, 'dragon') : null;
      // something to inspect: the dragon, else the town it happened at
      const sel = beast ? { kind: 'band', id: beast.id } : near && (near.x - fx.x) ** 2 + (near.y - fx.y) ** 2 <= 36 ? { kind: 'settlement', id: near.id } : null;
      add({ key: `fx${fx.type}${Math.round(fx.x)}:${Math.round(fx.y)}`, type: fx.type, ambient: AMBIENT_FX.has(fx.type), cat, imp: b[1], x: fx.x, y: fx.y, born: fx.t ?? nowT,
        base: b[0], civId: fx.civId ?? null, zoom: Math.max(6, Math.min(14, 12 - Math.log2(Math.max(1, fx.r || 1)))), sel,
        caption: { text: fxText(fx.type, near, beast), cat, icon: FX_ICON[fx.type] || 'chronicle', place: near?.name || '', when: F.monthYear(w.time.day), sel, followSel: beast ? sel : null } });
    }
  }
  /** Is a story candidate (a chronicle entry, a live scan, a director source) already about this place and moment? */
  function toldNear(x, y, t) {
    for (const c of pool.values()) {
      if (c.key.startsWith('fx')) continue;
      if (Math.abs(c.x - x) <= FX_NEAR && Math.abs(c.y - y) <= FX_NEAR && Math.abs((c.live ? c.seen : c.born) - t) <= FX_NEAR_MS) return true;
    }
    return false;
  }
  /** The band behind an effect: the raid the bands' log records at that place lately, else the nearest of that kind. */
  function nearestBand(x, y, kind) {
    const w = app.world;
    const log = w.sys?.bands?.log || [];
    for (let k = log.length - 1; k >= 0; k--) {
      const [d, id, , , x1, y1] = log[k];
      if (w.time.day - d > 120) break;
      if (Math.abs(x1 - x) <= 2 && Math.abs(y1 - y) <= 2) { const b = w.bands.find((q) => q.id === id); if (b && b.kind === kind) return b; }
    }
    let best = null, bd = 20 * 20;
    for (const b of w.bands || []) { if (!b || b.kind !== kind) continue; const d = (b.x - x) ** 2 + (b.y - y) ** 2; if (d < bd) { bd = d; best = b; } }
    return best;
  }
  function fxText(type, near, beast) {
    const at = near ? ` near ${near.name}` : '';
    switch (type) {
      case 'dragonfire': return `${beast?.name ? cap(beast.name + (beast.epithet ? ' ' + beast.epithet : '')) : 'A dragon'} rains fire on ${near ? near.name : 'the land below'}.`;
      case 'raid': return near ? `Raiders strike ${near.name}.` : 'Raiders strike the countryside.';
      case 'awaken': return `Magic wakes in the land${at}.`;
      case 'battle': return `Armies clash${at}.`;
      case 'capture': return near ? `${near.name} has fallen to its besiegers.` : 'A city has fallen.';
      case 'siege': return `A siege tightens${at}.`;
      case 'eruption': return `A mountain wakes in fire${at}.`;
      case 'meteor': return `A star falls from the sky${at}.`;
      case 'quake': return `The ground heaves${at}.`;
      case 'tsunami': return `A great wave rolls toward the shore${at}.`;
      case 'landfall': return `A storm comes ashore${at}.`;
      case 'newcivs': return `A new people takes shape${at}.`;
      case 'rebellion': return `Rebellion flares${at}.`;
      case 'wonder': return `A wonder of the world is finished${at}.`;
      default: return `Something stirs${at}.`;
    }
  }
  function nearestTown(x, y) {
    const w = app.world;
    let best = null, bd = 36 * 36;
    for (const s of w.settlements) { if (!s || !s.alive) continue; const d = (s.x - x) ** 2 + (s.y - y) ** 2; if (d < bd) { bd = d; best = s; } }
    return best;
  }

  function sourcesScan(nowT) {
    for (const fn of getDirectorSources()) {
      let list = null;
      try { list = fn(app, nowT); } catch (e) { app.reportError('director.source', e); }
      if (!Array.isArray(list)) continue;
      list.forEach((c, k) => {
        if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return;
        const cp = c.caption;
        add({ key: c.key || `src:${c.type}:${Math.round(c.x)}:${Math.round(c.y)}:${k}`, type: c.type || 'source', cat: cp?.cat || 'myth', imp: c.imp ?? 3, x: c.x, y: c.y, born: nowT, live: true,
          base: Number(c.score) > 0 ? Number(c.score) : 1, box: c.box || null, zoom: c.zoom, sel: c.ref ? { kind: c.ref.k, id: c.ref.id } : null,
          caption: { text: typeof cp === 'string' ? cp : cp?.text || '', cat: cp?.cat || 'myth', icon: cp?.icon || c.type || 'miracle', place: cp?.place || '', when: F.monthYear(app.world.time.day), sel: c.ref ? { kind: c.ref.k, id: c.ref.id } : null } });
      });
    }
  }

  function add(c, nowT) {
    const prev = pool.get(c.key);
    if (prev && c.live) { c.born = prev.born; }
    else if (!c.born) c.born = nowT ?? performance.now();
    c.seen = nowT ?? performance.now();
    pool.set(c.key, c);
  }

  function score(c, nowT) {
    const imp = Math.max(1, Math.min(6, c.imp || 3));
    let s = (c.base ?? 1) * (1 + (imp * imp) / 5);
    if (!c.live) s *= Math.exp(-Math.max(0, nowT - c.born) / FRESH_MS);
    for (const r of recent) {
      if ((r.x - c.x) ** 2 + (r.y - c.y) ** 2 < 400) { s *= 0.3; break; }
    }
    if (c.civId != null && recent.slice(-2).some((r) => r.civId === c.civId)) s *= 0.3;
    if (recent.length >= 2 && recent.slice(-2).every((r) => r.type === c.type)) s *= 0.5;   // not the same kind of shot three times running
    else if (recent.length && recent[recent.length - 1].type === c.type) s *= 0.75;        // nor, readily, twice
    const t = shown.get(c.key);
    if (t != null && nowT - t < COOLDOWN_MS) s *= 0.15;
    if (current && c.key === current.key) s = current.score0 * Math.exp(-(nowT - current.start) / (FRESH_MS * 2.5));
    return s;
  }

  // --- the loop --------------------------------------------------------------------------------
  function tick(force = false) {
    const w = app.world;
    if (!on || !w || app.fastForwarding || app.chrono?.busy) return;
    const nowT = performance.now();
    freshEntries(nowT);
    liveScan(nowT);
    sourcesScan(nowT);
    fxScan(nowT);
    // forget what has faded or ended
    for (const [k, c] of pool) {
      if (c.live && nowT - c.seen > 600) pool.delete(k);
      else if (!c.live && nowT - c.born > FRESH_MS * 4) pool.delete(k);
    }
    if (nowT < suspendedUntil || app.follow) { if (app.follow && current) { current = null; caption.hidden = true; } syncChip(nowT); return; }
    let best = null, bs = 0;
    for (const c of pool.values()) {
      if (current && c.key === current.key) continue;
      const s = score(c, nowT);
      if (s > bs) { bs = s; best = c; }
    }
    const curScore = current ? score(current, nowT) : 0;
    const held = current ? nowT - current.start : Infinity;
    const due = current ? held >= current.dwell : true;
    if (best && bs >= QUIET_SCORE && (force || due || (bs > curScore * SWITCH_RATIO && (held >= MIN_DWELL || (best.imp >= 5 && held >= EPOCH_CUT))))) {
      cut(best, bs, nowT);
    } else if (current && due) {
      current = null;
      caption.hidden = true;
    }
    if (current?.follow) track(current);
    pace(nowT);
    syncChip(nowT);
  }

  function cut(c, s, nowT) {
    const imp = c.imp || 3;
    current = { ...c, score0: s, start: nowT, dwell: Math.round(settings.shotSec * 1000 * (imp >= 5 ? 1.8 : imp >= 4 ? 1.3 : 1)) };
    shown.set(c.key, nowT);
    recent.push({ x: c.x, y: c.y, civId: c.civId ?? null, type: c.type });
    if (!c.ambient) storyAt = nowT;
    if (recent.length > 3) recent.shift();
    if (!c.ambient) quiet = false;
    frame(c);
    showCaption(c.caption);
    app.emit('directorShot', { key: c.key, type: c.type, x: c.x, y: c.y });
  }

  function frame(c) {
    moving = true;
    try {
      if (c.box) app.frameBox(c.box, 64);
      else app.focus(c.x, c.y, Number.isFinite(c.zoom) ? c.zoom : 10);
    } finally { moving = false; }
  }
  /** Keep a moving subject (a storm) in the middle third of the view. */
  function track(c) {
    const p = c.follow ? selectionPoint(app, c.follow) : null;
    const r = app.renderer;
    if (!p || !r?.camera) return;
    const sp = app.r('tileToScreen', p.x + 0.5, p.y + 0.5);
    if (!sp) return;
    const off = Math.abs(sp.sx - r.viewW / 2) > r.viewW / 6 || Math.abs(sp.sy - r.viewH / 2 - ((typeof app.viewBias === 'function' && app.viewBias()) || 0)) > r.viewH / 6;
    if (off) { moving = true; app.focus(p.x, p.y, r.camera.zoom); moving = false; }
  }

  /**
   * Pace time around the story: quiet stretches (no story shot for a few seconds; storms and
   * fires do not count) run at Rapid with a chip; a story shot brings back the viewer's own
   * pace, and an action shot holds it at Fast at most. Never while paused, and never again
   * once the viewer picks a speed themselves.
   */
  function pace(nowT) {
    if (!settings.pacing || pacingHeld || app.speed === 0) return;
    if (base == null) base = app.speed;
    const story = current && !current.ambient;
    if (story) {
      const action = ACTION.has(current.type) || ACTION.has(current.cat) || (current.imp || 0) >= 4;
      const want = action ? Math.min(base, FAST) : base;
      if (app.speed !== want) setPace(want);
      return;
    }
    if (nowT - storyAt > QUIET_AFTER) {
      quiet = true;
      const want = Math.max(base, RAPID);
      if (app.speed !== want) setPace(want);
    }
  }
  function setPace(k) {
    pacedTo = k;
    app.setSpeed(k);
  }

  function syncChip(nowT) {
    if (!on) { chip.hidden = true; return; }
    if (app.follow) {
      chip.hidden = false;
      chip.className = 'story-chip is-wait';
      setText(chip, `Following ${describeSel(app, app.follow).name} · the Director waits`);
      return;
    }
    if (nowT < suspendedUntil) {
      chip.hidden = false;
      chip.className = 'story-chip is-wait';
      setText(chip, `Director resumes in ${Math.ceil((suspendedUntil - nowT) / 1000)} s · tap to resume now`);
      return;
    }
    if (quiet && (!current || current.ambient)) {
      chip.hidden = false;
      chip.className = 'story-chip is-quiet';
      setText(chip, `Quiet years · Year ${F.int(yearOf(app.world))} →`);
      return;
    }
    chip.hidden = true;
  }

  // --- control ----------------------------------------------------------------------------------
  function start({ quietly = false } = {}) {
    if (on || !app.world) return;
    on = true;
    offer?.close(); offer = null;     // the question is answered
    base = app.speed > 0 ? app.speed : null; pacedTo = null; pacingHeld = false;
    suspendedUntil = 0;
    storyAt = performance.now();
    lastSeq = Math.max(0, app.world.chronicle.seq - 40);   // the last few great events are fair game
    fxSince = performance.now() - 6000;
    pool.clear(); recent = []; current = null;
    document.getElementById('app')?.classList.add('is-directing');
    app.emit('director', true);
    if (!quietly) app.emit('directorStart');
    tick(true);
  }
  function stop() {
    if (!on) return;
    on = false;
    current = null;
    caption.hidden = true;
    chip.hidden = true;
    typing = null;
    quiet = false;
    if (base != null && pacedTo != null && app.speed === pacedTo && pacedTo !== base) app.setSpeed(base);
    base = null; pacedTo = null;
    document.getElementById('app')?.classList.remove('is-directing');
    app.emit('director', false);
  }
  function toggle() { if (on) stop(); else start(); }
  function skip() {
    if (!current) return;
    shown.set(current.key, performance.now());
    current = null;
    suspendedUntil = 0;
    tick(true);
  }
  function suspend(why) {
    if (!on) return;
    suspendedUntil = performance.now() + SUSPEND_MS;
    current = null;
    caption.hidden = true;
    if (base != null && pacedTo != null && app.speed === pacedTo && pacedTo !== base) { app.setSpeed(base); pacedTo = null; }
    quiet = false;
    storyAt = performance.now() + SUSPEND_MS;
    syncChip(performance.now());
  }

  app.director = { get on() { return on; }, start, stop, toggle, skip, suspend, settings };

  // the viewer takes the camera: wait
  app.on('userCamera', () => { if (on && !moving) suspend('camera'); });
  app.on('select', () => { if (on && !moving && !ownSelect && app.selection) suspend('select'); });
  let beforePause = null;
  app.on('speed', (k) => {
    if (!on || pacedTo === k) return;
    // pausing to read, and resuming, is not a choice of pace
    if (k === 0) { beforePause = app.lastSpeed; return; }
    if (beforePause != null && k === beforePause) { beforePause = null; return; }
    beforePause = null;
    // a speed the viewer picked: keep it, and stop pacing for this session
    pacingHeld = true;
    base = k; pacedTo = null; quiet = false;
  });
  app.on('tick', () => tick());
  app.on('world', () => { if (app.restoring) return; if (on) stop(); maybeOffer(); });
  app.on('worldRestored', () => { if (on) { lastSeq = app.world.chronicle.seq; pool.clear(); current = null; } });
  app.on('historySkipped', () => { if (on && app.world) { lastSeq = app.world.chronicle.seq - 20; current = null; } });

  // the caption replaces the major notices it may show, except news of what you watch
  registerToastFilter((a, e) => {
    if (!on || e.imp !== 3 || e.fold) return null;
    if (a.watchConcerns?.(e)) return null;
    return entryPoint(a, e) ? { suppress: true } : null;
  });

  // --- the offer --------------------------------------------------------------------------------
  // asked once per device (phones too): a viewer who said no is not asked again with every world
  const url = urlOptions();
  let offered = false;
  function maybeOffer() {
    offer?.close(); offer = null;
    if (offered) return;
    const auto = url.autostart === '1' || url.autostart === 'true';
    if (url.director === '1' || url.director === 'true') { offered = true; setTimeout(() => start(), 600); return; }
    if (url.director === '0') return;
    const first = !getPref('story.directorAsked', false);
    if (!(first || url.director === 'offer') || (auto && url.director !== 'offer')) return;
    offered = true;
    setTimeout(() => {
      if (!app.world || on) return;
      setPref('story.directorAsked', true);
      offer = offerToast(app, {
        icon: 'eye', kicker: 'The Director', title: 'Watch the story unfold?',
        text: 'The Director flies to great events as they happen and tells them as it goes. Move the map and it waits; press G to start or stop it.',
        ms: 20000,
        actions: [{ label: 'Begin the story', primary: true, run: () => start() }, { label: 'Not now', run: () => {} }],
      });
    }, 2500);
  }

  // --- settings ---------------------------------------------------------------------------------
  function openSettings() {
    const len = h('input', { id: 'dir-len', type: 'range', min: 5, max: 15, step: 1, value: settings.shotSec });
    const out = h('output', { for: 'dir-len', text: `${settings.shotSec} s` });
    len.addEventListener('input', () => { settings.shotSec = Number(len.value); out.textContent = `${settings.shotSec} s`; saveSettings(); });
    const sw = (key, label) => {
      const id = 'dir-' + key;
      const box = h('input', { id, type: 'checkbox' });
      box.checked = Boolean(settings[key]);
      box.addEventListener('change', () => { settings[key] = box.checked; saveSettings(); if (key === 'pacing' && box.checked) pacingHeld = false; if (key === 'captions' && !box.checked) caption.hidden = true; });
      return h('label.menu-item.switch', { for: id }, box, h('span.track'), h('span', { text: label }));
    };
    openModal({
      title: 'The Director', small: true,
      body: h('div.dir-settings', null,
        h('div.mini-slider', null, h('label', { for: 'dir-len', text: 'Shot length' }), len, out),
        sw('pacing', 'Pace time: slow for action, hurry through quiet years'),
        sw('captions', 'Show captions')),
      actions: [{ label: 'Done', cls: 'btn-brass', onClick: (m) => m.close() }],
    });
  }

  registerKey({ key: 'g', label: 'The Director: story mode on or off', group: 'Story', when: (a) => Boolean(a.world), run: () => toggle() });
  registerCommand({ id: 'director.toggle', label: 'The Director (story mode)', group: 'Story', icon: 'eye', keys: 'G', keywords: ['story', 'cinema', 'camera', 'auto', 'watch', 'narrate'], menu: 'Story', when: (a) => Boolean(a.world), run: () => toggle() });
  registerCommand({ id: 'director.settings', label: 'Director settings…', group: 'Story', icon: 'eye', keywords: ['pacing', 'captions', 'shot'], when: () => true, run: () => openSettings() });
}

const cap = (t) => (t ? String(t)[0].toUpperCase() + String(t).slice(1) : '');
