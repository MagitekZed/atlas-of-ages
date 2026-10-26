// Bands · hire. Free companies and their paymasters.
//   formation  when a rich realm disbands an army (the armyDisbanded hook, or — for war code
//              that does not emit it — a monthly check for returning armies that vanished),
//              some veterans keep their arms and form a company under their old general
//   hiring     realms at war buy free companies nearby: the band becomes an army of the
//              employer with flags.merc = bandId (war.js fights it like any other), paid a
//              signing bounty and a monthly fee from the treasury
//   contracts  each month the fee is paid or falls into arrears; three months unpaid and the
//              company may turn on its paymaster and march on one of its towns to make it
//              their own (combat.js foundRealm). Peace, or the employer's fall, ends a contract.
// A hired band follows its army every day. If the army vanishes, the band takes the field
// again with what was left when it was stood down (on its way home, the war over, or its
// paymaster fallen), and is counted cut to pieces when it vanished in the middle of the war.

import { createArmy, removeArmy, enemiesOf, nearestSettlement, settlementsNear, liveCivs } from '../../core/entities.js';
import { emit } from '../../core/hooks.js';
import { DAYS_PER_YEAR, DAYS_PER_MONTH, WATER } from '../../core/constants.js';
import { clamp } from '../../core/util.js';
import { state, spawnBand, endBand, banditry, roomFor, capRoom, ready } from './engine.js';
import { planRoute, tileOf } from './move.js';
import { attackOf, townDefence } from './combat.js';
import { companyName, makeLeader } from './names.js';
import { say, pick, cap, civName, CivName, rulerOf, count, money, bandName, BandName, warName, isTold } from './prose.js';

const FEE = 0.6;                 // crowns per soldier per month
const BOUNTY = 1;                // crowns per soldier on signing
const MIN_STR = 40;

const armyById = (world, id) => {
  if (id == null || id < 0) return null;
  for (const a of world.armies) if (a.id === id) return a;
  return null;
};
const isRich = (civ) => civ && civ.alive && (civ.treasury || 0) >= 800 + 0.03 * (civ.population || 0);

// ---------------------------------------------------------------------------
// Formation

/** armyDisbanded hook: remember levies that might become a company (hunts and mercs aside). */
export function onArmyDisbanded(world, army, reason) {
  if (!world.sys.bands || !army || !army.flags) return;
  if (army.flags.merc != null) {
    // war code standing a hired company down: remember how it ended for syncHired
    const band = world.bands.find((b) => b.id === army.flags.merc);
    if (band && band.state === 'hired' && band.data.armyId === army.id) {
      band.data.lstr = army.strength;
      band.data.lst = /destroy|rout|battle|annihil|starv/i.test(String(reason || '')) ? 0 : 1;
    }
    return;
  }
  if (army.flags.hunt != null) return;
  if (!(army.strength >= MIN_STR)) return;
  if (/destroy|rout|annihil|battle|starv|plague/i.test(String(reason || ''))) return;
  const st = state(world);
  if (st.disb.some((d) => d[0] === army.id)) return;
  st.disb.push([army.id, army.civId, Math.round(army.strength), Math.round(army.x * 10) / 10, Math.round(army.y * 10) / 10, world.time.day, genName(army)]);
  if (st.disb.length > 24) st.disb.splice(0, st.disb.length - 24);
}

/**
 * Monthly fallback for war code that removes armies without the hook: an army that was
 * heading home last month and is gone now was disbanded. Then take this month's snapshot.
 */
export function snapshotArmies(world) {
  const st = state(world);
  const live = new Set();
  for (const a of world.armies) live.add(a.id);
  for (const s of st.snap) {
    const [id, civId, str, x, y, ret, gen] = s;
    if (!ret || live.has(id) || st.disb.some((d) => d[0] === id)) continue;
    if (str >= MIN_STR && world.civs[civId]?.alive) st.disb.push([id, civId, str, x, y, world.time.day, gen]);
  }
  if (st.disb.length > 24) st.disb.splice(0, st.disb.length - 24);
  const snap = [];
  for (const a of world.armies) {
    if (a.flags?.hunt != null || a.flags?.merc != null || !(a.strength >= MIN_STR)) continue;
    snap.push([a.id, a.civId, Math.round(a.strength), Math.round(a.x * 10) / 10, Math.round(a.y * 10) / 10, a.state === 'returning' ? 1 : 0, genName(a)]);
  }
  st.snap = snap;
}

/** The commander's name, whether army.general is the contract object or an old bare string. */
function genName(army) {
  const g = army && army.general;
  if (!g) return null;
  if (typeof g === 'string') return g;
  return typeof g.name === 'string' && g.name ? g.name : null;
}

