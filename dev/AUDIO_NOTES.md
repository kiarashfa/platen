# Platen audio engine: design notes and measurements

`js/audio.js` is a fully procedural Web Audio engine (no samples, no network, imports only
`./util.js`). Test bench: `dev/audio.html`. Analysis tools: `tools/audio-*`.

## For the integrator

```js
import { TypewriterAudio, AMBIENCES, PROFILES, carriageEase } from './audio.js';
const audio = new TypewriterAudio();      // context may start suspended
addEventListener('pointerdown', () => audio.unlock(), { once: true });   // and on the first keydown
await audio.ready;                        // about 0.1 s: both profiles' buffers
```

- **Faders** (`setMaster`, `setMachine`, `setAmbienceLevel`) take 0..1 and apply gain = v².
  Defaults: master 0.9, machine 1, ambience level 0.5, profile `portable`, bell on, no ambience.
  Changes glide over about 30 ms.
- **Events called before `ready`** play nothing but still return their value.
- **Pan**: pass the key's position on the keyboard as `o.pan`. The engine places each layer
  where it happens on a real machine: the keytop tick and key return at `o.pan`, the typebar
  strike near the centre (`pan * 0.15`), the escapement at the carriage (-0.08). Defaults when
  `o.pan` is missing: bell +0.3, return lever -0.45, return slide sweeps -0.4 to +0.2, margin stop
  +0.2, knob +0.55, paper in +0.1, everything else 0.
- **`at`** schedules relative to now (seconds), on the audio clock.
- **Profiles**: `setProfile('desk')` switches instantly (both banks are built in `ready`).

### Timing for animation sync (all return values are plain objects)

| call | returns | what happens when (seconds after `at`) |
|---|---|---|
| `key(o)` | `{ strike, escape }` | keytop tick at 0; typebar hits the platen at `strike` (12-25 ms, faster when `intensity` is high); escapement / carriage step at `escape` (+20-38 ms after the strike); key returns 65-115 ms after the strike |
| `space(o)` | `{ strike, escape }` | bar bottoms out at `strike` (8-14 ms); escapement 18-32 ms later; bar returns 80-120 ms after |
| `backspace(o)` | `{ strike, escape }` | keytop tick; backspace lever clack at `strike` (16-24 ms); carriage steps back at `escape` |
| `shift(down, o)` | `{ strike }` | basket clunk at `strike` (10-16 ms down, 4-8 ms up) |
| `bell(o)` | `{ duration: 1.5 }` | trip click at 0, the strike on the dome 12-22 ms later; `{ duration: 0 }` when the bell is off |
| `carriageReturn({ cols, lines })` | `{ duration }` | `duration = 0.12 + 0.004 * cols`. Lever click at 0; line-space ratchet clicks at 12 ms, +34 ms per line (max 4); the carriage slides from 0 to `duration` and **the margin-stop thunk lands exactly at `duration`** |
| `carriageMove({ cols })` | `{ duration }` | `clamp(0.045 + 0.0045 * |cols|, 0.04, 0.5)`; for `|cols| <= 1` only a soft escapement tick at 4 ms |
| `lineFeed({ lines, up })` | `{ duration }` | `ceil(|lines|)` ratchet clicks 50 ms apart (half lines = 1 click); `up` is softer and slightly lower |
| `knob({ clicks })` | `{ duration }` | clicks 60-120 ms apart, like a hand turning |
| `paperIn()` | `{ duration: 1.55 }` | sheet touches the platen at 0.06; knob ratchet clicks from 0.14 to 1.36 (the hand speeds up, then slows); paper bail snaps back at 1.47 |
| `paperOut()` | `{ duration: 1.2 }` | release lever at 0; paper drag from 0.1 to 1.14; the sheet leaves with a soft flap at 1.13 |
| `jam(o)` | `{ strike }` | keytop tick, then the key bottoms out on the lock at `strike` |
| `correction(o)` | `{ duration: 0.1 }` | play it right after `backspace()` (e.g. `at: 0.15`) |

