# Pin Folders

A side panel that docks next to the real Discord app and lets your group sort pinned messages into shared folders. Everyone running the panel sees every change live. Everything runs on free plans with no time limit.

```
pin-folders/
  worker/   bot + live sync, runs free on Cloudflare Workers
  app/      the Windows side panel (auto-updates from GitHub Releases)
  .github/workflows/release.yml   builds and publishes app updates
```

**What the panel does**

- On launch it starts Discord (or brings it back from the tray) and fits Discord + panel side by side on the screen.
- Drag the panel and Discord moves with it. Drag Discord and the panel follows. Resize either and the other adjusts.
- Minimize either one and both minimize. Restore either and both come back.
- Close either one (panel X, Alt+F4, or Discord's own X) and both close. Discord's X normally only hides it to the tray; Pin Folders treats that as "closed" and fully quits Discord. Set `closeDiscordCompletely` to `false` in `app/config.json` if you'd rather it just hide.
- The split-window button in the title bar re-fits both windows if anything gets out of place.
- Folders: create, rename, delete, color, put folders inside folders (up to 5 levels), drag to reorder or nest. Drag messages between folders or right-click them. Click a message to jump to it in Discord. Search across everything.

**What people do in Discord**

- Right-click any message, then **Apps → Add to folder**, and pick a folder (or make a new one).
- `/importpins` in a channel copies its existing pins into a folder.
- `/folder create` and `/folder list`.

**Gamer mode**: the small switch in the panel's title bar turns on a slow RGB glow. It's a personal setting, remembered per PC.

**Adding the bot to another server**: open a channel in that server in Discord. The panel shows an **Add to this server** button, which opens Discord's own page for adding the bot. Discord only lists servers where you're allowed to add bots (Manage Server).

The bot shows as **offline** in the member list. That's normal: Discord calls it over the web only when someone uses it, which is what lets it run free. Discord itself is never modified; the panel only moves and resizes Discord's window.

## What it costs

Nothing. Discord bots, GitHub (public repo, Actions, Releases) and Cloudflare Workers' free plan have no trial period. Cloudflare's free plan allows 100,000 requests per day, far more than a friend group uses. If a limit were ever hit, the panel just stops syncing until the daily reset (midnight UTC); nothing is billed and no card is needed.

## Setup

Follow the step-by-step installation guide (shared separately). In short:

1. Create a Discord application + bot; note its **Application ID**, **Public Key** and **bot token**; turn on **Message Content Intent**; invite it with `bot` + `applications.commands`.
2. Upload this folder to a public GitHub repo.
3. Cloudflare: **Workers & Pages → Create → Import a repository**, pick the repo, root directory `worker`. Add secrets `DISCORD_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID`, `ACCESS_KEY`. Open `https://<worker>.workers.dev/setup?key=<ACCESS_KEY>` once.
4. In the Discord app's General Information page, set **Interactions Endpoint URL** to `https://<worker>.workers.dev/interactions`.
5. GitHub repo secrets: `SERVER_URL` = `wss://<worker>.workers.dev`, `ACCESS_KEY` = same as Cloudflare.
6. **Actions → Release app → Run workflow.** Share the Releases page; everyone installs once.

## Pushing updates to everyone

1. Change `"version"` in `app/package.json` (1.0.0 → 1.0.1).
2. **Actions → Release app → Run workflow.**

Every running panel downloads it within 30 minutes and offers **Restart now**; otherwise it installs the next time they close the app. Changes in `worker/` deploy to Cloudflare automatically on every push.

## Running locally (for development)

```
cd worker
npm install
# create worker/.dev.vars with DISCORD_TOKEN, DISCORD_PUBLIC_KEY, DISCORD_APPLICATION_ID, ACCESS_KEY
npm run dev            # http://localhost:8787

cd ../app
npm install
npm start              # set serverUrl to ws://localhost:8787 in config.json first
```

To build an installer locally without publishing: `cd app && npm run dist` (output in `app/dist`).

## Notes and limits

- Windows only (the window gluing uses Windows APIs).
- Folders are per server. If the bot is in several servers, pick one from the dropdown.
- Image previews come from Discord's attachment links, which can expire. When they do, the image just disappears from the card; clicking the message still opens it in Discord.
- Anyone with the app can rename and delete folders. Deleting a folder never deletes messages; they move to "Unsorted".
- The access key is built into the app. Treat the installer as private to your group.
