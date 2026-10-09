// Times the pure-JS synthesis in js/audio.js under Node (no Web Audio needed).
//   node tools/audio-bench.mjs [rain fire clock night bank]
// Copies js/audio.js + js/util.js to a temp folder, exposes the internal generators, and times them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platen-audio-'));
fs.copyFileSync(path.join(root, 'js/util.js'), path.join(tmp, 'util.js'));
const src = fs.readFileSync(path.join(root, 'js/audio.js'), 'utf8') +
  '\nexport const __dev = { ambienceData, AMB_GEN, buildBank, PROF, makeMachine, strike };\n';
fs.writeFileSync(path.join(tmp, 'audio.mjs'), src);
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
globalThis.AudioBuffer = class {           // just enough for buildBank
  constructor({ length, numberOfChannels = 1, sampleRate }) { this.length = length; this.sampleRate = sampleRate; this.ch = Array.from({ length: numberOfChannels }, () => new Float32Array(length)); }
  copyToChannel(a, i) { this.ch[i].set(a); }
  getChannelData(i) { return this.ch[i]; }
};
const { __dev } = await import(pathToFileURL(path.join(tmp, 'audio.mjs')).href);
const want = process.argv.slice(2);
const jobs = want.length ? want : ['bank', 'rain', 'fire', 'clock', 'night'];
for (const j of jobs) {
  const t0 = performance.now();
  let extra = '';
  if (j === 'bank') {
    const banks = [await __dev.buildBank(48000, 'portable'), await __dev.buildBank(48000, 'desk')];
    const bytes = b => Object.values(b).flat(2).filter(x => x instanceof AudioBuffer).reduce((s, x) => s + x.length * x.ch.length * 4, 0);
    extra = banks.map(b => `${b.id} ${(bytes(b) / 1048576).toFixed(2)} MB`).join(', ');
  } else await __dev.ambienceData(j, 48000);
  console.log(j.padEnd(6), (performance.now() - t0).toFixed(0), 'ms', extra);
}
fs.rmSync(tmp, { recursive: true, force: true });
