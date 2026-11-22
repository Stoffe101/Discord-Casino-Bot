import type { ButtonInteraction, Client, MessageComponentInteraction, ModalSubmitInteraction } from 'discord.js';
import type { Logger } from '../core/logger.js';
import type { Screen } from '../ui/kit.js';
import { DISCORD_ERRORS, discordErrorCode, editOptions, primaryFileName } from './payload.js';
import { isOutboundBlocked } from './outbound-guard.js';

/** An interaction on the panel message itself, which we may answer by updating that message. */
export type Carrier = MessageComponentInteraction | ModalSubmitInteraction | ButtonInteraction;

export interface PanelLocation {
  channelId: string | null;
  threadId: string | null;
  messageId: string | null;
}

export interface PanelSyncOptions<Hint> {
  name: string;
  client: Client;
  logger: Logger;
  locate(key: string): PanelLocation | undefined;
  /** Render the panel. `frame` is an intermediate animation frame (undefined = final state). */
  render(key: string, frame: number | undefined, hint: Hint | undefined): Promise<Screen | null>;
  /** Number of animation frames to show before the final render for this hint. */
  frames?(key: string, hint: Hint | undefined): number;
  /** Pause after each animation frame (may depend on what is being animated). */
  frameDelayMs?: number | ((hint: Hint | undefined) => number);
  /** Multiplier for a frame's own `holdMs` (animated GIFs); 0 in fast tests. */
  holdScale?: number;
  /** Minimum time between two edits of the same message. */
  minIntervalMs?: number;
  /** Called when the panel message or its channel no longer exists. */
  onMissing(key: string): Promise<void>;
}

interface Slot<Hint> {
  running: boolean;
  pending: { hint: Hint | undefined; carriers: Carrier[] } | null;
  lastFile: string | null;
  lastSentAt: number;
}

const ACK_SAFETY_MS = 2_200;
/** Every animation frame stays on screen at least this long, however slow the send was. */
export const MIN_FRAME_HOLD_MS = 180;
const CARRIER_MAX_AGE_MS = 2_500;

/**
 * Per-panel render queue. Requests coalesce: while one render is being sent, newer requests
 * collapse into a single follow-up render of the LATEST state, so a slow edit can never
 * overwrite a newer one. If the request came from a click on the panel itself, the click is
 * answered by updating the message directly (one API call instead of two).
 */
export class PanelSync<Hint = unknown> {
  private readonly slots = new Map<string, Slot<Hint>>();
  stats = { renders: 0, viaInteraction: 0, viaRest: 0, reusedImage: 0, failures: 0 };

  constructor(private readonly options: PanelSyncOptions<Hint>) {}

