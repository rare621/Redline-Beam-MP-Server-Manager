// Remote management: a host mode that exposes the app's API over the LAN,
// and a client mode that forwards the UI to a host. The password never
// crosses the network: the client proves it knows it via HMAC over a nonce.
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { EventEmitter } = require('events');

const DEFAULT_PORT = 47815;
const PROTOCOL = 1;
const THUMB_SCHEME = 'redline-thumb://';
// Channels a remote client may never invoke on the host.
const HOST_BLOCKED = /^(ui:|dialog:|remote:|local:|fs:isDir$|net:firewall$|files:reveal$)/;

const deriveKey = (password, salt) => crypto.scryptSync(String(password), Buffer.from(salt, 'hex'), 32);
const hmac = (key, nonce) => crypto.createHmac('sha256', key).update(nonce).digest('hex');

function isPrivateAddress(addr) {
  let a = String(addr || '').toLowerCase();
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (a === '::1' || a.startsWith('127.')) return true;
  if (a.startsWith('10.') || a.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
  if (a.startsWith('169.254.')) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(a) || a.startsWith('fe80:')) return true;
  return false;
}

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

class RemoteHost {
  constructor({ handlers, thumbDir, uploadDir, store }) {
    this.handlers = handlers;
    this.thumbDir = thumbDir;
    this.uploadDir = uploadDir;
    this.store = store;
    this.server = null;
    this.sessions = new Map(); // token -> { ip, since, name }
    this.nonces = new Map(); // nonce -> expiry
    this.fails = new Map(); // ip -> { count, until }
    this.sse = new Set();
    this.thumbPrefix = pathToFileURL(thumbDir).href + '/';
  }

  get config() {
    const s = this.store.settings;
    s.remoteHost = s.remoteHost || { enabled: false, port: DEFAULT_PORT };
    return s.remoteHost;
  }

  setPassword(password) {
    if (!password || String(password).length < 4) throw new Error('Password must be at least 4 characters');
    const salt = crypto.randomBytes(16).toString('hex');
    this.config.salt = salt;
    this.config.key = deriveKey(password, salt).toString('hex');
    this.sessions.clear(); // old sessions stop working when the password changes
    for (const c of this.sse) c.res.end();
  }

