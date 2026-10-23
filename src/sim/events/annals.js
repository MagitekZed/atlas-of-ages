// News value and the annals. The single chronicle news filter (core setNewsFilter) folds the
// routine so the Chronicle reads as history rather than a register:
//   'succession'    a realm's second succession within 15 years, with no crisis or new house,
//                   drops to imp 1 and folds
//   'battle.minor'  unnamed battles below the war module's notable threshold fold (as does any
//                   other '<kind>.minor' key, e.g. a band's petty raid)
//   'pact.nap', 'pact.trade'  oaths of peace and trade compacts drop to imp 1 and fold
// Every tenth year each realm with 3 or more folded items gets one imp-2 digest line
// (key 'annals.decade') that sums its decade up. The filter is pure (it reads earlier entries,
// never rng or sim state); the digest reads the chronicle, as only digests may.
// Also kept here: the running tally behind system.report() (read from new entries each day),
// and annalKeyLabel(key) for the UI.

import { withArticle } from '../../core/util.js';
import { setNewsFilter, chronicle } from '../../core/chronicle.js';
import { getEvent } from '../../core/events.js';
import { liveCivs } from '../../core/entities.js';
import { DAYS_PER_YEAR } from '../../core/constants.js';
import { evState } from './engine.js';
import { govNote } from './governor.js';
import { pick, peopleOf, civName, CivName, countWord, decadeName, listJoin, shareWord, peopleCount } from './prose.js';

const ROUTINE_GAP = 15 * DAYS_PER_YEAR;
const CRISIS_TAGS = ['crisis', 'usurper', 'usurp', 'coup', 'dynasty', 'new-dynasty', 'union', 'regency', 'civil-war', 'epithet', 'restoration', 'pretender'];

function hasAny(tags, list) {
  if (!Array.isArray(tags)) return false;
  for (const t of tags) if (list.includes(t)) return true;
  return false;
}

/** The previous succession entry of the same realm within 15 years (scans back; pure). */
function recentSuccession(world, e) {
  const es = world.chronicle.entries;
  const floor = e.day - ROUTINE_GAP;
  for (let k = es.length - 1; k >= 0; k--) {
    const o = es[k];
    if (o.day < floor) return false;
    if (o.civId === e.civId && o.key && (o.key === 'succession' || o.key.startsWith('succession.'))) return true;
  }
  return false;
}

function newsFilter(world, e) {
  const key = e.key;
  if (key === 'succession' || key === 'succession.routine') {
    if (e.imp > 2 || e.civId == null || hasAny(e.tags, CRISIS_TAGS)) return null;
    return recentSuccession(world, e) ? { imp: 1, fold: true } : null;
  }
  // 'battle.minor' (WP4) and any other '<kind>.minor' key (band raids …) are routine by name
  if (key === 'battle.minor' || key.endsWith('.minor')) return { fold: true };
  if (key === 'pact.nap' || key === 'pact.trade') return { imp: 1, fold: true };
  return null;
}
setNewsFilter(newsFilter);

// ---------------------------------------------------------------------------
// Labels for the UI

const LABELS = {
  succession: 'Succession', 'succession.routine': 'Succession', 'battle.minor': 'Skirmish', battle: 'Battle',
  'pact.nap': 'Oath of peace', 'pact.trade': 'Trade compact', 'annals.decade': 'Decade annals', 'record.broken': 'Record broken',
  'event.epithet': 'Epithet', 'event.specialty': 'Specialty', 'event.resettled': 'Resettled', 'event.age': 'Age of the world',
  'event.age.end': 'Age ended', 'event.extinction': 'Extinction', 'event.nudge': 'Fate nudged',
};
/** A short human label for an entry key ('event.town.great_fire' → 'Great fire'). */
export function annalKeyLabel(key) {
  if (!key) return '';
  if (LABELS[key]) return LABELS[key];
  if (key.startsWith('event.')) {
    const d = getEvent(key.slice(6));
    if (d && d.label) return d.label;
  }
  const tail = key.split('.').pop().replace(/_/g, ' ');
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}

/** Family of one of our entry keys (for tallies and the UI), or null. */
const FREE_FAMILY = { epithet: 'character', specialty: 'character', resettled: 'ruins', age: 'ages', 'age.end': 'ages' };
export function familyOfKey(key) {
  if (!key) return null;
  if (key === 'annals.decade') return 'annals';
  if (!key.startsWith('event.')) return null;
  const id = key.slice(6);
  const d = getEvent(id);
  return d ? d.family : FREE_FAMILY[id] || null;
}

// ---------------------------------------------------------------------------
// Decade digests (run on the first day of every tenth year)

