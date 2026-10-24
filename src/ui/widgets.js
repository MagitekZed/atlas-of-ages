// Shared widgets: tooltips, popovers, modal dialogs and confirmations (alert/confirm/prompt
// are unavailable in sandboxed hosts), the staged progress overlay, and the slider /
// parameter controls (range, select, bool and text) used by both the Genesis screen and the
// World tab. Closing a popover also closes any tooltip it raised.

import { h, clear, svgEl, nextFrame, focusFirst } from './dom.js';
import { glyph } from './icons.js';
import { paramValue } from './format.js';

// ---------------------------------------------------------------------------
// Tooltips: any element with data-tip (and optional data-tip-title) gets one on
// hover and keyboard focus.

let tipEl = null, tipFor = null, tipTimer = null;
let quietFocus = null;   // an anchor getting focus back from its popover: no tooltip for that

export function installTooltips() {
  tipEl = document.getElementById('tooltip');
  if (!tipEl) return;
  const show = (target) => {
    const text = target.getAttribute('data-tip');
    if (!text) return;
    tipFor = target;
    clear(tipEl);
    const title = target.getAttribute('data-tip-title');
    if (title) tipEl.appendChild(h('b', { text: title }));
    tipEl.appendChild(document.createTextNode(text));
    const key = target.getAttribute('data-tip-key');
    if (key) { tipEl.appendChild(document.createTextNode(' ')); tipEl.appendChild(h('kbd', { text: key })); }
    tipEl.hidden = false;
    place(target);
  };
  const place = (target) => {
    const r = target.getBoundingClientRect();
    const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let x = r.left + r.width / 2 - tw / 2;
    let y = r.top - th - 8;
    if (y < 8) y = r.bottom + 8;
    if (y + th > vh - 8) y = Math.max(8, vh - th - 8);
    x = Math.max(8, Math.min(vw - tw - 8, x));
    tipEl.style.left = x + 'px';
    tipEl.style.top = y + 'px';
  };
  const hide = () => { clearTimeout(tipTimer); tipFor = null; if (tipEl) tipEl.hidden = true; };
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const t = e.target.closest?.('[data-tip]');
    if (!t) return;
    if (t === tipFor) return;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => show(t), 380);
  });
  document.addEventListener('pointerout', (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (t && !t.contains(e.relatedTarget)) hide();
  });
  document.addEventListener('focusin', (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (t && t === quietFocus) { quietFocus = null; return; }   // focus handed back as a popover closes
    if (t && t.matches(':focus-visible')) show(t);
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', hide, true);
  window.addEventListener('blur', hide);
}

/** Hide the tooltip now (a popover or menu closing takes its tooltip along). */
export function hideTooltip() {
  clearTimeout(tipTimer);
  tipFor = null;
  if (tipEl) tipEl.hidden = true;
}

/** Is a popover open (the context menu and palettes close it before opening their own)? */
export const popoverOpen = () => Boolean(openPop);

export function tip(el, text, title = '', key = '') {
  if (text) el.setAttribute('data-tip', text); else el.removeAttribute('data-tip');
  if (title) el.setAttribute('data-tip-title', title); else el.removeAttribute('data-tip-title');
  if (key) el.setAttribute('data-tip-key', key); else el.removeAttribute('data-tip-key');
  if (!el.getAttribute('aria-label') && (title || text)) el.setAttribute('aria-label', title || text);
  return el;
}

// ---------------------------------------------------------------------------
// Icon buttons

export function iconButton(icon, label, onclick, { cls = '', key = '', tipText = '' } = {}) {
  const b = h('button.icon-btn', { type: 'button', class: cls, 'aria-label': label, onclick });
  const g = glyph(icon, 18);
  if (g) b.appendChild(svgEl(g));
  tip(b, tipText || label, tipText ? label : '', key);
  return b;
}

// ---------------------------------------------------------------------------
// Popovers anchored to a button; close on outside click / Escape.

let openPop = null;
export function closePopover() {
  if (!openPop) return;
  const p = openPop; openPop = null;
  hideTooltip();   // a tooltip raised by the popover's anchor or contents goes with it
  p.el.remove();
  p.anchor?.setAttribute('aria-expanded', 'false');
  p.onClose?.();
}

export function openPopover(anchor, content, { align = 'start', side = 'auto', cls = '', onClose = null } = {}) {
  if (openPop && openPop.anchor === anchor) { closePopover(); return null; }
  closePopover();
  const el = h('div.popover', { class: cls, role: 'dialog' }, content);
  document.body.appendChild(el);
  anchor.setAttribute('aria-expanded', 'true');
  const r = anchor.getBoundingClientRect();
  const pw = el.offsetWidth, ph = el.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let x = align === 'end' ? r.right - pw : r.left;
  x = Math.max(8, Math.min(vw - pw - 8, x));
  const below = r.bottom + 6, above = r.top - ph - 6;
  let y = side === 'above' ? above : side === 'below' ? below : (below + ph > vh - 8 && above > 8 ? above : below);
  y = Math.max(8, Math.min(vh - ph - 8, y));
  el.style.left = x + 'px'; el.style.top = y + 'px';
  el.style.position = 'fixed';
  openPop = { el, anchor, onClose };
  setTimeout(() => focusFirst(el), 0);
  return el;
}

document.addEventListener('pointerdown', (e) => {
  if (!openPop) return;
  if (openPop.el.contains(e.target) || openPop.anchor.contains(e.target)) return;
  closePopover();
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openPop) { e.stopPropagation(); const a = openPop.anchor; closePopover(); quietFocus = a?.closest?.('[data-tip]') || null; a?.focus?.(); setTimeout(() => { quietFocus = null; }, 0); }
}, true);