  status() {
    const ips = [];
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.') && !/vethernet|virtual|vmware|vbox|wsl/i.test(name)) ips.push(a.address);
      }
    }
    return {
      enabled: !!this.config.enabled,
      running: !!this.server?.listening,
      port: this.config.port || DEFAULT_PORT,
      hasPassword: !!this.config.key,
      addresses: ips,
      hostName: os.hostname(),
      clients: [...this.sessions.values()].map((s) => ({ ip: s.ip, since: s.since, name: s.name })),
      error: this.lastError || null,
    };
  }

  async start() {
    await this.stop();
    if (!this.config.key) throw new Error('Set a password first');
    const port = Number(this.config.port) || DEFAULT_PORT;
    this.lastError = null;
    this.server = http.createServer((req, res) => this.route(req, res).catch((e) => {
      if (!res.headersSent) send(res, 500, { ok: false, error: e.message });
    }));
    await new Promise((resolve, reject) => {
      this.server.once('error', (e) => {
        this.lastError = e.code === 'EADDRINUSE' ? `Port ${port} is already in use` : e.message;
        reject(new Error(this.lastError));
      });
      this.server.listen(port, '0.0.0.0', resolve);
    });
    this.sweep = setInterval(() => this.cleanup(), 60 * 1000);
  }

  async stop() {
    clearInterval(this.sweep);
    for (const c of this.sse) { try { c.res.end(); } catch { /* ignore */ } }
    this.sse.clear();
    this.sessions.clear();
    if (this.server) await new Promise((r) => this.server.close(() => r()));
    this.server = null;
  }

  cleanup() {
    const now = Date.now();
    for (const [n, exp] of this.nonces) if (exp < now) this.nonces.delete(n);
    // Remove upload folders older than an hour.
    fs.readdir(this.uploadDir, (err, items) => {
      if (err) return;
      for (const it of items) {
        const p = path.join(this.uploadDir, it);
        fs.stat(p, (e, st) => { if (!e && now - st.mtimeMs > 3600e3) fs.rm(p, { recursive: true, force: true }, () => {}); });
      }
    });
  }

  broadcast(channel, payload) {
    if (!this.sse.size) return;
    const data = `data: ${this.rewrite(JSON.stringify({ channel, payload }))}\n\n`;
    for (const c of this.sse) c.res.write(data);
  }

  rewrite(json) { return json.split(this.thumbPrefix).join(THUMB_SCHEME); }

  auth(req, url) {
    const token = req.headers['x-redline-token'] || url.searchParams.get('k');
    return token && this.sessions.has(token) ? token : null;
  }

  async route(req, res) {
    const ip = req.socket.remoteAddress;
    if (!isPrivateAddress(ip)) return send(res, 403, { ok: false, error: 'Only devices on the same network can connect' });
    const url = new URL(req.url, 'http://host');
    const p = url.pathname;

    if (p === '/api/hello') return send(res, 200, { app: 'Redline', protocol: PROTOCOL, hostName: os.hostname() });

    if (p === '/api/challenge') {
      const nonce = crypto.randomBytes(24).toString('hex');
      this.nonces.set(nonce, Date.now() + 60e3);
      return send(res, 200, { salt: this.config.salt, nonce });
    }

    if (p === '/api/login' && req.method === 'POST') {
      const f = this.fails.get(ip);
      if (f && f.until > Date.now()) return send(res, 429, { ok: false, error: `Too many wrong passwords. Try again in ${Math.ceil((f.until - Date.now()) / 1000)}s.` });
      const { nonce, proof, name } = JSON.parse(await readBody(req, 4096) || '{}');
      const exp = this.nonces.get(nonce);
      this.nonces.delete(nonce);
      const expected = Buffer.from(hmac(Buffer.from(this.config.key, 'hex'), String(nonce)), 'hex');
      const got = Buffer.from(String(proof || ''), 'hex');
      if (!exp || exp < Date.now() || got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
        const count = (f?.count || 0) + 1;
        this.fails.set(ip, { count, until: count >= 5 ? Date.now() + 30e3 * Math.min(count - 4, 10) : 0 });
        return send(res, 401, { ok: false, error: 'Wrong password' });
      }
      this.fails.delete(ip);
      const token = crypto.randomBytes(32).toString('hex');
      this.sessions.set(token, { ip: ip.replace(/^::ffff:/, ''), since: Date.now(), name: String(name || '').slice(0, 60) });
      return send(res, 200, { ok: true, token });
    }

    const token = this.auth(req, url);
    if (!token) return send(res, 401, { ok: false, error: 'Not logged in' });

    if (p === '/api/rpc' && req.method === 'POST') {
      const { channel, args } = JSON.parse(await readBody(req));
      const fn = this.handlers[channel];
      if (!fn || HOST_BLOCKED.test(channel)) return send(res, 403, { ok: false, error: `"${channel}" is not available remotely` });
      try {
        const data = await fn(...(Array.isArray(args) ? args : []));
        return send(res, 200, this.rewrite(JSON.stringify({ ok: true, data: data === undefined ? null : data })));
      } catch (e) {
        return send(res, 200, { ok: false, error: e?.message || String(e) });
      }
    }

    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      const client = { res, token };
      this.sse.add(client);
      const ping = setInterval(() => res.write(': ping\n\n'), 20e3);
      req.on('close', () => { clearInterval(ping); this.sse.delete(client); });
      return undefined;
    }

    if (p === '/api/logout' && req.method === 'POST') {
      this.sessions.delete(token);
      return send(res, 200, { ok: true });
    }

    if (p.startsWith('/thumb/')) {
      const name = path.basename(decodeURIComponent(p.slice(7)));
      const file = path.join(this.thumbDir, name);
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      const ext = path.extname(name).toLowerCase();
      // no-store: the remote computer must not keep copies of the host's photos on disk.
      res.writeHead(200, { 'Content-Type': ext === '.png' ? 'image/png' : 'image/jpeg', 'Cache-Control': 'no-store' });
      return fs.createReadStream(file).pipe(res);
    }

    if (p === '/api/upload' && req.method === 'POST') {
      const batch = String(url.searchParams.get('batch') || '').replace(/[^a-f0-9]/gi, '');
      const rel = String(url.searchParams.get('rel') || '').split(/[\\/]+/).filter((s) => s && s !== '.' && s !== '..').join(path.sep);
      if (!batch || !rel) return send(res, 400, { ok: false, error: 'Bad upload' });
      const dest = path.join(this.uploadDir, batch, rel);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(dest);
        req.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
        req.on('error', reject);
      });
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { ok: false, error: 'Not found' });
  }
}

// ---------------- client ----------------
class RemoteClient extends EventEmitter {
  constructor() {
    super();
    this.token = null;
    this.host = null;
    this.port = null;
    this.hostName = null;
    this.connected = false;
  }

  get base() { return `http://${this.host.includes(':') ? `[${this.host}]` : this.host}:${this.port}`; }

