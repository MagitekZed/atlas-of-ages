// Every key: the keyboard, mouse and touch card (? at the table, or Every key in the Contents
// and on the title page). The built-in keys stand in six numbered sections; keys and tabs that
// other packages registered (src/ui/registry.js) and that the sections do not already name
// follow under More.

import { h } from './dom.js';
import { openModal } from './widgets.js';
import { listKeys, getTabs, describeKey } from './registry.js';
import { tabOpen } from './app.js';

// A key spec is read word by word: a joiner (+ – / and or) stays plain, *word is a gesture of
// the mouse or a finger, anything else is a key cap.
const JOINERS = new Set(['+', '–', '/', 'and', 'or']);
function keyCell(spec) {
  const cell = h('span.ks-k');
  for (const w of spec.split(' ')) {
    if (JOINERS.has(w)) cell.append(h('span.ks-j', { text: w }));
    else if (w[0] === '*') cell.append(h('i.ks-g', { text: w.slice(1) }));
    else cell.append(h('kbd.kbd', { text: w }));
  }
  return cell;
}

const SECTIONS = [
  ['I', 'Time', [
    ['Space', 'Pause or resume; hold it and drag to pan'],
    ['1 – 6 and 0', 'Slow, Normal, Fast, Faster, Rapid, Max; 0 pauses'],
    ['J', 'Leap ahead: years of history at full speed'],
    ['U', 'Run until something happens; Shift U runs until the same thing happens again'],
    ['Ctrl + Z', 'Undo your last act; add Shift to redo it'],
  ]],
  ['II', 'Map', [
    ['*drag', 'Pan the map; the right or middle button always pans'],
    ['W A S D', 'Pan, as do the arrow keys'],
    ['*wheel or + / −', 'Zoom at the cursor'],
    ['*click', 'Inspect: open its dossier'],
    ['*double-click', 'Zoom in; on a town, dive down to it; on held ground, open its nation'],
    ['*right-click', 'What can be done here'],
    ['F', 'Show the whole world'],
    ['Z', 'Frame the selection'],
    ['M', 'Next map mode; Shift M for the one before'],
    ['Tab', 'With the map focused, walk the largest towns and armies in view; Shift Tab walks back'],
    ['Esc', 'One step back: return to Inspect, leave the past, clear the selection. With nothing to step back from, it opens the Contents'],
    ['H', 'Hide or show the instruments'],
  ]],
  ['III', 'Folios', [
    ['I', 'Dossier'], ['C', 'Chronicle'], ['N', 'Nations'], ['T', 'Statistics'],
    ['R', 'Annals'], ['P', 'World'], ['L', 'Atlas'], ['O', 'Legends, in Legendary and Mythic worlds'],
    ['\\', 'Fold or open the folio'],
    ['/ or Ctrl + K', 'Find anything: places, peoples, wars, commands'],
    ['Ctrl + S', 'Quick save'],
    ['?', 'This card'],
  ]],
  ['IV', 'Tools', [
    ['Q / E', 'Previous or next god tool'],
    ['*click, *drag', 'Use the tool; a brush keeps working while you hold the button'],
    ['[ and ]', 'Shrink or grow the brush'],
    ['Shift + *wheel', 'Brush radius; Alt and the wheel, its strength'],
  ]],
  ['V', 'Touch', [
    ['*drag', 'Pan'], ['*pinch', 'Zoom'], ['*tap', 'Inspect'], ['*long-press', 'What can be done here'],
  ]],
  ['VI', 'Story', [
    ['G', 'The Director: story mode on or off'],
    ['Y', 'The history timeline'],
    ['.', 'Watch or unwatch the selection'],
    ['B', 'Pin this view'],
    ['Shift + 1 – 9', 'Fly to a pinned view'],
  ]],
];
// registered keys the sections above already name (as describeKey writes them)
const NAMED = new Set(['U', 'Shift U', 'Ctrl Z', 'Ctrl Shift Z', 'Q', 'E', 'Z', '/', 'Ctrl K', 'G', 'Y', '.', 'B', 'Shift 1']);
const NAMED_TABS = new Set(['I', 'C', 'N', 'T', 'R', 'P', 'L', 'O']);

function section(n, name, rows) {
  const list = h('div.ks-rows');
  for (const [k, d] of rows) list.append(h('div.ks-row', null, keyCell(k), h('span.ks-d', { text: d })));
  return h('section.ks-sec', null, h('h3.ks-h', null, h('span.ks-n', { text: n }), h('span', { text: name })), list);
}

export function showHelp(app = null) {
  const secs = SECTIONS.map(([n, name, rows]) => section(n, name, rows));
  // what other packages added: their tabs' keys, then their shortcuts by group
  const more = [];
  for (const t of getTabs()) {
    const k = String(t.key || '').toUpperCase();
    if (k && !NAMED_TABS.has(k) && tabOpen(app, t)) more.push([k, t.label]);
  }
  const extra = listKeys().filter((d) => !d.hidden && !NAMED.has(describeKey(d)))
    .sort((a, b) => String(a.group).localeCompare(String(b.group)) || String(a.label).localeCompare(String(b.label)));
  for (const d of extra) more.push([d.display || describeKey(d), d.group && d.group !== 'More' ? `${d.label} (${d.group})` : d.label]);
  if (more.length) secs.push(section('VII', 'More', more));
  const [time, map, folios, tools, touch, story, rest] = secs;
  const body = h('div.ks', null,
    h('div.ks-col', null, time, tools, touch),
    h('div.ks-col', null, map),
    h('div.ks-col', null, folios, story, rest || null));
  const foot = h('p.ks-mac', null, 'On a Mac, ', h('kbd.kbd', { text: 'Ctrl' }), ' is ', h('kbd.kbd', { text: 'Cmd' }), ' and ', h('kbd.kbd', { text: 'Alt' }), ' is ', h('kbd.kbd', { text: 'Option' }));
  openModal({
    kicker: 'Keys · keyboard, mouse and touch', title: 'Every key', cls: 'is-keys',
    lead: 'Press ? at the table to open this card. Space works everywhere but in a text field.',
    body,
    actions: [foot, { label: 'Close', cls: 'btn-brass', onClick: (m) => m.close() }],
  });
}
