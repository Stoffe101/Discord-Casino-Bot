import type { CasinoApp } from '../../app/casino-app.js';
import { chips, discordTime, escapeMarkdown } from '../../core/format.js';
import { cardLabel } from '../../games/cards.js';
import { privatePokerHand, publicPokerHand } from '../../games/poker/engine.js';
import type { PokerSnapshot, PokerRenderHint } from '../../games/poker/poker-service.js';
import { framesToGif } from '../../render/gif.js';
import { pokerTableSvg } from '../../render/poker-image.js';
import { cid } from '../custom-id.js';
import { button, container, gallery, linkButton, modal, option, row, selectLabel, text, textInputLabel, type Screen } from '../kit.js';
import { COLORS, ICONS } from '../theme.js';
import { channelUrl, NAV, navRow, returnToCasino, type Viewer } from './common.js';

const STREETS = { preflop: 'Pre-flop', flop: 'Flop', turn: 'Turn', river: 'River', complete: 'Results' } as const;

/** Poker wording for the last move: "raises to 20" (the total), not the chips just added. */
function describeAction(action: { type: string; amount: number }, streetPaid: number): string {
  if (action.type === 'fold') return 'folds';
  if (action.type === 'check') return 'checks';
  if (action.type === 'call') return `calls ${chips(action.amount)}`;
  if (action.type === 'all-in') return `is all-in${streetPaid ? ` (${chips(streetPaid)})` : ''}`;
  return streetPaid >= action.amount ? `raises to ${chips(streetPaid)}` : `raises ${chips(action.amount)}`;
}

export function pokerUrl(record: PokerSnapshot['record']): string | null {
  return record.threadId ? channelUrl(record.guildId, record.threadId)
    : record.channelId && record.messageId ? channelUrl(record.guildId, record.channelId, record.messageId) : null;
}

export function openPokerModal(app: CasinoApp, guildId: string) {
  const config = app.settings.get(guildId).poker;
  return modal(cid('m', 'pkcreate'), 'Open a Hold’em table', [
    textInputLabel({ id: 'name', label: 'Table name', required: false, max: 32 }),
    selectLabel({ id: 'visibility', label: 'Who can join?', options: [option('Public', 'public', undefined, undefined, true), option('Private · access code', 'private')] }),
    textInputLabel({ id: 'seats', label: 'Seats', value: String(config.maxSeats), max: 1 }),
    textInputLabel({ id: 'buyin', label: 'Your buy-in', description: `${chips(config.minBuyIn)}–${chips(config.maxBuyIn)} chips`, value: String(config.minBuyIn), max: 8 }),
  ]);
}

export function joinPokerModal(table: PokerSnapshot) {
  const { record } = table;
  return modal(cid('m', 'pkjoin', record.id), 'Take a Hold’em seat', [
    textInputLabel({ id: 'buyin', label: 'Buy-in', description: `${chips(record.config.minBuyIn)}–${chips(record.config.maxBuyIn)} chips`, value: String(record.config.minBuyIn), max: 8 }),
    ...(record.isPrivate ? [textInputLabel({ id: 'code', label: 'Table access code', max: 10 })] : []),
  ]);
}

export function pokerRulesScreen(): Screen {
  return { components: [container(COLORS.deepEmerald, [
    navRow('games'),
    text('## No-Limit Texas Hold’em\nBuy in with fictional chips to take a seat. Only you can see your hole cards in **My hand**. Make the best five-card hand using any combination of your two cards and the five community cards.'),
    text('**Betting** · Match the current bet to call, raise by at least the last full bet or raise, or go all-in. Folded chips stay in the pot. Tied hands share their pot.\n**Table stack** · Your chips stay reserved while seated. Leaving returns your remaining stack after any active hand. There is no rake.'),
  ])] };
}

