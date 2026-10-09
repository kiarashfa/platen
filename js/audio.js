// Platen: procedural typewriter sound engine.
//
// Everything is synthesised here, no samples and no network. Each mechanical sound is an
// impact model: short excitations (half-sine contact pulses plus tiny noise bursts) drive banks
// of decaying modes (two-pole resonators) that stand for the typebar, the slug on the rubber
// platen, the frame, the escapement and so on, plus filtered-noise layers for friction and paper.
// The machine's mode tables are fixed per profile (it is one machine), every strike varies the
// excitation and the coupling, so repeats never sound identical but always sound like the same
// typewriter. Buffers are built once (several variants each); events are layered at play time.
// Design notes and measured levels: dev/AUDIO_NOTES.md.
import { hash32, rng, gauss, clamp, smoothstep } from './util.js';

export const AMBIENCES = [
  { id: 'rain', name: 'Rain on the window' }, { id: 'fire', name: 'Fireplace' },
  { id: 'clock', name: 'Mantel clock' }, { id: 'night', name: 'Summer night' },
];
export const PROFILES = [{ id: 'portable', name: 'Portable' }, { id: 'desk', name: 'Desk machine' }];

const TAU = Math.PI * 2;
const dB = v => Math.pow(10, v / 20);
const gn = r => gauss(r) * 2;                          // roughly N(0, 1)
const logr = (r, a, b) => a * Math.pow(b / a, r());    // log-uniform in [a, b)
const jit = (r, k) => 1 + (r() * 2 - 1) * k;           // uniform factor in [1-k, 1+k]
const idle = () => new Promise(res => setTimeout(res, 0));
const now = () => (globalThis.performance ? performance.now() : Date.now());
const fader = v => { v = clamp(+v || 0, 0, 1); return v * v; };   // all mix faders: gain = v^2

// ------------------------------------------------------------------------------------------
// DSP primitives (plain JS on typed arrays)

// RBJ biquad, in place over [from, to). type: lp hp bp peak ls hs
function biquad(x, sr, type, f, q = 0.7071, gainDb = 0, from = 0, to = x.length) {
  f = Math.min(Math.max(f, 5), sr * 0.45);
  const w = TAU * f / sr, cw = Math.cos(w), sw = Math.sin(w), al = sw / (2 * q);
  const A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
  else if (type === 'hp') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
  else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
  else if (type === 'peak') { b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; }
  else {
    const s = 2 * Math.sqrt(A) * al;
    if (type === 'ls') {
      b0 = A * ((A + 1) - (A - 1) * cw + s); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - s);
      a0 = (A + 1) + (A - 1) * cw + s; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - s;
    } else {
      b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - s);
      a0 = (A + 1) - (A - 1) * cw + s; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s;
    }
  }
  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = from; i < to; i++) {
    const xi = x[i];
    let y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    if (y < 1e-30 && y > -1e-30) y = 0;           // no denormals in long silent stretches
    x2 = x1; x1 = xi; y2 = y1; y1 = y;
    x[i] = y;
  }
  return x;
}

// Excitation: a list of hits { t, w (contact width s), a (force), nz (noise burst, relative), nt (its decay s) }.
// A half-sine contact pulse whose area is a * 0.1 ms whatever its width (wider = softer = duller).
function exc(n, sr, hits, r) {
  const x = new Float64Array(n);
  let s0 = n, s1 = 0;
  for (const h of hits) {
    if (!(h.a > 0)) continue;
    const i0 = Math.max(0, Math.round(h.t * sr));
    if (i0 >= n) continue;
    const m = Math.max(1, h.w * sr), mi = Math.ceil(m);
    let sum = 0;
    const tmp = new Float64Array(mi);
    for (let k = 0; k < mi; k++) { tmp[k] = Math.sin(Math.PI * Math.min(1, (k + 0.5) / m)); sum += tmp[k]; }
    const s = h.a * 1e-4 * sr / sum;
    for (let k = 0; k < mi && i0 + k < n; k++) x[i0 + k] += tmp[k] * s;
    let end = i0 + mi;
    if (h.nz) {
      const tau = Math.max(1, (h.nt || 0.0003) * sr), len = Math.ceil(tau * 7), amp = h.nz * s;
      for (let k = 0; k < len && i0 + k < n; k++) x[i0 + k] += amp * (r() * 2 - 1) * Math.exp(-k / tau);
      end = Math.max(end, i0 + len);
    }
    s0 = Math.min(s0, i0); s1 = Math.max(s1, Math.min(n, end));
  }
  if (s1 <= s0) { s0 = 0; s1 = 0; }
  return { x, s0, s1 };
}

// One decaying mode (two-pole resonator) driven by excitation E, added into out.
// Unit impulse -> amplitude `amp`; t60 = time to fall 60 dB.
function mode(out, E, sr, f, t60, amp) {
  if (!(f > 15) || f > sr * 0.46 || !amp || !(t60 > 0)) return;
  const w = TAU * f / sr, rr = Math.exp(-6.9078 / (t60 * sr));
  const a1 = 2 * rr * Math.cos(w), a2 = rr * rr, g = amp * Math.sin(w);
  const x = E.x, s1 = E.s1, end = Math.min(out.length, s1 + Math.ceil(t60 * 1.2 * sr));
  let y1 = 0, y2 = 0;
  for (let i = E.s0; i < end; i++) {
    let y = (i < s1 ? g * x[i] : 0) + a1 * y1 - a2 * y2;
    if (y < 1e-30 && y > -1e-30) y = 0;           // sparse excitations: keep out of denormals
    y2 = y1; y1 = y;
    out[i] += y;
  }
}

// A fixed mode table [[f, t60, amp], ...] with per-strike jitter (coupling varies, the parts do not).
function modes(out, E, sr, table, r, aj = 0.5, fj = 0.004, dj = 0.15, fk = 1, dk = 1, ak = 1) {
  for (const [f, d, a] of table) mode(out, E, sr, f * fk * (1 + gn(r) * fj), d * dk * jit(r, dj), a * ak * jit(r, aj));
}

// The impact itself, heard directly: the excitation high-passed.
function addHp(out, E, sr, fc, gain) {
  if (!gain || E.s1 <= E.s0) return;
  const pad = Math.ceil(0.004 * sr), s0 = E.s0, s1 = Math.min(out.length, E.s1 + pad);
  const tmp = E.x.slice(s0, s1);
  biquad(tmp, sr, 'hp', fc, 0.7071); biquad(tmp, sr, 'hp', fc, 0.7071);
  for (let i = 0; i < tmp.length; i++) out[s0 + i] += tmp[i] * gain;
}

// A band-limited noise burst: attack (s), exponential decay tau (s), band [lo, hi] Hz.
function noiseBurst(out, sr, r, t, attack, tau, lo, hi, amp) {
  const i0 = Math.round(t * sr), na = Math.max(1, attack * sr), nt = tau * sr;
  const len = Math.min(out.length - i0, Math.ceil(na + nt * 7));
  if (len <= 0) return;
  const tmp = new Float64Array(len);
  for (let k = 0; k < len; k++) tmp[k] = r() * 2 - 1;
  if (lo > 20) { biquad(tmp, sr, 'hp', lo); biquad(tmp, sr, 'hp', lo); }
  if (hi < sr * 0.45) { biquad(tmp, sr, 'lp', hi); biquad(tmp, sr, 'lp', hi); }
  for (let k = 0; k < len; k++) {
    const e = k < na ? Math.sin(0.5 * Math.PI * k / na) ** 2 : Math.exp(-(k - na) / nt);
    out[i0 + k] += tmp[k] * e * amp;
  }
}

// Trim the silent tail (below floor dB re peak) and fade the end; returns Float32Array.
function trimFade(out, sr, floor = -68) {
  let pk = 0;
  for (let i = 0; i < out.length; i++) { const a = Math.abs(out[i]); if (a > pk) pk = a; }
  const th = pk * dB(floor);
  let last = out.length - 1;
  while (last > 0 && Math.abs(out[last]) < th) last--;
  const n = Math.min(out.length, last + Math.ceil(0.002 * sr));
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = out[i];
  const nf = Math.min(Math.ceil(0.006 * sr), n >> 2);
  for (let k = 0; k < nf; k++) f[n - 1 - k] *= 0.5 - 0.5 * Math.cos(Math.PI * k / nf);
  f[0] = 0;
  return f;
}

function peakOf(a) { let p = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > p) p = v; } return p; }

// Scale a group of variants so the median peak is 1 (natural loudness differences survive).
// With byEnergy, each variant is first levelled by its loudest 4 ms (RMS), so a lucky noise
// spike cannot make one strike sound much louder than the next.
function normGroup(list, byEnergy = false, sr = 48000) {
  if (byEnergy) {
    const w = Math.max(8, Math.round(0.004 * sr));
    for (const a of list) {
      let s = 0, best = 0;
      for (let i = 0; i < a.length; i++) { s += a[i] * a[i]; if (i >= w) s -= a[i - w] * a[i - w]; if (s > best) best = s; }
      const k = 1 / Math.sqrt(best / w || 1);
      for (let i = 0; i < a.length; i++) a[i] *= k;
    }
  }
  const pk = list.map(peakOf).sort((a, b) => a - b), k = 1 / (pk[pk.length >> 1] || 1);
  for (const a of list) for (let i = 0; i < a.length; i++) a[i] *= k;
  return list;
}

function toBuffer(chans, sr) {
  const ch = Array.isArray(chans) ? chans : [chans];
  const b = new AudioBuffer({ length: Math.max(1, ch[0].length), numberOfChannels: ch.length, sampleRate: sr });
  ch.forEach((c, i) => b.copyToChannel(c instanceof Float32Array ? c : Float32Array.from(c), i));
  return b;
}

