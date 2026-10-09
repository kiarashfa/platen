// End-to-end check of the Planner with real mouse / keyboard input (Playwright Chromium).
//   node tools/art-planner-check.mjs [--port 8875] [--w 1600 --h 1000] [--shot name]
// Drives dev/planner.html: draws with every tool, erases, undoes, places a picture and a
// banner, checks that no key leaks to the page behind, presses "Type it" and checks the order.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const port = +opt('port', 8875);
const W = +opt('w', 1600), H = +opt('h', 1000);

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('[error] ' + m.text()); });
await page.goto(`http://localhost:${port}/dev/planner.html?shot=empty&typed=0`);
await page.waitForFunction(() => window.__done, null, { timeout: 60000 });

const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok: !!ok, info }); };
const st = () => page.evaluate(() => ({
  shapes: planner.shapes.map(s => s.type), planned: planner.plannedStrikes.length, tool: planner.tool,
  open: planner.isOpen, undo: planner.undoStack.length, redo: planner.redoStack.length, selected: planner.selected,
}));
// page cell -> client px
const box = await page.evaluate(() => { const r = planner.el.page.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
const at = (cx, cy) => ({ x: box.x + cx / 85 * box.w, y: box.y + cy / 66 * box.h });
const drag = async (a, b, steps = 12, mods = []) => {
  for (const m of mods) await page.keyboard.down(m);
  const p = at(...a), q = at(...b);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(p.x + (q.x - p.x) * i / steps, p.y + (q.y - p.y) * i / steps);
  await page.mouse.up();
  for (const m of mods) await page.keyboard.up(m);
  await page.waitForTimeout(60);
};
const click = async c => { const p = at(...c); await page.mouse.click(p.x, p.y); await page.waitForTimeout(60); };
const key = async k => { await page.keyboard.press(k); await page.waitForTimeout(40); };
const focusSheet = () => page.evaluate(() => planner.el.sheet.focus());

await focusSheet();
await key('p');
check('P selects the pencil', (await st()).tool === 'pencil');
// a wavy pencil stroke
{
  const p = at(10, 12);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  for (let i = 1; i <= 40; i++) { const q = at(10 + i * 0.6, 12 + Math.sin(i / 6) * 3); await page.mouse.move(q.x, q.y); }
  await page.mouse.up();
}
let s = await st();
check('pencil stroke adds a shape with strikes', s.shapes.join() === 'pencil' && s.planned >= 20, JSON.stringify(s));

await key('l');
await drag([10.5, 22.5], [40.5, 22.5]);
s = await st();
const lineCells = await page.evaluate(() => planner._perShape[1].strikes.map(t => t.y));
check('line tool: 31 strikes on line 22', s.shapes[1] === 'line' && lineCells.length === 31 && lineCells.every(y => y === 22), lineCells.length);

await key('b');
await drag([50.5, 6.5], [69.5, 15.5]);
s = await st();
const rectInfo = await page.evaluate(() => { const r = planner.shapes[2]; return { x: r.x, y: r.y, w: r.w, h: r.h, n: planner._perShape[2].strikes.length }; });
check('box tool snaps to cells', rectInfo.x === 50 && rectInfo.y === 6 && rectInfo.w === 20 && rectInfo.h === 10 && rectInfo.n === 2 * 20 + 2 * 10 - 4, JSON.stringify(rectInfo));

await key('o');
await drag([10.5, 30.5], [35.5, 44.5], 10, ['Shift']);
s = await st();
const ell = await page.evaluate(() => { const e = planner.shapes[3]; return { w: e.w, h: e.h }; });
check('oval with Shift is a circle on paper (w x 0.6 = h)', s.shapes[3] === 'ellipse' && Math.abs(ell.w * 0.6 - ell.h) <= 1, JSON.stringify(ell));

await key('f');
const before = (await st()).planned;
await click([60, 10]);
s = await st();
check('fill inside the box fills its interior (18 x 8 cells)', s.shapes[4] === 'fill' && s.planned - before === 18 * 8, `${s.planned - before}`);
await click([80, 40]);
s = await st();
const toast = await page.evaluate(() => planner.el.toast.textContent);
check('fill in an open area is refused with a message', s.shapes.length === 5 && /open/i.test(toast), toast);

await key('e');
await click([25, 22.5]);
s = await st();
check('eraser lifts the line off', s.shapes.join() === 'pencil,rect,ellipse,fill', s.shapes.join());
await page.keyboard.press('Control+z');
s = await st();
check('Ctrl+Z brings the line back', s.shapes.includes('line') && s.shapes.length === 5);
await page.keyboard.press('Control+Shift+z');
s = await st();
check('Ctrl+Shift+Z erases it again', !s.shapes.includes('line') && s.shapes.length === 4);

// keys must not leak to the page behind the planner
await page.evaluate(() => { window.__leaked = []; });
await focusSheet();
for (const k of ['a', 'Enter', 'Backspace', 'ArrowLeft', 'x', ' ']) await key(k);
await page.evaluate(() => document.body.focus());
await page.evaluate(() => document.activeElement && document.activeElement.blur());
for (const k of ['q', 'Enter']) await key(k);
const leaked = await page.evaluate(() => window.__leaked.slice());
check('no keystroke reaches the page behind', leaked.length === 0, JSON.stringify(leaked));

// picture: pick a sample, move it, resize it from a corner
await key('i');
await page.click('.pl-sample[data-sample="sailboat"]');
await page.waitForTimeout(100);
s = await st();
let pic = await page.evaluate(() => { const p = planner.shapes.find(x => x.type === 'picture'); return p && { x: p.x, y: p.y, cols: p.cols }; });
check('a sample picture is placed and selected', !!pic && !!s.selected, JSON.stringify(pic));
await drag([pic.x + 10, pic.y + 5], [pic.x + 6, pic.y + 9]);
let pic2 = await page.evaluate(() => { const p = planner.shapes.find(x => x.type === 'picture'); return { x: p.x, y: p.y, cols: p.cols }; });
check('dragging moves the picture by whole cells', pic2.x === pic.x - 4 && pic2.y === pic.y + 4, JSON.stringify(pic2));
const handle = await page.evaluate(() => { const r = planner.el.frames.querySelector('.is-selected .pl-h-se').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
await page.mouse.move(handle.x, handle.y);
await page.mouse.down();
await page.mouse.move(handle.x - box.w * 10 / 85, handle.y, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(80);
const pic3 = await page.evaluate(() => { const p = planner.shapes.find(x => x.type === 'picture'); return { x: p.x, y: p.y, cols: p.cols }; });
check('pulling the corner resizes it', pic3.cols === pic2.cols - 10 && pic3.x === pic2.x, JSON.stringify(pic3));
await page.click('.pl-panel [data-v="line"]');
await page.waitForTimeout(80);
const style = await page.evaluate(() => planner.shapes.find(x => x.type === 'picture').style);
check('style buttons change the selected picture', style === 'line', style);

// a local picture file: generated in the page, handed to the hidden file input
const png = await page.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 200; c.height = 100;
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 200, 100);
  x.fillStyle = '#222'; x.beginPath(); x.arc(100, 50, 40, 0, Math.PI * 2); x.fill();
  return c.toDataURL('image/png').split(',')[1];
});
await page.evaluate(() => planner._select(null));
await page.setInputFiles('.pl-file', { name: 'dot.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
await page.waitForFunction(() => planner.shapes.filter(s => s.type === 'picture').length === 2, null, { timeout: 5000 }).catch(() => {});
const filePic = await page.evaluate(() => { const p = planner.shapes.filter(s => s.type === 'picture')[1]; return p && { src: p.src, cols: p.cols, n: planner._perShape[planner.shapes.indexOf(p)].strikes.length }; });
check('a local image file becomes a picture (kept in the browser)', filePic && /^file:/.test(filePic.src) && filePic.n > 50, JSON.stringify(filePic));
await focusSheet();
await key('Delete');
const pics = await page.evaluate(() => planner.shapes.filter(s => s.type === 'picture').length);
check('Delete removes the selected picture', pics === 1, pics);
await page.click('.pl-viewseg [data-view="ink"]');
const view = await page.evaluate(() => planner.view);
await page.click('.pl-viewseg [data-view="both"]');
check('the Pencil / Both / Ink toggle switches the view', view === 'ink');

// banner: type text into the field (must not leak), then click to place
await key('t');
await page.evaluate(() => { window.__leaked = []; });
await page.fill('.pl-text', '');
await page.click('.pl-text');
await page.keyboard.type('Hi there');
const leaked2 = await page.evaluate(() => window.__leaked.slice());
check('typing in the banner field does not leak', leaked2.length === 0, JSON.stringify(leaked2));
await click([4.5, 52.5]);
const ban = await page.evaluate(() => { const b = planner.shapes.find(x => x.type === 'banner'); return b && { text: b.text, x: b.x, y: b.y }; });
check('banner placed where clicked', ban && ban.text === 'Hi there' && ban.x === 4 && ban.y === 52, JSON.stringify(ban));

// counter text
const count = await page.evaluate(() => planner.el.count.textContent);
check('counter shows strikes and time', /\d[\d,]* strikes · about .+ of typing/.test(count), count);

if (opt('shot', null)) {
  await page.evaluate(() => planner.setTool('pencil'));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(root, 'shots', opt('shot') + '.png') });
}

// type it
const planned = await page.evaluate(() => planner.plannedStrikes.length);
await page.click('.pl-primary');
await page.waitForTimeout(100);
const committed = await page.evaluate(() => window.__committed || []);
const sorted = committed.every((t, i) => i === 0 || t.y > committed[i - 1].y || (t.y === committed[i - 1].y && t.x >= committed[i - 1].x));
const fields = committed.every(t => Object.keys(t).sort().join() === 'c,f,k,p,x,y');
check('Type it commits every planned strike in typing order', committed.length === planned && sorted && fields, `${committed.length}/${planned}`);
s = await st();
check('the planner closes and the plan is spent', !s.open && s.shapes.length === 0);
await page.evaluate(() => planner.open());
await page.waitForTimeout(150);
await page.keyboard.press('Control+z');
s = await st();
check('Ctrl+Z after typing brings the plan back', s.shapes.length > 0, s.shapes.join());
await page.keyboard.press('Escape');
s = await st();
check('Escape closes the planner', !s.open);

// touch: a one-finger stroke draws, a second finger cancels it and pinches the zoom
await page.evaluate(() => { planner.open(); planner.setTool('pencil'); });
await page.waitForTimeout(120);
const touch = await page.evaluate(async () => {
  const pg = planner.el.page, r = pg.getBoundingClientRect();
  const ev = (type, id, x, y) => pg.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 11, clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true, button: 0, buttons: 1 }));
  const n0 = planner.shapes.length;
  ev('pointerdown', 11, 60, 60); for (let i = 1; i < 10; i++) ev('pointermove', 11, 60 + i * 8, 60 + i * 3); ev('pointerup', 11, 140, 90);
  const drew = planner.shapes.length === n0 + 1;
  const z0 = planner.zoom;
  ev('pointerdown', 21, 100, 100); ev('pointerdown', 22, 140, 140);
  for (let i = 1; i <= 6; i++) { ev('pointermove', 21, 100 - i * 10, 100 - i * 10); ev('pointermove', 22, 140 + i * 10, 140 + i * 10); }
  ev('pointerup', 21, 40, 40); ev('pointerup', 22, 200, 200);
  return { drew, added: planner.shapes.length - n0, z0, z1: planner.zoom };
});
check('touch: one finger draws', touch.drew, JSON.stringify(touch));
check('touch: two fingers zoom without drawing', touch.z1 > touch.z0 * 1.5 && touch.added === 1, JSON.stringify(touch));

await browser.close();
let fails = 0;
for (const r of results) { if (!r.ok) fails++; console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.info !== '' ? '  (' + r.info + ')' : ''}`); }
if (errors.length) console.log('console errors:\n' + errors.join('\n'));
console.log(`${results.length - fails}/${results.length} checks passed`);
process.exit(fails || errors.length ? 1 : 0);
