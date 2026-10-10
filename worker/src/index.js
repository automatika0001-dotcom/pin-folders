// Entry point. Routes:
//   GET  /              status page (shows which settings are missing)
//   GET  /ws?key=...    live connection for the panel app
//   POST /interactions  Discord sends commands / menu clicks here
//   GET  /setup?key=... registers the bot's commands with Discord (run once)
import { Hub, SERVER_VERSION } from './hub.js';
import { handleInteraction, registerCommands } from './bot.js';

export { Hub };

const REQUIRED = ['DISCORD_TOKEN', 'DISCORD_PUBLIC_KEY', 'DISCORD_APPLICATION_ID', 'ACCESS_KEY'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const hub = () => env.HUB.get(env.HUB.idFromName('main'));

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
      if (!env.ACCESS_KEY || !(await sameSecret(url.searchParams.get('key'), env.ACCESS_KEY))) {
        return new Response('Unauthorized', { status: 401 });
      }
      return hub().fetch(request);
    }

    if (url.pathname === '/interactions' && request.method === 'POST') {
      const body = await request.text();
      if (!(await verifyDiscordRequest(request, body, env.DISCORD_PUBLIC_KEY))) {
        return new Response('Invalid request signature', { status: 401 });
      }
      const interaction = JSON.parse(body);
      if (interaction.type === 1) return Response.json({ type: 1 }); // Discord's endpoint check
      return handleInteraction(interaction, env, ctx, hub());
    }

    if (url.pathname === '/setup') {
      if (!env.ACCESS_KEY || !(await sameSecret(url.searchParams.get('key'), env.ACCESS_KEY))) {
        return new Response('Add ?key=YOUR_ACCESS_KEY to the address.', { status: 401 });
      }
      return registerCommands(env);
    }

    const missing = REQUIRED.filter((k) => !env[k]);
    const text = missing.length
      ? `Pin Folders server is running, but these settings are missing:\n\n${missing.join('\n')}\n\nAdd them in Cloudflare: Worker > Settings > Variables and Secrets (type: Secret).`
      : `Pin Folders server is running. All settings are present. (server ${SERVER_VERSION})`;
    return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },
};

// ---------- helpers ----------
async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a ?? ''))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b ?? ''))),
  ]);
  return crypto.subtle.timingSafeEqual(x, y);
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

let cachedKey = null;
async function verifyDiscordRequest(request, body, publicKey) {
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');
  if (!signature || !timestamp || !publicKey || !/^[0-9a-f]{64}$/i.test(publicKey.trim())) return false;
  try {
    if (!cachedKey || cachedKey.hex !== publicKey) {
      const key = await crypto.subtle.importKey('raw', hexToBytes(publicKey.trim()), { name: 'Ed25519' }, false, ['verify']);
      cachedKey = { hex: publicKey, key };
    }
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      cachedKey.key,
      hexToBytes(signature),
      new TextEncoder().encode(timestamp + body)
    );
  } catch {
    return false;
  }
}
