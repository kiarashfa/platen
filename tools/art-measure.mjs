// Measures the typewriter-art density ramps with the real ink renderer and bakes them into
// js/art.js (the FALLBACK table between the @@FALLBACK markers, used under Node and before the
// browser has measured).
//   node tools/art-measure.mjs [--port 8875] [--dry]
// Needs the dev server running (node dev-server.js).
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const port = +(args[args.indexOf('--port') + 1] || 8875) || 8875;

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
await page.goto(`http://localhost:${port}/dev/planner.html?measure=1`);
await page.waitForFunction(() => window.__done, null, { timeout: 180000, polling: 250 });
const done = await page.evaluate(() => window.__done);
await browser.close();
if (!done.ok) { console.error('measure failed', done.error, errors); process.exit(1); }
if (done.standIn) { console.error('ink.js did not load; refusing to bake stand-in numbers'); process.exit(1); }
if (errors.length) console.log('console:\n' + errors.join('\n'));

const r5 = v => +(+v).toFixed(5);
const lines = ['const FALLBACK = {'];
for (const [tf, d] of Object.entries(done.out)) {
  const ramp = d.ramp.map(([g, v]) => `[${JSON.stringify(g)}, ${r5(v)}]`).join(', ');
  const singles = Object.entries(d.singles).map(([c, v]) => `${JSON.stringify(c)}: ${r5(v)}`).join(', ');
  lines.push(`  ${tf}: {`);
  lines.push(`    ramp: [${ramp}],`);
  lines.push(`    top: ${r5(d.top)},`);
  lines.push(`    singles: { ${singles} },`);
  lines.push('  },');
  console.log(tf.padEnd(7), d.ramp.map(([g]) => g.join('') || '_').join('  '));
}
lines.push('};');
const file = path.join(root, 'js', 'art.js');
const src = fs.readFileSync(file, 'utf8');
const a = src.indexOf('// @@FALLBACK-BEGIN'), b = src.indexOf('// @@FALLBACK-END');
if (a < 0 || b < 0) { console.error('markers not found in js/art.js'); process.exit(1); }
const next = src.slice(0, a) + '// @@FALLBACK-BEGIN\n' + lines.join('\n') + '\n' + src.slice(b);
if (args.includes('--dry')) console.log(lines.join('\n'));
else { fs.writeFileSync(file, next); console.log('updated js/art.js FALLBACK table'); }
