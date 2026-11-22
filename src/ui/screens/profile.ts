import type { CasinoApp } from '../../app/casino-app.js';
import { chips, discordTime, percent, signedChips } from '../../core/format.js';
import { ACHIEVEMENTS, isAchieved } from '../../domain/achievements.js';
import { COSMETICS, cosmetic, isCosmeticUnlocked, levelInfo, type CosmeticKind } from '../../domain/progression.js';
import { stat } from '../../domain/stats-service.js';
import { stylePreviewSvg } from '../../render/game-images.js';
import { cid } from '../custom-id.js';
import { button, container, gallery, option, progressBar, row, section, select, separator, text, thumbnail, type Screen } from '../kit.js';
import { COLORS, ICONS } from '../theme.js';
import { NAV, name, navRow, type Viewer } from './common.js';

export interface ProfileTarget {
  userId: string;
  displayName: string;
  avatarUrl: string;
}

export function profileScreen(app: CasinoApp, viewer: Viewer, target: ProfileTarget): Screen {
  const self = target.userId === viewer.userId;
  const player = self
    ? app.economy.ensurePlayer(viewer.guildId, viewer.userId, viewer.displayName)
    : app.economy.getPlayer(viewer.guildId, target.userId);
  if (!player) {
    return {
      components: [
        container(COLORS.charcoal, [
          text(`## ${target.displayName}\nThis player hasn't visited the casino yet.`),
          navRow('profile'),
        ]),
      ],
    };
  }
  const info = levelInfo(player.xp);
  const stats = app.stats.snapshot(viewer.guildId, target.userId);
  const unlocked = app.progress.unlockedAchievements(viewer.guildId, target.userId);
  const title = player.title_id ? cosmetic('title', player.title_id)?.name : undefined;
  const richRank = app.leaderboards.rankOf(viewer.guildId, 'richest', target.userId);

  const bj = (s: string) => stat(stats, 'blackjack', s);
  const hands = bj('hands');
  const winRate = hands > 0 ? percent(bj('hands_won') / hands) : '—';
  const blackjackBlock =
    bj('rounds') > 0
      ? `### ♠ Blackjack\nRounds **${chips(bj('rounds'))}** · Hands won **${chips(bj('hands_won'))}** · lost ${chips(bj('hands_lost'))} · pushed ${chips(bj('hands_pushed'))}\nNaturals **${chips(bj('blackjacks'))}** · Win rate **${winRate}** · Streak ${bj('current_streak')} (best **${bj('best_streak')}**)\nBiggest win **${chips(bj('biggest_win'))}** · Wagered ${chips(bj('wagered'))} · Net **${signedChips(bj('net'))}**`
      : '### ♠ Blackjack\nNo rounds played yet.';
  const otherLines: string[] = [];
  if (stat(stats, 'roulette', 'rounds') > 0) {
    otherLines.push(`Roulette — ${chips(stat(stats, 'roulette', 'rounds'))} spins · net ${signedChips(stat(stats, 'roulette', 'net'))}`);
  }
  if (stat(stats, 'slots', 'rounds') > 0) {
    otherLines.push(`Slots — ${chips(stat(stats, 'slots', 'rounds'))} spins · best ×${stat(stats, 'slots', 'biggest_multiplier')} · net ${signedChips(stat(stats, 'slots', 'net'))}`);
  }
  if (stat(stats, 'coinflip', 'rounds') > 0) {
    otherLines.push(`Coinflip — ${stat(stats, 'coinflip', 'wins')} won / ${stat(stats, 'coinflip', 'losses')} lost · net ${signedChips(stat(stats, 'coinflip', 'net'))}`);
  }
  const all = (s: string) => stat(stats, 'all', s);
  const rewards =
    app.db.get<{ n: number }>(
      "SELECT COALESCE(SUM(amount), 0) AS n FROM ledger WHERE guild_id = ? AND user_id = ? AND type IN ('passive_income','daily_reward','mission_reward','achievement_reward')",
      [viewer.guildId, target.userId],
    )?.n ?? 0;
  const recentAchievements = [...unlocked.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([id]) => ACHIEVEMENTS.find((a) => a.id === id))
    .filter((a) => a !== undefined)
    .map((a) => `${a.icon} ${a.name}`);

  return {
    components: [
      container(COLORS.emerald, [
        section(
          [
            `## ${target.displayName}${title ? `\n-# *“${title}”*` : ''}`,
            `**Level ${info.level} · ${info.rank.name}**\n${progressBar(info.progress)} ${chips(info.into)} / ${chips(info.span)} XP`,
          ],
          thumbnail(target.avatarUrl, `${target.displayName}'s avatar`),
        ),
        separator(),
        text(
          `**Chips** ${chips(player.balance + player.reserved)}${richRank ? ` · #${richRank} richest` : ''} · peak ${chips(player.highest_balance)}\n` +
            `**Earned** ${chips(all('net_won') + rewards)} (${chips(rewards)} from rewards) · **Wagered** ${chips(all('wagered'))} · **Net** ${signedChips(all('net'))}\n` +
            `-# Playing since ${discordTime(player.created_at, 'D')} · ${all('days_played')} days at the tables`,
        ),
        text(blackjackBlock + (otherLines.length ? `\n### Other games\n${otherLines.join('\n')}` : '')),
        text(
          `### Achievements · ${unlocked.size}/${ACHIEVEMENTS.length}\n${recentAchievements.length ? recentAchievements.join(' · ') : 'None yet — play a hand to earn your first.'}`,
        ),
        row(
          button({ id: cid('nav', 'achv', target.userId, 0), label: 'Achievements', emoji: ICONS.achievements }),
          self ? button({ id: cid('nav', 'style'), label: 'Customize', emoji: ICONS.style }) : null,
          button({ id: NAV.leaderboard, label: 'Leaderboards', emoji: ICONS.leaderboard }),
          button({ id: NAV.home, label: 'Home', emoji: ICONS.home }),
          self ? button({ id: cid('nav', 'privacy'), label: player.leaderboard_opt_out ? 'Show me on boards' : 'Hide me from boards' }) : null,
        ),
      ]),
    ],
  };
}

