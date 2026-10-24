// The instrument's glyph set: hand-drawn on a 24-unit grid with one engraved line weight
// (1.6, round caps), drawn in currentColor so every glyph follows the theme. Fills are
// used only for tiny details (eyes, seeds, sparks). Tool icons are looked up by the
// tool's `icon` key, through an alias table, with a lettered medallion as the fallback.
// Glyphs other packages register (src/ui/registry.js registerIcon) are found by their key
// after the built-in set; a built-in key always keeps its own glyph.

import { getIcon, hasIcons } from './registry.js';
import { svgEl } from './dom.js';
import { KIT_ICONS } from './kit-icons.js';

const DOT = (x, y, r = 0.9) => `<circle cx="${x}" cy="${y}" r="${r}" fill="currentColor" stroke="none"/>`;
const WAVES = (y) => `<path d="M2.5 ${y}c1.5 1 3 1 4.4 0s3-1 4.4 0 3 1 4.4 0 3-1 4.4 0"/>`;

export const GLYPHS = {
  // --- tools: terrain -------------------------------------------------------
  inspect: `<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5" stroke-width="2.2"/><path d="M10.5 7.8v1.4M10.5 11.8v1.4M7.8 10.5h1.4M11.8 10.5h1.4" stroke-width="1.2"/>`,
  raise: `<path d="M2.5 20h19"/><path d="M5 20c2.2-5 4.3-7.2 7-7.2s4.8 2.2 7 7.2"/><path d="M12 3v6.5M9.3 5.7L12 3l2.7 2.7"/><path d="M9.5 17.5l1.2-1.6M13.3 15.9l1.4 1.9" stroke-width="1.1"/>`,
  lower: `<path d="M2.5 12.5h3.6c1.6 0 2.4 6.5 5.9 6.5s4.3-6.5 5.9-6.5h3.6"/><path d="M12 2.8v6.2M9.3 6.4L12 9l2.7-2.6"/><path d="M9.2 15.6h5.6" stroke-width="1.1"/>`,
  flatten: `<path d="M2.5 7.5c2-2 4 2 6.3 0s4.3 2 6.4 0 4.3 2 6.3 0"/><path d="M8.8 11.5l3.2 2.3 3.2-2.3"/><path d="M2.5 17.5h19"/><path d="M5.5 17.5v2.3M12 17.5v2.3M18.5 17.5v2.3" stroke-width="1.2"/>`,
  mountain: `<path d="M2 20L9 8l3.8 6.4L15.6 10 22 20z"/><path d="M6.8 11.8l2.2 1.2 1.8-1.3M14.2 12.3l1.4.8 1.2-.9" stroke-width="1.2"/><path d="M11 17.5l1.2 2.5M16.5 16.6l.9 3.4" stroke-width="1.1"/>`,
  sink: `<path d="M12 2.5v5.2M9.8 5.6L12 7.8l2.2-2.2"/>${WAVES(11.2)}<path d="M5 20.5c1.6-3 4-4.8 7-4.8s5.4 1.8 7 4.8" stroke-dasharray="2 2"/>`,
  island: `${WAVES(19)}<path d="M5.5 17.8c1.4-2.6 3.6-4 6.5-4s5.1 1.4 6.5 4"/><path d="M11.6 14c.1-3 .7-5.6 2.2-7.6"/><path d="M13.8 6.4c-1.9-1.3-4.3-1.3-5.9.2M13.8 6.4c.9-1.8 2.8-2.8 4.8-2.3M13.8 6.4c1.9.1 3.4 1.2 3.9 2.9M13.8 6.4c-.4 1.8-1.7 2.9-3.2 3.3"/>`,
  // --- tools: life ------------------------------------------------------------
  bloom: `<path d="M12 21v-7.5"/><path d="M12 16c-3.2 0-5.2-2-5.2-5.2 3.2 0 5.2 2 5.2 5.2zM12 13.5c0-3.2 2-5.2 5.2-5.2 0 3.2-2 5.2-5.2 5.2z"/><path d="M8.5 21h7"/>${DOT(5.5, 4.5)}${DOT(12, 3)}${DOT(18.5, 4)}${DOT(3.8, 9, 0.7)}`,
  forest: `<path d="M7.5 3.2l4 7.3H9l3 5.5H3l3-5.5H3.5z"/><path d="M7.5 16v4"/><circle cx="16.8" cy="10.2" r="4"/><path d="M16.8 14.2V20M15 11.5l1.8 1.5 1.8-2.2" stroke-width="1.1"/><path d="M2.5 20.2h19"/>`,
  herds: `<path d="M4.5 4.5c0 3.2 2 5 4.6 5M19.5 4.5c0 3.2-2 5-4.6 5"/><path d="M9.1 9.5h5.8l-.9 7.2c-.3 1.6-1.2 2.8-2 2.8s-1.7-1.2-2-2.8z"/><path d="M9.2 10.6l-2.7 1.3M14.8 10.6l2.7 1.3"/>${DOT(10.6, 12.4, 0.7)}${DOT(13.4, 12.4, 0.7)}<path d="M11 17.4h2" stroke-width="1.1"/>`,
  predators: `<path d="M8.4 17.3c0-2.6 1.6-4.7 3.6-4.7s3.6 2.1 3.6 4.7c0 1.6-1.5 2.7-3.6 2.7s-3.6-1.1-3.6-2.7z"/><ellipse cx="5.8" cy="11.3" rx="1.5" ry="1.9"/><ellipse cx="9.4" cy="7.6" rx="1.6" ry="2"/><ellipse cx="14.6" cy="7.6" rx="1.6" ry="2"/><ellipse cx="18.2" cy="11.3" rx="1.5" ry="1.9"/><path d="M9.2 4.6l.2-1.4M14.8 4.6l-.2-1.4M5.4 8.4l-.4-1.3M18.6 8.4l.4-1.3" stroke-width="1.2"/>`,
  fish: `<path d="M3 12c2.5-3.4 6-5 9.5-5 2.6 0 4.2 1.4 5.3 3l3.2-2.6v9.2L17.8 14c-1.1 1.6-2.7 3-5.3 3-3.5 0-7-1.6-9.5-5z"/><path d="M10.3 9.4c.9 1.6.9 3.6 0 5.2" stroke-width="1.2"/>${DOT(7.2, 11.2, 0.8)}<path d="M13.5 10.5l1.2 1.5-1.2 1.5" stroke-width="1"/>`,
  wildfire: `<path d="M12 21c-3.5 0-6-2.4-6-5.6 0-3.2 2.4-4.7 3-8.2 1.8 1.2 2.8 3 2.8 4.7.9-.7 1.6-2.2 1.4-4.1 2.5 1.7 4.8 4.5 4.8 7.6 0 3.2-2.5 5.6-6 5.6z"/><path d="M12 21c-1.4 0-2.4-1-2.4-2.4 0-1.6 1.2-2.2 1.6-3.6.9.6 1.4 1.4 1.4 2.2.5-.3.9-.9.9-1.6 1 .8 1.3 1.9 1.3 3 0 1.4-1.1 2.4-2.8 2.4z" stroke-width="1.2"/>`,
  // --- tools: weather ---------------------------------------------------------
  rain: `<path d="M7 14.6a4 4 0 0 1-.6-7.9A5.5 5.5 0 0 1 17 7.2a3.7 3.7 0 0 1 .5 7.4z"/><path d="M8.2 17.5l-1.1 2.8M12.2 17.5l-1.1 2.8M16.2 17.5l-1.1 2.8"/>`,
  drought: `<circle cx="12" cy="8" r="3.1"/><path d="M12 2.4v1.3M12 12.3v1.2M6.4 8h1.3M16.3 8h1.3M8 4l.9.9M15.1 11.1l.9.9M16 4l-.9.9M8.9 11.1L8 12"/><path d="M2.5 16h19"/><path d="M7 16l1.5 2.4-1 2.1M13 16l-1 2 1.5 2.5M17.6 16l1 2.6M10.2 18.3l1.8-.3" stroke-width="1.2"/>`,
  storm: `<circle cx="12" cy="12" r="2.8"/><path d="M9.3 10.9C9.6 6.2 12.6 3.6 17.4 3.6"/><path d="M14.7 13.1c-.3 4.7-3.3 7.3-8.1 7.3"/><path d="M5 8.2c.9-1.6 2-2.7 3.4-3.4M19 15.8c-.9 1.6-2 2.7-3.4 3.4" stroke-width="1.1"/>`,
  blizzard: `<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/><path d="M10 4.5l2 1.8 2-1.8M10 19.5l2-1.8 2 1.8M4.8 10.2l2.6-.6-.8-2.6M19.2 13.8l-2.6.6.8 2.6M4.8 13.8l2.6.6-.8 2.6M19.2 10.2l-2.6-.6.8-2.6" stroke-width="1.2"/>`,
  lightning: `<path d="M7 14.6a4 4 0 0 1-.6-7.9A5.5 5.5 0 0 1 17 7.2a3.7 3.7 0 0 1 .5 7.4"/><path d="M12.6 11.5l-2.6 4.4h3.4l-2.4 4.8" stroke-width="1.8"/>`,
  // --- tools: catastrophe -----------------------------------------------------
  quake: `<path d="M2 12.5h3.2l1.4-3.8 2.4 8.6 2.6-12 2.6 13.2 2-8.4 1.6 2.4H22"/><path d="M3 20.5h4M17 20.5h4M3 3.5h4M17 3.5h4" stroke-width="1"/>`,
  volcano: `<path d="M2.5 20.5l6-9.2h7l6 9.2z"/><path d="M10.5 11.3l-1 3.6 1.3 1.5M13.8 11.3l.8 2.6" stroke-width="1.2"/><path d="M9.6 8.4c-1-1.5 0-3.1 1.5-3.1.3-1.6 2.5-2.1 3.4-.8 1.6-.4 2.8 1 2.2 2.4"/>${DOT(18.8, 4.2, 0.7)}${DOT(7, 5.6, 0.7)}`,
  meteor: `<circle cx="16" cy="16" r="3.4"/><path d="M13.4 13.4L4 4M12.2 16.6L6.6 11M16.6 12.2L11 6.6"/><path d="M14.6 15.2l1.2.8.6-1.4" stroke-width="1"/>`,
  tsunami: `<path d="M2.5 18c2.6 0 3.6-1.6 4.6-4.1C8.6 10.3 11.1 6.8 15.6 6.8c3 0 5 2 5 4.5 0 2-1.5 3.5-3.3 3.5-1.5 0-2.7-1-2.7-2.3 0-1 .8-1.7 1.7-1.7"/>${WAVES(21)}<path d="M9 12.2c1-1.6 2.3-2.6 3.8-3" stroke-width="1.1"/>`,
  flood: `<path d="M5 11.2L12 5l7 6.2"/><path d="M7 9.4v4.3M17 9.4v4.3"/><path d="M10.6 13.5v-2.2h2.8v2.2" stroke-width="1.2"/>${WAVES(15.2)}${WAVES(19.4)}`,
  locusts: `<circle cx="18" cy="9" r="2"/><path d="M16.3 10.1L5.5 15.8"/><path d="M15.2 9.3c-3.1 0-7.1 1.5-9.6 4.1"/><path d="M12 12.4l2.6 4.6-4 2.5M15.7 11.6l-.4 3.1M13.8 12.5l-.9 3"/><path d="M19.2 7.3c.9-2 2.2-3.1 3-3.3" stroke-width="1.2"/>${DOT(4, 5, 0.75)}${DOT(7.5, 3.6, 0.65)}${DOT(5.6, 8.3, 0.6)}`,
  // --- tools: peoples ---------------------------------------------------------
  tribe: `<path d="M12 5.2L4.2 20.5h15.6z"/><path d="M10.3 2.6l3.4 5M13.7 2.6l-3.4 5"/><path d="M12 20.5l-2.4-4.9h4.8z" stroke-width="1.2"/><path d="M7.6 14h1.8M14.6 14h1.8" stroke-width="1"/>`,
  settle: `<path d="M4.5 20.5v-7.3l5-4 5 4v7.3z"/><path d="M8.3 20.5v-3.4h2.4v3.4" stroke-width="1.2"/><path d="M18.2 20.5V4.2"/><path d="M18.2 4.4h3.4l-1.1 1.9 1.1 1.9h-3.4"/><path d="M2.5 20.5h19"/>`,
  prosper: `<path d="M12 21.2V7"/><path d="M12 8.5c-2.1 0-3.1-1.6-3.1-3.6 2.1 0 3.1 1.6 3.1 3.6zM12 8.5c2.1 0 3.1-1.6 3.1-3.6-2.1 0-3.1 1.6-3.1 3.6zM12 12.8c-2.1 0-3.1-1.6-3.1-3.6 2.1 0 3.1 1.6 3.1 3.6zM12 12.8c2.1 0 3.1-1.6 3.1-3.6-2.1 0-3.1 1.6-3.1 3.6zM12 17.1c-2.1 0-3.1-1.6-3.1-3.6 2.1 0 3.1 1.6 3.1 3.6zM12 17.1c2.1 0 3.1-1.6 3.1-3.6-2.1 0-3.1 1.6-3.1 3.6z"/><path d="M12 3.6V2.4" stroke-width="1.1"/>`,
  enlighten: `<path d="M3 8.2c3-1 6-1 9 1 3-2 6-2 9-1v11c-3-1-6-1-9 1-3-2-6-2-9-1z"/><path d="M12 9.2v11"/><path d="M12 2.2v2.4M7.4 3.4l1.1 1.9M16.6 3.4l-1.1 1.9" stroke-width="1.3"/><path d="M5.5 12h3.6M5.5 15h3.6M14.9 12h3.6M14.9 15h3.6" stroke-width="1"/>`,
  unrest: `<path d="M8.2 21.2l4.4-9.4"/><path d="M10.2 12.3l5.2 2.4M10.8 11l5.3 2.4" stroke-width="1.3"/><path d="M14.2 10.6c-1.9-.7-2.6-2.7-1.7-4.8.6.9 1.4 1.4 2.1 1.4-.4-1.4 0-2.7 1-3.8.5 2 2.4 2.8 2.6 4.8.2 1.4-.6 2.4-1.6 2.9" />${DOT(5, 6, 0.7)}${DOT(20, 16.5, 0.7)}`,
  ruin: `<path d="M3.5 20.5h12"/><path d="M6.5 20.5v-10.2M12.5 20.5v-6.3"/><path d="M5 10.3h3l1.2-1.3 1.4 1.8 2.2-1.6.7 1.1v4.2"/><path d="M9.5 20.5v-7" stroke-width="1"/><rect x="16" y="16.6" width="5.2" height="3.9" rx=".6"/><path d="M17.8 16.6v3.9" stroke-width="1"/>`,
  // --- tools: fate ------------------------------------------------------------
  // fate (WP1's Read Its Fate): a spindle with its thread running out
  fate: `<path d="M8 3.5h8M8 20.5h8"/><path d="M9.2 3.5c0 3 5.6 3.2 5.6 6.2s-5.6 3.2-5.6 6.2 5.6 1.6 5.6 4.6"/><path d="M14.8 9.7c1.8.4 3.2 1.4 4.7 3.4" stroke-width="1.2"/>${DOT(19.8, 13.6, 0.8)}`,
  discord: `<path d="M3.5 3.5L14 14M11.5 16.5l5-5M15.4 15.4l3.1 3.1M18 20.5l2.5-2.5"/><path d="M20.5 3.5L10 14M7.5 11.5l5 5M8.6 15.4l-3.1 3.1M3.5 18L6 20.5"/>`,
  harmony: `<path d="M4 20.5C9 17.6 14 11.3 16.2 3.8"/><path d="M7.4 18.1c-2-.5-3-2-3-3.6 1.8 0 3 1.5 3 3.6zM10.4 15.2c-.5-2 0-3.8 1.2-4.8.8 1.7.4 3.6-1.2 4.8zM10.4 15.2c2 .2 3.5 1.3 4 2.8-1.9.3-3.4-.8-4-2.8zM13.5 10.6c-.3-2 .4-3.6 1.6-4.5.6 1.8 0 3.5-1.6 4.5zM13.5 10.6c2 0 3.3 1 3.8 2.4-1.8.4-3.2-.5-3.8-2.4z"/>${DOT(19.5, 4.5, 0.7)}`,
  prophet: `<circle cx="10.5" cy="7.6" r="2"/><path d="M7.9 4.4a3.4 1.3 0 0 1 5.2 0" stroke-width="1.2"/><path d="M6.6 20.5l2.2-9.4h3.4l2.2 9.4z"/><path d="M18 7v13.5"/><path d="M18 2.2v3M16.5 3.7h3" stroke-width="1.3"/><path d="M12.2 13l3.6-1.6" stroke-width="1.2"/>`,
  miracle: `<path d="M11 2.5c.6 4.7 2.3 6.4 7 7-4.7.6-6.4 2.3-7 7-.6-4.7-2.3-6.4-7-7 4.7-.6 6.4-2.3 7-7z"/><path d="M19 15.6c.25 1.6.9 2.25 2.5 2.5-1.6.25-2.25.9-2.5 2.5-.25-1.6-.9-2.25-2.5-2.5 1.6-.25 2.25-.9 2.5-2.5z" stroke-width="1.2"/>${DOT(5, 18.5, 0.8)}${DOT(19.5, 4, 0.7)}`,
  plague: `<circle cx="12" cy="12" r="4.6"/><path d="M12 7.4V4.6M12 19.4v-2.8M7.4 12H4.6M19.4 12h-2.8M8.7 8.7l-2-2M17.3 17.3l-2-2M8.7 15.3l-2 2M17.3 6.7l-2 2"/>${DOT(12, 3.8, 1)}${DOT(12, 20.2, 1)}${DOT(3.8, 12, 1)}${DOT(20.2, 12, 1)}${DOT(6.1, 6.1, 0.9)}${DOT(17.9, 17.9, 0.9)}${DOT(6.1, 17.9, 0.9)}${DOT(17.9, 6.1, 0.9)}${DOT(10.6, 11, 0.8)}${DOT(13.6, 13, 0.7)}`,
  cure: `<path d="M9.4 3h5.2M10.4 3v5.1L5.6 17.6a2 2 0 0 0 1.8 2.9h9.2a2 2 0 0 0 1.8-2.9l-4.8-9.5V3"/><path d="M12 12.4v5M9.5 14.9h5" stroke-width="1.5"/>`,
  // --- interface --------------------------------------------------------------
  play: `<path d="M8 5.2v13.6L18.8 12z" fill="currentColor" stroke-linejoin="round"/>`,
  pause: `<path d="M8.2 5.5v13M15.8 5.5v13" stroke-width="2.6"/>`,
  leap: `<path d="M4.5 3.5h9M4.5 20.5h9"/><path d="M5.8 3.5c0 4.2 3.2 5.4 3.2 8.5s-3.2 4.3-3.2 8.5M12.2 3.5c0 4.2-3.2 5.4-3.2 8.5s3.2 4.3 3.2 8.5"/><path d="M7.4 18.6c.6-1.2 1-1.7 1.6-1.7s1 .5 1.6 1.7z" fill="currentColor" stroke-width="1"/><path d="M15.5 9l3.2 3-3.2 3M18.5 9l3.2 3-3.2 3" stroke-width="1.4"/>`,
  menu: `<path d="M4 7h16M4 12h16M4 17h16"/>`,
  close: `<path d="M6 6l12 12M18 6L6 18"/>`,
  back: `<path d="M14.5 5.5L8 12l6.5 6.5"/>`,
  chevron: `<path d="M6.5 9.5L12 15l5.5-5.5"/>`,
  chevronUp: `<path d="M6.5 14.5L12 9l5.5 5.5"/>`,
  search: `<circle cx="10.5" cy="10.5" r="5.5"/><path d="M14.6 14.6l5 5"/>`,
  target: `<circle cx="12" cy="12" r="6.5"/><path d="M12 2.8v4.4M12 16.8v4.4M2.8 12h4.4M16.8 12h4.4"/>${DOT(12, 12, 1.2)}`,
  follow: `<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="2.6"/><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6"/>`,
  fit: `<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><rect x="8.5" y="8.5" width="7" height="7" rx="1"/>`,
  layers: `<path d="M12 3.5l9 4.6-9 4.6-9-4.6z"/><path d="M3 12.2l9 4.6 9-4.6M3 16.3l9 4.6 9-4.6"/>`,
  save: `<path d="M4 7.5h16v12H4zM3 4h18v3.5H3z"/><path d="M9.5 11.5h5"/>`,
  open: `<path d="M3 6.5h6l2 2h10v10H3z"/><path d="M3 11.5h18"/>`,
  exportFile: `<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/><path d="M12 18v-7M9.2 13.6L12 10.8l2.8 2.8"/>`,
  importFile: `<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/><path d="M12 10.5v7M9.2 14.8l2.8 2.8 2.8-2.8"/>`,
  sun: `<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"/>`,
  moon: `<path d="M19.5 14.8A8 8 0 0 1 9.2 4.5a8 8 0 1 0 10.3 10.3z"/>`,
  help: `<circle cx="12" cy="12" r="9"/><path d="M9.4 9.4a2.7 2.7 0 1 1 3.6 2.5c-.7.3-1 .9-1 1.6v.8"/>${DOT(12, 17.2, 1)}`,
  eye: `<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>`,
  eyeOff: `<path d="M2.5 12S6 5.5 12 5.5c2 0 3.7.7 5 1.6M21.5 12s-3.5 6.5-9.5 6.5c-2 0-3.7-.7-5-1.6"/><path d="M4 20L20 4"/>`,
  newWorld: `<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c-2.6 2.4-3.8 5.2-3.8 8.5s1.2 6.1 3.8 8.5M12 3.5c2.6 2.4 3.8 5.2 3.8 8.5s-1.2 6.1-3.8 8.5"/>`,
  dice: `<rect x="4" y="4" width="16" height="16" rx="3"/>${DOT(8.5, 8.5, 1.2)}${DOT(15.5, 8.5, 1.2)}${DOT(12, 12, 1.2)}${DOT(8.5, 15.5, 1.2)}${DOT(15.5, 15.5, 1.2)}`,
  reset: `<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4v4.6h4.6"/>`,
  trash: `<path d="M4.5 6.5h15M9.5 6.5V4h5v2.5M6.5 6.5l1 14h9l1-14"/><path d="M10 10.5v6.5M14 10.5v6.5" stroke-width="1.2"/>`,
  pin: `<path d="M12 21s-6.5-6.2-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 14.8 12 21 12 21z"/><circle cx="12" cy="9.8" r="2.3"/>`,
  star: `<path d="M12 3.2l2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6-4.5-4.2 6.1-.7z"/>`,
  crown: `<path d="M3.5 17.5l-.9-9.5 5 4.2L12 5l4.4 7.2 5-4.2-.9 9.5z"/><path d="M3.8 20.5h16.4"/>`,
  keyboard: `<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9.3 10h.01M12.6 10h.01M15.9 10h.01M18 10h.01M6 13.6h.01M18 13.6h.01M9 14.2h6" stroke-width="2"/>`,
  // tabs and HUD marks
  chronicle: `<path d="M7 4h11a2 2 0 0 1 2 2v1.5h-3"/><path d="M7 4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9.5a2 2 0 0 0 2-2V7.5"/><path d="M7 4a2 2 0 0 1 2 2v.5"/><path d="M8.5 10.5h7M8.5 13.5h7M8.5 16.5h4.5" stroke-width="1.2"/>`,
  nations: `<path d="M5.5 21V3.5"/><path d="M5.5 4.5h12.5l-3 4 3 4H5.5"/><path d="M3.5 21h4"/>`,
  statistics: `<path d="M4 3.5v16.5h16.5"/><path d="M7.5 15.5l3.5-4.3 3 2.6 5.5-6.6"/>${DOT(19.5, 7.2, 1)}`,
  world: `<path d="M4 6.5h16M4 12h16M4 17.5h16"/><circle cx="9" cy="6.5" r="1.9" fill="var(--icon-knob, transparent)"/><circle cx="15.5" cy="12" r="1.9" fill="var(--icon-knob, transparent)"/><circle cx="7.5" cy="17.5" r="1.9" fill="var(--icon-knob, transparent)"/>`,
  atlas: `<path d="M3 6.5l6-2.2 6 2.2 6-2.2v13.3l-6 2.2-6-2.2-6 2.2z"/><path d="M9 4.3v13.3M15 6.5v13.3"/>`,
  people: `<circle cx="9" cy="7.5" r="2.6"/><path d="M4 19.5c0-3.3 2.2-5.6 5-5.6s5 2.3 5 5.6"/><circle cx="16.5" cy="8.6" r="2.1"/><path d="M15.3 13.9c2.6.1 4.7 2.3 4.7 5.6"/>`,
  war: `<path d="M3.5 3.5L14 14M11.5 16.5l5-5M15.4 15.4l3.1 3.1"/><path d="M20.5 3.5L10 14M7.5 11.5l5 5M8.6 15.4l-3.1 3.1"/>`,
  faith: `<path d="M12 21c-3.3 0-5.6-2.2-5.6-5.2 0-3 2.2-4.4 2.8-7.6 1.7 1.1 2.6 2.8 2.6 4.4.8-.6 1.5-2 1.3-3.8 2.3 1.5 4.5 4.2 4.5 7 0 3-2.3 5.2-5.6 5.2z"/><path d="M12 3v2.4M8.2 4.6l.9 1.4M15.8 4.6l-.9 1.4" stroke-width="1.2"/>`,
  era: `<path d="M7 3.5h10M7 20.5h10M8 3.5c0 4.2 4 5.2 4 8.5s-4 4.3-4 8.5M16 3.5c0 4.2-4 5.2-4 8.5s4 4.3 4 8.5"/><path d="M10 18.2h4" stroke-width="1.3"/>`,
  town: `<path d="M3.5 20.5v-6.5l4-3 4 3v6.5M11.5 20.5V9.5l4.5-4 4.5 4v11"/><path d="M2.5 20.5h19"/><path d="M15 12.5h2M15 15.5h2" stroke-width="1.1"/>`,
  army: `<path d="M6 21V3.5"/><path d="M6 4h10.5l-2.5 3.5 2.5 3.5H6"/><path d="M10 15.5l2 2 4-4.5" stroke-width="1.3"/>`,
  ship: `<path d="M3.5 15.5h17l-2.8 4.5H6.3z"/><path d="M11.5 15.5V3.5l6 9h-6M10 6.5l-4.5 7h4.5"/>`,
};

