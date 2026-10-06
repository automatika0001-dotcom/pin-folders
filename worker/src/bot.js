// Discord side: handles "Apps > Add to folder", /folder and /importpins.
// Discord calls us over HTTPS (Interactions Endpoint URL), so no always-on
// bot connection is needed. This is why the bot shows as offline in the
// member list even though everything works.
const API = 'https://discord.com/api/v10';
const EPHEMERAL = 64;

const COMMANDS = [
  { name: 'Add to folder', type: 3, contexts: [0], integration_types: [0] },
  {
    name: 'folder',
    type: 1,
    description: 'Manage shared pin folders',
    contexts: [0],
    integration_types: [0],
    options: [
      {
        type: 1,
        name: 'create',
        description: 'Create a folder',
        options: [{ type: 3, name: 'name', description: 'Folder name', required: true, max_length: 60 }],
      },
      { type: 1, name: 'list', description: 'List folders and how many messages each has' },
    ],
  },
  {
    name: 'importpins',
    type: 1,
    description: "Import this channel's pinned messages into a folder",
    contexts: [0],
    integration_types: [0],
    options: [
      { type: 3, name: 'folder', description: 'Folder name (created if missing). Default: Imported pins', max_length: 60 },
    ],
  },
];

export async function registerCommands(env) {
  if (!env.DISCORD_APPLICATION_ID || !env.DISCORD_TOKEN) {
    return text('DISCORD_APPLICATION_ID and DISCORD_TOKEN must be set first.', 400);
  }
  const res = await fetch(`${API}/applications/${env.DISCORD_APPLICATION_ID}/commands`, {
    method: 'PUT',
    headers: { Authorization: `Bot ${env.DISCORD_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(COMMANDS),
  });
  if (!res.ok) return text(`Discord refused the commands (${res.status}):\n${await res.text()}`, 500);
  return text('Done! The bot commands are registered. In Discord, press Ctrl+R if "Add to folder" doesn\'t show up yet.');
}

export async function handleInteraction(i, env, ctx, hub) {
  try {
    if (!i.guild_id) return reply('Pin Folders only works inside a server.');
    const by = i.member?.nick || i.member?.user?.global_name || i.member?.user?.username || 'Someone';

    // Right-click a message > Apps > Add to folder
    if (i.type === 2 && i.data.type === 3 && i.data.name === 'Add to folder') {
      const message = i.data.resolved?.messages?.[i.data.target_id];
      if (!message) return reply('Could not read that message.');
      const snap = snapshotOf(message, i, by);
      const [key, folders, current] = await Promise.all([
        hub.putPending(snap),
        hub.foldersWithCounts(i.guild_id),
        hub.currentFolder(i.guild_id, snap.messageId),
      ]);
      return Response.json({
        type: 4,
        data: {
          flags: EPHEMERAL,
          content: current ? `This message is currently in **${current.name}**. Move it to:` : 'Add this message to:',
          components: [
            {
              type: 1,
              components: [
                {
                  type: 3,
                  custom_id: `pf-pick:${key}`,
                  placeholder: 'Choose a folder',
                  options: [
                    ...folders.slice(0, 24).map((f) => ({
                      label: f.name.slice(0, 100),
                      value: f.id,
                      description: `${f.count} message(s)`,
                      default: current?.id === f.id,
                    })),
                    { label: 'New folder...', value: 'new', emoji: { name: '➕' } },
                  ],
                },
              ],
            },
          ],
        },
      });
    }

    // A folder was picked from the menu
    if (i.type === 3 && i.data.custom_id?.startsWith('pf-pick:')) {
      const key = i.data.custom_id.slice(8);
      const choice = i.data.values?.[0];
      if (choice === 'new') {
        if (!(await hub.hasPending(key))) return update('That expired, please try again.');
        return Response.json({
          type: 9,
          data: {
            custom_id: `pf-new:${key}`,
            title: 'New folder',
            components: [
              {
                type: 1,
                components: [{ type: 4, custom_id: 'name', label: 'Folder name', style: 1, max_length: 60, required: true }],
              },
            ],
          },
        });
      }
      const r = await hub.fileFromPending(key, choice);
      if (r.status === 'expired') return update('That expired, please try again.');
      if (r.status === 'nofolder') return update('That folder no longer exists.');
      return update(`Added to **${r.folderName}**.`);
    }

    // New folder name typed in the pop-up
    if (i.type === 5 && i.data.custom_id?.startsWith('pf-new:')) {
      const key = i.data.custom_id.slice(7);
      const r = await hub.fileFromPendingNewFolder(key, modalValue(i.data.components, 'name'), by);
      if (r.status === 'expired') return update('That expired, please try again.');
      return update(`Added to **${r.folderName}**.`);
    }

    if (i.type === 2 && i.data.name === 'folder') {
      const sub = i.data.options?.[0];
      if (sub?.name === 'create') {
        const name = await hub.createFolderFromBot(i.guild_id, optionValue(sub.options, 'name'), by);
        return reply(`Folder **${name}** is ready.`);
      }
      const [folders, unsorted] = await Promise.all([hub.foldersWithCounts(i.guild_id), hub.unsortedCount(i.guild_id)]);
      const lines = folders.map((f) => `• **${f.name}** (${f.count})`);
      if (unsorted) lines.push(`• *Unsorted* (${unsorted})`);
      return reply(lines.length ? lines.join('\n') : 'No folders yet.');
    }

    if (i.type === 2 && i.data.name === 'importpins') {
      const folderName = optionValue(i.data.options, 'folder') || 'Imported pins';
      // Answer right away ("thinking..."), then do the work in the background.
      ctx.waitUntil(importPins(i, env, hub, folderName, by));
      return Response.json({ type: 5, data: { flags: EPHEMERAL } });
    }

    return reply('Unknown command.');
  } catch (e) {
    console.log('Interaction error:', e.stack || e.message);
    return reply(`Something went wrong: ${e.message}`);
  }
}

async function importPins(i, env, hub, folderName, by) {
  let content;
  try {
    const messages = await fetchAllPins(i.channel_id, env.DISCORD_TOKEN);
    const snaps = messages.map((m) => snapshotOf(m, i, by));
    const r = await hub.importSnapshots(i.guild_id, folderName, snaps, by);
    content =
      `Imported ${r.added} pinned message(s) into **${r.folderName}**` + (r.skipped ? ` (${r.skipped} were already filed).` : '.');
  } catch (e) {
    content = `Import failed: ${e.message}`;
  }
  await fetch(`${API}/webhooks/${env.DISCORD_APPLICATION_ID}/${i.token}/messages/@original`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

// Uses the newer paginated pins endpoint, falling back to the older one.
async function fetchAllPins(channelId, token) {
  const headers = { Authorization: `Bot ${token}` };
  const out = [];
  let before = null;
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ limit: '50' });
    if (before) qs.set('before', before);
    const res = await fetch(`${API}/channels/${channelId}/messages/pins?${qs}`, { headers });
    if (res.status === 404 && page === 0) {
      const old = await fetch(`${API}/channels/${channelId}/pins`, { headers });
      if (!old.ok) throw new Error(pinsError(old.status));
      return old.json();
    }
    if (!res.ok) throw new Error(pinsError(res.status));
    const body = await res.json();
    const items = body.items || [];
    out.push(...items.map((x) => x.message));
    if (!body.has_more || !items.length) break;
    before = items[items.length - 1].pinned_at;
  }
  return out;
}

function pinsError(status) {
  return status === 403
    ? 'the bot cannot see this channel (it needs View Channels and Read Message History here)'
    : `Discord returned ${status}`;
}

function snapshotOf(m, i, addedBy) {
  const author = m.author || {};
  const embed = m.embeds?.[0];
  const embedText = embed ? [embed.title, embed.description].filter(Boolean).join(' - ') : '';
  let avatar = null;
  if (author.avatar) avatar = `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.png?size=64`;
  else if (author.id) avatar = `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(author.id) >> 22n) % 6n)}.png`;
  return {
    guildId: i.guild_id,
    channelId: m.channel_id || i.channel_id,
    channelName: i.channel?.name || null,
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
    addedBy,
    addedAt: Date.now(),
  };
}

function optionValue(options, name) {
  return options?.find((o) => o.name === name)?.value ?? null;
}

function modalValue(rows, id) {
  for (const row of rows || []) {
    const comps = row.components || (row.component ? [row.component] : []);
    for (const c of comps) if (c.custom_id === id) return c.value;
  }
  return '';
}

const reply = (content) => Response.json({ type: 4, data: { content, flags: EPHEMERAL } });
const update = (content) => Response.json({ type: 7, data: { content, components: [] } });
const text = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
