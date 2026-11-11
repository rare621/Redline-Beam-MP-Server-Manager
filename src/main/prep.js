// Prep packs: let players pre-download a server's mods so joining doesn't download anything.
//
// How it works: when a player joins, the BeamMP launcher looks in its cache folder
// (default %APPDATA%\BeamMP Launcher\Resources) for "<name>-<first 8 of SHA-256>.zip" and, if the
// full SHA-256 matches the server's, uses it instead of downloading. A prep pack is one zip holding
// the server's client mods under exactly those names, plus a manifest with each file's checksum.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const yazl = require('yazl');
const { openWithEntries } = require('./zip');

const MANIFEST = 'redline-prep.json';
const README = 'HOW TO INSTALL.txt';

const safeName = (n) => String(n).replace(/\^./g, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().replace(/\.+$/, '') || 'Server';
const cacheNameFor = (file, sha) => `${path.basename(file, path.extname(file))}-${sha.slice(0, 8)}${path.extname(file)}`;

class Prep {
  constructor({ dataDir, servers, emit, launcherCacheDir }) {
    this.servers = servers;
    this.emit = emit || (() => {});
    this.launcherCacheDir = launcherCacheDir;
    this.packDir = path.join(dataDir, 'prep-packs');
    this.hashFile = path.join(dataDir, 'hash-cache.json');
    try { this.hashes = JSON.parse(fs.readFileSync(this.hashFile, 'utf8')); } catch { this.hashes = {}; }
  }

  // SHA-256 of a file, cached by path + size + modified time (big mods take a while to hash).
  async sha256(file, onBytes) {
    const st = await fsp.stat(file);
    const key = `${path.resolve(file).toLowerCase()}|${st.size}|${Math.round(st.mtimeMs)}`;
    if (this.hashes[key]) { onBytes?.(st.size); return this.hashes[key]; }
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      const s = fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 });
      s.on('data', (c) => { hash.update(c); onBytes?.(c.length); });
      s.on('end', resolve);
      s.on('error', reject);
    });
    const sha = hash.digest('hex');
    this.hashes[key] = sha;
    fsp.writeFile(this.hashFile, JSON.stringify(this.hashes)).catch(() => {});
    return sha;
  }

  progress(p) {
    const now = Date.now();
    if (p.phase === 'progress' && now - (this.lastEmit || 0) < 120) return;
    this.lastEmit = now;
    this.emit('prep:progress', p);
  }

  // ---------- host side: build a pack from a server's enabled client mods ----------
  async buildPack(id) {
    const s = this.servers.get(id);
    const mods = this.servers.listModFiles(id).filter((m) => m.enabled);
    if (!mods.length) throw new Error('This server has no mods for players to download, so there is nothing to prep.');
    const totalBytes = mods.reduce((a, m) => a + m.size, 0);
    await fsp.mkdir(this.packDir, { recursive: true });

    // 1. checksums
    let done = 0;
    const entries = [];
    for (let i = 0; i < mods.length; i++) {
      const m = mods[i];
      const sha = await this.sha256(m.file, (n) => { done += n; this.progress({ phase: 'progress', step: 'hash', done, total: totalBytes * 2, file: m.fileName }); });
      entries.push({ file: m.fileName, cacheName: cacheNameFor(m.fileName, sha), size: m.size, sha256: sha, path: m.file });
    }

    // 2. write the zip (mods are already compressed, so they're stored as-is)
    const cfg = this.servers.readConfig(id).General;
    const serverName = safeName(cfg.Name || s.name);
    const manifest = {
      format: 'redline-prep',
      version: 1,
      server: serverName,
      created: new Date().toISOString(),
      mods: entries.map(({ path: _p, ...e }) => e),
    };
    const readme = [
      `Redline prep pack for "${serverName}"`,
      '',
      'This pack contains the mods this BeamMP server sends to players, so joining it',
      'does not have to download anything.',
      '',
      'EASY WAY (Redline): open Redline, click "Prep a friend\'s server" (bottom left)',
      'and choose this zip. Redline puts every mod in the right place and checks it.',
      '',
      'MANUAL WAY: copy every file from the "mods" folder in this zip into:',
      '  %APPDATA%\\BeamMP Launcher\\Resources',
      '(paste that path into the File Explorer address bar). Do not rename the files.',
      '',
      `Mods: ${entries.length}  ·  Size: ${(totalBytes / 1024 ** 3).toFixed(2)} GB  ·  Made ${manifest.created.slice(0, 10)}`,
    ].join('\r\n');

    const packName = `Redline Prep - ${serverName}.zip`;
    const out = path.join(this.packDir, packName);
    const tmp = `${out}.part`;
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), MANIFEST);
    zip.addBuffer(Buffer.from(readme), README);
    for (const e of entries) zip.addFile(e.path, `mods/${e.cacheName}`, { compress: false });
    zip.end();
    let written = 0;
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(tmp);
      zip.outputStream.on('data', (c) => { written += c.length; this.progress({ phase: 'progress', step: 'write', done: totalBytes + Math.min(written, totalBytes), total: totalBytes * 2, file: packName }); });
      zip.outputStream.pipe(ws);
      ws.on('close', resolve);
      ws.on('error', reject);
      zip.outputStream.on('error', reject);
    });
    await fsp.rename(tmp, out);
    const size = (await fsp.stat(out)).size;
    this.emit('prep:progress', { phase: 'built', file: packName });
    return { name: packName, size, mods: entries.length, server: serverName };
  }

  packPath(name) { return path.join(this.packDir, path.basename(String(name))); }

  async removePack(name) { await fsp.rm(this.packPath(name), { force: true }); }

  // ---------- player side: install a pack into the BeamMP launcher's cache ----------
  async installPack(zipFile) {
    const z = await openWithEntries(zipFile).catch(() => { throw new Error('That file is not a zip.'); });
    try {
      const mEntry = z.get(MANIFEST);
      if (!mEntry) throw new Error("That zip isn't a Redline prep pack (it has no redline-prep.json). Ask your friend for the file made with the Prep pack button.");
      const manifest = JSON.parse((await z.read(mEntry)).toString('utf8'));
      if (manifest.format !== 'redline-prep' || !Array.isArray(manifest.mods)) throw new Error('This prep pack is not in a format this version of Redline understands.');
      const dest = this.launcherCacheDir();
      await fsp.mkdir(dest, { recursive: true });
      const total = manifest.mods.reduce((a, m) => a + (m.size || 0), 0);
      let done = 0;
      const installed = [];
      const skipped = [];
      const failed = [];
      for (const m of manifest.mods) {
        const cacheName = path.basename(String(m.cacheName || ''));
        if (!/\.zip$/i.test(cacheName) || !/^[0-9a-f]{64}$/i.test(m.sha256 || '')) { failed.push(m.file || cacheName); continue; }
        const target = path.join(dest, cacheName);
        // Already there (the name carries the checksum) with the right size: nothing to do.
        try { if ((await fsp.stat(target)).size === m.size) { skipped.push({ file: m.file, cacheName, size: m.size }); done += m.size; this.progress({ phase: 'progress', done, total, file: m.file }); continue; } } catch { /* not there */ }
        // The launcher also accepts the plain name ("name.zip") when the contents match: if an
        // identical copy is already there, leave it alone (and never treat it as ours to delete).
        const plain = path.join(dest, path.basename(String(m.file || '')));
        try {
          if (/\.zip$/i.test(plain) && (await fsp.stat(plain)).size === m.size && (await this.sha256(plain)) === m.sha256.toLowerCase()) {
            skipped.push({ file: m.file, cacheName, size: m.size });
            done += m.size;
            this.progress({ phase: 'progress', done, total, file: m.file });
            continue;
          }
        } catch { /* not there */ }
        const entry = z.get(`mods/${cacheName}`);
        if (!entry) { failed.push(m.file); continue; }
        const tmp = `${target}.redline-part`;
        const hash = crypto.createHash('sha256');
        try {
          await new Promise((resolve, reject) => {
            z.zip.openReadStream(entry, (err, rs) => {
              if (err) return reject(err);
              const ws = fs.createWriteStream(tmp);
              rs.on('data', (c) => { hash.update(c); done += c.length; this.progress({ phase: 'progress', done, total, file: m.file }); });
              rs.on('error', reject);
              ws.on('error', reject);
              ws.on('close', resolve);
              rs.pipe(ws);
            });
          });
          if (hash.digest('hex') !== m.sha256.toLowerCase()) throw new Error('checksum mismatch');
          await fsp.rename(tmp, target);
          installed.push({ file: m.file, cacheName, size: m.size });
        } catch (e) {
          await fsp.rm(tmp, { force: true }).catch(() => {});
          failed.push(m.file);
        }
      }
      this.emit('prep:progress', { phase: 'installed' });
      return { server: manifest.server, created: manifest.created, dest, installed, skipped, failed, total: manifest.mods.length, totalBytes: total, cacheNames: manifest.mods.map((m) => path.basename(String(m.cacheName || ''))) };
    } finally {
      z.close();
    }
  }
}

module.exports = { Prep, cacheNameFor };
