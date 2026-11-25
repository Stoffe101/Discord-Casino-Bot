import { createHash } from 'node:crypto';
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

/** An attachment a message already carries (a discord.js Attachment has this shape). */
export interface ExistingAttachment {
  name: string;
  size: number;
}

/**
 * File names that identify their content: a content hash in the name (table-<hash>.png, every
 * GIF) or this build's fixed artwork (emerald-*.png). Only these are ever re-used by name, so a
 * re-used image can never show an older game state.
 */
function contentAddressed(name: string): boolean {
  return /[0-9a-f]{10,}/.test(name) || name.startsWith('emerald-');
}

/**
 * Whether an edit can leave the message's attachments as they are (upload nothing): the screen
 * shows no image, or every image it shows is already on the message (same content-addressed
 * name and byte size). Measured on real Discord: an edit that omits `attachments` keeps them and
 * `attachment://` resolves against them, while listing kept attachments by id makes Discord reject
 * the reference, so it is all or nothing. An image left unreferenced stays hidden on a Components
 * V2 message; that is what lets a return to a screen (Games after Rules) re-use its image.
 */
export function canKeepAttachments(screen: Screen, existing: Iterable<ExistingAttachment>): boolean {
  const wanted = screen.files ?? [];
  if (wanted.length === 0) return true;
  const have = new Map<string, number>();
  for (const a of existing) have.set(a.name, a.size);
  return wanted.every((f) => contentAddressed(f.name) && have.get(f.name) === f.data.length);
}

/** A fingerprint of what a screen shows (components and images), to skip edits that change nothing. */
export function screenDigest(screen: Screen): string {
  const hash = createHash('sha1').update(JSON.stringify(screen.components));
  for (const f of screen.files ?? []) hash.update(`\0${f.name}\0${f.data.length}`);
  return hash.digest('hex');
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
  invalidFormBody: 50035,
  threadArchived: 50083,
} as const;

export function discordErrorCode(error: unknown): number | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : null;
}
