import type { Logger } from '../core/logger.js';

/**
 * Test-mode outbound guard.
 *
 * While testing against a real server, the bot may only act inside ONE allowlisted text channel.
 * The guard enforces that at the lowest layer of the REST client — the function that performs
 * every HTTP request — so no code path (interaction handlers, panel updates, background jobs,
 * scripts) can send, edit, delete or create anything elsewhere. It also decides which incoming
 * interactions the bot may answer at all.
 *
 * Policy (default deny; a request must match one of these rules):
 *   /channels/{allowed}                    GET only (no channel edits)
 *   /channels/{allowed}/messages[/{id}]    GET, POST, PATCH; DELETE only for message IDs the
 *                                          session registered via allowDelete()
 *   /channels/{allowed}/typing             POST
 *   /interactions/{id}/{token}/callback    POST, only for interactions admitted by the guard
 *   /webhooks/{appId}/{token}/…            only for admitted interactions (replies, follow-ups)
 *   /applications/{appId}/guilds/{allowedGuild}/commands…   command registration for the guild
 *   /applications/…, /users/@me, /gateway… GET only
 *   /guilds/{allowedGuild}/…               GET only
 * Everything else (other channels, threads, DMs, reactions, pins, channel or server settings,
 * global commands, other guilds) is refused before it reaches the network.
 */
export interface OutboundAllowlist {
  guildId: string;
  channelId: string;
  applicationId: string;
}

export interface BlockedRequest {
  at: number;
  method: string;
  route: string;
  reason: string;
}

export interface AdmissionCandidate {
  id: string;
  token: string;
  guildId: string | null;
  channelId: string | null;
}

/** Interaction tokens are valid for 15 minutes. */
const INTERACTION_TTL_MS = 15 * 60_000;
const SNOWFLAKE = /^\d{15,22}$/;

export class OutboundBlockedError extends Error {
  readonly code = 'OUTBOUND_BLOCKED';
  constructor(
    readonly method: string,
    readonly route: string,
    readonly reason: string,
  ) {
    super(`Outbound Discord request blocked by test-mode allowlist: ${method} ${route} (${reason})`);
    this.name = 'OutboundBlockedError';
  }
}

export function isOutboundBlocked(error: unknown): error is OutboundBlockedError {
  return error instanceof OutboundBlockedError || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'OUTBOUND_BLOCKED');
}

/** Minimal shape of @discordjs/rest's REST manager that the guard hooks into. */
export interface GuardableRest {
  options: { makeRequest(url: string, init: { method?: string | undefined; body?: unknown }): Promise<unknown> };
}

export class OutboundGuard {
  /** interaction id → { token, expiresAt } for interactions the bot is allowed to answer. */
  private readonly admitted = new Map<string, { token: string; expiresAt: number }>();
  private readonly deletable = new Set<string>();
  readonly blocked: BlockedRequest[] = [];
  blockedCount = 0;
  allowedCount = 0;

