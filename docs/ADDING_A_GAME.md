# Adding a game

Every game plugs into the same economy, statistics, progression and UI. You never touch balances
directly and never write your own payout bookkeeping.

## 1. Pure rules (`src/games/<game>/engine.ts`)

Write the rules as pure functions with an injectable `Rng` (`core/random.ts`). Keep them free of
Discord, the database and the clock, so you can test every rule and payout exhaustively. Expose the
exact odds if the game has them (see `slots/engine.ts` → `exactReturnToPlayer()`).

## 2. A service (`src/games/<game>/<game>-service.ts`)

Copy the shape of `slots-service.ts` (single-player, instant) or `roulette-service.ts`
(shared, timed rounds):

```ts
const roundId = newId();
await queue.run(`${guildId}:${userId}`, () =>
  db.transaction(() => {
    // 1. Commit the wager (moves chips to escrow; throws InsufficientFundsError).
    economy.reserve({ guildId, userId, game: 'mygame', contextId: roundId, amount: bet, key: `mygame:${roundId}` });

    // 2. Resolve with the pure engine.
    const result = myEngine.play(rng);

    // 3. Settle — ONE call pays out and updates everything else.
    return recorder.record({
      guildId,
      roundId,
      game: 'mygame',
      title: 'My Game',
      players: [{
        userId,
        wagered: bet,                       // must equal the escrow held for this round
        returned: result.payout,            // stake included; 0 on a loss
        stats: { plays: 1, big_hits: result.big ? 1 : 0 },   // free-form per-game counters
        maxStats: { best_multiplier: result.multiplier },
        flags: result.jackpot ? ['mygame_jackpot'] : [],      // for achievements/missions
        xp: 3,                              // participation XP (daily soft cap applies)
        label: result.payout > bet ? 'win' : 'lose',
      }],
    });
  }),
);
```

`RoundRecorder.record` is exactly-once per `roundId` and, in the same transaction:
settles the escrow and credits the payout (ledger), writes `round_results` (history, weekly/daily
leaderboards), bumps `player_stats` for the game and for `all` (rounds, wins, losses, net,
biggest win, streaks, days played), grants XP, advances daily missions and unlocks achievements.

For multi-step games, persist your state in the same transaction as each escrow change (see how
`BlackjackTableService.mutate` and `RouletteService.mutate` do it) and add a `recoverAll()` that
resumes or calls `recorder.voidRound(...)` to refund.

Add `'mygame'` to the `GameId` union in `domain/economy/economy-service.ts` and a setting group in
`config/settings.ts` (`enabled`, `minBet`, `maxBet`) so admins can configure it.

## 3. Achievements and missions

Add entries to `domain/achievements.ts` (use `progress: counter('mygame', 'plays', 50)` for
counters or `flag: 'mygame_jackpot'` for events) and optionally `domain/missions.ts`.

## 4. Screens and routing

- Build screens with `ui/kit.ts` (`container`, `text`, `section`, `gallery`, `row`, `button`…),
  colours from `ui/theme.ts`, and `navRow()` for consistent navigation.
- Use `cid('mg', 'action', ...args)` for custom ids and add a `case 'mg'` to `discord/router.ts`.
- Render artwork in `render/` as SVG and convert with `app.images.render(svg, width)` (cached).
- Add your screen to `tests/ui.test.ts` so it is validated against Discord's limits.

## Example lifecycle (blackjack)

1. `placeBet` → `economy.reserve` (ledger `wager`, escrow held) + table state saved — one transaction.
2. Deadline → `deal` → `startRound` (engine) → state saved.
3. `act('double')` → `economy.reserve` for the extra stake + engine `act` + state saved.
4. Last hand finishes → engine `playDealer` + `settleRound` → `recorder.record` (escrows settled,
   payouts, stats, XP, missions, achievements) → table moves to betting with a new round id — all in
   the transaction of that final action.
5. The observer notifies the Discord adapter, which renders the reveal frames and the results panel.
