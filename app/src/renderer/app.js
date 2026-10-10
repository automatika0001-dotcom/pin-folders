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
      send({ op: 'sync' }); // undo optimistic changes with the server's truth
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
// viewReq changes only when the channel being shown changes (switching in Discord or
// in "Pins from"). The once-a-second check reuses it, so slow answers are never dropped.
function refreshView(force = false, quiet = false) {
  if (!ws || ws.readyState !== 1) return;
  const reqId = viewReq;
  if (channelMode === 'auto') {
    if (!discordTitle) {
      if (view.status !== 'nomatch') {
        view = { ...view, status: 'nomatch' };
        render();
      }
      return;
    }
    if (!quiet && view.status !== 'ok') view = { ...view, status: 'loading' };
    ws.send(JSON.stringify({ op: 'viewChannel', reqId, title: discordTitle, force }));
  } else {
    if (!quiet && view.channelId !== channelMode) view = { ...view, status: 'loading', pins: [] };
    ws.send(JSON.stringify({ op: 'viewChannel', reqId, guildId, channelId: channelMode, force }));
  }
  if (!quiet) render();
}

// Something different is being shown: forget answers about the previous channel.
function switchView(force = false) {
  viewReq++;
  refreshView(force);
}

// Check the open channel's pins about once a second while the panel is on screen,
// so a newly pinned message shows up under No Label right away.
setInterval(() => {
  if (document.visibilityState === 'visible' && !drag) refreshView(false, true);
}, 1000);

function onChannelView(m) {
  if (m.reqId !== viewReq) return; // an answer about a channel we've since left
  if (!m.ok) {
    const status = m.reason === 'no-match' ? 'nomatch' : m.reason === 'no-channel' ? 'nochannel' : 'error';
    if (view.status === status && view.reason === m.reason && (view.guildId || null) === (m.guildId || null)) return;
    view = { status, reason: m.reason, pins: [], guildId: m.guildId || null, channelId: null, channelName: null };
    if (status === 'nochannel' && channelMode === 'auto' && m.guildId && m.guildId !== guildId) setGuild(m.guildId, false);
    renderChannelPicker();
    return render();
  }
  const sig = (v) => `${v.status}|${v.guildId}|${v.channelId}|` + (v.pins || []).map((p) => p.messageId + ':' + (p.content || '').length).join(',');
  const next = { status: 'ok', guildId: m.guildId, channelId: m.channelId, channelName: m.channelName, pins: m.pins || [], reason: '' };
  if (sig(next) === sig(view)) return;
  view = next;
  if (inviteChecks.length) {
    inviteChecks.forEach(clearTimeout);
    inviteChecks = [];
  }
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
  if (channelMode === 'auto') switchView();
});

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
  updateInvite();
  const root = $('#folders');
  const scroll = root.scrollTop;
  root.innerHTML = '';

  if (!state.guilds.length) {
    root.innerHTML = `<div class="empty-state"><strong>No servers yet</strong>Add the Pin Folders bot to your Discord server to get started.${
      state.invite ? '<br><br><button class="primary invite-btn">Add to this server</button>' : ''
    }</div>`;
    root.querySelector('.invite-btn')?.addEventListener('click', inviteBot);
    updateInvite();
    return;
  }

  // Discord is on a server that doesn't have the bot: show none of another server's folders.
  const foreign = foreignServer();
  if (foreign) {
    root.innerHTML = `<div class="empty-state"><strong>No folders for ${esc(foreign)}</strong>Each server has its own folders. Add Pin Folders to this server with the button above to start sorting its pins.</div>`;
    seenKeys = null;
    return;
  }

  const all = entries().filter((e) => matches(e.data));
  const byNew = (a, b) => (b.data.addedAt || b.data.createdAt || 0) - (a.data.addedAt || a.data.createdAt || 0);
  const nextKeys = new Set(all.map((e) => e.key));

  const prevInboxScroll = root.dataset.inboxScroll ? Number(root.dataset.inboxScroll) : 0;

  const byFolder = new Map();
  for (const e of all) if (e.folderId) (byFolder.get(e.folderId) || byFolder.set(e.folderId, []).get(e.folderId)).push(e);
  const kids = folderChildren();

  // Builds a folder and everything inside it. Returns null when a search hides it.
  const build = (f, depth) => {
    const own = (byFolder.get(f.id) || []).sort(byNew);
    const children = depth < 12 ? (kids.get(f.id) || []).map((c) => build(c, depth + 1)).filter(Boolean) : [];
    const total = own.length + children.reduce((n, c) => n + c.total, 0);
    if (query && !total) return null;
    return { el: folderEl(f, own, { children: children.map((c) => c.el), total, depth }), total };
  };
  for (const f of kids.get(null) || []) {
    const b = build(f, 1);
    if (b) root.appendChild(b.el);
  }

  // "No Label" sits at the bottom and shows 3 pins at a time; scroll for the rest.
  // Same order as Discord's pinned messages: most recently pinned on top.
  // Discord's live pin list is the source of truth (it also covers messages that
  // were filed before pin dates were saved). Messages no longer pinned go last.
  const live = new Map(
    (view.status === 'ok' && view.guildId === guildId ? view.pins : []).map((p, i) => [p.messageId, { at: p.pinnedAt || null, i }])
  );
  const pinKey = (e) => {
    const l = live.get(e.data.messageId);
    return { pinned: !!l || !!e.data.pinnedAt, at: l?.at ?? e.data.pinnedAt ?? null, i: l ? l.i : Infinity };
  };
  const noLabel = all
    .filter((e) => !e.folderId)
    .map((e) => [e, pinKey(e)])
    .sort(([a, ka], [b, kb]) => {
      if (ka.pinned !== kb.pinned) return ka.pinned ? -1 : 1;
      if (ka.at && kb.at && ka.at !== kb.at) return kb.at - ka.at;
      if (ka.i !== kb.i) return ka.i - kb.i; // Discord's own order when dates are missing
      return (b.data.createdAt || 0) - (a.data.createdAt || 0);
    })
    .map(([e]) => e);
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

