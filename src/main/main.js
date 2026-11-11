const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, clipboard, safeStorage, session } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const store = require('./store');
const { ServerManager, httpGet } = require('./servers');
const { ContentService } = require('./content');
const { RemoteHost, RemoteClient, DEFAULT_PORT } = require('./remote');
const { Prep } = require('./prep');

nativeTheme.themeSource = 'dark';
if (process.env.BEAMMP_MANAGER_DATA) app.setPath('userData', process.env.BEAMMP_MANAGER_DATA);
const RENDERER = path.join(__dirname, '..', 'renderer');
let mainWin = null;
let pickerWin = null;
let quitting = false;

const servers = new ServerManager(store);
let content = null;
let prep = null;
let prepLocal = null;

const handlers = {};
const remoteClient = new RemoteClient();
let remoteHost = null;

function sendToWindows(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
}
// Local events go to our windows (unless they're showing a remote host) and to remote clients.
function broadcast(channel, payload) {
  if (!remoteClient.connected) sendToWindows(channel, payload);
  remoteHost?.broadcast(channel, payload);
}
remoteClient.on('event', ({ channel, payload }) => sendToWindows(channel, payload));
remoteClient.on('state', (st) => {
  sendToWindows('remote:state', st);
  if (!st.connected) { clearWebCache(); reloadWindows(); }
});
remoteClient.on('upload', (u) => sendToWindows('remote:upload', u));

function reloadWindows() {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.reload();
}
servers.on('log', (e) => broadcast('server:log', e));
servers.on('status', (e) => broadcast('server:status', e));
servers.on('changed', (id) => broadcast('server:changed', id));
servers.on('download', (e) => broadcast('server:download', e));
servers.on('update-available', (e) => broadcast('server:update', e));

const winOpts = (extra) => ({
  backgroundColor: '#0b0d12',
  icon: path.join(RENDERER, 'assets', 'icon.png'),
  titleBarStyle: 'hidden',
  titleBarOverlay: { color: '#00000000', symbolColor: '#c9cfdb', height: 40 },
  show: false,
  webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  ...extra,
});

function createMain() {
  mainWin = new BrowserWindow(winOpts({ width: 1360, height: 860, minWidth: 1040, minHeight: 680, title: 'Redline' }));
  mainWin.loadFile(path.join(RENDERER, 'index.html'));
  const reveal = () => {
    if (!mainWin || mainWin.isDestroyed() || mainWin.isVisible()) return;
    mainWin.show();
    // Windows may open new windows behind others; pull it to the front once.
    mainWin.setAlwaysOnTop(true);
    mainWin.focus();
    setTimeout(() => mainWin && !mainWin.isDestroyed() && mainWin.setAlwaysOnTop(false), 300);
  };
  mainWin.once('ready-to-show', reveal);
  setTimeout(reveal, 4000); // fallback in case ready-to-show never fires
  mainWin.on('close', async (e) => {
    if (quitting || servers.runningCount() === 0) return;
    e.preventDefault();
    const { response } = await dialog.showMessageBox(mainWin, {
      type: 'question', buttons: ['Stop servers and quit', 'Cancel'], defaultId: 0, cancelId: 1,
      title: 'Servers are running', message: `${servers.runningCount()} server(s) are still running.`,
      detail: 'Closing the manager will stop them.',
    });
    if (response === 0) {
      quitting = true;
      await servers.stopAll();
      app.quit();
    }
  });
  mainWin.on('closed', () => { mainWin = null; if (pickerWin) pickerWin.close(); });
}

function openPicker(serverId, tab) {
  const query = { server: serverId, tab: tab || 'maps' };
  if (pickerWin && !pickerWin.isDestroyed()) {
    pickerWin.webContents.send('picker:open', query);
    if (pickerWin.isMinimized()) pickerWin.restore();
    pickerWin.focus();
    return;
  }
  pickerWin = new BrowserWindow(winOpts({ width: 1240, height: 820, minWidth: 900, minHeight: 600, title: 'Content Browser', parent: undefined }));
  pickerWin.loadFile(path.join(RENDERER, 'picker.html'), { query });
  pickerWin.once('ready-to-show', () => pickerWin.show());
  pickerWin.on('closed', () => { pickerWin = null; });
}

// ---------- networking helpers ----------
function localAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push({ name, address: a.address });
    }
  }
  const score = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  const virtual = (n) => /vethernet|virtual|vmware|vbox|hyper-v|wsl|loopback|zerotier|tailscale|hamachi|radmin/i.test(n);
  return out.sort((a, b) => (virtual(a.name) - virtual(b.name)) || (score(a.address) - score(b.address)));
}

