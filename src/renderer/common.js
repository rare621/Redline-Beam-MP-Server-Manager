// Shared UI helpers for both windows.
const ICONS = {
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  restart: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  terminal: '<path d="M4 17l6-6-6-6M12 19h8"/>',
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>',
  car: '<path d="M5 17h14v-5l-2-5H7l-2 5z"/><circle cx="7.5" cy="17.5" r="1.8"/><circle cx="16.5" cy="17.5" r="1.8"/><path d="M5 12h14"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  puzzle: '<path d="M9 3h3a2 2 0 1 1 4 0h3v5a2 2 0 1 1 0 4v5h-5a2 2 0 1 0-4 0H5v-5a2 2 0 1 0 0-4V3z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17.5v.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  wifi: '<path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r="1" fill="currentColor"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.8-4M4 4v4h4M4 13a8 8 0 0 0 14.8 4M20 20v-4h-4"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  chevron: '<path d="M9 18l6-6-6-6"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  send: '<path d="M4 12 20 4l-6 16-3-7z"/>',
  kick: '<path d="M16 11h6M10 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM2 21a8 8 0 0 1 14 0"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  trailer: '<rect x="2" y="6" width="15" height="9" rx="1"/><path d="M17 12h5"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="12" cy="17.5" r="1.8"/>',
  cone: '<path d="M12 3 6 19h12z"/><path d="M8.5 12h7M4 21h16"/>',
  truck: '<path d="M2 6h11v10H2zM13 10h4l4 4v2h-8"/><circle cx="6" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
};

function icon(name, cls = '') {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
}

const LOGO = "<svg class=\"logo\" xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\"><defs><linearGradient id=\"rl-bg\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\"><stop offset=\"0\" stop-color=\"#23262f\"/><stop offset=\"1\" stop-color=\"#0b0c10\"/></linearGradient><linearGradient id=\"rl-arc\" x1=\"0\" y1=\"1\" x2=\"1\" y2=\"0\"><stop offset=\"0\" stop-color=\"#ffb347\"/><stop offset=\"0.6\" stop-color=\"#ff6a1a\"/><stop offset=\"1\" stop-color=\"#ff2d55\"/></linearGradient><radialGradient id=\"rl-glow\" cx=\"0.72\" cy=\"0.5\" r=\"0.5\"><stop offset=\"0\" stop-color=\"#ff2d55\" stop-opacity=\"0.55\"/><stop offset=\"1\" stop-color=\"#ff2d55\" stop-opacity=\"0\"/></radialGradient><clipPath id=\"rl-clip\"><rect x=\"2\" y=\"2\" width=\"60\" height=\"60\" rx=\"16\"/></clipPath><filter id=\"rl-blur\" x=\"-50%\" y=\"-50%\" width=\"200%\" height=\"200%\"><feGaussianBlur stdDeviation=\"1.4\"/></filter></defs><rect x=\"2\" y=\"2\" width=\"60\" height=\"60\" rx=\"16\" fill=\"url(#rl-bg)\"/><rect x=\"2.5\" y=\"2.5\" width=\"59\" height=\"59\" rx=\"15.5\" fill=\"none\" stroke=\"#ffffff\" stroke-opacity=\"0.09\"/><circle cx=\"44\" cy=\"30\" r=\"20\" fill=\"url(#rl-glow)\" clip-path=\"url(#rl-clip)\"/><path d=\"M15.4 45 A19 19 0 1 1 48.6 45\" fill=\"none\" stroke=\"#ffffff\" stroke-opacity=\"0.1\" stroke-width=\"5\" stroke-linecap=\"round\"/><path d=\"M15.4 45 A19 19 0 0 1 48.45 26.5\" fill=\"none\" stroke=\"url(#rl-arc)\" stroke-width=\"5\" stroke-linecap=\"round\"/><path d=\"M48.45 26.5 A19 19 0 0 1 48.6 45\" fill=\"none\" stroke=\"#ff2d55\" stroke-width=\"5\" stroke-linecap=\"round\"/><line x1=\"32\" y1=\"36.5\" x2=\"47\" y2=\"29.5\" stroke=\"#ff2d55\" stroke-width=\"4\" stroke-linecap=\"round\" filter=\"url(#rl-blur)\" opacity=\"0.9\"/><line x1=\"32\" y1=\"36.5\" x2=\"47\" y2=\"29.5\" stroke=\"#ffffff\" stroke-width=\"2.6\" stroke-linecap=\"round\"/><circle cx=\"32\" cy=\"36.5\" r=\"4.2\" fill=\"#0b0c10\" stroke=\"#ffffff\" stroke-width=\"2.2\"/><circle cx=\"32\" cy=\"36.5\" r=\"1.4\" fill=\"#ff2d55\"/></svg>";

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i];
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  if (d) return `${d}d ${hh}h ${m}m`;
  if (hh) return `${hh}h ${m}m ${ss}s`;
  return `${m}m ${ss}s`;
}

