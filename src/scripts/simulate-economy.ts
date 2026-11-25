/**
 * Seeded economy model for tuning passive income (and anything else that creates chips).
 *
 * Every scenario drives the real CasinoApp in an in-memory database with a manual clock: the
 * ledger, escrow, Hold'em stacks, daily missions, achievements, emergency relief and gifts all go
 * through production code. Attendance, game choice and claim habits are drawn up front from a
 * separate schedule stream, so every scenario sees exactly the same visits; only balances (and
 * therefore stakes, shortfalls and relief) differ. One 180-day run per scenario and seed is
 * snapshotted at day 30, 90 and 180.
 *
 *   npx tsx src/scripts/simulate-economy.ts                  # summary table, seeds 1-2
 *   npx tsx src/scripts/simulate-economy.ts --seeds 3 --json # plus one JSON line per snapshot
 *   npx tsx src/scripts/simulate-economy.ts --only 20/24,10/24 # rate/cap pairs from SCENARIOS
 *
 * Every economy key is set explicitly per scenario, so changing DEFAULT_SETTINGS never moves
 * the baseline.
 */
import { CasinoApp } from '../app/casino-app.js';
import { DAY, HOUR, ManualClock } from '../core/clock.js';
import { UserError } from '../core/errors.js';
import { silentLogger } from '../core/logger.js';
import { seededRng } from '../core/random.js';
import { ManualScheduler } from '../core/scheduler.js';
import { Database } from '../db/database.js';
import { availableActions, currentTurnUserId } from '../games/blackjack/engine.js';
import { basicStrategy } from '../games/blackjack/strategy.js';
import { pokerActions, type PokerAction } from '../games/poker/engine.js';
import type { RouletteBetType } from '../games/roulette/engine.js';
import { ALL_IN_DEAL_DELAY_MS } from '../tables/blackjack-table-service.js';

const GUILD = 'economy-simulation';
const START = Date.UTC(2026, 0, 1);
const HORIZONS = [30, 90, 180] as const;
const DAYS = HORIZONS.at(-1)!;

/** Everything except the passive keys, fixed so scenarios differ only in what they say. */
const BASE_ECONOMY = {
  startingBalance: 500, dailyReward: 100, dailyStreakBonus: 10, dailyStreakMaxDays: 7,
  reliefAmount: 50, reliefCooldownHours: 24, giftingEnabled: true, giftDailyLimit: 500,
};

interface Scenario { label: string; passivePerHour: number; passiveCapHours: number }
const SCENARIOS: readonly Scenario[] = [
  { label: '20/h 24h', passivePerHour: 20, passiveCapHours: 24 },
  { label: '15/h 24h', passivePerHour: 15, passiveCapHours: 24 },
  { label: '10/h 24h', passivePerHour: 10, passiveCapHours: 24 },
  { label: '10/h 48h', passivePerHour: 10, passiveCapHours: 48 },
  { label: '8/h 48h', passivePerHour: 8, passiveCapHours: 48 },
  { label: '5/h 48h', passivePerHour: 5, passiveCapHours: 48 },
  { label: 'off', passivePerHour: 0, passiveCapHours: 24 },
];

// ───────────────────────────── players ─────────────────────────────

type Game = 'blackjack' | 'roulette' | 'slots' | 'coinflip' | 'poker';
/** A fixed amount, or a share of the current balance (clamped to the game's limits). */
type Stake = { fixed: number } | { share: number };

interface Archetype {
  id: string;
  count: number;
  /** Percent chance of visiting on any given day. */
  attendance: number;
  /** First day per member (default 0). */
  joinDays?: readonly number[];
  games: readonly Game[];
  /** Assigned round-robin to members. */
  stakes: readonly Stake[];
  /** Percent of visits that include play (reward collectors rarely play). */
  playChance: number;
  /** Percent of visits that collect the daily reward. */
  dailyChance: number;
  /** A second, claim-only visit at 08:00 UTC. */
  morningVisit?: boolean;
  /** Fridays: percent chance to gift a friend, and how much. */
  gift?: { chance: number; amount: number };
}

