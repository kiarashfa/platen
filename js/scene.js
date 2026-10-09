// The stage: renderer, desk, lights, camera rig and the three moods (Morning, Lamplight, Midnight).
// Look: filmic (AgX) tone mapping, a soft studio environment of large dim softboxes for broad, calm
// reflections, soft variance shadows, a dark walnut desk and a leather blotter.
import * as THREE from 'three';
import { RoundedBoxGeometry } from './vendor/RoundedBoxGeometry.js';
import { rng, clamp, lerp } from './util.js';

export const MOODS = [
  { id: 'morning', name: 'Morning' },
  { id: 'lamp', name: 'Lamplight' },
  { id: 'midnight', name: 'Midnight' },
];

export const FOV = 20;
// distances were tuned at a 26 degree lens; this keeps framing when the lens changes
export const LENS_K = Math.tan(THREE.MathUtils.degToRad(13)) / Math.tan(THREE.MathUtils.degToRad(FOV / 2));

const MOOD = {
  morning: {
    bg: '#a79e90', fog: [150, 380], exposure: 1.0, env: 1.0,
    dome: ['#e8e2d6', '#b6ab9b', '#4d4238'],
    boxes: [
      { c: '#fff4e4', i: 3.2, w: 46, h: 34, p: [-52, 30, 10] },      // tall window to the left
      { c: '#ffffff', i: 0.9, w: 60, h: 20, p: [0, 46, 38] },        // soft ceiling bounce
      { c: '#dfe6ee', i: 0.6, w: 30, h: 26, p: [55, 20, 10] },
    ],
    key: { c: '#fff1dc', i: 2.2, p: [-75, 95, 45], angle: 0.75, pen: 1 },
    fill: { c: '#d6dde8', i: 0.45 }, hemi: ['#efe8dc', '#3e342c', 0.55],
  },
  lamp: {
    bg: '#120e0b', fog: [120, 320], exposure: 1.0, env: 0.85,
    dome: ['#3a2e25', '#1c1612', '#0b0908'],
    boxes: [
      { c: '#ffe6c9', i: 4.2, w: 30, h: 16, p: [-34, 42, 26] },      // the lamp shade
      { c: '#fff0dc', i: 0.7, w: 80, h: 18, p: [0, 54, -30] },       // warm wall behind
      { c: '#b8c6dc', i: 0.45, w: 30, h: 24, p: [50, 18, 22] },      // cool night from a window
    ],
    key: { c: '#ffe9d0', i: 3.4, p: [-34, 84, 48], angle: 0.52, pen: 0.95 },
    fill: { c: '#a9b8d0', i: 0.22 }, hemi: ['#6e5a48', '#0e0a08', 0.5],
  },
  midnight: {
    bg: '#08090d', fog: [90, 250], exposure: 1.05, env: 0.7,
    dome: ['#171a24', '#0d0e12', '#050506'],
    boxes: [
      { c: '#ffdcb6', i: 3.4, w: 20, h: 11, p: [-30, 38, 20] },     // the lamp
      { c: '#7d97d0', i: 0.6, w: 34, h: 26, p: [52, 24, -4] },      // moonlight through a window
    ],
    key: { c: '#ffdcb8', i: 3.3, p: [-36, 78, 30], angle: 0.42, pen: 0.95 },
    fill: { c: '#6f88c4', i: 0.34 }, hemi: ['#2e3142', '#050506', 0.3],
  },
};

function noise2(seed) {
  // value noise on a 256 lattice, smooth interpolation
  const r = rng(seed), P = new Float32Array(256 * 256);
  for (let i = 0; i < P.length; i++) P[i] = r();
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const g = (i, j) => P[((j & 255) << 8) | (i & 255)];
    const a = g(xi, yi) + (g(xi + 1, yi) - g(xi, yi)) * sx;
    const b = g(xi, yi + 1) + (g(xi + 1, yi + 1) - g(xi, yi + 1)) * sx;
    return a + (b - a) * sy;
  };
}

