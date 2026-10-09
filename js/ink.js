// Platen — procedural paper and ribbon-ink renderer.
//
// Everything is computed in JS typed arrays and pushed to the canvas with putImageData, so a page
// is a pure function of (paper id, scale, strikes, ghosts): no Math.random, no GPU blending.
//
//   paper  : low-res fields (formation, cockle, mottling, stains) + full-res fields (grain, tooth,
//            fibres, specks, laid lines, foxing), combined into RGBA once per paper id + scale and
//            cached. A "tooth" height map is kept for the ink (ink catches the high spots).
//   strike : the cached glyph mask is resampled with the machine's per-character misalignment and
//            the strike's jitter, softened, textured by the ribbon weave, uneven slug contact,
//            pressure, paper tooth and wear, then multiplied into the page (Beer-Lambert, so
//            overstrikes accumulate and the paper shows through light strokes).
//   ghost  : chalky lift-off patch + a whisper of grey + the dent (shaded as lit from top left).
//
// Usage notes
//   - await loadFonts() before the first render: glyphs drawn earlier use a fallback face and
//     stay on the canvas until the next render()/setPaper().
//   - Draw order is ghosts first, then strikes in list order; add() appends to what the surface
//     knows, so setPaper() can repaint everything.
//   - Paper generation at scale 1 takes ~0.3-0.5 s (cached per id + scale, ~2 full-size papers).
//
// Additions to the SPEC: FONT_CSS, faceMetrics(id), paperTexture(id, scale), PAPERS[].desc,
// PageSurface#imageData, #stats, #dispose().
import { hash32, rng, gauss, clamp, lerp, smoothstep } from './util.js';

export const GRID = { COLS: 85, ROWS: 66, CW: 24, RH: 40, W: 2040, H: 2640 };

export const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=Courier+Prime:ital,wght@0,400;0,700;1,400&family=Cutive+Mono&family=Special+Elite&display=swap';

// ---------------------------------------------------------------------------------------------
// Papers
// ---------------------------------------------------------------------------------------------
// base: RGB of the sheet. warm: per-channel response to darkening (blue falls faster = warmer
// shadows). tone2: colour that `tint` mixes toward (age, kraft flecks). Sizes are in mm.
const PAPER_DEFS = {
  ivory: {
    name: 'Cotton Ivory', desc: 'Warm ivory cotton rag with soft cloudy formation.',
    base: [244, 237, 219], tone2: [214, 196, 160], warm: [0.9, 1.0, 1.25], wick: 1.0,
    form: { amp: 0.016, cell: 3.2, oct: 4, gain: 0.55, big: 0.005 }, grain: 0.011, tooth: 0.014, toothCell: 0.17,
    cockle: { amp: 0.004, cell: 30 }, mottle: 0.04, mottleCell: 6,
    fibres: { dens: 0.42, len: [0.7, 3.4], amp: 0.06, light: 0.6, dark: 0.7, curl: 0.4 },
    specks: { dens: 0.0012, amp: 0.22 }, vignette: { amp: 0.008, width: 2.5, tint: 0.04 },
  },
  bond: {
    name: 'Bright Bond', desc: 'Cool bright white bond, fine fibres, a gentle cockle.',
    base: [241, 243, 245], tone2: [224, 228, 236], warm: [1.0, 1.0, 0.96], wick: 0.6,
    form: { amp: 0.009, cell: 2.8, oct: 4, gain: 0.55, big: 0.003 }, grain: 0.008, tooth: 0.011, toothCell: 0.15,
    cockle: { amp: 0.012, cell: 16 }, mottle: 0,
    fibres: { dens: 0.5, len: [0.5, 2.0], amp: 0.045, light: 0.35, dark: 0.75, curl: 0.25 },
    specks: { dens: 0.0006, amp: 0.2 }, vignette: null,
  },
  laid: {
    name: 'Laid Cream', desc: 'Cream laid paper with fine laid lines and chain lines.',
    base: [241, 231, 205], tone2: [214, 196, 158], warm: [0.9, 1.0, 1.3], wick: 0.85,
    form: { amp: 0.014, cell: 3.2, oct: 4, gain: 0.55, big: 0.004 }, grain: 0.009, tooth: 0.012, toothCell: 0.18,
    cockle: { amp: 0.004, cell: 30 }, mottle: 0.04, mottleCell: 6,
    fibres: { dens: 0.3, len: [0.6, 2.6], amp: 0.05, light: 0.55, dark: 0.7, curl: 0.3 },
    specks: { dens: 0.001, amp: 0.22 }, vignette: { amp: 0.008, width: 2.5, tint: 0.05 },
    laid: { period: 1.0, amp: 0.03, chain: 25, chainAmp: 0.02 },
  },
  aged: {
    name: 'Aged Parchment', desc: 'Yellowed, darker at the edges, foxing and old stains.',
    base: [236, 218, 178], tone2: [190, 150, 96], warm: [0.85, 1.0, 1.35], wick: 1.1,
    form: { amp: 0.018, cell: 4, oct: 4, gain: 0.58, big: 0.01 }, grain: 0.012, tooth: 0.014, toothCell: 0.18,
    cockle: { amp: 0.006, cell: 28 }, mottle: 0.07, mottleCell: 12,
    fibres: { dens: 0.32, len: [0.7, 3.0], amp: 0.05, light: 0.45, dark: 0.75, curl: 0.35 },
    specks: { dens: 0.0025, amp: 0.25 }, vignette: { amp: 0.035, width: 30, tint: 0.4, rough: 6 }, toning: { amp: 0.05, width: 3.5, tint: 0.55, rough: 3 },
    foxing: { count: 70, clusters: 7 }, stains: 3,
  },
  onion: {
    name: 'Onionskin', desc: 'Thin translucent onionskin with a crinkled cockle finish.',
    base: [231, 234, 234], tone2: [212, 219, 223], warm: [1.04, 1.0, 0.95], wick: 0.55,
    form: { amp: 0.016, cell: 3, oct: 4, gain: 0.58, big: 0.007 }, grain: 0.011, tooth: 0.011, toothCell: 0.14,
    cockle: { amp: 0.004, cell: 22 }, mottle: 0.03, mottleCell: 5,
    crinkle: { amp: 0.012, cell: 2.6, big: 11, height: 0.5 },
    fibres: { dens: 0.6, len: [0.6, 2.8], amp: 0.055, light: 0.3, dark: 0.85, curl: 0.4 },
    specks: { dens: 0.0006, amp: 0.15 }, vignette: null,
  },
  kraft: {
    name: 'Kraft', desc: 'Warm brown kraft with darker fibre flecks.',
    base: [196, 156, 110], tone2: [146, 104, 64], warm: [0.85, 1.0, 1.2], wick: 1.1,
    form: { amp: 0.016, cell: 3, oct: 4, gain: 0.58, big: 0.007 }, grain: 0.016, tooth: 0.016, toothCell: 0.2,
    cockle: { amp: 0.006, cell: 25 }, mottle: 0.08, mottleCell: 3.5,
    fibres: { dens: 2.4, len: [0.4, 3.6], amp: 0.045, light: 0.42, dark: 1.25, curl: 0.35, tint: 0.35 },
    specks: { dens: 0.03, amp: 0.3, tint: 0.9 }, vignette: { amp: 0.015, width: 3, tint: 0.15 },
  },
};

const toHex = c => '#' + c.map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');

export const PAPERS = Object.entries(PAPER_DEFS).map(([id, d]) => ({ id, name: d.name, swatch: toHex(d.base), desc: d.desc }));

// ---------------------------------------------------------------------------------------------
// Inks: T = fraction of light each channel keeps at density 1 (Beer-Lambert). `color` is the
// printed colour on white paper for UI swatches.
// ---------------------------------------------------------------------------------------------
const INK_T = {
  k: { name: 'Black', T: [0.125, 0.117, 0.112], bleed: 1.0 },
  r: { name: 'Red', T: [0.80, 0.19, 0.12], bleed: 1.15 },
  n: { name: 'Navy', T: [0.15, 0.19, 0.40], bleed: 1.0 },
  s: { name: 'Sepia', T: [0.42, 0.27, 0.16], bleed: 1.05 },
  v: { name: 'Violet', T: [0.38, 0.21, 0.58], bleed: 1.6 },
};
export const INKS = {};
for (const [k, v] of Object.entries(INK_T)) INKS[k] = { name: v.name, color: toHex(v.T.map(t => t * 255)) };

export const RIBBONS = [
  { id: 'black', name: 'Black', inks: ['k'] },
  { id: 'blackred', name: 'Black & Red', inks: ['k', 'r'] },
  { id: 'navy', name: 'Navy', inks: ['n'] },
  { id: 'sepia', name: 'Sepia', inks: ['s'] },
  { id: 'violet', name: 'Violet copy', inks: ['v'] },
];

export const TYPEFACES = [
  { id: 'pica', name: 'Pica', family: 'Courier Prime' },
  { id: 'elite', name: 'Elite', family: 'Special Elite' },
  { id: 'cutive', name: 'Cutive', family: 'Cutive Mono' },
];

