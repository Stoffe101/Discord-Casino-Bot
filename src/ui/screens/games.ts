import { createHash, randomInt } from 'node:crypto';
import type { CasinoApp } from '../../app/casino-app.js';
import { chips, countdown, discordTime, escapeMarkdown, signedChips } from '../../core/format.js';
import type { Challenge } from '../../games/coinflip/coinflip-service.js';
import { BET_TYPES, describeNumber, pocketColor, type RouletteBetType } from '../../games/roulette/engine.js';
import { rouletteReady, rouletteSpinAt, type WheelSnapshot } from '../../games/roulette/roulette-service.js';
import { SYMBOL_NAMES, THREE_OF_A_KIND, TWO_CHERRIES, exactReturnToPlayer } from '../../games/slots/engine.js';
import { coinSvg, coinTossFrames, rouletteSpinFrames, rouletteSvg, slotsSpinFrames, slotsSvg } from '../../render/game-images.js';
import { framesToGif, type GifFrame } from '../../render/gif.js';
import { GAMES, gameEnabled } from '../game-menu.js';
import { cid } from '../custom-id.js';
import {
  button,
  container,
  gallery,
  modal,
  option,
  row,
  section,
  select,
  selectLabel,
  separator,
  text,
  textInputLabel,
  userSelect,
  type ModalSpec,
  type Screen,
} from '../kit.js';
import { COLORS, ICONS } from '../theme.js';
import { navRow, type Viewer } from './common.js';

/** Extra time after a GIF's own length, so clients that load it a moment late still see it end. */
const LOAD_SLACK_MS = 450;

/** Encode animation frames as a GIF attachment, with how long to keep it up. */
async function gifFile(frames: GifFrame[], width: number, prefix: string): Promise<{ name: string; data: Buffer; holdMs: number }> {
  const { gif, durationMs } = await framesToGif(frames, width);
  const last = frames.at(-1)?.delayMs ?? 0; // the final still frame needn't be waited out
  return { name: `${prefix}-${createHash('sha1').update(gif).digest('hex').slice(0, 12)}.gif`, data: gif, holdMs: durationMs - last + LOAD_SLACK_MS };
}

// ───────────────────────────── hub ─────────────────────────────

export function gamesHubScreen(app: CasinoApp, viewer: Viewer): Screen {
  const settings = app.settings.get(viewer.guildId);
  const tableCount = app.blackjack.openTables(viewer.guildId).length;
  const availability = {
    blackjack: `${tableCount} open ${tableCount === 1 ? 'table' : 'tables'}`,
    roulette: app.roulette.wheelFor(viewer.guildId) ? 'Wheel open' : 'Open a shared wheel',
    slots: `${(exactReturnToPlayer().rtp * 100).toFixed(1)}% theoretical return`,
    coinflip: 'Two players',
  };
  return {
    components: [
      container(COLORS.emerald, [
        navRow('games'),
        text('## Games'),
        ...GAMES.flatMap((game) => {
          const enabled = gameEnabled(settings, game.id);
          const limits = settings[game.id];
          return [
            section([
              `**${game.icon} ${game.label}** · ${game.description}\n-# ${enabled ? `${availability[game.id]} · ${chips(limits.minBet)}–${chips(limits.maxBet)} chips` : 'Closed'}`,
            ], button({ id: game.play, label: game.id === 'blackjack' ? 'Browse tables' : game.id === 'roulette' ? 'Open the wheel' : game.id === 'slots' ? 'Play slots' : 'Play', tone: 'primary', disabled: !enabled })),
          ];
        }),
        row(...GAMES.map((game) => button({ id: game.rules, label: `${game.id === 'slots' ? 'Slots' : game.label} rules` }))),
        gameEnabled(settings, 'coinflip') ? userSelect(cid('cf', 'pick'), 'Challenge a friend to coinflip…') : null,
      ]),
    ],
  };
}

export function coinflipLobbyScreen(app: CasinoApp, viewer: Viewer): Screen {
  const enabled = gameEnabled(app.settings.get(viewer.guildId), 'coinflip');
  return { components: [container(COLORS.gold, [
    navRow('games'),
    text('## Coinflip\nPick a friend to challenge. You both put up the same number of chips. The winner takes the pot.'),
    enabled ? userSelect(cid('cf', 'pick'), 'Choose an opponent…') : text('Coinflip is closed.'),
  ])] };
}

// ───────────────────────────── slots ─────────────────────────────