// BeamMP uses ^0-^f / ^l ^n etc. for colors in names; strip them for display.
const stripCodes = (s) => String(s ?? '').replace(/\^[0-9a-fA-FlLmMnNoOrRpP]/g, '');

function thumbHtml(url, fallbackIcon = 'image', label = '') {
  const ph = label ? esc(label.slice(0, 2).toUpperCase()) : icon(fallbackIcon);
  return `<div class="thumb">${url ? `<img loading="lazy" src="${esc(url)}">` : ''}<div class="ph">${ph}</div></div>`;
}
// Fade images in once loaded (inline handlers are blocked by the CSP).
document.addEventListener('load', (e) => { if (e.target.tagName === 'IMG') e.target.classList.add('loaded'); }, true);
document.addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.remove(); }, true);

// ---------- toasts ----------
function toast(message, type = 'info', title) {
  let box = $('.toasts');
  if (!box) document.body.appendChild((box = h('<div class="toasts"></div>')));
  const ic = { success: 'check', error: 'alert', info: 'info' }[type] || 'info';
  const el = h(`<div class="toast ${type}">${icon(ic, 'ic')}<div class="msg">${title ? `<b>${esc(title)}</b>` : ''}${esc(message)}</div></div>`);
  box.appendChild(el);
  const remove = () => { el.classList.add('out'); setTimeout(() => el.remove(), 300); };
  setTimeout(remove, type === 'error' ? 7000 : 3800);
  el.addEventListener('click', remove);
}

async function guard(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg, 'success');
    return r;
  } catch (e) {
    toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error', 'Something went wrong');
    return undefined;
  }
}

// ---------- modals ----------
function modal({ title, body, actions = [], wide = false, onMount, dismissable = true }) {
  return new Promise((resolve) => {
    const back = h(`<div class="modal-back"><div class="modal ${wide ? 'wide' : ''}"><header><h2>${esc(title)}</h2></header><div class="body"></div><footer></footer></div></div>`);
    const bodyEl = $('.body', back);
    if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
    const close = (v) => {
      back.classList.add('out');
      document.removeEventListener('keydown', onKey);
      setTimeout(() => back.remove(), 200);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && dismissable) close(null);
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
        const primary = actions.find((a) => a.primary);
        if (primary) $$('footer .btn', back)[actions.indexOf(primary)].click();
      }
    };
    document.addEventListener('keydown', onKey);
    actions.forEach((a) => {
      const b = h(`<button class="btn ${a.cls || (a.primary ? 'primary' : '')}">${a.icon ? icon(a.icon) : ''}${esc(a.label)}</button>`);
      b.onclick = async () => {
        if (a.onClick) {
          b.disabled = true;
          const r = await a.onClick(bodyEl, close);
          b.disabled = false;
          if (r === false) return;
          if (r !== undefined) return close(r);
        }
        close(a.value !== undefined ? a.value : a.label);
      };
      $('footer', back).appendChild(b);
    });
    if (dismissable) back.addEventListener('mousedown', (e) => { if (e.target === back) close(null); });
    document.body.appendChild(back);
    onMount?.(bodyEl, close);
    setTimeout(() => $('input, textarea', bodyEl)?.focus(), 60);
  });
}

function confirmBox(title, message, { danger = false, ok = 'Confirm' } = {}) {
  return modal({
    title,
    body: `<div class="muted" style="white-space:pre-wrap">${esc(message)}</div>`,
    actions: [{ label: 'Cancel', value: false }, { label: ok, value: true, primary: !danger, cls: danger ? 'danger' : '' }],
  }).then((v) => v === true);
}

function promptBox(title, label, value = '') {
  return modal({
    title,
    body: `<div class="field"><label>${esc(label)}</label><input class="input" value="${esc(value)}"></div>`,
    actions: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, onClick: (b) => $('input', b).value.trim() || false }],
  });
}