// ---------------------------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------------------------
// Per face: advance (em), font size at scale 1 (px), measured once the fonts are usable.
const FACE = {};
for (const t of TYPEFACES) FACE[t.id] = { id: t.id, family: t.family, advance: 0.6, size: GRID.CW / 0.6, ready: false };
let fontEpoch = 0;
let fontsPromise = null;
const FONT_SAMPLE = 'AaBbEeGgMmQqWwYy0123456789 .,;:!?@#$%&*()[]/"\'-_ éèàçñüöäß £°§';

function ensureFontLink() {
  const links = [...document.querySelectorAll('link[rel="stylesheet"]')];
  let link = links.find(l => /fonts\.googleapis\.com/.test(l.href) && /Special\+Elite/.test(l.href) && /Cutive\+Mono/.test(l.href));
  if (!link) {
    link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = FONT_CSS;
    document.head.appendChild(link);
  }
  if (link.sheet) return Promise.resolve();
  return new Promise(res => {
    link.addEventListener('load', res, { once: true });
    link.addEventListener('error', res, { once: true });
    setTimeout(res, 8000);
  });
}

function measureFaces() {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  for (const f of Object.values(FACE)) {
    ctx.font = `100px "${f.family}", "Courier New", monospace`;
    let sum = 0, n = 0;
    for (const ch of 'MWimn0') { sum += ctx.measureText(ch).width; n++; }
    const adv = sum / n / 100;
    f.advance = adv > 0.3 && adv < 1 ? adv : 0.6;
    f.size = GRID.CW / f.advance;
  }
}

// Resolves (to true when all three faces loaded) once the faces are usable on canvas.
export function loadFonts() {
  if (fontsPromise) return fontsPromise;
  fontsPromise = (async () => {
    if (typeof document === 'undefined' || !document.fonts) return false;
    await ensureFontLink();
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const jobs = [];
    for (const t of TYPEFACES) {
      jobs.push(document.fonts.load(`40px "${t.family}"`, FONT_SAMPLE).catch(() => []));
      if (t.id === 'pica') jobs.push(document.fonts.load(`bold 40px "${t.family}"`, 'Aa').catch(() => []));
    }
    await Promise.race([Promise.all(jobs), wait(12000)]);
    const ok = TYPEFACES.every(t => document.fonts.check(`40px "${t.family}"`, 'Aa'));
    for (const t of TYPEFACES) FACE[t.id].ready = document.fonts.check(`40px "${t.family}"`, 'Aa');
    measureFaces();
    fontEpoch++;
    maskCache.clear();
    return ok;
  })();
  return fontsPromise;
}

// Face metrics after loadFonts (advance in em, font px at scale 1). Addition to the SPEC.
export function faceMetrics(id) { const f = FACE[id] || FACE.pica; return { advance: f.advance, size: f.size, ready: f.ready }; }

