// guide.js: a step-by-step guide for typing a drawing (or any page) on a real typewriter.
//
//   makeGuide(strikes, { title, typeface, pitch, paper }) -> { title, lines, summary, setup, legend, text }
//       pure, runs under Node: the strikes grouped into typed lines with run-length steps
//   guideText(guide) -> string                plain-text export (also guide.text)
//   openGuide(host, { PageSurface, strikes, title, typeface, paper }) -> Guide   (opens the view)
//   new Guide(host, { PageSurface }); guide.open({ strikes, title, ... }); guide.close(); guide.isOpen
//
// Step tokens of a line, in order:
//   { t: 'space', n }        press the space bar n times (n may end in a half: a half space)
//   { t: 'back',  n }        backspace n times (characters set half a space back)
//   { t: 'type',  s, k, pc } type these characters; '␣' inside s is one press of the space bar
//   { t: 'stack', glyphs }   overstrike: type glyphs[0], backspace, type glyphs[1] ... (one cell)
//   { t: 'ink',   k }        switch the ribbon to this colour (the red half of a black & red ribbon)

import { orderStrikes, PAGE } from './art.js';
import { hash32 } from './util.js';

export const SPACE_MARK = '␣';   // ␣
export const BACK_MARK = '⌫';    // ⌫
export const INK_NAMES = { k: 'black', r: 'red', n: 'navy', s: 'sepia', v: 'violet' };
const INK_COLORS = { k: '#201d1b', r: '#b8322a', n: '#26305f', s: '#6b4428', v: '#613594' };
const A4 = { cols: 82, rows: 70 };      // A4 at pica pitch and 6 lines per inch

// 3 -> '3', 2.5 -> '2½', 0.5 -> '½'
export function fmtHalf(v) {
  const w = Math.floor(v + 1e-6), half = v - w > 0.25;
  return half ? (w ? `${w}½` : '½') : String(w);
}
const plural = (n, one, many = one + 's') => `${fmtHalf(n)} ${n === 1 ? one : many}`;
const pclass = p => (p == null ? 0 : p >= 1.15 ? 1 : p <= 0.85 ? -1 : 0);

