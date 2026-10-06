// HTTP + WebSocket server. Every panel connects here; any change is
// broadcast to everyone instantly.
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

function createSyncServer({ store, getGuilds, accessKey }) {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, clients: wss.clients.size }));
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Pin Folders server is running.');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws' || !safeEqual(url.searchParams.get('key') || '', accessKey)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  function snapshot() {
    const guilds = getGuilds();
    const ids = new Set(guilds.map((g) => g.id));
    return {
      type: 'state',
      guilds,
      folders: store.data.folders.filter((f) => ids.has(f.guildId)),
      items: store.data.items.filter((i) => ids.has(i.guildId)),
    };
  }

  let pending = null;
  function broadcast() {
    // Coalesce bursts (e.g. importing 50 pins) into one push.
    if (pending) return;
    pending = setImmediate(() => {
      pending = null;
      const msg = JSON.stringify(snapshot());
      for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
    });
  }

  function requireGuild(guildId) {
    if (!getGuilds().some((g) => g.id === guildId)) throw new Error('Unknown server');
  }

  function handle(m) {
    switch (m.op) {
      case 'createFolder':
        requireGuild(m.guildId);
        store.createFolder(m.guildId, m.name, m.by || null);
        break;
      case 'renameFolder':
        store.renameFolder(m.id, m.name);
        break;
      case 'deleteFolder':
        store.deleteFolder(m.id);
        break;
      case 'reorderFolders':
        requireGuild(m.guildId);
        if (!Array.isArray(m.ids)) throw new Error('Bad order');
        store.reorderFolders(m.guildId, m.ids.map(String));
        break;
      case 'moveItem':
        store.moveItem(m.id, m.folderId || null);
        break;
      case 'removeItem':
        store.removeItem(m.id);
        break;
      default:
        throw new Error('Unknown operation');
    }
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.send(JSON.stringify(snapshot()));
    ws.on('message', (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (m.op === 'ping') return ws.send('{"type":"pong"}');
      try {
        handle(m);
        broadcast();
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', message: e.message }));
      }
    });
  });

  const hb = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  server.on('close', () => clearInterval(hb));

  return { server, broadcast, wss };
}

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

module.exports = { createSyncServer };
