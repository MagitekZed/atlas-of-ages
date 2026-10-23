// Events (order 84): the event deck and living history. Owned by WP1 "Event Deck & Living
// History" (docs/design/expansion-packages.md).
//   engine.js     scheduling, one-draw checks, fire/record/effects, cooldowns (core/events.js defs)
//   heat.js       causal heat per subject;  governor.js  per-family and deck-wide volume budgets
//   decks/*.js    early (Stone & Bronze Ages, great beasts), town, realm, pair, land, world
//   character.js  city character: legends, specialties, traits, epithets, hist counters
//   ruins.js      resettlement, looting and excavation (siteBonus / settleName providers)
//   ages.js       ages of the world and black-swan boosts (rates / warAppetite / routeValue)
//   annals.js     the news filter, decade digests and the report tally
//   fate.js       the 'fate' entity tool and eligibleEvents
// Daily: towns on day (id·37) % 360, realms on (id·53) % 360, bordering pairs on (a·7+b) % 360,
// continents on day 90, the world on day 180; year start rolls counters, decays heat, prunes
// cooldowns and (every tenth year) writes the decade digests. Budget ≤ 4 ms per sim-year.
// Published (guarded import by others): eligibleEvents, currentAges, EVENT_FAMILIES,
// annalKeyLabel (+ agesHistory, traitLabel, landAges for the UI).

import { liveCivs } from '../../core/entities.js';
import { registerProvider } from '../../core/ext.js';
import { getEvents } from '../../core/events.js';
import { DAYS_PER_YEAR } from '../../core/constants.js';
import { EVENT_FAMILIES, traitLabel, TRAITS, SPECIALTIES } from './data.js';
import { evState, check, townCtx, realmCtx, pairCtx, landCtx, worldCtx, pruneCooldowns, available, countRoutes } from './engine.js';
import { decayHeat } from './heat.js';
import { townYear, watchSieges, wealthQuantiles, plagueSweep } from './character.js';
import { seedAges, agesYear, currentAges, agesHistory } from './ages.js';
import { annalKeyLabel, writeDigests, tallyNew } from './annals.js';
import { seedBeasts, beastsYear, beastsOf } from './decks/early.js';
import './decks/town.js';
import './decks/realm.js';
import './decks/pair.js';
import { landsYear } from './decks/land.js';
import './decks/world.js';
import './ruins.js';
import { eligibleEvents } from './fate.js';

export { eligibleEvents, currentAges, agesHistory, EVENT_FAMILIES, annalKeyLabel, traitLabel, TRAITS, SPECIALTIES };

const Y = DAYS_PER_YEAR;
const ID = 'events';

// modular inverses: the ids whose check falls on day d are id ≡ d·inv (mod 360)
const inv = (m) => { for (let x = 1; x < 360; x++) if ((m * x) % 360 === 1) return x; return 1; };
const INV37 = inv(37), INV53 = inv(53);

/** Continental ages now running: [{ lm, land, kind: 'dark'|'golden', name, from, until }]. Pure. */
export function landAges(world) {
  const lands = world?.sys?.events?.lands;
  if (!lands) return [];
  const out = [];
  for (const k of Object.keys(lands)) {
    const l = lands[k];
    if (l && l.age && l.age.until > world.time.day) out.push({ lm: Number(k), land: l.name, ...l.age });
  }
  return out;
}

function yearStart(world) {
  const st = evState(world);
  const y = Math.floor(world.time.day / Y);
  if (st.yr.y !== y) { st.yr = { y, cur: {}, last: st.yr.cur }; }
  decayHeat(world);
  pruneCooldowns(world);
  countRoutes(world);
  wealthQuantiles(world);
  plagueSweep(world);
  if (y > 0 && y % 10 === 0) writeDigests(world);
}

function townChecks(world, doy) {
  const ss = world.settlements;
  for (let id = (doy * INV37) % 360; id < ss.length; id += 360) {
    const s = ss[id];
    if (!s || !s.alive) continue;
    townYear(world, s);
    if (!s.alive) continue;
    check(world, 'town', townCtx(world, s));
  }
}
function realmChecks(world, doy) {
  const cs = world.civs;
  for (let id = (doy * INV53) % 360; id < cs.length; id += 360) {
    const c = cs[id];
    if (!c || !c.alive) continue;
    check(world, 'realm', realmCtx(world, c));
  }
}
function pairChecks(world, doy) {
  const cs = world.civs;
  for (const a of liveCivs(world)) {
    let b = (((doy - 7 * a.id) % 360) + 360) % 360;
    for (; b < cs.length; b += 360) {
      if (b <= a.id) continue;
      const o = cs[b];
      if (!o || !o.alive) continue;
      const ra = a.relations[b], rb = o.relations[a.id];
      if (!ra || !((ra.border || 0) > 0 || (rb && (rb.border || 0) > 0))) continue;
      check(world, 'pair', pairCtx(world, a, o));
    }
  }
}

export const system = {
  id: ID,
  order: 84,
  init(world) {
    const fresh = !(world.sys.events && world.sys.events.rc);
    evState(world);
    if (fresh) countRoutes(world);
    seedBeasts(world);
    seedAges(world);
    world.cache.evHeat = null;
    world.cache.evCd = null;
  },
  update(world) {
    const day = world.time.day;
    const doy = day % Y;
    evState(world);
    if (doy === 0) yearStart(world);
    if (day % 10 === 0) watchSieges(world);
    townChecks(world, doy);
    realmChecks(world, doy);
    pairChecks(world, doy);
    if (doy === 90) {
      beastsYear(world);
      for (const land of landsYear(world)) check(world, 'land', landCtx(world, land));
    }
    if (doy === 180) {
      agesYear(world);
      check(world, 'world', worldCtx(world));
    }
    tallyNew(world);
  },
  report(world) { return report(world); },
};

