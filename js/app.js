// Platen: glue between the keyboard, the carriage rules, the ink, the 3D machine and the sound.
import * as THREE from 'three';
import { Stage } from './scene.js';
import { Machine, COLORS, PRINT } from './machine.js';
import { PageSurface, RIBBONS, INKS, loadFonts } from './ink.js';
import { Carriage, LAYOUT, newPage, pageText, wordCount, keyFor, fingerWeight } from './page.js';
import { Store } from './store.js';
import { UI } from './ui.js';
import { newSeed, clamp, rng } from './util.js';

export const DEFAULTS = {
  color: 'hunter', trim: null, keycaps: 'glass', paper: 'ivory', ribbon: 'black', red: false, wear: 0.12,
  typeface: 'pica', mood: 'lamp',
  volume: 0.85, profile: 'portable', bell: true, ambience: null, ambienceLevel: 0.5,
  spacing: 1, lineEnds: 'manual', correction: 'tape', marginL: LAYOUT.MARGIN_L, marginR: LAYOUT.MARGIN_R, closeup: false,
  mode: 'write', over: false, half: true, pressure: 1, speed: 1,
  welcomed: false,
};

const isTouch = matchMedia('(pointer: coarse)').matches;

class App {
  constructor() {
    this.clock = () => performance.now() / 1000;
    this.store = new Store();
    this.state = { settings: { ...DEFAULTS }, pages: [], current: 0 };
    this.lastKeyAt = 0;
    this.heldKeys = new Map();       // event.code -> key id (to release the 3D key)
    this.job = null;                 // auto-typing job
    this.audio = null;
    this.uploads = 0;
  }

  get s() { return this.state.settings; }
  get page() { return this.state.pages[this.state.current]; }
  now() { return this.clock(); }

  // ------------------------------------------------------------ boot
  async boot() {
    const fontsReady = loadFonts().catch(() => {});
    const saved = await this.store.load();
    if (saved) {
      this.state.settings = { ...DEFAULTS, ...saved.settings };
      this.state.pages = saved.pages.length ? saved.pages : [];
      this.state.current = clamp(saved.current | 0, 0, Math.max(0, this.state.pages.length - 1));
    }
    if (!this.state.pages.length) this.state.pages.push(newPage(this.s.paper));
    if (![1, 2].includes(this.s.speed)) this.s.speed = 1;      // the old 3x / 10x speeds are gone
    await fontsReady;

    this.stage = new Stage(document.getElementById('stage'), { clock: () => this.now() });
    this.machine = new Machine();
    this.stage.scene.add(this.machine.group);
    this.surface = new PageSurface({ paper: this.page.paper, scale: 1 });
    this.surface.render(this.page.strikes, this.page.ghosts);
    this._makeTextures();

    this.car = new Carriage({
      col: this.page.cursor?.col ?? this.s.marginL, row: this.page.cursor?.row ?? LAYOUT.TOP,
      marginL: this.s.marginL, marginR: this.s.marginR, spacing: this.s.spacing, lineEnds: this.s.lineEnds,
    });
    this.machine.setColumn(this.car.col, 0);
    this.machine.setRow(this.car.row, 0);
    this.machine.setMargins(this.s.marginL, this.s.marginR);

    this._initAudio();
    this.ui = new UI(this);
    this.applyAll();
    this._bindInput();
    window.addEventListener('resize', () => this.stage.resize());
    document.body.classList.remove('loading');
    const film = new URLSearchParams(location.search).has('film');
    if (!this.s.welcomed && !film) this.ui.showWelcome();
    this.updateStatus();
    if (film) { const m = await import('./film.js'); await m.setup(this); }
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
    return this;
  }

  async _initAudio() {
    try {
      const mod = await import('./audio.js');
      this.audio = new mod.TypewriterAudio();
      this.audioMod = mod;
      await this.audio.ready;
      this.applySound();
    } catch (e) {
      console.warn('audio unavailable', e);
      this.audio = null;
    }
  }

  // every audio call goes through here so a missing engine never breaks typing
  snd(name, ...args) {
    const a = this.audio;
    if (!a || typeof a[name] !== 'function') return undefined;
    try { return a[name](...args); } catch (e) { console.warn('audio', name, e); return undefined; }
  }

  _makeTextures() {
    const r = this.stage.renderer;
    this.paperTex = new THREE.CanvasTexture(this.surface.canvas);
    this.paperTex.colorSpace = THREE.SRGBColorSpace;
    this.paperTex.anisotropy = r.capabilities.getMaxAnisotropy();
    this.paperTex.generateMipmaps = true;
    this.paperTex.minFilter = THREE.LinearMipmapLinearFilter;
    this.machine.setPaperTexture(this.paperTex);
    this._bumpFor(this.surface);
    this.surface.takeDirty();
    this.texReady = false;
  }

