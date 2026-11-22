# Testing report — live and autonomous testing

**Date:** 2026-11-22
**Environment:** Windows 11, Node 24, discord.js 14.28.1
**Branch:** `feat/emerald-room-v1`

This report keeps four kinds of evidence apart:

| Kind | What it proves | How |
| --- | --- | --- |
| **A. Real Discord bot API** | Discord accepted what the bot sent | The running bot in test mode, plus `npm run live-bench`: one bot message in the allowlisted channel, edited through every screen |
| **B. Real Discord UI inspection** | How the screens look in the desktop client | Read-only screenshots of the allowlisted channel. Stopped part-way at the owner's request, because screenshots hid their browser |
| **C. Simulated players** | Behaviour of the real bot code under player actions | The full-stack harness: real discord.js, guard, router and panel sync against an in-memory Discord (`tests/harness/`). Its payload rules are *a model* of Discord's |
| **D. Real human clicks** | Real players pressing buttons in the client | **Not verified.** The bot can't press its own buttons, and the owner's account was deliberately not automated |

## Round 3: game feel (owner feedback: "a bit janky")

**How it was reviewed.** `npm run record` plays short sessions through the full stack with the bot's production animation timings, simulated network latency and human-paced clicks. It writes an HTML replay of every message change for each game, plus the frame images. I reviewed every frame before and after the changes. A web survey of other Discord casino bots fed into the priorities:
- OwO bot stops its slot reels in stages of about 1 s, 0.7 s and 1 s, and flips its coin after 2 s;
- totals appear as text, with soft hands marked;
- the newest card is highlighted;
- whole animations stay under about 3 s.

**Problems found in the recordings, all fixed:**
- **Spoilers during the dealer's reveal.** The activity log already said "Dealer busts · Alex wins 200" while the cards were still turning. Animation frames now show no log and no controls.
- **No dealing.** The table jumped from bets straight to every card dealt. Now:
  - the first card goes out to each player, plus the dealer's up card;
  - about 0.5 s later the second cards arrive with totals and the turn controls.
- **Hands hard to read.** Only the active player's hand was in text. Now:
  - the active hand is shown large ("8♠ 8♥ → 16") with the dealer's up card next to it;
  - a one-line summary lists every player's hands and totals.
- **Tiny totals and outcomes in the image.** Totals are now larger, gold on the hand to act. Results outline each seat green or red with a larger net amount. The dealer's bust total stays visible. The newest card glows.
- **Roulette, slots and coin flip jumped straight to the result.** Now:
  - roulette shows "no more bets" with the ball rolling, then slowing, then landing;
  - the slot reels spin and stop in turn, with controls locked and the balance unchanged until they settle, and the winning symbols glow;
  - the coin goes up, then lands.
- **Repeated slot results looked identical.** There's now a spin counter.

**Also new:** bets typed as `2k`, `1.5k`, `all`, `max` or `half` in the bet, roulette and coinflip boxes.

**Timings now** (per step, before network latency):
- deal pass 450 ms;
- each dealer card 700 ms;
- roulette and slot frames 650 ms;
- coin 1 s.

A full dealer reveal with two extra cards takes about 2–3 s.

**Verified:**
- 298 tests pass; `tests/integration/animations.test.ts` covers frame order, no spoilers, locked controls, the newest-card marker and amount parsing.
- **Live Discord:** all 37 screens were accepted, including the four new animation frames.
- **Live table threads:** 2 tables × 2 hands with the new deal and reveal frames, 0 rate-limited, 0 blocked.
## 0. Round 2: table threads under #casino

The owner then authorised threads whose parent is the verified #casino channel, in the same server. Nothing else changed.

**Guard.** With `CASINO_TEST_ALLOW_THREADS=true`, a thread becomes reachable only after Discord's own data confirms both its parent and its server. That confirmation can come from:
- the response to creating it;
- a channel lookup;
- the gateway cache;
- the interaction payload.

Once a thread is verified, the bot may:
- post and edit messages in it;
- add players to private tables;
- archive or lock it.

It may not rename or delete threads, create nested threads, or reach threads of other channels or servers. Interactions from unrelated threads get no response.

**Tests.** `tests/outbound-guard-threads.test.ts` has 38 cases:
- policy cases;
- learning from real discord.js REST responses, where a lookup of a #general thread does *not* unlock it;
- full-stack cases: a table thread is created under #casino, played in, then closed, locked and archived; a private table gets a private thread and the joining player is added; an interaction from a member's thread under #general is ignored; three tables get three threads, with no panels or notices left in #casino.