export function makeGuide(strikes, opts = {}) {
  const o = { title: 'Typewriter art', typeface: 'pica', pitch: 'pica', paper: 'letter', ...opts };
  const list = orderStrikes((strikes || []).filter(s => s && !s.g && typeof s.c === 'string' && s.c.trim() !== ''));
  const rows = new Map();
  for (const s of list) {
    if (!rows.has(s.y)) rows.set(s.y, []);
    rows.get(s.y).push(s);
  }
  const ys = [...rows.keys()].sort((a, b) => a - b);
  const margin = list.length ? Math.floor(Math.min(...list.map(s => s.x)) + 1e-6) : 0;
  const startInk = list.length ? list[0].k || 'k' : 'k';
  let ink = startInk;
  let inkSwitches = 0, stacks = 0, halfSpaces = false, backs = 0, keys = 0;
  const lines = ys.map((y, li) => {
    const cells = new Map();
    for (const s of rows.get(y)) {
      if (!cells.has(s.x)) cells.set(s.x, []);
      cells.get(s.x).push(s);
    }
    const xs = [...cells.keys()].sort((a, b) => a - b);
    const tokens = [];
    let run = null, cur = margin, lineKeys = 0;
    const flush = () => { if (run) { tokens.push(run); run = null; } };
    for (const x of xs) {
      const st = cells.get(x);
      const first = st[0];
      const k = first.k || 'k', pc = pclass(first.p);
      const gap = x - cur;
      const intGap = Math.abs(gap - Math.round(gap)) < 1e-6;
      if (st.length === 1 && run && k === ink && pc === run.pc && intGap && gap > -1e-6 && gap <= 2 + 1e-6) {
        const g = Math.round(gap);
        run.s += SPACE_MARK.repeat(g) + first.c;
        run.n++; run.keys += g + 1; lineKeys += g + 1;
        cur = x + 1;
        continue;
      }
      flush();
      if (gap > 1e-6) {
        tokens.push({ t: 'space', n: gap });
        lineKeys += Math.ceil(gap);
        if (!intGap) halfSpaces = true;
      } else if (gap < -1e-6) {
        tokens.push({ t: 'back', n: -gap });
        lineKeys += Math.ceil(-gap);
        backs++;
        if (!intGap) halfSpaces = true;
      }
      if (k !== ink) { tokens.push({ t: 'ink', k }); ink = k; inkSwitches++; }
      if (st.length === 1) {
        run = { t: 'type', s: first.c, k, pc, n: 1, keys: 1 };
        lineKeys += 1;
      } else {
        const glyphs = st.map(s => ({ c: s.c, k: s.k || 'k', pc: pclass(s.p) }));
        for (let i = 1; i < glyphs.length; i++) if (glyphs[i].k !== glyphs[i - 1].k) inkSwitches++;
        ink = glyphs[glyphs.length - 1].k;
        tokens.push({ t: 'stack', glyphs, n: glyphs.length, keys: glyphs.length * 2 - 1 });
        lineKeys += glyphs.length * 2 - 1;
        stacks++;
      }
      cur = x + 1;
    }
    flush();
    const steps = compress(tokens);
    keys += lineKeys + 1;                               // + the carriage return
    const startCol = xs[0];
    const line = {
      index: li,
      row: y,
      lineNo: y + 1,                                    // counted from 1 at the top of the sheet
      label: fmtHalf(y + 1),
      roll: li === 0 ? y : y - ys[li - 1],              // first line: lines down from the top edge
      startCol,
      fromMargin: startCol - margin,
      strikes: rows.get(y).length,
      keys: lineKeys,
      tokens: steps,
    };
    line.text = tokensText(steps);
    return line;
  });
  const xsAll = list.map(s => s.x);
  const inks = [...new Set(list.map(s => s.k || 'k'))];
  const halfLines = ys.some(y => Math.abs(y - Math.round(y)) > 1e-6);
  const summary = {
    title: o.title,
    strikes: list.length,
    lines: lines.length,
    cells: lines.reduce((n, l) => n + l.tokens.reduce((m, t) => m + (t.t === 'type' ? t.n : t.t === 'stack' ? t.repeat : 0), 0), 0),
    stacks,
    margin,
    firstRow: ys.length ? ys[0] : 0,
    lastRow: ys.length ? ys[ys.length - 1] : 0,
    leftCol: xsAll.length ? Math.min(...xsAll) : 0,
    rightCol: xsAll.length ? Math.max(...xsAll) : 0,
    widthCols: xsAll.length ? Math.ceil(Math.max(...xsAll) + 1 - Math.min(...xsAll)) : 0,
    heightLines: ys.length ? Math.ceil(ys[ys.length - 1] + 1 - ys[0]) : 0,
    inks,
    startInk,
    inkSwitches,
    halfLines,
    halfSpaces,
    backspaces: backs,
    keys,
    // a person reading the guide: about one key a second plus a few seconds per line
    minutesByHand: Math.max(1, Math.round((keys * 1.0 + lines.length * 6) / 60)),
    typeface: o.typeface,
    pitch: o.pitch,
    fitsA4: !xsAll.length || (Math.max(...xsAll) < A4.cols && ys[ys.length - 1] < A4.rows),
    pressure: list.some(s => pclass(s.p) !== 0),
  };
  const guide = { title: o.title, lines, summary };
  guide.setup = setupSteps(summary);
  guide.legend = legendFor(summary, lines);
  guide.id = hash32('guide', list.map(s => `${s.c}${s.x},${s.y}${s.k}`).join('|')).toString(36);
  guide.text = guideText(guide);
  return guide;
}

// Readable counts: identical overstrikes side by side become one step with a repeat, and four or
// more of the same character in a run become their own step ("8×:"), so nobody has to count dots.
const REPEAT_MIN = 4;
function compress(tokens) {
  const out = [];
  for (const tk of tokens) {
    if (tk.t === 'stack') {
      const prev = out[out.length - 1];
      const same = prev && prev.t === 'stack' && prev.glyphs.length === tk.glyphs.length
        && prev.glyphs.every((g, i) => g.c === tk.glyphs[i].c && g.k === tk.glyphs[i].k && g.pc === tk.glyphs[i].pc);
      if (same) { prev.repeat++; prev.keys += tk.keys; continue; }
      out.push({ ...tk, repeat: 1 });
      continue;
    }
    if (tk.t !== 'type') { out.push(tk); continue; }
    const chars = Array.from(tk.s);
    let i = 0, text = '';
    const pushText = () => {
      if (!text) return;
      out.push({ t: 'type', s: text, k: tk.k, pc: tk.pc, n: Array.from(text).filter(c => c !== SPACE_MARK).length, keys: Array.from(text).length, repeat: 1 });
      text = '';
    };
    while (i < chars.length) {
      let j = i;
      while (j < chars.length && chars[j] === chars[i]) j++;
      if (chars[i] !== SPACE_MARK && j - i >= REPEAT_MIN) {
        pushText();
        out.push({ t: 'type', s: chars[i], k: tk.k, pc: tk.pc, n: j - i, keys: j - i, repeat: j - i });
      } else text += chars.slice(i, j).join('');
      i = j;
    }
    pushText();
  }
  return out;
}