  _bumpFor(surface) {
    if (!surface.bumpCanvas) return;
    if (this.bumpTex) this.bumpTex.dispose();
    this.bumpTex = new THREE.CanvasTexture(surface.bumpCanvas);
    this.bumpTex.colorSpace = THREE.NoColorSpace;
    this.machine.setPaperBump(this.bumpTex, 0.01);
  }

  // push changed pixels of the page to the GPU (only the dirty band after the first upload)
  _uploadPaper() {
    const rect = this.surface.takeDirty();
    if (!rect) return false;
    const r = this.stage.renderer, tex = this.paperTex;
    const props = r.properties.get(tex);
    const full = rect.w * rect.h > this.surface.width * this.surface.height * 0.5;
    if (!this.texReady || !props.__webglTexture || full) {
      tex.needsUpdate = true;
      this.texReady = true;
      return true;
    }
    const gl = r.getContext();
    if (!this.scratch) this.scratch = document.createElement('canvas');
    const sc = this.scratch;
    const x = Math.max(0, Math.floor(rect.x)), y = Math.max(0, Math.floor(rect.y));
    const w = Math.min(this.surface.width - x, Math.ceil(rect.w) + 1), h = Math.min(this.surface.height - y, Math.ceil(rect.h) + 1);
    if (w <= 0 || h <= 0) return false;
    if (sc.width !== w || sc.height !== h) { sc.width = w; sc.height = h; }
    const sctx = sc.getContext('2d');
    sctx.clearRect(0, 0, w, h);
    sctx.drawImage(this.surface.canvas, x, y, w, h, 0, 0, w, h);
    r.state.bindTexture(gl.TEXTURE_2D, props.__webglTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, sc);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.uploads++;
    return true;
  }

  // ------------------------------------------------------------ frame loop
  _loop() {
    if (this.manual) return;
    requestAnimationFrame(this._loop);
    this.frame(this.now());
  }

  frame(now) {
    if (this.job) this._tickJob(now);
    const a = this.machine.update(now);
    const b = this.stage.frame(PRINT, now);
    const c = this._uploadPaper();
    if (a || b || c || this.stage.dirty || this.forceRender) this.stage.render();
  }

  // ------------------------------------------------------------ settings
  set(key, value) {
    this.s[key] = value;
    this.apply(key);
    this.save();
    this.ui && this.ui.sync(key);
  }

  applyAll() {
    for (const k of ['color', 'trim', 'keycaps', 'ribbon', 'mood', 'closeup', 'mode', 'spacing', 'lineEnds', 'margins']) this.apply(k);
    this.applySound();
  }

  apply(key) {
    const s = this.s, m = this.machine;
    switch (key) {
      case 'color': m.setColor(s.color); break;
      case 'trim': if (s.trim) m.setTrim(s.trim); else { m.trimId = null; m.setColor(s.color); } break;
      case 'keycaps': m.setKeycaps(s.keycaps); break;
      case 'ribbon': case 'red': {
        const rb = RIBBONS.find(r => r.id === s.ribbon) || RIBBONS[0];
        m.setRibbon(rb.inks.map(k => INKS[k].color));
        if (rb.inks.length < 2 && s.red) s.red = false;
        const lever = document.getElementById('ribbonLever');
        lever.hidden = rb.inks.length < 2;
        lever.classList.toggle('red', !!s.red);
        break;
      }
      case 'paper':
        this.page.paper = s.paper;
        this.surface.setPaper(s.paper);
        this._bumpFor(this.surface);
        break;
      case 'mood':
        this.stage.setMood(s.mood);
        document.body.classList.remove('mood-morning', 'mood-lamp', 'mood-midnight');
        document.body.classList.add('mood-' + s.mood);
        break;
      case 'closeup':
        this.stage.zoom = s.closeup ? 1.75 : 1;
        this.stage.dirty = true;
        document.getElementById('btnClose').setAttribute('aria-pressed', String(!!s.closeup));
        break;
      case 'mode':
        document.body.classList.toggle('mode-draw', s.mode === 'draw');
        document.body.classList.toggle('mode-write', s.mode !== 'draw');
        document.getElementById('drawbar').hidden = s.mode !== 'draw';
        break;
      case 'spacing': this.car.spacing = s.spacing; break;
      case 'lineEnds': this.car.lineEnds = s.lineEnds; break;
      case 'margins': case 'marginL': case 'marginR':
        this.car.marginL = s.marginL; this.car.marginR = s.marginR;
        m.setMargins(s.marginL, s.marginR);
        break;
      case 'volume': case 'profile': case 'bell': case 'ambience': case 'ambienceLevel':
        this.applySound(); break;
    }
    this.stage.dirty = true;
  }

