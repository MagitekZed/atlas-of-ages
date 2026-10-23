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
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ESBUILD = 'esbuild@0.28.2';
const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(root, 'dist');
mkdirSync(join(outDir, 'artifact'), { recursive: true });
const bundlePath = join(outDir, 'bundle.js');

execFileSync('npx', ['--yes', ESBUILD, 'src/main.js', '--bundle', '--format=esm', '--target=es2022',
  '--minify', '--charset=utf8', '--legal-comments=none', `--outfile=${bundlePath}`], { cwd: root, stdio: 'inherit' });

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
