// node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGuide, guideText, tokensText, fmtHalf, SPACE_MARK, BACK_MARK } from '../js/guide.js';
import * as art from '../js/art.js';

const S = (c, x, y, k = 'k', p = 1) => ({ c, x, y, k, p, f: 'pica' });

test('empty input gives an empty guide that still exports', () => {
  const g = makeGuide([], { title: 'Nothing' });
  assert.equal(g.lines.length, 0);
  assert.equal(g.summary.strikes, 0);
  assert.match(g.text, /Nothing/);
  assert.match(g.text, /nothing to type/);
});

test('lines are grouped by row, top to bottom, with the roll from the previous line', () => {
  const g = makeGuide([S('b', 12, 9), S('a', 10, 7), S('c', 11, 7), S('d', 10, 9.5), S('e', 10, 12)]);
  assert.deepEqual(g.lines.map(l => l.row), [7, 9, 9.5, 12]);
  assert.deepEqual(g.lines.map(l => l.roll), [7, 2, 0.5, 2.5]);
  assert.deepEqual(g.lines.map(l => l.label), ['8', '10', '10½', '13']);
  assert.equal(g.summary.halfLines, true);
  assert.equal(g.summary.firstRow, 7);
  assert.match(g.setup.join(' '), /roll down 7 lines/);
});

test('margin, start column and run-length steps', () => {
  // margin = 4 (leftmost strike); this line starts 3 past it
  const g = makeGuide([S('#', 4, 2), S('.', 7, 3), S(':', 8, 3), S(':', 9, 3), S('o', 10, 3), S('x', 16, 3), S('x', 18, 3)]);
  assert.equal(g.summary.margin, 4);
  const l = g.lines[1];
  assert.equal(l.startCol, 7);
  assert.equal(l.fromMargin, 3);
  assert.deepEqual(l.tokens.map(t => t.t), ['space', 'type', 'space', 'type']);
  assert.equal(l.tokens[0].n, 3);
  assert.equal(l.tokens[1].s, '.::o');
  assert.equal(l.tokens[2].n, 5);
  assert.equal(l.tokens[3].s, 'x' + SPACE_MARK + 'x', 'one or two spaces stay inside the run');
  assert.equal(l.text, '‹3›  .::o  ‹5›  x␣x');
  // keystrokes: 3 + 4 + 5 + 3
  assert.equal(l.keys, 15);
});

test('overstrikes become stacks: type, backspace, type', () => {
  const g = makeGuide([S('#', 5, 1), S('@', 5, 1), S('o', 6, 1), S('M', 7, 1), S('W', 7, 1), S('#', 7, 1)]);
  const t = g.lines[0].tokens;
  assert.deepEqual(t.map(x => x.t), ['stack', 'type', 'stack']);
  assert.deepEqual(t[0].glyphs.map(x => x.c), ['#', '@']);
  assert.deepEqual(t[2].glyphs.map(x => x.c), ['M', 'W', '#']);
  assert.equal(g.lines[0].text, `#${BACK_MARK}@  o  M${BACK_MARK}W${BACK_MARK}#`);
  assert.equal(g.summary.stacks, 2);
  assert.ok(g.legend.some(([sym]) => sym.includes(BACK_MARK)));
});

test('ribbon colour switches are marked once per change, across lines', () => {
  const g = makeGuide([S('a', 0, 0), S('b', 1, 0, 'r'), S('c', 2, 0, 'r'), S('d', 0, 1, 'r'), S('e', 1, 1)]);
  assert.deepEqual(g.lines[0].tokens.map(t => t.t), ['type', 'ink', 'type']);
  assert.equal(g.lines[0].tokens[1].k, 'r');
  assert.deepEqual(g.lines[1].tokens.map(t => t.t), ['type', 'ink', 'type'], 'red carries over to the next line');
  assert.equal(g.lines[1].tokens[1].k, 'k');
  assert.equal(g.summary.inkSwitches, 2);
  assert.deepEqual(g.summary.inks, ['k', 'r']);
  assert.match(g.setup.join(' '), /black & red/);
  assert.match(g.lines[0].text, /‹red›/);
});

test('half spaces and characters set back are spelled out', () => {
  const g = makeGuide([S('a', 2, 0), S('b', 3.5, 0), S('c', 4, 0)]);
  const t = g.lines[0].tokens;
  assert.deepEqual(t.map(x => x.t), ['type', 'space', 'type', 'back', 'type']);
  assert.equal(t[1].n, 0.5);
  assert.equal(t[3].n, 0.5);
  assert.equal(g.summary.halfSpaces, true);
  assert.equal(fmtHalf(0.5), '½');
  assert.equal(fmtHalf(3.5), '3½');
  assert.equal(fmtHalf(4), '4');
});

