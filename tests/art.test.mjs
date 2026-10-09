// node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as art from '../js/art.js';

const img = (w, h, f) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = f(x, y), i = (y * w + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
  }
  return { width: w, height: h, data };
};
const cells = strikes => new Set(strikes.map(s => `${s.x},${s.y}`));
const isStrike = s => typeof s.c === 'string' && s.c.length >= 1 && Number.isFinite(s.x) && Number.isFinite(s.y)
  && typeof s.k === 'string' && Number.isFinite(s.p) && typeof s.f === 'string';

test('built-in ramps are monotonic light -> dark and start blank', () => {
  for (const tf of ['pica', 'elite', 'cutive']) {
    const ramp = art.rampSync(tf);
    assert.ok(ramp.length >= 12 && ramp.length <= 16, `${tf}: ${ramp.length} levels`);
    assert.deepEqual(ramp[0].glyphs, []);
    assert.equal(ramp[0].density, 0);
    for (let i = 1; i < ramp.length; i++) {
      assert.ok(ramp[i].density > ramp[i - 1].density, `${tf} level ${i} darker than ${i - 1}`);
      assert.ok(ramp[i].glyphs.length >= 1 && ramp[i].glyphs.length <= 3);
    }
    assert.equal(ramp[ramp.length - 1].density, 1);
  }
});

test('densityRamp under Node falls back to the measured table; injected measure builds a monotonic ramp', async () => {
  const r = await art.densityRamp('pica');
  assert.equal(r, art.rampSync('pica'));
  // a fake typeface: ink per glyph from its char code, stacks as independent layers
  const cov = c => 0.02 + ((c.charCodeAt(0) * 37) % 100) / 260;
  const measure = gl => 1 - gl.reduce((s, c) => s * (1 - cov(c)), 1);
  const ramp = await art.densityRamp('pica', { measure });
  assert.ok(ramp.length >= 12, `levels ${ramp.length}`);
  for (let i = 1; i < ramp.length; i++) assert.ok(ramp[i].density > ramp[i - 1].density);
  assert.notEqual(art.rampSync('pica'), ramp, 'an injected measure does not replace the cached ramp');
});

test('imageToStrikes: a white picture gives no strikes in any style', () => {
  const white = img(120, 80, () => 255);
  for (const style of ['shade', 'line', 'stipple']) {
    assert.equal(art.imageToStrikes(white, { cols: 40, style }).length, 0, style);
    assert.equal(art.imageToStrikes(white, { cols: 40, style, halfRows: true }).length, 0, style + ' half');
  }
});

test('imageToStrikes respects position, cols and rows', () => {
  const grad = img(200, 100, x => Math.round(255 * x / 199));            // black left -> white right
  for (const style of ['shade', 'line', 'stipple']) for (const halfRows of [false, true]) {
    const s = art.imageToStrikes(grad, { x0: 10, y0: 7, cols: 30, rows: 12, style, halfRows });
    assert.ok(s.length > 0, `${style} produced strikes`);
    for (const t of s) {
      assert.ok(isStrike(t), 'strike shape');
      assert.ok(t.x >= 10 && t.x < 40, `${style} x in bounds: ${t.x}`);
      assert.ok(t.y >= 7 - 0.5 && t.y < 19, `${style} y in bounds: ${t.y}`);
      if (!halfRows && style === 'shade') assert.equal(t.y % 1, 0);
    }
  }
  // rows from the aspect: 60 cols of a 2:1 picture -> 60 * 0.6 / 2 = 18 lines
  assert.equal(art.pictureRows(200, 100, 60), 18);
  const s = art.imageToStrikes(grad, { cols: 60, style: 'shade' });
  assert.ok(Math.max(...s.map(t => t.y)) <= 17);
  assert.ok(Math.max(...s.map(t => t.x)) <= 59);
});

test('imageToStrikes: a black picture fills every cell with the darkest stack; shade gets lighter left to right', () => {
  const black = img(60, 60, () => 0);
  const s = art.imageToStrikes(black, { cols: 20, rows: 10, style: 'shade', autoLevels: false });
  assert.equal(cells(s).size, 200);
  const dark = art.rampSync('pica').at(-1).glyphs;
  assert.equal(s.length, 200 * dark.length);
  const grad = img(200, 100, x => Math.round(255 * x / 199));
  const g = art.imageToStrikes(grad, { cols: 40, rows: 10, style: 'shade' });
  const left = g.filter(t => t.x < 10).length, right = g.filter(t => t.x >= 30).length;
  assert.ok(left > right * 2, `more ink on the dark side (${left} vs ${right})`);
  // the light end stays clean paper
  assert.equal(g.filter(t => t.x >= 39).length, 0);
});