// ripple feedback on every button
document.addEventListener('pointerdown', (e) => {
  const b = e.target.closest('.btn');
  if (!b) return;
  const r = b.getBoundingClientRect();
  const s = Math.max(r.width, r.height);
  const rip = h('<span class="ripple"></span>');
  Object.assign(rip.style, { width: s + 'px', height: s + 'px', left: e.clientX - r.left - s / 2 + 'px', top: e.clientY - r.top - s / 2 + 'px' });
  b.appendChild(rip);
  setTimeout(() => rip.remove(), 600);
});

// drag & drop of files from Explorer
function enableFileDrop(onFiles, label = 'Drop files to add') {
  let depth = 0;
  let overlay = null;
  const show = () => { if (!overlay) { overlay = h(`<div class="drop-overlay"><div>${icon('upload')}${esc(typeof label === 'function' ? label() : label)}</div></div>`); document.body.appendChild(overlay); } };
  const hide = () => { overlay?.remove(); overlay = null; depth = 0; };
  window.addEventListener('dragenter', (e) => { if (![...e.dataTransfer.types].includes('Files')) return; e.preventDefault(); depth++; show(); });
  window.addEventListener('dragleave', () => { if (--depth <= 0) hide(); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    hide();
    const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean);
    if (paths.length) onFiles(paths);
  });
}

// `api` is provided globally by the preload script (contextBridge).

// ---------- remote management (shared by both windows) ----------
const REMOTE = { connected: false };
const remoteReady = (async () => {
  try { Object.assign(REMOTE, await api.call('remote:clientStatus')); } catch { /* ignore */ }
  const bar = $('.titlebar');
  if (!bar || !REMOTE.connected) return;
  const badge = h(`<div id="remoteBadge" class="remote-badge no-drag"><span class="dot live"></span>Controlling <b>${esc(REMOTE.hostName || REMOTE.host)}</b><span class="faint">${esc(REMOTE.host)}:${esc(REMOTE.port)}</span><button class="btn sm ghost">${icon('x')}Disconnect</button></div>`);
  $('button', badge).onclick = () => api.call('remote:disconnect');
  bar.appendChild(badge);
})();
api.on('remote:state', (st) => {
  if (st.reconnecting) toast('Lost connection to the host, reconnecting…', 'error');
  else if (st.connected) toast('Reconnected to the host', 'success');
  else if (st.reason) toast(st.reason, 'error', 'Disconnected');
  $('#remoteBadge')?.classList.toggle('lost', !!st.reconnecting);
});
// Upload progress card (remote PC → host).
api.on('remote:upload', (u) => {
  let card = document.getElementById('up-' + u.id);
  if (!card) {
    card = h(`<div class="upload-card" id="up-${u.id}"><div class="row"><div class="up-ic">${icon('upload')}</div>
      <div class="grow"><div class="up-title">Uploading to host</div><div class="up-file ellipsis"></div></div><div class="up-pct"></div></div>
      <div class="progress"><div style="width:0%"></div></div><div class="up-meta"></div></div>`);
    document.body.appendChild(card);
  }
  const pct = u.total ? Math.min(100, (u.sent / u.total) * 100) : 0;
  const secs = (Date.now() - u.started) / 1000;
  const speed = secs > 0.3 ? u.sent / secs : 0;
  const eta = speed > 0 ? (u.total - u.sent) / speed : 0;
  card.querySelector('.progress > div').style.width = pct + '%';
  card.querySelector('.up-pct').textContent = Math.floor(pct) + '%';
  if (u.file) card.querySelector('.up-file').textContent = `${u.count > 1 ? `${u.index + 1}/${u.count} · ` : ''}${u.file}`;
  card.querySelector('.up-meta').textContent = `${fmtBytes(u.sent)} of ${fmtBytes(u.total)}${speed ? ` · ${fmtBytes(speed)}/s` : ''}${eta > 1 && u.phase === 'progress' ? ` · ${eta > 90 ? Math.ceil(eta / 60) + ' min' : Math.ceil(eta) + ' s'} left` : ''}`;
  if (u.phase === 'done') {
    card.classList.add('done');
    card.querySelector('.up-title').textContent = 'Uploaded · adding to server…';
    card.querySelector('.up-pct').textContent = '100%';
    setTimeout(() => { card.classList.add('out'); setTimeout(() => card.remove(), 400); }, 3500);
  }
  if (u.phase === 'error') {
    card.classList.add('failed');
    card.querySelector('.up-title').textContent = 'Upload failed';
    card.querySelector('.up-meta').textContent = u.error || '';
    setTimeout(() => { card.classList.add('out'); setTimeout(() => card.remove(), 400); }, 7000);
  }
});
api.on('maps:reconciled', (e) => {
  if (e.disabled.length) toast(`So players only download the map in use, these were switched off: ${e.disabled.join(', ')}`, 'info', 'Unused maps switched off');
  if (e.enabled.length) toast(`Switched on: ${e.enabled.join(', ')}`, 'success', 'Map mod enabled');
});
api.on('library:sync', (e) => e.reason === 'moved'
  ? toast(`${e.added.length} mod${e.added.length > 1 ? 's' : ''} moved from the old Redline Mods Library to ${e.dir}`, 'success', 'Mods library moved')
  : null);
