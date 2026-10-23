// Save / load. Everything in the world object is saved except `cache` and `fx`.
// Typed-array fields in world.f are base64-encoded with their type name.
// Loading runs normalizeWorld, so saves from before a kernel addition gain its defaults.

import { RNG } from './rng.js';
import { emit } from './hooks.js';
import { normalizeWorld } from './world.js';

export const FIELD_TYPES = { Float32Array, Float64Array, Int32Array, Uint32Array, Int16Array, Uint16Array, Int8Array, Uint8Array, Uint8ClampedArray };
const TYPES = FIELD_TYPES;
/**
 * World keys never written as plain JSON: cache and fx are transient; f and rng are encoded
 * separately. Shared with core/keyframe.js, which skips these plus history, chronicle and ui.
 */
export const SAVE_SKIP = new Set(['cache', 'fx', 'f', 'rng']);
const SKIP = SAVE_SKIP;

export function typedToBase64(arr) {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}
export function base64ToTyped(str, Type) {
  let bytes;
  if (typeof Buffer !== 'undefined') {
    const b = Buffer.from(str, 'base64');
    bytes = new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice();
  } else {
    const bin = atob(str);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  }
  return new Type(bytes.buffer, 0, bytes.byteLength / Type.BYTES_PER_ELEMENT);
}

/** The save's top level, sharing the world's objects (callers stringify it, never edit it). */
function saveShell(world) {
  const out = { format: 'atlas-of-ages', formatVersion: 1 };
  for (const k of Object.keys(world)) {
    if (SKIP.has(k)) continue;
    // pending flags in a fixed key order: which system raised its flag first is not state
    out[k] = k === 'pending' && world.pending && typeof world.pending === 'object' ? sortedKeys(world.pending) : world[k];
  }
  out.rngState = world.rng.state.slice();
  out.fields = {};
  for (const [name, arr] of Object.entries(world.f)) {
    out.fields[name] = { type: arr.constructor.name, data: typedToBase64(arr) };
  }
  return out;
}
function sortedKeys(o) {
  const r = {};
  for (const k of Object.keys(o).sort()) r[k] = o[k];
  return r;
}

/**
 * World → save text (JSON) in a single pass: what JSON.stringify(serializeWorld(world)) gives,
 * without the deep copy. Save paths should use this (with compressText) rather than the object.
 */
export function serializeWorldText(world) {
  return JSON.stringify(saveShell(world));
}

/** World → plain JSON-safe object (a deep copy; safe to edit). */
export function serializeWorld(world) {
  return JSON.parse(serializeWorldText(world));
}

/** Plain object → live world. Systems must then run init(world). */
export function deserializeWorld(obj) {
  if (!obj || obj.format !== 'atlas-of-ages') throw new Error('This file is not an Atlas of Ages world.');
  const world = {};
  for (const k of Object.keys(obj)) {
    if (k === 'fields' || k === 'rngState' || k === 'format' || k === 'formatVersion') continue;
    world[k] = obj[k];
  }
  world.rng = RNG.fromState(obj.rngState);
  world.f = {};
  for (const [name, { type, data }] of Object.entries(obj.fields)) {
    const Type = TYPES[type];
    if (!Type) throw new Error(`Unknown field type ${type}`);
    world.f[name] = base64ToTyped(data, Type);
  }
  world.cache = {};
  world.fx = [];
  world.versions = { ...world.versions };
  for (const k of Object.keys(world.versions)) world.versions[k]++;
  normalizeWorld(world);
  emit(world, 'worldLoaded');
  return world;
}

/** Optional gzip helpers (browser CompressionStream / Node zlib). */
export async function compressJSON(obj) {
  return compressText(JSON.stringify(obj));
}
/** Gzip JSON text already made (e.g. serializeWorldText), skipping another stringify. */
export async function compressText(text) {
  if (typeof CompressionStream === 'undefined') return new TextEncoder().encode(text);
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
export async function decompressJSON(bytes) {
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!isGzip) return JSON.parse(new TextDecoder().decode(bytes));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}
