# Platen — module contract

Platen is a cozy typewriter simulator for the web: a 3D manual typewriter (Three.js) you type on
with your keyboard, with procedural paper, ribbon ink and mechanical sounds. Two modes:

- **Write**: real typewriter behaviour. The strike point is fixed at the centre of the screen; the
  carriage (platen + paper) slides left one character per keystroke, the margin bell rings eight
  characters before the right margin, Enter throws the carriage back with a line feed. Backspace
  moves the carriage back; with correction tape on it lifts the character off (a faint ghost stays).
- **Draw**: typewriter art. Arrow keys move the carriage and roll the platen in half steps,
  an overstrike lock lets you stack characters, and a Planner lets you sketch shapes or drop in a
  picture which the machine then types out by itself, clack by clack.

Static ES modules, no build step, no npm runtime dependencies. Three.js r185 is vendored in
`js/vendor/` and mapped with an import map (`import * as THREE from 'three'`).
Dev server: `node dev-server.js` -> http://localhost:8875. Headless checks:
`node tools/shoot.mjs "/dev/page.html" --name foo` writes `shots/foo.png` (see the header of
tools/shoot.mjs; pages set `window.__done = {ok:true, ...}` when they are ready, and set
`window.__pending = true` early if they need more than 4 s).

Everything user-visible is in English.

## Shared conventions

### Page grid (js/ink.js exports `GRID`)

US Letter, pica pitch: 10 characters per inch, 6 lines per inch.

| constant | value | meaning |
|---|---|---|
| `COLS` | 85 | character cells across the sheet (8.5 in) |
| `ROWS` | 66 | lines down the sheet (11 in) |
| `CW` | 24 | page-texture pixels per column at scale 1 |
| `RH` | 40 | page-texture pixels per row at scale 1 |
| `W`,`H` | 2040, 2640 | page texture size at scale 1 (240 px per inch) |

A cell `(x, y)` covers texture pixels `[x*CW, (x+1)*CW) × [y*RH, (y+1)*RH)` at scale 1. `x` and `y`
are floats: Write mode uses whole numbers, Draw mode also uses halves (half-space, half-line).
The glyph is drawn so a monospace typeface with a 0.6 em advance fills the cell width exactly
(font size = `CW / 0.6` = 40 px at scale 1) with its baseline at `y*RH + 0.74*RH`.

### Strike (one impact of a typebar on the paper)

```js
{ c: 'a',      // the character (one grapheme)
  x: 12, y: 7, // cell position (floats allowed)
  k: 'k',      // ink id, see INKS
  p: 1.0,      // pressure, 0.3 .. 1.5 (1 = a normal firm keystroke)
  s: 123456,   // uint32 seed; every random detail of this impression comes from it
  f: 'pica',   // typeface id, see TYPEFACES
  w: 0.2 }     // ribbon wear at the time of the strike, 0 = fresh ribbon .. 1 = worn out
```

Rendering a strike must be a pure function of the strike (plus the paper): drawing the same
strikes again gives the same pixels. Overstrikes accumulate ink (draw on top, multiply).

A **ghost** is a strike that was lifted off with correction tape; it is stored as the strike plus
`g: 1` and renders as a very faint impression (the dent and a whisper of ink remain).

A **page** is `{ id, paper: 'ivory', strikes: [...], ghosts: [...], created: epochMs }`.

### Shared helpers

`js/util.js`: `hash32(...parts)`, `rng(seed)` (mulberry32, returns floats in [0,1)), `gauss(r)`,
`clamp`, `lerp`, `smoothstep`, easing functions, `newSeed()`.

### UI look (css tokens, defined in css/app.css; panels written by others use these)

Old-money, cozy, tactile: cream paper panels, brass hairlines, deep hunter green and oxblood
accents, serif headings, typewriter labels. No neon, no glassmorphism, no emoji in the UI.

