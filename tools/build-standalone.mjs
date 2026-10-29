#!/usr/bin/env node
// Build single-file versions of the app (all modules + CSS inlined into one HTML page; the
// CSS is styles.css plus every <link rel="stylesheet" href="src/ui/css/….css"> in index.html):
//   "Atlas of Ages.html"         opens by double-click (inline module scripts need no server)
//   dist/artifact/index.html     the same page as a fragment for publishing as a Claude Artifact
//                                (the host supplies <!doctype>, <html>, <head> and <body>)
//
//   node tools/build-standalone.mjs
//
// Bundling uses esbuild through npx (downloaded into the npm cache, nothing added to the project).

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ESBUILD = 'esbuild@0.28.2';
const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(root, 'dist');
mkdirSync(join(outDir, 'artifact'), { recursive: true });
const bundlePath = join(outDir, 'bundle.js');

execFileSync('npx', ['--yes', ESBUILD, 'src/main.js', '--bundle', '--format=esm', '--target=es2022',
  '--minify', '--charset=utf8', '--legal-comments=none', `--outfile=${bundlePath}`], { cwd: root, stdio: 'inherit' });

// A loop of imports among modules with a top-level await (or that import one) loads in a browser,
// which skips a module still in the loop, but in the bundle each such module starts up as an
// async function awaiting the ones it imports in order. A loop that comes back to a module before
// its first await finds nothing to wait on and goes on; one that comes back after it has paused
// waits on it forever: the page stays on "Preparing the instruments…" with no error. Read the
// start-up order from an unminified build and refuse to write a page that would hang.
const checkPath = join(outDir, 'bundle-check.js');
execFileSync('npx', ['--yes', ESBUILD, 'src/main.js', '--bundle', '--format=esm', '--target=es2022',
  '--charset=utf8', '--log-level=warning', `--outfile=${checkPath}`], { cwd: root, stdio: 'inherit' });
const loops = startupLoops(readFileSync(checkPath, 'utf8'));
rmSync(checkPath);
if (loops.length) {
  console.error('The bundle would hang at start-up: these modules await each other in a loop (break one import in each):');
  for (const l of loops) console.error('  ' + l.join(' → '));
  process.exit(1);
}

/**
 * Loops among the bundle's async module start-ups (esbuild's `init_x = __esm({ async "path"() {
 * await init_y(); … } })`) that would hang: one that goes through some module's second or later
 * await, after it has paused. Each as a list of paths, the late step first.
 */
function startupLoops(code) {
  const path = new Map(), waits = new Map();   // init → its awaited start-ups, in order
  const re = /var (init_[\w$]+) = __esm\(\{\n\s*(async )?"([^"]+)"\(\) \{([\s\S]*?)\n {2}\}\n\}\);/g;
  for (let m; (m = re.exec(code));) {
    path.set(m[1], m[3]);
    if (m[2]) waits.set(m[1], [...new Set([...m[4].matchAll(/await (init_[\w$]+)\(\)/g)].map((x) => x[1]))]);
  }
  /** A chain of awaits from a back to b, or null. */
  const chain = (a, b) => {
    const prev = new Map([[a, null]]), queue = [a];
    while (queue.length) {
      const n = queue.shift();
      if (n === b) { const out = []; for (let x = n; x != null; x = prev.get(x)) out.unshift(x); return out; }
      for (const d of waits.get(n) || []) if (waits.has(d) && !prev.has(d)) { prev.set(d, n); queue.push(d); }
    }
    return null;
  };
  const out = [];
  for (const [x, ds] of waits) {
    ds.forEach((y, i) => {
      if (i === 0 || !waits.has(y)) return;
      const back = chain(y, x);
      if (back) out.push([x, ...back].map((n) => path.get(n)));
    });
  }
  return out;
}

// "</script" inside the bundle would end the inline element early.
const js = readFileSync(bundlePath, 'utf8').replace(/<\/(script)/gi, '<\\/$1');
const css = readFileSync(join(root, 'styles.css'), 'utf8').replace(/<\/(style)/gi, '<\\/$1');
const html = readFileSync(join(root, 'index.html'), 'utf8');

const swap = (src, re, replacement, label) => {
  if (!re.test(src)) throw new Error(`index.html: could not find ${label}`);
  return src.replace(re, () => replacement);
};
let page = swap(html, /<link rel="stylesheet" href="styles\.css">/, `<style>\n${css}\n</style>`, 'styles.css link');
// the packages' own stylesheets (src/ui/css/*.css), each inlined where index.html links it
page = page.replace(/<link rel="stylesheet" href="(src\/ui\/css\/[\w.-]+\.css)">/g, (m, href) => {
  const text = readFileSync(join(root, href), 'utf8').replace(/<\/(style)/gi, '<\\/$1');
  return `<style data-src="${href}">\n${text}\n</style>`;
});
if (/<link rel="stylesheet" href="(?!https?:)/.test(page)) throw new Error('index.html: a local stylesheet link was left un-inlined');
page = swap(page, /<script type="module" src="src\/main\.js"><\/script>/, `<script type="module">\n${js}\n</script>`, 'main.js script');
writeFileSync(join(root, 'Atlas of Ages.html'), page);

// Artifact fragment: drop doctype/html/head/body wrappers and the charset/viewport metas.
const head = page.match(/<head[^>]*>([\s\S]*?)<\/head>/i)[1]
  .replace(/<meta\s+charset[^>]*>/gi, '')
  .replace(/<meta\s+name="viewport"[^>]*>/gi, '')
  .trim();
const body = page.match(/<body[^>]*>([\s\S]*)<\/body>/i)[1].trim();
const lang = (page.match(/<html[^>]*\blang="([^"]+)"/i) || [])[1];
const fragment = [head, lang ? `<script>document.documentElement.lang=${JSON.stringify(lang)};</script>` : '', body]
  .filter(Boolean).join('\n');
writeFileSync(join(outDir, 'artifact', 'index.html'), fragment + '\n');

const kb = (s) => `${(Buffer.byteLength(s) / 1024).toFixed(0)} KB`;
console.log(`Atlas of Ages.html: ${kb(page)}  ·  dist/artifact/index.html: ${kb(fragment)}`);
