// End-to-end check of the typewriter Guide (Playwright Chromium).
//   node tools/art-guide-check.mjs [--port 8875]
// Progress by keyboard and taps, persistence across a reload, no key leaks, the .txt download,
// the print layout (writes shots/guide-print.pdf and shots/guide-print.png), and opening the
// guide from the Planner's "Make a guide".
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const port = +(args[args.indexOf('--port') + 1] || 8875) || 8875;
const base = `http://localhost:${port}`;

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('[error] ' + m.text()); });
const results = [];
const check = (name, ok, info = '') => results.push({ name, ok: !!ok, info });
const ready = () => page.waitForFunction(() => window.__done, null, { timeout: 60000 });
const st = () => page.evaluate(() => ({ open: guide.isOpen, done: guide.done.size, current: guide.current, lines: guide.guide.lines.length }));

await page.goto(`${base}/dev/guide.html?art=teacup&half=0`);
await ready();
let s = await st();
check('the guide opens with lines to type', s.open && s.lines > 10, JSON.stringify(s));
await page.evaluate(() => guide.sheet.focus());
for (const k of [' ', ' ', ' ', 'ArrowDown', 'ArrowUp', 'Enter']) await page.keyboard.press(k);
s = await st();
check('Space / Down / Enter advance, Up goes back', s.done === 4 && s.current === 4, JSON.stringify(s));
const now = await page.evaluate(() => document.querySelector('.gd-line.is-now').dataset.i);
check('the current line is highlighted', now === '4', now);
await page.click('.gd-line[data-i="9"]');
s = await st();
check('tapping a line marks it', s.done === 5 && s.current === 4, JSON.stringify(s));
await page.click('.gd-line[data-i="9"]');
const leaked = await page.evaluate(() => window.__leaked.slice());
check('no keystroke leaks out of the guide', leaked.length === 0, JSON.stringify(leaked));
await page.goto(`${base}/dev/guide.html?art=teacup&half=0&reset=0`);
await ready();
s = await st();
check('progress is remembered across a reload', s.done === 4 && s.current === 4, JSON.stringify(s));

// .txt download
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.gd-headtools .gd-btn:nth-child(2)')]);
const txtPath = path.join(root, 'shots', 'guide-teacup.txt');
await dl.saveAs(txtPath);
const txt = fs.readFileSync(txtPath, 'utf8');
check('Download .txt gives the whole guide', /SETUP/.test(txt) && /READING THE STEPS/.test(txt) && (txt.match(/\[ \] Line /g) || []).length === s.lines, `${dl.suggestedFilename()} ${txt.length} chars`);

// print layout: the real print path through Chromium's PDF renderer
await page.evaluate(() => guide._preparePrint());
const printLines = await page.evaluate(() => document.querySelectorAll('.gd-printout .gd-p-lines li').length);
await page.emulateMedia({ media: 'print' });
await page.screenshot({ path: path.join(root, 'shots', 'guide-print.png'), fullPage: true });
await page.pdf({ path: path.join(root, 'shots', 'guide-print.pdf'), format: 'Letter', printBackground: true });
await page.emulateMedia({ media: 'screen' });
const pdfSize = fs.statSync(path.join(root, 'shots', 'guide-print.pdf')).size;
check('print view lists every line and makes a PDF', printLines === s.lines && pdfSize > 20000, `${printLines} lines, ${Math.round(pdfSize / 1024)} KB`);
await page.evaluate(() => guide._cleanupPrint());
await page.keyboard.press('Escape');
s = await st();
check('Escape closes the guide', !s.open);

// from the Planner
await page.goto(`${base}/dev/planner.html?shot=picture`);
await ready();
await page.evaluate(() => { window.__leaked = []; });
await page.click('.pl-guidebtn');
await page.waitForTimeout(400);
const fromPlanner = await page.evaluate(() => ({ open: planner.guide && planner.guide.isOpen, title: planner.guide && planner.guide.guide.title, strikes: planner.guide && planner.guide.guide.summary.strikes, planned: planner.plannedStrikes.length, tool: planner.tool }));
check('"Make a guide" opens the guide for the planned strikes', fromPlanner.open && fromPlanner.title === 'Teacup' && fromPlanner.strikes === fromPlanner.planned, JSON.stringify(fromPlanner));
for (const k of ['p', 'e', ' ', 'ArrowDown']) await page.keyboard.press(k);
const after = await page.evaluate(() => ({ tool: planner.tool, done: planner.guide.done.size, leaked: window.__leaked.slice() }));
check('keys go to the guide, not to the planner or the page', after.tool === 'picture' && after.done === 2 && after.leaked.length === 0, JSON.stringify(after));
await page.keyboard.press('Escape');
const both = await page.evaluate(() => ({ guide: planner.guide.isOpen, planner: planner.isOpen }));
check('Escape closes the guide and leaves the planner open', !both.guide && both.planner, JSON.stringify(both));

await browser.close();
let fails = 0;
for (const r of results) { if (!r.ok) fails++; console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.info !== '' ? '  (' + r.info + ')' : ''}`); }
if (errors.length) console.log('console errors:\n' + errors.join('\n'));
console.log(`${results.length - fails}/${results.length} checks passed`);
process.exit(fails || errors.length ? 1 : 0);
