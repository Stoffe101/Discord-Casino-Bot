import type { CasinoApp } from '../../app/casino-app.js';
import { COUNTDOWN_CUTOFF_MS, chips, countdown, escapeMarkdown, discordTime, plural } from '../../core/format.js';
import { eventsScreen } from './events.js';
import { pokerUrl } from './poker.js';
import { myTable, myTableLine, returnToTableButton, seatConflict } from './my-table.js';
import { cardLabel } from '../../games/cards.js';
import { currentTurnUserId, describeRules, describeTotal, handValue, type BlackjackRules } from '../../games/blackjack/engine.js';
import { isMultiplayerLayout, renderTableSvg } from '../../render/table-image.js';
import { rulesFromSettings } from '../../tables/blackjack-table-service.js';
import { buildTableView, describeTableForAlt } from '../../tables/table-view.js';
import type { LastRoundResult, LogEntry, RenderHint, ResultSeat, TableSnapshot } from '../../tables/types.js';
import { tableAnimation } from './table-animation.js';
import { myHandSvg, type MyHandImage } from '../../render/hand-image.js';
import { basicStrategy } from '../../games/blackjack/strategy.js';
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
import { NAV, channelUrl, navRow, returnToCasino, type Viewer } from './common.js';

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

export const TABLE_FILTERS = ['all', 'blackjack', 'poker', 'roulette', 'seats', 'public', 'active', 'events', 'mine'] as const;
export type TableFilter = typeof TABLE_FILTERS[number];
const TABLE_FILTER_LABELS: Record<TableFilter, string> = {
  all: 'All games', blackjack: 'Blackjack', poker: 'Hold’em', roulette: 'Roulette', seats: 'Available seats', public: 'Public tables', active: 'In play', events: 'Scheduled events', mine: 'My table',
};
const TABLES_PER_PAGE = 3;