  applySound() {
    if (!this.audio) return;
    const s = this.s;
    this.snd('setMaster', s.volume);
    this.snd('setProfile', s.profile);
    this.snd('setBell', s.bell);
    this.snd('setAmbienceLevel', s.ambienceLevel);
    this.snd('setAmbience', s.ambience);
  }

  save() { this.page.cursor = { col: this.car.col, row: this.car.row }; this.store.save(this.state); }

  // ------------------------------------------------------------ ink
  ink() {
    const rb = RIBBONS.find(r => r.id === this.s.ribbon) || RIBBONS[0];
    return rb.inks[this.s.red && rb.inks.length > 1 ? 1 : 0];
  }

  toggleRibbon() {
    const rb = RIBBONS.find(r => r.id === this.s.ribbon);
    if (!rb || rb.inks.length < 2) { this.hint('This ribbon has one colour'); return; }
    this.set('red', !this.s.red);
    this.snd('knob', { clicks: 1 });
    this.hint(this.s.red ? 'Red half of the ribbon' : 'Black half of the ribbon');
  }

  // a fresh impression
  _strike(ch, col, row, pressure) {
    const st = { c: ch, x: col, y: row, k: this.ink(), p: clamp(pressure, 0.3, 1.5), s: newSeed(), f: this.s.typeface, w: this.s.wear };
    this.page.strikes.push(st);
    this.surface.add(st);
    return st;
  }

  // ------------------------------------------------------------ typing
  unlockAudio() { if (this.audio) this.snd('unlock'); }

  pressure(id, shift) {
    const t = this.now();
    const gap = t - this.lastKeyAt;
    this.lastKeyAt = t;
    // quick bursts land lighter; a deliberate keystroke lands firmer
    const speed = gap < 0.09 ? 0.86 : gap < 0.16 ? 0.94 : gap > 0.6 ? 1.06 : 1;
    const jitter = 1 + (Math.random() - 0.5) * 0.16;
    return speed * jitter * fingerWeight(id) * (shift ? 1.06 : 1) * (this.s.mode === 'draw' ? this.s.pressure : 1);
  }

  typeChar(ch, { auto = false, pressure = null } = {}) {
    if (ch === ' ') return this.space();
    if (ch === '\n') return this.carriageReturn();
    const { id, shift } = keyFor(ch);
    const over = this.s.mode === 'draw' && this.s.over;
    const r = this.car.type({ advance: !over });
    const m = this.machine;
    if (!auto && id) m.pressKey(id, true);
    else if (id) m.pressKey(id);
    if (r.act === 'jam') {
      this.snd('jam', { pan: id ? m.keyPan(id) : 0 });
      this.hint('The carriage is at the margin. Press Enter to return it.');
      this._shake();
      return;
    }
    if (r.act === 'return+strike') this._animateReturn(r.ret);
    const p = pressure ?? this.pressure(id, shift);
    this._strike(ch, r.col, r.row, p);
    m.strike(id, p);
    if (shift && auto) { m.setShift(true); setTimeout(() => m.setShift(false), 90); }
    this.snd('key', { char: ch, intensity: p, pan: id ? m.keyPan(id) * 0.6 : 0 });
    if (r.bell) this.snd('bell');
    if (!over) m.setColumn(this.car.col, 0.07);
    this._afterType();
  }

  space() {
    const r = this.car.space();
    const m = this.machine;
    m.pressKey('space');
    if (r.act === 'jam') { this.snd('jam'); this._shake(); return; }
    if (r.act === 'return') { this._animateReturn(r.ret); this._afterType(); return; }
    this.snd('space', { intensity: 1 });
    if (r.bell) this.snd('bell');
    m.setColumn(this.car.col, 0.07);
    this._afterType();
  }

  backspace() {
    const r = this.car.back(this.s.mode === 'draw' && this.s.half ? 0.5 : 1);
    this.machine.pressKey('back');
    if (r.act === 'stuck') { this.snd('jam', { intensity: 0.5 }); return; }
    this.snd('backspace');
    this.machine.setColumn(this.car.col, 0.08);
    if (this.s.correction === 'tape' && this.s.mode !== 'draw') this._liftOff(this.car.col, this.car.row);
    this._afterType();
  }

