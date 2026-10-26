// A town's people in the Chronicle (docs/design/people-in-numbers.md, phase 4): the marks wars,
// plagues and peace leave in its age bands (core/cohorts.js) and its trades (jobs.js).
//
// Monthly (settlement.js, after the births and deaths): s.flags.by (births this year),
// s.flags.fy (dead in feuds this year), s.flags.hn (months running the fields have been short
// of hands), and the world's natural births and deaths (sys.civ.pb / pd, closed yearly into
// sys.civ.py for the statistics).
// Yearly, in the town's own month (s.id mod 12), at most one entry, each kind at most once a
// town in TOWN_YEARS, about three a realm a century and, world-wide, once in WORLD_YEARS (the
// stronger marks) or WORLD_YEARS_MINOR (youth, ageing, feuds):
//   people.hollow   a generation missing among the young adults (men of a ten-year span under
//                   HOLLOW of the spans either side), named for the realm's bloodiest recent war,
//                   or a great sickness. Remembered on s.flags.hollow for the dossier's pyramid
//   people.widows   women of 15–44 outnumber the men 1.4 to 1, a war fought within 20 years
//   people.boom     births 30 % above the town's own decade for three years running, within ten
//                   years of a peace
//   people.hands    fields short of hands (farmers under 70 % of demand) six months running
//   people.feuds    a people's feuds (Mythic in-fighting) killed 0.6 % of the town in a year
//   people.youth    ages 15–24 above 24 % of a town of 2,000+
//   people.ageing   people over 65 above 18 % of a town of 1,000+
// In a Mythic town every people's bands are stages of its own life. Sentences are chosen by the
// town and the year, never by world.rng.

import { DAYS_PER_YEAR, RACE_META } from '../../core/constants.js';
import { bandTotals, cohortSummary, lifeExpectancy, NB, NC } from '../../core/cohorts.js';
import { registerProvider } from '../../core/ext.js';
import { fin, record } from './state.js';
import { approx } from './prose.js';

const Y = DAYS_PER_YEAR;
const TOWN_YEARS = 40, REALM_YEARS = 33, WORLD_YEARS = 12, WORLD_YEARS_MINOR = 6;
const MINOR = { youth: 1, ageing: 1, feuds: 1 };
const HOLLOW = 0.6;
const B = new Float64Array(NC);

/** The month's tallies (settlement.js; out: cohortMonth's births, deaths, famine, feud). */
export function peopleMonthly(world, s, X, out) {
  const fl = s.flags;
  fl.by = fin(fl.by) + out.births;
  if (out.feud > 0) fl.fy = fin(fl.fy) + out.feud;
  fl.hn = X.farmLoad > 0 && X.farmFrac < 0.7 ? fin(fl.hn) + 1 : 0;
  const st = world.sys.civ;
  if (st) { st.pb = fin(st.pb) + out.births; st.pd = fin(st.pd) + out.deaths + out.famine + fin(out.feud); }
}

/** Yearly (civ index, Midsummer): close the world's tallies for the statistics. */
export function peopleWorldYear(world) {
  const st = world.sys.civ;
  if (!st) return;
  st.py = [Math.round(fin(st.pb)), Math.round(fin(st.pd))];
  st.pb = 0; st.pd = 0;
}

const free = (world, key, years) => { const last = world.sys.civ?.rl?.[key]; return last == null || world.time.day - last >= years * Y; };
const stamp = (world, key) => { if (world.sys.civ) world.sys.civ.rl[key] = world.time.day; };
/** May this town (and its realm) tell this kind now? */
const may = (world, kind, s, civ) => free(world, `pp:${kind}:${s.id}`, TOWN_YEARS) && free(world, `pr:${kind}:${civ.id}`, REALM_YEARS)
  && free(world, `pw:${kind}`, MINOR[kind] ? WORLD_YEARS_MINOR : WORLD_YEARS);
const told = (world, kind, s, civ) => { stamp(world, `pp:${kind}:${s.id}`); stamp(world, `pr:${kind}:${civ.id}`); stamp(world, `pw:${kind}`); };
const choose = (s, y, arr) => arr[(s.id * 7 + y) % arr.length];
const fill = (t, v) => t.replace(/\{(\w+)\}/g, (_, k) => (v[k] != null ? v[k] : ''));

