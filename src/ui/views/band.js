// Band view — the Inspector record for roaming powers: outlaw bands, pirate fleets, free
// companies, hordes, beasts, dragons and the restless dead (living, or remembered from the
// archive once gone). Also registers: the band glyphs (icons for records, chronicle lines and
// tools), a search source over living and archived bands, map context items (inspect, follow,
// and in Mythic worlds send a hero, tame, summon), a Director source (dragon raids, horde
// marches, pirate sackings) and a command that tours the roaming powers.
//
// Owner: WP2 (roaming powers). Reads the world only; every act goes through the logged kernel
// tool calls (core/tools.js applyEntityTool). Styles in src/ui/css/bands.css (tokens only).

import { registerView, registerSearchSource, registerContextProvider, registerDirectorSource, registerIcon, registerCommand, sectionsFor } from '../registry.js';
import * as kernelTools from '../../core/tools.js';
import { BAND_KINDS, DAYS_PER_YEAR, MONTH_NAMES, DAYS_PER_MONTH, MONTHS_PER_YEAR } from '../../core/constants.js';
import { mythLevel } from '../../core/params.js';

let bands = null;
try { bands = await import('../../sim/bands/index.js'); } catch (e) { /* the record shows raw fields */ }
let ledger = null;
try { ledger = await import('../../sim/ledger.js'); } catch (e) { /* the band's own yearly samples */ }
let charts = null;
try { charts = await import('../charts.js'); } catch (e) { /* a plain canvas sparkline */ }

// ---------------------------------------------------------------------------
// Glyphs (24-unit grid, currentColor, engraved 1.6 line like icons.js)

const DOT = (x, y, r = 0.9) => `<circle cx="${x}" cy="${y}" r="${r}" fill="currentColor" stroke="none"/>`;
const ICONS = {
  band: `<path d="M4.5 4.5l10 10M19.5 4.5l-10 10"/><path d="M14.5 14.5l2.8 2.8-1.8 1.8-2.8-2.8M9.5 14.5l-2.8 2.8 1.8 1.8 2.8-2.8"/><path d="M3.5 20.5l2.4-2.4M20.5 20.5l-2.4-2.4"/>`,
  outlaw: `<path d="M5 20.5l8-4.5M13 20.5l-8-4.5"/><path d="M9 16c-2.1 0-3.3-1.5-3.3-3.2 0-1.8 1.3-2.6 1.7-4.5 1 .7 1.5 1.6 1.5 2.6.5-.4.9-1.2.8-2.2 1.5 1 2.5 2.5 2.5 4.1 0 1.7-1.1 3.2-3.2 3.2z"/><path d="M17.5 20.5V3.5l4 1.6-4 1.6"/>`,
  pirate: `<path d="M3 16.5h18l-2.6 4H5.6z"/><path d="M12 16.5V3"/><path d="M6.5 5.2c3.6 1 7.4 1 11 0l-.7 8.3c-3.2.8-6.4.8-9.6 0z"/>${DOT(12, 9.4, 1.4)}`,
  company: `<path d="M6 21V2.8"/><path d="M6 4h12.5v9.5H6"/><path d="M6 8.8h12.5M12.2 4v9.5" stroke-width="1.1"/>${DOT(6, 2.6, 1)}`,
  horde: `<path d="M12 21V5.5"/><path d="M9.4 3.4a2.6 2.6 0 0 0 5.2 0"/><path d="M8 7.5h8"/><path d="M9 7.5c-.6 3 .1 5.6 1 7.6M12 7.5c0 3.6.4 6.2 1 8.6M15 7.5c.6 3-.1 5.6-1 7.6"/>`,
  dragon: `<path d="M2.5 15.5c3.2-1 5.6-3.6 7.2-7.4 1 2.3 3 3.6 5.6 3.8"/><path d="M15.3 11.9c1.5-2.1 3.4-3.1 5.7-3.1l-1.5 2.1 1.5 1.5c-1.9.3-3.5 1.2-4.7 2.6"/><path d="M9.7 8.1c-3 .5-5.4-.6-7.2-3.1.5 3.3 2.3 5.4 5.1 6.5"/><path d="M4.5 20.5c2.1-2.6 5.1-3.7 8.2-3.3 2.4.3 4.5-.6 6.1-2.5"/>${DOT(18.6, 10.6, 0.7)}`,
  beast: `<path d="M5.5 3.5c1.6 5.2 1.6 11.6 0 17M11 2.8c1.7 6.2 1.7 12.2 0 18.4M16.5 3.5c1.6 5.2 1.6 11.6 0 17"/><path d="M19.5 7.5l2 1M19.5 16.5l2-1" stroke-width="1.1"/>`,
  undead: `<path d="M12 3C7.6 3 5 6 5 9.6c0 2.4 1.2 3.8 2.6 4.6V18h8.8v-3.8c1.4-.8 2.6-2.2 2.6-4.6C19 6 16.4 3 12 3z"/><circle cx="9.3" cy="10.4" r="1.4"/><circle cx="14.7" cy="10.4" r="1.4"/><path d="M10 18v3M14 18v3M12 18v3" stroke-width="1.1"/>`,
  lair: `<path d="M2.5 20.5c1.5-6.2 5-11.3 9.5-11.3s8 5.1 9.5 11.3z"/><path d="M8.4 20.5c.3-3.2 1.7-5.7 3.6-5.7s3.3 2.5 3.6 5.7"/>${DOT(12, 18.6, 0.8)}`,
  hunt: `<path d="M4.5 20L17 7.5M19.5 20L7 7.5"/><path d="M17 7.5l1.8-4 .7 3.3zM7 7.5L5.2 3.5l-.7 3.3z"/>`,
  summon: `<circle cx="12" cy="12" r="8.6" stroke-dasharray="2.6 2.1"/><path d="M12 5.6v12.8M6.5 8.8l11 6.4M17.5 8.8l-11 6.4" stroke-width="1.1"/><circle cx="12" cy="12" r="2.2"/>`,
  slay: `<path d="M12 2.5v13.5"/><path d="M8.3 16h7.4"/><path d="M12 16v5"/><path d="M5 8.5l2.4 1.4M19 8.5l-2.4 1.4M4.6 13.5h2.2M19.4 13.5h-2.2" stroke-width="1.1"/>`,
  tame: `<rect x="2.8" y="9" width="10" height="6" rx="3"/><rect x="11.2" y="9" width="10" height="6" rx="3"/>`,
};