  request(method, pathName, { body, headers = {}, stream, timeout = 60000 } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(`${this.base}${pathName}`, {
        method,
        headers: { ...(this.token ? { 'x-redline-token': this.token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      });
      req.setTimeout(timeout, () => req.destroy(new Error('The host did not respond')));
      req.on('error', (e) => reject(new Error(e.code === 'ECONNREFUSED' ? 'Could not reach the host. Check the IP and port, and that remote control is turned on there.'
        : e.code === 'ETIMEDOUT' || e.code === 'EHOSTUNREACH' ? 'The host is not reachable on this network.' : e.message)));
      if (stream) stream.pipe(req);
      else req.end(body ? JSON.stringify(body) : undefined);
    });
  }

  async json(method, pathName, body, opts) {
    const r = await this.request(method, pathName, { body, ...opts });
    let data;
    try { data = JSON.parse(this.rewrite(r.text)); } catch { throw new Error(`Unexpected reply from host (HTTP ${r.status})`); }
    if (r.status === 401 && this.connected && pathName !== '/api/login') this.drop('The host ended the session (password changed or remote control turned off).');
    if (r.status >= 400 && data.ok === false) throw new Error(data.error);
    return data;
  }

  rewrite(text) {
    if (!this.token) return text;
    return text.replace(/redline-thumb:\/\/([^"\\]+)/g, (_m, name) => `${this.base}/thumb/${name}?k=${this.token}`);
  }

  async connect(host, port, password) {
    this.disconnect(true);
    this.host = String(host).trim();
    this.port = Number(port) || DEFAULT_PORT;
    const hello = await this.json('GET', '/api/hello', null, { timeout: 6000 });
    if (hello.app !== 'Redline') throw new Error('That address is not a Redline host');
    const { salt, nonce } = await this.json('GET', '/api/challenge');
    if (!salt) throw new Error('The host has no password set yet');
    const proof = hmac(deriveKey(password, salt), nonce);
    const r = await this.json('POST', '/api/login', { nonce, proof, name: os.hostname() });
    this.token = r.token;
    this.hostName = hello.hostName;
    this.connected = true;
    this.openEvents();
    return this.status();
  }

  status() {
    return { connected: this.connected, host: this.host, port: this.port, hostName: this.hostName, reconnecting: !!this.reconnecting };
  }

  async call(channel, args) {
    const r = await this.json('POST', '/api/rpc', { channel, args }, { timeout: 10 * 60 * 1000 });
    if (!r.ok) throw new Error(r.error);
    return r.data;
  }

  openEvents() {
    if (!this.connected) return;
    const req = http.get(`${this.base}/api/events?k=${this.token}`, (res) => {
      if (res.statusCode !== 200) { res.resume(); if (res.statusCode === 401) this.drop('The host ended the session.'); else this.retryEvents(); return; }
      if (this.reconnecting) { this.reconnecting = false; this.emit('state', this.status()); }
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = block.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          try { const ev = JSON.parse(this.rewrite(line.slice(6))); this.emit('event', ev); } catch { /* ignore */ }
        }
      });
      res.on('end', () => this.retryEvents());
      res.on('error', () => this.retryEvents());
    });
    req.on('error', () => this.retryEvents());
    this.eventsReq = req;
  }

  retryEvents() {
    if (!this.connected || this.retryTimer) return;
    if (!this.reconnecting) { this.reconnecting = true; this.emit('state', this.status()); }
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.openEvents(); }, 3000);
  }

  drop(reason) {
    if (!this.connected) return;
    this.disconnect(true);
    this.emit('state', { ...this.status(), reason });
  }

  disconnect(silent) {
    if (this.connected && this.token) this.request('POST', '/api/logout', { timeout: 3000 }).catch(() => {});
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    try { this.eventsReq?.destroy(); } catch { /* ignore */ }
    this.connected = false;
    this.reconnecting = false;
    this.token = null;
    if (!silent) this.emit('state', this.status());
  }

  // Upload local files/folders to the host; returns the matching host paths.
  async upload(localPaths) {
    const batch = crypto.randomBytes(8).toString('hex');
    // Collect every file first so progress can cover the whole upload.
    const files = [];
    const walk = (p, rel) => {
      const st = fs.statSync(p);
      if (st.isDirectory()) for (const n of fs.readdirSync(p)) walk(path.join(p, n), `${rel}/${n}`);
      else files.push({ file: p, rel, size: st.size });
    };
    for (const lp of localPaths) walk(lp, path.basename(lp));
    const total = files.reduce((a, f) => a + f.size, 0);
    const started = Date.now();
    let sent = 0;
    let last = 0;
    const report = (phase, extra = {}) => this.emit('upload', { id: batch, phase, sent, total, count: files.length, started, ...extra });
    report('start');
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const stream = fs.createReadStream(f.file);
        stream.on('data', (chunk) => {
          sent += chunk.length;
          const now = Date.now();
          if (now - last > 120) { last = now; report('progress', { file: path.basename(f.file), index: i }); }
        });
        report('progress', { file: path.basename(f.file), index: i });
        const r = await this.request('POST', `/api/upload?batch=${batch}&rel=${encodeURIComponent(f.rel)}`, {
          stream, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': f.size }, timeout: 60 * 60 * 1000,
        });
        if (r.status !== 200) throw new Error(`Upload of ${path.basename(f.file)} failed`);
      }
    } catch (e) {
      report('error', { error: e.message });
      throw e;
    }
    report('done');
    return { batch, items: localPaths.map((lp) => ({ batch, rel: path.basename(lp) })) };
  }
}

module.exports = { RemoteHost, RemoteClient, DEFAULT_PORT, isPrivateAddress };