  // correction tape: lift the most recent impression at this cell, leave its ghost
  _liftOff(col, row) {
    const list = this.page.strikes;
    for (let i = list.length - 1; i >= 0; i--) {
      const st = list[i];
      if (Math.abs(st.x - col) < 0.26 && Math.abs(st.y - row) < 0.26) {
        list.splice(i, 1);
        const g = { ...st, g: 1 };
        this.page.ghosts.push(g);
        const rect = { x: (col - 1) * 24, y: (row - 1) * 40, w: 24 * 3, h: 40 * 3 };
        this.surface.redraw(rect, this.page.strikes, this.page.ghosts);
        this.snd('correction', { at: 0.06 });
        return true;
      }
    }
    return false;
  }

  carriageReturn() {
    const ret = this.car.ret();
    this._animateReturn(ret);
    this._afterType();
    if (this.car.full) this.nextSheet({ reason: 'full' });
  }

  _animateReturn(ret) {
    const cols = Math.abs(ret.from - ret.to);
    const res = this.snd('carriageReturn', { cols, lines: ret.lines });
    const dur = (res && res.duration) || 0.12 + 0.004 * cols;
    this.machine.carriageReturn(ret.to, this.car.row, dur, this.audioMod && this.audioMod.carriageEase);
  }

  tab() {
    const r = this.car.tab();
    this.machine.pressKey('tab');
    this.snd('carriageMove', { cols: r.col - r.from });
    if (r.bell) this.snd('bell', { at: 0.05 });
    this.machine.setColumn(this.car.col, 0.06 + 0.012 * (r.col - r.from));
    this._afterType();
  }

  // arrows: write mode moves whole steps, draw mode half steps (Shift = whole)
  nudge(dx, dy, whole = false) {
    const step = this.s.mode === 'draw' && this.s.half && !whole ? 0.5 : 1;
    const col = this.car.col + dx * step, row = this.car.row + dy * step;
    this.car.moveTo(col, row);
    if (dx) { this.machine.setColumn(this.car.col, 0.07); this.snd('carriageMove', { cols: step }); }
    if (dy) { this.machine.setRow(this.car.row, 0.09); this.snd('lineFeed', { lines: step, up: dy < 0 }); }
    this._afterType(false);
  }

  // click on the sheet: glide the carriage and roll the platen there
  moveTo(col, row) {
    const snap = this.s.mode === 'draw' && this.s.half ? 2 : 1;
    col = Math.round(col * snap) / snap; row = Math.round(row * snap) / snap;
    const from = { col: this.car.col, row: this.car.row };
    this.car.moveTo(col, row);
    const dc = Math.abs(this.car.col - from.col), dr = Math.abs(this.car.row - from.row);
    if (dc) { this.machine.setColumn(this.car.col, 0.12 + dc * 0.004); this.snd('carriageMove', { cols: dc }); }
    if (dr) { this.machine.setRow(this.car.row, 0.12 + Math.min(dr, 20) * 0.02); this.snd('knob', { clicks: Math.min(12, Math.ceil(dr)) }); }
    this._afterType(false);
  }

  _afterType(resetLook = true) {
    if (resetLook) this.stage.lookTarget = 0;
    document.body.classList.add('typing');
    this.updateStatus();
    this.save();
  }

  _shake() {
    const g = this.machine.group;
    const t0 = this.now();
    this.machine._tween(0.18, t => { g.position.x = Math.sin(t * Math.PI * 6) * 0.06 * (1 - t); }, () => { g.position.x = 0; });
  }

  // ------------------------------------------------------------ sheets
  newSheet() {
    if (!this.page.strikes.length) { this.hint('This sheet is still blank'); return; }
    this.nextSheet({ reason: 'new' });
  }

  nextSheet({ reason } = {}) {
    if (this.changingSheet) return;
    this.changingSheet = true;
    this.save();
    this.snd('paperOut');
    if (reason === 'full') this.toast('Sheet full. Rolling in a fresh one.');
    this.machine.ejectPaper(0.95, () => {
      const p = newPage(this.s.paper);
      this.state.pages.push(p);
      this.state.current = this.state.pages.length - 1;
      this._loadPage(true);
      this.changingSheet = false;
    });
  }

  // put page i in the machine
  openPage(i) {
    if (i === this.state.current) return;
    this.save();
    this.snd('paperOut');
    this.machine.ejectPaper(0.7, () => {
      this.state.current = i;
      this._loadPage(true);
    });
  }

  _loadPage(feed) {
    const p = this.page;
    if (p.paper !== this.surface.paper) { this.surface.setPaper(p.paper); this._bumpFor(this.surface); }
    this.surface.render(p.strikes, p.ghosts);
    this.texReady = false;
    this.car.col = p.cursor?.col ?? this.s.marginL;
    this.car.row = p.cursor?.row ?? LAYOUT.TOP;
    this.machine.setColumn(this.car.col, feed ? 0.25 : 0);
    if (feed) { this.machine.feedPaper(this.car.row, 1.1); this.snd('paperIn'); }
    else this.machine.setRow(this.car.row, 0);
    this.updateStatus();
    this.save();
    this.ui && this.ui.refreshPages();
  }

