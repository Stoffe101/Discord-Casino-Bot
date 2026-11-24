# Grand Casino Expansion handoff

The expansion lives on `feat/grand-casino-expansion`, based on `57f31ad` from
`feat/emerald-room-v1`. Use `git log -4 --oneline` for the current tip and milestone
commits. Keep the draft PR stacked on `feat/emerald-room-v1`.

## Player-facing changes

- Home links directly to the four playable games. Personal screens share a five-button navigation
  row. Leaderboard profile links carry the originating category, period and page in an owner- and
  guild-bound component ID, so Back works across process restarts.
- Games lists the playable games and rules. The table browser has paged public, available-seat and
  game filters. Blackjack still uses one seat per player per guild and its existing private
  access-code and thread flows. The browser currently lists Blackjack.
- Wallet has separate transaction, match, chip statistics, rewards, missions and gifting screens.
  Match details query settled records for the authenticated player in the current guild. Slots
  reuse existing round detail on restart. New spins store exact reel stops. Older spins retain the
  recorded payline and use the idle artwork when the stops are unavailable.
- Roulette uses a strict majority of current bettors after an eight-second minimum by default.
  Bettors can withdraw votes. New or changed bets reset the bettor's vote. The service queues bets,
  votes, deadline checks and settlement together and persists the quorum and timing in the wheel
  aggregate. An open wager modal is stamped with its round and rejected if it crosses a spin.
- The Emerald Relief Fund grants 50 chips to eligible empty wallets with a rolling 24-hour
  cooldown. It checks held wagers, daily and passive rewards and recent outgoing gifts. The
  optional Sosse casino title expires after 30 minutes and is rendered from SQLite timestamps.
  Server nickname changes require separate future work and permission.
- Gifting is off by default. It requires two established accounts, a current recipient in the
  server, a recipient who accepts incoming gifts, a private confirmation, and available
  chips. Both ledger entries commit together with a shared reference. Expired or abandoned
  confirmations may be reopened after a restart. Gifts do not enter gameplay statistics.
- The existing lobby activity feed uses configurable profit and stake thresholds, a per-player
  cooldown and opt-out. Activity updates share the lobby debounce. Genuine all-in event metadata
  and dedicated highlight artwork are still future work.

## Database and economy

Migration 2 adds three player preference fields and indexes for match filters, the social ledger
and activity lookups. Historical ledger entries and account balances are preserved. Legacy
roulette aggregates initialize a fresh window once, while new aggregates retain their saved
absolute deadlines and votes. Gift and relief mutations stay in `EconomyService`.

The new defaults are 500 starting chips, 20 passive chips per hour, a 24-hour passive cap, a
100-chip daily reward and a 10-chip streak increment. Stored administrator overrides win.
Existing balances use their original grant. Future passive and daily claims use the current guild
settings, including accrued passive earnings still outstanding at deployment.

`npm run simulate:economy` compares the previous and current defaults using 12 seeded player
profiles, production statistics and rewards, Blackjack, roulette, slots and coinflip. It uses the
pure poker engine to model zero-sum redistribution in the disposable database. The gift variant
moves 100 chips by day 30 and 325 by day 90. It leaves total supply unchanged.

| Defaults | Days | Chips created | Chips removed | Median | Mean | Balance range |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Previous | 30 | 219,675 | 8,876 | 17,327 | 17,567 | 8,460–28,085 |
| Current | 30 | 102,090 | 8,876 | 6,889 | 7,768 | 3,610–12,675 |
| Previous | 90 | 650,190 | 26,950 | 53,053 | 51,937 | 26,370–75,360 |
| Current | 90 | 298,665 | 26,950 | 22,458 | 22,643 | 10,752–34,945 |

The scenario had zero insufficient opening stakes after rewards, zero relief claims, and clean
ledger reconciliation in all runs. Passive income remains the largest source of chips. Treat these
figures as one low-stakes scenario. Separate integration tests exercise zero balances, open
escrows, relief and cooldowns.

## Poker continuation

The headless engine implements the four betting streets, blinds, heads-up order, full raises and
cumulative short all-ins, uncalled-bet refunds, best-five rankings, side pots, split pots and odd
chips. Public projections contain only the current board and legitimately revealed cards. The
engine receives funded stacks from its caller. There are currently no player-facing Poker buttons
or slash commands.

1. Add a poker table aggregate using the existing table-seat uniqueness constraint. Track table
   stacks as wallet escrow, including money committed to an active hand. Validate stack and wallet
   totals in the same SQLite transaction as every buy-in, cash-out, hand completion and refund.
2. Persist the active hand and its sequence with that aggregate. Bind action components to the
   guild, table, hand and version. Start with automatic timeout actions and an explicit atomic
   void/refund policy for a corrupted snapshot. Cover join/leave and sit-out behavior between
   hands before exposing the table.
3. Connect the service to guarded child threads and the table browser. Pass only
   `publicPokerHand` to shared renders and only the authenticated player's private projection
   to My Hand. Put reveal animations after the engine authorizes each street.
4. Add poker-specific round results and match details, then exercise two six-seat tables,
   concurrent Blackjack, reconnects at every street, side-pot settlement, stale duplicate
   actions, and privacy across text, attachments, logs and history.

Rules sources include [Robert’s Rules of Poker](https://www.pagat.com/docs/RobsPkrRules11.pdf) for
cash-game minimum bets and raises and the [Poker TDA rules](https://www.pokertda.com/view-poker-tda-rules/)
for reopening after cumulative short all-ins and odd-chip allocation.

## Verification and running

```powershell
npm ci
npm run check
npm run simulate:economy
npm run simulate -- --tables 3 --players 4 --rounds 10 --crash
npm run render-preview
npm run record -- roulette --latency 100 --think 100
```

The local Windows type check, lint, build and all 355 tests passed. The restart simulation settled 30 hands on three tables. Ledger reconciliation and chip
conservation passed, with zero held escrows and zero payload errors. It measured local p95 of
9.80 ms for game actions and 527.79 ms for panel rendering. The poker tests exhaustively check
2,598,960 five-card hands and exercise hundreds of seeded betting paths.

The live bench sends the simulated catalogue through the real bot REST API with the existing
test-mode allowlist. Discord accepted all 60 screens and the test message was removed. The median
request took 358 ms and the slowest took 5,185 ms. The guard blocked zero requests. The bench
uses a temporary message and no gateway session. Games, Wallet and
Roulette were visually inspected in the verified secondary-monitor Discord window. The stable bot
was still answering production interactions, so manual click behavior for the expansion remains
to be checked on a staging bot. The live bench does not verify mobile rendering or actual
interaction acknowledgements. Use the fake Discord integration suite for behavior and the
catalogue/preview commands for repeatable visual fixtures. Screenshots from the real server
belong outside source control.

For a staging login, create a local `.env` from `.env.example` and supply a separate bot
application's credentials plus the verified test guild and channel IDs. Keep test mode enabled and
set `DATABASE_PATH=./data/grand-test.db` before running `npm run build` and `npm start`.
Existing commands are unchanged. A staging application needs initial command registration.
To reuse the live token, coordinate a maintenance window and stop the existing gateway process
first. Use SQLite backup before any migration of live data, and verify with
`npm run reconcile` against the target database while no other process is writing to it.