// White / pink / brown noise (Float32, for long ambience beds).
function whiteN(n, r) { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = r() * 2 - 1; return a; }
function pinkN(n, r) {
  const a = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    a[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return a;
}
function brownN(n, r) {
  const a = new Float32Array(n);
  let b = 0;
  for (let i = 0; i < n; i++) { b = (b + 0.02 * (r() * 2 - 1)) / 1.02; a[i] = b * 3.5; }
  return a;
}

// Control-rate signal: fn(t) evaluated every 64 samples, linearly interpolated.
function ctrl(n, sr, fn) {
  const a = new Float32Array(n), step = 64;
  let prev = fn(0);
  for (let i = 0; i < n; i += step) {
    const nx = fn((i + step) / sr), m = Math.min(step, n - i);
    for (let k = 0; k < m; k++) a[i + k] = prev + (nx - prev) * k / step;
    prev = nx;
  }
  return a;
}
// Smooth random wander in about [-1, 1]: cosine-interpolated random points `rate` per second.
function wander(r, rate) {
  const pts = [];
  return t => {
    const u = t * rate, i = Math.floor(u);
    while (pts.length <= i + 1) pts.push(r() * 2 - 1);
    const f = 0.5 - 0.5 * Math.cos(Math.PI * (u - i));
    return pts[i] + (pts[i + 1] - pts[i]) * f;
  };
}
function sines(r, specs) {   // [[freq, depth], ...] with random phase and slight detune
  const s = specs.map(([f, d]) => [TAU * f * jit(r, 0.15), d, r() * TAU]);
  return t => { let v = 0; for (const [w, d, p] of s) v += d * Math.sin(w * t + p); return v; };
}

// Seamless loop helpers: beds are rendered n + X long and the overhang is crossfaded into the
// start (equal power); events are written modulo n so their tails wrap around.
function foldBed(a, n, X) {
  const out = new Float32Array(n);
  out.set(a.subarray(0, n));
  for (let i = 0; i < X; i++) {
    const c = (i + 0.5) / X;
    out[i] = a[i] * Math.sin(c * Math.PI / 2) + a[n + i] * Math.cos(c * Math.PI / 2);
  }
  return out;
}
function wrapAdd(dst, i0, src, g) {
  const n = dst.length;
  i0 = ((i0 % n) + n) % n;
  for (let k = 0; k < src.length; k++) { const j = i0 + k; dst[j < n ? j : j % n] += src[k] * g; }
}
// Impulse response of a small mode bank (+ direct click) for sparse events: each event then
// costs one short add instead of filtering the whole loop. exc0 = the excitation samples.
function bankIR(sr, table, hpFc, hpGain, exc0 = [1]) {
  const len = Math.ceil(Math.max(...table.map(m => m[1])) * 1.2 * sr) + 96;
  const out = new Float64Array(len), E = { x: new Float64Array(len), s0: 0, s1: exc0.length };
  exc0.forEach((v, i) => { E.x[i] = v; });
  for (const [f, d, a] of table) mode(out, E, sr, f, d, a);
  if (hpGain) addHp(out, E, sr, hpFc, hpGain);
  return out;
}
const panGains = p => [Math.cos((clamp(p, -1, 1) + 1) * Math.PI / 4), Math.sin((clamp(p, -1, 1) + 1) * Math.PI / 4)];

// ------------------------------------------------------------------------------------------
// Profiles and the machine's fixed parts

const PROF = {
  portable: {   // a 1950s portable: lighter, brighter, a little tinny, less body
    pitch: 1.0, decay: 0.85, bar: 540, tin: 1.0, click: 1.0, thud: 270, thudA: 0.55,
    body: [[205, 0.05, 0.14], [330, 0.035, 0.12]], heavy: 0.6, bell: 2420, bellDecay: 1.0,
    stop: 128, space: 300, lever: 520, shiftLow: [112, 168, 240],
  },
  desk: {       // a heavy office machine: deeper thunk, longer ring, more cast-iron body
    pitch: 0.87, decay: 1.25, bar: 470, tin: 0.25, click: 0.85, thud: 195, thudA: 0.75,
    body: [[118, 0.09, 0.26], [168, 0.07, 0.24], [245, 0.05, 0.16]], heavy: 1.0, bell: 1980, bellDecay: 1.3,
    stop: 92, space: 245, lever: 430, shiftLow: [86, 128, 196],
  },
};

function makeMachine(P, seed) {
  const r = rng(seed);
  const set = (k, lo, hi, d0, d1, a0, a1, fk = P.pitch, dk = P.decay) =>
    Array.from({ length: k }, () => [logr(r, lo, hi) * fk, (d0 + r() * (d1 - d0)) * dk, a0 + r() * (a1 - a0)]);
  const beam = (f0, d, a) => [[f0, d, a], [f0 * 2.756, d * 0.8, a * 0.8], [f0 * 5.404, d * 0.6, a * 0.55], [f0 * 8.933, d * 0.45, a * 0.3]];
  const f1 = P.bell, bd = P.bellDecay;
  return {
    frame: set(14, 600, 5000, 0.02, 0.08, 0.04, 0.17).map(([f, d, a]) => [f, d * Math.pow(1200 / f, 0.45), a]),  // highs die first
    zoneFrame: [0, 1, 2, 3].map(() => Array.from({ length: 14 }, () => 0.45 + r() * 1.1)),
    clack: [0, 1, 2, 3].map(z => set(8, 1400, 6500, 0.006, 0.02, 0.35, 1.0, P.pitch * (1 - 0.035 * z), 1)),
    shimmer: set(12, 5000, 11500, 0.0018, 0.006, 0.15, 0.45, Math.sqrt(P.pitch), 1),   // slug + type guide: dense, very short
    bars: [0, 1, 2, 3].map(z => P.bar * (1 - 0.035 * z) * (1 + gn(r) * 0.01)),
    tin: set(3, 420, 1500, 0.035, 0.075, 0.06, 0.18),
    esc: set(7, 1800, 5600, 0.006, 0.03, 0.14, 0.5, Math.sqrt(P.pitch)),
    ting: [[logr(r, 2600, 3400) * Math.sqrt(P.pitch), 0.06 * P.decay, 0.12]],
    escLow: set(2, 700, 1400, 0.012, 0.025, 0.1, 0.18),
    glass: set(4, 2200, 6500, 0.003, 0.009, 0.25, 0.75, 1, 1),
    keyLever: set(2, 650, 1500, 0.008, 0.018, 0.12, 0.25, P.pitch, 1),
    keyStop: set(6, 500, 2800, 0.006, 0.02, 0.15, 0.45, P.pitch, 1),
    ratchet: set(5, 2000, 7000, 0.005, 0.018, 0.2, 0.6, 1, 1),
    platen: set(2, 900, 1600, 0.02, 0.03, 0.1, 0.2),
    basket: set(6, 1500, 6000, 0.008, 0.025, 0.2, 0.6),
    shiftMid: set(3, 320, 700, 0.025, 0.04, 0.2, 0.35),
    rack: set(3, 2100, 5000, 0.003, 0.007, 0.4, 0.8, P.pitch, 1),
    lever: beam(P.lever * (1 + gn(r) * 0.02), 0.05 * P.decay, 0.4),
    backLever: beam(P.lever * 1.18 * (1 + gn(r) * 0.02), 0.035 * P.decay, 0.35),
    spaceBar: beam(P.space * (1 + gn(r) * 0.02), 0.045 * P.decay, 0.5),
    stopClack: set(5, 500, 2500, 0.01, 0.03, 0.2, 0.5),
    stopRing: set(3, 1100, 3400, 0.08, 0.16, 0.03, 0.07),
    bail: set(4, 900, 3500, 0.015, 0.045, 0.2, 0.5),
    trip: set(3, 3000, 6000, 0.003, 0.005, 0.2, 0.4, 1, 1),
    bell: [[f1, 1.5 * bd, 1.0], [f1 * 1.0021, 1.35 * bd, 0.55], [f1 * 2.29, 0.95 * bd, 0.5], [f1 * 2.2935, 0.85 * bd, 0.28],
      [f1 * 4.07, 0.5 * bd, 0.3], [f1 * 4.076, 0.45 * bd, 0.14], [f1 * 6.55, 0.3 * bd, 0.14], [f1 * 9.2, 0.18 * bd, 0.06]],
  };
}

// ------------------------------------------------------------------------------------------
// Sound builders. Each returns a Float32Array (mono). r = rng, P = profile, M = machine parts.

function strike(sr, r, P, M, z) {
  const n = Math.round(0.26 * sr), t0 = 0.004;
  const D = P.decay * (1 + 0.08 * z);
  const force = 1 + gn(r) * 0.08, tc = 0.00009 + r() * 0.00007, bdt = 0.0028 + r() * 0.0032;
  const hits = [
    { t: t0 - 0.0009 - r() * 0.001, w: 0.00005, a: 0.05 + r() * 0.06, nz: 0.6, nt: 0.00015 },  // through the type guide
    { t: t0, w: tc, a: force, nz: 1.1, nt: 0.00035 },                                             // slug hits ribbon + platen
    { t: t0 + bdt, w: tc * 1.5, a: force * (0.12 + r() * 0.16), nz: 0.5, nt: 0.0002 },            // rebound
  ];
  for (let k = 0, m = 1 + (r() * 3 | 0); k < m; k++) {                                           // the bar flexes and re-touches
    hits.push({ t: t0 + 0.0003 + r() * 0.0016, w: 0.00005, a: force * (0.1 + r() * 0.25), nz: 0.8, nt: 0.00012 });
  }
  const E = exc(n, sr, hits, r);
  const out = new Float64Array(n);
  const fb = M.bars[z] * (1 + gn(r) * 0.003);
  const BEAM = [[1, 0.036, 0.2], [2.756, 0.03, 0.18], [5.404, 0.022, 0.14], [8.933, 0.016, 0.08]];  // typebar, damped by the platen
  for (const [k, d, a] of BEAM) mode(out, E, sr, fb * k * (1 + gn(r) * 0.003), d * D * jit(r, 0.3), a * jit(r, 0.4));
  modes(out, E, sr, M.clack[z], r, 0.5, 0.03, 0.3);                                             // slug + platen contact
  modes(out, E, sr, M.shimmer, r, 0.6, 0.02, 0.3, 1, 1, P.click);
  M.frame.forEach(([f, d, a], j) => mode(out, E, sr, f * (1 + gn(r) * 0.003), d * D / P.decay * jit(r, 0.2), a * 1.2 * M.zoneFrame[z][j] * jit(r, 0.5)));
  modes(out, E, sr, M.tin, r, 0.5, 0.004, 0.2, 1, 1 + 0.08 * z, P.tin);                         // thin cover plates
  mode(out, E, sr, P.thud * (1 + gn(r) * 0.03), 0.03, 0.8 * P.thudA * jit(r, 0.2));             // rubber platen thud
  mode(out, E, sr, P.thud * 1.63 * (1 + gn(r) * 0.03), 0.02, 0.8 * P.thudA * 0.4 * jit(r, 0.3));
  for (const [f, d, a] of P.body) mode(out, E, sr, f * (1 + gn(r) * 0.02), d, 0.7 * a * jit(r, 0.25));
  addHp(out, E, sr, 2000, 1.5 * P.click);
  noiseBurst(out, sr, r, t0, 0.0001, 0.0009, 2500, 10000, 3 * force * P.click);                 // ribbon + paper slap
  return trimFade(out, sr);
}

function keyTick(sr, r, P, M) {
  const n = Math.round(0.05 * sr), t0 = 0.001;
  const E = exc(n, sr, [{ t: t0, w: 0.00008, a: 1, nz: 0.5, nt: 0.00012 },
    { t: t0 + 0.0006 + r() * 0.0008, w: 0.0001, a: 0.3 * r(), nz: 0.3 }], r);
  const out = new Float64Array(n);
  modes(out, E, sr, M.glass, r, 0.5);
  modes(out, E, sr, M.keyLever, r, 0.4);
  addHp(out, E, sr, 3000, 0.8);
  return trimFade(out, sr);
}

function keyUp(sr, r, P, M) {
  const n = Math.round(0.09 * sr), t0 = 0.001;
  const E = exc(n, sr, [{ t: t0, w: 0.0004, a: 1, nz: 0.2, nt: 0.0003 },
    { t: t0 + 0.004 + r() * 0.01, w: 0.0008, a: 0.6 + r() * 0.3, nz: 0.1 }], r);
  const out = new Float64Array(n);
  modes(out, E, sr, M.keyStop, r, 0.5);
  mode(out, E, sr, 220 * P.pitch * jit(r, 0.1), 0.025, 0.25);
  addHp(out, E, sr, 1500, 0.3);
  return trimFade(out, sr);
}

function escapement(sr, r, P, M) {
  const n = Math.round(0.12 * sr), t0 = 0.001, dt = 0.003 + r() * 0.004;
  const E = exc(n, sr, [{ t: t0, w: 0.00006, a: 0.3 + r() * 0.15, nz: 0.4, nt: 0.0001 },     // dog releases
    { t: t0 + dt, w: 0.00008, a: 1, nz: 0.5, nt: 0.00018 }], r);                                // carriage stops on the next tooth
  const out = new Float64Array(n);
  modes(out, E, sr, M.esc, r, 0.5);
  modes(out, E, sr, M.ting, r, 0.4);
  modes(out, E, sr, M.escLow, r, 0.4);
  mode(out, E, sr, 175 * P.pitch * jit(r, 0.08), 0.03, 0.2 * P.heavy);                         // carriage mass
  addHp(out, E, sr, 3000, 0.9);
  return trimFade(out, sr);
}

function thump(sr, r, P) {   // extra body for heavy (shifted) strikes
  const n = Math.round(0.22 * sr), t0 = 0.002;
  const E = exc(n, sr, [{ t: t0, w: 0.0012, a: 1 }], r);
  const out = new Float64Array(n);
  for (const [f, d, a] of P.body) mode(out, E, sr, f * jit(r, 0.03), d * 1.2, a * 1.3);
  mode(out, E, sr, P.thud * 0.75 * jit(r, 0.05), 0.05, 0.5);
  return trimFade(out, sr);
}

function spaceDown(sr, r, P, M) {
  const n = Math.round(0.2 * sr), t0 = 0.002;
  const E = exc(n, sr, [{ t: t0, w: 0.0004, a: 1, nz: 0.25, nt: 0.0003 },
    { t: t0 + 0.0015 + r() * 0.003, w: 0.0004, a: 0.5 + r() * 0.4, nz: 0.2 }], r);   // the two ends of the bar
  const out = new Float64Array(n);
  modes(out, E, sr, M.spaceBar, r, 0.4, 0.004, 0.2);
  modes(out, E, sr, M.frame, r, 0.5, 0.003, 0.2, 1, 1, 0.3);
  for (const [f, d, a] of P.body) mode(out, E, sr, f * jit(r, 0.03), d, a * 1.2);
  addHp(out, E, sr, 2500, 0.25);
  return trimFade(out, sr);
}

function spaceUp(sr, r, P, M) {
  const n = Math.round(0.12 * sr), t0 = 0.002;
  const E = exc(n, sr, [{ t: t0, w: 0.0005, a: 0.8, nz: 0.15 }, { t: t0 + 0.002 + r() * 0.004, w: 0.0006, a: 0.5 }], r);
  const out = new Float64Array(n);
  modes(out, E, sr, M.spaceBar, r, 0.5, 0.004, 0.2, 1, 0.7, 0.5);
  modes(out, E, sr, M.keyStop, r, 0.5, 0.004, 0.2, 0.9, 1, 0.6);
  return trimFade(out, sr);
}

function backClack(sr, r, P, M) {
  const n = Math.round(0.16 * sr), t0 = 0.002;
  const E = exc(n, sr, [{ t: t0, w: 0.00025, a: 1, nz: 0.4, nt: 0.0003 }, { t: t0 + 0.003 + r() * 0.003, w: 0.0003, a: 0.25 }], r);
  const out = new Float64Array(n);
  modes(out, E, sr, M.backLever, r, 0.4);
  modes(out, E, sr, M.frame, r, 0.5, 0.003, 0.2, 1, 1, 0.5);
  for (const [f, d, a] of P.body) mode(out, E, sr, f * jit(r, 0.03), d, a * 0.6);
  addHp(out, E, sr, 2200, 0.5);
  return trimFade(out, sr);
}

function shiftSound(sr, r, P, M, down) {
  const n = Math.round(0.26 * sr), t0 = 0.002;
  const main = exc(n, sr, [{ t: t0, w: down ? 0.0009 : 0.0007, a: 1, nz: 0.15, nt: 0.0005 },
    { t: t0 + 0.004 + r() * 0.004, w: 0.0006, a: 0.2 + 0.35 * r() }], r);
  const hits = [], cnt = down ? 7 + (r() * 6 | 0) : 3 + (r() * 3 | 0);
  for (let k = 0; k < cnt; k++) hits.push({ t: t0 + 0.0015 + Math.pow(r(), 1.6) * (down ? 0.04 : 0.025), w: 0.00006, a: 0.08 + r() * 0.25, nz: 0.5, nt: 0.0001 });
  const cl = exc(n, sr, hits, r);
  const out = new Float64Array(n), k = down ? 1 : 0.6;
  P.shiftLow.forEach((f, j) => mode(out, main, sr, f * jit(r, 0.03), [0.09, 0.075, 0.055][j] * P.decay, [0.6, 0.5, 0.35][j] * k * P.heavy * jit(r, 0.2)));
  modes(out, main, sr, M.shiftMid, r, 0.3, 0.004, 0.2, 1, 1, k);
  modes(out, cl, sr, M.basket, r, 0.5);
  modes(out, cl, sr, M.frame, r, 0.5, 0.003, 0.2, 1, 1, 0.5);
  addHp(out, main, sr, 1200, 0.15);
  addHp(out, cl, sr, 2500, 0.4);
  return trimFade(out, sr);
}

function bellSound(sr, r, P, M) {
  const n = Math.round((1.75 * P.bellDecay + 0.1) * sr), t0 = 0.002, ts = t0 + 0.012 + r() * 0.01;
  const trip = exc(n, sr, [{ t: t0, w: 0.00005, a: 0.25, nz: 0.5, nt: 0.0001 }], r);
  const hit = exc(n, sr, [{ t: ts, w: 0.00009 + r() * 0.00004, a: 1, nz: 0.25, nt: 0.00008 }], r);
  const out = new Float64Array(n);
  modes(out, trip, sr, M.trip, r, 0.3);
  addHp(out, trip, sr, 3000, 0.4);
  modes(out, hit, sr, M.bell, r, 0.25, 0.0003, 0.1);
  mode(out, hit, sr, 520 * P.pitch, 0.02, 0.15);       // the hammer and the post
  addHp(out, hit, sr, 4000, 0.3);
  return trimFade(out, sr, -72);
}

function ratchetClick(sr, r, P, M, soft = 0) {
  const n = Math.round(0.09 * sr), t0 = 0.001, dt = 0.002 + r() * 0.002;
  const E = exc(n, sr, [{ t: t0, w: 0.00006, a: 0.25 + r() * 0.1, nz: 0.4, nt: 0.0001 },
    { t: t0 + dt, w: soft ? 0.00014 : 0.00007, a: 1, nz: 0.5, nt: 0.00012 },
    { t: t0 + dt + 0.0012 + r() * 0.001, w: 0.0001, a: 0.2 * r() }], r);
  const out = new Float64Array(n);
  modes(out, E, sr, M.ratchet, r, 0.5, 0.004, 0.2, soft ? 0.94 : 1);
  modes(out, E, sr, M.platen, r, 0.4);
  mode(out, E, sr, 260 * P.pitch * jit(r, 0.08), 0.025, 0.2);
  if (soft) mode(out, E, sr, 420 * jit(r, 0.1), 0.012, 0.25);   // the rubber knob under the fingers
  addHp(out, E, sr, 3000, soft ? 0.4 : 0.7);
  return trimFade(out, sr);
}

function leverClick(sr, r, P, M) {
  const n = Math.round(0.14 * sr), t0 = 0.002;
  const E = exc(n, sr, [{ t: t0, w: 0.00015, a: 1, nz: 0.4, nt: 0.0002 }, { t: t0 + 0.002 + r() * 0.003, w: 0.0002, a: 0.3 * r() }], r);
  const out = new Float64Array(n);
  modes(out, E, sr, M.lever, r, 0.3);
  modes(out, E, sr, M.frame, r, 0.5, 0.003, 0.2, 1, 1, 0.5);
  addHp(out, E, sr, 2500, 0.6);
  return trimFade(out, sr);
}

function stopThunk(sr, r, P, M) {
  const n = Math.round(0.42 * sr), t0 = 0.002;
  const hits = [{ t: t0, w: 0.0006, a: 1, nz: 0.3, nt: 0.0004 }];
  let tb = t0, ab = 0.28;
  for (let k = 0, m = 3 + (r() * 3 | 0); k < m; k++) { tb += 0.006 + r() * 0.012; hits.push({ t: tb, w: 0.0003, a: ab * jit(r, 0.4), nz: 0.4 }); ab *= 0.55; }
  const E = exc(n, sr, hits, r);
  const out = new Float64Array(n);
  [[1, 0.12, 0.8], [1.6, 0.08, 0.5], [2.5, 0.05, 0.35]].forEach(([k, d, a]) => mode(out, E, sr, P.stop * k * jit(r, 0.03), d * P.decay, a * P.heavy * jit(r, 0.2)));
  modes(out, E, sr, M.stopClack, r, 0.4);
  modes(out, E, sr, M.frame, r, 0.5, 0.003, 0.2, 1, 1.6, 0.8);
  modes(out, E, sr, M.stopRing, r, 0.3);
  addHp(out, E, sr, 1500, 0.4);
  return trimFade(out, sr);
}

function correctionSound(sr, r, P, M) {
  const n = Math.round(0.14 * sr), t0 = 0.002;
  const E = exc(n, sr, [{ t: t0, w: 0.0007, a: 1, nz: 0.1 }], r);
  const out = new Float64Array(n);
  modes(out, E, sr, M.clack[1], r, 0.5, 0.02, 0.2, 0.9, 1.2, 0.3);
  mode(out, E, sr, P.thud * jit(r, 0.05), 0.025, P.thudA * 0.7);
  noiseBurst(out, sr, r, t0, 0.0015, 0.005, 900, 6000, 0.9);              // the tape and the paper
  const cr = [];
  for (let k = 0, m = 3 + (r() * 4 | 0); k < m; k++) cr.push({ t: t0 + 0.025 + r() * 0.05, w: 0.00004, a: 0.04 + r() * 0.1 });
  const C = exc(n, sr, cr, r);                                                // the tape peeling off
  mode(out, C, sr, logr(r, 3000, 6000), 0.002, 0.5);
  mode(out, C, sr, logr(r, 2000, 4000), 0.003, 0.4);
  return trimFade(out, sr);
}

function jamSound(sr, r, P, M) {
  const n = Math.round(0.15 * sr), t0 = 0.002;
  const E = exc(n, sr, [{ t: t0, w: 0.0009, a: 1, nz: 0.1 }], r);
  const C = exc(n, sr, [{ t: t0 + 0.003 + r() * 0.002, w: 0.0001, a: 0.3, nz: 0.3 }], r);
  const out = new Float64Array(n);
  for (let j = 0; j < 3; j++) mode(out, E, sr, logr(r, 150, 500) * P.pitch, 0.02 + r() * 0.02, 0.4);
  modes(out, E, sr, M.frame, r, 0.5, 0.003, 0.2, 1, 1, 0.15);
  mode(out, C, sr, logr(r, 1600, 3200), 0.012, 0.25);
  mode(out, C, sr, logr(r, 1600, 3200), 0.01, 0.2);
  return trimFade(out, sr);
}

// Carriage velocity during a throw (u = t / duration): a quick push over the first 13 %, then a
// steady slow-down from 1.3 to 0.75 so it still hits the margin stop with some speed.
const slideVel = u => (u < 0 || u >= 1 ? 0 : smoothstep(0, 0.13, u) * (1.3 - 0.55 * u));
const EASE = (() => {
  const N = 512, t = new Float64Array(N + 1);
  let acc = 0;
  for (let i = 1; i <= N; i++) { acc += slideVel((i - 0.5) / N); t[i] = acc; }
  for (let i = 0; i <= N; i++) t[i] /= acc;
  return t;
})();
// Fraction of the carriage travel done at u = t / duration (0..1), matching the rack rattle of
// carriageReturn() and carriageMove(); use it to animate the 3D carriage.
export function carriageEase(u) {
  const x = clamp(+u || 0, 0, 1) * 512, i = Math.min(511, Math.floor(x));
  return EASE[i] + (EASE[i + 1] - EASE[i]) * (x - i);
}

// The carriage slide (return / reposition): friction + the escapement ratchet rattling over
// the rack, one tick per column crossed, fast at first and slowing into the stop.
function slideSound(sr, P, M, cols, dur, seed, soft) {
  const r = rng(seed), n = Math.ceil((dur + 0.015) * sr), D = Math.max(1, dur * sr);
  const v = new Float64Array(n);
  let area = 0, vmax = 0;
  for (let i = 0; i < n; i++) {
    const s = slideVel(i / D);
    v[i] = s; area += s; if (s > vmax) vmax = s;
  }
  const E = { x: new Float64Array(n), s0: 0, s1: n };
  let x = 0, next = 1;
  for (let i = 0; i < n - 1; i++) {
    x += v[i] * cols / area;
    while (x >= next && next <= cols) {
      const a = Math.pow(v[i] / vmax, 0.8) * (0.5 + 0.5 * r());
      E.x[i] += a; E.x[i + 1] -= a * 0.3; next++;
    }
  }
  const out = new Float64Array(n);
  modes(out, E, sr, M.rack, r, 0.3, 0.01, 0.2, 1, 1, 18);
  addHp(out, E, sr, 2500, soft ? 1.5 : 2.5);
  const fr = new Float64Array(n), ru = new Float64Array(n);
  for (let i = 0; i < n; i++) { fr[i] = r() * 2 - 1; ru[i] = r() * 2 - 1; }
  biquad(fr, sr, 'hp', 280); biquad(fr, sr, 'lp', 2600); biquad(fr, sr, 'peak', 900, 1.2, 4);
  biquad(ru, sr, 'lp', 160); biquad(ru, sr, 'lp', 160);
  const kf = soft ? 0.05 : 0.09, kr = soft ? 0.3 : 0.6;
  for (let i = 0; i < n; i++) {
    const vv = v[i] / vmax;
    out[i] += fr[i] * kf * Math.pow(vv, 1.3) + ru[i] * kr * vv;
  }
  const fi = Math.ceil(0.003 * sr);
  for (let i = 0; i < fi; i++) out[i] *= i / fi;
  return trimFade(out, sr, -60);
}

// Time-varying band-pass (TPT state-variable filter), fc(t) in Hz.
function svfBP(x, sr, fcAt, q) {
  const k = 1 / q;
  let ic1 = 0, ic2 = 0, g = 0, a1 = 0, a2 = 0, a3 = 0;
  for (let i = 0; i < x.length; i++) {
    if ((i & 31) === 0) {
      g = Math.tan(Math.PI * Math.min(fcAt(i / sr), sr * 0.45) / sr);
      a1 = 1 / (1 + g * (g + k)); a2 = g * a1; a3 = g * a2;
    }
    const v3 = x[i] - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
    x[i] = v1;
  }
  return x;
}

function crinkle(out, sr, r, t0, t1, rate, amp) {
  const hits = [];
  for (let t = t0 + -Math.log(1 - r()) / rate; t < t1; t += -Math.log(1 - r()) / rate) hits.push({ t, w: 0.00004, a: amp * Math.pow(10, -r() * 1.2) });
  const C = exc(out.length, sr, hits, r);
  mode(out, C, sr, logr(r, 2500, 4500), 0.0018, 0.6);
  mode(out, C, sr, logr(r, 4500, 7500), 0.0012, 0.5);
  addHp(out, C, sr, 3000, 0.3);
}

const PAPER_IN = 1.55, PAPER_OUT = 1.2;

function paperInSound(sr, r, P, M) {
  const n = Math.round((PAPER_IN + 0.25) * sr), out = new Float64Array(n);
  const ct = [];
  const K = { x: new Float64Array(n), s0: 0, s1: n };
  for (let t = 0.14; t < 1.36;) {               // the hand speeds up, then slows to seat the sheet
    ct.push(t);
    const i = Math.round(t * sr), a = (0.35 + 0.65 * r()) * (0.75 + 0.25 * Math.sin(Math.PI * (t - 0.14) / 1.22));
    K.x[i] += a * 4; K.x[i + 1] += a * 2.4;
    t += (0.05 + r() * 0.02) * (1.35 - 0.45 * Math.sin(Math.PI * (t - 0.14) / 1.22));
  }
  modes(out, K, sr, M.ratchet, r, 0.3, 0.004, 0.1, 0.97, 0.7, 0.5);
  modes(out, K, sr, M.platen, r, 0.3);
  addHp(out, K, sr, 3000, 0.25);
  // paper sliding around the platen: hiss with slow wobble, flutter and a jerk at each click
  const h = new Float64Array(n);
  for (let i = 0; i < n; i++) h[i] = r() * 2 - 1;
  biquad(h, sr, 'hp', 1500); biquad(h, sr, 'lp', 7500); biquad(h, sr, 'peak', 3500, 1, 3);
  const ph = r() * TAU;
  let ci = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    while (ci < ct.length - 1 && ct[ci + 1] <= t) ci++;
    const jerk = t >= ct[ci] ? Math.exp(-(t - ct[ci]) / 0.012) : 0;
    const e = smoothstep(0.1, 0.25, t) * (1 - smoothstep(1.32, 1.45, t)) * (0.75 + 0.25 * Math.sin(TAU * 0.9 * t + ph)) * (1 + 0.12 * Math.sin(TAU * 19 * t)) * (1 + 0.35 * jerk);
    out[i] += h[i] * e * 0.3;
  }
  crinkle(out, sr, r, 0.15, 1.4, 35, 0.5);
  noiseBurst(out, sr, r, 0.06, 0.002, 0.01, 300, 2500, 0.25);              // the sheet touches the platen
  const B = exc(n, sr, [{ t: 1.47, w: 0.00015, a: 1, nz: 0.3, nt: 0.0002 }, { t: 1.474, w: 0.0002, a: 0.25 }], r);
  modes(out, B, sr, M.bail, r, 0.3);                                        // the paper bail snaps back
  mode(out, B, sr, 260 * P.pitch, 0.02, 0.3);
  addHp(out, B, sr, 2500, 0.4);
  return trimFade(out, sr);
}

