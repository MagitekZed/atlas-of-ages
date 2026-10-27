// Veterans and regiments (chunk 2, docs/design/war-machine.md): experience won in battle and on
// the drill field, standing regiments with names and histories, and levies who come home as
// veterans.
//
// Experience: every company that fought gains (+0.08 for the victors, +0.04 for the beaten who
// lived); a standing regiment at home drills toward 0.5. Veterans: the survivors of a levy go home
// counted in their realm's forces.vets (fading 5 % a year as they age), and the next levy takes
// them into its ranks, raising its experience (up to +0.3). Regiments (raising.js keeps them):
// named for their realm, its seat, its ruler or its era; a regiment whose company did most to win
// a named battle earns that battle as an honour ("the Second Lancers of Oskel, of Varn Ford"); one
// cut down covering a beaten army's retreat makes a last stand the Chronicle remembers; the first
// regiment a realm raises, an honour and the end of a regiment with honours are written down.
// Texts are picked by hash; no rng is drawn here.
//
// Exports: regimentName, displayName, battleExperience, drill, veteransHome, levyXp, noteFirstRegiment

import { chronicle } from '../../core/chronicle.js';
import { on } from '../../core/hooks.js';
import { DAYS_PER_YEAR } from '../../core/constants.js';
import { clamp01 } from '../../core/util.js';
import { civName, capFirst, capitalOf, eraOf, hashPick, rateOk, ordinalWord } from './common.js';
import { roleName, gearTier, ROLE } from './army.js';

const capWord = (s) => s.replace(/^./, (c) => c.toUpperCase());
const VET_FADE = Math.pow(0.95, 1 / 12);   // a month's share of veterans still fit to serve

/** A new regiment's name, from the realm, its seat, its ruler and the age. */
export function regimentName(world, civ, f, role) {
  f.raised ||= [0, 0, 0, 0, 0, 0, 0];
  const n = ++f.raised[role];
  const cap = capitalOf(world, civ);
  const seat = cap ? cap.name : civ.baseName || civ.name;
  const tier = gearTier(civ);
  const word = capWord(roleName(role, tier));
  const ord = capWord(ordinalWord(n));
  const era = eraOf(civ);
  const g = civ.ruler && civ.ruler.gender === 'f' ? 'Queen' : 'King';
  const forms = [`the ${ord} ${word} of ${seat}`, `the ${seat} ${word}`];
  if (era === 3 && (role === ROLE.SPEAR || role === ROLE.BLADE)) forms.push(`the ${ord} Legion`, `the ${ord} Legion of ${seat}`);
  if (role === ROLE.HHORSE || role === ROLE.LHORSE) forms.push(`the ${g}'s ${role === ROLE.HHORSE && tier >= 3 ? 'Lancers' : 'Horse'}`, `the ${ord} ${civ.adjective || ''} Horse`.replace('  ', ' '));
  if (role === ROLE.BLADE || role === ROLE.SPEAR) forms.push(`the ${g}'s Guard`, `the ${civ.adjective || seat} Guard`);
  if (role === ROLE.BOW) forms.push(`the ${seat} ${tier >= 4 ? 'Musketeers' : tier >= 3 ? 'Crossbows' : 'Bowmen'}`);
  if (role === ROLE.ENG) forms.push(`the ${seat} ${tier >= 4 ? 'Gunners' : 'Sappers'}`);
  // the guards and the king's own are raised once; later regiments of the role take numbers
  const name = n === 1 ? hashPick(forms, civ.id, role, world.time.day) : forms[0];
  return f.regs.some((r) => r.name === name) ? `the ${ord} ${word} of ${seat}` : name;
}

/** A regiment's name with its first honour (a battlefield): "the Second Lancers of Oskel, of Varn Ford". */
export function displayName(r) {
  const h = Array.isArray(r.honours) && r.honours.length ? r.honours[0] : null;
  return h ? `${r.name}, of ${h}` : r.name;
}

const regOf = (civ, id) => (civ && civ.forces && Array.isArray(civ.forces.regs) ? civ.forces.regs.find((r) => r.id === id) : null);

/**
 * After a battle: experience for every company that fought, the regiments' records, an honour for
 * the regiment that did most to win a named battle, and the last stands of regiments cut down.
 * powW: each of the victor's companies' share of its power (same order as its co).
 */