// ---------------------------------------------------------------------------------------------
// Small math helpers
// ---------------------------------------------------------------------------------------------
function ihash(x, y, s) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ (s | 0);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// smooth value noise in [0,1)
function vnoise(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = ihash(ix, iy, s), b = ihash(ix + 1, iy, s), c = ihash(ix, iy + 1, s), d = ihash(ix + 1, iy + 1, s);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

// Catmull-Rom lattice noise added into o1 (and optionally o2), unit-ish standard deviation.
const NOISE_NORM = 2.3;
function crNoise(w, h, cell, seed, o1, a1, o2 = null, a2 = 0) {
  if (cell < 0.8) cell = 0.8;
  const gw = Math.floor(w / cell) + 6, gh = Math.floor(h / cell) + 6;
  const r = rng(seed);
  const offx = r() * cell, offy = r() * cell;
  const g = new Float32Array(gw * gh);
  for (let i = 0; i < g.length; i++) g[i] = r() * 2 - 1;
  const xi = new Int32Array(w), xw = new Float32Array(w * 4);
  for (let x = 0; x < w; x++) {
    const gx = (x + 0.5 + offx) / cell + 1;
    const i = Math.floor(gx), t = gx - i, t2 = t * t, t3 = t2 * t;
    xi[x] = i - 1;
    xw[x * 4] = -0.5 * t3 + t2 - 0.5 * t;
    xw[x * 4 + 1] = 1.5 * t3 - 2.5 * t2 + 1;
    xw[x * 4 + 2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
    xw[x * 4 + 3] = 0.5 * t3 - 0.5 * t2;
  }
  const rows = [new Float32Array(w), new Float32Array(w), new Float32Array(w), new Float32Array(w)];
  const rowIdx = [-1, -1, -1, -1];
  const getRow = j => {
    const slot = j & 3, row = rows[slot];
    if (rowIdx[slot] !== j) {
      const b = j * gw;
      for (let x = 0; x < w; x++) {
        const k = b + xi[x], q = x * 4;
        row[x] = g[k] * xw[q] + g[k + 1] * xw[q + 1] + g[k + 2] * xw[q + 2] + g[k + 3] * xw[q + 3];
      }
      rowIdx[slot] = j;
    }
    return row;
  };
  const k1 = a1 * NOISE_NORM, k2 = a2 * NOISE_NORM;
  for (let y = 0; y < h; y++) {
    const gy = (y + 0.5 + offy) / cell + 1, j = Math.floor(gy), t = gy - j, t2 = t * t, t3 = t2 * t;
    const w0 = -0.5 * t3 + t2 - 0.5 * t, w1 = 1.5 * t3 - 2.5 * t2 + 1, w2 = -1.5 * t3 + 2 * t2 + 0.5 * t, w3 = 0.5 * t3 - 0.5 * t2;
    const r0 = getRow(j - 1), r1 = getRow(j), r2 = getRow(j + 1), r3 = getRow(j + 2);
    const o = y * w;
    if (o2) {
      for (let x = 0; x < w; x++) {
        const v = r0[x] * w0 + r1[x] * w1 + r2[x] * w2 + r3[x] * w3;
        o1[o + x] += v * k1; o2[o + x] += v * k2;
      }
    } else {
      for (let x = 0; x < w; x++) o1[o + x] += (r0[x] * w0 + r1[x] * w1 + r2[x] * w2 + r3[x] * w3) * k1;
    }
  }
}

function fbm(out, w, h, cell, oct, gain, seed, minCell = 1.6) {
  let a = 1, sum = 0;
  for (let o = 0; o < oct; o++) {
    if (cell >= minCell) { crNoise(w, h, cell, seed + o * 7919, out, a); sum += a * a; }
    cell /= 2.03; a *= gain;
  }
  const k = sum > 0 ? 1 / Math.sqrt(sum) : 0;
  for (let i = 0; i < out.length; i++) out[i] *= k;
}

function normalizeField(f) {
  let s = 0, s2 = 0;
  const n = f.length, step = Math.max(1, Math.floor(n / 50000));
  let c = 0;
  for (let i = 0; i < n; i += step) { s += f[i]; s2 += f[i] * f[i]; c++; }
  const m = s / c, sd = Math.sqrt(Math.max(1e-12, s2 / c - m * m));
  for (let i = 0; i < n; i++) f[i] = (f[i] - m) / sd;
}

// Bilinear upsample of a low-res field (cell i centred at page coordinate (i - 0.5) * step) added into dst.
function upsampleAdd(dst, W, H, src, lw, step, amp) {
  const xi = new Int32Array(W), xf = new Float32Array(W);
  for (let x = 0; x < W; x++) { const gx = (x + 0.5) / step + 0.5; const i = Math.floor(gx); xi[x] = i; xf[x] = gx - i; }
  for (let y = 0; y < H; y++) {
    const gy = (y + 0.5) / step + 0.5, j = Math.floor(gy), fy = gy - j;
    const r0 = j * lw, r1 = r0 + lw, o = y * W;
    for (let x = 0; x < W; x++) {
      const i = xi[x], fx = xf[x];
      const a = src[r0 + i] + (src[r0 + i + 1] - src[r0 + i]) * fx;
      const b = src[r1 + i] + (src[r1 + i + 1] - src[r1 + i]) * fx;
      dst[o + x] += (a + (b - a) * fy) * amp;
    }
  }
}

function splat(arr, W, H, x, y, v) {
  x -= 0.5; y -= 0.5;
  const ix = Math.floor(x), iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= W - 1 || iy >= H - 1) return;
  const fx = x - ix, fy = y - iy, o = iy * W + ix;
  arr[o] += v * (1 - fx) * (1 - fy);
  arr[o + 1] += v * fx * (1 - fy);
  arr[o + W] += v * (1 - fx) * fy;
  arr[o + W + 1] += v * fx * fy;
}

// soft round blob (radius in px); rough edge from value noise
function blob(arr, W, H, cx, cy, rad, v, seed = 0, rough = 0) {
  if (rad < 0.6) { splat(arr, W, H, cx, cy, v * Math.PI * rad * rad / 1.1); return; }
  const R = Math.ceil(rad * 2.2 + 1);
  const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(W - 1, Math.ceil(cx + R));
  const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(H - 1, Math.ceil(cy + R));
  const inv = 1 / (rad * rad);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      let d2 = (dx * dx + dy * dy) * inv;
      if (rough) d2 *= 1 + rough * (vnoise(x * 0.35, y * 0.35, seed) - 0.5);
      if (d2 > 4.5) continue;
      arr[y * W + x] += v * Math.exp(-d2 * 1.4);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Paper generation (cached per id + scale)
// ---------------------------------------------------------------------------------------------
// LRU with a memory budget: about two full-size papers plus any number of small ones.
const paperCache = new Map();
const PAPER_CACHE_BYTES = 130e6;

function getPaper(id, scale) {
  if (!PAPER_DEFS[id]) id = 'ivory';
  const key = id + '@' + scale;
  let p = paperCache.get(key);
  if (p) { paperCache.delete(key); paperCache.set(key, p); return p; }
  p = makePaper(id, scale);
  paperCache.set(key, p);
  let total = 0;
  for (const v of paperCache.values()) total += v.bytes;
  while (total > PAPER_CACHE_BYTES && paperCache.size > 1) {
    const k = paperCache.keys().next().value;
    total -= paperCache.get(k).bytes;
    paperCache.delete(k);
  }
  return p;
}

function makeCanvas(w, h) {
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  return new OffscreenCanvas(w, h);
}

// transient full-res float fields, reused between generations (single-threaded)
let PS = null;
let PSfree = 0;
function paperScratch(N) {
  if (!PS || PS.n !== N) PS = { n: N, lum: new Float32Array(N), fine: new Float32Array(N), tint: new Float32Array(N) };
  else { PS.lum.fill(0); PS.fine.fill(0); PS.tint.fill(0); }
  // let the big arrays go once generation bursts are over
  clearTimeout(PSfree);
  PSfree = setTimeout(() => { PS = null; }, 3000);
  return PS;
}

function makePaper(id, scale) {
  const t0 = performance.now();
  const def = PAPER_DEFS[id];
  const W = Math.round(GRID.W * scale), H = Math.round(GRID.H * scale), N = W * H;
  const ppmm = (240 / 25.4) * scale;
  const Wmm = W / ppmm, Hmm = H / ppmm;
  const seed = hash32('paper', id);
  const { lum, fine, tint } = paperScratch(N);
  const subPx = Math.min(1, ppmm / 9.45); // features below a pixel fade out on small pages

  // ---- low-res fields (about 0.5 mm per cell) ----
  const step = Math.max(1, Math.round(ppmm * 0.5));
  const lw = Math.ceil(W / step) + 2, lh = Math.ceil(H / step) + 2, LN = lw * lh;
  const lmm = step / ppmm;
  const lLum = new Float32Array(LN), lTint = new Float32Array(LN), lH = new Float32Array(LN);
  const tmp = new Float32Array(LN);
  const lowX = i => (i - 0.5) * lmm, lowY = j => (j - 0.5) * lmm;
  const minCell = 1.5;

  // formation: soft cloudy flocs
  fbm(tmp, lw, lh, def.form.cell / lmm, def.form.oct, def.form.gain, seed + 11, minCell);
  normalizeField(tmp);
  // formation reads strongly up close but hardly at all on a whole sheet seen small
  const formAmp = def.form.amp * lerp(0.45, 1, smoothstep(0.2, 0.8, scale));
  for (let i = 0; i < LN; i++) { lLum[i] += tmp[i] * formAmp; lH[i] += tmp[i] * 0.12; }
  const formation = tmp.slice();
  if (def.form.big) {
    tmp.fill(0);
    fbm(tmp, lw, lh, 24 / lmm, 2, 0.5, seed + 13, minCell);
    normalizeField(tmp);
    for (let i = 0; i < LN; i++) lLum[i] += tmp[i] * def.form.big;
  }

  // cockle: slow undulation of the sheet, seen as shading
  tmp.fill(0);
  fbm(tmp, lw, lh, def.cockle.cell / lmm, 3, 0.45, seed + 23, minCell);
  normalizeField(tmp);
  const Lx = -0.55, Ly = -0.83;
  const shadeK = def.cockle.amp / 0.35 / (lmm * 2) * (def.cockle.cell / 20);
  for (let j = 1; j < lh - 1; j++) for (let i = 1; i < lw - 1; i++) {
    const k = j * lw + i;
    const gx = tmp[k + 1] - tmp[k - 1], gy = tmp[k + lw] - tmp[k - lw];
    lLum[k] += -(gx * Lx + gy * Ly) * shadeK;
    lH[k] += tmp[k] * 0.5;
  }

  // onionskin crinkle: ridged noise, sharp creases with shading
  if (def.crinkle) {
    // a fine pebbly cockle (the onionskin finish) plus a few soft larger creases
    const C = def.crinkle;
    tmp.fill(0);
    fbm(tmp, lw, lh, C.cell / lmm, 2, 0.5, seed + 31, minCell);
    normalizeField(tmp);
    const cr = new Float32Array(LN);
    for (let i = 0; i < LN; i++) cr[i] = tmp[i] * 0.6;
    const tmp2 = new Float32Array(LN);
    fbm(tmp2, lw, lh, C.big / lmm, 2, 0.5, seed + 37, minCell);
    normalizeField(tmp2);
    for (let i = 0; i < LN; i++) { const v = 1 - Math.min(1, Math.abs(tmp2[i]) * 0.8); cr[i] += 0.8 * v * v * v * v; }
    const ck = C.amp / (lmm * 2) * (C.cell / 3);
    for (let j = 1; j < lh - 1; j++) for (let i = 1; i < lw - 1; i++) {
      const k = j * lw + i;
      const gx = cr[k + 1] - cr[k - 1], gy = cr[k + lw] - cr[k - lw];
      lLum[k] += -(gx * Lx + gy * Ly) * ck;
      lH[k] += cr[k] * C.height;
    }
  }

  // mottling: blotchy colour drift (age, kraft)
  if (def.mottle) {
    tmp.fill(0);
    fbm(tmp, lw, lh, (def.mottleCell || 7) / lmm, 4, 0.55, seed + 41, minCell);
    normalizeField(tmp);
    for (let i = 0; i < LN; i++) { lTint[i] += Math.max(-0.6, tmp[i]) * def.mottle * 0.5; lLum[i] -= tmp[i] * def.mottle * 0.06; }
  }

  // edges: gentle darkening toward the cut edges, irregular for old paper
  for (const v of [def.vignette, def.toning]) {
    if (!v) continue;
    const rough = v.rough || 0;
    for (let j = 0; j < lh; j++) for (let i = 0; i < lw; i++) {
      const k = j * lw + i;
      const x = lowX(i), y = lowY(j);
      let d = Math.min(x, y, Wmm - x, Hmm - y);
      d += rough * (formation[k] * 0.35 + (vnoise(x / 9, y / 9, seed + 5) - 0.5) * 1.6 + (vnoise(x / 2.5, y / 2.5, seed + 6) - 0.5) * 0.8);
      const e = Math.exp(-Math.max(0, d) / v.width);
      lLum[k] -= e * v.amp;
      lTint[k] += e * v.tint;
    }
  }

  // stains: faint tide marks with a darker rim (aged)
  if (def.stains) {
    const rs = rng(seed + 77);
    for (let s = 0; s < def.stains; s++) {
      const cx = lerp(0.12, 0.88, rs()) * Wmm, cy = lerp(0.1, 0.9, rs()) * Hmm;
      const rad = lerp(14, 38, rs()), str = lerp(0.12, 0.3, rs()), sd = (rs() * 1e9) | 0;
      const i0 = Math.max(0, Math.floor((cx - rad * 1.4) / lmm)), i1 = Math.min(lw - 1, Math.ceil((cx + rad * 1.4) / lmm) + 1);
      const j0 = Math.max(0, Math.floor((cy - rad * 1.4) / lmm)), j1 = Math.min(lh - 1, Math.ceil((cy + rad * 1.4) / lmm) + 1);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = lowX(i) - cx, y = lowY(j) - cy;
        const ang = Math.atan2(y, x);
        const rr = rad * (1 + 0.22 * (vnoise(Math.cos(ang) * 1.6 + 5, Math.sin(ang) * 1.6 + 5, sd) - 0.5) + 0.08 * (vnoise(Math.cos(ang) * 6 + 9, Math.sin(ang) * 6 + 9, sd + 1) - 0.5));
        const dist = Math.sqrt(x * x + y * y);
        const q = dist / rr;
        if (q > 1.25) continue;
        const k = j * lw + i;
        const inner = smoothstep(1.02, 0.55, q) * 0.35;
        const rim = Math.exp(-Math.pow((dist - rr) / 0.9, 2)) * (dist < rr ? 1 : 0.4);
        lTint[k] += str * (inner + rim * 1.1);
        lLum[k] -= str * (inner * 0.05 + rim * 0.06);
      }
    }
  }

  const prof = {}; let tp = performance.now();
  const lap = k => { const n = performance.now(); prof[k] = Math.round(n - tp); tp = n; };
  prof.low = Math.round(tp - t0);
  upsampleAdd(lum, W, H, lLum, lw, step, 1);
  upsampleAdd(tint, W, H, lTint, lw, step, 1);

  // ---- full-res fields ----
  // grain (~0.5 mm) and tooth (~0.17 mm): both lighten/darken and give the surface height
  crNoise(W, H, 0.55 * ppmm, seed + 101, lum, def.grain * subPx, fine, 0.6);
  crNoise(W, H, def.toothCell * ppmm, seed + 103, lum, def.tooth * subPx * subPx, fine, 1.0);

  // laid lines (horizontal, ~1 mm) and chain lines (vertical, ~25 mm)
  if (def.laid) {
    const L = def.laid, per = L.period * ppmm;
    const fade = smoothstep(2.5, 4.5, per);
    const wob = new Float32Array(W), mod = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      const xm = x / ppmm;
      wob[x] = (vnoise(xm / 30, 3.3, seed + 201) - 0.5) * 0.5 * per + (vnoise(xm / 7, 1.1, seed + 202) - 0.5) * 0.18 * per;
      mod[x] = 0.6 + 0.8 * vnoise(xm / 11, 7.7, seed + 203);
    }
    const chainX = [];
    const rc = rng(seed + 211);
    for (let cxm = 10 + rc() * 8; cxm < Wmm; cxm += L.chain + (rc() - 0.5) * 1.2) chainX.push({ x: cxm * ppmm, tilt: (rc() - 0.5) * 0.004 });
    const chainW = 0.35 * ppmm, chainS = 1.8 * ppmm;
    for (let y = 0; y < H; y++) {
      const o = y * W;
      const rowMod = 0.75 + 0.5 * vnoise(y / ppmm / 4, 2.2, seed + 204);
      for (let x = 0; x < W; x++) {
        const ph = (y + wob[x]) / per;
        const c = Math.cos(ph * 6.2831853);
        const v = c * c * c; // sharper ribs
        const a = L.amp * mod[x] * rowMod * fade;
        lum[o + x] += v * a * 0.6;
        fine[o + x] += v * 0.9 * fade;
      }
      for (const ch of chainX) {
        const cx = ch.x + ch.tilt * y;
        const x0 = Math.max(0, Math.floor(cx - chainS * 2.5)), x1 = Math.min(W - 1, Math.ceil(cx + chainS * 2.5));
        for (let x = x0; x <= x1; x++) {
          const d = (x + 0.5 - cx);
          const core = Math.exp(-(d * d) / (2 * chainW * chainW));
          const sh = Math.exp(-(d * d) / (2 * chainS * chainS));
          lum[o + x] += (core * 1.0 - sh * 0.35) * L.chainAmp;
          fine[o + x] -= core * 0.6;
        }
      }
    }
  }

  lap('noise');
  // fibres: short, slightly curved strands, lighter (translucent) or darker (shadowed)
  if (def.fibres) {
    const F = def.fibres, rf = rng(seed + 301);
    const n = Math.round(F.dens * Wmm * Hmm);
    const stepL = 0.7;
    for (let k = 0; k < n; k++) {
      let x = rf() * W, y = rf() * H;
      let ang = rf() * Math.PI * 2;
      const len = (F.len[0] + (F.len[1] - F.len[0]) * rf() * rf()) * ppmm;
      const light = rf() < F.light;
      const strength = (0.35 + 0.65 * rf()) * F.amp * subPx * (light ? 1 : -F.dark);
      const curl = gauss(rf) * F.curl / ppmm;
      const steps = Math.max(2, Math.ceil(len / stepL));
      const wide = rf() < 0.12 ? 1.6 : 1; // a few fibre bundles
      let ca = Math.cos(ang), sa = Math.sin(ang);
      const cc = Math.cos(curl), sc = Math.sin(curl);
      const tk = F.tint && !light ? -F.tint * 4 : 0;
      const inv = 1 / (steps - 1);
      for (let s = 0; s < steps; s++) {
        const u = 2 * s * inv - 1, u2 = u * u;
        const v = strength * (1 - 0.85 * u2 * u2) * stepL;
        // bilinear splat into lum, fine (and tint)
        const fx0 = x - 0.5, fy0 = y - 0.5, ix = fx0 | 0, iy = fy0 | 0;
        if (fx0 >= 0 && fy0 >= 0 && ix < W - 1 && iy < H - 1) {
          const fx = fx0 - ix, fy = fy0 - iy, o = iy * W + ix;
          const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
          const lv = v * wide, fv = (v < 0 ? -v : v) * 6 * wide;
          lum[o] += lv * w00; lum[o + 1] += lv * w10; lum[o + W] += lv * w01; lum[o + W + 1] += lv * w11;
          fine[o] += fv * w00; fine[o + 1] += fv * w10; fine[o + W] += fv * w01; fine[o + W + 1] += fv * w11;
          if (tk) { const tv = v * tk; tint[o] += tv * w00; tint[o + 1] += tv * w10; tint[o + W] += tv * w01; tint[o + W + 1] += tv * w11; }
        }
        if (wide > 1) splat(lum, W, H, x - sa * 0.8, y + ca * 0.8, v * 0.5);
        const nca = ca * cc - sa * sc; sa = sa * cc + ca * sc; ca = nca;
        x += ca * stepL; y += sa * stepL;
      }
    }
  }

  // specks: tiny dark bits of dirt or bark (shives in kraft)
  if (def.specks) {
    const S = def.specks, rs = rng(seed + 401);
    const n = Math.round(S.dens * Wmm * Hmm);
    for (let k = 0; k < n; k++) {
      const x = rs() * W, y = rs() * H;
      const radMm = 0.03 + 0.09 * Math.pow(rs(), 2.5);
      const rad = radMm * ppmm;
      const a = -S.amp * (0.4 + 0.6 * rs());
      if (S.tint && rs() < 0.8) {
        // elongated fleck
        const ang = rs() * Math.PI, l = (0.2 + 0.8 * rs()) * ppmm;
        for (let t = -l; t <= l; t += 0.6) blob(lum, W, H, x + Math.cos(ang) * t, y + Math.sin(ang) * t, rad * 0.8, a * 0.35);
        for (let t = -l; t <= l; t += 0.6) blob(tint, W, H, x + Math.cos(ang) * t, y + Math.sin(ang) * t, rad, S.tint * 0.3);
      } else {
        blob(lum, W, H, x, y, rad, a);
      }
    }
  }

  // foxing: clusters of small rust-brown spots (aged)
  if (def.foxing) {
    const rx = rng(seed + 501);
    const per = Math.ceil(def.foxing.count / def.foxing.clusters);
    for (let c = 0; c < def.foxing.clusters; c++) {
      const edge = rx() < 0.6;
      let cx = rx() * Wmm, cy = rx() * Hmm;
      if (edge) { if (rx() < 0.5) cx = rx() < 0.5 ? rx() * 25 : Wmm - rx() * 25; else cy = rx() < 0.5 ? rx() * 25 : Hmm - rx() * 25; }
      const spread = lerp(4, 18, rx());
      for (let k = 0; k < per; k++) {
        const x = (cx + gauss(rx) * spread) * ppmm, y = (cy + gauss(rx) * spread) * ppmm;
        const radMm = 0.12 + 1.3 * Math.pow(rx(), 3);
        const rad = radMm * ppmm;
        const str = lerp(0.25, 0.7, rx());
        const sd = (rx() * 1e9) | 0;
        blob(tint, W, H, x, y, rad, str, sd, 0.9);
        blob(lum, W, H, x, y, rad * 0.8, -0.035 * str, sd, 0.9);
        if (radMm > 0.5) blob(tint, W, H, x + (rx() - 0.5) * rad * 0.4, y + (rx() - 0.5) * rad * 0.4, rad * 0.35, str * 0.6);
      }
    }
  }

  lap('fibres+');
  // ---- compose RGBA ----
  const pixels = new Uint8ClampedArray(N * 4);
  const b = def.base, c2 = def.tone2, wr = def.warm;
  const dr = c2[0] - b[0], dg = c2[1] - b[1], db = c2[2] - b[2];
  for (let i = 0; i < N; i++) {
    const L = lum[i];
    let t = tint[i]; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const o = i * 4;
    pixels[o] = (b[0] + dr * t) * (1 + L * wr[0]);
    pixels[o + 1] = (b[1] + dg * t) * (1 + L * wr[1]);
    pixels[o + 2] = (b[2] + db * t) * (1 + L * wr[2]);
    pixels[o + 3] = 255;
  }

  // ---- tooth (full res, for ink contact) ----
  let s = 0, s2 = 0, cnt = 0;
  for (let i = 0; i < N; i += 13) { s += fine[i]; s2 += fine[i] * fine[i]; cnt++; }
  const mean = s / cnt, sd = Math.sqrt(Math.max(1e-9, s2 / cnt - mean * mean));
  const tooth = new Uint8Array(N);
  const tk = (0.12 * 255) / sd;
  for (let i = 0; i < N; i++) { const v = 128 + (fine[i] - mean) * tk; tooth[i] = v < 0 ? 0 : v > 255 ? 255 : v; }

  // ---- bump map (half res, grey): cockle and creases broad, tooth and fibres fine ----
  const bw = Math.ceil(W / 2), bh = Math.ceil(H / 2);
  const coarse = new Float32Array(bw * bh);
  upsampleAdd(coarse, bw, bh, lH, lw, step / 2, 1);
  const bumpGrey = new Uint8ClampedArray(bw * bh);
  const fk = 0.11 / sd;
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const X = Math.min(W - 2, x * 2), Y = Math.min(H - 2, y * 2), g = Y * W + X;
    const f = (fine[g] + fine[g + 1] + fine[g + W] + fine[g + W + 1]) * 0.25 - mean;
    bumpGrey[y * bw + x] = 128 + (coarse[y * bw + x] * 0.45 + f * fk) * 120;
  }
  lap('out');
  // canvases are made on first use (the page itself only needs the pixel arrays)
  let canvas = null, bump = null;
  return {
    id, scale, W, H, pixels, tooth, bumpGrey, bw, bh, ms: performance.now() - t0, prof,
    get canvas() {
      if (!canvas) { canvas = makeCanvas(W, H); canvas.getContext('2d').putImageData(new ImageData(pixels, W, H), 0, 0); }
      return canvas;
    },
    get bump() {
      if (!bump) {
        bump = makeCanvas(bw, bh);
        const bctx = bump.getContext('2d');
        const img = bctx.createImageData(bw, bh), d = img.data;
        for (let i = 0; i < bumpGrey.length; i++) { const v = bumpGrey[i], o = i * 4; d[o] = d[o + 1] = d[o + 2] = v; d[o + 3] = 255; }
        bctx.putImageData(img, 0, 0);
      }
      return bump;
    },
    get bytes() { return pixels.length + tooth.length + bumpGrey.length + (canvas ? pixels.length : 0) + (bump ? bumpGrey.length * 4 : 0); },
  };
}