```css
--ui-paper: #f3ead6;  --ui-paper-2: #e9dec4;  --ui-ink: #2a221c;  --ui-ink-2: #5a4c3f;
--ui-line: rgba(70, 52, 34, .22);  --ui-brass: #b08d57;  --ui-brass-2: #8c6b3c;
--ui-green: #2f4a3a;  --ui-oxblood: #6a2328;  --ui-shadow: 0 14px 40px rgba(18, 10, 4, .38);
--ui-serif: 'Cormorant Garamond', Georgia, serif;   /* headings */
--ui-type: 'Courier Prime', 'Courier New', monospace; /* labels, buttons, values */
--ui-radius: 10px;
```

Google Fonts loaded by index.html (dev pages must load the same link):
`https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=Courier+Prime:ital,wght@0,400;0,700;1,400&family=Cutive+Mono&family=Special+Elite&display=swap`

## Modules and owners

| file | what | owner |
|---|---|---|
| `js/audio.js` | procedural typewriter sound engine + ambiences + offline render | audio agent |
| `js/ink.js` | paper textures, ribbon inks, typefaces, `PageSurface` ink renderer | ink agent |
| `js/art.js`, `js/planner.js`, `css/planner.css` | Draw-mode conversion (image/shapes -> strikes) and the Planner panel | art agent |
| `js/page.js` | page model, carriage state machine, text export | main |
| `js/machine.js`, `js/scene.js` | the 3D typewriter, desk, lights, camera | main |
| `js/app.js`, `js/ui.js`, `js/store.js`, `index.html`, `css/app.css` | app glue, panels, persistence | main |

Each owner also writes its own `dev/<name>.html` test page. Don't edit files you don't own; if you
need a change elsewhere, say so in your final report.

---

## js/audio.js

All sound is synthesised in JS (no samples, no network). Buffers are generated once (several
random variants per sound, so repeated keys never sound identical) and played through a small
graph: per-voice gain + stereo pan -> machine bus -> (dry + short warm room reverb) -> master.
Ambience loops go to their own bus. It must sound like a real 1950s–60s manual typewriter recorded
close up in a quiet room (ASMR): layered mechanical events, not single beeps or white-noise clicks.

```js
export const AMBIENCES = [ { id: 'rain', name: 'Rain on the window' }, { id: 'fire', name: 'Fireplace' },
                           { id: 'clock', name: 'Mantel clock' }, { id: 'night', name: 'Summer night' } ];
export const PROFILES  = [ { id: 'portable', name: 'Portable' }, { id: 'desk', name: 'Desk machine' } ];

export class TypewriterAudio {
  constructor()                 // creates the AudioContext (it may start suspended)
  ready                         // Promise, resolves once all buffers exist
  unlock()                      // call inside a user gesture; resumes the context
  get context()
  // mix (all 0..1)
  setMaster(v); setMachine(v); setAmbience(id | null); setAmbienceLevel(v); setProfile(id); setBell(on)
  // mechanical events. o = { pan: -1..1, intensity: 0..1.5 (default 1), at: seconds from now (default 0), char }
  key(o)                 // character key: key travel + typebar strike + escapement tick
  space(o)               // space bar: thunk + escapement
  backspace(o)           // back-space key + carriage stepping back
  shift(down, o)         // the segment shift (heavy clunk down, softer clunk up)
  bell(o)                // margin bell
  carriageReturn({ cols, lines }) -> { duration }   // lever + line-feed ratchet + slide + stop
  lineFeed({ lines, up })  // platen ratchet clicks only (line up/down, half lines count as 1 click)
  carriageMove({ cols })   // quick carriage reposition without a return (draw mode / tab)
  jam(o)                   // a key pressed while the carriage is locked at the margin
  knob({ clicks })         // turning the platen knob by hand
  paperIn(); paperOut()    // feeding / pulling a sheet
  correction(o)            // the lift-off tape dab (soft papery tap) used with backspace erase
  // offline (for the demo video)
  startRecording(clock)    // clock() -> seconds; from now on events are logged, not played
  stopRecording() -> events  // [{ t, name, args }]
  async renderOffline(events, duration, { master, machine, ambience, ambienceLevel, profile }) -> AudioBuffer
  static encodeWav(audioBuffer) -> ArrayBuffer      // 16-bit PCM stereo
}
```

## js/ink.js