  deletePage(i) {
    const pages = this.state.pages;
    if (pages.length === 1) {
      pages[0] = newPage(this.s.paper);
      this.state.current = 0;
      this._loadPage(true);
      return;
    }
    const wasCurrent = i === this.state.current;
    pages.splice(i, 1);
    if (this.state.current >= pages.length || (i < this.state.current)) this.state.current = Math.max(0, this.state.current - (i <= this.state.current ? 1 : 0));
    if (wasCurrent) this._loadPage(true);
    this.save();
    this.ui && this.ui.refreshPages();
  }

  // ------------------------------------------------------------ auto typing (draw mode commits, demos)
  // The machine types the way a person would: the space bar between marks, backspace before an
  // overstrike, a carriage return between lines. Steps:
  //   { t: 'strike', c, x, y, k?, p?, f? }  an impression at the carriage (must already be there)
  //   { t: 'sp' } space bar   { t: 'back' } backspace   { t: 'half', dx } half-space nudge
  //   { t: 'ret', col, row } carriage return to col with line feed to row   { t: 'goto', col, row }
  //   { t: 'char', c, d? } typed through the normal keyboard path   { t: 'pause', d }
  runJob(steps, { speed = 1, label = 'Typing', onDone } = {}) {
    this.stopJob();
    if (!steps.length) return;
    if (speed === 0) { this._instant(steps, 0); onDone && onDone(); return; }
    this.job = { steps, i: 0, next: this.now(), speed, label, onDone, total: steps.length, seed: 1 };
    this.ui && this.ui.progress(0, label);
  }

  stopJob() {
    if (!this.job) return;
    const j = this.job;
    this.job = null;
    this.ui && this.ui.progress(null);
    this.save();
    j.onDone && j.onDone(true);
  }

  // put the rest of the drawing on the sheet at once
  finishJob() {
    const j = this.job;
    if (!j) return;
    this.job = null;
    this._instant(j.steps, j.i);
    this.ui && this.ui.progress(null);
    j.onDone && j.onDone(false);
  }

  _tickJob(now) {
    const j = this.job;
    let guard = 0;
    while (this.job === j && now >= j.next && guard++ < 40) {
      const st = j.steps[j.i++];
      if (!st) {
        this.job = null;
        this.ui && this.ui.progress(null);
        this.save();
        j.onDone && j.onDone(false);
        return;
      }
      const dt = this._step(st, j);
      j.next += dt / j.speed;
      if (j.i % 6 === 0) this.ui && this.ui.progress(j.i / j.total, j.label);
    }
  }

  // deterministic per-job variation (the film renders identically every time)
  _jr(j) { j.seed = (Math.imul(j.seed ^ (j.seed >>> 15), 2246822519) + 0x9e3779b9) >>> 0; return j.seed / 4294967296; }

  // perform one step, return its duration at speed 1 (seconds)
  _step(st, j) {
    const m = this.machine, r = () => this._jr(j);
    const fast = j.speed > 1;
    switch (st.t) {
      case 'pause': return st.d;
      case 'char':
        if (st.c === '\n') { this.carriageReturn(); return 0.55 + r() * 0.35; }
        if (st.c === '\t') { this.tab(); return 0.25; }
        this.typeChar(st.c, { auto: true, pressure: st.p });
        return st.d ?? (0.11 + r() * 0.1 + (st.c === ' ' ? 0.04 : 0));
      case 'sp': {
        this.car.col += 1;
        m.pressKey('space');
        m.setColumn(this.car.col, 0.06);
        this.snd('space', { intensity: 0.7 + r() * 0.2 });
        const next = j.steps[j.i];
        return next && next.t === 'sp' ? 0.085 + r() * 0.03 : 0.12 + r() * 0.05;
      }
      case 'back':
        this.car.col -= 1;
        m.pressKey('back');
        m.setColumn(this.car.col, 0.07);
        this.snd('backspace', { intensity: 0.8 });
        return 0.2 + r() * 0.06;
      case 'half':
        this.car.col += st.dx;
        m.setColumn(this.car.col, 0.08);
        this.snd('carriageMove', { cols: Math.abs(st.dx) });
        return 0.28;
      case 'ret': {
        const cols = Math.abs(this.car.col - st.col), lines = Math.max(1, Math.round(Math.abs(st.row - this.car.row)));
        const res = this.snd('carriageReturn', { cols, lines });
        const dur = (res && res.duration) || 0.12 + 0.004 * cols;
        this.car.col = st.col; this.car.row = st.row;
        m.carriageReturn(st.col, st.row, fast ? dur / j.speed : dur, this.audioMod && this.audioMod.carriageEase);
        this.updateStatus();
        return dur + 0.45 + r() * 0.3;
      }
      case 'goto': {
        const dc = Math.abs(st.col - this.car.col), dr = Math.abs(st.row - this.car.row);
        this.car.moveTo(st.col, st.row);
        if (dc) { m.setColumn(st.col, 0.25 + dc * 0.004); this.snd('carriageMove', { cols: dc }); }
        if (dr) { m.setRow(st.row, 0.4); this.snd('knob', { clicks: Math.min(14, Math.ceil(dr)) }); }
        return 0.9;
      }
      case 'strike': {
        const { id } = keyFor(st.c);
        m.pressKey(id || 'space');
        const s = { c: st.c, x: st.x, y: st.y, k: st.k || this.ink(), p: st.p ?? 1, s: newSeed(), f: st.f || this.s.typeface, w: this.s.wear };
        this.page.strikes.push(s);
        this.surface.add(s);
        m.strike(id, s.p);
        this.snd('key', { char: st.c, intensity: s.p * (0.88 + r() * 0.14), pan: id ? m.keyPan(id) * 0.5 : 0 });
        this.car.col = st.x + 1;                    // the escapement moves the carriage on
        m.setColumn(this.car.col, 0.07);
        this.updateStatus();
        return 0.17 + r() * 0.09;
      }
    }
    return 0;
  }

