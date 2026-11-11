const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, clipboard, safeStorage, session } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const store = require('./store');
const { ServerManager, httpGet } = require('./servers');
const { ContentService } = require('./content');
const { RemoteHost, RemoteClient, DEFAULT_PORT } = require('./remote');

nativeTheme.themeSource = 'dark';
if (process.env.BEAMMP_MANAGER_DATA) app.setPath('userData', process.env.BEAMMP_MANAGER_DATA);
const RENDERER = path.join(__dirname, '..', 'renderer');
let mainWin = null;
let pickerWin = null;
let quitting = false;

const servers = new ServerManager(store);
let content = null;

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
const LOCAL_ONLY = /^(ui:|dialog:|remote:|fs:isDir$)/;
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
function syncToLibrary(ids, reason) {
  syncChain = syncChain.then(async () => {
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
  const win = () => BrowserWindow.getFocusedWindow() || mainWin;

  handle('servers:list', () => servers.list());
  handle('servers:create', async (opts) => { const s = await servers.create(opts); syncToLibrary([s.id], 'new server'); return s; });
  handle('servers:import', async (dir) => { const s = await servers.importFolder(dir); syncToLibrary([s.id], 'added server'); return s; });
  handle('servers:remove', (id, del) => servers.remove(id, del));
  handle('servers:rename', (id, name) => servers.rename(id, name));
  handle('servers:get', (id) => servers.summary(servers.get(id)));
  handle('servers:download', (id) => servers.downloadExe(id));
  handle('servers:release', () => servers.latestRelease());
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
  handle('config:write', (id, sections) => servers.writeConfig(id, sections));
  handle('config:writeRaw', (id, text) => servers.writeRawConfig(id, text));
  handle('meta:read', (id) => servers.readMeta(id));
  handle('vehicles:setBlocked', (id, models) => servers.setBlockedVehicles(id, models));

  handle('mods:list', (id) => servers.listModFiles(id));
  handle('mods:details', async (id) => {
    const files = servers.listModFiles(id);
    const details = await content.scanMods(files.map((f) => f.file));
    return files.map((f) => ({ ...f, ...(details.find((d) => d.file === f.file) || {}), enabled: f.enabled }));
  });
  handle('mods:add', async (id, files) => { const r = await servers.addMods(id, files); syncToLibrary([id], 'mod added'); return r; });
  // Same as mods:add, for files already on the host (e.g. its library): never uploads.
  handle('mods:addHost', async (id, files) => { const r = await servers.addMods(id, files); syncToLibrary([id], 'mod added'); return r; });
  handle('library:dir', () => content.centralLibraryDir());
  handle('library:count', (dir) => { try { return fs.readdirSync(dir || content.centralLibraryDir()).length; } catch { return 0; } });
  // Move the central library to a new folder, then remove the old folder once it's empty.
  handle('library:move', async (newDir) => {
    const oldDir = path.resolve(content.centralLibraryDir());
    const target = path.resolve(String(newDir || '').trim() || path.join(os.homedir(), 'Documents', 'Redline Mods Library'));
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
  handle('mods:setEnabled', (id, name, en) => servers.setModEnabled(id, name, en));
  handle('mods:remove', (id, name) => servers.removeMod(id, name));
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

  remoteHost = new RemoteHost({ handlers, thumbDir: path.join(app.getPath('userData'), 'thumbs'), uploadDir, store });
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
  registerIpc();
  createMain();
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