function paperOutSound(sr, r, P, M) {
  const n = Math.round((PAPER_OUT + 0.3) * sr), out = new Float64Array(n);
  const L = exc(n, sr, [{ t: 0.003, w: 0.00015, a: 1, nz: 0.4, nt: 0.0002 }, { t: 0.0065, w: 0.0003, a: 0.3 }], r);
  modes(out, L, sr, M.lever, r, 0.3, 0.004, 0.2, 1.15);                     // paper release lever
  modes(out, L, sr, M.frame, r, 0.5, 0.003, 0.2, 1, 1, 0.4);
  mode(out, L, sr, 180 * P.pitch, 0.03, 0.3);
  addHp(out, L, sr, 2500, 0.5);
  // the drag: band-passed noise sweeping up as the sheet speeds out, with flutter
  const h = new Float64Array(n), b = new Float64Array(n);
  for (let i = 0; i < n; i++) { h[i] = r() * 2 - 1; b[i] = r() * 2 - 1; }
  svfBP(h, sr, t => 1300 + 1900 * smoothstep(0.1, 1.1, t), 0.9);
  biquad(b, sr, 'hp', 600); biquad(b, sr, 'lp', 9000);
  const fl = wander(r, 26), ph = r() * TAU;
  for (let i = 0; i < n; i++) {
    const t = i / sr, u = (t - 0.1) / 1.0;
    const e = smoothstep(0.1, 0.24, t) * (1 - smoothstep(1.02, 1.14, t)) * (0.75 + 0.35 * clamp(u, 0, 1));
    const f = 1 + 0.25 * Math.sin(TAU * (18 + 12 * clamp(u, 0, 1)) * t + ph) + 0.2 * fl(t);
    out[i] += (h[i] * 0.6 + b[i] * 0.18) * e * f;
  }
  crinkle(out, sr, r, 0.12, 1.1, 25, 0.4);
  noiseBurst(out, sr, r, 1.13, 0.002, 0.02, 250, 1500, 0.5);                // the sheet leaves: a soft flap
  noiseBurst(out, sr, r, 1.135, 0.0003, 0.002, 2000, 9000, 0.2);
  return trimFade(out, sr);
}