// one line of steps as text: tokens separated by two spaces, spaces as ‹n›
export function tokensText(tokens) {
  return tokens.map(tk => {
    if (tk.t === 'space') return `‹${fmtHalf(tk.n)}›`;
    if (tk.t === 'back') return tk.n === 1 ? BACK_MARK : `${fmtHalf(tk.n)}${BACK_MARK}`;
    if (tk.t === 'ink') return `‹${INK_NAMES[tk.k] || tk.k}›`;
    if (tk.t === 'stack') {
      let s = '', k = tk.glyphs[0].k;
      tk.glyphs.forEach((g, i) => {
        if (i) s += BACK_MARK;
        if (g.k !== k) { s += `‹${INK_NAMES[g.k] || g.k}›`; k = g.k; }
        s += g.c;
      });
      return tk.repeat > 1 ? `${tk.repeat}×${s}` : s;
    }
    return (tk.pc > 0 ? '‹firm›' : tk.pc < 0 ? '‹light›' : '') + (tk.repeat > 1 ? `${tk.repeat}×${tk.s}` : tk.s);
  }).join('  ');
}

function setupSteps(sm) {
  const out = [];
  out.push(`Paper: US Letter (8.5 x 11 in), upright. ${sm.fitsA4
    ? 'A4 works too.' : `A4 is narrower (82 columns, 70 lines) and would cut this picture off; use Letter.`}`);
  out.push('Pitch: pica, 10 characters per inch (the columns below are pica columns). An elite machine (12 per inch) types it narrower.');
  out.push(`Spacing: single, 6 lines per inch.${sm.halfLines ? ' Some lines sit half a line apart: roll the platen half a click (the variable line spacer or a half turn of the knob).' : ''}`);
  out.push(`Margin: with the paper edge at 0 on the paper scale, set the left margin at ${sm.margin}. Every line starts from there.`);
  out.push(`First line: line the top edge of the paper up with the type line, then roll down ${plural(sm.firstRow, 'line')}.`);
  const names = sm.inks.map(k => INK_NAMES[k] || k);
  if (sm.inks.length > 1) out.push(`Ribbon: ${names.join(' & ')}. Start on ${INK_NAMES[sm.startInk] || sm.startInk}; move the colour lever where the steps say ‹${names[1]}› or ‹${names[0]}›.`);
  else out.push(`Ribbon: ${names[0] || 'black'}.`);
  if (sm.stacks) out.push('Overstrikes: type the first character, press backspace once, type the next on top. They build the darkest tones.');
  if (sm.halfSpaces) out.push('Half spaces: some characters sit half a space over. Use the half-space key, or hold the space bar down while you type that character.');
  out.push(sm.pressure ? 'Strike evenly; the steps mark the keys to hit ‹firm› (harder) or ‹light› (softer).'
    : 'Strike every key evenly and firmly.');
  return out;
}

function legendFor(sm, lines) {
  const L = [[`‹3›`, 'press the space bar 3 times'], [SPACE_MARK, 'one space between characters'],
    ['→', 'carriage return, then roll down as the line says']];
  const has = t => lines.some(l => l.tokens.some(tk => tk.t === t));
  if (lines.some(l => l.tokens.some(tk => tk.repeat > 1))) L.push(['8×:', 'eight colons in a row; 3× before an overstrike means the same overstrike in 3 cells side by side']);
  if (has('stack')) L.push([`#${BACK_MARK}@`, 'overstrike: type #, backspace, type @']);
  if (has('back')) L.push([BACK_MARK, 'backspace (½: half a space back)']);
  if (sm.halfSpaces || sm.halfLines) L.push(['½', 'half a space or half a line']);
  if (has('ink')) L.push([`‹${INK_NAMES[sm.inks.find(k => k !== sm.startInk)] || 'red'}›`, 'switch the ribbon colour lever']);
  if (lines.some(l => l.tokens.some(tk => tk.pc))) L.push(['‹firm›', 'strike the next characters harder (or ‹light›: softer)']);
  return L;
}

