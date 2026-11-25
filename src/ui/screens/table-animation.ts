import { createHash } from 'node:crypto';
import type { CasinoApp } from '../../app/casino-app.js';
import { framesToGif, type GifFrame } from '../../render/gif.js';
import { cardArrivalFrames, chipFrames, type Arrival } from '../../render/table-animation.js';
import { buildTableView } from '../../tables/table-view.js';
import type { RenderHint, TableSnapshot } from '../../tables/types.js';
import { tableRules } from './blackjack.js';

/** GIF width: motion reads fine a little smaller than the static table (and renders faster). */
const GIF_WIDTH = 640;
/** Extra time after the GIF's own length, so clients that load it a moment late still see it end. */
const LOAD_SLACK_MS = 450;

export interface TableAnimation {
  /** Which text goes with it: the deal and the dealer's turn hide controls; a draw keeps them. */
  mode: 'deal' | 'draw' | 'reveal';
  file: { name: string; data: Buffer };
  holdMs: number;
}

const DEAL = { flight: 4, stagger: 1, frameMs: 65, quiet: true };
const DRAW = { flight: 6, stagger: 0, frameMs: 50 };
const REVEAL = { flight: 6, stagger: 7, frameMs: 55, landMs: 170 };

/**
 * The animation for a table change: cards dealt from the shoe, a drawn card flying in, the dealer
 * turning the hole card and drawing, then chips moving to winners and away from losers. Returns
 * null when the change has nothing to animate.
 */
export async function tableAnimation(app: CasinoApp, snapshot: Readonly<TableSnapshot>, hint: RenderHint): Promise<TableAnimation | null> {
  const { state } = snapshot;
  const rules = tableRules(app, snapshot);
  const seatOf = (userId: string) => state.seats.find((s) => s.userId === userId)?.seatIndex;
  const frames: GifFrame[] = [];
  let mode: TableAnimation['mode'] = 'draw';

  if (hint.kind === 'dealt' || (hint.kind === 'round_settled' && hint.dealt)) {
    // Two passes round the table, players then the dealer, like a real deal.
    mode = 'deal';
    const settled = !state.round;
    const view = settled ? buildTableView(snapshot, rules, { revealStep: 0 }) : buildTableView(snapshot, rules);
    const players = (state.round?.seats ?? state.lastResult?.seats ?? []).map((s) => seatOf(s.userId)).filter((s): s is number => s !== undefined);
    const arrivals: Arrival[] = [];
    for (const pass of [0, 1]) {
      for (const seat of players) arrivals.push({ to: { seat, hand: 0, card: pass } });
      arrivals.push({ to: { dealer: pass } });
    }
    frames.push(...cardArrivalFrames(view, arrivals, DEAL));
  }

  if (hint.kind === 'drawn') {
    const seat = seatOf(hint.userId);
    const view = buildTableView(snapshot, rules);
    const hand = seat === undefined ? undefined : view.seats[seat]?.hands[hint.hand];
    if (seat === undefined || !hand) return null;
    frames.push(...cardArrivalFrames(view, [{ to: { seat, hand: hint.hand, card: hand.cards.length - 1 } }], DRAW));
  }

  if (hint.kind === 'round_settled') {
    const result = state.lastResult;
    if (!result || result.voided) return frames.length ? encode(frames, mode) : null;
    if (!hint.dealt) mode = 'reveal';
    // The dealer's turn: the last player's card (if their action ended the round), the hole card
    // turning over, then each dealer draw landing with a beat.
    const revealView = buildTableView(snapshot, rules, { revealStep: Math.max(0, result.dealerCards.length - 2) });
    const arrivals: Arrival[] = [];
    if (hint.lastDraw) {
      const seat = seatOf(hint.lastDraw.userId);
      const hand = seat === undefined ? undefined : revealView.seats[seat]?.hands[hint.lastDraw.hand];
      if (seat !== undefined && hand) arrivals.push({ to: { seat, hand: hint.lastDraw.hand, card: hand.cards.length - 1 } });
    }
    if (!hint.dealt) arrivals.push({ to: { dealer: 1 }, flipOnly: true });
    for (let i = 2; i < result.dealerCards.length; i++) arrivals.push({ to: { dealer: i } });
    if (arrivals.length) frames.push(...cardArrivalFrames(revealView, arrivals, REVEAL));
    // Settling: chips slide to the winners and away from the losers.
    const moves = result.seats.filter((s) => s.net !== 0).map((s) => ({ seat: s.seatIndex, toSeat: s.net > 0, amount: s.wagered }));
    if (moves.length) frames.push(...chipFrames(buildTableView(snapshot, rules), moves, 7, 55));
  }

  return frames.length ? encode(frames, mode) : null;
}

async function encode(frames: GifFrame[], mode: TableAnimation['mode']): Promise<TableAnimation> {
  const { gif, durationMs } = await framesToGif(frames, mode === 'deal' ? 560 : GIF_WIDTH);
  const name = `table-anim-${createHash('sha1').update(gif).digest('hex').slice(0, 12)}.gif`;
  return { mode, file: { name, data: gif }, holdMs: durationMs + (mode === 'deal' ? 250 : LOAD_SLACK_MS) };
}