/** Tool icon keys that other modules may use, mapped onto glyphs. */
const ALIASES = {
  hourglass: 'leap', skip: 'leap', fastforward: 'leap', jump: 'leap',
  select: 'inspect', pointer: 'inspect', magnify: 'inspect',
  up: 'raise', elevate: 'raise', uplift: 'raise', raiseland: 'raise', hill: 'raise',
  down: 'lower', dig: 'lower', erode: 'lower', lowerland: 'lower', basin: 'lower',
  level: 'flatten', smooth: 'flatten', plain: 'flatten', flat: 'flatten',
  ridge: 'mountain', range: 'mountain', mountains: 'mountain', peak: 'mountain',
  drown: 'sink', submerge: 'sink', sea: 'sink',
  isle: 'island', archipelago: 'island',
  grow: 'bloom', greening: 'bloom', fertile: 'bloom', fertility: 'bloom', plant: 'bloom', seed: 'bloom', garden: 'bloom', vegetation: 'bloom',
  tree: 'forest', trees: 'forest', woods: 'forest', reforest: 'forest', grove: 'forest',
  herd: 'herds', animals: 'herds', fauna: 'herds', grazers: 'herds', cattle: 'herds', deer: 'herds', game: 'herds',
  predator: 'predators', wolves: 'predators', wolf: 'predators', hunters: 'predators', beasts: 'predators', paw: 'predators',
  fishes: 'fish', shoal: 'fish', fisheries: 'fish',
  fire: 'wildfire', burn: 'wildfire', ignite: 'wildfire', flame: 'wildfire', blaze: 'wildfire',
  water: 'rain', rainfall: 'rain', cloud: 'rain', clouds: 'rain', wet: 'rain', monsoon: 'rain',
  dry: 'drought', heat: 'drought', parch: 'drought', desert: 'drought', sunburn: 'drought',
  cyclone: 'storm', hurricane: 'storm', typhoon: 'storm', tempest: 'storm', spiral: 'storm',
  snow: 'blizzard', snowstorm: 'blizzard', ice: 'blizzard', cold: 'blizzard',
  thunder: 'lightning', thunderstorm: 'lightning', bolt: 'lightning',
  earthquake: 'quake', seismic: 'quake', tremor: 'quake', shake: 'quake',
  eruption: 'volcano', erupt: 'volcano', lava: 'volcano', magma: 'volcano',
  asteroid: 'meteor', impact: 'meteor', comet: 'meteor', star: 'meteor', fallingstar: 'meteor',
  wave: 'tsunami', megawave: 'tsunami', tidal: 'tsunami',
  deluge: 'flood', inundate: 'flood', overflow: 'flood',
  locust: 'locusts', swarm: 'locusts', insects: 'locusts', pests: 'locusts',
  people: 'tribe', peoples: 'tribe', tent: 'tribe', newtribe: 'tribe', nomads: 'tribe',
  town: 'settle', city: 'settle', found: 'settle', village: 'settle', colony: 'settle', settlement: 'settle',
  prosperity: 'prosper', bounty: 'prosper', harvest: 'prosper', blessing: 'prosper', bless: 'prosper', wheat: 'prosper', abundance: 'prosper',
  wisdom: 'enlighten', research: 'enlighten', knowledge: 'enlighten', golden: 'enlighten', goldenage: 'enlighten', book: 'enlighten', inspire: 'enlighten',
  rebellion: 'unrest', revolt: 'unrest', riot: 'unrest', incite: 'unrest', torch: 'unrest', uprising: 'unrest',
  devastate: 'ruin', raze: 'ruin', destroy: 'ruin', smite: 'ruin', ruins: 'ruin', column: 'ruin',
  hatred: 'discord', war: 'discord', swords: 'discord', strife: 'discord', enmity: 'discord',
  peace: 'harmony', goodwill: 'harmony', olive: 'harmony', concord: 'harmony', amity: 'harmony',
  faith: 'prophet', religion: 'prophet', preacher: 'prophet', messiah: 'prophet', founder: 'prophet',
  wonder: 'miracle', divine: 'miracle', sparkle: 'miracle', fervor: 'miracle', fervour: 'miracle', revival: 'miracle',
  disease: 'plague', pestilence: 'plague', outbreak: 'plague', sickness: 'plague', virus: 'plague',
  heal: 'cure', medicine: 'cure', remedy: 'cure', vaccine: 'cure', healing: 'cure',
  // chronicle entry icons used by the geopolitics modules
  battle: 'war', siege: 'war', capture: 'army', conquest: 'army',
  contact: 'people', firstcontact: 'people', diplomacy: 'harmony', treaty: 'harmony', alliance: 'harmony',
  vassal: 'crown', tribute: 'crown', betrayal: 'discord',
  trade: 'ship', caravan: 'ship', route: 'ship', commerce: 'ship',
};