function texFrom(canvas, srgb = true) {
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function woodTextures(size = 1024) {
  // dark walnut, quiet grain running along X
  const n1 = noise2(11), n2 = noise2(23), n3 = noise2(37);
  const col = document.createElement('canvas'), rough = document.createElement('canvas');
  col.width = col.height = rough.width = rough.height = size;
  const cc = col.getContext('2d'), rc = rough.getContext('2d');
  const ci = cc.createImageData(size, size), ri = rc.createImageData(size, size);
  const dark = [30, 22, 17], mid = [52, 39, 30], light = [72, 55, 42];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const warp = n1(u * 2.0, v * 4.5) * 2.4 + n2(u * 8, v * 20) * 0.3;
      const g = v * 11 + warp;
      const band = Math.pow(0.5 + 0.5 * Math.sin(g * Math.PI * 2), 3.0);
      const streak = n3(u * 80, v * 1300) * 0.6 + n3(u * 26, v * 460) * 0.4;
      const figure = n1(u * 1.4 + 7, v * 2.6) * 0.22;
      const t = clamp(0.32 + band * 0.22 + streak * 0.24 + figure, 0, 1);
      const c = t < 0.5 ? dark.map((d, i) => d + (mid[i] - d) * (t / 0.5)) : mid.map((m, i) => m + (light[i] - m) * ((t - 0.5) / 0.5));
      const k = (y * size + x) * 4;
      ci.data[k] = c[0]; ci.data[k + 1] = c[1]; ci.data[k + 2] = c[2]; ci.data[k + 3] = 255;
      const rv = 110 + streak * 50 + band * 20;
      ri.data[k] = ri.data[k + 1] = ri.data[k + 2] = clamp(rv, 0, 255); ri.data[k + 3] = 255;
    }
  }
  cc.putImageData(ci, 0, 0); rc.putImageData(ri, 0, 0);
  // soften: the desk is out of focus behind the machine
  const soft = document.createElement('canvas');
  soft.width = soft.height = size;
  const sctx = soft.getContext('2d');
  sctx.filter = 'blur(1.2px)';
  sctx.drawImage(col, 0, 0);
  return { map: texFrom(soft), rmap: texFrom(rough, false) };
}

function leatherTextures(w = 1024, h = 768) {
  // a dark brown leather blotter: pebble grain, a darker inset border with stitching
  const n1 = noise2(71), n2 = noise2(83), r = rng(5);
  const col = document.createElement('canvas'), rough = document.createElement('canvas');
  col.width = rough.width = w; col.height = rough.height = h;
  const cc = col.getContext('2d'), rc = rough.getContext('2d');
  const ci = cc.createImageData(w, h), ri = rc.createImageData(w, h);
  const border = 0.075;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = x / w, v = y / h;
    // pebbles: sharpened small-scale noise
    const p = n1(x / 3.2, y / 3.2), q = n2(x / 9, y / 9);
    const pebble = Math.pow(Math.abs(p - 0.5) * 2, 0.6);
    const mottled = n2(x / 90, y / 90) * 0.5 + n1(x / 260 + 3, y / 260) * 0.5;
    const edge = Math.min(u, v, 1 - u, 1 - v);
    const inBorder = edge < border ? 1 : 0;
    let lum = 0.86 + mottled * 0.18 - pebble * 0.1 + q * 0.04;
    if (inBorder) lum *= 0.78;
    const base = [64, 40, 27];
    const k = (y * w + x) * 4;
    ci.data[k] = base[0] * lum; ci.data[k + 1] = base[1] * lum; ci.data[k + 2] = base[2] * lum; ci.data[k + 3] = 255;
    const rv = 150 + pebble * 60 - mottled * 30 + (inBorder ? -20 : 0);
    ri.data[k] = ri.data[k + 1] = ri.data[k + 2] = clamp(rv, 0, 255); ri.data[k + 3] = 255;
  }
  cc.putImageData(ci, 0, 0); rc.putImageData(ri, 0, 0);
  // stitching just inside the border
  cc.strokeStyle = 'rgba(196,160,112,0.55)';
  cc.lineWidth = 2.2;
  cc.setLineDash([9, 7]);
  const inset = border * Math.min(w, h) * 0.55, inset2 = border * Math.min(w, h) + 7;
  for (const s of [inset, inset2]) cc.strokeRect(s, s * (h / h), w - 2 * s, h - 2 * s);
  return { map: texFrom(col), rmap: texFrom(rough, false) };
}

