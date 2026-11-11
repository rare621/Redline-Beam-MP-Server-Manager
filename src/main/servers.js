// Server registry, files, config, mods/plugins and process control.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const net = require('net');
const https = require('https');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const { shell } = require('electron');
const toml = require('./toml');

const EXE_URL = 'https://github.com/BeamMP/BeamMP-Server/releases/latest/download/BeamMP-Server.exe';
const RELEASE_API = 'https://api.github.com/repos/BeamMP/BeamMP-Server/releases/latest';
const PLUGIN_NAME = 'BeamMPManager';
const PLUGIN_SRC = path.join(__dirname, 'plugin', 'main.lua');
const MAX_LOG = 3000;

const DEFAULT_GENERAL = {
  Name: 'BeamMP Server',
  Port: 30814,
  AuthKey: '',
  AllowGuests: true,
  LogChat: true,
  Debug: false,
  IP: '::',
  Private: false,
  InformationPacket: true,
  MaxCars: 1,
  MaxPlayers: 8,
  Map: '/levels/gridmap_v2/info.json',
  Description: 'BeamMP Default Description',
  Tags: 'Freeroam',
  ResourceFolder: 'Resources',
};
const DEFAULT_MISC = { ImScaredOfUpdates: false, UpdateReminderTime: '30s' };

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[()][A-Z0-9]/g, '');
const safeName = (n) => String(n).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().replace(/\.+$/, '') || 'BeamMP Server';

function httpGet(url, { json = false, headers = {}, onProgress, dest, redirects = 6 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Redline-BeamMP-Manager', ...headers } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(httpGet(new URL(res.headers.location, url).href, { json, headers, onProgress, dest, redirects: redirects - 1 }));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      if (dest) {
        const tmp = dest + '.download';
        const out = fs.createWriteStream(tmp);
        res.on('data', (c) => { got += c.length; onProgress?.(got, total); });
        res.pipe(out);
        out.on('finish', () => out.close(() => fsp.rename(tmp, dest).then(() => resolve(dest), reject)));
        out.on('error', reject);
        res.on('error', reject);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try { resolve(json ? JSON.parse(body) : body); } catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.setTimeout(30000, () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
  });
}

