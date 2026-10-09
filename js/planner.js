// planner.js: the Planner, a large overlay sheet for Draw mode. Sketch shapes in pencil, drop in a
// picture or a banner, see it as typed ink, then press "Type it" and the machine types it.
//
//   const planner = new Planner(host, { PageSurface, getPage, typeface, ink, inks, onCommit });
//   planner.open(); planner.close(); planner.isOpen
//
// typeface / ink / inks may be values or functions (read on every open). inks (optional) lists the
// ink ids on the current ribbon, e.g. ['k', 'r']. onCommit(strikes) receives the strikes in typing
// order ({ c, x, y, k, p, f }); the app adds seeds and wear and types them.

import * as art from './art.js';
import { hash32, clamp } from './util.js';
import { Guide } from './guide.js';

const COLS = art.PAGE.COLS, ROWS = art.PAGE.ROWS;
const PAGE_ASPECT = art.PAGE.W / art.PAGE.H;

const INK_FALLBACK = {
  k: { name: 'Black', color: '#201d1b' }, r: { name: 'Red', color: '#cc3027' }, n: { name: 'Navy', color: '#26305f' },
  s: { name: 'Sepia', color: '#6b4428' }, v: { name: 'Violet', color: '#613594' },
};
let INKMOD = null;
import('./ink.js').then(m => { INKMOD = m; }).catch(() => {});
const inkInfo = k => (INKMOD && INKMOD.INKS && INKMOD.INKS[k]) || INK_FALLBACK[k] || INK_FALLBACK.k;

const val = v => (typeof v === 'function' ? v() : v);

const TOOLS = [
  { id: 'pencil', name: 'Pencil', key: 'p', hint: 'Draw freehand. Each cell the line passes gets one character.' },
  { id: 'line', name: 'Line', key: 'l', hint: 'Drag from one end to the other. Hold Shift for straight angles.' },
  { id: 'rect', name: 'Box', key: 'b', hint: 'Drag a box. Corners get +, sides - and |, or your character.' },
  { id: 'ellipse', name: 'Oval', key: 'o', hint: 'Drag an oval. Hold Shift for a circle.' },
  { id: 'fill', name: 'Fill', key: 'f', hint: 'Click inside a closed outline to fill it with a character or a tone.' },
  { id: 'eraser', name: 'Eraser', key: 'e', hint: 'Click or drag over a shape to lift it off the plan.' },
  { id: 'picture', name: 'Picture', key: 'i', hint: 'Choose a picture, then drag it into place and pull a corner to size it.' },
  { id: 'banner', name: 'Banner', key: 't', hint: 'Type your words, then click the page where the banner should start.' },
];
const DRAW_TOOLS = ['pencil', 'line', 'rect', 'ellipse', 'fill'];

