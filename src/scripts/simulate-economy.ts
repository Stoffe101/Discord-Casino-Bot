import { DEFAULT_SETTINGS } from '../config/settings.js';
import { CasinoApp } from '../app/casino-app.js';
import { ManualClock } from '../core/clock.js';
import { silentLogger } from '../core/logger.js';
import { seededRng } from '../core/random.js';
import { ManualScheduler } from '../core/scheduler.js';
import { Database } from '../db/database.js';
import { availableActions, currentTurnUserId } from '../games/blackjack/engine.js';
import { basicStrategy } from '../games/blackjack/strategy.js';
import { pokerActions, type PokerAction } from '../games/poker/engine.js';
import { ALL_IN_DEAL_DELAY_MS } from '../tables/blackjack-table-service.js';

const guild = 'economy-simulation';
const previous = { startingBalance: 1000, passivePerHour: 50, dailyReward: 250, dailyStreakBonus: 25 };
const { startingBalance, passivePerHour, dailyReward, dailyStreakBonus } = DEFAULT_SETTINGS.economy;
const proposed = { startingBalance, passivePerHour, dailyReward, dailyStreakBonus };
const people = Array.from({ length: 12 }, (_, index) => ({
  id: String(index), attendance: index % 2 ? 28 : 72, game: index % 4, stake: [10, 25, 50, 100][Math.floor(index / 3)]!,
}));