**Carriage motion.** `carriageEase(u)` (exported, an addition to the SPEC) returns the fraction
of the carriage travel done at `u = t / duration`. It is the integral of the velocity profile the
rack rattle is synthesised from: a quick push over the first 13 %, then a steady slow-down from
1.3 to 0.75 so the carriage still hits the stop with speed. Values: 0.1 -> 0.05, 0.25 -> 0.24,
0.5 -> 0.53, 0.75 -> 0.78, 0.9 -> 0.92. Animate `carriageReturn` and `carriageMove` with it and
the clicks will match the moving carriage.

### Recording and offline render (demo video)

- `startRecording(clock)`: from now on events are logged, not played; return values are the
  same. `clock` is optional (default: seconds since the call). Each logged event carries a `seed`
  in its options, so the offline render reproduces exactly the variants and timings that would
  have played.
- `events` are `{ t, name, args }` with `args` in the public call form (`shift` is
  `[down, o]`). You can also write them by hand. `t` is seconds from the start of the render.
- `renderOffline(events, duration, opts)` builds the same graph (one `buildGraph` for live and
  offline) in an `OfflineAudioContext`, stereo, at the live context's rate if it is 44.1/48 kHz,
  otherwise 48 kHz. `opts`: `master, machine, ambience, ambienceLevel, profile` as in the SPEC,
  plus (additions) `bell` (bool), `sampleRate`, `limiter` (false bypasses compressor + clipper,
  for measurement). Missing opts fall back to the live settings. The ambience fades in over 0.4 s.
  12.3 s renders in about 0.75 s.
- `TypewriterAudio.encodeWav(buffer)` -> 16-bit PCM stereo WAV (TPDF dither).

### Ambiences

- Built lazily on the first `setAmbience(id)` (or `renderOffline` with that ambience), **in a
  module worker that loads this same file** (`new Worker(import.meta.url, { type: 'module' })`),
  so the page never stalls. If workers are unavailable it falls back to the main thread in
  yielding chunks. Generation takes 0.12-0.5 s in Node; 0.3-1.9 s wall clock in the headless test
  browser.
- Switching crossfades (time constant 0.45 s out, 0.5 s in); a loop starts at a random offset.
- Memory: each loop is 40 s stereo float (15 MB; the clock is 30 s, 11.5 MB). Machine buffers
  are 2.2 MB (portable) and 3.0 MB (desk) at 48 kHz, measured with `tools/audio-bench.mjs`.

### Additions to the SPEC API (nothing renamed)

- `export function carriageEase(u)`.
- Return values listed in the timing table (`key`, `space`, `backspace`, `shift`, `jam` return
  `{ strike, escape? }`; `bell`, `lineFeed`, `carriageMove`, `knob`, `paperIn`, `paperOut`,
  `correction` return `{ duration }`).
- `renderOffline` opts `bell`, `sampleRate`, `limiter`.
- Getters `profile`, `ambience`; `stats` (build and generation times); `ambienceBuffer(id)`
  (dev: the raw loop). `o.seed` (uint32) is accepted by every event to force a variant.

## Architecture

```
voice: AudioBufferSource -> [high shelf for intensity != 1] -> Gain -> StereoPanner ─┐
                                                                                     v
machine bus (x1.414: undoes the pan law's -3 dB) -> machine fader -> DynamicsCompressor
  (threshold -9 dB, knee 6, ratio 4, attack 2 ms, release 120 ms) -> trim -2.9 dB
  ├─ dry ───────────────────────────────────────────────┐
  └─ Convolver (mono in, stereo small-room IR) x 0.15 ──┤
ambience loop -> fade gain -> ambience fader ───────────┤
                                                        v
                         mix -> master fader -> soft clipper -> destination
```

- **The compressor's automatic makeup gain** is +2.90 dB at these settings in Chromium
  (measured with `tools/audio-compcal.js`; the Web Audio spec defines it, so Firefox and Safari
  should match). The trim cancels it: limited and unlimited renders of fast typing have the same
  RMS (-30.57 vs -30.47 dBFS); the compressor only shaves about 1 dB off the loudest peaks.
- **Soft clipper**: a WaveShaper that is exactly linear below 0.6 (-4.4 dBFS) and bends smoothly
  (tanh) towards a 0.98 ceiling; a 0.5 pre-gain lets it handle overs up to +6 dBFS. It never
  engaged in any test render.
