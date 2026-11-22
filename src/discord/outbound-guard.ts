import type { Logger } from '../core/logger.js';

/**
 * Test-mode outbound guard.
 *
 * While testing against a real server, the bot may only act inside ONE allowlisted text channel
 * and — when explicitly enabled — inside threads whose parent is that channel. The guard enforces
 * that at the lowest layer of the REST client (the function that performs every HTTP request), so
 * no code path — interaction handlers, panel updates, background jobs, scripts — can send, edit,
 * delete or create anything elsewhere. It also decides which incoming interactions the bot may
 * answer at all.
 *
 * Thread verification: a thread counts as allowed only after its parent and server have been
 * confirmed from Discord's own data — the response to the bot creating it, a channel lookup
 * (`GET /channels/{id}`), the gateway cache, or the interaction payload. Unknown ids are refused.
 *
 * Policy (default deny; a request must match one of these rules):
 *   /channels/{allowed}                       GET only (no channel edits)
 *   /channels/{allowed}/messages[/{id}]       GET, POST, PATCH; DELETE only for ids registered via allowDelete()
 *   /channels/{allowed}/typing                POST
 *   /channels/{allowed}/threads               POST (threads enabled; public/private threads only)
 *   /channels/{thread}                        GET; PATCH limited to archived / locked / auto-archive
 *   /channels/{thread}/messages[/{id}]        as for the allowed channel
 *   /channels/{thread}/thread-members/{user}  GET, PUT (private table seats)
 *   /channels/{any}                           GET only — channel lookup, used to verify thread parents
 *   /interactions/{id}/{token}/callback       POST, only for interactions admitted by the guard
 *   /webhooks/{appId}/{token}/…               only for admitted interactions (replies, follow-ups)
 *   /applications/{appId}/guilds/{allowedGuild}/commands…   command registration for the guild
 *   /applications/…, /users/{id}, /gateway…   GET only
 *   /guilds/{allowedGuild}/…                  GET only
 * Everything else (other channels and their threads, DMs, reactions, pins, deleting threads,
 * channel or server settings, global commands, other servers) is refused before it reaches the
 * network, as is any payload that could ping someone.
 */
export interface OutboundAllowlist {
  guildId: string;
  channelId: string;
  applicationId: string;
  /** Also allow threads whose parent is `channelId` (explicit opt-in). */
  allowThreads?: boolean;
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
  /** For interactions inside a thread: the thread's parent channel. */
  parentId?: string | null;
}

export interface ThreadFacts {
  id: string;
  parentId: string | null | undefined;
  guildId: string | null | undefined;
}

/** Interaction tokens are valid for 15 minutes. */
const INTERACTION_TTL_MS = 15 * 60_000;
const SNOWFLAKE = /^\d{15,22}$/;
const THREAD_TYPES = new Set([11, 12]); // public and private threads (not announcement threads)
const THREAD_PATCH_KEYS = new Set(['archived', 'locked', 'auto_archive_duration']);

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

/** The subset of @discordjs/rest's ResponseLike the guard reads (no clone() in Node's transport). */
interface ResponseLikeBody {
  ok?: boolean;
  status?: number;
  statusText?: string;
  headers?: Headers;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}

/** Minimal shape of @discordjs/rest's REST manager that the guard hooks into. */
export interface GuardableRest {
  options: { makeRequest(url: string, init: { method?: string | undefined; body?: unknown }): Promise<unknown> };
}

export class OutboundGuard {
  /** interaction id → { token, expiresAt } for interactions the bot is allowed to answer. */
  private readonly admitted = new Map<string, { token: string; expiresAt: number }>();
  private readonly deletable = new Set<string>();
  /** Threads verified to be children of the allowlisted channel in the allowlisted server. */
  private readonly threads = new Set<string>();
  readonly blocked: BlockedRequest[] = [];
  blockedCount = 0;
  allowedCount = 0;

  constructor(
    readonly allow: OutboundAllowlist,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {
    for (const name of ['guildId', 'channelId', 'applicationId'] as const) {
      if (!SNOWFLAKE.test(allow[name])) throw new Error(`OutboundGuard: ${name} must be a Discord ID`);
    }
  }

  get threadsAllowed(): boolean {
    return this.allow.allowThreads === true;
  }

  /** Threads verified so far (for diagnostics and tests). */
  get knownThreads(): ReadonlySet<string> {
    return this.threads;
  }

  /**
   * Record a thread if — and only if — it is a child of the allowlisted channel in the
   * allowlisted server. Returns whether the thread is allowed.
   */
  learnThread(thread: ThreadFacts): boolean {
    if (!this.threadsAllowed) return false;
    if (thread.parentId === this.allow.channelId && thread.guildId === this.allow.guildId && SNOWFLAKE.test(thread.id)) {
      this.threads.add(thread.id);
      return true;
    }
    return this.threads.has(thread.id);
  }

  /** True if a panel stored at this location can be updated under the allowlist. */
  allowsLocation(location: { channelId: string | null; threadId: string | null }): boolean {
    if (location.threadId === null) return location.channelId === this.allow.channelId;
    return this.threadsAllowed && this.threads.has(location.threadId);
  }

  /**
   * Gateway side: decide whether an incoming interaction may be handled. Interactions from other
   * servers, channels or unrelated threads get no response at all (any response would be an
   * outgoing action outside the allowlist); the refusal is logged locally.
   */
  admitInteraction(candidate: AdmissionCandidate): boolean {
    const inGuild = candidate.guildId === this.allow.guildId;
    const inChannel = candidate.channelId === this.allow.channelId;
    const inThread =
      this.threadsAllowed &&
      candidate.channelId !== null &&
      (this.threads.has(candidate.channelId) || this.learnThread({ id: candidate.channelId, parentId: candidate.parentId ?? null, guildId: candidate.guildId }));
    if (!inGuild || !(inChannel || inThread)) {
      this.logger.warn('test mode: ignored interaction outside the allowlist', { guildId: candidate.guildId, channelId: candidate.channelId, parentId: candidate.parentId ?? null });
      return false;
    }
    this.prune();
    this.admitted.set(candidate.id, { token: candidate.token, expiresAt: this.now() + INTERACTION_TTL_MS });
    return true;
  }

  /** Permit deleting one specific message (e.g. a message this session created). */
  allowDelete(messageId: string): void {
    this.deletable.add(messageId);
  }

  /** Throws OutboundBlockedError unless the request is allowed. `body` is the raw request body. */
  check(method: string | undefined, url: string, body?: unknown): void {
    const verb = (method ?? 'GET').toUpperCase();
    const route = routeOf(url);
    const parsed = parseBody(body);
    const reason = this.violation(verb, route, parsed) ?? mentionViolation(parsed);
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
      const response = await original(url, init);
      return this.observe((init.method ?? 'GET').toUpperCase(), routeOf(url), response as ResponseLikeBody);
    };
  }

