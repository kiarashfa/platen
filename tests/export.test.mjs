// node --test tests/*.test.mjs — image export helpers
import test from 'node:test';
import assert from 'node:assert/strict';
import { separateInk, cropRect, cropData, exportName } from '../js/export.js';

const px = (...rgba) => new Uint8ClampedArray(rgba);

test('bare paper becomes fully transparent', () => {
  const paper = px(240, 232, 214, 255);
  const out = separateInk(paper, paper, 'clear');
  assert.equal(out[3], 0);
});

test('black ink on cream paper becomes opaque near-black', () => {
  const paper = px(240, 232, 214, 255);
  const page = px(24, 23, 21, 255);         // paper * 0.1
  const out = separateInk(page, paper, 'clear');
  assert.ok(out[3] > 225, 'alpha ' + out[3]);
  assert.ok(out[0] < 20 && out[1] < 20 && out[2] < 20);
});

test('clear ink over white reproduces the white-paper version', () => {
  const paper = px(236, 226, 205, 255);
  const page = px(200, 90, 80, 255);        // a reddish impression
  const clear = separateInk(page, paper, 'clear');
  const white = separateInk(page, paper, 'white');
  const a = clear[3] / 255;
  for (let c = 0; c < 3; c++) {
    const over = 255 * (1 - a) + clear[c] * a;
    assert.ok(Math.abs(over - white[c]) < 12, `channel ${c}: ${over} vs ${white[c]}`);
  }
});

test('white mode removes the paper colour but keeps the ink', () => {
  const paper = px(200, 170, 130, 255);     // kraft
  const out = separateInk(px(200, 170, 130, 255, 100, 85, 65, 255), px(200, 170, 130, 255, 200, 170, 130, 255), 'white');
  assert.deepEqual([...out.slice(0, 3)], [255, 255, 255]);
  assert.ok(Math.abs(out[4] - 127.5) < 2);
  assert.equal(paper.length, 4);
});

test('cropRect unions, pads and clamps', () => {
  const r = cropRect([{ x: 100, y: 50, w: 20, h: 40 }, { x: 300, y: 400, w: 24, h: 40 }], 10, 350, 420);
  assert.deepEqual(r, { x: 90, y: 40, w: 244, h: 380 });
  assert.equal(cropRect([], 10, 100, 100), null);
});

test('cropData copies the right pixels', () => {
  const W = 4, H = 3, data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) data[i * 4] = i;
  const out = cropData(data, W, { x: 1, y: 1, w: 2, h: 2 });
  assert.deepEqual([out[0], out[4], out[8], out[12]], [5, 6, 9, 10]);
});

test('file names say what they are', () => {
  assert.equal(exportName('sheet', 2, 'paper'), 'platen-page-2.png');
  assert.equal(exportName('ink', 3, 'clear'), 'platen-page-3-ink-transparent.png');
  assert.equal(exportName('photo', 1, 'paper'), 'platen-photo.png');
});
