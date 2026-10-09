// Render the intro film.
//   node tools/film.mjs                    every frame -> docs/platen-intro.mp4 (+ poster, + README gif)
//   node tools/film.mjs --frames 30,150,400  step through the timeline, save only these frames to shots/
// The page is index.html?film: js/film.js puts the app on a virtual clock and exposes FILM.renderAt(t).
// Frames are stepped in order (the typing is stateful), screenshotted by Playwright Chromium at
// 1920 x 1080, the recorded sound events are rendered offline to shots/film.wav, and ffmpeg muxes both.
// Needs the dev server on port 8875.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const audioOnly = args.includes('--audio-only');      // step the timeline without screenshots, render the WAV
const only = opt('frames', null) ? opt('frames').split(',').map(Number) : null;
const frameDir = path.join(root, 'shots', 'film_frames');
const W = 1920, H = 1080;

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
await page.goto(`http://localhost:${opt('port', 8875)}/index.html?film`);
await page.waitForFunction(() => window.FILM, null, { timeout: 90000, polling: 200 });
const info = await page.evaluate(() => ({ fps: FILM.fps, duration: FILM.duration, art: FILM.artStrikes }));
console.log(JSON.stringify(info));
const N = Math.round(info.duration * info.fps);
const last = only ? Math.max(...only) : N - 1;
if (!only && !audioOnly) { fs.rmSync(frameDir, { recursive: true, force: true }); fs.mkdirSync(frameDir, { recursive: true }); }
const t0 = Date.now();
for (let i = 0; i <= last; i++) {
  const want = audioOnly ? false : only ? only.includes(i) : true;
  const st = await page.evaluate(t => FILM.renderAt(t), i / info.fps);
  if (!want) continue;
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const out = only ? path.join(root, 'shots', `film_f${String(i).padStart(4, '0')}.png`) : path.join(frameDir, `f_${String(i).padStart(4, '0')}.png`);
  await page.screenshot({ path: out });
  if (only) console.log(path.relative(root, out), JSON.stringify(st));
  else if (i % 60 === 0) console.log(`frame ${i}/${N} (${((Date.now() - t0) / 1000).toFixed(0)} s) strikes=${st.strikes}`);
}
if (only) { await browser.close(); if (errors.length) console.log(errors.slice(0, 10).join('\n')); process.exit(0); }

const snd = await page.evaluate(() => FILM.soundtrack());
console.log('soundtrack', JSON.stringify(snd));
await browser.close();
if (audioOnly) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(root, 'shots', 'film.wav'), '-b:a', '192k', path.join(root, 'shots', 'film-audio.mp3')]);
  console.log('shots/film.wav, shots/film-audio.mp3');
  process.exit(0);
}
if (errors.length) console.log('console errors:\n' + errors.slice(0, 10).join('\n'));

const docs = path.join(root, 'docs');
fs.mkdirSync(docs, { recursive: true });
const mp4 = path.join(docs, 'platen-intro.mp4');
const wav = path.join(root, 'shots', 'film.wav');
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a], { stdio: 'inherit' });
ff('-framerate', String(info.fps), '-i', path.join(frameDir, 'f_%04d.png'), ...(snd.ok ? ['-i', wav] : []),
  '-c:v', 'libx264', '-preset', 'slow', '-crf', opt('crf', '20'), '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  ...(snd.ok ? ['-af', 'loudnorm=I=-19:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', '-shortest'] : ['-an']), mp4);
// poster: the finished drawing just before the end card
ff('-i', path.join(frameDir, `f_${String(Math.round(29.4 * info.fps)).padStart(4, '0')}.png`), '-q:v', '3', path.join(docs, 'intro-poster.jpg'));
console.log(`${path.relative(root, mp4)} ${(fs.statSync(mp4).size / 1e6).toFixed(2)} MB in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
