/* global pf */
const $ = (s) => document.querySelector(s);

let cfg = null;
let ws = null;
let retry = 0;
let state = { guilds: [], folders: [], items: [] };
let guildId = localStorage.getItem('guildId');
let query = '';
const collapsed = new Set(JSON.parse(localStorage.getItem('collapsed') || '[]'));

// The channel whose (unsorted) pins appear under "No Label".
let discordTitle = '';
let channelMode = 'auto'; // 'auto' follows Discord, otherwise a channel id
const channelsByGuild = new Map();
let view = { status: 'idle', guildId: null, channelId: null, channelName: null, pins: [], reason: '' };
let viewReq = 0;

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
    refreshView(true);
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'state') {
      state = m;
      if (!guildId || !state.guilds.some((g) => g.id === guildId)) setGuild(state.guilds[0]?.id || null, false);
      requestChannels(guildId);
      render();
    } else if (m.type === 'channel') {
      onChannelView(m);
    } else if (m.type === 'channels') {
      channelsByGuild.set(m.guildId, m.channels);
      renderChannelPicker();
    } else if (m.type === 'error') {
      toast(m.message);
      render(); // undo optimistic changes
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
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(op));
    return true;
  }
  toast('Not connected to the server yet');
  return false;
}

function setStatus(s) {
  const el = $('#status');
  el.className = 'status ' + s;
  el.querySelector('b').textContent = { online: 'Live', offline: 'Offline', connecting: 'Connecting' }[s];
}

setInterval(() => ws && ws.readyState === 1 && ws.send('{"op":"ping"}'), 25000);

// ---------- current channel ("No Label") ----------
function refreshView(force = false) {
  if (!ws || ws.readyState !== 1) return;
  const reqId = ++viewReq;
  if (channelMode === 'auto') {
    if (!discordTitle) {
      view = { ...view, status: 'nomatch' };
      return render();
    }
    if (view.status !== 'ok') view = { ...view, status: 'loading' };
    ws.send(JSON.stringify({ op: 'viewChannel', reqId, title: discordTitle, force }));
  } else {
    if (view.channelId !== channelMode) view = { ...view, status: 'loading', pins: [] };
    ws.send(JSON.stringify({ op: 'viewChannel', reqId, guildId, channelId: channelMode, force }));
  }
  render();
}

function onChannelView(m) {
  if (m.reqId !== viewReq) return; // an older answer
  if (!m.ok) {
    view = { status: m.reason === 'no-match' ? 'nomatch' : 'error', reason: m.reason, pins: [], guildId: null, channelId: null, channelName: null };
    renderChannelPicker();
    return render();
  }
  view = { status: 'ok', guildId: m.guildId, channelId: m.channelId, channelName: m.channelName, pins: m.pins || [], reason: '' };
  // Follow Discord into whichever server it's showing.
  if (channelMode === 'auto' && m.guildId !== guildId) setGuild(m.guildId, false);
  renderChannelPicker();
  render();
}

function requestChannels(gid) {
  if (gid && !channelsByGuild.has(gid) && ws && ws.readyState === 1) {
    channelsByGuild.set(gid, null); // pending
    ws.send(JSON.stringify({ op: 'listChannels', guildId: gid }));
  }
}

function setGuild(id, byUser) {
  guildId = id;
  if (id) localStorage.setItem('guildId', id);
  if (byUser && channelMode !== 'auto') channelMode = 'auto';
  requestChannels(id);
  renderGuilds();
  renderChannelPicker();
}

pf.onDiscordTitle((t) => {
  discordTitle = t || '';
  if (channelMode === 'auto') refreshView();
});
setInterval(() => refreshView(), 30000); // pick up newly pinned messages

// ---------- data shaping ----------
function guildFolders() {
  return state.folders.filter((f) => f.guildId === guildId).sort((a, b) => a.position - b.position);
}

/** Everything shown, as {key, kind, data, folderId} entries. */
function entries() {
  const filed = state.items.filter((i) => i.guildId === guildId);
  const folderIds = new Set(guildFolders().map((f) => f.id));
  const filedIds = new Set(filed.map((i) => i.messageId));
  const list = filed.map((i) => ({
    key: i.id,
    kind: 'filed',
    data: i,
    folderId: i.folderId && folderIds.has(i.folderId) ? i.folderId : null,
  }));
  if (view.status === 'ok' && view.guildId === guildId) {
    for (const p of view.pins) {
      if (!filedIds.has(p.messageId)) list.push({ key: 'pin:' + p.messageId, kind: 'pin', data: p, folderId: null });
    }
  }
  return list;
}