```js
export const GRID = { COLS: 85, ROWS: 66, CW: 24, RH: 40, W: 2040, H: 2640 };
export const PAPERS = [ { id: 'ivory', name: 'Cotton Ivory', swatch: '#…' }, { id: 'bond', name: 'Bright Bond' },
  { id: 'laid', name: 'Laid Cream' }, { id: 'aged', name: 'Aged Parchment' }, { id: 'onion', name: 'Onionskin' },
  { id: 'kraft', name: 'Kraft' } ];
export const INKS = { k: { name: 'Black', color }, r: { name: 'Red' }, n: { name: 'Navy' }, s: { name: 'Sepia' }, v: { name: 'Violet' } };
export const RIBBONS = [ { id: 'black', name: 'Black', inks: ['k'] }, { id: 'blackred', name: 'Black & Red', inks: ['k', 'r'] },
  { id: 'navy', name: 'Navy', inks: ['n'] }, { id: 'sepia', name: 'Sepia', inks: ['s'] }, { id: 'violet', name: 'Violet copy', inks: ['v'] } ];
export const TYPEFACES = [ { id: 'pica', name: 'Pica', family: 'Courier Prime' },
  { id: 'elite', name: 'Elite', family: 'Special Elite' }, { id: 'cutive', name: 'Cutive', family: 'Cutive Mono' } ];
export async function loadFonts()        // resolves when all three families are usable on canvas
export function strikeRect(strike, scale = 1) -> { x, y, w, h }   // canvas px the strike may touch
export class PageSurface {
  constructor({ paper = 'ivory', scale = 1 })   // canvas is GRID.W*scale × GRID.H*scale, opaque
  canvas; width; height; scale; paper
  version                     // increments on every change
  setPaper(id)                // regenerates the paper and redraws the ink it knows about
  render(strikes, ghosts = [])  // full redraw
  add(strike) -> rect         // draw one more impression on top; returns the dirty rect
  redraw(rect, strikes, ghosts) // repaint a region from scratch (after a lift-off)
  takeDirty() -> rect | null  // union of dirty rects since the last call (for partial GPU uploads)
  paperCanvas                 // the paper alone (same size)
  bumpCanvas                  // greyscale height map of the paper fibres (may be smaller), for 3D lighting
}
```

## js/art.js and js/planner.js

```js
// art.js — pure functions (canvas only to measure glyph darkness)
export async function densityRamp(typefaceId) -> [ { glyphs: ['#'], density: 0..1 } ... ]   // light -> dark, measured
export function imageToStrikes(imageData, opts) -> strikes   // opts: { x0, y0, cols, rows?, halfRows, style:
                    //  'shade' | 'line' | 'stipple', contrast, brightness, gamma, invert, ink, typeface }
export function shapesToStrikes(shapes, opts) -> strikes    // shapes: pencil / line / rect / ellipse strokes and fills, in page cells
export function orderStrikes(strikes) -> strikes            // typing order: top to bottom, left to right per line
export const SAMPLES = [ { id, name, draw(ctx, w, h) } ]     // built-in pictures drawn in code (no image files)
// planner.js — the Planner panel (a large overlay sheet)
export class Planner {
  constructor(host, { PageSurface, getPage, typeface, ink, onCommit })   // onCommit(strikes) when "Type it" is pressed
  open(); close(); get isOpen()
}
```
Strikes returned by art.js carry `c, x, y, k, p, f`; the app adds `s` (seed) and `w` when typing them.

## js/page.js (main)

Carriage state machine and text export: `Carriage` with `col`, `row`, margins, line spacing,
`type(ch)`, `space()`, `back()`, `ret()`, bell and lock logic, and `pageText(page)`.

## js/machine.js + js/scene.js (main)

The 3D machine: enamel body in an old-money colour (Hunter Green, Oxblood, Navy, Cream, Camel,
Tobacco, Sage, Slate, Claret, Ebony), chrome or brass trim, glass-top keys, typebar basket,
ribbon spools, carriage with platen, knobs, paper bail and return lever, and the sheet of paper
whose texture is a `PageSurface.canvas`.