/** Turn some of the month's disbanded armies into free companies. */
export function formCompanies(world) {
  const st = state(world);
  if (!st.disb.length) return;
  const list = st.disb;
  st.disb = [];
  const rate = banditry(world);
  if (rate <= 0) return;
  const rng = world.rng;
  for (const [, civId, str, x, y, , gen] of list) {
    const civ = world.civs[civId];
    if (!isRich(civ)) continue;
    const era = civ.tech?.era || 0;
    if (!rng.chance(clamp(0.12 * rate * (era >= 2 ? 1.5 : era >= 1 ? 1 : 0.5), 0, 0.9))) continue;
    if (!ready(world, `co${civId}`, 25 * DAYS_PER_YEAR)) continue;
    let strength = Math.round(str * rng.float(0.3, 0.55));
    strength = Math.min(strength, Math.round(capRoom(world)));
    if (strength < 25 || !roomFor(world, strength)) continue;
    const i = tileOf(world, x, y);
    if (world.f.water[i] !== WATER.LAND) continue;
    const leader = typeof gen === 'string' && gen
      ? { name: gen, short: String(gen).split(' ')[0], skill: Math.round(rng.float(0.9, 1.35) * 100) / 100, born: world.time.day - rng.int(30, 50) * DAYS_PER_YEAR }
      : makeLeader(world, civ.language, { title: 'Captain', lo: 0.9, hi: 1.3, minAge: 30, maxAge: 50 });
    const nm = companyName(world, leader, civ);
    const band = spawnBand(world, {
      kind: 'company', name: nm.name, leader, x: i % world.W, y: (i / world.W) | 0, homeI: i, homeR: 30,
      state: 'lair', strength, morale: 0.9, originCivId: civId,
      data: { emblem: nm.emblem, idle: 0, armyId: -1, fee: 0, arrears: 0, foe: -1, served: 0, last: world.time.day },
    });
    say(world, band, {
      // only a company of real size is news when it forms (a few dozen veterans are not)
      cat: 'war', imp: strength >= 200 ? 2 : 1, fold: strength < 200, key: 'band.company.formed', civId,
      text: pick(world, [
        `When the levies of ${civName(civ)} were sent home, ${count(strength)} veterans under ${leader.name} would not lay down their arms; they formed ${bandName(band)} and sold their swords to whoever would pay.`,
        `${cap(bandName(band))} was born in the camps of ${civName(civ)}: soldiers with no wish to go back to the plough, ready to fight for any banner.`,
        `${cap(leader.name)} kept ${count(strength)} men under arms after the war, and called them ${bandName(band)}.`,
      ]),
    });
  }
}

// ---------------------------------------------------------------------------
// Hiring and contracts

/** Monthly: free companies look for a realm at war that can pay. */
export function hiring(world) {
  const rng = world.rng;
  const day = world.time.day;
  for (const band of world.bands) {
    if (band.kind !== 'company' || band.state !== 'lair' || band.data.seize || (band.data.noHire || 0) > day) continue;
    const lm = world.f.landmass[tileOf(world, band.x, band.y)];
    let best = null, bs = 0, bd = 0;
    for (const civ of liveCivs(world)) {    // (the living realms, in id order: world.civs holds every realm ever)
      if (!civ || !civ.alive || civ.id === band.data.foe) continue;
      const enemies = enemiesOf(world, civ.id);
      if (!enemies.length) continue;
      const fee = Math.max(2, Math.round(band.strength * FEE));
      if ((civ.treasury || 0) < fee * 6 + band.strength * BOUNTY) continue;
      const cap0 = world.settlements[civ.capitalId];
      if (!cap0) continue;
      const near = nearestSettlement(world, band.x, band.y, { civId: civ.id, maxDist: 60 });
      if (!near || world.f.landmass[near.i] !== lm) continue;
      const d = Math.hypot(near.x - band.x, near.y - band.y);
      // a realm that fights with hired swords (geo/raising.js) looks for them first
      const sc = Math.sqrt(civ.treasury) * (1 + 0.3 * enemies.length) / (1 + d / 20) * (civ.forces && civ.forces.sys === 'hired' ? 3 : 1);
      if (sc > bs) { bs = sc; best = civ; bd = d; }
    }
    if (best && rng.chance(0.5)) hire(world, band, best, bd);
  }
}