- **Ambience bypasses the compressor**, so typing never pumps the rain.
- **Room**: synthetic stereo IR, 0.55 s: 14 early reflections in the first 2-28 ms (slightly
  smeared), then decorrelated noise in three bands with RT60 0.40 s (< 450 Hz), 0.30 s
  (450 Hz-2.8 kHz) and 0.16 s (> 2.8 kHz). Energy-normalised; wet send 0.15 (about -16 dB of
  the dry energy): a quiet room, recorded close.

## How the sounds are made

Common method: an **excitation** (half-sine contact pulse whose width sets the hardness, area
normalised so wider = duller at the same force, plus a tiny exponentially decaying noise burst for
surface roughness) drives **banks of two-pole resonators** (modes with their own frequency, T60
and gain), plus the excitation itself high-passed (the impact heard directly) and short filtered
noise for paper and friction. The machine is one physical object: its mode tables (frame,
escapement, ratchet, bell...) are fixed per profile from a seed, and each variant only jitters
the coupling (gains ±50 %), decays (±15-30 %) and frequencies (±0.3-3 %). Variants per sound:
24 strikes (4 basket zones x 6), 8 escapements and ratchet clicks, 4-6 of everything else;
the same variant never plays twice in a row. Buffers are trimmed at -68 dB and faded. Strike,
space, escapement, tick, key-up, ratchet and knob variants are levelled by their loudest 4 ms
(RMS), then by group median peak, so a lucky noise spike cannot make one keystroke jump out.

Levels below are peak dBFS per channel at full faders, centre pan, before the compressor.

### Character key (`key`)
1. **Keytop tick** (glass top, chrome rim): 0.08 ms pulse into 4 modes 2.2-6.5 kHz (T60 3-9 ms)
   and 2 key-lever modes 650-1500 Hz. Measured -20 to -24 dB below the strike.
2. **Travel**: 12-22 ms / (0.65 + 0.35 x intensity); measured 17-26 ms.
3. **Strike** (the clack, -6.5 dBFS nominal; measured -6 to -10.5 dBFS sample peak, 1 ms RMS
   within 2.6 dB over 8 strikes): a pre-tick through the type guide 1-2 ms before, the main hit
   (0.09-0.16 ms contact) with 1-3 chatter hits in the first 2 ms, and a rebound 3-6 ms later at
   12-28 %. They drive: the slug/platen contact (8 modes 1.4-6.5 kHz, T60 6-20 ms, the clack
   colour), a dense shimmer of 12 very short modes 5-11.5 kHz (T60 2-6 ms), the typebar as a
   free bar (540 Hz portable / 470 Hz desk, ratios 1, 2.76, 5.40, 8.93, damped by the platen:
   T60 16-36 ms x the profile decay), 14 frame/segment modes 600 Hz-5 kHz (T60 20-80 ms scaled by
   (1200 / f)^0.45, so highs die first), the thin cover plates
   (3 modes 420-1500 Hz, portable only), the rubber platen thud (270 Hz + 1.63x, T60 20-30 ms;
   desk 195 Hz), the body (205/330 Hz portable; 118/168/245 Hz desk, T60 50-90 ms), the direct
   click (excitation high-passed at 2 kHz) and a ribbon/paper slap (noise 2.5-10 kHz, 0.9 ms).
   Attack 0.10-0.15 ms (10-90 %). Spectral centroid of the first 7 ms: 1.7-2.2 kHz portable,
   0.6-1.4 kHz desk. Decay: -20 dB in 3-7 ms, -40 dB in 42-63 ms (including room).
4. **Escapement** (-17 dBFS nominal; measured -8 to -14 dB re the strike, 24-39 ms after it):
   the dog releases (small tick) and 3-7 ms later the carriage stops on the next tooth: 7 modes
   1.8-5.6 kHz (T60 6-30 ms), a faint "ting" at 2.6-3.4 kHz (T60 50-75 ms), two 700-1400 Hz
   modes and the carriage mass at 175 Hz.