const SLOT_BETS = [5, 10, 25, 50, 100, 250, 500, 1000];

/**
 * The player's private slot machine. `stopped` (0–2) renders an in-motion frame of the last spin:
 * only the first reels have stopped, nothing about the outcome (or the new balance) is shown yet,
 * and every control is disabled until the reels settle.
 */
/**
 * The slot machine. ``result``: this render answers a spin (show what it paid); otherwise the
 * machine was just opened or the bet changed, and the last spin is only mentioned in passing.
 */
export async function slotsScreen(app: CasinoApp, viewer: Viewer, bet: number, options: { stopped?: number; animate?: boolean; result?: boolean } = {}): Promise<Screen> {
  app.economy.ensurePlayer(viewer.guildId, viewer.userId, viewer.displayName);
  const s = app.settings.get(viewer.guildId).slots;
  const amount = Math.min(s.maxBet, Math.max(s.minBet, bet));
  const last = app.slots.lastSpin(viewer.guildId, viewer.userId);
  const spinning = (options.stopped !== undefined || options.animate === true) && last !== undefined && last !== null;
  const settled = app.economy.getPlayer(viewer.guildId, viewer.userId)!.balance;
  const balance = spinning ? settled - last.payout : settled;
  const count = app.slots.spinCount(viewer.guildId, viewer.userId);
  const line = last?.spin.line ?? [];
  const showResult = spinning || options.result === true;
  const paying = showResult && !spinning && last && last.payout > 0 ? (line.every((sym) => sym === line[0]) ? [0, 1, 2] : line.flatMap((sym, i) => (sym === 'cherry' ? [i] : []))) : [];
  const final = { rows: last?.spin.rows ?? null, win: (last?.payout ?? 0) > 0, label: last?.spin.label ?? '', bet: last?.bet ?? amount, payout: last?.payout ?? 0, paying: last && last.payout > 0 ? (line.every((sym) => sym === line[0]) ? [0, 1, 2] : line.flatMap((sym, i) => (sym === 'cherry' ? [i] : []))) : [] };
  // Animated: the reels roll and stop one by one (GIF); otherwise a still of the current state.
  const anim = options.animate && last ? await gifFile(slotsSpinFrames(final), 560, 'slots-spin') : null;
  const still = anim
    ? null
    : await app.images.render(slotsSvg({ ...final, win: showResult && !spinning && final.win, ...(spinning ? { stopped: options.stopped } : {}), paying, ...(last && !showResult ? { idle: true } : {}) }), 640);
  const file = anim ? anim.name : `slots-${still!.key}.png`;
  const png = anim ? anim.data : still!.png;
  const betOptions = [...new Set([s.minBet, ...SLOT_BETS.filter((b) => b > s.minBet && b < s.maxBet), s.maxBet])].slice(0, 5);
  const resultText = spinning
    ? `### Spinning…\n-# Bet ${chips(last.bet)} · spin #${count}`
    : last && !showResult
      ? `### Pull the lever
-# Last spin: ${last.payout > 0 ? `${last.spin.label} **+${chips(last.net)}**` : 'no win'} · bet ${chips(last.bet)}`
      : last
      ? last.payout > 0
        ? `### ${last.spin.label}! **+${chips(last.net)}**\n-# Bet ${chips(last.bet)} × ${last.spin.multiplier} · spin #${count}${last.recorded?.achievements.length ? ` · ✦ unlocked ${last.recorded.achievements.map((a) => a.name).join(', ')}` : ''}`
        : `### No win this time\n-# Bet ${chips(last.bet)} · ${signedChips(last.net)} · spin #${count}`
      : '### Pull the lever\n-# Line up three of a kind on the middle row. Two cherries pay double.';
  return {
    files: [{ name: file, data: png, description: spinning ? 'The reels are spinning' : last ? `Slot reels showing ${last.spin.line.join(', ')}` : 'Slot machine' }],
    ...(anim ? { holdMs: anim.holdMs } : {}),
    components: [
      container(showResult && !spinning && last && last.payout > 0 ? COLORS.gold : COLORS.emerald, [
        navRow('games', spinning),
        text(`## ${ICONS.slots} Emerald Slots\n-# Balance **${chips(balance)}** chips · bet **${chips(amount)}**`),
        gallery([{ url: `attachment://${file}`, description: 'Slot machine reels' }]),
        text(resultText),
        row(...betOptions.map((b) => button({ id: cid('nav', 'slots', b), label: chips(b), tone: b === amount ? 'primary' : 'secondary', disabled: spinning || b === amount }))),
        row(
          button({ id: cid('sl', 'spin', amount, count), label: `Spin ${chips(amount)}`, tone: 'success', disabled: spinning || balance < amount }),
          button({ id: cid('sl', 'pay', amount), label: 'Paytable', disabled: spinning }),
        ),
      ]),
    ],
  };
}

