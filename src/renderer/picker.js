// Content Browser window: pick maps, switch vehicles on/off, add/remove mods.
const params = new URLSearchParams(location.search);
const P = {
  server: params.get('server'),
  tab: params.get('tab') || 'maps',
  servers: [],
  stock: null,
  mods: [],
  meta: { blockedVehicles: [] },
  config: null,
  library: null,
  vehCat: 'all',
  q: '',
};
const SEG = { maps: ['map', 'Maps'], vehicles: ['car', 'Vehicles'], mods: ['box', 'Mods'] };
const CATS = [['all', 'All', 'layers'], ['car', 'Cars', 'car'], ['truck', 'Trucks & buses', 'truck'], ['trailer', 'Trailers', 'trailer'], ['prop', 'Props', 'cone'], ['other', 'Other', 'box'], ['mod', 'Mod vehicles', 'puzzle']];

$('#tbLogo').innerHTML = LOGO;
for (const el of $$('.seg-item')) {
  const [ic, label] = SEG[el.dataset.tab];
  el.innerHTML = `${icon(ic)}${label}<span class="n" data-n="${el.dataset.tab}"></span>`;
  el.onclick = () => setTab(el.dataset.tab);
}
$('#q').oninput = (e) => { P.q = e.target.value.toLowerCase(); render(); };
$('#serverSel').onchange = (e) => { P.server = e.target.value; load(); };

api.on('picker:open', ({ server, tab }) => { const changed = server !== P.server; P.server = server; setTab(tab, true); if (changed) load(); });
api.on('server:changed', debounce(() => reloadServerData(), 300));
api.on('content:progress', (p) => {
  if (p.kind === 'library') {
    const lb = $('#libLabel');
    if (lb) lb.textContent = `Reading your mods library… ${p.done + 1} of ${p.total} (${p.label})`;
    return;
  }
  const el = $('#scanProgress');
  if (el) { el.firstElementChild.style.width = (p.done / Math.max(1, p.total)) * 100 + '%'; el.classList.remove('indeterminate'); $('#scanLabel').textContent = `Reading ${p.label} (${p.done}/${p.total})`; }
});

function moveSegInk() {
  const a = $('.seg-item.active');
  const ink = $('#segInk');
  if (!a || !ink) return;
  ink.style.left = a.offsetLeft + 'px';
  ink.style.width = a.offsetWidth + 'px';
}
window.addEventListener('resize', moveSegInk);
document.fonts.ready.then(moveSegInk);

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function setTab(tab, silent) {
  P.tab = SEG[tab] ? tab : 'maps';
  $$('.seg-item').forEach((el) => el.classList.toggle('active', el.dataset.tab === P.tab));
  moveSegInk();
  $('#q').placeholder = `Search ${SEG[P.tab][1].toLowerCase()}…`;
  if (!P.library) loadLibrary();
  render();
}