export async function pokerPanel(app: CasinoApp, table: PokerSnapshot, animation?: PokerRenderHint): Promise<Screen> {
  const { record, state } = table;
  const view = state.hand ? publicPokerHand(state.hand) : state.result;
  const names = Object.fromEntries((view?.seats ?? []).map((seat) => [
    seat.userId, state.seats.find((player) => player.userId === seat.userId)?.name ?? app.economy.getPlayer(record.guildId, seat.userId)?.display_name ?? 'Player',
  ]));
  const pot = view?.seats.reduce((sum, seat) => sum + seat.committed, 0) ?? 0;
  const active = state.hand?.seats.find((seat) => seat.seat === view?.actor);
  const action = view?.lastAction;
  const actingName = action ? view?.seats.find((seat) => seat.seat === action.seat)?.userId : undefined;
  const payout = view?.result?.payouts.map(({ seat, amount }) => {
    const player = view.seats.find((entry) => entry.seat === seat)!;
    return `${escapeMarkdown(names[player.userId]!)} +${chips(amount)}`;
  });
  const status = !view ? '### Waiting for players\nTwo funded players can start a hand.'
    : state.hand
      ? `### ${STREETS[view.street]} · Pot ${chips(pot)}${view.board.length ? `\n**Board** · ${view.board.map(cardLabel).join('  ')}` : ''}\n${active ? `**${escapeMarkdown(names[active.userId]!)} to act** · ${discordTime(state.deadline!)}` : ''}`
        + (action && actingName ? `\n-# ${escapeMarkdown(names[actingName]!)} ${describeAction(action, view?.seats.find((seat) => seat.seat === action.seat)?.streetPaid ?? 0)}` : '')
      : `### Results · Pot ${chips(pot)}\n${payout?.join(' · ') || 'Hand complete'}${view.result && view.result.pots.length > 1 ? `\n-# Pots ${view.result.pots.map((entry) => chips(entry.amount)).join(' · ')}` : ''}`;
  const roster = [...state.seats].sort((a, b) => a.seat - b.seat).map((seat) => {
    const handSeat = view?.seats.find((entry) => entry.userId === seat.userId);
    const stack = state.hand ? handSeat?.stack ?? seat.stack : seat.stack;
    const flags = seat.leaving ? ' · leaving after this hand' : handSeat?.folded && state.hand ? ' · folded'
      : state.hand && handSeat && stack === 0 ? ' · all-in' : seat.sittingOut ? ' · sitting out' : state.hand && !handSeat ? ' · next hand' : '';
    return `**${escapeMarkdown(seat.name)}** ${chips(stack)}${flags}`;
  });
  let file: Screen['files'] | undefined;
  let holdMs: number | undefined;
  if (view) {
    const svg = pokerTableSvg(view, names);
    try {
      if (animation && animation !== 'update') {
        const first = pokerTableSvg(view, names, animation === 'dealt' ? { dealtSeats: 0 }
          : animation === 'board' ? { shownBoard: view.board.length <= 3 ? 0 : view.board.length - 1 }
          : { maskShowdown: true });
        const middle = animation === 'dealt' ? pokerTableSvg(view, names, { dealtSeats: Math.ceil(view.seats.length / 2) }) : null;
        const frames = [{ svg: first, delayMs: 240 }, ...(middle ? [{ svg: middle, delayMs: 260 }] : []), { svg, delayMs: 650 }];
        const { gif } = await framesToGif(frames, 640);
        file = [{ name: `poker-${record.version}.gif`, data: gif, description: 'Hold’em table animation' }];
        holdMs = 850;
      }
      if (!file) {
        const { png, key } = await app.images.render(svg, 790);
        file = [{ name: `poker-${key}.png`, data: png, description: 'Hold’em community cards and stacks. Seat status appears below.' }];
      }
    } catch {
      // All gameplay information and controls remain available when rendering fails.
    }
  }
  return {
    files: file, holdMs,
    components: [
      container(COLORS.emerald, [
        text(`## ${escapeMarkdown(record.name)}\n-# Hold’em · ${record.isPrivate ? 'Private' : 'Public'} · ${state.seats.length}/${record.config.maxSeats} seats · blinds ${chips(record.config.smallBlind)}/${chips(record.config.bigBlind)}`),
        file?.[0] ? gallery([{ url: `attachment://${file[0].name}`, description: file[0].description }]) : null,
        text(status),
        roster.length ? text(`-# ${roster.join('  ·  ')}`) : null,
        row(
          button({ id: cid('pk', 'join', record.id), label: 'Take a seat', tone: 'success', emoji: ICONS.tables, disabled: state.seats.length >= record.config.maxSeats }),
          button({ id: cid('pk', 'hand', record.id), label: 'My hand', emoji: ICONS.hand }),
          button({ id: cid('pk', 'start', record.id, record.version), label: 'Deal (host)', tone: 'primary', disabled: !!state.hand || state.seats.filter((seat) => seat.stack > 0 && !seat.sittingOut).length < 2 }),
        ),
        row(
          button({ id: cid('nav', 'pkrules'), label: 'Rules', emoji: ICONS.help }),
          returnToCasino(app, record.guildId, record.channelId),
        ),
      ]),
    ],
  };
}

