# The Emerald Room — a multiplayer Discord casino

A premium, button-driven casino for **private** Discord communities. Friends sit at real multiplayer
blackjack tables (each in its own thread), spin a shared roulette wheel, play a private slot machine
and challenge each other to coinflip duels — all with **free, fictional chips** that can never be
bought, sold or cashed out.

![A five-player blackjack table mid-hand](docs/images/table-playing.png)

<table>
<tr>
<td><img src="docs/images/table-results.png" alt="Round results" width="400"></td>
<td><img src="docs/images/roulette.png" alt="Roulette result" width="400"></td>
</tr>
<tr>
<td><img src="docs/images/banner.png" alt="Lobby banner" width="400"></td>
<td><img src="docs/images/slots.png" alt="Slot machine jackpot" width="400"></td>
</tr>
</table>

*All images are rendered by the bot itself (`npm run render-preview -- --docs`). The artwork —
cards, felt, chips, wheel, reels — is original vector art; fonts are Cinzel and Manrope (SIL OFL).*

---

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Discord setup](#discord-setup)
- [Using the casino](#using-the-casino)
- [Commands](#commands)
- [Configuration](#configuration)
- [Multiplayer blackjack](#multiplayer-blackjack)
- [Blackjack house rules](#blackjack-house-rules)
- [Economy](#economy)
- [Persistence and restart recovery](#persistence-and-restart-recovery)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Project layout and extending](#project-layout-and-extending)
- [Policy and compliance](#policy-and-compliance)

Further reading: [Discord setup guide](docs/DISCORD_SETUP.md) · [Architecture](docs/ARCHITECTURE.md) ·
[Adding a game](docs/ADDING_A_GAME.md) · [Windows hosting](docs/WINDOWS_HOSTING.md) ·
[Feature checklist](docs/FEATURES.md) · [Compliance notes](docs/COMPLIANCE.md)

## Features

**Blackjack (flagship)**
- Real rules engine, independent of Discord: 6-deck shoe with a cryptographically secure shuffle,
  soft/hard totals, naturals, dealer peek, hit / stand / double / split (to 4 hands) / surrender,
  insurance, split-ace rules, configurable S17/H17, 3:2 or 6:5.
- **Multiple concurrent tables**, each with its own thread, dealer, shoe, seats, timers and panel.
  Five seats by default (1–7 configurable). Private tables with access codes.
- One persistent **table panel** per thread that updates in place: the table image (dealer, every
  hand, bets, the active player highlighted in gold), a status line, a short activity log and
  controls that change with the phase. Only the active player's clicks count; everyone else gets a
  discreet private explanation.
- Betting with chip buttons (presets derived from the table limits), rebet, custom amounts; the
  hand is dealt 20 s after the first bet, or 3 s after everyone is in.
- Turn timers shown as live Discord timestamps (no per-second edits), auto-stand on timeout,
  automatic sit-out for absent players, leave-after-this-hand, host tools (deal early, remove
  player, close table).
- Dealer reveal animation (one edit per dealer card, configurable), results with per-hand outcomes,
  achievements and level-ups.

**Casino**
- `/casino` home, wallet, transaction history, profile, achievements, cosmetics, leaderboards,
  daily missions, help — almost entirely clickable, in private (ephemeral) panels that update in
  place.
- A persistent public **lobby** message with live table list, quick seat, highlights. It survives
  restarts and recreates itself if deleted (never duplicates).
- **Roulette** (shared European wheel, 13 bet types), **Slots** (exact RTP 96.53%),
  **Coinflip duels** (escrowed stakes, accept/decline/cancel/expiry).
- Progression: XP and levels (separate from wealth, with a daily soft cap), 21 achievements,
  3 daily missions, unlockable card backs, table felts and titles — cosmetic only.
- Button-driven admin panel for every setting, audited wallet adjustments, health check.

**Engineering**
- TypeScript, Node.js 24, discord.js 14 with **Components V2**, SQLite via Node's built-in
  `node:sqlite` (no native build step on Windows), resvg for image rendering.
- Append-only ledger, escrowed wagers, idempotent operations, exactly-once settlement,
  deterministic restart recovery. **156 automated tests**, plus an end-to-end simulation.

## Quick start

Requirements: **Node.js 24+** (developed on Windows 11 with Node 24.13), a Discord application.

```powershell
git clone https://github.com/Stoffe101/Discord-Casino-Bot.git
cd Discord-Casino-Bot
npm install
copy .env.example .env      # then fill in DISCORD_TOKEN and DISCORD_CLIENT_ID
npm run register-commands   # registers slash commands (instant if DISCORD_DEV_GUILD_ID is set)
npm run dev                 # start with auto-reload
```

Then, in your server, run **`/casinoadmin setup`** in the channel you want as the casino lobby.

| Script | What it does |
| --- | --- |
| `npm run dev` | Run from source with auto-reload (tsx) |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled bot (production) |
| `npm run register-commands` | Register slash commands (dev guild or global; see below) |
| `npm test` | Full test suite (headless; never connects to Discord) |
| `npm run typecheck` / `npm run lint` | Static checks |
| `npm run check` | typecheck + lint + test + build |
| `npm run simulate` | Headless multi-table simulation with timings and ledger audit |
| `npm run render-preview` | Render sample artwork to `render-preview/` |

> npm 11 may print an `allow-scripts` warning for `esbuild` (used by the dev runner). It is safe to
> ignore; nothing in this project needs install scripts.

## Discord setup

Full walkthrough with screenshots-in-words: **[docs/DISCORD_SETUP.md](docs/DISCORD_SETUP.md)**. In short:

1. Create an application at <https://discord.com/developers/applications>, add a **Bot**, copy the
   token into `.env` (`DISCORD_TOKEN`) and the Application ID (`DISCORD_CLIENT_ID`).
2. **No privileged intents are needed** — leave Presence, Server Members and Message Content off.
   The bot only uses the `Guilds` intent.
3. Invite it with the `bot` and `applications.commands` scopes and these permissions
   (integer `395137108992`): View Channel, Send Messages, Embed Links, Attach Files,
   Read Message History, Create Public Threads, Create Private Threads, Send Messages in Threads,
   Manage Threads.

   `https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot+applications.commands&permissions=395137108992`
4. `npm run register-commands`. With `DISCORD_DEV_GUILD_ID` set, commands appear instantly in that
   server; without it they are registered globally (can take up to an hour).
5. Start the bot and run `/casinoadmin setup` in your casino channel.

## Using the casino

- **`/casino`** opens your private home: balance, passive income, daily reward, tables, games and
  navigation. Everything after that is buttons.
- **Play Blackjack** seats you at the busiest public table with a free seat (or opens one) and links
  you to its thread. Press a chip on the table to bet. When it's your turn the action buttons light up.
- **Spectate** any public table by opening its thread. Joining mid-hand deals you in next hand.
- The **lobby** (posted by `/casinoadmin setup`) lists live tables and gives one-click quick seat,
  wallet, daily reward, leaderboards and more. Its menus open privately, so the channel stays clean.

## Commands

| Command | Purpose |
| --- | --- |
| `/casino` | Casino home |
| `/wallet` · `/daily` | Wallet / claim the daily reward |
| `/blackjack` | Table browser: quick seat, open a table, join |
| `/roulette` · `/slots` | Go to the wheel / open your slot machine |
| `/coinflip <player> <stake> [call]` | Challenge someone to a duel |
| `/profile [player]` · `/leaderboard [board]` | Stats and rankings |
| `/help` | Topic-based help |
| User menu → **Apps → Casino profile** | Someone's profile |
| `/casinoadmin setup [channel]` | Post or move the lobby (Manage Server) |
| `/casinoadmin panel` | Settings panel |
| `/casinoadmin adjust <player> <amount> <reason>` | Audited wallet adjustment |
| `/casinoadmin audit` · `/casinoadmin health` | Audit log / ledger + bot health |
| `/casinoadmin reset-dev` | Development-only wipe (see below) |

`/casinoadmin` is hidden from members without **Manage Server**, and every admin action re-checks
that permission server-side.

## Configuration

**Environment** (`.env`, never committed):

| Variable | Default | Notes |
| --- | --- | --- |
| `DISCORD_TOKEN` | — | Bot token |
| `DISCORD_CLIENT_ID` | — | Application ID |
| `DISCORD_DEV_GUILD_ID` | empty | Register commands to this server instantly |
| `NODE_ENV` | `development` | `production` disables some dev-only checks |
| `DATABASE_PATH` | `./data/casino.db` | Created automatically |
| `LOG_LEVEL` | `info` | `trace`…`error` |
| `LOG_DIR` | `./logs` | Daily JSON-lines log files; empty = console only |
| `ALLOW_DEV_RESET` | `false` | Enables `/casinoadmin reset-dev` (dev server + development only) |

**Per-server settings** are edited in `/casinoadmin panel` and stored in the database — no code
changes needed. Defaults:

| Group | Setting (default) |
| --- | --- |
| General | Casino name (*The Emerald Room*), casino open (on) |
| Economy | Starting chips 1,000 · passive 50/h · passive cap 24 h · daily 250 · streak +25/day up to 7 days |
| Blackjack | Bets 10–500 · 5 seats · turn 30 s · betting window 20 s · insurance window 12 s · 6 decks · S17 · 3:2 · DAS on · surrender on · insurance on · split to 4 hands · no resplit aces · 75% penetration · reveal animation on |
| Tables | Max 6 open tables · threads on · close empty tables after 10 min · close tables without bets after 30 min |
| Other games | Coinflip 10–1,000, 120 s expiry · Roulette 10–500 per spot, 25 s window · Slots 5–250 |

## Multiplayer blackjack

- Every table has its **own** players, dealer, shoe, phase, timers, panel and thread. Tables never
  share state; each processes its actions one at a time through its own queue, while the database
  keeps money atomic across all of them. Ten friends can split across two five-seat tables (this
  exact scenario is an automated test), and the simulation runs 10+ tables concurrently.
- **One seat per player** across the whole server (enforced by a database unique constraint).
  Switch tables between hands; leaving mid-hand stands your remaining hands and frees the seat
  when the hand ends.
- **Phases:** betting → (insurance) → player turns → dealer → settlement → results, then betting
  reopens immediately; nobody needs to rejoin between hands.
- **Who can press what:** bet/rebet/clear act for whoever clicks. Hit/Stand/Double/Split/Surrender
  only work for the active player, and every button carries the round's sequence number, so a
  double-click or an old message can never act twice. Double/Split show as disabled when the rules
  don't allow them or the player can't afford them.
- **Timers:** the deadline is shown as a Discord relative timestamp. A 2-second grace period applies,
  then the hand stands. Two timeouts in a row, or two hands in a row without betting, sit a player
  out so the table isn't held up; betting again brings them back.
- **Threads:** tables live in `blackjack-table-NN` threads (private threads for private tables).
  If threads can't be created, the panel is posted in the casino channel instead. Idle tables close
  (never mid-hand), open bets are refunded and the thread is locked and archived.

## Blackjack house rules

Vegas-style defaults, all configurable:

- 6 decks, reshuffle at 75% penetration (cryptographically secure Fisher–Yates shuffle).
- Dealer **stands on all 17s** (H17 optional) and **peeks** for blackjack with an ace or ten up, so
  a dealer blackjack only ever takes the original bets.
- Blackjack pays **3:2** (6:5 optional). Wins pay 1:1, pushes return the stake.
- Double on any first two cards; **double after split** allowed.
- Split identical ranks up to **4 hands**; split aces get one card each and cannot be hit; aces are
  not resplit by default; 21 after a split is not a blackjack.
- **Late surrender** on the first two cards of an unsplit hand returns half the bet.
- **Insurance** when the dealer shows an ace: costs half the bet, pays 2:1. (Taking insurance with a
  natural is the "even money" equivalent.)
- The hand automatically stands at 21.
- **Rounding policy:** chips are integers; any fractional payout (3:2 on an odd bet, half-bet
  surrender/insurance) is **rounded down**. A 15-chip blackjack returns 37 (15 + 22).

## Economy

- Balances are integers and can't go negative (validated in code and by `CHECK` constraints).
- **Ledger:** every change is an immutable row (database triggers reject updates/deletes) with a
  unique idempotency key. Invariant: `balance = SUM(ledger)` per player — verified by tests, by an
  hourly self-audit, and by `/casinoadmin health`.
- **Escrow:** a bet moves chips from *available* to *committed* the moment it's placed. Doubles,
  splits and insurance escrow more. Committed chips can't be spent elsewhere. Settlement releases
  escrow and credits the payout in the same transaction.
- **Passive income** is computed from a timestamp (no background timers), capped, keeps fractional
  progress between claims, and can't be double-claimed.
- **Daily reward** uses UTC calendar days (no timezone tricks) with a streak bonus.
- **Transaction types:** welcome chips, passive earnings, daily reward, mission and achievement
  rewards, wager, bet withdrawn, win / push / settled, refund, admin adjustment.
- XP and levels come from playing and goals — never from chip wealth — with a daily soft cap. Missions
  reward taking part, never bet size. Cosmetics never affect odds.

## Persistence and restart recovery

SQLite in WAL mode (`data/casino.db`). The full state of every table — including the shoe — is
saved in the **same transaction** as the money movement that changed it, and settlement is
exactly-once (round id primary key). What happens if the process stops:

| Stopped during… | After restart |
| --- | --- |
| Betting | Bets stay escrowed; a fresh betting window starts; the hand is dealt normally |
| Dealing | Dealing is atomic with locking the bets: either the hand exists (resumes) or the bets are still open |
| Insurance / player turns | The hand resumes **exactly** (same cards, same shoe); the current player gets a fresh timer |
| The action that ends a hand | Dealer play and settlement are part of that action's transaction: either everything committed, or the hand is back at that decision and continues |
| Settlement | Cannot be half-applied; cannot run twice |
| Unreadable/corrupt state | The round is voided and **every stake refunded** atomically; seats are kept |
| Orphaned wagers (no live round) | Refunded at startup |
| Coinflip challenge | Re-armed, or expired and refunded if overdue |
| Roulette spin | Bets kept and a new window starts; the spin itself is atomic |

Panels are re-rendered on startup; missing table messages or threads are recreated, and the lobby
message is edited in place (or re-posted if it was deleted). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

> **Single process only.** The bot is designed for one running instance (one SQLite database). Do
> not run two copies against the same database or the same Discord application.

## Testing

```powershell
npm test            # 156 tests, ~3 s, fully headless
npm run check       # typecheck + lint + tests + build
npm run simulate    # e.g. -- --tables 10 --rounds 50 --crash
```

The suite covers card values, every rule and payout (including a 3,000-round randomised invariant
test), shoe exhaustion, ten players on two concurrent tables with simultaneous clicks, double-clicks
and stale buttons, escrow and ledger invariants, concurrent claims, crash/restart at every phase,
corrupt state, orphan refunds, exact slot RTP by enumeration, roulette odds, coinflip races and
expiry, UI payloads against Discord's limits (40 components, 10 per container, 4,000 characters,
custom-id rules, attachments), and the interaction router driven by fake interactions.

Sample local measurements (Windows 11, Node 24, `npm run simulate -- --tables 2 --rounds 20`):
service actions average ~2 ms (p95 ~6 ms); a full table panel including the image renders in
~65 ms on average; table images are ~150–190 KB. Discord network latency comes on top and was not
measured — **no live Discord test has been run by the author of this release**.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Configuration problem: DISCORD_TOKEN is not set` | Copy `.env.example` to `.env` and fill it in |
| Slash commands don't appear | Run `npm run register-commands`; set `DISCORD_DEV_GUILD_ID` for instant registration; global commands can take up to an hour |
| "Missing permissions" on setup | Grant the permissions listed above in the casino channel (check channel overrides) |
| Tables are posted as channel messages, not threads | The bot lacks Create Public/Private Threads or Send Messages in Threads in that channel |
| "This interaction failed" | Check the console/log; the bot acknowledges within Discord's 3 s window, so this usually means the bot was offline or lacks access to the channel |
| A table panel was deleted | Interact with the table (e.g. Quick seat) — the panel is recreated automatically |
| Ledger warnings in the log | Run `/casinoadmin health`; please report it with the log file |
| `allow-scripts` warning during `npm install` | Harmless (esbuild, used only by the dev runner) |

## Project layout and extending

```
src/
  app/            composition root (no Discord)
  config/         env parsing, per-server settings schema + defaults
  core/           logger, clock, CSPRNG, keyed queues, scheduler, errors, formatting
  db/             node:sqlite wrapper (transactions/savepoints), migrations
  domain/         economy + ledger, stats, progression, achievements, missions,
                  leaderboards, round recorder (exactly-once settlement), settings
  games/          blackjack engine, roulette, slots, coinflip (pure rules + services)
  tables/         multiplayer blackjack table service, view model, types
  render/         SVG artwork → PNG (cards, table, banner, wheel, reels, coin)
  ui/             Components V2 kit, validator, custom ids, every screen
  discord/        client, router, panel render queues, lobby, commands, payloads
  scripts/        command registration, simulation, render preview
tests/            vitest suites (headless)
```

To add a game, implement its rules as a pure module, escrow wagers with `EconomyService.reserve`,
and settle with `RoundRecorder.record` — that one call pays out, updates stats, streaks, XP,
missions, achievements and leaderboards. Screens reuse the UI kit. Walkthrough:
[docs/ADDING_A_GAME.md](docs/ADDING_A_GAME.md). Tournaments are a planned extension; see
[docs/FEATURES.md](docs/FEATURES.md).

## Policy and compliance

The chips are **fictional and non-transferable**: they can't be bought, sold, traded, cashed out or
redeemed for anything of value, and there are no payments or crypto anywhere in this project.
Discord's [Developer Policy](https://support-dev.discord.com/hc/en-us/articles/8563934450327)
prohibits facilitating illegal gambling; its
[App Discovery content requirements](https://support-dev.discord.com/hc/en-us/articles/9489299950487)
exclude "gambling-adjacent" apps, and its
[Monetization Policy](https://support.discord.com/hc/en-us/articles/10575066024983) prohibits
monetizing simulated casinos. This bot is therefore intended for **private servers only**: do not
list it in App Discovery and do not monetize it. Details: [docs/COMPLIANCE.md](docs/COMPLIANCE.md).