function pluralTitle(t) {
  const w = String(t || 'ruler').toLowerCase();
  if (/man$/.test(w)) return w.replace(/man$/, 'men');
  if (/[^aeiou]y$/.test(w)) return w.replace(/y$/, 'ies');
  if (/(s|sh|ch|x)$/.test(w)) return w + 'es';
  return w + 's';
}

const HUNT = 'event.realm.royal_hunt', FEAST = 'event.town.festival';
function classify(e) {
  const k = e.key || '';
  if (k === 'succession' || k.startsWith('succession.')) return 'rulers';
  if (k === 'battle.minor') return 'skirmish';
  if (k.endsWith('.minor')) return 'raid';
  if (k === 'pact.nap') return 'nap';
  if (k === 'pact.trade') return 'trade';
  if (k === HUNT) return 'hunt';
  if (k === FEAST) return 'feast';
  if (k === 'event.realm.great_census') return 'census';
  if (k === 'event.pair.embassy' || k === 'event.pair.hostage_exchange') return 'embassy';
  if (k === 'event.realm.royal_wedding') return 'wedding';
  return 'other';
}

/** One imp-2 line per realm with ≥ 3 folded items in the decade just ended. */
export function writeDigests(world) {
  const st = evState(world);
  const an = st.annals;
  const year = Math.floor(world.time.day / DAYS_PER_YEAR);
  const es = world.chronicle.entries;
  const per = new Map();
  for (let k = es.length - 1; k >= 0; k--) {
    const e = es[k];
    if (e.seq <= an.seq) break;
    if (!e.fold || e.civId == null) continue;
    let g = per.get(e.civId);
    if (!g) per.set(e.civId, (g = { n: 0, rulers: 0, skirmish: 0, raid: 0, nap: 0, trade: 0, hunt: 0, feast: 0, census: 0, embassy: 0, wedding: 0, other: 0, foes: new Map() }));
    const kind = classify(e);
    g[kind]++; g.n++;
    if (kind === 'skirmish' && e.ref && e.ref.k === 'war') {
      const war = world.wars[e.ref.id];
      if (war) {
        const side = war.attackers.includes(e.civId) ? war.defenders : war.attackers;
        for (const id of side) g.foes.set(id, (g.foes.get(id) || 0) + 1);
      }
    }
  }
  an.seq = world.chronicle.seq;
  const civs = liveCivs(world);
  const cands = [];
  for (const civ of civs) {
    const g = per.get(civ.id);
    // a decade of feasts alone is not worth a line: it needs some business of state, or bulk
    const state = g ? g.rulers + g.skirmish + g.raid + g.nap + g.trade + g.embassy + g.census + g.wedding : 0;
    if (g && g.n >= 3 && (state >= 1 || g.n >= 5)) cands.push([civ, g]);
  }
  cands.sort((a, b) => b[1].n - a[1].n || a[0].id - b[0].id);
  // the busiest realms get their line; a decade's digests never outnumber a quarter of the realms
  const cap = Math.max(3, Math.ceil(civs.length / 4));
  const dname = decadeName(year - 10);
  for (const [civ, g] of cands.slice(0, cap)) {
    const parts = [];
    // the title the last dead ruler held (not the living one's), with its proper article
    const deadTitle = (civ.rulerHistory?.[civ.rulerHistory.length - 1]?.title || civ.ruler?.title || 'ruler').toLowerCase();
    if (g.rulers) parts.push(g.rulers === 1 ? `buried ${withArticle(deadTitle)}` : `buried ${countWord(g.rulers)} ${pluralTitle(deadTitle)}`);
    if (g.skirmish) {
      let foe = null, fn = 0;
      for (const [id, n] of g.foes) if (n > fn) { fn = n; foe = world.civs[id]; }
      parts.push(`fought ${g.skirmish === 1 ? 'a skirmish' : countWord(g.skirmish) + ' skirmishes'}${foe ? ' against ' + peopleOf(foe) : ' on their borders'}`);
    }
    if (g.raid) parts.push(g.raid === 1 ? 'drove off a band of raiders' : `suffered ${countWord(g.raid)} raids by brigands and outlaws`);
    if (g.nap) parts.push(`swore ${g.nap === 1 ? 'an oath' : countWord(g.nap) + ' oaths'} of peace with their neighbours`);
    if (g.trade) parts.push(`sealed ${g.trade === 1 ? 'a trade compact' : countWord(g.trade) + ' trade compacts'}`);
    if (g.embassy) parts.push(`exchanged envoys ${g.embassy === 1 ? 'once' : countWord(g.embassy) + ' times'}`);
    if (g.wedding) parts.push(g.wedding === 1 ? 'celebrated a royal wedding' : `celebrated ${countWord(g.wedding)} royal weddings`);
    if (g.hunt) parts.push(g.hunt === 1 ? 'rode out on a royal hunt' : `rode out on ${countWord(g.hunt)} royal hunts`);
    if (g.feast) parts.push(g.feast === 1 ? 'kept a great feast' : `kept ${countWord(g.feast)} great feasts`);
    if (g.census) parts.push('counted their people');
    if (g.other) parts.push(`saw ${countWord(g.other)} lesser ${g.other === 1 ? 'matter' : 'matters'} set down in the annals`);
    const pop0 = an.pop[civ.id];
    const pop = Math.round(civ.population || 0);
    let tail = '';
    if (Number.isFinite(pop0) && pop0 > 200 && pop > 0) {
      const r = pop / pop0 - 1;
      if (r >= 0.12) tail = `, and their numbers grew by ${shareWord(r)} to ${peopleCount(world, pop)}`;
      else if (r <= -0.08) tail = `, while their numbers fell by ${shareWord(-r)}`;
    }
    const body = listJoin(parts) + tail;
    const pool = [
      `In ${dname} ${peopleOf(civ)} ${body}.`,
      `The annals of ${civName(civ)} for ${dname} record that its people ${body}.`,
    ];
    // a decade in which a fifth of the people died was no time of small things
    const fell = Number.isFinite(pop0) && pop0 > 200 && pop > 0 && pop / pop0 - 1 <= -0.2;
    if (!fell) pool.push(`For ${peopleOf(civ)}, ${dname} were years of small things: they ${body}.`);
    if (!g.skirmish) pool.push(`${CivName(civ)} passed ${dname} quietly; its people ${body}.`);
    else pool.push(`${CivName(civ)} knew no great war in ${dname}, but its people ${body}.`);
    const text = pick(world, pool).replace(/^./, (c) => c.toUpperCase());
    const cap0 = civ.capitalId != null ? world.settlements[civ.capitalId] : null;
    const entry = chronicle(world, {
      cat: 'civ', imp: 2, text, x: cap0 ? cap0.x : civ.originX ?? null, y: cap0 ? cap0.y : civ.originY ?? null,
      civId: civ.id, icon: 'scroll', ref: { k: 'civ', id: civ.id }, key: 'annals.decade', tags: ['digest'],
    });
    govNote(world, 'annals', entry);
    st.families.annals = (st.families.annals || 0) + 1;
  }
  an.seq = world.chronicle.seq;
  an.pop = {};
  for (const civ of civs) an.pop[civ.id] = Math.round(civ.population || 0);
}