// ------------------------------------------------------------------------------------------
// Bank: every buffer for one profile.

const COUNTS = { strike: 6, tick: 6, keyUp: 6, escape: 8, thump: 4, space: 6, spaceUp: 4, back: 5,
  shiftDown: 4, shiftUp: 4, bell: 4, ratchet: 8, knob: 6, lever: 4, stop: 4, correction: 4, jam: 4 };

async function buildBank(sr, id) {
  const t0 = now();
  const P = PROF[id], M = makeMachine(P, hash32('platen-machine', id));
  const r = rng(hash32('platen-bank', id));
  const many = (k, fn) => Array.from({ length: k }, (_, i) => fn(i));
  const raw = {};
  raw.strike = many(4, z => many(COUNTS.strike, () => strike(sr, r, P, M, z)));
  await idle();
  raw.tick = many(COUNTS.tick, () => keyTick(sr, r, P, M));
  raw.keyUp = many(COUNTS.keyUp, () => keyUp(sr, r, P, M));
  raw.escape = many(COUNTS.escape, () => escapement(sr, r, P, M));
  raw.thump = many(COUNTS.thump, () => thump(sr, r, P));
  raw.space = many(COUNTS.space, () => spaceDown(sr, r, P, M));
  raw.spaceUp = many(COUNTS.spaceUp, () => spaceUp(sr, r, P, M));
  raw.back = many(COUNTS.back, () => backClack(sr, r, P, M));
  raw.shiftDown = many(COUNTS.shiftDown, () => shiftSound(sr, r, P, M, true));
  raw.shiftUp = many(COUNTS.shiftUp, () => shiftSound(sr, r, P, M, false));
  await idle();
  raw.bell = many(COUNTS.bell, () => bellSound(sr, r, P, M));
  await idle();
  raw.ratchet = many(COUNTS.ratchet, () => ratchetClick(sr, r, P, M, 0));
  raw.knob = many(COUNTS.knob, () => ratchetClick(sr, r, P, M, 1));
  raw.lever = many(COUNTS.lever, () => leverClick(sr, r, P, M));
  raw.stop = many(COUNTS.stop, () => stopThunk(sr, r, P, M));
  raw.correction = many(COUNTS.correction, () => correctionSound(sr, r, P, M));
  raw.jam = many(COUNTS.jam, () => jamSound(sr, r, P, M));
  normGroup(raw.strike.flat(), true, sr);
  const B = { id, P, M, sr, cache: new Map() };
  const ENERGY = new Set(['space', 'escape', 'tick', 'keyUp', 'ratchet', 'knob']);
  for (const k of Object.keys(raw)) {
    if (k === 'strike') { B.strike = raw.strike.map(zs => zs.map(a => toBuffer(a, sr))); continue; }
    B[k] = normGroup(raw[k], ENERGY.has(k), sr).map(a => toBuffer(a, sr));
  }
  B.ms = now() - t0;
  return B;
}

