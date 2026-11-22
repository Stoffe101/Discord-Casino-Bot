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
| **D. Real human clicks** | Real players pressing buttons in the client | **Not verified in this session.** The bot can't press its own buttons, and the owner's account was deliberately not automated |

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

**Bottleneck found: one shared channel in test mode.** With 12 tables, test mode peaked at 40–73 channel message writes per 5 s, far above Discord's per-channel edit limit. Clicks aren't affected (they answer through the interaction), but timer-driven panel updates would queue. In normal mode each table has its own thread, and with it its own rate limit. **Recommendation:** keep test mode to a few tables, and use threads in production.

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
  - The thread from the earlier unguarded run still shows that table's last open panel. Test mode can't edit threads, so it stays stale, and clicks on it get no response while test mode is on.

## 7. Remaining limitations and unverified behaviour

- **(D) Real players pressing buttons in the client** (desktop or mobile) is still unverified. Every click path was exercised through the full-stack harness, and every payload was accepted by Discord, but no human click was observed.
- **Threads are untested live.** Production mode uses one thread per table, and posting in threads was not authorised for this session. Thread creation, private-thread membership and thread panels are covered only by the harness.
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
