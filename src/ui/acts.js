// Divine acts: the entity tools (target 'entity', contracts §11) as levers on the records they
// touch. For every kind named in some tool's entity.kinds, a "Divine acts" section joins that
// kind's Inspector record (registerSection), listing the acts available in this world.
//   - An act that needs a choice opens a small form: a technology (from the published tech
//     table, those whose prerequisites are met), a wonder, a new name, or whatever the tool
//     declares in def.args = [{ key, type: 'tech'|'wonder'|'text'|'select', label, options?(world,
//     target) → [[value, label]] }]. Without args, gift_tech asks for techId, commission_wonder
//     for kind and rename for name.
//   - A tool with a preview shows its forecast, or the reason it cannot act; fate cards from
//     preview.cards are drawn as cards whose actions apply the tool with { card, action }.
//   - Dangerous acts (def.danger) ask first unless the Chronoscope can undo them.
// Every act goes through applyEntityTool as one undoable act (app.chrono) and is answered by
// the deed card (deedcard.js).

import * as kernelTools from '../core/tools.js';
import { getTools } from '../core/tools.js';
import { registerSection } from './registry.js';
import { h, clear, setText } from './dom.js';
import { iconEl } from './icons.js';
import { tip, confirmDialog } from './widgets.js';
import { statusToast } from './toasts.js';
import { selectionPoint, describeSel } from './app.js';
import * as F from './format.js';

let techMod = null;
try { techMod = await import('../sim/civ/tech.js'); } catch (e) { /* the tech table is optional here */ }

const INFERRED_ARGS = {
  gift_tech: [{ key: 'techId', type: 'tech', label: 'Technology' }],
  commission_wonder: [{ key: 'kind', type: 'wonder', label: 'Wonder' }],
  rename: [{ key: 'name', type: 'text', label: 'New name' }],
};
const PREVIEW_MS = 2000;

