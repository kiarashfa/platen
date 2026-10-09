// The intro film: drives the real app on a virtual clock, one frame at a time.
// Loaded by app.js when the page has ?film. tools/film.mjs calls FILM.renderAt(t) for every frame,
// screenshots it, then FILM.soundtrack() renders the recorded sound events to a WAV.
import { newPage, LAYOUT } from './page.js';
import { COLORS } from './machine.js';
import { SAMPLES, pictureImageData, imageToStrikes, orderStrikes } from './art.js';
import { clamp, lerp, easeInOutCubic } from './util.js';

const DURATION = 40;
const COLORS_SHOWN = ['oxblood', 'navy', 'cream', 'camel', 'tobacco', 'sage', 'slate', 'claret', 'ebony', 'hunter'];
const NAMES = { oxblood: 'Oxblood', navy: 'Admiralty Navy', cream: 'Ivory Cream', camel: 'Camel', tobacco: 'Tobacco',
  sage: 'Sage', slate: 'Slate Blue', claret: 'Claret', ebony: 'Ebony', hunter: 'Hunter Green' };

// camera keys: t, dist, elev, tUp, zoom, az, look, tx (target x: negative puts the machine right of centre)
const CAM = [
  [0.0, 92, 0.6, -2.5, 1.0, -0.42, 0, -21],
  [3.4, 80, 0.5, -3, 1.0, -0.2, 0, -14],
  [4.6, 70, 0.45, -3, 1.0, 0.0, 0, 0],
  [5.6, 70, 0.43, -1.6, 1.62, 0.0, 0, 0],
  [12.6, 70, 0.43, -1.6, 1.68, -0.03, 0, 0],
  [13.8, 72, 0.47, -3, 1.0, -0.18, 0, 0],
  [20.6, 72, 0.47, -3, 1.0, 0.18, 0, 0],
  [22.4, 70, 0.44, -1.6, 1.55, 0.0, 0, 0],      // close on the print point while it draws
  [27.6, 70, 0.44, -1.6, 1.6, 0.0, 0, 0],
  [27.9, 70, 0.46, -1.0, 1.22, 0.0, 6.4, 0],    // (under the fade) the finished picture
  [31.4, 72, 0.47, -1.0, 1.18, 0.0, 6.4, 0],
  [36.0, 74, 0.47, -1.0, 1.15, 0.0, 6.4, 0],
  [40.0, 84, 0.5, -1.5, 1.05, 0.0, 6.4, 0],
];

function camAt(t) {
  let i = 0;
  while (i < CAM.length - 2 && t > CAM[i + 1][0]) i++;
  const a = CAM[i], b = CAM[i + 1];
  const u = easeInOutCubic(clamp((t - a[0]) / (b[0] - a[0]), 0, 1));
  return a.map((v, k) => lerp(v, b[k], u));
}

const CSS = `
body.film .brand, body.film .tools, body.film .status, body.film .drawbar, body.film .progress, body.film .welcome, body.film .toast, body.film .kbd-btn { display: none !important; }
.film-layer { position: fixed; inset: 0; pointer-events: none; z-index: 50; font-family: 'Cormorant Garamond', Georgia, serif; color: #f3e7c9; }
.film-layer .cap { position: absolute; opacity: 0; will-change: opacity, transform; }
.film-title { left: 120px; top: 34%; text-align: left; text-shadow: 0 4px 30px rgba(0,0,0,.65); }
.film-title h1 { margin: 0; font-style: italic; font-weight: 600; font-size: 168px; line-height: 1; letter-spacing: .01em; }
.film-title p { margin: 18px 0 0; font: 400 26px 'Courier Prime', monospace; letter-spacing: .32em; text-transform: uppercase; color: #e2cf9f; }
.film-title i { display: block; width: 160px; height: 2px; margin: 28px 0 0 4px; background: linear-gradient(90deg, #c9a466, transparent); }
.film-lower { left: 64px; bottom: 60px; padding: 30px 60px 34px 32px; text-shadow: 0 2px 18px rgba(0,0,0,.7);
  background: radial-gradient(ellipse 75% 85% at 35% 55%, rgba(9, 6, 4, .66), rgba(9, 6, 4, .3) 55%, transparent 78%); }
.film-lower small { display: block; font: 700 18px 'Courier Prime', monospace; letter-spacing: .3em; text-transform: uppercase; color: #d8bd84; margin-bottom: 10px; }
.film-lower span { display: block; font-style: italic; font-weight: 500; font-size: 54px; line-height: 1.05; }
.film-swatch { display: inline-block; width: 30px; height: 30px; border-radius: 50%; margin-right: 16px; vertical-align: -2px; box-shadow: 0 0 0 2px #c9a466, 0 3px 10px rgba(0,0,0,.5); }
.film-black { inset: 0; background: #070504; }
.film-top { left: 0; right: 0; top: 54px; text-align: center; text-shadow: 0 2px 18px rgba(0,0,0,.6); }
.film-top small { display: block; font: 700 17px 'Courier Prime', monospace; letter-spacing: .3em; text-transform: uppercase; color: #d8bd84; margin-bottom: 8px; }
.film-top span { font-style: italic; font-weight: 500; font-size: 44px; }
body.film .gd-root, body.film [class^="gd-"] { transition: none !important; }
.film-end { inset: 0; display: grid; place-content: center; text-align: center; background: radial-gradient(ellipse at 50% 50%, rgba(18,11,6,.62), rgba(10,6,3,.9)); }
.film-end h1 { margin: 0; font-style: italic; font-weight: 600; font-size: 150px; line-height: 1; color: #f3e7c9; }
.film-end .url { margin-top: 26px; font: 700 34px 'Courier Prime', monospace; letter-spacing: .04em; color: #e6cf98; }
.film-end .sub { margin-top: 18px; font: 400 21px 'Courier Prime', monospace; letter-spacing: .3em; text-transform: uppercase; color: #bfae8c; }
`;