export function paytableScreen(bet: number): Screen {
  const { rtp, hitRate } = exactReturnToPlayer();
  const lines = Object.entries(THREE_OF_A_KIND).map(([sym, mult]) => `${SYMBOL_NAMES[sym as keyof typeof SYMBOL_NAMES]} × 3 — **×${mult}**`);
  lines.push(`Any two Cherries — **×${TWO_CHERRIES}**`);
  return {
    components: [
      container(COLORS.gold, [
        navRow('games'),
        text(`## Paytable\n${lines.join('\n')}\n-# Payouts include your stake. Return to player ${(rtp * 100).toFixed(2)}% · a win on ${(hitRate * 100).toFixed(1)}% of spins · each reel stops independently.`),
        row(button({ id: cid('nav', 'slots', bet), label: 'Back to the machine', emoji: ICONS.back })),
      ]),
    ],
  };
}

// ───────────────────────────── roulette ─────────────────────────────

const COLOR_DOT = { red: '🔴', black: '⚫', green: '🟢' } as const;

export async function roulettePanel(app: CasinoApp, wheel: Readonly<WheelSnapshot>, options: { spinFrame?: number; animate?: boolean } = {}): Promise<Screen> {
  const { record, state } = wheel;
  const s = app.settings.get(record.guildId).roulette;
  const result = state.lastResult;
  // The animated spin: wheel and ball in motion until the ball drops (the outcome stays out of the
  // text until the final frame replaces this one).
  if (options.animate && result) {
    const gif = await gifFile(rouletteSpinFrames({ result: result.number, history: state.history, spinNumber: result.spinNumber }), 640, 'wheel-spin');
    const bets = result.players.map((p) => `**${escapeMarkdown(p.displayName)}** ${p.bets.map((b) => `${b.label} ${chips(b.amount)}`).join(' · ')}`);
    return {
      files: [{ name: gif.name, data: gif.data, description: 'The roulette wheel is spinning' }],
      holdMs: gif.holdMs,
      components: [
        container(COLORS.emerald, [
          text(`## ${ICONS.roulette} Roulette\n-# Spin ${result.spinNumber} · no more bets`),
          gallery([{ url: `attachment://${gif.name}`, description: 'The roulette wheel is spinning' }]),
          text(`### No more bets — the ball is rolling…\n${bets.join('\n')}`),
        ]),
      ],
    };
  }
  // In-motion frames between "no more bets" and the result: the outcome is already settled, but
  // nothing about it is shown until the ball lands.
  if (options.spinFrame !== undefined && result) {
    const { key, png } = await app.images.render(
      rouletteSvg({ result: null, history: state.history, spinNumber: result.spinNumber, spin: { frame: options.spinFrame, wheelAngle: randomInt(360), ballAngle: randomInt(360) } }),
      760,
    );
    const file = `wheel-${key}.png`;
    const bets = result.players.map((p) => `**${escapeMarkdown(p.displayName)}** ${p.bets.map((b) => `${b.label} ${chips(b.amount)}`).join(' · ')}`);
    return {
      files: [{ name: file, data: png, description: 'The roulette wheel is spinning' }],
      components: [
        container(COLORS.emerald, [
          text(`## ${ICONS.roulette} Roulette\n-# Spin ${result.spinNumber} · no more bets`),
          gallery([{ url: `attachment://${file}`, description: 'The roulette wheel is spinning' }]),
          text(`### ${options.spinFrame === 0 ? 'No more bets — the ball is rolling…' : 'The ball is slowing down…'}\n${bets.join('\n')}`),
        ]),
      ],
    };
  }
  const { key, png } = await app.images.render(
    rouletteSvg({ result: result?.number ?? null, history: state.history, spinNumber: result?.spinNumber ?? 0 }),
    760,
  );
  const file = `wheel-${key}.png`;
  const lines: string[] = [];
  if (result) {
    lines.push(`### ${COLOR_DOT[pocketColor(result.number)]} ${describeNumber(result.number)}`);
    for (const p of result.players.slice(0, 8)) {
      const won = p.bets.filter((b) => b.returned > 0).map((b) => b.label);
      lines.push(
        `${p.net > 0 ? '▲' : p.net < 0 ? '▼' : '■'} ${escapeMarkdown(p.displayName)} ${p.net > 0 ? `won **${chips(p.net)}**` : p.net < 0 ? `lost ${chips(-p.net)}` : 'broke even'}${won.length ? ` · ${won.join(', ')}` : ''}`,
      );
    }
    const unlocked = result.players.flatMap((p) => p.achievements.map((a) => `${escapeMarkdown(p.displayName)} unlocked **${a}**`));
    if (unlocked.length) lines.push(`-# ✦ ${unlocked.join(' · ')}`);
  }
  const byUser = new Map<string, string[]>();
  for (const bet of state.bets) {
    const label = bet.type === 'straight' ? `#${bet.number}` : BET_TYPES.find((b) => b.type === bet.type)!.label;
    byUser.set(bet.userId, [...(byUser.get(bet.userId) ?? []), `${label} ${chips(bet.amount)}`]);
  }
  const betsText = [...byUser.entries()].map(([userId, bets]) => `**${escapeMarkdown(state.names[userId] ?? 'Player')}** ${bets.join(' · ')}`).join('\n');
  const due = rouletteSpinAt(state);
  const ready = rouletteReady(state);
  const timing = due ? `spinning ${countdown(due, app.clock.now(), 'now — last bets!')}` : 'the wheel spins after the first bet';
  const voting = ready.bettors > 0
    ? `**Ready to spin: ${ready.votes}/${ready.bettors}** · ${ready.required} required${state.readyAt && state.readyAt > app.clock.now() ? ` · early start opens ${discordTime(state.readyAt)}` : ''}`
    : null;
  return {
    files: [{ name: file, data: png, description: result ? `Roulette result ${result.number}` : 'Roulette wheel' }],
    components: [
      container(result ? COLORS.gold : COLORS.emerald, [
        text(`## ${ICONS.roulette} Roulette\n-# European single-zero wheel · bets ${chips(s.minBet)}–${chips(s.maxBet)} per spot · ${s.bettingSeconds}s betting window`),
        gallery([{ url: `attachment://${file}`, description: 'Roulette wheel' }]),
        lines.length ? text(lines.join('\n')) : null,
        separator(),
        text(`**Spin ${state.spinNumber + 1}** · ${timing}${betsText ? `\n${betsText}` : '\n-# No bets yet.'}`),
        voting ? text(voting) : null,
        select({
          id: cid('rl', 'bet', record.id, state.roundId),
          placeholder: 'Place a bet…',
          options: BET_TYPES.map((b) => option(b.label, b.type, b.description)),
        }),
        row(
          button({ id: cid('rl', 'clear', record.id, state.roundId), label: 'Withdraw bets', disabled: !ready.bettors }),
          button({ id: cid('rl', 'ready', record.id, state.roundId), label: 'Ready', tone: 'success', disabled: !ready.bettors }),
          button({ id: cid('rl', 'unready', record.id, state.roundId), label: 'Withdraw vote', disabled: !ready.votes }),
          button({ id: cid('rl', 'help', record.id), label: 'How to play', emoji: ICONS.help }),
          button({ id: cid('bj', 'home', 'wheel'), label: 'Casino', emoji: ICONS.home }),
        ),
      ]),
    ],
  };
}