test('imageToStrikes styles use their own characters', () => {
  const disc = img(160, 160, (x, y) => (Math.hypot(x - 80, y - 80) < 50 ? 30 : 255));
  const st = art.imageToStrikes(disc, { cols: 40, style: 'stipple' });
  assert.ok(st.length > 0);
  assert.ok(st.every(t => t.c === '.' || t.c === ':'));
  assert.ok(st.every(t => (t.x * 2) % 1 === 0 && (t.y * 2) % 1 === 0), 'stipple sits on half steps');
  const ln = art.imageToStrikes(disc, { cols: 40, style: 'line', hatch: 0 });
  assert.ok(ln.length > 20 && ln.length < 200, `outline only: ${ln.length}`);
  const chars = new Set(ln.map(t => t.c));
  assert.ok(['/', '\\', '|', '-', '_', '(', ')'].filter(c => chars.has(c)).length >= 3, [...chars].join(''));
});

test('a horizontal line of n cells gives n strikes', () => {
  for (const n of [1, 5, 17]) {
    const s = art.shapesToStrikes([{ type: 'line', x1: 2.5, y1: 5.5, x2: 2.5 + n - 1, y2: 5.5, glyph: '#' }]);
    assert.equal(s.length, n);
    assert.ok(s.every(t => t.y === 5 && t.c === '#'));
    assert.deepEqual(s.map(t => t.x).sort((a, b) => a - b), Array.from({ length: n }, (_, i) => 2 + i));
  }
  const auto = art.shapesToStrikes([{ type: 'line', x1: 2.2, y1: 5.3, x2: 12.2, y2: 5.3, glyph: 'auto' }]);
  assert.ok(auto.every(t => t.c === '-'), 'a line through the middle of the cells is hyphens');
  const low = art.shapesToStrikes([{ type: 'line', x1: 2.2, y1: 5.8, x2: 12.2, y2: 5.8, glyph: 'auto' }]);
  assert.ok(low.every(t => t.c === '_'), 'a line along the bottom of the cells is underscores');
  const up = art.shapesToStrikes([{ type: 'line', x1: 2.5, y1: 12.5, x2: 12.5, y2: 2.5, glyph: 'auto' }]);
  assert.ok(up.every(t => t.c === '/'), 'rising diagonal: ' + up.map(t => t.c).join(''));
  const vert = art.shapesToStrikes([{ type: 'line', x1: 4.5, y1: 1.5, x2: 4.5, y2: 9.5, glyph: 'auto' }]);
  assert.equal(vert.length, 9);
  assert.ok(vert.every(t => t.c === '|'));
});

test('half steps put strikes on the half grid', () => {
  const s = art.shapesToStrikes([{ type: 'line', x1: 2.25, y1: 5.25, x2: 6.75, y2: 5.25, glyph: '-', halfStep: true }]);
  assert.equal(s.length, 10);
  assert.ok(s.every(t => (t.x * 2) % 1 === 0 && t.y === 5));
});

test('rectangle outline and fill', () => {
  const r = { type: 'rect', x: 2, y: 3, w: 10, h: 4, glyph: 'auto' };
  const s = art.shapesToStrikes([r]);
  assert.equal(s.length, 2 * 10 + 2 * 4 - 4);
  assert.equal(s.filter(t => t.c === '+').length, 4);
  assert.equal(s.filter(t => t.c === '-').length, 16);
  assert.equal(s.filter(t => t.c === '|').length, 4);
  for (const t of s) assert.ok(t.x >= 2 && t.x <= 11 && t.y >= 3 && t.y <= 6);
  // fill of the 10 x 4 rectangle: 40 cells
  const f = art.shapesToStrikes([{ type: 'fill', of: { type: 'rect', x: 2, y: 3, w: 10, h: 4 }, glyph: '#' }]);
  assert.equal(f.length, 40);
  assert.equal(cells(f).size, 40);
  // a fill after its outline stays inside the lines
  const both = art.rasterizeShapes([r, { type: 'fill', of: { type: 'rect', x: 2, y: 3, w: 10, h: 4 }, glyph: 'o' }]);
  assert.equal(both.perShape[1].strikes.length, 8 * 2);
  // shade fill uses ramp characters on every cell
  const sh = art.shapesToStrikes([{ type: 'fill', of: { type: 'rect', x: 0, y: 0, w: 10, h: 4 }, glyph: 'auto', shade: 0.6 }]);
  assert.equal(cells(sh).size, 40);
});