  request(key: string, hint?: Hint, carrier?: Carrier): void {
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { running: false, pending: null, lastFile: null, lastSentAt: 0 };
      this.slots.set(key, slot);
    }
    if (!slot.pending) slot.pending = { hint, carriers: [] };
    else if (hint !== undefined && (slot.pending.hint === undefined || this.options.frames?.(key, hint))) slot.pending.hint = hint;
    if (carrier) {
      slot.pending.carriers.push(carrier);
      this.armSafetyAck(carrier);
    }
    if (!slot.running) void this.run(key, slot);
  }

  forget(key: string): void {
    this.slots.delete(key);
  }

  async idle(): Promise<void> {
    for (let i = 0; i < 200 && [...this.slots.values()].some((s) => s.running || s.pending); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  private armSafetyAck(carrier: Carrier): void {
    const wait = Math.max(0, ACK_SAFETY_MS - (Date.now() - carrier.createdTimestamp));
    setTimeout(() => {
      if (!carrier.deferred && !carrier.replied) carrier.deferUpdate().catch(() => undefined);
    }, wait).unref?.();
  }

  private async run(key: string, slot: Slot<Hint>): Promise<void> {
    slot.running = true;
    try {
      while (slot.pending) {
        const job = slot.pending;
        slot.pending = null;
        let carriers = job.carriers;
        const frames = this.options.frames?.(key, job.hint) ?? 0;
        const delay = typeof this.options.frameDelayMs === 'function' ? this.options.frameDelayMs(job.hint) : (this.options.frameDelayMs ?? 900);
        for (let frame = 0; frame < frames; frame++) {
          // Pace by cadence: the time Discord took to show this frame counts towards its slot, so
          // a slow connection doesn't stretch the animation (a short minimum hold keeps it readable).
          const shown = Date.now();
          const hold = await this.renderAndSend(key, slot, frame, carriers, job.hint);
          carriers = [];
          // An animated frame stays up for its own length; a still frame for the cadence.
          const target = hold !== undefined ? hold * (this.options.holdScale ?? 1) : delay;
          await sleep(Math.max(target > 0 ? MIN_FRAME_HOLD_MS : 0, target - (Date.now() - shown)));
        }
        await this.renderAndSend(key, slot, undefined, carriers, job.hint);
      }
    } catch (error) {
      this.options.logger.error(`${this.options.name} render loop failed`, { key, error });
    } finally {
      slot.running = false;
      if (slot.pending) void this.run(key, slot);
    }
  }

  /** Returns the rendered frame's own hold time (animated frames), if any. */
  private async renderAndSend(key: string, slot: Slot<Hint>, frame: number | undefined, carriers: Carrier[], hint?: Hint): Promise<number | undefined> {
    const spacing = (this.options.minIntervalMs ?? 300) - (Date.now() - slot.lastSentAt);
    if (spacing > 0 && carriers.length === 0 && frame === undefined) await sleep(spacing);
    let screen: Screen | null = null;
    try {
      screen = await this.options.render(key, frame, hint);
    } catch (error) {
      this.options.logger.error(`${this.options.name} render failed`, { key, error });
    }
    const fresh = carriers.filter((c) => !c.deferred && !c.replied && Date.now() - c.createdTimestamp < CARRIER_MAX_AGE_MS);
    const chosen = screen ? fresh.at(-1) : undefined;
    for (const c of carriers) {
      if (c !== chosen && !c.deferred && !c.replied) await c.deferUpdate().catch(() => undefined);
    }
    if (!screen) return undefined;
    const file = primaryFileName(screen);
    const reuse = file !== null && file === slot.lastFile;
    if (reuse) this.stats.reusedImage++;
    this.stats.renders++;
    if (chosen && 'update' in chosen) {
      try {
        await chosen.update(editOptions(screen, reuse));
        this.stats.viaInteraction++;
        slot.lastFile = file;
        slot.lastSentAt = Date.now();
        return screen.holdMs;
      } catch (error) {
        const code = discordErrorCode(error);
        if (code !== DISCORD_ERRORS.unknownInteraction && code !== DISCORD_ERRORS.alreadyAcknowledged) {
          this.options.logger.warn(`${this.options.name} interaction update failed; falling back`, { key, code, error });
        }
      }
    }
    await this.editViaRest(key, slot, screen, reuse, file);
    return screen.holdMs;
  }

  private async editViaRest(key: string, slot: Slot<Hint>, screen: Screen, reuse: boolean, file: string | null): Promise<void> {
    const location = this.options.locate(key);
    const channelId = location?.threadId ?? location?.channelId;
    if (!location || !channelId || !location.messageId) return;
    try {
      const channel = await this.options.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) throw Object.assign(new Error('channel missing'), { code: DISCORD_ERRORS.unknownChannel });
      if (channel.isThread() && channel.archived) await channel.setArchived(false).catch(() => undefined);
      await channel.messages.edit(location.messageId, editOptions(screen, reuse));
      this.stats.viaRest++;
      slot.lastFile = file;
      slot.lastSentAt = Date.now();
    } catch (error) {
      this.stats.failures++;
      const code = discordErrorCode(error);
      // A panel the test-mode allowlist can't reach (e.g. in a thread) is treated like a missing one:
      // it gets recreated somewhere allowed.
      if (code === DISCORD_ERRORS.unknownMessage || code === DISCORD_ERRORS.unknownChannel || isOutboundBlocked(error)) {
        slot.lastFile = null;
        this.options.logger.warn(`${this.options.name} message missing or not allowed; recreating`, { key, code });
        await this.options.onMissing(key).catch((e: unknown) => this.options.logger.error(`${this.options.name} recreate failed`, { key, error: e }));
      } else if (reuse) {
        // The cached image may be gone (e.g. edited elsewhere): retry once with a fresh upload.
        slot.lastFile = null;
        await this.editViaRest(key, slot, screen, false, file).catch(() => undefined);
      } else {
        this.options.logger.warn(`${this.options.name} edit failed`, { key, code, error });
      }
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
