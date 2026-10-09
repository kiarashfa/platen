// Persistence: one IndexedDB record holds settings and every page. Falls back to localStorage,
// and to memory only when storage is blocked (private windows, previews).
const DB = 'platen', STORE = 'kv', KEY = 'state-v1';

function idb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('no indexedDB'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// strikes are stored as compact arrays: [c, x, y, k, p, s, f, w, g]
const FACES = ['pica', 'elite', 'cutive'];
const pack = s => [s.c, s.x, s.y, s.k, Math.round(s.p * 100) / 100, s.s, FACES.indexOf(s.f), Math.round((s.w || 0) * 100) / 100, s.g ? 1 : 0];
const unpack = a => {
  const s = { c: a[0], x: a[1], y: a[2], k: a[3], p: a[4], s: a[5], f: FACES[a[6]] || 'pica', w: a[7] };
  if (a[8]) s.g = 1;
  return s;
};

export class Store {
  constructor() {
    this.db = null;
    this.timer = 0;
    this.ready = idb().then(db => { this.db = db; }).catch(() => { this.db = null; });
  }

  async load() {
    await this.ready;
    let raw = null;
    try {
      if (this.db) {
        raw = await new Promise((res, rej) => {
          const r = this.db.transaction(STORE).objectStore(STORE).get(KEY);
          r.onsuccess = () => res(r.result || null);
          r.onerror = () => rej(r.error);
        });
      }
    } catch { raw = null; }
    if (!raw) {
      try { const t = localStorage.getItem('platen.' + KEY); raw = t ? JSON.parse(t) : null; } catch { raw = null; }
    }
    if (!raw) return null;
    try {
      return {
        settings: raw.settings || {},
        current: raw.current || 0,
        pages: (raw.pages || []).map(p => ({
          ...p, strikes: (p.strikes || []).map(unpack), ghosts: (p.ghosts || []).map(unpack),
        })),
      };
    } catch { return null; }
  }

  // debounced save of the whole state
  save(state, delay = 700) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(state), delay);
  }

  async saveNow(state) {
    clearTimeout(this.timer);
    const raw = {
      settings: state.settings, current: state.current,
      pages: state.pages.map(p => ({ id: p.id, paper: p.paper, created: p.created, cursor: p.cursor,
        strikes: p.strikes.map(pack), ghosts: (p.ghosts || []).map(pack) })),
    };
    await this.ready;
    try {
      if (this.db) {
        await new Promise((res, rej) => {
          const tx = this.db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(raw, KEY);
          tx.oncomplete = res; tx.onerror = () => rej(tx.error);
        });
        return true;
      }
    } catch { /* fall through */ }
    try { localStorage.setItem('platen.' + KEY, JSON.stringify(raw)); return true; } catch { return false; }
  }
}
