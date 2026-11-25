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
encoded (`tests/integration/panel-priority.test.ts`). A solo player is dealt 0.7 s after betting;
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

**Open decisions for the owner.**
- Hold'em: no dead button / missed-blind tracking (sitting out one hand dodges the big blind).
  Two `it.fails` tests describe the standard behaviour.
- Economy: passive income is ~46% of chips created over 90 seeded days and the median balance
  reaches ~33× the starting 500, so stakes become trivial over months. Consider a lower passive
  rate or cap; nothing was changed without your call.
- Hold'em chip dumping lets a new account move its starting chips to a friend in one hand (the
  gift age rule doesn't apply at the table). Options: an account-age gate on Hold'em seats.
- Real nicknames remain disabled until you approve them for a guild.
- Events still need a manually opened, assigned table; automatic creation near start time is not
  built yet.

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
  create single-table sessions, set registration and capacity, and explicitly assign a
  matching table they have opened. Start times require a date and UTC offset. Registrations,
  invite codes and state recover from SQLite. The first version has no automatic table
  assignment, waitlist, entry fees, pings or Discord-native event announcements.
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

- Run a fresh `/casino`, check that the complete Home controls are immediately visible, then
  open Games and return. Repeat on a narrower Discord window or mobile and check wrapping.
- Join a Blackjack table with a second player. Leave the betting panel open through the deadline,
  press Deal now if a stale control is still visible, and verify one deal and one wallet charge.
- Open a private Hold’em table with two real Discord users. Verify the invitation, private
  thread access, each player's My hand, flop through showdown, and both cash-outs.
- Create an event with a future offset-qualified time. Have a second player register, assign
  an owned matching table, start when ready and confirm the table link from both accounts.