/** The realm's war that cost it the most since `since` (active or ended after it), or null. */
function bloodiestWar(world, civ, since) {
  let best = null, bd = 0;
  for (const w of world.wars) {
    if (!w || (!w.attackers.includes(civ.id) && !w.defenders.includes(civ.id))) continue;
    if (!w.active && !(fin(w.endDay, -Infinity) >= since)) continue;
    const d = fin(w.casualties?.[civ.id]);
    if (d > bd) { bd = d; best = w; }
  }
  return best;
}
/** Days since the realm's last war ended (Infinity if none; 0 while one is fought). */
function sincePeace(world, civ) {
  let last = -Infinity;
  for (const w of world.wars) {
    if (!w || (!w.attackers.includes(civ.id) && !w.defenders.includes(civ.id))) continue;
    if (w.active) return 0;
    if (fin(w.endDay, -Infinity) > last) last = w.endDay;
  }
  return world.time.day - last;
}
const warName = (w) => (w && w.name ? (/^the /i.test(w.name) ? 'the ' + w.name.slice(4) : 'the ' + w.name) : 'the wars');

const TEXT = {
  hollow: [
    'Years after {cause}, {town} felt the hole it left: a generation of young men was missing, and their sons were never born.',
    'In {town} a whole generation came up short. {Cause} had taken its young men, and the town was poorer in hands and husbands for decades.',
    'The children of {town} grew up among the gaps {cause} had left: few men of their fathers’ age, and fewer still to marry.',
  ],
  widows: [
    '{town} became a town of widows: after {cause}, its women of marrying age outnumbered the men {ratio} to one.',
    'So many of {town}’s young men had fallen in {cause} that its women outnumbered them {ratio} to one, and many never married.',
  ],
  boom: [
    'With the peace, {town} filled with cradles: for three years running more children were born there than in any decade before.',
    'Peace brought the men home, and {town} its children: the birth rate stood a third above its old mark for three years together.',
  ],
  hands: [
    'In {town} the fields went unworked for want of hands; the harvest fell short and weeds took the furrows.',
    '{town} had more fields than farmers: for half a year its land lay half-tended, and bread grew dear.',
  ],
  feuds: [
    'Feuds among the {people} of {town} grew bloody: about {n} died at one another’s hands in a single year.',
    'The {people} of {town} turned on each other: blood feuds and challenges cost about {n} lives in a year.',
  ],
  youth: [
    '{town} teemed with the young: one in four of its people was between fifteen and twenty-five, restless for land and work.',
    'Young people crowded {town}: a quarter of the town was under twenty-five and old enough to want more than it had.',
  ],
  ageing: [
    '{town} grew old: nearly one in five of its people had seen sixty-five winters, and few children ran in its streets.',
    'The young had gone from {town}, and the old remained: almost a fifth of its people were past sixty-five.',
  ],
};