function matches(d) {
  if (!query) return true;
  const hay = `${d.content} ${d.authorName} ${d.channelName} ${(d.attachments || []).map((a) => a.name).join(' ')}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
}

// ---------- rendering ----------
let seenKeys = null;
let pendingRender = false;
let receivedFolder = null;

function render() {
  if (drag) {
    pendingRender = true;
    return;
  }
  renderGuilds();
  const root = $('#folders');
  const scroll = root.scrollTop;
  root.innerHTML = '';

  if (!state.guilds.length) {
    root.innerHTML = `<div class="empty-state"><strong>No servers yet</strong>Invite the Pin Folders bot to your Discord server to get started.</div>`;
    return;
  }

  const all = entries().filter((e) => matches(e.data));
  const byNew = (a, b) => (b.data.addedAt || b.data.createdAt || 0) - (a.data.addedAt || a.data.createdAt || 0);
  const nextKeys = new Set(all.map((e) => e.key));

  const prevInboxScroll = root.dataset.inboxScroll ? Number(root.dataset.inboxScroll) : 0;

  for (const f of guildFolders()) {
    const its = all.filter((e) => e.folderId === f.id).sort(byNew);
    if (query && !its.length) continue;
    root.appendChild(folderEl(f, its));
  }

  // "No Label" sits at the bottom and shows 3 pins at a time; scroll for the rest.
  const noLabel = all.filter((e) => !e.folderId).sort(byNew);
  const inbox = folderEl({ id: null, name: 'No Label' }, noLabel);
  root.appendChild(inbox);
  limitInbox(inbox, prevInboxScroll);

  if (seenKeys) {
    for (const el of root.querySelectorAll('.item')) if (!seenKeys.has(el.dataset.key)) el.classList.add('enter');
  }
  seenKeys = nextKeys;

  if (receivedFolder !== undefined && receivedFolder !== null) {
    const el = root.querySelector(`.folder[data-id="${receivedFolder}"]`);
    if (el) {
      el.classList.add('received');
      setTimeout(() => el.classList.remove('received'), 650);
    }
    receivedFolder = null;
  }
  root.scrollTop = scroll;
}

// Caps the No Label list at 3 visible pins (cards vary in height, so measure).
const INBOX_VISIBLE = 3;
function limitInbox(folder, restoreScroll = 0) {
  const list = folder.querySelector('.items');
  const cards = list.querySelectorAll('.item');
  list.classList.remove('capped');
  list.style.maxHeight = '';
  if (cards.length <= INBOX_VISIBLE) return;
  const top = list.getBoundingClientRect().top;
  const cut = cards[INBOX_VISIBLE].getBoundingClientRect().top;
  list.style.maxHeight = Math.max(120, Math.round(cut - top)) + 'px';
  list.classList.add('capped');
  list.scrollTop = restoreScroll;
  list.addEventListener('scroll', () => {
    $('#folders').dataset.inboxScroll = String(list.scrollTop);
  });
}

function renderGuilds() {
  const sel = $('#guild');
  const html = state.guilds.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
  if (sel.dataset.html !== html) {
    sel.innerHTML = html;
    sel.dataset.html = html;
  }
  sel.value = guildId || '';
  sel.disabled = state.guilds.length < 2;
}

function renderChannelPicker() {
  const sel = $('#channel');
  const chans = channelsByGuild.get(guildId) || [];
  const autoLabel =
    view.status === 'ok' && channelMode === 'auto' ? `Follow Discord (#${view.channelName})` : 'Follow Discord';
  sel.innerHTML =
    `<option value="auto">${esc(autoLabel)}</option>` +
    (chans.length ? `<optgroup label="Channels">${chans.map((c) => `<option value="${c.id}">#${esc(c.name)}</option>`).join('')}</optgroup>` : '');
  sel.value = channelMode;
}

function folderEl(f, items) {
  const isNoLabel = f.id === null;
  const key = f.id || 'nolabel';
  const el = document.createElement('div');
  el.className = 'folder' + (isNoLabel ? ' nolabel' : '') + (collapsed.has(key) && !query ? ' collapsed' : '');
  el.dataset.id = f.id || 'nolabel';
  const sub = isNoLabel && view.status === 'ok' && view.guildId === guildId ? `#${esc(view.channelName)}` : '';
  el.innerHTML = `
    <div class="folder-head" ${isNoLabel ? '' : 'data-draggable="1"'}>
      <svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
      <span class="name">${esc(f.name)}</span>
      ${sub ? `<span class="sub">${sub}</span>` : ''}
      <span class="count">${items.length}</span>
      ${isNoLabel ? '' : '<button class="more" title="Folder options"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button>'}
    </div>
    <div class="items"></div>`;

  const list = el.querySelector('.items');
  if (!items.length) list.innerHTML = emptyText(isNoLabel);
  for (const e of items) list.appendChild(itemEl(e));

  const head = el.querySelector('.folder-head');
  head.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!isNoLabel) folderMenu(f, e.clientX, e.clientY);
  });
  head.querySelector('.more')?.addEventListener('click', (e) => {
    e.stopPropagation();
    folderMenu(f, e.clientX, e.clientY);
  });
  return el;
}