export function battleExperience(world, ctx) {
  const { W, L, coW, coL, cw, cl, bname, site, before, powW, entry } = ctx;
  for (const c of coW) if (c[1] > 0) c[4] = Math.min(1, c[4] + 0.08);
  for (const c of coL) if (c[1] > 0) c[4] = Math.min(1, c[4] + 0.04);
  for (const c of coW) { const r = c[5] != null ? regOf(cw, c[5]) : null; if (r) { r.battles = (r.battles | 0) + 1; r.won = (r.won | 0) + 1; } }
  for (const c of coL) { const r = c[5] != null ? regOf(cl, c[5]) : null; if (r) r.battles = (r.battles | 0) + 1; }
  // an honour: the victor's regiment that carried the day in a battle men named
  if (bname && powW) {
    let best = -1, bp = 0;
    for (let k = 0; k < coW.length; k++) if (coW[k][5] != null && powW[k] > bp) { bp = powW[k]; best = k; }
    const r = best >= 0 && bp >= 0.25 ? regOf(cw, coW[best][5]) : null;
    if (r) {
      (r.honours ||= []).push(site || bname);   // the place: "the Second Lancers of Oskel, of Varn Ford"
      if (r.honours.length > 6) r.honours.length = 6;
      if (rateOk(world, `honour:${cw.id}`, 10 * DAYS_PER_YEAR)) {
        chronicle(world, {
          cat: 'war', imp: 1, x: W.x, y: W.y, civId: cw.id, icon: 'army', key: 'regiment.honour', ref: { k: 'civ', id: cw.id }, tags: ['regiment'], ...(entry ? { cause: entry.seq } : {}),
          text: hashPick([
            `${capFirst(r.name)} carried the day at ${bname.replace(/^the /i, 'the ')}, and bore its name ever after.`,
            `For their part in ${bname.replace(/^the /i, 'the ')}, ${r.name} of ${civName(cw)} were given the battle as an honour.`,
          ], r.id, cw.id, world.time.day),
        });
      }
    }
  }
  // last stands: a regiment of the beaten side cut down to a handful
  {
    for (let k = 0; k < coL.length; k++) {
      const c = coL[k];
      if (c[5] == null || !(c[1] < 20) || !(before[k] >= 150)) continue;
      const r = regOf(cl, c[5]);
      if (!r || !rateOk(world, `stand:${cl.id}`, 15 * DAYS_PER_YEAR)) continue;
      chronicle(world, {
        cat: 'war', imp: 2, x: L.x, y: L.y, civId: cl.id, icon: 'army', key: 'regiment.laststand', ref: { k: 'civ', id: cl.id }, tags: ['regiment'], ...(entry ? { cause: entry.seq } : {}),
        text: hashPick([
          `${capFirst(displayName(r))} stood to the last ${bname ? `at ${bname.replace(/^the /i, 'the ')}` : 'on the field'}, covering the retreat of ${civName(cl)}; few of them lived.`,
          `${capFirst(displayName(r))} would not give ground ${bname ? `at ${bname.replace(/^the /i, 'the ')}` : ''}, and died where they stood so that the rest of the ${civName(cl)} host could get away.`.replace('  ', ' '),
        ], r.id, cl.id, world.time.day),
      });
    }
  }
}

/** A standing regiment at home drills toward its ceiling (0.5) a little each month. */
export function drill(f) {
  for (const r of f.regs) if (r.out == null && r.xp < 0.5) r.xp = Math.min(0.5, r.xp + 0.008);
  f.vets = (f.vets || 0) * VET_FADE;
}

/** A levy's survivors come home as veterans (their experience counts them). */
export function veteransHome(world, civ, army, levyMen) {
  if (!civ || !civ.forces || !(levyMen > 0)) return;
  let xp = 0, n = 0;
  for (const c of Array.isArray(army.co) ? army.co : []) if (c[5] == null) { xp += c[4] * c[1]; n += c[1]; }
  const avg = n > 0 ? xp / n : 0.1;
  civ.forces.vets = (civ.forces.vets || 0) + levyMen * clamp01(avg * 2);
}

/** A new levy of `str` men: veterans join it (they leave the pool); its experience (0.1–0.4). */
export function levyXp(civ, str) {
  const f = civ && civ.forces;
  if (!f || !(f.vets > 1) || !(str > 0)) return 0.1;
  const join = Math.min(f.vets, str * 0.5);
  f.vets -= join;
  return 0.1 + 0.3 * clamp01(join / str * 2);
}

/** The first regiment a realm raises is written down. */
export function noteFirstRegiment(world, civ, reg) {
  const f = civ.forces;
  if (f.firstReg) return;
  f.firstReg = world.time.day;
  const cap = capitalOf(world, civ);
  chronicle(world, {
    cat: 'civ', imp: 1, x: cap ? cap.x : null, y: cap ? cap.y : null, civId: civ.id, sid: cap ? cap.id : null, icon: 'army', key: 'regiment.raised', ref: { k: 'civ', id: civ.id }, tags: ['regiment'],
    text: `${capFirst(civName(civ))} raised its first standing regiment, ${reg.name}.`,
  });
}

// a regiment with honours that is disbanded, or lost in the field, is remembered
on('regimentDisbanded', (world, civ, reg, why) => {
  if (!civ || !reg || !(reg.honours && reg.honours.length) || !rateOk(world, `regEnd:${civ.id}`, 10 * DAYS_PER_YEAR)) return;
  const cap = capitalOf(world, civ);
  chronicle(world, {
    cat: 'civ', imp: 1, x: cap ? cap.x : null, y: cap ? cap.y : null, civId: civ.id, sid: cap ? cap.id : null, icon: 'army', key: 'regiment.disbanded', ref: { k: 'civ', id: civ.id }, tags: ['regiment'],
    text: `${capFirst(displayName(reg))} ${why === 'cost' ? 'was disbanded, for the crown could no longer pay it' : 'was disbanded when the old army was given up'}; its colours were laid up in ${cap ? cap.name : 'the capital'}.`,
  });
});