// ---------- "Add to this server" ----------
/** Server name from Discord's window title ("#general | My Server - Discord"), or null if not a server channel. */
function titleServerName(title) {
  const t = String(title || '').replace(/\s+-\s+Discord\s*$/i, '').replace(/^Discord\s+[|\-]\s+/i, '').trim();
  if (!t) return null;
  const parts = t.split(/\s+\|\s+/);
  if (parts.length < 2) return null; // DMs, Friends, settings etc.
  if (!parts.some((p) => p.startsWith('#') || /^[^@\s]/.test(p))) return null;
  const name = parts[parts.length - 1].trim();
  return name && !name.startsWith('#') && !name.startsWith('@') ? name : null;
}

/** Name of the server Discord is showing when the bot isn't in it (null otherwise). */
function foreignServer() {
  return channelMode === 'auto' && view.status === 'nomatch' ? titleServerName(discordTitle) : null;
}

function updateInvite() {
  const box = $('#invite');
  const server = foreignServer();
  const show = !!state.invite && !!server && ws && ws.readyState === 1;
  box.classList.toggle('hidden', !show);
  if (show) $('#invite-server').textContent = server;
}

let inviteChecks = [];
function inviteBot() {
  if (!state.invite) return toast('Not connected to the server yet');
  pf.openExternal(state.invite);
  // Once they've added it, pick the server up quickly instead of waiting 10 minutes.
  inviteChecks.forEach(clearTimeout);
  inviteChecks = [8, 20, 40, 75, 120, 180].map((sec) =>
    setTimeout(() => {
      if (ws && ws.readyState === 1) ws.send('{"op":"refreshGuilds"}');
      refreshView(true);
    }, sec * 1000)
  );
}
window.addEventListener('focus', () => {
  if (inviteChecks.length && ws && ws.readyState === 1) {
    ws.send('{"op":"refreshGuilds"}');
    setTimeout(() => refreshView(true), 1500);
  }
});

// ---------- folder tree helpers ----------
const MAX_DEPTH = 5;
const COLORS = [
  ['blurple', 'Blurple'], ['green', 'Green'], ['yellow', 'Yellow'], ['orange', 'Orange'],
  ['red', 'Red'], ['pink', 'Pink'], ['purple', 'Purple'], ['teal', 'Teal'],
];