Five thread-mode scenarios run through the full stack (`tests/integration/threads-mode.test.ts`):
- a crash and resume: the thread is looked up and verified, and the same message is edited;
- 10 players on 2 tables concurrently;
- roulette in its own thread;
- timeouts, settlement and the idle close;
- a table whose thread lives under another channel: it is never written to and is re-homed under #casino.

A 60/12 scale run in thread mode (`simulate:discord --threads`): 36 hands, 472 interactions, 0 late, 0 blocked, ledger OK.

The whole suite passes: 283 tests.

**Live: `npm run live-tables`.** This runs the real bot thread code against real Discord: thread creation, panel sync with dealer reveal frames, and close/lock/archive. The players are simulated through the game services.

| Run | Result |
| --- | --- |
| 3 tables (2 public, 1 private) × 2 hands, concurrently | ✅ 3 threads created under #casino. Results shown on every panel. Image still resolved after an edit that reused it without re-uploading. Closed panel, locked and archived on all 3. 6 hands, 72 panel edits, **0 rate-limited**. Guard: 103 allowed, 0 blocked. Ledger OK |
| Same run: what #casino received | ✅ **0 new messages**. The bot now deletes Discord's "started a thread" notice, since the lobby already lists tables (verified live, 0 left from the run). Private threads create no notice |
| Discord API timings in threads | message edit avg 552 ms (p95 1.1 s); message create avg 953 ms; thread/channel requests avg 368 ms |

**Found and fixed in this round:**

1. **The guard couldn't learn threads from Discord responses in production.** Node's discord.js transport returns responses without `clone()`. The live run only worked because the bot also learns from discord.js's thread-created event.
   - The guard now buffers the body for the two routes it inspects and hands back an equivalent response.
   - The test fake now returns the same response shape as the real transport, so tests can't hide this again.
2. **Close-time cleanup was fire-and-forget.** The closed panel, lock and archive ran outside the work that `idle()` and shutdown wait for, so a shutdown right after a close could cut it short. It is now tracked.
3. **Thread notices cluttered #casino.** Every public table left a "started a thread" notice; these are now removed.
4. **A stale panel was left from the first, unguarded session.** That session's thread still showed "Table 01" as open. It is now marked closed, locked and archived.
5. **Leftover notices from earlier bench runs** were deleted. These were the bot's own messages only; the notice for your original table thread was kept.

**Still needs you, because only real people can press buttons:** see the short checklist in the PR (§ "Your manual test").
## 1. Safety setup: test-mode allowlist

- **Allowlist.** Resolved with `npm run test:allowlist`, which reads the development server from `.env` and makes two read-only API calls.
  - Exactly one text channel named `casino` exists, so nothing had to be guessed.
  - The server and channel IDs are stored only in the local `.env`, which is gitignored.
  - This report deliberately leaves out the server name and IDs.
- **Enforcement.** The guard (`src/discord/outbound-guard.ts`) wraps the HTTP function of the Discord client. Every request passes through it: interaction handlers, panel sync, lobby sync, timers and scripts. It is default-deny, and refusals are logged locally with interaction tokens redacted.
  - **Allowed:** messages in the allowlisted channel, answers to interactions that came from it, and command registration for that server.
  - **Refused:** threads, DMs, other channels or servers, reactions, pins, settings, global commands, and any payload that could ping.
- **Interactions.** Interactions from other channels or threads are dropped before routing, so no response is sent outside the allowlist.
- **Lobby.** `/casinoadmin setup` pointed at another channel is refused privately (tested). If no lobby is configured, test mode posts it in the allowlisted channel on startup.
- **Guard tests** (`tests/outbound-guard.test.ts`, 50 cases):
  - the policy table;
  - token expiry and percent-encoded routes;
  - a real discord.js `REST` client: blocked requests never reach the network;
  - full-stack cases: an interaction from `#general` produces zero HTTP requests, setup elsewhere is refused, a thread panel is relocated without touching the thread, and timeouts, lobby refreshes and closes stay inside the allowlist.
- **Live evidence.** On the first guarded boot, the bot tried to update an existing table panel inside a thread (created by an earlier unguarded run). The guard blocked the edit, logged it, and the table was re-posted in the allowed channel. Today's log has exactly one blocked request (that one) and no error lines.

## 2. What ran and the results