function emptyText(isNoLabel) {
  if (!isNoLabel) return '<div class="empty-folder">Drag pins here</div>';
  if (view.status === 'loading') return '<div class="skeleton"></div><div class="skeleton"></div>';
  if (view.status === 'ok' && view.guildId === guildId) return `<div class="empty-folder">Every pin in #${esc(view.channelName)} is in a folder.</div>`;
  if (view.status === 'error') return `<div class="empty-folder">Couldn't load pins: ${esc(view.reason)}</div>`;
  return '<div class="empty-folder">Open a text channel in Discord (or pick one under "Pins from") to see its unsorted pins here.</div>';
}

function itemEl(e) {
  const it = e.data;
  const el = document.createElement('div');
  el.className = 'item';
  el.dataset.key = e.key;
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
    </div>
    <button class="jump" title="Jump to this message in Discord">Jump</button>`;

  el.querySelector('.jump').addEventListener('click', (ev) => {
    ev.stopPropagation();
    pf.openMessage(it);
  });
  el.addEventListener('click', (ev) => {
    const a = ev.target.closest('a');
    if (a) {
      ev.preventDefault();
      pf.openExternal(a.href);
    }
  });
  el.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    itemMenu(e, ev.clientX, ev.clientY);
  });
  return el;
}

document.addEventListener(
  'error',
  (e) => {
    if (e.target.tagName === 'IMG') e.target.classList.contains('avatar') ? (e.target.src = AVATAR_FALLBACK) : e.target.remove();
  },
  true
);
const AVATAR_FALLBACK =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#3f4147"/></svg>');

// ---------- moving things (shared by drag & drop and menus) ----------
function findEntry(key) {
  return entries().find((e) => e.key === key) || null;
}

/** Moves an entry into a folder (or back to No Label). Updates instantly, then syncs. */
function moveEntry(entry, targetId) {
  const toFolder = targetId === 'nolabel' ? null : targetId;
  if ((entry.folderId || null) === toFolder) return false;

  if (entry.kind === 'pin') {
    if (!toFolder) return false;
    if (!send({ op: 'fileFromChannel', guildId, channelId: entry.data.channelId, messageId: entry.data.messageId, folderId: toFolder })) return false;
    state.items = [...state.items, { ...entry.data, id: 'tmp:' + entry.data.messageId, folderId: toFolder, addedAt: Date.now() }];
  } else if (!toFolder) {
    if (!send({ op: 'removeItem', id: entry.data.id })) return false;
    state.items = state.items.filter((i) => i.id !== entry.data.id);
  } else {
    if (!send({ op: 'moveItem', id: entry.data.id, folderId: toFolder })) return false;
    state.items = state.items.map((i) => (i.id === entry.data.id ? { ...i, folderId: toFolder } : i));
  }
  receivedFolder = targetId;
  return true;
}

function reorder(movingId, targetId, after) {
  const ids = guildFolders()
    .map((f) => f.id)
    .filter((id) => id !== movingId);
  let at = ids.indexOf(targetId);
  if (after) at++;
  ids.splice(at, 0, movingId);
  if (!send({ op: 'reorderFolders', guildId, ids })) return;
  const rank = new Map(ids.map((id, i) => [id, i]));
  state.folders = state.folders.map((f) => (rank.has(f.id) ? { ...f, position: rank.get(f.id) } : f));
}

// ---------- tactile drag & drop (pointer based) ----------
let drag = null;

$('#folders').addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('button, a, .more')) return;
  const card = e.target.closest('.item');
  const head = e.target.closest('.folder-head');
  if (!card && !head) return;
  drag = {
    kind: card ? 'item' : 'folder',
    source: card || head.parentElement,
    head,
    key: card ? card.dataset.key : head.parentElement.dataset.id,
    canDrag: card ? true : !!head.dataset.draggable,
    x0: e.clientX,
    y0: e.clientY,
    started: false,
    vx: 0,
    lastX: e.clientX,
    tilt: 0,
    hoverTarget: null,
    hoverSince: 0,
  };
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd, { once: true });
  window.addEventListener('pointercancel', onDragEnd, { once: true });
});

function startDrag(e) {
  const src = drag.kind === 'item' ? drag.source : drag.head;
  const r = src.getBoundingClientRect();
  const ghost = src.cloneNode(true);
  ghost.classList.add('ghost', 'lift');
  if (drag.kind === 'folder') ghost.classList.add('folder-ghost');
  ghost.classList.remove('enter', 'lifted');
  ghost.style.width = r.width + 'px';
  ghost.style.transformOrigin = `${drag.x0 - r.left}px ${drag.y0 - r.top}px`;
  document.body.appendChild(ghost);
  drag.ghost = ghost;
  drag.offX = drag.x0 - r.left;
  drag.offY = drag.y0 - r.top;
  drag.origin = r;
  drag.started = true;
  drag.source.classList.add('lifted');
  document.body.classList.add('dragging');
  closeMenu();
  positionGhost(e.clientX, e.clientY);
  autoScrollLoop();
}

function positionGhost(x, y) {
  // A little tilt in the direction you're moving makes it feel picked up.
  drag.vx = drag.vx * 0.7 + (x - drag.lastX) * 0.3;
  drag.lastX = x;
  drag.tilt = Math.max(-6, Math.min(6, drag.vx * 0.6));
  drag.px = x;
  drag.py = y;
  drag.ghost.style.transform = `translate(${x - drag.offX}px, ${y - drag.offY}px) rotate(${drag.tilt}deg) scale(0.94)`;
}

function onDragMove(e) {
  if (!drag) return;
  if (!drag.started) {
    if (!drag.canDrag || Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return;
    startDrag(e);
  }
  positionGhost(e.clientX, e.clientY);
  updateDropTarget(e.clientX, e.clientY);
}

function updateDropTarget(x, y) {
  const under = document.elementFromPoint(x, y);
  const folder = under?.closest?.('.folder');
  for (const el of document.querySelectorAll('.drop-target, .drop-before, .drop-after')) {
    if (el !== folder) el.classList.remove('drop-target', 'drop-before', 'drop-after');
  }
  drag.target = null;
  if (!folder) return;

  if (drag.kind === 'item') {
    const entry = findEntry(drag.key);
    const targetId = folder.dataset.id;
    const same = entry && (entry.folderId || 'nolabel') === targetId;
    const pinToNoLabel = entry?.kind === 'pin' && targetId === 'nolabel';
    if (!entry || same || pinToNoLabel) return folder.classList.remove('drop-target');
    folder.classList.add('drop-target');
    drag.target = { id: targetId, el: folder };
    // Hovering a collapsed folder opens it.
    if (drag.hoverTarget !== folder) {
      drag.hoverTarget = folder;
      drag.hoverSince = Date.now();
    } else if (folder.classList.contains('collapsed') && Date.now() - drag.hoverSince > 550) {
      folder.classList.remove('collapsed');
      collapsed.delete(targetId);
      saveCollapsed();
    }
  } else {
    const targetId = folder.dataset.id;
    if (targetId === 'nolabel' || targetId === drag.key) return folder.classList.remove('drop-before', 'drop-after');
    const r = folder.getBoundingClientRect();
    const after = y > r.top + r.height / 2;
    folder.classList.toggle('drop-before', !after);
    folder.classList.toggle('drop-after', after);
    drag.target = { id: targetId, el: folder, after };
  }
}

function autoScrollLoop() {
  if (!drag || !drag.started) return;
  const box = $('#folders');
  const r = box.getBoundingClientRect();
  const edge = 44;
  if (drag.py < r.top + edge) box.scrollTop -= Math.ceil((r.top + edge - drag.py) / 4);
  else if (drag.py > r.bottom - edge) box.scrollTop += Math.ceil((drag.py - (r.bottom - edge)) / 4);
  requestAnimationFrame(autoScrollLoop);
}

function onDragEnd() {
  window.removeEventListener('pointermove', onDragMove);
  const d = drag;
  if (!d) return;

  if (!d.started) {
    drag = null;
    // A plain click on a folder header opens/closes it.
    if (d.kind === 'folder') toggleFolder(d.source);
    return;
  }

  const ghost = d.ghost;
  const target = d.target;
  for (const el of document.querySelectorAll('.drop-target, .drop-before, .drop-after')) el.classList.remove('drop-target', 'drop-before', 'drop-after');
  document.body.classList.remove('dragging');

  let moved = false;
  if (target && d.kind === 'item') {
    const entry = findEntry(d.key);
    if (entry) moved = moveEntry(entry, target.id);
  } else if (target && d.kind === 'folder') {
    reorder(d.key, target.id, target.after);
    moved = true;
  }

  // Fly into the folder, or spring back to where it came from.
  ghost.classList.remove('lift');
  ghost.classList.add('settle');
  if (moved && d.kind === 'item') {
    const h = target.el.querySelector('.folder-head').getBoundingClientRect();
    ghost.style.transform = `translate(${h.left + 12}px, ${h.top}px) scale(0.3)`;
    ghost.style.opacity = '0';
  } else if (moved) {
    const r = target.el.getBoundingClientRect();
    ghost.style.transform = `translate(${r.left}px, ${target.after ? r.bottom - 30 : r.top}px) scale(1)`;
    ghost.style.opacity = '0';
  } else {
    ghost.style.transform = `translate(${d.origin.left}px, ${d.origin.top}px) scale(1)`;
  }
  setTimeout(() => {
    ghost.remove();
    d.source.classList.remove('lifted');
    drag = null;
    if (moved || pendingRender) {
      pendingRender = false;
      render();
    }
  }, 230);
}

function toggleFolder(folderEl) {
  const key = folderEl.dataset.id;
  folderEl.classList.toggle('collapsed');
  if (key === 'nolabel' && !folderEl.classList.contains('collapsed')) limitInbox(folderEl);
  folderEl.classList.contains('collapsed') ? collapsed.add(key) : collapsed.delete(key);
  saveCollapsed();
}

function saveCollapsed() {
  localStorage.setItem('collapsed', JSON.stringify([...collapsed]));
}

// ---------- text formatting ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function formatContent(raw) {
  let s = esc(raw);
  s = s.replace(/&lt;a?:(\w+):\d+&gt;/g, ':$1:');
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
function openMenu(x, y, items) {
  const m = $('#menu');
  m.innerHTML = '';
  for (const e of items) {
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

function itemMenu(entry, x, y) {
  const folders = guildFolders().filter((f) => f.id !== entry.folderId);
  const moveTo = folders.map((f) => ({ text: f.name, action: () => moveEntry(entry, f.id) && render() }));
  openMenu(x, y, [
    { text: 'Jump to message', action: () => pf.openMessage(entry.data) },
    ...(moveTo.length ? ['-', { label: 'Move to' }, ...moveTo] : []),
    ...(entry.kind === 'filed'
      ? ['-', { text: 'Back to No Label', danger: true, action: () => moveEntry(entry, 'nolabel') && render() }]
      : []),
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
    text: 'Its messages go back to No Label. This is shared with everyone.',
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

// ---------- updates (click the version number to check) ----------
let versionTimer;
function setVersionText(text, cls = '', resetMs = 0) {
  const v = $('#version');
  v.textContent = text;
  v.className = 'version ' + cls;
  clearTimeout(versionTimer);
  if (resetMs) versionTimer = setTimeout(() => setVersionText('v' + cfg.version), resetMs);
}

$('#version').onclick = () => {
  setVersionText('Checking...', 'busy');
  pf.checkForUpdates();
};

pf.onUpdate((u) => {
  const b = $('#update-banner');
  if (u.state === 'checking') return setVersionText('Checking...', 'busy');
  if (u.state === 'none') return setVersionText('Up to date ✓', 'ok', 3000);
  if (u.state === 'dev') return setVersionText('Updates work in the installed app', '', 3000);
  if (u.state === 'error') return setVersionText('Update check failed', '', 3000);
  if (u.state === 'downloading') {
    setVersionText('Downloading...', 'busy');
    b.classList.remove('hidden');
    b.innerHTML = `<span>Downloading update${u.version ? ' ' + esc(u.version) : ''}... ${u.percent ?? 0}%</span>`;
  } else if (u.state === 'ready') {
    setVersionText('Update ready', 'ok');
    b.classList.remove('hidden');
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
  setGuild(e.target.value, true);
  refreshView();
};
$('#channel').onchange = (e) => {
  channelMode = e.target.value;
  view = { status: 'loading', pins: [], guildId: null, channelId: null, channelName: null, reason: '' };
  refreshView(true);
};
$('#search').oninput = (e) => {
  query = e.target.value.trim();
  render();
};

(async function init() {
  cfg = await pf.getConfig();
  setVersionText('v' + cfg.version);
  if (!cfg.serverUrl || cfg.serverUrl.includes('YOUR-SERVER') || !cfg.accessKey || cfg.accessKey.startsWith('CHANGE-ME')) {
    setStatus('offline');
    $('#folders').innerHTML =
      '<div class="empty-state"><strong>Not configured</strong>Set serverUrl and accessKey in config.json, then rebuild the app.</div>';
    return;
  }
  connect();
})();