const ICON_OF = {
  bandits: 'outlaw', pirates: 'pirate', company: 'company', horde: 'horde', migration: 'horde',
  dragon: 'dragon', wyvern: 'beast', troll: 'beast', giant: 'beast', treant: 'beast', kraken: 'beast', behemoth: 'beast', undead: 'undead',
};
const iconOf = (kind) => ICON_OF[kind] || 'band';

// ---------------------------------------------------------------------------
// Small DOM kit (text only through textContent)

function h(tag, props, ...kids) {
  const [name, ...cls] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (cls.length) el.className = cls.join(' ');
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'text') el.textContent = String(v);
    else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style') for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const setText = (el, t) => { const s = t == null ? '' : String(t); if (el.textContent !== s) el.textContent = s; };
const svgIcon = (key, size = 16) => {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="glyph" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[key] || ICONS.band}</svg>`;
  return t.content.firstElementChild;
};

// ---------------------------------------------------------------------------
// Words

const fmtInt = (n) => String(Math.max(0, Math.round(n || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const year = (day) => `Year ${Math.floor((day || 0) / DAYS_PER_YEAR)}`;
const years = (days) => { const y = Math.max(0, Math.round((days || 0) / DAYS_PER_YEAR)); return y === 1 ? 'a year' : y < 1 ? 'less than a year' : `${y} years`; };
const civLabel = (w, id) => { const c = id != null && id >= 0 ? w.civs[id] : null; return c ? c.name : null; };
const cap1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const FATE = {
  slain: 'slain', hunted: 'hunted down', destroyed: 'destroyed', dispersed: 'dispersed', dwindled: 'dwindled away', settled: 'settled as a realm',
  age: 'dead of great age', retreated: 'driven from the wild', faded: 'faded into dust', gone: 'gone',
};
const STATE_WORD = {
  lair: 'At rest', sleep: 'Asleep', roam: 'On the move', raid: 'Raiding', return: 'Returning home', hired: 'Under contract',
  tamed: 'Tamed', settling: 'Marching to take a town', gone: 'Gone',
};
const VARIETY = { fire: 'Fire drake', frost: 'Frost wyrm', green: 'Green wyrm', sea: 'Sea wyrm' };

function bandOf(world, id) {
  const live = world.bands.find((b) => b.id === id);
  if (live) return { live: true, b: live };
  const a = world.sys?.bands?.archive;
  if (a) for (let k = a.length - 1; k >= 0; k--) if (a[k].id === id) return { live: false, b: a[k] };
  return null;
}
function titleOf(b) {
  if (!b.name) return 'A roaming band';
  if (!b.epithet) return b.name;
  return /^the\s|\sthe\s/i.test(b.name) && !/^the\s/i.test(b.epithet) ? `${b.name}, called ${b.epithet}` : `${b.name} ${b.epithet}`;
}
const kindLabel = (b) => BAND_KINDS[b.kind]?.label || b.kind;
const isBeast = (b) => b.family === 'beast' || b.family === 'spirit';
const armyOf = (w, id) => (id != null && id >= 0 ? w.armies.find((a) => a.id === id) || null : null);
const siteOf = (w, id) => (id != null ? w.sites.find((s) => s.id === id) || null : null);

/** One sentence about where the band stands now. */
function lead(w, b, live) {
  if (!live) {
    const fate = FATE[b.cause] || b.cause || 'gone';
    const slayer = b.slayer && b.slayer.name ? ` by ${b.slayer.name}${civLabel(w, b.slayer.civId) ? ' of ' + civLabel(w, b.slayer.civId) : ''}` : '';
    return `${cap1(titleOf(b))} is ${fate === 'gone' ? 'gone' : 'no more'}: ${fate}${slayer} in ${year(b.died)}, after ${years((b.died || 0) - (b.born || 0))} abroad.`;
  }
  const W = w.W;
  const target = b.targetSid >= 0 ? w.settlements[b.targetSid] : null;
  const L = b.leader ? b.leader.name : null;
  switch (b.state) {
    case 'sleep': {
      const lair = siteOf(w, b.data?.lair);
      const since = b.data?.slept || b.createdDay;
      // a sleeping Scourge (bands/kinds/undead.js) keeps no hoard
      if (b.kind === 'undead') return `Dormant in ${lair?.name || 'its barrow'} these ${years(w.time.day - since)}, weakening slowly, until fresh foes wake it.`;
      return `Asleep in ${lair?.name || 'its lair'} these ${years(w.time.day - since)}, coiled about a hoard of ${fmtInt(b.loot)} crowns.`;
    }
    case 'hired': {
      const c = civLabel(w, b.civId);
      return `${fmtInt(b.strength)} swords in the pay of ${c || 'a prince'}${b.data?.arrears ? `, ${b.data.arrears} month${b.data.arrears === 1 ? '' : 's'} unpaid` : ''}.`;
    }
    case 'tamed': return `Bound to ${civLabel(w, b.civId) || 'its masters'}${armyOf(w, b.data?.armyId) ? ', marching beside their strongest army' : ', resting by their capital'}.`;
    case 'raid': {
      const T = target ? target.name : null;
      if (b.data?.ambush >= 0) return `${cap1(titleOf(b))} ${isBeast(b) ? 'waits' : 'wait'} in ambush on a ${b.kind === 'pirates' ? 'sea lane' : 'road'}.`;
      if (isBeast(b)) return `${cap1(titleOf(b))} is on the wing${T ? ', bound for ' + T : ''}.`.replace('on the wing', b.kind === 'dragon' || b.kind === 'wyvern' ? 'on the wing' : 'abroad');
      return L ? `${L} leads ${titleOf(b)} against ${T || 'the settled country'}.` : `${cap1(titleOf(b))} march on ${T || 'the settled country'}.`;
    }
    case 'settling': return `Marching on ${target ? target.name : 'a town'} to take it and keep it.`;
    case 'roam': return b.kind === 'horde' ? `Riding on ${target ? target.name : 'the settled lands'}, ${fmtInt(b.strength)} strong.` : b.kind === 'company' ? 'On the march, looking for a war that pays.' : 'Abroad in the wild, ranging over its country.';
    case 'return': return `Heading home${b.homeI >= 0 ? ` to ${b.kind === 'dragon' ? siteOf(w, b.data?.lair)?.name || 'its lair' : 'its haunts'}` : ''}.`;
    default: {
      if (b.kind === 'pirates' && b.data?.wait > 0) return 'Lying in wait on a sea lane for a merchantman.';
      const near = b.homeI >= 0 ? w.settlements.find((s) => s && s.alive && Math.abs(s.x - b.homeI % W) + Math.abs(s.y - ((b.homeI / W) | 0)) < 12) : null;
      const where = near ? ` near ${near.name}` : '';
      switch (b.kind) {
        case 'dragon': return `Awake in ${siteOf(w, b.data?.lair)?.name || 'its lair'}, brooding over ${fmtInt(b.loot)} crowns; it will hunt again.`;
        case 'company': return `${fmtInt(b.strength)} veterans camped${where}, waiting for a paymaster.`;
        case 'pirates': return `${fmtInt(b.strength)} pirates in their cove${where}.`;
        case 'horde': return `${fmtInt(b.strength)} riders encamped${where}.`;
        case 'undead': return `The dead stand silent${where}, waiting.`;
        case 'treant': return b.data?.awake > 0 ? `Awake and angry${where}.` : `Sleeping among the old trees${where}.`;
        default: return isBeast(b) ? `Resting in its haunt${where}.` : `${fmtInt(b.strength)} outlaws in their camp${where}.`;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The record

function deedsOf(w, id) {
  const out = [];
  const es = w.chronicle.entries;
  for (let k = es.length - 1; k >= 0 && out.length < 14; k--) { const e = es[k]; if (e.ref && e.ref.k === 'band' && e.ref.id === id) out.push(e); }
  return out;
}

function drawSpark(canvas, values) {
  if (charts && typeof charts.drawSparkline === 'function') {
    try { charts.drawSparkline(canvas, values, getComputedStyle(canvas).color || '#c9a466', { height: 46 }); return; } catch (e) { /* plain fallback */ }
  }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const wcss = canvas.clientWidth || 300, hcss = 46;
  canvas.width = Math.round(wcss * dpr); canvas.height = Math.round(hcss * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, wcss, hcss);
  if (values.length < 2) return;
  const max = Math.max(1, ...values);
  g.strokeStyle = getComputedStyle(canvas).color || '#c9a466'; g.lineWidth = 1.5;
  g.beginPath();
  values.forEach((v, k) => { const x = (k / (values.length - 1)) * (wcss - 2) + 1, y = hcss - 3 - (v / max) * (hcss - 8); if (k) g.lineTo(x, y); else g.moveTo(x, y); });
  g.stroke();
}

/** The band's ledger (WP6 series 'b') as MiniChart data, or null without one. */
function ledgerOf(w, b) {
  if (!ledger || typeof ledger.series !== 'function') return null;
  let s = null;
  try { s = ledger.series(w, 'b', b.id); } catch (e) { return null; }
  if (!s || !Array.isArray(s.v) || s.v.length < 2) return null;
  const col = (name) => s.ch.indexOf(name);
  const keys = ['strength', 'hp', 'morale', 'loot'].map(col);
  return {
    days: s.v.map((_, k) => s.t0 + k * s.st),
    rows: s.v.map((row) => keys.map((j) => (j >= 0 && Number.isFinite(row[j]) ? row[j] : 0))),
    live: s.end == null,
  };
}

/** The band's own yearly samples (archived bands and worlds without a ledger). */
function historyOf(w, b, live) {
  const hs = live ? b.data?.h : b.h;
  return Array.isArray(hs) ? hs.map((p) => p[1] || 0) : [];
}

function cell(k) {
  const v = h('span.v'), s = h('span.s');
  return { el: h('div.cell', null, h('span.k', { text: k }), v, s), v, s };
}
/**
 * A divine act on a band, from the record or the context menu: one undoable act for the
 * Chronoscope (snapped just before it, never merged with another), and nothing at all while
 * history is being re-written (the act would land on the world being replaced).
 */
function bandAct(app, tid, b) {
  const w = app.world;
  if (!w || typeof kernelTools.applyEntityTool !== 'function' || app.chrono?.busy || app.fastForwarding) return null;
  const t = kernelTools.getTool?.(tid);
  app.chrono?.beginAct?.({ kind: 'entity', id: tid, label: t?.label || tid, icon: t?.icon || tid, x: b.x ?? null, y: b.y ?? null });
  let r = null;
  try { r = kernelTools.applyEntityTool(w, tid, { kind: 'band', id: b.id }, {}); }
  catch (e) { app.reportError?.(`band.${tid}`, e); }
  finally { app.chrono?.endAct?.(); }
  app.emit?.('worldEdited');
  return r;
}

function section(title, ...kids) { return h('section.ins-section', null, h('h4.rule-head', { text: title }), ...kids); }
function linkBtn(label, fn) { return h('button.link', { type: 'button', onclick: fn }, label); }

function mountRecord(app, sel, el) {
  const w = app.world;
  const id = sel.id;
  const root = h('div.band-view');
  el.append(root);
  const leadP = h('p.ins-lead');
  const chips = h('div.band-chips');
  const c1 = cell('Strength'), c2 = cell('Morale'), c3 = cell('Loot');
  const meter = h('div.meter.band-meter');
  const kv = h('dl.kv');
  const acts = h('div.band-acts');
  const actNote = h('p.band-note', { role: 'status', 'aria-live': 'polite' });
  const deeds = h('div.band-deeds');
  const spark = h('canvas.band-spark', { 'aria-label': 'Strength over the years', role: 'img' });
  // WP6's life chart when the ledger and its chart are present; the plain sparkline otherwise
  const rec0 = bandOf(app.world, id);
  const beast0 = rec0 ? isBeast(rec0.b) : false;
  const pctFmt = (v) => `${Math.round((v || 0) * 100)}%`;
  const mini = charts && typeof charts.MiniChart === 'function' ? new charts.MiniChart({
    channels: [
      { key: 'strength', label: beast0 ? 'Power' : 'Strength', fmt: fmtInt },
      { key: 'hp', label: 'Vigour', fmt: pctFmt },
      { key: 'morale', label: 'Morale', fmt: pctFmt },
      { key: 'loot', label: rec0?.b.kind === 'dragon' ? 'Hoard' : 'Loot', fmt: fmtInt },
    ],
    height: 72, prefKey: 'bands',
    onPick: (day) => app.emit?.('timeTravel', Math.floor(day / DAYS_PER_YEAR)),
  }) : null;
  const chartBox = h('div.band-chart', null, mini ? mini.el : null, spark);
  const lore = h('p.band-lore');
  root.append(leadP, chips, h('div.kv-3', null, c1.el, c2.el, c3.el), meter,
    section('The record', kv), acts, actNote,
    section('Over the years', chartBox), section('Deeds', deeds), section('Lore', lore));

  let lastSeq = -1, lastKv = '', lastActs = '', lastSpark = '';
  const rows = new Map();
  function row(key, label, value, onClick) {
    let r = rows.get(key);
    if (!r) {
      const dt = h('dt', { text: label }), dd = h('dd.txt');
      r = { dt, dd, v: null };
      rows.set(key, r);
    }
    const sig = String(value) + (onClick ? '*' : '');
    if (r.v !== sig) {
      r.v = sig;
      r.dd.textContent = '';
      if (value == null || value === '') r.dd.append('—');
      else if (onClick) r.dd.append(linkBtn(String(value), onClick));
      else r.dd.append(String(value));
    }
    return r;
  }

  function update() {
    const rec = bandOf(app.world, id);
    if (!rec) { setText(leadP, 'This band is not in the record.'); return; }
    const { live, b } = rec;
    const wld = app.world;
    setText(leadP, lead(wld, b, live));
    // chips: kind, state, family tone
    const chipSig = `${b.kind}|${live ? b.state : 'gone'}|${b.data?.elder ? 1 : 0}|${b.data?.pact ? 1 : 0}`;
    if (chips.dataset.sig !== chipSig) {
      chips.dataset.sig = chipSig;
      chips.textContent = '';
      chips.className = `band-chips is-${b.kind === 'dragon' ? 'dragon' : b.family || 'outlaw'}`;
      chips.append(h('span.band-chip.is-kind', null, svgIcon(iconOf(b.kind), 13), kindLabel(b)));
      chips.append(h('span.band-chip', { text: live ? STATE_WORD[b.state] || b.state : cap1(FATE[b.cause] || 'gone') }));
      if (b.kind === 'dragon' && b.data?.variety) chips.append(h('span.band-chip', { text: VARIETY[b.data.variety] || b.data.variety }));
      if (b.data?.elder) chips.append(h('span.band-chip.is-gold', { text: 'Elder' }));
      if (b.data?.pact) chips.append(h('span.band-chip.is-warn', { text: 'Bound by pact' }));
    }
    const beast = isBeast(b);
    if (live) {
      const str = beast ? b.power : b.strength;
      setText(c1.el.querySelector('.k'), beast ? 'Power' : 'Strength');
      setText(c1.v, fmtInt(str));
      setText(c1.s, beast ? 'soldier-equivalents' : 'under arms');
      setText(c2.el.querySelector('.k'), beast ? 'Health' : 'Morale');
      const mv = beast ? b.hp ?? 1 : b.morale ?? 1;
      setText(c2.v, `${Math.round(Math.min(1, mv) * 100)}%`);
      setText(c2.s, beast ? (mv < 0.35 ? 'gravely wounded' : mv < 0.7 ? 'wounded' : 'whole') : (mv < 0.4 ? 'wavering' : mv > 1.02 ? 'in high spirits' : 'steady'));
      setText(c3.el.querySelector('.k'), b.kind === 'dragon' ? 'Hoard' : 'Loot');
      setText(c3.v, fmtInt(b.loot));
      setText(c3.s, 'crowns');
      const peak = Math.max(1, b.data?.peak || str || 1);
      meter.style.setProperty('--v', `${Math.round(Math.min(1, (str || 0) / peak) * 100)}%`);
      meter.classList.toggle('is-danger', b.family === 'beast' || b.kind === 'horde');
      meter.hidden = false;
    } else {
      setText(c1.el.querySelector('.k'), 'At its height');
      setText(c1.v, fmtInt(b.peak)); setText(c1.s, beast ? 'power' : 'strong');
      setText(c2.el.querySelector('.k'), 'Raids'); setText(c2.v, fmtInt(b.raids)); setText(c2.s, '');
      setText(c3.el.querySelector('.k'), 'Killed'); setText(c3.v, fmtInt(b.kills)); setText(c3.s, '');
      meter.hidden = true;
    }
    // the record rows
    const parts = [];
    const sel2 = (s) => () => app.select(s, { focus: true });
    const leaderName = b.leader ? (typeof b.leader === 'string' ? b.leader : b.leader.name) : null;
    if (leaderName) parts.push(row('leader', b.kind === 'horde' ? 'Khan' : b.family === 'outlaw' ? 'Captain' : 'Led by', leaderName));
    const sinceLabel = beast ? (live ? 'Known since' : 'Known') : live ? 'Abroad since' : 'Abroad';
    parts.push(row('since', sinceLabel, live ? `${year(b.createdDay)} (${years(wld.time.day - b.createdDay)})` : `${year(b.born)} – ${year(b.died)}`));
    const origin = civLabel(wld, b.originCivId);
    if (origin) parts.push(row('origin', 'Out of', origin, sel2({ kind: 'civ', id: b.originCivId })));
    if (live && b.civId >= 0) {
      const role = b.state === 'hired' ? 'Paymaster' : b.state === 'tamed' ? 'Master' : b.data?.bound ? 'Bound to' : b.data?.pact ? 'Pact with' : 'Allied with';
      parts.push(row('civ', role, civLabel(wld, b.civId), sel2({ kind: 'civ', id: b.civId })));
      // a grave-plague's dead (myth/sickness.js, bands/kinds/undead.js)
      if (b.data?.bound) parts.push(row('bound', 'Its binding', `until ${year(b.data.bound.u)}, while its master's ruler lives and is at war`));
    }
    if (live && b.state === 'hired') {
      const a = armyOf(wld, b.data?.armyId);
      if (a) parts.push(row('army', 'Marches as', a.name || 'an army', sel2({ kind: 'army', id: a.id })));
      parts.push(row('fee', 'Fee', `${fmtInt(b.data?.fee)} crowns a month`));
    }
    if (live && b.targetSid >= 0 && wld.settlements[b.targetSid]) parts.push(row('target', 'Bound for', wld.settlements[b.targetSid].name, sel2({ kind: 'settlement', id: b.targetSid })));
    if (b.kind === 'dragon') {
      const lair = siteOf(wld, live ? b.data?.lair : null) || (!live ? wld.sites.find((s) => s.kind === 'lair' && s.data?.bandId === b.id) : null);
      if (lair) parts.push(row('lair', 'Lair', lair.name, () => app.focus(lair.x, lair.y, Math.max(app.renderer?.camera?.zoom || 10, 11))));
      if (live) {
        const age = Math.round((wld.time.day - (b.data?.born ?? b.createdDay)) / DAYS_PER_YEAR);
        parts.push(row('age', 'Age', `${fmtInt(age)} years${b.data?.elder ? ' (an Elder)' : ''}`));
        parts.push(row('wakings', 'Wakings', fmtInt(b.data?.wakings || 0)));
        if (b.data?.pact) parts.push(row('pact', 'Tribute from', civLabel(wld, b.data.pact.civId), sel2({ kind: 'civ', id: b.data.pact.civId })));
      }
    }
    if (live) { parts.push(row('raids', 'Raids', fmtInt(b.raids))); parts.push(row('kills', 'Killed', fmtInt(b.kills))); }
    if (!live && b.slayer && b.slayer.name) parts.push(row('slayer', 'Slain by', `${b.slayer.name}${civLabel(wld, b.slayer.civId) ? ' of ' + civLabel(wld, b.slayer.civId) : ''}`));
    const sig = parts.map((r) => r.dt.textContent).join('|');
    if (sig !== lastKv) { lastKv = sig; kv.textContent = ''; for (const r of parts) kv.append(r.dt, r.dd); }

    // acts of the gods (Mythic worlds, living wild beasts)
    const actSig = live && beast && mythLevel(wld) >= 2 && b.state !== 'tamed' ? `${b.id}|${b.state}|${Math.round((b.hp ?? 1) * 20)}|${wld.time.day >> 6}` : '';
    if (actSig !== lastActs) {
      lastActs = actSig;
      acts.textContent = '';
      // the divine-acts section (story.acts), when present, carries the buttons: here only the odds
      const shared = sectionsFor('band').some((d) => d.id === 'story.acts');
      if (actSig && typeof kernelTools.previewTool === 'function') {
        for (const [tid, icon, label] of [['slay_beast', 'slay', 'Send a hero'], ['tame_beast', 'tame', 'Tame']]) {
          const p = kernelTools.previewTool(wld, tid, b.x, b.y, { target: { kind: 'band', id: b.id } });
          if (!p) continue;
          const odds = p.ok && p.cards && p.cards[0] ? Math.round(p.cards[0].p * 100) : null;
          if (shared) {
            if (!p.ok) continue;   // no realm within reach: the divine-acts section says why
            acts.append(h('span.band-chip.band-oddchip', { title: p.ok ? p.text : p.reason }, svgIcon(icon, 13), tid === 'slay_beast' ? 'God-sent hero' : 'Taming', h('span.band-odds', { text: odds != null ? `${odds}%` : '—' })));
            continue;
          }
          const btn = h('button.btn.btn-sm.band-act', { type: 'button', title: p.ok ? p.text : p.reason, disabled: !p.ok }, svgIcon(icon, 14), label, odds != null ? h('span.band-odds', { text: `${odds}%` }) : null);
          btn.addEventListener('click', () => {
            const r = bandAct(app, tid, b);
            setText(actNote, r && r.message ? r.message : '');
            lastActs = '';
          });
          acts.append(btn);
        }
      }
    }
    // the years, sampled: the ledger's life chart (raids as ticks), else the band's own samples
    const led = mini ? ledgerOf(wld, b) : null;
    if (led) {
      const sig = `L${led.days.length}:${led.rows[led.rows.length - 1].join(',')}`;
      if (sig !== lastSpark) {
        lastSpark = sig;
        const marks = [];
        for (const e of wld.sys?.bands?.log || []) if (e[1] === b.id) marks.push({ day: e[0], color: '#e0664d', label: 'raid' });
        requestAnimationFrame(() => mini.setData({ days: led.days, rows: led.rows, marks, live: led.live }));
      }
      mini.el.hidden = false; spark.hidden = true;
      chartBox.parentElement.hidden = false;
    } else {
      const hist = historyOf(wld, b, live);
      const sparkSig = hist.join(',');
      if (mini) mini.el.hidden = true;
      spark.hidden = false;
      if (sparkSig !== lastSpark && spark.isConnected) { lastSpark = sparkSig; drawSpark(spark, hist); }
      chartBox.parentElement.hidden = hist.length < 2;
    }
    // deeds, newest first
    if (wld.chronicle.seq !== lastSeq) {
      lastSeq = wld.chronicle.seq;
      const list = deedsOf(wld, b.id);
      deeds.textContent = '';
      if (!list.length) deeds.append(h('p.empty-note', { text: 'Nothing about this band has reached the chronicle yet.' }));
      for (const e of list) {
        const m = MONTH_NAMES[Math.floor(e.day / DAYS_PER_MONTH) % MONTHS_PER_YEAR];
        // dated like every other dossier's history (Y555); the month is in the tooltip
        const btn = h('button.ins-entry.band-deed', { type: 'button', title: `${m}, Year ${Math.floor(e.day / DAYS_PER_YEAR)} · show on the map` }, h('span.y', { text: `Y${Math.floor(e.day / DAYS_PER_YEAR)}` }), h('span.t', { text: e.text }));
        if (e.imp >= 3) btn.classList.add('is-major');
        btn.addEventListener('click', () => { if (Number.isFinite(e.x) && Number.isFinite(e.y)) app.focus(e.x, e.y); app.emit?.('chronicleScrollTo', e.seq); });
        deeds.append(btn);
      }
    }
    const L = bands?.BEAST_LORE?.[b.kind];
    setText(lore, L ? `${L.habitat}. ${L.behaviour} ${L.answer}` : '');
    lore.parentElement.hidden = !L;
  }
  update();
  return { update, destroy() { root.remove(); } };
}