const ARCHETYPES: readonly Archetype[] = [
  { id: 'infrequent', count: 8, attendance: 22, games: ['blackjack', 'roulette', 'slots'], stakes: [{ fixed: 10 }, { fixed: 25 }, { share: 0.05 }, { fixed: 50 }], playChance: 100, dailyChance: 100 },
  {
    id: 'regular', count: 10, attendance: 65, games: ['blackjack', 'roulette', 'slots', 'coinflip'],
    stakes: [{ fixed: 25 }, { fixed: 50 }, { share: 0.03 }, { share: 0.05 }, { fixed: 100 }], playChance: 100, dailyChance: 90, gift: { chance: 40, amount: 50 },
  },
  {
    id: 'blackjack', count: 8, attendance: 75, games: ['blackjack'],
    stakes: [{ fixed: 25 }, { fixed: 50 }, { fixed: 100 }, { share: 0.03 }, { share: 0.05 }, { share: 0.1 }, { fixed: 10 }, { share: 0.05 }], playChance: 100, dailyChance: 90,
  },
  { id: 'holdem', count: 8, attendance: 55, games: ['poker'], stakes: [{ share: 0.3 }, { share: 0.5 }, { fixed: 200 }, { share: 1 }], playChance: 100, dailyChance: 85 },
  { id: 'roulette', count: 4, attendance: 60, games: ['roulette'], stakes: [{ fixed: 25 }, { share: 0.05 }, { share: 0.1 }, { fixed: 50 }], playChance: 100, dailyChance: 90 },
  { id: 'slots', count: 4, attendance: 60, games: ['slots'], stakes: [{ fixed: 5 }, { fixed: 25 }, { share: 0.02 }, { share: 0.05 }], playChance: 100, dailyChance: 90 },
  { id: 'collector', count: 6, attendance: 85, games: ['roulette'], stakes: [{ fixed: 10 }, { fixed: 25 }], playChance: 10, dailyChance: 100, morningVisit: true, gift: { chance: 20, amount: 100 } },
  {
    id: 'newcomer', count: 4, attendance: 65, joinDays: [60, 60, 120, 120], games: ['blackjack', 'roulette', 'slots', 'coinflip'],
    stakes: [{ fixed: 25 }, { share: 0.05 }, { fixed: 50 }, { share: 0.03 }], playChance: 100, dailyChance: 90, gift: { chance: 40, amount: 50 },
  },
];

interface Person { id: string; type: Archetype; stake: Stake; joinDay: number; friend: string }

const PEOPLE: readonly Person[] = (() => {
  const people: Person[] = [];
  for (const type of ARCHETYPES) {
    for (let i = 0; i < type.count; i++) {
      people.push({ id: `${type.id}-${i}`, type, stake: type.stakes[i % type.stakes.length]!, joinDay: type.joinDays?.[i] ?? 0, friend: `${type.id}-${(i + 1) % type.count}` });
    }
  }
  return people;
})();

interface Visit { person: Person; game: Game; play: boolean; daily: boolean; gift: boolean; betKind: number }

/** Precomputed from its own stream so every scenario gets identical visits. */
function schedule(seed: number): { morning: Person[]; evening: Visit[] }[] {
  const rng = seededRng(seed * 7919 + 17);
  return Array.from({ length: DAYS }, (_, day) => {
    const morning: Person[] = [];
    const evening: Visit[] = [];
    for (const person of PEOPLE) {
      const { type } = person;
      const roll = rng.int(100);
      const choice = rng.int(type.games.length);
      const play = rng.int(100) < type.playChance;
      const daily = rng.int(100) < type.dailyChance;
      const gift = rng.int(100) < (type.gift?.chance ?? 0);
      const betKind = rng.int(100);
      const morningRoll = rng.int(100);
      if (day < person.joinDay) continue;
      if (day === person.joinDay || roll < type.attendance) {
        evening.push({ person, game: type.games[choice]!, play, daily, gift: gift && day % 7 === 4, betKind });
      }
      if (type.morningVisit && day > person.joinDay && morningRoll < type.attendance) morning.push(person);
    }
    return { morning, evening };
  });
}

// ───────────────────────────── one run ─────────────────────────────

