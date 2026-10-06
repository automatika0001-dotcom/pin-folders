/* global pf */
const $ = (s) => document.querySelector(s);

let cfg = null;
let ws = null;
let retry = 0;
let state = { guilds: [], folders: [], items: [] };
let guildId = localStorage.getItem('guildId');
let query = '';
const collapsed = new Set(JSON.parse(localStorage.getItem('collapsed') || '[]'));

// ---------- connection ----------
function wsUrl() {
  let base = (cfg.serverUrl || '').trim().replace(/\/+$/, '');
  base = base.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  if (!/^wss?:\/\//.test(base)) base = 'wss://' + base;
  return `${base}/ws?key=${encodeURIComponent(cfg.accessKey)}`;
}

function connect() {
  setStatus('connecting');
  try {
    ws = new WebSocket(wsUrl());
  } catch {
    return scheduleReconnect();
  }
  ws.onopen = () => {
    retry = 0;
    setStatus('online');
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'state') {
      state = m;
      render();
    } else if (m.type === 'error') {
      toast(m.message);
    }
  };
  ws.onclose = () => {
    setStatus('offline');
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  setTimeout(connect, Math.min(15000, 1000 * 2 ** retry++));
}

function send(op) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(op));
  else toast('Not connected to the server yet');
}

function setStatus(s) {
  const el = $('#status');
  el.className = 'status ' + s;
  el.querySelector('b').textContent = { online: 'Live', offline: 'Offline', connecting: 'Connecting' }[s];
}

// Keep-alive so idle connections aren't dropped by proxies.
setInterval(() => ws && ws.readyState === 1 && ws.send('{"op":"ping"}'), 25000);

// ---------- rendering ----------
function render() {
  renderGuilds();
  const root = $('#folders');
  const scroll = root.scrollTop;
  root.innerHTML = '';

  if (!state.guilds.length) {
    root.innerHTML = `<div class="empty-state"><strong>No servers yet</strong>Invite the Pin Folders bot to your Discord server to get started.</div>`;
    return;
  }

  const folders = state.folders.filter((f) => f.guildId === guildId).sort((a, b) => a.position - b.position);
  const items = state.items
    .filter((i) => i.guildId === guildId)
    .filter(matches)
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

  for (const f of folders) {
    const its = items.filter((i) => i.folderId === f.id);
    if (query && !its.length) continue;
    root.appendChild(folderEl(f, its));
  }
  const unsorted = items.filter((i) => !i.folderId || !folders.some((f) => f.id === i.folderId));
  if (unsorted.length) root.appendChild(folderEl({ id: null, name: 'Unsorted' }, unsorted));

  if (!root.children.length) {
    root.innerHTML = query
      ? `<div class="empty-state"><strong>No matches</strong>Nothing pinned matches "${esc(query)}".</div>`
      : `<div class="empty-state"><strong>No folders yet</strong>Create a folder below, then in Discord right-click any message and choose <kbd>Apps</kbd> then <kbd>Add to folder</kbd>.<br><br>Use <kbd>/importpins</kbd> in a channel to bring in its existing pins.</div>`;
  }
  root.scrollTop = scroll;
}

function renderGuilds() {
  if (!state.guilds.some((g) => g.id === guildId)) guildId = state.guilds[0]?.id || null;
  const sel = $('#guild');
  sel.innerHTML = state.guilds.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
  sel.value = guildId || '';
  sel.disabled = state.guilds.length < 2;
}

