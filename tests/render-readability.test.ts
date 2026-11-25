import { describe, expect, it } from 'vitest';
import { Resvg } from '@resvg/resvg-js';
import { DEFAULT_RULES, currentTurnUserId } from '../src/games/blackjack/engine.js';
import { RANKS, SUITS, type Card } from '../src/games/cards.js';
import { dealPoker, publicPokerHand } from '../src/games/poker/engine.js';
import { seededRng } from '../src/core/random.js';
import { CARD_H, CARD_W, INDEX_BOX, INDEX_REVEAL_X, INDEX_REVEAL_Y, RANK_BOX, RANK_CAP, RANK_REVEAL_Y, cardIndex } from '../src/render/cards.js';
import { renderOptions } from '../src/render/png.js';
import { pokerLayout, pokerTableSvg } from '../src/render/poker-image.js';
import { cardArrivalFrames } from '../src/render/table-animation.js';
import { TABLE_W, TEXT_FLOOR, doubleTag, handLabels, measure, renderTableSvg, tableLayout, tagWidth, type Rect, type TableLayout } from '../src/render/table-image.js';
import { esc } from '../src/render/svg.js';
import { POKER_NAMES, auditSvg, blackjackFixtures, myHandFixtures, pokerFixtures, tableFixture } from '../src/scripts/render-tables-preview.js';
import { myHandSvg } from '../src/render/hand-image.js';
import { ALL_IN_DEAL_DELAY_MS } from '../src/tables/blackjack-table-service.js';
import { buildTableView, type TableView } from '../src/tables/table-view.js';
import { createHarness } from './table-harness.js';
import { GUILD, userId } from './helpers.js';

/**
 * Readability of the shared table images when Discord scales them down.
 *
 * Measured from the layout geometry, at a given display width (px on screen):
 *   - a card's rank index as its glyph (cap) height: card width × RANK_CAP × display / image width
 *   - every other text as its font size × display / image width
 * Floors: ≥ 9 px at 400 px wide, ≥ 11 px at 500 px wide (names: ≥ 9 px at 400).
 */

const at = (display: number, width: number, virtual: number) => (virtual * display) / width;
const rankPx = (cardW: number, display: number, width = TABLE_W) => at(display, width, cardW * RANK_CAP);

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01;
}

function inside(inner: Rect, outer: Rect): boolean {
  return inner.x >= outer.x - 0.01 && inner.y >= outer.y - 0.01 && inner.x + inner.w <= outer.x + outer.w + 0.01 && inner.y + inner.h <= outer.y + outer.h + 0.01;
}

const indexBox = (x: number, y: number, w: number, box: typeof INDEX_BOX | typeof RANK_BOX = INDEX_BOX): Rect => {
  const s = w / CARD_W;
  return { x: x + box.x0 * s, y: y + box.y0 * s, w: (box.x1 - box.x0) * s, h: (box.y1 - box.y0) * s };
};