function hire(world, band, civ) {
  const day = world.time.day;
  const war = world.wars.find((w) => w && w.active && (w.attackers.includes(civ.id) || w.defenders.includes(civ.id)));
  if (!war) return false;
  const fee = Math.max(2, Math.round(band.strength * FEE));
  const bounty = Math.round(band.strength * BOUNTY);
  const home = nearestSettlement(world, band.x, band.y, { civId: civ.id });
  if (!home) return false;
  const army = createArmy(world, {
    civId: civ.id, x: band.x, y: band.y, homeId: home.id, strength: band.strength, warId: war.id,
    general: band.leader?.name ? { name: band.leader.name, skill: band.leader.skill || 1, born: Number.isFinite(band.leader.born) ? band.leader.born : day - 40 * DAYS_PER_YEAR, wins: 0, battles: 0, honours: 0 } : null,
    state: 'idle', morale: band.morale ?? 1,
  });
  Object.assign(army.flags, { mp: 0, skill: band.leader?.skill || 1, bad: [], nextPlan: day + 5, startStr: band.strength, drawn: 0, merc: band.id });
  army.name = band.name;
  civ.treasury = Math.max(0, (civ.treasury || 0) - bounty);
  band.loot = (band.loot || 0) + bounty;
  band.state = 'hired';
  band.civId = civ.id;
  band.path = null;
  band.targetSid = -1;
  Object.assign(band.data, { armyId: army.id, fee, arrears: 0, since: day, idle: 0, lx: band.x, ly: band.y, lstr: band.strength });
  const st = state(world);
  st.stats.hires++;
  const enemy = world.civs[(war.attackers.includes(civ.id) ? war.defenders : war.attackers)[0]];
  // a company's first contract is news; the ones after it are the trade it lives by
  band.data.hires = (band.data.hires || 0) + 1;
  const first = band.data.hires === 1 && (isTold(band) || (band.strength || 0) >= 200);
  say(world, band, {
    cat: 'war', imp: first ? 2 : 1, fold: !first, key: 'band.hire', civId: civ.id,
    text: pick(world, [
      `${BandName(band)} took service with ${civName(civ)} for ${money(fee)} a month and marched against ${civName(enemy)}.`,
      `${cap(rulerOf(civ))} hired ${bandName(band)} for ${warName(war)}: ${money(bounty)} down and ${money(fee)} a month.`,
      `${CivName(civ)} bought the swords of ${bandName(band)}${band.leader ? `, and ${band.leader.name}` : ', whose captains'} swore to serve until ${warName(war)} was won.`,
    ]),
  });
  return true;
}

/** Monthly: pay, arrears, mutiny, and the end of contracts. */
export function contracts(world) {
  const rng = world.rng;
  for (const band of world.bands.slice()) {
    if (band.kind !== 'company' || band.state !== 'hired') continue;
    const army = armyById(world, band.data.armyId);
    if (!army) continue;                       // syncHired frees the band
    const civ = world.civs[band.civId];
    if (!civ || !civ.alive) { release(world, band, army, 'void'); continue; }
    if (!enemiesOf(world, civ.id).length) { release(world, band, army, 'peace'); continue; }
    const fee = band.data.fee || Math.max(2, Math.round(army.strength * FEE));
    // a stretched treasury pays late even before it is empty
    const late = (civ.treasury || 0) < fee * 12 && rng.chance(0.3);
    if ((civ.treasury || 0) >= fee && !late) { civ.treasury -= fee; band.loot = (band.loot || 0) + fee; band.data.arrears = 0; }
    else {
      band.data.arrears = (band.data.arrears || 0) + 1;
      if (band.data.arrears === 2 && ready(world, `ar${band.id}`, 5 * DAYS_PER_YEAR)) {
        say(world, band, { cat: 'war', imp: 1, fold: true, key: 'band.arrears', civId: civ.id, text: `${BandName(band)} had not been paid for two months, and its captains spoke openly against ${rulerOf(civ)}.` });
      }
    }
    band.data.served = (band.data.served || 0) + 1;
    const greedy = band.leader && /Black|Bloody|Butcher|Bastard/.test(band.leader.name) ? 2 : 1;
    if ((band.data.arrears >= 3 && rng.chance(0.5)) || rng.chance(0.002 * greedy)) mutiny(world, band, army, civ);
  }
}

/** The band takes the field at the army's place with what is left of it. */
function freeAt(world, band, x, y, strength) {
  const i = tileOf(world, x, y);
  band.x = i % world.W; band.y = (i / world.W) | 0;
  band.homeI = i;
  band.strength = Math.max(0, strength);
  band.state = 'lair';
  band.civId = -1;
  band.path = null;
  band.targetSid = -1;
  band.data.armyId = -1;
  band.data.idle = 0;
  band.data.arrears = 0;
  band.data.noHire = world.time.day + 2 * DAYS_PER_MONTH;
}

