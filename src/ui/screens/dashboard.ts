import { chips, discordTime } from '../../core/format.js';
import type { WalletView } from '../../domain/economy/economy-service.js';
import { casinoArtwork } from '../../render/casino-art.js';
import { gallery, type Screen } from '../kit.js';

/** Supply the illustration and its reference together, including on a renderer failure. */
export async function dashboardArt(kind: 'home' | 'wallet' | 'games' | 'games-holdem') {
  const file = await casinoArtwork(kind);
  return {
    files: file ? [file] : undefined,
    component: file ? gallery([{ url: `attachment://${file.name}`, description: file.description }]) : null,
  } satisfies { files: Screen['files']; component: ReturnType<typeof gallery> | null };
}

export function balanceText(wallet: WalletView): string {
  return `## ${chips(wallet.balance)} chips\n-# Available to play · ${chips(wallet.reserved)} committed · ${chips(wallet.total)} total`;
}

export function rewardSummary(wallet: WalletView, dailyEnabled: boolean, brief = false): string {
  const { passive, daily } = wallet;
  const passiveText = passive.ratePerHour === 0 ? 'Disabled'
    : `${chips(passive.available)}${brief ? '' : ` / ${chips(passive.cap)}`} chips ready${!brief && passive.fullAt ? ` · full ${discordTime(passive.fullAt)}` : ''}`;
  const dailyText = !dailyEnabled ? 'Disabled'
    : daily.available ? `${chips(daily.amount)} chips ready` : `Next ${discordTime(daily.nextAt)}`;
  return `**Passive income** · ${passiveText}\n**Daily reward** · ${dailyText}`;
}