/** Every legibility and geometry rule for one blackjack table; returns the smallest sizes found. */
function checkTable(view: TableView, label: string): { rank400: number; text400: number } {
  const L = tableLayout(view);
  const problems: string[] = [];
  const ratio = L.height / L.width;
  if (ratio < 9 / 16 - 0.001 || ratio > 3 / 4 + 0.001) problems.push(`aspect ${L.width}x${L.height}`);
  let rank400 = rankPx(L.dealer.cardW, 400);
  let text400 = at(400, L.width, L.dealer.label.size);
  const rects: Rect[] = [L.dealer.rect];
  for (const seat of view.seats) {
    const g = L.seats[seat.seatIndex];
    if (!g) continue;
    rects.push(g.rect);
    if (!inside(g.rect, { x: 0, y: 0, w: L.width, h: L.height })) problems.push(`${seat.name}: panel off the image`);
    for (const size of [g.nameSize, g.pillSize]) {
      text400 = Math.min(text400, at(400, L.width, size));
      if (at(400, L.width, size) < 9 || at(500, L.width, size) < 11) problems.push(`${seat.name}: text ${size}`);
    }
    seat.hands.forEach((hand, h) => {
      const hg = g.hands[h]!;
      rank400 = Math.min(rank400, rankPx(hg.cardW, 400));
      if (rankPx(hg.cardW, 400) < 9 || rankPx(hg.cardW, 500) < 11) problems.push(`${seat.name} hand ${h}: card ${hg.cardW.toFixed(1)}`);
      if (!inside(hg.box, g.body)) problems.push(`${seat.name} hand ${h}: cards outside the panel`);
      // Every card's index stays uncovered: by the cards dealt after it (in any hand of the seat),
      // by any total / outcome label, and by a "2×" marker. (Rank-only cascades keep the rank.)
      const later = g.hands.flatMap((other, o) => other.cards.map((c, k) => ({ o, k, r: { x: c.x, y: c.y, w: other.cardW, h: other.cardH } })));
      const pillH = g.pillSize * 1.48;
      const labels = g.hands.map((other, o) => ({ x: other.pill.cx - Math.min(other.pill.maxW, tagWidth(handLabels(seat.hands[o]!)[0]!, g.pillSize)) / 2, y: other.pill.cy - pillH / 2, w: Math.min(other.pill.maxW, tagWidth(handLabels(seat.hands[o]!)[0]!, g.pillSize)), h: pillH }));
      const marks = g.hands.flatMap((other, o) => (seat.hands[o]!.doubled ? [doubleTag(other)] : [])).map((d) => ({ x: d.x, y: d.cy - d.h / 2, w: d.w, h: d.h }));
      hg.cards.forEach((c, k) => {
        const box = indexBox(c.x, c.y, hg.cardW, hg.reveal === 'rank' ? RANK_BOX : INDEX_BOX);
        for (const cover of later) {
          const after = cover.o > h || (cover.o === h && cover.k > k);
          if (after && overlaps(box, cover.r)) problems.push(`${seat.name} hand ${h} card ${k}: index covered`);
        }
        for (const r of [...labels, ...marks]) if (overlaps(box, r)) problems.push(`${seat.name} hand ${h} card ${k}: index under a label`);
      });
      // The shortest label always fits its slot, so labels never run into each other.
      const shortest = handLabels(hand).at(-1)!;
      if (tagWidth(shortest, TEXT_FLOOR) > hg.pill.maxW + 0.5) problems.push(`${seat.name} hand ${h}: label "${shortest}" too wide`);
    });
    // Hands never overlap each other.
    g.hands.forEach((a, i) => g.hands.slice(i + 1).forEach((b) => overlaps(a.box, b.box) && problems.push(`${seat.name}: hands overlap`)));
  }
  rects.forEach((a, i) => rects.slice(i + 1).forEach((b) => overlaps(a, b) && problems.push('panels overlap')));
  expect(problems, label).toEqual([]);
  return { rank400, text400 };
}

/** A table with `n` seated players; the players at `complex` hold hands of `counts` cards (doubled), the rest 2–3 cards. */
function sweepView(n: number, counts: number[], complex: number[]): TableView {
  const deck = 'AS 2H 3D 4C 5S 6H 7D 8C 9S TH JD QC KS'.split(' ');
  const hand = (k: number, off: number, split: boolean) => ({ cards: Array.from({ length: k }, (_, c) => deck[(c + off) % deck.length]).join(' '), split, doubled: split && k === 3 });
  return tableFixture({
    mode: 'playing', dealer: '7D', hole: true, active: 0,
    seats: Array.from({ length: n }, (_, i) => ({ hands: complex.includes(i) ? counts.map((k, h) => hand(k, h * 3 + i, counts.length > 1)) : [hand(i % 2 ? 3 : 2, i, false)] })),
  });
}

