// Discovers BeamNG content: stock vehicles & maps from the game install,
// plus vehicles/maps inside mod zips. Extracts preview photos into a cache.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { openWithEntries, lenientJson } = require('./zip');

const HIDDEN_LEVELS = new Set(['template', 'showroom_v2', 'showroom_v2_lighting_simple', 'autotest', 'garage_v2']);
const SKIP_VEHICLE_ZIPS = new Set(['common']);

// Used only when no BeamNG install can be found.
const FALLBACK_MAPS = [
  ['gridmap_v2', 'Grid Map'], ['automation_test_track', 'Automation Test Track'], ['east_coast_usa', 'East Coast, USA'],
  ['west_coast_usa', 'West Coast, USA'], ['hirochi_raceway', 'Hirochi Raceway'], ['italy', 'Italy'],
  ['jungle_rock_island', 'Jungle Rock Island'], ['industrial', 'Industrial Site'], ['small_island', 'Small Island, USA'],
  ['smallgrid', 'Small Grid'], ['utah', 'Utah, USA'], ['driver_training', 'Driver Training Grounds'],
  ['derby', 'Derby Arenas'], ['johnson_valley', 'Johnson Valley'], ['cliff', 'Cliff'],
];
const FALLBACK_VEHICLES = {
  car: 'autobello barstow bastion bluebuck bolide burnside bx covet etk800 etkc etki fullsize hopper lansdale legran midsize miramar moonhawk nine pessima pigeon roamer sbr scintilla sunburst2 vivace wendover wigeon atv utv racetruck rockbouncer',
  truck: 'pickup van midtruck md_series us_semi citybus dumptruck wl40 percheron',
  trailer: 'boxutility boxutility_large caravan cargotrailer containerTrailer dolly dryvan flatbed frameless_dump log_trailer tanker tiltdeck tsfb',
  prop: 'cones barrier barrels ball blockwall bollard cannon couch delineator gate haybale piano rocks roadsigns spikestrip trafficbarrel tirestacks tirewall trampoline woodcrate woodplanks',
  other: 'unicycle',
};

