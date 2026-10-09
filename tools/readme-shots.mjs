// README images: node tools/readme-shots.mjs [hero] [colors] [draw] [planner]   (all when no args)
// Drives the real app headless (dev server on 8875) and writes docs/*.jpg via PIL for compression.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const want = process.argv.slice(2);
const on = k => !want.length || want.includes(k);
const docs = path.join(root, 'docs'), shots = path.join(root, 'shots');
fs.mkdirSync(docs, { recursive: true });

const LETTER = 'October 9, 2026\n\nDear Margaret,\n\nThe rain has not stopped all evening, so I\nhave pulled the old machine out of the\ncupboard. There is something about the bell\nat the end of each line that makes a person\nchoose their words more carefully.';

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
async function open(w, h) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto('http://localhost:8875/index.html');
  await page.waitForFunction(() => window.PL && window.PL.machine && !document.body.classList.contains('loading'), null, { timeout: 60000 });
  await page.evaluate(() => { document.getElementById('welcome').hidden = true; PL.s.welcomed = true; });
  return page;
}
const settle = page => page.evaluate(() => new Promise(r => setTimeout(r, 900)));
const jpg = (src, dst, q = 88) => execFileSync('python', ['-c',
  'import sys; from PIL import Image; Image.open(sys.argv[1]).convert("RGB").save(sys.argv[2], quality=int(sys.argv[3]), optimize=True, progressive=True)', src, dst, String(q)]);

if (on('hero')) {
  const page = await open(1920, 1080);
  await page.evaluate(t => PL.typeText(t, { speed: 60 }), LETTER);
  await page.evaluate(() => { PL.stage.zoom = 1.12; PL.stage.dirty = true; document.body.classList.remove('typing'); });
  await settle(page);
  await page.screenshot({ path: path.join(shots, 'readme-hero.png') });
  jpg(path.join(shots, 'readme-hero.png'), path.join(docs, 'hero.jpg'), 86);
  // social card 1200 x 630 from the middle
  execFileSync('python', ['-c', 'import sys; from PIL import Image; im=Image.open(sys.argv[1]).convert("RGB"); w,h=im.size; c=im.crop((180,40,180+1560,40+819)).resize((1200,630), Image.LANCZOS); c.save(sys.argv[2], quality=86, optimize=True)',
    path.join(shots, 'readme-hero.png'), path.join(docs, 'og.jpg')]);
  console.log('hero, og');
  await page.close();
}

if (on('colors')) {
  const page = await open(960, 600);
  await page.addStyleTag({ content: '.brand,.tools,.status,.drawbar,.progress{display:none!important}' });
  await page.evaluate(t => PL.typeText(t, { speed: 80 }), 'Dear Margaret,\nThe rain has not stopped all evening.');
  const ids = ['hunter', 'oxblood', 'navy', 'cream', 'camel', 'tobacco', 'sage', 'slate', 'claret', 'ebony'];
  const files = [];
  for (const id of ids) {
    await page.evaluate(c => { PL.set('color', c); }, id);
    await settle(page);
    const f = path.join(shots, `readme-color-${id}.png`);
    await page.screenshot({ path: f });
    files.push(f);
  }
  execFileSync('python', [path.join(root, 'tools', 'readme-grid.py'), path.join(docs, 'colors.jpg'), ...files]);
  console.log('colors');
  await page.close();
}

if (on('draw')) {
  const page = await open(1600, 1000);
  await page.addStyleTag({ content: '.progress{display:none!important}' });
  await page.evaluate(async () => {
    PL.set('mode', 'draw');
    const art = await import('/js/art.js');
    const s = art.SAMPLES.find(x => x.id === 'teacup');
    const img = art.pictureImageData(s, 240, s.aspect);
    const cols = 46;
    const strikes = art.orderStrikes(art.imageToStrikes(img, { x0: Math.round((85 - cols) / 2), y0: 10, cols, style: 'shade', typeface: 'pica', ink: 'k' }));
    PL.runJob(strikes.map(st => ({ t: 'strike', ...st })), { speed: 0 });
    const last = strikes[strikes.length - 1];
    PL.car.moveTo(last.x + 1, last.y + 1);
    PL.machine.setRow(PL.car.row, 0); PL.machine.setColumn(PL.car.col, 0);
    PL.stage.zoom = 1.25; PL.stage.lookTarget = PL.stage.look = 6.5;
  });
  await settle(page);
  await page.screenshot({ path: path.join(shots, 'readme-draw.png') });
  jpg(path.join(shots, 'readme-draw.png'), path.join(docs, 'draw.jpg'), 86);
  console.log('draw');
  await page.close();
}

if (on('planner')) {
  const page = await open(1600, 1000);
  await page.evaluate(async () => { PL.set('mode', 'draw'); await PL.openPlanner(); });
  await settle(page);
  await page.screenshot({ path: path.join(shots, 'readme-planner.png') });
  jpg(path.join(shots, 'readme-planner.png'), path.join(docs, 'planner.jpg'), 86);
  console.log('planner');
  await page.close();
}

if (on('guide')) {
  const page = await open(1600, 1000);
  await page.evaluate(async () => {
    const art = await import('/js/art.js');
    const s = art.SAMPLES.find(x => x.id === 'teacup');
    const img = art.pictureImageData(s, 240, s.aspect);
    const strikes = art.orderStrikes(art.imageToStrikes(img, { x0: 25, y0: 9, cols: 34, style: 'shade', typeface: 'pica', ink: 'k' }));
    await PL.openGuide(strikes, 'Teacup');
  });
  await settle(page);
  await page.screenshot({ path: path.join(shots, 'readme-guide.png') });
  jpg(path.join(shots, 'readme-guide.png'), path.join(docs, 'guide.jpg'), 86);
  console.log('guide');
  await page.close();
}

if (on('paper') && fs.existsSync(path.join(shots, 'ink-compare-zoom.png'))) {
  jpg(path.join(shots, 'ink-compare-zoom.png'), path.join(docs, 'paper.jpg'), 88);
  console.log('paper');
}
await browser.close();
