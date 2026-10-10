// node --test tests/   — carriage rules and text export (pure logic, no browser needed)
import test from 'node:test';
import assert from 'node:assert/strict';
import { Carriage, LAYOUT, newPage, pageText, wordCount, keyFor, fingerWeight, pageMarkdown, pagesMarkdown, looksLikeArt } from '../js/page.js';

const typeLine = (car, page, text) => {
  for (const ch of text) {
    if (ch === ' ') { car.space(); continue; }
    const r = car.type();
    if (r.act === 'strike' || r.act === 'return+strike') page.strikes.push({ c: ch, x: r.col, y: r.row });
  }
};

test('a fresh page starts at the top-left margin', () => {
  const p = newPage();
  assert.equal(p.cursor.col, LAYOUT.MARGIN_L);
  assert.equal(p.cursor.row, LAYOUT.TOP);
  assert.deepEqual(p.strikes, []);
});

test('typing advances one column per character', () => {
  const car = new Carriage();
  const r = car.type();
  assert.equal(r.act, 'strike');
  assert.equal(r.col, LAYOUT.MARGIN_L);
  assert.equal(car.col, LAYOUT.MARGIN_L + 1);
});

test('the bell rings exactly once, eight characters before the right margin', () => {
  const car = new Carriage();
  let bells = 0, at = -1;
  for (let i = 0; i < 70; i++) {
    const r = car.type();
    if (r.act === 'jam') break;
    if (r.bell) { bells++; at = car.col; }
  }
  assert.equal(bells, 1);
  assert.equal(at, LAYOUT.MARGIN_R - LAYOUT.BELL);
});

test('the carriage locks at the right margin in manual mode', () => {
  const car = new Carriage();
  for (let i = 0; i < LAYOUT.MARGIN_R - LAYOUT.MARGIN_L; i++) assert.notEqual(car.type().act, 'jam');
  assert.equal(car.type().act, 'jam');
  assert.equal(car.col, LAYOUT.MARGIN_R);
});

test('margin release lets you type past the margin', () => {
  const car = new Carriage();
  car.col = LAYOUT.MARGIN_R;
  car.release = true;
  assert.equal(car.type().act, 'strike');
  car.ret();
  assert.equal(car.release, false);
});

test('auto line ends return the carriage at the first space after the bell', () => {
  const car = new Carriage({ lineEnds: 'auto' });
  car.col = LAYOUT.MARGIN_R - 3;
  const r = car.space();
  assert.equal(r.act, 'return');
  assert.equal(car.col, LAYOUT.MARGIN_L);
  assert.equal(car.row, LAYOUT.TOP + 1);
});

test('auto line ends never jam: a letter at the margin returns first', () => {
  const car = new Carriage({ lineEnds: 'auto' });
  car.col = LAYOUT.MARGIN_R;
  const r = car.type();
  assert.equal(r.act, 'return+strike');
  assert.equal(r.col, LAYOUT.MARGIN_L);
  assert.equal(r.row, LAYOUT.TOP + 1);
});

test('carriage return honours line spacing', () => {
  const car = new Carriage({ spacing: 2 });
  car.type(); car.type();
  const ret = car.ret();
  assert.deepEqual([ret.from, ret.to, ret.lines], [LAYOUT.MARGIN_L + 2, LAYOUT.MARGIN_L, 2]);
  assert.equal(car.row, LAYOUT.TOP + 2);
});

test('backspace stops at the left margin', () => {
  const car = new Carriage();
  assert.equal(car.back().act, 'stuck');
  car.type();
  assert.equal(car.back().act, 'back');
  assert.equal(car.col, LAYOUT.MARGIN_L);
});

test('tab jumps to the next stop', () => {
  const car = new Carriage();
  car.type();
  const r = car.tab();
  assert.equal(r.col, LAYOUT.MARGIN_L + LAYOUT.TAB);
  car.tab();
  assert.equal(car.col, LAYOUT.MARGIN_L + 2 * LAYOUT.TAB);
});

