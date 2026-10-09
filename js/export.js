// Image export helpers (pure, no DOM): lift the ink off the paper, and crop to what was typed.

// The page is ink multiplied onto paper: result = paper * T, with T the ink's transmittance per
// channel. Given the page and the paper alone, recover T and either
//   'white': put the same ink on pure white (T * 255), or
//   'clear': turn it into colour + alpha that looks identical over white and works over anything.
export function separateInk(page, paper, mode = 'clear') {
  const n = page.length, out = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i += 4) {
    const tr = Math.min(1, page[i] / Math.max(1, paper[i]));
    const tg = Math.min(1, page[i + 1] / Math.max(1, paper[i + 1]));
    const tb = Math.min(1, page[i + 2] / Math.max(1, paper[i + 2]));
    if (mode === 'white') {
      out[i] = tr * 255; out[i + 1] = tg * 255; out[i + 2] = tb * 255; out[i + 3] = 255;
      continue;
    }
    let a = 1 - Math.min(tr, tg, tb);
    if (a < 0.035) { out[i + 3] = 0; continue; }          // paper fibres, not ink
    a = Math.min(1, (a - 0.035) / 0.965);
    // white * (1 - a) + c * a = t   =>   c = (t - 1 + a) / a
    out[i] = Math.max(0, (tr - 1 + a) / a) * 255;
    out[i + 1] = Math.max(0, (tg - 1 + a) / a) * 255;
    out[i + 2] = Math.max(0, (tb - 1 + a) / a) * 255;
    out[i + 3] = a * 255;
  }
  return out;
}

// Union of rects ({x, y, w, h}) grown by pad and clamped to W x H; null when there is nothing.
export function cropRect(rects, pad, W, H) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    if (!r || r.w <= 0 || r.h <= 0) continue;
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  if (!isFinite(x0)) return null;
  x0 = Math.max(0, Math.floor(x0 - pad)); y0 = Math.max(0, Math.floor(y0 - pad));
  x1 = Math.min(W, Math.ceil(x1 + pad)); y1 = Math.min(H, Math.ceil(y1 + pad));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Copy a rect out of an RGBA buffer of width W.
export function cropData(data, W, rect) {
  const out = new Uint8ClampedArray(rect.w * rect.h * 4);
  for (let y = 0; y < rect.h; y++) {
    const s = ((rect.y + y) * W + rect.x) * 4;
    out.set(data.subarray(s, s + rect.w * 4), y * rect.w * 4);
  }
  return out;
}

// A file name that says what it is: platen-page-2.png, platen-page-2-ink.png, platen-photo.png
export function exportName(what, pageNo, bg) {
  if (what === 'photo') return 'platen-photo.png';
  return `platen-page-${pageNo}${what === 'ink' ? '-ink' : ''}${bg === 'clear' ? '-transparent' : ''}.png`;
}