export function tablesScreen(app: CasinoApp, viewer: Viewer, filter: TableFilter = 'all', page = 0): Screen {
  app.economy.ensurePlayer(viewer.guildId, viewer.userId, viewer.displayName);
  if (filter === 'events') return eventsScreen(app, viewer, page);
  const settings = app.settings.get(viewer.guildId);
  const blackjack = app.blackjack.openTables(viewer.guildId);
  const poker = app.poker.openTables(viewer.guildId);
  const wheel = app.roulette.wheelFor(viewer.guildId);
  const myBlackjack = app.blackjack.tableOfUser(viewer.guildId, viewer.userId);
  const myPoker = app.poker.tableOfUser(viewer.guildId, viewer.userId);
  const mine = myBlackjack?.record.id ?? myPoker?.record.id;
  const mineUrl = myBlackjack ? tableLocation(myBlackjack) : myPoker ? pokerUrl(myPoker.record) : null;
  const entries = [
    ...blackjack.map((table) => ({
      kind: 'blackjack', game: 'Blackjack', record: table.record, url: tableLocation(table),
      canJoin: settings.enabled && settings.blackjack.enabled && table.state.seats.length < table.record.config.maxSeats,
      description: tableSummary(table), players: table.state.seats.map((seat) => seat.displayName),
      active: table.state.phase !== 'betting', join: cid('tbl', 'join', table.record.id),
    })),
    ...poker.map((table) => ({
      kind: 'poker', game: 'Hold’em', record: table.record, url: pokerUrl(table.record),
      canJoin: settings.enabled && settings.poker.enabled && table.state.seats.length < table.record.config.maxSeats,
      description: `${table.state.seats.length}/${table.record.config.maxSeats} seated · ${table.state.hand ? 'hand in play' : 'between hands'} · blinds ${chips(table.record.config.smallBlind)}/${chips(table.record.config.bigBlind)}`,
      players: table.state.seats.map((seat) => seat.name), active: !!table.state.hand, join: cid('pk', 'join', table.record.id),
    })),
    ...(wheel ? [{
      kind: 'roulette', game: 'Roulette', record: { id: wheel.record.id, name: 'Shared wheel', isPrivate: false },
      url: wheel.record.threadId ? channelUrl(viewer.guildId, wheel.record.threadId)
        : wheel.record.channelId && wheel.record.messageId ? channelUrl(viewer.guildId, wheel.record.channelId, wheel.record.messageId) : null,
      canJoin: false, description: `${new Set(wheel.state.bets.map((bet) => bet.userId)).size} bettors · ${wheel.state.bets.length ? 'taking bets' : 'waiting for bets'} · ${chips(settings.roulette.minBet)}–${chips(settings.roulette.maxBet)} per spot`,
      players: [], active: wheel.state.bets.length > 0, join: cid('rl', 'open'),
    }] : []),
  ];
  const focusedGame = filter === 'blackjack' || filter === 'poker' ? filter : null;
  const myView = filter === 'mine';
  const allowed = TABLE_FILTERS.filter((kind) => kind !== 'mine' && (kind !== 'poker' || settings.poker.enabled || poker.length > 0));
  const filtered = entries.filter((entry) => filter === 'all' || filter === entry.kind || (filter === 'seats' && entry.canJoin)
    || (filter === 'active' && entry.active) || (filter === 'public' && !entry.record.isPrivate) || (myView && entry.record.id === mine));
  const pages = Math.max(1, Math.ceil(filtered.length / TABLES_PER_PAGE));
  const current = Math.min(pages - 1, Math.max(0, page));
  const sections = filtered.slice(current * TABLES_PER_PAGE, (current + 1) * TABLES_PER_PAGE).flatMap((entry) => {
    const seated = mine === entry.record.id;
    const wheelEntry = entry.kind === 'roulette';
    const players = entry.players.length ? `\n-# ${entry.players.map(escapeMarkdown).join(', ')}` : '';
    const action = seated && entry.url ? linkButton('Your table', entry.url, ICONS.tables)
      : wheelEntry && entry.url ? linkButton('Go to wheel', entry.url, ICONS.roulette)
      : button({ id: entry.join, label: wheelEntry ? 'Open wheel' : entry.record.isPrivate ? 'Join with code' : entry.canJoin ? 'Join' : 'Unavailable',
        tone: 'success', emoji: ICONS.tables, disabled: !wheelEntry && (!entry.canJoin || !!mine && !seated) });
    return [
      section([`**${escapeMarkdown(entry.record.name)}** · ${entry.game} · ${entry.record.isPrivate ? 'Private' : 'Public'}\n${entry.description}${players}`], action),
      !wheelEntry && entry.url && !entry.record.isPrivate && !seated ? row(linkButton('Spectate', entry.url, ICONS.spectate)) : null,
    ];
  });
  const me = myTable(app, viewer);
  // My table: one card with the way back (and out, when nothing is in play).
  if (myView) {
    return {
      components: [
        container(me?.urgent ? COLORS.gold : COLORS.emerald, [
          navRow('games'),
          me ? text(`## My table\n${myTableLine(me)}`) : text('## My table\n-# You are not seated at a Blackjack or Hold’em table right now.'),
          me
            ? row(
                returnToTableButton(me),
                me.canLeaveNow ? button({ id: me.game === 'blackjack' ? cid('bj', 'leave', me.id) : cid('pk', 'leave', me.id), label: 'Leave table', emoji: ICONS.leave, tone: 'danger' }) : null,
                button({ id: NAV.floor, label: 'Games', emoji: ICONS.games }),
              )
            : row(
                button({ id: NAV.floor, label: 'Games', emoji: ICONS.games, tone: 'success' }),
                button({ id: cid('nav', 'tables', 'blackjack'), label: 'Blackjack tables', emoji: ICONS.blackjack }),
                settings.poker.enabled ? button({ id: cid('nav', 'tables', 'poker'), label: 'Hold’em tables', emoji: ICONS.poker }) : null,
              ),
        ]),
      ],
    };
  }
  const gameLabel = focusedGame ? TABLE_FILTER_LABELS[focusedGame] : 'Casino';
  const stakes = focusedGame === 'blackjack'
    ? `Bets ${chips(settings.blackjack.minBet)}–${chips(settings.blackjack.maxBet)} · up to ${settings.blackjack.maxSeats} seats · you play the dealer, not each other`
    : focusedGame === 'poker'
      ? `Blinds ${chips(settings.poker.smallBlind)}/${chips(settings.poker.bigBlind)} · buy-in ${chips(settings.poker.minBuyIn)}–${chips(settings.poker.maxBuyIn)} · no rake`
      : 'Every open table and the shared wheel.';
  const count = filtered.length
    ? `**${plural(filtered.length, 'table')} open**`
    : focusedGame ? `**No ${gameLabel} tables yet** — open the first one and friends can join from here.` : 'No tables match this filter.';
  const enabled = focusedGame === 'blackjack' ? settings.enabled && settings.blackjack.enabled : focusedGame === 'poker' ? settings.enabled && settings.poker.enabled : false;
  const otherGame = !!me && !!focusedGame && me.game !== focusedGame;
  const sameGame = !!me && !!focusedGame && me.game === focusedGame;
  return {
    components: [
      container(COLORS.emerald, [
        navRow('games'),
        text(`## ${focusedGame === 'blackjack' ? ICONS.blackjack : focusedGame === 'poker' ? ICONS.poker : ICONS.tables} ${focusedGame ? `${gameLabel} tables` : 'All tables'}\n-# ${stakes}\n${count}`),
        !focusedGame
          ? select({ id: cid('tbl', 'filter'), placeholder: 'Filter tables', options: allowed.map((value) => option(TABLE_FILTER_LABELS[value], value, undefined, undefined, value === filter)) })
          : null,
        // Seated in the other game: say why this game is unavailable and how to get back or out.
        ...(otherGame && me ? seatConflict(me, `a ${gameLabel} table`) : []),
        sameGame && me ? text(`### Your table\n${myTableLine(me)}`) : null,
        focusedGame && !otherGame
          ? row(
              sameGame && me ? returnToTableButton(me)
                : button({ id: focusedGame === 'blackjack' ? cid('tbl', 'create') : cid('pk', 'create'), label: `Open a ${gameLabel} table`, emoji: focusedGame === 'blackjack' ? ICONS.blackjack : ICONS.poker, tone: 'success', disabled: !enabled }),
              button({ id: cid('nav', 'rules', focusedGame), label: 'Rules', emoji: ICONS.rules }),
              button({ id: NAV.floor, label: 'Games', emoji: ICONS.back }),
            )
          : null,
        !focusedGame ? row(
          button({ id: cid('nav', 'tables', 'blackjack'), label: 'Blackjack tables', emoji: ICONS.blackjack }),
          settings.poker.enabled ? button({ id: cid('nav', 'tables', 'poker'), label: 'Hold’em tables', emoji: ICONS.poker }) : null,
          mineUrl ? linkButton('Return to your table', mineUrl, ICONS.tables) : null,
        ) : null,
      ]),
      sections.length ? container(COLORS.deepEmerald, sections) : null,
      pages > 1 ? row(
        button({ id: cid('nav', 'tables', filter, current - 1), label: 'Previous', emoji: ICONS.prev, disabled: current === 0 }),
        button({ id: cid('nav', 'tables', filter, current), label: 'Refresh ' + (current + 1) + '/' + pages, emoji: ICONS.refresh }),
        button({ id: cid('nav', 'tables', filter, current + 1), label: 'Next', emoji: ICONS.next, disabled: current + 1 === pages }),
      ) : row(button({ id: cid('nav', 'tables', filter, current), label: 'Refresh', emoji: ICONS.refresh })),
    ].filter((component) => component !== null),
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
      placeholder: 'e.g. 250, 2k, half or all',
    }),
  ]);
}

