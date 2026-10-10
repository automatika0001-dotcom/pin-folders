// Shared helpers for talking to Discord's REST API and turning messages
// into the small "snapshot" objects the panel displays.
export const API = 'https://discord.com/api/v10';

export async function discordGet(path, token) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bot ${token}` } });
  if (!res.ok) {
    const err = new Error(
      res.status === 403
        ? 'the bot cannot see this channel (it needs View Channels and Read Message History here)'
        : `Discord returned ${res.status}`
    );
    err.status = res.status;
    if (res.status === 429) err.retryAfter = Number(res.headers.get('retry-after')) || 2;
    throw err;
  }
  return res.json();
}

// Uses the newer paginated pins endpoint, falling back to the older one.
export async function fetchAllPins(channelId, token) {
  const out = [];
  let before = null;
  for (let page = 0; page < 10; page++) {
    const qs = new URLSearchParams({ limit: '50' });
    if (before) qs.set('before', before);
    let body;
    try {
      body = await discordGet(`/channels/${channelId}/messages/pins?${qs}`, token);
    } catch (e) {
      if (e.status === 404 && page === 0) return discordGet(`/channels/${channelId}/pins`, token);
      throw e;
    }
    const items = body.items || [];
    out.push(...items.map((x) => ({ ...x.message, pinned_at: x.pinned_at })));
    if (!body.has_more || !items.length) break;
    before = items[items.length - 1].pinned_at;
  }
  return out;
}

// Text-like channels that can have pins, in sidebar order.
export async function fetchChannels(guildId, token) {
  const list = await discordGet(`/guilds/${guildId}/channels`, token);
  const cats = new Map(list.filter((c) => c.type === 4).map((c) => [c.id, c.position]));
  return list
    .filter((c) => c.type === 0 || c.type === 5)
    .map((c) => ({ id: c.id, name: c.name, parent: c.parent_id || null, position: c.position }))
    .sort((a, b) => (cats.get(a.parent) ?? -1) - (cats.get(b.parent) ?? -1) || a.position - b.position)
    .map(({ id, name }) => ({ id, name }));
}

export function snapshotOf(m, { guildId, channelId, channelName }, addedBy) {
  const author = m.author || {};
  const embed = m.embeds?.[0];
  const embedText = embed ? [embed.title, embed.description].filter(Boolean).join(' - ') : '';
  let avatar = null;
  if (author.avatar) avatar = `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.png?size=64`;
  else if (author.id) avatar = `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(author.id) >> 22n) % 6n)}.png`;
  return {
    guildId,
    channelId: m.channel_id || channelId,
    channelName: channelName || null,
    messageId: m.id,
    authorName: m.member?.nick || author.global_name || author.username || 'Unknown',
    authorAvatar: avatar,
    content: (m.content || embedText || '').slice(0, 1500),
    attachments: (m.attachments || []).slice(0, 4).map((a) => ({
      name: a.filename,
      url: a.url,
      contentType: a.content_type || null,
    })),
    createdAt: Date.parse(m.timestamp) || Date.now(),
    pinnedAt: Date.parse(m.pinned_at) || null, // when it was pinned (newer Discord API only)
    addedBy,
    addedAt: Date.now(),
  };
}