| Area | Kind | Result |
| --- | --- | --- |
| Lobby posted, edited in place after restarts (same message ID) | A + B | ✅ Same message reused across 3 restarts; renders correctly |
| All 33 screens accepted by Discord: lobby, home, wallet, history, rewards and missions, profile, achievements, cosmetics, 2 leaderboards, tables browser, table panel in 4 phases, my seat, rules, games hub, slots, paytable, roulette ×2, coinflip ×2, 2 help pages, 4 admin pages, notice, error, closed table | A | ✅ 33/33 accepted; no `50035` rejections |
| Screens viewed in the desktop client: lobby, table mid-hand, results, home, profile, leaderboard, rewards, roulette, slots (partly) | B | ✅ Rendered correctly; the copy and layout problems found are fixed (§3) |
| Blackjack end to end | C | ✅ 6/6 scenarios. Covered: dynamic controls per turn, wrong-turn clicks, concurrent double clicks, stale buttons, split, surrender, naturals, insurance, timeout then sit-out, leaving mid-hand, private table codes, host-only deal |
| Economy | C | ✅ Daily reward claimed once despite a double click; passive accrual and 24 h cap; insufficient funds message |
| Slots, roulette, coinflip | C | ✅ Duplicate spin ignored. Roulette: select → modal → spin → payout. Coinflip: accept pays, decline/cancel/expiry refund, outsider refused |
| Restart mid-hand | C | ✅ Same cards resume on the same panel message; nothing re-posted |
| Render ordering under latency, deleted panel, Discord 5xx | C | ✅ Latest state always wins; panel recreated; table stays playable |
| Two servers on one bot | C | ✅ Wallets and tables per server; forged cross-server button refused |
| 10 players / 2 tables, 3 hands | C | ✅ All acknowledged; ledger OK; chips conserved; isolation OK |
| 20 players / 4 tables with 25 ms latency, 2 hands | C | ✅ Same, plus every acknowledgement under 3 s |
| 60 players / 12 tables with 40 ms latency (`simulate:discord`) | C | ✅ 36 hands, 472 interactions, 0 late; ledger OK |
| 60 players / 12 tables × 15 hands with a crash (`simulate --crash`) | C (engine) | ✅ 180 hands; 12 tables restored; ledger OK; 0 open escrows |
| Single instance per database | live | ✅ With the bot running, a second `node dist/main.js` printed the refusal and exited with code 2; the running bot was unaffected. A restart right after a hard kill started normally, because the OS released the lock |
| Live database offline reconcile (`npm run reconcile`) | live | ✅ 0 problems |
| Full suite (`npm run check`) | — | ✅ 240 tests, typecheck, lint, build |

## 3. Issues found and fixed

Each fix has a regression test (`tests/ui-regressions.test.ts` unless noted).

| # | Issue | Found by | Cause → fix |
| --- | --- | --- | --- |
| 1 | `/casino` **would be rejected by Discord** for a seated player whose table panel wasn't posted yet | live-bench dry run | The fallback "Back to table" button reused the Tables button's custom ID; duplicate IDs invalidate the whole message. It now opens the player's seat screen with its own ID |
| 2 | **Results shown twice**: in the results block, then again in the activity log | client screenshot | After a hand, the log now shows only events since settlement |
| 3 | Achievements ran on: "Alex unlocked … · Alex unlocked … · Alex unlocked …" | client screenshot | One line per player: "Alex unlocked A, B and C · reached level 3" |
| 4 | Betting line "Alex — · Hanna —" was cryptic | client screenshot | Replaced by "Bets in: …", "Still deciding: …" and "Sitting out: …" |
| 5 | Profile copy: "1 days", "1 spins", "best ×0" | client screenshot | Pluralisation fixed; "best ×N" shown only after a win |
| 6 | Closed table read "empty table. Any open bets…" | client screenshot | Reason capitalised |
| 7 | Leaderboard "Maja — −25" looked like a typo | client screenshot | Separator changed to "·" |
| 8 | Test mode could still **ping members inside the channel** (the coinflip card pinged its opponent) | review | Guard rejects any payload that could mention someone; coinflip drops the ping in test mode; client default is `allowedMentions: { parse: [] }` (`tests/outbound-guard.test.ts`) |
| 9 | **Two bot processes could run against one database**. It happened once during this session's restart, for about a minute with no player activity; the ledger was checked afterwards (0 problems) | own restart mistake | An OS-held lock (a named pipe keyed on the database path) that the OS releases when the process dies. A second copy exits with code 2; the Windows runner stops instead of retrying. A first version used a PID file; it was replaced after review because PIDs get reused after hard kills and a fresh clone has no `data/` folder yet (`tests/instance-lock.test.ts`: hard-killed holder, missing folder; plus live proof) |
| 10 | A panel stored in a thread couldn't be updated under the allowlist | first guarded boot | Treated as a missing panel and re-posted in the allowed channel (`tests/outbound-guard.test.ts`) |