const ICONS = {
  pencil: '<path d="M4.5 19.5l1.2-4.3L15.8 5.1a1.6 1.6 0 0 1 2.3 0l.8.8a1.6 1.6 0 0 1 0 2.3L8.8 18.3z"/><path d="M14 7l3 3"/><path d="M5.7 15.2l3.1 3.1"/>',
  line: '<path d="M5.5 18.5l13-13"/><circle cx="5" cy="19" r="1.6"/><circle cx="19" cy="5" r="1.6"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="0.8"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8.2" ry="6.2"/>',
  fill: '<path d="M4.5 11.5L11 5l7 7-6.5 6.5a1.5 1.5 0 0 1-2.1 0l-4.9-4.9a1.5 1.5 0 0 1 0-2.1z"/><path d="M4.6 12.1h12.8"/><path d="M19.8 14.5s1.6 2.1 1.6 3.2a1.6 1.6 0 0 1-3.2 0c0-1.1 1.6-3.2 1.6-3.2z"/>',
  eraser: '<path d="M9 19.5h10.5"/><path d="M4.8 14.6l8.9-8.9a1.5 1.5 0 0 1 2.1 0l3 3a1.5 1.5 0 0 1 0 2.1L12 17.6a3 3 0 0 1-4.2 0l-3-3z"/><path d="M8.3 11.1l5.1 5.1"/>',
  picture: '<rect x="3.5" y="5" width="17" height="14" rx="1"/><path d="M3.8 16.5l5.2-5 4 3.8 2.4-2.2 5.1 4.6"/><circle cx="15.6" cy="9.2" r="1.5"/>',
  banner: '<path d="M3.5 18.5L8 5.5h1l4.5 13"/><path d="M5.2 14h6.6"/><path d="M15.5 9.5h5"/><path d="M18 9.5v9"/>',
  undo: '<path d="M8.5 6.5L4 11l4.5 4.5"/><path d="M4.5 11H15a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="M15.5 6.5L20 11l-4.5 4.5"/><path d="M19.5 11H9a5 5 0 0 0 0 10h3"/>',
  clear: '<path d="M4.5 7h15"/><path d="M9.5 7V4.8h5V7"/><path d="M6.8 7l.9 12.2h8.6L17.2 7"/><path d="M10.2 10.5v5.5"/><path d="M13.8 10.5v5.5"/>',
  zin: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/><path d="M8 10.5h5"/><path d="M10.5 8v5"/>',
  zout: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/><path d="M8 10.5h5"/>',
  fit: '<path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/>',
  close: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
  upload: '<path d="M12 15.5V4.5"/><path d="M7.5 9L12 4.5 16.5 9"/><path d="M4.5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V15"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;

const GLYPH_NAMES = { '#': 'number sign', '@': 'at sign', '*': 'asterisk', '+': 'plus', '=': 'equals', '-': 'hyphen',
  _: 'underscore', '.': 'period', ':': 'colon', ';': 'semicolon', ',': 'comma', "'": 'apostrophe', '"': 'quotation mark',
  '|': 'vertical bar', '/': 'slash', '\\': 'backslash', '(': 'left parenthesis', ')': 'right parenthesis', '<': 'less than',
  '>': 'greater than', '^': 'caret', '~': 'tilde', '%': 'percent', '&': 'ampersand', '$': 'dollar' };
const glyphName = g => GLYPH_NAMES[g] || g;

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// approximate canvas rect a strike may touch (same margins as ink.js strikeRect)
function strikeRectPx(st, scale, W, H) {
  const cw = art.PAGE.CW * scale, rh = art.PAGE.RH * scale;
  const x0 = Math.max(0, Math.floor(st.x * cw - cw * 0.5 - 3)), x1 = Math.min(W, Math.ceil((st.x + 1) * cw + cw * 0.5 + 3));
  const y0 = Math.max(0, Math.floor(st.y * rh - rh * 0.45 - 3)), y1 = Math.min(H, Math.ceil((st.y + 1) * rh + rh * 0.35 + 3));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}
function unionRect(a, b) {
  if (!a) return b;
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
}

let uid = 0;
const newId = () => 'sh' + (++uid).toString(36) + Date.now().toString(36).slice(-3);

export class Planner {
  constructor(host, opts = {}) {
    this.host = host || document.body;
    this.opts = opts;
    this.PageSurface = opts.PageSurface;
    this._open = false;
    this.shapes = [];
    this.undoStack = [];
    this.redoStack = [];
    this.tool = 'pencil';
    this.view = 'both';
    this.zoom = 1;
    this.brush = { glyph: 'auto', ink: 'k', pressure: 1, halfStep: false, shade: 0.45 };
    this.picDefaults = { style: 'shade', contrast: 0, brightness: 0, invert: false, hatch: 0.35 };
    this.bannerDefaults = { text: 'HELLO', glyph: 'self', size: 2 };
    this.selected = null;
    this.draft = null;
    this.hover = null;
    this.sources = new Map();
    this._imgCache = new Map();
    this._picCache = new Map();
    this._pointers = new Map();
    this._planned = [];
    this._perShape = [];
    this._shown = new Map();
    this._build();
    this._bind();
  }

  get isOpen() { return this._open; }

  // ------------------------------------------------------------------ open / close
  open() {
    if (this._open) return;
    this._open = true;
    this.root.hidden = false;
    this.root.getBoundingClientRect();
    this.root.classList.add('is-open');
    this._readSettings();
    this._layout();
    this._renderBase();
    this._replan();
    this._syncPanel();
    this._lastFocus = document.activeElement;
    this.el.sheet.focus({ preventScroll: true });
    window.addEventListener('keydown', this._winKey, true);
    window.addEventListener('keyup', this._winKeyUp, true);
  }

  // Tones come from the measured ramp. The built-in table was measured with the same renderer;
  // re-measure live (once per typeface, ~0.5 s) only when a picture or a tone fill needs it.
  _ensureRamp() {
    if (!this.PageSurface || !this.ramp || this.ramp.source === 'renderer') return;
    this._rampTried = this._rampTried || new Set();
    if (this._rampTried.has(this.typeface)) return;          // one attempt per typeface
    const tf = this.typeface;
    this._rampTried.add(tf);
    clearTimeout(this._rampTimer);
    this._rampTimer = setTimeout(() => {
      art.densityRamp(tf, { PageSurface: this.PageSurface }).then(r => {
        if (tf === this.typeface && r !== this.ramp) { this.ramp = r; this._picCache.clear(); this._replan(); }
      }).catch(() => {});
    }, 300);
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this._cancelGesture();
    this._pinch = null;
    this._pointers.clear();
    this.root.classList.remove('is-open');
    window.removeEventListener('keydown', this._winKey, true);
    window.removeEventListener('keyup', this._winKeyUp, true);
    clearTimeout(this._closeTimer);
    this._closeTimer = setTimeout(() => { if (!this._open) this.root.hidden = true; }, 220);
    if (this._lastFocus && this._lastFocus.focus) try { this._lastFocus.focus({ preventScroll: true }); } catch { /* gone */ }
  }

  destroy() {
    this.close();
    if (this._ro) this._ro.disconnect();
    this.root.remove();
  }

  _readSettings() {
    this.typeface = val(this.opts.typeface) || 'pica';
    const cur = val(this.opts.ink) || 'k';
    let inks = val(this.opts.inks);
    if (!Array.isArray(inks) || !inks.length) inks = Array.isArray(cur) ? cur : [cur];
    this.inks = inks;
    if (!this.inks.includes(this.brush.ink)) this.brush.ink = this.inks.includes(cur) ? cur : this.inks[0];
    const r = art.rampSync(this.typeface);
    if (r !== this.ramp) { this.ramp = r; this._picCache.clear(); }
    this._buildInks();
  }

  // ------------------------------------------------------------------ DOM
  _build() {
    const el = this.el = {};
    this.root = h('div', { class: 'pl-root', hidden: true });
    const scrim = h('div', { class: 'pl-scrim' });
    el.sheet = h('section', { class: 'pl-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pl-title', tabindex: '-1' });

    // header
    el.view = h('div', { class: 'pl-seg pl-viewseg', role: 'radiogroup', 'aria-label': 'Show' },
      ...[['pencil', 'Pencil'], ['both', 'Both'], ['ink', 'Ink']].map(([v, t]) =>
        h('button', { type: 'button', class: 'pl-segbtn', role: 'radio', 'data-view': v, 'aria-checked': 'false', title: `Show ${t.toLowerCase()}` }, t)));
    const head = h('header', { class: 'pl-head' },
      h('div', { class: 'pl-titles' },
        h('h2', { class: 'pl-title', id: 'pl-title' }, 'The Planner'),
        h('p', { class: 'pl-sub' }, 'Sketch in pencil. The machine types it for you, clack by clack.')),
      h('div', { class: 'pl-headtools' },
        h('span', { class: 'pl-label pl-viewlabel' }, 'Show'), el.view,
        h('button', { type: 'button', class: 'pl-iconbtn pl-x', 'aria-label': 'Close the planner', title: 'Close (Esc)', html: icon('close'), onclick: () => this.close() })));

    // tools
    el.tools = h('nav', { class: 'pl-tools', role: 'toolbar', 'aria-label': 'Drawing tools' });
    el.toolBtns = {};
    for (const t of TOOLS) {
      const b = h('button', { type: 'button', class: 'pl-tool', 'data-tool': t.id, 'aria-pressed': 'false', 'aria-label': t.name, title: `${t.name} (${t.key.toUpperCase()})`,
        html: icon(t.id) + `<span>${t.name}</span>` });
      el.toolBtns[t.id] = b;
      el.tools.append(b);
    }
    el.tools.append(h('span', { class: 'pl-toolsep', 'aria-hidden': 'true' }));
    el.undo = h('button', { type: 'button', class: 'pl-tool pl-tool-sm', 'aria-label': 'Undo', title: 'Undo (Ctrl+Z)', html: icon('undo') + '<span>Undo</span>' });
    el.redo = h('button', { type: 'button', class: 'pl-tool pl-tool-sm', 'aria-label': 'Redo', title: 'Redo (Ctrl+Shift+Z)', html: icon('redo') + '<span>Redo</span>' });
    el.clear = h('button', { type: 'button', class: 'pl-tool pl-tool-sm', 'aria-label': 'Clear the plan', title: 'Clear the plan', html: icon('clear') + '<span>Clear</span>' });
    el.tools.append(el.undo, el.redo, el.clear);

    // stage
    el.ink = h('canvas', { class: 'pl-ink', 'aria-hidden': 'true' });
    el.guides = h('canvas', { class: 'pl-guides', 'aria-hidden': 'true' });
    el.grid = h('div', { class: 'pl-grid', 'aria-hidden': 'true' });
    el.frames = h('div', { class: 'pl-frames' });
    el.cursor = h('div', { class: 'pl-cursor', 'aria-hidden': 'true' });
    el.page = h('div', { class: 'pl-page', role: 'img', 'aria-label': 'The page. Draw on it with the selected tool.' },
      el.ink, el.guides, el.grid, el.frames, el.cursor);
    el.stage = h('div', { class: 'pl-stage' }, el.page);
    el.toast = h('div', { class: 'pl-toast', role: 'status', 'aria-live': 'polite' });
    el.zoomLabel = h('span', { class: 'pl-zoomval' }, '100%');
    const zoom = h('div', { class: 'pl-zoom', role: 'group', 'aria-label': 'Zoom' },
      h('button', { type: 'button', class: 'pl-iconbtn', 'aria-label': 'Zoom out', title: 'Zoom out', html: icon('zout'), onclick: () => this._zoomBy(1 / 1.4) }),
      h('button', { type: 'button', class: 'pl-iconbtn', 'aria-label': 'Fit the page', title: 'Fit the page', html: icon('fit'), onclick: () => this._setZoom(1) }),
      h('button', { type: 'button', class: 'pl-iconbtn', 'aria-label': 'Zoom in', title: 'Zoom in', html: icon('zin'), onclick: () => this._zoomBy(1.4) }),
      el.zoomLabel);
    el.stagewrap = h('div', { class: 'pl-stagewrap' }, el.stage, zoom, el.toast);

    // options panel
    el.panel = h('aside', { class: 'pl-panel', 'aria-label': 'Tool options' });
    this._buildPanel();

    // footer
    el.count = h('div', { class: 'pl-count', 'aria-live': 'polite' }, 'Nothing planned yet');
    el.cancel = h('button', { type: 'button', class: 'pl-btn pl-ghost' }, 'Cancel');
    el.commit = h('button', { type: 'button', class: 'pl-btn pl-primary', disabled: true, title: 'The machine types the plan, clack by clack' }, 'Type it');
    el.guideBtn = h('button', { type: 'button', class: 'pl-btn pl-guidebtn', disabled: true,
      title: 'Step-by-step instructions to type this on your own typewriter' }, 'Make a guide');
    const foot = h('footer', { class: 'pl-foot' }, el.count, h('div', { class: 'pl-actions' }, el.cancel, el.guideBtn, el.commit));

    el.sheet.append(head, h('div', { class: 'pl-body' }, el.tools, el.stagewrap, el.panel), foot);
    this.root.append(scrim, el.sheet);
    this.host.append(this.root);
    this.gctx = el.guides.getContext('2d');
    this.ictx = el.ink.getContext('2d');
  }

  _section(title, tools, ...body) {
    const s = h('section', { class: 'pl-sec', 'data-tools': tools.join(' ') }, title ? h('h3', { class: 'pl-label' }, title) : null, ...body);
    this.el.sections.push(s);
    return s;
  }

  _seg(name, items, onPick) {
    const g = h('div', { class: 'pl-seg', role: 'radiogroup', 'aria-label': name });
    for (const [v, t] of items) {
      g.append(h('button', { type: 'button', class: 'pl-segbtn', role: 'radio', 'aria-checked': 'false', 'data-v': String(v),
        onclick: () => onPick(v) }, t));
    }
    return g;
  }

  _slider(label, min, max, step, onInput) {
    const out = h('output', { class: 'pl-val' });
    const input = h('input', { type: 'range', min, max, step, 'aria-label': label });
    input.addEventListener('input', () => onInput(+input.value, false));
    input.addEventListener('change', () => onInput(+input.value, true));
    const row = h('label', { class: 'pl-slider' }, h('span', { class: 'pl-slname' }, label), input, out);
    row._input = input; row._out = out;
    return row;
  }

  _toggle(label, onChange) {
    const input = h('input', { type: 'checkbox', class: 'pl-switch-input' });
    input.addEventListener('change', () => onChange(input.checked));
    const row = h('label', { class: 'pl-switch' }, input, h('span', { class: 'pl-switch-track', 'aria-hidden': 'true' }), h('span', { class: 'pl-switch-label' }, label));
    row._input = input;
    return row;
  }

  _buildPanel() {
    const el = this.el;
    el.sections = [];
    el.hint = h('p', { class: 'pl-hint' });
    el.panel.append(h('div', { class: 'pl-panelhead' }, h('h3', { class: 'pl-paneltitle' }, 'Pencil'), el.hint));
    el.panelTitle = el.panel.querySelector('.pl-paneltitle');

    // character palette
    el.keys = h('div', { class: 'pl-keys', role: 'radiogroup', 'aria-label': 'Character' });
    for (const g of art.PALETTE) {
      el.keys.append(h('button', { type: 'button', class: 'pl-key' + (g === 'auto' ? ' pl-key-auto' : ''), role: 'radio', 'aria-checked': 'false',
        'data-glyph': g, 'aria-label': g === 'auto' ? 'Automatic: follows the direction of the line' : `Character ${glyphName(g)}`, title: g === 'auto' ? 'Automatic' : glyphName(g) },
      g === 'auto' ? 'auto' : g));
    }
    el.panel.append(this._section('Character', [...DRAW_TOOLS], el.keys));

    // tone for fills
    el.tone = this._slider('Tone', 0.05, 1, 0.05, (v, done) => { this.brush.shade = v; this._refreshSliderLabels(); if (done) this._syncPanel(); });
    el.toneRamp = h('div', { class: 'pl-ramp', 'aria-hidden': 'true' });
    el.panel.append(this._section('Tone (with auto)', ['fill'], el.tone, el.toneRamp));

    // ribbon inks
    el.inks = h('div', { class: 'pl-inks', role: 'radiogroup', 'aria-label': 'Ink' });
    el.panel.append(this._section('Ribbon', [...DRAW_TOOLS, 'picture', 'banner'], el.inks));

    // strike
    el.strike = this._seg('Strike', [[0.7, 'Light'], [1, 'Normal'], [1.3, 'Heavy']], v => this._setBrush({ pressure: v }));
    el.panel.append(this._section('Strike', [...DRAW_TOOLS, 'picture', 'banner'], el.strike));

    // half steps
    el.half = this._toggle('Half steps (finer lines, more strikes)', on => this._setBrush({ halfStep: on }));
    el.panel.append(this._section('', [...DRAW_TOOLS], el.half));

    // pictures
    el.samples = h('div', { class: 'pl-samples' });
    for (const s of art.SAMPLES) {
      const cv = h('canvas', { width: 120, height: Math.round(120 / Math.max(0.6, s.aspect)) });
      try { s.draw(cv.getContext('2d'), cv.width, cv.height); } catch { /* thumbnail only */ }
      const b = h('button', { type: 'button', class: 'pl-sample', 'data-sample': s.id, 'aria-label': `Place the ${s.name.toLowerCase()} picture`, title: s.name },
        cv, h('span', {}, s.name));
      b._cv = cv; b._sample = s;
      el.samples.append(b);
    }
    el.file = h('input', { type: 'file', accept: 'image/*', class: 'pl-file', tabindex: '-1', 'aria-hidden': 'true' });
    el.fileBtn = h('button', { type: 'button', class: 'pl-btn pl-small pl-filebtn', html: icon('upload') + '<span>Your own picture</span>', title: 'The picture stays in your browser' });
    el.picChooser = this._section('Pictures', ['picture'], el.samples, h('div', { class: 'pl-row' }, el.fileBtn, el.file),
      h('p', { class: 'pl-note' }, 'Your picture stays on this computer; nothing is uploaded.'));
    el.panel.append(el.picChooser);

    el.picStyle = this._seg('Style', [['shade', 'Shade'], ['line', 'Line'], ['stipple', 'Stipple']], v => this._editPicture({ style: v, halfRows: v === 'shade' }));
    el.picCols = this._slider('Size', 10, COLS, 1, (v, done) => this._editPicture({ cols: v }, !done));
    el.picContrast = this._slider('Contrast', -1, 1, 0.05, (v, done) => this._editPicture({ contrast: v }, !done));
    el.picBright = this._slider('Brightness', -1, 1, 0.05, (v, done) => this._editPicture({ brightness: v }, !done));
    el.picHatch = this._slider('Hatching', 0, 1, 0.05, (v, done) => this._editPicture({ hatch: v }, !done));
    el.picHalf = this._toggle('Half lines (smoother, slower)', on => this._editPicture({ halfRows: on }));
    el.picInvert = this._toggle('Invert', on => this._editPicture({ invert: on }));
    el.picRemove = h('button', { type: 'button', class: 'pl-btn pl-small pl-danger', onclick: () => this._removeSelected() }, 'Remove picture');
    el.picOpts = this._section('This picture', ['picture'], el.picStyle, el.picCols, el.picContrast, el.picBright, el.picHatch, el.picHalf, el.picInvert,
      h('div', { class: 'pl-row' }, el.picRemove));
    el.panel.append(el.picOpts);

    // banner
    el.bText = h('input', { type: 'text', class: 'pl-text', maxlength: '40', value: this.bannerDefaults.text, 'aria-label': 'Banner text', spellcheck: 'false', autocomplete: 'off' });
    el.bText.addEventListener('input', () => this._editBanner({ text: el.bText.value }, true));
    el.bText.addEventListener('change', () => this._editBanner({ text: el.bText.value }));
    el.bGlyph = h('div', { class: 'pl-keys pl-keys-sm', role: 'radiogroup', 'aria-label': 'Letters made of' });
    for (const g of ['self', '#', '@', '*', 'X', 'o', '$', '%', '&', '+']) {
      el.bGlyph.append(h('button', { type: 'button', class: 'pl-key' + (g === 'self' ? ' pl-key-auto' : ''), role: 'radio', 'aria-checked': 'false', 'data-glyph': g,
        'aria-label': g === 'self' ? 'Each letter made of itself' : `Letters made of ${glyphName(g)}` }, g === 'self' ? 'own' : g));
    }
    el.bSize = this._seg('Size', [[1, 'Small'], [2, 'Medium'], [3, 'Large']], v => this._editBanner({ size: v }));
    el.bRemove = h('button', { type: 'button', class: 'pl-btn pl-small pl-danger', onclick: () => this._removeSelected() }, 'Remove banner');
    el.bInfo = h('p', { class: 'pl-note' });
    el.panel.append(this._section('Words', ['banner'], el.bText),
      this._section('Letters made of', ['banner'], el.bGlyph),
      this._section('Size', ['banner'], el.bSize, el.bInfo),
      el.bOpts = this._section('', ['banner'], h('div', { class: 'pl-row' }, el.bRemove)));

    // eraser
    el.panel.append(this._section('', ['eraser'],
      h('p', { class: 'pl-note' }, 'Pictures and banners can also be removed with Delete while selected.'),
      h('div', { class: 'pl-row' }, h('button', { type: 'button', class: 'pl-btn pl-small pl-danger', onclick: () => this._clear() }, 'Clear the whole plan'))));
  }

  _buildInks() {
    const el = this.el;
    el.inks.textContent = '';
    for (const k of this.inks) {
      const info = inkInfo(k);
      el.inks.append(h('button', { type: 'button', class: 'pl-inkbtn', role: 'radio', 'aria-checked': String(this.brush.ink === k), 'data-ink': k,
        'aria-label': `${info.name} ink`, onclick: () => this._setBrush({ ink: k }) },
      h('span', { class: 'pl-swatch', style: `--sw:${info.color}` }), h('span', {}, info.name)));
    }
    if (this.inks.length < 2) el.inks.append(h('span', { class: 'pl-note pl-inline' }, 'A black & red ribbon adds red.'));
  }

  // ------------------------------------------------------------------ events
  _bind() {
    const el = this.el;
    el.cancel.addEventListener('click', () => this.close());
    el.commit.addEventListener('click', () => this._typeIt());
    el.guideBtn.addEventListener('click', () => this.makeGuide());
    el.undo.addEventListener('click', () => this.undo());
    el.redo.addEventListener('click', () => this.redo());
    el.clear.addEventListener('click', () => this._clear());
    for (const b of Object.values(el.toolBtns)) b.addEventListener('click', () => this.setTool(b.dataset.tool));
    el.view.addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (b) this.setView(b.dataset.view); });
    el.keys.addEventListener('click', e => { const b = e.target.closest('[data-glyph]'); if (b) this._setBrush({ glyph: b.dataset.glyph }); });
    el.bGlyph.addEventListener('click', e => { const b = e.target.closest('[data-glyph]'); if (b) this._editBanner({ glyph: b.dataset.glyph }); });
    el.samples.addEventListener('click', e => { const b = e.target.closest('[data-sample]'); if (b) this._addPicture({ kind: 'sample', id: b.dataset.sample }); });
    el.fileBtn.addEventListener('click', () => el.file.click());
    el.file.addEventListener('change', () => { const f = el.file.files && el.file.files[0]; if (f) this._loadFile(f); el.file.value = ''; });
    this.root.querySelector('.pl-scrim').addEventListener('click', () => this.close());

    // keys: nothing typed inside the panel reaches the typewriter
    const stop = e => e.stopPropagation();
    this.root.addEventListener('keydown', e => { this._key(e); e.stopPropagation(); });
    this.root.addEventListener('keyup', stop);
    this.root.addEventListener('keypress', stop);
    // keys aimed outside the panel while it is open (focus lost to the body): handle and swallow
    this._winKey = e => {
      if (!this._open || this.root.contains(e.target) || (this.guide && this.guide.isOpen)) return;
      this._key(e);
      e.stopPropagation();
    };
    this._winKeyUp = e => { if (this._open && !this.root.contains(e.target) && !(this.guide && this.guide.isOpen)) e.stopPropagation(); };

    // pointer drawing
    const pg = el.page;
    pg.addEventListener('pointerdown', e => this._down(e));
    pg.addEventListener('pointermove', e => this._move(e));
    pg.addEventListener('pointerup', e => this._up(e));
    pg.addEventListener('pointercancel', e => this._up(e, true));
    pg.addEventListener('pointerleave', () => { if (!this._gesture) { this.hover = null; this._hideCursor(); this._drawGuides(); } });
    pg.addEventListener('contextmenu', e => e.preventDefault());
    el.stage.addEventListener('wheel', e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      this._zoomAt(this.zoom * Math.exp(-e.deltaY * 0.0022), e.clientX, e.clientY);
    }, { passive: false });
    // drop a picture file onto the page
    el.stage.addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); el.stage.classList.add('is-drop'); } });
    el.stage.addEventListener('dragleave', () => el.stage.classList.remove('is-drop'));
    el.stage.addEventListener('drop', e => {
      el.stage.classList.remove('is-drop');
      const f = e.dataTransfer && [...e.dataTransfer.files].find(x => /^image\//.test(x.type));
      if (f) { e.preventDefault(); this.setTool('picture'); this._loadFile(f); }
    });
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => { if (this._open) this._layout(); });
      this._ro.observe(el.stage);
    } else {
      window.addEventListener('resize', () => { if (this._open) this._layout(); });
    }
  }

  _key(e) {
    const k = e.key;
    const inText = e.target && (e.target.tagName === 'INPUT' && /text|search/.test(e.target.type) || e.target.tagName === 'TEXTAREA');
    const mod = e.ctrlKey || e.metaKey;
    if (k === 'Escape') {
      e.preventDefault();
      if (this._gesture || this.draft) { this._cancelGesture(); this._replan(); return; }
      if (this.selected && !inText) { this._select(null); return; }
      this.close();
      return;
    }
    if (mod && !e.altKey && (k === 'z' || k === 'Z')) { if (inText) return; e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
    if (mod && !e.altKey && (k === 'y' || k === 'Y')) { if (inText) return; e.preventDefault(); this.redo(); return; }
    if (k === 'Tab') { this._trapTab(e); return; }
    const inInput = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT');
    if (inText || mod || e.altKey) return;
    if (inInput) return;                               // sliders and switches keep their own keys
    if ((k === 'Delete' || k === 'Backspace') && this.selected) { e.preventDefault(); this._removeSelected(); return; }
    const t = TOOLS.find(t => t.key === k.toLowerCase());
    if (t) { e.preventDefault(); this.setTool(t.id); return; }
    if (k === '+' || k === '=') { e.preventDefault(); this._zoomBy(1.4); return; }
    if (k === '-' || k === '_') { e.preventDefault(); this._zoomBy(1 / 1.4); return; }
    if (k === '0') { e.preventDefault(); this._setZoom(1); return; }
    // anything else typed while the planner is open does nothing (and never reaches the machine)
    if (k.length === 1 && e.target === this.el.sheet) e.preventDefault();
  }

  _trapTab(e) {
    const f = [...this.el.sheet.querySelectorAll('button, input, [tabindex="0"]')]
      .filter(x => !x.disabled && x.tabIndex >= 0 && x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === this.el.sheet)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  // ------------------------------------------------------------------ tools and settings
  setTool(id) {
    if (!TOOLS.find(t => t.id === id)) return;
    this._cancelGesture();
    this.tool = id;
    if (this.selected) {
      const s = this._shape(this.selected);
      if (!s || (id !== s.type)) this.selected = null;
    }
    if (id === 'picture' && !this.selected) {
      const pics = this.shapes.filter(s => s.type === 'picture');
      if (pics.length) this.selected = pics[pics.length - 1].id;
    }
    this.el.page.dataset.tool = id;
    this._syncPanel();
    const tb = this.el.toolBtns[id];
    if (tb && this.el.tools.scrollWidth > this.el.tools.clientWidth + 2) {
      const r = tb.getBoundingClientRect(), tr = this.el.tools.getBoundingClientRect();
      if (r.left < tr.left || r.right > tr.right) this.el.tools.scrollLeft += r.left - tr.left - (tr.width - r.width) / 2;
    }
    this._updateFrames();
    this._drawGuides();
  }

  setView(v) {
    this.view = v;
    this._syncPanel();
    this._drawGuides();
    this._drawInk();
  }

  _setBrush(patch) {
    Object.assign(this.brush, patch);
    const sel = this._shape(this.selected);
    if (sel && (sel.type === 'picture' || sel.type === 'banner') && ('ink' in patch || 'pressure' in patch)) {
      const p = {};
      if ('ink' in patch) p.ink = patch.ink;
      if ('pressure' in patch) p.pressure = patch.pressure;
      this._editShape(sel.id, p);
    }
    this._syncPanel();
  }

  _brushProps() {
    const b = this.brush;
    return { glyph: b.glyph, ink: b.ink, pressure: b.pressure, halfStep: b.halfStep };
  }

  _syncPanel() {
    const el = this.el;
    const tool = TOOLS.find(t => t.id === this.tool);
    for (const [id, b] of Object.entries(el.toolBtns)) {
      const on = id === this.tool;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    el.panelTitle.textContent = tool.name;
    el.hint.textContent = tool.hint;
    for (const s of el.sections) s.hidden = !s.dataset.tools.split(' ').includes(this.tool);
    const sel = this._shape(this.selected);
    const setRadio = (group, attr, v) => {
      for (const b of group.querySelectorAll(`[${attr}]`)) {
        const on = b.getAttribute(attr) === String(v);
        b.setAttribute('aria-checked', String(on));
        b.classList.toggle('is-on', on);
      }
    };
    setRadio(el.keys, 'data-glyph', this.brush.glyph);
    setRadio(el.view, 'data-view', this.view);
    const inkNow = sel && (sel.type === 'picture' || sel.type === 'banner') ? sel.ink : this.brush.ink;
    const pressNow = sel && (sel.type === 'picture' || sel.type === 'banner') ? sel.pressure : this.brush.pressure;
    setRadio(el.inks, 'data-ink', inkNow);
    setRadio(el.strike, 'data-v', pressNow);
    el.half._input.checked = !!this.brush.halfStep;
    el.tone._input.value = this.brush.shade;
    el.toneRamp.parentElement.hidden = this.tool !== 'fill' || this.brush.glyph !== 'auto';
    // picture
    const pic = sel && sel.type === 'picture' ? sel : null;
    el.picOpts.hidden = this.tool !== 'picture' || !pic;
    // with a picture selected its own controls come first, the chooser last
    el.picOpts.style.order = pic ? '-1' : '';
    el.picChooser.style.order = pic ? '5' : '-1';
    el.picChooser.querySelector('.pl-label').textContent = pic ? 'Another picture' : 'Pictures';
    if (pic) {
      setRadio(el.picStyle, 'data-v', pic.style);
      el.picCols._input.value = pic.cols;
      el.picContrast._input.value = pic.contrast;
      el.picBright._input.value = pic.brightness;
      el.picHatch._input.value = pic.hatch ?? 0.35;
      el.picHatch.hidden = pic.style !== 'line';
      el.picHalf.hidden = pic.style === 'stipple';
      el.picHalf._input.checked = !!pic.halfRows;
      el.picInvert._input.checked = !!pic.invert;
    }
    for (const b of el.samples.querySelectorAll('.pl-sample')) {
      const on = !!(pic && this.sources.get(pic.src) && this.sources.get(pic.src).sampleId === b.dataset.sample);
      b.classList.toggle('is-on', on);
    }
    // banner
    const ban = sel && sel.type === 'banner' ? sel : null;
    const bo = ban || this.bannerDefaults;
    if (document.activeElement !== el.bText) el.bText.value = bo.text;
    setRadio(el.bGlyph, 'data-glyph', bo.glyph);
    setRadio(el.bSize, 'data-v', bo.size);
    el.bOpts.hidden = this.tool !== 'banner' || !ban;
    const bs = art.bannerSize(bo.text || ' ', { size: bo.size });
    el.bInfo.textContent = `${bs.cols} columns x ${bs.rows} lines${bs.cols > COLS ? ' (wider than the page: shorten it or pick a smaller size)' : ''}`;
    el.undo.disabled = !this.undoStack.length;
    el.redo.disabled = !this.redoStack.length;
    el.clear.disabled = !this.shapes.length;
    this._refreshSliderLabels();
    this._drawToneRamp();
  }

  _refreshSliderLabels() {
    const el = this.el;
    const sel = this._shape(this.selected);
    el.tone._out.textContent = Math.round(this.brush.shade * 100) + '%';
    if (sel && sel.type === 'picture') {
      el.picCols._out.textContent = `${sel.cols} col`;
      const f = v => (v > 0 ? '+' : '') + Math.round(v * 100);
      el.picContrast._out.textContent = f(sel.contrast);
      el.picBright._out.textContent = f(sel.brightness);
      el.picHatch._out.textContent = Math.round((sel.hatch ?? 0.35) * 100) + '%';
    }
  }

  _drawToneRamp() {
    const box = this.el.toneRamp;
    if (box.parentElement.hidden) return;
    const ramp = this.ramp || art.rampSync(this.typeface);
    const t = this.brush.shade;
    const pick = ramp.reduce((best, r) => (Math.abs(r.density - t) < Math.abs(best.density - t) ? r : best), ramp[0]);
    box.textContent = '';
    for (const r of ramp.slice(1)) {
      box.append(h('span', { class: 'pl-rampcell' + (r === pick ? ' is-on' : ''), title: r.glyphs.join(' over ') }, r.glyphs.join('')));
    }
  }

  // ------------------------------------------------------------------ shapes and history
  _shape(id) { return id ? this.shapes.find(s => s.id === id) || null : null; }

  _commit(next) {
    this.undoStack.push(this.shapes);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.shapes = next;
    this._coalesce = null;
    this._afterChange();
  }

  _afterChange() {
    if (this.selected && !this._shape(this.selected)) this.selected = null;
    this._replan();
    this._syncPanel();
  }

  // edit one shape; `live` edits (slider drags) share one undo step until the drag ends
  _editShape(id, patch, live = false) {
    const i = this.shapes.findIndex(s => s.id === id);
    if (i < 0) return;
    const next = this.shapes.slice();
    next[i] = { ...next[i], ...patch };
    const key = id + ':' + Object.keys(patch).join(',');
    if (this._coalesce === key) {
      this.shapes = next;
      this._afterChange();
    } else {
      this._commit(next);
      this._coalesce = key;
    }
    if (!live) this._coalesce = null;
  }

  undo() {
    if (!this.undoStack.length) return;
    this._cancelGesture();
    this.redoStack.push(this.shapes);
    this.shapes = this.undoStack.pop();
    this._coalesce = null;
    this._afterChange();
  }

  redo() {
    if (!this.redoStack.length) return;
    this._cancelGesture();
    this.undoStack.push(this.shapes);
    this.shapes = this.redoStack.pop();
    this._coalesce = null;
    this._afterChange();
  }

  _clear() {
    if (!this.shapes.length) return;
    this._commit([]);
    this.selected = null;
    this._toast('Plan cleared. Ctrl+Z brings it back.');
  }

  _removeSelected() {
    const s = this._shape(this.selected);
    if (!s) return;
    this.selected = null;
    this._commit(this.shapes.filter(x => x.id !== s.id));
  }

  _select(id) {
    this.selected = id;
    this._syncPanel();
    this._updateFrames();
    this._drawGuides();
  }

  // ------------------------------------------------------------------ pictures
  _source(desc) {
    if (desc.kind === 'sample') {
      const id = 'sample:' + desc.id;
      if (!this.sources.has(id)) {
        const s = art.SAMPLES.find(x => x.id === desc.id);
        if (!s) return null;
        const cv = document.createElement('canvas');
        cv.width = 480; cv.height = Math.round(480 / s.aspect);
        s.draw(cv.getContext('2d'), cv.width, cv.height);
        this.sources.set(id, { id, kind: 'sample', sampleId: s.id, name: s.name, aspect: s.aspect, sample: s, guide: cv });
      }
      return this.sources.get(id);
    }
    return this.sources.get(desc.id) || null;
  }

  async _loadFile(file) {
    try {
      const bmp = await createImageBitmap(file);
      const id = 'file:' + newId();
      // keep a bounded copy (the original stays only in memory, in this browser)
      const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(bmp.width * k)); cv.height = Math.max(1, Math.round(bmp.height * k));
      const c = cv.getContext('2d');
      c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height);
      c.drawImage(bmp, 0, 0, cv.width, cv.height);
      if (bmp.close) bmp.close();
      this.sources.set(id, { id, kind: 'file', name: file.name || 'Picture', aspect: cv.width / cv.height, image: cv, guide: cv });
      this._addPicture({ kind: 'file', id });
    } catch (e) {
      this._toast('That file could not be read as a picture.');
    }
  }

  _addPicture(desc) {
    const src = this._source(desc);
    if (!src) return;
    const sel = this._shape(this.selected);
    if (sel && sel.type === 'picture') {                    // swap the picture in the selected frame
      this._editShape(sel.id, { src: src.id, cols: this._fitCols(sel.cols, src.aspect, sel.y) });
      return;
    }
    const d = this.picDefaults;
    let cols = this._fitCols(56, src.aspect, 4);
    const rows = art.pictureRows(1000, 1000 / src.aspect, cols);
    const x = Math.round((COLS - cols) / 2);
    const y = Math.max(2, Math.min(Math.round((ROWS - rows) / 2) - 4, 8));
    const shape = { id: newId(), type: 'picture', src: src.id, x, y, cols, style: d.style, contrast: d.contrast, brightness: d.brightness,
      invert: d.invert, hatch: d.hatch, halfRows: d.style === 'shade', ink: this.brush.ink, pressure: this.brush.pressure };
    this.selected = shape.id;
    this._commit(this.shapes.concat([shape]));
    this._toast(`${src.name}: drag it into place, pull a corner to resize.`);
  }

  _fitCols(cols, aspect, y) {
    let c = Math.max(10, Math.min(COLS - 2, Math.round(cols)));
    while (c > 10 && art.pictureRows(1000, 1000 / aspect, c) > ROWS - Math.max(1, y) - 1) c--;
    return c;
  }

  _picRows(s) {
    const src = this.sources.get(s.src);
    return art.pictureRows(1000, 1000 / (src ? src.aspect : 1), s.cols);
  }

  _editPicture(patch, live = false) {
    const s = this._shape(this.selected);
    if (s && s.type === 'picture') {
      if ('cols' in patch) {
        const src = this.sources.get(s.src);
        patch.cols = this._fitCols(patch.cols, src ? src.aspect : 1, s.y);
        if (s.x + patch.cols > COLS) patch.x = Math.max(0, COLS - patch.cols);
      }
      this._editShape(s.id, patch, live);
    } else {
      Object.assign(this.picDefaults, patch);
    }
  }

  _imageData(src, width) {
    const key = src.id + '@' + width;
    let img = this._imgCache.get(key);
    if (!img) {
      img = art.pictureImageData(src.sample || src.image, width, src.aspect);
      if (this._imgCache.size > 24) this._imgCache.clear();
      this._imgCache.set(key, img);
    }
    return img;
  }

  // the picture converted at the origin (cached), then moved into place
  _pictureStrikes(s) {
    const src = this.sources.get(s.src);
    if (!src) return [];
    const opt = { cols: s.cols, style: s.style, contrast: s.contrast, brightness: s.brightness, invert: !!s.invert, hatch: s.hatch ?? 0.35,
      halfRows: s.style === 'stipple' ? false : !!s.halfRows, ink: s.ink, pressure: s.pressure, typeface: this.typeface };
    const key = src.id + '|' + JSON.stringify(opt);
    let base = this._picCache.get(key);
    if (!base) {
      const img = this._imageData(src, Math.min(1200, Math.max(160, s.cols * 8)));
      base = art.imageToStrikes(img, { ...opt, x0: 0, y0: 0, ramp: this.ramp, pageCols: 1e6, pageRows: 1e6 });
      if (this._picCache.size > 40) this._picCache.clear();
      this._picCache.set(key, base);
    }
    return base.map(t => ({ ...t, x: t.x + s.x, y: t.y + s.y }));
  }

  // ------------------------------------------------------------------ banners
  _editBanner(patch, live = false) {
    const s = this._shape(this.selected);
    if (s && s.type === 'banner') this._editShape(s.id, patch, live);
    else { Object.assign(this.bannerDefaults, patch); this._syncPanel(); }
  }

  _placeBanner(p) {
    const d = this.bannerDefaults;
    const text = (this.el.bText.value || d.text || '').trim() || 'HELLO';
    const size = art.bannerSize(text, { size: d.size });
    // start where clicked; nudge back onto the page only when the banner would then fit
    let x = clamp(Math.floor(p.x), 0, COLS - 1), y = clamp(Math.floor(p.y), 0, ROWS - 1);
    if (size.cols <= COLS) x = Math.min(x, COLS - size.cols);
    if (size.rows <= ROWS) y = Math.min(y, ROWS - size.rows);
    if (size.cols > COLS) this._toast('That banner is wider than the page; the end will be cut off. Try a smaller size.');
    const shape = { id: newId(), type: 'banner', text, glyph: d.glyph, size: d.size, x, y, ink: this.brush.ink, pressure: this.brush.pressure };
    this.selected = shape.id;
    this._commit(this.shapes.concat([shape]));
    return shape;
  }

  // ------------------------------------------------------------------ planning
  _plan() {
    const shapes = this.draft ? this.shapes.concat([this.draft]) : this.shapes;
    const prepared = shapes.map(s => (s.type === 'picture' ? { id: s.id, type: 'strikes', strikes: this._pictureStrikes(s) } : s));
    const res = art.rasterizeShapes(prepared, { typeface: this.typeface, ramp: this.ramp });
    this._perShape = res.perShape;
    this._planned = art.orderStrikes(res.strikes);
    return res;
  }

  _replan() {
    if (!this._open) return;
    if (this.shapes.some(x => x.type === 'picture' || (x.type === 'fill' && (!x.glyph || x.glyph === 'auto')))) this._ensureRamp();
    this._plan();
    this._updateCount();
    this._updateFrames();
    this._drawGuides();
    this._schedulePreview();
  }

  _updateCount() {
    const n = this._planned.length;
    if (!n) this.el.count.textContent = 'Nothing planned yet';
    else {
      const sec = art.estimateSeconds(this._planned);
      this.el.count.innerHTML = `<b>${n.toLocaleString('en-US')}</b> strike${n === 1 ? '' : 's'} <span class="pl-dot">·</span> ${art.formatDuration(sec)} of typing`;
    }
    this.el.commit.disabled = !n || !!this.draft;
    this.el.guideBtn.disabled = !n || !!this.draft;
  }

  // ------------------------------------------------------------------ ink rendering
  // surface resolution for the page as shown (zoom included), in a few steps so zooming
  // re-renders the ink only when it would otherwise look soft
  _surfaceScale() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = (this._fitW || 700) * this.zoom;
    const want = w * dpr * 1.1 / art.PAGE.W;
    return [0.35, 0.5, 0.7].find(s => s >= want) || 0.7;    // 0.7 keeps two surfaces near 70 MB
  }

  _maybeRescale() {
    if (!this.base || !this._open) return;
    const s = this._surfaceScale();
    if (s === this.base.scale) return;
    clearTimeout(this._rescaleTimer);
    this._rescaleTimer = setTimeout(() => {
      if (!this._open || this._surfaceScale() === this.base.scale) return;
      this._renderBase();
      this._schedulePreview();
    }, 260);
  }

  _renderBase() {
    const page = val(this.opts.getPage) || { paper: 'ivory', strikes: [], ghosts: [] };
    this._page = page;
    const paper = page.paper || 'ivory';
    if (!this.PageSurface) return;
    const scale = this._surfaceScale();
    if (!this.base || this.base.scale !== scale) {
      if (this.base && this.base.dispose) this.base.dispose();
      if (this.preview && this.preview.dispose) this.preview.dispose();
      this.base = new this.PageSurface({ paper, scale });
      this.preview = new this.PageSurface({ paper, scale });
    } else {
      if (this.base.paper !== paper) this.base.setPaper(paper);
      if (this.preview.paper !== paper) this.preview.setPaper(paper);
    }
    this._existing = (page.strikes || []).filter(s => !s.g);
    this._ghosts = (page.ghosts || []).concat((page.strikes || []).filter(s => s.g));
    this.base.render(this._existing, this._ghosts);
    this.preview.render(this._existing, this._ghosts);
    this._shown = new Map();
    this.el.ink.width = this.base.width;
    this.el.ink.height = this.base.height;
    this._drawInk();
  }

  _seeded() {
    const count = new Map();
    return this._planned.map(st => {
      const cell = st.x + ',' + st.y;
      const n = (count.get(cell) || 0);
      count.set(cell, n + 1);
      const key = `${st.c}|${st.x}|${st.y}|${st.k}|${st.p}|${st.f}|${n}`;
      return { key, s: { ...st, s: hash32('plan', key), w: 0.12 } };
    });
  }

  _schedulePreview() {
    if (this._pvRaf) return;
    this._pvRaf = requestAnimationFrame(() => { this._pvRaf = 0; this._updatePreview(); });
  }

  _updatePreview() {
    if (!this.preview || !this._open) return;
    const items = this._seeded();
    const next = new Map(items.map(it => [it.key, it.s]));
    const added = [], removed = [];
    for (const [k, s] of next) if (!this._shown.has(k)) added.push(s);
    for (const [k, s] of this._shown) if (!next.has(k)) removed.push(s);
    if (!added.length && !removed.length) return;
    const P = this.preview;
    const all = this._existing.concat(items.map(it => it.s));
    let rect = null;
    for (const s of added.concat(removed)) rect = unionRect(rect, strikeRectPx(s, P.scale, P.width, P.height));
    if (rect && rect.w * rect.h > P.width * P.height * 0.45) P.render(all, this._ghosts);
    else if (!removed.length && added.length < 80) for (const s of added) P.add(s);
    else if (rect) P.redraw(rect, all, this._ghosts);
    this._shown = next;
    this._drawInk();
  }

  _drawInk() {
    const c = this.ictx;
    if (!this.base) {
      const cv = this.el.ink;
      if (cv.width !== 340) { cv.width = 340; cv.height = 440; }
      c.fillStyle = '#f4eddc'; c.fillRect(0, 0, cv.width, cv.height);
      return;
    }
    c.globalAlpha = 1;
    c.drawImage(this.base.canvas, 0, 0);
    if (this.view !== 'pencil' && this._planned.length) {
      c.globalAlpha = this.view === 'ink' ? 1 : 0.62;
      c.drawImage(this.preview.canvas, 0, 0);
      c.globalAlpha = 1;
    }
  }

  // ------------------------------------------------------------------ layout and zoom
  _layout() {
    const st = this.el.stage;
    const pad = window.innerWidth < 760 ? 10 : 22;
    const sw = Math.max(120, st.clientWidth - pad * 2), sh = Math.max(160, st.clientHeight - pad * 2);
    const fitW = Math.min(sw, sh * PAGE_ASPECT);
    this._fitW = fitW;
    const w = Math.round(fitW * this.zoom), hh = Math.round(fitW / PAGE_ASPECT * this.zoom);
    const pg = this.el.page;
    pg.style.width = w + 'px';
    pg.style.height = hh + 'px';
    this._cw = w / COLS; this._ch = hh / ROWS;
    pg.style.setProperty('--cw', this._cw + 'px');
    pg.style.setProperty('--ch', this._ch + 'px');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const gw = Math.min(4096, Math.round(w * dpr)), gh = Math.min(4096, Math.round(hh * dpr));
    if (this.el.guides.width !== gw || this.el.guides.height !== gh) { this.el.guides.width = gw; this.el.guides.height = gh; }
    this.el.zoomLabel.textContent = Math.round(this.zoom * 100) + '%';
    this._drawGuides();
    this._updateFrames();
    this._maybeRescale();
  }

  _setZoom(z, cx, cy) {
    z = clamp(z, 1, 5);
    const st = this.el.stage;
    const r0 = this.el.page.getBoundingClientRect();
    const sr = st.getBoundingClientRect();
    if (cx == null) { cx = sr.left + sr.width / 2; cy = sr.top + sr.height / 2; }
    const fx = (cx - r0.left) / r0.width, fy = (cy - r0.top) / r0.height;
    this.zoom = z;
    this._layout();
    const r1 = this.el.page.getBoundingClientRect();
    st.scrollLeft += (r1.left + fx * r1.width) - cx;
    st.scrollTop += (r1.top + fy * r1.height) - cy;
  }
  _zoomBy(f) { this._setZoom(this.zoom * f); }
  _zoomAt(z, cx, cy) { this._setZoom(z, cx, cy); }

  // ------------------------------------------------------------------ pointer input
  _cell(e) {
    const r = this.el.page.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * COLS, y: (e.clientY - r.top) / r.height * ROWS };
  }

  _snap(p, s) { return { x: Math.floor(p.x / s) * s, y: Math.floor(p.y / s) * s }; }

  _down(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this._pointers.size === 2) { this._startPinch(); return; }
    if (this._pointers.size > 2 || this._pinch) return;
    e.preventDefault();
    try { this.el.page.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (document.activeElement && this.root.contains(document.activeElement) && document.activeElement.blur && document.activeElement !== this.el.sheet) {
      if (document.activeElement === this.el.bText) this._editBanner({ text: this.el.bText.value });
      this.el.sheet.focus({ preventScroll: true });
    }
    const p = this._cell(e);
    const s = this.brush.halfStep ? 0.5 : 1;
    const g = this._gesture = { id: e.pointerId, start: p, last: p, before: this.shapes, changed: false, kind: null };
    this.el.page.classList.add('is-drawing');
    switch (this.tool) {
      case 'pencil':
        g.kind = 'draft';
        this.draft = { id: newId(), type: 'pencil', points: [[p.x, p.y]], ...this._brushProps() };
        break;
      case 'line':
        g.kind = 'draft';
        this.draft = { id: newId(), type: 'line', x1: p.x, y1: p.y, x2: p.x, y2: p.y, ...this._brushProps() };
        break;
      case 'rect':
      case 'ellipse': {
        g.kind = 'draft';
        g.anchor = this._snap(p, s);
        this.draft = { id: newId(), type: this.tool, x: g.anchor.x, y: g.anchor.y, w: s, h: s, ...this._brushProps() };
        break;
      }
      case 'fill':
        g.kind = 'tap';
        g.filled = this._fillAt(p);
        break;
      case 'eraser':
        g.kind = 'erase';
        this._eraseAt(p);
        break;
      case 'picture':
      case 'banner': {
        const handle = e.target && e.target.dataset && e.target.dataset.handle;
        const hit = handle ? this._shape(this.selected) : this._frameAt(p, this.tool);
        if (hit) {
          this.selected = hit.id;
          g.kind = handle ? 'resize' : 'move';
          g.handle = handle;
          g.orig = { ...hit };
          this._syncPanel();
          this._updateFrames();
        } else if (this.tool === 'banner') {
          const b = this._placeBanner(p);
          g.kind = 'move';
          g.orig = { ...b };
          g.before = this.shapes;
        } else {
          this.selected = null;
          this._syncPanel();
          this._updateFrames();
          if (!this.shapes.some(x => x.type === 'picture')) this._toast('Choose a picture on the right first.');
        }
        break;
      }
    }
    this._replan();
  }

  _move(e) {
    if (this._pointers.has(e.pointerId)) this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this._pinch) { this._movePinch(); return; }
    const p = this._cell(e);
    const g = this._gesture;
    if (!g || g.id !== e.pointerId) { this._hoverAt(p, e); return; }
    const s = this.brush.halfStep ? 0.5 : 1;
    g.last = p;
    const d = this.draft;
    switch (g.kind) {
      case 'draft':
        if (d.type === 'pencil') {
          const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
          for (const ev of (evs.length ? evs : [e])) {
            const q = this._cell(ev);
            const lastP = d.points[d.points.length - 1];
            if (Math.hypot((q.x - lastP[0]) * art.CELL_W, q.y - lastP[1]) >= 0.18) d.points.push([q.x, q.y]);
          }
          this.draft = { ...d };
        } else if (d.type === 'line') {
          let x2 = p.x, y2 = p.y;
          if (e.shiftKey) {
            const dx = (x2 - d.x1) * art.CELL_W, dy = y2 - d.y1;
            const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
            x2 = d.x1 + Math.cos(a) * len / art.CELL_W; y2 = d.y1 + Math.sin(a) * len;
          }
          this.draft = { ...d, x2, y2 };
        } else {
          const c = this._snap(p, s), a = g.anchor;
          let x = Math.min(a.x, c.x), y = Math.min(a.y, c.y);
          let w = Math.abs(c.x - a.x) + s, hh = Math.abs(c.y - a.y) + s;
          if (e.shiftKey && d.type === 'ellipse') {
            hh = Math.max(s, Math.round(w * art.CELL_W / s) * s);
            if (c.y < a.y) y = a.y - hh + s;
          }
          this.draft = { ...d, x, y, w, h: hh };
        }
        this._replan();
        break;
      case 'erase':
        this._eraseAt(p);
        break;
      case 'move': {
        const sh = this._shape(this.selected);
        if (!sh) break;
        const dx = Math.round(p.x - g.start.x), dy = Math.round(p.y - g.start.y);
        const size = sh.type === 'picture' ? { cols: sh.cols, rows: this._picRows(sh) } : art.bannerSize(sh.text, { size: sh.size });
        const nx = clamp(g.orig.x + dx, -Math.floor(size.cols / 2), COLS - Math.ceil(size.cols / 2));
        const ny = clamp(g.orig.y + dy, -Math.floor(size.rows / 2), ROWS - Math.ceil(size.rows / 2));
        if (nx !== sh.x || ny !== sh.y) { this._liveReplace({ ...sh, x: nx, y: ny }); g.changed = true; }
        break;
      }
      case 'resize': {
        const sh = this._shape(this.selected);
        if (!sh || sh.type !== 'picture') break;
        const src = this.sources.get(sh.src);
        const left = g.handle === 'nw' || g.handle === 'sw';
        const top = g.handle === 'nw' || g.handle === 'ne';
        const right0 = g.orig.x + g.orig.cols;
        let cols = left ? Math.round(right0 - p.x) : Math.round(p.x - g.orig.x);
        cols = clamp(cols, 10, COLS);
        cols = this._fitCols(cols, src ? src.aspect : 1, 0);
        const rows = art.pictureRows(1000, 1000 / (src ? src.aspect : 1), cols);
        const rows0 = art.pictureRows(1000, 1000 / (src ? src.aspect : 1), g.orig.cols);
        const x = left ? right0 - cols : g.orig.x;
        const y = top ? g.orig.y + rows0 - rows : g.orig.y;
        if (cols !== sh.cols || x !== sh.x || y !== sh.y) { this._liveReplace({ ...sh, cols, x, y }); g.changed = true; }
        break;
      }
      default: break;
    }
  }

  _liveReplace(shape) {
    this.shapes = this.shapes.map(s => (s.id === shape.id ? shape : s));
    this._replan();
    this._refreshSliderLabels();
  }

  _up(e, cancelled = false) {
    this._pointers.delete(e.pointerId);
    if (this._pinch) { if (this._pointers.size < 2) this._pinch = null; return; }
    const g = this._gesture;
    if (!g || g.id !== e.pointerId) return;
    this._gesture = null;
    this.el.page.classList.remove('is-drawing');
    if (cancelled) { this._cancelGesture(g); this._replan(); return; }
    if (g.kind === 'draft' && this.draft) {
      const d = this.draft;
      this.draft = null;
      this._commit(this.shapes.concat([d]));
    } else if ((g.kind === 'move' || g.kind === 'resize' || g.kind === 'erase') && g.changed) {
      const now = this.shapes;
      this.shapes = g.before;
      this._commit(now);
    } else {
      this._replan();
      this._syncPanel();
    }
  }

  _cancelGesture(g = this._gesture) {
    if (g && (g.kind === 'move' || g.kind === 'resize' || g.kind === 'erase') && g.changed) this.shapes = g.before;
    this._gesture = null;
    this.draft = null;
    if (this.el) this.el.page.classList.remove('is-drawing');
  }

  _startPinch() {
    // a second finger: drop whatever the first one started and pan / zoom instead
    const g = this._gesture;
    if (g) this._cancelGesture(g);
    if (g && g.kind === 'tap' && g.filled) this.undo();            // a fill placed by the first finger
    const pts = [...this._pointers.values()];
    this._pointers = new Map([...this._pointers.entries()].slice(0, 2));
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    this._pinch = { d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1, z0: this.zoom, mid };
    this.el.page.classList.remove('is-drawing');
    this._replan();
  }

  _movePinch() {
    const pts = [...this._pointers.values()];
    if (pts.length < 2) return;
    const P = this._pinch;
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    const st = this.el.stage;
    st.scrollLeft -= mid.x - P.mid.x;
    st.scrollTop -= mid.y - P.mid.y;
    P.mid = mid;
    const z = clamp(P.z0 * d / P.d0, 1, 5);
    if (Math.abs(z - this.zoom) > 0.01) this._setZoom(z, mid.x, mid.y);
  }

  _hoverAt(p, e) {
    if (e.pointerType === 'touch') return;
    if (this.tool === 'eraser') {
      const hit = this._shapeAt(p);
      const id = hit ? hit.id : null;
      if (id !== this.hover) { this.hover = id; this._drawGuides(); }
      this._hideCursor();
      return;
    }
    if (this.tool === 'picture' || this.tool === 'banner') { this._hideCursor(); return; }
    const s = this.brush.halfStep ? 0.5 : 1;
    const c = this._snap(p, s);
    if (c.x < 0 || c.y < 0 || c.x >= COLS || c.y >= ROWS) { this._hideCursor(); return; }
    const cur = this.el.cursor;
    cur.style.left = (c.x / COLS * 100) + '%';
    cur.style.top = (c.y / ROWS * 100) + '%';
    cur.textContent = this.brush.glyph === 'auto' ? '' : this.brush.glyph;
    cur.classList.add('is-on');
  }

  _hideCursor() { this.el.cursor.classList.remove('is-on'); }

  // topmost shape whose strikes (or frame) are under p
  _shapeAt(p) {
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      const s = this.shapes[i];
      if (s.type === 'picture' || s.type === 'banner') {
        if (this._frameAt(p, s.type, s)) return s;
        continue;
      }
      const res = this._perShape[i];
      if (!res) continue;
      for (const st of res.strikes) {
        if (Math.abs(st.x + 0.5 - p.x) <= 0.85 && Math.abs(st.y + 0.5 - p.y) <= 0.75) return s;
      }
    }
    return null;
  }

  _frameRect(s) {
    if (s.type === 'picture') return { x: s.x, y: s.y, w: s.cols, h: this._picRows(s) };
    const b = art.bannerSize(s.text || ' ', { size: s.size });
    return { x: s.x, y: s.y, w: b.cols, h: b.rows };
  }

  _frameAt(p, type, only) {
    const list = only ? [only] : this.shapes.slice().reverse();
    for (const s of list) {
      if (s.type !== type) continue;
      const r = this._frameRect(s);
      if (p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h) return s;
    }
    return null;
  }

  _eraseAt(p) {
    const hit = this._shapeAt(p);
    if (!hit) return;
    this.shapes = this.shapes.filter(s => s.id !== hit.id);
    if (this._gesture) this._gesture.changed = true;
    if (this.selected === hit.id) this.selected = null;
    this.hover = null;
    this._replan();
  }

  _fillAt(p) {
    if (p.x < 0 || p.y < 0 || p.x >= COLS || p.y >= ROWS) return false;
    // the topmost closed outline around the point
    let of = null;
    for (let i = this.shapes.length - 1; i >= 0 && !of; i--) {
      const s = this.shapes[i];
      if (s.type === 'rect' && p.x >= s.x && p.x < s.x + s.w && p.y >= s.y && p.y < s.y + s.h) of = { type: 'rect', x: s.x, y: s.y, w: s.w, h: s.h };
      else if (s.type === 'ellipse') {
        const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
        if (((p.x - cx) / (s.w / 2)) ** 2 + ((p.y - cy) / (s.h / 2)) ** 2 <= 1) of = { type: 'ellipse', x: s.x, y: s.y, w: s.w, h: s.h };
      } else if (s.type === 'pencil' && s.points.length > 6) {
        const a = s.points[0], b = s.points[s.points.length - 1];
        if (Math.hypot((a[0] - b[0]) * art.CELL_W, a[1] - b[1]) < 2.2) {
          const poly = { type: 'polygon', points: s.points };
          if (pointInPoly(p, s.points)) of = poly;
        }
      }
    }
    const fill = { id: newId(), type: 'fill', ...this._brushProps(), shade: this.brush.shade };
    if (of) fill.of = of; else fill.at = [p.x, p.y];
    const test = art.rasterizeShapes(this.shapes.concat([fill]), { typeface: this.typeface, ramp: this.ramp });
    const mine = test.perShape[test.perShape.length - 1];
    if (!mine.ok || !mine.strikes.length) {
      this._toast(mine.reason === 'open' ? 'That area is open. Close the outline first, or fill inside a box or an oval.'
        : 'Nothing to fill there.');
      return false;
    }
    this._commit(this.shapes.concat([fill]));
    return true;
  }

  // ------------------------------------------------------------------ guides (pencil layer)
  _drawGuides() {
    const c = this.gctx;
    const cv = this.el.guides;
    if (!c || !cv.width) return;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, cv.width, cv.height);
    const sx = cv.width / COLS, sy = cv.height / ROWS;
    const px = x => x * sx, py = y => y * sy;
    const dpr = cv.width / Math.max(1, this.el.page.clientWidth || cv.width);
    const pencilOn = this.view !== 'ink';
    const shapes = this.draft ? this.shapes.concat([this.draft]) : this.shapes;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    shapes.forEach((s, i) => {
      const isHover = this.hover === s.id;
      if (!pencilOn && !isHover) return;
      if (s.type === 'picture') {
        const src = this.sources.get(s.src);
        if (src && src.guide && pencilOn) {
          const r = this._frameRect(s);
          c.save();
          c.globalAlpha = this.view === 'pencil' ? 0.42 : this.tool === 'picture' ? 0.16 : 0;
          c.filter = 'grayscale(1) contrast(0.9)';
          c.drawImage(src.guide, px(r.x), py(r.y), px(r.w), py(r.h));
          c.restore();
        }
        if (isHover) this._outlineCells(c, this._perShape[i], sx, sy, 'rgba(106,35,40,0.5)');
        return;
      }
      const color = isHover ? 'rgba(106, 35, 40, 0.9)' : 'rgba(64, 62, 60, 0.62)';
      const lw = Math.max(1, (isHover ? 2.2 : 1.25) * dpr);
      const st = shapeStep(s);
      const path = () => {
        c.beginPath();
        if (s.type === 'pencil') {
          s.points.forEach(([x, y], k) => (k ? c.lineTo(px(x), py(y)) : c.moveTo(px(x), py(y))));
          if (s.points.length === 1) c.lineTo(px(s.points[0][0]) + 0.5, py(s.points[0][1]));
        } else if (s.type === 'line') {
          c.moveTo(px(s.x1), py(s.y1)); c.lineTo(px(s.x2), py(s.y2));
        } else if (s.type === 'rect') {
          c.rect(px(s.x + st / 2), py(s.y + st / 2), px(s.w - st), py(s.h - st));
        } else if (s.type === 'ellipse') {
          c.ellipse(px(s.x + s.w / 2), py(s.y + s.h / 2), Math.max(0.5, px(s.w / 2 - st / 2)), Math.max(0.5, py(s.h / 2 - st / 2)), 0, 0, Math.PI * 2);
        }
      };
      if (s.type === 'fill' || s.type === 'banner') {
        const res = this._perShape[i];
        if (!res) return;
        c.fillStyle = isHover ? 'rgba(106,35,40,0.45)' : (s.type === 'banner' ? 'rgba(64,62,60,0.2)' : 'rgba(64,62,60,0.16)');
        const seen = new Set();
        for (const t of res.strikes) {
          const k = t.x + ',' + t.y;
          if (seen.has(k)) continue;
          seen.add(k);
          const w = (s.halfStep ? 0.5 : 1);
          c.fillRect(px(t.x) + 1, py(t.y) + 1, Math.max(1, px(w) - 2), Math.max(1, py(w) - 2));
        }
        return;
      }
      // graphite: a firm stroke plus a faint grainy second pass
      c.strokeStyle = color;
      c.lineWidth = lw;
      path(); c.stroke();
      if (!isHover) {
        c.save();
        c.globalAlpha = 0.35;
        c.lineWidth = lw * 2.2;
        c.setLineDash([lw * 0.6, lw * 1.7]);
        path(); c.stroke();
        c.restore();
      }
    });
  }

  _outlineCells(c, res, sx, sy, color) {
    if (!res) return;
    c.fillStyle = color;
    for (const t of res.strikes) c.fillRect(t.x * sx, t.y * sy, sx, sy);
  }

  _updateFrames() {
    const box = this.el.frames;
    const want = this.shapes.filter(s => s.type === 'picture' || s.type === 'banner');
    const have = new Map([...box.children].map(n => [n.dataset.id, n]));
    for (const [id, n] of have) if (!want.find(s => s.id === id)) n.remove();
    for (const s of want) {
      let n = have.get(s.id);
      if (!n) {
        n = h('div', { class: 'pl-frame', 'data-id': s.id },
          ...['nw', 'ne', 'sw', 'se'].map(k => h('span', { class: `pl-handle pl-h-${k}`, 'data-handle': k, 'aria-hidden': 'true' })),
          h('span', { class: 'pl-framelabel' }));
        box.append(n);
      }
      const r = this._frameRect(s);
      n.style.left = (r.x / COLS * 100) + '%';
      n.style.top = (r.y / ROWS * 100) + '%';
      n.style.width = (r.w / COLS * 100) + '%';
      n.style.height = (r.h / ROWS * 100) + '%';
      const active = this.tool === s.type;
      n.classList.toggle('is-active', active);
      n.classList.toggle('is-selected', active && this.selected === s.id);
      n.classList.toggle('is-banner', s.type === 'banner');
      const label = n.querySelector('.pl-framelabel');
      label.textContent = s.type === 'picture' ? `${s.cols} x ${r.h}` : `${r.w} x ${r.h}`;
    }
  }

  // ------------------------------------------------------------------ commit
  _typeIt() {
    if (!this._planned.length || this.draft) return;
    const strikes = art.orderStrikes(this._planned).map(({ c, x, y, k, p, f }) => ({ c, x, y, k, p, f }));
    // the plan is spent; Ctrl+Z in the planner brings it back
    this._commit([]);
    this.selected = null;
    this.close();
    if (typeof this.opts.onCommit === 'function') this.opts.onCommit(strikes);
  }

  // A typewriter Guide for the planned strikes. With an onGuide option the app shows it (and the
  // Planner closes, keeping the plan); otherwise the Planner opens its own Guide on top.
  makeGuide() {
    if (!this._planned.length || this.draft) return null;
    const strikes = art.orderStrikes(this._planned).map(({ c, x, y, k, p, f }) => ({ c, x, y, k, p, f }));
    if (typeof this.opts.onGuide === 'function') {
      const title = this._planTitle();
      this.close();
      this.opts.onGuide(strikes, { title, typeface: this.typeface, paper: this._page && this._page.paper });
      return null;
    }
    if (!this.guide) this.guide = new Guide(this.host, { PageSurface: this.PageSurface });
    return this.guide.open({ strikes, title: this._planTitle(), typeface: this.typeface, paper: this._page && this._page.paper });
  }

  _planTitle() {
    const pics = this.shapes.filter(s => s.type === 'picture'), bans = this.shapes.filter(s => s.type === 'banner');
    if (pics.length === 1 && !bans.length) {
      const src = this.sources.get(pics[0].src);
      return src ? src.name.replace(/\.[a-z0-9]+$/i, '') : 'Your picture';
    }
    if (bans.length && !pics.length) return bans.map(b => b.text).join(' / ');
    return 'Your drawing';
  }

  _toast(msg) {
    const t = this.el.toast;
    t.textContent = msg;
    t.classList.add('is-on');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('is-on'), 3200);
  }

  // ------------------------------------------------------------------ dev / test hooks
  // Replace the plan (used by dev/planner.html to preload states). Shapes as in art.js; pictures
  // as { type: 'picture', sample: 'teacup', x, y, cols, style, ... }.
  load(shapes) {
    const out = [];
    for (const s of shapes) {
      const sh = { id: s.id || newId(), ink: this.brush.ink, pressure: 1, ...s };
      if (s.type === 'picture' && s.sample) {
        const src = this._source({ kind: 'sample', id: s.sample });
        if (!src) continue;
        sh.src = src.id;
        delete sh.sample;
        sh.cols = sh.cols || 50;
        sh.style = sh.style || 'shade';
        sh.contrast = sh.contrast ?? 0; sh.brightness = sh.brightness ?? 0;
        sh.halfRows = sh.halfRows ?? sh.style === 'shade';
      }
      out.push(sh);
    }
    this._commit(out);
  }

  get plannedStrikes() { return this._planned.slice(); }
}

function shapeStep(s) { return s.halfStep ? 0.5 : 1; }

function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p.y) !== (yj > p.y) && p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