  constructor(
    readonly allow: OutboundAllowlist,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {
    for (const [name, value] of Object.entries(allow)) {
      if (!SNOWFLAKE.test(value)) throw new Error(`OutboundGuard: ${name} must be a Discord ID`);
    }
  }

  /** Threads count as separate channels: they are never allowed in test mode. */
  get threadsAllowed(): boolean {
    return false;
  }

  /** True if a panel stored at this location can be updated under the allowlist. */
  allowsLocation(location: { channelId: string | null; threadId: string | null }): boolean {
    return location.threadId === null && location.channelId === this.allow.channelId;
  }

  /**
   * Gateway side: decide whether an incoming interaction may be handled. Interactions from other
   * servers, channels or threads get no response at all (any response would be an outgoing
   * action outside the allowlist); the refusal is logged locally.
   */
  admitInteraction(candidate: AdmissionCandidate): boolean {
    if (candidate.guildId !== this.allow.guildId || candidate.channelId !== this.allow.channelId) {
      this.logger.warn('test mode: ignored interaction outside the allowlisted channel', {
        guildId: candidate.guildId,
        channelId: candidate.channelId,
      });
      return false;
    }
    this.prune();
    this.admitted.set(candidate.id, { token: candidate.token, expiresAt: this.now() + INTERACTION_TTL_MS });
    return true;
  }

  /** Permit deleting one specific message (e.g. a test message this session created). */
  allowDelete(messageId: string): void {
    this.deletable.add(messageId);
  }

  /** Throws OutboundBlockedError unless the request is allowed. ody is the raw request body. */
  check(method: string | undefined, url: string, body?: unknown): void {
    const verb = (method ?? 'GET').toUpperCase();
    const route = routeOf(url);
    const reason = this.violation(verb, route) ?? mentionViolation(parseBody(body));
    if (reason === null) {
      this.allowedCount++;
      return;
    }
    this.blockedCount++;
    const entry = { at: this.now(), method: verb, route: redactRoute(route), reason };
    this.blocked.push(entry);
    if (this.blocked.length > 100) this.blocked.shift();
    this.logger.warn('test mode: blocked outbound Discord request', entry);
    throw new OutboundBlockedError(verb, entry.route, reason);
  }

  /** Hook into a REST manager so every HTTP request passes through check() first. */
  install(rest: GuardableRest): void {
    const original = rest.options.makeRequest.bind(rest.options);
    rest.options.makeRequest = async (url, init) => {
      this.check(init.method, url, (init as { body?: unknown }).body);
      return original(url, init);
    };
  }

  /** Returns null when allowed, otherwise the reason for refusing. */
  violation(method: string, route: string): string | null {
    const s = route.split('/').filter(Boolean).map(decodeSegment);
    const read = method === 'GET';
    switch (s[0]) {
      case 'channels': {
        if (s[1] !== this.allow.channelId) return 'channel is not allowlisted (threads count as separate channels)';
        if (s.length === 2) return read ? null : 'channel settings may not be changed';
        if (s[2] === 'typing' && s.length === 3) return method === 'POST' ? null : 'unsupported typing request';
        if (s[2] !== 'messages') return `only messages are allowed in the channel (not ${s[2]})`;
        if (s.length === 3) return read || method === 'POST' ? null : 'bulk message operations are not allowed';
        if (s[3] === 'bulk-delete') return 'bulk delete is not allowed';
        if (s.length === 4) {
          if (read || method === 'PATCH') return null;
          if (method === 'DELETE') return this.deletable.has(s[3]!) ? null : 'only messages created by this test session may be deleted';
          return 'unsupported message operation';
        }
        if (s[4] === 'threads') return 'thread creation is not allowed in test mode';
        return read ? null : `message ${s[4]} operations are not allowed (reactions, pins…)`;
      }
      case 'interactions': {
        const entry = s[1] ? this.admitted.get(s[1]) : undefined;
        if (!entry || entry.token !== s[2] || entry.expiresAt < this.now()) return 'interaction was not admitted by the allowlist';
        return s[3] === 'callback' && method === 'POST' ? null : 'unsupported interaction request';
      }
      case 'webhooks': {
        if (s[1] !== this.allow.applicationId) return 'only interaction webhooks of this application are allowed';
        const token = s[2];
        const ok = token !== undefined && [...this.admitted.values()].some((e) => e.token === token && e.expiresAt >= this.now());
        return ok ? null : 'interaction token was not admitted by the allowlist';
      }
      case 'applications': {
        if (s[1] !== this.allow.applicationId && s[1] !== '@me') return 'another application';
        if (s[2] === 'guilds' && s[3] === this.allow.guildId && s[4] === 'commands') return null;
        return read ? null : 'only commands for the allowlisted server may be changed';
      }
      case 'guilds':
        if (s[1] !== this.allow.guildId) return 'server is not allowlisted';
        return read ? null : 'server settings may not be changed';
      case 'users':
        if (!read) return 'opening DMs or changing users is not allowed';
        return s.length === 2 ? null : 'only user profiles may be read (no DM or server lists)';
      case 'gateway':
        return read ? null : 'unsupported gateway request';
      default:
        return `route /${s[0] ?? ''} is not allowlisted`;
    }
  }

  private prune(): void {
    const now = this.now();
    for (const [id, entry] of this.admitted) if (entry.expiresAt < now) this.admitted.delete(id);
  }
}

/** "/channels/1/messages" from "https://discord.com/api/v10/channels/1/messages?x=1". */
export function routeOf(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split('?')[0] ?? url;
  }
  return path.replace(/^\/api(\/v\d+)?/, '') || '/';
}

/** JSON bodies are strings; bodies with files are FormData carrying a payload_json part. */
function parseBody(body: unknown): unknown {
  try {
    if (typeof body === 'string') return JSON.parse(body);
    if (body && typeof (body as { get?: unknown }).get === 'function') {
      const part = (body as { get(name: string): unknown }).get('payload_json');
      return typeof part === 'string' ? JSON.parse(part) : undefined;
    }
  } catch {
    // Not JSON: nothing to inspect.
  }
  return undefined;
}

/**
 * No pings in test mode: a message may only mention people when allowed_mentions explicitly
 * allows nothing (mentions then render as names without notifying anyone).
 */
export function mentionViolation(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { type?: unknown; data?: unknown };
  const payload = (typeof b.type === 'number' && b.data && typeof b.data === 'object' ? b.data : body) as {
    allowed_mentions?: { parse?: unknown[]; users?: unknown[]; roles?: unknown[]; replied_user?: boolean };
    content?: unknown;
    components?: unknown;
  };
  const allowed = payload.allowed_mentions;
  if (allowed) {
    if (allowed.parse?.length || allowed.users?.length || allowed.roles?.length || allowed.replied_user) return 'pings are not allowed in test mode';
    return null;
  }
  const visible = `${typeof payload.content === 'string' ? payload.content : ''}${JSON.stringify(payload.components ?? '')}`;
  return /<@[!&]?\d+>|@everyone|@here/.test(visible) ? 'message mentions someone without allowed_mentions (it would ping)' : null;
}

/** The REST client percent-encodes route parameters; compare the decoded values. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Interaction tokens are credentials: never write them to logs. */
function redactRoute(route: string): string {
  return route.replace(/^(\/interactions\/\d+\/)[^/]+/, '$1[token]').replace(/^(\/webhooks\/\d+\/)[^/]+/, '$1[token]');
}

/** Read the test-mode allowlist from the environment (fail closed when test mode is on). */
export function allowlistFromEnv(env: NodeJS.ProcessEnv, applicationId: string): OutboundAllowlist | null {
  if (env.CASINO_TEST_MODE !== 'true') return null;
  const guildId = (env.CASINO_TEST_GUILD_ID ?? '').trim();
  const channelId = (env.CASINO_TEST_CHANNEL_ID ?? '').trim();
  if (!SNOWFLAKE.test(guildId) || !SNOWFLAKE.test(channelId)) {
    throw new Error('CASINO_TEST_MODE=true requires CASINO_TEST_GUILD_ID and CASINO_TEST_CHANNEL_ID (run npm run test:allowlist)');
  }
  return { guildId, channelId, applicationId };
}
