// Small shared helpers: deterministic randomness and math.

// 32-bit string/number hash (FNV-1a over the UTF-16 units of the joined parts).
export function hash32(...parts) {
  let h = 0x811c9dc5;
  const s = parts.join('\u0001');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32: tiny, fast, good enough for jitter and textures. Returns floats in [0, 1).
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Gaussian-ish sample from a uniform rng (sum of three, mean 0, sd ~0.5).
export const gauss = r => (r() + r() + r() - 1.5);

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
export const easeInOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutBack = (t, s = 1.4) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2);

// A fresh random uint32 for new strikes (not deterministic on purpose).
export const newSeed = () => (Math.random() * 4294967296) >>> 0;
