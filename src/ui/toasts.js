// Toasts: notable chronicle entries surface as clickable slips that focus the map. Which
// entries toast is the viewer's choice per category (Notices, prefs.getNotices: off, epochal,
// historic, major — the default — or all). The stream is metered in real time so a busy age
// never floods the screen: historic entries (4–5) always show, ordinary ones draw from a
// small token bucket, and the rest are folded into one digest slip that keeps count and
// opens the Chronicle. At Rapid and Max speed only epochal entries (5) toast when "quiet at
// speed" is on (else historic ones queue), and the digest restarts its count every half
// minute so its date stays current. Routine entries (fold: true) never toast. Registered
// toast filters (src/ui/registry.js) may suppress an entry or mark it watched: a watched
// entry of importance 2 or more shows as a gilded slip (class is-watched) outside the meter.
// Pausing for great events belongs to the Notices' pause rules (until.js); without them the
// old "pause on epochal events" switch still applies. Status toasts (tool feedback, saves,
// errors) use one slot; action cards (actionToast: deeds, undo, arrivals) stand apart.
// Offers (offerToast: sound, the Director) are one-time suggestions: one at a time, the rest
// wait their turn, and none while a deed card is telling what the hand just did.
// When time stops by itself (an epochal event, a Notices rule, a run until), pauseAlert tells a
// viewer who may be elsewhere: a chime (audio.js, its own switch in Notices, heard with the
// soundscape off and the tab hidden), "⏸ Paused" in the tab's title until time runs again, and
// a desktop notification while the tab is hidden. Desktop notifications are asked for afresh on
// every visit, the first time time runs (app.pauseDesktop is never saved), and are used only
// after a yes in this visit, whatever the browser still remembers.

import { CATEGORIES } from '../core/constants.js';
import { chronicleSince } from '../core/chronicle.js';
import { h, clear, svgEl, setText } from './dom.js';
import { glyph, resolveGlyph } from './icons.js';
import { monthYear, int } from './format.js';
import { getToastFilters, toastVerdict } from './registry.js';
import { getNotices, noticeMin } from './prefs.js';

const MAX_VISIBLE = 4;
const LIFE = { 3: 7000, 4: 10000, 5: 15000 };
const BUCKET_MAX = 2;          // ordinary major toasts that may burst at once
const BUCKET_REFILL_MS = 4500; // one more allowed every few seconds
const GREAT_PER_TICK = 2;      // historic toasts shown per refresh; the rest join the digest
const FAST_SPEED = 5;          // speed index from which historic (4) entries also queue
const DIGEST_SPAN_MS = 30000;  // a digest older than this is replaced by a fresh one
const MAX_WATCHED = 3;         // gilded slips (watched entries) visible at once
const MAX_CARDS = 3;           // action cards (deeds, undo notices, arrivals) visible at once
export const CAT_ICON = {
  civ: 'nations', war: 'war', diplomacy: 'harmony', religion: 'faith', disease: 'plague', tech: 'enlighten',
  culture: 'miracle', trade: 'ship', nature: 'forest', climate: 'rain', disaster: 'volcano', divine: 'miracle',
};

export function entryIcon(e) {
  return (e.icon && resolveGlyph(e.icon)) || CAT_ICON[e.cat] || 'chronicle';
}

let root = null;
let statusEl = null, statusTimer = 0;

