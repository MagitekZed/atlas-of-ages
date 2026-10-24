// Theme: Atlas of Ages has one look, dark (Copperplate). The light parchment theme was retired
// with the game UI overhaul; these exports stay so callers keep working, and any data-theme a
// host sets on <html> is ignored. Canvas code still re-reads colour tokens on 'theme'.

export function themeChoice() { return 'dark'; }

export function effectiveTheme() { return 'dark'; }

/** Kept for old callers: there is only one theme. */
export function setTheme(app) { app?.emit?.('theme', 'dark'); }

export function installThemeWatch() {
  document.documentElement.removeAttribute('data-theme');
}