/** Map of parentId (null = top level) -> child folders, in order. */
function folderChildren() {
  const list = guildFolders();
  const ids = new Set(list.map((f) => f.id));
  const kids = new Map();
  for (const f of list) {
    const p = f.parentId && ids.has(f.parentId) && f.parentId !== f.id ? f.parentId : null;
    (kids.get(p) || kids.set(p, []).get(p)).push(f);
  }
  return kids;
}

function folderById(id) {
  return state.folders.find((f) => f.id === id) || null;
}

function depthOf(id) {
  let d = 0;
  for (let f = folderById(id); f && d < 50; f = f.parentId ? folderById(f.parentId) : null) d++;
  return d;
}

function heightOf(id, kids = folderChildren(), guard = 0) {
  if (guard > 50) return 1;
  return 1 + Math.max(0, ...(kids.get(id) || []).map((k) => heightOf(k.id, kids, guard + 1)));
}

function isInside(id, ancestorId) {
  for (let f = folderById(id); f; f = f.parentId ? folderById(f.parentId) : null) if (f.id === ancestorId) return true;
  return false;
}

/** All folders in tree order with "Parent / Child" labels (for menus). */
function folderPaths() {
  const kids = folderChildren();
  const out = [];
  const walk = (p, prefix, d) => {
    if (d > 12) return;
    for (const f of kids.get(p) || []) {
      const path = prefix ? `${prefix} / ${f.name}` : f.name;
      out.push({ folder: f, path, depth: d });
      walk(f.id, path, d + 1);
    }
  };
  walk(null, '', 1);
  return out;
}

function renderGuilds() {
  const sel = $('#guild');
  const html = state.guilds.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
  if (sel.dataset.html !== html) {
    sel.innerHTML = html;
    sel.dataset.html = html;
  }
  const foreign = foreignServer();
  sel.querySelector('option[data-foreign]')?.remove();
  if (foreign) {
    const o = document.createElement('option');
    o.dataset.foreign = '1';
    o.value = '';
    o.textContent = `${foreign} (no Pin Folders bot)`;
    sel.prepend(o);
    sel.dataset.html = '';
  }
  sel.value = foreign ? '' : guildId || '';
  sel.disabled = state.guilds.length < 2 && !foreign;
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

function folderEl(f, items, opts = {}) {
  const isNoLabel = f.id === null;
  const key = f.id || 'nolabel';
  const children = opts.children || [];
  const total = opts.total ?? items.length;
  const el = document.createElement('div');
  el.className =
    'folder' +
    (isNoLabel ? ' nolabel' : '') +
    (f.color ? ` colored c-${f.color}` : '') +
    (opts.depth > 1 ? ' sub' : '') +
    (collapsed.has(key) && !query ? ' collapsed' : '');
  el.dataset.id = f.id || 'nolabel';
  const sub = isNoLabel && view.status === 'ok' && view.guildId === guildId ? `#${esc(view.channelName)}` : '';
  el.innerHTML = `
    <div class="folder-head" ${isNoLabel ? '' : 'data-draggable="1"'}>
      <svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
      ${isNoLabel ? '' : '<svg class="ficon" viewBox="0 0 24 24"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.2h7.4A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/></svg>'}
      <span class="name">${esc(f.name)}</span>
      ${sub ? `<span class="sub">${sub}</span>` : ''}
      <span class="count" title="${items.length} here${children.length ? `, ${total} including subfolders` : ''}">${total}</span>
      ${isNoLabel ? '' : '<button class="more" title="Folder options"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button>'}
    </div>
    <div class="folder-body"><div class="items"></div></div>`;

  const body = el.querySelector('.folder-body');
  const list = el.querySelector('.items');
  if (!items.length && !children.length) list.innerHTML = emptyText(isNoLabel);
  if (!items.length && children.length) list.remove();
  for (const e of items) list.appendChild(itemEl(e));
  if (children.length) {
    const wrap = document.createElement('div');
    wrap.className = 'subfolders';
    for (const c of children) wrap.appendChild(c);
    body.appendChild(wrap);
  }

  const head = el.querySelector('.folder-head');
  head.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
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
  if (view.status === 'nochannel')
    return '<div class="empty-folder">The bot can\'t see this channel. Give it <b>View Channel</b> and <b>Read Message History</b> here to see its pins.</div>';
  if (view.status === 'nomatch' && titleServerName(discordTitle))
    return '<div class="empty-folder">This server doesn\'t have the Pin Folders bot yet. Use <b>Add to this server</b> above.</div>';
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
    // Out of every folder = back to No Label (kept, from any channel), never lost.
    if (!send({ op: 'moveItem', id: entry.data.id, folderId: null })) return false;
    state.items = state.items.map((i) => (i.id === entry.data.id ? { ...i, folderId: null, unlabeledAt: Date.now() } : i));
  } else {
    if (!send({ op: 'moveItem', id: entry.data.id, folderId: toFolder })) return false;
    state.items = state.items.map((i) => (i.id === entry.data.id ? { ...i, folderId: toFolder } : i));
  }
  receivedFolder = targetId;
  return true;
}

