import { MessageFlags, type AttachmentPayload, type InteractionReplyOptions, type MessageCreateOptions, type MessageEditOptions } from 'discord.js';
import type { Screen } from '../ui/kit.js';

const NO_PINGS = { parse: [] as never[] };

function files(screen: Screen): AttachmentPayload[] {
  return (screen.files ?? []).map((f) => ({ attachment: f.data, name: f.name, ...(f.description ? { description: f.description.slice(0, 1024) } : {}) }));
}

/** A new public message (table panel, lobby, coinflip duel). */
export function createOptions(screen: Screen, pingUserIds: string[] = []): MessageCreateOptions {
  return {
    components: screen.components,
    files: files(screen),
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: pingUserIds.length ? { parse: [], users: pingUserIds } : NO_PINGS,
  };
}

/** An interaction reply (ephemeral by default). */
export function replyOptions(screen: Screen, ephemeral = true): InteractionReplyOptions & { flags: number } {
  return {
    components: screen.components,
    files: files(screen),
    flags: MessageFlags.IsComponentsV2 | (ephemeral ? MessageFlags.Ephemeral : 0),
    allowedMentions: NO_PINGS,
  };
}

/**
 * Edit an existing message. When `reuseAttachments` is true the previously uploaded image is
 * kept (same file name) and nothing is re-uploaded; otherwise old attachments are replaced.
 */
export function editOptions(screen: Screen, reuseAttachments = false): MessageEditOptions {
  if (reuseAttachments) {
    return { components: screen.components, flags: MessageFlags.IsComponentsV2, allowedMentions: NO_PINGS };
  }
  return {
    components: screen.components,
    files: files(screen),
    attachments: [],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: NO_PINGS,
  };
}

export function primaryFileName(screen: Screen): string | null {
  return screen.files?.[0]?.name ?? null;
}

/** Discord API error codes we handle explicitly. */
export const DISCORD_ERRORS = {
  unknownChannel: 10003,
  unknownMessage: 10008,
  unknownInteraction: 10062,
  alreadyAcknowledged: 40060,
  missingAccess: 50001,
  missingPermissions: 50013,
  threadArchived: 50083,
} as const;

export function discordErrorCode(error: unknown): number | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : null;
}
