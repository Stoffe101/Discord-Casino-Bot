# Grand Casino Expansion handoff

## Claude takeover, 2026-11-25 (read this first)

Claude took the expansion back over at `085e0c5` (Codex). The test runtime then ran `bdebf81`;
`085e0c5` only added documentation on top. Baseline before any change: typecheck clean,
372/372 tests. Everything below this section is Codex's earlier handoff, kept for history.

**Independent audits.** Four areas were re-checked from scratch with reproduction tests in
`tests/audit-*.test.ts` (kept as regression tests; deliberate open items are `it.fails`):

- Hold'em engine, escrow and private information: correct blinds, heads-up order, min-raise and
  short all-ins, side and split pots, uncalled bets, conservation across restarts on every
  street; no hole-card/board/deck leak in 600+ projected states. Fixed: a departing player
  stalled the table for the turn timer. Open by design: dead-button and missed-blind rules.
- Gifting, relief, Sosse nicknames, highlights: fixed "Major win" ignoring the stake floor
  (a 10-chip jackpot was announced), a single passive chip blocking relief, a locked-out
  nickname retry, and nickname restoration after the approval changed.
- Table and thread lifecycle and events: see "Lifecycle fixes" below.
- Table artwork readability: see "Multiplayer tables" below.

**Player experience.** The Games floor is one illustrated image (a tile per game plus Events)
with two rows of game buttons in the same order; Home is a personal dashboard (avatar, balance,
your table with a direct link into its thread, claimable rewards, next event, activity; no quick
seat, no image attachment); Wallet, Gifting, Events, the lobby sign and the roulette vote were
redesigned; Blackjack and Hold'em table lists are game-specific; asking for one card game while
seated at the other explains why and offers return/leave/Games. Every entry route is covered
by `tests/integration/entry-routes.test.ts`.

**Responsiveness.** A newer animated change (including a private My hand action, which has no
click on the panel) now cuts an older animation short, and an overtaken animation is never
encoded (`tests/integration/panel-priority.test.ts`). A solo player is dealt 0.4 s after betting (0.7 s before 01b6986);
Deal now (host) only shows while someone is still deciding, removing the race seen live.

**Lifecycle fixes.**
- Private tables (both games) are never posted publicly: refused with a refund when Discord refuses
  the private thread, when threads are off, or when a vanished thread would be re-homed.
- Private-thread membership is enforced (host first, guests rolled back if they can't be added,
  re-homed tables re-add everyone, leavers and kicked players removed). The test-mode guard allows
  exactly one extra request for this: removing a member of a verified casino thread.
- Failed creations leave no debris. Closing is durable: migration 5 (`discord_closed_at`) and a
  reconcile step at startup and on every sweep finish any close Discord didn't confirm. On the
  first start it finished cleanup for 11 previously closed test tables.
- Emptied Blackjack tables get a new host; event tables are held until 30 minutes after their start;
  event capacity counts the organizer; tables open only under the configured casino channel; the
  first sweep runs 5 s after start (idle closes land at 3–4 min empty, 5–6 min occupied).

**Multiplayer tables.** Adaptive layouts (1–4 seats one row, 5–6 as 3+2/3+3, 7 as 4+3) with a compact
dealer strip and per-seat arrangements for splits and long hands. Measured from geometry in
`tests/render-readability.test.ts`: smallest card rank or text ≥ 9 px at 400 px display width and
≥ 11.5 px at 500 px for every fixture (before: down to 3.0 px). Hold'em uses the same standards.
Animations share the layout. Previews: `npx tsx src/scripts/render-tables-preview.ts` (writes PNGs under the gitignored `recordings/`).

**Operations.** `<database>.stop` next to the database asks a hidden Windows runtime to shut down
gracefully (drain, close, release the lock, exit 0). `data/deploy-check.mjs` (local) inspects the
test database read-only and takes an online SQLite backup.

