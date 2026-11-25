import type { GuildSettings } from '../config/settings.js';
import { cid } from './custom-id.js';
import { ICONS } from './theme.js';

export const GAMES = [
  { id: 'blackjack', label: 'Blackjack', icon: ICONS.blackjack, description: 'Play the dealer at a shared table.', play: cid('nav', 'tables', 'blackjack'), rules: cid('nav', 'bjrules') },
  { id: 'poker', label: 'Hold’em', icon: ICONS.poker, description: 'Play no-limit Texas Hold’em with friends.', play: cid('nav', 'tables', 'poker'), rules: cid('nav', 'pkrules') },
  { id: 'roulette', label: 'Roulette', icon: ICONS.roulette, description: 'Take a spot on the shared European wheel.', play: cid('rl', 'open'), rules: cid('rl', 'help') },
  { id: 'slots', label: 'Emerald Slots', icon: ICONS.slots, description: 'Three reels and one payline on your private machine.', play: cid('nav', 'slots'), rules: cid('sl', 'pay') },
  { id: 'coinflip', label: 'Coinflip', icon: ICONS.coinflip, description: 'Challenge a friend to a flip at equal stakes.', play: cid('nav', 'coinflip'), rules: cid('nav', 'cfrules') },
] as const;

export type GameId = typeof GAMES[number]['id'];

export function gameEnabled(settings: GuildSettings, id: GameId): boolean {
  return settings.enabled && settings[id].enabled;
}
