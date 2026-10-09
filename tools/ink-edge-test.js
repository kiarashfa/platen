// Robustness checks for js/ink.js, run inside the dev page:
//   node tools/shoot.mjs "/dev/ink.html?crop=ivory;z=1" --name x --noshot --w 400 --h 200 --eval "import('/tools/ink-edge-test.js').then(t => t.run())"
// Returns an object of check results (all should be true / small).
export async function run() {
  const m = await import('/js/ink.js');
  const out = {};
  const S = new m.PageSurface({ paper: 'bond', scale: 1 });
  const odd = ['W', 'é', '€', '😀', 'Ω', '́', '', ' ', '_', '|', '¶', 'ß', 'Ж', '漢'];
  const strikes = [];
  let seed = 1;
  // corners and beyond the edges
  for (const [x, y] of [[-1, -1], [0, 0], [84, 0], [84.5, 65.5], [85, 66], [-0.5, 30], [42, 65], [42, -0.5], [100, 100]]) {
    strikes.push({ c: 'M', x, y, k: 'k', p: 1.5, s: seed++, f: 'elite', w: 0 });
  }
  odd.forEach((c, i) => strikes.push({ c, x: 5 + i, y: 10, k: 'v', p: 1, s: seed++, f: 'cutive', w: 0.5 }));
  // missing fields
  strikes.push({ c: 'q', x: 3, y: 12 });
  let threw = null;
  try { for (const s of strikes) S.add(s); } catch (e) { threw = String(e.stack || e); }
  out.addNoThrow = threw || true;
  // ghost through add(), then compare a clipped redraw to a full render
  const ghost = { c: 'Z', x: 20, y: 20, k: 'k', p: 1.2, s: 99, f: 'pica', w: 0.1, g: 1 };
  const over = { c: 'A', x: 20, y: 20, k: 'k', p: 1, s: 100, f: 'pica', w: 0.1 };
  S.add(ghost); S.add(over);
  const R = m.strikeRect(over, 1);
  const before = S.imageData.data.slice();
  S.redraw({ x: R.x + 5, y: R.y + 7, w: 13, h: 21 }, S._strikes, S._ghosts);
  let maxd = 0;
  const a = S.imageData.data;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - before[i]); if (d > maxd) maxd = d; }
  out.redrawClipMaxDiff = maxd;
  // render() equals the add() sequence (ghosts first, so compare against a surface built that way)
  const T = new m.PageSurface({ paper: 'bond', scale: 1 });
  T.render(S._strikes, S._ghosts);
  const U = new m.PageSurface({ paper: 'bond', scale: 1 });
  U.render([], S._ghosts); for (const s of S._strikes) U.add(s);
  let md = 0; const ta = T.imageData.data, ua = U.imageData.data;
  for (let i = 0; i < ta.length; i++) { const d = Math.abs(ta[i] - ua[i]); if (d > md) md = d; }
  out.renderVsAddMaxDiff = md;
  // strikeRect bounds are clipped to the canvas
  out.rectOutside = m.strikeRect({ x: 100, y: 100 }, 1);
  out.rectCorner = m.strikeRect({ x: -1, y: -1 }, 1);
  // version + dirty behave
  const v0 = S.version; S.takeDirty();
  S.add({ c: 'x', x: 50, y: 50, s: 5 });
  out.versionBumped = S.version === v0 + 1;
  out.dirty = S.takeDirty();
  out.dirtyCleared = S.takeDirty() === null;
  // setPaper keeps the ink it knows about
  const before2 = S.imageData.data[(m.strikeRect(over, 1).y + 20) * S.width * 4 + (m.strikeRect(over, 1).x + 20) * 4];
  S.setPaper('kraft');
  out.setPaperKeepsInk = S._strikes.length;
  out.paperAfter = S.paper;
  out.unknownPaper = (S.setPaper('nope'), S.paper);
  // scales
  for (const sc of [0.15, 0.2, 0.25, 0.5, 1.5]) {
    const P = new m.PageSurface({ paper: 'laid', scale: sc });
    const t0 = performance.now();
    P.render(strikes.filter(s => s.c), [ghost]);
    out['scale' + sc] = { w: P.width, h: P.height, ms: Math.round(performance.now() - t0), paperMs: Math.round(P.stats.paperMs) };
    P.dispose();
  }
  return out;
}