describe('card index', () => {
  it('fits the strip a covering card leaves visible, for every rank and suit', () => {
    const problems: string[] = [];
    for (const rank of RANKS) {
      for (const suit of SUITS) {
        // Q's tail runs under the next card by design; its bowl is an O of the same width.
        const markup = rank === 'Q' ? cardIndex(`K${suit}` as Card).replace('>K<', '>O<') : cardIndex(`${rank}${suit}` as Card);
        const bbox = (svg: string) => new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1400" viewBox="0 0 100 140">${svg}</svg>`, renderOptions()).getBBox()!;
        const outside = (b: ReturnType<typeof bbox>, box: typeof INDEX_BOX | typeof RANK_BOX) => b.x < box.x0 || b.y < box.y0 || b.x + b.width > box.x1 || b.y + b.height > box.y1;
        if (outside(bbox(markup), INDEX_BOX)) problems.push(`${rank}${suit} index`);
        if (outside(bbox(markup.slice(0, markup.indexOf('</text>') + 7)), RANK_BOX)) problems.push(`${rank}${suit} rank`);
      }
    }
    expect(problems).toEqual([]);
    expect(INDEX_BOX.x1).toBeLessThanOrEqual(INDEX_REVEAL_X * CARD_W);
    expect(INDEX_BOX.y1).toBeLessThanOrEqual(INDEX_REVEAL_Y * CARD_H);
    expect(RANK_BOX.y1).toBeLessThanOrEqual(RANK_REVEAL_Y * CARD_H);
  });
});