/** Puts a folder inside another (parentId) or at the top level (null), next to a sibling if given. */
function moveFolderTo(id, parentId, ref = {}) {
  const f = folderById(id);
  if (!f) return false;
  parentId = parentId || null;
  if (parentId && (parentId === id || isInside(parentId, id))) {
    toast("A folder can't go inside itself");
    return false;
  }
  if (parentId && depthOf(parentId) + heightOf(id) > MAX_DEPTH) {
    toast(`Folders can be nested ${MAX_DEPTH} levels deep at most`);
    return false;
  }
  const sameSpot =
    (f.parentId || null) === parentId && !ref.beforeId && !ref.afterId;
  if (sameSpot) return false;
  if (!send({ op: 'moveFolder', id, parentId, beforeId: ref.beforeId || null, afterId: ref.afterId || null })) return false;

  // Show it right away; the server's answer follows within a moment.
  let position = Math.max(0, ...state.folders.map((x) => x.position)) + 1;
  if (ref.beforeId) position = (folderById(ref.beforeId)?.position ?? position) - 0.5;
  else if (ref.afterId) position = (folderById(ref.afterId)?.position ?? position) + 0.5;
  state.folders = state.folders.map((x) => (x.id === id ? { ...x, parentId, position } : x));
  if (parentId) {
    collapsed.delete(parentId);
    saveCollapsed();
  }
  return true;
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
    // Dragging a folder: top edge of a header = put it above, otherwise = put it inside.
    const head = under?.closest?.('.folder-head');
    const tf = head ? head.parentElement : folder;
    for (const el of document.querySelectorAll('.drop-target, .drop-before, .drop-after')) {
      if (el !== tf) el.classList.remove('drop-target', 'drop-before', 'drop-after');
    }
    if (!tf || drag.source.contains(tf)) return;
    if (tf.dataset.id === 'nolabel') {
      // Dropping on No Label = move to the top level, at the end.
      tf.classList.add('drop-before');
      drag.target = { mode: 'top', el: tf };
      return;
    }
    let mode = 'inside';
    if (head) {
      const r = head.getBoundingClientRect();
      const rel = (y - r.top) / r.height;
      if (rel < 0.3) mode = 'before';
      else if (rel > 0.7 && tf.classList.contains('collapsed')) mode = 'after';
    }
    tf.classList.toggle('drop-target', mode === 'inside');
    tf.classList.toggle('drop-before', mode === 'before');
    tf.classList.toggle('drop-after', mode === 'after');
    drag.target = { mode, id: tf.dataset.id, el: tf };
    // Hovering a collapsed folder opens it, so you can drop deeper.
    if (mode === 'inside') {
      if (drag.hoverTarget !== tf) {
        drag.hoverTarget = tf;
        drag.hoverSince = Date.now();
      } else if (tf.classList.contains('collapsed') && Date.now() - drag.hoverSince > 700) {
        tf.classList.remove('collapsed');
        collapsed.delete(tf.dataset.id);
        saveCollapsed();
      }
    }
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
    if (target.mode === 'inside') moved = moveFolderTo(d.key, target.id);
    else if (target.mode === 'top') moved = moveFolderTo(d.key, null);
    else {
      const t = folderById(target.id);
      moved = t && moveFolderTo(d.key, t.parentId || null, target.mode === 'before' ? { beforeId: t.id } : { afterId: t.id });
    }
    if (moved && target.mode === 'inside') receivedFolder = target.id;
  }

  // Fly into the folder, or spring back to where it came from.
  ghost.classList.remove('lift');
  ghost.classList.add('settle');
  if (moved && (d.kind === 'item' || target.mode === 'inside')) {
    const h = target.el.querySelector('.folder-head').getBoundingClientRect();
    ghost.style.transform = `translate(${h.left + 12}px, ${h.top}px) scale(0.3)`;
    ghost.style.opacity = '0';
  } else if (moved) {
    const r = target.el.getBoundingClientRect();
    ghost.style.transform = `translate(${r.left}px, ${target.mode === 'after' ? r.bottom - 30 : r.top}px) scale(1)`;
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
    } else if (e.swatches) {
      const row = document.createElement('div');
      row.className = 'swatches';
      for (const [key, name] of [[null, 'No color'], ...COLORS]) {
        const b = document.createElement('button');
        b.className = 'sw' + (key ? ` c-${key}` : ' none') + ((e.current || null) === key ? ' on' : '');
        b.title = name;
        b.onclick = () => {
          closeMenu();
          e.onPick(key);
        };
        row.appendChild(b);
      }
      m.appendChild(row);
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
  const canNest = depthOf(f.id) < MAX_DEPTH;
  openMenu(x, y, [
    ...(canNest ? [{ text: 'New folder inside', action: () => newFolder(f) }] : []),
    { text: 'Rename folder', action: () => renameFolder(f) },
    { label: 'Color' },
    { swatches: true, current: f.color, onPick: (color) => setFolderColor(f, color) },
    ...(f.parentId ? ['-', { text: 'Move to top level', action: () => moveFolderTo(f.id, null) && render() }] : []),
    '-',
    { text: 'Delete folder', danger: true, action: () => deleteFolder(f) },
  ]);
}