api.on('library:sync', (e) => e.reason === 'moved' ? null : toast(`${e.added.length} mod${e.added.length > 1 ? 's' : ''} copied into your central mods library`, 'success', 'Mods library updated'));

// Remove a mod from a server for good; the copy in the mods library / BeamNG mods folder stays.
async function removeModFromServer(serverId, fileName, extra = '') {
  const kept = await api.call('mods:keptWhere', serverId, fileName).catch(() => null);
  const ok = await confirmBox('Remove from server?',
    `${fileName} will be deleted from this server, so players no longer download it.${extra}\n\nYour copy stays in:\n${kept || 'your mods library'}`,
    { danger: true, ok: 'Remove from server' });
  if (!ok) return false;
  const r = await guard(() => api.call('mods:remove', serverId, fileName));
  if (!r) return false;
  toast(`Removed from the server. Your copy is in ${r.keptAt}${r.restartNeeded ? ' · restart the server to apply' : ''}`, 'success', 'Mod removed');
  return true;
}

// Stock BeamNG maps/vehicles. While controlling a host, use this PC's own BeamNG install for
// real names and photos when it has one (nothing is copied to or from the host).
async function loadStock(force) {
  await remoteReady;
  if (REMOTE.connected) {
    const local = await api.call('local:stock', force).catch(() => null);
    if (local && !local.fallback) return { ...local, fromThisPc: true };
  }
  return api.call('content:stock', force);
}

// Pick a folder on the computer that runs the servers: a native dialog locally,
// or a browser of the host's folders when controlling it remotely.
async function chooseHostFolder(title, start) {
  await remoteReady;
  if (!REMOTE.connected) return api.call('dialog:openFolder', title);
  return modal({
    title: title || 'Choose a folder on the host',
    wide: true,
    body: `<div class="faint" style="font-size:12px">Browsing folders on <b>${esc(REMOTE.hostName || REMOTE.host)}</b></div>
      <div class="row"><button class="btn sm icon" id="hfUp">${icon('back')}</button><input class="input mono" id="hfPath" style="height:32px;font-size:12px"></div>
      <div class="list" id="hfList" style="max-height:420px;overflow:auto"></div>`,
    actions: [{ label: 'Cancel', value: null }, { label: 'Select this folder', primary: true, onClick: (b) => $('#hfPath', b).value.trim() || false }],
    onMount: (b) => {
      const load = async (dir) => {
        const r = await guard(() => api.call('hostfs:list', dir));
        if (!r) return;
        $('#hfPath', b).value = r.path;
        $('#hfUp', b).disabled = r.parent === null;
        $('#hfUp', b).onclick = () => load(r.parent);
        $('#hfList', b).innerHTML = r.dirs.length
          ? r.dirs.map((d) => `<div class="lrow clickable" data-p="${esc(d.path)}"><div class="ic-box dir">${icon('folder')}</div><div class="grow t ellipsis">${esc(d.name)}</div></div>`).join('')
          : `<div class="empty" style="padding:20px">${icon('folder')}<div>No subfolders</div></div>`;
        for (const el of $$('[data-p]', b)) el.onclick = () => load(el.dataset.p);
      };
      $('#hfPath', b).onkeydown = (e) => { if (e.key === 'Enter') { e.stopPropagation(); load(e.target.value.trim()); } };
      load(start || '');
    },
  });
}
