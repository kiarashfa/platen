// Panels, reading view, pages, welcome card. Plain DOM; every control writes through app.set().
import { COLORS, TRIMS, KEYCAPS } from './machine.js';
import { PAPERS, RIBBONS, INKS, TYPEFACES, PageSurface, strikeRect } from './ink.js';
import { separateInk, cropRect, cropData, exportName } from './export.js';
import { MOODS } from './scene.js';
import { LAYOUT, pageText, wordCount, pagesMarkdown } from './page.js';

// mirrors js/audio.js (kept here so the panels work even before the sound engine has loaded)
const PROFILES = [{ id: 'portable', name: 'Portable' }, { id: 'desk', name: 'Desk machine' }];
const AMBIENCES = [{ id: null, name: 'Quiet' }, { id: 'rain', name: 'Rain' }, { id: 'fire', name: 'Fireplace' },
  { id: 'clock', name: 'Mantel clock' }, { id: 'night', name: 'Summer night' }];

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
};

const download = (blob, name) => {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
};

export class UI {
  constructor(app) {
    this.app = app;
    this.drawer = document.getElementById('drawer');
    this.body = document.getElementById('drawerBody');
    this.title = document.getElementById('drawerTitle');
    this.panel = null;
    this.syncers = new Map();
    this.thumbCache = new Map();
    this._bind();
  }

