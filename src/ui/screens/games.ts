import type { CasinoApp } from '../../app/casino-app.js';
import { chips, discordTime, escapeMarkdown, signedChips } from '../../core/format.js';
import type { Challenge } from '../../games/coinflip/coinflip-service.js';
import { BET_TYPES, describeNumber, pocketColor, type RouletteBetType } from '../../games/roulette/engine.js';
import type { WheelSnapshot } from '../../games/roulette/roulette-service.js';
import { SYMBOL_NAMES, THREE_OF_A_KIND, TWO_CHERRIES, exactReturnToPlayer } from '../../games/slots/engine.js';
import { coinSvg, rouletteSvg, slotsSvg } from '../../render/game-images.js';
import { cid } from '../custom-id.js';
import {
  button,
  container,
  gallery,
  linkButton,
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
import { NAV, channelUrl, navRow, type Viewer } from './common.js';

// ───────────────────────────── hub ─────────────────────────────

export function gamesHubScreen(app: CasinoApp, viewer: Viewer): Screen {
  const s = app.settings.get(viewer.guildId);
  const wheel = app.roulette.wheelFor(viewer.guildId);
  const wheelUrl = wheel?.record.threadId
    ? channelUrl(viewer.guildId, wheel.record.threadId)
    : wheel?.record.channelId && wheel.record.messageId
      ? channelUrl(viewer.guildId, wheel.record.channelId, wheel.record.messageId)
      : null;
  return {
    components: [
      container(COLORS.emerald, [
        text('## 🎲 More games\n-# Blackjack is the house special — but the night is young.'),
        section(
          [`**${ICONS.roulette} Roulette** — a shared European wheel. Everyone bets during a short window, then it spins.\n-# Bets ${chips(s.roulette.minBet)}–${chips(s.roulette.maxBet)} per spot`],
          wheelUrl
            ? linkButton('Go to the wheel', wheelUrl)
            : button({ id: cid('rl', 'open'), label: 'Open the wheel', tone: 'primary', disabled: !s.roulette.enabled }),
        ),
        section(
          [`**${ICONS.slots} Emerald Slots** — your own private machine. Three reels, one payline, ${(exactReturnToPlayer().rtp * 100).toFixed(1)}% return.\n-# Spins ${chips(s.slots.minBet)}–${chips(s.slots.maxBet)}`],
          button({ id: cid('nav', 'slots', s.slots.minBet), label: 'Play slots', tone: 'primary', disabled: !s.slots.enabled }),
        ),
        text(`**${ICONS.coinflip} Coinflip duel** — challenge a friend: equal stakes, one flip, winner takes the pot.\n-# Stakes ${chips(s.coinflip.minBet)}–${chips(s.coinflip.maxBet)} · the challenge is posted in this channel`),
        s.coinflip.enabled ? userSelect(cid('cf', 'pick'), 'Challenge someone to a coinflip…') : null,
        navRow('home', [button({ id: NAV.home, label: 'Home', emoji: ICONS.home })]),
      ]),
    ],
  };
}

// ───────────────────────────── slots ─────────────────────────────

const SLOT_BETS = [5, 10, 25, 50, 100, 250, 500, 1000];

export async function slotsScreen(app: CasinoApp, viewer: Viewer, bet: number): Promise<Screen> {
  app.economy.ensurePlayer(viewer.guildId, viewer.userId, viewer.displayName);
  const s = app.settings.get(viewer.guildId).slots;
  const amount = Math.min(s.maxBet, Math.max(s.minBet, bet));
  const last = app.slots.lastSpin(viewer.guildId, viewer.userId);
  const balance = app.economy.getPlayer(viewer.guildId, viewer.userId)!.balance;
  const count = app.slots.spinCount(viewer.guildId, viewer.userId);
  const svg = slotsSvg({ rows: last?.spin.rows ?? null, win: (last?.payout ?? 0) > 0, label: last?.spin.label ?? '', bet: last?.bet ?? amount, payout: last?.payout ?? 0 });
  const { key, png } = await app.images.render(svg, 640);
  const file = `slots-${key}.png`;
  const options = [...new Set([s.minBet, ...SLOT_BETS.filter((b) => b > s.minBet && b < s.maxBet), s.maxBet])].slice(0, 5);
  const resultText = last
    ? last.payout > 0
      ? `### ${last.spin.label}! **+${chips(last.net)}**\n-# Bet ${chips(last.bet)} × ${last.spin.multiplier}${last.recorded?.achievements.length ? ` · ✦ unlocked ${last.recorded.achievements.map((a) => a.name).join(', ')}` : ''}`
      : `### No win this time\n-# Bet ${chips(last.bet)} · ${signedChips(last.net)}`
    : '### Pull the lever\n-# Line up three of a kind on the middle row. Two cherries pay double.';
  return {
    files: [{ name: file, data: png, description: last ? `Slot reels showing ${last.spin.line.join(', ')}` : 'Slot machine' }],
    components: [
      container(last && last.payout > 0 ? COLORS.gold : COLORS.emerald, [
        text(`## ${ICONS.slots} Emerald Slots\n-# Balance **${chips(balance)}** chips · bet **${chips(amount)}**`),
        gallery([{ url: `attachment://${file}`, description: 'Slot machine reels' }]),
        text(resultText),
        row(...options.map((b) => button({ id: cid('nav', 'slots', b), label: chips(b), tone: b === amount ? 'primary' : 'secondary', disabled: b === amount }))),
        row(
          button({ id: cid('sl', 'spin', amount, count), label: `Spin ${chips(amount)}`, tone: 'success', disabled: balance < amount }),
          button({ id: cid('sl', 'pay', amount), label: 'Paytable' }),
          button({ id: NAV.games, label: 'Games', emoji: ICONS.games }),
          button({ id: NAV.home, label: 'Home', emoji: ICONS.home }),
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
        text(`## Paytable\n${lines.join('\n')}\n-# Payouts include your stake. Return to player ${(rtp * 100).toFixed(2)}% · a win on ${(hitRate * 100).toFixed(1)}% of spins · each reel stops independently.`),
        row(button({ id: cid('nav', 'slots', bet), label: 'Back to the machine', emoji: ICONS.back })),
      ]),
    ],
  };
}

// ───────────────────────────── roulette ─────────────────────────────

const COLOR_DOT = { red: '🔴', black: '⚫', green: '🟢' } as const;

export async function roulettePanel(app: CasinoApp, wheel: Readonly<WheelSnapshot>): Promise<Screen> {
  const { record, state } = wheel;
  const s = app.settings.get(record.guildId).roulette;
  const result = state.lastResult;
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
  const timing = state.deadline ? `spinning ${discordTime(state.deadline)}` : 'the wheel spins after the first bet';
  return {
    files: [{ name: file, data: png, description: result ? `Roulette result ${result.number}` : 'Roulette wheel' }],
    components: [
      container(result ? COLORS.gold : COLORS.emerald, [
        text(`## ${ICONS.roulette} Roulette\n-# European single-zero wheel · bets ${chips(s.minBet)}–${chips(s.maxBet)} per spot · ${s.bettingSeconds}s betting window`),
        gallery([{ url: `attachment://${file}`, description: 'Roulette wheel' }]),
        lines.length ? text(lines.join('\n')) : null,
        separator(),
        text(`**Spin ${state.spinNumber + 1}** · ${timing}${betsText ? `\n${betsText}` : '\n-# No bets yet.'}`),
        select({
          id: cid('rl', 'bet', record.id),
          placeholder: 'Place a bet…',
          options: BET_TYPES.map((b) => option(b.label, b.type, b.description)),
        }),
        row(
          button({ id: cid('rl', 'clear', record.id), label: 'Withdraw my bets', disabled: state.bets.length === 0 }),
          button({ id: cid('rl', 'help', record.id), label: 'How to play', emoji: ICONS.help }),
          button({ id: cid('bj', 'home', 'wheel'), label: 'Casino', emoji: ICONS.home }),
        ),
      ]),
    ],
  };
}

export function rouletteBetModal(wheelId: string, type: RouletteBetType, min: number, max: number): ModalSpec {
  const info = BET_TYPES.find((b) => b.type === type)!;
  const components = [
    textInputLabel({ id: 'amount', label: 'Bet amount', description: `${chips(min)}–${chips(max)} chips · ${info.description}`, value: String(min), max: 12 }),
  ];
  if (type === 'straight') {
    components.unshift(textInputLabel({ id: 'number', label: 'Number (0–36)', description: 'A straight-up bet pays 35:1', max: 2, placeholder: '17' }));
  }
  return modal(cid('m', 'rlbet', wheelId, type), `Bet on ${info.label}`, components);
}

export function rouletteHelpScreen(): Screen {
  return {
    components: [
      container(COLORS.emerald, [
        text(
          `## How roulette works\nPick a bet from the menu and enter an amount — your chips are set aside straight away. The first bet starts the betting window; when it ends the wheel spins and everyone is paid at once.\n\n${BET_TYPES.map((b) => `▸ **${b.label}** — ${b.description}`).join('\n')}\n-# Zero is green: every outside bet loses on 0. House edge 2.70% on every bet.`,
        ),
      ]),
    ],
  };
}

// ───────────────────────────── coinflip ─────────────────────────────

export function coinflipModal(opponentId: string, opponentName: string, min: number, max: number): ModalSpec {
  return modal(cid('m', 'cf', opponentId), `Challenge ${opponentName}`.slice(0, 45), [
    textInputLabel({ id: 'amount', label: 'Stake (each)', description: `${chips(min)}–${chips(max)} chips — the winner takes both`, value: String(min), max: 12 }),
    selectLabel({
      id: 'call',
      label: 'Your call',
      options: [option('Heads', 'heads', 'The crown side', undefined, true), option('Tails', 'tails', 'The spade side')],
    }),
  ]);
}

export async function coinflipMessage(app: CasinoApp, challenge: Challenge, names: { challenger: string; opponent: string }): Promise<Screen> {
  const c = escapeMarkdown(names.challenger);
  const o = escapeMarkdown(names.opponent);
  const pot = challenge.amount * 2;
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