test('flood fill inside an outline, refused when the area is open', () => {
  const box = { type: 'rect', x: 10, y: 10, w: 12, h: 6, glyph: '#' };
  const res = art.rasterizeShapes([box, { type: 'fill', at: [15, 12], glyph: '.' }]);
  assert.equal(res.perShape[1].ok, true);
  assert.equal(res.perShape[1].strikes.length, 10 * 4);
  const open = art.rasterizeShapes([{ type: 'line', x1: 10.5, y1: 10.5, x2: 30.5, y2: 10.5, glyph: '#' }, { type: 'fill', at: [15, 14], glyph: '.' }]);
  assert.equal(open.perShape[1].ok, false);
  assert.equal(open.perShape[1].strikes.length, 0);
});

test('ellipse outline is a closed thin ring inside its box', () => {
  const e = { type: 'ellipse', x: 10, y: 5, w: 20, h: 10, glyph: 'auto' };
  const s = art.shapesToStrikes([e]);
  assert.equal(cells(s).size, s.length, 'no cell struck twice');
  for (const t of s) assert.ok(t.x >= 10 && t.x < 30 && t.y >= 5 && t.y < 15);
  assert.ok(s.some(t => t.c === '(') && s.some(t => t.c === ')'), 'brackets on the sides');
  assert.ok(s.length > 30 && s.length < 70, `ring size ${s.length}`);
});

test('pencil strokes: one strike per cell, direction-aware glyphs, pressure and ink carried', () => {
  const pts = Array.from({ length: 50 }, (_, i) => [5 + i * 0.4, 20 - i * 0.24]);
  const s = art.shapesToStrikes([{ type: 'pencil', points: pts, glyph: 'auto', ink: 'r', pressure: 1.3 }], { typeface: 'elite' });
  assert.equal(cells(s).size, s.length);
  assert.ok(s.every(t => t.k === 'r' && t.p === 1.3 && t.f === 'elite'));
  assert.ok(s.filter(t => t.c === '/').length > s.length / 2, s.map(t => t.c).join(''));
  const stack = art.shapesToStrikes([{ type: 'pencil', points: [[1.5, 1.5], [3.5, 1.5]], glyph: 'MW' }]);
  assert.equal(stack.length, 6, 'a two-character glyph is an overstrike stack');
});

test('orderStrikes: line by line, left to right, duplicates removed, stacks kept in order', () => {
  const mk = (c, x, y) => ({ c, x, y, k: 'k', p: 1, f: 'pica' });
  const out = art.orderStrikes([mk('a', 5, 2), mk('b', 1, 3), mk('c', 9, 1), mk('#', 4, 2), mk('@', 4, 2), mk('a', 5, 2), mk('d', 2, 1.5), mk('M', 4, 2)]);
  assert.deepEqual(out.map(s => s.c), ['c', 'd', '#', '@', 'M', 'a', 'b']);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].y > out[i - 1].y || (out[i].y === out[i - 1].y && out[i].x >= out[i - 1].x));
  }
  assert.equal(art.orderStrikes([]).length, 0);
});

test('banner width and letters', () => {
  const sz = art.bannerSize('HH', { size: 2 });
  assert.deepEqual(sz, { cols: 22, rows: 7 });
  const s = art.bannerToStrikes('HH', { x0: 3, y0: 4, size: 2, glyph: '#' });
  assert.equal(Math.min(...s.map(t => t.x)), 3);
  assert.equal(Math.max(...s.map(t => t.x)), 3 + 22 - 1);
  assert.equal(Math.max(...s.map(t => t.y)), 4 + 7 - 1);
  assert.ok(s.every(t => t.c === '#'));
  const own = art.bannerToStrikes('HI', { size: 1 });
  assert.ok(own.some(t => t.c === 'H') && own.some(t => t.c === 'I'));
  assert.deepEqual(art.bannerSize('A B', { size: 1 }), { cols: 5 + 1 + 3 + 1 + 5, rows: 7 });
  assert.deepEqual(art.bannerSize('AB\nC', { size: 3 }), { cols: (5 + 1 + 5) * 3, rows: (7 * 2 + 2) * 2 });
});

test('typing time estimate: real speed, 6 strikes a second plus a second per line', () => {
  const s = Array.from({ length: 18 }, (_, i) => ({ c: 'x', x: i % 9, y: i < 9 ? 0 : 1, k: 'k', p: 1, f: 'pica' }));
  assert.equal(art.estimateSeconds(s), 18 / 6 + 2 * 1);
  assert.match(art.formatDuration(300), /about 5 min/);
});

test('strikes from every source stay on the page', () => {
  const s = art.shapesToStrikes([
    { type: 'line', x1: -5, y1: 3.5, x2: 100, y2: 3.5, glyph: '#' },
    { type: 'banner', text: 'WIDE BANNER TEXT', x: 40, y: 60, size: 2 },
  ]);
  for (const t of s) assert.ok(t.x >= 0 && t.x <= art.PAGE.COLS - 1 && t.y >= 0 && t.y <= art.PAGE.ROWS - 1);
});