// Paper texture without a page (UI swatches, previews). Addition to the SPEC.
export function paperTexture(id, scale = 0.25) {
  const p = getPaper(id, scale);
  return { canvas: p.canvas, bumpCanvas: p.bump, width: p.W, height: p.H, ms: p.ms };
}

// ---------------------------------------------------------------------------------------------
// Glyph masks (cached per face + char + scale)
// ---------------------------------------------------------------------------------------------
const maskCache = new Map();
let gcv = null, gctx = null;

function glyphMask(faceId, ch, scale) {
  const key = faceId + '\u0001' + ch + '\u0001' + scale + '\u0001' + fontEpoch;
  let m = maskCache.get(key);
  if (m) return m;
  const face = FACE[faceId] || FACE.pica;
  const ss = scale < 0.55 ? 4 : scale < 0.95 ? 2 : 1;
  const S = scale * ss;
  const cw = GRID.CW * S, rh = GRID.RH * S;
  const padX = ss * Math.ceil(cw * 0.6 / ss), padT = ss * Math.ceil(rh * 0.6 / ss), padB = ss * Math.ceil(rh * 0.5 / ss);
  const cwI = ss * Math.ceil((Math.ceil(cw) + 2 * padX) / ss), chI = ss * Math.ceil((Math.ceil(rh) + padT + padB) / ss);
  if (!gcv) { gcv = makeCanvas(cwI, chI); gctx = gcv.getContext('2d', { willReadFrequently: true }); }
  if (gcv.width < cwI || gcv.height < chI) { gcv.width = Math.max(gcv.width, cwI); gcv.height = Math.max(gcv.height, chI); gctx = gcv.getContext('2d', { willReadFrequently: true }); }
  gctx.setTransform(1, 0, 0, 1, 0, 0);
  gctx.clearRect(0, 0, gcv.width, gcv.height);
  gctx.fillStyle = '#000';
  gctx.font = `${face.size * S}px "${face.family}", "Courier New", monospace`;
  gctx.textAlign = 'center';
  gctx.textBaseline = 'alphabetic';
  gctx.fillText(ch, padX + cw / 2, padT + rh * 0.74);
  const src = gctx.getImageData(0, 0, cwI, chI).data;
  const w = cwI / ss, h = chI / ss;
  const a = new Float32Array(w * h);
  const inv = 1 / (255 * ss * ss);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let yy = 0; yy < ss; yy++) { const row = ((y * ss + yy) * cwI + x * ss) * 4 + 3; for (let xx = 0; xx < ss; xx++) s += src[row + xx * 4]; }
    a[y * w + x] = s * inv;
  }
  // trim
  let x0 = w, y0 = h, x1 = -1, y1 = -1, sum = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = a[y * w + x];
    if (v > 0.004) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; sum += v; }
  }
  if (x1 < 0) {
    m = { empty: true };
  } else {
    const tw = x1 - x0 + 1, th = y1 - y0 + 1;
    const t = new Float32Array(tw * th);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) t[y * tw + x] = a[(y + y0) * w + x + x0];
    m = { empty: false, a: t, w: tw, h: th, ox: x0 - padX / ss, oy: y0 - padT / ss, sum, nick: undefined };
  }
  if (maskCache.size > 4000) maskCache.clear();
  maskCache.set(key, m);
  return m;
}