## 4. Performance

| Measurement | Result |
| --- | --- |
| Discord API requests from this PC (live bench, 33 message create/edit requests) | Median **429 ms**. About every sixth edit waited ~4.7 s: Discord rate-limits edits in one channel to roughly 5 per 5 s |
| Click → acknowledgement, 12 tables at once with 40 ms simulated latency | p50 199 ms · p95 440 ms · max 531 ms |
| Router handling per interaction (same run) | avg 33 ms · max 187 ms |
| Game action service time, 12 tables at once (engine simulation) | avg 13 ms · p95 32 ms |
| Table image render (800 px PNG), 12 tables at once | avg 148 ms · p95 259 ms; ~180 KB per image |
| Panel updates sent by answering the click itself (no extra request) | 304 of 415 (73%) |
| Memory, 12-table run | JS heap ~39 MB (stable). RSS 130 → ~300 MB, mostly native memory from the image renderer |

**Bottleneck found: one shared channel in test mode with threads off.** With 12 tables, it peaked at 40–73 channel message writes per 5 s, far above Discord's per-channel edit limit. Clicks aren't affected (they answer through the interaction), but timer-driven panel updates would queue. In normal mode each table has its own thread, and with it its own rate limit. **Recommendation:** with threads off, keep test mode to a few tables; use threads otherwise. In thread mode the same 12-table run peaked at 24 writes in one channel, all in #casino at the moment 12 tables opened together (thread creation plus notice removal). Per-table panel edits go to separate threads.

The running bot now logs Discord API timings by request kind every 10 minutes and on shutdown. They also appear in `/casinoadmin health`.

## 5. Ledger reconciliation

- **Unit and integration suites:** every scenario ends with `reconcile()` returning no issues and no held escrows.
- **Engine simulation, 60 players, crash mid-run:** reconciled, chips conserved.
  - Note: achievement and mission rewards paid out 34,980 chips, while the house won 8,170. Early-session rewards dominate the economy (see §7).
- **Full-stack 60/12 run:** reconciled, chips conserved, 0 open escrows.
- **Live database** (after the overlap in issue 9): 1 player, 0 problems.

## 6. Live Discord observations

- **Real rendering quality:**
  - The lobby banner and table image are sharp.
  - Card ranks stay readable at chat width.
  - The active seat's gold highlight and the outcome chips (WIN, BUST, BLACKJACK) are clear.
  - Disabled actions (Split, Surrender) are visibly greyed out.
- **Wrapping:** at the window size used, the lobby's 8 buttons wrapped to three lines; still tidy.
- **Screenshots stay local.** They were taken of the allowlisted channel only and kept out of the repository and PR, because they show member names and the server.
- **Messages the bot left in the channel:**
  - The lobby. It was already there and is reused.
  - A "Table 01 — closed" panel, re-posted from the thread when test mode started, then closed by the idle sweep.
  - The bench message was deleted at the end of testing.
  - The thread from the earlier unguarded run was closed, locked and archived in round 2.
  - Rounds 2–3 left **10 archived, locked bench threads** under #casino. Four are private, and they are named like real tables (`blackjack-table-NN`). The guard deliberately can't delete threads, so remove them by hand if you want them gone.

## 7. Remaining limitations and unverified behaviour

- **(D) Real players pressing buttons in the client** (desktop or mobile) is still unverified. Every click path was exercised through the full-stack harness, and every payload was accepted by Discord, but no human click was observed.
- **Threads (round 2):** creation, panels, reveal frames and close/lock/archive were verified live with simulated players. Joining from a real click and private-thread membership for a real member still need a human.
- **Mobile layout** was not inspected in a real mobile client.
- **Early-session reward inflation:** first-hand achievements and missions can roughly double a new player's bankroll in one evening. This is a design choice, left unchanged; a "reward multiplier" setting would be a small follow-up.
- **Single process only**, now enforced by an OS-held lock on the database path.

## 8. Reproducing

```powershell
npm run check
```
```powershell
npm run simulate:discord -- --tables 12 --players 5 --rounds 3 --latency 40
```
```powershell
npm run simulate -- --tables 12 --players 5 --rounds 15 --crash
```
```powershell
npm run live-bench
```
The live bench requires test mode and the bot's token, and posts and deletes one message in the allowlisted channel.
