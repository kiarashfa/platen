// art.js: Draw-mode conversion for Platen. Pictures, shapes and banners -> strikes.
// Pure functions. The canvas is only used to measure how dark each glyph prints (and to draw the
// built-in SAMPLES). Under Node the measured tables below are used instead (or pass `measure`).
//
// A strike here is { c, x, y, k, p, f } (cell position in page cells, ink id, pressure, typeface);
// the app adds the seed `s` and the ribbon wear `w` when it types them.

import { clamp, rng } from './util.js';

// Mirror of ink.js GRID (kept here so this module has no dependency on the renderer).
export const PAGE = { COLS: 85, ROWS: 66, CW: 24, RH: 40, W: 2040, H: 2640 };
export const CELL_W = 0.6;               // cell width / line height (10 pitch, 6 lpi)
export const FAMILIES = { pica: 'Courier Prime', elite: 'Special Elite', cutive: 'Cutive Mono' };
export const PRESSURE = { light: 0.7, normal: 1.0, heavy: 1.3 };
export const STRIKES_PER_SEC = 6;        // the machine typing art at real speed
export const SECS_PER_LINE = 1;          // carriage return, line feed and the spaces to the first strike

// Characters offered in the Planner's glyph palette ('auto' picks by stroke direction).
export const PALETTE = ['auto', '#', '@', '*', '+', 'x', 'o', 'O', '%', '&', '$', '=', '-', '_', '.', ':',
  ';', ',', "'", '"', '|', '/', '\\', '(', ')', '<', '>', '^', '~', 'X', 'M', 'W', '8'];

// ---------------------------------------------------------------------------------------------
// Glyph darkness: measurement and ramps
// ---------------------------------------------------------------------------------------------

// Singles considered for tone. Tier A are the classic typewriter-art characters (preferred),
// tier C read as text or have a lopsided shape (only used when nothing else is close).
const TONE_SINGLES = ['.', ',', "'", ':', ';', '-', '~', '=', '+', '^', '"', '*', 'i', 'c', 'v', 'o',
  'x', 'e', 'z', 's', 'a', 'O', '0', 'X', '8', '%', '&', '$', '#', '@', 'M', 'W', 'N', 'H', 'B',
  'Q', 'R', 'D', 'K', 'E'];
const TIER_A = new Set(['.', ':', '-', '=', '+', '*', 'o', 'x', '%', '#', '@', 'O', 'X', '8', 'M', 'W']);
const TIER_C = new Set(['i', 'c', 'v', 'e', 'z', 's', 'a', 'Q', 'R', 'D', 'K', 'E', '^', '"', '~']);
// Characters stacked (overstruck) for the darkest tones.
export const STACK_BASE = ['#', '@', 'M', 'W', 'N', 'H', 'B', '8', '%', '&', '$', 'X', 'O', '0', '=', '+', 'o', 'x', '*', '-', ':'];
// Dots used by the stipple style.
const DOTS = ['.', ':', ',', ';', "'"];

const tierPenalty = glyphs => glyphs.reduce((s, g) => s + (TIER_A.has(g) ? 0 : TIER_C.has(g) ? 0.03 : 0.012), 0);