// ---------------------------------------------------------------------------------------------
// The machine's personality: constant per typeface + character
// ---------------------------------------------------------------------------------------------
const SHIFTED = new Set('!@#$%^&*()_+{}|:"<>?~');
const CLOSED = new Set('aeobdgpqABDOPQR04689@&%#');
const personaCache = new Map();

function persona(faceId, ch) {
  const key = faceId + '\u0001' + ch;
  let p = personaCache.get(key);
  if (p) return p;
  const r = rng(hash32('persona', faceId, ch));
  const rm = rng(hash32('machine', faceId));
  const capDy = (rm() - 0.6) * 1.6, capDx = (rm() - 0.5) * 0.8, capRot = (rm() - 0.5) * 0.006;
  const isCap = (ch.toUpperCase() === ch && ch.toLowerCase() !== ch) || SHIFTED.has(ch);
  let dx = gauss(r) * 0.55, dy = gauss(r) * 0.65, rot = gauss(r) * 0.012;
  if (r() < 0.14) dx += (r() < 0.5 ? -1 : 1) * (0.8 + r() * 1.0);
  if (r() < 0.16) dy += (r() < 0.5 ? -1 : 1) * (0.9 + r() * 1.1);
  if (r() < 0.10) rot += (r() < 0.5 ? -1 : 1) * (0.015 + r() * 0.02);
  if (isCap) { dx += capDx; dy += capDy; rot += capRot; }
  // slug contact: this character's own tilt plus the whole machine's (worn platen, typebar set)
  const ua = r() * Math.PI * 2, uc = 0.1 + 0.32 * r();
  const ma = rm() * Math.PI * 2, mu = 0.1 + 0.08 * rm();
  const ux = Math.cos(ua) * uc + Math.cos(ma) * mu, uy = Math.sin(ua) * uc + Math.sin(ma) * mu;
  const closed = CLOSED.has(ch);
  p = {
    dx, dy, rot,
    ux: ux / (Math.hypot(ux, uy) || 1), uy: uy / (Math.hypot(ux, uy) || 1), uneven: Math.hypot(ux, uy),
    weight: 0.84 + 0.26 * r(),
    dirt: closed ? r() * ('eaoEO'.includes(ch) ? 1 : 0.55) : 0,
    nick: r() < 0.28 ? { u: r(), amt: 0.35 + 0.45 * r(), rad: 0.7 + 0.8 * r() } : null,
  };
  personaCache.set(key, p);
  return p;
}

function nickFor(m, pers) {
  if (m.nick !== undefined) return m.nick;
  m.nick = null;
  if (pers.nick) {
    const idx = [];
    for (let i = 0; i < m.a.length; i++) if (m.a[i] > 0.6) idx.push(i);
    if (idx.length) {
      const k = idx[Math.min(idx.length - 1, Math.floor(pers.nick.u * idx.length))];
      m.nick = { x: k % m.w, y: Math.floor(k / m.w) };
    }
  }
  return m.nick;
}