  _instant(steps, from = 0) {
    let last = null;
    for (let i = from; i < steps.length; i++) {
      const st = steps[i];
      if (st.t !== 'strike') continue;
      this.page.strikes.push({ c: st.c, x: st.x, y: st.y, k: st.k || this.ink(), p: st.p ?? 1, s: newSeed(), f: st.f || this.s.typeface, w: this.s.wear });
      last = st;
    }
    this.surface.render(this.page.strikes, this.page.ghosts);
    if (last) {
      this.car.moveTo(last.x + 1, last.y);
      this.machine.setRow(this.car.row, 0.5);
      this.machine.setColumn(this.car.col, 0.4);
      this.snd('knob', { clicks: 6 });
    }
    this.updateStatus();
    this.save();
  }

  // the typist's way through a drawing (strikes already in typing order: by line, left to right)
  artSteps(strikes) {
    if (!strikes.length) return [];
    const minX = Math.min(...strikes.map(s => s.x));
    const steps = [{ t: 'goto', col: minX, row: strikes[0].y }];
    let row = strikes[0].y, col = minX;
    for (const st of strikes) {
      if (Math.abs(st.y - row) > 1e-3) { steps.push({ t: 'ret', col: minX, row: st.y }); row = st.y; col = minX; }
      let dx = st.x - col;
      while (dx <= -1 + 1e-3) { steps.push({ t: 'back' }); dx += 1; col -= 1; }
      while (dx >= 1 - 1e-3) { steps.push({ t: 'sp' }); dx -= 1; col += 1; }
      if (Math.abs(dx) > 1e-3) { steps.push({ t: 'half', dx }); col += dx; }
      steps.push({ t: 'strike', c: st.c, x: st.x, y: st.y, k: st.k, p: st.p, f: st.f });
      col = st.x + 1;
    }
    return steps;
  }

  // typewriter art from the Planner (already in typing order)
  typeArt(strikes) {
    this.runJob(this.artSteps(strikes), { speed: this.s.speed || 1, label: 'Typing your drawing' });
  }

  // human-paced text (used by the demo film and the welcome note)
  typeText(text, { speed = 1, rhythm = 1 } = {}) {
    const r = rng(text.length * 7919);
    const steps = [...text].map(c => {
      let d = (0.09 + r() * 0.12) * rhythm;
      if (c === ' ') d += 0.03;
      if (/[.,;:!?]/.test(c)) d += 0.18 * rhythm;
      return { t: 'char', c, d };
    });
    return new Promise(res => this.runJob(steps, { speed, label: 'Typing', onDone: res }));
  }

  // ------------------------------------------------------------ status, hints
  updateStatus() {
    const p = this.page, idx = this.state.current + 1, n = this.state.pages.length;
    const line = Math.floor(this.car.row - LAYOUT.TOP) + 1, col = Math.floor(this.car.col) + 1;
    const pos = document.getElementById('stPos');
    pos.textContent = `p. ${idx}${n > 1 ? '/' + n : ''} · line ${line} · col ${col}`;
    clearTimeout(this._wcTimer);
    this._wcTimer = setTimeout(() => {
      const words = wordCount(pageText(p));
      document.getElementById('stWords').textContent = `${words} word${words === 1 ? '' : 's'}`;
    }, 120);
  }