function cached(B, key, make) {
  let b = B.cache.get(key);
  if (!b) {
    b = make();
    B.cache.set(key, b);
    if (B.cache.size > 48) B.cache.delete(B.cache.keys().next().value);
  }
  return b;
}
function normOne(f32) { const p = peakOf(f32) || 1; for (let i = 0; i < f32.length; i++) f32[i] /= p; return f32; }

// ------------------------------------------------------------------------------------------
// Room impulse response: a small warm room (RT about 0.3 s, damped highs, early reflections).

function buildRoomIR(sr) {
  const r = rng(hash32('platen-room'));
  const n = Math.ceil(0.55 * sr), chans = [];
  const bands = [['lp', 450, 0.4, 0.9], ['bp', 1200, 0.3, 1.0], ['hp', 2800, 0.16, 0.5]];  // type, f, RT60, gain
  for (let c = 0; c < 2; c++) {
    const x = new Float32Array(n);
    for (const [type, f, rt, g] of bands) {
      const w = whiteN(n, r);
      if (type === 'bp') { biquad(w, sr, 'hp', 450); biquad(w, sr, 'lp', 2800); } else { biquad(w, sr, type, f); biquad(w, sr, type, f); }
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        x[i] += w[i] * g * Math.pow(10, -3 * t / rt) * smoothstep(0.004, 0.028, t);
      }
    }
    for (let k = 0; k < 14; k++) {                  // early reflections, slightly smeared
      const t = 0.0022 + Math.pow(r(), 1.3) * 0.026, a = (0.75 - t * 15) * (0.5 + 0.5 * r()) * (r() < 0.5 ? -1 : 1);
      const i0 = Math.round(t * sr), tau = 0.00006 * sr;
      for (let j = 0; j < 12; j++) if (i0 + j < n) x[i0 + j] += a * Math.exp(-j / tau) * 3;
    }
    chans.push(x);
  }
  let e = 0;
  for (const x of chans) for (let i = 0; i < n; i++) e += x[i] * x[i];
  const k = 1 / Math.sqrt(e / 2);
  for (const x of chans) for (let i = 0; i < n; i++) x[i] *= k;
  const fo = Math.ceil(0.03 * sr);
  for (const x of chans) for (let j = 0; j < fo; j++) x[n - 1 - j] *= j / fo;
  return toBuffer(chans, sr);
}

// ------------------------------------------------------------------------------------------
// Ambience loops (built lazily, stereo, seamless)

const AMB_SECS = { rain: 40, fire: 40, clock: 30, night: 40 };
const AMB_TARGET = { rain: -24, fire: -25, clock: null, night: -27 };   // RMS dBFS at level 1 (clock: peak -14)

async function ambienceData(id, sr) {
  const T = AMB_SECS[id], n = Math.round(T * sr), X = Math.round(1.5 * sr);
  const r = rng(hash32('platen-amb', id));
  const [L, R] = await AMB_GEN[id](sr, n, X, r);
  let e = 0, pk = 0;
  for (let i = 0; i < n; i++) { e += L[i] * L[i] + R[i] * R[i]; pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i])); }
  const rms = Math.sqrt(e / (2 * n));
  const k = AMB_TARGET[id] == null ? dB(-14) / pk : dB(AMB_TARGET[id]) / rms;
  for (let i = 0; i < n; i++) { L[i] *= k; R[i] *= k; }
  return [L, R];
}

// The loops are generated in a module worker running this same file (so the page never stalls);
// if workers are unavailable they are generated here instead, in yielding chunks.
function ambienceViaWorker(id, sr) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker(import.meta.url, { type: 'module' }); } catch (e) { reject(e); return; }
    const done = () => { clearTimeout(timer); w.terminate(); };
    const timer = setTimeout(() => { done(); reject(new Error('ambience worker timeout')); }, 90000);
    w.onmessage = e => {
      done();
      if (e.data && e.data.L) { AMB_GEN_MS[id] = e.data.ms; resolve([e.data.L, e.data.R]); }
      else reject(new Error((e.data && e.data.error) || 'ambience worker failed'));
    };
    w.onerror = e => { done(); reject(e instanceof Error ? e : new Error('ambience worker error')); };
    w.postMessage({ platenAmbience: id, sr });
  });
}

const AMB_GEN_MS = {};      // generation time per loop (inside the worker when one is used)
async function buildAmbience(id, sr) {
  let data;
  try { data = await ambienceViaWorker(id, sr); AMB_GEN_MS[id + ':where'] = 'worker'; }
  catch { const t0 = now(); data = await ambienceData(id, sr); AMB_GEN_MS[id] = now() - t0; AMB_GEN_MS[id + ':where'] = 'main'; }
  return toBuffer(data, sr);
}

