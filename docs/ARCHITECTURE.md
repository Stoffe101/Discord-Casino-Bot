# Architecture

```
            Discord gateway / REST
                    │
        ┌───────────▼────────────┐
        │ discord/  (adapter)     │  router · panel render queues · lobby · commands
        └───────────┬────────────┘
                    │ screens (plain JSON)            ┌─────────────┐
        ┌───────────▼────────────┐                    │ render/     │ SVG → PNG
        │ ui/  (presentation)     │◄───────────────────┤ (resvg,     │ (thread pool)
        └───────────┬────────────┘   images            │  OFL fonts) │
                    │ read-only state                 └─────────────┘
        ┌───────────▼─────────────────────────────────────────────────┐
        │ tables/ + games/*/…-service.ts   (orchestration, per-table queue) │
        └───────────┬─────────────────────────────────────────────────┘
                    │ pure rules            money/stats
        ┌───────────▼───────────┐  ┌──────────▼───────────────────────┐
        │ games/*/engine.ts      │  │ domain/  economy · ledger · round │
        │ (no I/O, deterministic)│  │ recorder · stats · progression …  │
        └────────────────────────┘  └──────────┬───────────────────────┘
                                               │ synchronous transactions
                                    ┌──────────▼──────────┐
                                    │ db/  node:sqlite WAL │
                                    └─────────────────────┘
```

Dependency direction is strictly downward: game rules know nothing about Discord or the database;
the economy knows nothing about games beyond a label; only `discord/` imports discord.js
(the UI kit only borrows its type definitions and enums).

## Key decisions

| Decision | Why |
| --- | --- |
| `node:sqlite` instead of better-sqlite3 | Built into Node 24 — no native compilation on Windows, same synchronous API style. The one-time "experimental" warning is filtered in `db/sqlite.ts`. |
| Synchronous transactions | A transaction can never interleave with another inside the process; `Database.transaction` rejects async callbacks so nobody awaits mid-transaction. Nested calls use savepoints. |
| Full table state as JSON in one row | Every mutation persists the whole aggregate (seats, bets, round, shoe, log) with an optimistic version check, in the same transaction as its money movements. Recovery is just "load and continue". |
| Per-table serial queue | Actions on one table run strictly in order; different tables run in parallel. |
| Pure engine returning new state | Compute → persist → swap. A failure anywhere leaves memory and database untouched. |
| Components V2 as plain JSON | Screens are data: testable headlessly and validated against Discord limits. |
| resvg + bundled fonts | Crisp vector artwork, identical on Windows and Linux CI, rendered off the event loop. |

## Money model

- `players.balance` (available) and `players.reserved` (committed) are integers with `CHECK >= 0`.
- `ledger` rows are append-only (triggers abort UPDATE/DELETE). `amount` is the signed change to
  the available balance; `balance_after`/`reserved_after` snapshot the result.
- `escrows` hold committed chips per (user, context) — the context is a blackjack round id, a
  roulette spin id, a coinflip challenge id or a slots spin id.
- Invariants (checked by `EconomyService.reconcile`): `balance = Σ ledger.amount`,
  `reserved = Σ held escrows`, last ledger snapshot = current row, nothing negative.
- Every operation takes an idempotency key (unique per server): replays are no-ops.
- `RoundRecorder.record` settles a round in one transaction: inserting the `game_rounds` row
  (primary key = round id) is the exactly-once guard, then each player's escrow is settled
  (with an expected-stake consistency check), results, stats, streaks, XP, missions, achievements
  and highlights are written. `voidRound` is the symmetric exactly-once refund.

## Blackjack table lifecycle

```
            first bet → deadline (20 s; 3 s once everyone is in)
 betting ───────────────────────────────────────────────► deal
    ▲                                                       │
    │                        ace up + insurance on          ▼
    │                     ┌──────────── insurance ◄──── startRound
    │                     │ all decided / timeout           │ dealer peek
    │                     ▼                                 ▼
    │                  playing ◄─── act (hit/stand/…) / timeout (auto-stand)
    │                     │ last hand finished
    │                     ▼
    └──── settle (same transaction: dealer draws, recorder pays, new round id)
```

`state.round.seq` increments on every accepted change; turn buttons embed it, so stale or doubled
clicks are rejected with a friendly message. Timers are keyed one-shots whose callbacks re-check
that the deadline they were armed for is still current.

## Discord adapter

- **Router** (`discord/router.ts`): parses `scope:action:args` custom ids, builds a `Viewer`
  (guild, user, display name, avatar, admin flag), calls services, shows screens. Private panels
  update in place; clicks on public messages open private replies. An ack guard defers any
  interaction still unanswered after 2.2 s. User-facing errors become small private cards; anything
  else is logged with a reference code.
- **Panel sync** (`discord/panel-sync.ts`): one render queue per table/wheel. Requests coalesce, so
  a slow edit is always followed by one render of the *latest* state and never overwrites a newer
  one. When the change came from a click on that panel, the click is answered with
  `interaction.update()` — one API call — otherwise the message is edited via REST. Identical images
  are not re-uploaded. Dealer reveals are a few frames ~850 ms apart (configurable off).
- **Lobby**: debounced (2.5 s) edits of one stored message; re-posted only if it was deleted.
- **Origins**: services accept an opaque `origin` token and pass it back through their observer, so
  the exact click that caused a change can answer it — no shared mutable "current interaction".

## Recovery policy

Startup order: open DB → migrate → `app.recover()` (blackjack, roulette, coinflip, orphan refunds,
reconciliation) → log in → re-attach/recreate panels → refresh lobbies. See the table in the README
for the per-phase behaviour. Corrupt state for a table voids the round with full refunds rather
than guessing. Escrows that no live round references are refunded.

## Concurrency and scale

Designed for **one process**. Multi-instance hosting is **not supported** (two processes would each
keep their own in-memory tables and timers). Within the process, every table, wheel, slots player
and coinflip challenge has its own serial queue; SQLite (WAL) serialises writes. The simulation
(`npm run simulate`) exercises many concurrent tables; 10 players on 2 tables is part of the test
suite.

## Rate limits and performance

- Turn timers are Discord timestamps — no per-second edits.
- Edits per panel are coalesced and spaced (≥300 ms); discord.js queues on 429s.
- Images: 800 px wide PNGs (~150–190 KB), LRU-cached by content hash, rendered on libuv's pool.
- Typical local cost per action: ~2 ms service + ~65 ms panel render (see README).