// ---------------------------------------------------------------------------
// yearRecord provider: { family: n } fired in the year just ended (WP6 stores it under 'ev')

registerProvider('yearRecord', 'ev', (world) => {
  const yr = world.sys && world.sys.events && world.sys.events.yr;
  const last = yr && yr.last;
  return last && Object.keys(last).length ? last : null;
});

// ---------------------------------------------------------------------------
// Report (headless)

function p90(hist) {
  let n = 0;
  for (const v of hist) n += v || 0;
  if (!n) return null;
  let acc = 0;
  for (let k = 0; k < hist.length; k++) { acc += hist[k] || 0; if (acc >= 0.9 * n) return k; }
  return hist.length - 1;
}

function report(world) {
  const st = world.sys.events;
  if (!st) return null;
  const t = st.tally;
  const years = Math.max(1, world.time.day / Y);
  const early = Math.min(250, years);
  const lines = [];
  const fam = t.fam || {};
  const famTot = Object.values(fam).reduce((a, b) => a + b, 0);
  const famRow = Object.entries(fam).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v} (${famTot ? Math.round(100 * v / famTot) : 0}%)`).join(' · ');
  lines.push(`deck: ${['town', 'realm', 'pair', 'land', 'world'].map((s) => `${s} ${getEvents(s).length}`).join(', ')} defs; exports ${Object.entries(available()).map(([k, v]) => `${k}${v ? '' : '✗'}`).join(' ')}`);
  lines.push(`imp≥2 ${(t.n2 / years).toFixed(2)}/yr overall, ${(t.n2early / early).toFixed(2)}/yr in Y0–250; ours ${(t.ev2 / years).toFixed(2)}/yr`);
  lines.push(`first imp≥4 ${t.first4 != null ? 'Y' + Math.floor(t.first4 / Y) : 'never'}; imp≥3 ${(t.n3 / years).toFixed(2)}/yr, p90 gap ${p90(t.gaps) ?? '—'} y`);
  lines.push(`war ${t.n2late ? Math.round(100 * t.war2late / t.n2late) : 0}% of imp≥2 after Y250; successions ${t.civ2 ? Math.round(100 * t.succ2 / t.civ2) : 0}% of Nations imp≥2`);
  lines.push(`families (imp≥2): ${famRow || 'none'}`);
  const cents = Object.keys(st.byCentury).map(Number).sort((a, b) => a - b);
  for (const c of cents) {
    const row = Object.entries(st.byCentury[c]).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' ');
    lines.push(`  C${c + 1} (Y${c * 100}–${c * 100 + 99}): ${row}`);
  }
  const top = Object.entries(st.counts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k.replace(/^(town|realm|pair|land|world)\./, '')} ${v}`).join(' · ');
  lines.push(`most fired: ${top}`);
  const ages = (st.ages?.past || []).map((a) => `${a.name} Y${Math.floor(a.from / Y)}–${Math.floor(a.to / Y)}`)
    .concat((st.ages?.cur || []).map((a) => `${a.name} Y${Math.floor(a.from / Y)}–`));
  lines.push(`ages: ${ages.join('; ') || 'none'}`);
  lines.push(`black swans: ${(st.swan?.hist || []).map((h) => `${h.name} Y${Math.floor(h.day / Y)}`).join('; ') || 'none'}`);
  const bs = beastsOf(world);
  lines.push(`great beasts: ${bs.length} (${bs.filter((b) => b.ext != null).length} extinct${bs.filter((b) => b.ext != null).length ? ', first Y' + Math.floor(Math.min(...bs.filter((b) => b.ext != null).map((b) => b.ext)) / Y) : ''})`);
  let epi = 0, traits = 0, legends = 0;
  for (const s of world.settlements) { if (!s || !s.alive) continue; if (s.epithet) epi++; if (s.traits && s.traits.length) traits++; if (s.legend) legends++; }
  lines.push(`towns: ${epi} with epithets, ${traits} with traits, ${legends} with legends`);
  const checks = [];
  const maxShare = famTot ? Math.max(...Object.values(fam)) / famTot : 0;
  // the volume targets are for long runs (SPEC §9 measures 1000 years); short runs only report
  if (years >= 500) checks.push({ ok: t.n2 / years >= 2 && t.n2 / years <= 40, label: `imp≥2 entries ${(t.n2 / years).toFixed(1)}/yr (2–40)` });
  if (years >= 300) checks.push({ ok: famTot < 60 || maxShare <= 0.2, label: `largest event family ${Math.round(100 * maxShare)}% of our imp≥2 entries (≤20%, target 15%)` });
  if (years >= 250) checks.push({ ok: t.n2early / 250 >= 1.5, label: `imp≥2 in Y0–250 ${(t.n2early / 250).toFixed(2)}/yr (≥1.5)` });
  if (years >= 300) checks.push({ ok: t.n2late === 0 || t.war2late / t.n2late <= 0.4, label: `war ${t.n2late ? Math.round(100 * t.war2late / t.n2late) : 0}% of imp≥2 after Y250 (≤40%)` });
  return { title: 'Events (WP1)', lines, checks };
}