**Test runtime switch (2026-11-25 01:25).** Verified the recorded PID 44844 (`bdebf81`, command line
with `data/grand-test.env` and `dist/main.js`) and that no other casino process existed; the database
had one player (520 chips), nothing held, no open tables, a clean ledger. The old build had no
graceful trigger, so only that PID was stopped. Backup: `data/grand-test-pre-claude-2026-11-25T00-25-30-313Z.db`;
rollback build: `data/rollback-dist-bdebf81/`. Started exactly one process (PID 40224, `8831697`);
recovery and reconciliation clean, no warnings. Later builds can be stopped with the `.stop` file.
To roll back: create `data/grand-test.db.stop`, wait for exit, start `data/rollback-dist-bdebf81/main.js`
with the same env files against a copy of the backup, and carry forward any activity since.

**Decisions since made (2026-11-25), with what remains.**
- Hold'em blinds: a moving big blind with a dead button and missed-blind tracking (148cbf3).
  A player who owes blinds chooses in their private view between posting and playing the next
  hand (default) and "Wait for big blind"; the choice is stored with the seat, and a stack that
  can't cover what is owed simply waits (`tests/integration/poker-wait-big-blind.test.ts`).
- Economy: passive income 8/h stored for 48 h (see "Economy rebalance"), with income already
  earned at the old rate kept by migration 7.
- Hold'em chip dumping: for its first 24 hours (the gift rule's age) an account may put at most
  two table minimums at risk (200 chips at the defaults): its buy-in plus its net Hold'em losses
  so far, read from `round_results`. Reviewed: the buy-in and hand results are counted separately
  (no double counting); leaving and buying in again cannot exceed the limit; winners and day-old
  accounts are unaffected; the minimum is a server setting, so a table host cannot raise the
  limit. Residual risks: a new account can still pass up to 200 chips on its first day, several
  new accounts can each do so, and established accounts can collude (the admin "Unusual
  transfers" review shows such patterns; nothing acts automatically).
- #casino cleanup (`src/discord/channel-tidy.ts`): finished coinflip cards leave after 30 s
  (3 min for a resolved flip). A sweep once startup recovery has completed (closes reconciled,
  event tables opened, panels re-attached), plus 30 s, deletes only the bot's own messages this
  database shows are finished: panels of closed tables and wheels, "started a thread" notices
  for table threads, and finished challenge cards past their linger time. The lobby, live
  challenges, open tables and wheels, anything younger than 10 minutes or pinned, anything the
  records can't explain (for example another runtime's messages under the same bot account) and
  everyone else's messages always stay. At most 40 deletes per sweep, each registered with the
  test-mode guard.
- Real nicknames remain disabled until you approve them for a guild.
- Event tables: one table per event (multi-table events would extend `EventTableConfig` to a
  list). A player who withdraws must leave the event's table first. A crash in the instant
  between the game service creating the table and the event recording it would leave that
  table unlinked (it then idles out normally with refunds); the event records the table before
  any Discord call, so a crash anywhere later resumes the same table.

**Still needs a real person (not clickable by Claude this round):** a fresh `/casino` to confirm the
whole Home appears on first open (Home no longer carries any image attachment); a two-player
Blackjack hand to observe bet-to-cards time; a two-player private Hold'em hand; mobile wrapping.