export function playerPokerScreen(table: PokerSnapshot, viewer: Viewer): Screen {
  const { record, state } = table;
  const player = state.seats.find((seat) => seat.userId === viewer.userId);
  const privateView = state.hand ? privatePokerHand(state.hand, viewer.userId) : null;
  const legal = privateView?.legal;
  const actionId = (action: string, raiseTo?: number) => cid('pk', action, record.id, state.handId ?? '', state.hand?.seq ?? 0, raiseTo);
  const pot = state.hand?.seats.reduce((sum, seat) => sum + seat.committed, 0) ?? 0;
  const active = state.hand?.seats.find((seat) => seat.userId === viewer.userId);
  const raiseText = state.hand?.currentBet === 0 ? 'Bet' : 'Raise to';
  const actions = legal && !player?.leaving ? row(
    button({ id: actionId('fold'), label: 'Fold', tone: 'danger' }),
    legal.check ? button({ id: actionId('check'), label: 'Check', tone: 'success' })
      : legal.call !== null ? button({ id: actionId('call'), label: `Call ${chips(legal.call)}`, tone: 'success' }) : null,
    legal.minTo !== null ? button({ id: actionId('raise', legal.minTo), label: `${raiseText} ${chips(legal.minTo)}`, tone: 'primary' }) : null,
    legal.minTo !== null && legal.minTo < legal.maxTo ? button({ id: actionId('custom'), label: 'Custom' }) : null,
    legal.allIn ? button({ id: actionId('allin'), label: `All-in ${chips(active?.stack ?? 0)}` }) : null,
  ) : null;
  const url = pokerUrl(record);
  const parts = [
    `## ${escapeMarkdown(record.name)} · My hand`,
    player ? `**Your stack** · ${chips(active?.stack ?? player.stack)} chips` : 'Take a seat to receive a hand.',
    privateView ? `### ${privateView.cards.map(cardLabel).join('  ')}` : null,
    state.hand?.board.length ? `**Board** · ${state.hand.board.map(cardLabel).join('  ')}` : null,
    state.hand ? `-# ${STREETS[state.hand.street]} · Pot ${chips(pot)}` : null,
    player?.leaving ? 'Your remaining stack returns to Wallet after this hand.' : legal ? '**Your turn.**' : player && state.hand ? 'Waiting for play. Refresh to see the current action.' : null,
  ].filter(Boolean);
  return { components: [container(COLORS.gold, [
    text(parts.join('\n')),
    actions,
    row(
      button({ id: cid('pk', 'hand', record.id), label: 'Refresh', emoji: ICONS.refresh }),
      player && !player.leaving ? button({ id: cid('pk', 'sit', record.id, player.sittingOut ? 'in' : 'out'), label: player.sittingOut ? 'Sit in' : 'Sit out' }) : null,
      player && !player.leaving ? button({ id: cid('pk', 'leave', record.id), label: 'Leave', emoji: ICONS.leave }) : null,
      url ? linkButton('Table', url, ICONS.tables) : null,
    ),
    viewer.userId === record.ownerId ? row(
      button({ id: cid('pk', 'close', record.id), label: 'Close table', disabled: !!state.hand }),
    ) : null,
  ])] };
}

export function pokerRaiseModal(id: string, handId: string, seq: number, min: number, max: number) {
  return modal(cid('m', 'pkraise', id, handId, seq), 'Set your total street bet', [
    textInputLabel({ id: 'amount', label: 'Raise to', description: `${chips(min)}–${chips(max)} including chips already in this street`, value: String(min), max: 10 }),
  ]);
}

export function pokerJoinedScreen(table: PokerSnapshot, showCode = false): Screen {
  const url = pokerUrl(table.record);
  return { components: [container(COLORS.emerald, [
    text(`## ${escapeMarkdown(table.record.name)}\nYou’re seated.${showCode && table.record.accessCode ? '\n**Access code** · ' + table.record.accessCode : ''}`),
    row(
      url ? linkButton('Open table', url, ICONS.tables) : null,
      button({ id: cid('pk', 'hand', table.record.id), label: 'My hand', emoji: ICONS.hand }),
      button({ id: NAV.home, label: 'Home', emoji: ICONS.home }),
    ),
  ])] };
}