export function guideText(g) {
  const sm = g.summary;
  const W = 78;
  const out = [];
  out.push('PLATEN: A GUIDE FOR YOUR TYPEWRITER');
  out.push('='.repeat(35));
  out.push(`${g.title}`);
  out.push(`${sm.strikes.toLocaleString('en-US')} strikes on ${sm.lines} lines, ${sm.widthCols} columns wide. Roughly ${sm.minutesByHand} min at an easy pace.`);
  out.push('');
  out.push('SETUP');
  g.setup.forEach((s, i) => out.push(wrap(`${i + 1}. ${s}`, W, '   ')));
  out.push('');
  out.push('READING THE STEPS');
  for (const [sym, txt] of g.legend) out.push(`  ${sym.padEnd(8)} ${txt}`);
  out.push('');
  out.push('STEPS  (line on the sheet, roll from the line before, start column; then the keys)');
  out.push('');
  for (const l of g.lines) {
    const roll = l.index === 0 ? `↓${fmtHalf(l.roll)} from top` : `→ roll ${fmtHalf(l.roll)}`;
    out.push(`[ ] Line ${l.label.padEnd(5)} ${roll.padEnd(15)} col ${String(fmtHalf(l.startCol)).padEnd(4)} (margin +${fmtHalf(l.fromMargin)})`);
    out.push(`      ${l.text}`);
  }
  if (!g.lines.length) out.push('(nothing to type)');
  out.push('');
  out.push('Made with Platen.');
  return out.join('\n');
}

function wrap(s, W, indent) {
  const words = s.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > W) { lines.push(cur); cur = indent + w; } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) lines.push(cur);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// The Guide view (browser only)
// ---------------------------------------------------------------------------------------------

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
}