// ---------------------------------------------------------------------------
// Registration

function pointOf(world, id) {
  const rec = bandOf(world, id);
  if (!rec) return null;
  const b = rec.b;
  if (rec.live && b.state === 'hired') { const a = armyOf(world, b.data?.armyId); if (a) return { x: a.x, y: a.y }; }
  return Number.isFinite(b.x) ? { x: b.x, y: b.y } : null;
}

function search(app, q, limit) {
  const w = app.world;
  if (!w || !q) return [];
  const s = q.trim().toLowerCase();
  if (s.length < 2) return [];
  const out = [];
  const consider = (b, live) => {
    const title = titleOf(b).toLowerCase();
    const leader = (b.leader ? (typeof b.leader === 'string' ? b.leader : b.leader.name) : '') || '';
    const kind = kindLabel(b).toLowerCase();
    let score = 0;
    if (title.replace(/^the\s+/, '').startsWith(s)) score = 3;
    else if (title.includes(s)) score = 2.2;
    else if (leader.toLowerCase().includes(s)) score = 1.8;
    else if (kind.includes(s) || b.kind.includes(s)) score = 1.2;
    if (!score) return;
    out.push({
      kind: 'band', id: b.id, label: titleOf(b), icon: iconOf(b.kind), score: score + (live ? 0.5 : 0),
      sub: live ? `${kindLabel(b)} · ${STATE_WORD[b.state] || b.state}` : `${kindLabel(b)} · ${FATE[b.cause] || 'gone'} in ${year(b.died)}`,
      run: (a) => a.select({ kind: 'band', id: b.id }, { focus: true }),
    });
  };
  for (const b of w.bands) consider(b, true);
  for (const b of w.sys?.bands?.archive || []) consider(b, false);
  return out.sort((a, b) => b.score - a.score).slice(0, limit || 12);
}