function matches(i) {
  if (!query) return true;
  const hay = `${i.content} ${i.authorName} ${i.channelName} ${(i.attachments || []).map((a) => a.name).join(' ')}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
}

function folderEl(f, items) {
  const key = f.id || 'unsorted';
  const el = document.createElement('div');
  el.className = 'folder' + (f.id ? '' : ' unsorted') + (collapsed.has(key) && !query ? ' collapsed' : '');
  el.dataset.id = f.id || '';
  el.innerHTML = `
    <div class="folder-head" ${f.id ? 'draggable="true"' : ''}>
      <svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
      <span class="name">${esc(f.name)}</span>
      <span class="count">${items.length}</span>
      ${f.id ? '<button class="more" title="Folder options"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button>' : ''}
    </div>
    <div class="items"></div>`;

  const list = el.querySelector('.items');
  if (!items.length) list.innerHTML = '<div class="empty-folder">Drop messages here</div>';
  for (const it of items) list.appendChild(itemEl(it));

  const head = el.querySelector('.folder-head');
  head.addEventListener('click', (e) => {
    if (e.target.closest('.more')) return;
    el.classList.toggle('collapsed');
    el.classList.contains('collapsed') ? collapsed.add(key) : collapsed.delete(key);
    localStorage.setItem('collapsed', JSON.stringify([...collapsed]));
  });
  const more = head.querySelector('.more');
  if (more) {
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      folderMenu(f, e.clientX, e.clientY);
    });
    head.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      folderMenu(f, e.clientX, e.clientY);
    });
    head.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('pf/folder', f.id);
      e.dataTransfer.effectAllowed = 'move';
    });
  }

  // Drop targets: items onto any folder, folders onto other folders (reorder).
  el.addEventListener('dragover', (e) => {
    const types = e.dataTransfer.types;
    if (types.includes('pf/item')) {
      e.preventDefault();
      el.classList.add('drop-target');
    } else if (types.includes('pf/folder') && f.id) {
      e.preventDefault();
      el.classList.add('drop-before');
    }
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('drop-target', 'drop-before');
  });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drop-target', 'drop-before');
    const itemId = e.dataTransfer.getData('pf/item');
    const folderId = e.dataTransfer.getData('pf/folder');
    if (itemId) send({ op: 'moveItem', id: itemId, folderId: f.id });
    else if (folderId && f.id && folderId !== f.id) reorder(folderId, f.id);
  });
  return el;
}

function reorder(movingId, beforeId) {
  const ids = state.folders
    .filter((f) => f.guildId === guildId)
    .sort((a, b) => a.position - b.position)
    .map((f) => f.id)
    .filter((id) => id !== movingId);
  ids.splice(ids.indexOf(beforeId), 0, movingId);
  send({ op: 'reorderFolders', guildId, ids });
}

function itemEl(it) {
  const el = document.createElement('div');
  el.className = 'item';
  el.draggable = true;
  el.title = 'Click to open in Discord';
  const atts = (it.attachments || [])
    .map((a) =>
      (a.contentType || '').startsWith('image/') ? `<img class="thumb" src="${esc(a.url)}" alt="">` : `<span class="file">📎 ${esc(a.name)}</span>`
    )
    .join('');
  el.innerHTML = `
    <img class="avatar" src="${esc(it.authorAvatar || '')}" alt="">
    <div class="item-body">
      <div class="item-head">
        <span class="author">${esc(it.authorName)}</span>
        <span class="meta">${it.channelName ? '#' + esc(it.channelName) + ' · ' : ''}${ago(it.createdAt)}</span>
      </div>
      ${it.content ? `<div class="content">${formatContent(it.content)}</div>` : ''}
      ${atts ? `<div class="attachments">${atts}</div>` : ''}
    </div>`;

  el.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (a) {
      e.preventDefault();
      e.stopPropagation();
      return pf.openExternal(a.href);
    }
    pf.openMessage(it);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    itemMenu(it, e.clientX, e.clientY);
  });
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('pf/item', it.id);
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  return el;
}

// Hide broken images (Discord attachment links can expire).
document.addEventListener(
  'error',
  (e) => {
    if (e.target.tagName === 'IMG') e.target.classList.contains('avatar') ? (e.target.src = AVATAR_FALLBACK) : e.target.remove();
  },
  true
);
const AVATAR_FALLBACK =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#4e5058"/></svg>');

// ---------- text formatting ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function formatContent(raw) {
  let s = esc(raw);
  s = s.replace(/&lt;a?:(\w+):\d+&gt;/g, ':$1:'); // custom emoji
  s = s.replace(/&lt;@!?\d+&gt;/g, '<span class="mention">@user</span>');
  s = s.replace(/&lt;@&amp;\d+&gt;/g, '<span class="mention">@role</span>');
  s = s.replace(/&lt;#\d+&gt;/g, '<span class="mention">#channel</span>');
  s = s.replace(/```([\s\S]*?)```/g, (_, c) => `<code>${c.trim()}</code>`);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  s = s.replace(/(https?:\/\/[^\s<]+[^\s<.,:;"')\]])/g, '<a href="$1">$1</a>');
  s = s.replace(/\n/g, '<br>');
  if (query) {
    for (const w of query.split(/\s+/).filter(Boolean)) {
      const re = new RegExp(`(?![^<]*>)(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
      s = s.replace(re, '<mark>$1</mark>');
    }
  }
  return s;
}

function ago(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
  return new Date(ts).toLocaleDateString();
}

// ---------- menus & dialogs ----------
function openMenu(x, y, entries) {
  const m = $('#menu');
  m.innerHTML = '';
  for (const e of entries) {
    if (e === '-') {
      m.appendChild(document.createElement('hr'));
    } else if (e.label && !e.action) {
      const d = document.createElement('div');
      d.className = 'label';
      d.textContent = e.label;
      m.appendChild(d);
    } else {
      const b = document.createElement('button');
      b.textContent = e.text;
      if (e.danger) b.className = 'danger';
      b.onclick = () => {
        closeMenu();
        e.action();
      };
      m.appendChild(b);
    }
  }
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(6, Math.min(x, innerWidth - r.width - 6)) + 'px';
  m.style.top = Math.max(6, Math.min(y, innerHeight - r.height - 6)) + 'px';
}
function closeMenu() {
  $('#menu').classList.add('hidden');
}
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#menu')) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
  if (e.ctrlKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    $('#search').focus();
  }
});
window.addEventListener('blur', closeMenu);