// ---------------------------------------------------------------------------------------------
// Strike geometry
// ---------------------------------------------------------------------------------------------
export function strikeRect(st, scale = 1) {
  const cw = GRID.CW * scale, rh = GRID.RH * scale;
  const W = Math.round(GRID.W * scale), H = Math.round(GRID.H * scale);
  let x0 = Math.floor(st.x * cw - cw * 0.5 - 2), x1 = Math.ceil((st.x + 1) * cw + cw * 0.5 + 2);
  let y0 = Math.floor(st.y * rh - rh * 0.45 - 2), y1 = Math.ceil((st.y + 1) * rh + rh * 0.35 + 2);
  x0 = clamp(x0, 0, W); y0 = clamp(y0, 0, H); x1 = clamp(x1, 0, W); y1 = clamp(y1, 0, H);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

function intersect(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}
function union(a, b) {
  if (!a) return b && b.w > 0 && b.h > 0 ? { ...b } : a;
  if (!b || b.w <= 0 || b.h <= 0) return a;
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
}
const touches = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// ---------------------------------------------------------------------------------------------
// Scratch buffers + blur
// ---------------------------------------------------------------------------------------------
const BUF = { n: 0, A: null, B1: null, B2: null, B3: null, T: null };
function bufs(n) {
  if (n > BUF.n) {
    const m = Math.ceil(n * 1.3) + 64;
    BUF.n = m;
    BUF.A = new Float32Array(m); BUF.B1 = new Float32Array(m); BUF.B2 = new Float32Array(m);
    BUF.B3 = new Float32Array(m); BUF.T = new Float32Array(m);
  }
  return BUF;
}
const kernels = new Map();
function kernel(sigma) {
  const key = Math.round(sigma * 40);
  let k = kernels.get(key);
  if (k) return k;
  const sg = key / 40, r = Math.max(1, Math.ceil(sg * 2.6));
  k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sg * sg)); k[i + r] = v; s += v; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  kernels.set(key, k);
  return k;
}
// separable gaussian, zero outside the region
function blur(src, dst, tmp, w, h, sigma) {
  const n = w * h;
  if (sigma < 0.22) { for (let i = 0; i < n; i++) dst[i] = src[i]; return; }
  const k = kernel(sigma), r = (k.length - 1) >> 1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      const i0 = x - r < 0 ? r - x : 0, i1 = x + r >= w ? r + (w - 1 - x) : 2 * r;
      for (let i = i0; i <= i1; i++) s += src[o + x - r + i] * k[i];
      tmp[o + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    const i0 = y - r < 0 ? r - y : 0, i1 = y + r >= h ? r + (h - 1 - y) : 2 * r;
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = i0; i <= i1; i++) s += tmp[(y - r + i) * w + x] * k[i];
      dst[o + x] = s;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Ribbon fabric tile (per scale): plain weave, every crossing a small dome along the thread on
// top, with jittered threads, uneven thickness and ink load. Channel 2 is the ink-load blotching.
// ---------------------------------------------------------------------------------------------
const RT = 256, RTM = RT - 1;
const ribbonTiles = new Map();
function pnoise(x, y, n, seed) { // periodic value noise, lattice n x n
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const x0 = ((ix % n) + n) % n, y0 = ((iy % n) + n) % n, x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
  const a = ihash(x0, y0, seed), b = ihash(x1, y0, seed), c = ihash(x0, y1, seed), d = ihash(x1, y1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function blurWrap(f, n, sigma) {
  if (sigma < 0.2) return;
  const k = kernel(sigma), r = (k.length - 1) >> 1, tmp = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let s = 0; for (let i = -r; i <= r; i++) s += f[y * n + ((x + i + n) % n)] * k[i + r]; tmp[y * n + x] = s;
  }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let s = 0; for (let i = -r; i <= r; i++) s += tmp[((y + i + n) % n) * n + x] * k[i + r]; f[y * n + x] = s;
  }
}
function ribbonTile(scale) {
  let t = ribbonTiles.get(scale);
  if (t) return t;
  const r = rng(hash32('ribbon', Math.round(scale * 1000)));
  const N = Math.max(8, Math.round(RT / (2.2 * scale)));
  const pitch = RT / N;
  const hgt = new Float32Array(RT * RT);
  const wOff = [], fOff = [], wW = [], fW = [], wL = [], fL = [];
  for (let j = 0; j < N; j++) {
    wOff.push(gauss(r) * 0.22 * pitch); fOff.push(gauss(r) * 0.22 * pitch);
    wW.push((0.34 + 0.14 * r()) * pitch); fW.push((0.34 + 0.14 * r()) * pitch);
    wL.push(0.72 + 0.5 * r()); fL.push(0.72 + 0.5 * r());
  }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const warpTop = ((i + j) & 1) === 0;
    const cx = (i + 0.5) * pitch + fOff[i] + gauss(r) * 0.12 * pitch;
    const cy = (j + 0.5) * pitch + wOff[j] + gauss(r) * 0.12 * pitch;
    const along = pitch * (0.6 + 0.25 * r()), across = warpTop ? wW[j] : fW[i];
    const load = (warpTop ? wL[j] : fL[i]) * (0.75 + 0.5 * r());
    const ax = warpTop ? along : across, ay = warpTop ? across : along;
    const sk = gauss(r) * 0.25; // slight skew of each float
    for (let yy = Math.floor(cy - ay - 1); yy <= Math.ceil(cy + ay + 1); yy++) {
      for (let xx = Math.floor(cx - ax - 1); xx <= Math.ceil(cx + ax + 1); xx++) {
        let dx = (xx + 0.5 - cx), dy = (yy + 0.5 - cy);
        if (warpTop) dy -= dx * sk; else dx -= dy * sk;
        dx /= ax; dy /= ay;
        const q = dx * dx + dy * dy;
        if (q >= 1) continue;
        const v = load * Math.sqrt(1 - q);
        const idx = ((yy % RT + RT) % RT) * RT + ((xx % RT + RT) % RT);
        if (v > hgt[idx]) hgt[idx] = v;
      }
    }
  }
  const weave = new Float32Array(RT * RT), load = new Float32Array(RT * RT);
  const hseed = (r() * 4294967296) >>> 0;
  const hn = Math.max(4, Math.round(RT / Math.max(1, 0.9 * scale)));
  for (let y = 0; y < RT; y++) for (let x = 0; x < RT; x++) {
    const i = y * RT + x;
    const hair = pnoise(x * hn / RT, y * hn / RT, hn, hseed);
    weave[i] = smoothstep(0.08, 0.7, hgt[i]) * (0.7 + 0.6 * hair);
  }
  blurWrap(weave, RT, 0.32 * pitch);
  let m = 0;
  for (let i = 0; i < weave.length; i++) m += weave[i];
  m /= weave.length;
  for (let i = 0; i < weave.length; i++) weave[i] /= m;
  // ink-load blotches at two sizes (~0.4 mm and ~1.4 mm), unit sd
  const n1 = Math.max(2, Math.round(RT / (4 * scale))), n2 = Math.max(2, Math.round(RT / (13 * scale)));
  const s1 = (r() * 4294967296) >>> 0, s2 = (r() * 4294967296) >>> 0;
  for (let y = 0; y < RT; y++) for (let x = 0; x < RT; x++) {
    load[y * RT + x] = (pnoise(x * n1 / RT, y * n1 / RT, n1, s1) - 0.5) * 0.9 + (pnoise(x * n2 / RT, y * n2 / RT, n2, s2) - 0.5) * 1.2;
  }
  normalizeField(load);
  t = { weave, load, pitch };
  ribbonTiles.set(scale, t);
  return t;
}

// Paper wick tile (per scale): a dense mat of fine fibres the fresh ink creeps along.
const WT = 512, WTM = WT - 1;
const wickTiles = new Map();
function wickTile(scale) {
  if (scale < 0.45) return null;
  let t = wickTiles.get(scale);
  if (t) return t;
  const r = rng(hash32('wick', Math.round(scale * 1000)));
  const ppmm = (240 / 25.4) * scale;
  const f = new Float32Array(WT * WT);
  const n = Math.round(3.2 * (WT / ppmm) * (WT / ppmm));
  for (let k = 0; k < n; k++) {
    let x = r() * WT, y = r() * WT, ang = r() * Math.PI * 2;
    const len = (0.2 + 1.1 * r() * r()) * ppmm, curl = gauss(r) * 0.5 / ppmm, a = 0.5 + 0.5 * r();
    for (let s = 0; s < len; s += 0.6) {
      const xx = ((Math.floor(x) % WT) + WT) % WT, yy = ((Math.floor(y) % WT) + WT) % WT;
      f[yy * WT + xx] += a;
      ang += curl; x += Math.cos(ang) * 0.6; y += Math.sin(ang) * 0.6;
    }
  }
  blurWrap(f, WT, 0.5);
  for (let i = 0; i < f.length; i++) f[i] = 1 - Math.exp(-f[i] * 1.1);
  wickTiles.set(scale, f);
  return f;
}

// ---------------------------------------------------------------------------------------------
// One impression
// ---------------------------------------------------------------------------------------------
const pressureDensity = p => { p = clamp(p, 0.2, 1.6); return 1.1 * (1 - Math.exp(-1.9 * p)) / (1 - Math.exp(-1.9 * 1.5)); };
const refArea = new Map();
function areaFactor(face, scale, m) {
  const key = face + '@' + scale + '@' + fontEpoch;
  let ref = refArea.get(key);
  if (ref === undefined) { const n = glyphMask(face, 'n', scale); ref = n.empty ? m.sum : n.sum; refArea.set(key, ref); }
  return clamp(Math.pow(ref / Math.max(1e-6, m.sum), 0.14), 0.86, 1.3);
}