async function load() {
  P.servers = await api.call('servers:list');
  if (!P.servers.find((s) => s.id === P.server)) P.server = P.servers[0]?.id;
  $('#serverSel').innerHTML = P.servers.map((s) => `<option value="${s.id}" ${s.id === P.server ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  const s = P.servers.find((x) => x.id === P.server);
  $('#tbServer').textContent = s ? `· ${s.name}` : '';
  if (!P.stock) {
    $('#body').innerHTML = `<div class="scan-box"><div style="font-weight:700;color:var(--text)">Loading BeamNG content…</div><div class="faint" id="scanLabel">Finding your BeamNG.drive install</div><div class="progress indeterminate" id="scanProgress"><div></div></div><div class="faint" style="font-size:12px">First time only. Photos are cached after this.</div></div>`;
    P.stock = await api.call('content:stock').catch(() => ({ vehicles: [], maps: [], fallback: true }));
  }
  await reloadServerData();
  loadThisPc();
}

async function reloadServerData() {
  if (!P.server) { render(); return; }
  const id = P.server;
  const [mods, meta, config] = await Promise.all([
    api.call('mods:details', id).catch(() => []),
    api.call('meta:read', id).catch(() => ({ blockedVehicles: [] })),
    api.call('config:read', id).catch(() => null),
  ]);
  if (id !== P.server) return;
  Object.assign(P, { mods, meta, config });
  // Don't clobber vehicle toggles that are still waiting to be saved.
  if (!P.blockedDirty) P.blocked = new Set(meta.blockedVehicles);
  render();
}

async function loadLibrary() {
  P.library = { loading: true, mods: [] };
  P.library = await api.call('mods:library').catch(() => ({ dir: null, mods: [] }));
  render();
}

// ---- "This PC": the remote computer's own BeamNG mods (only while controlling a host) ----
async function loadThisPc() {
  await remoteReady;
  if (!REMOTE.connected || P.thisPc) return;
  P.thisPc = { loading: true, mods: [] };
  render();
  P.thisPc = await api.call('local:library').catch(() => ({ dir: null, mods: [] }));
  render();
}

// kind: 'map' | 'vehicle' | 'mod'. Returns a section listing This PC's items not yet on the server.
function thisPcSection(kind) {
  if (!REMOTE.connected || !P.thisPc) return '';
  const onServer = new Set(P.mods.map((m) => m.fileName.toLowerCase()));
  const mods = P.thisPc.mods.filter((m) => !onServer.has(m.fileName.toLowerCase()));
  let items;
  if (kind === 'map') items = mods.flatMap((m) => (m.maps || []).map((x) => ({ title: x.title, thumb: x.thumb, sub: m.fileName, mod: m, mapPath: x.mapPath })));
  else if (kind === 'vehicle') items = mods.flatMap((m) => (m.vehicles || []).map((x) => ({ title: x.name, thumb: x.thumb, sub: m.fileName, mod: m })));
  else items = mods.map((m) => ({ title: m.title, thumb: m.thumb, sub: `${fmtBytes(m.size)}${m.kind !== 'other' ? ' · ' + m.kind : ''}`, mod: m }));
  items = items.filter((i) => match(i.title, i.sub));
  const title = { map: 'Mod maps on this PC', vehicle: 'Mod vehicles on this PC', mod: 'Mods on this PC' }[kind];
  const head = `<div class="sec-title">${icon('upload')}${title} <span class="pill blue">${P.thisPc.loading ? '…' : items.length}</span><span class="faint" style="text-transform:none;letter-spacing:0;font-weight:500">uploaded to the host when added</span></div>`;
  if (P.thisPc.loading) return head + '<div class="row faint"><div class="spinner"></div>Reading this PC\'s BeamNG mods folder…</div>';
  if (!P.thisPc.dir) return head + '<div class="faint">No BeamNG mods folder found on this PC.</div>';
  if (!items.length) return head + `<div class="faint">Nothing on this PC that isn't already on the server.</div>`;
  const small = kind === 'vehicle';
  return head + `<div class="cgrid ${small ? 'small' : ''}">${items.map((it, i) => `
    <div class="ccard" style="animation-delay:${Math.min(i, 24) * 18}ms">
      ${thumbHtml(it.thumb, kind === 'map' ? 'map' : kind === 'vehicle' ? 'car' : 'box')}
      <div class="tag"><span class="pill blue">This PC</span></div>
      <div class="meta row"><div class="grow"><div class="t ellipsis">${esc(it.title)}</div><div class="s ellipsis">${esc(it.sub)}</div></div>
        <button class="btn sm primary" data-pcup="${esc(it.mod.file)}" ${it.mapPath ? `data-pcmap="${esc(it.mapPath)}"` : ''} title="Upload to the host server">${icon('upload')}${small ? '' : kind === 'map' ? 'Upload & use' : 'Upload'}</button></div>
    </div>`).join('')}</div>`;
}

function bindThisPc(root) {
  for (const b of $$('[data-pcup]', root)) {
    b.onclick = async (e) => {
      e.stopPropagation();
      b.disabled = true;
      b.innerHTML = '<div class="spinner" style="width:14px;height:14px"></div>';
      const r = await guard(() => api.call('mods:add', P.server, [b.dataset.pcup]));
      if (r?.added?.length) toast(`Uploaded ${r.added[0]} to the host${r.restartNeeded ? ' · restart the server to apply' : ''}`, 'success');
      await reloadServerData();
      if (r && b.dataset.pcmap) setMap(b.dataset.pcmap);
    };
  }
}

// Mods in the user's BeamNG mods folder that aren't on this server yet.
function libraryNotOnServer() {
  const onServer = new Set(P.mods.map((m) => m.fileName.toLowerCase()));
  return (P.library?.mods || []).filter((m) => !onServer.has(m.fileName.toLowerCase()));
}

const libSection = (title, ic, count) => `<div class="sec-title">${icon(ic)}${title} <span class="pill">${P.library?.loading ? '…' : count}</span></div>`;
const libLoadingRow = () => `<div class="row faint"><div class="spinner"></div><span id="libLabel">Reading your mods library… (first time can take a minute, photos are cached after)</span></div>`;

async function addLibraryMod(file, btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner" style="width:14px;height:14px"></div>'; }
  const r = await guard(() => api.call('mods:addHost', P.server, [file]));
  if (r?.added?.length) toast(`Added ${r.added[0]} to the server${r.restartNeeded ? ' · restart to apply' : ''}`, 'success');
  await reloadServerData();
  return !!r;
}

const match = (...fields) => !P.q || fields.join(' ').toLowerCase().includes(P.q);
const serverObj = () => P.servers.find((s) => s.id === P.server);

function render() {
  const body = $('#body');
  if (!P.stock) return;
  if (!P.server) {
    body.innerHTML = `<div class="empty">${icon('server')}<div>Create a server in the main window first.</div></div>`;
    $('#sub').innerHTML = ''; $('#foot').innerHTML = '';
    return;
  }
  const modMaps = P.mods.flatMap((m) => (m.maps || []).map((mp) => ({ ...mp, mod: m })));
  const modVeh = P.mods.flatMap((m) => (m.vehicles || []).map((v) => ({ ...v, mod: m, category: 'mod' })));
  const lib = libraryNotOnServer();
  const libMaps = lib.flatMap((m) => (m.maps || []).map((mp) => ({ ...mp, lib: m })));
  const libVeh = lib.flatMap((m) => (m.vehicles || []).map((v) => ({ ...v, lib: m })));
  $('[data-n="maps"]').textContent = P.stock.maps.length + modMaps.length + libMaps.length;
  $('[data-n="vehicles"]').textContent = P.stock.vehicles.length + modVeh.length + libVeh.length;
  $('[data-n="mods"]').textContent = P.mods.length;
  moveSegInk();
  const scroll = body.scrollTop;
  ({ maps: renderMaps, vehicles: renderVehicles, mods: renderModsTab })[P.tab](body, { modMaps, modVeh, libMaps, libVeh });
  body.scrollTop = scroll;
}

function fallbackNotice() {
  return P.stock.fallback ? `<div class="notice warn">${icon('alert')}<div>BeamNG.drive was not found on this PC, so stock content is shown without photos. Set the install folder in the main window's App settings.</div></div>` : '';
}

// ---------- maps ----------
function renderMaps(body, { modMaps, libMaps }) {
  const curPath = String(P.config?.General?.Map || '').toLowerCase();
  const isCur = (m) => m.mapPath.toLowerCase() === curPath;
  const card = (m, i, mod) => `
    <div class="ccard ${isCur(m) ? 'current' : ''}" data-map="${esc(m.mapPath)}" ${mod ? `data-modfile="${esc(mod.fileName)}"` : ''} style="animation-delay:${Math.min(i, 24) * 22}ms">
      ${thumbHtml(m.thumb, 'map')}
      <div class="tag">${mod ? `<span class="pill blue">Mod${mod.enabled ? '' : ' · not in use'}</span>` : '<span class="pill">BeamNG</span>'}</div>
      ${isCur(m) ? `<div class="badge-check">${icon('check')}</div>` : mod ? `<div class="corner hover-only"><button class="btn sm icon danger" data-rmmod="${esc(mod.fileName)}" title="Remove this map mod">${icon('trash')}</button></div>` : ''}
      <div class="meta"><div class="t ellipsis">${esc(m.title)}</div><div class="s ellipsis">${mod ? esc(mod.fileName) : esc(m.id)}${m.size && m.size[0] > 0 ? ` · ${m.size[0]}×${m.size[1]}` : ''}</div></div>
    </div>`;
  const stock = P.stock.maps.filter((m) => match(m.title, m.id));
  const mods = modMaps.filter((m) => match(m.title, m.id, m.mod.fileName));
  const cur = [...P.stock.maps, ...modMaps].find(isCur);
  $('#sub').innerHTML = `
    <button class="btn primary sm" id="addMap">${icon('plus')}Add map (.zip)</button>
    <button class="btn sm" id="customMap">${icon('edit')}Custom map path</button>
    <span class="faint" style="font-size:12px;margin-left:6px">Click a map to make it the server map.</span>`;
  body.innerHTML = `${fallbackNotice()}
    <div class="sec-title">${icon('map')}BeamNG maps <span class="pill">${stock.length}</span></div>
    <div class="cgrid">${stock.map((m, i) => card(m, i)).join('') || '<div class="faint">No matches</div>'}</div>
    <div class="sec-title">${icon('puzzle')}Mod maps on this server <span class="pill">${mods.length}</span></div>
    ${mods.length ? `<div class="cgrid">${mods.map((m, i) => card(m, i, m.mod)).join('')}</div>`
      : `<div class="empty" style="padding:24px">${icon('map')}<div>No mod maps on this server yet. Pick one from your BeamNG mods below, click "Add map (.zip)", or drop a map mod here.</div></div>`}
    ${libSection(REMOTE.connected ? "Mod maps in the host's library" : 'Mod maps in your mods library', 'download', libMaps.filter((m) => match(m.title, m.id, m.lib.fileName)).length)}
    ${P.library?.loading ? libLoadingRow() : !P.library?.dir ? `<div class="faint">Your BeamNG mods folder wasn't found. Use Auto-detect in App settings.</div>`
      : (() => {
        const lm = libMaps.filter((m) => match(m.title, m.id, m.lib.fileName));
        return lm.length ? `<div class="cgrid">${lm.map((m, i) => `
          <div class="ccard" data-libmap="${esc(m.lib.file)}" data-mappath="${esc(m.mapPath)}" style="animation-delay:${Math.min(i, 24) * 22}ms">
            ${thumbHtml(m.thumb, 'map')}
            <div class="tag"><span class="pill blue">Your mod</span></div>
            <div class="meta row"><div class="grow"><div class="t ellipsis">${esc(m.title)}</div><div class="s ellipsis">${esc(m.lib.fileName)} · ${fmtBytes(m.lib.size)}</div></div>
              <button class="btn sm primary">${icon('plus')}Add & use</button></div>
          </div>`).join('')}</div>` : `<div class="faint">No other map mods in your library. Drop downloaded tracks into the library folder to see them here.</div>`;
      })()}`;
  body.insertAdjacentHTML('beforeend', thisPcSection('map'));
  bindThisPc(body);
  $('#foot').innerHTML = `<span class="faint">Current map:</span><span class="foot-stat">${esc(cur ? cur.title : P.config?.General?.Map || 'none')}</span>
    ${cur ? '' : `<span class="pill crashed">${icon('alert')}Not found on this PC or in server mods</span>`}
    <div class="grow"></div><span class="saved-ind" id="savedInd">${icon('check')}Saved</span>
    ${serverObj()?.status === 'running' ? '<span class="pill stopping">Restart the server to change map</span>' : ''}`;

  $('#addMap').onclick = () => pickAndAddMods('Add map mods (.zip)');
  $('#customMap').onclick = async () => {
    const v = await promptBox('Custom map path', 'Map path used in ServerConfig.toml', P.config?.General?.Map || '/levels/gridmap_v2/info.json');
    if (v) setMap(v);
  };
  for (const c of $$('[data-map]', body)) {
    c.onclick = async (e) => {
      if (e.target.closest('[data-rmmod]')) return;
      // The host switches the chosen map's mod on and unused map mods off automatically.
      setMap(c.dataset.map);
    };
  }
  for (const c of $$('[data-libmap]', body)) {
    c.onclick = async () => {
      if (await addLibraryMod(c.dataset.libmap, $('button', c))) setMap(c.dataset.mappath);
    };
  }
  bindRemoveMod(body);
}

async function setMap(mapPath) {
  const r = await guard(() => api.call('config:write', P.server, { General: { Map: mapPath } }));
  if (!r) return;
  P.config = r;
  render();
  flashSaved();
  toast('Map updated', 'success');
}

function flashSaved() {
  const el = $('#savedInd');
  if (!el) return;
  el.classList.add('show');
  clearTimeout(flashSaved.t);
  flashSaved.t = setTimeout(() => el.classList.remove('show'), 1600);
}

// ---------- vehicles ----------
const saveBlockedNow = debounce(async () => {
  const r = await guard(() => api.call('vehicles:setBlocked', P.server, [...P.blocked]));
  P.blockedDirty = false;
  if (r) flashSaved();
}, 450);
function saveBlocked() {
  P.blockedDirty = true;
  saveBlockedNow();
}

function renderVehicles(body, { modVeh, libVeh }) {
  const all = [...P.stock.vehicles, ...modVeh];
  const inCat = (v) => P.vehCat === 'all' || v.category === P.vehCat;
  const shown = all.filter((v) => inCat(v) && match(v.name, v.model, v.brand, v.mod?.fileName || ''));
  const counts = Object.fromEntries(CATS.map(([k]) => [k, all.filter((v) => k === 'all' || v.category === k).length]));
  counts.mod += libVeh.length;
  $('#sub').innerHTML = `
    <div class="chips">${CATS.filter(([k]) => counts[k] || k === 'mod').map(([k, label, ic]) => `<span class="chip ${P.vehCat === k ? 'on' : ''}" data-cat="${k}">${icon(ic)}${label}<span class="n">${counts[k]}</span></span>`).join('')}</div>
    <div class="grow"></div>
    <button class="btn sm" id="vOn">${icon('check')}All shown on</button>
    <button class="btn sm" id="vOff">${icon('x')}All shown off</button>
    <button class="btn sm ghost" id="vReset">${icon('refresh')}Reset</button>
    <button class="btn primary sm" id="vAdd">${icon('plus')}Add vehicle (.zip)</button>`;
  const card = (v, i) => {
    const on = !P.blocked.has(v.model);
    return `<div class="ccard veh ${on ? 'on' : 'off'}" data-model="${esc(v.model)}" style="animation-delay:${Math.min(i, 30) * 15}ms">
      ${thumbHtml(v.thumb, 'car')}
      <div class="check">${icon('check')}</div>
      ${v.mod ? `<div class="tag"><span class="pill accent">Mod</span></div>` : ''}
      ${v.mod ? `<div class="corner hover-only" style="right:44px"><button class="btn sm icon danger" data-rmmod="${esc(v.mod.fileName)}" title="Remove this vehicle mod">${icon('trash')}</button></div>` : ''}
      <div class="meta"><div class="t ellipsis">${esc(v.name)}</div><div class="s ellipsis">${esc(v.model)}${v.type ? ' · ' + esc(v.type) : ''}${v.mod ? ' · ' + esc(v.mod.fileName) : ''}</div></div>
    </div>`;
  };
  body.innerHTML = `${fallbackNotice()}
    <div class="notice">${icon('info')}<div>Every stock vehicle is <b>on</b> by default. Click a vehicle to switch it off; players can't spawn vehicles that are off. Changes save automatically and apply instantly, even while the server is running.</div></div>
    ${shown.length ? `<div class="cgrid small">${shown.map(card).join('')}</div>`
      : `<div class="empty">${icon('car')}<div>${P.vehCat === 'mod' && !P.q ? 'No mod vehicles on this server yet. Add one from your BeamNG mods below, or drop a .zip here.' : 'No vehicles match'}</div></div>`}
    ${P.vehCat === 'all' || P.vehCat === 'mod' ? `
      ${libSection(REMOTE.connected ? "Mod vehicles in the host's library" : 'Mod vehicles in your mods library', 'download', libVeh.filter((v) => match(v.name, v.model, v.lib.fileName)).length)}
      ${P.library?.loading ? libLoadingRow() : !P.library?.dir ? `<div class="faint">Your BeamNG mods folder wasn't found. Use Auto-detect in App settings.</div>`
        : (() => {
          const lv = libVeh.filter((v) => match(v.name, v.model, v.lib.fileName));
          return lv.length ? `<div class="cgrid small">${lv.map((v, i) => `
            <div class="ccard" style="animation-delay:${Math.min(i, 30) * 15}ms">
              ${thumbHtml(v.thumb, 'car')}
              <div class="tag"><span class="pill accent">Your mod</span></div>
              <div class="meta row"><div class="grow"><div class="t ellipsis">${esc(v.name)}</div><div class="s ellipsis">${esc(v.lib.fileName)}</div></div>
                <button class="btn sm primary" data-addlibveh="${esc(v.lib.file)}" title="Add to server">${icon('plus')}</button></div>
            </div>`).join('')}</div>` : `<div class="faint">No other vehicle mods in your library.</div>`;
        })()}` : ''}`;
  for (const b of $$('[data-addlibveh]', body)) b.onclick = () => addLibraryMod(b.dataset.addlibveh, b);
  if (P.vehCat === 'all' || P.vehCat === 'mod') { body.insertAdjacentHTML('beforeend', thisPcSection('vehicle')); bindThisPc(body); }
  const updateFoot = () => {
    const allowed = all.filter((v) => !P.blocked.has(v.model)).length;
    $('#foot').innerHTML = `<span class="foot-stat"><b>${allowed}</b> of ${all.length} vehicles allowed</span><span class="faint">${P.blocked.size ? `${P.blocked.size} switched off` : 'Everything is allowed'}</span><div class="grow"></div><span class="saved-ind" id="savedInd">${icon('check')}Saved</span>`;
  };
  updateFoot();
  for (const c of $$('[data-cat]')) c.onclick = () => { P.vehCat = c.dataset.cat; render(); };
  for (const c of $$('[data-model]', body)) {
    c.onclick = (e) => {
      if (e.target.closest('[data-rmmod]')) return;
      const m = c.dataset.model;
      if (P.blocked.has(m)) P.blocked.delete(m); else P.blocked.add(m);
      const on = !P.blocked.has(m);
      c.classList.toggle('on', on);
      c.classList.toggle('off', !on);
      updateFoot();
      saveBlocked();
    };
  }
  const setShown = (on) => {
    for (const v of shown) { if (on) P.blocked.delete(v.model); else P.blocked.add(v.model); }
    render(); saveBlocked();
  };
  $('#vOn').onclick = () => setShown(true);
  $('#vOff').onclick = () => setShown(false);
  $('#vReset').onclick = async () => {
    if (!(await confirmBox('Reset vehicles?', 'Switch every vehicle back on?', { ok: 'Reset' }))) return;
    P.blocked.clear(); render(); saveBlocked();
  };
  $('#vAdd').onclick = () => pickAndAddMods('Add vehicle mods (.zip)');
  bindRemoveMod(body);
}

