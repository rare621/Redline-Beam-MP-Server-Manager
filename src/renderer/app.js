// Main window: server list, dashboard, console, config, mods, plugins, files.
const state = {
  servers: [],
  selected: null,
  tab: 'dashboard',
  stock: null,
  net: null,
  logs: new Map(), // id -> entries (mirrors main process buffer)
  players: [],
  filesRel: '',
  downloads: new Map(),
};
const TABS = [
  ['dashboard', 'Dashboard', 'dashboard'],
  ['console', 'Console', 'terminal'],
  ['config', 'Settings', 'settings'],
  ['mods', 'Mods & Content', 'box'],
  ['plugins', 'Plugins', 'puzzle'],
  ['files', 'Files', 'folder'],
];
const KEYMASTER = 'https://keymaster.beammp.com/';

// ---------- boot ----------
$('#tbLogo').innerHTML = LOGO;
$('#btnNew').innerHTML = icon('plus') + 'New';
$('#btnImport').innerHTML = icon('folderPlus') + 'Add folder';
$('#btnSettings').innerHTML = icon('settings') + 'App settings';
$('#btnKeymaster').innerHTML = icon('key');
$('#btnNew').onclick = () => createServerDialog();
$('#btnImport').onclick = () => importServer();
$('#btnSettings').onclick = () => appSettingsDialog();
$('#btnKeymaster').onclick = () => api.call('ui:openExternal', KEYMASTER);
$('#btnRemote').innerHTML = icon('wifi') + 'Remote';
$('#btnRemote').onclick = () => remoteDialog();

api.on('server:status', (s) => { upsertServer(s); });
let changedTimer;
api.on('server:changed', (id) => {
  clearTimeout(changedTimer);
  changedTimer = setTimeout(async () => {
    await refreshServers();
    // Keep the open tab in sync with edits made from the Content Browser window.
    if (id && id === state.selected && !$('.modal-back')) {
      if (state.tab === 'dashboard' || state.tab === 'mods' || state.tab === 'plugins') renderTab();
      else if (state.tab === 'config' && !configDirty()) renderTab();
    }
  }, 250);
});
api.on('server:log', (e) => onLog(e));
api.on('server:download', (e) => onDownload(e));

refreshServers().then(() => {
  if (state.servers.length) select(state.servers[0].id);
  else renderMain();
  setupCheck();
});

// One-time warning when BeamNG or its mods folder can't be found on this PC.
async function setupCheck() {
  await remoteReady;
  if (REMOTE.connected) return;
  const r = await api.call('app:setupCheck').catch(() => ({ show: false }));
  if (!r.show) { api.call('app:setupDone'); return; }
  const row = (ok, title, okText, missText) => `<div class="toggle-row"><div><div class="t-title">${ok ? '✓' : '⚠'} ${title}</div><div class="t-sub">${ok ? esc(okText) : missText}</div></div></div>`;
  const go = await modal({
    title: 'Quick setup check',
    body: `<div class="muted">Redline looked for BeamNG.drive on this computer.</div>
      ${row(!!r.gameDir, 'BeamNG.drive game', r.gameDir, 'Not found. Stock maps and vehicles will be listed without photos. That\'s fine for a dedicated server PC.')}
      ${row(!!r.modsDir, 'BeamNG mods folder', r.modsDir, 'Not found. Redline will use the central mods library instead.')}
      <div class="banner-msg warn" style="margin:0;background:var(--accent-soft);border-color:rgba(255,122,26,.35);color:#ffc58a">${icon('box')}<div class="grow">Central mods library<small>${esc(r.libraryDir)}<br>Every mod and track from your servers is collected here automatically, so it's all available when you make a new server. You can drop downloaded mods in here too.</small></div></div>`,
    actions: [{ label: 'Open App settings', value: 'settings' }, { label: 'Got it', primary: true, value: 'ok' }],
  });
  api.call('app:setupDone');
  if (go === 'settings') appSettingsDialog();
}
api.call('content:stock').then((s) => { state.stock = s; if (state.tab === 'dashboard') renderTab(); }).catch(() => {});

setInterval(tick, 1000);
let pollN = 0;
function tick() {
  // uptime counters
  for (const el of $$('[data-uptime]')) el.textContent = fmtDuration(Date.now() - Number(el.dataset.uptime));
  if (++pollN % 2 === 0) pollPlayers();
}

async function pollPlayers() {
  const s = current();
  if (!s || s.status !== 'running') { if (state.players.length) { state.players = []; renderPlayers(); } return; }
  const players = await api.call('servers:players', s.id).catch(() => []);
  if (JSON.stringify(players) !== JSON.stringify(state.players)) { state.players = players; renderPlayers(); updatePlayerStat(); }
}

const current = () => state.servers.find((s) => s.id === state.selected);

async function refreshServers() {
  state.servers = await api.call('servers:list');
  renderSidebar();
  if (state.selected && !current()) { state.selected = state.servers[0]?.id || null; renderMain(); }
  else if (current()) renderHeaderOnly();
}

function upsertServer(s) {
  const i = state.servers.findIndex((x) => x.id === s.id);
  if (i >= 0) state.servers[i] = s; else state.servers.push(s);
  renderSidebar();
  if (s.id === state.selected) { renderHeaderOnly(); if (state.tab === 'dashboard') renderTab(); }
}

// ---------- sidebar ----------
function renderSidebar() {
  const list = $('#serverList');
  const running = state.servers.filter((s) => s.status === 'running').length;
  $('#runCount').textContent = `${running} running`;
  $('#runCount').className = 'pill ' + (running ? 'running' : '');
  if (!state.servers.length) {
    list.innerHTML = `<div class="empty" style="padding:30px 10px">${icon('server')}<div>No servers yet</div></div>`;
    return;
  }
  list.innerHTML = state.servers.map((s, i) => `
    <div class="srv-item ${s.id === state.selected ? 'active' : ''}" data-id="${s.id}" style="animation-delay:${i * 40}ms">
      <div class="av">${icon('server')}<span class="sd ${s.status}"></span></div>
      <div class="grow">
        <div class="nm ellipsis">${esc(s.name)}</div>
        <div class="sub ellipsis">${s.status === 'running' ? 'Online' : s.status === 'crashed' ? 'Crashed' : s.status === 'stopping' ? 'Stopping…' : 'Offline'} · :${esc(s.port)}${s.exists ? '' : ' · folder missing'}</div>
      </div>
    </div>`).join('');
  for (const el of $$('.srv-item', list)) el.onclick = () => select(el.dataset.id);
}

function select(id) {
  if (state.selected !== id) { state.players = []; state.filesRel = ''; }
  state.selected = id;
  renderSidebar();
  renderMain();
}

// ---------- main ----------
function renderMain() {
  const main = $('#main');
  const s = current();
  if (!s) {
    main.innerHTML = `
      <div class="welcome"><div>
        <div class="hero-logo">${LOGO}</div>
        <h1>Welcome to <span>Redline</span></h1>
        <p>Your BeamMP servers, one place. Create a new server in seconds or add folders you already have. Pick maps, vehicles and mods with photos, then start, stop and watch your server live.</p>
        <div class="actions">
          <button class="btn primary" id="wNew">${icon('plus')}Create a server</button>
          <button class="btn" id="wImport">${icon('folderPlus')}Add existing folder</button>
        </div>
        <div class="feature-grid">
          ${[['bolt', 'One-click start', 'Start, stop and restart with a live console'], ['map', 'Maps with photos', 'Every BeamNG map on this PC'], ['car', 'Vehicle control', 'Switch any car on or off'], ['globe', 'Port forwarding', 'Your IP and port, ready to copy']]
            .map(([ic, t, d], i) => `<div class="feature" style="animation-delay:${200 + i * 80}ms">${icon(ic)}<b>${t}</b><span>${d}</span></div>`).join('')}
        </div>
      </div></div>`;
    $('#wNew').onclick = () => createServerDialog();
    $('#wImport').onclick = () => importServer();
    return;
  }
  main.innerHTML = `
    <div class="srv-header">
      <div class="banner" id="banner"></div>
      <div class="top" id="hdrTop"></div>
      <div class="tabs" id="tabs">${TABS.map(([k, label, ic]) => `<div class="tab ${k === state.tab ? 'active' : ''}" data-tab="${k}">${icon(ic)}${label}<span class="count hidden" data-count="${k}"></span></div>`).join('')}<div class="tab-ink" id="ink"></div></div>
    </div>
    <div class="tab-body" id="tabBody"></div>
    <div class="savebar" id="savebar"><span>You have unsaved changes</span><button class="btn sm" id="sbReset">Discard</button><button class="btn primary sm" id="sbSave">${icon('check')}Save changes</button></div>`;
  for (const t of $$('.tab', main)) t.onclick = () => switchTab(t.dataset.tab);
  renderHeaderOnly();
  renderTab();
  requestAnimationFrame(moveInk);
}

function moveInk() {
  const t = $('.tab.active');
  const ink = $('#ink');
  if (!t || !ink) return;
  ink.style.left = t.offsetLeft + 'px';
  ink.style.width = t.offsetWidth + 'px';
}
window.addEventListener('resize', moveInk);
document.fonts.ready.then(moveInk);

function switchTab(tab) {
  if (state.tab === 'config' && configDirty() && !window.confirm('Discard unsaved settings changes?')) return;
  state.tab = tab;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  moveInk();
  renderTab();
}