test('firm and light strikes are marked', () => {
  const g = makeGuide([S('a', 0, 0), S('b', 1, 0, 'k', 1.3), S('c', 2, 0, 'k', 1.3), S('d', 3, 0, 'k', 0.7)]);
  assert.deepEqual(g.lines[0].tokens.map(t => [t.t, t.pc]), [['type', 0], ['type', 1], ['type', -1]]);
  assert.match(tokensText(g.lines[0].tokens), /‹firm›bc  ‹light›d/);
});

test('every strike is accounted for; a planner picture round-trips', () => {
  const img = { width: 120, height: 120, data: new Uint8ClampedArray(120 * 120 * 4) };
  for (let i = 0; i < 120 * 120; i++) {
    const x = i % 120, y = Math.floor(i / 120);
    const v = Math.hypot(x - 60, y - 60) < 45 ? 40 + x : 255;
    img.data.set([v, v, v, 255], i * 4);
  }
  const strikes = art.orderStrikes(art.imageToStrikes(img, { cols: 40, x0: 10, y0: 5, halfRows: true }));
  const g = makeGuide(strikes, { title: 'Disc' });
  let n = 0;
  for (const l of g.lines) for (const t of l.tokens) n += t.t === 'type' ? t.n : t.t === 'stack' ? t.glyphs.length * t.repeat : 0;
  assert.equal(n, strikes.length);
  assert.equal(g.summary.strikes, strikes.length);
  // replay the steps and land on the same cells
  const seen = [];
  for (const l of g.lines) {
    let cur = g.summary.margin;
    for (const t of l.tokens) {
      if (t.t === 'space') cur += t.n;
      else if (t.t === 'back') cur -= t.n;
      else if (t.t === 'stack') for (let r = 0; r < t.repeat; r++) { for (const gl of t.glyphs) seen.push(`${gl.c}@${cur},${l.row}`); cur += 1; }
      else if (t.t === 'type' && t.repeat > 1) for (let r = 0; r < t.repeat; r++) { seen.push(`${t.s}@${cur},${l.row}`); cur += 1; }
      else if (t.t === 'type') for (const ch of t.s) { if (ch !== SPACE_MARK) seen.push(`${ch}@${cur},${l.row}`); cur += 1; }
    }
  }
  assert.deepEqual(seen.sort(), strikes.map(s => `${s.c}@${s.x},${s.y}`).sort());
});

test('plain-text export lists setup, legend and every line', () => {
  const g = makeGuide([S('H', 30, 10), S('i', 31, 10), S('!', 31, 11)], { title: 'Greeting' });
  const t = guideText(g);
  assert.equal(t, g.text);
  assert.match(t, /Greeting/);
  assert.match(t, /SETUP/);
  assert.match(t, /left margin at\s+30/);
  assert.match(t, /\[ \] Line 11 /);
  assert.match(t, /\[ \] Line 12 /);
  assert.match(t, /Hi/);
  assert.ok(g.summary.fitsA4);
  const wide = makeGuide([S('x', 84, 3)]);
  assert.equal(wide.summary.fitsA4, false);
  assert.match(wide.setup[0], /use Letter/);
  assert.notEqual(makeGuide([S('x', 1, 1)]).id, makeGuide([S('y', 1, 1)]).id);
});

test('repeats: long runs of one character and identical overstrikes side by side are counted', () => {
  const row = [S('.', 0, 0), ...Array.from({ length: 9 }, (_, i) => S(':', 1 + i, 0)), S('o', 10, 0)];
  const stacks = Array.from({ length: 5 }, (_, i) => [S('#', 20 + i, 0), S('@', 20 + i, 0)]).flat();
  const g = makeGuide([...row, ...stacks]);
  const t = g.lines[0].tokens;
  assert.deepEqual(t.map(x => [x.t, x.s || '', x.repeat]), [['type', '.', 1], ['type', ':', 9], ['type', 'o', 1], ['space', '', undefined], ['stack', '', 5]]);
  assert.equal(g.lines[0].text, `.  9×:  o  ‹9›  5×#${BACK_MARK}@`);
  assert.equal(g.summary.cells, 11 + 5);
  // three in a row stay in the run
  assert.equal(makeGuide([S('-', 0, 0), S('-', 1, 0), S('-', 2, 0)]).lines[0].tokens[0].s, '---');
});