// ---------------------------------------------------------------------------
// Modals

const modalStack = [];

export function openModal({ title, body, actions = [], small = false, onClose = null, kicker = '', lead = '', cls = '' }) {
  const root = document.getElementById('modal-root') || document.body;
  const prevFocus = document.activeElement;
  const closeBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Close' });
  closeBtn.appendChild(svgEl(glyph('close', 18)));
  const titleId = 'modal-title-' + (modalStack.length + 1);
  const foot = h('div.modal-foot');
  // a plate: a running head (kicker, rule, Esc), then the title and an italic lead
  const head = kicker
    ? h('div.modal-head.is-plate', null,
      h('div.modal-rh', null, h('span.mh-kind', { text: kicker }), h('span.mh-rule'), h('kbd.kbd', { text: 'Esc' }), closeBtn),
      h('h2', { id: titleId, text: title }),
      lead ? h('p.modal-lead', { text: lead }) : null)
    : h('div.modal-head', null, h('h2', { id: titleId, text: title }), closeBtn);
  const box = h('div.modal', { class: `${small ? 'is-small' : ''} ${cls}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    head,
    h('div.modal-body', null, body),
    foot,
  );
  const scrim = h('div.modal-scrim', null, box);
  const m = {
    el: scrim, box,
    close(result) {
      const k = modalStack.indexOf(m);
      if (k < 0) return;
      modalStack.splice(k, 1);
      scrim.remove();
      document.removeEventListener('keydown', onKey, true);
      try { prevFocus?.focus?.({ preventScroll: true }); } catch (e) { /* element gone */ }
      onClose?.(result);
    },
    setActions(list) {
      clear(foot);
      foot.hidden = !list.length;
      for (const a of list) {
        if (a instanceof Node) { foot.appendChild(a); continue; }   // a foot of the caller's own
        const b = h('button.btn', { type: 'button', class: a.cls || '', text: a.label, onclick: () => a.onClick?.(m) });
        if (a.disabled) b.disabled = true;
        foot.appendChild(b);
      }
    },
  };
  const onKey = (e) => {
    if (modalStack[modalStack.length - 1] !== m) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); m.close(false); }
    if (e.key === 'Tab') {
      const f = Array.from(box.querySelectorAll('button:not([disabled]), input:not([disabled]), select, textarea, [href], [tabindex]:not([tabindex="-1"])')).filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  closeBtn.addEventListener('click', () => m.close(false));
  scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) m.close(false); });
  document.addEventListener('keydown', onKey, true);
  m.setActions(actions);
  root.appendChild(scrim);
  modalStack.push(m);
  setTimeout(() => focusFirst(box.querySelector('.modal-body')) || focusFirst(box), 0);
  return m;
}

export const modalOpen = () => modalStack.length > 0;

/** In-page confirmation. Resolves true/false. */
export function confirmDialog({ title, text, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const m = openModal({
      title, small: true,
      body: h('p', { text }),
      onClose: (r) => finish(Boolean(r)),
      actions: [
        { label: cancelLabel, onClick: (mm) => mm.close(false) },
        { label: confirmLabel, cls: danger ? 'btn-danger' : 'btn-brass', onClick: (mm) => mm.close(true) },
      ],
    });
    setTimeout(() => m.box.querySelector('.modal-foot .btn:last-child')?.focus(), 0);
  });
}

/** In-page text prompt. Resolves the string or null. */
export function promptDialog({ title, label, value = '', confirmLabel = 'Save' }) {
  return new Promise((resolve) => {
    const id = 'prompt-' + Math.round(performance.now());
    const input = h('input.field', { id, type: 'text', value, maxlength: 80, autocomplete: 'off' });
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const m = openModal({
      title, small: true,
      body: h('div', null, h('label.gen-label', { for: id, text: label }), input),
      onClose: (r) => finish(r === true ? input.value.trim() || null : null),
      actions: [
        { label: 'Cancel', onClick: (mm) => mm.close(false) },
        { label: confirmLabel, cls: 'btn-brass', onClick: (mm) => mm.close(true) },
      ],
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); m.close(true); } });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

// ---------------------------------------------------------------------------
// Staged progress overlay

/** Milliseconds as a short duration: "840 ms", "3.2 s", "1 min 12 s". */
export function msText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return Math.round(ms) + '\u00a0ms';   // non-breaking: a number never wraps away from its unit
  if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + '\u00a0s';
  const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
  return `${m}\u00a0min${s ? ' ' + s + '\u00a0s' : ''}`;
}

/**
 * Staged progress overlay. Each stage's time is the work it did, measured from after its
 * label was painted to the start of the next stage.
 * api: stage(k, label) · note(text) · detail(text) · fraction(0..1) · substages([{label, ms}])
 *      onCancel(label, fn) adds a stop button · close()
 */
export function showProgress(title, stageLabels = []) {
  const root = document.getElementById('progress');
  clear(root);
  const now = h('p.now', { text: stageLabels[0] || 'Working…' });
  const detail = h('p.detail', { hidden: true });
  const list = h('ul.stages');
  const items = stageLabels.map((s) => {
    const li = h('li', null, h('span.mk'), h('span', { text: s }), h('span.ms'));
    list.appendChild(li);
    return li;
  });
  const bar = h('i');
  const barWrap = h('div.progress-bar', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'aria-label': title }, bar);
  const foot = h('div.progress-foot', { hidden: true });
  const box = h('div.progress-box.instrument.ticked', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('h2', { text: title }), now, detail, barWrap, list, foot);
  root.appendChild(box);
  root.hidden = false;
  let cur = -1, t0 = performance.now();
  const setBar = (f) => {
    const v = (Math.max(0, Math.min(1, f)) * 100);
    bar.style.setProperty('--v', v.toFixed(1) + '%');
    barWrap.setAttribute('aria-valuenow', String(Math.round(v)));
  };
  const finishCurrent = () => {
    if (cur >= 0 && items[cur]) {
      items[cur].classList.remove('cur'); items[cur].classList.add('done');
      items[cur].querySelector('.ms').textContent = msText(performance.now() - t0);
    }
  };
  const api = {
    async stage(k, label) {
      finishCurrent();
      cur = k;
      if (items[k]) items[k].classList.add('cur');
      now.textContent = label || stageLabels[k] || '';
      setBar(k / Math.max(1, stageLabels.length));
      await nextFrame();
      t0 = performance.now();
    },
    note(text) { if (now.textContent !== text) now.textContent = text; },
    detail(text) { detail.hidden = !text; if (detail.textContent !== (text || '')) detail.textContent = text || ''; },
    fraction(f) { setBar(f); },
    /** Sub-stage labels reported by the generator, listed in order under the current stage with their timings. */
    substages(subs) {
      let at = items[cur];
      if (!at || !subs.length) return;
      for (const s of subs) {
        const li = h('li.done.sub', null, h('span.mk'), h('span', { text: s.label }), h('span.ms', { text: msText(s.ms) }));
        at.after(li);
        at = li;
      }
    },
    /** Offer a button that stops the work (e.g. "Stop here"). */
    onCancel(label, fn) {
      clear(foot);
      const b = h('button.btn.btn-sm', { type: 'button', text: label });
      b.addEventListener('click', () => { b.disabled = true; fn(); });
      foot.appendChild(b);
      foot.hidden = false;
      setTimeout(() => b.focus({ preventScroll: true }), 0);
    },
    close() { finishCurrent(); root.hidden = true; clear(root); },
  };
  return api;
}

// ---------------------------------------------------------------------------
// Sliders and parameter controls

/** Keep a range input's filled track in sync with its value. */
export function syncRange(input) {
  const min = Number(input.min) || 0, max = Number(input.max) || 1, v = Number(input.value);
  const f = max > min ? (v - min) / (max - min) : 0;
  input.style.setProperty('--fill', (Math.max(0, Math.min(1, f)) * 100).toFixed(1) + '%');
}

export function rangeInput({ id, min, max, step, value, label, oninput }) {
  const input = h('input', { id, type: 'range', min, max, step, value, 'aria-label': label });
  input.value = String(value);
  syncRange(input);
  input.addEventListener('input', () => { syncRange(input); oninput?.(Number(input.value), input); });
  return input;
}

/**
 * Build a control for a PARAMS entry. opts: { idPrefix, value, genesisValue, onChange(key, value), compact }
 * Returns { el, set(value), key }.
 */
export function paramControl(p, { idPrefix = 'p', value, genesisValue = undefined, onChange, showDesc = true }) {
  const id = `${idPrefix}-${p.key}`;
  const out = h('output.val', { for: id });
  const label = h('label', { for: id, text: p.label });
  const row = h('div.param', { dataset: { key: p.key } }, label);
  let input;
  let mark = null;
  const markChanged = (v) => {
    const changed = genesisValue !== undefined && String(v) !== String(genesisValue);
    out.classList.toggle('is-changed', changed);
  };
  if (p.type === 'range') {
    input = rangeInput({
      id, min: p.min, max: p.max, step: p.step, value, label: p.label,
      oninput: (v) => { out.textContent = paramValue(p, v); markChanged(v); onChange?.(p.key, v); },
    });
    out.textContent = paramValue(p, value);
    row.appendChild(out);
    const ctl = h('div.ctl', null, input);
    if (genesisValue !== undefined && p.max > p.min) {
      const f = (Number(genesisValue) - p.min) / (p.max - p.min);
      mark = h('i.genesis-mark', { title: 'Value at genesis', style: { left: `calc(7px + (100% - 14px) * ${Math.max(0, Math.min(1, f)).toFixed(4)})` } });
      ctl.appendChild(mark);
    }
    row.appendChild(ctl);
  } else if (p.type === 'select') {
    input = h('select.field', { id });
    for (const [v, lab] of p.options) input.appendChild(h('option', { value: String(v), text: lab }));
    input.value = String(value);
    input.addEventListener('change', () => {
      const opt = p.options.find(([v]) => String(v) === input.value);
      const v = opt ? opt[0] : p.default;
      markChanged(v);
      onChange?.(p.key, v);
    });
    row.appendChild(h('span.val'));
    row.appendChild(h('div.ctl', null, input));
  } else if (p.type === 'text') {
    input = h('input.field', { id, type: 'text', maxlength: p.maxLength || 40, autocomplete: 'off', spellcheck: 'false', placeholder: p.placeholder || '' });
    input.value = value == null ? '' : String(value);
    input.addEventListener('change', () => { markChanged(input.value); onChange?.(p.key, input.value); });
    row.appendChild(h('span.val'));
    row.appendChild(h('div.ctl', null, input));
  } else if (p.type === 'bool') {
    input = h('input', { id, type: 'checkbox' });
    input.checked = Boolean(value);
    const sw = h('label.switch', { for: id }, input, h('span.track'));
    input.addEventListener('change', () => { out.textContent = input.checked ? 'On' : 'Off'; markChanged(input.checked); onChange?.(p.key, input.checked); });
    out.textContent = value ? 'On' : 'Off';
    row.appendChild(h('span.row-end', null, out, sw));
  }
  if (showDesc && p.desc) row.appendChild(h('p.desc', { text: p.desc }));
  markChanged(value);
  return {
    el: row, key: p.key, input,
    set(v) {
      if (!input) return;
      if (p.type === 'bool') { input.checked = Boolean(v); out.textContent = v ? 'On' : 'Off'; }
      else if (p.type === 'select' || p.type === 'text') input.value = v == null ? '' : String(v);
      else { input.value = String(v); syncRange(input); out.textContent = paramValue(p, v); }
      markChanged(v);
    },
  };
}

/** Graduated neatline: a tick every 15° of longitude and latitude around a map, the equator dashed. */
export function graduationSVG(gap = 7) {
  const top = [], bottom = [], left = [], right = [];
  for (let k = 0; k <= 24; k++) {
    const x = (k / 24) * 100, long = k % 2 === 0;
    top.push(`<line x1="${x}%" y1="${long ? 0 : 3}" x2="${x}%" y2="6"/>`);
    bottom.push(`<line x1="${x}%" y1="0" x2="${x}%" y2="${long ? 6 : 3}"/>`);
  }
  for (let k = 0; k <= 12; k++) {
    const y = (k / 12) * 100, long = k % 2 === 0;
    left.push(`<line x1="${long ? 0 : 3}" y1="${y}%" x2="6" y2="${y}%"/>`);
    right.push(`<line x1="0" y1="${y}%" x2="${long ? 6 : 3}" y2="${y}%"/>`);
  }
  const stroke = 'stroke="var(--rule-2)" stroke-width="1"';
  return `<svg width="100%" height="100%" style="position:absolute;inset:0;overflow:visible" aria-hidden="true">
    <svg x="0" y="-${gap}" width="100%" height="6" overflow="visible" ${stroke}>${top.join('')}</svg>
    <svg x="0" y="100%" width="100%" height="6" overflow="visible" ${stroke}><g transform="translate(0 1)">${bottom.join('')}</g></svg>
    <svg x="-${gap}" y="0" width="6" height="100%" overflow="visible" ${stroke}>${left.join('')}</svg>
    <svg x="100%" y="0" width="6" height="100%" overflow="visible" ${stroke}><g transform="translate(1 0)">${right.join('')}</g></svg>
    <line x1="0" y1="50%" x2="100%" y2="50%" stroke="var(--brass)" stroke-opacity="0.35" stroke-dasharray="2 5"/>
  </svg>`;
}
