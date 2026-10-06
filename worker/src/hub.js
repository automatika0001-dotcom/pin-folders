// The Hub is a single Durable Object: it stores all folders in SQLite and
// holds every panel's live WebSocket. Any change is pushed to all panels.
// WebSockets use hibernation, so idle connections cost (almost) nothing.
import { DurableObject } from 'cloudflare:workers';
import { fetchAllPins, fetchChannels, snapshotOf } from './discordApi.js';

const GUILD_CACHE_MS = 10 * 60 * 1000;
const PENDING_TTL_MS = 15 * 60 * 1000;
const CHANNEL_CACHE_MS = 10 * 60 * 1000;
const PIN_CACHE_MS = 20 * 1000;

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, name TEXT NOT NULL,
      position INTEGER NOT NULL, created_by TEXT, created_at INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, message_id TEXT NOT NULL,
      folder_id TEXT, data TEXT NOT NULL, added_at INTEGER,
      UNIQUE (guild_id, message_id))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS pending (key TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
    // Keep-alive pings are answered without waking the object up.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"op":"ping"}', '{"type":"pong"}'));
  }

  // ---------- live connections ----------
  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify(await this.snapshot()));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.op === 'ping') return ws.send('{"type":"pong"}');
    try {
      const result = await this.applyOp(m);
      if (result?.reply) ws.send(JSON.stringify(result.reply));
      if (!result?.quiet) await this.broadcast();
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
    }
  }

  webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }

  async broadcast() {
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return;
    const msg = JSON.stringify(await this.snapshot());
    for (const ws of sockets) {
      try {
        ws.send(msg);
      } catch {
        /* dropped connection */
      }
    }
  }

  async snapshot() {
    const guilds = await this.guilds();
    const ids = new Set(guilds.map((g) => g.id));
    const folders = this.sql
      .exec('SELECT id, guild_id, name, position FROM folders ORDER BY position')
      .toArray()
      .filter((f) => ids.has(f.guild_id))
      .map((f) => ({ id: f.id, guildId: f.guild_id, name: f.name, position: f.position }));
    const items = this.sql
      .exec('SELECT id, guild_id, folder_id, data FROM items')
      .toArray()
      .filter((i) => ids.has(i.guild_id))
      .map((i) => ({ ...JSON.parse(i.data), id: i.id, guildId: i.guild_id, folderId: i.folder_id }));
    return { type: 'state', guilds, folders, items };
  }

  // Servers the bot is in (cached; refreshed from Discord every 10 minutes).
  async guilds(force = false) {
    if (this.env.DEV_GUILDS) return JSON.parse(this.env.DEV_GUILDS);
    if (!force && this.guildCache && Date.now() - this.guildCache.at < GUILD_CACHE_MS) return this.guildCache.list;
    const stored = this.sql.exec("SELECT value FROM meta WHERE key = 'guilds'").toArray()[0];
    const cached = stored ? JSON.parse(stored.value) : { at: 0, list: [] };
    if (!force && Date.now() - cached.at < GUILD_CACHE_MS) {
      this.guildCache = cached;
      return cached.list;
    }
    try {
      const res = await fetch('https://discord.com/api/v10/users/@me/guilds?limit=200', {
        headers: { Authorization: `Bot ${this.env.DISCORD_TOKEN}` },
      });
      if (!res.ok) throw new Error(`Discord said ${res.status}`);
      const list = (await res.json()).map((g) => ({
        id: g.id,
        name: g.name,
        icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64` : null,
      }));
      const fresh = { at: Date.now(), list };
      this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('guilds', ?)", JSON.stringify(fresh));
      this.guildCache = fresh;
      return list;
    } catch (e) {
      console.log('Could not refresh server list:', e.message);
      this.guildCache = { at: Date.now() - GUILD_CACHE_MS + 60000, list: cached.list }; // retry in a minute
      return cached.list;
    }
  }

  async requireGuild(guildId) {
    let list = await this.guilds();
    if (!list.some((g) => g.id === guildId)) list = await this.guilds(true); // bot may have just joined
    if (!list.some((g) => g.id === guildId)) throw new Error('Unknown server');
  }

  // ---------- operations from the panel ----------
  async applyOp(m) {
    switch (m.op) {
      case 'createFolder':
        await this.requireGuild(m.guildId);
        return this.createFolder(m.guildId, m.name, m.by || null);
      case 'renameFolder': {
        const name = cleanName(m.name);
        if (!name) throw new Error('Folder name cannot be empty');
        if (!this.getFolder(m.id)) throw new Error('Folder not found');
        this.sql.exec('UPDATE folders SET name = ? WHERE id = ?', name, m.id);
        return;
      }
      case 'deleteFolder':
        if (!this.getFolder(m.id)) throw new Error('Folder not found');
        this.sql.exec('UPDATE items SET folder_id = NULL WHERE folder_id = ?', m.id);
        this.sql.exec('DELETE FROM folders WHERE id = ?', m.id);
        return;
      case 'reorderFolders': {
        if (!Array.isArray(m.ids)) throw new Error('Bad order');
        const rank = new Map(m.ids.map((id, i) => [String(id), i]));
        this.foldersFor(m.guildId)
          .sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9))
          .forEach((f, i) => this.sql.exec('UPDATE folders SET position = ? WHERE id = ?', i, f.id));
        return;
      }
      case 'moveItem': {
        const it = this.sql.exec('SELECT guild_id FROM items WHERE id = ?', m.id).toArray()[0];
        if (!it) throw new Error('Item not found');
        if (m.folderId) {
          const f = this.getFolder(m.folderId);
          if (!f || f.guild_id !== it.guild_id) throw new Error('Folder not found');
        }
        this.sql.exec('UPDATE items SET folder_id = ? WHERE id = ?', m.folderId || null, m.id);
        return;
      }
      case 'removeItem':
        this.sql.exec('DELETE FROM items WHERE id = ?', m.id);
        return;
      // ----- current channel's pins (answered only to the asking panel) -----
      case 'viewChannel':
        return { quiet: true, reply: await this.viewChannel(m) };
      case 'listChannels':
        await this.requireGuild(m.guildId);
        return { quiet: true, reply: { type: 'channels', guildId: m.guildId, channels: await this.channelsFor(m.guildId) } };
      case 'fileFromChannel':
        return this.fileFromChannel(m);
      default:
        throw new Error('Unknown operation');
    }
  }

  // ---------- current channel's pins ----------
  async channelsFor(guildId) {
    if (this.env.DEV_FIXTURES) return JSON.parse(this.env.DEV_FIXTURES).channels?.[guildId] || [];
    this.chanCache ||= new Map();
    const hit = this.chanCache.get(guildId);
    if (hit && Date.now() - hit.at < CHANNEL_CACHE_MS) return hit.list;
    const list = await fetchChannels(guildId, this.env.DISCORD_TOKEN);
    this.chanCache.set(guildId, { at: Date.now(), list });
    return list;
  }

  async pinsFor(guildId, channel, force = false) {
    this.pinCache ||= new Map();
    const hit = this.pinCache.get(channel.id);
    if (!force && hit && Date.now() - hit.at < PIN_CACHE_MS) return hit.pins;
    const raw = this.env.DEV_FIXTURES
      ? JSON.parse(this.env.DEV_FIXTURES).pins?.[channel.id] || []
      : await fetchAllPins(channel.id, this.env.DISCORD_TOKEN);
    const pins = raw.map((m) => snapshotOf(m, { guildId, channelId: channel.id, channelName: channel.name }, null));
    this.pinCache.set(channel.id, { at: Date.now(), pins });
    return pins;
  }

  // Works out which channel Discord is showing from its window title,
  // e.g. "#general | My Server - Discord".
  async resolveTitle(title) {
    const t = String(title || '').toLowerCase();
    if (!t) return null;
    const guilds = [...(await this.guilds())].sort((a, b) => b.name.length - a.name.length);
    const named = guilds.find((g) => t.includes(g.name.toLowerCase()));
    const candidates = named ? [named] : guilds.slice(0, 10);
    const segments = t.split(/\s+[|\-\u2013\u2014]\s+/).map((x) => x.trim().replace(/^#/, ''));
    for (const g of candidates) {
      const chans = await this.channelsFor(g.id);
      const byHash = chans
        .filter((c) => t.includes('#' + c.name.toLowerCase()))
        .sort((a, b) => b.name.length - a.name.length)[0];
      const ch = byHash || chans.find((c) => segments.includes(c.name.toLowerCase()));
      if (ch) return { guildId: g.id, channel: ch };
    }
    return null;
  }

  async viewChannel(m) {
    const base = { type: 'channel', reqId: m.reqId ?? null };
    try {
      let target = null;
      if (m.guildId && m.channelId) {
        await this.requireGuild(m.guildId);
        const ch = (await this.channelsFor(m.guildId)).find((c) => c.id === m.channelId);
        if (!ch) throw new Error('Channel not found');
        target = { guildId: m.guildId, channel: ch };
      } else if (m.title) {
        target = await this.resolveTitle(m.title);
      }
      if (!target) return { ...base, ok: false, reason: 'no-match' };
      const pins = await this.pinsFor(target.guildId, target.channel, !!m.force);
      return { ...base, ok: true, guildId: target.guildId, channelId: target.channel.id, channelName: target.channel.name, pins };
    } catch (e) {
      return { ...base, ok: false, reason: e.message };
    }
  }

  async fileFromChannel(m) {
    await this.requireGuild(m.guildId);
    const folder = this.getFolder(m.folderId);
    if (!folder || folder.guild_id !== m.guildId) throw new Error('Folder not found');
    const ch = (await this.channelsFor(m.guildId)).find((c) => c.id === m.channelId);
    if (!ch) throw new Error('Channel not found');
    let pin = (await this.pinsFor(m.guildId, ch)).find((p) => p.messageId === m.messageId);
    if (!pin) pin = (await this.pinsFor(m.guildId, ch, true)).find((p) => p.messageId === m.messageId);
    if (!pin) throw new Error('That message is no longer pinned');
    this.upsertItem({ ...pin, addedBy: m.by || null, addedAt: Date.now() }, folder.id);
  }

  // ---------- storage helpers ----------
  getFolder(id) {
    return this.sql.exec('SELECT * FROM folders WHERE id = ?', id).toArray()[0] || null;
  }

  foldersFor(guildId) {
    return this.sql.exec('SELECT * FROM folders WHERE guild_id = ? ORDER BY position', guildId).toArray();
  }

  createFolder(guildId, name, createdBy) {
    const clean = cleanName(name);
    if (!clean) throw new Error('Folder name cannot be empty');
    const existing = this.foldersFor(guildId).find((f) => f.name.toLowerCase() === clean.toLowerCase());
    if (existing) return existing;
    const max = this.sql.exec('SELECT MAX(position) AS p FROM folders WHERE guild_id = ?', guildId).toArray()[0]?.p;
    const folder = {
      id: crypto.randomUUID(),
      guild_id: guildId,
      name: clean,
      position: max == null ? 0 : max + 1,
      created_by: createdBy,
      created_at: Date.now(),
    };
    this.sql.exec(
      'INSERT INTO folders (id, guild_id, name, position, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      folder.id, folder.guild_id, folder.name, folder.position, folder.created_by, folder.created_at
    );
    return folder;
  }

  upsertItem(snap, folderId) {
    const existing = this.sql
      .exec('SELECT id FROM items WHERE guild_id = ? AND message_id = ?', snap.guildId, snap.messageId)
      .toArray()[0];
    if (existing) {
      this.sql.exec('UPDATE items SET folder_id = ?, data = ? WHERE id = ?', folderId, JSON.stringify(snap), existing.id);
    } else {
      this.sql.exec(
        'INSERT INTO items (id, guild_id, message_id, folder_id, data, added_at) VALUES (?, ?, ?, ?, ?, ?)',
        crypto.randomUUID(), snap.guildId, snap.messageId, folderId, JSON.stringify(snap), Date.now()
      );
    }
  }

  // ---------- called by the Discord bot (RPC) ----------
  foldersWithCounts(guildId) {
    return this.sql
      .exec(
        `SELECT f.id, f.name, (SELECT COUNT(*) FROM items i WHERE i.folder_id = f.id) AS count
         FROM folders f WHERE f.guild_id = ? ORDER BY f.position`,
        guildId
      )
      .toArray();
  }

  unsortedCount(guildId) {
    return this.sql.exec('SELECT COUNT(*) AS n FROM items WHERE guild_id = ? AND folder_id IS NULL', guildId).toArray()[0].n;
  }

  currentFolder(guildId, messageId) {
    return (
      this.sql
        .exec(
          `SELECT f.id, f.name FROM items i JOIN folders f ON f.id = i.folder_id
           WHERE i.guild_id = ? AND i.message_id = ?`,
          guildId, messageId
        )
        .toArray()[0] || null
    );
  }

  putPending(snap) {
    this.sql.exec('DELETE FROM pending WHERE created_at < ?', Date.now() - PENDING_TTL_MS);
    const key = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    this.sql.exec('INSERT INTO pending (key, data, created_at) VALUES (?, ?, ?)', key, JSON.stringify(snap), Date.now());
    return key;
  }

  hasPending(key) {
    return this.sql.exec('SELECT 1 FROM pending WHERE key = ?', key).toArray().length > 0;
  }

  takePending(key) {
    const row = this.sql.exec('SELECT data FROM pending WHERE key = ?', key).toArray()[0];
    if (!row) return null;
    this.sql.exec('DELETE FROM pending WHERE key = ?', key);
    return JSON.parse(row.data);
  }

  async fileFromPending(key, folderId) {
    const folder = this.getFolder(folderId);
    if (!folder) return { status: 'nofolder' };
    const snap = this.takePending(key);
    if (!snap) return { status: 'expired' };
    this.upsertItem(snap, folder.id);
    await this.broadcast();
    return { status: 'ok', folderName: folder.name };
  }

  async fileFromPendingNewFolder(key, name, by) {
    const snap = this.takePending(key);
    if (!snap) return { status: 'expired' };
    const folder = this.createFolder(snap.guildId, name, by);
    this.upsertItem(snap, folder.id);
    await this.broadcast();
    return { status: 'ok', folderName: folder.name };
  }

  async createFolderFromBot(guildId, name, by) {
    const folder = this.createFolder(guildId, name, by);
    await this.broadcast();
    return folder.name;
  }

  async importSnapshots(guildId, folderName, snaps, by) {
    const folder = this.createFolder(guildId, folderName, by);
    let added = 0;
    for (const s of snaps) {
      const exists = this.sql
        .exec('SELECT 1 FROM items WHERE guild_id = ? AND message_id = ?', guildId, s.messageId)
        .toArray().length;
      if (exists) continue; // keep how people already sorted it
      this.upsertItem(s, folder.id);
      added++;
    }
    await this.broadcast();
    return { added, skipped: snaps.length - added, folderName: folder.name };
  }
}

function cleanName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
}