/** One town's year (settlement.js, in its own month): close its tallies and tell at most one mark it bears. */
export function peopleYearly(world, s, civ) {
  const fl = s.flags;
  const pop = fin(s.population);
  // births against the town's own decade (per head), for booms
  const br = pop > 0 ? fin(fl.by) / pop : 0;
  const avg = fin(fl.bavg);
  fl.boomN = avg > 0 && br > 1.3 * avg ? fin(fl.boomN) + 1 : 0;
  fl.bavg = Math.round((avg > 0 ? avg + (br - avg) / 10 : br) * 1e5) / 1e5;
  const feudDead = fin(fl.fy);
  fl.by = 0; fl.fy = 0;
  if (!civ || !civ.alive || !s.alive) return;
  const tot = bandTotals(s.cohorts, B);
  if (!(tot > 0)) return;
  const day = world.time.day, y = Math.floor(day / Y);
  const v = { town: s.name };
  const tell = (kind, imp, extra) => {
    told(world, kind, s, civ);
    Object.assign(v, extra);
    const t = fill(choose(s, y, TEXT[kind]), v);
    record(world, { cat: 'civ', imp, key: 'people.' + kind, text: t.charAt(0).toUpperCase() + t.slice(1), s, civ, tags: ['people', kind] });
  };
  const n = (b) => B[b] + B[NB + b];
  // a hollow among the young men: a ten-year span against the spans either side
  if (pop >= 2000) {
    for (let b = 3; b <= 7; b++) {
      const span = B[b] + B[b + 1], before = B[b - 2] + B[b - 1], after = B[b + 2] + B[b + 3];
      if (before + after > 0 && span < HOLLOW * (before + after) / 2) {
        if (!may(world, 'hollow', s, civ)) break;
        const w = bloodiestWar(world, civ, day - 60 * Y);
        const plague = !w && fin(s.hist?.plagues) > 0;
        if (!w && !plague) break;
        const cause = w ? warName(w) : 'the great sickness';
        fl.hollow = { b, day, cause };
        tell('hollow', civ.capitalId === s.id ? 3 : 2, { cause, Cause: cause.charAt(0).toUpperCase() + cause.slice(1) });
        return;
      }
    }
  }
  let men = 0, women = 0;
  for (let b = 3; b <= 8; b++) { men += B[b]; women += B[NB + b]; }
  if (pop >= 1000 && men > 0 && women >= 1.4 * men && may(world, 'widows', s, civ)) {
    const w = bloodiestWar(world, civ, day - 20 * Y);
    if (w) { tell('widows', 2, { cause: warName(w), ratio: (women / men).toFixed(1).replace(/\.0$/, '') }); return; }
  }
  if (fin(fl.boomN) >= 3 && pop >= 500) {
    const sp = sincePeace(world, civ);
    if (sp > 0 && sp <= 10 * Y && may(world, 'boom', s, civ)) { tell('boom', 2, {}); return; }
  }
  if (fin(fl.hn) >= 6 && pop >= 500 && may(world, 'hands', s, civ)) { tell('hands', 2, {}); return; }
  if (feudDead >= 0.006 * pop && feudDead >= 10 && may(world, 'feuds', s, civ)) {
    tell('feuds', feudDead >= 0.015 * pop ? 2 : 1, { people: (RACE_META[s.race]?.plural || 'people').toLowerCase(), n: approx(feudDead) });
    return;
  }
  if (pop >= 2000 && (n(3) + n(4)) > 0.24 * tot && may(world, 'youth', s, civ)) { tell('youth', 1, {}); return; }
  let old = 0;
  for (let b = 13; b < NB; b++) old += n(b);
  if (pop >= 1000 && old > 0.18 * tot && may(world, 'ageing', s, civ)) tell('ageing', 1, {});
}

// ---------------------------------------------------------------------------
// The world's people in the yearly record (stats.js, ext yearRecord → rec.people): median age,
// natural births and deaths per thousand over the last complete year (sys.civ.py; war, plague
// and disasters are charted apart), life expectancy at birth as if those rates held, and the
// working hands in each trade (per mille, jobs.js order; 15 in a Mythic world).

const W = new Float64Array(NC), T = new Float64Array(NC);
registerProvider('yearRecord', 'people', (world) => {
  let pop = 0;
  W.fill(0);
  const tr = [];
  let hands = 0;
  for (const s of world.settlements) {
    if (!s || !s.alive || !s.cohorts) continue;
    pop += bandTotals(s.cohorts, T);
    for (let i = 0; i < NC; i++) W[i] += T[i];
    const j = s.jobs;
    if (Array.isArray(j)) for (let t = 0; t < j.length; t++) { tr[t] = (tr[t] || 0) + j[t]; hands += j[t]; }
  }
  if (!(pop > 0)) return null;
  const out = { med: Math.round(cohortSummary(Array.from(W)).median * 10) / 10 };
  const py = world.sys.civ?.py;
  if (Array.isArray(py) && py.length === 2) {
    out.bpk = Math.round(py[0] / pop * 10000) / 10;
    out.dpk = Math.round(py[1] / pop * 10000) / 10;
    if (out.dpk > 0) out.le = Math.round(lifeExpectancy(out.dpk / 1000, (out.bpk - out.dpk) / 1000) * 10) / 10;
  }
  if (hands > 0) out.tr = tr.map((v) => Math.round(1000 * (v || 0) / hands));
  return out;
});

/** The realm's word for its manpower (dossier): its levy base against its people. */
export function manpowerReason(world, civ) {
  const r = fin(civ.flags?.mpr, 1);
  if (r < 0.85) {
    let h = null;
    for (const id of civ.settlementIds || []) { const s = world.settlements[id]; if (s && s.alive && s.flags?.hollow && (!h || s.flags.hollow.day > h.day)) h = s.flags.hollow; }
    return h ? `Few young men: the hollow left by ${h.cause}` : 'Few young men of fighting age';
  }
  if (r > 1.15) return 'Many young men of fighting age';
  return '';
}