export const ACHIEVEMENTS_PAGE = 7;

export function achievementsScreen(app: CasinoApp, viewer: Viewer, targetId: string, targetName: string, page: number): Screen {
  const unlocked = app.progress.unlockedAchievements(viewer.guildId, targetId);
  const player = app.economy.getPlayer(viewer.guildId, targetId);
  const ctx = { stats: app.stats.snapshot(viewer.guildId, targetId), flags: new Set<string>(), level: levelInfo(player?.xp ?? 0).level };
  const ordered = [...ACHIEVEMENTS].sort((a, b) => Number(unlocked.has(b.id)) - Number(unlocked.has(a.id)));
  const pages = Math.max(1, Math.ceil(ordered.length / ACHIEVEMENTS_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const lines = ordered.slice(p * ACHIEVEMENTS_PAGE, (p + 1) * ACHIEVEMENTS_PAGE).map((a) => {
    const at = unlocked.get(a.id);
    const reward = [a.reward.chips ? `${chips(a.reward.chips)} chips` : null, a.reward.xp ? `${a.reward.xp} XP` : null].filter(Boolean).join(' + ');
    if (at) return `**${a.icon} ${a.name}** — ${a.description}\n-# Unlocked ${discordTime(at, 'D')} · ${reward}`;
    if (a.secret) return `**◇ ???** — A secret achievement.\n-# Keep playing to discover it.`;
    const progress = a.progress?.(ctx);
    const bar = progress && progress.target > 1 ? ` ${progressBar(progress.current / progress.target, 8)} ${progress.current}/${progress.target}` : '';
    void isAchieved;
    return `◇ ${a.name} — ${a.description}\n-# Locked${bar} · ${reward}`;
  });
  return {
    components: [
      container(COLORS.gold, [
        text(`## Achievements · ${targetName}\n-# ${unlocked.size} of ${ACHIEVEMENTS.length} unlocked`),
        separator(),
        text(lines.join('\n')),
        row(
          button({ id: cid('nav', 'achv', targetId, p - 1), emoji: ICONS.back, disabled: p === 0 }),
          button({ id: cid('nav', 'achv', targetId, 'page'), label: `Page ${p + 1} of ${pages}`, disabled: true }),
          button({ id: cid('nav', 'achv', targetId, p + 1), emoji: ICONS.next, disabled: p >= pages - 1 }),
          button({ id: cid('nav', 'profile', targetId === viewer.userId ? '' : targetId), label: 'Profile', emoji: ICONS.profile }),
          button({ id: NAV.home, label: 'Home', emoji: ICONS.home }),
        ),
      ]),
    ],
  };
}

/** Cosmetic picker with a rendered preview of the chosen felt and card back. */
export async function styleScreen(app: CasinoApp, viewer: Viewer): Promise<Screen> {
  const player = app.economy.ensurePlayer(viewer.guildId, viewer.userId, viewer.displayName);
  const level = levelInfo(player.xp).level;
  const achieved = new Set(app.progress.unlockedAchievements(viewer.guildId, viewer.userId).keys());
  const choices = (kind: CosmeticKind, current: string | null) =>
    COSMETICS.filter((c) => c.kind === kind).map((c) => {
      const open = isCosmeticUnlocked(c, level, achieved);
      return option(open ? c.name : `🔒 ${c.name}`, open ? c.id : `locked:${c.id}`, open ? c.description : `Locked — ${c.description}`, undefined, c.id === current);
    });
  const { png } = await app.images.render(stylePreviewSvg(player.felt_id, player.card_back_id), 560);
  const titleOptions = [option('No title', 'none', 'Show your rank only', undefined, !player.title_id), ...choices('title', player.title_id)];
  return {
    files: [{ name: 'style.png', data: png, description: 'Preview of your felt and card back' }],
    components: [
      container(COLORS.violet, [
        text(`## Customize\n-# Cosmetics unlock with levels and achievements. They never affect the odds.\nYour **felt** and **card back** are used at tables you open.`),
        gallery([{ url: 'attachment://style.png', description: 'Preview of your felt and card back' }]),
        select({ id: cid('style', 'card_back'), placeholder: 'Card back', options: choices('card_back', player.card_back_id) }),
        select({ id: cid('style', 'felt'), placeholder: 'Table felt', options: choices('felt', player.felt_id) }),
        select({ id: cid('style', 'title'), placeholder: 'Profile title', options: titleOptions }),
        row(
          button({ id: cid('nav', 'profile', ''), label: 'Profile', emoji: ICONS.profile }),
          button({ id: NAV.home, label: 'Home', emoji: ICONS.home }),
        ),
      ]),
    ],
  };
}

/** Apply a cosmetic choice (validated against unlocks). */
export function applyCosmetic(app: CasinoApp, viewer: Viewer, kind: CosmeticKind, value: string): string | null {
  if (value.startsWith('locked:')) return 'That cosmetic is still locked.';
  const player = app.economy.ensurePlayer(viewer.guildId, viewer.userId, viewer.displayName);
  if (kind === 'title' && value === 'none') {
    app.db.run('UPDATE players SET title_id = NULL WHERE guild_id = ? AND user_id = ?', [viewer.guildId, viewer.userId]);
    return null;
  }
  const item = cosmetic(kind, value);
  const achieved = new Set(app.progress.unlockedAchievements(viewer.guildId, viewer.userId).keys());
  if (!item || !isCosmeticUnlocked(item, levelInfo(player.xp).level, achieved)) return 'That cosmetic is still locked.';
  const column = kind === 'card_back' ? 'card_back_id' : kind === 'felt' ? 'felt_id' : 'title_id';
  app.db.run(`UPDATE players SET ${column} = ? WHERE guild_id = ? AND user_id = ?`, [value, viewer.guildId, viewer.userId]);
  return null;
}

export { name };
