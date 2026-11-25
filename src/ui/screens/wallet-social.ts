import type { CasinoApp } from '../../app/casino-app.js';
import { chips, escapeMarkdown } from '../../core/format.js';
import { MIN_GIFT } from '../../domain/economy/economy-service.js';
import { cid } from '../custom-id.js';
import { button, container, modal, progressBar, row, text, textInputLabel, userSelect, type Screen } from '../kit.js';
import { COLORS, ICONS } from '../theme.js';
import { navRow, type Viewer } from './common.js';

export function giftingScreen(app: CasinoApp, viewer: Viewer): Screen {
  const { giftingEnabled, giftDailyLimit } = app.settings.get(viewer.guildId).economy;
  const player = app.economy.requirePlayer(viewer.guildId, viewer.userId);
  const dayStart = Math.floor(app.clock.now() / 86_400_000) * 86_400_000;
  const sent = app.db.get<{ sent: number }>(
    "SELECT COALESCE(SUM(-amount), 0) AS sent FROM ledger WHERE guild_id = ? AND user_id = ? AND type = 'gift_sent' AND created_at >= ?",
    [viewer.guildId, viewer.userId, dayStart],
  )?.sent ?? 0;
  const left = Math.max(0, giftDailyLimit - sent);
  return { components: [container(COLORS.gold, [
    navRow('wallet'),
    text(giftingEnabled
      ? `## ${ICONS.gift} Chip gifts\nSend a friend some of your fictional chips — ${MIN_GIFT} or more from your available balance.\n**${chips(left)}** of ${chips(giftDailyLimit)} left to give today · ${progressBar(giftDailyLimit ? sent / giftDailyLimit : 0, 10)}\n-# Both of you need a casino account at least 24 hours old. Gifts can't be undone.`
      : `## ${ICONS.gift} Chip gifts\nGifting is switched off on this server.`),
    giftingEnabled && left >= MIN_GIFT ? userSelect(cid('gift', 'pick'), 'Choose who to gift chips to…') : null,
    row(
      button({ id: cid('nav', 'wallet', 'gifting'), label: 'Back to wallet', emoji: ICONS.back }),
      giftingEnabled ? button({ id: cid('gift', 'incoming', player.gifts_opt_out ? 'on' : 'off'), label: player.gifts_opt_out ? 'Allow gifts to me' : 'Don’t accept gifts' }) : null,
    ),
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
