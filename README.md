# Pin Folders

A side panel that docks next to the real Discord app and lets your group sort pinned messages into shared folders. Everyone running the panel sees every change live.

```
pin-folders/
  server/   bot + live sync server (runs 24/7 in the cloud)
  app/      the Windows side panel (auto-updates from GitHub Releases)
  .github/workflows/release.yml   builds and publishes app updates
```

**What the panel does**

- On launch it starts Discord (or brings it back from the tray) and fits Discord + panel side by side on the screen.
- Drag the panel and Discord moves with it. Drag Discord and the panel follows. Resize either and the other adjusts.
- Minimize either one and both minimize. Restore either and both come back.
- Close either one (panel X, Alt+F4, or Discord's own X) and both close. Discord's X normally only hides it to the tray; Pin Folders treats that as "closed" and fully quits Discord. Set `closeDiscordCompletely` to `false` in `app/config.json` if you'd rather it just hide.
- The split-window button in the title bar re-fits both windows if anything gets out of place.
- Folders: create, rename, delete, drag to reorder. Drag messages between folders or right-click them. Click a message to jump to it in Discord. Search across everything.

**What people do in Discord**

- Right-click any message, then **Apps → Add to folder**, and pick a folder (or make a new one).
- `/importpins` in a channel copies its existing pins into a folder.
- `/folder create` and `/folder list`.

Discord itself is never modified. The panel only moves and resizes Discord's window, and the bot is an ordinary Discord bot, so this stays within Discord's rules.

---

## One-time setup (about 30 minutes)

### 1. Create the Discord bot

1. Go to https://discord.com/developers/applications and click **New Application**. Name it "Pin Folders".
2. Open the **Bot** tab:
   - Click **Reset Token** and copy the token somewhere safe. This is your `DISCORD_TOKEN`.
   - Turn on **Message Content Intent** and save.
3. Open **OAuth2 → URL Generator**:
   - Scopes: `bot` and `applications.commands`
   - Bot permissions: `View Channels`, `Read Message History`
   - Open the generated link and add the bot to your server.

### 2. Put the code on GitHub

1. Create a new **public** repository called `pin-folders` (public so everyone's app can download updates; no passwords or keys live in the code).
2. Upload the contents of this folder to it. Check that `.github/workflows/release.yml` made it; if the web uploader skipped it, use **Add file → Create new file**, type `.github/workflows/release.yml` as the name and paste the file's contents.

### 3. Run the server in the cloud

The server must run around the clock so the bot answers and changes sync. The easiest option is **Railway** (railway.com), which deploys straight from GitHub. Check their current pricing; any host that keeps a Node.js app running 24/7 with a little persistent disk works the same way.

On Railway:

1. **New Project → Deploy from GitHub repo →** pick `pin-folders`.
2. In the service's **Settings**, set **Root Directory** to `server`.
3. In **Variables**, add:
   - `DISCORD_TOKEN` = the bot token from step 1
   - `ACCESS_KEY` = a long random password (everyone's panel uses it to connect)
   - `DATA_DIR` = `/data`
4. Right-click the service → **Attach Volume**, mount path `/data` (keeps your folders when the server restarts).
5. In **Settings → Networking**, click **Generate Domain**. You'll get something like `pin-folders-production.up.railway.app`.
6. Open that address in a browser. You should see "Pin Folders server is running." In Discord, the bot should show as online.

### 4. Give GitHub the server address and key

In the `pin-folders` repo: **Settings → Secrets and variables → Actions → New repository secret**, twice:

- `SERVER_URL` = `wss://` + your Railway domain, e.g. `wss://pin-folders-production.up.railway.app`
- `ACCESS_KEY` = the same value as on Railway

These get baked into the app when GitHub builds it, so you never edit config files.

If anyone uses Discord PTB or Canary instead of normal Discord, set `"discordFlavor"` to `"ptb"` or `"canary"` in `app/config.json`.

### 5. Publish version 1.0.0

On GitHub: **Actions → Release app → Run workflow**. (If GitHub asks you to enable workflows first, click the green button.)

It builds the Windows installer (about 5 minutes) and puts it on the repo's **Releases** page as `PinFolders-Setup-1.0.0.exe`.

### 6. Everyone installs once

Send people the Releases page link. They run the installer once and from then on start **Pin Folders** instead of Discord (it opens Discord for them).

Windows SmartScreen will warn that the app is from an unknown publisher because it isn't code-signed. Click **More info → Run anyway**. This only happens on the first install, not on updates.

---

## Pushing updates to everyone

1. Make your changes in the repo.
2. Change `"version"` in `app/package.json` (1.0.0 → 1.0.1).
3. **Actions → Release app → Run workflow.**

Within 30 minutes every running panel downloads the update in the background and shows **"Update 1.0.1 is ready, Restart now"**. Clicking it restarts just the panel (Discord stays open). If they ignore it, it installs the next time they close the app. Change `updateCheckMinutes` in `config.json` to check more or less often.

Server changes deploy separately: Railway redeploys automatically whenever you push changes in the `server` folder.

---

## Running locally (for development)

```
cd server
cp .env.example .env     # fill in DISCORD_TOKEN and ACCESS_KEY
npm install
npm start

cd ../app
npm install
npm start                # set serverUrl to ws://localhost:8080 in config.json first
```

To build an installer locally without publishing: `cd app && npm run dist` (output in `app/dist`).

## Notes and limits

- Windows only (the window gluing uses Windows APIs).
- Folders are per server. If the bot is in several servers, pick one from the dropdown.
- Image previews come from Discord's attachment links, which can expire. When they do, the image just disappears from the card; clicking the message still opens it in Discord.
- Anyone with the app can rename and delete folders. Deleting a folder never deletes messages; they move to "Unsorted".
- The access key is built into the app. Treat the installer as private to your group.