  _bind() {
    const app = this.app;
    document.querySelectorAll('.tool[data-panel]').forEach(b => b.addEventListener('click', () => {
      app.unlockAudio();
      const p = b.dataset.panel;
      if (this.panel === p && this.drawerOpen()) this.closeDrawer(); else this.openDrawer(p);
    }));
    document.getElementById('drawerClose').addEventListener('click', () => this.closeDrawer());
    document.getElementById('btnClose').addEventListener('click', () => app.set('closeup', !app.s.closeup));
    document.getElementById('btnFull').addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.().catch(() => {});
    });
    document.querySelectorAll('.modes button').forEach(b => b.addEventListener('click', () => {
      app.unlockAudio();
      app.set('mode', b.dataset.mode);
      if (b.dataset.mode === 'draw') app.hint('Draw mode: arrows move half steps, click the sheet to place the carriage.', 4200);
    }));
    document.getElementById('ribbonLever').addEventListener('click', () => app.toggleRibbon());
    // draw bar
    document.getElementById('dbPlanner').addEventListener('click', () => { app.unlockAudio(); app.openPlanner(); });
    document.getElementById('dbGuide').addEventListener('click', () => app.openGuide());
    document.getElementById('dbImage').addEventListener('click', () => this.openExport());
    document.getElementById('btnExport').addEventListener('click', () => { app.unlockAudio(); this.openExport(); });
    // save as image dialog
    for (const [id, key, num] of [['exWhat', 'what', false], ['exBg', 'bg', false], ['exSize', 'size', true]]) {
      document.querySelectorAll(`#${id} button`).forEach(b => b.addEventListener('click', () => {
        if (b.disabled) return;
        this.ex[key] = num ? +b.dataset.v : b.dataset.v;
        this._exportPreview();
      }));
    }
    document.querySelectorAll('#exporter [data-ex]').forEach(b => b.addEventListener('click', () => this._exportAct(b.dataset.ex, b)));
    document.getElementById('exporter').addEventListener('click', e => { if (e.target.id === 'exporter') this.closeExport(); });
    document.getElementById('dbOver').addEventListener('click', () => app.set('over', !app.s.over));
    document.getElementById('dbHalf').addEventListener('click', () => app.set('half', !app.s.half));
    document.querySelectorAll('#dbPress button').forEach(b => b.addEventListener('click', () => app.set('pressure', +b.dataset.v)));
    document.querySelectorAll('#dbSpeed button').forEach(b => b.addEventListener('click', () => app.set('speed', +b.dataset.v)));
    document.getElementById('progressStop').addEventListener('click', () => app.stopJob());
    document.getElementById('progressFinish').addEventListener('click', () => app.finishJob());
    // reader
    document.querySelectorAll('#reader [data-act]').forEach(b => b.addEventListener('click', () => this._readerAct(b.dataset.act)));
    document.getElementById('reader').addEventListener('click', e => { if (e.target.id === 'reader') this.closeReader(); });
    document.querySelector('.reader-sheet').addEventListener('dblclick', e => e.currentTarget.classList.toggle('zoomed'));
    document.getElementById('welcomeGo').addEventListener('click', () => this.hideWelcome(true));
    this.sync('mode'); this.sync('over'); this.sync('half'); this.sync('pressure'); this.sync('speed');
  }

  // ------------------------------------------------------------ drawer
  drawerOpen() { return this.drawer.classList.contains('open'); }
  modalOpen() { return document.getElementById('reader').classList.contains('open') || document.getElementById('exporter').classList.contains('open'); }
  welcomeOpen() { return !document.getElementById('welcome').hidden; }

  openDrawer(name) {
    this.panel = name;
    this.syncers.clear();
    this.body.replaceChildren();
    const titles = { machine: 'Machine', sound: 'Sound', writing: 'Writing', pages: 'Pages', help: 'How it works' };
    this.title.textContent = titles[name];
    this['_panel_' + name]();
    this.drawer.classList.add('open');
    this.drawer.setAttribute('aria-hidden', 'false');
    document.querySelectorAll('.tool[data-panel]').forEach(b => b.classList.toggle('on', b.dataset.panel === name));
  }

  closeDrawer() {
    this.drawer.classList.remove('open');
    this.drawer.setAttribute('aria-hidden', 'true');
    document.querySelectorAll('.tool[data-panel]').forEach(b => b.classList.remove('on'));
    this.app.input && this.app.input.blur();
  }

  sync(key) {
    const app = this.app;
    const f = this.syncers.get(key);
    if (f) f();
    if (key === 'mode') document.querySelectorAll('.modes button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.mode === app.s.mode)));
    if (key === 'over') document.getElementById('dbOver').setAttribute('aria-pressed', String(!!app.s.over));
    if (key === 'half') document.getElementById('dbHalf').setAttribute('aria-pressed', String(!!app.s.half));
    if (key === 'pressure') document.querySelectorAll('#dbPress button').forEach(b => b.classList.toggle('on', +b.dataset.v === app.s.pressure));
    if (key === 'speed') document.querySelectorAll('#dbSpeed button').forEach(b => b.classList.toggle('on', +b.dataset.v === app.s.speed));
  }

  // ------------------------------------------------------------ control builders
  _sec(title, ...kids) { return h('section', { class: 'sec' }, h('h3', {}, ...[].concat(title)), ...kids); }

  _seg(key, options, { cls = '', label } = {}) {
    const app = this.app;
    const el = h('div', { class: 'seg ' + cls, role: 'radiogroup', 'aria-label': label || key });
    const btns = options.map(o => {
      const b = h('button', { role: 'radio', onclick: () => { app.set(key, o.id); } }, ...[].concat(o.label ?? o.name));
      if (o.style) b.style.cssText = o.style;
      el.append(b);
      return [o.id, b];
    });
    const sync = () => btns.forEach(([id, b]) => b.setAttribute('aria-checked', String(app.s[key] === id)));
    this.syncers.set(key, sync); sync();
    return el;
  }

  _swatches(key, items, { cls = '', color = i => i.hex } = {}) {
    const app = this.app;
    const el = h('div', { class: 'swatches ' + cls, role: 'radiogroup' });
    const btns = items.map(it => {
      const b = h('button', { class: 'sw', role: 'radio', title: it.name, 'aria-label': it.name, onclick: () => app.set(key, it.id) },
        h('i', { style: `background:${color(it)}` }), h('span', {}, it.name));
      el.append(b);
      return [it.id, b];
    });
    const sync = () => btns.forEach(([id, b]) => b.setAttribute('aria-checked', String(app.s[key] === id)));
    this.syncers.set(key, sync); sync();
    return el;
  }

  _range(key, { min = 0, max = 1, step = 0.01, left = '', right = '' } = {}) {
    const app = this.app;
    const input = h('input', { type: 'range', min, max, step, 'aria-label': key });
    input.value = app.s[key];
    input.addEventListener('input', () => app.set(key, +input.value));
    this.syncers.set(key, () => { if (document.activeElement !== input) input.value = app.s[key]; });
    return h('div', { class: 'range' }, left ? h('span', {}, left) : null, input, right ? h('span', {}, right) : null);
  }

  _toggle(key, text) {
    const app = this.app;
    const input = h('input', { type: 'checkbox' });
    input.checked = !!app.s[key];
    input.addEventListener('change', () => app.set(key, input.checked));
    this.syncers.set(key, () => { input.checked = !!app.s[key]; });
    return h('label', { class: 'toggle' }, h('span', {}, text), input, h('b'));
  }

  // ------------------------------------------------------------ panels
  _panel_machine() {
    const app = this.app;
    const colorName = h('em');
    const syncName = () => { colorName.textContent = (COLORS.find(c => c.id === app.s.color) || {}).name || ''; };
    syncName();
    const sw = this._swatches('color', COLORS);
    const inner = this.syncers.get('color');
    this.syncers.set('color', () => { inner(); syncName(); });
    const paperName = h('em');
    const syncPaper = () => { paperName.textContent = (PAPERS.find(p => p.id === app.s.paper) || {}).name || ''; };
    syncPaper();
    const ps = this._swatches('paper', PAPERS, { cls: 'paper', color: p => p.swatch });
    const innerP = this.syncers.get('paper');
    this.syncers.set('paper', () => { innerP(); syncPaper(); });
    // ribbons
    const rbWrap = h('div', { class: 'ribbons', role: 'radiogroup' });
    const rbBtns = RIBBONS.map(r => {
      const a = INKS[r.inks[0]].color, b = INKS[r.inks[1] || r.inks[0]].color;
      const btn = h('button', { class: 'rb', role: 'radio', onclick: () => app.set('ribbon', r.id), title: r.name },
        h('i', { style: `--a:${a};--b:${b}` }), r.name);
      rbWrap.append(btn);
      return [r.id, btn];
    });
    const syncRb = () => rbBtns.forEach(([id, b]) => b.setAttribute('aria-checked', String(app.s.ribbon === id)));
    this.syncers.set('ribbon', syncRb); syncRb();

    this.body.append(
      this._sec(['Enamel', colorName], sw),
      this._sec('Trim', this._seg('trim', [{ id: null, name: 'Matched' }, ...TRIMS])),
      this._sec('Keys', this._seg('keycaps', KEYCAPS)),
      this._sec(['Paper', paperName], ps, h('p', { class: 'note' }, 'Changes the sheet in the machine and every new one.')),
      this._sec('Ribbon', rbWrap),
      this._sec('Ribbon ink', this._range('wear', { left: 'fresh', right: 'worn' })),
      this._sec('Typeface', this._seg('typeface', TYPEFACES.map(t => ({
        id: t.id, label: [h('span', { style: `font-family:'${t.family}'` }, 'Aa'), h('small', {}, t.name)] })), { cls: 'fonts' })),
      this._sec('Light', this._seg('mood', MOODS)),
    );
  }

  _panel_sound() {
    const app = this.app;
    this.body.append(
      this._sec('Volume', this._range('volume', { left: 'soft', right: 'loud' })),
      this._sec('Machine', this._seg('profile', PROFILES), h('p', { class: 'note' }, 'A light portable, or a heavy office machine with more body.')),
      this._sec('Bell', this._toggle('bell', 'Ring the margin bell')),
      this._sec('Ambience', this._seg('ambience', AMBIENCES), this._range('ambienceLevel', { left: 'far', right: 'near' })),
      this._sec('Note', h('p', { class: 'note' }, 'Every sound is synthesised live in your browser: the clack, the escapement, the bell, the carriage, the rain. Headphones recommended.')),
    );
  }

  _panel_writing() {
    const app = this.app;
    const stepper = (key, label, min, max) => {
      const out = h('output', {}, String(app.s[key] + 1));
      const set = v => { v = Math.max(min, Math.min(max, v)); app.set(key, v); };
      this.syncers.set(key, () => { out.textContent = String(app.s[key] + 1); });
      return h('div', { class: 'stepper' }, h('label', {}, label),
        h('button', { 'aria-label': label + ' left', onclick: () => set(app.s[key] - 1) }, '‹'), out,
        h('button', { 'aria-label': label + ' right', onclick: () => set(app.s[key] + 1) }, '›'));
    };
    this.body.append(
      this._sec('Line spacing', this._seg('spacing', [{ id: 1, name: 'Single' }, { id: 1.5, name: '1½' }, { id: 2, name: 'Double' }])),
      this._sec('Line ends', this._seg('lineEnds', [{ id: 'manual', name: 'Bell & lock' }, { id: 'auto', name: 'Auto return' }]),
        h('p', { class: 'note' }, 'Bell & lock is the real thing: the carriage stops at the margin until you press Enter. Auto return throws it back at the first space after the bell.')),
      this._sec('Backspace', this._seg('correction', [{ id: 'tape', name: 'Correction tape' }, { id: 'none', name: 'Ink is forever' }]),
        h('p', { class: 'note' }, 'With tape, backspace lifts the letter off and leaves a faint ghost. Without it, backspace only moves the carriage, so you can overstrike.')),
      this._sec('Margins', stepper('marginL', 'Left margin', 0, app.s.marginR - 20), stepper('marginR', 'Right margin', app.s.marginL + 20, LAYOUT.COLS - 1)),
      this._sec('View', this._toggle('closeup', 'Close-up on the sheet'),
        h('p', { class: 'note' }, 'Scroll to look up the page, Ctrl+scroll to zoom. Esc hides everything but the machine.')),
    );
  }

  _panel_pages() {
    const app = this.app;
    this.body.append(
      this._sec('This sheet',
        h('div', { class: 'row2' },
          h('button', { class: 'btn', onclick: () => this.openReader(app.state.current) }, 'Read it'),
          h('button', { class: 'btn', onclick: () => { app.newSheet(); } }, 'Fresh sheet')),
        h('button', { class: 'btn', onclick: () => this.openExport() }, 'Save as image (PNG)'),
      ),
      this._sec('Everything',
        h('div', { class: 'row2' },
          h('button', { class: 'btn', onclick: () => this.downloadAllMarkdown(), title: 'Every page in one Markdown file' }, 'Save .md'),
          h('button', { class: 'btn', onclick: () => this.downloadAllText() }, 'Save .txt')),
        h('button', { class: 'btn', onclick: () => this.copyAll() }, 'Copy all text'),
        h('button', { class: 'btn', onclick: () => this.printPages(app.state.pages.map((_, i) => i)) }, 'Print or save as PDF'),
        h('p', { class: 'note' }, 'Markdown keeps your paragraphs; drawings go in as code blocks, character for character.'),
      ),
      this._sec(['Sheets', h('em', {}, `${app.state.pages.length}`)], this.thumbs = h('div', { class: 'thumbs' })),
    );
    this.refreshPages(true);
  }

  _panel_help() {
    const rows = [
      ['Enter', 'Carriage return and line feed'], ['Backspace', 'Back one space (lifts the letter with correction tape)'],
      ['Tab', 'Jump to the next tab stop'], ['Arrows', 'Move the carriage / roll the platen (half steps in Draw)'],
      ['Ctrl+R', 'Switch ribbon colour (black / red)'], ['Ctrl+Enter', 'Pull the sheet and roll in a fresh one'],
      ['Ctrl+S', 'Save the sheet, just the ink, or a photo of the machine as a PNG'],
      ['Esc', 'Hide everything but the machine; stops auto typing'], ['Scroll', 'Look up the page'], ['Ctrl+scroll', 'Zoom'],
      ['Click the sheet', 'Move the carriage there'], ['Click the lever', 'Carriage return'], ['Click a knob', 'Roll the platen one line'],
    ];
    const t = h('table', { class: 'keys-help' }, ...rows.map(([k, v]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, v))));
    this.body.append(
      this._sec('Keys', t),
      this._sec('Draw mode', h('p', { class: 'note' }, 'Typewriter art the old way: arrows move half a space or half a line, Overstrike keeps the carriage still so you can stack letters into darker tones. Sketch & picture lets you draw shapes or drop in a photo; the machine then types it out by itself, at a typist’s pace.')),
      this._sec('Guide', h('p', { class: 'note' }, 'Own a real typewriter? Guide turns the sheet (or a planned drawing) into setup steps and line-by-line instructions: spaces, characters and overstrikes. Tick lines off as you type, or print it.')),
      this._sec('About', h('p', { class: 'note' }, 'Platen is a cozy typewriter for slow writing and typewriter art. The machine is modelled in Three.js, the paper and ink are drawn pixel by pixel, and every sound is synthesised. Your pages stay in this browser.')),
    );
  }

  // ------------------------------------------------------------ pages + thumbnails
  refreshPages(force = false) {
    if (!this.thumbs || this.panel !== 'pages' || (!force && !this.drawerOpen())) return;
    const app = this.app;
    this.thumbs.replaceChildren();
    app.state.pages.forEach((p, i) => {
      const c = this._thumb(p);
      const b = h('button', { class: 'thumb' + (i === app.state.current ? ' current' : ''), onclick: () => this.openReader(i), title: 'Read page ' + (i + 1) },
        c, h('span', {}, `${i + 1}${i === app.state.current ? ' · in machine' : ''}`));
      this.thumbs.append(b);
    });
  }

  _thumb(p) {
    const key = p.id + ':' + p.strikes.length + ':' + p.ghosts.length + ':' + p.paper;
    let src = this.thumbCache.get(key);
    if (!src) {
      const s = new PageSurface({ paper: p.paper, scale: 0.12 });
      s.render(p.strikes, p.ghosts);
      src = s.canvas;
      this.thumbCache.set(key, src);
    }
    const c = h('canvas', { width: src.width, height: src.height });
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  }

  _surfaceFor(i, scale = 1) {
    const app = this.app;
    if (i === app.state.current && scale === 1) return app.surface;
    const p = app.state.pages[i];
    const s = new PageSurface({ paper: p.paper, scale });
    s.render(p.strikes, p.ghosts);
    return s;
  }

  openReader(i) {
    const app = this.app;
    this.readerIndex = i;
    const p = app.state.pages[i];
    const src = this._surfaceFor(i, 1).canvas;
    const cv = document.getElementById('readerCanvas');
    cv.width = src.width; cv.height = src.height;
    cv.getContext('2d').drawImage(src, 0, 0);
    const text = pageText(p);
    document.getElementById('readerTitle').textContent = `Page ${i + 1}`;
    const d = new Date(p.created);
    document.getElementById('readerMeta').textContent = `${wordCount(text)} words · ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`;
    document.querySelector('#reader [data-act="load"]').hidden = i === app.state.current;
    const m = document.getElementById('reader');
    m.classList.add('open'); m.setAttribute('aria-hidden', 'false');
  }

  closeReader() {
    const m = document.getElementById('reader');
    m.classList.remove('open'); m.setAttribute('aria-hidden', 'true');
    document.querySelector('.reader-sheet').classList.remove('zoomed');
  }

  async _readerAct(act) {
    const app = this.app, i = this.readerIndex, p = app.state.pages[i];
    if (act === 'close') return this.closeReader();
    if (act === 'copy') {
      try { await navigator.clipboard.writeText(pageText(p)); app.toast('Copied the text of this page'); }
      catch { app.toast('Copying was blocked by the browser'); }
    }
    if (act === 'md') {
      if (!pageText(p).trim()) { app.toast('This page is blank'); return; }
      download(new Blob([pagesMarkdown([p], { title: `Platen · page ${i + 1}`, numbers: [i + 1] })], { type: 'text/markdown;charset=utf-8' }), `platen-page-${i + 1}.md`);
    }
    if (act === 'txt') download(new Blob([pageText(p) + '\n'], { type: 'text/plain;charset=utf-8' }), `platen-page-${i + 1}.txt`);
    if (act === 'png') { this.closeReader(); this.openExport(i); }
    if (act === 'print') this.printPages([i]);
    if (act === 'guide') { this.closeReader(); app.openGuide(p.strikes, `Page ${i + 1}`); }
    if (act === 'load') { this.closeReader(); this.closeDrawer(); app.openPage(i); }
    if (act === 'delete') {
      if (!confirm('Throw this page away? It cannot be brought back.')) return;
      this.closeReader();
      app.deletePage(i);
      this.refreshPages();
    }
  }

  allText() {
    return this.app.state.pages.map(p => pageText(p)).filter(t => t.trim()).join('\n\n\n');
  }

  async copyAll() {
    try { await navigator.clipboard.writeText(this.allText()); this.app.toast('Copied every page'); }
    catch { this.app.toast('Copying was blocked by the browser'); }
  }

  downloadAllText() {
    download(new Blob([this.allText() + '\n'], { type: 'text/plain;charset=utf-8' }), 'platen-pages.txt');
  }

  downloadAllMarkdown() {
    const pages = this.app.state.pages;
    if (!pages.some(p => pageText(p).trim())) { this.app.toast('Nothing typed yet'); return; }
    download(new Blob([pagesMarkdown(pages)], { type: 'text/markdown;charset=utf-8' }), 'platen-pages.md');
    this.app.toast('Saved platen-pages.md');
  }

  // print through a hidden frame holding one image per sheet
  printPages(indices) {
    const imgs = indices.map(i => this._surfaceFor(i, 1).canvas.toDataURL('image/jpeg', 0.92));
    const f = h('iframe', { style: 'position:fixed;width:0;height:0;border:0;right:0;bottom:0' });
    document.body.append(f);
    const d = f.contentDocument;
    d.open();
    d.write(`<!doctype html><html><head><title>Platen pages</title><style>@page{size:letter;margin:0}html,body{margin:0}img{display:block;width:8.5in;height:11in;page-break-after:always}</style></head><body>${imgs.map(s => `<img src="${s}">`).join('')}</body></html>`);
    d.close();
    setTimeout(() => { f.contentWindow.focus(); f.contentWindow.print(); setTimeout(() => f.remove(), 2000); }, 400);
  }

  // ------------------------------------------------------------ save as image
  openExport(i = this.app.state.current) {
    const app = this.app;
    this.ex = this.ex || { what: 'sheet', bg: 'paper', size: 1 };
    this.ex.page = i;
    this.closeDrawer();
    const m = document.getElementById('exporter');
    m.classList.add('open'); m.setAttribute('aria-hidden', 'false');
    this._exportPreview();
  }

  closeExport() {
    const m = document.getElementById('exporter');
    m.classList.remove('open'); m.setAttribute('aria-hidden', 'true');
  }

  // build the image: full = the real output size, otherwise a quick standard-size preview
  async _exportCanvas(full) {
    const app = this.app, { what, bg, size, page: i } = this.ex;
    if (what === 'photo') return app.snapshot(full ? (size > 1 ? 3 : 2) : 1);
    const p = app.state.pages[i];
    const scale = full ? size : 1;
    let surf = app.surface;
    if (i !== app.state.current || scale !== 1) {
      surf = new PageSurface({ paper: p.paper, scale });
      surf.render(p.strikes, p.ghosts);
    }
    const W = surf.width, H = surf.height;
    let rect = { x: 0, y: 0, w: W, h: H };
    if (what === 'ink') {
      const inked = p.strikes.filter(s => !s.g);
      rect = cropRect(inked.map(s => strikeRect(s, scale)), 60 * scale, W, H) || rect;
    }
    const pageData = surf.canvas.getContext('2d').getImageData(rect.x, rect.y, rect.w, rect.h);
    let data = pageData.data;
    if (bg !== 'paper') {
      const pc = surf.paperCanvas;
      const paperData = pc.getContext('2d').getImageData(rect.x, rect.y, rect.w, rect.h).data;
      data = separateInk(data, paperData, bg === 'clear' ? 'clear' : 'white');
    }
    const out = document.createElement('canvas');
    out.width = rect.w; out.height = rect.h;
    out.getContext('2d').putImageData(new ImageData(data, rect.w, rect.h), 0, 0);
    if (surf !== app.surface && surf.dispose) surf.dispose();
    return out;
  }

  async _exportPreview() {
    const app = this.app, ex = this.ex, p = app.state.pages[ex.page];
    const hasInk = p.strikes.some(s => !s.g);
    if (!hasInk && ex.what === 'ink') ex.what = 'sheet';
    const photo = ex.what === 'photo';
    const sync = (id, key) => document.querySelectorAll(`#${id} button`).forEach(b => {
      b.setAttribute('aria-checked', String(String(ex[key]) === b.dataset.v));
    });
    sync('exWhat', 'what'); sync('exBg', 'bg'); sync('exSize', 'size');
    document.querySelector('#exWhat [data-v="ink"]').disabled = !hasInk;
    document.querySelectorAll('#exBg button').forEach(b => { b.disabled = photo; });
    document.getElementById('exPage').textContent = photo ? 'What you see on the desk right now' : `Page ${ex.page + 1}`;
    const token = (this._exToken = (this._exToken || 0) + 1);
    const src = await this._exportCanvas(false);
    if (token !== this._exToken) return;
    const cv = document.getElementById('exCanvas');
    cv.width = src.width; cv.height = src.height;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(src, 0, 0);
    document.getElementById('exStage').classList.toggle('checker', !photo && ex.bg === 'clear');
    const k = photo ? Math.min(ex.size > 1 ? 3 : 2, 5000 / src.width) : ex.size;   // the preview is 1x
    const w = Math.round(src.width * k), h = Math.round(src.height * k);
    document.getElementById('exMeta').textContent = photo ? `${w} × ${h} px` : `${w} × ${h} px · ${Math.round(240 * ex.size)} dpi`;
  }

  async _exportAct(act, btn) {
    const app = this.app, ex = this.ex;
    if (act === 'close') return this.closeExport();
    const side = btn.closest('.ex-side');
    side.classList.add('ex-busy');
    const label = btn.textContent;
    btn.textContent = 'Rendering…';
    await new Promise(r => setTimeout(r, 30));      // let the label paint before the heavy work
    try {
      const cv = await this._exportCanvas(act === 'save');
      const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
      if (act === 'save') {
        download(blob, exportName(ex.what, ex.page + 1, ex.what === 'photo' ? 'paper' : ex.bg));
        app.toast('Saved ' + exportName(ex.what, ex.page + 1, ex.what === 'photo' ? 'paper' : ex.bg));
      } else {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        app.toast('Image copied. Paste it anywhere.');
      }
    } catch (e) {
      console.warn(e);
      app.toast(act === 'copy' ? 'This browser blocked copying images. Use Save PNG.' : 'Could not make the image.');
    } finally {
      btn.textContent = label;
      side.classList.remove('ex-busy');
    }
  }

  // ------------------------------------------------------------ progress + welcome
  progress(frac, label) {
    const el = document.getElementById('progress');
    if (frac == null) { el.hidden = true; return; }
    el.hidden = false;
    document.getElementById('progressBar').style.width = Math.round(frac * 100) + '%';
    document.getElementById('progressText').textContent = label || '';
  }

  showWelcome() { document.getElementById('welcome').hidden = false; }

  hideWelcome(feed = false) {
    const app = this.app;
    document.getElementById('welcome').hidden = true;
    app.unlockAudio();
    if (!app.s.welcomed) {
      app.set('welcomed', true);
      if (feed && !app.page.strikes.length) { app.machine.feedPaper(app.car.row, 1.2); app.snd('paperIn'); }
    }
    app.input && !matchMedia('(pointer: coarse)').matches && app.input.focus({ preventScroll: true });
  }
}
