// Page model and the carriage's rules: margins, the bell, the margin lock, tabs, line spacing.
// Pure logic, no DOM: the app turns the returned events into animation, ink and sound.

export const LAYOUT = {
  COLS: 85, ROWS: 66,   // US Letter at pica pitch
  TOP: 6,               // first line on a fresh sheet (1 inch down)
  BOTTOM: 62,           // last line before the sheet is full
  MARGIN_L: 10, MARGIN_R: 75,
  BELL: 8,              // the bell rings this many characters before the right margin
  TAB: 5,
};

let idCounter = 0;
export function newPage(paper = 'ivory') {
  return {
    id: Date.now().toString(36) + (idCounter++).toString(36),
    paper, strikes: [], ghosts: [], created: Date.now(),
    cursor: { col: LAYOUT.MARGIN_L, row: LAYOUT.TOP },
  };
}

export class Carriage {
  constructor({ col = LAYOUT.MARGIN_L, row = LAYOUT.TOP, marginL = LAYOUT.MARGIN_L, marginR = LAYOUT.MARGIN_R,
    spacing = 1, lineEnds = 'manual' } = {}) {
    Object.assign(this, { col, row, marginL, marginR, spacing, lineEnds });
    this.release = false;       // margin release: lets the next characters pass the right margin
  }

  get bellCol() { return this.marginR - LAYOUT.BELL; }
  get limit() { return this.release ? LAYOUT.COLS - 1 : this.marginR; }

  // move right by n columns; reports whether the bell was passed on the way
  _advance(n) {
    const before = this.col;
    this.col = Math.min(this.col + n, LAYOUT.COLS - 1);
    return before < this.bellCol && this.col >= this.bellCol;
  }

  // a character key. Returns { act: 'strike', col, row, bell } or { act: 'jam' } or, in auto mode,
  // { act: 'return+strike', ret, col, row, bell } when the carriage had to be returned first.
  type({ advance = true } = {}) {
    if (this.col >= this.limit) {
      if (this.lineEnds === 'auto') {
        const ret = this.ret();
        const col = this.col, row = this.row;
        const bell = advance ? this._advance(1) : false;
        return { act: 'return+strike', ret, col, row, bell };
      }
      return { act: 'jam' };
    }
    const col = this.col, row = this.row;
    const bell = advance ? this._advance(1) : false;
    return { act: 'strike', col, row, bell };
  }

  // the space bar; in auto mode a space after the bell returns the carriage instead
  space() {
    if (this.lineEnds === 'auto' && this.col >= this.bellCol) return { act: 'return', ret: this.ret() };
    if (this.col >= this.limit) return { act: 'jam' };
    const bell = this._advance(1);
    return { act: 'space', bell };
  }

  back(n = 1) {
    const min = this.release ? 0 : Math.min(this.marginL, this.col);
    const before = this.col;
    this.col = Math.max(min, this.col - n);
    return { act: before === this.col ? 'stuck' : 'back', from: before, col: this.col };
  }

  ret() {
    const from = this.col;
    this.col = this.marginL;
    this.row += this.spacing;
    this.release = false;
    return { from, to: this.col, lines: this.spacing, row: this.row };
  }

  tab() {
    const stop = this.marginL + Math.floor((this.col - this.marginL) / LAYOUT.TAB + 1) * LAYOUT.TAB;
    const to = Math.min(stop, this.limit);
    const from = this.col;
    const bell = from < this.bellCol && to >= this.bellCol;
    this.col = to;
    return { act: 'move', from, col: to, bell };
  }

  // free moves (draw mode / arrows / clicking the sheet)
  moveTo(col, row) {
    const from = { col: this.col, row: this.row };
    this.col = Math.max(0, Math.min(LAYOUT.COLS - 1, col));
    this.row = Math.max(0, Math.min(LAYOUT.ROWS - 1, row));
    return { act: 'moveTo', from, col: this.col, row: this.row };
  }

  get full() { return this.row > LAYOUT.BOTTOM; }
}

// ---------------------------------------------------------------- text export

// The page as plain text: the last character struck in each cell wins (retyping over a letter
// is how you fix it), ghosts are ignored, the common left margin and the blank top are dropped.
export function pageText(page) {
  // group impressions into lines by their vertical position (quarter-line tolerance)
  const lines = new Map();
  let minCol = Infinity;
  for (const s of page.strikes) {
    if (!s.c || /\s/.test(s.c)) continue;
    const y = Math.round(s.y * 4) / 4, c = Math.round(s.x);
    if (c < 0) continue;
    if (!lines.has(y)) lines.set(y, new Map());
    lines.get(y).set(c, s.c);
    if (c < minCol) minCol = c;
  }
  if (!lines.size) return '';
  const ys = [...lines.keys()].sort((a, b) => a - b);
  // the line spacing in use is the most common gap (when it repeats); bigger gaps are blank lines
  const counts = new Map();
  for (let i = 1; i < ys.length; i++) { const g = ys[i] - ys[i - 1]; counts.set(g, (counts.get(g) || 0) + 1); }
  let base = 1, best = 1;
  for (const [g, n] of counts) if (n > best || (n === best && n > 1 && g < base)) { base = g; best = n; }
  if (!(base > 0)) base = 1;
  const out = [];
  ys.forEach((y, i) => {
    if (i) {
      const blanks = Math.min(3, Math.max(0, Math.round((y - ys[i - 1]) / base) - 1));
      for (let b = 0; b < blanks; b++) out.push('');
    }
    const row = lines.get(y);
    let maxC = minCol;
    for (const c of row.keys()) if (c > maxC) maxC = c;
    let line = '';
    for (let c = minCol; c <= maxC; c++) line += row.get(c) || ' ';
    out.push(line.replace(/\s+$/, ''));
  });
  return out.join('\n');
}

export function wordCount(text) {
  const m = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return m ? m.length : 0;
}

// physical key a typed character comes from (for the key and typebar animation)
const SHIFT_MAP = { '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '¢': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  '_': '-', '+': '=', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/' };
export function keyFor(ch) {
  if (/^[a-z0-9\-=;',./]$/.test(ch)) return { id: ch, shift: false };
  if (/^[A-Z]$/.test(ch)) return { id: ch.toLowerCase(), shift: true };
  if (SHIFT_MAP[ch]) return { id: SHIFT_MAP[ch], shift: true };
  return { id: null, shift: false };
}

// how hard a finger lands on a key: pinkies are lighter, punctuation punches harder
const LIGHT = new Set(['q', 'a', 'z', 'p', ';', '/', '1', '0', '-', '=', "'"]);
export function fingerWeight(id) {
  if (!id) return 1;
  if (LIGHT.has(id)) return 0.88;
  if (id === '.' || id === ',') return 1.06;
  return 1;
}