// Resample the glyph mask into A over the returned region; null if nothing to draw.
function placeGlyph(st, scale, clip, W, H, margin) {
  const face = FACE[st.f] ? st.f : 'pica';
  const ch = st.c == null ? '' : String(st.c);
  if (!ch || ch.trim() === '') return null; // spaces (incl. no-break) leave no mark
  const m = glyphMask(face, ch, scale);
  if (m.empty) return null;
  const pers = persona(face, ch);
  const r = rng((st.s >>> 0) ^ 0x5bd1e995);
  const s = scale, cw = GRID.CW * s, rh = GRID.RH * s;
  const X0 = st.x * cw, Y0 = st.y * rh;
  const dx = (pers.dx + gauss(r) * 0.4) * s, dy = (pers.dy + gauss(r) * 0.45) * s;
  const th = pers.rot + gauss(r) * 0.006;
  const co = Math.cos(th), si = Math.sin(th);
  const pvx = X0 + cw * 0.5, pvy = Y0 + rh * 0.55;
  const MX = X0 + m.ox, MY = Y0 + m.oy;
  // forward transform of mask corners -> page bbox
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const [qx, qy] of [[MX, MY], [MX + m.w, MY], [MX, MY + m.h], [MX + m.w, MY + m.h]]) {
    const px = co * (qx - pvx) - si * (qy - pvy) + pvx + dx, py = si * (qx - pvx) + co * (qy - pvy) + pvy + dy;
    if (px < bx0) bx0 = px; if (px > bx1) bx1 = px; if (py < by0) by0 = py; if (py > by1) by1 = py;
  }
  let reg = { x: Math.floor(bx0 - margin), y: Math.floor(by0 - margin), w: 0, h: 0 };
  reg.w = Math.ceil(bx1 + margin) - reg.x; reg.h = Math.ceil(by1 + margin) - reg.y;
  reg = intersect(reg, strikeRect(st, scale));
  reg = intersect(reg, { x: 0, y: 0, w: W, h: H });
  // compute over the full (unclipped) region so a clipped redraw gives identical pixels
  if (reg.w <= 0 || reg.h <= 0) return null;
  const out = clip ? intersect(reg, clip) : reg;
  if (out.w <= 0 || out.h <= 0) return null;
  const n = reg.w * reg.h;
  const B = bufs(n);
  const A = B.A, ma = m.a, mw = m.w, mh = m.h;
  const nk = pers.nick ? nickFor(m, pers) : null;
  const nkr = nk ? pers.nick.rad * s * (s < 1 ? 1.4 : 1) : 0, nka = nk ? pers.nick.amt : 0;
  const nk2 = nk ? 1 / (2 * nkr * nkr) : 0;
  for (let y = 0; y < reg.h; y++) {
    const py = reg.y + y + 0.5 - pvy - dy;
    const px0 = reg.x + 0.5 - pvx - dx;
    let qx = co * px0 + si * py + pvx - MX - 0.5;
    let qy = -si * px0 + co * py + pvy - MY - 0.5;
    const o = y * reg.w;
    for (let x = 0; x < reg.w; x++, qx += co, qy -= si) {
      const ix = Math.floor(qx), iy = Math.floor(qy);
      let v = 0;
      if (ix >= -1 && iy >= -1 && ix < mw && iy < mh) {
        const fx = qx - ix, fy = qy - iy;
        const k = iy * mw + ix;
        const okx0 = ix >= 0, okx1 = ix + 1 < mw, oky0 = iy >= 0, oky1 = iy + 1 < mh;
        const a00 = okx0 && oky0 ? ma[k] : 0, a10 = okx1 && oky0 ? ma[k + 1] : 0;
        const a01 = okx0 && oky1 ? ma[k + mw] : 0, a11 = okx1 && oky1 ? ma[k + mw + 1] : 0;
        v = (a00 + (a10 - a00) * fx) * (1 - fy) + (a01 + (a11 - a01) * fx) * fy;
        if (nk && v > 0) {
          const ddx = qx - nk.x, ddy = qy - nk.y;
          v *= 1 - nka * Math.exp(-(ddx * ddx + ddy * ddy) * nk2);
        }
      }
      A[o + x] = v;
    }
  }
  // glyph centre on the page
  const gcx = co * (MX + m.w / 2 - pvx) - si * (MY + m.h / 2 - pvy) + pvx + dx;
  const gcy = si * (MX + m.w / 2 - pvx) + co * (MY + m.h / 2 - pvy) + pvy + dy;
  return { reg, out, pers, r, gcx, gcy, ch, face, m };
}

function drawStrike(data, W, H, paper, st, scale, clip) {
  const s = scale;
  const p = st.p == null ? 1 : st.p;
  const wear = clamp(st.w == null ? 0 : st.w, 0, 1);
  const fresh = 1 - wear;
  const sig1 = (0.42 + 0.22 * clamp(p, 0.3, 1.5)) * s;
  const sig2 = (1.25 + 0.45 * clamp(p, 0.3, 1.5)) * s;
  const margin = Math.ceil(sig2 * 2.6 + 1.5);
  const g = placeGlyph(st, scale, clip, W, H, margin);
  if (!g) return null;
  const { reg, out, pers, r } = g;
  const rw = reg.w, rhh = reg.h;
  const B = bufs(rw * rhh);
  const A = B.A, B1 = B.B1, B2 = B.B2, B3 = B.B3, T = B.T;
  blur(A, B1, T, rw, rhh, sig1);
  blur(A, B2, T, rw, rhh, sig2);

  // dirty slug: heavy fresh strikes on closed letters partly fill their counters
  let fill = 0;
  if (pers.dirt > 0) {
    const roll = r();
    fill = pers.dirt * fresh * smoothstep(0.85, 1.35, p) * (roll < 0.45 ? 0.3 : roll < 0.8 ? 0.65 : 1.0);
    if (fill > 0.04) blur(A, B3, T, rw, rhh, 2.3 * s); else fill = 0;
  }

  const inkDef = INK_T[st.k] || INK_T.k;
  // wear: lighter and greyer (absorbances pulled toward their mean)
  const ab = inkDef.T.map(t => -Math.log(t));
  const am = (ab[0] + ab[1] + ab[2]) / 3;
  const desat = 0.55 * wear;
  const ar = lerp(ab[0], am, desat), ag = lerp(ab[1], am, desat), abl = lerp(ab[2], am, desat);
  const Pc = pressureDensity(p) * pers.weight * areaFactor(g.face, scale, g.m); // how hard the slug meets the paper
  const P = Pc * (1 - 0.45 * wear - 0.25 * wear * wear);                          // how much ink it leaves
  // slug contact unevenness (personality + strike)
  const ua = Math.atan2(pers.uy, pers.ux) + gauss(r) * 0.6;
  const uneven = pers.uneven * (1 + 0.9 * clamp(1 - p, 0, 0.7)) * (0.75 + 0.5 * r());
  const ux = Math.cos(ua) * uneven / (GRID.RH * 0.3 * s), uy = Math.sin(ua) * uneven / (GRID.RH * 0.3 * s);
  // ribbon fabric and ink load: a random window of the ribbon tile
  const rt = ribbonTile(scale);
  const weave = rt.weave, load = rt.load;
  const weaveFade = smoothstep(1.0, 1.9, rt.pitch);
  const wAmp = (0.42 + 0.4 * wear) * weaveFade;
  const wMax = 1.9 - 0.5 * wear;
  const tox = (r() * RT) | 0, toy = (r() * RT) | 0;
  const pAmp = (0.09 + 0.3 * wear) * smoothstep(0.25, 0.7, s);
  const gapT = wear > 0.5 ? (wear - 0.5) * 1.1 : 0;
  // paper: absorbency, tooth
  const absorb = PAPER_DEFS[paper.id].wick ?? 1;
  const wick = wickTile(scale);
  const halo = 0.2 * inkDef.bleed * absorb * (0.3 + 0.7 * fresh) * smoothstep(0.35, 0.9, s * 1.2);
  const ragK = 0.9 * smoothstep(0.45, 0.9, s);
  const squeeze = 0.22 * fresh;
  const toothFade = smoothstep(0.3, 0.8, s);
  const contactBias = (Pc - 0.46) * 0.95;
  const tooth = paper.tooth;
  const gcx = g.gcx, gcy = g.gcy;

  const x0 = out.x - reg.x, y0 = out.y - reg.y, x1 = x0 + out.w, y1 = y0 + out.h;
  for (let y = y0; y < y1; y++) {
    const py = reg.y + y;
    const rowI = y * rw;
    const trow = ((py + toy) & RTM) * RT, wrow = (py & WTM) * WT;
    for (let x = x0; x < x1; x++) {
      const i = rowI + x;
      const b2 = B2[i], b1 = B1[i];
      if (b2 < 0.004 && b1 < 0.004) continue;
      const a = A[i];
      const px = reg.x + x;
      const gi = py * W + px;
      const t = (tooth[gi] - 128) * (1 / 255) * toothFade;
      const wk = wick ? wick[wrow + (px & WTM)] : 0.3;
      const ti = trow + ((px + tox) & RTM);
      let wm = 1 + wAmp * (weave[ti] - 1);
      if (wm > wMax) wm = wMax;
      const pn = load[ti];
      let pm = 1 + pAmp * pn;
      if (gapT > 0) pm *= 0.2 + 0.8 * smoothstep(gapT - 0.1, gapT + 0.45, 0.55 + 0.22 * pn + 0.3 * (wm - 1));
      // uneven slug
      let um = 1 + (px - gcx) * ux + (py - gcy) * uy;
      if (um < 0.1) um = 0.1; else if (um > 1.4) um = 1.4;
      // ragged outline: the edge moves with the paper tooth and fibres
      let core = b1 + ragK * (t * 1.5 + (wk - 0.3) * 0.45 * absorb) * 4 * b1 * (1 - b1);
      core = core < 0 ? 0 : core > 1 ? 1 : core;
      // contact with the paper surface (light strikes only catch the high spots)
      const ctc = smoothstep(-0.3, 0.16, t + contactBias * um + (core - 0.5) * 0.25);
      let d = core * wm * pm * um * ctc * (1 + 0.7 * t);
      // ink squeezed to the rim: the middle of a broad inked area is a touch lighter
      if (b2 > 0.72) d *= 1 - squeeze * smoothstep(0.72, 0.97, b2);
      // bleed creeping along the fibres around the stroke
      const out2 = b2 - a > 0 ? b2 - a : 0;
      d += halo * out2 * (0.12 + 1.9 * wk) * pm;
      if (fill > 0) { const f = B3[i]; if (f > 0.3 && a < 0.95) d += fill * smoothstep(0.32, 0.62, f) * (1 - a) * 0.75 * wm; }
      d *= P;
      if (d < 0.003) continue;
      const o = gi * 4;
      data[o] = data[o] * Math.exp(-d * ar);
      data[o + 1] = data[o + 1] * Math.exp(-d * ag);
      data[o + 2] = data[o + 2] * Math.exp(-d * abl);
    }
  }
  return out;
}