function mapInfo(mapPath) {
  const id = (String(mapPath).match(/levels\/([^/]+)/i) || [])[1] || '';
  const m = state.stock?.maps.find((x) => x.id.toLowerCase() === id.toLowerCase());
  return m || { id, title: id ? id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : 'Unknown map', thumb: null, custom: true };
}

function renderHeaderOnly() {
  const s = current();
  const top = $('#hdrTop');
  if (!s || !top) return;
  const statusLabel = { running: 'Online', stopped: 'Offline', crashed: 'Crashed', stopping: 'Stopping…', starting: 'Starting…' }[s.status] || s.status;
  const running = s.status === 'running' || s.status === 'stopping';
  top.innerHTML = `
    <div class="grow">
      <h1><span class="ellipsis">${esc(s.name)}</span><span class="pill ${s.status}"><span class="dot"></span>${statusLabel}</span></h1>
      <div class="path" id="hdrPath" title="Open folder">${icon('folder')}<span class="ellipsis">${esc(s.path)}</span></div>
    </div>
    <div class="ctl">
      ${running
        ? `<button class="btn" id="cRestart" ${s.status === 'stopping' ? 'disabled' : ''}>${icon('restart')}Restart</button>
           <button class="btn danger" id="cStop" ${s.status === 'stopping' ? 'disabled' : ''}>${icon('stop')}Stop</button>`
        : `<button class="btn success" id="cStart" ${s.hasExe ? '' : 'disabled title="Download the server first"'}>${icon('play')}Start server</button>`}
      <button class="btn icon" id="cMore" title="Rename / remove">${icon('edit')}</button>
    </div>`;
  $('#hdrPath').onclick = () => api.call('files:reveal', s.id, '');
  $('#cStart') && ($('#cStart').onclick = startServer);
  $('#cStop') && ($('#cStop').onclick = () => guard(() => api.call('servers:stop', s.id)));
  $('#cRestart') && ($('#cRestart').onclick = () => guard(() => api.call('servers:restart', s.id), 'Server restarted'));
  $('#cMore').onclick = () => serverMenu(s);
  const m = mapInfo(s.map);
  const banner = $('#banner');
  if (banner) banner.style.backgroundImage = m.thumb ? `url("${m.thumb}")` : 'none';
}

async function startServer() {
  const s = current();
  if (!s.hasAuthKey) {
    const go = await confirmBox('No AuthKey set', 'BeamMP servers need an AuthKey from keymaster.beammp.com to start and to show up for players.\n\nStart anyway?', { ok: 'Start anyway' });
    if (!go) return;
  }
  const r = await guard(() => api.call('servers:start', s.id));
  if (r) { toast('Server is starting up', 'success'); if (state.tab !== 'dashboard' && state.tab !== 'console') switchTab('console'); }
}

async function serverMenu(s) {
  const r = await modal({
    title: 'Manage server',
    body: `<div class="field"><label>Display name (sidebar only)</label><input class="input" id="rnName" value="${esc(s.name)}"></div>
      <div class="toggle-row"><div><div class="t-title">Remove from manager</div><div class="t-sub">The server folder stays on disk. You can add it back any time.</div></div><button class="btn sm" data-act="forget">Remove</button></div>
      <div class="toggle-row"><div><div class="t-title" style="color:#ff8592">Delete server</div><div class="t-sub">Moves the whole server folder to the Recycle Bin.</div></div><button class="btn danger sm" data-act="delete">${icon('trash')}Delete</button></div>`,
    actions: [{ label: 'Close', value: null }, { label: 'Save name', primary: true, onClick: (b) => ({ rename: $('#rnName', b).value }) }],
    onMount: (b, close) => { for (const btn of $$('[data-act]', b)) btn.onclick = () => close({ act: btn.dataset.act }); },
  });
  if (!r) return;
  if (r.rename) return guard(() => api.call('servers:rename', s.id, r.rename), 'Renamed');
  if (r.act === 'forget' && await confirmBox('Remove server?', `"${s.name}" will be removed from the list. Files are kept.`, { ok: 'Remove' })) {
    await guard(() => api.call('servers:remove', s.id, false), 'Server removed from list');
  }
  if (r.act === 'delete' && await confirmBox('Delete server?', `This moves the folder to the Recycle Bin:\n${s.path}`, { danger: true, ok: 'Delete' })) {
    await guard(() => api.call('servers:remove', s.id, true), 'Server moved to Recycle Bin');
  }
}

function renderTab() {
  const body = $('#tabBody');
  if (!body) return;
  $('#savebar')?.classList.remove('show');
  ({ dashboard: renderDashboard, console: renderConsole, config: renderConfig, mods: renderMods, plugins: renderPlugins, files: renderFiles }[state.tab])(body);
}

// ---------- dashboard ----------
async function renderDashboard(body) {
  const s = current();
  const m = mapInfo(s.map);
  const dl = state.downloads.get(s.id);
  const [meta, mods] = await Promise.all([api.call('meta:read', s.id).catch(() => ({ blockedVehicles: [] })), api.call('mods:list', s.id).catch(() => [])]);
  if (current()?.id !== s.id || state.tab !== 'dashboard') return;
  const totalVeh = state.stock?.vehicles.length || 0;
  const blocked = meta.blockedVehicles.length;
  const enabledMods = mods.filter((x) => x.enabled).length;
  const running = s.status === 'running';

  body.innerHTML = `
    ${!s.exists ? `<div class="banner-msg err">${icon('alert')}<div class="grow">Server folder not found<small>${esc(s.path)}</small></div></div>` : ''}
    ${!s.hasExe && s.exists ? `<div class="banner-msg warn">${icon('download')}<div class="grow">BeamMP-Server.exe is missing<small>Download the latest official server from GitHub (BeamMP/BeamMP-Server).</small>
      ${dl ? `<div class="progress ${dl.total ? '' : 'indeterminate'}" style="margin-top:8px"><div style="width:${dl.total ? (dl.got / dl.total) * 100 : 0}%"></div></div>` : ''}</div>
      <button class="btn primary sm" id="dlExe" ${dl ? 'disabled' : ''}>${icon('download')}${dl ? 'Downloading…' : 'Download server'}</button></div>` : ''}
    ${!s.hasAuthKey ? `<div class="banner-msg warn">${icon('key')}<div class="grow">No AuthKey set<small>Get a free key at keymaster.beammp.com and paste it in Settings → Authentication.</small></div>
      <button class="btn sm" id="getKey">${icon('external')}Get key</button><button class="btn sm" id="goCfg">Add key</button></div>` : ''}
    <div class="stats">
      <div class="stat"><div class="glow" style="background:${running ? 'var(--green)' : '#666'}"></div><div class="lbl">${icon('bolt')}Status</div>
        <div class="val" style="color:${running ? 'var(--green)' : s.status === 'crashed' ? 'var(--red)' : 'inherit'}">${{ running: 'Online', crashed: 'Crashed', stopping: 'Stopping' }[s.status] || 'Offline'}</div>
        <div class="sub">${running && s.startedAt ? `Up <span data-uptime="${s.startedAt}">${fmtDuration(Date.now() - s.startedAt)}</span>` : 'Not running'}</div></div>
      <div class="stat"><div class="glow" style="background:var(--blue)"></div><div class="lbl">${icon('users')}Players</div>
        <div class="val" id="statPlayers">${running ? state.players.length : 0}<small> / ${esc(s.maxPlayers)}</small></div><div class="sub">${s.private ? 'Private server' : 'Public server'}</div></div>
      <div class="stat"><div class="glow" style="background:var(--accent)"></div><div class="lbl">${icon('car')}Vehicles</div>
        <div class="val">${totalVeh ? totalVeh - blocked : '—'}<small>${totalVeh ? ' / ' + totalVeh : ''}</small></div><div class="sub">${blocked ? `${blocked} switched off` : 'All stock vehicles allowed'}</div></div>
      <div class="stat"><div class="glow" style="background:#b69cff"></div><div class="lbl">${icon('box')}Mods</div>
        <div class="val">${enabledMods}<small>${mods.length !== enabledMods ? ' / ' + mods.length : ''}</small></div><div class="sub">${mods.length ? fmtBytes(mods.filter((x) => x.enabled).reduce((a, b) => a + b.size, 0)) + ' to download' : 'No mods installed'}</div></div>
    </div>
    <div class="dash">
      <div class="col">
        <div class="card"><h3>${icon('globe')}Connection & port forwarding<span class="right"><button class="btn ghost sm" id="netRefresh">${icon('refresh')}Refresh</button></span></h3>
          <div id="netBox"><div class="row faint"><div class="spinner"></div>Looking up your IP addresses…</div></div>
        </div>
        <div class="card"><h3>${icon('users')}Players online<span class="right faint" id="plCount"></span></h3><div class="players" id="playersBox"></div></div>
      </div>
      <div class="col">
        <div class="card"><h3>${icon('layers')}Content<span class="right"><button class="btn sm" id="openBrowser">${icon('external')}Open content browser</button></span></h3>
          <div class="content-tiles">
            <div class="ctile" data-pick="maps">${thumbHtml(m.thumb, 'map')}<div class="grow"><div class="t ellipsis">${esc(m.title)}</div><div class="s">Current map · click to change</div></div>${icon('chevron')}</div>
            <div class="ctile" data-pick="vehicles">${thumbHtml(state.stock?.vehicles.find((v) => v.model === 'pickup')?.thumb || state.stock?.vehicles[0]?.thumb, 'car')}<div class="grow"><div class="t">Vehicles</div><div class="s">${totalVeh ? `${totalVeh - blocked} of ${totalVeh} allowed` : 'Choose allowed vehicles'}</div></div>${icon('chevron')}</div>
            <div class="ctile" data-pick="mods">${thumbHtml(null, 'box')}<div class="grow"><div class="t">Mods</div><div class="s">${enabledMods} enabled · add maps, cars and more</div></div>${icon('chevron')}</div>
          </div>
        </div>
        <div class="card"><h3>${icon('server')}Server details</h3>
          <div class="list">
            ${detailRow('Server name', stripCodes(s.title))}
            ${detailRow('Port', s.port)}
            ${detailRow('Max players', s.maxPlayers)}
            ${detailRow('Visibility', s.private ? 'Private (direct connect only)' : 'Public (listed in server browser)')}
            ${detailRow('Process ID', s.pid || '—')}
          </div>
        </div>
      </div>
    </div>`;
  $('#dlExe') && ($('#dlExe').onclick = () => downloadExe(s.id));
  $('#getKey') && ($('#getKey').onclick = () => api.call('ui:openExternal', KEYMASTER));
  $('#goCfg') && ($('#goCfg').onclick = () => switchTab('config'));
  $('#openBrowser').onclick = () => api.call('ui:openPicker', s.id, 'maps');
  for (const t of $$('[data-pick]', body)) t.onclick = () => api.call('ui:openPicker', s.id, t.dataset.pick);
  $('#netRefresh').onclick = () => loadNet(true);
  renderPlayers();
  loadNet(false);
}

