import type { CasinoApp } from '../../app/casino-app.js';
import { chips, escapeMarkdown } from '../../core/format.js';
import { MIN_GIFT } from '../../domain/economy/economy-service.js';
import { cid } from '../custom-id.js';
import { button, container, modal, row, text, textInputLabel, userSelect, type Screen } from '../kit.js';
import { COLORS, ICONS } from '../theme.js';
import { navRow, type Viewer } from './common.js';

export function giftingScreen(app: CasinoApp, viewer: Viewer): Screen {
  const { giftingEnabled, giftDailyLimit } = app.settings.get(viewer.guildId).economy;
  const player = app.economy.requirePlayer(viewer.guildId, viewer.userId);
  return { components: [container(COLORS.gold, [
    navRow('wallet'),
    text(giftingEnabled
      ? `## Chip gifts\nSend a friend ${MIN_GIFT} or more fictional chips from your available balance. You can send up to ${chips(giftDailyLimit)} per UTC day. Both players need a casino account at least 24 hours old.`
      : '## Chip gifts\nGifting is disabled on this server.'),
    giftingEnabled ? userSelect(cid('gift', 'pick'), 'Choose a recipient…') : null,
    giftingEnabled ? row(button({ id: cid('gift', 'incoming', player.gifts_opt_out ? 'on' : 'off'), label: player.gifts_opt_out ? 'Allow incoming gifts' : 'Turn off incoming gifts' })) : null,
  ])] };
}

export function giftAmountModal(recipientId: string, recipientName: string, limit: number) {
  return modal(cid('m', 'gift', recipientId), `Gift chips to ${recipientName}`.slice(0, 45), [
    textInputLabel({ id: 'amount', label: 'Chips to send', description: `${MIN_GIFT}–${chips(limit)} chips`, max: 10 }),
  ]);
}

export function confirmGiftScreen(id: string, recipientName: string, amount: number): Screen {
  return { components: [container(COLORS.gold, [
    navRow('wallet'),
    text(`## Confirm chip gift\nSend **${chips(amount)}** chips to **${escapeMarkdown(recipientName)}**?\n-# This confirmation expires in five minutes.`),
    row(
      button({ id: cid('gift', 'send', id), label: 'Confirm gift', tone: 'success' }),
      button({ id: cid('gift', 'cancel', id), label: 'Cancel', emoji: ICONS.back }),
    ),
  ])] };
}
