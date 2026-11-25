import type { CasinoApp } from '../../app/casino-app.js';
import { DAY, startOfUtcDay } from '../../core/clock.js';
import { chips, discordTime } from '../../core/format.js';
import { ACHIEVEMENTS } from '../../domain/achievements.js';
import { levelInfo } from '../../domain/progression.js';
import { cid } from '../custom-id.js';
import { button, container, progressBar, row, separator, text, type Screen } from '../kit.js';
import { COLORS, ICONS } from '../theme.js';
import { claimButtons } from './home.js';
import { navRow, type Viewer } from './common.js';

export function rewardsScreen(app: CasinoApp, viewer: Viewer, missionsOnly = false): Screen {
  const player = app.economy.ensurePlayer(viewer.guildId, viewer.userId, viewer.displayName);
  const wallet = app.economy.getWallet(viewer.guildId, viewer.userId);
  const econ = app.settings.get(viewer.guildId).economy;
  const missions = app.progress.todaysMissions(viewer.guildId, viewer.userId);
  const streak = wallet.daily.streak;
  const streakDays = Array.from({ length: econ.dailyStreakMaxDays }, (_, i) => (i < (wallet.daily.available ? streak - 1 : streak) ? '◆' : '◇')).join(' ');
  const daily = econ.dailyReward === 0 ? '**Daily reward** · disabled on this server' : wallet.daily.available
    ? `**Daily reward** · ready — **${chips(wallet.daily.amount)}** chips\nStreak ${streakDays}${streak > 1 ? ` · day ${streak}` : ''}`
    : `**Daily reward** · claimed — next ${discordTime(wallet.daily.nextAt)}\nStreak ${streakDays} · ${streak} ${streak === 1 ? 'day' : 'days'}`;
  const passive = `**Passive income** · ${chips(wallet.passive.available)} ready of ${chips(wallet.passive.cap)}`;
  const missionLines = missions.map((m) => {
    const done = m.completedAt !== null;
    return done
      ? `✅ ~~${m.def.name}~~ — ${m.def.description} · **+${chips(m.def.reward)}** collected`
      : `▸ **${m.def.name}** — ${m.def.description}\n-# ${progressBar(m.progress / m.target, 8)} ${m.progress}/${m.target} · reward ${chips(m.def.reward)} chips + ${m.def.xp} XP`;
  });
  const info = levelInfo(player.xp);
  const unlocked = app.progress.unlockedAchievements(viewer.guildId, viewer.userId);
  const ctx = { stats: app.stats.snapshot(viewer.guildId, viewer.userId), flags: new Set<string>(), level: info.level };
  const close = ACHIEVEMENTS.filter((a) => !unlocked.has(a.id) && !a.secret && a.progress)
    .map((a) => ({ a, p: a.progress!(ctx) }))
    .filter(({ p }) => p.current > 0 && p.target > 1)
    .sort((x, y) => y.p.current / y.p.target - x.p.current / x.p.target)
    .slice(0, 2)
    .map(({ a, p }) => `${a.icon} **${a.name}** ${progressBar(p.current / p.target, 6)} ${p.current}/${p.target}`);
  const resets = startOfUtcDay(app.clock.now()) + DAY;
  return {
    components: [
      container(COLORS.gold, [
        navRow('wallet'),
        text(`## 🎁 Rewards\n-# Free chips for showing up. Rewards never depend on how much you bet.`),
        text(`${daily}\n${passive}`),
        missionsOnly ? null : row(...claimButtons(app, viewer, 'rewards')),
        separator(),
        missionsOnly ? text(`### Today's missions\n${missionLines.join('\n') || 'No missions today.'}\n-# New missions ${discordTime(resets)}`) : null,
        close.length ? text(`### Almost there\n${close.join('\n')}`) : null,
        row(
          button({ id: cid('nav', 'achv', viewer.userId, 0), label: 'Achievements', emoji: ICONS.achievements }),
          button({ id: cid('nav', missionsOnly ? 'rewards' : 'missions'), label: missionsOnly ? 'Rewards' : 'Missions' }),
        ),
      ]),
    ],
  };
}