describe('text measurement', () => {
  it('matches the bundled fonts, so labels are fitted to their real width', () => {
    const strings = ['Christoffer', 'BUST · 25', '21 · DOUBLED', 'Bets 10 – 1,000', '−1,250', 'Maximilian_the_Great', 'a[b]\\c{d}~e…×'];
    for (const [family, weight, font] of [['Manrope', 800, 'ui'], ['Cinzel', 900, 'display']] as const) {
      for (const text of strings) {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="200"><text x="10" y="120" font-family="${family}" font-weight="${weight}" font-size="100">${esc(text)}</text></svg>`;
        const ink = new Resvg(svg, renderOptions()).getBBox()!.width;
        // Advance widths include the side bearings the ink box leaves out (and ignore kerning).
        const estimate = measure(text, 100, font);
        expect(estimate - ink, `${family} ${text}`).toBeGreaterThanOrEqual(-3);
        expect(estimate - ink, `${family} ${text}`).toBeLessThanOrEqual(24);
      }
    }
  });
});

describe('blackjack table readability', () => {
  const fixtures = blackjackFixtures();

  it.each(Object.keys(fixtures))('%s meets the floors at 400 and 500 px', (name) => {
    const view = fixtures[name]!;
    checkTable(view, name);
    // Independent check straight from the SVG (every text element and card index drawn).
    const svg = renderTableSvg(view);
    for (const [display, floor] of [[400, 9], [500, 11]] as const) {
      const audit = auditSvg(svg, display);
      expect(audit.rankCap, `${name} rank @${display}`).toBeGreaterThanOrEqual(floor);
      expect(audit.text, `${name} text @${display} (${audit.smallest})`).toBeGreaterThanOrEqual(floor);
    }
  });

  it('holds the floors for 1–7 seats with split and long hands at any seat, alone or in pairs', () => {
    const failures: string[] = [];
    for (let n = 1; n <= 7; n++) {
      for (const counts of [[5], [6], [7], [2, 2], [3, 3], [2, 2, 2], [3, 2, 2, 1], [2, 2, 2, 2], [3, 3, 3, 3], [4, 4], [5, 5]]) {
        for (let seat = 0; seat < n; seat++) {
          for (const complex of n > 1 ? [[seat], [seat, (seat + 1) % n]] : [[seat]]) {
            const label = `${n} seats, seats ${complex.join('+')} hold ${counts.join('+')}`;
            try {
              checkTable(sweepView(n, counts, complex), label);
            } catch {
              failures.push(label);
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('keeps seat positions when only the turn, statuses or results change', () => {
    const base = fixtures['bj7-playing']!;
    const geometry = (v: TableView) => JSON.stringify(tableLayout(v));
    const quiet = structuredClone(base);
    for (const seat of quiet.seats) {
      seat.active = false;
      seat.status = null;
      for (const hand of seat.hands) {
        hand.active = false;
        hand.badge = { text: 'BUST · 25', tone: 'bad' };
        hand.visible = 0;
        hand.fresh = 0;
      }
    }
    quiet.mode = 'results';
    quiet.dealer.visible = 0;
    expect(geometry(quiet)).toBe(geometry(base));
    // A different player to act moves nobody.
    const moved = structuredClone(fixtures['bj5-playing-a2']!);
    moved.seats.forEach((seat) => (seat.active = seat.seatIndex === 4));
    expect(geometry(moved)).toBe(geometry(fixtures['bj5-playing-a2']!));
    // Nor does a hit: the cards already on the table stay where they are.
    const before = tableLayout(fixtures['bj2-playing']!).seats[1]!.hands[0]!.cards;
    const hit = structuredClone(fixtures['bj2-playing']!);
    hit.seats[1]!.hands[0]!.cards.push('3C');
    expect(tableLayout(hit).seats[1]!.hands[0]!.cards.slice(0, 2)).toEqual(before);
  });

  it('animates cards into exactly the spots the still image uses', () => {
    const view = fixtures['bj5-playing-a2']!;
    const arrivals = view.seats.filter((s) => s.hands.length).map((s) => ({ to: { seat: s.seatIndex, hand: 0, card: s.hands[0]!.cards.length - 1 } }));
    const frames = cardArrivalFrames(view, [...arrivals, { to: { dealer: 1 } }], { flight: 4, stagger: 1, frameMs: 60 });
    expect(frames.at(-1)!.svg).toBe(renderTableSvg(view));
    // Frames lay the table out identically (only the cards in flight differ).
    const L: TableLayout = tableLayout(view);
    const panel = (svg: string) => svg.match(/<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+" rx="14"/g);
    expect(panel(frames[0]!.svg)).toEqual(panel(frames.at(-1)!.svg));
    expect(L.seats.filter(Boolean)).toHaveLength(5);
  });

  it('shows insurance, doubles and outcomes from a real round', async () => {
    const h = createHarness();
    const owner = userId(1);
    for (let i = 1; i <= 3; i++) h.economy.ensurePlayer(GUILD, userId(i), `Player ${i}`);
    const table = await h.tables.createTable({ guildId: GUILD, ownerId: owner, ownerName: 'Player 1' });
    const id = table.record.id;
    for (let i = 2; i <= 3; i++) await h.tables.join(id, userId(i), `Player ${i}`);
    // p1 T,9 · p2 5,6 · p3 T,7 · dealer A up, 6 in the hole; p2 then draws a T on the double.
    await h.tables.debugSetShoe(id, ['TS', '5H', 'TD', 'AH', '9S', '6C', '7D', '6S', 'TC', 'TH', '9C'] as Card[]);
    for (let i = 1; i <= 3; i++) await h.tables.placeBet(id, userId(i), 100);
    await h.tick(ALL_IN_DEAL_DELAY_MS);
    expect(h.tables.peek(id)!.state.phase).toBe('insurance');
    const deciding = buildTableView(h.tables.peek(id)!, DEFAULT_RULES);
    checkTable(deciding, 'insurance decision');
    await h.tables.decideInsurance(id, userId(1), true);
    await h.tables.decideInsurance(id, userId(2), false);
    await h.tables.decideInsurance(id, userId(3), false);
    const playing = buildTableView(h.tables.peek(id)!, DEFAULT_RULES);
    expect(playing.seats[0]!.insurance).toBe('taken');
    checkTable(playing, 'playing');
    for (let guard = 0; guard < 10; guard++) {
      const s = h.tables.peek(id)!.state;
      if (s.phase !== 'playing') break;
      const who = currentTurnUserId(s.round!)!;
      await h.tables.act(id, who, who === userId(2) ? 'double' : 'stand', s.round!.seq);
    }
    const results = buildTableView(h.tables.peek(id)!, DEFAULT_RULES);
    expect(results.mode).toBe('results');
    expect(results.seats[0]!.insurance).toBe('lost');
    expect(results.seats[1]!.hands[0]!.doubled).toBe(true);
    checkTable(results, 'results');
    const svg = renderTableSvg(results);
    expect(svg).toContain('>2×<');
    expect(svg).toContain('>INS<');
  });
});

describe("Hold'em table readability", () => {
  const fixtures = pokerFixtures();

  function checkPoker(view: ReturnType<typeof publicPokerHand>, label: string) {
    const L = pokerLayout(view);
    const problems: string[] = [];
    const ratio = L.height / L.width;
    if (ratio < 9 / 16 - 0.001 || ratio > 3 / 4 + 0.001) problems.push('aspect');
    for (const cardW of [L.board.cardW, ...L.seats.map((s) => s.cardW)]) {
      if (rankPx(cardW, 400, L.width) < 9 || rankPx(cardW, 500, L.width) < 11) problems.push(`card ${cardW.toFixed(1)}`);
    }
    for (const s of L.seats) {
      if (at(400, L.width, Math.min(s.nameSize, s.pillSize)) < 9) problems.push('text');
      if (overlaps(indexBox(s.cards[0]!.x, s.cards[0]!.y, s.cardW), { x: s.cards[1]!.x, y: s.cards[1]!.y, w: s.cardW, h: s.cardH })) problems.push('hole card index covered');
      if (!inside({ x: s.cards[0]!.x, y: s.cards[0]!.y, w: s.cards[1]!.x + s.cardW - s.cards[0]!.x, h: s.cardH }, s.rect)) problems.push('cards outside panel');
    }
    const rects = [L.board.rect, ...L.seats.map((s) => s.rect)];
    rects.forEach((a, i) => rects.slice(i + 1).forEach((b) => overlaps(a, b) && problems.push('panels overlap')));
    expect(problems, label).toEqual([]);
    const svg = pokerTableSvg(view, POKER_NAMES);
    for (const [display, floor] of [[400, 9], [500, 11]] as const) {
      const audit = auditSvg(svg, display);
      expect(audit.text, `${label} text @${display} (${audit.smallest})`).toBeGreaterThanOrEqual(floor);
      if (audit.rankCap !== Infinity) expect(audit.rankCap, `${label} rank @${display}`).toBeGreaterThanOrEqual(floor);
    }
  }

  it.each(Object.keys(fixtures))('%s meets the floors', (name) => checkPoker(fixtures[name]!, name));

  it('meets the floors for every seat count the settings allow (2–7, and the engine maximum of 9)', () => {
    for (let n = 2; n <= 9; n++) {
      const hand = dealPoker(Array.from({ length: n }, (_, seat) => ({ seat, userId: String(seat), stack: 500 })), 0, 5, 10, seededRng(n));
      checkPoker(publicPokerHand(hand), `${n} seats`);
    }
  });

  it('never draws a hole card face unless the engine revealed it at showdown', () => {
    const faces = (svg: string) => (svg.match(/class="ix"/g) ?? []).length;
    const live = publicPokerHand(dealPoker([0, 1, 2, 3].map((seat) => ({ seat, userId: String(seat), stack: 500 })), 0, 5, 10, seededRng(4)));
    expect(faces(pokerTableSvg(live, POKER_NAMES))).toBe(live.board.length);
    for (const name of ['pk6-flop', 'pk6-river-allin']) {
      const view = fixtures[name]!;
      expect(faces(pokerTableSvg(view, POKER_NAMES)), name).toBe(view.board.length);
    }
    const showdown = fixtures['pk6-showdown-sidepots']!;
    const revealed = showdown.seats.filter((s) => s.cards).length * 2;
    expect(faces(pokerTableSvg(showdown, POKER_NAMES))).toBe(5 + revealed);
    expect(faces(pokerTableSvg(showdown, POKER_NAMES, { maskShowdown: true }))).toBe(5);
  });

  it('keeps cards in the same places across animation frames', () => {
    const spots = (svg: string): string[] => [...(svg.match(/<g transform="translate\([\d. ]+\) scale\([\d.]+\)">/g) ?? [])].sort();
    const view = fixtures['pk6-showdown-sidepots']!;
    const final = pokerTableSvg(view, POKER_NAMES);
    const masked = pokerTableSvg(view, POKER_NAMES, { maskShowdown: true });
    expect(spots(masked)).toEqual(spots(final));
    const partial = spots(pokerTableSvg(view, POKER_NAMES, { shownBoard: 3 }));
    expect(partial.every((s) => spots(final).includes(s))).toBe(true);
  });
});

describe('private hand view', () => {
  it.each(Object.entries(myHandFixtures()))('%s meets the floors when shown 400 px wide', (name, view) => {
    const audit = auditSvg(myHandSvg(view), 400);
    expect(audit.rankCap, name).toBeGreaterThanOrEqual(9);
    expect(audit.text, `${name} (${audit.smallest})`).toBeGreaterThanOrEqual(9);
  });
});