function contextItems(app, ctx) {
  const w = app.world;
  if (!w) return [];
  const out = [];
  const pick = (ctx.picks || []).find((p) => p.kind === 'band');
  if (pick) {
    const rec = bandOf(w, pick.id);
    if (rec) {
      const b = rec.b;
      out.push({ label: `Inspect ${titleOf(b)}`, icon: iconOf(b.kind), run: () => app.select({ kind: 'band', id: b.id }, { focus: false }) });
      if (rec.live) out.push({ label: `Follow ${titleOf(b)}`, icon: 'follow', run: () => { app.select({ kind: 'band', id: b.id }, { focus: true }); app.follow = { kind: 'band', id: b.id }; } });
      if (rec.live && isBeast(b) && mythLevel(w) >= 2 && b.state !== 'tamed' && typeof kernelTools.previewTool === 'function') {
        for (const [tid, icon, verb] of [['slay_beast', 'slay', 'Send a hero against'], ['tame_beast', 'tame', 'Try to tame']]) {
          const p = kernelTools.previewTool(w, tid, b.x, b.y, { target: { kind: 'band', id: b.id } });
          if (!p || !p.ok) continue;
          const odds = p.cards && p.cards[0] ? ` (${Math.round(p.cards[0].p * 100)}%)` : '';
          out.push({ label: `${verb} ${titleOf(b)}${odds}`, icon, run: () => { bandAct(app, tid, b); } });
        }
      }
    }
  } else if (mythLevel(w) >= 2 && ctx.tile && typeof app.setTool === 'function') {
    out.push({ label: 'Summon a beast here', icon: 'summon', run: () => app.setTool('summon_beast') });
  }
  return out;
}