export function rouletteBetModal(wheelId: string, type: RouletteBetType, min: number, max: number, roundId?: string): ModalSpec {
  const info = BET_TYPES.find((b) => b.type === type)!;
  const components = [
    textInputLabel({ id: 'amount', label: 'Bet amount', description: `${chips(min)}–${chips(max)} chips · ${info.description}`, value: String(min), max: 12, placeholder: 'e.g. 50, 1k or all' }),
  ];
  if (type === 'straight') {
    components.unshift(textInputLabel({ id: 'number', label: 'Number (0–36)', description: 'A straight-up bet pays 35:1', max: 2, placeholder: '17' }));
  }
  return modal(cid('m', 'rlbet', wheelId, type, roundId), `Bet on ${info.label}`, components);
}

export function rouletteHelpScreen(): Screen {
  return {
    components: [
      container(COLORS.emerald, [
        navRow('games'),
        text(
          `## How roulette works\nPick a bet from the menu and enter an amount — your chips are set aside straight away. The first bet starts the betting window; the wheel spins when time runs out or when a majority of bettors vote Ready and the minimum betting window has passed.\n\n${BET_TYPES.map((b) => `▸ **${b.label}** — ${b.description}`).join('\n')}\n-# Zero is green: every outside bet loses on 0. House edge 2.70% on every bet.`,
        ),
      ]),
    ],
  };
}