5. **Key return** (-28 dBFS nominal; measured -16 to -19.5 dB re the strike, 66-105 ms after
   it): two soft (0.4 and 0.8 ms) felt-damped hits through 6 modes 500-2800 Hz and 220 Hz.
- **Per character**: each typebar pair (`a`/`A`, `1`/`!`...) has a fixed place in the basket
  (from a hash). Distance from the centre picks one of 4 zones: edge bars are longer (typebar
  and clack modes -3.5 % per zone, ring +8 % per zone) and each character gets a fixed
  playback-rate nudge of ±1.5 %. Small slugs (`. , ' \``) are 2.5 dB lighter and 3 % brighter;
  wide letters (`m w M W @ # % &`) are 0.8 dB heavier.
- **Intensity** (0..1.5): strike gain I^1.3 below 1 and 1 + 0.45 (I - 1) above, a high shelf of
  5 x (I - 1) dB at 2.5 kHz, and above 1.05 an extra body thump (body modes + 0.75 x platen
  frequency, 1.2 ms soft pulse). Capitals with `intensity: 1.3` measure 1-3 dB louder and
  bassier (portable -5.8 dBFS, desk -2.5 dBFS raw).

### Space bar (`space`)
The bar bottoms out at both ends 1.5-4.5 ms apart (0.4 ms pulses: a softer, wider contact) into
the bar's beam modes (300 Hz portable / 245 Hz desk, ratios 1-8.93, T60 20-45 ms), the frame at
30 % and the body; then the escapement, then a soft double rattle as the bar springs back.
-9 dBFS, centroid 1.4 kHz (desk 1.0 kHz).

### Backspace (`backspace`)
Keytop tick, the backspace lever's clack (beam modes from 610 Hz, frame at 50 %, body) at -13 dBFS,
the carriage stepping back (an escapement variant played 12 % slower, -18 dBFS), key return.

### Shift (`shift`)
Down: a soft 0.9 ms hit into three heavy low modes (112/168/240 Hz portable, 86/128/196 Hz desk,
T60 55-90 ms) and 3 mid modes 320-700 Hz, plus a clatter of 7-12 tiny hits spread over 40 ms
through the basket's 6 modes 1.5-6 kHz and the frame. -11 dBFS. Up: 60 % of the low clunk,
3-5 clatter hits over 25 ms, -16 dBFS.

### Margin bell (`bell`)
Trip click (3 modes 3-6 kHz) then, 12-22 ms later, the hammer on a small brass dome. Partials of
the dome (portable f1 = 2420 Hz; desk 1980 Hz): ratios 1 and 1.0021 (a 5 Hz beat), 2.29 and
2.2935 (8 Hz beat), 4.07 and 4.076, 6.55, 9.2 (skipped above 0.46 x sample rate); T60 1.5, 1.35,
0.95, 0.85, 0.5, 0.45, 0.3, 0.18 s (x1.3 on the desk). Plus a short 520 Hz hammer/post knock.
-12.5 dBFS nominal (measured -8.7 portable / -10.5 desk, the room adds to a sustained tone);
-20 dB at 0.3 s, -40 dB at 0.9-1.0 s.

### Carriage return (`carriageReturn`)
Lever click (the return lever as a bent beam from 520 Hz, frame) -> 1-4 platen ratchet clicks
34 ms apart -> the slide, synthesised per call and cached: one rack tick per column crossed
(3 modes 2.1-5 kHz, T60 3-7 ms, plus a direct click; tick strength follows speed^0.8) over
friction noise (280 Hz-2.6 kHz with a bump at 900 Hz, level ~ speed^1.3) and a rolling rumble
(< 160 Hz), panned from left to right -> the **margin-stop thunk** at `duration`: carriage mass
on the stop (128 Hz x 1, 1.6, 2.5 portable; 92 Hz desk; T60 50-150 ms), a clack (5 modes
500-2500 Hz), the frame ringing longer, two faint rings 1.1-3.4 kHz, and 3-5 bounces at 6-45 ms
with falling force. Loudness scales with cols (factor 0.55 + 0.45 x min(1, cols / 50)): measured
-9.9 dBFS for 10 columns, -6.8 for 60. Rattle peaks sit 10-15 dB under the thunk.