const AMB_GEN = {
  async rain(sr, n, X, r) {
    const N = n + X, out = [];
    const swell = sines(r, [[0.05, 0.16], [0.13, 0.1], [0.31, 0.06]]), flut = sines(r, [[4.7, 0.025], [7.3, 0.02]]);
    const far = wander(r, 0.12);
    for (let c = 0; c < 2; c++) {
      const a = pinkN(N, r);
      biquad(a, sr, 'hp', 560, 0.6); biquad(a, sr, 'hp', 560, 0.9); biquad(a, sr, 'lp', 6000); biquad(a, sr, 'lp', 7500, 0.6);
      biquad(a, sr, 'peak', 2300, 0.7, 2.5);
      const own = sines(r, [[0.09, 0.06], [0.21, 0.05]]);
      const m = ctrl(N, sr, t => 1 + swell(t) + own(t) + flut(t));
      const w = brownN(N, r);                       // the broad wash of rain outside
      biquad(w, sr, 'lp', 900); biquad(w, sr, 'hp', 140); biquad(w, sr, 'hp', 140);
      const u = brownN(N, r);                       // far low rumble
      biquad(u, sr, 'lp', 110); biquad(u, sr, 'lp', 110); biquad(u, sr, 'hp', 35);
      const mu = ctrl(N, sr, t => 0.75 + 0.25 * far(t));
      for (let i = 0; i < N; i++) a[i] = a[i] * m[i] + w[i] * 0.25 * m[i] + u[i] * 0.3 * mu[i];
      out.push(foldBed(a, n, X));
      await idle();
    }
    // droplets on the glass: many tiny ticks (power-law amplitudes), a few families of pane modes
    const fams = [[3200, 4700, 6100], [2400, 3900, 7300], [2900, 5200, 6600], [2600, 4300, 8000]].map(fs =>
      bankIR(sr, fs.map(f => [f * jit(r, 0.05), 0.003 + r() * 0.003, 0.12]), 2500, 0.6, [1, -0.5]));
    for (let k = 0, cnt = Math.round(90 * n / sr); k < cnt; k++) {
      const i = (r() * n) | 0, a = Math.pow(10, -r() * 1.8), [gl, gr] = panGains(r() * 2 - 1), ir = fams[(r() * fams.length) | 0];
      wrapAdd(out[0], i, ir, a * gl); wrapAdd(out[1], i, ir, a * gr);
    }
    await idle();
    // heavier drips: a bigger knock on the pane with a little splatter
    for (let k = 0, cnt = Math.round(0.5 * n / sr); k < cnt; k++) {
      const len = Math.round(0.06 * sr), buf = new Float64Array(len), hits = [{ t: 0.001, w: 0.0001, a: 1, nz: 0.5, nt: 0.0001 }];
      for (let s = 0, m = 3 + (r() * 6 | 0); s < m; s++) hits.push({ t: 0.002 + r() * 0.015, w: 0.00004, a: 0.05 + r() * 0.2 });
      const E = exc(len, sr, hits, r);
      mode(buf, E, sr, logr(r, 1500, 2600), 0.006, 0.4); mode(buf, E, sr, logr(r, 2800, 4200), 0.004, 0.3);
      addHp(buf, E, sr, 2000, 0.3);
      const [gl, gr] = panGains(r() * 1.6 - 0.8), i0 = (r() * n) | 0, a = 0.08 + r() * 0.08;
      wrapAdd(out[0], i0, buf, a * gl); wrapAdd(out[1], i0, buf, a * gr);
    }
    // the odd drip outside falling into water: a small rising plink, far and soft
    for (let k = 0, cnt = Math.round(0.2 * n / sr); k < cnt; k++) {
      const tau = 0.008 + r() * 0.012, len = Math.ceil(tau * 7 * sr), buf = new Float64Array(len);
      const f0 = logr(r, 1100, 2400), rise = 0.2 + r() * 0.3;
      let ph = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        ph += TAU * f0 * (1 + rise * (1 - Math.exp(-t / tau))) / sr;
        buf[i] = Math.sin(ph) * (1 - Math.exp(-t / 0.0005)) * Math.exp(-t / tau);
      }
      biquad(buf, sr, 'lp', 3500);
      const [gl, gr] = panGains(r() * 2 - 1), i0 = (r() * n) | 0, a = 0.012 + r() * 0.012;
      wrapAdd(out[0], i0, buf, a * gl); wrapAdd(out[1], i0, buf, a * gr);
    }
    return out;
  },

  async fire(sr, n, X, r) {
    const N = n + X, out = [];
    const breath = wander(r, 0.18), breath2 = sines(r, [[0.07, 0.12], [0.23, 0.08]]), flick = sines(r, [[2.3, 0.05], [3.7, 0.05], [5.9, 0.04]]);
    const hissW = wander(r, 0.4);
    const m = ctrl(N, sr, t => Math.max(0.25, 1 + 0.32 * breath(t) + breath2(t) + flick(t)));
    for (let c = 0; c < 2; c++) {
      const a = brownN(N, r);
      biquad(a, sr, 'lp', 300); biquad(a, sr, 'lp', 300); biquad(a, sr, 'hp', 38); biquad(a, sr, 'hp', 38);
      const p = pinkN(N, r);
      biquad(p, sr, 'hp', 280); biquad(p, sr, 'lp', 800);
      const h = whiteN(N, r);
      biquad(h, sr, 'hp', 2800); biquad(h, sr, 'lp', 9000);
      const mh = ctrl(N, sr, t => 0.6 + 0.4 * hissW(t));
      for (let i = 0; i < N; i++) a[i] = (a[i] * 0.7 + p[i] * 0.8) * m[i] + h[i] * 0.05 * mh[i];
      out.push(foldBed(a, n, X));
      await idle();
    }
    // crackles: Poisson with clusters; short broadband snaps through small wood resonances
    const times = [];
    for (let t = 0; t < n / sr; t += -Math.log(1 - r()) / 8) times.push([t, 1]);
    for (let t = 0; t < n / sr; t += -Math.log(1 - r()) / 0.7) {
      const span = 0.03 + r() * 0.15;
      for (let k = 0, m2 = 3 + (r() * 10 | 0); k < m2; k++) times.push([t + r() * span, 0.6]);
    }
    const fams = [[1400, 3600], [2200, 5200], [1100, 6400], [1700, 4400], [2600, 5900]].map(fs =>
      bankIR(sr, fs.map(f => [f * jit(r, 0.05), 0.0015 + r() * 0.003, 0.3]), 1500, 1.2));
    for (const [t, w] of times) {
      const i = Math.floor(t * sr) % n, a = w * Math.pow(10, -0.2 - r() * 1.4), [gl, gr] = panGains(gn(r) * 0.3), ir = fams[(r() * fams.length) | 0];
      for (let s = 0, len = 1 + (r() * 3 | 0); s < len; s++) {    // a crackle is 1-4 samples of random-sign snap
        const v = a * (r() * 2 - 1);
        wrapAdd(out[0], i + s, ir, v * gl); wrapAdd(out[1], i + s, ir, v * gr);
      }
    }
    await idle();
    // pops: sap bursting, a woody knock with a spray of tiny crackles
    for (let k = 0, cnt = Math.round(0.12 * n / sr); k < cnt; k++) {
      const len = Math.round(0.12 * sr), buf = new Float64Array(len), hits = [{ t: 0.001, w: 0.00025, a: 1, nz: 0.6, nt: 0.0002 }];
      for (let s = 0, m2 = 6 + (r() * 10 | 0); s < m2; s++) hits.push({ t: 0.002 + Math.pow(r(), 1.5) * 0.07, w: 0.00004, a: 0.05 + r() * 0.2 });
      const E = exc(len, sr, hits, r);
      for (let j = 0; j < 4; j++) mode(buf, E, sr, logr(r, 450, 1800), 0.015 + r() * 0.025, 0.25);
      addHp(buf, E, sr, 1500, 0.5);
      const [gl, gr] = panGains(gn(r) * 0.3), i0 = (r() * n) | 0, a = 0.09 + r() * 0.09;
      wrapAdd(out[0], i0, buf, a * gl); wrapAdd(out[1], i0, buf, a * gr);
    }
    return out;
  },

  async clock(sr, n, X, r) {
    const out = [new Float32Array(n), new Float32Array(n)];
    const beat = (tock) => {
      const len = Math.round(0.45 * sr), buf = new Float64Array(len), t0 = 0.001;
      const E = exc(len, sr, [{ t: t0, w: 0.00005, a: tock ? 0.85 : 1, nz: 0.4, nt: 0.0001 },
        { t: t0 + (tock ? 0.0035 : 0.0026) + r() * 0.0006, w: 0.00006, a: tock ? 0.4 : 0.5, nz: 0.3 }], r);
      const metal = tock ? [2650, 3820, 5150, 7300] : [3100, 4420, 5650, 7900];
      metal.forEach(f => mode(buf, E, sr, f * jit(r, 0.004), 0.004 + r() * 0.006, 0.25));
      const wood = tock ? [290, 470, 820, 1240, 1720] : [330, 540, 760, 1150, 2100];
      wood.forEach((f, j) => mode(buf, E, sr, f * jit(r, 0.004), (0.06 - j * 0.008) * jit(r, 0.1), (0.4 - j * 0.05) * (tock ? 1.15 : 1)));
      mode(buf, E, sr, 215 * jit(r, 0.004), 0.05, 0.25);           // the hollow case
      mode(buf, E, sr, 531, 0.45, 0.006);                           // the coiled gong, barely touched
      mode(buf, E, sr, 1373, 0.3, 0.003);
      addHp(buf, E, sr, 3000, 0.5);
      return buf;
    };
    const ticks = [0, 1, 2, 3].map(() => beat(false)), tocks = [0, 1, 2, 3].map(() => beat(true));
    const [gl, gr] = panGains(0.25);
    const room = [0, 1].map(() => {                                  // a whisper of room on each beat
      const len = Math.round(0.4 * sr), w = new Float64Array(len);
      for (let i = 0; i < len; i++) w[i] = (r() * 2 - 1) * Math.pow(10, -3 * (i / sr) / 0.32) * smoothstep(0, 0.01, i / sr);
      biquad(w, sr, 'lp', 2500); biquad(w, sr, 'hp', 150);
      return w;
    });
    const beats = Math.round(n / sr);
    for (let k = 0; k < beats; k++) {
      for (const tock of [false, true]) {
        const t = k + (tock ? 0.508 : 0) + gn(r) * 0.0003, i0 = Math.round(t * sr), b = (tock ? tocks : ticks)[r() * 4 | 0], a = jit(r, 0.04);
        wrapAdd(out[0], i0, b, a * gl); wrapAdd(out[1], i0 + Math.round(0.0003 * sr), b, a * gr);
        wrapAdd(out[0], i0, room[0], a * 0.02); wrapAdd(out[1], i0, room[1], a * 0.02);
      }
    }
    for (let c = 0; c < 2; c++) {                                    // faint room tone
      const p = pinkN(n + X, r);
      biquad(p, sr, 'lp', 600); biquad(p, sr, 'hp', 50);
      const f = foldBed(p, n, X);
      for (let i = 0; i < n; i++) out[c][i] += f[i] * 0.15;
    }
    return out;
  },

  async night(sr, n, X, r) {
    const N = n + X, out = [];
    const gust = wander(r, 0.07), gust2 = sines(r, [[0.031, 0.25], [0.11, 0.12]]);
    const g = ctrl(N, sr, t => clamp(0.6 + 0.25 * gust(t) + 0.6 * gust2(t), 0.3, 1.1));
    for (let c = 0; c < 2; c++) {
      const w = pinkN(N, r);
      biquad(w, sr, 'lp', 420); biquad(w, sr, 'lp', 420); biquad(w, sr, 'hp', 45);
      const l = whiteN(N, r);                                         // leaves
      biquad(l, sr, 'hp', 1800); biquad(l, sr, 'lp', 5000);
      for (let i = 0; i < N; i++) w[i] = w[i] * g[i] * 0.45 + l[i] * g[i] * g[i] * 0.012;
      out.push(foldBed(w, n, X));
      await idle();
    }
    // two far tree crickets: soft continuous trills, tuned to repeat exactly over the loop
    const T = n / sr;
    for (const [f0, rate, p] of [[2950, 48, -0.5], [3180, 53, 0.6]]) {
      const ft = Math.round(f0 * jit(r, 0.02) * T) / T, pr = Math.round(rate * jit(r, 0.04) * T) / T;
      const p1 = r() * TAU, p2 = r() * TAU, [gl, gr] = panGains(p);
      const amp = ctrl(n, sr, t => 0.55 + 0.25 * Math.sin(TAU * t / T + p1) + 0.15 * Math.sin(TAU * 3 * t / T + p2));
      for (let i = 0; i < n; i++) {
        const t = i / sr, pulse = Math.max(0, Math.sin(TAU * pr * t));
        const v = Math.sin(TAU * ft * t) * pulse * pulse * amp[i] * 0.0045;
        out[0][i] += v * gl; out[1][i] += v * gr;
      }
    }
    // field crickets at different distances: chirps of 3-4 syllables, each with its own rhythm
    const crickets = [1.0, 1.5, 2.2, 3.0, 4.2].map(dist => ({
      f: logr(r, 3900, 5000), dist, pan: (r() * 2 - 1) * 0.85, syl: 3 + (r() * 2 | 0), sylDur: 0.011 + r() * 0.005,
      sylPer: 0.027 + r() * 0.008, per: 0.38 + r() * 0.24, on: 4 + r() * 10, off: 1.5 + r() * 4.5,
    }));
    for (const C of crickets) {
      const [gl, gr] = panGains(C.pan), amp = 0.03 / Math.pow(C.dist, 1.25), h2 = 0.06 / C.dist;
      const echo = 0.008 + r() * 0.012, sl = Math.round(C.sylDur * sr), syl = new Float64Array(sl);
      let t = r() * 3, onUntil = t + C.on * jit(r, 0.4);
      while (t < n / sr) {
        if (t > onUntil) { t += C.off * jit(r, 0.5); onUntil = t + C.on * jit(r, 0.5); continue; }
        const ns = C.syl - (r() < 0.15 ? 1 : 0), a = amp * jit(r, 0.15);
        for (let s = 0; s < ns; s++) {
          const ph0 = r() * TAU;
          for (let i = 0; i < sl; i++) {
            const u = i / sl, env = Math.pow(Math.sin(Math.PI * Math.pow(u, 0.8)), 2), f = C.f * (1 - 0.025 * u);
            syl[i] = env * (Math.sin(TAU * f * i / sr + ph0) + h2 * Math.sin(2 * TAU * f * i / sr + ph0));
          }
          const i0 = Math.round((t + s * C.sylPer * jit(r, 0.04)) * sr), ae = a * (s === 0 ? 0.8 : 1);
          wrapAdd(out[0], i0, syl, ae * gl); wrapAdd(out[1], i0, syl, ae * gr);
          const ie = i0 + Math.round(echo * sr);                       // reflection off the house wall
          wrapAdd(out[0], ie, syl, ae * gr * 0.25); wrapAdd(out[1], ie, syl, ae * gl * 0.25);
        }
        t += C.per * jit(r, 0.08);
      }
    }
    return out;
  },
};

// ------------------------------------------------------------------------------------------
// Graph: per-voice gain + pan -> machine bus -> compressor -> dry + room -> mix <- ambience
//        -> master -> soft clipper -> destination. One builder for live and offline contexts.

const ROOM_WET = 0.15;
const COMP_TRIM = dB(-2.9);    // undoes the compressor's automatic makeup gain (+2.90 dB, tools/audio-compcal.js)
let CLIP_CURVE = null;
function clipCurve() {
  if (CLIP_CURVE) return CLIP_CURVE;
  const N = 4097, c = new Float32Array(N), t = 0.6, ceil = 0.98;
  for (let i = 0; i < N; i++) {
    const u = (i / (N - 1)) * 2 - 1, x = Math.abs(u * 2);           // a 0.5 pre-gain is undone here
    const y = x < t ? x : t + (ceil - t) * Math.tanh((x - t) / (ceil - t));
    c[i] = Math.sign(u) * y;
  }
  return (CLIP_CURVE = c);
}

function buildGraph(ctx, ir, mix, limiter = true) {
  const G = { ctx, bank: null, bellOn: true };
  G.bus = ctx.createGain(); G.bus.gain.value = Math.SQRT2;          // undo the pan law's -3 dB at centre
  G.machine = ctx.createGain(); G.machine.gain.value = fader(mix.machine);
  G.bus.connect(G.machine);
  let m = G.machine;
  if (limiter) {
    const c = G.comp = ctx.createDynamicsCompressor();
    c.threshold.value = -9; c.knee.value = 6; c.ratio.value = 4; c.attack.value = 0.002; c.release.value = 0.12;
    G.trim = ctx.createGain(); G.trim.gain.value = COMP_TRIM;
    m.connect(c); c.connect(G.trim); m = G.trim;
  }
  G.mix = ctx.createGain();
  m.connect(G.mix);
  G.conv = ctx.createConvolver(); G.conv.normalize = false;
  G.conv.channelCount = 1; G.conv.channelCountMode = 'explicit';
  G.conv.buffer = ir;
  G.wet = ctx.createGain(); G.wet.gain.value = ROOM_WET;
  m.connect(G.conv); G.conv.connect(G.wet); G.wet.connect(G.mix);
  G.amb = ctx.createGain(); G.amb.gain.value = fader(mix.ambienceLevel);
  G.amb.connect(G.mix);
  G.master = ctx.createGain(); G.master.gain.value = fader(mix.master);
  G.mix.connect(G.master);
  if (limiter) {
    G.pre = ctx.createGain(); G.pre.gain.value = 0.5;
    G.clip = ctx.createWaveShaper(); G.clip.curve = clipCurve(); G.clip.oversample = '2x';
    G.master.connect(G.pre); G.pre.connect(G.clip); G.clip.connect(ctx.destination);
  } else G.master.connect(ctx.destination);
  return G;
}