// ---------------------------------------------------------------------------
// Tally for system.report(): every new entry, once (cheap: entries are appended in order)

const SUCC_RE = /(took|ascended|came to|inherited) the throne|succeeded (him|her|them)|was elected|took the (crown|seat)|became (king|queen|chief|ruler)/i;

export function tallyNew(world) {
  const st = evState(world);
  const t = st.tally;
  const seq = world.chronicle.seq;
  if (seq === t.seq) return;
  const es = world.chronicle.entries;
  let k = es.length - 1;
  while (k >= 0 && es[k].seq > t.seq) k--;
  for (k = k + 1; k < es.length; k++) {
    const e = es[k];
    if (e.imp < 2) continue;
    const late = e.day >= 250 * DAYS_PER_YEAR;
    t.n2++;
    if (late) t.n2late++; else t.n2early++;
    if (late && e.cat === 'war') t.war2late++;
    if (e.cat === 'civ') {
      t.civ2++;
      if (e.key === 'succession' || (e.key && e.key.startsWith('succession.')) || (!e.key && SUCC_RE.test(e.text))) t.succ2++;
    }
    const c = String(Math.floor(e.day / (DAYS_PER_YEAR * 100)));
    const bc = ((t.cent ||= {})[c] ||= {});
    bc[e.cat] = (bc[e.cat] || 0) + 1;
    bc._all = (bc._all || 0) + 1;
    const fam = familyOfKey(e.key);
    if (fam) {
      t.ev2++;
      const fm = (t.fam ||= {});
      fm[fam] = (fm[fam] || 0) + 1;
      const fcen = ((t.famCent ||= {})[c] ||= {});
      fcen[fam] = (fcen[fam] || 0) + 1;
    }
    if (e.imp >= 3) {
      t.n3++;
      if (t.last3 != null) {
        const gap = Math.min(40, Math.floor((e.day - t.last3) / DAYS_PER_YEAR));
        t.gaps[gap] = (t.gaps[gap] || 0) + 1;
      }
      t.last3 = e.day;
    }
    if (e.imp >= 4 && t.first4 == null) t.first4 = e.day;
  }
  t.seq = seq;
}