class ServerManager extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.procs = new Map(); // id -> { child, logs, startedAt, stopping }
    this.logs = new Map();
  }

  // ---------- registry ----------
  get(id) {
    const s = this.store.servers.find((x) => x.id === id);
    if (!s) throw new Error('Server not found');
    return s;
  }

  findExe(dir) {
    try {
      const exes = fs.readdirSync(dir).filter((f) => /\.exe$/i.test(f));
      return path.join(dir, exes.find((f) => /^beammp[-_ ]?server\.exe$/i.test(f)) || exes.find((f) => /beammp.*server/i.test(f)) || '') || null;
    } catch { return null; }
  }

  exePath(s) {
    const e = this.findExe(s.path);
    return e && e !== s.path && fs.existsSync(e) ? e : null;
  }

  summary(s) {
    const p = this.procs.get(s.id);
    let cfg = {};
    try { cfg = this.readConfig(s.id).General || {}; } catch { /* ignore */ }
    return {
      id: s.id,
      name: s.name,
      path: s.path,
      exists: fs.existsSync(s.path),
      hasExe: !!this.exePath(s),
      status: p ? (p.stopping ? 'stopping' : 'running') : (s.lastExit && s.lastExit.crashed ? 'crashed' : 'stopped'),
      startedAt: p?.startedAt || null,
      pid: p?.child?.pid || null,
      port: cfg.Port ?? 30814,
      map: cfg.Map || '',
      maxPlayers: cfg.MaxPlayers ?? 8,
      private: cfg.Private ?? true,
      hasAuthKey: !!cfg.AuthKey,
      title: cfg.Name || s.name,
    };
  }

  list() { return this.store.servers.map((s) => this.summary(s)); }

  register(name, dir) {
    const existing = this.store.servers.find((s) => path.resolve(s.path).toLowerCase() === path.resolve(dir).toLowerCase());
    if (existing) return existing;
    const s = { id: crypto.randomUUID(), name, path: dir, createdAt: Date.now() };
    this.store.servers.push(s);
    this.store.save();
    return s;
  }

  async ensureLayout(s) {
    await fsp.mkdir(path.join(s.path, 'Resources', 'Client'), { recursive: true });
    await fsp.mkdir(path.join(s.path, 'Resources', 'Server'), { recursive: true });
    const cfg = path.join(s.path, 'ServerConfig.toml');
    if (!fs.existsSync(cfg)) {
      let text = toml.setValues('', 'General', { ...DEFAULT_GENERAL, Name: s.name });
      text = toml.setValues(text, 'Misc', DEFAULT_MISC);
      await fsp.writeFile(cfg, text);
    }
  }

  async create({ name, parentDir, port, maxPlayers, maxCars, map, authKey, isPrivate, description, download = true }) {
    if (!parentDir) throw new Error('Choose a folder for the server');
    const dir = path.join(parentDir, safeName(name));
    if (fs.existsSync(dir) && fs.readdirSync(dir).length && fs.existsSync(path.join(dir, 'ServerConfig.toml'))) {
      throw new Error(`A server already exists in ${dir}. Use "Add existing folder" instead.`);
    }
    await fsp.mkdir(dir, { recursive: true });
    const s = { id: crypto.randomUUID(), name: safeName(name), path: dir, createdAt: Date.now() };
    await this.ensureLayout(s);
    await this.writeConfig(null, {
      General: {
        Name: name,
        Port: Number(port) || 30814,
        MaxPlayers: Number(maxPlayers) || 8,
        MaxCars: Number(maxCars) || 1,
        Map: map || DEFAULT_GENERAL.Map,
        AuthKey: authKey || '',
        Private: !!isPrivate,
        Description: description || DEFAULT_GENERAL.Description,
      },
    }, s);
    this.store.servers.push(s);
    this.store.save();
    this.emit('changed', s.id);
    if (download) await this.downloadExe(s.id);
    return this.summary(s);
  }

  async importFolder(dir) {
    if (!fs.existsSync(dir)) throw new Error('Folder does not exist');
    let name = path.basename(dir);
    try {
      const cfg = toml.parse(fs.readFileSync(path.join(dir, 'ServerConfig.toml'), 'utf8'));
      if (cfg.General?.Name) name = String(cfg.General.Name).replace(/\^./g, '').trim() || name;
    } catch { /* new config will be created */ }
    const s = this.register(name, dir);
    await this.ensureLayout(s);
    this.emit('changed', s.id);
    return this.summary(s);
  }

  async remove(id, deleteFiles) {
    const s = this.get(id);
    if (this.procs.has(id)) throw new Error('Stop the server before removing it');
    if (deleteFiles && fs.existsSync(s.path)) await shell.trashItem(s.path);
    this.store.load().servers = this.store.servers.filter((x) => x.id !== id);
    this.store.save();
    this.emit('changed', null);
  }

  rename(id, name) {
    const s = this.get(id);
    s.name = String(name).trim() || s.name;
    this.store.save();
    this.emit('changed', id);
  }

  // ---------- executable ----------
  async latestRelease() {
    const r = await httpGet(RELEASE_API, { json: true });
    return { version: r.tag_name, published: r.published_at, url: r.html_url };
  }

  async downloadExe(id) {
    const s = this.get(id);
    if (this.procs.has(id)) throw new Error('Stop the server before updating it');
    const dest = path.join(s.path, 'BeamMP-Server.exe');
    this.emit('download', { id, phase: 'start', got: 0, total: 0 });
    let last = 0;
    try {
      await httpGet(EXE_URL, {
        dest,
        onProgress: (got, total) => {
          const now = Date.now();
          if (now - last > 120) { last = now; this.emit('download', { id, phase: 'progress', got, total }); }
        },
      });
    } catch (e) {
      this.emit('download', { id, phase: 'error', error: e.message });
      throw new Error('Download failed: ' + e.message);
    }
    this.emit('download', { id, phase: 'done' });
    this.emit('changed', id);
    return dest;
  }

  // ---------- config ----------
  readConfig(id, sOverride) {
    const s = sOverride || this.get(id);
    const file = path.join(s.path, 'ServerConfig.toml');
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { /* defaults */ }
    const parsed = toml.parse(text);
    return {
      General: { ...DEFAULT_GENERAL, ...(parsed.General || {}) },
      Misc: { ...DEFAULT_MISC, ...(parsed.Misc || {}) },
      raw: text,
    };
  }

  async writeConfig(id, sections, sOverride) {
    const s = sOverride || this.get(id);
    const file = path.join(s.path, 'ServerConfig.toml');
    let text = '';
    try { text = await fsp.readFile(file, 'utf8'); } catch { /* new */ }
    for (const [sec, vals] of Object.entries(sections)) text = toml.setValues(text, sec, vals);
    await fsp.writeFile(file, text);
    if (!sOverride) this.emit('changed', id);
    return this.readConfig(null, s);
  }

  async writeRawConfig(id, text) {
    const s = this.get(id);
    toml.parse(text);
    await fsp.writeFile(path.join(s.path, 'ServerConfig.toml'), text);
    this.emit('changed', id);
  }

  // ---------- manager metadata (vehicle toggles) ----------
  metaFile(s) { return path.join(s.path, '.manager', 'manager.json'); }

  readMeta(id) {
    const s = this.get(id);
    try { return { blockedVehicles: [], ...JSON.parse(fs.readFileSync(this.metaFile(s), 'utf8')) }; } catch { return { blockedVehicles: [] }; }
  }

  async writeMeta(id, patch) {
    const s = this.get(id);
    const meta = { ...this.readMeta(id), ...patch };
    await fsp.mkdir(path.dirname(this.metaFile(s)), { recursive: true });
    await fsp.writeFile(this.metaFile(s), JSON.stringify(meta, null, 2));
    await this.installPlugin(s);
    this.emit('changed', id);
    return meta;
  }

  setBlockedVehicles(id, models) {
    return this.writeMeta(id, { blockedVehicles: [...new Set(models.map(String))] });
  }

  resourceDir(s) {
    let folder = 'Resources';
    try { folder = this.readConfig(null, s).General.ResourceFolder || 'Resources'; } catch { /* default */ }
    return path.resolve(s.path, folder);
  }

  async installPlugin(s) {
    const dir = path.join(this.resourceDir(s), 'Server', PLUGIN_NAME);
    await fsp.mkdir(dir, { recursive: true });
    // readFile works inside the packaged app archive (asar); copyFile may not.
    await fsp.writeFile(path.join(dir, 'main.lua'), await fsp.readFile(PLUGIN_SRC));
    let blocked = [];
    try { blocked = JSON.parse(fs.readFileSync(this.metaFile(s), 'utf8')).blockedVehicles || []; } catch { /* none */ }
    const lua = '-- Generated by Redline: vehicles switched off for this server\nreturn {\n'
      + blocked.map((m) => `  [${JSON.stringify(m)}] = true,`).join('\n') + '\n}\n';
    await fsp.writeFile(path.join(dir, 'blocked.lua'), lua);
  }

  // ---------- mods ----------
  disabledDir(s) { return path.join(s.path, '.manager', 'disabled_mods'); }
  clientDir(s) { return path.join(this.resourceDir(s), 'Client'); }

  listModFiles(id) {
    const s = this.get(id);
    const read = (dir, enabled) => {
      try {
        return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.zip')).map((f) => {
          const st = fs.statSync(path.join(dir, f));
          return { fileName: f, file: path.join(dir, f), size: st.size, mtime: st.mtimeMs, enabled };
        });
      } catch { return []; }
    };
    return [...read(this.clientDir(s), true), ...read(this.disabledDir(s), false)].sort((a, b) => a.fileName.localeCompare(b.fileName));
  }

  async addMods(id, files) {
    const s = this.get(id);
    const dir = this.clientDir(s);
    await fsp.mkdir(dir, { recursive: true });
    const added = [];
    const skipped = [];
    for (const f of files) {
      if (!/\.zip$/i.test(f)) { skipped.push(path.basename(f)); continue; }
      const dest = path.join(dir, path.basename(f));
      if (path.resolve(f).toLowerCase() !== path.resolve(dest).toLowerCase()) await fsp.copyFile(f, dest);
      added.push(path.basename(f));
    }
    this.emit('changed', id);
    return { added, skipped, restartNeeded: this.procs.has(id) };
  }

  async setModEnabled(id, fileName, enabled) {
    const s = this.get(id);
    const from = path.join(enabled ? this.disabledDir(s) : this.clientDir(s), path.basename(fileName));
    const toDir = enabled ? this.clientDir(s) : this.disabledDir(s);
    await fsp.mkdir(toDir, { recursive: true });
    await fsp.rename(from, path.join(toDir, path.basename(fileName)));
    this.emit('changed', id);
    return { restartNeeded: this.procs.has(id) };
  }

  async removeMod(id, fileName) {
    const s = this.get(id);
    for (const dir of [this.clientDir(s), this.disabledDir(s)]) {
      const p = path.join(dir, path.basename(fileName));
      if (fs.existsSync(p)) await shell.trashItem(p);
    }
    this.emit('changed', id);
    return { restartNeeded: this.procs.has(id) };
  }

  // ---------- server plugins ----------
  listPlugins(id) {
    const s = this.get(id);
    const dir = path.join(this.resourceDir(s), 'Server');
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
        const p = path.join(dir, d.name);
        let files = [];
        try { files = fs.readdirSync(p); } catch { /* ignore */ }
        return { name: d.name, path: p, files: files.length, lua: files.filter((f) => f.endsWith('.lua')).length, system: d.name === PLUGIN_NAME };
      });
    } catch { return []; }
  }

  async addPlugin(id, src) {
    const s = this.get(id);
    const dest = path.join(this.resourceDir(s), 'Server', path.basename(src));
    await fsp.cp(src, dest, { recursive: true });
    this.emit('changed', id);
  }

  async removePlugin(id, name) {
    const s = this.get(id);
    if (name === PLUGIN_NAME) throw new Error('The manager helper plugin is required for player list and vehicle filtering');
    await shell.trashItem(path.join(this.resourceDir(s), 'Server', path.basename(name)));
    this.emit('changed', id);
  }

  // ---------- file browser ----------
  resolveIn(s, rel = '') {
    const root = path.resolve(s.path);
    const p = path.resolve(root, rel || '.');
    if (p !== root && !p.startsWith(root + path.sep)) throw new Error('Path is outside the server folder');
    return p;
  }

  async listDir(id, rel) {
    const s = this.get(id);
    const dir = this.resolveIn(s, rel);
    const items = await fsp.readdir(dir, { withFileTypes: true });
    const out = [];
    for (const it of items) {
      let st = null;
      try { st = await fsp.stat(path.join(dir, it.name)); } catch { /* ignore */ }
      out.push({ name: it.name, dir: it.isDirectory(), size: st?.size || 0, mtime: st?.mtimeMs || 0, rel: path.relative(s.path, path.join(dir, it.name)) });
    }
    return out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  }

  async readText(id, rel) {
    const p = this.resolveIn(this.get(id), rel);
    const st = await fsp.stat(p);
    if (st.size > 3 * 1024 * 1024) throw new Error('File is too large to edit here');
    return fsp.readFile(p, 'utf8');
  }

  async writeText(id, rel, text) {
    await fsp.writeFile(this.resolveIn(this.get(id), rel), text);
    this.emit('changed', id);
  }

  async addFiles(id, rel, files) {
    const s = this.get(id);
    const dir = this.resolveIn(s, rel);
    for (const f of files) {
      const dest = path.join(dir, path.basename(f));
      const st = await fsp.stat(f);
      if (st.isDirectory()) await fsp.cp(f, dest, { recursive: true });
      else await fsp.copyFile(f, dest);
    }
    this.emit('changed', id);
  }

  async mkdir(id, rel, name) {
    await fsp.mkdir(path.join(this.resolveIn(this.get(id), rel), safeName(name)), { recursive: true });
  }

  async deletePath(id, rel) {
    const s = this.get(id);
    const p = this.resolveIn(s, rel);
    if (p === path.resolve(s.path)) throw new Error('Cannot delete the server root');
    await shell.trashItem(p);
    this.emit('changed', id);
  }

  async renamePath(id, rel, newName) {
    const s = this.get(id);
    const p = this.resolveIn(s, rel);
    await fsp.rename(p, path.join(path.dirname(p), safeName(newName)));
  }

  reveal(id, rel) {
    const s = this.get(id);
    const p = this.resolveIn(s, rel);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) shell.openPath(p);
    else shell.showItemInFolder(p);
  }

  // ---------- process control ----------
  portFree(port) {
    return new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(port, '0.0.0.0');
    });
  }

  pushLog(id, line, kind = 'out') {
    let arr = this.logs.get(id);
    if (!arr) this.logs.set(id, (arr = []));
    const entry = { t: Date.now(), line, kind };
    arr.push(entry);
    if (arr.length > MAX_LOG) arr.splice(0, arr.length - MAX_LOG);
    this.emit('log', { id, ...entry });
  }

  getLogs(id) { return this.logs.get(id) || []; }
  clearLogs(id) { this.logs.set(id, []); }

  async start(id) {
    const s = this.get(id);
    if (this.procs.has(id)) return this.summary(s);
    const exe = this.exePath(s);
    if (!exe) throw new Error('BeamMP-Server.exe is missing. Download it from the server page first.');
    await this.ensureLayout(s);
    await this.installPlugin(s);
    const cfg = this.readConfig(id).General;
    if (!(await this.portFree(Number(cfg.Port)))) throw new Error(`Port ${cfg.Port} is already in use by another program or server.`);
    try { await fsp.unlink(path.join(this.resourceDir(s), 'Server', PLUGIN_NAME, 'status.json')); } catch { /* none */ }

    const child = spawn(exe, [], { cwd: s.path, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const rec = { child, startedAt: Date.now(), stopping: false };
    this.procs.set(id, rec);
    s.lastExit = null;
    this.pushLog(id, `▶ Starting ${path.basename(exe)} in ${s.path}`, 'sys');

    const pipe = (stream, kind) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (d) => {
        buf += d;
        const parts = buf.split(/\r?\n|\r(?!\n)/);
        buf = parts.pop();
        for (const p of parts) {
          const line = stripAnsi(p).replace(/^>\s*$/, '').trimEnd();
          if (line) this.pushLog(id, line, kind);
        }
      });
    };
    pipe(child.stdout, 'out');
    pipe(child.stderr, 'err');
    child.on('error', (e) => this.pushLog(id, 'Process error: ' + e.message, 'err'));
    child.on('exit', (code) => {
      clearTimeout(rec.killTimer);
      this.procs.delete(id);
      const crashed = !rec.stopping && code !== 0;
      s.lastExit = { code, crashed, at: Date.now() };
      this.pushLog(id, `■ Server exited (code ${code ?? 'killed'})${crashed ? ' — it stopped unexpectedly, check the log above' : ''}`, crashed ? 'err' : 'sys');
      this.emit('status', this.summary(s));
    });
    this.emit('status', this.summary(s));
    return this.summary(s);
  }

  stop(id) {
    const rec = this.procs.get(id);
    if (!rec) return Promise.resolve();
    return new Promise((resolve) => {
      rec.child.once('exit', () => resolve());
      if (rec.stopping) return;
      rec.stopping = true;
      this.emit('status', this.summary(this.get(id)));
      this.pushLog(id, '■ Stopping server…', 'sys');
      try { rec.child.stdin.write('exit\n'); } catch { /* ignore */ }
      rec.killTimer = setTimeout(() => this.kill(id), 8000);
    });
  }

  kill(id) {
    const rec = this.procs.get(id);
    if (!rec) return;
    rec.stopping = true;
    execFile('taskkill', ['/pid', String(rec.child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  }

  async restart(id) {
    await this.stop(id);
    return this.start(id);
  }

  command(id, cmd) {
    const rec = this.procs.get(id);
    if (!rec) throw new Error('Server is not running');
    this.pushLog(id, '> ' + cmd, 'cmd');
    rec.child.stdin.write(cmd + '\n');
  }

  readPlayers(id) {
    const s = this.get(id);
    if (!this.procs.has(id)) return [];
    try {
      const st = JSON.parse(fs.readFileSync(path.join(this.resourceDir(s), 'Server', PLUGIN_NAME, 'status.json'), 'utf8'));
      if (Date.now() / 1000 - st.time > 15) return [];
      return st.players || [];
    } catch { return []; }
  }

  runningCount() { return this.procs.size; }

  async stopAll() {
    await Promise.all([...this.procs.keys()].map((id) => this.stop(id)));
  }
}

module.exports = { ServerManager, DEFAULT_GENERAL, httpGet };