// One layer of an event: buffer -> (high shelf) -> gain -> stereo pan -> machine bus.
function voice(G, buf, when, gain, pan = 0, rate = 1, shelf = 0, panTo) {
  if (!buf || !(gain > 0)) return;
  const c = G.ctx, s = c.createBufferSource();
  s.buffer = buf;
  if (rate !== 1) s.playbackRate.value = rate;
  const g = c.createGain(); g.gain.value = gain;
  const p = c.createStereoPanner(); p.pan.value = clamp(pan, -1, 1);
  const t = Math.max(when, c.currentTime);
  if (panTo !== undefined) { p.pan.setValueAtTime(clamp(pan, -1, 1), t); p.pan.linearRampToValueAtTime(clamp(panTo, -1, 1), t + buf.duration / rate); }
  let f = null;
  if (Math.abs(shelf) > 0.3) {
    f = c.createBiquadFilter(); f.type = 'highshelf'; f.frequency.value = 2500; f.gain.value = shelf;
    s.connect(f); f.connect(g);
  } else s.connect(g);
  g.connect(p); p.connect(G.bus);
  s.onended = () => { s.disconnect(); if (f) f.disconnect(); g.disconnect(); p.disconnect(); };
  s.start(t);
}

function pickV(list, R) {
  let i = Math.floor(R() * list.length) % list.length;
  if (list.length > 1 && i === list._last) i = (i + 1) % list.length;
  list._last = i;
  return list[i];
}

// Typebar for a character: position in the basket (edge bars are longer: lower, longer ring),
// a small consistent pitch nudge, and slug size (punctuation is light, wide letters heavy).
const BAR_PAIRS = '1!2@3#4$5%6^7&8*9(0)-_=+qQwWeErRtTyYuUiIoOpP[{]}aAsSdDfFgGhHjJkKlL;:\'"zZxXcCvVbBnNmM,<.>/?`~\\|';
const BAR_OF = new Map();
for (let i = 0; i < BAR_PAIRS.length; i += 2) { BAR_OF.set(BAR_PAIRS[i], i >> 1); BAR_OF.set(BAR_PAIRS[i + 1], i >> 1); }
const BAR_CACHE = new Map();
function barInfo(ch) {
  const c = ch == null ? '' : String(ch);
  let b = BAR_CACHE.get(c);
  if (b) return b;
  const h = hash32('typebar', BAR_OF.has(c) ? 'b' + BAR_OF.get(c) : 'c' + c.toLowerCase());
  const edge = Math.abs(((h & 0xffff) / 65535) * 2 - 1);
  const zone = Math.min(3, Math.floor(edge * 4));
  const rate = 1 + (((h >>> 16) & 0xff) / 255 - 0.5) * 0.03 - edge * 0.008;
  const gain = '.,\'`-_:;"'.includes(c) ? dB(-2.5) : 'mwMW@#%&'.includes(c) ? dB(0.8) : 1;
  b = { zone, rate, gain, small: '.,\'`'.includes(c) };
  BAR_CACHE.set(c, b);
  return b;
}

// Playback levels (linear) for unit-peak buffers: peak dBFS per channel at full faders,
// centre pan, before the compressor. The strike is the reference.
const LV = {
  strike: dB(-6.5), tick: dB(-29), keyUp: dB(-28), escape: dB(-17), thump: dB(-15), space: dB(-10),
  spaceUp: dB(-26), back: dB(-13), backStep: dB(-18), shiftDown: dB(-11), shiftUp: dB(-16), bell: dB(-12.5),
  ratchet: dB(-17), knob: dB(-21), lever: dB(-15), stop: dB(-6.5), slide: dB(-17), correction: dB(-17),
  jam: dB(-15), paperIn: dB(-12), paperOut: dB(-11), move: dB(-21),
};

const RET_DUR = cols => 0.12 + 0.004 * cols;
const MOVE_DUR = cols => clamp(0.045 + 0.0045 * cols, 0.04, 0.5);

// Events. Every one takes (G, when, o); with G = null it only computes its return value.
// All randomness comes from rng(o.seed), so a logged event replays the same offline.
const EV = {
  key(G, when, o) {
    const R = rng(o.seed), I = clamp(o.intensity ?? 1, 0, 1.5);
    const travel = (0.012 + R() * 0.01) / (0.65 + 0.35 * I);       // harder presses fly faster
    const esc = travel + 0.02 + R() * 0.018, up = travel + 0.065 + R() * 0.05;
    const res = { strike: travel, escape: esc };
    if (!G) return res;
    const B = G.bank, bar = barInfo(o.char), pan = clamp(o.pan ?? 0, -1, 1);
    const zone = o.char == null ? (R() * 4) | 0 : bar.zone;
    const sg = I <= 1 ? Math.pow(I, 1.3) : 1 + (I - 1) * 0.45;
    voice(G, pickV(B.tick, R), when, LV.tick * (0.6 + 0.45 * I) * jit(R, 0.2), pan);
    voice(G, pickV(B.strike[zone], R), when + travel, LV.strike * sg * bar.gain * jit(R, 0.06), pan * 0.15,
      bar.rate * (bar.small ? 1.03 : 1), (I - 1) * 5);
    if (I > 1.05) voice(G, pickV(B.thump, R), when + travel, LV.thump * (I - 1) * 2 * B.P.heavy, 0);
    voice(G, pickV(B.escape, R), when + esc, LV.escape * jit(R, 0.15), -0.08);
    voice(G, pickV(B.keyUp, R), when + up, LV.keyUp * jit(R, 0.25) * (0.7 + 0.3 * I), pan);
    return res;
  },
  space(G, when, o) {
    const R = rng(o.seed), I = clamp(o.intensity ?? 1, 0, 1.5);
    const down = 0.008 + R() * 0.006, esc = down + 0.018 + R() * 0.014, up = down + 0.08 + R() * 0.04;
    const res = { strike: down, escape: esc };
    if (!G) return res;
    const B = G.bank, pan = clamp(o.pan ?? 0, -1, 1);
    voice(G, pickV(B.space, R), when + down, LV.space * Math.pow(I, 1.2) * jit(R, 0.1), pan * 0.3);
    voice(G, pickV(B.escape, R), when + esc, LV.escape * jit(R, 0.15), -0.08);
    voice(G, pickV(B.spaceUp, R), when + up, LV.spaceUp * jit(R, 0.25), pan * 0.3);
    return res;
  },
  backspace(G, when, o) {
    const R = rng(o.seed), I = clamp(o.intensity ?? 1, 0, 1.5);
    const clack = 0.016 + R() * 0.008, step = clack + 0.008 + R() * 0.006, up = clack + 0.085 + R() * 0.035;
    const res = { strike: clack, escape: step };
    if (!G) return res;
    const B = G.bank, pan = clamp(o.pan ?? 0, -1, 1);
    voice(G, pickV(B.tick, R), when, LV.tick * jit(R, 0.2), pan);
    voice(G, pickV(B.back, R), when + clack, LV.back * I * jit(R, 0.1), pan * 0.4);
    voice(G, pickV(B.escape, R), when + step, LV.backStep * jit(R, 0.15), -0.1, 0.88);
    voice(G, pickV(B.keyUp, R), when + up, LV.keyUp * jit(R, 0.25), pan);
    return res;
  },
  shift(G, when, o) {
    const R = rng(o.seed), I = clamp(o.intensity ?? 1, 0, 1.5), down = !!o.down;
    const at = down ? 0.01 + R() * 0.006 : 0.004 + R() * 0.004;
    const res = { strike: at };
    if (!G) return res;
    const B = G.bank, pan = clamp(o.pan ?? 0, -1, 1);
    if (down) voice(G, pickV(B.tick, R), when, LV.tick * jit(R, 0.2), pan);
    voice(G, pickV(down ? B.shiftDown : B.shiftUp, R), when + at, (down ? LV.shiftDown : LV.shiftUp) * I * jit(R, 0.1), pan * 0.25);
    return res;
  },
  bell(G, when, o) {
    const R = rng(o.seed);
    if (!G) return { duration: 1.5 };
    if (!G.bellOn) return { duration: 0 };
    voice(G, pickV(G.bank.bell, R), when, LV.bell * clamp(o.intensity ?? 1, 0, 1.5) * jit(R, 0.08), clamp(o.pan ?? 0.3, -1, 1));
    return { duration: 1.5 };
  },
  carriageReturn(G, when, o) {
    const R = rng(o.seed), cols = clamp(+(o.cols ?? 40) || 0, 0, 160), lines = Math.abs(+(o.lines ?? 1) || 0);
    const duration = RET_DUR(cols), res = { duration };
    if (!G) return res;
    const B = G.bank, loud = 0.55 + 0.45 * Math.min(1, cols / 50);
    voice(G, pickV(B.lever, R), when, LV.lever * jit(R, 0.1), -0.45);
    const clicks = Math.min(4, Math.ceil(lines - 1e-6));
    for (let k = 0; k < clicks; k++) voice(G, pickV(B.ratchet, R), when + 0.012 + k * 0.034 + R() * 0.006, LV.ratchet * jit(R, 0.15), -0.3);
    if (cols > 0.25) {
      const v = (R() * 3) | 0, key = `ret|${cols}|${v}`;
      const sb = cached(B, key, () => toBuffer(normOne(slideSound(B.sr, B.P, B.M, cols, duration, hash32(key, B.id), false)), B.sr));
      voice(G, sb, when, LV.slide * (0.55 + 0.45 * loud), -0.4, 1, 0, 0.2);
    }
    voice(G, pickV(B.stop, R), when + duration, LV.stop * loud * jit(R, 0.08), 0.2);
    return res;
  },
  lineFeed(G, when, o) {
    const R = rng(o.seed), n = Math.max(1, Math.min(8, Math.ceil(Math.abs(+(o.lines ?? 1) || 1) - 1e-6)));
    const gap = 0.05, res = { duration: (n - 1) * gap + 0.03 };
    if (!G) return res;
    for (let k = 0; k < n; k++) voice(G, pickV(G.bank.ratchet, R), when + k * gap + R() * 0.008, LV.ratchet * jit(R, 0.15) * (o.up ? 0.8 : 1), -0.35, o.up ? 0.93 : 1);
    return res;
  },
  carriageMove(G, when, o) {
    const R = rng(o.seed), cols = Math.abs(+(o.cols ?? 1) || 0), duration = MOVE_DUR(cols), res = { duration };
    if (!G) return res;
    const B = G.bank;
    if (cols <= 1.01) {
      voice(G, pickV(B.escape, R), when + 0.004, LV.escape * 0.55 * jit(R, 0.15), -0.08, 0.95);
      return res;
    }
    const v = (R() * 3) | 0, key = `mov|${cols}|${v}`;
    const sb = cached(B, key, () => toBuffer(normOne(slideSound(B.sr, B.P, B.M, cols, duration, hash32(key, B.id), true)), B.sr));
    voice(G, sb, when, LV.move, 0);
    voice(G, pickV(B.escape, R), when + duration, LV.escape * 0.7 * jit(R, 0.15), -0.08, 0.92);
    return res;
  },
  jam(G, when, o) {
    const R = rng(o.seed), I = clamp(o.intensity ?? 1, 0, 1.5), at = 0.01 + R() * 0.006, up = at + 0.09 + R() * 0.03;
    const res = { strike: at };
    if (!G) return res;
    const B = G.bank, pan = clamp(o.pan ?? 0, -1, 1);
    voice(G, pickV(B.tick, R), when, LV.tick * jit(R, 0.2), pan);
    voice(G, pickV(B.jam, R), when + at, LV.jam * I * jit(R, 0.1), pan * 0.4);
    voice(G, pickV(B.keyUp, R), when + up, LV.keyUp * 0.7 * jit(R, 0.2), pan);
    return res;
  },
  knob(G, when, o) {
    const R = rng(o.seed), n = Math.max(1, Math.min(40, Math.round(Math.abs(+(o.clicks ?? 1) || 1))));
    const ts = [];
    for (let k = 0, t = 0; k < n; k++) { ts.push(t); t += 0.06 + R() * 0.06; }
    const res = { duration: ts[n - 1] + 0.04 };
    if (!G) return res;
    ts.forEach(t => voice(G, pickV(G.bank.knob, R), when + t, LV.knob * jit(R, 0.2), clamp(o.pan ?? 0.55, -1, 1)));
    return res;
  },
  paperIn(G, when, o) {
    const R = rng(o.seed), res = { duration: PAPER_IN };
    if (!G) return res;
    const B = G.bank, v = (R() * 2) | 0;
    voice(G, cached(B, 'pin|' + v, () => toBuffer(normOne(paperInSound(B.sr, rng(hash32('pin', B.id, v)), B.P, B.M)), B.sr)), when, LV.paperIn, clamp(o.pan ?? 0.1, -1, 1));
    return res;
  },
  paperOut(G, when, o) {
    const R = rng(o.seed), res = { duration: PAPER_OUT };
    if (!G) return res;
    const B = G.bank, v = (R() * 2) | 0;
    voice(G, cached(B, 'pout|' + v, () => toBuffer(normOne(paperOutSound(B.sr, rng(hash32('pout', B.id, v)), B.P, B.M)), B.sr)), when, LV.paperOut, clamp(o.pan ?? 0, -1, 1), 1, 0, clamp((o.pan ?? 0) + 0.25, -1, 1));
    return res;
  },
  correction(G, when, o) {
    const R = rng(o.seed), res = { duration: 0.1 };
    if (!G) return res;
    voice(G, pickV(G.bank.correction, R), when, LV.correction * clamp(o.intensity ?? 1, 0, 1.5) * jit(R, 0.1), clamp(o.pan ?? 0, -1, 1) * 0.15);
    return res;
  },
};