function shadowBlob() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 10, 128, 128, 128);
  g.addColorStop(0, 'rgba(0,0,0,0.7)');
  g.addColorStop(0.5, 'rgba(0,0,0,0.32)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

// a soft studio for reflections: a graded dome plus a few large, dim softboxes
function studioEnv(renderer, m) {
  const sc = new THREE.Scene();
  const dome = new THREE.Mesh(new THREE.SphereGeometry(80, 48, 24), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { top: { value: new THREE.Color(m.dome[0]) }, mid: { value: new THREE.Color(m.dome[1]) }, bot: { value: new THREE.Color(m.dome[2]) } },
    vertexShader: 'varying vec3 vP; void main() { vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 mid; uniform vec3 bot; varying vec3 vP; void main() { float y = vP.y; vec3 c = y > 0.0 ? mix(mid, top, smoothstep(0.0, 0.85, y)) : mix(mid, bot, smoothstep(0.0, 0.45, -y)); gl_FragColor = vec4(c, 1.0); }',
  }));
  sc.add(dome);
  for (const b of m.boxes) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(b.w, b.h), new THREE.MeshBasicMaterial({ color: new THREE.Color(b.c).multiplyScalar(b.i), side: THREE.DoubleSide }));
    p.position.set(...b.p);
    p.lookAt(0, 8, 0);
    sc.add(p);
  }
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(sc, 0.04, 1, 300);
  pm.dispose();
  sc.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  return rt;
}

export class Stage {
  constructor(canvas, { clock } = {}) {
    this.canvas = canvas;
    this.clock = clock || (() => performance.now() / 1000);
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 1;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 2, 1200);
    this.target = new THREE.Vector3();
    this.look = 0;            // 0 = home; > 0 looks further up the sheet (cm)
    this.lookTarget = 0;
    this.zoom = 1;
    this.drift = new THREE.Vector2();
    this.driftTarget = new THREE.Vector2();
    this.dirty = true;