const detailRow = (k, v) => `<div class="row" style="padding:6px 2px;border-bottom:1px solid var(--line)"><span class="faint grow">${esc(k)}</span><span class="select-text">${esc(v)}</span></div>`;

function updatePlayerStat() {
  const s = current();
  const el = $('#statPlayers');
  if (el && s) el.innerHTML = `${state.players.length}<small> / ${esc(s.maxPlayers)}</small>`;
}

function renderPlayers() {
  const box = $('#playersBox');
  if (!box) return;
  const s = current();
  $('#plCount') && ($('#plCount').textContent = s?.status === 'running' ? `${state.players.length} connected` : '');
  if (s?.status !== 'running') { box.innerHTML = `<div class="empty" style="padding:20px">${icon('users')}<div>Start the server to see players</div></div>`; return; }
  if (!state.players.length) { box.innerHTML = `<div class="empty" style="padding:20px">${icon('users')}<div>Nobody is online yet</div></div>`; return; }
  box.innerHTML = state.players.map((p) => `
    <div class="player"><div class="pav">${esc(stripCodes(p.name).slice(0, 1).toUpperCase())}</div>
      <div class="grow"><div style="font-weight:600">${esc(stripCodes(p.name))} ${p.guest ? '<span class="pill" style="height:18px;font-size:10px">Guest</span>' : ''}</div><div class="faint" style="font-size:12px">${p.vehicles} vehicle${p.vehicles === 1 ? '' : 's'} · ID ${p.id}</div></div>
      <button class="btn sm danger" data-kick="${esc(p.name)}">${icon('kick')}Kick</button></div>`).join('');
  for (const b of $$('[data-kick]', box)) {
    b.onclick = async () => {
      const reason = await promptBox(`Kick ${b.dataset.kick}`, 'Reason (shown to the player)', 'Kicked by admin');
      if (reason) guard(() => api.call('servers:command', s.id, `kick ${b.dataset.kick} ${reason}`), 'Player kicked');
    };
  }
}

async function loadNet(force) {
  const box = $('#netBox');
  if (!box) return;
  if (force || !state.net) {
    box.innerHTML = '<div class="row faint"><div class="spinner"></div>Looking up your IP addresses…</div>';
    state.net = await api.call('net:info', force).catch(() => ({ local: [], public: null }));
  }
  const box2 = $('#netBox');
  if (!box2) return;
  const s = current();
  const local = state.net.local[0]?.address || 'Unknown';
  const pub = state.net.public || 'Unavailable';
  box2.innerHTML = `
    <div class="net-grid">
      <div class="net-item"><div><div class="k">Port to forward</div><div class="v big">${esc(s.port)}</div></div><span class="pill accent" style="margin-left:auto">TCP + UDP</span></div>
      <div class="net-item"><div><div class="k">Forward to (this PC)</div><div class="v">${esc(local)}</div></div><button class="btn sm icon ghost" data-copy="${esc(local)}" title="Copy">${icon('copy')}</button></div>
      <div class="net-item"><div><div class="k">Players connect to</div><div class="v">${esc(pub)}:${esc(s.port)}</div></div><button class="btn sm icon ghost" data-copy="${esc(pub)}:${esc(s.port)}" title="Copy">${icon('copy')}</button></div>
      <div class="net-item"><div><div class="k">Same network (LAN)</div><div class="v">${esc(local)}:${esc(s.port)}</div></div><button class="btn sm icon ghost" data-copy="${esc(local)}:${esc(s.port)}" title="Copy">${icon('copy')}</button></div>
    </div>
    ${state.net.local.length > 1 ? `<div class="faint" style="font-size:12px;margin-top:8px">Other adapters: ${state.net.local.slice(1).map((a) => `${esc(a.address)} (${esc(a.name)})`).join(', ')}</div>` : ''}
    <ol class="steps">
      <li><span>Open your router page${state.net.gateway ? ` at <a data-router="${esc(state.net.gateway)}">${esc(state.net.gateway)}</a>` : ''} and find <b>Port Forwarding</b> (sometimes called NAT or Virtual Server).</span></li>
      <li><span>Forward port <b>${esc(s.port)}</b> for <b>both TCP and UDP</b> to <b>${esc(local)}</b>.</span></li>
      <li><span>Allow the port through Windows Firewall.</span></li>
      <li><span>Friends connect with <b>Direct Connect</b> in BeamMP using <b>${esc(pub)}</b> and port <b>${esc(s.port)}</b>.</span></li>
    </ol>
    <div class="row" style="margin-top:14px"><button class="btn sm" id="fwBtn">${icon('shield')}Add Windows Firewall rule</button><span class="faint" style="font-size:12px">Asks for administrator permission</span></div>`;
  for (const b of $$('[data-copy]', box2)) b.onclick = () => { api.call('ui:copy', b.dataset.copy); toast(`Copied ${b.dataset.copy}`, 'success'); };
  const r = $('[data-router]', box2);
  if (r) r.onclick = () => api.call('ui:openExternal', `http://${r.dataset.router}`);
  if (REMOTE.connected) $('#fwBtn').parentElement.innerHTML = '<span class="faint" style="font-size:12px">Add the Windows Firewall rule on the host computer itself.</span>';
  else $('#fwBtn').onclick = () => guard(() => api.call('net:firewall', s.port), `Firewall rule added for port ${s.port} (TCP + UDP)`);
}

async function downloadExe(id) {
  state.downloads.set(id, { got: 0, total: 0 });
  if (state.tab === 'dashboard') renderTab();
  await guard(() => api.call('servers:download', id), 'BeamMP server downloaded');
  state.downloads.delete(id);
  await refreshServers();
  if (state.tab === 'dashboard' && current()?.id === id) renderTab();
}

function onDownload(e) {
  if (e.phase === 'progress') {
    state.downloads.set(e.id, { got: e.got, total: e.total });
    const bar = $('.banner-msg .progress');
    if (bar && e.id === state.selected) { bar.classList.toggle('indeterminate', !e.total); bar.firstElementChild.style.width = e.total ? (e.got / e.total) * 100 + '%' : '0'; }
    const cbar = $('#createProgress');
    if (cbar) { cbar.classList.toggle('indeterminate', !e.total); cbar.firstElementChild.style.width = e.total ? (e.got / e.total) * 100 + '%' : '0'; $('#createStatus').textContent = `Downloading BeamMP-Server.exe… ${fmtBytes(e.got)}${e.total ? ' of ' + fmtBytes(e.total) : ''}`; }
  }
}

// ---------- console ----------
function levelClass(line) {
  const m = line.match(/\[(ERROR|WARN|WARNING|INFO|DEBUG|CHAT|LUA|LUA ERROR|LUA WARN)\]/i);
  if (!m) return '';
  const l = m[1].toLowerCase();
  if (l.includes('error')) return 'lv-error';
  if (l.startsWith('warn') || l === 'lua warn') return 'lv-warn';
  if (l === 'lua') return 'lv-lua';
  return 'lv-' + l;
}
const lineHtml = (e) => `<div class="ln ${e.kind} ${levelClass(e.line)}">${esc(e.line)}</div>`;
const cmdHistory = [];
let histIdx = -1;