export async function setup(app) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  document.body.classList.add('film');
  const layer = document.createElement('div');
  layer.className = 'film-layer';
  layer.innerHTML = `
    <div class="cap film-title" id="fTitle"><h1>Platen</h1><p>a cozy typewriter for the web</p><i></i></div>
    <div class="cap film-lower" id="fSound"><small>sound</small><span>Every clack, bell and carriage return<br>is synthesised as you type.</span></div>
    <div class="cap film-lower" id="fColor"><small>old-money enamels</small><span><b class="film-swatch" id="fSw"></b><em id="fName" style="font-style:italic">Oxblood</em></span></div>
    <div class="cap film-lower" id="fDraw"><small>draw mode</small><span>Sketch it, or drop in a picture.<br>It types it out at a typist's pace.</span></div>
    <div class="cap film-lower" id="fDone"><small>a few minutes later</small><span>Typewriter art, on real-looking paper.</span></div>
    <div class="cap film-black" id="fBlack"></div>
    <div class="cap film-top" id="fGuide"><small>guide mode</small><span>Type it yourself, on your own typewriter.</span></div>
    <div class="cap film-end" id="fEnd"><div><h1>Platen</h1><div class="url">winchxyz.github.io/platen</div><div class="sub">free · open source · in your browser</div></div></div>`;
  document.body.append(layer);

  // a clean, private run: nothing is saved, the clock is ours
  app.store.save = () => {};
  app.store.saveNow = async () => true;
  app.manual = true;
  let vt = 0;
  app.clock = () => vt;
  app.stage.clock = () => vt;
  app.state.pages = [newPage('ivory')];
  app.state.current = 0;
  Object.assign(app.s, { color: 'hunter', trim: null, keycaps: 'glass', paper: 'ivory', ribbon: 'black', red: false, wear: 0.1,
    typeface: 'pica', mood: 'lamp', mode: 'write', spacing: 1, lineEnds: 'manual', correction: 'tape', marginL: 14, marginR: 52, closeup: false });
  app.applyAll();
  app.apply('paper');
  app.surface.render([], []);
  app.texReady = false;
  app.car.col = 14; app.car.row = LAYOUT.TOP;
  app.machine.setColumn(14, 0);
  app.machine.paperState = 'gone';
  app.machine.paper.visible = false;
  if (app.audio) { await app.audio.ready; app.audio.startRecording(() => vt); }

  const $ = id => document.getElementById(id);
  const fade = (el, t, a, b, f = 0.5) => {
    const o = clamp(Math.min((t - a) / f, (b - t) / f), 0, 1);
    el.style.opacity = o.toFixed(3);
    el.style.transform = `translateY(${((1 - o) * 14).toFixed(1)}px)`;
  };

  // picture for the draw scene
  const sample = SAMPLES.find(s => s.id === 'teacup') || SAMPLES[0];
  const img = pictureImageData(sample, 240, sample.aspect);
  const cols = 34;
  const art = orderStrikes(imageToStrikes(img, { x0: Math.round((85 - cols) / 2), y0: 9, cols, style: 'shade', typeface: 'pica', ink: 'k' }));

  const cues = [
    [0.25, () => { app.machine.feedPaper(LAYOUT.TOP, 1.4); app.snd('paperIn'); }],
    [4.6, () => app.typeText('Dear reader,\nSome things are better typed slowly,\none key at a time.', { rhythm: 0.74 })],
    ...COLORS_SHOWN.map((c, i) => [14.0 + i * 0.66, () => { app.s.color = c; app.apply('color'); }]),
    [20.9, () => { app.s.mood = 'lamp'; app.nextSheet({ reason: 'new' }); }],
    [22.3, () => {
      // the sparse steam rows are already on the sheet; the camera arrives as the cup itself is typed
      app.s.mode = 'draw'; app.apply('mode'); app.s.speed = 1;
      const rows = [...new Set(art.map(s => s.y))].sort((a, b) => a - b);
      const dense = rows.find(y => art.filter(s => s.y === y).length > 14) ?? rows[0];
      const pre = art.filter(s => s.y < dense), rest = art.filter(s => s.y >= dense);
      app._instant(pre.map(s => ({ t: 'strike', ...s })), 0);
      app.typeArt(rest);
    }],
    [27.78, () => { app.finishJob(); }],
    [31.3, async () => {
      // the guide sheet for the same drawing
      const mod = await import('./guide.js');
      app.guide = app.guide || new mod.Guide(document.getElementById('guideHost'), { PageSurface: app.surface.constructor });
      app.guide.open({ strikes: art, title: 'Teacup', typeface: 'pica', paper: 'ivory', PageSurface: app.surface.constructor });
    }],
    [33.1, () => app.guide && app.guide.next()],
    [33.9, () => app.guide && app.guide.next()],
    [34.7, () => app.guide && app.guide.next()],
    [36.2, () => { if (app.guide) app.guide.close(); }],
  ];
  let ci = 0;

  const FILM = {
    fps: 30, duration: DURATION, artStrikes: art.length,
    renderAt(t) {
      vt = t;
      while (ci < cues.length && cues[ci][0] <= t) cues[ci++][1]();
      const [, dist, elev, tUp, zoom, az, look, tx] = camAt(t);
      const st = app.stage;
      st.camParams = { dist, elev, tUp, down: 0, tx };
      st.zoom = zoom;
      st.drift.set(az / 0.05, 0); st.driftTarget.copy(st.drift);
      st.look = st.lookTarget = look;
      fade($('fTitle'), t, 0.7, 3.9, 0.7);
      fade($('fSound'), t, 8.6, 12.8, 0.5);
      fade($('fColor'), t, 14.1, 20.7, 0.45);
      const k = clamp(Math.floor((t - 14.0 - 0.24) / 0.66), 0, COLORS_SHOWN.length - 1);
      const cid = COLORS_SHOWN[k];
      $('fName').textContent = NAMES[cid];
      $('fSw').style.background = (COLORS.find(c => c.id === cid) || COLORS[0]).hex;
      fade($('fDraw'), t, 22.9, 27.3, 0.5);
      fade($('fBlack'), t, 27.45, 28.15, 0.3);
      $('fBlack').style.transform = 'none';
      fade($('fDone'), t, 28.5, 31.2, 0.5);
      fade($('fGuide'), t, 99, 100, 0.5);
      fade($('fEnd'), t, 36.3, 46, 0.9);
      app.forceRender = true;
      app.frame(t);
      return { t, strikes: app.page.strikes.length, job: !!app.job };
    },
    async soundtrack() {
      if (!app.audio) return { ok: false, error: 'no audio' };
      const events = app.audio.stopRecording();
      const buf = await app.audio.renderOffline(events, DURATION, { master: 0.9, machine: 1, ambience: 'fire', ambienceLevel: 0.62, profile: 'portable' });
      const wav = app.audio.constructor.encodeWav(buf);
      const r = await fetch('/__file?name=film.wav', { method: 'POST', body: wav });
      return { ok: r.ok, events: events.length, seconds: buf.duration };
    },
  };
  window.FILM = FILM;
  window.__done = { ok: true, film: true, art: art.length };
  return FILM;
}
