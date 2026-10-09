// Headless page driver (Playwright Chromium, real GPU through ANGLE/D3D11).
//   node tools/shoot.mjs "/dev/ink.html" [--name ink] [--w 1400] [--h 900] [--dpr 1]
//        [--eval "js expression run after load, may return a promise"] [--wait 0 (ms after __done)]
//        [--timeout 120000] [--port 8875] [--noshot]
// Loads the page from the dev server, waits for window.__done (truthy) when the page sets it
// (pages that never set it get 4 s), runs --eval if given, prints __done + console errors,
// then writes shots/<name>.png. Use ';' instead of '&' between query params on the command line.
// Git Bash rewrites a leading-slash argument into "C:/Program Files/Git/dev/..."; that prefix is undone.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const PW = process.env.PLAYWRIGHT_CORE || 'playwright-core';   // npm i -D playwright-core, or point at a copy
const { chromium } = require(PW);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const unmsys = a => a.replace(/^[A-Za-z]:[\\/].*?[\\/]Git[\\/](?=[a-z])/i, '/');
const urlPath = (args.map(unmsys).find(a => a.startsWith('/')) || '/index.html').replace(/;/g, '&');
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const flag = k => args.includes('--' + k);
const name = opt('name', path.basename(urlPath.split('?')[0], '.html') || 'shot');
const timeout = +opt('timeout', 120000);
const port = +opt('port', 8875);

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: +opt('w', 1400), height: +opt('h', 900) }, deviceScaleFactor: +opt('dpr', 1) });
const errors = [];
page.on('console', m => {
  const t = m.type();
  if (t === 'error' || t === 'warning') errors.push(`[${t}] ${m.text()}`);
  else if (flag('log')) console.log(`[${t}] ${m.text()}`);
});
page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
const t0 = Date.now();
await page.goto(`http://localhost:${port}${urlPath}`);
let done = null;
try {
  await page.waitForFunction(() => window.__done, null, { timeout: Math.min(timeout, 4000), polling: 100 });
  done = await page.evaluate(() => window.__done);
} catch {
  // pages that never set __done: wait a little longer only if they declared __pending
  const pending = await page.evaluate(() => !!window.__pending);
  if (pending) {
    try {
      await page.waitForFunction(() => window.__done, null, { timeout, polling: 250 });
      done = await page.evaluate(() => window.__done);
    } catch (e) { done = { ok: false, error: 'timeout: ' + e.message }; }
  }
}
const ev = opt('eval', null);
let evResult;
if (ev) {
  try { evResult = await page.evaluate(src => Promise.resolve((0, eval)(src)), ev); }
  catch (e) { evResult = { error: String(e.message || e) }; }
}
const wait = +opt('wait', 0);
if (wait) await page.waitForTimeout(wait);
if (!flag('noshot')) {
  fs.mkdirSync(path.join(root, 'shots'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'shots', name + '.png') });
}
console.log(JSON.stringify({ path: urlPath, secs: (Date.now() - t0) / 1000, done, eval: evResult, shot: flag('noshot') ? null : `shots/${name}.png` }, null, 1));
if (errors.length) console.log('console:\n' + errors.slice(0, 40).join('\n'));
await browser.close();