  /**
   * Learn threads from Discord's answers: thread creation and channel lookups. The body can only be
   * read once, so for those two routes it is buffered and an equivalent response is handed back.
   */
  private async observe(method: string, route: string, response: ResponseLikeBody): Promise<unknown> {
    if (!this.threadsAllowed || !response?.ok || typeof response.arrayBuffer !== 'function') return response;
    const s = route.split('/').filter(Boolean).map(decodeSegment);
    const lookup = method === 'GET' && s[0] === 'channels' && s.length === 2;
    const created = method === 'POST' && s[0] === 'channels' && (s[2] === 'threads' || s[4] === 'threads');
    if (!lookup && !created) return response;
    const buffer = await response.arrayBuffer();
    const replay = new Response(buffer, { status: response.status ?? 200, statusText: response.statusText ?? '', headers: response.headers ?? {} });
    try {
      const data = JSON.parse(Buffer.from(buffer).toString('utf8')) as { id?: unknown; type?: unknown; parent_id?: unknown; guild_id?: unknown };
      if (typeof data.id === 'string' && typeof data.type === 'number' && THREAD_TYPES.has(data.type)) {
        this.learnThread({ id: data.id, parentId: typeof data.parent_id === 'string' ? data.parent_id : null, guildId: typeof data.guild_id === 'string' ? data.guild_id : null });
      }
    } catch {
      // Not JSON — nothing to learn.
    }
    return replay;
  }

  /** Returns null when allowed, otherwise the reason for refusing. */
  violation(method: string, route: string, body?: unknown): string | null {
    const s = route.split('/').filter(Boolean).map(decodeSegment);
    const read = method === 'GET';
    switch (s[0]) {
      case 'channels':
        return this.channelViolation(method, s, body);
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

  private channelViolation(method: string, s: string[], body: unknown): string | null {
    const read = method === 'GET';
    const id = s[1] ?? '';
    const isMain = id === this.allow.channelId;
    const isThread = !isMain && this.threadsAllowed && this.threads.has(id);
    if (!isMain && !isThread) {
      // Looking up a channel's metadata is how thread parents get verified; nothing else is allowed.
      if (read && s.length === 2 && this.threadsAllowed) return null;
      return this.threadsAllowed
        ? 'channel is not allowlisted (only #casino and threads verified to be its children)'
        : 'channel is not allowlisted (threads count as separate channels)';
    }
    if (s.length === 2) {
      if (read) return null;
      if (isMain) return 'channel settings may not be changed';
      if (method !== 'PATCH') return 'threads may not be deleted';
      const keys = body && typeof body === 'object' ? Object.keys(body) : [];
      const extra = keys.filter((k) => !THREAD_PATCH_KEYS.has(k));
      return extra.length ? `only archiving or locking a thread is allowed (not ${extra.join(', ')})` : null;
    }
    if (s[2] === 'threads') {
      if (!isMain || s.length !== 3) return 'thread creation is only allowed under the allowlisted channel';
      if (!this.threadsAllowed) return 'thread creation is not allowed in test mode';
      if (method !== 'POST') return 'unsupported thread request';
      const type = (body as { type?: unknown } | undefined)?.type;
      return type === undefined || (typeof type === 'number' && THREAD_TYPES.has(type)) ? null : 'only public or private threads may be created';
    }
    if (s[2] === 'thread-members') {
      if (!isThread) return 'thread membership is only allowed in verified threads';
      return read || method === 'PUT' ? null : 'only adding members to a thread is allowed';
    }
    if (s[2] === 'typing' && s.length === 3) return method === 'POST' ? null : 'unsupported typing request';
    if (s[2] !== 'messages') return `only messages are allowed in the channel (not ${s[2]})`;
    if (s.length === 3) return read || method === 'POST' ? null : 'bulk message operations are not allowed';
    if (s[3] === 'bulk-delete') return 'bulk delete is not allowed';
    if (s.length === 4) {
      if (read || method === 'PATCH') return null;
      if (method === 'DELETE') return this.deletable.has(s[3]!) ? null : 'only messages created by this test session may be deleted';
      return 'unsupported message operation';
    }
    if (s[4] === 'threads') {
      if (!isMain || !this.threadsAllowed) return 'thread creation is not allowed in test mode';
      return method === 'POST' ? null : 'unsupported thread request';
    }
    return read ? null : `message ${s[4]} operations are not allowed (reactions, pins…)`;
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
  return { guildId, channelId, applicationId, allowThreads: env.CASINO_TEST_ALLOW_THREADS === 'true' };
}
