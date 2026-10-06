// Discord bot: lets people file any message into a shared folder from inside
// Discord (right-click a message > Apps > Add to folder).
const crypto = require('crypto');
const {
  Client,
  Events,
  GatewayIntentBits,
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require('discord.js');

const EPHEMERAL = { flags: MessageFlags.Ephemeral };

function startBot({ token, store, onChange }) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  const commands = [
    new ContextMenuCommandBuilder().setName('Add to folder').setType(ApplicationCommandType.Message),
    new SlashCommandBuilder()
      .setName('folder')
      .setDescription('Manage shared pin folders')
      .addSubcommand((s) =>
        s
          .setName('create')
          .setDescription('Create a folder')
          .addStringOption((o) => o.setName('name').setDescription('Folder name').setRequired(true).setMaxLength(60))
      )
      .addSubcommand((s) => s.setName('list').setDescription('List folders and how many messages each has')),
    new SlashCommandBuilder()
      .setName('importpins')
      .setDescription("Import this channel's pinned messages into a folder")
      .addStringOption((o) =>
        o.setName('folder').setDescription('Folder name (created if missing). Default: Imported pins').setMaxLength(60)
      ),
  ].map((c) => c.toJSON());

  async function register(guild) {
    try {
      await guild.commands.set(commands);
    } catch (e) {
      console.error(`Could not register commands in ${guild.name}:`, e.message);
    }
  }

  client.once(Events.ClientReady, async (c) => {
    console.log(`Bot online as ${c.user.tag} in ${c.guilds.cache.size} server(s)`);
    for (const g of c.guilds.cache.values()) await register(g);
    onChange();
  });
  client.on(Events.GuildCreate, async (g) => {
    await register(g);
    onChange();
  });
  client.on(Events.GuildDelete, () => onChange());
  client.on(Events.GuildUpdate, () => onChange());

  // Message snapshots waiting for the user to pick a folder.
  const pending = new Map();
  function remember(snap) {
    const key = crypto.randomBytes(6).toString('hex');
    pending.set(key, snap);
    setTimeout(() => pending.delete(key), 15 * 60 * 1000).unref();
    return key;
  }

  function displayName(interaction) {
    return interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (!interaction.inGuild()) return;

      // Right-click > Apps > Add to folder
      if (interaction.isMessageContextMenuCommand() && interaction.commandName === 'Add to folder') {
        const snap = snapshotOf(interaction.targetMessage, displayName(interaction));
        const key = remember(snap);
        const folders = store.foldersFor(interaction.guildId);
        const current = store.findItemByMessage(interaction.guildId, snap.messageId);
        const currentName = current?.folderId ? store.getFolder(current.folderId)?.name : null;

        const menu = new StringSelectMenuBuilder()
          .setCustomId(`pf-pick:${key}`)
          .setPlaceholder('Choose a folder')
          .addOptions(
            ...folders.slice(0, 24).map((f) => ({
              label: f.name,
              value: f.id,
              description: `${store.countIn(f.id)} message(s)`,
              default: current?.folderId === f.id,
            })),
            { label: 'New folder...', value: 'new', emoji: '➕' }
          );

        return interaction.reply({
          content: currentName ? `This message is currently in **${currentName}**. Move it to:` : 'Add this message to:',
          components: [new ActionRowBuilder().addComponents(menu)],
          ...EPHEMERAL,
        });
      }

      // Folder picked
      if (interaction.isStringSelectMenu() && interaction.customId.startsWith('pf-pick:')) {
        const key = interaction.customId.slice(8);
        const snap = pending.get(key);
        if (!snap) return interaction.update({ content: 'That expired, please try again.', components: [] });
        const choice = interaction.values[0];

        if (choice === 'new') {
          const modal = new ModalBuilder()
            .setCustomId(`pf-new:${key}`)
            .setTitle('New folder')
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId('name')
                  .setLabel('Folder name')
                  .setStyle(TextInputStyle.Short)
                  .setMaxLength(60)
                  .setRequired(true)
              )
            );
          return interaction.showModal(modal);
        }

        const folder = store.getFolder(choice);
        if (!folder) return interaction.update({ content: 'That folder no longer exists.', components: [] });
        store.upsertItem(snap, folder.id);
        pending.delete(key);
        onChange();
        return interaction.update({ content: `Added to **${folder.name}**.`, components: [] });
      }

      // New folder name submitted
      if (interaction.isModalSubmit() && interaction.customId.startsWith('pf-new:')) {
        const key = interaction.customId.slice(7);
        const snap = pending.get(key);
        const done = (content) =>
          interaction.isFromMessage() ? interaction.update({ content, components: [] }) : interaction.reply({ content, ...EPHEMERAL });
        if (!snap) return done('That expired, please try again.');
        const folder = store.createFolder(interaction.guildId, interaction.fields.getTextInputValue('name'), displayName(interaction));
        store.upsertItem(snap, folder.id);
        pending.delete(key);
        onChange();
        return done(`Added to **${folder.name}**.`);
      }

      if (interaction.isChatInputCommand() && interaction.commandName === 'folder') {
        if (interaction.options.getSubcommand() === 'create') {
          const f = store.createFolder(interaction.guildId, interaction.options.getString('name', true), displayName(interaction));
          onChange();
          return interaction.reply({ content: `Folder **${f.name}** is ready.`, ...EPHEMERAL });
        }
        const folders = store.foldersFor(interaction.guildId);
        const unsorted = store.data.items.filter((i) => i.guildId === interaction.guildId && !i.folderId).length;
        const lines = folders.map((f) => `• **${f.name}** (${store.countIn(f.id)})`);
        if (unsorted) lines.push(`• *Unsorted* (${unsorted})`);
        return interaction.reply({ content: lines.length ? lines.join('\n') : 'No folders yet.', ...EPHEMERAL });
      }

      if (interaction.isChatInputCommand() && interaction.commandName === 'importpins') {
        await interaction.deferReply(EPHEMERAL);
        const name = interaction.options.getString('folder') || 'Imported pins';
        const messages = await fetchAllPins(interaction.channel);
        const folder = store.createFolder(interaction.guildId, name, displayName(interaction));
        let added = 0;
        for (const m of messages) {
          if (store.findItemByMessage(interaction.guildId, m.id)) continue; // keep existing sorting
          store.upsertItem(snapshotOf(m, displayName(interaction)), folder.id);
          added++;
        }
        onChange();
        return interaction.editReply(
          `Imported ${added} pinned message(s) into **${folder.name}**` +
            (messages.length - added ? ` (${messages.length - added} were already filed).` : '.')
        );
      }
    } catch (e) {
      console.error(e);
      const msg = { content: `Something went wrong: ${e.message}`, ...EPHEMERAL };
      if (interaction.deferred) interaction.editReply(msg.content).catch(() => {});
      else if (interaction.isRepliable() && !interaction.replied) interaction.reply(msg).catch(() => {});
    }
  });

  client.login(token);

  return {
    getGuilds() {
      return client.guilds.cache.map((g) => ({
        id: g.id,
        name: g.name,
        icon: g.iconURL({ size: 64, extension: 'png' }),
      }));
    },
  };
}