/** End a contract (peace, the employer's fall): the army is stood down, the company is free. */
export function release(world, band, army, why) {
  const civ = world.civs[band.civId];
  emit(world, 'armyDisbanded', army, why === 'peace' ? 'contract' : 'void');
  removeArmy(world, army.id);
  freeAt(world, band, army.x, army.y, army.strength);
  if ((band.data.served || 0) >= 12 && ready(world, `rel${band.id}`, 10 * DAYS_PER_YEAR)) {
    say(world, band, {
      cat: 'war', imp: 1, fold: true, key: 'band.release', civId: civ ? civ.id : null,
      text: why === 'peace'
        ? pick(world, [`With the war over, ${civName(civ)} paid off ${bandName(band)}, who went looking for another.`, `${BandName(band)} left the service of ${civName(civ)} when peace was made.`])
        : `${BandName(band)} found itself without a master when ${civName(civ)} fell.`,
    });
  }
}

/** Unpaid (or simply treacherous), the company turns on its paymaster. */
function mutiny(world, band, army, civ) {
  const st = state(world);
  emit(world, 'armyDisbanded', army, 'mutiny');
  removeArmy(world, army.id);
  const owed = band.data.arrears || 0;
  freeAt(world, band, army.x, army.y, army.strength);
  band.data.foe = civ.id;
  st.stats.mutinies++;
  // the softest rich town of the old paymaster within reach becomes the prize
  let best = null, bs = 0;
  for (const s of settlementsNear(world, band.x, band.y, 25, (q) => q.civId === civ.id)) {
    const A = attackOf(band), D = townDefence(world, s);
    if (A < 1.1 * D) continue;
    const sc = Math.sqrt(Math.max(1, (s.wealth || 0) + 0.1 * s.population)) * (A / D) / (1 + Math.hypot(s.x - band.x, s.y - band.y) / 8);
    if (sc > bs) { bs = sc; best = s; }
  }
  const entry = say(world, band, {
    cat: 'war', imp: 3, key: 'band.mutiny', civId: civ.id,
    text: owed >= 3
      ? pick(world, [
        `Unpaid for ${count(owed)} months, ${bandName(band)} turned on ${civName(civ)}${best ? ` and marched on ${best.name}` : ''}.`,
        `${cap(rulerOf(civ))} could not pay ${bandName(band)}, and the company that had fought for ${civName(civ)} turned its spears against it.`,
        `${BandName(band)} mutinied for their arrears${band.leader ? `; ${band.leader.name} tore down the banner of ${civName(civ)}` : ''}${best ? ` and led them against ${best.name}` : ''}.`,
      ])
      : pick(world, [
        `${BandName(band)} sold out ${civName(civ)} in the middle of the war${best ? ` and fell upon ${best.name}` : ''}.`,
        `${band.leader ? cap(band.leader.name) : 'The captains of ' + bandName(band)} broke faith with ${civName(civ)}, reckoning there was more to be had by turning than by fighting.`,
      ]),
  });
  if (best && planRoute(world, band, best.i)) {
    band.state = 'settling';
    band.targetSid = best.id;
    band.data.seize = 1;
    band.data.cause = entry ? entry.seq : null;
  }
}

/** Daily for hired companies: march with the army; if it is gone, take the field again. */
export function syncHired(world, band) {
  const army = armyById(world, band.data.armyId);
  if (army) {
    band.x = army.x; band.y = army.y;
    band.strength = Math.max(0, army.strength);
    band.morale = army.morale ?? band.morale;
    band.data.lx = army.x; band.data.ly = army.y; band.data.lstr = army.strength; band.data.lst = army.state === 'returning' ? 1 : 0;
    return;
  }
  // the army is gone: stood down on its way home (or with the war over), or cut to pieces
  const civ = world.civs[band.civId];
  const stoodDown = band.data.lst === 1 || !civ || !civ.alive || !enemiesOf(world, civ.id).length;
  const left = stoodDown ? band.data.lstr ?? band.strength : 0;
  if (!(left >= 10)) {
    if ((band.data.served || 0) >= 3 || (band.raids || 0) > 0) {
      const notable = isTold(band) || (band.data.served || 0) >= 12;
      say(world, band, { cat: 'war', imp: notable ? 2 : 1, fold: !notable, key: 'band.destroyed', civId: civ ? civ.id : null, text: pick(world, [`${BandName(band)} was cut to pieces in the service of ${civName(civ)}.`, `Few of ${bandName(band)} lived to collect their pay from ${civName(civ)}.`]) });
    }
    endBand(world, band, 'destroyed');
    return;
  }
  freeAt(world, band, band.data.lx ?? band.x, band.data.ly ?? band.y, left);
}
