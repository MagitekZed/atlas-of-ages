// The Nations ledger: every living nation, sortable by population, lands, power, towns,
// age, stability or wealth, with a bar relative to the leader; then the fallen, with
// their lifespans, peaks and the manner of their end. Pick two to four nations (Compare, or
// Shift+click a row) to open them side by side (./compare.js). In a Mythic world each realm
// also shows its peoples as a thin stacked bar (./peoples.js), and the ledger can be sorted by
// the share of its leading people.

import { liveCivs, civSettlements, enemiesOf } from '../core/entities.js';
import { h, clear, setText } from './dom.js';
import { tip } from './widgets.js';
import { iconEl } from './icons.js';
import * as F from './format.js';
import { powerOf } from '../sim/stats.js';
import { getPref, setPref } from './prefs.js';
import { RACE_META } from '../core/constants.js';
import { peoplesOn, realmMix, wholePct, peoplesBar, mixKey, mixPhrase } from './peoples.js';
import { strongestBands, article } from './temper.js';

let compareMod = null;
try { compareMod = await import('./compare.js'); } catch (e) { /* no comparisons */ }

// [key, label, value(world, civ, derived), format]; derived = { pop, towns, power } computed per refresh
const SORTS = [
  ['pop', 'People', (w, c, d) => d.pop, (v) => F.people(v)],
  ['land', 'Lands', (w, c) => c.territory || 0, (v) => F.area(v)],
  ['power', 'Power', (w, c, d) => d.power, (v) => F.num(v, 1)],
  ['towns', 'Towns', (w, c, d) => d.towns, (v) => F.int(v)],
  ['age', 'Age', (w, c) => w.time.day - c.foundedDay, (v) => F.span(v)],
  ['stab', 'Stability', (w, c) => c.stability || 0, (v) => F.pct(v)],
  ['gold', 'Treasury', (w, c) => c.treasury || 0, (v) => F.money(v)],
  // Mythic worlds only: the share of the realm's leading people (most homogeneous first)
  ['peoples', 'Peoples', (w, c, d) => (d.mix && d.mix[0] ? d.mix[0].share : 0), (v) => F.pct(v), { myth: true }],
];

