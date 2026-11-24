import type { CasinoApp } from '../../app/casino-app.js';
import { chips } from '../../core/format.js';
import { describeRules } from '../../games/blackjack/engine.js';
import { rulesFromSettings } from '../../tables/blackjack-table-service.js';
import { cid } from '../custom-id.js';
import { container, option, select, text, type Screen } from '../kit.js';
import { COLORS } from '../theme.js';
import { navRow, type Viewer } from './common.js';

export const HELP_TOPICS = ['start', 'blackjack', 'economy', 'tables', 'games', 'fair', 'commands'] as const;
export type HelpTopic = (typeof HELP_TOPICS)[number];

const TITLES: Record<HelpTopic, string> = {
  start: 'Getting started',
  blackjack: 'Blackjack',
  economy: 'Chips & rewards',
  tables: 'Tables, seats & threads',
  games: 'Other games',
  fair: 'Fair play',
  commands: 'Commands',
};

export function helpScreen(app: CasinoApp, viewer: Viewer, topic: HelpTopic): Screen {
  const s = app.settings.get(viewer.guildId);
  const e = s.economy;
  const bodies: Record<HelpTopic, string> = {
    start:
      `**Welcome!** Everything works with buttons — commands are optional.\n` +
      `1. **Play Blackjack** seats you at an open table (or opens one) and takes you to its thread.\n` +
      `2. Press a chip to bet. The hand is dealt shortly after; when it's your turn, the action buttons light up for you.\n` +
      `3. Collect your **daily reward** and **passive income** from the wallet — free chips, every day.\n` +
      `4. Check **Leaderboards** and your **Profile** to see how you stack up.\n` +
      `-# Personal menus only appear to you, so the channels stay tidy.`,
    blackjack:
      `Beat the dealer without going over 21. Face cards count 10, aces 1 or 11.\n` +
      `${describeRules(rulesFromSettings(s.blackjack))
        .map((l) => `▸ ${l}`)
        .join('\n')}\n` +
      `**Hit** take a card · **Stand** keep your total · **Double** double your bet for exactly one card · **Split** a pair into two hands · **Surrender** give up half your bet.\n` +
      `-# You have ${s.blackjack.turnSeconds}s per decision; after that your hand stands automatically.`,
    economy:
      `▸ New players start with **${chips(e.startingBalance)}** chips.\n` +
      `▸ **Passive income:** ${chips(e.passivePerHour)} chips per hour while you're away, stored for up to ${e.passiveCapHours} hours.\n` +
      `▸ **Daily reward:** ${chips(e.dailyReward)} chips, +${chips(e.dailyStreakBonus)} per day of streak (up to ${e.dailyStreakMaxDays} days). Resets at midnight UTC.\n` +
      `▸ **Missions:** three small goals each day for bonus chips and XP.\n` +
      `▸ Chips you bet are held safely until the hand is settled — your wallet shows them as *committed*.\n` +
      `-# Chips are fictional and have no real-world value. They can't be bought, sold, traded or cashed out.`,
    tables:
      `▸ Every blackjack table has its own thread, dealer, shoe and players — several tables run side by side.\n` +
      `▸ Up to ${s.blackjack.maxSeats} players per table. You can sit at one table at a time and switch between hands.\n` +
      `▸ Join mid-hand and you'll be dealt in next hand. Anyone can watch a public table's thread.\n` +
      `▸ **Private tables** need the host's access code. The host can deal early, remove players and close the table.\n` +
      `▸ Tables close after ${s.tables.idleMinutes} minutes of inactivity between hands. Empty tables close after ${s.tables.idleEmptyMinutes} minutes.`,
    games:
      `▸ **Roulette:** a shared European wheel. Bet during the window; it spins for everyone at once.\n` +
      `▸ **Slots:** a private machine — three reels, one payline.\n` +
      `▸ **Coinflip:** challenge a friend; both stakes are held until the flip.\n` +
      `-# More games can be added without touching the economy — see docs/ADDING_A_GAME.md.`,
    fair:
      `▸ Every shuffle, spin and flip uses Node's cryptographically secure random generator.\n` +
      `▸ Nobody — admins included — can see or influence upcoming cards or results.\n` +
      `▸ Every chip movement is written to an append-only ledger you can browse in your wallet.\n` +
      `▸ If the bot restarts mid-hand, the hand resumes exactly where it was; anything that can't be resumed is refunded.`,
    commands:
      `\`/casino\` open the casino · \`/wallet\` your chips · \`/daily\` claim your daily reward\n` +
      `\`/blackjack\` find a table · \`/leaderboard\` rankings · \`/profile [player]\` stats\n` +
      `\`/coinflip <player> <stake>\` challenge someone · \`/roulette\` · \`/slots\` · \`/help\`\n` +
      `Right-click a member → **Apps → Casino profile** to see their stats.\n` +
      `-# Admins: \`/casinoadmin setup\` posts the lobby, \`/casinoadmin panel\` opens settings.`,
  };
  return {
    components: [
      container(COLORS.emerald, [
        navRow(),
        text(`## ❔ ${TITLES[topic]}\n${bodies[topic]}`),
        select({
          id: cid('help', 'topic'),
          placeholder: 'More help topics…',
          options: HELP_TOPICS.map((t) => option(TITLES[t], t, undefined, undefined, t === topic)),
        }),
      ]),
    ],
  };
}