const ICON = {
  print: '<path d="M7 9V4h10v5"/><rect x="4" y="9" width="16" height="7" rx="1.5"/><path d="M7 14h10v6H7z"/>',
  download: '<path d="M12 4v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19.5h14"/>',
  close: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
  up: '<path d="M6 14l6-6 6 6"/>',
  down: '<path d="M6 10l6 6 6-6"/>',
};
const svg = n => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON[n]}</svg>`;

const STORE = 'platen-guide:';
const store = {
  get(id) { try { const v = localStorage.getItem(STORE + id); return v ? JSON.parse(v) : null; } catch { return null; } },
  set(id, v) { try { localStorage.setItem(STORE + id, JSON.stringify(v)); } catch { /* private mode etc. */ } },
};

function tokenNode(tk) {
  if (tk.t === 'space') {
    return el('span', { class: 'gd-tok gd-gap', 'aria-label': `${fmtHalf(tk.n)} space${tk.n === 1 ? '' : 's'}` },
      el('b', {}, fmtHalf(tk.n)), el('small', {}, tk.n === 1 ? 'space' : 'spaces'));
  }
  if (tk.t === 'back') return el('span', { class: 'gd-tok gd-gap gd-back', 'aria-label': `backspace ${fmtHalf(tk.n)}` }, el('b', {}, tk.n === 1 ? '' : fmtHalf(tk.n)), el('small', {}, BACK_MARK));
  if (tk.t === 'ink') return el('span', { class: `gd-tok gd-inkswitch gd-ink-${tk.k}`, style: `--ink:${INK_COLORS[tk.k] || '#222'}` }, `switch to ${INK_NAMES[tk.k] || tk.k}`);
  if (tk.t === 'stack') {
    const n = el('span', { class: 'gd-tok gd-stack', title: 'Overstrike: type, backspace, type', 'aria-label': `${tk.repeat > 1 ? tk.repeat + ' times ' : ''}overstrike ${tk.glyphs.map(g => g.c).join(' then ')}` });
    if (tk.repeat > 1) n.append(el('b', { class: 'gd-times' }, `${tk.repeat}×`));
    tk.glyphs.forEach((g, i) => {
      if (i) n.append(el('i', { 'aria-hidden': 'true' }, BACK_MARK));
      n.append(el('span', { style: g.k !== 'k' ? `color:${INK_COLORS[g.k]}` : null }, g.c));
    });
    return n;
  }
  if (tk.repeat > 1) {
    return el('span', { class: 'gd-tok gd-rep' + (tk.pc > 0 ? ' gd-firm' : tk.pc < 0 ? ' gd-light' : ''), 'aria-label': `${tk.s} ${tk.repeat} times`, style: tk.k !== 'k' ? `color:${INK_COLORS[tk.k]}` : null },
      el('b', { class: 'gd-times' }, `${tk.repeat}×`), el('span', { class: 'gd-glyph' }, tk.s));
  }
  const n = el('span', { class: 'gd-tok gd-run' + (tk.pc > 0 ? ' gd-firm' : tk.pc < 0 ? ' gd-light' : ''), style: tk.k !== 'k' ? `color:${INK_COLORS[tk.k]}` : null });
  for (const part of tk.s.split(/(␣+)/)) {
    if (!part) continue;
    if (part[0] === SPACE_MARK) {
      n.append(el('span', { class: 'gd-sp', role: 'img', 'aria-label': `${part.length} space${part.length > 1 ? 's' : ''}` },
        ...Array.from({ length: part.length }, () => el('i'))));
    }
    else n.append(document.createTextNode(part));
  }
  if (tk.pc) n.append(el('small', { class: 'gd-pnote' }, tk.pc > 0 ? 'firm' : 'light'));
  return n;
}

// the Guide's stylesheet loads itself next to this module (index.html may also link it)
function ensureCss() {
  if (document.querySelector('link[data-gd-css], link[href$="guide.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('../css/guide.css', import.meta.url).href;
  link.dataset.gdCss = '';
  document.head.append(link);
}

export class Guide {
  constructor(host, opts = {}) {
    ensureCss();
    this.host = host || document.body;
    this.opts = opts;
    this._open = false;
    this.done = new Set();
    this._build();
  }

  get isOpen() { return this._open; }

  // open({ strikes, title, typeface, paper, PageSurface })
  open(args = {}) {
    const a = { ...this.opts, ...args };
    this.PageSurface = a.PageSurface || this.PageSurface;
    this.paper = a.paper || 'ivory';
    this.strikes = (a.strikes || []).filter(s => s && !s.g);
    this.guide = makeGuide(this.strikes, { title: a.title || 'Your drawing', typeface: a.typeface || 'pica' });
    const saved = store.get(this.guide.id);
    this.done = new Set(saved && Array.isArray(saved.done) ? saved.done.filter(i => i < this.guide.lines.length) : []);
    this._fill();
    const details = this.aside.querySelector('details');
    if (details && window.matchMedia) details.open = !window.matchMedia('(max-width: 760px)').matches;
    this._open = true;
    this.root.hidden = false;
    this.root.getBoundingClientRect();
    this.root.classList.add('is-open');
    this._lastFocus = document.activeElement;
    this.sheet.focus({ preventScroll: true });
    window.addEventListener('keydown', this._winKey, true);
    window.addEventListener('keyup', this._winKeyUp, true);
    window.addEventListener('beforeprint', this._beforePrint);
    window.addEventListener('afterprint', this._afterPrint);
    requestAnimationFrame(() => this._scrollToCurrent(false));
    return this;
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this.root.classList.remove('is-open');
    window.removeEventListener('keydown', this._winKey, true);
    window.removeEventListener('keyup', this._winKeyUp, true);
    window.removeEventListener('beforeprint', this._beforePrint);
    window.removeEventListener('afterprint', this._afterPrint);
    clearTimeout(this._closeT);
    this._closeT = setTimeout(() => { if (!this._open) this.root.hidden = true; }, 200);
    if (this._lastFocus && this._lastFocus.focus) try { this._lastFocus.focus({ preventScroll: true }); } catch { /* gone */ }
  }

  destroy() { this.close(); this.root.remove(); }

  // ---------------------------------------------------------------- DOM
  _build() {
    this.root = el('div', { class: 'gd-root', hidden: true });
    this.sheet = el('section', { class: 'gd-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'gd-title', tabindex: '-1' });
    this.titleEl = el('h2', { class: 'gd-title', id: 'gd-title' }, el('span', { class: 'gd-wide' }, 'A guide for your typewriter'), el('span', { class: 'gd-narrow' }, 'Typewriter guide'));
    this.subEl = el('p', { class: 'gd-sub' });
    const btn = (cls, label, icon, fn, title) => el('button', { type: 'button', class: cls, 'aria-label': label, title: title || label, html: svg(icon) + `<span>${label}</span>`, onclick: fn });
    this.printBtn = btn('gd-btn', 'Print / Save as PDF', 'print', () => this.print());
    this.txtBtn = btn('gd-btn', 'Download .txt', 'download', () => this.downloadText());
    this.closeBtn = el('button', { type: 'button', class: 'gd-iconbtn gd-x', 'aria-label': 'Close the guide', title: 'Close (Esc)', html: svg('close'), onclick: () => this.close() });
    const head = el('header', { class: 'gd-head' },
      el('div', { class: 'gd-titles' }, this.titleEl, this.subEl),
      el('div', { class: 'gd-headtools' }, this.printBtn, this.txtBtn, this.closeBtn));
    this.preview = el('img', { class: 'gd-preview', alt: 'The finished picture' });
    this.sheetMap = el('div', { class: 'gd-map', 'aria-hidden': 'true' }, el('div', { class: 'gd-mapart' }), el('div', { class: 'gd-mapmargin' }));
    this.setupEl = el('ol', { class: 'gd-setup' });
    this.legendEl = el('dl', { class: 'gd-legend' });
    this.aside = el('aside', { class: 'gd-aside' },
      el('figure', { class: 'gd-figure' }, this.preview, el('figcaption', {}, el('span', {}, 'Where it sits on the sheet'), this.sheetMap)),
      el('details', { class: 'gd-details', open: true },
        el('summary', {}, 'Before you start'),
        this.setupEl,
        el('h3', { class: 'gd-label' }, 'Reading the steps'),
        this.legendEl));
    this.list = el('ol', { class: 'gd-lines', 'aria-label': 'Lines to type' });
    this.steps = el('div', { class: 'gd-steps' }, this.list);
    this.progressBar = el('div', { class: 'gd-bar' }, el('span'));
    this.progressText = el('div', { class: 'gd-progress', 'aria-live': 'polite' });
    this.backBtn = el('button', { type: 'button', class: 'gd-btn gd-big gd-ghost', html: svg('up') + '<span>Back</span>', 'aria-label': 'Back one line (Up arrow)', onclick: () => this.back() });
    this.nextBtn = el('button', { type: 'button', class: 'gd-btn gd-big gd-primary', html: '<span>Done<span class="gd-wide">, next line</span></span>' + svg('down'), 'aria-label': 'Mark this line typed and go to the next (Space or Down arrow)', onclick: () => this.next() });
    const foot = el('footer', { class: 'gd-foot' }, el('div', { class: 'gd-progresswrap' }, this.progressText, this.progressBar), el('div', { class: 'gd-nav' }, this.backBtn, this.nextBtn));
    this.sheet.append(head, el('div', { class: 'gd-body' }, this.aside, this.steps), foot);
    this.root.append(el('div', { class: 'gd-scrim', onclick: () => this.close() }), this.sheet);
    this.host.append(this.root);

    this.list.addEventListener('click', e => {
      const li = e.target.closest('.gd-line');
      if (!li) return;
      this.toggle(+li.dataset.i);
    });
    const stop = e => e.stopPropagation();
    this.root.addEventListener('keydown', e => { this._key(e); e.stopPropagation(); });
    this.root.addEventListener('keyup', stop);
    this.root.addEventListener('keypress', stop);
    this._winKey = e => { if (!this._open || this.root.contains(e.target)) return; this._key(e); e.stopPropagation(); };
    this._winKeyUp = e => { if (this._open && !this.root.contains(e.target)) e.stopPropagation(); };
    this._beforePrint = () => this._preparePrint();
    this._afterPrint = () => this._cleanupPrint();
  }

  _fill() {
    const g = this.guide, sm = g.summary;
    this.subEl.textContent = `${g.title} · ${sm.strikes.toLocaleString('en-US')} strikes on ${sm.lines} line${sm.lines === 1 ? '' : 's'} · roughly ${sm.minutesByHand} min at an easy pace`;
    this.setupEl.textContent = '';
    for (const s of g.setup) this.setupEl.append(el('li', {}, s));
    this.legendEl.textContent = '';
    for (const [sym, txt] of g.legend) this.legendEl.append(el('dt', {}, sym), el('dd', {}, txt));
    this.list.textContent = '';
    this.rows = g.lines.map((l, i) => {
      const meta = el('div', { class: 'gd-meta' },
        el('span', { class: 'gd-lineno' }, `Line ${l.label}`),
        el('span', { class: 'gd-roll' }, i === 0 ? `roll ${fmtHalf(l.roll)} from the top` : `return, roll ${fmtHalf(l.roll)}`),
        el('span', { class: 'gd-col' }, `col ${fmtHalf(l.startCol)}`));
      const toks = el('div', { class: 'gd-toks' }, ...l.tokens.map(tokenNode));
      const li = el('li', { class: 'gd-line', 'data-i': String(i), role: 'checkbox', 'aria-checked': 'false', 'aria-label': `Line ${l.label}: ${l.text}` },
        el('span', { class: 'gd-check', 'aria-hidden': 'true' }), meta, toks);
      this.list.append(li);
      return li;
    });
    if (!g.lines.length) this.list.append(el('li', { class: 'gd-empty' }, 'Nothing to type yet.'));
    // sheet map: where the art sits on the page
    const art = this.sheetMap.firstChild, mar = this.sheetMap.lastChild;
    art.style.left = (sm.leftCol / PAGE.COLS * 100) + '%';
    art.style.width = (sm.widthCols / PAGE.COLS * 100) + '%';
    art.style.top = (sm.firstRow / PAGE.ROWS * 100) + '%';
    art.style.height = (Math.max(1, sm.heightLines) / PAGE.ROWS * 100) + '%';
    mar.style.left = (sm.margin / PAGE.COLS * 100) + '%';
    this._renderPreview();
    this._update();
  }

  _renderPreview() {
    const sm = this.guide.summary;
    const strikes = this.strikes.map((s, i) => (s.s == null ? { ...s, s: hash32('guide', s.c, s.x, s.y, i), w: s.w ?? 0.12 } : s));
    const pad = 1.5;
    const x0 = Math.max(0, sm.leftCol - pad), x1 = Math.min(PAGE.COLS, sm.rightCol + 1 + pad);
    const y0 = Math.max(0, sm.firstRow - pad), y1 = Math.min(PAGE.ROWS, sm.lastRow + 1 + pad);
    const wCells = Math.max(4, x1 - x0), hCells = Math.max(3, y1 - y0);
    const scale = Math.min(0.75, 900 / (wCells * PAGE.CW));
    let src = null;
    if (this.PageSurface && strikes.length) {
      try {
        const surf = new this.PageSurface({ paper: this.paper, scale });
        surf.render(strikes, []);
        src = surf.canvas;
        this._surface && this._surface.dispose && this._surface.dispose();
        this._surface = surf;
      } catch (e) { src = null; }
    }
    const cw = PAGE.CW * scale, rh = PAGE.RH * scale;
    const cv = document.createElement('canvas');
    cv.width = Math.round(wCells * cw); cv.height = Math.round(hCells * rh);
    const c = cv.getContext('2d');
    if (src) c.drawImage(src, Math.round(x0 * cw), Math.round(y0 * rh), cv.width, cv.height, 0, 0, cv.width, cv.height);
    else {
      c.fillStyle = '#f6efdf'; c.fillRect(0, 0, cv.width, cv.height);
      c.font = `${PAGE.RH * scale}px "Courier Prime", monospace`; c.textAlign = 'center';
      for (const s of strikes) {
        c.fillStyle = INK_COLORS[s.k] || '#222';
        c.fillText(s.c, (s.x - x0 + 0.5) * cw, (s.y - y0 + 0.74) * rh);
      }
    }
    try { this.preview.src = cv.toDataURL('image/png'); } catch { /* tainted: leave empty */ }
    this.preview.style.aspectRatio = `${cv.width} / ${cv.height}`;
  }

  // ---------------------------------------------------------------- progress
  get current() {
    const n = this.guide ? this.guide.lines.length : 0;
    for (let i = 0; i < n; i++) if (!this.done.has(i)) return i;
    return n;
  }

  toggle(i) {
    if (this.done.has(i)) this.done.delete(i); else this.done.add(i);
    this._save(); this._update(); this._scrollToCurrent(true);
  }

  next() {
    const i = this.current;
    if (i >= this.guide.lines.length) return;
    this.done.add(i);
    this._save(); this._update(); this._scrollToCurrent(true);
  }

  back() {
    const i = this.current;
    let j = i - 1;
    while (j >= 0 && !this.done.has(j)) j--;
    if (j < 0) return;
    this.done.delete(j);
    this._save(); this._update(); this._scrollToCurrent(true);
  }

  reset() { this.done.clear(); this._save(); this._update(); this._scrollToCurrent(true); }

  _save() { store.set(this.guide.id, { done: [...this.done].sort((a, b) => a - b), at: Date.now() }); }

  _update() {
    const n = this.guide.lines.length, cur = this.current, d = this.done.size;
    this.rows.forEach((li, i) => {
      const done = this.done.has(i);
      li.classList.toggle('is-done', done);
      li.classList.toggle('is-now', i === cur);
      li.setAttribute('aria-checked', String(done));
      li.setAttribute('aria-current', i === cur ? 'step' : 'false');
    });
    const pct = n ? Math.round(d / n * 100) : 0;
    this.progressBar.firstChild.style.width = pct + '%';
    this.progressText.innerHTML = !n ? 'Nothing to type'
      : cur >= n ? `<b>All ${n} lines typed.</b> Pull the sheet out and admire it.`
        : `<b>Line ${this.guide.lines[cur].label}</b> next · ${d} of ${n} lines typed (${pct}%)`;
    this.nextBtn.disabled = cur >= n;
    this.backBtn.disabled = d === 0;
  }

  _scrollToCurrent(smooth) {
    const li = this.rows && this.rows[this.current];
    if (!li) return;
    const box = this.steps;
    const r = li.getBoundingClientRect(), b = box.getBoundingClientRect();
    if (r.top < b.top + 60 || r.bottom > b.bottom - 60) {
      box.scrollTo({ top: box.scrollTop + (r.top - b.top) - b.height * 0.3, behavior: smooth ? 'smooth' : 'auto' });
    }
  }

  _key(e) {
    const k = e.key;
    if (e.ctrlKey || e.metaKey || e.altKey) {
      if ((e.ctrlKey || e.metaKey) && (k === 'p' || k === 'P')) { e.preventDefault(); this.print(); }
      return;
    }
    const onButton = e.target && e.target.tagName === 'BUTTON' && e.target !== this.sheet;
    if (k === 'Escape') { e.preventDefault(); this.close(); return; }
    if (k === 'ArrowDown' || k === 'PageDown' || (k === ' ' && !onButton) || (k === 'Enter' && !onButton)) { e.preventDefault(); this.next(); return; }
    if (k === 'ArrowUp' || k === 'PageUp' || k === 'Backspace') { e.preventDefault(); this.back(); return; }
    if (k === 'Tab') {
      const f = [...this.sheet.querySelectorAll('button, summary')].filter(x => !x.disabled && x.offsetParent !== null);
      if (f.length && e.shiftKey && (document.activeElement === f[0] || document.activeElement === this.sheet)) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (f.length && !e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      return;
    }
    if (k.length === 1) e.preventDefault();             // nothing types while the guide is open
  }

  // ---------------------------------------------------------------- export
  downloadText() {
    const blob = new Blob([this.guide.text], { type: 'text/plain;charset=utf-8' });
    const a = el('a', { href: URL.createObjectURL(blob), download: slug(this.guide.title) + '-typewriter-guide.txt' });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  print() {
    this._preparePrint();
    try { window.print(); } finally { setTimeout(() => this._cleanupPrint(), 600); }
  }

  // a clean, static copy of the guide for paper (or PDF)
  _preparePrint() {
    if (!this.guide) return;
    this._cleanupPrint();
    const g = this.guide, sm = g.summary;
    const out = el('div', { class: 'gd-printout' });
    out.append(
      el('header', { class: 'gd-p-head' }, el('h1', {}, 'A guide for your typewriter'),
        el('p', {}, `${g.title} · ${sm.strikes.toLocaleString('en-US')} strikes on ${sm.lines} lines · ${sm.widthCols} columns wide · roughly ${sm.minutesByHand} min`)),
      el('div', { class: 'gd-p-top' },
        el('img', { class: 'gd-p-preview', src: this.preview.src, alt: '' }),
        el('div', { class: 'gd-p-setup' }, el('h2', {}, 'Before you start'), el('ol', {}, ...g.setup.map(s => el('li', {}, s))),
          el('h2', {}, 'Reading the steps'), el('dl', {}, ...g.legend.flatMap(([a, b]) => [el('dt', {}, a), el('dd', {}, b)])))),
      el('h2', { class: 'gd-p-stepshead' }, 'Steps'),
      el('ol', { class: 'gd-p-lines' }, ...g.lines.map((l, i) => el('li', { class: this.done.has(i) ? 'is-done' : '' },
        el('span', { class: 'gd-p-box' }, this.done.has(i) ? '☑' : '☐'),
        el('span', { class: 'gd-p-meta' }, `Line ${l.label}`, el('small', {}, i === 0 ? `↓${fmtHalf(l.roll)} from top` : `roll ${fmtHalf(l.roll)}`), el('small', {}, `col ${fmtHalf(l.startCol)}`)),
        el('span', { class: 'gd-p-toks' }, ...l.tokens.map(tokenNode))))),
      el('p', { class: 'gd-p-foot' }, 'Made with Platen.'));
    document.body.append(out);
    document.body.classList.add('gd-printing');
    this._printout = out;
  }

  _cleanupPrint() {
    document.body.classList.remove('gd-printing');
    if (this._printout) { this._printout.remove(); this._printout = null; }
  }
}

function slug(s) {
  return String(s || 'drawing').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'drawing';
}

// Open a guide for these strikes (creates the view on first use and reuses it).
const GUIDES = new WeakMap();
export function openGuide(host, opts = {}) {
  const h = host || document.body;
  let g = GUIDES.get(h);
  if (!g) { g = new Guide(h, { PageSurface: opts.PageSurface }); GUIDES.set(h, g); }
  return g.open(opts);
}