function folderMenu(f, x, y) {
  openMenu(x, y, [
    { text: 'Rename folder', action: () => renameFolder(f) },
    { text: 'Delete folder', danger: true, action: () => deleteFolder(f) },
  ]);
}

function itemMenu(it, x, y) {
  const folders = state.folders.filter((f) => f.guildId === guildId && f.id !== it.folderId).sort((a, b) => a.position - b.position);
  openMenu(x, y, [
    { text: 'Open in Discord', action: () => pf.openMessage(it) },
    '-',
    ...(folders.length || it.folderId ? [{ label: 'Move to' }] : []),
    ...folders.map((f) => ({ text: f.name, action: () => send({ op: 'moveItem', id: it.id, folderId: f.id }) })),
    ...(it.folderId ? [{ text: 'Unsorted', action: () => send({ op: 'moveItem', id: it.id, folderId: null }) }] : []),
    '-',
    { text: 'Remove from folders', danger: true, action: () => send({ op: 'removeItem', id: it.id }) },
  ]);
}

function ask({ title, text = '', value = null, ok = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const d = $('#dialog');
    $('#dlg-title').textContent = title;
    $('#dlg-text').textContent = text;
    const input = $('#dlg-input');
    input.classList.toggle('hidden', value === null);
    input.value = value ?? '';
    const okBtn = $('#dlg-ok');
    okBtn.textContent = ok;
    okBtn.classList.toggle('danger', danger);
    d.onclose = () => resolve(d.returnValue === 'ok' ? (value === null ? true : input.value.trim()) : null);
    d.returnValue = '';
    d.showModal();
    if (value !== null) input.select();
  });
}

async function newFolder() {
  if (!guildId) return toast('No server selected');
  const name = await ask({ title: 'New folder', value: '', ok: 'Create' });
  if (name) send({ op: 'createFolder', guildId, name });
}
async function renameFolder(f) {
  const name = await ask({ title: 'Rename folder', value: f.name, ok: 'Save' });
  if (name && name !== f.name) send({ op: 'renameFolder', id: f.id, name });
}
async function deleteFolder(f) {
  const yes = await ask({
    title: `Delete "${f.name}"?`,
    text: 'Messages in it will move to Unsorted. This is shared with everyone.',
    ok: 'Delete',
    danger: true,
  });
  if (yes) send({ op: 'deleteFolder', id: f.id });
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

// ---------- updates & Discord status ----------
pf.onUpdate((u) => {
  const b = $('#update-banner');
  b.classList.remove('hidden');
  if (u.state === 'downloading') {
    b.innerHTML = `<span>Downloading update${u.version ? ' ' + esc(u.version) : ''}... ${u.percent ?? 0}%</span>`;
  } else if (u.state === 'ready') {
    b.innerHTML = `<span>Update ${esc(u.version)} is ready</span><button id="btn-update">Restart now</button>`;
    $('#btn-update').onclick = () => pf.installUpdate();
  }
});

pf.onDiscordStatus((s) => {
  const b = $('#discord-banner');
  if (s === 'ok') return b.classList.add('hidden');
  b.classList.remove('hidden');
  b.textContent = s === 'searching' ? 'Starting Discord...' : 'Could not find Discord. Is it installed?';
});

// ---------- wiring ----------
$('#btn-min').onclick = () => pf.minimize();
$('#btn-close').onclick = () => pf.close();
$('#btn-snap').onclick = () => pf.snap();
$('#btn-new').onclick = newFolder;
$('#guild').onchange = (e) => {
  guildId = e.target.value;
  localStorage.setItem('guildId', guildId);
  render();
};
$('#search').oninput = (e) => {
  query = e.target.value.trim();
  render();
};

(async function init() {
  cfg = await pf.getConfig();
  $('#version').textContent = 'v' + cfg.version;
  if (!cfg.serverUrl || cfg.serverUrl.includes('YOUR-SERVER') || !cfg.accessKey || cfg.accessKey.startsWith('CHANGE-ME')) {
    setStatus('offline');
    $('#folders').innerHTML =
      '<div class="empty-state"><strong>Not configured</strong>Set serverUrl and accessKey in config.json, then rebuild the app.</div>';
    return;
  }
  connect();
})();
