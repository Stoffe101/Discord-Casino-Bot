# Grand Casino Expansion handoff

The expansion is on `feat/grand-casino-expansion` and stacks on `feat/emerald-room-v1`.
[PR #2](https://github.com/Stoffe101/Discord-Casino-Bot/pull/2) remains a draft. The
previous test build was `0a3ad3c`. The current test runtime is `061452b`; its
checkout, process record and database backup are local to the expansion worktree.

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
  Actual Discord nickname changes remain unimplemented. The existing optional casino-only
  Sosse title still expires after 30 minutes.
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
`npm run build` passed locally on Windows. The suite ran 366 tests, including
the exhaustive 2,598,960-hand evaluator, service recovery on every poker street,
multiway side pots, two six-seat tables alongside Blackjack, privacy projections, event
scheduling and assignment, Blackjack delay and stale interactions, and relief at one or two chips.

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
comparison uses a five-seat fixture. The small-table renderer is covered in headless validation.
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
admin overrides are preserved. Before the test switch, SQLite's backup API created an online
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
