// A war at a glance (chunk 10, docs/design/seeing-and-hand.md): each side's leader and allies,
// the towns it has taken and razed, its fallen and its aim, and the latest named battle. Read by
// the war dossier's "Each side" and the watched war's chip. Pure reads of the war's own records.

import { aimWords } from '../sim/geo/terms.js';
import * as F from './format.js';

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** { att, def, latest } for war: each side { leader, allies, taken, razed, dead, aim }. */
export function warSides(w, war) {
  const t = war.ledger && Array.isArray(war.ledger.t) ? war.ledger.t.filter(Array.isArray) : [];
  const side = (ids, sign) => {
    const set = new Set(ids);
    let leader = null;
    for (const id of ids) { const c = w.civs[id]; if (c && (c.alive || !leader)) { leader = c; if (c.alive) break; } }
    let taken = 0, razed = 0;
    for (const [, , , to, code] of t) if (set.has(to)) { if (code === 'razed' || code === 'x') razed++; else if (code !== 'returned') taken++; }
    let dead = 0;
    for (const id of ids) dead += fin(war.casualties && war.casualties[id]);
    return { leader, allies: Math.max(0, ids.length - 1), taken, razed, dead, aim: aimWords(w, war, sign) || '' };
  };
  let latest = null;
  const b = war.ledger && Array.isArray(war.ledger.b) ? war.ledger.b : [];
  for (let k = b.length - 1; k >= 0; k--) if (Array.isArray(b[k]) && b[k].length >= 7 && b[k][6]) { latest = { day: b[k][0], name: b[k][6], winner: w.civs[b[k][3]] || null }; break; }
  return { att: side(war.attackers || [], 1), def: side(war.defenders || [], -1), latest };
}

/** "the Kingdom of Varn and 2 allies: 3 towns taken, 1 razed, 12,400 fallen". */
export function sideLine(s) {
  const who = s.leader ? `${s.leader.name}${s.allies ? ` and ${s.allies} ${s.allies === 1 ? 'ally' : 'allies'}` : ''}` : 'No one';
  const parts = [`${F.int(s.taken)} ${s.taken === 1 ? 'town' : 'towns'} taken`];
  if (s.razed) parts.push(`${F.int(s.razed)} razed`);
  parts.push(`${F.people(s.dead)} fallen`);
  return `${who}: ${parts.join(', ')}`;
}