/**
 * Keys drawn from the Copperplate set (src/ui/kit-icons.js) instead of the older hand-drawn
 * glyphs: an exact key or a resolved one maps to a kit id. Kit ids themselves ('family-land',
 * 'mode-terrain') work too. Keys not listed keep their older glyph until the kit covers them.
 */
const KIT = {
  inspect: 'inspect', play: 'play', pause: 'pause', leap: 'leap', hourglass: 'run-until', undo: 'undo', redo: 'redo', rewind: 'rewind',
  menu: 'menu', close: 'close', back: 'back', search: 'find', target: 'locate', follow: 'follow', pin: 'pin', star: 'watch',
  save: 'save', open: 'load', help: 'help', keyboard: 'keys', eye: 'story', world: 'settings',
  chronicle: 'chronicle', nations: 'nations', statistics: 'figures', atlas: 'atlas', annals: 'annals', codex: 'codex', legends: 'codex', timeline: 'timeline',
  raise: 'tool-raise-land', sink: 'tool-drown-land', forest: 'tool-plant-forest', rain: 'tool-rain', drought: 'tool-drought',
  lightning: 'tool-lightning', quake: 'tool-earthquake', tsunami: 'tool-tsunami', settle: 'tool-found-town',
  discord: 'tool-incite-war', harmony: 'tool-forge-alliance', prosper: 'tool-bless',
  storm: 'storm', volcano: 'volcano', ruin: 'ruin', plague: 'plague', town: 'town', army: 'army', ship: 'fleet', caravan: 'caravan',
};
function kitId(key) {
  if (!key) return null;
  const raw = String(key);
  if (KIT[raw]) return KIT[raw];
  if (KIT_ICONS[raw]) return raw;
  const g = resolveGlyph(key);
  return g && KIT[g] ? KIT[g] : null;
}
const KIT_OPEN = (size, cls) => `<svg class="glyph kit${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true" focusable="false">`;