function setFolderColor(f, color) {
  if ((f.color || null) === color) return;
  if (!send({ op: 'setFolderColor', id: f.id, color })) return;
  state.folders = state.folders.map((x) => (x.id === f.id ? { ...x, color } : x));
  render();
}

function itemMenu(entry, x, y) {
  const moveTo = folderPaths()
    .filter((p) => p.folder.id !== entry.folderId)
    .map((p) => ({ text: p.path, action: () => moveEntry(entry, p.folder.id) && render() }));
  openMenu(x, y, [
    { text: 'Jump to message', action: () => pf.openMessage(entry.data) },
    ...(moveTo.length ? ['-', { label: 'Move to' }, ...moveTo] : []),
    ...(entry.kind === 'filed'
      ? ['-', { text: 'Move to No Label', action: () => moveEntry(entry, 'nolabel') && render() }]
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

async function newFolder(parent = null) {
  if (foreignServer()) return toast('Add Pin Folders to this server first');
  if (!guildId) return toast('No server selected');
  const name = await ask({ title: parent ? `New folder inside "${parent.name}"` : 'New folder', value: '', ok: 'Create' });
  if (!name) return;
  if (send({ op: 'createFolder', guildId, name, parentId: parent ? parent.id : null }) && parent) {
    collapsed.delete(parent.id);
    saveCollapsed();
  }
}
async function renameFolder(f) {
  const name = await ask({ title: 'Rename folder', value: f.name, ok: 'Save' });
  if (name && name !== f.name) send({ op: 'renameFolder', id: f.id, name });
}
async function deleteFolder(f) {
  const yes = await ask({
    title: `Delete "${f.name}"?`,
    text: 'Its messages go back to No Label and any folders inside it move up one level. This is shared with everyone.',
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
$('#btn-new').onclick = () => newFolder();
$('#btn-invite').onclick = inviteBot;

// Gamer mode: a slow RGB glow through the UI. Personal setting, remembered on this PC.
function setGamer(on) {
  document.documentElement.classList.toggle('gamer', on);
  $('#gamer').setAttribute('aria-checked', String(on));
  try {
    localStorage.setItem('gamer', on ? '1' : '0');
  } catch {
    /* ignore */
  }
}
$('#gamer').onclick = () => setGamer(!document.documentElement.classList.contains('gamer'));
setGamer(localStorage.getItem('gamer') === '1');
$('#guild').onchange = (e) => {
  if (!e.target.value) return renderGuilds();
  setGuild(e.target.value, true);
  switchView();
};
$('#channel').onchange = (e) => {
  channelMode = e.target.value;
  view = { status: 'loading', pins: [], guildId: null, channelId: null, channelName: null, reason: '' };
  switchView(true);
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
