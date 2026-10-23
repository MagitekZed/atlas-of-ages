// Legends — the Legends tab (key O) for Mythic and Legendary worlds: the state of the age
// (the weave and the world's mana over time, the marks of the Fading), the peoples of the
// world (race population shares over the centuries, the world's mix today, a card per people
// with its numbers, character, leanings and how fast its temperament drifts with its history,
// the latest turnings and expulsions), the peoples of each continent and of each realm
// (stacked bars from the sim's peoples helpers, ./peoples.js), the bestiary (beasts
// alive and slain, from world.bands and WP2's archive), the places of power, the arcane arts
// across the world, and the miracles and tales (Legendary worlds see only the last).
// Read-only: it reads the yearly records (record.myth from the yearRecord provider), world
// state and the chronicle; it never writes the world.

import { registerTab } from './registry.js';
import { h, Binder, svgEl, cssVar } from './dom.js';
import * as F from './format.js';
import { RACE_META, BAND_KINDS, DAYS_PER_YEAR } from '../core/constants.js';
import { RACES, RACE_LIST, raceRgb } from '../sim/myth/races.js';
import { raceBlurb } from '../sim/myth/identity.js';
import { leyNodes, manaAt } from '../sim/myth/mana.js';
import { SCHOOLS, ARCANE_TECHS } from '../sim/myth/arcana.js';
import { weaveWord } from '../sim/myth/fading.js';
import { DOMAIN_LABEL } from '../sim/myth/divine.js';
import { raceBadge, MYTH_ICONS } from './views/myth.js';
import { worldMix, realmMix, landMix, peoplesBar, mixKey, mixPhrase, raceDot, wholePct } from './peoples.js';
import { driftWords, leanings } from './temper.js';

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const yearOf = (day) => Math.floor(fin(day) / DAYS_PER_YEAR);
const isMythic = (w) => Boolean(w && w.params && w.params.mythLevel >= 2 && w.sys?.myth?.v != null);
const isLegend = (w) => Boolean(w && w.params && w.params.mythLevel >= 1);
const svg = (inner, size = 16) => svgEl(`<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`);
const sec = (title, icon, ...children) => h('section.ins-section.legends-sec', null, h('h4.rule-head', null, icon ? svg(MYTH_ICONS[icon] || '', 14) : null, title), ...children);

/** Race shares per yearly record: [{ y, total, v: { race: pop } }] (thinned to ≤ 240 points). */
function raceSeries(w) {
  const ys = w.history?.years || [];
  const out = [];
  const step = Math.max(1, Math.ceil(ys.length / 240));
  for (let k = 0; k < ys.length; k += step) {
    const r = ys[k]?.myth?.races;
    if (!r) continue;
    let total = 0;
    for (const v of Object.values(r)) total += fin(v);
    out.push({ y: ys[k].y, total, v: r });
  }
  return out;
}

