import { ComponentType, type APILabelComponent } from 'discord.js';
import type { CasinoApp } from '../../app/casino-app.js';
import { chips, discordTime, escapeMarkdown, signedChips } from '../../core/format.js';
import { SETTING_GROUPS, SETTING_SPECS, getPath, type SettingGroup, type SettingSpec } from '../../config/settings.js';
import { cid } from '../custom-id.js';
import { button, container, modal, option, row, section, select, separator, text, textInputLabel, type ModalSpec, type Screen } from '../kit.js';
import { COLORS, ICONS } from '../theme.js';
import { tableSummary } from './blackjack.js';

function formatValue(spec: SettingSpec, value: unknown): string {
  if (spec.type === 'bool') return value ? 'On' : 'Off';
  if (spec.type === 'int') return chips(Number(value));
  return String(value);
}

export function adminScreen(app: CasinoApp, guildId: string, group: SettingGroup, notice?: string): Screen {
  const settings = app.settings.get(guildId);
  const specs = SETTING_SPECS.filter((s) => s.group === group);
  const lines = specs.map((s) => `**${s.label}** · ${formatValue(s, getPath(settings, s.key))}`);
  const lobby = app.settings.lobby(guildId);
  return {
    components: [
      container(COLORS.charcoal, [
        text(
          `## ${ICONS.settings} Casino admin\n-# Only server managers can see this. Changes apply immediately; blackjack rules take effect from the next hand.${notice ? `\n${notice}` : ''}`,
        ),
        select({
          id: cid('adm', 'group'),
          placeholder: 'Settings group',
          options: (Object.keys(SETTING_GROUPS) as SettingGroup[]).map((g) => option(SETTING_GROUPS[g].label, g, SETTING_GROUPS[g].description, undefined, g === group)),
        }),
        text(lines.join('\n')),
        select({
          id: cid('adm', 'edit', group),
          placeholder: 'Change a setting…',
          options: specs.map((s) => option(s.label, s.key, `${formatValue(s, getPath(settings, s.key))} — ${s.help}`)),
        }),
        separator(),
        text(
          `**Lobby** · ${lobby.channelId ? `<#${lobby.channelId}>` : 'not set up — use `/casinoadmin setup`'}\n-# Wallet adjustments always need a reason and are written to the ledger. Admins cannot influence game outcomes.`,
        ),
        row(
          button({ id: cid('adm', 'adjust'), label: 'Adjust a wallet', emoji: ICONS.wallet }),
          button({ id: cid('adm', 'audit'), label: 'Audit log', emoji: ICONS.history }),
          button({ id: cid('adm', 'tables'), label: 'Manage tables', emoji: ICONS.tables }),
          button({ id: cid('adm', 'lobby'), label: 'Refresh lobby', emoji: ICONS.refresh, disabled: !lobby.channelId }),
          button({ id: cid('adm', 'health'), label: 'Health check' }),
        ),
      ]),
    ],
  };
}

export function settingModal(app: CasinoApp, guildId: string, spec: SettingSpec): ModalSpec {
  const current = getPath(app.settings.get(guildId), spec.key);
  const description = spec.type === 'int' ? `${spec.help} (${chips(spec.min)}–${chips(spec.max)})` : spec.help;
  return modal(cid('m', 'admset', spec.key), spec.label, [
    textInputLabel({ id: 'value', label: spec.label, description, value: String(current ?? ''), max: spec.type === 'text' ? spec.maxLength : 12 }),
  ]);
}

export function adjustModal(): ModalSpec {
  const userPicker: APILabelComponent = {
    type: ComponentType.Label,
    label: 'Player',
    component: { type: ComponentType.UserSelect, custom_id: 'user', min_values: 1, max_values: 1 },
  };
  return modal(cid('m', 'admadjust'), 'Adjust a wallet', [
    userPicker,
    textInputLabel({ id: 'amount', label: 'Amount', description: 'Positive to add chips, negative to remove (e.g. -250)', max: 12 }),
    textInputLabel({ id: 'reason', label: 'Reason (required)', description: 'Recorded permanently in the audit log', min: 3, max: 200, paragraph: true }),
  ]);
}

export function auditScreen(app: CasinoApp, guildId: string): Screen {
  const rows = app.db.all<{ user_id: string; amount: number; type: string; memo: string | null; actor_id: string | null; reference: string | null; created_at: number }>(
    "SELECT user_id, amount, type, memo, actor_id, reference, created_at FROM ledger WHERE guild_id = ? AND type IN ('admin_adjust', 'gift_sent', 'gift_received', 'emergency_relief') ORDER BY created_at DESC, rowid DESC LIMIT 15",
    [guildId],
  );
  const labels: Record<string, string> = { gift_sent: 'Gift sent', gift_received: 'Gift received', emergency_relief: 'Relief grant' };
  const lines = rows.map((entry) => {
    const reason = entry.type === 'admin_adjust'
      ? `by <@${entry.actor_id ?? '0'}> · ${escapeMarkdown(entry.memo ?? '')}`
      : `${labels[entry.type]}${entry.reference ? ` · ref ${entry.reference.slice(0, 8)}` : ''}`;
    return `**${signedChips(entry.amount)}** <@${entry.user_id}> · ${reason} · ${discordTime(entry.created_at)}`;
  });
  return {
    components: [
      container(COLORS.charcoal, [
        text(`## Audit log\n-# Recent wallet adjustments, relief and gifts.\n${lines.join('\n') || 'No entries yet.'}`),
        row(button({ id: cid('adm', 'group', 'general'), label: 'Back', emoji: ICONS.back })),
      ]),
    ],
  };
}

export function adminTablesScreen(app: CasinoApp, guildId: string): Screen {
  const tables = app.blackjack.openTables(guildId).slice(0, 7);
  const wheel = app.roulette.wheelFor(guildId);
  return {
    components: [
      container(COLORS.charcoal, [
        text('## Manage tables\n-# Force-closing a table mid-hand voids the hand and refunds every stake.'),
        ...tables.map((t) => section([`**${escapeMarkdown(t.record.name)}** — ${tableSummary(t)}`], button({ id: cid('adm', 'close', t.record.id), label: 'Force close', tone: 'danger' }))),
        wheel ? section([`**Roulette wheel** — ${wheel.state.bets.length} bets`], button({ id: cid('adm', 'closewheel', wheel.record.id), label: 'Close wheel', tone: 'danger' })) : null,
        tables.length === 0 && !wheel ? text('No tables are open.') : null,
        row(button({ id: cid('adm', 'group', 'tables'), label: 'Back', emoji: ICONS.back })),
      ]),
    ],
  };
}

export function devResetModal(guildId: string): ModalSpec {
  return modal(cid('m', 'admreset'), 'Reset ALL casino data', [
    textInputLabel({
      id: 'confirm',
      label: `Type RESET ${guildId.slice(-4)} to confirm`,
      description: 'Development only. Deletes every account, ledger entry and table in this server.',
      max: 20,
    }),
  ]);
}
