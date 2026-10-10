// Phone input check (emulated touch phone, 390 x 844, dev server on 8875):
//   node tools/mobile-check.mjs
// Taps 3D keys with real touch events, types through the hidden textarea the way Android (Unidentified
// keydown + input) and iOS (keydown/keyup with an empty code) deliver it, and reports whether every key
// came back up and whether taps on the machine steal or keep the system keyboard's focus.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium, devices } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(`${process.env.BASE || "http://localhost:" + (process.env.PORT || 8875)}/index.html`);
await page.waitForFunction(() => window.PL && PL.machine && !document.body.classList.contains('loading'), null, { timeout: 60000 });
await page.evaluate(() => { document.getElementById('welcome').hidden = true; PL.s.welcomed = true; });
await page.waitForTimeout(500);

// screen position of a 3D key's cap
const keyXY = id => page.evaluate(k => {
  const key = PL.machine.keys.get(k);
  const v = key.obj.getWorldPosition(new PL.THREE.Vector3());
  v.y += 0.2;
  v.project(PL.stage.camera);
  const r = PL.stage.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
}, id);
const stuck = () => page.evaluate(() => [...PL.machine.keys].filter(([, k]) => k.held || k.press > 0.01).map(([id]) => id));
const focused = () => page.evaluate(() => document.activeElement === PL.input);
const typed = () => page.evaluate(() => PL.page.strikes.map(s => s.c).join(''));
const report = {};

// 1. tap three 3D keys
for (const id of ['f', 'j', 'g']) {
  const p = await keyXY(id);
  await page.touchscreen.tap(p.x, p.y);
  await page.waitForTimeout(250);
}
await page.waitForTimeout(400);
report.tapTyped = await typed();
report.tapStuck = await stuck();
report.tapFocusedKeyboard = await focused();

// 2. open the system keyboard with the button, then tap a 3D key: the keyboard should stay
await page.tap('#kbdBtn');
await page.waitForTimeout(200);
report.kbdOpened = await focused();
const p = await keyXY('k');
await page.touchscreen.tap(p.x, p.y);
await page.waitForTimeout(400);
report.kbdStillOpenAfterKeyTap = await focused();

// 3. Android-style virtual keyboard: keydown 'Unidentified', then input events
await page.evaluate(() => {
  const ta = PL.input;
  for (const ch of 'abc') {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', code: '', bubbles: true, cancelable: true }));
    ta.value = ch;
    ta.dispatchEvent(new InputEvent('input', { data: ch, inputType: 'insertText', bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'Unidentified', code: '', bubbles: true }));
  }
});
await page.waitForTimeout(500);
// 4. iOS-style: real keys but an empty code on every event
await page.evaluate(() => {
  for (const ch of 'xyz') {
    PL.input.dispatchEvent(new KeyboardEvent('keydown', { key: ch, code: '', bubbles: true, cancelable: true }));
  }
  for (const ch of 'xyz') PL.input.dispatchEvent(new KeyboardEvent('keyup', { key: ch, code: '', bubbles: true }));
});
await page.waitForTimeout(500);
report.typedAll = await typed();
report.stuckAfterKeyboards = await stuck();
report.errors = errors;
console.log(JSON.stringify(report, null, 1));
await browser.close();
