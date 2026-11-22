# Discord setup

This bot is completely separate from any other bot you run (it uses its own application, token,
database and configuration). Nothing here touches your music bot.

## 1. Create the application

1. Go to <https://discord.com/developers/applications> → **New Application**. Give it a name such as
   *Emerald Room*.
2. **General Information** → copy the **Application ID** into `.env` as `DISCORD_CLIENT_ID`.
   Optionally upload an icon and description.
3. **Bot** tab:
   - **Reset Token** → copy it into `.env` as `DISCORD_TOKEN`. Treat it like a password; never commit it.
   - **Privileged Gateway Intents:** leave **all three off** (Presence, Server Members, Message
     Content). The bot only uses the non-privileged `Guilds` intent — it never reads message content
     and never lists members.
   - *Public Bot* can be turned off so only you can invite it.
4. **Installation** tab: keep *Guild Install*; *User Install* isn't needed (all commands are
   server-only).

## 2. Invite the bot

Use this URL (replace `YOUR_APP_ID`):

```
https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot+applications.commands&permissions=395137108992
```

Requested permissions (the minimum the features need):

| Permission | Why |
| --- | --- |
| View Channel, Send Messages, Read Message History | Post and edit the lobby and table panels |
| Embed Links, Attach Files | Components V2 media (table images, banner) |
| Create Public Threads / Create Private Threads | One thread per table (private tables get private threads) |
| Send Messages in Threads | Post the panel inside a table's thread |
| Manage Threads | Archive/lock threads of closed tables, add players to private threads |

No administrator, moderation, role or voice permissions are requested. If channel permission
overrides deny any of these in your casino channel, grant them there.

## 3. Register slash commands

```powershell
npm run register-commands
```

- With `DISCORD_DEV_GUILD_ID` in `.env` (your test server's ID — enable *Developer Mode* in Discord,
  then right-click the server → *Copy Server ID*), commands are registered to that server and appear
  **immediately**.
- Without it, commands are registered **globally**, which can take up to an hour to show up.
- To move from a dev registration to global: `npm run register-commands -- --global`, then
  `npm run register-commands -- --clear-guild` to remove the duplicate guild copies.

Re-run the command whenever command definitions change (after updating the bot).

## 4. Start and set up

```powershell
npm run dev        # development (auto-reload)
# or
npm run build
npm start          # production
```

In Discord, in the channel you want as the casino (a normal text channel), run:

```
/casinoadmin setup
```

The bot posts the lobby message and remembers it. Running setup again in another channel moves the
lobby (the old message is deleted). Restarts never create duplicates; if someone deletes the lobby
message, it is re-posted at the next update.

Then open **`/casinoadmin panel`** to adjust the economy, limits, timers and rules for your server.

## 5. Development vs production

| | Development | Production |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` |
| Commands | `DISCORD_DEV_GUILD_ID` (instant) | global registration |
| Runner | `npm run dev` | `npm run build && npm start` |
| Payload validation | invalid payloads throw (fail fast) | invalid payloads are logged |
| `/casinoadmin reset-dev` | only with `ALLOW_DEV_RESET=true` in the dev server | always refused |

Use a separate application (token) for testing if you want to keep production data untouched — the
database file is per installation (`DATABASE_PATH`).
