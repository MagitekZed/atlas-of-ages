// Who holds power (chunk 7, docs/design/who-holds-power.md): a realm's estates, laws, court and
// where its money goes, in its dossier. Read-only: everything comes from civ.est, civ.laws,
// civ.court and civ.purse (sim/civ/power.js, laws.js, court.js).

import { h, Binder } from '../dom.js';
import * as F from '../format.js';
import { registerSection } from '../registry.js';
import { kv, rows } from '../inspector.js';
import { DAYS_PER_YEAR } from '../../core/constants.js';
import { estateNames, estatePower, reserveYears, ruinNow, ROLES } from '../../sim/civ/power.js';
import { factionName, wantWords } from '../../sim/civ/court.js';

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const pct = (v) => `${Math.round(fin(v) * 100)}%`;
const yearOf = (day) => Math.floor(fin(day) / DAYS_PER_YEAR);
const cap = (s) => String(s || '').replace(/^./, (c) => c.toUpperCase());

const MOOD = (l) => (l >= 0.7 ? 'loyal' : l >= 0.5 ? 'content' : l >= 0.35 ? 'uneasy' : l >= 0.25 ? 'angry' : 'near revolt');
const WHY = { tax: 'the taxes', hunger: 'hunger', court: 'the court’s spending', coin: 'the coin', war: 'the wars', faith: 'the faith', land: 'the land', bond: 'their bondage', rights: 'their rights', ruler: 'the ruler', purge: 'the purge', dark: 'the dark arts' };
const LAW_WORDS = {
  inherit: { eldest: 'passes whole to the eldest heir', divided: 'is shared among the heirs', elective: 'is chosen by the great', seniority: 'passes to the eldest of the house' },
  faith: { one: 'one faith; the others forbidden', tolerated: 'the other faiths suffered', free: 'every faith free' },
  bond: { none: 'none: all are free', serf: 'serfdom: peasants bound to the land', slave: 'slavery: captives held as slaves' },
  land: { crown: 'held by the crown', nobles: 'held in fiefs by the great', freeholds: 'held by those who work it' },
};
const ARMY = { levy: 'levies called up in war', feudal: 'the lords bring their hosts', standing: 'a standing army', hired: 'hired companies' };

function civSection(app, sel, el) {
  const w = app.world, civ = w.civs[sel.id];
  if (!civ) return null;
  const b = new Binder();
  el.appendChild(h('h4.rule-head', { text: 'Who holds power' }));
  // the estates: each with its mood (and what angers it), its share of the people and the wealth, its power
  const est = () => (Array.isArray(civ.est) ? civ.est : []);
  el.appendChild(rows(b, () => {
    const names = estateNames(w, civ), pw = estatePower(civ) || [];
    return ROLES.map((role, i) => ({ i, r: est()[i], name: names[i] })).filter((q) => q.r && fin(q.r[0]) > 0 && q.name).map(({ i, r, name }) => {
      const why = civ.estWhy?.[i];
      return {
        key: `e${i}:${MOOD(r[3])}:${why}:${Math.round(r[0] * 100)}:${Math.round(r[1] * 100)}:${Math.round(fin(pw[i]) * 100)}`, icon: 'people', label: cap(name), n: MOOD(r[3]),
        s: `${r[3] < 0.5 && why ? `over ${WHY[why] || why} · ` : ''}${pct(r[0])} of the people, ${pct(r[1])} of the wealth, power ${pct(pw[i])}`,
      };
    });
  }, 'The estates are counted once a year.', app));
  // the laws
  const L = () => civ.laws || {};
  const since = (k) => (L().since && L().since[k] != null ? ` (since Year ${yearOf(L().since[k])})` : '');
  el.appendChild(kv(b, [
    { k: 'Inheritance', v: () => `The crown ${LAW_WORDS.inherit[L().inherit] || '—'}${since('inherit')}`, txt: true, hide: () => !L().inherit },
    { k: 'Faith', v: () => `${cap(LAW_WORDS.faith[L().faith] || '—')}${since('faith')}`, txt: true, hide: () => !L().faith },
    { k: 'Bondage', v: () => `${cap(LAW_WORDS.bond[L().bond] || '—')}${since('bond')}`, txt: true, hide: () => !L().bond },
    { k: 'Land', v: () => `${cap(LAW_WORDS.land[L().land] || '—')}${since('land')}`, txt: true, hide: () => !L().land },
    { k: 'The army', v: () => cap(ARMY[civ.forces?.sys] || '—'), txt: true, hide: () => !civ.forces?.sys },
  ]));
  // the court
  el.appendChild(rows(b, () => (civ.court && Array.isArray(civ.court.f) ? civ.court.f : []).slice().sort((a, c) => c.sway - a.sway).map((f) => ({
    key: `f${f.k}:${f.lead?.name}:${f.want?.kind}:${f.want?.value}:${fin(f.grudge)}`, icon: 'crown', label: cap(factionName(w, civ, f.k)), n: `sway ${pct(f.sway)}`,
    s: `${f.lead ? `led by ${f.lead.name}` : 'leaderless'}${f.want ? ` · wants ${wantWords(w, f.want)}${fin(f.grudge) >= 2 ? ', refused twice' : fin(f.grudge) >= 1 ? ', refused once' : ''}` : ' · content for now'}`,
  })), 'No factions at court yet.', app));
  // where the money goes (last month)
  const m = () => (civ.purse && Array.isArray(civ.purse.m) ? civ.purse.m : null);
  el.appendChild(kv(b, [
    { k: 'Taxes in', v: () => (m() ? `${F.int(m()[0])} a month` : '—'), hide: () => !m() },
    { k: 'Corruption', v: () => `${pct(civ.purse?.graft)} kept by officials (${F.int(m()?.[1])})`, txt: true, hide: () => !m() },
    { k: 'Ruin and coin', v: () => { const r = ruinNow(w, civ), c = fin(civ.purse?.coin); return [r > 0.005 ? `${pct(r)} lost to ruin, until Year ${yearOf(civ.purse.ruin.until)}` : '', c > 0 ? `coin debased by ${pct(c)}` : ''].filter(Boolean).join('; ') || 'none'; }, txt: true, hide: () => !m() || !(fin(m()[2]) > 0 || fin(civ.purse?.coin) > 0) },
    { k: 'The court', v: () => `${F.int(m()?.[3])} a month (${pct(civ.purse?.court)} of income, and what lies above the reserve)`, txt: true, hide: () => !m() },
    { k: 'Reserve', v: () => `${reserveYears(w, civ).toFixed(1)} years of income (${F.int(m()?.[4])}); the treasury holds ${F.int(civ.treasury)}`, txt: true, hide: () => !m() },
  ]));
  b.update();
  return { update: () => b.update() };
}

export function mount() {
  registerSection('civ', { id: 'power.civ', order: 24, when: (a, sel) => Boolean(a.world && a.world.civs[sel.id] && (a.world.civs[sel.id].est || a.world.civs[sel.id].purse)), mount: civSection });
}