let publicIpCache = null;
async function publicIp(force) {
  if (publicIpCache && !force && Date.now() - publicIpCache.t < 10 * 60 * 1000) return publicIpCache.ip;
  for (const url of ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com']) {
    try {
      const ip = String(await httpGet(url)).trim();
      if (/^[0-9a-f.:]+$/i.test(ip)) { publicIpCache = { ip, t: Date.now() }; return ip; }
    } catch { /* try next */ }
  }
  return null;
}

function defaultGateway() {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1).NextHop"],
      { windowsHide: true, timeout: 8000 }, (err, out) => resolve(err ? null : String(out).trim() || null));
  });
}

function addFirewallRule(port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('Invalid port');
  const cmds = [
    `netsh advfirewall firewall delete rule name="BeamMP Server ${p}"`,
    `netsh advfirewall firewall add rule name="BeamMP Server ${p}" dir=in action=allow protocol=TCP localport=${p}`,
    `netsh advfirewall firewall add rule name="BeamMP Server ${p}" dir=in action=allow protocol=UDP localport=${p}`,
  ].join(' & ');
  return new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-Command', `Start-Process cmd -ArgumentList '/c ${cmds.replace(/'/g, "''")}' -Verb RunAs -WindowStyle Hidden -Wait`],
      { windowsHide: true }, (err) => (err ? reject(new Error('Firewall rule was not added (UAC prompt declined?)')) : resolve(true)));
  });
}

// ---------- IPC ----------
// Channels that always run on this computer, even while controlling a remote host.
const LOCAL_ONLY = /^(ui:|dialog:|remote:|local:|fs:isDir$)/;
const HOST_SIDE_ONLY = { 'files:reveal': 'Open in Explorer only works on the host computer itself.', 'net:firewall': 'Add the firewall rule on the host computer itself.' };

// When remote, files picked on this computer are uploaded to the host first.
async function uploadArgs(channel, args) {
  const up = async (paths) => {
    const { batch, items } = await remoteClient.upload(paths);
    const hostPaths = await remoteClient.call('upload:paths', [batch, items.map((i) => i.rel)]);
    return { batch, hostPaths };
  };
  if (channel === 'mods:add') { const u = await up(args[1]); return { batch: u.batch, args: [args[0], u.hostPaths] }; }
  if (channel === 'files:add') { const u = await up(args[2]); return { batch: u.batch, args: [args[0], args[1], u.hostPaths] }; }
  if (channel === 'plugins:add') { const u = await up([args[1]]); return { batch: u.batch, args: [args[0], u.hostPaths[0]] }; }
  return { args };
}

async function callRemote(channel, args) {
  if (HOST_SIDE_ONLY[channel]) throw new Error(HOST_SIDE_ONLY[channel]);
  const { batch, args: finalArgs } = await uploadArgs(channel, args);
  try {
    return await remoteClient.call(channel, finalArgs);
  } finally {
    if (batch) remoteClient.call('upload:cleanup', [batch]).catch(() => {});
  }
}

function handle(channel, fn) {
  handlers[channel] = fn;
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      const remote = remoteClient.connected && !LOCAL_ONLY.test(channel);
      return { ok: true, data: remote ? await callRemote(channel, args) : await fn(...args) };
    } catch (err) {
      console.error(channel, err);
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

// ---------- central mods library ----------
// Copies (or hard-links, when on the same drive) every server mod zip that the
// central library doesn't have yet, so new servers can pick from everything.
let syncChain = Promise.resolve();
// libraryCollect: 'auto' (default: only when BeamNG isn't installed here), 'always' or 'never'.
async function shouldCollect(reason) {
  const mode = store.settings.libraryCollect || 'auto';
  if (reason === 'manual' || mode === 'always') return true;
  if (mode === 'never') return false;
  return !(await content.findGameDir());
}

function syncToLibrary(ids, reason) {
  syncChain = syncChain.then(async () => {
    if (!(await shouldCollect(reason))) return [];
    const lib = content.centralLibraryDir();
    const have = new Map();
    try { for (const f of fs.readdirSync(lib)) have.set(f.toLowerCase(), f); } catch { return; }
    const added = [];
    for (const id of ids) {
      let files = [];
      try { files = servers.listModFiles(id); } catch { continue; }
      for (const f of files) {
        const key = f.fileName.toLowerCase();
        if (have.has(key)) continue;
        const dest = path.join(lib, f.fileName);
        try {
          try { await fs.promises.link(f.file, dest); } catch { await fs.promises.copyFile(f.file, dest); }
          have.set(key, f.fileName);
          added.push(f.fileName);
        } catch (e) { console.warn('library sync failed', f.file, e.message); }
      }
    }
    if (added.length) broadcast('library:sync', { added, reason, dir: lib });
    return added;
  }).catch((e) => console.warn('library sync', e));
  return syncChain;
}

// ---------- only the active map gets downloaded ----------
// Map-only mod zips that don't contain the server's current map are switched off
// (moved out of Resources/Client) so players don't download unused tracks. The zip
// holding the current map is switched on. Mods that also contain vehicles are left alone.
// ---------- vehicle on/off drives whether a vehicle mod is downloaded ----------
// A vehicle-only mod whose vehicles are ALL switched off is switched off too (players stop
// downloading it). It comes back as soon as one of its vehicles is switched on again. Only mods
// Redline switched off itself are switched back on; mods with maps are left to reconcileMapMods.
async function reconcileVehicleMods(id) {
  const meta = servers.readMeta(id);
  const blocked = new Set(meta.blockedVehicles || []);
  const auto = new Set((meta.autoDisabledMods || []).map((f) => f.toLowerCase()));
  const files = servers.listModFiles(id);
  const details = await content.scanMods(files.map((f) => f.file));
  const disabled = [];
  const enabled = [];
  for (const f of files) {
    const d = details.find((x) => x.file === f.file);
    if (!d || !d.vehicles?.length || d.maps?.length) continue;
    const allOff = d.vehicles.every((v) => blocked.has(v.model));
    const key = f.fileName.toLowerCase();
    try {
      if (allOff && f.enabled) { await servers.setModEnabled(id, f.fileName, false); auto.add(key); disabled.push(d.title || f.fileName); }
      if (!allOff && !f.enabled && auto.has(key)) { await servers.setModEnabled(id, f.fileName, true); auto.delete(key); enabled.push(d.title || f.fileName); }
      if (!allOff && f.enabled) auto.delete(key);
    } catch (e) { console.warn('vehicle mod reconcile', f.fileName, e.message); }
  }
  const autoList = files.filter((f) => auto.has(f.fileName.toLowerCase())).map((f) => f.fileName);
  if (JSON.stringify(autoList) !== JSON.stringify(meta.autoDisabledMods || [])) await servers.writeMeta(id, { autoDisabledMods: autoList });
  if (disabled.length || enabled.length) broadcast('vehicles:reconciled', { id, disabled, enabled });
  return { disabled, enabled };
}

async function reconcileMapMods(id) {
  const files = servers.listModFiles(id);
  const details = await content.scanMods(files.map((f) => f.file));
  const cur = String(servers.readConfig(id).General.Map || '').toLowerCase();
  const disabled = [];
  const enabled = [];
  for (const f of files) {
    const d = details.find((x) => x.file === f.file);
    if (!d || !d.maps?.length || d.vehicles?.length) continue;
    const isCurrent = d.maps.some((m) => m.mapPath.toLowerCase() === cur);
    try {
      if (isCurrent && !f.enabled) { await servers.setModEnabled(id, f.fileName, true); enabled.push(d.title || f.fileName); }
      if (!isCurrent && f.enabled) { await servers.setModEnabled(id, f.fileName, false); disabled.push(d.title || f.fileName); }
    } catch (e) { console.warn('map reconcile', f.fileName, e.message); }
  }
  if (disabled.length || enabled.length) broadcast('maps:reconciled', { id, disabled, enabled });
  return { disabled, enabled };
}

// ---------- Redline self-update (GitHub releases) ----------
const APP_REPO = 'rare621/Redline-Beam-MP-Server-Manager';
const appVersion = () => process.env.REDLINE_FAKE_VERSION || app.getVersion(); // env: test hook
const isPortable = () => !!process.env.PORTABLE_EXECUTABLE_FILE;

async function checkAppUpdate() {
  const r = await httpGet(`https://api.github.com/repos/${APP_REPO}/releases/latest`, { json: true });
  const latest = String(r.tag_name || '').replace(/^v/, '');
  const current = appVersion();
  const setup = (r.assets || []).find((a) => /^Redline-Setup-.*\.exe$/i.test(a.name));
  return {
    current,
    latest,
    available: !!latest && ServerManager.compareVersions(latest, current) > 0,
    skipped: store.settings.skipAppVersion === latest,
    notes: String(r.body || '').slice(0, 4000),
    url: r.html_url,
    setup: setup ? { url: setup.browser_download_url, size: setup.size, name: setup.name } : null,
    portable: isPortable(),
    packaged: app.isPackaged,
  };
}

async function installAppUpdate() {
  const info = await checkAppUpdate();
  if (!info.available) throw new Error('Redline is already up to date');
  if (!info.setup) throw new Error('This release has no installer attached');
  const dest = path.join(os.tmpdir(), info.setup.name);
  let last = 0;
  sendToWindows('app:update-progress', { phase: 'download', got: 0, total: info.setup.size });
  await httpGet(info.setup.url, {
    dest,
    onProgress: (got, total) => {
      const now = Date.now();
      if (now - last > 150) { last = now; sendToWindows('app:update-progress', { phase: 'download', got, total: total || info.setup.size }); }
    },
  });
  const size = fs.statSync(dest).size;
  if (size !== info.setup.size) throw new Error('The download was incomplete. Please try again.');
  if (!app.isPackaged) {
    sendToWindows('app:update-progress', { phase: 'done-dev', file: dest });
    return { installed: false, file: dest, note: 'Running from source: downloaded but not installed.' };
  }
  sendToWindows('app:update-progress', { phase: 'install' });
  // Stop servers, run the installer silently, then start the updated Redline again.
  quitting = true;
  await servers.stopAll();
  const exe = process.execPath;
  const cmdFile = path.join(os.tmpdir(), 'redline-update.cmd');
  fs.writeFileSync(cmdFile, [
    '@echo off',
    'rem Wait for Redline to close, install the update silently, then start Redline again.',
    'timeout /t 3 /nobreak >nul',
    `start "" /wait "${dest}" /S`,
    `start "" "${exe}"`,
    `del "${dest}" >nul 2>&1`,
    '(goto) 2>nul & del "%~f0"',
  ].join('\r\n'));
  spawn('cmd.exe', ['/d', '/c', cmdFile], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  setTimeout(() => app.quit(), 300);
  return { installed: true };
}

// Lists folders on this computer, used by the remote folder picker.
async function listHostFolders(dir) {
  if (!dir) {
    const roots = [];
    for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (fs.existsSync(`${l}:\\`)) roots.push({ name: `${l}:\\`, path: `${l}:\\` });
    const special = ['documents', 'desktop', 'downloads'].map((k) => ({ name: k[0].toUpperCase() + k.slice(1), path: app.getPath(k) }));
    return { path: '', parent: null, dirs: [...special, ...roots] };
  }
  const items = await fs.promises.readdir(dir, { withFileTypes: true });
  const parent = path.dirname(dir) === dir ? '' : path.dirname(dir);
  return {
    path: dir,
    parent,
    dirs: items.filter((i) => i.isDirectory() && !i.name.startsWith('$')).map((i) => ({ name: i.name, path: path.join(dir, i.name) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function registerIpc() {
  // Lets a window ask whether it is the one in focus, so background notices only show there.
  ipcMain.handle('ui:focusState', (e) => {
    const self = BrowserWindow.fromWebContents(e.sender);
    const focused = BrowserWindow.getFocusedWindow();
    return { ok: true, data: { self: !!self && focused === self, any: !!focused } };
  });
  const win = () => BrowserWindow.getFocusedWindow() || mainWin;

  handle('servers:list', () => servers.list());
  handle('servers:create', async (opts) => { const s = await servers.create(opts); syncToLibrary([s.id], 'new server'); return s; });
  handle('servers:import', async (dir) => { const s = await servers.importFolder(dir); syncToLibrary([s.id], 'added server'); return s; });
  handle('servers:remove', (id, del) => servers.remove(id, del));
  handle('servers:rename', (id, name) => servers.rename(id, name));
  handle('servers:get', (id) => servers.summary(servers.get(id)));
  handle('servers:download', (id) => servers.downloadExe(id));
  handle('servers:release', () => servers.latestRelease());
  handle('servers:updateInfo', (id, force) => servers.updateInfo(id, force));
  handle('servers:ignoreUpdate', (id, version) => servers.ignoreUpdate(id, version));
  handle('servers:update', (id) => servers.updateExe(id));
  handle('servers:start', (id) => servers.start(id));
  handle('servers:stop', (id) => servers.stop(id));
  handle('servers:kill', (id) => servers.kill(id));
  handle('servers:restart', (id) => servers.restart(id));
  handle('servers:command', (id, cmd) => servers.command(id, cmd));
  handle('servers:logs', (id) => servers.getLogs(id));
  handle('servers:clearLogs', (id) => servers.clearLogs(id));
  handle('servers:players', (id) => servers.readPlayers(id));
  handle('servers:defaultDir', () => store.settings.serversDir || path.join(app.getPath('documents'), 'BeamMP Servers'));

  handle('config:read', (id) => servers.readConfig(id));
  handle('config:write', async (id, sections) => {
    const r = await servers.writeConfig(id, sections);
    if (sections?.General?.Map) await reconcileMapMods(id);
    return servers.readConfig(id);
  });
  handle('config:writeRaw', (id, text) => servers.writeRawConfig(id, text));
  handle('meta:read', (id) => servers.readMeta(id));
  handle('vehicles:setBlocked', async (id, models) => {
    const meta = await servers.setBlockedVehicles(id, models);
    await reconcileVehicleMods(id);
    return meta;
  });

  handle('mods:list', (id) => servers.listModFiles(id));
  handle('mods:details', async (id) => {
    const files = servers.listModFiles(id);
    const details = await content.scanMods(files.map((f) => f.file));
    return files.map((f) => ({ ...f, ...(details.find((d) => d.file === f.file) || {}), enabled: f.enabled }));
  });
  handle('mods:add', async (id, files) => { const r = await servers.addMods(id, files); syncToLibrary([id], 'mod added'); await reconcileMapMods(id); await reconcileVehicleMods(id); return r; });
  // Same as mods:add, for files already on the host (e.g. its library): never uploads.
  handle('mods:addHost', async (id, files) => { const r = await servers.addMods(id, files); syncToLibrary([id], 'mod added'); await reconcileMapMods(id); await reconcileVehicleMods(id); return r; });
  handle('library:dir', () => content.centralLibraryDir());
  // This computer's own BeamNG mods (used while controlling a remote host, to upload from here).
  handle('local:library', () => content.listUserLibrary());
  // This computer's own stock BeamNG content (real names + photos), shown while controlling a host.
  handle('local:stock', (force) => content.getStock(force));
  // Redline's own updates always concern this computer, so these are local-only too.
  handle('local:appUpdateCheck', () => checkAppUpdate());
  handle('local:appUpdateInstall', () => installAppUpdate());
  handle('local:appUpdateSkip', (version) => { store.settings.skipAppVersion = version; store.save(); });
  handle('local:appVersion', () => ({ version: appVersion(), portable: isPortable(), packaged: app.isPackaged }));
  handle('library:count', (dir) => { try { return fs.readdirSync(dir || content.centralLibraryDir()).length; } catch { return 0; } });
  // Move the central library to a new folder, then remove the old folder once it's empty.
  handle('library:move', async (newDir) => {
    const oldDir = path.resolve(content.centralLibraryDir());
    const target = path.resolve(String(newDir || '').trim() || content.beammpResourcesDir());
    if (target.toLowerCase() === oldDir.toLowerCase()) return { moved: 0, skipped: [], oldRemoved: false };
    const inside = (a, b) => a.toLowerCase().startsWith(b.toLowerCase() + path.sep);
    if (inside(target, oldDir) || inside(oldDir, target)) throw new Error('The new library folder cannot be inside the old one (or the other way round).');
    await syncChain; // let any running collection finish first
    await fs.promises.mkdir(target, { recursive: true });
    let moved = 0;
    const skipped = [];
    const moveItem = async (from, to) => {
      try { await fs.promises.rename(from, to); return; } catch (e) { if (e.code !== 'EXDEV') throw e; }
      await fs.promises.cp(from, to, { recursive: true, errorOnExist: true, force: false });
      await fs.promises.rm(from, { recursive: true, force: true });
    };
    let items = [];
    try { items = await fs.promises.readdir(oldDir); } catch { /* old folder missing: nothing to move */ }
    for (const name of items) {
      const from = path.join(oldDir, name);
      const to = path.join(target, name);
      if (fs.existsSync(to)) { skipped.push(name); continue; }
      try { await moveItem(from, to); moved++; } catch (e) { skipped.push(name); console.warn('library move', name, e.message); }
    }
    let oldRemoved = false;
    try { await fs.promises.rmdir(oldDir); oldRemoved = true; } catch { /* not empty or missing */ }
    store.settings.libraryPath = target;
    store.save();
    broadcast('server:changed', null);
    return { moved, skipped, oldRemoved, oldDir, newDir: target };
  });
  handle('library:syncAll', () => syncToLibrary(store.servers.map((s) => s.id), 'manual'));
  // One-time setup check shown on first launch (and once after this update).
  handle('app:setupCheck', async () => {
    if (store.settings.setupChecked) return { show: false };
    const [gameDir, modsDir] = [await content.findGameDir(), content.findUserModsDir()];
    return { show: !gameDir || !modsDir, gameDir, modsDir, libraryDir: content.centralLibraryDir() };
  });
  handle('app:setupDone', () => { store.settings.setupChecked = true; store.save(); });
  handle('mods:setEnabled', async (id, name, en) => {
    const r = await servers.setModEnabled(id, name, en);
    // A manual change wins: forget any automatic switch-off for this mod.
    const meta = servers.readMeta(id);
    const auto = (meta.autoDisabledMods || []).filter((f) => f.toLowerCase() !== String(name).toLowerCase());
    const patch = { autoDisabledMods: auto };
    if (en) {
      // Switching a mod back on also switches its vehicles back on, so the two never disagree.
      const d = (await content.scanMods([path.join(servers.clientDir(servers.get(id)), path.basename(name))]))[0];
      const models = new Set((d?.vehicles || []).map((v) => v.model));
      if (models.size) patch.blockedVehicles = (meta.blockedVehicles || []).filter((m) => !models.has(m));
    }
    await servers.writeMeta(id, patch);
    return r;
  });
  // Remove = delete from the server for good, but never lose the mod: keep (or make) a copy in
  // the BeamNG mods folder or the central library first.
  handle('mods:remove', (id, name) => servers.removeMod(id, name, async (serverFile) => {
    const base = path.basename(serverFile).toLowerCase();
    const size = fs.statSync(serverFile).size;
    const lib = await content.listUserLibrary().catch(() => ({ mods: [] }));
    const existing = lib.mods.find((m) => m.fileName.toLowerCase() === base && m.size === size);
    if (existing) return path.dirname(existing.file);
    const libDir = content.centralLibraryDir();
    let dest = path.join(libDir, path.basename(serverFile));
    if (fs.existsSync(dest)) dest = path.join(libDir, `${path.basename(serverFile, '.zip')} (${Date.now()}).zip`);
    try { await fs.promises.link(serverFile, dest); } catch { await fs.promises.copyFile(serverFile, dest); }
    return libDir;
  }));
  handle('mods:keptWhere', async (id, name) => {
    const lib = await content.listUserLibrary().catch(() => ({ mods: [] }));
    const hit = lib.mods.find((m) => m.fileName.toLowerCase() === String(name).toLowerCase());
    return hit ? path.dirname(hit.file) : content.centralLibraryDir();
  });
  handle('mods:library', () => content.listUserLibrary());

  handle('plugins:list', (id) => servers.listPlugins(id));
  handle('plugins:add', (id, src) => servers.addPlugin(id, src));
  handle('plugins:remove', (id, name) => servers.removePlugin(id, name));

  handle('files:list', (id, rel) => servers.listDir(id, rel));
  handle('files:read', (id, rel) => servers.readText(id, rel));
  handle('files:write', (id, rel, text) => servers.writeText(id, rel, text));
  handle('files:add', async (id, rel, files) => { await servers.addFiles(id, rel, files); syncToLibrary([id], 'files added'); });
  handle('files:mkdir', (id, rel, name) => servers.mkdir(id, rel, name));
  handle('files:delete', (id, rel) => servers.deletePath(id, rel));
  handle('files:rename', (id, rel, name) => servers.renamePath(id, rel, name));
  handle('files:reveal', (id, rel) => servers.reveal(id, rel));

  handle('content:stock', (force) => content.getStock(force));
  handle('content:gameDir', () => content.findGameDir());
  handle('content:modsDir', () => content.findUserModsDir());

  handle('net:info', async (force) => ({ local: localAddresses(), public: await publicIp(force), gateway: await defaultGateway() }));
  handle('net:firewall', (port) => addFirewallRule(port));

  handle('settings:get', () => store.settings);
  handle('settings:set', (patch) => {
    Object.assign(store.settings, patch);
    store.save();
    content.stock = null;
    return store.settings;
  });

  handle('ui:openPicker', (id, tab) => openPicker(id, tab));
  handle('ui:openExternal', (url) => {
    if (!/^https?:\/\//.test(url)) throw new Error('Only web links can be opened');
    return shell.openExternal(url);
  });
  handle('ui:openPath', (p) => shell.openPath(p));
  handle('ui:copy', (text) => clipboard.writeText(String(text)));
  handle('dialog:openFolder', async (title) => {
    const r = await dialog.showOpenDialog(win(), { title: title || 'Choose folder', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:openFiles', async (opts = {}) => {
    const r = await dialog.showOpenDialog(win(), {
      title: opts.title || 'Choose files',
      properties: ['openFile', 'multiSelections'],
      filters: opts.zip ? [{ name: 'BeamNG mods', extensions: ['zip'] }] : [{ name: 'All files', extensions: ['*'] }],
    });
    return r.canceled ? [] : r.filePaths;
  });
  handle('fs:isDir', (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  handle('dialog:saveFile', async (opts = {}) => {
    const r = await dialog.showSaveDialog(win(), {
      title: opts.title || 'Save',
      defaultPath: path.join(app.getPath('downloads'), opts.defaultName || 'file.zip'),
      filters: [{ name: 'Zip file', extensions: ['zip'] }],
    });
    return r.canceled ? null : r.filePath;
  });

  // ---- prep packs ----
  // Server side (runs on the host when remote): build a pack, and delete it after it's been fetched.
  handle('prep:build', (id) => prep.buildPack(id));
  handle('prep:packCleanup', (name) => prep.removePack(name));
  // Save a built pack to a path on THIS computer (downloads it from the host when remote).
  handle('local:prepExport', async (packName, dest) => {
    if (remoteClient.connected) {
      await remoteClient.download(`/pack/${encodeURIComponent(packName)}`, dest, (got, total) =>
        sendToWindows('prep:progress', { phase: 'progress', step: 'download', done: got, total }));
      remoteClient.call('prep:packCleanup', [packName]).catch(() => {});
    } else {
      const src = prep.packPath(packName);
      try { await fs.promises.rename(src, dest); } catch (e) {
        if (e.code !== 'EXDEV' && e.code !== 'EEXIST' && e.code !== 'EPERM') throw e;
        await fs.promises.copyFile(src, dest);
        await fs.promises.rm(src, { force: true });
      }
    }
    return { dest, size: fs.statSync(dest).size };
  });
  // Player side: installed packs are tracked so they can be updated or removed cleanly.
  const prepped = () => (store.settings.prepped = store.settings.prepped || []);
  const lc = (s) => String(s).toLowerCase();
  // Delete files a pack put in the launcher cache, unless another prepped server still uses them.
  const releaseFiles = async (entry, keep = new Set()) => {
    const others = new Set(prepped().filter((p) => p !== entry).flatMap((p) => p.cacheNames.map(lc)));
    const removed = [];
    for (const c of entry.owned || []) {
      if (keep.has(lc(c)) || others.has(lc(c))) continue;
      try { await fs.promises.rm(path.join(entry.dir, path.basename(c)), { force: true }); removed.push(c); } catch { /* ignore */ }
    }
    return removed;
  };
  handle('local:cacheDir', () => content.beammpResourcesDir());
  handle('ui:showItem', (p) => shell.showItemInFolder(String(p)));
  handle('local:prepList', () => prepped().map((p) => {
    let present = 0;
    // A mod counts as present under its launcher name ("name-1a2b3c4d.zip") or its plain name.
    for (const c of p.cacheNames) {
      const base = path.basename(c);
      if (fs.existsSync(path.join(p.dir, base)) || fs.existsSync(path.join(p.dir, base.replace(/-[0-9a-f]{8}(\.zip)$/i, '$1')))) present++;
    }
    return { id: p.id, server: p.server, created: p.created, installedAt: p.installedAt, size: p.size, mods: p.cacheNames.length, present, dir: p.dir };
  }));
  handle('local:prepInstall', async (zipFile, replaceId) => {
    const r = await prepLocal.installPack(zipFile);
    const list = prepped();
    const old = (replaceId && list.find((p) => p.id === replaceId)) || list.find((p) => lc(p.server) === lc(r.server));
    const newSet = new Set(r.cacheNames.map(lc));
    const owned = r.installed.map((x) => x.cacheName);
    let removed = [];
    if (old) {
      for (const c of old.owned || []) if (newSet.has(lc(c)) && !owned.some((o) => lc(o) === lc(c))) owned.push(c);
      removed = await releaseFiles(old, newSet);
      list.splice(list.indexOf(old), 1);
    }
    list.push({ id: old?.id || crypto.randomUUID(), server: r.server, created: r.created, installedAt: Date.now(), size: r.totalBytes, cacheNames: r.cacheNames, owned, dir: r.dest });
    store.save();
    return { server: r.server, dest: r.dest, installed: r.installed.length, skipped: r.skipped.length, failed: r.failed, removed: removed.length, updated: !!old, total: r.total };
  });
  handle('local:prepRemove', async (id, deleteFiles) => {
    const list = prepped();
    const entry = list.find((p) => p.id === id);
    if (!entry) throw new Error('That prepped server is no longer listed');
    const removed = deleteFiles ? await releaseFiles(entry) : [];
    list.splice(list.indexOf(entry), 1);
    store.save();
    return { removed: removed.length, server: entry.server };
  });

  // ---- remote management ----
  const uploadDir = path.join(app.getPath('userData'), 'remote-uploads');
  handle('hostfs:list', (dir) => listHostFolders(dir));
  handle('upload:paths', (batch, rels) => rels.map((r) => path.join(uploadDir, String(batch).replace(/[^a-f0-9]/gi, ''), path.basename(r))));
  handle('upload:cleanup', (batch) => fs.promises.rm(path.join(uploadDir, String(batch).replace(/[^a-f0-9]/gi, '')), { recursive: true, force: true }));

  handle('remote:hostStatus', () => remoteHost.status());
  handle('remote:hostSet', async ({ enabled, port, password }) => {
    const cfg = remoteHost.config;
    if (password) remoteHost.setPassword(password);
    if (port) {
      const p = Number(port);
      if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error('Port must be between 1024 and 65535');
      cfg.port = p;
    }
    cfg.enabled = !!enabled;
    store.save();
    if (cfg.enabled) await remoteHost.start(); else await remoteHost.stop();
    return remoteHost.status();
  });
  // Recent connections; passwords (when remembered) are encrypted with Windows DPAPI via safeStorage.
  const recents = () => (store.settings.remoteRecents = store.settings.remoteRecents || []);
  const sameHost = (r, host, port) => r.host === String(host).trim() && Number(r.port) === Number(port);
  handle('remote:clientStatus', () => ({
    ...remoteClient.status(),
    last: store.settings.remoteClient || null,
    defaultPort: DEFAULT_PORT,
    canRemember: safeStorage.isEncryptionAvailable(),
    recents: recents().map(({ pw, ...r }) => ({ ...r, savedPassword: !!pw })),
  }));
  const doConnect = async (host, port, password, remember) => {
    const st = await remoteClient.connect(host, port, password);
    const list = recents().filter((r) => !sameHost(r, st.host, st.port));
    const old = recents().find((r) => sameHost(r, st.host, st.port));
    let pw = remember === undefined ? old?.pw : undefined;
    if (remember && safeStorage.isEncryptionAvailable()) pw = safeStorage.encryptString(String(password)).toString('base64');
    list.unshift({ host: st.host, port: st.port, hostName: st.hostName, lastUsed: Date.now(), ...(pw ? { pw } : {}) });
    store.settings.remoteRecents = list.slice(0, 8);
    store.settings.remoteClient = { host: st.host, port: st.port };
    store.save();
    setTimeout(reloadWindows, 150);
    return st;
  };
  handle('remote:connect', (host, port, password, remember) => doConnect(host, port, password, remember));
  handle('remote:connectRecent', (host, port) => {
    const r = recents().find((x) => sameHost(x, host, port));
    if (!r?.pw) throw new Error('No saved password for this computer');
    let pw;
    try { pw = safeStorage.decryptString(Buffer.from(r.pw, 'base64')); } catch { throw new Error('The saved password could not be read. Enter it again.'); }
    return doConnect(host, port, pw);
  });
  handle('remote:forgetRecent', (host, port) => {
    store.settings.remoteRecents = recents().filter((r) => !sameHost(r, host, port));
    store.save();
  });
  handle('remote:disconnect', () => {
    remoteClient.disconnect(true);
    clearWebCache();
    setTimeout(reloadWindows, 150);
  });

  remoteHost = new RemoteHost({ handlers, thumbDir: path.join(app.getPath('userData'), 'thumbs'), uploadDir, store, packDir: path.join(app.getPath('userData'), 'prep-packs') });
  fs.mkdirSync(uploadDir, { recursive: true });
  if (remoteHost.config.enabled) remoteHost.start().catch((e) => console.warn('Remote host failed to start:', e.message));
}

// Only one Redline per data folder: launching it again focuses the open window.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => {
  if (!mainWin) return;
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
});

// Nothing from a remote host should linger on this computer: drop the web cache
// on disconnect and at startup (also clears photos cached by older versions).
function clearWebCache() {
  session.defaultSession.clearCache().catch(() => {});
}

app.whenReady().then(() => {
  clearWebCache();
  content = new ContentService({ dataDir: app.getPath('userData'), getSettings: () => store.settings, emit: broadcast });
  // Building packs is server-side work (events reach remote viewers too); installing is always local.
  prep = new Prep({ dataDir: app.getPath('userData'), servers, emit: broadcast, launcherCacheDir: () => content.beammpResourcesDir() });
  prepLocal = new Prep({ dataDir: app.getPath('userData'), servers, emit: sendToWindows, launcherCacheDir: () => content.beammpResourcesDir() });
  registerIpc();
  createMain();
  // The central library moved to the BeamMP Launcher's Resources folder: move anything from the
  // old Documents\Redline Mods Library over once, then remove the old folder if it's empty.
  if (content.isDefaultLibrary() && !store.settings.libraryMigrated) {
    setTimeout(() => {
      syncChain = syncChain.then(async () => {
        const oldDir = content.legacyLibraryDir();
        const newDir = content.centralLibraryDir();
        const moved = [];
        let items = [];
        try { items = await fs.promises.readdir(oldDir); } catch { /* no old library */ }
        for (const name of items) {
          const from = path.join(oldDir, name);
          const to = path.join(newDir, name);
          if (fs.existsSync(to)) continue;
          try {
            try { await fs.promises.rename(from, to); } catch (e) {
              if (e.code !== 'EXDEV') throw e;
              await fs.promises.copyFile(from, to);
              await fs.promises.unlink(from);
            }
            moved.push(name);
          } catch (e) { console.warn('library migrate', name, e.message); }
        }
        try { await fs.promises.rmdir(oldDir); } catch { /* not empty or missing */ }
        store.settings.libraryMigrated = true;
        store.save();
        if (moved.length) broadcast('library:sync', { added: moved, reason: 'moved', dir: newDir });
      });
    }, 2000);
  }
  // Apply the vehicle on/off ⇄ mod download link to existing servers (stopped ones only).
  setTimeout(async () => {
    for (const s of store.servers) {
      if (servers.procs.has(s.id) || !fs.existsSync(s.path)) continue;
      await reconcileVehicleMods(s.id).catch((e) => console.warn('vehicle reconcile', e.message));
    }
  }, 4000);
  // First start after this update: collect mods from servers that were already added.
  if (!store.settings.librarySynced) {
    setTimeout(() => syncToLibrary(store.servers.map((s) => s.id), 'first start').then(() => {
      store.settings.librarySynced = true;
      store.save();
    }), 3000);
  }
  // Warm up the stock content cache in the background so pickers open instantly.
  setTimeout(() => content.getStock().catch(() => {}), 1500);
});

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { for (const id of [...servers.procs.keys()]) servers.kill(id); });
app.on('window-all-closed', () => app.quit());