### Line feed, knob, carriage move
- **Ratchet click**: pawl lifts (small tick), drops into the next tooth 2-4 ms later, a tiny
  settle; 5 modes 2-7 kHz, 2 platen modes 900-1600 Hz, a 260 Hz platen thud. -17 dBFS.
- **Knob click**: the same ratchet with a softer pulse, slightly lower, plus the rubber knob
  (420 Hz, 12 ms). -21 dBFS.
- **Carriage move**: the slide model, quieter and with less friction (-21 dBFS), ending on a
  light escapement tick; single steps are just a soft tick.

### Paper (`paperIn`, `paperOut`) and `correction`
- **Paper in**: the sheet tapping the platen (noise 300-2500 Hz), 20-25 knob ratchet clicks with
  varying force, paper hiss (1.5-7.5 kHz, bump at 3.5 kHz, slow wobble, 19 Hz flutter, a small
  jerk after each click), crinkle (Poisson 35/s micro-ticks through 2 short modes), the bail
  snapping back (4 modes 0.9-3.5 kHz). -11.4 dBFS peak.
- **Paper out**: release lever clack, then the drag: noise through a band-pass sweeping
  1.3 -> 3.2 kHz as the sheet speeds up plus broadband 0.6-9 kHz, flutter at 18 -> 30 Hz with a
  random wander, crinkle, and a soft low flap (250-1500 Hz) as the sheet leaves. -11 dBFS peak.
- **Correction**: a muffled strike (0.7 ms pulse into damped clack modes and the platen thud), a
  papery noise burst 0.9-6 kHz, then 3-6 micro-crackles 25-75 ms later as the tape peels off.
  -16.8 dBFS, centroid 1 kHz.
- **Jam**: keytop tick, then a dull 0.9 ms thud into 3 modes 150-500 Hz with a faint chink of
  typebars (1.6-3.2 kHz). -14.2 dBFS, centroid 250 Hz.

### Profiles
| | portable | desk |
|---|---|---|
| mode pitch | x1.00 | x0.87 |
| ring decays | x0.85 | x1.25 |
| typebar fundamental | 540 Hz | 470 Hz |
| platen thud | 270 Hz | 195 Hz |
| body modes | 205, 330 Hz (light) | 118, 168, 245 Hz (strong) |
| thin cover plates | full | 25 % |
| click / slap | 1.0 | 0.85 |
| bell | 2420 Hz, x1.0 decay | 1980 Hz, x1.3 decay |
| margin stop | 128 Hz | 92 Hz |
| shift clunk | 112/168/240 Hz | 86/128/196 Hz |

### Ambiences (seamless loops, stereo, levels at ambience level 1)
- **Rain on the window** (40 s, RMS -24 dBFS, peak -6.9): pink noise high-passed at 560 Hz
  (4th order) and low-passed at 6-7.5 kHz with a +2.5 dB bump at 2.3 kHz, swelling slowly (0.05,
  0.13, 0.31 Hz) with a little 5-7 Hz flutter; a low-passed brown wash (140-900 Hz) and a far
  rumble (35-110 Hz); about 90 droplet ticks per second on the glass (power-law amplitudes over
  36 dB, 4 families of pane modes 2.4-8 kHz, T60 3-6 ms); a heavier drip with splatter every
  2 s; a soft rising plink of a drip outside every 5 s.
- **Fireplace** (40 s, RMS -25 dBFS, peak -7.7): brown-noise roar below 300 Hz plus a
  280-800 Hz band, breathing (random wander at 0.18 Hz plus 0.07/0.23 Hz) and flicker (2-6 Hz);
  a faint hiss (2.8-9 kHz); crackles: Poisson 8/s plus clusters of 3-12 snaps (0.7 clusters/s),
  1-4 random-sign samples through 5 families of short wood modes 1.1-6.4 kHz (T60 1.5-4.5 ms)
  with a direct click; a sap pop (woody 450-1800 Hz knock and a spray of micro-crackles) every
  8 s. Centroid 360 Hz.