// ───────────────────────────── table panel ─────────────────────────────

const TONE_GLYPH: Record<LogEntry['tone'], string> = { info: '·', good: '▲', bad: '▼', gold: '✦' };

/**
 * The shared, persistent panel in each table's thread. Everyone sees it; buttons act for
 * whoever presses them, and turn controls only work for the active player (checked server-side).
 */
/** "Alex 8♠ 3♣ **11** · 8♥ 9♥ **17**": every player's hands in one line, for the table summary. */
function seatSummary(state: TableSnapshot['state'], round: NonNullable<TableSnapshot['state']['round']>, activeUserId: string | null): string[] {
  return round.seats.map((rs) => {
    const name = escapeMarkdown(state.seats.find((s) => s.userId === rs.userId)?.displayName ?? 'Player');
    const hands = rs.hands
      .map((h) => {
        const { total } = handValue(h.cards);
        const tag = h.surrendered ? ' · surrendered' : total > 21 ? ' · bust' : h.doubled ? ' · doubled' : '';
        return `${h.cards.map(cardLabel).join('  ')} → **${describeTotal(h.cards, h.fromSplit)}**${tag}`;
      })
      .join('  ·  ');
    return `${rs.userId === activeUserId ? '▸ ' : ''}**${name}** · ${hands}`;
  });
}