// ---------- mods ----------
function renderModsTab(body) {
  const onServer = new Set(P.mods.map((m) => m.fileName.toLowerCase()));
  const kindLabel = { map: 'Map', vehicle: 'Vehicle', mixed: 'Map + vehicles', other: 'Mod' };
  const kindCls = { map: 'blue', vehicle: 'accent', mixed: 'accent', other: '' };
  const desc = (m) => [m.vehicles?.length ? `${m.vehicles.length} vehicle${m.vehicles.length > 1 ? 's' : ''}` : '', m.maps?.length ? `${m.maps.length} map${m.maps.length > 1 ? 's' : ''}` : '', fmtBytes(m.size)].filter(Boolean).join(' · ');
  const serverMods = P.mods.filter((m) => match(m.title, m.fileName));
  const lib = (P.library?.mods || []).filter((m) => match(m.title, m.fileName));
  $('#sub').innerHTML = `
    <button class="btn primary sm" id="mAdd">${icon('plus')}Add .zip files</button>
    <span class="faint" style="font-size:12px;margin-left:6px">Or drag & drop mod zips anywhere in this window.</span>
    <div class="grow"></div>
    ${P.library?.dir ? `<button class="btn sm ghost" id="libOpen">${icon('folder')}Open mods library</button>` : ''}`;
  body.innerHTML = `
    ${serverObj()?.status === 'running' ? `<div class="notice warn">${icon('info')}<div>The server is running. Mod changes apply after a restart.</div></div>` : ''}
    <div class="sec-title">${icon('server')}On this server <span class="pill">${serverMods.length}</span></div>
    ${serverMods.length ? `<div class="cgrid">${serverMods.map((m, i) => `
      <div class="ccard ${m.enabled ? '' : 'disabled-mod'}" style="animation-delay:${Math.min(i, 24) * 22}ms">
        ${thumbHtml(m.thumb, m.kind === 'map' ? 'map' : m.kind === 'vehicle' ? 'car' : 'box')}
        <div class="tag"><span class="pill ${kindCls[m.kind] || ''}">${kindLabel[m.kind] || 'Mod'}</span></div>
        <div class="corner hover-only"><button class="btn sm icon danger" data-rmmod="${esc(m.fileName)}" title="Remove from server">${icon('trash')}</button></div>
        <div class="meta row"><div class="grow"><div class="t ellipsis">${esc(m.title)}</div><div class="s ellipsis">${esc(desc(m))}</div></div>
          <label class="switch" title="Enable / disable"><input type="checkbox" data-en="${esc(m.fileName)}" ${m.enabled ? 'checked' : ''}><span class="track"></span></label></div>
      </div>`).join('')}</div>`
      : `<div class="empty" style="padding:24px">${icon('box')}<div>No mods on this server yet.</div></div>`}
    <div class="sec-title">${icon('download')}${REMOTE.connected ? "Host's mods library" : 'Your mods library'} <span class="pill">${P.library?.loading ? '…' : lib.length}</span></div>
    ${P.library?.loading ? '<div class="row faint"><div class="spinner"></div><span id="libLabel">Reading your mods library… (first time can take a minute, photos are cached after)</span></div>'
      : !P.library?.dir ? `<div class="empty" style="padding:24px">${icon('folder')}<div>Your BeamNG mods folder was not found. Set it in App settings in the main window.</div></div>`
      : lib.length ? `<div class="cgrid">${lib.map((m, i) => {
        const has = onServer.has(m.fileName.toLowerCase());
        return `<div class="ccard" style="animation-delay:${Math.min(i, 24) * 22}ms">
          ${thumbHtml(m.thumb, m.kind === 'map' ? 'map' : m.kind === 'vehicle' ? 'car' : 'box')}
          <div class="tag"><span class="pill ${kindCls[m.kind] || ''}">${kindLabel[m.kind] || 'Mod'}</span></div>
          <div class="meta row"><div class="grow"><div class="t ellipsis">${esc(m.title)}</div><div class="s ellipsis">${esc(desc(m))}</div></div>
          ${has ? `<span class="pill running">${icon('check')}Added</span>` : `<button class="btn sm primary" data-addlib="${esc(m.file)}">${icon('plus')}Add</button>`}</div>
        </div>`;
      }).join('')}</div>` : `<div class="empty" style="padding:24px">${icon('box')}<div>No mod zips in ${esc(P.library.dir)}</div></div>`}`;
  const enabled = P.mods.filter((m) => m.enabled);
  $('#foot').innerHTML = `<span class="foot-stat"><b>${enabled.length}</b> enabled mod${enabled.length === 1 ? '' : 's'}</span><span class="faint">${fmtBytes(enabled.reduce((a, b) => a + b.size, 0))} for players to download</span>`;

  $('#mAdd').onclick = () => pickAndAddMods('Add BeamNG mods (.zip)');
  $('#libOpen') && ($('#libOpen').onclick = () => api.call('ui:openPath', P.library.dir));
  for (const t of $$('[data-en]', body)) t.onchange = async () => {
    const ok = await guard(() => api.call('mods:setEnabled', P.server, t.dataset.en, t.checked));
    if (ok === undefined) { t.checked = !t.checked; return; }
    const m = P.mods.find((x) => x.fileName === t.dataset.en);
    m.enabled = t.checked;
    t.closest('.ccard').classList.toggle('disabled-mod', !t.checked);
  };
  for (const b of $$('[data-addlib]', body)) b.onclick = () => addLibraryMod(b.dataset.addlib, b);
  body.insertAdjacentHTML('beforeend', thisPcSection('mod'));
  bindThisPc(body);
  bindRemoveMod(body);
}