const SHOT = { dragon: 0.95, horde: 0.8, pirates: 0.65, company: 0.7, undead: 0.75, kraken: 0.6 };
function directorShots(app) {
  const w = app.world;
  const st = w?.sys?.bands;
  if (!st) return [];
  const day = w.time.day;
  const out = [];
  const kinds = Object.keys(BAND_KINDS);
  for (let k = st.log.length - 1; k >= 0 && out.length < 6; k--) {
    const [d, bandId, , , x1, y1, ki, sev] = st.log[k];
    if (day - d > 40) break;
    const kind = kinds[ki] || 'bandits';
    const base = SHOT[kind] ?? (BAND_KINDS[kind]?.family === 'beast' ? 0.55 : 0.35);
    const rec = bandOf(w, bandId);
    const name = rec ? titleOf(rec.b) : kindLabel({ kind });
    const t = w.settlements.find((s) => s && s.x === x1 && s.y === y1);
    // a named dragon burning a town is the story itself (imp 4, Myth & Magic); other raids are war
    const dragon = kind === 'dragon';
    const where = t ? t.name : 'the country';
    out.push({ type: dragon ? 'dragon-raid' : `${kind}-raid`, x: x1, y: y1, zoom: dragon ? 8 : 9, imp: dragon ? 4 : 3, score: base * (0.6 + 0.4 * (sev || 0.5)) * (1 - (day - d) / 60),
      caption: { text: `${cap1(name)} ${dragon ? 'burns' : 'strikes'} ${where}.`, cat: dragon ? 'myth' : 'war', icon: iconOf(kind), place: t ? t.name : '' }, ref: { k: 'band', id: bandId } });
  }
  for (const b of w.bands) {
    if (b.kind === 'horde' && b.state === 'roam') out.push({ type: 'horde-march', x: b.x, y: b.y, zoom: 7, score: 0.5, caption: { text: `${cap1(titleOf(b))} rides on ${w.settlements[b.targetSid]?.name || 'the settled lands'}.`, cat: 'war', icon: 'horde' }, ref: { k: 'band', id: b.id } });
    else if (b.kind === 'dragon' && (b.state === 'raid' || b.state === 'return')) out.push({ type: 'dragon-flight', x: b.x, y: b.y, zoom: 7, score: 0.85, caption: { text: `${cap1(titleOf(b))} is aloft.`, cat: 'myth', icon: 'dragon' }, ref: { k: 'band', id: b.id } });
  }
  return out;
}