export async function blackjackPanel(
  app: CasinoApp,
  snapshot: Readonly<TableSnapshot>,
  options: { revealStep?: number; dealStep?: number; animation?: RenderHint } = {},
): Promise<Screen> {
  const { record, state } = snapshot;
  const rules = tableRules(app, snapshot);
  const view = buildTableView(snapshot, rules, options);
  const multiplayer = isMultiplayerLayout(view);
  // An animated frame carries a GIF (cards in motion); every other frame is a sharp static PNG.
  const anim = options.animation ? await tableAnimation(app, snapshot, options.animation) : null;
  const image = anim ? anim.file : await (async () => {
    const { key, png } = await app.images.render(renderTableSvg(view), 800);
    return { name: `table-${key}.png`, data: png };
  })();
  const fileName = image.name;
  // Alt text never runs ahead of an animation (screen readers would hear the result first).
  const alt = anim?.mode === 'deal' ? 'Cards are being dealt' : anim?.mode === 'reveal' ? 'The dealer is playing' : describeTableForAlt(view);
  const host = state.seats.find((s) => s.userId === record.ownerId)?.displayName;
  const header =
    `## ♠ ${escapeMarkdown(record.name)}${record.isPrivate ? ' 🔒' : ''}\n` +
    `-# Blackjack · ${state.seats.length}/${record.config.maxSeats} seated · bets ${chips(record.config.minBet)}–${chips(record.config.maxBet)}${host ? ` · host ${escapeMarkdown(host)}` : ''}`;
  const tableId = record.id;
  const parts: ReturnType<typeof text>[] = [];
  const rows: ReturnType<typeof row>[] = [];
  let handList: ReturnType<typeof text> | null = null;
  // A deal that leads into play carries the live text and controls with its GIF: players can act
  // the moment the cards are in, instead of waiting for the animation and then the still. A deal
  // that ends the hand at once (a dealer blackjack) keeps the outcome out of the text until it lands.
  const dealing = options.dealStep !== undefined || (anim?.mode === 'deal' && !state.round);
  const revealing = options.revealStep !== undefined || anim?.mode === 'reveal';
  // Animation frames show no controls and no activity log (the log already knows the outcome).
  const animating = dealing || revealing;

  if (dealing) {
    const players = view.seats.filter((s) => s.hands.length).map((s) => escapeMarkdown(s.name));
    parts.push(text(`### 🃏 Dealing hand ${view.roundNumber}\n-# Cards are going out to ${players.join(', ') || 'the table'}…`));
  } else if (revealing && state.lastResult && options.revealStep === undefined) {
    // The animated reveal: the outcome stays out of the text until the cards have landed.
    parts.push(text(`### Dealer's turn\nThe dealer turns over the hole card…`));
  } else if (revealing && state.lastResult) {
    const shown = state.lastResult.dealerCards.slice(0, 2 + options.revealStep!);
    const step = options.revealStep!;
    const line = step === 0 ? 'The dealer turns over the hole card…' : `The dealer draws ${cardLabel(shown.at(-1)!)}…`;
    parts.push(text(`### Dealer's turn\n${line}\nDealer: ${shown.map(cardLabel).join(' ')} — **${describeTotal(shown)}**`));
  } else if (state.phase === 'playing' && state.round) {
    const round = state.round;
    const turn = round.turn!;
    const seat = round.seats[turn.seat]!;
    const hand = seat.hands[turn.hand]!;
    const who = state.seats.find((s) => s.userId === seat.userId)?.displayName ?? 'Player';
    const opts = app.blackjack.playerOptions(tableId, seat.userId);
    const handOf = seat.hands.length > 1 ? ` · hand ${turn.hand + 1} of ${seat.hands.length}` : '';
    const up = round.dealer[0]!;
    parts.push(
      text(
        `### ▸ ${escapeMarkdown(who)} to act${handOf}\n` +
          `## ${hand.cards.map(cardLabel).join(' ')}  →  ${describeTotal(hand.cards, hand.fromSplit)}\n` +
          `-# Bet ${chips(hand.bet)} · dealer shows ${cardLabel(up)} · ${state.deadline && state.deadline - app.clock.now() > COUNTDOWN_CUTOFF_MS ? `decide ${discordTime(state.deadline)}, then the hand stands automatically` : 'time is nearly up — the hand stands automatically'}`,
      ),
    );
    if (round.seats.length > 1) handList = text('### Player hands\n' + seatSummary(state, round, seat.userId).join('\n'));
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
        `### The dealer shows an ace — insurance?\nInsurance costs half your bet and pays **2:1** if the dealer has blackjack.\n-# Waiting for ${pending.join(', ') || 'nobody'} · closes ${countdown(state.deadline ?? app.clock.now(), app.clock.now(), 'now')}`,
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
      lines.push(`-# ${dealerVerdict(result)}`);
      for (const s of result.seats) {
        const verdict = s.net > 0 ? `▲ ${escapeMarkdown(s.displayName)} won **${chips(s.net)}**` : s.net < 0 ? `▼ ${escapeMarkdown(s.displayName)} lost ${chips(-s.net)}` : `■ ${escapeMarkdown(s.displayName)} broke even`;
        const detail = s.hands
          .map((h) => {
            const outcome = h.outcome === 'blackjack' ? 'Blackjack' : h.outcome === 'bust' ? 'Bust' : h.outcome === 'surrender' ? 'Surrendered' : String(h.total);
            return multiplayer ? h.cards.map(cardLabel).join('  ') + ' → **' + outcome + '**' : outcome + (h.doubled ? ' doubled' : '');
          })
          .join(' / ');
        lines.push(`${verdict} · ${detail}${s.timedOut ? ' · ran out of time' : ''}`);
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
    const dealDue = state.deadline !== null && state.deadline <= app.clock.now();
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
        ? 'dealing ' + countdown(state.deadline, app.clock.now(), dealDue ? 'now…' : 'shortly…')
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
        // Only while someone is still deciding: once everyone is in, the deal is moments away anyway
        // (and a manual deal would only race it).
        betCount > 0 && deciding.length > 0 ? button({ id: cid('bj', 'deal', tableId, state.roundId), label: dealDue ? 'Dealing…' : 'Deal now (host)', tone: 'success', disabled: dealDue }) : null,
      ),
    );
  }

  // Right after a hand the results block already tells the story: only show what happened since.
  const showingResults = !animating && state.phase === 'betting' && state.lastResult !== null && !state.lastResult.voided;
  const recent = animating ? [] : showingResults ? state.log.filter((l) => l.at > state.lastResult!.settledAt) : state.log;
  // While a hand is in play the table summary shows the state; keep only the latest moves.
  const log = recent.slice(state.phase === 'playing' ? -2 : -4).map((l) => `-# ${TONE_GLYPH[l.tone]} ${escapeMarkdown(l.text)}`);
  const art = gallery([{ url: 'attachment://' + fileName, description: alt }]);
  const controls = animating ? [] : rows;
  const full = state.seats.length >= record.config.maxSeats;
  const accent = state.phase === 'playing' && !dealing ? COLORS.gold : state.lastResult && !animating && state.phase === 'betting' ? COLORS.deepEmerald : COLORS.emerald;
  return {
    files: [{ name: fileName, data: image.data, description: alt }],
    ...(anim ? { holdMs: anim.holdMs } : {}),
    components: [
      container(accent, [
        text(header),
        multiplayer ? null : art,
        ...parts,
        ...(multiplayer ? controls : []),
        multiplayer ? art : null,
        handList,
        log.length ? separator() : null,
        log.length ? text(log.join('\n')) : null,
        ...(multiplayer ? [] : controls),
      ]),
      container(COLORS.deepEmerald, [row(
        button({ id: cid('bj', 'join', tableId), label: full ? 'Table full' : 'Take a seat', emoji: ICONS.tables, tone: 'success', disabled: full }),
        button({ id: cid('bj', 'seat', tableId), label: state.phase === 'betting' ? 'My seat' : 'My hand', emoji: ICONS.hand }),
        button({ id: cid('bj', 'leave', tableId), label: 'Leave', emoji: ICONS.leave }),
        button({ id: cid('bj', 'rules', tableId), label: 'Rules', emoji: ICONS.help }),
        button({ id: cid('bj', 'home', tableId), label: 'Home', emoji: ICONS.home }),
      ),
      row(returnToCasino(app, record.guildId, record.channelId)),
      ]),
    ],
  };
}