export function mountToasts(app) {
  root = document.getElementById('toasts');
  let lastSeq = 0;
  let tokens = BUCKET_MAX, refillAt = performance.now();
  let digest = null;   // { el, text, n, fromDay, timer, born }

  const reset = () => { tokens = BUCKET_MAX; refillAt = performance.now(); digest = null; };
  app.on('world', (w) => { lastSeq = w.chronicle.seq; clear(root); statusEl = null; reset(); restoreTitle(); });
  // time running again clears the paused title; the first run of a visit offers desktop notices
  app.on('speed', (k) => { if (k !== 0) { restoreTitle(); offerDesktop(app); } });
  app.on('historySkipped', () => {
    if (app.world) lastSeq = app.world.chronicle.seq;
    for (const t of root.querySelectorAll('.toast:not(.is-status):not(.is-card)')) t.remove();
    reset();
  });
  let notices = getNotices();
  app.on('notices', () => { notices = getNotices(); });
  app.on('tick', () => {
    const w = app.world;
    if (!w || w.chronicle.seq === lastSeq) return;
    if (app.fastForwarding) { lastSeq = w.chronicle.seq; return; }
    const fresh = chronicleSince(w, lastSeq);
    lastSeq = w.chronicle.seq;
    const filtered = getToastFilters().length > 0;
    const fast = app.speed >= FAST_SPEED;
    const major = [], watched = [];
    let epochal = null, quiet = 0, quietDay = null;
    for (const e of fresh) {
      if (e.fold) continue;
      if (e.imp >= 5) epochal = e;
      const v = filtered ? toastVerdict(app, e) : null;
      if (v?.suppress) continue;
      if (v?.watched && e.imp >= 2) { watched.push(e); continue; }
      const min = noticeMin(notices, e.cat);
      if (min <= 0 || e.imp < min) continue;
      // quiet at speed: only epochal entries interrupt a fast run; the rest join the digest
      if (fast && notices.quietFast && e.imp < 5) { quiet++; if (quietDay == null) quietDay = e.day; continue; }
      major.push(e);
    }
    for (const e of watched.slice(-MAX_WATCHED)) pushEntry(app, e, { watched: true });
    if (quiet) addToDigest(quiet, quietDay);
    if (!major.length) { if (epochal) autoPause(epochal); return; }
    const nowT = performance.now();
    while (tokens < BUCKET_MAX && nowT - refillAt >= BUCKET_REFILL_MS) { tokens++; refillAt += BUCKET_REFILL_MS; }
    if (tokens >= BUCKET_MAX) refillAt = nowT;
    const greatImp = fast ? 5 : 4;
    const great = major.filter((e) => e.imp >= greatImp).sort((a, b) => b.imp - a.imp || a.seq - b.seq);
    const show = great.slice(0, GREAT_PER_TICK);
    let folded = great.length - show.length;
    for (const e of major) {
      if (e.imp >= greatImp) continue;
      if (tokens > 0) { tokens--; show.push(e); } else folded++;
    }
    show.sort((a, b) => a.seq - b.seq);
    for (const e of show) pushEntry(app, e);
    if (folded > 0) addToDigest(folded, major[0].day);
    if (epochal) autoPause(epochal);
  });

  function autoPause(epochal) {
    if (app.pauseRulesArmed) return;   // the Notices' pause rules (until.js) decide
    if (app.autoPause && app.speed !== 0) {
      app.pause();
      statusToast(app, 'Time paused for an epochal event. Press Space to continue.', 'info', { icon: 'pause' });
      pauseAlert(app, epochal ? epochal.text : 'An epochal event');
    }
  }

  function addToDigest(n, day) {
    if (digest && performance.now() - digest.born > DIGEST_SPAN_MS) { clearTimeout(digest.timer); dismiss(digest.el); digest = null; }
    if (digest && digest.el.isConnected && !digest.el.classList.contains('is-leaving')) {
      digest.n += n;
      clearTimeout(digest.timer);
    } else {
      const text = h('p.text');
      const el = h('div.toast.is-digest', { role: 'button', tabindex: '0' },
        h('span.ico', null, svgEl(glyph('chronicle', 16))),
        h('div.meta', null, h('span.cat', { text: 'Chronicle' }), h('span.since')),
        h('span'),
        text,
      );
      const open = () => { app.setTab('chronicle'); app.emit('layout', 'open-panel'); dismiss(el); digest = null; };
      el.addEventListener('click', open);
      el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } });
      root.append(el);
      digest = { el, text, n, fromDay: day, timer: 0, born: performance.now() };
    }
    setText(digest.el.querySelector('.since'), 'since ' + monthYear(digest.fromDay));
    setText(digest.text, `${int(digest.n)} more major event${digest.n === 1 ? ' was' : 's were'} recorded. Open the Chronicle to read them.`);
    const el = digest.el;
    digest.timer = setTimeout(() => { if (digest?.el === el) digest = null; dismiss(el); }, 9000);
    trim();
  }
}