function bindRemoveMod(root) {
  for (const b of $$('[data-rmmod]', root)) {
    b.onclick = async (e) => {
      e.stopPropagation();
      const file = b.dataset.rmmod;
      const mod = P.mods.find((m) => m.fileName === file);
      const extra = mod && (mod.vehicles?.length + mod.maps?.length > 1) ? `\n\nThis zip contains ${mod.vehicles.length} vehicle(s) and ${mod.maps.length} map(s); all of them will be removed.` : '';
      if (!(await confirmBox('Remove from server?', `${file} will be moved to the Recycle Bin.${extra}`, { danger: true, ok: 'Remove' }))) return;
      if (await guard(() => api.call('mods:remove', P.server, file), 'Removed') !== undefined) reloadServerData();
    };
  }
}

async function pickAndAddMods(title) {
  const files = await api.call('dialog:openFiles', { zip: true, title });
  if (files.length) addModFiles(files);
}

async function addModFiles(files) {
  if (!P.server) return;
  const r = await guard(() => api.call('mods:add', P.server, files));
  if (!r) return;
  if (r.added.length) toast(`${r.added.length} mod${r.added.length > 1 ? 's' : ''} added${r.restartNeeded ? ' · restart the server to apply' : ''}`, 'success');
  if (r.skipped.length) toast(`Only .zip mods can be added. Skipped: ${r.skipped.join(', ')}`, 'error');
  await reloadServerData();
}

enableFileDrop((paths) => addModFiles(paths), 'Drop .zip mods to add them to the server');

setTab(P.tab);
load();