interface Counters { visits: number; intents: number; short: number; blocked: number; busts: number; giftsSent: number; giftChips: number }
const zero = (): Counters => ({ visits: 0, intents: 0, short: 0, blocked: 0, busts: 0, giftsSent: 0, giftChips: 0 });

export interface Snapshot {
  scenario: string; seed: number; day: number; players: number;
  faucets: Record<string, number>; created: number; passive: number;
  passiveShare: number; passiveShareInclHouse: number;
  housePaid: number; houseTook: number; houseNet: number; houseNetByGame: Record<string, number>; pvpMoved: number;
  p10: number; p50: number; p90: number; max: number; mean: number;
  typicalBet: number; medianOverBet: number; medianOverMaxBet: number;
  period: Counters & { reliefs: number; shortRate: number; blockedRate: number; reliefPer100Visits: number };
  byArchetype: Record<string, number>;
}

async function run(scenario: Scenario, seed: number): Promise<Snapshot[]> {
  const db = new Database(':memory:');
  db.migrate();
  const clock = new ManualClock(START + 19 * HOUR);
  const scheduler = new ManualScheduler(clock);
  const behaviour = seededRng(seed * 104729 + 3);
  const app = new CasinoApp({ db, clock, scheduler, rng: seededRng(seed * 15485863 + 11), logger: silentLogger });
  const economy = { ...BASE_ECONOMY, passivePerHour: scenario.passivePerHour, passiveCapHours: scenario.passiveCapHours };
  for (const [key, value] of Object.entries(economy)) app.settings.set(GUILD, 'economy.' + key, value);
  app.settings.set(GUILD, 'poker.enabled', true);
  const settings = () => app.settings.get(GUILD);
  const wallet = (userId: string) => app.economy.getPlayer(GUILD, userId)?.balance ?? 0;
  const plan = schedule(seed);
  const snapshots: Snapshot[] = [];
  let counters = zero();
  let periodStart = clock.now();

  const limits = (game: Game): { min: number; max: number } => {
    const s = settings();
    switch (game) {
      case 'blackjack': return { min: s.blackjack.minBet, max: s.blackjack.maxBet };
      case 'roulette': return { min: s.roulette.minBet, max: s.roulette.maxBet };
      case 'slots': return { min: s.slots.minBet, max: s.slots.maxBet };
      case 'coinflip': return { min: s.coinflip.minBet, max: s.coinflip.maxBet };
      case 'poker': return { min: s.poker.minBuyIn, max: s.poker.maxBuyIn };
    }
  };
  /** What the player would like to stake right now (before checking the wallet). */
  const intended = (person: Person, game: Game): number => {
    const { min, max } = limits(game);
    const raw = 'fixed' in person.stake ? person.stake.fixed : Math.round((wallet(person.id) * person.stake.share) / 5) * 5;
    return Math.min(max, Math.max(min, raw));
  };
  /** What they can actually stake (0 = cannot play this game). */
  const affordable = (person: Person, game: Game): number => {
    const want = intended(person, game);
    const have = wallet(person.id);
    return have >= want ? want : have >= limits(game).min ? have : 0;
  };
  const tryRelief = (userId: string): void => {
    if (app.economy.reliefStatus(GUILD, userId).eligible) app.economy.claimRelief(GUILD, userId, false);
  };

  async function blackjack(group: Person[]): Promise<void> {
    for (let start = 0; start < group.length; start += 5) {
      const seated = group.slice(start, start + 5);
      const table = await app.blackjack.createTable({ guildId: GUILD, ownerId: seated[0]!.id, ownerName: seated[0]!.id });
      const tableId = table.record.id;
      for (const person of seated.slice(1)) await app.blackjack.join(tableId, person.id, person.id);
      for (let round = 0; round < 10; round++) {
        let bets = 0;
        for (const person of seated) {
          const amount = affordable(person, 'blackjack');
          if (amount > 0) {
            await app.blackjack.placeBet(tableId, person.id, amount);
            bets++;
          }
        }
        if (!bets) break;
        clock.advance(Math.max(ALL_IN_DEAL_DELAY_MS, settings().blackjack.bettingSeconds * 1000));
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
          const canPay = wallet(userId) >= actual.bet;
          const move = basicStrategy(actual.cards, hand.dealer[0]!, { ...legal, split: legal.split && canPay, double: legal.double && canPay }, hand.rules.dealerHitsSoft17).move;
          await app.blackjack.act(tableId, userId, move, hand.seq);
          state = app.blackjack.peek(tableId)!.state;
        }
        clock.advance(5_000);
        scheduler.runDue();
        await app.blackjack.idle();
      }
      await app.blackjack.closeTable(tableId, 'session over', { force: true });
    }
  }

  async function roulette(group: { person: Person; betKind: number }[]): Promise<void> {
    if (!group.length) return;
    const wheel = app.roulette.wheelFor(GUILD) ?? (await app.roulette.open(GUILD)).wheel;
    for (let spin = 0; spin < 6; spin++) {
      let bets = 0;
      for (const { person, betKind } of group) {
        const amount = affordable(person, 'roulette');
        if (!amount) continue;
        // Roulette regulars spread their bets; everyone else plays red or black.
        const focused = person.type.id === 'roulette';
        const pick = (betKind + spin * 37 + behaviour.int(100)) % 100;
        const type: RouletteBetType = !focused || pick < 65 ? (pick % 2 ? 'red' : 'black') : pick < 90 ? (['dozen1', 'dozen2', 'dozen3'] as const)[pick % 3]! : 'straight';
        await app.roulette.placeBet(wheel.record.id, { userId: person.id, displayName: person.id, type, number: type === 'straight' ? behaviour.int(37) : undefined, amount });
        bets++;
      }
      if (!bets) break;
      clock.advance(settings().roulette.bettingSeconds * 1000);
      scheduler.runDue();
      await app.roulette.idle();
      clock.advance(5_000);
      scheduler.runDue();
      await app.roulette.idle();
    }
  }

  async function slots(person: Person): Promise<void> {
    for (let spin = 0; spin < 20; spin++) {
      const amount = affordable(person, 'slots');
      if (!amount) break;
      await app.slots.spin(GUILD, person.id, amount, null);
    }
  }

  async function coinflip(pair: [Person, Person]): Promise<void> {
    for (let duel = 0; duel < 2; duel++) {
      const amount = Math.min(affordable(pair[0], 'coinflip'), affordable(pair[1], 'coinflip'));
      if (!amount) break;
      const challenge = await app.coinflip.create({ guildId: GUILD, challengerId: pair[0].id, opponentId: pair[1].id, amount, call: behaviour.int(2) ? 'heads' : 'tails' });
      await app.coinflip.accept(challenge.id, pair[1].id);
    }
  }

  async function poker(group: Person[]): Promise<void> {
    for (let start = 0; start + 1 < group.length; start += 6) {
      const players = group.slice(start, start + 6).filter((person) => affordable(person, 'poker') > 0);
      if (players.length < 2) continue;
      // Buy in with the wanted amount; if a table rule refuses it (such as a first-day limit for
      // new accounts), try the minimum, and otherwise sit this session out.
      let id: string | undefined;
      for (const person of players) {
        for (const amount of [affordable(person, 'poker'), limits('poker').min]) {
          try {
            if (id) await app.poker.join(id, person.id, person.id, amount);
            else id = (await app.poker.create({ guildId: GUILD, userId: person.id, name: person.id, buyIn: amount })).record.id;
            break;
          } catch (error) {
            if (!(error instanceof UserError)) throw error;
          }
        }
      }
      if (!id) continue;
      for (let handNo = 0; handNo < 8; handNo++) {
        const snapshot = app.poker.peek(id);
        if (!snapshot || snapshot.state.seats.filter((seat) => seat.stack > 0).length < 2) break;
        await app.poker.start(id, snapshot.record.ownerId, snapshot.record.version);
        while (app.poker.peek(id)!.state.hand) {
          const current = app.poker.peek(id)!;
          const hand = current.state.hand!;
          const player = hand.seats.find((seat) => seat.seat === hand.actor)!;
          const legal = pokerActions(hand, player.userId)!;
          const roll = behaviour.int(100);
          const action: PokerAction = legal.minTo !== null && roll < 15 ? { type: 'raise', to: legal.minTo }
            : legal.check ? { type: 'check' } : roll < 35 ? { type: 'fold' } : { type: 'call' };
          await app.poker.act(id, player.userId, current.state.handId!, hand.seq, action);
        }
      }
      await app.poker.close(id, 'session over');
    }
  }

  for (let day = 0; day < DAYS; day++) {
    const { morning, evening } = plan[day]!;
    clock.set(START + day * DAY + 8 * HOUR);
    for (const person of morning) {
      app.economy.ensurePlayer(GUILD, person.id, person.id);
      app.economy.claimPassive(GUILD, person.id);
      counters.visits++;
    }
    clock.set(START + day * DAY + 19 * HOUR);
    const players: { visit: Visit; game: Game }[] = [];
    for (const visit of evening) {
      const { person } = visit;
      app.economy.ensurePlayer(GUILD, person.id, person.id);
      counters.visits++;
      app.economy.claimPassive(GUILD, person.id);
      const daily = app.economy.getWallet(GUILD, person.id).daily;
      if (daily.available && (visit.daily || wallet(person.id) < limits(visit.game).min)) app.economy.claimDaily(GUILD, person.id);
      if (!visit.play) continue;
      counters.intents++;
      if (wallet(person.id) < intended(person, visit.game)) counters.short++;
      if (!affordable(person, visit.game)) tryRelief(person.id);
      if (!affordable(person, visit.game)) {
        counters.blocked++;
        continue;
      }
      players.push({ visit, game: visit.game });
    }

    // Fridays: a few friends send each other small gifts, and someone flush helps the poorest
    // player who showed up (accounts must be a day old; refusals are simply skipped).
    if (day % 7 === 4) {
      const present = evening.map((visit) => visit.person);
      const gifts: [string, string, number][] = evening
        .filter((visit) => visit.gift && visit.person.type.gift && wallet(visit.person.id) > 4 * visit.person.type.gift.amount)
        .map((visit) => [visit.person.id, visit.person.friend, visit.person.type.gift!.amount]);
      const byWealth = [...present].sort((a, b) => wallet(a.id) - wallet(b.id));
      if (byWealth.length > 1 && wallet(byWealth[0]!.id) < 100 && wallet(byWealth.at(-1)!.id) > 2000) gifts.push([byWealth.at(-1)!.id, byWealth[0]!.id, 100]);
      for (const [from, to, amount] of gifts) {
        try {
          if (!app.economy.getPlayer(GUILD, to)) continue;
          app.economy.gift(GUILD, from, to, amount, `sim-${seed}-${day}-${from}-${to}`);
          counters.giftsSent++;
          counters.giftChips += amount;
        } catch (error) {
          if (!(error instanceof UserError)) throw error;
        }
      }
    }

    await blackjack(players.filter((p) => p.game === 'blackjack').map((p) => p.visit.person));
    await roulette(players.filter((p) => p.game === 'roulette').map((p) => ({ person: p.visit.person, betKind: p.visit.betKind })));
    for (const p of players.filter((entry) => entry.game === 'slots')) await slots(p.visit.person);
    const flippers = players.filter((p) => p.game === 'coinflip').map((p) => p.visit.person);
    for (let i = 0; i + 1 < flippers.length; i += 2) await coinflip([flippers[i]!, flippers[i + 1]!]);
    if (flippers.length % 2) await slots(flippers.at(-1)!);
    await poker(players.filter((p) => p.game === 'poker').map((p) => p.visit.person));

    // Anyone who busted mid-session asks the relief fund once before leaving.
    for (const { visit, game } of players) {
      if (wallet(visit.person.id) < limits(game).min) {
        counters.busts++;
        tryRelief(visit.person.id);
      }
    }

    if ((HORIZONS as readonly number[]).includes(day + 1)) {
      snapshots.push(measure(db, app, scenario, seed, day + 1, counters, periodStart));
      counters = zero();
      periodStart = clock.now();
    }
  }
  if (app.economy.reconcile().length) throw new Error('Ledger did not reconcile.');
  await app.shutdown();
  db.close();
  return snapshots;
}