const SVG_OPEN = (size, cls) => `<svg class="glyph${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">`;

/** Resolve an icon key (exact, alias, or a known key inside a compound like "tool-quake"). */
export function resolveGlyph(key) {
  if (!key) return null;
  if (KIT_ICONS[key]) return key;
  const k = String(key).toLowerCase().replace(/[\s_-]+/g, '');
  if (GLYPHS[key]) return key;
  const reg = hasIcons();
  if (reg && getIcon(key) != null) return key;
  if (GLYPHS[k]) return k;
  if (ALIASES[k]) return ALIASES[k];
  for (const part of String(key).toLowerCase().split(/[\s_-]+/)) {
    if (GLYPHS[part]) return part;
    if (ALIASES[part]) return ALIASES[part];
  }
  if (reg) {
    if (getIcon(k) != null) return k;
    for (const part of String(key).toLowerCase().split(/[\s_-]+/)) if (getIcon(part) != null) return part;
  }
  return null;
}

/** SVG markup for a glyph; null when unknown. */
export function glyph(key, size = 20, cls = '') {
  const k = kitId(key);
  if (k) return KIT_OPEN(size, cls) + KIT_ICONS[k] + '</svg>';
  const g = resolveGlyph(key);
  if (!g) return null;
  const inner = GLYPHS[g] ?? getIcon(g);
  return inner != null ? SVG_OPEN(size, cls) + inner + '</svg>' : null;
}

/** Element for a glyph (or a lettered medallion when the key is unknown). Known glyphs are parsed once and cloned. */
export function iconEl(key, { size = 20, label = '', cls = '' } = {}) {
  const markup = glyph(key, size, cls);
  if (markup) return svgEl(markup);
  const letter = (label || String(key || '?')).trim().charAt(0).toUpperCase() || '?';
  return svgEl(SVG_OPEN(size, cls + ' glyph-fallback') +
    `<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="10.3" stroke-width="0.8" stroke-dasharray="1.2 1.8"/>` +
    `<text x="12" y="16" text-anchor="middle" font-size="11" font-family="IM Fell English SC, Georgia, serif" fill="currentColor" stroke="none">${letter.replace(/[<>&"]/g, '')}</text></svg>`);
}