async function model(days: number, economy: typeof previous, gifting: boolean, seed: number) {
  const db = new Database(':memory:');
  db.migrate();
  const clock = new ManualClock(Date.UTC(2026, 0, 1, 19));
  const scheduler = new ManualScheduler(clock);
  const rng = seededRng(seed);
  const app = new CasinoApp({ db, clock, scheduler, rng, logger: silentLogger });
  for (const [key, value] of Object.entries(economy)) app.settings.set(guild, 'economy.' + key, value);
  app.settings.set(guild, 'economy.giftingEnabled', gifting);
  app.settings.set(guild, 'poker.enabled', true);
  app.settings.set(guild, 'poker.minBuyIn', 40);
  for (const player of people) app.economy.ensurePlayer(guild, player.id);
  const balance = (userId: string) => app.economy.requirePlayer(guild, userId).balance;
  const blackjack = people.filter((player) => player.game === 0);
  const owner = blackjack[0]!.id;
  const table = await app.blackjack.createTable({ guildId: guild, ownerId: owner, ownerName: owner });
  const tableId = table.record.id;
  for (const player of blackjack.slice(1)) await app.blackjack.join(tableId, player.id, player.id);
  const { wheel } = await app.roulette.open(guild);
  let sessions = 0;
  let insufficient = 0;
  let lowVisits = 0;
  let pokerMoved = 0;
  let gifts = 0;
  for (let day = 0; day < days; day++) {
    const active = people.filter((player) => rng.int(100) < player.attendance);
    sessions += active.length;
    const isFriday = day % 7 === 4;
    for (const player of active) {
      if (balance(player.id) < player.stake) lowVisits++;
      if (rng.int(100) < 80 || balance(player.id) < player.stake) app.economy.claimPassive(guild, player.id);
      const daily = app.economy.getWallet(guild, player.id).daily;
      if (daily.available && (rng.int(100) < 75 || balance(player.id) < player.stake)) app.economy.claimDaily(guild, player.id);
      if (app.economy.reliefStatus(guild, player.id).eligible) app.economy.claimRelief(guild, player.id, false);
      if (balance(player.id) < player.stake) insufficient++;
    }
    if (gifting && day > 0 && isFriday) {
      const recipients = [...people].sort((a, b) => balance(a.id) - balance(b.id));
      const recipient = recipients[0]!;
      const sender = recipients.at(-1)!;
      if (recipient.id !== sender.id && balance(sender.id) > 200) {
        app.economy.gift(guild, sender.id, recipient.id, 25, 'sim-gift-' + day);
        gifts += 25;
      }
    }

    for (let round = 0; round < 10; round++) {
      const playing = active.filter((player) => player.game === 0 && balance(player.id) >= player.stake);
      if (!playing.length) break;
      for (const player of playing) await app.blackjack.placeBet(tableId, player.id, player.stake);
      clock.advance(Math.max(ALL_IN_DEAL_DELAY_MS, app.settings.get(guild).blackjack.bettingSeconds * 1000));
      scheduler.runDue();
      await app.blackjack.idle();
      let state = app.blackjack.peek(tableId)!.state;
      if (state.phase === 'insurance') {
        for (const seat of state.round!.seats) {
          if (seat.insurance.decision === 'pending') await app.blackjack.decideInsurance(tableId, seat.userId, false);
        }
        state = app.blackjack.peek(tableId)!.state;
      }
      while (state.phase === 'playing') {
        const hand = state.round!;
        const userId = currentTurnUserId(hand)!;
        const legal = availableActions(hand, userId);
        const actual = hand.seats[hand.turn!.seat]!.hands[hand.turn!.hand]!;
        const canPay = balance(userId) >= actual.bet;
        const move = basicStrategy(actual.cards, hand.dealer[0]!, { ...legal, split: legal.split && canPay, double: legal.double && canPay }, hand.rules.dealerHitsSoft17).move;
        await app.blackjack.act(tableId, userId, move, hand.seq);
        state = app.blackjack.peek(tableId)!.state;
      }
    }
    for (const player of active) {
      if (player.game === 1 && balance(player.id) >= player.stake) {
        await app.roulette.placeBet(wheel.record.id, { userId: player.id, displayName: player.id, type: 'red', amount: player.stake });
      }
      if (player.game === 2) {
        for (let spin = 0; spin < 16 && balance(player.id) >= player.stake; spin++) {
          await app.slots.spin(guild, player.id, player.stake, null);
        }
      }
    }
    clock.advance(app.settings.get(guild).roulette.bettingSeconds * 1000);
    scheduler.runDue();
    await app.roulette.idle();

    const pair = active.filter((person) => person.game === 3 && balance(person.id) >= 40).slice(0, 2);
    if (pair.length === 2) {
      if (day % 2 === 0) {
        const stake = Math.min(pair[0]!.stake, pair[1]!.stake, balance(pair[0]!.id), balance(pair[1]!.id));
        const challenge = await app.coinflip.create({ guildId: guild, challengerId: pair[0]!.id, opponentId: pair[1]!.id, amount: stake, call: 'heads' });
        await app.coinflip.accept(challenge.id, pair[1]!.id);
      } else {
        const [host, guest] = pair;
        const opening = [host!, guest!].map((person) => Math.min(balance(person.id), Math.max(40, person.stake * 2)));
        const table = await app.poker.create({ guildId: guild, userId: host!.id, name: host!.id, buyIn: opening[0]! });
        const id = table.record.id;
        await app.poker.join(id, guest!.id, guest!.id, opening[1]!);
        await app.poker.start(id, host!.id, app.poker.peek(id)!.record.version);
        while (app.poker.peek(id)!.state.hand) {
          const snapshot = app.poker.peek(id)!;
          const hand = snapshot.state.hand!;
          const player = hand.seats.find((seat) => seat.seat === hand.actor)!;
          const legal = pokerActions(hand, player.userId)!;
          const action: PokerAction = legal.minTo !== null && rng.int(4) === 0
            ? { type: 'raise', to: legal.minTo }
            : legal.check ? { type: 'check' } : rng.int(6) === 0 ? { type: 'fold' } : { type: 'call' };
          await app.poker.act(id, player.userId, snapshot.state.handId!, hand.seq, action);
        }
        pokerMoved += db.get<{ net: number }>("SELECT COALESCE(SUM(MAX(net, 0)), 0) AS net FROM round_results WHERE round_id = (SELECT id FROM game_rounds WHERE table_id = ?)", [id])!.net;
        await app.poker.close(id, 'simulation end');
      }
    }
    clock.set(Date.UTC(2026, 0, 2 + day, 19));
  }

  const supplies = db.all<{ type: string; total: number }>(
    "SELECT type, SUM(amount) AS total FROM ledger WHERE type IN ('initial_grant', 'passive_income', 'daily_reward', 'mission_reward', 'achievement_reward', 'emergency_relief') GROUP BY type",
  );
  const grants = Object.fromEntries(supplies.map(({ type, total }) => [type, total]));
  const house = db.get<{ paid: number; took: number }>(
    "SELECT COALESCE(SUM(MAX(net, 0)), 0) AS paid, COALESCE(SUM(MAX(-net, 0)), 0) AS took FROM round_results WHERE game IN ('blackjack', 'roulette', 'slots')",
  )!;
  const closing = people.map((person) => balance(person.id)).sort((a, b) => a - b);
  const total = closing.reduce((sum, chips) => sum + chips, 0);
  const created = house.paid + supplies.reduce((sum, row) => sum + row.total, 0);
  if (app.economy.reconcile().length || total !== created - house.took) throw new Error('Economy supply did not reconcile.');
  const report = {
    days, gifting, sessions, lowVisits, insufficient, created, removed: house.took, total,
    min: closing[0], max: closing.at(-1), median: (closing[5]! + closing[6]!) / 2,
    mean: Math.round(total / closing.length), pokerMoved, gifts, grants,
  };
  await app.shutdown();
  db.close();
  return report;
}

for (const days of [30, 90]) {
  for (const [label, config, gifting] of [['previous', previous, false], ['proposed', proposed, false], ['proposed-with-gifts', proposed, true]] as const) {
    console.log(JSON.stringify({ label, ...await model(days, config, gifting, 20261124) }));
  }
}