// ───────────────────────────── measurement ─────────────────────────────

const FAUCETS = ['initial_grant', 'passive_income', 'daily_reward', 'mission_reward', 'achievement_reward', 'emergency_relief'] as const;

function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

function median(sorted: readonly number[]): number {
  if (!sorted.length) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function measure(db: Database, app: CasinoApp, scenario: Scenario, seed: number, day: number, counters: Counters, periodStart: number): Snapshot {
  const now = app.clock.now();
  const rows = db.all<{ type: string; total: number }>(
    `SELECT type, SUM(amount) AS total FROM ledger WHERE guild_id = ? AND type IN (${FAUCETS.map(() => '?').join(', ')}) GROUP BY type`,
    [GUILD, ...FAUCETS],
  );
  const faucets = Object.fromEntries(FAUCETS.map((type) => [type, rows.find((row) => row.type === type)?.total ?? 0]));
  const created = Object.values(faucets).reduce((sum, value) => sum + value, 0);
  const house = db.get<{ paid: number; took: number }>(
    "SELECT COALESCE(SUM(MAX(net, 0)), 0) AS paid, COALESCE(SUM(MAX(-net, 0)), 0) AS took FROM round_results WHERE guild_id = ? AND game IN ('blackjack', 'roulette', 'slots')",
    [GUILD],
  )!;
  const houseNetByGame = Object.fromEntries(db.all<{ game: string; net: number }>(
    "SELECT game, -SUM(net) AS net FROM round_results WHERE guild_id = ? AND game IN ('blackjack', 'roulette', 'slots') GROUP BY game",
    [GUILD],
  ).map((row) => [row.game, row.net]));
  const pvp = db.get<{ moved: number }>("SELECT COALESCE(SUM(MAX(net, 0)), 0) AS moved FROM round_results WHERE guild_id = ? AND game IN ('poker', 'coinflip')", [GUILD])!.moved;
  const wallets = db.all<{ user_id: string; total: number }>('SELECT user_id, balance + reserved AS total FROM players WHERE guild_id = ?', [GUILD]);
  const sorted = wallets.map((w) => w.total).sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  if (total !== created - house.took + house.paid) throw new Error(`Supply mismatch on day ${day}: ${total} vs ${created - house.took + house.paid}`);
  const bets = db.all<{ wagered: number }>(
    "SELECT wagered FROM round_results WHERE guild_id = ? AND game IN ('blackjack', 'roulette', 'slots', 'coinflip') AND created_at > ? ORDER BY wagered",
    [GUILD, now - 30 * DAY],
  ).map((row) => row.wagered);
  const reliefs = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ledger WHERE guild_id = ? AND type = 'emergency_relief' AND created_at > ?", [GUILD, periodStart])!.n;
  const byArchetype: Record<string, number> = {};
  for (const type of ARCHETYPES) {
    const members = wallets.filter((w) => w.user_id.startsWith(type.id + '-')).map((w) => w.total).sort((a, b) => a - b);
    if (members.length) byArchetype[type.id] = median(members);
  }
  const p50 = median(sorted);
  const typicalBet = median(bets);
  const maxBet = app.settings.get(GUILD).blackjack.maxBet;
  const passive = faucets.passive_income ?? 0;
  return {
    scenario: scenario.label, seed, day, players: sorted.length, faucets, created, passive,
    passiveShare: passive / created, passiveShareInclHouse: passive / (created + house.paid),
    housePaid: house.paid, houseTook: house.took, houseNet: house.took - house.paid, houseNetByGame, pvpMoved: pvp,
    p10: quantile(sorted, 0.1), p50, p90: quantile(sorted, 0.9), max: sorted.at(-1) ?? 0, mean: Math.round(total / sorted.length),
    typicalBet, medianOverBet: typicalBet ? p50 / typicalBet : 0, medianOverMaxBet: p50 / maxBet,
    period: {
      ...counters, reliefs,
      shortRate: counters.intents ? counters.short / counters.intents : 0,
      blockedRate: counters.intents ? counters.blocked / counters.intents : 0,
      reliefPer100Visits: counters.visits ? (100 * reliefs) / counters.visits : 0,
    },
    byArchetype,
  };
}

// ───────────────────────────── report ─────────────────────────────

function argument(name: string): string | undefined {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const seedCount = Number(argument('seeds') ?? 2);
  const json = process.argv.includes('--json');
  const seeds = Array.from({ length: seedCount }, (_, i) => 20261125 + i);
  const only = argument('only')?.split(',');
  const scenarios = only ? SCENARIOS.filter((s) => only.includes(`${s.passivePerHour}/${s.passiveCapHours}`)) : SCENARIOS;
  const all: Snapshot[] = [];
  for (const scenario of scenarios) {
    for (const seed of seeds) {
      const snapshots = await run(scenario, seed);
      for (const snapshot of snapshots) if (json) console.log(JSON.stringify(snapshot));
      all.push(...snapshots);
    }
  }
  const avg = (items: Snapshot[], pick: (s: Snapshot) => number) => items.reduce((sum, s) => sum + pick(s), 0) / items.length;
  const pct = (value: number) => (100 * value).toFixed(0).padStart(3) + '%';
  const num = (value: number) => Math.round(value).toLocaleString('en-US');
  console.log(`\n${PEOPLE.length} players, seeds ${seeds.join(', ')} (means across seeds). Wallet = balance + committed chips.`);
  console.log('created = chips granted (start, passive, daily, missions, achievements, relief); passive% of that (and of that plus house payouts, the older measure).');
  console.log('typ.bet = median house-game/coinflip wager in the last 30 days; p50/max = median wallet in maximum blackjack bets.');
  console.log('short = visits where the wanted stake was unaffordable; blocked = could not play at all; rates are per period since the previous snapshot.');
  const header = ['scenario', 'day', 'created', 'passive%', '(incl house)', 'house net', 'p10', 'p50', 'p90', 'max', 'typ.bet', 'p50/bet', 'p50/max', 'short', 'blocked', 'relief/100v', 'newcomer p50'];
  console.log(header.join(' | '));
  for (const scenario of scenarios) {
    for (const day of HORIZONS) {
      const items = all.filter((s) => s.scenario === scenario.label && s.day === day);
      console.log([
        scenario.label.padEnd(9), String(day).padStart(3), num(avg(items, (s) => s.created)).padStart(9),
        pct(avg(items, (s) => s.passiveShare)), pct(avg(items, (s) => s.passiveShareInclHouse)), num(avg(items, (s) => s.houseNet)).padStart(8),
        num(avg(items, (s) => s.p10)).padStart(6), num(avg(items, (s) => s.p50)).padStart(7), num(avg(items, (s) => s.p90)).padStart(7), num(avg(items, (s) => s.max)).padStart(7),
        num(avg(items, (s) => s.typicalBet)).padStart(4), avg(items, (s) => s.medianOverBet).toFixed(0).padStart(4), avg(items, (s) => s.medianOverMaxBet).toFixed(0).padStart(4),
        pct(avg(items, (s) => s.period.shortRate)), pct(avg(items, (s) => s.period.blockedRate)), avg(items, (s) => s.period.reliefPer100Visits).toFixed(2).padStart(5),
        day > 120 ? num(avg(items, (s) => s.byArchetype.newcomer ?? 0)).padStart(6) : '     -',
      ].join(' | '));
    }
  }
  console.log(`\nDay ${DAYS} (mean across seeds): median wallet by archetype; chips created by source; house net take by game.`);
  for (const scenario of scenarios) {
    const items = all.filter((s) => s.scenario === scenario.label && s.day === DAYS);
    console.log(scenario.label.padEnd(9), ARCHETYPES.map((type) => `${type.id} ${num(avg(items, (s) => s.byArchetype[type.id] ?? 0))}`).join(', '));
    console.log(' '.repeat(9), FAUCETS.map((type) => `${type} ${num(avg(items, (s) => s.faucets[type] ?? 0))}`).join(', '));
    console.log(' '.repeat(9), ['blackjack', 'roulette', 'slots'].map((game) => `${game} ${num(avg(items, (s) => s.houseNetByGame[game] ?? 0))}`).join(', '), `· Hold'em/coinflip moved ${num(avg(items, (s) => s.pvpMoved))}`);
  }
}

await main();
