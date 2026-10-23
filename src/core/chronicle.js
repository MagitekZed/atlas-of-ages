// The Chronicle: the world's written history. Systems record notable events here.
//
// entry = { seq, day, cat, imp, text, x, y, civId, sid, icon, ref?, key?, cause?, tags?, fold? }
//   cat  — key of CATEGORIES (constants.js)
//   imp  — importance 1..5:
//          1 local detail  2 notable  3 major (toast)  4 historic  5 epochal (may auto-pause)
//   text — one finished sentence in past tense, e.g.
//          "Settlers from Varath founded Oskel on the banks of the Tiren."
// Optional fields, stored only when set (old entries simply lack them):
//   ref   — { k: REF_KIND, id }: the entity the entry is about (constants.js REF_KINDS)
//   key   — dotted event-type string: 'succession', 'battle.minor', 'pact.nap',
//           'event.great_fire', 'annals.decade', 'record.broken' …
//   cause — seq of the parent entry ("Because …"); chronicle() returns the entry, so a
//           caller can chain: const e = chronicle(w, …); chronicle(w, { …, cause: e.seq })
//   tags  — up to 4 short strings
//   fold  — true marks a routine entry: hidden from the Notable view, toasts and the
//           Director, and counted by the annals digests instead
// Entries are immutable once pushed (keyframes share them by reference). Sim code never reads
// entries to make decisions; only the news filter and digests read them.

const MAX_ENTRIES = 6000;
const KEEP_RECENT = 2000;
const KEEP_PER_SID = 12;
const KEEP_PER_CIV = 24;

// The single news filter (registered by WP1's annals): fn(world, entry) → { imp?, fold? } | null.
// Module-level by design (code, not state): it must be deterministic and pure.
let newsFilter = null;

/**
 * Install (or clear, with null) the deterministic news filter. It runs before push, only for
 * entries that carry a key, and may lower/raise imp or set/clear fold.
 */
export function setNewsFilter(fn) {
  newsFilter = typeof fn === 'function' ? fn : null;
}

/**
 * Write a chronicle entry and return it.
 * e: { text, cat?, imp?, x?, y?, civId?, sid?, icon?, ref?, key?, cause?, tags?, fold? }
 */
/**
 * Realms with plural names take plural verbs in every template ("the Vaunian Clans were…",
 * never "…Clans was"); a kernel pass so no writer has to remember it.
 */
const PLURAL_REALM = /\b(Clans|Tribes|Cities|Provinces) (was|has)\b/;
function agreeText(text) {
  return typeof text === 'string' && PLURAL_REALM.test(text)
    ? text.replace(new RegExp(PLURAL_REALM.source, 'g'), (m, a, v) => `${a} ${v === 'was' ? 'were' : 'have'}`)
    : text;
}

export function chronicle(world, e) {
  const c = world.chronicle;
  const entry = {
    seq: ++c.seq,
    day: world.time.day,
    cat: e.cat || 'civ',
    imp: Math.max(1, Math.min(5, e.imp ?? 2)),
    text: agreeText(e.text),
    x: e.x ?? null,
    y: e.y ?? null,
    civId: e.civId ?? null,
    sid: e.sid ?? null,
    icon: e.icon ?? null,
  };
  if (e.ref && e.ref.k != null) entry.ref = { k: e.ref.k, id: e.ref.id ?? null };
  if (e.key) entry.key = String(e.key);
  if (e.cause != null && Number.isFinite(e.cause)) entry.cause = e.cause;
  if (Array.isArray(e.tags) && e.tags.length) entry.tags = e.tags.slice(0, 4).map(String);
  if (e.fold) entry.fold = true;
  if (entry.key && newsFilter) {
    let r = null;
    try { r = newsFilter(world, entry); } catch (err) { console.error('[chronicle:newsFilter]', err); }
    if (r) {
      if (Number.isFinite(r.imp)) entry.imp = Math.max(1, Math.min(5, Math.round(r.imp)));
      if (r.fold === true) entry.fold = true;
      else if (r.fold === false) delete entry.fold;
    }
  }
  c.entries.push(entry);
  if (c.entries.length > MAX_ENTRIES) prune(c);
  return entry;
}

/**
 * Drop old routine entries. An older entry survives if imp ≥ 2, or it is among the last 12
 * entries for its sid, or among the last 24 for its civId (so every place and people keeps a
 * history); beyond that the oldest are thinned first. Survivors are never edited.
 */
function prune(c) {
  const es = c.entries;
  const cut = es.length - KEEP_RECENT;
  // per-entity retention, counted from the newest entry backwards over the whole log
  const bySid = new Map(), byCiv = new Map();
  const keep = new Uint8Array(cut);
  for (let k = es.length - 1; k >= 0; k--) {
    const e = es[k];
    let held = false;
    if (e.sid != null) { const n = bySid.get(e.sid) || 0; bySid.set(e.sid, n + 1); if (n < KEEP_PER_SID) held = true; }
    if (e.civId != null) { const n = byCiv.get(e.civId) || 0; byCiv.set(e.civId, n + 1); if (n < KEEP_PER_CIV) held = true; }
    if (held && k < cut) keep[k] = 1;
  }
  const older = es.slice(0, cut);
  const recent = es.slice(cut);
  const limit = MAX_ENTRIES - 500;
  let kept = older.filter((e, k) => e.imp >= 2 || keep[k]);
  if (kept.length + recent.length > limit) kept = older.filter((e, k) => e.imp >= 3 || keep[k]);
  if (kept.length + recent.length > limit) kept = kept.slice(kept.length - (limit - recent.length));
  c.entries = kept.concat(recent);
}

/** Entries with seq > sinceSeq, oldest first. */
export function chronicleSince(world, sinceSeq) {
  const es = world.chronicle.entries;
  let lo = 0, hi = es.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (es[mid].seq <= sinceSeq) lo = mid + 1; else hi = mid;
  }
  return es.slice(lo);
}

/** The entry with this seq, or null if pruned / unknown (binary search). */
export function chronicleEntry(world, seq) {
  const es = world.chronicle.entries;
  let lo = 0, hi = es.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, s = es[mid].seq;
    if (s === seq) return es[mid];
    if (s < seq) lo = mid + 1; else hi = mid - 1;
  }
  return null;
}