export function mount(app) {
  const registered = new Set();

  /** Entity tools usable in this world for a record kind. */
  function actsFor(kind) {
    const w = app.world;
    const all = w && typeof kernelTools.availableTools === 'function' ? kernelTools.availableTools(w) : getTools();
    return all.filter((t) => t.target === 'entity' && typeof t.applyEntity === 'function' && Array.isArray(t.entity?.kinds) && t.entity.kinds.includes(kind));
  }

  /** Is the record still a living thing the hand can touch? (A slain beast, a fallen nation, a ruin keep their records, not their acts.) */
  function targetLive(sel) {
    const w = app.world;
    if (!w || !sel) return false;
    switch (sel.kind) {
      case 'civ': return Boolean(w.civs[sel.id]) && w.civs[sel.id].alive !== false;
      case 'settlement': return Boolean(w.settlements[sel.id]?.alive);
      case 'band': return (w.bands || []).some((b) => b.id === sel.id);
      case 'army': return w.armies.some((q) => q.id === sel.id);
      case 'storm': return w.storms.some((q) => q.id === sel.id);
      default: return describeSel(app, sel).alive !== false;
    }
  }

  /** Register a section for every kind some entity tool can touch (tools may register late). */
  function sync() {
    const kinds = new Set();
    for (const t of getTools()) if (t.target === 'entity' && Array.isArray(t.entity?.kinds)) for (const k of t.entity.kinds) kinds.add(k);
    for (const kind of kinds) {
      if (registered.has(kind)) continue;
      registered.add(kind);
      registerSection(kind, { id: 'story.acts', order: 85, when: (a, sel) => Boolean(a.world) && targetLive(sel) && actsFor(sel.kind).length > 0, mount: (a, sel, el) => section(sel, el) });
    }
  }
  sync();
  app.on('world', sync);
  app.on('toolsChanged', sync);

  // ---------------------------------------------------------------------------
  // The section

  function section(sel, el) {
    const target = { kind: sel.kind, id: sel.id };
    const grid = h('div.acts-grid', { role: 'group', 'aria-label': 'Divine acts' });
    const panel = h('div.acts-panel', { hidden: true });
    el.append(h('h4.rule-head', { text: 'Divine acts' }), grid, panel);
    let open = null;       // the act whose form is open
    let sig = '';
    let previewAt = 0;

    function build() {
      const list = actsFor(sel.kind);
      const s = list.map((t) => t.id).join(',');
      if (s === sig) return;
      sig = s;
      clear(grid);
      for (const t of list) {
        const b = h('button.act-btn', { type: 'button', class: `is-${t.polarity || 'neutral'}`, 'aria-pressed': 'false' }, iconEl(t.icon || t.id, { size: 18, label: t.label }), h('span', { text: t.label }));
        tip(b, t.desc || '', t.label);
        b.addEventListener('click', () => choose(t, b));
        b._tool = t;
        grid.appendChild(b);
      }
      if (open && !list.some((t) => t.id === open.id)) closeForm();
    }

    /** The choices this act asks for here (a wonder list the tool does not supply is left to the tool). */
    const usable = (t) => argsOf(t).filter((a) => a.type === 'text' || a.type === 'tech' || optionsFor(t, a).length > 0);

    function choose(t, btn) {
      if (open && open.id === t.id) { closeForm(); return; }
      const args = usable(t);
      const pv = preview(t);
      if (!args.length && !(pv && Array.isArray(pv.cards) && pv.cards.length) && !(pv && pv.ok === false) && !(pv && pv.text)) { act(t, {}); return; }
      openForm(t, args, pv, btn);
    }

    function closeForm() {
      open = null;
      panel.hidden = true;
      clear(panel);
      for (const b of grid.children) b.setAttribute('aria-pressed', 'false');
    }

    function openForm(t, args, pv, btn) {
      open = t;
      for (const b of grid.children) b.setAttribute('aria-pressed', String(b === btn));
      clear(panel);
      panel.hidden = false;
      const values = {};
      const fields = h('div.acts-fields');
      for (const a of args) fields.appendChild(field(t, a, values));
      const note = h('p.acts-note');
      const cards = h('div.fate-cards');
      const goBtn = h('button.btn.btn-sm.btn-brass', { type: 'button', text: t.label });
      goBtn.addEventListener('click', () => act(t, { ...values }));
      const cancel = h('button.btn.btn-sm.btn-quiet', { type: 'button', text: 'Cancel' });
      cancel.addEventListener('click', closeForm);
      panel.append(h('div.acts-title', null, iconEl(t.icon || t.id, { size: 16, label: t.label }), h('b', { text: t.label }), t.desc ? h('span.muted', { text: t.desc }) : null), fields, note, cards, h('div.acts-go', null, cancel, goBtn));
      const showPreview = (p) => {
        note.className = 'acts-note' + (p && p.ok === false ? ' is-refused' : '');
        setText(note, p ? (p.ok === false ? p.reason || 'This cannot be done now.' : p.text || '') : '');
        goBtn.disabled = Boolean(p && p.ok === false);
        clear(cards);
        if (p && Array.isArray(p.cards) && p.cards.length) {
          goBtn.hidden = true;
          for (const c of p.cards.slice(0, 6)) cards.appendChild(fateCard(t, c));
        } else goBtn.hidden = false;
      };
      showPreview(pv);
      open._refresh = () => showPreview(preview(t, values));
    }

    function fateCard(t, c) {
      const pct = Number.isFinite(c.p) ? Math.round(Math.max(0, Math.min(1, c.p)) * 100) : null;
      const actions = h('div.fc-actions');
      for (const a of Array.isArray(c.actions) && c.actions.length ? c.actions : [{ id: 'invoke', label: 'Invoke' }]) {
        const b = h('button.btn.btn-sm', { type: 'button', text: a.label || F.humanize(a.id) });
        b.addEventListener('click', () => act(t, { card: c.id, action: a.id }));
        actions.appendChild(b);
      }
      return h('div.fate-card', null,
        h('div.fc-head', null, h('b', { text: c.label || F.humanize(c.id) }), pct != null ? h('span.fc-p', { text: `${pct}%` }) : null),
        pct != null ? h('div.meter', { style: { '--v': pct + '%' } }) : null,
        Array.isArray(c.effects) && c.effects.length ? h('ul.fc-fx', null, c.effects.slice(0, 4).map((x) => h('li', { text: String(x) }))) : null,
        actions);
    }

    function field(t, a, values) {
      const id = `act-${t.id}-${a.key}-${sel.id}`;
      const label = h('label', { for: id, text: a.label || F.humanize(a.key) });
      let input;
      const opts = optionsFor(t, a);
      if (a.type === 'text') {
        const cur = describeSel(app, sel).name || '';
        input = h('input.field', { id, type: 'text', maxlength: 40, value: cur, autocomplete: 'off', spellcheck: 'false' });
        values[a.key] = cur;
        input.addEventListener('input', () => { values[a.key] = input.value.trim(); });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); act(t, { ...values }); } });
      } else {
        input = h('select.field', { id });
        if (!opts.length) input.appendChild(h('option', { value: '', text: a.type === 'tech' ? 'Nothing left to learn now' : 'Nothing to choose' }));
        for (const [v, lab] of opts) input.appendChild(h('option', { value: String(v), text: lab }));
        values[a.key] = opts.length ? opts[0][0] : null;
        input.addEventListener('change', () => { const o = opts.find(([v]) => String(v) === input.value); values[a.key] = o ? o[0] : null; open?._refresh?.(); });
      }
      return h('div.acts-field', null, label, input);
    }

    function optionsFor(t, a) {
      const w = app.world;
      if (typeof a.options === 'function') { try { const o = a.options(w, target); if (Array.isArray(o)) return o; } catch (e) { app.reportError(`acts.${t.id}.options`, e); } return []; }
      if (Array.isArray(a.options)) return a.options;
      if (a.type === 'tech' && techMod?.TECHS) {
        const civ = sel.kind === 'civ' ? w.civs[sel.id] : sel.kind === 'settlement' ? w.civs[w.settlements[sel.id]?.civId] : null;
        const known = civ?.tech?.known || {};
        return techMod.TECHS.filter((x) => known[x.id] == null && (x.prereqs || []).every((p) => known[p] != null))
          .sort((p, q) => p.era - q.era || p.name.localeCompare(q.name)).map((x) => [x.id, `${x.name} · ${F.eraName(x.era)}`]);
      }
      return [];
    }

    function preview(t, extra = {}) {
      if (typeof t.preview !== 'function' || typeof kernelTools.previewTool !== 'function') return null;
      const p = selectionPoint(app, sel) || {};
      try { return kernelTools.previewTool(app.world, t.id, p.x ?? null, p.y ?? null, { target, ...extra }); } catch (e) { return null; }
    }

    async function act(t, args) {
      const w = app.world;
      if (!w || typeof kernelTools.applyEntityTool !== 'function') return;
      if (app.chrono?.busy || app.fastForwarding) return;
      let risky = false;
      try { risky = typeof t.danger === 'function' && Boolean(t.danger(args)); } catch (e) { risky = false; }
      if (risky && !app.chrono?.canProtect?.()) {
        const ok = await confirmDialog({ title: `${t.label}?`, text: `${t.label} cannot be undone here. Do it anyway?`, confirmLabel: t.label, danger: true });
        if (!ok) return;
      }
      if (!('card' in args)) for (const a of usable(t)) if (args[a.key] == null || args[a.key] === '') { statusToast(app, `Choose ${(a.label || a.key).toLowerCase()} first.`, 'warn', { icon: t.icon || t.id }); return; }
      const p = selectionPoint(app, sel) || {};
      app.chrono?.beginAct?.({ kind: 'entity', id: t.id, label: t.label, icon: t.icon || t.id, x: p.x ?? null, y: p.y ?? null });
      let res = null;
      try { res = kernelTools.applyEntityTool(w, t.id, target, args); }
      catch (e) { app.reportError(`acts.${t.id}`, e); }
      finally { app.chrono?.endAct?.(); }
      if (!res || res.ok === false) statusToast(app, res?.message || `${t.label} could not be done.`, 'warn', { icon: t.icon || t.id });
      else if (!app.deedCards && res.message) statusToast(app, res.message, 'ok', { icon: t.icon || t.id });
      closeForm();
      sig = '';
      app.emit('worldEdited');
    }

    build();
    return {
      update() {
        build();
        const nowT = performance.now();
        if (open && nowT - previewAt > PREVIEW_MS) { previewAt = nowT; open._refresh?.(); }
      },
    };
  }
}

/** The choices an entity tool needs: its own args, else the ones the reserved ids are known to take. */
function argsOf(t) {
  if (Array.isArray(t.args)) return t.args.filter((a) => a && a.key);
  return INFERRED_ARGS[t.id] || [];
}