// ---------------------------------------------------------------------------
// Time stopped by itself: the chime, the tab's title, a desktop notification

let baseTitle = null;
const PAUSE_MARK = '⏸ ';

/** Tell a viewer who may be looking elsewhere that time stopped for `text`. */
export function pauseAlert(app, text) {
  const line = String(text || 'Time paused').replace(/\s+/g, ' ').trim();
  if (getNotices().pauseChime) app.sound?.chime?.();
  if (baseTitle == null) baseTitle = document.title.startsWith(PAUSE_MARK) ? 'Atlas of Ages' : document.title;
  const short = line.length > 70 ? line.slice(0, 67).replace(/\s+\S*$/, '') + '…' : line;
  document.title = `${PAUSE_MARK}Paused: ${short} · ${baseTitle}`;
  if (app.pauseDesktop && document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const note = new Notification('Atlas of Ages: time paused', { body: line, tag: 'atlas-pause' });
      note.onclick = () => { try { window.focus(); } catch (e) { /* the browser decides */ } note.close(); };
    } catch (e) { /* notifications unavailable here */ }
  }
}

function restoreTitle() {
  if (baseTitle != null && document.title.startsWith(PAUSE_MARK)) document.title = baseTitle;
}

/**
 * Turn desktop notifications on or off for this visit only. Turning them on asks the browser
 * when it has not been asked; resolves to whether they are on.
 */
export async function setPauseDesktop(app, on) {
  app.pauseDesktop = false;
  if (!on || typeof Notification === 'undefined') return false;
  let perm = Notification.permission;
  if (perm === 'default') { try { perm = await Notification.requestPermission(); } catch (e) { perm = 'denied'; } }
  app.pauseDesktop = perm === 'granted';
  if (perm === 'denied') statusToast(app, 'This browser blocks notifications from Atlas. Allow them in the site settings to use them.', 'warn', { icon: 'pause' });
  return app.pauseDesktop;
}

let desktopAsked = false;
/** Once per visit, the first time time runs: ask whether to notify the desktop when it pauses. */
function offerDesktop(app) {
  if (desktopAsked || !app.world || app.fastForwarding) return;
  desktopAsked = true;
  if (typeof Notification === 'undefined' || Notification.permission === 'denied' || !getNotices().pauseRules.length) return;
  offerToast(app, {
    icon: 'pause', kicker: 'Notices', title: 'Tell you when time pauses?',
    text: 'If you let history run in another tab, a desktop notification can tell you when it stops for something great. Asked each visit; nothing is kept.',
    ms: 14000,
    actions: [{ label: 'Notify me this visit', primary: true, run: () => { setPauseDesktop(app, true); } }, { label: 'Not now', run: () => {} }],
  });
}

/** A phone's column: few slips at a time, so the map stays in view (one beside an offer card). */
const isPhone = () => { try { return window.matchMedia('(max-width: 600px)').matches; } catch (e) { return false; } };

/** Keep at most MAX_VISIBLE chronicle slips: newest are on top, so the oldest (last) go first; the digest stays. */
function trim() {
  const phone = isPhone();
  const offerUpNow = phone && root.querySelector('.toast.is-offer:not(.is-leaving)');
  const max = phone ? (offerUpNow ? 1 : 2) : MAX_VISIBLE;
  const list = Array.from(root.querySelectorAll('.toast:not(.is-status):not(.is-leaving):not(.is-digest):not(.is-watched):not(.is-card)'));
  const digestN = root.querySelector('.toast.is-digest:not(.is-leaving)') ? 1 : 0;
  while (list.length && list.length + digestN > Math.max(1, max)) dismiss(list.pop());
  // watched slips stand outside the meter, but never more than a few at once
  const gilded = Array.from(root.querySelectorAll('.toast.is-watched:not(.is-leaving)'));
  while (gilded.length > (phone ? 1 : MAX_WATCHED)) dismiss(gilded.pop());
}

