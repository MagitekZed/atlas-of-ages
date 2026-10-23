// Per-viewer conveniences (theme, last tab, overlays, brush sizes) in localStorage.
// Storage may be missing or throw (private windows, sandboxed hosts, thumbnails), so
// every access is guarded and the app behaves identically without it.

const KEY = 'atlas-of-ages:prefs:v1';
let cache = null;

function load() {
  if (cache) return cache;
  cache = {};
  try {
    const raw = window.localStorage?.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object') cache = v;
    }
  } catch (e) { /* storage unavailable */ }
  return cache;
}

export function getPref(key, fallback = null) {
  const v = load()[key];
  return v === undefined ? fallback : v;
}

export function setPref(key, value) {
  const p = load();
  if (value === undefined) delete p[key]; else p[key] = value;
  try { window.localStorage?.setItem(KEY, JSON.stringify(p)); } catch (e) { /* storage unavailable */ }
}

/** Query-string options (testing hooks and shareable views). */
export function urlOptions() {
  try {
    const q = new URLSearchParams(window.location.search);
    const out = {};
    for (const [k, v] of q) out[k] = v;
    return out;
  } catch (e) { return {}; }
}

// --- Notices (story package): how the chronicle reaches the viewer -------------------------
// { cat: { [category]: minImp (0 = off, 2 all, 3 major, 4 historic, 5 epochal) },
//   pauseRules: [{ id, args }]  run-until conditions armed during live play (until.js),
//   quietFast: bool              at Rapid and Max only epochal entries toast,
//   badgeAfterLeap: bool         a leap clears the Chronicle's unread badge }

const NOTICES_KEY = 'story.notices';
export const NOTICE_LEVELS = [[0, 'Off'], [5, 'Epochal'], [4, 'Historic'], [3, 'Major'], [2, 'All']];

/** The viewer's notice settings, with defaults (and the old single auto-pause switch folded in). */
export function getNotices() {
  const saved = getPref(NOTICES_KEY, null);
  const n = saved && typeof saved === 'object' ? { ...saved } : {};
  n.cat = n.cat && typeof n.cat === 'object' ? { ...n.cat } : {};
  if (!Array.isArray(n.pauseRules)) n.pauseRules = getPref('autoPause', true) === false ? [] : [{ id: 'epochal', args: {} }];
  if (typeof n.quietFast !== 'boolean') n.quietFast = true;
  if (typeof n.badgeAfterLeap !== 'boolean') n.badgeAfterLeap = true;
  return n;
}

export function setNotices(n) { setPref(NOTICES_KEY, n); }

/** The least importance a category's entries need to toast (default 3: major). */
export function noticeMin(notices, cat) {
  const v = notices?.cat?.[cat];
  return Number.isFinite(v) ? v : 3;
}