/** Called once by mounts.js when the app is ready, before any world begins. */
export function mount(app) {
  for (const [k, svg] of Object.entries(ICONS)) registerIcon(k, svg);
  registerView('band', {
    label: 'Roaming power', icon: 'band',
    describe(a, sel) {
      const rec = a.world ? bandOf(a.world, sel.id) : null;
      if (!rec) return { name: 'A roaming band', sub: '' };
      const b = rec.b;
      return { name: titleOf(b), icon: iconOf(b.kind), sub: `${kindLabel(b)} · ${rec.live ? STATE_WORD[b.state] || b.state : FATE[b.cause] || 'gone'}` };
    },
    point: pointOf,
    frame(world, id) {
      const p = pointOf(world, id);
      if (!p) return null;
      const rec = bandOf(world, id);
      const b = rec?.b;
      let x0 = p.x - 5, y0 = p.y - 5, x1 = p.x + 5, y1 = p.y + 5;
      if (rec?.live && b.targetSid >= 0 && world.settlements[b.targetSid]) {
        const t = world.settlements[b.targetSid];
        x0 = Math.min(x0, t.x - 3); y0 = Math.min(y0, t.y - 3); x1 = Math.max(x1, t.x + 3); y1 = Math.max(y1, t.y + 3);
      }
      return { x0, y0, x1, y1 };
    },
    rendererSel: (world, id) => ({ kind: 'band', id, x: null, y: null }),
    mount: mountRecord,
  });
  registerSearchSource({ id: 'bands', label: 'Roaming powers', search });
  registerContextProvider(contextItems);
  registerDirectorSource(directorShots);
  registerCommand({
    id: 'bands.next', label: 'Show the next roaming power', group: 'Map', keywords: ['band', 'dragon', 'horde', 'pirates', 'outlaws', 'beast', 'monster'], icon: 'band',
    when: (a) => Boolean(a.world && a.world.bands.length),
    run(a) {
      const list = a.world.bands.slice().sort((p, q) => (q.kind === 'dragon') - (p.kind === 'dragon') || (q.power || q.strength) - (p.power || p.strength) || p.id - q.id);
      if (!list.length) return;
      const cur = a.selection && a.selection.kind === 'band' ? list.findIndex((b) => b.id === a.selection.id) : -1;
      const next = list[(cur + 1) % list.length];
      a.select({ kind: 'band', id: next.id }, { focus: true });
    },
  });
}