function dismiss(el) {
  if (!el || el.classList.contains('is-leaving')) return;
  el.classList.add('is-leaving');
  setTimeout(() => el.remove(), 230);
}

function lifetime(el, ms) {
  let left = ms, t0 = performance.now(), timer = setTimeout(() => dismiss(el), left);
  el.addEventListener('pointerenter', () => { clearTimeout(timer); left -= performance.now() - t0; });
  el.addEventListener('pointerleave', () => { t0 = performance.now(); timer = setTimeout(() => dismiss(el), Math.max(1500, left)); });
}

function pushEntry(app, e, { watched = false } = {}) {
  const cat = CATEGORIES[e.cat] || { label: e.cat, color: 'var(--brass)' };
  const close = h('button.icon-btn.x', { type: 'button', 'aria-label': 'Dismiss' }, svgEl(glyph('close', 14)));
  const el = h('div.toast', { class: `imp-${e.imp}${watched ? ' is-watched' : ''}`, role: 'button', tabindex: '0', style: { '--c': cat.color }, 'aria-label': e.text },
    h('span.ico', null, svgEl(glyph(entryIcon(e), 16))),
    h('div.meta', null, h('span.cat', { text: cat.label }), h('span', { text: monthYear(e.day) })),
    close,
    h('p.text', { text: e.text }),
  );
  const go = () => { focusEntry(app, e); dismiss(el); };
  el.addEventListener('click', (ev) => { if (ev.target.closest('.x')) { dismiss(el); return; } go(); });
  el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
  root.prepend(el);
  trim();
  lifetime(el, LIFE[e.imp] || 7000);
}

/** Does a chronicle entry point at something on the map? */
export const entryHasPlace = (app, e) => Boolean(app.world && ((e.sid != null && app.world.settlements[e.sid]) || (e.civId != null && app.world.civs[e.civId]) || (e.x != null && e.y != null)));

/**
 * Select and focus whatever a chronicle entry is about. opts.openTab (default true) also
 * switches the panel to the Inspector; lists that should stay put pass false.
 */
export function focusEntry(app, e, opts = {}) {
  const w = app.world;
  if (!w) return;
  const o = { focus: true, openTab: opts.openTab !== false };
  if (e.sid != null && w.settlements[e.sid]) app.select({ kind: 'settlement', id: e.sid }, o);
  else if (e.civId != null && w.civs[e.civId] && e.x == null) app.select({ kind: 'civ', id: e.civId }, o);
  else if (e.x != null && e.y != null) {
    const x = Math.round(e.x), y = Math.round(e.y);
    if (x >= 0 && y >= 0 && x < w.W && y < w.H) app.select({ kind: 'tile', id: y * w.W + x, x, y }, o);
  } else if (e.civId != null && w.civs[e.civId]) app.select({ kind: 'civ', id: e.civId }, o);
}

/** One-line status message (tool feedback, saves, notices). kind: ok | warn | error | info. opts.onClick makes it a button. */
export function statusToast(app, text, kind = 'info', { icon = null, ms = 4200, onClick = null } = {}) {
  if (!root) root = document.getElementById('toasts');
  if (!root) return;
  if (statusEl) { statusEl.remove(); statusEl = null; }
  clearTimeout(statusTimer);
  const ico = icon || (kind === 'error' ? 'help' : kind === 'warn' ? 'help' : kind === 'ok' ? 'star' : 'chronicle');
  const el = h('div.toast.is-status', { class: kind === 'error' ? 'is-error' : '', role: kind === 'error' ? 'alert' : 'status' },
    h('span.ico', { style: { '--c': kind === 'error' ? 'var(--danger)' : kind === 'warn' ? 'var(--warn)' : 'var(--verdigris)' } }, svgEl(glyph(ico, 15) || glyph('star', 15))),
    h('p.text', { text }),
  );
  if (onClick) {
    el.classList.add('is-action');
    el.tabIndex = 0;
    const go = () => { onClick(); dismiss(el); };
    el.addEventListener('click', go);
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
  }
  root.prepend(el);
  statusEl = el;
  statusTimer = setTimeout(() => { if (statusEl === el) statusEl = null; dismiss(el); }, kind === 'error' ? Math.max(ms, 7000) : ms);
}