  hint(text, ms = 2600) {
    const el = document.getElementById('hint');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this._hintTimer);
    this._hintTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  toast(text, ms = 2200) {
    const el = document.getElementById('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  // ------------------------------------------------------------ input
  _bindInput() {
    const ta = document.getElementById('keys');
    this.input = ta;
    const blocked = () => (this.planner && this.planner.isOpen) || (this.guide && this.guide.isOpen) || this.ui.modalOpen();

    window.addEventListener('keydown', e => {
      if (blocked()) {
        if (e.key === 'Escape' && this.ui.modalOpen()) this.ui.closeReader();
        return;
      }
      const t = e.target;
      // sliders and text fields keep their keys; everything else (even a focused panel button) types
      if (t && t !== ta && t.closest && t.closest('input, select, textarea')) {
        if (e.key === 'Escape') { t.blur(); this.ui.closeDrawer(); }
        return;
      }
      this.unlockAudio();
      if (this.ui.welcomeOpen()) { this.ui.hideWelcome(); }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (this.job) { this.stopJob(); return; }
        if (this.ui.drawerOpen()) this.ui.closeDrawer();
        else document.body.classList.toggle('focus');
        return;
      }
      if (this.job) { if (e.key.length === 1 || e.key === 'Enter') e.preventDefault(); return; }
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'Enter') { e.preventDefault(); this.newSheet(); }
        else if (e.key.toLowerCase() === 'r' && !e.shiftKey) { e.preventDefault(); this.toggleRibbon(); }
        return;
      }
      if (e.altKey && e.key.length === 1) return;
      const k = e.key;
      if (k === 'Shift') {
        if (!e.repeat) { this.machine.pressKey(e.code === 'ShiftRight' ? 'shiftR' : 'shiftL', true); this.machine.setShift(true); this.snd('shift', true); }
        return;
      }
      if (k === 'CapsLock') { this.machine.pressKey('lock'); this.snd('shift', true); return; }
      if (k === 'Enter') { e.preventDefault(); if (!e.repeat) this.carriageReturn(); return; }
      if (k === 'Backspace') { e.preventDefault(); this.backspace(); return; }
      if (k === 'Delete') { e.preventDefault(); if (this._liftOff(this.car.col, this.car.row)) this._afterType(); return; }
      if (k === 'Tab') { e.preventDefault(); this.tab(); return; }
      if (k.startsWith('Arrow')) {
        e.preventDefault();
        const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[k];
        this.nudge(d[0], d[1], e.shiftKey);
        return;
      }
      if ([...k].length === 1) {
        e.preventDefault();
        if (e.repeat && k !== ' ') return;         // typewriters don't auto-repeat
        this.heldKeys.set(e.code, keyFor(k).id);
        this.stage.driftTarget.set(0, 0);
        this.typeChar(k);
      }
    });

    window.addEventListener('keyup', e => {
      if (e.key === 'Shift') {
        this.machine.releaseKey('shiftL'); this.machine.releaseKey('shiftR');
        this.machine.setShift(false); this.snd('shift', false);
        return;
      }
      const id = this.heldKeys.get(e.code);
      if (id) { this.machine.releaseKey(id); this.heldKeys.delete(e.code); }
    });

    // a clicked panel button should not keep focus (Space/Enter would press it again)
    document.addEventListener('pointerup', e => {
      const b = e.target.closest && e.target.closest('button');
      if (b && !(this.planner && this.planner.isOpen) && !(this.guide && this.guide.isOpen)) setTimeout(() => { if (document.activeElement === b) b.blur(); }, 0);
    });

    // phones: the hidden textarea receives the on-screen keyboard
    ta.addEventListener('input', e => {
      if (blocked() || this.job) { ta.value = ''; return; }
      this.unlockAudio();
      const type = e.inputType || '';
      if (type === 'insertLineBreak' || type === 'insertParagraph') this.carriageReturn();
      else if (type.startsWith('delete')) this.backspace();
      else if (e.data) for (const ch of e.data) this.typeChar(ch);
      ta.value = '';
    });