const prettify = (id) => String(id).replace(/[_\-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
const fileUrl = (p) => (p ? pathToFileURL(p).href : null);

function categoryFor(type, model) {
  const t = String(type || '').toLowerCase();
  if (model === 'unicycle') return 'other';
  if (t.includes('trailer')) return 'trailer';
  if (t.includes('truck') || t.includes('bus') || t.includes('machinery')) return 'truck';
  if (t.includes('car') || t.includes('automation')) return 'car';
  if (t.includes('prop') || t.includes('utility')) return 'prop';
  return t ? 'other' : 'car';
}

class ContentService {
  constructor({ dataDir, getSettings, emit }) {
    this.dataDir = dataDir;
    this.thumbDir = path.join(dataDir, 'thumbs');
    this.getSettings = getSettings;
    this.emit = emit || (() => {});
    this.stock = null;
    this.stockPromise = null;
    this.modCacheFile = path.join(dataDir, 'mod-cache.json');
    try { this.modCache = JSON.parse(fs.readFileSync(this.modCacheFile, 'utf8')); } catch { this.modCache = {}; }
    fs.mkdirSync(this.thumbDir, { recursive: true });
  }

  // ---------- locating the game ----------
  // BeamNG records its install and (optionally) a custom user folder in these ini files.
  readBeamIni() {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const out = {};
    for (const f of [path.join(local, 'BeamNG', 'BeamNG.drive.ini'), path.join(local, 'BeamNG.drive', 'BeamNG.drive.ini')]) {
      try {
        for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
          const m = line.match(/^\s*([A-Za-z_]+)\s*=\s*(.+?)\s*$/);
          if (m && !out[m[1].toLowerCase()]) out[m[1].toLowerCase()] = m[2].replace(/^"|"$/g, '');
        }
      } catch { /* ignore */ }
    }
    return out;
  }

  async findGameDir() {
    if (process.env.REDLINE_NO_GAME) return null; // test switch: behave like a PC without BeamNG
    const override = this.getSettings().beamngPath;
    if (override && fs.existsSync(path.join(override, 'content'))) return override;
    const ini = this.readBeamIni();
    if (ini.installpath && fs.existsSync(path.join(ini.installpath, 'content', 'vehicles'))) return path.resolve(ini.installpath);
    const libs = new Set(['C:/Program Files (x86)/Steam', 'C:/Program Files/Steam']);
    // Common non-Steam / alternate Steam locations on every drive.
    for (const d of 'CDEFGHIJ') {
      for (const p of [`${d}:/SteamLibrary`, `${d}:/Steam`, `${d}:/Games/Steam`, `${d}:/Program Files (x86)/Steam`]) libs.add(p);
      for (const p of [`${d}:/BeamNG.drive`, `${d}:/Games/BeamNG.drive`]) if (fs.existsSync(path.join(p, 'content', 'vehicles'))) return p;
    }
    const steam = await new Promise((resolve) =>
      execFile('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true }, (err, out) =>
        resolve(err ? null : (String(out).match(/SteamPath\s+REG_SZ\s+(.+)/) || [])[1]?.trim())));
    if (steam) libs.add(steam);
    for (const lib of [...libs]) {
      try {
        const vdf = await fsp.readFile(path.join(lib, 'steamapps', 'libraryfolders.vdf'), 'utf8');
        for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1].replace(/\\\\/g, '\\'));
      } catch { /* ignore */ }
    }
    for (const lib of libs) {
      const dir = path.join(lib, 'steamapps', 'common', 'BeamNG.drive');
      if (fs.existsSync(path.join(dir, 'content', 'vehicles'))) return dir;
    }
    return null;
  }

  findUserModsDir() {
    if (process.env.REDLINE_NO_GAME) return null;
    const override = this.getSettings().modsPath;
    if (override && fs.existsSync(override)) return override;
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const ini = this.readBeamIni();
    const custom = ini.userfolder || ini.userpath;
    const candidates = [];
    if (custom) candidates.push(path.join(custom, 'current', 'mods'), path.join(custom, 'mods'));
    candidates.push(path.join(local, 'BeamNG', 'BeamNG.drive', 'current', 'mods'));
    try {
      const old = path.join(local, 'BeamNG.drive');
      const versions = fs.readdirSync(old).filter((v) => /^\d+\.\d+$/.test(v))
        .sort((a, b) => parseFloat(b) - parseFloat(a));
      for (const v of versions) candidates.push(path.join(old, v, 'mods'));
    } catch { /* ignore */ }
    candidates.push(path.join(os.homedir(), 'Documents', 'BeamNG.drive', 'mods'));
    return candidates.find((c) => fs.existsSync(c)) || null;
  }

  loadTranslations(gameDir) {
    const tr = {};
    const base = path.join(gameDir, 'locales');
    const tryFile = (f) => { try { Object.assign(tr, lenientJson(fs.readFileSync(f))); } catch { /* ignore */ } };
    const dir = path.join(base, 'translations', 'en-US');
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) tryFile(path.join(dir, f));
    }
    tryFile(path.join(base, 'en-US.json'));
    return tr;
  }

  // ---------- thumbnails ----------
  async saveThumb(z, entry, key) {
    if (!entry) return null;
    const ext = path.extname(entry.fileName).toLowerCase() || '.jpg';
    const out = path.join(this.thumbDir, key.replace(/[^a-z0-9_\-]/gi, '_') + ext);
    if (!fs.existsSync(out)) {
      try { await fsp.writeFile(out, await z.read(entry)); } catch { return null; }
    }
    return out;
  }

  pickVehicleImage(z, dir, defaultPc) {
    const inDir = z.entries.filter((e) => {
      const n = e.fileName.toLowerCase();
      return n.startsWith(dir) && !n.slice(dir.length).includes('/') && /\.(jpe?g|png)$/.test(n);
    });
    const find = (re) => inDir.find((e) => re.test(e.fileName.slice(dir.length).toLowerCase()));
    return find(/^default\.(jpe?g|png)$/)
      || (defaultPc && find(new RegExp(`^${defaultPc.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(jpe?g|png)$`)))
      || inDir.sort((a, b) => b.uncompressedSize - a.uncompressedSize).find((e) => e.uncompressedSize < 2e6);
  }

  pickLevelImage(z, dir, info) {
    const previews = Array.isArray(info?.previews) ? info.previews : [];
    for (const p of previews) {
      const e = z.get(dir + String(p).replace(/^\/?(levels\/[^/]+\/)?/i, ''));
      if (e) return e;
    }
    const imgs = z.entries.filter((e) => {
      const n = e.fileName.toLowerCase();
      return n.startsWith(dir) && !n.slice(dir.length).includes('/') && /\.(jpe?g|png)$/.test(n) && !/minimap|terrain|\.ter\./.test(n);
    });
    return imgs.find((e) => /preview/i.test(e.fileName) && !/spawn_/i.test(e.fileName))
      || imgs.find((e) => /preview/i.test(e.fileName))
      || imgs.find((e) => e.uncompressedSize < 4e6);
  }

  // Scan vehicles and levels inside an opened zip.
  async scanZipContent(z, thumbPrefix, tr = {}) {
    const t = (v) => (v && tr[v]) || (v && !/^[a-z]+(Data)?\.[\w.]+$/i.test(v) ? v : null);
    const vehicles = [];
    const maps = [];
    const vehicleDirs = new Set();
    const levelDirs = new Set();
    for (const name of z.names) {
      let m = name.match(/^vehicles\/([^/]+)\/info\.json$/i);
      if (m) vehicleDirs.add(m[1]);
      m = name.match(/^vehicles\/([^/]+)\/[^/]+\.jbeam$/i);
      if (m) vehicleDirs.add(m[1]);
      m = name.match(/^levels\/([^/]+)\/(info\.json|main\.level\.json|[^/]+\.mis)$/i);
      if (m) levelDirs.add(m[1]);
    }
    for (const model of vehicleDirs) {
      if (model.toLowerCase() === 'common') continue;
      const dir = `vehicles/${model}/`.toLowerCase();
      const infoEntry = z.get(`vehicles/${model}/info.json`);
      if (!infoEntry && !z.names.some((n) => n.toLowerCase().startsWith(dir) && /\.pc$/i.test(n))) continue;
      let info = {};
      if (infoEntry) { try { info = lenientJson(await z.read(infoEntry)); } catch { /* ignore */ } }
      const brand = t(info.Brand) || '';
      let nm = t(info.Name) || prettify(model);
      if (brand && !nm.toLowerCase().startsWith(brand.toLowerCase())) nm = `${brand} ${nm}`;
      const img = this.pickVehicleImage(z, dir, info.default_pc);
      const thumb = await this.saveThumb(z, img, `${thumbPrefix}_v_${model}`);
      vehicles.push({
        model, name: nm, brand, type: info.Type || '', category: categoryFor(info.Type, model),
        author: t(info.Author) || '', thumb: fileUrl(thumb),
      });
    }
    for (const id of levelDirs) {
      const dir = `levels/${id}/`.toLowerCase();
      let info = {};
      const infoEntry = z.get(`levels/${id}/info.json`);
      if (infoEntry) { try { info = lenientJson(await z.read(infoEntry)); } catch { /* ignore */ } }
      const img = this.pickLevelImage(z, dir, info);
      const thumb = await this.saveThumb(z, img, `${thumbPrefix}_m_${id}`);
      maps.push({
        id, title: t(info.title) || prettify(id), description: t(info.description) || '',
        authors: t(info.authors) || '', size: Array.isArray(info.size) ? info.size : null,
        thumb: fileUrl(thumb), mapPath: `/levels/${id}/info.json`,
      });
    }
    return { vehicles, maps };
  }

  // ---------- stock content ----------
  getStock(force = false) {
    if (this.stock && !force) return Promise.resolve(this.stock);
    if (!this.stockPromise || force) {
      this.stockPromise = this._scanStock(force).then((s) => { this.stock = s; return s; })
        .finally(() => { this.stockPromise = null; });
    }
    return this.stockPromise;
  }

  async _scanStock(force) {
    const gameDir = await this.findGameDir();
    if (!gameDir) return this.fallbackStock();
    const vDir = path.join(gameDir, 'content', 'vehicles');
    const lDir = path.join(gameDir, 'content', 'levels');
    const list = (d) => { try { return fs.readdirSync(d).filter((f) => f.toLowerCase().endsWith('.zip')).map((f) => path.join(d, f)); } catch { return []; } };
    const vZips = list(vDir).filter((f) => !SKIP_VEHICLE_ZIPS.has(path.basename(f, '.zip').toLowerCase()));
    const lZips = list(lDir).filter((f) => !HIDDEN_LEVELS.has(path.basename(f, '.zip').toLowerCase()));
    const stamp = [...vZips, ...lZips].map((f) => { try { return `${path.basename(f)}:${fs.statSync(f).mtimeMs}`; } catch { return f; } }).join('|');
    const stampHash = crypto.createHash('md5').update(gameDir + stamp).digest('hex');
    const cacheFile = path.join(this.dataDir, 'stock-cache.json');
    if (!force) {
      try {
        const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (c.stamp === stampHash && c.version === 3) return c.data;
      } catch { /* rescan */ }
    }
    const tr = this.loadTranslations(gameDir);
    const vehicles = [];
    const maps = [];
    const all = [...vZips, ...lZips];
    let done = 0;
    for (const file of all) {
      this.emit('content:progress', { done, total: all.length, label: path.basename(file) });
      let z;
      try {
        z = await openWithEntries(file);
        const r = await this.scanZipContent(z, 'stock', tr);
        vehicles.push(...r.vehicles);
        maps.push(...r.maps.filter((m) => !HIDDEN_LEVELS.has(m.id.toLowerCase())));
      } catch (e) {
        console.warn('scan failed', file, e.message);
      } finally {
        z?.close();
      }
      done++;
    }
    this.emit('content:progress', { done, total: all.length, label: 'Done' });
    vehicles.sort((a, b) => a.name.localeCompare(b.name));
    maps.sort((a, b) => a.title.localeCompare(b.title));
    const data = { gameDir, vehicles, maps, fallback: false };
    try { fs.writeFileSync(cacheFile, JSON.stringify({ version: 3, stamp: stampHash, data })); } catch { /* ignore */ }
    return data;
  }

  fallbackStock() {
    // Prefer the bundled list of real stock names (text only, no game assets).
    try {
      const names = JSON.parse(fs.readFileSync(path.join(__dirname, 'stock-names.json'), 'utf8'));
      const vehicles = names.vehicles.map((v) => ({ ...v, thumb: null })).sort((a, b) => a.name.localeCompare(b.name));
      const maps = names.maps.map((m) => ({ ...m, description: '', thumb: null, mapPath: `/levels/${m.id}/info.json` })).sort((a, b) => a.title.localeCompare(b.title));
      return { gameDir: null, vehicles, maps, fallback: true };
    } catch { /* fall back to the short built-in list */ }
    const vehicles = [];
    for (const [category, list] of Object.entries(FALLBACK_VEHICLES)) {
      for (const model of list.split(' ')) vehicles.push({ model, name: prettify(model), brand: '', category, thumb: null });
    }
    const maps = FALLBACK_MAPS.map(([id, title]) => ({ id, title, description: '', thumb: null, mapPath: `/levels/${id}/info.json` }));
    return { gameDir: null, vehicles, maps, fallback: true };
  }

  // ---------- mods ----------
  async scanMod(file) {
    let st;
    try { st = await fsp.stat(file); } catch { return null; }
    const key = `${path.basename(file)}|${st.size}|${Math.round(st.mtimeMs)}`;
    const cached = this.modCache[key];
    if (cached && (!cached.thumbPath || fs.existsSync(cached.thumbPath))) return { ...cached.data, file, fileName: path.basename(file), size: st.size };
    const hash = crypto.createHash('md5').update(key).digest('hex').slice(0, 12);
    let z;
    const result = { title: prettify(path.basename(file, '.zip')), kind: 'other', vehicles: [], maps: [], thumb: null, author: '', tagline: '' };
    let thumbPath = null;
    try {
      z = await openWithEntries(file);
      const r = await this.scanZipContent(z, `mod_${hash}`);
      result.vehicles = r.vehicles;
      result.maps = r.maps;
      // Repository mods ship a mod_info folder with a title and icon.
      const infoName = z.names.find((n) => /^mod_info\/[^/]+\/info\.json$/i.test(n));
      if (infoName) {
        try {
          const info = lenientJson(await z.read(z.get(infoName)));
          if (info.title) result.title = String(info.title).replace(/\[[^\]]*\]/g, '').trim() || result.title;
          result.author = info.username || '';
          result.tagline = info.tag_line || '';
        } catch { /* ignore */ }
        const icon = z.names.find((n) => n.toLowerCase().startsWith(path.dirname(infoName).toLowerCase() + '/') && /icon\.(jpe?g|png)$/i.test(n));
        if (icon) thumbPath = await this.saveThumb(z, z.get(icon), `mod_${hash}_icon`);
      }
      if (!thumbPath) {
        const first = r.maps.find((m) => m.thumb) || r.vehicles.find((v) => v.thumb);
        if (first) thumbPath = require('url').fileURLToPath(first.thumb);
      }
      result.kind = r.maps.length && r.vehicles.length ? 'mixed' : r.maps.length ? 'map' : r.vehicles.length ? 'vehicle' : 'other';
      result.thumb = fileUrl(thumbPath);
    } catch (e) {
      result.error = 'Could not read zip: ' + e.message;
    } finally {
      z?.close();
    }
    this.modCache[key] = { data: result, thumbPath };
    fsp.writeFile(this.modCacheFile, JSON.stringify(this.modCache)).catch(() => {});
    return { ...result, file, fileName: path.basename(file), size: st.size };
  }

  async scanMods(files) {
    const out = [];
    for (const f of files) {
      const r = await this.scanMod(f);
      if (r) out.push(r);
    }
    return out;
  }

  // The BeamMP Launcher's Resources folder (where BeamMP keeps multiplayer mods).
  beammpResourcesDir() {
    const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const launchers = [path.join(roaming, 'BeamMP Launcher'), path.join(roaming, 'BeamMP-Launcher')];
    const launcher = launchers.find((d) => fs.existsSync(path.join(d, 'Resources'))) || launchers.find((d) => fs.existsSync(d)) || launchers[0];
    // The launcher's cache folder, as set by "CachingDirectory" in Launcher.cfg (default ./Resources).
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(launcher, 'Launcher.cfg'), 'utf8'));
      if (typeof cfg.CachingDirectory === 'string' && cfg.CachingDirectory.trim()) return path.resolve(launcher, cfg.CachingDirectory.trim());
    } catch { /* default */ }
    return path.join(launcher, 'Resources');
  }

  // Older Redline versions used this folder as the central library.
  legacyLibraryDir() { return path.join(os.homedir(), 'Documents', 'Redline Mods Library'); }

  // Central library: collects every mod/track zip from all servers. Defaults to the BeamMP
  // Launcher's Resources folder (created if missing); can be changed in App settings.
  centralLibraryDir() {
    const dir = this.getSettings().libraryPath || this.beammpResourcesDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* reported when used */ }
    return dir;
  }

  isDefaultLibrary() { return !this.getSettings().libraryPath; }

  // Mods available to add, tagged by source: 'beammp' (central library / launcher resources)
  // and 'beamng' (the BeamNG mods folder, if this PC has one).
  async listUserLibrary() {
    const central = this.centralLibraryDir();
    const beam = this.findUserModsDir();
    const sources = [[central, 'beammp'], [beam, 'beamng']].filter(([d]) => d);
    const files = [];
    for (const [dir, source] of sources) {
      const seen = new Map(); // dedupe key -> index in files
      const walk = (d, depth) => {
        let items = [];
        try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const it of items) {
          const p = path.join(d, it.name);
          if (it.isDirectory() && depth < 2 && it.name !== 'multiplayer') { walk(p, depth + 1); continue; }
          if (!it.isFile() || !it.name.toLowerCase().endsWith('.zip')) continue;
          // The BeamMP launcher keeps copies as "name-1a2b3c4d.zip"; show each mod once.
          let size = 0;
          try { size = fs.statSync(p).size; } catch { continue; }
          const base = it.name.toLowerCase().replace(/-[0-9a-f]{8}(?=\.zip$)/, '');
          const key = `${base}|${size}`;
          const hashed = base !== it.name.toLowerCase();
          if (seen.has(key)) {
            if (!hashed) files[seen.get(key)].file = p; // prefer the plain name
            continue;
          }
          seen.set(key, files.length);
          files.push({ file: p, source });
        }
      };
      walk(dir, 0);
    }
    const mods = [];
    for (let i = 0; i < files.length; i++) {
      this.emit('content:progress', { kind: 'library', done: i, total: files.length, label: path.basename(files[i].file) });
      const r = await this.scanMod(files[i].file);
      if (r) mods.push({ ...r, source: files[i].source });
    }
    mods.sort((a, b) => a.title.localeCompare(b.title));
    const resources = this.beammpResourcesDir();
    return {
      dir: central,
      central,
      centralIsLauncher: path.resolve(central).toLowerCase() === path.resolve(resources).toLowerCase(),
      beamngDir: beam,
      mods,
    };
  }
}

module.exports = { ContentService, prettify };
