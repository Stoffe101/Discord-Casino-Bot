/**
 * An in-memory Discord for integration tests.
 *
 * The real discord.js Client runs unchanged; only its HTTP layer (`makeRequest`) is pointed at
 * this class, and interactions are injected as raw gateway payloads through discord.js's own
 * InteractionCreate action. So every test exercises production code end to end: bot adapter,
 * outbound guard, router, panel sync, discord.js serialization and (simulated) Discord
 * validation. Nothing here touches the network.
 *
 * Realism that matters for bugs:
 *  - interactions must be acknowledged within 3 s and only once (Unknown interaction / already
 *    acknowledged errors otherwise), follow-ups need an acknowledged token;
 *  - disabled buttons can't be clicked, ephemeral messages are only visible to their owner,
 *    modal fields are validated (required / length) before submit;
 *  - message payloads are validated like Discord does (Components V2 limits, unique custom ids,
 *    attachment:// references must resolve to an attachment of the resulting message), and an
 *    invalid payload is rejected with 50035 instead of being stored.
 */
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ClientUser, type Client } from 'discord.js';

const EPOCH = 1420070400000n;
let seq = 0n;
export function snowflake(at = Date.now()): string {
  seq = (seq + 1n) & 0xfffn;
  return (((BigInt(at) - EPOCH) << 22n) | (BigInt(process.pid & 0x3ff) << 12n) | seq).toString();
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface FakeUser {
  id: string;
  name: string;
  admin: boolean;
}

export interface FakeAttachment {
  id: string;
  filename: string;
  size: number;
}

export interface FakeMessage {
  id: string;
  channelId: string;
  guildId: string;
  flags: number;
  content: string;
  components: Json[];
  attachments: FakeAttachment[];
  /** Ephemeral messages are only visible to this user. */
  forUser: string | null;
  edits: number;
  deleted: boolean;
  /** True while a deferred reply is still "thinking". */
  loading: boolean;
  /** Message type (0 default, 18 = "started a thread" system notice). */
  type: number;
  /** For thread notices: the thread they point at. */
  referenceChannelId: string | null;
}

export interface FakeChannel {
  id: string;
  guildId: string;
  name: string;
  type: 0 | 11 | 12;
  parentId: string | null;
  archived: boolean;
  locked: boolean;
}

export interface InteractionRecord {
  id: string;
  token: string;
  kind: 'command' | 'button' | 'select' | 'modal' | 'usermenu';
  userId: string;
  channelId: string;
  customId: string | null;
  createdAt: number;
  ackedAt: number | null;
  /** Interaction callback types in order (4 reply, 5 deferReply, 6 deferUpdate, 7 update, 9 modal). */
  callbacks: number[];
  /** The message a component/modal came from. */
  source: FakeMessage | null;
  /** The interaction's own response message (reply, deferred reply, or the updated source). */
  original: FakeMessage | null;
  followUps: FakeMessage[];
  modal: Json | null;
  /** Errors Discord returned for this interaction's requests. */
  errors: string[];
}

export interface RequestLog {
  method: string;
  route: string;
  status: number;
  ms: number;
  /** Wall-clock time the request finished. */
  at: number;
}

interface Result {
  status: number;
  body?: Json;
}

const ACK_DEADLINE_MS = 3_000;
const TOKEN_TTL_MS = 15 * 60_000;
const V2 = 1 << 15;
const EPHEMERAL = 1 << 6;

const err = (status: number, code: number, message: string, errors?: Json): Result => ({ status, body: { code, message, ...(errors ? { errors } : {}) } });

export class FakeDiscord {
  readonly appId = snowflake();
  readonly botUser = { id: this.appId, username: 'Emerald Room', discriminator: '0000', global_name: null, avatar: null, bot: true };
  readonly guilds = new Map<string, { id: string; name: string }>();
  readonly channels = new Map<string, FakeChannel>();
  readonly messages = new Map<string, FakeMessage>();
  readonly users = new Map<string, FakeUser>();
  readonly interactions = new Map<string, InteractionRecord>();
  readonly log: RequestLog[] = [];
  /** Payloads Discord would have rejected (also returned to the bot as 50035 errors). */
  readonly problems: string[] = [];
  /** Artificial network latency per request. */
  latencyMs = 0;
  /** Fault injection: return an error result for matching requests. */
  fault: ((method: string, route: string) => Result | null) | null = null;
  private client: Client | null = null;

  // ───────────────────────────── world building ─────────────────────────────

  addGuild(name: string): string {
    const id = snowflake();
    this.guilds.set(id, { id, name });
    return id;
  }

  addChannel(guildId: string, name: string): string {
    const id = snowflake();
    this.channels.set(id, { id, guildId, name, type: 0, parentId: null, archived: false, locked: false });
    return id;
  }

  /** A thread someone else created (e.g. a member) under a channel. */
  addThread(parentId: string, name: string, type: 11 | 12 = 11): string {
    const parent = this.channels.get(parentId)!;
    const id = snowflake();
    this.channels.set(id, { id, guildId: parent.guildId, name, type, parentId, archived: false, locked: false });
    return id;
  }

  user(name: string, options: { admin?: boolean } = {}): FakeUser {
    const u = { id: snowflake(), name, admin: options.admin ?? false };
    this.users.set(u.id, u);
    return u;
  }

  /** Point a (not logged in) discord.js client at this fake: bot user, guild and channel caches. */
  attach(client: Client): void {
    this.client = client;
    client.rest.setToken('fake-token-for-tests');
    const UserCtor = ClientUser as unknown as new (c: Client, data: unknown) => ClientUser;
    (client as unknown as { user: ClientUser }).user = new UserCtor(client, this.botUser);
    for (const g of this.guilds.values()) (client.guilds as unknown as { _add(d: Json): unknown })._add(this.guildJson(g.id));
  }

  // ───────────────────────────── HTTP ─────────────────────────────

  readonly makeRequest = async (url: string, init: { method?: string | undefined; body?: unknown }): Promise<Response> => {
    const started = performance.now();
    const u = new URL(url);
    const route = u.pathname.replace(/^\/api(\/v\d+)?/, '');
    const method = (init.method ?? 'GET').toUpperCase();
    const { json, files } = await readBody(init.body);
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    let result: Result;
    try {
      result = this.fault?.(method, route) ?? this.route(method, route, u.searchParams, json, files);
    } catch (e) {
      result = err(500, 0, e instanceof Error ? e.message : String(e));
    }
    this.log.push({ method, route: route.replace(/\/[A-Za-z0-9_-]{40,}/g, '/[token]'), status: result.status, ms: performance.now() - started, at: Date.now() });
    return undiciLikeResponse(result.status, result.body);
  };

  private route(method: string, route: string, query: URLSearchParams, json: Json, files: FakeFile[]): Result {
    const s = route.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    if (s[0] === 'interactions' && s[3] === 'callback' && method === 'POST') return this.callback(s[2]!, json, files, query.get('with_response') === 'true');
    if (s[0] === 'webhooks') return this.webhook(method, s[2]!, s.slice(3), json, files);
    if (s[0] === 'channels') return this.channelRoute(method, s.slice(1), json, files);
    if (s[0] === 'guilds' && s[2] === 'members' && method === 'GET') {
      const user = this.users.get(s[3]!);
      return user ? { status: 200, body: this.memberJson(user) } : err(404, 10007, 'Unknown Member');
    }
    if (s[0] === 'users' && method === 'GET') {
      const user = this.users.get(s[1]!);
      return user ? { status: 200, body: this.userJson(user) } : err(404, 10013, 'Unknown User');
    }
    this.problems.push(`unhandled route ${method} ${route}`);
    return err(404, 0, `fake discord: unhandled route ${method} ${route}`);
  }

  private callback(token: string, json: Json, files: FakeFile[], withResponse: boolean): Result {
    const rec = this.interactions.get(token);
    if (!rec) return err(404, 10062, 'Unknown interaction');
    if (rec.ackedAt !== null) return this.fail(rec, err(400, 40060, 'Interaction has already been acknowledged.'));
    if (Date.now() - rec.createdAt > ACK_DEADLINE_MS) return this.fail(rec, err(404, 10062, 'Unknown interaction'));
    const data = json?.data ?? {};
    let message: FakeMessage | null = null;
    switch (json?.type) {
      case 4: {
        const ephemeral = ((data.flags ?? 0) & EPHEMERAL) !== 0;
        const made = this.create(rec.channelId, data, files, ephemeral ? rec.userId : null);
        if ('status' in made) return this.fail(rec, made);
        message = made;
        break;
      }
      case 5:
        message = this.blank(rec.channelId, (data.flags ?? 0) & EPHEMERAL ? rec.userId : null, data.flags ?? 0);
        message.loading = true;
        break;
      case 6:
        if (!rec.source) return this.fail(rec, err(400, 50035, 'deferUpdate on an interaction without a message'));
        message = rec.source;
        break;
      case 7: {
        if (!rec.source) return this.fail(rec, err(400, 50035, 'update on an interaction without a message'));
        const edited = this.edit(rec.source, data, files);
        if (edited) return this.fail(rec, edited);
        message = rec.source;
        break;
      }
      case 9:
        if (rec.kind === 'modal') return this.fail(rec, err(400, 50035, 'a modal cannot open another modal'));
        rec.modal = data;
        break;
      default:
        return this.fail(rec, err(400, 50035, `unsupported callback type ${json?.type}`));
    }
    rec.ackedAt = Date.now();
    rec.callbacks.push(json.type);
    if (message) rec.original = message;
    if (!withResponse) return { status: 204 };
    return {
      status: 200,
      body: {
        interaction: { id: rec.id, type: rec.kind === 'command' || rec.kind === 'usermenu' ? 2 : rec.kind === 'modal' ? 5 : 3, response_message_id: message?.id, response_message_loading: json.type === 5, response_message_ephemeral: message ? message.forUser !== null : false },
        resource: { type: json.type, ...(message ? { message: this.messageJson(message) } : {}) },
      },
    };
  }

  private webhook(method: string, token: string, rest: string[], json: Json, files: FakeFile[]): Result {
    const rec = this.interactions.get(token);
    if (!rec || Date.now() - rec.createdAt > TOKEN_TTL_MS) return err(404, 10015, 'Unknown Webhook');
    if (rec.ackedAt === null) return this.fail(rec, err(404, 10015, 'Unknown Webhook (interaction not acknowledged yet)'));
    if (rest.length === 0 && method === 'POST') {
      const ephemeral = ((json?.flags ?? 0) & EPHEMERAL) !== 0;
      const made = this.create(rec.channelId, json ?? {}, files, ephemeral ? rec.userId : null);
      if ('status' in made) return this.fail(rec, made);
      rec.followUps.push(made);
      return { status: 200, body: this.messageJson(made) };
    }
    if (rest[0] !== 'messages' || !rest[1]) return err(404, 0, 'unhandled webhook route');
    const target = rest[1] === '@original' ? rec.original : (rec.followUps.find((m) => m.id === rest[1]) ?? null);
    if (!target || target.deleted) return this.fail(rec, err(404, 10008, 'Unknown Message'));
    if (method === 'GET') return { status: 200, body: this.messageJson(target) };
    if (method === 'DELETE') {
      target.deleted = true;
      return { status: 204 };
    }
    if (method === 'PATCH') {
      const edited = this.edit(target, json ?? {}, files);
      if (edited) return this.fail(rec, edited);
      target.loading = false;
      return { status: 200, body: this.messageJson(target) };
    }
    return err(405, 0, 'method not allowed');
  }

  private channelRoute(method: string, s: string[], json: Json, files: FakeFile[]): Result {
    const channel = this.channels.get(s[0]!);
    if (!channel) return err(404, 10003, 'Unknown Channel');
    if (s.length === 1) {
      if (method === 'GET') return { status: 200, body: this.channelJson(channel) };
      if (method === 'PATCH') {
        if (typeof json?.archived === 'boolean') channel.archived = json.archived;
        if (typeof json?.locked === 'boolean') channel.locked = json.locked;
        return { status: 200, body: this.channelJson(channel) };
      }
    }
    if (s[1] === 'threads' && method === 'POST') {
      const id = snowflake();
      const thread: FakeChannel = { id, guildId: channel.guildId, name: json?.name ?? 'thread', type: json?.type === 12 ? 12 : 11, parentId: channel.id, archived: false, locked: false };
      this.channels.set(id, thread);
      // Like Discord: a public thread created without a starter message posts a notice in the parent.
      if (thread.type === 11) {
        const notice = this.blank(channel.id, null, 0);
        notice.type = 18;
        notice.content = thread.name;
        notice.referenceChannelId = id;
      }
      return { status: 201, body: this.channelJson(thread) };
    }
    if (s[1] === 'thread-members' && method === 'PUT') return { status: 204 };
    if (s[1] === 'messages') {
      if (s.length === 2 && method === 'GET') {
        const list = [...this.messages.values()].filter((m) => m.channelId === channel.id && !m.forUser && !m.deleted).reverse().slice(0, 50);
        return { status: 200, body: list.map((m) => this.messageJson(m)) };
      }
      if (s.length === 2 && method === 'POST') {
        if (channel.archived && channel.type !== 0) return err(400, 50083, 'Thread is archived');
        if (((json?.flags ?? 0) & EPHEMERAL) !== 0) return err(400, 50035, 'Channel messages cannot be ephemeral');
        const made = this.create(channel.id, json ?? {}, files, null);
        return 'status' in made ? made : { status: 200, body: this.messageJson(made) };
      }
      const message = this.messages.get(s[2] ?? '');
      if (!message || message.deleted || message.channelId !== channel.id || message.forUser) return err(404, 10008, 'Unknown Message');
      if (method === 'GET') return { status: 200, body: this.messageJson(message) };
      if (method === 'DELETE') {
        message.deleted = true;
        return { status: 204 };
      }
      if (method === 'PATCH') {
        const edited = this.edit(message, json ?? {}, files);
        return edited ?? { status: 200, body: this.messageJson(message) };
      }
    }
    this.problems.push(`unhandled channel route ${method} /channels/${s.join('/')}`);
    return err(404, 0, 'unhandled channel route');
  }

  private fail(rec: InteractionRecord, result: Result): Result {
    rec.errors.push(`${result.status} ${result.body?.code}: ${result.body?.message}`);
    return result;
  }

  // ───────────────────────────── messages ─────────────────────────────

  private blank(channelId: string, forUser: string | null, flags: number): FakeMessage {
    const channel = this.channels.get(channelId)!;
    const m: FakeMessage = { id: snowflake(), channelId, guildId: channel.guildId, flags, content: '', components: [], attachments: [], forUser, edits: 0, deleted: false, loading: false, type: 0, referenceChannelId: null };
    this.messages.set(m.id, m);
    return m;
  }

  private create(channelId: string, payload: Json, files: FakeFile[], forUser: string | null): FakeMessage | Result {
    const draft = {
      flags: payload.flags ?? 0,
      content: payload.content ?? '',
      components: payload.components ?? [],
      attachments: files.map((f) => ({ id: snowflake(), filename: f.name, size: f.size })),
    };
    const problems = validateMessage(draft, payload);
    if (problems.length) return this.reject(problems);
    const m = this.blank(channelId, forUser, draft.flags);
    Object.assign(m, draft);
    return m;
  }

  /** Returns an error result, or null when the edit was applied. */
  private edit(message: FakeMessage, payload: Json, files: FakeFile[]): Result | null {
    const kept = payload.attachments === undefined ? message.attachments : message.attachments.filter((a) => (payload.attachments as Json[]).some((p) => String(p.id) === a.id));
    const flags = payload.flags === undefined ? message.flags : (payload.flags | (message.flags & EPHEMERAL));
    const draft = {
      flags,
      content: payload.content === undefined ? message.content : (payload.content ?? ''),
      components: payload.components === undefined ? message.components : payload.components,
      attachments: [...kept, ...files.map((f) => ({ id: snowflake(), filename: f.name, size: f.size }))],
    };
    const problems = validateMessage(draft, payload);
    if (message.flags & V2 && !(draft.flags & V2)) problems.push('IS_COMPONENTS_V2 cannot be removed from a message');
    if (problems.length) return this.reject(problems);
    Object.assign(message, draft);
    message.edits++;
    return null;
  }

  private reject(problems: string[]): Result {
    this.problems.push(...problems);
    return err(400, 50035, 'Invalid Form Body', problems);
  }

  // ───────────────────────────── gateway: inject interactions ─────────────────────────────

  private base(user: FakeUser, channelId: string, kind: InteractionRecord['kind'], customId: string | null, source: FakeMessage | null) {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`no channel ${channelId}`);
    const id = snowflake();
    // Real tokens are opaque base64 strings; webhook routes and callbacks both carry them.
    const token = Buffer.from(`interaction:${id}:${randomBytes(24).toString('hex')}`).toString('base64url');
    const rec: InteractionRecord = { id, token, kind, userId: user.id, channelId, customId, createdAt: Date.now(), ackedAt: null, callbacks: [], source, original: null, followUps: [], modal: null, errors: [] };
    this.interactions.set(token, rec);
    const raw: Json = {
      id,
      application_id: this.appId,
      token,
      version: 1,
      guild_id: channel.guildId,
      channel_id: channelId,
      channel: this.channelJson(channel),
      member: this.memberJson(user),
      app_permissions: '2251799813685247',
      locale: 'en-US',
      guild_locale: 'en-US',
      entitlements: [],
      authorizing_integration_owners: { '0': channel.guildId },
      context: 0,
      attachment_size_limit: 26_214_400,
    };
    if (source) raw.message = this.messageJson(source);
    return { raw, rec };
  }

  private dispatch(raw: Json): void {
    if (!this.client) throw new Error('attach() a client first');
    (this.client as unknown as { actions: { InteractionCreate: { handle(d: Json): void } } }).actions.InteractionCreate.handle(raw);
  }

  slash(user: FakeUser, channelId: string, name: string, options: { subcommand?: string; args?: Array<{ name: string; type: 'string' | 'integer' | 'user' | 'channel'; value: string | number }> } = {}): InteractionRecord {
    const { raw, rec } = this.base(user, channelId, 'command', null, null);
    const typeCode = { string: 3, integer: 4, user: 6, channel: 7 } as const;
    const args = (options.args ?? []).map((a) => ({ name: a.name, type: typeCode[a.type], value: a.value }));
    const resolvedUsers = (options.args ?? []).filter((a) => a.type === 'user').map((a) => this.users.get(String(a.value))!).filter(Boolean);
    const resolvedChannels = (options.args ?? []).filter((a) => a.type === 'channel').map((a) => this.channels.get(String(a.value))!).filter(Boolean);
    raw.type = 2;
    raw.data = {
      id: snowflake(),
      name,
      type: 1,
      guild_id: raw.guild_id,
      options: options.subcommand ? [{ name: options.subcommand, type: 1, options: args }] : args,
      ...(resolvedUsers.length || resolvedChannels.length
        ? { resolved: { ...(resolvedUsers.length ? this.resolved(resolvedUsers) : {}), ...(resolvedChannels.length ? { channels: Object.fromEntries(resolvedChannels.map((ch) => [ch.id, { ...this.channelJson(ch), permissions: '2251799813685247' }])) } : {}) } }
        : {}),
    };
    this.dispatch(raw);
    return rec;
  }

  /** Click a button the user can actually see and press (disabled buttons can't be clicked). */
  click(user: FakeUser, message: FakeMessage, match: string | RegExp): InteractionRecord {
    this.assertVisible(user, message);
    const button = findComponents(message.components, 2).find((b) => (typeof match === 'string' ? b.custom_id === match || b.label === match : match.test(b.label ?? '') || match.test(b.custom_id ?? '')));
    if (!button) throw new Error(`no button matching ${String(match)} on message (buttons: ${buttonsOf(message).map((b) => b.label ?? b.custom_id).join(', ')})`);
    if (button.disabled) throw new Error(`button "${button.label ?? button.custom_id}" is disabled`);
    if (!button.custom_id) throw new Error(`button "${button.label}" is a link button`);
    const { raw, rec } = this.base(user, message.channelId, 'button', button.custom_id, message);
    raw.type = 3;
    raw.data = { custom_id: button.custom_id, component_type: 2 };
    this.dispatch(raw);
    return rec;
  }

  /** Send a raw custom id as if a (possibly stale or forged) button was pressed. */
  clickRaw(user: FakeUser, message: FakeMessage, customId: string): InteractionRecord {
    const { raw, rec } = this.base(user, message.channelId, 'button', customId, message);
    raw.type = 3;
    raw.data = { custom_id: customId, component_type: 2 };
    this.dispatch(raw);
    return rec;
  }

  select(user: FakeUser, message: FakeMessage, customIdPrefix: string, values: string[]): InteractionRecord {
    this.assertVisible(user, message);
    const menu = [...findComponents(message.components, 3), ...findComponents(message.components, 5)].find((c) => c.custom_id.startsWith(customIdPrefix));
    if (!menu) throw new Error(`no select starting with ${customIdPrefix}`);
    if (menu.disabled) throw new Error('select is disabled');
    if (menu.type === 3) {
      for (const v of values) if (!menu.options.some((o: Json) => o.value === v)) throw new Error(`"${v}" is not an option of ${menu.custom_id}`);
    }
    if (values.length < (menu.min_values ?? 1) || values.length > (menu.max_values ?? 1)) throw new Error('wrong number of values');
    const { raw, rec } = this.base(user, message.channelId, 'select', menu.custom_id, message);
    raw.type = 3;
    raw.data = { custom_id: menu.custom_id, component_type: menu.type, values };
    if (menu.type === 5) raw.data.resolved = this.resolved(values.map((v) => this.users.get(v)!));
    this.dispatch(raw);
    return rec;
  }

  /** Fill in and submit the modal that `opener` showed. Values are keyed by field custom id. */
  submitModal(user: FakeUser, opener: InteractionRecord, values: Record<string, string | string[]>): InteractionRecord {
    const modal = opener.modal;
    if (!modal) throw new Error('that interaction did not open a modal');
    if (opener.userId !== user.id) throw new Error('only the user who opened a modal can submit it');
    const components: Json[] = [];
    const resolvedUsers: FakeUser[] = [];
    for (const row of modal.components ?? []) {
      const field = row.type === 18 ? row.component : row.components?.[0];
      if (!field) continue;
      const v = values[field.custom_id];
      if (field.type === 4) {
        const value = typeof v === 'string' ? v : (field.value ?? '');
        if ((field.required ?? true) && value.length === 0) throw new Error(`modal field ${field.custom_id} is required`);
        if (field.max_length !== undefined && value.length > field.max_length) throw new Error(`modal field ${field.custom_id} is too long`);
        if (field.min_length !== undefined && value.length > 0 && value.length < field.min_length) throw new Error(`modal field ${field.custom_id} is too short`);
        components.push({ type: 18, id: row.id ?? 1, component: { type: 4, id: field.id ?? 2, custom_id: field.custom_id, value } });
      } else if (field.type === 3) {
        const chosen = Array.isArray(v) ? v : v === undefined ? (field.options ?? []).filter((o: Json) => o.default).map((o: Json) => o.value) : [v];
        if ((field.required ?? true) && chosen.length === 0) throw new Error(`modal select ${field.custom_id} is required`);
        components.push({ type: 18, id: row.id ?? 1, component: { type: 3, id: field.id ?? 2, custom_id: field.custom_id, values: chosen } });
      } else if (field.type === 5) {
        const chosen = Array.isArray(v) ? v : v === undefined ? [] : [v];
        resolvedUsers.push(...chosen.map((id) => this.users.get(id)!).filter(Boolean));
        components.push({ type: 18, id: row.id ?? 1, component: { type: 5, id: field.id ?? 2, custom_id: field.custom_id, values: chosen } });
      }
    }
    const { raw, rec } = this.base(user, opener.channelId, 'modal', modal.custom_id, opener.source);
    raw.type = 5;
    raw.data = { custom_id: modal.custom_id, components, ...(resolvedUsers.length ? { resolved: this.resolved(resolvedUsers) } : {}) };
    this.dispatch(raw);
    return rec;
  }

  private assertVisible(user: FakeUser, message: FakeMessage): void {
    if (message.deleted) throw new Error('message was deleted');
    if (message.forUser && message.forUser !== user.id) throw new Error('that ephemeral message belongs to someone else');
  }

  // ───────────────────────────── queries ─────────────────────────────

  /** Public messages in a channel, oldest first. */
  channelMessages(channelId: string): FakeMessage[] {
    return [...this.messages.values()].filter((m) => m.channelId === channelId && !m.forUser && !m.deleted);
  }

  /** What a user would currently see as the response to an interaction (last follow-up wins). */
  seen(rec: InteractionRecord): FakeMessage | null {
    return rec.followUps.at(-1) ?? rec.original;
  }

  // ───────────────────────────── JSON shapes ─────────────────────────────

  userJson(u: FakeUser): Json {
    return { id: u.id, username: u.name.toLowerCase().replace(/\W+/g, ''), discriminator: '0', global_name: u.name, avatar: null, bot: false };
  }

  memberJson(u: FakeUser): Json {
    // ManageGuild (1 << 5) marks casino admins; everyone gets the usual member permissions.
    const base = 1n << 10n | 1n << 11n | 1n << 15n | 1n << 16n;
    return { user: this.userJson(u), nick: null, avatar: null, roles: [], joined_at: new Date(0).toISOString(), deaf: false, mute: false, flags: 0, pending: false, permissions: String(u.admin ? base | (1n << 5n) : base) };
  }

  private resolved(users: FakeUser[]): Json {
    return {
      users: Object.fromEntries(users.map((u) => [u.id, this.userJson(u)])),
      members: Object.fromEntries(users.map((u) => { const { user: _u, ...m } = this.memberJson(u); return [u.id, m]; })),
    };
  }

  channelJson(c: FakeChannel): Json {
    if (c.type === 0) return { id: c.id, type: 0, guild_id: c.guildId, name: c.name, position: 0, permission_overwrites: [], parent_id: null, nsfw: false, topic: null, last_message_id: null, rate_limit_per_user: 0, flags: 0 };
    return {
      id: c.id,
      type: c.type,
      guild_id: c.guildId,
      parent_id: c.parentId,
      name: c.name,
      owner_id: this.appId,
      flags: 0,
      rate_limit_per_user: 0,
      member_count: 1,
      message_count: 0,
      thread_metadata: { archived: c.archived, locked: c.locked, auto_archive_duration: 1440, archive_timestamp: new Date().toISOString(), ...(c.type === 12 ? { invitable: false } : {}) },
    };
  }

  private guildJson(guildId: string): Json {
    const g = this.guilds.get(guildId)!;
    return {
      id: g.id,
      name: g.name,
      icon: null,
      owner_id: snowflake(),
      // Administrator on @everyone keeps permission checks simple for the bot member.
      roles: [{ id: g.id, name: '@everyone', permissions: '8', position: 0, color: 0, hoist: false, managed: false, mentionable: false, flags: 0 }],
      channels: [...this.channels.values()].filter((c) => c.guildId === g.id && c.type === 0).map((c) => this.channelJson(c)),
      threads: [],
      members: [{ user: this.botUser, roles: [], joined_at: new Date(0).toISOString(), deaf: false, mute: false, flags: 0 }],
      member_count: 2,
      features: [],
      emojis: [],
      stickers: [],
      afk_timeout: 300,
      verification_level: 0,
      default_message_notifications: 0,
      explicit_content_filter: 0,
      mfa_level: 0,
      system_channel_flags: 0,
      premium_tier: 0,
      preferred_locale: 'en-US',
      nsfw_level: 0,
      premium_progress_bar_enabled: false,
    };
  }

  messageJson(m: FakeMessage): Json {
    return {
      id: m.id,
      channel_id: m.channelId,
      guild_id: m.guildId,
      author: this.botUser,
      content: m.content,
      timestamp: new Date().toISOString(),
      edited_timestamp: m.edits ? new Date().toISOString() : null,
      tts: false,
      mention_everyone: false,
      mentions: [],
      mention_roles: [],
      attachments: m.attachments.map((a) => ({ id: a.id, filename: a.filename, size: a.size, url: `https://cdn.fake/${a.id}/${a.filename}`, proxy_url: `https://media.fake/${a.id}/${a.filename}`, content_type: 'image/png' })),
      embeds: [],
      pinned: false,
      type: m.type,
      ...(m.referenceChannelId ? { message_reference: { type: 0, channel_id: m.referenceChannelId, guild_id: m.guildId } } : {}),
      flags: m.flags,
      components: m.components,
      application_id: this.appId,
      webhook_id: m.forUser ? this.appId : undefined,
    };
  }
}