/** "a", "a and b", "a, b and c". */
function listOf(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** Shown on the panel's message once a table is closed. */
export function closedTablePanel(app: CasinoApp, location: { guildId: string; channelId: string | null; name: string }, reason: string): Screen {
  return {
    components: [
      container(COLORS.charcoal, [
        text(`## ${escapeMarkdown(location.name)} · Closed\n-# ${escapeMarkdown(reason.charAt(0).toUpperCase() + reason.slice(1))}. Remaining chips were returned to Wallet.`),
        row(returnToCasino(app, location.guildId, location.channelId)),
      ]),
    ],
  };
}

// ───────────────────────────── personal seat panel ─────────────────────────────

/**
 * "My hand": the player's private view of their own hand during a round — a close-up image, their
 * total, whose turn it is, a basic-strategy tip and what each move would do — with private action
 * buttons (they work exactly like the table's). Seat controls follow underneath.
 */
function dealerVerdict(result: LastRoundResult): string {
  return result.dealerBlackjack ? 'Dealer had **blackjack**' : result.dealerBust ? `Dealer **busted** with ${result.dealerTotal}` : `Dealer stood on **${result.dealerTotal}**`;
}

/**
 * The private view. ``revealing``: the shared panel is still playing the dealer's turn, so the
 * private view must not run ahead of it (no result, no settled balance — "watch the table").
 */
export async function myHandScreen(app: CasinoApp, viewer: Viewer, tableId: string, options: { revealing?: boolean } = {}): Promise<Screen> {
  const seatScreen = mySeatScreen(app, viewer, tableId);
  const snap = app.blackjack.peek(tableId);
  const round = snap?.state.round;
  const mine = round?.seats.find((s) => s.userId === viewer.userId);
  if (snap && !round) {
    // Between hands: your last hand and how it went (once the table has shown it).
    const result = snap.state.lastResult;
    const myResult = result && !result.voided ? result.seats.find((s) => s.userId === viewer.userId) : undefined;
    if (result && myResult) return handResultScreen(app, snap, result, myResult, seatScreen, options.revealing === true);
  }
  if (!snap || !round || !mine) return seatScreen;
  const { record, state } = snap;
  const rules = tableRules(app, snap);
  const view = buildTableView(snap, rules);
  const seatView = view.seats.find((s) => s.userId === viewer.userId);
  const { key, png } = await app.images.render(
    myHandSvg({
      feltId: record.config.feltId,
      cardBackId: record.config.cardBackId,
      dealer: view.dealer.cards,
      dealerTotal: view.dealer.total,
      hands: (seatView?.hands ?? []).map((h) => ({ cards: h.cards, total: h.total, active: h.active, badge: h.badge })),
    }),
    760,
  );
  const file = `hand-${key}.png`;
  const up = round.dealer[0]!;
  const turnUser = state.phase === 'playing' ? currentTurnUserId(round) : null;
  const myTurn = turnUser === viewer.userId;
  const turnHand = myTurn ? round.turn!.hand : -1;
  const handLines = mine.hands.map((h, i) => {
    const marker = i === turnHand ? '▸ ' : '';
    const label = mine.hands.length > 1 ? `**Hand ${i + 1}** ` : '';
    const { total } = handValue(h.cards);
    const done = h.surrendered ? ' · surrendered' : total > 21 ? ' · bust' : h.done && i !== turnHand ? ' · done' : '';
    return `${marker}${label}${h.cards.map(cardLabel).join(' ')} → **${describeTotal(h.cards, h.fromSplit)}** · bet ${chips(h.bet)}${h.doubled ? ' (doubled)' : ''}${done}`;
  });
  const lines = [`## ${ICONS.blackjack} Your hand · ${escapeMarkdown(record.name)}`, ...handLines, `-# Dealer shows ${cardLabel(up)}`];
  const rows: ReturnType<typeof row>[] = [];
  if (state.phase === 'insurance' && mine.insurance.decision === 'pending') {
    lines.push(`### Insurance?\nIt costs **${chips(Math.floor(mine.hands[0]!.bet / 2))}** and pays 2:1 if the dealer has blackjack.\n-# Basic strategy: decline insurance.`);
    rows.push(row(button({ id: cid('bj', 'ins', tableId, 1), label: 'Take insurance', tone: 'primary' }), button({ id: cid('bj', 'ins', tableId, 0), label: 'No insurance' })));
  } else if (myTurn) {
    const hand = mine.hands[turnHand]!;
    const opts = app.blackjack.playerOptions(tableId, viewer.userId);
    const legal = { double: !!opts?.double && !!opts.canAffordDouble, split: !!opts?.split && !!opts.canAffordSplit, surrender: !!opts?.surrender };
    const tip = basicStrategy(hand.cards, up, legal, rules.dealerHitsSoft17);
    const total = describeTotal(hand.cards, hand.fromSplit);
    const explain = [
      opts?.hit ? '**Hit** — take another card' : null,
      opts?.stand ? `**Stand** — keep ${total}` : null,
      legal.double ? `**Double** — add ${chips(hand.bet)}, take exactly one more card` : null,
      legal.split ? `**Split** — two hands, another ${chips(hand.bet)} on the second` : null,
      legal.surrender ? `**Surrender** — give up and get ${chips(Math.floor(hand.bet / 2))} back` : null,
    ].filter(Boolean);
    lines.push(`### ▸ Your turn · decide ${discordTime(state.deadline ?? app.clock.now())}`, `💡 Basic strategy says **${tip.move[0]!.toUpperCase()}${tip.move.slice(1)}** — ${tip.why}.`, `-# ${explain.join(' · ')}`);
    const id = (action: string) => cid('bj', 'act', tableId, action, round.seq);
    rows.push(
      row(
        button({ id: id('hit'), label: 'Hit', tone: 'success', disabled: !opts?.hit }),
        button({ id: id('stand'), label: 'Stand', tone: 'danger', disabled: !opts?.stand }),
        button({ id: id('double'), label: 'Double', tone: 'primary', disabled: !legal.double }),
        button({ id: id('split'), label: 'Split', tone: 'primary', disabled: !legal.split }),
        rules.surrender ? button({ id: id('surrender'), label: 'Surrender', disabled: !legal.surrender }) : null,
      ),
    );
  } else {
    const waitingFor = turnUser ? escapeMarkdown(state.seats.find((s) => s.userId === turnUser)?.displayName ?? 'another player') : null;
    const finished = mine.hands.every((h) => h.done || h.surrendered);
    lines.push(waitingFor ? `-# ${finished ? 'Your hand is done' : 'Not your turn yet'} — waiting for **${waitingFor}**.` : '-# Waiting for the table.');
  }
  rows.push(row(button({ id: cid('bj', 'seat', tableId), label: 'Refresh', emoji: ICONS.refresh })));
  return {
    files: [{ name: file, data: png, description: `Your hand: ${handLines.join('; ').replace(/\*\*/g, '')}` }],
    components: [
      container(myTurn ? COLORS.gold : COLORS.emerald, [text(lines.slice(0, 1).concat(lines.slice(1, 1 + handLines.length + 1)).join('\n')), gallery([{ url: `attachment://${file}`, description: 'Your hand' }]), text(lines.slice(2 + handLines.length).join('\n') || '-# '), ...rows]),
      ...seatScreen.components,
    ],
  };
}

async function handResultScreen(
  app: CasinoApp,
  snap: Readonly<TableSnapshot>,
  result: LastRoundResult,
  mine: ResultSeat,
  seatScreen: Screen,
  revealing: boolean,
): Promise<Screen> {
  const { record } = snap;
  const handLines = mine.hands.map((h, i) => {
    const label = mine.hands.length > 1 ? `**Hand ${i + 1}** ` : '';
    return `${label}${h.cards.map(cardLabel).join(' ')} → **${describeTotal(h.cards, h.fromSplit)}** · bet ${chips(h.bet)}${h.doubled ? ' (doubled)' : ''}`;
  });
  const base = { feltId: record.config.feltId, cardBackId: record.config.cardBackId };
  let image: MyHandImage;
  let lines: string[];
  let color: number;
  if (revealing) {
    const up = result.dealerCards[0]!;
    image = { ...base, dealer: [up, null], dealerTotal: describeTotal([up]), hands: mine.hands.map((h) => ({ cards: h.cards, total: describeTotal(h.cards, h.fromSplit), active: false, badge: null })) };
    lines = [`## ${ICONS.blackjack} Your hand · ${escapeMarkdown(record.name)}`, ...handLines, `### Dealer's turn`, '-# Watch the table — the result shows there first. Refresh here afterwards.'];
    color = COLORS.emerald;
  } else {
    const view = buildTableView(snap, tableRules(app, snap));
    const seatView = view.seats.find((s) => s.userId === mine.userId);
    image = { ...base, dealer: view.dealer.cards, dealerTotal: view.dealer.total, hands: (seatView?.hands ?? []).map((h) => ({ cards: h.cards, total: h.total, active: false, badge: h.badge })) };
    const verdict = mine.net > 0 ? `You won **${chips(mine.net)}**` : mine.net < 0 ? `You lost ${chips(-mine.net)}` : 'You broke even';
    lines = [`## ${ICONS.blackjack} Hand ${result.roundNumber} · ${verdict}`, ...handLines, `-# ${dealerVerdict(result)}`];
    color = mine.net > 0 ? COLORS.gold : COLORS.emerald;
  }
  const { key, png } = await app.images.render(myHandSvg(image), 760);
  const file = `hand-${key}.png`;
  const head = lines.slice(0, 1 + handLines.length).join('\n');
  const tail = lines.slice(1 + handLines.length).join('\n');
  return {
    files: [{ name: file, data: png, description: revealing ? "Your hand; the dealer's turn is being played" : `Your last hand: ${handLines.join('; ').replace(/\*\*/g, '')}` }],
    components: [
      container(color, [text(head), gallery([{ url: `attachment://${file}`, description: 'Your hand' }]), text(tail), ...(revealing ? [row(button({ id: cid('bj', 'seat', record.id), label: 'Refresh', emoji: ICONS.refresh }))] : [])]),
      // The seat menu shows your balance: only once the result is out.
      ...(revealing ? [] : seatScreen.components),
    ],
  };
}

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
        navRow('games'),
        text(
          `## ${ICONS.blackjack} Blackjack house rules\n${describeRules(rules)
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