/**
 * A card in the toast column with buttons (deeds, undo notices, arrivals). Outside the meter.
 * opts: { icon, color, kicker, title, text, actions: [{ label, run, primary? }], ms, cls, onClick }
 * Returns { el, update({ kicker?, title?, text? }), close() }.
 */
export function actionToast(app, { icon = 'chronicle', color = null, kicker = '', title = '', text = '', actions = [], ms = 9000, cls = '', onClick = null } = {}) {
  if (!root) root = document.getElementById('toasts');
  if (!root) return { el: null, update() {}, close() {} };
  const kEl = h('span.cat', { text: kicker });
  const tEl = h('b.card-title', { text: title, hidden: !title });
  const xEl = h('p.text', { text });
  const close = h('button.icon-btn.x', { type: 'button', 'aria-label': 'Dismiss' }, svgEl(glyph('close', 14)));
  const row = h('div.card-actions', { hidden: !actions.length });
  const el = h('div.toast.is-card', { class: cls, role: 'status', style: color ? { '--c': color } : null },
    h('span.ico', null, svgEl(glyph(icon, 16) || glyph('star', 16))),
    h('div.meta', null, kEl),
    close,
    h('div.card-body', null, tEl, xEl),
    row,
  );
  for (const a of actions) {
    const b = h('button.btn.btn-sm', { type: 'button', class: a.primary ? 'btn-brass' : '', text: a.label });
    b.addEventListener('click', (ev) => { ev.stopPropagation(); try { a.run?.(); } catch (e) { app.reportError('toast.action', e); } if (a.keep !== true) dismiss(el); });
    row.appendChild(b);
  }
  close.addEventListener('click', (ev) => { ev.stopPropagation(); dismiss(el); });
  if (onClick) {
    el.classList.add('is-clickable');
    el.addEventListener('click', (ev) => { if (ev.target.closest('button')) return; onClick(); });
  }
  root.prepend(el);
  if (ms > 0) lifetime(el, ms);
  const cards = Array.from(root.querySelectorAll('.toast.is-card:not(.is-leaving)'));
  while (cards.length > (isPhone() ? 2 : MAX_CARDS)) dismiss(cards.pop());
  trim();
  return {
    el,
    update({ kicker: k, title: t, text: x } = {}) {
      if (k != null) setText(kEl, k);
      if (t != null) { setText(tEl, t); tEl.hidden = !t; }
      if (x != null) setText(xEl, x);
    },
    close() { dismiss(el); },
  };
}

const offers = [];        // queued offers: { opts, card, cancelled }
let offerUp = null, offerTimer = 0;
const showing = (el) => Boolean(el && el.isConnected && !el.classList.contains('is-leaving'));
/**
 * A one-time suggestion card (actionToast options; class is-offer). Only one offer is on screen
 * at a time and none while a deed card is up; the others wait. Returns { close() }, which also
 * takes a waiting offer out of the queue.
 */
export function offerToast(app, opts) {
  const item = { opts, card: null, cancelled: false };
  offers.push(item);
  pumpOffers(app);
  return { close() { item.cancelled = true; item.card?.close(); }, get shown() { return showing(item.card?.el); } };
}
function pumpOffers(app) {
  clearTimeout(offerTimer); offerTimer = 0;
  if (offerUp && !showing(offerUp.card?.el)) offerUp = null;
  while (offers.length && offers[0].cancelled) offers.shift();
  if (!offers.length) return;
  if (!root) root = document.getElementById('toasts');
  if (!offerUp && !root?.querySelector('.toast.is-deed:not(.is-leaving)')) {
    const item = offers.shift();
    item.card = actionToast(app, { ...item.opts, cls: `${item.opts.cls || ''} is-offer`.trim() });
    offerUp = item;
  }
  if (offers.length) offerTimer = setTimeout(() => pumpOffers(app), 1000);
}
