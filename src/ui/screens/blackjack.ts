import type { CasinoApp } from '../../app/casino-app.js';
import { chips, escapeMarkdown, discordTime, plural } from '../../core/format.js';
import { cardLabel } from '../../games/cards.js';
import { describeRules, describeTotal, type BlackjackRules } from '../../games/blackjack/engine.js';
import { renderTableSvg } from '../../render/table-image.js';
import { rulesFromSettings } from '../../tables/blackjack-table-service.js';
import { buildTableView, describeTableForAlt } from '../../tables/table-view.js';
import type { LogEntry, TableSnapshot } from '../../tables/types.js';
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
  selectLabel,
  separator,
  text,
  textInputLabel,
  userSelect,
  type ModalSpec,
  type Screen,
} from '../kit.js';
import { COLORS, ICONS } from '../theme.js';
import { NAV, channelUrl, type Viewer } from './common.js';

const CHIP_VALUES = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000];

/** Up to five bet presets spanning the table limits: min, three "nice" values, max. */
export function chipPresets(min: number, max: number): number[] {
  const inner = CHIP_VALUES.filter((v) => v > min && v < max);
  const picks: number[] = [];
  if (inner.length <= 3) picks.push(...inner);
  else for (let i = 0; i < 3; i++) picks.push(inner[Math.round((i * (inner.length - 1)) / 2)]!);
  return [...new Set([min, ...picks, max])].sort((a, b) => a - b).slice(0, 5);
}

export function tableRules(app: CasinoApp, snapshot: Readonly<TableSnapshot>): BlackjackRules {
  return snapshot.state.round?.rules ?? rulesFromSettings(app.settings.get(snapshot.record.guildId).blackjack);
}

/** One-line status for lobby/table lists. */
export function tableSummary(snapshot: Readonly<TableSnapshot>): string {
  const { record, state } = snapshot;
  const seated = `${state.seats.length}/${record.config.maxSeats} seated`;
  const phase =
    state.phase === 'playing' || state.phase === 'insurance'
      ? `hand ${state.roundNumber} in play`
      : Object.keys(state.bets).length > 0
        ? 'taking bets'
        : state.seats.length === 0
          ? 'empty'
          : 'waiting for bets';
  return `${seated} · ${phase} · bets ${chips(record.config.minBet)}–${chips(record.config.maxBet)}`;
}

function tableLocation(snapshot: Readonly<TableSnapshot>): string | null {
  const { record } = snapshot;
  if (record.threadId) return channelUrl(record.guildId, record.threadId);
  if (record.channelId && record.messageId) return channelUrl(record.guildId, record.channelId, record.messageId);
  return null;
}

// ───────────────────────────── table browser ─────────────────────────────

