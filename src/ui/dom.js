// A tiny DOM toolkit for the instrument panels: an element builder, text that only
// touches the DOM when it changes, binders that refresh live values in place, and a few
// timing helpers. All text goes in through textContent; only trusted, hand-written SVG
// (icons.js) is ever parsed as markup, and each distinct glyph only once.

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * h('button.btn.primary#go', { onclick, title, dataset: {k: v}, style: {...}, attrs }, ...children)
 * Children: strings/numbers → text, Nodes, arrays (flattened), null/false skipped.
 */
export function h(spec, props = null, ...children) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(spec) || [null, spec, ''];
  const el = document.createElement(m[1] || 'div');
  if (m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g) || []) {
      if (part[0] === '.') el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
  }
  if (props) applyProps(el, props);
  append(el, children);
  return el;
}

function applyProps(el, props) {
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') { for (const c of String(v).split(/\s+/)) if (c) el.classList.add(c); }
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv;
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v; // trusted, hand-written markup only
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
}

export function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
  return el;
}

/** Parse trusted SVG markup (from icons.js) into an element. Each distinct markup is parsed once and cloned after. */
const svgCache = new Map();
export function svgEl(markup) {
  if (markup == null) return null;
  let proto = svgCache.get(markup);
  if (!proto) {
    const t = document.createElement('template');
    t.innerHTML = markup.trim();
    proto = t.content.firstElementChild;
    if (!proto) return null;
    if (svgCache.size > 600) svgCache.clear();
    svgCache.set(markup, proto);
  }
  return proto.cloneNode(true);
}

export function svgNode(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Set textContent only when it differs (avoids layout churn at 4 Hz). */
export function setText(el, value) {
  const s = value == null ? '' : String(value);
  if (el.textContent !== s) el.textContent = s;
}

/** Fraction 0..1 → CSS custom property used by meter bars. */
export function setMeter(el, v) {
  const f = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
  const s = (f * 100).toFixed(1) + '%';
  if (el.style.getPropertyValue('--v') !== s) el.style.setProperty('--v', s);
}

/**
 * Binder: collects live bindings for one view and refreshes them in place.
 *   b.text(el, () => value)       b.meter(el, () => 0..1)
 *   b.attr(el, 'title', fn)       b.toggle(el, 'is-on', () => bool)
 *   b.list(container, () => items, keyOf, render)  — rebuilt only when keys change
 *   b.run(fn)                     — arbitrary per-refresh work
 */
export class Binder {
  constructor() { this.items = []; }
  text(el, fn) { this.items.push({ k: 0, el, fn, last: undefined }); return el; }
  meter(el, fn) { this.items.push({ k: 1, el, fn, last: undefined }); return el; }
  attr(el, name, fn) { this.items.push({ k: 2, el, fn, name, last: undefined }); return el; }
  toggle(el, cls, fn) { this.items.push({ k: 3, el, fn, name: cls, last: undefined }); return el; }
  hide(el, fn) { this.items.push({ k: 4, el, fn, last: undefined }); return el; }
  run(fn) { this.items.push({ k: 5, fn }); }
  list(container, itemsFn, keyOf, render) {
    this.items.push({ k: 6, el: container, fn: itemsFn, keyOf, render, last: null });
    return container;
  }
  update() {
    for (const it of this.items) {
      let v;
      try { v = it.fn(); } catch (e) { v = undefined; }
      switch (it.k) {
        case 0: if (v !== it.last) { it.last = v; setText(it.el, v ?? '—'); } break;
        case 1: if (v !== it.last) { it.last = v; setMeter(it.el, v); } break;
        case 2: if (v !== it.last) { it.last = v; if (v == null) it.el.removeAttribute(it.name); else it.el.setAttribute(it.name, v); } break;
        case 3: if (v !== it.last) { it.last = v; it.el.classList.toggle(it.name, Boolean(v)); } break;
        case 4: if (v !== it.last) { it.last = v; it.el.hidden = Boolean(v); } break;
        case 5: break;
        case 6: {
          const items = Array.isArray(v) ? v : [];
          const sig = items.map(it.keyOf).join('|');
          if (sig !== it.last) {
            it.last = sig;
            clear(it.el);
            items.forEach((item, k) => {
              try { const node = it.render(item, k); if (node) it.el.appendChild(node); } catch (e) { console.error('[ui:list]', e); }
            });
          }
          break;
        }
      }
    }
  }
}

/** Debounce: run fn once, ms after the last call. */
export function debounce(fn, ms) {
  let t = null;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...a); }, ms); };
  d.cancel = () => { clearTimeout(t); t = null; };
  d.flush = (...a) => { clearTimeout(t); t = null; fn(...a); };
  return d;
}

/** Resolve after the browser has painted at least once. Never hangs: hidden tabs do not paint, so a timeout backs it up. */
export function nextFrame(maxMs = 150) {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    if (isHidden()) { yieldTask().then(fin); return; }
    try { requestAnimationFrame(() => requestAnimationFrame(fin)); } catch (e) { fin(); return; }
    setTimeout(fin, maxMs);
  });
}

/** Resolve at the next animation frame (one paint), or promptly when the page is hidden. */
export function oneFrame(maxMs = 100) {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    if (isHidden()) { yieldTask().then(fin); return; }
    try { requestAnimationFrame(fin); } catch (e) { fin(); return; }
    setTimeout(fin, maxMs);
  });
}

/** Yield to the event loop without timer clamping (timers are throttled to 1 s in background tabs). */
const yieldQueue = [];
let yieldChannel = null;
export function yieldTask() {
  return new Promise((resolve) => {
    if (!yieldChannel) {
      try {
        yieldChannel = new MessageChannel();
        yieldChannel.port1.onmessage = () => { const r = yieldQueue.shift(); if (r) r(); };
      } catch (e) { yieldChannel = false; }
    }
    if (!yieldChannel) { setTimeout(resolve, 0); return; }
    yieldQueue.push(resolve);
    yieldChannel.port2.postMessage(0);
  });
}

export const isHidden = () => { try { return document.visibilityState === 'hidden'; } catch (e) { return false; } };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read a CSS custom property from :root (canvas drawing follows the theme tokens). */
export function cssVar(name, fallback = '#888') {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch (e) { return fallback; }
}

/** True when the user asked for less motion. */
export const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
};

/** Phone and portrait-tablet layout (bottom sheet, compact HUD), also on screens too short for the side panel. Matches the CSS breakpoint. */
export const isCompact = () => {
  try { return window.matchMedia('(max-width: 900px), (max-height: 520px)').matches; } catch (e) { return false; }
};

/** Focus the first focusable element in a container. */
export function focusFirst(root) {
  const el = root.querySelector('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])');
  if (el) el.focus({ preventScroll: true });
}

/** Is a keyboard event aimed at a text-entry control? */
export function isTyping(e) {
  const t = e.target;
  if (!t || !t.tagName) return false;
  if (t.isContentEditable) return true;
  if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  if (t.tagName === 'INPUT') return !['range', 'checkbox', 'radio', 'button', 'submit'].includes(t.type);
  return false;
}