- **Mantel clock** (30 s, exactly 30 periods; peak -14 dBFS, RMS -44): tick at 0 s, tock at
  0.508 s (a slightly out-of-beat clock), each a double click (drop, then lock 2.6/3.5 ms later)
  through metal pallet modes (tick 3.1-7.9 kHz, tock 2.65-7.3 kHz) and different wooden case
  modes (tick 330-2100 Hz, tock 290-1720 Hz, T60 30-60 ms), a 215 Hz hollow-case mode, the coiled
  gong barely touched (531 and 1373 Hz, very faint), a whisper of room tail; panned slightly right
  with a 0.3 ms inter-channel delay; faint room tone (pink < 600 Hz, about -66 dBFS).
- **Summer night** (40 s, RMS -27 dBFS, peak -10.9): five field crickets (3.9-5 kHz carrier
  gliding down 2.5 % per syllable, a faint 2nd harmonic) at distances 1-4.2 (gain falls as
  d^-1.25), chirps of 2-4 syllables (11-16 ms, every 27-35 ms) every 0.38-0.62 s, each cricket
  singing for 4-14 s and resting 1.5-6 s, with a wall reflection 8-20 ms later; two far tree
  crickets (continuous 48/53 Hz trills at 2.95/3.18 kHz, tuned to repeat exactly over the loop);
  soft wind (pink below 420 Hz) and leaves (1.8-5 kHz) swelling with gusts.

Seams (end -> start) are invisible in the measurements: the jump across the seam is below the
99.9th percentile of ordinary sample-to-sample steps for every loop, and the RMS around the seam
is within 1.2 dB of the median (the clock seam lands on a tick by design).

## Measured (48 kHz, Chromium headless; full tables in `shots/audio-analysis.txt`)

- Buffer build: 56-60 ms portable + 33-38 ms desk (about 90-100 ms for both), room IR 14-24 ms.
- Fast typing, 12 keys/s with spaces: peak -5.9 dBFS through the limiter (-4.9 raw), RMS -30.5
  dBFS, median peak-to-valley between keys 44.6 dB (keys stay separate, no smear), no clipping.
  Desk: peak -5.0, 43.7 dB.
- Demo (12.3 s, rain at 0.45, master 0.9): peak -6.6 dBFS, RMS -34.7 dBFS, 0 clipped samples.
- Catalog (`shots/audio-cat-*.png`): keys -6 to -10 dBFS (soft key -14, period -10, capital -5.8),
  space -8.8, backspace -13.4, shift -11 / -16, bell -8.7, return -9.9 (10 cols) / -6.8 (60),
  line feed -14.6, knob -18.4, move -20, jam -14.2, paper in -11.4, paper out -11, correction
  -16.8 (portable; desk within about 2 dB, except capitals at -2.5 and the 60-column return at
  -5.6).

## Re-running the checks

```
node tools/shoot.mjs "/dev/audio.html?render=1" --name audio --timeout 240000   # or render=catalog | amb | demo
python tools/audio-analyze.py            # PNGs + shots/audio-analysis.json (args: catalog | demo | fast | amb)
ffmpeg -y -i shots/audio-demo.wav -codec:a libmp3lame -b:a 192k shots/audio-demo.mp3
node tools/audio-bench.mjs               # synthesis timings in Node
node tools/shoot.mjs "/dev/audio.html" --noshot --eval "import('/tools/audio-livetest.js').then(m => m.default())"
node tools/shoot.mjs "/dev/audio.html" --noshot --eval "import('/tools/audio-compcal.js').then(m => m.default())"
```

## Known limits

- Nobody has listened to it: everything was tuned by measurement (spectrograms, envelopes,
  levels) against the anatomy of a real machine, not against a recording. The parameters most
  worth adjusting by ear are the strike's balance (`clack`, `shimmer`, slap and thud gains in
  `strike()`), `LV` (per-event levels) and `ROOM_WET`.
- The compressor trim is measured in Chromium only.
- Ambience loops repeat every 30-40 s; the rain and fire have no rare events (thunder, a log
  falling) on purpose, because they would be recognisable on every loop.
- Every event creates 3 nodes per layer (source, gain, panner; plus a shelf for non-default
  intensity): a keystroke is 4 layers. Disconnected on `ended`.
