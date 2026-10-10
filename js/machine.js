// The typewriter: a 1950s-60s portable built from code (units: centimetres, Y up, +Z toward the typist).
// The body is static; the carriage (platen, knobs, paper table, bail, return lever and the sheet) slides
// along X so the column being typed always sits at the print point, which is fixed at world x = 0.
import * as THREE from 'three';
import { RoundedBoxGeometry } from './vendor/RoundedBoxGeometry.js';
import { mergeGeometries } from './vendor/BufferGeometryUtils.js';
import { clamp, easeOutCubic, easeInOutCubic } from './util.js';

// ---------------------------------------------------------------- palette
export const COLORS = [
  { id: 'hunter', name: 'Hunter Green', hex: '#253c30', trim: 'brass', decal: '#d8b56a' },
  { id: 'oxblood', name: 'Oxblood', hex: '#44181a', trim: 'brass', decal: '#d8b56a' },
  { id: 'navy', name: 'Admiralty Navy', hex: '#1b2538', trim: 'chrome', decal: '#d8b56a' },
  { id: 'cream', name: 'Ivory Cream', hex: '#dcd1b7', trim: 'chrome', decal: '#7a5a32' },
  { id: 'camel', name: 'Camel', hex: '#937455', trim: 'brass', decal: '#3a2716' },
  { id: 'tobacco', name: 'Tobacco', hex: '#41301f', trim: 'brass', decal: '#d8b56a' },
  { id: 'sage', name: 'Sage', hex: '#6f7a64', trim: 'chrome', decal: '#2f3a2a' },
  { id: 'slate', name: 'Slate Blue', hex: '#45535f', trim: 'chrome', decal: '#e4d6b0' },
  { id: 'claret', name: 'Claret', hex: '#4c1c34', trim: 'chrome', decal: '#e0c27e' },
  { id: 'ebony', name: 'Ebony', hex: '#1a1918', trim: 'chrome', decal: '#d8b56a' },
];
export const TRIMS = [{ id: 'chrome', name: 'Chrome' }, { id: 'brass', name: 'Brass' }];
export const KEYCAPS = [{ id: 'glass', name: 'Glass top' }, { id: 'black', name: 'Black' }, { id: 'ivory', name: 'Ivory' }];

// ---------------------------------------------------------------- geometry constants
export const PAGE_W = 21.59;            // US Letter, cm
export const PAGE_H = 27.94;
export const CELL_W = 2.54 / 10;        // pica
export const ROW_H = 2.54 / 6;          // 6 lines per inch
const PLATEN_R = 1.9;
const PLATEN_LEN = 29.5;
const PLATEN_Y = 12.0;
const PLATEN_Z = -7.4;
const PAPER_R = PLATEN_R + 0.025;
const BETA = 0.10;                       // print point angle above the platen's front, radians
const GAMMA = 0.47;                      // where the sheet leaves the platen (tilt back from vertical)
export const PRINT = new THREE.Vector3(0, PLATEN_Y + PAPER_R * Math.sin(BETA), PLATEN_Z + PAPER_R * Math.cos(BETA));
const SEG_Y = 7.7;                       // typebar pivot height
const SEG_R = 3.55;                      // pivot arc radius around the point under PRINT
const BAR_L = Math.hypot(SEG_R, PRINT.y - SEG_Y);
const BAR_REST = 0.40;                   // rest tilt (down, radians)
const BAR_HIT = -(Math.PI - Math.atan2(PRINT.y - SEG_Y, SEG_R));
const COVER_Y = 9.55;                    // top face of the top cover
const BODY_TOP = 7.0;                    // flat top of the lower shell (under the cover)
const BODY_TOP_Z = 2.4;                  // where the keyboard deck meets that top
const COVER_FRONT = 2.55;                // front edge of the cover plate (z)
const SLOT_W = 12.6;                     // the slot in the cover in front of the platen
const SLOT_Z0 = PRINT.z - 1.3, SLOT_Z1 = PRINT.z + 3.9;
const RIB_X = 5.35;                      // ribbon guide posts

// Keyboard rows, front (0) to back (3). Keys are identified by the unshifted character they type.
const ROWS = [
  { keys: 'zxcvbnm,./', off: 1.25 },
  { keys: "asdfghjkl;'", off: 0.75 },
  { keys: 'qwertyuiop', off: 0.5 },
  { keys: '1234567890-=', off: 0 },
];
const SHIFTED = { '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '¢', '7': '&', '8': '*', '9': '(', '0': ')',
  '-': '_', '=': '+', ';': ':', "'": '"', ',': ',', '.': '.', '/': '?' };
const PITCH = 1.95;
const rowZ = r => 11.0 - r * 2.0;
const deckY = z => 3.75 + (13.4 - z) * ((BODY_TOP - 3.75) / (13.4 - BODY_TOP_Z));   // keyboard deck surface
const rowTopY = r => deckY(rowZ(r)) + 1.55 + r * 0.32;
const KEY_TILT = 0.36;

// ---------------------------------------------------------------- small helpers
function roundedPolyShape(pts, radius) {
  // pts: [[x,y,r?]...] closed polygon; each corner rounded with its own radius (or the default)
  const s = new THREE.Shape();
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
    const r = p1[2] ?? radius;
    const d1 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), d2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const rr = Math.min(r, d1 / 2, d2 / 2);
    const a = [p1[0] + (p0[0] - p1[0]) / d1 * rr, p1[1] + (p0[1] - p1[1]) / d1 * rr];
    const b = [p1[0] + (p2[0] - p1[0]) / d2 * rr, p1[1] + (p2[1] - p1[1]) / d2 * rr];
    if (i === 0) s.moveTo(a[0], a[1]); else s.lineTo(a[0], a[1]);
    s.quadraticCurveTo(p1[0], p1[1], b[0], b[1]);
  }
  s.closePath();
  return s;
}

// shrink a simple polygon by d (edges moved inward, neighbours intersected)
function offsetPolygon(pts, d) {
  const n = pts.length;
  let area = 0;
  for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
  const sgn = area > 0 ? 1 : -1;            // ccw: inward normal is the left normal
  const lines = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
    const nx = -dy / l * sgn, ny = dx / l * sgn;
    lines.push({ p: [a[0] + nx * d, a[1] + ny * d], v: [dx, dy] });
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const L1 = lines[(i - 1 + n) % n], L2 = lines[i];
    const den = L1.v[0] * L2.v[1] - L1.v[1] * L2.v[0];
    if (Math.abs(den) < 1e-9) { out.push(L2.p); continue; }
    const t = ((L2.p[0] - L1.p[0]) * L2.v[1] - (L2.p[1] - L1.p[1]) * L2.v[0]) / den;
    out.push([L1.p[0] + L1.v[0] * t, L1.p[1] + L1.v[1] * t]);
  }
  return out;
}