// A lifted-off strike: chalky patch where the tape lifted, a whisper of grey, and the dent.
function drawGhost(data, W, H, paper, st, scale, clip) {
  const s = scale;
  const margin = Math.ceil(3 * s + 2);
  const g = placeGlyph(st, scale, null, W, H, margin);
  if (!g) return null;
  const { reg, r } = g;
  // the tape patch: a soft rounded rectangle around the cell
  const cw = GRID.CW * s, rh = GRID.RH * s;
  const pcx = (st.x + 0.5) * cw + gauss(r) * 0.6 * s, pcy = (st.y + 0.52) * rh + gauss(r) * 0.6 * s;
  const phw = cw * 0.56, phh = rh * 0.44, feather = 2.2 * s + 0.6;
  // patch region may be wider than the glyph region; work in the union
  let preg = { x: Math.floor(pcx - phw - feather * 2), y: Math.floor(pcy - phh - feather * 2), w: 0, h: 0 };
  preg.w = Math.ceil(pcx + phw + feather * 2) - preg.x; preg.h = Math.ceil(pcy + phh + feather * 2) - preg.y;
  preg = intersect(preg, strikeRect(st, scale));
  let reg2 = union(reg, preg);
  reg2 = intersect(reg2, { x: 0, y: 0, w: W, h: H });
  const out = clip ? intersect(reg2, clip) : reg2;
  if (out.w <= 0 || out.h <= 0) return null;
  const rw = reg.w, rhh = reg.h;
  const B = bufs(rw * rhh);
  blur(B.A, B.B1, B.T, rw, rhh, 0.9 * s);
  blur(B.A, B.B2, B.T, rw, rhh, 1.3 * s);
  const A = B.A, B1 = B.B1, B2 = B.B2;
  const grey = 0.045 * (st.p == null ? 1 : clamp(st.p, 0.3, 1.5)) * (1 - 0.4 * clamp(st.w || 0, 0, 1));
  const absK = [-Math.log(0.42), -Math.log(0.41), -Math.log(0.40)];
  const ink = INK_T[st.k] || INK_T.k;
  const ia = ink.T.map(t => -Math.log(t));
  const iam = (ia[0] + ia[1] + ia[2]) / 3;
  const tintAbs = [0, 1, 2].map(c => absK[c] + (ia[c] - iam) * 0.08);
  const Lx = -0.55, Ly = -0.83;
  const dent = 0.16 * clamp(st.p == null ? 1 : st.p, 0.3, 1.5) * smoothstep(0.35, 0.9, s);
  const lift = 0.06;
  const rs = (st.s >>> 0) ^ 0x2545f491;
  for (let py = out.y; py < out.y + out.h; py++) {
    for (let px = out.x; px < out.x + out.w; px++) {
      const gi = py * W + px, o = gi * 4;
      // patch
      const qx = Math.abs(px + 0.5 - pcx) - phw, qy = Math.abs(py + 0.5 - pcy) - phh;
      const rr = Math.min(phw, phh) * 0.35;
      const dd = Math.hypot(Math.max(qx + rr, 0), Math.max(qy + rr, 0)) + Math.min(Math.max(qx + rr, qy + rr), 0) - rr;
      const pa = smoothstep(feather, -feather, dd);
      if (pa > 0.002) {
        const ch = 0.75 + 0.5 * vnoise(px * 0.7 / s, py * 0.7 / s, rs);
        const k = lift * pa * ch;
        data[o] += (255 - data[o]) * k;
        data[o + 1] += (255 - data[o + 1]) * k;
        data[o + 2] += (250 - data[o + 2]) * k;
      }
      // glyph trace + dent
      const lx = px - reg.x, ly = py - reg.y;
      if (lx < 1 || ly < 1 || lx >= rw - 1 || ly >= rhh - 1) continue;
      const i = ly * rw + lx;
      const b1 = B1[i];
      if (b1 < 0.004 && B2[i] < 0.004) continue;
      let d = b1 * grey;
      if (A[i] > 0.45 && ihash(px, py, rs) > 0.93) d += 0.07 * A[i];
      const gx = B2[i + 1] - B2[i - 1], gy = B2[i + rw] - B2[i - rw];
      // dent (height = -B2): surface normal ~ (gx, gy, 1); walls facing the light (top left)
      // are brighter, so the upper-left inner edge sits in shadow and the lower-right catches light
      const shade = (gx * Lx + gy * Ly) * dent;
      const f = 1 + shade;
      data[o] = data[o] * Math.exp(-d * tintAbs[0]) * f;
      data[o + 1] = data[o + 1] * Math.exp(-d * tintAbs[1]) * f;
      data[o + 2] = data[o + 2] * Math.exp(-d * tintAbs[2]) * f;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// PageSurface
// ---------------------------------------------------------------------------------------------
export class PageSurface {
  constructor({ paper = 'ivory', scale = 1 } = {}) {
    this.scale = scale;
    this.width = Math.round(GRID.W * scale);
    this.height = Math.round(GRID.H * scale);
    this.canvas = makeCanvas(this.width, this.height);
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.version = 0;
    this._dirty = null;
    this._strikes = [];
    this._ghosts = [];
    this._img = new ImageData(this.width, this.height);
    this.stats = { paperMs: 0, lastRenderMs: 0, adds: 0, addMs: 0 };
    this.paper = null;
    this.setPaper(paper);
  }

  get paperCanvas() { return this._paper.canvas; }
  get bumpCanvas() { return this._paper.bump; }
  // The ImageData behind the canvas (addition): lets the 3D side upload a dirty band straight
  // from memory (texSubImage2D with UNPACK_ROW_LENGTH) instead of re-reading the canvas.
  get imageData() { return this._img; }

  setPaper(id) {
    if (!PAPER_DEFS[id]) id = 'ivory';
    this._paper = getPaper(id, this.scale);
    this.stats.paperMs = this._paper.ms;
    this.paper = id;
    this._paint(this._strikes, this._ghosts);
  }

  render(strikes, ghosts = []) {
    this._strikes = (strikes || []).filter(s => !s.g);
    this._ghosts = (ghosts || []).concat((strikes || []).filter(s => s.g));
    this._paint(this._strikes, this._ghosts);
  }

  _paint(strikes, ghosts) {
    const t0 = performance.now();
    const data = this._img.data;
    data.set(this._paper.pixels);
    const { width: W, height: H, scale } = this;
    for (const g of ghosts) drawGhost(data, W, H, this._paper, g, scale, null);
    for (const s of strikes) drawStrike(data, W, H, this._paper, s, scale, null);
    this.ctx.putImageData(this._img, 0, 0);
    this.stats.lastRenderMs = performance.now() - t0;
    this._mark({ x: 0, y: 0, w: W, h: H });
  }

  add(strike) {
    const t0 = performance.now();
    const { width: W, height: H, scale } = this;
    let rect;
    if (strike.g) {
      this._ghosts.push(strike);
      rect = drawGhost(this._img.data, W, H, this._paper, strike, scale, null);
    } else {
      this._strikes.push(strike);
      rect = drawStrike(this._img.data, W, H, this._paper, strike, scale, null);
    }
    if (rect && rect.w > 0 && rect.h > 0) this.ctx.putImageData(this._img, 0, 0, rect.x, rect.y, rect.w, rect.h);
    else rect = { x: 0, y: 0, w: 0, h: 0 };
    this._mark(rect);
    this.stats.adds++; this.stats.addMs += performance.now() - t0;
    return rect;
  }

  redraw(rect, strikes = this._strikes, ghosts = this._ghosts) {
    const { width: W, height: H, scale } = this;
    const r = intersect({ x: Math.floor(rect.x), y: Math.floor(rect.y), w: Math.ceil(rect.w), h: Math.ceil(rect.h) }, { x: 0, y: 0, w: W, h: H });
    if (r.w <= 0 || r.h <= 0) return;
    const allS = (strikes || []).filter(s => !s.g), allG = (ghosts || []).concat((strikes || []).filter(s => s.g));
    const inS = allS.filter(s => touches(strikeRect(s, scale), r));
    const inG = allG.filter(s => touches(strikeRect(s, scale), r));
    // keep what we know in sync (works whether the caller passes full lists or just the region's)
    if (strikes !== this._strikes) this._strikes = this._strikes.filter(s => !touches(strikeRect(s, scale), r)).concat(inS);
    if (ghosts !== this._ghosts) this._ghosts = this._ghosts.filter(s => !touches(strikeRect(s, scale), r)).concat(inG);
    const data = this._img.data, px = this._paper.pixels;
    for (let y = r.y; y < r.y + r.h; y++) {
      const o = (y * W + r.x) * 4;
      data.set(px.subarray(o, o + r.w * 4), o);
    }
    for (const g of inG) drawGhost(data, W, H, this._paper, g, scale, r);
    for (const s of inS) drawStrike(data, W, H, this._paper, s, scale, r);
    this.ctx.putImageData(this._img, 0, 0, r.x, r.y, r.w, r.h);
    this._mark(r);
  }

  takeDirty() {
    const d = this._dirty;
    this._dirty = null;
    return d;
  }

  _mark(rect) {
    this.version++;
    if (rect && rect.w > 0 && rect.h > 0) this._dirty = union(this._dirty, rect);
  }

  dispose() {
    this._img = null; this._strikes = []; this._ghosts = [];
    this.canvas.width = this.canvas.height = 1;
  }
}