export function tablesScreen(app: CasinoApp, viewer: Viewer): Screen {
  app.economy.ensurePlayer(viewer.guildId, viewer.userId, viewer.displayName);
  const tables = app.blackjack.openTables(viewer.guildId).slice(0, 6);
  const settings = app.settings.get(viewer.guildId);
  const mine = app.blackjack.tableOfUser(viewer.guildId, viewer.userId);
  const sections = tables.map((t) => {
    const seatedHere = t.state.seats.some((s) => s.userId === viewer.userId);
    const full = t.state.seats.length >= t.record.config.maxSeats;
    const url = tableLocation(t);
    const players = t.state.seats.map((s) => escapeMarkdown(s.displayName)).join(', ');
    const accessory = seatedHere
      ? url
        ? linkButton('Your seat', url, ICONS.blackjack)
        : button({ id: cid('tbl', 'join', t.record.id), label: 'Your seat', disabled: true })
      : full
        ? url
          ? linkButton('Watch', url)
          : button({ id: cid('tbl', 'join', t.record.id), label: 'Full', disabled: true })
        : button({ id: cid('tbl', 'join', t.record.id), label: t.record.isPrivate ? 'Join 🔒' : 'Join', tone: 'success' });
    return section(
      [`**${escapeMarkdown(t.record.name)}**${t.record.isPrivate ? ' · private' : ''}\n${tableSummary(t)}${players ? `\n-# ${players}` : ''}`],
      accessory,
    );
  });
  const canCreate = settings.blackjack.enabled && !mine;
  return {
    components: [
      container(COLORS.emerald, [
        text(
          `## ♠ Blackjack tables\n-# ${tables.length ? 'Pick a seat — each table has its own dealer, shoe and thread.' : 'No tables are open yet. Open one and your friends can join you.'}`,
        ),
        ...sections,
        mine ? text(`-# You're seated at **${escapeMarkdown(mine.record.name)}**. Leave it to join another table.`) : null,
        row(
          button({ id: cid('tbl', 'quick'), label: 'Quick seat', emoji: ICONS.blackjack, tone: 'success', disabled: !!mine || !settings.blackjack.enabled }),
          button({ id: cid('tbl', 'create'), label: 'Open a table', tone: 'primary', disabled: !canCreate }),
          button({ id: NAV.tables, label: 'Refresh', emoji: ICONS.refresh }),
          button({ id: NAV.home, label: 'Home', emoji: ICONS.home }),
        ),
      ]),
    ],
  };
}

export function createTableModal(app: CasinoApp, guildId: string): ModalSpec {
  const bj = app.settings.get(guildId).blackjack;
  const seatOptions = Array.from({ length: bj.maxSeats }, (_, i) => i + 1)
    .filter((n) => n >= 1)
    .reverse()
    .map((n) => option(`${n} ${n === 1 ? 'seat' : 'seats'}`, String(n), n === bj.maxSeats ? 'Default' : undefined, undefined, n === bj.maxSeats));
  return modal(cid('m', 'tblcreate'), 'Open a blackjack table', [
    textInputLabel({ id: 'name', label: 'Table name', description: 'Optional — e.g. "The High Rollers"', required: false, max: 32, placeholder: 'Leave blank for a numbered table' }),
    selectLabel({
      id: 'visibility',
      label: 'Who can join?',
      options: [
        option('Public', 'public', 'Anyone in the server can sit down', undefined, true),
        option('Private', 'private', 'Players need an access code from you'),
      ],
    }),
    selectLabel({ id: 'seats', label: 'Seats', options: seatOptions }),
    textInputLabel({ id: 'min', label: 'Minimum bet', description: `Server range ${chips(bj.minBet)}–${chips(bj.maxBet)}`, required: false, value: String(bj.minBet), max: 9 }),
    textInputLabel({ id: 'max', label: 'Maximum bet', required: false, value: String(bj.maxBet), max: 9 }),
  ]);
}

export function accessCodeModal(tableId: string, tableName: string): ModalSpec {
  return modal(cid('m', 'tblcode', tableId), `Join ${tableName}`.slice(0, 45), [
    textInputLabel({ id: 'code', label: 'Access code', description: 'Ask the table host for the 5-character code', min: 4, max: 8, placeholder: 'e.g. K7Q2M' }),
  ]);
}

export function customBetModal(tableId: string, min: number, max: number, current: number | null): ModalSpec {
  return modal(cid('m', 'bjbet', tableId), 'Place a custom bet', [
    textInputLabel({
      id: 'amount',
      label: 'Bet amount',
      description: `Between ${chips(min)} and ${chips(max)} chips`,
      value: current ? String(current) : undefined,
      max: 12,
      placeholder: String(min),
    }),
  ]);
}

// ───────────────────────────── table panel ─────────────────────────────

const TONE_GLYPH: Record<LogEntry['tone'], string> = { info: '·', good: '▲', bad: '▼', gold: '✦' };

/**
 * The shared, persistent panel in each table's thread. Everyone sees it; buttons act for
 * whoever presses them, and turn controls only work for the active player (checked server-side).
 */
export async function blackjackPanel(app: CasinoApp, snapshot: Readonly<TableSnapshot>, options: { revealStep?: number } = {}): Promise<Screen> {
  const { record, state } = snapshot;
  const rules = tableRules(app, snapshot);
  const view = buildTableView(snapshot, rules, options);
  const svg = renderTableSvg(view);
  const { key, png } = await app.images.render(svg, 800);
  const fileName = `table-${key}.png`;
  const host = state.seats.find((s) => s.userId === record.ownerId)?.displayName;
  const header =
    `## ♠ ${escapeMarkdown(record.name)}${record.isPrivate ? ' 🔒' : ''}\n` +
    `-# Blackjack · ${state.seats.length}/${record.config.maxSeats} seated · bets ${chips(record.config.minBet)}–${chips(record.config.maxBet)}${host ? ` · host ${escapeMarkdown(host)}` : ''}`;
  const tableId = record.id;
  const parts: ReturnType<typeof text>[] = [];
  const rows: ReturnType<typeof row>[] = [];
  const revealing = options.revealStep !== undefined;

  if (revealing && state.lastResult) {
    const shown = state.lastResult.dealerCards.slice(0, 2 + options.revealStep!);
    parts.push(text(`### Dealer's turn\nThe dealer shows ${shown.map(cardLabel).join(' ')} — **${describeTotal(shown)}**`));
  } else if (state.phase === 'playing' && state.round) {
    const round = state.round;
    const turn = round.turn!;
    const seat = round.seats[turn.seat]!;
    const hand = seat.hands[turn.hand]!;
    const who = state.seats.find((s) => s.userId === seat.userId)?.displayName ?? 'Player';
    const opts = app.blackjack.playerOptions(tableId, seat.userId);
    const handOf = seat.hands.length > 1 ? ` · hand ${turn.hand + 1} of ${seat.hands.length}` : '';
    parts.push(
      text(
        `### ▸ ${escapeMarkdown(who)} to act${handOf}\n${hand.cards.map(cardLabel).join('  ')} — **${describeTotal(hand.cards, hand.fromSplit)}** · bet ${chips(hand.bet)}\n-# Decide ${discordTime(state.deadline ?? app.clock.now())} — after that the hand stands automatically.`,
      ),
    );
    const seq = round.seq;
    const id = (action: string) => cid('bj', 'act', tableId, action, seq);
    rows.push(
      row(
        button({ id: id('hit'), label: 'Hit', tone: 'success', disabled: !opts?.hit }),
        button({ id: id('stand'), label: 'Stand', tone: 'danger', disabled: !opts?.stand }),
        button({
          id: id('double'),
          label: opts?.double && !opts.canAffordDouble ? 'Double (no chips)' : 'Double',
          tone: 'primary',
          disabled: !opts?.double || !opts.canAffordDouble,
        }),
        button({ id: id('split'), label: opts?.split && !opts.canAffordSplit ? 'Split (no chips)' : 'Split', tone: 'primary', disabled: !opts?.split || !opts.canAffordSplit }),
        rules.surrender ? button({ id: id('surrender'), label: 'Surrender', disabled: !opts?.surrender }) : null,
      ),
    );
  } else if (state.phase === 'insurance' && state.round) {
    const pending = state.round.seats
      .filter((s) => s.insurance.decision === 'pending')
      .map((s) => escapeMarkdown(state.seats.find((x) => x.userId === s.userId)?.displayName ?? 'Player'));
    parts.push(
      text(
        `### The dealer shows an ace — insurance?\nInsurance costs half your bet and pays **2:1** if the dealer has blackjack.\n-# Waiting for ${pending.join(', ') || 'nobody'} · closes ${discordTime(state.deadline ?? app.clock.now())}`,
      ),
    );
    rows.push(
      row(
        button({ id: cid('bj', 'ins', tableId, 1), label: 'Take insurance', tone: 'primary' }),
        button({ id: cid('bj', 'ins', tableId, 0), label: 'No insurance' }),
      ),
    );
  } else {
    // Betting (with or without the previous hand's results).
    const result = state.lastResult;
    const lines: string[] = [];
    if (result && !result.voided) {
      lines.push(`### Hand ${result.roundNumber} · results`);
      const dealer = result.dealerBlackjack ? 'Dealer had **blackjack**' : result.dealerBust ? `Dealer **busted** with ${result.dealerTotal}` : `Dealer stood on **${result.dealerTotal}**`;
      lines.push(`-# ${dealer}`);
      for (const s of result.seats) {
        const verdict = s.net > 0 ? `▲ ${escapeMarkdown(s.displayName)} won **${chips(s.net)}**` : s.net < 0 ? `▼ ${escapeMarkdown(s.displayName)} lost ${chips(-s.net)}` : `■ ${escapeMarkdown(s.displayName)} broke even`;
        const detail = s.hands
          .map((h) => (h.outcome === 'blackjack' ? 'blackjack!' : h.outcome === 'bust' ? 'bust' : h.outcome === 'surrender' ? 'surrendered' : `${h.total}${h.doubled ? ' doubled' : ''}`))
          .join(' / ');
        lines.push(`${verdict} · ${detail}`);
      }
      // One line per player: "Alex unlocked First Hand and Split Decision · reached level 3".
      const extras = result.seats
        .map((s) => {
          const bits = [
            s.achievements.length ? `unlocked ${listOf(s.achievements.map((a) => `**${a}**`))}` : null,
            s.levelUp ? `reached **level ${s.levelUp}**` : null,
            s.missions.length ? `completed ${listOf(s.missions.map((m) => `**${m}**`))}` : null,
          ].filter(Boolean);
          return bits.length ? `${escapeMarkdown(s.displayName)} ${bits.join(' · ')}` : null;
        })
        .filter((line): line is string => line !== null);
      for (const line of extras.slice(0, 3)) lines.push(`-# ✦ ${line}`);
    }
    const betCount = Object.keys(state.bets).length;
    const placed = state.seats.filter((s) => state.bets[s.userId]).map((s) => `${escapeMarkdown(s.displayName)} **${chips(state.bets[s.userId]!)}**`);
    const deciding = state.seats.filter((s) => !state.bets[s.userId] && !s.sittingOut).map((s) => escapeMarkdown(s.displayName));
    const away = state.seats.filter((s) => !state.bets[s.userId] && s.sittingOut).map((s) => escapeMarkdown(s.displayName));
    const betLine = [
      placed.length ? `Bets in: ${placed.join(' · ')}` : '',
      placed.length && deciding.length ? `-# Still deciding: ${deciding.join(', ')}` : '',
      away.length ? `-# Sitting out: ${away.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const heading = result && !result.voided ? '**Next hand** · ' : '### Place your bets\n';
    const timing =
      betCount > 0 && state.deadline
        ? `dealing ${discordTime(state.deadline)}`
        : state.seats.length === 0
          ? 'take a seat to play'
          : 'press a chip to bet — the deal starts shortly after the first bet';
    lines.push(`${heading}${timing}${betLine ? `\n${betLine}` : ''}`);
    parts.push(text(lines.join('\n')));
    const presets = chipPresets(record.config.minBet, record.config.maxBet);
    rows.push(row(...presets.map((amount) => button({ id: cid('bj', 'bet', tableId, amount), label: chips(amount) }))));
    rows.push(
      row(
        button({ id: cid('bj', 'rebet', tableId), label: 'Rebet', tone: 'primary', emoji: ICONS.refresh }),
        button({ id: cid('bj', 'betx', tableId), label: 'Custom bet' }),
        button({ id: cid('bj', 'clear', tableId), label: 'Clear bet', disabled: betCount === 0 }),
        betCount > 0 ? button({ id: cid('bj', 'deal', tableId), label: 'Deal now (host)', tone: 'success' }) : null,
      ),
    );
  }

  // Right after a hand the results block already tells the story: only show what happened since.
  const showingResults = !revealing && state.phase === 'betting' && state.lastResult !== null && !state.lastResult.voided;
  const recent = showingResults ? state.log.filter((l) => l.at > state.lastResult!.settledAt) : state.log;
  const log = recent.slice(-4).map((l) => `-# ${TONE_GLYPH[l.tone]} ${escapeMarkdown(l.text)}`);
  const full = state.seats.length >= record.config.maxSeats;
  const accent = state.phase === 'playing' ? COLORS.gold : state.lastResult && !revealing && state.phase === 'betting' ? COLORS.deepEmerald : COLORS.emerald;
  return {
    files: [{ name: fileName, data: png, description: describeTableForAlt(view) }],
    components: [
      container(accent, [
        text(header),
        gallery([{ url: `attachment://${fileName}`, description: describeTableForAlt(view) }]),
        ...parts,
        log.length ? separator() : null,
        log.length ? text(log.join('\n')) : null,
        ...(revealing ? [] : rows),
      ]),
      row(
        button({ id: cid('bj', 'join', tableId), label: full ? 'Table full' : 'Take a seat', emoji: ICONS.tables, tone: 'success', disabled: full }),
        button({ id: cid('bj', 'seat', tableId), label: 'My seat' }),
        button({ id: cid('bj', 'leave', tableId), label: 'Leave' }),
        button({ id: cid('bj', 'rules', tableId), label: 'Rules', emoji: ICONS.help }),
        button({ id: cid('bj', 'home', tableId), label: 'Casino', emoji: ICONS.home }),
      ),
    ],
  };
}

/** "a", "a and b", "a, b and c". */
function listOf(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** Shown on the panel's message once a table is closed. */
export function closedTablePanel(name: string, reason: string): Screen {
  return {
    components: [
      container(COLORS.charcoal, [
        text(`## ♠ ${escapeMarkdown(name)} — closed\n-# ${escapeMarkdown(reason.charAt(0).toUpperCase() + reason.slice(1))}. Any open bets were refunded. Thanks for playing!`),
        row(button({ id: cid('bj', 'home', 'closed'), label: 'Open the casino', emoji: ICONS.home })),
      ]),
    ],
  };
}

// ───────────────────────────── personal seat panel ─────────────────────────────

export function mySeatScreen(app: CasinoApp, viewer: Viewer, tableId: string): Screen {
  const snap = app.blackjack.peek(tableId);
  if (!snap) {
    return { components: [container(COLORS.charcoal, [text('### This table has closed.'), row(button({ id: NAV.tables, label: 'Tables', emoji: ICONS.tables }))])] };
  }
  const { record, state } = snap;
  const seat = state.seats.find((s) => s.userId === viewer.userId);
  const wallet = app.economy.getWallet(viewer.guildId, viewer.userId);
  const isHost = record.ownerId === viewer.userId;
  if (!seat) {
    return {
      components: [
        container(COLORS.emerald, [
          text(`## ${escapeMarkdown(record.name)}\nYou're watching this table. ${tableSummary(snap)}.\n-# Balance ${chipsLine(wallet.balance)}`),
          row(
            button({ id: cid('bj', 'join', tableId), label: 'Take a seat', tone: 'success', disabled: state.seats.length >= record.config.maxSeats }),
            button({ id: cid('bj', 'rules', tableId), label: 'Rules', emoji: ICONS.help }),
          ),
        ]),
      ],
    };
  }
  const inRound = state.round?.seats.some((s) => s.userId === viewer.userId) ?? false;
  const status = seat.leaving
    ? 'Leaving after this hand'
    : seat.sittingOut
      ? 'Sitting out — bet to jump back in'
      : inRound
        ? 'Playing this hand'
        : state.bets[viewer.userId]
          ? `Bet placed: **${chips(state.bets[viewer.userId]!)}**`
          : 'Waiting for your bet';
  const components = [
    text(
      `## Your seat · ${escapeMarkdown(record.name)}\nSeat **${seat.seatIndex + 1}** · ${status}\nBalance ${chipsLine(wallet.balance)}${wallet.reserved ? ` · ${chips(wallet.reserved)} on the table` : ''}${seat.lastBet ? ` · last bet ${chips(seat.lastBet)}` : ''}`,
    ),
    row(
      seat.sittingOut
        ? button({ id: cid('bj', 'sit', tableId, 0), label: "I'm back", tone: 'success' })
        : button({ id: cid('bj', 'sit', tableId, 1), label: 'Sit out' }),
      button({ id: cid('bj', 'leave', tableId), label: inRound ? 'Leave after this hand' : 'Leave table', tone: 'danger' }),
      button({ id: cid('bj', 'rules', tableId), label: 'Rules', emoji: ICONS.help }),
    ),
  ];
  if (isHost) {
    components.push(
      text(
        `### Host tools${record.isPrivate ? `\nAccess code: **\`${record.accessCode}\`** — share it with friends you want to invite.` : ''}\n-# You can deal early, remove a player between hands, or close the table.`,
      ),
    );
    components.push(
      row(
        button({ id: cid('bj', 'close', tableId), label: 'Close table', tone: 'danger', disabled: state.phase !== 'betting' }),
      ),
    );
    if (state.seats.length > 1) components.push(userSelect(cid('bj', 'kick', tableId), 'Remove a player from the table…'));
  }
  return { components: [container(isHost ? COLORS.gold : COLORS.emerald, components)] };
}

function chipsLine(amount: number): string {
  return `**${chips(amount)}** chips`;
}

export function rulesScreen(app: CasinoApp, guildId: string, tableId?: string): Screen {
  const snap = tableId ? app.blackjack.peek(tableId) : undefined;
  const rules = snap ? tableRules(app, snap) : rulesFromSettings(app.settings.get(guildId).blackjack);
  const bj = app.settings.get(guildId).blackjack;
  return {
    components: [
      container(COLORS.emerald, [
        text(
          `## ♠ House rules\n${describeRules(rules)
            .map((l) => `▸ ${l}`)
            .join('\n')}`,
        ),
        text(
          `### How a hand works\n1. Bet with the chip buttons — the hand is dealt ${bj.bettingSeconds}s after the first bet, or 3s after everyone is in.\n2. On your turn the action buttons light up. You have **${bj.turnSeconds}s** per decision; then the hand stands.\n3. The dealer plays, everyone is paid, and betting reopens straight away.\n-# Payouts: win 1:1 · blackjack ${rules.blackjackPayout.numerator}:${rules.blackjackPayout.denominator} · push returns your bet · fractions of a chip round down.`,
        ),
        text(`-# Shuffles use a cryptographically secure random generator. Admins cannot see or change upcoming cards.`),
      ]),
    ],
  };
}

export { plural };