/** Stacked race-share area chart onto a canvas. */
function drawShares(canvas, w) {
  const series = raceSeries(w);
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const cssW = canvas.clientWidth || 340, cssH = canvas.clientHeight || 130;
  const W = Math.round(cssW * dpr), H = Math.round(cssH * dpr);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const pad = { l: 4, r: 4, t: 6, b: 16 };
  const gw = cssW - pad.l - pad.r, gh = cssH - pad.t - pad.b;
  ctx.strokeStyle = cssVar('--chart-grid', 'rgba(237,227,203,0.07)');
  ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) { const y = pad.t + (gh * k) / 4; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + gw, y); ctx.stroke(); }
  if (series.length < 2) {
    ctx.fillStyle = cssVar('--ink-3', '#8f8877');
    ctx.font = 'italic 13px "IM Fell English", Georgia, serif';
    ctx.textAlign = 'center';
    ctx.fillText('The chronicles of the peoples begin after the first year.', cssW / 2, cssH / 2);
    return;
  }
  const y0 = series[0].y, y1 = series[series.length - 1].y;
  const X = (y) => pad.l + (y1 > y0 ? ((y - y0) / (y1 - y0)) * gw : 0);
  const base = new Float64Array(series.length);
  for (const r of RACE_LIST) {
    const top = series.map((p, k) => base[k] + (p.total > 0 ? fin(p.v[r]) / p.total : 0));
    if (top.every((v, k) => v - base[k] < 1e-4)) continue;
    const c = raceRgb(r);
    ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},0.88)`;
    ctx.beginPath();
    series.forEach((p, k) => { const x = X(p.y), y = pad.t + gh * (1 - top[k]); if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    for (let k = series.length - 1; k >= 0; k--) ctx.lineTo(X(series[k].y), pad.t + gh * (1 - base[k]));
    ctx.closePath(); ctx.fill();
    for (let k = 0; k < series.length; k++) base[k] = top[k];
  }
  ctx.fillStyle = cssVar('--ink-3', '#8f8877');
  ctx.font = '11px "IBM Plex Mono", monospace';
  ctx.textAlign = 'left'; ctx.fillText(`Y${y0}`, pad.l, cssH - 3);
  ctx.textAlign = 'right'; ctx.fillText(`Y${y1}`, pad.l + gw, cssH - 3);
}

/** A small line chart of a record value (weave or mana) over the years. */
function drawLine(canvas, w, pick, max, color) {
  const ys = (w.history?.years || []).filter((r) => r && r.myth && Number.isFinite(pick(r)));
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const cssW = canvas.clientWidth || 160, cssH = canvas.clientHeight || 40;
  const W = Math.round(cssW * dpr), H = Math.round(cssH * dpr);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  if (ys.length < 2) return;
  const y0 = ys[0].y, y1 = ys[ys.length - 1].y;
  ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
  ctx.beginPath();
  ys.forEach((r, k) => {
    const x = 2 + (y1 > y0 ? ((r.y - y0) / (y1 - y0)) * (cssW - 4) : 0);
    const y = 3 + (cssH - 6) * (1 - Math.max(0, Math.min(1, pick(r) / max)));
    if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  });
  ctx.stroke();
}

/** "Lizardfolk Y0–310, Humans since Y310": who outnumbered all others, century by century. */
function agesOfPeoples(w) {
  const s = raceSeries(w);
  if (!s.length) return '';
  const spans = [];
  for (const p of s) {
    let best = null, bv = -1;
    for (const r of RACE_LIST) { const v = fin(p.v[r]); if (v > bv) { bv = v; best = r; } }
    if (!best || bv <= 0) continue;
    const last = spans[spans.length - 1];
    if (last && last.r === best) last.to = p.y; else spans.push({ r: best, from: p.y, to: p.y });
  }
  // fold short reigns (under 40 years) into their neighbours
  const kept = spans.filter((sp, k) => sp.to - sp.from >= 40 || k === spans.length - 1);
  if (!kept.length) return '';
  const parts = kept.slice(-4).map((sp, k, arr) => `${RACE_META[sp.r].plural} ${k === arr.length - 1 ? `since Y${sp.from}` : `Y${sp.from}–${sp.to}`}`);
  return `The most numerous people: ${parts.join(', ')}.`;
}

/** The race's character and gifts in a few clauses ("Ingenious: they study harder…"), or null. */
function identityList(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return h('ul.lg-identity', null, ...list.slice(0, 4).map((c) => {
    const t = String(c), k = t.indexOf(': ');
    return k > 0 && k < 20 ? h('li', null, h('b', { text: t.slice(0, k) }), document.createTextNode(': ' + t.slice(k + 2) + '.')) : h('li', { text: t + '.' });
  }));
}

/**
 * A people's card: its badge and numbers, its blurb, which way its temperament leans and how
 * fast it drifts with its history ("Inventive and restless; they change quickly.").
 */
function raceCard(x) {
  const R = RACES[x.r] || {};
  const blurb = raceBlurb(x.r);
  const lean = leanings(R.temper, 3);
  const drift = driftWords(R.adapt);
  const line = [lean.length ? F.headName(F.listing(lean, 3)) : '', drift ? (lean.length ? drift.phrase : F.headName(drift.phrase)) : ''].filter(Boolean).join('; ');
  const card = h('div.lg-race', { class: blurb || line ? 'is-card' : '' },
    raceBadge(x.r, { size: 18, plural: true }),
    h('span.lg-n', { text: x.pop >= 1 ? `${x.pct}% · ${F.people(x.pop)} · ${x.civs} realm${x.civs === 1 ? '' : 's'} · ${x.towns} town${x.towns === 1 ? '' : 's'}` : `gone · once ${F.people(x.peak)}` }),
    blurb ? h('p.lg-blurb', { text: blurb }) : null,
    identityList(R.identity),
    line ? h('p.lg-temper', null, h('span', { text: line + '.' }), drift ? h('span.lg-drift', { text: `drift \u00d7${fin(R.adapt, 1).toFixed(1)}`, title: `Their temperament drifts at ${drift.detail}.` }) : null) : null,
  );
  return card;
}

// ---------------------------------------------------------------------------

function legendsTab(app, el) {
  const b = new Binder();
  el.classList.add('legends');
  const empty = h('p.empty-note', { text: 'No legends yet: this world holds only history. Choose a Legendary or Mythic age at genesis, or awaken magic with the god tools.' });
  const body = h('div.legends-body');
  el.append(empty, body);

  // --- the age
  const weaveVal = h('span.lg-big'), weaveSub = h('span.lg-sub');
  const weaveCv = h('canvas.lg-spark', { 'aria-label': 'The weave over the years' });
  const manaVal = h('span.lg-big'), manaSub = h('span.lg-sub');
  const manaCv = h('canvas.lg-spark', { 'aria-label': 'Mean mana over the years' });
  const marks = h('p.lg-note');
  const ageSec = sec('The age', 'myth',
    h('div.lg-gauges', null,
      h('div.lg-gauge', null, h('span.lg-k', { text: 'Weave' }), weaveVal, weaveSub, weaveCv),
      h('div.lg-gauge', null, h('span.lg-k', { text: 'Mana' }), manaVal, manaSub, manaCv),
    ),
    marks,
  );
  b.text(weaveVal, () => (isMythic(app.world) ? `${Math.round(100 * fin(app.world.sys.myth.weave, 1))}%` : '—'));
  b.text(weaveSub, () => (isMythic(app.world) ? weaveWord(fin(app.world.sys.myth.weave, 1)) : ''));
  b.text(manaVal, () => { const y = app.world?.history?.years; const r = y && y[y.length - 1]?.myth; return r ? String(Math.round(100 * fin(r.mana))) : '—'; });
  b.text(manaSub, () => 'land mean');
  b.text(marks, () => {
    const w = app.world;
    if (!isMythic(w)) return '';
    const m = w.sys.myth.fade?.marks || {};
    const txt = Object.entries(m).sort((a, c) => c[0] - a[0]).map(([k, d]) => `${k === '0.75' ? 'the ley-fires dimmed' : k === '0.5' ? 'the wonders grew few' : 'the Age of Myth ended'} in Year ${yearOf(d)}`);
    const aw = w.sys.myth.awakenedDay != null ? `Magic woke in Year ${yearOf(w.sys.myth.awakenedDay)}. ` : '';
    return aw + (txt.length ? F.headName(F.listing(txt, 3)) + '.' : w.params.fading ? 'Industry has not yet thinned the weave.' : 'The Fading is off: the weave holds whatever the smoke.');
  });
  b.hide(ageSec, () => !isMythic(app.world));

  // --- the peoples
  const shareCv = h('canvas.lg-shares', { 'aria-label': 'Population of each people over time, as shares' });
  const ages = h('p.lg-note');
  // the world's mix today: everyone counted by share in every town (towns = where a people
  // holds the majority), with the realms each people rules
  const worldBar = peoplesBar({ size: 'lg', label: 'Peoples of the world' });
  worldBar.classList.add('lg-pp-bar');
  b.run(() => { if (isMythic(app.world)) worldBar.set(worldMix(app.world)); });
  const raceRows = h('div.lg-races');
  b.list(raceRows, () => {
    const w = app.world;
    if (!isMythic(w)) return [];
    const n = Object.fromEntries(RACE_LIST.map((r) => [r, { civs: 0, towns: 0, pop: 0, share: 0, pct: 0 }]));
    for (const c of w.civs) if (c && c.alive && c.race && n[c.race]) n[c.race].civs++;
    const wm = worldMix(w), wp = wholePct(wm);
    wm.forEach((it, k) => { if (n[it.race]) { n[it.race].towns = fin(it.towns); n[it.race].pop = fin(it.pop); n[it.race].share = fin(it.share); n[it.race].pct = wp[k]; } });
    return RACE_LIST.filter((r) => n[r].pop > 0 || n[r].towns || n[r].civs || fin(w.sys.myth.peak?.[r]) > 0).map((r) => ({ r, ...n[r], peak: fin(w.sys.myth.peak?.[r]) })).sort((a, c) => c.pop - a.pop);
  }, (x) => `${x.r}:${x.civs}:${x.towns}:${Math.round(Math.log2(x.pop + 1) * 4)}:${x.pct}`, (x) => raceCard(x));
  // the latest turnings (a town's dominant people changed) and expulsions, newest first; the
  // scan of the chronicle reruns only when it grows
  const shifts = h('div.lg-list');
  let shiftKey = '', shiftList = [], shiftW = null;
  b.list(shifts, () => {
    const w = app.world;
    if (!isMythic(w)) return [];
    const es = w.chronicle?.entries || [];
    const key = `${es.length}|${es.length ? es[es.length - 1].seq : 0}`;
    if (key !== shiftKey || w !== shiftW) {
      shiftKey = key; shiftW = w;
      const out = [];
      for (let k = es.length - 1; k >= 0 && out.length < 6; k--) { const e = es[k]; if (e && (e.key === 'myth.turned' || e.key === 'myth.expulsion')) out.push(e); }
      shiftList = out;
    }
    return shiftList;
  }, (e) => e.seq, (e) => {
    const row = h('button.lg-row.lg-tale', { type: 'button' }, h('span.lg-y', { text: `Y${yearOf(e.day)}` }), h('span.lg-text', { text: e.text }));
    row.addEventListener('click', () => {
      if (e.ref && e.ref.k) app.select({ kind: e.ref.k, id: e.ref.id }, { focus: true });
      else if (e.sid != null) app.select({ kind: 'settlement', id: e.sid }, { focus: true });
      else app.emit('chronicleScrollTo', e.seq);
    });
    return row;
  });
  const shiftBox = h('div', null, h('h5.sub-head', { text: 'Turnings and exiles' }), shifts);
  b.hide(shiftBox, () => shifts.childElementCount === 0);
  const peopleSec = sec('The peoples', 'myth', shareCv, ages, worldBar, raceRows, shiftBox);
  b.text(ages, () => (isMythic(app.world) ? agesOfPeoples(app.world) : ''));
  b.hide(peopleSec, () => !isMythic(app.world));

  // --- the peoples of each continent
  const lands = h('div.lg-table');
  b.list(lands, () => {
    const w = app.world;
    if (!isMythic(w) || !w.f.landmass) return [];
    const out = [];
    for (let k = 0; k < (w.features || []).length; k++) {
      const ft = w.features[k];
      if (!ft || ft.kind !== 'continent') continue;
      const fi = Math.round(ft.y) * w.W + Math.round(ft.x);
      const lm = fi >= 0 && fi < w.N ? w.f.landmass[fi] : -1;
      if (!(lm >= 0) || out.some((o) => o.lm === lm)) continue;
      const mix = landMix(w, lm);
      if (!mix.length) continue;
      let pop = 0, towns = 0;
      for (const it of mix) { pop += fin(it.pop); towns += fin(it.towns); }
      out.push({ k, ft, lm, mix, pop, towns });
    }
    return out.sort((a, c) => c.pop - a.pop);
  }, (x) => `${x.k}:${mixKey(x.mix)}:${Math.round(Math.log2(x.pop + 1) * 4)}`, (x) => {
    const row = h('button.lg-prow', { type: 'button' },
      h('span.lg-t', { text: x.ft.name || 'An unnamed land' }),
      h('span.lg-n', { text: `${F.people(x.pop)} · ${x.towns} town${x.towns === 1 ? '' : 's'}` }),
      peoplesBar({ size: 'md', label: `Peoples of ${x.ft.name}` }).set(x.mix),
      h('span.lg-s', { text: mixPhrase(x.mix, 4) }),
    );
    row.addEventListener('click', () => app.select({ kind: 'continent', id: x.k }, { focus: true }));
    return row;
  });
  const landNote = h('p.empty-note', { text: 'No land is peopled yet.' });
  b.hide(landNote, () => lands.childElementCount > 0);
  const landSec = sec('Peoples of the lands', 'myth', lands, landNote);
  b.hide(landSec, () => !isMythic(app.world));

  // --- the peoples of each realm
  const realms = h('div.lg-table');
  b.list(realms, () => {
    const w = app.world;
    if (!isMythic(w)) return [];
    const out = [];
    for (const c of w.civs) {
      if (!c || !c.alive) continue;
      const mix = realmMix(w, c);
      if (!mix.length) continue;
      let pop = 0;
      for (const it of mix) pop += fin(it.pop);
      out.push({ c, mix, pop });
    }
    return out.sort((a, d) => d.pop - a.pop || a.c.id - d.c.id).slice(0, 40);
  }, (x) => `${x.c.id}:${x.c.name}:${x.c.race}:${mixKey(x.mix)}:${Math.round(Math.log2(x.pop + 1) * 4)}`, (x) => {
    const row = h('button.lg-prow', { type: 'button' },
      h('span.lg-t', null, h('i.swatch', { style: { '--c': x.c.colorHex } }), x.c.name),
      h('span.lg-n', null, x.c.race ? raceDot(x.c.race, 14) : null, ` ${F.people(x.pop)}`),
      peoplesBar({ size: 'md', label: `Peoples of ${x.c.name}` }).set(x.mix),
      h('span.lg-s', { text: `${mixPhrase(x.mix, 4)}${x.c.race ? ` · ruled by ${RACE_META[x.c.race]?.plural.toLowerCase() || 'others'}` : ''}` }),
    );
    row.addEventListener('click', () => app.select({ kind: 'civ', id: x.c.id }, { focus: true }));
    return row;
  });
  const realmSec = sec('Peoples of the realms', 'myth', realms);
  b.hide(realmSec, () => !isMythic(app.world) || realms.childElementCount === 0);

  // --- bestiary (WP2's beasts)
  const beasts = h('div.lg-list');
  b.list(beasts, () => {
    const w = app.world;
    if (!isMythic(w)) return [];
    const live = (w.bands || []).filter((x) => x && BAND_KINDS[x.kind]?.family === 'beast').map((x) => ({ live: true, id: x.id, name: [x.name || BAND_KINDS[x.kind].label, x.epithet].filter(Boolean).join(' '), kind: x.kind, raids: fin(x.raids), kills: fin(x.kills), state: x.state }));
    const dead = (w.sys.bands?.archive || []).filter((x) => x && BAND_KINDS[x.kind]?.family === 'beast').slice(-12).reverse().map((x) => ({ live: false, id: x.id, name: [x.name || BAND_KINDS[x.kind]?.label, x.epithet].filter(Boolean).join(' '), kind: x.kind, raids: fin(x.raids), kills: fin(x.kills), fate: x.slayer ? `slain by ${typeof x.slayer === 'string' ? x.slayer : x.slayer.name || 'a hero'}` : x.cause || 'gone' }));
    return live.sort((a, c) => c.kills - a.kills || a.id - c.id).concat(dead).slice(0, 24);
  }, (x) => `${x.live ? 'l' : 'd'}${x.id}:${x.raids}:${x.kills}:${x.state || ''}`, (x) => {
    const row = h('button.lg-row', { type: 'button', class: x.live ? '' : 'is-past' },
      h('span.lg-t', { text: F.headName(x.name) }),
      h('span.lg-s', { text: `${BAND_KINDS[x.kind]?.label || x.kind}${x.live ? ` · ${x.state}` : ` · ${String(x.fate).startsWith('slain by') ? x.fate : F.humanize(String(x.fate))}`}` }),
      h('span.lg-n', { text: x.raids || x.kills ? `${x.raids} raids · ${F.people(x.kills)} slain` : '' }),
    );
    row.addEventListener('click', () => app.select({ kind: 'band', id: x.id }, { focus: x.live }));
    return row;
  });
  const beastNote = h('p.empty-note', { text: 'No great beasts have been seen yet.' });
  const beastSec = sec('Bestiary', 'folklore', beasts, beastNote);
  b.hide(beastNote, () => beasts.childElementCount > 0);
  b.hide(beastSec, () => !isMythic(app.world));

  // --- places of power
  const nodes = h('div.lg-list');
  b.list(nodes, () => {
    const w = app.world;
    if (!isMythic(w)) return [];
    return leyNodes(w).slice().sort((a, c) => fin(c.data?.power) - fin(a.data?.power) || a.id - c.id).slice(0, 30).map((n) => {
      const o = w.f.owner[n.i];
      return { n, holder: o >= 0 ? w.civs[o] : null, mana: manaAt(w, n.x, n.y) };
    });
  }, (x) => `${x.n.id}:${x.holder ? x.holder.id : -1}:${Math.round(x.mana * 20)}`, (x) => {
    const row = h('button.lg-row', { type: 'button' },
      h('span.lg-t', { text: F.headName(x.n.name) }),
      h('span.lg-s', null, x.holder ? h('i.swatch', { style: { '--c': x.holder.colorHex, marginRight: '5px' } }) : null, x.holder ? x.holder.name : 'the wild'),
      h('span.lg-n', { text: `power ${Math.round(100 * fin(x.n.data?.power, 0.8))} · mana ${Math.round(100 * x.mana)}` }),
    );
    row.addEventListener('click', () => app.select({ kind: 'site', id: x.n.id }, { focus: true }));
    return row;
  });
  const nodeSec = sec('Places of power', 'node', nodes);
  b.hide(nodeSec, () => !isMythic(app.world));

  // --- the arts
  const arts = h('div.lg-list');
  b.list(arts, () => {
    const w = app.world;
    if (!isMythic(w)) return [];
    const out = [];
    for (const S of Object.values(SCHOOLS)) {
      const techs = ARCANE_TECHS.filter((t) => t.school === S.id);
      let realms = 0, first = null, firstDay = Infinity, deepest = 0;
      for (const c of w.civs) {
        if (!c || !c.tech?.known) continue;
        let n = 0;
        for (const t of techs) { const d = c.tech.known[t.id]; if (d != null) { n++; if (d < firstDay) { firstDay = d; first = c; } } }
        if (n && c.alive) realms++;
        if (n > deepest) deepest = n;
      }
      out.push({ S, realms, first, firstDay, deepest, total: techs.length });
    }
    return out.sort((a, c) => c.realms - a.realms || a.firstDay - c.firstDay);
  }, (x) => `${x.S.id}:${x.realms}:${x.deepest}`, (x) => h('div.lg-row.is-static', { style: { '--sc': `rgb(${x.S.color.join(',')})` } },
    h('span.lg-t.lg-school', { text: x.S.label }),
    h('span.lg-s', { text: x.first ? `first ${x.first.adjective || x.first.name}, Y${yearOf(x.firstDay)}` : x.S.desc }),
    h('span.lg-n', { text: x.realms ? `${x.realms} realm${x.realms === 1 ? '' : 's'} · deepest ${x.deepest}/${x.total}` : 'unpractised' }),
  ));
  const artSec = sec('The arcane arts', 'arcane', arts);
  b.hide(artSec, () => !isMythic(app.world));

  // --- miracles and tales (Legendary and Mythic)
  const tales = h('div.lg-list');
  b.list(tales, () => {
    const w = app.world;
    if (!isLegend(w)) return [];
    const es = w.chronicle.entries;
    const out = [];
    for (let k = es.length - 1; k >= 0 && out.length < 14; k--) {
      const e = es[k];
      if (!e.key || !(e.key.startsWith('event.folk_') || e.key.startsWith('myth.divine') || e.key === 'myth.awakening' || e.key.startsWith('myth.fading') || e.key === 'myth.kinstrife' || e.key.startsWith('myth.race'))) continue;
      out.push(e);
    }
    return out;
  }, (e) => e.seq, (e) => {
    const row = h('button.lg-row.lg-tale', { type: 'button' }, h('span.lg-y', { text: `Y${yearOf(e.day)}` }), h('span.lg-text', { text: e.text }));
    row.addEventListener('click', () => {
      if (e.ref && e.ref.k) app.select({ kind: e.ref.k, id: e.ref.id }, { focus: true });
      else if (e.sid != null) app.select({ kind: 'settlement', id: e.sid }, { focus: true });
      else app.emit('chronicleScrollTo', e.seq);
    });
    return row;
  });
  const talesNote = h('p.empty-note', { text: 'No tales are told yet.' });
  const answered = h('p.lg-note');
  b.text(answered, () => {
    const w = app.world;
    if (!isMythic(w)) { const f = w?.sys?.myth?.folk; return f ? `${fin(f.n)} tales told, ${Object.keys(f.saints || {}).length} saints remembered.` : ''; }
    const d = w.sys.myth.divine || {};
    const by = Object.entries(d.byDomain || {}).sort((a, c) => c[1] - a[1]).map(([k, n]) => `${DOMAIN_LABEL[k] || k} ${n}`);
    return `The gods have answered ${fin(d.n)} time${fin(d.n) === 1 ? '' : 's'}${by.length ? ` (${by.join(', ')})` : ''}; ${fin(w.sys.myth.folk?.n)} tales told.`;
  });
  const taleSec = sec('Miracles and tales', 'folklore', answered, tales, talesNote);
  b.hide(talesNote, () => tales.childElementCount > 0);

  body.append(ageSec, peopleSec, landSec, realmSec, beastSec, nodeSec, artSec, taleSec);
  b.hide(empty, () => isLegend(app.world));
  b.hide(body, () => !isLegend(app.world));

  let drawnKey = '';
  const charts = () => {
    const w = app.world;
    if (!isMythic(w)) return;
    const key = `${w.history?.years?.length || 0}|${shareCv.clientWidth}|${document.documentElement.dataset.theme || ''}`;
    if (key === drawnKey) return;
    drawnKey = key;
    drawShares(shareCv, w);
    drawLine(weaveCv, w, (r) => r.myth?.weave, 1, cssVar('--brass', '#c9a466'));
    drawLine(manaCv, w, (r) => r.myth?.mana, 1, 'rgb(180,154,240)');
  };
  return {
    show() { b.update(); drawnKey = ''; charts(); },
    update() { b.update(); charts(); },
    hide() {},
  };
}

let mounted = false;
export function mount(app) {
  if (mounted) return;
  mounted = true;
  registerTab({
    id: 'legends', label: 'Legends', key: 'O', icon: 'legends', order: 65,
    desc: 'The age of myth: peoples, beasts, places of power, the arts and the tales.',
    when: (a) => isLegend(a.world),
    unavailable: 'Legends appear in Legendary and Mythic worlds.',
    mount: legendsTab,
  });
}