// Measures how dark a stack of glyphs prints in one cell with the real typeface, mirroring the
// ink renderer: glyph size from the face's measured advance, centred, baseline at 0.74 of the
// line, and overstrikes adding ink density (Beer-Lambert, black ribbon keeps ~12% of the light).
// Returns the mean absorbed light over one cell area (ink spilling outside the cell counts too).
export function canvasMeasurer(family, { scale = 2, keep = 0.125 } = {}) {
  const cw = PAGE.CW * scale, rh = PAGE.RH * scale, padX = cw, padY = rh;
  const W = cw + 2 * padX, H = rh + 2 * padY;
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H)
    : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.font = `100px "${family}", "Courier New", monospace`;
  let adv = 0;
  for (const ch of 'MWimn0') adv += ctx.measureText(ch).width / 100 / 6;
  if (!(adv > 0.3 && adv < 1)) adv = CELL_W;
  const size = (PAGE.CW / adv) * scale;
  const k = -Math.log(keep);
  const acc = new Float32Array(W * H);
  const drawOne = g => {
    ctx.clearRect(0, 0, W, H);
    ctx.font = `${size}px "${family}", "Courier New", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#000';
    ctx.fillText(g, padX + cw / 2, padY + 0.74 * rh);
    const d = ctx.getImageData(0, 0, W, H).data;
    for (let i = 0, p = 3; i < acc.length; i++, p += 4) acc[i] += d[p] / 255;
  };
  const fn = glyphs => {
    acc.fill(0);
    for (const g of glyphs) drawOne(g);
    let s = 0;
    for (let i = 0; i < acc.length; i++) if (acc[i] > 0) s += 1 - Math.exp(-k * acc[i]);
    return s / (cw * rh) / (1 - keep);
  };
  fn.advance = adv;
  // Darkness on a 3 x 5 grid over the cell (for shape-aware choices).
  fn.map = glyphs => {
    acc.fill(0);
    for (const g of glyphs) drawOne(g);
    const out = new Array(15).fill(0);
    for (let y = 0; y < rh; y++) for (let x = 0; x < cw; x++) {
      const bx = Math.min(2, Math.floor(x * 3 / cw)), by = Math.min(4, Math.floor(y * 5 / rh));
      const a = acc[(y + padY) * W + x + padX];
      if (a > 0) out[by * 3 + bx] += (1 - Math.exp(-k * a)) / (1 - keep);
    }
    const area = (cw / 3) * (rh / 5);
    return out.map(v => +(v / area).toFixed(3));
  };
  return fn;
}

// Builds a light -> dark ramp from a measure function (glyph stack -> coverage).
// Level 0 is the blank cell. density is normalised so the darkest level is 1.
// Every glyph stack the ramp builder may consider (singles, pairs, triples of the darkest).
// `darkOrder` (optional) is STACK_BASE sorted dark -> light for the typeface.
export function rampCandidates(darkOrder) {
  const out = TONE_SINGLES.map(c => [c]);
  const base = darkOrder || STACK_BASE;
  for (let i = 0; i < base.length; i++) for (let j = i + 1; j < base.length; j++) out.push([base[i], base[j]]);
  const dark = darkOrder ? base.slice(0, 9) : ['#', '@', 'M', 'W', 'N', 'H', 'B', '8', '%', '&', '$'];
  for (let i = 0; i < dark.length; i++) for (let j = i + 1; j < dark.length; j++) for (let k = j + 1; k < dark.length; k++) out.push([dark[i], dark[j], dark[k]]);
  return out;
}

export function buildRamp(measure, { levels = 15, curve = 1.0 } = {}) {
  const cands = [];
  const single = new Map();
  for (const c of TONE_SINGLES) {
    const v = measure([c]);
    single.set(c, v);
    cands.push({ glyphs: [c], cov: v });
  }
  const base = STACK_BASE.filter(c => single.has(c)).sort((a, b) => single.get(b) - single.get(a));
  for (const g of rampCandidates(base)) if (g.length > 1) cands.push({ glyphs: g, cov: measure(g) });
  const max = Math.max(...cands.map(c => c.cov));
  for (const c of cands) c.d = c.cov / max;
  const picked = [];
  let prev = 0;
  for (let i = 1; i < levels; i++) {
    const t = Math.pow(i / (levels - 1), curve);
    let best = null, bestScore = Infinity;
    for (const c of cands) {
      if (c.d <= prev + 0.35 / levels * Math.min(1, t * 4) + 0.004) continue;
      const score = Math.abs(c.d - t) + (c.glyphs.length - 1) * 0.02 + tierPenalty(c.glyphs);
      if (score < bestScore) { bestScore = score; best = c; }
    }
    if (!best) break;
    picked.push(best);
    prev = best.d;
  }
  const top = picked.length ? picked[picked.length - 1].cov : 1;
  const ramp = [{ glyphs: [], density: 0, cov: 0 }]
    .concat(picked.map(c => ({ glyphs: c.glyphs, density: +(c.cov / top).toFixed(4), cov: +c.cov.toFixed(5) })));
  ramp.singles = Object.fromEntries([...single].map(([k, v]) => [k, +v.toFixed(5)]));
  for (const c of DOTS) if (!(c in ramp.singles)) ramp.singles[c] = +measure([c]).toFixed(5);
  return ramp;
}

// Measured in Chromium with the real web fonts by tools/art-measure.mjs (do not edit by hand).
// @@FALLBACK-BEGIN
const FALLBACK = {
  pica: {
    ramp: [[[], 0], [["."], 0.0942], [["-"], 0.1644], [[";"], 0.2322], [["*"], 0.2857], [["*","-"], 0.3463], [["o"], 0.4133], [["O"], 0.4971], [["X"], 0.5734], [["W"], 0.6553], [["M","*"], 0.7124], [["X","x"], 0.7845], [["@","O"], 0.8486], [["@","W"], 0.9159], [["@","W","X"], 1]],
    top: 0.62448,
    singles: { ".": 0.05884, ":": 0.11536, ",": 0.09537, ";": 0.14498, "'": 0.0783, "-": 0.10266, "_": 0.13501, "|": 0.1558, "/": 0.19514, "\\": 0.19393, "(": 0.19629, ")": 0.21744, "+": 0.16671, "*": 0.17841, "o": 0.25812, "x": 0.28873, "#": 0.3499, "@": 0.42539 },
  },
  elite: {
    ramp: [[[], 0], [["'"], 0.0743], [["."], 0.14], [[":"], 0.2218], [["="], 0.3029], [["o"], 0.3582], [["x"], 0.4113], [["H"], 0.5001], [["M"], 0.5883], [["%"], 0.6399], [["M","x"], 0.7142], [["%","o"], 0.786], [["%","O"], 0.8442], [["%","M"], 0.899], [["%","M","$"], 1]],
    top: 0.74339,
    singles: { ".": 0.1041, ":": 0.16488, ",": 0.14956, ";": 0.22836, "'": 0.05525, "-": 0.11816, "_": 0.10418, "|": 0.14456, "/": 0.166, "\\": 0.16943, "(": 0.138, ")": 0.16296, "+": 0.14606, "*": 0.18893, "o": 0.26629, "x": 0.30572, "#": 0.33626, "@": 0.40007 },
  },
  cutive: {
    ramp: [[[], 0], [["-"], 0.082], [["="], 0.1529], [["=","-"], 0.2208], [["*","-"], 0.2835], [["0"], 0.3543], [["8"], 0.4279], [["%"], 0.5105], [["M","-"], 0.5735], [["M","x"], 0.6451], [["@","o"], 0.7162], [["M","#"], 0.7898], [["@","M"], 0.8556], [["@","%","#"], 0.9311], [["@","M","W"], 1]],
    top: 0.55551,
    singles: { ".": 0.03047, ":": 0.05484, ",": 0.03948, ";": 0.06862, "'": 0.04248, "-": 0.04556, "_": 0.05538, "|": 0.12687, "/": 0.12678, "\\": 0.11582, "(": 0.12223, ")": 0.1169, "+": 0.10478, "*": 0.1362, "o": 0.17741, "x": 0.18199, "#": 0.25679, "@": 0.33969 },
  },
};
// @@FALLBACK-END

const RAMPS = new Map();

function rampFromTable(t) {
  const ramp = t.ramp.map(([glyphs, density]) => ({ glyphs, density, cov: density * t.top }));
  ramp.singles = t.singles;
  return ramp;
}

// The ramp to use right now: measured if densityRamp() has run for this typeface, else the table.
export function rampSync(typefaceId = 'pica') {
  if (RAMPS.has(typefaceId)) return RAMPS.get(typefaceId);
  const t = FALLBACK[typefaceId] || FALLBACK.pica;
  const ramp = rampFromTable(t);
  RAMPS.set(typefaceId, ramp);
  ramp.source = 'table';
  return ramp;
}

// Measures every candidate stack with the real ink renderer: each stack is typed as a 3 x 3 patch
// on a PageSurface and the centre cell's absorbed light (linear, relative to the bare paper) is
// read back. Returns a measure function (glyphs[] -> darkness) backed by that table.
export async function surfaceMeasurer(PageSurface, typefaceId = 'pica', { scale = 0.5, paper = 'bond' } = {}) {
  const key = g => g.slice().sort().join('\u0001');
  const table = new Map();
  const surface = new PageSurface({ paper, scale });
  const ctx = surface.ctx || surface.canvas.getContext('2d');
  const W = surface.width, H = surface.height;
  const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const LUT = new Float32Array(256).map((_, i) => lin(i));
  surface.render([]);
  const bare = ctx.getImageData(0, 0, W, H).data;
  const per = 3, step = 4;
  const perRow = Math.floor((PAGE.COLS - 1) / step), perCol = Math.floor((PAGE.ROWS - 1) / step);
  const cw = PAGE.CW * scale, rh = PAGE.RH * scale;
  const batch = async cands => {
    for (let p0 = 0; p0 < cands.length; p0 += perRow * perCol) {
      const part = cands.slice(p0, p0 + perRow * perCol);
      const strikes = [];
      part.forEach((g, n) => {
        const bx = 1 + (n % perRow) * step, by = 1 + Math.floor(n / perRow) * step;
        let i = 0;
        for (let y = 0; y < per; y++) for (let x = 0; x < per; x++) for (const c of g) {
          strikes.push({ c, x: bx + x, y: by + y, k: 'k', p: 1, f: typefaceId, s: (n * 97 + i++ * 131 + 7) >>> 0, w: 0 });
        }
      });
      surface.render(strikes);
      const d = ctx.getImageData(0, 0, W, H).data;
      part.forEach((g, n) => {
        const bx = 2 + (n % perRow) * step, by = 2 + Math.floor(n / perRow) * step;
        const x0 = Math.round(bx * cw), y0 = Math.round(by * rh), x1 = Math.round((bx + 1) * cw), y1 = Math.round((by + 1) * rh);
        let si = 0, sp = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          const o = (y * W + x) * 4;
          si += 0.2126 * LUT[d[o]] + 0.7152 * LUT[d[o + 1]] + 0.0722 * LUT[d[o + 2]];
          sp += 0.2126 * LUT[bare[o]] + 0.7152 * LUT[bare[o + 1]] + 0.0722 * LUT[bare[o + 2]];
        }
        table.set(key(g), Math.max(0, 1 - si / sp));
      });
      await new Promise(r => setTimeout(r, 0));
    }
  };
  const singles = rampCandidates().filter(g => g.length === 1).concat(['_', '|', '/', '\\', '(', ')'].map(c => [c]));
  await batch(singles);
  const order = STACK_BASE.slice().sort((a, b) => (table.get(key([b])) ?? 0) - (table.get(key([a])) ?? 0));
  await batch(rampCandidates(order).filter(g => g.length > 1));
  if (surface.dispose) surface.dispose();
  const fn = g => {
    const v = table.get(key(g));
    if (v != null) return v;
    // stacks outside the table: combine as independent layers (only used for exotic glyphs)
    return 1 - g.reduce((s, c) => s * (1 - (table.get(key([c])) ?? 0.2)), 1);
  };
  fn.table = table;
  return fn;
}

const PENDING = new Map();

// Measure (or recall) the density ramp for a typeface: [{ glyphs: ['#'], density }] light -> dark.
// opts.PageSurface: measure with the real ink renderer (best); opts.measure: inject a measure
// function (glyphs[] -> darkness, used by tests); otherwise the canvas is used when the web font
// is available, else the built-in table (measured with the renderer by tools/art-measure.mjs).
export async function densityRamp(typefaceId = 'pica', opts = {}) {
  const cached = RAMPS.get(typefaceId);
  if (!opts.measure && cached && (cached.source === 'renderer' || (cached.source === 'canvas' && !opts.PageSurface))) return cached;
  const pkey = typefaceId + (opts.PageSurface ? ':r' : ':c');
  if (!opts.measure && PENDING.has(pkey)) return PENDING.get(pkey);
  const job = (async () => {
    let measure = opts.measure, source = 'injected';
    if (!measure && typeof document !== 'undefined' && document.fonts) {
      const family = FAMILIES[typefaceId] || FAMILIES.pica;
      let fontOk = false;
      try { const faces = await document.fonts.load(`40px "${family}"`, '#@MWo.'); fontOk = !!(faces && faces.length); } catch { /* table */ }
      if (fontOk && opts.PageSurface) {
        try { measure = await surfaceMeasurer(opts.PageSurface, typefaceId); source = 'renderer'; } catch (e) { measure = null; }
      }
      if (fontOk && !measure) { measure = canvasMeasurer(family); source = 'canvas'; }
    }
    if (!measure) return rampSync(typefaceId);
    const ramp = buildRamp(measure, opts);
    ramp.source = source;
    ramp.measure = measure;
    if (!opts.measure) RAMPS.set(typefaceId, ramp);
    return ramp;
  })();
  if (!opts.measure) PENDING.set(pkey, job);
  try { return await job; } finally { PENDING.delete(pkey); }
}

// For tests / the app: register a ramp explicitly.
export function setRamp(typefaceId, ramp) { RAMPS.set(typefaceId, ramp); }

// ---------------------------------------------------------------------------------------------
// Image helpers (all on Float32 luminance grids, 1 = white paper, 0 = black)
// ---------------------------------------------------------------------------------------------

function toLum(img) {
  const { width: w, height: h, data } = img;
  const L = new Float32Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const a = data[p + 3] / 255;
    const l = (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / 255;
    L[i] = 1 - a * (1 - l);
  }
  return L;
}

// 1-D resample with a box filter when shrinking and linear interpolation when growing.
function scaleAxis(src, n, N, count, stride, step, out, oStride, oStep) {
  const r = n / N;
  for (let line = 0; line < count; line++) {
    const so = line * stride, oo = line * oStride;
    for (let X = 0; X < N; X++) {
      let v;
      if (r >= 1) {
        const a = X * r, b = a + r;
        let s = 0;
        for (let i = Math.floor(a); i < b && i < n; i++) s += src[so + i * step] * (Math.min(b, i + 1) - Math.max(a, i));
        v = s / r;
      } else {
        const c = (X + 0.5) * r - 0.5;
        const i0 = clamp(Math.floor(c), 0, n - 1), i1 = Math.min(n - 1, i0 + 1);
        const t = clamp(c - i0, 0, 1);
        v = src[so + i0 * step] * (1 - t) + src[so + i1 * step] * t;
      }
      out[oo + X * oStep] = v;
    }
  }
}

function resample(L, w, h, W, H) {
  const tmp = new Float32Array(W * h);
  scaleAxis(L, w, W, h, w, 1, tmp, W, 1);
  const out = new Float32Array(W * H);
  scaleAxis(tmp, h, H, W, 1, W, out, 1, W);
  return out;
}

function blur(src, W, H, sigma) {
  if (sigma < 0.2) return Float32Array.from(src);
  const r = Math.ceil(sigma * 3);
  const k = new Float32Array(2 * r + 1);
  let ks = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); ks += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += src[y * W + clamp(x + i, 0, W - 1)] * k[i + r];
    tmp[y * W + x] = s;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += tmp[clamp(y + i, 0, H - 1) * W + x] * k[i + r];
    out[y * W + x] = s;
  }
  return out;
}

function percentile(A, q) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < A.length; i++) hist[clamp(Math.round(A[i] * 255), 0, 255)]++;
  const target = q * A.length;
  let acc = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i / 255; }
  return 1;
}

// Luminance -> darkness 0..1 with the user's adjustments. contrast/brightness in -1..1, gamma > 0.
function toneMap(L, o) {
  const T = new Float32Array(L.length);
  let lo = 0, hi = 1;
  if (o.autoLevels !== false) {
    const a = percentile(L, 0.004), b = percentile(L, 0.996);
    if (b - a > 0.12) { lo = a; hi = b; }
  }
  const c = clamp(o.contrast ?? 0, -1, 1);
  const cf = c >= 0 ? 1 + c * 2.2 : 1 + c * 0.85;
  const br = clamp(o.brightness ?? 0, -1, 1) * 0.5;
  const g = clamp(o.gamma ?? 1, 0.2, 5);
  for (let i = 0; i < L.length; i++) {
    let v = (L[i] - lo) / (hi - lo);
    if (o.invert) v = 1 - v;
    v = (v - 0.5) * cf + 0.5 + br;
    v = clamp(v, 0, 1);
    v = Math.pow(v, g);
    T[i] = 1 - v;
  }
  return T;
}

// Picture size on the page. cols given; rows (full lines) from the aspect unless given.
export function pictureRows(width, height, cols) {
  return Math.max(1, Math.round(cols * CELL_W * height / width));
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16);

function nearestLevel(levels, v) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < levels.length; i++) {
    const d = Math.abs(levels[i] - v);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// Quantise a grid of target densities onto ramp levels.
// mode 'diffuse': serpentine Floyd-Steinberg with damped error; 'ordered': 4x4 Bayer between levels.
function quantise(V, cols, rows, levels, { mode = 'diffuse', strength = 0.8, cut = 0 } = {}) {
  const idx = new Int16Array(cols * rows);
  if (mode === 'ordered' || mode === 'none') {
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const i = y * cols + x, v = V[i];
      if (v <= cut) continue;
      if (mode === 'none') { idx[i] = nearestLevel(levels, v); continue; }
      let hiI = levels.findIndex(l => l >= v);
      if (hiI < 0) { idx[i] = levels.length - 1; continue; }
      if (hiI === 0) continue;
      const lo = levels[hiI - 1], hi = levels[hiI];
      const f = (v - lo) / (hi - lo);
      idx[i] = f > BAYER4[(y & 3) * 4 + (x & 3)] ? hiI : hiI - 1;
    }
    return idx;
  }
  const E = Float32Array.from(V);
  for (let y = 0; y < rows; y++) {
    const ltr = (y & 1) === 0;
    for (let n = 0; n < cols; n++) {
      const x = ltr ? n : cols - 1 - n;
      const i = y * cols + x;
      if (V[i] <= cut) { idx[i] = 0; continue; }       // clean paper: no dither noise in highlights
      const v = clamp(E[i], -0.25, 1.25);
      const k = nearestLevel(levels, v);
      idx[i] = k;
      const e = (v - levels[k]) * strength;
      const dx = ltr ? 1 : -1;
      if (x + dx >= 0 && x + dx < cols) E[i + dx] += e * 7 / 16;
      if (y + 1 < rows) {
        if (x - dx >= 0 && x - dx < cols) E[i + cols - dx] += e * 3 / 16;
        E[i + cols] += e * 5 / 16;
        if (x + dx >= 0 && x + dx < cols) E[i + cols + dx] += e * 1 / 16;
      }
    }
  }
  return idx;
}

// ---------------------------------------------------------------------------------------------
// imageToStrikes
// ---------------------------------------------------------------------------------------------

const PIC_DEFAULTS = {
  x0: 0, y0: 0, cols: 60, rows: undefined, halfRows: false, style: 'shade', contrast: 0, brightness: 0,
  gamma: 1, invert: false, ink: 'k', typeface: 'pica', pressure: 1, dither: 'diffuse', sharpen: 0.35,
  autoLevels: true, hatch: 0.35, detail: 0.5, pageCols: PAGE.COLS, pageRows: PAGE.ROWS,
};

// imageData: { width, height, data: RGBA bytes } (an ImageData or a plain object).
export function imageToStrikes(imageData, opts = {}) {
  const o = { ...PIC_DEFAULTS, ...opts };
  for (const k of Object.keys(PIC_DEFAULTS)) if (o[k] === undefined) o[k] = PIC_DEFAULTS[k];
  const cols = Math.max(1, Math.round(o.cols));
  const rows = Math.max(1, Math.round(o.rows ?? pictureRows(imageData.width, imageData.height, cols)));
  const L = toLum(imageData);
  const ramp = o.ramp || rampSync(o.typeface);
  let out;
  if (o.style === 'line') out = lineStyle(L, imageData.width, imageData.height, cols, rows, o, ramp);
  else if (o.style === 'stipple') out = stippleStyle(L, imageData.width, imageData.height, cols, rows, o, ramp);
  else out = shadeStyle(L, imageData.width, imageData.height, cols, rows, o, ramp);
  return clipToPage(out, o.pageCols, o.pageRows);
}

function clipToPage(strikes, cols = PAGE.COLS, rows = PAGE.ROWS) {
  return strikes.filter(s => s.x >= 0 && s.y >= 0 && s.x <= cols - 1 && s.y <= rows - 1);
}

const mk = (c, x, y, o) => ({ c, x, y, k: o.ink || 'k', p: o.pressure ?? 1, f: o.typeface || 'pica' });

function shadeStyle(L, w, h, cols, rows, o, ramp) {
  const half = !!o.halfRows;
  const nr = half ? rows * 2 : rows;
  // 2 x 2 samples per cell for a light unsharp mask, then average down.
  const SX = 2, SY = 2;
  const G = resample(L, w, h, cols * SX, nr * SY);
  let T = toneMap(G, o);
  const W = cols * SX, H = nr * SY;
  if (o.sharpen > 0) {
    const B = blur(T, W, H, 2.2);
    for (let i = 0; i < T.length; i++) T[i] = clamp(T[i] + (T[i] - B[i]) * o.sharpen * 1.6, 0, 1);
  }
  const V = new Float32Array(cols * nr);
  for (let y = 0; y < nr; y++) for (let x = 0; x < cols; x++) {
    let s = 0;
    for (let j = 0; j < SY; j++) for (let i = 0; i < SX; i++) s += T[(y * SY + j) * W + x * SX + i];
    V[y * cols + x] = s / (SX * SY);
  }
  // With half rows two glyphs share every line, so each one needs about half the ink.
  const gain = half ? 0.6 : 1;
  const curve = o.curve ?? 1.3;
  for (let i = 0; i < V.length; i++) V[i] = Math.pow(V[i], curve) * gain;
  const levels = ramp.map(r => r.density);
  const cut = Math.max(0.012, levels[1] * 0.45) ;
  const idx = quantise(V, cols, nr, levels, { mode: o.dither, strength: 0.8, cut });
  const out = [];
  const step = half ? 0.5 : 1;
  for (let y = 0; y < nr; y++) for (let x = 0; x < cols; x++) {
    const k = idx[y * cols + x];
    if (!k) continue;
    for (const g of ramp[k].glyphs) out.push(mk(g, o.x0 + x, o.y0 + y * step, o));
  }
  return out;
}

// Contour drawing: lines where the picture is darker than its surroundings (difference of
// Gaussians), each cell gets a character that follows the local stroke direction, plus optional
// diagonal hatching for the dark masses.
function lineStyle(L, w, h, cols, rows, o, ramp) {
  const half = !!o.halfRows;
  const nr = half ? rows * 2 : rows;
  const SX = 6, SY = half ? 5 : 10;            // sub-pixels are 0.1 line square
  const W = cols * SX, H = nr * SY;
  const G = resample(L, w, h, W, H);
  const T = toneMap(G, o);
  const lum = T.map(v => 1 - v);
  const detail = clamp(o.detail ?? 0.5, 0, 1);
  const s1 = blur(lum, W, H, 1.1), s2 = blur(lum, W, H, 3.2);
  const tau = 0.05 - detail * 0.035;
  const Wt = new Float32Array(W * H);
  for (let i = 0; i < Wt.length; i++) {
    const d = s1[i] - s2[i];
    if (d < -tau) Wt[i] = Math.min(1, (-d - tau) / 0.06 + 0.25);
  }
  const n = cols * nr;
  const mass = new Float32Array(n), cx = new Float32Array(n), cy = new Float32Array(n);
  for (let cyI = 0; cyI < nr; cyI++) for (let cxI = 0; cxI < cols; cxI++) {
    let m = 0, mx = 0, my = 0;
    for (let j = 0; j < SY; j++) for (let i = 0; i < SX; i++) {
      const v = Wt[(cyI * SY + j) * W + cxI * SX + i];
      if (v) { m += v; mx += v * (i + 0.5); my += v * (j + 0.5); }
    }
    const c = cyI * cols + cxI;
    mass[c] = m / (SX * SY);
    if (m > 0) { cx[c] = mx / m / SX; cy[c] = my / m / SY; }
  }
  const minMass = 0.07 - detail * 0.03;
  const glyph = new Array(n).fill(null);
  const angle = new Float32Array(n);
  // Orientation from a Gaussian-weighted PCA of the line pixels around each cell.
  const R = 9, sig = 5.5;
  for (let cyI = 0; cyI < nr; cyI++) for (let cxI = 0; cxI < cols; cxI++) {
    const c = cyI * cols + cxI;
    if (mass[c] < minMass) continue;
    const px = (cxI + cx[c]) * SX, py = (cyI + cy[c]) * SY;
    let sw = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    const x0 = Math.max(0, Math.floor(px - R)), x1 = Math.min(W - 1, Math.ceil(px + R));
    const y0 = Math.max(0, Math.floor(py - R)), y1 = Math.min(H - 1, Math.ceil(py + R));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const v = Wt[y * W + x];
      if (!v) continue;
      const dx = x + 0.5 - px, dy = y + 0.5 - py;
      const wt = v * Math.exp(-(dx * dx + dy * dy) / (2 * sig * sig));
      sw += wt; sx += wt * dx; sy += wt * dy; sxx += wt * dx * dx; syy += wt * dy * dy; sxy += wt * dx * dy;
    }
    const mx = sx / sw, my = sy / sw;
    const vxx = sxx / sw - mx * mx, vyy = syy / sw - my * my, vxy = sxy / sw - mx * my;
    const theta = 0.5 * Math.atan2(2 * vxy, vxx - vyy);             // image coords, y down
    const tr = vxx + vyy, det = vxx * vyy - vxy * vxy;
    const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
    const aniso = l1 > 1e-6 ? (l1 - l2) / (l1 + l2) : 0;
    let phi = (-theta * 180 / Math.PI) % 180;                          // y up, degrees
    if (phi < 0) phi += 180;
    angle[c] = phi;
    if (aniso < 0.14) { glyph[c] = mass[c] > 0.5 ? '#' : mass[c] > 0.24 ? 'o' : '.'; continue; }
    if (phi < 28 || phi >= 152) glyph[c] = (!half && cy[c] > 0.62) ? '_' : '-';
    else if (phi < 70) glyph[c] = '/';
    else if (phi < 110) glyph[c] = '|';
    else glyph[c] = '\\';
  }
  // Thin strokes to one cell: drop a cell when a neighbour across the stroke carries more line.
  const keep = glyph.slice();
  for (let cyI = 0; cyI < nr; cyI++) for (let cxI = 0; cxI < cols; cxI++) {
    const c = cyI * cols + cxI;
    const g = glyph[c];
    if (!g || g === '.' || g === 'o' || g === '#') continue;
    const a = (angle[c] + 90) * Math.PI / 180;                       // normal, y up, physical units
    let nx = Math.cos(a) / CELL_W, ny = -Math.sin(a) * (half ? 2 : 1);  // in cells (y down)
    const m = Math.max(Math.abs(nx), Math.abs(ny));
    nx = Math.round(nx / m); ny = Math.round(ny / m);
    for (const sgn of [1, -1]) {
      const xx = cxI + nx * sgn, yy = cyI + ny * sgn;
      if (xx < 0 || yy < 0 || xx >= cols || yy >= nr) continue;
      const k = yy * cols + xx;
      if (!glyph[k]) continue;
      let da = Math.abs(angle[k] - angle[c]); da = Math.min(da, 180 - da);
      if (da > 35) continue;
      if (mass[k] > mass[c] * 1.05 || (Math.abs(mass[k] - mass[c]) <= mass[c] * 0.05 && k < c)) { keep[c] = null; break; }
    }
  }
  for (let c = 0; c < n; c++) glyph[c] = keep[c];
  // Curvature: a steep stroke whose neighbours above and below both lean the same way is a bracket.
  const xs = c => (c % cols) + cx[c];
  for (let cyI = 1; cyI < nr - 1; cyI++) for (let cxI = 0; cxI < cols; cxI++) {
    const c = cyI * cols + cxI;
    const g = glyph[c];
    if (g !== '|' && g !== '/' && g !== '\\') continue;
    if (angle[c] < 55 || angle[c] > 125) continue;
    const near = dy => {
      let best = -1, bd = 9;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = cxI + dx; if (xx < 0 || xx >= cols) continue;
        const k = (cyI + dy) * cols + xx;
        if (glyph[k] && glyph[k] !== '-' && glyph[k] !== '_' && Math.abs(dx) < bd) { bd = Math.abs(dx); best = k; }
      }
      return best;
    };
    const a = near(-1), b = near(1);
    if (a < 0 || b < 0) continue;
    const here = xs(c), da = xs(a) - here, db = xs(b) - here;
    if (da < -0.3 && db < -0.3) glyph[c] = ')';
    else if (da > 0.3 && db > 0.3) glyph[c] = '(';
  }
  const out = [];
  const step = half ? 0.5 : 1;
  for (let y = 0; y < nr; y++) for (let x = 0; x < cols; x++) {
    const g = glyph[y * cols + x];
    if (g) out.push(mk(g, o.x0 + x, o.y0 + y * step, o));
  }
  // Hatching for the dark masses: diagonal '/' lines (each '/' meets the next one up and to the
  // right), closer together as the tone darkens, crossed with '\' in the deepest shadows.
  const hatch = clamp(o.hatch ?? 0.35, 0, 1);
  if (hatch > 0) {
    const occupied = new Set(out.map(s => `${s.x},${Math.floor(s.y)}`));
    const t1 = 0.78 - hatch * 0.4, t2 = 0.9 - hatch * 0.35, t3 = 0.98 - hatch * 0.25;
    for (let r = 0; r < rows; r++) for (let x = 0; x < cols; x++) {
      let s = 0;
      const ya = Math.floor(r * H / rows), yb = Math.max(ya + 1, Math.floor((r + 1) * H / rows));
      for (let yy = ya; yy < yb; yy++) for (let i = 0; i < SX; i++) s += T[yy * W + x * SX + i];
      const t = s / ((yb - ya) * SX);
      if (t < t1 || occupied.has(`${o.x0 + x},${o.y0 + r}`)) continue;
      const d = ((x + r) % 4 + 4) % 4, e = ((x - r) % 4 + 4) % 4;
      let g = null;
      if (d === 0 || (t >= t2 && d === 2)) g = '/';
      if (t >= t3 && e === 1) g = g ? 'X' : '\\';
      if (g) out.push(mk(g, o.x0 + x, o.y0 + r, o));
    }
  }
  return out;
}

// Engraving-like dots: '.' and ':' on a half-space, half-line lattice placed by error diffusion.
function stippleStyle(L, w, h, cols, rows, o, ramp) {
  const S = ramp.singles || {};
  const dot = S['.'] || 0.008, colon = S[':'] || dot * 2;
  const NX = cols * 2, NY = rows * 2;                     // dot positions every half cell
  // Sample the picture where the dot actually lands: period centre ~(0.5, 0.72) of the glyph cell.
  const SX = 3, SY = 3;
  const G = resample(L, w, h, NX * SX, NY * SY);
  let T = toneMap(G, o);
  const W = NX * SX, H = NY * SY;
  if (o.sharpen > 0) {
    const B = blur(T, W, H, 3);
    for (let i = 0; i < T.length; i++) T[i] = clamp(T[i] + (T[i] - B[i]) * o.sharpen * 1.4, 0, 1);
  }
  const V = new Float32Array(NX * NY);
  for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) {
    let s = 0;
    for (let j = 0; j < SY; j++) for (let i = 0; i < SX; i++) s += T[(y * SY + j) * W + x * SX + i];
    V[y * NX + x] = s / (SX * SY);
  }
  // Levels in "dots": blank, period, colon. Full black = a colon at every position.
  const levels = [0, dot / colon, 1];
  const idx = quantise(V, NX, NY, levels, { mode: 'diffuse', strength: 0.95, cut: 0.03 });
  const out = [];
  for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) {
    const k = idx[y * NX + x];
    if (!k) continue;
    // the dot of '.' sits low in its cell (about 0.7 of the line); strike half a line higher so
    // the dot lands on the patch of picture it stands for
    out.push(mk(k === 1 ? '.' : ':', o.x0 + x * 0.5, o.y0 + y * 0.5 - 0.5, o));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------
// Coordinates are page cells (floats). Common fields: { id, type, glyph: 'auto' | chars (a string
// of 1-3 characters is an overstrike stack), ink: 'k', pressure: 1, halfStep: false }.
//   pencil  { points: [[x, y], ...] }                 freehand polyline
//   line    { x1, y1, x2, y2 }
//   rect    { x, y, w, h }                            outline of the cells in [x, x+w) x [y, y+h)
//   ellipse { x, y, w, h }                            outline of the ellipse inscribed in that box
//   fill    { of: rect | ellipse | pencil | polygon geometry } or { at: [x, y] } (flood fill
//           inside the outlines drawn before it); glyph, or shade: 0..1 (a ramp tone);
//           over: false (default) leaves cells already struck by earlier shapes alone
//   picture { image: ImageData, x, y, cols, rows?, style, contrast, ... }   (see imageToStrikes)
//   banner  { text, x, y, size, glyph }                                     (see bannerToStrikes)
//   strikes { strikes: [...] }                                              (precomputed, passed through)

const DIR_GLYPH = (phi, fy) => {
  if (phi < 25 || phi >= 155) return fy >= 0.55 ? '_' : '-';
  if (phi < 68) return '/';
  if (phi < 112) return '|';
  return '\\';
};

// physical angle (y up, degrees 0..180) of a step dx, dy in cells
const physAngle = (dx, dy) => {
  let a = Math.atan2(-dy, dx * CELL_W) * 180 / Math.PI;
  a %= 180; if (a < 0) a += 180;
  return a;
};

// Cells (grid indices at step s) along a polyline, 8-connected and thinned, with the local direction.
function traceCells(points, s, closed = false) {
  const cells = [];
  const push = (i, j, fx, fy, dx, dy) => {
    const last = cells[cells.length - 1];
    if (last && last.i === i && last.j === j) {
      last.dx += dx; last.dy += dy; last.fy += fy; last.n++;
      return;
    }
    cells.push({ i, j, dx, dy, fy, n: 1, fx });
  };
  const pts = closed && points.length > 2 ? points.concat([points[0]]) : points;
  if (pts.length === 1) {
    const [x, y] = pts[0];
    push(Math.floor(x / s), Math.floor(y / s), 0, (y / s) % 1, 1, 0);
  }
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
    const dx = bx - ax, dy = by - ay;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx / s, dy / s) * 3));
    for (let t = 0; t <= steps; t++) {
      if (t === 0 && k > 0) continue;
      const x = ax + dx * t / steps, y = ay + dy * t / steps;
      const gx = x / s, gy = y / s;
      push(Math.floor(gx), Math.floor(gy), gx - Math.floor(gx), gy - Math.floor(gy), dx, dy);
    }
  }
  // Remove 4-connected corner cells so the path is a thin 8-connected line.
  let changed = true;
  while (changed) {
    changed = false;
    for (let k = 1; k + 1 < cells.length; k++) {
      const a = cells[k - 1], c = cells[k + 1];
      if (Math.abs(a.i - c.i) <= 1 && Math.abs(a.j - c.j) <= 1 && !(a.i === c.i && a.j === c.j)) {
        const b = cells[k];
        c.dx += b.dx; c.dy += b.dy;
        cells.splice(k, 1);
        changed = true;
      }
    }
  }
  // de-duplicate cells visited twice (loops)
  const seen = new Map();
  for (const c of cells) {
    const key = c.i + ',' + c.j;
    if (seen.has(key)) { const d = seen.get(key); d.dx += c.dx; d.dy += c.dy; continue; }
    seen.set(key, c);
  }
  return [...seen.values()].map(c => ({ ...c, fy: c.fy / c.n }));
}

// Smooth the direction along the path (window of +-2 cells) for 'auto' glyphs.
function smoothDirs(cells) {
  return cells.map((c, k) => {
    let dx = 0, dy = 0;
    for (let m = Math.max(0, k - 2); m <= Math.min(cells.length - 1, k + 2); m++) {
      const n = Math.hypot(cells[m].dx * CELL_W, cells[m].dy) || 1;
      dx += cells[m].dx / n; dy += cells[m].dy / n;
    }
    return { ...c, sdx: dx, sdy: dy };
  });
}

const glyphsOf = g => (!g || g === 'auto') ? null : Array.from(g);

function shapeStep(shape) { return shape.halfStep ? 0.5 : 1; }

function strokeStrikes(cells, s, shape, o, autoFor) {
  const out = [];
  const fixed = glyphsOf(shape.glyph);
  for (const c of cells) {
    const x = c.i * s, y = c.j * s;
    const gl = fixed || [autoFor(c)];
    for (const g of gl) out.push(mk(g, x, y, { ink: shape.ink, pressure: shape.pressure, typeface: o.typeface }));
  }
  return out;
}

function ellipsePoints(x, y, w, h, s) {
  // inscribed in the box, passing through the centres of the outermost cells
  const cx = x + w / 2, cy = y + h / 2;
  const rx = Math.max(0, w / 2 - s / 2), ry = Math.max(0, h / 2 - s / 2);
  const n = Math.max(24, Math.ceil((rx / CELL_W + ry) * 2 * Math.PI / s * 2));
  const pts = [];
  for (let k = 0; k < n; k++) {
    const t = (k / n) * Math.PI * 2;
    pts.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]);
  }
  return { pts, cx, cy, rx, ry };
}

function insideTest(of, s = 1) {
  if (!of) return () => false;
  if (of.type === 'rect') return (px, py) => px >= of.x && px < of.x + of.w && py >= of.y && py < of.y + of.h;
  if (of.type === 'ellipse') {
    // the same centre line the outline is drawn on, so a fill never pokes outside its oval
    const cx = of.x + of.w / 2, cy = of.y + of.h / 2;
    const rx = Math.max(s / 2, of.w / 2 - s / 2), ry = Math.max(s / 2, of.h / 2 - s / 2);
    return (px, py) => rx > 0 && ry > 0 && ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1;
  }
  const poly = of.points || [];
  return (px, py) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
}

function boundsOf(of) {
  if (of.type === 'rect' || of.type === 'ellipse') return { x0: of.x, y0: of.y, x1: of.x + of.w, y1: of.y + of.h };
  const ps = of.points || [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ps) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1 };
}

// glyphs for a shade fill at grid index (i, j): ordered dither between the two nearest ramp levels
function shadeGlyphs(ramp, t, i, j) {
  const levels = ramp.map(r => r.density);
  const v = clamp(t, 0, 1);
  let hiI = levels.findIndex(l => l >= v);
  if (hiI <= 0) return hiI === 0 ? [] : ramp[ramp.length - 1].glyphs;
  const lo = levels[hiI - 1], hi = levels[hiI];
  const f = (v - lo) / (hi - lo);
  return ramp[f > BAYER4[(j & 3) * 4 + (i & 3)] ? hiI : hiI - 1].glyphs;
}

// Rasterise every shape. Returns { strikes, perShape: [{ id, strikes, ok, reason }] } in shape order.
export function rasterizeShapes(shapes, opts = {}) {
  const o = { typeface: 'pica', pageCols: PAGE.COLS, pageRows: PAGE.ROWS, ...opts };
  const ramp = o.ramp || rampSync(o.typeface);
  const occupied = [];                 // strikes so far, for fills
  const perShape = [];
  const all = [];
  for (const shape of shapes) {
    let res = { strikes: [], ok: true };
    try { res = rasterizeOne(shape, o, ramp, occupied); }
    catch (e) { res = { strikes: [], ok: false, reason: String(e && e.message || e) }; }
    const strikes = clipToPage(res.strikes, o.pageCols, o.pageRows);
    perShape.push({ id: shape.id, type: shape.type, strikes, ok: res.ok !== false, reason: res.reason });
    for (const s of strikes) { all.push(s); occupied.push(s); }
  }
  return { strikes: all, perShape };
}

export function shapesToStrikes(shapes, opts = {}) {
  return rasterizeShapes(shapes, opts).strikes;
}

function rasterizeOne(shape, o, ramp, occupied) {
  const s = shapeStep(shape);
  const so = { ink: shape.ink || 'k', pressure: shape.pressure ?? 1, typeface: o.typeface };
  switch (shape.type) {
    case 'pencil': {
      const pts = shape.points || [];
      if (!pts.length) return { strikes: [] };
      const cells = smoothDirs(traceCells(pts, s, !!shape.closed));
      return { strikes: strokeStrikes(cells, s, shape, o, c => DIR_GLYPH(physAngle(c.sdx, c.sdy), c.fy)) };
    }
    case 'line': {
      const cells = traceCells([[shape.x1, shape.y1], [shape.x2, shape.y2]], s);
      const phi = physAngle(shape.x2 - shape.x1, shape.y2 - shape.y1);
      return { strikes: strokeStrikes(cells, s, shape, o, c => DIR_GLYPH(phi, c.fy)) };
    }
    case 'rect': {
      const i0 = Math.round(shape.x / s), j0 = Math.round(shape.y / s);
      const i1 = Math.round((shape.x + shape.w) / s) - 1, j1 = Math.round((shape.y + shape.h) / s) - 1;
      if (i1 < i0 || j1 < j0) return { strikes: [] };
      const cells = [];
      const add = (i, j, g) => cells.push({ i, j, g });
      if (i0 === i1 || j0 === j1) {
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) add(i, j, i0 === i1 && j0 !== j1 ? '|' : '-');
      } else {
        for (let i = i0; i <= i1; i++) { add(i, j0, (i === i0 || i === i1) ? '+' : '-'); add(i, j1, (i === i0 || i === i1) ? '+' : '-'); }
        for (let j = j0 + 1; j < j1; j++) { add(i0, j, '|'); add(i1, j, '|'); }
      }
      const fixed = glyphsOf(shape.glyph);
      const out = [];
      for (const c of cells) for (const g of (fixed || [c.g])) out.push(mk(g, c.i * s, c.j * s, so));
      return { strikes: out };
    }
    case 'ellipse': {
      const { pts, cx, cy } = ellipsePoints(shape.x, shape.y, shape.w, shape.h, s);
      if (shape.w <= s || shape.h <= s) {
        return { strikes: strokeStrikes(traceCells(pts.length ? [pts[0]] : [], s), s, shape, o, () => 'o') };
      }
      const cells = traceCells(pts, s, true);
      return {
        strikes: strokeStrikes(cells, s, shape, o, c => {
          // tangent from the ellipse equation at this cell's centre
          const px = (c.i + 0.5) * s, py = (c.j + 0.5) * s;
          const ax = (px - cx), ay = (py - cy);
          const rx = Math.max(0.5, shape.w / 2), ry = Math.max(0.5, shape.h / 2);
          // normal ~ (ax / rx^2, ay / ry^2); tangent perpendicular
          const nx = ax / (rx * rx), ny = ay / (ry * ry);
          const phi = physAngle(-ny, nx);
          const side = Math.atan2(ay / ry, ax / rx) * 180 / Math.PI;       // -180..180, 0 = right
          if (phi >= 62 && phi < 118) return Math.abs(side) < 90 ? ')' : '(';
          if (phi < 25 || phi >= 155) return '_';
          return phi < 90 ? '/' : '\\';
        }),
      };
    }
    case 'fill': return fillShape(shape, o, ramp, occupied, so);
    case 'picture': {
      if (!shape.image) return { strikes: [], ok: false, reason: 'no image' };
      return {
        strikes: imageToStrikes(shape.image, {
          ...shape, x0: shape.x, y0: shape.y, ink: so.ink, pressure: so.pressure, typeface: o.typeface, ramp,
          pageCols: o.pageCols, pageRows: o.pageRows,
        }),
      };
    }
    case 'banner':
      return { strikes: bannerToStrikes(shape.text || '', { ...shape, x0: shape.x, y0: shape.y, ink: so.ink, pressure: so.pressure, typeface: o.typeface }) };
    case 'strikes':                                   // precomputed (e.g. a cached picture conversion)
      return { strikes: (shape.strikes || []).map(s => ({ c: s.c, x: s.x, y: s.y, k: s.k || so.ink, p: s.p ?? so.pressure, f: s.f || o.typeface })) };
    default:
      return { strikes: [], ok: false, reason: 'unknown shape ' + shape.type };
  }
}

function fillShape(shape, o, ramp, occupied, so) {
  const s = shapeStep(shape);
  const fixed = glyphsOf(shape.glyph);
  const tone = shape.shade ?? 0.5;
  const glyphsAt = (i, j) => fixed || shadeGlyphs(ramp, tone, i, j);
  // cells already struck, at this grid step (a whole cell blocks the half cells it covers)
  const blocked = new Set();
  for (const st of occupied) {
    const ext = 1;                                   // a strike covers one whole cell
    for (let y = st.y; y < st.y + ext - 1e-9; y += s) for (let x = st.x; x < st.x + ext - 1e-9; x += s) {
      blocked.add(Math.floor(x / s + 1e-6) + ',' + Math.floor(y / s + 1e-6));
    }
  }
  const out = [];
  if (shape.of) {
    const inside = insideTest(shape.of, s);
    const b = boundsOf(shape.of);
    const i0 = Math.max(0, Math.floor(b.x0 / s)), i1 = Math.min(Math.ceil(o.pageCols / s) - 1, Math.ceil(b.x1 / s));
    const j0 = Math.max(0, Math.floor(b.y0 / s)), j1 = Math.min(Math.ceil(o.pageRows / s) - 1, Math.ceil(b.y1 / s));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (!inside((i + 0.5) * s, (j + 0.5) * s)) continue;
      if (!shape.over && blocked.has(i + ',' + j)) continue;
      for (const g of glyphsAt(i, j)) out.push(mk(g, i * s, j * s, so));
    }
    return { strikes: out };
  }
  if (shape.at) {
    const NI = Math.ceil(o.pageCols / s), NJ = Math.ceil(o.pageRows / s);
    const si = Math.floor(shape.at[0] / s), sj = Math.floor(shape.at[1] / s);
    if (si < 0 || sj < 0 || si >= NI || sj >= NJ) return { strikes: [], ok: false, reason: 'outside the page' };
    if (blocked.has(si + ',' + sj)) return { strikes: [], ok: false, reason: 'that cell is already struck' };
    const seen = new Set([si + ',' + sj]);
    const queue = [[si, sj]];
    const region = [];
    const limit = shape.limit || Math.floor(NI * NJ * 0.5);
    while (queue.length) {
      const [i, j] = queue.pop();
      if (i <= 0 || j <= 0 || i >= NI - 1 || j >= NJ - 1) return { strikes: [], ok: false, reason: 'open' };
      region.push([i, j]);
      if (region.length > limit) return { strikes: [], ok: false, reason: 'open' };
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = (i + di) + ',' + (j + dj);
        if (seen.has(k) || blocked.has(k)) continue;
        seen.add(k);
        queue.push([i + di, j + dj]);
      }
    }
    for (const [i, j] of region) for (const g of glyphsAt(i, j)) out.push(mk(g, i * s, j * s, so));
    return { strikes: out };
  }
  return { strikes: [], ok: false, reason: 'nothing to fill' };
}

// ---------------------------------------------------------------------------------------------
// Banners: big letters built from characters
// ---------------------------------------------------------------------------------------------

const FONT_ROWS = 7;
const F = {};
const def = (chars, rows) => { for (const ch of chars) F[ch] = rows; };
def('A', ['.XXX.', 'X...X', 'X...X', 'XXXXX', 'X...X', 'X...X', 'X...X']);
def('B', ['XXXX.', 'X...X', 'X...X', 'XXXX.', 'X...X', 'X...X', 'XXXX.']);
def('C', ['.XXX.', 'X...X', 'X....', 'X....', 'X....', 'X...X', '.XXX.']);
def('D', ['XXXX.', 'X...X', 'X...X', 'X...X', 'X...X', 'X...X', 'XXXX.']);
def('E', ['XXXXX', 'X....', 'X....', 'XXXX.', 'X....', 'X....', 'XXXXX']);
def('F', ['XXXXX', 'X....', 'X....', 'XXXX.', 'X....', 'X....', 'X....']);
def('G', ['.XXX.', 'X...X', 'X....', 'X.XXX', 'X...X', 'X...X', '.XXXX']);
def('H', ['X...X', 'X...X', 'X...X', 'XXXXX', 'X...X', 'X...X', 'X...X']);
def('I', ['.XXX.', '..X..', '..X..', '..X..', '..X..', '..X..', '.XXX.']);
def('J', ['..XXX', '...X.', '...X.', '...X.', '...X.', 'X..X.', '.XX..']);
def('K', ['X...X', 'X..X.', 'X.X..', 'XX...', 'X.X..', 'X..X.', 'X...X']);
def('L', ['X....', 'X....', 'X....', 'X....', 'X....', 'X....', 'XXXXX']);
def('M', ['X...X', 'XX.XX', 'X.X.X', 'X.X.X', 'X...X', 'X...X', 'X...X']);
def('N', ['X...X', 'X...X', 'XX..X', 'X.X.X', 'X..XX', 'X...X', 'X...X']);
def('O', ['.XXX.', 'X...X', 'X...X', 'X...X', 'X...X', 'X...X', '.XXX.']);
def('P', ['XXXX.', 'X...X', 'X...X', 'XXXX.', 'X....', 'X....', 'X....']);
def('Q', ['.XXX.', 'X...X', 'X...X', 'X...X', 'X.X.X', 'X..X.', '.XX.X']);
def('R', ['XXXX.', 'X...X', 'X...X', 'XXXX.', 'X.X..', 'X..X.', 'X...X']);
def('S', ['.XXXX', 'X....', 'X....', '.XXX.', '....X', '....X', 'XXXX.']);
def('T', ['XXXXX', '..X..', '..X..', '..X..', '..X..', '..X..', '..X..']);
def('U', ['X...X', 'X...X', 'X...X', 'X...X', 'X...X', 'X...X', '.XXX.']);
def('V', ['X...X', 'X...X', 'X...X', 'X...X', 'X...X', '.X.X.', '..X..']);
def('W', ['X...X', 'X...X', 'X...X', 'X.X.X', 'X.X.X', 'X.X.X', '.X.X.']);
def('X', ['X...X', 'X...X', '.X.X.', '..X..', '.X.X.', 'X...X', 'X...X']);
def('Y', ['X...X', 'X...X', '.X.X.', '..X..', '..X..', '..X..', '..X..']);
def('Z', ['XXXXX', '....X', '...X.', '..X..', '.X...', 'X....', 'XXXXX']);
def('0', ['.XXX.', 'X...X', 'X..XX', 'X.X.X', 'XX..X', 'X...X', '.XXX.']);
def('1', ['..X..', '.XX..', '..X..', '..X..', '..X..', '..X..', '.XXX.']);
def('2', ['.XXX.', 'X...X', '....X', '...X.', '..X..', '.X...', 'XXXXX']);
def('3', ['XXXXX', '...X.', '..X..', '...X.', '....X', 'X...X', '.XXX.']);
def('4', ['...X.', '..XX.', '.X.X.', 'X..X.', 'XXXXX', '...X.', '...X.']);
def('5', ['XXXXX', 'X....', 'XXXX.', '....X', '....X', 'X...X', '.XXX.']);
def('6', ['..XX.', '.X...', 'X....', 'XXXX.', 'X...X', 'X...X', '.XXX.']);
def('7', ['XXXXX', '....X', '...X.', '..X..', '.X...', '.X...', '.X...']);
def('8', ['.XXX.', 'X...X', 'X...X', '.XXX.', 'X...X', 'X...X', '.XXX.']);
def('9', ['.XXX.', 'X...X', 'X...X', '.XXXX', '....X', '...X.', '.XX..']);
def('!', ['X', 'X', 'X', 'X', 'X', '.', 'X']);
def('?', ['.XXX.', 'X...X', '....X', '...X.', '..X..', '.....', '..X..']);
def('.', ['..', '..', '..', '..', '..', 'XX', 'XX']);
def(',', ['..', '..', '..', '..', 'XX', '.X', 'X.']);
def(':', ['..', 'XX', 'XX', '..', 'XX', 'XX', '..']);
def("'", ['X', 'X', '.', '.', '.', '.', '.']);
def('-', ['....', '....', '....', 'XXXX', '....', '....', '....']);
def('+', ['.....', '..X..', '..X..', 'XXXXX', '..X..', '..X..', '.....']);
def('=', ['....', '....', 'XXXX', '....', 'XXXX', '....', '....']);
def('&', ['.XX..', 'X..X.', 'X.X..', '.X...', 'X.X.X', 'X..X.', '.XX.X']);
def('/', ['....X', '....X', '...X.', '..X..', '.X...', 'X....', 'X....']);
def('(', ['..X', '.X.', 'X..', 'X..', 'X..', '.X.', '..X']);
def(')', ['X..', '.X.', '..X', '..X', '..X', '.X.', 'X..']);
def('#', ['.X.X.', '.X.X.', 'XXXXX', '.X.X.', 'XXXXX', '.X.X.', '.X.X.']);
def('*', ['.....', 'X.X.X', '.XXX.', 'XXXXX', '.XXX.', 'X.X.X', '.....']);
def(' ', ['...', '...', '...', '...', '...', '...', '...']);

export const BANNER_SIZES = {
  1: { sx: 1, sy: 1, name: 'Small' },      // 5 x 7 cells per letter (tall, condensed)
  2: { sx: 2, sy: 1, name: 'Medium' },     // 10 x 7 cells
  3: { sx: 3, sy: 2, name: 'Large' },      // 15 x 14 cells
};

const bannerLines = text => String(text).toUpperCase().split('\n');
const fontOf = ch => F[ch] || F['?'];

// Size of a banner in cells: { cols, rows }.
export function bannerSize(text, opts = {}) {
  const { sx, sy } = BANNER_SIZES[opts.size] || BANNER_SIZES[2];
  const lines = bannerLines(text);
  let cols = 0;
  for (const line of lines) {
    let wpx = 0;
    const chars = Array.from(line);
    chars.forEach((ch, i) => { wpx += fontOf(ch)[0].length + (i < chars.length - 1 ? 1 : 0); });
    cols = Math.max(cols, wpx * sx);
  }
  const rows = (lines.length * FONT_ROWS + (lines.length - 1) * 2) * sy;
  return { cols, rows };
}

// opts: { x0, y0, size: 1 | 2 | 3, glyph: 'self' | chars, ink, pressure, typeface }
export function bannerToStrikes(text, opts = {}) {
  const o = { x0: 0, y0: 0, size: 2, glyph: 'self', ink: 'k', pressure: 1, typeface: 'pica', ...opts };
  const { sx, sy } = BANNER_SIZES[o.size] || BANNER_SIZES[2];
  const out = [];
  let y = o.y0;
  for (const line of bannerLines(text)) {
    let x = o.x0;
    for (const ch of Array.from(line)) {
      const rows = fontOf(ch);
      const own = ch === ' ' ? [] : (F[ch] ? [ch] : ['?']);
      const gl = (!o.glyph || o.glyph === 'self' || o.glyph === 'auto') ? own : Array.from(o.glyph);
      for (let r = 0; r < rows.length; r++) for (let c = 0; c < rows[r].length; c++) {
        if (rows[r][c] !== 'X') continue;
        for (let a = 0; a < sy; a++) for (let b = 0; b < sx; b++) {
          for (const g of gl) out.push(mk(g, x + c * sx + b, y + r * sy + a, o));
        }
      }
      x += (rows[0].length + 1) * sx;
    }
    y += (FONT_ROWS + 2) * sy;
  }
  return clipToPage(out, o.pageCols, o.pageRows);
}

// ---------------------------------------------------------------------------------------------
// Ordering and estimates
// ---------------------------------------------------------------------------------------------

const strikeKey = s => `${s.c}\u0001${s.x}\u0001${s.y}\u0001${s.k}\u0001${s.p}\u0001${s.f}`;

// Typing order: by line (y), then left to right; exact duplicates removed; stacks keep their order.
export function orderStrikes(strikes) {
  const seen = new Set();
  const items = [];
  strikes.forEach((s, i) => {
    const key = strikeKey(s);
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ s, i });
  });
  items.sort((a, b) => (a.s.y - b.s.y) || (a.s.x - b.s.x) || (a.i - b.i));
  return items.map(it => it.s);
}

// Seconds the machine needs to type these strikes at real speed.
export function estimateSeconds(strikes) {
  const lines = new Set(strikes.map(s => s.y)).size;
  return strikes.length / STRIKES_PER_SEC + lines * SECS_PER_LINE;
}

export function formatDuration(sec) {
  if (sec < 1) return 'no time';
  if (sec < 60) return `about ${Math.max(5, Math.round(sec / 5) * 5)} s`;
  const m = sec / 60;
  if (m < 60) return `about ${Math.round(m)} min`;
  const h = Math.floor(m / 60), mm = Math.round(m - h * 60);
  return `about ${h} h ${mm} min`;
}

// ---------------------------------------------------------------------------------------------
// Built-in pictures, drawn in code (greyscale, white paper background, soft vignettes)
// ---------------------------------------------------------------------------------------------
// Each draw(ctx, w, h) works in a 100-unit-wide frame; `aspect` is width / height.

function frame(ctx, w, h, H) {
  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  const k = w / 100;
  ctx.scale(k, h / H);
  return { k, blur: u => `blur(${Math.max(0, u * k).toFixed(2)}px)` };
}

function vignette(ctx, W, H, inner, outer, cx = 0.5, cy = 0.5) {
  ctx.save();
  ctx.translate(W * cx, H * cy);
  ctx.scale(W / 2, H / 2);
  const g = ctx.createRadialGradient(0, 0, inner, 0, 0, outer);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,1)');
  ctx.fillStyle = g;
  ctx.fillRect(-2, -2, 4, 4);
  ctx.restore();
}

function lin(ctx, x0, y0, x1, y1, stops) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const [t, c] of stops) g.addColorStop(t, c);
  return g;
}

function rad(ctx, x, y, r0, r1, stops, x1 = x, y1 = y) {
  const g = ctx.createRadialGradient(x, y, r0, x1, y1, r1);
  for (const [t, c] of stops) g.addColorStop(t, c);
  return g;
}

function ell(ctx, x, y, rx, ry, fill) {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(0.01, rx), Math.max(0.01, ry), 0, 0, Math.PI * 2);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
}

function pine(ctx, x, base, height, width, fill, seed = 1) {
  const r = rng(seed);
  const top = base - height;
  const tiers = Math.max(4, Math.round(height / 5));
  const right = [], left = [];
  for (let i = 0; i < tiers; i++) {
    const t0 = i / tiers, t1 = (i + 1) / tiers;
    const yb = top + (height * 0.92) * t1;
    const hw = (width / 2) * (0.18 + 0.82 * t1) * (0.85 + r() * 0.3);
    const yi = top + (height * 0.92) * t0 + (height / tiers) * 0.55;
    right.push([x + hw * 0.42, yi], [x + hw, yb + 0.6 + r() * 0.8]);
    left.push([x - hw * 0.42, yi + r() * 0.4], [x - hw * (0.9 + r() * 0.2), yb + 0.4 + r() * 0.8]);
  }
  ctx.beginPath();
  ctx.moveTo(x, top);
  for (const [px, py] of right) ctx.lineTo(px, py);
  ctx.lineTo(x + width * 0.06, base - height * 0.06);
  ctx.lineTo(x + width * 0.06, base);
  ctx.lineTo(x - width * 0.06, base);
  ctx.lineTo(x - width * 0.06, base - height * 0.06);
  for (let i = left.length - 1; i >= 0; i--) ctx.lineTo(left[i][0], left[i][1]);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

// circle-circle intersection points
function cci(ax, ay, ar, bx, by, br) {
  const d = Math.hypot(bx - ax, by - ay);
  const a = (ar * ar - br * br + d * d) / (2 * d);
  const hh = Math.sqrt(Math.max(0, ar * ar - a * a));
  const mx = ax + a * (bx - ax) / d, my = ay + a * (by - ay) / d;
  return [[mx + hh * (by - ay) / d, my - hh * (bx - ax) / d], [mx - hh * (by - ay) / d, my + hh * (bx - ax) / d]];
}

function crescentPath(ctx, ax, ay, ar, bx, by, br) {
  const [p, q] = cci(ax, ay, ar, bx, by, br);
  const aP = Math.atan2(p[1] - ay, p[0] - ax), aQ = Math.atan2(q[1] - ay, q[0] - ax);
  const bP = Math.atan2(p[1] - by, p[0] - bx), bQ = Math.atan2(q[1] - by, q[0] - bx);
  ctx.beginPath();
  ctx.arc(ax, ay, ar, aP, aQ, true);         // the outer edge, away from B
  ctx.arc(bx, by, br, bQ, bP, false);        // the inner edge, inside A
  ctx.closePath();
}

function drawTeacup(ctx, w, h) {
  const H = 100 / 1.15;
  const { blur } = frame(ctx, w, h, H);
  // shadow + saucer
  ctx.save(); ctx.filter = blur(2.2); ell(ctx, 51, 76, 42, 6.5, 'rgba(0,0,0,0.42)'); ctx.restore();
  ell(ctx, 50, 72.8, 40.5, 9.2, '#5e5e5e');
  ell(ctx, 50, 71, 41, 9.2, lin(ctx, 0, 62, 0, 80, [[0, '#f4f4f4'], [0.4, '#d6d6d6'], [0.8, '#a2a2a2'], [1, '#808080']]));
  ell(ctx, 50, 70.2, 23, 4.6, lin(ctx, 0, 65.6, 0, 74.8, [[0, '#a9a9a9'], [1, '#e4e4e4']]));
  ctx.save(); ctx.filter = blur(1.2); ell(ctx, 54, 70.4, 16, 3.2, 'rgba(0,0,0,0.55)'); ctx.restore();
  // handle (behind the body's right edge)
  ctx.beginPath();
  ctx.moveTo(74.5, 37.5);
  ctx.bezierCurveTo(93, 33.5, 95, 58, 69.5, 61);
  ctx.lineTo(70.2, 56.8);
  ctx.bezierCurveTo(87, 53.5, 86.5, 41, 75.2, 43.5);
  ctx.closePath();
  ctx.fillStyle = lin(ctx, 72, 36, 92, 60, [[0, '#cfcfcf'], [0.45, '#8c8c8c'], [1, '#3c3c3c']]);
  ctx.fill();
  ctx.lineWidth = 0.5; ctx.strokeStyle = '#4a4a4a'; ctx.stroke();
  // body
  const body = () => {
    ctx.beginPath();
    ctx.moveTo(24, 33);
    ctx.bezierCurveTo(24, 50, 29, 63, 38.5, 67.5);
    ctx.quadraticCurveTo(50, 71, 61.5, 67.5);
    ctx.bezierCurveTo(71, 63, 76, 50, 76, 33);
    ctx.ellipse(50, 33, 26, 6, 0, 0, Math.PI, false);
    ctx.closePath();
  };
  body();
  ctx.fillStyle = lin(ctx, 24, 0, 76, 0, [[0, '#7c7c7c'], [0.1, '#c4c4c4'], [0.3, '#fbfbfb'], [0.46, '#e8e8e8'],
    [0.72, '#a6a6a6'], [0.9, '#5e5e5e'], [1, '#474747']]);
  ctx.fill();
  ctx.save();
  body(); ctx.clip();
  ctx.fillStyle = lin(ctx, 0, 36, 0, 70, [[0, 'rgba(0,0,0,0)'], [0.6, 'rgba(0,0,0,0.05)'], [1, 'rgba(0,0,0,0.32)']]);
  ctx.fillRect(20, 30, 60, 42);
  // decorative band following the curve
  ctx.lineWidth = 3.4;
  ctx.strokeStyle = 'rgba(25,25,25,0.62)';
  ctx.beginPath(); ctx.ellipse(50, 43.2, 26, 6.2, 0, 0.05, Math.PI - 0.05, false); ctx.stroke();
  ctx.lineWidth = 0.9;
  ctx.strokeStyle = 'rgba(25,25,25,0.5)';
  ctx.beginPath(); ctx.ellipse(50, 47.6, 25, 6.2, 0, 0.1, Math.PI - 0.1, false); ctx.stroke();
  ctx.restore();
  // opening: inner wall, tea, rim
  ell(ctx, 50, 33, 26, 6, lin(ctx, 0, 27, 0, 39, [[0, '#bdbdbd'], [1, '#efefef']]));
  ell(ctx, 50, 34.3, 23.2, 4.5, rad(ctx, 45, 33.5, 1, 24, [[0, '#4a4a4a'], [0.6, '#2a2a2a'], [1, '#161616']]));
  ctx.save(); ctx.filter = blur(0.6); ell(ctx, 42, 33.6, 6.5, 1.2, 'rgba(255,255,255,0.4)'); ctx.restore();
  ctx.lineWidth = 0.6; ctx.strokeStyle = '#6a6a6a';
  ctx.beginPath(); ctx.ellipse(50, 33, 26.3, 6.25, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 0.9; ctx.strokeStyle = '#ffffff';
  ctx.beginPath(); ctx.ellipse(50, 33, 25.5, 5.7, 0, 0, Math.PI * 2); ctx.stroke();
  // steam
  ctx.save();
  ctx.filter = blur(0.7);
  ctx.lineCap = 'round';
  const wisps = [[41, 2.6, 0.0, 3.1], [50.5, 3.2, 1.6, 3.4], [59, 2.4, 3.0, 2.8]];
  for (const [x0, amp, ph, lw] of wisps) {
    ctx.beginPath();
    for (let y = 27; y >= 3; y -= 0.5) {
      const t = (27 - y) / 24;
      const x = x0 + Math.sin(t * 5.2 + ph) * amp * (0.4 + t);
      if (y === 27) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.lineWidth = lw;
    ctx.strokeStyle = lin(ctx, 0, 3, 0, 27, [[0, 'rgba(110,110,110,0)'], [0.35, 'rgba(110,110,110,0.6)'], [0.8, 'rgba(110,110,110,0.42)'], [1, 'rgba(110,110,110,0)']]);
    ctx.stroke();
  }
  ctx.restore();
  ctx.restore();
}

function drawMoon(ctx, w, h) {
  const H = 100 / 1.25;
  const { blur } = frame(ctx, w, h, H);
  ctx.fillStyle = lin(ctx, 0, 0, 0, H, [[0, '#262626'], [0.5, '#4c4c4c'], [0.78, '#8e8e8e'], [1, '#c4c4c4']]);
  ctx.fillRect(0, 0, 100, H);
  // glow
  ctx.fillStyle = rad(ctx, 64, 26, 12, 30, [[0, 'rgba(255,255,255,0.42)'], [0.4, 'rgba(255,255,255,0.14)'], [1, 'rgba(255,255,255,0)']]);
  ctx.fillRect(0, 0, 100, H);
  // stars
  const r = rng(7);
  for (let i = 0; i < 26; i++) {
    const x = 6 + r() * 88, y = 3 + r() * 40;
    if (Math.hypot(x - 64, (y - 26) * 1.2) < 21) continue;
    const s = 0.7 + r() * 0.8;
    ctx.fillStyle = '#fff';
    ell(ctx, x, y, s, s * 1.15, '#fff');
    if (s > 1.0) {
      ctx.fillRect(x - s * 2.6, y - 0.2, s * 5.2, 0.4);
      ctx.fillRect(x - 0.2, y - s * 3, 0.4, s * 6);
    }
  }
  // crescent
  crescentPath(ctx, 64, 26, 14, 71, 21, 12.2);
  ctx.fillStyle = rad(ctx, 57, 30, 2, 16, [[0, '#ffffff'], [0.8, '#fafafa'], [1, '#e2e2e2']]);
  ctx.fill();
  ctx.save();
  crescentPath(ctx, 64, 26, 14, 71, 21, 12.2); ctx.clip();
  ctx.filter = blur(0.5);
  ell(ctx, 55.5, 29, 2.2, 2.6, 'rgba(0,0,0,0.1)');
  ell(ctx, 59.5, 36, 1.6, 1.4, 'rgba(0,0,0,0.1)');
  ctx.restore();
  // distant hills and mist
  ctx.beginPath();
  ctx.moveTo(0, 60);
  for (let x = 0; x <= 100; x += 2) ctx.lineTo(x, 58 + Math.sin(x * 0.07) * 2.5 + Math.sin(x * 0.19 + 1) * 1.2);
  ctx.lineTo(100, H); ctx.lineTo(0, H); ctx.closePath();
  ctx.fillStyle = lin(ctx, 0, 54, 0, 68, [[0, '#707070'], [1, '#8c8c8c']]);
  ctx.fill();
  ctx.fillStyle = lin(ctx, 0, 60, 0, 70, [[0, 'rgba(255,255,255,0)'], [0.6, 'rgba(255,255,255,0.45)'], [1, 'rgba(255,255,255,0.1)']]);
  ctx.fillRect(0, 58, 100, 14);
  // far pines
  const far = [[38, 12], [43, 15], [47, 11], [52, 14], [57, 10], [61, 13], [65, 9.5], [70, 12], [74, 10]];
  far.forEach(([x, hh], i) => pine(ctx, x, 70, hh, hh * 0.42, '#4a4a4a', 30 + i));
  // near pines
  const near = [[6, 44, 15], [15, 50, 17], [25, 34, 13], [33, 24, 10], [80, 30, 12], [89, 46, 16], [97, 36, 13]];
  near.forEach(([x, hh, ww], i) => pine(ctx, x, H + 1, hh, ww, '#121212', 50 + i));
  ctx.fillStyle = '#141414';
  ctx.beginPath();
  ctx.moveTo(0, H);
  ctx.lineTo(0, 74); ctx.quadraticCurveTo(30, 71.5, 50, 74.5); ctx.quadraticCurveTo(75, 77, 100, 72.5);
  ctx.lineTo(100, H); ctx.closePath(); ctx.fill();
  vignette(ctx, 100, H, 0.66, 1.02);
  ctx.restore();
}

function drawSailboat(ctx, w, h) {
  const H = 100;
  const { blur } = frame(ctx, w, h, H);
  const horizon = 62;
  ctx.fillStyle = lin(ctx, 0, 0, 0, horizon, [[0, '#8e8e8e'], [0.55, '#c8c8c8'], [1, '#e6e6e6']]);
  ctx.fillRect(0, 0, 100, horizon);
  // clouds
  ctx.save(); ctx.filter = blur(2.2);
  for (const [x, y, r] of [[18, 22, 6], [25, 19, 7.5], [32, 23, 5.5], [76, 12, 5], [84, 10, 6.5], [91, 13, 4.5]]) ell(ctx, x, y, r * 1.3, r * 0.75, 'rgba(255,255,255,0.85)');
  ctx.restore();
  // sea
  ctx.fillStyle = lin(ctx, 0, horizon, 0, H, [[0, '#7c7c7c'], [0.4, '#626262'], [1, '#3a3a3a']]);
  ctx.fillRect(0, horizon, 100, H - horizon);
  ctx.fillStyle = '#5c5c5c'; ctx.fillRect(0, horizon - 0.3, 100, 0.8);
  // waves: rows of crests, bigger towards the viewer
  const rowsY = [65.5, 69.5, 74.5, 80.5, 87.5, 95.5];
  rowsY.forEach((y, ri) => {
    const s = 0.5 + ri * 0.32, len = 5 + ri * 2.4;
    const r = rng(100 + ri);
    for (let x = -len + r() * len; x < 100 + len; x += len * (0.9 + r() * 0.5)) {
      ctx.lineCap = 'round';
      ctx.lineWidth = 0.5 + s * 0.9;
      ctx.strokeStyle = 'rgba(25,25,25,0.55)';
      ctx.beginPath(); ctx.moveTo(x, y + s * 1.6); ctx.quadraticCurveTo(x + len * 0.5, y + s * 0.2, x + len, y + s * 1.6); ctx.stroke();
      ctx.lineWidth = 0.4 + s * 0.7;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath(); ctx.moveTo(x + len * 0.12, y + s * 0.6); ctx.quadraticCurveTo(x + len * 0.5, y - s * 0.9, x + len * 0.86, y + s * 0.4); ctx.stroke();
    }
  });
  // reflection
  ctx.save(); ctx.filter = blur(0.5);
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = `rgba(10,10,10,${0.45 - i * 0.06})`;
    ctx.fillRect(38 + i * 1.6 + Math.sin(i) * 1.5, 75.5 + i * 1.6, 24 - i * 3, 0.9);
  }
  ctx.restore();
  // sails
  ctx.beginPath(); ctx.moveTo(51.2, 17); ctx.quadraticCurveTo(44, 40, 31.5, 63); ctx.lineTo(51.2, 63); ctx.closePath();
  ctx.fillStyle = lin(ctx, 31, 0, 51, 0, [[0, '#bcbcbc'], [0.55, '#e9e9e9'], [1, '#ffffff']]);
  ctx.fill();
  ctx.lineWidth = 0.6; ctx.strokeStyle = '#6e6e6e'; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(53, 19.5); ctx.quadraticCurveTo(63, 42, 71.5, 63); ctx.lineTo(53, 63); ctx.closePath();
  ctx.fillStyle = lin(ctx, 53, 0, 72, 0, [[0, '#ffffff'], [0.5, '#e2e2e2'], [1, '#a4a4a4']]);
  ctx.fill(); ctx.stroke();
  // sail seams
  ctx.lineWidth = 0.35; ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  for (const y of [30, 40, 50]) { ctx.beginPath(); ctx.moveTo(51, y); ctx.lineTo(51 - (y - 17) * 0.42, y + 1.5); ctx.stroke(); }
  // mast and pennant
  ctx.fillStyle = '#1e1e1e'; ctx.fillRect(51.4, 14.5, 1.3, 51);
  ctx.beginPath(); ctx.moveTo(52.6, 14.6); ctx.lineTo(58.5, 16.2); ctx.lineTo(52.6, 17.8); ctx.closePath(); ctx.fill();
  // hull
  ctx.beginPath();
  ctx.moveTo(29, 64.4); ctx.lineTo(75.5, 63.2);
  ctx.quadraticCurveTo(71, 71.5, 62, 73.2); ctx.lineTo(40, 73.2);
  ctx.quadraticCurveTo(33, 71.5, 29, 64.4); ctx.closePath();
  ctx.fillStyle = lin(ctx, 0, 63, 0, 73, [[0, '#3a3a3a'], [1, '#141414']]);
  ctx.fill();
  ctx.lineWidth = 1.1; ctx.strokeStyle = '#f0f0f0';
  ctx.beginPath(); ctx.moveTo(30.5, 65.6); ctx.lineTo(73.8, 64.4); ctx.stroke();
  // gulls
  ctx.lineWidth = 0.75; ctx.strokeStyle = '#2a2a2a'; ctx.lineCap = 'round';
  for (const [x, y, s] of [[17, 33, 4.2], [26, 27, 3.2], [82, 30, 2.6]]) {
    ctx.beginPath(); ctx.moveTo(x - s, y); ctx.quadraticCurveTo(x - s * 0.5, y - s * 0.55, x, y + s * 0.15);
    ctx.quadraticCurveTo(x + s * 0.5, y - s * 0.55, x + s, y); ctx.stroke();
  }
  vignette(ctx, 100, H, 0.7, 1.02);
  ctx.restore();
}

function drawLighthouse(ctx, w, h) {
  const H = 100 / 0.78;
  const { blur } = frame(ctx, w, h, H);
  const sea = 103;
  ctx.fillStyle = lin(ctx, 0, 0, 0, sea, [[0, '#2c2c2c'], [0.55, '#5e5e5e'], [1, '#b4b4b4']]);
  ctx.fillRect(0, 0, 100, sea);
  const r = rng(11);
  for (let i = 0; i < 18; i++) {
    const x = 5 + r() * 90, y = 3 + r() * 45, s = 0.45 + r() * 0.6;
    if (Math.abs(y - 26) < 14 || Math.abs(x - 50) < 12) continue;
    ell(ctx, x, y, s, s * 1.1, 'rgba(255,255,255,0.9)');
  }
  // halo and beams
  ctx.fillStyle = rad(ctx, 50, 27, 2, 22, [[0, 'rgba(255,255,255,0.95)'], [0.35, 'rgba(255,255,255,0.35)'], [1, 'rgba(255,255,255,0)']]);
  ctx.fillRect(0, 0, 100, 60);
  ctx.save(); ctx.filter = blur(1.2);
  ctx.beginPath(); ctx.moveTo(50, 27); ctx.lineTo(-5, 12); ctx.lineTo(-5, 34); ctx.closePath();
  ctx.fillStyle = lin(ctx, 50, 0, -5, 0, [[0, 'rgba(255,255,255,0.85)'], [1, 'rgba(255,255,255,0.05)']]); ctx.fill();
  ctx.beginPath(); ctx.moveTo(50, 27); ctx.lineTo(105, 17); ctx.lineTo(105, 31); ctx.closePath();
  ctx.fillStyle = lin(ctx, 50, 0, 105, 0, [[0, 'rgba(255,255,255,0.8)'], [1, 'rgba(255,255,255,0.04)']]); ctx.fill();
  ctx.restore();
  // tower
  const tower = () => {
    ctx.beginPath(); ctx.moveTo(43, 37); ctx.lineTo(57, 37); ctx.lineTo(61.5, 104); ctx.lineTo(38.5, 104); ctx.closePath();
  };
  tower();
  ctx.fillStyle = lin(ctx, 38, 0, 62, 0, [[0, '#8e8e8e'], [0.28, '#f6f6f6'], [0.55, '#dadada'], [1, '#626262']]);
  ctx.fill();
  ctx.save(); tower(); ctx.clip();
  for (const [y0, y1] of [[45, 55], [65, 75], [85, 95]]) {
    ctx.beginPath();
    ctx.moveTo(30, y0); ctx.quadraticCurveTo(50, y0 + 2.2, 70, y0);
    ctx.lineTo(70, y1); ctx.quadraticCurveTo(50, y1 + 2.2, 30, y1); ctx.closePath();
    ctx.fillStyle = lin(ctx, 38, 0, 62, 0, [[0, '#2a2a2a'], [0.3, '#4e4e4e'], [0.6, '#363636'], [1, '#121212']]);
    ctx.fill();
  }
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(49.2, 59, 1.6, 3.4); ctx.fillRect(49.2, 79, 1.6, 3.4);
  ctx.beginPath(); ctx.moveTo(47.6, 104); ctx.lineTo(47.6, 99.5); ctx.arc(50, 99.5, 2.4, Math.PI, 0); ctx.lineTo(52.4, 104); ctx.fill();
  ctx.restore();
  // gallery, lantern, roof
  ctx.fillStyle = '#1c1c1c';
  ctx.fillRect(40.5, 34.4, 19, 2.8);
  ctx.fillRect(41, 30.2, 18, 0.8);
  for (let x = 41.2; x <= 58.6; x += 2.2) ctx.fillRect(x, 30.2, 0.55, 4.4);
  ctx.fillStyle = rad(ctx, 50, 27, 0.5, 7, [[0, '#ffffff'], [0.7, '#f4f4f4'], [1, '#d0d0d0']]);
  ctx.fillRect(45, 22.5, 10, 8);
  ctx.fillStyle = '#2a2a2a';
  for (const x of [45, 47.8, 51.6, 54.4]) ctx.fillRect(x, 22.5, 0.6, 8);
  ctx.beginPath(); ctx.moveTo(43.4, 23); ctx.quadraticCurveTo(50, 13, 56.6, 23); ctx.closePath();
  ctx.fillStyle = '#161616'; ctx.fill();
  ell(ctx, 50, 15.2, 1.1, 1.1, '#161616');
  ctx.fillRect(49.7, 11.5, 0.6, 3.5);
  // sea
  ctx.fillStyle = lin(ctx, 0, sea, 0, H, [[0, '#7a7a7a'], [1, '#383838']]);
  ctx.fillRect(0, sea, 100, H - sea);
  ctx.lineCap = 'round';
  for (let ri = 0; ri < 7; ri++) {
    const y = sea + 3 + ri * 3.6, s = 0.6 + ri * 0.25, len = 6 + ri * 1.6;
    const rr = rng(200 + ri);
    for (let x = -len + rr() * len; x < 100 + len; x += len * (1 + rr() * 0.6)) {
      ctx.lineWidth = 0.4 + s * 0.6; ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + len * 0.5, y - s, x + len, y); ctx.stroke();
    }
  }
  // rocks
  const rocks = [
    [[24, 112], [27, 104.5], [33, 101.5], [38, 102], [41, 106], [42, 112]],
    [[36, 112], [38.5, 102.5], [46, 99.6], [55, 100], [62, 103], [64, 112]],
    [[58, 112], [61, 104], [67, 102.6], [73, 105], [77, 112]],
  ];
  for (const poly of rocks) {
    ctx.beginPath(); poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
    ctx.fillStyle = lin(ctx, 0, 99, 0, 112, [[0, '#6c6c6c'], [0.35, '#3a3a3a'], [1, '#161616']]);
    ctx.fill();
  }
  // foam at the rocks
  ctx.save(); ctx.filter = blur(0.8);
  for (const [x, y, rx] of [[26, 112, 6], [44, 112.6, 9], [66, 112.2, 8], [78, 111.5, 4]]) ell(ctx, x, y, rx, 1.4, 'rgba(255,255,255,0.85)');
  ctx.restore();
  vignette(ctx, 100, H, 0.68, 1.02, 0.5, 0.48);
  ctx.restore();
}

function drawRose(ctx, w, h) {
  const H = 100 / 0.8;
  const { blur } = frame(ctx, w, h, H);
  // stem
  ctx.lineCap = 'round';
  ctx.lineWidth = 2.6; ctx.strokeStyle = '#3a3a3a';
  ctx.beginPath(); ctx.moveTo(50, 56); ctx.bezierCurveTo(52, 75, 45, 95, 47, 121); ctx.stroke();
  ctx.lineWidth = 0.9; ctx.strokeStyle = '#6e6e6e';
  ctx.beginPath(); ctx.moveTo(50.6, 58); ctx.bezierCurveTo(52.6, 75, 45.6, 95, 47.6, 120); ctx.stroke();
  ctx.fillStyle = '#2e2e2e';
  for (const [x, y, d] of [[51.2, 68, 1], [48.4, 88, -1], [46.6, 106, 1]]) {
    ctx.beginPath(); ctx.moveTo(x, y - 1.6); ctx.lineTo(x + d * 3, y - 2.6); ctx.lineTo(x, y + 0.6); ctx.closePath(); ctx.fill();
  }
  // leaves
  const leaf = (x0, y0, x1, y1, bulge) => {
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const nx = -(y1 - y0), ny = x1 - x0, nl = Math.hypot(nx, ny);
    const ox = nx / nl * bulge, oy = ny / nl * bulge;
    ctx.beginPath(); ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(mx + ox, my + oy, x1, y1);
    ctx.quadraticCurveTo(mx - ox, my - oy, x0, y0); ctx.closePath();
    ctx.fillStyle = lin(ctx, x0, y0, x1, y1, [[0, '#2a2a2a'], [0.6, '#4a4a4a'], [1, '#6a6a6a']]);
    ctx.fill();
    ctx.lineWidth = 0.6; ctx.strokeStyle = '#9a9a9a';
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(mx + ox * 0.15, my + oy * 0.15, x1, y1); ctx.stroke();
    for (let t = 0.25; t < 0.85; t += 0.18) {
      const px = x0 + (x1 - x0) * t, py = y0 + (y1 - y0) * t;
      ctx.lineWidth = 0.35;
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + ox * 0.6 + (x1 - x0) * 0.08, py + oy * 0.6 + (y1 - y0) * 0.08); ctx.stroke();
    }
  };
  ctx.lineWidth = 1.4; ctx.strokeStyle = '#3a3a3a';
  ctx.beginPath(); ctx.moveTo(49.4, 82); ctx.quadraticCurveTo(44, 80, 41, 78.5); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(47.4, 98); ctx.quadraticCurveTo(52, 96, 56, 94.5); ctx.stroke();
  leaf(41, 78.5, 20, 70, 6.5);
  leaf(56, 94.5, 78, 88, -6.5);
  // sepals
  ctx.fillStyle = '#2c2c2c';
  for (const [x1, y1, x2, y2] of [[50, 54, 38, 58], [50, 54, 62, 58.5], [50, 55, 47, 62]]) {
    ctx.beginPath(); ctx.moveTo(x1 - 2, y1); ctx.quadraticCurveTo((x1 + x2) / 2, y2 - 3, x2, y2); ctx.quadraticCurveTo((x1 + x2) / 2 + 1, y1 + 2, x1 + 2, y1 + 1); ctx.closePath(); ctx.fill();
  }
  // bloom from the side: a shaded cup whose opening shows the spiral of rolled inner petals, three
  // overlapping front petals with light lips, two curled tips at the rim
  ctx.save(); ctx.filter = blur(2.4); ell(ctx, 53, 53, 21, 5.5, 'rgba(0,0,0,0.3)'); ctx.restore();
  const shape = (path, fill) => { ctx.beginPath(); path(); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); };
  const shadowLine = (path, a = 0.3, w = 2.4) => {
    ctx.save(); ctx.filter = blur(1.1); ctx.lineCap = 'round'; ctx.lineWidth = w; ctx.strokeStyle = `rgba(20,20,20,${a})`;
    ctx.beginPath(); path(); ctx.stroke(); ctx.restore();
  };
  const lip = (path, w = 1.3) => { ctx.save(); ctx.lineCap = 'round'; ctx.lineWidth = w; ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.beginPath(); path(); ctx.stroke(); ctx.restore(); };
  // cup body, lit from the left
  shape(() => { ctx.moveTo(29, 21); ctx.bezierCurveTo(25, 37, 34, 53, 50, 56); ctx.bezierCurveTo(66, 53, 75, 37, 71, 21); ctx.bezierCurveTo(64, 25, 57, 26.5, 50, 26.5); ctx.bezierCurveTo(43, 26.5, 36, 25, 29, 21); },
    lin(ctx, 26, 0, 74, 0, [[0, '#bdbdbd'], [0.35, '#9a9a9a'], [0.7, '#666666'], [1, '#3c3c3c']]));
  // the opening and its spiral
  ell(ctx, 50, 21, 21, 7, rad(ctx, 47, 21, 1, 21, [[0, '#2e2e2e'], [0.65, '#505050'], [1, '#7a7a7a']]));
  ctx.save(); ctx.translate(50.5, 21.2); ctx.scale(1, 0.34); ctx.lineCap = 'round';
  for (const [w, col, dr] of [[3.2, '#dedede', 0], [1.3, '#161616', -2.4]]) {
    ctx.lineWidth = w; ctx.strokeStyle = col; ctx.beginPath();
    for (let k = 0; k <= 150; k++) {
      const th = k * 0.09, rr = 18 - th * 1.25 + dr;
      if (rr < 1) break;
      const x = Math.cos(th + 2.0) * rr, y = Math.sin(th + 2.0) * rr;
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();
  lip(() => { ctx.ellipse(50, 21, 21, 7, 0, Math.PI * 1.05, Math.PI * 1.95); }, 1.1);
  // curled tips at the rim
  shape(() => { ctx.moveTo(30.5, 22); ctx.quadraticCurveTo(25, 19, 23.5, 14.5); ctx.quadraticCurveTo(29.5, 15.5, 33.5, 20.5); }, '#e8e8e8');
  shape(() => { ctx.moveTo(69.5, 22); ctx.quadraticCurveTo(75, 19, 76.5, 14.5); ctx.quadraticCurveTo(70.5, 15.5, 66.5, 20.5); }, '#b0b0b0');
  // front petals: left, right, then the middle one over both
  shape(() => { ctx.moveTo(29, 21.5); ctx.bezierCurveTo(27.5, 37, 36, 50, 50, 55.5); ctx.bezierCurveTo(46, 45, 46.5, 35, 53, 27); ctx.bezierCurveTo(43, 27.5, 35.5, 25.5, 29, 21.5); },
    lin(ctx, 29, 22, 50, 55, [[0, '#f2f2f2'], [0.45, '#cdcdcd'], [1, '#808080']]));
  shadowLine(() => { ctx.moveTo(53.5, 28); ctx.bezierCurveTo(47.5, 35.5, 47, 45, 51, 55); }, 0.32, 2.6);
  shape(() => { ctx.moveTo(71, 21.5); ctx.bezierCurveTo(72.5, 37, 64, 50, 50, 55.5); ctx.bezierCurveTo(53.5, 46, 55.5, 37, 51.5, 29.5); ctx.bezierCurveTo(59.5, 28.5, 65.5, 25.5, 71, 21.5); },
    lin(ctx, 71, 22, 50, 55, [[0, '#c6c6c6'], [0.45, '#8e8e8e'], [1, '#4a4a4a']]));
  lip(() => { ctx.moveTo(29.5, 22); ctx.bezierCurveTo(36, 25.8, 43, 27.6, 52.5, 27.2); });
  lip(() => { ctx.moveTo(70.5, 22); ctx.bezierCurveTo(65.5, 25.6, 59.5, 28.4, 52, 29.6); }, 1.0);
  shadowLine(() => { ctx.moveTo(37, 41.5); ctx.bezierCurveTo(43, 37.8, 57, 37.8, 63, 41.5); }, 0.26, 2.2);
  shape(() => { ctx.moveTo(37, 40); ctx.bezierCurveTo(42, 35.5, 58, 35.5, 63, 40); ctx.bezierCurveTo(62.5, 49, 57, 55.5, 50, 56.5); ctx.bezierCurveTo(43, 55.5, 37.5, 49, 37, 40); },
    lin(ctx, 0, 36, 0, 57, [[0, '#f6f6f6'], [0.35, '#d6d6d6'], [1, '#868686']]));
  lip(() => { ctx.moveTo(37.4, 40); ctx.bezierCurveTo(42, 36, 58, 36, 62.6, 40); });
  ctx.restore();
}

export const SAMPLES = [
  { id: 'teacup', name: 'Teacup', aspect: 1.15, draw: drawTeacup },
  { id: 'moon', name: 'Moon over pines', aspect: 1.25, draw: drawMoon },
  { id: 'sailboat', name: 'Sailboat', aspect: 1.0, draw: drawSailboat },
  { id: 'lighthouse', name: 'Lighthouse', aspect: 0.78, draw: drawLighthouse },
  { id: 'rose', name: 'Rose', aspect: 0.8, draw: drawRose },
];

// Browser helper: render a sample (or any CanvasImageSource) to ImageData of the given width.
export function pictureImageData(src, width, aspect) {
  const w = Math.max(8, Math.round(width));
  const a = aspect || (src.width && src.height ? src.width / src.height : 1);
  const h = Math.max(8, Math.round(w / a));
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  if (src && typeof src.draw === 'function') src.draw(ctx, w, h);
  else ctx.drawImage(src, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}
