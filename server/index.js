require('dotenv').config();
const path = require('path');
const { Store } = require('./store');
const { createSyncServer } = require('./sync');
const { startBot } = require('./bot');

const { DISCORD_TOKEN, ACCESS_KEY } = process.env;
const PORT = Number(process.env.PORT) || 8080;

if (!DISCORD_TOKEN || !ACCESS_KEY) {
  console.error('Missing DISCORD_TOKEN or ACCESS_KEY. See .env.example');
  process.exit(1);
}

const store = new Store(process.env.DATA_DIR || path.join(__dirname, 'data'));

let bot = null;
const sync = createSyncServer({
  store,
  accessKey: ACCESS_KEY,
  getGuilds: () => (bot ? bot.getGuilds() : []),
});

bot = startBot({ token: DISCORD_TOKEN, store, onChange: sync.broadcast });

sync.server.listen(PORT, () => console.log(`Sync server listening on :${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    store.flush();
    process.exit(0);
  });
}