function canvasTex(w, h, draw, { srgb = true, repeat = false } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

// fine orange-peel normal map for enamel (tileable value noise -> normals)
function enamelNormal(seed = 7) {
  const N = 256;
  const h = new Float32Array(N * N);
  let s = seed;
  const rnd = () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9 >>> 0) / 4294967296);
  for (const [cells, amp] of [[16, 1], [32, 0.6], [64, 0.35]]) {
    const g = Array.from({ length: cells * cells }, rnd);
    const step = N / cells;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const gx = x / step, gy = y / step, x0 = Math.floor(gx), y0 = Math.floor(gy);
      const fx = gx - x0, fy = gy - y0;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const v = (i, j) => g[((j % cells) * cells) + (i % cells)];
      const a = v(x0, y0) + (v(x0 + 1, y0) - v(x0, y0)) * sx;
      const b = v(x0, y0 + 1) + (v(x0 + 1, y0 + 1) - v(x0, y0 + 1)) * sx;
      h[y * N + x] += (a + (b - a) * sy) * amp;
    }
  }
  return canvasTex(N, N, (ctx) => {
    const img = ctx.createImageData(N, N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const dx = h[y * N + (x + 1) % N] - h[y * N + (x - 1 + N) % N];
      const dy = h[((y + 1) % N) * N + x] - h[((y - 1 + N) % N) * N + x];
      const k = 1.6;
      let nx = -dx * k, ny = -dy * k, nz = 1;
      const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
      const i = (y * N + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255; img.data[i + 1] = (ny * 0.5 + 0.5) * 255; img.data[i + 2] = (nz * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, { srgb: false, repeat: true });
}

// ---------------------------------------------------------------- the machine
export class Machine {
  constructor({ maxAnisotropy = 8 } = {}) {
    this.group = new THREE.Group();
    this.group.name = 'typewriter';
    this.maxAniso = maxAnisotropy;
    this.tweens = [];
    this.now = 0;
    this.keys = new Map();          // id -> { obj, rest, axis, bar }
    this.bars = [];
    this.pickables = [];
    this.colorId = 'hunter';
    this.trimId = null;
    this.keycapId = 'glass';
    this.col = 40;                  // carriage column (float)
    this.paperY = 6;                // row at the print point (float)
    this.paperState = 'in';         // 'in' | 'out'
    this.paperOffset = 0;           // extra paper travel for feed/eject animations (cm)
    this.shiftLift = 0;

    this._materials();
    this._body();
    this._keyboard();
    this._basket();
    this._carriage();
    this._ribbon();
    this._paper();
    this.setColor('hunter');
    this._applyCarriage();
  }

  // ------------------------------------------------------------ materials
  _materials() {
    this.enamelNormal = enamelNormal();
    this.enamelNormal.repeat.set(3, 3);
    this.mat = {
      enamel: new THREE.MeshPhysicalMaterial({
        color: '#29473a', roughness: 0.5, metalness: 0.0, clearcoat: 0.7, clearcoatRoughness: 0.24,
        envMapIntensity: 0.9,
      }),
      enamelDark: new THREE.MeshPhysicalMaterial({ color: '#1d1a17', roughness: 0.55, clearcoat: 0.6, clearcoatRoughness: 0.3 }),
      satin: new THREE.MeshStandardMaterial({ color: '#29473a', roughness: 0.7, metalness: 0 }),
      chrome: new THREE.MeshStandardMaterial({ color: '#d6d1c7', metalness: 1.0, roughness: 0.3 }),
      trim: new THREE.MeshStandardMaterial({ color: '#d6d1c7', metalness: 1.0, roughness: 0.3 }),
      steel: new THREE.MeshStandardMaterial({ color: '#9d9890', metalness: 1.0, roughness: 0.42 }),
      darkSteel: new THREE.MeshStandardMaterial({ color: '#4a4846', metalness: 0.9, roughness: 0.45 }),
      rubber: new THREE.MeshPhysicalMaterial({ color: '#181615', roughness: 0.78, sheen: 0.3, sheenColor: '#3a3633', sheenRoughness: 0.7 }),
      bakelite: new THREE.MeshPhysicalMaterial({ color: '#1a1512', roughness: 0.42, clearcoat: 0.6, clearcoatRoughness: 0.3 }),
      interior: new THREE.MeshStandardMaterial({ color: '#1f1b17', roughness: 0.85, metalness: 0.2 }),
      felt: new THREE.MeshStandardMaterial({ color: '#3b2a22', roughness: 1.0 }),
      ribbonInk: new THREE.MeshStandardMaterial({ roughness: 0.85, side: THREE.DoubleSide }),
      plastic: new THREE.MeshPhysicalMaterial({
        color: '#ffffff', roughness: 0.08, transmission: 0, transparent: true, opacity: 1, clearcoat: 1,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    };
  }

  _mesh(geo, mat, parent = this.group, { cast = true, receive = true } = {}) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast; m.receiveShadow = receive;
    parent.add(m);
    return m;
  }

  // ------------------------------------------------------------ body
  _body() {
    const W = 31.5, BEV = 1.0;
    // final side outline in (z, y): front lip, sloped keyboard deck, flat top under the cover
    const prof = [
      [14.6, 0.9, 0.5], [14.6, 3.1, 0.6], [13.4, 3.75, 1.0], [BODY_TOP_Z, BODY_TOP, 0.9],
      [-14.8, BODY_TOP, 0.6], [-14.8, 0.9, 0.4],
    ];
    // ExtrudeGeometry pushes the walls out by bevelSize, so extrude the outline shrunk by that much
    const inset = offsetPolygon(prof.map(([z, y]) => [-z, y]), BEV);
    const shape = roundedPolyShape(inset.map((p, i) => [p[0], p[1], prof[i][2]]), 0.6);
    const g = new THREE.ExtrudeGeometry(shape, {
      depth: W - 2 * 1.2, bevelEnabled: true, bevelThickness: 1.2, bevelSize: BEV, bevelSegments: 6, curveSegments: 10,
    });
    g.rotateY(Math.PI / 2);           // shape (x, y, e) -> world (e, y, -x): shape x = -z
    g.translate(-(W - 2.4) / 2, 0, 0);
    g.computeVertexNormals();
    this._fixUV(g, 0.06);
    this.body = this._mesh(g, this.mat.enamel);

    // top cover: a closed plate (ribbon spools live underneath) with a slim slot in front of the
    // platen where the type guide and ribbon show and the typebars come up to strike
    const cz0 = COVER_FRONT, cz1 = -14.0, cw = W / 2 - 0.35, CB = 0.35;
    const cover = roundedPolyShape([[-cw, cz0, 2.2], [cw, cz0, 2.2], [cw, cz1, 1.6], [-cw, cz1, 1.6]], 1.6);
    const hole = roundedPolyShape([[-SLOT_W / 2, SLOT_Z0], [SLOT_W / 2, SLOT_Z0], [SLOT_W / 2, SLOT_Z1], [-SLOT_W / 2, SLOT_Z1]], 1.1);
    cover.holes.push(hole);
    const thick = COVER_Y - BODY_TOP + 0.3;
    const cg = new THREE.ExtrudeGeometry(cover, { depth: thick - 2 * CB, bevelEnabled: true, bevelThickness: CB, bevelSize: CB, bevelSegments: 5, curveSegments: 28 });
    cg.rotateX(Math.PI / 2);          // shape (x, y, e) -> world (x, -e, y)
    cg.translate(0, COVER_Y - CB, 0);
    cg.computeVertexNormals();
    this._fixUV(cg, 0.06, 'xz');
    this.cover = this._mesh(cg, this.mat.enamel);

    // the dark well under the slot (inside faces of a box)
    const ih = COVER_Y - BODY_TOP + 0.6;
    const well = new THREE.Mesh(new THREE.BoxGeometry(SLOT_W - 2 * CB - 0.1, ih, SLOT_Z1 - SLOT_Z0 - 2 * CB - 0.1),
      new THREE.MeshStandardMaterial({ color: '#15110e', roughness: 0.95, side: THREE.BackSide }));
    well.position.set(0, BODY_TOP + ih / 2 - 0.25, (SLOT_Z0 + SLOT_Z1) / 2);
    well.receiveShadow = true;
    this.group.add(well);

    // keyboard comb: dark slots the key levers come out of
    for (let r = 0; r < 4; r++) {
      const z = rowZ(r) - 0.05;
      const comb = new THREE.Mesh(new RoundedBoxGeometry(27.6, 0.5, 0.9, 2, 0.2), this.mat.interior);
      comb.position.set(0.2, deckY(z) + 0.12, z);
      comb.rotation.x = -Math.atan((BODY_TOP - 3.75) / (13.4 - BODY_TOP_Z));
      comb.receiveShadow = true;
      this.group.add(comb);
    }

    // carriage rail behind the platen
    const rail = this._mesh(new THREE.CylinderGeometry(0.32, 0.32, 33, 16), this.mat.steel);
    rail.rotation.z = Math.PI / 2;
    rail.position.set(0, COVER_Y + 0.55, PLATEN_Z - 3.1);
    const rail2 = this._mesh(new THREE.BoxGeometry(32, 0.5, 1.2), this.mat.darkSteel);
    rail2.position.set(0, COVER_Y + 0.2, PLATEN_Z - 2.0);

    // feet
    for (const [x, z] of [[-13.5, 12.5], [13.5, 12.5], [-13.5, -12.8], [13.5, -12.8]]) {
      const f = this._mesh(new THREE.CylinderGeometry(1.1, 1.25, 0.9, 20), this.mat.rubber);
      f.position.set(x, 0.45, z);
    }

    // name on the front wall of the cover, right behind the number row
    this.decalMat = new THREE.MeshPhysicalMaterial({ transparent: true, roughness: 0.25, metalness: 0.9, clearcoat: 1, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    // a slanted name rail along the front edge of the cover, tilted toward the typist
    const tilt = -0.95;
    const railM = this._mesh(new RoundedBoxGeometry(23.5, 1.8, 0.6, 3, 0.26), this.mat.enamel);
    railM.position.set(0, COVER_Y + 0.2, COVER_FRONT + 0.15);
    railM.rotation.x = tilt;
    const n = new THREE.Vector3(0, -Math.sin(tilt), Math.cos(tilt));
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(8.4, 1.35), this.decalMat);
    plate.position.copy(railM.position).addScaledVector(n, 0.31);
    plate.rotation.x = tilt;
    this.group.add(plate);
    this.namePlate = plate;
    // thin trim lines either side of the name
    for (const side of [-1, 1]) {
      const t = this._mesh(new THREE.BoxGeometry(6.2, 0.07, 0.04), this.mat.trim);
      t.position.copy(railM.position).addScaledVector(n, 0.31);
      t.position.x = side * 7.6;
      t.rotation.x = tilt;
    }
  }

  _fixUV(g, k, plane = 'zy') {
    // planar UVs in cm so the enamel normal map has a constant scale
    const p = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      if (plane === 'xz') uv.setXY(i, x * k, z * k);
      else uv.setXY(i, (z + x * 0.7) * k, (y + x * 0.3) * k);
    }
    uv.needsUpdate = true;
  }

  _decalTexture() {
    const c = COLORS.find(c => c.id === this.colorId);
    return canvasTex(1024, 164, (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = c.decal;
      ctx.font = 'italic 600 128px "Cormorant Garamond", Georgia, serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 3; ctx.shadowOffsetY = 2;
      ctx.fillText('Platen', w / 2, h / 2 + 6);
      ctx.shadowColor = 'transparent';
      ctx.fillRect(w / 2 - 330, h / 2 + 4, 120, 3);
      ctx.fillRect(w / 2 + 210, h / 2 + 4, 120, 3);
    });
  }

  // ------------------------------------------------------------ keyboard
  _keyboard() {
    this.keyGroup = new THREE.Group();
    this.group.add(this.keyGroup);
    const atlasCells = 8;
    this.legendIndex = new Map();
    let idx = 0;
    const specs = [];
    ROWS.forEach((row, r) => {
      const n = row.keys.length;
      const x0 = -((12 - 1) * PITCH) / 2 + row.off * PITCH;
      for (let i = 0; i < n; i++) specs.push({ id: row.keys[i], r, x: x0 + i * PITCH, w: 1, label: row.keys[i] });
    });
    const x0r = r => -((12 - 1) * PITCH) / 2 + ROWS[r].off * PITCH;
    specs.push({ id: 'shiftL', r: 0, x: x0r(0) - 2.45, w: 1.7, label: 'SHIFT' });
    specs.push({ id: 'shiftR', r: 0, x: x0r(0) + 9 * PITCH + 2.45, w: 1.7, label: 'SHIFT' });
    specs.push({ id: 'lock', r: 1, x: x0r(1) - 2.25, w: 1.45, label: 'LOCK' });
    specs.push({ id: 'tab', r: 2, x: x0r(2) - 2.3, w: 1.45, label: 'TAB' });
    specs.push({ id: 'mr', r: 3, x: x0r(3) - 2.25, w: 1.2, label: 'M.R.' });
    specs.push({ id: 'back', r: 3, x: x0r(3) + 11 * PITCH + 2.25, w: 1.2, label: '←' });
    for (const s of specs) { this.legendIndex.set(s.id, idx++); }
    this.keySpecs = specs;
    this.atlasCells = atlasCells;

    this.keyMats = {
      ring: this.mat.trim,
      cap: new THREE.MeshPhysicalMaterial({ roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.04 }),
      skirt: new THREE.MeshPhysicalMaterial({ color: '#111', roughness: 0.4, clearcoat: 0.7 }),
      stem: this.mat.darkSteel,
    };
    const ringGeo = new THREE.TorusGeometry(0.74, 0.1, 10, 40);
    const skirtGeo = new THREE.CylinderGeometry(0.73, 0.7, 0.32, 40, 1);
    const stemGeo = new THREE.CylinderGeometry(0.11, 0.11, 2.6, 8);

    for (const s of specs) {
      const pivot = new THREE.Group();
      const z = rowZ(s.r), y = rowTopY(s.r);
      pivot.position.set(s.x, y, z);
      pivot.rotation.x = KEY_TILT;
      this.keyGroup.add(pivot);
      const sx = s.w;     // wide keys are ovals
      // cap face with legend
      const face = new THREE.CircleGeometry(0.69, 40);
      face.rotateX(-Math.PI / 2);
      const cell = this.legendIndex.get(s.id);
      const cu = (cell % atlasCells) / atlasCells, cv = 1 - (Math.floor(cell / atlasCells) + 1) / atlasCells;
      const uv = face.attributes.uv;
      for (let i = 0; i < uv.count; i++) {
        // circle UVs are 0..1; stretch the legend for oval keys so letters keep their shape
        const u = uv.getX(i), v = uv.getY(i);
        uv.setXY(i, cu + u / atlasCells, cv + v / atlasCells);
      }
      const faceM = new THREE.Mesh(face, this.keyMats.cap);
      faceM.position.y = 0.17;
      faceM.scale.x = sx;
      faceM.receiveShadow = true;
      pivot.add(faceM);
      const ring = new THREE.Mesh(ringGeo, this.keyMats.ring);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.17;
      ring.scale.x = sx;
      ring.castShadow = true;
      pivot.add(ring);
      const skirt = new THREE.Mesh(skirtGeo, this.keyMats.skirt);
      skirt.scale.x = sx;
      skirt.castShadow = true;
      pivot.add(skirt);
      const stem = new THREE.Mesh(stemGeo, this.keyMats.stem);
      stem.position.y = -1.3;
      stem.rotation.x = -KEY_TILT * 0.6;
      stem.castShadow = true;
      pivot.add(stem);
      faceM.userData.key = s.id; ring.userData.key = s.id; skirt.userData.key = s.id;
      this.pickables.push(faceM, skirt);
      this.keys.set(s.id, { obj: pivot, restY: y, press: 0 });
    }

    // space bar: chrome bar on two arms
    const sb = new THREE.Group();
    sb.position.set(-0.6, deckY(13.0) + 1.05, 13.05);
    this.keyGroup.add(sb);
    const bar = new THREE.Mesh(new RoundedBoxGeometry(14.5, 0.55, 1.15, 3, 0.26), this.keyMats.ring);
    bar.castShadow = true; bar.receiveShadow = true;
    bar.userData.key = 'space';
    sb.add(bar);
    for (const ax of [-5.2, 5.2]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.25, 3.2), this.mat.darkSteel);
      arm.position.set(ax, -0.45, -1.6);
      arm.rotation.x = -0.32;
      sb.add(arm);
    }
    this.pickables.push(bar);
    this.keys.set('space', { obj: sb, restY: sb.position.y, press: 0 });
    this._legendAtlas();
  }

  _legendAtlas() {
    const style = this.keycapId;
    const cells = this.atlasCells, C = 128;
    const bg = style === 'black' ? '#151311' : style === 'ivory' ? '#efe6d0' : '#f2ead8';
    const ink = style === 'black' ? '#efe7d4' : '#1b1714';
    const tex = canvasTex(cells * C, cells * C, (ctx) => {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, cells * C, cells * C);
      for (const s of this.keySpecs) {
        const i = this.legendIndex.get(s.id);
        const cx = (i % cells) * C + C / 2, cy = Math.floor(i / cells) * C + C / 2;
        if (style === 'glass') {
          // paper insert under glass: faint inner ring
          ctx.strokeStyle = 'rgba(60,40,20,0.25)';
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(cx, cy, C * 0.43, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.fillStyle = ink;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const label = s.label;
        if (label.length === 1 && /[a-z]/.test(label)) {
          ctx.font = '700 64px "Courier Prime", "Courier New", monospace';
          ctx.fillText(label.toUpperCase(), cx, cy + 4);
        } else if (label.length === 1) {
          const up = SHIFTED[label] ?? '';
          ctx.font = '700 46px "Courier Prime", "Courier New", monospace';
          if (up && up !== label) {
            ctx.fillText(up, cx, cy - 20);
            ctx.fillText(label, cx, cy + 24);
          } else ctx.fillText(label, cx, cy + 4);
        } else {
          ctx.font = `700 ${label.length > 4 ? 22 : 26}px "Courier Prime", "Courier New", monospace`;
          ctx.fillText(label, cx, cy + 2);
        }
      }
    });
    if (this.keyMats.cap.map) this.keyMats.cap.map.dispose();
    this.keyMats.cap.map = tex;
    this.keyMats.cap.color.set('#ffffff');
    this.keyMats.cap.roughness = style === 'glass' ? 0.5 : 0.3;
    this.keyMats.cap.clearcoat = style === 'glass' ? 1 : 0.8;
    this.keyMats.cap.clearcoatRoughness = style === 'glass' ? 0.03 : 0.12;
    this.keyMats.cap.needsUpdate = true;
    this.keyMats.skirt.color.set(style === 'ivory' ? '#e3d8bf' : '#121110');
  }

  // ------------------------------------------------------------ typebar basket
  _basket() {
    this.basket = new THREE.Group();
    this.group.add(this.basket);
    const ids = [];
    // bars ordered across the arc by the key's x position (left keys -> left bars)
    const charKeys = this.keySpecs.filter(s => s.label.length === 1 && s.id.length === 1);
    charKeys.sort((a, b) => a.x - b.x || a.r - b.r);
    charKeys.forEach(s => ids.push(s.id));
    const n = ids.length;
    const span = 1.32;     // radians each side
    const barGeo = mergeGeometries([
      new THREE.BoxGeometry(0.16, 0.12, BAR_L - 0.35).translate(0, 0, (BAR_L - 0.35) / 2),
      new THREE.BoxGeometry(0.34, 0.22, 0.42).translate(0, 0.02, BAR_L - 0.2),      // slug
      new THREE.CylinderGeometry(0.16, 0.16, 0.24, 10).rotateZ(Math.PI / 2),         // pivot boss
    ]);
    ids.forEach((id, i) => {
      const th = -span + (2 * span * i) / (n - 1);
      const pivot = new THREE.Group();
      pivot.position.set(SEG_R * Math.sin(th), SEG_Y, PRINT.z + SEG_R * Math.cos(th));
      pivot.rotation.y = th;
      const hinge = new THREE.Group();
      hinge.rotation.x = BAR_REST;
      pivot.add(hinge);
      const m = new THREE.Mesh(barGeo, this.mat.chrome);
      m.castShadow = true;
      hinge.add(m);
      this.basket.add(pivot);
      const bar = { id, hinge, t0: -1 };
      this.bars.push(bar);
      const k = this.keys.get(id);
      if (k) k.bar = bar;
    });
    // segment arc (slotted block the bars pivot in) and the felt type rest
    const seg = this._mesh(new THREE.TorusGeometry(SEG_R, 0.45, 10, 64, 2 * span + 0.2), this.mat.darkSteel);
    seg.rotation.x = Math.PI / 2;
    seg.rotation.z = Math.PI / 2 - span - 0.1;
    seg.position.set(0, SEG_Y - 0.15, PRINT.z);
    seg.scale.z = 0.6;
    const rest = this._mesh(new THREE.TorusGeometry(SEG_R + BAR_L * Math.cos(BAR_REST) - 0.35, 0.3, 8, 64, 2 * span + 0.3), this.mat.felt);
    rest.rotation.x = Math.PI / 2;
    rest.rotation.z = Math.PI / 2 - span - 0.15;
    rest.position.set(0, SEG_Y - BAR_L * Math.sin(BAR_REST) - 0.3, PRINT.z);

    // type guide: the chrome fork right under the print point + clear card holder with marks
    const guide = this._mesh(new RoundedBoxGeometry(1.6, 0.9, 0.25, 2, 0.08), this.mat.chrome);
    guide.position.set(0, PRINT.y - 1.45, PRINT.z + 0.55);
    guide.rotation.x = -0.2;
    const ch = new THREE.Mesh(new THREE.PlaneGeometry(5.4, 1.5), new THREE.MeshPhysicalMaterial({
      map: canvasTex(540, 150, (ctx, w, h) => {
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(235,240,245,0.10)';
        ctx.beginPath(); ctx.roundRect(2, 2, w - 4, h - 4, 18); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 3; ctx.stroke();
        // window slot showing the print line
        ctx.clearRect(60, 38, w - 120, 44);
        ctx.strokeStyle = 'rgba(40,40,40,0.45)'; ctx.lineWidth = 2;
        ctx.strokeRect(60, 38, w - 120, 44);
        ctx.fillStyle = '#b3261e';
        ctx.fillRect(w / 2 - 1.5, 92, 3, 30);
        ctx.beginPath(); ctx.moveTo(w / 2 - 9, 122); ctx.lineTo(w / 2 + 9, 122); ctx.lineTo(w / 2, 108); ctx.fill();
        ctx.fillStyle = 'rgba(30,30,30,0.5)';
        for (let i = -9; i <= 9; i++) if (i) ctx.fillRect(w / 2 + i * 25.4 - 0.75, 92, 1.5, i % 5 ? 10 : 18);
      }),
      transparent: true, roughness: 0.1, clearcoat: 1, clearcoatRoughness: 0.05, depthWrite: false, side: THREE.DoubleSide,
    }));
    const a = BETA - 0.02;
    ch.position.set(0, PLATEN_Y + (PAPER_R + 0.07) * Math.sin(a) - 0.12, PLATEN_Z + (PAPER_R + 0.07) * Math.cos(a));
    ch.rotation.x = -a;
    this.group.add(ch);
    this.cardHolder = ch;
  }

  // ------------------------------------------------------------ carriage
  _carriage() {
    const c = this.carriage = new THREE.Group();
    this.carriageLift = new THREE.Group();     // shift raises the carriage a little
    this.carriageLift.add(c);
    this.group.add(this.carriageLift);

    // platen + axle
    this.platen = new THREE.Group();
    this.platen.position.set(0, PLATEN_Y, PLATEN_Z);
    c.add(this.platen);
    const pg = new THREE.CylinderGeometry(PLATEN_R, PLATEN_R, PLATEN_LEN, 64, 1);
    pg.rotateZ(Math.PI / 2);
    this._mesh(pg, this.mat.rubber, this.platen);
    const axle = new THREE.CylinderGeometry(0.35, 0.35, PLATEN_LEN + 6, 16);
    axle.rotateZ(Math.PI / 2);
    this._mesh(axle, this.mat.chrome, this.platen);

    // knobs: fluted bakelite with a chrome cap
    for (const side of [-1, 1]) {
      const kg = new THREE.CylinderGeometry(2.05, 2.05, 1.9, 96, 2);
      const p = kg.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), z = p.getZ(i);
        const r = Math.hypot(x, z);
        if (r > 1.5) {
          const a = Math.atan2(z, x);
          const k = 1 + 0.035 * Math.sign(Math.cos(a * 24));
          p.setX(i, x * k); p.setZ(i, z * k);
        }
      }
      kg.computeVertexNormals();
      kg.rotateZ(Math.PI / 2);
      const knob = this._mesh(kg, this.mat.bakelite, this.platen);
      knob.position.x = side * (PLATEN_LEN / 2 + 2.7);
      knob.userData.part = 'knob';
      this.pickables.push(knob);
      const cap = new THREE.SphereGeometry(1.2, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2);
      cap.scale(1, 0.35, 1);
      cap.rotateZ(-side * Math.PI / 2);
      const capM = this._mesh(cap, this.mat.trim, this.platen);
      capM.position.x = side * (PLATEN_LEN / 2 + 3.65);
      const collar = new THREE.CylinderGeometry(1.0, 1.0, 1.0, 32);
      collar.rotateZ(Math.PI / 2);
      const col = this._mesh(collar, this.mat.chrome, this.platen);
      col.position.x = side * (PLATEN_LEN / 2 + 1.3);
    }

    // carriage end frames
    for (const side of [-1, 1]) {
      const fg = new RoundedBoxGeometry(1.0, 3.9, 6.6, 3, 0.4);
      const f = this._mesh(fg, this.mat.enamel, c);
      f.position.set(side * (PLATEN_LEN / 2 + 0.6), PLATEN_Y - 0.3, PLATEN_Z - 1.6);
    }
    // carriage frame bar along the back
    const fb = this._mesh(new RoundedBoxGeometry(PLATEN_LEN + 1.8, 1.6, 1.4, 3, 0.35), this.mat.enamel, c);
    fb.position.set(0, PLATEN_Y - 1.4, PLATEN_Z - 3.6);

    // paper table behind the sheet (painted)
    // a short curved table, rounded at the top corners, then a chrome wire rest above it
    const ptW = 24.5, ptH = 4.6;
    const outline = roundedPolyShape([[-ptW / 2, 0, 0.2], [ptW / 2, 0, 0.2], [ptW / 2, ptH, 1.6], [-ptW / 2, ptH, 1.6]], 1.2);
    const ptg = new THREE.ShapeGeometry(outline, 16);
    const pp = ptg.attributes.position;
    for (let i = 0; i < pp.count; i++) {
      const q = this._pathPoint(1.0 + pp.getY(i));
      pp.setXYZ(i, pp.getX(i), q.y - 0.32 * q.ny, q.z - 0.32 * q.nz);
    }
    ptg.computeVertexNormals();
    const pt = this._mesh(ptg, this.mat.satin, c);
    pt.material.side = THREE.DoubleSide;
    this.paperTable = pt;
    // rolled chrome edge along the top of the table
    const edge = [];
    for (let i = 0; i <= 24; i++) {
      const x = -ptW / 2 + 1.2 + (ptW - 2.4) * i / 24;
      const q = this._pathPoint(1.0 + ptH - 0.02);
      edge.push(new THREE.Vector3(x, q.y - 0.32 * q.ny, q.z - 0.32 * q.nz));
    }
    this._mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(edge), 24, 0.09, 8, false), this.mat.chrome, c);

    // paper bail: chrome rod with two rubber rollers, held by arms from the end frames
    const bq = this._pathPoint(3.1);
    const bailY = bq.y + bq.ny * 0.34, bailZ = bq.z + bq.nz * 0.34;
    const rod = new THREE.CylinderGeometry(0.17, 0.17, PLATEN_LEN - 1, 16);
    rod.rotateZ(Math.PI / 2);
    const rodM = this._mesh(rod, this.mat.chrome, c);
    rodM.position.set(0, bailY, bailZ);
    for (const x of [-5.5, 5.5]) {
      const rg = new THREE.CylinderGeometry(0.42, 0.42, 1.3, 24);
      rg.rotateZ(Math.PI / 2);
      const rm = this._mesh(rg, this.mat.rubber, c);
      rm.position.set(x, bailY - bq.ny * 0.2, bailZ - bq.nz * 0.2);
    }
    for (const side of [-1, 1]) {
      const arm = this._mesh(new RoundedBoxGeometry(0.3, 0.5, 4.4, 2, 0.12), this.mat.chrome, c);
      arm.position.set(side * (PLATEN_LEN / 2 - 0.4), (bailY + PLATEN_Y) / 2 + 0.2, (bailZ + PLATEN_Z) / 2 + 0.2);
      arm.rotation.x = Math.atan2(bailY - PLATEN_Y, bailZ - PLATEN_Z) * -1 + Math.PI;
    }

    // front scale strip (moves with the carriage)
    const sc = new THREE.Mesh(new THREE.PlaneGeometry(PLATEN_LEN - 2, 0.75), new THREE.MeshStandardMaterial({
      map: canvasTex(2048, 56, (ctx, w, h) => {
        ctx.fillStyle = '#e4dccb'; ctx.fillRect(0, 0, w, h);
        const pxPerCm = w / (PLATEN_LEN - 2);
        const x0 = w / 2 - (PAGE_W / 2) * pxPerCm;
        ctx.fillStyle = '#2a2420';
        ctx.font = '700 22px "Courier Prime", monospace';
        ctx.textAlign = 'center';
        for (let i = 0; i <= 90; i++) {
          const x = x0 + (i + 0.5) * CELL_W * pxPerCm;
          if (x < 4 || x > w - 4) continue;
          const big = i % 10 === 0, mid = i % 5 === 0;
          ctx.fillRect(x - 1, 0, 2, big ? 22 : mid ? 15 : 9);
          if (big) ctx.fillText(String(i), x, 46);
        }
      }),
      roughness: 0.4, metalness: 0.2,
    }));
    // the scale rides on the bail, just above the rod
    const sq = this._pathPoint(3.62);
    sc.scale.y = 0.62;
    sc.position.set(0, sq.y + sq.ny * 0.27, sq.z + sq.nz * 0.27);
    sc.rotation.x = -GAMMA;
    c.add(sc);
    const scBack = this._mesh(new RoundedBoxGeometry(PLATEN_LEN - 1.4, 0.62, 0.12, 2, 0.05), this.mat.trim, c);
    scBack.position.set(0, sq.y + sq.ny * 0.2, sq.z + sq.nz * 0.2);
    scBack.rotation.x = -GAMMA;

    // carriage return lever (left), pivoting at the end frame
    const lev = this.lever = new THREE.Group();
    lev.position.set(-(PLATEN_LEN / 2 + 1.2), PLATEN_Y + 0.6, PLATEN_Z - 0.6);
    c.add(lev);
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(-1.0, 2.2, 0.8), new THREE.Vector3(-1.6, 4.2, 2.6),
      new THREE.Vector3(-0.8, 5.2, 4.6), new THREE.Vector3(0.9, 5.4, 5.8),
    ]);
    this._mesh(new THREE.TubeGeometry(curve, 48, 0.26, 12, false), this.mat.trim, lev);
    const paddle = this._mesh(new RoundedBoxGeometry(2.6, 0.5, 1.5, 3, 0.22), this.mat.trim, lev);
    paddle.position.set(1.9, 5.4, 6.0);
    paddle.rotation.y = -0.25;
    paddle.userData.part = 'lever';
    this.pickables.push(paddle);
    const hub = new THREE.CylinderGeometry(0.6, 0.6, 0.6, 20);
    hub.rotateZ(Math.PI / 2);
    this._mesh(hub, this.mat.trim, lev);

    // margin stops on the rail behind (brass tabs) - decorative
    this.marginTabs = [];
    for (const k of [0, 1]) {
      const t = this._mesh(new RoundedBoxGeometry(0.6, 0.9, 0.5, 2, 0.12), this.mat.trim, c);
      t.position.set(0, COVER_Y + 1.05, PLATEN_Z - 3.1);
      this.marginTabs.push(t);
    }
    this.setMargins(10, 75);
  }

  // ------------------------------------------------------------ ribbon + spools
  _ribbon() {
    // the spools sit under the closed cover; only the band across the slot shows
    this.spools = [];
    for (const side of [-1, 1]) {
      const post = this._mesh(new THREE.CylinderGeometry(0.13, 0.13, 3.0, 12), this.mat.chrome);
      post.position.set(side * RIB_X, COVER_Y + 0.55, PRINT.z + 0.02);
      const cap = this._mesh(new THREE.SphereGeometry(0.2, 16, 10), this.mat.chrome);
      cap.position.set(side * RIB_X, COVER_Y + 2.05, PRINT.z + 0.02);
    }
    // the ribbon band: from each spool to the vibrator in front of the print point
    const geo = new THREE.BufferGeometry();
    const N = 24;
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((2 * N + 2) * 2 * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array((2 * N + 2) * 2 * 2), 2));
    const idx = [];
    for (let i = 0; i < 2 * N + 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    geo.setIndex(idx);
    this.ribbonGeo = geo;
    this.ribbonN = N;
    this.ribbonTex = canvasTex(8, 64, (ctx) => {}, {});
    this.mat.ribbonBand = new THREE.MeshStandardMaterial({ map: this.ribbonTex, roughness: 0.9, side: THREE.DoubleSide });
    const band = this._mesh(geo, this.mat.ribbonBand);
    band.frustumCulled = false;
    this.ribbonLift = 0;
    this.setRibbon(['#2a2826']);
    this._layoutRibbon();
    // vibrator fork
    const vib = this.vibrator = this._mesh(new RoundedBoxGeometry(2.2, 0.35, 0.22, 2, 0.08), this.mat.chrome);
    vib.position.set(0, PRINT.y - 1.75, PRINT.z + 0.32);
  }

  setRibbon(colors) {
    const tex = canvasTex(8, 64, (ctx, w, h) => {
      const n = colors.length;
      colors.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(0, (i * h) / n, w, h / n); });
      // soft fabric sheen along the edges
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, 'rgba(255,255,255,0.10)'); g.addColorStop(0.5, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(0,0,0,0.12)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    });
    this.mat.ribbonBand.map = tex;
    this.mat.ribbonBand.needsUpdate = true;
    this.mat.ribbonInk.color.set(colors[0]).multiplyScalar(0.9);
  }

  _layoutRibbon() {
    const N = this.ribbonN;
    const pos = this.ribbonGeo.attributes.position, uv = this.ribbonGeo.attributes.uv;
    const W = 1.27;
    const lift = this.ribbonLift;
    const cy = PRINT.y - 0.98 + lift * 0.95;       // band centre at the print point
    const cz = PRINT.z + 0.17;
    const low = BODY_TOP + 1.0;
    // polyline: up out of the well, round the left post, across the print point, down the right
    const pts = [];
    const seg = (a, b, n) => { for (let i = 0; i < n; i++) { const t = i / n; pts.push(a.map((v, k) => v + (b[k] - v) * t)); } };
    const A = [-RIB_X - 0.9, low, cz - 0.9], B = [-RIB_X, cy - 0.12, cz - 0.12], C = [RIB_X, cy - 0.12, cz - 0.12], D = [RIB_X + 0.9, low, cz - 0.9];
    const M1 = [-2.4, cy, cz], M2 = [2.4, cy, cz];
    seg(A, B, N / 2); seg(B, M1, N / 2); seg(M1, M2, 1); seg(M2, C, N / 2); seg(C, D, N / 2);
    pts.push(D);
    let k = 0;
    for (let i = 0; i < pts.length && k < pos.count; i++) {
      const [x, y, z] = pts[i];
      pos.setXYZ(k, x, y + W / 2, z); uv.setXY(k, 0, 1); k++;
      pos.setXYZ(k, x, y - W / 2, z); uv.setXY(k, 0, 0); k++;
    }
    pos.needsUpdate = true;
    this.ribbonGeo.computeVertexNormals();
    this.ribbonGeo.computeBoundingSphere();
  }

  // ------------------------------------------------------------ paper path + sheet
  // Path of the sheet in the carriage's YZ plane. s = 0 at the print point, s > 0 up the front of the
  // platen and away over the paper table, s < 0 down around the platen (hidden behind it).
  _buildPathTable() {
    const ds = 0.05, n = 1400;
    const tab = new Float32Array((n + 1) * 4);
    const sWrap = (GAMMA - BETA) * PAPER_R;
    let y = 0, z = 0, psi = 0;
    for (let i = 0; i <= n; i++) {
      const s = i * ds;
      if (s <= sWrap) {
        const ph = BETA + s / PAPER_R;
        y = PLATEN_Y + PAPER_R * Math.sin(ph); z = PLATEN_Z + PAPER_R * Math.cos(ph);
        psi = ph;
      } else {
        const over = s - sWrap - 11.5;      // free paper above the table curls back gently
        const target = over > 0 ? Math.min(GAMMA + 0.0016 * over * over + 0.012 * over, 1.25) : GAMMA;
        psi = target;
        y += Math.cos(psi) * ds; z -= Math.sin(psi) * ds;
      }
      tab[i * 4] = y; tab[i * 4 + 1] = z; tab[i * 4 + 2] = Math.sin(psi); tab[i * 4 + 3] = Math.cos(psi);
    }
    this._ptab = { tab, ds, n };
  }

  _pathPoint(s) {
    if (!this._ptab) this._buildPathTable();
    if (s < 0) {
      const ph = BETA + s / PAPER_R;
      return { y: PLATEN_Y + PAPER_R * Math.sin(ph), z: PLATEN_Z + PAPER_R * Math.cos(ph), ny: Math.sin(ph), nz: Math.cos(ph) };
    }
    const { tab, ds, n } = this._ptab;
    const f = Math.min(s / ds, n - 1e-6), i = Math.floor(f), t = f - i;
    const g = k => tab[i * 4 + k] + (tab[(i + 1) * 4 + k] - tab[i * 4 + k]) * t;
    return { y: g(0), z: g(1), ny: g(2), nz: g(3) };
  }

  _paper() {
    this.paperMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
    this.paperGeo = new THREE.BufferGeometry();
    const NS = 220, NX = 2;
    this.paperNS = NS; this.paperNX = NX;
    const count = (NS + 1) * (NX + 1);
    this.paperGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    this.paperGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    this.paperGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    const idx = [];
    for (let i = 0; i < NS; i++) for (let j = 0; j < NX; j++) {
      const a = i * (NX + 1) + j, b = a + 1, c = a + NX + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
    this.paperGeo.setIndex(idx);
    this.paper = this._mesh(this.paperGeo, this.paperMat, this.carriage);
    this.paper.frustumCulled = false;
    this.paper.userData.part = 'paper';
    this.pickables.push(this.paper);
    this._layoutPaper();
  }

  // y position on the page (cm from the top edge) that sits at the print point
  _pageYAtPrint() {
    return (this.paperY + 0.62) * ROW_H + this.paperOffset;
  }

  _layoutPaper() {
    const NS = this.paperNS, NX = this.paperNX;
    const yc = this._pageYAtPrint();
    const sTop = yc, sBot = Math.max(yc - PAGE_H, -(Math.PI + 0.7) * PAPER_R);
    const pos = this.paperGeo.attributes.position, nor = this.paperGeo.attributes.normal, uv = this.paperGeo.attributes.uv;
    const visible = sTop > sBot + 0.01;
    this.paper.visible = visible && this.paperState !== 'gone';
    if (!visible) return;
    // denser sampling around the platen
    for (let i = 0; i <= NS; i++) {
      const t = i / NS;
      const s = sBot + (sTop - sBot) * t;
      const q = this._pathPoint(s);
      const py = yc - s;                 // cm from the page top
      for (let j = 0; j <= NX; j++) {
        const u = j / NX;
        const x = -PAGE_W / 2 + u * PAGE_W;
        const k = i * (NX + 1) + j;
        pos.setXYZ(k, x, q.y, q.z);
        nor.setXYZ(k, 0, q.ny, q.nz);
        uv.setXY(k, u, py / PAGE_H);      // texture uploaded with flipY = false
      }
    }
    pos.needsUpdate = nor.needsUpdate = uv.needsUpdate = true;
    this.paperGeo.computeBoundingSphere();
  }

  setPaperTexture(tex) {
    tex.flipY = false;
    this.paperMat.map = tex;
    this.paperMat.needsUpdate = true;
  }

  setPaperBump(tex, scale = 0.012) {
    tex.flipY = false;
    this.paperMat.bumpMap = tex;
    this.paperMat.bumpScale = scale;
    this.paperMat.needsUpdate = true;
  }

  // ------------------------------------------------------------ appearance
  setColor(id) {
    const c = COLORS.find(c => c.id === id) || COLORS[0];
    this.colorId = c.id;
    this._tweenColor(this.mat.enamel.color, c.hex, 0.45);
    this._tweenColor(this.mat.satin.color, c.hex, 0.45);
    if (!this.trimId) this._applyTrim(c.trim);
    if (this.decalMat.map) this.decalMat.map.dispose();
    this.decalMat.map = this._decalTexture();
    this.decalMat.color.set('#ffffff');
    this.decalMat.metalness = c.decal === '#d8b56a' || c.decal === '#e0c27e' ? 0.85 : 0.1;
    this.decalMat.needsUpdate = true;
    this.ping();
  }

  setTrim(id) { this.trimId = id; this._applyTrim(id); this.ping(); }
  _applyTrim(id) {
    const brass = id === 'brass';
    this.mat.trim.color.set(brass ? '#c4a26a' : '#d6d1c7');
    this.mat.trim.roughness = brass ? 0.34 : 0.28;
  }

  setKeycaps(id) { this.keycapId = id; this._legendAtlas(); this.ping(); }

  _tweenColor(color, hex, dur) {
    const from = color.clone(), to = new THREE.Color(hex);
    this._tween(dur, t => color.copy(from).lerp(to, easeInOutCubic(t)));
  }

  setMargins(l, r) {
    this.margins = [l, r];
    if (!this.marginTabs) return;
    [l, r].forEach((col, i) => { this.marginTabs[i].position.x = -PAGE_W / 2 + (col + 0.5) * CELL_W + (i ? 0.4 : -0.4); });
  }

  // ------------------------------------------------------------ animation core
  ping() { this.dirty = true; }

  _tween(dur, fn, done) {
    const tw = { t0: this.now, dur: Math.max(dur, 1e-4), fn, done };
    this.tweens.push(tw);
    this.dirty = true;
    return tw;
  }

  // returns true while anything still moves (the stage keeps rendering)
  update(now) {
    this.now = now;
    let active = false;
    if (this.tweens.length) {
      const keep = [];
      for (const tw of this.tweens) {
        const t = clamp((now - tw.t0) / tw.dur, 0, 1);
        tw.fn(t);
        if (t < 1) keep.push(tw); else tw.done && tw.done();
      }
      this.tweens = keep;
      active = true;
    }
    // typebars
    for (const b of this.bars) {
      if (b.t0 < 0) continue;
      const e = now - b.t0;
      const up = 0.045, hold = 0.012, down = 0.12;
      let a;
      if (e < up) a = easeOutCubic(e / up) ** 1.5;
      else if (e < up + hold) a = 1;
      else if (e < up + hold + down) { const t = (e - up - hold) / down; a = 1 - t * t * (3 - 2 * t); a = a + Math.sin(t * Math.PI) * 0.0; }
      else { a = 0; b.t0 = -1; }
      b.hinge.rotation.x = BAR_REST + (BAR_HIT - BAR_REST) * a * b.reach;
      active = true;
    }
    // keys
    for (const [, k] of this.keys) {
      if (k.t0 == null) continue;
      let e = now - k.t0;
      const dn = 0.03, up = 0.11;
      // a release that never arrives (lost keyup, odd touch input) must not leave a key down for good
      if (k.held && e > 2.5) { k.held = false; k.t0 = now - dn; e = dn; }
      let d;
      if (k.held) d = Math.min(e / dn, 1);
      else if (e < dn) d = e / dn;
      else if (e < dn + up) d = 1 - easeOutCubic((e - dn) / up);
      else { d = 0; k.t0 = null; }
      k.press = d;
      const depth = 0.55;
      k.obj.position.y = k.restY - d * depth;
      active = true;
    }
    // ribbon vibrator
    if (this.ribbonT0 != null) {
      const e = now - this.ribbonT0;
      const tot = 0.13;
      this.ribbonLift = e < 0.03 ? e / 0.03 : e < tot ? 1 - (e - 0.03) / (tot - 0.03) : 0;
      if (e >= tot) this.ribbonT0 = null;
      this._layoutRibbon();
      this.vibrator.position.y = PRINT.y - 1.75 + this.ribbonLift * 0.95;
      active = true;
    }
    const was = this.dirty;
    this.dirty = false;
    return active || was;
  }

  // ------------------------------------------------------------ actions
  carriageX(col) { return PAGE_W / 2 - (col + 0.5) * CELL_W; }

  _applyCarriage() {
    this.carriage.position.x = this.carriageX(this.col);
  }

  // move the carriage to a column (float). dur 0 = jump.
  setColumn(col, dur = 0.05, ease = easeOutCubic) {
    if (this._colTween) this._colTween.cancel = true;
    const from = this.col, to = col;
    if (dur <= 0 || Math.abs(to - from) < 1e-4) { this.col = to; this._applyCarriage(); this.ping(); return; }
    const tw = this._tween(dur, t => { if (tw.cancel) return; this.col = from + (to - from) * ease(t); this._applyCarriage(); });
    this._colTween = tw;
  }

  // roll the platen so `row` (float) sits at the print point
  setRow(row, dur = 0.09) {
    if (this._rowTween) this._rowTween.cancel = true;
    const from = this.paperY, to = row;
    const rot0 = this.platen.rotation.x;
    if (dur <= 0) { this.paperY = to; this.platen.rotation.x = rot0 - (to - from) * ROW_H / PLATEN_R; this._layoutPaper(); this.ping(); return; }
    const tw = this._tween(dur, t => {
      if (tw.cancel) return;
      const e = easeOutCubic(t);
      this.paperY = from + (to - from) * e;
      this.platen.rotation.x = rot0 - (to - from) * e * ROW_H / PLATEN_R;
      this._layoutPaper();
    });
    this._rowTween = tw;
  }

  pressKey(id, held = false) {
    const k = this.keys.get(id);
    if (!k) return;
    k.t0 = this.now; k.held = held;
    this.ping();
  }

  releaseKey(id) {
    const k = this.keys.get(id);
    if (!k || !k.held) return;
    k.held = false;
    k.t0 = this.now - 0.03;
    this.ping();
  }

  // swing the typebar of a key to the platen (no key -> the middle bar)
  strike(id, intensity = 1) {
    const bar = (this.keys.get(id) && this.keys.get(id).bar) || this.bars[(this.bars.length / 2) | 0];
    bar.t0 = this.now;
    bar.reach = 1;
    this.ribbonT0 = this.now;
    // ribbon advance: spools turn a hair
    for (const s of this.spools) s.top.rotation.y += 0.035 * s.side;
    this.ping();
  }

  carriageReturn(toCol, toRow, dur, ease) {
    const lev = this.lever;
    this._tween(0.16, t => { lev.rotation.y = -Math.sin(t * Math.PI) * 0.22; });
    this.setRow(toRow, 0.12);
    this.setColumn(toCol, dur, ease || (t => 1 - Math.pow(1 - t, 2.2)));
  }

  // stereo position of a key (-1 left .. 1 right) for the sound
  keyPan(id) {
    const s = this.keySpecs.find(k => k.id === id);
    return s ? Math.max(-1, Math.min(1, s.x / 16)) : 0;
  }

  setShift(on) {
    const from = this.shiftLift, to = on ? 1 : 0;
    this._tween(0.07, t => { this.shiftLift = from + (to - from) * t; this.carriageLift.position.y = this.shiftLift * 0.32; });
  }

  // feed a fresh sheet so `row` ends at the print point
  feedPaper(row, dur = 1.1) {
    this.paperState = 'in';
    this.paperY = row;
    const start = -(row + 0.62) * ROW_H - 2.5;
    this.paperOffset = start;
    const rot0 = this.platen.rotation.x;
    this._tween(dur, t => {
      const e = easeInOutCubic(t);
      this.paperOffset = start * (1 - e);
      this.platen.rotation.x = rot0 + start * e / PLATEN_R;
      this._layoutPaper();
    });
  }

  // pull the sheet up and out
  ejectPaper(dur = 0.9, done) {
    const from = this.paperOffset, to = PAGE_H + 6 - (this.paperY + 0.62) * ROW_H;
    this._tween(dur, t => {
      const e = t * t;
      this.paperOffset = from + (to - from) * e;
      this._layoutPaper();
    }, () => { this.paperState = 'gone'; this.paper.visible = false; done && done(); });
  }

  // ------------------------------------------------------------ picking
  // raycaster -> { type:'key', id } | { type:'paper', col, row } | { type:'knob' } | { type:'lever' } | null
  pick(raycaster) {
    const hits = raycaster.intersectObjects(this.pickables, false);
    if (!hits.length) return null;
    const h = hits[0], o = h.object;
    if (o.userData.key) return { type: 'key', id: o.userData.key };
    if (o.userData.part === 'paper' && h.uv) {
      const pageX = h.uv.x * PAGE_W, pageY = h.uv.y * PAGE_H;
      return { type: 'paper', col: pageX / CELL_W - 0.5, row: pageY / ROW_H - 0.62, point: h.point };
    }
    if (o.userData.part) return { type: o.userData.part };
    return null;
  }
}

export const KEY_ROWS = ROWS;
export const SHIFT_LEGENDS = SHIFTED;