async function renderConsole(body) {
  const s = current();
  body.style.paddingBottom = '22px';
  body.innerHTML = `
    <div class="console-wrap">
      <div class="row">
        <div class="chips">${['status', 'list', 'help', 'settings list'].map((c) => `<span class="chip" data-cmd="${c}">${icon('terminal')}${c}</span>`).join('')}
          <span class="chip" data-say>${icon('send')}Say to everyone…</span></div>
        <div class="grow"></div>
        <span class="chip on" id="autoScroll">Auto-scroll</span>
        <button class="btn sm ghost" id="clearLog">${icon('trash')}Clear</button>
      </div>
      <div class="console" id="console"></div>
      <div class="console-input">
        <input class="input" id="cmdInput" placeholder="${s.status === 'running' ? 'Type a server command (e.g. say Hello, kick Name, status) and press Enter' : 'Start the server to send commands'}" ${s.status === 'running' ? '' : 'disabled'}>
        <button class="btn primary" id="cmdSend" ${s.status === 'running' ? '' : 'disabled'}>${icon('send')}Send</button>
      </div>
    </div>`;
  body.firstElementChild.style.height = '100%';
  const con = $('#console');
  const logs = await api.call('servers:logs', s.id);
  state.logs.set(s.id, logs);
  con.innerHTML = logs.length ? logs.map(lineHtml).join('') : `<div class="ln sys">Console output will appear here when the server runs.</div>`;
  con.scrollTop = con.scrollHeight;
  const send = (cmd) => {
    cmd = (cmd ?? $('#cmdInput').value).trim();
    if (!cmd) return;
    cmdHistory.unshift(cmd); histIdx = -1;
    guard(() => api.call('servers:command', s.id, cmd));
    $('#cmdInput').value = '';
  };
  $('#cmdSend').onclick = () => send();
  $('#cmdInput').onkeydown = (e) => {
    if (e.key === 'Enter') send();
    if (e.key === 'ArrowUp' && cmdHistory.length) { histIdx = Math.min(histIdx + 1, cmdHistory.length - 1); e.target.value = cmdHistory[histIdx]; e.preventDefault(); }
    if (e.key === 'ArrowDown') { histIdx = Math.max(histIdx - 1, -1); e.target.value = histIdx >= 0 ? cmdHistory[histIdx] : ''; }
  };
  for (const c of $$('[data-cmd]', body)) c.onclick = () => (s.status === 'running' ? send(c.dataset.cmd) : toast('Start the server first'));
  $('[data-say]', body).onclick = async () => {
    if (s.status !== 'running') return toast('Start the server first');
    const msg = await promptBox('Message everyone', 'Message');
    if (msg) send('say ' + msg);
  };
  $('#autoScroll').onclick = (e) => e.currentTarget.classList.toggle('on');
  $('#clearLog').onclick = async () => { await api.call('servers:clearLogs', s.id); con.innerHTML = ''; };
  if (s.status === 'running') $('#cmdInput').focus();
}

function onLog(e) {
  if (e.id !== state.selected || state.tab !== 'console') return;
  const con = $('#console');
  if (!con) return;
  if (con.children.length === 1 && con.firstElementChild.textContent.startsWith('Console output')) con.innerHTML = '';
  con.insertAdjacentHTML('beforeend', lineHtml(e));
  while (con.children.length > 3000) con.firstElementChild.remove();
  if ($('#autoScroll')?.classList.contains('on')) con.scrollTop = con.scrollHeight;
  if (/\[INFO\].*(ALL SYSTEMS STARTED|Vehicle data network online|started)/i.test(e.line)) {
    const inp = $('#cmdInput');
    if (inp) { inp.disabled = false; $('#cmdSend').disabled = false; }
  }
}
api.on('server:status', (s) => {
  if (s.id === state.selected && state.tab === 'console') {
    const inp = $('#cmdInput');
    if (inp) { const on = s.status === 'running'; inp.disabled = !on; $('#cmdSend').disabled = !on; inp.placeholder = on ? 'Type a server command and press Enter' : 'Start the server to send commands'; }
  }
});

// ---------- config ----------
let cfgOriginal = null;
const CFG_FIELDS = {
  General: ['Name', 'Description', 'Tags', 'Map', 'MaxPlayers', 'MaxCars', 'AllowGuests', 'Port', 'IP', 'Private', 'InformationPacket', 'AuthKey', 'LogChat', 'Debug', 'ResourceFolder'],
  Misc: ['ImScaredOfUpdates', 'UpdateReminderTime'],
};

function configDirty() {
  if (!cfgOriginal || !$('#cfgForm')) return false;
  const cur = readCfgForm();
  return JSON.stringify(cur) !== JSON.stringify(pickCfg(cfgOriginal));
}
function pickCfg(c) {
  const out = {};
  for (const [sec, keys] of Object.entries(CFG_FIELDS)) { out[sec] = {}; for (const k of keys) out[sec][k] = c[sec][k]; }
  return out;
}
function readCfgForm() {
  const out = { General: {}, Misc: {} };
  for (const el of $$('#cfgForm [data-key]')) {
    const [sec, key] = el.dataset.key.split('.');
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'number') v = Number(v);
    out[sec][key] = v;
  }
  return out;
}