// Public call signature <-> internal options object.
function toOpts(name, args) {
  if (name === 'shift') return { ...(args[1] || {}), down: !!args[0] };
  return { ...(args[0] || {}) };
}
function toArgs(name, o) {
  if (name === 'shift') { const { down, ...rest } = o; return [down, rest]; }
  return [o];
}

// ------------------------------------------------------------------------------------------

export class TypewriterAudio {
  constructor() {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    this._mix = { master: 0.9, machine: 1, ambienceLevel: 0.5 };
    this._profile = 'portable';
    this._bellOn = true;
    this._ambId = null;
    this._amb = null;
    this._banks = {};
    this._bankP = {};
    this._ambP = {};
    this._rec = null;
    this.stats = { buildMs: {}, ambienceMs: {}, ambienceGen: AMB_GEN_MS, sampleRate: this.ctx.sampleRate };
    const t0 = now();
    this._ir = buildRoomIR(this.ctx.sampleRate);
    this.stats.roomMs = now() - t0;
    this._G = buildGraph(this.ctx, this._ir, this._mix, true);
    this.ready = this._init();
  }

  async _init() {
    const t0 = now();
    try {
      await this._bankFor(this._profile);
      this._G.bank = this._banks[this._profile];
      for (const p of PROFILES) await this._bankFor(p.id);
      this._G.bank = this._banks[this._profile];
    } catch (e) { console.error('[audio] build failed', e); }
    this.stats.buildMs.total = now() - t0;
    return this;
  }

  _bankFor(id) {
    if (!this._bankP[id]) {
      this._bankP[id] = buildBank(this.ctx.sampleRate, id).then(b => { this._banks[id] = b; this.stats.buildMs[id] = b.ms; return b; });
    }
    return this._bankP[id];
  }

  _ambFor(id) {
    if (!this._ambP[id]) {
      const t0 = now();
      this._ambP[id] = buildAmbience(id, this.ctx.sampleRate).then(b => { this.stats.ambienceMs[id] = now() - t0; return b; });
    }
    return this._ambP[id];
  }

  unlock() {
    const c = this.ctx;
    if (c.state === 'running') return Promise.resolve();
    try {
      const s = c.createBufferSource();
      s.buffer = new AudioBuffer({ length: 1, sampleRate: c.sampleRate });
      s.connect(c.destination); s.start();
    } catch { /* not needed everywhere */ }
    return c.resume().catch(() => {});
  }

  get context() { return this.ctx; }

  // --- mix (all 0..1; gain = v^2)
  _ramp(param, v) { const t = this.ctx.currentTime; param.cancelScheduledValues(t); param.setTargetAtTime(v, t, 0.03); }
  setMaster(v) { this._mix.master = clamp(+v || 0, 0, 1); this._ramp(this._G.master.gain, fader(v)); }
  setMachine(v) { this._mix.machine = clamp(+v || 0, 0, 1); this._ramp(this._G.machine.gain, fader(v)); }
  setAmbienceLevel(v) { this._mix.ambienceLevel = clamp(+v || 0, 0, 1); this._ramp(this._G.amb.gain, fader(v)); }
  setBell(on) { this._bellOn = !!on; this._G.bellOn = this._bellOn; }
  setProfile(id) {
    if (!PROF[id]) return;
    this._profile = id;
    if (this._banks[id]) this._G.bank = this._banks[id];
    else this._bankFor(id).then(b => { if (this._profile === id) this._G.bank = b; });
  }
  get profile() { return this._profile; }
  get ambience() { return this._ambId; }

  setAmbience(id) {
    id = id && AMB_SECS[id] ? id : null;
    this._ambId = id;
    const c = this.ctx, t = c.currentTime;
    if (this._amb && this._amb.id !== id) {
      const a = this._amb;
      a.g.gain.cancelScheduledValues(t); a.g.gain.setValueAtTime(a.g.gain.value, t); a.g.gain.setTargetAtTime(0, t, 0.45);
      try { a.src.stop(t + 3); } catch { /* already stopped */ }
      this._amb = null;
    }
    if (!id || this._amb) return;
    this._ambFor(id).then(buf => {
      if (this._ambId !== id || this._amb) return;
      const src = c.createBufferSource(), g = c.createGain(), t1 = c.currentTime;
      src.buffer = buf; src.loop = true;
      g.gain.value = 0; src.connect(g); g.connect(this._G.amb);
      src.start(t1, Math.random() * buf.duration);
      g.gain.setTargetAtTime(1, t1, 0.5);
      this._amb = { id, src, g };
    });
  }

  // --- events
  _call(name, args) {
    const o = toOpts(name, args);
    if (o.seed == null) o.seed = (Math.random() * 4294967296) >>> 0;
    if (this._rec) {
      this._rec.events.push({ t: this._rec.clock(), name, args: toArgs(name, o) });
      return EV[name](null, 0, o);
    }
    if (!this._G.bank) return EV[name](null, 0, o);
    return EV[name](this._G, this.ctx.currentTime + Math.max(0, +o.at || 0), o);
  }
  key(o = {}) { return this._call('key', [o]); }
  space(o = {}) { return this._call('space', [o]); }
  backspace(o = {}) { return this._call('backspace', [o]); }
  shift(down, o = {}) { return this._call('shift', [down, o]); }
  bell(o = {}) { return this._call('bell', [o]); }
  carriageReturn(o = {}) { return this._call('carriageReturn', [o]); }
  lineFeed(o = {}) { return this._call('lineFeed', [o]); }
  carriageMove(o = {}) { return this._call('carriageMove', [o]); }
  jam(o = {}) { return this._call('jam', [o]); }
  knob(o = {}) { return this._call('knob', [o]); }
  paperIn(o = {}) { return this._call('paperIn', [o]); }
  paperOut(o = {}) { return this._call('paperOut', [o]); }
  correction(o = {}) { return this._call('correction', [o]); }

  // --- offline
  startRecording(clock) {
    const t0 = now();
    this._rec = { clock: typeof clock === 'function' ? clock : () => (now() - t0) / 1000, events: [] };
  }
  stopRecording() {
    const ev = this._rec ? this._rec.events : [];
    this._rec = null;
    return ev;
  }

  // events: [{ t, name, args }] with t in seconds from the start of the render.
  // opts: { master, machine, ambience, ambienceLevel, profile, bell, sampleRate, limiter }
  async renderOffline(events, duration, opts = {}) {
    await this.ready;
    const live = this.ctx.sampleRate;
    const sr = opts.sampleRate || (live === 44100 || live === 48000 ? live : 48000);
    const profile = PROF[opts.profile] ? opts.profile : this._profile;
    const bank = await this._bankFor(profile);
    const ambId = opts.ambience === undefined ? this._ambId : opts.ambience;
    const amb = ambId && AMB_SECS[ambId] ? await this._ambFor(ambId) : null;
    const len = Math.max(1, Math.ceil(duration * sr));
    const oc = new OfflineAudioContext(2, len, sr);
    const mix = {
      master: opts.master ?? this._mix.master, machine: opts.machine ?? this._mix.machine,
      ambienceLevel: opts.ambienceLevel ?? this._mix.ambienceLevel,
    };
    const G = buildGraph(oc, this._ir, mix, opts.limiter !== false);
    G.bank = bank; G.bellOn = opts.bell ?? this._bellOn;
    if (amb) {
      const s = oc.createBufferSource(), g = oc.createGain();
      s.buffer = amb; s.loop = true; s.connect(g); g.connect(G.amb);
      g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(1, 0.4);
      s.start(0, (hash32('amb-offset', ambId) % 1000) / 1000 * amb.duration);
    }
    (events || []).forEach((e, i) => {
      if (!e || !EV[e.name]) return;
      const o = toOpts(e.name, e.args || []);
      if (o.seed == null) o.seed = hash32(e.name, e.t, i);
      const when = (+e.t || 0) + Math.max(0, +o.at || 0);
      if (when < duration) EV[e.name](G, when, o);
    });
    return oc.startRendering();
  }

  static encodeWav(buf) {
    const n = buf.length, sr = buf.sampleRate;
    const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    const ab = new ArrayBuffer(44 + n * 4), dv = new DataView(ab);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + n * 4, true); str(8, 'WAVE');
    str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
    str(36, 'data'); dv.setUint32(40, n * 4, true);
    const r = rng(0x5eed);
    let o = 44;
    for (let i = 0; i < n; i++) {
      for (const ch of [L, R]) {
        const v = Math.round(ch[i] * 32767 + (r() - r()));     // TPDF dither
        dv.setInt16(o, v < -32768 ? -32768 : v > 32767 ? 32767 : v, true); o += 2;
      }
    }
    return ab;
  }

  // Dev helper (used by dev/audio.html): the raw ambience loop as an AudioBuffer.
  async ambienceBuffer(id) { return AMB_SECS[id] ? this._ambFor(id) : null; }
}

// Worker side: when this module runs inside the ambience worker, answer generation requests.
if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  globalThis.addEventListener('message', async e => {
    const d = e.data || {};
    if (!d.platenAmbience) return;
    try {
      const t0 = now();
      const [L, R] = await ambienceData(d.platenAmbience, d.sr);
      globalThis.postMessage({ L, R, ms: now() - t0 }, [L.buffer, R.buffer]);
    } catch (err) { globalThis.postMessage({ error: String((err && err.message) || err) }); }
  });
}