function snapshotOf(message, addedBy) {
  const embed = message.embeds?.[0];
  const embedText = embed ? [embed.title, embed.description].filter(Boolean).join(' - ') : '';
  return {
    guildId: message.guildId,
    channelId: message.channelId,
    channelName: message.channel?.name || null,
    messageId: message.id,
    authorName: message.member?.displayName || message.author?.globalName || message.author?.username || 'Unknown',
    authorAvatar: message.author?.displayAvatarURL({ size: 64, extension: 'png' }) || null,
    content: (message.content || embedText || '').slice(0, 1500),
    attachments: [...(message.attachments?.values() || [])].slice(0, 4).map((a) => ({
      name: a.name,
      url: a.url,
      contentType: a.contentType || null,
    })),
    createdAt: message.createdTimestamp,
    addedBy,
    addedAt: Date.now(),
  };
}

// Supports both the newer paginated pins API and the older one.
async function fetchAllPins(channel) {
  const out = [];
  if (typeof channel.messages.fetchPins === 'function') {
    let before;
    for (let page = 0; page < 20; page++) {
      const res = await channel.messages.fetchPins(before ? { before } : {});
      const items = res.items ?? [];
      for (const it of items) out.push(it.message);
      if (!res.hasMore || !items.length) break;
      before = items[items.length - 1].pinnedAt;
    }
  } else {
    const col = await channel.messages.fetchPinned();
    out.push(...col.values());
  }
  return out;
}

module.exports = { startBot };