    // pointer: pick keys, the sheet, knobs and the lever; wheel looks up the sheet
    const cv = this.stage.renderer.domElement;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const pickAt = (x, y) => {
      const r = cv.getBoundingClientRect();
      ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, this.stage.camera);
      return this.machine.pick(ray);
    };
    let downAt = null;
    cv.addEventListener('pointerdown', e => {
      this.unlockAudio();
      downAt = { x: e.clientX, y: e.clientY, t: this.now() };
    });
    cv.addEventListener('pointerup', e => {
      if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 8) { downAt = null; return; }
      downAt = null;
      if (this.job || blocked()) return;
      const hit = pickAt(e.clientX, e.clientY);
      if (isTouch) ta.focus({ preventScroll: true });
      if (!hit) return;
      if (hit.type === 'key') {
        const id = hit.id;
        if (id === 'space') this.space();
        else if (id === 'back') this.backspace();
        else if (id === 'tab') this.tab();
        else if (id === 'shiftL' || id === 'shiftR' || id === 'lock') { this.shiftLock = !this.shiftLock; this.machine.pressKey(id); this.machine.setShift(this.shiftLock); this.snd('shift', this.shiftLock); this.hint(this.shiftLock ? 'Shift lock on' : 'Shift lock off'); }
        else if (id === 'mr') { this.car.release = true; this.machine.pressKey('mr'); this.snd('knob', { clicks: 1 }); this.hint('Margin released for this line'); }
        else if (id.length === 1) {
          let ch = id;
          if (this.shiftLock) ch = /[a-z]/.test(id) ? id.toUpperCase() : ({ '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '¢', '7': '&', '8': '*', '9': '(', '0': ')', '-': '_', '=': '+', ';': ':', "'": '"', '/': '?' }[id] || id);
          this.typeChar(ch);
        }
      } else if (hit.type === 'lever') this.carriageReturn();
      else if (hit.type === 'knob') this.nudge(0, 1, true);
      else if (hit.type === 'paper') this.moveTo(hit.col, hit.row);
    });
    let lastMove = 0;
    cv.addEventListener('pointermove', e => {
      const r = cv.getBoundingClientRect();
      if (!isTouch) this.stage.driftTarget.set(((e.clientX - r.left) / r.width - 0.5) * 2, ((e.clientY - r.top) / r.height - 0.5) * 2);
      const t = performance.now();
      if (t - lastMove < 60 || isTouch) return;
      lastMove = t;
      const hit = pickAt(e.clientX, e.clientY);
      cv.classList.toggle('can-pick', !!hit);
    });
    cv.addEventListener('pointerleave', () => this.stage.driftTarget.set(0, 0));
    // the chrome fades while typing and comes back as soon as the pointer moves
    let lastXY = null;
    window.addEventListener('pointermove', e => {
      if (lastXY && Math.hypot(e.clientX - lastXY[0], e.clientY - lastXY[1]) > 6) document.body.classList.remove('typing');
      lastXY = [e.clientX, e.clientY];
    });
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      if (e.ctrlKey) { this.stage.zoom = clamp(this.stage.zoom * Math.exp(-e.deltaY * 0.002), 0.75, 2.4); this.stage.dirty = true; return; }
      const maxLook = Math.max(0, (this.car.row - LAYOUT.TOP) * 0.4233 - 4);
      this.stage.lookTarget = clamp(this.stage.lookTarget - e.deltaY * 0.02, 0, maxLook + 6);
    }, { passive: false });
    if (isTouch) document.getElementById('kbdBtn').hidden = false;
    document.getElementById('kbdBtn').addEventListener('click', () => { this.unlockAudio(); ta.focus(); });
  }

  // ------------------------------------------------------------ typing guide (for a real typewriter)
  async openGuide(strikes, title) {
    const list = (strikes || this.page.strikes).filter(s => !s.g);
    if (!list.length) { this.hint('Type or sketch something on the sheet first.'); return; }
    try {
      const mod = await import('./guide.js');
      const art = await import('./art.js');
      if (!this.guide) this.guide = new mod.Guide(document.getElementById('guideHost'), { PageSurface });
      this.guide.open({ strikes: art.orderStrikes(list), title: title || `Page ${this.state.current + 1}`,
        typeface: this.s.typeface, paper: this.page.paper, PageSurface });
    } catch (e) {
      console.error(e);
      this.toast('The guide could not open.');
    }
  }

  // ------------------------------------------------------------ Draw mode planner
  async openPlanner() {
    if (this.job) return;
    try {
      if (!this.planner) {
        const mod = await import('./planner.js');
        this.planner = new mod.Planner(document.getElementById('plannerHost'), {
          PageSurface,
          getPage: () => this.page,
          typeface: () => this.s.typeface,
          ink: () => this.ink(),
          inks: () => (RIBBONS.find(r => r.id === this.s.ribbon) || RIBBONS[0]).inks,
          onCommit: strikes => this.typeArt(strikes),
          onGuide: strikes => this.openGuide(strikes, 'Your drawing'),
        });
      }
      this.planner.open();
    } catch (e) {
      console.error(e);
      this.toast('The planner could not open.');
    }
  }
}

const app = new App();
window.PL = app;
app.boot().catch(e => {
  console.error(e);
  document.querySelector('#loader span').textContent = 'Something jammed: ' + (e.message || e);
});