async function renderConfig(body) {
  const s = current();
  const cfg = await api.call('config:read', s.id);
  cfgOriginal = cfg;
  const G = cfg.General, M = cfg.Misc;
  const txt = (key, label, hint = '', type = 'text', extra = '') => {
    const [sec, k] = key.split('.');
    return `<div class="field"><label>${label}</label><input class="input" type="${type}" data-key="${key}" value="${esc(cfg[sec][k])}" ${extra}>${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
  };
  const sw = (key, title, sub) => {
    const [sec, k] = key.split('.');
    return `<div class="toggle-row"><div><div class="t-title">${title}</div><div class="t-sub">${sub}</div></div><label class="switch"><input type="checkbox" data-key="${key}" ${cfg[sec][k] ? 'checked' : ''}><span class="track"></span></label></div>`;
  };
  const m = mapInfo(G.Map);
  body.innerHTML = `
    ${s.status === 'running' ? `<div class="banner-msg warn">${icon('info')}<div class="grow">The server is running<small>Changes are saved to ServerConfig.toml and apply after a restart.</small></div></div>` : ''}
    <div class="cfg" id="cfgForm">
      <div class="card"><h3>${icon('server')}General</h3>
        ${txt('General.Name', 'Server name', 'Shown in the BeamMP server list. Supports ^ color codes like ^4Blue.')}
        <div class="field"><label>Description</label><textarea class="input" data-key="General.Description" rows="3">${esc(G.Description)}</textarea></div>
        ${txt('General.Tags', 'Tags', 'Comma separated, e.g. Freeroam,Racing,Drift')}
      </div>
      <div class="card"><h3>${icon('map')}Gameplay</h3>
        <div class="field"><label>Map</label>
          <div class="map-field">${thumbHtml(m.thumb, 'map')}<div class="grow"><div style="font-weight:600" id="cfgMapTitle">${esc(m.title)}</div><input class="input mono" data-key="General.Map" value="${esc(G.Map)}" style="height:30px;font-size:12px;margin-top:4px"></div>
          <button class="btn sm" id="cfgPickMap">${icon('image')}Browse</button></div></div>
        <div class="grid-2">${txt('General.MaxPlayers', 'Max players', '', 'number', 'min="1" max="200"')}${txt('General.MaxCars', 'Max cars per player', '', 'number', 'min="0" max="50"')}</div>
        ${sw('General.AllowGuests', 'Allow guests', 'Players without a BeamMP account can join')}
      </div>
      <div class="card"><h3>${icon('globe')}Network</h3>
        <div class="grid-2">${txt('General.Port', 'Port', 'TCP + UDP, default 30814', 'number', 'min="1" max="65535"')}${txt('General.IP', 'Bind IP', ':: listens on all addresses')}</div>
        ${sw('General.Private', 'Private server', 'Hidden from the public server list, join with Direct Connect')}
        ${sw('General.InformationPacket', 'Information packet', 'Lets launchers query server info before joining')}
      </div>
      <div class="card"><h3>${icon('key')}Authentication</h3>
        <div class="field"><label>AuthKey</label>
          <div class="input-group"><input class="input mono" type="password" data-key="General.AuthKey" value="${esc(G.AuthKey)}" placeholder="Paste your key from keymaster.beammp.com">
          <button class="btn icon" id="showKey" title="Show / hide">${icon('eye')}</button></div>
          <span class="hint">Keep this secret. <a id="cfgKeymaster">Get a free key at keymaster.beammp.com</a></span></div>
        ${sw('General.LogChat', 'Log chat', 'Write player chat to the console and log file')}
        ${sw('General.Debug', 'Debug logging', 'Very verbose; for troubleshooting only')}
      </div>
      <div class="card full"><h3>${icon('settings')}Advanced<span class="right"><button class="btn sm" id="rawEdit">${icon('edit')}Edit raw ServerConfig.toml</button></span></h3>
        <div class="grid-3">
          ${txt('General.ResourceFolder', 'Resource folder', 'Where mods and plugins live')}
          ${txt('Misc.UpdateReminderTime', 'Update reminder', 'e.g. 30s, 5min')}
          <div style="align-self:end">${sw('Misc.ImScaredOfUpdates', 'Hide update notices', 'Silence "new version" messages')}</div>
        </div>
      </div>
    </div>`;
  const form = $('#cfgForm');
  const onInput = () => $('#savebar').classList.toggle('show', configDirty());
  form.addEventListener('input', onInput);
  form.addEventListener('change', onInput);
  $('#showKey').onclick = () => { const i = $('[data-key="General.AuthKey"]'); i.type = i.type === 'password' ? 'text' : 'password'; };
  $('#cfgKeymaster').onclick = () => api.call('ui:openExternal', KEYMASTER);
  $('#cfgPickMap').onclick = () => api.call('ui:openPicker', s.id, 'maps');
  $('#rawEdit').onclick = () => editText(s.id, 'ServerConfig.toml', true);
  $('#sbReset').onclick = () => renderConfig(body);
  $('#sbSave').onclick = async () => {
    const vals = readCfgForm();
    const port = vals.General.Port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return toast('Port must be a number between 1 and 65535', 'error');
    const r = await guard(() => api.call('config:write', s.id, vals), s.status === 'running' ? 'Saved. Restart the server to apply.' : 'Settings saved');
    if (r) { cfgOriginal = r; $('#savebar').classList.remove('show'); await refreshServers(); }
  };
}

// ---------- mods ----------
async function renderMods(body) {
  const s = current();
  body.innerHTML = `
    <div class="toolbar">
      <div class="search">${icon('search')}<input class="input" id="modSearch" placeholder="Search mods"></div>
      <div class="grow"></div>
      <button class="btn" id="modBrowser">${icon('image')}Content browser</button>
      <button class="btn primary" id="modAdd">${icon('plus')}Add mod files</button>
    </div>
    ${s.status === 'running' ? `<div class="banner-msg warn">${icon('info')}<div class="grow">Mod changes apply after a restart<small>Players download enabled mods when they join.</small></div></div>` : ''}
    <div class="list" id="modList"><div class="row faint"><div class="spinner"></div>Reading mods…</div></div>`;
  $('#modAdd').onclick = async () => { const files = await api.call('dialog:openFiles', { zip: true, title: 'Add BeamNG mods (.zip)' }); if (files.length) addMods(files); };
  $('#modBrowser').onclick = () => api.call('ui:openPicker', s.id, 'mods');
  const mods = await api.call('mods:details', s.id);
  if (current()?.id !== s.id || state.tab !== 'mods') return;
  const list = $('#modList');
  const draw = () => {
    const q = $('#modSearch').value.toLowerCase();
    const shown = mods.filter((m) => !q || (m.title + m.fileName).toLowerCase().includes(q));
    $('[data-count="mods"]').textContent = mods.length;
    $('[data-count="mods"]').classList.toggle('hidden', !mods.length);
    moveInk();
    if (!shown.length) {
      list.innerHTML = `<div class="empty">${icon('box')}<div>${mods.length ? 'No mods match your search' : 'No mods yet. Drop .zip files here or click "Add mod files".'}</div></div>`;
      return;
    }
    list.innerHTML = shown.map((m, i) => `
      <div class="lrow ${m.enabled ? '' : 'off'}" style="animation-delay:${Math.min(i, 15) * 25}ms">
        ${thumbHtml(m.thumb, m.kind === 'map' ? 'map' : m.kind === 'vehicle' ? 'car' : 'box')}
        <div class="grow"><div class="t ellipsis">${esc(m.title || m.fileName)}</div>
          <div class="s ellipsis">${esc(m.fileName)} · ${fmtBytes(m.size)}${m.vehicles?.length ? ` · ${m.vehicles.length} vehicle${m.vehicles.length > 1 ? 's' : ''}` : ''}${m.maps?.length ? ` · ${m.maps.length} map${m.maps.length > 1 ? 's' : ''}` : ''}</div></div>
        <span class="pill ${m.kind === 'map' ? 'blue' : m.kind === 'vehicle' ? 'accent' : ''}">${{ map: 'Map', vehicle: 'Vehicle', mixed: 'Map + vehicles', other: 'Mod' }[m.kind] || 'Mod'}</span>
        <label class="switch" title="${m.enabled ? 'Enabled' : 'Disabled'}"><input type="checkbox" data-toggle="${esc(m.fileName)}" ${m.enabled ? 'checked' : ''}><span class="track"></span></label>
        <div class="acts"><button class="btn sm icon ghost" data-del="${esc(m.fileName)}" title="Remove">${icon('trash')}</button></div>
      </div>`).join('');
    for (const t of $$('[data-toggle]', list)) t.onchange = async () => {
      const r = await guard(() => api.call('mods:setEnabled', s.id, t.dataset.toggle, t.checked));
      if (!r) { t.checked = !t.checked; return; }
      const mod = mods.find((x) => x.fileName === t.dataset.toggle);
      mod.enabled = t.checked;
      t.closest('.lrow').classList.toggle('off', !t.checked);
    };
    for (const b of $$('[data-del]', list)) b.onclick = async () => {
      if (!(await confirmBox('Remove mod?', `${b.dataset.del} will be moved to the Recycle Bin.`, { danger: true, ok: 'Remove' }))) return;
      if (await guard(() => api.call('mods:remove', s.id, b.dataset.del), 'Mod removed') !== undefined) renderMods(body);
    };
  };
  $('#modSearch').oninput = draw;
  draw();
}

async function addMods(files) {
  const s = current();
  const r = await guard(() => api.call('mods:add', s.id, files));
  if (!r) return;
  if (r.added.length) toast(`${r.added.length} mod${r.added.length > 1 ? 's' : ''} added${r.restartNeeded ? ' · restart to apply' : ''}`, 'success');
  if (r.skipped.length) toast(`Skipped (not .zip): ${r.skipped.join(', ')}`, 'error');
  if (state.tab === 'mods') renderTab();
}

// ---------- plugins ----------
async function renderPlugins(body) {
  const s = current();
  const plugins = await api.call('plugins:list', s.id);
  body.innerHTML = `
    <div class="toolbar"><div class="muted">Server plugins are Lua scripts in <span class="mono">Resources/Server</span>. Each plugin is a folder.</div><div class="grow"></div>
      <button class="btn primary" id="plAdd">${icon('folderPlus')}Add plugin folder</button></div>
    <div class="list">${plugins.length ? plugins.map((p, i) => `
      <div class="lrow" style="animation-delay:${i * 30}ms"><div class="ic-box ${p.system ? '' : 'dir'}">${icon(p.system ? 'shield' : 'puzzle')}</div>
        <div class="grow"><div class="t">${esc(p.name)} ${p.system ? '<span class="pill accent" style="height:20px;font-size:11px">Manager</span>' : ''}</div>
        <div class="s">${p.system ? 'Built-in helper: player list and vehicle filtering' : `${p.files} file${p.files === 1 ? '' : 's'} · ${p.lua} Lua`}</div></div>
        <div class="acts"><button class="btn sm ghost" data-open="${esc(p.name)}">${icon('folder')}Open</button>
        ${p.system ? '' : `<button class="btn sm icon ghost" data-rm="${esc(p.name)}" title="Remove">${icon('trash')}</button>`}</div></div>`).join('')
      : `<div class="empty">${icon('puzzle')}<div>No plugins yet</div></div>`}</div>`;
  $('#plAdd').onclick = async () => {
    const dir = await api.call('dialog:openFolder', 'Choose a plugin folder');
    if (dir && await guard(() => api.call('plugins:add', s.id, dir), 'Plugin added') !== undefined) renderPlugins(body);
  };
  for (const b of $$('[data-open]', body)) b.onclick = () => api.call('files:reveal', s.id, `Resources/Server/${b.dataset.open}`);
  for (const b of $$('[data-rm]', body)) b.onclick = async () => {
    if (!(await confirmBox('Remove plugin?', `"${b.dataset.rm}" will be moved to the Recycle Bin.`, { danger: true, ok: 'Remove' }))) return;
    if (await guard(() => api.call('plugins:remove', s.id, b.dataset.rm), 'Plugin removed') !== undefined) renderPlugins(body);
  };
}

// ---------- files ----------
const TEXT_EXT = /\.(toml|lua|json|txt|log|cfg|ini|md|yml|yaml|csv|xml|js|bat|cmd|ps1|sh)$/i;
async function renderFiles(body) {
  const s = current();
  let items;
  try { items = await api.call('files:list', s.id, state.filesRel); } catch (e) {
    state.filesRel = '';
    body.innerHTML = `<div class="empty">${icon('alert')}<div>${esc(e.message)}</div></div>`;
    return;
  }
  const parts = state.filesRel ? state.filesRel.split(/[\\/]/) : [];
  body.innerHTML = `
    <div class="toolbar">
      <div class="crumbs"><a data-rel="">${icon('server')}</a>${parts.map((p, i) => `${icon('chevron')}<a data-rel="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</a>`).join('')}</div>
      <div class="grow"></div>
      <button class="btn sm" id="fNewDir">${icon('folderPlus')}New folder</button>
      <button class="btn sm" id="fReveal">${icon('external')}Open in Explorer</button>
      <button class="btn sm primary" id="fAdd">${icon('upload')}Add files</button>
    </div>
    <div class="list">
      ${parts.length ? `<div class="lrow clickable" data-up><div class="ic-box">${icon('back')}</div><div class="grow t">..</div></div>` : ''}
      ${items.length ? items.map((f, i) => `
        <div class="lrow ${f.dir ? 'clickable' : ''}" data-item="${esc(f.rel)}" data-dir="${f.dir}" style="animation-delay:${Math.min(i, 20) * 15}ms">
          <div class="ic-box ${f.dir ? 'dir' : ''}">${icon(f.dir ? 'folder' : 'file')}</div>
          <div class="grow"><div class="t ellipsis">${esc(f.name)}</div><div class="s">${f.dir ? 'Folder' : fmtBytes(f.size)} · ${new Date(f.mtime).toLocaleString()}</div></div>
          <div class="acts">
            ${!f.dir && TEXT_EXT.test(f.name) ? `<button class="btn sm ghost" data-edit>${icon('edit')}Edit</button>` : ''}
            <button class="btn sm icon ghost" data-rename title="Rename">${icon('edit')}</button>
            <button class="btn sm icon ghost" data-show title="Show in Explorer">${icon('external')}</button>
            <button class="btn sm icon ghost" data-delete title="Delete">${icon('trash')}</button>
          </div>
        </div>`).join('') : `<div class="empty">${icon('folder')}<div>This folder is empty. Drop files here to add them.</div></div>`}
    </div>`;
  for (const a of $$('[data-rel]', body)) a.onclick = () => { state.filesRel = a.dataset.rel; renderFiles(body); };
  $('[data-up]', body) && ($('[data-up]', body).onclick = () => { state.filesRel = parts.slice(0, -1).join('/'); renderFiles(body); });
  $('#fReveal').onclick = () => api.call('files:reveal', s.id, state.filesRel);
  $('#fAdd').onclick = async () => { const files = await api.call('dialog:openFiles', { title: 'Add files to server folder' }); if (files.length) addFilesHere(files); };
  $('#fNewDir').onclick = async () => { const n = await promptBox('New folder', 'Folder name'); if (n && await guard(() => api.call('files:mkdir', s.id, state.filesRel, n)) !== undefined) renderFiles(body); };
  for (const row of $$('[data-item]', body)) {
    const rel = row.dataset.item;
    const isDir = row.dataset.dir === 'true';
    row.onclick = (e) => {
      if (e.target.closest('.acts')) return;
      if (isDir) { state.filesRel = rel.replace(/\\/g, '/'); renderFiles(body); } else if (TEXT_EXT.test(rel)) editText(s.id, rel);
    };
    $('[data-edit]', row) && ($('[data-edit]', row).onclick = () => editText(s.id, rel));
    $('[data-show]', row).onclick = () => api.call('files:reveal', s.id, rel);
    $('[data-rename]', row).onclick = async () => {
      const n = await promptBox('Rename', 'New name', rel.split(/[\\/]/).pop());
      if (n && await guard(() => api.call('files:rename', s.id, rel, n)) !== undefined) renderFiles(body);
    };
    $('[data-delete]', row).onclick = async () => {
      if (!(await confirmBox('Delete?', `${rel} will be moved to the Recycle Bin.`, { danger: true, ok: 'Delete' }))) return;
      if (await guard(() => api.call('files:delete', s.id, rel), 'Moved to Recycle Bin') !== undefined) renderFiles(body);
    };
  }
}

async function addFilesHere(files) {
  const s = current();
  if (await guard(() => api.call('files:add', s.id, state.filesRel, files), `Added ${files.length} item${files.length > 1 ? 's' : ''}`) !== undefined) renderTab();
}

async function editText(id, rel, isConfig = false) {
  const text = await guard(() => api.call('files:read', id, rel));
  if (text === undefined) return;
  const ta = h(`<textarea class="input editor" spellcheck="false"></textarea>`);
  ta.value = text;
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); const p = ta.selectionStart; ta.setRangeText('  ', p, ta.selectionEnd, 'end'); }
  });
  await modal({
    title: rel.split(/[\\/]/).pop(),
    wide: true,
    body: ta,
    actions: [{ label: 'Cancel', value: null }, {
      label: 'Save', primary: true, icon: 'check',
      onClick: async () => {
        const ok = await guard(() => (isConfig ? api.call('config:writeRaw', id, ta.value) : api.call('files:write', id, rel, ta.value)), 'Saved');
        if (ok === undefined) return false;
        if (isConfig || /ServerConfig\.toml$/i.test(rel)) { await refreshServers(); if (state.tab === 'config') renderTab(); }
        return true;
      },
    }],
  });
}

// global drag & drop
enableFileDrop((paths) => {
  const s = current();
  if (!s) return toast('Create or select a server first', 'error');
  if (state.tab === 'files') return addFilesHere(paths);
  if (state.tab === 'plugins') return Promise.all(paths.map((p) => api.call('plugins:add', s.id, p))).then(() => { toast('Plugin added', 'success'); renderTab(); }).catch((e) => toast(e.message, 'error'));
  addMods(paths);
}, () => (state.tab === 'files' ? 'Drop to add to this folder' : state.tab === 'plugins' ? 'Drop plugin folders' : 'Drop .zip mods to add them to the server'));

// ---------- create / import ----------
async function importServer() {
  const dir = await chooseHostFolder('Choose an existing BeamMP server folder');
  if (!dir) return;
  const s = await guard(() => api.call('servers:import', dir), 'Server added');
  if (s) { await refreshServers(); select(s.id); }
}

function nextPort() {
  const used = new Set(state.servers.map((s) => Number(s.port)));
  let p = 30814;
  while (used.has(p)) p++;
  return p;
}

async function createServerDialog() {
  const defaultDir = await api.call('servers:defaultDir');
  if (!state.stock) state.stock = await api.call('content:stock').catch(() => null);
  const maps = state.stock?.maps || [];
  const gm = maps.find((m) => m.id === 'gridmap_v2') || maps[0];
  let selMap = gm ? { ...gm, source: 'stock' } : { title: 'Gridmap v2', mapPath: '/levels/gridmap_v2/info.json', source: 'stock' };
  const body = h(`<div style="display:flex;flex-direction:column;gap:14px">
    <div class="grid-2">
      <div class="field"><label>Server name</label><input class="input" id="nName" value="My BeamMP Server"></div>
      <div class="field"><label>Port</label><input class="input" id="nPort" type="number" value="${nextPort()}" min="1" max="65535"></div>
    </div>
    <div class="field"><label>Location</label><div class="input-group"><input class="input" id="nDir" value="${esc(defaultDir)}"><button class="btn" id="nBrowse">${icon('folder')}Browse</button></div>
      <span class="hint" id="nPathHint"></span></div>
    <div class="field"><label>Map</label><div class="map-choice" id="nMap"></div>
      <span class="hint">BeamNG maps and mod maps from your mods library. A mod map is added to the server automatically.</span></div>
    <div class="grid-2">
      <div class="field"><label>Max players</label><input class="input" id="nPlayers" type="number" value="8" min="1"></div>
      <div class="field"><label>Max cars per player</label><input class="input" id="nCars" type="number" value="1" min="0"></div>
    </div>
    <div class="field"><label>AuthKey <a id="nKeyLink" style="font-weight:500">(get one free)</a></label><input class="input mono" id="nKey" type="password" placeholder="Optional now, required to start"></div>
    <div class="toggle-row"><div><div class="t-title">Private server</div><div class="t-sub">Not listed publicly; friends join with your IP</div></div><label class="switch"><input type="checkbox" id="nPrivate"><span class="track"></span></label></div>
    <div class="toggle-row"><div><div class="t-title">Download BeamMP-Server.exe</div><div class="t-sub">Latest official release from GitHub</div></div><label class="switch"><input type="checkbox" id="nDl" checked><span class="track"></span></label></div>
    <div id="nProgressBox" class="hidden"><div class="faint" id="createStatus" style="margin-bottom:8px">Creating server…</div><div class="progress indeterminate" id="createProgress"><div></div></div></div>
  </div>`);
  const updHint = () => { $('#nPathHint', body).textContent = 'Server folder: ' + ($('#nDir', body).value.replace(/[\\/]+$/, '') + '\\' + $('#nName', body).value.replace(/[<>:"/\\|?*]/g, '').trim()); };
  $('#nName', body).oninput = updHint;
  $('#nDir', body).oninput = updHint;
  updHint();
  $('#nBrowse', body).onclick = async () => { const d = await chooseHostFolder('Where should the server folder be created?'); if (d) { $('#nDir', body).value = d; updHint(); } };
  $('#nKeyLink', body).onclick = () => api.call('ui:openExternal', KEYMASTER);
  const drawMap = () => {
    $('#nMap', body).innerHTML = `${thumbHtml(selMap.thumb, 'map')}<div class="grow"><div style="font-weight:700">${esc(selMap.title)}</div>
      <div class="faint" style="font-size:12px">${selMap.source === 'stock' ? 'BeamNG map' : `Mod map · ${esc(selMap.modFile?.split(/[\\/]/).pop() || '')}`}</div></div>
      <button class="btn sm">${icon('image')}Choose map</button>`;
  };
  drawMap();
  $('#nMap', body).onclick = async () => {
    const r = await pickMapModal(selMap.mapPath);
    if (r) { selMap = r; drawMap(); }
  };

  const result = await modal({
    title: 'Create a new server',
    body,
    wide: true,
    dismissable: true,
    actions: [{ label: 'Cancel', value: null }, {
      label: 'Create server', primary: true, icon: 'plus',
      onClick: async (b) => {
        const opts = {
          name: $('#nName', b).value.trim() || 'BeamMP Server',
          parentDir: $('#nDir', b).value.trim(),
          port: Number($('#nPort', b).value),
          maxPlayers: Number($('#nPlayers', b).value),
          maxCars: Number($('#nCars', b).value),
          map: selMap ? selMap.mapPath : undefined,
          authKey: $('#nKey', b).value.trim(),
          isPrivate: $('#nPrivate', b).checked,
          download: $('#nDl', b).checked,
        };
        $('#nProgressBox', b).classList.remove('hidden');
        $('#createStatus', b).textContent = opts.download ? 'Creating folder and downloading BeamMP-Server.exe…' : 'Creating server…';
        try {
          const created = await api.call('servers:create', opts);
          if (selMap.source === 'library' && selMap.modFile) {
            $('#createStatus', b).textContent = 'Adding the map mod to the server…';
            await api.call('mods:addHost', created.id, [selMap.modFile]);
          }
          return created;
        } catch (e) {
          $('#nProgressBox', b).classList.add('hidden');
          toast(e.message, 'error', 'Could not create server');
          await refreshServers();
          return false;
        }
      },
    }],
  });
  if (result) {
    toast(`${result.name} is ready`, 'success', 'Server created');
    await refreshServers();
    select(result.id);
  }
}

// ---------- app settings ----------
async function appSettingsDialog() {
  const [settings, gameDir, modsDir, defaultDir, libDir] = await Promise.all([
    api.call('settings:get'), api.call('content:gameDir'), api.call('content:modsDir'), api.call('servers:defaultDir'), api.call('library:dir'),
  ]);
  const folderField = (id, label, value, hint) => `<div class="field"><label>${label}</label><div class="input-group"><input class="input" id="${id}" value="${esc(value || '')}" placeholder="Auto-detect"><button class="btn" data-browse="${id}" title="Browse">${icon('folder')}</button></div><span class="hint" data-hint="${id}">${hint}</span></div>`;
  const det = (p, miss) => (p ? `<span style="color:var(--green)">✓ Auto-detected:</span> ${esc(p)}` : `<span style="color:var(--yellow)">Not found automatically.</span> ${miss}`);
  const r = await modal({
    title: REMOTE.connected ? `App settings on ${REMOTE.hostName || REMOTE.host}` : 'App settings',
    body: `
      <div class="toggle-row"><div><div class="t-title">Auto-detect BeamNG</div><div class="t-sub">Finds the game through Steam libraries, BeamNG's own settings file and common folders</div></div><button class="btn sm primary" id="sDetect">${icon('search')}Auto-detect</button></div>
      ${folderField('sGame', 'BeamNG.drive install folder', settings.beamngPath, det(gameDir, 'Set it to show stock maps and vehicles with photos.'))}
      ${folderField('sMods', 'Your BeamNG mods folder', settings.modsPath, det(modsDir, 'Fine if BeamNG isn\'t installed here: the central mods library below is used instead.'))}
      ${folderField('sLib', `Central mods library${gameDir ? '' : ' <span class="pill accent" style="height:20px;font-size:11px">used because BeamNG isn\'t installed</span>'}`, settings.libraryPath, `Currently: ${esc(libDir)}. Mods and tracks from every server are collected here automatically.`)}
      <div class="toggle-row"><div><div class="t-title">Collect mods from all servers now</div><div class="t-sub">Copies any server mod or track that isn't in the central library yet</div></div><button class="btn sm" id="sCollect">${icon('download')}Collect</button></div>
      ${folderField('sServers', 'Default folder for new servers', settings.serversDir, `Currently: ${esc(defaultDir)}`)}
      <div class="toggle-row"><div><div class="t-title">Rescan BeamNG content</div><div class="t-sub">Reload stock maps, vehicles and photos (after a game update)</div></div><button class="btn sm" id="sRescan">${icon('refresh')}Rescan</button></div>`,
    actions: [{ label: 'Cancel', value: null }, {
      label: 'Save', primary: true,
      onClick: (b) => ({ beamngPath: $('#sGame', b).value.trim(), modsPath: $('#sMods', b).value.trim(), serversDir: $('#sServers', b).value.trim(), libraryPath: $('#sLib', b).value.trim() }),
    }],
    onMount: (b) => {
      $('#sCollect', b).onclick = async (e) => {
        const btn = e.currentTarget;
        btn.innerHTML = '<div class="spinner"></div>Collecting…';
        const added = await guard(() => api.call('library:syncAll'));
        btn.innerHTML = icon('check') + (added?.length ? `${added.length} added` : 'Up to date');
      };
      for (const btn of $$('[data-browse]', b)) btn.onclick = async () => { const d = await chooseHostFolder(); if (d) $('#' + btn.dataset.browse, b).value = d; };
      $('#sDetect', b).onclick = async (e) => {
        const btn = e.currentTarget;
        btn.innerHTML = '<div class="spinner"></div>Detecting…';
        // Clear manual overrides, then ask the detector again.
        await api.call('settings:set', { beamngPath: '', modsPath: '' });
        const [g, m] = await Promise.all([api.call('content:gameDir'), api.call('content:modsDir')]);
        $('#sGame', b).value = '';
        $('#sMods', b).value = '';
        $('[data-hint="sGame"]', b).innerHTML = det(g, 'Browse to your BeamNG.drive folder.');
        $('[data-hint="sMods"]', b).innerHTML = det(m, 'Browse to your BeamNG mods folder.');
        btn.innerHTML = icon('check') + (g && m ? 'Found both' : g || m ? 'Found one' : 'Not found');
        toast(g ? `BeamNG found: ${g}` : 'BeamNG.drive was not found automatically', g ? 'success' : 'error');
      };
      $('#sRescan', b).onclick = async (e) => {
        e.currentTarget.innerHTML = '<div class="spinner"></div>Scanning…';
        state.stock = await guard(() => api.call('content:stock', true), 'BeamNG content rescanned');
        e.target.closest('button') && (e.target.closest('button').innerHTML = icon('check') + 'Done');
      };
    },
  });
  if (!r) return;
  const norm = (p) => String(p || '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
  const newLib = r.libraryPath;
  delete r.libraryPath;
  if (newLib !== (settings.libraryPath || '') && norm(newLib) !== norm(libDir)) {
    const count = await api.call('library:count', libDir);
    const ok = await confirmBox('Move mods library?',
      `${count} item${count === 1 ? '' : 's'} will be moved from\n${libDir}\nto\n${newLib || 'the default folder (Documents\\Redline Mods Library)'}\n\nThe old folder is deleted once everything has moved.`, { ok: 'Move library' });
    if (ok) {
      toast('Moving your mods library…', 'info');
      const m = await guard(() => api.call('library:move', newLib));
      if (m) {
        toast(`Moved ${m.moved} item${m.moved === 1 ? '' : 's'} to ${m.newDir}${m.oldRemoved ? ' and removed the old folder' : ''}`, 'success', 'Library moved');
        if (m.skipped.length) toast(`Left in the old folder (a file with the same name already exists in the new one): ${m.skipped.join(', ')}`, 'error');
      }
    }
  }
  await guard(() => api.call('settings:set', r), 'Settings saved');
  state.stock = await api.call('content:stock').catch(() => state.stock);
  renderMain();
}

// ---------- map browser pop-up (BeamNG maps + mod maps) ----------
async function pickMapModal(currentPath, serverId) {
  if (!state.stock) state.stock = await api.call('content:stock').catch(() => ({ maps: [] }));
  const items = state.stock.maps.map((m) => ({ ...m, source: 'stock' }));
  let filter = 'all';
  let q = '';
  let libLoading = true;
  const cur = String(currentPath || '').toLowerCase();
  return modal({
    title: 'Choose a map',
    wide: true,
    body: `<div class="toolbar" style="margin:0">
        <div class="search">${icon('search')}<input class="input" id="mpQ" placeholder="Search maps"></div>
        <div class="chips" id="mpChips"></div></div>
      <div class="mp-grid" id="mpGrid"></div>`,
    actions: [{ label: 'Cancel', value: null }],
    onMount: (b, close) => {
      const draw = () => {
        const counts = { all: items.length, stock: items.filter((i) => i.source === 'stock').length, mods: items.filter((i) => i.source !== 'stock').length };
        $('#mpChips', b).innerHTML = [['all', 'All', 'layers'], ['stock', 'BeamNG', 'map'], ['mods', 'Mod maps', 'puzzle']]
          .map(([k, l, ic]) => `<span class="chip ${filter === k ? 'on' : ''}" data-f="${k}">${icon(ic)}${l} <span class="faint">${counts[k]}${k !== 'stock' && libLoading ? '…' : ''}</span></span>`).join('');
        for (const c of $$('[data-f]', b)) c.onclick = () => { filter = c.dataset.f; draw(); };
        const shown = items.filter((m) => (filter === 'all' || (filter === 'stock' ? m.source === 'stock' : m.source !== 'stock'))
          && (!q || `${m.title} ${m.id} ${m.modFile || ''}`.toLowerCase().includes(q)));
        $('#mpGrid', b).innerHTML = shown.map((m, i) => `
          <div class="mp-card ${m.mapPath.toLowerCase() === cur ? 'sel' : ''}" data-i="${items.indexOf(m)}" style="animation-delay:${Math.min(i, 20) * 18}ms">
            ${thumbHtml(m.thumb, 'map')}
            <div class="tag">${m.source === 'stock' ? '<span class="pill">BeamNG</span>' : `<span class="pill blue">${m.source === 'server' ? 'On server' : 'Your mod'}</span>`}</div>
            <div class="n ellipsis">${esc(m.title)}</div><div class="s ellipsis">${m.source === 'stock' ? esc(m.id) : esc(m.modFile.split(/[\\/]/).pop())}</div>
          </div>`).join('')
          + (libLoading && filter !== 'stock' ? `<div class="row faint" style="grid-column:1/-1;padding:10px"><div class="spinner"></div>Loading mod maps from your mods library…</div>` : '')
          || `<div class="empty" style="grid-column:1/-1">${icon('map')}<div>No maps match</div></div>`;
        for (const c of $$('[data-i]', b)) c.onclick = () => close(items[Number(c.dataset.i)]);
      };
      $('#mpQ', b).oninput = (e) => { q = e.target.value.toLowerCase(); draw(); };
      draw();
      (async () => {
        const seen = new Set(items.map((i) => i.mapPath.toLowerCase()));
        if (serverId) {
          const mods = await api.call('mods:details', serverId).catch(() => []);
          for (const m of mods) for (const mp of m.maps || []) if (!seen.has(mp.mapPath.toLowerCase())) { seen.add(mp.mapPath.toLowerCase()); items.push({ ...mp, source: 'server', modFile: m.file }); }
        }
        const lib = await api.call('mods:library').catch(() => ({ mods: [] }));
        for (const m of lib.mods) for (const mp of m.maps || []) if (!seen.has(mp.mapPath.toLowerCase())) { seen.add(mp.mapPath.toLowerCase()); items.push({ ...mp, source: 'library', modFile: m.file }); }
        libLoading = false;
        if (document.body.contains(b)) draw();
      })();
    },
  });
}

// ---------- remote management ----------
async function remoteDialog() {
  const [client, host] = await Promise.all([api.call('remote:clientStatus'), api.call('remote:hostStatus').catch(() => null)]);
  const hostCard = host ? `
    <div class="card" style="display:flex;flex-direction:column;gap:12px">
      <h3>${icon('server')}Let other computers control this PC</h3>
      <div class="toggle-row"><div><div class="t-title">Allow remote control</div><div class="t-sub">Devices on the same home network can manage these servers with the password</div></div>
        <label class="switch"><input type="checkbox" id="rhOn" ${host.enabled ? 'checked' : ''}><span class="track"></span></label></div>
      <div class="grid-2">
        <div class="field"><label>Port</label><input class="input" id="rhPort" type="number" value="${esc(host.port)}"></div>
        <div class="field"><label>Password ${host.hasPassword ? '<span class="faint">(leave blank to keep)</span>' : ''}</label><input class="input" id="rhPw" type="password" placeholder="${host.hasPassword ? '••••••••' : 'At least 4 characters'}"></div>
      </div>
      <div id="rhStatus"></div>
      <div class="row"><div class="grow"></div><button class="btn primary sm" id="rhSave">${icon('check')}Apply</button></div>
    </div>` : '';
  const clientCard = `
    <div class="card" style="display:flex;flex-direction:column;gap:12px">
      <h3>${icon('globe')}Control another computer</h3>
      ${client.connected
        ? `<div class="banner-msg warn" style="margin:0;background:var(--blue-soft);border-color:rgba(77,163,255,.35);color:#a9d1ff">${icon('wifi')}<div class="grow">Connected to <b>${esc(client.hostName || client.host)}</b><small>${esc(client.host)}:${esc(client.port)} · everything you see is loaded from that computer</small></div><button class="btn sm danger" id="rcOff">Disconnect</button></div>`
        : `${client.recents?.length ? `<div class="field"><label>Recent connections</label><div class="list">${client.recents.map((r, i) => `
            <div class="lrow clickable" data-recent="${i}">
              <div class="ic-box">${icon('server')}</div>
              <div class="grow"><div class="t">${esc(r.hostName || r.host)}</div><div class="s mono">${esc(r.host)}:${esc(r.port)} · last used ${new Date(r.lastUsed).toLocaleString()}${r.savedPassword ? ' · password saved' : ''}</div></div>
              <button class="btn sm primary" data-rconnect="${i}">${icon('send')}${r.savedPassword ? 'Connect' : 'Use'}</button>
              <button class="btn sm icon ghost" data-rforget="${i}" title="Forget">${icon('x')}</button>
            </div>`).join('')}</div></div>` : ''}
          <div class="grid-3">
            <div class="field"><label>Host IP address</label><input class="input mono" id="rcHost" placeholder="e.g. 192.168.1.50" value="${esc(client.last?.host || '')}"></div>
            <div class="field"><label>Port</label><input class="input mono" id="rcPort" type="number" value="${esc(client.last?.port || client.defaultPort)}"></div>
            <div class="field"><label>Password</label><input class="input" id="rcPw" type="password"></div>
          </div>
          <div class="row">
            ${client.canRemember ? `<label class="row" style="gap:8px;cursor:pointer"><label class="switch"><input type="checkbox" id="rcRemember"><span class="track"></span></label><span style="font-size:13px">Remember password</span></label>` : ''}
            <div class="grow"></div><button class="btn primary sm" id="rcGo">${icon('send')}Connect</button></div>
          <div class="faint" style="font-size:12px">Nothing from the host is stored on this computer; servers, files and photos load from the host. A remembered password is encrypted for your Windows account only.</div>`}
    </div>`;
  await modal({
    title: 'Remote management',
    wide: true,
    body: `${client.connected ? '' : hostCard}${clientCard}`,
    actions: [{ label: 'Close', value: null }],
    onMount: (b, close) => {
      const showHost = (st) => {
        const box = $('#rhStatus', b);
        if (!box) return;
        if (!st.enabled) { box.innerHTML = '<div class="faint" style="font-size:12px">Remote control is off.</div>'; return; }
        if (!st.running) { box.innerHTML = `<div class="banner-msg err" style="margin:0">${icon('alert')}<div class="grow">Not running<small>${esc(st.error || 'Check the port and password')}</small></div></div>`; return; }
        const addr = st.addresses[0] || 'this PC';
        box.innerHTML = `<div class="net-grid">
            <div class="net-item"><div><div class="k">On the other computer, enter</div><div class="v big">${esc(addr)} : ${esc(st.port)}</div></div><button class="btn sm icon ghost" data-copy="${esc(addr)}">${icon('copy')}</button></div>
            <div class="net-item"><div><div class="k">Connected now</div><div class="v">${st.clients.length ? st.clients.map((c) => esc(c.name || c.ip)).join(', ') : 'Nobody'}</div></div></div>
          </div>${st.addresses.length > 1 ? `<div class="faint" style="font-size:12px;margin-top:6px">Other addresses: ${st.addresses.slice(1).map(esc).join(', ')}</div>` : ''}
          <div class="faint" style="font-size:12px;margin-top:6px">If it can't connect, allow Redline through Windows Firewall when Windows asks (Private networks).</div>`;
        for (const c of $$('[data-copy]', box)) c.onclick = () => { api.call('ui:copy', c.dataset.copy); toast('Copied', 'success'); };
      };
      if (host) showHost(host);
      $('#rhSave', b) && ($('#rhSave', b).onclick = async () => {
        const st = await guard(() => api.call('remote:hostSet', { enabled: $('#rhOn', b).checked, port: Number($('#rhPort', b).value), password: $('#rhPw', b).value }));
        if (st) { $('#rhPw', b).value = ''; showHost(st); toast(st.running ? 'Remote control is on' : 'Remote control is off', 'success'); }
        else showHost(await api.call('remote:hostStatus'));
      });
      $('#rcOff', b) && ($('#rcOff', b).onclick = () => { close(null); api.call('remote:disconnect'); });
      $('#rcGo', b) && ($('#rcGo', b).onclick = async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.innerHTML = '<div class="spinner"></div>Connecting…';
        const ok = await guard(() => api.call('remote:connect', $('#rcHost', b).value.trim(), Number($('#rcPort', b).value), $('#rcPw', b).value, $('#rcRemember', b)?.checked || false));
        if (ok) { toast(`Connected to ${ok.hostName}`, 'success'); close(null); return; }
        btn.disabled = false;
        btn.innerHTML = icon('send') + 'Connect';
      });
      $('#rcPw', b) && ($('#rcPw', b).onkeydown = (e) => { if (e.key === 'Enter') { e.stopPropagation(); $('#rcGo', b).click(); } });
      const fill = (r) => { $('#rcHost', b).value = r.host; $('#rcPort', b).value = r.port; $('#rcPw', b).value = ''; $('#rcPw', b).focus(); };
      for (const row of $$('[data-recent]', b)) {
        const r = client.recents[Number(row.dataset.recent)];
        row.onclick = (e) => { if (!e.target.closest('button')) fill(r); };
      }
      for (const btn of $$('[data-rconnect]', b)) btn.onclick = async () => {
        const r = client.recents[Number(btn.dataset.rconnect)];
        if (!r.savedPassword) { fill(r); toast('Enter the password to connect'); return; }
        btn.disabled = true;
        btn.innerHTML = '<div class="spinner"></div>';
        const ok = await guard(() => api.call('remote:connectRecent', r.host, r.port));
        if (ok) { toast(`Connected to ${ok.hostName}`, 'success'); close(null); return; }
        btn.disabled = false;
        btn.innerHTML = icon('send') + 'Connect';
        fill(r);
      };
      for (const btn of $$('[data-rforget]', b)) btn.onclick = async () => {
        const r = client.recents[Number(btn.dataset.rforget)];
        await api.call('remote:forgetRecent', r.host, r.port);
        btn.closest('.lrow').remove();
        toast(`Forgot ${r.hostName || r.host}`, 'success');
      };
    },
  });
}