test('the sheet is full past the bottom line', () => {
  const car = new Carriage();
  car.row = LAYOUT.BOTTOM;
  assert.equal(car.full, false);
  car.ret();
  assert.equal(car.full, true);
});

test('pageText rebuilds lines, keeps indents, drops the margin', () => {
  const page = newPage();
  const car = new Carriage();
  typeLine(car, page, 'Dear reader,');
  car.ret(); car.ret();
  typeLine(car, page, '  Hello there.');
  assert.equal(pageText(page), 'Dear reader,\n\n  Hello there.');
});

test('pageText: the last strike in a cell wins (retyping fixes a letter)', () => {
  const page = newPage();
  page.strikes.push({ c: 't', x: 10, y: 6 }, { c: 'e', x: 11, y: 6 }, { c: 'h', x: 12, y: 6 }, { c: 'h', x: 11, y: 6 }, { c: 'e', x: 12, y: 6 });
  assert.equal(pageText(page), 'the');
});

test('pageText collapses double spacing', () => {
  const page = newPage();
  const car = new Carriage({ spacing: 2 });
  typeLine(car, page, 'one'); car.ret();
  typeLine(car, page, 'two'); car.ret();
  typeLine(car, page, 'three'); car.ret(); car.ret();
  typeLine(car, page, 'four');
  assert.equal(pageText(page), 'one\ntwo\nthree\n\nfour');
});

test('Markdown: prose keeps its lines, drops indents and escapes formatting', () => {
  const page = newPage();
  page.created = Date.UTC(2026, 9, 9, 12);
  const car = new Carriage();
  typeLine(car, page, 'Dear *Margaret*,'); car.ret(); car.ret();
  typeLine(car, page, '     The rain has_not stopped.'); car.ret();
  typeLine(car, page, '# not a heading');
  const md = pageMarkdown(page, 2);
  assert.match(md, /^## Page 2\n\n\*9 October 2026\*\n\n/);
  assert.ok(md.includes('Dear \\*Margaret\\*,\n\nThe rain has\\_not stopped.\n\\# not a heading\n'), md);
  assert.ok(!/^ {4}/m.test(md), 'no line may start with four spaces (a code block)');
});

test('Markdown: typewriter art goes in a code block, unchanged', () => {
  const page = newPage();
  for (let x = 20; x < 30; x++) page.strikes.push({ c: '#', x, y: 8 }, { c: '@', x, y: 8 });
  page.strikes.push({ c: '.', x: 22.5, y: 9.5 });
  assert.equal(looksLikeArt(page), true);
  const md = pageMarkdown(page, 1);
  assert.ok(md.includes('```text\n@@@@@@@@@@\n'), md);
  assert.ok(md.trimEnd().endsWith('```'));
});

test('Markdown: blank pages are skipped and the header counts the rest', () => {
  const a = newPage(), b = newPage(), c = newPage();
  const car = new Carriage();
  typeLine(car, a, 'One.');
  typeLine(new Carriage(), c, 'Three.');
  const md = pagesMarkdown([a, b, c], { now: Date.UTC(2026, 9, 10, 12) });
  assert.ok(md.startsWith('# Platen pages\n\nTyped on [Platen](https://winchxyz.github.io/platen/) · 2 pages · exported 10 October 2026\n'), md);
  assert.ok(md.includes('## Page 1') && md.includes('## Page 3') && !md.includes('## Page 2'));
  assert.equal(looksLikeArt(a), false);
});

test('wordCount counts words, not punctuation', () => {
  assert.equal(wordCount("It's a quiet night — rain, a lamp."), 7);
  assert.equal(wordCount(''), 0);
});

test('keyFor maps characters to physical keys', () => {
  assert.deepEqual(keyFor('a'), { id: 'a', shift: false });
  assert.deepEqual(keyFor('A'), { id: 'a', shift: true });
  assert.deepEqual(keyFor('?'), { id: '/', shift: true });
  assert.deepEqual(keyFor('"'), { id: "'", shift: true });
  assert.equal(keyFor('é').id, null);
  assert.ok(fingerWeight('q') < fingerWeight('f'));
});