// ───────────────────────────── payload validation (what Discord would reject) ─────────────────────────────

interface Draft {
  flags: number;
  content: string;
  components: Json[];
  attachments: FakeAttachment[];
}

function walk(components: Json[], visit: (c: Json, parent: Json | null) => void, parent: Json | null = null): void {
  for (const c of components ?? []) {
    visit(c, parent);
    if (Array.isArray(c.components)) walk(c.components, visit, c);
    if (Array.isArray(c.items)) walk(c.items, visit, c);
    if (c.accessory) walk([c.accessory], visit, c);
    if (c.component) walk([c.component], visit, c);
  }
}

export function findComponents(components: Json[], type: number): Json[] {
  const found: Json[] = [];
  walk(components, (c) => {
    if (c.type === type) found.push(c);
  });
  return found;
}

export function buttonsOf(message: FakeMessage): Array<{ label?: string; custom_id?: string; disabled?: boolean; style: number; url?: string }> {
  return findComponents(message.components, 2);
}

export function textOf(message: FakeMessage | null): string {
  if (!message) return '';
  return findComponents(message.components, 10).map((t) => t.content).join('\n');
}

function validateMessage(draft: Draft, payload: Json): string[] {
  const problems: string[] = [];
  const v2 = (draft.flags & V2) !== 0;
  if (v2) {
    if (draft.content) problems.push('content is not allowed with IS_COMPONENTS_V2');
    if (payload.embeds?.length) problems.push('embeds are not allowed with IS_COMPONENTS_V2');
    if (draft.components.length === 0) problems.push('a Components V2 message needs at least one component');
  } else if (!draft.content && draft.components.length === 0 && draft.attachments.length === 0) {
    problems.push('cannot send an empty message');
  }
  let total = 0;
  let textChars = 0;
  const ids = new Set<string>();
  const names = new Set(draft.attachments.map((a) => a.filename));
  walk(draft.components, (c, parent) => {
    total++;
    if (c.custom_id !== undefined) {
      if (typeof c.custom_id !== 'string' || c.custom_id.length === 0 || c.custom_id.length > 100) problems.push(`custom_id length invalid: ${c.custom_id}`);
      if (ids.has(c.custom_id)) problems.push(`duplicate custom_id ${c.custom_id}`);
      ids.add(c.custom_id);
    }
    switch (c.type) {
      case 1: {
        const buttons = (c.components ?? []).filter((x: Json) => x.type === 2).length;
        const selects = (c.components ?? []).filter((x: Json) => [3, 5, 6, 7, 8].includes(x.type)).length;
        if (buttons > 5) problems.push('action row has more than 5 buttons');
        if (selects > 1 || (selects && buttons)) problems.push('action row mixes selects and buttons');
        if (buttons + selects === 0) problems.push('empty action row');
        break;
      }
      case 2:
        if (c.style === 5 ? !c.url || c.custom_id : !c.custom_id) problems.push(`button ${c.label} has wrong url/custom_id for its style`);
        if (c.label && c.label.length > 80) problems.push(`button label too long: ${c.label}`);
        if (!c.label && !c.emoji) problems.push('button needs a label or emoji');
        break;
      case 3:
        if (!c.options?.length || c.options.length > 25) problems.push(`select ${c.custom_id} has ${c.options?.length ?? 0} options`);
        for (const o of c.options ?? []) if (!o.label || o.label.length > 100 || !o.value || o.value.length > 100) problems.push(`bad select option in ${c.custom_id}`);
        break;
      case 9:
        if (!c.accessory) problems.push('section without accessory');
        if (!c.components?.length || c.components.length > 3) problems.push('section needs 1–3 text displays');
        break;
      case 10:
        textChars += String(c.content ?? '').length;
        if (!c.content) problems.push('empty text display');
        break;
      case 11:
      case 12:
      case 13: {
        const urls: string[] = c.type === 12 ? (c.items ?? []).map((it: Json) => it.media?.url) : [c.media?.url ?? c.file?.url];
        if (c.type === 12 && (!c.items?.length || c.items.length > 10)) problems.push('media gallery needs 1–10 items');
        for (const url of urls) {
          if (typeof url !== 'string') problems.push('media without url');
          else if (url.startsWith('attachment://') && !names.has(url.slice('attachment://'.length))) problems.push(`media references missing attachment ${url}`);
        }
        break;
      }
      case 17:
        if (c.accent_color !== undefined && c.accent_color !== null && (c.accent_color < 0 || c.accent_color > 0xffffff)) problems.push('bad accent color');
        if (parent) problems.push('containers cannot be nested');
        break;
      default:
        break;
    }
  });
  if (total > 40) problems.push(`too many components (${total} > 40)`);
  if (textChars > 4000) problems.push(`too much text (${textChars} > 4000)`);
  return problems;
}