export function createNations(app) {
  const el = h('div.tabpanel');
  let sortKey = getPref('ledgerSort', 'pop');
  if (!SORTS.some((s) => s[0] === sortKey)) sortKey = 'pop';

  const tiles = h('div.stat-tiles');
  const tAlive = tile('Living nations'), tFallen = tile('Fallen'), tPeople = tile('People in nations');
  tiles.append(tAlive.el, tFallen.el, tPeople.el);
  const seg = h('div.chip-row', { role: 'group', 'aria-label': 'Sort nations by' });
  for (const [key, label] of SORTS) {
    const b = h('button.chip', { type: 'button', text: label, 'aria-pressed': String(key === sortKey), dataset: { sort: key } });
    b.addEventListener('click', () => { sortKey = key; setPref('ledgerSort', key); for (const x of seg.children) x.setAttribute('aria-pressed', String(x === b)); lastSig = ''; refresh(); });
    seg.appendChild(b);
  }
  // comparison picking
  const picked = new Set();
  let picking = false;
  // Compare stands in the folio's running head (panel.js shows a tab's headActions)
  const pickBtn = h('button.icon-btn.head-compare', { type: 'button', 'aria-label': 'Compare nations', 'aria-pressed': 'false' }, iconEl('compare', { size: 18, label: 'Compare' }));
  tip(pickBtn, 'Pick two to four nations to set side by side (or Shift+click any row).', 'Compare');
  const pickBar = h('div.compare-bar', { hidden: true });
  const goBtn = h('button.btn.btn-sm.btn-brass', { type: 'button' });
  const clearBtn = h('button.btn.btn-sm.btn-quiet', { type: 'button', text: 'Clear' });
  pickBar.append(h('span.cb-text'), goBtn, clearBtn);
  goBtn.addEventListener('click', () => { if (compareMod && compareMod.openCompare(app, [...picked])) { picking = false; picked.clear(); syncPick(); } });
  clearBtn.addEventListener('click', () => { picked.clear(); picking = false; syncPick(); });
  pickBtn.addEventListener('click', () => { picking = !picking; if (!picking) picked.clear(); syncPick(); });
  pickBtn.hidden = !compareMod;
  function togglePick(id) {
    if (picked.has(id)) picked.delete(id); else if (picked.size < 4) picked.add(id);
    picking = true;
    syncPick();
  }
  function syncPick() {
    pickBtn.setAttribute('aria-pressed', String(picking));
    pickBar.hidden = !picking;
    setText(pickBar.querySelector('.cb-text'), picked.size < 2 ? `Pick ${picked.size ? 'one more' : 'two to four'} nation${picked.size ? '' : 's'} to compare` : `${picked.size} nations picked`);
    goBtn.textContent = `Compare ${picked.size || ''}`.trim();
    goBtn.disabled = picked.size < 2;
    for (const row of el.querySelectorAll('.ledger-row[data-civ]')) row.classList.toggle('is-picked', picked.has(Number(row.dataset.civ)));
  }
  const liveList = h('div.list', { role: 'list' });
  const fallenList = h('div.list', { role: 'list' });
  const fallenHead = h('h4.rule-head', null, 'The fallen ', h('span.count'));
  const liveHead = h('h4.rule-head', null, 'Living nations ', h('span.count'));
  el.append(tiles, h('div.ledger-head', null, h('div.ledger-sortrow', null, h('span.gen-label', { text: 'Sort by', style: { marginBottom: '0' } })), seg), pickBar, liveHead, liveList, fallenHead, fallenList);

  function tile(label) {
    const v = h('span.v'), d = h('span.d');
    return { el: h('div.stat-tile', null, h('span.k', { text: label }), v, d), v, d };
  }

  let lastSig = '';
  function refresh() {
    const w = app.world;
    if (!w) return;
    const civs = liveCivs(w).slice();
    const derived = new Map();
    const myth = peoplesOn(w);
    let total = 0;
    for (const c of civs) {
      const towns = civSettlements(w, c);
      const d = { towns: towns.length, pop: towns.reduce((a, s) => a + (s.population || 0), 0), power: powerOf(w, c, true), mix: myth ? realmMix(w, c) : null, bands: strongestBands(c, 2) };
      derived.set(c.id, d);
      total += d.pop;
    }
    // the Peoples sort is offered only where there are peoples
    for (const x of seg.children) if (x.dataset.sort === 'peoples') x.hidden = !myth;
    const sort = SORTS.find((s) => s[0] === sortKey && (myth || !s[4]?.myth)) || SORTS[0];
    const byPeoples = sort[0] === 'peoples';
    for (const x of seg.children) { const on = String(x.dataset.sort === sort[0]); if (x.getAttribute('aria-pressed') !== on) x.setAttribute('aria-pressed', on); }
    const val = (c) => { const v = sort[2](w, c, derived.get(c.id)); return Number.isFinite(v) ? v : 0; };
    civs.sort((a, b) => val(b) - val(a));
    const max = Math.max(1e-9, ...civs.map(val));
    const fallen = w.civs.filter((c) => !c.alive).sort((a, b) => (b.fallenDay || 0) - (a.fallenDay || 0));

    setText(tAlive.v, String(civs.length));
    setText(tAlive.d, civs.length ? `largest: ${civs.slice().sort((a, b) => derived.get(b.id).pop - derived.get(a.id).pop)[0].name}` : 'none yet');
    setText(tFallen.v, String(fallen.length));
    setText(tFallen.d, fallen.length ? `last: ${fallen[0].name}` : 'none yet');
    setText(tPeople.v, F.people(total));
    setText(tPeople.d, `${F.int(civs.reduce((a, c) => a + derived.get(c.id).towns, 0))} settlements`);
    setText(liveHead.querySelector('.count'), String(civs.length));
    setText(fallenHead.querySelector('.count'), String(fallen.length));
    fallenHead.hidden = fallen.length === 0;

    const sig = civs.map((c) => `${c.id}:${c.name}:${Math.round(val(c) / max * 100)}:${c.government}:${c.tech?.era}:${enemiesOf(w, c.id).length}:${c.goldenAge > 0}:${c.vassalOf}:${derived.get(c.id).bands.join(',')}${myth ? ':' + mixKey(derived.get(c.id).mix) : ''}`).join('|') + '#' + fallen.length + ':' + sort[0];
    if (sig === lastSig) return;
    lastSig = sig;

    clear(liveList);
    if (!civs.length) liveList.appendChild(h('p.empty-note', { text: 'No nations live on this world.' }));
    for (const c of civs) {
      const v = val(c);
      const d = derived.get(c.id);
      const wars = enemiesOf(w, c.id).length;
      const flags = h('span.flags');
      if (wars) flags.appendChild(h('span.tag.is-war', { text: wars === 1 ? 'at war' : `${wars} foes` }));
      if (c.goldenAge > 0) flags.appendChild(h('span.tag.is-good', { text: 'golden age' }));
      if (c.vassalOf != null) flags.appendChild(h('span.tag', { text: 'vassal' }));
      const m = h('div.meter');
      m.style.setProperty('--v', (Math.max(0, v / max) * 100).toFixed(1) + '%');
      m.style.setProperty('--mc', c.colorHex);
      const mix = myth && d.mix && d.mix.length ? d.mix : null;
      // sorted by peoples, the figure is the leading people's whole share (as in the bar)
      const valText = byPeoples ? (mix ? `${wholePct(mix)[0]}%` : '—') : sort[3](v);
      const valSub = byPeoples ? (mix ? RACE_META[mix[0].race]?.plural || '' : '') : sort[0] === 'pop' ? `${d.towns} towns` : F.people(d.pop);
      const row = h('button.ledger-row', { type: 'button', role: 'listitem', style: { '--c': c.colorHex }, dataset: { civ: String(c.id) }, class: (picked.has(c.id) ? 'is-picked' : '') + (mix ? ' has-peoples' : '') },
        h('span.stripe'),
        h('span.nm', null, c.name, flags),
        h('span.val', null, valText, h('small', { text: valSub })),
        // its temperament first ("warlike · devout"), then its state, age and founding
        h('span.sb', null, d.bands.length ? h('i.tb', { text: d.bands.join(' · ') }) : null, d.bands.length ? ' · ' : null, `${F.titleCase(c.government || 'tribe')} · ${F.eraName(c.tech?.era)} · since ${F.year(c.foundedDay)}`),
        byPeoples && mix ? null : m,
        mix ? peoplesBar({ size: 'sm', label: `Peoples of ${c.name}` }).set(mix) : null,
      );
      tip(row, `${c.ruler ? [c.ruler.title, c.ruler.name, c.ruler.epithet].filter(Boolean).join(' ') + ' rules. ' : ''}${d.bands.length ? `${F.headName(article(d.bands[0]))} ${d.bands.join(' and ')} people. ` : ''}${F.area(c.territory)} of land.${mix ? ` Its peoples: ${mixPhrase(mix, 4, ', ')}.` : ''}`, c.name);
      row.addEventListener('click', (e) => { if (compareMod && (picking || e.shiftKey)) togglePick(c.id); else app.select({ kind: 'civ', id: c.id }, { focus: true }); });
      liveList.appendChild(row);
    }
    clear(fallenList);
    for (const c of fallen.slice(0, 80)) {
      const row = h('button.ledger-row.is-fallen', { type: 'button', role: 'listitem', style: { '--c': c.colorHex }, dataset: { civ: String(c.id) }, class: picked.has(c.id) ? 'is-picked' : '' },
        h('span.stripe'),
        h('span.nm', { text: c.name }),
        h('span.val', null, F.people(c.peakPopulation), h('small', { text: 'at peak' })),
        h('span.sb', { text: `${F.lifespan(c.foundedDay, c.fallenDay)} · ${F.humanize(c.fallCause || 'collapse')}` }),
      );
      row.addEventListener('click', (e) => { if (compareMod && (picking || e.shiftKey)) togglePick(c.id); else app.select({ kind: 'civ', id: c.id }, { focus: false }); });
      fallenList.appendChild(row);
    }
    if (fallen.length > 80) fallenList.appendChild(h('p.empty-note', { text: `And ${fallen.length - 80} older nations, remembered in the Chronicle.` }));
  }

  return {
    id: 'nations', label: 'Nations', title: 'Nations', icon: 'nations', el, headActions: compareMod ? [pickBtn] : [],
    show() { lastSig = ''; refresh(); },
    refresh,
    onWorld() { lastSig = ''; refresh(); },
  };
}
