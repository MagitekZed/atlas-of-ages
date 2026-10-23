// Theme: dark by default, a light parchment variant, or follow the system. The choice is
// written as data-theme on <html> (the stylesheet's token blocks key on it) and kept per
// viewer. Canvas code re-reads colour tokens when the 'theme' event fires.

import { getPref, setPref } from './prefs.js';

export function themeChoice() {
  const t = document.documentElement.getAttribute('data-theme');
  return t === 'light' || t === 'dark' ? t : 'system';
}

export function effectiveTheme() {
  const t = themeChoice();
  if (t !== 'system') return t;
  try { return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; } catch (e) { return 'dark'; }
}

let lastEmitted = null;
/** Tell the app the effective theme changed — once per real change, however it was caused. */
function announce(app) {
  const t = effectiveTheme();
  if (t === lastEmitted) return;
  lastEmitted = t;
  app.emit('theme', t);
}

export function setTheme(app, choice) {
  const root = document.documentElement;
  if (choice === 'light' || choice === 'dark') root.setAttribute('data-theme', choice);
  else root.removeAttribute('data-theme');
  setPref('theme', choice === 'system' ? undefined : choice);
  announce(app);
}

export function installThemeWatch(app) {
  const saved = getPref('theme', null);
  const fromUrl = (() => { try { return new URLSearchParams(location.search).get('theme'); } catch (e) { return null; } })();
  if (!fromUrl && (saved === 'light' || saved === 'dark') && themeChoice() === 'system') document.documentElement.setAttribute('data-theme', saved);
  lastEmitted = effectiveTheme();
  try {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => announce(app));
  } catch (e) { /* old browsers: no live updates */ }
  // a host may change data-theme on <html> itself; follow it
  try {
    new MutationObserver(() => announce(app)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  } catch (e) { /* no observer */ }
}