    this._desk();
    this._lights();
    this.setMood('lamp');
    this.resize();
  }

  _desk() {
    const { map, rmap } = woodTextures(1024);
    map.repeat.set(2, 1.4); rmap.repeat.set(2, 1.4);
    const desk = new THREE.Mesh(new THREE.PlaneGeometry(520, 360), new THREE.MeshStandardMaterial({
      map, roughnessMap: rmap, roughness: 0.7, metalness: 0, envMapIntensity: 0.6,
    }));
    desk.rotation.x = -Math.PI / 2;
    desk.position.z = 20;
    desk.receiveShadow = true;
    this.scene.add(desk);
    this.deskMat = desk.material;

    // leather blotter under the machine
    const lt = leatherTextures();
    lt.map.wrapS = lt.map.wrapT = lt.rmap.wrapS = lt.rmap.wrapT = THREE.ClampToEdgeWrapping;
    const padGeo = new RoundedBoxGeometry(64, 0.42, 46, 4, 0.5);
    // map the top face's UVs across the whole pad
    const pp = padGeo.attributes.position, uv = padGeo.attributes.uv;
    for (let i = 0; i < pp.count; i++) uv.setXY(i, pp.getX(i) / 64 + 0.5, 0.5 - pp.getZ(i) / 46);
    const pad = new THREE.Mesh(padGeo, new THREE.MeshPhysicalMaterial({
      map: lt.map, roughnessMap: lt.rmap, roughness: 0.8, sheen: 0.4, sheenColor: '#6b4a34', sheenRoughness: 0.5, envMapIntensity: 0.7,
    }));
    pad.position.set(0, 0.0, 2.0);
    pad.receiveShadow = true;
    this.scene.add(pad);
    this.pad = pad;

    // soft contact shadow under the machine
    const blob = new THREE.Mesh(new THREE.PlaneGeometry(46, 42), new THREE.MeshBasicMaterial({ map: shadowBlob(), transparent: true, depthWrite: false, opacity: 0.5 }));
    blob.rotation.x = -Math.PI / 2;
    blob.position.set(0, 0.23, 0.5);
    this.scene.add(blob);

    // a little stack of fresh sheets to the right, and a pencil
    const sheets = new THREE.Group();
    const sm = new THREE.MeshStandardMaterial({ color: '#efe7d6', roughness: 0.95 });
    for (let i = 0; i < 9; i++) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(21.6, 0.05, 27.9), sm);
      p.position.set(Math.sin(i * 2.1) * 0.35, 0.03 + i * 0.055, Math.cos(i * 1.7) * 0.3);
      p.rotation.y = Math.sin(i * 1.3) * 0.03;
      p.castShadow = i === 8; p.receiveShadow = true;
      sheets.add(p);
    }
    sheets.position.set(52, 0, 8);
    sheets.rotation.y = -0.18;
    this.scene.add(sheets);
    const pencil = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 16, 6), new THREE.MeshStandardMaterial({ color: '#2f4a3a', roughness: 0.5 }));
    body.rotation.z = Math.PI / 2;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.8, 6), new THREE.MeshStandardMaterial({ color: '#d9b98b', roughness: 0.8 }));
    tip.rotation.z = -Math.PI / 2; tip.position.x = 8.9;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.44, 0.9, 12), new THREE.MeshStandardMaterial({ color: '#b9975e', metalness: 1, roughness: 0.35 }));
    band.rotation.z = Math.PI / 2; band.position.x = -8.3;
    for (const m of [body, tip, band]) { m.castShadow = true; pencil.add(m); }
    pencil.position.set(46, 1.0, 30);
    pencil.rotation.y = 0.5;
    this.scene.add(pencil);
  }

  _lights() {
    const s = this.scene;
    this.hemi = new THREE.HemisphereLight('#fff', '#000', 0.4);
    s.add(this.hemi);
    const key = this.key = new THREE.SpotLight('#ffd2a0', 3, 0, 0.5, 0.95, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.06;
    key.shadow.radius = 5;
    key.shadow.camera.near = 30;
    key.shadow.camera.far = 300;
    s.add(key);
    s.add(key.target);
    key.target.position.set(0, 6, -2);
    this.fill = new THREE.DirectionalLight('#9ab', 0.2);
    this.fill.position.set(60, 40, 50);
    s.add(this.fill);
  }

  setMood(id) {
    const m = MOOD[id] || MOOD.lamp;
    this.moodId = MOOD[id] ? id : 'lamp';
    const s = this.scene;
    s.background = new THREE.Color(m.bg);
    s.fog = new THREE.Fog(m.bg, m.fog[0], m.fog[1]);
    if (this.envRT) this.envRT.dispose();
    this.envRT = studioEnv(this.renderer, m);
    s.environment = this.envRT.texture;
    s.environmentIntensity = m.env;
    this.renderer.toneMappingExposure = m.exposure;
    this.key.color.set(m.key.c);
    this.key.intensity = m.key.i;
    this.key.position.set(...m.key.p);
    this.key.angle = m.key.angle;
    this.key.penumbra = m.key.pen;
    this.fill.color.set(m.fill.c);
    this.fill.intensity = m.fill.i;
    this.hemi.color.set(m.hemi[0]);
    this.hemi.groundColor.set(m.hemi[1]);
    this.hemi.intensity = m.hemi[2];
    this.dirty = true;
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  // frame the print point; aspect-aware so the sheet stays readable on phones
  frame(print, now) {
    const aspect = this.camera.aspect;
    // follow look and drift smoothly (time-based so recordings are deterministic)
    const dt = this._lastFrame == null ? 1 / 60 : clamp(now - this._lastFrame, 0, 0.1);
    this._lastFrame = now;
    const k = 1 - Math.exp(-dt * 7);
    this.look = lerp(this.look, this.lookTarget, k);
    this.drift.lerp(this.driftTarget, 1 - Math.exp(-dt * 3));
    const moving = Math.abs(this.look - this.lookTarget) > 0.01 || this.drift.distanceTo(this.driftTarget) > 0.0005;

    const portrait = aspect < 0.9;
    const cp = this.camParams || {};
    // landscape: a fixed distance; narrow screens: fit a width that keeps the current line readable
    const tanH = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    let baseDist = (70 - clamp(aspect - 1.6, 0, 1) * 4) * LENS_K;
    if (aspect < 1.4) {
      const want = lerp(17, 46, clamp((aspect - 0.45) / (1.4 - 0.45), 0, 1));   // cm visible across
      baseDist = want / (2 * tanH * aspect);
    }
    const dist = (cp.dist != null ? cp.dist * LENS_K : baseDist) / this.zoom;
    const elev = cp.elev ?? (portrait ? 0.42 : 0.45);            // radians above horizontal
    const up = this.look;
    // the target climbs the sheet when looking up (paper is tilted back ~27 degrees)
    const tUp = cp.tUp ?? (portrait ? -2.2 : -3);
    const zUp = (this.zoom - 1) * 5.2;          // closer views centre on the sheet, not the keys
    this.target.set(cp.tx ?? 0, print.y + tUp + zUp + up * 0.89, print.z + 1.5 - zUp * 0.5 - up * 0.45);
    const az = this.drift.x * 0.05, el = elev + this.drift.y * 0.03 + up * 0.012;
    this.camera.position.set(
      this.target.x + dist * Math.cos(el) * Math.sin(az),
      this.target.y + dist * Math.sin(el),
      this.target.z + dist * Math.cos(el) * Math.cos(az),
    );
    this.camera.lookAt(this.target.x, this.target.y - (cp.down ?? 0), this.target.z);
    return moving;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
    this.dirty = false;
  }
}