// ───────────────────────────── coinflip ─────────────────────────────

export function coinflipModal(opponentId: string, opponentName: string, min: number, max: number): ModalSpec {
  return modal(cid('m', 'cf', opponentId), `Challenge ${opponentName}`.slice(0, 45), [
    textInputLabel({ id: 'amount', label: 'Stake (each)', description: `${chips(min)}–${chips(max)} chips — the winner takes both`, value: String(min), max: 12, placeholder: 'e.g. 100, 1k or half' }),
    selectLabel({
      id: 'call',
      label: 'Your call',
      options: [option('Heads', 'heads', 'The crown side', undefined, true), option('Tails', 'tails', 'The spade side')],
    }),
  ]);
}

export async function coinflipMessage(app: CasinoApp, challenge: Challenge, names: { challenger: string; opponent: string }, options: { flipping?: boolean; animate?: boolean } = {}): Promise<Screen> {
  const c = escapeMarkdown(names.challenger);
  const o = escapeMarkdown(names.opponent);
  const pot = challenge.amount * 2;
  if (options.flipping && challenge.status === 'resolved') {
    // The moment between "accepted" and the result: nothing about the outcome is shown yet.
    // Animated: the coin is tossed, tumbles and lands (GIF); otherwise a still of it mid-air.
    const anim = options.animate && challenge.result ? await gifFile(coinTossFrames(challenge.result), 420, 'coin-toss') : null;
    const still = anim ? null : await app.images.render(coinSvg('flip'), 420);
    const file = anim ? anim.name : `coin-${still!.key}.png`;
    return {
      files: [{ name: file, data: anim ? anim.data : still!.png, description: 'The coin is in the air' }],
      ...(anim ? { holdMs: anim.holdMs } : {}),
      components: [
        container(COLORS.gold, [
          text(`## ${ICONS.coinflip} The coin is in the air…`),
          gallery([{ url: `attachment://${file}`, description: 'The coin is in the air' }]),
          text(`**${c}** called **${challenge.call === 'heads' ? 'Heads' : 'Tails'}** · **${o}** has the other side · pot **${chips(pot)}**`),
        ]),
      ],
    };
  }
  if (challenge.status === 'pending') {
    return {
      components: [
        container(COLORS.gold, [
          text(
            `## ${ICONS.coinflip} Coinflip duel\n**${c}** challenges <@${challenge.opponentId}> to a flip for **${chips(challenge.amount)}** chips each.\n${c} calls **${challenge.call === 'heads' ? 'Heads' : 'Tails'}** · winner takes **${chips(pot)}**\n-# ${o}, accept or decline below · expires ${discordTime(challenge.expiresAt)}`,
          ),
          row(
            button({ id: cid('cf', 'accept', challenge.id), label: `Accept (${chips(challenge.amount)})`, tone: 'success' }),
            button({ id: cid('cf', 'decline', challenge.id), label: 'Decline', tone: 'danger' }),
            button({ id: cid('cf', 'cancel', challenge.id), label: 'Cancel' }),
          ),
        ]),
      ],
    };
  }
  if (challenge.status === 'resolved') {
    const { key, png } = await app.images.render(coinSvg(challenge.result), 420);
    const file = `coin-${key}.png`;
    const winner = challenge.winnerId === challenge.challengerId ? c : o;
    return {
      files: [{ name: file, data: png, description: `The coin landed on ${challenge.result}` }],
      components: [
        container(COLORS.gold, [
          text(`## ${ICONS.coinflip} ${challenge.result === 'heads' ? 'Heads' : 'Tails'}!`),
          gallery([{ url: `attachment://${file}`, description: `The coin landed on ${challenge.result}` }]),
          text(`**${winner}** wins the pot of **${chips(pot)}** chips.\n-# ${c} called ${challenge.call} · ${chips(challenge.amount)} each`),
        ]),
      ],
    };
  }
  const why = challenge.status === 'declined' ? `${o} declined` : challenge.status === 'cancelled' ? `${c} cancelled` : 'Nobody answered in time';
  return {
    components: [
      container(COLORS.charcoal, [text(`## ${ICONS.coinflip} Coinflip duel — closed\n${why}. The stake was refunded.`)]),
    ],
  };
}