The expansion is on `feat/grand-casino-expansion` and stacks on `feat/emerald-room-v1`.
[PR #2](https://github.com/Stoffe101/Discord-Casino-Bot/pull/2) remains a draft. The
original test build was `0a3ad3c`. The current test runtime is `bdebf81`. Its
checkout, process record and database backups are local to the expansion worktree.

## Games floor and Blackjack follow-up

Home and the public lobby surface Games, My table and Events. Blackjack and Hold’em
open independent table lists, with matching creation flows. The generic browser keeps
its casino-wide filters. The other game cards open the wheel, private slots machine or
coinflip opponent picker directly. Every game has a native illustrated card and its
own rules button.

The multiplayer Blackjack panel shows the turn and action controls above a shorter
table image and displays player cards and totals in a native text list. The default
betting window is 12 seconds. When every active seat has bet, the automatic deal starts
after 1.5 seconds. Hold’em and Blackjack retain their own action timers. Existing
administrator overrides are preserved.

Table exits link to the persistent casino landing message. Discord link controls need a
click to move the client. The archive path drains in-flight panel edits first, writes the
closed state when the old message is available, and locks and archives the thread even
when that message is missing. Defaults are three minutes empty and five minutes idle
between games. Active hands and pending wagers keep a table open. The lobby edits its
existing message and the bot removes its own thread creation notices.

The test runtime was switched with no open wagers and no schema change. A SQLite backup
was taken at data/grand-test-pre-premium-2026-11-24T22-03-15-368Z.db. The previous compiled
test build is at data/rollback-dist-5b688f0/. The test database had one player with 530
available and no reserved chips at cutover. Local checks, 372 tests and Windows and
Linux CI passed.

The real Discord desktop flow opened and closed each table through its own game card,
returned the Hold’em buy-in in full, and followed Return to casino back to the configured
lobby. It played one 10-chip Blackjack hand, which lost to a dealer natural. The engine
settled it 1,506 ms after reserving the wager. The deal was visible in a desktop snapshot
at about five seconds, giving an upper bound for this observation. The equivalent
five-seat synthetic opening deal attachment shrank from 272 KB to 162 KB. Desktop
multiplayer readability was checked with a five-seat fixture. The real player used the
solo live flow. Five historical threads were archived after verifying both their closed
table records and their bot ownership and parent channel. The two new test threads
were already archived and locked by the bot. Reconciliation reported zero problems.

## Player experience

- Home puts the spendable balance and game actions first, followed by rewards and recent
  casino activity. Wallet groups rewards and transactions separately. Games adds original
  SVG illustrations, short descriptions, table activity and direct play or rules buttons.
- Blackjack uses larger cards and tighter positions on small tables. Navigation and secondary
  actions sit together directly below the shared table. The deal control identifies its original
  betting round, and a click racing the automatic deal acknowledges the existing round or
  refreshes the panel. The first animation has a 1,100 ms render budget during actionable play.
  When it runs over budget the static state can take over. Normal deal, draw and reveal
  animations remain available.
- Hold’em has persistent public and private tables, six default seats, blinds, dealer rotation,
  timeouts, sit-out, buy-ins, cash-outs and private My hand controls. Public panels render only
  the authorized projection, with back-facing cards in the deal animation and only showdown
  cards revealed. Stacks remain in table escrow. A hand settles and rolls stacks into the
  next hand atomically, with no rake. Blackjack and Hold’em share seat exclusivity.
- The table browser lists Blackjack, Hold’em, roulette and upcoming events. Event organizers
  create single-table sessions, set registration and capacity, and configure the event's table
  (seats and bets, or the Hold'em buy-in) from the event. Blackjack event tables open by
  themselves 15 minutes before the start once enough players registered (startup and the
  minute sweep, one at a time per event, never a second table); the organizer can open early.
  Hold'em event tables never open by themselves: a seat holds the player's own buy-in, so the
  first registered player to click "Join the table" (organizer included) opens it with the
  buy-in they enter. Registered players take a seat with one click; registration is the access
  to a private event's table (its code is never shown). Cancelling, or an event called off
  short of players, closes the table it opened with refunds. Event tables are exempt from idle
  closing until 30 minutes after the start. Start times require a date and UTC offset.
  Registrations, invite codes and state recover from SQLite. No waitlist, entry fees, pings or
  Discord-native event announcements.
- Relief considers the lowest opening stake or buy-in across the enabled games. Held stakes,
  table stacks, active reward availability, cooldown and recent outgoing gifts still affect
  eligibility. Gifting is enabled by default while explicit guild overrides take precedence.
  The optional casino-only Sosse title lasts 30 minutes. Actual server nicknames require a
  separate, informed player opt-in after the relief chips are already available.
- Highlights use recorded net winnings and the current privacy setting and cooldown. Hold’em
  all-in recognition requires the entire starting stack to remain committed after any refunds,
  a configurable stake floor and a qualifying profit. Pot-win highlights use the player's
  payout share and net profit. Notable Blackjack split wins and roulette straight wins use
  recorded outcomes. Dedicated highlight artwork and cross-game all-in classification remain open.

Hold’em is enabled explicitly on the isolated test database. Other guilds still need
`poker.enabled=true` through the existing administrator settings. Before enabling on a
separate runtime, verify that Discord can create and manage the casino's public and private
child threads and send messages in them. Deployments can configure an organizer role through
`eventOrganizerRole`. The default restricts event management to server managers.

## Verification

`npm run typecheck`, `npm run lint`, `npm test -- --maxWorkers=3` and
`npm run build` passed locally on Windows. The suite ran 370 tests, including
the exhaustive 2,598,960-hand evaluator, service recovery on every poker street,
multiway side pots, two six-seat tables alongside Blackjack, privacy projections, event
scheduling and assignment, Blackjack delay and stale interactions, relief at one or two chips,
slow animation fallback, and the nickname lifecycle against a fake Discord member adapter.

The delayed-deal regression injected 160 ms of Fake Discord latency. It reproduced state
committing while the old panel still offered Deal now. The stale click now reconciles safely.
The initial `/casino` and the Home-tab update produced the same visible component tree and
attachment references with Components V2 and private visibility. The user confirmed the
buttons were visible on their latest attempt before the rollout. The original missing controls
did not recur, and their original cause remains unknown.

### Interaction bench, 409aba1 → 89b43fc (2026-11-25)

`tests/harness/bench-interactions.ts` drives the real router, services, renderers and panel
queues against Fake Discord with production timings and animations, adding 120 ms per Discord
request and 150 ms per upload (calibrated against real Discord with `src/scripts/bench-live-rest.ts`).
The baseline ran in an isolated worktree of 409aba1 with the same harness. Each side: 3 cold
processes plus 8 passes in one process (warm = passes 2–8), and a concurrency run (5-seat
Blackjack tables, a 4-seat Hold'em table, 10 roulette bettors and 5 browsers clicking at once,
about 30 users). Results, median / p95 / max ms of the first visible change (warm):

| Interaction | 409aba1 | 89b43fc |
| --- | ---: | ---: |
| Navigation without images (Home, Profile, Rules, lists…) | 123–125 / ≤138 | 123–125 / ≤137 |
| Games, returning from a screen without images | 277 / 281 (179 KB) | 124 / 126 (2 KB) |
| Games, after Wallet (the badge replaced its image) | 278 / 280 (179 KB) | 279 / 282 (97 KB) |
| Relief / Gift confirm | 278 / 402 | 124 / 248 |
| Blackjack bet → solo deal: deliberate wait | 1,115 | 790 |
| Blackjack bet → solo deal: final frame | 2,228 | 1,893 |
| Blackjack double | 475 | 421 |
| Blackjack hit that ends the round | 970 / 1,021 | 778 / 787 |
| Hold'em deal (host): final frame, errors | 1,878, 7 of 7 | 1,584, 0 |
| Slots spin | 583 / 645 | 513 / 540 |
| Coinflip accept | 371 | 355 |

Concurrency: uploaded data 99 MB → 62 MB, lobby edits 24 → 9, event-loop max 309 → 56 ms
(p99 17 ms both), peak RSS 409 → 351 MB, no errors. Raw results and the comparison are in the
gitignored `recordings/perf/` (`compare-409aba1-89b43fc.txt`). Eight render threads instead of four
(`UV_THREADPOOL_SIZE=8`) gained only 5–10% on the hit, so the default was kept.

What remains slow, and why: a Blackjack hit or stand that ends the round answers with one GIF
of the card, the dealer's reveal and the chip settlement (about 30 frames), so it shows after
about 0.8 s. Showing the drawn card first (about 0.4 s) needs a text mode that does not reveal
the outcome early; not done. Games after Wallet re-uploads its banner: Discord keeps either all
existing attachments or none, so a screen with a different image replaces the banner.

The bench also found a real bug, fixed in 89b43fc: Node timers can fire a millisecond before
`Date.now()` reaches their target (9 of 400 here), and roulette spins and Hold'em turn timeouts
treated such a call as not due and dropped it, leaving a wheel unspun with bets on it.

### Timing

These are local single samples from the real router, services and renderers against Fake Discord
with 40 ms added request latency. The settle column waits for queued follow-up work, with
animations encoded and zero deliberate animation hold.

| Interaction | Acknowledged (ms) | Queues drained (ms) |
| --- | ---: | ---: |
| Home slash, cold artwork | 74 | 76 |
| Home tab, cached artwork | 46 | 46 |
| Games | 88 | 89 |
| Wallet | 76 | 77 |
| Match history | 45 | 45 |
| Browse tables | 46 | 46 |
| Blackjack quick seat and panel creation | 47 | 309 |
| Blackjack join | 46 | 139 |
| Blackjack wager | 136 | 151 |
| Blackjack deal | 567 | 735 |
| Blackjack hit | 398 | 566 |
| Blackjack stand and settlement | 1,019 | 1,187 |
| Roulette open | 47 | 339 |
| Roulette wager modal / submit | 46 / 47 | 47 / 62 |
| Roulette ready vote | 45 | 61 |
| Slots open / spin | 62 / 323 | 62 / 416 |

In that manual deal sample, commit and render start both took place 1 ms after deal began.
The first GIF finished at +513 ms and Fake Discord acknowledged at +566 ms. The final
still was acknowledged at +704 ms. The automatic timing race is covered separately by
the regression. Discord's network receipt and actual client media painting were outside
this sample.

The real Discord REST bench edited one synthetic message in the allowlisted channel, then removed it.
Discord accepted all 19 selected payloads. Median request time was 537 ms and maximum was
4,834 ms. Home and Wallet were both 394 ms, cached Home 247 ms, the Blackjack deal GIF
3,357 ms and Poker deal GIF 537 ms. These counts include service queues and attachment uploads.
Even some text-only edits took several seconds late in the sequence. The run did not isolate
Discord rate limiting from transport and queue delays.

The desktop client displayed the before/after Home, Wallet, Games and Blackjack fixture payloads
on the verified secondary display. The Hold’em table and event details were also inspected.
Cropped screenshots are under the gitignored `recordings/premium-review/`. The Blackjack
comparison uses a five-seat fixture. The matching solo renders are in blackjack-solo-before.png and blackjack-solo-after.png in that directory.
Live mobile layout, exact client-paint timings and a two-player private Hold’em hand still need
human confirmation. The REST bench used synthetic data, including for personal views.

The 30-player, six-thread Fake Discord run settled 12 hands. It recorded 165 interactions, no
late or missing acknowledgements, 849 ms p95 and 991 ms max acknowledgement, and no ledger,
isolation, payload or escrow errors. RSS rose from 144 to 224 MB. The separate crash simulation
restored three live tables and settled 30 hands. Game action p95 was 10.43 ms and panel rendering
p95 was 312.14 ms. The suite also covers ten active roulette bettors, vote changes, wallet
operations, third-party clicks, missing panels and the allowlist. These results are from several
scenarios with different configurations.

### Seeded economy

`npm run simulate:economy` uses production poker escrow, varied stakes and longer sessions
in disposable databases. Defaults remain 500 starting chips with no existing balance resets.

| 90-day scenario, 12 players | Chips created | Chips removed | Median | Insufficient opening stakes |
| --- | ---: | ---: | ---: | ---: |
| Previous defaults | 802,576 | 154,167 | 54,075 | 0 |
| Current defaults | 444,911 | 151,480 | 16,520 | 0 |
| Current defaults with gifts | 444,911 | 151,480 | 16,507.5 | 0 |

Current defaults saw 544 sessions and 295 chips net redistributed through settled Hold’em. Gifting
moved another 325 chips between wallets with no supply change. Passive income remains the largest
issuance source. These seeded scenarios illustrate affordability and inflation under their activity
model.

## Database and release

**Test runtime, 2026-11-25 (second session).** The PC restarted at about 14:29 and the runtime
(409aba1) was not running; it was restarted as PID 36396 from a frozen copy of that build
(`data/runtime-dist-409aba1/`, so later builds in `dist/` can't change a running bot), after a
backup. Upgrade to 60d5576 (code as 89b43fc plus docs): verified PID 36396 by command line;
`deploy-check inspect` showed 1 player, 520 chips, nothing held, no tables; backup
`data/grand-test-pre-claude-2026-11-25T15-03-09-279Z.db`; graceful stop through
`data/grand-test.db.stop` (exit in about a second, no other casino process); started exactly one
process, PID 7040, from `data/runtime-dist-60d5576/` with the same env files. Migrations 6 and 7
applied, recovery clean, reconcile empty, offline about 13 s. Migration 7 credited the one player
369 chips earned at the old rate (520 → 889); the ledger matches. Record:
`data/grand-test-runtime.json`. Rollback: stop through the `.stop` file, restore the backup above
(it predates migrations 6 and 7) and start `data/runtime-dist-409aba1/main.js`; restoring is
required, because 409aba1 doesn't know migration 7's credit.

**Migration rehearsal (2026-11-25).** This build's migrations ran on copies made with SQLite's
online backup API (sources opened read-only): the test database (schema 5 → 7, one player
credited 351) and the stable database (schema 1 → 7, one player credited 480, the old cap). In
both, nothing but the credit changed, the ledger reconciles, and running the migrations again
applies nothing.

Migration 3 adds `casino_events`, event registrations and their lookup indexes. Poker uses the
existing game tables, seats, escrows and round tables. Existing ledger rows, preferences and
admin overrides are preserved. Before the first test switch, SQLite's backup API created an online
snapshot and an independent migration rehearsal. Schema 2 upgraded to 3 with SQLite integrity
and application reconciliation verified. The isolated test snapshot contained one player,
565 available chips, six ledger entries, two rounds and no held escrows or active tables.
The automated recovery tests provide coverage for active rounds. The live test database had
no rounds in progress at cutover.

The cutover made a second SQLite backup after the old gateway stopped. The local backup is
`data/grand-test-pre-premium-2026-11-24T21-20-02-858Z.db`. The previous compiled runtime is
under `data/rollback-dist-0a3ad3c/`. After starting the new gateway, ledger reconciliation
reported zero problems, the guard confirmed the designated channel and its verified child
threads, and Discord returned the edited lobby with its Events control. No explicit gifting
override was present on the test guild, so its new default took effect.

Migration 4 stores the exact earlier nickname or null, expiry and retry time for consented
nickname changes. After separate approval, set CASINO_NICKNAME_GUILD_ID for the one authorized
guild and enable economy.reliefNickname to offer new changes. Existing restorations continue
if the administrator disables future offers. Bot permissions and role hierarchy apply. The
bot restores after expiry only if the current nickname still reads Sosse. Discord offers no
conditional nickname write. A manual change observed before restoration takes precedence.
Temporary permission failures retry, and departed members need no restoration.

The test runtime rehearsed schema 3 to 4 on a separate copy, then took a fresh
backup at data/grand-test-pre-premium-2026-11-24T21-28-54-362Z.db. The rollback build for
this switch is under data/rollback-dist-061452b/. Hold’em and gifting stayed enabled.
The nickname offer and all guild-member edits are disabled in guarded test mode.

For a future coordinated rollout:

1. Verify the target environment, worktree, bot identity and database path. Run the tests,
   build and rehearse the migration on a separate SQLite backup. Compare the reconciliation
   report, row counts, available balances, held escrows and administrator overrides.
2. Wait for active play to finish. Stop the confirmed previous gateway process, take a fresh
   SQLite backup, and start exactly one process against the intended database. Check startup
   recovery, the lobby and reconciliation. For the existing test runtime, use the current
   staging environment files and `node --enable-source-maps dist/main.js`.
3. To roll back, stop the new gateway and preserve its database and WAL state using SQLite backup.
   Start the prior build against a separate copy of the pre-switch snapshot. Point the database
   setting at that copy. If players have used the new build, the snapshot predates their activity.
   Reconcile or carry forward those changes before reopening the old build for play. Keep the new
   database intact.

## Remaining client checks

**Focused checklist after the 2026-11-25 stabilization (first items first):**
1. Image reuse on private screens (only proven against Fake Discord and real channel-message
   edits, not yet on an ephemeral interaction in the client): open Games → Rules → Games, and
   Wallet → Gifting → Wallet. The banner and the wallet badge must appear every time, and Home
   right after Games must not show a stray banner (kept images stay unreferenced). If an
   image is ever missing, set `canKeepAttachments` to always return false in
   `src/discord/payload.ts` (one line) and report it.
2. Hold'em with two or three people: one player sits out past the big blind and sits back in.
   My hand shows "You owe …" and "Wait for big blind"; pressing it switches to "Post and play
   next hand", and the next deal leaves them out until the big blind reaches them.
3. Event table: create a Blackjack event starting in 20 minutes with two registered players; at
   15 minutes before the start the table opens by itself and "Join the table" seats each player
   with one click. For Hold'em, check that nothing opens by itself and that "Join the table" asks
   for a buy-in.
4. Roulette: two players bet and both press Ready; the wheel spins at the ready time (the
   early-timer fix).
5. #casino stays to the lobby, live challenges and nothing else after a restart (wait a minute).

- Run a fresh `/casino`, check that the complete Home controls are immediately visible, then
  open Games and return. Repeat on a narrower Discord window or mobile and check wrapping.
- Join a Blackjack table with a second player. Leave the betting panel open through the deadline,
  press Deal now if a stale control is still visible, and verify one deal and one wallet charge.
- Open a private Hold’em table with two real Discord users. Verify the invitation, private
  thread access, each player's My hand, flop through showdown, and both cash-outs.
- Create an event with a future offset-qualified time. Have a second player register, assign
  an owned matching table, start when ready and confirm the table link from both accounts.

## Economy rebalance (2026-11)

**Change.** The default passive income is now **8 chips per hour, stored for up to 48 hours**.
It was 20 per hour for up to 24 hours, so at most 384 chips can wait instead of 480. No other
economy default changed.

**Evidence.** Run `npx tsx src/scripts/simulate-economy.ts [--seeds N] [--json] [--only 20/24,8/48]`.
The script drives the real app (ledger, escrow, Hold'em stacks, missions, achievements, relief
and gifts) for 52 seeded players over 180 days. The players are infrequent, regular,
Blackjack-focused, Hold'em-focused, roulette, slots, reward collectors and late joiners, with
fixed and balance-proportional stakes. Visits are drawn from their own seeded stream, so every
scenario sees the same visits, and two runs produce identical output. The table shows means
across seeds 20261125 and 20261126:

| Passive | Day | Chips created | Passive share | Wallet p10 / p50 / p90 | p50 ÷ max bet (500) |
|---|---|---|---|---|---|
| 20/h, 24 h (old) | 90 | 1.82M | 70% | 13.4k / 33.8k / 54.1k | 68 |
| | 180 | 3.66M | 72% | 29.5k / 66.7k / 106.7k | 133 |
| 10/h, 24 h | 90 | 1.18M | 54% | 7.3k / 20.8k / 36.9k | 42 |
| **8/h, 48 h (new)** | 90 | 1.21M | 56% | 8.3k / 22.7k / 37.3k | 45 |
| | 180 | 2.40M | 58% | 23.0k / 43.2k / 70.7k | 86 |
| off (reference) | 180 | 1.01M | 0% | 7.0k / 14.6k / 39.5k | 29 |

The table was produced before another session's first-day Hold'em buy-in limit landed. With that
limit, the script now falls back to the minimum buy-in. A one-seed rerun of 8/h, 48 h moved chips
created by under 0.2% and that seed's day-90 median from 20.7k to 21.3k.

**Why 8/h with a 48-hour cap.**
- About a third fewer chips are created at every horizon, about the same as 10/h with a 24-hour cap.
- Visiting every other day now earns as much passive income as visiting daily, which takes away
  the pressure to check in every day.
- The day-180 median of reward collectors versus infrequent players narrows from 3.6× to 2.4×.

Shortfalls stay rare in every scenario:
- With passive income at 5/h or more, no visit wanted a stake the player could not afford, and
  nobody was blocked from playing.
- At 8/h, 48 h there were 2 busts and 1 relief claim in 2,107 visits during days 1–30, and none
  after that.
- Only with passive income off did any visit want an unaffordable stake: 5 of about 4,500
  intended plays. That scenario also had 18 relief claims in the first 30 days (0.85 per 100
  visits).

The older "46%" figure divided passive income by grants plus house payouts. On that basis
passive income is now 23% at 90 days, down from 35%.

**What this does not fix.** Daily rewards, missions and achievements still grant about 100 chips
per player per day. The house edge removes only about 1% of what is created, which is within
noise. Even with passive income off, the median wallet holds about 29 maximum bets by day 180.
Keeping 10–500 stakes meaningful for months needs a decision on those other sources, or chip
sinks or higher limits. None of that was changed here.

**Existing servers.** `guild_settings.settings_json` holds only the keys an admin set, and
defaults are read from code. Migration 7 (`passive_rebalance_2026_11`) settles income earned before
the switch; see "Uncollected passive income" below.
- **Never set either passive key:** the server moves to 8/h and 48 h on the next start. The test
  server stores only `poker.enabled`, so it moves.
- **Admin set either key, even to 20:** the server keeps that value. Changing another setting does
  not copy the passive keys in, and Reset all lands on the new defaults.
- **Admin set only one key:** each key stands alone. A server that set only the rate keeps its
  rate but gets the new 48-hour cap, so 20/h can now store 960 chips instead of 480. If that
  matters, set the cap too. Alternatively, ship 10/h with a 24-hour cap: it creates the same
  chips (1.18M vs 1.21M at 90 days) with no cross-effect, but loses the skip-a-day parity.
- **Balances, ledger, streaks and committed chips** (escrows, Hold'em stacks) are untouched. No
  balance goes down.
- **Uncollected passive income is kept.** Migration 7 runs once, on the first start of this build,
  inside one transaction and before anything reads passive income. For every player on a server
  whose effective rate or cap changes, it credits the income accrued at the old settings (same
  formula as Collect: whole chips, capped, so 24 hours waiting still pays 480) as a
  `passive_income` ledger entry with reference `migration:7` and memo "Passive earnings at the
  previous rate", then restarts accrual from that moment at 8/h. Servers that set both passive
  values are skipped. Explicit overrides are read the way the app reads them (invalid JSON counts
  as none). A crash rolls the whole migration back and the next start runs it again; once
  recorded in `schema_migrations` it never runs again. Rehearsed on copies of the test and stable
  databases (see "Migration rehearsal" under Database and release). Tests: `tests/passive-rebalance.test.ts`.
- **To keep the old behaviour:** in the admin panel, under Economy, set Passive chips / hour to 20
  and Passive cap to 24.
- **Tests:** `tests/economy-defaults.test.ts`.

**Unusual transfers (admin, read-only).** The admin panel has a second row with an
"Unusual transfers" button (`adm:transfers`). It shows patterns from the last 7 days and states
its own criteria. It never acts on a wallet.
- **New accounts:** accounts that joined in the window and, within 48 hours of joining, passed
  at least half of their actual starting grant to one player. This counts Hold'em and coinflip
  losses (each hand pairs the loser with a winner by `MIN(lost, won)`) and gifts. Chips won back
  from that player are subtracted. House games are ignored.
- **Repeated gifts:** sender→recipient pairs with 3 or more gifts.
- **Limits:** each list shows at most 10 rows, and every query is scoped to one guild.
- **Code and tests:** `src/domain/economy/transfer-review.ts` and `tests/economy-transfer-review.test.ts`.