// ───────────────────────────── responses ─────────────────────────────

/**
 * The same shape @discordjs/rest's Node transport (undici) returns: no clone(), body readable once.
 * Using real fetch Responses here would hide bugs that only show up in production.
 */
export function undiciLikeResponse(status: number, body?: unknown): Response {
  const text = body === undefined ? '' : JSON.stringify(body);
  let used = false;
  const read = () => {
    if (used) throw new TypeError('Body is unusable: Body has already been read');
    used = true;
    return text;
  };
  return {
    body: null,
    arrayBuffer: async () => new TextEncoder().encode(read()).buffer,
    json: async () => JSON.parse(read()),
    text: async () => read(),
    get bodyUsed() {
      return used;
    },
    headers: new Headers(body === undefined ? {} : { 'content-type': 'application/json' }),
    status,
    statusText: '',
    ok: status >= 200 && status < 300,
  } as unknown as Response;
}

// ───────────────────────────── request bodies ─────────────────────────────

interface FakeFile {
  name: string;
  size: number;
}

async function readBody(body: unknown): Promise<{ json: Json; files: FakeFile[] }> {
  if (body === undefined || body === null) return { json: undefined, files: [] };
  if (typeof body === 'string') return { json: JSON.parse(body), files: [] };
  if (body instanceof Uint8Array) return { json: JSON.parse(Buffer.from(body).toString('utf8')), files: [] };
  const form = body as { entries?: () => Iterable<[string, unknown]> };
  if (typeof form.entries === 'function') {
    let json: Json;
    const files: FakeFile[] = [];
    for (const [key, value] of form.entries()) {
      if (key === 'payload_json') json = JSON.parse(String(value));
      else if (value && typeof value === 'object' && 'arrayBuffer' in value) {
        const blob = value as Blob & { name?: string };
        files.push({ name: blob.name ?? key, size: blob.size });
      }
    }
    return { json, files };
  }
  return { json: undefined, files: [] };
}
